/**
 * theme-ui.js — Phase 9 題材 Tab UI（使用者自訂版）
 * 功能：瀏覽題材（三種檢視）、新增/編輯/刪除題材、管理個股、健康度
 */

import { saveUserTheme, deleteUserTheme, reloadThemes } from './theme.js';
import { loadHealthCacheBatch, saveHealthCache, getAllSignalsCache, getKlineCache } from './db.js';
import { resolveYahooSymbol, getChineseName } from './api.js';
import { calcHealth, calcHealthLong, healthBadge, healthBadgeDual } from './health.js';
import { fsGetShared, fsSetShared } from './firebase.js';
import { scanOneCode } from './signal-scan.js';
import { currentTier } from './auth-tier.js';

// ── 顏色 Map ─────────────────────────────────────────────────
const COLORS = {
  blue:   { bg: 'rgba(59,130,246,0.12)',  border: '#3b82f6', text: '#93c5fd' },
  green:  { bg: 'rgba(34,197,94,0.12)',   border: '#22c55e', text: '#86efac' },
  red:    { bg: 'rgba(239,68,68,0.12)',   border: '#ef4444', text: '#fca5a5' },
  yellow: { bg: 'rgba(234,179,8,0.12)',   border: '#eab308', text: '#fde047' },
  purple: { bg: 'rgba(168,85,247,0.12)',  border: '#a855f7', text: '#d8b4fe' },
  orange: { bg: 'rgba(249,115,22,0.12)',  border: '#f97316', text: '#fdba74' },
  cyan:   { bg: 'rgba(6,182,212,0.12)',   border: '#06b6d4', text: '#67e8f9' },
  gray:   { bg: 'rgba(107,114,128,0.12)', border: '#6b7280', text: '#9ca3af' },
};
const COLOR_KEYS = Object.keys(COLORS);
function gc(key) { return COLORS[key] ?? COLORS.gray; }
function genId() { return 'theme_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

// ── 狀態 ─────────────────────────────────────────────────────
let _activeIdx  = 0;
let _viewMode   = 'compact';   // 'compact' | 'detail' | 'table'
let _sortCol    = null;        // 排序欄位
let _sortAsc    = false;       // 小卡固定降冪
const _SORT_CYCLE  = [null, 'chg', 'price', 'hs', 'hl'];
const _SORT_LABELS = { chg: '漲跌幅▼', price: '股價▼', hs: '短線▼', hl: '長線▼' };
let _healthMap  = new Map();   // code → { healthShort, healthLong }
let _yaoguMap   = new Map();   // code → { x1, x2, x5, strongest }
let _hotSet     = new Set();   // 前日漲停 code Set
let _hotToday   = new Set();   // 今日漲停 code Set（盤中偵測）
let _hotDate    = null;        // 強勢資料日期

// ── 健康度工具（直接用 health.js export）────────────────────
// healthBadge(score, prefix) / healthBadgeDual(hs, hl, prefix) 已 import

// ── 撥盤狀態（四撥盤新增）────────────────────────────────────
let _activePanel = 'custom';   // 'passive' | 'active' | 'custom' | 'admin'
let _etfPassive  = null;       // 快取，null 表示未載入
let _etfActive   = null;
const ETF_PASSIVE_KEY = 'etf/passive';
const ETF_ACTIVE_KEY  = 'etf/active';

// ── 主入口 ───────────────────────────────────────────────────
export function renderThemePanel() {
  const container = document.getElementById('tabTheme');
  if (!container) return;

  const isVvvip = currentTier === 'vvvip';

  // 外層：四撥盤切換列 + 內容區
  container.innerHTML = `
    <div class="theme-outer">
      <div class="theme-panel-switcher">
        <button class="theme-psw-btn ${_activePanel==='passive'?'active':''}" data-panel="passive">📊 被動型ETF</button>
        <button class="theme-psw-btn ${_activePanel==='active' ?'active':''}" data-panel="active">🎯 主動型ETF</button>
        <button class="theme-psw-btn ${_activePanel==='custom' ?'active':''}" data-panel="custom">🏷️ 自訂題材</button>
        ${isVvvip ? `<button class="theme-psw-btn theme-psw-btn--admin ${_activePanel==='admin'?'active':''}" data-panel="admin">⚙️ 管理員</button>` : ''}
      </div>
      <div class="theme-panel-content" id="themePanelContent"></div>
    </div>`;

  // 綁定撥盤切換
  container.querySelectorAll('.theme-psw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.theme-psw-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activePanel = btn.dataset.panel;
      _renderActivePanel();
    });
  });

  _renderActivePanel();
}

// ── 撥盤分派 ─────────────────────────────────────────────────
function _renderActivePanel() {
  const content = document.getElementById('themePanelContent');
  if (!content) return;
  switch (_activePanel) {
    case 'passive': _renderEtfPanelInner(content, 'passive'); break;
    case 'active':  _renderEtfPanelInner(content, 'active');  break;
    case 'custom':  _renderCustomPanelInner(content); break;
    case 'admin':   _renderAdminPanelInner(content); break;
  }
}

// ── 自訂題材撥盤（原本的 theme-layout 搬進來）────────────────
function _renderCustomPanelInner(content) {
  const { themes = [], stockThemeMap = new Map() } = window.__themeData ?? {};
  if (_activeIdx > themes.length) _activeIdx = 0;

  content.innerHTML = `
    <div class="theme-layout">
      <div class="theme-header">
        <div>
          <div class="theme-header-label">THEME TRACKER</div>
          <div class="theme-header-title">題材追蹤</div>
        </div>
        <div class="theme-header-actions">
          <span class="theme-header-count" id="themeHeaderCount"></span>
          <button class="theme-search-stock-btn" id="themeSearchStockBtn">🔍 以個股搜尋題材</button>
          <button class="theme-yaogu-scan-btn" id="themeYaoguScanBtn">🚀 妖股查詢</button>
          <button class="theme-add-btn" id="themeAddBtn">＋ 新增題材</button>
        </div>
      </div>
      <div id="themeHotBanner" style="display:none"></div>
      <div class="theme-tabbar-wrap">
        <div class="theme-tabbar-fade theme-tabbar-fade--left"  id="themeTabFadeL"></div>
        <div class="theme-tabbar" id="themeTabBar"></div>
        <div class="theme-tabbar-fade theme-tabbar-fade--right" id="themeTabFadeR"></div>
      </div>
      <div class="theme-content" id="themeContent"></div>
    </div>`;

  document.getElementById('themeAddBtn').addEventListener('click', () => _openThemeEditor(null));
  document.getElementById('themeSearchStockBtn').addEventListener('click', () => _openStockSearchModal());
  document.getElementById('themeYaoguScanBtn').addEventListener('click', () => _openYaoguScanModal());
  _renderTabBar(themes, stockThemeMap);
  _showTab(_activeIdx, themes, stockThemeMap);
}

// ── ETF 撥盤（被動/主動共用）────────────────────────────────
// ETF 資料轉換成 theme 格式，複用原本 _renderStocks 渲染
const ETF_COLORS = ['blue', 'cyan', 'green', 'purple', 'orange', 'yellow', 'red', 'gray'];
let _etfActiveIdx = { passive: 0, active: 0 };

async function _renderEtfPanelInner(content, type) {
  content.innerHTML = `<div class="theme-etf-loading">載入中…</div>`;

  let etfList = type === 'passive' ? _etfPassive : _etfActive;

  // 首次載入
  if (etfList === null) {
    try {
      const key = type === 'passive' ? ETF_PASSIVE_KEY : ETF_ACTIVE_KEY;
      const data = await fsGetShared(key);
      etfList = Array.isArray(data) ? data : [];
    } catch(e) {
      etfList = [];
    }
    if (type === 'passive') _etfPassive = etfList;
    else                    _etfActive  = etfList;
  }

  if (!etfList.length) {
    content.innerHTML = `<div class="theme-empty-state">
      <div class="theme-empty-icon">${type === 'passive' ? '📊' : '🎯'}</div>
      <div class="theme-empty-title">${type === 'passive' ? '被動型' : '主動型'} ETF 成份股尚未設定</div>
      ${type === 'active' && currentTier === 'vvvip' ? '<div class="theme-empty-desc">請切換到「管理員」撥盤匯入</div>' : ''}
    </div>`;
    return;
  }

  // ETF → theme 格式轉換
  const themes = etfList.map((etf, i) => ({
    id:     `etf_${etf.etfCode}`,
    emoji:  type === 'passive' ? '📊' : '🎯',
    name:   `${etf.etfCode} ${etf.etfName}`,
    color:  ETF_COLORS[i % ETF_COLORS.length],
    desc:   `${type === 'passive' ? '被動型' : '主動型'} ETF — ${etf.etfCode} ${etf.etfName}`,
    stocks: etf.stocks ?? [],
  }));

  const stockThemeMap = new Map();
  themes.forEach((t, ti) => {
    (t.stocks ?? []).forEach(s => {
      if (!stockThemeMap.has(s.code)) stockThemeMap.set(s.code, new Set());
      stockThemeMap.get(s.code).add(ti);
    });
  });

  let activeIdx = Math.min(_etfActiveIdx[type], themes.length - 1);

  // 渲染外框（跟 _renderCustomPanelInner 同結構）
  content.innerHTML = `
    <div class="theme-layout">
      <div class="theme-header">
        <div>
          <div class="theme-header-label">${type === 'passive' ? 'PASSIVE ETF' : 'ACTIVE ETF'}</div>
          <div class="theme-header-title">${type === 'passive' ? '被動型 ETF' : '主動型 ETF'}</div>
        </div>
        <div class="theme-header-actions">
          <span class="theme-header-count" id="themeHeaderCount"></span>
        </div>
      </div>
      <div class="theme-tabbar-wrap">
        <div class="theme-tabbar-fade theme-tabbar-fade--left"  id="themeTabFadeL"></div>
        <div class="theme-tabbar" id="themeTabBar"></div>
        <div class="theme-tabbar-fade theme-tabbar-fade--right" id="themeTabFadeR"></div>
      </div>
      <div class="theme-content" id="themeContent"></div>
    </div>`;

  // Tab Bar（複用 _renderTabBar 邏輯，但不含關聯Tab）
  const bar = document.getElementById('themeTabBar');
  let tabHtml = '';
  themes.forEach((t, i) => {
    const c = gc(t.color);
    tabHtml += `<button class="theme-tab-btn ${i === activeIdx ? 'active' : ''}" data-idx="${i}"
      style="--t-border:${c.border};--t-text:${c.text};--t-bg:${c.bg}">
      <span class="theme-tab-emoji">${t.emoji}</span>
      <span class="theme-tab-name">${t.name}</span>
      <span class="theme-tab-count">${t.stocks.length}</span>
    </button>`;
  });
  bar.innerHTML = tabHtml;

  const themeContent = document.getElementById('themeContent');

  bar.querySelectorAll('.theme-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeIdx = +btn.dataset.idx;
      _etfActiveIdx[type] = activeIdx;
      _sortCol = null; _sortAsc = false;
      bar.querySelectorAll('.theme-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.scrollIntoView({ inline: 'center', behavior: 'smooth' });
      _renderStocks(themeContent, themes[activeIdx], activeIdx, themes, stockThemeMap, true);
    });
  });

  // 漸層 + 滾輪
  requestAnimationFrame(() => {
    bar.querySelector('.theme-tab-btn.active')?.scrollIntoView({ inline: 'center', behavior: 'instant' });
    _updateTabFade(bar);
  });
  bar.addEventListener('scroll', () => _updateTabFade(bar), { passive: true });
  bar.addEventListener('wheel', e => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    bar.scrollLeft += e.deltaY * 0.8;
    _updateTabFade(bar);
  }, { passive: false });

  // 渲染第一個 ETF
  _renderStocks(themeContent, themes[activeIdx], activeIdx, themes, stockThemeMap, true);
}

// ── 管理員撥盤 ───────────────────────────────────────────────
// adminType: 'active' | 'passive'，預設 active
let _adminType = 'active';

function _renderAdminPanelInner(content) {
  if (currentTier !== 'vvvip') {
    content.innerHTML = `<div class="theme-empty-state"><div class="theme-empty-icon">🔒</div><div class="theme-empty-title">無權限</div></div>`;
    return;
  }
  _renderAdminBody(content, _adminType);
}

