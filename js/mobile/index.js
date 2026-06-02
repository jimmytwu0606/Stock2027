/**
 * js/mobile/index.js — 手機版統一入口（第一階段）
 * main.js 在 initWatchlist() 之前呼叫這個
 * Watchlist 接管由 mobile-main.js 的 initMobilePost() 負責（在 initWatchlist 之後）
 */

import { initMobileNav, setNavDeps, openMobileStockPage, closeMobileStockPage, updateMobileStockTitle } from './mobile-nav.js';
import { initMobileWatchlist, renderMobileWatchlist } from './mobile-watchlist.js';
import { initMobileScreener } from './mobile-screener.js';
import { initMobileSettings } from './mobile-settings.js';

export async function initMobile(deps = {}) {
  const { AppState, showToast, getChineseName, fetchTWSEPrices, openSettings } = deps;

  // 1. 導航
  initMobileNav();
  setNavDeps({ AppState, showToast, getChineseName, fetchTWSEPrices });

  // 2. 自選清單：不在這裡初始化！
  //    桌機版 initWatchlist() 在 initMobile 之後才跑，會把 tabWatchlist 覆蓋
  //    改由 main.js 在 initWatchlist() 後呼叫 initMobilePost()

  // 3. 篩選頁
  initMobileScreener({ AppState, showToast, getChineseName, fetchTWSEPrices });

  // 4. 設定頁
  initMobileSettings();

  // 5. window 橋接
  window.__mobileOpenStock = (title) => openMobileStockPage(title);
  window.__mobileCloseStock = () => closeMobileStockPage();
  window.__mobileUpdateTitle = (title) => updateMobileStockTitle(title);
  window.__mobileRenderWatchlist = () => initMobileWatchlist();
}
