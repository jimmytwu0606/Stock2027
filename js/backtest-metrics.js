/**
 * backtest-metrics.js — 績效指標層
 *
 * 輸入 runBacktest 的輸出 + 大盤基準 candles，產出儀表板需要的全部指標。
 *
 * export：
 *   calcMetrics({ equity, trades, dailyReturns, benchCandles, capital })
 *   → {
 *       cagr, mdd, sharpe, alpha, beta,         // 核心指標（% 或比率）
 *       benchCagr,                              // 大盤同期年化
 *       totalReturn, benchTotalReturn,          // 期間總報酬 %
 *       winRate, tradeCount, avgHoldDays,       // 逐筆統計
 *       monthlyWinRate, monthlyWins, monthlyTotal, avgMonthlyReturn,
 *       yearlyReturns: [{year, strategy, bench}],
 *       curve:      [{t, strategy, bench}],     // 累計報酬曲線（%，畫圖用）
 *       drawdown:   [{t, dd}],                  // 回檔序列（%，畫水下圖用）
 *     }
 */

const TRADING_DAYS = 252;

export function calcMetrics({ equity, trades, dailyReturns, benchCandles, capital }) {
  if (!equity?.length) throw new Error('equity 為空');

  // ── 對齊基準到 equity 的日曆（用 a 還原價）──
  const benchByTs = new Map();
  if (benchCandles?.length) {
    benchCandles.forEach(c => benchByTs.set(c.t, c.a ?? c.c));
  }
  // 基準在 equity 起日的價格（找 ≤ 起日的最近值）
  const startTs = equity[0].t;
  let benchStart = null;
  if (benchCandles?.length) {
    for (const c of benchCandles) { if (c.t <= startTs) benchStart = c.a ?? c.c; else break; }
    if (benchStart == null) benchStart = benchCandles[0].a ?? benchCandles[0].c;
  }

  // ── 累計報酬曲線 + 基準曲線 ──
  const curve = [];
  let lastBench = benchStart;
  for (const pt of equity) {
    const b = benchByTs.get(pt.t);
    if (b != null) lastBench = b;
    curve.push({
      t: pt.t,
      strategy: +((pt.value / capital - 1) * 100).toFixed(2),
      bench: benchStart && lastBench ? +((lastBench / benchStart - 1) * 100).toFixed(2) : null,
    });
  }

  // ── 總報酬 / CAGR ──
  const endValue = equity[equity.length - 1].value;
  const totalReturn = (endValue / capital - 1) * 100;
  const nDays = equity.length;
  const cagr = (Math.pow(endValue / capital, TRADING_DAYS / nDays) - 1) * 100;

  let benchTotalReturn = null, benchCagr = null;
  if (benchStart && lastBench) {
    benchTotalReturn = (lastBench / benchStart - 1) * 100;
    benchCagr = (Math.pow(lastBench / benchStart, TRADING_DAYS / nDays) - 1) * 100;
  }

  // ── MDD + 回檔序列 ──
  let peak = -Infinity, mdd = 0;
  const drawdown = [];
  for (const pt of equity) {
    peak = Math.max(peak, pt.value);
    const dd = (pt.value / peak - 1) * 100;
    mdd = Math.min(mdd, dd);
    drawdown.push({ t: pt.t, dd: +dd.toFixed(2) });
  }

  // ── Sharpe（rf=0 簡化）──
  const rs = dailyReturns.map(d => d.r);
  const mean = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length > 1 ? rs.length - 1 : 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std * Math.sqrt(TRADING_DAYS) : 0;

  // ── Beta / Alpha（需要基準日報酬）──
  let beta = null, alpha = null;
  if (benchCandles?.length) {
    const benchRetByTs = new Map();
    for (let i = 1; i < benchCandles.length; i++) {
      const p0 = benchCandles[i - 1].a ?? benchCandles[i - 1].c;
      const p1 = benchCandles[i].a ?? benchCandles[i].c;
      if (p0 > 0) benchRetByTs.set(benchCandles[i].t, p1 / p0 - 1);
    }
    const pairs = dailyReturns
      .map(d => [d.r, benchRetByTs.get(d.t)])
      .filter(([, b]) => b != null);
    if (pairs.length > 30) {
      const ms = pairs.reduce((a, [s]) => a + s, 0) / pairs.length;
      const mb = pairs.reduce((a, [, b]) => a + b, 0) / pairs.length;
      let cov = 0, varB = 0;
      for (const [s, b] of pairs) { cov += (s - ms) * (b - mb); varB += (b - mb) ** 2; }
      cov /= pairs.length - 1; varB /= pairs.length - 1;
      beta = varB > 0 ? cov / varB : 0;
      // Alpha（年化，rf=0）：策略年化 - Beta × 大盤年化
      if (benchCagr != null) alpha = cagr - beta * benchCagr;
    }
  }

  // ── 逐筆統計 ──
  const closed = trades.filter(t => t.reason !== '期末持有');
  const wins = closed.filter(t => t.retPct > 0).length;
  const winRate = closed.length ? wins / closed.length * 100 : 0;
  const avgHoldDays = closed.length ? closed.reduce((a, t) => a + t.holdDays, 0) / closed.length : 0;

  // ── 月報酬 / 月勝率 ──
  const monthly = new Map();   // 'YYYY-MM' → {first, last}
  for (const pt of equity) {
    const d = new Date(pt.t * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthly.has(key)) monthly.set(key, { first: pt.value, last: pt.value });
    else monthly.get(key).last = pt.value;
  }
  const monthlyRets = [...monthly.values()].map(m => m.last / m.first - 1);
  const monthlyWins = monthlyRets.filter(r => r > 0).length;
  const monthlyTotal = monthlyRets.length;
  const monthlyWinRate = monthlyTotal ? monthlyWins / monthlyTotal * 100 : 0;
  const avgMonthlyReturn = monthlyTotal ? monthlyRets.reduce((a, b) => a + b, 0) / monthlyTotal * 100 : 0;

  // ── 年度報酬（策略 vs 基準）──
  const yearly = new Map();    // year → {sFirst, sLast, bFirst, bLast}
  let lastB = benchStart;
  for (const pt of equity) {
    const y = new Date(pt.t * 1000).getFullYear();
    const b = benchByTs.get(pt.t);
    if (b != null) lastB = b;
    if (!yearly.has(y)) yearly.set(y, { sFirst: pt.value, sLast: pt.value, bFirst: lastB, bLast: lastB });
    else { const e = yearly.get(y); e.sLast = pt.value; e.bLast = lastB; }
  }
  const yearlyReturns = [...yearly.entries()].map(([year, e]) => ({
    year,
    strategy: +((e.sLast / e.sFirst - 1) * 100).toFixed(1),
    bench: e.bFirst && e.bLast ? +((e.bLast / e.bFirst - 1) * 100).toFixed(1) : null,
  }));

  return {
    cagr: +cagr.toFixed(1),
    mdd: +mdd.toFixed(1),
    sharpe: +sharpe.toFixed(2),
    alpha: alpha != null ? +alpha.toFixed(1) : null,
    beta: beta != null ? +beta.toFixed(2) : null,
    benchCagr: benchCagr != null ? +benchCagr.toFixed(1) : null,
    totalReturn: +totalReturn.toFixed(1),
    benchTotalReturn: benchTotalReturn != null ? +benchTotalReturn.toFixed(1) : null,
    winRate: +winRate.toFixed(1),
    tradeCount: closed.length,
    avgHoldDays: +avgHoldDays.toFixed(1),
    monthlyWinRate: +monthlyWinRate.toFixed(1),
    monthlyWins, monthlyTotal,
    avgMonthlyReturn: +avgMonthlyReturn.toFixed(2),
    yearlyReturns, curve, drawdown,
  };
}
