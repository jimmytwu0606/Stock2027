// js/chart-edit.js
// ============================================================================
// Phase 7.1 — K 線編輯模式主控(升級版)
// ============================================================================
// Phase 7.1 變更:
//   A1. 工具列改浮動定位(疊在 K 線左上,不擠壓 K 線)
//   A2. 端點獨立拖動(可旋轉/縮放單一標註)
//   A3. 磁吸 K 棒 OHLC(8px 內吸到 open/high/low/close)
//   A4. 跨週期座標修正(time 優先 → logical fallback)
//   A5. 即時座標提示(浮層顯示 OHLCV)
//
// 對外 API(不變):
//   initChartEdit({ chartContainer, getChart, getSeries, getCode, getCandles, onReloadChart })
//   enterEditMode() / exitEditMode() / isEditing()
//   loadAnnotationsForCode(code)
//   reattachAfterReload()
//
// ⚠ 新增依賴:getCandles → 提供當前 candles 給磁吸跟提示用
// ============================================================================

import { initOverlay } from './canvas-overlay.js';
import { AppState }    from './state.js';
import { saveAnnotation, loadAnnotation, deleteAnnotation } from './db.js';

// ---------- 工具定義 ----------
const TOOLS = {
  select: { icon: '↖', label: '選取',   needPoints: 0 },
  line:   { icon: '╱', label: '趨勢線', needPoints: 2 },
  hline:  { icon: '━', label: '水平線', needPoints: 1 },
  vline:  { icon: '│', label: '垂直線', needPoints: 1 },
  rect:   { icon: '▭', label: '矩形',   needPoints: 2 },
  text:   { icon: 'T', label: '文字',   needPoints: 1 },
};

const DEFAULT_COLOR = {
  line:  '#3b82f6',
  hline: '#26a69a',
  vline: '#a78bfa',
  rect:  '#f59e0b',
  text:  '#e8eaed',
};

const HIT_THRESHOLD     = 6;
const ENDPOINT_RADIUS   = 8;     // A2 端點命中範圍
const SNAP_PX           = 8;     // A3 磁吸範圍(桌機)
const SNAP_PX_MOBILE    = 12;    // A3 磁吸範圍(手機)
const DEBOUNCE_SAVE_MS  = 500;

// ---------- 模組狀態 ----------
let overlay = null;
let editing = false;
let activeTool = 'select';
let annotations = [];
let undoStack = [];
let selectedId = null;
let draggingId = null;
let draggingEndpoint = null;    // A2 拖動的是哪個端點 ({ id, index })
let dragOffset = null;
let drawingTemp = null;
let saveTimer = null;
let savedIndicatorState = null;
let snapEnabled = true;          // A3 磁吸開關
let shiftHeld = false;           // A3 Shift = 暫時關磁吸
let lastSnap = null;             // A3 目前吸附位置
let hoverInfo = null;            // A5 滑鼠 hover 的 OHLCV
let coordPanelEl = null;         // A5 浮層元素

let ctxRefs = null;
let toolbarEl = null;

// ============================================================================
// 對外初始化
// ============================================================================
export function initChartEdit({ chartContainer, getChart, getSeries, getCode, getCandles, onReloadChart,
                                getMacdChart, getMacdChartEl, getKdChart, getKdChartEl, getRsiChart, getRsiChartEl }) {
  if (!chartContainer) {
    console.warn('[chart-edit] no chartContainer, abort init');
    return;
  }
  ctxRefs = { chartContainer, getChart, getSeries, getCode, getCandles, onReloadChart,
              getMacdChart, getMacdChartEl, getKdChart, getKdChartEl, getRsiChart, getRsiChartEl };
  _injectToolbar();
  _injectCoordPanel();
  _bindGlobalKeys();
}

