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
import { getKlineCache } from './db.js';
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

  // ── Phase B：IDB 批次預載（同 pattern-scan 架構）────────
  //   原版逐檔序列掃 + 每檔無條件 sleep(400ms)，1900 檔光 sleep 就 12+ 分鐘。
  //   改：一次性預載 IDB → hit 純計算零等待 → miss 最後低速補掃。
  yield { type: 'progress', done: 0, total, message: '載入本地快取…', rateLimited: false };

  const memCache  = new Map();
  const missCodes = [];
  const PRELOAD_CONCURRENCY = 32;

  for (let i = 0; i < codes.length; i += PRELOAD_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = codes.slice(i, i + PRELOAD_CONCURRENCY);
    await Promise.all(batch.map(async code => {
      const hit = await getKlineCache(code + '.TW',  '1y').catch(() => null)
               || await getKlineCache(code + '.TWO', '1y').catch(() => null);
      if (hit?.candles?.length) memCache.set(code, hit.candles);
      else missCodes.push(code);
    }));
    if ((i / PRELOAD_CONCURRENCY) % 4 === 0) {
      yield { type: 'progress', done: 0, total, message: `載入本地快取… (${Math.min(i + PRELOAD_CONCURRENCY, total)}/${total})`, rateLimited: false };
    }
  }

  // ── Phase C：cache hit 純計算（線型 + 指標，全本地）──────
  //   sector 評分需打外部 proxy 抓 meta（慢），延後到 Phase D 只對「接近門檻」
  //   的候選股做。若種子模板本身沒有產業資料（topSector=null），完全跳過。
  let done = 0;
  const needMeta   = !!template.topSector;
  const candidates = [];           // 待 Phase D 補 sector 的候選
  const COMPUTE_BATCH = 50;        // 指標計算較重，批次小一點

  const hitCodes = [...memCache.keys()];
  for (let i = 0; i < hitCodes.length; i += COMPUTE_BATCH) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }

    const batch = hitCodes.slice(i, i + COMPUTE_BATCH);
    for (const code of batch) {
      done++;
      const candles = memCache.get(code);
      if (!candles || candles.length < windowSize + 30) continue;

      const patternScore   = scorePattern(candles.slice(-(windowSize + 5)), template, 'simple');
      const indicatorScore = scoreIndicators(candles, template);
      // 先以「無產業資料」計分（sector 權重自動重分配）
      const nullComposite  = calcCompositeScore(null, patternScore, indicatorScore, weights);

      if (!needMeta) {
        if (nullComposite >= threshold) {
          const item = _buildSeedResult(code, candles, priceMap, {
            sectorScore: null, patternScore, indicatorScore, compositeScore: nullComposite,
          });
          AppState.seed.scanResults.push(item);
          yield { type: 'result', item, done, total };
        }
      } else if (nullComposite >= threshold - Math.round(weights.sector * 100)) {
        // sector 最多貢獻 weights.sector*100 分 → 低於此緩衝的不可能達標，直接淘汰
        candidates.push({ code, candles, patternScore, indicatorScore, nullComposite });
      }
    }

    yield { type: 'progress', done, total, message: `掃描中 ${done}/${total}…`, rateLimited: false };
    await _yieldToUI();
  }
  memCache.clear();

  // ── Phase D：候選股補 sector（只打接近門檻的，並發 6）────
  if (needMeta && candidates.length > 0) {
    yield { type: 'progress', done, total, message: `比對產業資料（${candidates.length} 檔候選）…`, rateLimited: false };
    const META_CONCURRENCY = 6;
    for (let i = 0; i < candidates.length; i += META_CONCURRENCY) {
      if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
      const batch = candidates.slice(i, i + META_CONCURRENCY);
      await Promise.all(batch.map(async cand => {
        let sectorScore = null;
        try {
          const meta = await _fetchMetaQuiet(toYahooSymbol(cand.code));
          sectorScore = scoreSector(meta, template);
        } catch (_) {}
        cand.sectorScore = sectorScore;
        cand.compositeScore = calcCompositeScore(sectorScore, cand.patternScore, cand.indicatorScore, weights);
      }));
      for (const cand of batch) {
        if (cand.compositeScore >= threshold) {
          const item = _buildSeedResult(cand.code, cand.candles, priceMap, cand);
          AppState.seed.scanResults.push(item);
          yield { type: 'result', item, done, total };
        }
      }
      yield { type: 'progress', done, total, message: `比對產業資料 (${Math.min(i + META_CONCURRENCY, candidates.length)}/${candidates.length})…`, rateLimited: false };
    }
  }

  // ── Phase E：cache miss 低速補掃 ─────────────────────────
  let consecutive429 = 0;
  const MISS_CONCURRENCY = 4;
  for (let i = 0; i < missCodes.length; i += MISS_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }

    const batch = missCodes.slice(i, i + MISS_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(code =>
      signal.aborted ? Promise.resolve(null) :
      _scanOne(code, template, { weights, windowSize, period: '1y', threshold, signal, priceMap })
    ));

    let batchHas429 = false;
    for (const result of batchResults) {
      done++;
      if (result === '429') { batchHas429 = true; consecutive429++; }
      else {
        consecutive429 = Math.max(0, consecutive429 - 1);
        if (result) {
          AppState.seed.scanResults.push(result);
          yield { type: 'result', item: result, done, total };
        }
      }
    }
    yield { type: 'progress', done, total,
            message: batchHas429 ? 'rate limit，放慢中…' : `補抓缺漏資料 ${done}/${total}…`,
            rateLimited: batchHas429 };
    await _sleep(batchHas429 ? 800 + Math.min(consecutive429 * 1200, 8000) : 200);
  }

  AppState.seed.scanResults.sort((a, b) => b.compositeScore - a.compositeScore);
  yield { type: 'done', total, elapsed: 0 };
  _abortController = null;
}

