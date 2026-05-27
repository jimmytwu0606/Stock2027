/**
 * analysis-fullscreen.js
 * Phase 7.3 v2 — 全視窗模式深度解讀
 *
 * 設計：
 *   進入全視窗時觸發 renderFullscreenAnalysis()
 *   自動掃描 AppState.indicators 找出啟用的指標 → 渲染對應 module
 *
 * 模組化：
 *   每個指標一個 module，含：
 *     id, name, icon, candleMinLen
 *     evaluate(candles)  → { score, signal, items, raw }
 *     renderBadge()      → 小 chip HTML（K 線右上角）
 *     renderFull()       → 完整解讀 HTML（K 線下方）
 *     getTeachHTML()     → 靜態教學文字
 *     getApplicationHTML() → 實戰應用文字
 *
 * 註冊新指標：
 *   import { registerAnalysisModule } from './analysis-fullscreen.js';
 *   registerAnalysisModule({ id:'ema', ... });
 *
 * Golden Board：本檔的 IchimokuModule 為樣板，
 *   未來新增 EMA / DMI / GMMA / SAR 等指標時依此模板複製。
 *
 * export：
 *   initFullscreenAnalysis()             ← 主入口，全視窗進入時呼叫
 *   destroyFullscreenAnalysis()          ← 退出全視窗時呼叫
 *   registerAnalysisModule(module)       ← 對外註冊新指標模組
 *   refreshFullscreenAnalysis()          ← 切換週期/股票後重新渲染
 */

import { AppState } from './state.js';
import { bindAIEvents, renderAISection, loadAIResults } from './analysis-ai-prompt.js';

// ── 指標模組（各自獨立，按需引入）──
// 每個模組檔案自行 import 並呼叫 registerAnalysisModule()
// 在 index.html 以 <script type="module"> 引入即可自動註冊

// ═══════════════════════════════════════════════════════
// 模組註冊表
// ═══════════════════════════════════════════════════════
const _modules = new Map();

export function registerAnalysisModule(mod) {
  if (!mod || !mod.id) return;
  _modules.set(mod.id, mod);
}

// ═══════════════════════════════════════════════════════
// 工具：DOM 取得
// ═══════════════════════════════════════════════════════
function _miniContainer() { return document.getElementById('fsMiniBadges'); }
function _deepContainer() { return document.getElementById('fsDeepZone'); }
function _chartPanel()    { return document.getElementById('chartPanel'); }

function _legendCard()    { return document.getElementById('fsLegendCard'); }
function _legendBody()    { return document.getElementById('fsLegendBody'); }
function _legendReopen()  { return document.getElementById('fsLegendReopen'); }
function _chartArea()     { return document.querySelector('#chartPanel.fullscreen-mode .chart-area'); }

// ═══════════════════════════════════════════════════════
// 主入口：進入全視窗時呼叫
// ═══════════════════════════════════════════════════════
export function initFullscreenAnalysis() {
  refreshFullscreenAnalysis();
  _bindMiniBadgeClick();
  _bindLegendCard();
  _bindReadoutInteractive();
  // loadAIResults 已移至 refreshFullscreenAnalysis 結尾執行
  // （確保 DOM 存在後才讀取，不再用 setTimeout 猜時機）
}

// ═══════════════════════════════════════════════════════
// 退出全視窗時清掉
// ═══════════════════════════════════════════════════════
export function destroyFullscreenAnalysis() {
  const mini = _miniContainer();
  const deep = _deepContainer();
  const lb   = _legendBody();
  const bar  = document.getElementById('fsTabBar');
  if (mini) mini.innerHTML = '';
  if (deep) deep.innerHTML = '';
  if (lb)   lb.innerHTML   = '';
  if (bar)  { bar.innerHTML = ''; bar.style.display = 'none'; }
  _activeModId = null;     // 退出全視窗後重置，下次進入重新自動選
  _evalCache.clear();      // 清 evaluate 快取，下次進入重新計算（股票/週期可能已換）
  _closePopover();
}

