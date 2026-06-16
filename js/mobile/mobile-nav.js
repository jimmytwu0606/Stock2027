/**
 * mobile-nav.js — Phase 10.3
 * 框架：頂部 topbar 常駐 + ☰ 抽屜，無左側側欄
 * 所有頁面（看盤/自選/篩選/設定/個股）都在同一個全寬框架內切換
 */

import { buildSettingsPanel } from './mobile-settings.js';
import { getMainChart } from '../chart.js';

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;
let _deps = {};
export function setNavDeps(deps) { _deps = deps; }

const STOCK_TABS = [
  { id: 'chart',    label: 'K線圖',   icon: '📈' },
];
const NAV_ITEMS = [
  { page: 'chart',     label: '看盤',     icon: '📈' },
  { page: 'watchlist', label: '自選清單', icon: '★'  },
  { page: 'screener',  label: '篩選',     icon: '🔍' },
  { page: 'settings',  label: '設定',     icon: '⚙'  },
];

let _drawerOpen  = false;
let _currentPage = 'chart';
let _inStock     = false;  // 是否在個股頁

// ── 初始化 ─────────────────────────────────────────────────────────────────
export function initMobileNav() {
  if (!isMobile()) return;
  _buildTopbar();
  _showPage('chart');

  // 手機主圖撐滿：副圖隱藏後留下的黑塊 → 每次圖重繪把主圖高度填到可用空間
  // 用 getMainChart().applyOptions（不寫 localStorage，桌機不受影響；isMobile 再擋一層）
  window.addEventListener('chartRendered', () => requestAnimationFrame(() => { _forceMobileIndicators(); _fitMobileChart(); }));
  window.addEventListener('orientationchange', () => setTimeout(_fitMobileChart, 200));
  window.addEventListener('resize', () => { clearTimeout(_fitTimer); _fitTimer = setTimeout(_fitMobileChart, 200); });

  window.__mobileOpenStock = () => {
    openMobileStockPage();
    _showStockContent('chart');
  };
}

let _fitTimer = null;
function _fitMobileChart() {
  if (!isMobile()) return;
  try {
    const chart  = getMainChart?.();
    const mainEl = document.getElementById('mainChart');
    if (!chart || !mainEl) return;
    const top = document.getElementById('mTopbar')?.offsetHeight || 52;
    const hdr = document.getElementById('stockHeader')?.offsetHeight || 0;
    const bar = document.getElementById('mKlineBar')?.offsetHeight || 0;
    const avail = window.innerHeight - top - hdr - bar - 6;
    const h = Math.max(260, Math.round(avail));
    chart.applyOptions({ height: h });
    window._chartResize?.();
  } catch (_) {}
}

// ── Topbar + 抽屜 ──────────────────────────────────────────────────────────
function _buildTopbar() {
  if (document.getElementById('mTopbar')) return;

  // topbar
  const topbar = document.createElement('div');
  topbar.id = 'mTopbar';
  topbar.innerHTML = `
    <button id="mMenuBtn" aria-label="選單">☰</button>
    <div id="mTopbarBrand">
      <img src="favicon.svg" alt="" id="mTopbarLogo"/>
      <span id="mTopbarName">dengdeng</span>
    </div>
    <div id="mTopbarRight"></div>
  `;
  document.body.appendChild(topbar);

  // overlay
  const overlay = document.createElement('div');
  overlay.id = 'mDrawerOverlay';
  document.body.appendChild(overlay);

  // drawer
  const drawer = document.createElement('nav');
  drawer.id = 'mDrawer';
  drawer.innerHTML = `
    ${NAV_ITEMS.map(n => `
      <button class="m-drawer-item m-drawer-nav" data-nav-page="${n.page}">
        <span>${n.icon}</span><span>${n.label}</span>
      </button>`).join('')}
    <div class="m-drawer-sep"></div>
    ${STOCK_TABS.map(t => `
      <button class="m-drawer-item m-drawer-stock" data-stock-tab="${t.id}" style="display:none">
        <span>${t.icon}</span><span>${t.label}</span>
      </button>`).join('')}
  `;
  document.body.appendChild(drawer);

  document.getElementById('mMenuBtn').addEventListener('click', () =>
    _drawerOpen ? _closeDrawer() : _openDrawer());
  overlay.addEventListener('click', _closeDrawer);

  // 直接綁在每個按鈕上（同 mobile-screener.js 做法）
  drawer.querySelectorAll('.m-drawer-nav').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.navPage;
      _closeDrawer();
      if (_inStock && (page === 'watchlist' || page === 'screener')) {
        _showStockContent(page);
      } else {
        if (_inStock) _exitStock();
        _showPage(page);
      }
    });
  });

  drawer.querySelectorAll('.m-drawer-stock').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.stockTab;
      _closeDrawer();
      _showStockContent('chart');
      _setDrawerStockActive(tab);
      window.__switchStockTab?.(tab);
      if (tab !== 'chart' && window.__stockDashCode)
        window.__loadStockPanel?.(tab, window.__stockDashCode);
    });
  });

  // main 留空間給 topbar
  document.querySelector('.main')?.classList.add('m-has-topbar');
}

