/**
 * mobile-watchlist.js — Phase 10.2
 * 自選清單 + 篩選清單切換
 * 卡片風格：題材追蹤小卡（canvas sparkline + health badge + X系列 + 🔥今日）
 */

import { loadAllResults }                                   from '../screener-result-store.js';
import { loadHealthCacheBatch, getAllSignalsCache,
         getKlineCache }                                    from '../db.js';
import { healthBadgeDual }                                  from '../health.js';

// ── 初始化（tabWatchlist 頁用）────────────────────────────────────────────
export async function initMobileWatchlist() {
  const container = document.getElementById('watchlistContainerMobile');
  if (!container) return;
  await renderMobileWatchlist();
}

export async function renderMobileWatchlist() {
  const container = document.getElementById('watchlistContainerMobile');
  if (!container) return;
  await _renderWithSwitcher(container);
}

// ── 渲染到指定元素（個股全頁框架用）─────────────────────────────────────
export async function renderIntoEl(el) {
  if (!el) return;
  await _renderWithSwitcher(el);
}

// ── 帶切換器的渲染入口 ────────────────────────────────────────────────────
async function _renderWithSwitcher(el) {
  // 注入 health badge + 題材卡片 CSS（只注入一次）
  if (!document.getElementById('mwlThemeStyle')) {
    const style = document.createElement('style');
    style.id = 'mwlThemeStyle';
    style.textContent = `
      .mwl-theme-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:6px 10px; }
      .mwl-theme-card:active { border-color:#30363d !important; }
      .hg-health-badge { display:inline-block;padding:1px 6px;border-radius:5px;font-size:11px;font-weight:700; }
      .hg-health-badge.strong    { background:rgba(34,197,94,0.18);color:#4ade80; }
      .hg-health-badge.mid-strong{ background:rgba(132,204,22,0.18);color:#a3e635; }
      .hg-health-badge.neutral   { background:rgba(234,179,8,0.18);color:#fbbf24; }
      .hg-health-badge.mid-weak  { background:rgba(249,115,22,0.18);color:#fb923c; }
      .hg-health-badge.weak      { background:rgba(239,68,68,0.18);color:#f87171; }
      .hg-health-badge-long { display:inline-block;padding:1px 6px;border-radius:5px;font-size:11px;font-weight:700;opacity:0.75; }
      .hg-health-badge-long.strong    { background:rgba(34,197,94,0.12);color:#4ade80; }
      .hg-health-badge-long.mid-strong{ background:rgba(132,204,22,0.12);color:#a3e635; }
      .hg-health-badge-long.neutral   { background:rgba(234,179,8,0.12);color:#fbbf24; }
      .hg-health-badge-long.mid-weak  { background:rgba(249,115,22,0.12);color:#fb923c; }
      .hg-health-badge-long.weak      { background:rgba(239,68,68,0.12);color:#f87171; }
      .hg-health-empty  { color:#3d444d;font-size:11px; }
      .hg-health-dual   { display:inline-flex;align-items:center;gap:2px; }
      .hg-health-sep    { color:#21262d;font-size:10px; }
    `;
    document.head.appendChild(style);
  }
  let savedResults = [];
  try { savedResults = await loadAllResults(); } catch(_) {}

  el.innerHTML = `
    <div id="mwlSwitcher" style="
      display:flex;align-items:center;gap:8px;
      padding:10px 12px 8px;border-bottom:0.5px solid #21262d;
      position:sticky;top:0;background:#0d1117;z-index:10;
    ">
      <select id="mwlModeSelect" style="
        flex:1;padding:7px 10px;background:#161b22;border:0.5px solid #30363d;
        border-radius:9px;color:#e6edf3;font-size:13px;
      ">
        <option value="watchlist">★ 自選清單</option>
        ${savedResults.map(r =>
          `<option value="screener:${r.id}">🔍 ${_esc(r.name)} (${r.results?.length ?? 0})</option>`
        ).join('')}
      </select>
      <button id="mwlRefreshBtn" style="
        width:32px;height:32px;border-radius:8px;border:0.5px solid #30363d;
        background:#161b22;color:#8b949e;font-size:15px;cursor:pointer;flex-shrink:0;
      ">↺</button>
    </div>
    <div id="mwlBody" style="padding:8px 0;"></div>
  `;

  const body = el.querySelector('#mwlBody');
  const sel  = el.querySelector('#mwlModeSelect');

  const render = async () => {
    body.innerHTML = '<div style="padding:16px;font-size:12px;color:#3d444d;text-align:center">載入中…</div>';
    const val = sel.value;
    if (val === 'watchlist') {
      await _renderWatchlistGroups(body);
    } else {
      const id  = val.replace('screener:', '');
      const rec = savedResults.find(r => r.id === id);
      await _renderScreenerResult(body, rec);
    }
  };

  sel.addEventListener('change', render);
  el.querySelector('#mwlRefreshBtn').addEventListener('click', () => _renderWithSwitcher(el));
  await render();
}

