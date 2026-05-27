/**
 * indicators.js
 * 技術指標純計算函式，無任何 DOM 操作
 * 所有函式均為 pure function，輸入 → 輸出。
 *
 * ── 原有 ──
 *   calcMA(closes, n)              → number[]  (含 null 前綴)
 *   calcRSI(closes, n)             → number[]
 *   calcKD(candles, n)             → { k: number[], d: number[] }
 *   calcMACD(closes, f, s, g)      → { dif, sigLine, hist }
 *   calcBollinger(closes, n, mult) → ({ upper, mid, lower, width } | null)[]
 *   calcBBWidth(closes, n, mult)   → (number | null)[]
 *
 * ── Advanced 5 新增 ──
 *   calcEMA(closes, n)             → number[]
 *   calcGMMA(closes)               → { short: number[][], long: number[][] }
 *   calcBias(closes, n)            → (number | null)[]
 *   calcPSY(closes, n)             → (number | null)[]
 *   calcRCI(closes, n)             → (number | null)[]
 *   calcDMI(candles, n)            → { plusDI, minusDI, adx }
 *   calcSAR(candles, step, maxStep)→ (number | null)[]  (前30根為null)
 *   calcHV(closes, n)              → (number | null)[]  (年化波動率%)
 *   calcEnvelope(closes, n, pct)   → ({ upper, mid, lower } | null)[]
 */

// ─────────────────────────────────────────────
// 移動平均（SMA）
// ─────────────────────────────────────────────
export function calcMA(closes, n) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    const sum = closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0);
    return +(sum / n).toFixed(2);
  });
}

// ─────────────────────────────────────────────
// RSI（Wilder's Simple Method）
// ─────────────────────────────────────────────
export function calcRSI(closes, n = 14) {
  return closes.map((_, i) => {
    if (i < n) return null;
    let gain = 0, loss = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const delta = closes[j] - closes[j - 1];
      if (delta > 0) gain += delta;
      else           loss -= delta;
    }
    const rs = loss === 0 ? 100 : gain / loss;
    return +(100 - 100 / (1 + rs)).toFixed(2);
  });
}

// ─────────────────────────────────────────────
// KD（隨機指標，Stochastic Oscillator）
// ─────────────────────────────────────────────
export function calcKD(candles, n = 9) {
  let k = 50, d = 50;
  const kArr = [], dArr = [];

  candles.forEach((c, i) => {
    const slice = candles.slice(Math.max(0, i - n + 1), i + 1);
    const lo    = Math.min(...slice.map(x => x.low));
    const hi    = Math.max(...slice.map(x => x.high));
    const rsv   = hi === lo ? 50 : (c.close - lo) / (hi - lo) * 100;

    k = k * 2 / 3 + rsv / 3;
    d = d * 2 / 3 + k   / 3;

    kArr.push(+k.toFixed(2));
    dArr.push(+d.toFixed(2));
  });

  return { k: kArr, d: dArr };
}

// ─────────────────────────────────────────────
// EMA 內部輔助（從頭開始，第0根即有值）
// ─────────────────────────────────────────────
function _ema(arr, n) {
  const k = 2 / (n + 1);
  let v = arr[0];
  return arr.map((p, i) => {
    if (i === 0) return p;
    v = p * k + v * (1 - k);
    return +v.toFixed(4);
  });
}

// ─────────────────────────────────────────────
// MACD（12, 26, 9）
// ─────────────────────────────────────────────
export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const eFast   = _ema(closes, fast);
  const eSlow   = _ema(closes, slow);
  const dif     = closes.map((_, i) => +(eFast[i] - eSlow[i]).toFixed(4));
  const sigLine = _ema(dif, signal);
  const hist    = dif.map((v, i) => +(v - sigLine[i]).toFixed(4));
  return { dif, sigLine, hist };
}

// ─────────────────────────────────────────────
// 布林通道（Bollinger Bands）
// 回傳與 closes 等長的陣列，前 n-1 項為 null（與 calcMA 對齊）
// ─────────────────────────────────────────────
export function calcBollinger(closes, n = 20, stdMult = 2) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    const slice = closes.slice(i - n + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / n;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return {
      upper: +(mean + stdMult * std).toFixed(2),
      mid:   +mean.toFixed(2),
      lower: +(mean - stdMult * std).toFixed(2),
      width: +(std * 2 * stdMult / mean * 100).toFixed(4),
    };
  });
}

