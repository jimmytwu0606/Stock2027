/**
 * seed-scan.js — Phase 4 種子選股全市場掃描
 *
 * 兩階段：
 *   Phase A：TWSE priceMap 過濾（瞬間，無額外請求）
 *   Phase B：逐一拉 Yahoo Finance K 線 → 三維評分
 *
 * export：
 *   runSeedScan(template, opts)       ← AsyncGenerator（多股模式）
 *   runSingleSeedScan(code, opts)     ← AsyncGenerator（單股相似模式）
 *   abortSeedScan()
 */

import { fetchTWSEPrices, fetchHistoryCached, resolveYahooSymbol, toYahooSymbol, fetchFundamentals, getAllKnownCodes, getChineseName } from './api.js';
import { AppState }  from './state.js';
import { Config }    from './config.js';
import {
  scoreSector, scorePattern, scoreIndicators, calcCompositeScore,
} from './seed.js';

// ─── 取消控制 ─────────────────────────────────────────────
let _abortController = null;

export function abortSeedScan() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
}

// ─── 主掃描 AsyncGenerator ────────────────────────────────
export async function* runSeedScan(template, opts = {}) {
  const {
    weights            = { sector: 0.25, pattern: 0.50, indicator: 0.25 },
    priceMin           = 0,
    priceMax           = 99999,
    volumeMin          = 0,
    useScreenerResults = false,
    windowSize         = template?.windowSize ?? 20,
    threshold          = 60,
    skipOTC            = true,
    period             = Config.screenerPeriod || '3mo',
  } = opts;

  if (!template) {
    yield { type: 'error', message: '尚未設定種子模板' };
    return;
  }

  AppState.seed.scanResults = [];
  _abortController = new AbortController();
  const signal = _abortController.signal;

  // ── Phase A：取得候選清單 ──────────────────────────────
  yield { type: 'progress', done: 0, total: 0, message: '取得市場代號清單…', rateLimited: false };

  let priceMap;
  try {
    priceMap = await fetchTWSEPrices();
  } catch (err) {
    const cached = window.__priceCache ?? {};
    if (Object.keys(cached).length > 0) {
      console.warn('[seed-scan] TWSE 失敗，用 __priceCache');
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
        console.warn('[seed-scan] 用名稱快取代號清單 fallback:', codes.length);
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

  let codes;
  if (useScreenerResults && AppState.screener.results.length > 0) {
    codes = AppState.screener.results
      .map(r => r.code)
      .filter(c => /^\d{4}$/.test(c));
  } else {
    // 偵測無價格模式
    const allKeys = Object.keys(priceMap);
    const isNoPriceMode = allKeys.length > 0 && allKeys.every(c => (priceMap[c]?.price ?? 0) === 0);
    codes = allKeys.filter(code => {
      if (!/^\d{4}$/.test(code)) return false;
      if (isNoPriceMode) return true;  // 無價格資料時放行所有代號
      const d = priceMap[code];
      if (!d) return false;
      if (d.price < priceMin || d.price > priceMax) return false;
      if (d.volume < volumeMin) return false;
      return true;
    });
  }

  const total = codes.length;
  yield { type: 'progress', done: 0, total, message: `篩選後掃描 ${total} 檔…`, rateLimited: false };

  // ── Phase B：逐一掃描 ─────────────────────────────────
  let done           = 0;
  let consecutive429 = 0;

  for (const code of codes) {
    if (signal.aborted) {
      yield { type: 'aborted', message: '掃描已取消' };
      return;
    }

    // ⚠️ 踩雷備忘（永久，2026-05-28）：
    //   舊版用 toYahooSymbol + skipOTC，_otcSet 冷啟動空時上櫃股全被跳過，
    //   KV miss + Yahoo 502 時 fetchHistory 沒有 staleCandles 保護全部死掉。
    //   改用 resolveYahooSymbol（自動試 .TW/.TWO，有 staleCandles fallback）。
    const result = await _scanOne(code, template, {
      weights, windowSize, period, threshold, signal, priceMap,
    });

    done++;

    if (result === '429') {
      consecutive429++;
      yield { type: 'progress', done, total, message: 'rate limit，放慢中…', rateLimited: true };
    } else {
      consecutive429 = Math.max(0, consecutive429 - 1);
      if (result) {
        AppState.seed.scanResults.push(result);
        yield { type: 'result', item: result, done, total };
      }
      yield { type: 'progress', done, total, message: `掃描中 ${done}/${total}…`, rateLimited: false };
    }

    const delay = 400 + Math.min(consecutive429 * 1200, 8000);
    await _sleep(delay);
  }

  AppState.seed.scanResults.sort((a, b) => b.compositeScore - a.compositeScore);
  yield { type: 'done', total, elapsed: 0 };
  _abortController = null;
}

// ─── 單股掃描 ─────────────────────────────────────────────
async function _scanOne(code, template, opts) {
  const { weights, windowSize, period, threshold, signal, priceMap } = opts;
  if (signal?.aborted) return null;

  const MAX_RETRY = 2;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) return null;
    try {
      // 優先走 fetchHistoryCached（R2 快取，有 .TW/.TWO suffix fallback，快且穩）
      // resolveYahooSymbol 只在完全找不到時才用（每次打 Yahoo 較慢且容易被封）
      let candles = null;
      let symbol  = toYahooSymbol(code);  // 預設 .TW

      try {
        candles = await fetchHistoryCached(symbol, period, { allowStale: true });
      } catch (_) {}

      // .TW 找不到 → 試 .TWO（上櫃）
      if (!candles || candles.length < windowSize + 10) {
        const symTWO = code + '.TWO';
        try {
          const c2 = await fetchHistoryCached(symTWO, period, { allowStale: true });
          if (c2 && c2.length >= windowSize + 10) {
            candles = c2;
            symbol  = symTWO;
          }
        } catch (_) {}
      }

      // 兩個都失敗 → fallback resolveYahooSymbol（打 Yahoo 確認）
      if (!candles || candles.length < windowSize + 10) {
        try {
          const resolved = await resolveYahooSymbol(code, period);
          candles = resolved.candles;
          symbol  = resolved.symbol;
        } catch (_) {}
      }

      if (!candles || candles.length < windowSize + 30) return null;

      const recent = candles.slice(-Math.max(windowSize, 240));

      // ── 三維評分 ──
      let sectorScore = null;
      try {
        const meta = await _fetchMetaQuiet(symbol);
        sectorScore = scoreSector(meta, template);
      } catch (_) {}

      const patternScore   = scorePattern(candles.slice(-(windowSize + 5)), template, 'simple');
      const indicatorScore = scoreIndicators(candles, template);
      const compositeScore = calcCompositeScore(sectorScore, patternScore, indicatorScore, weights);

      if (compositeScore < threshold) return null;

      const priceInfo = priceMap[code] ?? {};

      return {
        code,
        name:           priceInfo.name   ?? code,
        price:          priceInfo.price  ?? 0,
        chgPct:         priceInfo.chgPct ?? 0,
        sectorScore:    sectorScore ?? 0,
        patternScore,
        indicatorScore,
        compositeScore,
        sector:         null,
        industry:       null,
        miniCandles:    recent,
      };

    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('429')) return '429';
      if (attempt < MAX_RETRY) { await _sleep(800 * (attempt + 1)); continue; }
      return null;
    }
  }
  return null;
}

