/**
 * pattern-image.js — 圖片線型分析模組
 * 
 * 職責：
 *   1. 接收圖片（File/Blob/DataURL）
 *   2. 自動識別「折線圖」或「K棒圖」
 *   3. 提取價格走勢，正規化成 normalizedPrices[]
 *   4. 提供「描線補救」模式（辨識失敗時讓用戶手動描）
 *   5. 輸出給 pattern.js / pattern-scan.js 使用（介面不變）
 * 
 * 不修改：pattern.js / pattern-draw.js / pattern-scan.js / pattern-ui.js
 * 
 * 使用方式：
 *   import { analyzePatternImage, initDrawMode } from './pattern-image.js';
 *   const result = await analyzePatternImage(file, { priceMin, priceMax });
 *   // result.normalizedPrices → 送進 pattern-scan.js
 *   // result.mode → 'kbar' | 'line' | 'draw'
 *   // result.confidence → 0~1
 */

// ─── 常數 ───────────────────────────────────────────────────────────────────

const IMG_MAX_WIDTH  = 1200;   // 超過此寬度縮放（避免太慢）
const IMG_MAX_HEIGHT = 800;
const TARGET_POINTS  = 30;     // 正規化輸出點數（跟 pattern-draw.js 一致）
const MIN_KBAR_PX    = 3;      // K棒色塊至少要有幾px才算有效
const LINE_SCORE_MIN = 40;     // 折線像素最小顏色強度（RGB差值）

// 台股K棒色彩定義（黑底平台）
const KBAR_COLORS = {
  // 紅K（漲）
  red: (r, g, b) => r > 140 && r - g > 60 && r - b > 40,
  // 青/綠K（跌）- TradingView 台股用青色
  teal: (r, g, b) => g > 100 && b > 100 && g - r > 20 && r < 140,
  // 也支援綠K（其他平台）
  green: (r, g, b) => g > 130 && g - r > 50 && g - b > 20,
  // 折線（紅色）
  redLine: (r, g, b) => (r - Math.max(g, b)) > LINE_SCORE_MIN,
  // 折線（白色，部分平台）
  whiteLine: (r, g, b) => r > 180 && g > 180 && b > 180,
  // 折線（黃/橘色，部分平台）
  yellowLine: (r, g, b) => r > 160 && g > 120 && b < 80 && r > g,
};

// 背景色判斷（暗底）
const isBgDark = (r, g, b) => r < 50 && g < 50 && b < 50;
const isBgLight = (r, g, b) => r > 200 && g > 200 && b > 200;

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * 分析圖片，提取線型
 * @param {File|Blob|string} source - 圖片檔案或 dataURL
 * @param {Object} opts
 * @param {number} [opts.priceMin] - 使用者輸入的最低價（選填，目前只做形狀比對不需要）
 * @param {number} [opts.priceMax] - 使用者輸入的最高價（選填）
 * @param {HTMLCanvasElement} [opts.previewCanvas] - 預覽用 canvas（選填，會畫出辨識結果）
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzePatternImage(source, opts = {}) {
  const img = await _loadImage(source);
  const { canvas, ctx } = _prepareCanvas(img);
  const { data: pixels, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // 偵測圖片類型
  const bgType = _detectBackground(pixels, width, height);
  const kbarInfo = _detectKBarMode(pixels, width, height, bgType);
  const lineInfo = _detectLineMode(pixels, width, height, bgType);

  let mode, normalizedPrices, confidence, debugPoints;

  if (kbarInfo.score > lineInfo.score && kbarInfo.kbars.length >= 5) {
    // K棒模式
    mode = 'kbar';
    const closes = kbarInfo.kbars.map(k => k.midY);
    normalizedPrices = _normalizeY(closes, height);
    confidence = Math.min(1, kbarInfo.kbars.length / 20);
    debugPoints = kbarInfo.kbars.map(k => ({ x: k.cx, y: k.midY, type: k.isRed ? 'red' : 'teal' }));
  } else if (lineInfo.points.length >= 5) {
    // 折線模式
    mode = 'line';
    const ys = lineInfo.points.map(p => p.y);
    normalizedPrices = _normalizeY(ys, height);
    confidence = Math.min(1, lineInfo.points.length / 30);
    debugPoints = lineInfo.points.map(p => ({ x: p.x, y: p.y, type: 'line' }));
  } else {
    // 辨識失敗，回退到描線模式
    mode = 'draw';
    normalizedPrices = [];
    confidence = 0;
    debugPoints = [];
  }

  // 降採樣到 TARGET_POINTS
  if (normalizedPrices.length > TARGET_POINTS) {
    normalizedPrices = _downsample(normalizedPrices, TARGET_POINTS);
  }

  // 畫到預覽 canvas
  if (opts.previewCanvas) {
    _drawDebugOverlay(opts.previewCanvas, canvas, debugPoints, mode, width, height);
  }

  return {
    normalizedPrices,
    mode,
    confidence,
    kbarCount: kbarInfo.kbars.length,
    linePointCount: lineInfo.points.length,
    imageSize: { width, height },
    bgType,
    _rawCanvas: canvas,
    _debugPoints: debugPoints,
  };
}

// ─── 圖片載入 ────────────────────────────────────────────────────────────────

function _loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (typeof source === 'string') {
      img.src = source;
    } else {
      img.src = URL.createObjectURL(source);
    }
  });
}

