/**
 * analysis-kline.js
 * 支撐壓力頁專用 Canvas 渲染器
 * 職責：折線K線 + 支撐線 / 壓力線 / 箱型 各自獨立渲染
 * 對外 API：initSRKline(containerEl, candles, r, fetchFn)
 */
import { analyze } from './chart-analysis.js';

// ── 常數 ──────────────────────────────────────────────────
const PERIOD_N = { '30d': 30, '60d': 60, '3mo': 90, '6mo': 130 };
const PERIOD_API = { '30d': '1mo', '60d': '3mo', '3mo': '3mo', '6mo': '6mo' };
const RES_COL  = '#e53935';
const SUP_COL  = '#1e88e5';
const NOW_COL  = '#FFD600';
const LINE_BG  = '#0d1117';

// ── 狀態 ──────────────────────────────────────────────────
let _cvs      = null;
let _ctx      = null;
let _candles  = [];
let _r        = null;
let _curN     = 60;
let _layer    = 'sr';   // 'sr' | 'box'
let _selKey   = null;   // 目前選中的關卡 key（'R1'/'R2'/'S1'/'S2'...）
let _levels   = [];     // [{ key, type, price, col, stars, distance }]
let _touchMap = {};     // { R1: [idxArray], S1: [idxArray] }
let _fetchFn  = null;   // async (period) => candles[]

// ── 初始化 ─────────────────────────────────────────────────
export function initSRKline(wrapEl, candles, r, fetchFn) {
  _fetchFn = fetchFn ?? null;
  _candles = candles || [];
  _r       = r;
  window.__srData = r;  // 橋接給 analysis-perspective.js 使用
  _curN    = Math.min(60, _candles.length);
  _layer   = 'sr';
  _selKey  = null;

  // 建立 DOM
  wrapEl.innerHTML = _buildHTML();

  _cvs = wrapEl.querySelector('#srkCanvas');
  _ctx = _cvs?.getContext('2d');
  if (!_cvs || !_ctx) return;

  // 建立關卡清單
  _buildLevels();

  // 綁定事件
  _bindPeriodBtns(wrapEl);
  _bindLayerBtns(wrapEl);
  _bindLevelCards(wrapEl);

  // 初次繪製
  _resize();
  draw();
}

// 重置（換股時呼叫）
export function resetSRKline() {
  _cvs = null; _ctx = null;
  _candles = []; _r = null;
  _selKey = null; _levels = []; _touchMap = {};
}

