/**
 * health.js
 * 統一健康度計算模組 — Advanced 5（雙健康度版）v2.8
 *
 * 設計原則：
 *   1. 全系統只有一份健康度邏輯
 *   2. 越具參考價值的指標 → 加分/扣分越重
 *   3. 負向訊號導入扣分，避免所有股票都高分
 *   4. 雙健康度：短線（隔日衝）+ 長線（中長線布局）
 *   5. v2.8：短線健康度加入 X 系列訊號加成層（做法 B，不影響五燈獎）
 *
 * export：
 *   calcHealth(candles, signals?)    → number|null  短線健康度（需 ≥20 根日K）
 *   calcHealthLong(candles, fund?)   → number|null  長線健康度（需 ≥120 根日K）
 *   calcHealthFast(row)              → number|null  篩選器快速估算（無K線）
 *   healthBadge(score, prefix)       → string       HTML badge
 *   healthBadgeDual(s, l, prefix)    → string       短線+長線雙 badge HTML
 *
 * ══ 短線健康度評分架構（滿分 100，基準 50）══
 *  趨勢 MA+EMA    ±22  站上 MA20/60 + EMA 排列 [v2: 28→22 降權避免單維蓋全局]
 *  RSI(14)        ±20  50-60 +12 / 60-70 +20 / 70-80 +5 [v2: 細分區間 + 70-80 從 +10 降 +5]
 *  KD(9)          ±15  >85 扣分（極度超買）
 *  DMI/ADX(14)    ±12  ADX<15 盤整不計分
 *  量能            ±10  爆量加；嚴重萎縮扣
 *  HV(20) 波動率  ± 8  低波動潛伏加；過熱扣
 *  乖離率(20)     ± 4  >10 +2→+3 / >15 +4 [v2: 高乖離扣分加重]
 *  PSY(12)        ± 3  情緒佐證
 *
 * ══ X 系列訊號加成（v2.8 新增，做法 B）══
 *  X1 黃金比例      +6  三軸共振（動能+量能+趨勢），最穩定的強勢確認
 *  X2 天黑請閉眼    +8  飆股加速期爆量，強動能確認（不補回乖離扣分，另加）
 *  X3 炒底王        +5  V 型反轉量增，底部確認加分
 *  X4 何時輪到我    +4  族群輪動，本股尚未啟動，溫和加分
 *  上限：X 系列加成後總分不超過 92（避免飆股爆量時顯示 100 分誤導）
 *  設計原則：訊號加成是「確認強勢狀態」，不是「補回技術面扣分」
 *  ⚠️ 與五燈獎完全獨立：X1-X4 未進 _SCORABLE_IDS，健康度加成不影響燈號計分
 *
 * ══ 長線健康度評分架構（滿分 100，基準 50）══
 *  大趨勢結構      ±20  MA60/120/240 排列；年線部分採比例權重 [v2: MA240 不足容錯]
 *  基本面獲利品質  ±20  EPS正且成長；毛利率/淨利率趨勢（營收預留引信）
 *  歷史百分位      ±15  現價在1年區間的位置（低檔加；高檔扣）
 *  週K RSI        ±12  合成週K RSI，中期動能 [v2: 高位區加分打折]
 *  波段結構 HH/HL ±10  高低點持續墊高 = 多頭完整 [v2: 高位區加分打折]
 *  估值合理性      ±10  PE/PB/殖利率（預留：EPS成長率）
 *  長期量能        ± 8  半年均量遞增（籌碼沉澱）
 *  月K趨勢        ± 5  月K站上月線的連續性 [v2: 高位區加分打折]
 *
 * ── 高位區動能打折（v2 新增）──
 *  pct > 88%  → 高位區，週K RSI / HH-HL / 月K 三維度「加分」× 0.5
 *  pct > 95%  → 過熱區，週K RSI / HH-HL / 月K 三維度「加分」× 0
 *  扣分不打折（避免雙重懲罰）
 *
 * ── MA240 容錯（v2 新增）──
 *  yearlyWeight = min(n, 240) / 240
 *  影響：站上年線 ±4、半年線>年線 ±2、月K跌破年線 -12 均乘以 yearlyWeight
 *
 * ── 負向重扣 ──
 *  EPS 連續衰退       → -15
 *  PE > 50 過度高估   → -10
 *  現價在1年高點90%+  → - 8（追高風險）
 *  現價在1年高點95%+  → -12（過熱追高）
 *  月K跌破年線        → -12（× yearlyWeight）
 *
 * ── 預留引信（營收，待 Firebase 資料就緒後啟用）──
 *  fund._revenueGrowthMoM  月營收月增率
 *  fund._revenueGrowthYoY  月營收年增率
 *  fund._revenueSeries     月營收序列
 */

