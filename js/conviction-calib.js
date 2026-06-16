/**
 * conviction-calib.js — Advanced 8 CV-P2 校正引擎
 *
 * 用全市場歷史 K 線跑格點掃描，為 conviction.js 的自由參數找最優值。
 *
 * 評判標準（ROADMAP §4.2 鐵則，開跑前寫死，不准事後搬門柱）：
 *   ① 十分位曲線單調性 Spearman ≥ 0.8（C 高組未來報酬單調高於 C 低組）
 *   ② OOS 日 IC 均值 > 0.03 且 t 值 > 2
 *   ③ 敏感度平緩：某參數差一格結果天壤之別 = 過擬合源，取穩健次優
 *
 * 時間三切（防校正本身過擬合）：
 *   訓練段（調參）／驗證段（選參）／封存段（最終審判，只准開封一次）
 *
 * 用法（本機 node，需餵真實全市場 K 線）：
 *   import { calibrate } from './conviction-calib.js';
 *   const result = calibrate(klineMap, { fwdDays: 20 });
 *   // klineMap: { code: [{open,high,low,close,volume}, ...] }
 *
 * 結果寫 CONVICTION_CALIB_MMDD.md，最優參數凍結進 conviction.js。
 */

import { computeConviction, CONV_PARAMS } from './conviction.js';

// ── 時間三切比例（依資料長度切）─────────────────────────────────────────────
const SPLIT = { train: 0.5, valid: 0.25, archive: 0.25 };

// 評判標準（寫死，不准改）
const JUDGE = {
  SPEARMAN_MIN: 0.8,   // 十分位單調性下界
  IC_MEAN_MIN:  0.03,  // OOS 日 IC 均值下界
  IC_T_MIN:     2.0,   // IC t 值下界
};

// ── 統計工具 ────────────────────────────────────────────────────────────────

// Spearman 等級相關（用於 IC：C 排名 vs 未來報酬排名）
function _spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length; i++) {
      // 處理並列：取平均排名
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mx) * (ry[i] - my);
    vx += (rx[i] - mx) ** 2;
    vy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(vx * vy);
  return den === 0 ? 0 : cov / den;
}

// 平均值 / 標準差
function _mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _std(a) {
  if (a.length < 2) return 0;
  const m = _mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}

/**
 * 計算單一參數組在指定時間段的審判指標
 * @param klineMap { code: bars[] }
 * @param params 覆寫 CONV_PARAMS
 * @param fwdDays 前瞻報酬期（5/10/20）
 * @param segFrom, segTo 時間段比例 [0,1]（時間三切用）
 * @returns { icMean, icStd, icT, icDays, spearmanDecile, decileRets }
 */
export function judge(klineMap, params, fwdDays, segFrom = 0, segTo = 1) {
  // 蒐集每日橫斷面：{ date: [{c, fwdRet}] }
  const byDate = new Map();

  for (const code of Object.keys(klineMap)) {
    const bars = klineMap[code];
    if (!bars || bars.length < 90) continue;
    const res = computeConviction(bars, params);
    const C = res.C;
    const n = bars.length;
    // 時間段切片（用 index 比例）
    const iStart = Math.floor(n * segFrom);
    const iEnd = Math.floor(n * segTo);
    for (let i = iStart; i < iEnd; i++) {
      if (C[i] == null) continue;
      const fwdIdx = i + fwdDays;
      if (fwdIdx >= n) continue;
      const c0 = bars[i].close, c1 = bars[fwdIdx].close;
      if (!(c0 > 0) || !(c1 > 0)) continue;
      const fwdRet = (c1 / c0 - 1) * 100;
      const date = bars[i].time;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ c: C[i], fwdRet });
    }
  }

  // 每日 IC（橫斷面 C vs fwdRet 的 Spearman），至少 20 檔才算
  const dailyIC = [];
  for (const [, arr] of byDate) {
    if (arr.length < 20) continue;
    const ic = _spearman(arr.map(x => x.c), arr.map(x => x.fwdRet));
    if (ic != null) dailyIC.push(ic);
  }
  const icMean = _mean(dailyIC);
  const icStd = _std(dailyIC);
  const icT = icStd > 0 ? icMean / (icStd / Math.sqrt(dailyIC.length)) : 0;

  // 十分位：全段 pooled，按 C 分 10 組，看各組平均 fwdRet 是否單調
  const pooled = [];
  for (const [, arr] of byDate) for (const x of arr) pooled.push(x);
  pooled.sort((a, b) => a.c - b.c);
  const decileRets = [];
  const dN = Math.floor(pooled.length / 10);
  if (dN >= 5) {
    for (let d = 0; d < 10; d++) {
      const slice = pooled.slice(d * dN, (d + 1) * dN);
      decileRets.push(+_mean(slice.map(x => x.fwdRet)).toFixed(3));
    }
  }
  // 十分位單調性：組序號(1-10) vs 組報酬 的 Spearman
  const spearmanDecile = decileRets.length === 10
    ? _spearman([1,2,3,4,5,6,7,8,9,10], decileRets)
    : null;

  return {
    icMean: +icMean.toFixed(4),
    icStd: +icStd.toFixed(4),
    icT: +icT.toFixed(2),
    icDays: dailyIC.length,
    spearmanDecile: spearmanDecile != null ? +spearmanDecile.toFixed(3) : null,
    decileRets,
    pass: (spearmanDecile != null && spearmanDecile >= JUDGE.SPEARMAN_MIN
           && icMean > JUDGE.IC_MEAN_MIN && icT > JUDGE.IC_T_MIN),
  };
}