// ── HTML 骨架 ──────────────────────────────────────────────
function _buildHTML() {
  const now = _candles.length ? _candles[_candles.length - 1].close : 0;

  // 壓力格子
  const resItems = (_r?.resistance?.items || []).slice(0, 2);
  const supItems = (_r?.support?.items    || []).slice(0, 2);

  const _lvCard = (item, type, idx) => {
    const key   = (type === 'res' ? 'R' : 'S') + (idx + 1);
    const dist  = now > 0 ? ((item.price - now) / now * 100).toFixed(1) : '—';
    const sign  = +dist >= 0 ? '+' : '';
    const stars = '★'.repeat(item.strength || 1) + '☆'.repeat(Math.max(0, 3 - (item.strength || 1)));
    const cls   = type === 'res' ? 'srk-res' : 'srk-sup';
    const tcls  = type === 'res' ? 'srk-tag-r' : 'srk-tag-s';
    const dcls  = type === 'res' ? 'srk-dist-r' : 'srk-dist-s';
    return `
      <div class="srk-lvcard ${cls}" data-key="${key}" data-type="${type}" data-price="${item.price}">
        <div class="srk-tag ${tcls}">${type === 'res' ? '壓力' : '支撐'} ${key}</div>
        <div class="srk-price">${item.price}</div>
        <div class="srk-lv-sub">
          <span class="srk-dist ${dcls}">${sign}${dist}%</span>
          <span class="srk-stars">${stars}</span>
        </div>
      </div>`;
  };

  const resGrid = resItems.length
    ? resItems.map((it, i) => _lvCard(it, 'res', i)).join('')
    : `<div class="srk-empty-lv">上方無顯著壓力</div>`;

  const supGrid = supItems.length
    ? supItems.map((it, i) => _lvCard(it, 'sup', i)).join('')
    : `<div class="srk-empty-lv">下方無顯著支撐</div>`;

  // 操作建議
  const advice = (_r?.srAdvice || []).map(a => `<div class="srk-adv-line">${a}</div>`).join('');

  // 來源說明
  const srcRows = [
    ...resItems.map((it, i) => ({
      key: 'R' + (i+1), col: i === 0 ? RES_COL : '#ef9a9a',
      price: it.price, desc: (it.sources || []).join(' × ')
    })),
    ...supItems.map((it, i) => ({
      key: 'S' + (i+1), col: i === 0 ? SUP_COL : '#90caf9',
      price: it.price, desc: (it.sources || []).join(' × ')
    })),
  ].map(s => `
    <div class="srk-src-row" data-key="${s.key}">
      <div class="srk-src-dot" style="background:${s.col}"></div>
      <span class="srk-src-name">${s.key[0]==='R'?'壓力':'支撐'} ${s.key}　${s.price}</span>
      <span class="srk-src-desc">${s.desc}</span>
      <span class="srk-src-arr">›</span>
    </div>`).join('');

  return `
    <!-- K 線卡 -->
    <div class="srk-card" style="padding:10px 12px 8px">
      <div class="srk-btn-row">
        <button class="srk-chip" data-period="30d">30日</button>
        <button class="srk-chip active" data-period="60d">60日</button>
        <button class="srk-chip" data-period="3mo">3月</button>
        <button class="srk-chip" data-period="6mo">半年</button>
        <div class="srk-sep"></div>
        <button class="srk-chip srk-layer active-sr" data-layer="sr">支撐壓力</button>
        <button class="srk-chip srk-layer" data-layer="box">箱型</button>
      </div>
      <canvas id="srkCanvas" height="180" style="background:${LINE_BG};border-radius:8px;display:block;width:100%"></canvas>
      <div class="srk-hint" id="srkHint">點選下方關卡，K 線高亮觸及點</div>
    </div>

    <!-- 關卡格子 -->
    <div class="srk-card">
      <div class="srk-card-label">關卡清單 — 點選互動</div>
      <div class="srk-grid" id="srkResGrid">${resGrid}</div>
      <div class="srk-ruler">
        <div class="srk-ruler-line"></div>
        <span class="srk-ruler-price">現價 ${now}</span>
        <div class="srk-ruler-line"></div>
      </div>
      <div class="srk-grid" id="srkSupGrid">${supGrid}</div>
    </div>

    ${advice ? `
    <!-- 操作建議 -->
    <div class="srk-card">
      <div class="srk-advice-box">
        <div class="srk-adv-title">💡 操作建議</div>
        ${advice}
      </div>
    </div>` : ''}

    ${srcRows ? `
    <!-- 來源說明 -->
    <div class="srk-card">
      <div class="srk-card-label">關卡來源說明</div>
      ${srcRows}
    </div>` : ''}
  `;
}

// ── 建立關卡清單 + 觸及索引 ───────────────────────────────
function _buildLevels() {
  _levels = [];
  _touchMap = {};

  const now = _candles.length ? _candles[_candles.length - 1].close : 0;

  (_r?.resistance?.items || []).slice(0, 2).forEach((it, i) => {
    const key = 'R' + (i + 1);
    _levels.push({ key, type: 'res', price: it.price, col: i === 0 ? RES_COL : '#ef5350' });
  });
  (_r?.support?.items || []).slice(0, 2).forEach((it, i) => {
    const key = 'S' + (i + 1);
    _levels.push({ key, type: 'sup', price: it.price, col: i === 0 ? SUP_COL : '#42a5f5' });
  });

  // 各自獨立計算觸及點
  _levels.forEach(lv => {
    const band = lv.price * 0.015;
    // 壓力：高點靠近；支撐：低點靠近
    _touchMap[lv.key] = _candles.reduce((acc, c, i) => {
      if (lv.type === 'res' && c.high  >= lv.price - band) acc.push(i);
      if (lv.type === 'sup' && c.low   <= lv.price + band) acc.push(i);
      return acc;
    }, []);
  });
}