// ═══════════════════════════════════════════════════════
// 切換週期/股票後重新渲染
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 全視窗 Tab 模式
// ─ _activeModId：當前顯示的指標 id（不動 AppState.indicators）
// ─ _evalCache：所有啟用指標的 evaluate 結果快取
//   → tab 切換只換 innerHTML，不重新計算，瞬間切換
// ─ 退出全視窗後 AppState.indicators 完整還原，副圖不受影響
// ═══════════════════════════════════════════════════════
let _activeModId = null;
let _evalCache   = new Map();  // id → { mod, evaluation, disabled, disabledReason }

// debounce flag：防止 chartRendered 短時間內觸發多次
let _refreshInFlight = false;

// ── Tab Bar 渲染（只更新 active class，不重建 DOM）──
function _renderTabBar(allMods) {
  const bar = document.getElementById('fsTabBar');
  if (!bar) return;

  if (allMods.length === 0) {
    bar.innerHTML = '';
    bar.style.display = 'none';
    return;
  }

  // 已建立過 tab bar 且數量相同 → 只更新 active class（避免 re-bind）
  const existing = bar.querySelectorAll('.fs-tab-btn');
  if (existing.length === allMods.length) {
    existing.forEach((btn, i) => {
      btn.classList.toggle('active', allMods[i].id === _activeModId);
    });
    return;
  }

  // 首次建立或指標數量改變 → 重建
  bar.style.display = 'flex';
  bar.innerHTML = allMods.map(({ id, mod, disabled, disabledReason }) => {
    const isActive = id === _activeModId;
    const cls = ['fs-tab-btn', isActive ? 'active' : '', disabled ? 'disabled' : '']
      .filter(Boolean).join(' ');
    const title = disabled ? disabledReason : mod.name;
    return `<button class="${cls}" data-tab="${id}" title="${title}" ${disabled ? 'disabled' : ''}>
      <span class="fs-tab-icon">${mod.icon}</span>
      <span class="fs-tab-label">${mod.name}</span>
      ${disabled ? '<span class="fs-tab-lock">🔒</span>' : ''}
    </button>`;
  }).join('');

  // 綁定 tab 點擊
  bar.querySelectorAll('.fs-tab-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === _activeModId) return;  // 同一個不重繪
      _activeModId = btn.dataset.tab;
      _renderTabBar(allMods);     // 只更新 active class
      _switchToActive();          // 從 cache 切換內容，不重算
    });
  });
}

// ── 從 cache 切換到當前 active module（不重新 evaluate）──
async function _switchToActive() {
  const deep = _deepContainer();
  const mini = _miniContainer();
  if (!deep) return;

  const cached = _evalCache.get(_activeModId);
  if (!cached) { deep.innerHTML = ''; return; }

  const { mod, evaluation } = cached;

  // mini badge
  if (mini) {
    mini.innerHTML = mod.renderBadge
      ? mod.renderBadge(evaluation, _activeModId)
      : _defaultBadge(mod, evaluation, _activeModId);
  }

  // deep zone — 從 cache 直接拿 HTML（首次才生成，之後直接用）
  if (!cached.html) {
    cached.html = mod.renderFull
      ? mod.renderFull(evaluation)
      : _defaultFullRender(mod, evaluation);
  }
  deep.innerHTML = `
    <section class="fs-deep-module" id="fsModule-${_activeModId}">
      ${cached.html}
    </section>
  `;

  // 圖例卡
  _renderLegend([{ id: _activeModId, mod, evaluation }]);

  // 重綁互動
  _bindWhyButtons();
  try { bindAIEvents(); } catch(e) {}
  _bindFundLoadBtn();

  // AI 快取（loadAIResults 會依 activeModId 的 section 填內容）
  if (_refreshInFlight) return;
  _refreshInFlight = true;
  try {
    await loadAIResults(AppState.activeCode);
  } catch(e) {
    console.warn('[fs-analysis] loadAIResults failed:', e);
  } finally {
    _refreshInFlight = false;
  }
}