// ─── 輕量 meta 請求（只取 sector/industry，錯誤靜默） ────────
const _metaCache = new Map();

async function _fetchMetaQuiet(symbol) {
  if (_metaCache.has(symbol)) return _metaCache.get(symbol);
  // 直接用 Yahoo v8 quote endpoint 取 sector（輕量，比 fundamentals 快）
  const proxyList = [
    `https://corsproxy.io/?https://query2.finance.yahoo.com/v8/finance/quote?symbols=${symbol}&fields=sector,industry`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://query2.finance.yahoo.com/v8/finance/quote?symbols=${symbol}&fields=sector,industry`)}`,
  ];
  for (const url of proxyList) {
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const json = await res.json();
      const result = json?.quoteResponse?.result?.[0] ?? {};
      const meta = { sector: result.sector ?? null, industry: result.industry ?? null };
      _metaCache.set(symbol, meta);
      return meta;
    } catch (_) { /* try next proxy */ }
  }
  return { sector: null, industry: null };
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────
// 單股相似掃描
// ─────────────────────────────────────────────────────────────

/**
 * runSingleSeedScan(seedCode, opts) — AsyncGenerator
 *
 * 以單一種子股的近 N 日收盤漲跌幅序列為基準，
 * 用 Pearson 相關係數對全市場做相似度比對。
 *
 * opts:
 *   simMode    = 'technical' | 'marketcap' | 'mixed'
 *   scanScope  = 'fast' | 'full'
 *   lookback   = 60            // 比對天數
 *   threshold  = 0.75          // Pearson 最低門檻（-1~1）
 *   priceMin   = 0
 *   priceMax   = 99999
 */
