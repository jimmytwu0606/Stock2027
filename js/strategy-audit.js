/**
 * strategy-audit.js — 策略體檢（VVVIP 限定）
 * 職責：
 *   - hub toolbar 注入 🧪 體檢按鈕（僅 VVVIP 顯示）
 *   - 用 window.__snapshot 模擬全策略命中數，診斷異常
 *   - 產出 AI 修正報告（一鍵複製，貼給 Claude 修）
 * 診斷邏輯與 console 稽核腳本同源（2026-06-11 建立）
 * 依賴：strategy.js STRATEGIES / screener.js CONDITION_DEFS + SNAP_NUMERIC + SNAPSHOT_MISSING_CONDS
 */

import { STRATEGIES } from './strategy.js';
import { CONDITION_DEFS, SNAP_NUMERIC, SNAPSHOT_MISSING_CONDS } from './screener.js';

let _lastReport = '';

// ─── 初始化 ────────────────────────────────────────────────
export function initStrategyAudit() {
  _injectButton();
  // tier 可能晚於 hub init 才就緒 → 輪詢 10 秒內補顯示
  let tries = 0;
  const t = setInterval(() => {
    _updateButtonVisibility();
    if (++tries >= 20 || window.__userTier === 'vvvip') clearInterval(t);
  }, 500);
}

function _injectButton() {
  if (document.getElementById('hubAuditBtn')) return;
  const anchor = document.getElementById('hubConfigScreener');
  if (!anchor) return;
  const btn = document.createElement('button');
  btn.id = 'hubAuditBtn';
  btn.className = 'sc-btn sc-btn-ghost hub-config-btn';
  btn.textContent = '🧪 策略體檢';
  btn.style.display = 'none';
  btn.title = '驗證所有策略是否正常運作（VVVIP）';
  btn.addEventListener('click', _openAuditModal);
  anchor.parentNode.insertBefore(btn, anchor);
  _updateButtonVisibility();
}

function _updateButtonVisibility() {
  const btn = document.getElementById('hubAuditBtn');
  if (btn) btn.style.display = window.__userTier === 'vvvip' ? '' : 'none';
}

// ─── 體檢核心 ──────────────────────────────────────────────
function _runAudit() {
  const snap = window.__snapshot?.stocks;
  if (!snap) return { error: 'snapshot 未載入，請重新整理頁面' };

  const defMap = Object.fromEntries(CONDITION_DEFS.map(d => [d.id, d]));
  const codes  = Object.keys(snap);

  // snapshot 全市場出現過的 key
  const seenKeys = new Set();
  codes.forEach(c => Object.keys(snap[c]).forEach(k => seenKeys.add(k)));

  const rows = STRATEGIES.map(st => {
    const conds = st.conditions.map(c => ({ ...c, def: defMap[c.condId] }));
    const noDef = conds.filter(c => !c.def).map(c => c.condId);
    const p3    = conds.filter(c => c.def?.phase === 3).map(c => c.condId);
    const p12   = conds.filter(c => c.def && c.def.phase !== 3);
    const inEscape = conds.some(c => SNAPSHOT_MISSING_CONDS.has(c.condId));
    const blind = p12.filter(c =>
      c.def.phase === 2 && !SNAP_NUMERIC[c.condId]
      && !SNAPSHOT_MISSING_CONDS.has(c.condId) && !seenKeys.has(c.condId)
    ).map(c => c.condId);

    let hits = 0;
    if (!noDef.length && p12.length && !inEscape) {
      for (const code of codes) {
        const sc = snap[code];
        const ok = p12.every(c => {
          const nm = SNAP_NUMERIC[c.condId];
          if (nm && typeof sc[nm.key] === 'number') {
            if (nm.limitUpExempt && sc.limit_up === true) return true;
            const v = c.value ?? c.def.default ?? 0;
            return nm.op === '<=' ? sc[nm.key] <= v : sc[nm.key] >= v;
          }
          const val = sc[c.condId];
          if (c.def.type === 'number' && typeof val === 'number') {
            const v = c.value ?? c.def.default ?? 0;
            return /_max$/.test(c.condId) ? val <= v : val >= v;
          }
          return val === true;
        });
        if (ok) hits++;
      }
    }

    const pct = hits / codes.length * 100;
    let level = 'ok', verdict = '正常';
    if (noDef.length)        { level = 'dead';  verdict = 'condId 不存在：' + noDef.join(','); }
    else if (!p12.length)    { level = 'dead';  verdict = '純基本面（無可用條件）'; }
    else if (blind.length)   { level = 'blind'; verdict = 'snapshot 盲區：' + blind.join(','); }
    else if (inEscape)       { level = 'note';  verdict = '走 K 線路徑（逃生門名單）'; }
    else if (hits === 0)     { level = 'warn';  verdict = '今日 0 命中（連續多日才異常）'; }
    else if (pct > 50 && !st.id.startsWith('W'))
                             { level = 'warn';  verdict = `命中 ${pct.toFixed(1)}%（門檻過鬆）`; }
    // W 系列為避險寬篩，崩盤日高命中是市場真相，不判過鬆

    return {
      id: st.id, name: st.name, hits, pct: pct.toFixed(1), level, verdict,
      conds: st.conditions.map(c => c.condId + (c.value !== undefined ? `=${c.value}` : '')),
    };
  });

  return { rows, total: codes.length, date: window.__snapshot?.date ?? '?' };
}

