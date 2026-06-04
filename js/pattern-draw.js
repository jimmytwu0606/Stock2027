/**
 * pattern-draw.js — Phase 3 型態輸入 UI
 * 職責：
 *   1. 手繪模式：Canvas 折線手繪，轉換為虛擬 Candle[]
 *   2. 圖片模式：顯示/隱藏 pdImageWrap，切換交由本模組統一管理
 * （框選模式已移除，main.js 已不再發 patternRangeSelect）
 * 依賴：state.js（AppState）、pattern.js（describePattern、normalizeSeries）
 * 對外暴露：initPatternDraw()
 */

import { AppState } from './state.js';
import { describePattern, normalizeSeries } from './pattern.js';

// ─── 模組狀態 ──────────────────────────────────────────────
let drawMode   = 'draw';   // 'draw' | 'image'
let isDrawing  = false;
let drawPoints = [];        // [{ x, y }, ...]

// ─── 初始化 ────────────────────────────────────────────────
export function initPatternDraw() {
  _bindModeSwitch();
  _bindDrawMode();
  _bindConfirmBtn();
  _bindSimilaritySlider();
  // 預設進入手繪模式
  _enterDrawMode();
}

// ─── 模式切換（手繪 ↔ 圖片） ──────────────────────────────
function _bindModeSwitch() {
  document.querySelectorAll('.pd-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === drawMode) return;
      drawMode = mode;

      document.querySelectorAll('.pd-mode-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );

      if (mode === 'draw') {
        _enterDrawMode();
      } else if (mode === 'image') {
        _enterImageMode();
      }
    });
  });
}

function _enterDrawMode() {
  drawMode = 'draw';
  // 更新 active（預設進入時也要設）
  document.querySelectorAll('.pd-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === 'draw')
  );

  const drawWrap   = document.getElementById('pdDrawWrap');
  const imageWrap  = document.getElementById('pdImageWrap');
  const meta       = document.getElementById('pdMeta');
  const confirmBtn = document.getElementById('pdConfirmBtn');

  if (drawWrap)   drawWrap.style.display   = '';
  if (imageWrap)  imageWrap.style.display  = 'none';
  if (meta)       meta.textContent = '在下方畫布上繪製理想走勢';
  if (confirmBtn) confirmBtn.style.display = '';

  _initDrawCanvas();
}

function _enterImageMode() {
  drawMode = 'image';

  const drawWrap   = document.getElementById('pdDrawWrap');
  const imageWrap  = document.getElementById('pdImageWrap');
  const meta       = document.getElementById('pdMeta');
  const preview    = document.getElementById('pdPreview');
  const confirmBtn = document.getElementById('pdConfirmBtn');

  if (drawWrap)   drawWrap.style.display   = 'none';
  if (imageWrap)  imageWrap.style.display  = '';
  if (meta)       meta.style.display       = 'none';
  if (preview)    preview.style.display    = 'none';
  if (confirmBtn) confirmBtn.style.display = 'none';
}

// ─── 手繪模式：綁清除按鈕 ─────────────────────────────────
function _bindDrawMode() {
  document.addEventListener('click', e => {
    if (!e.target.closest('#pdClearBtn')) return;
    drawPoints = [];
    const canvas = document.getElementById('pdCanvas');
    if (canvas) _clearCanvas(canvas.getContext('2d'), canvas);
    _setConfirmEnabled(false);
    AppState.pattern.template = null;
    const preview = document.getElementById('pdPreview');
    if (preview) preview.style.display = 'none';
  });
}

// ─── Canvas 初始化（切換到手繪模式時呼叫） ────────────────
function _initDrawCanvas() {
  const canvas = document.getElementById('pdCanvas');
  if (!canvas) return;

  // clone 節點以清除舊事件
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);

  const wrap = document.getElementById('pdDrawWrap');
  newCanvas.width  = wrap ? (wrap.clientWidth - 28 || 560) : 560;
  newCanvas.height = 140;

  const ctx = newCanvas.getContext('2d');
  _clearCanvas(ctx, newCanvas);

  // 滑鼠
  newCanvas.addEventListener('mousedown', e => {
    isDrawing  = true;
    drawPoints = [_pt(newCanvas, e)];
  });
  newCanvas.addEventListener('mousemove', e => {
    if (!isDrawing) return;
    drawPoints.push(_pt(newCanvas, e));
    _redrawLines(ctx, newCanvas, drawPoints);
  });
  newCanvas.addEventListener('mouseup',    () => { if (isDrawing) { isDrawing = false; _onDrawEnd(newCanvas); } });
  newCanvas.addEventListener('mouseleave', () => { if (isDrawing) { isDrawing = false; _onDrawEnd(newCanvas); } });

  // 觸控
  newCanvas.addEventListener('touchstart', e => {
    e.preventDefault();
    isDrawing  = true;
    drawPoints = [_ptTouch(newCanvas, e.touches[0])];
  }, { passive: false });
  newCanvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!isDrawing) return;
    drawPoints.push(_ptTouch(newCanvas, e.touches[0]));
    _redrawLines(ctx, newCanvas, drawPoints);
  }, { passive: false });
  newCanvas.addEventListener('touchend', () => {
    if (isDrawing) { isDrawing = false; _onDrawEnd(newCanvas); }
  });
}