/**
 * 格點掃描：對一組候選參數逐一在訓練段審判，回傳排序結果
 * @param klineMap
 * @param grid [{ name, params }] 候選參數組
 * @param fwdDays
 * @param seg 'train'|'valid'|'archive'
 */
export function gridScan(klineMap, grid, fwdDays = 20, seg = 'train') {
  const segRange = {
    train:   [0, SPLIT.train],
    valid:   [SPLIT.train, SPLIT.train + SPLIT.valid],
    archive: [SPLIT.train + SPLIT.valid, 1],
  }[seg];

  const results = [];
  for (const cand of grid) {
    const j = judge(klineMap, cand.params, fwdDays, segRange[0], segRange[1]);
    results.push({ name: cand.name, params: cand.params, ...j });
  }
  // 依 IC 均值排序（主要指標）
  results.sort((a, b) => b.icMean - a.icMean);
  return results;
}

/**
 * 權重專用快速掃描（z 分數只算一次，91 組權重只做輕量合成）
 *
 * 權重只影響「W_MOM·zMom + W_OBV·zObv + W_WIN·zWin」這一步，
 * 前面的 z 分數、Guard、未來報酬每組權重都相同 → 預算快取，避免重算 91 次。
 * 把階段3 從幾十分鐘降到幾秒。
 *
 * @param klineMap
 * @param weightGrid [{ name, params:{W_MOM,W_OBV,W_WIN} }]
 * @param fwdDays
 * @param seg
 * @param baseParams 其餘參數（z窗/EMA/Guard/κ 等，沿用已選定值）
 */