/**
 * calcBBWidth：計算布林帶寬序列（僅帶寬數值，含 null 前綴）
 * 供篩選器 bb_squeeze 條件使用
 */
export function calcBBWidth(closes, n = 20, stdMult = 2) {
  return calcBollinger(closes, n, stdMult).map(b => b ? b.width : null);
}

// ═══════════════════════════════════════════════════════
// ▼▼▼  Advanced 5 新增指標  ▼▼▼
// ═══════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// A1 EMA（指數移動平均）— 公開 export
// 與內部 _ema 相同邏輯，但補齊前綴使長度與 calcMA 一致
// 注意：EMA 從第0根即有值（不像 SMA 需要 n 根），
//       回傳完整長度陣列，供 chart.js / screener 引用
// ─────────────────────────────────────────────
export function calcEMA(closes, n) {
  return _ema(closes, n);
}

// ─────────────────────────────────────────────
// A3 GMMA 顧比均線（Guppy Multiple Moving Average）
// 短期組：EMA(3,5,8,10,12,15)
// 長期組：EMA(30,35,40,45,50,60)
// 用法：const { short, long } = calcGMMA(closes)
//   short[0] = EMA3 序列, short[1] = EMA5 序列, ...
//   long[0]  = EMA30序列, ...
// 策略判斷：
//   多頭 — short 每條最新值都 > long 每條最新值
//   空頭 — short 每條最新值都 < long 每條最新值
// ⚠️ 共12條線，圖表顯示時務必預設 toggle 關閉
// ─────────────────────────────────────────────
export function calcGMMA(closes) {
  const shortPeriods = [3, 5, 8, 10, 12, 15];
  const longPeriods  = [30, 35, 40, 45, 50, 60];
  return {
    short: shortPeriods.map(n => _ema(closes, n)),
    long:  longPeriods.map(n  => _ema(closes, n)),
  };
}

// ─────────────────────────────────────────────
// A4 乖離率（Bias Rate）
// 公式：(收盤 - MAn) / MAn × 100
// 前 n-1 根無法計算，填 null
// 正值 = 超漲，負值 = 超跌
// ─────────────────────────────────────────────
export function calcBias(closes, n = 20) {
  const ma = calcMA(closes, n);
  return closes.map((c, i) => {
    if (ma[i] == null || ma[i] === 0) return null;
    return +((c - ma[i]) / ma[i] * 100).toFixed(2);
  });
}

// ─────────────────────────────────────────────
// A5 PSY 心理線（Psychological Line）
// 公式：N日內上漲天數 / N × 100
// 優點：公式明確，邊界清楚，不易誤判
// PSY > 75 超買，PSY < 25 超賣
// ─────────────────────────────────────────────
export function calcPSY(closes, n = 12) {
  return closes.map((_, i) => {
    if (i < n) return null;
    let upDays = 0;
    for (let j = i - n + 1; j <= i; j++) {
      if (closes[j] > closes[j - 1]) upDays++;
    }
    return +((upDays / n) * 100).toFixed(2);
  });
}

// ─────────────────────────────────────────────
// A6 RCI（Rank Correlation Index，順位相關係數）
// 公式：RCI = (1 - 6Σd² / (n³ - n)) × 100
// d = 時間順位（越新=1）- 價格順位（越高=1）
// +80 以上極強多頭，-80 以下極強空頭
// 極值翻轉是最強訊號
// ─────────────────────────────────────────────
export function calcRCI(closes, n = 9) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    const slice = closes.slice(i - n + 1, i + 1); // 最舊→最新
    // 價格排序（由高到低，最高=1）
    const sorted = [...slice].sort((a, b) => b - a);
    const priceRank = slice.map(v => sorted.indexOf(v) + 1);
    // 時間排序（最新=1）
    let d2sum = 0;
    for (let j = 0; j < n; j++) {
      const timeRank  = n - j;          // slice[j] 的時間排位（最舊=n，最新=1）
      const d = timeRank - priceRank[j];
      d2sum += d * d;
    }
    const rci = (1 - (6 * d2sum) / (n * n * n - n)) * 100;
    return +rci.toFixed(2);
  });
}

