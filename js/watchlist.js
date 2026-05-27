/**
 * watchlist.js — 自選清單（群組版）
 *
 * 資料結構改為多群組，每群組內含 stocks[]。
 * 個股可跨群組重複出現。
 * 持久化改走 db.js（IndexedDB）。
 *
 * 對外 API：
 *   initWatchlist()           — main.js 啟動時呼叫
 *   renderWatchlist()         — 重繪整個 sidebar
 *   addStockToGroup(stock, groupId)
 *   removeStockFromGroup(code, groupId)
 *   createGroup(name)
 *   deleteGroup(id)
 *   getDefaultGroupId()       — 取「預設清單」群組 id
 */

import { AppState }    from './state.js';
import { showToast }   from './ui.js';
import {
  getAllGroups, saveGroup, deleteGroup as dbDeleteGroup,
  initDB, migrateFromLocalStorage,
} from './db.js';
import { getChineseName } from './api.js';
import { calcSignalLamps } from './strategy.js';
import { getYaoguStatus } from './signal-scan.js';
import { getYaoguRecord } from './db.js';

// ─── 內部狀態 ──────────────────────────────────────────────────────────────

let _groups = [];          // Group[]，記憶體鏡像
let _collapsed = new Set(); // 摺疊中的群組 id

// ─── MIS debounced DB flush ───────────────────────────────────────────────
// ⚠️ 踩雷備忘（永久，2026-05-21）：
//   MIS 盤中報價(個股 mis-poll / 自選 mis-wl-poll / Firestore realtime)
//   舊版完全不寫 IndexedDB → F5 後回到上次盤後價 → 看起來是「舊價格」。
//   新邏輯：每次 push 都重置 5 秒 debounce,5 秒內沒新報價就寫一次 DB,
//   兼顧「F5 拿得到最新價」+「不要每 15 秒 saveGroup 操爆 DB」。
//   ⚠️ 自選輪詢的 await updateStockPrices 不可移除(整輪強制 flush 的保險)。
let _misFlushTimer = null;
const _MIS_FLUSH_MS = 5000;

function _scheduleMisFlush() {
  if (_misFlushTimer) clearTimeout(_misFlushTimer);
  _misFlushTimer = setTimeout(async () => {
    _misFlushTimer = null;
    try {
      await Promise.all(_groups.map(g => saveGroup(g)));
      console.log(`[watchlist] MIS debounced flush → 已寫 ${_groups.length} 群組到 IndexedDB`);
    } catch (e) {
      console.warn('[watchlist] MIS debounced flush failed:', e.message);
    }
  }, _MIS_FLUSH_MS);
}

// ─── 初始化 ────────────────────────────────────────────────────────────────

export async function initWatchlist() {
  await initDB();
  await migrateFromLocalStorage();
  _groups = await getAllGroups();

  // 若完全空白（全新安裝），建立預設群組
  if (_groups.length === 0) {
    const def = _makeGroup('預設清單', 0);
    _groups = [def];
    await saveGroup(def);
  }

  // 確保預設清單有大盤三檔指數（若已存在則跳過）
  await _ensureDefaultIndices();

  AppState.watchlistGroups = _groups;
  renderWatchlist();
  _bindSidebarEvents();

  // 訊號更新時重繪自選清單（signal-scan.js 觸發）
  if (!document.body.dataset.signalWlBound) {
    document.body.dataset.signalWlBound = '1';
    document.addEventListener('signalsUpdated', async (e) => {
      // v2.8 順帶更新 AppState.yaoguStatus（有哪幾檔有妖股狀態）
      const updatedCodes = Object.keys(e.detail ?? {});
      if (!AppState.yaoguStatus) AppState.yaoguStatus = {};
      for (const code of updatedCodes) {
        try {
          const record  = await getYaoguRecord(code);
          const signals  = AppState.signals?.[code] ?? [];
          // streak 從 DB record 讀取（由 updateYaoguTracker 在掃描時算好存入）
          const streak = record?.streak ?? null;
          const ys = getYaoguStatus(code, signals, record, streak);
          if (ys) AppState.yaoguStatus[code] = ys;
          else    delete AppState.yaoguStatus[code];
        } catch (_) {}
      }
      renderWatchlist();
    });

    // ── PriceHub 廣播事件：有新報價就補到 _groups 並重繪 ──────────────────
    // 解決「盤後要踩才更新」問題：
    //   fetchTWSEPrices / MIS 輪詢 / 任何來源進 Hub → 廣播 → 這裡收到 → 重繪
    //   persist:true（盤後批次）才寫 DB；persist:false（MIS）只更新記憶體
    document.addEventListener('pricesUpdated', (e) => {
      const { map, persist, source } = e.detail ?? {};
      if (!map) return;

      // persist:true 時 PriceHub 已透過 updateStockPrices() 寫好 DB + 重繪
      // 這裡只處理 persist:false（MIS 盤中），避免雙重 saveGroup
      if (persist) return;

      let dirty = false;
      for (const g of _groups) {
        for (const s of g.stocks) {
          const p = map[s.code];
          if (!p) continue;
          s.price  = p.price;
          s.chg    = p.chg;
          s.chgPct = p.chgPct;
          dirty = true;
        }
      }
      if (dirty) renderWatchlist();
    });
  }
}

