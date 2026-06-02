/**
 * mobile-nav.js — Phase 10.1
 * 職責：
 *  1. 左側固定 4 btn 導航（看盤/自選/篩選/設定）
 *  2. 個股全頁覆蓋 + 側邊抽屜切換 stock tabs
 *
 * 完全不搬 DOM，不碰桌機版任何邏輯。
 */

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;
let _deps = {};
export function setNavDeps(deps) { _deps = deps; }

const STOCK_TABS = [
  { id: 'chart',    label: 'K線圖',   icon: '📈' },
  { id: 'analysis', label: '智能分析', icon: '🧠' },
];

// 底部導航項目（在抽屜下方）
const NAV_ITEMS = [
  { page: 'watchlist', label: '自選清單', icon: '★' },
  { page: 'screener',  label: '篩選',     icon: '🔍' },
  { page: 'settings',  label: '設定',     icon: '⚙' },
];

let _drawerOpen = false;
let _currentPage = 'chart';

// ── 初始化 ─────────────────────────────────────────────────────────────────
export function initMobileNav() {
  if (!isMobile()) return;
  _buildSideNav();
  _buildStockOverlay();
  _showPage('chart');
}

// ── 左側導航列 ─────────────────────────────────────────────────────────────
let _navCollapsed = false;

function _buildSideNav() {
  if (document.getElementById('mSideNav')) return;

  const nav = document.createElement('nav');
  nav.id = 'mSideNav';
  nav.innerHTML = `
    <button class="msn-btn active" data-page="chart">
      <span class="msn-icon">📈</span>
      <span class="msn-label">看盤</span>
    </button>
    <button class="msn-btn" data-page="watchlist">
      <span class="msn-icon">★</span>
      <span class="msn-label">自選</span>
    </button>
    <button class="msn-btn" data-page="screener">
      <span class="msn-icon">🔍</span>
      <span class="msn-label">篩選</span>
    </button>
    <button class="msn-btn" data-page="settings">
      <span class="msn-icon">⚙</span>
      <span class="msn-label">設定</span>
    </button>
  `;
  document.body.appendChild(nav);

  nav.querySelectorAll('.msn-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      const isAlreadyActive = btn.classList.contains('active');

      if (isAlreadyActive) {
        // 再點一次 active btn → 收合/展開 nav
        _navCollapsed = !_navCollapsed;
        nav.classList.toggle('m-nav-collapsed', _navCollapsed);
        document.querySelector('.main')?.classList.toggle('m-nav-collapsed', _navCollapsed);
        return;
      }

      // 切換到新頁面
      _navCollapsed = false;
      nav.classList.remove('m-nav-collapsed');
      document.querySelector('.main')?.classList.remove('m-nav-collapsed');

      nav.querySelectorAll('.msn-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _showPage(page);
    });
  });
}

// ── 頁面切換 ───────────────────────────────────────────────────────────────
function _showPage(page) {
  _currentPage = page;

  // 所有 tab-panel 先隱藏
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  const map = {
    chart:     'tabChart',
    watchlist: 'tabWatchlist',
    screener:  'tabScreener',
    settings:  'tabMobileSettings',
  };

  const panelId = map[page];
  if (panelId) {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');
  }

  // 題材已整合進篩選（mobile-screener.js 的 seg-tab）
  // 設定頁：動態建立
  if (page === 'settings') _ensureSettingsPage();
  // 篩選頁：確保 mobile-screener 已初始化
  if (page === 'screener') {
    document.dispatchEvent(new CustomEvent('mobileScreenerActivate'));
  }
  // 自選清單：確保 mobile-watchlist 已初始化並 render
  if (page === 'watchlist') {
    import('./mobile-watchlist.js').then(m => m.initMobileWatchlist?.()).catch(() => {});
  }
}

// ── 設定頁（動態建立，對應 settings-drawer 內容）─────────────────────────
function _ensureSettingsPage() {
  if (document.getElementById('tabMobileSettings')) return;

  // 複製 settings-drawer 的 .drawer-body 和 .drawer-footer 進來
  const drawer = document.getElementById('settingsDrawer');
  if (!drawer) return;

  const panel = document.createElement('div');
  panel.id = 'tabMobileSettings';
  panel.className = 'tab-panel';

  const header = document.createElement('div');
  header.className = 'msettings-header';
  header.innerHTML = '<span>⚙ 系統設定</span>';

  const body = drawer.querySelector('.drawer-body')?.cloneNode(true);
  const footer = drawer.querySelector('.drawer-footer')?.cloneNode(true);

  if (body) panel.appendChild(header);
  if (body) panel.appendChild(body);
  if (footer) panel.appendChild(footer);

  // 插入到 .main 裡
  document.querySelector('main.main')?.appendChild(panel);

  // 把 footer 按鈕事件橋接到原始 drawer 按鈕
  panel.querySelector('#settingsSaveBtn')?.addEventListener('click', () => {
    document.getElementById('settingsSaveBtn')?.click();
  });
  panel.querySelector('#settingsResetBtn')?.addEventListener('click', () => {
    document.getElementById('settingsResetBtn')?.click();
  });
}