export async function refreshFullscreenAnalysis() {
  const mini = _miniContainer();
  const deep = _deepContainer();
  if (!mini || !deep) return;

  // 非全視窗狀態不渲染
  if (!_chartPanel()?.classList.contains('fullscreen-mode')) return;

  const candles = AppState.lastCandles || [];
  if (!candles.length) {
    mini.innerHTML = '';
    deep.innerHTML = '';
    const bar = document.getElementById('fsTabBar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
    _renderLegend([]);
    return;
  }

  // ── 全部 evaluate + cache（含週期不足的標記 disabled）──
  _evalCache.clear();
  const allMods = [];
  for (const [id, mod] of _modules) {
    if (!_isModuleActive(id)) continue;
    const minLen = mod.candleMinLen || 20;
    const disabled = candles.length < minLen;
    const disabledReason = disabled
      ? `${mod.name} 需要 ≥ ${minLen} 根 K 線（目前 ${candles.length} 根，請切換至較長週期）`
      : '';

    let evaluation = { score: 0, signal: null, items: [], raw: null };
    if (!disabled) {
      try { evaluation = mod.evaluate(candles); }
      catch(e) { console.warn(`[fs-analysis] ${id} evaluate failed:`, e); }
    }

    _evalCache.set(id, { mod, evaluation, disabled, disabledReason, html: null });
    allMods.push({ id, mod, disabled, disabledReason });
  }

  if (allMods.length === 0) {
    mini.innerHTML = '';
    deep.innerHTML = '';
    const bar = document.getElementById('fsTabBar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
    _renderLegend([]);
    return;
  }

  // ── 橋接：把非 summary 的 evalCache 寫給 window.__fsEvalCache ──
  // SummaryModule 的 evaluate() 讀這個，必須在 summary 之前寫好
  window.__fsEvalCache = new Map(
    [..._evalCache.entries()].filter(([id]) => id !== 'summary')
  );
  // summary 需要重新 evaluate（此時 __fsEvalCache 已就緒）
  const _summaryCache = _evalCache.get('summary');
  if (_summaryCache && !_summaryCache.disabled) {
    try { _summaryCache.evaluation = _summaryCache.mod.evaluate(candles); }
    catch(e) { console.warn('[fs-analysis] summary evaluate failed:', e); }
    _summaryCache.html = null;  // 強制重新生成 HTML
  }

  // 確保 _activeModId 指向有效且可用的 tab
  const available = allMods.filter(m => !m.disabled);
  const stillValid = available.find(m => m.id === _activeModId);
  if (!stillValid) {
    _activeModId = (available[0] ?? allMods[0]).id;
  }

  // summary 永遠排在 Tab Bar 第一個
  const summaryIdx = allMods.findIndex(m => m.id === 'summary');
  if (summaryIdx > 0) {
    const [sumItem] = allMods.splice(summaryIdx, 1);
    allMods.unshift(sumItem);
  }

  // 渲染 tab bar
  _renderTabBar(allMods);

  // 從 cache 渲染當前 active（已 evaluate 好，直接出 HTML）
  await _switchToActive();
}

// 判定指標是否被開啟（對應 AppState.indicators 的 key）
function _isModuleActive(modId) {
  // Ichimoku → AppState.indicators.ICHI
  const keyMap = {
    ichimoku: 'ICHI',
    kd:       'KD',
    rsi:      'RSI',
    macd:     'MACD',
    ema:      'EMA',
    dmi:      'DMI',
    gmma:     'GMMA',
    sar:      'SAR',
    env:      'ENV',
    bb:       'BB',
    psy:      'PSY',
    rci:      'RCI',
    hv:       'HV',
  };
  // 型態/基本面/葛蘭碧 模組:永遠啟用(不受 indicators 開關控制)
  // 葛蘭碧 v2.6 — 沒有對應的 toolbar 開關,且讀的是 AppState.signals 不需綁定指標
  if (modId === 'pattern' || modId === 'fundamental' || modId === 'granville' || modId === 'xseries') return true;
  const stateKey = keyMap[modId];
  return stateKey ? !!AppState.indicators[stateKey] : false;
}

// 預設 badge / 預設 full（讓未提供自訂渲染的 module 也可運作）
function _defaultBadge(mod, ev, id) {
  return `<span class="fs-mini-badge" data-mod="${id}">
    <span>${mod.icon || '📊'} ${mod.name || id}</span>
  </span>`;
}
function _defaultFullRender(mod, ev) {
  return `<div class="fs-deep-module-head">
    <span class="fs-icon">${mod.icon || '📊'}</span>
    <span class="fs-title">${mod.name || mod.id}</span>
  </div>
  <div class="fs-deep-module-body">尚未實作此指標的詳細解讀</div>`;
}

// ═══════════════════════════════════════════════════════
// 互動：mini badge 點擊 → 跳到對應模組
// ═══════════════════════════════════════════════════════
function _bindMiniBadgeClick() {
  const mini = _miniContainer();
  if (!mini || mini.dataset.bound) return;
  mini.dataset.bound = '1';
  mini.addEventListener('click', (e) => {
    const badge = e.target.closest('.fs-mini-badge');
    if (!badge) return;
    const modId = badge.dataset.mod;
    // 高亮這個 badge（focus 狀態），不自動跳走，讓使用者自行滑動
    mini.querySelectorAll('.fs-mini-badge').forEach(b => b.classList.remove('focused'));
    badge.classList.add('focused');
  });
}

// ═══════════════════════════════════════════════════════
// v3：圖例卡（可拖拽 / 摺疊 / 關閉）
// ═══════════════════════════════════════════════════════
function _renderLegend(active) {
  const body = _legendBody();
  if (!body) return;

  // 蒐集所有 active module 的 legend rows
  const rows = [];
  active.forEach(({ mod, evaluation, id }) => {
    if (mod.getLegendRows) {
      const modRows = mod.getLegendRows(evaluation);
      modRows.forEach(r => rows.push({ ...r, modId: id }));
    }
  });

  if (rows.length === 0) {
    body.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px">尚未啟用指標</div>';
    return;
  }

  body.innerHTML = rows.map(r => `
    <div class="fs-legend-row" data-line="${_escapeAttr(r.id || '')}" data-mod="${_escapeAttr(r.modId)}" title="${_escapeAttr(r.tooltip || '點擊跳到詳細說明')}">
      <span class="fs-legend-swatch ${r.area ? 'is-area' : ''}" style="background:${r.color}"></span>
      <span class="fs-legend-name">${r.name}${r.value != null ? `<small>${r.value}</small>` : ''}</span>
    </div>
  `).join('');

  // 綁定點擊：高亮對應判讀項目，不自動跳走，讓使用者自行滑動
  body.querySelectorAll('.fs-legend-row').forEach(row => {
    row.addEventListener('click', () => {
      const modId  = row.dataset.mod;
      const lineId = row.dataset.line;
      // 短暫高亮對應判讀項目（不跳走）
      if (lineId) {
        const item = document.querySelector(`#fsModule-${modId} [data-line-ref="${lineId}"]`);
        if (item) {
          item.classList.add('is-pinned');
          setTimeout(() => item.classList.remove('is-pinned'), 2400);
        }
      }
    });
  });
}

function _bindLegendCard() {
  const card     = _legendCard();
  const reopen   = _legendReopen();
  const head     = card?.querySelector('.fs-legend-head');
  const btnCol   = document.getElementById('fsLegendCollapse');
  const btnClose = document.getElementById('fsLegendClose');
  if (!card || card.dataset.bound) return;
  card.dataset.bound = '1';

  // 摺疊
  btnCol?.addEventListener('click', (e) => {
    e.stopPropagation();
    card.classList.toggle('is-collapsed');
    btnCol.textContent = card.classList.contains('is-collapsed') ? '+' : '−';
  });

  // 關閉 → 顯示 reopen 按鈕
  btnClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    card.style.display = 'none';
    if (reopen) reopen.classList.add('show');
  });

  // 重開
  reopen?.addEventListener('click', () => {
    card.style.display = 'block';
    reopen.classList.remove('show');
  });

  // 拖拽（head 是握把）
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  head?.addEventListener('mousedown', (e) => {
    if (e.target.closest('.fs-legend-btn')) return; // 按鈕區不觸發
    dragging = true;
    card.classList.add('is-dragging');
    const rect = card.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;
    // 切換到 left/top 定位
    card.style.right  = 'auto';
    card.style.left   = startLeft + 'px';
    card.style.top    = startTop + 'px';
    e.preventDefault();
  });

  // 全域 mousemove / mouseup（避免拖到外面斷掉）
  if (!document._fsLegendBound) {
    document._fsLegendBound = true;
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const card = _legendCard();
      if (!card) return;
      const area = _chartArea();
      const areaRect = area?.getBoundingClientRect();
      let newLeft = startLeft + (e.clientX - startX);
      let newTop  = startTop  + (e.clientY - startY);
      // 邊界保護
      if (areaRect) {
        const cardRect = card.getBoundingClientRect();
        if (newLeft < areaRect.left + 4) newLeft = areaRect.left + 4;
        if (newTop  < areaRect.top + 4)  newTop  = areaRect.top + 4;
        if (newLeft + cardRect.width  > areaRect.right - 4) newLeft = areaRect.right - cardRect.width - 4;
        if (newTop  + cardRect.height > areaRect.bottom - 4) newTop = areaRect.bottom - cardRect.height - 4;
      }
      card.style.left = newLeft + 'px';
      card.style.top  = newTop + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const card = _legendCard();
      if (card) card.classList.remove('is-dragging');
    });
  }
}

