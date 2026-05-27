/**
 * screener-ui.js
 * Phase 2 篩選器 UI
 *
 * export：
 *   initScreener()
 */

import { CONDITION_DEFS, runScreener, loadSavedSets, saveSet, deleteSavedSet } from './screener.js';
import { loadAllResults, saveResult, deleteResult } from './screener-result-store.js';
import { AppState } from './state.js';
import { getChineseName, fetchFundamentalsBatch } from './api.js';

// fund 快取（結果渲染後批次讀入）
let _scFundCache = {};
import { calcHealth, calcHealthFast, calcHealthLong, healthBadgeDual } from './health.js';
import { Config } from './config.js';

// 目前使用中的條件列
let _conditions = [];
let _isRunning  = false;
let _results    = [];
let _sortKey    = 'chgPct';   // 預設：漲跌幅
let _sortAsc    = false;       // 預設：降冪

// 本次篩選 meta（供備份用）
let _currentStrategyName = null;
let _currentCondLabels   = [];

// ─────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────
export async function initScreener() {
  _renderConditionArea();
  _renderResults([]);
  _bindToolbarEvents();
  _bindStrategyEvents();
  await _renderSavedSets();
  await _renderSavedResultsList();
}

// ─────────────────────────────────────────────
// 策略庫事件監聽
// ─────────────────────────────────────────────
function _bindStrategyEvents() {
  document.addEventListener('screenerPhase2Progress', (e) => {
    const { done, total } = e.detail;
    _updateProgress(done, total);
    _updateStatus(`計算技術指標中：${done} / ${total} 檔…`);
  });

  document.addEventListener('strategyClear', () => {
    _conditions = [];
    _currentStrategyName = null;
    _renderConditionArea();
  });

  document.addEventListener('screenerAddCondition', (e) => {
    const { condId, value } = e.detail ?? {};
    if (!condId) return;
    const def = CONDITION_DEFS.find(d => d.id === condId);
    if (!def) { console.warn('[screener-ui] unknown condId:', condId); return; }
    if (_conditions.find(c => c.id === condId)) return;
    _conditions.push({ id: condId, def, value: value ?? def.default });
    _renderConditionArea();
  });

  document.addEventListener('strategyApplied', (e) => {
    _currentStrategyName = e.detail?.name ?? null;
  });

  // v2.6.2 — 策略自動升級週期時同步 Config.screenerPeriod
  document.addEventListener('screenerPeriodUpgrade', (e) => {
    const { period, reason } = e.detail ?? {};
    if (!period) return;
    Config.screenerPeriod = period;
    console.log(`[screener-ui] Config.screenerPeriod 同步為 ${period}（${reason}）`);
  });
}

// ─────────────────────────────────────────────
// 條件區渲染
// ─────────────────────────────────────────────
function _renderConditionArea() {
  const wrap = document.getElementById('screenerConditions');
  if (!wrap) return;

  if (!_conditions.length) {
    wrap.innerHTML = `<div class="sc-empty-conds">尚未新增任何條件<br>點擊「＋ 新增條件」開始</div>`;
    return;
  }

  wrap.innerHTML = _conditions.map((c, i) => _renderCondRow(c, i)).join('');

  wrap.querySelectorAll('.sc-cond-row').forEach((row, i) => {
    const select = row.querySelector('.sc-cond-select');
    select?.addEventListener('change', e => {
      const def = CONDITION_DEFS.find(d => d.id === e.target.value);
      if (!def) return;
      _conditions[i] = { id: def.id, def, value: def.default };
      _renderConditionArea();
    });

    const input = row.querySelector('.sc-cond-input');
    input?.addEventListener('input', e => {
      _conditions[i].value = parseFloat(e.target.value) || 0;
    });

    row.querySelector('.sc-cond-del')?.addEventListener('click', () => {
      _conditions.splice(i, 1);
      _renderConditionArea();
    });
  });
}