// ─────────────────────────────────────────────
// A7 DMI 動向指標（Directional Movement Index）
// 回傳：{ plusDI, minusDI, adx }，各為 number[]
// 前 n 根為 null（需要 n+1 根才能算第一個 TR）
// 判斷：
//   +DI > -DI 且 ADX > 20 → 多頭趨勢
//   ADX < 20              → 盤整，避免追買
//   ADX > 30              → 強趨勢確認
// ─────────────────────────────────────────────
export function calcDMI(candles, n = 14) {
  const len = candles.length;
  const plusDI  = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const adx     = new Array(len).fill(null);

  if (len < n + 1) return { plusDI, minusDI, adx };

  // 計算每根的 +DM, -DM, TR
  const dmPlus  = [];
  const dmMinus = [];
  const tr      = [];

  for (let i = 1; i < len; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];
    const upMove   = (cur.high  ?? cur.close) - (prev.high  ?? prev.close);
    const downMove = (prev.low  ?? prev.close) - (cur.low   ?? cur.close);
    dmPlus.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
    dmMinus.push(downMove > upMove   && downMove > 0 ? downMove : 0);
    const h = cur.high  ?? cur.close;
    const l = cur.low   ?? cur.close;
    const pc = prev.close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder 平滑（第一個用簡單加總）
  let smTR    = tr.slice(0, n).reduce((a, b) => a + b, 0);
  let smPlus  = dmPlus.slice(0, n).reduce((a, b) => a + b, 0);
  let smMinus = dmMinus.slice(0, n).reduce((a, b) => a + b, 0);

  const firstIdx = n; // candles index = n（dmPlus 是從 i=1 開始，所以 dmPlus[n-1] 對應 candles[n]）
  const _di = (sm, smTR_) => smTR_ > 0 ? (sm / smTR_) * 100 : 0;

  let pdi = _di(smPlus, smTR);
  let mdi = _di(smMinus, smTR);
  plusDI[firstIdx]  = +pdi.toFixed(2);
  minusDI[firstIdx] = +mdi.toFixed(2);

  // 第一個 DX → 後面用 Wilder 平滑 ADX
  const dx0   = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
  let smDX    = dx0;
  let adxVal  = dx0; // 先累積 n 個 DX 才開始輸出 ADX

  // 累積 n 個 DX 後才有 ADX，因此 ADX 從 firstIdx + n 開始有效
  const dxArr = [dx0];

  for (let i = n; i < tr.length; i++) {
    smTR    = smTR    - smTR    / n + tr[i];
    smPlus  = smPlus  - smPlus  / n + dmPlus[i];
    smMinus = smMinus - smMinus / n + dmMinus[i];
    pdi = _di(smPlus, smTR);
    mdi = _di(smMinus, smTR);
    const cIdx = i + 1; // candles index
    plusDI[cIdx]  = +pdi.toFixed(2);
    minusDI[cIdx] = +mdi.toFixed(2);
    const dx = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
    dxArr.push(dx);
  }

  // ADX = n 週期 Wilder 平均 DX
  // 需要 n 個 DX 才能出第一個 ADX
  if (dxArr.length >= n) {
    let adxSmooth = dxArr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    adx[firstIdx + n - 1] = +adxSmooth.toFixed(2);
    for (let i = n; i < dxArr.length; i++) {
      adxSmooth = (adxSmooth * (n - 1) + dxArr[i]) / n;
      adx[firstIdx + i] = +adxSmooth.toFixed(2);
    }
  }

  return { plusDI, minusDI, adx };
}

// ─────────────────────────────────────────────
// A8 SAR 拋物線指標（Parabolic SAR）
// ⚠️ 前 WARMUP 根設為 null（計算值震盪，不可信）
// SAR 在股價下方 → 多頭；在上方 → 空頭
// 反轉時 SAR 跳到對面 → 轉折訊號
// ─────────────────────────────────────────────
const SAR_WARMUP = 30;

