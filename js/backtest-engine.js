/**
 * backtest-engine.js — 組合回測引擎
 *
 * 設計：
 *   1. 向量化指標：每檔股票的 RSI/MA/均量/KD/MACD 整段算一次 O(n)，
 *      逐日訊號判定變 O(1) 查表（比逐日呼叫 matchSignals 快 ~100 倍）
 *   2. 條件庫對齊 strategy.js 的 condId 語意（支援 X 系列全部條件）
 *   3. 組合回放：逐日推進，先出場後進場，T+1 開盤價成交（避免未來函數）
 *   4. 報酬用還原價 a 計算（含息），市值/股數全部以 a 為基準
 *
 * export：
 *   runBacktest(opts) → { equity, trades, dailyReturns, config }
 *     opts: {
 *       histMap:      Map<code, {candles:[{t,o,h,l,c,a,v}]}>   ← api-hist.js fetchHistAll
 *       entryIds:     ['X1']                进场訊號（任一觸發即進場）
 *       exitMode:     'days' | 'signal_gone'
 *       exitDays:     20                    exitMode='days' 時的持有天數
 *       capital:      1_000_000
 *       maxPositions: 10
 *       feeRate:      0.001425             買賣手續費
 *       taxRate:      0.003                賣出證交稅
 *       startTs:      可選，回測起始 unix ts（預設資料最早+60 根暖機）
 *       onProgress:   (done, total) => {}
 *     }
 *
 *   SUPPORTED_CONDS — 引擎已實作的 condId 清單（UI 用來判斷哪些策略可回測）
 *   isStrategyBacktestable(strategy) — 該策略的條件是否全部支援
 */

import { STRATEGIES } from './strategy.js';

// ─────────────────────────────────────────────────────────────────────────────
// 指標向量化（整段一次算完）
// ─────────────────────────────────────────────────────────────────────────────
function _sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function _rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const gain = Math.max(chg, 0), loss = Math.max(-chg, 0);
    if (i <= n) {
      avgGain += gain / n; avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function _kd(candles, n = 9, kS = 3, dS = 3) {
  const len = candles.length;
  const K = new Array(len).fill(null), D = new Array(len).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < len; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (candles[j].h > hh) hh = candles[j].h;
      if (candles[j].l < ll) ll = candles[j].l;
    }
    const rsv = hh === ll ? 50 : (candles[i].c - ll) / (hh - ll) * 100;
    k = (k * (kS - 1) + rsv) / kS;
    d = (d * (dS - 1) + k) / dS;
    K[i] = k; D[i] = d;
  }
  return { K, D };
}

function _macd(closes, fast = 12, slow = 26, sig = 9) {
  const len = closes.length;
  const dif = new Array(len).fill(null), dea = new Array(len).fill(null), hist = new Array(len).fill(null);
  let emaF = closes[0], emaS = closes[0], emaD = 0;
  const aF = 2 / (fast + 1), aS = 2 / (slow + 1), aD = 2 / (sig + 1);
  for (let i = 0; i < len; i++) {
    emaF = i === 0 ? closes[0] : closes[i] * aF + emaF * (1 - aF);
    emaS = i === 0 ? closes[0] : closes[i] * aS + emaS * (1 - aS);
    const d = emaF - emaS;
    dif[i] = d;
    emaD = i === 0 ? d : d * aD + emaD * (1 - aD);
    dea[i] = emaD;
    hist[i] = d - emaD;
  }
  return { dif, dea, hist };
}

// Supertrend(period,mult) 方向序列（'up'/'down'）— 出場規則用，slim 欄位 .h/.l/.c
function _supertrend(candles, period = 10, mult = 3) {
  const n = candles.length;
  const dir = new Array(n).fill(null);
  if (n < period + 2) return dir;
  const tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0) { tr[i] = candles[i].h - candles[i].l; continue; }
    const pc = candles[i - 1].c;
    tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  const atr = new Array(n).fill(null);
  let s = 0; for (let i = 0; i < period; i++) s += tr[i];
  atr[period - 1] = s / period;
  for (let i = period; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  let fU = null, fL = null, pdir = null;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const bU = hl2 + mult * atr[i], bL = hl2 - mult * atr[i];
    const pc = candles[i - 1]?.c ?? candles[i].c;
    fU = (fU == null || bU < fU || pc > fU) ? bU : fU;
    fL = (fL == null || bL > fL || pc < fL) ? bL : fL;
    if (pdir == null) pdir = candles[i].c >= hl2 ? 'up' : 'down';
    else if (pdir === 'up') pdir = candles[i].c < fL ? 'down' : 'up';
    else pdir = candles[i].c > fU ? 'up' : 'down';
    dir[i] = pdir;
  }
  return dir;
}

// 週線多頭 + Weinstein 階段（日線對齊布林/數字陣列）— 進場條件用
// 週線 resample 一次（週一起算），週MA10 判多頭、週MA30 判階段；映射回日線用「前一完成週」狀態（因果、不看未來）
function _weeklyArrays(candles) {
  const n = candles.length;
  const weeklyBull = new Array(n).fill(false);
  const stage = new Array(n).fill(0);
  if (n < 60) return { weeklyBull, stage };
  const weeks = [];
  let cur = null, curKey = null;
  for (let i = 0; i < n; i++) {
    const d = new Date((candles[i].t || 0) * 1000);
    const dow = d.getUTCDay();                          // 0=Sun..6=Sat
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
    const key = mon.toISOString().slice(0, 10);
    if (key !== curKey) { if (cur) weeks.push(cur); cur = { s: i, e: i, c: candles[i].c }; curKey = key; }
    else { cur.e = i; cur.c = candles[i].c; }
  }
  if (cur) weeks.push(cur);
  const wClose = weeks.map(w => w.c);
  const wMA10 = _sma(wClose, 10);
  const wMA30 = _sma(wClose, 30);
  const wBull = weeks.map((w, k) => k >= 10 && wMA10[k] != null && wMA10[k - 1] != null && w.c > wMA10[k] && wMA10[k] > wMA10[k - 1]);
  const wStage = weeks.map((w, k) => {
    if (k < 31 || wMA30[k] == null || wMA30[k - 1] == null || wMA30[k - 1] === 0) return 0;
    const slope = (wMA30[k] - wMA30[k - 1]) / wMA30[k - 1];
    const FLAT = 0.003;                                 // 0.3%/週 視為盤整
    if (slope > FLAT)  return 2;                        // 上升期（可買）
    if (slope < -FLAT) return 4;                        // 下降期
    return w.c > wMA30[k] ? 3 : 1;                      // 盤整：價在軸線上=頭部(3)、下=底部(1)
  });
  for (let wi = 0; wi < weeks.length; wi++) {
    const w = weeks[wi];
    const pb = wi >= 1 ? wBull[wi - 1] : false;         // 用「前一完成週」狀態，避免用到當週未完成資料
    const ps = wi >= 1 ? wStage[wi - 1] : 0;
    for (let i = w.s; i <= w.e; i++) { weeklyBull[i] = pb; stage[i] = ps; }
  }
  return { weeklyBull, stage };
}

