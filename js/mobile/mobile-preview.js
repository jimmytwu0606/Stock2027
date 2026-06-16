/**
 * js/mobile/mobile-preview.js — 手機版「個股速覽」模態框（簡易版）
 *
 * 桌機 stock-preview.js 一行不動；本檔是手機獨立簡易版，自包含 CSS（mpv- 前綴）。
 * 由上到下：代號/名稱/價 → RS 區塊 → K 線(K棒+量+MA20/60/120) → KD/RSI/MACD 讀數
 *           → 妖股簡易卡(命中才顯示) → 基本面 6 格 → 月營收 24 月 → 法人 → 連結
 *
 * 維持 Fable 方案：K 線 canvas 自繪、只查 IDB（.TW/.TWO 雙查）不打 Worker、MA20/60/120。
 * 新增：RS（讀 window.__snapshot.stocks[code].rs_v/rs_line_high）、量、KD/RSI/MACD、妖股卡。
 *
 * 對外橋接：window.__mobileOpenPreview(code, ctx)
 */

import { AppState } from '../state.js';
import { toYahooSymbol, getChineseName, fetchFundamentals, fetchFinMindRevenue, fetchChipData, fetchForeignBuyDays } from '../api.js';
import { getKlineCache, getYaoguRecord } from '../db.js';
import { getFinMindToken } from '../config.js';
import { calcKD, calcRSI, calcMACD } from '../indicators.js';

const UP = '#ef5350', DOWN = '#26a69a';                 // 台股：漲紅跌綠
const MA_COLORS = { 20: '#58a6ff', 60: '#d4a72c', 120: '#e8b04b' };
const PERIODS = [{ label: '3月', n: 65 }, { label: '6月', n: 130 }, { label: '1年', n: 250 }];

let _bg = null;
let _openSeq = 0;
let _curCode = null;
let _curCtx = null;
let _curSymbol = null;
let _candles1y = null;
let _periodIdx = 1;          // 手機預設 6 月（短一點比較看得清）

// ─────────────────────────────────────────────
// 對外入口
// ─────────────────────────────────────────────
export async function openMobilePreview(code, ctx = {}) {
  _ensureDom();
  const seq = ++_openSeq;
  _curCode = code;
  _curCtx = ctx;
  _curSymbol = null;
  _candles1y = null;
  _periodIdx = 1;

  _bg.style.display = 'flex';
  document.addEventListener('keydown', _onEsc);

  const name = getChineseName(code) || window.__nameCache?.get?.(code) || window.__priceCache?.[code]?.name || '';
  _el('mpvCode').textContent = code;
  _el('mpvName').textContent = name;
  _renderPrice(window.__priceCache?.[code] ?? null);

  _renderRS(code);
  _el('mpvChartSec').innerHTML = _skel('K 線載入中…');
  _el('mpvIndSec').innerHTML = '';
  _el('mpvYaoguSec').innerHTML = '';
  _el('mpvFundSec').innerHTML = _skel('基本面載入中…');
  _el('mpvRevSec').innerHTML = '';
  _el('mpvChipSec').innerHTML = '';
  _renderLinks(code, null);

  _loadKline(code, seq);
  _loadYaogu(code, seq);
  _loadFund(code, seq);
  _loadRevenue(code, seq);
  _loadChips(code, seq);
}

export function initMobilePreview() {
  _ensureDom();
}

export function closeMobilePreview() {
  if (_bg) _bg.style.display = 'none';
  document.removeEventListener('keydown', _onEsc);
}

function _onEsc(e) { if (e.key === 'Escape') closeMobilePreview(); }

// 進入完整個股頁（CTA，opt-in；走既有 loadStock）
function _enterStock() {
  const code = _curCode;
  closeMobilePreview();
  window.__loadStock?.(code);
}

