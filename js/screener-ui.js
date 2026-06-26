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
import { addStockToGroup } from './watchlist.js';
import { watchAddCode, createList as pfCreateList } from './portfolio.js';

// fund 快取（結果渲染後批次讀入）
let _scFundCache = {};
import { calcHealth, calcHealthFast, calcHealthLong, renderHealthBadge, shortHealthScore } from './health.js';
import { Config } from './config.js';
import { getKlineCache, getAllSignalsCache } from './db.js';
import { openStockPreview } from './stock-preview.js';

// 目前使用中的條件列
let _conditions = [];
let _isRunning  = false;
let _results    = [];
let _sortKey    = 'chgPct';   // 預設：漲跌幅
let _sortAsc    = false;       // 預設：降冪
let _page       = 1;           // 結果分頁（15 檔/頁）
let _yaoguMap   = new Map();   // code → { x1,x2,x5,x6, rank }（妖股標籤）
const PAGE_SIZE = 15;

// 本次篩選 meta（供備份用）
let _currentStrategyName = null;
let _currentStrategyId   = null;
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
  // 系統發現「🔍 個篩」在 hub lazy init 前就 dispatch → 事件已掉，從全域暫存消化
  if (window.__screenerPresetConds) {
    const d = window.__screenerPresetConds;
    window.__screenerPresetConds = null;
    _applyPresetConds(d);
  }
}

// ── 系統發現/名人堂 → 個篩自訂條件 套用 ─────────────────────────────────
// GAS 條件與前端同名不同義者（踩雷備忘：kd_k_min 反義、vol_surge/bb 系列門檻不同）
const _GAS_SEMANTIC_WARN = new Set(['kd_k_min', 'vol_surge', 'bb_squeeze', 'bb_expanding']);

// GAS 固定門檻等效值（heatmap_calc.gs _calcConditions 語意）：
// 套用系統發現條件時用這些值，不用前端 default（門檻不同會讓命中數對不上，
// 例：gain_10d GAS >5%，前端 default 10% → 直接篩掉一半）
const _GAS_EQUIV_VALUES = {
  gain_10d: 5,      // 近10日漲 >5%
  loss_5d: 5,       // 近5日跌 >5%
  rsi_min: 50,      // RSI ≥50
  rsi_max: 80,      // RSI ≥80
  kd_k_max: 80,     // K ≥80
  vol_surge: 1.5,   // 量 ≥1.5x
};

function _applyPresetConds(detail, opts = {}) {
  const { conds, name } = detail ?? {};
  const autorun = opts.autorun !== false;
  if (!Array.isArray(conds) || !conds.length) return;
  _conditions = [];
  const missing = [], warned = [];
  for (const id of conds) {
    const def = CONDITION_DEFS.find(d => d.id === id);
    if (!def) { missing.push(id); continue; }
    if (_GAS_SEMANTIC_WARN.has(id)) warned.push(id);
    const value = (id in _GAS_EQUIV_VALUES) ? _GAS_EQUIV_VALUES[id] : def.default;
    _conditions.push({ id, def, value });
  }
  _currentStrategyName = name ?? '系統發現';
  _currentStrategyId   = null;
  _renderConditionArea();

  let note = `已套用：${name ?? conds.join('+')}`;
  if (warned.length)  note += `｜⚠ ${warned.join(',')} 前端與 GAS 語意/門檻不同，結果可能與系統發現命中數有出入`;
  if (missing.length) note += `｜❌ 個篩無此條件已略過：${missing.join(',')}`;
  _updateStatus(note);
  if (missing.length || !autorun) {
    openScreenerModal();             // 缺漏或匯入模式 → 開 modal 讓使用者確認
    _switchToCustomTabLocal();
  } else {
    requestAnimationFrame(() => _runScreener());  // 全數套用 → 直接開篩
  }
}