// ============================================================================
// 模式切換
// ============================================================================
export function enterEditMode() {
  if (!ctxRefs) { console.warn('[chart-edit] not initialized'); return; }
  if (editing) return;
  editing = true;

  _hideIndicators(true);
  window.dispatchEvent(new CustomEvent('chartReload'));

  const attach = () => {
    if (!editing) return;
    _createOverlay();
    const code = ctxRefs.getCode?.();
    if (code) loadAnnotationsForCode(code);
    window.removeEventListener('chartRendered', attach);
  };
  window.addEventListener('chartRendered', attach, { once: true });
  setTimeout(() => {
    if (editing && !overlay) attach();
  }, 200);

  _showToolbar(true);
  ctxRefs.chartContainer.classList.add('chart-edit-active');

  window.dispatchEvent(new CustomEvent('chartEditModeChanged', { detail: { editing: true } }));
}

export function exitEditMode() {
  if (!editing) return;
  editing = false;

  _flushSave();

  if (overlay) { try { overlay.destroy(); } catch {} overlay = null; }

  _hideIndicators(false);
  window.dispatchEvent(new CustomEvent('chartReload'));

  _showToolbar(false);
  _hideCoordPanel();
  ctxRefs.chartContainer.classList.remove('chart-edit-active');

  drawingTemp = null;
  draggingId = null;
  draggingEndpoint = null;
  dragOffset = null;
  selectedId = null;
  lastSnap = null;
  activeTool = 'select';
  _updateToolbarUI();

  window.dispatchEvent(new CustomEvent('chartEditModeChanged', { detail: { editing: false } }));
}

export function isEditing() { return editing; }

function _createOverlay() {
  if (overlay) { try { overlay.destroy(); } catch {} overlay = null; }
  overlay = initOverlay(ctxRefs.chartContainer, { mode: 'edit', id: 'overlay-edit' });
  const chart  = ctxRefs.getChart?.();
  const series = ctxRefs.getSeries?.();
  if (chart && series) overlay.setChart(chart, series);
  overlay.enable();
  overlay.on('mousedown', _onMouseDown);
  overlay.on('mousemove', _onMouseMove);
  overlay.on('mouseup',   _onMouseUp);
  overlay.on('dblclick',  _onDblClick);
  overlay.on('leave',     _onLeave);
  overlay.render(_drawAll);
}

export function reattachAfterReload() {
  if (!editing || !overlay) return;
  const chart  = ctxRefs.getChart?.();
  const series = ctxRefs.getSeries?.();
  if (chart && series) overlay.setChart(chart, series);
  overlay.requestRender();
}

// ============================================================================
// 標註資料管理
// ============================================================================
export async function loadAnnotationsForCode(code) {
  if (!code) {
    annotations = []; undoStack = [];
    if (editing) overlay?.requestRender();
    return;
  }
  try {
    const data = await loadAnnotation(code);
    annotations = Array.isArray(data?.lines) ? data.lines : [];
  } catch (e) {
    console.warn('[chart-edit] loadAnnotation failed', e);
    annotations = [];
  }
  undoStack = [];
  selectedId = null;
  if (editing) overlay?.requestRender();
}

export function getAnnotations() {
  return annotations.slice();
}

// ============================================================================
// 繪製
// ============================================================================
function _drawAll(ctx, h) {
  // A3:繪製磁吸提示點
  if (lastSnap && editing && activeTool !== 'select') {
    _drawSnapIndicator(ctx, lastSnap);
  }

  if (!annotations.length && !drawingTemp) return;
  for (const a of annotations) _drawAnnotation(ctx, h, a, a.id === selectedId);
  if (drawingTemp) _drawAnnotation(ctx, h, drawingTemp, false);
}