export async function* runSingleSeedScan(seedCode, opts = {}) {
  const {
    simMode   = 'technical',
    scanScope = 'fast',
    lookback  = 60,
    threshold = 0.75,
    priceMin  = 0,
    priceMax  = 99999,
  } = opts;

  AppState.seed.scanResults = [];
  _abortController = new AbortController();
  const signal = _abortController.signal;

  // ── 取種子 K 線 ──
  yield { type: 'progress', done: 0, total: 0, message: `取得 ${seedCode} K 線…`, rateLimited: false };

  let seedCandles = null;
  const seedSymTW  = seedCode + '.TW';
  const seedSymTWO = seedCode + '.TWO';
  try {
    seedCandles = await fetchHistoryCached(seedSymTW, '1y', { allowStale: true });
  } catch (_) {}
  if (!seedCandles || seedCandles.length < lookback + 5) {
    try {
      seedCandles = await fetchHistoryCached(seedSymTWO, '1y', { allowStale: true });
    } catch (_) {}
  }
  if (!seedCandles || seedCandles.length < lookback + 5) {
    yield { type: 'error', message: `無法取得 ${seedCode} 的 K 線資料` };
    return;
  }

  // 種子序列：近 lookback 日收盤漲跌幅
  const seedReturns = _toReturns(seedCandles.slice(-(lookback + 1)));
  // 種子市值（用最後收盤估算，僅 mixed/marketcap 模式用）
  const seedPrice   = seedCandles[seedCandles.length - 1].close;

  // ── 取候選代號清單 ──
  yield { type: 'progress', done: 0, total: 0, message: '取得代號清單…', rateLimited: false };

  let priceMap = {};
  if (scanScope === 'full') {
    try {
      priceMap = await fetchTWSEPrices();
    } catch (_) {}
  }
  // fast 或 full 失敗 → fallback __priceCache
  if (!priceMap || Object.keys(priceMap).length === 0) {
    priceMap = window.__priceCache ?? {};
  }
  // 再 fallback getAllKnownCodes
  if (Object.keys(priceMap).length === 0) {
    getAllKnownCodes().forEach(c => { priceMap[c] = { price: 0, volume: 0, chgPct: 0 }; });
  }

  const allKeys = Object.keys(priceMap);
  const isNoPriceMode = allKeys.every(c => (priceMap[c]?.price ?? 0) === 0);

  const codes = allKeys.filter(code => {
    if (!/^\d{4,5}$/.test(code)) return false;
    if (code === seedCode) return false;
    if (!isNoPriceMode) {
      const p = priceMap[code]?.price ?? 0;
      if (p < priceMin || p > priceMax) return false;
    }
    return true;
  });

  const total = codes.length;
  yield { type: 'progress', done: 0, total, message: `掃描 ${total} 檔…`, rateLimited: false };

  let done = 0;
  let consecutive429 = 0;

  for (const code of codes) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }

    const item = await _scanOneSimilar(code, {
      seedReturns, seedPrice, lookback, simMode, threshold, signal, priceMap,
    });

    done++;

    if (item === '429') {
      consecutive429++;
      yield { type: 'progress', done, total, message: 'rate limit，放慢中…', rateLimited: true };
    } else {
      consecutive429 = Math.max(0, consecutive429 - 1);
      if (item) {
        AppState.seed.scanResults.push(item);
        yield { type: 'result', item, done, total };
      }
      yield { type: 'progress', done, total, message: `掃描中 ${done}/${total}…`, rateLimited: false };
    }

    const delay = 350 + Math.min(consecutive429 * 1000, 6000);
    await _sleep(delay);
  }

  AppState.seed.scanResults.sort((a, b) => b.compositeScore - a.compositeScore);
  yield { type: 'done', total };
  _abortController = null;
}

