// js/chart-analysis-card.js
// ============================================================================
// 智能分析面板 — 5 Tab 架構（全新重設計）
// Tab 0: 總覽（評分環 + 健康度 + 趨勢結構）
// Tab 1: EMA + BB + ENV + SAR + GMMA
// Tab 2: 支撐壓力關卡 + 分價量
// Tab 3: DMI + PSY + RCI + HV
// Tab 4: KD + RSI + MACD
// ============================================================================

import { analyze, analyzeEntryPlan } from './chart-analysis.js';
import { calcHealthWithSignals } from './stock-tabs.js';
import { calcHealthLong } from './health.js';
import { fetchHistory, fetchFundamentalsFromFirestore, toYahooSymbol } from './api.js';

import {
  calcEMA, calcGMMA, calcBollinger, calcEnvelope, calcSAR,
  calcKD, calcRSI, calcMACD,
  calcDMI, calcPSY, calcRCI, calcHV,
} from './indicators.js';

// ── 台股多紅空綠 ──
const C_UP   = '#ef5350';
const C_DOWN = '#26a69a';
const C_GOLD = '#FFD600';
const C_GRID = 'rgba(255,255,255,0.04)';
const C_BG   = '#0d1117';
const C_MUTED= '#8a8f99';
const C_BLUE = '#3b82f6';
const C_AMBER= '#f59e0b';
const C_PURP = '#a78bfa';
const C_CYAN = '#22d3ee';

let _containerEl     = null;
let _ctxRefs         = null;
let _lastResult      = null;
let _lastCode        = null;
let _activeTab       = 0;
let _longHealthCache = null;
let _io              = null;
let _pendingCode     = null;

// ── 5 個 Tab 定義 ──
const TABS = [
  { icon: '📊', label: '總覽'  },
  { icon: '📈', label: '均線'  },
  { icon: '🎯', label: '籌碼'  },
  { icon: '⚡', label: '動能'  },
  { icon: '🌊', label: '震盪'  },
];

// ============================================================================
// 公開 API
// ============================================================================

export function initAnalysisCard({ containerSelector, getCandles, getCode }) {
  _ctxRefs     = { getCandles, getCode };
  _containerEl = typeof containerSelector === 'string'
    ? document.querySelector(containerSelector) : containerSelector;
  if (!_containerEl) return;
  _containerEl.classList.add('ca-panel');
  _containerEl.innerHTML = `<div class="ca-empty">選擇個股後將自動產生智能分析</div>`;

  _io = new IntersectionObserver(entries => {
    for (const e of entries) { if (e.isIntersecting && _pendingCode) _doCompute(); }
  }, { threshold: 0.05 });
  _io.observe(_containerEl);
}

export function renderAnalysisPanel(code) {
  if (!_containerEl) return;
  _pendingCode     = code;
  _lastCode        = code;
  _activeTab       = 0;
  _longHealthCache = null;
  _prefetchLongHealth(code);

  const rect   = _containerEl.getBoundingClientRect();
  const inView = rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0;
  if (inView) _doCompute();
  else _containerEl.innerHTML = `<div class="ca-empty">切換到「智能分析」分頁可看 ${code} 的分析</div>`;
}

export function refreshAnalysis() { if (_lastCode) _doCompute(); }
export function getLastAnalysisResult() { return _lastResult; }

// ============================================================================
// 背景預拉長線健康度
// ============================================================================

async function _prefetchLongHealth(code) {
  try {
    const symbol = toYahooSymbol(code);
    const [rawC, fund] = await Promise.allSettled([
      fetchHistory(symbol, '1y'),
      fetchFundamentalsFromFirestore(code),
    ]);
    const c1y = rawC.status === 'fulfilled' && rawC.value?.length >= 120
      ? rawC.value.map(c => ({
          open: c.open??c.o, high: c.high??c.h,
          low:  c.low ??c.l, close: c.close??c.c, volume: c.volume??c.v??0 }))
      : null;
    if (!c1y) return;
    _longHealthCache = { long: calcHealthLong(c1y, fund.status==='fulfilled' ? fund.value : null) };
    if (_activeTab === 0 && _containerEl) {
      const el = _containerEl.querySelector('.cao-long-hbar');
      if (el && _longHealthCache.long != null)
        el.innerHTML = _hbar(_longHealthCache.long, '#0f6e56');
    }
  } catch(e) { console.warn('[analysis-card] prefetchLongHealth', e); }
}

// ============================================================================
// 主計算
// ============================================================================

function _doCompute() {
  if (!_ctxRefs) return;
  const candles = _ctxRefs.getCandles?.() || [];
  if (!candles.length) { _containerEl.innerHTML = `<div class="ca-empty">尚無 K 線資料</div>`; return; }
  try {
    _lastResult = analyze(candles);
    _renderShell(_lastResult, candles);
    _pendingCode = null;
  } catch(e) {
    console.error('[analysis-card] analyze failed', e);
    _containerEl.innerHTML = `<div class="ca-empty">分析失敗：${e.message}</div>`;
  }
}

// ============================================================================
// 外殼 — 5 Tab
// ============================================================================

function _renderShell(r, candles) {
  if (!r || r.empty) {
    _containerEl.innerHTML = `<div class="ca-empty">${r?.reason || '無分析結果'}</div>`;
    return;
  }
  _containerEl.innerHTML = `
    <div class="ca-wrap">
      <div class="ca-tabbar" id="caTabBar">
        ${TABS.map((t, i) => `
          <button class="ca-tab ${i===0?'active':''}" data-tab="${i}">
            <span class="ca-tab-icon">${t.icon}</span>
            <span class="ca-tab-label">${t.label}</span>
          </button>`).join('')}
      </div>
      <div class="ca-body" id="caBody"></div>
    </div>`;

  _containerEl.querySelectorAll('.ca-tab').forEach(btn =>
    btn.addEventListener('click', () => {
      _containerEl.querySelectorAll('.ca-tab').forEach(b => b.classList.toggle('active', b===btn));
      _activeTab = +btn.dataset.tab;
      _renderTab(_activeTab, r, candles);
    })
  );
  _renderTab(0, r, candles);
}

function _renderTab(tab, r, candles) {
  const body = _containerEl.querySelector('#caBody');
  if (!body) return;
  body.innerHTML = '';
  requestAnimationFrame(() => {
    if (tab === 0) _tabOverview(body, r, candles);
    if (tab === 1) _tabEMA(body, candles);
    if (tab === 2) _tabQuant(body, candles, r);
    if (tab === 3) _tabMomentum(body, candles);
    if (tab === 4) _tabOscillator(body, candles);
  });
}

// ============================================================================
// Tab 0 — 總覽
// ============================================================================