function _renderCondRow(c, i) {
  const groupLabels = {
    price:     '價格',
    volume:    '量能',
    technical: '技術指標',
    ma:        '均線',
    bollinger: '布林通道',
  };

  const optionsByGroup = {};
  CONDITION_DEFS.forEach(d => {
    const g = groupLabels[d.group] ?? d.group;
    if (!optionsByGroup[g]) optionsByGroup[g] = [];
    optionsByGroup[g].push(d);
  });

  const optionsHtml = Object.entries(optionsByGroup).map(([groupName, defs]) => `
    <optgroup label="${groupName}">
      ${defs.map(d =>
        `<option value="${d.id}" ${d.id === c.id ? 'selected' : ''}>${d.label}</option>`
      ).join('')}
    </optgroup>`).join('');

  const inputHtml = c.def.type === 'boolean'
    ? `<span class="sc-cond-bool-label">${c.def.unit || '（符合即計入）'}</span>`
    : `<input class="sc-cond-input" type="number" value="${c.value}" step="any" />
       <span class="sc-cond-unit">${c.def.unit}</span>`;

  const phaseBadge = c.def.phase === 2
    ? `<span class="sc-phase-badge">需K線</span>`
    : '';

  return `
    <div class="sc-cond-row" data-idx="${i}">
      <select class="sc-cond-select">${optionsHtml}</select>
      ${inputHtml}
      ${phaseBadge}
      <button class="sc-cond-del" title="移除此條件">✕</button>
    </div>`;
}

// ─────────────────────────────────────────────
// Toolbar 事件
// ─────────────────────────────────────────────
function _bindToolbarEvents() {
  document.getElementById('screenerAddCond')?.addEventListener('click', () => {
    const def = CONDITION_DEFS[0];
    _conditions.push({ id: def.id, def, value: def.default });
    _renderConditionArea();
  });

  document.getElementById('screenerClearConds')?.addEventListener('click', () => {
    _conditions = [];
    _currentStrategyName = null;
    _renderConditionArea();
    _renderResults([]);
    _hideSaveResultBtn();
    _updateStatus('');
  });

  document.getElementById('screenerRun')?.addEventListener('click', _runScreener);

  document.getElementById('screenerSave')?.addEventListener('click', async () => {
    if (!_conditions.length) return;
    const name = prompt('輸入篩選組合名稱：', `自訂篩選 ${new Date().toLocaleDateString('zh-TW')}`);
    if (!name?.trim()) return;
    await saveSet(name.trim(), _conditions);
    await _renderSavedSets();
    _showMsg('篩選組合已儲存');
  });

  // toolbar 靜態「儲存結果」按鈕（篩選完成後才顯示）
  document.getElementById('screenerSaveResultBtn')?.addEventListener('click', _toggleSaveNameArea);
}

// ─────────────────────────────────────────────
// 執行篩選
// ─────────────────────────────────────────────
async function _runScreener() {
  if (_isRunning) return;
  if (!_conditions.length) {
    _showMsg('請先新增至少一個篩選條件');
    return;
  }

  // 等 fetchTWSEPrices 完成（__twsePricesReady），確保 __priceCache 有資料
  // 若已完成（Promise 已 resolve）則立即繼續
  if (window.__twsePricesReady) {
    _updateStatus('等待市場資料載入…');
    try { await window.__twsePricesReady; } catch (_) {}
  }

  _isRunning           = true;
  _results             = [];
  _currentCondLabels   = _conditions.map(c => c.def.label);
  _renderResults([]);
  _hideSaveResultBtn();
  _setRunBtnState(true);
  _updateStatus('正在取得全市場資料…');

  const progressEl = document.getElementById('screenerProgress');
  if (progressEl) progressEl.style.display = '';

  let phase1Total = 0;
  let phase1Pass  = 0;
  let resultCount = 0;

  try {
    for await (const event of runScreener(_conditions)) {
      switch (event.type) {
        case 'status': {
          _updateStatus(event.payload.message);
          break;
        }
        case 'phase1_done': {
          phase1Total = event.payload.total;
          phase1Pass  = event.payload.passed;
          _updateStatus(
            `第一階段完成：${phase1Total} 檔 → 剩 ${phase1Pass} 檔` +
            (_conditions.some(c => c.def.phase === 2) ? '，計算技術指標中…' : '')
          );
          _updateProgress(0, phase1Pass);
          break;
        }
        case 'progress': {
          _updateProgress(event.payload.done, event.payload.total);
          break;
        }
        case 'result': {
          resultCount++;
          _results.push(event.payload);
          if (resultCount % 10 === 1 || resultCount === 1) {
            _renderResults(_results);
          }
          break;
        }
        case 'done': {
          _renderResults(_results);
          _updateProgress(phase1Pass, phase1Pass);
          _updateStatus(
            `篩選完成：共 ${resultCount} 檔符合條件（從 ${phase1Total} 檔中篩選）`
          );
          AppState.screener.results = _results;
          if (resultCount > 0) _showSaveResultBtn();
          // 批次讀 fund → 長線健康度吃基本面
          if (_results.length > 0) {
            const codes = _results.map(r => r.code);
            fetchFundamentalsBatch(codes).then(fundMap => {
              fundMap.forEach((f, code) => { _scFundCache[code] = f ?? null; });
              _renderResults(_results); // 重繪，帶入 fund
            }).catch(() => {});
          }
          break;
        }
        case 'error': {
          _showMsg('⚠ ' + event.payload.message);
          break;
        }
      }
    }
  } catch (e) {
    _showMsg('⚠ 篩選發生錯誤：' + e.message);
    console.error('[screener-ui] error:', e);
  } finally {
    _isRunning = false;
    _setRunBtnState(false);
    setTimeout(() => {
      if (progressEl) progressEl.style.display = 'none';
    }, 1500);
  }
}