function _drawAnnotation(ctx, h, a, isSelected) {
  ctx.save();
  ctx.lineWidth = (a.width || 1.5) + (isSelected ? 1 : 0);
  ctx.strokeStyle = a.color || DEFAULT_COLOR[a.type] || '#3b82f6';
  ctx.fillStyle   = a.color || DEFAULT_COLOR[a.type] || '#3b82f6';
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  const W = h.width, H = h.height;
  const pts = (a.points || []).map(p => _pointToXY(h, p));

  if (a.type === 'line' && pts.length >= 2 && pts[0] && pts[1]) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
    if (isSelected) _drawHandles(ctx, pts);
  } else if (a.type === 'hline' && pts[0]) {
    ctx.beginPath();
    ctx.moveTo(0, pts[0].y);
    ctx.lineTo(W, pts[0].y);
    ctx.stroke();
    _drawPriceLabel(ctx, W - 4, pts[0].y, a.points[0].price, a.color || DEFAULT_COLOR.hline);
    if (isSelected) _drawHandles(ctx, [{ x: W / 2, y: pts[0].y }]);
  } else if (a.type === 'vline' && pts[0]) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, 0);
    ctx.lineTo(pts[0].x, H);
    ctx.stroke();
    if (isSelected) _drawHandles(ctx, [{ x: pts[0].x, y: H / 2 }]);
  } else if (a.type === 'rect' && pts.length >= 2 && pts[0] && pts[1]) {
    const x = Math.min(pts[0].x, pts[1].x);
    const y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x);
    const hh = Math.abs(pts[1].y - pts[0].y);
    ctx.strokeRect(x, y, w, hh);
    ctx.globalAlpha = 0.08;
    ctx.fillRect(x, y, w, hh);
    ctx.globalAlpha = 1;
    if (isSelected) {
      // 四個角的端點(A2 可獨立拖)
      _drawHandles(ctx, [
        { x: pts[0].x, y: pts[0].y },
        { x: pts[1].x, y: pts[0].y },
        { x: pts[1].x, y: pts[1].y },
        { x: pts[0].x, y: pts[1].y },
      ]);
    }
  } else if (a.type === 'text' && pts[0]) {
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    const txt = a.label || '標註';
    const m = ctx.measureText(txt);
    const padX = 6, padY = 4;
    const bx = pts[0].x, by = pts[0].y;
    ctx.fillStyle = 'rgba(28, 31, 36, 0.92)';
    ctx.fillRect(bx, by - 9, m.width + padX * 2, 18 + padY);
    ctx.strokeStyle = a.color || DEFAULT_COLOR.text;
    ctx.strokeRect(bx, by - 9, m.width + padX * 2, 18 + padY);
    ctx.fillStyle = a.color || DEFAULT_COLOR.text;
    ctx.fillText(txt, bx + padX, by);
    if (isSelected) _drawHandles(ctx, [pts[0]]);
  }
  ctx.restore();
}