// ─────────────────────────────────────────────
// RS 區塊（讀夜間 snapshot）
// ─────────────────────────────────────────────
function _renderRS(code) {
  const sec = _el('mpvRSSec');
  if (!sec) return;
  const row = window.__snapshot?.stocks?.[code];
  const rsv = row?.rs_v;
  if (rsv == null) {
    sec.innerHTML = `<div class="mpv-rs mpv-rs-empty">🏅 RS 尚無資料 <span>夜間全市場快照未涵蓋此股</span></div>`;
    return;
  }
  const lineHigh = row.rs_line_high === true;
  const tier = rsv >= 95 ? 'elite' : rsv >= 87 ? 'strong' : rsv >= 50 ? 'mid' : 'weak';
  const c = rsv >= 87 ? '#e3b341' : rsv >= 50 ? '#8b9dc3' : DOWN;
  const tierTxt = tier === 'elite' ? '精英級 ≥95' : tier === 'strong' ? '強勢級 ≥87'
                : tier === 'mid' ? '中性偏強' : '相對弱勢';
  const desc = tier === 'elite' ? '全市場最強前 5%' : tier === 'strong' ? '已達歐尼爾選股門檻'
             : tier === 'mid' ? '未達 87 強勢門檻' : '動能落後大盤多數個股';
  sec.innerHTML = `
    <div class="mpv-rs" style="border-color:${c}">
      <div class="mpv-rs-top">
        <span class="mpv-rs-medal">🏅</span>
        <span class="mpv-rs-val" style="color:${c}">RS ${rsv}</span>
        <span class="mpv-rs-tier" style="background:${c}22;color:${c}">${tierTxt}</span>
        ${lineHigh ? `<span class="mpv-rs-high">線創 60 日新高 ↗</span>` : ''}
      </div>
      <div class="mpv-rs-desc">強於全市場 ${rsv}% 個股，${desc}${lineHigh ? '；RS 線領先價格創高，資金相對流入' : ''}。</div>
    </div>`;
}

// ─────────────────────────────────────────────
// K 線（canvas 自繪：K 棒 + 量 + MA20/60/120）
// ─────────────────────────────────────────────
async function _loadKline(code, seq) {
  const sym1 = toYahooSymbol(code);
  const sym2 = sym1.endsWith('.TW') ? sym1.replace('.TW', '.TWO') : sym1.replace('.TWO', '.TW');
  let hit = null, sym = null;
  try { hit = await getKlineCache(sym1, '1y'); sym = sym1; } catch (_) {}
  if (!hit?.candles?.length) {
    try { hit = await getKlineCache(sym2, '1y'); sym = sym2; } catch (_) {}
  }
  if (seq !== _openSeq) return;

  const candles = hit?.candles;
  if (!candles || candles.length < 5) {
    _el('mpvChartSec').innerHTML = _skel('無 K 線快取（bundle 尚未灌入此股）');
    return;
  }
  _candles1y = candles;
  _curSymbol = sym;
  _renderLinks(code, sym);

  if (!window.__priceCache?.[code] && candles.length >= 2) {
    const last = candles[candles.length - 1], prev = candles[candles.length - 2];
    _renderPrice({ price: last.close, prev: prev.close,
      chgPct: prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0 });
  }

  _renderChartSec();
  _renderIndicators();
}

function _renderChartSec() {
  const sec = _el('mpvChartSec');
  sec.innerHTML = `
    <div class="mpv-ma-legend">
      ${[20, 60, 120].map(n => `<span style="color:${MA_COLORS[n]}"><b>MA${n}</b></span>`).join('')}
    </div>
    <canvas class="mpv-kcanvas" id="mpvKCanvas"></canvas>
    <div class="mpv-period-row">
      ${PERIODS.map((p, i) =>
        `<button class="mpv-pbtn${i === _periodIdx ? ' active' : ''}" data-pi="${i}">${p.label}</button>`).join('')}
    </div>`;
  sec.querySelectorAll('.mpv-pbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      _periodIdx = +btn.dataset.pi;
      sec.querySelectorAll('.mpv-pbtn').forEach(b => b.classList.toggle('active', +b.dataset.pi === _periodIdx));
      requestAnimationFrame(_drawKline);
    });
  });
  requestAnimationFrame(_drawKline);
}

