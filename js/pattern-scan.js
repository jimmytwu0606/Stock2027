/**
 * pattern-scan.js — Phase 3 全市場型態掃描
 * 職責：
 *   - 接收範本 Candle[]，批次掃描全市場 K 線
 *   - AsyncGenerator 逐步回傳進度與結果
 *   - 管理掃描取消
 *   - 429 rate limit 指數退避重試
 */

import { fetchTWSEPrices, fetchHistory, toYahooSymbol, getChineseName, getAllKnownCodes } from './api.js';
import { findBestMatch } from './pattern.js';
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
  const {
    similarity  = AppState.pattern.similarity  || 75,
    windowSize  = AppState.pattern.windowSize  || 20,
    featureMode = AppState.pattern.featureMode || 'simple',
    period      = Config.screenerPeriod        || '3mo',
    // 強制並發數最高 2，避免 429
    concurrency = Math.min(Config.concurrency  || 3, 2),
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
    // 用 priceMap 過濾
    const allKeys = Object.keys(priceMap);
    const isNoPriceMode = allKeys.length > 0 && allKeys.every(c => (priceMap[c]?.price ?? 0) === 0);
    codes = allKeys.filter(code => {
      if (!/^\d{4}$/.test(code)) return false;
      if (isNoPriceMode) return true;
      const d = priceMap[code];
      if (!d) return false;
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
        // 遇到無法恢復的 429，記錄並繼續
        consecutive429++;
        yield { type: 'progress', phase: 'scan', message: `掃描中（rate limit，放慢中）…`, done, total };
      } else {
        consecutive429 = Math.max(0, consecutive429 - 1); // 成功則遞減
        if (result && result.score >= similarity) {
          results.push(result);
          yield { type: 'result', item: result, done, total };
        }
        yield { type: 'progress', phase: 'scan', message: `掃描中…`, done, total };
      }

      // 批次內每股之間固定間隔
      // 若連續碰到 429，間隔指數增加（最長 8 秒）
      const baseDelay = 400;
      const extraDelay = Math.min(consecutive429 * 1000, 8000);
      await _sleep(baseDelay + extraDelay);
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
  const symbol = toYahooSymbol(code);
  // .TWO（上櫃）在 Yahoo Finance 多數 404，直接跳過節省時間
  if (symbol.endsWith('.TWO')) return null;
  if (signal?.aborted) return null;

  // 最多重試 2 次（僅針對非 429 錯誤）
  const MAX_RETRY = 2;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) return null;

    try {
      const candles = await fetchHistory(symbol, period);

      if (!candles || candles.length < windowSize) return null;

      // ── 只取最近 N 根（windowSize），不滑動掃描歷史 ──
      // 目的：找「現在正在發生」的相似走勢，而非歷史某段
      const recent = candles.slice(-windowSize);
      const { score } = findBestMatch(templateCandles, recent);

      return {
        code,
        name:        getChineseName(code) ?? priceMap?.[code]?.name ?? '',
        score:       Math.round(score * 10) / 10,
        startIdx:    0,
        endIdx:      windowSize - 1,
        candles:     recent,
        fullCandles: candles,
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