// ── 渲染自選清單 ─────────────────────────────────────────────────────────
async function _renderWatchlistGroups(body) {
  const groups = window.__AppState?.watchlistGroups ?? [];
  if (!groups.length) {
    body.innerHTML = '<div class="mwl-empty">尚無自選股</div>';
    return;
  }

  const allCodes = groups.flatMap(g => g.stocks?.map(s => s.code) ?? []);
  const [priceCache, healthMap, yaoguMap, klineMap] = await _loadBulkData(allCodes);

  let html = '';
  groups.forEach(group => {
    const stocks = group.stocks ?? [];
    if (!stocks.length) return;
    html += `<div class="mwl-group">
      <div class="mwl-group-name">${_esc(group.name ?? '未命名')}</div>
      <div class="mwl-theme-grid">`;
    stocks.forEach(s => {
      html += _themeCardHTML(s.code, s.name ?? s.code, priceCache, healthMap, yaoguMap);
    });
    html += `</div></div>`;
  });

  body.innerHTML = html || '<div class="mwl-empty">尚無自選股</div>';
  _bindCards(body);
  _enqueueSparklines(body, allCodes, klineMap);
}

// ── 渲染篩選結果清單 ──────────────────────────────────────────────────────
async function _renderScreenerResult(body, rec) {
  if (!rec?.results?.length) {
    body.innerHTML = `<div class="mwl-empty">${rec ? '此清單無結果' : '找不到清單'}</div>`;
    return;
  }

  const results  = rec.results;
  const allCodes = results.map(r => r.code);
  const [priceCache, healthMap, yaoguMap, klineMap] = await _loadBulkData(allCodes);

  body.innerHTML = `
    <div class="mwl-group">
      <div class="mwl-group-name" style="display:flex;align-items:center;justify-content:space-between;">
        <span>${_esc(rec.name)}</span>
        <span style="font-size:11px;color:#3d444d">${results.length} 檔 · ${_fmtDate(rec.savedAt)}</span>
      </div>
      <div class="mwl-theme-grid">
        ${results.map(r => _themeCardHTML(r.code, r.name ?? r.code, priceCache, healthMap, yaoguMap)).join('')}
      </div>
    </div>`;

  _bindCards(body);
  _enqueueSparklines(body, allCodes, klineMap);
}

// ── 批次載資料（價格 / health / signals / kline）─────────────────────────
async function _loadBulkData(codes) {
  const priceCache = window.__priceCache ?? {};

  // Health
  let healthMap = new Map();
  try { healthMap = await loadHealthCacheBatch(codes); } catch(_) {}

  // X1/X2/X5（yaogu）
  let yaoguMap = new Map();
  try {
    const allSig = await getAllSignalsCache();
    allSig.forEach(row => {
      const sigs = row.signals ?? [];
      const x1 = sigs.some(s => s.id === 'X1');
      const x2 = sigs.some(s => s.id === 'X2');
      const x5 = sigs.some(s => s.id === 'X5');
      if (x1 || x2 || x5)
        yaoguMap.set(row.code, { x1, x2, x5, strongest: x2 ? 'X2' : x1 ? 'X1' : 'X5' });
    });
  } catch(_) {}

  // Kline（並發預載）
  const klineMap = new Map();
  await Promise.allSettled(codes.map(async code => {
    const sym1 = `${code}.TW`;
    const sym2 = `${code}.TWO`;
    let c = await getKlineCache(sym1, '1y').catch(() => null);
    if (!c?.candles?.length) c = await getKlineCache(sym2, '1y').catch(() => null);
    if (c?.candles?.length) klineMap.set(code, c.candles);
  }));

  return [priceCache, healthMap, yaoguMap, klineMap];
}