function _sma(cs, n) {
  const out = new Array(cs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < cs.length; i++) {
    sum += cs[i].close;
    if (i >= n) sum -= cs[i - n].close;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function _vol(c) { return +(c.volume ?? c.vol ?? c.v ?? 0) || 0; }

function _drawKline() {
  const cv = _el('mpvKCanvas');
  if (!cv || !_candles1y) return;
  const all = _candles1y;
  const ma = { 20: _sma(all, 20), 60: _sma(all, 60), 120: _sma(all, 120) };

  const n = Math.min(PERIODS[_periodIdx].n, all.length);
  const s = all.length - n;
  const cs = all.slice(s);

  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || cv.parentElement.clientWidth || 360;
  const H = 240;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padR = 50;
  const volH = 42, volGap = 6;
  const priceTop = 8, priceBottom = H - volH - volGap;
  const volTop = H - volH;

  let hi = -Infinity, lo = Infinity;
  for (const c of cs) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  for (const k of [20, 60, 120]) for (let i = s; i < all.length; i++) {
    const v = ma[k][i]; if (v != null) { if (v > hi) hi = v; if (v < lo) lo = v; }
  }
  if (!isFinite(hi) || hi === lo) { hi = lo + 1; }

  const x = i => i / Math.max(cs.length - 1, 1) * (W - padR - 4) + 2;
  const y = v => (hi - v) / (hi - lo) * (priceBottom - priceTop) + priceTop;

  // 網格 + 右側價格刻度
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  for (let g = 0; g < 4; g++) {
    const gy = priceTop + (priceBottom - priceTop) * g / 3;
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
    ctx.fillStyle = '#8a8f99';
    ctx.fillText(_fmtTick(hi - (hi - lo) * g / 3), W - padR + 6, gy + 3);
  }

  // 量（底部）
  let maxVol = 0;
  for (const c of cs) { const v = _vol(c); if (v > maxVol) maxVol = v; }
  const bw = Math.max(1, (W - padR) / cs.length - 1);
  if (maxVol > 0) {
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const up = c.close >= c.open;
      const h = Math.max(1, Math.round(_vol(c) / maxVol * (volH - 2)));
      ctx.fillStyle = (up ? UP : DOWN) + '66';
      ctx.fillRect(x(i) - bw / 2, volTop + (volH - h), bw, h);
    }
  }

  // K 棒
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const up = c.close >= c.open;
    const col = up ? UP : DOWN;
    const cx = x(i);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(cx, y(c.high)); ctx.lineTo(cx, y(c.low)); ctx.stroke();
    ctx.fillRect(cx - bw / 2, Math.min(y(c.open), y(c.close)), bw, Math.max(1, Math.abs(y(c.open) - y(c.close))));
  }

  // MA 線（完整序列計算 → 視窗切片，無暖機空洞）
  for (const k of [20, 60, 120]) {
    ctx.strokeStyle = MA_COLORS[k]; ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < cs.length; i++) {
      const v = ma[k][s + i];
      if (v == null) continue;
      const px = x(i), py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    if (started) ctx.stroke();
  }

  // 現價標籤
  const last = cs[cs.length - 1];
  const prev = cs[cs.length - 2];
  const ly = Math.min(Math.max(y(last.close), 16), priceBottom);
  ctx.fillStyle = (prev && last.close < prev.close) ? DOWN : UP;
  ctx.fillRect(W - padR + 2, ly - 8, padR - 4, 16);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.fillText(_fmtTick(last.close), W - padR + 7, ly + 3.5);
}

function _fmtTick(v) {
  if (v >= 1000) return Math.round(v).toLocaleString();
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

// ─────────────────────────────────────────────
// KD / RSI / MACD 讀數條（不開副圖）
// ─────────────────────────────────────────────
function _renderIndicators() {
  const sec = _el('mpvIndSec');
  if (!sec || !_candles1y || _candles1y.length < 20) return;
  const cs = _candles1y;
  const closes = cs.map(c => c.close);

  // KD
  const { k, d } = calcKD(cs, 9);
  const lk = k[k.length - 1], ld = d[d.length - 1];
  let kdSig, kdCol;
  if (lk > ld && lk < 80)      { kdSig = '金叉';   kdCol = UP; }
  else if (lk > 80)            { kdSig = '高檔鈍化'; kdCol = UP; }
  else if (lk < ld && lk > 20) { kdSig = '死叉';   kdCol = DOWN; }
  else if (lk < 20)            { kdSig = '低檔';   kdCol = DOWN; }
  else                         { kdSig = '糾結';   kdCol = '#8a8f99'; }

  // RSI
  const rsiArr = calcRSI(closes, 14);
  const lr = rsiArr[rsiArr.length - 1];
  let rsiSig, rsiCol;
  if (lr == null)        { rsiSig = '—';   rsiCol = '#8a8f99'; }
  else if (lr >= 70)     { rsiSig = '超買'; rsiCol = UP; }
  else if (lr <= 30)     { rsiSig = '超賣'; rsiCol = DOWN; }
  else if (lr >= 50)     { rsiSig = '偏強'; rsiCol = UP; }
  else                   { rsiSig = '偏弱'; rsiCol = DOWN; }

  // MACD
  const { dif, sigLine, hist } = calcMACD(closes);
  const lh = hist[hist.length - 1];
  const ldif = dif[dif.length - 1], lsig = sigLine[sigLine.length - 1];
  let mSig, mCol;
  if (lh > 0 && ldif > lsig)  { mSig = '紅柱'; mCol = UP; }
  else if (lh > 0)            { mSig = '紅柱縮'; mCol = UP; }
  else if (lh < 0 && ldif < lsig) { mSig = '綠柱'; mCol = DOWN; }
  else                        { mSig = '綠柱縮'; mCol = DOWN; }

  const cell = (label, val, sig, col) => `
    <div class="mpv-ind-cell">
      <div class="mpv-ind-label">${label}</div>
      <div class="mpv-ind-val">${val}</div>
      <div class="mpv-ind-sig" style="color:${col}">${sig}</div>
    </div>`;

  sec.innerHTML = `
    <div class="mpv-ind-row">
      ${cell('KD', `${lk?.toFixed(0)} / ${ld?.toFixed(0)}`, kdSig, kdCol)}
      ${cell('RSI', lr != null ? lr.toFixed(1) : '—', rsiSig, rsiCol)}
      ${cell('MACD', (lh >= 0 ? '+' : '') + (lh != null ? lh.toFixed(2) : '—'), mSig, mCol)}
    </div>`;
}

// ─────────────────────────────────────────────
// 妖股簡易卡（命中才顯示）
// ─────────────────────────────────────────────
function _forwardReturn(candles, activatedTs, nDays) {
  if (!candles?.length || !activatedTs) return null;
  let aIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const ts = candles[i].time > 1e10 ? candles[i].time : candles[i].time * 1000;
    if (ts >= activatedTs - 86400000) { aIdx = i; break; }
  }
  if (aIdx < 0 || aIdx >= candles.length - 1) return null;
  const entry = candles[aIdx].close;
  if (!entry) return null;
  const exitIdx = Math.min(aIdx + nDays, candles.length - 1);
  const matured = (aIdx + nDays) <= candles.length - 1;
  const ret = +((candles[exitIdx].close / entry - 1) * 100).toFixed(1);
  const slice = candles.slice(aIdx, exitIdx + 1);
  const maxRet = +((Math.max(...slice.map(c => c.high ?? c.close)) / entry - 1) * 100).toFixed(0);
  const maxDd = +((Math.min(...slice.map(c => c.low ?? c.close)) / entry - 1) * 100).toFixed(0);
  return { ret, matured, maxRet, maxDd };
}

