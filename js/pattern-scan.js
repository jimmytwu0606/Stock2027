/**
 * pattern-scan.js — Phase 3 全市場型態掃描
 * 職責：
 *   - 接收範本 Candle[]，批次掃描全市場 K 線
 *   - AsyncGenerator 逐步回傳進度與結果
 *   - 管理掃描取消
 *   - 429 rate limit 指數退避重試
 */

import { fetchTWSEPrices, fetchHistory, fetchHistoryCached, resolveYahooSymbol, toYahooSymbol, getChineseName, getAllKnownCodes } from './api.js';
import { findBestMatch, normalizeSeries, pearsonPrefilter } from './pattern.js';
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

  for (let i = 0; i < codes.length; i += concurrency) {
    if (signal.aborted) {
      yield { type: 'aborted', message: '掃描已取消', results };
      return;
    }

    const batch = codes.slice(i, i + concurrency);

    // 逐一（非並發）執行，更容易控制速率
    for (const code of batch) {
      if (signal.aborted) break;

      const result = await _scanOneWithRetry(
        code, templateCandles,
        { windowSize, featureMode, period, signal, priceMap },
        consecutive429
      );

      done++;

      if (result === '429') {
        consecutive429++;
        yield { type: 'progress', phase: 'scan', message: `掃描中（rate limit，放慢中）…`, done, total };
      } else {
        consecutive429 = Math.max(0, consecutive429 - 1);
        if (result && result.score >= similarity) {
          results.push(result);
          yield { type: 'result', item: result, done, total };
        }
        yield { type: 'progress', phase: 'scan', message: `掃描中…`, done, total };
      }

      const isCacheHit = result?.fromCache === true;
      const baseDelay  = result === '429' ? 800 : isCacheHit ? 0 : 200;
      const extraDelay = Math.min(consecutive429 * 1000, 8000);
      if (baseDelay + extraDelay > 0) await _sleep(baseDelay + extraDelay);

      // 每 10 筆強制讓出主執行緒，避免 DTW 計算連續佔用導致畫面凍結
      if (done % 10 === 0) await _yieldToUI();
    }
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
      const _t0 = Date.now();
      const candles = await fetchHistoryCached(symbol, FETCH_PERIOD);
      const fromCache = (Date.now() - _t0) < 30;

      const scanLen = Math.max(templateCandles.length, windowSize);
      if (!candles || candles.length < scanLen) return null;

      const recent = candles.slice(-scanLen);

      const templateNorm = normalizeSeries(templateCandles.map(c => c.close));
      const recentNorm   = normalizeSeries(recent.map(c => c.close));
      if (!pearsonPrefilter(templateNorm, recentNorm, 0.2)) return null;

      const { score } = findBestMatch(templateCandles, recent);

      const pd = priceMap?.[code] ?? {};
      return {
        code,
        name:        getChineseName(code) ?? pd.name ?? '',
        score:       Math.round(score * 10) / 10,
        price:       isFinite(pd.price)  ? pd.price  : 0,
        chgPct:      isFinite(pd.chgPct) ? pd.chgPct : 0,
        startIdx:    0,
        endIdx:      windowSize - 1,
        candles:     recent,
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
