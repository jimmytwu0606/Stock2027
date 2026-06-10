/**
 * pattern-scan.js — Phase 3 全市場型態掃描
 * 職責：
 *   - 接收範本 Candle[]，批次掃描全市場 K 線
 *   - AsyncGenerator 逐步回傳進度與結果
 *   - 管理掃描取消
 *   - 429 rate limit 指數退避重試
 */

import { fetchTWSEPrices, fetchHistory, fetchHistoryCached, resolveYahooSymbol, toYahooSymbol, getChineseName, getAllKnownCodes } from './api.js';
import { calcSimilarity, normalizeSeries, pearsonPrefilter } from './pattern.js';
import { getKlineCache } from './db.js';
import { AppState } from './state.js';
import { Config } from './config.js';

// ─── 掃描取消控制 ──────────────────────────────────────────
let _abortController = null;

export function abortScan() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
}

// ─── 主掃描 AsyncGenerator ────────────────────────────────
export async function* runPatternScan(templateCandles, opts = {}) {
  // ── 相容性轉換：圖片模式傳入 number[]，手繪模式傳入 Candle[] ──
  // 統一轉成 Candle[]，讓後續 normalizeCandles / findBestMatch 可以正常使用
  if (templateCandles.length > 0 && typeof templateCandles[0] === 'number') {
    const now = Math.floor(Date.now() / 1000);
    templateCandles = templateCandles.map((v, i) => ({
      time:   now - (templateCandles.length - 1 - i) * 86400,
      open:   v * 100, high: v * 100 + 0.5,
      low:    v * 100 - 0.5, close: v * 100,
      volume: 1000,
    }));
  }

  // ── 讀取型態比對自己的 period（獨立於篩選器）──
  const pdPeriodEl = document.getElementById('pdPeriod');
  const pdPeriod   = pdPeriodEl?.value || '3mo';

  const {
    similarity  = AppState.pattern.similarity  || 75,
    windowSize  = AppState.pattern.windowSize  || 20,
    featureMode = AppState.pattern.featureMode || 'simple',
    period      = pdPeriod,   // ← 用型態比對自己的 period，不吃 Config.screenerPeriod
    concurrency = 3,          // cache hit 快，但 cache miss 還是要保護 proxy
  } = opts;

  AppState.pattern.scanResults = [];
  _abortController = new AbortController();
  const signal = _abortController.signal;

  // Step 1：取得全市場代號清單
  yield { type: 'progress', phase: 'fetch_list', message: '取得市場代號清單…', done: 0, total: 0 };

  let priceMap;
  try {
    priceMap = await fetchTWSEPrices();
  } catch (err) {
    const cached = window.__priceCache ?? {};
    if (Object.keys(cached).length > 0) {
      console.warn('[pattern-scan] TWSE 失敗，用 __priceCache');
      priceMap = cached;
    } else {
      yield { type: 'error', message: '無法取得市場代號：' + err.message };
      return;
    }
  }
  if (!priceMap || Object.keys(priceMap).length === 0) {
    const cached = window.__priceCache ?? {};
    if (Object.keys(cached).length > 0) {
      priceMap = cached;
    } else {
      const codes = getAllKnownCodes();
      if (codes.length > 0) {
        console.warn('[pattern-scan] 用名稱快取代號清單 fallback:', codes.length);
        priceMap = {};
        codes.forEach(c => {
          priceMap[c] = { name: getChineseName(c) ?? c, price: 0, volume: 0, chgPct: 0 };
        });
      } else {
        yield { type: 'error', message: '市場資料完全無法取得' };
        return;
      }
    }
  }

  // ── 篩選條件（priceMap 已有當日收盤價/量能，不需額外請求）──
  const {
    priceMin    = 0,       // 股價下限（元）
    priceMax    = 99999,   // 股價上限（元）
    volumeMin   = 0,       // 成交量下限（張）
    fromScreener = false,  // 是否直接用 Phase 2 結果
  } = opts;

  let codes;

  if (fromScreener && AppState.screener.results.length > 0) {
    // 直接吃 Phase 2 篩選結果
    codes = AppState.screener.results.map(r => r.code).filter(code => /^\d{4}$/.test(code));
    yield { type: 'progress', phase: 'scan', message: `從選股結果掃描 ${codes.length} 檔…`, done: 0, total: codes.length };
  } else {
    // 用 priceMap + getAllKnownCodes 合併代號來源
    // Firestore priceMap 只有上市股，上櫃股靠 _nameCache 補入
    const pmKeys = new Set(Object.keys(priceMap).filter(c => /^\d{4}$/.test(c)));
    const ncKeys = getAllKnownCodes().filter(c => /^\d{4}$/.test(c) && !pmKeys.has(c));
    const allKeys = [...pmKeys, ...ncKeys];
    const isNoPriceMode = pmKeys.size > 0 && [...pmKeys].every(c => (priceMap[c]?.price ?? 0) === 0);
    codes = allKeys.filter(code => {
      if (!/^\d{4}$/.test(code)) return false;
      if (isNoPriceMode) return true;
      const d = priceMap[code];
      // priceMap 沒有的代號（上櫃）→ 只做股價區間過濾時放行（無法確認價格）
      if (!d) return (priceMin <= 0 || priceMin === undefined) && (priceMax >= 9999 || priceMax === undefined);
      if (d.price < priceMin || d.price > priceMax) return false;
      if (d.volume < volumeMin) return false;
      return true;
    });
    yield { type: 'progress', phase: 'scan', message: `篩選後掃描 ${codes.length} 檔（共 ${Object.keys(priceMap).length} 檔）…`, done: 0, total: codes.length };
  }

  const total = codes.length;

  // Step 2：逐批掃描
  let done        = 0;
  let results     = [];
  let consecutive429 = 0;   // 連續 429 次數，用於動態退避

  // bundle 預載後幾乎全 cache hit（IDB 本地讀取 + DTW 純計算）→ 可大幅並發
  // cache miss（要打 Worker）才需限流；用較高並發批次，批內並行跑
  // CONCURRENCY 提高：IDB 讀取的非同步等待可 overlap，cache hit 不 sleep
  const HIT_CONCURRENCY = 12;  // cache hit 批次並發數（純本地，可拉高）

  for (let i = 0; i < codes.length; i += HIT_CONCURRENCY) {
    if (signal.aborted) {
      yield { type: 'aborted', message: '掃描已取消', results };
      return;
    }

    const batch = codes.slice(i, i + HIT_CONCURRENCY);

    // 批內並行：Promise.all 讓 IDB 讀取等待 overlap（DTW 仍序列但 I/O 不阻塞）
    const batchResults = await Promise.all(
      batch.map(code =>
        signal.aborted ? Promise.resolve(null) :
        _scanOneWithRetry(
          code, templateCandles,
          { windowSize, featureMode, period, signal, priceMap },
          consecutive429
        )
      )
    );

    let batchHas429 = false;
    let batchHasMiss = false;
    for (const result of batchResults) {
      done++;
      if (result === '429') {
        batchHas429 = true;
        consecutive429++;
      } else {
        consecutive429 = Math.max(0, consecutive429 - 1);
        if (result && result.score >= similarity) {
          results.push(result);
          yield { type: 'result', item: result, done, total };
        }
        if (result?.fromCache === false) batchHasMiss = true;
      }
    }

    yield {
      type: 'progress', phase: 'scan',
      message: batchHas429 ? '掃描中（rate limit，放慢中）…' : '掃描中…',
      done, total,
    };

    // 限流：整批若有 429 或 cache miss（打了 Worker）才 sleep；全 hit 不等待
    if (batchHas429) {
      await _sleep(800 + Math.min(consecutive429 * 1000, 8000));
    } else if (batchHasMiss) {
      await _sleep(200);  // 批次有打 Worker → 保護 proxy
    }

    // 讓出主執行緒，避免連續 DTW 凍結畫面
    await _yieldToUI();
  }

  results.sort((a, b) => b.score - a.score);
  AppState.pattern.scanResults = results;
  yield { type: 'done', results, total };
  _abortController = null;
}