function _drawHandles(ctx, pts) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  for (const p of pts) {
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function _drawPriceLabel(ctx, x, y, price, color) {
  if (price == null) return;
  ctx.save();
  ctx.font = '11px system-ui';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const txt = (+price).toFixed(2);
  const m = ctx.measureText(txt);
  ctx.fillStyle = color;
  ctx.fillRect(x - m.width - 6, y - 8, m.width + 6, 16);
  ctx.fillStyle = '#fff';
  ctx.fillText(txt, x - 3, y);
  ctx.restore();
}

// A3: 磁吸指示點
function _drawSnapIndicator(ctx, snap) {
  ctx.save();
  ctx.fillStyle = '#22c55e';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(snap.x, snap.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 標籤
  ctx.font = '11px system-ui';
  ctx.fillStyle = 'rgba(28, 31, 36, 0.92)';
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1;
  const text = `${snap.field} ${snap.price.toFixed(2)}`;
  const m = ctx.measureText(text);
  const labelX = snap.x + 10, labelY = snap.y - 18;
  ctx.fillRect(labelX, labelY - 8, m.width + 10, 16);
  ctx.strokeRect(labelX, labelY - 8, m.width + 10, 16);
  ctx.fillStyle = '#22c55e';
  ctx.fillText(text, labelX + 5, labelY + 4);
  ctx.restore();
}

// ============================================================================
// 座標轉換(A4 跨週期穩定)
// ============================================================================
// X 軸:time 優先(跨週期穩定),logical fallback
// Y 軸:price
function _pointToXY(h, p) {
  if (!p) return null;
  let x = null, y = null;
  if (p.time != null) x = h.timeToX(p.time);
  if ((x == null) && p.logical != null) x = h.logicalToX(p.logical);
  if (p.price != null) y = h.priceToY(p.price);
  if (x == null || y == null) return null;
  return { x, y };
}

// 反向:pixel → 標註座標(寫入時 time + logical + price 都記)
function _xyToPoint(h, x, y) {
  return {
    time:    h.xToTime(x),
    logical: h.xToLogical(x),
    price:   h.yToPrice(y),
  };
}

// ============================================================================
// 事件處理
// ============================================================================
function _onMouseDown(e) {
  // A3 磁吸點優先
  const pos = _maybeSnap(e);

  if (activeTool === 'select') {
    // A2 先檢查是否點到端點(優先級高於整體拖動)
    const endpointHit = _hitEndpoint(e);
    if (endpointHit) {
      selectedId = endpointHit.id;
      draggingEndpoint = endpointHit;
      dragOffset = { x: pos.x, y: pos.y };
      _pushUndo();
      overlay.requestRender();
      return;
    }
    // 否則嘗試整體拖動
    const hit = _hitTest(e);
    selectedId = hit ? hit.id : null;
    if (hit) {
      draggingId = hit.id;
      dragOffset = { x: pos.x, y: pos.y };
      _pushUndo();
    }
    overlay.requestRender();
    return;
  }

  // 繪製工具
  const id = _uuid();
  const now = Date.now();
  const p0 = _xyToPoint(overlay, pos.x, pos.y);
  // 若磁吸命中,覆蓋 price 為精確值
  if (pos.snap) p0.price = pos.snap.price;
  drawingTemp = {
    id, type: activeTool,
    points: [p0],
    color: DEFAULT_COLOR[activeTool],
    width: 1.5,
    label: activeTool === 'text' ? '' : undefined,
    created_at: now, updated_at: now,
  };
  if (TOOLS[activeTool].needPoints === 1) {
    _commitDrawing();
  }
  overlay.requestRender();
}

function _onMouseMove(e) {
  // A5 即時座標提示
  _updateCoordPanel(e);

  // A3 磁吸偵測(僅繪製工具)
  if (activeTool !== 'select' && editing) {
    lastSnap = _findNearestSnap(e);
  } else {
    lastSnap = null;
  }

  // 端點獨立拖
  if (draggingEndpoint) {
    const anno = annotations.find(a => a.id === draggingEndpoint.id);
    if (!anno) return;
    const pos = _maybeSnap(e);
    const newPoint = _xyToPoint(overlay, pos.x, pos.y);
    if (pos.snap) newPoint.price = pos.snap.price;
    anno.points[draggingEndpoint.index] = newPoint;
    anno.updated_at = Date.now();
    overlay.requestRender();
    _scheduleSave();
    return;
  }

  // 整體拖動
  if (draggingId) {
    const anno = annotations.find(a => a.id === draggingId);
    if (!anno) return;
    const dx = e.x - dragOffset.x;
    const dy = e.y - dragOffset.y;
    dragOffset = { x: e.x, y: e.y };
    _shiftAnnotation(anno, dx, dy);
    overlay.requestRender();
    _scheduleSave();
    return;
  }

  // 繪製中的第二點
  if (drawingTemp && TOOLS[drawingTemp.type].needPoints === 2) {
    const pos = _maybeSnap(e);
    const p1 = _xyToPoint(overlay, pos.x, pos.y);
    if (pos.snap) p1.price = pos.snap.price;
    drawingTemp.points[1] = p1;
    overlay.requestRender();
  }

  overlay.requestRender();
}

function _onMouseUp() {
  if (draggingEndpoint) {
    draggingEndpoint = null;
    dragOffset = null;
    return;
  }
  if (draggingId) {
    draggingId = null;
    dragOffset = null;
    return;
  }
  if (drawingTemp && TOOLS[drawingTemp.type].needPoints === 2) {
    if (drawingTemp.points[1]) _commitDrawing();
    else { drawingTemp = null; overlay.requestRender(); }
  }
}

function _onDblClick(e) {
  const hit = _hitTest(e);
  if (hit && hit.type === 'text') {
    const newLabel = prompt('編輯標註文字', hit.label || '');
    if (newLabel !== null) {
      _pushUndo();
      hit.label = newLabel;
      hit.updated_at = Date.now();
      _scheduleSave();
      overlay.requestRender();
    }
  }
}

function _onLeave() {
  hoverInfo = null;
  lastSnap = null;
  _hideCoordPanel();
  overlay?.requestRender();
}

function _commitDrawing() {
  if (!drawingTemp) return;
  if (drawingTemp.type === 'text') {
    const txt = prompt('輸入文字標註', '');
    if (txt == null || txt.trim() === '') {
      drawingTemp = null; overlay.requestRender(); return;
    }
    drawingTemp.label = txt.trim();
  }
  _pushUndo();
  annotations.push(drawingTemp);
  drawingTemp = null;
  setActiveTool('select');
  _scheduleSave();
  overlay.requestRender();
}

// ============================================================================
// A2: 端點命中測試
// ============================================================================
function _hitEndpoint(e) {
  if (!overlay) return null;
  const h = overlay;
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.id !== selectedId) continue;  // 只有選中的才檢查端點
    const eps = _getEndpoints(h, a);
    for (let j = 0; j < eps.length; j++) {
      const p = eps[j];
      if (!p) continue;
      if (Math.hypot(p.x - e.x, p.y - e.y) < ENDPOINT_RADIUS) {
        return { id: a.id, index: p.index, type: a.type };
      }
    }
  }
  return null;
}

