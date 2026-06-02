/**
 * js/mobile/index.js — 手機版統一入口
 * main.js 只 import 這一個檔案
 *
 * 職責：
 *  - 初始化所有手機版模組
 *  - 橋接 main.js 需要的 window 全域變數
 */

import { initMobileNav, openMobileStockPage, closeMobileStockPage, updateMobileStockTitle } from './mobile-nav.js';
import { initMobileWatchlist, renderMobileWatchlist } from './mobile-watchlist.js';
import { initMobileScreener } from './mobile-screener.js';
import { initMobileSettings } from './mobile-settings.js';

export async function initMobile(deps = {}) {
  const { AppState, showToast, getChineseName, fetchTWSEPrices, openSettings } = deps;

  // 1. 導航（側邊 nav + 個股全頁 + 抽屜）
  initMobileNav();

  // 2. 自選清單
  await initMobileWatchlist();

  // 3. 篩選頁
  initMobileScreener({ AppState, showToast, getChineseName, fetchTWSEPrices });

  // 4. 設定頁
  initMobileSettings();

  // 5. 掛 window 橋接，讓 main.js 的 loadStock 等函式能呼叫手機版功能
  window.__mobileOpenStock = (title) => openMobileStockPage(title);
  window.__mobileCloseStock = () => closeMobileStockPage();
  window.__mobileUpdateTitle = (title) => updateMobileStockTitle(title);
  window.__mobileRenderWatchlist = () => renderMobileWatchlist();
}