// ─── Modal ─────────────────────────────────────────────────
function _openAuditModal() {
  const result = _runAudit();
  let bg = document.getElementById('auditModalBg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'auditModalBg';
    bg.className = 'seed-modal-bg';
    document.body.appendChild(bg);
    bg.addEventListener('click', e => { if (e.target === bg) bg.style.display = 'none'; });
  }
  bg.style.display = '';

  if (result.error) {
    bg.innerHTML = `<div class="seed-modal"><div class="seed-modal-header">
      <span class="seed-modal-title">🧪 策略體檢</span>
      <button class="seed-modal-close" onclick="document.getElementById('auditModalBg').style.display='none'">✕</button>
    </div><div class="seed-modal-body" style="padding:20px">⚠ ${result.error}</div></div>`;
    return;
  }

  const { rows, total, date } = result;
  const abnormal = rows.filter(r => r.level !== 'ok' && r.level !== 'note');
  const notes    = rows.filter(r => r.level === 'note');
  const okRows   = rows.filter(r => r.level === 'ok');
  _lastReport = _buildReport(rows, total, date);

  const COLOR = { dead: '#ef5350', blind: '#fbbf24', warn: '#f59e0b', note: '#60a5fa', ok: 'var(--muted)' };
  const tr = r => `<tr>
    <td style="padding:4px 8px;font-weight:600;color:var(--accent)">${r.id}</td>
    <td style="padding:4px 8px">${r.name}</td>
    <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">${r.hits}（${r.pct}%）</td>
    <td style="padding:4px 8px;color:${COLOR[r.level]}">${r.verdict}</td>
  </tr>`;

  bg.innerHTML = `
    <div class="seed-modal" style="max-width:720px;width:92%">
      <div class="seed-modal-header">
        <span class="seed-modal-title">🧪 策略體檢 · ${date} · ${total} 檔樣本</span>
        <button class="seed-modal-close" id="auditModalClose">✕</button>
      </div>
      <div class="seed-modal-body" style="max-height:60vh;overflow-y:auto">
        <div class="seed-modal-section">
          <div class="seed-section-title" style="color:#ef5350">異常 / 待觀察（${abnormal.length}）</div>
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            ${abnormal.map(tr).join('') || '<tr><td style="padding:8px;color:var(--muted)">全部正常 🎉</td></tr>'}
          </table>
        </div>
        ${notes.length ? `<div class="seed-modal-section">
          <div class="seed-section-title" style="color:#60a5fa">K 線路徑（正常，僅速度較慢）（${notes.length}）</div>
          <table style="width:100%;font-size:12px;border-collapse:collapse">${notes.map(tr).join('')}</table>
        </div>` : ''}
        <div class="seed-modal-section">
          <div class="seed-section-title">正常（${okRows.length}）</div>
          <table style="width:100%;font-size:12px;border-collapse:collapse">${okRows.map(tr).join('')}</table>
        </div>
      </div>
      <div class="seed-modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <button class="seed-tb-btn" id="auditCopyBtn">📋 複製 AI 修正報告</button>
        <button class="seed-modal-start" id="auditRerunBtn">↺ 重新體檢</button>
      </div>
    </div>`;

  document.getElementById('auditModalClose')?.addEventListener('click', () => bg.style.display = 'none');
  document.getElementById('auditRerunBtn')?.addEventListener('click', _openAuditModal);
  document.getElementById('auditCopyBtn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(_lastReport);
      const btn = document.getElementById('auditCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => btn.textContent = '📋 複製 AI 修正報告', 1500); }
    } catch (_) {
      document.dispatchEvent(new CustomEvent('showToast', { detail: '複製失敗，請手動選取' }));
    }
  });
}

// ─── AI 修正報告 ───────────────────────────────────────────
function _buildReport(rows, total, date) {
  const abnormal = rows.filter(r => r.level !== 'ok' && r.level !== 'note');
  const lines = [
    `# dengdeng 策略體檢報告`,
    ``,
    `- 體檢時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
    `- snapshot 日期：${date}・樣本 ${total} 檔`,
    `- 策略總數：${rows.length}・異常/待觀察 ${abnormal.length}`,
    ``,
    `## 異常策略`,
    ``,
  ];
  if (!abnormal.length) {
    lines.push('（無，全部正常）');
  } else {
    abnormal.forEach(r => {
      lines.push(`### ${r.id} ${r.name}`);
      lines.push(`- 診斷：${r.verdict}`);
      lines.push(`- 今日命中：${r.hits} 檔（${r.pct}%）`);
      lines.push(`- 條件：${r.conds.join('、')}`);
      lines.push(``);
    });
  }
  lines.push(`## 全策略命中一覽`);
  lines.push(``);
  lines.push(`| 策略 | 名稱 | 命中 | % | 診斷 |`);
  lines.push(`|---|---|---|---|---|`);
  rows.forEach(r => lines.push(`| ${r.id} | ${r.name} | ${r.hits} | ${r.pct} | ${r.verdict} |`));
  lines.push(``);
  lines.push(`---`);
  lines.push(`請依以上報告判斷：哪些異常是市況因素（大跌日多頭策略歸零屬正常）、哪些是條件設計或跨系統（前端 screener.js vs GAS heatmap_calc.gs）定義漂移需要修正。需要修正的請說明根因並提供修正檔案。`);
  return lines.join('\n');
}
