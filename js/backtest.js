/**
 * backtest.js — Phase 3 歷史型態勝率回測
 * 職責：
 *   - 在單支股票的完整 K 線中，找出所有歷史上相似型態的出現位置
 *   - 統計每次出現後 N 日的漲跌，計算勝率 / 平均報酬 / 最大獲利損失
 * 依賴：pattern.js（calcSimilarity）
 */

import { calcSimilarity } from './pattern.js';

// ─── 主函式 ────────────────────────────────────────────────

/**
 * 對單支股票做歷史回測
 * @param {Candle[]} templateCandles  範本
 * @param {Candle[]} allCandles       目標股票完整 K 線（越長越好，建議 1~2 年）
 * @param {object}  opts
 * @param {number}  opts.holdDays     持有天數（默認 5）
 * @param {number}  opts.minScore     最低相似度門檻（默認 70）
 * @param {string}  opts.featureMode  'simple' | 'multi'
 * @returns {BacktestResult}
 */
export function runBacktest(templateCandles, allCandles, opts = {}) {
  const {
    holdDays    = 5,
    minScore    = 70,
    featureMode = 'simple',
  } = opts;

  const tLen   = templateCandles.length;
  const total  = allCandles.length;
  const hits   = [];

  // 滑動視窗掃描（不重疊，排除最後 holdDays 根避免未來資料）
  let i = 0;
  while (i <= total - tLen - holdDays) {
    const segment = allCandles.slice(i, i + tLen);
    const score   = calcSimilarity(templateCandles, segment, featureMode);

    if (score >= minScore) {
      // 記錄此次命中
      const entryClose = allCandles[i + tLen - 1].close;  // 型態最後一根收盤進場
      const exitClose  = allCandles[i + tLen - 1 + holdDays]?.close;

      if (exitClose != null) {
        const ret = ((exitClose - entryClose) / entryClose) * 100;
        hits.push({
          startIdx:   i,
          endIdx:     i + tLen - 1,
          score,
          entryDate:  allCandles[i + tLen - 1].time,
          exitDate:   allCandles[i + tLen - 1 + holdDays].time,
          entryClose,
          exitClose,
          returnPct:  Math.round(ret * 100) / 100,
          win:        ret > 0,
        });
      }

      // 跳過已命中的區間（避免重疊）
      i += tLen;
    } else {
      i++;
    }
  }

  return _summarize(hits, holdDays);
}

// ─── 統計彙總 ──────────────────────────────────────────────

/**
 * @typedef {object} BacktestResult
 * @property {number} totalHits        命中次數
 * @property {number} winRate          勝率 % (0~100)
 * @property {number} avgReturn        平均報酬 %
 * @property {number} maxGain          最大獲利 %
 * @property {number} maxLoss          最大虧損 %
 * @property {number} holdDays         持有天數
 * @property {HitRecord[]} hits        詳細命中記錄
 */
function _summarize(hits, holdDays) {
  if (hits.length === 0) {
    return {
      totalHits: 0, winRate: 0, avgReturn: 0,
      maxGain: 0, maxLoss: 0, holdDays, hits: [],
    };
  }

  const wins     = hits.filter(h => h.win).length;
  const rets     = hits.map(h => h.returnPct);
  const avgRet   = rets.reduce((a, b) => a + b, 0) / rets.length;
  const maxGain  = Math.max(...rets);
  const maxLoss  = Math.min(...rets);

  return {
    totalHits: hits.length,
    winRate:   Math.round((wins / hits.length) * 1000) / 10,
    avgReturn: Math.round(avgRet * 100) / 100,
    maxGain:   Math.round(maxGain * 100) / 100,
    maxLoss:   Math.round(maxLoss * 100) / 100,
    holdDays,
    hits,
  };
}

// ─── 批次回測（多支股票） ────────────────────────────────────

/**
 * 對多支股票做批次回測，回傳彙總後的跨市場統計
 * @param {Candle[]} templateCandles
 * @param {Array<{ code: string, candles: Candle[] }>} stockList
 * @param {object} opts
 * @returns {AggregateBacktestResult}
 */
export function runBatchBacktest(templateCandles, stockList, opts = {}) {
  const results = stockList
    .map(({ code, candles }) => ({
      code,
      ...runBacktest(templateCandles, candles, opts),
    }))
    .filter(r => r.totalHits > 0);

  if (results.length === 0) {
    return { stocks: 0, totalHits: 0, winRate: 0, avgReturn: 0, results: [] };
  }

  // 合併所有 hits
  const allHits = results.flatMap(r => r.hits);
  const wins    = allHits.filter(h => h.win).length;
  const rets    = allHits.map(h => h.returnPct);

  return {
    stocks:    results.length,
    totalHits: allHits.length,
    winRate:   Math.round((wins / allHits.length) * 1000) / 10,
    avgReturn: Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 100) / 100,
    maxGain:   Math.round(Math.max(...rets) * 100) / 100,
    maxLoss:   Math.round(Math.min(...rets) * 100) / 100,
    results,   // 各股個別結果
  };
}

// ─── 報酬分布 ──────────────────────────────────────────────

/**
 * 計算報酬分布（供長條圖 UI 使用）
 * @param {HitRecord[]} hits
 * @param {number} [bucketSize=2] 每個區間的寬度（%）
 * @returns {{ label: string, count: number }[]}
 */
export function calcReturnDistribution(hits, bucketSize = 2) {
  if (!hits.length) return [];

  const rets  = hits.map(h => h.returnPct);
  const min   = Math.floor(Math.min(...rets) / bucketSize) * bucketSize;
  const max   = Math.ceil(Math.max(...rets) / bucketSize) * bucketSize;

  const buckets = {};
  for (let r = min; r <= max; r += bucketSize) {
    buckets[r] = 0;
  }
  for (const ret of rets) {
    const key = Math.floor(ret / bucketSize) * bucketSize;
    if (buckets[key] != null) buckets[key]++;
  }

  // ⚠️ Object.entries 對數字 key 會「正整數升序在前、其餘字串在後」，
  //   導致負數 bucket（"-18"）排到正數後面 → X 軸順序錯亂。
  //   必須明確依數值排序，不能依賴物件 key 列舉順序。
  return Object.entries(buckets)
    .map(([label, count]) => ({
      value: Number(label),
      label: `${Number(label) >= 0 ? '+' : ''}${label}%`,
      count,
      isPositive: Number(label) >= 0,
    }))
    .sort((a, b) => a.value - b.value);
}
