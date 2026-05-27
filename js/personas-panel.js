/**
 * personas-panel.js — AI 圓桌 Tab 完整 Panel（VVVIP 限定）
 *
 * 子 Tab：
 *   🤖 AI 對話   ← placeholder，未來放燈燈對話
 *   ⚙️ 人格管理  ← 從 settings-drawer 移入
 *
 * 呼叫：
 *   main.js 切到 personas stock-tab 時呼叫 initPersonasPanel()
 *   resetPersonasPanel() → 切換個股時重置
 */

import { PERSONA_META, parseLinesFromText, buildPersonaPrompt } from './settings.js';
import { Config, saveConfig } from './config.js';
import { showToast } from './ui.js';
import { requireTier } from './auth-tier.js';

let _initialized = false;

// ─── 主入口 ───────────────────────────────────────────────────────────────
export function initPersonasPanel() {
  const panel = document.getElementById('personasPanel');
  if (!panel || _initialized) return;
  _initialized = true;

  // VVVIP 才渲染
  if (!requireTier('vvvip')) {
    panel.innerHTML = `
      <div class="pp-locked">
        <div class="pp-locked-icon">🔒</div>
        <div class="pp-locked-text">AI 圓桌為 VVVIP 專屬功能</div>
      </div>`;
    return;
  }

  panel.innerHTML = _buildHTML();
  _bindEvents(panel);
  _switchSubTab('chat', panel);
}

export function resetPersonasPanel() {
  _initialized = false;
}

// ─── HTML 骨架 ────────────────────────────────────────────────────────────
function _buildHTML() {
  const personaOpts = Object.entries(PERSONA_META)
    .map(([k, p]) => `<option value="${k}">${p.emoji ?? ''} ${p.name}（${p.sect ?? ''}）</option>`)
    .join('');

  return `
    <div class="pp-container">
      <nav class="pp-tabbar">
        <button class="pp-tab active" data-pp-tab="chat">🤖 AI 對話</button>
        <button class="pp-tab"        data-pp-tab="manage">⚙️ 人格管理</button>
      </nav>

      <!-- AI 對話 placeholder -->
      <div class="pp-panel active" id="ppChat">
        <div class="pp-placeholder">
          <div class="pp-placeholder-icon">🤖</div>
          <div class="pp-placeholder-title">AI 對話</div>
          <div class="pp-placeholder-desc">
            燈燈與各派人格的對話功能開發中<br>
            請先至「人格管理」設定各人格句型
          </div>
        </div>
      </div>

      <!-- 人格管理 -->
      <div class="pp-panel" id="ppManage">
        <div class="pp-manage-hint">
          每個人格獨立管理。複製 Prompt 給 Gemini/GPT/Claude → 拿到 JSON → 貼回來合併。<br>
          可用變數：<code>{h}</code>=健康度、<code>{chgPct}</code>=漲跌幅、<code>{pe}</code>=PE
        </div>

        <div class="pp-row">
          <label class="pp-label">選人格</label>
          <select id="ppPersonaPick" class="pp-select">${personaOpts}</select>
        </div>

        <div class="pp-row">
          <button class="pp-btn" id="ppPromptCopyBtn">📋 複製這人格的 Prompt</button>
          <span class="pp-hint" id="ppPromptHint"></span>
        </div>

        <div class="pp-row-col">
          <label class="pp-label">貼上 AI 回的 JSON</label>
          <textarea id="ppJsonInput" class="pp-textarea" rows="6"
            placeholder='["句子1", "句子2"]&#10;或&#10;{"lines":["句子1","句子2"]}'></textarea>
          <div id="ppJsonStatus" class="pp-json-status"></div>
        </div>

        <div class="pp-row pp-actions">
          <button class="pp-btn"             id="ppPreviewBtn">👁 預覽</button>
          <button class="pp-btn pp-btn-primary" id="ppMergeBtn">＋ 合併新增</button>
          <button class="pp-btn pp-btn-danger"  id="ppClearBtn">🗑 清空此人格</button>
        </div>

        <div class="pp-current">
          <div class="pp-current-head">
            <span>目前句型（<span id="ppCurrentCount">0</span>）</span>
            <span class="pp-hint">儲存於 IndexedDB，F5 後還在</span>
          </div>
          <div id="ppCurrentList" class="pp-current-list"></div>
        </div>
      </div>
    </div>
  `;
}