function _getEndpoints(h, a) {
  const out = [];
  const pts = (a.points || []).map(p => _pointToXY(h, p));
  if (a.type === 'line' && pts[0] && pts[1]) {
    out.push({ ...pts[0], index: 0 });
    out.push({ ...pts[1], index: 1 });
  } else if (a.type === 'rect' && pts[0] && pts[1]) {
    // 矩形 4 角 = 兩個 point 的組合
    out.push({ x: pts[0].x, y: pts[0].y, index: 0 });
    out.push({ x: pts[1].x, y: pts[1].y, index: 1 });
    // (中間兩個角是組合出來的,目前只支援拖兩個 point;簡化版)
  }
  return out;
}

// ============================================================================
// 一般命中測試
// ============================================================================
function _hitTest(e) {
  if (!overlay) return null;
  const h = overlay;
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (_hitOne(h, a, e.x, e.y)) return a;
  }
  return null;
}

function _hitOne(h, a, x, y) {
  const pts = (a.points || []).map(p => _pointToXY(h, p));
  if (a.type === 'hline' && pts[0]) {
    return Math.abs(y - pts[0].y) < HIT_THRESHOLD;
  }
  if (a.type === 'vline' && pts[0]) {
    return Math.abs(x - pts[0].x) < HIT_THRESHOLD;
  }
  if (a.type === 'line' && pts[0] && pts[1]) {
    return _distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < HIT_THRESHOLD;
  }
  if (a.type === 'rect' && pts[0] && pts[1]) {
    const minX = Math.min(pts[0].x, pts[1].x), maxX = Math.max(pts[0].x, pts[1].x);
    const minY = Math.min(pts[0].y, pts[1].y), maxY = Math.max(pts[0].y, pts[1].y);
    const onEdge =
      (Math.abs(x - minX) < HIT_THRESHOLD && y >= minY - 4 && y <= maxY + 4) ||
      (Math.abs(x - maxX) < HIT_THRESHOLD && y >= minY - 4 && y <= maxY + 4) ||
      (Math.abs(y - minY) < HIT_THRESHOLD && x >= minX - 4 && x <= maxX + 4) ||
      (Math.abs(y - maxY) < HIT_THRESHOLD && x >= minX - 4 && x <= maxX + 4);
    if (onEdge) return true;
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  }
  if (a.type === 'text' && pts[0]) {
    return Math.abs(x - pts[0].x) < 80 && Math.abs(y - pts[0].y) < 12;
  }
  return false;
}