function _prepareCanvas(img) {
  let w = img.naturalWidth, h = img.naturalHeight;
  // 縮放避免太大
  if (w > IMG_MAX_WIDTH) { h = Math.round(h * IMG_MAX_WIDTH / w); w = IMG_MAX_WIDTH; }
  if (h > IMG_MAX_HEIGHT) { w = Math.round(w * IMG_MAX_HEIGHT / h); h = IMG_MAX_HEIGHT; }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

// ─── 背景偵測 ────────────────────────────────────────────────────────────────

/**
 * 偵測背景類型：dark / light / unknown
 * 採樣四個角落判斷
 */
function _detectBackground(pixels, width, height) {
  const corners = [
    [5, 5], [width - 6, 5], [5, height - 6], [width - 6, height - 6],
  ];
  let darkCount = 0, lightCount = 0;
  for (const [x, y] of corners) {
    const i = (y * width + x) * 4;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (isBgDark(r, g, b)) darkCount++;
    else if (isBgLight(r, g, b)) lightCount++;
  }
  if (darkCount >= 2) return 'dark';
  if (lightCount >= 2) return 'light';
  return 'unknown';
}

// ─── K棒模式偵測 ─────────────────────────────────────────────────────────────

/**
 * 掃描全圖，找 K 棒色塊群組
 * 策略：
 *   1. 每列掃描是否有 red/teal/green 色塊
 *   2. 連續有色的 x 欄視為同一根 K 棒
 *   3. 統計每根 K 棒的 high_y / low_y / midY / isRed
 */
function _detectKBarMode(pixels, width, height, bgType) {
  // 根據背景調整色彩條件
  const isKBarColor = bgType === 'light'
    ? (r, g, b) => (KBAR_COLORS.red(r, g, b) || KBAR_COLORS.green(r, g, b))
    : (r, g, b) => (KBAR_COLORS.red(r, g, b) || KBAR_COLORS.teal(r, g, b) || KBAR_COLORS.green(r, g, b));

  const isRedColor = (r, g, b) => KBAR_COLORS.red(r, g, b);

  // 1. 掃描每欄有無K棒色塊
  const colHasKBar = new Uint8Array(width);
  const colRedCount = new Int32Array(width);
  const colTealCount = new Int32Array(width);
  const colHighY = new Int32Array(width).fill(height);
  const colLowY = new Int32Array(width).fill(-1);

  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (isKBarColor(r, g, b)) {
        count++;
        if (y < colHighY[x]) colHighY[x] = y;
        if (y > colLowY[x]) colLowY[x] = y;
        if (isRedColor(r, g, b)) colRedCount[x]++;
        else colTealCount[x]++;
      }
    }
    if (count >= MIN_KBAR_PX) colHasKBar[x] = 1;
  }

  // 2. 連續有色欄合併成一根 K 棒
  const kbars = [];
  let inBar = false, barStart = 0, gap = 0;

  for (let x = 0; x <= width; x++) {
    if (colHasKBar[x]) {
      if (!inBar) { inBar = true; barStart = x; }
      gap = 0;
    } else {
      if (inBar) {
        gap++;
        if (gap > 4) {
          // 結束一根K棒
          const barEnd = x - gap;
          const cx = Math.round((barStart + barEnd) / 2);
          // 取這根K棒範圍內所有欄的 high/low
          let highY = height, lowY = -1;
          let redCnt = 0, tealCnt = 0;
          for (let bx = barStart; bx <= barEnd; bx++) {
            if (colHasKBar[bx]) {
              if (colHighY[bx] < highY) highY = colHighY[bx];
              if (colLowY[bx] > lowY) lowY = colLowY[bx];
              redCnt += colRedCount[bx];
              tealCnt += colTealCount[bx];
            }
          }
          if (lowY > highY) {
            kbars.push({
              cx, highY, lowY,
              midY: (highY + lowY) / 2,
              isRed: redCnt >= tealCnt,
              width: barEnd - barStart + 1,
            });
          }
          inBar = false;
          gap = 0;
        }
      }
    }
  }

  // 過濾掉異常的（太高太矮、偏離主群）
  const filteredKbars = _filterOutlierKbars(kbars, height);

  // 計算信心分數：K棒數量 × 密度
  const score = filteredKbars.length >= 5
    ? filteredKbars.length * 2
    : 0;

  return { kbars: filteredKbars, score };
}

