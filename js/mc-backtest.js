// js/mc-backtest.js
// ============================================================================
// 蒙地卡羅歷史回測 — 站在歷史每一天用 v1.6 公式預測,跟實際 K 線對答案
// ============================================================================
// 對外 API:
//   runMcBacktest(candles, opts) → 單檔回測 (個股全視窗按鈕用)
//   runMcBacktestMulti(items, onProgress, opts) → 多檔批次 (跨股測試按鈕用)
//
// 設計原則:
//   1. 用同一份五因子公式 (monte-carlo.js 的 computeForecastCenter)
//      → 回測結果跟使用者眼前看到的扇形中線一致
//   2. 每個 t 點切片 candles.slice(0, t),不偷看未來
//   3. 不跑路徑,只算中線 (解析解,快 500 倍)
//   4. sampleStep=1 (預設) 每天跑一次;sampleStep=5 改成每 5 天抽一次
//   5. patternDrift 預設關閉 (跑 230 次 findSimilarPatterns 太慢)
//      withPattern=true 啟用,搭配 sampleStep=5 把 230 次降到 46 次
// ============================================================================

import { computeForecastCenter } from './monte-carlo.js';

const HORIZONS  = [5, 10, 15, 20];     // 要驗證的根數
const MIN_HIST  = 60;                  // 切片最小歷史長度
const HIT_THRES = 0.05;                // 命中判定: |預測幅度 - 實際幅度| < 5%
const FORMULA   = 'v1.8-bt';           // v1.8: 四段公式分派 (Regime-Switching)

/**
 * 跑歷史回測 (單檔)
 * @param {Candle[]} candles 完整 K 線陣列 (至少 100 根才有意義)
 * @param {object} opts
 * @param {boolean} [opts.withPattern=false] 是否啟用 patternDrift (慢但更準確)
 * @param {number}  [opts.sampleStep=1] 取樣步長,5 表示每 5 天抽 1 個樣本
 * @param {boolean} [opts.collectDiag=false] 是否收集 v1.6.1 診斷統計 (個股 σ / RSI / drift 分布)
 * @returns {object} 回測結果
 */
export function runMcBacktest(candles, opts = {}) {
  const { withPattern = false, sampleStep = 1, collectDiag = false } = opts;

  if (!candles || candles.length < MIN_HIST + HORIZONS[HORIZONS.length - 1] + 5) {
    return {
      ok: false,
      reason: `K線不足,至少需要 ${MIN_HIST + HORIZONS[HORIZONS.length - 1] + 5} 根`,
    };
  }

  // 對每個 horizon 累積統計
  const stats = {};
  for (const N of HORIZONS) {
    stats[N] = {
      hit:    0,     // 命中數 (方向對 + 誤差<5%)
      dirHit: 0,     // 方向命中數
      total:  0,     // 總樣本數
      errSum: 0,     // 累積絕對誤差 (算 MAE 用)
      // 散佈圖原始資料 (預測幅度 vs 實際幅度,單位: 比例)
      scatter: [],
    };
  }

  const maxH = HORIZONS[HORIZONS.length - 1];

  // v1.6.1 診斷:每個樣本點的 diag 累積
  const diagSamples = collectDiag ? [] : null;

  // sampleStep=5 → 從 MIN_HIST 起跳,每 5 步取一個樣本點
  for (let t = MIN_HIST; t < candles.length - maxH; t += sampleStep) {
    // 切片: 只看 [0, t-1] 這段歷史 (假裝站在 t-1 收盤後)
    const sliced = candles.slice(0, t);
    const forecast = computeForecastCenter(sliced, maxH, { withPattern });
    if (!forecast) continue;

    const startPrice = forecast.startPrice;  // = candles[t-1].close

    // 收集診斷
    if (diagSamples && forecast.diag) {
      diagSamples.push(forecast.diag);
    }

    for (const N of HORIZONS) {
      const predPrice   = forecast.prices[N];
      const actualPrice = candles[t - 1 + N]?.close;
      if (predPrice == null || actualPrice == null) continue;

      const predChg   = (predPrice   - startPrice) / startPrice;
      const actualChg = (actualPrice - startPrice) / startPrice;

      // 方向命中: 預測方向 === 實際方向 (兩者同號;持平算對)
      const dirHit = (predChg >= 0) === (actualChg >= 0);

      // 完整命中: 方向對 + 誤差 < 5%
      const err = Math.abs(actualChg - predChg);
      const hit = dirHit && err < HIT_THRES;

      const s = stats[N];
      s.total++;
      if (dirHit) s.dirHit++;
      if (hit)    s.hit++;
      s.errSum += err;
      s.scatter.push({ predChg, actualChg, t });
    }
  }

  // 算最終比率
  const result = {
    ok:       true,
    formula:  FORMULA + (sampleStep > 1 ? `-s${sampleStep}` : '') + (withPattern ? '-p' : ''),
    samples:  stats[HORIZONS[0]].total,
    horizons: {},
    withPattern,
    sampleStep,
  };

  for (const N of HORIZONS) {
    const s = stats[N];
    if (s.total === 0) {
      result.horizons[N] = { total: 0 };
      continue;
    }
    result.horizons[N] = {
      total:   s.total,
      hit:     s.hit,
      hitRate: s.hit / s.total,        // 0~1
      dirHit:  s.dirHit,
      dirRate: s.dirHit / s.total,     // 0~1
      mae:     s.errSum / s.total,     // 平均絕對誤差 (比例)
      scatter: s.scatter,               // 散佈圖原始資料 (預留給未來 v2)
    };
  }

  // ─── v1.6.1 診斷彙整 ─────────────────────────────────────────────
  if (diagSamples && diagSamples.length > 0) {
    result.diag = _summarizeDiag(diagSamples);
  }

  return result;
}