function _distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function _shiftAnnotation(a, dx, dy) {
  if (!overlay) return;
  const h = overlay;
  a.points = (a.points || []).map(p => {
    const xy = _pointToXY(h, p);
    if (!xy) return p;
    return _xyToPoint(h, xy.x + dx, xy.y + dy);
  });
  a.updated_at = Date.now();
}

// ============================================================================
// A3: 磁吸偵測
// ============================================================================
function _maybeSnap(e) {
  if (!snapEnabled || shiftHeld) return { x: e.x, y: e.y, snap: null };
  const snap = _findNearestSnap(e);
  if (!snap) return { x: e.x, y: e.y, snap: null };
  return { x: snap.x, y: snap.y, snap };
}

function _findNearestSnap(e) {
  const candles = ctxRefs?.getCandles?.() || AppState.lastCandles;
  if (!candles || !candles.length || !overlay) return null;

  const snapRange = window.innerWidth < 768 ? SNAP_PX_MOBILE : SNAP_PX;

  // 找出滑鼠下方最近的 candle
  const logical = overlay.xToLogical(e.x);
  if (logical == null) return null;
  const idx = Math.round(logical);
  if (idx < 0 || idx >= candles.length) return null;

  const c = candles[idx];
  if (!c) return null;

  const cx = overlay.logicalToX(idx);
  if (cx == null || Math.abs(cx - e.x) > snapRange * 2) return null;

  // 計算到 OHLC 四個點的距離
  const candidates = [
    { field: 'O', price: c.open,  y: overlay.priceToY(c.open) },
    { field: 'H', price: c.high,  y: overlay.priceToY(c.high) },
    { field: 'L', price: c.low,   y: overlay.priceToY(c.low) },
    { field: 'C', price: c.close, y: overlay.priceToY(c.close) },
  ].filter(p => p.y != null);

  let best = null;
  for (const p of candidates) {
    const dist = Math.hypot(cx - e.x, p.y - e.y);
    if (dist < snapRange && (!best || dist < best.dist)) {
      best = { x: cx, y: p.y, price: p.price, field: p.field, dist };
    }
  }
  return best;
}

export function setSnapEnabled(v) {
  snapEnabled = !!v;
  _updateToolbarUI();
}
export function isSnapEnabled() { return snapEnabled; }

// ============================================================================
// A5: 即時座標提示
// ============================================================================
function _injectCoordPanel() {
  if (document.getElementById('chartEditCoordPanel')) {
    coordPanelEl = document.getElementById('chartEditCoordPanel');
    return;
  }
  coordPanelEl = document.createElement('div');
  coordPanelEl.id = 'chartEditCoordPanel';
  coordPanelEl.className = 'ce-coord-panel hidden';
  ctxRefs.chartContainer.appendChild(coordPanelEl);
}

