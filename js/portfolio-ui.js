/**
 * portfolio-ui.js — 庫存 Tab UI (多清單版)
 */

import {
  loadLists, listAll, getList,
  createList, renameList, deleteList,
  ensureDefaultList, dedupEmptyLists,
  holdingAddTx, holdingUpdateTx, holdingRemoveTx, holdingRemoveCode,
  watchAddCode, watchUpdate, watchRemoveCode,
  calcHoldingItem, calcHoldingPL, calcListTotals, calcWatchDistance,
} from './portfolio.js';
import { getChineseName, ensureChineseName, fetchHistoryCached, toYahooSymbol, resolveYahooSymbol, fetchFundamentalsBatch } from './api.js';
import { getAllGroups, loadHealthCacheBatch, saveHealthCache, deletePortfolioList } from './db.js';
import { calcHealth, calcHealthLong, renderHealthBadge, shortHealthScore } from './health.js';
import { openStockPreview } from './stock-preview.js';

// 自製 prompt — 取代瀏覽器原生 prompt(避免醜陋的瀏覽器彈窗)
function pfPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const modal = document.getElementById('pfPromptModal');
    if (!modal) { resolve(prompt(message, defaultValue)); return; }   // fallback
    document.getElementById('pfPromptMessage').textContent = message;
    const input = document.getElementById('pfPromptInput');
    input.value = defaultValue;
    modal.classList.add('open');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const close = (val) => {
      modal.classList.remove('open');
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      btnClose.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBg);
      resolve(val);
    };
    const btnOk = document.getElementById('pfPromptConfirm');
    const btnCancel = document.getElementById('pfPromptCancel');
    const btnClose = document.getElementById('pfPromptClose');
    const onOk     = () => close(input.value.trim() || null);
    const onCancel = () => close(null);
    const onKey    = (e) => {
      if (e.key === 'Enter')  onOk();
      if (e.key === 'Escape') onCancel();
    };
    const onBg = (e) => { if (e.target === modal) onCancel(); };
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBg);
  });
}