import { calcMA, calcEMA, calcRSI, calcKD, calcDMI, calcHV, calcBias, calcPSY } from './indicators.js';

// ═══════════════════════════════════════════════════════
// 工具：從日K合成週K / 月K
// ═══════════════════════════════════════════════════════
function _toWeeklyCandles(dailyCandles) {
  const weeks = [];
  let cur = null;
  for (const c of dailyCandles) {
    const d = new Date((c.time ?? 0) * 1000);
    // 週一開新週（getDay() === 1）或第一根
    const isMon = d.getDay() === 1;
    if (!cur || isMon) {
      if (cur) weeks.push(cur);
      cur = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 };
    } else {
      cur.high   = Math.max(cur.high, c.high);
      cur.low    = Math.min(cur.low,  c.low);
      cur.close  = c.close;
      cur.volume = (cur.volume ?? 0) + (c.volume ?? 0);
    }
  }
  if (cur) weeks.push(cur);
  return weeks;
}

function _toMonthlyCandles(dailyCandles) {
  const months = [];
  let cur = null, lastMonth = -1;
  for (const c of dailyCandles) {
    const d = new Date((c.time ?? 0) * 1000);
    const m = d.getFullYear() * 12 + d.getMonth();
    if (m !== lastMonth) {
      if (cur) months.push(cur);
      cur = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 };
      lastMonth = m;
    } else {
      cur.high   = Math.max(cur.high, c.high);
      cur.low    = Math.min(cur.low,  c.low);
      cur.close  = c.close;
      cur.volume = (cur.volume ?? 0) + (c.volume ?? 0);
    }
  }
  if (cur) months.push(cur);
  return months;
}