function _renderAdminBody(content, type) {
  _adminType = type;
  const isActive  = type === 'active';
  const etfList   = (isActive ? _etfActive : _etfPassive) ?? [];
  const fsKey     = isActive ? ETF_ACTIVE_KEY : ETF_PASSIVE_KEY;
  const typeLabel = isActive ? '主動型' : '被動型';
  const placeholder = isActive ? '代號，如 00981A' : '代號，如 0050';

  let _editingCode  = null;
  let _pendingStocks = null;

  content.innerHTML = `
  <div class="theme-admin-panel">
    <div class="theme-admin-title">⚙️ ETF 成份股管理</div>

    <!-- 被動/主動切換 -->
    <div class="theme-admin-type-tabs">
      <button class="theme-admin-type-btn ${!isActive?'active':''}" data-type="passive">📊 被動型ETF</button>
      <button class="theme-admin-type-btn ${isActive?'active':''}"  data-type="active">🎯 主動型ETF</button>
    </div>

    <div class="theme-admin-section">
      <div class="theme-admin-label">選擇 ${typeLabel} ETF</div>
      <div class="theme-admin-etf-btns" id="adminEtfBtns">
        ${etfList.map(e => `<button class="theme-admin-etf-btn" data-etf="${e.etfCode}">${e.etfCode} ${e.etfName}</button>`).join('')}
        <button class="theme-admin-etf-btn theme-admin-etf-new" id="adminNewEtfBtn">＋ 新增ETF</button>
      </div>
    </div>

    <div class="theme-admin-section" id="adminNewEtfForm" style="display:none">
      <div class="theme-admin-label">新增 ${typeLabel} ETF</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="theme-admin-input" id="adminEtfCode" placeholder="${placeholder}" maxlength="8">
        <input class="theme-admin-input" id="adminEtfName" placeholder="名稱" maxlength="30">
        <button class="tm-btn" id="adminEtfCreate">建立</button>
      </div>
    </div>

    <div id="adminStockEditor" style="display:none">
      <div class="theme-admin-section">
        <div class="theme-admin-label">
          編輯：<strong id="adminEditingLabel"></strong>
          <button class="tm-btn tm-btn--danger" id="adminDelEtfBtn" style="margin-left:8px;font-size:11px;padding:2px 8px">刪除此ETF</button>
        </div>
        <div class="theme-admin-label" style="margin-top:12px;font-size:11px;color:var(--muted)">
          貼入 JSON / 表格複製 / 代號+股名 / 純代號 — 自動解析，取代現有名單
        </div>
        <textarea class="theme-admin-textarea" id="adminImportText"
          placeholder='支援所有格式，直接貼上即可'></textarea>
        <button class="tm-btn" id="adminImportBtn">🔍 解析預覽</button>
      </div>

      <div class="theme-admin-section" id="adminDiffArea" style="display:none">
        <div class="theme-admin-label">差異比較</div>
        <div id="adminDiffContent"></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="tm-btn" id="adminConfirmBtn">✅ 確認匯入</button>
          <button class="tm-btn tm-btn--cancel" id="adminCancelBtn">取消</button>
        </div>
      </div>

      <div class="theme-admin-section">
        <div class="theme-admin-label">現有成份股</div>
        <div class="theme-admin-stocks-wrap" id="adminCurrentStocks"></div>
      </div>
    </div>
  </div>`;

  // ── 被動/主動切換 ──
  content.querySelectorAll('.theme-admin-type-btn').forEach(btn => {
    btn.addEventListener('click', () => _renderAdminBody(content, btn.dataset.type));
  });

  // ── ETF 選擇 ──
  content.querySelectorAll('.theme-admin-etf-btn:not(#adminNewEtfBtn)').forEach(btn => {
    btn.addEventListener('click', () => { _editingCode = btn.dataset.etf; _showEditor(); });
  });

  document.getElementById('adminNewEtfBtn')?.addEventListener('click', () => {
    const f = document.getElementById('adminNewEtfForm');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });

  // ── 建立新 ETF ──
  document.getElementById('adminEtfCreate')?.addEventListener('click', async () => {
    const code = document.getElementById('adminEtfCode')?.value.trim().toUpperCase();
    const name = document.getElementById('adminEtfName')?.value.trim();
    if (!code || !name) return alert('請輸入代號和名稱');
    const list = isActive ? _etfActive : _etfPassive;
    if ((list ?? []).find(e => e.etfCode === code)) return alert('此ETF已存在');
    const newEntry = { etfCode: code, etfName: name, stocks: [], updatedAt: Date.now() };
    if (isActive) { if (!_etfActive) _etfActive = []; _etfActive.push(newEntry); }
    else          { if (!_etfPassive) _etfPassive = []; _etfPassive.push(newEntry); }
    await fsSetShared(fsKey, isActive ? _etfActive : _etfPassive);
    _renderAdminBody(content, type);
  });

  // ── 解析匯入 ──
  document.getElementById('adminImportBtn')?.addEventListener('click', () => {
    if (!_editingCode) return alert('請先選擇 ETF');
    const text = document.getElementById('adminImportText')?.value.trim();
    if (!text) return;
    _pendingStocks = _parseEtfImport(text);
    if (!_pendingStocks.length) return alert('解析失敗，請確認格式');

    const list     = (isActive ? _etfActive : _etfPassive) ?? [];
    const etf      = list.find(e => e.etfCode === _editingCode);
    const oldCodes = new Set((etf?.stocks ?? []).map(s => s.code));
    const newCodes = new Set(_pendingStocks.map(s => s.code));
    const added    = _pendingStocks.filter(s => !oldCodes.has(s.code));
    const removed  = (etf?.stocks ?? []).filter(s => !newCodes.has(s.code));
    const kept     = _pendingStocks.filter(s => oldCodes.has(s.code));

    document.getElementById('adminDiffArea').style.display = 'block';
    document.getElementById('adminDiffContent').innerHTML = `
      <div style="font-size:13px;margin-bottom:8px">
        新增 <span style="color:var(--up);font-weight:600">${added.length} 檔</span>　
        剔除 <span style="color:var(--down);font-weight:600">${removed.length} 檔</span>　
        維持 <span style="color:var(--muted)">${kept.length} 檔</span>
        ${_pendingStocks.length !== added.length + kept.length ? `<span style="color:var(--muted);font-size:11px">（已去重）</span>` : ''}
      </div>
      ${added.length ? `<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--up);margin-bottom:4px">＋ 新增</div>${added.map(s=>`<span class="theme-admin-diff-tag theme-admin-diff-tag--add">${s.code} ${s.name}</span>`).join('')}</div>` : ''}
      ${removed.length ? `<div><div style="font-size:11px;color:var(--down);margin-bottom:4px">－ 剔除（確認後將從名單移除）</div>${removed.map(s=>`<span class="theme-admin-diff-tag theme-admin-diff-tag--del">${s.code} ${s.name}</span>`).join('')}</div>` : ''}`;
  });

  // ── 確認匯入 ──
  document.getElementById('adminConfirmBtn')?.addEventListener('click', async () => {
    if (!_pendingStocks || !_editingCode) return;
    const list = isActive ? _etfActive : _etfPassive;
    if (!list) return;
    const idx = list.findIndex(e => e.etfCode === _editingCode);
    if (idx < 0) return;
    list[idx].stocks    = _pendingStocks;
    list[idx].updatedAt = Date.now();
    await fsSetShared(fsKey, list);
    // 清除對應撥盤快取，下次切過去會重新載入
    if (isActive) _etfActive = list; else _etfPassive = list;
    document.getElementById('adminDiffArea').style.display = 'none';
    document.getElementById('adminImportText').value = '';
    _pendingStocks = null;
    _showEditor();
    _toast(`✅ ${_editingCode} 成份股已更新（${list[idx].stocks.length} 檔）`);
  });

  // ── 取消 ──
  document.getElementById('adminCancelBtn')?.addEventListener('click', () => {
    document.getElementById('adminDiffArea').style.display = 'none';
    _pendingStocks = null;
  });

  // ── 刪除ETF ──
  document.getElementById('adminDelEtfBtn')?.addEventListener('click', async () => {
    if (!_editingCode) return;
    if (!confirm(`確定刪除 ${_editingCode}？此操作無法復原。`)) return;
    if (isActive) _etfActive  = (_etfActive  ?? []).filter(e => e.etfCode !== _editingCode);
    else          _etfPassive = (_etfPassive ?? []).filter(e => e.etfCode !== _editingCode);
    await fsSetShared(fsKey, isActive ? _etfActive : _etfPassive);
    _editingCode = null;
    _renderAdminBody(content, type);
  });

  // ── 顯示編輯區 ──
  function _showEditor() {
    const list = (isActive ? _etfActive : _etfPassive) ?? [];
    const etf  = list.find(e => e.etfCode === _editingCode);
    if (!etf) return;
    document.getElementById('adminStockEditor').style.display = 'block';
    document.getElementById('adminEditingLabel').textContent = `${etf.etfCode} ${etf.etfName}`;
    const wrap = document.getElementById('adminCurrentStocks');
    wrap.innerHTML = etf.stocks?.length
      ? etf.stocks.map(s => `<span class="theme-admin-stock-chip"><span style="color:var(--accent)">${s.code}</span> ${s.name}</span>`).join('')
      : '<span style="color:var(--muted);font-size:12px">尚無成份股，請貼入名單</span>';
  }
}

// ── ETF 匯入解析 ─────────────────────────────────────────────
// 支援格式：
//   1. JSON 陣列（含 code+name 欄位，可有多餘欄位如 qty/weight）
//   2. Tab/空格分隔表格（代號 名稱 股數 金額 權重% — 取前兩欄）
//   3. 逐行「代號 股名」或純代號
//   4. 換行分隔純欄位（每個欄位一行，代號行+名稱行交替或連續）
// 自動去重（以代號為 key，保留第一次出現）
// 自動過濾非股票列（期貨、現金、中文 header 等）
function _parseEtfImport(text) {
  const nc = window.__nameCache ?? {};
  const _getName = code => (typeof nc.get === 'function' ? nc.get(code) : nc[code]) || '';
  const _isStockCode = s => /^\d{4,6}[A-Za-z]?$/.test(s);
  const _clean = s => (s ?? '').replace(/\*/g, '').replace(/-KY$/i, s => s).trim();

  // ── 格式1：JSON ──────────────────────────────────────────────
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) {
      return _dedup(arr
        .map(item => ({
          code: _clean(String(item.code ?? item['股票代號'] ?? item['證券代號'] ?? '')),
          name: _clean(String(item.name ?? item['股票名稱'] ?? item['證券名稱'] ?? '')),
        }))
        .filter(item => _isStockCode(item.code))
        .map(item => ({
          code: item.code,
          name: item.name || _getName(item.code) || item.code,
        }))
      );
    }
  } catch(_) {}

  // ── 格式2/3/4：文字（逐行解析）──────────────────────────────
  const rows = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 偵測是否為「純欄位換行」格式（每行只有一個token，代號和名稱分開行）
  // 例：2330\n台積電\n2383\n台光電…
  const singleTokenLines = lines.filter(l => !l.includes('\t') && l.split(/\s+/).length === 1);
  const isPureColumnMode = singleTokenLines.length > lines.length * 0.7;

  if (isPureColumnMode) {
    // 純欄位模式：找代號行，下一行當名稱
    for (let i = 0; i < lines.length; i++) {
      const code = _clean(lines[i]);
      if (!_isStockCode(code)) continue;
      const nextLine = lines[i + 1]?.trim() ?? '';
      // 下一行是名稱（非代號）就取，否則從 nameCache 取
      const name = (!_isStockCode(_clean(nextLine)) && nextLine && !/^\d/.test(nextLine))
        ? _clean(nextLine)
        : _getName(code) || code;
      if (!_isStockCode(_clean(nextLine))) i++; // 消耗名稱行
      rows.push({ code, name });
    }
  } else {
    // Tab/空格分隔模式：每行取前兩欄
    lines.forEach(line => {
      // 先試 tab 分隔，再試空白
      const parts = line.includes('\t')
        ? line.split('\t').map(p => p.trim())
        : line.split(/\s{2,}|\s+/).map(p => p.trim()); // 2+空格或單空格

      const code = _clean(parts[0] ?? '');
      if (!_isStockCode(code)) return; // 過濾 header/非股票列

      // 名稱：取第二欄，若無則從 nameCache
      let name = _clean(parts[1] ?? '');
      // 過濾掉純數字欄（股數/金額欄誤判）
      if (!name || /^[\d,]+$/.test(name)) name = _getName(code) || code;

      rows.push({ code, name });
    });
  }

  return _dedup(rows);
}

// 去重：以代號為 key，保留第一筆
function _dedup(rows) {
  const seen = new Set();
  return rows.filter(r => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}

// ── Tab Bar ───────────────────────────────────────────────────
function _renderTabBar(themes, stockThemeMap) {
  const bar = document.getElementById('themeTabBar');
  if (!bar) return;
  if (!themes.length) { bar.innerHTML = ''; return; }

  let html = '';
  themes.forEach((t, i) => {
    const c = gc(t.color);
    const active = i === _activeIdx ? 'active' : '';
    html += `<button class="theme-tab-btn ${active}" data-idx="${i}"
      style="--t-border:${c.border};--t-text:${c.text};--t-bg:${c.bg}">
      <span class="theme-tab-emoji">${t.emoji}</span>
      <span class="theme-tab-name">${t.name}</span>
      <span class="theme-tab-count">${(t.stocks ?? []).length}</span>
    </button>`;
  });
  if (themes.length >= 2) {
    const relActive = _activeIdx === themes.length ? 'active' : '';
    html += `<button class="theme-tab-btn theme-tab-relation ${relActive}" data-idx="${themes.length}"
      style="--t-border:#6b7280;--t-text:#9ca3af;--t-bg:rgba(107,114,128,0.12)">
      <span class="theme-tab-emoji">🔀</span><span class="theme-tab-name">關聯</span>
    </button>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.theme-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeIdx = +btn.dataset.idx;
      _sortCol = null; _sortAsc = false;
      bar.querySelectorAll('.theme-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.scrollIntoView({ inline: 'center', behavior: 'smooth' });
      const { themes, stockThemeMap } = window.__themeData;
      _showTab(_activeIdx, themes, stockThemeMap);
    });
  });

  // 初始置中 active tab + 漸層更新
  requestAnimationFrame(() => {
    const active = bar.querySelector('.theme-tab-btn.active');
    if (active) active.scrollIntoView({ inline: 'center', behavior: 'instant' });
    _updateTabFade(bar);
  });

  // 滾動時即時更新左右漸層
  bar.addEventListener('scroll', () => _updateTabFade(bar), { passive: true });

  // PC 滑鼠滾輪 → 水平捲動
  bar.addEventListener('wheel', e => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    bar.scrollLeft += e.deltaY * 0.8;
    _updateTabFade(bar);
  }, { passive: false });

  // PC 拖曳滑動
  let _isDragging = false, _dragStartX = 0, _dragScrollLeft = 0;
  bar.addEventListener('mousedown', e => {
    if (e.target.closest('.theme-tab-btn')) return; // 點按鈕不觸發拖曳
    _isDragging = true;
    _dragStartX = e.pageX - bar.offsetLeft;
    _dragScrollLeft = bar.scrollLeft;
    bar.style.cursor = 'grabbing';
    bar.style.userSelect = 'none';
  });
  document.addEventListener('mouseup', () => {
    if (!_isDragging) return;
    _isDragging = false;
    bar.style.cursor = '';
    bar.style.userSelect = '';
  });
  bar.addEventListener('mousemove', e => {
    if (!_isDragging) return;
    e.preventDefault();
    const x = e.pageX - bar.offsetLeft;
    bar.scrollLeft = _dragScrollLeft - (x - _dragStartX);
    _updateTabFade(bar);
  });
}

