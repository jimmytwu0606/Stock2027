/**
 * pattern-draw.js — Phase 3 型態輸入 UI
 * 職責：
 *   1. 框選模式：監聽 patternRangeSelect 事件，擷取 AppState.lastCandles 子集
 *   2. 手繪模式：Canvas 折線手繪，轉換為虛擬 Candle[]
 * 依賴：state.js（AppState）、pattern.js（describePattern、normalizeSeries）
 * 對外暴露：initPatternDraw()
 *
 * 注意：HTML 結構已寫在 index.html 的 #patternDrawPanel，
 *       本模組只負責綁事件，不重建 innerHTML。
 */

import { AppState } from './state.js';
import { describePattern, normalizeSeries } from './pattern.js';

// ─── 模組狀態 ──────────────────────────────────────────────
let drawMode   = 'select';  // 'select' | 'draw'
let isDrawing  = false;
let drawPoints = [];        // [{ x, y }, ...]

// ─── 初始化 ────────────────────────────────────────────────
export function initPatternDraw() {
  _bindModeSwitch();
  _bindSelectMode();
  _bindDrawMode();
  _bindConfirmBtn();
  _bindSimilaritySlider();
}

// ─── 模式切換（框選 ↔ 手繪） ──────────────────────────────
function _bindModeSwitch() {
  document.querySelectorAll('.pd-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      drawMode = btn.dataset.mode;

      document.querySelectorAll('.pd-mode-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );

      const selectHint = document.getElementById('pdSelectHint');
      const drawWrap   = document.getElementById('pdDrawWrap');
      const meta       = document.getElementById('pdMeta');

      if (drawMode === 'select') {
        if (selectHint) selectHint.style.display = '';
        if (drawWrap)   drawWrap.style.display   = 'none';
        if (meta)       meta.textContent =
          '切換到「看盤」Tab，點擊「框選型態」後拖曳選取 K 線區間';
      } else {
        if (selectHint) selectHint.style.display = 'none';
        if (drawWrap)   drawWrap.style.display   = '';
        if (meta)       meta.textContent = '在下方畫布上繪製理想走勢';
        _initDrawCanvas();
      }
    });
  });
}

// ─── 框選模式：監聽來自 main.js 的 patternRangeSelect 事件 ─
function _bindSelectMode() {
  document.addEventListener('patternRangeSelect', e => {
    const { startIdx, endIdx } = e.detail;
    const candles = AppState.lastCandles;
    if (!candles || !candles.length) return;

    const selected = candles.slice(startIdx, endIdx + 1);
    const len      = selected.length;

    const info = document.getElementById('pdSelectInfo');
    if (info) info.textContent = `已選 ${len} 根 K 棒`;

    const meta = document.getElementById('pdMeta');
    const desc = describePattern(selected);
    if (meta) meta.textContent = `選取 ${len} 根・${desc.label}・${desc.volatility}`;

    _updatePreview(selected);
    _setConfirmEnabled(len >= 5);
    AppState.pattern.template = selected;
  });
}

// ─── 手繪模式：綁清除按鈕（Canvas 事件在切換時才初始化） ──
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

// ─── 確認按鈕 ──────────────────────────────────────────────
function _bindConfirmBtn() {
  document.getElementById('pdConfirmBtn')?.addEventListener('click', () => {
    const template = AppState.pattern.template;
    if (!template || template.length < 5) return;
    AppState.pattern.similarity  = parseInt(document.getElementById('pdSimilarity')?.value  ?? 75);
    AppState.pattern.windowSize  = parseInt(document.getElementById('pdWindow')?.value       ?? 20);
    AppState.pattern.featureMode = document.getElementById('pdFeatureMode')?.value ?? 'simple';
    document.dispatchEvent(new CustomEvent('patternScanStart', { detail: { template } }));
  });
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
