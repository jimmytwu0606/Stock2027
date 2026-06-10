/**
 * screener-result-store.js
 * 篩選結果命名儲存 / 載入（Phase 6 強化）
 *
 * 資料結構：
 *   {
 *     id:          string,       // 唯一 id
 *     name:        string,       // 使用者命名
 *     savedAt:     number,       // timestamp
 *     strategy:    string|null,  // 套用的策略名稱（無策略則 null）
 *     condLabels:  string[],     // 當時的條件標籤清單
 *     results:     ResultRow[],  // 完整結果（含指標數值）
 *   }
 *
 *   ResultRow：
 *   {
 *     code, name, price, chgPct, volume, indicators, matchedConds
 *   }
 *
 * 全部走 db.js getAllScreenerResults / saveScreenerResult / deleteScreenerResult
 * 若 db.js 尚未有這三個函式，則 fallback 到 IndexedDB 直接操作（向後相容）
 */

// ── db.js 介面（嘗試 import；若函式不存在則走內建 fallback）
import { getAllScreenerResults, saveScreenerResult, deleteScreenerResult } from './db.js';

const DB_NAME    = 'stockdash_results';
const DB_VERSION = 1;
const STORE_NAME = 'screenerResults';
const MAX_SAVED  = 30;

// ─────────────────────────────────────────────
// 低階 IndexedDB fallback（當 db.js 尚未支援時使用）
// ─────────────────────────────────────────────
let _fallbackDB = null;

async function _openFallbackDB() {
  if (_fallbackDB) return _fallbackDB;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _fallbackDB = e.target.result; resolve(_fallbackDB); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function _fbGetAll() {
  const db = await _openFallbackDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _fbPut(entry) {
  const db = await _openFallbackDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function _fbDelete(id) {
  const db = await _openFallbackDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ─────────────────────────────────────────────
// 公開 API
// ─────────────────────────────────────────────

/**
 * 讀取所有已儲存的篩選結果，按儲存時間降冪排列
 * @returns {Promise<Array>}
 */
export async function loadAllResults() {
  try {
    const rows = typeof getAllScreenerResults === 'function'
      ? await getAllScreenerResults()
      : await _fbGetAll();
    return rows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  } catch (e) {
    console.warn('[result-store] loadAllResults error:', e);
    return [];
  }
}

/**
 * 儲存一次篩選結果
 * @param {string}   name        使用者輸入的名稱
 * @param {Array}    results     runScreener 累積的 result payload 陣列
 * @param {object}   meta        { strategy, condLabels }
 * @returns {Promise<string>}   新 entry 的 id
 */
export async function saveResult(name, results, meta = {}) {
  const all = await loadAllResults();
  if (all.length >= MAX_SAVED) {
    throw new Error(`最多儲存 ${MAX_SAVED} 筆結果，請先刪除舊記錄`);
  }

  const entry = {
    id:         `result_${Date.now()}`,
    name:       name.trim() || `篩選結果 ${_formatDate(Date.now())}`,
    savedAt:    Date.now(),
    strategy:   meta.strategy   ?? null,
    strategyId: meta.strategyId ?? null,
    condLabels: meta.condLabels ?? [],
    results,
  };

  if (typeof saveScreenerResult === 'function') {
    await saveScreenerResult(entry);
  } else {
    await _fbPut(entry);
  }
  return entry.id;
}

/**
 * 刪除一筆儲存結果
 * @param {string} id
 */
export async function deleteResult(id) {
  if (typeof deleteScreenerResult === 'function') {
    await deleteScreenerResult(id);
  } else {
    await _fbDelete(id);
  }
}

// ─────────────────────────────────────────────
// 工具函式
// ─────────────────────────────────────────────
function _formatDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth()+1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