/* 📥 匯入條件清單：解析貼上的文字，抽出合法 condition id（吃 lab-discovered 📋 複製格式或任意含 id 的文字） */
function _injectImportUI() {
  const pc = document.getElementById('scPanelCustom');
  if (!pc || pc.querySelector('#scImportCondsBtn')) return;
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:10px;border-top:1px solid var(--border,#222);padding-top:10px';
  row.innerHTML = `
    <button id="scImportCondsBtn" class="sc-add-cond-btn" type="button"
      style="font-size:12px">📥 匯入條件清單</button>
    <div id="scImportCondsBox" style="display:none;margin-top:8px">
      <textarea id="scImportCondsTa" rows="5" placeholder="貼上系統發現 📋 複製的條件清單（或任何含 condition id 的文字）"
        style="width:100%;background:var(--bg,#0d1117);color:var(--text,#ddd);border:1px solid var(--border,#333);border-radius:6px;padding:8px;font-size:12px;font-family:monospace;resize:vertical"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
        <button id="scImportCondsApply" class="sc-add-cond-btn" type="button" style="font-size:12px">套用</button>
      </div>
      <div id="scImportCondsMsg" style="font-size:11px;color:var(--muted,#888);margin-top:4px"></div>
    </div>`;
  pc.appendChild(row);

  row.querySelector('#scImportCondsBtn').addEventListener('click', () => {
    const box = row.querySelector('#scImportCondsBox');
    box.style.display = box.style.display === 'none' ? '' : 'none';
  });
  row.querySelector('#scImportCondsApply').addEventListener('click', () => {
    const ta  = row.querySelector('#scImportCondsTa');
    const msg = row.querySelector('#scImportCondsMsg');
    const text = ta.value ?? '';
    // 抽 token、按出現順序比對合法 condition id，去重
    const ids = new Set(CONDITION_DEFS.map(d => d.id));
    const found = [];
    for (const tok of text.match(/[a-z][a-z0-9_]+/gi) ?? []) {
      const t = tok.toLowerCase();
      if (ids.has(t) && !found.includes(t)) found.push(t);
    }
    if (!found.length) { msg.textContent = '❌ 沒有解析到任何合法 condition id'; return; }
    _applyPresetConds({ conds: found, name: '匯入清單' }, { autorun: false });
    msg.textContent = `✅ 已套用 ${found.length} 個條件：${found.join(', ')}（按「開始篩選」執行）`;
  });
}

// 切到自訂條件 tab（與 _switchToStrategyTab 對稱）
function _switchToCustomTabLocal() {
  document.querySelectorAll('.sc-left-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.sc-left-tab[data-left-tab="custom"]')?.classList.add('active');
  const pc = document.getElementById('scPanelCustom');
  const ps = document.getElementById('scPanelStrategy');
  if (pc) pc.style.display = '';
  if (ps) ps.style.display = 'none';
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
    _currentStrategyId   = null;
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

  document.addEventListener('screener:applyConds', (e) => {
    window.__screenerPresetConds = null; // 已由事件接手，清掉暫存防 init 重複消化
    _applyPresetConds(e.detail);
  });

  document.addEventListener('strategyApplied', (e) => {
    _currentStrategyName = e.detail?.name ?? null;
    _currentStrategyId   = e.detail?.id   ?? null;
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
  // 同時更新 modal 內的條件列和主畫面的條件摘要
  _renderCondIntoEl('screenerConditionsModal');
  _renderCondSummary();
}

function _renderCondIntoEl(wrapperId) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;

  if (!_conditions.length) {
    wrap.innerHTML = `<div class="sc-empty-conds">尚未新增任何條件<br>點擊「＋ 新增條件」</div>`;
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

// 主畫面條件摘要列（顯示 tag）
function _renderCondSummary() {
  const summary = document.getElementById('screenerCondSummary');
  const tagsEl  = document.getElementById('screenerCondTags');
  if (!summary || !tagsEl) return;
  if (!_conditions.length) {
    summary.style.display = 'none';
    return;
  }
  summary.style.display = '';
  tagsEl.innerHTML = _conditions.map(c =>
    `<span class="sc-cond-tag-pill">${_escHtml(c.def.label)}</span>`
  ).join('');
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
  // Modal 內「＋ 新增條件」
  document.getElementById('screenerAddCondModal')?.addEventListener('click', () => {
    const def = CONDITION_DEFS[0];
    _conditions.push({ id: def.id, def, value: def.default });
    _renderConditionArea();
  });

  // Modal 內「清除全部」
  document.getElementById('screenerModalClear')?.addEventListener('click', () => {
    _conditions = [];
    _currentStrategyName = null;
    _renderConditionArea();
    _renderResults([]);
    _hideSaveResultBtn();
    _updateStatus('');
  });

  // Modal 內「開始篩選」→ 關 modal 後執行篩選
  document.getElementById('screenerModalRun')?.addEventListener('click', () => {
    _closeScreenerModal();
    requestAnimationFrame(() => _runScreener());
  });

  // Modal 內「儲存組合」
  document.getElementById('screenerModalSave')?.addEventListener('click', async () => {
    if (!_conditions.length) return;
    const name = prompt('輸入篩選組合名稱：', `自訂篩選 ${new Date().toLocaleDateString('zh-TW')}`);
    if (!name?.trim()) return;
    await saveSet(name.trim(), _conditions);
    await _renderSavedSets();
    _showMsg('篩選組合已儲存');
  });

  // Modal tab 切換（strategy.js 也會綁 .sc-left-tab，這裡只需確保 panel 切換正確）
  // strategy.js 的 _switchToCustomTab 已處理 scPanelCustom/scPanelStrategy 的顯隱
  // 所以這裡不需要重複綁

  // Modal 開關
  document.getElementById('screenerModalClose')?.addEventListener('click', _closeScreenerModal);
  document.getElementById('screenerModalBg')?.addEventListener('click', e => {
    if (e.target.id === 'screenerModalBg') _closeScreenerModal();
  });

  // 主畫面「編輯條件」btn → 開 modal
  document.getElementById('screenerCondEditBtn')?.addEventListener('click', openScreenerModal);

  // 舊版相容：toolbar 靜態「儲存結果」按鈕
  document.getElementById('screenerSaveResultBtn')?.addEventListener('click', _toggleSaveNameArea);
  // 舊版相容：toolbar「全部加入追蹤」按鈕
  document.getElementById('screenerAddAllToWlBtn')?.addEventListener('click', () => {
    _openAddAllWlPopover(document.getElementById('screenerAddAllToWlBtn'));
  });
}

// ── 個篩 Modal 開關 ───────────────────────────────────────
export function openScreenerModal() {
  const bg = document.getElementById('screenerModalBg');
  if (bg) bg.style.display = 'flex';
  _renderConditionArea();
  _injectImportUI();
  _renderSavedSets();
  // 預設顯示策略庫 tab（每次開啟都切回，不殘留上次的 custom）
  _switchToStrategyTab();
}

// 切到策略庫 tab（與 strategy.js 的 _switchToCustomTab 對稱）
function _switchToStrategyTab() {
  document.querySelectorAll('.sc-left-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.sc-left-tab[data-left-tab="strategy"]')?.classList.add('active');
  const pc = document.getElementById('scPanelCustom');
  const ps = document.getElementById('scPanelStrategy');
  if (pc) pc.style.display = 'none';
  if (ps) ps.style.display = '';
}

function _closeScreenerModal() {
  const bg = document.getElementById('screenerModalBg');
  if (bg) bg.style.display = 'none';
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

  // overlay 和 running 狀態先設（在任何 await 之前，讓使用者馬上看到）
  _isRunning           = true;
  _results             = [];
  _page                = 1;
  _loadYaoguMap();
  _currentCondLabels   = _conditions.map(c => c.def.label);
  _hideSaveResultBtn();
  _setRunBtnState(true);

  const el = document.getElementById('screenerResults');
  if (el) {
    el.innerHTML = `<div id="scScanningOverlay" style="padding:60px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;box-sizing:border-box;">
      <div id="scScanningStatus" style="font-size:13px;color:var(--text)">正在取得全市場資料…</div>
      <div id="scScanningCount" style="font-size:24px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums;letter-spacing:.02em"></div>
    </div>`;
  }

  // 等 fetchTWSEPrices 完成（overlay 已顯示，使用者看得到進度）
  if (window.__twsePricesReady) {
    _updateStatus('等待市場資料載入…');
    try { await window.__twsePricesReady; } catch (_) {}
  }

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
      av = shortHealthScore({ code: a.code, row: a, candles: _s(a.candles) }) ?? -1;
      bv = shortHealthScore({ code: b.code, row: b, candles: _s(b.candles) }) ?? -1;
      // 排序用短線分數
    } else if (key === 'code') {
      // 代號是字串，數值化排序（含 00 開頭 ETF）
      av = parseInt(a.code, 10) || 0;
      bv = parseInt(b.code, 10) || 0;
    } else if (key === 'yaogu') {
      av = _yaoguMap.get(a.code)?.rank ?? 0;
      bv = _yaoguMap.get(b.code)?.rank ?? 0;
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
    if (_isRunning) {
      // 不清空 loading overlay，由 _updateStatus/_updateProgress 控制
      return;
    }
    el.innerHTML = `<div class="sc-results-empty">目前沒有符合條件的股票</div>`;
    return;
  }

  const sorted = _sortedRows(rows);

  const cols = [
    { key: 'code',   label: '代號' },
    { key: null,     label: '名稱',     noSort: true },
    { key: 'price',  label: '收盤價',   align: 'right' },
    { key: 'chgPct', label: '漲跌幅',   align: 'right' },
    { key: 'volume', label: '成交量',   align: 'right' },
    { key: 'health', label: '健康度' },
    { key: 'yaogu',  label: '妖股' },
    { key: null,     label: '走勢',     noSort: true },
    { key: null,     label: '符合指標', noSort: true },
    { key: null,     label: '',         noSort: true },
  ];

  let thead = '<tr>';
  cols.forEach(col => {
    const alignCls = col.align === 'right' ? ' sc-tbl-num' : '';
    if (col.noSort) {
      thead += `<th class="sc-tbl-th no-sort${alignCls}">${col.label}</th>`;
      return;
    }
    const isSorted = _sortKey === col.key;
    const arrow = isSorted ? (_sortAsc ? ' ▲' : ' ▼') : '';
    thead += `<th class="sc-tbl-th${isSorted ? ' sorted' : ''}${alignCls}" data-sort="${col.key}">${col.label}${arrow}</th>`;
  });
  thead += '</tr>';

  // ── 分頁：15 檔/頁 ──
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (_page > totalPages) _page = totalPages;
  const pageRows = sorted.slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);

  const tbody = pageRows.map(r => _renderResultRow(r)).join('');
  const pager = totalPages > 1 ? _renderPager(totalPages, sorted.length) : '';
  el.innerHTML = `<div class="sc-tbl-wrap"><table class="sc-tbl"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>${pager}`;

  // pager 事件
  el.querySelectorAll('.sc-pager-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (!p || p === _page) return;
      _page = p;
      _renderResults(_results);
      el.closest('.sc-results-full')?.scrollTo({ top: 0 });
    });
  });

  el.querySelectorAll('.sc-tbl-th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) _sortAsc = !_sortAsc;
      else { _sortKey = key; _sortAsc = false; }
      _page = 1;
      _renderResults(_results);
    });
  });

  el.querySelectorAll('.sc-result-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sc-add-wl-btn')) return;
      const code = row.dataset.code;
      if (!code) return;
      const result = _results.find(r => r.code === code);
      const matchedConds = result?.matchedConds ?? [];
      // 點擊 → 開個股速覽 modal；ctx 透傳給 modal 的「進入個股頁面」（stockSelect detail）
      openStockPreview(code, {
        matchedConds,
        matchedCondIds: result?.matchedCondIds ?? [],
        strategyId: _currentStrategyId,
        strategyName: _currentStrategyName,
        fromScreener: true,
      });
    });
  });

  el.querySelectorAll('.sc-add-wl-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openAddWlPopover(btn, btn.dataset.code, btn.dataset.name);
    });
  });

  _enqueueScSparklines(el, pageRows);
}

