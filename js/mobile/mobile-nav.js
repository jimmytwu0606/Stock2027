/**
 * mobile-nav.js — Phase 10.1
 * 職責：
 *  1. 左側固定 4 btn 導航（看盤/自選/篩選/設定）
 *  2. 個股全頁覆蓋 + 側邊抽屜切換 stock tabs
 *
 * 完全不搬 DOM，不碰桌機版任何邏輯。
 */

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

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

  const el = document.createElement('div');
  el.id = 'mStockPage';
  el.innerHTML = `
    <div id="mStockTopbar">
      <button id="mDrawerToggle" aria-label="切換頁籤">☰</button>
      <div id="mStockBrand">
        <img src="favicon.svg" alt="dengdeng" id="mStockLogoImg"/>
        <span id="mStockLogoText">dengdeng</span>
      </div>
      <div id="mStockTitle">—</div>
    </div>
    <div id="mDrawerOverlay"></div>
    <nav id="mStockDrawer">
      ${STOCK_TABS.map(t => `
        <button class="m-drawer-item" data-stock-tab="${t.id}">
          <span>${t.icon}</span><span>${t.label}</span>
        </button>`).join('')}
      <div class="m-drawer-sep"></div>
      ${NAV_ITEMS.map(n => `
        <button class="m-drawer-item m-drawer-nav" data-nav-page="${n.page}">
          <span>${n.icon}</span><span>${n.label}</span>
        </button>`).join('')}
    </nav>
  `;
  document.body.appendChild(el);

  document.getElementById('mDrawerToggle')
    .addEventListener('click', () => _drawerOpen ? _closeDrawer() : _openDrawer());
  document.getElementById('mDrawerOverlay')
    .addEventListener('click', _closeDrawer);

  document.querySelectorAll('.m-drawer-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.stockTab;
      _closeDrawer();
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
      closeMobileStockPage();
      // 切換到對應頁面
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const map = { watchlist: 'tabWatchlist', screener: 'tabScreener', settings: 'tabMobileSettings' };
      if (page === 'settings') {
        // 確保設定頁已建立
        document.dispatchEvent(new CustomEvent('mobileEnsureSettings'));
      }
      const panelId = map[page];
      if (panelId) document.getElementById(panelId)?.classList.add('active');
      // 更新左側 nav active 狀態
      document.querySelectorAll('.msn-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.page === page));
    });
  });
}

// ── 個股全頁開關 ───────────────────────────────────────────────────────────
export function openMobileStockPage(title) {
  if (!isMobile()) return;
  document.getElementById('tabChart')?.classList.add('m-stock-active');
  document.getElementById('mStockPage')?.classList.add('m-stock-open');
  document.body.classList.add('m-stock-open');
  if (title) updateMobileStockTitle(title);
  _setDrawerActive('chart');
  buildMobileKlineBar();
}

export function closeMobileStockPage() {
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