function _updateTabFade(bar) {
  const fadeL = document.getElementById('themeTabFadeL');
  const fadeR = document.getElementById('themeTabFadeR');
  if (!fadeL || !fadeR || !bar) return;
  const { scrollLeft, scrollWidth, clientWidth } = bar;
  fadeL.style.opacity = scrollLeft > 4 ? '1' : '0';
  fadeR.style.opacity = scrollLeft + clientWidth < scrollWidth - 4 ? '1' : '0';
}

// ── 切換內容 ─────────────────────────────────────────────────
function _showTab(idx, themes, stockThemeMap) {
  const content = document.getElementById('themeContent');
  if (!content) return;
  if (!themes.length) {
    content.innerHTML = `<div class="theme-empty-state">
      <div class="theme-empty-icon">📂</div>
      <div class="theme-empty-title">尚無題材</div>
      <div class="theme-empty-desc">點擊右上角「＋ 新增題材」開始建立你的第一個題材清單</div>
    </div>`;
    return;
  }
  if (idx >= themes.length) {
    _renderRelation(content, themes, stockThemeMap);
  } else {
    _renderStocks(content, themes[idx], idx, themes, stockThemeMap);
  }
}


// ── 強勢族群資料載入 ──────────────────────────────────────────
async function _loadHotData(codeSet) {
  _hotSet   = new Set();
  _hotToday = new Set();
  _hotDate  = null;

  try {
    // 前日（往前找最多 7 天）
    const base = new Date();
    for (let i = 1; i <= 7; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const snap = await fsGetShared(`market/${dateStr}/limit_up`);
      if (!snap?.sectorRank) continue;
      _hotDate = dateStr;
      snap.sectorRank.forEach(sector => {
        (sector.stocks ?? []).forEach(s => {
          if (codeSet.has(s.code)) _hotSet.add(s.code);
        });
      });
      break;
    }

    // 今日（若盤中 __priceCache 有強勢資料則偵測）
    // 以漲幅 > 9% 為今日強勢判斷門檻
    if (codeSet.size) {
      const pc = window.__priceCache ?? {};
      codeSet.forEach(code => {
        const chg = pc[code]?.chgPct ?? pc[code]?.changePercent;
        if (chg != null && chg >= 9) _hotToday.add(code);
      });
    }
  } catch (e) {
    console.warn('[theme] 強勢族群載入失敗:', e.message);
  }
}

// ── B 層：題材 Header 強勢提示 ───────────────────────────────
function _renderHotBanner(themes) {
  const wrap = document.getElementById('themeHotBanner');
  if (!wrap) return;

  // 計算哪些題材有強勢股
  const hits = [];
  themes.forEach((t, i) => {
    const codes = (t.stocks ?? []).map(s => s.code);
    const todayHit = codes.filter(c => _hotToday.has(c));
    const prevHit  = codes.filter(c => _hotSet.has(c) && !_hotToday.has(c));
    if (todayHit.length || prevHit.length) {
      hits.push({ i, t, todayHit, prevHit });
    }
  });

  if (!hits.length) { wrap.style.display = 'none'; return; }

  const dateLabel = _hotDate ? `（${_hotDate}）` : '';
  let html = `<div class="th-hot-banner">
    <span class="th-hot-banner-icon">🔥</span>
    <span class="th-hot-banner-text">強勢股命中：`;

  html += hits.map(({ i, t, todayHit, prevHit }) => {
    const total = todayHit.length + prevHit.length;
    const todayTag = todayHit.length ? `<span class="th-hot-today-dot">今日</span>` : '';
    return `<span class="th-hot-banner-tag" data-idx="${i}">${t.emoji} ${t.name} ${total}檔${todayTag}</span>`;
  }).join('');

  html += `</span>
    <span class="th-hot-banner-date">${dateLabel}</span>
  </div>`;

  wrap.innerHTML = html;
  wrap.style.display = '';

  // 點擊跳到該題材
  wrap.querySelectorAll('.th-hot-banner-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const idx = +tag.dataset.idx;
      _activeIdx = idx;
      // 重渲染 Tab Bar + 內容
      const { themes, stockThemeMap } = window.__themeData;
      document.querySelectorAll('.theme-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelector(`.theme-tab-btn[data-idx="${idx}"]`)?.classList.add('active');
      document.querySelector(`.theme-tab-btn[data-idx="${idx}"]`)?.scrollIntoView({ inline: 'center', behavior: 'smooth' });
      _showTab(idx, themes, stockThemeMap);
    });
  });
}

// ── 個股清單（含三種檢視）────────────────────────────────────
// isEtf=true 時隱藏「編輯/新增/刪除題材」按鈕（ETF 撥盤唯讀）
async function _renderStocks(container, theme, themeIdx, themes, stockThemeMap, isEtf = false) {
  const c = gc(theme.color);
  const stocks = theme.stocks ?? [];

  // 批次讀健康度 + 妖股訊號 + 強勢族群
  if (stocks.length) {
    const codes = stocks.map(s => s.code);
    const codeSet = new Set(codes);
    _healthMap = await loadHealthCacheBatch(codes);

    // ── 從 kline_cache 撈最後一根收盤當現價，push 進 PriceHub ──────────
    // 比等 TWSE 批次快，題材 Tab 一開就能顯示價格
    _prefillPriceFromKline(codes).then(() => {
      // push 完立刻重繪價格欄（只更新 price span，不重建整張卡片）
      _repaintPrices(container);
    }).catch(() => {});

    // 從 signals_cache 撈 X1/X2/X5
    _yaoguMap = new Map();
    const allSig = await getAllSignalsCache();
    allSig.forEach(row => {
      if (!codeSet.has(row.code)) return;
      const sigs = row.signals ?? [];
      const x1 = sigs.some(s => s.id === 'X1');
      const x2 = sigs.some(s => s.id === 'X2');
      const x5 = sigs.some(s => s.id === 'X5');
      if (x1 || x2 || x5) {
        const strongest = x2 ? 'X2' : x1 ? 'X1' : 'X5';
        _yaoguMap.set(row.code, { x1, x2, x5, strongest });
      }
    });

    // 強勢族群：前日 + 今日
    await _loadHotData(codeSet);
  } else {
    _healthMap = new Map();
    _yaoguMap  = new Map();
    _hotSet    = new Set();
    _hotToday  = new Set();
  }

  // 渲染 B 層 header 強勢提示
  _renderHotBanner(themes);

  const hc = document.getElementById('themeHeaderCount');
  if (hc) hc.textContent = `${stocks.length} 檔`;

  container.innerHTML = `
    <div class="theme-desc" style="--t-border:${c.border}">
      <span class="theme-desc-emoji">${theme.emoji}</span>
      <span class="theme-desc-text">${theme.desc || '（無說明）'}</span>
    </div>
    <div class="theme-toolbar">
      <div class="theme-view-switcher">
        <button class="th-view-btn th-refresh-btn" id="themeRefreshData" title="更新股價與健康度">↻</button>
        <div class="th-view-divider"></div>
        <button class="th-view-btn ${_viewMode==='compact'?'active':''}" data-view="compact" title="簡約卡片（再點切換排序）">⊞${_viewMode==='compact'&&_sortCol?` <small>${_SORT_LABELS[_sortCol]}</small>`:''}</button>
        <button class="th-view-btn ${_viewMode==='detail'?'active':''}" data-view="detail" title="詳細卡片（再點切換排序）">▤${_viewMode==='detail'&&_sortCol?` <small>${_SORT_LABELS[_sortCol]}</small>`:''}</button>
        <button class="th-view-btn ${_viewMode==='table'?'active':''}" data-view="table" title="表格">☰</button>
      </div>
      <div class="theme-toolbar-right">
        ${isEtf ? '' : `
        <button class="theme-tool-btn" id="themeEditBtn">✏️ 編輯題材</button>
        <button class="theme-tool-btn" id="themeAddStockBtn">＋ 新增個股</button>
        <button class="theme-tool-btn theme-tool-btn--danger" id="themeDeleteBtn">🗑 刪除題材</button>`}
      </div>
    </div>
    <div id="themeStockBody"></div>`;

  // 工具列事件
  document.getElementById('themeEditBtn')?.addEventListener('click', () => _openThemeEditorTabbed(theme));
  document.getElementById('themeAddStockBtn')?.addEventListener('click', () => _openThemeEditor(theme));
  document.getElementById('themeDeleteBtn')?.addEventListener('click', () => _confirmDelete(theme));

  // 更新按鈕
  document.getElementById('themeRefreshData')?.addEventListener('click', () =>
    _refreshStockData(theme, themeIdx, themes, stockThemeMap));

  // 排序狀態同步到按鈕 label（不重建 toolbar）
  function _updateSortBtns() {
    container.querySelectorAll('.th-view-btn[data-view]').forEach(b => {
      const v = b.dataset.view;
      const icon = v === 'compact' ? '⊞' : v === 'detail' ? '▤' : '☰';
      const showLabel = (v === 'compact' || v === 'detail') && v === _viewMode && _sortCol;
      b.innerHTML = showLabel
        ? `${icon} <small>${_SORT_LABELS[_sortCol]}</small>`
        : icon;
    });
  }

  // 檢視切換（compact / detail 再點同一個 → 輪換排序）
  container.querySelectorAll('.th-view-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const clickedView = btn.dataset.view;
      if (clickedView !== 'table' && clickedView === _viewMode) {
        // 再點同一個：輪換排序欄位（降冪固定）
        const cur = _SORT_CYCLE.indexOf(_sortCol);
        _sortCol = _SORT_CYCLE[(cur + 1) % _SORT_CYCLE.length];
        _sortAsc = false;
      } else {
        // 切換到不同 view：清排序
        if (clickedView === 'table') { _sortCol = null; _sortAsc = true; }
        _viewMode = clickedView;
        container.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
      _updateSortBtns();
      _renderStockBody(theme, themeIdx, themes, stockThemeMap);
    });
  });

  _renderStockBody(theme, themeIdx, themes, stockThemeMap);
}

// ── 更新股價 + 健康度 + 訊號掃描 ───────────────────────────────
async function _refreshStockData(theme, themeIdx, themes, stockThemeMap) {
  const stocks = theme.stocks ?? [];
  if (!stocks.length) return;

  const btn = document.getElementById('themeRefreshData');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  let done = 0;
  for (const s of stocks) {
    try {
      // 1. 拉 K 線 + 算健康度
      const { candles } = await resolveYahooSymbol(s.code, '1y');
      if (candles?.length) {
        const hs = calcHealth(candles.slice(-65));
        const hl = calcHealthLong(candles);
        await saveHealthCache(s.code, hs, hl, 'afterhours');
      }
      // 2. 訊號掃描（含妖股注入 + 寫 IndexedDB + 更新 AppState）
      await scanOneCode(s.code, { silent: true });
    } catch (e) {
      console.warn(`[theme] 更新失敗 ${s.code}:`, e.message);
    }
    done++;
    if (btn) btn.textContent = `${done}/${stocks.length}`;
  }

  // 重讀快取重渲染
  const codes = stocks.map(s => s.code);
  const codeSet = new Set(codes);
  _healthMap = await loadHealthCacheBatch(codes);
  const allSig = await getAllSignalsCache();
  _yaoguMap = new Map();
  allSig.forEach(row => {
    if (!codeSet.has(row.code)) return;
    const sigs = row.signals ?? [];
    const x1 = sigs.some(s => s.id === 'X1');
    const x2 = sigs.some(s => s.id === 'X2');
    const x5 = sigs.some(s => s.id === 'X5');
    if (x1 || x2 || x5) _yaoguMap.set(row.code, { x1, x2, x5, strongest: x2?'X2':x1?'X1':'X5' });
  });
  _renderStockBody(theme, themeIdx, themes, stockThemeMap);

  if (btn) { btn.textContent = '✓'; btn.disabled = false; }
  setTimeout(() => { if (document.getElementById('themeRefreshData')) btn.textContent = '↻'; }, 2000);
}

