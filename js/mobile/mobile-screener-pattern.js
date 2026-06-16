/**
 * mobile-screener-pattern.js
 * 型態比對：結果渲染 + 設定（手繪 Canvas + 圖片匯入）
 */

// ── 圖片模式狀態 ──────────────────────────────────────────────
let _imgResult = null;       // analyzePatternImage 的回傳
let _drawController = null;  // initDrawMode 的 controller

export function renderResult(body, deps) {
  const { AppState, onOpenSheet, getChineseName } = deps;
  const results = AppState?.pattern?.scanResults || [];

  if (!results.length) {
    body.innerHTML = _emptyHTML('〰','尚無型態比對結果','請至「設定掃描 → 型態」手繪走勢或匯入圖片後執行');
    return;
  }
  body.innerHTML = `
    <div class="m-last-scan">型態比對 <span>${results.length} 檔</span></div>
    <div class="m-result-list">
      ${results.slice(0,50).map(r => _resultCardHTML(r, { tags:[`相似度 ${r.score}%`], tagClass:'blue' })).join('')}
    </div>`;
  _bindResultCards(body, results, { icon:'〰', title:'型態比對', mode:'pattern' }, deps);
}

export function renderSetup(body, deps) {
  const { AppState } = deps;
  body.innerHTML = `
    <!-- 模式切換 -->
    <div class="m-s-section" style="padding-bottom:10px">
      <div style="display:flex;gap:8px">
        <button class="m-pd-tab active" data-tab="draw">✏️ 手繪走勢</button>
        <button class="m-pd-tab" data-tab="image">🖼️ 圖片匯入</button>
      </div>
    </div>

    <!-- 手繪區 -->
    <div id="mPdDrawSection" class="m-s-section">
      <div class="m-s-label">手繪走勢</div>
      <div id="mPdDrawWrap" style="background:#0d1117;border-radius:10px;padding:10px;margin-bottom:12px">
        <canvas id="mPdCanvas" style="width:100%;height:110px;background:#0a0e13;border-radius:6px;display:block;cursor:crosshair;touch-action:none"></canvas>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
          <span style="font-size:11px;color:#8b949e" id="mPdMeta">在畫布上繪製理想走勢</span>
          <button id="mPdClear" style="font-size:11px;color:#8b949e;background:#30363d;padding:3px 8px;border-radius:6px;border:none;cursor:pointer">清除</button>
        </div>
      </div>
    </div>

    <!-- 圖片匯入區 -->
    <div id="mPdImageSection" class="m-s-section" style="display:none">
      <div class="m-s-label">圖片匯入</div>
      <input type="file" id="mPdFileInput" accept="image/*" style="display:none">
      <!-- 上傳區 -->
      <div id="mPdDropZone" style="border:1.5px dashed #30363d;border-radius:10px;padding:24px 16px;text-align:center;cursor:pointer;margin-bottom:10px">
        <div style="font-size:28px;margin-bottom:6px">🖼️</div>
        <div style="font-size:13px;font-weight:500;color:#e6edf3;margin-bottom:4px">拖曳圖片到此處</div>
        <div style="font-size:11px;color:#8b949e">或點擊選取 · 支援K線截圖 / 折線圖</div>
      </div>
      <!-- 預覽區 -->
      <div id="mPdImgPreviewWrap" style="display:none;margin-bottom:10px">
        <canvas id="mPdImgCanvas" style="width:100%;border-radius:8px;background:#000;display:block;max-height:180px;object-fit:contain"></canvas>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 2px">
          <span id="mPdImgConfidence" style="font-size:11px;color:#8b949e"></span>
          <div id="mPdImgMiniChart" style="line-height:0"></div>
        </div>
        <div id="mPdImgStatus" style="font-size:12px;color:#8b949e;min-height:16px"></div>
      </div>
      <!-- 描線補救 -->
      <div id="mPdManualWrap" style="display:none;margin-bottom:8px">
        <button id="mPdManualBtn" style="padding:7px 14px;border-radius:9px;background:rgba(245,158,11,0.12);border:0.5px solid rgba(245,158,11,0.3);color:#f59e0b;font-size:13px;cursor:pointer">✏️ 手動描線</button>
        <span id="mPdManualStatus" style="font-size:11px;color:#8b949e;margin-left:8px"></span>
      </div>
    </div>

    <!-- 相似度門檻 -->
    <div class="m-s-section">
      <div class="m-s-label">相似度門檻</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <input type="range" id="mPdSimilarity" min="50" max="95" value="${AppState?.pattern?.similarity||75}" style="flex:1">
        <span id="mPdSimilarityVal" style="font-size:13px;font-weight:600;color:#58a6ff;min-width:36px">${AppState?.pattern?.similarity||75}%</span>
      </div>
    </div>

    <div class="m-run-wrap">
      <button class="m-run-btn" id="mPatternRunBtn" disabled>先在畫布繪製走勢</button>
    </div>`;

  // ── Tab 切換 ──
  body.querySelectorAll('.m-pd-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.m-pd-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      body.querySelector('#mPdDrawSection').style.display  = tab === 'draw'  ? '' : 'none';
      body.querySelector('#mPdImageSection').style.display = tab === 'image' ? '' : 'none';
      // 切到手繪時重設圖片模式狀態（不清除已辨識結果，只切 UI）
      if (tab === 'draw') _exitManualDraw();
    });
  });

  // ── 手繪模式 ──
  _initCanvas(body, deps);

  body.querySelector('#mPdSimilarity')?.addEventListener('input', e => {
    body.querySelector('#mPdSimilarityVal').textContent = e.target.value + '%';
  });

  // ── 圖片模式：點擊上傳 ──
  const dropZone  = body.querySelector('#mPdDropZone');
  const fileInput = body.querySelector('#mPdFileInput');

  dropZone?.addEventListener('click', () => fileInput?.click());
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = '#58a6ff'; });
  dropZone?.addEventListener('dragleave', () => { dropZone.style.borderColor = '#30363d'; });
  dropZone?.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.style.borderColor = '#30363d';
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) await _handleImageFile(file, body, deps);
  });
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (file) await _handleImageFile(file, body, deps);
  });

  // ── 描線補救按鈕 ──
  body.querySelector('#mPdManualBtn')?.addEventListener('click', () => {
    _toggleManualDraw(body, deps);
  });

  // ── 執行按鈕 ──
  body.querySelector('#mPatternRunBtn')?.addEventListener('click', async () => {
    const template = AppState?.pattern?.template;
    if (!template) return;
    const sim = Number(body.querySelector('#mPdSimilarity')?.value||75);
    deps.onClose?.();
    await runScan({ template, similarity: sim }, deps);
  });
}

