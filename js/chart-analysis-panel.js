// js/chart-analysis-panel.js
// ============================================================================
// Phase 7.3 — 技術分析說明區 + Excel 引線風格
// ============================================================================
// 架構:
//   全視窗時在 K 線上方建立一個「說明區」DOM 元素
//   每個技術分析訊號/燈號各自有一個說明框(card)
//   說明框用 <canvas> 畫引線連到 K 線對應位置(折角 + 箭頭)
//
// 對外 API:
//   initAnalysisPanel(refs)
//   showSignalCards(signalResults)   // signalResults: SignalCard[]
//   clearSignalCards()
//   updatePanelLayout()              // resize 時呼叫
//
// SignalCard 格式:
//   {
//     id, label, color,
//     lines: string[],               // 說明文字(多行)
//     anchorIdx: number,             // K 棒 logical index
//     anchorPrice: number,           // K 棒錨點價格
//     anchorAbove: boolean,          // 引線從上方或下方進入 K 棒
//   }
// ============================================================================

const PANEL_HEIGHT_RATIO = 0.28;   // 說明區佔全視窗高度的比例
const CARD_MIN_W = 160;
const CARD_MAX_W = 220;
const CARD_PAD_X = 12;
const CARD_PAD_Y = 10;
const LINE_H = 16;
const COLORS = {
  bg:     'rgba(14, 17, 23, 0.94)',
  border: 'rgba(255,255,255,0.10)',
  text:   '#e8eaed',
  muted:  '#8a8f99',
};

let refs = null;
let panelEl = null;        // 說明區 DOM
let lineCanvas = null;     // 覆蓋全 chartPanel 的引線 canvas
let cards = [];            // 目前顯示的說明卡
let _resizeObs = null;

// HP1: timeScale 訂閱管理(只訂閱一次,避免重複堆積)
let _unsubTime    = null;
let _unsubLogical = null;
let _redrawRafId  = null;

// HP1: 用 rAF 節流引線重繪
function _scheduleRedraw() {
  if (_redrawRafId) return;
  _redrawRafId = requestAnimationFrame(() => {
    _redrawRafId = null;
    _drawLeaderLines();
  });
}

// ============================================================================
// 初始化
// ============================================================================
export function initAnalysisPanel(r) {
  refs = r;

  // resize 重新計算
  window.addEventListener('chartRendered', () => {
    // chart 重建 → 重新訂閱 timeScale
    _resubscribeTimeScale();
    if (cards.length) _renderAll();
  });
  window.addEventListener('resize', () => {
    if (cards.length) _renderAll();
  });
}

// HP1: 訂閱 timeScale,只訂閱一次,重複呼叫先取消舊的
function _resubscribeTimeScale() {
  try { _unsubTime?.();    } catch {}
  try { _unsubLogical?.(); } catch {}
  _unsubTime = null;
  _unsubLogical = null;

  const chart = refs?.getMainChart?.();
  if (!chart) return;

  try {
    const ts = chart.timeScale();
    const redraw = () => { if (cards.length) _scheduleRedraw(); };

    ts.subscribeVisibleTimeRangeChange(redraw);
    _unsubTime = () => { try { ts.unsubscribeVisibleTimeRangeChange(redraw); } catch {} };

    if (typeof ts.subscribeVisibleLogicalRangeChange === 'function') {
      ts.subscribeVisibleLogicalRangeChange(redraw);
      _unsubLogical = () => { try { ts.unsubscribeVisibleLogicalRangeChange(redraw); } catch {} };
    }
  } catch (e) {
    console.warn('[analysis-panel] subscribeTimeScale failed', e);
  }
}

