import { tsToDate, COMPARE_STRATEGIES } from './lab-utils.js';
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
  if (btn) btn.addEventListener('click', () => _runSingleAll());
  // Enter 直接觸發
  document.getElementById('labCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _runSingleAll();
  });
}

export async function runSingleBacktestExternal(code) {
  const inp = document.getElementById('labCodeInput');
  if (inp) inp.value = code;
  return _runSingleAll();
}

// 代號或股名模糊比對
function _resolveCodeFuzzy(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4,6}$/.test(s)) return s;
  const nc = window.__nameCache;
  if (nc?.entries) {
    // 完全相符優先，其次包含
    let partial = null;
    for (const [code, name] of nc.entries()) {
      if (!name) continue;
      if (name === s) return code;
      if (!partial && name.includes(s)) partial = code;
    }
    return partial;
  }
  return null;
}

const _HOLD_OPTIONS = [5, 10, 15, 20, 30, 60];

async function _runSingleAll() {
  const inputEl  = document.getElementById('labCodeInput');
  const resultEl = document.getElementById('labSingleResult');
  const emptyEl  = document.getElementById('labSingleEmpty');
  const runBtn   = document.getElementById('labRunSingle');

  const code = _resolveCodeFuzzy(inputEl?.value);
  if (!code) { dengToast('請輸入有效股票代號或股名'); return; }

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '分析中…'; }
  if (emptyEl) emptyEl.style.display = 'none';
  if (resultEl) {
    resultEl.style.display = '';
    resultEl.innerHTML = '<div style="color:var(--muted);padding:20px">讀取 K 線中…</div>';
  }

  try {
    let candles = await fetchHistoryCached(toYahooSymbol(code), '1y', { allowStale: true });
    if (!candles || candles.length < 60)
      candles = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: true }).catch(() => null);
    if (!candles || candles.length < 60) {
      if (resultEl) resultEl.innerHTML = '<div style="color:var(--muted);padding:20px">K 線資料不足，無法回測</div>';
      return;
    }

    const name = getChineseName(code) || code;
    const stratList = COMPARE_STRATEGIES
      .map(id => STRATEGIES.find(st => st.id === id))
      .filter(Boolean);

    // 全策略 × 全持有天數：每策略只匹配一次進場點，各持有天數共用
    const rows = [];
    for (let si = 0; si < stratList.length; si++) {
      const st = stratList[si];
      if (resultEl && si % 5 === 0) {
        resultEl.innerHTML = `<div style="color:var(--muted);padding:20px">分析中… ${si}/${stratList.length} 策略</div>`;
        await new Promise(r => setTimeout(r, 0));
      }

      // 進場點（最大持有天數需保留出場空間）
      const maxHold = Math.max(..._HOLD_OPTIONS);
      const entryIdx = [];
      const maxIdx = candles.length - 6;  // 至少 5 日出場空間
      for (let i = 20; i <= maxIdx; i++) {
        if (_matchStrategyAt(candles.slice(0, i + 1), st.id)) entryIdx.push(i);
      }
      if (!entryIdx.length) continue;

      // 各持有天數績效，取均報最佳
      let best = null;
      for (const hold of _HOLD_OPTIONS) {
        const sigs = [];
        for (const i of entryIdx) {
          const exitIdx = i + hold;
          if (exitIdx >= candles.length) continue;
          const ret = (candles[exitIdx].close - candles[i].close) / candles[i].close * 100;
          sigs.push({ ret, win: ret > 0, date: tsToDate(candles[i].time) });
        }
        if (!sigs.length) continue;
        const wins   = sigs.filter(x => x.win).length;
        const wr     = +(wins / sigs.length * 100).toFixed(1);
        const avgRet = +(sigs.reduce((a, x) => a + x.ret, 0) / sigs.length).toFixed(2);
        if (!best || avgRet > best.avgRet) {
          best = { hold, wr, avgRet, cnt: sigs.length,
                   first: sigs[0].date, last: sigs[sigs.length - 1].date };
        }
      }
      if (best) rows.push({ id: st.id, name: st.name, icon: st.icon ?? '', ...best });
    }

    _renderAllResult(resultEl, { code, name, rows });
  } catch (e) {
    dengToast('回測失敗：' + e.message);
    console.error('[lab-single]', e);
  } finally {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ 開始分析'; }
  }
}

// ── 渲染：全策略結果表 ─────────────────────────────────────────────────────
function _renderAllResult(el, { code, name, rows }) {
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">近一年無任何策略進場訊號</div>';
    return;
  }
  rows.sort((a, b) => b.wr - a.wr || b.avgRet - a.avgRet);
  const top = rows[0];

  const _recentColor = d => {
    if (!d || d === '—') return 'var(--muted)';
    const days = (Date.now() - new Date(d.replace(/\//g, '-')).getTime()) / 86400000;
    return days <= 30 ? '#ef5350' : days <= 90 ? '#f0b429' : 'var(--muted)';
  };

  const trs = rows.map((r, i) => `
    <tr>
      <td style="padding:5px 8px;color:var(--muted);font-size:12px">${i + 1}</td>
      <td style="padding:5px 8px;font-size:12px;white-space:nowrap"><span style="color:var(--accent)">${r.id}</span> <span style="color:var(--text)">${r.name}</span></td>
      <td style="padding:5px 8px;text-align:right;font-size:12px;color:var(--text)">${r.hold}日</td>
      <td style="padding:5px 8px;text-align:right;font-size:12px;font-weight:600;color:${r.wr >= 70 ? '#ef5350' : r.wr >= 50 ? '#f0b429' : 'var(--text)'}">${r.wr}%</td>
      <td style="padding:5px 8px;text-align:right;font-size:12px;font-weight:600;color:${r.avgRet >= 0 ? '#ef5350' : '#26a69a'}">${r.avgRet >= 0 ? '+' : ''}${r.avgRet}%</td>
      <td style="padding:5px 8px;text-align:right;font-size:12px;color:var(--text)">${r.cnt}</td>
      <td style="padding:5px 8px;text-align:right;font-size:11px;color:var(--muted);white-space:nowrap">${r.first}</td>
      <td style="padding:5px 8px;text-align:right;font-size:11px;white-space:nowrap;color:${_recentColor(r.last)}">${r.last}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
      <span style="font-size:15px;font-weight:600;color:var(--text)">${code} ${name}</span>
      <span style="font-size:12px;color:var(--muted)">全策略 × 持有 5/10/15/20/30/60 日，自動取各策略最佳持有</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">最佳策略</div>
        <div style="font-size:15px;font-weight:700;color:var(--accent)">${top.id} ${top.name}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">勝率（最佳）</div>
        <div style="font-size:18px;font-weight:700;color:${top.wr >= 55 ? '#ef5350' : '#26a69a'}">${top.wr}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">平均報酬（最佳）</div>
        <div style="font-size:18px;font-weight:700;color:${top.avgRet >= 0 ? '#ef5350' : '#26a69a'}">${top.avgRet >= 0 ? '+' : ''}${top.avgRet}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">有效策略數</div>
        <div style="font-size:18px;font-weight:700;color:var(--text)">${rows.length}</div>
      </div>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:var(--bg2)">
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">#</th>
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">策略</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">最佳持有</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">勝率</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">平均報酬</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">樣本</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">首次觸發</th>
            <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">近期觸發</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
    <div class="lab-result-hint" style="margin-top:8px">近期觸發：紅 ≤30 日、橙 ≤90 日</div>`;
}