// 站上 POC（近 lookback 日量價分佈最密集價，依收盤分箱）— 進場條件用
function _pocAboveArr(candles, lookback = 120, bins = 40) {
  const n = candles.length;
  const out = new Array(n).fill(false);
  const hist = new Array(bins);
  for (let i = 20; i < n; i++) {
    const start = Math.max(0, i - lookback + 1);
    let lo = Infinity, hi = -Infinity;
    for (let j = start; j <= i; j++) { const c = candles[j].c; if (c < lo) lo = c; if (c > hi) hi = c; }
    if (hi <= lo) continue;
    const w = (hi - lo) / bins;
    hist.fill(0);
    for (let j = start; j <= i; j++) {
      let b = Math.floor((candles[j].c - lo) / w); if (b >= bins) b = bins - 1; if (b < 0) b = 0;
      hist[b] += candles[j].v ?? 0;
    }
    let pocBin = 0, pocVol = -1;
    for (let b = 0; b < bins; b++) if (hist[b] > pocVol) { pocVol = hist[b]; pocBin = b; }
    out[i] = candles[i].c > lo + (pocBin + 0.5) * w;
  }
  return out;
}
function _precompute(candles) {
  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v ?? 0);
  const ma5    = _sma(closes, 5);
  const ma20   = _sma(closes, 20);
  const volMa10 = _sma(vols, 10);
  const volMa20 = _sma(vols, 20);
  const volMa30 = _sma(vols, 30);
  const rsi    = _rsi(closes, 14);
  const { K, D } = _kd(candles);
  const macd   = _macd(closes);
  const stDir  = _supertrend(candles, 10, 3);   // Supertrend 出場/進場用
  const { weeklyBull, stage } = _weeklyArrays(candles);   // 週線多頭 / Weinstein 階段
  const pocAbove = _pocAboveArr(candles, 120, 40);        // 站上 POC
  return { closes, vols, ma5, ma20, volMa10, volMa20, volMa30, rsi, K, D, macd, stDir, weeklyBull, stage, pocAbove };
}

// ─────────────────────────────────────────────────────────────────────────────
// 條件庫（condId → (ind, i, val) => bool）對齊 strategy.js 語意
//   ind = _precompute 結果，i = 當日 index，val = 條件參數
// ─────────────────────────────────────────────────────────────────────────────
const COND_LIB = {
  rsi_min:    (ind, i, v) => ind.rsi[i] != null && ind.rsi[i] >= v,
  rsi_max:    (ind, i, v) => ind.rsi[i] != null && ind.rsi[i] <= v,
  above_ma20: (ind, i)    => ind.ma20[i] != null && ind.closes[i] > ind.ma20[i],
  ma20_rising:(ind, i, v) => {
    const n = v ?? 3;
    if (i < n || ind.ma20[i - n] == null) return false;
    for (let k = 0; k < n; k++) if (!(ind.ma20[i - k] > ind.ma20[i - k - 1])) return false;
    return true;
  },
  vol_surge_short: (ind, i, v) => ind.volMa10[i - 1] != null && ind.volMa10[i - 1] > 0 && ind.vols[i] >= ind.volMa10[i - 1] * v,
  vol_surge_long:  (ind, i, v) => ind.volMa30[i - 1] != null && ind.volMa30[i - 1] > 0 && ind.vols[i] >= ind.volMa30[i - 1] * v,
  vol_surge:       (ind, i, v) => ind.volMa20[i - 1] != null && ind.volMa20[i - 1] > 0 && ind.vols[i] >= ind.volMa20[i - 1] * v,
  vol_shrink:      (ind, i, v) => ind.volMa20[i - 1] != null && ind.volMa20[i - 1] > 0 && ind.vols[i] <= ind.volMa20[i - 1] * v,
  gain_10d:   (ind, i, v) => i >= 10 && ind.closes[i - 10] > 0 && (ind.closes[i] / ind.closes[i - 10] - 1) * 100 >= v,
  loss_5d:    (ind, i, v) => i >= 5  && ind.closes[i - 5] > 0 && (1 - ind.closes[i] / ind.closes[i - 5]) * 100 >= v,
  drop_n_days:(ind, i, v) => i >= 3  && ind.closes[i - 3] > 0 && (ind.closes[i] / ind.closes[i - 3] - 1) * 100 <= v,
  kd_golden:  (ind, i)    => i >= 1 && ind.K[i] != null && ind.K[i - 1] != null && ind.K[i - 1] <= ind.D[i - 1] && ind.K[i] > ind.D[i],
  kd_k_min:   (ind, i, v) => ind.K[i] != null && ind.K[i] >= v,
  kd_k_max:   (ind, i, v) => ind.K[i] != null && ind.K[i] <= v,
  macd_golden:(ind, i)    => i >= 1 && ind.macd.dif[i - 1] <= ind.macd.dea[i - 1] && ind.macd.dif[i] > ind.macd.dea[i],
  macd_hist_pos: (ind, i) => ind.macd.hist[i] > 0,
  ma5_cross_ma20:(ind, i) => i >= 1 && ind.ma5[i - 1] != null && ind.ma20[i - 1] != null && ind.ma5[i - 1] <= ind.ma20[i - 1] && ind.ma5[i] > ind.ma20[i],
  high_n_days:(ind, i, v) => {
    if (i < v) return false;
    for (let k = 1; k <= v; k++) if (ind.closes[i - k] >= ind.closes[i]) return false;
    return true;
  },
  chg_min:    (ind, i, v) => i >= 1 && ind.closes[i - 1] > 0 && (ind.closes[i] / ind.closes[i - 1] - 1) * 100 >= v,
  vol_min:    (ind, i, v) => ind.vols[i] / 1000 >= v,   // strategy.js 的 vol_min 單位是「張」
  rsi_revival:(ind, i, v) => {
    if (ind.rsi[i] == null || ind.rsi[i] < v) return false;
    for (let k = 1; k <= 5; k++) { if (i - k < 0) return false; if (ind.rsi[i - k] != null && ind.rsi[i - k] < 30) return true; }
    return false;
  },
  tight_consolidation: (ind, i, v) => {
    if (i < 6 || ind.volMa10[i - 1] == null) return false;
    let hh = -Infinity, ll = Infinity;
    for (let k = 1; k <= 5; k++) { hh = Math.max(hh, ind.closes[i - k]); ll = Math.min(ll, ind.closes[i - k]); }
    const rangePct = ll > 0 ? (hh - ll) / ll * 100 : 999;
    const breakout = ind.closes[i] > hh && ind.vols[i] >= ind.volMa10[i - 1] * 1.5;
    return rangePct < v && breakout;
  },
  // ── 進階指標進場條件（搭配 TA_ENTRY_STRATEGIES）
  weekly_bull:     (ind, i)    => ind.weeklyBull?.[i] === true,
  weinstein_stage: (ind, i, v) => ind.stage?.[i] === (v ?? 2),
  above_poc:       (ind, i)    => ind.pocAbove?.[i] === true,
  supertrend_up:   (ind, i)    => ind.stDir?.[i] === 'up',
};