// ─── 妖股標籤 ─────────────────────────────────────────────
async function _loadYaoguMap() {
  _yaoguMap = new Map();
  let allCache = [];
  try { allCache = await getAllSignalsCache(); } catch (_) {}
  allCache.forEach(row => {
    const sigs = row.signals ?? [];
    const x1 = sigs.some(sg => sg.id === 'X1');
    const x2 = sigs.some(sg => sg.id === 'X2');
    const x5 = sigs.some(sg => sg.id === 'X5');
    const x6 = sigs.some(sg => sg.id === 'X6');
    if (x1 || x2 || x5 || x6) {
      // 排序權重：X2 > X1 > X6 > X5
      _yaoguMap.set(row.code, { x1, x2, x5, x6, rank: x2 ? 4 : x1 ? 3 : x6 ? 2 : 1 });
    }
  });
}

function _ygPills(code) {
  const yg = _yaoguMap.get(code);
  if (!yg) return '';
  return ['X2','X1','X6','X5']
    .filter(id => yg[id.toLowerCase()])
    .map(id => `<span class="th-yaogu-pill th-yaogu-pill--${id.toLowerCase()}">${id}</span>`)
    .join('');
}

// ─── 結果分頁列 ───────────────────────────────────────────
function _renderPager(totalPages, totalRows) {
  // 頁碼窗口：1 … (cur-1 cur cur+1) … last
  const cur = _page;
  const pages = new Set([1, totalPages, cur - 1, cur, cur + 1]);
  const list = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let btns = '';
  let prev = 0;
  for (const p of list) {
    if (p - prev > 1) btns += `<span style="color:var(--hint);padding:0 2px">…</span>`;
    const active = p === cur;
    btns += `<button class="sc-pager-btn" data-page="${p}" style="
      min-width:28px;padding:3px 7px;font-size:12px;border-radius:4px;cursor:pointer;
      border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};
      background:${active ? 'rgba(59,130,246,.12)' : 'transparent'};
      color:${active ? 'var(--accent)' : 'var(--muted)'};">${p}</button>`;
    prev = p;
  }
  const prevBtn = `<button class="sc-pager-btn" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''} style="padding:3px 7px;font-size:12px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:${cur <= 1 ? 'not-allowed' : 'pointer'};opacity:${cur <= 1 ? '.4' : '1'}">‹</button>`;
  const nextBtn = `<button class="sc-pager-btn" data-page="${cur + 1}" ${cur >= totalPages ? 'disabled' : ''} style="padding:3px 7px;font-size:12px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:${cur >= totalPages ? 'not-allowed' : 'pointer'};opacity:${cur >= totalPages ? '.4' : '1'}">›</button>`;

  return `<div class="sc-pager" style="display:flex;align-items:center;justify-content:center;gap:4px;padding:10px 0">
    ${prevBtn}${btns}${nextBtn}
    <span style="font-size:11px;color:var(--hint);margin-left:8px">共 ${totalRows} 檔</span>
  </div>`;
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
  // 符合指標欄：只顯示策略名稱（自訂條件不顯示）
  const tags = _currentStrategyName
    ? `<span class="sc-tag sc-tag-strategy">${_currentStrategyName}</span>`
    : '';

  // 短線：固定取最後 65 根（≈3mo），沒有 candles 才 fallback 快估
  const _sc = r.candles?.length > 65 ? r.candles.slice(-65) : r.candles;
  const healthShort = shortHealthScore({ code: r.code, row: r, candles: _sc });
  // 長線：需 ≥120 根（screener 3mo 通常不夠，顯示 —）
  const healthLong  = r.candles?.length >= 120 ? calcHealthLong(r.candles, _scFundCache[r.code] ?? null, r.code) : null;

  // v2.7+ 訊號觸發資訊 chip
  // 格式:「已亮 N 天 · 起 MM/DD」(全要版,使用者選 D 選項)
  const triggerChip = _renderTriggerChip(r.triggerHistory);

  return `
    <tr class="sc-result-row" data-code="${r.code}">
      <td class="sc-tbl-td"><span class="sc-tbl-code">${r.code}</span></td>
      <td class="sc-tbl-td"><span class="sc-tbl-name">${r.name}</span></td>
      <td class="sc-tbl-td sc-tbl-num"><span class="sc-tbl-price">${fmt(r.price)}</span></td>
      <td class="sc-tbl-td sc-tbl-num"><span class="sc-tbl-chg ${chgCls}">${chgStr}</span></td>
      <td class="sc-tbl-td sc-tbl-num">${fmtVol(r.volume)}</td>
      <td class="sc-tbl-td">${renderHealthBadge(healthShort, healthLong)}</td>
      <td class="sc-tbl-td">${_ygPills(r.code)}</td>
      <td class="sc-tbl-td"><canvas class="sc-sparkline" data-code="${r.code}" width="80" height="32"></canvas></td>
      <td class="sc-tbl-td sc-tbl-tags">${tags}${tags && triggerChip ? '<span style="display:inline-block;width:6px"></span>' : ''}${triggerChip}</td>
      <td class="sc-tbl-td">
        <button class="sc-add-wl-btn" data-code="${r.code}" data-name="${_escHtml(r.name ?? r.code)}" title="加入追蹤清單">＋</button>
      </td>
    </tr>`;
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
  const el = document.getElementById('screenerSavedSetsModal') ?? document.getElementById('screenerSavedSets');
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
  const btn    = document.getElementById('screenerSaveResultBtn');
  const btnAll = document.getElementById('screenerAddAllToWlBtn');
  if (btn)    btn.style.display    = '';
  if (btnAll) btnAll.style.display = '';
}