// ═══════════════════════════════════════════════════════
// v3：判讀項目互動（點此 → K 線邊框閃爍 + pin 此項）
// ═══════════════════════════════════════════════════════
function _bindReadoutInteractive() {
  const deep = _deepContainer();
  if (!deep || deep.dataset.boundReadout) return;
  deep.dataset.boundReadout = '1';

  deep.addEventListener('click', (e) => {
    // 點 「為什麼?」單獨處理，不觸發整列互動
    if (e.target.closest('.fs-readout-why')) return;

    const item = e.target.closest('.fs-readout-item.is-interactive');
    if (!item) return;

    // toggle pin 狀態
    const wasPinned = item.classList.contains('is-pinned');
    deep.querySelectorAll('.fs-readout-item.is-pinned').forEach(i => i.classList.remove('is-pinned'));
    if (!wasPinned) {
      item.classList.add('is-pinned');
      // K 線區邊框閃爍提示
      const area = _chartArea();
      if (area) {
        area.classList.add('is-highlight');
        setTimeout(() => area.classList.remove('is-highlight'), 1200);
      }
    }
  });
}

// ═══════════════════════════════════════════════════════
// 互動：「為什麼?」popover
// ═══════════════════════════════════════════════════════
let _activePopover = null;
function _closePopover() {
  if (_activePopover) { _activePopover.remove(); _activePopover = null; }
}
// ── 全視窗基本面「載入」按鈕 ──
function _bindFundLoadBtn() {
  const btn = document.getElementById('fsFundLoadBtn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    const statusEl = document.getElementById('fsFundLoadStatus');
    const code = AppState.activeCode;
    if (!code) return;

    btn.disabled = true;
    btn.textContent = '⏳ 載入中…';
    if (statusEl) statusEl.textContent = '';

    try {
      // 動態 import（stock-tabs.js 是同層目錄）
      const { ensureFundamentals } = await import('./stock-tabs.js');
      const fund = await ensureFundamentals(code);
      if (fund) {
        window.__lastFundamentals = fund;
        if (statusEl) statusEl.textContent = '✅ 載入成功，正在重新分析…';
        // 清掉 fundamental 的 html 快取，強制重新渲染
        const fundEntry = _evalCache.get('fundamental');
        if (fundEntry) fundEntry.html = null;
        // 重跑完整分析（重新 evaluate + 渲染）
        setTimeout(() => refreshFullscreenAnalysis(), 200);
      } else {
        if (statusEl) statusEl.textContent = '⚠️ 載入失敗，請確認 FinMind Token 是否設定';
        btn.disabled = false;
        btn.textContent = '📥 重試';
      }
    } catch(e) {
      console.warn('[fs-analysis] ensureFundamentals failed:', e);
      if (statusEl) statusEl.textContent = '❌ 錯誤：' + e.message;
      btn.disabled = false;
      btn.textContent = '📥 重試';
    }
  });
}

