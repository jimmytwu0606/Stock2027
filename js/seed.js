/**
 * seed.js — Phase 4 種子選股
 * 純計算模組（無網路請求、無外部依賴）
 *
 * export：
 *   extractSeedFeatures(candles, fundamentals)
 *   mergeTemplates(features[])
 *   scoreSector(candidateFundamentals, template)
 *   scorePattern(candidateCandles, template)
 *   scoreIndicators(candidateCandles, template)
 *   calcCompositeScore(sector, pattern, indicator, weights)
 *   defaultWeights()
 *   describeTemplate(template)
 *   templateDivergenceWarning(template)
 */

import { calcRSI, calcKD, calcMACD, calcMA } from './indicators.js';
import { normalizeCandles, calcSimilarity }   from './pattern.js';

// ─── 預設評分權重 ─────────────────────────────────────────
export function defaultWeights() {
  return { sector: 0.25, pattern: 0.50, indicator: 0.25 };
}

// ─── 特徵萃取（單支種子股） ────────────────────────────────
/**
 * @param {Candle[]} candles     - 完整 K 線（需足夠長度供指標計算）
 * @param {object}  fundamentals - Yahoo v8 meta 或 FinMind 回傳
 * @param {number}  windowSize   - 取最後 N 根作為型態樣本，預設 20
 * @returns {SeedFeature}
 */
export function extractSeedFeatures(candles, fundamentals = {}, windowSize = 20) {
  if (!candles || candles.length < windowSize) return null;

  const closes = candles.map(c => c.close);

  // 技術指標（取最後一值）
  const rsiArr  = calcRSI(closes, 14);
  const kdObj   = calcKD(candles, 9);
  const macdObj = calcMACD(closes, 12, 26, 9);
  const ma20Arr = calcMA(closes, 20);

  const last    = candles.length - 1;
  const rsi     = rsiArr[last]      ?? 50;
  const kdK     = kdObj.k[last]     ?? 50;
  const hist    = macdObj.hist[last] ?? 0;
  const ma20    = ma20Arr[last]     ?? closes[last];

  const macdSign  = hist > 0.001 ? 1 : hist < -0.001 ? -1 : 0;
  const maAbove20 = closes[last] > ma20;

  // 型態樣本：最後 windowSize 根
  const patternCandles = candles.slice(-windowSize);

  return {
    code:          fundamentals.code     ?? '',
    name:          fundamentals.name     ?? '',
    sector:        fundamentals.sector   ?? null,
    industry:      fundamentals.industry ?? null,
    candles:       patternCandles,
    rsi,
    kdK,
    macdSign,
    maAbove20,
  };
}

// ─── 模板合併（多支種子） ──────────────────────────────────
/**
 * @param {SeedFeature[]} features
 * @returns {MergedTemplate}
 */
