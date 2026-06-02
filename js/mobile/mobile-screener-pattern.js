/**
 * mobile-screener-pattern.js
 * 型態比對：結果渲染 + 設定（手繪 Canvas）
 */

export function renderResult(body, deps) {
  const { AppState, onOpenSheet, getChineseName } = deps;
  const results = AppState?.pattern?.scanResults || [];

  if (!results.length) {
    body.innerHTML = _emptyHTML('〰','尚無型態比對結果','請至「設定掃描 → 型態」手繪走勢後執行');
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
    <div class="m-s-section">
      <div class="m-s-label">手繪走勢</div>
      <div id="mPdDrawWrap" style="background:#0d1117;border-radius:10px;padding:10px;margin-bottom:12px">
        <canvas id="mPdCanvas" style="width:100%;height:110px;background:#0a0e13;border-radius:6px;display:block;cursor:crosshair;touch-action:none"></canvas>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
          <span style="font-size:11px;color:#3d444d" id="mPdMeta">在畫布上繪製理想走勢</span>
          <button id="mPdClear" style="font-size:11px;color:#8b949e;background:#30363d;padding:3px 8px;border-radius:6px;border:none;cursor:pointer">清除</button>
        </div>
      </div>
      <div class="m-s-label">相似度門檻</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <input type="range" id="mPdSimilarity" min="50" max="95" value="${AppState?.pattern?.similarity||75}" style="flex:1">
        <span id="mPdSimilarityVal" style="font-size:13px;font-weight:600;color:#58a6ff;min-width:36px">${AppState?.pattern?.similarity||75}%</span>
      </div>
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mPatternRunBtn" disabled>先在畫布繪製走勢</button>
    </div>`;

  _initCanvas(body, deps);

  body.querySelector('#mPdSimilarity')?.addEventListener('input', e => {
    body.querySelector('#mPdSimilarityVal').textContent = e.target.value + '%';
  });

  body.querySelector('#mPatternRunBtn')?.addEventListener('click', async () => {
    const template = AppState?.pattern?.template;
    if (!template) return;
    const sim = Number(body.querySelector('#mPdSimilarity')?.value||75);
    deps.onClose?.();
    await runScan({ template, similarity: sim }, deps);
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

// ── Canvas 手繪 ──────────────────────────────────────────
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
    el.addEventListener('click',()=>window.__loadStock?.(results[i]?.code||el.dataset.code));
  });
}
function _emptyHTML(icon,title,desc){
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