// ─────────────────────────────────────────────
// 結果列表渲染
// ─────────────────────────────────────────────
function _sortedRows(rows) {
  const key = _sortKey;
  const asc = _sortAsc;
  return [...rows].sort((a, b) => {
    let av, bv;
    if (key === 'health') {
      const _s = c => c?.length > 65 ? c.slice(-65) : c;
      av = (_s(a.candles)?.length >= 20 ? calcHealth(_s(a.candles)) : calcHealthFast(a)) ?? -1;
      bv = (_s(b.candles)?.length >= 20 ? calcHealth(_s(b.candles)) : calcHealthFast(b)) ?? -1;
      // 排序用短線分數
    } else {
      av = a[key] ?? (key === 'chgPct' ? -999 : 0);
      bv = b[key] ?? (key === 'chgPct' ? -999 : 0);
    }
    return asc ? av - bv : bv - av;
  });
}

function _renderResults(rows) {
  const el = document.getElementById('screenerResults');
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = `<div class="sc-results-empty">
      ${_isRunning ? '篩選中…' : '目前沒有符合條件的股票'}
    </div>`;
    return;
  }

  const sorted = _sortedRows(rows);

  // 欄位定義：[key, label]
  const cols = [
    { key: null,       label: '代號／名稱' },
    { key: 'price',    label: '收盤價' },
    { key: 'chgPct',   label: '漲跌幅' },
    { key: 'volume',   label: '成交量' },
    { key: 'health',   label: '健康度' },
    { key: null,       label: '符合指標' },
  ];

  const headerHtml = cols.map(c => {
    if (!c.key) return `<span>${c.label}</span>`;
    const isActive = _sortKey === c.key;
    const arrow    = isActive ? (_sortAsc ? ' ↑' : ' ↓') : ' ⇅';
    return `<span class="sc-sort-col${isActive ? ' active' : ''}" data-sort="${c.key}" style="cursor:pointer;user-select:none">${c.label}<span style="opacity:${isActive?1:0.35};font-size:11px">${arrow}</span></span>`;
  }).join('');

  el.innerHTML = `
    <div class="sc-results-header">${headerHtml}</div>
    <div class="sc-results-body">
      ${sorted.map(r => _renderResultRow(r)).join('')}
    </div>`;

  // 點欄位標題 → 排序
  el.querySelectorAll('.sc-sort-col').forEach(col => {
    col.addEventListener('click', () => {
      const key = col.dataset.sort;
      if (_sortKey === key) {
        _sortAsc = !_sortAsc;
      } else {
        _sortKey = key;
        _sortAsc = false;  // 新欄位預設降冪
      }
      _renderResults(_results);
    });
  });

  // 點個股列 → 跳看盤，帶 matchedConds 讓個股頁顯示篩選條件標籤
  el.querySelectorAll('.sc-result-row').forEach(row => {
    row.addEventListener('click', () => {
      const code = row.dataset.code;
      if (!code) return;
      // 找到對應的篩選結果，取 matchedConds
      const result = _results.find(r => r.code === code);
      const matchedConds = result?.matchedConds ?? [];
      document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
      document.querySelector('.main-tab[data-tab="chart"]')?.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tabChart')?.classList.add('active');
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.tab-item[data-mobile-tab="chart"]')?.classList.add('active');
      document.querySelector('.sidebar').style.display = '';
      document.querySelector('.main').style.display    = '';
      document.dispatchEvent(new CustomEvent('stockSelect', {
        detail: { code, matchedConds, fromScreener: true }
      }));
    });
  });
}

