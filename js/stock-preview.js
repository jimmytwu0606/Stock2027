/**
 * stock-preview.js — 個股速覽 Modal
 *
 * 篩選機制（個篩 / 型態 / 種子 / 題材）選出的個股，點擊先跳此 modal 速覽，
 * modal 內「進入個股頁面」才真正切看盤 tab + 載入個股頁。
 *
 * 資料源（全部現有，零後端改動）：
 *   - 價格：window.__priceCache（PriceHub）→ fallback IDB 1y K 線最後兩根
 *   - K 線 + MA20/60/120：IDB getKlineCache 1y（.TW/.TWO 雙查），canvas 自繪零依賴
 *   - 基本面：fetchFundamentals（PE/PB/殖利率/EPS/市值/淨利率）
 *   - 月營收：fetchFinMindRevenue（需 FinMind Token，無 token 隱藏區塊）
 *   - 法人：fetchChipData（當日）+ fetchForeignBuyDays（外資近10日）；要不到資料 → 整區隱藏
 *   - 相關連結：URL 拼接（TradingView 依 K 線 symbol suffix 判斷 TWSE/TPEX）
 *
 * 進入個股頁面流程（根治 K 線空白）：
 *   1. 切 main-tab[data-tab=chart] + tabChart panel active（含手機 tab-item）
 *   2. AppState.period = '1mo' + tb-btn active 同步
 *   3. dispatch stockSelect（帶原始 ctx：matchedConds/strategyId/fromScreener…）
 *      → main.js 既有監聽 → screenerContext + loadStock 完整重載
 *
 * export:
 *   openStockPreview(code, ctx?)   ctx = stockSelect detail 透傳 + 可選 _afterEnter()
 *
 * ⚠️ 踩雷備忘：
 *   - 不用全域 .up/.down（additions.css 是國際慣例綠漲），色彩 class 一律 spv- 前綴寫死台股色
 *   - K 線只查 IDB，不打 Worker（modal 是速覽，miss 就顯示「無 K 線快取」）
 *   - MA 在完整 1y 序列上計算後再切顯示視窗，避免暖機期空值
 */

import { AppState } from './state.js';
import { toYahooSymbol, getChineseName, fetchFundamentals, fetchFinMindRevenue, fetchChipData, fetchForeignBuyDays } from './api.js';
import { getKlineCache } from './db.js';
import { getFinMindToken } from './config.js';

const UP = '#ef5350', DOWN = '#26a69a';            // 台股：漲紅跌綠
const MA_COLORS = { 20: '#58a6ff', 60: '#d4a72c', 120: '#e8b04b' };
const PERIODS = [{ label: '3月', n: 65 }, { label: '6月', n: 130 }, { label: '1年', n: 250 }];

let _bg = null;            // modal 背板 DOM
let _openSeq = 0;          // 防止快速連開時舊資料蓋新資料
let _curCode = null;
let _curCtx = null;
let _curSymbol = null;     // K 線命中的 yahoo symbol（連結用）
let _candles1y = null;     // 當前股票 1y K 線（period 切換重繪用）
let _periodIdx = 2;        // 預設 1年

// ─────────────────────────────────────────────
// 對外入口
// ─────────────────────────────────────────────
export async function openStockPreview(code, ctx = {}) {
  _ensureDom();
  const seq = ++_openSeq;
  _curCode = code;
  _curCtx = ctx;
  _curSymbol = null;
  _candles1y = null;
  _periodIdx = 2;

  _bg.style.display = 'flex';
  document.addEventListener('keydown', _onEsc);

  // ── Header 先用快取即繪 ──
  const name = getChineseName(code) || window.__nameCache?.get?.(code) || window.__priceCache?.[code]?.name || '';
  _el('spvCode').textContent = code;
  _el('spvName').textContent = name;
  _renderPrice(window.__priceCache?.[code] ?? null);

  // ── 各區塊重置為載入中 ──
  _el('spvChartSec').innerHTML = _skel('K 線載入中…');
  _el('spvFundSec').innerHTML = _skel('基本面載入中…');
  _el('spvRevSec').innerHTML = '';
  _el('spvChipSec').innerHTML = '';
  _renderLinks(code, null);

  // ── 並行載入，各自渲染（互不阻塞）──
  _loadKline(code, seq);
  _loadFund(code, seq);
  _loadRevenue(code, seq);
  _loadChips(code, seq);
}

