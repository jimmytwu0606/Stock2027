/**
 * pattern.js — Phase 3 型態比對核心演算法
 * 職責：K線正規化、DTW 相似度計算、相似度分數轉換
 * 依賴：無（純計算，不 import 任何模組）
 */

// ─── 正規化 ───────────────────────────────────────────────

/**
 * 將 Candle[] 的收盤價序列正規化為 0~1 範圍（min-max）
 * @param {Candle[]} candles
 * @returns {number[]} 正規化後的數值序列
 */
export function normalizeCandles(candles) {
  const closes = candles.map(c => c.close);
  return normalizeSeries(closes);
}

/**
 * 將任意數值序列正規化為 0~1
 * @param {number[]} series
 * @returns {number[]}
 */
export function normalizeSeries(series) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  if (range === 0) return series.map(() => 0.5);
  return series.map(v => (v - min) / range);
}

/**
 * 將 Candle[] 轉為多維特徵向量序列（收盤、振幅、成交量變化）
 * 用於更精準的 DTW 比對（可選）
 * @param {Candle[]} candles
 * @returns {number[][]} 每根 K 棒一個特徵向量 [normClose, normRange, normVolChg]
 */
export function candlesToFeatures(candles) {
  const closes  = normalizeSeries(candles.map(c => c.close));
  const ranges  = normalizeSeries(candles.map(c => c.high - c.low));
  const volumes = candles.map(c => c.volume);
  // 成交量日變化率
  const volChgs = volumes.map((v, i) =>
    i === 0 ? 0 : (v - volumes[i - 1]) / (volumes[i - 1] || 1)
  );
  const normVolChgs = normalizeSeries(volChgs.map(v => Math.max(-2, Math.min(2, v))));

  return closes.map((c, i) => [c, ranges[i], normVolChgs[i]]);
}

// ─── DTW ──────────────────────────────────────────────────

/**
 * Dynamic Time Warping 距離計算（1D 序列）
 * 時間複雜度 O(n*m)，m n 為兩序列長度
 * @param {number[]} a 查詢序列（template）
 * @param {number[]} b 目標序列
 * @param {number} [window=Infinity] Sakoe-Chiba 視窗（限制扭曲範圍，提升速度）
 * @returns {number} DTW 距離（越小越相似）
 */
export function calcDTW(a, b, window = Infinity) {
  const n = a.length;
  const m = b.length;
  // 使用 Float32Array 降低 GC 壓力
  const dtw = new Float32Array(n * m).fill(Infinity);

  const idx = (i, j) => i * m + j;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (Math.abs(i - j) > window) continue;
      const cost = Math.abs(a[i] - b[j]);
      const prev = Math.min(
        i > 0 ? dtw[idx(i - 1, j)]     : Infinity,
        j > 0 ? dtw[idx(i, j - 1)]     : Infinity,
        i > 0 && j > 0 ? dtw[idx(i - 1, j - 1)] : Infinity,
      );
      dtw[idx(i, j)] = cost + (prev === Infinity ? 0 : prev);
    }
  }

  return dtw[idx(n - 1, m - 1)];
}

/**
 * 多維序列 DTW（特徵向量版本）
 * @param {number[][]} a
 * @param {number[][]} b
 * @param {number} [window=Infinity]
 * @returns {number}
 */
export function calcDTWMulti(a, b, window = Infinity) {
  const n = a.length;
  const m = b.length;
  const dtw = new Float32Array(n * m).fill(Infinity);
  const idx = (i, j) => i * m + j;

  const euclidean = (va, vb) => {
    let sum = 0;
    for (let k = 0; k < va.length; k++) sum += (va[k] - vb[k]) ** 2;
    return Math.sqrt(sum);
  };

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (Math.abs(i - j) > window) continue;
      const cost = euclidean(a[i], b[j]);
      const prev = Math.min(
        i > 0 ? dtw[idx(i - 1, j)]     : Infinity,
        j > 0 ? dtw[idx(i, j - 1)]     : Infinity,
        i > 0 && j > 0 ? dtw[idx(i - 1, j - 1)] : Infinity,
      );
      dtw[idx(i, j)] = cost + (prev === Infinity ? 0 : prev);
    }
  }

  return dtw[idx(n - 1, m - 1)];
}

// ─── 相似度計算 ────────────────────────────────────────────

/**
 * 將 DTW 距離轉換為 0~100 的相似度分數
 * 距離 0 → 100分；距離 ≥ maxDist → 0分
 * @param {number} dtwDist
 * @param {number} [maxDist=5] 認定為完全不相似的距離上限（正規化後序列用）
 * @returns {number} 0~100
 */
export function distToSimilarity(dtwDist, maxDist = 5) {
  const score = Math.max(0, 1 - dtwDist / maxDist) * 100;
  return Math.round(score * 10) / 10;
}