// ── 繪製主函式 ────────────────────────────────────────────
export function draw() {
  if (!_ctx || !_cvs) return;
  const cs  = _candles.slice(-_curN);
  if (!cs.length) return;

  const W = _cvs.width, H = _cvs.height;
  _ctx.clearRect(0, 0, W, H);
  _ctx.fillStyle = LINE_BG;
  _ctx.fillRect(0, 0, W, H);

  // 價格範圍（壓力支撐線也納入）
  const allP = cs.flatMap(c => [c.high || c.h, c.low || c.l])
    .concat(_levels.map(l => l.price))
    .concat([cs[cs.length - 1].close || cs[cs.length - 1].c]);
  const minP = Math.min(...allP) * 0.99;
  const maxP = Math.max(...allP) * 1.01;

  const PL = 4, PR = 52, PT = 10, PB = 8;
  const CW = W - PL - PR, CH = H - PT - PB;

  function py(p) { return PT + CH * (1 - (p - minP) / (maxP - minP)); }
  function px(i) { return PL + (i / (cs.length - 1 || 1)) * CW; }
  function getC(c) { return c.close ?? c.c ?? 0; }
  function getH(c) { return c.high  ?? c.h ?? getC(c); }
  function getL(c) { return c.low   ?? c.l ?? getC(c); }

  // grid
  _ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  _ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = PT + CH * i / 4;
    _ctx.beginPath(); _ctx.moveTo(PL, y); _ctx.lineTo(W - PR, y); _ctx.stroke();
  }

  // ── 圖層：箱型 ───────────────────────────────────────────
  if (_layer === 'box' && _r?.box?.isBox) {
    const bTop = py(_r.box.upper);
    const bBot = py(_r.box.lower);
    const grad = _ctx.createLinearGradient(0, bTop, 0, bBot);
    grad.addColorStop(0,  'rgba(245,158,11,0.06)');
    grad.addColorStop(1,  'rgba(245,158,11,0.16)');
    _ctx.fillStyle = grad;
    _ctx.fillRect(PL, bTop, CW, bBot - bTop);
    _ctx.save();
    _ctx.setLineDash([4, 3]);
    _ctx.strokeStyle = 'rgba(245,158,11,0.6)';
    _ctx.lineWidth = 1;
    ['upper', 'lower'].forEach(k => {
      const y = py(_r.box[k]);
      _ctx.beginPath(); _ctx.moveTo(PL, y); _ctx.lineTo(W - PR, y); _ctx.stroke();
      _ctx.fillStyle = 'rgba(245,158,11,0.8)';
      _ctx.font = '10px sans-serif'; _ctx.textAlign = 'left';
      _ctx.fillText((k === 'upper' ? '上緣 ' : '下緣 ') + _r.box[k], W - PR + 3, y + (k === 'upper' ? -3 : 11));
    });
    _ctx.restore();
  }

  // ── 圖層：支撐壓力（分開渲染）────────────────────────────
  if (_layer === 'sr') {
    _levels.filter(lv => lv.type === 'res').forEach(lv => _drawHLine(lv, cs, py, px, W, PR));
    _levels.filter(lv => lv.type === 'sup').forEach(lv => _drawHLine(lv, cs, py, px, W, PR));
  }

  // ── 折線 K 線 ────────────────────────────────────────────
  const closes = cs.map(getC);
  _ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  _ctx.lineWidth = 1;
  _ctx.lineJoin = 'round';
  _ctx.beginPath();
  closes.forEach((v, i) => { i === 0 ? _ctx.moveTo(px(i), py(v)) : _ctx.lineTo(px(i), py(v)); });
  _ctx.stroke();

  // 折線填色
  const grad2 = _ctx.createLinearGradient(0, py(Math.max(...closes)), 0, py(Math.min(...closes)));
  grad2.addColorStop(0, 'rgba(59,130,246,0.18)');
  grad2.addColorStop(1, 'rgba(59,130,246,0.01)');
  _ctx.fillStyle = grad2;
  _ctx.beginPath();
  closes.forEach((v, i) => { i === 0 ? _ctx.moveTo(px(i), py(v)) : _ctx.lineTo(px(i), py(v)); });
  _ctx.lineTo(px(closes.length - 1), H); _ctx.lineTo(px(0), H);
  _ctx.closePath(); _ctx.fill();

  // ── 觸及高亮（sr 模式 + 選中關卡）───────────────────────
  if (_layer === 'sr' && _selKey) {
    const lv = _levels.find(l => l.key === _selKey);
    if (lv) {
      // 只處理對應類型的觸及點
      const idxOffset = _candles.length - cs.length;
      const touches   = (_touchMap[lv.key] || [])
        .filter(i => i >= idxOffset)
        .map(i => i - idxOffset);

      touches.forEach(i => {
        const hy = lv.type === 'res' ? py(getH(cs[i])) : py(getL(cs[i]));
        // 光暈
        _ctx.beginPath();
        _ctx.arc(px(i), hy, 6, 0, Math.PI * 2);
        _ctx.fillStyle = lv.col + '44';
        _ctx.fill();
        // 圓圈
        _ctx.beginPath();
        _ctx.arc(px(i), hy, 4, 0, Math.PI * 2);
        _ctx.strokeStyle = lv.col;
        _ctx.lineWidth = 1.5;
        _ctx.stroke();
      });
    }
  }

  // ── 現價線 ───────────────────────────────────────────────
  const nowPrice = getC(cs[cs.length - 1]);
  const yn = py(nowPrice);
  _ctx.save(); _ctx.setLineDash([2, 2]);
  _ctx.strokeStyle = NOW_COL; _ctx.lineWidth = 1;
  _ctx.beginPath(); _ctx.moveTo(PL, yn); _ctx.lineTo(W - PR, yn); _ctx.stroke();
  _ctx.restore();
  _ctx.fillStyle = NOW_COL; _ctx.font = 'bold 10px sans-serif'; _ctx.textAlign = 'left';
  _ctx.fillText(nowPrice.toFixed(1), W - PR + 3, yn + 3.5);
}