export function initStockPreview() {
  _ensureDom();   // 啟動時建好 DOM + window.__openStockPreview 橋接
}

export function closeStockPreview() {
  if (_bg) _bg.style.display = 'none';
  document.removeEventListener('keydown', _onEsc);
}

function _onEsc(e) { if (e.key === 'Escape') closeStockPreview(); }

// ─────────────────────────────────────────────
// 進入個股頁面（CTA）
// ─────────────────────────────────────────────
function _enterStock() {
  const code = _curCode, ctx = _curCtx ?? {};
  if (!code) return;
  closeStockPreview();

  // 1. 切看盤 tab（桌機 + 手機）
  document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.main-tab[data-tab="chart"]')?.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('tabChart');
  if (panel) { panel.style.display = ''; panel.classList.add('active'); }
  document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
  document.querySelector('.tab-item[data-mobile-tab="chart"]')?.classList.add('active');
  const sb = document.querySelector('.sidebar'); if (sb) sb.style.display = '';
  const mn = document.querySelector('.main');    if (mn) mn.style.display = '';

  // 2. K 線週期固定 1mo + 工具列按鈕同步
  AppState.period = '1mo';
  document.querySelectorAll('.tb-btn[data-period]').forEach(b =>
    b.classList.toggle('active', b.dataset.period === '1mo'));

  // 3. 走既有 stockSelect 流程（main.js 監聽 → screenerContext + loadStock 完整重載）
  const { _afterEnter, ...detail } = ctx;
  document.dispatchEvent(new CustomEvent('stockSelect', { detail: { ...detail, code } }));

  // 4. 來源模組的後續事件（如 pattern-ui 的 patternHighlight）
  try { _afterEnter?.(); } catch (_) {}
}

// ─────────────────────────────────────────────
// K 線（canvas 自繪）
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
    _el('spvChartSec').innerHTML = _skel('無 K 線快取（bundle 尚未灌入此股）');
    return;
  }
  _candles1y = candles;
  _curSymbol = sym;
  _renderLinks(code, sym);

  // 價格 fallback：priceCache 沒有時用 K 線最後兩根
  if (!window.__priceCache?.[code] && candles.length >= 2) {
    const last = candles[candles.length - 1], prev = candles[candles.length - 2];
    _renderPrice({ price: last.close, prev: prev.close,
      chgPct: prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0 });
  }

  _renderChartSec();
}

