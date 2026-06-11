/**
 * lag-ui.js — 領漲跟漲掃描 UI（hub 第四模式）
 * 職責：
 *   - 設定 Modal（領漲股 / maxLag / lookback / 門檻 / 股價區間）
 *   - 掃描進度與結果列表（複用 seed.css 的 seed-tb / sr-tbl 樣式）
 *   - 結果列點擊 → dispatch stockSelect
 * 引擎：seed-scan.js runLagScan / abortSeedScan
 */

import { runLagScan, abortSeedScan } from './seed-scan.js';
import { getChineseName }            from './api.js';
import { AppState }                  from './state.js';
import { calcHealth, calcHealthLong, renderHealthBadge } from './health.js';
import { getAllSignalsCache } from './db.js';

let _leaderCode = null;
let _scanning   = false;
let _results    = [];
let _sortKey    = 'corr';   // corr | lag | price | chg | hs | hl
let _sortAsc    = false;    // 預設降冪
let _yaoguMap   = new Map(); // code → { x1,x2,x5,x6, rank }

// ─── 初始化 ────────────────────────────────────────────────
export function initLagUI() {
  _bindModal();
  _bindToolbar();
}

// ─── Modal ─────────────────────────────────────────────────
function _bindModal() {
  const bg = document.getElementById('lagModalBg');

  document.getElementById('lagOpenConfig')?.addEventListener('click', () => {
    if (bg) bg.style.display = '';
  });
  document.getElementById('lagModalClose')?.addEventListener('click', () => {
    if (bg) bg.style.display = 'none';
  });
  bg?.addEventListener('click', e => { if (e.target === bg) bg.style.display = 'none'; });

  // 領漲股設定
  const setLeader = () => {
    const inp  = document.getElementById('lagLeaderInput');
    const code = inp?.value.trim();
    if (!code || !/^\d{4}$/.test(code)) { _toast('請輸入 4 碼股票代號'); return; }
    _leaderCode = code;
    const name = getChineseName(code) ?? '';
    const chip = document.getElementById('lagLeaderChip');
    if (chip) chip.innerHTML = `<span class="seed-tb-chip">${code} ${name}</span>`;
    const tbCode = document.getElementById('lagTbLeaderCode');
    if (tbCode) tbCode.textContent = `領漲股：${code} ${name}`;
    const scanBtn = document.getElementById('lagScanBtn');
    if (scanBtn) scanBtn.disabled = false;
    if (inp) inp.value = '';
  };
  document.getElementById('lagLeaderSetBtn')?.addEventListener('click', setLeader);
  document.getElementById('lagLeaderInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') setLeader();
  });

  // 門檻滑桿
  document.getElementById('lagThreshold')?.addEventListener('input', e => {
    const el = document.getElementById('lagThresholdVal');
    if (el) el.textContent = (e.target.value / 100).toFixed(2);
  });

  // Modal 內開始掃描
  document.getElementById('lagModalStart')?.addEventListener('click', () => {
    if (bg) bg.style.display = 'none';
    _startScan();
  });
}

// ─── Toolbar ───────────────────────────────────────────────
function _bindToolbar() {
  document.getElementById('lagScanBtn')?.addEventListener('click', _startScan);
  document.getElementById('lagAbortBtn')?.addEventListener('click', () => abortSeedScan());
}