// ── 個股清單渲染（三種模式）─────────────────────────────────
function _renderStockBody(theme, themeIdx, themes, stockThemeMap) {
  const body = document.getElementById('themeStockBody');
  if (!body) return;
  const stocks = theme.stocks ?? [];
  if (!stocks.length) {
    body.innerHTML = `<div class="theme-stocks-empty">尚無個股，點擊「＋ 新增個股」加入</div>`;
    return;
  }

  // 排序
  let sorted = stocks.map((s, i) => ({ ...s, _orig: i }));
  if (_sortCol) {
    sorted.sort((a, b) => {
      let va, vb;
      if (_sortCol === 'code')   { va = a.code;  vb = b.code; }
      else if (_sortCol === 'name')  { va = a.name;  vb = b.name; }
      else if (_sortCol === 'price') { va = _price(a.code); vb = _price(b.code); }
      else if (_sortCol === 'chg')   { va = _chg(a.code);   vb = _chg(b.code); }
      else if (_sortCol === 'hs')    { va = (_healthMap.get(a.code)?.healthShort ?? -1); vb = (_healthMap.get(b.code)?.healthShort ?? -1); }
      else if (_sortCol === 'hl')    { va = (_healthMap.get(a.code)?.healthLong  ?? -1); vb = (_healthMap.get(b.code)?.healthLong  ?? -1); }
      if (typeof va === 'string') return _sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return _sortAsc ? (va - vb) : (vb - va);
    });
  }

  if (_viewMode === 'compact') _renderCompact(body, sorted, theme, themeIdx, themes, stockThemeMap);
  else if (_viewMode === 'detail') _renderDetail(body, sorted, theme, themeIdx, themes, stockThemeMap);
  else _renderTable(body, sorted, theme, themeIdx, themes, stockThemeMap);
}

// ── 現價 / 漲跌幅輔助 ────────────────────────────────────────
function _price(code) { return (window.__priceCache ?? {})[code]?.price ?? null; }
function _chg(code)   {
  const p = (window.__priceCache ?? {})[code];
  return p?.changePercent ?? p?.chgPct ?? null;
}
function _priceHtml(code) {
  const p = (window.__priceCache ?? {})[code];
  if (!p?.price) return '';
  const chg = p.changePercent ?? p.chgPct;
  if (chg == null) return `<span class="theme-stock-price">${p.price}</span>`;
  const cls = chg >= 0 ? 'up' : 'down';
  const sign = chg >= 0 ? '+' : '';
  return `<span class="theme-stock-price ${cls}">${p.price} <small>${sign}${Number(chg).toFixed(2)}%</small></span>`;
}
function _chgHtml(code) {
  const chg = _chg(code);
  if (chg == null) return '<span class="hg-health-empty">—</span>';
  const cls = chg >= 0 ? 'up' : 'down';
  const sign = chg >= 0 ? '+' : '';
  return `<span class="theme-stock-price ${cls}">${sign}${Number(chg).toFixed(2)}%</span>`;
}

// ── 簡約卡片 ─────────────────────────────────────────────────
function _renderCompact(body, stocks, theme, themeIdx, themes, stockThemeMap) {
  const c = gc(theme.color);
  let html = `<div class="theme-stocks-grid theme-stocks-grid--compact">`;
  stocks.forEach(s => {
    const h = _healthMap.get(s.code);
    const hs = h?.healthShort ?? null;
    const hl = h?.healthLong  ?? null;
    const yg = _yaoguMap.get(s.code);
    const ygClass = yg ? ` theme-card--yaogu theme-card--yaogu-${yg.strongest.toLowerCase()}` : '';
    html += `<div class="theme-stock-card theme-card--compact${ygClass}" data-code="${s.code}"
      style="--t-border:${c.border};--t-bg:${c.bg}">
      <div class="theme-stock-header">
        <span class="theme-stock-code">${s.code}</span>
        <span class="theme-stock-name">${s.name}</span>
        ${_priceHtml(s.code)}
        <button class="theme-stock-del" data-orig="${s._orig}" title="移除">✕</button>
      </div>
      <div class="th-compact-health">
        ${healthBadgeDual(hs, hl, 'hg')}
        ${yg ? `<span class="th-yaogu-pill th-yaogu-pill--${yg.strongest.toLowerCase()}">${yg.strongest}</span>` : ''}
        ${_hotToday.has(s.code) ? '<span class="th-hot-pill th-hot-pill--today">🔥今日</span>' : _hotSet.has(s.code) ? `<span class="th-hot-pill">${_hotDate?.slice(5) ?? '前日'}</span>` : ''}
      </div>
      <canvas class="th-sparkline" data-code="${s.code}" width="220" height="56"></canvas>
    </div>`;
  });
  html += `</div>`;
  body.innerHTML = html;
  _bindStockEvents(body, theme, themeIdx, themes, stockThemeMap);
  _enqueueSparklines(body, stocks);
}

// ── 詳細卡片 ─────────────────────────────────────────────────
function _renderDetail(body, stocks, theme, themeIdx, themes, stockThemeMap) {
  const c = gc(theme.color);
  let html = `<div class="theme-stocks-grid theme-stocks-grid--detail">`;
  stocks.forEach(s => {
    const h = _healthMap.get(s.code);
    const hs = h?.healthShort ?? null;
    const hl = h?.healthLong  ?? null;
    const otherIdxs = [...(stockThemeMap.get(s.code) ?? [])].filter(i => i !== themeIdx);
    const crossTags = otherIdxs.map(oi => {
      const ot = themes[oi]; if (!ot) return '';
      const oc = gc(ot.color);
      return `<span class="theme-cross-tag" style="background:${oc.bg};color:${oc.text};border-color:${oc.border}">${ot.emoji} ${ot.name}</span>`;
    }).join('');

    const yg2 = _yaoguMap.get(s.code);
    const ygClass2 = yg2 ? ` theme-card--yaogu theme-card--yaogu-${yg2.strongest.toLowerCase()}` : '';
    html += `<div class="theme-stock-card theme-card--detail${ygClass2}" data-code="${s.code}"
      style="--t-border:${c.border};--t-bg:${c.bg}">
      <div class="theme-stock-header">
        <span class="theme-stock-code">${s.code}</span>
        <span class="theme-stock-name">${s.name}</span>
        ${_priceHtml(s.code)}
        <button class="theme-stock-del" data-orig="${s._orig}" title="移除">✕</button>
      </div>
      <div class="theme-stock-reason">${s.reason || ''}</div>
      <div class="th-compact-health">
        ${healthBadgeDual(hs, hl, 'hg')}
        ${yg2 ? `<span class="th-yaogu-pill th-yaogu-pill--${yg2.strongest.toLowerCase()}">${yg2.strongest}</span>` : ''}
        ${_hotToday.has(s.code) ? '<span class="th-hot-pill th-hot-pill--today">🔥今日</span>' : _hotSet.has(s.code) ? `<span class="th-hot-pill">${_hotDate?.slice(5) ?? '前日'}</span>` : ''}
      </div>
      ${crossTags ? `<div class="theme-cross-tags">${crossTags}</div>` : ''}
    </div>`;
  });
  html += `</div>`;
  body.innerHTML = html;
  _bindStockEvents(body, theme, themeIdx, themes, stockThemeMap);
}

// ── 表格 ─────────────────────────────────────────────────────
function _renderTable(body, stocks, theme, themeIdx, themes, stockThemeMap) {
  const cols = [
    { key:'code',  label:'代號' },
    { key:'name',  label:'股名' },
    { key:'price', label:'現價' },
    { key:'chg',   label:'漲跌幅' },
    { key:'hs',    label:'短線健康' },
    { key:'hl',    label:'長線健康' },
    { key:'yaogu', label:'妖股訊號', noSort: true },
    { key:'hot',   label:'強勢', noSort: true },
    { key:'reason',label:'理由', noSort: true },
  ];

  let thead = `<tr>`;
  cols.forEach(col => {
    if (col.noSort) { thead += `<th class="th-tbl-th">${col.label}</th>`; return; }
    const isSorted = _sortCol === col.key;
    const arrow = isSorted ? (_sortAsc ? ' ▲' : ' ▼') : '';
    thead += `<th class="th-tbl-th th-tbl-sortable ${isSorted?'sorted':''}" data-col="${col.key}">${col.label}${arrow}</th>`;
  });
  thead += `<th class="th-tbl-th"></th></tr>`;

  let tbody = '';
  stocks.forEach(s => {
    const h  = _healthMap.get(s.code);
    const hs = h?.healthShort ?? null;
    const hl = h?.healthLong  ?? null;
    tbody += `<tr class="th-tbl-row" data-code="${s.code}">
      <td class="th-tbl-td"><span class="theme-stock-code">${s.code}</span></td>
      <td class="th-tbl-td"><span class="theme-stock-name">${s.name}</span></td>
      <td class="th-tbl-td">${_priceHtml(s.code) || '—'}</td>
      <td class="th-tbl-td">${_chgHtml(s.code)}</td>
      <td class="th-tbl-td">${healthBadge(hs, 'hg')}</td>
      <td class="th-tbl-td">${healthBadge(hl, 'hg')}</td>
      <td class="th-tbl-td">${(() => { const yg3=_yaoguMap.get(s.code); return yg3?`<span class="th-yaogu-pill th-yaogu-pill--${yg3.strongest.toLowerCase()}">${yg3.strongest}</span>`:''; })()}</td>
      <td class="th-tbl-td">${_hotToday.has(s.code)?'<span class="th-hot-pill th-hot-pill--today">🔥今日</span>':_hotSet.has(s.code)?`<span class="th-hot-pill">${_hotDate?.slice(5)??'前日'}</span>`:''}</td>
      <td class="th-tbl-td th-tbl-reason">${s.reason || ''}</td>
      <td class="th-tbl-td"><button class="theme-stock-del" data-orig="${s._orig}" title="移除">✕</button></td>
    </tr>`;
  });

  body.innerHTML = `<div class="th-tbl-wrap"><table class="th-tbl">
    <thead>${thead}</thead>
    <tbody>${tbody}</tbody>
  </table></div>`;

  // 排序 header
  body.querySelectorAll('.th-tbl-sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_sortCol === col) _sortAsc = !_sortAsc;
      else { _sortCol = col; _sortAsc = true; }
      _renderStockBody(theme, themeIdx, themes, stockThemeMap);
    });
  });

  _bindStockEvents(body, theme, themeIdx, themes, stockThemeMap);
}

// ── 共用事件綁定 ──────────────────────────────────────────────
function _bindStockEvents(body, theme, themeIdx, themes, stockThemeMap) {
  // 點卡片/列跳轉個股
  body.querySelectorAll('[data-code]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.theme-stock-del')) return;
      document.dispatchEvent(new CustomEvent('stockSelect', { detail: { code: el.dataset.code } }));
      document.querySelector('.main-tab[data-tab="chart"]')?.click();
    });
  });

  // 移除個股
  body.querySelectorAll('.theme-stock-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const orig = +btn.dataset.orig;
      const newStocks = [...(theme.stocks ?? [])];
      newStocks.splice(orig, 1);
      await saveUserTheme({ ...theme, stocks: newStocks });
      await _refresh();
    });
  });
}