// 把所有樣本點的 diag 彙總成統計摘要
function _summarizeDiag(samples) {
  const n = samples.length;
  if (n === 0) return null;

  // 取陣列中位數 / p25 / p75 的工具
  const _percentiles = (arr, ps) => {
    const sorted = [...arr].filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
    if (!sorted.length) return ps.map(() => null);
    return ps.map(p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
  };
  const _meanAbs = (arr) => {
    const filtered = arr.filter(v => v != null && !Number.isNaN(v));
    if (!filtered.length) return 0;
    return filtered.reduce((s, v) => s + Math.abs(v), 0) / filtered.length;
  };

  // σ 分布
  const sigmas = samples.map(d => d.stdDev_raw);
  const [sigP25, sigMed, sigP75] = _percentiles(sigmas, [0.25, 0.5, 0.75]);

  // RSI 分布 + 過熱/超賣比例
  const rsis = samples.map(d => d.rsi).filter(v => v != null);
  const [rsiP25, rsiMed, rsiP75] = _percentiles(rsis, [0.25, 0.5, 0.75]);
  const rsiHotPct  = rsis.length ? rsis.filter(r => r > 75).length / rsis.length : 0;
  const rsiColdPct = rsis.length ? rsis.filter(r => r < 25).length / rsis.length : 0;

  // drift clip 比例
  const clipPct = samples.filter(d => d.clipped).length / n;

  // 各因子平均「絕對」貢獻 (越大代表該因子主導力越強)
  const contribAbs = {
    recentMean:   _meanAbs(samples.map(d => d.contrib?.recentMean)),
    mean:         _meanAbs(samples.map(d => d.contrib?.mean)),
    volDrift:     _meanAbs(samples.map(d => d.contrib?.volDrift)),
    patternDrift: _meanAbs(samples.map(d => d.contrib?.patternDrift)),
  };
  const contribSum = contribAbs.recentMean + contribAbs.mean + contribAbs.volDrift + contribAbs.patternDrift;
  // 主導因子佔比 (各因子貢獻 / 總貢獻)
  const contribPct = contribSum > 0 ? {
    recentMean:   contribAbs.recentMean   / contribSum,
    mean:         contribAbs.mean         / contribSum,
    volDrift:     contribAbs.volDrift     / contribSum,
    patternDrift: contribAbs.patternDrift / contribSum,
  } : null;

  return {
    samples: n,
    sigma:   { p25: sigP25, median: sigMed, p75: sigP75 },
    rsi:     { p25: rsiP25, median: rsiMed, p75: rsiP75, hotPct: rsiHotPct, coldPct: rsiColdPct },
    clipPct,
    contribAbs,
    contribPct,
    // ─── v1.8: regime 分布(該股 230 個 t 點各被分到哪個公式) ──
    regimeCount: _countRegimes(samples),
    regimeMain:  _findMainRegime(samples),
  };
}

// 算每個 regime 在所有樣本點中出現幾次
function _countRegimes(samples) {
  const counts = { superlow: 0, low: 0, mid: 0, high: 0, unknown: 0 };
  for (const s of samples) {
    const r = s.regime || 'unknown';
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

// 找該股主要被哪個 regime 公式驅動 (>50% 就明顯,40-50% 算「偏」)
function _findMainRegime(samples) {
  const counts = _countRegimes(samples);
  const total  = samples.length;
  if (total === 0) return { name: null, pct: 0 };
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topName, topCount] = sorted[0];
  return { name: topName, pct: topCount / total };
}

// ============================================================================
// 跨股批次回測
// ============================================================================
// 預設 20 檔測試樣本 — v2.8 擴充版
// 涵蓋：大型多頭 / 高beta / 牛皮 / 妖股（多種類型）/ 傳產 / 下行 / 循環
// 妖股類型特別加強：爆量啟動型 / 慢牛爆發型 / 低基期型
const DEFAULT_BASKET = [
  // ── 大型權值股（基準對照）──
  { code: '2330', name: '台積電',   type: '大型多頭' },
  { code: '2317', name: '鴻海',     type: '大型多頭' },
  { code: '2454', name: '聯發科',   type: '高 beta' },
  { code: '2412', name: '中華電',   type: '牛皮股' },
  // ── 傳產 / 循環股 ──
  { code: '1101', name: '台泥',     type: '傳產整理' },
  { code: '2603', name: '長榮',     type: '循環股' },
  { code: '3034', name: '聯詠',     type: '下行' },
  // ── 已驗證飆股（歷史高報酬）──
  { code: '8021', name: '尖點',     type: 'PCB飆股 +483%' },
  { code: '2408', name: '南亞科',   type: 'DRAM飆股 +559%' },
  { code: '3035', name: '智原',     type: '妖股（AI概念）' },
  // ── 2026年妖股實戰樣本（X2天黑請閉眼實證標的）──
  { code: '3021', name: '鴻名',     type: '妖股（爆量啟動型）X2實證' },
  { code: '6570', name: '維田',     type: '妖股（低基期爆發型）X2實證' },
  { code: '6432', name: '今展科',   type: '妖股（主升段持續型）X2實證' },
  { code: '2377', name: '微星',     type: '妖股（慢牛爆發型）X2無X1' },
  { code: '2302', name: '麗正',     type: '妖股（低基期爆量型）X5候選' },
  // ── 其他強勢股（增加樣本多樣性）──
  { code: '2376', name: '技嘉',     type: '高beta AI概念' },
  { code: '3711', name: '日月光投控', type: '半導體封測' },
  { code: '2357', name: '華碩',     type: '電腦品牌' },
  { code: '4938', name: '和碩',     type: '代工大型' },
  { code: '6415', name: '矽力-KY',  type: '類比IC飆股' },
];

export function getDefaultBacktestBasket() {
  return DEFAULT_BASKET.map(s => ({ ...s }));   // 防止外部 mutation
}

/**
 * 跑多檔批次回測 (跨股測試)
 * 序列跑,每跑完一檔呼叫 onProgress 讓 UI 更新
 *
 * @param {Array<{code, name, type, candles}>} items 已備好 candles 的個股清單
 *   - 呼叫端負責 fetchHistory(),這裡只做計算
 * @param {function} onProgress (done, total, current, partial) — 進度回呼
 *   - done: 已跑完的檔數
 *   - total: 總檔數
 *   - current: 當前股票物件
 *   - partial: 累積的結果陣列 (含目前已跑完的)
 * @param {object} opts 同 runMcBacktest 的 opts
 * @param {AbortSignal} [opts.signal] 可取消
 * @returns {Promise<{ok, results, aborted}>}
 */
export async function runMcBacktestMulti(items, onProgress, opts = {}) {
  const { withPattern = true, sampleStep = 5, signal = null } = opts;
  const results = [];
  let aborted = false;

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) { aborted = true; break; }

    const item = items[i];
    const { code, name, type, candles } = item;

    let result;
    if (!candles || candles.length < MIN_HIST + 20 + 5) {
      result = { code, name, type, ok: false, reason: 'K線不足' };
    } else {
      try {
        const bt = runMcBacktest(candles, { withPattern, sampleStep, collectDiag: true });
        result = { code, name, type, ...bt };
      } catch (err) {
        result = { code, name, type, ok: false, reason: err.message || 'unknown' };
      }
    }

    results.push(result);

    // yield 一個 frame,讓 UI 渲染進度
    try { await onProgress?.(i + 1, items.length, item, results); } catch {}
    await new Promise(r => setTimeout(r, 0));  // 釋放主執行緒
  }

  return { ok: true, results, aborted, formula: FORMULA + `-s${sampleStep}` + (withPattern ? '-p' : '') };
}