// ─── 單股掃描（含重試） ────────────────────────────────────
/**
 * @returns {object|null|'429'}
 *   object = 掃描結果
 *   null   = 其他錯誤（略過）
 *   '429'  = rate limit，無法重試
 */
async function _scanOneWithRetry(code, templateCandles, opts, consecutive429 = 0) {
  const { windowSize, featureMode, period, signal, priceMap } = opts;
  if (signal?.aborted) return null;

  // 最多重試 2 次（僅針對非 429 錯誤）
  const MAX_RETRY = 2;

  // ⚠️ 踩雷備忘（永久，2026-06-02）：
  //   傳入的 period（pdPeriod，可能為 3mo）送給 Worker 時 R2 key = yahoo:{sym}:3mo → 永遠 MISS。
  //   GAS 只寫 1y，固定送 '1y' 才能命中 R2。
  //   型態比對實際上只用最後 windowSize 根（slice(-scanLen)），
  //   用 1y 資料截尾結果完全等同，且 IndexedDB 命中時完全不打 Worker。
  const FETCH_PERIOD = '1y';

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) return null;

    try {
      // fetchHistoryCached：IndexedDB → Worker R2（key=yahoo:{sym}:1y）→ live Yahoo
      // ⚠️ 踩雷備忘（永久，2026-05-28）：
      //   resolveYahooSymbol 每檔打兩次 API（.TW + .TWO），全市場 1700 檔 × 2 = 3400 次
      //   proxy 立刻被打爆，大量 502 → 全部 return null → 結果 0。
      //   型態比對用 toYahooSymbol + fetchHistoryCached 即可，上櫃比例少且 R2 有快取。
      const symbol = toYahooSymbol(code);
      const tLen    = templateCandles.length;
      const scanLen = Math.max(tLen, windowSize);

      // ── 打 Worker 前先看 IDB 既有快取根數 ──────────────────────────────────
      //   新上市股（如 7803 只有 15 根）K 線不足 scanLen，比對本來就比不了。
      //   但 fetchHistoryCached 會因「根數 < period 60%」判定快取不足 → 重打 Worker
      //   → 盤後 Yahoo 502/400 噴一堆 error 又拖速度。
      //   先檢查 IDB：有快取但根數不足 scanLen → 直接跳過，不打 Worker。
      try {
        const sym2 = symbol.endsWith('.TW') ? symbol.replace('.TW', '.TWO') : symbol.replace('.TWO', '.TW');
        const idbHit = await getKlineCache(symbol, '1y').catch(() => null)
                    || await getKlineCache(sym2, '1y').catch(() => null);
        if (idbHit?.candles && idbHit.candles.length < scanLen) {
          return null;  // IDB 有資料但根數不足 → 新股/資料太短，跳過不打 Worker
        }
      } catch (_) {}

      const _t0 = Date.now();
      // ⚠️ allowStale:true — 批次掃描接受「差一天」的快取，不為最近一根重打 Worker。
      //   上櫃股快取常缺今天那根（GAS 寫入時序），無 allowStale 會每支 fall through
      //   打 Worker 1.5 秒 → 整批龜速。型態比對用截尾資料結果等同。
      const candles = await fetchHistoryCached(symbol, FETCH_PERIOD, { allowStale: true });
      const fromCache = (Date.now() - _t0) < 30;

      if (!candles || candles.length < scanLen) return null;

      // ── 比對段固定為「最新 tLen 根」（貼齊右端，找正在形成此型態的股票）──
      // 不做歷史滑動：比對段永遠是最近 tLen 根，畫圖時藍框貼右端、最後一根=今天
      const matchSegment = candles.slice(-tLen);

      // 粗篩：最新 tLen 根降採樣 Pearson，快速剔除明顯不像（省 DTW）
      const templateNorm = normalizeSeries(templateCandles.map(c => c.close));
      const matchNorm    = normalizeSeries(matchSegment.map(c => c.close));
      if (!pearsonPrefilter(templateNorm, matchNorm, 0.1)) return null;

      // 直接比對最新 tLen 根 vs 範本
      const score = calcSimilarity(templateCandles, matchSegment, featureMode);

      // 畫圖用：前面補一些 context（灰線），藍框=最新 tLen 根貼右端
      // drawCandles = 最新 (tLen + context) 根，匹配段在最右側 tLen 根
      const CONTEXT = Math.min(20, candles.length - tLen);  // 前置 context 根數
      const drawCandles = candles.slice(-(tLen + CONTEXT));
      // 匹配段（最新 tLen 根）在 drawCandles 裡的座標：[CONTEXT, drawCandles.length-1]
      const drawStartIdx = CONTEXT;
      const drawEndIdx   = drawCandles.length - 1;

      const pd = priceMap?.[code] ?? {};
      // 價格來源：priceMap 優先（當日收盤）；上櫃股 priceMap 常無 price（=0）
      //   → 用已抓到的 K 線最後一根補（今收），漲跌幅用最後兩根算
      // 避免上櫃股在型態結果列表顯示「—」
      let _price  = isFinite(pd.price)  && pd.price  > 0 ? pd.price  : null;
      let _chgPct = isFinite(pd.chgPct) && pd.chgPct !== 0 ? pd.chgPct : null;
      if (_price == null && candles.length >= 1) {
        const last = candles[candles.length - 1];
        _price = last?.close ?? null;
        if (_chgPct == null && candles.length >= 2) {
          const prev = candles[candles.length - 2];
          if (prev?.close > 0) _chgPct = (last.close - prev.close) / prev.close * 100;
        }
      }

      return {
        code,
        name:        getChineseName(code) ?? pd.name ?? '',
        score:       Math.round(score * 10) / 10,
        price:       _price  ?? 0,
        chgPct:      _chgPct ?? 0,
        startIdx:    drawStartIdx,    // 匹配段在 drawCandles 裡的起點
        endIdx:      drawEndIdx,      // 匹配段終點（貼齊最新）
        candles:     drawCandles,     // 含 context + 匹配段，畫到今天
        fullCandles: candles,
        fromCache,
      };

    } catch (err) {
      const msg = String(err?.message || err);

      // 429：不重試，直接回傳標記
      if (msg.includes('429')) return '429';

      // timeout 或其他錯誤：等待後重試
      if (attempt < MAX_RETRY) {
        await _sleep(1000 * (attempt + 1));
        continue;
      }

      return null;
    }
  }

  return null;
}

// ─── 工具 ──────────────────────────────────────────────────
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 強制讓出主執行緒一次，讓瀏覽器有機會更新畫面
function _yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
