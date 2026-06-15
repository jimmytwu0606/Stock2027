/**
 * api.js — 殼層（功能已分割至 api-*.js，所有舊 import 路徑不變）
 *   api-core.js     proxy / token / 熔斷 / toYahooSymbol
 *   api-cache.js    IDB fundCache / nameCache
 *   api-names.js    股名工具
 *   api-kline.js    K線 / 報價 / 篩選 / bundle
 *   api-fund.js     基本面 / 財報 / 籌碼
 *   api-news.js     新聞 / 公告
 *   api-prices.js   fetchTWSEPrices / MIS
 *   api-snapshot.js snapshot / cond history
 */
export { FEATURE_INTRADAY_5M, toYahooSymbol, isWorkerCooling, workerCooldownRemainSec,
         getKlineProxyMode, setKlineProxyMode } from './api-core.js';
export { getCachedFundamentals, getCachedChipData, clearFundCache, clearChipCache } from './api-cache.js';
export { getChineseName, preloadNamesFromFirestore, getAllKnownCodes, ensureChineseName } from './api-names.js';
export { resolveYahooSymbol, fetchQuote, fetchHistory, fetchHistoryCached, fetchIntraday,
         fetchScreenerData, fetchScreenerDataFinMind, preloadBundles } from './api-kline.js';
export { fetchFinMindRevenue, fetchEarningsDate, fetchFundamentals, fetchFundamentalsFromFirestore,
         fetchFundamentalsBatch, fetchHealthData, fetchChipData, fetchForeignBuyDays,
         fetchVerifyData, fetchFundSnapshot, fetchChipSnapshot } from './api-fund.js';
export { fetchNews, fetchAnnouncements } from './api-news.js';
export { fetchMisIntraday, fetchTWSEPrices, isMisCooling, misCooldownRemainSec } from './api-prices.js';
export { fetchHealthSnapshot, fetchSnapshot, fetchCondHistory, runSnapshotScreener } from './api-snapshot.js';

