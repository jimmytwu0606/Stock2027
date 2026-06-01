/**
 * db.js — IndexedDB + Firestore 雙軌持久化層
 *
 * 未登入：純 IndexedDB（行為與原版完全相同）
 * 已登入：IndexedDB 為主（即時），Firestore 非同步同步（雲端備份 + 跨裝置）
 *
 * 登入時自動執行 syncLocalToCloud()：把本地資料上傳合併至 Firestore
 * 切換裝置時執行 syncCloudToLocal()：把雲端資料拉回本地
 *
 * stores（ObjectStore）：
 *   watchlistGroups   — 自選清單群組 + 個股
 *   screenerSets      — 篩選條件組合
 *   screenerResults   — 篩選結果命名清單
 *   seedSets          — 種子股組合（Phase 4）
 *   config            — 單筆 key-value 設定
 */

import { currentUser, fsGet, fsSet, fsGetAll, fsDelete } from './firebase.js';

const DB_NAME    = 'stockdash';
// DB_VERSION 不再寫死：先偵測瀏覽器現有版本，確保永遠不會 VersionError
// 自動補建邏輯會在缺 store 時升版，所以這裡只需要「不降版」

let _db = null;

// 取得目前瀏覽器 IndexedDB 的版本（不存在則回傳 0）
async function _getCurrentVersion() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = (e) => {
      const ver = e.target.result.version;
      e.target.result.close();
      resolve(ver);
    };
    req.onerror = () => resolve(0);
  });
}

// ─── 初始化 ────────────────────────────────────────────────────────────────

export async function initDB() {
  if (_db) return _db;

  // 先讀現有版本，確保不會用比現有低的版本開啟
  const currentVer = await _getCurrentVersion();
  const DB_VERSION = Math.max(currentVer, 9);  // 至少 9，不降版

  _db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('watchlistGroups')) {
        const s = db.createObjectStore('watchlistGroups', { keyPath: 'id' });
        s.createIndex('order', 'order', { unique: false });
      }
      if (!db.objectStoreNames.contains('screenerSets')) {
        db.createObjectStore('screenerSets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('screenerResults')) {
        const s = db.createObjectStore('screenerResults', { keyPath: 'id' });
        s.createIndex('savedAt', 'savedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('seedSets')) {
        db.createObjectStore('seedSets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
      // ⭐ Phase 7: K 線標註(個股代碼為 keyPath)
      if (!db.objectStoreNames.contains('annotations')) {
        db.createObjectStore('annotations', { keyPath: 'code' });
      }
      // ⭐ Phase 7.4: K 線資料快取
      //   keyPath = `${symbol}_${period}` 例:'2330.TW_3mo'
      //   value = { key, symbol, period, candles, cachedAt, validUntil }
      if (!db.objectStoreNames.contains('kline_cache')) {
        const s = db.createObjectStore('kline_cache', { keyPath: 'key' });
        s.createIndex('cachedAt', 'cachedAt', { unique: false });
      }
      // ⭐ Phase 7.4: 訊號掃描結果持久化(Lazy 掃描)
      //   keyPath = code(個股代碼)
      //   value = { code, signals: [...], scannedAt }
      if (!db.objectStoreNames.contains('signals_cache')) {
        const s = db.createObjectStore('signals_cache', { keyPath: 'code' });
        // Advanced 2 — 個股補充資訊（Prompt 匯入）
        if (!db.objectStoreNames.contains('stockInfo')) {
          db.createObjectStore('stockInfo', { keyPath: 'code' });
        }

        if (!db.objectStoreNames.contains('portfolio')) {
          db.createObjectStore('portfolio', { keyPath: 'code' });
        }
        if (!db.objectStoreNames.contains('portfolio_lists')) {
          db.createObjectStore('portfolio_lists', { keyPath: 'id' });
        }
        s.createIndex('scannedAt', 'scannedAt', { unique: false });
      }
      // ⭐ 強勢族群追蹤 — 族群訂閱
      // keyPath = sectorKey (e.g. "up_散熱" / "down_航運")
      if (!db.objectStoreNames.contains("sector_subscriptions")) {
        db.createObjectStore("sector_subscriptions", { keyPath: "sectorKey" });
      }
      // ⭐ Phase 9: 使用者自訂題材
      // keyPath = id (nanoid 格式，e.g. 'theme_1234567890')
      if (!db.objectStoreNames.contains('userThemes')) {
        const s = db.createObjectStore('userThemes', { keyPath: 'id' });
        s.createIndex('order', 'order', { unique: false });
      }
    };

    req.onblocked = () => {
      console.warn('[db] IndexedDB 升級被其他分頁阻擋,請關閉其他開啟此網站的分頁');
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      // 列出實際存在的 stores,方便除錯
      console.log('[db] open OK, version =', db.version, ', stores =', Array.from(db.objectStoreNames));
      resolve(db);
    };
    req.onerror   = (e) => {
      console.error('[db] open failed:', e.target.error);
      reject(e.target.error);
    };
  });

  // ── 自動補建缺失的 store(處理 DB 升版沒跑到 onupgradeneeded 的情況)
  const required = ['watchlistGroups','screenerSets','screenerResults','seedSets','config',
                    'annotations','kline_cache','signals_cache','stockInfo','portfolio','portfolio_lists',
                    'sector_subscriptions','ai_analysis','yaogu_tracker','userThemes'];
  const missing  = required.filter(s => !_db.objectStoreNames.contains(s));
  if (missing.length > 0) {
    console.warn('[db] 缺失 stores:', missing, '→ 自動升版補建');
    const curVer = _db.version;
    _db.close();
    _db = null;
    _db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, curVer + 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const s of missing) {
          if (s === 'watchlistGroups') {
            const st = db.createObjectStore('watchlistGroups', { keyPath: 'id' });
            st.createIndex('order', 'order', { unique: false });
          } else if (s === 'screenerResults') {
            const st = db.createObjectStore('screenerResults', { keyPath: 'id' });
            st.createIndex('savedAt', 'savedAt', { unique: false });
          } else if (s === 'config') {
            db.createObjectStore('config', { keyPath: 'key' });
          } else if (s === 'portfolio_lists') {
            db.createObjectStore(s, { keyPath: 'id' });
          } else if (s === 'sector_subscriptions') {
            db.createObjectStore(s, { keyPath: 'sectorKey' });
          } else if (s === 'annotations' || s === 'stockInfo' || s === 'portfolio' || s === 'signals_cache') {
            db.createObjectStore(s, { keyPath: 'code' });
          } else if (s === 'kline_cache') {
            const st = db.createObjectStore('kline_cache', { keyPath: 'key' });
            st.createIndex('symbol', 'symbol', { unique: false });
            st.createIndex('cachedAt', 'cachedAt', { unique: false });
          } else if (s === 'ai_analysis') {
            // keyPath: `${code}_${modId}`，如 '2330_ichimoku'
            const st = db.createObjectStore('ai_analysis', { keyPath: 'id' });
            st.createIndex('code',    'code',    { unique: false });
            st.createIndex('savedAt', 'savedAt', { unique: false });
          } else if (s === 'yaogu_tracker') {
            // 妖股狀態機記錄 keyPath = code（4 碼股票代號）
            // 結構：{ code, activatedAt, status, lastUpdated }
            db.createObjectStore('yaogu_tracker', { keyPath: 'code' });
          } else if (s === 'userThemes') {
            const st = db.createObjectStore('userThemes', { keyPath: 'id' });
            st.createIndex('order', 'order', { unique: false });
          } else {
            db.createObjectStore(s, { keyPath: 'id' });
          }
          console.log(`[db] 補建 store: ${s}`);
        }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        console.log('[db] 升版完成 → version =', db.version, ', stores =', Array.from(db.objectStoreNames));
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  return _db;
}