function _renderResultRow(r) {
  const fmt    = v => v == null ? '—' : v >= 100 ? v.toFixed(1) : v.toFixed(2);
  const fmtVol = v => {
    if (!v) return '—';
    if (v >= 10000) return (v / 10000).toFixed(1) + '萬';
    return v.toLocaleString();
  };
  const chgCls = r.chgPct > 0 ? 'up' : r.chgPct < 0 ? 'down' : 'flat';
  const chgStr = r.chgPct != null
    ? `${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(2)}%`
    : '—';
  const tags = r.matchedConds.slice(0, 4).map(
    label => `<span class="sc-tag">${label}</span>`
  ).join('');

  // 短線：固定取最後 65 根（≈3mo），沒有 candles 才 fallback 快估
  const _sc = r.candles?.length > 65 ? r.candles.slice(-65) : r.candles;
  const healthShort = _sc?.length >= 20
    ? calcHealth(_sc)
    : calcHealthFast(r);
  // 長線：需 ≥120 根（screener 3mo 通常不夠，顯示 —）
  const healthLong  = r.candles?.length >= 120 ? calcHealthLong(r.candles, _scFundCache[r.code] ?? null) : null;

  // v2.7+ 訊號觸發資訊 chip
  // 格式:「已亮 N 天 · 起 MM/DD」(全要版,使用者選 D 選項)
  const triggerChip = _renderTriggerChip(r.triggerHistory);

  return `
    <div class="sc-result-row" data-code="${r.code}">
      <div class="sc-result-id">
        <span class="sc-code">${r.code}</span>
        <span class="sc-name">${r.name}</span>
      </div>
      <div class="sc-result-price">${fmt(r.price)}</div>
      <div class="sc-result-chg ${chgCls}">${chgStr}</div>
      <div class="sc-result-vol">${fmtVol(r.volume)}</div>
      <div class="sc-result-health">${healthBadgeDual(healthShort, healthLong, 'sc')}</div>
      <div class="sc-result-tags">${tags}${triggerChip}</div>
    </div>`;
}

/**
 * v2.7+ 渲染訊號觸發資訊 chip
 *
 * 顯示:「已亮 N 天 · 起 MM/DD」
 * isNew=true 時:「✨ 今天新觸發」(streak=1)
 * null 時:不渲染
 *
 * ⚠️ 永久備忘(2026-05-24 踩雷):
 *   candle.time 是 Yahoo 給的「Unix 秒數」(整數 10 位 1.7×10⁹ 級別)
 *   不是毫秒(13 位 1.7×10¹² 級別)
 *   直接 new Date(time) 會解析成 1970 年的某天
 *   必須乘 1000 才會得到正確的 2026 年日期
 *   參考:roadmap 0522 已記載「K線時間軸顯示 UTC」相同源頭問題
 *
 * @param {object|null} th  { streak, firstTriggerDate, isNew, totalTriggers }
 * @returns {string} HTML chip 字串
 */
function _renderTriggerChip(th) {
  if (!th) return '';
  const { streak, firstTriggerDate, isNew, totalTriggers } = th;

  // 解析日期 → MM/DD 格式
  let mmdd = '—';
  if (firstTriggerDate != null) {
    try {
      let ts = firstTriggerDate;
      // 字串日期(如 '2026-05-22')直接 new Date 就好
      // 數字:判斷秒 vs 毫秒
      //   - 秒:約 10 位數(< 10^11) → 乘 1000
      //   - 毫秒:約 13 位數(>= 10^11)
      // 邊界值:2001 年的毫秒約 10^12,所以用 10^11 當判斷線安全
      if (typeof ts === 'number' && ts < 1e11) {
        ts = ts * 1000;
      }
      const d = new Date(ts);
      if (!isNaN(d)) {
        const m  = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        mmdd = `${m}/${dd}`;
      }
    } catch (_) {}
  }

  // 過去 120 天觸發次數(僅在 tooltip 顯示)
  const tooltipText = `過去 120 天共觸發 ${totalTriggers} 次`;

  if (isNew) {
    // 今天才剛觸發(streak=1) → 高亮金色
    return `<span class="sc-trigger-chip is-new" title="${tooltipText}">
      ✨ 今天新觸發 · ${mmdd}
    </span>`;
  }

  // 已亮多天
  return `<span class="sc-trigger-chip" title="${tooltipText}">
    🔆 已亮 ${streak} 天 · 起 ${mmdd}
  </span>`;
}

