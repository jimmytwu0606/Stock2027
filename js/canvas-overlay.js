// js/canvas-overlay.js
// ============================================================================
// Phase 7 — Canvas Overlay 底層共用模組
// ============================================================================
// 在 K 線容器上疊一層 <canvas>,用於 Phase 7 編輯模式繪製標註。
// 設計上獨立於 Phase 3 的 pattern-draw.js,兩者不互相影響。
//
// 對外 API:
//   initOverlay(containerEl, opts) → overlay
//     overlay.setChart(chart, series)
//     overlay.priceToY / yToPrice
//     overlay.timeToX / xToTime
//     overlay.xToLogical / logicalToX
//     overlay.render(drawFn)
//     overlay.enable() / disable()
//     overlay.on(event, handler) / off(event, handler)
//     overlay.destroy()
//
// 註: Lightweight Charts v4.1.x 提供:
//   timeScale().subscribeVisibleTimeRangeChange(cb)
//   timeScale().subscribeVisibleLogicalRangeChange(cb)
//   timeScale().coordinateToLogical(x) / logicalToCoordinate(idx)
//   timeScale().coordinateToTime(x)    / timeToCoordinate(time)
//   series.priceToCoordinate(price)    / coordinateToPrice(y)
// ============================================================================

const OVERLAY_Z = 5;