// ─── 自訂確認泡泡（取代原生 confirm()） ──────────────────────────────────────
function _pfConfirm(title, body, okLabel = '刪除') {
  return new Promise(resolve => {
    // 樣式注入（只注一次，沿用 wl-confirm 設計語言）
    if (!document.getElementById('pf-confirm-style')) {
      const s = document.createElement('style');
      s.id = 'pf-confirm-style';
      s.textContent = `
        .pf-confirm-overlay {
          display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,.65); z-index: 99999;
          align-items: center; justify-content: center; padding: 24px;
        }
        .pf-confirm-overlay.open { display: flex; }
        .pf-confirm-modal {
          background: #252830;
          border-radius: 16px;
          border: 0.5px solid rgba(255,255,255,.12);
          padding: 24px 20px 20px;
          width: 100%; max-width: 320px;
          animation: pf-confirm-in .18s ease;
          box-shadow: 0 16px 48px rgba(0,0,0,.7);
        }
        @keyframes pf-confirm-in {
          from { opacity:0; transform: scale(.94); }
          to   { opacity:1; transform: scale(1); }
        }
        .pf-confirm-title {
          font-size: 16px; font-weight: 500; color: #e8e8ea;
          margin: 0 0 8px; line-height: 1.4;
        }
        .pf-confirm-body {
          font-size: 13px; color: #9aa0a6;
          margin: 0 0 22px; line-height: 1.5;
        }
        .pf-confirm-btns { display: flex; gap: 10px; }
        .pf-confirm-cancel, .pf-confirm-ok {
          flex: 1; min-height: 48px; border-radius: 10px;
          border: none; font-size: 15px; font-weight: 500;
          cursor: pointer; transition: background .15s;
          -webkit-tap-highlight-color: transparent;
        }
        .pf-confirm-cancel {
          background: rgba(255,255,255,.08); color: #cdd0d4;
          border: 0.5px solid rgba(255,255,255,.1);
        }
        .pf-confirm-cancel:hover  { background: rgba(255,255,255,.13); }
        .pf-confirm-cancel:active { background: rgba(255,255,255,.06); }
        .pf-confirm-ok { background: #ef5350; color: #fff; }
        .pf-confirm-ok:hover  { background: #e53935; }
        .pf-confirm-ok:active { background: #c62828; }
      `;
      document.head.appendChild(s);
    }

    // 建立或重用 overlay
    let overlay = document.getElementById('pf-confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pf-confirm-overlay';
      overlay.className = 'pf-confirm-overlay';
      overlay.innerHTML = `
        <div class="pf-confirm-modal" role="dialog" aria-modal="true">
          <p class="pf-confirm-title"></p>
          <p class="pf-confirm-body"></p>
          <div class="pf-confirm-btns">
            <button class="pf-confirm-cancel">取消</button>
            <button class="pf-confirm-ok"></button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }

    overlay.querySelector('.pf-confirm-title').textContent = title;
    overlay.querySelector('.pf-confirm-body').textContent  = body;
    overlay.querySelector('.pf-confirm-ok').textContent    = okLabel;

    const close = (result) => {
      overlay.classList.remove('open');
      overlay.querySelector('.pf-confirm-ok').removeEventListener('click', onOk);
      overlay.querySelector('.pf-confirm-cancel').removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBg);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk     = () => close(true);
    const onCancel = () => close(false);
    const onBg     = (e) => { if (e.target === overlay) close(false); };
    const onKey    = (e) => { if (e.key === 'Escape') close(false); };

    overlay.querySelector('.pf-confirm-ok').addEventListener('click', onOk);
    overlay.querySelector('.pf-confirm-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('click', onBg);
    document.addEventListener('keydown', onKey);
    overlay.classList.add('open');
  });
}

let _initialized = false;
let _activeKind   = 'holding';
let _activeListId = null;
let _healthCache  = {};
let _healthLongCache = {};  // 長線健康度快取
let _fundCache    = {};     // Phase 2: fundamentals 快取(從 Firestore 讀)
let _priceCache   = {};

// ─── 限流保護：debounce guard + proxy 退避 ────────────────────────────────
// ⚠️ 踩雷備忘（永久）：
//   _refreshHealthInBackground 有 7 個觸發點（切 tab、切清單、新增/刪除股票等），
//   同時觸發時 proxy 會被 429 限流全批死。
//   修法：
//   1. _healthRefreshTimer — 300ms debounce，多個觸發合併成一次
//   2. _healthRunning — 執行中 flag，同一時間只跑一個批次
//   3. _proxyBackoff — proxy 被 429 時，記錄退避到期時間，未到期的 fetch 直接 skip
//   4. _fetchBatch concurrency=3 — 同時最多 3 個 fetchHistoryCached 並行
const CONCURRENCY = 1;           // 串列逐檔，避免 proxy 429（盤中 Yahoo 封鎖期間）
const PROXY_BACKOFF_MS = 30000;  // proxy 被 429 後退避 30 秒
let _healthRefreshTimer = null;
let _healthRunning = false;
let _proxyBackoffUntil = 0;      // epoch ms，未到期不打

// ─── 健康度快取有效性判斷 ────────────────────────────────────────────────────
// 盤中（台灣時間 週一到週五 09:00–13:35）
function _isTradingNow() {
  const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const day  = tw.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 13 * 60 + 35;
}
// 取今天交易日的日期字串（台灣時間 YYYY-MM-DD）
function _twDateStr() {
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return tw.toISOString().slice(0, 10);
}
/**
 * 判斷健康度快取是否仍有效，不需重打 API
 * @param {{ healthSavedAt, healthSource }} cache
 * @returns {boolean}
 */
function _isHealthCacheValid(cache) {
  if (!cache || cache.healthShort == null) return false;
  const savedAt = cache.healthSavedAt;
  // 跨交易日 → 無效
  const savedDate = new Date(savedAt + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (savedDate !== _twDateStr()) return false;
  // 同一交易日（不管盤中/盤後）→ 直接用
  // ⚠️ 踩雷備忘（永久，2026-05-26）：
  //   舊版盤中快取設 5 分鐘有效期，Shift+F5 重載後距今超過 5 分鐘 → 快取失效
  //   → 打 API → Worker 502 → 健康度消失。
  //   盤中健康度重算應由 K 線更新事件驅動（force=true），不靠快取過期。
  //   同日快取一律有效，force 重整時才強制重打。
  return true;
}

// ── 搜尋 / 分頁 / 排序狀態 ────────────────────────
const PAGE_SIZE   = 10;
let _searchQuery  = '';
let _currentPage  = 1;       // 1-based
let _sortKey      = null;    // 'name'|'code'|'price'|'healthShort'|'healthLong'|'pl'|'dist'
let _sortAsc      = true;

/**
 * 取得當下「鎖定的參考價」— 加入追蹤瞬間呼叫
 * 優先序: __priceCache (批次/即時) → _priceCache (已抓過的K線) → 現抓K線
 * 拓不到 → 回傳 0
 */
async function _lockRefPrice(code) {
  // 1. priceCache (盤中=即時、盤後=當日收盤)
  const px1 = window.__priceCache?.[code]?.price;
  if (px1 > 0) return px1;
  // 2. K線快取最後一根
  const px2 = _priceCache[code];
  if (px2 > 0) return px2;
  // 3. 現抓 K 線(已有 IndexedDB 24h 快取,失敗回 0)
  try {
    const symbol = toYahooSymbol(code);
    const candles = await fetchHistoryCached(symbol, '1mo');
    const last = candles?.[candles.length - 1]?.close;
    if (last > 0) {
      _priceCache[code] = last;
      return last;
    }
  } catch (_) {}
  return 0;
}

function _priceOf(code) {
  return window.__priceCache?.[code]?.price ?? _priceCache[code] ?? null;
}

/** 確保至少有一個 holding 和一個 watch 清單（在 sync 之後才呼叫）*/
async function _ensureDefaultLists() {
  // 用固定 id（holding_default / watch_default），存在則不重建 → 根治繁殖
  await ensureDefaultList('holding');
  await ensureDefaultList('watch');
}


export async function initPortfolio() {
  if (_initialized) return;
  _initialized = true;

  // skipDefaults=true：等 syncCloudToLocal 完成後才補建預設清單，
  // 避免空殼預設清單被 syncLocalToCloud 上傳覆蓋雲端資料
  await loadLists({ skipDefaults: true });
  // sync 後先清理重複空清單（含同步刪雲端），再補預設清單
  try {
    const removed = await dedupEmptyLists();
    for (const id of removed) deletePortfolioList(id).catch(() => {});  // 同步刪雲端
  } catch (e) { console.warn('[portfolio] dedup 失敗:', e.message); }
  await _ensureDefaultLists();
  _autoSelectFirstList();
  _bindKindTabs();
  _bindToolbar();
  _bindListSelector();
  render();

  // ── 暴露橋接 API 供 market.js 追蹤功能使用 ──
  window.__portfolioAPI = {
    getWatchLists: () => listAll('watch'),
    isInWatch: (code) => listAll('watch').some(l => l.items?.some(it => it.code === code)),
    reload: async () => {
      await loadLists({ skipDefaults: true });
      // sync 後重新 dedup（清掉雲端拉回的重複空清單，含同步刪雲端）
      try {
        const removed = await dedupEmptyLists();
        for (const id of removed) deletePortfolioList(id).catch(() => {});
      } catch (e) { console.warn('[portfolio] reload dedup 失敗:', e.message); }
      await _ensureDefaultLists();
      render();
    },
  };

  document.querySelector('.main-tab[data-tab="portfolio"]')?.addEventListener('click', () => {
    render();
    _refreshHealthInBackground();
  });

  // ── 背景一次性修補:把 item.name === item.code 的壞資料補成中文 ─────────
  // 問題:早期批次匯入 watchlist 時,nameCache 還沒 preload 完成,
  //       getChineseName(code) 回 null → 把 code 當 name 寫進 IndexedDB,
  //       壞資料永久卡住(item.name = "3646" 而非「華新」)。
  // 解法:啟動 5 秒後(等 preloadNamesFromFirestore 完成)掃 watch 清單,
  //       凡是 item.name === item.code 就嘗試 ensureChineseName 補正。
  //       只跑一次,只處理 watch(holding 沒提供改 name 的 API)。
  // ⚠️ 不要太早跑:nameCache 還沒 preload 完跑也是白跑。
  setTimeout(_repairWatchNames, 5000);

  // ── 訂閱 PriceHub 廣播:有新報價就重畫表格 ──────────────────────────────
  // 問題:portfolio-ui 原本沒訂閱,MIS 即時報價只更新 window.__priceCache,
  //       表格不會自動重畫,要等使用者切 tab 才看得到新價。
  // 解法:用 rAF throttle 防止一個 cycle 內多次 dispatch 都觸發 render;
  //       任一 modal 開啟時跳過(避免使用者編輯到一半畫面跳動)。
  // ⚠️ 踩雷備忘:這個訂閱「絕對不能拿掉」,否則追蹤頁/持股頁報價會凍住。
  let _renderPending = false;
  document.addEventListener('pricesUpdated', () => {
    if (_renderPending) return;
    // modal 開啟時跳過,等下次 pricesUpdated 再嘗試
    const anyModalOpen = document.querySelector(
      '#pfModal.open, #pfWatchModal.open, #pfLoadModal.open'
    );
    if (anyModalOpen) return;
    _renderPending = true;
    requestAnimationFrame(() => {
      _renderPending = false;
      // 只在 portfolio tab 是 active 時才重畫(節省效能)
      const portfolioTabActive = document.querySelector('.main-tab[data-tab="portfolio"]')?.classList.contains('active');
      if (portfolioTabActive) render();
    });
  });
}

function _autoSelectFirstList() {
  const lists = listAll(_activeKind);
  _activeListId = lists[0]?.id ?? null;
}

// ── 背景一次性修補 watch 清單的壞 name(item.name === item.code 的壞資料)──
// 跑時機:initPortfolio 後延遲 5 秒,等 nameCache 預載完
// 範圍:只處理 watch 清單(holding 沒提供改 name 的 API)
// 安全性:逐筆檢查、ensureChineseName 失敗就跳過、修完才呼叫 watchUpdate
async function _repairWatchNames() {
  try {
    const watchLists = listAll('watch');
    if (!watchLists.length) return;

    let fixedCount = 0;
    for (const list of watchLists) {
      for (const item of (list.items ?? [])) {
        if (!item.name || item.name !== item.code) continue;  // 名稱正常,跳過
        try {
          const realName = await ensureChineseName(item.code);
          if (!realName || realName === item.code) continue;  // 還是沒拿到,跳過
          await watchUpdate(list.id, item.code, { name: realName });
          fixedCount++;
        } catch (e) {
          // 單筆失敗不影響其他,靜默
        }
      }
    }

    if (fixedCount > 0) {
      console.log(`[portfolio] 修補 ${fixedCount} 筆 watch 清單股名`);
      // 修完重畫一次(只在 portfolio tab active 時)
      const portfolioTabActive = document.querySelector('.main-tab[data-tab="portfolio"]')?.classList.contains('active');
      if (portfolioTabActive) render();
    }
  } catch (e) {
    console.warn('[portfolio] _repairWatchNames 失敗:', e?.message);
  }
}

function _bindKindTabs() {
  document.querySelectorAll('.pf-kind-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      if (kind === _activeKind) return;
      _activeKind = kind;
      document.querySelectorAll('.pf-kind-tab').forEach(b => b.classList.toggle('active', b === btn));
      _autoSelectFirstList();
      render();
      _refreshHealthInBackground();
    });
  });
}

function _bindToolbar() {
  document.getElementById('pfRefreshBtn')?.addEventListener('click', () => {
    render();
    _refreshHealthInBackground(true);
  });

  // 搜尋 Bar
  document.getElementById('pfSearchInput')?.addEventListener('input', (e) => {
    _searchQuery  = e.target.value.trim().toLowerCase();
    _currentPage  = 1;
    render();
  });
  document.getElementById('pfAddBtn')?.addEventListener('click', () => {
    if (_activeKind === 'holding') _openHoldingModal(null);
    else _openWatchModal(null);
  });
  document.getElementById('pfLoadFromWatchlistBtn')?.addEventListener('click', _openLoadWatchlistModal);
}

function _bindListSelector() {
  document.getElementById('pfListSelect')?.addEventListener('change', (e) => {
    _activeListId = e.target.value;
    render();
    _refreshHealthInBackground();
  });

  document.getElementById('pfListAddBtn')?.addEventListener('click', async () => {
    const name = await pfPrompt(`新增「${_activeKind === 'holding' ? '持股' : '追蹤'}」清單,輸入名稱:`);
    if (!name) return;
    const list = await createList(_activeKind, name.trim());
    _activeListId = list.id;
    _renderListSelector();
    render();
  });

  document.getElementById('pfListRenameBtn')?.addEventListener('click', async () => {
    if (!_activeListId) return;
    const cur = getList(_activeListId);
    const name = await pfPrompt('輸入新名稱:', cur?.name);
    if (!name || name === cur.name) return;
    await renameList(_activeListId, name.trim());
    _renderListSelector();
  });

  document.getElementById('pfListDeleteBtn')?.addEventListener('click', async () => {
    if (!_activeListId) return;
    const cur = getList(_activeListId);
    const lists = listAll(_activeKind);
    if (lists.length <= 1) {
      alert('至少要保留一個清單,無法刪除');
      return;
    }
    if (!await _pfConfirm('刪除清單', `確定刪除清單「${cur.name}」？裡面所有資料會一起刪除`, '刪除')) return;
    await deleteList(_activeListId);
    _autoSelectFirstList();
    _renderListSelector();
    render();
  });

  // 匯出追蹤清單 JSON
  document.getElementById('pfListExportBtn')?.addEventListener('click', () => {
    if (!_activeListId) return;
    const list = getList(_activeListId);
    if (!list || list.kind !== 'watch') return;

    const payload = {
      name:      list.name,
      kind:      'watch',
      exportAt:  new Date().toISOString(),
      items:     list.items.map(it => ({
        code:     it.code,
        name:     it.name,
        refPrice: it.refPrice ?? 0,
        note:     it.note ?? '',
      })),
    };

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.href     = url;
    a.download = `watch_${_esc(list.name)}_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    document.dispatchEvent(new CustomEvent('showToast', {
      detail: `✓ 已匯出「${list.name}」${list.items.length} 檔`
    }));
  });
}

function _renderListSelector() {
  const sel = document.getElementById('pfListSelect');
  if (!sel) return;
  const lists = listAll(_activeKind);
  sel.innerHTML = lists.map(l => {
    // 持股:只算實際有股數的;追蹤:全部都算
    let count = l.items.length;
    if (l.kind === 'holding') {
      count = l.items.filter(it => {
        const { shares } = calcHoldingItem(it);
        return shares > 0;
      }).length;
      // 待編輯佔位也顯示一下
      const placeholder = l.items.length - count;
      if (placeholder > 0) {
        return `<option value="${l.id}" ${l.id === _activeListId ? 'selected' : ''}>${_esc(l.name)} (${count}+${placeholder})</option>`;
      }
    }
    return `<option value="${l.id}" ${l.id === _activeListId ? 'selected' : ''}>${_esc(l.name)} (${count})</option>`;
  }).join('');
}

export function render() {
  _renderListSelector();
  _renderToolbar();
  if (_activeKind === 'holding') _renderHoldingTable();
  else _renderWatchTable();
}

function _renderToolbar() {
  const addBtn = document.getElementById('pfAddBtn');
  if (addBtn) addBtn.textContent = _activeKind === 'holding' ? '＋ 新增持股' : '＋ 新增追蹤';
  const loadBtn = document.getElementById('pfLoadFromWatchlistBtn');
  if (loadBtn) loadBtn.style.display = _activeKind === 'watch' ? '' : 'none';
  const exportBtn = document.getElementById('pfListExportBtn');
  if (exportBtn) exportBtn.style.display = _activeKind === 'watch' ? '' : 'none';
}

function _renderHoldingTable() {
  const list = getList(_activeListId);
  const thead = document.getElementById('pfThead');
  const tbody = document.getElementById('pfTbody');
  const totalsEl = document.getElementById('pfTotals');
  if (!tbody) return;

  // ── 排序 th 產生器
  const th = (key, label) => {
    const active = _sortKey === key;
    const arrow  = active ? (_sortAsc ? ' ↑' : ' ↓') : '';
    return `<th class="pf-th-sort${active ? ' active' : ''}" data-sort="${key}">${label}${arrow}</th>`;
  };

  if (thead) thead.innerHTML = `<tr>
    ${th('name','股名')}${th('code','代號')}${th('price','現價')}
    ${th('healthShort','健康度')}
    ${th('shares','股數')}${th('avgCost','均價')}${th('pl','損益')}<th></th>
  </tr>`;

  // 綁定 th 排序點擊
  thead?.querySelectorAll('.pf-th-sort').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.sort;
      if (_sortKey === k) _sortAsc = !_sortAsc;
      else { _sortKey = k; _sortAsc = true; }
      _currentPage = 1;
      render();
    });
  });

  if (!list || !list.items.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="pf-empty">尚無持股 — 點右上「＋ 新增持股」或「批次新增」</td></tr>`;
    if (totalsEl) totalsEl.innerHTML = '';
    _renderPagination(0);
    return;
  }

  // ── 搜尋過濾
  let items = list.items.filter(item => {
    if (!_searchQuery) return true;
    const validStoredName = item.name && item.name !== item.code;
    const name = (validStoredName ? item.name : (getChineseName(item.code) || item.code)).toLowerCase();
    return name.includes(_searchQuery) || item.code.includes(_searchQuery);
  });

  // ── 排序
  if (_sortKey) {
    items = [...items].sort((a, b) => {
      let av, bv;
      if (_sortKey === 'name') {
        const na = (a.name && a.name !== a.code) ? a.name : (getChineseName(a.code) || a.code);
        const nb = (b.name && b.name !== b.code) ? b.name : (getChineseName(b.code) || b.code);
        av = na; bv = nb;
        return _sortAsc ? av.localeCompare(bv,'zh-TW') : bv.localeCompare(av,'zh-TW');
      }
      if (_sortKey === 'code')        { av = a.code; bv = b.code; }
      else if (_sortKey === 'price')  { av = _priceOf(a.code) ?? -Infinity; bv = _priceOf(b.code) ?? -Infinity; }
      else if (_sortKey === 'healthShort') { av = _healthCache[a.code] ?? -1; bv = _healthCache[b.code] ?? -1; }
      else if (_sortKey === 'shares') { av = calcHoldingItem(a).shares; bv = calcHoldingItem(b).shares; }
      else if (_sortKey === 'avgCost'){ av = calcHoldingItem(a).avgCost; bv = calcHoldingItem(b).avgCost; }
      else if (_sortKey === 'pl')     {
        av = calcHoldingPL(a, _priceOf(a.code)).pl;
        bv = calcHoldingPL(b, _priceOf(b.code)).pl;
      }
      else { av = 0; bv = 0; }
      return _sortAsc ? av - bv : bv - av;
    });
  }

  // ── 分頁
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (_currentPage > totalPages) _currentPage = totalPages;
  const pageItems = items.slice((_currentPage - 1) * PAGE_SIZE, _currentPage * PAGE_SIZE);

  tbody.innerHTML = pageItems.map(item => {
    const { shares, avgCost } = calcHoldingItem(item);
    const price = _priceOf(item.code);
    const { pl, plPct } = calcHoldingPL(item, price);
    const health     = _healthCache[item.code];
    const healthLong = _healthLongCache[item.code];
    const plCls = pl > 0 ? 'up' : pl < 0 ? 'down' : '';
    const validStoredName = item.name && item.name !== item.code;
    const name = validStoredName ? item.name : (getChineseName(item.code) || item.code);
    return `
      <tr class="pf-row" data-code="${item.code}">
        <td class="pf-name">${_esc(name)}</td>
        <td class="pf-code">${item.code}</td>
        <td class="pf-price">${price != null ? price.toFixed(2) : '—'}</td>
        <td class="pf-health">${renderHealthBadge(health, healthLong)}</td>
        <td class="pf-shares">${shares.toLocaleString()}</td>
        <td class="pf-avg">${avgCost > 0 ? avgCost.toFixed(2) : '—'}</td>
        <td class="pf-pl ${plCls}">
          ${pl !== 0 ? `${pl >= 0 ? '+' : ''}${Math.round(pl).toLocaleString()}` : '—'}
          ${pl !== 0 ? `<div class="pf-pl-pct">${pl >= 0 ? '+' : ''}${plPct.toFixed(2)}%</div>` : ''}
        </td>
        <td class="pf-actions"><button class="pf-icon-btn pf-view-btn" title="跳轉看盤">📊</button></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.pf-row').forEach(tr => {
    const code = tr.dataset.code;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.pf-view-btn')) {
        openStockPreview(code);   // 📊 → 個股速覽 modal（CTA 才進個股頁）
        return;
      }
      _openHoldingModal(code);
    });
  });

  _renderPagination(total);

  if (totalsEl) {
    const t = calcListTotals(list, _priceOf);
    const plCls = t.totalPL > 0 ? 'up' : t.totalPL < 0 ? 'down' : '';
    totalsEl.innerHTML = `
      <div class="pf-total-cell">
        <div class="pf-total-label">總成本</div>
        <div class="pf-total-value">${Math.round(t.totalCost).toLocaleString()}</div>
      </div>
      <div class="pf-total-cell">
        <div class="pf-total-label">總市值</div>
        <div class="pf-total-value">${Math.round(t.totalMarketValue).toLocaleString()}</div>
      </div>
      <div class="pf-total-cell pf-total-pl ${plCls}">
        <div class="pf-total-label">全部損益</div>
        <div class="pf-total-value">${t.totalPL >= 0 ? '+' : ''}${Math.round(t.totalPL).toLocaleString()}</div>
        <div class="pf-total-pct">${t.totalPL >= 0 ? '+' : ''}${t.totalPLPct.toFixed(2)}%</div>
      </div>`;
  }
}