// ─── 通用 IndexedDB CRUD ──────────────────────────────────────────────────

function tx(storeName, mode = 'readonly') {
  // 防呆:store 不存在時給友善錯誤,讓 caller 能 catch
  if (!_db.objectStoreNames.contains(storeName)) {
    const err = new Error(`[db] store '${storeName}' 不存在(DB 版本可能未升級,請清除 IndexedDB 重新整理)`);
    err.code = 'STORE_NOT_FOUND';
    throw err;
  }
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

export async function dbGet(store, key) {
  await initDB();
  try {
    return await wrap(tx(store).get(key));
  } catch (e) {
    if (e.code === 'STORE_NOT_FOUND') {
      console.warn(e.message);
      return null;
    }
    throw e;
  }
}

export async function dbGetAll(store) {
  await initDB();
  try {
    return await wrap(tx(store).getAll());
  } catch (e) {
    if (e.code === 'STORE_NOT_FOUND') {
      console.warn(e.message);
      return [];   // store 不存在 → 視為空,不中斷主流程
    }
    throw e;
  }
}

export async function dbPut(store, value) {
  await initDB();
  try {
    return await wrap(tx(store, 'readwrite').put(value));
  } catch (e) {
    if (e.code === 'STORE_NOT_FOUND') {
      console.warn(e.message, '— 寫入被略過');
      return;
    }
    throw e;
  }
}

export async function dbDelete(store, key) {
  await initDB();
  try {
    return await wrap(tx(store, 'readwrite').delete(key));
  } catch (e) {
    if (e.code === 'STORE_NOT_FOUND') {
      console.warn(e.message, '— 刪除被略過');
      return;
    }
    throw e;
  }
}

export async function dbClear(store) {
  await initDB();
  return wrap(tx(store, 'readwrite').clear());
}

// ─── Firestore 同步輔助 ───────────────────────────────────────────────────

/**
 * Firestore collection 名稱對應表
 * IndexedDB store name → Firestore collection name
 */
const FS_COL = {
  watchlistGroups: 'watchlist',
  screenerSets:    'screener_sets',
  screenerResults: 'screener_results',
  seedSets:        'seed_sets',
  annotations:     'annotations',
  stockInfo:       'stock_info',
  portfolio_lists: 'portfolio_lists',
  yaogu_tracker:   'yaogu',           // v2.8 妖股狀態機
  userThemes:      'user_themes',     // Phase 9 使用者自訂題材
};

/**
 * 非同步寫入 Firestore（不阻塞 UI）
 * 僅在已登入時執行，失敗只印 warning 不影響本地操作
 */
function _fsPushOne(store, data) {
  if (!currentUser || !FS_COL[store]) return;
  const uid = currentUser.uid;
  // ⚠️ Firestore 不接受 undefined，需先清除（null 可以，undefined 不行）
  const clean = JSON.parse(JSON.stringify(data, (k, v) => v === undefined ? null : v));
  fsSet(uid, FS_COL[store], clean.id, clean).catch(err =>
    console.warn(`[db] Firestore sync failed (${store}/${data.id}):`, err)
  );
}

function _fsDeleteOne(store, id) {
  if (!currentUser || !FS_COL[store]) return;
  const uid = currentUser.uid;
  fsDelete(uid, FS_COL[store], id).catch(err =>
    console.warn(`[db] Firestore delete failed (${store}/${id}):`, err)
  );
}

// ─── Config ───────────────────────────────────────────────────────────────

export async function getConfig(key, fallback = null) {
  const row = await dbGet('config', key);
  return row ? row.value : fallback;
}

export async function setConfig(key, value) {
  await dbPut('config', { key, value });
  // config 單獨走 Firestore 的 config/appConfig doc（merge 模式）
  if (currentUser) {
    fsSet(currentUser.uid, 'config', 'appConfig', { [key]: value }, true).catch(err =>
      console.warn('[db] Firestore config sync failed:', err)
    );
  }
}

// ─── 自選清單群組 ──────────────────────────────────────────────────────────

export async function getAllGroups() {
  const groups = await dbGetAll('watchlistGroups');
  return groups.sort((a, b) => a.order - b.order);
}

export async function saveGroup(group) {
  await dbPut('watchlistGroups', group);
  _fsPushOne('watchlistGroups', group);
}

export async function deleteGroup(id) {
  await dbDelete('watchlistGroups', id);
  _fsDeleteOne('watchlistGroups', id);
}

// ─── 篩選條件組合 ─────────────────────────────────────────────────────────

export async function getAllScreenerSets() {
  return dbGetAll('screenerSets');
}

export async function saveScreenerSet(set) {
  await dbPut('screenerSets', set);
  _fsPushOne('screenerSets', set);
}

export async function deleteScreenerSet(id) {
  await dbDelete('screenerSets', id);
  _fsDeleteOne('screenerSets', id);
}

// ─── 篩選結果命名清單 ─────────────────────────────────────────────────────

export async function getAllScreenerResults() {
  return dbGetAll('screenerResults');
}

export async function saveScreenerResult(record) {
  await dbPut('screenerResults', record);
  _fsPushOne('screenerResults', record);
}

export async function deleteScreenerResult(id) {
  await dbDelete('screenerResults', id);
  _fsDeleteOne('screenerResults', id);
}

// ─── 種子股組合（Phase 4）────────────────────────────────────────────────

export async function getAllSeedSets() {
  return dbGetAll('seedSets');
}

// ─── 庫存持倉 (portfolio) ─────────────────────────────────────────────────

export async function getAllHoldings() {
  return dbGetAll('portfolio');
}

export async function saveHolding(holding) {
  await dbPut('portfolio', holding);
  _fsPushOne('portfolio', holding);
}

export async function deleteHolding(code) {
  await dbDelete('portfolio', code);
  _fsDeleteOne('portfolio', code);
}

// ─── 庫存多清單(portfolio_lists)──────────────────────────────────────────

export async function getAllPortfolioLists() {
  return dbGetAll('portfolio_lists');
}

export async function savePortfolioList(list) {
  await dbPut('portfolio_lists', list);
  _fsPushOne('portfolio_lists', list);
}

export async function deletePortfolioList(id) {
  await dbDelete('portfolio_lists', id);
  _fsDeleteOne('portfolio_lists', id);
}

export async function saveSeedSet(set) {
  await dbPut('seedSets', set);
  _fsPushOne('seedSets', set);
}

export async function deleteSeedSet(id) {
  await dbDelete('seedSets', id);
  _fsDeleteOne('seedSets', id);
}

// ─── K 線標註（Phase 7）────────────────────────────────────────────────────

/**
 * 載入單檔股票的所有標註
 * @param {string} code  個股代碼
 * @returns {object|null}  { code, lines: [], notes: '', last_modified }
 */
export async function loadAnnotation(code) {
  if (!code) return null;
  return dbGet('annotations', code);
}

/**
 * 儲存單檔股票的標註（覆蓋整包）
 * @param {string} code
 * @param {object} data  { code, lines: [], notes?: '', custom_levels?: [] }
 */
export async function saveAnnotation(code, data) {
  if (!code) return;
  // annotations 用 code 當 keyPath；同時設 id=code 讓 _fsPushOne 能正常雲端同步
  const payload = {
    ...data,
    code,
    id: code,
    last_modified: Date.now(),
  };
  await dbPut('annotations', payload);
  _fsPushOne('annotations', payload);
}

/**
 * 刪除單檔股票的所有標註
 */
export async function deleteAnnotation(code) {
  if (!code) return;
  await dbDelete('annotations', code);
  _fsDeleteOne('annotations', code);
}

export async function getAllAnnotations() {
  return dbGetAll('annotations');
}

// ─── K 線資料快取(Phase 7.4)──────────────────────────────────────────────
// 不走 Firestore 同步:K 線資料量大、可重新從 Yahoo 拉,沒必要上雲

/**
 * 讀取快取的 K 線
 * @param {string} symbol  Yahoo symbol,例:'2330.TW'
 * @param {string} period  '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y'
 * @returns {object|null}  { key, symbol, period, candles, cachedAt, validUntil } 或 null
 */
export async function getKlineCache(symbol, period) {
  if (!symbol || !period) return null;
  const key = `${symbol}_${period}`;
  try {
    return await dbGet('kline_cache', key);
  } catch (e) {
    console.warn('[db] getKlineCache failed:', e?.message);
    return null;
  }
}

/**
 * 寫入快取(fire-and-forget,失敗不影響呼叫端)
 * @param {string} symbol
 * @param {string} period
 * @param {Array}  candles
 * @param {number} validUntil  失效時間戳(ms)
 */
export async function setKlineCache(symbol, period, candles, validUntil) {
  if (!symbol || !period || !Array.isArray(candles)) return;
  const key = `${symbol}_${period}`;
  try {
    await dbPut('kline_cache', {
      key,
      symbol,
      period,
      candles,
      cachedAt:   Date.now(),
      validUntil,
    });
  } catch (e) {
    console.warn('[db] setKlineCache failed:', e?.message);
  }
}

/**
 * 刪除單筆 K 線快取
 */
export async function deleteKlineCache(symbol, period) {
  if (!symbol || !period) return;
  const key = `${symbol}_${period}`;
  try {
    await dbDelete('kline_cache', key);
  } catch (e) {
    console.warn('[db] deleteKlineCache failed:', e?.message);
  }
}

/**
 * 清掉所有「失效時間 < 現在」的 K 線快取
 * 開機時跑一次,避免無限堆積
 */
export async function cleanupExpiredKlineCache() {
  try {
    const all = await dbGetAll('kline_cache');
    const now = Date.now();
    let removed = 0;
    for (const row of all) {
      if (row.validUntil && row.validUntil < now) {
        await dbDelete('kline_cache', row.key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[db] kline_cache 清理過期 ${removed} 筆`);
    }
  } catch (e) {
    console.warn('[db] cleanupExpiredKlineCache failed:', e?.message);
  }
}

/**
 * 整包清除 K 線快取(給「強制刷新」用 — 暫時不需要,目前用 force 跳過)
 */
export async function clearAllKlineCache() {
  try {
    await dbClear('kline_cache');
    console.log('[db] kline_cache 已全部清除');
  } catch (e) {
    console.warn('[db] clearAllKlineCache failed:', e?.message);
  }
}

// ─── 訊號掃描結果(Phase 7.4 Lazy 掃描)─────────────────────────────────────
// 不走 Firestore 同步:訊號可從 K 線重算,不需要跨裝置

/**
 * 讀取單檔的訊號掃描結果
 * @param {string} code  個股代碼
 * @returns {object|null}  { code, signals: [...], scannedAt }
 */
export async function getSignalsCache(code) {
  if (!code) return null;
  try {
    return await dbGet('signals_cache', code);
  } catch (e) {
    console.warn('[db] getSignalsCache failed:', e?.message);
    return null;
  }
}

/**
 * 寫入訊號掃描結果
 * @param {string} code
 * @param {Array} signals  Signal[]
 */
export async function setSignalsCache(code, signals, version) {
  if (!code || !Array.isArray(signals)) return;
  try {
    await dbPut('signals_cache', {
      code,
      signals,
      scannedAt: Date.now(),
      _v: version,   // v2.5 新增：策略邏輯版號，讀回時驗證快取是否仍對應當前 calc
    });
  } catch (e) {
    console.warn('[db] setSignalsCache failed:', e?.message);
  }
}

/**
 * 讀取所有訊號掃描結果(啟動時還原 AppState.signals 用)
 * @returns {Array<{ code, signals, scannedAt }>}
 */
export async function getAllSignalsCache() {
  try {
    return await dbGetAll('signals_cache');
  } catch (e) {
    console.warn('[db] getAllSignalsCache failed:', e?.message);
    return [];
  }
}

/**
 * 刪除單檔訊號快取
 */
export async function deleteSignalsCache(code) {
  if (!code) return;
  try {
    await dbDelete('signals_cache', code);
  } catch (e) {
    console.warn('[db] deleteSignalsCache failed:', e?.message);
  }
}

/**
 * 一次清空所有 signals 快取（v2.5 新增）
 * 用途：STRATEGY_VERSION 升版時，把所有舊快取一次清光
 * @returns {Promise<number>} 清掉的筆數
 */
export async function clearAllSignalsCache() {
  try {
    await initDB();
    const all = await dbGetAll('signals_cache');
    let cleared = 0;
    for (const row of all || []) {
      if (row?.code) {
        await dbDelete('signals_cache', row.code);
        cleared++;
      }
    }
    return cleared;
  } catch (e) {
    console.warn('[db] clearAllSignalsCache failed:', e?.message);
    return 0;
  }
}

// ─── 雲端同步 ─────────────────────────────────────────────────────────────

/**
 * 登入後：把本地 IndexedDB 資料上傳到 Firestore（本地優先）
 * 適用場景：第一次在這台裝置登入，把現有資料備份上雲
 */
// ─── 妖股狀態機追蹤（yaogu_tracker）v2.8 ───────────────────────────────────
//
// 資料結構：
//   {
//     code:         '3021',          // 股票代號（keyPath）
//     activatedAt:  1716595200000,   // 首次 X1+X2 同時亮的時間戳（ms）
//     status:       'active',        // 'active' | 'warning1' | 'warning2' | 'watching' | 'exited'
//     lastUpdated:  1716681600000,   // 最後更新時間戳（ms）
//     exitedAt:     null,            // 出場時間戳（status='exited' 時有值）
//   }
//
// ⚠️ 永久備忘：
//   - 雲端同步走 Firestore users/{uid}/yaogu/{code}
//   - status='exited' 的記錄保留 60 天供回顧，不自動刪除
//   - F5 後從 IndexedDB 讀取，不怕記憶體消失

/**
 * 讀取單一妖股記錄
 * @param {string} code 股票代號
 * @returns {object|null}
 */
export async function getYaoguRecord(code) {
  try {
    return await dbGet('yaogu_tracker', code);
  } catch (e) {
    if (e.code === 'STORE_NOT_FOUND') return null;
    throw e;
  }
}

/**
 * 讀取所有妖股記錄
 * @returns {Array}
 */
export async function getAllYaoguRecords() {
  try {
    return await dbGetAll('yaogu_tracker');
  } catch (e) {
    if (e.code === 'STORE_NOT_FOUND') return [];
    throw e;
  }
}

/**
 * 寫入/更新妖股記錄，並同步到 Firestore
 * @param {object} record  { code, activatedAt, status, lastUpdated, exitedAt? }
 */
export async function putYaoguRecord(record) {
  await dbPut('yaogu_tracker', record);
  // 雲端同步（已登入時）
  if (currentUser) {
    const clean = JSON.parse(JSON.stringify(record, (k, v) => v === undefined ? null : v));
    fsSet(currentUser.uid, 'yaogu', record.code, clean).catch(err =>
      console.warn(`[db] yaogu Firestore sync failed (${record.code}):`, err)
    );
  }
}

/**
 * 刪除妖股記錄（手動重置用）
 * @param {string} code
 */
export async function deleteYaoguRecord(code) {
  await dbDelete('yaogu_tracker', code);
  if (currentUser) {
    fsDelete(currentUser.uid, 'yaogu', code).catch(err =>
      console.warn(`[db] yaogu Firestore delete failed (${code}):`, err)
    );
  }
}

export async function syncLocalToCloud() {
  if (!currentUser) return;
  const uid = currentUser.uid;

  // ── 10 分鐘內已上傳過就跳過，避免每次 authStateChanged 重複全量上傳 ──
  const UPLOAD_KEY = `__cloudUpload_${uid}`;
  const UPLOAD_TTL = 10 * 60 * 1000; // 10 分鐘
  try {
    const last = localStorage.getItem(UPLOAD_KEY);
    if (last && Date.now() - Number(last) < UPLOAD_TTL) {
      console.log('[db] syncLocalToCloud 已在 10min 內上傳，跳過');
      return;
    }
  } catch (_) {}

  const stores = [
    { idb: 'watchlistGroups', fs: 'watchlist' },
    { idb: 'screenerSets',    fs: 'screener_sets' },
    { idb: 'screenerResults', fs: 'screener_results' },
    { idb: 'seedSets',        fs: 'seed_sets' },
    { idb: 'annotations',     fs: 'annotations' },
    { idb: 'portfolio_lists', fs: 'portfolio_lists' },
    { idb: 'yaogu_tracker',   fs: 'yaogu' },  // v2.8 妖股狀態機
    { idb: 'userThemes',      fs: 'user_themes' }, // Phase 9
  ];

  for (const { idb, fs } of stores) {
    try {
      const rows = await dbGetAll(idb);
      for (const row of rows) {
        // annotations 用 code 當 id,其餘 store 沿用 row.id
        const docId = row.id || row.code;
        if (!docId) continue;
        // ⚠️ Firestore 不接受 undefined,需先清除(null 可以,undefined 不行)
        //   舊版直接傳 row,某個 group 有 undefined 欄位就整批雲端寫不上去
        //   修法:跟 _fsPushOne 一樣用 JSON.stringify replacer 把 undefined 轉 null
        const clean = JSON.parse(JSON.stringify(row, (k, v) => v === undefined ? null : v));
        await fsSet(uid, fs, docId, clean);
      }
    } catch (err) {
      console.warn(`[db] syncLocalToCloud failed (${idb}):`, err);
    }
  }

  // config 整包上傳
  try {
    const configKeys = ['appConfig', 'ls_migrated'];
    const configObj  = {};
    for (const k of configKeys) {
      const row = await dbGet('config', k);
      if (row) configObj[k] = row.value;
    }
    if (Object.keys(configObj).length > 0) {
      await fsSet(uid, 'config', 'appConfig', configObj);
    }
  } catch (err) {
    console.warn('[db] syncLocalToCloud config failed:', err);
  }

  // 成功完成：更新上傳時間戳記
  try { localStorage.setItem(UPLOAD_KEY, String(Date.now())); } catch (_) {}
  console.log('[db] syncLocalToCloud done');
}

/**
 * 切換新裝置後：從 Firestore 拉回資料覆蓋本地 IndexedDB
 * 適用場景：新裝置首次開啟，本地是空的，從雲端還原
 * 只在本地 watchlistGroups 為空時自動執行（避免覆蓋本地較新資料）
 */
export async function syncCloudToLocal() {
  if (!currentUser) return;
  const uid = currentUser.uid;

  // ── 1小時內已同步過就跳過，避免每次 authStateChanged 都全量讀 Firestore ──
  const SYNC_KEY = `__cloudSync_${uid}`;
  const SYNC_TTL = 60 * 60 * 1000; // 1 小時
  try {
    const last = localStorage.getItem(SYNC_KEY);
    if (last && Date.now() - Number(last) < SYNC_TTL) {
      console.log('[db] syncCloudToLocal 已在 1hr 內同步，跳過');
      return;
    }
  } catch (_) {}

  // 每個 store 獨立判斷：本地空才從雲端拉，本地有資料則跳過
  //   修法緣由：原本只看 watchlistGroups 判斷整批，
  //   只要本地有自選股，題材/篩選組合等永遠拉不回來
  const stores = [
    { fs: 'watchlist',         idb: 'watchlistGroups',  check: rs => rs.some(g => g.stocks?.length > 0) },
    { fs: 'screener_sets',     idb: 'screenerSets',     check: rs => rs.length > 0 },
    { fs: 'screener_results',  idb: 'screenerResults',  check: rs => rs.length > 0 },
    { fs: 'seed_sets',         idb: 'seedSets',         check: rs => rs.length > 0 },
    { fs: 'annotations',       idb: 'annotations',      check: rs => rs.length > 0 },
    { fs: 'portfolio_lists',   idb: 'portfolio_lists',  check: rs => rs.some(l => l.items?.length > 0) },
    { fs: 'yaogu',             idb: 'yaogu_tracker',    check: rs => rs.length > 0 },
    { fs: 'user_themes',       idb: 'userThemes',       check: rs => rs.length > 0 },
  ];

  let pulledCount = 0;
  for (const { fs, idb, check } of stores) {
    try {
      const local = await dbGetAll(idb);
      if (check(local)) {
        console.log(`[db] syncCloudToLocal: ${idb} 本地有資料，跳過`);
        continue;
      }
      const rows = await fsGetAll(uid, fs);
      if (!rows.length) continue;
      for (const row of rows) {
        await dbPut(idb, row);
      }
      pulledCount += rows.length;
      console.log(`[db] syncCloudToLocal: ${idb} 拉回 ${rows.length} 筆`);
    } catch (err) {
      console.warn(`[db] syncCloudToLocal failed (${fs}):`, err);
    }
  }

  // config
  try {
    const cfgDoc = await fsGet(uid, 'config', 'appConfig');
    if (cfgDoc) {
      for (const [k, v] of Object.entries(cfgDoc)) {
        await dbPut('config', { key: k, value: v });
      }
    }
  } catch (err) {
    console.warn('[db] syncCloudToLocal config failed:', err);
  }

  // 成功完成：更新 lastSync 時間戳記
  try { localStorage.setItem(SYNC_KEY, String(Date.now())); } catch (_) {}
  console.log(`[db] syncCloudToLocal done (拉回 ${pulledCount} 筆共)`);
}

// ─── 從 localStorage 一次性遷移（首次載入執行一次）──────────────────────

export async function migrateFromLocalStorage() {
  try {
    const migrated = await getConfig('ls_migrated', false);
    if (migrated) return;
  } catch (_) {
    return;
  }

  try {
    const raw = localStorage.getItem('stockdash_watchlist_v2');
    if (raw) {
      const stocks = JSON.parse(raw);
      if (Array.isArray(stocks) && stocks.length > 0) {
        const clean = stocks.filter(s => s && s.code).map(s => ({
          code:   String(s.code),
          name:   s.name   ?? s.code,
          price:  s.price  ?? null,
          chg:    s.chg    ?? null,
          chgPct: s.chgPct ?? null,
        }));
        if (clean.length > 0) {
          await saveGroup({ id: 'default', name: '預設清單', order: 0, stocks: clean });
        }
      }
    }
  } catch (e) {
    console.warn('[db] migrate watchlist failed:', e);
  }

  try {
    const screenerRaw = localStorage.getItem('stockdash_screener_sets_v1');
    if (screenerRaw) {
      const sets = JSON.parse(screenerRaw);
      if (Array.isArray(sets)) {
        for (const s of sets) {
          if (s && s.id) await saveScreenerSet(s);
        }
      }
    }
  } catch (e) {
    console.warn('[db] migrate screenerSets failed:', e);
  }

  try {
    const cfgRaw = localStorage.getItem('stockdash_config_v1');
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw);
      if (cfg && typeof cfg === 'object') await setConfig('appConfig', cfg);
    }
  } catch (e) {
    console.warn('[db] migrate config failed:', e);
  }

  try {
    await setConfig('ls_migrated', true);
  } catch (_) {}
}

// ─── 個股補充資訊（Advanced 2 — Prompt 匯入）────────────────────────────────

/**
 * 載入個股補充資訊
 * @param {string} code  個股代碼
 * @returns {object|null}
 */
export async function loadStockInfo(code) {
  if (!code) return null;
  await initDB();
  return wrap(tx('stockInfo').get(code));
}

/**
 * 儲存個股補充資訊（覆蓋整包）
 * @param {string} code
 * @param {object} info  JSON 匯入的資料
 */
export async function saveStockInfo(code, info) {
  if (!code) return;
  await initDB();
  const data = { code, id: code, ...info, savedAt: Date.now() };
  await wrap(tx('stockInfo', 'readwrite').put(data));
  // 同步到 Firestore 個人區（id: code 供 _fsPushOne 用）
  _fsPushOne('stockInfo', data);
}

/**
 * 刪除個股補充資訊
 */
export async function deleteStockInfo(code) {
  if (!code) return;
  await initDB();
  await wrap(tx('stockInfo', 'readwrite').delete(code));
}

// ══════════════════════════════════════════════════════
// AI 分析結果快取（ai_analysis store）
// keyPath: id = `${code}_${modId}_${period}`
// 不同週期的分析分開存（日K 1y 與週K 2y 的 Ichimoku 分析方向不同）
// ══════════════════════════════════════════════════════

/**
 * 讀取單筆 AI 分析結果
 * @param {string} code
 * @param {string} modId   指標 id，如 'ichimoku'
 * @param {string} period  週期，如 '1y' '2y' '6mo'
 * @returns {Object|null}
 */
export async function getAIAnalysis(code, modId, period) {
  if (!code || !modId) return null;
  await initDB();
  return wrap(tx('ai_analysis', 'readonly').get(`${code}_${modId}_${period || ''}`));
}

/**
 * 寫入 AI 分析結果
 * @param {string} code
 * @param {string} modId
 * @param {Object} payload  { prompt, result, period }
 */
export async function setAIAnalysis(code, modId, payload) {
  if (!code || !modId) return;
  await initDB();
  const period = payload.period || '';
  await wrap(tx('ai_analysis', 'readwrite').put({
    id:      `${code}_${modId}_${period}`,
    code,
    modId,
    period,
    prompt:  payload.prompt  || '',
    result:  payload.result  || '',
    savedAt: Date.now(),
  }));
}

/**
 * 刪除單筆 AI 分析結果
 */
export async function deleteAIAnalysis(code, modId, period) {
  if (!code || !modId) return;
  await initDB();
  await wrap(tx('ai_analysis', 'readwrite').delete(`${code}_${modId}_${period || ''}`));
}

/**
 * 讀取某股票 + 某週期 所有模組的 AI 分析（供全視窗一次預載）
 * @param {string} code
 * @param {string} period
 * @returns {Object}  { [modId]: record }
 */
export async function getAllAIAnalysisByCode(code, period) {
  if (!code) return {};
  await initDB();
  const all = await wrap(
    tx('ai_analysis', 'readonly').index('code').getAll(IDBKeyRange.only(code))
  );
  const map = {};
  for (const row of all || []) {
    // 只回傳符合當前週期的紀錄
    if (period && row.period && row.period !== period) continue;
    map[row.modId] = row;
  }
  return map;
}

// ══════════════════════════════════════════════════════
// 健康度快取（health cache）— 存於 stockInfo store
// keyPath: code
// 欄位：healthShort / healthLong / healthSavedAt / healthSource
//   healthSource: 'intraday' | 'afterhours'
//   healthSavedAt: epoch ms
//
// 更新規則（由 portfolio-ui.js 判斷）：
//   盤後存的（healthSource='afterhours'）→ 同一交易日直接用
//   盤中存的（healthSource='intraday'）  → 距今 < 5 分鐘直接用，否則重算
//   跨交易日 → 一定重算
// ══════════════════════════════════════════════════════

/**
 * 讀取健康度快取
 * @param {string} code
 * @returns {{ healthShort, healthLong, healthSavedAt, healthSource } | null}
 */
export async function loadHealthCache(code) {
  if (!code) return null;
  await initDB();
  const row = await wrap(tx('stockInfo').get(code));
  if (!row || row.healthSavedAt == null) return null;
  return {
    healthShort:   row.healthShort   ?? null,
    healthLong:    row.healthLong    ?? null,
    healthSavedAt: row.healthSavedAt,
    healthSource:  row.healthSource  ?? 'afterhours',
    lastPrice:     row.lastPrice     ?? null,  // 最後已知現價
  };
}

/**
 * 儲存健康度快取（merge 進 stockInfo，不覆蓋其他欄位）
 * 同時 push 到 Firestore（已登入時）
 * @param {string} code
 * @param {number|null} healthShort
 * @param {number|null} healthLong
 * @param {'intraday'|'afterhours'} source
 */
export async function saveHealthCache(code, healthShort, healthLong, source = 'afterhours', lastPrice = null) {
  if (!code) return;
  await initDB();
  // 讀出現有資料 merge，避免覆蓋 AI 匯入的欄位
  const existing = await wrap(tx('stockInfo').get(code)) ?? { code };
  const data = {
    ...existing,
    code,
    id: code,  // ★ _fsPushOne 用 clean.id 當 Firestore docId，stockInfo keyPath 是 code
    healthShort,
    healthLong,
    healthSavedAt: Date.now(),
    healthSource:  source,
    ...(lastPrice != null ? { lastPrice } : {}),  // 有值才更新，避免覆蓋
  };
  await wrap(tx('stockInfo', 'readwrite').put(data));
  // Firestore 同步（fire-and-forget）
  _fsPushOne('stockInfo', data);
}

/**
 * 批次讀取多檔健康度快取
 * @param {string[]} codes
 * @returns {Map<string, { healthShort, healthLong, healthSavedAt, healthSource }>}
 */
export async function loadHealthCacheBatch(codes) {
  if (!codes?.length) return new Map();
  await initDB();
  const result = new Map();
  for (const code of codes) {
    const row = await wrap(tx('stockInfo').get(code));
    if (row?.healthSavedAt != null) {
      result.set(code, {
        healthShort:   row.healthShort   ?? null,
        healthLong:    row.healthLong    ?? null,
        healthSavedAt: row.healthSavedAt,
        healthSource:  row.healthSource  ?? 'afterhours',
        lastPrice:     row.lastPrice     ?? null,
      });
    }
  }
  return result;
}

/**
 * 啟動時預填報價：從 stockInfo 批次讀所有有 lastPrice 的記錄
 * 供 main.js PriceHub 初始化後立刻 push，讓題材/篩選等 Tab 一開就有舊價格
 * @returns {Object} { [code]: { price, prev, chgPct, name } }
 */
export async function loadAllLastPrices() {
  await initDB();
  const all = await wrap(tx('stockInfo').getAll());
  const result = {};
  for (const row of (all ?? [])) {
    if (!row?.code || row.lastPrice == null) continue;
    result[row.code] = {
      price:   row.lastPrice,
      prev:    row.lastPrice,   // 沒有 prev 就先用同值，TWSE 批次來了會覆蓋
      chg:     0,
      chgPct:  0,
      name:    row.name ?? row.code,
    };
  }
  return result;
}

// ─── Phase 9: 使用者自訂題材 CRUD ────────────────────────────────────────────
// 資料結構：
// {
//   id: 'theme_<timestamp>',  ← keyPath
//   emoji: '🤖',
//   name: 'AI 機器人',
//   desc: '...',
//   color: 'blue',            ← blue/green/red/yellow/purple/orange/cyan/gray
//   order: 0,                 ← 排序
//   stocks: [{ code, name, reason }],
//   createdAt: epoch_ms,
//   updatedAt: epoch_ms,
// }

/**
 * 取得所有使用者題材（依 order 排序）
 */
export async function getUserThemes() {
  await initDB();
  const all = await wrap(tx('userThemes').getAll());
  return (all ?? []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 新增或更新一個題材
 */
export async function saveUserTheme(theme) {
  await initDB();
  const now = Date.now();
  const data = {
    ...theme,
    updatedAt: now,
    createdAt: theme.createdAt ?? now,
  };
  await wrap(tx('userThemes', 'readwrite').put(data));
  _fsPushOne('userThemes', data);
  return data;
}

/**
 * 刪除一個題材
 */
export async function deleteUserTheme(id) {
  await initDB();
  await wrap(tx('userThemes', 'readwrite').delete(id));
  _fsDeleteOne('userThemes', id);
}

/**
 * 批次更新排序（拖曳後呼叫）
 * @param {Array<{id, order}>} orderList
 */
export async function reorderUserThemes(orderList) {
  await initDB();
  for (const { id, order } of orderList) {
    const existing = await wrap(tx('userThemes').get(id));
    if (!existing) continue;
    const updated = { ...existing, order, updatedAt: Date.now() };
    await wrap(tx('userThemes', 'readwrite').put(updated));
    _fsPushOne('userThemes', updated);
  }
}