// ── 水平線繪製（壓力/支撐分開呼叫）──────────────────────
function _drawHLine(lv, cs, py, px, W, PR) {
  const act = _selKey === lv.key;
  _ctx.save();
  _ctx.setLineDash([4, 3]);
  _ctx.strokeStyle = act ? lv.col : lv.col + '66';
  _ctx.lineWidth   = act ? 1.5 : 0.8;
  _ctx.beginPath();
  _ctx.moveTo(4, py(lv.price));
  _ctx.lineTo(W - PR, py(lv.price));
  _ctx.stroke();
  _ctx.restore();
  // 標籤
  _ctx.fillStyle  = act ? lv.col : lv.col + 'aa';
  _ctx.font       = (act ? 'bold ' : '') + '10px sans-serif';
  _ctx.textAlign  = 'left';
  _ctx.fillText(lv.key + ' ' + lv.price, W - PR + 3, py(lv.price) + 3.5);
}

// ── 趨勢線繪製 ───────────────────────────────────────────

// ── 事件綁定 ──────────────────────────────────────────────
function _bindPeriodBtns(wrapEl) {
  wrapEl.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const period    = btn.dataset.period;
      const apiPeriod = PERIOD_API[period] || '3mo';
      const n         = PERIOD_N[period]   || 60;

      // 更新 active 狀態
      wrapEl.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _selKey = null;
      _clearLvSel(wrapEl);

      // 有 fetchFn → 重拉 API
      if (_fetchFn) {
        _drawLoading('載入中…');
        try {
          const newCandles = await _fetchFn(apiPeriod);
          if (newCandles && newCandles.length > 0) {
            _candles = newCandles;
            _curN    = Math.min(n, _candles.length);
            // 用新 candles 重算支撐壓力
            const newR = analyze(_candles);
            _r = newR;
            _buildLevels();
            // 更新關卡格子
            _rebuildLevelCards(wrapEl, newR, newCandles);
            draw();
          } else {
            _drawLoading('資料不足');
          }
        } catch (e) {
          console.warn('[analysis-kline] fetchFn failed:', e);
          _drawLoading('載入失敗');
        }
        return;
      }

      // 沒有 fetchFn → slice 現有 candles
      if (n > _candles.length) {
        const hint = wrapEl.querySelector('#srkHint');
        if (hint) hint.textContent = `⚠ 目前 ${_candles.length} 根，請切換至更長週期後重新開啟`;
        return;
      }
      _curN = n;
      draw();
    });
  });
}

function _bindLayerBtns(wrapEl) {
  wrapEl.querySelectorAll('[data-layer]').forEach(btn => {
    btn.addEventListener('click', () => {
      _layer  = btn.dataset.layer;
      _selKey = null;
      wrapEl.querySelectorAll('.srk-layer').forEach(b => {
        b.classList.remove('active-sr', 'active-trend', 'active-box');
      });
      btn.classList.add('active-' + _layer);
      _clearLvSel(wrapEl);
      const hint = wrapEl.querySelector('#srkHint');
      if (hint) {
        hint.textContent =
          _layer === 'sr'  ? '點選下方關卡，K 線高亮觸及點' :
                             '黃色帶 = 箱型整理區間';
      }
      draw();
    });
  });
}