export const SUPPORTED_CONDS = Object.keys(COND_LIB);

// ═════════════════════════════════════════════════════════════════════════════
// GAS 對齊條件庫（2026-06-10，系統發現策略 2Y 回測用）
//   condId 用 'gas:' 前綴，固定門檻 boolean，語意照 heatmap_calc.gs _calcConditions
//   與上方 COND_LIB（strategy.js 參數化語意）並存，互不干擾
// ═════════════════════════════════════════════════════════════════════════════

function _ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = i >= n - 1 ? prev : null;
  }
  return out;
}

function _gasPre(candles, base) {
  const n = candles.length;
  const closes = base.closes;
  const highs = candles.map(c => c.h ?? c.c);
  const lows  = candles.map(c => c.l ?? c.c);
  const opens = candles.map(c => c.o ?? c.c);
  const vols  = base.vols;

  const ema5 = _ema(closes, 5), ema10 = _ema(closes, 10), ema20 = _ema(closes, 20), ema60 = _ema(closes, 60);

  // GMMA（標準參數）
  const gS = [3,5,8,10,12,15].map(p => _ema(closes, p));
  const gL = [30,35,40,45,50,60].map(p => _ema(closes, p));

  // DMI(14) Wilder
  const pdi = new Array(n).fill(null), mdi = new Array(n).fill(null), adx = new Array(n).fill(null);
  {
    const P = 14;
    let sTR = 0, sDP = 0, sDM = 0, adxSum = 0, adxCnt = 0, prevAdx = null;
    const dxArr = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
      const dP = up > dn && up > 0 ? up : 0;
      const dM = dn > up && dn > 0 ? dn : 0;
      if (i <= P) { sTR += tr; sDP += dP; sDM += dM; }
      else { sTR = sTR - sTR / P + tr; sDP = sDP - sDP / P + dP; sDM = sDM - sDM / P + dM; }
      if (i >= P && sTR > 0) {
        const p = 100 * sDP / sTR, m = 100 * sDM / sTR;
        pdi[i] = p; mdi[i] = m;
        const dx = (p + m) > 0 ? 100 * Math.abs(p - m) / (p + m) : 0;
        dxArr.push(dx);
        if (dxArr.length === P) { prevAdx = dxArr.reduce((a,b)=>a+b,0) / P; adx[i] = prevAdx; }
        else if (dxArr.length > P) { prevAdx = (prevAdx * (P - 1) + dx) / P; adx[i] = prevAdx; }
      }
    }
  }

  // SAR(0.02, 0.2)
  const sar = new Array(n).fill(null);
  if (n >= 2) {
    let bull = closes[1] >= closes[0];
    let af = 0.02, ep = bull ? highs[1] : lows[1], s = bull ? lows[0] : highs[0];
    sar[1] = s;
    for (let i = 2; i < n; i++) {
      s = s + af * (ep - s);
      if (bull) {
        s = Math.min(s, lows[i-1], lows[i-2]);
        if (lows[i] < s) { bull = false; s = ep; ep = lows[i]; af = 0.02; }
        else if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + 0.02, 0.2); }
      } else {
        s = Math.max(s, highs[i-1], highs[i-2]);
        if (highs[i] > s) { bull = true; s = ep; ep = highs[i]; af = 0.02; }
        else if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + 0.02, 0.2); }
      }
      sar[i] = s;
    }
  }

  // Bollinger(20,2) + 帶寬
  const bbU = new Array(n).fill(null), bbL = new Array(n).fill(null), bbW = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    let sum = 0; for (let k = i - 19; k <= i; k++) sum += closes[k];
    const mid = sum / 20;
    let sq = 0; for (let k = i - 19; k <= i; k++) sq += (closes[k] - mid) ** 2;
    const sd = Math.sqrt(sq / 20);
    bbU[i] = mid + 2 * sd; bbL[i] = mid - 2 * sd;
    bbW[i] = mid > 0 ? (bbU[i] - bbL[i]) / mid * 100 : null;
  }

  // PSY(12) / bias20 / RCI(9) / HV(20)
  const psy = new Array(n).fill(null), bias = new Array(n).fill(null), rci = new Array(n).fill(null), hv = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i >= 12) {
      let up = 0; for (let k = i - 11; k <= i; k++) if (closes[k] > closes[k-1]) up++;
      psy[i] = up / 12 * 100;
    }
    if (base.ma20[i] != null && base.ma20[i] > 0) bias[i] = (closes[i] - base.ma20[i]) / base.ma20[i] * 100;
    if (i >= 8) {
      const win = closes.slice(i - 8, i + 1);
      const ranked = win.map((v, idx) => ({ v, idx })).sort((a, b) => b.v - a.v);
      const pr = new Array(9); ranked.forEach((o, r) => { pr[o.idx] = r + 1; });
      let d2 = 0; for (let k = 0; k < 9; k++) { const dr = (9 - k) - pr[k]; d2 += dr * dr; }
      rci[i] = (1 - 6 * d2 / (9 * 80)) * 100;
    }
    if (i >= 20) {
      let m = 0; const rets = [];
      for (let k = i - 19; k <= i; k++) { const r = Math.log(closes[k] / closes[k-1]); rets.push(r); m += r; }
      m /= 20;
      let v = 0; rets.forEach(r => { v += (r - m) ** 2; });
      hv[i] = Math.sqrt(v / 20) * Math.sqrt(250) * 100;
    }
  }

  // 一目均衡表（轉換9/基準26/先行52/位移26）
  const _hl = (i, p) => {
    if (i < p - 1) return null;
    let h = -Infinity, l = Infinity;
    for (let k = i - p + 1; k <= i; k++) { h = Math.max(h, highs[k]); l = Math.min(l, lows[k]); }
    return (h + l) / 2;
  };
  const tenkan = new Array(n).fill(null), kijun = new Array(n).fill(null);
  for (let i = 0; i < n; i++) { tenkan[i] = _hl(i, 9); kijun[i] = _hl(i, 26); }
  const spanA = new Array(n).fill(null), spanB = new Array(n).fill(null);
  for (let i = 26; i < n; i++) {
    if (tenkan[i-26] != null && kijun[i-26] != null) spanA[i] = (tenkan[i-26] + kijun[i-26]) / 2;
    spanB[i] = _hl(i - 26, 52);
  }

  // 含今日的 20 日高低 / 20 日均量（GAS slice(i-19, i+1) 語意）
  const hi20 = new Array(n).fill(null), lo20 = new Array(n).fill(null), vol20 = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - 19);
    let h = -Infinity, l = Infinity, vs = 0;
    for (let k = from; k <= i; k++) { h = Math.max(h, closes[k]); l = Math.min(l, closes[k]); vs += vols[k]; }
    hi20[i] = h; lo20[i] = l; vol20[i] = vs / 20;
  }

  return { closes, opens, highs, lows, vols, ema5, ema10, ema20, ema60, gS, gL, pdi, mdi, adx, sar, bbU, bbL, bbW, psy, bias, rci, hv, tenkan, kijun, spanA, spanB, hi20, lo20, vol20, ma5: base.ma5, ma20: base.ma20, rsi: base.rsi, K: base.K, D: base.D, macd: base.macd };
}

