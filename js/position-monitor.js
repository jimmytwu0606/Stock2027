/**
 * position-monitor.js — 庫存持倉三線監控
 *
 * 對每筆持倉計算三條風控線並輸出燈號：
 *   🔴/🟢 停損線：現價距「進場價 × (1-stopPct%)」
 *   🔴/🟢 回落停利線：現價距「持有期高點 × (1-trailPct%)」（僅獲利中啟用）
 *   🔴/🟢 市場溫度：0050 收盤 vs MA60（regime）
 *   → 三燈任一紅 = 建議出場提醒
 *
 * 用法（接 portfolio-ui.js）：
 *   import { checkPosition, checkPositions, renderMonitorBadge } from './position-monitor.js';
 *
 *   // 單筆
 *   const r = await checkPosition({ code: '6116', entryPrice: 14.2, entryDate: '2026-05-12' });
 *   el.innerHTML = renderMonitorBadge(r);
 *
 *   // 批次（庫存頁 reload 時）
 *   const results = await checkPositions([{code, entryPrice, entryDate}, ...]);
 *
 * 參數預設 stopPct=15 / trailPct=20（妖股寬版）。
 * 建議：用 lab-backtest 的「🔬 參數掃描」找出各訊號最佳參數後，
 *       依訊號別傳入不同參數（e.g. X2 用掃描結果）。
 */

import { fetchHistOne, fetchBenchmark } from './api-hist.js';

const DEFAULT_STOP  = 15;   // 停損 %
const DEFAULT_TRAIL = 20;   // 回落停利 %

let _regimeCache = null;    // { ts, riskOn }（5 分鐘快取）

// ─────────────────────────────────────────────────────────────────────────────
// 單筆持倉檢查
// ─────────────────────────────────────────────────────────────────────────────
export async function checkPosition({ code, entryPrice, entryDate, stopPct = DEFAULT_STOP, trailPct = DEFAULT_TRAIL, curPrice = null }) {
  const hist = await fetchHistOne(code);
  if (!hist?.candles?.length) {
    return { code, error: '無歷史資料', lights: {}, verdict: 'unknown' };
  }

  const entryTs = Math.floor(new Date(entryDate + 'T00:00:00+08:00').getTime() / 1000);
  const candles = hist.candles;

  // 持有期間 K 線（進場日起）
  const holding = candles.filter(c => c.t >= entryTs);
  const lastC = candles[candles.length - 1];
  const price = curPrice ?? lastC.c;            // 可傳即時價，否則用最近收盤

  // 持有期高點（用原始收盤價，與 entryPrice 同基準）
  const peak = Math.max(entryPrice, ...holding.map(c => c.c), price);

  const retPct = (price / entryPrice - 1) * 100;
  const stopLine  = entryPrice * (1 - stopPct / 100);
  const trailLine = peak * (1 - trailPct / 100);
  const fromPeakPct = (price / peak - 1) * 100;

  // 三燈判定
  const stopHit  = price <= stopLine;
  const trailHit = retPct > 0 && price <= trailLine;   // 僅獲利中啟用回落停利
  const regime   = await _checkRegime();

  const lights = {
    stop:   stopHit ? 'red' : (price <= stopLine * 1.05 ? 'yellow' : 'green'),
    trail:  trailHit ? 'red' : (retPct > 0 && price <= trailLine * 1.03 ? 'yellow' : 'green'),
    regime: regime.riskOn ? 'green' : 'red',
  };

  let verdict, verdictText;
  if (stopHit)            { verdict = 'exit';  verdictText = `🔴 跌破停損線（${stopLine.toFixed(2)}）建議出場`; }
  else if (trailHit)      { verdict = 'exit';  verdictText = `🔴 從高點回落 ${Math.abs(fromPeakPct).toFixed(1)}% 建議停利出場`; }
  else if (!regime.riskOn){ verdict = 'caution'; verdictText = `🟡 大盤轉弱（0050<MA60），收緊警戒`; }
  else                    { verdict = 'hold';  verdictText = `🟢 三線安全，續抱`; }

  return {
    code, price, entryPrice, retPct: +retPct.toFixed(2),
    peak: +peak.toFixed(2), fromPeakPct: +fromPeakPct.toFixed(2),
    stopLine: +stopLine.toFixed(2), trailLine: +trailLine.toFixed(2),
    stopPct, trailPct, lights, verdict, verdictText,
    distToStop:  +((price / stopLine - 1) * 100).toFixed(1),    // 距停損還有 %
    distToTrail: retPct > 0 ? +((price / trailLine - 1) * 100).toFixed(1) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次檢查（庫存頁用）
// ─────────────────────────────────────────────────────────────────────────────
export async function checkPositions(positions) {
  const results = [];
  for (const pos of positions) {
    try { results.push(await checkPosition(pos)); }
    catch (e) { results.push({ code: pos.code, error: e.message, lights: {}, verdict: 'unknown' }); }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染：監控徽章（塞進庫存列）
// ─────────────────────────────────────────────────────────────────────────────
export function renderMonitorBadge(r) {
  if (r.error) return `<span style="font-size:11px;color:var(--hint)">監控:—</span>`;

  const dot = c => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${
    c === 'red' ? 'var(--down)' : c === 'yellow' ? '#f59e0b' : 'var(--up)'};margin-right:2px"></span>`;

  const tip = [
    `停損線 ${r.stopLine}（距 ${r.distToStop}%）`,
    r.distToTrail != null ? `回落停利線 ${r.trailLine}（距 ${r.distToTrail}%）` : `回落停利：尚未獲利，未啟用`,
    `高點 ${r.peak}（現距 ${r.fromPeakPct}%）`,
    r.verdictText,
  ].join('&#10;');

  const color = r.verdict === 'exit' ? 'var(--down)' : r.verdict === 'caution' ? '#f59e0b' : 'var(--up)';
  const label = r.verdict === 'exit' ? '出場' : r.verdict === 'caution' ? '警戒' : '續抱';

  return `<span title="${tip}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 7px;border:1px solid ${color};border-radius:10px;color:${color};cursor:help">
    ${dot(r.lights.stop)}${dot(r.lights.trail)}${dot(r.lights.regime)} ${label}
  </span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 內部：市場溫度（0050 vs MA60，5 分鐘快取）
// ─────────────────────────────────────────────────────────────────────────────
async function _checkRegime() {
  if (_regimeCache && Date.now() - _regimeCache.ts < 5 * 60 * 1000) return _regimeCache;

  try {
    const candles = await fetchBenchmark('0050');
    if (!candles || candles.length < 65) {
      _regimeCache = { ts: Date.now(), riskOn: true };   // 無資料不擋
      return _regimeCache;
    }
    const closes = candles.map(c => c.a ?? c.c);
    const last60 = closes.slice(-60);
    const ma60 = last60.reduce((a, b) => a + b, 0) / 60;
    _regimeCache = { ts: Date.now(), riskOn: closes[closes.length - 1] > ma60, ma60: +ma60.toFixed(2) };
  } catch {
    _regimeCache = { ts: Date.now(), riskOn: true };
  }
  return _regimeCache;
}
