/**
 * pattern-image-ui.js — 圖片線型比對 UI 層
 * 
 * 職責：
 *   - 上傳區（拖曳 / 點擊 / 貼上）
 *   - 預覽 canvas + 辨識結果標示
 *   - 價格範圍輸入（priceMin / priceMax）
 *   - 一鍵重新辨識 / 切換手繪模式
 *   - 辨識完成 → 呼叫 pattern-scan.js 全市場掃描
 * 
 * 不修改：pattern.js / pattern-draw.js / pattern-scan.js / pattern-ui.js
 * 
 * 使用方式：
 *   import { initPatternImageUI } from './pattern-image-ui.js';
 *   initPatternImageUI(containerEl, { onResult });
 * 
 * onResult(normalizedPrices) 會呼叫 pattern-scan.js 既有掃描邏輯
 */

import {
  analyzePatternImage,
  initDrawMode,
  fileToDataURL,
  isImageFile,
  getConfidenceLabel,
} from './pattern-image.js';

// ─── 主初始化 ─────────────────────────────────────────────────────────────────

/**
 * 初始化圖片比對 UI
 * @param {HTMLElement} container - 掛載容器
 * @param {Object} opts
 * @param {Function} opts.onResult - (normalizedPrices: number[]) => void，接掃描
 */
export function initPatternImageUI(container, opts = {}) {
  container.innerHTML = _buildHTML();
  _applyStyles();

  const el = {
    dropZone:    container.querySelector('.pi-drop-zone'),
    fileInput:   container.querySelector('.pi-file-input'),
    previewWrap: container.querySelector('.pi-preview-wrap'),
    previewCanvas: container.querySelector('.pi-preview-canvas'),
    statusBar:   container.querySelector('.pi-status'),
    priceMin:    container.querySelector('.pi-price-min'),
    priceMax:    container.querySelector('.pi-price-max'),
    btnAnalyze:  container.querySelector('.pi-btn-analyze'),
    btnDraw:     container.querySelector('.pi-btn-draw'),
    btnClear:    container.querySelector('.pi-btn-clear'),
    btnScan:     container.querySelector('.pi-btn-scan'),
    miniChart:   container.querySelector('.pi-mini-chart'),
    confidence:  container.querySelector('.pi-confidence'),
  };

  let currentResult  = null;
  let drawMode       = null;
  let isDrawing      = false;
  let currentFile    = null;

  // ── 拖曳上傳 ──────────────────────────────────────────────────────────────

  el.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    el.dropZone.classList.add('pi-drag-over');
  });
  el.dropZone.addEventListener('dragleave', () => {
    el.dropZone.classList.remove('pi-drag-over');
  });
  el.dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    el.dropZone.classList.remove('pi-drag-over');
    const file = e.dataTransfer.files[0];
    if (file && isImageFile(file)) await _handleFile(file);
  });

  // ── 點擊上傳 ──────────────────────────────────────────────────────────────

  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const file = el.fileInput.files[0];
    if (file) await _handleFile(file);
  });

  // ── 貼上（Ctrl+V）──────────────────────────────────────────────────────────

  document.addEventListener('paste', async e => {
    // 只在 container 可見時響應
    if (!container.offsetParent) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) await _handleFile(blob);
        break;
      }
    }
  });

  // ── 重新辨識 ──────────────────────────────────────────────────────────────

  el.btnAnalyze.addEventListener('click', async () => {
    if (currentFile) await _handleFile(currentFile);
  });

  // ── 切換手繪模式 ──────────────────────────────────────────────────────────

  el.btnDraw.addEventListener('click', () => {
    if (!el.previewCanvas.width) {
      _setStatus('請先上傳圖片', 'warn');
      return;
    }
    _toggleDrawMode();
  });

  // ── 清除 ──────────────────────────────────────────────────────────────────

  el.btnClear.addEventListener('click', () => {
    _reset();
  });

  // ── 送出掃描 ──────────────────────────────────────────────────────────────

  el.btnScan.addEventListener('click', () => {
    if (!currentResult?.normalizedPrices?.length) {
      _setStatus('請先上傳圖片或完成描線', 'warn');
      return;
    }
    if (opts.onResult) {
      opts.onResult(currentResult.normalizedPrices);
      _setStatus('已送出掃描 ✓', 'ok');
    }
  });

  // ─── 內部函式 ────────────────────────────────────────────────────────────

  async function _handleFile(file) {
    currentFile = file;
    _exitDrawMode();
    _setStatus('辨識中...', 'loading');
    el.btnScan.disabled = true;

    try {
      const result = await analyzePatternImage(file, {
        priceMin: parseFloat(el.priceMin.value) || undefined,
        priceMax: parseFloat(el.priceMax.value) || undefined,
        previewCanvas: el.previewCanvas,
      });

      currentResult = result;
      el.previewWrap.style.display = 'block';

      // 信心度顯示
      const { text, color } = getConfidenceLabel(result.confidence, result.mode);
      el.confidence.textContent = `辨識信心：${text}`;
      el.confidence.style.color = color;

      // 狀態說明
      const modeText = result.mode === 'kbar'
        ? `K棒模式・${result.kbarCount} 根`
        : result.mode === 'line'
        ? `折線模式・${result.linePointCount} 點`
        : '辨識失敗，請手動描線';

      _setStatus(modeText, result.mode === 'draw' ? 'warn' : 'ok');

      // 畫迷你折線預覽
      _drawMiniChart(el.miniChart, result.normalizedPrices);

      el.btnScan.disabled = result.normalizedPrices.length === 0;

      // 信心低於0.4自動提示切手繪
      if (result.confidence < 0.4 && result.mode !== 'draw') {
        _setStatus(`${modeText}（信心低，建議切手繪模式）`, 'warn');
      }
      if (result.mode === 'draw') {
        _toggleDrawMode(true);
      }
    } catch (err) {
      console.error('[pattern-image-ui] 辨識失敗', err);
      _setStatus('圖片解析失敗，請重試', 'error');
    }
  }

  function _toggleDrawMode(forceOn = false) {
    if (isDrawing && !forceOn) {
      _exitDrawMode();
      return;
    }
    // 進入手繪模式
    isDrawing = true;
    el.btnDraw.textContent = '✏️ 結束描線';
    el.btnDraw.classList.add('pi-btn-active');
    el.previewCanvas.style.cursor = 'crosshair';

    drawMode = initDrawMode(el.previewCanvas, (normalizedPrices, points) => {
      // 描線完成
      currentResult = { normalizedPrices, mode: 'draw', confidence: 1 };
      _drawMiniChart(el.miniChart, normalizedPrices);
      el.confidence.textContent = `辨識信心：手動描線`;
      el.confidence.style.color = '#26a69a';
      _setStatus(`描線完成・${points.length} 點`, 'ok');
      el.btnScan.disabled = false;
      _exitDrawMode();
    });
  }

  function _exitDrawMode() {
    if (drawMode) { drawMode.destroy(); drawMode = null; }
    isDrawing = false;
    el.btnDraw.textContent = '✏️ 手動描線';
    el.btnDraw.classList.remove('pi-btn-active');
    if (el.previewCanvas) el.previewCanvas.style.cursor = 'default';
  }

  function _reset() {
    _exitDrawMode();
    currentResult = null;
    currentFile = null;
    el.previewWrap.style.display = 'none';
    el.previewCanvas.width = 0;
    el.previewCanvas.height = 0;
    el.confidence.textContent = '';
    el.miniChart.innerHTML = '';
    el.btnScan.disabled = true;
    _setStatus('請上傳K線圖或折線圖', '');
    el.fileInput.value = '';
  }

  function _setStatus(msg, type) {
    el.statusBar.textContent = msg;
    el.statusBar.className = 'pi-status';
    if (type) el.statusBar.classList.add(`pi-status-${type}`);
  }

  // 重置
  _reset();
}