/**
 * 去除明顯偏離群體的 K 棒（如均線色塊誤判）
 */
function _filterOutlierKbars(kbars, height) {
  if (kbars.length < 3) return kbars;

  // 計算中位數 midY
  const mids = kbars.map(k => k.midY).sort((a, b) => a - b);
  const median = mids[Math.floor(mids.length / 2)];
  const mad = _median(mids.map(v => Math.abs(v - median)));
  const threshold = Math.max(mad * 5, height * 0.4);

  return kbars.filter(k => Math.abs(k.midY - median) < threshold);
}

function _median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ─── 折線模式偵測 ─────────────────────────────────────────────────────────────

/**
 * 掃描全圖找折線
 * 策略：每列找「顏色得分最高」的像素（非背景的最顯著色彩）
 * 支援紅線、白線、黃線
 */
function _detectLineMode(pixels, width, height, bgType) {
  const points = [];
  const MIN_COVERAGE = Math.floor(width * 0.3); // 至少覆蓋30%寬度才算有效折線

  // 決定「線條色彩得分」函數
  // 同時嘗試多種顏色，取最高分
  function lineScore(r, g, b) {
    const scores = [
      r - Math.max(g, b),              // 紅線
      Math.min(r, g) - b + 30,         // 黃/橙線（R≈G高，B低）
      Math.min(r, g, b) - 30,          // 白線（全高）
    ];
    return Math.max(...scores);
  }

  for (let x = 0; x < width; x++) {
    let bestY = -1, bestScore = -Infinity;

    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];

      // 跳過背景
      if (bgType === 'dark' && isBgDark(r, g, b)) continue;
      if (bgType === 'light' && isBgLight(r, g, b)) continue;

      const score = lineScore(r, g, b);
      if (score > LINE_SCORE_MIN && score > bestScore) {
        bestScore = score;
        bestY = y;
      }
    }

    if (bestY >= 0) {
      points.push({ x, y: bestY, score: bestScore });
    }
  }

  // 平滑：去除跳動太大的離群點
  const smoothed = _smoothLinePoints(points, height);

  // 信心分數
  const score = smoothed.length >= MIN_COVERAGE ? smoothed.length : 0;

  return { points: smoothed, score };
}

/**
 * 平滑折線點：去除跳動超過高度15%的點
 */
function _smoothLinePoints(points, height) {
  if (points.length < 3) return points;
  const maxJump = height * 0.15;
  const result = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const dy = Math.abs(points[i].y - result[result.length - 1].y);
    if (dy < maxJump) {
      result.push(points[i]);
    }
    // 跳過離群點，繼續找下一個
  }
  return result;
}

// ─── 正規化 ──────────────────────────────────────────────────────────────────

/**
 * Y 像素序列 → 0~1 正規化
 * 注意：y軸反轉（y小=高價）
 */
function _normalizeY(ys, height) {
  if (ys.length === 0) return [];
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const range = yMax - yMin || 1;
  return ys.map(y => (yMax - y) / range); // 反轉：y越小→值越大
}

/**
 * 降採樣到 targetN 個點（等間距取樣）
 */
function _downsample(arr, targetN) {
  if (arr.length <= targetN) return arr;
  const result = [];
  const step = (arr.length - 1) / (targetN - 1);
  for (let i = 0; i < targetN; i++) {
    const idx = Math.round(i * step);
    result.push(arr[Math.min(idx, arr.length - 1)]);
  }
  return result;
}

// ─── 預覽疊加層 ──────────────────────────────────────────────────────────────

/**
 * 在用戶提供的 previewCanvas 上畫出辨識結果
 * @param {HTMLCanvasElement} previewCanvas
 * @param {HTMLCanvasElement} sourceCanvas - 解析後的原圖 canvas
 * @param {Array} debugPoints
 * @param {string} mode
 * @param {number} width
 * @param {number} height
 */