export function gridScanWeights(klineMap, weightGrid, fwdDays = 20, seg = 'train', baseParams = {}) {
  const segRange = {
    train:   [0, SPLIT.train],
    valid:   [SPLIT.train, SPLIT.train + SPLIT.valid],
    archive: [SPLIT.train + SPLIT.valid, 1],
  }[seg];
  const P = { ...CONV_PARAMS, ...baseParams };
  const emaK = 2 / (P.EMA_SPAN + 1);

  // ── 預算階段：每檔的 z 分數、guard、未來報酬，全部算一次快取 ──────────────
  const cache = [];   // [{ zm, zo, zw, guard, fwdRet[], dates[], iStart, iEnd, n }]
  for (const code of Object.keys(klineMap)) {
    const bars = klineMap[code];
    if (!bars || bars.length < 90) continue;
    const res = computeConviction(bars, baseParams);   // 算一次取 components + guard
    const { zMom, zObv, zWin } = res.components;
    const guard = res.guard;
    const n = bars.length;
    const iStart = Math.floor(n * segRange[0]);
    const iEnd = Math.floor(n * segRange[1]);
    // 預算未來報酬
    const fwdRet = new Array(n).fill(null);
    const dates = new Array(n).fill(null);
    for (let i = iStart; i < iEnd; i++) {
      const fi = i + fwdDays;
      if (fi >= n) break;
      const c0 = bars[i].close, c1 = bars[fi].close;
      if (c0 > 0 && c1 > 0) { fwdRet[i] = (c1 / c0 - 1) * 100; dates[i] = bars[i].time; }
    }
    cache.push({ zMom, zObv, zWin, guard, fwdRet, dates, iStart, iEnd, n });
  }

  // ── 掃描階段：每組權重只做輕量合成 → IC ──────────────────────────────────
  const results = [];
  for (const cand of weightGrid) {
    const { W_MOM, W_OBV, W_WIN } = cand.params;
    const byDate = new Map();
    const pooled = [];

    for (const ck of cache) {
      const { zMom, zObv, zWin, guard, fwdRet, dates, iStart, iEnd, n } = ck;
      // 用此權重重建 C（合成→EMA→Guard），只在需要的 index 範圍
      // EMA 需要從頭累積，所以從 0 跑到 iEnd
      let e = null;
      const C = new Array(n).fill(null);
      for (let i = 0; i < iEnd; i++) {
        if (zMom[i] === null || zObv[i] === null || zWin[i] === null) { continue; }
        const rawV = W_MOM * zMom[i] + W_OBV * zObv[i] + W_WIN * zWin[i];
        e = (e === null) ? rawV : rawV * emaK + e * (1 - emaK);
        C[i] = e * guard[i] - (1 - guard[i]) * P.KAPPA;
      }
      // 收集 segment 範圍的 (C, fwdRet)
      for (let i = iStart; i < iEnd; i++) {
        if (C[i] === null || fwdRet[i] === null) continue;
        const rec = { c: C[i], fwdRet: fwdRet[i] };
        pooled.push(rec);
        const d = dates[i];
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(rec);
      }
    }

    // 每日 IC
    const dailyIC = [];
    for (const [, arr] of byDate) {
      if (arr.length < 20) continue;
      const ic = _spearman(arr.map(x => x.c), arr.map(x => x.fwdRet));
      if (ic != null) dailyIC.push(ic);
    }
    const icMean = _mean(dailyIC);
    const icStd = _std(dailyIC);
    const icT = icStd > 0 ? icMean / (icStd / Math.sqrt(dailyIC.length)) : 0;

    // 十分位
    pooled.sort((a, b) => a.c - b.c);
    const decileRets = [];
    const dN = Math.floor(pooled.length / 10);
    if (dN >= 5) {
      for (let d = 0; d < 10; d++) {
        const slice = pooled.slice(d * dN, (d + 1) * dN);
        decileRets.push(+_mean(slice.map(x => x.fwdRet)).toFixed(3));
      }
    }
    const spearmanDecile = decileRets.length === 10
      ? _spearman([1,2,3,4,5,6,7,8,9,10], decileRets) : null;

    results.push({
      name: cand.name, params: cand.params,
      icMean: +icMean.toFixed(4), icStd: +icStd.toFixed(4), icT: +icT.toFixed(2),
      icDays: dailyIC.length,
      spearmanDecile: spearmanDecile != null ? +spearmanDecile.toFixed(3) : null,
      decileRets,
      pass: (spearmanDecile != null && spearmanDecile >= JUDGE.SPEARMAN_MIN
             && icMean > JUDGE.IC_MEAN_MIN && icT > JUDGE.IC_T_MIN),
    });
  }
  results.sort((a, b) => b.icMean - a.icMean);
  return results;
}

/**
 * 產生 P1 權重格點（單純形，步長 0.05，三權重和=1）
 */
export function genWeightGrid(step = 0.05) {
  const grid = [];
  for (let m = 0.1; m <= 0.8; m += step) {
    for (let o = 0.1; o <= 0.8 - m + 1e-9; o += step) {
      const w = +(1 - m - o).toFixed(4);
      if (w < 0.1 || w > 0.8) continue;
      grid.push({
        name: `w(${m.toFixed(2)}/${o.toFixed(2)}/${w.toFixed(2)})`,
        params: { W_MOM: +m.toFixed(4), W_OBV: +o.toFixed(4), W_WIN: w },
      });
    }
  }
  return grid;
}

/**
 * 單參數掃描格點（P2~P5 等單維參數）
 */
export function genSingleParamGrid(paramName, values) {
  return values.map(v => ({
    name: `${paramName}=${v}`,
    params: { [paramName]: v },
  }));
}

/**
 * 敏感度檢查：格點結果的 IC 是否平緩（相鄰格差異 < 閾值）
 * 回傳 { smooth: bool, maxJump, worst }
 */
export function sensitivityCheck(scanResults, jumpThreshold = 0.015) {
  if (scanResults.length < 2) return { smooth: true, maxJump: 0, worst: null };
  // 依 IC 排序後看相鄰差
  const ics = scanResults.map(r => r.icMean);
  let maxJump = 0, worst = null;
  for (let i = 1; i < ics.length; i++) {
    const jump = Math.abs(ics[i] - ics[i - 1]);
    if (jump > maxJump) { maxJump = jump; worst = [scanResults[i - 1].name, scanResults[i].name]; }
  }
  return { smooth: maxJump < jumpThreshold, maxJump: +maxJump.toFixed(4), worst };
}

export { JUDGE, SPLIT };