function _tabOverview(body, r, candles) {
  const code  = _ctxRefs.getCode?.() ?? '';
  const short = calcHealthWithSignals(candles, code);
  const long  = _longHealthCache?.long ?? calcHealthLong(candles);

  // ── 評分計算 ──
  const inds    = r.trend?.indicators ?? {};
  const indList = Object.values(inds).filter(Boolean);
  const trendNorm = r.trend?.maxScore > 0 ? (r.trend.score / r.trend.maxScore) : 0;
  const trendHealth = Math.round((trendNorm + 1) / 2 * 100);
  const score = short != null ? Math.round(short * 0.55 + trendHealth * 0.45) : trendHealth;

  const signal    = score>=78?'強多格局':score>=62?'偏多格局':score>=48?'中性觀望':score>=35?'偏弱格局':'空頭格局';
  const signalCol = score>=78?C_UP:score>=62?'#66bb6a':score>=48?'#aaa':score>=35?C_AMBER:C_DOWN;

  // ── 指標統計 ──
  const bullInds = indList.filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  const bearInds = indList.filter(x=>x.score<0).sort((a,b)=>a.score-b.score);
  const neuInds  = indList.filter(x=>x.score===0);
  const total    = indList.length||1;
  const bP = Math.round(bullInds.length/total*100);
  const beP= Math.round(bearInds.length/total*100);
  const nP = 100-bP-beP;

  const _rows = (arr, col) => arr.map(x=>`
    <div class="cao-ind-row">
      <span class="cao-ind-dot" style="background:${col}"></span>
      <span class="cao-ind-name">${x.label??'—'}</span>
      <span class="cao-ind-val">${x.value!=null?String(x.value).split('\n')[0]:'—'}</span>
    </div>`).join('');

  // ── 複合訊號 ──
  const compSignals = _buildCompoundSignals(r, candles, short, trendHealth);
  const ep = analyzeEntryPlan(r);
  const vp = r.volumePrice;

  // ── 乖離率：-30~+30 → 0~100（50=中性）──
  const biasRaw = inds.bias?.value ? parseFloat(inds.bias.value) : null;
  const biasScore = biasRaw != null ? Math.max(0, Math.min(100, 50 + biasRaw * (50/30))) : null;
  const biasLabel = biasRaw == null ? '—'
    : biasRaw > 15 ? '嚴重超漲'
    : biasRaw > 8  ? '偏高'
    : biasRaw < -15? '嚴重超跌'
    : biasRaw < -8 ? '偏低' : '正常';
  const biasDisp = biasRaw != null ? `${biasRaw>=0?'+':''}${biasRaw.toFixed(1)}%` : '—';

  // ── 唯一 ID（每次 render 不同，避免 canvas 衝突）──
  const ts = Date.now();
  const uid1='g1_'+ts, uid2='g2_'+ts, uid3='g3_'+ts, uid4='g4_'+ts, uid5='g5_'+ts, uid_sr='sr_'+ts;

  // ── 支撐壓力儀表盤資料 ──
  const allPrices = [
    ...(r.support?.items??[]).map(s=>s.price),
    ...(r.resistance?.items??[]).map(s=>s.price),
    r.lastClose,
  ].filter(Boolean);
  const srMin = allPrices.length ? Math.min(...allPrices)*0.985 : 0;
  const srMax = allPrices.length ? Math.max(...allPrices)*1.015 : 100;

  // ── 趨勢指標明細：分類別型 vs 數值型 ──
  const CATEGORY_KEYS = new Set(['maAlignment','hhhl','recentBars','breakout','historicalRank']);
  const NUM_CONFIGS = {
    rci:        { min:-100, max:100,  marks:[{v:-80,l:'-80'},{v:0,l:'0'},{v:80,l:'+80'}] },
    psy:        { min:0,   max:100,  marks:[{v:25,l:'25'},{v:50,l:'50'},{v:75,l:'75'}] },
    bias:       { min:-30, max:30,   marks:[{v:-15,l:'-15'},{v:0,l:'0'},{v:15,l:'+15'}], center:true },
    hv:         { min:0,   max:80,   marks:[{v:20,l:'20'},{v:50,l:'50'}] },
    adx:        { min:0,   max:60,   marks:[{v:20,l:'20'},{v:25,l:'25'},{v:40,l:'40'}] },
    longTermPos:{ min:-20, max:20,   marks:[{v:0,l:'0'}], center:true },
    maSlope:    { min:-3,  max:3,    marks:[{v:0,l:'0'}], center:true },
  };

  const _wrapInd = (rowInner, ind) => {
    const why = ind.reason ? `<div class="cao-ind-why">${String(ind.reason).split('\n')[0]}</div>` : '';
    return `<div class="cao-ind-item">${rowInner}${why}</div>`;
  };

  const _indRows = (arr, col) => arr.map(ind => {
    const key = Object.keys(inds).find(k => inds[k]===ind) ?? '';
    const isCat = CATEGORY_KEYS.has(key) || !NUM_CONFIGS[key];
    const dotCol = ind.score > 0 ? C_UP : ind.score < 0 ? C_DOWN : '#888';

    if (isCat) {
      // badge 模式
      const vals = String(ind.value??'—').split('/').map(v=>v.trim());
      const badges = vals.map(v => {
        const isUp = /多頭|HH\+HL|突破|紅/.test(v);
        const isDn = /空頭|LH\+LL|黑/.test(v);
        const bc   = isUp?'rgba(239,83,80,0.13)':isDn?'rgba(38,166,154,0.13)':'rgba(136,135,128,0.13)';
        const tc   = isUp?'#ef9a9a':isDn?'#80cbc4':'#aaa';
        return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;background:${bc};color:${tc};margin-right:4px">${v}</span>`;
      }).join('');
      return _wrapInd(`<div class="cao-ind-row">
        <span class="cao-ind-dot" style="background:${dotCol}"></span>
        <span class="cao-ind-name">${ind.label??'—'}</span>
        <div style="flex:1">${badges}</div>
      </div>`, ind);
    } else {
      // gauge bar 模式
      const cfg = NUM_CONFIGS[key];
      const raw = parseFloat(String(ind.value??'0'));
      const pct = cfg.center
        ? Math.max(0,Math.min(100, 50 + (raw/(cfg.max))*50))
        : Math.max(0,Math.min(100, (raw-cfg.min)/(cfg.max-cfg.min)*100));
      const barCol = ind.score>0?C_UP:ind.score<0?C_DOWN:'#888780';
      const markerHtml = cfg.marks.map(m=>{
        const mp = cfg.center
          ? 50 + (m.v/cfg.max)*50
          : (m.v-cfg.min)/(cfg.max-cfg.min)*100;
        return `<div style="position:absolute;top:-2px;left:${mp}%;width:1.5px;height:12px;background:rgba(255,255,255,0.2);transform:translateX(-50%)"></div>`;
      }).join('');
      const dispVal = String(ind.value??'—').split(' ').slice(0,2).join(' ');
      return _wrapInd(`<div class="cao-ind-row">
        <span class="cao-ind-dot" style="background:${dotCol}"></span>
        <span class="cao-ind-name">${ind.label??'—'}</span>
        <div style="flex:1;display:flex;align-items:center;gap:8px">
          <div style="flex:1;position:relative;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:visible">
            ${markerHtml}
            <div style="height:100%;border-radius:4px;background:${barCol};width:${pct.toFixed(1)}%"></div>
          </div>
          <span style="font-size:13px;font-weight:500;color:${barCol};min-width:90px;text-align:right;white-space:nowrap">${dispVal}</span>
        </div>
      </div>`, ind);
    }
  }).join('');

  body.innerHTML = `<div class="cao-wrap">

  <!-- ── 5 個轉速表左右並排 ── -->
  <div class="cao-card cao-dash-card">
    <div class="cao-gauge-row5">

      <div class="cao-gauge-unit">
        <canvas id="${uid1}" class="cao-gauge-canvas"></canvas>
        <div class="cao-gauge-num" style="color:${signalCol}">${score}</div>
        <div class="cao-gauge-lbl-row"><span style="color:${C_DOWN}">空</span><span style="color:#555">中</span><span style="color:${C_UP}">多</span></div>
        <div class="cao-gauge-title" style="color:${signalCol}">${signal}</div>
        <div class="cao-gauge-sub">${r.trend?.direction==='up'?'▲ 多頭':r.trend?.direction==='down'?'▼ 空頭':'— 盤整'}</div>
      </div>

      <div class="cao-gauge-unit">
        <canvas id="${uid2}" class="cao-gauge-canvas"></canvas>
        <div class="cao-gauge-num">${short??'—'}</div>
        <div class="cao-gauge-lbl-row"><span style="color:${C_DOWN}">弱</span><span style="color:#555">中</span><span style="color:${C_UP}">強</span></div>
        <div class="cao-gauge-title">短線健康</div>
        <div class="cao-gauge-sub">技術面</div>
      </div>

      <div class="cao-gauge-unit">
        <canvas id="${uid3}" class="cao-gauge-canvas"></canvas>
        <div class="cao-gauge-num">${long!=null?long:'...'}</div>
        <div class="cao-gauge-lbl-row"><span style="color:${C_DOWN}">弱</span><span style="color:#555">中</span><span style="color:${C_UP}">強</span></div>
        <div class="cao-gauge-title">長線健康</div>
        <div class="cao-gauge-sub">基本面</div>
      </div>

      <div class="cao-gauge-unit">
        <canvas id="${uid4}" class="cao-gauge-canvas"></canvas>
        <div class="cao-gauge-num" style="font-size:14px">${biasDisp}</div>
        <div class="cao-gauge-lbl-row"><span style="color:${C_DOWN}">超跌</span><span style="color:#555">中</span><span style="color:${C_UP}">超漲</span></div>
        <div class="cao-gauge-title">乖離 MA20</div>
        <div class="cao-gauge-sub">${biasLabel}</div>
      </div>

      <div class="cao-gauge-unit">
        <canvas id="${uid5}" class="cao-gauge-canvas"></canvas>
        <div class="cao-gauge-num" style="font-size:14px">${bullInds.length}多/${bearInds.length}空</div>
        <div class="cao-gauge-lbl-row"><span style="color:${C_DOWN}">純空</span><span style="color:#555">均</span><span style="color:${C_UP}">純多</span></div>
        <div class="cao-gauge-title">多空比例</div>
        <div class="cao-gauge-sub">${neuInds.length} 中性</div>
      </div>

    </div>
  </div>

  <!-- ── 關鍵訊號 ── -->
  ${compSignals.length ? `
  <div class="cao-card">
    <div class="cao-card-title">🔔 關鍵訊號</div>
    ${compSignals.map(s=>`<div class="cao-sig-item cao-sig-${s.type}">${s.icon} ${s.text}</div>`).join('')}
  </div>` : ''}

  <!-- ── 進場計畫 ── -->
  ${ep ? `
  <div class="cao-card">
    <div class="cao-card-title">🎯 分批進場計畫</div>
    <div class="cao-entry-grid">
      <div class="cao-entry-item">
        <div class="cao-entry-label">第一批 <span class="cao-entry-pct">30%</span></div>
        <div class="cao-entry-price" style="color:${C_UP}">${ep.entry1}</div>
        <div class="cao-entry-hint">現價附近</div>
      </div>
      <div class="cao-entry-item">
        <div class="cao-entry-label">第二批 <span class="cao-entry-pct">40%</span></div>
        <div class="cao-entry-price" style="color:${C_UP}">${ep.entry2}</div>
        <div class="cao-entry-hint">S1 ${ep.s1Price}</div>
      </div>
      <div class="cao-entry-item">
        <div class="cao-entry-label">第三批 <span class="cao-entry-pct">30%</span></div>
        <div class="cao-entry-price" style="color:${C_UP}">${ep.entry3}</div>
        <div class="cao-entry-hint">${ep.s2Price?'S2 '+ep.s2Price:'S1-3%'}</div>
      </div>
    </div>
    <div class="cao-entry-summary">
      <span>均成本 <b>${ep.avgCost}</b></span>
      <span style="color:${C_DOWN}">停損 <b>${ep.stop}</b></span>
      <span style="color:${C_UP}">停利 <b>${ep.target}</b></span>
      <span style="color:${ep.rr>=2.5?C_UP:ep.rr>=1.5?C_AMBER:C_MUTED}">風報比 <b>${ep.rr}x</b></span>
    </div>
  </div>` : ''}

  <!-- ── 支撐壓力轉速表 ── -->
  ${_buildSRCard(r, uid_sr)}

  <!-- ── 趨勢指標明細 ── -->
  <div class="cao-card">
    <div class="cao-card-title">📊 趨勢指標明細
      <span class="cao-card-badge" style="color:${r.trend?.direction==='up'?C_UP:r.trend?.direction==='down'?C_DOWN:'#888'}">
        ${r.trend?.direction==='up'?'▲ 多頭':r.trend?.direction==='down'?'▼ 空頭':'— 盤整'}
      </span>
    </div>
    ${_indRows([...bullInds,...neuInds,...bearInds],'')}
  </div>

  </div>`;

  // ── 每次 render 都重跑動畫 ──
  requestAnimationFrame(() => {
    _drawGauge(uid1, score, false);
    _drawGauge(uid2, short??0, false);
    _drawGauge(uid3, long??0, false);
    _drawGauge(uid4, biasScore??50, true);
    // 多空比例儀表：淨值 (bull-bear)/total → 0~1，50=均衡
    const netScore = 50 + (bullInds.length - bearInds.length) / (total||1) * 50;
    _drawGauge(uid5, Math.max(0,Math.min(100,netScore)), false);
    // 支撐壓力轉速表
    if (allPrices.length > 1) _drawSRGauge(uid_sr, r, srMin, srMax, undefined);
  });
}

