/**
 * seed-scan.js — Phase 4 種子選股全市場掃描
 *
 * 兩階段：
 *   Phase A：TWSE priceMap 過濾（瞬間，無額外請求）
 *   Phase B：逐一拉 Yahoo Finance K 線 → 三維評分
 *
 * export：
 *   runSeedScan(template, opts)  ← AsyncGenerator
 *   abortSeedScan()
 */

import { fetchTWSEPrices, fetchHistoryCached, resolveYahooSymbol, fetchFundamentals, getAllKnownCodes, getChineseName } from './api.js';
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
      // resolveYahooSymbol：自動試 .TW/.TWO，有 staleCandles fallback
      // fetchHistoryCached：KV HIT 時極快，miss 才打 Yahoo
      const { symbol, candles } = await resolveYahooSymbol(code, period);
      if (!candles || candles.length < windowSize + 30) return null;

      const recent = candles.slice(-windowSize);

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