// ════════════════════════════════════════════════════════════
// 編輯題材（Tab 版）：基本資料 + 搬移個股
// ════════════════════════════════════════════════════════════
function _openThemeEditorTabbed(theme) {
  let _activeTab = 'info'; // 'info' | 'move'

  function _render() {
    _showModal(`
      <div class="tm-modal-title">✏️ 編輯題材</div>
      <div class="tm-edit-tabs">
        <button class="tm-edit-tab ${_activeTab === 'info' ? 'active' : ''}" data-tab="info">基本資料</button>
        <button class="tm-edit-tab ${_activeTab === 'move' ? 'active' : ''}" data-tab="move">🔀 搬移個股</button>
      </div>
      <div id="tmEditTabBody">
        ${_activeTab === 'info' ? _renderInfoTab() : _renderMoveTab()}
      </div>
    `, 'large');

    // tab 切換
    document.querySelectorAll('.tm-edit-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeTab = btn.dataset.tab;
        _render();
      });
    });

    if (_activeTab === 'info') _bindInfoTab();
    else _bindMoveTab();
  }

  // ── Tab 1：基本資料 ─────────────────────────────────────
  function _renderInfoTab() {
    const colorOpts = COLOR_KEYS.map(k => {
      const sel = (theme.color === k) ? 'selected' : '';
      return `<option value="${k}" ${sel}>${k}</option>`;
    }).join('');
    return `
      <div class="tm-form" style="margin-top:14px">
        <div class="tm-row">
          <div style="flex:0 0 auto">
            <label class="tm-label">Emoji</label>
            <input class="tm-input" id="tmEmoji" value="${theme.emoji}" maxlength="2" style="width:58px;text-align:center;font-size:20px">
          </div>
          <div style="flex:1">
            <label class="tm-label">顏色</label>
            <select class="tm-input" id="tmColor">${colorOpts}</select>
          </div>
        </div>
        <div>
          <label class="tm-label">題材名稱</label>
          <input class="tm-input" id="tmName" value="${theme.name}" placeholder="例：AI 機器人">
        </div>
        <div>
          <label class="tm-label">題材說明</label>
          <textarea class="tm-input tm-textarea" id="tmDesc" placeholder="簡短說明投資邏輯（選填）">${theme.desc ?? ''}</textarea>
        </div>
      </div>
      <div class="tm-modal-actions">
        <button class="tm-btn tm-btn--cancel" id="tmCancel">取消</button>
        <button class="tm-btn tm-btn--ok" id="tmOk">儲存</button>
      </div>`;
  }

  function _bindInfoTab() {
    document.getElementById('tmCancel').addEventListener('click', _closeModal);
    document.getElementById('tmOk').addEventListener('click', async () => {
      const name = document.getElementById('tmName').value.trim();
      if (!name) { _shake('tmName'); return; }
      const data = {
        ...theme,
        emoji: document.getElementById('tmEmoji').value.trim() || '📌',
        name,
        desc:  document.getElementById('tmDesc').value.trim(),
        color: document.getElementById('tmColor').value,
      };
      await saveUserTheme(data);
      _closeModal();
      await _refresh();
    });
  }

  // ── Tab 2：搬移個股 ─────────────────────────────────────
  const allThemes = window.__themeData?.themes ?? [];
  const targets = allThemes.filter(t => t.id !== theme.id);
  let selectedCodes = new Set();
  let targetId = targets[0]?.id ?? null;

  function _renderMoveTab() {
    const stocks = theme.stocks ?? [];
    if (!stocks.length) {
      return `
        <div class="tm-move-empty">此題材目前沒有個股</div>
        <div class="tm-modal-actions">
          <button class="tm-btn tm-btn--cancel" id="tmCancel">關閉</button>
        </div>`;
    }
    if (!targets.length) {
      return `
        <div class="tm-move-empty">沒有其他題材可搬移，請先建立第二個題材</div>
        <div class="tm-modal-actions">
          <button class="tm-btn tm-btn--cancel" id="tmCancel">關閉</button>
        </div>`;
    }

    const targetOpts = targets.map(t =>
      `<option value="${t.id}" ${t.id === targetId ? 'selected' : ''}>${t.emoji} ${t.name}</option>`
    ).join('');

    const stockRows = stocks.map(s => `
      <label class="tm-move-row">
        <input type="checkbox" class="tm-move-chk" data-code="${s.code}" ${selectedCodes.has(s.code) ? 'checked' : ''}>
        <span class="theme-stock-code">${s.code}</span>
        <span class="theme-stock-name">${s.name}</span>
        <span class="tm-pending-reason">${s.reason || ''}</span>
      </label>`).join('');

    return `
      <div class="tm-move-toolbar">
        <label class="tm-move-selall">
          <input type="checkbox" id="tmSelectAll"> 全選
        </label>
        <span class="tm-move-arrow">→ 搬移到</span>
        <select class="tm-input tm-move-target" id="tmMoveTarget">${targetOpts}</select>
      </div>
      <div class="tm-move-list">${stockRows}</div>
      <div class="tm-move-hint" id="tmMoveHint"></div>
      <div class="tm-modal-actions">
        <button class="tm-btn tm-btn--cancel" id="tmCancel">取消</button>
        <button class="tm-btn tm-btn--ok" id="tmDoMove">搬移</button>
      </div>`;
  }

  function _bindMoveTab() {
    const stocks = theme.stocks ?? [];
    if (!stocks.length || !targets.length) {
      document.getElementById('tmCancel')?.addEventListener('click', _closeModal);
      return;
    }

    // 同步勾選狀態到 selectedCodes
    const syncChecks = () => {
      selectedCodes = new Set(
        [...document.querySelectorAll('.tm-move-chk:checked')].map(el => el.dataset.code)
      );
    };

    // 全選 checkbox
    document.getElementById('tmSelectAll').addEventListener('change', e => {
      document.querySelectorAll('.tm-move-chk').forEach(chk => { chk.checked = e.target.checked; });
      syncChecks();
    });

    // 個別勾選
    document.querySelectorAll('.tm-move-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        syncChecks();
        const allChk = document.getElementById('tmSelectAll');
        if (allChk) allChk.checked = (selectedCodes.size === stocks.length);
      });
    });

    // 目標題材下拉
    document.getElementById('tmMoveTarget').addEventListener('change', e => {
      targetId = e.target.value;
    });

    document.getElementById('tmCancel').addEventListener('click', _closeModal);

    document.getElementById('tmDoMove').addEventListener('click', async () => {
      syncChecks();
      const hintEl = document.getElementById('tmMoveHint');
      if (!selectedCodes.size) {
        hintEl.textContent = '請先勾選要搬移的個股';
        hintEl.className = 'tm-move-hint tm-err';
        return;
      }
      if (!targetId) {
        hintEl.textContent = '請選擇目標題材';
        hintEl.className = 'tm-move-hint tm-err';
        return;
      }

      const targetTheme = allThemes.find(t => t.id === targetId);
      if (!targetTheme) return;

      // 要搬移的個股物件
      const toMove = (theme.stocks ?? []).filter(s => selectedCodes.has(s.code));

      // 原題材：刪掉已勾選的
      const srcUpdated = {
        ...theme,
        stocks: (theme.stocks ?? []).filter(s => !selectedCodes.has(s.code)),
      };

      // 目標題材：加入（已有的跳過）
      const existCodes = new Set((targetTheme.stocks ?? []).map(s => s.code));
      const newStocks = toMove.filter(s => !existCodes.has(s.code));
      const skipped = toMove.length - newStocks.length;
      const dstUpdated = {
        ...targetTheme,
        stocks: [...(targetTheme.stocks ?? []), ...newStocks],
      };

      // 同時儲存兩筆
      await Promise.all([
        saveUserTheme(srcUpdated),
        saveUserTheme(dstUpdated),
      ]);

      _closeModal();
      await _refresh();

      // 若原題材已空，提示一下（不強制跳tab）
      const msg = skipped
        ? `✓ 已搬移 ${newStocks.length} 檔，${skipped} 檔目標已存在略過`
        : `✓ 已搬移 ${newStocks.length} 檔到「${targetTheme.emoji} ${targetTheme.name}」`;
      // 用短暫 toast 提示
      _toast(msg);
    });
  }

  _render();
}