// ============================================================================
// 顯示說明卡
// ============================================================================
export function showSignalCards(signalCards) {
  // HP2: 按 anchorIdx 排序,讓卡片從左到右,跟錨點順序一致,引線不交叉
  cards = (signalCards || []).slice().sort((a, b) => {
    const ai = a.anchorIdx ?? Number.MAX_SAFE_INTEGER;
    const bi = b.anchorIdx ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
  // 確保已訂閱 timeScale(第一次顯示卡片時建立)
  if (!_unsubTime) _resubscribeTimeScale();
  _renderAll();
}

export function clearSignalCards() {
  cards = [];
  // 取消 timeScale 訂閱
  try { _unsubTime?.();    } catch {}
  try { _unsubLogical?.(); } catch {}
  _unsubTime = null;
  _unsubLogical = null;
  // 取消 pending redraw
  if (_redrawRafId) { cancelAnimationFrame(_redrawRafId); _redrawRafId = null; }
  _destroyPanel();
  _clearLineCanvas();
}

export function updatePanelLayout() {
  if (cards.length) _renderAll();
}

// ============================================================================
// 主渲染流程
// ============================================================================
function _renderAll() {
  if (!cards.length) { _destroyPanel(); _clearLineCanvas(); return; }

  const chartPanel = document.getElementById('chartPanel');
  if (!chartPanel) return;

  // chartArea 是引線 canvas 跟說明卡的共同容器
  const chartArea = chartPanel.querySelector('#chartArea, .chart-area') || chartPanel;

  // 1. 說明區
  _ensurePanel(chartPanel);

  // 2. 渲染說明卡片
  _renderCards();

  // 3. 引線 canvas 掛在 chartArea(跟說明卡同一容器,座標系一致)
  _ensureLineCanvas(chartArea);

  // 4. 等 DOM 更新後畫引線
  requestAnimationFrame(() => _drawLeaderLines());
}

// ============================================================================
// 說明區 DOM
// ============================================================================
function _ensurePanel(chartPanel) {
  // 掛在 #chartArea(K 線容器)裡,top:0 = K 線頂部,永遠不蓋工具列
  const chartArea = chartPanel.querySelector('#chartArea, .chart-area');
  const container = chartArea || chartPanel;

  if (panelEl && panelEl.parentNode === container) return;
  if (panelEl) _destroyPanel();

  panelEl = document.createElement('div');
  panelEl.id = 'analysisSignalPanel';
  panelEl.className = 'asp-panel';

  container.style.position = container.style.position || 'relative';
  container.appendChild(panelEl);
}

function _destroyPanel() {
  _resizeObs?.disconnect();
  _resizeObs = null;
  if (panelEl?.parentNode) panelEl.parentNode.removeChild(panelEl);
  panelEl = null;
}

function _renderCards() {
  if (!panelEl) return;
  panelEl.innerHTML = '';

  cards.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'asp-card';
    el.dataset.cardIdx = i;
    el.style.borderColor = card.color || '#3b82f6';

    const title = document.createElement('div');
    title.className = 'asp-card-title';
    title.style.color = card.color || '#3b82f6';
    title.textContent = card.label;

    // 卡片複製按鈕
    const copyBtn = document.createElement('button');
    copyBtn.className = 'asp-card-copy';
    copyBtn.title = '複製此說明';
    copyBtn.textContent = '📋';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _copyCardText(card, copyBtn);
    });

    const body = document.createElement('div');
    body.className = 'asp-card-body';
    body.innerHTML = (card.lines || [])
      .map(l => `<div class="asp-card-line">${_esc(l)}</div>`)
      .join('');

    // 引線錨點(右下角的小點)
    const anchor = document.createElement('div');
    anchor.className = 'asp-card-anchor';

    el.appendChild(title);
    el.appendChild(copyBtn);
    el.appendChild(body);
    el.appendChild(anchor);
    panelEl.appendChild(el);
  });
}

// 複製卡片文字到剪貼簿
async function _copyCardText(card, btn) {
  const text = `【${card.label}】\n${(card.lines || []).join('\n')}\n— 選股台 Phase 7.1`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    if (btn) {
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied'); }, 1200);
    }
  } catch (e) {
    console.warn('[asp-card-copy] failed', e);
    if (btn) { btn.textContent = '✗'; setTimeout(() => { btn.textContent = '📋'; }, 1200); }
  }
}

// ============================================================================
// 引線 Canvas
// ============================================================================
function _ensureLineCanvas(chartPanel) {
  if (lineCanvas && lineCanvas.parentNode === chartPanel) return;
  if (lineCanvas) { try { lineCanvas.parentNode?.removeChild(lineCanvas); } catch {} }

  lineCanvas = document.createElement('canvas');
  lineCanvas.id = 'asp-line-canvas';
  Object.assign(lineCanvas.style, {
    position:      'absolute',
    top:           '0',
    left:          '0',
    width:         '100%',
    height:        '100%',
    pointerEvents: 'none',
    zIndex:        '7',
  });
  chartPanel.style.position = chartPanel.style.position || 'relative';
  chartPanel.appendChild(lineCanvas);
}