// ─── 迷你折線圖 ───────────────────────────────────────────────────────────────

function _drawMiniChart(container, normalizedPrices) {
  if (!normalizedPrices?.length) { container.innerHTML = ''; return; }
  const W = 180, H = 48, PAD = 4;
  const pts = normalizedPrices;
  const xStep = (W - PAD * 2) / (pts.length - 1);

  const svgPts = pts.map((v, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - v) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // 漸層 fill
  const areaClose = pts.map((v, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - v) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaPath = `M ${PAD},${H - PAD} L ${areaClose.join(' L ')} L ${W - PAD},${H - PAD} Z`;

  container.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
      <defs>
        <linearGradient id="pi-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#26a69a" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#26a69a" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#pi-grad)" />
      <polyline points="${svgPts}" fill="none" stroke="#26a69a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

// ─── HTML 模板 ────────────────────────────────────────────────────────────────

function _buildHTML() {
  return `
<div class="pi-root">
  <input type="file" class="pi-file-input" accept="image/*" style="display:none">

  <!-- 上傳區 -->
  <div class="pi-drop-zone">
    <div class="pi-drop-icon">🖼️</div>
    <div class="pi-drop-text">拖曳圖片到此處</div>
    <div class="pi-drop-sub">或點擊選取 / Ctrl+V 貼上截圖</div>
    <div class="pi-drop-sub">支援：K線圖截圖、折線圖、手繪比對</div>
  </div>

  <!-- 價格範圍（選填） -->
  <div class="pi-price-row">
    <label class="pi-label">價格範圍（選填）</label>
    <div class="pi-price-inputs">
      <input type="number" class="pi-price-min pi-input" placeholder="最低價" min="0" step="0.1">
      <span class="pi-price-sep">—</span>
      <input type="number" class="pi-price-max pi-input" placeholder="最高價" min="0" step="0.1">
      <span class="pi-price-unit">元</span>
    </div>
  </div>

  <!-- 預覽區 -->
  <div class="pi-preview-wrap" style="display:none">
    <canvas class="pi-preview-canvas"></canvas>
    <div class="pi-preview-footer">
      <div class="pi-confidence"></div>
      <div class="pi-mini-chart"></div>
    </div>
  </div>

  <!-- 狀態列 -->
  <div class="pi-status">請上傳K線圖或折線圖</div>

  <!-- 工具列 -->
  <div class="pi-toolbar">
    <button class="pi-btn pi-btn-analyze">🔍 重新辨識</button>
    <button class="pi-btn pi-btn-draw">✏️ 手動描線</button>
    <button class="pi-btn pi-btn-clear">🗑️ 清除</button>
    <button class="pi-btn pi-btn-scan pi-btn-primary" disabled>🚀 開始掃描</button>
  </div>
</div>
`;
}

// ─── 內聯樣式（注入一次）────────────────────────────────────────────────────

let _stylesInjected = false;
function _applyStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
/* pattern-image-ui 樣式 */
.pi-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  font-size: 13px;
  color: var(--text, #e0e0e0);
}

/* 上傳區 */
.pi-drop-zone {
  border: 1.5px dashed var(--border, #444);
  border-radius: 10px;
  padding: 24px 16px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  background: var(--bg2, #1a1a1a);
}
.pi-drop-zone:hover,
.pi-drop-zone.pi-drag-over {
  border-color: #26a69a;
  background: rgba(38,166,154,0.06);
}
.pi-drop-icon { font-size: 28px; margin-bottom: 6px; }
.pi-drop-text { font-size: 14px; font-weight: 500; margin-bottom: 4px; color: var(--text, #e0e0e0); }
.pi-drop-sub  { font-size: 11px; color: var(--text2, #888); margin-bottom: 2px; }

/* 價格範圍 */
.pi-price-row   { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pi-label       { font-size: 12px; color: var(--text2, #888); white-space: nowrap; }
.pi-price-inputs{ display: flex; align-items: center; gap: 6px; }
.pi-input {
  width: 80px;
  background: var(--bg2, #1a1a1a);
  border: 1px solid var(--border, #444);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--text, #e0e0e0);
  font-size: 12px;
  outline: none;
}
.pi-input:focus { border-color: #26a69a; }
.pi-price-sep   { color: var(--text2, #888); }
.pi-price-unit  { font-size: 11px; color: var(--text2, #888); }

/* 預覽 */
.pi-preview-wrap {
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}
.pi-preview-canvas {
  display: block;
  width: 100%;
  max-height: 220px;
  object-fit: contain;
  image-rendering: pixelated;
}
.pi-preview-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg2, #1a1a1a);
  border-top: 1px solid var(--border, #333);
}
.pi-confidence { font-size: 11px; }
.pi-mini-chart { line-height: 0; }

/* 狀態列 */
.pi-status        { font-size: 12px; color: var(--text2, #888); min-height: 18px; }
.pi-status-ok     { color: #26a69a; }
.pi-status-warn   { color: #f59e0b; }
.pi-status-error  { color: #ef5350; }
.pi-status-loading{ color: #60a5fa; }

/* 工具列 */
.pi-toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pi-btn {
  flex: 1;
  min-width: 80px;
  padding: 7px 10px;
  background: var(--bg2, #222);
  border: 1px solid var(--border, #444);
  border-radius: 6px;
  color: var(--text, #ddd);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.pi-btn:hover:not(:disabled) { background: var(--bg3, #2a2a2a); border-color: #666; }
.pi-btn:disabled              { opacity: 0.4; cursor: not-allowed; }
.pi-btn-primary {
  background: #26a69a;
  border-color: #26a69a;
  color: #fff;
  font-weight: 500;
}
.pi-btn-primary:hover:not(:disabled) { background: #2bbdb0; }
.pi-btn-active {
  background: rgba(245,158,11,0.15);
  border-color: #f59e0b;
  color: #f59e0b;
}
`;
  document.head.appendChild(style);
}