// ── 頁面切換（非個股）─────────────────────────────────────────────────────
function _showPage(page) {
  _currentPage = page;

  // 進入任何頁面前，清除殘留
  if (_inStock || document.body.classList.contains('m-stock-open')) {
    _exitStock();
  }
  document.getElementById('mSettingsPage')?.remove();

  const PAGE_TITLES = {
    chart: 'dengdeng', watchlist: '自選清單', screener: '篩選', settings: '設定',
  };
  _setTopbarTitle(PAGE_TITLES[page] ?? '');
  _setTopbarRight('');

  // 隱藏所有個股專用 drawer 項目（只在個股頁才顯示）
  document.querySelectorAll('.m-drawer-stock').forEach(b => b.style.display = 'none');

  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  if (page === 'settings') {
    // 設定頁：獨立全寬，不走個股框架
    _openSettingsPage();
    return;
  }

  const map = { chart:'tabChart', watchlist:'tabWatchlist', screener:'tabHub' };
  const panelId = map[page];
  if (panelId) document.getElementById(panelId)?.classList.add('active');

  if (page === 'screener')
    document.dispatchEvent(new CustomEvent('mobileScreenerActivate'));
  if (page === 'watchlist')
    import('./mobile-watchlist.js').then(m => m.initMobileWatchlist?.()).catch(() => {});
}

// ── 個股頁 ─────────────────────────────────────────────────────────────────
export function openMobileStockPage(title) {
  if (!isMobile()) return;
  _inStock = true;
  document.body.classList.add('m-stock-open');
  document.getElementById('tabChart')?.classList.add('m-stock-active');
  // 顯示個股 drawer 項目
  document.querySelectorAll('.m-drawer-stock').forEach(b => b.style.display = '');
  if (title) _setTopbarTitle(title);
  _setDrawerStockActive('chart');
  _buildKlineBar();
  requestAnimationFrame(() => setTimeout(_fitMobileChart, 60));
}

export function closeMobileStockPage() {
  _exitStock();
  _showPage('chart');
}

function _exitStock() {
  _inStock = false;
  document.body.classList.remove('m-stock-open');
  document.getElementById('tabChart')?.classList.remove('m-stock-active');
  document.getElementById('mWatchlistPanel')?.remove();
  document.getElementById('mScreenerPanel')?.remove();
  document.getElementById('chartPanel') && (document.getElementById('chartPanel').style.display = '');
  document.querySelectorAll('.m-drawer-stock').forEach(b => b.style.display = 'none');
}

function _showStockContent(type) {
  const chartPanel = document.getElementById('chartPanel');
  const _hideAll = () => {
    document.getElementById('mWatchlistPanel')?.remove();
    document.getElementById('mScreenerPanel')?.remove();
    if (chartPanel) chartPanel.style.display = '';
  };

  if (type === 'watchlist') {
    _hideAll();
    if (chartPanel) chartPanel.style.display = 'none';
    const el = document.createElement('div');
    el.id = 'mWatchlistPanel';
    el.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding:12px 8px;';
    chartPanel?.parentElement?.appendChild(el);
    _setTopbarTitle('自選清單');
    import('./mobile-watchlist.js').then(m => m.renderIntoEl?.(el)).catch(() => {});
    _setDrawerStockActive(null);

  } else if (type === 'screener') {
    _hideAll();
    if (chartPanel) chartPanel.style.display = 'none';
    const el = document.createElement('div');
    el.id = 'mScreenerPanel';
    el.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;';
    chartPanel?.parentElement?.appendChild(el);
    _setTopbarTitle('篩選');
    import('./mobile-screener.js').then(m => m.renderIntoEl?.(el, _deps)).catch(() => {});
    _setDrawerStockActive(null);

  } else {
    _hideAll();
    if (window.__stockDashCode)
      _setTopbarTitle(window.__mobileStockName || window.__stockDashCode);
  }
}

