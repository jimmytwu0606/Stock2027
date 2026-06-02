/**
 * mobile-screener.js — Phase 10 手機版篩選骨架
 * 只負責：DOM 骨架、select 切換、setup sheet 開關、掃描進度覆蓋、bottom sheet
 * 各機制邏輯拆到獨立子模組：
 *   mobile-screener-strat.js / pattern.js / seed.js / track.js / theme.js
 */

let _deps = {};
let _currentMode = 'theme';
let _scanAbort   = null;

// ─── 初始化 ───────────────────────────────────────────────
export function initMobileScreener(deps) {
  _deps = deps;
  _buildDOM();
  _bindSegTabs();
  _bindSetupBtn();
  _renderCurrentMode();
}

// ─── DOM 骨架 ─────────────────────────────────────────────
function _buildDOM() {
  const panel = document.getElementById('tabScreener');
  if (!panel) return;
  panel.innerHTML = `
    <div id="mScrMain">
      <div class="m-scr-header">
        <div class="m-scr-title">選股</div>
        <button class="m-setup-btn active" id="mSetupBtn">⚙ 設定掃描</button>
      </div>
      <div class="m-seg-wrap">
        <select class="m-mode-select" id="mModeSelect">
          <option value="setup">⚙ 設定掃描</option>
          <option disabled>──────────</option>
          <option value="theme">🏷 題材</option>
          <option value="strat">⚡ 策略</option>
          <option value="track">📋 追蹤</option>
          <option value="pattern">〰 型態</option>
          <option value="seed">🌱 種子</option>
        </select>
      </div>
      <div class="m-result-body" id="mResultBody"></div>
    </div>

    <div class="m-setup-screen" id="mSetupScreen">
      <div class="m-setup-nav">
        <button class="m-setup-back" id="mSetupBack">← 選股</button>
        <div class="m-setup-nav-title">設定掃描</div>
        <div style="width:60px"></div>
      </div>
      <div class="m-setup-tabs" id="mSetupTabs">
        <button class="m-stab active" data-stab="strat">⚡ 策略</button>
        <button class="m-stab"        data-stab="pattern">〰 型態</button>
        <button class="m-stab"        data-stab="seed">🌱 種子</button>
        <button class="m-stab"        data-stab="track">📋 追蹤</button>
        <button class="m-stab"        data-stab="theme">🏷 題材</button>
      </div>
      <div class="m-setup-body" id="mSetupBody"></div>
    </div>

    <div class="m-scan-overlay" id="mScanOverlay">
      <div class="m-scan-spinner"></div>
      <div class="m-scan-title" id="mScanTitle">掃描中…</div>
      <div class="m-scan-sub"   id="mScanSub">初始化中</div>
      <div class="m-scan-prog-wrap"><div class="m-scan-prog-fill" id="mScanProg"></div></div>
      <div class="m-scan-count" id="mScanCount"></div>
      <button class="m-scan-abort" id="mScanAbort">取消掃描</button>
    </div>

    <div class="m-sheet-ov" id="mSheetOv">
      <div class="m-bsheet">
        <div class="m-sh-handle"></div>
        <div class="m-sh-hd">
          <div class="m-sh-title-row">
            <div class="m-sh-icon" id="mShIcon"></div>
            <div>
              <div class="m-sh-title" id="mShTitle"></div>
              <div class="m-sh-sub"   id="mShSub"></div>
            </div>
          </div>
          <button class="m-sh-close" id="mShClose">✕</button>
        </div>
        <div class="m-sh-sort" id="mShSort"></div>
        <div class="m-sh-body"><div class="m-sh-stocks" id="mShStocks"></div></div>
      </div>
    </div>
  `;

  document.getElementById('mScanAbort')?.addEventListener('click', _abortScan);
  document.getElementById('mSheetOv')?.addEventListener('click', e => {
    if (e.target === document.getElementById('mSheetOv')) _closeSheet();
  });
  document.getElementById('mShClose')?.addEventListener('click', _closeSheet);
  document.getElementById('mSetupTabs')?.querySelectorAll('.m-stab').forEach(btn => {
    btn.addEventListener('click', () => _switchSetupTab(btn.dataset.stab));
  });
  document.getElementById('mSetupBack')?.addEventListener('click', _closeSetup);
}

function _bindSegTabs() {
  document.getElementById('mModeSelect')?.addEventListener('change', e => {
    const val = e.target.value;
    if (val === 'setup') { e.target.value = _currentMode; _openSetup(); return; }
    _currentMode = val;
    _renderCurrentMode();
  });
}