// ─── 結果物件組裝（Phase C/D 共用） ───────────────────────
function _buildSeedResult(code, candles, priceMap, scores) {
  const priceInfo = priceMap[code] ?? {};
  const last = candles[candles.length - 1];
  return {
    code,
    name:           getChineseName(code) ?? priceInfo.name ?? code,
    price:          (isFinite(priceInfo.price) && priceInfo.price > 0) ? priceInfo.price : (last?.close ?? 0),
    chgPct:         priceInfo.chgPct ?? 0,
    sectorScore:    scores.sectorScore ?? 0,
    patternScore:   scores.patternScore,
    indicatorScore: scores.indicatorScore,
    compositeScore: scores.compositeScore,
    sector:         null,
    industry:       null,
    miniCandles:    candles.slice(-240),
  };
}

function _yieldToUI() {
  return new Promise(r => setTimeout(r, 0));
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

  // ── IDB 批次預載 → 純計算 → miss 補掃（同 pattern-scan 架構）──
  yield { type: 'progress', done: 0, total, message: '載入本地快取…', rateLimited: false };

  const memCache  = new Map();
  const missCodes = [];
  const PRELOAD_CONCURRENCY = 32;
  for (let i = 0; i < codes.length; i += PRELOAD_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = codes.slice(i, i + PRELOAD_CONCURRENCY);
    await Promise.all(batch.map(async code => {
      const hit = await getKlineCache(code + '.TW',  '1y').catch(() => null)
               || await getKlineCache(code + '.TWO', '1y').catch(() => null);
      if (hit?.candles?.length) memCache.set(code, hit.candles);
      else missCodes.push(code);
    }));
    if ((i / PRELOAD_CONCURRENCY) % 4 === 0) {
      yield { type: 'progress', done: 0, total, message: `載入本地快取… (${Math.min(i + PRELOAD_CONCURRENCY, total)}/${total})`, rateLimited: false };
    }
  }

  let done = 0;
  const COMPUTE_BATCH = 150;   // Pearson O(n)，很輕，批次可大
  const hitCodes = [...memCache.keys()];
  for (let i = 0; i < hitCodes.length; i += COMPUTE_BATCH) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = hitCodes.slice(i, i + COMPUTE_BATCH);
    for (const code of batch) {
      done++;
      const candles = memCache.get(code);
      if (!candles || candles.length < lookback + 5) continue;
      const item = _scoreSimilar(code, candles, { seedReturns, seedPrice, lookback, simMode, threshold, priceMap });
      if (item) {
        AppState.seed.scanResults.push(item);
        yield { type: 'result', item, done, total };
      }
    }
    yield { type: 'progress', done, total, message: `掃描中 ${done}/${total}…`, rateLimited: false };
    await _yieldToUI();
  }
  memCache.clear();

  // miss 低速補掃
  let consecutive429 = 0;
  const MISS_CONCURRENCY = 4;
  for (let i = 0; i < missCodes.length; i += MISS_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = missCodes.slice(i, i + MISS_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(code =>
      signal.aborted ? Promise.resolve(null) :
      _scanOneSimilar(code, { seedReturns, seedPrice, lookback, simMode, threshold, signal, priceMap })
    ));
    let batchHas429 = false;
    for (const item of batchResults) {
      done++;
      if (item === '429') { batchHas429 = true; consecutive429++; }
      else {
        consecutive429 = Math.max(0, consecutive429 - 1);
        if (item) {
          AppState.seed.scanResults.push(item);
          yield { type: 'result', item, done, total };
        }
      }
    }
    yield { type: 'progress', done, total,
            message: batchHas429 ? 'rate limit，放慢中…' : `補抓缺漏資料 ${done}/${total}…`,
            rateLimited: batchHas429 };
    await _sleep(batchHas429 ? 800 + Math.min(consecutive429 * 1000, 6000) : 200);
  }

  AppState.seed.scanResults.sort((a, b) => b.compositeScore - a.compositeScore);
  yield { type: 'done', total };
  _abortController = null;
}