// ── 轉速表 canvas 繪製（指針動畫）──
// isBias=true → 乖離率模式：中間=中性，右=超漲，左=超跌
function _drawGauge(uid, targetScore, isBias) {
  const canvas = document.getElementById(uid);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 150, H = 95, cx = 75, cy = 86, R = 66, rIn = 48;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const zones = isBias ? [
    {from:0,   to:0.2, color:'#26a69a'},   // 超跌
    {from:0.2, to:0.4, color:'#5DCAA5'},
    {from:0.4, to:0.6, color:'#888780'},   // 中性
    {from:0.6, to:0.8, color:'#f59e0b'},
    {from:0.8, to:1.0, color:'#ef5350'},   // 超漲
  ] : [
    {from:0,   to:0.2, color:'#26a69a'},
    {from:0.2, to:0.4, color:'#5DCAA5'},
    {from:0.4, to:0.6, color:'#888780'},
    {from:0.6, to:0.8, color:'#f59e0b'},
    {from:0.8, to:1.0, color:'#ef5350'},
  ];

  function draw(cur) {
    ctx.clearRect(0, 0, W, H);
    zones.forEach(z => {
      const a1 = Math.PI + z.from * Math.PI;
      const a2 = Math.PI + z.to   * Math.PI;
      ctx.beginPath();
      ctx.arc(cx,cy,R,a1,a2);
      ctx.arc(cx,cy,rIn,a2,a1,true);
      ctx.closePath();
      ctx.fillStyle = z.color;
      ctx.fill();
    });
    // 刻度
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.8;
    for (let i=0; i<=10; i++) {
      const a = Math.PI + (i/10)*Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx+Math.cos(a)*(rIn+1), cy+Math.sin(a)*(rIn+1));
      ctx.lineTo(cx+Math.cos(a)*(R-1),   cy+Math.sin(a)*(R-1));
      ctx.stroke();
    }
    // 指針
    const pA = Math.PI + (cur/100)*Math.PI;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(pA)*14, cy+Math.sin(pA)*14);
    ctx.lineTo(cx+Math.cos(pA)*(R-7), cy+Math.sin(pA)*(R-7));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx,cy,6,0,Math.PI*2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  // easing 動畫
  let cur = 0;
  const target = Math.max(0, Math.min(100, targetScore));
  function animate() {
    const diff = target - cur;
    if (Math.abs(diff) < 0.5) { draw(target); return; }
    cur += diff * 0.1;
    draw(cur);
    requestAnimationFrame(animate);
  }
  animate();
}



// ── 支撐壓力 card HTML 生成器 ──
function _buildSRCard(r, uid_sr) {
  const sItems = (r.support?.items??[]).slice(0,3).map((x,i)=>({...x,isRes:false,label:'S'+(i+1)}));
  const rItems = (r.resistance?.items??[]).slice(0,3).map((x,i)=>({...x,isRes:true,label:'R'+(i+1)}));
  const allItems = [...rItems.slice().reverse(),...sItems].sort((a,b)=>b.price-a.price);
  if(!allItems.length) return '';

  // 價格範圍（滑桿用）
  const prices = allItems.map(x=>x.price);
  const pMin = +(Math.min(...prices)*0.97).toFixed(1);
  const pMax = +(Math.max(...prices)*1.03).toFixed(1);
  const lc = r.lastClose;
  const slid_id = uid_sr+'_slider';
  const info_id = uid_sr+'_info';

  const maxDist = Math.max(...allItems.map(x=>parseFloat(x.distance)||0),1);

  const rows_id = uid_sr+'_rows';

  function buildRows(p) {
    const maxD = Math.max(...allItems.map(x=>Math.abs(x.price-p)/p*100), 1);
    return allItems.map(item=>{
      const col = item.isRes?'#26a69a':'#ef5350';
      const dist = Math.abs(item.price - p) / p * 100;
      const distStr = (item.isRes ? '+' : '-') + dist.toFixed(2) + '%';
      const barPct = Math.min(100, dist/maxD*100).toFixed(0);
      const st = Math.max(0,Math.min(3,item.strength??0));
      const stars = '★'.repeat(st)+'☆'.repeat(3-st);
      const hist = item.history?.tests>0?'測試'+item.history.tests+'次守'+item.history.held+'次':'';
      return '<div style="padding:5px 0;border-bottom:0.5px solid rgba(255,255,255,0.05)">'
        +'<div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">'
        +'<span style="font-size:12px;font-weight:700;min-width:26px;color:'+col+'">'+item.label+'</span>'
        +'<span style="font-size:15px;font-weight:700;color:'+col+';min-width:70px">$'+item.price+'</span>'
        +'<span style="font-size:12px;color:#888;min-width:46px">'+distStr+'</span>'
        +'<span style="font-size:12px;color:'+col+'">'+stars+'</span>'
        +'<span style="font-size:10px;color:#555;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+hist+'</span>'
        +'</div>'
        +'<div style="height:6px;background:rgba(255,255,255,0.07);border-radius:3px;overflow:hidden">'
        +'<div style="height:100%;border-radius:3px;background:'+col+';width:'+barPct+'%"></div>'
        +'</div></div>';
    }).join('');
  }
  const rowsHtml = '<div id="'+rows_id+'">'+buildRows(lc)+'</div>';

  // info 區（滑桿拖動時更新）
  function buildInfo(p) {
    const r1=rItems[0], s1=sItems[0];
    const distRv = r1?'+'+(((r1.price-p)/p)*100).toFixed(1)+'%':'—';
    const distSv = s1?'-'+(((p-s1.price)/p)*100).toFixed(1)+'%':'—';
    let desc='';
    if(r1&&s1){
      if(p>s1.price&&p<r1.price) desc='現價位於 S1 與 R1 之間，中段整理';
      else if(p>=r1.price) desc='突破 R1 '+r1.price+'，下一壓力 R2 '+(rItems[1]?.price??'—');
      else desc='跌破 S1 '+s1.price+'，下一支撐 S2 '+(sItems[1]?.price??'—');
    } else if(r1){ desc='現價低於壓力 '+distRv; }
    else if(s1){ desc='現價高於支撐 '+distSv; }
    return '<div style="font-size:20px;font-weight:700;color:#FFD600;margin-top:4px">'+p.toFixed(1)+'</div>'
      +'<div style="font-size:11px;color:#888;margin-top:3px;text-align:center">'
      +'距壓力 <span style="color:#26a69a">'+distRv+'</span>　距支撐 <span style="color:#ef5350">'+distSv+'</span>'
      +'</div>'
      +'<div style="font-size:11px;color:#aaa;margin-top:5px;text-align:center;line-height:1.5">'+desc+'</div>';
  }

  const html = '<div class="cao-card">'
    +'<div class="cao-card-title">🧱 支撐 / 壓力 關卡</div>'
    +'<div style="display:flex;align-items:flex-start;gap:16px">'
    // 左：儀表盤 + 資訊 + 滑桿
    +'<div style="flex-shrink:0;width:190px;display:flex;flex-direction:column;align-items:center">'
    +'<canvas id="'+uid_sr+'" width="190" height="120" style="width:190px;height:120px"></canvas>'
    +'<div id="'+info_id+'">'+buildInfo(lc)+'</div>'
    +'<div style="font-size:10px;color:#555;margin-top:8px">'
    +'<span style="color:#ef5350">● 支撐</span>　<span style="color:#26a69a">● 壓力</span>　<span style="color:#FFD600">● 現價</span>'
    +'</div>'
    +'<div style="width:100%;margin-top:10px;padding:0 4px">'
    +'<div style="font-size:10px;color:#555;margin-bottom:4px;text-align:center">模擬現價</div>'
    +'<div style="display:flex;align-items:center;gap:6px">'
    +'<span style="font-size:10px;color:#555">'+pMin+'</span>'
    +'<input type="range" id="'+slid_id+'" min="'+pMin+'" max="'+pMax+'" step="0.1" value="'+lc+'" style="flex:1">'
    +'<span style="font-size:10px;color:#555">'+pMax+'</span>'
    +'</div></div>'
    +'</div>'
    // 右：關卡列表
    +'<div style="flex:1;min-width:0;padding-top:6px">'+rowsHtml+'</div>'
    +'</div></div>';

  // 綁定滑桿（DOM 插入後執行）
  setTimeout(()=>{
    const slider = document.getElementById(slid_id);
    const infoEl = document.getElementById(info_id);
    if(!slider||!infoEl) return;
    slider.addEventListener('input', ()=>{
      const p = parseFloat(slider.value);
      infoEl.innerHTML = buildInfo(p);
      _drawSRGauge(uid_sr, r, pMin, pMax, p);
      const rowsEl = document.getElementById(rows_id);
      if(rowsEl) rowsEl.innerHTML = buildRows(p);
    });
  }, 100);

  return html;
}

