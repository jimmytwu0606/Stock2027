/**
 * price-hub.js — 統一報價分配中心
 *
 * 所有報價來源（TWSE批次、MIS即時、Yahoo fetchQuote、Firestore）
 * 統一透過 PriceHub.push() 進來，Hub 負責：
 *   1. merge 寫入 window.__priceCache（保留最豐富欄位）
 *   2. 更新 watchlist 自選清單 UI
 *   3. 若是 activeCode，更新個股標頭
 *   4. 發出 CustomEvent('pricesUpdated') 供篩選器等訂閱
 *
 * 欄位優先級（越後來越新的 price/chgPct 覆蓋，但 open/high/low 只有 Yahoo 有）：
 *   Yahoo fetchQuote  → price, prev, open, high, low, volume, name, chg, chgPct
 *   MIS 即時          → price, prev, chgPct, volume, name, chg
 *   TWSE/TPEx 盤後    → price, prev, chgPct, volume, name, chg
 *   Firestore         → price, prev, chgPct, volume, name, chg
 *
 * ⚠️ 踩雷備忘：
 *   - MIS 不提供 open/high/low，merge 時不能清掉 Yahoo 填的欄位
 *   - 盤中 TWSE 批次跳過，此時 __priceCache 的上市股靠 MIS 填
 *   - updateStockPrices 會寫 IndexedDB（盤後用）；updateStockPricesFromMis 不寫（盤中輪詢用）
 *   - Firestore realtime 區（shared/market/realtime）是 GAS 每分鐘寫入，優先度最高
 *
 * export:
 *   PriceHub.push(map, opts)   → 統一入口
 *   PriceHub.get(code)         → 讀單筆快取
 *   PriceHub.snapshot()        → 讀整份快取（篩選器用）
 *   PriceHub.onUpdate(fn)      → 訂閱更新（fn 收到 map）
 *   PriceHub.offUpdate(fn)     → 取消訂閱
 */

import { AppState } from './state.js';

// ── 內部快取（即 window.__priceCache 的正式管理者）──────────────────────────
let _cache = {};

// ── 訂閱者清單 ───────────────────────────────────────────────────────────────
const _listeners = new Set();

// ── 更新個股標頭的函式（由 main.js 在初始化時注入，避免循環 import）────────
let _updateHeaderFn   = null;
let _updateWatchlistFn = null;
let _updateMisFn       = null;
let _getChineseNameFn  = null;  // api.js 的 getChineseName，由 main.js 注入

export function initPriceHub({ updateHeader, updateStockPrices, updateStockPricesFromMis, getChineseName }) {
  _updateHeaderFn    = updateHeader;
  _updateWatchlistFn = updateStockPrices;
  _updateMisFn       = updateStockPricesFromMis;
  _getChineseNameFn  = getChineseName ?? null;

  // 讓外部仍可透過 window.__priceCache 讀取（向後相容篩選器等直讀邏輯）
  window.__priceCache = _cache;

  // 掛上全域參照，讓 watchlist.js 等不直接 import 的模組也能呼叫
  window.__priceHub = { push, get, snapshot, onUpdate, offUpdate };
}

/**
 * 統一報價入口
 *
 * @param {Object} map   { [code]: { price, prev, chg?, chgPct?, volume?, name?,
 *                                   open?, high?, low? } }
 * @param {Object} opts
 *   @param {boolean} opts.persist   true = 寫 IndexedDB（盤後批次用）
 *                                   false = 只更新記憶體（盤中 MIS 輪詢用）
 *   @param {boolean} opts.updateHeader  true = 若 activeCode 在 map 裡，更新個股標頭
 *   @param {string}  opts.source    來源標記（debug 用，不影響邏輯）
 */