function _bindWhyButtons() {
  document.querySelectorAll('.fs-readout-why[data-why]').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _closePopover();
      const title = btn.dataset.whyTitle || '為什麼這算這樣？';
      const body  = btn.dataset.why;
      const rect  = btn.getBoundingClientRect();
      const pop = document.createElement('div');
      pop.className = 'fs-popover';
      pop.innerHTML = `
        <button class="fs-popover-close" aria-label="關閉">✕</button>
        <div class="fs-popover-title">${title}</div>
        <div>${body}</div>
      `;
      document.body.appendChild(pop);
      // 定位：在按鈕下方，靠右對齊
      const popRect = pop.getBoundingClientRect();
      let left = rect.right - popRect.width;
      let top  = rect.bottom + 8;
      // 邊界保護
      if (left < 8) left = 8;
      if (top + popRect.height > window.innerHeight - 8) {
        top = rect.top - popRect.height - 8;
      }
      pop.style.left = left + 'px';
      pop.style.top  = top + 'px';
      _activePopover = pop;
      pop.querySelector('.fs-popover-close').addEventListener('click', _closePopover);
    });
  });
  // 點空白關閉
  if (!document._fsPopBound) {
    document._fsPopBound = true;
    document.addEventListener('click', (e) => {
      if (_activePopover && !e.target.closest('.fs-popover') && !e.target.closest('.fs-readout-why')) {
        _closePopover();
      }
    });
  }
}

