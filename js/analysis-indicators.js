/**
 * analysis-indicators.js
 * ============================================================================
 * 智能分析 — 指標圖文解說面板（第五頁）
 * 四組 Tab：EMA均線組 / 震盪組 / 量化組 / 動能組
 *
 * 對外 API:
 *   initIndicatorPanel(wrapEl, candles, r)   ← 掛載並渲染
 *   resetIndicatorPanel()                     ← 清理舊狀態
 * ============================================================================
 */

import {
  calcEMA, calcGMMA, calcBollinger, calcEnvelope,
  calcKD, calcRSI, calcMACD,
  calcDMI, calcPSY, calcRCI, calcHV,
} from './indicators.js';

// ─── 台股多紅空綠 ───
const C_UP    = '#ef5350';   // 多頭紅
const C_DOWN  = '#26a69a';   // 空頭綠
const C_GOLD  = '#FFD600';   // 現價線
const C_GRID  = 'rgba(255,255,255,0.04)';
const C_BG    = '#0d1117';
const C_TEXT  = '#e8eaed';
const C_MUTED = '#8a8f99';
const C_BLUE  = '#3b82f6';
const C_AMBER = '#f59e0b';

let _wrapEl   = null;
let _candles  = null;
let _r        = null;
let _activeTab = 0;

// ─── Tab 定義 ───
const TABS = [
  { label: 'EMA均線組', icon: '📈' },
  { label: '震盪組',   icon: '🌊' },
  { label: '量化組',   icon: '📦' },
  { label: '動能組',   icon: '⚡' },
];

// ============================================================================
// 公開 API
// ============================================================================

export function resetIndicatorPanel() {
  _wrapEl    = null;
  _candles   = null;
  _r         = null;
  _activeTab = 0;
}

export function initIndicatorPanel(wrapEl, candles, r) {
  _wrapEl   = wrapEl;
  _candles  = candles;
  _r        = r;
  _activeTab = 0;

  if (!candles || candles.length < 30) {
    wrapEl.innerHTML = `<div class="ind-empty">K棒不足30根，無法計算指標</div>`;
    return;
  }

  _renderShell();
  _renderTab(_activeTab);
}

// ============================================================================
// 外殼骨架
// ============================================================================

function _renderShell() {
  _wrapEl.innerHTML = `
    <div class="ind-wrap">
      <div class="ind-tabbar" id="indTabBar">
        ${TABS.map((t, i) => `
          <button class="ind-tab ${i === 0 ? 'active' : ''}" data-tab="${i}">
            <span class="ind-tab-icon">${t.icon}</span>
            <span class="ind-tab-label">${t.label}</span>
          </button>`).join('')}
      </div>
      <div class="ind-content" id="indContent"></div>
    </div>
  `;

  _wrapEl.querySelectorAll('.ind-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = +btn.dataset.tab;
      _wrapEl.querySelectorAll('.ind-tab').forEach(b => b.classList.toggle('active', b === btn));
      _activeTab = tab;
      _renderTab(tab);
    });
  });
}

// ============================================================================
// Tab 分派
// ============================================================================

function _renderTab(tab) {
  const content = _wrapEl.querySelector('#indContent');
  if (!content) return;
  content.innerHTML = '';

  // 每次切換 Tab 後 rAF 確保 canvas 有寬度
  requestAnimationFrame(() => {
    if (tab === 0) _drawEMAGroup(content);
    if (tab === 1) _drawOscillator(content);
    if (tab === 2) _drawQuantGroup(content);
    if (tab === 3) _drawMomentum(content);
  });
}

// ============================================================================
// 共用工具
// ============================================================================

function _closes() {
  return _candles.map(c => c.close ?? c.c ?? 0);
}

/** 建一張 canvas card，回傳 { card, canvas, textEl } */
function _makeCard(title, height = 120) {
  const card = document.createElement('div');
  card.className = 'ind-card';
  card.innerHTML = `
    <div class="ind-card-title">${title}</div>
    <canvas class="ind-canvas" height="${height}"></canvas>
    <div class="ind-card-text"></div>
  `;
  return {
    card,
    canvas: card.querySelector('canvas'),
    textEl: card.querySelector('.ind-card-text'),
  };
}

/** 設定 canvas 實際像素大小 */
function _sizeCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w   = canvas.parentElement.clientWidth - 28 || 280;
  canvas.style.width  = w + 'px';
  canvas.style.height = height + 'px';
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h: height };
}