function _renderWatchTable() {
  const list = getList(_activeListId);
  const thead = document.getElementById('pfThead');
  const tbody = document.getElementById('pfTbody');
  const totalsEl = document.getElementById('pfTotals');
  if (totalsEl) totalsEl.innerHTML = '';
  if (!tbody) return;

  // ── 排序 th 產生器
  const th = (key, label) => {
    const active = _sortKey === key;
    const arrow  = active ? (_sortAsc ? ' ↑' : ' ↓') : '';
    return `<th class="pf-th-sort${active ? ' active' : ''}" data-sort="${key}">${label}${arrow}</th>`;
  };

  if (thead) thead.innerHTML = `<tr>
    ${th('name','股名')}${th('code','代號')}${th('price','現價')}
    ${th('healthShort','健康度')}
    ${th('refPrice','參考價')}${th('dist','距離')}<th>備註</th><th></th>
  </tr>`;

  thead?.querySelectorAll('.pf-th-sort').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.sort;
      if (_sortKey === k) _sortAsc = !_sortAsc;
      else { _sortKey = k; _sortAsc = true; }
      _currentPage = 1;
      render();
    });
  });

  if (!list || !list.items.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="pf-empty">尚無追蹤 — 點「＋ 新增追蹤」、「批次新增」或「📥 載入自選」</td></tr>`;
    _renderPagination(0);
    return;
  }

  // ── 搜尋過濾
  let items = list.items.filter(item => {
    if (!_searchQuery) return true;
    const validStoredName = item.name && item.name !== item.code;
    const name = (validStoredName ? item.name : (getChineseName(item.code) || item.code)).toLowerCase();
    return name.includes(_searchQuery) || item.code.includes(_searchQuery);
  });

  // ── 排序
  if (_sortKey) {
    items = [...items].sort((a, b) => {
      let av, bv;
      if (_sortKey === 'name') {
        const na = (a.name && a.name !== a.code) ? a.name : (getChineseName(a.code) || a.code);
        const nb = (b.name && b.name !== b.code) ? b.name : (getChineseName(b.code) || b.code);
        return _sortAsc ? na.localeCompare(nb,'zh-TW') : nb.localeCompare(na,'zh-TW');
      }
      if      (_sortKey === 'code')        { av = a.code; bv = b.code; return _sortAsc ? av.localeCompare(bv) : bv.localeCompare(av); }
      else if (_sortKey === 'price')       { av = _priceOf(a.code) ?? -Infinity; bv = _priceOf(b.code) ?? -Infinity; }
      else if (_sortKey === 'healthShort') { av = _healthCache[a.code] ?? -1;    bv = _healthCache[b.code] ?? -1; }
      else if (_sortKey === 'refPrice')    { av = a.refPrice ?? 0;                bv = b.refPrice ?? 0; }
      else if (_sortKey === 'dist')        {
        av = calcWatchDistance(a, _priceOf(a.code)).distPct ?? -Infinity;
        bv = calcWatchDistance(b, _priceOf(b.code)).distPct ?? -Infinity;
      }
      else { av = 0; bv = 0; }
      return _sortAsc ? av - bv : bv - av;
    });
  }

  // ── 分頁
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (_currentPage > totalPages) _currentPage = totalPages;
  const pageItems = items.slice((_currentPage - 1) * PAGE_SIZE, _currentPage * PAGE_SIZE);

  tbody.innerHTML = pageItems.map(item => {
    const price = _priceOf(item.code);
    const { distPct } = calcWatchDistance(item, price);
    const health     = _healthCache[item.code];
    const healthLong = _healthLongCache[item.code];
    const validStoredName = item.name && item.name !== item.code;
    const name = validStoredName ? item.name : (getChineseName(item.code) || item.code);
    const distCls = distPct > 0 ? 'up' : distPct < 0 ? 'down' : '';
    return `
      <tr class="pf-row" data-code="${item.code}">
        <td class="pf-name">${_esc(name)}</td>
        <td class="pf-code">${item.code}</td>
        <td class="pf-price">${price != null ? price.toFixed(2) : '—'}</td>
        <td class="pf-health">${renderHealthBadge(health, healthLong)}</td>
        <td class="pf-avg">${item.refPrice > 0 ? item.refPrice.toFixed(2) : '—'}</td>
        <td class="pf-pl ${distCls}">
          ${(price != null && item.refPrice > 0) ? `${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%` : '—'}
        </td>
        <td class="pf-note">${_esc(item.note ?? '')}</td>
        <td class="pf-actions"><button class="pf-icon-btn pf-view-btn" title="跳轉看盤">📊</button></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.pf-row').forEach(tr => {
    const code = tr.dataset.code;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.pf-view-btn')) {
        openStockPreview(code);   // 📊 → 個股速覽 modal（CTA 才進個股頁）
        return;
      }
      _openWatchModal(code);
    });
  });

  _renderPagination(total);
}


