/**
 * auth-gate.js — 依 tier + Firestore feature gates 動態隱藏/顯示 UI
 *
 * 預設值硬寫在 DEFAULT_GATES，管理員可在後台覆蓋到 Firestore。
 * 改完即時生效（不需 F5）。
 *
 * Gate ID 命名規則：
 *   tab_{name}         主 Tab
 *   stocktab_{name}    個股內頁 Tab
 *   el_{id}            DOM element id
 *   ind_{name}         K線工具列指標按鈕
 *   strategy_{id}      策略（由 strategy.js 讀 window.__userTier 過濾）
 *   gb_{name}          Golden Board 模組
 */

import { TIER_ORDER } from './auth-tier.js';
import { fsGetShared, fsSetShared } from './firebase.js';

// ─── 預設功能閘門（Firestore 沒設定時的 fallback）────────────────────────
export const DEFAULT_GATES = {
  // 主 Tab
  tab_theme:        'free',
  tab_portfolio:    'pro',
  tab_screener:     'pro',
  tab_pattern:      'pro',
  tab_seed:         'pro',

  // 個股內頁 Tab
  stocktab_personas:   'vvvip',  // AI 圓桌
  stocktab_resonance:  'pro',    // 多週期共振
  stocktab_analysis:   'free',   // 智能分析
  stocktab_chip:       'vvvip',  // 籌碼
  stocktab_fundamental:'free',   // 基本面
  stocktab_news:       'free',   // 新聞
  stocktab_announcement:'vvvip', // 公告
  stocktab_stockinfo:  'free',   // 補充資訊

  // 特定元素
  el_btnMonteCarlo:  'vvvip',    // 蒙地卡羅按鈕
  el_msStrategyTab:  'pro',      // 追蹤清單策略選股
  el_yaoguQuery:     'pro',      // 妖股查詢按鈕

  // K線指標按鈕
  ind_ICHI: 'free',
  ind_EMA:  'free',
  ind_BB:   'free',
  ind_ENV:  'pro',
  ind_SAR:  'pro',
  ind_GMMA: 'pro',
  ind_PVD:  'pro',
  ind_DMI:  'pro',
  ind_PSY:  'pro',
  ind_RCI:  'pro',
  ind_HV:   'pro',
};

// ─── Gate 中文說明（管理後台顯示用）────────────────────────────────────────
export const GATE_LABELS = {
  // 主 Tab
  tab_theme:        { label: '題材追蹤 Tab',     group: '主 Tab' },
  tab_portfolio:    { label: '庫存 Tab',          group: '主 Tab' },
  tab_screener:     { label: '個股篩選 Tab',      group: '主 Tab' },
  tab_pattern:      { label: '型態比對 Tab',      group: '主 Tab' },
  tab_seed:         { label: '種子選股 Tab',      group: '主 Tab' },

  // 個股內頁
  stocktab_personas:    { label: 'AI 圓桌',    group: '個股內頁' },
  stocktab_resonance:   { label: '多週期共振', group: '個股內頁' },
  stocktab_analysis:    { label: '智能分析',   group: '個股內頁' },
  stocktab_chip:        { label: '籌碼',       group: '個股內頁' },
  stocktab_fundamental: { label: '基本面',     group: '個股內頁' },
  stocktab_news:        { label: '新聞',       group: '個股內頁' },
  stocktab_announcement:{ label: '公告',       group: '個股內頁' },
  stocktab_stockinfo:   { label: '補充資訊',   group: '個股內頁' },

  // 特定功能
  el_btnMonteCarlo:   { label: '蒙地卡羅模擬',    group: '特定功能' },
  el_msStrategyTab:   { label: '追蹤清單策略選股', group: '特定功能' },
  el_yaoguQuery:      { label: '🚀 妖股查詢',      group: '特定功能' },

  // K線指標
  ind_ICHI: { label: '☁️ Ichimoku 一目均衡表', group: 'K線指標' },
  ind_EMA:  { label: 'EMA 指數移動平均',        group: 'K線指標' },
  ind_BB:   { label: 'BB 布林通道',             group: 'K線指標' },
  ind_ENV:  { label: 'ENV 包絡線',              group: 'K線指標' },
  ind_SAR:  { label: '☄️ SAR 拋物線',           group: 'K線指標' },
  ind_GMMA: { label: '🐉 GMMA 顧比均線',        group: 'K線指標' },
  ind_PVD:  { label: '📊 PVD 分價量表',         group: 'K線指標' },
  ind_DMI:  { label: '⚡ DMI 趨向指標',          group: 'K線指標' },
  ind_PSY:  { label: '🧠 PSY 心理線',           group: 'K線指標' },
  ind_RCI:  { label: '🔄 RCI 順位相關係數',      group: 'K線指標' },
  ind_HV:   { label: '📊 HV 歷史波動率',        group: 'K線指標' },
};

// ─── 目前生效的 gates（預設值 + Firestore 覆蓋）───────────────────────────
let _gates = { ...DEFAULT_GATES };
let _gatesLoaded = false;