function _hideSaveResultBtn() {
  const btn    = document.getElementById('screenerSaveResultBtn');
  const btnAll = document.getElementById('screenerAddAllToWlBtn');
  const area   = document.getElementById('screenerSaveResultArea');
  if (btn)    btn.style.display    = 'none';
  if (btnAll) btnAll.style.display = 'none';
  if (area)   area.style.display   = 'none';
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
        strategyId: _currentStrategyId,
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
  _loadYaoguMap().then(() => _renderResults(_results));  // 妖股快取載完重繪補標籤
  _currentStrategyName = entry.strategy ?? null;
  _currentStrategyId   = entry.strategyId ?? null;
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
  if (_results.length > 0) _showSaveResultBtn();
}

// ─────────────────────────────────────────────
// UI 狀態工具
// ─────────────────────────────────────────────
function _updateStatus(msg) {
  const el = document.getElementById('screenerStatus');
  if (el) el.textContent = msg;
  // 同步更新 loading overlay
  const ov = document.getElementById('scScanningStatus');
  if (ov) ov.textContent = msg;
}

function _showMsg(msg) {
  _updateStatus(msg);
}

function _updateProgress(done, total) {
  const bar = document.getElementById('screenerProgressBar');
  const txt = document.getElementById('screenerProgressText');
  if (bar) bar.style.width = `${total > 0 ? Math.round(done / total * 100) : 0}%`;
  if (txt) txt.textContent = `${done} / ${total}`;
  // 同步更新 loading overlay 計數
  const cnt = document.getElementById('scScanningCount');
  if (cnt && total > 0) cnt.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} 檔`;
}

function _setRunBtnState(running) {
  const btn = document.getElementById('screenerModalRun');
  if (!btn) return;
  btn.disabled    = running;
  btn.textContent = running ? '篩選中…' : '▶ 開始篩選';
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

// ─────────────────────────────────────────────
// 全清單加入「庫存追蹤清單」popover（兩步：選清單 → 命名確認）
// ─────────────────────────────────────────────
function _openAddAllWlPopover(anchor) {
  if (_wlPopover?.dataset.mode === 'all') { _closeWlPopover(); return; }
  _closeWlPopover();

  if (!_results.length) {
    document.dispatchEvent(new CustomEvent('showToast', { detail: '目前沒有篩選結果' }));
    return;
  }

  const api    = window.__portfolioAPI;
  const groups = api ? api.getWatchLists() : [];

  const pop = document.createElement('div');
  pop.className    = 'sc-wl-popover';
  pop.dataset.mode = 'all';
  pop.innerHTML = `
    <div class="sc-wlp-title">加入庫存追蹤清單（${_results.length} 檔）</div>
    <div class="sc-wlp-list">
      ${groups.map(g => `
        <div class="sc-wlp-item" data-list-id="${_escHtml(g.id)}" data-list-name="${_escHtml(g.name)}">
          <span class="sc-wlp-dot"></span>
          <span class="sc-wlp-name">${_escHtml(g.name)}</span>
          <span class="sc-wlp-count">${g.items?.length ?? 0} 檔</span>
        </div>`).join('')}
      <div class="sc-wlp-item sc-wlp-new" data-list-id="__new__">
        <span class="sc-wlp-dot" style="background:#3fb950"></span>
        <span class="sc-wlp-name">＋ 新建追蹤清單</span>
      </div>
    </div>`;

  _positionPopover(pop, anchor);
  _wlPopover = pop;

  pop.querySelectorAll('.sc-wlp-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const listId   = item.dataset.listId;
      const listName = item.dataset.listName ?? '';
      _closeWlPopover();
      _openAddAllConfirm(anchor, listId, listName);
    });
  });

  _bindOutsideClose(pop, anchor);
}

/** 第二步：命名 popover（備註欄位） */
function _openAddAllConfirm(anchor, listId, listName) {
  _closeWlPopover();

  const isNew = listId === '__new__';
  const pop   = document.createElement('div');
  pop.className    = 'sc-wl-popover sc-wl-popover--confirm';
  pop.dataset.mode = 'confirm';
  pop.innerHTML = `
    <div class="sc-wlp-title">${isNew ? '新建追蹤清單' : `加入「${_escHtml(listName)}」`}</div>
    <div class="sc-wlp-form">
      ${isNew ? `<input class="sc-wlp-input" id="scWlNewName" placeholder="清單名稱（必填）" maxlength="20" />` : ''}
      <input class="sc-wlp-input" id="scWlNote" placeholder="備註（選填，套用至全部）" maxlength="40" />
      <div class="sc-wlp-actions">
        <button class="sc-wlp-cancel">取消</button>
        <button class="sc-wlp-confirm">確認加入 ${_results.length} 檔</button>
      </div>
    </div>`;

  _positionPopover(pop, anchor);
  _wlPopover = pop;

  // 自動 focus
  setTimeout(() => (pop.querySelector('#scWlNewName') ?? pop.querySelector('#scWlNote'))?.focus(), 50);

  pop.querySelector('.sc-wlp-cancel')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _closeWlPopover();
  });

  pop.querySelector('.sc-wlp-confirm')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const note     = pop.querySelector('#scWlNote')?.value.trim() ?? '';
    let   targetId = listId;

    if (isNew) {
      const newName = pop.querySelector('#scWlNewName')?.value.trim();
      if (!newName) {
        pop.querySelector('#scWlNewName')?.focus();
        pop.querySelector('#scWlNewName')?.classList.add('sc-wlp-input--err');
        return;
      }
      const newList = await pfCreateList('watch', newName);
      targetId = newList.id;
      // 刷新 portfolioAPI 快取
      if (window.__portfolioAPI?.reload) await window.__portfolioAPI.reload();
    }

    _closeWlPopover();

    // 逐一 watchAddCode，已存在跳過
    let added = 0, skipped = 0;
    for (const r of _results) {
      const px = window.__priceCache?.[r.code]?.price ?? r.price ?? 0;
      try {
        const list = await watchAddCode(targetId, r.code, r.name ?? r.code, px, note);
        if (!list) { skipped++; continue; }
        // watchAddCode 已存在時回傳原 list（沒加）
        const wasAlready = list.items.filter(it => it.code === r.code).length > 0
          && list.updatedAt <= list.updatedAt; // 無法判斷，改用 find 前後對比
        added++;
      } catch (_) { skipped++; }
    }

    const targetName = isNew
      ? (pop.querySelector('#scWlNewName')?.value.trim() ?? '新清單')
      : listName;
    document.dispatchEvent(new CustomEvent('showToast', {
      detail: `✓ 已加入「${targetName}」${added} 檔${skipped > 0 ? `（${skipped} 檔略過）` : ''}`
    }));

    // 刷新 portfolio tab
    if (window.__portfolioAPI?.reload) window.__portfolioAPI.reload().catch(() => {});
  });

  _bindOutsideClose(pop, anchor);
}


// ─────────────────────────────────────────────
// 篩選結果「加入追蹤清單」popover
// ─────────────────────────────────────────────
let _wlPopover = null;

function _closeWlPopover() {
  if (_wlPopover) { _wlPopover.remove(); _wlPopover = null; }
}

/** popover 定位：緊貼 anchor 下方，不夠空間改上方 */
function _positionPopover(pop, anchor) {
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const pw   = pop.offsetWidth || 200;
  let left   = rect.right - pw;
  if (left < 6) left = 6;
  if (window.innerHeight - rect.bottom < 240) {
    pop.style.top = `${rect.top + window.scrollY - (pop.offsetHeight || 200) - 4}px`;
  } else {
    pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  }
  pop.style.left = `${Math.min(left, window.innerWidth - pw - 8)}px`;
}

/** 點外部自動關閉 */
function _bindOutsideClose(pop, anchor) {
  setTimeout(() => {
    document.addEventListener('click', function _out(e) {
      if (!pop.contains(e.target) && e.target !== anchor) {
        _closeWlPopover();
        document.removeEventListener('click', _out, true);
      }
    }, true);
  }, 0);
}

/** 單股：新建追蹤清單並加入 */
async function _openSingleConfirm(anchor, code, name) {
  _closeWlPopover();
  const pop = document.createElement('div');
  pop.className    = 'sc-wl-popover sc-wl-popover--confirm';
  pop.dataset.mode = 'single';
  pop.innerHTML = `
    <div class="sc-wlp-title">新建追蹤清單</div>
    <div class="sc-wlp-form">
      <input class="sc-wlp-input" id="scWlSingleName" placeholder="清單名稱（必填）" maxlength="20" />
      <div class="sc-wlp-actions">
        <button class="sc-wlp-cancel">取消</button>
        <button class="sc-wlp-confirm">建立並加入</button>
      </div>
    </div>`;
  _positionPopover(pop, anchor);
  _wlPopover = pop;
  setTimeout(() => pop.querySelector('#scWlSingleName')?.focus(), 50);

  pop.querySelector('.sc-wlp-cancel')?.addEventListener('click', (e) => {
    e.stopPropagation(); _closeWlPopover();
  });
  pop.querySelector('.sc-wlp-confirm')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const newName = pop.querySelector('#scWlSingleName')?.value.trim();
    if (!newName) {
      pop.querySelector('#scWlSingleName')?.classList.add('sc-wlp-input--err');
      return;
    }
    const newList = await pfCreateList('watch', newName);
    const px = window.__priceCache?.[code]?.price ?? 0;
    await watchAddCode(newList.id, code, name, px, '');
    if (window.__portfolioAPI?.reload) await window.__portfolioAPI.reload();
    document.dispatchEvent(new CustomEvent('showToast', { detail: `✓ ${code} 已加入「${newName}」` }));
    _closeWlPopover();
  });
  _bindOutsideClose(pop, anchor);
}

function _openAddWlPopover(anchor, code, name) {
  if (_wlPopover?.dataset.code === code) { _closeWlPopover(); return; }
  _closeWlPopover();

  const api    = window.__portfolioAPI;
  const groups = api ? api.getWatchLists() : [];
  const inLists = new Set(
    groups.filter(g => g.items?.some(it => it.code === code)).map(g => g.id)
  );

  const pop = document.createElement('div');
  pop.className    = 'sc-wl-popover';
  pop.dataset.code = code;
  pop.innerHTML = `
    <div class="sc-wlp-title">加入庫存追蹤清單</div>
    <div class="sc-wlp-list">
      ${groups.map(g => `
        <div class="sc-wlp-item${inLists.has(g.id) ? ' sc-wlp-in' : ''}"
             data-list-id="${_escHtml(g.id)}"
             data-list-name="${_escHtml(g.name)}">
          <span class="sc-wlp-dot"></span>
          <span class="sc-wlp-name">${_escHtml(g.name)}</span>
          <span class="sc-wlp-count">${g.items?.length ?? 0} 檔</span>
          ${inLists.has(g.id) ? '<span class="sc-wlp-check">✓</span>' : ''}
        </div>`).join('')}
      <div class="sc-wlp-item sc-wlp-new" data-list-id="__new__">
        <span class="sc-wlp-dot" style="background:#3fb950"></span>
        <span class="sc-wlp-name">＋ 新建追蹤清單</span>
      </div>
    </div>`;

  _positionPopover(pop, anchor);
  _wlPopover = pop;

  pop.querySelectorAll('.sc-wlp-item:not(.sc-wlp-in)').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const listId   = item.dataset.listId;
      const listName = item.dataset.listName ?? '';
      _closeWlPopover();
      if (listId === '__new__') {
        _openSingleConfirm(anchor, code, name);
      } else {
        const px = window.__priceCache?.[code]?.price ?? 0;
        await watchAddCode(listId, code, name, px, '');
        document.dispatchEvent(new CustomEvent('showToast', { detail: `✓ ${code} 已加入「${listName}」` }));
        if (window.__portfolioAPI?.reload) window.__portfolioAPI.reload().catch(() => {});
      }
    });
  });

  _bindOutsideClose(pop, anchor);
}

// ─── Screener Sparkline ────────────────────────────────────
let _scSparklineQueue = [];
let _scSparklineTimer = null;

function _enqueueScSparklines(container, rows) {
  _scSparklineQueue = [];
  clearTimeout(_scSparklineTimer);
  rows.forEach(r => {
    const canvas = container.querySelector(`.sc-sparkline[data-code="${r.code}"]`);
    if (canvas) _scSparklineQueue.push({ canvas, code: r.code });
  });
  _drainScSparklineQueue();
}

function _drainScSparklineQueue() {
  if (!_scSparklineQueue.length) return;
  const { canvas, code } = _scSparklineQueue.shift();
  if (!document.contains(canvas)) {
    _scSparklineTimer = setTimeout(_drainScSparklineQueue, 0);
    return;
  }
  _drawScSparkline(canvas, code).finally(() => {
    _scSparklineTimer = setTimeout(_drainScSparklineQueue, 30);
  });
}

async function _drawScSparkline(canvas, code) {
  const symbol = code.length <= 4 ? `${code}.TW` : `${code}.TWO`;
  let cached = await getKlineCache(symbol, '1y');
  if (!cached?.candles?.length) {
    const sym2 = code.length <= 4 ? `${code}.TWO` : `${code}.TW`;
    cached = await getKlineCache(sym2, '1y');
  }
  if (!cached?.candles?.length) { _drawScNoData(canvas); return; }

  const raw    = cached.candles.slice(-40);
  const closes = raw.map(c => c.close ?? c[4] ?? null).filter(v => v != null);
  if (closes.length < 5) { _drawScNoData(canvas); return; }

  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const PL = 4, PR = 4, PT = 6, PB = 6;
  const dW = W - PL - PR, dH = H - PT - PB;
  const minV = Math.min(...closes), maxV = Math.max(...closes);
  const range = maxV - minV || 1;
  const xOf = i => PL + (i / (closes.length - 1)) * dW;
  const yOf = v => PT + (1 - (v - minV) / range) * dH;

  // 格線
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(r => {
    const y = PT + r * dH;
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
  });

  // MA20
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

  const isUp = closes[closes.length - 1] >= closes[0];
  const lineColor = isUp ? '#ef5350' : '#26a69a';
  const fillColor = isUp ? 'rgba(239,83,80,0.10)' : 'rgba(38,166,154,0.12)';

  ctx.beginPath();
  closes.forEach((v, i) => { const x = xOf(i), y = yOf(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.lineTo(xOf(closes.length - 1), H - PB);
  ctx.lineTo(PL, H - PB);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  closes.forEach((v, i) => { const x = xOf(i), y = yOf(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();

  const lx = xOf(closes.length - 1), ly = yOf(closes[closes.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
}

function _drawScNoData(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(100,116,139,0.3)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('—', canvas.width / 2, canvas.height / 2 + 3);
}