// ── 分頁列渲染 ─────────────────────────────────────────
function _renderPagination(total) {
  const el = document.getElementById('pfPagination');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const start = (_currentPage - 1) * PAGE_SIZE + 1;
  const end   = Math.min(_currentPage * PAGE_SIZE, total);

  let html = `<span class="pf-page-info">${start}–${end} / ${total} 筆</span>`;
  html += `<button class="pf-page-btn" data-page="1" ${_currentPage===1?'disabled':''}>«</button>`;
  html += `<button class="pf-page-btn" data-page="${_currentPage-1}" ${_currentPage===1?'disabled':''}>‹</button>`;

  // 最多顯示 5 頁按鈕
  let lo = Math.max(1, _currentPage - 2);
  let hi = Math.min(totalPages, lo + 4);
  lo = Math.max(1, hi - 4);
  for (let p = lo; p <= hi; p++) {
    html += `<button class="pf-page-btn${p===_currentPage?' active':''}" data-page="${p}">${p}</button>`;
  }

  html += `<button class="pf-page-btn" data-page="${_currentPage+1}" ${_currentPage===totalPages?'disabled':''}>›</button>`;
  html += `<button class="pf-page-btn" data-page="${totalPages}" ${_currentPage===totalPages?'disabled':''}>»</button>`;
  el.innerHTML = html;

  el.querySelectorAll('.pf-page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentPage = parseInt(btn.dataset.page);
      render();
    });
  });
}

