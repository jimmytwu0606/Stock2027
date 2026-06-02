/**
 * js/mobile/mobile-main.js
 * 手機版第二階段初始化，在 main.js 的 initWatchlist() 完成後呼叫
 * 確保桌機版 watchlist HTML 已寫入，再由手機版接管
 */

import { initMobileWatchlist } from './mobile-watchlist.js';

export async function initMobilePost() {
  if (!window.matchMedia('(max-width: 767px)').matches) return;
  await initMobileWatchlist();
}