// ── 圖片處理 ──────────────────────────────────────────────────
async function _handleImageFile(file, body, deps) {
  const statusEl     = body.querySelector('#mPdImgStatus');
  const previewWrap  = body.querySelector('#mPdImgPreviewWrap');
  const confidenceEl = body.querySelector('#mPdImgConfidence');
  const miniChart    = body.querySelector('#mPdImgMiniChart');
  const manualWrap   = body.querySelector('#mPdManualWrap');
  const runBtn       = body.querySelector('#mPatternRunBtn');

  if (statusEl) { statusEl.textContent = '辨識中…'; statusEl.style.color = '#60a5fa'; }

  try {
    const { analyzePatternImage, getConfidenceLabel } = await import('../pattern-image.js');
    const previewCanvas = body.querySelector('#mPdImgCanvas');

    const result = await analyzePatternImage(file, { previewCanvas });
    _imgResult = result;
    previewWrap.style.display = 'block';

    const { text, color } = getConfidenceLabel(result.confidence, result.mode);
    if (confidenceEl) { confidenceEl.textContent = `辨識信心：${text}`; confidenceEl.style.color = color; }

    const modeText = result.mode === 'kbar'
      ? `K棒模式・${result.kbarCount} 根`
      : result.mode === 'line'
      ? `折線模式・${result.linePointCount} 點`
      : '辨識失敗，請手動描線';

    if (statusEl) {
      statusEl.textContent = modeText;
      statusEl.style.color = result.mode === 'draw' ? '#f59e0b' : '#26a69a';
    }

    _drawMiniSVG(miniChart, result.normalizedPrices);

    if (result.normalizedPrices.length > 0) {
      // 轉成 template Candle[]，存進 AppState
      const tpl = _pricestoTemplate(result.normalizedPrices);
      if (deps.AppState?.pattern) deps.AppState.pattern.template = tpl;
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = '開始比對 →'; }
    }

    // 信心低或辨識失敗 → 顯示描線按鈕
    if (result.confidence < 0.4 || result.mode === 'draw') {
      if (manualWrap) manualWrap.style.display = '';
      if (result.mode === 'draw') _toggleManualDraw(body, deps, true);
    } else {
      if (manualWrap) manualWrap.style.display = '';
    }

  } catch(err) {
    if (statusEl) { statusEl.textContent = '圖片解析失敗，請重試'; statusEl.style.color = '#ef5350'; }
  }
}