/** 畫背景格線 */
function _drawGrid(ctx, w, h, lines = 4) {
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth   = 0.5;
  for (let i = 1; i <= lines; i++) {
    const y = (h / (lines + 1)) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

/**
 * 折線繪製（過濾 null）
 * series: number[]，與 _candles 等長
 */
function _drawLine(ctx, series, w, h, minV, maxV, color, lineWidth = 1.5) {
  const n    = series.length;
  const span = maxV - minV || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;
  ctx.beginPath();
  let started = false;
  series.forEach((v, i) => {
    if (v == null) return;
    const x = (i / (n - 1)) * w;
    const y = h - ((v - minV) / span) * h;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** 帶狀填色（upper[] lower[] 均與 candles 等長） */
function _drawBand(ctx, upper, lower, w, h, minV, maxV, fillColor) {
  const n    = upper.length;
  const span = maxV - minV || 1;
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  upper.forEach((v, i) => {
    if (v == null) return;
    const x = (i / (n - 1)) * w;
    const y = h - ((v - minV) / span) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  for (let i = lower.length - 1; i >= 0; i--) {
    const v = lower[i];
    if (v == null) continue;
    const x = (i / (n - 1)) * w;
    const y = h - ((v - minV) / span) * h;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** 水平虛線 */
function _hline(ctx, y, w, color = '#555', dash = [4, 4]) {
  ctx.strokeStyle = color;
  ctx.lineWidth   = 0.7;
  ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  ctx.setLineDash([]);
}

/** 右上角標籤 */
function _label(ctx, text, color, x, y = 12) {
  ctx.font      = 'bold 10px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.fillText(text, x - 4, y);
}

/** 計算 series 中有效值的 [min, max]，含 padding */
function _minMax(series, padPct = 0.06) {
  let mn = Infinity, mx = -Infinity;
  series.forEach(v => {
    if (v == null) return;
    if (typeof v === 'object') { mn = Math.min(mn, v.lower ?? v.min ?? v); mx = Math.max(mx, v.upper ?? v.max ?? v); }
    else { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  });
  if (!isFinite(mn)) return [0, 100];
  const pad = (mx - mn) * padPct;
  return [mn - pad, mx + pad];
}

/** 合併多組序列的 minMax */
function _minMaxMulti(...seriesList) {
  let mn = Infinity, mx = -Infinity;
  seriesList.forEach(s => {
    s.forEach(v => {
      if (v == null) return;
      mn = Math.min(mn, v); mx = Math.max(mx, v);
    });
  });
  if (!isFinite(mn)) return [0, 100];
  const pad = (mx - mn) * 0.06;
  return [mn - pad, mx + pad];
}

/** 文解輔助：取最後一個非 null 值 */
function _last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

// ============================================================================
// Tab 0 — EMA 均線組
// ============================================================================

function _drawEMAGroup(content) {
  const closes  = _closes();
  const n       = closes.length;

  // EMA 5/10/20/60
  const ema5  = calcEMA(closes, 5);
  const ema10 = calcEMA(closes, 10);
  const ema20 = calcEMA(closes, 20);
  const ema60 = calcEMA(closes, 60);

  // BB
  const bb    = calcBollinger(closes, 20, 2);
  const bbUpper = bb.map(b => b?.upper ?? null);
  const bbMid   = bb.map(b => b?.mid   ?? null);
  const bbLower = bb.map(b => b?.lower ?? null);

  // ENV
  const env     = calcEnvelope(closes, 20, 5);
  const envU    = env.map(e => e?.upper ?? null);
  const envL    = env.map(e => e?.lower ?? null);

  // GMMA
  const gmma    = calcGMMA(closes);

  // ── Card 1: EMA + BB ──
  {
    const { card, canvas, textEl } = _makeCard('EMA均線 + 布林通道', 130);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 130);

    const allVals = [...closes, ...bbUpper.filter(Boolean), ...bbLower.filter(Boolean)];
    const [mn, mx] = _minMax(allVals);

    _drawGrid(ctx, w, h);

    // BB 填色
    _drawBand(ctx, bbUpper, bbLower, w, h, mn, mx, 'rgba(59,130,246,0.08)');

    // 現價折線
    _drawLine(ctx, closes, w, h, mn, mx, 'rgba(255,255,255,0.3)', 1);

    // EMA 線
    const emaColors = ['#f59e0b', '#3b82f6', '#a78bfa', '#ef5350'];
    [ema5, ema10, ema20, ema60].forEach((e, i) => _drawLine(ctx, e, w, h, mn, mx, emaColors[i], 1.2));

    // BB 上下軌
    _drawLine(ctx, bbUpper, w, h, mn, mx, 'rgba(59,130,246,0.7)', 1);
    _drawLine(ctx, bbMid,   w, h, mn, mx, 'rgba(59,130,246,0.4)', 0.8);
    _drawLine(ctx, bbLower, w, h, mn, mx, 'rgba(59,130,246,0.7)', 1);

    // 標籤
    const last5  = _last(ema5);
    const last60 = _last(ema60);
    _label(ctx, `EMA5:${last5?.toFixed(1)}`, '#f59e0b', w);

    // 文解
    const lastClose = closes[n - 1];
    const bbLast    = _last(bb);
    const e5 = _last(ema5), e10 = _last(ema10), e20 = _last(ema20), e60 = _last(ema60);

    let emaText = '';
    if (e5 && e10 && e20 && e60) {
      if (e5 > e10 && e10 > e20 && e20 > e60) emaText = '多頭排列（5>10>20>60），短線動能強';
      else if (e5 < e10 && e10 < e20 && e20 < e60) emaText = '空頭排列（5<10<20<60），偏空格局';
      else emaText = 'EMA糾結中，方向待確認';
    }

    let bbText = '';
    if (bbLast) {
      const width = bbLast.width;
      const pos = lastClose > bbLast.upper ? `突破上軌（現價+${((lastClose - bbLast.upper) / bbLast.upper * 100).toFixed(1)}%），短線偏強` :
                  lastClose < bbLast.lower ? `跌破下軌（現價${((lastClose - bbLast.lower) / bbLast.lower * 100).toFixed(1)}%），短線超賣` :
                  lastClose > bbLast.mid   ? `現價在中軌上方，偏強整理` : `現價在中軌下方，偏弱整理`;
      const squeeze = width < 3 ? 'BB帶寬收窄（<3），醞釀突破' : width > 8 ? 'BB帶寬擴張，行情進行中' : 'BB帶寬正常';
      bbText = `${squeeze}；${pos}`;
    }

    textEl.innerHTML = _textBlock([
      { icon: '📈', title: 'EMA均線', text: emaText },
      { icon: '🎯', title: '布林通道', text: bbText },
    ]);
  }

  // ── Card 2: ENV 乖離通道 ──
  {
    const { card, canvas, textEl } = _makeCard('ENV 乖離通道 (MA20 ±5%)', 100);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 100);

    const allVals = [...closes, ...envU.filter(Boolean), ...envL.filter(Boolean)];
    const [mn, mx] = _minMax(allVals);

    _drawGrid(ctx, w, h);
    _drawBand(ctx, envU, envL, w, h, mn, mx, 'rgba(245,158,11,0.07)');
    _drawLine(ctx, closes, w, h, mn, mx, 'rgba(255,255,255,0.3)', 1);
    _drawLine(ctx, envU, w, h, mn, mx, 'rgba(245,158,11,0.7)', 1);
    _drawLine(ctx, envL, w, h, mn, mx, 'rgba(245,158,11,0.7)', 1);

    const lastClose = closes[n - 1];
    const lastEnvU  = _last(envU);
    const lastEnvL  = _last(envL);
    let envText = '';
    if (lastEnvU && lastEnvL) {
      if (lastClose > lastEnvU)      envText = `突破上軌（+5%），強勢，追高需謹慎`;
      else if (lastClose < lastEnvL) envText = `跌破下軌（-5%），超跌，反彈候選`;
      else {
        const pct = ((lastClose - (_last(env)?.mid ?? lastClose)) / (_last(env)?.mid ?? 1) * 100).toFixed(1);
        envText = `現價乖離 ${pct}%，位於通道內，正常整理`;
      }
    }

    textEl.innerHTML = _textBlock([{ icon: '🌐', title: 'ENV乖離通道', text: envText }]);
  }

  // ── Card 3: GMMA 顧比均線 ──
  {
    const { card, canvas, textEl } = _makeCard('GMMA 顧比均線（短6 + 長6）', 110);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 110);

    if (n < 62) {
      ctx.fillStyle = C_MUTED;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('資料不足（需62根以上）', w / 2, h / 2);
      textEl.innerHTML = `<div class="ind-text-muted">資料不足，無法計算GMMA</div>`;
    } else {
      const allShort = gmma.short.map(_last).filter(Boolean);
      const allLong  = gmma.long.map(_last).filter(Boolean);

      // minMax 含所有 GMMA 線 + 收盤
      let mn = Infinity, mx = -Infinity;
      [...gmma.short, ...gmma.long].forEach(s => s.forEach(v => {
        if (v == null) return;
        mn = Math.min(mn, v); mx = Math.max(mx, v);
      }));
      closes.forEach(v => { mn = Math.min(mn, v); mx = Math.max(mx, v); });
      const pad = (mx - mn) * 0.06;
      mn -= pad; mx += pad;

      _drawGrid(ctx, w, h);
      _drawLine(ctx, closes, w, h, mn, mx, 'rgba(255,255,255,0.2)', 1);

      // 短期組：藍色系
      gmma.short.forEach(s => _drawLine(ctx, s, w, h, mn, mx, 'rgba(59,130,246,0.65)', 1));
      // 長期組：紅色系
      gmma.long.forEach(s  => _drawLine(ctx, s, w, h, mn, mx, 'rgba(239,83,80,0.65)',  1));

      // 文解
      const shortMin = Math.min(...allShort);
      const shortMax = Math.max(...allShort);
      const longMin  = Math.min(...allLong);
      const longMax  = Math.max(...allLong);

      let gmmaText = '';
      if (allShort.every(v => v > longMax))      gmmaText = '短期組全部高於長期組，多頭趨勢確立';
      else if (allShort.every(v => v < longMin)) gmmaText = '短期組全部低於長期組，空頭趨勢確立';
      else if (shortMin > longMin && shortMax < longMax) gmmaText = '短期組穿插在長期組中，趨勢轉換觀察期';
      else gmmaText = '短長期均線交纏，盤整格局';

      textEl.innerHTML = _textBlock([{ icon: '🔀', title: 'GMMA顧比均線', text: gmmaText }]);
    }
  }
}

// ============================================================================
// Tab 1 — 震盪組
// ============================================================================

function _drawOscillator(content) {
  const closes = _closes();
  const kd     = calcKD(_candles, 9);
  const rsi    = calcRSI(closes, 14);
  const macd   = calcMACD(closes, 12, 26, 9);

  // ── KD ──
  {
    const { card, canvas, textEl } = _makeCard('KD(9)  超買>80 / 超賣<20', 110);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 110);
    const [mn, mx] = [0, 100];

    _drawGrid(ctx, w, h);

    // 超買超賣帶
    const y80 = h - (80 / 100) * h;
    const y20 = h - (20 / 100) * h;
    ctx.fillStyle = 'rgba(239,83,80,0.07)';
    ctx.fillRect(0, 0, w, y80);
    ctx.fillStyle = 'rgba(38,166,154,0.07)';
    ctx.fillRect(0, y20, w, h - y20);
    _hline(ctx, y80, w, 'rgba(239,83,80,0.4)');
    _hline(ctx, y20, w, 'rgba(38,166,154,0.4)');

    // K/D 線
    _drawLine(ctx, kd.k, w, h, mn, mx, '#f59e0b', 1.5);
    _drawLine(ctx, kd.d, w, h, mn, mx, '#3b82f6', 1.5);

    const lastK = _last(kd.k), lastD = _last(kd.d);
    _label(ctx, `K:${lastK?.toFixed(1)} D:${lastD?.toFixed(1)}`, C_AMBER, w);

    // 文解
    let kdText = '';
    if (lastK != null && lastD != null) {
      const state = lastK > 80 ? '超買（K>80），小心拉回' :
                    lastK < 20 ? '超賣（K<20），反彈機率提升' :
                    lastK > lastD ? 'K線在D線上方' : 'K線在D線下方';
      // 偵測黃金/死亡交叉（最近5根）
      let cross = '';
      for (let i = kd.k.length - 1; i >= Math.max(0, kd.k.length - 5); i--) {
        if (i === 0) break;
        const prevDiff = kd.k[i - 1] - kd.d[i - 1];
        const currDiff = kd.k[i]     - kd.d[i];
        if (prevDiff < 0 && currDiff >= 0) { cross = '🔔 近期出現黃金交叉'; break; }
        if (prevDiff > 0 && currDiff <= 0) { cross = '🔕 近期出現死亡交叉'; break; }
      }
      kdText = [state, cross].filter(Boolean).join('；');
      if (lastK > 80 && Math.abs(lastK - lastD) < 3) kdText += '；高檔鈍化注意';
      if (lastK < 20 && Math.abs(lastK - lastD) < 3) kdText += '；低檔鈍化注意';
    }

    textEl.innerHTML = _textBlock([{ icon: '🌊', title: 'KD(9)', text: kdText }]);
  }

  // ── RSI ──
  {
    const { card, canvas, textEl } = _makeCard('RSI(14)  超買>70 / 超賣<30', 110);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 110);

    _drawGrid(ctx, w, h);
    const y70 = h - (70 / 100) * h;
    const y50 = h - (50 / 100) * h;
    const y30 = h - (30 / 100) * h;
    ctx.fillStyle = 'rgba(239,83,80,0.07)';
    ctx.fillRect(0, 0, w, y70);
    ctx.fillStyle = 'rgba(38,166,154,0.07)';
    ctx.fillRect(0, y30, w, h - y30);
    _hline(ctx, y70, w, 'rgba(239,83,80,0.4)');
    _hline(ctx, y50, w, 'rgba(255,255,255,0.15)');
    _hline(ctx, y30, w, 'rgba(38,166,154,0.4)');

    _drawLine(ctx, rsi, w, h, 0, 100, '#a78bfa', 1.8);

    const lastRSI = _last(rsi);
    _label(ctx, `RSI:${lastRSI?.toFixed(1)}`, '#a78bfa', w);

    let rsiText = '';
    if (lastRSI != null) {
      rsiText = lastRSI > 70 ? `RSI ${lastRSI.toFixed(1)}，強勢超買區，短線注意高點` :
                lastRSI < 30 ? `RSI ${lastRSI.toFixed(1)}，超賣區，反彈機率增加` :
                lastRSI > 50 ? `RSI ${lastRSI.toFixed(1)}，中性偏強（50以上）` :
                               `RSI ${lastRSI.toFixed(1)}，中性偏弱（50以下）`;
    }

    textEl.innerHTML = _textBlock([{ icon: '💪', title: 'RSI(14)', text: rsiText }]);
  }

  // ── MACD ──
  {
    const { card, canvas, textEl } = _makeCard('MACD (12,26,9) — 多紅柱空綠柱', 140);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 140);

    const n    = macd.hist.length;
    const difV = macd.dif.filter(Boolean);
    const [mn, mx] = _minMax([...macd.dif, ...macd.sigLine, ...macd.hist]);

    _drawGrid(ctx, w, h);

    // 零軸
    const y0 = h - ((0 - mn) / (mx - mn)) * h;
    _hline(ctx, y0, w, 'rgba(255,255,255,0.2)', []);

    // 柱狀（台股：正值紅色，負值綠色）
    const span = mx - mn || 1;
    const barW = Math.max(1, w / n - 1);
    macd.hist.forEach((v, i) => {
      if (v == null) return;
      const x  = (i / (n - 1)) * w;
      const y  = h - ((v - mn) / span) * h;
      ctx.fillStyle = v >= 0 ? `rgba(239,83,80,0.75)` : `rgba(38,166,154,0.75)`;
      if (v >= 0) ctx.fillRect(x - barW / 2, y, barW, y0 - y);
      else        ctx.fillRect(x - barW / 2, y0, barW, y - y0);
    });

    // DIF / Signal 線
    _drawLine(ctx, macd.dif,     w, h, mn, mx, '#f59e0b', 1.5);
    _drawLine(ctx, macd.sigLine, w, h, mn, mx, '#3b82f6', 1.5);

    const lastDif = _last(macd.dif);
    const lastSig = _last(macd.sigLine);
    const lastHist = _last(macd.hist);
    _label(ctx, `DIF:${lastDif?.toFixed(2)} SIG:${lastSig?.toFixed(2)}`, '#f59e0b', w);

    let macdText = '';
    if (lastDif != null && lastSig != null) {
      const aboveZero = lastDif > 0;
      const macdBull  = lastDif > lastSig;
      // 偵測交叉
      let cross = '';
      for (let i = macd.dif.length - 1; i >= Math.max(0, macd.dif.length - 5); i--) {
        if (i === 0) break;
        const pd = macd.dif[i-1] - macd.sigLine[i-1];
        const cd = macd.dif[i]   - macd.sigLine[i];
        if (pd < 0 && cd >= 0) { cross = '🔔 DIF剛上穿Signal線（黃金交叉）'; break; }
        if (pd > 0 && cd <= 0) { cross = '🔕 DIF剛下穿Signal線（死亡交叉）'; break; }
      }
      const zoneText = aboveZero ? '在零軸上方（多頭區）' : '在零軸下方（空頭區）';
      const crossDir = macdBull  ? 'DIF > Signal，偏多' : 'DIF < Signal，偏空';
      const histDir  = lastHist != null ?
        (lastHist > 0 ? '柱狀為正（紅），能量擴張' : '柱狀為負（綠），能量收縮') : '';
      macdText = [cross, zoneText, crossDir, histDir].filter(Boolean).join('；');
    }

    textEl.innerHTML = _textBlock([{ icon: '⚡', title: 'MACD(12,26,9)', text: macdText }]);
  }
}

// ============================================================================
// Tab 2 — 量化組
// ============================================================================

function _drawQuantGroup(content) {
  const closes = _closes();
  const n      = _candles.length;
  const r      = _r;

  // ── 支撐壓力價位圖 ──
  {
    const { card, canvas, textEl } = _makeCard('支撐 / 壓力 關卡圖', 130);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 130);

    _drawGrid(ctx, w, h);

    // 收盤折線
    const [mn, mx] = _minMax(closes);
    _drawLine(ctx, closes, w, h, mn, mx, 'rgba(255,255,255,0.35)', 1.2);

    // 取 r.support / r.resistance 的價位
    const supports   = (r?.support?.items || []).slice(0, 3);
    const resistances= (r?.resistance?.items || []).slice(0, 3);
    const span = mx - mn || 1;

    const _drawHLevel = (price, color, tag) => {
      if (price < mn || price > mx) return;
      const y = h - ((price - mn) / span) * h;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(`${tag} ${price}`, 4, y - 2);
    };

    supports.forEach((s, i)    => _drawHLevel(s.price, '#1e88e5', `S${i + 1}`));
    resistances.forEach((s, i) => _drawHLevel(s.price, '#e53935', `R${i + 1}`));

    // 現價線
    const lastClose = closes[n - 1];
    const yNow = h - ((lastClose - mn) / span) * h;
    ctx.strokeStyle = C_GOLD;
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, yNow); ctx.lineTo(w, yNow); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 10px sans-serif';
    ctx.fillStyle = C_GOLD;
    ctx.textAlign = 'right';
    ctx.fillText(`▶ ${lastClose}`, w - 2, yNow - 2);

    // 文解
    const s1 = supports[0];
    const r1 = resistances[0];
    const srLines = [];
    if (s1) srLines.push(`距最近支撐 $${s1.price}（-${s1.distance}%）`);
    if (r1) srLines.push(`距最近壓力 $${r1.price}（+${r1.distance}%）`);
    const srText = srLines.length ? srLines.join('；') : '無明顯支撐/壓力關卡';

    textEl.innerHTML = _textBlock([{ icon: '🎯', title: '支撐/壓力', text: srText }]);
  }

  // ── 分價量 ──
  {
    const BARS    = 60;  // 用最近60根 K 棒
    const BUCKETS = 20;

    const { card, canvas, textEl } = _makeCard('分價量（近60根）', 160);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 160);

    _drawGrid(ctx, w, h);

    const slice = _candles.slice(-BARS);
    if (slice.length < 10) {
      ctx.fillStyle = C_MUTED;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('資料不足', w / 2, h / 2);
      textEl.innerHTML = `<div class="ind-text-muted">資料不足</div>`;
    } else {
      const sliceCloses = slice.map(c => c.close ?? c.c ?? 0);
      const sliceVols   = slice.map(c => c.volume ?? c.v ?? 0);
      const priceMin    = Math.min(...sliceCloses);
      const priceMax    = Math.max(...sliceCloses);
      const step        = (priceMax - priceMin) / BUCKETS || 1;

      // 分桶
      const buckets     = new Array(BUCKETS).fill(0);
      slice.forEach((c, i) => {
        const p   = c.close ?? c.c ?? 0;
        const idx = Math.min(BUCKETS - 1, Math.floor((p - priceMin) / step));
        buckets[idx] += sliceVols[i];
      });

      const maxVol = Math.max(...buckets) || 1;

      // 右側 60% 寬度畫橫向 bar，左側 40% 預留收盤折線
      const chartW  = w * 0.55;  // 橫 bar 區
      const lineX0  = w * 0.58;  // 折線起點
      const lineW   = w - lineX0;

      // 橫向 bar（從左到右）
      buckets.forEach((vol, i) => {
        const ratio = vol / maxVol;
        const y1    = h - ((i + 1) / BUCKETS) * h;
        const bh    = h / BUCKETS - 1;
        // 最大量帶（籌碼密集區）橘色，其餘藍色
        ctx.fillStyle = ratio > 0.7 ? 'rgba(245,158,11,0.6)' : 'rgba(59,130,246,0.35)';
        ctx.fillRect(0, y1, chartW * ratio, bh);
      });

      // 右側收盤折線（最近60根）
      const sliceMn = priceMin - (priceMax - priceMin) * 0.06;
      const sliceMx = priceMax + (priceMax - priceMin) * 0.06;
      const sliceSpan = sliceMx - sliceMn || 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      sliceCloses.forEach((p, i) => {
        const x = lineX0 + (i / (sliceCloses.length - 1)) * lineW;
        const y = h - ((p - sliceMn) / sliceSpan) * h;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 現價水平線
      const lastClose = sliceCloses[sliceCloses.length - 1];
      const yNow = h - ((lastClose - sliceMn) / sliceSpan) * h;
      ctx.strokeStyle = C_GOLD;
      ctx.lineWidth   = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, yNow); ctx.lineTo(w, yNow); ctx.stroke();
      ctx.setLineDash([]);

      // 文解：找最大量 bucket
      const maxIdx    = buckets.indexOf(Math.max(...buckets));
      const denseLo   = +(priceMin + maxIdx * step).toFixed(2);
      const denseHi   = +(denseLo + step).toFixed(2);
      const denseText = `籌碼最密集區 $${denseLo}~$${denseHi}`;
      const posText   = lastClose > denseHi  ? '現價在密集區上方（籌碼無壓力）' :
                        lastClose < denseLo  ? '現價在密集區下方（有解套賣壓）' :
                                               '現價在密集區內（強支撐但有套牢壓）';

      textEl.innerHTML = _textBlock([{ icon: '📊', title: '分價量分析', text: `${denseText}；${posText}` }]);
    }
  }
}

// ============================================================================
// Tab 3 — 動能組
// ============================================================================

function _drawMomentum(content) {
  const closes = _closes();
  const dmi    = calcDMI(_candles, 14);
  const psy    = calcPSY(closes, 12);
  const rci    = calcRCI(closes, 9);
  const hv     = calcHV(closes, 20);

  // ── DMI / ADX ──
  {
    const { card, canvas, textEl } = _makeCard('DMI / ADX — 趨勢強度與方向', 120);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 120);

    const [mn, mx] = _minMaxMulti(dmi.plusDI, dmi.minusDI, dmi.adx);
    _drawGrid(ctx, w, h);

    // 25 / 20 基準線
    const y25 = h - ((25 - mn) / (mx - mn)) * h;
    const y20 = h - ((20 - mn) / (mx - mn)) * h;
    _hline(ctx, y25, w, 'rgba(255,255,255,0.2)');
    _hline(ctx, y20, w, 'rgba(255,255,255,0.12)');

    // DI+（紅）, DI-（綠）, ADX（白）
    _drawLine(ctx, dmi.plusDI,  w, h, mn, mx, C_UP,   1.5);
    _drawLine(ctx, dmi.minusDI, w, h, mn, mx, C_DOWN, 1.5);
    _drawLine(ctx, dmi.adx,     w, h, mn, mx, 'rgba(255,255,255,0.7)', 1.8);

    const lastADX = _last(dmi.adx);
    const lastDIP = _last(dmi.plusDI);
    const lastDIM = _last(dmi.minusDI);

    _label(ctx, `ADX:${lastADX?.toFixed(1)}`, 'rgba(255,255,255,0.7)', w);

    let dmiText = '';
    if (lastADX != null && lastDIP != null && lastDIM != null) {
      const strength = lastADX > 30 ? '強趨勢（ADX>30）' :
                       lastADX > 25 ? '趨勢成形（ADX>25）' :
                       lastADX > 20 ? '弱趨勢（ADX>20）' : '盤整（ADX<20），趨勢不明';
      const dir = lastDIP > lastDIM ? `DI+>DI-，多頭方向` : `DI->DI+，空頭方向`;
      dmiText = `${strength}；${dir}`;
    }

    textEl.innerHTML = _textBlock([{ icon: '🧭', title: 'DMI/ADX', text: dmiText }]);
  }

  // ── PSY ──
  {
    const { card, canvas, textEl } = _makeCard('PSY 心理線(12) — 過熱>75 / 悲觀<25', 100);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 100);

    _drawGrid(ctx, w, h);
    _hline(ctx, h - (75 / 100) * h, w, 'rgba(239,83,80,0.4)');
    _hline(ctx, h - (50 / 100) * h, w, 'rgba(255,255,255,0.15)');
    _hline(ctx, h - (25 / 100) * h, w, 'rgba(38,166,154,0.4)');

    _drawLine(ctx, psy, w, h, 0, 100, '#a78bfa', 1.8);

    const lastPSY = _last(psy);
    _label(ctx, `PSY:${lastPSY?.toFixed(1)}%`, '#a78bfa', w);

    let psyText = '';
    if (lastPSY != null) {
      psyText = lastPSY > 75 ? `PSY ${lastPSY.toFixed(0)}%，市場過熱，注意短線拉回風險` :
                lastPSY < 25 ? `PSY ${lastPSY.toFixed(0)}%，市場悲觀，反彈機率偏高` :
                lastPSY > 50 ? `PSY ${lastPSY.toFixed(0)}%，偏多氣氛` :
                               `PSY ${lastPSY.toFixed(0)}%，偏空氣氛`;
    }

    textEl.innerHTML = _textBlock([{ icon: '🧠', title: 'PSY心理線', text: psyText }]);
  }

  // ── RCI ──
  {
    const { card, canvas, textEl } = _makeCard('RCI(9) 順位相關 — 極強>+80 / 極弱<-80', 100);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 100);

    _drawGrid(ctx, w, h);
    _hline(ctx, h - ((80 - (-100)) / 200) * h,  w, 'rgba(239,83,80,0.4)');
    _hline(ctx, h - ((0  - (-100)) / 200) * h,  w, 'rgba(255,255,255,0.2)');
    _hline(ctx, h - ((-80 - (-100)) / 200) * h, w, 'rgba(38,166,154,0.4)');

    _drawLine(ctx, rci, w, h, -100, 100, '#f59e0b', 1.8);

    const lastRCI = _last(rci);
    _label(ctx, `RCI:${lastRCI?.toFixed(1)}`, '#f59e0b', w);

    let rciText = '';
    if (lastRCI != null) {
      rciText = lastRCI > 80  ? `RCI ${lastRCI.toFixed(0)}，極強多頭，接近頂部須注意反轉` :
                lastRCI < -80 ? `RCI ${lastRCI.toFixed(0)}，極強空頭，接近底部可觀察翻多` :
                lastRCI > 0   ? `RCI ${lastRCI.toFixed(0)}，多頭方向，趨勢仍在` :
                                `RCI ${lastRCI.toFixed(0)}，空頭方向，趨勢仍弱`;
    }

    textEl.innerHTML = _textBlock([{ icon: '📐', title: 'RCI順位相關', text: rciText }]);
  }

  // ── HV 歷史波動率 ──
  {
    const { card, canvas, textEl } = _makeCard('HV 歷史波動率(20) — 年化%', 100);
    content.appendChild(card);
    const { ctx, w, h } = _sizeCanvas(canvas, 100);

    const validHV = hv.filter(Boolean);
    const hvAvg   = validHV.length ? validHV.reduce((a, b) => a + b, 0) / validHV.length : 30;
    const [mn, mx] = _minMax(hv, 0.1);

    _drawGrid(ctx, w, h);

    // 平均線
    const yAvg = h - ((hvAvg - mn) / (mx - mn || 1)) * h;
    _hline(ctx, yAvg, w, 'rgba(255,255,255,0.25)');

    _drawLine(ctx, hv, w, h, mn, mx, '#22d3ee', 1.8);

    const lastHV = _last(hv);
    _label(ctx, `HV:${lastHV?.toFixed(1)}%`, '#22d3ee', w);

    let hvText = '';
    if (lastHV != null) {
      const vsAvg = lastHV > hvAvg * 1.3 ? '高於歷史均值（行情活躍，風險偏大）' :
                    lastHV < hvAvg * 0.7  ? '低於歷史均值（波動收縮，伺機方向）' : '接近歷史均值（正常波動）';
      const level = lastHV > 50 ? '高波動（>50%），適合短線操作' :
                    lastHV < 20 ? '低波動（<20%），趨勢整理中' : `年化波動 ${lastHV.toFixed(1)}%`;
      hvText = `${level}；${vsAvg}`;
    }

    textEl.innerHTML = _textBlock([{ icon: '📉', title: 'HV歷史波動率', text: hvText }]);
  }
}

// ============================================================================
// 文解 HTML 產生
// ============================================================================

function _textBlock(items) {
  return items.map(item => `
    <div class="ind-text-row">
      <span class="ind-text-icon">${item.icon}</span>
      <div class="ind-text-body">
        <span class="ind-text-title">${item.title}</span>
        <span class="ind-text-desc">${item.text || '—'}</span>
      </div>
    </div>
  `).join('');
}

// ── 數字格式化（千分位） ──
function _fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e8)  return (n / 1e8).toFixed(1) + '億';
  if (n >= 1e4)  return (n / 1e4).toFixed(1) + '萬';
  return String(n);
}