async function _loadYaogu(code, seq) {
  let rec = null;
  try { rec = await getYaoguRecord(code); } catch (_) {}
  if (seq !== _openSeq) return;

  const sigs = AppState.signals?.[code] ?? [];
  const ids = new Set(sigs.map(s => s.id));
  const hasX1 = ids.has('X1'), hasX2 = ids.has('X2'), hasX5 = ids.has('X5');
  const anyX = hasX1 || hasX2 || hasX5;
  const active = rec && rec.status && rec.status !== 'exited' && rec.status !== 'exit';

  if (!anyX && !active) return;   // 非妖股 → 整區隱藏

  // 等級
  let tier, tierColor, tierTxt, tierSub;
  if ((hasX1 && hasX2 && hasX5) || (hasX1 && hasX2) || (hasX2 && hasX5)) {
    tier = 'strong'; tierColor = '#ef5350'; tierTxt = '強妖'; tierSub = '多重確認';
  } else if (hasX2 || (hasX1 && hasX5)) {
    tier = 'mid'; tierColor = '#f59e0b'; tierTxt = '中妖'; tierSub = '趨勢＋主力';
  } else if (hasX1) {
    tier = 'steady'; tierColor = '#eab308'; tierTxt = '穩健型'; tierSub = '趨勢確認';
  } else if (hasX5) {
    tier = 'early'; tierColor = '#eab308'; tierTxt = '早期型'; tierSub = '主力建倉觀察';
  } else {
    tier = 'watch'; tierColor = '#a78bfa'; tierTxt = '妖股觀察'; tierSub = '狀態追蹤中';
  }

  const stateMap = { active: '啟動中', warning1: '警戒一', warning2: '警戒二', watching: '觀察中' };
  const stateTxt = active ? (stateMap[rec.status] || rec.status) : '訊號命中';
  const xPill = (on, icon, id, name) =>
    `<div class="mpv-x${on ? ' on' : ''}"><div class="mpv-x-icon">${icon}</div><div class="mpv-x-id">${id}</div><div class="mpv-x-name">${name}</div></div>`;

  // 啟動後報酬
  let retHtml = '';
  let metaHtml = '';
  if (rec?.activatedAt && _candles1y?.length) {
    const r5 = _forwardReturn(_candles1y, rec.activatedAt, 5);
    const r10 = _forwardReturn(_candles1y, rec.activatedAt, 10);
    const r20 = _forwardReturn(_candles1y, rec.activatedAt, 20);
    const cellR = (label, r) => {
      if (!r) return `<div class="mpv-yr-cell"><div class="mpv-yr-lab">${label}</div><div class="mpv-yr-val" style="color:#8a8f99">—</div></div>`;
      const col = r.ret >= 0 ? UP : DOWN;
      return `<div class="mpv-yr-cell"><div class="mpv-yr-lab">${label}${r.matured ? '' : '*'}</div><div class="mpv-yr-val" style="color:${col}">${r.ret >= 0 ? '+' : ''}${r.ret}%</div></div>`;
    };
    retHtml = `
      <div class="mpv-yr-title">啟動後報酬</div>
      <div class="mpv-yr-row">${cellR('5 日', r5)}${cellR('10 日', r10)}${cellR('20 日', r20)}</div>`;
    const days = Math.floor((Date.now() - rec.activatedAt) / 86400000);
    const dStr = new Date(rec.activatedAt).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
    const best = r20 || r10 || r5;
    const ddTxt = best ? ` · 區間最大 <span style="color:${UP}">+${best.maxRet}%</span> · 回撤 <span style="color:${DOWN}">${best.maxDd}%</span>` : '';
    metaHtml = `<div class="mpv-y-meta">啟動 ${dStr} · 持有 ${days} 日${ddTxt}</div>`;
  }

  _el('mpvYaoguSec').innerHTML = `
    <div class="mpv-sec-title">妖股訊號</div>
    <div class="mpv-y-badge" style="background:${tierColor}1a;border-color:${tierColor}">
      <span class="mpv-y-dot" style="background:${tierColor}"></span>
      <span class="mpv-y-tier" style="color:${tierColor}">${tierTxt}</span>
      <span class="mpv-y-sub">${tierSub}</span>
      <span class="mpv-y-state">${stateTxt}</span>
    </div>
    <div class="mpv-x-row">
      ${xPill(hasX1, '🪙', 'X1', '黃金比例')}
      ${xPill(hasX2, '🌑', 'X2', '天黑請閉眼')}
      ${xPill(hasX5, '🚀', 'X5', '量證明一切')}
    </div>
    ${retHtml}${metaHtml}`;
}

