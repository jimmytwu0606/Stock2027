/**
 * tribunal-core.js — 策略鑑定所計算核心（純函式，無 DOM）
 *
 * 對外 API：
 *   wilsonInterval(wins, n, z?)              → { lo, hi }   勝率信賴區間
 *   calcRiskProfile({ equity, trades, dailyReturns, metrics, capital, foundTs })
 *                                            → 八維風險評估物件
 *   judgeGates(profile, metrics)             → { G1..G4, pass, fails[] }
 *
 * 設計原則（ROADMAP_ADVANCED_8 §七）：
 *   - 單一引擎：全部從同一次 runBacktest 的 equity/trades/dailyReturns 取值，不另跑回測
 *   - in-sample 分段：trades.entryTs >= foundTs−120根 視為發現窗內，分開統計
 *   - 圖文同源：水下曲線最深點 === metrics.mdd（驗收條件）
 *
 * 注意：本檔不依賴 backtest-metrics.js 既有輸出之外的東西；metrics 即 calcMetrics() 結果。
 */

const TRADING_DAYS = 252;

// ── Wilson score interval（勝率信賴區間，G4 與小樣本降灰共用）──
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n || n <= 0) return { lo: 0, hi: 0 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return {
    lo: +(Math.max(0, center - margin) * 100).toFixed(1),
    hi: +(Math.min(1, center + margin) * 100).toFixed(1),
  };
}

// ── 百分位（線性插值，與 conviction-demo quant 同口徑）──
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 八維風險評估
 * @param foundTs 發現日 timestamp（秒）；給 null 則整段視為窗外（既有策略無發現窗）
 */
export function calcRiskProfile({ equity, trades, dailyReturns, metrics, capital, foundTs = null }) {
  const closed = (trades || []).filter(t => t.retPct != null);
  const rets = closed.map(t => t.retPct);

  // ── 1. 回撤維度（深度/回復天數/水下占比）──
  // drawdown 序列已由 calcMetrics 提供：[{t, dd}]（dd 為負%）
  const dd = metrics.drawdown || [];
  let mddIdx = 0, mdd = 0;
  dd.forEach((d, i) => { if (d.dd < mdd) { mdd = d.dd; mddIdx = i; } });
  // 回復天數：MDD 之後第一次 dd 回到 0（或 >-0.5%）
  let recoverDays = null;
  for (let i = mddIdx; i < dd.length; i++) {
    if (dd[i].dd > -0.5) { recoverDays = i - mddIdx; break; }
  }
  const underwaterRatio = dd.length
    ? +(dd.filter(d => d.dd < -0.5).length / dd.length * 100).toFixed(1) : 0;

  // ── 2. 連虧維度 ──
  let maxLoseStreak = 0, cur = 0;
  closed.forEach(t => {
    if (t.retPct < 0) { cur++; maxLoseStreak = Math.max(maxLoseStreak, cur); }
    else cur = 0;
  });

  // ── 3. 左尾維度（單筆最大虧損 / P5 / P1 / 偏度）──
  const sortedRets = [...rets].sort((a, b) => a - b);
  const worstTrade = sortedRets.length ? sortedRets[0] : null;
  const p5 = quantile(sortedRets, 0.05);
  const p1 = quantile(sortedRets, 0.01);
  let skew = null;
  if (rets.length > 2) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length) || 1e-9;
    skew = +(rets.reduce((a, b) => a + ((b - m) / sd) ** 3, 0) / rets.length).toFixed(2);
  }

  // ── 4. 風險調整維度（Sortino / Calmar；Sharpe 取自 metrics）──
  const drArr = (dailyReturns || []).map(d => d.r);
  let sortino = null;
  if (drArr.length) {
    const mean = drArr.reduce((a, b) => a + b, 0) / drArr.length;
    const downside = drArr.filter(r => r < 0);
    const dStd = downside.length
      ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) : 0;
    sortino = dStd > 0 ? +(mean / dStd * Math.sqrt(TRADING_DAYS)).toFixed(2) : null;
  }
  const calmar = (metrics.mdd && metrics.mdd !== 0)
    ? +(metrics.cagr / Math.abs(metrics.mdd)).toFixed(2) : null;

  // ── 5. 市況脆弱性（依 trade entryTs 對 regime 分格；regime 由呼叫端附在 trade.regime）──
  // 若 trade 無 regime 欄位則回 null，UI 顯示「未分市況」
  const byRegime = {};
  let hasRegime = false;
  ['bull', 'bear', 'range'].forEach(r => byRegime[r] = { n: 0, wins: 0 });
  closed.forEach(t => {
    if (t.regime && byRegime[t.regime]) {
      hasRegime = true;
      byRegime[t.regime].n++;
      if (t.retPct > 0) byRegime[t.regime].wins++;
    }
  });
  const regimeStats = hasRegime ? Object.fromEntries(
    Object.entries(byRegime).map(([k, v]) => [k, {
      n: v.n,
      winRate: v.n ? +(v.wins / v.n * 100).toFixed(1) : null,
    }])
  ) : null;

  // ── 6. 過擬合維度（in-sample 占比 / 窗外樣本 / Wilson 區間）──
  const WINDOW_BARS = 120;
  let inSampleCount = 0, oosCount = 0, oosWins = 0;
  const oosRets = [];
  if (foundTs != null) {
    // 發現窗 = 發現日往前 120 交易日。以 entryTs 是否落在 [foundTs−120根, ∞) 近似
    // 交易日→秒的精確換算交給呼叫端標記 t.inSample；此處有標記就用，無則用 ts 近似
    closed.forEach(t => {
      const isIn = t.inSample != null
        ? t.inSample
        : (t.entryTs >= foundTs - WINDOW_BARS * 86400); // 粗略：120 自然日，呼叫端應覆寫
      if (isIn) inSampleCount++;
      else { oosCount++; if (t.retPct > 0) oosWins++; oosRets.push(t.retPct); }
    });
  } else {
    oosCount = closed.length; oosWins = closed.filter(t => t.retPct > 0).length;
    closed.forEach(t => oosRets.push(t.retPct));
  }
  const inSampleRatio = closed.length
    ? +(inSampleCount / closed.length * 100).toFixed(1) : 0;
  const oosWilson = wilsonInterval(oosWins, oosCount);
  const oosWinRate = oosCount ? +(oosWins / oosCount * 100).toFixed(1) : null;
  const oosAvgRet = oosRets.length
    ? +(oosRets.reduce((a, b) => a + b, 0) / oosRets.length).toFixed(2) : null;

  // ── 7. 結構性維度（低流動性占比交呼叫端；此處留位）──
  // lowLiqRatio 需 trade 帶成交量資訊，呼叫端有則填，無則 null
  const lowLiqRatio = null;

  // ── 8. 集中度維度（單一個股貢獻 / 單一年度貢獻）──
  const byCode = {};
  closed.forEach(t => { byCode[t.code] = (byCode[t.code] || 0) + t.retPct; });
  const codeContribs = Object.entries(byCode).sort((a, b) => b[1] - a[1]);
  const totalAbsRet = codeContribs.reduce((a, [, v]) => a + Math.abs(v), 0) || 1e-9;
  const topCode = codeContribs[0] || null;
  const topCodeShare = topCode
    ? +(Math.abs(topCode[1]) / totalAbsRet * 100).toFixed(1) : null;

  return {
    rets,
    drawdown: { mdd: metrics.mdd, recoverDays, underwaterRatio, mddIdx },
    streak:   { maxLoseStreak },
    leftTail: { worstTrade, p5: p5 != null ? +p5.toFixed(2) : null, p1: p1 != null ? +p1.toFixed(2) : null, skew },
    riskAdj:  { sharpe: metrics.sharpe, sortino, calmar },
    regime:   regimeStats,
    overfit:  { inSampleRatio, oosCount, oosWinRate, oosWilson, oosAvgRet },
    structure:{ lowLiqRatio },
    concentration: { topCode: topCode ? topCode[0] : null, topCodeShare },
  };
}

