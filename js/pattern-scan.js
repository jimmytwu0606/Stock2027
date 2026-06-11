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

  // ── 範本只需正規化一次（原本每檔都重算）──
  const templateNorm = normalizeSeries(templateCandles.map(c => c.close));
  const tLen    = templateCandles.length;
  const scanLen = Math.max(tLen, windowSize);

  // ── Pearson 粗篩門檻跟著相似度門檻走 ──
  //   原本固定 0.1 幾乎不過濾；門檻 89% 時 corr<0.5 根本不可能達標，
  //   拉高 threshold 可在 DTW 前砍掉大部分股票。
  const pearsonTh = similarity >= 85 ? 0.5 : similarity >= 75 ? 0.35 : 0.2;

  // ═══ Phase A：IDB 批次預載到記憶體 ═══════════════════════
  //   原本每檔在掃描迴圈內做 2 次 IDB get（.TW + .TWO），與 DTW 交錯執行。
  //   改成開頭一次性大並發預載進 Map，之後 hit 全走記憶體、零 I/O。
  yield { type: 'progress', phase: 'scan', message: '載入本地快取…', done: 0, total };

  const memCache  = new Map();   // code → candles（IDB hit）
  const missCodes = [];          // IDB miss → Phase C 低速走 Worker
  const PRELOAD_CONCURRENCY = 32;

  for (let i = 0; i < codes.length; i += PRELOAD_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消', results: [] }; return; }
    const batch = codes.slice(i, i + PRELOAD_CONCURRENCY);
    await Promise.all(batch.map(async code => {
      const symbol = toYahooSymbol(code);
      const sym2   = symbol.endsWith('.TW') ? symbol.replace('.TW', '.TWO') : symbol.replace('.TWO', '.TW');
      const hit = await getKlineCache(symbol, '1y').catch(() => null)
               || await getKlineCache(sym2,   '1y').catch(() => null);
      if (hit?.candles?.length) memCache.set(code, hit.candles);
      else missCodes.push(code);
    }));
    if ((i / PRELOAD_CONCURRENCY) % 4 === 0) {
      yield { type: 'progress', phase: 'scan', message: `載入本地快取… (${Math.min(i + PRELOAD_CONCURRENCY, total)}/${total})`, done: 0, total };
    }
  }

  // ═══ Phase B：cache hit 純計算掃描（零 I/O、零 sleep）═══
  let done    = 0;
  let results = [];
  const COMPUTE_BATCH = 100;   // 每批讓出一次主執行緒，避免凍結畫面

  const hitCodes = [...memCache.keys()];
  for (let i = 0; i < hitCodes.length; i += COMPUTE_BATCH) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消', results }; return; }

    const batch = hitCodes.slice(i, i + COMPUTE_BATCH);
    for (const code of batch) {
      done++;
      const candles = memCache.get(code);
      if (!candles || candles.length < scanLen) continue;  // 新股/資料太短

      const result = _scoreCandles(code, candles, templateCandles, templateNorm,
                                   { featureMode, similarity, pearsonTh, priceMap, fromCache: true });
      if (result && result.score >= similarity) {
        results.push(result);
        yield { type: 'result', item: result, done, total };
      }
    }

    yield { type: 'progress', phase: 'scan', message: '掃描中…', done, total };
    await _yieldToUI();
  }
  memCache.clear();  // 釋放記憶體

  // ═══ Phase C：cache miss 低速補掃（必打 Worker，保護 proxy）═══
  let consecutive429 = 0;
  const MISS_CONCURRENCY = 4;

  for (let i = 0; i < missCodes.length; i += MISS_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消', results }; return; }

    const batch = missCodes.slice(i, i + MISS_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(code =>
        signal.aborted ? Promise.resolve(null) :
        _scanOneWithRetry(
          code, templateCandles,
          { windowSize, featureMode, period, signal, priceMap, similarity, pearsonTh, templateNorm },
          consecutive429
        )
      )
    );

    let batchHas429 = false;
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
      }
    }

    yield {
      type: 'progress', phase: 'scan',
      message: batchHas429 ? '補抓缺漏資料（rate limit，放慢中）…' : `補抓缺漏資料… (${Math.min(i + MISS_CONCURRENCY, missCodes.length)}/${missCodes.length})`,
      done, total,
    };

    if (batchHas429) {
      await _sleep(800 + Math.min(consecutive429 * 1000, 8000));
    } else {
      await _sleep(200);  // miss 必打 Worker → 保護 proxy
    }
  }


  results.sort((a, b) => b.score - a.score);
  AppState.pattern.scanResults = results;
  yield { type: 'done', results, total };
  _abortController = null;
}