export function push(map, opts = {}) {
  const {
    persist       = false,
    updateHeader  = true,
    source        = 'unknown',
  } = opts;

  if (!map || !Object.keys(map).length) return;

  const activeCode = AppState.activeCode;
  const updated    = {};  // 本次實際有變化的 code

  for (const [code, incoming] of Object.entries(map)) {
    // ── 計算 chg / chgPct（若來源沒提供）────────────────────────────────────
    const price = incoming.price ?? incoming.close;
    if (price == null || isNaN(price)) continue;

    const prev   = incoming.prev ?? incoming.previousClose ?? price;
    const chg    = incoming.chg    ?? (price - prev);
    const chgPct = incoming.chgPct ?? (prev > 0 ? (chg / prev) * 100 : 0);

    // ── name 合併：中文名優先，不讓英文名蓋掉已有的中文名 ──────────────────
    const isChinese = (s) => s && /[\u4e00-\u9fa5]/.test(s);
    const cachedName = _cache[code]?.name;
    const incomingName = incoming.name;
    let mergedName;
    if (isChinese(incomingName)) {
      mergedName = incomingName;                    // 新的是中文 → 覆蓋
    } else if (isChinese(cachedName)) {
      mergedName = cachedName;                      // cache 是中文 → 保留
    } else {
      mergedName = incomingName || cachedName || code; // 都不是中文 → 用非空的
    }
    // 同步補查 _nameCache（api.js 的本地快取）
    if (!isChinese(mergedName)) {
      const apiName = window.__nameCache?.get?.(code);
      if (isChinese(apiName)) mergedName = apiName;
    }

    const next = {
      price,
      prev,
      chg,
      chgPct,
      volume:  incoming.volume  ?? _cache[code]?.volume  ?? 0,
      name:    mergedName,
      // open/high/low：MIS 盤中有，Yahoo fetchQuote 有，TWSE 批次/Firestore 無
      // ⚠️ 必須用 !== undefined（嚴格）：
      //    JS loose equality: undefined == null → true
      //    ?? 和 != null 都無法區分兩者，TWSE 批次的 undefined 會蓋掉 MIS 已填的值
      //    只有 !== undefined 才能正確判斷「來源有無帶此欄位」
      open:    incoming.open  !== undefined ? incoming.open  : (_cache[code]?.open  ?? null),
      high:    incoming.high  !== undefined ? incoming.high  : (_cache[code]?.high  ?? null),
      low:     incoming.low   !== undefined ? incoming.low   : (_cache[code]?.low   ?? null),
      // 記錄最後更新來源與時間（debug）
      _src:    source,
      _ts:     Date.now(),
    };

    _cache[code] = next;
    updated[code] = next;
  }

  if (!Object.keys(updated).length) return;

  // ── 確保 window.__priceCache 與內部 _cache 同一個物件參照 ────────────────
  window.__priceCache = _cache;

  // ── 1. 更新 watchlist UI ────────────────────────────────────────────────
  if (_updateMisFn && !persist) {
    _updateMisFn(updated);
  } else if (_updateWatchlistFn && persist) {
    _updateWatchlistFn(updated);   // 盤後批次：寫 DB
  }

  // ── 2. 更新個股標頭（只在 activeCode 有在本批更新時才觸發）──────────────
  if (updateHeader && _updateHeaderFn && activeCode && updated[activeCode]) {
    const d = updated[activeCode];
    // 補查中文名：api._nameCache → window.__nameCache → 已有的 name
    const isChinese = (s) => s && /[\u4e00-\u9fa5]/.test(s);
    const chName = (_getChineseNameFn?.(activeCode))
      || window.__nameCache?.get?.(activeCode)
      || (isChinese(d.name) ? d.name : null)
      || d.name;
    _updateHeaderFn(activeCode, {
      price:  d.price,
      prev:   d.prev,
      open:   d.open,
      high:   d.high,
      low:    d.low,
      volume: d.volume,
      name:   chName,
    });
  }

  // ── 3. 廣播給訂閱者（篩選器、市場總覽等）───────────────────────────────
  if (_listeners.size > 0) {
    for (const fn of _listeners) {
      try { fn(updated, _cache); } catch (_) {}
    }
  }

  // ── 4. CustomEvent（給沒有直接 import price-hub 的 legacy 模組）──────────
  document.dispatchEvent(new CustomEvent('pricesUpdated', {
    detail: { map: updated, cache: _cache, source, persist }
  }));
}

/**
 * 讀單筆快取
 * @param {string} code
 * @returns {{ price, prev, chg, chgPct, volume, name, open, high, low } | undefined}
 */
export function get(code) {
  return _cache[code];
}

/**
 * 讀整份快取（篩選器直讀用）
 * 回傳的是 _cache 的參照，不是複製，直讀即可
 * @returns {Object}
 */
export function snapshot() {
  return _cache;
}

/**
 * 訂閱更新
 * @param {Function} fn  (updatedMap, fullCache) => void
 */
export function onUpdate(fn) {
  _listeners.add(fn);
}

/**
 * 取消訂閱
 * @param {Function} fn
 */
export function offUpdate(fn) {
  _listeners.delete(fn);
}

/**
 * Firestore 即時報價訂閱管理
 *
 * 架構：GAS Cron 每分鐘寫 shared/market/realtime/prices（全市場快照）
 *       前端用 onSnapshot 監聽，有新資料就 push 進 Hub
 *
 * ⚠️ realtime 區只在盤中啟動，盤後改讀 shared/market/{date}/prices 靜態快照
 * ⚠️ onSnapshot 會持續消耗 Firestore reads，每次收到約 1 read
 *    → 盤中每分鐘 1 read；全天 ~270 reads；遠低於免費 50K/天額度
 *
 * @param {Function} fsOnSnapshot  firebase.js 提供的 onSnapshot 函式
 * @param {Function} fsDoc         firebase.js 提供的 doc 參照取得函式
 */
let _realtimeUnsub = null;

export function startFirestoreRealtime(fsOnSnapshot, fsDoc) {
  // 避免重複訂閱
  if (_realtimeUnsub) return;

  const _isTradingNow = () => {
    const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const day  = tw.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
    return mins >= 9 * 60 && mins <= 13 * 60 + 35;
  };

  // 非盤中不啟動（省 Firestore reads）
  if (!_isTradingNow()) {
    console.log('[price-hub] 非盤中，略過 Firestore realtime 訂閱');
    return;
  }

  try {
    const docRef = fsDoc('shared/market/realtime/prices');
    _realtimeUnsub = fsOnSnapshot(docRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (!data || typeof data !== 'object') return;

      // Firestore 格式：{ [code]: { price, prev, chgPct, volume, name } }
      push(data, {
        persist:      false,   // 即時資料不寫 DB
        updateHeader: true,
        source:       'firestore-realtime',
      });
      console.log(`[price-hub] Firestore realtime 更新 ${Object.keys(data).length} 檔`);
    }, (err) => {
      console.warn('[price-hub] Firestore realtime 訂閱失敗:', err.message);
      _realtimeUnsub = null;
    });
    console.log('[price-hub] Firestore realtime 訂閱啟動');
  } catch (e) {
    console.warn('[price-hub] startFirestoreRealtime 失敗:', e.message);
  }
}

/**
 * 停止 Firestore 即時訂閱（盤後收盤時呼叫）
 */
export function stopFirestoreRealtime() {
  if (_realtimeUnsub) {
    _realtimeUnsub();
    _realtimeUnsub = null;
    console.log('[price-hub] Firestore realtime 訂閱已停止');
  }
}