/**
 * 主要入口：計算兩段 K 線的相似度
 * @param {Candle[]} templateCandles  範本 K 線
 * @param {Candle[]} targetCandles    目標 K 線片段（長度可不同）
 * @param {'simple'|'multi'} [mode='simple']  simple=只用收盤價，multi=多維特徵
 * @returns {number} 相似度分數 0~100
 */
export function calcSimilarity(templateCandles, targetCandles, mode = 'simple') {
  if (templateCandles.length < 3 || targetCandles.length < 3) return 0;

  if (mode === 'multi') {
    const a = candlesToFeatures(templateCandles);
    const b = candlesToFeatures(targetCandles);
    const w = Math.floor(Math.max(a.length, b.length) * 0.2);
    const dist = calcDTWMulti(a, b, w);
    // 多維距離 maxDist 調高（維度多距離自然大）
    return distToSimilarity(dist, a.length * 1.5);
  } else {
    const a = normalizeCandles(templateCandles);
    const b = normalizeCandles(targetCandles);
    const w = Math.floor(Math.max(a.length, b.length) * 0.2);
    const dist = calcDTW(a, b, w);
    return distToSimilarity(dist, a.length * 0.5);
  }
}

// ─── 滑動視窗掃描 ──────────────────────────────────────────

/**
 * 在一段較長的 K 線中，用滑動視窗找出與範本最相似的片段
 * @param {Candle[]} templateCandles  範本
 * @param {Candle[]} allCandles       目標股票的完整 K 線（較長）
 * @param {number}  [tolerance=5]    視窗長度容忍（±N根）
 * @returns {{ score: number, startIdx: number, endIdx: number }}
 */
export function findBestMatch(templateCandles, allCandles, tolerance = 5) {
  const tLen = templateCandles.length;
  const totalLen = allCandles.length;

  if (totalLen < tLen) {
    // 目標太短，直接比對全段
    const score = calcSimilarity(templateCandles, allCandles);
    return { score, startIdx: 0, endIdx: allCandles.length - 1 };
  }

  let bestScore = -1;
  let bestStart = 0;

  // 只掃描最近 60 根（避免掃太久），可依需求調整
  const scanFrom = Math.max(0, totalLen - 60);

  for (let i = scanFrom; i <= totalLen - tLen; i++) {
    const segment = allCandles.slice(i, i + tLen);
    const score = calcSimilarity(templateCandles, segment);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  return {
    score:    bestScore,
    startIdx: bestStart,
    endIdx:   bestStart + tLen - 1,
  };
}

// ─── 型態描述工具 ──────────────────────────────────────────

/**
 * 簡單分析 K 線型態特徵（供 UI 顯示用）
 * @param {Candle[]} candles
 * @returns {{ trend: string, volatility: string, label: string }}
 */
export function describePattern(candles) {
  if (!candles || candles.length < 3) return { trend: '–', volatility: '–', label: '未知' };

  const closes = candles.map(c => c.close);
  const first = closes[0];
  const last  = closes[closes.length - 1];
  const mid   = closes[Math.floor(closes.length / 2)];
  const chgPct = ((last - first) / first) * 100;

  // 波動率
  const normalized = normalizeSeries(closes);
  const volatility = Math.max(...normalized) - Math.min(...normalized);

  let trend, volLabel, label;

  // 趨勢判斷
  if (chgPct > 5)       trend = '強勢上漲';
  else if (chgPct > 1)  trend = '溫和上漲';
  else if (chgPct < -5) trend = '強勢下跌';
  else if (chgPct < -1) trend = '溫和下跌';
  else                   trend = '盤整';

  // 波動
  if (volatility > 0.3)      volLabel = '高波動';
  else if (volatility > 0.1) volLabel = '中波動';
  else                        volLabel = '低波動';

  // 嘗試識別常見型態
  const firstHalf  = closes.slice(0, Math.floor(closes.length / 2));
  const secondHalf = closes.slice(Math.floor(closes.length / 2));
  const firstMin   = Math.min(...firstHalf);
  const secondMin  = Math.min(...secondHalf);
  const firstMax   = Math.max(...firstHalf);
  const secondMax  = Math.max(...secondHalf);

  if (mid < first * 0.97 && mid < last * 0.97) {
    label = 'V型反轉';
  } else if (mid > first * 1.03 && mid > last * 1.03) {
    label = '倒V型';
  } else if (Math.abs(firstMin - secondMin) / firstMin < 0.03 && mid > firstMin * 1.05) {
    label = 'W底';
  } else if (Math.abs(firstMax - secondMax) / firstMax < 0.03 && mid < firstMax * 0.95) {
    label = 'M頭';
  } else if (chgPct > 3 && volatility < 0.15) {
    label = '緩步上漲';
  } else if (chgPct < -3 && volatility < 0.15) {
    label = '緩步下跌';
  } else {
    label = trend;
  }

  return { trend, volatility: volLabel, label, chgPct: chgPct.toFixed(1) };
}