// ─── 掃描 ──────────────────────────────────────────────────
async function _startScan() {
  if (_scanning) return;
  if (!_leaderCode) { _toast('請先設定領漲股（⚙ 設定領漲股）'); return; }

  const maxLag    = parseInt(document.querySelector('input[name="lagMaxLag"]:checked')?.value   ?? '5', 10);
  const lookback  = parseInt(document.querySelector('input[name="lagLookback"]:checked')?.value ?? '40', 10);
  const threshold = (parseInt(document.getElementById('lagThreshold')?.value ?? '70', 10)) / 100;
  const priceMin  = parseFloat(document.getElementById('lagPriceMin')?.value) || 0;
  const priceMax  = parseFloat(document.getElementById('lagPriceMax')?.value) || 99999;

  _scanning = true;
  _results  = [];
  _yaoguMap = new Map();
  (async () => {
    let allCache = [];
    try { allCache = await getAllSignalsCache(); } catch (_) {}
    allCache.forEach(row => {
      const sigs = row.signals ?? [];
      const x1 = sigs.some(sg => sg.id === 'X1');
      const x2 = sigs.some(sg => sg.id === 'X2');
      const x5 = sigs.some(sg => sg.id === 'X5');
      const x6 = sigs.some(sg => sg.id === 'X6');
      if (x1 || x2 || x5 || x6) {
        // 排序權重：X2 > X1 > X6 > X5
        const rank = x2 ? 4 : x1 ? 3 : x6 ? 2 : 1;
        _yaoguMap.set(row.code, { x1, x2, x5, x6, rank });
      }
    });
  })();
  _renderResults();
  _setScanningUI(true);

  let found = 0;
  try {
    for await (const ev of runLagScan(_leaderCode, { maxLag, lookback, threshold, priceMin, priceMax })) {
      switch (ev.type) {
        case 'progress': {
          _setProgress(ev.done, ev.total, ev.message);
          break;
        }
        case 'result': {
          found++;
          _results.push(ev.item);
          if (found <= 3 || found % 3 === 0) _renderResults();
          break;
        }
        case 'error': {
          _toast(ev.message);
          break;
        }
        case 'done':
        case 'aborted': {
          _results = [...(AppState.seed.scanResults ?? _results)];
          _renderResults();
          const sum = document.getElementById('lagSummary');
          if (sum) sum.textContent = ev.type === 'aborted' ? `已取消（找到 ${found} 檔）` : `找到 ${found} 檔`;
          break;
        }
      }
    }
  } finally {
    _scanning = false;
    _setScanningUI(false);
  }
}

// ─── UI 狀態 ───────────────────────────────────────────────
function _setScanningUI(on) {
  const scanBtn  = document.getElementById('lagScanBtn');
  const abortBtn = document.getElementById('lagAbortBtn');
  const progText = document.getElementById('lagProgressText');
  if (scanBtn)  scanBtn.style.display  = on ? 'none' : '';
  if (abortBtn) abortBtn.style.display = on ? '' : 'none';
  if (progText) progText.style.display = on ? '' : 'none';
  if (!on) _setProgress(0, 0, '');
}

function _setProgress(done, total, message) {
  const txt = document.getElementById('lagProgressText');
  const bar = document.getElementById('lagProgressBar');
  if (txt) txt.textContent = total > 0 ? `${message}（${done}/${total}）` : message;
  if (bar) bar.style.width = total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
}

// ─── 結果列表 ──────────────────────────────────────────────
const _COLS = [
  { key: 'code',  label: '代號' },
  { key: null,    label: '名稱' },
  { key: 'corr',  label: '相關性' },
  { key: 'lag',   label: '落後天數' },
  { key: 'price', label: '現價' },
  { key: 'chg',   label: '漲跌幅' },
  { key: 'hs',    label: '短線健康' },
  { key: 'hl',    label: '長線健康' },
  { key: 'yg',    label: '妖股' },
  { key: null,    label: '走勢' },
];

function _ensureHealth(item) {
  // 健康度每筆只算一次，cache 在 item 上（排序重渲染不重算）
  if (item._hs === undefined) {
    const short = item.miniCandles?.length > 65 ? item.miniCandles.slice(-65) : item.miniCandles;
    item._hs = short?.length >= 20 ? calcHealth(short) : null;
    item._hl = item.miniCandles?.length >= 120 ? calcHealthLong(item.miniCandles, null, item.code) : null;
  }
}

function _ygPills(code) {
  const yg = _yaoguMap.get(code);
  if (!yg) return '';
  return ['X2','X1','X6','X5']
    .filter(id => yg[id.toLowerCase()])
    .map(id => `<span class="th-yaogu-pill th-yaogu-pill--${id.toLowerCase()}">${id}</span>`)
    .join('');
}

function _sortVal(item, key) {
  switch (key) {
    case 'corr':  return item._pearson ?? -2;
    case 'lag':   return item.lag ?? 0;
    case 'price': return item.price ?? 0;
    case 'chg':   return item.chgPct ?? 0;
    case 'hs':    return item._hs ?? -1;
    case 'hl':    return item._hl ?? -1;
    case 'code':  return parseInt(item.code, 10) || 0;
    case 'yg':    return _yaoguMap.get(item.code)?.rank ?? 0;
    default:      return 0;
  }
}