// ─── 事件綁定 ──────────────────────────────────────────────────────────────
function _bindEvents(panel) {
  // 子 Tab 切換
  panel.querySelectorAll('.pp-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchSubTab(btn.dataset.ppTab, panel));
  });

  // 人格選單切換
  panel.querySelector('#ppPersonaPick')?.addEventListener('change', () => {
    _refreshList(panel);
    _clearStatus(panel);
  });

  // 複製 Prompt
  panel.querySelector('#ppPromptCopyBtn')?.addEventListener('click', async () => {
    const key    = panel.querySelector('#ppPersonaPick')?.value;
    const prompt = buildPersonaPrompt(key);
    const hint   = panel.querySelector('#ppPromptHint');
    try {
      await navigator.clipboard.writeText(prompt);
      if (hint) {
        hint.textContent = `✓ 已複製 ${PERSONA_META[key]?.name} 的 Prompt，貼給 Gemini/GPT/Claude`;
        setTimeout(() => { if (hint) hint.textContent = ''; }, 4000);
      }
    } catch (_) {
      if (hint) hint.textContent = '複製失敗，請手動選取複製';
    }
  });

  // 預覽
  panel.querySelector('#ppPreviewBtn')?.addEventListener('click', () => {
    const raw    = panel.querySelector('#ppJsonInput')?.value || '';
    const status = panel.querySelector('#ppJsonStatus');
    const parsed = parseLinesFromText(raw);
    if (parsed.error) {
      if (status) { status.textContent = '✗ ' + parsed.error; status.className = 'pp-json-status err'; }
      return;
    }
    if (!parsed.lines.length) {
      if (status) { status.textContent = '⚠ 沒解析到任何句子'; status.className = 'pp-json-status err'; }
      return;
    }
    if (status) {
      status.innerHTML = `✓ 解析到 ${parsed.lines.length} 句，預覽：<br>` +
        parsed.lines.slice(0, 5).map(l => `<span class="pp-preview-line">• ${_esc(l)}</span>`).join('') +
        (parsed.lines.length > 5 ? `<br><span class="pp-hint">…還有 ${parsed.lines.length - 5} 句</span>` : '');
      status.className = 'pp-json-status ok';
    }
  });

  // 合併新增
  panel.querySelector('#ppMergeBtn')?.addEventListener('click', async () => {
    const key    = panel.querySelector('#ppPersonaPick')?.value;
    const raw    = panel.querySelector('#ppJsonInput')?.value || '';
    const status = panel.querySelector('#ppJsonStatus');
    const parsed = parseLinesFromText(raw);
    if (parsed.error) {
      if (status) { status.textContent = '✗ ' + parsed.error; status.className = 'pp-json-status err'; }
      return;
    }
    if (!parsed.lines.length) {
      if (status) { status.textContent = '⚠ 沒解析到任何句子'; status.className = 'pp-json-status err'; }
      return;
    }
    Config.personasLines = Config.personasLines ?? {};
    const existing = Array.isArray(Config.personasLines[key]) ? Config.personasLines[key] : [];
    const merged   = [...new Set([...existing, ...parsed.lines])];
    const added    = merged.length - existing.length;
    Config.personasLines[key] = merged;
    await saveConfig();
    _applyToMemory();
    panel.querySelector('#ppJsonInput').value = '';
    if (status) {
      status.textContent = `✓ ${PERSONA_META[key]?.name}：新增 ${added} 句、跳過 ${parsed.lines.length - added} 句重複`;
      status.className = 'pp-json-status ok';
    }
    showToast(`✓ ${PERSONA_META[key]?.name} +${added} 句`);
    _refreshList(panel);
  });

  // 清空
  panel.querySelector('#ppClearBtn')?.addEventListener('click', async () => {
    const key = panel.querySelector('#ppPersonaPick')?.value;
    const cur = (Config.personasLines?.[key] ?? []).length;
    if (cur === 0) { showToast('已經是空的'); return; }
    if (!confirm(`確定清空「${PERSONA_META[key]?.name}」的所有自訂句型？（共 ${cur} 句）`)) return;
    Config.personasLines = Config.personasLines ?? {};
    Config.personasLines[key] = [];
    await saveConfig();
    _applyToMemory();
    showToast(`✓ 已清空 ${PERSONA_META[key]?.name}`);
    _refreshList(panel);
  });

  _refreshList(panel);
}

// ─── 子 Tab 切換 ──────────────────────────────────────────────────────────
function _switchSubTab(tab, panel) {
  panel.querySelectorAll('.pp-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.ppTab === tab));
  panel.querySelector('#ppChat')  ?.classList.toggle('active', tab === 'chat');
  panel.querySelector('#ppManage')?.classList.toggle('active', tab === 'manage');
}

// ─── 句型清單 ──────────────────────────────────────────────────────────────
function _refreshList(panel) {
  const key   = panel.querySelector('#ppPersonaPick')?.value ?? 'deng';
  const lines = Array.isArray(Config.personasLines?.[key]) ? Config.personasLines[key] : [];
  const count = panel.querySelector('#ppCurrentCount');
  const list  = panel.querySelector('#ppCurrentList');
  if (count) count.textContent = lines.length;
  if (!list) return;
  if (!lines.length) {
    list.innerHTML = '<div class="pp-empty">尚無自訂句型 — 複製 Prompt 給 AI 拿 JSON 回來合併</div>';
    return;
  }
  list.innerHTML = lines.map((l, i) => `
    <div class="pp-line-item">
      <span class="pp-line-num">${i + 1}</span>
      <span class="pp-line-text">${_esc(l)}</span>
      <button class="pp-line-del" data-idx="${i}" title="刪除">✕</button>
    </div>`).join('');

  list.querySelectorAll('.pp-line-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const k   = panel.querySelector('#ppPersonaPick')?.value ?? 'deng';
      const idx = Number(btn.dataset.idx);
      const arr = [...(Config.personasLines?.[k] ?? [])];
      arr.splice(idx, 1);
      Config.personasLines[k] = arr;
      await saveConfig();
      _applyToMemory();
      _refreshList(panel);
    });
  });
}

function _clearStatus(panel) {
  const status = panel.querySelector('#ppJsonStatus');
  if (status) { status.textContent = ''; status.className = 'pp-json-status'; }
  const hint = panel.querySelector('#ppPromptHint');
  if (hint) hint.textContent = '';
}

function _applyToMemory() {
  const lines = Config.personasLines ?? {};
  window.__personasExtraLines = {};
  ['deng','niu','ga','aunt','quant'].forEach(id => {
    window.__personasExtraLines[id] = Array.isArray(lines[id]) ? lines[id] : [];
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
