/**
 * hotgroup-tabs.js — 族群觀察 子頁切換（強勢族群 / 族群回測）
 *
 * 族群回測自 strategy-lab 遷入：
 *   - HTML 區塊（labControlsIndustry / labIndSettingPanel / labPanelIndustry）已搬至 #hgSubBacktest
 *   - 切到「族群回測」子頁才 lazy import lab-industry.js
 *   - 權限：pro / vvvip 可用；其餘顯示 #hgBtProBanner
 *
 * export：initHotgroupTabs()  ← main.js 在 hotgroup tab 點擊時呼叫
 */

let _inited      = false;
let _labLoaded   = false;
let _currentSub  = 'hot';

export function initHotgroupTabs() {
  if (_inited) return;
  _inited = true;

  document.querySelectorAll('.hg-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.hgsub;
      if (sub) _switchSub(sub);
    });
  });

  window.addEventListener('authReady', () => {
    if (_currentSub === 'backtest') { _applyTier(); _loadLab(); }
  });

  // 全域跳轉：族群回測 modal / 熱力圖點個股 → 切到實驗室
  // （lab-industry.js 內 inline onclick 與 modal 按鈕共用此入口）
  window.openLabWithCode = async (code, subPage = 'single', opts = {}) => {
    const labTab = document.querySelector('.main-tab[data-tab="lab"]');
    if (!labTab || labTab.style.display === 'none') return;  // 無 lab 權限
    labTab.click();
    const m = await import('./strategy-lab.js');
    await m.initStrategyLab();
    requestAnimationFrame(() => m.openLabWithCode(code, subPage, opts));
  };
}

function _switchSub(sub) {
  _currentSub = sub;
  document.querySelectorAll('.hg-subtab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.hgsub === sub);
  });
  const hotEl = document.getElementById('hgSubHot');
  const btEl  = document.getElementById('hgSubBacktest');
  if (hotEl) hotEl.style.display = sub === 'hot' ? '' : 'none';
  if (btEl)  btEl.style.display  = sub === 'backtest' ? '' : 'none';

  if (sub === 'backtest') {
    _applyTier();
    _loadLab();
  }
}

function _applyTier() {
  const tier = window.__userTier ?? 'guest';
  const ok   = tier === 'pro' || tier === 'vvvip';
  const banner  = document.getElementById('hgBtProBanner');
  const toolbar = document.querySelector('.hg-bt-toolbar');
  const panel   = document.getElementById('labPanelIndustry');
  if (banner)  banner.style.display  = ok ? 'none' : '';
  if (toolbar) toolbar.style.display = ok ? '' : 'none';
  if (panel)   panel.style.display   = ok ? '' : 'none';
}

async function _loadLab() {
  if (_labLoaded) return;
  const tier = window.__userTier ?? 'guest';
  if (tier !== 'pro' && tier !== 'vvvip') return;  // 升級後 authReady 再進來
  _labLoaded = true;
  try {
    const m = await import('./lab-industry.js');
    m.bindIndustryRun();
    m.bindIndModal();
    m.preloadHeatMap().catch(() => {});
  } catch (e) {
    _labLoaded = false;
    console.error('[hotgroup-tabs] lab-industry 載入失敗:', e);
  }
}
