/**
 * layout.js — Sidebar Drawer 控制
 *
 * v2：sidebar 改為抽屜式（position:fixed），不再做寬度拖曳。
 * - 漢堡按鈕 .drawer-toggle-btn 開啟
 * - overlay #sidebarOverlay 點擊關閉
 * - ESC 關閉
 * - window.__drawerOpen / __drawerClose 供外部（手機版）呼叫
 *
 * 桌機版寬度（--sidebar-w）仍從 IndexedDB 讀取，套用在 padding 上。
 * 手機版滑桿保留但改為調整 --sidebar-w（影響 .main padding）。
 */

import { getConfig, setConfig } from './db.js';

const DEFAULT_W = 240;
const MIN_WIDTH  = 180;
const MAX_WIDTH  = 480;

let _sidebar = null;
let _overlay = null;

// ─── 初始化 ──────────────────────────────────────────────────────────────

export async function initLayout() {
  _sidebar = document.getElementById('sidebar');
  _overlay = document.getElementById('sidebarOverlay');
  const toggleBtn = document.querySelector('.drawer-toggle-btn');

  if (!_sidebar) return;

  // 讀取已儲存寬度，套用到 --sidebar-w
  const saved = await getConfig('sidebarWidth', DEFAULT_W);
  _applyWidth(saved);

  // 漢堡按鈕
  toggleBtn?.addEventListener('click', openDrawer);

  // Overlay 點擊關閉
  _overlay?.addEventListener('click', closeDrawer);

  // ESC 關閉
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // 手機滑桿（設定抽屜裡，調整 --sidebar-w）
  _bindMobileSlider();

  // expose 給外部（main.js _toggleMobileSidebar）
  window.__drawerOpen  = openDrawer;
  window.__drawerClose = closeDrawer;
  window.__drawerToggle = () =>
    _sidebar.classList.contains('drawer-open') ? closeDrawer() : openDrawer();
}

// ─── 開 / 關 ──────────────────────────────────────────────────────────────

export function openDrawer() {
  _sidebar?.classList.add('drawer-open');
  _overlay?.classList.add('visible');
}

export function closeDrawer() {
  _sidebar?.classList.remove('drawer-open');
  _overlay?.classList.remove('visible');
}

// ─── 套用寬度（--sidebar-w） ─────────────────────────────────────────────

function _applyWidth(px) {
  const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px));
  document.documentElement.style.setProperty('--sidebar-w', `${clamped}px`);

  // 同步手機滑桿
  const slider = document.getElementById('sidebarWidthSlider');
  if (slider) {
    const pct = Math.round((clamped / window.innerWidth) * 100);
    slider.value = pct;
    _updateSliderLabel(pct);
  }
}

async function _saveWidth(px) {
  _applyWidth(px);
  await setConfig('sidebarWidth', px);
}

// ─── 手機百分比滑桿 ───────────────────────────────────────────────────────

function _bindMobileSlider() {
  const slider = document.getElementById('sidebarWidthSlider');
  if (!slider) return;

  slider.addEventListener('input', () => {
    const pct = parseInt(slider.value, 10);
    const px  = Math.round(window.innerWidth * pct / 100);
    _applyWidth(px);
    _updateSliderLabel(pct);
  });

  slider.addEventListener('change', async () => {
    const current = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')
    ) || DEFAULT_W;
    await _saveWidth(current);
  });
}

function _updateSliderLabel(pct) {
  const label = document.getElementById('sidebarWidthLabel');
  if (label) label.textContent = `${pct}%`;
}