// ── 設定頁（獨立全寬，不依賴個股框架）────────────────────────────────────
function _openSettingsPage() {
  // 關閉個股頁（如果開著）
  if (_inStock || document.body.classList.contains('m-stock-open')) {
    _exitStock();
  }

  // 移除舊的設定 panel
  document.getElementById('mSettingsPage')?.remove();

  const page = document.createElement('div');
  page.id = 'mSettingsPage';
  page.style.cssText = [
    'position:fixed;top:52px;left:0;right:0;bottom:0',
    'background:#0d1117;z-index:100',
    'overflow-y:auto;-webkit-overflow-scrolling:touch',
    'display:flex;flex-direction:column',
  ].join(';');
  document.body.appendChild(page);

  _setTopbarTitle('設定');

  import('./mobile-settings.js').then(m => m.renderIntoEl?.(page)).catch(() => {});
}

export function closeMobileSettingsPage() {
  document.getElementById('mSettingsPage')?.remove();
}

function _setTopbarTitle(text) {
  const el = document.getElementById('mTopbarRight');
  if (el) el.textContent = text;
}
function _setTopbarRight(html) {
  const el = document.getElementById('mTopbarRight');
  if (el) el.innerHTML = html;
}

export function updateMobileStockTitle(title) {
  _setTopbarTitle(title);
}

// ── 抽屜 ──────────────────────────────────────────────────────────────────
function _openDrawer() {
  _drawerOpen = true;
  document.getElementById('mDrawer')?.classList.add('open');
  document.getElementById('mDrawerOverlay')?.classList.add('open');
}
function _closeDrawer() {
  _drawerOpen = false;
  document.getElementById('mDrawer')?.classList.remove('open');
  document.getElementById('mDrawerOverlay')?.classList.remove('open');
}
function _setDrawerStockActive(tab) {
  document.querySelectorAll('.m-drawer-stock').forEach(b =>
    b.classList.toggle('active', b.dataset.stockTab === tab));
}

// ── K 線控制列 ─────────────────────────────────────────────────────────────
const _PERIOD_LABELS = {'5d':'5日','1mo':'1月','3mo':'3月','6mo':'6月','1y':'1年','2y':'2年'};

// 手機主圖固定均線 MA5/10/20/60（免切換）；副圖全關（手機不顯示副圖）
const _M_MA_ON   = ['MA5','MA10','MA20','MA60'];
const _M_SUB_OFF = ['KD','RSI','MACD','DMI','PSY','RCI','HV','CONV','TTM','OBV','RS'];
function _forceMobileIndicators() {
  if (!isMobile()) return;
  _M_MA_ON.forEach(ind => {
    const b = document.querySelector(`.ind-toggle[data-ind="${ind}"]`);
    if (b && !b.classList.contains('on')) b.click();
  });
  _M_SUB_OFF.forEach(ind => {
    const b = document.querySelector(`.ind-toggle[data-ind="${ind}"]`);
    if (b && b.classList.contains('on')) b.click();
  });
}

function _buildKlineBar() {
  if (document.getElementById('mKlineBar')) return;
  const bar = document.createElement('div');
  bar.id = 'mKlineBar';
  bar.innerHTML = `
    <select id="mPeriodSel" class="mkl-sel">
      ${Object.entries(_PERIOD_LABELS).map(([v,l]) =>
        `<option value="${v}"${v==='1mo'?' selected':''}>${l}</option>`).join('')}
    </select>
    <button id="mKlineRefresh" class="mkl-refresh-btn" style="
      padding:0 10px;height:32px;border-radius:8px;border:0.5px solid #30363d;
      background:rgba(88,166,255,0.1);color:#58a6ff;font-size:16px;cursor:pointer;flex-shrink:0;line-height:1">↺</button>
  `;
  const chartPanel = document.getElementById('chartPanel');
  if (chartPanel) chartPanel.insertBefore(bar, chartPanel.firstChild);

  document.getElementById('mPeriodSel')?.addEventListener('change', e => {
    document.querySelector(`.tb-btn[data-period="${e.target.value}"]`)?.click();
  });
  document.getElementById('mKlineRefresh')?.addEventListener('click', () => {
    const code = window.__stockDashCode;
    if (code) window.__loadStock?.(code, { force: true });
  });

  // 固定均線 + 關副圖（免切換）
  _forceMobileIndicators();
}