// ── 共用小工具 ──
const _g_chg = (g, i) => i >= 1 && g.closes[i-1] > 0 ? (g.closes[i] / g.closes[i-1] - 1) * 100 : 0;
const _g_volSurge = (g, i) => g.vol20[i] > 0 && g.vols[i] >= g.vol20[i] * 1.5;
const _g_limitUp = (g, i) => _g_chg(g, i) >= 9.5 && Math.abs(g.closes[i] - g.highs[i]) < 0.01;
const _g_crossUp = (g, i) => i >= 1 && g.ma20[i] != null && g.ma20[i-1] != null && g.closes[i] > g.ma20[i] && g.closes[i-1] <= g.ma20[i-1];

const GAS_LIB = {
  rsi_min:    (g,i) => g.rsi[i] != null && g.rsi[i] >= 50,
  rsi_max:    (g,i) => g.rsi[i] != null && g.rsi[i] >= 80,
  rsi_revival:(g,i) => i >= 1 && g.rsi[i] != null && g.rsi[i-1] != null && g.rsi[i] > 30 && g.rsi[i-1] <= 30,
  kd_k_min:   (g,i) => g.K[i] != null && g.K[i] <= 20,
  kd_k_max:   (g,i) => g.K[i] != null && g.K[i] >= 80,
  kd_golden:  (g,i) => i >= 1 && g.K[i] != null && g.K[i] > g.D[i] && g.K[i-1] <= g.D[i-1],
  kd_dead:    (g,i) => i >= 1 && g.K[i] != null && g.K[i] < g.D[i] && g.K[i-1] >= g.D[i-1],
  macd_golden:(g,i) => i >= 1 && g.macd.dif[i] > g.macd.dea[i] && g.macd.dif[i-1] <= g.macd.dea[i-1],
  macd_dead:  (g,i) => i >= 1 && g.macd.dif[i] < g.macd.dea[i] && g.macd.dif[i-1] >= g.macd.dea[i-1],
  macd_hist_pos: (g,i) => g.macd.hist[i] > 0,
  macd_dead_above_zero: (g,i) => GAS_LIB.macd_dead(g,i) && g.macd.dif[i] > 0,
  above_ma20: (g,i) => g.ma20[i] != null && g.closes[i] > g.ma20[i],
  below_ma20: (g,i) => g.ma20[i] != null && g.closes[i] < g.ma20[i],
  ma5_cross_ma20: (g,i) => i >= 1 && g.ma5[i] != null && g.ma20[i] != null && g.ma5[i] > g.ma20[i] && g.ma5[i-1] <= g.ma20[i-1],
  ma20_turn_up:   (g,i) => i >= 2 && g.ma20[i] != null && g.ma20[i] > g.ma20[i-1] && g.ma20[i-1] <= g.ma20[i-2],
  ma20_rising:    (g,i) => i >= 1 && g.ma20[i] != null && g.ma20[i] > g.ma20[i-1],
  ma20_declining: (g,i) => i >= 1 && g.ma20[i] != null && g.ma20[i] < g.ma20[i-1],
  ma20_turn_down: (g,i) => i >= 2 && g.ma20[i] != null && g.ma20[i] < g.ma20[i-1] && g.ma20[i-1] >= g.ma20[i-2],
  price_cross_ma20_up:   _g_crossUp,
  price_reclaim_ma20:    _g_crossUp,
  price_cross_ma20_down: (g,i) => i >= 1 && g.ma20[i] != null && g.ma20[i-1] != null && g.closes[i] < g.ma20[i] && g.closes[i-1] >= g.ma20[i-1],
  price_bounce_ma20:     (g,i) => g.ma20[i] != null && Math.abs(g.closes[i] - g.ma20[i]) / g.ma20[i] < 0.02 && g.closes[i] > g.ma20[i],
  price_far_below_ma20:  (g,i) => g.ma20[i] != null && g.closes[i] < g.ma20[i] * 0.92,
  price_far_above_ma20:  (g,i) => g.ma20[i] != null && g.closes[i] > g.ma20[i] * 1.08,
  price_rally_fail_ma20: (g,i) => i >= 1 && g.ma20[i] != null && g.ma20[i-1] != null && g.closes[i] < g.ma20[i] && g.closes[i-1] >= g.ma20[i-1],
  bb_squeeze:    (g,i) => g.bbW[i] != null && g.bbW[i] < 3,
  bb_expanding:  (g,i) => i >= 5 && g.bbW[i] != null && g.bbW[i-5] != null && g.bbW[i] > g.bbW[i-5] * 1.3,
  bb_upper_touch:(g,i) => g.bbU[i] != null && g.closes[i] >= g.bbU[i] * 0.99,
  bb_lower_touch:(g,i) => g.bbL[i] != null && g.closes[i] <= g.bbL[i] * 1.01,
  high_n_days: (g,i) => g.closes[i] >= g.hi20[i] * 0.99,
  drop_n_days: (g,i) => g.closes[i] <= g.lo20[i] * 1.01,
  vol_surge:  _g_volSurge,
  vol_shrink: (g,i) => g.vol20[i] > 0 && g.vols[i] <= g.vol20[i] * 0.5,
  limit_up:   _g_limitUp,
  limit_down: (g,i) => _g_chg(g,i) <= -9.5 && Math.abs(g.closes[i] - g.lows[i]) < 0.01,
  vol_surge_long:  (g,i) => (_g_volSurge(g,i) && i >= 1 && g.closes[i] > g.closes[i-1]) || _g_limitUp(g,i),
  vol_surge_short: (g,i) => (_g_volSurge(g,i) && i >= 1 && g.closes[i] < g.closes[i-1]) || _g_limitUp(g,i),
  vol_surge_drop:  (g,i) => _g_volSurge(g,i) && i >= 1 && g.closes[i] < g.closes[i-1],
  psy_oversold:   (g,i) => g.psy[i] != null && g.psy[i] <= 25,
  psy_overbought: (g,i) => g.psy[i] != null && g.psy[i] >= 75,
  bias20_low:     (g,i) => g.bias[i] != null && g.bias[i] <= -8,
  rci9_turn_up:   (g,i) => i >= 1 && g.rci[i] != null && g.rci[i-1] != null && g.rci[i] > -80 && g.rci[i-1] <= -80,
  dmi_bull:   (g,i) => g.pdi[i] != null && g.mdi[i] != null && g.adx[i] != null && g.pdi[i] > g.mdi[i] && g.adx[i] > 20,
  dmi_strong: (g,i) => g.adx[i] != null && g.adx[i] > 30 && g.pdi[i] > g.mdi[i],
  dmi_bear:   (g,i) => g.pdi[i] != null && g.mdi[i] != null && g.mdi[i] > g.pdi[i],
  sar_bull:   (g,i) => g.sar[i] != null && g.closes[i] > g.sar[i],
  hv_low:     (g,i) => g.hv[i] != null && g.hv[i] < 20,
  ema_bull:   (g,i) => g.ema5[i] != null && g.ema60[i] != null && g.ema5[i] > g.ema10[i] && g.ema10[i] > g.ema20[i] && g.ema20[i] > g.ema60[i],
  ema_cross_up: (g,i) => i >= 1 && g.ema5[i] != null && g.ema20[i] != null && g.ema5[i-1] != null && g.ema20[i-1] != null && g.ema5[i] > g.ema20[i] && g.ema5[i-1] <= g.ema20[i-1],
  ma_bear_array: (g,i) => g.ema5[i] != null && g.ema60[i] != null && g.ema5[i] < g.ema10[i] && g.ema10[i] < g.ema20[i] && g.ema20[i] < g.ema60[i],
  gmma_bull: (g,i) => {
    let sMin = Infinity, lMax = -Infinity;
    for (const a of g.gS) { if (a[i] == null) return false; sMin = Math.min(sMin, a[i]); }
    for (const a of g.gL) { if (a[i] == null) return false; lMax = Math.max(lMax, a[i]); }
    return sMin > lMax;
  },
  ichi_cloud_above: (g,i) => g.spanA[i] != null && g.spanB[i] != null && g.closes[i] > Math.max(g.spanA[i], g.spanB[i]),
  ichi_below_cloud: (g,i) => g.spanA[i] != null && g.spanB[i] != null && g.closes[i] < Math.min(g.spanA[i], g.spanB[i]),
  ichi_bull_cloud:  (g,i) => g.spanA[i] != null && g.spanB[i] != null && g.spanA[i] > g.spanB[i],
  ichi_tk_cross: (g,i) => i >= 1 && g.tenkan[i] != null && g.kijun[i] != null && g.tenkan[i-1] != null && g.kijun[i-1] != null && g.tenkan[i] > g.kijun[i] && g.tenkan[i-1] <= g.kijun[i-1],
  ichi_tk_dead:  (g,i) => i >= 1 && g.tenkan[i] != null && g.kijun[i] != null && g.tenkan[i-1] != null && g.kijun[i-1] != null && g.tenkan[i] < g.kijun[i] && g.tenkan[i-1] >= g.kijun[i-1],
  ichi_chikou_above: (g,i) => i >= 26 && g.closes[i] > g.closes[i-26],
  three_peaks: (g,i) => {
    if (i < 4) return false;
    let p = 0;
    for (let pi = 1; pi < Math.min(20, i); pi++) {
      const idx = i - pi;
      if (g.closes[idx] > g.closes[idx-1] && g.closes[idx] > g.closes[idx+1]) p++;
    }
    return p >= 3;
  },
  three_valleys: (g,i) => {
    if (i < 4) return false;
    let v = 0;
    for (let vi = 1; vi < Math.min(20, i); vi++) {
      const idx = i - vi;
      if (g.closes[idx] < g.closes[idx-1] && g.closes[idx] < g.closes[idx+1]) v++;
    }
    return v >= 3;
  },
  three_soldiers: (g,i) => i >= 2 &&
    g.closes[i] > g.opens[i] && g.closes[i-1] > g.opens[i-1] && g.closes[i-2] > g.opens[i-2] &&
    g.closes[i] > g.closes[i-1] && g.closes[i-1] > g.closes[i-2],
  bullish_engulfing: (g,i) => i >= 1 &&
    g.closes[i] > g.opens[i] && g.closes[i-1] < g.opens[i-1] &&
    g.opens[i] < g.closes[i-1] && g.closes[i] > g.opens[i-1],
  tight_consolidation: (g,i) => {
    if (i < 4) return false;
    let hh = -Infinity, ll = Infinity;
    for (let k = i - 4; k <= i; k++) { hh = Math.max(hh, g.closes[k]); ll = Math.min(ll, g.closes[k]); }
    return ll > 0 && (hh - ll) / ll < 0.03 && _g_volSurge(g, i);
  },
  gain_10d: (g,i) => i >= 10 && g.closes[i-10] > 0 && (g.closes[i] - g.closes[i-10]) / g.closes[i-10] > 0.05,
  loss_5d:  (g,i) => i >= 5  && g.closes[i-5]  > 0 && (g.closes[i] - g.closes[i-5])  / g.closes[i-5]  < -0.05,
};