// ─────────────────────────────────────────────
// 基本面 6 格
// ─────────────────────────────────────────────
async function _loadFund(code, seq) {
  let data = null;
  try { data = await fetchFundamentals(toYahooSymbol(code), code); } catch (_) {}
  if (seq !== _openSeq) return;
  const sec = _el('mpvFundSec');
  if (!data) { sec.innerHTML = _skel('基本面資料無法取得'); return; }

  const num = v => v != null ? Number(v).toFixed(2) : '—';
  const pct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const cap = v => {
    if (v == null) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(1) + ' 兆';
    if (v >= 1e8) return (v / 1e8).toFixed(1) + ' 億';
    return Number(v).toLocaleString();
  };
  let netMargin = data.profitMargin != null ? data.profitMargin * 100 : data._marginSeries?.[0]?.netMargin;

  sec.innerHTML = `
    <div class="mpv-sec-title">基本面</div>
    <div class="mpv-grid">
      ${_cell('P/E', num(data.pe))}
      ${_cell('P/B', num(data.pbRatio))}
      ${_cell('殖利率', pct(data.dividendYield))}
      ${_cell('EPS', num(data.eps))}
      ${_cell('市值', cap(data.marketCap))}
      ${_cell('淨利率', netMargin != null ? netMargin.toFixed(1) + '%' : '—')}
    </div>`;
}

function _cell(label, value) {
  return `<div class="mpv-cell"><span class="mpv-cell-label">${label}</span><span class="mpv-cell-value">${value}</span></div>`;
}

// ─────────────────────────────────────────────
// 月營收（需 FinMind Token，無 token / 無資料 → 整區隱藏）
// ─────────────────────────────────────────────
async function _loadRevenue(code, seq) {
  if (!getFinMindToken?.()) return;
  let rows = null;
  try { rows = await fetchFinMindRevenue(code); } catch (_) {}
  if (seq !== _openSeq) return;
  if (!rows?.length) return;

  const latest = rows[0];
  const rev = Number(latest.revenue);
  const prev12 = rows[12] ? Number(rows[12].revenue) : null;
  const yoy = prev12 && prev12 > 0 ? (rev - prev12) / prev12 * 100 : null;

  let streak = 0;
  for (let i = 0; i < rows.length - 12; i++) {
    const r = Number(rows[i].revenue), p = Number(rows[i + 12].revenue);
    if (p > 0 && r > p) streak++; else break;
  }

  const view = rows.slice(0, 24);
  const maxRev = Math.max(...view.map(r => Number(r.revenue)), 1);
  const bars = [...view].reverse().map((r) => {
    const i = rows.findIndex(x => x.date === r.date);
    const p12 = rows[i + 12] ? Number(rows[i + 12].revenue) : null;
    const pos = p12 == null || Number(r.revenue) >= p12;
    const h = Math.max(2, Math.round(Number(r.revenue) / maxRev * 46));
    return `<div class="mpv-bar" style="height:${h}px;background:${pos ? UP : DOWN}" title="${r.date?.slice(0, 7)}"></div>`;
  }).join('');

  const amt = rev * 1000 >= 1e8 ? (rev * 1000 / 1e8).toFixed(1) + ' 億' : (rev * 1000 / 1e4).toFixed(0) + ' 萬';
  const yoyCls = yoy == null ? '' : (yoy >= 0 ? 'mpv-up' : 'mpv-down');
  const yoyTxt = yoy == null ? '' : `，YoY <b>${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%</b>`;
  const streakTxt = streak >= 2 ? `，連續 ${streak} 月成長` : '';

  _el('mpvRevSec').innerHTML = `
    <div class="mpv-sec-title">月營收</div>
    <div class="mpv-rev-summary ${yoyCls}">營收 ${amt}${yoyTxt}${streakTxt}</div>
    <div class="mpv-bars">${bars}</div>
    <div class="mpv-bar-dates">
      <span>${view[view.length - 1]?.date?.slice(0, 7) ?? ''}</span>
      <span>${view[0]?.date?.slice(0, 7) ?? ''}</span>
    </div>`;
}