function _drawDebugOverlay(previewCanvas, sourceCanvas, debugPoints, mode, width, height) {
  previewCanvas.width = width;
  previewCanvas.height = height;
  const ctx = previewCanvas.getContext('2d');

  // 畫原圖
  ctx.drawImage(sourceCanvas, 0, 0);

  // 依模式畫疊加
  if (mode === 'kbar') {
    ctx.strokeStyle = 'rgba(255, 220, 0, 0.9)';
    ctx.lineWidth = 1;
    // 在每根K棒畫一個菱形標記
    debugPoints.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.strokeStyle = p.type === 'red' ? 'rgba(255,200,0,0.9)' : 'rgba(0,255,200,0.9)';
      ctx.stroke();
    });
    // 連線
    if (debugPoints.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,220,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.moveTo(debugPoints[0].x, debugPoints[0].y);
      debugPoints.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  } else if (mode === 'line') {
    // 折線模式：畫黃色點連線
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,220,0,0.85)';
    ctx.lineWidth = 2;
    debugPoints.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  // 左上角標示模式
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(4, 4, mode === 'kbar' ? 90 : mode === 'line' ? 80 : 100, 22);
  ctx.fillStyle = '#FFD700';
  ctx.font = '11px monospace';
  ctx.fillText(
    mode === 'kbar' ? `K棒 ${debugPoints.length}根` :
    mode === 'line' ? `折線 ${debugPoints.length}點` : '請手動描線',
    8, 19
  );
}

// ─── 描線補救模式 ─────────────────────────────────────────────────────────────

/**
 * 在 canvas 上啟動「手動描線」模式
 * 用戶在圖片上畫折線，輸出 normalizedPrices[]
 * 
 * @param {HTMLCanvasElement} canvas - 顯示圖片的 canvas
 * @param {Function} onComplete - 完成後回呼 (normalizedPrices) => void
 * @returns {{ destroy: Function }} - 呼叫 destroy() 解除事件
 */
export function initDrawMode(canvas, onComplete) {
  const ctx = canvas.getContext('2d');
  const points = []; // { x, y }
  let drawing = false;

  // 畫線樣式
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function onStart(e) {
    e.preventDefault();
    drawing = true;
    points.length = 0;
    const pos = getPos(e);
    points.push(pos);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  }

  function onMove(e) {
    e.preventDefault();
    if (!drawing) return;
    const pos = getPos(e);
    // 只在 x 前進時記錄（保持單調）
    if (points.length === 0 || pos.x > points[points.length - 1].x) {
      points.push(pos);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    }
  }

  function onEnd(e) {
    e.preventDefault();
    if (!drawing || points.length < 3) return;
    drawing = false;

    // 提取 Y 序列正規化
    const ys = points.map(p => p.y);
    const normalized = _normalizeY(ys, canvas.height);
    const downsampled = _downsample(normalized, TARGET_POINTS);

    onComplete(downsampled, points);
  }

  // 綁定 mouse + touch
  canvas.addEventListener('mousedown', onStart);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onEnd);
  canvas.addEventListener('touchstart', onStart, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onEnd, { passive: false });

  // 顯示提示
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, canvas.height - 30, canvas.width, 30);
  ctx.fillStyle = '#FFD700';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('在圖上從左到右畫出走勢線', canvas.width / 2, canvas.height - 12);
  ctx.textAlign = 'left';

  return {
    destroy() {
      canvas.removeEventListener('mousedown', onStart);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup', onEnd);
      canvas.removeEventListener('touchstart', onStart);
      canvas.removeEventListener('touchmove', onMove);
      canvas.removeEventListener('touchend', onEnd);
    },
    getPoints() { return [...points]; },
    clear() {
      points.length = 0;
    },
  };
}

// ─── 工具函式（可供外部使用）────────────────────────────────────────────────

/**
 * 把 File/Blob 轉成 dataURL（方便預覽）
 */
export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * 判斷檔案是否為圖片
 */
export function isImageFile(file) {
  return file && file.type.startsWith('image/');
}

/**
 * 根據信心值給出建議文字
 */
export function getConfidenceLabel(confidence, mode) {
  if (mode === 'draw') return { text: '手動描線', color: '#aaa' };
  if (confidence >= 0.7) return { text: `高 (${Math.round(confidence * 100)}%)`, color: '#26a69a' };
  if (confidence >= 0.4) return { text: `中 (${Math.round(confidence * 100)}%)`, color: '#f59e0b' };
  return { text: `低 (${Math.round(confidence * 100)}%)`, color: '#ef5350' };
}