// ─── 純計算：對單檔 candles 評分（共用於 Phase B / Phase C）────
/**
 * @returns {object|null}  null = 粗篩未過或資料不足
 */
function _scoreCandles(code, candles, templateCandles, templateNorm, opts) {
  const { featureMode, similarity, pearsonTh, priceMap, fromCache } = opts;
  const tLen = templateCandles.length;

  // ── 比對段固定為「最新 tLen 根」（貼齊右端，找正在形成此型態的股票）──
  const matchSegment = candles.slice(-tLen);

  // 粗篩：降採樣 Pearson，快速剔除明顯不像（省 DTW）
  const matchNorm = normalizeSeries(matchSegment.map(c => c.close));
  if (!pearsonPrefilter(templateNorm, matchNorm, pearsonTh)) return null;

  // DTW（early abandoning：低於 similarity 門檻的提前放棄，省一半以上計算）
  const score = calcSimilarity(templateCandles, matchSegment, featureMode, similarity);
  if (score < similarity) return null;

  // 畫圖用：前面補一些 context（灰線），藍框=最新 tLen 根貼右端
  const CONTEXT = Math.min(20, candles.length - tLen);
  const drawCandles  = candles.slice(-(tLen + CONTEXT));
  const drawStartIdx = CONTEXT;
  const drawEndIdx   = drawCandles.length - 1;

  const pd = priceMap?.[code] ?? {};
  // 價格來源：priceMap 優先（當日收盤）；上櫃股 priceMap 常無 price（=0）
  //   → 用 K 線最後一根補（今收），漲跌幅用最後兩根算
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
    startIdx:    drawStartIdx,
    endIdx:      drawEndIdx,
    candles:     drawCandles,
    fullCandles: candles,
    fromCache,
  };
}

// ─── 單股掃描（含重試，僅 Phase C cache miss 使用） ─────────
/**
 * @returns {object|null|'429'}
 *   object = 掃描結果
 *   null   = 其他錯誤 / 粗篩未過（略過）
 *   '429'  = rate limit，無法重試
 */
async function _scanOneWithRetry(code, templateCandles, opts, consecutive429 = 0) {
  const { windowSize, featureMode, signal, priceMap, similarity, pearsonTh, templateNorm } = opts;
  if (signal?.aborted) return null;

  // 最多重試 2 次（僅針對非 429 錯誤）
  const MAX_RETRY = 2;

  // ⚠️ 踩雷備忘（永久，2026-06-02）：
  //   傳入的 period（pdPeriod，可能為 3mo）送給 Worker 時 R2 key = yahoo:{sym}:3mo → 永遠 MISS。
  //   GAS 只寫 1y，固定送 '1y' 才能命中 R2。
  const FETCH_PERIOD = '1y';

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) return null;

    try {
      // ⚠️ 踩雷備忘（永久，2026-05-28）：
      //   resolveYahooSymbol 每檔打兩次 API，全市場會打爆 proxy。
      //   型態比對用 toYahooSymbol + fetchHistoryCached 即可。
      const symbol  = toYahooSymbol(code);
      const tLen    = templateCandles.length;
      const scanLen = Math.max(tLen, windowSize);

      // 此函式只處理 Phase A 預載判定為 miss 的代號（IDB 無資料），
      // 不需再查 IDB 根數，直接走 fetchHistoryCached（→ Worker R2 → live Yahoo）。
      // ⚠️ allowStale:true — 批次掃描接受「差一天」的快取，不為最近一根重打 Worker。
      const candles = await fetchHistoryCached(symbol, FETCH_PERIOD, { allowStale: true });

      if (!candles || candles.length < scanLen) return null;

      return _scoreCandles(code, candles, templateCandles, templateNorm,
                           { featureMode, similarity, pearsonTh, priceMap, fromCache: false });

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