/**
 * reloadWatchlist()
 * authReady 後呼叫：只重新拉資料 + 重繪，不重綁工具列事件。
 * 避免 _bindSidebarEvents() 被執行兩次造成按鈕雙重觸發。
 */
export async function reloadWatchlist() {
  _groups = await getAllGroups();
  if (_groups.length === 0) {
    const def = _makeGroup('預設清單', 0);
    _groups = [def];
    await saveGroup(def);
  }
  await _ensureDefaultIndices();
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

// ─── 預設指數 ─────────────────────────────────────────────────────────────

const _DEFAULT_INDICES = [
  { code: '^TWII', name: '加權指數' },
  { code: '^DJI',  name: '道瓊指數' },
  { code: '^SOX',  name: '費城半導體' },
];

async function _ensureDefaultIndices() {
  // 找預設清單（第一個群組，或名稱含「預設」的群組）
  const defGroup = _groups.find(g => g.name.includes('預設')) ?? _groups[0];
  if (!defGroup) return;

  let changed = false;
  for (const idx of _DEFAULT_INDICES) {
    if (!defGroup.stocks.some(s => s.code === idx.code)) {
      defGroup.stocks.push({ code: idx.code, name: idx.name });
      changed = true;
    }
  }
  if (changed) await saveGroup(defGroup);
}

// ─── 渲染 ──────────────────────────────────────────────────────────────────

let _renderLocked = false;

export function renderWatchlist() {
  if (_renderLocked) return;  // 拖曳中不重繪
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  // ── 渲染前從 __priceCache 補最新報價,同步寫回 _groups ──
  // ⚠️ 判斷不能只看 s.price === p.price:
  //   價格可能不變但 chgPct 已更新(MIS 偶爾延遲回報);
  //   且初次載入 s.price 是 undefined,要寫回。
  const cache = window.__priceCache ?? {};
  console.log('[watchlist] renderWatchlist cache size:', Object.keys(cache).length, 'sample:', Object.entries(cache).slice(0,2).map(([k,v])=>k+'='+v.price));
  let _cacheUpdated = false;
  for (const g of _groups) {
    for (const s of g.stocks) {
      const p = cache[s.code];
      if (!p?.price) continue;
      // 任一欄位有變化或 s.price 還是 null 就更新
      if (s.price === p.price && s.chgPct === p.chgPct && s.price != null) continue;
      s.price  = p.price;
      s.chg    = p.chg  ?? (p.price - (p.prev ?? p.price));
      s.chgPct = p.chgPct ?? 0;
      _cacheUpdated = true;
    }
  }
  // 有更新就排程 5 秒後寫 DB(debounce,避免每次 render 都寫)
  if (_cacheUpdated) {
    _scheduleMisFlush();
  }

  // 確保依 order 排序後再渲染
  _groups.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  container.innerHTML = _groups.map(g => _renderGroup(g)).join('');
  _bindGroupEvents();
}

function _renderGroup(group) {
  const isCollapsed = _collapsed.has(group.id);
  const chevron = isCollapsed ? "▶" : "▼";
  const items = isCollapsed ? '' : group.stocks.map(s => _renderStock(s, group.id)).join('');

  return `
<div class="wl-group" data-group-id="${group.id}" draggable="false">
  <div class="wl-group-header" data-action="toggle-group" data-group-id="${group.id}">
    <span class="wl-group-drag-handle" data-action="drag-group" title="拖曳排序">⠿</span>
    
    <div class="wl-group-title-wrap">
      <span class="wl-chevron" aria-hidden="true">${chevron}</span>
      <span class="wl-group-name">${_esc(group.name)}</span>
      <span class="wl-group-count">${group.stocks.length}</span>
    </div>
    
    <div class="wl-group-actions">
      <button class="wl-icon-btn" 
              data-action="export-group" 
              data-group-id="${group.id}" 
              title="匯出 JSON">
        ↓
      </button>
      <button class="wl-icon-btn" 
              data-action="rename-group" 
              data-group-id="${group.id}" 
              title="重新命名">
        ✎
      </button>
      <button class="wl-icon-btn" 
              data-action="delete-group" 
              data-group-id="${group.id}" 
              title="刪除群組">
        ✕
      </button>
    </div>
  </div>

  <div class="wl-group-body ${isCollapsed ? 'collapsed' : ''}">
    ${items}
  </div>
</div>`;
}

function _renderStock(stock, groupId) {
  const displayName = getChineseName(stock.code) || stock.name;
  const chgClass = stock.chgPct >= 0 ? 'down' : 'up';
  const sign     = stock.chgPct >= 0 ? '+' : '';

  // 五燈獎
  const signals = AppState.signals?.[stock.code] ?? [];
  const lamps   = calcSignalLamps(signals, signals?._difPos !== false);
  const lampHtml = lamps !== 0 ? _renderLamps(lamps, signals) : '';

  // v2.8 妖股狀態小圓點（從 AppState.yaoguStatus 讀取，由 updateYaoguTracker 寫入）
  const yaoguStatus = AppState.yaoguStatus?.[stock.code] ?? null;
  const yaoguDot = yaoguStatus ? _renderYaoguDot(yaoguStatus) : '';

  return `
<div class="wl-item" data-code="${stock.code}" data-group-id="${groupId}"
     draggable="true" data-action="select-stock">
  <div class="wl-item-left">
    <span class="wl-code">${stock.code}</span>
    <span class="wl-name">${_esc(displayName)}</span>
    ${lampHtml}${yaoguDot}
  </div>
  <div class="wl-item-right">
    <span class="wl-price">${stock.price ?? '—'}</span>
    <span class="wl-chg ${chgClass}">${sign}${stock.chgPct?.toFixed(2) ?? '—'}%</span>
  </div>
  <button class="wl-remove-btn" data-action="remove-stock"
          data-code="${stock.code}" data-group-id="${groupId}" title="移除">
    ×
  </button>
</div>`;
}

/**
 * v2.8 妖股狀態小圓點（左側清單簡潔版）
 * @param {{ status, label, color, daysSince }} yaoguStatus
 */
function _renderYaoguDot(ys) {
  if (!ys) return '';
  // exit 狀態顯示但用灰色（已出場但保留記錄）
  const color = ys.status === 'exited' ? '#6b7280' : ys.color;
  const days  = ys.daysSince != null ? ` · 第${ys.daysSince}天` : '';
  const tip   = `${ys.label}${days}\n${ys.desc ?? ''}`;
  return `<span class="wl-yaogu-dot" style="background:${color}" title="${tip}"></span>`;
}

/**
 * 渲染五燈 HTML（v2.6 — 支援負數綠燈、金燈、死亡綠燈）
 * @param {number} lamps  -5 ~ 5，0.5 倍數,負數=綠燈,正數=紅燈
 * @param {Signal[]} signals  原始訊號(用於 tooltip)
 */
function _renderLamps(lamps, signals) {
  // 台股慣例：紅色 = 做多訊號（買進）；綠色 = 避險訊號（賣出/減碼）
  const abs = Math.abs(lamps);
  const isBull    = lamps > 0;
  const isBear    = lamps < 0;
  const isGolden  = isBull && abs >= 5.0;
  const isDanger  = isBear && abs >= 5.0;

  let colorCls;
  if      (isGolden) colorCls = 'lamps-golden';
  else if (isDanger) colorCls = 'lamps-danger';
  else if (isBull)   colorCls = 'lamps-pos';
  else               colorCls = 'lamps-neg';

  // tooltip 列出符合的策略名稱
  const sigList = Array.isArray(signals) ? signals : [];
  const tip  = sigList.map(s => s.name).join('、');

  // 半燈邏輯：abs = 2.5 → 第 1~2 燈全亮，第 3 燈半亮
  const fullLamps = Math.floor(abs);
  const hasHalf   = (abs % 1) === 0.5;

  const dots = Array.from({ length: 5 }, (_, i) => {
    if (i < fullLamps)              return `<span class="wl-lamp on"></span>`;
    if (i === fullLamps && hasHalf) return `<span class="wl-lamp half"></span>`;
    return `<span class="wl-lamp"></span>`;
  }).join('');

  return `<div class="wl-lamps ${colorCls}" title="${tip}">${dots}</div>`;
}

// ─── Sidebar 工具列事件（新增群組按鈕 + 匯入）────────────────────────────

// 持久的 file input，只建立一次，避免每次點擊都 createElement 造成多重 listener
let _importFileInput = null;

function _bindSidebarEvents() {
  // 防止 initWatchlist() 被多次呼叫（如 authReady 後）時重複綁定
  const toolbar = document.getElementById('watchlistToolbar')
    ?? document.querySelector('.watchlist-toolbar')
    ?? document.querySelector('.sidebar-toolbar');

  // 用各自按鈕的 dataset.bound 做防護，不依賴 toolbar 容器是否存在
  const addGroupBtn  = document.getElementById('watchlistAddGroup');
  const importBtn    = document.getElementById('watchlistImportBtn');

  if (addGroupBtn && !addGroupBtn.dataset.bound) {
    addGroupBtn.dataset.bound = '1';
    addGroupBtn.addEventListener('click', () => _promptCreateGroup());
  }

  if (importBtn && !importBtn.dataset.bound) {
    importBtn.dataset.bound = '1';
    importBtn.addEventListener('click', () => _triggerImport());
  }
}  // ← _bindSidebarEvents 結尾

// 匯入觸發：使用持久 input，只建立一次
function _triggerImport() {
  if (!_importFileInput) {
    _importFileInput = document.createElement('input');
    _importFileInput.type   = 'file';
    _importFileInput.accept = '.json';
    _importFileInput.style.display = 'none';
    document.body.appendChild(_importFileInput);
    _importFileInput.addEventListener('change', () => _handleImportFile(_importFileInput));
  }
  // 每次觸發前重設 value，確保選同一個檔案也能觸發 change 事件
  _importFileInput.value = '';
  _importFileInput.click();
}

// ─── 匯出單一群組 JSON ────────────────────────────────────────────────────

export function exportGroupJSON(groupId) {
  const g = _groups.find(g => g.id === groupId);
  if (!g) return;
  const json = JSON.stringify({ name: g.name, stocks: g.stocks }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `watchlist_${g.name}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 匯入 JSON → 建立新群組 ──────────────────────────────────────────────

async function _handleImportFile(input) {
  {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // 支援單一群組格式：{ name, stocks }
      // 或陣列格式：[{ name, stocks }, ...]
      const groups = Array.isArray(data) ? data : [data];

      for (const g of groups) {
        if (!Array.isArray(g.stocks)) continue;
        const name   = g.name ?? file.name.replace('.json', '');
        const stocks = g.stocks.filter(s => s?.code);
        const newGroup = _makeGroup(`${name}（匯入）`, _groups.length);
        newGroup.stocks = stocks;
        _groups.push(newGroup);
        await saveGroup(newGroup);
      }

      AppState.watchlistGroups = _groups;
      renderWatchlist();
      showToast(`✓ 匯入成功，已建立新群組`);
    } catch (err) {
      showToast('⚠ 匯入失敗：' + err.message);
    }
  }
}

// ─── 群組內事件委派 ────────────────────────────────────────────────────────

function _bindGroupEvents() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  // 永久委派，不用 once，renderWatchlist 不需要重綁
  // 用 flag 防止重複綁定
  if (container.dataset.bound === '1') {
    _bindDragDrop();
    _bindHandles();
    return;
  }
  container.dataset.bound = '1';
  container.addEventListener('click', _handleGroupClick);
  _bindDragDrop();
  _bindHandles();
}

function _handleGroupClick(e) {
  // 1. 尋找最近的 data-action 元素
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action  = btn.dataset.action;
  const groupId = btn.dataset.groupId;
  const code    = btn.dataset.code;

  /**
   * 【關鍵修正】
   * 如果動作是「重新命名」、「刪除群組」或「移除個股」，
   * 必須阻止事件冒泡，防止觸發父層 .wl-group-header 的 toggle-group。
   */
  if (action === 'rename-group' || action === 'delete-group' || action === 'remove-stock' || action === 'export-group') {
    e.stopPropagation();
  }

  switch (action) {
    case 'toggle-group':
      _toggleGroup(groupId); 
      break;
    case 'export-group':
      exportGroupJSON(groupId);
      break;
    case 'rename-group':
      _promptRenameGroup(groupId); 
      break;
    case 'delete-group':
      _confirmDeleteGroup(groupId); 
      break;
    case 'remove-stock':
      removeStockFromGroup(code, groupId); 
      break;
    case 'select-stock':
      // 發送自訂事件給 main.js 處理圖表載入
      document.dispatchEvent(new CustomEvent('stockSelect', { detail: { code } })); 
      break;
  }
}

// ─── 群組操作 ──────────────────────────────────────────────────────────────

function _toggleGroup(id) {
  _collapsed.has(id) ? _collapsed.delete(id) : _collapsed.add(id);
  renderWatchlist();
}

export async function createGroup(name) {
  const g = _makeGroup(name, _groups.length);
  _groups.push(g);
  await saveGroup(g);
  renderWatchlist();
  return g.id;
}

async function _confirmDeleteGroup(id) {
  const g = _groups.find(g => g.id === id);
  if (!g) return;
  if (g.id === 'default' && _groups.length === 1) {
    showToast('至少保留一個清單'); return;
  }
  if (!confirm(`刪除「${g.name}」？群組內個股將一併移除。`)) return;
  await deleteGroup(id);
}

export async function deleteGroup(id) {
  _groups = _groups.filter(g => g.id !== id);
  await dbDeleteGroup(id);
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

async function _promptCreateGroup() {
  const name = prompt('新群組名稱：');
  if (!name?.trim()) return;
  await createGroup(name.trim());
}

async function _promptRenameGroup(id) {
  const g = _groups.find(g => g.id === id);
  if (!g) return;
  const name = prompt('重新命名：', g.name);
  if (!name?.trim() || name.trim() === g.name) return;
  g.name = name.trim();
  await saveGroup(g);
  renderWatchlist();
}

// ─── 個股操作 ──────────────────────────────────────────────────────────────

export async function addStockToGroup(stock, groupId) {
  const g = _groups.find(g => g.id === groupId);
  if (!g) return;

  // 同一群組不重複
  if (g.stocks.some(s => s.code === stock.code)) {
    showToast(`${stock.code} 已在「${g.name}」`);
    return;
  }

  // 補中文名（Yahoo Finance 回傳英文時用 TWSE cache 覆蓋）
  const chName = getChineseName(stock.code);
  if (chName) stock = { ...stock, name: chName };

  g.stocks.push(stock);
  await saveGroup(g);
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

export async function removeStockFromGroup(code, groupId) {
  const g = _groups.find(g => g.id === groupId);
  if (!g) return;
  g.stocks = g.stocks.filter(s => s.code !== code);
  await saveGroup(g);
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

export async function updateStockPrices(priceMap) {



  let dirty = false;
  for (const g of _groups) {
    for (const s of g.stocks) {
      const p = priceMap[s.code];
      if (!p) continue;


      s.price  = p.price;
      s.chg    = p.chg;
      s.chgPct = p.chgPct;
      dirty = true;
    }
  }
  if (dirty) {
    for (const g of _groups) await saveGroup(g);
    renderWatchlist();
  }
}

/**
 * updateStockPricesFromMis(misMap)
 * 盤中輪詢專用：更新記憶體 + 重繪 UI，並啟動 debounced DB flush。
 *
 * ⚠️ 踩雷備忘（永久，2026-05-21）：
 *   舊版完全不寫 IndexedDB，導致 MIS 個股輪詢(mis-poll)、啟動補刷(mis-patch)、
 *   Firestore realtime 拿到的最新報價全部只活在記憶體，F5 重整就回到上次盤後價。
 *   只有「自選輪詢最後一輪」會手動 await updateStockPrices 補寫，
 *   但只 cover 自選清單，個股 mis-poll 仍然不寫。
 *
 *   新邏輯：每次 push 都重置 5 秒 debounce timer，
 *   5 秒內沒新報價就把 _groups 整批寫進 IndexedDB，F5 後拿得到最新價。
 *   debounce 避免盤中每 15 秒 saveGroup 把 IndexedDB 操爆。
 *
 *   ⚠️ 不可移除：自選輪詢的 await updateStockPrices 還是要保留，
 *   它是「整輪結束強制 flush」的保險(避免 debounce 還沒到就關頁)。
 *
 * @param {Object} misMap  { [code]: { price, prev, chgPct, volume, name } }
 */
export function updateStockPricesFromMis(misMap) {
  let dirty = false;
  const hits = [], misses = [];
  // 一次性 debug：看 _groups 和 misMap 的 key 格式
  const groupCodes = _groups.flatMap(g => g.stocks.map(s => s.code));
  const mapKeys = Object.keys(misMap);
  console.log('[watchlist] _groups codes sample:', groupCodes.slice(0,5));
  console.log('[watchlist] misMap keys sample:', mapKeys.slice(0,5));
  for (const g of _groups) {
    for (const s of g.stocks) {
      const p = misMap[s.code];
      if (!p) { misses.push(s.code); continue; }
      s.price  = p.price;
      s.chgPct = p.chgPct;
      s.chg    = p.price - p.prev;
      dirty    = true;
      hits.push(`${s.code}=${p.price}`);
    }
  }
  console.log(`[watchlist] updateStockPricesFromMis hits=${hits.length} miss=${misses.length}`, hits.slice(0,5), misses.slice(0,5));
  if (dirty) {
    renderWatchlist();
    _scheduleMisFlush();  // ⚠️ 5 秒後寫 DB(debounce)
  }
}

export function getDefaultGroupId() {
  return _groups[0]?.id ?? 'default';
}

export function getGroups() { return _groups; }

// ─── 拖曳排序（個股跨群組移動）───────────────────────────────────────────

// ─── 拖曳排序（個股跨群組移動）───────────────────────────────────────────

function _bindDragDrop() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  if (container.dataset.dragBound === '1') return;
  container.dataset.dragBound = '1';

  let dragCode    = null;
  let dragGroupId = null;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.wl-item');
    if (!item) return;
    
    dragCode    = item.dataset.code;
    dragGroupId = item.dataset.groupId;
    
    e.dataTransfer.effectAllowed = 'copyMove';
    item.classList.add('dragging');
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest('.wl-item');
    if (item) item.classList.remove('dragging');
    dragCode = dragGroupId = null;
    // 確保結束時清除所有高亮
    container.querySelectorAll('.wl-group').forEach(el => el.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    // 【修正】只在拖曳個股時才處理高亮邏輯
    if (!dragCode) return;

    const groupEl = e.target.closest('.wl-group');
    
    // 優化高亮邏輯：避免頻繁操作 DOM
    const currentOver = container.querySelector('.wl-group.drag-over');
    if (currentOver !== groupEl) {
      if (currentOver) currentOver.classList.remove('drag-over');
      if (groupEl) groupEl.classList.add('drag-over');
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    
    // 【修正】確保清除樣式
    container.querySelectorAll('.wl-group').forEach(el => el.classList.remove('drag-over'));

    const targetGroup = e.target.closest('.wl-group');
    if (!targetGroup || !dragCode) return;

    const toGroupId = targetGroup.dataset.groupId;
    if (toGroupId === dragGroupId) return;

    const fromGroup = _groups.find(g => g.id === dragGroupId);
    const toGroup   = _groups.find(g => g.id === toGroupId);
    
    if (!fromGroup || !toGroup) return;

    const stock = fromGroup.stocks.find(s => s.code === dragCode);
    if (!stock) return;

    if (!toGroup.stocks.some(s => s.code === stock.code)) {
      toGroup.stocks.push({ ...stock });
      
      // 更新資料
      await saveGroup(toGroup);
      AppState.watchlistGroups = _groups;

      // 【修正點開功能】
      // 拖曳成功後，如果目標群組本來是摺疊的，自動幫它打開
      if (_collapsed.has(toGroupId)) {
        _collapsed.delete(toGroupId);
      }
      
      // 最後才執行重繪
      renderWatchlist();
      showToast(`${stock.code} 已複製到「${toGroup.name}」`);
    } else {
      showToast(`${stock.code} 已在「${toGroup.name}」`);
    }

    dragCode = dragGroupId = null;
  });
}

// ─── 群組拖曳排序 ────────────────────────────────────────────────────────────

let _draggingGroupEl = null;

async function _saveGroupOrder() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;
  const groupEls = [...container.querySelectorAll('.wl-group')];
  for (let i = 0; i < groupEls.length; i++) {
    const id = groupEls[i].dataset.groupId;
    const g  = _groups.find(g => g.id === id);
    if (g) g.order = i;
  }
  await Promise.all(_groups.map(g => saveGroup(g)));
  AppState.watchlistGroups = _groups;
}

function _bindGroupDragSort() {
  // 不用 event delegation，改在 renderWatchlist 後直接對每個 handle 綁事件
}

function _bindHandles() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  container.querySelectorAll('[data-action="drag-group"]').forEach(handle => {
    if (handle.dataset.handleBound) return;
    handle.dataset.handleBound = '1';

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const groupEl = handle.closest('.wl-group');
      if (!groupEl) return;

      _draggingGroupEl = groupEl;
      _renderLocked    = true;  // 拖曳期間鎖住，禁止 renderWatchlist
      groupEl.classList.add('dragging-group');

      const onMove = (ev) => {
        if (!_draggingGroupEl) return;

        _draggingGroupEl.style.pointerEvents = 'none';
        const elBelow = document.elementFromPoint(ev.clientX, ev.clientY);
        _draggingGroupEl.style.pointerEvents = '';

        const overGroup = elBelow?.closest('.wl-group');
        if (!overGroup || overGroup === _draggingGroupEl) return;

        const rect = overGroup.getBoundingClientRect();
        const mid  = rect.top + rect.height / 2;
        if (ev.clientY < mid) {
          container.insertBefore(_draggingGroupEl, overGroup);
        } else {
          container.insertBefore(_draggingGroupEl, overGroup.nextSibling);
        }
      };

      const onUp = async () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        if (_draggingGroupEl) {
          _draggingGroupEl.classList.remove('dragging-group');
          _draggingGroupEl = null;
          await _saveGroupOrder();
          _renderLocked = false;  // 解鎖
          renderWatchlist();
        } else {
          _renderLocked = false;
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ─── 工具 ──────────────────────────────────────────────────────────────────

function _makeGroup(name, order) {
  return { id: _uuid(), name, order, stocks: [] };
}

function _uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function _esc(str) {
  return str?.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) ?? '';
}