function _refreshHealthInBackground(force = false) {
  // ── debounce：300ms 內多次呼叫合併成一次 ──
  if (_healthRefreshTimer) clearTimeout(_healthRefreshTimer);
  _healthRefreshTimer = setTimeout(() => _doRefreshHealth(force), 300);
}

async function _doRefreshHealth(force = false) {
  // ── 執行中 flag：同時只跑一個批次 ──
  if (_healthRunning) {
    console.log('[portfolio] health refresh 已在執行中，跳過重複觸發');
    return;
  }
  _healthRunning = true;
  try {
    const list = getList(_activeListId);
    if (!list) return;

    const allItems = list.items;
    if (!allItems.length) return;

    // ── Step 1：批次讀 IndexedDB 健康度快取 ──
    // 有效快取直接填入記憶體，不打 API
    if (!force) {
      const codes = allItems.map(it => it.code);
      try {
        const cached = await loadHealthCacheBatch(codes);
        let hitCount = 0;
        for (const [code, c] of cached) {
          // lastPrice：不管健康度是否有效，只要有存過就填入（避免顯示 —）
          if (c.lastPrice != null && _priceCache[code] == null) {
            _priceCache[code] = c.lastPrice;
          }
          if (_isHealthCacheValid(c)) {
            _healthCache[code]     = c.healthShort;
            _healthLongCache[code] = c.healthLong;
            hitCount++;
          }
        }
        if (hitCount > 0) {
          console.log(`[portfolio] health DB 快取命中 ${hitCount}/${codes.length} 檔，直接渲染`);
          render();
        }
      } catch (e) {
        console.warn('[portfolio] loadHealthCacheBatch failed:', e.message);
      }
    }

    // ── Step 2：過濾真正需要打 API 的檔 ──
    const needFetch = allItems.filter(it =>
      force ||
      _healthCache[it.code] == null ||
      (it.refPrice === 0 && list.kind === 'watch')
    );
    if (!needFetch.length) {
      console.log('[portfolio] 所有健康度來自快取，跳過 API');
      return;
    }

    console.log(`[portfolio] 需要 API 取健康度：${needFetch.length} 檔`);

    // ── proxy 退避檢查 ──
    const now = Date.now();
    if (!force && _proxyBackoffUntil > now) {
      const secLeft = Math.ceil((_proxyBackoffUntil - now) / 1000);
      console.log(`[portfolio] proxy 退避中，剩 ${secLeft}s，跳過此輪`);
      return;
    }

    // 第一輪
    const failed = await _fetchBatch(needFetch);

    // 第二輪：失敗的 retry（等 3 秒喘息，但仍受退避保護）
    if (failed.length) {
      console.log(`[portfolio] 第一輪失敗 ${failed.length} 檔，3 秒後 retry`);
      await new Promise(r => setTimeout(r, 3000));
      if (_proxyBackoffUntil > Date.now()) {
        console.warn(`[portfolio] proxy 退避中，放棄 retry ${failed.length} 檔`);
        return;
      }
      const stillFailed = await _fetchBatch(failed);
      if (stillFailed.length) {
        console.warn(`[portfolio] 第二輪仍失敗 ${stillFailed.length} 檔:`, stillFailed.map(i => i.code).join(','));
      }
    }
  } finally {
    _healthRunning = false;
  }
}