// ── 手動描線模式（圖片上描線）───────────────────────────────
let _manualActive = false;

function _toggleManualDraw(body, deps, forceOn = false) {
  if (_manualActive && !forceOn) {
    _exitManualDraw();
    body.querySelector('#mPdManualBtn').textContent = '✏️ 手動描線';
    body.querySelector('#mPdManualStatus').textContent = '';
    return;
  }

  const canvas = body.querySelector('#mPdImgCanvas');
  if (!canvas?.width) return;

  _manualActive = true;
  if (body.querySelector('#mPdManualBtn')) body.querySelector('#mPdManualBtn').textContent = '結束描線';

  import('../pattern-image.js').then(({ initDrawMode }) => {
    _drawController = initDrawMode(canvas, (normalizedPrices, points) => {
      _imgResult = { normalizedPrices, mode: 'draw', confidence: 1 };
      const tpl = _pricestoTemplate(normalizedPrices);
      if (deps.AppState?.pattern) deps.AppState.pattern.template = tpl;
      _drawMiniSVG(body.querySelector('#mPdImgMiniChart'), normalizedPrices);
      const runBtn = body.querySelector('#mPatternRunBtn');
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = '開始比對 →'; }
      if (body.querySelector('#mPdManualStatus')) body.querySelector('#mPdManualStatus').textContent = `描線完成・${points.length} 點`;
      _exitManualDraw();
      if (body.querySelector('#mPdManualBtn')) body.querySelector('#mPdManualBtn').textContent = '✏️ 重新描線';
    });
  });
}

function _exitManualDraw() {
  if (_drawController) { _drawController.destroy(); _drawController = null; }
  _manualActive = false;
}

// ── normalizedPrices[] → Candle[] ──────────────────────────
function _pricestoTemplate(normalizedPrices) {
  const now = Math.floor(Date.now() / 1000);
  return normalizedPrices.map((v, i) => {
    const close = v * 100;
    return {
      time:   now - (normalizedPrices.length - 1 - i) * 86400,
      open:   close, high: close + 0.5, low: close - 0.5, close,
      volume: 1000,
    };
  });
}

