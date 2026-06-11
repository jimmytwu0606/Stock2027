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
import { STRATEGIES } from './strategy.js';
import { fetchSnapshot, runSnapshotScreener } from './api.js';
import { getChineseName } from './api.js';
import { initPatternUI }   from './pattern-ui.js';
import { initSeedUI }      from './seed-ui.js';
import { initLagUI }       from './lag-ui.js';
import { initStrategyAudit } from './strategy-audit.js';
import { openStockPreview } from './stock-preview.js';

const SUBS = {
  screener: 'hubSubScreener',
  pattern:  'hubSubPattern',
  seed:     'hubSubSeed',
  lag:      'hubSubLag',
};

let _currentMode = 'screener';
let _screenerInited = false;
let _patternInited  = false;
let _seedInited     = false;
let _lagInited      = false;

// ── 公開入口 ──────────────────────────────────────────────
export function initScreenerHub() {
  _bindModeBtns();
  initStrategyAudit();  // 🧪 策略體檢（VVVIP 限定，自行控制顯隱）
  _bindConfigBtns();
  _bindActionBtns();
  _listenResultEvents();
  _initSnapshotScreener();  // 快速篩初始化（預載 snapshot）
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
  const configMap = { screener: 'hubConfigScreener', pattern: 'hubConfigPattern', seed: 'hubConfigSeed', lag: 'hubConfigLag' };
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
  if (mode === 'lag' && !_lagInited) {
    _lagInited = true;
    initLagUI();
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
  document.getElementById('hubConfigLag')?.addEventListener('click', () => {
    document.getElementById('lagOpenConfig')?.click();
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


// ── Snapshot 快速篩（預設策略，雲端預算，秒出結果）──────────────────────
// 只在「個股篩選」模式下顯示；自訂條件仍走本機運算（screener-ui.js）

let _snapshot     = null;
let _snapLoading  = false;

function _initSnapshotScreener() {
  // 背景預載 snapshot（不擋 UI）
  fetchSnapshot().then(snap => { _snapshot = snap; });

  // 綁定快速篩按鈕（由 index.html 的 hubQuickScanBtn 觸發）
  document.getElementById('hubQuickScanBtn')?.addEventListener('click', _runQuickScan);
}

async function _runQuickScan() {
  const btn = document.getElementById('hubQuickScanBtn');
  if (btn) btn.disabled = true;

  try {
    // 確保 snapshot 已載入
    if (!_snapshot) {
      if (btn) btn.textContent = '載入中…';
      _snapshot = await fetchSnapshot();
    }
    if (!_snapshot) {
      alert('雲端策略資料尚未就緒，請稍後再試');
      return;
    }

    if (btn) btn.textContent = '計算中…';

    // 只跑有 tier 權限的策略（tier gate 由 strategy.js 控管）
    const tier = window.__userTier ?? 'free';
    const tierOrder = { free: 0, pro: 1, vvvip: 2 };
    const myTier = tierOrder[tier] ?? 0;
    const tierMap = { free: 0, pro: 1, vvvip: 2 };

    const eligibleStrategies = STRATEGIES.filter(s => {
      const need = tierMap[s.tier] ?? 0;
      // 基本面策略（S16~S19）需要 fundamentals，snapshot 沒有 → 跳過
      if (s.category === '基本面' || s.category === '巴菲特') return false;
      return myTier >= need;
    });

    // 跑 snapshot 篩選
    const hitMap = runSnapshotScreener(eligibleStrategies, _snapshot);

    // 整理結果：每支股票 → 命中哪些策略
    const stockHits = {};  // { code: [stratId, ...] }
    Object.entries(hitMap).forEach(([stratId, codes]) => {
      codes.forEach(code => {
        if (!stockHits[code]) stockHits[code] = [];
        stockHits[code].push(stratId);
      });
    });

    const totalCodes = Object.keys(stockHits).length;
    console.log(`[quick-scan] 命中 ${totalCodes} 支`);

    // 渲染結果
    _renderQuickScanResult(stockHits, eligibleStrategies);

  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ 快速篩選'; }
  }
}

function _renderQuickScanResult(stockHits, strategies) {
  const container = document.getElementById('hubQuickScanResult');
  if (!container) return;

  const stratMap = Object.fromEntries(strategies.map(s => [s.id, s]));
  const codes    = Object.keys(stockHits);

  if (!codes.length) {
    container.innerHTML = '<div style="color:var(--muted);padding:16px">今日無符合條件個股</div>';
    container.style.display = '';
    return;
  }

  // 依命中策略數排序（多的優先）
  codes.sort((a, b) => stockHits[b].length - stockHits[a].length);

  const rows = codes.slice(0, 200).map(code => {
    const strats = stockHits[code].map(id => {
      const s = stratMap[id];
      return s ? `<span class="qs-tag" title="${s.name}">${s.icon}${s.id}</span>` : '';
    }).join('');
    const snap  = _snapshot.stocks[code] || {};
    const price = typeof snap.price_min === 'number' ? snap.price_min.toFixed(2) : '—';
    const chg   = typeof snap.chg_min   === 'number' ? snap.chg_min.toFixed(2)   : '—';
    const chgCls = typeof snap.chg_min === 'number' ? (snap.chg_min >= 0 ? 'up' : 'dn') : '';
    return `<tr class="qs-row" data-code="${code}">
      <td class="qs-code">${code}</td>
      <td class="qs-name">${getChineseName(code) || ''}</td>
      <td class="qs-price">${price}</td>
      <td class="qs-chg ${chgCls}">${chg}%</td>
      <td class="qs-strats">${strats}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="qs-header">
      <span>共 <b>${codes.length}</b> 支命中（顯示前 200）・資料日期 ${_snapshot.date}</span>
    </div>
    <table class="qs-table">
      <thead><tr>
        <th>代號</th><th>名稱</th><th>收盤</th><th>漲跌</th><th>命中策略</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  container.style.display = '';

  // 點擊個股 → 開 K 線，同時設定 screenerContext 讓個股頁知道來源策略
  container.querySelectorAll('.qs-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const code = tr.dataset.code;
      if (!code) return;
      // 取這支股票命中的第一個 X 系列策略（優先 X2 > X1 > X5 > X6）
      const hitStrats = stockHits[code] ?? [];
      const X_PRIORITY = ['X2','X1','X5','X6'];
      const xStrat = X_PRIORITY.find(id => hitStrats.includes(id)) ?? null;
      const stratObj = xStrat ? stratMap[xStrat] : (hitStrats[0] ? stratMap[hitStrats[0]] : null);
      // 點擊 → 個股速覽 modal；ctx 透傳給「進入個股頁面」的 stockSelect
      openStockPreview(code, {
        matchedConds:  hitStrats.map(id => stratMap[id]?.name ?? id),
        strategyId:    stratObj?.id   ?? null,
        strategyName:  stratObj?.name ?? null,
        fromScreener:  true,
      });
    });
  });

  // 顯示 action btns
  _showActionBtns();
}
