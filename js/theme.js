/**
 * theme.js — Phase 9 題材 Tab 核心邏輯（使用者自訂版）
 * 資料來源：IndexedDB userThemes + Firestore users/{uid}/user_themes
 * 不走 shared/themes，每人管自己的
 */

import { getUserThemes, saveUserTheme, deleteUserTheme, reorderUserThemes } from './db.js';

// ── 內部狀態 ─────────────────────────────────────────────────
let _themes        = [];
let _stockThemeMap = new Map();
let _initPromise   = null;

// ── 公開 API ─────────────────────────────────────────────────

export async function initTheme() {
  if (_initPromise) return _initPromise;
  _initPromise = _doInit();
  return _initPromise;
}

/** 重新載入（新增/刪除後呼叫）*/
export async function reloadThemes() {
  _initPromise = null;
  return initTheme();
}

export function getThemes()        { return _themes; }
export function getStockThemeMap() { return _stockThemeMap; }

export function getThemeIndexesForStock(code) {
  return [...(_stockThemeMap.get(code) ?? [])];
}

// 直接 proxy db 函式供 theme-ui.js 呼叫
export { saveUserTheme, deleteUserTheme, reorderUserThemes };

// ── 內部實作 ─────────────────────────────────────────────────

async function _doInit() {
  try {
    _themes = await getUserThemes();
  } catch (err) {
    console.error('[theme] 讀取失敗', err);
    _themes = [];
  }

  _stockThemeMap = new Map();
  _themes.forEach((theme, ti) => {
    (theme.stocks ?? []).forEach(s => {
      if (!_stockThemeMap.has(s.code)) _stockThemeMap.set(s.code, new Set());
      _stockThemeMap.get(s.code).add(ti);
    });
  });

  window.__themeData = { themes: _themes, stockThemeMap: _stockThemeMap };
  document.dispatchEvent(new CustomEvent('themeDataReady'));
}
