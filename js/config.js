/**
 * config.js
 * 資料來源設定、API Key 管理、功能模組開關
 *
 * v3：登入後 FinMind Token 額外同步至 Firestore
 *     其他設定維持 db.js 雙軌（IndexedDB + Firestore）
 *
 * export：
 *   Config
 *   loadConfig()          ← async
 *   saveConfig()          ← async
 *   resetConfig()         ← async
 *   syncTokenFromCloud()  ← async，登入後從雲端拉回 Token
 *   getDataSource()
 *   getFinMindToken()
 *   getNewsSource()
 *   isModuleEnabled(key)
 */

import { getConfig, setConfig } from './db.js';
import { currentUser, fsGet, fsSet } from './firebase.js';

const DEFAULT_CONFIG = {
  dataSource:     'twse',       // 'twse' | 'finmind'
  finmindToken:   '',
  newsSource:     'yahootw',    // 'yahootw' | 'googlenews' | 'yahoofinance'
  concurrency:    5,
  screenerPeriod: '3mo',
  modules: {
    institutionalBuySell: true,
    marginTrading:        true,
    technicalScreener:    true,
  },
  mobileDefaultIndicator: 'KD',
  // AI 圓桌:每個人格的自訂句型(一行一句),存使用者貼進來的擴充內容
  personasLines: {
    deng: [], niu: [], ga: [], aunt: [], quant: [],
  },
};

// 執行期 Config 物件（由 loadConfig() 填充）
export const Config = {
  ...DEFAULT_CONFIG,
  modules:       { ...DEFAULT_CONFIG.modules },
  personasLines: {
    deng: [], niu: [], ga: [], aunt: [], quant: [],
  },
};

// ─── 載入（async）────────────────────────────────────────────────────────

export async function loadConfig() {
  try {
    const saved = await getConfig('appConfig', null);
    if (saved) {
      Object.assign(Config, saved);
      Config.modules = { ...DEFAULT_CONFIG.modules, ...(saved.modules ?? {}) };
      // 確保 personasLines 五個 key 都存在(避免舊版資料缺欄)
      Config.personasLines = {
        deng:  Array.isArray(saved.personasLines?.deng)  ? saved.personasLines.deng  : [],
        niu:   Array.isArray(saved.personasLines?.niu)   ? saved.personasLines.niu   : [],
        ga:    Array.isArray(saved.personasLines?.ga)    ? saved.personasLines.ga    : [],
        aunt:  Array.isArray(saved.personasLines?.aunt)  ? saved.personasLines.aunt  : [],
        quant: Array.isArray(saved.personasLines?.quant) ? saved.personasLines.quant : [],
      };
    }
  } catch (e) {
    console.warn('[config] loadConfig failed, using defaults:', e);
  }
}

// ─── 儲存（async）────────────────────────────────────────────────────────

export async function saveConfig() {
  try {
    const data = {
      dataSource:             Config.dataSource,
      finmindToken:           Config.finmindToken,
      newsSource:             Config.newsSource,
      concurrency:            Config.concurrency,
      screenerPeriod:         Config.screenerPeriod,
      modules:                { ...Config.modules },
      mobileDefaultIndicator: Config.mobileDefaultIndicator,
      personasLines:          { ...Config.personasLines },
    };

    // 本地 IndexedDB（db.js 會順帶同步一般欄位到 Firestore）
    await setConfig('appConfig', data);

    // FinMind Token 額外單獨寫入 Firestore private doc（已登入時）
    // 路徑：users/{uid}/config/finmindToken
    // 與其他 config 分開存，方便之後做欄位級別的權限控管
    if (currentUser && Config.finmindToken?.trim()) {
      fsSet(currentUser.uid, 'config', 'finmindToken', {
        token:     Config.finmindToken.trim(),
        updatedAt: Date.now(),
      }).catch(err => console.warn('[config] Token cloud sync failed:', err));
    }
  } catch (e) {
    console.error('[config] saveConfig failed:', e);
  }
}

// ─── 重置（async）────────────────────────────────────────────────────────

export async function resetConfig() {
  Object.assign(Config, DEFAULT_CONFIG);
  Config.modules       = { ...DEFAULT_CONFIG.modules };
  Config.personasLines = { deng: [], niu: [], ga: [], aunt: [], quant: [] };
  await saveConfig();
}

// ─── 登入後從雲端拉回 FinMind Token ─────────────────────────────────────
//
// 呼叫時機：main.js 的 authReady 事件觸發後
// 策略：雲端有 Token 且本地沒有 → 用雲端的；本地有 → 維持本地（本地優先）

export async function syncTokenFromCloud() {
  if (!currentUser) return;

  try {
    // 本地已有 Token，不覆蓋
    if (Config.finmindToken?.trim()) {
      // 但確保雲端也有最新版本
      await fsSet(currentUser.uid, 'config', 'finmindToken', {
        token:     Config.finmindToken.trim(),
        updatedAt: Date.now(),
      });
      return;
    }

    // 本地沒有，從雲端拉
    const doc = await fsGet(currentUser.uid, 'config', 'finmindToken');
    if (doc?.token) {
      Config.finmindToken = doc.token;
      // 同步回本地 IndexedDB
      await setConfig('appConfig', { ...Config });
      console.log('[config] FinMind Token restored from cloud');
    }
  } catch (err) {
    console.warn('[config] syncTokenFromCloud failed:', err);
  }
}

// ─── 快捷 getter ──────────────────────────────────────────────────────────

export function getDataSource()      { return Config.dataSource; }
export function getFinMindToken()    { return Config.finmindToken?.trim() || null; }
export function getNewsSource()      { return Config.newsSource ?? 'yahootw'; }
export function isModuleEnabled(key) { return Config.modules[key] === true; }