// ─────────────────────────────────────────────
// 法人動向（要不到資料 → 整區隱藏）
// ─────────────────────────────────────────────
async function _loadChips(code, seq) {
  const [chipR, histR] = await Promise.allSettled([
    fetchChipData(code),
    fetchForeignBuyDays(code, 10),
  ]);
  if (seq !== _openSeq) return;

  const inst = chipR.status === 'fulfilled' ? chipR.value?.institutional : null;
  const hist = histR.status === 'fulfilled' ? (histR.value ?? []) : [];
  if (!inst && !hist.length) return;

  const fmtN = v => v == null ? '—' : Math.abs(v).toLocaleString();
  const instCell = (name, val) => {
    const cls = val > 0 ? 'mpv-up' : val < 0 ? 'mpv-down' : '';
    return `<div class="mpv-inst-col">
      <div class="mpv-inst-name">${name}</div>
      <div class="mpv-inst-sum ${cls}">${val > 0 ? '+' : val < 0 ? '-' : ''}${fmtN(val)} 張</div>
    </div>`;
  };

  let headline = '', instHtml = '';
  if (inst) {
    const total = inst.total ?? 0;
    headline = `<div class="mpv-chip-headline ${total >= 0 ? 'mpv-up' : 'mpv-down'}">
      今日三大法人${total >= 0 ? '買超' : '賣超'} <b>${fmtN(total)} 張</b></div>`;
    instHtml = `<div class="mpv-inst-row">
      ${instCell('外資', inst.foreign)}${instCell('投信', inst.trust)}${instCell('自營商', inst.dealer)}
    </div>`;
  }

  let histHtml = '';
  if (hist.length) {
    const rows = [...hist].reverse();
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.net)), 1);
    const bars = rows.map(r => {
      const h = Math.max(2, Math.round(Math.abs(r.net) / maxAbs * 14));
      const buy = r.net >= 0;
      return `<i title="${r.date}  ${buy ? '+' : ''}${r.net?.toLocaleString?.() ?? r.net} 張"
        style="height:${h}px;background:${buy ? UP : DOWN};align-self:${buy ? 'flex-end' : 'flex-start'}"></i>`;
    }).join('');
    const sum = rows.reduce((s, r) => s + (r.net ?? 0), 0);
    histHtml = `<div class="mpv-fh-row">
      <span class="mpv-inst-name">外資近 10 日</span>
      <div class="mpv-fh-bars">${bars}</div>
      <span class="mpv-inst-sum ${sum >= 0 ? 'mpv-up' : 'mpv-down'}">Σ ${sum >= 0 ? '+' : ''}${sum.toLocaleString()}</span>
    </div>`;
  }

  _el('mpvChipSec').innerHTML = `
    <div class="mpv-sec-title">法人動向</div>
    ${headline}${instHtml}${histHtml}`;
}

// ─────────────────────────────────────────────
// 相關連結
// ─────────────────────────────────────────────
function _renderLinks(code, sym) {
  const tvPrefix = sym?.endsWith('.TWO') ? 'TPEX' : 'TWSE';
  const links = [
    ['Yahoo', `https://tw.stock.yahoo.com/quote/${code}`],
    ['Google', `https://www.google.com/search?q=${code}+%E8%82%A1%E7%A5%A8`],
    ['TradingView', `https://tw.tradingview.com/chart/?symbol=${tvPrefix}%3A${code}`],
    ['Goodinfo', `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${code}`],
    ['Wantgoo', `https://www.wantgoo.com/stock/${code}`],
  ];
  _el('mpvLinks').innerHTML = links.map(([n, u]) =>
    `<a class="mpv-link" href="${u}" target="_blank" rel="noopener">${n}</a>`).join('');
}