// ═══════════════════════════════════════════════════════
// 短線健康度（原 calcHealth，加根數保護）
// 需要 ≥20 根日K；建議傳 1y（≥240根）讓指標更準
// v2.8：加入 signals 參數，支援 X 系列訊號加成
//   - signals 為 Signal[]（matchSignals 回傳值）
//   - 不傳或傳空陣列行為完全不變（向後相容）
//   - X 系列加成與五燈獎 _SCORABLE_IDS 完全獨立
// ═══════════════════════════════════════════════════════
export function calcHealth(candles, signals = []) {
  if (!candles || candles.length < 20) return null;

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume ?? 0);
  const n       = closes.length;
  const last    = closes[n - 1];

  const ma5  = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma60 = n >= 60 ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60 : null;

  const ema5  = calcEMA(closes, 5)[n - 1];
  const ema20 = calcEMA(closes, 20)[n - 1];

  const rsi   = calcRSI(closes, 14)[n - 1] ?? 50;

  const { k: kArr } = calcKD(candles, 9);
  const kVal  = kArr[n - 1] ?? 50;
  const kUp   = kVal >= (kArr[n - 2] ?? kVal);

  const vol5     = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20    = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1;

  let adxVal = null, dmiDir = 0;
  if (n >= 30) {
    const { plusDI, minusDI, adx } = calcDMI(candles, 14);
    adxVal = adx[n - 1];
    const pdi = plusDI[n - 1], mdi = minusDI[n - 1];
    if (adxVal != null && pdi != null && mdi != null) dmiDir = pdi > mdi ? 1 : -1;
  }

  const hv   = calcHV(closes, 20)[n - 1];
  const bias = calcBias(closes, 20)[n - 1];
  const psy  = calcPSY(closes, 12)[n - 1];

  let score = 50;

  // ① 趨勢 MA+EMA ±22 [v2: 28→22，避免單一維度蓋過全局]
  score += last > ma20 ? 8 : -8;
  score += ma5  > ma20 ? 6 : -6;
  if (ma60 != null) score += last > ma60 ? 5 : -5;
  score += ema5 > ema20 ? 3 : -3;

  // ② RSI ±20 [v2: 50-70 細分為 50-60(+12) / 60-70(+20)，70-80 從 +10 降 +5]
  if      (rsi >= 50 && rsi < 60) score += 12;
  else if (rsi >= 60 && rsi < 70) score += 20;
  else if (rsi >= 70 && rsi < 80) score +=  5;
  else if (rsi >= 80)             score -= 15;
  else if (rsi >= 40)             score -=  5;
  else if (rsi >= 30)             score -= 12;
  else                            score -= 20;

  // ③ KD ±15
  if      (kVal >= 50 && kVal < 80) score += 12;
  else if (kVal >= 80 && kVal < 85) score +=  4;
  else if (kVal >= 85)              score -= 10;
  else if (kVal >= 20)              score -=  6;
  else                              score -= 15;
  score += kUp ? 3 : -3;

  // ④ DMI ±12
  if (adxVal != null && adxVal >= 15) {
    if      (adxVal >= 30) score += dmiDir * 12;
    else if (adxVal >= 20) score += dmiDir *  7;
    else                   score += dmiDir *  3;
  }

  // ⑤ 量能 ±10
  if      (volRatio >= 2.0) score += 10;
  else if (volRatio >= 1.5) score +=  7;
  else if (volRatio >= 1.0) score +=  3;
  else if (volRatio >= 0.7) score -=  2;
  else                      score -=  8;

  // ⑥ HV ±8
  if (hv != null) {
    if      (hv < 15) score +=  8;
    else if (hv < 25) score +=  5;
    else if (hv < 40) score +=  0;
    else if (hv < 60) score -=  4;
    else              score -=  8;
  }

  // ⑦ 乖離率 ±4 [v2: 高乖離扣分加重；門檻從 >20/>10 改為 >15/>10]
  if (bias != null) {
    if      (bias > 15)  score -=  4;
    else if (bias > 10)  score -=  3;
    else if (bias > 5)   score -=  1;
    else if (bias < -15) score +=  3;
    else if (bias < -8)  score +=  2;
    else if (bias < -3)  score +=  1;
  }

  // ⑧ PSY ±3
  if (psy != null) {
    if      (psy < 25) score +=  3;
    else if (psy < 40) score +=  1;
    else if (psy > 75) score -=  2;
    else if (psy > 60) score +=  1;
  }

  // ── v2.8 X 系列訊號加成層 ────────────────────────────────────
  // 設計原則:
  //   ① 訊號加成是「確認強勢狀態」，不補回技術面扣分
  //   ② 與五燈獎 _SCORABLE_IDS 完全獨立，不影響燈號計分
  //   ③ 加成後上限 92（飆股爆量時不應顯示 100，保留風險提示空間）
  //   ④ 多個 X 系列同時觸發時，取最高單一加成（不累加避免雙重計算）
  //   ⑤ 沒傳 signals 或空陣列 → 完全跳過，行為與 v2.7 一致
  if (Array.isArray(signals) && signals.length > 0) {
    const X_BONUS = {
      X1: 6,  // 三軸共振（穩健型）
      X2: 8,  // 天黑請閉眼（飆股加速）
      X3: 5,  // 炒底王（V型反轉）
      X4: 4,  // 何時輪到我（族群輪動）
      X5: 5,  // 量證明一切（妖股先期，固定20天勝率65.5%）
    };
    let maxBonus = 0;
    for (const sig of signals) {
      const b = X_BONUS[sig.id];
      if (b != null && b > maxBonus) maxBonus = b;
    }
    if (maxBonus > 0) {
      score += maxBonus;
      score = Math.min(score, 92);  // 上限 92，不要顯示 100 誤導
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ═══════════════════════════════════════════════════════
// 長線健康度
// 需要 ≥120 根日K（建議 1y ≥240 根）
// fund 為 fetchFundamentals 回傳物件（可 null，基本面維度會跳過）
// ═══════════════════════════════════════════════════════
export function calcHealthLong(candles, fund = null, code = null) {
  // 優先讀 GAS 預算快照（window.__healthSnapshot），快照有值就直接回傳
  if (code && window.__healthSnapshot?.data?.[code]?.ll != null) {
    return window.__healthSnapshot.data[code].ll;
  }
  if (!candles || candles.length < 60) return null;

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume ?? 0);
  const n       = closes.length;
  const last    = closes[n - 1];

  // 合成週K / 月K
  const weeklyCandles  = _toWeeklyCandles(candles);
  const monthlyCandles = _toMonthlyCandles(candles);
  const wCloses = weeklyCandles.map(c => c.close);
  const mCloses = monthlyCandles.map(c => c.close);
  const wN = wCloses.length;
  const mN = mCloses.length;

  let score = 50;

  // ① 大趨勢結構 ±20（MA60/120/240）[v2: MA240 不足 240 根時用比例容錯]
  const ma60  = n >= 60  ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60   : null;
  const ma120 = n >= 120 ? closes.slice(-120).reduce((a, b) => a + b, 0) / 120 : null;
  const ma240 = n >= 240 ? closes.slice(-240).reduce((a, b) => a + b, 0) / 240 : null;

  // [v2] 動態年線：n<240 時用最長可用均線 + 權重比例
  // 例：n=200 → maMax=200日均線, yearlyWeight=0.83；n=240+ → 全權重
  const yearlyLen    = Math.min(n, 240);
  const maMax        = yearlyLen >= 120
    ? closes.slice(-yearlyLen).reduce((a, b) => a + b, 0) / yearlyLen
    : null;
  const yearlyWeight = yearlyLen / 240;  // 1.0 = 滿；0.5 = 半年資料

  if (ma60 != null) {
    score += last > ma60 ? 6 : -6;   // 站上季線
    if (ma120 != null) {
      score += last > ma120  ? 5 : -5;  // 站上半年線
      score += ma60 > ma120  ? 3 : -3;  // 季線 > 半年線
    }
    // [v2] 年線判定改用 maMax + 權重，不再因 n<240 整段跳過
    if (maMax != null) {
      score += (last > maMax ? 4 : -4) * yearlyWeight;
      if (ma120 != null) {
        score += (ma120 > maMax ? 2 : -2) * yearlyWeight;
      }
    }
  }

  // ② 基本面：獲利品質 ±20
  if (fund != null) {
    const eps           = fund.eps;
    const earningsGrowth = fund.earningsGrowth; // 小數，如 0.15 = 15%
    const profitMargin  = fund.profitMargin;    // 小數
    const epsSeries     = fund._epsSeries ?? [];  // [{ date, eps }]，由新到舊
    const marginSeries  = fund._marginSeries ?? []; // [{ grossMargin, netMargin }]

    // EPS 正值
    if (eps != null) {
      score += eps > 0 ? 5 : -8;
    }

    // 盈餘成長率
    if (earningsGrowth != null) {
      const eg = earningsGrowth * 100;
      if      (eg >= 20) score +=  8;
      else if (eg >= 10) score +=  5;
      else if (eg >= 0)  score +=  2;
      else if (eg >= -10) score -= 5;
      else               score -= 10; // EPS 衰退嚴重
    }

    // EPS 連續衰退（看 epsSeries 最近4季）
    if (epsSeries.length >= 4) {
      const recent = epsSeries.slice(0, 4).map(e => e.eps);
      const declining = recent[0] < recent[1] && recent[1] < recent[2] && recent[2] < recent[3];
      if (declining) score -= 15; // ⚠️ 連續衰退，長線危險
    }

    // 淨利率
    if (profitMargin != null) {
      const pm = profitMargin * 100;
      if      (pm >= 20) score +=  5;
      else if (pm >= 10) score +=  3;
      else if (pm >= 5)  score +=  1;
      else if (pm < 0)   score -=  5;
    } else if (marginSeries.length > 0) {
      // fallback: 從序列取最新
      const netM = marginSeries[0]?.netMargin;
      if (netM != null) {
        if      (netM >= 20) score +=  5;
        else if (netM >= 10) score +=  3;
        else if (netM >= 5)  score +=  1;
        else if (netM < 0)   score -=  5;
      }
    }

    // ── 月營收 ±6（MoM ±3 / YoY ±4）──
    if (fund._revenueGrowthMoM != null) {
      const mom = fund._revenueGrowthMoM * 100;
      if      (mom >= 10) score += 3;
      else if (mom >=  3) score += 1;
      else if (mom <= -10) score -= 3;
      else if (mom <=  -3) score -= 1;
    }
    if (fund._revenueGrowthYoY != null) {
      const yoy = fund._revenueGrowthYoY * 100;
      if      (yoy >= 20) score += 3;
      else if (yoy >= 10) score += 2;
      else if (yoy >=  0) score += 1;
      else if (yoy >= -10) score -= 2;
      else                 score -= 4;
    }
    // fund._revenueSeries 預留，暫不計分
  }

  // ③ 歷史百分位 ±15（1年內價格區間）
  // [v2] pct 外提，供後續高位區動能打折判定使用
  let pct = 50;
  {
    const lookback = Math.min(n, 250);
    const slice = closes.slice(-lookback);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    pct = hi > lo ? (last - lo) / (hi - lo) * 100 : 50;
    if      (pct <= 20)  score += 15;  // 1年低檔區
    else if (pct <= 35)  score += 10;
    else if (pct <= 50)  score +=  5;
    else if (pct <= 65)  score +=  0;  // 中段，中性
    else if (pct <= 80)  score -=  3;
    else if (pct <= 90)  score -=  8;  // ⚠️ 偏高
    else                 score -= 12;  // ⚠️ 追高風險
  }

  // [v2] 高位區動能打折係數（影響週K RSI / HH-HL / 月K 的「加分」維度）
  // pct > 95% 過熱：加分 × 0；pct > 88% 高位：加分 × 0.5；其餘正常
  // 扣分不打折（避免雙重懲罰，下行訊號要照舊力道）
  const momentumDiscount = pct > 95 ? 0 : pct > 88 ? 0.5 : 1.0;

  // ④ 週K RSI ±12（合成週K）[v2: 加分套高位區打折]
  if (wN >= 15) {
    const wRSI = calcRSI(wCloses, 14);
    const wRsiVal = wRSI[wN - 1];
    if (wRsiVal != null) {
      if      (wRsiVal >= 55 && wRsiVal < 75) score += 12 * momentumDiscount;
      else if (wRsiVal >= 75)                 score +=  4 * momentumDiscount; // 週線超買，謹慎
      else if (wRsiVal >= 45)                 score +=  4 * momentumDiscount;
      else if (wRsiVal >= 30)                 score -=  5; // 扣分不打折
      else                                    score -= 12; // 週線超賣，長線弱
    }
  }

  // ⑤ 波段結構 HH/HL ±10（最近30根日K）[v2: 多頭加分套高位區打折]
  {
    const seg = candles.slice(-Math.min(n, 60));
    const segH = seg.map(c => c.high ?? c.close);
    const segL = seg.map(c => c.low  ?? c.close);
    const sN = seg.length;
    if (sN >= 10) {
      // 找近兩個局部高點和低點
      const midH = segH.slice(0, Math.floor(sN / 2));
      const midL = segL.slice(0, Math.floor(sN / 2));
      const latH = segH.slice(Math.floor(sN / 2));
      const latL = segL.slice(Math.floor(sN / 2));
      const hh = Math.max(...latH) > Math.max(...midH); // 後半段高點更高
      const hl = Math.min(...latL) > Math.min(...midL); // 後半段低點更高
      const lh = Math.max(...latH) < Math.max(...midH);
      const ll = Math.min(...latL) < Math.min(...midL);
      if      (hh && hl) score += 10 * momentumDiscount; // HH+HL 完整多頭結構
      else if (hh || hl) score +=  4 * momentumDiscount; // 部分多頭
      else if (lh && ll) score -= 10; // LH+LL 空頭結構（扣分不打折）
      else if (lh || ll) score -=  4;
    }
  }

  // ⑥ 估值合理性 ±10（PE / PB / 殖利率）
  if (fund != null) {
    const pe  = fund.pe;
    const pb  = fund.pbRatio;
    const div = fund.dividendYield; // 小數

    if (pe != null && pe > 0) {
      if      (pe <= 10)  score +=  5;
      else if (pe <= 15)  score +=  3;
      else if (pe <= 25)  score +=  1;
      else if (pe <= 40)  score -=  2;
      else if (pe <= 50)  score -=  5;
      else                score -= 10; // ⚠️ PE > 50，過度高估
    }

    if (pb != null && pb > 0) {
      if      (pb <= 1.0) score +=  3;
      else if (pb <= 2.0) score +=  1;
      else if (pb <= 4.0) score +=  0;
      else                score -=  2;
    }

    if (div != null) {
      const divPct = div * 100;
      if      (divPct >= 5)  score +=  3;
      else if (divPct >= 3)  score +=  2;
      else if (divPct >= 1)  score +=  1;
      // 零殖利率不扣分（成長股特性）
    }
  }

  // ⑦ 長期量能 ±8（近半年均量 vs 1年均量）
  if (n >= 120) {
    const volHalf = volumes.slice(-60).reduce((a, b) => a + b, 0) / 60;
    const volFull = volumes.slice(-120).reduce((a, b) => a + b, 0) / 120;
    const vRatio  = volFull > 0 ? volHalf / volFull : 1;
    if      (vRatio >= 1.5) score += 8;  // 近期量能擴增（籌碼活絡）
    else if (vRatio >= 1.1) score += 4;
    else if (vRatio >= 0.9) score += 0;
    else if (vRatio >= 0.7) score -= 3;
    else                    score -= 8;  // 長期量能萎縮
  }

  // ⑧ 月K趨勢 ±5（月K站上月均線）[v2: 加分套高位區打折]
  if (mN >= 6) {
    const ma6m  = mCloses.slice(-6).reduce((a, b) => a + b, 0) / 6;
    const lastM = mCloses[mN - 1];
    // 月K收盤站上6月均線
    score += lastM > ma6m ? 3 * momentumDiscount : -3;  // 扣分不打折
    // 月K趨勢方向（最近3月）
    if (mN >= 4) {
      const slope = mCloses[mN - 1] - mCloses[mN - 4];
      score += slope > 0 ? 2 * momentumDiscount : -2;   // 扣分不打折
    }
  }

  // 月K跌破年線重扣 [v2: 改用 maMax + yearlyWeight，不要求 n>=240]
  if (mN >= 12 && maMax != null) {
    const lastMClose = mCloses[mN - 1];
    if (lastMClose < maMax) score -= 12 * yearlyWeight;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ═══════════════════════════════════════════════════════
// 快速估算版：篩選器使用，無K線
// ═══════════════════════════════════════════════════════
export function calcHealthFast(row) {
  const ind = row.indicators ?? {};
  let score = 50;
  let counted = 0;

  if (ind.aboveMA20 != null) { score += ind.aboveMA20 ? 10 : -10; counted++; }
  if (ind.ma5CrossMA20 != null) { score += ind.ma5CrossMA20 ? 6 : -4; counted++; }

  if (ind.rsi != null) {
    const rsi = ind.rsi;
    // [v2] 同步 calcHealth 的 RSI 細分區間
    if      (rsi >= 50 && rsi < 60) score += 12;
    else if (rsi >= 60 && rsi < 70) score += 20;
    else if (rsi >= 70 && rsi < 80) score +=  5;
    else if (rsi >= 80)             score -= 15;
    else if (rsi >= 40)             score -=  5;
    else if (rsi >= 30)             score -= 12;
    else                            score -= 20;
    counted++;
  }

  if (ind.kdK != null) {
    const k = ind.kdK;
    if      (k >= 50 && k < 80) score += 12;
    else if (k >= 80 && k < 85) score +=  4;
    else if (k >= 85)           score -= 10;
    else if (k >= 20)           score -=  6;
    else                        score -= 15;
    counted++;
  }

  if (ind.volSurgeRatio != null) {
    const vr = ind.volSurgeRatio;
    if      (vr >= 2.0) score += 10;
    else if (vr >= 1.5) score +=  7;
    else if (vr >= 1.0) score +=  3;
    else if (vr >= 0.7) score -=  2;
    else                score -=  8;
    counted++;
  }

  if (counted === 0) {
    const chg = row.chgPct ?? 0;
    return chg > 9 ? 55 : chg > 5 ? 60 : chg > 0 ? 55 :
           chg < -5 ? 45 : chg < -9 ? 40 : 50;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ═══════════════════════════════════════════════════════
// Badge 輔助
// ═══════════════════════════════════════════════════════
export function healthBadge(score, prefix = 'hg') {
  if (score == null) return `<span class="${prefix}-health-empty">—</span>`;
  const cls = score >= 80 ? 'strong'
            : score >= 60 ? 'mid-strong'
            : score >= 40 ? 'neutral'
            : score >= 20 ? 'mid-weak'
            :               'weak';
  return `<span class="${prefix}-health-badge ${cls}">${score}</span>`;
}

/**
 * 雙健康度 badge（短線 + 長線並排）
 * @param {number|null} shortScore  短線健康度
 * @param {number|null} longScore   長線健康度
 * @param {string}      prefix      CSS class 前綴
 */
export function healthBadgeDual(shortScore, longScore, prefix = 'hg') {
  const s = healthBadge(shortScore, prefix);
  const l = longScore != null
    ? `<span class="${prefix}-health-badge-long ${_longCls(longScore)}">${longScore}</span>`
    : `<span class="${prefix}-health-empty">—</span>`;
  return `<span class="${prefix}-health-dual">${s}<span class="${prefix}-health-sep">│</span>${l}</span>`;
}

function _longCls(score) {
  return score >= 80 ? 'strong'
       : score >= 60 ? 'mid-strong'
       : score >= 40 ? 'neutral'
       : score >= 20 ? 'mid-weak'
       :               'weak';
}

// ═══════════════════════════════════════════════════════
// 2-E 統一 API 層
// ─ getHealthScore()   統一計算入口
// ─ getYaoguLevel()    妖股等級分類
// ─ renderHealthBadge() 統一渲染（取代各模組自訂 prefix）
// ═══════════════════════════════════════════════════════

/**
 * 短線強勢分 — 統一入口（已驗證 rsClean 取代舊 calcHealth）
 *
 * 優先序：
 *   1. window.__snapshot.stocks[code].rsclean_v
 *      （GAS 夜間 _injectRSRating 算的全市場百分位，封存段 IC 0.094 > 舊短線健康度 ≈0、
 *        十分位 0.879 > 0.842；前端單股算不出橫斷面百分位，必須讀預算值）
 *   2. row.rsclean_v（若 row 直接帶）
 *   3. 舊 calcHealth(candles)（snapshot 缺才退回，盤中／假日／非母體股才會走到）
 *   4. calcHealthFast(row)
 *
 * 換引擎不換車殼：badge 容器/顏色/呼叫端全不動，只換這個分數來源。
 *
 * @param {{code?:string, row?:Object, candles?:Array, signals?:Array}} opts
 * @returns {number|null}
 */
export function shortHealthScore({ code = null, row = null, candles = null, signals = [] } = {}) {
  const snapV = code ? window.__snapshot?.stocks?.[code]?.rsclean_v : null;
  if (snapV != null) return snapV;
  if (row && row.rsclean_v != null) return row.rsclean_v;
  if (candles && candles.length >= 20) return calcHealth(candles, signals);
  if (row) return calcHealthFast(row);
  return null;
}

/**
 * 統一健康度計算入口
 * 短線走 shortHealthScore（rsClean 優先），長線優先讀 __healthSnapshot
 *
 * @param {Array}       candles  日K陣列（可 null）
 * @param {Object}      row      screener row（fallback 用）
 * @param {Array}       signals  X 系列訊號（選填）
 * @param {Object}      fund     基本面資料（選填，供 calcHealthLong 用）
 * @param {string}      code     股票代號（讀 rsclean_v / 長線快照用）
 * @returns {{ short: number|null, long: number|null }}
 */
export function getHealthScore(candles, row = null, signals = [], fund = null, code = null) {
  const short = shortHealthScore({ code, row, candles, signals });

  // 長線健康：優先讀 GAS 預算快照（window.__healthSnapshot），快照缺才本機算
  let long = null;
  if (code && window.__healthSnapshot?.data?.[code]?.ll != null) {
    long = window.__healthSnapshot.data[code].ll;
  } else if (candles && candles.length >= 120) {
    long = calcHealthLong(candles, fund);
  }

  return { short, long };
}

/**
 * 妖股等級分類
 * 根據命中的 X 系列訊號 id 陣列判斷妖股等級
 *
 * 分類邏輯（與 strategy.js X 系列定義對齊）：
 *   強妖：X2 + X1 同時命中（飆股加速 + 三軸共振）
 *   中妖：X2 alone / X1 + X5
 *   穩健型妖：X1 alone
 *   早期型妖：X5 alone
 *   無：其他
 *
 * @param {string[]} signalIds  命中的策略 id 陣列，例如 ['X1','X5']
 * @returns {{ level: string, label: string, cls: string } | null}
 */
export function getYaoguLevel(signalIds = []) {
  if (!Array.isArray(signalIds) || signalIds.length === 0) return null;
  const has = id => signalIds.includes(id);

  if (has('X2') && has('X1')) {
    return { level: 'strong',  label: '強妖',   cls: 'yaogu-strong'  };
  }
  if (has('X2') || (has('X1') && has('X5'))) {
    return { level: 'mid',     label: '中妖',   cls: 'yaogu-mid'     };
  }
  if (has('X1')) {
    return { level: 'steady',  label: '穩健型', cls: 'yaogu-steady'  };
  }
  if (has('X5')) {
    return { level: 'early',   label: '早期型', cls: 'yaogu-early'   };
  }
  return null;
}

/**
 * 統一健康度渲染
 * 不再各模組維護不同 prefix 的 CSS；統一用 hg- class
 * 舊的 healthBadge(score, prefix) 保留，不動
 *
 * @param {number|null} shortScore  短線健康度
 * @param {number|null} longScore   長線健康度（選填）
 * @param {Object}      opts
 * @param {string[]}    opts.signalIds  X 系列訊號 id（選填，顯示妖股 badge）
 * @param {boolean}     opts.compact    僅顯示短線（不含長線）
 * @returns {string}  HTML string
 */
export function renderHealthBadge(shortScore, longScore = null, opts = {}) {
  const { signalIds = [], compact = false } = opts;

  const _cls = score =>
    score >= 80 ? 'strong'
    : score >= 60 ? 'mid-strong'
    : score >= 40 ? 'neutral'
    : score >= 20 ? 'mid-weak'
    :               'weak';

  const shortHtml = shortScore != null
    ? `<span class="hg-health-badge ${_cls(shortScore)}">${shortScore}</span>`
    : `<span class="hg-health-empty">—</span>`;

  if (compact) return shortHtml;

  const longHtml = longScore != null
    ? `<span class="hg-health-badge-long ${_cls(longScore)}">${longScore}</span>`
    : `<span class="hg-health-empty">—</span>`;

  const yaogu = getYaoguLevel(signalIds);
  const yaoguHtml = yaogu
    ? `<span class="hg-yaogu-badge ${yaogu.cls}">${yaogu.label}</span>`
    : '';

  return `<span class="hg-health-dual">${shortHtml}<span class="hg-health-sep">│</span>${longHtml}${yaoguHtml}</span>`;
}