// ─── 單股相似評分：純計算（hit 路徑直接呼叫） ────────────────
function _scoreSimilar(code, candles, opts) {
  const { seedReturns, seedPrice, lookback, simMode, threshold, priceMap } = opts;

  // 技術相似度（Pearson，0~1）
  const candReturns = _toReturns(candles.slice(-(lookback + 1)));
  const pearson     = _pearson(seedReturns, candReturns);
  let techScore     = (pearson + 1) / 2;

  // 市值相似度（0~1）
  let mcapScore = 1;
  if (simMode === 'marketcap' || simMode === 'mixed') {
    const candPrice = candles[candles.length - 1].close;
    const ratio     = candPrice / seedPrice;
    mcapScore = ratio >= 0.5 && ratio <= 1.5 ? 1 - Math.abs(ratio - 1) / 0.5 : 0;
  }

  let finalScore;
  if (simMode === 'marketcap')  finalScore = mcapScore;
  else if (simMode === 'mixed') finalScore = techScore * 0.7 + mcapScore * 0.3;
  else                          finalScore = techScore;

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
}

// ─── 單股相似評分：含網路抓取（僅 miss 路徑使用） ─────────────
async function _scanOneSimilar(code, opts) {
  const { lookback, signal } = opts;
  if (signal?.aborted) return null;
  try {
    let candles = null;
    try { candles = await fetchHistoryCached(code + '.TW',  '1y', { allowStale: true }); } catch (_) {}
    if (!candles || candles.length < lookback + 5) {
      try { candles = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: true }); } catch (_) {}
    }
    if (!candles || candles.length < lookback + 5) return null;
    return _scoreSimilar(code, candles, opts);
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


// ─────────────────────────────────────────────────────────────
// 領漲-跟漲掃描（lag-ui.js 專用）
// ─────────────────────────────────────────────────────────────

