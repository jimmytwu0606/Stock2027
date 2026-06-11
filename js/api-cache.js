/**
 * api-cache.js — IDB 快取層（fundCache / nameCache store）
 */

// ─────────────────────────────────────────────
// 基本面快取（IndexedDB）
// key 格式：
//   fund_{code}     → fetchFundamentals 結果
//   rev_{code}      → fetchFinMindRevenue 結果
//
// TTL 策略：依台灣法規公布截止日 + 2天緩衝判斷，而非固定時間
//   月營收：每月 10 號前公布 → 12 號後才視為「新週期已開始」
//   季財報：5/15、8/14、11/14、3/31 → 各加 2 天
// ─────────────────────────────────────────────
const _NAME_TTL    = 90 * 24 * 60 * 60 * 1000; // 90 天（名稱快取專用）
const _CACHE_STORE = 'fundCache';
const _NAME_STORE  = 'nameCache';
let _cacheDB = null;

/**
 * 計算「最近一個應更新點」的時間戳（ms）
 * 規則：月營收 12 號、季財報各截止日 +2 天
 * 快取的 ts 若早於此時間點 → 視為過期
 */
function _lastUpdatePoint() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const day   = now.getDate();

  // 季報更新點（月/日，均已 +2 天緩衝）
  // [月(0-indexed), 日]
  const quarterPoints = [
    [4-1, 2],   // Q4+年報：3/31 → 4/2
    [5-1, 17],  // Q1：5/15 → 5/17
    [8-1, 16],  // Q2：8/14 → 8/16
    [11-1, 16], // Q3：11/14 → 11/16
  ];

  // 找出今年所有候選時間點（季報 + 每月 12 號）
  const candidates = [];

  // 月營收更新點：每月 12 號
  for (let m = 0; m <= 11; m++) {
    candidates.push(new Date(year, m, 12).getTime());
    candidates.push(new Date(year - 1, m, 12).getTime()); // 去年同期
  }

  // 季報更新點
  for (const [m, d] of quarterPoints) {
    candidates.push(new Date(year, m, d).getTime());
    candidates.push(new Date(year - 1, m, d).getTime()); // 去年同期
  }

  // 找出「所有 <= 今天的更新點」中最大的一個
  const nowTs = Date.now();
  const past  = candidates.filter(t => t <= nowTs);
  return Math.max(...past);
}

async function _openCacheDB() {
  if (_cacheDB) return _cacheDB;
  return new Promise((resolve, reject) => {
    // version 2：新增 nameCache store
    const req = indexedDB.open('stockdash_cache', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // v1 的 fundCache（保留）
      if (!db.objectStoreNames.contains(_CACHE_STORE)) {
        db.createObjectStore(_CACHE_STORE, { keyPath: 'key' });
      }
      // v2 新增：nameCache（一筆存整張名稱表）
      if (!db.objectStoreNames.contains(_NAME_STORE)) {
        db.createObjectStore(_NAME_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { _cacheDB = e.target.result; resolve(_cacheDB); };
    req.onerror   = () => reject(req.error);
  });
}

/** 讀名稱快取，回傳 { [code]: name } 或 null（不存在/過期） */
async function _namesCacheGet() {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_NAME_STORE, 'readonly');
    const store = tx.objectStore(_NAME_STORE);
    const item  = await new Promise((res, rej) => {
      const r = store.get('all');
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    if (!item) return null;
    if (Date.now() - item.ts > _NAME_TTL) return null;  // 過期（90天）
    return { names: item.names, ts: item.ts };
  } catch (e) {
    console.warn('[nameCache] get failed:', e.message);
    return null;
  }
}

/** 寫名稱快取 */
async function _namesCacheSet(names) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_NAME_STORE, 'readwrite');
    const store = tx.objectStore(_NAME_STORE);
    store.put({ key: 'all', names, ts: Date.now() });
  } catch (e) {
    console.warn('[nameCache] set failed:', e.message);
  }
}

async function _cacheGet(key) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readonly');
    const store = tx.objectStore(_CACHE_STORE);
    const item  = await new Promise((res, rej) => {
      const r = store.get(key);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    if (!item) return null;
    // 智慧判斷：快取時間點早於「最近一個應更新點」→ 過期
    // 例如今天 5/15，最近更新點是 5/12（月營收），
    // 若快取是 5/11 存的 → 過期；5/13 存的 → 還有效
    if (item.ts < _lastUpdatePoint()) {
      console.log(`[cache] expired ${key}（快取早於最近更新點，重新抓取）`);
      return null;
    }
    return item.value;
  } catch (e) {
    console.warn('[cache] get failed:', e.message);
    return null;
  }
}

async function _cacheSet(key, value) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(_CACHE_STORE);
    store.put({ key, value, ts: Date.now() });
  } catch (e) {
    console.warn('[cache] set failed:', e.message);
  }
}

/** 給 AI 圓桌預載用 — 只讀快取,沒有不打 API */
export async function getCachedFundamentals(code) {
  return _cacheGet(`fund_${code}`);
}
export async function getCachedChipData(code) {
  return _cacheGet(`chip_${code}`);
}

/** 清除單一個股的快取（手動重新整理時用） */
export async function clearFundCache(code) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(_CACHE_STORE);
    store.delete(`fund_${code}`);
    store.delete(`rev_${code}`);
    console.log(`[cache] cleared fund ${code}`);
  } catch (e) {
    console.warn('[cache] clear failed:', e.message);
  }
}

/** 清除籌碼快取（手動更新籌碼時用） */
export async function clearChipCache(code) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(_CACHE_STORE);
    store.delete(`chip_${code}`);
    console.log(`[cache] cleared chip ${code}`);
  } catch (e) {
    console.warn('[cache] clear chip failed:', e.message);
  }
}
export { _openCacheDB, _cacheGet, _cacheSet, _namesCacheGet, _namesCacheSet, _lastUpdatePoint };

