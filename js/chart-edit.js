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
import { anchoredVWAP } from './indicators.js';

// ---------- 工具定義 ----------
const TOOLS = {
  select: { icon: '↖', label: '選取',   needPoints: 0 },
  line:   { icon: '╱', label: '趨勢線', needPoints: 2 },
  hline:  { icon: '━', label: '水平線', needPoints: 1 },
  vline:  { icon: '│', label: '垂直線', needPoints: 1 },
  rect:   { icon: '▭', label: '矩形',   needPoints: 2 },
  ray:    { icon: '↗', label: '射線（延伸至圖緣）', needPoints: 2 },
  fib:    { icon: '𝔉', label: '費波那契回撤',       needPoints: 2 },
  measure:{ icon: '⤢', label: '量尺（漲跌幅/K棒數）', needPoints: 2 },
  text:   { icon: 'T', label: '文字',   needPoints: 1 },
  avwap:  { icon: '⚓', label: '錨定均價 AVWAP（點 K 棒設錨，畫該點以來平均成本線）', needPoints: 1 },
  position:{ icon: '🎯', label: '多空部位（拖 進場→停利，自動帶 1:1 停損，可調）', needPoints: 2 },
  channel: { icon: '∥', label: '平行通道（拉基準線，再拖第三點調通道寬）', needPoints: 2 },
  fibext: { icon: '📐', label: 'Fib 延伸（突破後目標 1.272 / 1.618 / 2.618）', needPoints: 2 },
};

const DEFAULT_COLOR = {
  line:  '#3b82f6',
  hline: '#26a69a',
  vline: '#a78bfa',
  rect:  '#f59e0b',
  ray:   '#3b82f6',
  fib:   '#e3b341',
  measure: '#8b9dc3',
  text:  '#e8eaed',
  avwap: '#fbbf24',
  position: '#e3b341',
  channel: '#3b82f6',
  fibext: '#a78bfa',
};

// 樣式面板：色票 / 線寬 / 虛實（套用到選中圖形；無選取時設為新圖形預設）
const STYLE_COLORS = ['#3b82f6', '#ef5350', '#26a69a', '#e3b341', '#a78bfa', '#e8eaed'];
let currentStyle = { color: null, width: 1.5, dash: false };  // color null = 用工具預設色

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
let hoverId   = null;            // B1 hover 高亮的圖形 id
let ctxMenuEl = null;            // B2 右鍵選單元素
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

  // ⚠️ 不再用 _hideIndicators 動 AppState（會 desync 且還原脆弱）。
  //    工作室的「乾淨」改由 CSS（.studio-mode 隱藏 .ind-panel）處理，AppState 不碰。
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
  _hideCtxMenu();
  hoverId = null;

  // ⚠️ 已不再用 _hideIndicators，無需還原 AppState
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

// 圖層「✏️ 手繪」開關：隱藏/顯示已提交的手繪標註（進行中的繪製不受影響）
let _annotationsVisible = true;
export function setAnnotationsVisible(v) {
  _annotationsVisible = !!v;
  overlay?.requestRender();
}
export function areAnnotationsVisible() { return _annotationsVisible; }

function _createOverlay() {
  if (overlay) { try { overlay.destroy(); } catch {} overlay = null; }
  _hideCtxMenu();
  hoverId = null;
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

  // B2 右鍵選單（canvas-overlay 不轉發 contextmenu，直接綁原生）
  if (overlay.canvas) {
    overlay.canvas.addEventListener('contextmenu', _onContextMenu);
  }
}

function _onContextMenu(ev) {
  if (!editing || !overlay) return;
  ev.preventDefault();
  const rect = overlay.canvas.getBoundingClientRect();
  const e = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  const hit = _hitTest(e);
  _hideCtxMenu();
  if (!hit) return;
  selectedId = hit.id;
  overlay.requestRender();
  _showCtxMenu(ev.clientX, ev.clientY);
}

function _showCtxMenu(clientX, clientY) {
  if (!ctxMenuEl) {
    ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'ce-ctx-menu';
    ctxMenuEl.innerHTML = `
      <button data-cm="dup">⧉ 複製</button>
      <button data-cm="top">⇡ 置頂</button>
      <button data-cm="del" style="color:#ef5350">🗑 刪除</button>`;
    document.body.appendChild(ctxMenuEl);
    ctxMenuEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.cm;
      if (act === 'del') deleteSelected();
      if (act === 'dup') _duplicateSelected();
      if (act === 'top') _bringToFront();
      _hideCtxMenu();
    });
    // 點其他地方關閉
    document.addEventListener('mousedown', (ev) => {
      if (ctxMenuEl && !ctxMenuEl.contains(ev.target)) _hideCtxMenu();
    });
  }
  ctxMenuEl.style.left = clientX + 'px';
  ctxMenuEl.style.top  = clientY + 'px';
  ctxMenuEl.style.display = 'flex';
}