function _renderResults() {
  const wrap = document.getElementById('lagResultList');
  if (!wrap) return;

  if (!_results.length) {
    if (!_scanning) return;  // 保留空狀態
    wrap.innerHTML = '<div class="seed-empty-state"><p>掃描中…</p></div>';
    return;
  }

  _results.forEach(_ensureHealth);
  const sorted = [..._results].sort((a, b) => {
    const av = _sortVal(a, _sortKey), bv = _sortVal(b, _sortKey);
    return _sortAsc ? av - bv : bv - av;
  });

  const thead = _COLS.map(c => {
    if (!c.key) return `<th class="sr-tbl-th no-sort">${c.label}</th>`;
    const isSorted = c.key === _sortKey;
    const arrow = isSorted ? (_sortAsc ? ' ▲' : ' ▼') : '';
    return `<th class="sr-tbl-th${isSorted ? ' sorted' : ''}" data-col="${c.key}">${c.label}${arrow}</th>`;
  }).join('');

  const rows = sorted.map(item => {
    const chgColor = item.chgPct >= 0 ? '#ef5350' : '#26a69a';  // 台股：漲紅跌綠
    const chgTxt = `${item.chgPct >= 0 ? '+' : ''}${(item.chgPct ?? 0).toFixed(2)}%`;
    return `<tr class="sr-tbl-row" data-code="${item.code}">
      <td class="sr-tbl-td sr-tbl-code">${item.code}</td>
      <td class="sr-tbl-td sr-tbl-name">${item.name}</td>
      <td class="sr-tbl-td" style="color:var(--accent);font-weight:600">${(item._pearson ?? 0).toFixed(2)}</td>
      <td class="sr-tbl-td"><span class="seed-tb-chip">落後 ${item.lag} 天</span></td>
      <td class="sr-tbl-td">${item.price ? Number(item.price).toFixed(item.price >= 500 ? 0 : 1) : '—'}</td>
      <td class="sr-tbl-td" style="color:${chgColor};font-weight:600">${chgTxt}</td>
      <td class="sr-tbl-td">${renderHealthBadge(item._hs, null, { compact: true })}</td>
      <td class="sr-tbl-td">${renderHealthBadge(item._hl, null, { compact: true })}</td>
      <td class="sr-tbl-td">${_ygPills(item.code)}</td>
      <td class="sr-tbl-td" style="width:130px"><canvas class="lag-mini-chart" height="36" style="width:120px" data-code="${item.code}"></canvas></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sr-tbl-wrap">
      <table class="sr-tbl">
        <thead><tr>${thead}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // 排序 header
  wrap.querySelectorAll('.sr-tbl-th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_sortKey === col) _sortAsc = !_sortAsc;
      else { _sortKey = col; _sortAsc = false; }
      _renderResults();
    });
  });

  // mini charts
  const map = new Map(sorted.map(i => [i.code, i]));
  wrap.querySelectorAll('.lag-mini-chart').forEach(canvas => {
    const item = map.get(canvas.dataset.code);
    if (item?.miniCandles?.length) {
      requestAnimationFrame(() => _drawMiniChart(canvas, item.miniCandles));
    }
  });

  // 點擊 → 個股頁
  wrap.querySelectorAll('.sr-tbl-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const code = tr.dataset.code;
      if (!code) return;
      document.dispatchEvent(new CustomEvent('stockSelect', {
        detail: { code, fromScreener: true, strategyId: null, strategyName: '領漲跟漲' },
      }));
    });
  });
}

// ─── Mini chart（近 60 根 + MA20 灰線暖機，台股紅漲綠跌）────
function _drawMiniChart(canvas, candles) {
  const w = canvas.offsetWidth || 120;
  const h = canvas.height;
  canvas.width = w;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const SHOW = 60;
  const allCloses = candles.map(c => c.close);
  const closes    = allCloses.slice(-SHOW);
  const offset    = allCloses.length - closes.length;
  const min   = Math.min(...closes);
  const max   = Math.max(...closes);
  const range = max - min || 1;
  const n     = closes.length;

  const xAt = i => (i / (n - 1)) * w;
  const yAt = v => h - ((v - min) / range) * h * 0.85 - h * 0.075;

  if (allCloses.length >= 20) {
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let sum = 0, started = false;
    const firstIdx = Math.max(0, offset - 19);
    for (let g = firstIdx; g < offset; g++) sum += allCloses[g];
    for (let i = 0; i < n; i++) {
      const g = offset + i;
      sum += allCloses[g];
      if (g >= 20) sum -= allCloses[g - 20];
      if (g < 19) continue;
      const x = xAt(i), y = yAt(Math.max(min, Math.min(max, sum / 20)));
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i), y = yAt(closes[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = closes[n - 1] >= closes[0] ? '#ef5350' : '#26a69a';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

// ─── 工具 ──────────────────────────────────────────────────
function _toast(msg) {
  document.dispatchEvent(new CustomEvent('showToast', { detail: msg }));
}