// ── 支撐壓力轉速表 ──
function _drawSRGauge(uid, r, pMin, pMax, simPrice) {
  const canvas = document.getElementById(uid);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W=190, H=120, cx=95, cy=110, R=86, rIn=60;
  canvas.style.width  = W+'px';
  canvas.style.height = H+'px';
  canvas.width  = Math.round(W*dpr);
  canvas.height = Math.round(H*dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const toAngle = p => Math.PI + Math.max(0,Math.min(1,(p-pMin)/(pMax-pMin))) * Math.PI;
  const curPrice = simPrice ?? r.lastClose;

  // 背景弧（暗灰）
  ctx.beginPath();
  ctx.arc(cx,cy,R,Math.PI,2*Math.PI);
  ctx.arc(cx,cy,rIn,2*Math.PI,Math.PI,true);
  ctx.closePath();
  ctx.fillStyle='rgba(255,255,255,0.05)';
  ctx.fill();

  // 支撐區帶（紅，最低支撐以下）
  const sItems = (r.support?.items??[]).slice(0,3);
  const rItems = (r.resistance?.items??[]).slice(0,3);
  if (sItems.length) {
    const loS = Math.min(...sItems.map(s=>s.price));
    const a1=Math.PI, a2=toAngle(loS);
    ctx.beginPath(); ctx.arc(cx,cy,R,a1,a2); ctx.arc(cx,cy,rIn,a2,a1,true);
    ctx.closePath(); ctx.fillStyle='rgba(239,83,80,0.12)'; ctx.fill();
  }
  // 壓力區帶（綠，最高壓力以上）
  if (rItems.length) {
    const hiR = Math.max(...rItems.map(s=>s.price));
    const a1=toAngle(hiR), a2=2*Math.PI;
    ctx.beginPath(); ctx.arc(cx,cy,R,a1,a2); ctx.arc(cx,cy,rIn,a2,a1,true);
    ctx.closePath(); ctx.fillStyle='rgba(38,166,154,0.12)'; ctx.fill();
  }

  // 刻度
  ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=0.5;
  for(let i=0;i<=20;i++){
    const a=Math.PI+(i/20)*Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a)*rIn, cy+Math.sin(a)*rIn);
    ctx.lineTo(cx+Math.cos(a)*R,   cy+Math.sin(a)*R);
    ctx.stroke();
  }

  // 支撐線（紅）
  sItems.forEach(s=>{
    const a=toAngle(s.price);
    ctx.strokeStyle='#ef5350';
    ctx.lineWidth=s.strength===3?2.5:s.strength===2?1.8:1.2;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a)*(rIn-2), cy+Math.sin(a)*(rIn-2));
    ctx.lineTo(cx+Math.cos(a)*(R+2),   cy+Math.sin(a)*(R+2));
    ctx.stroke();
  });

  // 壓力線（綠）
  rItems.forEach(s=>{
    const a=toAngle(s.price);
    ctx.strokeStyle='#26a69a';
    ctx.lineWidth=s.strength===3?2.5:s.strength===2?1.8:1.2;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a)*(rIn-2), cy+Math.sin(a)*(rIn-2));
    ctx.lineTo(cx+Math.cos(a)*(R+2),   cy+Math.sin(a)*(R+2));
    ctx.stroke();
  });

  // 現價指針（金）— 動畫狀態存在 canvas 上，避免每次重畫從 pMin 暴衝、多重 rAF 疊加亂飄
  const EASE = 0.15;
  const SNAP = Math.max(0.05, (pMax-pMin)*0.0015);
  if (canvas._srRaf) { cancelAnimationFrame(canvas._srRaf); canvas._srRaf = null; }
  let cur = (typeof canvas._srCur === 'number' && isFinite(canvas._srCur)) ? canvas._srCur : pMin;
  const target = curPrice;
  function animate() {
    const diff = target - cur;
    if (Math.abs(diff) < SNAP) { cur = target; canvas._srCur = cur; canvas._srRaf = null; drawFrame(cur); return; }
    cur += diff * EASE;
    canvas._srCur = cur;
    drawFrame(cur);
    canvas._srRaf = requestAnimationFrame(animate);
  }
  function drawFrame(p) {
    // 只重繪指針部分（不清除色帶）
    ctx.clearRect(0,0,W,H);
    // 重繪色帶和線條（簡化：直接重繪）
    ctx.beginPath(); ctx.arc(cx,cy,R,Math.PI,2*Math.PI); ctx.arc(cx,cy,rIn,2*Math.PI,Math.PI,true);
    ctx.closePath(); ctx.fillStyle='rgba(255,255,255,0.05)'; ctx.fill();
    if (sItems.length) {
      const loS=Math.min(...sItems.map(s=>s.price)), a1=Math.PI, a2=toAngle(loS);
      ctx.beginPath(); ctx.arc(cx,cy,R,a1,a2); ctx.arc(cx,cy,rIn,a2,a1,true);
      ctx.closePath(); ctx.fillStyle='rgba(239,83,80,0.12)'; ctx.fill();
    }
    if (rItems.length) {
      const hiR=Math.max(...rItems.map(s=>s.price)), a1=toAngle(hiR), a2=2*Math.PI;
      ctx.beginPath(); ctx.arc(cx,cy,R,a1,a2); ctx.arc(cx,cy,rIn,a2,a1,true);
      ctx.closePath(); ctx.fillStyle='rgba(38,166,154,0.12)'; ctx.fill();
    }
    ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=0.5;
    for(let i=0;i<=20;i++){
      const a=Math.PI+(i/20)*Math.PI;
      ctx.beginPath(); ctx.moveTo(cx+Math.cos(a)*rIn,cy+Math.sin(a)*rIn); ctx.lineTo(cx+Math.cos(a)*R,cy+Math.sin(a)*R); ctx.stroke();
    }
    sItems.forEach(s=>{
      const a=toAngle(s.price); ctx.strokeStyle='#ef5350'; ctx.lineWidth=s.strength===3?2.5:s.strength===2?1.8:1.2;
      ctx.beginPath(); ctx.moveTo(cx+Math.cos(a)*(rIn-2),cy+Math.sin(a)*(rIn-2)); ctx.lineTo(cx+Math.cos(a)*(R+2),cy+Math.sin(a)*(R+2)); ctx.stroke();
    });
    rItems.forEach(s=>{
      const a=toAngle(s.price); ctx.strokeStyle='#26a69a'; ctx.lineWidth=s.strength===3?2.5:s.strength===2?1.8:1.2;
      ctx.beginPath(); ctx.moveTo(cx+Math.cos(a)*(rIn-2),cy+Math.sin(a)*(rIn-2)); ctx.lineTo(cx+Math.cos(a)*(R+2),cy+Math.sin(a)*(R+2)); ctx.stroke();
    });
    // 指針
    const pA=toAngle(p);
    ctx.strokeStyle='#FFD600'; ctx.lineWidth=3; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(cx+Math.cos(pA)*14,cy+Math.sin(pA)*14); ctx.lineTo(cx+Math.cos(pA)*(R-7),cy+Math.sin(pA)*(R-7)); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx,cy,7,0,Math.PI*2); ctx.fillStyle='#FFD600'; ctx.fill();
  }
  animate();
}

// ── 複合訊號生成器 ──────────────────────────────────────────
function _buildCompoundSignals(r, candles, short, trendHealth) {
  const signals = [];
  const inds = r.trend?.indicators ?? {};
  const vp   = r.volumePrice;
  const N    = candles.length;

  // A. EMA 多空排列 + ADX 強趨勢 → 複合做多/做空
  const ma  = inds.maAlignment;
  const adx = inds.adx;
  const adxVal = adx?.value ? parseFloat(adx.value) : 0;
  if (ma?.score > 0 && adxVal > 25) {
    signals.push({ type:'bull', icon:'🚀', text:`MA多頭排列 + ADX ${adxVal.toFixed(0)} 強趨勢，順勢做多有利` });
  } else if (ma?.score < 0 && adxVal > 25) {
    signals.push({ type:'bear', icon:'⛔', text:`MA空頭排列 + ADX ${adxVal.toFixed(0)} 強趨勢，逆勢風險高` });
  }

  // B. HH/HL 波段結構
  const hhhl = inds.hhhl;
  if (hhhl?.value?.includes('HH+HL')) {
    signals.push({ type:'bull', icon:'📈', text:'高點低點依序墊高（HH+HL），多頭波段結構完整' });
  } else if (hhhl?.value?.includes('LH+LL')) {
    signals.push({ type:'bear', icon:'📉', text:'高點低點依序墊低（LH+LL），空頭波段結構確立' });
  }

  // C. SAR 剛翻多/翻空（比值持續偵測）
  const sar = inds.sar;
  if (sar?.value?.includes('剛翻多')) {
    signals.push({ type:'bull', icon:'🔄', text:`SAR 剛翻多，趨勢轉換訊號，可輕倉試多` });
  } else if (sar?.value?.includes('剛翻空')) {
    signals.push({ type:'bear', icon:'🔄', text:`SAR 剛翻空，趨勢反轉警告，持倉需謹慎` });
  }

  // D. 乖離率極值警告
  const bias = inds.bias;
  if (bias?.score <= -0.5) {
    const bv = bias.value?.split('%')[0] ?? '';
    signals.push({ type:'warn', icon:'⚠️', text:`乖離率 ${bv}%，嚴重超漲，短線追高風險高` });
  } else if (bias?.score >= 0.3) {
    const bv = bias.value?.split('%')[0] ?? '';
    signals.push({ type:'bull', icon:'💎', text:`乖離率 ${bv}%，超跌區，可逢低留意反彈` });
  }

  // E. 突破訊號
  const brk = inds.breakout;
  if (brk?.value?.includes('突破後回測')) {
    signals.push({ type:'bull', icon:'✅', text:'突破前高後回測確認，是相對安全的進場點' });
  } else if (brk?.value?.includes('近期突破前高')) {
    signals.push({ type:'bull', icon:'🔔', text:'近期突破前高，留意是否有量配合，有量才算' });
  }

  // F. 量價訊號
  if (vp && !vp.empty) {
    if (vp.signal === 'bullish') {
      signals.push({ type:'bull', icon:'💹', text:`價量齊揚（${vp.pattern}），買盤積極，健康多方` });
    } else if (vp.signal === 'warning') {
      signals.push({ type:'warn', icon:'⚡', text:`${vp.pattern}，動能不足，勿追高` });
    } else if (vp.signal === 'bearish') {
      signals.push({ type:'bear', icon:'🔴', text:`${vp.pattern}，賣壓沉重，先觀望` });
    }
    if (vp.surge) {
      signals.push({ type:'warn', icon:'📦', text:`爆量（均量 ${vp.surge.ratio}x），需確認漲跌方向再判斷出貨或吸籌` });
    }
    if (vp.divergence?.type === 'top') {
      signals.push({ type:'bear', icon:'🚨', text:'高檔量價背離（價漲量縮），注意短線拉回' });
    } else if (vp.divergence?.type === 'bottom') {
      signals.push({ type:'bull', icon:'🛟', text:'低檔量價背離（價跌量縮），跌勢趨緩，可留意止跌訊號' });
    }
  }

  // G. PSY 極值
  const psy = inds.psy;
  if (psy?.score < 0) {
    signals.push({ type:'warn', icon:'🌡️', text:`${psy.reason}` });
  } else if (psy?.score > 0) {
    signals.push({ type:'bull', icon:'🌡️', text:`${psy.reason}` });
  }

  // 最多顯示 5 條，多空各取最強，警告補充
  const bulls = signals.filter(s=>s.type==='bull').slice(0,2);
  const bears = signals.filter(s=>s.type==='bear').slice(0,2);
  const warns = signals.filter(s=>s.type==='warn').slice(0,1);
  return [...bulls, ...bears, ...warns].slice(0,5);
}

// ============================================================================
// Tab 1 — 均線：EMA + BB + ENV + SAR + GMMA
// ============================================================================