// ── 題材卡片 HTML ─────────────────────────────────────────────────────────
function _themeCardHTML(code, name, priceCache, healthMap, yaoguMap) {
  const p      = priceCache[code];
  const price  = p?.price  ?? null;
  const chgPct = p?.chgPct ?? null;
  const isUp   = (chgPct ?? 0) >= 0;
  const clr    = isUp ? '#ef5350' : '#26a69a';
  const priceTxt = price  != null ? price.toFixed(2)                          : '—';
  const chgTxt   = chgPct != null ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%` : '—';

  const h  = healthMap.get(code);
  const hs = h?.healthShort ?? null;
  const hl = h?.healthLong  ?? null;

  const yg        = yaoguMap.get(code);
  const isHotToday = chgPct != null && chgPct >= 9;

  // X1/X2/X5 pill
  const xPill = yg
    ? `<span style="
        padding:1px 5px;border-radius:4px;font-size:10px;font-weight:700;
        background:${yg.strongest==='X2'?'rgba(239,68,68,0.2)':yg.strongest==='X1'?'rgba(249,115,22,0.2)':'rgba(234,179,8,0.2)'};
        color:${yg.strongest==='X2'?'#f87171':yg.strongest==='X1'?'#fb923c':'#fbbf24'};
        border:0.5px solid ${yg.strongest==='X2'?'rgba(239,68,68,0.4)':yg.strongest==='X1'?'rgba(249,115,22,0.4)':'rgba(234,179,8,0.4)'};
      ">${yg.strongest}</span>`
    : '';

  const hotPill = isHotToday
    ? `<span style="
        padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;
        background:rgba(239,68,68,0.15);color:#f97316;border:0.5px solid rgba(249,115,22,0.4);
      ">🔥今日</span>`
    : '';

  return `<div class="mwl-card mwl-theme-card" data-code="${code}" style="
    background:#161b22;border:0.5px solid #21262d;border-radius:12px;
    padding:10px 10px 8px;cursor:pointer;transition:border-color 0.15s;
    overflow:hidden;
  ">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;">
      <div>
        <div style="font-size:13px;font-weight:700;color:${clr};letter-spacing:0.3px">${priceTxt}</div>
        <div style="font-size:11px;color:${clr}">${chgTxt}</div>
      </div>
      <div style="font-size:11px;color:#8b949e;text-align:right;max-width:60px;
                  overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(name)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
      ${healthBadgeDual(hs, hl, 'hg')}
      ${xPill}
      ${hotPill}
    </div>
    <canvas class="mwl-spark-canvas" data-code="${code}" width="200" height="52"
      style="width:100%;height:52px;display:block;border-radius:4px;"></canvas>
    <div style="font-size:10px;color:#3d444d;margin-top:4px">${_esc(code)}</div>
  </div>`;
}

// ── Canvas Sparkline ──────────────────────────────────────────────────────
let _sparkQueue = [];
let _sparkTimer = null;

function _enqueueSparklines(body, codes, klineMap) {
  _sparkQueue = [];
  clearTimeout(_sparkTimer);
  codes.forEach(code => {
    const canvas = body.querySelector(`.mwl-spark-canvas[data-code="${code}"]`);
    if (canvas) _sparkQueue.push({ canvas, code, klineMap });
  });
  _drainSparkQueue();
}

function _drainSparkQueue() {
  if (!_sparkQueue.length) return;
  const { canvas, code, klineMap } = _sparkQueue.shift();
  if (!document.contains(canvas)) {
    _sparkTimer = setTimeout(_drainSparkQueue, 0);
    return;
  }
  _drawSparkCanvas(canvas, code, klineMap).finally(() => {
    _sparkTimer = setTimeout(_drainSparkQueue, 30);
  });
}

async function _drawSparkCanvas(canvas, code, klineMap) {
  const candles = klineMap?.get(code);
  if (!candles?.length) { _drawNoData(canvas); return; }

  const raw    = candles.slice(-40);
  const closes = raw.map(c => c.close ?? c[4] ?? null).filter(v => v != null);
  if (closes.length < 5) { _drawNoData(canvas); return; }

  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const PL = 4, PR = 4, PT = 5, PB = 5;
  const dW = W - PL - PR, dH = H - PT - PB;
  const minV = Math.min(...closes), maxV = Math.max(...closes);
  const range = maxV - minV || 1;
  const xOf = i => PL + (i / (closes.length - 1)) * dW;
  const yOf = v => PT + (1 - (v - minV) / range) * dH;

  // 格線
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(r => {
    const y = PT + r * dH;
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
  });

  // MA20
  if (closes.length >= 20) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.lineWidth = 1;
    for (let i = 19; i < closes.length; i++) {
      const ma = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      const x = xOf(i), y = yOf(ma);
      if (i === 19) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const isUp   = closes[closes.length - 1] >= closes[0];
  const lc     = isUp ? '#ef5350' : '#26a69a';
  const fillC  = isUp ? 'rgba(239,83,80,0.10)' : 'rgba(38,166,154,0.12)';

  // fill
  ctx.beginPath();
  closes.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.lineTo(xOf(closes.length - 1), H - PB);
  ctx.lineTo(PL, H - PB);
  ctx.closePath();
  ctx.fillStyle = fillC;
  ctx.fill();

  // line
  ctx.beginPath();
  ctx.strokeStyle = lc;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  closes.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();

  // dot
  const lx = xOf(closes.length - 1), ly = yOf(closes[closes.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = lc; ctx.fill();
}

function _drawNoData(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(100,116,139,0.25)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('—', canvas.width / 2, canvas.height / 2 + 3);
}

// ── 工具函式 ─────────────────────────────────────────────────────────────
function _bindCards(body) {
  body.querySelectorAll('.mwl-card').forEach(card => {
    card.addEventListener('click', () => {
      const code = card.dataset.code;
      if (code) (window.__mobileOpenPreview||window.__loadStock)?.(code);
    });
  });
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth()+1}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