// 新增 / 編輯題材 Modal
// ════════════════════════════════════════════════════════════
function _openThemeEditor(theme) {
  const isNew = !theme;
  let pendingStocks = isNew ? [] : [...(theme.stocks ?? [])];

  const colorOpts = COLOR_KEYS.map(k => {
    const sel = (!isNew && theme.color === k) || (isNew && k === 'blue') ? 'selected' : '';
    return `<option value="${k}" ${sel}>${k}</option>`;
  }).join('');

  _showModal(`
    <div class="tm-modal-title">${isNew ? '新增題材' : '編輯題材'}</div>
    <div class="tm-section-label">① 基本資訊</div>
    <div class="tm-form">
      <div class="tm-row">
        <div style="flex:0 0 auto">
          <label class="tm-label">Emoji</label>
          <input class="tm-input" id="tmEmoji" value="${isNew ? '📌' : theme.emoji}" maxlength="2" style="width:58px;text-align:center;font-size:20px">
        </div>
        <div style="flex:1">
          <label class="tm-label">顏色</label>
          <select class="tm-input" id="tmColor">${colorOpts}</select>
        </div>
      </div>
      <div>
        <label class="tm-label">題材名稱</label>
        <input class="tm-input" id="tmName" value="${isNew ? '' : theme.name}" placeholder="例：AI 機器人">
      </div>
      <div>
        <label class="tm-label">題材說明</label>
        <textarea class="tm-input tm-textarea" id="tmDesc" placeholder="簡短說明投資邏輯（選填）">${isNew ? '' : (theme.desc ?? '')}</textarea>
      </div>
    </div>

    <div class="tm-section-label">② 加入個股（選填）</div>
    <div class="tm-ai-box">
      <div class="tm-ai-header">
        <span class="tm-ai-label">🤖 AI 輔助選股</span>
        <button class="tm-copy-btn" id="tmCopyPrompt">複製 Prompt</button>
      </div>
      <div class="tm-ai-steps">複製 Prompt → 貼給 AI → 把 AI 回覆的 JSON 貼回下方</div>
      <textarea class="tm-input tm-textarea tm-json-input" id="tmJsonInput"
        placeholder='貼上 AI 回覆的 JSON，例：&#10;[&#10;  { "code": "2330", "name": "台積電", "reason": "..." }&#10;]'></textarea>
      <button class="tm-parse-btn" id="tmParseJson">解析並加入</button>
      <div class="tm-parse-result" id="tmParseResult"></div>
    </div>

    <div class="tm-manual-box">
      <div class="tm-ai-header">
        <span class="tm-ai-label">✍️ 手動新增</span>
      </div>
      <div class="tm-manual-row">
        <input class="tm-input" id="tmMCode" placeholder="代號" maxlength="6" style="width:80px;flex:0 0 auto">
        <input class="tm-input" id="tmMName" placeholder="股名（輸入代號自動帶入）" style="flex:1">
        <button class="tm-add-stock-btn" id="tmAddOne">加入</button>
      </div>
      <input class="tm-input" id="tmMReason" placeholder="納入理由（選填）" style="margin-top:6px">
      <div class="tm-manual-hint" id="tmManualHint"></div>
    </div>

    <div class="tm-pending-wrap" id="tmPendingWrap" style="display:none">
      <div class="tm-section-label" style="margin-top:12px">待加入個股 <span id="tmPendingCount"></span></div>
      <div class="tm-pending-list" id="tmPendingList"></div>
    </div>

    <div class="tm-modal-actions">
      <button class="tm-btn tm-btn--cancel" id="tmCancel">取消</button>
      <button class="tm-btn tm-btn--ok" id="tmOk">${isNew ? '建立題材' : '儲存'}</button>
    </div>`, 'large');

  // 複製 Prompt
  document.getElementById('tmCopyPrompt').addEventListener('click', () => {
    const name = document.getElementById('tmName').value.trim() || '（題材名稱）';
    navigator.clipboard.writeText(_buildAiPrompt(name)).then(() => {
      const btn = document.getElementById('tmCopyPrompt');
      if (!btn) return;
      btn.textContent = '✓ 已複製';
      setTimeout(() => { if (document.getElementById('tmCopyPrompt')) btn.textContent = '複製 Prompt'; }, 2000);
    });
  });

  // 解析 JSON
  document.getElementById('tmParseJson').addEventListener('click', () => {
    const raw = document.getElementById('tmJsonInput').value.trim();
    const result = document.getElementById('tmParseResult');
    if (!raw) { result.textContent = '請先貼上 JSON'; result.className = 'tm-parse-result tm-err'; return; }
    let parsed;
    try {
      const clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      parsed = JSON.parse(clean);
      if (!Array.isArray(parsed)) throw new Error('需要陣列格式');
    } catch (e) {
      result.textContent = `JSON 解析失敗：${e.message}`;
      result.className = 'tm-parse-result tm-err'; return;
    }
    let added = 0, skipped = 0;
    parsed.forEach(item => {
      const code   = String(item.code   ?? item['代號'] ?? '').trim();
      const name   = String(item.name   ?? item['股名'] ?? item['名稱'] ?? '').trim();
      const reason = String(item.reason ?? item['理由'] ?? item['納入理由'] ?? '').trim();
      if (!code || !name) { skipped++; return; }
      if (pendingStocks.some(s => s.code === code)) { skipped++; return; }
      pendingStocks.push({ code, name, reason });
      added++;
    });
    result.textContent = `✓ 成功加入 ${added} 檔${skipped ? `，略過 ${skipped} 筆` : ''}`;
    result.className = 'tm-parse-result tm-ok';
    document.getElementById('tmJsonInput').value = '';
    _renderPending();
  });

  // 手動新增
  const codeEl = document.getElementById('tmMCode');
  const nameEl = document.getElementById('tmMName');
  const hintEl = document.getElementById('tmManualHint');
  codeEl.addEventListener('input', () => {
    const n = window.__nameCache?.get?.(codeEl.value.trim());
    if (n) { nameEl.value = n; hintEl.textContent = `✓ ${n}`; hintEl.style.color = '#86efac'; }
    else { hintEl.textContent = codeEl.value.length >= 4 ? '找不到股名，請手動輸入' : ''; hintEl.style.color = '#fca5a5'; }
  });
  const doAddOne = () => {
    const code = codeEl.value.trim(), name = nameEl.value.trim();
    const reason = document.getElementById('tmMReason').value.trim();
    if (!code) { _shake('tmMCode'); return; }
    if (!name) { _shake('tmMName'); return; }
    if (pendingStocks.some(s => s.code === code)) { hintEl.textContent = '此代號已在清單中'; hintEl.style.color = '#fca5a5'; return; }
    pendingStocks.push({ code, name, reason });
    codeEl.value = ''; nameEl.value = ''; document.getElementById('tmMReason').value = ''; hintEl.textContent = '';
    _renderPending();
  };
  document.getElementById('tmAddOne').addEventListener('click', doAddOne);
  codeEl.addEventListener('keydown', e => { if (e.key === 'Enter') doAddOne(); });

  document.getElementById('tmCancel').addEventListener('click', _closeModal);
  document.getElementById('tmOk').addEventListener('click', async () => {
    const name = document.getElementById('tmName').value.trim();
    if (!name) { _shake('tmName'); return; }
    const data = {
      id:     isNew ? genId() : theme.id,
      emoji:  document.getElementById('tmEmoji').value.trim() || '📌',
      name,
      desc:   document.getElementById('tmDesc').value.trim(),
      color:  document.getElementById('tmColor').value,
      order:  isNew ? (window.__themeData?.themes?.length ?? 0) : theme.order,
      stocks: pendingStocks,
    };
    await saveUserTheme(data);
    _closeModal();
    if (isNew) _activeIdx = window.__themeData?.themes?.length ?? 0;
    await _refresh();
    if (isNew) renderThemePanel();
  });

  function _renderPending() {
    const wrap = document.getElementById('tmPendingWrap');
    const list = document.getElementById('tmPendingList');
    const count = document.getElementById('tmPendingCount');
    if (!wrap || !list) return;
    if (!pendingStocks.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    count.textContent = `（${pendingStocks.length} 檔）`;
    list.innerHTML = pendingStocks.map((s, i) => `
      <div class="tm-pending-row">
        <span class="theme-stock-code">${s.code}</span>
        <span class="theme-stock-name">${s.name}</span>
        <span class="tm-pending-reason">${s.reason || ''}</span>
        <button class="tm-pending-del" data-i="${i}">✕</button>
      </div>`).join('');
    list.querySelectorAll('.tm-pending-del').forEach(btn => {
      btn.addEventListener('click', () => { pendingStocks.splice(+btn.dataset.i, 1); _renderPending(); });
    });
  }

  if (pendingStocks.length) _renderPending();
}


// ════════════════════════════════════════════════════════════
// kline_cache → PriceHub 價格預填
// ════════════════════════════════════════════════════════════

/**
 * 從 kline_cache 讀各股最後一根收盤，push 進 PriceHub
 * 讓題材 Tab 在 TWSE 批次 API 回來前就能顯示價格
 * TWSE 批次完成後會用最新值覆蓋（chg/chgPct 也會修正）
 */
async function _prefillPriceFromKline(codes) {
  if (!window.__priceHub) return;

  const map = {};
  await Promise.all(codes.map(async code => {
    // 已有報價就跳過，不蓋掉 TWSE 批次的正確值
    if (window.__priceCache?.[code]?.price) return;

    // 試 .TW 再試 .TWO
    const syms = [`${code}.TW`, `${code}.TWO`];
    for (const sym of syms) {
      const cached = await getKlineCache(sym, '1y');
      if (!cached?.candles?.length) continue;
      const last = cached.candles[cached.candles.length - 1];
      const price = last?.close ?? last?.[4];
      if (!price) continue;
      // prev 用倒數第二根，算出 chgPct
      const prev2 = cached.candles.length >= 2
        ? (cached.candles[cached.candles.length - 2]?.close ?? price)
        : price;
      const chg    = price - prev2;
      const chgPct = prev2 > 0 ? (chg / prev2) * 100 : 0;
      map[code] = { price, prev: prev2, chg, chgPct };
      break;
    }
  }));

  if (!Object.keys(map).length) return;
  window.__priceHub.push(map, { persist: false, updateHeader: false, source: 'kline-price' });
}

// ════════════════════════════════════════════════════════════
// 價格欄位快速重繪（不重建卡片，只換 price span）
// ════════════════════════════════════════════════════════════

function _repaintPrices(container) {
  if (!container) return;
  // 找所有帶 data-code 的卡片和表格列
  container.querySelectorAll('[data-code]').forEach(el => {
    const code = el.dataset.code;
    if (!code) return;
    const span = el.querySelector('.theme-stock-price');
    if (!span) return;
    const html = _priceHtml(code);
    if (html) span.outerHTML = html;
  });
}

// ════════════════════════════════════════════════════════════
// 小卡 K 線折線圖（Sparkline）排隊機制
// ════════════════════════════════════════════════════════════

let _sparklineQueue = [];   // [{ canvas, code }]
let _sparklineTimer = null;

/**
 * 把本次小卡所有 canvas 加入排隊，每 1 秒畫一張
 * 切換 tab / viewMode 時舊 timer 會因為 canvas 不在 DOM 而自動跳過
 */
function _enqueueSparklines(body, stocks) {
  // 清掉上一輪殘留的佇列（切 tab 時會重跑）
  _sparklineQueue = [];
  clearTimeout(_sparklineTimer);

  stocks.forEach(s => {
    const canvas = body.querySelector(`.th-sparkline[data-code="${s.code}"]`);
    if (canvas) _sparklineQueue.push({ canvas, code: s.code });
  });

  _drainSparklineQueue();
}

function _drainSparklineQueue() {
  if (!_sparklineQueue.length) return;
  const { canvas, code } = _sparklineQueue.shift();

  // canvas 已離開 DOM（切走了）→ 跳過，繼續下一張
  if (!document.contains(canvas)) {
    _sparklineTimer = setTimeout(_drainSparklineQueue, 0);
    return;
  }

  _drawSparkline(canvas, code).finally(() => {
    _sparklineTimer = setTimeout(_drainSparklineQueue, 50);
  });
}

/**
 * 從 kline_cache 取最近 40 根，畫折線 + MA20
 */
async function _drawSparkline(canvas, code) {
  const symbol = code.length <= 4 ? `${code}.TW` : `${code}.TWO`;
  // 先試 .TW，找不到試 .TWO
  let cached = await getKlineCache(symbol, '1y');
  if (!cached?.candles?.length) {
    const sym2 = code.length <= 4 ? `${code}.TWO` : `${code}.TW`;
    cached = await getKlineCache(sym2, '1y');
  }

  if (!cached?.candles?.length) {
    // 沒資料：畫 placeholder
    _drawNoData(canvas);
    return;
  }

  const raw = cached.candles.slice(-40);
  const closes = raw.map(c => c.close ?? c[4] ?? null).filter(v => v != null);
  if (closes.length < 5) { _drawNoData(canvas); return; }

  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const PAD_L = 4, PAD_R = 4, PAD_T = 6, PAD_B = 6;
  const drawW = W - PAD_L - PAD_R;
  const drawH = H - PAD_T - PAD_B;

  const minV = Math.min(...closes);
  const maxV = Math.max(...closes);
  const range = maxV - minV || 1;

  const xOf = i => PAD_L + (i / (closes.length - 1)) * drawW;
  const yOf = v => PAD_T + (1 - (v - minV) / range) * drawH;

  // ── 背景格線（淡）
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(r => {
    const y = PAD_T + r * drawH;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
  });

  // ── MA20 線（灰，半透明）
  if (closes.length >= 20) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.lineWidth = 1;
    for (let i = 19; i < closes.length; i++) {
      const ma = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      const x = xOf(i), y = yOf(ma);
      if (i === 19) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── 決定折線顏色：最後一根 vs 第一根
  const isUp = closes[closes.length - 1] >= closes[0];
  const lineColor = isUp ? '#ef5350' : '#26a69a';
  const fillColor = isUp ? 'rgba(239,83,80,0.10)' : 'rgba(38,166,154,0.12)';

  // ── 填色區域
  ctx.beginPath();
  closes.forEach((v, i) => {
    const x = xOf(i), y = yOf(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineTo(xOf(closes.length - 1), H - PAD_B);
  ctx.lineTo(PAD_L, H - PAD_B);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // ── 主折線
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  closes.forEach((v, i) => {
    const x = xOf(i), y = yOf(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // ── 最後一點高亮圓點
  const lx = xOf(closes.length - 1), ly = yOf(closes[closes.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
}

function _drawNoData(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(100,116,139,0.3)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('無資料', canvas.width / 2, canvas.height / 2 + 3);
}

function _buildAiPrompt(themeName) {
  return `我正在整理台股「${themeName}」題材的個股清單。

請幫我列出這個題材中，台灣股市（上市/上櫃）具代表性的相關個股，包含：
- 直接受益的核心標的
- 供應鏈上下游重要廠商

請以 JSON 陣列格式回覆，每筆包含以下欄位：
- code：台股股票代號（4~5碼數字）
- name：公司中文名稱
- reason：簡短說明為何納入此題材（30字以內）

格式範例：
[
  { "code": "2330", "name": "台積電", "reason": "全球最大晶圓代工，AI 晶片主要製造商" },
  { "code": "6669", "name": "緯穎", "reason": "AI 伺服器 ODM，輝達主力供應商" }
]

只回覆 JSON，不需要其他說明文字。`;
}


// ════════════════════════════════════════════════════════════
// 妖股查詢 Modal
// ════════════════════════════════════════════════════════════
function _openYaoguScanModal() {
  let _scanType = 'rocket'; // 'rocket' | 'valley'
  let _parsedStocks = [];

  _showModal(`
    <div class="tm-modal-title">妖股查詢</div>

    <!-- 類型選擇 -->
    <div class="ys-type-row">
      <button class="ys-type-btn active" id="ysBtnRocket" data-type="rocket">
        <span class="ys-type-icon">🚀</span>
        <span class="ys-type-label">近期飆股</span>
        <span class="ys-type-desc">主升段、強者恆強</span>
      </button>
      <button class="ys-type-btn" id="ysBtnValley" data-type="valley">
        <span class="ys-type-icon">🌱</span>
        <span class="ys-type-label">谷底翻身</span>
        <span class="ys-type-desc">跌深反彈、等待確認</span>
      </button>
    </div>

    <!-- 價格區間 -->
    <div class="tm-section-label" style="margin-top:14px">② 價格區間</div>
    <div class="ys-price-filter-block">
      <div class="ys-price-presets">
        <button class="ys-preset-btn" data-min="0" data-max="50">50以下</button>
        <button class="ys-preset-btn" data-min="0" data-max="100">100以下</button>
        <button class="ys-preset-btn" data-min="0" data-max="300">300以下</button>
        <button class="ys-preset-btn" data-min="0" data-max="500">500以下</button>
        <button class="ys-preset-btn ys-preset-btn--active" data-min="0" data-max="">不限</button>
      </div>
      <div class="ys-price-inputs">
        <span class="ys-price-label">自訂</span>
        <input class="tm-input ys-price-input" id="ysPriceMin" type="number" placeholder="最低" min="0" value="">
        <span class="ys-price-sep">—</span>
        <input class="tm-input ys-price-input" id="ysPriceMax" type="number" placeholder="最高" min="0" value="">
        <span class="ys-price-unit">元</span>
      </div>
    </div>

    <!-- AI 輔助 -->
    <div class="tm-section-label" style="margin-top:14px">③ AI 掃描</div>
    <div class="ys-ai-box" id="ysAiBox">
      <div class="tm-ai-header">
        <span class="ys-ai-label" id="ysAiLabel">🚀 讓 AI 找出近期飆股</span>
        <button class="tm-copy-btn" id="ysCopyPrompt">複製 Prompt</button>
      </div>
      <div class="ys-ai-steps" id="ysAiSteps">複製 Prompt（已含價格條件）→ 貼給 AI → 把 JSON 貼回下方</div>
      <textarea class="tm-input tm-textarea tm-json-input" id="ysJsonInput"
        placeholder='貼上 AI 回覆的 JSON，例：
[
  { "code": "2330", "name": "台積電", "reason": "..." },
  { "code": "3017", "name": "奇鋐",  "reason": "..." }
]'></textarea>
      <button class="tm-parse-btn" id="ysParseJson">解析並預覽</button>
      <div class="tm-parse-result" id="ysParseResult"></div>
    </div>

    <!-- 預覽區 -->
    <div id="ysPreviewWrap" style="display:none">
      <div class="tm-section-label" style="margin-top:14px">
        預覽 <span id="ysPreviewCount"></span>
      </div>
      <div class="ys-preview-grid" id="ysPreviewGrid"></div>
    </div>

    <div class="tm-modal-actions">
      <button class="tm-btn tm-btn--cancel" id="tmCancel">取消</button>
      <button class="tm-btn tm-btn--ok" id="ysSave" style="display:none">存為題材</button>
    </div>`, 'large');

  // ── 類型切換 ────────────────────────────────────────────────
  function _switchType(type) {
    _scanType = type;
    _parsedStocks = [];
    document.getElementById('ysPreviewWrap').style.display = 'none';
    document.getElementById('ysSave').style.display = 'none';
    document.getElementById('ysJsonInput').value = '';
    document.getElementById('ysParseResult').textContent = '';

    document.querySelectorAll('.ys-type-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.type === type);
    });

    const isRocket = type === 'rocket';
    document.getElementById('ysAiLabel').textContent  = isRocket ? '🚀 讓 AI 找出近期飆股' : '🌱 讓 AI 找出谷底翻身股';
    document.getElementById('ysAiSteps').textContent  = '複製 Prompt → 貼給 AI → 把 JSON 貼回下方';
    document.getElementById('ysAiBox').className      = `ys-ai-box ys-ai-box--${type}`;
  }

  document.getElementById('ysBtnRocket').addEventListener('click', () => _switchType('rocket'));
  document.getElementById('ysBtnValley').addEventListener('click', () => _switchType('valley'));

  // 價格快捷按鈕
  document.querySelectorAll('.ys-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ys-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('ysPriceMin').value = btn.dataset.min ?? '';
      document.getElementById('ysPriceMax').value = btn.dataset.max ?? '';
    });
  });
  // 手動輸入時取消 preset active
  ['ysPriceMin','ysPriceMax'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      document.querySelectorAll('.ys-preset-btn').forEach(b => b.classList.remove('active'));
    });
  });

  // ── 複製 Prompt ─────────────────────────────────────────────
  document.getElementById('ysCopyPrompt').addEventListener('click', () => {
    const priceMin = parseFloat(document.getElementById('ysPriceMin')?.value) || 0;
    const priceMax = parseFloat(document.getElementById('ysPriceMax')?.value) || 0;
    const txt = _scanType === 'rocket'
      ? _buildRocketPrompt(priceMin, priceMax)
      : _buildValleyPrompt(priceMin, priceMax);
    navigator.clipboard.writeText(txt).then(() => {
      const btn = document.getElementById('ysCopyPrompt');
      if (!btn) return;
      btn.textContent = '✓ 已複製';
      setTimeout(() => { if (document.getElementById('ysCopyPrompt')) btn.textContent = '複製 Prompt'; }, 2000);
    });
  });

  // ── 解析 JSON ───────────────────────────────────────────────
  document.getElementById('ysParseJson').addEventListener('click', async () => {
    const raw = document.getElementById('ysJsonInput').value.trim();
    const result = document.getElementById('ysParseResult');
    if (!raw) { result.textContent = '請先貼上 JSON'; result.className = 'tm-parse-result tm-err'; return; }

    try {
      const clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      _parsedStocks = JSON.parse(clean);
      if (!Array.isArray(_parsedStocks)) throw new Error('需要陣列格式');
    } catch (e) {
      result.textContent = `JSON 解析失敗：${e.message}`;
      result.className = 'tm-parse-result tm-err';
      return;
    }

    // ── Step 1：解析 + 股名用 nameCache 修正 ────────────────
    const nameCache = window.__nameCache ?? new Map();
    let invalidCodes = [];

    _parsedStocks = _parsedStocks.map(s => {
      const code   = String(s.code   ?? s['代號'] ?? '').trim();
      const aiName = String(s.name   ?? s['股名'] ?? s['名稱'] ?? '').trim();
      const reason = String(s.reason ?? s['理由'] ?? '').trim();
      if (!code) return null;

      const realName = nameCache.get(code)
        || getChineseName(code)
        || (window.__priceCache ?? {})[code]?.name
        || aiName;  // 最後 fallback 用 AI 給的名稱
      if (!realName) {
        // 三層 fallback 都沒有 → 才視為無效代號
        invalidCodes.push(code);
        return null;
      }
      // 股名自動修正（以 nameCache 為準）
      const name = realName;
      if (aiName && aiName !== realName) {
        console.log(`[theme] 股名修正 ${code}: "${aiName}" → "${realName}"`);
      }
      return { code, name, reason };
    }).filter(Boolean);

    // ── Step 2：價格區間過濾 ──────────────────────────────────
    const priceMin = parseFloat(document.getElementById('ysPriceMin')?.value) || 0;
    const priceMax = parseFloat(document.getElementById('ysPriceMax')?.value) || Infinity;
    let priceFiltered = 0;
    if (priceMax < Infinity || priceMin > 0) {
      const before = _parsedStocks.length;
      _parsedStocks = _parsedStocks.filter(s => {
        const p = (window.__priceCache ?? {})[s.code]?.price;
        if (p == null) return true;
        return p >= priceMin && p <= priceMax;
      });
      priceFiltered = before - _parsedStocks.length;
    }

    // ── Step 3：讀 signals_cache，3 天內有 X 訊號的標記 ──────
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let xTagged = 0;
    const total = _parsedStocks.length;

    result.textContent = `掃描妖股訊號… 0/${total}`;
    result.className = 'tm-parse-result';

    for (const [_si, s] of _parsedStocks.entries()) {
      result.textContent = `掃描妖股訊號… ${_si + 1}/${total}`;
      try {
        // 先查 cache，沒有再掃
        let cached = await getAllSignalsCache().then(all => all.find(r => r.code === s.code));
        const isFresh = cached && (now - (cached.scannedAt ?? 0)) < THREE_DAYS;

        let sigs = [];
        if (isFresh) {
          sigs = cached.signals ?? [];
        } else {
          // cache 沒有或超過 3 天，即時掃一次（5 秒 timeout，避免 proxy 全掛時卡死）
          sigs = await Promise.race([
            scanOneCode(s.code, { silent: true }),
            new Promise(res => setTimeout(() => res([]), 5000)),
          ]);
        }

        const x1 = sigs.some(sg => sg.id === 'X1');
        const x2 = sigs.some(sg => sg.id === 'X2');
        const x5 = sigs.some(sg => sg.id === 'X5');
        if (x1 || x2 || x5) {
          s._sigs = { x1, x2, x5, strongest: x2?'X2':x1?'X1':'X5' };
          _yaoguMap.set(s.code, s._sigs);
          xTagged++;
        }
      } catch(e) {
        console.warn(`[theme] 訊號讀取失敗 ${s.code}:`, e.message);
      }
    }

    // ── Step 4：結果摘要 ─────────────────────────────────────
    const msgs = [`✓ 找到 ${_parsedStocks.length} 檔`];
    if (invalidCodes.length) msgs.push(`無效代號剔除 ${invalidCodes.length} 筆`);
    if (priceFiltered)       msgs.push(`價格過濾 ${priceFiltered} 檔`);
    if (xTagged)             msgs.push(`🚀 ${xTagged} 檔有 X 訊號`);

    result.textContent = msgs.join('，');
    result.className = _parsedStocks.length > 0 ? 'tm-parse-result tm-ok' : 'tm-parse-result tm-err';
    document.getElementById('ysJsonInput').value = '';
    _renderYaoguPreview();
  });

  // ── 取消 / 儲存 ─────────────────────────────────────────────
  document.getElementById('tmCancel').addEventListener('click', _closeModal);

  document.getElementById('ysSave').addEventListener('click', async () => {
    if (!_parsedStocks.length) return;
    const isRocket = _scanType === 'rocket';
    const data = {
      id:     genId(),
      emoji:  isRocket ? '🚀' : '🌱',
      name:   isRocket ? '近期飆股掃描' : '谷底翻身觀察',
      desc:   isRocket ? 'AI 掃描近期主升段強勢股，技術面 + 量能雙確認' : 'AI 掃描跌深反彈訊號股，等待底部確認進場',
      color:  isRocket ? 'red' : 'green',
      order:  window.__themeData?.themes?.length ?? 0,
      stocks: _parsedStocks,
      _yaoguType: _scanType,  // 標記為妖股掃描題材，渲染時特殊處理
    };
    await saveUserTheme(data);
    _closeModal();
    _activeIdx = window.__themeData?.themes?.length ?? 0;
    await _refresh();
    renderThemePanel();
  });

  // ── 預覽渲染 ────────────────────────────────────────────────
  function _renderYaoguPreview() {
    const wrap  = document.getElementById('ysPreviewWrap');
    const grid  = document.getElementById('ysPreviewGrid');
    const count = document.getElementById('ysPreviewCount');
    const save  = document.getElementById('ysSave');
    if (!wrap || !grid) return;

    wrap.style.display = '';
    save.style.display = '';
    count.textContent = `（${_parsedStocks.length} 檔）`;

    const isRocket = _scanType === 'rocket';
    grid.innerHTML = _parsedStocks.map((s, i) => {
      const p = (window.__priceCache ?? {})[s.code];
      const chg = p?.chgPct ?? p?.changePercent;
      const chgHtml = chg != null
        ? `<span class="theme-stock-price ${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${Number(chg).toFixed(2)}%</span>`
        : '';
      const sg = s._sigs;
      const xPills = sg ? [
        sg.x2 ? '<span class="th-yaogu-pill th-yaogu-pill--x2">X2</span>' : '',
        sg.x1 ? '<span class="th-yaogu-pill th-yaogu-pill--x1">X1</span>' : '',
        sg.x5 ? '<span class="th-yaogu-pill th-yaogu-pill--x5">X5</span>' : '',
      ].join('') : '';
      return `
        <div class="ys-preview-card ys-preview-card--${_scanType}">
          <div class="ys-card-rank">${i + 1}</div>
          <div class="ys-card-body">
            <div class="ys-card-header">
              <span class="theme-stock-code">${s.code}</span>
              <span class="theme-stock-name">${s.name}</span>
              ${chgHtml}
              ${xPills}
              <button class="ys-card-del" data-i="${i}">✕</button>
            </div>
            <div class="ys-card-reason">${s.reason}</div>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.ys-card-del').forEach(btn => {
      btn.addEventListener('click', () => {
        _parsedStocks.splice(+btn.dataset.i, 1);
        _renderYaoguPreview();
      });
    });
  }
}

// ── 🚀 近期飆股 Prompt ────────────────────────────────────────
function _buildRocketPrompt(priceMin = 0, priceMax = 0) {
  const priceCondition = priceMax > 0
    ? `- 股價介於 ${priceMin} ~ ${priceMax} 元之間`
    : priceMin > 0 ? `- 股價高於 ${priceMin} 元` : '';
  const priceExclude = priceMax > 0 ? `- 剔除股價超過 ${priceMax} 元的個股` : '';
  return `你是台股技術分析專家。請幫我找出台股近期符合以下條件的「近期飆股」：

選股條件（同時符合越多越好）：
1. 股價突破近期整理區，站上 MA20 且 MA20 > MA60
2. 成交量較近 20 日均量放大 1.5 倍以上
3. MACD 黃金交叉或多頭排列（快線在慢線上方）
4. RSI 介於 55~80（強勢但未過熱，排除 RSI < 50 的弱勢股）
5. 近 5 日漲幅 > 5%，且為「多日小漲」型態，非單日暴漲後拉回
6. 主力籌碼持續買超（外資或投信擇一買超）
7. 近 3 日無連續收黑（確認買盤持續）
8. 短線動能強，非整理末段的弱反彈

嚴格排除條件：
- 排除金融股、營建股、航運股、傳產股（電線電纜、鋼鐵、紡織、食品）
- 排除月 KD 死叉的長線弱勢股

選股價格條件：
- 剔除股價 < 10 元的低價股
${priceCondition}

排除條件：
${priceExclude}
- 剔除近期有重大利空的個股
- 剔除純炒作無基本面的個股

請列出 15~25 檔，優先選擇有基本面支撐的標的。

回覆格式（只回覆 JSON，不要任何說明）：
[
  { "code": "台股代號", "name": "公司中文名", "reason": "符合條件的具體說明（30字以內）" }
]`;
}

// ── 🌱 谷底翻身 Prompt ───────────────────────────────────────
function _buildValleyPrompt(priceMin = 0, priceMax = 0) {
  const priceCondition = priceMax > 0
    ? `- 股價介於 ${priceMin} ~ ${priceMax} 元之間`
    : priceMin > 0 ? `- 股價高於 ${priceMin} 元` : '';
  const priceExclude = priceMax > 0 ? `- 剔除股價超過 ${priceMax} 元的個股` : '';
  return `你是台股技術分析專家。請幫我找出台股近期符合以下條件的「谷底翻身」候選股：

選股條件（同時符合越多越好）：
1. 距離近期高點跌幅超過 30%，處於相對低位
2. 近期出現止跌訊號：量縮後突然爆量，或 K 線出現錘頭線/十字星
3. MACD 低位金叉，或出現底背離（價格創新低但 MACD 未創新低）
4. RSI 從超賣區（< 30）回升至 40 以上
5. 週線級別出現支撐（前波低點或整數關卡）
6. 基本面未明顯惡化（EPS 正值，營收未連續衰退超過 3 季）
7. 近 3 日收紅或出現轉折 K 棒（確認底部成形，非持續下跌中）
8. 月線仍在多頭位置（不選已破長線支撐的股票）

嚴格排除條件：
- 排除金融股、營建股、航運股、傳產股（電線電纜、鋼鐵、紡織、食品）
- 排除短線健康度 < 30 的極弱勢股（太弱不是谷底，是持續下跌）

選股價格條件：
- 剔除股價 < 10 元的低價股
${priceCondition}

排除條件：
${priceExclude}
- 剔除財務體質有問題（高負債或虧損連續超過 2 年）
- 剔除純炒作後崩跌的個股

請列出 15~20 檔，優先選擇跌深但基本面尚可的標的。

回覆格式（只回覆 JSON，不要任何說明）：
[
  { "code": "台股代號", "name": "公司中文名", "reason": "符合條件的具體說明（30字以內）" }
]`;
}

// ════════════════════════════════════════════════════════════
// 以個股搜尋題材 Modal
// ════════════════════════════════════════════════════════════
function _openStockSearchModal() {
  _showModal(`
    <div class="tm-modal-title">🔍 以個股搜尋相關題材</div>

    <div class="tm-section-label">① 輸入個股</div>
    <div class="tm-manual-row" style="margin-bottom:12px">
      <input class="tm-input" id="ssCode" placeholder="代號" maxlength="6" style="width:80px;flex:0 0 auto">
      <input class="tm-input" id="ssName" placeholder="股名（輸入代號自動帶入）" style="flex:1" readonly>
    </div>

    <div class="tm-section-label">② AI 輔助探索</div>
    <div class="tm-ai-box">
      <div class="tm-ai-header">
        <span class="tm-ai-label">🤖 讓 AI 找出相關題材與個股</span>
        <button class="tm-copy-btn" id="ssCopyPrompt">複製 Prompt</button>
      </div>
      <div class="tm-ai-steps">複製 Prompt → 貼給 AI → 把 AI 回覆的 JSON 貼回下方</div>
      <textarea class="tm-input tm-textarea tm-json-input" id="ssJsonInput"
        placeholder='貼上 AI 回覆的 JSON，例：
[
  {
    "theme": "AI 伺服器",
    "emoji": "🖥️",
    "color": "blue",
    "desc": "...",
    "stocks": [
      { "code": "2330", "name": "台積電", "reason": "..." }
    ]
  }
]'></textarea>
      <button class="tm-parse-btn" id="ssParseJson">解析並預覽</button>
      <div class="tm-parse-result" id="ssParseResult"></div>
    </div>

    <div id="ssPreviewWrap" style="display:none">
      <div class="tm-section-label" style="margin-top:12px">
        ③ 選擇要建立的題材
        <span class="ss-select-all-wrap">
          <label><input type="checkbox" id="ssSelectAll" checked> 全選</label>
        </span>
      </div>
      <div id="ssPreviewList" class="ss-preview-list"></div>
    </div>

    <div class="tm-modal-actions">
      <button class="tm-btn tm-btn--cancel" id="tmCancel">取消</button>
      <button class="tm-btn tm-btn--ok" id="ssSave" style="display:none">建立勾選的題材</button>
    </div>`, 'large');

  let parsedThemes = [];

  // 代號自動帶股名
  const codeEl = document.getElementById('ssCode');
  const nameEl = document.getElementById('ssName');
  codeEl.addEventListener('input', () => {
    const n = window.__nameCache?.get?.(codeEl.value.trim());
    nameEl.value = n ?? '';
  });

  // 複製 Prompt
  document.getElementById('ssCopyPrompt').addEventListener('click', () => {
    const code = codeEl.value.trim();
    const name = nameEl.value.trim();
    if (!code) { _shake('ssCode'); return; }
    const txt = _buildStockSearchPrompt(code, name);
    navigator.clipboard.writeText(txt).then(() => {
      const btn = document.getElementById('ssCopyPrompt');
      if (!btn) return;
      btn.textContent = '✓ 已複製';
      setTimeout(() => { if (document.getElementById('ssCopyPrompt')) btn.textContent = '複製 Prompt'; }, 2000);
    });
  });

  // 解析 JSON
  document.getElementById('ssParseJson').addEventListener('click', () => {
    const raw = document.getElementById('ssJsonInput').value.trim();
    const result = document.getElementById('ssParseResult');
    if (!raw) { result.textContent = '請先貼上 JSON'; result.className = 'tm-parse-result tm-err'; return; }

    try {
      const clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      parsedThemes = JSON.parse(clean);
      if (!Array.isArray(parsedThemes)) throw new Error('需要陣列格式');
      parsedThemes.forEach(t => {
        if (!t.theme && !t.name) throw new Error('每個題材需要有 theme 或 name 欄位');
      });
    } catch (e) {
      result.textContent = `JSON 解析失敗：${e.message}`;
      result.className = 'tm-parse-result tm-err';
      return;
    }

    result.textContent = `✓ 找到 ${parsedThemes.length} 個題材`;
    result.className = 'tm-parse-result tm-ok';
    document.getElementById('ssJsonInput').value = '';
    _renderStockSearchPreview(parsedThemes);
  });

  // 全選
  document.getElementById('ssSelectAll').addEventListener('change', e => {
    document.querySelectorAll('.ss-theme-check').forEach(cb => { cb.checked = e.target.checked; });
  });

  // 取消
  document.getElementById('tmCancel').addEventListener('click', _closeModal);

  // 儲存
  document.getElementById('ssSave').addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.ss-theme-check:checked')];
    if (!checked.length) return;

    const existing = window.__themeData?.themes ?? [];
    let created = 0;

    for (const cb of checked) {
      const idx = +cb.dataset.idx;
      const t = parsedThemes[idx];
      const name = t.theme ?? t.name ?? '未命名題材';

      // 重複檢查
      const isDup = existing.some(e => e.name === name);

      const data = {
        id:     genId(),
        emoji:  t.emoji  ?? '📌',
        name,
        desc:   t.desc   ?? '',
        color:  t.color  ?? 'gray',
        order:  existing.length + created,
        stocks: (t.stocks ?? []).map(s => ({
          code:   String(s.code ?? '').trim(),
          name:   String(s.name ?? s.股名 ?? '').trim(),
          reason: String(s.reason ?? s.理由 ?? '').trim(),
        })).filter(s => s.code && s.name),
      };

      if (isDup) {
        // 合併個股到現有題材
        const existTheme = existing.find(e => e.name === name);
        const merged = [...(existTheme.stocks ?? [])];
        data.stocks.forEach(s => {
          if (!merged.some(m => m.code === s.code)) merged.push(s);
        });
        await saveUserTheme({ ...existTheme, stocks: merged });
      } else {
        await saveUserTheme(data);
        created++;
      }
    }

    _closeModal();
    _activeIdx = Math.max(0, (window.__themeData?.themes?.length ?? 0) - 1);
    await _refresh();
    renderThemePanel();
  });
}

function _renderStockSearchPreview(themes) {
  const wrap = document.getElementById('ssPreviewWrap');
  const list = document.getElementById('ssPreviewList');
  const saveBtn = document.getElementById('ssSave');
  if (!wrap || !list) return;

  const existing = new Set((window.__themeData?.themes ?? []).map(t => t.name));

  wrap.style.display = '';
  saveBtn.style.display = '';

  list.innerHTML = themes.map((t, i) => {
    const name = t.theme ?? t.name ?? '未命名';
    const isDup = existing.has(name);
    const c = COLORS[t.color] ?? COLORS.gray;
    const stockCount = (t.stocks ?? []).length;
    return `
      <div class="ss-preview-row">
        <input type="checkbox" class="ss-theme-check" data-idx="${i}" checked>
        <span class="ss-preview-emoji">${t.emoji ?? '📌'}</span>
        <div class="ss-preview-info">
          <div class="ss-preview-name" style="color:${c.text}">
            ${name}
            ${isDup ? '<span class="ss-dup-badge">已存在（將合併個股）</span>' : ''}
          </div>
          <div class="ss-preview-desc">${t.desc ?? ''}</div>
          <div class="ss-preview-stocks">${stockCount} 檔個股：${(t.stocks ?? []).slice(0, 5).map(s => s.name ?? s.code).join('、')}${stockCount > 5 ? '…' : ''}</div>
        </div>
      </div>`;
  }).join('');

  // 全選 checkbox 狀態同步
  list.querySelectorAll('.ss-theme-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const all = [...list.querySelectorAll('.ss-theme-check')];
      document.getElementById('ssSelectAll').checked = all.every(c => c.checked);
    });
  });
}

function _buildStockSearchPrompt(code, name) {
  const label = name ? `${name}（${code}）` : code;
  return `我想了解台股 ${label} 這檔股票屬於哪些投資題材。

請幫我：
1. 找出這檔股票所屬的 3~5 個投資題材（例如：AI 伺服器、先進封裝、電動車供應鏈等）
2. 對每個題材，列出台股中具代表性的相關個股（含 ${label} 本身）

請以 JSON 陣列格式回覆，結構如下：
[
  {
    "theme": "題材名稱",
    "emoji": "一個代表性 emoji",
    "color": "blue",
    "desc": "這個題材的簡短說明（30字以內）",
    "stocks": [
      { "code": "股票代號", "name": "公司中文名稱", "reason": "納入此題材的原因（20字以內）" }
    ]
  }
]

color 請從以下選一個：blue / green / red / yellow / purple / orange / cyan / gray
只回覆 JSON，不需要其他說明文字。`;
}

// ── 刪除確認 ─────────────────────────────────────────────────
function _confirmDelete(theme) {
  _showModal(`
    <div class="tm-modal-title">刪除題材</div>
    <div class="tm-modal-body">確定要刪除「${theme.emoji} ${theme.name}」？<br>此操作無法復原。</div>
    <div class="tm-modal-actions">
      <button class="tm-btn tm-btn--cancel" id="tmCancel">取消</button>
      <button class="tm-btn tm-btn--danger" id="tmOk">確定刪除</button>
    </div>`);
  document.getElementById('tmCancel').addEventListener('click', _closeModal);
  document.getElementById('tmOk').addEventListener('click', async () => {
    await deleteUserTheme(theme.id);
    _closeModal(); _activeIdx = 0;
    await _refresh(); renderThemePanel();
  });
}

// ── 關聯 Tab ─────────────────────────────────────────────────
function _renderRelation(container, themes, stockThemeMap) {
  const hc = document.getElementById('themeHeaderCount');
  if (hc) hc.textContent = `${themes.length} 個題材`;
  const n = themes.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const setI = new Set((themes[i].stocks ?? []).map(s => s.code));
    const ov = (themes[j].stocks ?? []).filter(s => setI.has(s.code));
    matrix[i][j] = matrix[j][i] = ov;
  }
  const ranked = [...stockThemeMap.entries()].filter(([,s])=>s.size>=2).sort((a,b)=>b[1].size-a[1].size).slice(0,5);

  let mHtml = `<div class="theme-matrix-wrap"><table class="theme-matrix"><thead><tr><th></th>`;
  themes.forEach(t => { mHtml += `<th title="${t.name}">${t.emoji}</th>`; });
  mHtml += `</tr></thead><tbody>`;
  themes.forEach((t,i) => {
    const c = gc(t.color);
    mHtml += `<tr><td class="theme-matrix-label" style="color:${c.text}">${t.emoji} ${t.name}</td>`;
    themes.forEach((_,j) => {
      if (i===j) { mHtml += `<td class="theme-matrix-self">—</td>`; return; }
      const ov=matrix[i][j]??[];
      mHtml += `<td class="${ov.length?'theme-matrix-hit':'theme-matrix-zero'}" title="${ov.map(s=>`${s.name}(${s.code})`).join('、')}" data-i="${i}" data-j="${j}">${ov.length||''}</td>`;
    });
    mHtml += `</tr>`;
  });
  mHtml += `</tbody></table></div>`;

  let topHtml = '';
  if (ranked.length) {
    topHtml = `<div class="theme-section-title" style="margin-top:24px">🏆 跨題材最廣個股</div><div class="theme-topn-list">`;
    ranked.forEach(([code,idxSet]) => {
      const name = window.__nameCache?.get?.(code)??'';
      const tags = [...idxSet].map(i=>{const t=themes[i];if(!t)return'';const c=gc(t.color);return`<span class="theme-cross-tag" style="background:${c.bg};color:${c.text};border-color:${c.border}">${t.emoji} ${t.name}</span>`;}).join('');
      topHtml += `<div class="theme-topn-row" data-code="${code}"><span class="theme-stock-code">${code}</span><span class="theme-stock-name">${name}</span><div class="theme-cross-tags" style="margin:0">${tags}</div><span class="theme-topn-badge">${idxSet.size} 題材</span></div>`;
    });
    topHtml += `</div>`;
  }

  container.innerHTML = `<div class="theme-relation">
    <div class="theme-section-title">📊 題材交叉矩陣<span style="font-size:11px;font-weight:400;margin-left:8px;text-transform:none;letter-spacing:0">點擊數字查看共同個股</span></div>
    ${mHtml}${topHtml}</div>`;

  container.querySelectorAll('.theme-matrix-hit').forEach(cell => {
    cell.addEventListener('click', () => {
      const ov=matrix[+cell.dataset.i][+cell.dataset.j]??[];
      if(ov.length) _showOverlapPopup(themes[+cell.dataset.i],themes[+cell.dataset.j],ov);
    });
  });
  container.querySelectorAll('.theme-topn-row').forEach(row => {
    row.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('stockSelect',{detail:{code:row.dataset.code}}));
      document.querySelector('.main-tab[data-tab="chart"]')?.click();
    });
  });
}

// ── Overlap Popup ─────────────────────────────────────────────
function _showOverlapPopup(themeA, themeB, stocks) {
  document.getElementById('themeOverlapPopup')?.remove();
  const cA=gc(themeA.color),cB=gc(themeB.color);
  const popup=document.createElement('div');
  popup.id='themeOverlapPopup'; popup.className='theme-overlap-popup';
  popup.innerHTML=`<div class="theme-overlap-header">
    <span style="color:${cA.text}">${themeA.emoji} ${themeA.name}</span>
    <span class="theme-overlap-x">×</span>
    <span style="color:${cB.text}">${themeB.emoji} ${themeB.name}</span>
    <span class="theme-overlap-count">${stocks.length} 檔</span>
    <button class="theme-overlap-close" id="themeOverlapClose">✕</button>
  </div>
  <div class="theme-overlap-list">${stocks.map(s=>`<div class="theme-overlap-row" data-code="${s.code}"><span class="theme-stock-code">${s.code}</span><span class="theme-stock-name">${s.name}</span></div>`).join('')}</div>`;
  document.body.appendChild(popup);
  popup.querySelectorAll('.theme-overlap-row').forEach(r=>{r.addEventListener('click',()=>{document.dispatchEvent(new CustomEvent('stockSelect',{detail:{code:r.dataset.code}}));document.querySelector('.main-tab[data-tab="chart"]')?.click();popup.remove();});});
  document.getElementById('themeOverlapClose').addEventListener('click',()=>popup.remove());
  setTimeout(()=>{document.addEventListener('click',function h(e){if(!popup.contains(e.target)){popup.remove();document.removeEventListener('click',h);}});},100);
}

// ── Modal 工具 ────────────────────────────────────────────────
function _showModal(html, size='normal') {
  document.getElementById('themeModal')?.remove();
  const backdrop=document.createElement('div');
  backdrop.id='themeModal'; backdrop.className='tm-backdrop';
  backdrop.innerHTML=`<div class="tm-modal ${size==='large'?'tm-modal--large':''}">${html}</div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click',e=>{if(e.target===backdrop)_closeModal();});
  setTimeout(()=>backdrop.querySelector('input:not([readonly])')?.focus(),50);
}
function _closeModal() { document.getElementById('themeModal')?.remove(); }
function _shake(id) {
  const el=document.getElementById(id); if(!el) return;
  el.style.animation='tmShake .3s';
  el.addEventListener('animationend',()=>{el.style.animation='';},{once:true});
}
function _toast(msg) {
  const t = document.createElement('div');
  t.className = 'tm-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('tm-toast--show'));
  setTimeout(() => {
    t.classList.remove('tm-toast--show');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  }, 2800);
}

// ── 重新整理 ─────────────────────────────────────────────────
async function _refresh() {
  await reloadThemes();
  const { themes, stockThemeMap } = window.__themeData;
  if (_activeIdx > themes.length) _activeIdx = Math.max(0, themes.length-1);
  _renderTabBar(themes, stockThemeMap);
  _showTab(_activeIdx, themes, stockThemeMap);
}
