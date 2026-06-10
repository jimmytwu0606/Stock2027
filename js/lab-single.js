import { resolveCode, tsToDate } from './lab-utils.js';
/**
 * lab-single.js — 單股回測子模組
 * 由 strategy-lab.js 呼叫，不對外直接 export
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { CONDITION_DEFS } from './screener.js';
import { STRATEGIES } from './strategy.js';
import { dengToast } from './loading-deng.js';


// ── 單股回測進場條件匹配 ──────────────────────────────────────────────────
function _matchStrategyAt(sliced, strategyId) {
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return false;

  const histConds = strategy.conditions.map(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    return def ? { def, value: c.value ?? def.default } : null;
  }).filter(Boolean);

  const p1Conds = histConds.filter(c => c.def.phase === 1);
  const p2Conds = histConds.filter(c => c.def.phase === 2);

  const last   = sliced[sliced.length - 1];
  const prev   = sliced[sliced.length - 2];
  const chgPct = prev?.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
  const twseRow = {
    price:  last.close,
    chgPct,
    volume: Math.round((last.volume ?? 0) / 1000),
  };

  for (const { def, value } of p1Conds) {
    try { if (!def.match(twseRow, value)) return false; } catch { return false; }
  }

  if (p2Conds.length > 0) {
    const ind = {};
    for (const { def } of p2Conds) {
      if (def.calc) {
        try { Object.assign(ind, def.calc(sliced)); } catch {}
      }
    }
    for (const { def, value } of p2Conds) {
      try { if (!def.match(ind, value)) return false; } catch { return false; }
    }
  }
  return true;
}

function _calcStrategySignals(candles, strategyId, holdDays) {
  const signals = [];
  if (!candles || candles.length < 60) return signals;

  const maxIdx = candles.length - holdDays - 1;
  const avg20vol = candles.slice(-20).reduce((s, c) => s + (c.volume ?? 0), 0) / 20 / 1000;

  for (let i = 20; i <= maxIdx; i++) {
    const sliced = candles.slice(0, i + 1);
    if (_matchStrategyAt(sliced, strategyId)) {
      const entry    = candles[i].close;
      const exit     = candles[i + holdDays].close;
      const ret      = (exit - entry) / entry * 100;
      const volK     = Math.round((candles[i].volume ?? 0) / 1000);
      const volRatio = avg20vol > 0 ? +(volK / avg20vol).toFixed(2) : 1;
      signals.push({
        date: tsToDate(candles[i].time),
        entry, exit,
        ret:      +ret.toFixed(2),
        win:      ret > 0,
        vol:      volK,
        volRatio,
      });
    }
  }
  return signals;
}

// ── 渲染單股回測結果 ───────────────────────────────────────────────────────
function _renderSingleResult(el, { code, name, strategy, holdDays, signals }) {
  if (!signals.length) {
    el.innerHTML = `<div style="color:var(--muted);padding:20px;text-align:center">此期間無進場訊號</div>`;
    return;
  }
  const wins   = signals.filter(s => s.win).length;
  const wr     = (wins / signals.length * 100).toFixed(1);
  const avgRet = (signals.reduce((s, x) => s + x.ret, 0) / signals.length).toFixed(2);
  const maxDD  = (() => {
    let peak = -Infinity, dd = 0;
    for (const s of signals) {
      if (s.ret > peak) peak = s.ret;
      if (peak - s.ret > dd) dd = peak - s.ret;
    }
    return dd.toFixed(2);
  })();

  const rows = signals.slice().reverse().map(s => `
    <tr>
      <td style="padding:5px 8px;color:var(--muted);font-size:12px">${s.date}</td>
      <td style="padding:5px 8px;text-align:right;font-size:12px">${s.entry.toFixed(2)}</td>
      <td style="padding:5px 8px;text-align:right;font-size:12px">${s.exit.toFixed(2)}</td>
      <td style="padding:5px 8px;text-align:right;font-size:12px;color:${s.win ? 'var(--down)' : 'var(--up)'};font-weight:600">
        ${s.ret > 0 ? '+' : ''}${s.ret}%
      </td>
      <td style="padding:5px 8px;text-align:right;font-size:11px;color:var(--muted)">${s.volRatio}x</td>
    </tr>`).join('');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">勝率</div>
        <div style="font-size:18px;font-weight:700;color:${parseFloat(wr)>=55?'var(--down)':'var(--up)'}">${wr}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">平均報酬</div>
        <div style="font-size:18px;font-weight:700;color:${parseFloat(avgRet)>=0?'var(--down)':'var(--up)'}">${avgRet > 0 ? '+' : ''}${avgRet}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">樣本數</div>
        <div style="font-size:18px;font-weight:700;color:var(--text)">${signals.length}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">最大回落</div>
        <div style="font-size:18px;font-weight:700;color:var(--up)">-${maxDD}%</div>
      </div>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:var(--bg2)">
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">日期</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">進場</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">出場</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">報酬</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">量比</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── 公開 API（由 strategy-lab.js 呼叫）───────────────────────────────────
export function bindSingleRun() {
  const btn = document.getElementById('labRunSingle');
  if (btn) btn.addEventListener('click', _runSingleBacktest);
}

export async function runSingleBacktestExternal(code, strategyId, holdDays) {
  return _runSingleBacktest(code, strategyId, holdDays);
}

async function _runSingleBacktest(extCode, extStrategy, extHold) {
  const inputEl    = document.getElementById('labSingleCode');
  const stratEl    = document.getElementById('labSingleStrategy');
  const holdEl     = document.getElementById('labSingleHold');
  const resultEl   = document.getElementById('labSingleResult');
  const progressEl = document.getElementById('labSingleProgress');

  const codeRaw  = extCode    ?? inputEl?.value?.trim() ?? '';
  const stratId  = extStrategy ?? stratEl?.value ?? '';
  const holdDays = extHold    ?? parseInt(holdEl?.value ?? '10');
  const code     = resolveCode(codeRaw);

  if (!code) { dengToast('請輸入有效股票代號'); return; }
  if (!stratId) { dengToast('請選擇策略'); return; }

  if (progressEl) progressEl.style.display = '';
  if (resultEl)   resultEl.innerHTML = '';

  try {
    let candles = await fetchHistoryCached(toYahooSymbol(code), '1y', { allowStale: false });
    if (!candles || candles.length < 60)
      candles = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: false }).catch(() => null);
    if (!candles || candles.length < 60) {
      dengToast('K 線資料不足，無法回測');
      return;
    }
    const name    = getChineseName(code) || code;
    const signals = _calcStrategySignals(candles, stratId, holdDays);
    if (resultEl) _renderSingleResult(resultEl, { code, name, strategy: stratId, holdDays, signals });
  } catch(e) {
    dengToast('回測失敗：' + e.message);
    console.error('[lab-single]', e);
  } finally {
    if (progressEl) progressEl.style.display = 'none';
  }
}