export function calcSAR(candles, step = 0.02, maxStep = 0.2) {
  const len = candles.length;
  const result = new Array(len).fill(null);
  if (len < SAR_WARMUP + 2) return result;

  // 初始化：用前兩根判斷初始趨勢
  let bull   = candles[1].close >= candles[0].close; // true=多頭
  let sar    = bull ? candles[0].low : candles[0].high;
  let ep     = bull ? candles[0].high : candles[0].low; // Extreme Point
  let af     = step; // Acceleration Factor

  for (let i = 1; i < len; i++) {
    const cur  = candles[i];
    const high = cur.high  ?? cur.close;
    const low  = cur.low   ?? cur.close;

    // 計算新 SAR
    let newSar = sar + af * (ep - sar);

    if (bull) {
      // 多頭：SAR 不能高於前兩根低點
      const prevLow  = candles[i - 1].low  ?? candles[i - 1].close;
      const prev2Low = i >= 2 ? (candles[i - 2].low ?? candles[i - 2].close) : prevLow;
      newSar = Math.min(newSar, prevLow, prev2Low);

      if (low < newSar) {
        // 多頭反轉 → 空頭
        bull   = false;
        newSar = ep;
        ep     = low;
        af     = step;
      } else {
        if (high > ep) { ep = high; af = Math.min(af + step, maxStep); }
      }
    } else {
      // 空頭：SAR 不能低於前兩根高點
      const prevHigh  = candles[i - 1].high  ?? candles[i - 1].close;
      const prev2High = i >= 2 ? (candles[i - 2].high ?? candles[i - 2].close) : prevHigh;
      newSar = Math.max(newSar, prevHigh, prev2High);

      if (high > newSar) {
        // 空頭反轉 → 多頭
        bull   = true;
        newSar = ep;
        ep     = high;
        af     = step;
      } else {
        if (low < ep) { ep = low; af = Math.min(af + step, maxStep); }
      }
    }

    sar = newSar;
    // 暖機期不輸出
    if (i >= SAR_WARMUP) result[i] = +sar.toFixed(2);
  }

  return result;
}

