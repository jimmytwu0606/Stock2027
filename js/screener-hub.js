/**
 * screener-hub.js
 * 選股篩選 Hub — 統一入口，整合個股篩選 / 型態比對 / 種子選股
 *
 * 職責：
 *   - hub toolbar 三個模式 btn 切換子面板
 *   - 初始化三個子模組（lazy，切到才初始化）
 *   - 統一管理右側 action btn（加入追蹤 / 儲存結果 / 匯出）
 *   - 不干涉各子模組的 JS 邏輯，只控制 display
 */

import { initScreener, openScreenerModal } from './screener-ui.js';
import { initPatternUI }   from './pattern-ui.js';
import { initSeedUI }      from './seed-ui.js';

const SUBS = {
  screener: 'hubSubScreener',
  pattern:  'hubSubPattern',
  seed:     'hubSubSeed',
};

let _currentMode = 'screener';
let _screenerInited = false;
let _patternInited  = false;
let _seedInited     = false;

// ── 公開入口 ──────────────────────────────────────────────
export function initScreenerHub() {
  _bindModeBtns();
  _bindConfigBtns();
  _bindActionBtns();
  _listenResultEvents();
  // 預設顯示個股篩選（頁面載入時就 init，不等 tab 點擊）
  _switchMode('screener');
  // 橋接：tab 點擊時由 main.js 呼叫，讓 hub 重新 focuse 當前 mode
  window.__screenerHubSwitch = () => {
    // 確保 hub panel visible
    const hub = document.getElementById('tabHub');
    if (hub && !hub.classList.contains('active')) return;
    _switchMode(_currentMode);
  };
}

// ── 模式切換 ─────────────────────────────────────────────
function _bindModeBtns() {
  document.querySelectorAll('.hub-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.hub;
      if (mode) _switchMode(mode);
    });
  });
}

function _switchMode(mode) {
  _currentMode = mode;

  // 更新 btn active
  document.querySelectorAll('.hub-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.hub === mode);
  });

  // 顯示對應 config btn，隱藏其他
  const configMap = { screener: 'hubConfigScreener', pattern: 'hubConfigPattern', seed: 'hubConfigSeed' };
  Object.entries(configMap).forEach(([m, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = m === mode ? '' : 'none';
  });

  // 顯隱子面板
  Object.entries(SUBS).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = key === mode ? 'flex' : 'none';
  });

  // Lazy init
  if (mode === 'screener' && !_screenerInited) {
    _screenerInited = true;
    initScreener().catch(e => console.error('[hub] initScreener error:', e));
  }
  if (mode === 'pattern' && !_patternInited) {
    _patternInited = true;
    initPatternUI();
  }
  if (mode === 'seed' && !_seedInited) {
    _seedInited = true;
    initSeedUI();
  }

  // 重設 action btn（切模式時隱藏，等新結果出來再顯示）
  _hideActionBtns();
}

// ── Config btns（各模式設定 btn，右側）──────────────────
function _bindConfigBtns() {
  document.getElementById('hubConfigScreener')?.addEventListener('click', () => {
    openScreenerModal();
  });
  document.getElementById('hubConfigPattern')?.addEventListener('click', () => {
    document.getElementById('pdOpenConfig')?.click();
  });
  document.getElementById('hubConfigSeed')?.addEventListener('click', () => {
    document.getElementById('seedOpenConfig')?.click();
  });
}

// ── Action btns ───────────────────────────────────────────
function _bindActionBtns() {
  // 加入追蹤：代理給各子模組既有的按鈕
  document.getElementById('hubAddTrackBtn')?.addEventListener('click', () => {
    if (_currentMode === 'screener') {
      document.getElementById('screenerAddAllToWlBtn')?.click();
    }
    // pattern / seed 目前各自有 sr-add-btn，hub 層不重複做
  });

  // 儲存結果：代理給 screener
  document.getElementById('hubSaveResultBtn')?.addEventListener('click', () => {
    if (_currentMode === 'screener') {
      document.getElementById('screenerSaveResultBtn')?.click();
    }
  });

  // 匯出：screener 結果匯出 JSON
  document.getElementById('hubExportBtn')?.addEventListener('click', () => {
    if (_currentMode === 'screener') {
      _exportScreenerResults();
    }
  });
}

function _hideActionBtns() {
  ['hubAddTrackBtn','hubSaveResultBtn','hubExportBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function _showActionBtns() {
  ['hubAddTrackBtn','hubSaveResultBtn','hubExportBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

// ── 監聽結果事件（各子模組掃完後顯示 action btns）────────
function _listenResultEvents() {
  // screener 掃完 → 監聽 screenerResultReady 事件
  document.addEventListener('screenerResultReady', () => {
    if (_currentMode === 'screener') _showActionBtns();
  });

  // pattern 掃完：prSummaryText 有文字時
  document.addEventListener('patternScanStart', () => {
    if (_currentMode === 'pattern') _hideActionBtns();
  });
  // pattern done：監聽 prList 出現內容
  document.addEventListener('patternScanDone', () => {
    if (_currentMode === 'pattern') _showActionBtns();
  });

  // seed 掃完：seedTbSaveBtn 出現
  const seedSaveBtn = document.getElementById('seedTbSaveBtn');
  if (seedSaveBtn) {
    new MutationObserver(() => {
      if (seedSaveBtn.style.display !== 'none' && _currentMode === 'seed') {
        _showActionBtns();
      }
    }).observe(seedSaveBtn, { attributes: true, attributeFilter: ['style'] });
  }
}

// ── 匯出 screener 結果 ────────────────────────────────────
function _exportScreenerResults() {
  const { AppState } = window.__AppState ? { AppState: window.__AppState } : {};
  // 從 AppState 取結果
  const results = window.__AppState?.screener?.results ?? [];
  if (!results.length) {
    document.dispatchEvent(new CustomEvent('showToast', { detail: '目前沒有篩選結果可匯出' }));
    return;
  }
  const exportData = {
    exportAt: new Date().toISOString(),
    count:    results.length,
    items:    results.map(r => ({
      code:   r.code,
      name:   r.name,
      price:  r.price,
      chgPct: r.chgPct,
      matchedConds: r.matchedConds,
    })),
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  a.href     = url;
  a.download = `screener_${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
