/**
 * strategy-lab.js — 策略實驗室 orchestrator
 *
 * 對外 API：
 *   initStrategyLab()              ← screener-hub.js lazy init 呼叫
 *   openLabWithCode(code, subPage) ← 外部跳轉（從族群 modal 點個股 → MC）
 *
 * 子模組（lazy import）：
 *   lab-single.js    → 單股回測
 *   lab-industry.js  → 族群回測
 *   lab-mc.js        → MC 模擬
 *   lab-compare.js   → 策略比較
 */

import { dengToast } from './loading-deng.js';

let _inited     = false;
let _currentSub = 'single';

// ── 公開入口 ──────────────────────────────────────────────────────────────
export async function initStrategyLab() {
  if (_inited) return;
  _inited = true;

  _bindSubTabs();
  _applyTierUI();
  _switchSub('single');

  // 各子模組 lazy init（切到對應 tab 才 import）
  // 預先 bind run buttons（import 後才能 bind）
  _lazyBind('single',   () => import('./lab-single.js'),   m => m.bindSingleRun());
  _lazyBind('industry', () => import('./lab-industry.js'), m => {
    m.bindIndustryRun();
    m.bindIndModal();
    m.preloadHeatMap().catch(() => {});
  });
  _lazyBind('mc',       () => import('./lab-mc.js'),       m => m.bindMCRun());
  _lazyBind('compare',  () => import('./lab-compare.js'),  m => m.bindCompareRun());
  _lazyBind('experiment', () => import('./lab-experiment.js'), m => m.bindExperimentRun());
  _lazyBind('backtest', () => import('./lab-backtest.js'), m => m.bindBacktestRun());

  window.addEventListener('authReady', () => _applyTierUI());
}

/** 外部跳轉：從族群 modal 點個股 → 切到 MC 子頁並帶入代號 */
export function openLabWithCode(code, subPage = 'mc') {
  _switchSub(subPage);
  const idMap = { mc: 'labMCCodeInput', single: 'labCodeInput', compare: 'labCompareCodeInput' };
  const inp = document.getElementById(idMap[subPage] ?? '');
  if (inp) inp.value = code;
}

// ── lazy bind：切到 tab 時才 import 並初始化 ──────────────────────────────
const _bound = new Set();
function _lazyBind(sub, importFn, initFn) {
  // 當 tab 切到此 sub 時觸發
  const tryBind = async () => {
    if (_bound.has(sub)) return;
    _bound.add(sub);
    try {
      const mod = await importFn();
      initFn(mod);
    } catch(e) {
      console.error(`[lab] lazy bind ${sub} failed:`, e);
    }
  };
  // 若初始 tab 就是這個，立刻 bind
  if (_currentSub === sub) tryBind();
  // 否則等 tab 切換時 bind
  document.addEventListener(`lab:switch:${sub}`, tryBind, { once: true });
}

// ── 子頁切換 ──────────────────────────────────────────────────────────────
function _bindSubTabs() {
  document.querySelectorAll('.lab-sub-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.lab;
      if (sub) _switchSub(sub);
    });
  });
}

function _switchSub(sub) {
  _currentSub = sub;

  document.querySelectorAll('.lab-sub-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lab === sub);
  });

  const panels = {
    single: 'labPanelSingle', industry: 'labPanelIndustry',
    mc: 'labPanelMC', compare: 'labPanelCompare',
    experiment: 'labPanelExperiment',
    backtest: 'labPanelBacktest',
  };
  Object.entries(panels).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === sub ? '' : 'none';
  });

  const controls = {
    single: 'labControlsSingle', industry: 'labControlsIndustry',
    mc: 'labControlsMC', compare: 'labControlsCompare',
    experiment: 'labControlsExperiment',
    backtest: 'labControlsBacktest',
  };
  Object.entries(controls).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === sub ? '' : 'none';
  });

  // 通知 lazy bind
  document.dispatchEvent(new CustomEvent(`lab:switch:${sub}`));
}

// ── 權限 UI ───────────────────────────────────────────────────────────────
function _applyTierUI() {
  const tier = window.__userTier ?? 'guest';
  const isVVVIP  = tier === 'vvvip';
  const isPro    = tier === 'pro';
  const hasAccess = isVVVIP || isPro;

  const labBtn = document.getElementById('hubBtnLab');
  if (labBtn) labBtn.style.display = hasAccess ? '' : 'none';

  const banner = document.getElementById('labProBanner');
  if (banner) banner.style.display = 'none';

  const mcBtn = document.getElementById('labBtnMC');
  if (mcBtn) mcBtn.style.display = isVVVIP ? '' : 'none';

  const mcRunBtn = document.getElementById('labRunMC');
  if (mcRunBtn) mcRunBtn.disabled = !isVVVIP;

  // 真實驗室：只有 vvvip 才顯示
  const expBtn = document.getElementById('labBtnExperiment');
  if (expBtn) expBtn.style.display = isVVVIP ? '' : 'none';
}