// ─────────────────────────────────────────────
// Header 價格
// ─────────────────────────────────────────────
function _renderPrice(p) {
  const priceEl = _el('mpvPrice'), chgEl = _el('mpvChg');
  if (!priceEl || !chgEl) return;
  if (!p || p.price == null) { priceEl.textContent = '—'; priceEl.className = 'mpv-price'; chgEl.textContent = ''; return; }
  const chg = p.chg ?? (p.prev != null ? p.price - p.prev : 0);
  const chgPct = p.chgPct ?? (p.prev > 0 ? chg / p.prev * 100 : 0);
  const cls = chg >= 0 ? 'mpv-up' : 'mpv-down';
  priceEl.textContent = p.price.toLocaleString(undefined, { minimumFractionDigits: p.price < 100 ? 2 : 0, maximumFractionDigits: 2 });
  priceEl.className = `mpv-price ${cls}`;
  chgEl.innerHTML = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}（${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%）`;
  chgEl.className = `mpv-chg ${cls}`;
}

// ─────────────────────────────────────────────
// DOM 注入（只一次）
// ─────────────────────────────────────────────
function _el(id) { return document.getElementById(id); }
function _skel(t) { return `<div class="mpv-skel">${t}</div>`; }

function _ensureDom() {
  if (_bg) return;

  if (!document.getElementById('mpv-style')) {
    const st = document.createElement('style');
    st.id = 'mpv-style';
    st.textContent = `
.mpv-bg{position:fixed;inset:0;background:rgba(0,0,0,.66);backdrop-filter:blur(2px);display:none;align-items:center;justify-content:center;z-index:1300}
.mpv-modal{width:min(480px,96vw);max-height:92vh;background:#161b22;border:1px solid rgba(255,255,255,.08);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.6);font-size:13px;color:#e8eaed}
.mpv-header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
.mpv-code{font-family:ui-monospace,monospace;font-size:15px;font-weight:700;color:#58a6ff}
.mpv-name{font-size:15px;font-weight:600}
.mpv-price-block{margin-left:auto;text-align:right}
.mpv-price{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.mpv-chg{font-size:11px;font-variant-numeric:tabular-nums}
.mpv-up{color:${UP} !important}.mpv-down{color:${DOWN} !important}
.mpv-close{margin-left:4px;background:none;border:none;color:#8a8f99;font-size:18px;cursor:pointer;padding:4px;line-height:1}
.mpv-cta-row{display:flex;gap:8px;padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
.mpv-cta{flex:1;padding:9px;border-radius:8px;border:1px solid rgba(88,166,255,.4);background:rgba(88,166,255,.12);color:#58a6ff;font-size:13px;font-weight:600;cursor:pointer}
.mpv-body{overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1}
.mpv-section{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
.mpv-section:empty{display:none}
.mpv-sec-title{font-size:12px;font-weight:700;color:#8a8f99;letter-spacing:.5px;margin-bottom:9px}
.mpv-rs{border:1px solid #30363d;border-radius:10px;padding:9px 12px;background:#1c2230}
.mpv-rs-empty{color:#8a8f99;font-size:12px}.mpv-rs-empty span{color:#5f6672;margin-left:6px;font-size:11px}
.mpv-rs-top{display:flex;align-items:center;gap:8px}
.mpv-rs-medal{font-size:16px}
.mpv-rs-val{font-size:16px;font-weight:700}
.mpv-rs-tier{font-size:11px;padding:2px 8px;border-radius:6px}
.mpv-rs-high{margin-left:auto;font-size:11px;color:${UP}}
.mpv-rs-desc{font-size:11px;color:#8a8f99;line-height:1.5;margin-top:5px}
.mpv-ma-legend{display:flex;gap:12px;font-size:11px;margin-bottom:6px}
.mpv-kcanvas{width:100%;height:240px;display:block}
.mpv-period-row{display:flex;gap:6px;margin-top:8px}
.mpv-pbtn{padding:4px 12px;font-size:11px;border-radius:6px;border:1px solid rgba(255,255,255,.08);background:none;color:#8a8f99;cursor:pointer;min-height:30px}
.mpv-pbtn.active{background:rgba(88,166,255,.15);color:#58a6ff;border-color:rgba(88,166,255,.4)}
.mpv-ind-row{display:flex;gap:8px}
.mpv-ind-cell{flex:1;background:#1c2230;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:7px 8px}
.mpv-ind-label{font-size:10px;color:#8a8f99}
.mpv-ind-val{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.mpv-ind-sig{font-size:10px;margin-top:1px}
.mpv-y-badge{display:flex;align-items:center;gap:8px;border:1px solid;border-radius:10px;padding:9px 12px;margin-bottom:10px}
.mpv-y-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.mpv-y-tier{font-size:15px;font-weight:700}
.mpv-y-sub{font-size:11px;color:#8a8f99}
.mpv-y-state{margin-left:auto;font-size:11px;color:#8a8f99}
.mpv-x-row{display:flex;gap:6px;margin-bottom:10px}
.mpv-x{flex:1;background:#1c2230;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 4px;text-align:center;opacity:.4}
.mpv-x.on{opacity:1;border-color:rgba(245,158,11,.5)}
.mpv-x-icon{font-size:15px}
.mpv-x-id{font-size:11px;font-weight:700;color:#e8b04b;margin-top:1px}
.mpv-x-name{font-size:9px;color:#8a8f99;line-height:1.2}
.mpv-yr-title{font-size:11px;color:#8a8f99;margin-bottom:6px}
.mpv-yr-row{display:flex;gap:6px;margin-bottom:8px}
.mpv-yr-cell{flex:1;background:#1c2230;border-radius:8px;padding:7px;text-align:center}
.mpv-yr-lab{font-size:10px;color:#8a8f99}
.mpv-yr-val{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.mpv-y-meta{font-size:11px;color:#8a8f99;line-height:1.5}
.mpv-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden}
.mpv-cell{background:#1c2230;padding:8px 12px;display:flex;justify-content:space-between;align-items:baseline}
.mpv-cell-label{font-size:12px;color:#8a8f99}
.mpv-cell-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.mpv-rev-summary{font-size:12px;margin-bottom:8px;line-height:1.6}
.mpv-bars{display:flex;align-items:flex-end;gap:3px;height:48px}
.mpv-bar{flex:1;border-radius:2px 2px 0 0;min-height:2px}
.mpv-bar-dates{display:flex;justify-content:space-between;font-size:10px;color:#8a8f99;margin-top:4px}
.mpv-chip-headline{font-size:12px;margin-bottom:10px}
.mpv-inst-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.mpv-inst-col{background:#1c2230;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px}
.mpv-inst-name{font-size:11px;color:#8a8f99}
.mpv-inst-sum{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:4px}
.mpv-fh-row{display:flex;align-items:center;gap:10px}
.mpv-fh-bars{display:flex;align-items:center;gap:2px;height:32px;flex:1}
.mpv-fh-bars i{flex:1;border-radius:1px;display:block}
.mpv-links{display:flex;flex-wrap:wrap;gap:8px}
.mpv-link{font-size:12px;color:#8a8f99;padding:5px 12px;border:1px solid rgba(255,255,255,.08);border-radius:14px;text-decoration:none;min-height:30px;display:inline-flex;align-items:center}
.mpv-skel{color:#8a8f99;font-size:12px;padding:6px 0}`;
    document.head.appendChild(st);
  }

  _bg = document.createElement('div');
  _bg.className = 'mpv-bg';
  _bg.id = 'mpvModalBg';
  _bg.innerHTML = `
    <div class="mpv-modal">
      <div class="mpv-header">
        <span class="mpv-code" id="mpvCode"></span>
        <span class="mpv-name" id="mpvName"></span>
        <div class="mpv-price-block">
          <div class="mpv-price" id="mpvPrice">—</div>
          <div class="mpv-chg" id="mpvChg"></div>
        </div>
        <button class="mpv-close" id="mpvCloseBtn" title="關閉">✕</button>
      </div>
      <div class="mpv-cta-row">
        <button class="mpv-cta" id="mpvEnterBtn">📈 進入個股頁面</button>
      </div>
      <div class="mpv-body">
        <div class="mpv-section" id="mpvRSSec"></div>
        <div class="mpv-section" id="mpvChartSec"></div>
        <div class="mpv-section" id="mpvIndSec"></div>
        <div class="mpv-section" id="mpvYaoguSec"></div>
        <div class="mpv-section" id="mpvFundSec"></div>
        <div class="mpv-section" id="mpvRevSec"></div>
        <div class="mpv-section" id="mpvChipSec"></div>
        <div class="mpv-section">
          <div class="mpv-sec-title">相關連結</div>
          <div class="mpv-links" id="mpvLinks"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(_bg);

  _bg.addEventListener('click', e => { if (e.target === _bg) closeMobilePreview(); });
  _bg.querySelector('#mpvCloseBtn').addEventListener('click', closeMobilePreview);
  _bg.querySelector('#mpvEnterBtn').addEventListener('click', _enterStock);

  window.__mobileOpenPreview = openMobilePreview;
}