// ─── 從 Firestore 載入 gates ───────────────────────────────────────────────
export async function loadFeatureGates() {
  try {
    const data = await fsGetShared('feature_gates/config');
    if (data && typeof data === 'object') {
      _gates = { ...DEFAULT_GATES, ...data };
    }
  } catch (e) {
    console.warn('[auth-gate] 無法讀取 feature gates，使用預設值', e);
  }
  _gatesLoaded = true;
  return _gates;
}

// ─── 儲存 gates 到 Firestore ─────────────────────────────────────────────
export async function saveFeatureGates(newGates) {
  _gates = { ...DEFAULT_GATES, ...newGates };
  await fsSetShared('feature_gates/config', _gates);
}

// ─── 取得目前 gates ───────────────────────────────────────────────────────
export function getFeatureGates() {
  return { ..._gates };
}

// ─── 主入口 ───────────────────────────────────────────────────────────────
export function applyTierGate(tier) {
  const lvl = TIER_ORDER[tier] ?? 0;

  // 判斷某 gate 是否對目前 tier 開放
  const canAccess = (gateId) => {
    const required = _gates[gateId] ?? DEFAULT_GATES[gateId] ?? 'free';
    return lvl >= (TIER_ORDER[required] ?? 1);
  };

  // ── 主 Tab Bar（桌面）────────────────────────────────
  _showTab('theme',     canAccess('tab_theme'));
  _showTab('portfolio', canAccess('tab_portfolio'));
  _showTab('screener',  canAccess('tab_screener'));
  _showTab('pattern',   canAccess('tab_pattern'));
  _showTab('seed',      canAccess('tab_seed'));

  // ── 手機底部 Tab Bar ──────────────────────────────────
  _showMobileTab('screener', canAccess('tab_screener'));
  _showMobileTab('pattern',  canAccess('tab_pattern'));
  _showMobileTab('seed',     canAccess('tab_seed'));

  // ── 個股內頁 Tab ──────────────────────────────────────
  _showStockTab('personas',     canAccess('stocktab_personas'));
  _showStockTab('resonance',    canAccess('stocktab_resonance'));
  _showStockTab('analysis',     canAccess('stocktab_analysis'));
  _showStockTab('chip',         canAccess('stocktab_chip'));
  _showStockTab('fundamental',  canAccess('stocktab_fundamental'));
  _showStockTab('news',         canAccess('stocktab_news'));
  _showStockTab('announcement', canAccess('stocktab_announcement'));
  _showStockTab('stockinfo',    canAccess('stocktab_stockinfo'));

  // ── 特定元素 ──────────────────────────────────────────
  _showEl('btnMonteCarlo',     canAccess('el_btnMonteCarlo'));
  _showEl('msStrategyTab',     canAccess('el_msStrategyTab'));
  _showEl('themeYaoguScanBtn', canAccess('el_yaoguQuery'));
  // 庫存追蹤 Modal 的策略選股 Tab（pfModal，selector 不同）
  _showElQ('[data-pf-tab="strategy"]', canAccess('el_msStrategyTab'));

  // ── K線指標按鈕 ───────────────────────────────────────
  ['ICHI','EMA','BB','ENV','SAR','GMMA','PVD','DMI','PSY','RCI','HV'].forEach(ind => {
    const visible = canAccess(`ind_${ind}`);
    document.querySelectorAll(`[data-ind="${ind}"]`).forEach(btn => {
      btn.style.display = visible ? '' : 'none';
    });
  });

  // ── 全域 tier + gates（strategy.js / theme-ui.js 等動態渲染模組讀取）──
  window.__userTier    = tier;
  window.__featureGates = { ..._gates };

  // ── 訪客重導：若當前 Tab 需要登入，切回看盤 ──────────
  const isFree = lvl >= 1;
  if (!isFree) {
    const activeTab    = document.querySelector('.main-tab.active');
    const activeDataTab = activeTab?.dataset?.tab;
    const guestOK = ['chart', 'hotgroup'];
    if (activeDataTab && !guestOK.includes(activeDataTab)) {
      document.querySelector('.main-tab[data-tab="chart"]')?.click();
    }
    const activeMobile    = document.querySelector('.tab-item.active');
    const activeMobileTab = activeMobile?.dataset?.mobileTab;
    const mobileGuestOK = ['chart', 'watchlist'];
    if (activeMobileTab && !mobileGuestOK.includes(activeMobileTab)) {
      document.querySelector('.tab-item[data-mobile-tab="chart"]')?.click();
    }
  }
}

// ─── 工具函式 ──────────────────────────────────────────────────────────────
function _showTab(dataTab, visible) {
  const btn = document.querySelector(`.main-tab[data-tab="${dataTab}"]`);
  if (btn) btn.style.display = visible ? '' : 'none';
}
function _showMobileTab(dataMobileTab, visible) {
  const btn = document.querySelector(`.tab-item[data-mobile-tab="${dataMobileTab}"]`);
  if (btn) btn.style.display = visible ? '' : 'none';
}
function _showStockTab(dataStockTab, visible) {
  const btn = document.querySelector(`.stock-tab[data-stock-tab="${dataStockTab}"]`);
  if (btn) btn.style.display = visible ? '' : 'none';
}
function _showEl(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

// _showElQ 補充（querySelector 版，給無 id 的元素用）
function _showElQ(selector, visible) {
  document.querySelectorAll(selector).forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}