function _renderChartSec() {
  const sec = _el('spvChartSec');
  sec.innerHTML = `
    <div class="spv-ma-legend">
      ${[20, 60, 120].map(n => `<span style="color:${MA_COLORS[n]}"><b>MA${n}</b></span>`).join('')}
    </div>
    <canvas class="spv-kcanvas" id="spvKCanvas"></canvas>
    <div class="spv-period-row">
      ${PERIODS.map((p, i) =>
        `<button class="spv-pbtn${i === _periodIdx ? ' active' : ''}" data-pi="${i}">${p.label}</button>`).join('')}
    </div>`;
  sec.querySelectorAll('.spv-pbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      _periodIdx = +btn.dataset.pi;
      sec.querySelectorAll('.spv-pbtn').forEach(b => b.classList.toggle('active', +b.dataset.pi === _periodIdx));
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

function _drawKline() {
  const cv = _el('spvKCanvas');
  if (!cv || !_candles1y) return;
  const all = _candles1y;
  const ma = { 20: _sma(all, 20), 60: _sma(all, 60), 120: _sma(all, 120) };

  const n = Math.min(PERIODS[_periodIdx].n, all.length);
  const s = all.length - n;
  const cs = all.slice(s);

  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || cv.parentElement.clientWidth || 440;
  const H = 180;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  let hi = -Infinity, lo = Infinity;
  for (const c of cs) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  for (const k of [20, 60, 120]) for (let i = s; i < all.length; i++) {
    const v = ma[k][i]; if (v != null) { if (v > hi) hi = v; if (v < lo) lo = v; }
  }
  if (!isFinite(hi) || hi === lo) { hi = lo + 1; }

  const padR = 54;
  const x = i => i / Math.max(cs.length - 1, 1) * (W - padR - 4) + 2;
  const y = v => (hi - v) / (hi - lo) * (H - 16) + 8;

  // 網格 + 右側價格刻度
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  for (let g = 0; g < 4; g++) {
    const gy = 8 + (H - 16) * g / 3;
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
    ctx.fillStyle = '#8a8f99';
    ctx.fillText(_fmtTick(hi - (hi - lo) * g / 3), W - padR + 6, gy + 3);
  }

  // K 棒
  const bw = Math.max(1, (W - padR) / cs.length - 1);
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
  const ly = Math.min(Math.max(y(last.close), 16), H - 8);
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
// 基本面
// ─────────────────────────────────────────────
async function _loadFund(code, seq) {
  let data = null;
  try { data = await fetchFundamentals(toYahooSymbol(code), code); } catch (_) {}
  if (seq !== _openSeq) return;
  const sec = _el('spvFundSec');
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
    <div class="spv-sec-title">基本面</div>
    <div class="spv-grid">
      ${_cell('P/E', num(data.pe))}
      ${_cell('P/B', num(data.pbRatio))}
      ${_cell('殖利率', pct(data.dividendYield))}
      ${_cell('EPS', num(data.eps))}
      ${_cell('市值', cap(data.marketCap))}
      ${_cell('淨利率', netMargin != null ? netMargin.toFixed(1) + '%' : '—')}
    </div>`;
}

function _cell(label, value) {
  return `<div class="spv-cell"><span class="spv-cell-label">${label}</span><span class="spv-cell-value">${value}</span></div>`;
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

  // rows 降冪（最新在前），單位千元
  const latest = rows[0];
  const rev = Number(latest.revenue);
  const prev12 = rows[12] ? Number(rows[12].revenue) : null;
  const yoy = prev12 && prev12 > 0 ? (rev - prev12) / prev12 * 100 : null;

  // 連續成長月數（YoY > 0 從最新往回數）
  let streak = 0;
  for (let i = 0; i < rows.length - 12; i++) {
    const r = Number(rows[i].revenue), p = Number(rows[i + 12].revenue);
    if (p > 0 && r > p) streak++; else break;
  }

  // 近 24 月 bars（升冪顯示），逐月 YoY 上色
  const view = rows.slice(0, 24);
  const maxRev = Math.max(...view.map(r => Number(r.revenue)), 1);
  const bars = [...view].reverse().map((r, _, arr) => {
    const i = rows.findIndex(x => x.date === r.date);
    const p12 = rows[i + 12] ? Number(rows[i + 12].revenue) : null;
    const pos = p12 == null || Number(r.revenue) >= p12;
    const h = Math.max(2, Math.round(Number(r.revenue) / maxRev * 46));
    return `<div class="spv-bar" style="height:${h}px;background:${pos ? UP : DOWN}" title="${r.date?.slice(0, 7)}"></div>`;
  }).join('');

  const amt = rev * 1000 >= 1e8 ? (rev * 1000 / 1e8).toFixed(1) + ' 億' : (rev * 1000 / 1e4).toFixed(0) + ' 萬';
  const yoyCls = yoy == null ? '' : (yoy >= 0 ? 'spv-up' : 'spv-down');
  const yoyTxt = yoy == null ? '' : `，YoY <b>${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%</b>`;
  const streakTxt = streak >= 2 ? `，連續 ${streak} 月成長` : '';

  _el('spvRevSec').innerHTML = `
    <div class="spv-sec-title">月營收</div>
    <div class="spv-rev-summary ${yoyCls}">營收 ${amt}${yoyTxt}${streakTxt}</div>
    <div class="spv-bars">${bars}</div>
    <div class="spv-bar-dates">
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
  if (!inst && !hist.length) return;   // 全要不到 → 隱藏

  const fmtN = v => v == null ? '—' : Math.abs(v).toLocaleString();
  const instCell = (name, val) => {
    const cls = val > 0 ? 'spv-up' : val < 0 ? 'spv-down' : '';
    return `<div class="spv-inst-col">
      <div class="spv-inst-name">${name}</div>
      <div class="spv-inst-sum ${cls}">${val > 0 ? '+' : val < 0 ? '-' : ''}${fmtN(val)} 張</div>
    </div>`;
  };

  let headline = '';
  let instHtml = '';
  if (inst) {
    const total = inst.total ?? 0;
    headline = `<div class="spv-chip-headline ${total >= 0 ? 'spv-up' : 'spv-down'}">
      今日三大法人${total >= 0 ? '買超' : '賣超'} <b>${fmtN(total)} 張</b></div>`;
    instHtml = `<div class="spv-inst-row">
      ${instCell('外資', inst.foreign)}${instCell('投信', inst.trust)}${instCell('自營商', inst.dealer)}
    </div>`;
  }

  // 外資近 10 日 bars（hist 降冪 → 升冪顯示）
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
    histHtml = `<div class="spv-fh-row">
      <span class="spv-inst-name">外資近 10 日</span>
      <div class="spv-fh-bars">${bars}</div>
      <span class="spv-inst-sum ${sum >= 0 ? 'spv-up' : 'spv-down'}">Σ ${sum >= 0 ? '+' : ''}${sum.toLocaleString()}</span>
    </div>`;
  }

  _el('spvChipSec').innerHTML = `
    <div class="spv-sec-title">法人動向</div>
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
  _el('spvLinks').innerHTML = links.map(([n, u]) =>
    `<a class="spv-link" href="${u}" target="_blank" rel="noopener">${n}</a>`).join('');
}

// ─────────────────────────────────────────────
// Header 價格
// ─────────────────────────────────────────────
function _renderPrice(p) {
  const priceEl = _el('spvPrice'), chgEl = _el('spvChg');
  if (!p || p.price == null) { priceEl.textContent = '—'; priceEl.className = 'spv-price'; chgEl.textContent = ''; return; }
  const chg = p.chg ?? (p.prev != null ? p.price - p.prev : 0);
  const chgPct = p.chgPct ?? (p.prev > 0 ? chg / p.prev * 100 : 0);
  const cls = chg >= 0 ? 'spv-up' : 'spv-down';
  priceEl.textContent = p.price.toLocaleString(undefined, { minimumFractionDigits: p.price < 100 ? 2 : 0, maximumFractionDigits: 2 });
  priceEl.className = `spv-price ${cls}`;
  chgEl.innerHTML = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}（${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%）`;
  chgEl.className = `spv-chg ${cls}`;
}

// ─────────────────────────────────────────────
// DOM 注入（只一次）
// ─────────────────────────────────────────────
function _el(id) { return document.getElementById(id); }
function _skel(t) { return `<div class="spv-skel">${t}</div>`; }

function _ensureDom() {
  if (_bg) return;

  if (!document.getElementById('spv-style')) {
    const st = document.createElement('style');
    st.id = 'spv-style';
    st.textContent = `
.spv-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);display:none;align-items:center;justify-content:center;z-index:1200}
.spv-modal{width:480px;max-width:96vw;max-height:92vh;background:var(--card,#161b22);border:1px solid rgba(255,255,255,.08);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55);font-size:13px}
.spv-header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
.spv-code{font-family:ui-monospace,monospace;font-size:16px;font-weight:700;color:var(--accent,#58a6ff)}
.spv-name{font-size:15px;font-weight:600;color:var(--text,#e8eaed)}
.spv-price-block{margin-left:auto;text-align:right}
.spv-price{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.spv-chg{font-size:12px;font-variant-numeric:tabular-nums}
.spv-up{color:${UP} !important}.spv-down{color:${DOWN} !important}
.spv-close{margin-left:6px;background:none;border:none;color:var(--muted,#8a8f99);font-size:18px;cursor:pointer;padding:4px;line-height:1}
.spv-close:hover{color:var(--text,#e8eaed)}
.spv-cta-row{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
.spv-cta{flex:1;padding:8px;border-radius:8px;border:1px solid rgba(88,166,255,.4);background:rgba(88,166,255,.12);color:var(--accent,#58a6ff);font-size:13px;font-weight:600;cursor:pointer;transition:.15s}
.spv-cta:hover{background:rgba(88,166,255,.22)}
.spv-body{overflow-y:auto;flex:1}
.spv-body::-webkit-scrollbar{width:8px}
.spv-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}
.spv-section{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.spv-section:last-child{border-bottom:none}
.spv-section:empty{display:none}
.spv-sec-title{font-size:12px;font-weight:700;color:var(--muted,#8a8f99);letter-spacing:.5px;margin-bottom:10px}
.spv-ma-legend{display:flex;gap:12px;font-size:11px;margin-bottom:6px}
.spv-kcanvas{width:100%;height:180px;display:block}
.spv-period-row{display:flex;gap:4px;margin-top:8px}
.spv-pbtn{padding:3px 10px;font-size:11px;border-radius:6px;border:1px solid rgba(255,255,255,.08);background:none;color:var(--muted,#8a8f99);cursor:pointer}
.spv-pbtn.active{background:rgba(88,166,255,.15);color:var(--accent,#58a6ff);border-color:rgba(88,166,255,.4)}
.spv-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden}
.spv-cell{background:var(--card2,#1c2230);padding:8px 12px;display:flex;justify-content:space-between;align-items:baseline}
.spv-cell-label{font-size:12px;color:var(--muted,#8a8f99)}
.spv-cell-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text,#e8eaed)}
.spv-rev-summary{font-size:12px;margin-bottom:8px;line-height:1.6}
.spv-bars{display:flex;align-items:flex-end;gap:3px;height:48px}
.spv-bar{flex:1;border-radius:2px 2px 0 0;min-height:2px}
.spv-bar-dates{display:flex;justify-content:space-between;font-size:10px;color:var(--muted,#8a8f99);margin-top:4px}
.spv-chip-headline{font-size:12px;margin-bottom:10px}
.spv-inst-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.spv-inst-col{background:var(--card2,#1c2230);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px}
.spv-inst-name{font-size:11px;color:var(--muted,#8a8f99)}
.spv-inst-sum{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:4px}
.spv-fh-row{display:flex;align-items:center;gap:10px}
.spv-fh-bars{display:flex;align-items:center;gap:2px;height:32px;flex:1}
.spv-fh-bars i{flex:1;border-radius:1px;display:block}
.spv-links{display:flex;flex-wrap:wrap;gap:8px}
.spv-link{font-size:12px;color:var(--muted,#8a8f99);padding:4px 10px;border:1px solid rgba(255,255,255,.08);border-radius:14px;text-decoration:none;transition:.15s}
.spv-link:hover{color:var(--accent,#58a6ff);border-color:rgba(88,166,255,.4)}
.spv-skel{color:var(--muted,#8a8f99);font-size:12px;padding:6px 0}`;
    document.head.appendChild(st);
  }

  _bg = document.createElement('div');
  _bg.className = 'spv-bg';
  _bg.id = 'spvModalBg';
  _bg.innerHTML = `
    <div class="spv-modal">
      <div class="spv-header">
        <span class="spv-code" id="spvCode"></span>
        <span class="spv-name" id="spvName"></span>
        <div class="spv-price-block">
          <div class="spv-price" id="spvPrice">—</div>
          <div class="spv-chg" id="spvChg"></div>
        </div>
        <button class="spv-close" id="spvCloseBtn" title="關閉">✕</button>
      </div>
      <div class="spv-cta-row">
        <button class="spv-cta" id="spvEnterBtn">📈 進入個股頁面</button>
      </div>
      <div class="spv-body">
        <div class="spv-section" id="spvChartSec"></div>
        <div class="spv-section" id="spvFundSec"></div>
        <div class="spv-section" id="spvRevSec"></div>
        <div class="spv-section" id="spvChipSec"></div>
        <div class="spv-section">
          <div class="spv-sec-title">相關連結</div>
          <div class="spv-links" id="spvLinks"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(_bg);

  _bg.addEventListener('click', e => { if (e.target === _bg) closeStockPreview(); });
  _bg.querySelector('#spvCloseBtn').addEventListener('click', closeStockPreview);
  _bg.querySelector('#spvEnterBtn').addEventListener('click', _enterStock);

  // 全域橋接：未 import 的模組（如 screener-hub）也能呼叫
  window.__openStockPreview = openStockPreview;
}