function _tabEMA(body, candles) {
  const closes = candles.map(c=>c.close??c.c??0);
  const n      = candles.length;
  const ema5   = calcEMA(closes,5), ema10=calcEMA(closes,10);
  const ema20  = calcEMA(closes,20), ema60=calcEMA(closes,60);
  const bb     = calcBollinger(closes,20,2);
  const bbU    = bb.map(b=>b?.upper??null), bbM=bb.map(b=>b?.mid??null), bbL=bb.map(b=>b?.lower??null);
  const env    = calcEnvelope(closes,20,5);
  const envU   = env.map(e=>e?.upper??null), envM=env.map(e=>e?.mid??null), envL=env.map(e=>e?.lower??null);
  const sar    = calcSAR(candles,0.02,0.2);
  const gmma   = n>=62 ? calcGMMA(closes) : null;

  // ── EMA + BB ──
  {
    const {card,canvas,textEl,chipEl} = _card('EMA 5/10/20/60 + 布林通道 (20,2)', 130);
    body.appendChild(card);
    const {ctx,w,h} = _size(canvas,130);
    const [mn,mx] = _mm([...closes,...bbU.filter(Boolean),...bbL.filter(Boolean)]);
    _grid(ctx,w,h);
    _band(ctx,bbU,bbL,w,h,mn,mx,'rgba(59,130,246,0.13)','rgba(59,130,246,0.02)');
    _line(ctx,closes,w,h,mn,mx,'rgba(255,255,255,0.2)',1);
    _line(ctx,ema5,  w,h,mn,mx,C_AMBER,1.2);
    _line(ctx,ema10, w,h,mn,mx,C_BLUE, 1.2);
    _line(ctx,ema20, w,h,mn,mx,C_PURP, 1.2);
    _line(ctx,ema60, w,h,mn,mx,C_UP,   1.2);
    _line(ctx,bbU,   w,h,mn,mx,'rgba(59,130,246,0.6)',1);
    _line(ctx,bbM,   w,h,mn,mx,'rgba(59,130,246,0.3)',0.7);
    _line(ctx,bbL,   w,h,mn,mx,'rgba(59,130,246,0.6)',1);
    _legend(ctx,w,[{label:'EMA5',color:C_AMBER},{label:'EMA10',color:C_BLUE},{label:'EMA20',color:C_PURP},{label:'EMA60',color:C_UP}]);

    const [e5,e10,e20,e60] = [_last(ema5),_last(ema10),_last(ema20),_last(ema60)];
    const bbl = _last(bb), lc = closes[n-1];
    let emaText='';
    if(e5&&e10&&e20&&e60){
      if(e5>e10&&e10>e20&&e20>e60)       emaText='多頭排列（5>10>20>60），短線動能強';
      else if(e5<e10&&e10<e20&&e20<e60)  emaText='空頭排列（5<10<20<60），偏空格局';
      else if(e5>e20&&e20>e60)            emaText='短線偏多，中線尚未完全多排，注意回測';
      else                                emaText='EMA糾結，方向待確認';
    }
    let bbText='';
    if(bbl){
      const bw=bbl.width;
      const sq=bw<3?'BB帶寬收窄（整理，留意突破方向）':bw>8?'BB帶寬擴張（行情進行中）':'BB帶寬正常';
      const pos=lc>bbl.upper?`突破上軌（+${((lc-bbl.upper)/bbl.upper*100).toFixed(1)}%），強勢`:
                lc<bbl.lower?`跌破下軌（${((lc-bbl.lower)/bbl.lower*100).toFixed(1)}%），超賣`:
                lc>bbl.mid?'現價在中軌上方，偏強':'現價在中軌下方，偏弱';
      bbText=`${sq}；${pos}`;
    }
    let maTone='neutral',maChip='均線糾結';
    if(e5&&e10&&e20&&e60){
      if(e5>e10&&e10>e20&&e20>e60){maTone='bull';maChip='多頭排列';}
      else if(e5<e10&&e10<e20&&e20<e60){maTone='bear';maChip='空頭排列';}
      else if(e5>e20&&e20>e60){maTone='bull';maChip='短多・中線待確認';}
    }
    _chip(chipEl,maChip,maTone);
    const _emaC=(a,b)=>a>b?C_UP:a<b?C_DOWN:C_MUTED;
    const emaStats=[];
    if(e5)  emaStats.push({k:'EMA5', v:e5.toFixed(2),  c:_emaC(e5,e10)});
    if(e20) emaStats.push({k:'EMA20',v:e20.toFixed(2), c:_emaC(e20,e60)});
    if(e60) emaStats.push({k:'EMA60',v:e60.toFixed(2)});
    if(bbl) emaStats.push({k:'BB帶寬',v:bbl.width.toFixed(1)});
    textEl.innerHTML=_txt2(emaStats,`${[emaText,bbText].filter(Boolean).join('。')}。短均站上長均且發散時順勢偏多；均線糾結時等方向明朗再進場。`);
  }

  // ── ENV ──
  {
    const {card,canvas,textEl,chipEl} = _card('ENV 乖離通道 (MA20 ±5%)',100);
    body.appendChild(card);
    const {ctx,w,h} = _size(canvas,100);
    const [mn,mx] = _mm([...closes,...envU.filter(Boolean),...envL.filter(Boolean)]);
    _grid(ctx,w,h);
    _band(ctx,envU,envL,w,h,mn,mx,'rgba(245,158,11,0.13)','rgba(245,158,11,0.02)');
    _line(ctx,closes,w,h,mn,mx,'rgba(255,255,255,0.2)',1);
    _line(ctx,envU,w,h,mn,mx,'rgba(245,158,11,0.7)',1);
    _line(ctx,envM,w,h,mn,mx,'rgba(245,158,11,0.3)',0.7);
    _line(ctx,envL,w,h,mn,mx,'rgba(245,158,11,0.7)',1);

    const lc=closes[n-1],eu=_last(envU),el=_last(envL),em=_last(envM);
    if(eu&&el&&em){
      const bias=(lc-em)/em*100, bs=(bias>=0?'+':'')+bias.toFixed(1)+'%';
      let tone,chip,read;
      if(lc>eu){tone='warn';chip='突破上軌・追高謹慎';read='股價衝出 +5% 乖離帶上緣，短線過熱。回測上軌不破可續抱；跌回通道內宜減碼，乖離擴大常是短線高點訊號。';}
      else if(lc<el){tone='bull';chip='跌破下軌・超跌候選';read='股價跌破 -5% 乖離帶下緣，乖離過大易出現反彈。可留意，但需配合量能與其他指標，勿單獨接刀。';}
      else{tone='neutral';chip='通道內整理';read='股價在 ±5% 乖離帶內正常波動。靠近上軌偏強、靠近下軌偏弱，貼著中軌（MA20）為盤整。';}
      _chip(chipEl,chip,tone);
      textEl.innerHTML=_txt2([
        {k:'MA20',v:em.toFixed(2)},
        {k:'上軌',v:eu.toFixed(2),c:C_AMBER},
        {k:'下軌',v:el.toFixed(2),c:C_AMBER},
        {k:'乖離',v:bs,c:bias>=0?C_UP:C_DOWN},
      ],read);
    }
  }

  // ── SAR ──
  {
    const {card,canvas,textEl,chipEl} = _card('SAR 拋物線停損 (step 0.02)',110);
    body.appendChild(card);
    const {ctx,w,h} = _size(canvas,110);
    const [mn,mx] = _mm([...closes,...sar.filter(Boolean)]);
    const span=mx-mn||1;
    _grid(ctx,w,h);
    _line(ctx,closes,w,h,mn,mx,'rgba(255,255,255,0.3)',1.2);
    sar.forEach((v,i)=>{
      if(v==null)return;
      const x=(i/(n-1))*w, y=h-((v-mn)/span)*h;
      ctx.fillStyle=v<closes[i]?C_UP:C_DOWN;  // 下方=多頭=紅；上方=空頭=綠
      ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill();
    });
    const ls=_last(sar),lc=closes[n-1];
    if(ls!=null){
      const bull=ls<lc, dist=Math.abs((lc-ls)/lc*100).toFixed(1);
      _chip(chipEl, bull?'多頭・SAR 在下方':'空頭・SAR 在上方', bull?'bull':'bear');
      const read=bull
        ?`翻多後拋物點逐步上移墊高停損。現價站穩 SAR 上方續抱；單日收盤跌破 ${ls.toFixed(2)} 即多翻空，停損位明確、不需猜測。`
        :`空頭中拋物點壓在上方逐步下移。現價在 SAR 下方續弱；單日收盤突破 ${ls.toFixed(2)} 才轉多，否則勿搶反彈。`;
      textEl.innerHTML=_txt2([
        {k:'SAR',v:ls.toFixed(2),c:bull?C_UP:C_DOWN},
        {k:'現價',v:lc.toFixed(2)},
        {k:'距離',v:dist+'%'},
        {k:'加速因子',v:'0.02→0.20'},
      ],read);
    }
  }

  // ── GMMA ──
  {
    const {card,canvas,textEl,chipEl} = _card('GMMA 顧比均線（短期6藍 + 長期6紅）',110);
    body.appendChild(card);
    const {ctx,w,h} = _size(canvas,110);
    if(!gmma){
      ctx.fillStyle=C_MUTED; ctx.font='11px sans-serif'; ctx.textAlign='center';
      ctx.fillText('資料不足（需 62 根以上）',w/2,h/2);
      _chip(chipEl,'資料不足','neutral');
      textEl.innerHTML=_txt2([],'需 62 根以上 K 線才能計算長期 EMA60。請切換較長週期或等待資料補齊。');
    } else {
      let mn=Infinity,mx=-Infinity;
      [...gmma.short,...gmma.long].forEach(s=>s.forEach(v=>{if(v==null)return;mn=Math.min(mn,v);mx=Math.max(mx,v);}));
      closes.forEach(v=>{mn=Math.min(mn,v);mx=Math.max(mx,v);});
      const p=(mx-mn)*0.06;
      _grid(ctx,w,h);
      _line(ctx,closes,w,h,mn-p,mx+p,'rgba(255,255,255,0.2)',1);
      gmma.short.forEach(s=>_line(ctx,s,w,h,mn-p,mx+p,'rgba(59,130,246,0.6)',1));
      gmma.long.forEach(s =>_line(ctx,s,w,h,mn-p,mx+p,'rgba(239,83,80,0.6)', 1));
      _legend(ctx,w,[{label:'短期組',color:'rgba(59,130,246,0.9)'},{label:'長期組',color:'rgba(239,83,80,0.9)'}]);

      const ls=gmma.short.map(_last).filter(Boolean), ll=gmma.long.map(_last).filter(Boolean);
      if(ls.length&&ll.length){
        const sMin=Math.min(...ls),sMax=Math.max(...ls),lMin=Math.min(...ll),lMax=Math.max(...ll);
        let tone,chip,read,state;
        if(ls.every(v=>v>lMax)){tone='bull';chip='多頭趨勢確立';state='短期全在上';read='短期 6 線完全在長期 6 線之上且間距放大，散戶與機構同向做多，趨勢健康。若短期帶開始收斂插入長期帶為轉弱前兆。';}
        else if(ls.every(v=>v<lMin)){tone='bear';chip='空頭趨勢確立';state='短期全在下';read='短期 6 線完全在長期 6 線之下，賣方主導，反彈多為逃命波。等短期帶上穿長期帶再談轉多。';}
        else if(sMin>lMin&&sMax<lMax){tone='warn';chip='趨勢轉換觀察';state='短期穿插';read='短期組插入長期組中，多空拉鋸的轉折觀察期。等短期帶明確脫離長期帶再決定方向，勿預設立場。';}
        else{tone='neutral';chip='盤整交纏';state='長短交纏';read='長短期均線糾纏、間距收斂，盤整格局缺乏明確趨勢。等帶距重新擴張代表新趨勢啟動。';}
        _chip(chipEl,chip,tone);
        textEl.innerHTML=_txt2([
          {k:'短期組',v:'6 線',c:C_BLUE},
          {k:'長期組',v:'6 線',c:C_UP},
          {k:'狀態',v:state},
        ],read);
      }
    }
  }
}