export function mergeTemplates(features) {
  if (!features || features.length === 0) return null;

  const windowSize = features[0].candles.length;

  // ── 產業計數 ──
  const sectorCount   = new Map();
  const industryCount = new Map();
  for (const f of features) {
    if (f.sector)   sectorCount.set(f.sector,     (sectorCount.get(f.sector)   || 0) + 1);
    if (f.industry) industryCount.set(f.industry, (industryCount.get(f.industry) || 0) + 1);
  }
  const topSector   = _maxKey(sectorCount);
  const topIndustry = _maxKey(industryCount);

  // ── K 線正規化後求平均與標準差 ──
  const normalizedList = features.map(f => normalizeCandles(f.candles));
  const patternSeries  = new Array(windowSize).fill(0);
  const patternStd     = new Array(windowSize).fill(0);

  for (let i = 0; i < windowSize; i++) {
    const vals = normalizedList.map(s => s[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    patternSeries[i] = mean;
    if (vals.length > 1) {
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      patternStd[i] = Math.sqrt(variance);
    }
  }

  // ── 指標輪廓（中位數） ──
  const rsiVals  = features.map(f => f.rsi).sort((a, b) => a - b);
  const kdKVals  = features.map(f => f.kdK).sort((a, b) => a - b);
  const macdVote = features.filter(f => f.macdSign > 0).length > features.length / 2 ? 1
                 : features.filter(f => f.macdSign < 0).length > features.length / 2 ? -1 : 0;
  const maVote   = features.filter(f => f.maAbove20).length > features.length / 2;

  return {
    sectors:      sectorCount,
    topSector,
    topIndustry,
    patternSeries,
    patternStd,
    indProfile: {
      rsi:  { median: _median(rsiVals), q1: _quantile(rsiVals, 0.25), q3: _quantile(rsiVals, 0.75) },
      kdK:  { median: _median(kdKVals), q1: _quantile(kdKVals, 0.25), q3: _quantile(kdKVals, 0.75) },
      macdSign:  macdVote,
      maAbove20: maVote,
    },
    seedCount:  features.length,
    windowSize,
  };
}

// ─── 產業評分（0–100） ─────────────────────────────────────
/**
 * @param {object}         candidateFundamentals  - { sector, industry }
 * @param {MergedTemplate} template
 * @returns {number|null}  null = 無法評分（資料缺失）
 */
export function scoreSector(candidateFundamentals, template) {
  if (!template.topSector) return null;  // 種子無產業資料
  const cs = candidateFundamentals?.sector   ?? null;
  const ci = candidateFundamentals?.industry ?? null;
  if (!cs) return null;  // 候選股無產業資料

  if (cs === template.topSector && ci && ci === template.topIndustry) return 100;
  if (cs === template.topSector) return 60;
  return 0;
}

// ─── 線型評分（0–100） ─────────────────────────────────────
/**
 * @param {Candle[]}       candidateCandles  - 最近 windowSize 根
 * @param {MergedTemplate} template
 * @param {string}         featureMode       - 'simple' | 'multi'
 */
export function scorePattern(candidateCandles, template, featureMode = 'simple') {
  if (!candidateCandles || candidateCandles.length < template.windowSize) return 0;
  const recent = candidateCandles.slice(-template.windowSize);

  // 用 pattern.js 的 calcSimilarity，以合併後的平均序列作為範本
  // 把 patternSeries 包成 Candle 格式（close 欄位）供 normalizeCandles 使用
  const fakeTplCandles = template.patternSeries.map((v, i) => ({
    time: i, open: v, high: v, low: v, close: v, volume: 1,
  }));

  return calcSimilarity(fakeTplCandles, recent, featureMode);
}

// ─── 技術指標評分（0–100） ────────────────────────────────
/**
 * 依 RSI / KD-K / MACD方向 / MA排列 與模板輪廓的距離計算相似度
 */
export function scoreIndicators(candidateCandles, template) {
  if (!candidateCandles || candidateCandles.length < 30) return 50; // 資料不足給中等分

  const closes  = candidateCandles.map(c => c.close);
  const last    = candidateCandles.length - 1;

  const rsiArr  = calcRSI(closes, 14);
  const kdObj   = calcKD(candidateCandles, 9);
  const macdObj = calcMACD(closes, 12, 26, 9);
  const ma20Arr = calcMA(closes, 20);

  const rsi     = rsiArr[last]      ?? 50;
  const kdK     = kdObj.k[last]     ?? 50;
  const hist    = macdObj.hist[last] ?? 0;
  const ma20    = ma20Arr[last]     ?? closes[last];
  const macdSign  = hist > 0.001 ? 1 : hist < -0.001 ? -1 : 0;
  const maAbove20 = closes[last] > ma20;

  const { indProfile: p } = template;

  // RSI 距離（0–100 區間，以 IQR 為容差）
  const rsiIqr  = Math.max(p.rsi.q3 - p.rsi.q1, 10);
  const rsiDist = Math.abs(rsi - p.rsi.median) / rsiIqr;

  // KD-K 距離
  const kdIqr   = Math.max(p.kdK.q3 - p.kdK.q1, 10);
  const kdDist  = Math.abs(kdK - p.kdK.median) / kdIqr;

  // MACD 方向一致性（0 or 1）
  const macdMatch = macdSign === p.macdSign ? 1 : 0;

  // MA 排列一致性（0 or 1）
  const maMatch = maAbove20 === p.maAbove20 ? 1 : 0;

  // 各項轉換成 0–100 分（距離越小分越高）
  const rsiScore  = Math.max(0, 100 - rsiDist  * 50);
  const kdScore   = Math.max(0, 100 - kdDist   * 50);
  const macdScore = macdMatch * 100;
  const maScore   = maMatch   * 100;

  return Math.round((rsiScore * 0.3 + kdScore * 0.3 + macdScore * 0.2 + maScore * 0.2));
}

// ─── 綜合評分（加權合併） ──────────────────────────────────
/**
 * @param {number|null} sectorScore
 * @param {number}      patternScore
 * @param {number}      indicatorScore
 * @param {Weights}     weights         - { sector, pattern, indicator }（總和 = 1）
 * @returns {number}    0–100
 */
export function calcCompositeScore(sectorScore, patternScore, indicatorScore, weights) {
  // sectorScore = null 時，將其權重平分給 pattern 與 indicator
  if (sectorScore === null) {
    const total  = weights.pattern + weights.indicator;
    if (total === 0) return Math.round(patternScore);
    const wp = weights.pattern   / total;
    const wi = weights.indicator / total;
    return Math.round(patternScore * wp + indicatorScore * wi);
  }
  return Math.round(
    sectorScore    * weights.sector   +
    patternScore   * weights.pattern  +
    indicatorScore * weights.indicator
  );
}

// ─── 模板文字描述 ──────────────────────────────────────────
export function describeTemplate(template) {
  if (!template) return '';
  const lines = [];

  if (template.topSector)   lines.push(`主力產業：${template.topSector}`);
  if (template.topIndustry) lines.push(`細分產業：${template.topIndustry}`);

  const { rsi, kdK, macdSign, maAbove20 } = template.indProfile;
  lines.push(`RSI 中位數：${rsi.median.toFixed(0)}（${rsi.q1.toFixed(0)}–${rsi.q3.toFixed(0)}）`);
  lines.push(`KD-K 中位數：${kdK.median.toFixed(0)}（${kdK.q1.toFixed(0)}–${kdK.q3.toFixed(0)}）`);
  lines.push(`MACD 方向：${macdSign > 0 ? '多方' : macdSign < 0 ? '空方' : '中性'}`);
  lines.push(`均線排列：${maAbove20 ? '股價 > MA20（偏多）' : '股價 < MA20（偏空）'}`);
  lines.push(`種子數量：${template.seedCount} 檔`);

  return lines.join('\n');
}

// ─── 線型分歧警示 ─────────────────────────────────────────
export function templateDivergenceWarning(template) {
  if (!template) return null;
  const avgStd = template.patternStd.reduce((a, b) => a + b, 0) / template.patternStd.length;
  if (avgStd > 0.25) {
    return `種子線型分歧度偏高（${(avgStd * 100).toFixed(0)}%），比對結果可能不準確。建議改用 Phase 3 單一型態比對。`;
  }
  return null;
}

// ─── 私有工具 ─────────────────────────────────────────────
function _maxKey(map) {
  let maxK = null, maxV = 0;
  for (const [k, v] of map) { if (v > maxV) { maxV = v; maxK = k; } }
  return maxK;
}

function _median(sorted) {
  const n = sorted.length;
  if (n === 0) return 50;
  return n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
}

function _quantile(sorted, q) {
  if (sorted.length === 0) return 50;
  const pos = q * (sorted.length - 1);
  const lo  = Math.floor(pos);
  const hi  = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