function _hideCtxMenu() {
  if (ctxMenuEl) ctxMenuEl.style.display = 'none';
}

function _duplicateSelected() {
  const src = annotations.find(a => a.id === selectedId);
  if (!src) return;
  _pushUndo();
  const dup = JSON.parse(JSON.stringify(src));
  dup.id = _uuid();
  dup.auto = false;   // 複製出來的視為手繪
  dup.created_at = dup.updated_at = Date.now();
  annotations.push(dup);
  selectedId = dup.id;
  _shiftAnnotation(dup, 12, 12);   // 錯位避免完全重疊
  _scheduleSave();
  overlay.requestRender();
}

function _bringToFront() {
  const idx = annotations.findIndex(a => a.id === selectedId);
  if (idx < 0 || idx === annotations.length - 1) return;
  _pushUndo();
  const [a] = annotations.splice(idx, 1);
  annotations.push(a);   // 陣列尾端後畫 = 最上層，hit test 也是倒序先命中
  _scheduleSave();
  overlay.requestRender();
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
  if (_annotationsVisible) for (const a of annotations) _drawAnnotation(ctx, h, a, a.id === selectedId);
  if (drawingTemp) _drawAnnotation(ctx, h, drawingTemp, false);
}

function _drawAnnotation(ctx, h, a, isSelected) {
  ctx.save();
  const isHover = !isSelected && a.id === hoverId;
  ctx.lineWidth = (a.width || 1.5) + (isSelected ? 1 : 0) + (isHover ? 0.8 : 0);
  ctx.strokeStyle = a.color || DEFAULT_COLOR[a.type] || '#3b82f6';
  ctx.fillStyle   = a.color || DEFAULT_COLOR[a.type] || '#3b82f6';
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(a.dash ? [6, 4] : []);

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
  } else if (a.type === 'ray' && pts.length >= 2 && pts[0] && pts[1]) {
    // 從 p0 穿過 p1 延伸到畫布邊緣
    const ext = _extendToEdge(pts[0], pts[1], W, H);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(ext.x, ext.y);
    ctx.stroke();
    if (isSelected) _drawHandles(ctx, pts);
  } else if (a.type === 'fib' && pts.length >= 2 && pts[0] && pts[1]) {
    const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const p0 = a.points[0], p1 = a.points[1];
    const x0 = Math.min(pts[0].x, pts[1].x);
    const x1 = W;  // 向右延伸到圖緣（看未來支撐壓力）
    const base = a.color || DEFAULT_COLOR.fib;
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';   // 標籤靠右緣，不壓 K 棒
    for (const lv of FIB_LEVELS) {
      const price = p1.price + (p0.price - p1.price) * lv;
      const y = h.priceToY(price);
      if (y == null) continue;
      ctx.globalAlpha = (lv === 0 || lv === 1) ? 0.85 : (lv === 0.5 ? 0.6 : 0.38);
      ctx.strokeStyle = base;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.globalAlpha = (lv === 0 || lv === 1) ? 0.95 : 0.75;
      ctx.fillStyle = base;
      ctx.fillText(`${(lv * 100).toFixed(1)}% ${price.toFixed(2)}`, x1 - 4, y - 2);
    }
    ctx.globalAlpha = 1;
    if (isSelected) _drawHandles(ctx, pts);
  } else if (a.type === 'measure' && pts.length >= 2 && pts[0] && pts[1]) {
    const p0 = a.points[0], p1 = a.points[1];
    const chgPct = (p0.price && p1.price) ? ((p1.price - p0.price) / p0.price) * 100 : 0;
    // 台股慣例：漲紅跌綠
    const col = chgPct >= 0 ? '#ef5350' : '#26a69a';
    const bars = (p0.logical != null && p1.logical != null)
      ? Math.abs(Math.round(p1.logical - p0.logical)) : null;
    // 半透明區域 + 對角箭頭
    const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x), hh = Math.abs(pts[1].y - pts[0].y);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(x, y, w, hh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
    // 箭頭頭部
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    ctx.beginPath();
    ctx.moveTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[1].x - 8 * Math.cos(ang - 0.4), pts[1].y - 8 * Math.sin(ang - 0.4));
    ctx.moveTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[1].x - 8 * Math.cos(ang + 0.4), pts[1].y - 8 * Math.sin(ang + 0.4));
    ctx.stroke();
    // 資訊框
    const diff = (p1.price ?? 0) - (p0.price ?? 0);
    const lines = [
      `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%（${diff >= 0 ? '+' : ''}${diff.toFixed(2)}）`,
      bars != null ? `${bars} 根 K 棒` : '',
    ].filter(Boolean);
    ctx.font = '12px system-ui';
    const bw = Math.max(...lines.map(t => ctx.measureText(t).width)) + 12;
    const bx = (pts[0].x + pts[1].x) / 2 - bw / 2;
    const by = Math.min(pts[0].y, pts[1].y) - 18 * lines.length - 8;
    ctx.fillStyle = 'rgba(28,31,36,0.92)';
    ctx.fillRect(bx, by, bw, 18 * lines.length + 6);
    ctx.strokeStyle = col;
    ctx.strokeRect(bx, by, bw, 18 * lines.length + 6);
    ctx.fillStyle = col;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    lines.forEach((t, i) => ctx.fillText(t, bx + 6, by + 4 + i * 18));
    if (isSelected) _drawHandles(ctx, pts);
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
  } else if (a.type === 'avwap' && pts[0]) {
    // T-2 手動錨定 AVWAP：從點選的 K 棒起算量加權均價線（錨點以來平均成本）
    const res = _avwapScreenPts(h, a);
    if (res && res.line.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(res.line[0].x, res.line[0].y);
      for (let i = 1; i < res.line.length; i++) ctx.lineTo(res.line[i].x, res.line[i].y);
      ctx.stroke();
      const last = res.line[res.line.length - 1];
      if (res.lastVal != null) _drawPriceLabel(ctx, h.width - 2, last.y, res.lastVal, a.color || DEFAULT_COLOR.avwap);
    }
    // 錨點 ⚓ 記號（線太短也畫，標示設錨位置）
    ctx.setLineDash([]);
    ctx.font = '13px system-ui';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = a.color || DEFAULT_COLOR.avwap;
    ctx.fillText('⚓', pts[0].x, pts[0].y);
    if (isSelected) _drawHandles(ctx, [pts[0]]);
  } else if (a.type === 'position' && pts[0] && pts[1]) {
    // 🎯 多空部位：進場(p0)/停利(p1)/停損(p2，缺則即時推導 1:1) 三水平線 + 獲利/虧損區（台股：賺紅賠綠）
    const entry = a.points[0], target = a.points[1];
    const ePr = entry.price, tPr = target.price;
    const sPr = (a.points[2] && a.points[2].price != null) ? a.points[2].price : (ePr - (tPr - ePr));
    const yE = pts[0].y, yT = pts[1].y;
    const yS = h.priceToY(sPr);
    const boxL = Math.min(pts[0].x, pts[1].x), boxR = Math.max(pts[0].x, pts[1].x);
    const RED = '#ef5350', GREEN = '#26a69a', NEU = '#e3b341';
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(239,83,80,0.12)';
    ctx.fillRect(boxL, Math.min(yE, yT), boxR - boxL, Math.abs(yT - yE));
    if (yS != null) { ctx.fillStyle = 'rgba(38,166,154,0.12)'; ctx.fillRect(boxL, Math.min(yE, yS), boxR - boxL, Math.abs(yS - yE)); }
    const _hl = (y, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(boxL, y); ctx.lineTo(boxR, y); ctx.stroke(); };
    _hl(yT, RED, 1.4); _hl(yE, NEU, 1.6); if (yS != null) _hl(yS, GREEN, 1.4);
    const tPct = (tPr - ePr) / ePr * 100, sPct = (sPr - ePr) / ePr * 100;
    const reward = Math.abs(tPr - ePr), risk = Math.abs(ePr - sPr);
    const rr = risk > 0 ? reward / risk : 0;
    ctx.font = '11px system-ui'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const _lbl = (x, y, txt, col) => { const m = ctx.measureText(txt); ctx.fillStyle = 'rgba(28,31,36,0.92)'; ctx.fillRect(x, y - 8, m.width + 8, 16); ctx.fillStyle = col; ctx.fillText(txt, x + 4, y); };
    _lbl(boxR + 4, yT, `停利 ${tPr.toFixed(2)}　${tPct >= 0 ? '+' : ''}${tPct.toFixed(1)}%`, RED);
    _lbl(boxR + 4, yE, `進場 ${ePr.toFixed(2)}`, NEU);
    if (yS != null) _lbl(boxR + 4, yS, `停損 ${sPr.toFixed(2)}　${sPct >= 0 ? '+' : ''}${sPct.toFixed(1)}%`, GREEN);
    _lbl(boxL + 4, Math.min(yE, yT, yS != null ? yS : yT) - 12, `盈虧比 ${rr.toFixed(1)}`, rr >= 2 ? RED : NEU);
    if (isSelected) _drawHandles(ctx, [{ x: pts[0].x, y: yE }, { x: pts[1].x, y: yT }, { x: pts[1].x, y: yS != null ? yS : yT }]);
  } else if (a.type === 'channel' && pts[0] && pts[1]) {
    // ∥ 平行通道：base 線(p0,p1) + 平行線（過 p2，缺則即時推導偏移），螢幕等距、向右緣延伸 + 填色
    const base0 = pts[0], base1 = pts[1];
    let yOff;
    if (a.points[2] && a.points[2].price != null) {
      const dxb = base1.x - base0.x;
      const yBaseAtP2 = dxb !== 0 ? base0.y + (base1.y - base0.y) * (pts[2].x - base0.x) / dxb : base0.y;
      yOff = (pts[2] ? pts[2].y : base0.y) - yBaseAtP2;
    } else {
      const off = Math.max(Math.abs((a.points[1].price ?? 0) - (a.points[0].price ?? 0)), (a.points[0].price || 1) * 0.02);
      const y1 = h.priceToY((a.points[0].price ?? 0) + off), y0 = h.priceToY(a.points[0].price ?? 0);
      yOff = (y1 != null && y0 != null) ? (y1 - y0) : -40;
    }
    const par0 = { x: base0.x, y: base0.y + yOff }, par1 = { x: base1.x, y: base1.y + yOff };
    const bE = _extendToEdge(base0, base1, W, H), pE = _extendToEdge(par0, par1, W, H);
    const col = a.color || DEFAULT_COLOR.channel;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.08; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(base0.x, base0.y); ctx.lineTo(bE.x, bE.y); ctx.lineTo(pE.x, pE.y); ctx.lineTo(par0.x, par0.y); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = a.width || 1.5;
    ctx.beginPath(); ctx.moveTo(base0.x, base0.y); ctx.lineTo(bE.x, bE.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(par0.x, par0.y); ctx.lineTo(pE.x, pE.y); ctx.stroke();
    if (isSelected && pts[2]) _drawHandles(ctx, [base0, base1, pts[2]]);
  } else if (a.type === 'fibext' && pts.length >= 2 && pts[0] && pts[1]) {
    // 📐 Fib 延伸：目標價 = p0 + (p1−p0)×ratio（突破延伸，與回撤互補）
    const EXT = [0.618, 1, 1.272, 1.618, 2, 2.618];
    const p0 = a.points[0], p1 = a.points[1];
    const x0 = Math.min(pts[0].x, pts[1].x), x1 = W;
    const base = a.color || DEFAULT_COLOR.fibext;
    ctx.setLineDash(a.dash ? [6, 4] : []);
    ctx.strokeStyle = base; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '11px system-ui'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'right';
    for (const lv of EXT) {
      const price = p0.price + (p1.price - p0.price) * lv;
      const y = h.priceToY(price);
      if (y == null) continue;
      ctx.setLineDash([]);
      ctx.globalAlpha = lv === 1 ? 0.85 : lv === 1.618 ? 0.7 : 0.4;
      ctx.strokeStyle = base;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.globalAlpha = (lv === 1 || lv === 1.618) ? 0.95 : 0.75;
      ctx.fillStyle = base;
      ctx.fillText(`${(lv * 100).toFixed(1)}% ${price.toFixed(2)}`, x1 - 4, y - 2);
    }
    ctx.globalAlpha = 1;
    if (isSelected) _drawHandles(ctx, pts);
  }
  // ✨ 自動描繪標記（與手繪區分，清除自動時只掃這些）
  if (a.auto && pts[0]) {
    ctx.setLineDash([]);
    ctx.font = '10px system-ui';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.8;
    ctx.fillText('✨', 4, pts[0].y - 10);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// 從 p0 穿過 p1 延伸到畫布邊界的交點
function _extendToEdge(p0, p1, W, H) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  if (dx === 0 && dy === 0) return p1;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (W - p0.x) / dx);
  if (dx < 0) t = Math.min(t, (0 - p0.x) / dx);
  if (dy > 0) t = Math.min(t, (H - p0.y) / dy);
  if (dy < 0) t = Math.min(t, (0 - p0.y) / dy);
  if (!Number.isFinite(t)) return p1;
  return { x: p0.x + dx * t, y: p0.y + dy * t };
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

// ── T-2 AVWAP 手動錨：把錨點 point 解析成 K 棒索引並算 AVWAP 序列 ──
function _avwapResolve(a) {
  const candles = ctxRefs?.getCandles?.() || [];
  if (!candles.length) return null;
  const p0 = a.points?.[0];
  if (!p0) return null;
  let idx = -1;
  if (p0.time != null) idx = candles.findIndex(c => c.time >= p0.time);
  if (idx < 0 && p0.logical != null) idx = Math.round(p0.logical);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(idx, candles.length - 1));
  return { idx, av: anchoredVWAP(candles, idx), candles };
}
// AVWAP 螢幕座標 polyline（錨點起到最後一根），供繪製與命中測試共用
function _avwapScreenPts(h, a) {
  const r = _avwapResolve(a);
  if (!r) return null;
  const line = [];
  for (let i = r.idx; i < r.candles.length; i++) {
    const v = r.av[i];
    if (v == null) continue;
    const x = h.timeToX(r.candles[i].time);
    const y = h.priceToY(v);
    if (x == null || y == null) continue;
    line.push({ x, y });
  }
  return { line, lastVal: r.av[r.candles.length - 1] };
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
    color: currentStyle.color || DEFAULT_COLOR[activeTool],
    width: currentStyle.width,
    dash:  currentStyle.dash,
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

  // B1 hover 高亮（select 模式、非拖曳中）
  if (activeTool === 'select' && !draggingId && !draggingEndpoint && !drawingTemp) {
    const hit = _hitTest(e);
    const newHover = hit ? hit.id : null;
    if (newHover !== hoverId) {
      hoverId = newHover;
      if (overlay?.canvas) overlay.canvas.style.cursor = hoverId ? 'pointer' : '';
      overlay?.requestRender();
    }
  } else if (hoverId) {
    hoverId = null;
    if (overlay?.canvas) overlay.canvas.style.cursor = '';
  }

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
  } else if (drawingTemp.type === 'position') {
    // 進場(p0) → 停利(p1)；自動補停損(p2)：對稱 1:1 風險報酬，使用者可拖調
    const p0 = drawingTemp.points[0], p1 = drawingTemp.points[1];
    if (!p0 || !p1 || p0.price == null || p1.price == null) { drawingTemp = null; overlay.requestRender(); return; }
    const stopPrice = p0.price - (p1.price - p0.price);
    drawingTemp.points[2] = { time: p1.time, logical: p1.logical, price: stopPrice };
  } else if (drawingTemp.type === 'channel') {
    // 基準線(p0,p1) → 自動補通道寬錨點(p2)：預設偏移 = 線本身漲跌幅或 2% 取大者
    const p0 = drawingTemp.points[0], p1 = drawingTemp.points[1];
    if (!p0 || !p1 || p0.price == null || p1.price == null) { drawingTemp = null; overlay.requestRender(); return; }
    const off = Math.max(Math.abs(p1.price - p0.price), (p0.price || 1) * 0.02);
    drawingTemp.points[2] = { time: p0.time, logical: p0.logical, price: p0.price + off };
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
  if ((a.type === 'line' || a.type === 'ray' || a.type === 'fib' || a.type === 'fibext' || a.type === 'measure') && pts[0] && pts[1]) {
    out.push({ ...pts[0], index: 0 });
    out.push({ ...pts[1], index: 1 });
  } else if (a.type === 'rect' && pts[0] && pts[1]) {
    // 矩形 4 角 = 兩個 point 的組合
    out.push({ x: pts[0].x, y: pts[0].y, index: 0 });
    out.push({ x: pts[1].x, y: pts[1].y, index: 1 });
    // (中間兩個角是組合出來的,目前只支援拖兩個 point;簡化版)
  } else if (a.type === 'avwap' && pts[0]) {
    out.push({ ...pts[0], index: 0 });   // 錨點可拖曳重設
  } else if (a.type === 'position' && pts[0] && pts[1] && pts[2]) {
    out.push({ x: pts[0].x, y: pts[0].y, index: 0 });   // 進場（左緣）
    out.push({ x: pts[1].x, y: pts[1].y, index: 1 });   // 停利（右緣）
    out.push({ x: pts[1].x, y: pts[2].y, index: 2 });   // 停損（右緣）
  } else if (a.type === 'channel' && pts[0] && pts[1] && pts[2]) {
    out.push({ ...pts[0], index: 0 });
    out.push({ ...pts[1], index: 1 });
    out.push({ ...pts[2], index: 2 });   // 通道寬
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
  if ((a.type === 'line' || a.type === 'measure') && pts[0] && pts[1]) {
    return _distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < HIT_THRESHOLD;
  }
  if (a.type === 'ray' && pts[0] && pts[1]) {
    const ext = _extendToEdge(pts[0], pts[1], h.width, h.height);
    return _distToSegment(x, y, pts[0].x, pts[0].y, ext.x, ext.y) < HIT_THRESHOLD;
  }
  if (a.type === 'fib' && pts[0] && pts[1]) {
    // 命中：兩錨點連線附近，或任一 level 水平線（x0 以右）
    if (_distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < HIT_THRESHOLD) return true;
    const x0 = Math.min(pts[0].x, pts[1].x);
    if (x < x0 - 4) return false;
    const p0 = a.points[0], p1 = a.points[1];
    for (const lv of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
      const yLv = h.priceToY(p1.price + (p0.price - p1.price) * lv);
      if (yLv != null && Math.abs(y - yLv) < HIT_THRESHOLD) return true;
    }
    return false;
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
  if (a.type === 'fibext' && pts[0] && pts[1]) {
    if (_distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < HIT_THRESHOLD) return true;
    const x0 = Math.min(pts[0].x, pts[1].x);
    if (x < x0 - 4) return false;
    const p0 = a.points[0], p1 = a.points[1];
    for (const lv of [0.618, 1, 1.272, 1.618, 2, 2.618]) {
      const yLv = h.priceToY(p0.price + (p1.price - p0.price) * lv);
      if (yLv != null && Math.abs(y - yLv) < HIT_THRESHOLD) return true;
    }
    return false;
  }
  if (a.type === 'avwap' && pts[0]) {
    if (Math.abs(x - pts[0].x) < 12 && Math.abs(y - pts[0].y) < 12) return true;  // 點⚓錨
    const res = _avwapScreenPts(h, a);
    if (res) for (let i = 1; i < res.line.length; i++) {
      if (_distToSegment(x, y, res.line[i - 1].x, res.line[i - 1].y, res.line[i].x, res.line[i].y) < HIT_THRESHOLD) return true;
    }
    return false;
  }
  if (a.type === 'position' && pts[0] && pts[1] && pts[2]) {
    const boxL = Math.min(pts[0].x, pts[1].x) - 4, boxR = Math.max(pts[0].x, pts[1].x) + 4;
    const yv = [pts[0].y, pts[1].y, pts[2].y];
    return x >= boxL && x <= boxR && y >= Math.min(...yv) - 4 && y <= Math.max(...yv) + 4;
  }
  if (a.type === 'channel' && pts[0] && pts[1] && pts[2]) {
    const dxb = pts[1].x - pts[0].x;
    const yBaseAtP2 = dxb !== 0 ? pts[0].y + (pts[1].y - pts[0].y) * (pts[2].x - pts[0].x) / dxb : pts[0].y;
    const yOff = pts[2].y - yBaseAtP2;
    const par0 = { x: pts[0].x, y: pts[0].y + yOff }, par1 = { x: pts[1].x, y: pts[1].y + yOff };
    const bE = _extendToEdge(pts[0], pts[1], h.width, h.height), pE = _extendToEdge(par0, par1, h.width, h.height);
    if (_distToSegment(x, y, pts[0].x, pts[0].y, bE.x, bE.y) < HIT_THRESHOLD) return true;
    if (_distToSegment(x, y, par0.x, par0.y, pE.x, pE.y) < HIT_THRESHOLD) return true;
    return false;
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

export function clearAutoDrawings() {
  if (!annotations.some(a => a.auto)) return;
  _pushUndo();
  annotations = annotations.filter(a => !a.auto);
  if (selectedId && !annotations.find(a => a.id === selectedId)) selectedId = null;
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
// ✨ 自動描繪：擺動點分群 → 支撐/壓力水平線；近 80 根主波段 → 費波回撤
// ============================================================================
export function autoDraw() {
  const candles = ctxRefs?.getCandles?.() || AppState.lastCandles;
  if (!candles || candles.length < 30 || !overlay) {
    alert('K 線不足，無法自動描繪');
    return;
  }
  _pushUndo();
  const now = Date.now();
  const added = [];

  // ── 1. 擺動點偵測（fractal window 3：左右各 3 根都更低/更高）──
  const PIVOT_W = 3;
  const pivots = [];  // { idx, price, kind: 'high'|'low' }
  for (let i = PIVOT_W; i < candles.length - PIVOT_W; i++) {
    const hi = candles[i].high, lo = candles[i].low;
    let isH = true, isL = true;
    for (let j = i - PIVOT_W; j <= i + PIVOT_W; j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) isH = false;
      if (candles[j].low  <= lo) isL = false;
    }
    if (isH) pivots.push({ idx: i, price: hi, kind: 'high' });
    if (isL) pivots.push({ idx: i, price: lo, kind: 'low' });
  }

  // ── 2. 支撐壓力：擺動點價位分群（±1.5%），觸碰次數 ≥ 3 取前 3 名 ──
  const lastClose = candles[candles.length - 1].close;
  const clusters = [];
  for (const p of pivots) {
    const hit = clusters.find(cl => Math.abs(cl.price - p.price) / cl.price < 0.015);
    if (hit) {
      hit.count++;
      hit.price = (hit.price * (hit.count - 1) + p.price) / hit.count;  // 移動平均
    } else {
      clusters.push({ price: p.price, count: 1 });
    }
  }
  // 只取「現價上方最近壓力」+「現價下方最近支撐」各一條，避免滿屏橫線雜訊
  const valid = clusters.filter(cl => cl.count >= 3 && Math.abs(cl.price - lastClose) / lastClose > 0.02);
  const res = valid.filter(cl => cl.price > lastClose).sort((a, b) => a.price - b.price)[0];
  const sup = valid.filter(cl => cl.price < lastClose).sort((a, b) => b.price - a.price)[0];
  [res, sup].filter(Boolean).forEach(cl => {
      added.push({
        id: _uuid(), type: 'hline',
        // ⚠️ _pointToXY 需要 time/logical 才回座標，hline 也不例外 → 錨在最後一根
        points: [{ price: cl.price, time: candles[candles.length - 1].time, logical: candles.length - 1 }],
        color: cl.price > lastClose ? '#ef5350' : '#26a69a',  // 上方=壓力紅，下方=支撐綠
        width: 1.5, dash: true, auto: true,
        label: cl.price > lastClose ? `壓力（${cl.count}次）` : `支撐（${cl.count}次）`,
        created_at: now, updated_at: now,
      });
    });

  // ── 3. 主波段費波：近 80 根找最高點，與其之前的最低點配對 ──
  const N = Math.min(80, candles.length);
  const recent = candles.slice(-N);
  const offset = candles.length - N;
  let hiIdx = 0;
  recent.forEach((c, i) => { if (c.high > recent[hiIdx].high) hiIdx = i; });
  let loIdx = 0;
  for (let i = 1; i <= hiIdx; i++) {
    if (recent[i].low < recent[loIdx].low) loIdx = i;
  }
  if (hiIdx > loIdx) {
    const cLo = candles[offset + loIdx], cHi = candles[offset + hiIdx];
    const range = (cHi.high - cLo.low) / cLo.low;
    if (range > 0.1) {  // 波段幅度 > 10% 才畫，避免盤整段畫垃圾
      added.push({
        id: _uuid(), type: 'fib',
        // p0=低點（100%）、p1=高點（0%），與手繪「低拉到高」一致
        points: [
          { time: cLo.time, logical: offset + loIdx, price: cLo.low },
          { time: cHi.time, logical: offset + hiIdx, price: cHi.high },
        ],
        color: '#e3b341', width: 1.5, dash: false, auto: true,
        created_at: now, updated_at: now,
      });
    }
  }

  if (!added.length) {
    alert('找不到值得描繪的結構（擺動點/波段不足）');
    undoStack.pop();  // 還掉這次 pushUndo
    return;
  }
  annotations.push(...added);
  _scheduleSave();
  overlay.requestRender();
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
    <div class="ce-drag-handle" title="拖曳移動工具列">⠿</div>
    <div class="ce-tools">
      ${Object.entries(TOOLS).map(([k, t]) =>
        `<button class="ce-tool-btn" data-tool="${k}" title="${t.label}">${t.icon}</button>`
      ).join('')}
    </div>
    <div class="ce-divider"></div>
    <div class="ce-styles">
      ${STYLE_COLORS.map(col =>
        `<button class="ce-style-swatch" data-color="${col}" style="background:${col}" title="顏色（套用選取或之後新圖形）"></button>`
      ).join('')}
      <button class="ce-style-btn" data-width="1.5" title="細線">─</button>
      <button class="ce-style-btn" data-width="2.5" title="粗線" style="font-weight:700">━</button>
      <button class="ce-style-btn" data-dash="1" title="虛線切換">┄</button>
    </div>
    <div class="ce-divider"></div>
    <div class="ce-actions">
      <button class="ce-action-btn" data-action="auto"      title="自動描繪（支撐壓力 + 主波段費波）">✨</button>
      <button class="ce-action-btn" data-action="clearAuto" title="清除自動描繪（手繪保留）">🧹</button>
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

    // 樣式面板：套用到選中圖形，無選取則設為後續預設
    const sw = ev.target.closest('.ce-style-swatch, .ce-style-btn');
    if (sw) {
      const patch = {};
      if (sw.dataset.color) { currentStyle.color = sw.dataset.color; patch.color = sw.dataset.color; }
      if (sw.dataset.width) { currentStyle.width = +sw.dataset.width; patch.width = +sw.dataset.width; }
      if (sw.dataset.dash)  { currentStyle.dash = !currentStyle.dash; patch.dash = currentStyle.dash; }
      const sel = annotations.find(a => a.id === selectedId);
      if (sel) {
        _pushUndo();
        Object.assign(sel, patch, { updated_at: Date.now() });
        _scheduleSave();
      }
      overlay?.requestRender();
      return;
    }

    const aBtn = ev.target.closest('.ce-action-btn, .ce-exit-btn');
    if (!aBtn) return;
    const action = aBtn.dataset.action;
    if (action === 'auto')      autoDraw();
    if (action === 'clearAuto') clearAutoDrawings();
    if (action === 'snap')   { setSnapEnabled(!snapEnabled); }
    if (action === 'undo')   undo();
    if (action === 'delete') deleteSelected();
    if (action === 'clear')  clearAll();
    if (action === 'export') exportImage();
    if (action === 'exit')   exitEditMode();
  });

  _makeToolbarDraggable();
}

// ── 工具列可拖移（拖左側 ⠿ 把手到任一處，位置存 localStorage）──
let _savedToolbarPos = null;
function _applyToolbarPos(left, top) {
  if (!toolbarEl) return;
  toolbarEl.style.left = left + 'px';
  toolbarEl.style.top  = top + 'px';
  toolbarEl.style.right = 'auto';
  toolbarEl.style.bottom = 'auto';
}
function _clampToolbarPos(left, top) {
  const par = toolbarEl.offsetParent || document.documentElement;
  const maxL = Math.max(0, (par.clientWidth  || window.innerWidth)  - toolbarEl.offsetWidth);
  const maxT = Math.max(0, (par.clientHeight || window.innerHeight) - toolbarEl.offsetHeight);
  return { left: Math.max(0, Math.min(left, maxL)), top: Math.max(0, Math.min(top, maxT)) };
}
function _restoreToolbarPos() {
  if (!_savedToolbarPos || !toolbarEl) return;
  // 工具列剛顯示，下一幀才有正確尺寸 → rAF 後夾邊套用
  requestAnimationFrame(() => {
    if (!toolbarEl || toolbarEl.classList.contains('hidden')) return;
    const c = _clampToolbarPos(_savedToolbarPos.left, _savedToolbarPos.top);
    _applyToolbarPos(c.left, c.top);
  });
}
function _makeToolbarDraggable() {
  const handle = toolbarEl?.querySelector('.ce-drag-handle');
  if (!handle) return;
  try {
    const pos = JSON.parse(localStorage.getItem('ceToolbarPos') || 'null');
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) _savedToolbarPos = pos;
  } catch {}

  let dragging = false, sx = 0, sy = 0, startLeft = 0, startTop = 0;
  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    const c = _clampToolbarPos(startLeft + (pt.clientX - sx), startTop + (pt.clientY - sy));
    _applyToolbarPos(c.left, c.top);
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    toolbarEl.classList.remove('ce-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    _savedToolbarPos = { left: parseFloat(toolbarEl.style.left) || 0, top: parseFloat(toolbarEl.style.top) || 0 };
    try { localStorage.setItem('ceToolbarPos', JSON.stringify(_savedToolbarPos)); } catch {}
  };
  const onDown = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    const r  = toolbarEl.getBoundingClientRect();
    const pr = (toolbarEl.offsetParent || document.documentElement).getBoundingClientRect();
    startLeft = r.left - pr.left;
    startTop  = r.top  - pr.top;
    sx = pt.clientX; sy = pt.clientY;
    dragging = true;
    toolbarEl.classList.add('ce-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    e.preventDefault();
  };
  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}

function _showToolbar(show) {
  if (!toolbarEl) return;
  toolbarEl.classList.toggle('hidden', !show);
  if (show) { _updateToolbarUI(); _restoreToolbarPos(); }
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
    if (savedIndicatorState) return;   // 已隱藏中：不要用「已清空」狀態覆蓋備份
    savedIndicatorState = {
      indicators: { ...AppState.indicators },
      ma:         { ...AppState.ma },
    };
    // 只關副圖/均線，保留其餘鍵（RS/DMI/… 不要整組被刪，否則還原失敗時全消失）
    AppState.indicators = { ...AppState.indicators, KD: false, RSI: false, MACD: false };
    AppState.ma = { ...AppState.ma, 5: false, 10: false, 20: false, 60: false, BB: false };
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