// ─────────────────────────────────────────────
// 已儲存的篩選組合
// ─────────────────────────────────────────────
async function _renderSavedSets() {
  const el = document.getElementById('screenerSavedSets');
  if (!el) return;

  const sets = await loadSavedSets();
  if (!sets.length) {
    el.innerHTML = '<div class="sc-saved-empty">尚無儲存的篩選組合</div>';
    return;
  }

  el.innerHTML = sets.map(s => `
    <div class="sc-saved-item">
      <span class="sc-saved-name">${_escHtml(s.name)}</span>
      <span class="sc-saved-count">${s.conditions.length} 個條件</span>
      <button class="sc-saved-load" data-id="${_escHtml(s.id)}">載入</button>
      <button class="sc-saved-del"  data-id="${_escHtml(s.id)}">✕</button>
    </div>`).join('');

  el.querySelectorAll('.sc-saved-load').forEach(btn => {
    btn.addEventListener('click', async () => {
      const allSets = await loadSavedSets();
      const set = allSets.find(s => s.id === btn.dataset.id);
      if (!set) return;
      _conditions = set.conditions.map(c => {
        const def = CONDITION_DEFS.find(d => d.id === c.id);
        return def ? { id: c.id, def, value: c.value } : null;
      }).filter(Boolean);
      _currentStrategyName = null;
      _renderConditionArea();
      _showMsg(`已載入：${set.name}`);
    });
  });

  el.querySelectorAll('.sc-saved-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteSavedSet(btn.dataset.id);
      await _renderSavedSets();
    });
  });
}

// ─────────────────────────────────────────────
// 結果備份 — toolbar 按鈕 show/hide
// ─────────────────────────────────────────────

function _showSaveResultBtn() {
  const btn = document.getElementById('screenerSaveResultBtn');
  if (btn) btn.style.display = '';
}

function _hideSaveResultBtn() {
  const btn  = document.getElementById('screenerSaveResultBtn');
  const area = document.getElementById('screenerSaveResultArea');
  if (btn)  btn.style.display  = 'none';
  if (area) area.style.display = 'none';
}

// ─────────────────────────────────────────────
// 結果備份 — 命名輸入列（展開 / 收合）
// ─────────────────────────────────────────────
function _toggleSaveNameArea() {
  const area = document.getElementById('screenerSaveResultArea');
  if (!area) return;

  // 已展開命名列 → 收起
  if (area.style.display !== 'none' && area.dataset.mode === 'save') {
    area.style.display = 'none';
    return;
  }

  area.dataset.mode  = 'save';
  area.style.display = '';
  area.innerHTML = `
    <div class="sc-save-result-bar">
      <span class="sc-save-result-count">共 ${_results.length} 檔</span>
      <input
        class="sc-save-result-input"
        id="screenerResultName"
        type="text"
        placeholder="輸入名稱（如：S1量價齊揚 0515）"
        maxlength="40"
      />
      <button class="sc-save-result-confirm" id="screenerResultConfirmBtn">確認儲存</button>
      <button class="sc-save-result-cancel"  id="screenerResultCancelBtn">✕</button>
    </div>`;

  document.getElementById('screenerResultName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('screenerResultConfirmBtn')?.click();
  });

  document.getElementById('screenerResultConfirmBtn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('screenerResultName');
    const name      = nameInput?.value.trim() || '';
    try {
      await saveResult(name, _results, {
        strategy:   _currentStrategyName,
        condLabels: _currentCondLabels,
      });
      document.dispatchEvent(new CustomEvent('showToast', {
        detail: `✓ 已儲存「${name || '篩選結果'}」`,
      }));
      area.style.display = 'none';
      // 自動展開歷史區塊讓使用者看到剛存的記錄
      document.querySelector('.saved-results-section')?.setAttribute('open', '');
      await _renderSavedResultsList();
    } catch (e) {
      document.dispatchEvent(new CustomEvent('showToast', {
        detail: `❌ 儲存失敗：${e.message}`,
      }));
    }
  });

  document.getElementById('screenerResultCancelBtn')?.addEventListener('click', () => {
    area.style.display = 'none';
  });
}