/**
 * G1~G4 門檻判定（軌道 A：買賣訊號策略）
 * @param profile calcRiskProfile 結果
 * @param metrics calcMetrics 結果
 * @param opts    { benchTotalReturn }  同期 TWII 總報酬（G3 用）
 */
export function judgeGates(profile, metrics, opts = {}) {
  const fails = [];

  // G1：2Y 組合回測總報酬 > 0（含費稅）
  const G1 = metrics.totalReturn > 0;
  if (!G1) fails.push(`G1 總報酬 ${metrics.totalReturn}% ≤ 0`);

  // G2：MDD > −35%
  const G2 = metrics.mdd > -35;
  if (!G2) fails.push(`G2 MDD ${metrics.mdd}% 深於 −35%`);

  // G3：純窗外段超額 > 同期大盤
  // - 無發現窗（既有策略，in-sample=0%）：窗外即整段，直接用 totalReturn vs benchTotalReturn
  // - 有發現窗（系統發現候選）：按窗外交易筆數佔比，線性拆分實際總報酬與同期大盤
  //   （不可用單筆平均複利連乘——組合回測是資金曲線，連乘 n 筆會指數爆炸失真）
  const bench = opts.benchTotalReturn ?? metrics.benchTotalReturn ?? 0;
  const ov = profile.overfit;
  let excess, excessNote = '';
  if (ov.inSampleRatio > 0 && ov.oosCount > 0 && metrics.tradeCount > 0) {
    // 窗外筆數佔比 → 同時拆分策略總報酬與大盤（同口徑相減才公平）
    const oosShare = Math.max(0.05, Math.min(1, ov.oosCount / metrics.tradeCount));
    const oosStrat = metrics.totalReturn * oosShare;
    const oosBench = bench * oosShare;
    excess = +(oosStrat - oosBench).toFixed(1);
    excessNote = '（窗外段）';
  } else {
    excess = +(metrics.totalReturn - bench).toFixed(1);
  }
  const G3 = excess > 0;
  if (!G3) fails.push(`G3 超額 ${excess}%${excessNote} ≤ 0（輸大盤）`);

  // G4：窗外勝率 Wilson 下界 > 45%
  const wlo = profile.overfit.oosWilson?.lo ?? 0;
  const G4 = wlo > 45 && profile.overfit.oosCount >= 10;
  if (!G4) {
    if (profile.overfit.oosCount < 10) fails.push(`G4 窗外樣本僅 ${profile.overfit.oosCount} 筆（< 10，信心不足）`);
    else fails.push(`G4 窗外勝率下界 ${wlo}% ≤ 45%`);
  }

  return { G1, G2, G3, G4, excess, pass: G1 && G2 && G3 && G4, fails };
}