// 跑一批 fetchHistoryCached，concurrency=3，回傳失敗的 items
async function _fetchBatch(items) {
  const failed = [];

  // ⚠️ Phase 2:批次預載 fund(從 Firestore,純讀,失敗回 null,不阻塞)
  const codesToLoad = items.filter(it => _fundCache[it.code] === undefined).map(it => it.code);
  if (codesToLoad.length > 0) {
    try {
      const fundMap = await fetchFundamentalsBatch(codesToLoad);
      for (const code of codesToLoad) {
        _fundCache[code] = fundMap.get(code) ?? null;
      }
    } catch (_) {
      for (const code of codesToLoad) {
        if (_fundCache[code] === undefined) _fundCache[code] = null;
      }
    }
  }

  // ── concurrency=3 並發佇列 ──
  // 同時最多 CONCURRENCY 個 fetch，每個完成後才啟動下一個
  const queue = [...items];
  let idx = 0;

  const _fetchOne = async (item) => {
    try {
      // ★ 改用 resolveYahooSymbol：自動試 .TW/.TWO，上櫃股不會送錯 suffix
      const { candles } = await resolveYahooSymbol(item.code, '1y');
      if (candles?.length) {
        const last = candles[candles.length - 1];
        if (last?.close) _priceCache[item.code] = last.close;
        if (candles.length >= 20) {
          const fund = _fundCache[item.code] ?? null;
          let candlesShort = candles.length > 65 ? candles.slice(-65) : candles;

          // ── 接入今日即時報價（盤中健康度即時化）──────────────────────────
          const livePrice  = window.__priceCache?.[item.code]?.price;
          const livePrev   = window.__priceCache?.[item.code]?.prev;
          const liveVolume = window.__priceCache?.[item.code]?.volume ?? 0;
          if (livePrice && livePrev && candlesShort.length > 0) {
            const todayStr = _twDateStr();
            const lastC    = candlesShort[candlesShort.length - 1];
            const lastDate = typeof lastC.time === 'string'
              ? lastC.time.slice(0, 10)
              : new Date((lastC.time > 1e10 ? lastC.time : lastC.time * 1000)).toISOString().slice(0, 10);
            if (lastDate < todayStr) {
              // 最後一根是昨收，接一根今日模擬K
              candlesShort = [...candlesShort, {
                time:   Math.floor(Date.now() / 1000),
                open:   livePrev,
                high:   Math.max(livePrev, livePrice),
                low:    Math.min(livePrev, livePrice),
                close:  livePrice,
                volume: liveVolume,
              }];
            } else {
              // 最後一根就是今日，更新收盤
              candlesShort = [...candlesShort.slice(0, -1), {
                ...lastC,
                close:  livePrice,
                high:   Math.max(lastC.high ?? livePrice, livePrice),
                low:    Math.min(lastC.low  ?? livePrice, livePrice),
                volume: Math.max(lastC.volume ?? 0, liveVolume),
              }];
            }
          }
          const hShort = shortHealthScore({ code: item.code, candles: candlesShort });
          const hLong  = calcHealthLong(candles, fund, item.code);
          _healthCache[item.code]     = hShort;
          _healthLongCache[item.code] = hLong;
          // ── 存回 IndexedDB + Firestore（fire-and-forget）──
          const source = _isTradingNow() ? 'intraday' : 'afterhours';
          const px = _priceCache[item.code] ?? window.__priceCache?.[item.code]?.price ?? null;
          saveHealthCache(item.code, hShort, hLong, source, px).catch(e =>
            console.warn(`[portfolio] saveHealthCache ${item.code} failed:`, e.message)
          );
        }
        render();
      } else {
        failed.push(item);
      }
    } catch (err) {
      // ── proxy 429 偵測：設退避 ──
      const msg = err?.message ?? '';
      if (msg.includes('429') || msg.includes('Too Many') || msg.includes('限流')) {
        _proxyBackoffUntil = Date.now() + PROXY_BACKOFF_MS;
        console.warn(`[portfolio] proxy 429 偵測，退避 ${PROXY_BACKOFF_MS/1000}s`);
      }
      failed.push(item);
    }
  };

  // 每批 CONCURRENCY 個並發，批次間間隔 400ms 避免 proxy 壓力
  while (idx < queue.length) {
    // 退避中提早結束
    if (_proxyBackoffUntil > Date.now()) {
      failed.push(...queue.slice(idx));
      console.warn(`[portfolio] proxy 退避中，跳過剩餘 ${queue.length - idx} 檔`);
      break;
    }
    const batch = queue.slice(idx, idx + CONCURRENCY);
    idx += CONCURRENCY;
    await Promise.all(batch.map(_fetchOne));
    if (idx < queue.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  return failed;
}

// ════════════════════════════════════════════════════════
// 持股 Modal
// ════════════════════════════════════════════════════════
function _openHoldingModal(code) {
  const isNew = !code;
  const list = getList(_activeListId);
  if (!list) return;
  const item = code ? list.items.find(it => it.code === code) : null;
  const modal = document.getElementById('pfModal');
  if (!modal) return;
  modal.dataset.code = code ?? '';
  modal.classList.add('open');
  document.getElementById('pfModalTitle').textContent = isNew ? '新增持股' : `編輯持股 — ${item.name || code}`;
  document.getElementById('pfModalCode').value = code ?? '';
  document.getElementById('pfModalCode').readOnly = !isNew;
  document.getElementById('pfModalName').value = item?.name || '';
  if (isNew) {
    document.getElementById('pfModalTxList').innerHTML = '<div class="pf-mod-hint">先填代號後按「新增交易」</div>';
    document.getElementById('pfModalSummary').innerHTML = '';
  } else {
    _renderTxList(item);
    _renderHoldingSummary(item);
  }
}

function _closeModal() { document.getElementById('pfModal')?.classList.remove('open'); }

function _renderTxList(item) {
  const txList = document.getElementById('pfModalTxList');
  if (!item || !item.transactions?.length) {
    txList.innerHTML = '<div class="pf-mod-hint">尚無交易紀錄</div>';
    return;
  }
  txList.innerHTML = item.transactions.map(t => `
    <div class="pf-tx-row" data-tx-id="${t.id}">
      <select class="pf-tx-type">
        <option value="buy"  ${t.type==='buy'?'selected':''}>買進</option>
        <option value="sell" ${t.type==='sell'?'selected':''}>賣出</option>
      </select>
      <input type="date" class="pf-tx-date" value="${t.date}" />
      <input type="number" class="pf-tx-shares" value="${t.shares}" min="0" placeholder="股數" />
      <input type="number" class="pf-tx-price"  value="${t.price}"  min="0" step="0.01" placeholder="價格" />
      <input type="text"   class="pf-tx-note"   value="${_esc(t.note ?? '')}" placeholder="備註" />
      <button class="pf-tx-del" title="刪除這筆">✕</button>
    </div>`).join('');

  txList.querySelectorAll('.pf-tx-row').forEach(row => {
    const txId = row.dataset.txId;
    row.querySelectorAll('select, input').forEach(el => {
      el.addEventListener('change', async () => {
        const code = document.getElementById('pfModal').dataset.code;
        await holdingUpdateTx(_activeListId, code, txId, {
          type:   row.querySelector('.pf-tx-type').value,
          date:   row.querySelector('.pf-tx-date').value,
          shares: row.querySelector('.pf-tx-shares').value,
          price:  row.querySelector('.pf-tx-price').value,
          note:   row.querySelector('.pf-tx-note').value,
        });
        const it = getList(_activeListId)?.items.find(i => i.code === code);
        _renderHoldingSummary(it);
        render();
      });
    });
    row.querySelector('.pf-tx-del').addEventListener('click', async () => {
      if (!await _pfConfirm('刪除交易', '確定刪除這筆交易？', '刪除')) return;
      const code = document.getElementById('pfModal').dataset.code;
      await holdingRemoveTx(_activeListId, code, txId);
      const it = getList(_activeListId)?.items.find(i => i.code === code);
      if (!it) { _closeModal(); render(); return; }
      _renderTxList(it);
      _renderHoldingSummary(it);
      render();
    });
  });
}

function _renderHoldingSummary(item) {
  const el = document.getElementById('pfModalSummary');
  if (!item) { el.innerHTML = ''; return; }
  const { shares, avgCost, totalCost } = calcHoldingItem(item);
  const price = _priceOf(item.code);
  const { pl, plPct } = calcHoldingPL(item, price);
  const plCls = pl > 0 ? 'up' : pl < 0 ? 'down' : '';
  el.innerHTML = `
    <div class="pf-sum-grid">
      <div><span>持有股數</span><b>${shares.toLocaleString()}</b></div>
      <div><span>均價</span><b>${avgCost > 0 ? avgCost.toFixed(2) : '—'}</b></div>
      <div><span>總成本</span><b>${Math.round(totalCost).toLocaleString()}</b></div>
      <div><span>現價</span><b>${price != null ? price.toFixed(2) : '—'}</b></div>
      <div class="${plCls}"><span>損益</span><b>${pl !== 0 ? (pl>=0?'+':'') + Math.round(pl).toLocaleString() : '—'}</b></div>
      <div class="${plCls}"><span>損益%</span><b>${pl !== 0 ? (pl>=0?'+':'') + plPct.toFixed(2) + '%' : '—'}</b></div>
    </div>`;
}

// ════════════════════════════════════════════════════════
// 追蹤 Modal
// ════════════════════════════════════════════════════════
function _openWatchModal(code, opts = {}) {
  const isNew    = !code;
  const isEdit   = !isNew;
  const initTab  = opts.tab || 'single';
  const list = getList(_activeListId);
  if (!list) return;
  const item = code ? list.items.find(it => it.code === code) : null;
  const modal = document.getElementById('pfWatchModal');
  if (!modal) return;
  modal.dataset.code = code ?? '';
  modal.classList.add('open');

  // 標題
  document.getElementById('pfWatchModalTitle').textContent = isNew
    ? (_activeKind === 'holding' ? '新增持股' : '新增追蹤')
    : `編輯追蹤 — ${item?.name || code}`;

  // 單筆欄位
  document.getElementById('pfWatchCode').value     = code ?? '';
  document.getElementById('pfWatchCode').readOnly  = isEdit;
  document.getElementById('pfWatchName').value     = item?.name || '';
  document.getElementById('pfWatchRefPrice').value = item?.refPrice || '';
  document.getElementById('pfWatchNote').value     = item?.note || '';

  // 移除按鈕：只有編輯模式才顯示
  const removeBtn = document.getElementById('pfWatchRemove');
  if (removeBtn) removeBtn.style.display = isEdit ? '' : 'none';

  // 編輯模式：隱藏 Tab Bar，只顯示單筆欄位
  const tabsEl = document.getElementById('pfWatchTabs');
  if (tabsEl) tabsEl.style.display = isEdit ? 'none' : '';

  // 切換到指定 Tab（新增時）
  if (isNew) _switchPfTab(initTab);
  else _switchPfTab('single');

  // 批次面板清空
  const batchTa = document.getElementById('pfBatchInput');
  if (batchTa) batchTa.value = '';
  const batchPv = document.getElementById('pfBatchPreview');
  if (batchPv) batchPv.innerHTML = '';
}

// Tab 切換
function _switchPfTab(tab) {
  // Tab 按鈕 active 狀態
  document.querySelectorAll('#pfWatchTabs .pf-modal-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.pfTab === tab);
  });
  // Panel 顯示
  document.getElementById('pfTabSingle').style.display   = tab === 'single'   ? '' : 'none';
  document.getElementById('pfTabBatch').style.display    = tab === 'batch'    ? '' : 'none';
  document.getElementById('pfTabStrategy').style.display = tab === 'strategy' ? '' : 'none';
  // Footer 按鈕顯示
  document.getElementById('pfWatchSave').style.display    = tab === 'single' ? '' : 'none';
  document.getElementById('pfBatchConfirm').style.display = tab === 'batch'  ? '' : 'none';
  // 策略選股自己有按鈕，footer 不顯示確認鈕

  // 策略 Tab 第一次切入時懶載入
  if (tab === 'strategy') {
    import('./modal-strategy.js').then(m => m.renderStrategyGrid?.());
  }
}

function _closeWatchModal() { document.getElementById('pfWatchModal')?.classList.remove('open'); }

// ════════════════════════════════════════════════════════
// 批次新增代號 Modal
// ════════════════════════════════════════════════════════
// 批次新增已整合到 pfWatchModal 的 batch Tab
function _openBatchModal() {
  _openWatchModal(null, { tab: 'batch' });
  setTimeout(() => document.getElementById('pfBatchInput')?.focus(), 50);
}

function _closeBatchModal() { _closeWatchModal(); }

function _parseBatchCodes(text) {
  // 先把「名稱（代號）」或「名稱(代號)」格式提取代號
  // 例：神準（3558）、虹揚-KY（6573）→ 3558、6573
  const preprocessed = String(text || '').replace(
    /[\u4e00-\u9fa5\w\-\.]+[（(](\d{4,6}[A-Z]?)[）)]/gi,
    (_, code) => code
  );
  const raw = preprocessed.split(/[\s,;、\n]+/).filter(Boolean);
  const valid = [], invalid = [];
  for (const t of raw) {
    // 純代號格式：4-6碼數字 + 可選英文字母
    if (/^\d{4,6}[A-Z]?$/i.test(t)) valid.push(t.toUpperCase());
    else invalid.push(t);
  }
  const unique = [...new Set(valid)];
  return { codes: unique, invalid, duplicateRemoved: valid.length - unique.length };
}

function _renderBatchPreview(text) {
  const pv = document.getElementById('pfBatchPreview');
  if (!pv) return;
  if (!text.trim()) { pv.innerHTML = ''; return; }
  const { codes, invalid, duplicateRemoved } = _parseBatchCodes(text);
  const curList = getList(_activeListId);
  const existing = new Set((curList?.items ?? []).map(it => it.code));
  const newOnes = codes.filter(c => !existing.has(c));
  const skipped = codes.filter(c =>  existing.has(c));
  let html = `<div class="pf-batch-preview-stat">
    將新增 <b>${newOnes.length}</b> 檔
    ${skipped.length ? ` / 跳過 <b>${skipped.length}</b> 檔(已存在)` : ''}
    ${invalid.length ? ` / <b class="down">${invalid.length}</b> 個無效` : ''}
    ${duplicateRemoved > 0 ? ` / 去重 ${duplicateRemoved} 個` : ''}
  </div>`;
  if (newOnes.length) {
    html += `<div class="pf-batch-chips">${newOnes.map(c => {
      const name = getChineseName(c) || c;
      return `<span class="pf-batch-chip">${c} <em>${_esc(name)}</em></span>`;
    }).join('')}</div>`;
  }
  if (skipped.length) html += `<div class="pf-batch-skip">已存在(跳過): ${skipped.join('、')}</div>`;
  if (invalid.length) html += `<div class="pf-batch-errors"><b>無效輸入:</b> ${invalid.map(_esc).join('、')}</div>`;
  pv.innerHTML = html;
}

// ════════════════════════════════════════════════════════
// 載入自選 Modal
// ════════════════════════════════════════════════════════
async function _openLoadWatchlistModal() {
  if (_activeKind !== 'watch') return;
  const groups = await getAllGroups();
  if (!groups?.length) {
    alert('沒有自選群組可載入');
    return;
  }
  const modal = document.getElementById('pfLoadModal');
  if (!modal) return;
  modal.classList.add('open');
  const sel = document.getElementById('pfLoadGroupSelect');
  sel.innerHTML = groups.map(g => `<option value="${g.id}">${_esc(g.name)} (${g.stocks?.length ?? 0})</option>`).join('');
  _renderLoadPreview();
  sel.onchange = _renderLoadPreview;
}

async function _renderLoadPreview() {
  const groups = await getAllGroups();
  const id = document.getElementById('pfLoadGroupSelect')?.value;
  const g = groups.find(x => x.id === id);
  const pv = document.getElementById('pfLoadPreview');
  if (!g || !pv) return;
  const codes = (g.stocks ?? []).map(s => s.code);
  const curList = getList(_activeListId);
  const existing = new Set((curList?.items ?? []).map(it => it.code));
  const newOnes = codes.filter(c => !existing.has(c));
  pv.innerHTML = `<div class="pf-batch-preview-stat">
    將新增 <b>${newOnes.length}</b> 檔(共 ${codes.length} 檔,跳過 ${codes.length - newOnes.length} 檔已存在)
  </div>`;
}

function _closeLoadModal() { document.getElementById('pfLoadModal')?.classList.remove('open'); }

// ─── 全域事件綁定(只綁一次) ─────────────────────────
if (typeof document !== 'undefined' && !window.__pfBoundV2) {
  window.__pfBoundV2 = true;
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pfModalClose')?.addEventListener('click', _closeModal);
    document.getElementById('pfModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'pfModal') _closeModal();
    });
    document.getElementById('pfModalAddTx')?.addEventListener('click', async () => {
      const codeInput = document.getElementById('pfModalCode');
      const nameInput = document.getElementById('pfModalName');
      const code = codeInput.value.trim();
      if (!/^\d{4,6}[A-Z]?$/i.test(code)) { alert('請輸入正確的股票代號'); codeInput.focus(); return; }
      let name = nameInput.value.trim() || getChineseName(code);
      if (!name) { try { name = await ensureChineseName(code); } catch (_) {} }
      name = name || code;
      nameInput.value = name;
      const today = new Date().toISOString().slice(0, 10);
      await holdingAddTx(_activeListId, code, name, { type: 'buy', date: today, shares: 0, price: 0 });
      codeInput.readOnly = true;
      document.getElementById('pfModal').dataset.code = code;
      document.getElementById('pfModalTitle').textContent = `編輯持股 — ${name}`;
      const it = getList(_activeListId).items.find(i => i.code === code);
      _renderTxList(it);
      _renderHoldingSummary(it);
      render();
    });
    document.getElementById('pfModalRemove')?.addEventListener('click', async () => {
      const code = document.getElementById('pfModal').dataset.code;
      if (!code) return;
      if (!await _pfConfirm(`移除 ${code}`, '所有交易紀錄會一起刪除', '移除')) return;
      await holdingRemoveCode(_activeListId, code);
      _closeModal();
      render();
    });

    document.getElementById('pfWatchClose')?.addEventListener('click', _closeWatchModal);
    document.getElementById('pfWatchCancel')?.addEventListener('click', _closeWatchModal);

    // Tab 按鈕切換
    document.querySelectorAll('#pfWatchTabs .pf-modal-tab').forEach(btn => {
      btn.addEventListener('click', () => _switchPfTab(btn.dataset.pfTab));
    });

    // 初始化策略選股模組（注入 close/toast）
    import('./modal-strategy.js').then(m => {
      m.initStrategyModal?.(_closeWatchModal, (msg) => {
        const t = document.getElementById('toast');
        if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }
        else alert(msg);
      });
    });

    // 妖股加入請求（從 modal-strategy 的 EVA 警告觸發）
    document.addEventListener('msYaoguAddRequest', async (e) => {
      const stocks = e.detail?.stocks ?? [];
      const curList = getList(_activeListId);
      if (!curList) return;
      const existing = new Set((curList.items ?? []).map(it => it.code));
      let added = 0;
      for (const s of stocks) {
        if (existing.has(s.code)) continue;
        try {
          const refPx = await _lockRefPrice(s.code);
          await watchAddCode(_activeListId, s.code, s.name, refPx, `⚡ 妖股 ${s._sigs?.strongest ?? ''}`);
          added++;
        } catch (err) { console.warn('[portfolio] 妖股加入失敗', s.code, err); }
      }
      render();
      _refreshHealthInBackground();
      const t = document.getElementById('toast');
      if (t) { t.textContent = `⚡ 已加入 ${added} 檔妖股`; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
    });
    document.getElementById('pfWatchModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'pfWatchModal') _closeWatchModal();
    });
    document.getElementById('pfWatchSave')?.addEventListener('click', async () => {
      const codeEl = document.getElementById('pfWatchCode');
      const nameEl = document.getElementById('pfWatchName');
      const refEl  = document.getElementById('pfWatchRefPrice');
      const noteEl = document.getElementById('pfWatchNote');
      const code = codeEl.value.trim();
      if (!/^\d{4,6}[A-Z]?$/i.test(code)) { alert('請輸入正確的股票代號'); return; }
      let name = nameEl.value.trim() || getChineseName(code);
      if (!name) { try { name = await ensureChineseName(code); } catch (_) {} }
      name = name || code;
      const refPrice = Number(refEl.value) || 0;
      const note = noteEl.value.trim();
      const wasNew = !codeEl.readOnly;
      if (wasNew) {
        await watchAddCode(_activeListId, code, name, refPrice, note);
      } else {
        await watchUpdate(_activeListId, code, { name, refPrice, note });
      }
      _closeWatchModal();
      render();
      _refreshHealthInBackground();
    });
    document.getElementById('pfWatchRemove')?.addEventListener('click', async () => {
      const code = document.getElementById('pfWatchModal').dataset.code;
      if (!code) return;
      if (!await _pfConfirm(`移除 ${code}`, '確定從追蹤清單移除此股？', '移除')) return;
      await watchRemoveCode(_activeListId, code);
      _closeWatchModal();
      render();
    });

    // 批次：input 變更時即時預覽（保留）
    document.getElementById('pfBatchInput')?.addEventListener('input', (e) => {
      _renderBatchPreview(e.target.value);
    });
    document.getElementById('pfBatchConfirm')?.addEventListener('click', async () => {
      const text = document.getElementById('pfBatchInput')?.value || '';
      const { codes } = _parseBatchCodes(text);
      const curList = getList(_activeListId);
      const existing = new Set((curList?.items ?? []).map(it => it.code));
      const newOnes = codes.filter(c => !existing.has(c));
      if (!newOnes.length) { alert('沒有新代號可加入'); return; }
      const names = {};
      for (const code of newOnes) {
        names[code] = getChineseName(code);
        if (!names[code]) { try { names[code] = await ensureChineseName(code); } catch (_) {} }
        names[code] = names[code] || code;
      }
      let added = 0;
      for (const code of newOnes) {
        try {
          if (_activeKind === 'holding') {
            await holdingAddTx(_activeListId, code, names[code], {
              type: 'buy', date: new Date().toISOString().slice(0, 10),
              shares: 0, price: 0, note: '待編輯',
            });
          } else {
            // 追蹤:加入「瞬間」鎖定參考價(優先即時、否則 K線最後一根)
            const refPx = await _lockRefPrice(code);
            await watchAddCode(_activeListId, code, names[code], refPx, '');
          }
          added++;
        } catch (e) { console.warn('[portfolio] 新增失敗', code, e); }
      }
      _closeBatchModal();
      render();
      _refreshHealthInBackground();
      setTimeout(() => alert(`已新增 ${added} 檔`), 80);
    });

    document.getElementById('pfLoadClose')?.addEventListener('click', _closeLoadModal);
    document.getElementById('pfLoadCancel')?.addEventListener('click', _closeLoadModal);
    document.getElementById('pfLoadModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'pfLoadModal') _closeLoadModal();
    });
    document.getElementById('pfLoadConfirm')?.addEventListener('click', async () => {
      const id = document.getElementById('pfLoadGroupSelect')?.value;
      const groups = await getAllGroups();
      const g = groups.find(x => x.id === id);
      if (!g) return;
      const codes = (g.stocks ?? []).map(s => s.code);
      const curList = getList(_activeListId);
      const existing = new Set((curList?.items ?? []).map(it => it.code));
      let added = 0;
      for (const code of codes) {
        if (existing.has(code)) continue;
        // ⚠️ 踩雷:不能只用 getChineseName(同步,nameCache miss 時回 null)
        //         要用 ensureChineseName(async,會打 Firebase/TWSE 補)
        //         否則寫入 DB 的 name 又會 = code 造成壞資料
        let name = (await ensureChineseName(code)) || code;
        const refPx = await _lockRefPrice(code);
        await watchAddCode(_activeListId, code, name, refPx, '');
        added++;
      }
      _closeLoadModal();
      render();
      _refreshHealthInBackground();
      setTimeout(() => alert(`已從「${g.name}」載入 ${added} 檔`), 80);
    });
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

// ── 盤中健康度觸發入口（由 main.js MIS 更新後呼叫）────────────────────────
// 有 debounce 保護，多次呼叫只跑一次
export function refreshHealthFromPrice() {
  if (!_isTradingNow()) return;
  _refreshHealthInBackground(false);  // force=false：有快取且有效時跳過
}