// ─── 單股相似評分 ────────────────────────────────────────────
async function _scanOneSimilar(code, opts) {
  const { seedReturns, seedPrice, lookback, simMode, threshold, signal, priceMap } = opts;
  if (signal?.aborted) return null;

  try {
    let candles = null;
    try { candles = await fetchHistoryCached(code + '.TW',  '1y', { allowStale: true }); } catch (_) {}
    if (!candles || candles.length < lookback + 5) {
      try { candles = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: true }); } catch (_) {}
    }
    if (!candles || candles.length < lookback + 5) return null;

    // 技術相似度（Pearson，0~1）
    const candReturns  = _toReturns(candles.slice(-(lookback + 1)));
    const pearson      = _pearson(seedReturns, candReturns);
    let techScore      = (pearson + 1) / 2;  // 轉換到 0~1

    // 市值相似度（0~1）
    let mcapScore = 1;
    if (simMode === 'marketcap' || simMode === 'mixed') {
      const candPrice = candles[candles.length - 1].close;
      const ratio     = candPrice / seedPrice;
      // ±50% 範圍內線性映射到 0~1（超出給 0）
      mcapScore = ratio >= 0.5 && ratio <= 1.5
        ? 1 - Math.abs(ratio - 1) / 0.5
        : 0;
    }

    // 合併分數
    let finalScore;
    if (simMode === 'marketcap')       finalScore = mcapScore;
    else if (simMode === 'mixed')      finalScore = techScore * 0.7 + mcapScore * 0.3;
    else /* technical */               finalScore = techScore;

    if (finalScore < threshold) return null;

    const priceInfo = priceMap[code] ?? {};
    const rawPrice  = priceInfo.price ?? candles[candles.length - 1]?.close ?? 0;
    return {
      code,
      name:           getChineseName(code) ?? priceInfo.name ?? code,
      price:          isFinite(rawPrice) ? rawPrice : 0,
      chgPct:         priceInfo.chgPct ?? 0,
      compositeScore: Math.round(finalScore * 100),
      patternScore:   Math.round(techScore  * 100),
      sectorScore:    simMode !== 'technical' ? Math.round(mcapScore * 100) : 0,
      indicatorScore: 0,
      miniCandles:    candles.slice(-240),
      _pearson:       pearson,
    };
  } catch (err) {
    if (String(err?.message ?? err).includes('429')) return '429';
    return null;
  }
}

// ─── 計算漲跌幅序列 ──────────────────────────────────────────
function _toReturns(candles) {
  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    returns.push(prev > 0 ? (candles[i].close - prev) / prev : 0);
  }
  return returns;
}

// ─── Pearson 相關係數 ─────────────────────────────────────────
function _pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - ma, y = bx[i] - mb;
    num += x * y;
    da  += x * x;
    db  += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom < 1e-10 ? 0 : num / denom;
}