// ═══════════════════════════════════════════════════════
// HTML helper：渲染一條判讀
// item = { ok: true/false, text, sub, why, whyTitle }
// ═══════════════════════════════════════════════════════
export function _renderReadoutItem(item) {
  const cls = item.ok === true ? 'is-pos' : item.ok === false ? 'is-neg' : 'is-neu';
  const check = item.ok === true ? '✅' : item.ok === false ? '⚠️' : '•';
  const why = item.why
    ? `<button class="fs-readout-why" data-why="${_escapeAttr(item.why)}" data-why-title="${_escapeAttr(item.whyTitle || '解釋')}">🔍 為什麼?</button>`
    : '';
  // v3: 若指定 lineRef，加入 is-interactive 讓使用者可點擊互動高亮
  const interactive = item.lineRef ? ' is-interactive' : '';
  const lineAttr    = item.lineRef ? ` data-line-ref="${_escapeAttr(item.lineRef)}"` : '';
  return `
    <div class="fs-readout-item ${cls}${interactive}"${lineAttr}>
      <span class="fs-check">${check}</span>
      <span class="fs-text">
        ${item.text}
        ${item.sub ? `<span class="fs-text-sub">${item.sub}</span>` : ''}
      </span>
      ${why}
    </div>
  `;
}

export function _escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ═══════════════════════════════════════════════════════
// 🌟 IchimokuModule — Golden Board
// 完整解讀：即時判讀 + 五條線詳解 + 雲帶教學 + 三大訊號 + 實戰應用
// ═══════════════════════════════════════════════════════