function _clearLineCanvas() {
  if (!lineCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = lineCanvas.getContext('2d');
  ctx.clearRect(0, 0, lineCanvas.width / dpr, lineCanvas.height / dpr);
  try { lineCanvas.parentNode?.removeChild(lineCanvas); } catch {}
  lineCanvas = null;
}

function _drawLeaderLines() {
  if (!lineCanvas || !panelEl || !cards.length) return;

  const chartPanel = lineCanvas.parentNode;
  if (!chartPanel) return;

  // canvas 尺寸同步
  const dpr  = window.devicePixelRatio || 1;
  const pRect = chartPanel.getBoundingClientRect();
  lineCanvas.width  = Math.floor(pRect.width  * dpr);
  lineCanvas.height = Math.floor(pRect.height * dpr);
  lineCanvas.style.width  = pRect.width  + 'px';
  lineCanvas.style.height = pRect.height + 'px';

  const ctx = lineCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, pRect.width, pRect.height);

  // 拿主圖 chart + series 用來轉座標
  const chart  = refs?.getMainChart?.();
  const series = refs?.getCandleSeries?.();
  if (!chart || !series) return;

  const ts = chart.timeScale();
  const mainEl = refs?.getMainChartEl?.();
  if (!mainEl) return;
  const mainRect = mainEl.getBoundingClientRect();

  cards.forEach((card, i) => {
    const cardEl = panelEl.querySelector(`[data-card-idx="${i}"]`);
    if (!cardEl) return;

    const cardRect = cardEl.getBoundingClientRect();

    // 引線從卡片的底部中央出發
    const fromX = cardRect.left - pRect.left + cardRect.width / 2;
    const fromY = cardRect.bottom - pRect.top;

    // K 棒錨點座標
    const anchorX = _getLogicalX(ts, card.anchorIdx, pRect);
    const anchorY = _getPriceY(series, card.anchorPrice, mainEl, pRect, card.anchorAbove);

    if (anchorX == null || anchorY == null) return;

    _drawLeaderLine(ctx, fromX, fromY, anchorX, anchorY, card.color || '#3b82f6');
  });
}

function _getLogicalX(ts, idx, pRect) {
  if (idx == null) return null;
  try {
    const x = ts.logicalToCoordinate(idx);
    if (x == null || !isFinite(x)) return null;
    // x 是相對於 mainChart 容器的座標,需要轉換到 chartPanel 座標
    const mainEl = refs?.getMainChartEl?.();
    if (!mainEl) return null;
    const mainRect = mainEl.getBoundingClientRect();
    return mainRect.left - pRect.left + x;
  } catch { return null; }
}

function _getPriceY(series, price, mainEl, pRect, above) {
  if (price == null) return null;
  try {
    const y = series.priceToCoordinate(price);
    if (y == null || !isFinite(y)) return null;
    const mainRect = mainEl.getBoundingClientRect();
    const absY = mainRect.top - pRect.top + y;
    // above = 引線從上方進入 K 棒(高點),否則從下方(低點)
    return absY + (above ? -8 : 8);
  } catch { return null; }
}

// Excel 風格引線:折角兩段 + 箭頭
function _drawLeaderLine(ctx, x1, y1, x2, y2, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // 折角點:先垂直走到 K 棒同高,再水平到 K 棒
  const midY = y1 + (y2 - y1) * 0.4;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1, midY);   // 向下折
  ctx.lineTo(x2, midY);   // 水平到 K 棒正上方
  ctx.lineTo(x2, y2);     // 向下到錨點
  ctx.stroke();

  ctx.setLineDash([]);

  // 箭頭
  const dir = y2 > midY ? 1 : -1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 5, y2 - dir * 9);
  ctx.lineTo(x2 + 5, y2 - dir * 9);
  ctx.closePath();
  ctx.fill();

  // 起點小圓
  ctx.beginPath();
  ctx.arc(x1, y1, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.restore();
}

// ============================================================================
// 工具
// ============================================================================
function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
