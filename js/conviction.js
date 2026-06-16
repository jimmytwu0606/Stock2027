/**
 * conviction.js — Advanced 8：確信度系統 C 曲線（v1 計算核心）
 *
 * 把「動能 × 量能流 × 勝率」合成一條可被審判的曲線 C，疊在 K 線下方，
 * 用自身股性區間（P20–P80 帶）與頂底背離回答「這檔現在的脈動可不可信」。
 *
 * 移植自 conviction-demo.html 的 computeC（本冊唯一已驗證參考實作），
 * 補全真實 K 線防呆（null/資料不足/停牌缺口）。
 *
 * 公式（v1，三成分，全程僅用截至前一日資料）：
 *   C_raw = 0.45·z(風險調整動能) + 0.30·z(OBV量能流) + 0.25·z(勝日比)
 *   C = EMA5(C_raw) × Guard − (1−Guard)·κ
 *
 * Guard 修正式（鐵律，demo 撞出的設計缺陷修正）：
 *   純乘數 ×g 會讓崩跌日的負值 C 被縮小（越崩讀數越溫和，荒謬）。
 *   正確式 C×g−(1−g)·κ：g 觸發時正值 C 塌陷、負值 C 加深，雙向皆對。
 *
 * ⚠ C 是「觀察與排序工具」，不是進場訊號。
 *
 * 凍結參數（v1 demo 預設，校正前暫用；CV-P2 校正後更新並附日期）：
 *   參數變更必須升 CONVICTION_VERSION 並重跑全套審判。
 */

// ── 凍結參數（demo 預設，未經正式校正）─────────────────────────────────────
export const CONVICTION_VERSION = 1;          // 參數變更必升，IDB 快取鍵用
export const CONV_PARAMS = {
  W_MOM:      0.45,   // 動能權重
  W_OBV:      0.30,   // 量能流權重
  W_WIN:      0.25,   // 勝日比權重
  MOM_LOOKBACK: 20,   // P2 動能回看
  Z_WINDOW:   60,     // P3 z 滾動窗
  WINSOR:     3,      // P4 winsorize ±σ
  EMA_SPAN:   5,      // P5 EMA 平滑
  BAND_WINDOW: 60,    // P6 帶窗
  BAND_LO:    0.2,    // P6 帶下分位
  BAND_HI:    0.8,    // P6 帶上分位
  GUARD_THETA_R: 2.2, // P7 Guard 否決閾值（body range / ATR）
  GUARD_THETA_V: 2.2, // P7 Guard 否決閾值（vol / volMA）
  GUARD_VETO: 0.3,    // P8 Guard 地板
  GUARD_REC:  0.06,   // P8 Guard 每日回復
  KAPPA:      1.5,    // P9 崩跌懲罰深度
  OBV_LOOKBACK: 10,   // OBV 動量差分窗
  WIN_WINDOW: 20,     // 勝日比窗（v1 限定）
};

// ── 基礎工具 ────────────────────────────────────────────────────────────────

// ATR(14)，Wilder 平滑
function _atr14(bars) {
  const out = [];
  let a = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!b || !(b.high >= b.low)) { out.push(a); continue; }
    const tr = i > 0 && bars[i - 1]
      ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
      : (b.high - b.low);
    a = (a === null) ? tr : (a * 13 + tr) / 14;
    out.push(a);
  }
  return out;
}

// 滾動 z-score + winsorize（與 demo rollZ 一致，補 null 防呆）
function _rollZ(arr, win, winsor) {
  return arr.map((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const s = Math.max(0, i - win + 1);
    const xs = [];
    for (let j = s; j <= i; j++) {
      if (arr[j] !== null && arr[j] !== undefined && Number.isFinite(arr[j])) xs.push(arr[j]);
    }
    if (xs.length < 10) return null;   // 樣本不足不算 z
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length) || 1e-9;
    const z = (v - m) / sd;
    return Math.max(-winsor, Math.min(winsor, z));   // winsorize
  });
}