/**
 * runLagScan(leaderCode, opts) — AsyncGenerator
 *
 * 以領漲股「lag 天前」的走勢為基準，找現在走勢與其高度相關的跟漲候選。
 * 比對式：pearson( leader[t-lookback-lag .. t-lag], candidate[t-lookback .. t] )
 * 對每檔候選自動掃 lag = 1..maxLag，取相關性最高的 lag 回報。
 *
 * opts: { maxLag=5, lookback=40, threshold=0.7, priceMin=0, priceMax=99999 }
 */
export async function* runLagScan(leaderCode, opts = {}) {
  const {
    maxLag    = 5,
    lookback  = 40,
    threshold = 0.7,
    priceMin  = 0,
    priceMax  = 99999,
  } = opts;

  AppState.seed.scanResults = [];
  _abortController = new AbortController();
  const signal = _abortController.signal;

  // ── 領漲股 K 線（需 lookback + maxLag + 1 根以上）──
  yield { type: 'progress', done: 0, total: 0, message: `取得 ${leaderCode} K 線…`, rateLimited: false };

  let leaderCandles = null;
  try { leaderCandles = await fetchHistoryCached(leaderCode + '.TW',  '1y', { allowStale: true }); } catch (_) {}
  if (!leaderCandles || leaderCandles.length < lookback + maxLag + 1) {
    try { leaderCandles = await fetchHistoryCached(leaderCode + '.TWO', '1y', { allowStale: true }); } catch (_) {}
  }
  if (!leaderCandles || leaderCandles.length < lookback + maxLag + 1) {
    yield { type: 'error', message: `無法取得 ${leaderCode} 的 K 線資料（需 ${lookback + maxLag + 1} 根以上）` };
    return;
  }

  // 領漲股各 lag 的報酬序列預先切好：lagSegs[L] = lag=L 時的比對段（長度 lookback）
  const leaderReturns = _toReturns(leaderCandles);  // 長度 = candles-1
  const lagSegs = [];
  for (let L = 1; L <= maxLag; L++) {
    // 最近 lookback 段往前平移 L 天
    const end = leaderReturns.length - L;
    lagSegs[L] = leaderReturns.slice(end - lookback, end);
  }

  // ── 代號清單（沿用 priceMap 流程）──
  yield { type: 'progress', done: 0, total: 0, message: '取得代號清單…', rateLimited: false };
  let priceMap;
  try { priceMap = await fetchTWSEPrices(); }
  catch (_) { priceMap = window.__priceCache ?? {}; }
  if (!priceMap || Object.keys(priceMap).length === 0) {
    priceMap = window.__priceCache ?? {};
    if (Object.keys(priceMap).length === 0) {
      const cs = getAllKnownCodes();
      priceMap = {};
      cs.forEach(c => { priceMap[c] = { name: getChineseName(c) ?? c, price: 0, volume: 0, chgPct: 0 }; });
    }
  }
  const allKeys = Object.keys(priceMap);
  const isNoPriceMode = allKeys.length > 0 && allKeys.every(c => (priceMap[c]?.price ?? 0) === 0);
  // 代號白名單：4 碼個股/ETF + 00 開頭 ETF 家族（如 00878、00632R）
  //   排除權證（6 碼數字）與 TDR（91 開頭 6 碼）；ETF 依需求保留
  const _isStockOrETF = code => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);
  const codes = allKeys.filter(code => {
    if (!_isStockOrETF(code)) return false;
    if (code === leaderCode) return false;          // 排除領漲股自己
    if (isNoPriceMode) return true;
    const d = priceMap[code];
    if (!d) return false;
    if (d.price < priceMin || d.price > priceMax) return false;
    return true;
  });
  const total = codes.length;

  // ── IDB 預載 → 純計算 → miss 補掃 ──
  yield { type: 'progress', done: 0, total, message: '載入本地快取…', rateLimited: false };
  const memCache  = new Map();
  const missCodes = [];
  const PRELOAD_CONCURRENCY = 32;
  for (let i = 0; i < codes.length; i += PRELOAD_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = codes.slice(i, i + PRELOAD_CONCURRENCY);
    await Promise.all(batch.map(async code => {
      const hit = await getKlineCache(code + '.TW',  '1y').catch(() => null)
               || await getKlineCache(code + '.TWO', '1y').catch(() => null);
      if (hit?.candles?.length) memCache.set(code, hit.candles);
      else missCodes.push(code);
    }));
    if ((i / PRELOAD_CONCURRENCY) % 4 === 0) {
      yield { type: 'progress', done: 0, total, message: `載入本地快取… (${Math.min(i + PRELOAD_CONCURRENCY, total)}/${total})`, rateLimited: false };
    }
  }

  let done = 0;
  const COMPUTE_BATCH = 150;
  const hitCodes = [...memCache.keys()];
  for (let i = 0; i < hitCodes.length; i += COMPUTE_BATCH) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = hitCodes.slice(i, i + COMPUTE_BATCH);
    for (const code of batch) {
      done++;
      const candles = memCache.get(code);
      const item = _scoreLag(code, candles, { lagSegs, maxLag, lookback, threshold, priceMap });
      if (item) {
        AppState.seed.scanResults.push(item);
        yield { type: 'result', item, done, total };
      }
    }
    yield { type: 'progress', done, total, message: `掃描中 ${done}/${total}…`, rateLimited: false };
    await _yieldToUI();
  }
  memCache.clear();

  // miss 低速補掃
  const MISS_CONCURRENCY = 4;
  for (let i = 0; i < missCodes.length; i += MISS_CONCURRENCY) {
    if (signal.aborted) { yield { type: 'aborted', message: '掃描已取消' }; return; }
    const batch = missCodes.slice(i, i + MISS_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async code => {
      if (signal.aborted) return null;
      let candles = null;
      try { candles = await fetchHistoryCached(code + '.TW',  '1y', { allowStale: true }); } catch (_) {}
      if (!candles || candles.length < lookback + 2) {
        try { candles = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: true }); } catch (_) {}
      }
      return _scoreLag(code, candles, { lagSegs, maxLag, lookback, threshold, priceMap });
    }));
    for (const item of batchResults) {
      done++;
      if (item) {
        AppState.seed.scanResults.push(item);
        yield { type: 'result', item, done, total };
      }
    }
    yield { type: 'progress', done, total, message: `補抓缺漏資料 ${done}/${total}…`, rateLimited: false };
    await _sleep(200);
  }

  AppState.seed.scanResults.sort((a, b) => b.compositeScore - a.compositeScore);
  yield { type: 'done', total };
  _abortController = null;
}