// ── 迷你 SVG 折線 ─────────────────────────────────────────────
function _drawMiniSVG(container, prices) {
  if (!container || !prices?.length) return;
  const W = 120, H = 36, PAD = 3;
  const pts = prices;
  const xStep = (W - PAD * 2) / (pts.length - 1);
  const svgPts = pts.map((v, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - v) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  container.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
    <polyline points="${svgPts}" fill="none" stroke="#26a69a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ── Canvas 手繪（手繪 tab 用）────────────────────────────────
function _initCanvas(body, deps) {
  const canvas = body.querySelector('#mPdCanvas');
  if (!canvas) return;
  const wrap = body.querySelector('#mPdDrawWrap');
  canvas.width  = (wrap?.clientWidth||300) - 20;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');
  _clearCanvas(ctx, canvas);
  let drawing = false, pts = [];

  const getPos = (e) => {
    const r = canvas.getBoundingClientRect();
    const scaleX = canvas.width / r.width;
    const scaleY = canvas.height / r.height;
    const src = e.touches ? e.touches[0] : e;
    return { x:(src.clientX-r.left)*scaleX, y:(src.clientY-r.top)*scaleY };
  };
  const onStart = e => { e.preventDefault(); drawing=true; pts=[getPos(e)]; };
  const onMove  = e => { e.preventDefault(); if(!drawing) return; pts.push(getPos(e)); _redraw(ctx,canvas,pts); };
  const onEnd   = () => {
    if (!drawing) return; drawing=false;
    if (pts.length < 5) return;
    const template = _ptsToCandles(pts, canvas.width, canvas.height);
    if (deps.AppState?.pattern) deps.AppState.pattern.template = template;
    body.querySelector('#mPdMeta').textContent = `手繪 ${template.length} 根`;
    const btn = body.querySelector('#mPatternRunBtn');
    if (btn) { btn.disabled=false; btn.textContent='開始比對 →'; }
  };

  canvas.addEventListener('mousedown', onStart);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onEnd);
  canvas.addEventListener('mouseleave', onEnd);
  canvas.addEventListener('touchstart', onStart, {passive:false});
  canvas.addEventListener('touchmove',  onMove,  {passive:false});
  canvas.addEventListener('touchend',   onEnd);

  body.querySelector('#mPdClear')?.addEventListener('click', () => {
    pts=[]; _clearCanvas(ctx,canvas);
    if (deps.AppState?.pattern) deps.AppState.pattern.template=null;
    body.querySelector('#mPdMeta').textContent='在畫布上繪製理想走勢';
    const btn=body.querySelector('#mPatternRunBtn');
    if(btn){btn.disabled=true;btn.textContent='先在畫布繪製走勢';}
  });
}

function _clearCanvas(ctx, canvas) {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
  for(let y=0;y<=canvas.height;y+=44){ ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke(); }
  ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.setLineDash([4,4]);
  ctx.beginPath();ctx.moveTo(0,canvas.height/2);ctx.lineTo(canvas.width,canvas.height/2);ctx.stroke();
  ctx.setLineDash([]);
}
function _redraw(ctx, canvas, pts) {
  _clearCanvas(ctx,canvas);
  if(pts.length<2) return;
  ctx.strokeStyle='#ef5350';ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y);
  ctx.stroke();
}
function _ptsToCandles(pts, w, h) {
  const sampled = pts.length>40 ? Array.from({length:40},(_,i)=>pts[Math.round(i*(pts.length-1)/39)]) : pts;
  const now = Math.floor(Date.now()/1000);
  return sampled.map((p,i)=>{
    const close=((h-p.y)/h)*100;
    return {time:now-(sampled.length-1-i)*86400,open:close,high:close+0.5,low:close-0.5,close,volume:1000};
  });
}

export async function runScan(opts, deps) {
  const { showScanOverlay, hideScanOverlay, updateProgress, onResult, onDone } = deps;
  showScanOverlay?.('型態比對中…');
  try {
    const { runPatternScan } = await import('../pattern-scan.js');
    const gen = runPatternScan(opts.template, { similarity: opts.similarity });
    for await (const evt of gen) {
      if (evt.type==='progress') updateProgress?.(evt.done, evt.total, evt.message);
      if (evt.type==='result')   onResult?.(evt.item);
      if (evt.type==='done')     break;
    }
    onDone?.('pattern');
  } catch(e) {
    deps.showToast?.('掃描失敗：'+e.message);
  } finally {
    hideScanOverlay?.();
  }
}

function _resultCardHTML(r, opts={}) {
  const up = (r.pct??r.chgPct??0)>=0;
  const clr = up?'#ef5350':'#26a69a';
  return `<div class="m-rc" data-code="${r.code}">
    <div class="m-rc-info">
      <div class="m-rc-name">${r.name||r.code}</div>
      <div class="m-rc-code">${r.code}</div>
      <div class="m-rc-badge">${(opts.tags||[]).map(t=>`<span class="m-rc-tag ${opts.tagClass||''}">${t}</span>`).join('')}</div>
    </div>
    <div class="m-rc-r">
      <div class="m-rc-price" style="color:${clr}">${r.price?Number(r.price).toFixed(2):'—'}</div>
      ${r.pct!=null||r.chgPct!=null?`<div class="m-rc-pct ${up?'m-up-bg':'m-dn-bg'}">${up?'+':''}${Number(r.pct??r.chgPct).toFixed(2)}%</div>`:''}
    </div>
  </div>`;
}
function _bindResultCards(body, results, meta, deps) {
  body.querySelectorAll('.m-rc').forEach((el,i)=>{
    el.addEventListener('click',()=>(window.__mobileOpenPreview||window.__loadStock)?.(results[i]?.code||el.dataset.code));
  });
}
function _emptyHTML(icon,title,desc){
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
