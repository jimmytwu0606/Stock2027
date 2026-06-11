/**
 * api-names.js — 股名 / 代號工具
 */
import { fsGetShared } from './firebase.js';


// ─────────────────────────────────────────────
// 中文名稱 cache（由 fetchTWSEPrices 填充）
// ─────────────────────────────────────────────
const _nameCache = {};   // { '2330': '台積電', ... }

/**
 * 查詢中文股票名稱（需先呼叫過 fetchTWSEPrices）
 * @param {string} code  純代號，如 '2330'
 * @returns {string|null}
 */
export function getChineseName(code) {
  return _nameCache[code] ?? null;
}

export async function preloadNamesFromFirestore() {
  // ── localStorage 快取：24 小時內不重打 Firestore ──────────────────────
  const CACHE_KEY = '__nameCache_v1';
  const TTL_MS    = 24 * 60 * 60 * 1000; // 24 小時
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < TTL_MS && data && typeof data === 'object') {
        let filled = 0;
        for (const [code, name] of Object.entries(data)) {
          if (!_nameCache[code] && name) { _nameCache[code] = name; filled++; }
        }
        // 同步到 window.__nameCache（modal-strategy.js 等模組用）
        if (!window.__nameCache) window.__nameCache = new Map();
        for (const [code, name] of Object.entries(data)) {
          if (!window.__nameCache.has(code) && name) window.__nameCache.set(code, name);
        }
        console.log(`[api] preloadNamesFromFirestore → localStorage 命中 ${filled} 筆`);
        return;
      }
    }
  } catch (_) { /* localStorage 失敗就繼續讀 Firestore */ }

  // ── 快取過期或不存在：讀 Firestore ────────────────────────────────────
  try {
    const meta = await fsGetShared('names/meta');
    if (!meta?.batches) return;
    const batches = Number(meta.batches);
    let filled = 0;
    const freshData = {};
    for (let b = 0; b < batches; b++) {
      const chunk = await fsGetShared(`names/batch${b}`);
      if (!chunk) continue;
      const entries = Array.isArray(chunk) ? chunk : Object.entries(chunk);
      for (const [code, name] of entries) {
        if (name && typeof name === 'string') {
          freshData[code] = name;
          if (!_nameCache[code]) { _nameCache[code] = name; filled++; }
        }
      }
    }
    // 寫回 localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: freshData }));
    } catch (_) { /* 超過 5MB quota 靜默略過 */ }
    // 同步到 window.__nameCache（modal-strategy.js 等模組用）
    if (!window.__nameCache) window.__nameCache = new Map();
    for (const [code, name] of Object.entries(freshData)) {
      if (!window.__nameCache.has(code) && name) window.__nameCache.set(code, name);
    }
    console.log(`[api] preloadNamesFromFirestore → Firestore ${filled} 筆，已快取`);
  } catch (e) {
    console.warn('[api] preloadNamesFromFirestore failed:', e.message);
  }
}



/**
 * 取得所有已知股票代號（從中文名快取）
 * 用途：TWSE/TPEx 全掛時，篩選器的清單來源 fallback
 * @returns {string[]}  e.g. ['2330','2317',...]
 */
export function getAllKnownCodes() {
  return Object.keys(_nameCache).filter(c => /^\d{4,6}$/.test(c));
}

/**
 * 指數/特殊代號靜態對照表
 * ⚠️ 踩雷備忘：^TWII / ^DJI / ^SOX 等指數代號不是台股代號，
 *   不可送去 TWSE opendata 查詢（會 ERR_NAME_NOT_RESOLVED / 404）。
 *   在這裡直接給中文名，ensureChineseName 的三道防線完全跳過。
 * 新增指數時只需在這裡加一行，不需動其他邏輯。
 */
const _INDEX_NAMES = {
  '^TWII':  '加權指數',
  '^DJI':   '道瓊指數',
  '^IXIC':  '那斯達克',
  '^GSPC':  'S&P 500',
  '^SOX':   '費城半導體',
  '^N225':  '日經225',
  '^HSI':   '恆生指數',
  '^FTSE':  '富時100',
  '^VIX':   '恐慌指數',
  'GC=F':   '黃金期貨',
  'CL=F':   '原油期貨',
  'BTC-USD': '比特幣',
};

/**
 * 確保 _nameCache 有該代號的中文名。
 * 若 _nameCache 已有就直接回傳，否則打 TWSE 個股 API 補填。
 * 不拋錯，失敗靜默略過。
 * @param {string} code  純代號，如 '2330'
 * @returns {Promise<string|null>}
 */
export async function ensureChineseName(code) {
  // ── 指數/特殊代號：直接回靜態中文名，不打任何 API ──
  // ⚠️ ^TWII 等代號送 TWSE 會 ERR_NAME_NOT_RESOLVED，務必在此攔截
  if (_INDEX_NAMES[code]) {
    _nameCache[code] = _INDEX_NAMES[code];
    return _INDEX_NAMES[code];
  }

  // ── 非純數字代號（如 ^開頭、已帶.TW suffix）→ 不是台股，不查 TWSE ──
  if (!/^\d{4,6}$/.test(code)) {
    return null;  // 靜默略過，沒有中文名也無妨
  }

  // ── _nameCache 已有就直接回傳（preloadNamesFromFirestore 預載後命中率很高）──
  if (_nameCache[code]) return _nameCache[code];

  // ⚠️ 踩雷備忘：
  //   Firebase names/batch* 是自己的資料庫，優先查，不要先打外部 API
  //   preloadNamesFromFirestore 在 main.js 啟動時已背景執行，
  //   但若 loadStock 比預載更早觸發（race condition），這裡補查一次個股

  // 第一道：Firebase names/batch*（自己的資料，優先）
  // 逐批搜尋，找到就停止（不需要讀全部批次）
  try {
    const meta = await fsGetShared('names/meta');
    if (meta?.batches > 0) {
      for (let b = 0; b < meta.batches; b++) {
        const chunk = await fsGetShared(`names/batch${b}`);
        if (!chunk) continue;
        const entries = Array.isArray(chunk) ? chunk : Object.entries(chunk);
        // 順帶填充整批進 _nameCache（下次就不用再查了）
        for (const [c, n] of entries) {
          if (n && typeof n === 'string' && !_nameCache[c]) _nameCache[c] = n;
        }
        if (_nameCache[code]) return _nameCache[code];
      }
    }
  } catch (_) {}

  // ── _nameCache 預載後可能已有了，再查一次 ──
  if (_nameCache[code]) return _nameCache[code];

  // 第二道：FinMind TaiwanStockInfo（外部 API，CORS 友善）
  try {
    const token = getFinMindToken?.() ?? '';
    const url   = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&data_id=${code}${token ? `&token=${token}` : ''}`;
    const text  = await fetchDirect(url, 6000);
    const name  = JSON.parse(text)?.data?.[0]?.stock_name;
    if (name) { _nameCache[code] = name; return name; }
  } catch (_) {}

  return null;
}
export { _nameCache };