function _bindSetupBtn() {
  document.getElementById('mSetupBtn')?.addEventListener('click', _openSetup);
}

// ─── 結果渲染（lazy import 子模組）────────────────────────
async function _renderCurrentMode() {
  const body = document.getElementById('mResultBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:20px;color:#3d444d;font-size:13px;text-align:center">載入中…</div>';
  const subdeps = _mkSubDeps();
  try {
    switch (_currentMode) {
      case 'theme': { const m = await import('./mobile-screener-theme.js');   await m.renderResult(body, subdeps); break; }
      case 'strat': { const m = await import('./mobile-screener-strat.js');   m.renderResult(body, subdeps);       break; }
      case 'track': { const m = await import('./mobile-screener-track.js');   await m.renderResult(body, subdeps); break; }
      case 'pattern':{ const m = await import('./mobile-screener-pattern.js'); m.renderResult(body, subdeps);      break; }
      case 'seed':  { const m = await import('./mobile-screener-seed.js');    m.renderResult(body, subdeps);       break; }
    }
  } catch(e) {
    body.innerHTML = `<div class="m-empty"><div class="m-empty-icon">⚠️</div><div class="m-empty-title">載入失敗</div><div class="m-empty-desc">${e.message}</div></div>`;
  }
}

// ─── 設定掃描（lazy import 子模組）────────────────────────
function _openSetup() {
  document.getElementById('mScrMain')?.classList.add('m-hidden');
  document.getElementById('mSetupScreen')?.classList.add('open');
  _renderSetupTab('strat');
}
function _closeSetup() {
  document.getElementById('mScrMain')?.classList.remove('m-hidden');
  document.getElementById('mSetupScreen')?.classList.remove('open');
}
function _switchSetupTab(tab) {
  document.querySelectorAll('#mSetupTabs .m-stab').forEach(b =>
    b.classList.toggle('active', b.dataset.stab === tab));
  _renderSetupTab(tab);
}
async function _renderSetupTab(tab) {
  const body = document.getElementById('mSetupBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:20px;color:#3d444d;font-size:13px;text-align:center">載入中…</div>';
  const subdeps = _mkSubDeps();
  try {
    switch (tab) {
      case 'strat':   { const m = await import('./mobile-screener-strat.js');   m.renderSetup(body, subdeps);        break; }
      case 'pattern': { const m = await import('./mobile-screener-pattern.js'); m.renderSetup(body, subdeps);        break; }
      case 'seed':    { const m = await import('./mobile-screener-seed.js');    await m.renderSetup(body, subdeps);   break; }
      case 'track':   { const m = await import('./mobile-screener-track.js');   await m.renderSetup(body, subdeps);  break; }
      case 'theme':   { const m = await import('./mobile-screener-theme.js');   await m.renderSetup(body, subdeps);  break; }
    }
  } catch(e) {
    body.innerHTML = `<div style="padding:20px;color:#3d444d;font-size:13px">${e.message}</div>`;
  }
}

// ─── 子模組 deps 工廠 ─────────────────────────────────────
function _mkSubDeps() {
  return {
    ..._deps,
    showToast:       _deps.showToast,
    getChineseName:  _deps.getChineseName,
    AppState:        _deps.AppState,
    onClose:         _closeSetup,
    onDone:          (mode) => { _currentMode = mode; _renderCurrentMode(); },
    onOpenSheet:     _openSheet,
    showScanOverlay: _showScanOverlay,
    hideScanOverlay: _hideScanOverlay,
    updateProgress:  _updateScanProgress,
    onResult:        () => {},
  };
}

// ─── 掃描進度 ─────────────────────────────────────────────
function _showScanOverlay(label) {
  const el = document.getElementById('mScanOverlay');
  if (el) el.classList.add('open');
  _updateScanProgress(0, 0, label || '掃描中…');
}
function _hideScanOverlay() {
  document.getElementById('mScanOverlay')?.classList.remove('open');
}
function _updateScanProgress(done, total, msg) {
  const title = document.getElementById('mScanTitle');
  const sub   = document.getElementById('mScanSub');
  const prog  = document.getElementById('mScanProg');
  const cnt   = document.getElementById('mScanCount');
  if (title) title.textContent = msg || '掃描中…';
  if (prog && total > 0) prog.style.width = Math.round(done/total*100) + '%';
  if (cnt)  cnt.textContent = total > 0 ? `${done} / ${total}` : '';
}
function _abortScan() {
  if (_scanAbort) { _scanAbort.abort(); _scanAbort = null; }
  _hideScanOverlay();
}

// ─── Bottom Sheet ─────────────────────────────────────────
function _openSheet({ icon, title, sub, stocks, sort }) {
  document.getElementById('mShIcon').textContent  = icon || '';
  document.getElementById('mShTitle').textContent = title || '';
  document.getElementById('mShSub').textContent   = sub   || '';

  const sortEl = document.getElementById('mShSort');
  sortEl.innerHTML = (sort||[]).map((s,i) =>
    `<button class="m-sh-pill ${i===0?'on':''}">${s}</button>`
  ).join('');

  let sorted = [...(stocks||[])];
  const render = () => {
    document.getElementById('mShStocks').innerHTML = sorted.map(s => {
      const up = (s.pct??0) >= 0;
      const clr = up ? '#ef5350' : '#26a69a';
      return `<div class="m-ss-card" data-code="${s.code}" style="cursor:pointer">
        <div class="m-ss-info">
          <div class="m-ss-name">${s.name||s.code}</div>
          <div class="m-ss-code">${s.code}</div>
        </div>
        <div class="m-ss-r">
          <div class="m-ss-price" style="color:${clr}">${s.price!=null?Number(s.price).toFixed(2):'—'}</div>
          ${s.pct!=null?`<div class="m-ss-pct ${up?'m-up-bg':'m-dn-bg'}">${up?'+':''}${Number(s.pct).toFixed(2)}%</div>`:''}
        </div>
      </div>`;
    }).join('');
    document.querySelectorAll('.m-ss-card').forEach(el =>
      el.addEventListener('click', () => window.__loadStock?.(el.dataset.code)));
  };
  render();

  sortEl.querySelectorAll('.m-sh-pill').forEach((btn,i) => {
    btn.addEventListener('click', () => {
      sortEl.querySelectorAll('.m-sh-pill').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on');
      const label = btn.textContent;
      if (label.includes('漲幅')) sorted.sort((a,b)=>(b.pct??0)-(a.pct??0));
      else if (label.includes('跌幅')) sorted.sort((a,b)=>(a.pct??0)-(b.pct??0));
      else if (label.includes('成交')) sorted.sort((a,b)=>(b.volume??0)-(a.volume??0));
      render();
    });
  });

  document.getElementById('mSheetOv')?.classList.add('open');
}
function _closeSheet() {
  document.getElementById('mSheetOv')?.classList.remove('open');
}

// ─── renderIntoEl（個股全頁框架用）──────────────────────────
export function renderIntoEl(el, deps) {
  if (deps) _deps = deps;
  if (!el) return;

  el.style.cssText = 'display:flex;flex-direction:column;flex:1;position:relative;min-height:100%;';
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;flex:1;min-height:0;">
      <div class="m-seg-wrap">
        <select class="m-mode-select" id="mScrInlineSelect">
          <option value="setup">⚙ 設定掃描</option>
          <option disabled>──────────</option>
          <option value="theme">🏷 題材</option>
          <option value="strat">⚡ 策略</option>
          <option value="track">📋 追蹤</option>
          <option value="pattern">〰 型態</option>
          <option value="seed">🌱 種子</option>
        </select>
      </div>
      <div class="m-result-body" id="mScrInlineBody" style="flex:1;overflow-y:auto;"></div>
    </div>
    <div id="mScrInlineSetup" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#0d1117;z-index:9999;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:0.5px solid #21262d;flex-shrink:0;">
        <div style="font-size:16px;font-weight:600;color:#e6edf3;">設定掃描</div>
        <button id="mScrInlineSetupClose" style="width:28px;height:28px;border-radius:50%;background:#30363d;border:none;color:#8b949e;font-size:14px;cursor:pointer;">✕</button>
      </div>
      <div style="display:flex;overflow-x:auto;border-bottom:0.5px solid #21262d;flex-shrink:0;" id="mScrInlineSetupTabs">
        <button class="m-stab active" data-stab="strat"   style="flex-shrink:0;padding:9px 14px;font-size:13px;color:#58a6ff;border-bottom:2px solid #58a6ff;background:none;border-top:none;border-left:none;border-right:none;cursor:pointer;white-space:nowrap;">⚡ 策略</button>
        <button class="m-stab"        data-stab="pattern" style="flex-shrink:0;padding:9px 14px;font-size:13px;color:#3d444d;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;cursor:pointer;white-space:nowrap;">〰 型態</button>
        <button class="m-stab"        data-stab="seed"    style="flex-shrink:0;padding:9px 14px;font-size:13px;color:#3d444d;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;cursor:pointer;white-space:nowrap;">🌱 種子</button>
        <button class="m-stab"        data-stab="track"   style="flex-shrink:0;padding:9px 14px;font-size:13px;color:#3d444d;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;cursor:pointer;white-space:nowrap;">📋 追蹤</button>
        <button class="m-stab"        data-stab="theme"   style="flex-shrink:0;padding:9px 14px;font-size:13px;color:#3d444d;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;cursor:pointer;white-space:nowrap;">🏷 題材</button>
      </div>
      <div id="mScrInlineSetupBody" style="flex:1;overflow-y:auto;"></div>
    </div>
  `;

  const openInlineSetup = () => {
    // 把 sheet 移到 body 層級，避免父層高度/transform 問題
    let sheet = document.getElementById('mScrInlineSetup');
    if (!sheet) {
      sheet = el.querySelector('#mScrInlineSetup');
      if (sheet) document.body.appendChild(sheet);
    }
    if (sheet) { sheet.style.display='flex'; sheet.style.flexDirection='column'; }
    _renderInlineSetupTab('strat', el);
  };
  const closeInlineSetup = () => {
    const sheet = document.getElementById('mScrInlineSetup');
    if (sheet) sheet.style.display = 'none';
  };

  el.querySelector('#mScrInlineSelect')?.addEventListener('change', e => {
    const val = e.target.value;
    if (val === 'setup') { e.target.value = _currentMode; openInlineSetup(); return; }
    _currentMode = val;
    _renderInlineCurrentMode(el);
  });
  el.querySelector('#mScrInlineSetupClose')?.addEventListener('click', closeInlineSetup);
  el.querySelectorAll('#mScrInlineSetupTabs .m-stab').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('#mScrInlineSetupTabs .m-stab').forEach(b => {
        b.style.color='#3d444d'; b.style.borderBottomColor='transparent';
      });
      btn.style.color='#58a6ff'; btn.style.borderBottomColor='#58a6ff';
      _renderInlineSetupTab(btn.dataset.stab, el);
    });
  });

  // 預設開設定掃描
  openInlineSetup();
}

async function _renderInlineCurrentMode(el) {
  const body = el.querySelector('#mScrInlineBody');
  if (!body) return;
  const subdeps = { ..._deps, onOpenSheet: _openSheet, showScanOverlay: _showScanOverlay, hideScanOverlay: _hideScanOverlay, updateProgress: _updateScanProgress, onResult:()=>{}, onDone:(mode)=>{_currentMode=mode; _renderInlineCurrentMode(el);}, onClose:()=>{ document.getElementById('mScrInlineSetup').style.display='none'; } };
  try {
    switch (_currentMode) {
      case 'theme': { const m=await import('./mobile-screener-theme.js');   await m.renderResult(body,subdeps); break; }
      case 'strat': { const m=await import('./mobile-screener-strat.js');   m.renderResult(body,subdeps);      break; }
      case 'track': { const m=await import('./mobile-screener-track.js');   await m.renderResult(body,subdeps);break; }
      case 'pattern':{ const m=await import('./mobile-screener-pattern.js');m.renderResult(body,subdeps);      break; }
      case 'seed':  { const m=await import('./mobile-screener-seed.js');    m.renderResult(body,subdeps);      break; }
    }
  } catch(e) { body.innerHTML=`<div style="padding:20px;color:#3d444d">${e.message}</div>`; }
}

async function _renderInlineSetupTab(tab, el) {
  const body = el.querySelector('#mScrInlineSetupBody');
  if (!body) return;
  const subdeps = { ..._deps, onOpenSheet:_openSheet, showScanOverlay:_showScanOverlay, hideScanOverlay:_hideScanOverlay, updateProgress:_updateScanProgress, onResult:()=>{}, onDone:(mode)=>{_currentMode=mode; document.getElementById('mScrInlineSetup').style.display='none'; _renderInlineCurrentMode(el);}, onClose:()=>{ document.getElementById('mScrInlineSetup').style.display='none'; } };
  try {
    switch (tab) {
      case 'strat':   { const m=await import('./mobile-screener-strat.js');   m.renderSetup(body,subdeps);       break; }
      case 'pattern': { const m=await import('./mobile-screener-pattern.js'); m.renderSetup(body,subdeps);       break; }
      case 'seed':    { const m=await import('./mobile-screener-seed.js');    await m.renderSetup(body,subdeps); break; }
      case 'track':   { const m=await import('./mobile-screener-track.js');   await m.renderSetup(body,subdeps);break; }
      case 'theme':   { const m=await import('./mobile-screener-theme.js');   await m.renderSetup(body,subdeps);break; }
    }
  } catch(e) { body.innerHTML=`<div style="padding:20px;color:#3d444d">${e.message}</div>`; }
}