// ─────────────────────────────────────────────
// 結果備份 — 歷史清單
// ─────────────────────────────────────────────
async function _renderSavedResultsList() {
  const container = document.getElementById('screenerSavedList');
  if (!container) return;

  const all = await loadAllResults();

  if (!all.length) {
    container.innerHTML = `<div class="sc-saved-empty">尚無儲存的篩選結果</div>`;
    return;
  }

  container.innerHTML = all.map(entry => {
    const dateStr   = _formatDate(entry.savedAt);
    const stratLabel = entry.strategy
      ? `<span class="sc-ri-strategy">${_escHtml(entry.strategy)}</span>`
      : '';
    const condStr   = (entry.condLabels ?? []).join('、') || '（無條件資訊）';
    const results   = entry.results ?? [];
    const stockTags = results.slice(0, 8).map(r =>
      `<span class="sc-ri-stock-tag">${_escHtml(r.code)} ${_escHtml(r.name ?? '')}</span>`
    ).join('') + (results.length > 8
      ? `<span class="sc-ri-stock-more">+${results.length - 8}</span>`
      : '');

    return `
    <div class="sc-saved-result-item">
      <div class="sc-ri-header">
        <span class="sc-ri-name">${_escHtml(entry.name)}</span>
        ${stratLabel}
        <span class="sc-ri-date">${dateStr}</span>
        <span class="sc-ri-count">${results.length} 檔</span>
        <div class="sc-ri-actions">
          <button class="sc-ri-btn-load" data-result-id="${entry.id}">📂 載入</button>
          <button class="sc-ri-btn-del"  data-result-id="${entry.id}">🗑</button>
        </div>
      </div>
      <div class="sc-ri-conds">${_escHtml(condStr)}</div>
      <div class="sc-ri-stocks">${stockTags}</div>
    </div>`;
  }).join('');

  // 事件委派（dataset.bound 防重複）
  if (!container.dataset.bound) {
    container.dataset.bound = '1';
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-result-id]');
      if (!btn) return;
      const id = btn.dataset.resultId;
      if (btn.classList.contains('sc-ri-btn-load')) {
        const fresh = await loadAllResults();
        _loadResultEntry(id, fresh);
      }
      if (btn.classList.contains('sc-ri-btn-del')) {
        if (!confirm('確定刪除這筆備份？')) return;
        await deleteResult(id);
        await _renderSavedResultsList();
      }
    });
  }
}

function _loadResultEntry(id, all) {
  const entry = all.find(e => e.id === id);
  if (!entry) return;

  _results = entry.results ?? [];
  _renderResults(_results);

  // 顯示「已載入備份」提示列
  const area = document.getElementById('screenerSaveResultArea');
  if (area) {
    area.dataset.mode  = 'loaded';
    area.style.display = '';
    area.innerHTML = `
      <div class="sc-save-result-bar sc-save-result-bar--loaded">
        <span class="sc-save-result-loaded-label">📂 已載入：${_escHtml(entry.name)}</span>
        <span class="sc-save-result-count">${_results.length} 檔 ／ ${_formatDate(entry.savedAt)}</span>
        <button class="sc-save-result-cancel" id="screenerClearLoadedBtn">✕</button>
      </div>`;
    document.getElementById('screenerClearLoadedBtn')?.addEventListener('click', () => {
      area.style.display = 'none';
      _results = [];
      _renderResults([]);
    });
  }

  _updateStatus(`已載入備份「${entry.name}」，共 ${_results.length} 檔`);
  AppState.screener.results = _results;
}

// ─────────────────────────────────────────────
// UI 狀態工具
// ─────────────────────────────────────────────
function _updateStatus(msg) {
  const el = document.getElementById('screenerStatus');
  if (el) el.textContent = msg;
}

function _showMsg(msg) {
  _updateStatus(msg);
}

function _updateProgress(done, total) {
  const bar = document.getElementById('screenerProgressBar');
  const txt = document.getElementById('screenerProgressText');
  if (!bar || !txt) return;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  bar.style.width = `${pct}%`;
  txt.textContent = `${done} / ${total}`;
}

function _setRunBtnState(running) {
  const btn = document.getElementById('screenerRun');
  if (!btn) return;
  btn.disabled    = running;
  btn.textContent = running ? '篩選中…' : '開始篩選';
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _formatDate(ts) {
  if (!ts) return '';
  const d   = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