// ============================================================================
// Tab 2 — 籌碼：支撐壓力 + 分價量
// ============================================================================

function _tabQuant(body, candles, r) {
  const closes = candles.map(c=>c.close??c.c??0);
  const n      = candles.length;

  // ── 支撐壓力關卡圖 ──
  {
    const {card,canvas,textEl,chipEl} = _card('支撐 / 壓力 關卡（S1~S3 / R1~R3）',140);
    body.appendChild(card);
    const {ctx,w,h} = _size(canvas,140);

    const sups = (r?.support?.items||[]).slice(0,3);
    const ress = (r?.resistance?.items||[]).slice(0,3);
    const allP = [...closes,...sups.map(s=>s.price),...ress.map(s=>s.price)];
    const [mn,mx] = _mm(allP);
    const span=mx-mn||1;

    _grid(ctx,w,h);
    _line(ctx,closes,w,h,mn,mx,'rgba(255,255,255,0.3)',1.2);

    const _hl=(price,color,tag)=>{
      if(price<mn||price>mx)return;
      const y=h-((price-mn)/span)*h;
      ctx.strokeStyle=color; ctx.lineWidth=1;
      ctx.setLineDash([5,3]);
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font='bold 10px sans-serif'; ctx.fillStyle=color; ctx.textAlign='left';
      ctx.fillText(`${tag} ${price}`,4,y-3);
    };
    ress.forEach((s,i)=>_hl(s.price,'#e53935',`R${i+1}`));
    sups.forEach((s,i)=>_hl(s.price,'#1e88e5',`S${i+1}`));

    const lc=closes[n-1], yN=h-((lc-mn)/span)*h;
    ctx.strokeStyle=C_GOLD; ctx.lineWidth=1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(0,yN); ctx.lineTo(w,yN); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font='bold 10px sans-serif'; ctx.fillStyle=C_GOLD; ctx.textAlign='right';
    ctx.fillText(`▶ ${lc}`,w-2,yN-3);

    const r1=ress[0],s1=sups[0];
    let srTone='neutral',srChip='區間整理';
    if(r1&&r1.distance<2){srTone='warn';srChip='逼近壓力 R1';}
    else if(s1&&s1.distance<2){srTone='bull';srChip='貼近支撐 S1';}
    else if(!r1&&!s1){srChip='無明顯關卡';}
    _chip(chipEl,srChip,srTone);
    const srStats=[];
    if(r1){srStats.push({k:'壓力 R1',v:'$'+r1.price,c:C_UP});srStats.push({k:'距壓',v:'+'+r1.distance+'%',c:C_UP});}
    if(s1){srStats.push({k:'支撐 S1',v:'$'+s1.price,c:C_BLUE});srStats.push({k:'距撐',v:'-'+s1.distance+'%',c:C_BLUE});}
    const srRead=(r1||s1)
      ?`上方壓力 ${r1?('$'+r1.price+' '+_stars(r1.strength)):'—'}，下方支撐 ${s1?('$'+s1.price+' '+_stars(s1.strength)):'—'}。星級越高關卡越強，帶量突破壓力可追、跌破支撐宜停損。`
      :`目前無明顯支撐/壓力關卡，價格處於空白區間，方向參考其他指標。`;
    textEl.innerHTML=_txt2(srStats,srRead);
  }

  // ── 分價量 ──
  {
    const LOOK=60, BUCK=20;
    const {card,canvas,textEl,chipEl} = _card(`分價量（近${LOOK}根，${BUCK}格）`,170);
    body.appendChild(card);
    const {ctx,w,h} = _size(canvas,170);
    _grid(ctx,w,h);

    const sl=candles.slice(-LOOK);
    if(sl.length<10){
      ctx.fillStyle=C_MUTED; ctx.font='11px sans-serif'; ctx.textAlign='center';
      ctx.fillText('資料不足',w/2,h/2);
      _chip(chipEl,'資料不足','neutral');
      textEl.innerHTML=_txt2([],'近期 K 線不足以統計分價量分布，請切換較長週期。');
    } else {
      const sc=sl.map(c=>c.close??c.c??0), sv=sl.map(c=>c.volume??c.v??0);
      const pMin=Math.min(...sc), pMax=Math.max(...sc), step=(pMax-pMin)/BUCK||1;
      const bkts=new Array(BUCK).fill(0);
      sl.forEach((c,i)=>{const p=c.close??c.c??0; bkts[Math.min(BUCK-1,Math.floor((p-pMin)/step))]+=sv[i];});
      const maxV=Math.max(...bkts)||1;

      const barW=w*0.55, lx=w*0.58, lw=w-lx;
      bkts.forEach((v,i)=>{
        const r=v/maxV, y1=h-((i+1)/BUCK)*h, bh=h/BUCK-1;
        ctx.fillStyle=r>0.7?'rgba(245,158,11,0.65)':'rgba(59,130,246,0.35)';
        ctx.fillRect(0,y1,barW*r,bh);
      });

      const sMn=pMin-(pMax-pMin)*0.06, sMx=pMax+(pMax-pMin)*0.06, sSp=sMx-sMn||1;
      ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=1;
      ctx.beginPath();
      sc.forEach((p,i)=>{
        const x=lx+(i/(sc.length-1))*lw, y=h-((p-sMn)/sSp)*h;
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      });
      ctx.stroke();

      const lc=sc[sc.length-1], yN=h-((lc-sMn)/sSp)*h;
      ctx.strokeStyle=C_GOLD; ctx.lineWidth=0.8; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(0,yN); ctx.lineTo(w,yN); ctx.stroke();
      ctx.setLineDash([]);

      const mi=bkts.indexOf(maxV), dlo=+(pMin+mi*step).toFixed(2), dhi=+(dlo+step).toFixed(2);
      const totalV=sv.reduce((a,b)=>a+b,0)||1;
      const pct=((bkts[mi]/totalV)*100).toFixed(0);
      let vpTone,vpChip,vpRead;
      if(lc>dhi){vpTone='bull';vpChip='密集區上方';vpRead=`現價在主力套牢區上方，頭頂無解套賣壓，回測 $${dlo}~$${dhi} 為支撐。`;}
      else if(lc<dlo){vpTone='warn';vpChip='密集區下方';vpRead=`現價在套牢區下方，上方 $${dlo}~$${dhi} 是解套賣壓，反彈到此易遇阻，需放量才能突破。`;}
      else{vpTone='neutral';vpChip='密集區內';vpRead=`現價落在籌碼最密集區，支撐強但套牢盤也多，常陷區間整理，等帶量突破上緣才轉強。`;}
      _chip(chipEl,vpChip,vpTone);
      textEl.innerHTML=_txt2([
        {k:'密集區',v:`$${dlo}~$${dhi}`,c:C_AMBER},
        {k:'量集中',v:pct+'%'},
        {k:'現價',v:lc.toFixed(2)},
      ],vpRead);
    }
  }
}

// ============================================================================
// Tab 3 — 動能：DMI + PSY + RCI + HV
// ============================================================================

