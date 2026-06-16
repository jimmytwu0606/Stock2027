/**
 * state.js
 * 全域應用狀態與 localStorage 持久化
 *
 * export：
 *   AppState
 *   saveWatchlist()
 *   addToWatchlist(code, name)
 *   removeFromWatchlist(idx)
 *   updateWatchlistPrice(code, price, chg, chgPct, name)
 */

const STORAGE_KEY = 'stockdash_watchlist_v2';

const DEFAULT_WATCHLIST = [
  { code: '2330', name: '台積電',     price: null, chg: null, chgPct: null },
  { code: '2317', name: '鴻海',       price: null, chg: null, chgPct: null },
  { code: '2454', name: '聯發科',     price: null, chg: null, chgPct: null },
  { code: '2412', name: '中華電',     price: null, chg: null, chgPct: null },
  { code: '0050', name: '元大台灣50', price: null, chg: null, chgPct: null },
];

function _loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (e) { /* ignore */ }
  return DEFAULT_WATCHLIST.map(s => ({ ...s }));
}

/** 應用主狀態，所有模組共享此物件 */
export const AppState = {
  activeCode: null,      // 目前顯示的股票代號
  period:     '1mo',     // 目前 K 線週期
  indicators: {          // 副圖指標開關
    KD:   true,
    RSI:  true,
    MACD: true,
    // Advanced 5 — 主圖 overlay（預設關閉）
    BB:   false,         // 布林通道（從 ma 移來，統一由 _toggleInd 管理）
    EMA:  false,
    GMMA: false,
    SAR:  false,
    SUPERTREND: false,   // T-7 Supertrend 主圖貼地線（ATR 通道翻轉）
    AVWAP: false,        // T-2 錨定VWAP（妖股 active 自動掛啟動日成本線）
    ENV:  false,
    // Advanced 5 — 副圖（預設關閉）
    DMI:  false,
    PSY:  false,
    RCI:  false,
    HV:   false,
    TTM:  false,         // T-6 TTM Squeeze 副圖（壓縮點+動能柱）
    OBV:  false,         // T-8 OBV 能量潮副圖
    // C1 — 一目均衡表（預設關閉，使用者主動勾選時才觸發獨佔模式）
    // ⚠️ 不可設為 true:1mo/3mo/5d 等預設週期 K 數不足,
    //   會導致 _renderIchimoku ready=false 但 fitContent 又被跳過,
    //   K 線停在預設右側位置,看起來像被擠到角落
    ICHI: false,
    // C3 — 分價量表（預設關閉）
    PVD:  false,
  },
  // C1 — Ichimoku 獨佔模式暫存：勾選 ICHI 時把其他指標狀態存進來，
  // 取消勾選時還原。null = 不在獨佔模式
  _indicatorsBackup: null,
  // C1 — Ichimoku 獨佔模式旗標：true = 自動關了其他指標；false = 使用者自己又開回來
  ma: {                  // 均線開關
    5:  true,
    10: true,
    20: true,
    60: false,
  },
  watchlist:   _loadWatchlist(),
  lastCandles: [],       // 最後一次載入的 K 線（供 Phase 3 使用）

  // Phase 2
  screener: {
    conditions: [],      // 篩選條件陣列
    results:    [],      // 篩選結果
    savedSets:  [],      // 儲存的篩選組合
  },

  // Phase 3
  pattern: {
    template:    null,       // Candle[]  框選或手繪的範本
    similarity:  75,         // 相似度門檻（0~100）
    windowSize:  20,         // 比對視窗根數
    featureMode: 'simple',   // 'simple'（收盤價）| 'multi'（多維特徵）
    scanResults: [],         // 掃描結果
  },

  // 訊號比對結果 { [code]: Signal[] }
  signals: {},

  // 群組自選清單（由 watchlist.js 維護）
  watchlistGroups: [],

  // Phase 4
  seed: {
    seedCodes:   [],    // string[]：種子代號列表
    features:    [],    // SeedFeature[]：萃取結果
    template:    null,  // MergedTemplate | null
    weights:     { sector: 0.25, pattern: 0.50, indicator: 0.25 },
    windowSize:  20,    // 比對視窗根數
    threshold:   60,    // 最低綜合分數（0–100）
    scanResults: [],    // SeedResultItem[]
  },
};

export function saveWatchlist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(AppState.watchlist));
}

/** 新增自選股（若已存在則略過），回傳是否成功新增 */
export function addToWatchlist(code, name = null) {
  if (AppState.watchlist.find(s => s.code === code)) return false;
  AppState.watchlist.push({ code, name: name || code, price: null, chg: null, chgPct: null });
  saveWatchlist();
  return true;
}

/** 移除自選股 */
export function removeFromWatchlist(idx) {
  AppState.watchlist.splice(idx, 1);
  saveWatchlist();
}

/** 更新自選股報價 */
export function updateWatchlistPrice(code, price, chg, chgPct, name = null) {
  const entry = AppState.watchlist.find(s => s.code === code);
  if (!entry) return;
  entry.price  = price;
  entry.chg    = chg;
  entry.chgPct = chgPct;
  if (name && entry.name === code) entry.name = name;
  saveWatchlist();
}