// ── 個股全頁覆蓋 ───────────────────────────────────────────────────────────
function _buildStockOverlay() {
  if (document.getElementById('mStockPage')) return;

  // mStockPage：純背景容器，pointer-events: none
  const el = document.createElement('div');
  el.id = 'mStockPage';
  document.body.appendChild(el);

  // mStockTopbar：直接掛 body，完全不繼承 mStockPage 的 pointer-events
  const topbar = document.createElement('div');
  topbar.id = 'mStockTopbar';
  topbar.innerHTML = `
    <button id="mDrawerToggle" aria-label="切換頁籤">☰</button>
    <div id="mStockBrand">
      <img src="favicon.svg" alt="dengdeng" id="mStockLogoImg"/>
      <span id="mStockLogoText">dengdeng</span>
    </div>
    <div id="mStockTitle">—</div>
  `;
  document.body.appendChild(topbar);

  // overlay + drawer 也直接掛 body
  const overlay = document.createElement('div');
  overlay.id = 'mDrawerOverlay';
  document.body.appendChild(overlay);

  const drawerEl = document.createElement('nav');
  drawerEl.id = 'mStockDrawer';
  drawerEl.innerHTML = `
    ${STOCK_TABS.map(t => `
      <button class="m-drawer-item" data-stock-tab="${t.id}">
        <span>${t.icon}</span><span>${t.label}</span>
      </button>`).join('')}
    <div class="m-drawer-sep"></div>
    ${NAV_ITEMS.map(n => `
      <button class="m-drawer-item m-drawer-nav" data-nav-page="${n.page}">
        <span>${n.icon}</span><span>${n.label}</span>
      </button>`).join('')}
  `;
  document.body.appendChild(drawerEl);

  document.getElementById('mDrawerToggle')
    .addEventListener('click', () => _drawerOpen ? _closeDrawer() : _openDrawer());
  document.getElementById('mDrawerOverlay')
    .addEventListener('click', _closeDrawer);

  document.querySelectorAll('.m-drawer-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.stockTab;
      _closeDrawer();
      // 切回 K線或其他 stock tab 時，先還原內容區
      _showStockPageContent('chart');
      _setDrawerActive(tab);
      window.__switchStockTab?.(tab);
      if (tab !== 'chart' && window.__stockDashCode)
        window.__loadStockPanel?.(tab, window.__stockDashCode);
    });
  });

  // 導航項目（自選/篩選/設定）→ 關閉個股頁，切換到對應頁面
  document.querySelectorAll('.m-drawer-nav').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.navPage;
      _closeDrawer();

      if (page === 'watchlist' || page === 'screener') {
        // 自選/篩選：在個股全頁框架內切換，不離開全頁模式
        _showStockPageContent(page);
        return;
      }

      // 設定：關閉個股全頁，切換到設定 panel
      closeMobileStockPage();
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      if (page === 'settings') {
        _ensureSettingsPage();
        document.getElementById('tabMobileSettings')?.classList.add('active');
      }
      document.querySelectorAll('.msn-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.page === page));
    });
  });
}

// ── 個股全頁內容切換 ──────────────────────────────────────────────────────
// 在全頁框架內切換內容（K線 / 自選清單 / 篩選）
function _showStockPageContent(type) {
  const chartPanel = document.getElementById('chartPanel');
  const title = document.getElementById('mStockTitle');

  // 隱藏所有覆蓋 panel
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
    if (title) title.textContent = '自選清單';
    import('./mobile-watchlist.js').then(m => m.renderIntoEl?.(el)).catch(() => {});
    _setDrawerActive(null);

  } else if (type === 'screener') {
    _hideAll();
    if (chartPanel) chartPanel.style.display = 'none';
    const el = document.createElement('div');
    el.id = 'mScreenerPanel';
    el.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;';
    chartPanel?.parentElement?.appendChild(el);
    if (title) title.textContent = '篩選';
    import('./mobile-screener.js').then(m => m.renderIntoEl?.(el, _deps)).catch(() => {});
    _setDrawerActive(null);

  } else {
    // 切回 K線
    _hideAll();
    if (title && window.__stockDashCode) {
      title.textContent = window.__mobileStockName || window.__stockDashCode;
    }
  }
}

// ── 個股全頁開關 ───────────────────────────────────────────────────────────
export function openMobileStockPage(title) {
  if (!isMobile()) return;
  // 隱藏左側 nav（個股全頁從 left:0 撐滿）
  document.getElementById('mSideNav')?.classList.add('m-nav-hidden');
  document.getElementById('tabChart')?.classList.add('m-stock-active');
  document.getElementById('mStockPage')?.classList.add('m-stock-open');
  document.body.classList.add('m-stock-open');
  if (title) updateMobileStockTitle(title);
  _setDrawerActive('chart');
  buildMobileKlineBar();
}