// ─────────────────────────────────────────────
// A9 HV 歷史波動率（Historical Volatility）
// 公式：N日對數報酬率標準差 × √252（年化）
// 常用 20 日
// HV < 20% → 低波動穩定
// HV 突然放大 → 行情啟動訊號
// ─────────────────────────────────────────────
export function calcHV(closes, n = 20) {
  return closes.map((_, i) => {
    if (i < n) return null;
    const slice = closes.slice(i - n, i + 1); // n+1 個收盤，算 n 個報酬率
    const returns = [];
    for (let j = 1; j < slice.length; j++) {
      if (slice[j - 1] > 0) returns.push(Math.log(slice[j] / slice[j - 1]));
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    const hv = Math.sqrt(variance) * Math.sqrt(252) * 100; // 年化 %
    return +hv.toFixed(2);
  });
}

// ─────────────────────────────────────────────
// A11 ENV 包絡線（Envelope）
// 公式：上軌 = MA × (1 + pct/100)，下軌 = MA × (1 - pct/100)
// 常用 MA20 ± 5%
// 股價觸及下軌 → 超跌反彈候選
// 股價突破上軌 → 強勢突破
// ─────────────────────────────────────────────
export function calcEnvelope(closes, n = 20, pct = 5) {
  const ma = calcMA(closes, n);
  return closes.map((_, i) => {
    if (ma[i] == null) return null;
    const mid = ma[i];
    return {
      upper: +(mid * (1 + pct / 100)).toFixed(2),
      mid:   +mid.toFixed(2),
      lower: +(mid * (1 - pct / 100)).toFixed(2),
    };
  });
}

// ─────────────────────────────────────────────
// C1 一目均衡表 Ichimoku Cloud（雲帶五條線）
// 經典參數：tenkanLen=9, kijunLen=26, senkouBLen=52, shift=26
//
// 五條線：
//   轉換線(Tenkan)  = (9日最高 + 9日最低) / 2
//   基準線(Kijun)   = (26日最高 + 26日最低) / 2
//   先行帶A(SenkouA) = (Tenkan + Kijun) / 2，前移 26 日（畫到未來）
//   先行帶B(SenkouB) = (52日最高 + 52日最低) / 2，前移 26 日
//   延遲線(Chikou)  = 收盤價，後移 26 日（畫到過去）
//
// 訊號：
//   三役好轉：Tenkan>Kijun + 收盤>雲帶上緣 + Chikou>26日前收盤
//   雲帶上方：收盤 > max(SenkouA, SenkouB)
//   TK 黃金交叉：Tenkan 剛上穿 Kijun（近 1~3 日）
//   雲帶顏色：SenkouA > SenkouB → 多頭雲（淡紅/淡綠）；反之空頭雲
//
// 回傳：對齊原 candles 長度的陣列；前移帶 A/B 額外 +26 個未來資料點
// 結構：{
//   tenkan:  number[]   ← 對齊 candles
//   kijun:   number[]   ← 對齊 candles
//   senkouA: { time, value }[]  ← 含 26 個未來時間點
//   senkouB: { time, value }[]  ← 含 26 個未來時間點
//   chikou:  number[]   ← 對齊 candles，最後 26 個為 null
// }
// 注意：時間軸上 senkouA/B 的 time 由 candles 平均時間間隔推算
// ─────────────────────────────────────────────
export function calcIchimoku(candles, tenkanLen = 9, kijunLen = 26, senkouBLen = 52, shift = 26) {
  const n = candles.length;
  if (n < senkouBLen) {
    // 資料不夠完整算 SenkouB，回傳空結構（避免外層崩潰）
    return {
      tenkan: new Array(n).fill(null),
      kijun:  new Array(n).fill(null),
      senkouA: [],
      senkouB: [],
      chikou:  new Array(n).fill(null),
      _meta:  { ready: false, reason: `candles<${senkouBLen}` },
    };
  }

  // 工具：取近 len 根的最高/最低中點
  const midRange = (i, len) => {
    if (i < len - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - len + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low  < lo) lo = candles[j].low;
    }
    return (hi + lo) / 2;
  };

  const tenkan = [];
  const kijun  = [];
  for (let i = 0; i < n; i++) {
    tenkan.push(midRange(i, tenkanLen));
    kijun.push(midRange(i, kijunLen));
  }

  // 先行帶 A/B：當下值，待會兒整段往未來 shift
  // value[i] 屬於 candles[i]，但實際畫在 candles[i + shift] 的時間位置
  const senkouAValues = [];
  const senkouBValues = [];
  for (let i = 0; i < n; i++) {
    senkouAValues.push(tenkan[i] != null && kijun[i] != null
      ? (tenkan[i] + kijun[i]) / 2 : null);
    senkouBValues.push(midRange(i, senkouBLen));
  }

  // 計算未來時間戳：用最近 5 根 candles 的平均間隔當步長
  let avgStep = 86400; // 預設一天（秒），交易日為主
  if (n >= 6) {
    const recent = candles.slice(-6);
    let sum = 0, cnt = 0;
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i].time - recent[i - 1].time;
      if (d > 0 && d < 86400 * 7) { sum += d; cnt++; }  // 過濾跨週末異常值
    }
    if (cnt > 0) avgStep = Math.round(sum / cnt);
  }

  // 組裝 senkouA / senkouB：對齊位移後的時間軸
  // [0..n-1] 對應 candles[i+shift] 的位置 → i+shift < n 時用 candles 時間
  //                                          i+shift >= n 時用未來推算的時間
  const lastTime = candles[n - 1].time;
  const senkouA = [];
  const senkouB = [];
  for (let i = 0; i < n; i++) {
    const targetIdx = i + shift;
    let t;
    if (targetIdx < n) {
      t = candles[targetIdx].time;
    } else {
      t = lastTime + avgStep * (targetIdx - n + 1);
    }
    if (senkouAValues[i] != null) senkouA.push({ time: t, value: +senkouAValues[i].toFixed(4) });
    if (senkouBValues[i] != null) senkouB.push({ time: t, value: +senkouBValues[i].toFixed(4) });
  }

  // 延遲線：收盤後移 shift 日 → chikou[i] = candles[i+shift].close
  // 等價：在 candles[i] 位置顯示 candles[i+shift].close
  const chikou = [];
  for (let i = 0; i < n; i++) {
    chikou.push(i + shift < n ? candles[i + shift].close : null);
  }

  return {
    tenkan, kijun, senkouA, senkouB, chikou,
    _meta: { ready: true, tenkanLen, kijunLen, senkouBLen, shift },
  };
}