// 分位數（線性插值）
function _quantile(xs, q) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const idx = (a.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/**
 * 計算 C 曲線
 * @param {Array} bars - [{open, high, low, close, volume|vol}, ...] 由舊到新
 * @param {object} params - 覆寫 CONV_PARAMS（選填，校正用）
 * @returns {{C, p20, p80, guard, components}} 各為與 bars 等長的陣列（不足處為 null）
 */
export function computeConviction(bars, params = {}) {
  const P = { ...CONV_PARAMS, ...params };
  const n = Array.isArray(bars) ? bars.length : 0;
  const empty = { C: [], p20: [], p80: [], guard: [], components: { zMom: [], zObv: [], zWin: [] } };
  if (n < 30) return empty;   // 資料太短無法算 z

  // 統一 volume 欄位（兼容 vol / volume）
  const vol = bars.map(b => (b && (b.volume ?? b.vol)) || 0);

  const atr = _atr14(bars);

  // ── 成分 1：風險調整動能（20日報酬 / (ATR/price)）──────────────────────
  const mom = bars.map((_, i) => {
    if (i < P.MOM_LOOKBACK) return null;
    const c0 = bars[i - P.MOM_LOOKBACK]?.close, c1 = bars[i]?.close, a = atr[i];
    if (!(c0 > 0) || !(c1 > 0) || !(a > 0)) return null;
    return (c1 / c0 - 1) / (a / c1);
  });

  // ── 成分 2：OBV 量能流（OBV 10日動量）──────────────────────────────────
  let obv = 0;
  const obvA = bars.map((b, i) => {
    if (i > 0 && b && bars[i - 1]) {
      obv += (b.close > bars[i - 1].close ? vol[i] : b.close < bars[i - 1].close ? -vol[i] : 0);
    }
    return obv;
  });
  const obvS = obvA.map((v, i) => (i < P.OBV_LOOKBACK) ? null : v - obvA[i - P.OBV_LOOKBACK]);

  // ── 成分 3：勝日比（近20日上漲日占比）──────────────────────────────────
  const win = bars.map((_, i) => {
    if (i < P.WIN_WINDOW) return null;
    let w = 0;
    for (let j = i - (P.WIN_WINDOW - 1); j <= i; j++) {
      if (bars[j] && bars[j - 1] && bars[j].close > bars[j - 1].close) w++;
    }
    return w / P.WIN_WINDOW;
  });

  // z-score 標準化（winsorize ±3）
  const zm = _rollZ(mom, P.Z_WINDOW, P.WINSOR);
  const zo = _rollZ(obvS, P.Z_WINDOW, P.WINSOR);
  const zw = _rollZ(win, P.Z_WINDOW, P.WINSOR);

  // ── Guard：爆量長黑硬否決 + 緩回復 ─────────────────────────────────────
  let g = 1;
  const guard = [];
  const volMA = bars.map((_, i) => {
    const s = Math.max(0, i - (P.WIN_WINDOW - 1));
    let t = 0;
    for (let j = s; j <= i; j++) t += vol[j];
    return t / (i - s + 1);
  });
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const body = b ? (b.open - b.close) : 0;     // body>0 = 黑K（收<開）
    const rng = b ? (b.high - b.low) : 0;
    const a = atr[i];
    const vMAprev = (i > 0) ? volMA[i - 1] : volMA[i];
    // 硬否決：高檔爆量長黑（黑K + 長實體 + 爆量）
    if (i > P.MOM_LOOKBACK && body > 0 && a > 0 &&
        rng > P.GUARD_THETA_R * a && vol[i] > P.GUARD_THETA_V * vMAprev) {
      g = P.GUARD_VETO;
    } else {
      g = Math.min(1, g + P.GUARD_REC);   // 緩回復
    }
    guard.push(g);
  }

  // ── 合成 C_raw → EMA5 → Guard 修正式 ───────────────────────────────────
  const raw = bars.map((_, i) =>
    (zm[i] === null || zo[i] === null || zw[i] === null)
      ? null
      : P.W_MOM * zm[i] + P.W_OBV * zo[i] + P.W_WIN * zw[i]
  );

  const C = [];
  let e = null;
  const emaK = 2 / (P.EMA_SPAN + 1);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (v === null) { C.push(null); continue; }
    e = (e === null) ? v : v * emaK + e * (1 - emaK);
    // 🔴 Guard 修正式：C×g − (1−g)·κ（鐵律，純乘數會錯誤縮小負值）
    C.push(e * guard[i] - (1 - guard[i]) * P.KAPPA);
  }

  // ── 股性帶：C 自身 60日 P20/P80 ────────────────────────────────────────
  const p20 = [], p80 = [];
  for (let i = 0; i < n; i++) {
    if (C[i] === null) { p20.push(null); p80.push(null); continue; }
    const s = Math.max(0, i - (P.BAND_WINDOW - 1));
    const xs = [];
    for (let j = s; j <= i; j++) if (C[j] !== null) xs.push(C[j]);
    if (xs.length < 10) { p20.push(null); p80.push(null); continue; }
    p20.push(_quantile(xs, P.BAND_LO));
    p80.push(_quantile(xs, P.BAND_HI));
  }

  return { C, p20, p80, guard, components: { zMom: zm, zObv: zo, zWin: zw } };
}

/**
 * 取最新一筆 C 值與狀態（前端 chip / snapshot 用）
 * @returns {{c, p20, p80, inBand, guardActive}|null}
 */
export function latestConviction(bars, params = {}) {
  const r = computeConviction(bars, params);
  const i = r.C.length - 1;
  if (i < 0 || r.C[i] === null) return null;
  const c = r.C[i], lo = r.p20[i], hi = r.p80[i];
  return {
    c: +c.toFixed(3),
    p20: lo != null ? +lo.toFixed(3) : null,
    p80: hi != null ? +hi.toFixed(3) : null,
    inBand: (lo != null && hi != null) ? (c >= lo && c <= hi) : null,
    guardActive: r.guard[i] < 1,
  };
}