function _updateCoordPanel(e) {
  if (!editing || !coordPanelEl) return;
  const candles = ctxRefs?.getCandles?.() || AppState.lastCandles;
  if (!candles || !candles.length || !overlay) {
    _hideCoordPanel();
    return;
  }
  const logical = overlay.xToLogical(e.x);
  const idx = logical != null ? Math.round(logical) : -1;
  if (idx < 0 || idx >= candles.length) {
    _hideCoordPanel();
    return;
  }
  const c = candles[idx];
  if (!c) return;

  const date = c.time ? _fmtDate(c.time) : '';
  const price = overlay.yToPrice(e.y);
  const priceStr = price != null ? price.toFixed(2) : '-';

  coordPanelEl.innerHTML = `
    <div class="ce-coord-date">${date} <span class="ce-coord-price">游標 ${priceStr}</span></div>
    <div class="ce-coord-row">
      <span>O <b>${c.open?.toFixed(2)}</b></span>
      <span>H <b class="ce-coord-up">${c.high?.toFixed(2)}</b></span>
      <span>L <b class="ce-coord-down">${c.low?.toFixed(2)}</b></span>
      <span>C <b>${c.close?.toFixed(2)}</b></span>
    </div>
    <div class="ce-coord-vol">量 ${_fmtVol(c.volume)}</div>
  `;
  coordPanelEl.classList.remove('hidden');
}

function _hideCoordPanel() {
  if (coordPanelEl) coordPanelEl.classList.add('hidden');
}

function _fmtDate(t) {
  if (typeof t === 'string') return t;
  if (typeof t === 'number') {
    const d = new Date(t * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  if (t && t.year) return `${t.year}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`;
  return '';
}

function _fmtVol(v) {
  if (!v) return '0';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 億';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 萬';
  return v.toLocaleString();
}

// ============================================================================
// 全域鍵盤(Shift 暫時關磁吸,Esc 退出選取)
// ============================================================================
function _bindGlobalKeys() {
  document.addEventListener('keydown', (ev) => {
    if (!editing) return;
    if (ev.key === 'Shift') shiftHeld = true;
    if (ev.key === 'Escape') {
      selectedId = null;
      drawingTemp = null;
      overlay?.requestRender();
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selectedId) {
        ev.preventDefault();
        deleteSelected();
      }
    }
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.key === 'Shift') shiftHeld = false;
  });
}

// ============================================================================
// Undo / Delete / Clear
// ============================================================================
function _pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify(annotations)));
  if (undoStack.length > 50) undoStack.shift();
}

export function undo() {
  if (!undoStack.length) return;
  annotations = undoStack.pop();
  _scheduleSave();
  overlay?.requestRender();
}

export function clearAll() {
  if (!annotations.length) return;
  if (!confirm('確定清除所有標註?')) return;
  _pushUndo();
  annotations = [];
  _scheduleSave();
  overlay?.requestRender();
}

export function deleteSelected() {
  if (!selectedId) return;
  _pushUndo();
  annotations = annotations.filter(a => a.id !== selectedId);
  selectedId = null;
  _scheduleSave();
  overlay?.requestRender();
}

// ============================================================================
// 儲存
// ============================================================================
function _scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(_flushSave, DEBOUNCE_SAVE_MS);
}

async function _flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const code = ctxRefs?.getCode?.();
  if (!code) return;
  try {
    if (!annotations.length) {
      await deleteAnnotation(code);
    } else {
      await saveAnnotation(code, {
        code,
        lines: annotations,
      });
    }
  } catch (e) {
    console.warn('[chart-edit] save failed', e);
  }
}

// ============================================================================
// 工具列(A1 浮動定位)
// ============================================================================
export function setActiveTool(tool) {
  if (!TOOLS[tool]) return;
  activeTool = tool;
  selectedId = null;
  drawingTemp = null;
  _updateToolbarUI();
  overlay?.requestRender();
}