export const GAS_SUPPORTED_CONDS = Object.keys(GAS_LIB);

/**
 * 對外：把一段 K 線（{time,open,high,low,close,volume} 或 {t,o,h,l,c,v} 皆可）
 * 預算成 GAS 條件 evaluator。供真實驗室等模組做系統發現策略的逐根判定。
 * 回傳 (i, condIds[]) => bool（暖機 < 60 根一律 false，一目雲等由各條件 null 防護兜底）
 */
export function buildGasEvaluator(rawCandles) {
  const candles = rawCandles.map(c => ({
    t: c.t ?? c.time, o: c.o ?? c.open, h: c.h ?? c.high,
    l: c.l ?? c.low,  c: c.c ?? c.close, v: c.v ?? c.volume ?? 0,
  }));
  const base = _precompute(candles);
  const g = _gasPre(candles, base);
  return (i, condIds) => {
    if (i < 60) return false;
    return condIds.every(id => { const f = GAS_LIB[id]; return f ? f(g, i) : false; });
  };
}


export function isStrategyBacktestable(strategy) {
  return strategy.conditions.every(c =>
    c.condId.startsWith('gas:') ? !!GAS_LIB[c.condId.slice(4)] : !!COND_LIB[c.condId]
  );
}

/** 該日該檔是否觸發指定訊號 */
function _signalAt(ind, i, strategy) {
  if (i < 35) return false;   // 暖機保護（MACD/RSI 需要 ~35 根）
  return strategy.conditions.every(c => {
    if (c.condId.startsWith('gas:')) {
      const gfn = GAS_LIB[c.condId.slice(4)];
      return gfn && ind.gas ? gfn(ind.gas, i) : false;
    }
    const fn = COND_LIB[c.condId];
    return fn ? fn(ind, i, c.value) : false;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 組合回放主體
// ─────────────────────────────────────────────────────────────────────────────
export function runBacktest(opts) {
  const {
    histMap, entryIds = ['X1'],
    exitMode = 'days', exitDays = 20,
    capital = 1_000_000, maxPositions = 10,
    feeRate = 0.001425, taxRate = 0.003,
    stopPct = 8, trailPct = 15, maxHoldDays = 120,
    regimeCandles = null,
    entryFilters = [],
    startTs = null, onProgress = null,
  } = opts;

  const customStrategies = (opts.customStrategies ?? []).filter(isStrategyBacktestable);
  const entryStrats = [
    ...STRATEGIES.filter(s => entryIds.includes(s.id) && isStrategyBacktestable(s)),
    ...customStrategies,
  ];
  if (entryStrats.length === 0) throw new Error('無可回測的進場訊號（條件未支援）');

  const needGas = entryStrats.some(s => s.conditions.some(c => c.condId.startsWith('gas:')));
  const prep = _prepStocks(histMap, startTs, onProgress, needGas);
  const regime = _prepRegime(regimeCandles);
  const result = _replay(prep, entryStrats, { exitMode, exitDays, capital, maxPositions, feeRate, taxRate, stopPct, trailPct, maxHoldDays, regime, entryFilters });
  if (onProgress) onProgress(1, 1);
  return {
    ...result,
    config: { entryIds, exitMode, exitDays, capital, maxPositions, stockCount: prep.stocks.length, days: prep.days.length },
  };
}

/**
 * 全策略比較：每個可回測策略各跑一輪（共用指標預算，快）
 * 回傳 [{ id, name, icon, category, equity, trades, dailyReturns, config }]
 */
export function runBacktestAll(opts) {
  const {
    histMap, exitMode = 'days', exitDays = 20,
    capital = 1_000_000, maxPositions = 10,
    feeRate = 0.001425, taxRate = 0.003,
    stopPct = 8, trailPct = 15, maxHoldDays = 120,
    regimeCandles = null,
    startTs = null, onProgress = null,
  } = opts;

  const strats = STRATEGIES.filter(isStrategyBacktestable);
  const prep = _prepStocks(histMap, startTs, null);
  const regime = _prepRegime(regimeCandles);
  const results = [];

  strats.forEach((strat, idx) => {
    const r = _replay(prep, [strat], { exitMode, exitDays, capital, maxPositions, feeRate, taxRate, stopPct, trailPct, maxHoldDays, regime });
    results.push({
      id: strat.id, name: strat.name, icon: strat.icon, category: strat.category,
      ...r,
      config: { entryIds: [strat.id], exitMode, exitDays, capital, maxPositions, stockCount: prep.stocks.length, days: prep.days.length },
    });
    if (onProgress) onProgress(idx + 1, strats.length);
  });

  return results;
}

// ── 內部：股票池預處理（指標預算 + 交易日曆）──────────────────────────────
function _prepStocks(histMap, startTs, onProgress, needGas = false) {
  const stocks = [];
  const allTs  = new Set();
  const codes = [...histMap.keys()];
  let prepDone = 0;

  for (const code of codes) {
    const hist = histMap.get(code);
    const candles = (hist?.candles ?? []).filter(c => c.a != null && c.c > 0);
    if (candles.length < 60) { prepDone++; continue; }
    const ind = _precompute(candles);
    if (needGas) ind.gas = _gasPre(candles, ind);
    const tsIndex = new Map();
    candles.forEach((c, i) => { tsIndex.set(c.t, i); allTs.add(c.t); });
    stocks.push({ code, candles, ind, tsIndex });
    prepDone++;
    if (onProgress) onProgress(prepDone, codes.length);
  }
  if (stocks.length === 0) throw new Error('無有效股票資料');

  const calendar = [...allTs].sort((a, b) => a - b);
  const warmupTs = calendar[Math.min(60, calendar.length - 1)];
  const beginTs  = startTs ? Math.max(startTs, warmupTs) : warmupTs;
  const days = calendar.filter(ts => ts >= beginTs);
  return { stocks, days };
}

/**
 * 參數掃描：對指定進場訊號，grid 掃 trailing 出場參數（共用指標預算）
 * 回傳 [{ stopPct, trailPct, equity, trades, dailyReturns, config }]
 */
export function runParamScan(opts) {
  const {
    histMap, entryIds = ['X2'],
    stops = [10, 15, 20], trails = [15, 20, 25],
    capital = 1_000_000, maxPositions = 10,
    feeRate = 0.001425, taxRate = 0.003, maxHoldDays = 120,
    regimeCandles = null, startTs = null, onProgress = null,
  } = opts;

  const entryStrats = STRATEGIES.filter(s => entryIds.includes(s.id) && isStrategyBacktestable(s));
  if (entryStrats.length === 0) throw new Error('無可回測的進場訊號');

  const prep = _prepStocks(histMap, startTs, null);
  const regime = _prepRegime(regimeCandles);
  const results = [];
  const total = stops.length * trails.length;
  let done = 0;

  for (const stopPct of stops) {
    for (const trailPct of trails) {
      const r = _replay(prep, entryStrats, {
        exitMode: 'trailing', exitDays: 0, capital, maxPositions,
        feeRate, taxRate, stopPct, trailPct, maxHoldDays, regime,
      });
      results.push({
        stopPct, trailPct, ...r,
        config: { entryIds, exitMode: 'trailing', stopPct, trailPct, capital, maxPositions, stockCount: prep.stocks.length, days: prep.days.length },
      });
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  return results;
}

// ── 內部：大盤濾網預處理（指數/0050 收盤 > MA60 = 可進場）────────────────
function _prepRegime(candles) {
  if (!candles || candles.length < 80) return null;
  const closes = candles.map(c => c.a ?? c.c);
  const ma60 = _sma(closes, 60);
  const riskOn = new Map();   // ts → bool
  for (let i = 0; i < candles.length; i++) {
    riskOn.set(candles[i].t, ma60[i] != null && closes[i] > ma60[i]);
  }
  // 提供「找 ≤ts 最近一筆」的查詢（個股與基準交易日曆可能略有差異）
  const sortedTs = candles.map(c => c.t);
  return {
    canEnter(ts) {
      // 二分找 ≤ ts 的最近基準日
      let lo = 0, hi = sortedTs.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTs[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans < 0) return true;   // 基準資料尚未開始，不擋
      return riskOn.get(sortedTs[ans]) !== false;
    },
  };
}

// ── 內部：回放核心 ──────────────────────────────────────────────────────────
function _replay(prep, entryStrats, cfg) {
  const { stocks, days } = prep;
  const { exitMode, exitDays, capital, maxPositions, feeRate, taxRate } = cfg;
  const entryFilters = cfg.entryFilters ?? [];

  let cash = capital;
  const positions = new Map();
  const trades = [];
  const equity = [];
  const perSlot = capital / maxPositions;
  const stockByCode = new Map(stocks.map(s => [s.code, s]));

  for (let d = 0; d < days.length; d++) {
    const ts = days[d];

    // (a) 出場
    for (const [code, pos] of [...positions]) {
      const st = stockByCode.get(code);
      const i  = st.tsIndex.get(ts);
      if (i == null) continue;
      pos.entryDayCount++;

      let shouldExit = false, reason = '';
      if (exitMode === 'days' && pos.entryDayCount >= exitDays) {
        shouldExit = true; reason = `滿${exitDays}天`;
      } else if (exitMode === 'signal_gone' && i >= 1) {
        const strat = entryStrats.find(s => s.id === pos.signalId) ?? entryStrats[0];
        if (!_signalAt(st.ind, i - 1, strat)) { shouldExit = true; reason = '訊號消失'; }
      } else if (exitMode === 'trailing' && i >= 1) {
        // 停損 + 移動停利：用昨日收盤判定（今日開盤執行）
        const prevA = st.candles[i - 1].a;
        pos.peakA = Math.max(pos.peakA ?? pos.entryA, prevA);
        const fromEntry = prevA / pos.entryA - 1;
        const fromPeak  = prevA / pos.peakA - 1;
        if (fromEntry <= -(cfg.stopPct ?? 8) / 100) {
          shouldExit = true; reason = `停損${cfg.stopPct ?? 8}%`;
        } else if (fromPeak <= -(cfg.trailPct ?? 15) / 100 && fromEntry > 0) {
          shouldExit = true; reason = `回落停利${cfg.trailPct ?? 15}%`;
        } else if (pos.entryDayCount >= (cfg.maxHoldDays ?? 120)) {
          shouldExit = true; reason = `滿${cfg.maxHoldDays ?? 120}天上限`;
        }
      } else if (exitMode === 'supertrend' && i >= 1) {
        // Supertrend 翻空（用昨日方向，今開執行）
        if (st.ind.stDir[i - 1] === 'down') { shouldExit = true; reason = 'Supertrend翻空'; }
        else if (pos.entryDayCount >= (cfg.maxHoldDays ?? 120)) { shouldExit = true; reason = `滿${cfg.maxHoldDays ?? 120}天上限`; }
      } else if (exitMode === 'avwap' && i >= 1) {
        // 以進場 bar 為錨，增量累計 Σ(還原價×量)/Σ量；昨收跌破即出場（今開執行）
        const upto = i - 1;
        let lastJ = pos.vwapLastIdx ?? (pos.entryIdx - 1);
        for (let j = lastJ + 1; j <= upto; j++) {
          const cj = st.candles[j]; const vv = cj.v ?? 0;
          pos.vwapPV = (pos.vwapPV ?? 0) + cj.a * vv;
          pos.vwapV  = (pos.vwapV ?? 0) + vv;
        }
        pos.vwapLastIdx = upto;
        if (pos.vwapV > 0 && st.candles[i - 1].a < pos.vwapPV / pos.vwapV) {
          shouldExit = true; reason = '跌破錨定VWAP';
        } else if (pos.entryDayCount >= (cfg.maxHoldDays ?? 120)) {
          shouldExit = true; reason = `滿${cfg.maxHoldDays ?? 120}天上限`;
        }
      }

      if (shouldExit) {
        const c = st.candles[i];
        const openA = c.a * (c.o / c.c);
        const proceeds = pos.shares * openA * (1 - feeRate - taxRate);
        cash += proceeds;
        trades.push({
          code, signalId: pos.signalId, entryTs: pos.entryTs, exitTs: ts,
          entryPrice: pos.entryC, exitPrice: c.o,
          holdDays: pos.entryDayCount, retPct: +((proceeds / pos.cost - 1) * 100).toFixed(2), reason,
        });
        positions.delete(code);
      }
    }

    // (b) 進場（大盤濾網：用前一交易日的大盤狀態判定，T+1 一致）
    const regimeOk = !cfg.regime || d === 0 || cfg.regime.canEnter(days[d - 1]);
    if (regimeOk && positions.size < maxPositions) {
      const candidates = [];
      for (const st of stocks) {
        if (positions.has(st.code)) continue;
        const i = st.tsIndex.get(ts);
        if (i == null || i < 1) continue;
        // 進場濾網（AND-gate）：用前一日（i-1）狀態，與 _signalAt 同步（T+1）
        if (entryFilters.length && !entryFilters.every(f => COND_LIB[f.condId]?.(st.ind, i - 1, f.value))) continue;
        for (const strat of entryStrats) {
          if (_signalAt(st.ind, i - 1, strat)) { candidates.push({ st, i, signalId: strat.id }); break; }
        }
      }
      candidates.sort((a, b) => a.st.code.localeCompare(b.st.code));
      for (const cand of candidates) {
        if (positions.size >= maxPositions) break;
        const budget = Math.min(perSlot, cash);
        if (budget < perSlot * 0.5) break;
        const c = cand.st.candles[cand.i];
        const openA = c.a * (c.o / c.c);
        if (openA <= 0) continue;
        const shares = budget * (1 - feeRate) / openA;
        cash -= budget;
        positions.set(cand.st.code, {
          shares, cost: budget, entryA: openA, entryC: c.o, entryTs: ts,
          entryDayCount: 0, signalId: cand.signalId, entryIdx: cand.i,
        });
      }
    }

    // (c) 結算
    let mv = 0;
    for (const [code, pos] of positions) {
      const st = stockByCode.get(code);
      const i  = st.tsIndex.get(ts);
      let a = null;
      if (i != null) a = st.candles[i].a;
      else {
        for (let k = st.candles.length - 1; k >= 0; k--) {
          if (st.candles[k].t <= ts) { a = st.candles[k].a; break; }
        }
      }
      mv += a != null ? pos.shares * a : pos.cost;
    }
    equity.push({ t: ts, value: cash + mv });
  }

  // 期末平倉
  const lastTs = days[days.length - 1];
  for (const [code, pos] of positions) {
    const st = stockByCode.get(code);
    const last = st.candles[st.candles.length - 1];
    const proceeds = pos.shares * last.a * (1 - feeRate - taxRate);
    trades.push({
      code, signalId: pos.signalId, entryTs: pos.entryTs, exitTs: lastTs,
      entryPrice: pos.entryC, exitPrice: last.c,
      holdDays: pos.entryDayCount, retPct: +((proceeds / pos.cost - 1) * 100).toFixed(2), reason: '期末持有',
    });
  }

  const dailyReturns = [];
  for (let i = 1; i < equity.length; i++) {
    dailyReturns.push({ t: equity[i].t, r: equity[i].value / equity[i - 1].value - 1 });
  }
  return { equity, trades, dailyReturns };
}