export function closeMobileStockPage() {
  document.getElementById('mSideNav')?.classList.remove('m-nav-hidden');
  document.getElementById('tabChart')?.classList.remove('m-stock-active');
  document.body.classList.remove('m-stock-open');
  document.getElementById('mStockPage')?.classList.remove('m-stock-open');
  _closeDrawer();
  // 直接 active tabChart，不透過 _showPage
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tabChart')?.classList.add('active');
  document.querySelectorAll('.msn-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.page === 'chart'));
}

export function updateMobileStockTitle(title) {
  const el = document.getElementById('mStockTitle');
  if (el && title) el.textContent = title;
}

// ── 抽屜 ──────────────────────────────────────────────────────────────────
function _openDrawer() {
  _drawerOpen = true;
  document.getElementById('mStockDrawer')?.classList.add('open');
  document.getElementById('mDrawerOverlay')?.classList.add('open');
}

function _closeDrawer() {
  _drawerOpen = false;
  document.getElementById('mStockDrawer')?.classList.remove('open');
  document.getElementById('mDrawerOverlay')?.classList.remove('open');
}

function _setDrawerActive(tab) {
  document.querySelectorAll('.m-drawer-item').forEach(b =>
    b.classList.toggle('active', b.dataset.stockTab === tab));
}

// ── 手機版 K 線控制列（三個 select）─────────────────────────────────────
const _MAIN_OPTS = [
  { ind: 'none', label: '主圖：無'  },
  { ind: 'MA20', label: 'MA20'     },
  { ind: 'MA5',  label: 'MA5'      },
  { ind: 'MA10', label: 'MA10'     },
  { ind: 'MA60', label: 'MA60'     },
  { ind: 'EMA',  label: 'EMA'      },
  { ind: 'BB',   label: 'BB'       },
  { ind: 'ENV',  label: 'ENV'      },
  { ind: 'ICHI', label: 'Ichimoku' },
  { ind: 'SAR',  label: 'SAR'      },
  { ind: 'GMMA', label: 'GMMA'     },
  { ind: 'PVD',  label: '分價量'   },
];
const _SUB_OPTS = [
  { ind: 'KD',   label: 'KD'   },
  { ind: 'RSI',  label: 'RSI'  },
  { ind: 'MACD', label: 'MACD' },
  { ind: 'DMI',  label: 'DMI'  },
  { ind: 'PSY',  label: 'PSY'  },
  { ind: 'RCI',  label: 'RCI'  },
  { ind: 'HV',   label: 'HV'   },
];
const _PERIOD_LABELS = {'5d':'5日','1mo':'1月','3mo':'3月','6mo':'6月','1y':'1年','2y':'2年'};
let _curMainInd = 'MA20';
let _curSubInd  = 'KD';

function buildMobileKlineBar() {
  if (document.getElementById('mKlineBar')) return;
  const bar = document.createElement('div');
  bar.id = 'mKlineBar';
  bar.innerHTML = `
    <select id="mPeriodSel" class="mkl-sel">
      ${Object.entries(_PERIOD_LABELS).map(([v,l]) =>
        `<option value="${v}"${v==='1mo'?' selected':''}>${l}</option>`).join('')}
    </select>
    <select id="mMainIndSel" class="mkl-sel">
      ${_MAIN_OPTS.map(o =>
        `<option value="${o.ind}"${o.ind===_curMainInd?' selected':''}>${o.label}</option>`).join('')}
    </select>
    <select id="mSubIndSel" class="mkl-sel">
      ${_SUB_OPTS.map(o =>
        `<option value="${o.ind}"${o.ind===_curSubInd?' selected':''}>${o.label}</option>`).join('')}
    </select>
  `;
  const chartPanel = document.getElementById('chartPanel');
  if (chartPanel) chartPanel.insertBefore(bar, chartPanel.firstChild);

  document.getElementById('mPeriodSel')?.addEventListener('change', e => {
    document.querySelector(`.tb-btn[data-period="${e.target.value}"]`)?.click();
  });
  document.getElementById('mMainIndSel')?.addEventListener('change', e => {
    const prev = _curMainInd; _curMainInd = e.target.value;
    if (prev !== 'none') {
      const old = document.querySelector(`.ind-toggle[data-ind="${prev}"]`);
      if (old?.classList.contains('on')) old.click();
    }
    if (_curMainInd !== 'none') {
      const btn = document.querySelector(`.ind-toggle[data-ind="${_curMainInd}"]`);
      if (btn && !btn.classList.contains('on')) btn.click();
    }
  });
  document.getElementById('mSubIndSel')?.addEventListener('change', e => {
    const prev = _curSubInd; _curSubInd = e.target.value;
    const old = document.querySelector(`.ind-toggle[data-ind="${prev}"]`);
    if (old?.classList.contains('on')) old.click();
    const btn = document.querySelector(`.ind-toggle[data-ind="${_curSubInd}"]`);
    if (btn && !btn.classList.contains('on')) btn.click();
  });
}
