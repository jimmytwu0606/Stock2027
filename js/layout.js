/**
 * layout.js — Sidebar 寬度調整
 *
 * 桌面版：拖曳 #sidebarResizer 分隔線調整 sidebar 寬度（150–480px）
 * 手機版：設定抽屜中提供百分比滑桿（25%–60%，相對視窗寬度）
 * 持久化：setConfig('sidebarWidth', px) via IndexedDB
 */

import { getConfig, setConfig } from './db.js';

const MIN_WIDTH  = 150;
const MAX_WIDTH  = 480;
const DEFAULT_W  = 260;

let _sidebar   = null;
let _resizer   = null;
let _isDesktop = () => window.innerWidth > 768;

// ─── 初始化 ────────────────────────────────────────────────────────────────

export async function initLayout() {
  _sidebar = document.getElementById('sidebar');
  _resizer = document.getElementById('sidebarResizer');
  if (!_sidebar) return;

  // 讀取已儲存寬度
  const saved = await getConfig('sidebarWidth', DEFAULT_W);
  _applyWidth(saved);

  if (_resizer) _bindDesktopDrag();
  _bindMobileSlider();
  _bindWindowResize();
}

// ─── 套用寬度 ──────────────────────────────────────────────────────────────

function _applyWidth(px) {
  const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px));

  // 更新 :root 的 --sidebar-w，main.css grid-template-columns 自動響應
  document.documentElement.style.setProperty('--sidebar-w', `${clamped}px`);

  // 同步手機滑桿（若存在）
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

// ─── 桌面拖曳 ──────────────────────────────────────────────────────────────

function _bindDesktopDrag() {
  let dragging  = false;
  let startX    = 0;
  let startW    = 0;

  _resizer.addEventListener('mousedown', (e) => {
    if (!_isDesktop()) return;
    dragging = true;
    startX   = e.clientX;
    startW   = _sidebar.offsetWidth;
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW  = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + delta));
    _applyWidth(newW);
  });

  document.addEventListener('mouseup', async () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    // 從 CSS 變數讀回目前寬度
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || DEFAULT_W;
    await _saveWidth(current);
  });

  // 觸控支援（平板）
  _resizer.addEventListener('touchstart', (e) => {
    if (!_isDesktop()) return;
    dragging = true;
    startX   = e.touches[0].clientX;
    startW   = _sidebar.offsetWidth;
    document.body.classList.add('resizing');
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const delta = e.touches[0].clientX - startX;
    const newW  = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + delta));
    _applyWidth(newW);
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || DEFAULT_W;
    await _saveWidth(current);
  });
}

// ─── 手機百分比滑桿 ────────────────────────────────────────────────────────

function _bindMobileSlider() {
  const slider = document.getElementById('sidebarWidthSlider');
  if (!slider) return;

  slider.addEventListener('input', () => {
    const pct  = parseInt(slider.value, 10);
    const px   = Math.round(window.innerWidth * pct / 100);
    _applyWidth(px);
    _updateSliderLabel(pct);
  });

  slider.addEventListener('change', async () => {
    await _saveWidth(_sidebar.offsetWidth);
  });
}

function _updateSliderLabel(pct) {
  const label = document.getElementById('sidebarWidthLabel');
  if (label) label.textContent = `${pct}%`;
}

// ─── 視窗 resize 保護 ─────────────────────────────────────────────────────

function _bindWindowResize() {
  window.addEventListener('resize', () => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || DEFAULT_W;
    if (current < MIN_WIDTH || current > MAX_WIDTH) _applyWidth(DEFAULT_W);
  });
}