// ─── 領漲-跟漲：單檔評分（純計算）────────────────────────────
function _scoreLag(code, candles, opts) {
  const { lagSegs, maxLag, lookback, threshold, priceMap } = opts;
  if (!candles || candles.length < lookback + 2) return null;

  // 候選股「現在」的比對段：最近 lookback 天報酬
  const candReturns = _toReturns(candles.slice(-(lookback + 1)));

  let bestCorr = -2, bestLag = 0;
  for (let L = 1; L <= maxLag; L++) {
    const corr = _pearson(lagSegs[L], candReturns);
    if (corr > bestCorr) { bestCorr = corr; bestLag = L; }
  }
  if (bestCorr < threshold) return null;

  const priceInfo = priceMap[code] ?? {};
  const last      = candles[candles.length - 1];
  const rawPrice  = (isFinite(priceInfo.price) && priceInfo.price > 0) ? priceInfo.price : (last?.close ?? 0);
  return {
    code,
    name:           getChineseName(code) ?? priceInfo.name ?? code,
    price:          rawPrice,
    chgPct:         priceInfo.chgPct ?? 0,
    compositeScore: Math.round(bestCorr * 100),  // 相關性 0~100
    lag:            bestLag,                     // 落後天數
    miniCandles:    candles.slice(-240),
    _pearson:       bestCorr,
  };
}