function _bindLevelCards(wrapEl) {
  wrapEl.querySelectorAll('[data-key][data-type]').forEach(card => {
    card.addEventListener('click', () => {
      // 點格子自動切到 sr 圖層
      if (_layer !== 'sr') {
        _layer = 'sr';
        wrapEl.querySelectorAll('.srk-layer').forEach(b => {
          b.classList.remove('active-sr', 'active-trend', 'active-box');
        });
        wrapEl.querySelector('[data-layer="sr"]')?.classList.add('active-sr');
        const hint = wrapEl.querySelector('#srkHint');
        if (hint) hint.textContent = '點選下方關卡，K 線高亮觸及點';
      }
      const key = card.dataset.key;
      const was = _selKey === key;
      _selKey = was ? null : key;
      _clearLvSel(wrapEl);
      if (!was) {
        const selCls = card.dataset.type === 'res' ? 'srk-sel-res' : 'srk-sel-sup';
        card.classList.add(selCls);
      }
      draw();
    });
  });

  // 來源說明行點擊（同步選中關卡）
  wrapEl.querySelectorAll('.srk-src-row[data-key]').forEach(row => {
    row.addEventListener('click', () => {
      const card = wrapEl.querySelector(`[data-key="${row.dataset.key}"][data-type]`);
      if (card) card.click();
    });
  });
}

function _clearLvSel(wrapEl) {
  wrapEl.querySelectorAll('[data-key][data-type]').forEach(c => {
    c.classList.remove('srk-sel-res', 'srk-sel-sup');
  });
}

// Canvas 顯示 loading 文字
function _drawLoading(msg) {
  if (!_ctx || !_cvs) return;
  const W = _cvs.width, H = _cvs.height;
  _ctx.clearRect(0, 0, W, H);
  _ctx.fillStyle = LINE_BG;
  _ctx.fillRect(0, 0, W, H);
  _ctx.fillStyle = 'rgba(255,255,255,0.3)';
  _ctx.font = '13px sans-serif';
  _ctx.textAlign = 'center';
  _ctx.fillText(msg, W / 2, H / 2);
}

// 重算後更新關卡格子 HTML
function _rebuildLevelCards(wrapEl, newR, newCandles) {
  const resGrid = wrapEl.querySelector('#srkResGrid');
  const supGrid = wrapEl.querySelector('#srkSupGrid');
  const ruler   = wrapEl.querySelector('.srk-ruler-price');
  if (!resGrid || !supGrid) return;

  const now = newCandles.length ? newCandles[newCandles.length - 1].close : 0;
  if (ruler) ruler.textContent = '現價 ' + now;

  const _lvCard = (item, type, idx) => {
    const key   = (type === 'res' ? 'R' : 'S') + (idx + 1);
    const dist  = now > 0 ? ((item.price - now) / now * 100).toFixed(1) : '—';
    const sign  = +dist >= 0 ? '+' : '';
    const stars = '★'.repeat(item.strength || 1) + '☆'.repeat(Math.max(0, 3 - (item.strength || 1)));
    const cls   = type === 'res' ? 'srk-res' : 'srk-sup';
    const tcls  = type === 'res' ? 'srk-tag-r' : 'srk-tag-s';
    const dcls  = type === 'res' ? 'srk-dist-r' : 'srk-dist-s';
    return `
      <div class="srk-lvcard ${cls}" data-key="${key}" data-type="${type}" data-price="${item.price}">
        <div class="srk-tag ${tcls}">${type === 'res' ? '壓力' : '支撐'} ${key}</div>
        <div class="srk-price">${item.price}</div>
        <div class="srk-lv-sub">
          <span class="srk-dist ${dcls}">${sign}${dist}%</span>
          <span class="srk-stars">${stars}</span>
        </div>
      </div>`;
  };

  const resItems = (newR?.resistance?.items || []).slice(0, 2);
  const supItems = (newR?.support?.items    || []).slice(0, 2);

  resGrid.innerHTML = resItems.length
    ? resItems.map((it, i) => _lvCard(it, 'res', i)).join('')
    : `<div class="srk-empty-lv">上方無顯著壓力</div>`;
  supGrid.innerHTML = supItems.length
    ? supItems.map((it, i) => _lvCard(it, 'sup', i)).join('')
    : `<div class="srk-empty-lv">下方無顯著支撐</div>`;

  // 重新綁點擊
  wrapEl.querySelectorAll('[data-key][data-type]').forEach(card => {
    card.addEventListener('click', () => {
      if (_layer !== 'sr') {
        _layer = 'sr';
        wrapEl.querySelectorAll('.srk-layer').forEach(b => {
          b.classList.remove('active-sr', 'active-trend', 'active-box');
        });
        wrapEl.querySelector('[data-layer="sr"]')?.classList.add('active-sr');
      }
      const key = card.dataset.key;
      const was = _selKey === key;
      _selKey = was ? null : key;
      _clearLvSel(wrapEl);
      if (!was) card.classList.add(card.dataset.type === 'res' ? 'srk-sel-res' : 'srk-sel-sup');
      draw();
    });
  });
}

function _resize() {
  if (!_cvs) return;
  _cvs.width = _cvs.parentElement?.clientWidth - 26 || 420;
}