export function initOverlay(containerEl, opts = {}) {
  if (!containerEl) throw new Error('[canvas-overlay] containerEl is required');
  const mode = opts.mode || 'edit';
  const id   = opts.id   || `overlay-${mode}-${Math.random().toString(36).slice(2, 7)}`;

  // ---------- DOM ----------
  const cs = getComputedStyle(containerEl);
  if (cs.position === 'static') containerEl.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.id = id;
  canvas.dataset.overlayMode = mode;
  Object.assign(canvas.style, {
    position:      'absolute',
    top:           '0',
    left:          '0',
    width:         '100%',
    height:        '100%',
    pointerEvents: 'none',
    zIndex:        String(OVERLAY_Z),
    touchAction:   'none',
  });
  containerEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // ---------- 狀態 ----------
  let chart = null;
  let series = null;
  let drawFn = null;
  let enabled = false;
  let resizeObs = null;
  let unsubTime = null;
  let unsubLogical = null;
  let rafId = 0;                   // ⚠ 必須在 resize() 之前宣告(resize → requestRender 會讀它)
  const listeners = {
    mousedown:  [], mousemove: [], mouseup: [],
    click:      [], dblclick:  [], leave:   [],
    render:     [],
  };

  // ---------- DPR / Resize ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = containerEl.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestRender();
  }
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(containerEl);
  resize();

  // ---------- 座標轉換 ----------
  function priceToY(price) {
    if (!series || price == null) return null;
    try {
      const y = series.priceToCoordinate(price);
      return (y == null || !Number.isFinite(y)) ? null : y;
    } catch { return null; }
  }
  function yToPrice(y) {
    if (!series || y == null) return null;
    try {
      const p = series.coordinateToPrice(y);
      return (p == null || !Number.isFinite(p)) ? null : p;
    } catch { return null; }
  }
  function timeToX(time) {
    if (!chart || time == null) return null;
    try {
      const x = chart.timeScale().timeToCoordinate(time);
      return (x == null || !Number.isFinite(x)) ? null : x;
    } catch { return null; }
  }
  function xToTime(x) {
    if (!chart || x == null) return null;
    try {
      const t = chart.timeScale().coordinateToTime(x);
      return t ?? null;
    } catch { return null; }
  }
  function xToLogical(x) {
    if (!chart || x == null) return null;
    try {
      const idx = chart.timeScale().coordinateToLogical(x);
      return (idx == null || !Number.isFinite(idx)) ? null : idx;
    } catch { return null; }
  }
  function logicalToX(idx) {
    if (!chart || idx == null) return null;
    try {
      const x = chart.timeScale().logicalToCoordinate(idx);
      return (x == null || !Number.isFinite(x)) ? null : x;
    } catch { return null; }
  }

  // ---------- Render ----------
  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (drawFn) {
        try { drawFn(ctx, helpers); } catch (e) { console.error('[overlay drawFn]', e); }
      }
      listeners.render.forEach(fn => {
        try { fn(ctx, helpers); } catch (e) { console.error('[overlay render]', e); }
      });
    });
  }
  function render(fn) {
    drawFn = fn || null;
    requestRender();
  }

  const helpers = {
    priceToY, yToPrice,
    timeToX, xToTime,
    xToLogical, logicalToX,
    get width()  { return canvas.getBoundingClientRect().width;  },
    get height() { return canvas.getBoundingClientRect().height; },
    get mode()   { return mode; },
  };

  // ---------- Chart 訂閱 ----------
  function setChart(chartInstance, candleSeries) {
    if (unsubTime)    { try { unsubTime();    } catch {} unsubTime    = null; }
    if (unsubLogical) { try { unsubLogical(); } catch {} unsubLogical = null; }

    chart  = chartInstance || null;
    series = candleSeries  || null;

    if (!chart) { requestRender(); return; }

    try {
      const ts = chart.timeScale();
      const onChange = () => requestRender();
      ts.subscribeVisibleTimeRangeChange(onChange);
      unsubTime = () => { try { ts.unsubscribeVisibleTimeRangeChange(onChange); } catch {} };

      if (typeof ts.subscribeVisibleLogicalRangeChange === 'function') {
        ts.subscribeVisibleLogicalRangeChange(onChange);
        unsubLogical = () => { try { ts.unsubscribeVisibleLogicalRangeChange(onChange); } catch {} };
      }
    } catch (e) { console.warn('[canvas-overlay] subscribe timeScale failed', e); }

    requestRender();
  }

  // ---------- 滑鼠 ----------
  function getLocalXY(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX ?? (e.touches?.[0]?.clientX) ?? 0;
    const cy = e.clientY ?? (e.touches?.[0]?.clientY) ?? 0;
    return { x: cx - rect.left, y: cy - rect.top };
  }
  function fire(name, e) {
    const { x, y } = getLocalXY(e);
    const evt = {
      x, y,
      price:   yToPrice(y),
      time:    xToTime(x),
      logical: xToLogical(x),
      raw:     e,
    };
    listeners[name]?.forEach(fn => {
      try { fn(evt); } catch (err) { console.error(err); }
    });
  }
  const _md = e => fire('mousedown', e);
  const _mm = e => fire('mousemove', e);
  const _mu = e => fire('mouseup',   e);
  const _ck = e => fire('click',     e);
  const _dc = e => fire('dblclick',  e);
  const _ml = e => fire('leave',     e);

  function enable() {
    if (enabled) return;
    canvas.style.pointerEvents = 'auto';
    canvas.addEventListener('mousedown', _md);
    canvas.addEventListener('mousemove', _mm);
    canvas.addEventListener('mouseup',   _mu);
    canvas.addEventListener('click',     _ck);
    canvas.addEventListener('dblclick',  _dc);
    canvas.addEventListener('mouseleave',_ml);
    enabled = true;
  }
  function disable() {
    if (!enabled) return;
    canvas.style.pointerEvents = 'none';
    canvas.removeEventListener('mousedown', _md);
    canvas.removeEventListener('mousemove', _mm);
    canvas.removeEventListener('mouseup',   _mu);
    canvas.removeEventListener('click',     _ck);
    canvas.removeEventListener('dblclick',  _dc);
    canvas.removeEventListener('mouseleave',_ml);
    enabled = false;
  }

  function on(event, handler) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
  }
  function off(event, handler) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(h => h !== handler);
  }

  function destroy() {
    disable();
    if (resizeObs)    try { resizeObs.disconnect(); } catch {}
    if (unsubTime)    try { unsubTime();    } catch {}
    if (unsubLogical) try { unsubLogical(); } catch {}
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    chart = series = drawFn = null;
    Object.keys(listeners).forEach(k => listeners[k] = []);
  }

  return {
    mode, canvas, ctx,
    setChart,
    priceToY, yToPrice,
    timeToX, xToTime,
    xToLogical, logicalToX,
    render, requestRender,
    enable, disable,
    on, off,
    destroy,
  };
}