function _injectToolbar() {
  if (document.getElementById('chartEditToolbar')) {
    toolbarEl = document.getElementById('chartEditToolbar');
    return;
  }
  toolbarEl = document.createElement('div');
  toolbarEl.id = 'chartEditToolbar';
  toolbarEl.className = 'ce-toolbar ce-toolbar-floating hidden';
  toolbarEl.innerHTML = `
    <div class="ce-tools">
      ${Object.entries(TOOLS).map(([k, t]) =>
        `<button class="ce-tool-btn" data-tool="${k}" title="${t.label}">${t.icon}</button>`
      ).join('')}
    </div>
    <div class="ce-divider"></div>
    <div class="ce-actions">
      <button class="ce-action-btn" data-action="snap"   title="磁吸 K 棒(Shift 暫時關)">🧲</button>
      <button class="ce-action-btn" data-action="undo"   title="復原">⟲</button>
      <button class="ce-action-btn" data-action="delete" title="刪除選取(Del)">🗑</button>
      <button class="ce-action-btn" data-action="clear"  title="清除全部">✖</button>
      <button class="ce-action-btn" data-action="export" title="匯出 PNG">⬇</button>
    </div>
    <div class="ce-divider"></div>
    <button class="ce-exit-btn" data-action="exit">退出編輯</button>
  `;
  // A1: 直接掛到 chartContainer 內部(浮動定位)
  ctxRefs.chartContainer.appendChild(toolbarEl);

  toolbarEl.addEventListener('click', (ev) => {
    const tBtn = ev.target.closest('.ce-tool-btn');
    if (tBtn) { setActiveTool(tBtn.dataset.tool); return; }

    const aBtn = ev.target.closest('.ce-action-btn, .ce-exit-btn');
    if (!aBtn) return;
    const action = aBtn.dataset.action;
    if (action === 'snap')   { setSnapEnabled(!snapEnabled); }
    if (action === 'undo')   undo();
    if (action === 'delete') deleteSelected();
    if (action === 'clear')  clearAll();
    if (action === 'export') exportImage();
    if (action === 'exit')   exitEditMode();
  });
}

function _showToolbar(show) {
  if (!toolbarEl) return;
  toolbarEl.classList.toggle('hidden', !show);
  if (show) _updateToolbarUI();
}

function _updateToolbarUI() {
  if (!toolbarEl) return;
  toolbarEl.querySelectorAll('.ce-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === activeTool);
  });
  // 磁吸開關狀態
  const snapBtn = toolbarEl.querySelector('[data-action="snap"]');
  if (snapBtn) snapBtn.classList.toggle('active', snapEnabled);
}

// ============================================================================
// 隱藏 / 恢復指標
// ============================================================================
function _hideIndicators(hide) {
  if (hide) {
    savedIndicatorState = {
      indicators: { ...AppState.indicators },
      ma:         { ...AppState.ma },
    };
    AppState.indicators = { KD: false, RSI: false, MACD: false };
    AppState.ma = { 5: false, 10: false, 20: false, 60: false, BB: false };
  } else if (savedIndicatorState) {
    AppState.indicators = savedIndicatorState.indicators;
    AppState.ma         = savedIndicatorState.ma;
    savedIndicatorState = null;
  }
}

// ============================================================================
// 匯出
// ============================================================================
export async function exportImage() {
  try {
    const chartEl = ctxRefs?.chartContainer;
    if (!chartEl) return;
    if (window.html2canvas) {
      const canvas = await window.html2canvas(chartEl, {
        backgroundColor: '#0e0f11',
        scale: 2,
        logging: false,
      });
      _downloadCanvas(canvas, `${ctxRefs.getCode?.() || 'chart'}-${Date.now()}.png`);
      return;
    }
    if (overlay) {
      _downloadCanvas(overlay.canvas, `${ctxRefs.getCode?.() || 'chart'}-overlay.png`);
    }
    alert('完整匯出需要載入 html2canvas;目前只匯出了標註層 PNG');
  } catch (e) {
    console.warn('[chart-edit] export failed', e);
    alert('匯出失敗:' + e.message);
  }
}

function _downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

// ============================================================================
// 工具
// ============================================================================
function _uuid() {
  return 'a_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