function _tabMomentum(body, candles) {
  const closes=candles.map(c=>c.close??c.c??0);
  const dmi=calcDMI(candles,14), psy=calcPSY(closes,12), rci=calcRCI(closes,9), hv=calcHV(closes,20);

  // ── DMI ──
  {
    const {card,canvas,textEl,chipEl}=_card('DMI / ADX (14) — ADX白 / DI+紅 / DI-綠',120);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,120);
    const [mn,mx]=_mmMulti(dmi.plusDI,dmi.minusDI,dmi.adx);
    const sp=mx-mn||1;
    _grid(ctx,w,h);
    const _hy=v=>h-((v-mn)/sp)*h;
    _hlineY(ctx,_hy(25),w,'rgba(255,255,255,0.2)');
    _hlineY(ctx,_hy(20),w,'rgba(255,255,255,0.1)');
    ctx.font='10px sans-serif'; ctx.textAlign='left'; ctx.fillStyle=C_MUTED;
    ctx.fillText('25',2,_hy(25)-2); ctx.fillText('20',2,_hy(20)-2);
    _line(ctx,dmi.plusDI, w,h,mn,mx,C_UP,  1.5);
    _line(ctx,dmi.minusDI,w,h,mn,mx,C_DOWN,1.5);
    _line(ctx,dmi.adx,    w,h,mn,mx,'rgba(255,255,255,0.75)',2);
    _legend(ctx,w,[{label:'DI+',color:C_UP},{label:'DI-',color:C_DOWN},{label:'ADX',color:'rgba(255,255,255,0.75)'}]);

    const adx=_last(dmi.adx),dip=_last(dmi.plusDI),dim=_last(dmi.minusDI);
    if(adx!=null&&dip!=null&&dim!=null){
      const bull=dip>dim, strong=adx>25;
      _chip(chipEl, (bull?'多頭':'空頭')+(adx>30?'強趨勢':adx>25?'趨勢成形':adx>20?'弱趨勢':'盤整無趨勢'), adx<20?'neutral':(bull?'bull':'bear'));
      const read=`${strong?'ADX>25、趨勢明確':'ADX 偏低、趨勢未成形，順勢單勝率低'}。${bull?'DI+ 在上、多方主導，回檔找買點':'DI- 在上、空方主導，反彈視為減碼'}。ADX 由低翻揚是趨勢啟動訊號。`;
      textEl.innerHTML=_txt2([
        {k:'ADX',v:adx.toFixed(1),c:adx>25?C_GOLD:C_MUTED},
        {k:'DI+',v:dip.toFixed(1),c:C_UP},
        {k:'DI-',v:dim.toFixed(1),c:C_DOWN},
      ],read);
    }
  }

  // ── PSY ──
  {
    const {card,canvas,textEl,chipEl}=_card('PSY 心理線 (12) — >75過熱 / <25悲觀',100);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,100);
    _grid(ctx,w,h);
    _hlineY(ctx,h*0.25,w,'rgba(239,83,80,0.4)');
    _hlineY(ctx,h*0.50,w,'rgba(255,255,255,0.15)');
    _hlineY(ctx,h*0.75,w,'rgba(38,166,154,0.4)');
    ctx.font='10px sans-serif'; ctx.textAlign='left'; ctx.fillStyle=C_MUTED;
    ctx.fillText('75',2,h*0.25-2); ctx.fillText('25',2,h*0.75-2);
    _line(ctx,psy,w,h,0,100,C_PURP,1.8);
    _labelRight(ctx,`PSY ${_last(psy)?.toFixed(1)}%`,C_PURP,w);

    const lp=_last(psy);
    if(lp!=null){
      let tone,chip,read;
      if(lp>75){tone='warn';chip='過熱（>75）';read='近 12 日上漲天數過多，市場過度樂觀，短線易拉回，追高風險高。';}
      else if(lp<25){tone='bull';chip='悲觀（<25）';read='近 12 日跌多漲少，情緒悲觀，常是反彈醞釀區，可留意但需訊號確認。';}
      else if(lp>50){tone='bull';chip='偏多氣氛';read='上漲天數過半，氣氛偏多但未過熱，趨勢中段可續抱。';}
      else{tone='bear';chip='偏空氣氛';read='下跌天數過半，氣氛偏弱，反彈力道有限，宜保守。';}
      _chip(chipEl,chip,tone);
      textEl.innerHTML=_txt2([
        {k:'PSY',v:lp.toFixed(0)+'%',c:lp>75?C_AMBER:lp<25?C_DOWN:lp>50?C_UP:C_DOWN},
        {k:'過熱線',v:'75%'},
        {k:'悲觀線',v:'25%'},
      ],read);
    }
  }

  // ── RCI ──
  {
    const {card,canvas,textEl,chipEl}=_card('RCI (9) 順位相關 — +80極強多 / -80極強空',100);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,100);
    _grid(ctx,w,h);
    const _ry=v=>h-((v+100)/200)*h;
    _hlineY(ctx,_ry(80), w,'rgba(239,83,80,0.4)');
    _hlineY(ctx,_ry(0),  w,'rgba(255,255,255,0.2)');
    _hlineY(ctx,_ry(-80),w,'rgba(38,166,154,0.4)');
    ctx.font='10px sans-serif'; ctx.textAlign='left'; ctx.fillStyle=C_MUTED;
    ctx.fillText('+80',2,_ry(80)-2); ctx.fillText('0',2,_ry(0)-2); ctx.fillText('-80',2,_ry(-80)-2);
    _line(ctx,rci,w,h,-100,100,C_AMBER,1.8);
    _labelRight(ctx,`RCI ${_last(rci)?.toFixed(1)}`,C_AMBER,w);

    const lr=_last(rci);
    if(lr!=null){
      let tone,chip,read;
      if(lr>80){tone='warn';chip='極強多（>+80）';read='RCI 進入超買頂部區，多頭強但接近反轉，追高需設好停利，留意高檔鈍化。';}
      else if(lr<-80){tone='bull';chip='極強空（<-80）';read='RCI 進入超賣底部區，空頭強但接近反轉，可觀察翻多訊號，勿在下跌中段搶接。';}
      else if(lr>0){tone='bull';chip='多頭方向';read='RCI 在零軸上方，順位偏多，短線動能向上。';}
      else{tone='bear';chip='空頭方向';read='RCI 在零軸下方，順位偏空，短線動能向下。';}
      _chip(chipEl,chip,tone);
      textEl.innerHTML=_txt2([
        {k:'RCI',v:lr.toFixed(0),c:lr>0?C_UP:C_DOWN},
        {k:'極強多',v:'+80'},
        {k:'極強空',v:'-80'},
      ],read);
    }
  }

  // ── HV ──
  {
    const {card,canvas,textEl,chipEl}=_card('HV 歷史波動率 (20) — 年化%',100);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,100);
    const valid=hv.filter(Boolean), avg=valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:30;
    const [mn,mx]=_mm(hv,0.1);
    _grid(ctx,w,h);
    const yA=h-((avg-mn)/(mx-mn||1))*h;
    _hlineY(ctx,yA,w,'rgba(255,255,255,0.25)');
    ctx.font='10px sans-serif'; ctx.textAlign='left'; ctx.fillStyle=C_MUTED;
    ctx.fillText(`均 ${avg.toFixed(0)}%`,2,yA-2);
    _line(ctx,hv,w,h,mn,mx,C_CYAN,1.8);
    _labelRight(ctx,`HV ${_last(hv)?.toFixed(1)}%`,C_CYAN,w);

    const lh=_last(hv);
    if(lh!=null){
      let tone,chip,read;
      if(lh>50){tone='warn';chip='高波動';read='年化波動率偏高，行情劇烈、風險大，部位宜縮小、停損放寬避免被掃。';}
      else if(lh<20){tone='neutral';chip='低波動潛伏';read='波動收斂到低檔，能量壓縮中，常是變盤前的平靜，等放量表態再進場。';}
      else{tone='neutral';chip='波動正常';read='波動率落在常態區間，依趨勢指標操作即可。';}
      _chip(chipEl,chip,tone);
      const rel=lh>avg*1.3?'高於均值':lh<avg*0.7?'低於均值':'近均值';
      textEl.innerHTML=_txt2([
        {k:'HV',v:lh.toFixed(1)+'%',c:C_CYAN},
        {k:'均值',v:avg.toFixed(0)+'%'},
        {k:'相對',v:rel},
      ],read);
    }
  }
}

// ============================================================================
// Tab 4 — 震盪：KD + RSI + MACD
// ============================================================================