function _onDrawEnd(canvas) {
  if (drawPoints.length < 5) return;
  const template = _drawPointsToCandles(drawPoints, canvas.width, canvas.height);
  AppState.pattern.template = template;
  _updatePreview(template);
  _setConfirmEnabled(true);
  const meta = document.getElementById('pdMeta');
  if (meta) {
    const desc = describePattern(template);
    meta.textContent = `手繪 ${template.length} 根・${desc.label}`;
  }
  // 通知 toolbar 有新範本
  document.dispatchEvent(new CustomEvent('patternTemplateReady'));
}

// ─── 座標工具 ──────────────────────────────────────────────
function _pt(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function _ptTouch(canvas, touch) {
  const r = canvas.getBoundingClientRect();
  return { x: touch.clientX - r.left, y: touch.clientY - r.top };
}

// ─── Canvas 繪製 ───────────────────────────────────────────
function _clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 1;
  for (let y = 0; y <= canvas.height; y += 35) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function _redrawLines(ctx, canvas, points) {
  _clearCanvas(ctx, canvas);
  if (points.length < 2) return;
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.fillStyle = '#3b82f6';
  [points[0], points[points.length - 1]].forEach(p => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  });
}

function _drawPointsToCandles(points, width, height) {
  const sampled = _downsample(points, 40);
  const now     = Math.floor(Date.now() / 1000);
  return sampled.map((pt, i) => {
    const close = ((height - pt.y) / height) * 100;
    return {
      time:   now - (sampled.length - 1 - i) * 86400,
      open:   close, high: close + 0.5, low: close - 0.5, close,
      volume: 1000,
    };
  });
}

function _downsample(points, maxLen) {
  if (points.length <= maxLen) return points;
  const step = points.length / maxLen;
  return Array.from({ length: maxLen }, (_, i) => points[Math.round(i * step)]);
}

// ─── 型態預覽 ──────────────────────────────────────────────
function _updatePreview(candles) {
  const wrap   = document.getElementById('pdPreview');
  const canvas = document.getElementById('pdPreviewCanvas');
  const tags   = document.getElementById('pdPreviewTags');
  if (!wrap || !canvas || !tags) return;

  wrap.style.display = '';
  canvas.width  = (canvas.parentElement?.clientWidth ?? 280) - 20;
  canvas.height = 64;

  const ctx  = canvas.getContext('2d');
  const w    = canvas.width;
  const h    = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const norm = normalizeSeries(candles.map(c => c.close));
  const n    = norm.length;

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  norm.forEach((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * (w - 4) + 2 : w / 2;
    const y = h - 4 - v * (h - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = 'rgba(59,130,246,0.1)';
  ctx.beginPath();
  norm.forEach((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * (w - 4) + 2 : w / 2;
    const y = h - 4 - v * (h - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(w - 2, h - 4); ctx.lineTo(2, h - 4); ctx.closePath(); ctx.fill();

  const desc = describePattern(candles);
  tags.innerHTML = `
    <span class="pd-tag">${desc.label}</span>
    <span class="pd-tag pd-tag--muted">${desc.volatility}</span>
    <span class="pd-tag ${Number(desc.chgPct) >= 0 ? 'pd-tag--up' : 'pd-tag--down'}">
      ${Number(desc.chgPct) >= 0 ? '+' : ''}${desc.chgPct}%
    </span>
    <span class="pd-tag pd-tag--muted">${candles.length} 根</span>
  `;
}

// ─── 確認按鈕（新架構：只更新 chip，不直接觸發掃描） ────
function _bindConfirmBtn() {
  // pdConfirmBtn 已移除（新架構用 pdModalStart / pdScanBtn）
  // 保留此函式避免呼叫端報錯
}

// 對外暴露：型態確認後通知 toolbar 更新
export function notifyTemplateReady() {
  document.dispatchEvent(new CustomEvent('patternTemplateReady'));
}

// ─── 相似度滑桿 ────────────────────────────────────────────
function _bindSimilaritySlider() {
  document.getElementById('pdSimilarity')?.addEventListener('input', e => {
    const display = document.getElementById('pdSimilarityVal');
    if (display) display.textContent = e.target.value + '%';
  });
}

// ─── 「從選股結果掃描」勾選時更新計數 ──────────────────────
export function updateScreenerCount() {
  const count = AppState.screener?.results?.length || 0;
  const el    = document.getElementById('pdScreenerCount');
  const cb    = document.getElementById('pdFromScreener');
  if (!el) return;
  if (count > 0) {
    el.textContent = `${count} 檔`;
    if (cb) cb.disabled = false;
  } else {
    el.textContent = '';
    if (cb) { cb.checked = false; cb.disabled = true; }
  }
}

// ─── 內部工具 ──────────────────────────────────────────────
function _setConfirmEnabled(enabled) {
  const btn = document.getElementById('pdConfirmBtn');
  if (btn) btn.disabled = !enabled;
}