function _tabOscillator(body, candles) {
  const closes=candles.map(c=>c.close??c.c??0);
  const kd=calcKD(candles,9), rsi=calcRSI(closes,14), macd=calcMACD(closes,12,26,9);

  // ── KD ──
  {
    const {card,canvas,textEl,chipEl}=_card('KD (9) — K黃 D藍 / 超買>80 超賣<20',115);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,115);
    _grid(ctx,w,h);
    ctx.fillStyle='rgba(239,83,80,0.07)';  ctx.fillRect(0,0,   w,h*0.2);
    ctx.fillStyle='rgba(38,166,154,0.07)'; ctx.fillRect(0,h*0.8,w,h*0.2);
    _hlineY(ctx,h*0.2,w,'rgba(239,83,80,0.4)');
    _hlineY(ctx,h*0.5,w,'rgba(255,255,255,0.1)');
    _hlineY(ctx,h*0.8,w,'rgba(38,166,154,0.4)');
    ctx.font='10px sans-serif'; ctx.textAlign='left'; ctx.fillStyle=C_MUTED;
    ctx.fillText('80',2,h*0.2-2); ctx.fillText('20',2,h*0.8-2);
    _line(ctx,kd.k,w,h,0,100,C_AMBER,1.5);
    _line(ctx,kd.d,w,h,0,100,C_BLUE, 1.5);
    _legend(ctx,w,[{label:`K ${_last(kd.k)?.toFixed(1)}`,color:C_AMBER},{label:`D ${_last(kd.d)?.toFixed(1)}`,color:C_BLUE}]);

    const lk=_last(kd.k),ld=_last(kd.d);
    if(lk!=null&&ld!=null){
      let cross='';
      for(let i=kd.k.length-1;i>=Math.max(1,kd.k.length-5);i--){
        const pd=kd.k[i-1]-kd.d[i-1],cd=kd.k[i]-kd.d[i];
        if(pd<0&&cd>=0){cross='golden';break;}
        if(pd>0&&cd<=0){cross='death';break;}
      }
      const dull=(lk>80||lk<20)&&Math.abs(lk-ld)<3;
      let tone,chip,read;
      if(cross==='golden'){tone='bull';chip='近期黃金交叉';read='K 線上穿 D 線，短線轉強訊號。';}
      else if(cross==='death'){tone='bear';chip='近期死亡交叉';read='K 線下穿 D 線，短線轉弱訊號。';}
      else if(lk>80){tone='warn';chip='超買（>80）';read='KD 進入超買區，短線偏熱，留意拉回。';}
      else if(lk<20){tone='bull';chip='超賣（<20）';read='KD 進入超賣區，反彈機率提升。';}
      else{tone=lk>ld?'bull':'bear';chip=lk>ld?'K 在 D 上（偏多）':'K 在 D 下（偏弱）';read='KD 在中性區，順 K/D 相對位置觀察。';}
      if(dull)read+=' 高/低檔鈍化中，訊號鈍化勿過度解讀。';
      _chip(chipEl,chip,tone);
      textEl.innerHTML=_txt2([
        {k:'K',v:lk.toFixed(1),c:lk>ld?C_UP:C_DOWN},
        {k:'D',v:ld.toFixed(1)},
        {k:'區間',v:lk>80?'超買':lk<20?'超賣':'中性'},
      ],read);
    }
  }

  // ── RSI ──
  {
    const {card,canvas,textEl,chipEl}=_card('RSI (14) — 超買>70 / 超賣<30',115);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,115);
    _grid(ctx,w,h);
    ctx.fillStyle='rgba(239,83,80,0.07)';  ctx.fillRect(0,0,   w,h*0.3);
    ctx.fillStyle='rgba(38,166,154,0.07)'; ctx.fillRect(0,h*0.7,w,h*0.3);
    _hlineY(ctx,h*0.3,w,'rgba(239,83,80,0.4)');
    _hlineY(ctx,h*0.5,w,'rgba(255,255,255,0.15)');
    _hlineY(ctx,h*0.7,w,'rgba(38,166,154,0.4)');
    ctx.font='10px sans-serif'; ctx.textAlign='left'; ctx.fillStyle=C_MUTED;
    ctx.fillText('70',2,h*0.3-2); ctx.fillText('50',2,h*0.5-2); ctx.fillText('30',2,h*0.7-2);
    _line(ctx,rsi,w,h,0,100,C_PURP,1.8);
    _labelRight(ctx,`RSI ${_last(rsi)?.toFixed(1)}`,C_PURP,w);

    const lr=_last(rsi);
    if(lr!=null){
      let tone,chip,read;
      if(lr>70){tone='warn';chip='超買（>70）';read='RSI 進入超買區，強勢但短線高點風險升高，追價設好停利。';}
      else if(lr<30){tone='bull';chip='超賣（<30）';read='RSI 進入超賣區，反彈機率增加，可留意但需配合止跌訊號。';}
      else if(lr>50){tone='bull';chip='中性偏強';read='RSI 在 50 上方，多方力道占優，回測 50 不破續偏多。';}
      else{tone='bear';chip='中性偏弱';read='RSI 在 50 下方，空方力道占優，反彈受 50 壓制偏弱。';}
      _chip(chipEl,chip,tone);
      textEl.innerHTML=_txt2([
        {k:'RSI',v:lr.toFixed(1),c:lr>70?C_AMBER:lr<30?C_DOWN:lr>50?C_UP:C_DOWN},
        {k:'超買線',v:'70'},
        {k:'超賣線',v:'30'},
      ],read);
    }
  }

  // ── MACD ──
  {
    const {card,canvas,textEl,chipEl}=_card('MACD (12,26,9) — 正柱紅（多）負柱綠（空）',145);
    body.appendChild(card);
    const {ctx,w,h}=_size(canvas,145);
    const nn=macd.hist.length;
    const [mn,mx]=_mmMulti(macd.dif,macd.sigLine,macd.hist);
    const sp=mx-mn||1;
    _grid(ctx,w,h);
    const y0=h-((0-mn)/sp)*h;
    _hlineY(ctx,y0,w,'rgba(255,255,255,0.2)',[]);

    const bw=Math.max(1,w/nn-0.5);
    macd.hist.forEach((v,i)=>{
      if(v==null)return;
      const x=(i/(nn-1))*w, y=h-((v-mn)/sp)*h;
      ctx.fillStyle=v>=0?'rgba(239,83,80,0.75)':'rgba(38,166,154,0.75)';
      v>=0?ctx.fillRect(x-bw/2,y,bw,y0-y):ctx.fillRect(x-bw/2,y0,bw,y-y0);
    });
    _line(ctx,macd.dif,    w,h,mn,mx,C_AMBER,1.5);
    _line(ctx,macd.sigLine,w,h,mn,mx,C_BLUE, 1.5);
    _legend(ctx,w,[{label:`DIF ${_last(macd.dif)?.toFixed(2)}`,color:C_AMBER},{label:`SIG ${_last(macd.sigLine)?.toFixed(2)}`,color:C_BLUE}]);

    const ld=_last(macd.dif),ls=_last(macd.sigLine),lh=_last(macd.hist);
    if(ld!=null&&ls!=null){
      let cross='';
      for(let i=macd.dif.length-1;i>=Math.max(1,macd.dif.length-5);i--){
        const pd=macd.dif[i-1]-macd.sigLine[i-1],cd=macd.dif[i]-macd.sigLine[i];
        if(pd<0&&cd>=0){cross='golden';break;}
        if(pd>0&&cd<=0){cross='death';break;}
      }
      const above=ld>0;
      let tone,chip;
      if(cross==='golden'){tone='bull';chip='黃金交叉'+(above?'（零軸上）':'');}
      else if(cross==='death'){tone='bear';chip='死亡交叉'+(above?'':'（零軸下）');}
      else if(ld>ls){tone='bull';chip=above?'多頭區・DIF 在上':'零軸下偏多';}
      else{tone='bear';chip=above?'零軸上轉弱':'空頭區・DIF 在下';}
      _chip(chipEl,chip,tone);
      const read=`${above?'DIF 在零軸上方（多頭能量）':'DIF 在零軸下方（空頭能量）'}。${cross==='golden'?'剛黃金交叉、動能轉強':cross==='death'?'剛死亡交叉、動能轉弱':ld>ls?'DIF 在 Signal 上、偏多':'DIF 在 Signal 下、偏空'}。柱狀${lh>=0?'轉紅放大為加分':'翻綠縮短為減分'}。`;
      textEl.innerHTML=_txt2([
        {k:'DIF',v:ld.toFixed(2),c:ld>ls?C_UP:C_DOWN},
        {k:'Signal',v:ls.toFixed(2)},
        {k:'柱狀',v:(lh>=0?'+':'')+(lh!=null?lh.toFixed(2):'—'),c:lh>=0?C_UP:C_DOWN},
      ],read);
    }
  }
}

// ============================================================================
// 共用工具
// ============================================================================

function _card(title,canvasH){
  const card=document.createElement('div');
  card.className='ca-ind-card';
  card.innerHTML=`<div class="ca-ind-head"><span class="ca-ind-title">${title}</span><span class="ca-ind-chip" hidden></span></div><canvas class="ca-ind-canvas" height="${canvasH}"></canvas><div class="ca-ind-text"></div>`;
  return {card,canvas:card.querySelector('canvas'),textEl:card.querySelector('.ca-ind-text'),chipEl:card.querySelector('.ca-ind-chip')};
}

function _size(canvas,height){
  const dpr=window.devicePixelRatio||1;
  const w=(canvas.parentElement?.clientWidth||300)-28;
  canvas.style.width=w+'px'; canvas.style.height=height+'px';
  canvas.width=Math.round(w*dpr); canvas.height=Math.round(height*dpr);
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  return {ctx,w,h:height};
}

function _grid(ctx,w,h,lines=4){
  ctx.fillStyle=C_BG; ctx.fillRect(0,0,w,h);
  ctx.strokeStyle=C_GRID; ctx.lineWidth=0.5;
  for(let i=1;i<=lines;i++){const y=h/(lines+1)*i; ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
}

function _line(ctx,series,w,h,mn,mx,color,lw=1.5){
  const n=series.length,span=mx-mn||1;
  ctx.strokeStyle=color; ctx.lineWidth=lw; ctx.beginPath();
  let s=false;
  series.forEach((v,i)=>{if(v==null)return;const x=(i/(n-1))*w,y=h-((v-mn)/span)*h;s?(ctx.lineTo(x,y)):(ctx.moveTo(x,y),s=true);});
  ctx.stroke();
}

function _band(ctx,upper,lower,w,h,mn,mx,fill,fill2){
  const n=upper.length,span=mx-mn||1;
  if(fill2){const g=ctx.createLinearGradient(0,0,0,h);g.addColorStop(0,fill);g.addColorStop(1,fill2);ctx.fillStyle=g;}else{ctx.fillStyle=fill;}
  ctx.beginPath(); let s=false;
  upper.forEach((v,i)=>{if(v==null)return;const x=(i/(n-1))*w,y=h-((v-mn)/span)*h;s?ctx.lineTo(x,y):(ctx.moveTo(x,y),s=true);});
  for(let i=lower.length-1;i>=0;i--){const v=lower[i];if(v==null)continue;ctx.lineTo((i/(n-1))*w,h-((v-mn)/span)*h);}
  ctx.closePath(); ctx.fill();
}

function _hlineY(ctx,y,w,color,dash=[4,4]){
  ctx.strokeStyle=color; ctx.lineWidth=0.7; ctx.setLineDash(dash);
  ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke(); ctx.setLineDash([]);
}

function _legend(ctx,w,items){
  ctx.font='600 11px sans-serif'; ctx.textAlign='right';
  let x=w-2;
  [...items].reverse().forEach(it=>{ctx.fillStyle=it.color;const tw=ctx.measureText(it.label).width;ctx.fillText(it.label,x,13);x-=tw+10;});
}

function _labelRight(ctx,text,color,w){
  ctx.font='600 11px sans-serif'; ctx.fillStyle=color; ctx.textAlign='right'; ctx.fillText(text,w-2,13);
}

function _last(arr){for(let i=arr.length-1;i>=0;i--)if(arr[i]!=null)return arr[i];return null;}

function _mm(series,pad=0.06){
  let mn=Infinity,mx=-Infinity;
  series.forEach(v=>{if(v==null)return;mn=Math.min(mn,v);mx=Math.max(mx,v);});
  if(!isFinite(mn))return[0,100];
  const p=(mx-mn)*pad; return[mn-p,mx+p];
}

function _mmMulti(...lists){
  let mn=Infinity,mx=-Infinity;
  lists.forEach(s=>(s||[]).forEach(v=>{if(v==null)return;mn=Math.min(mn,v);mx=Math.max(mx,v);}));
  if(!isFinite(mn))return[0,100];
  const p=(mx-mn)*0.06;return[mn-p,mx+p];
}

function _txt(items){
  return items.map(it=>`
    <div class="ca-ind-row">
      <span class="ca-ind-icon">${it.icon}</span>
      <div class="ca-ind-body">
        <span class="ca-ind-name">${it.title}</span>
        <span class="ca-ind-desc">${it.body||'—'}</span>
      </div>
    </div>`).join('');
}

function _chip(el,label,tone){
  if(!el)return;
  const col=tone==='bull'?C_UP:tone==='bear'?C_DOWN:tone==='warn'?C_AMBER:'#9aa3af';
  el.textContent=label;
  el.style.color=col;
  el.style.background=col+'22';
  el.style.borderColor=col+'66';
  el.hidden=false;
}

function _txt2(stats,read){
  const s=(stats&&stats.length)
    ?`<div class="ca-ind-stats">${stats.map(x=>`<div class="ca-ind-stat"><span class="ca-ind-stat-k">${x.k}</span><span class="ca-ind-stat-v"${x.c?` style="color:${x.c}"`:''}>${x.v}</span></div>`).join('')}</div>`
    :'';
  const r=read?`<div class="ca-ind-read">${read}</div>`:'';
  return s+r;
}

function _hbar(val,col){
  if(val==null)return`<span class="cao-na">資料不足</span>`;
  return`<div class="cao-hbar-row"><div class="cao-hbar-track"><div class="cao-hbar-fill" style="width:${val}%;background:${col}"></div></div><span class="cao-hbar-num" style="color:${col}">${val}</span></div>`;
}

function _stars(s){const n=Math.max(0,Math.min(3,+(s??0)||0));return'★'.repeat(n)+'☆'.repeat(3-n);}
