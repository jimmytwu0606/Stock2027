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
import { loadStockInfo, saveStockInfo, deleteStockInfo } from './db.js';
import { fsGetShared } from './firebase.js';
import { calcHealthWithSignals } from './stock-tabs.js';
import { calcHealthLong } from './health.js';
import { fetchHistory, fetchFundamentalsFromFirestore, toYahooSymbol, fetchVerifyData } from './api.js';

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

// ── 6 個 Tab 定義（觀點排第一）──
const TABS = [
  { icon: '👁', label: '觀點'  },
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
    window.__lastAnalysisResult = _lastResult;  // Modal 重繪用
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
    if (tab === 0) {
      _tabPerspective(body, r, candles).then(() => {
        // 引導按鈕：跳補充資訊 tab（矛盾偵測用）
        body.querySelector('.pv-goto-stockinfo')?.addEventListener('click', () => {
          document.querySelector('.stock-tab[data-stock-tab="stockinfo"]')?.click();
        });
        // 複製 Prompt 按鈕
        body.querySelectorAll('.si-copy-prompt-btn').forEach(btn => {
          btn.addEventListener('click', () => _siCopyPrompt(btn.dataset.siCode));
        });
        // 開啟補充資訊 → Modal
        body.querySelectorAll('.si-open-tab-btn').forEach(btn => {
          btn.addEventListener('click', () => _siShowModal(window.__stockDashCode ?? ''));
        });
        // 即時比對按鈕
        body.querySelectorAll('.si-verify-now-btn').forEach(btn => {
          btn.addEventListener('click', () => _siRunLiveVerify(btn, btn.dataset.code));
        });
      }).catch(e => console.warn('[perspective]', e));
      return;
    }
    if (tab === 1) _tabOverview(body, r, candles);
    if (tab === 2) _tabEMA(body, candles);
    if (tab === 3) _tabQuant(body, candles, r);
    if (tab === 4) _tabMomentum(body, candles);
    if (tab === 5) _tabOscillator(body, candles);
  });
}

// ============================================================================
// Tab 0 — 觀點（Strategy × 診斷 × 決策 × 燈燈）
// ============================================================================

// 觀點卡背景預拉基本面（不阻塞渲染，拉到後重新渲染）
function _prefetchFundForPerspective(code, body, r, candles) {
  // 避免重複觸發
  if (window.__fundFetchingFor === code) return;
  window.__fundFetchingFor = code;

  // 監聽 fundamentalsUpdated 事件（stock-tabs.js 載完後會 dispatch）
  const handler = (e) => {
    if (e.detail?.code !== code) return;
    document.removeEventListener('fundamentalsUpdated', handler);
    window.__fundFetchingFor = null;
    // 確認還在觀點 tab 才重繪
    const activeTab = document.querySelector('.ca-tab.active');
    if (activeTab?.dataset?.tab === '0') {
      _tabPerspective(body, r, candles);
    }
  };
  document.addEventListener('fundamentalsUpdated', handler);

  // 10 秒後自動清除監聽（防 leak）
  setTimeout(() => {
    document.removeEventListener('fundamentalsUpdated', handler);
    window.__fundFetchingFor = null;
  }, 10000);

  // 觸發基本面載入（借用 stock-tabs 的 ensureFundamentals）
  window.__ensureFundamentals?.(code).catch(() => {});
}

// ============================================================================
// 財報摘要卡（觀點卡專用）
// ============================================================================
function _buildFundSummaryCard(fund, chips, C_UP, C_DOWN, C_AMBER, C_MUTED) {
  if (!fund) return '';

  const _pct  = v => v != null ? (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%' : '—';
  const _num  = v => v != null ? Number(v).toFixed(2) : '—';
  const _col  = v => v == null ? '' : v > 0 ? C_UP : v < 0 ? C_DOWN : C_MUTED;
  const _colM = v => v == null ? '' : v > 20 ? C_UP : v > 10 ? C_AMBER : C_DOWN;

  // ── 取值 ──
  const eps        = fund.eps;
  const epsGrowth  = fund.earningsGrowth;
  const revGrowth  = fund.revenueGrowth;
  const pe         = fund.pe;
  const pb         = fund.pbRatio;
  const divYield   = fund.dividendYield;

  // 三率：優先從 _marginSeries 取
  const ms0        = fund._marginSeries?.[0];
  const grossM     = ms0?.grossMargin    ?? null;
  const opM        = ms0?.operatingMargin ?? null;
  const netMraw    = ms0?.netMargin       ?? null;
  const netM       = netMraw != null ? netMraw : (fund.profitMargin != null ? fund.profitMargin * 100 : null);

  // 三率趨勢（和上季比）
  const ms1        = fund._marginSeries?.[1];
  const grossTrend = (grossM != null && ms1?.grossMargin != null) ? grossM - ms1.grossMargin : null;

  // PEG
  const peg = (pe != null && epsGrowth != null && epsGrowth > 0)
    ? (pe / (epsGrowth * 100)).toFixed(2) : null;

  // ── 成長動能條列（rule-based）──
  const upsides = [];
  if (epsGrowth != null && epsGrowth > 0.1)
    upsides.push(`EPS 年增 ${(epsGrowth*100).toFixed(0)}%，獲利加速擴張`);
  else if (epsGrowth != null && epsGrowth > 0)
    upsides.push(`EPS 年增 ${(epsGrowth*100).toFixed(1)}%，獲利持續成長`);

  if (revGrowth != null && revGrowth > 0.1)
    upsides.push(`營收年增 ${(revGrowth*100).toFixed(0)}%，業務擴張動能強勁`);
  else if (revGrowth != null && revGrowth > 0)
    upsides.push(`營收年增 ${(revGrowth*100).toFixed(1)}%，成長軌道穩健`);

  if (grossM != null && grossM > 40)
    upsides.push(`毛利率 ${grossM.toFixed(1)}%，競爭護城河深`);
  else if (grossM != null && grossM > 25)
    upsides.push(`毛利率 ${grossM.toFixed(1)}%，獲利品質良好`);

  if (grossTrend != null && grossTrend > 1)
    upsides.push(`毛利率較上季提升 ${grossTrend.toFixed(1)} 個百分點，成本控制改善`);

  if (peg != null && parseFloat(peg) < 0.5)
    upsides.push(`PEG ${peg}，用低估值買高成長，CP 值高`);
  else if (peg != null && parseFloat(peg) < 1)
    upsides.push(`PEG ${peg}，成長速度超過本益比，估值合理`);

  if (chips?.foreignNet > 2000)
    upsides.push(`外資買超 ${Math.round(chips.foreignNet/1000)} 千張，法人認同基本面`);

  if (divYield != null && divYield > 0.04)
    upsides.push(`殖利率 ${(divYield*100).toFixed(1)}%，股息收益具吸引力`);

  // ── 風險因素條列（rule-based）──
  const risks = [];
  if (epsGrowth != null && epsGrowth < 0)
    risks.push(`EPS 年衰退 ${Math.abs(epsGrowth*100).toFixed(1)}%，獲利能力下滑`);

  if (revGrowth != null && revGrowth < 0)
    risks.push(`營收年衰退 ${Math.abs(revGrowth*100).toFixed(1)}%，業務動能轉弱`);

  if (grossTrend != null && grossTrend < -2)
    risks.push(`毛利率較上季下滑 ${Math.abs(grossTrend).toFixed(1)} 個百分點，成本壓力增加`);

  if (pe != null && pe > 30 && (epsGrowth == null || epsGrowth < 0.15))
    risks.push(`PE ${pe.toFixed(1)} 倍偏高，若獲利成長不及預期估值壓力大`);

  if (pe != null && pe > 50)
    risks.push(`PE ${pe.toFixed(1)} 倍，高估值需持續高成長支撐，修正風險高`);

  if (netM != null && netM < 5)
    risks.push(`淨利率 ${netM.toFixed(1)}% 偏低，獲利品質有待改善`);

  if (divYield != null && divYield < 0.005)
    risks.push(`殖利率 ${(divYield*100).toFixed(1)}%，不適合股息投資策略`);

  if (chips?.foreignNet < -2000)
    risks.push(`外資賣超 ${Math.abs(Math.round(chips.foreignNet/1000))} 千張，法人持續出清`);

  if (upsides.length === 0 && risks.length === 0) return '';

  // ── 燈燈結論句（rule-based，不依賴台詞庫）──
  let dengConclusion = '';
  let verdictLabel = '', verdictClass = '';

  const bullCount = upsides.length;
  const bearCount = risks.length;

  if (epsGrowth != null && epsGrowth > 0.3 && peg != null && parseFloat(peg) < 0.8) {
    dengConclusion = `EPS 年增 ${(epsGrowth*100).toFixed(0)}%、PEG ${peg}——用這個估值買這個成長速度，燈燈覺得市場還沒充分定價。風險只有一個：這個成長速度能不能持續。`;
    verdictLabel = '基本面優質'; verdictClass = 'bull';
  } else if (epsGrowth != null && epsGrowth > 0.15 && grossM != null && grossM > 30) {
    dengConclusion = `獲利在成長、毛利率撐著——公司本身的體質不錯。技術面如果站多頭，基本面是這波的底氣，喵。`;
    verdictLabel = '基本面穩健'; verdictClass = 'bull';
  } else if (epsGrowth != null && epsGrowth > 0 && bullCount > bearCount) {
    dengConclusion = `獲利小幅成長，算是及格。動能不算強，但也沒有明顯破口。這種公司適合等技術面訊號出來再進，不用搶。`;
    verdictLabel = '基本面普通'; verdictClass = 'watch';
  } else if (epsGrowth != null && epsGrowth < -0.1) {
    dengConclusion = `獲利在縮水，財報說話很誠實。技術面就算有反彈，燈燈也會擔心這是逃命波，喵。`;
    verdictLabel = '基本面偏弱'; verdictClass = 'bear';
  } else if (bearCount > bullCount) {
    dengConclusion = `風險點比成長動能多，財報整體偏保守。燈燈建議基本面改善之前，倉位輕一點。`;
    verdictLabel = '基本面保守'; verdictClass = 'watch';
  } else {
    dengConclusion = `財報數字平穩，沒有特別亮眼，也沒有明顯警訊。這種情況燈燈通常以技術面為主要判斷依據。`;
    verdictLabel = '基本面中性'; verdictClass = 'watch';
  }

  const verdictStyle = verdictClass === 'bull'
    ? `background:rgba(239,83,80,.12);color:${C_UP};border:0.5px solid rgba(239,83,80,.3)`
    : verdictClass === 'bear'
    ? `background:rgba(38,166,154,.12);color:${C_DOWN};border:0.5px solid rgba(38,166,154,.3)`
    : `background:rgba(245,158,11,.12);color:${C_AMBER};border:0.5px solid rgba(245,158,11,.3)`;

  // ── 指標格子 ──
  const _metricHtml = (label, val, color) => `
    <div style="background:rgba(255,255,255,.03);border-radius:6px;padding:7px 9px;border:0.5px solid rgba(255,255,255,.06)">
      <div style="font-size:11px;color:${C_MUTED};margin-bottom:3px">${label}</div>
      <div style="font-size:16px;font-weight:500;color:${color || '#e8eaed'}">${val}</div>
    </div>`;

  const _itemHtml = (text, color) => `
    <div style="display:flex;align-items:flex-start;gap:7px;font-size:13px;color:#c9d1d9;line-height:1.45;margin-bottom:5px">
      <div style="width:5px;height:5px;border-radius:50%;background:${color};flex-shrink:0;margin-top:5px"></div>
      ${text}
    </div>`;

  return `<div class="cao-card">
    <div style="font-size:11px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase;margin-bottom:10px">財報摘要</div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:10px">
      ${_metricHtml('EPS（最新季）',   eps != null ? _num(eps) : '—',               eps != null && eps > 0 ? C_UP : C_DOWN)}
      ${_metricHtml('EPS 年增率',      _pct(epsGrowth),                              _col(epsGrowth))}
      ${_metricHtml('營收年增率',      _pct(revGrowth),                              _col(revGrowth))}
      ${_metricHtml('毛利率',          grossM != null ? grossM.toFixed(1) + '%' : '—', _colM(grossM))}
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:12px">
      ${_metricHtml('本益比（PE）',    pe != null ? pe.toFixed(1) : '—',             pe != null && pe < 20 ? C_UP : pe > 40 ? C_DOWN : C_AMBER)}
      ${_metricHtml('淨利率',          netM != null ? netM.toFixed(1) + '%' : '—',   _colM(netM))}
      ${_metricHtml('股息殖利率',      divYield != null ? (divYield*100).toFixed(1) + '%' : '—', divYield != null && divYield > 0.04 ? C_UP : C_MUTED)}
      ${_metricHtml('PEG',             peg ?? '—',                                   peg != null && parseFloat(peg) < 1 ? C_UP : peg != null && parseFloat(peg) < 2 ? C_AMBER : C_DOWN)}
    </div>

    <div style="height:0.5px;background:rgba(255,255,255,.07);margin-bottom:10px"></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      ${upsides.length ? `<div>
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:7px">
          <div style="width:6px;height:6px;border-radius:50%;background:${C_UP}"></div>
          <div style="font-size:12px;font-weight:500;color:${C_UP}">成長動能</div>
        </div>
        ${upsides.map(t => _itemHtml(t, C_UP)).join('')}
      </div>` : '<div></div>'}
      ${risks.length ? `<div>
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:7px">
          <div style="width:6px;height:6px;border-radius:50%;background:${C_DOWN}"></div>
          <div style="font-size:12px;font-weight:500;color:${C_DOWN}">風險因素</div>
        </div>
        ${risks.map(t => _itemHtml(t, C_DOWN)).join('')}
      </div>` : '<div></div>'}
    </div>

    <div style="height:0.5px;background:rgba(255,255,255,.07);margin-bottom:10px"></div>

    <div style="display:flex;gap:10px;align-items:flex-start">
      <div style="width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.07);border:0.5px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🐱</div>
      <div style="background:rgba(255,255,255,.04);border:0.5px solid rgba(255,255,255,.08);border-radius:0 10px 10px 10px;padding:9px 12px;flex:1">
        <div style="font-size:13px;color:#e8eaed;line-height:1.65">${dengConclusion}</div>
        <div style="margin-top:7px">
          <span style="font-size:11px;font-weight:500;padding:2px 10px;border-radius:20px;${verdictStyle}">${verdictLabel}</span>
        </div>
      </div>
    </div>
  </div>`;
}

// ============================================================================
// 補充資訊區塊（整合進觀點卡）
// ============================================================================
function _buildStockInfoSection(info, autoData, code, C_UP, C_DOWN, C_AMBER, C_MUTED) {
  const hasManual = info && Object.keys(info).filter(k => k !== 'code' && k !== 'savedAt').length > 0;
  const hasAuto   = autoData?.revenue?.data?.length > 0 ||
                    autoData?.eps?.data?.length > 0 ||
                    autoData?.dividend?.data?.length > 0;
  const forward   = info?.forward;
  const hasForward = !!(forward && (forward.story || forward.consensus || forward.drivers?.length));

  if (!hasManual && !hasAuto) {
    // 無資料：只顯示 Prompt 操作區
    return `<div class="cao-card">
      <div style="font-size:11px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase;margin-bottom:10px">補充資訊</div>
      <div style="font-size:13px;color:${C_MUTED};margin-bottom:12px">尚未補充法說會、法人評等等資訊。複製 Prompt 給 AI，貼回 JSON 後匯入。</div>
      ${_siPromptArea(code, C_UP, C_AMBER, C_MUTED)}
    </div>`;
  }

  const parts = [];

  // ── 前瞻面分析（新版圖文卡）──────────────────────────────────────────────
  if (hasForward) {
    const f = forward;

    // ── verify 狀態列（顯示勘誤結果 + 過期提醒）──────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    let verifyHtml = '';
    const verifyWarnings = info?._verify?.warnings ?? [];

    // 過期偵測
    let staleMsg = '';
    if (f.updatedAt) {
      const days = Math.floor((Date.now() - new Date(f.updatedAt).getTime()) / 86400000);
      if (days > 60) {
        staleMsg = `🔴 前瞻資料已 <strong>${days} 天</strong>未更新（截止：${f.updatedAt}），市場情況可能已大幅改變`;
      } else if (days > 30) {
        staleMsg = `🟡 前瞻資料已 ${days} 天（截止：${f.updatedAt}），建議重新確認`;
      }
    } else if (f.story || f.consensus) {
      staleMsg = `🟡 前瞻資料缺少截止日期，無法判斷新鮮度`;
    }

    // checkedAt + FinMind 比對值 + 歷史 warnings
    const checkedAt     = info?._verify?.checkedAt;
    const finmindValues = info?._verify?.finmind;
    const hasVerifyWarnings = verifyWarnings.length > 0;

    // FinMind 比對值小字
    let finmindRow = '';
    if (finmindValues) {
      const fmItems = [];
      if (finmindValues.pbRatio != null)      fmItems.push(`PB ${finmindValues.pbRatio}`);
      if (finmindValues.dividendYield != null) fmItems.push(`殖利率 ${finmindValues.dividendYield}%`);
      if (finmindValues.pe != null)            fmItems.push(`PE ${finmindValues.pe}`);
      if (fmItems.length) finmindRow = `<div style="font-size:10px;color:${C_MUTED};margin-top:3px">FinMind 實際值：${fmItems.join(' · ')}</div>`;
    }

    if (staleMsg || hasVerifyWarnings || checkedAt) {
      const staleRow  = staleMsg ? `<div style="margin-bottom:${hasVerifyWarnings?'5px':'0'}">${staleMsg}</div>` : '';
      const warnRows  = hasVerifyWarnings
        ? verifyWarnings.map(w => `<div>⚠️ ${w}</div>`).join('')
        : '';
      const okRow     = !staleMsg && !hasVerifyWarnings && checkedAt
        ? `<span style="color:#26a69a">✅ 上次匯入 FinMind 驗證通過</span>` : '';
      const checkedRow = checkedAt ? `<div style="font-size:10px;color:${C_MUTED};margin-top:4px">驗證日：${checkedAt} · AI 推理，僅供參考</div>` : '';

      const bannerColor = staleMsg?.startsWith('🔴') ? 'rgba(239,83,80,.1)'
        : (staleMsg || hasVerifyWarnings) ? 'rgba(245,158,11,.1)' : 'rgba(38,166,154,.08)';
      const borderColor = staleMsg?.startsWith('🔴') ? 'rgba(239,83,80,.3)'
        : (staleMsg || hasVerifyWarnings) ? 'rgba(245,158,11,.3)' : 'rgba(38,166,154,.25)';
      const textColor   = staleMsg?.startsWith('🔴') ? '#ef5350'
        : (staleMsg || hasVerifyWarnings) ? '#f59e0b' : '#26a69a';

      verifyHtml = `
        <div style="background:${bannerColor};border:0.5px solid ${borderColor};border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:${textColor};line-height:1.6">
          ${staleRow}${warnRows}${okRow}${finmindRow}${checkedRow}
          ${staleMsg ? `<button class="si-copy-prompt-btn" data-si-code="${code}" style="margin-top:6px;padding:3px 10px;border-radius:4px;background:rgba(255,255,255,.08);border:0.5px solid rgba(255,255,255,.15);color:#e8eaed;font-size:11px;cursor:pointer">📋 重新更新 Prompt</button>` : ''}
        </div>`;
    }
    // 計算 EPS 成長率
    // 近四季 EPS TTM：從 autoData.eps 最新 4 季加總，fallback 單季 * 4
    const _epsRows = autoData?.eps?.data
      ? [...autoData.eps.data].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4)
      : [];
    const _ttmEps = _epsRows.length === 4
      ? _epsRows.reduce((s, r) => s + (r.eps ?? 0), 0)
      : _epsRows.length > 0
        ? _epsRows.reduce((s, r) => s + (r.eps ?? 0), 0)
        : null;
    const curEps  = _ttmEps ?? (window.__lastFundamentals?.eps ? window.__lastFundamentals.eps * 4 : null);
    const nextPct = (curEps && f.epsEstNext)  ? ((f.epsEstNext  / curEps - 1) * 100).toFixed(0) : null;
    const yr2Pct  = (curEps && f.epsEstYear2) ? ((f.epsEstYear2 / curEps - 1) * 100).toFixed(0) : null;
    const epsLabel = _epsRows.length >= 4 ? '近四季 EPS（TTM）' : _epsRows.length > 0 ? `近${_epsRows.length}季 EPS 合計` : '近四季 EPS（實績）';

    const epsRow = (f.epsEstNext || f.epsEstYear2) ? `
      <div style="display:flex;gap:8px;margin-bottom:14px;align-items:stretch">
        ${curEps ? `<div style="flex:1;background:rgba(255,255,255,.03);border-radius:8px;padding:10px 12px;border:0.5px solid rgba(255,255,255,.07)">
          <div style="font-size:11px;color:${C_MUTED};margin-bottom:4px">${epsLabel}</div>
          <div style="font-size:20px;font-weight:500;color:#e8eaed">${curEps.toFixed(1)}</div>
          <div style="font-size:11px;color:${C_MUTED};margin-top:3px">歷史基準</div>
        </div>
        <div style="display:flex;align-items:center;justify-content:center;color:${C_MUTED};font-size:18px;flex-shrink:0;padding:0 4px">→</div>` : ''}
        ${f.epsEstNext ? `<div style="flex:1;background:rgba(239,83,80,.06);border-radius:8px;padding:10px 12px;border:0.5px solid rgba(239,83,80,.2)">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <div style="font-size:11px;color:${C_MUTED}">法人預估（明年）</div>
            ${f.epsEstNextConf ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${f.epsEstNextConf==='high'?'rgba(38,166,154,.2)':f.epsEstNextConf==='mid'?'rgba(245,158,11,.2)':'rgba(239,83,80,.15)'};color:${f.epsEstNextConf==='high'?'#26a69a':f.epsEstNextConf==='mid'?'#f59e0b':'#ef5350'}">${f.epsEstNextConf==='high'?'高信心':f.epsEstNextConf==='mid'?'中信心':'低信心'}</span>` : ''}
          </div>
          <div style="font-size:20px;font-weight:500;color:${C_UP}">${f.epsEstNext}</div>
          ${nextPct ? `<div style="font-size:11px;color:${C_UP};margin-top:3px">+${nextPct}%</div>` : ''}
        </div>` : ''}
        ${f.epsEstNext && f.epsEstYear2 ? `<div style="display:flex;align-items:center;justify-content:center;color:${C_MUTED};font-size:18px;flex-shrink:0;padding:0 4px">→</div>` : ''}
        ${f.epsEstYear2 ? `<div style="flex:1;background:rgba(239,83,80,.1);border-radius:8px;padding:10px 12px;border:0.5px solid rgba(239,83,80,.3)">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <div style="font-size:11px;color:${C_MUTED}">法人預估（後年）</div>
            ${f.epsEstYear2Conf ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${f.epsEstYear2Conf==='high'?'rgba(38,166,154,.2)':f.epsEstYear2Conf==='mid'?'rgba(245,158,11,.2)':'rgba(239,83,80,.15)'};color:${f.epsEstYear2Conf==='high'?'#26a69a':f.epsEstYear2Conf==='mid'?'#f59e0b':'#ef5350'}">${f.epsEstYear2Conf==='high'?'高信心':f.epsEstYear2Conf==='mid'?'中信心':'低信心'}</span>` : ''}
          </div>
          <div style="font-size:20px;font-weight:500;color:${C_UP}">${f.epsEstYear2}</div>
          ${yr2Pct ? `<div style="font-size:11px;color:${C_UP};margin-top:3px">+${yr2Pct}%</div>` : ''}
        </div>` : ''}
      </div>` : '';

    const driversHtml = (f.drivers || []).map(d =>
      `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:7px;font-size:13px;color:#c9d1d9;line-height:1.5">
        <div style="width:5px;height:5px;border-radius:50%;background:${C_UP};flex-shrink:0;margin-top:6px"></div>${d}
      </div>`
    ).join('');

    const risksHtml = (f.risks || []).map(r =>
      `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:7px;font-size:13px;color:#c9d1d9;line-height:1.5">
        <div style="width:5px;height:5px;border-radius:50%;background:${C_DOWN};flex-shrink:0;margin-top:6px"></div>${r}
      </div>`
    ).join('');

    parts.push(`
      ${verifyHtml}
      <div style="background:rgba(129,140,248,.06);border:0.5px solid rgba(129,140,248,.25);border-radius:8px;padding:14px 16px;margin-bottom:10px">
        <div style="font-size:11px;color:#818cf8;font-weight:500;margin-bottom:6px">市場核心押注</div>
        <div style="font-size:15px;font-weight:500;color:#e8eaed;line-height:1.6">${f.story}</div>
      </div>
      ${epsRow}
      ${driversHtml || risksHtml ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:12px;font-weight:500;color:${C_UP};margin-bottom:8px">成長動能</div>
          ${driversHtml}
        </div>
        <div>
          <div style="font-size:12px;font-weight:500;color:${C_DOWN};margin-bottom:8px">主要風險</div>
          ${risksHtml}
        </div>
      </div>` : ''}
      ${f.moat ? `<div style="background:rgba(251,191,36,.05);border:0.5px solid rgba(251,191,36,.2);border-radius:6px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:8px">
        <span style="font-size:14px;flex-shrink:0">🏰</span>
        <div>
          <div style="font-size:11px;color:#fbbf24;font-weight:500;margin-bottom:3px">護城河</div>
          <div style="font-size:13px;color:#e8eaed;line-height:1.5">${f.moat}</div>
        </div>
      </div>` : ''}
      ${(f.catalysts?.length) ? `<div style="margin-bottom:10px">
        <div style="font-size:11px;color:${C_AMBER};font-weight:500;margin-bottom:6px">⚡ 近期催化劑</div>
        ${f.catalysts.map(c => `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;font-size:12px;color:#c9d1d9">
          <div style="width:4px;height:4px;border-radius:50%;background:${C_AMBER};flex-shrink:0;margin-top:5px"></div>${c}
        </div>`).join('')}
      </div>` : ''}
      ${f.riskScore != null ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <div style="font-size:11px;color:${C_MUTED}">綜合風險</div>
        <div style="display:flex;gap:3px">
          ${[1,2,3,4,5].map(i => `<div style="width:18px;height:6px;border-radius:2px;background:${i <= f.riskScore ? (f.riskScore<=2?'#26a69a':f.riskScore<=3?'#f59e0b':'#ef5350') : 'rgba(255,255,255,.1)'}"></div>`).join('')}
        </div>
        <div style="font-size:11px;color:${f.riskScore<=2?'#26a69a':f.riskScore<=3?'#f59e0b':'#ef5350'}">${f.riskScore<=2?'偏低':f.riskScore<=3?'中等':f.riskScore<=4?'偏高':'高風險'}</div>
      </div>` : ''}
      ${f.consensus ? `<div style="background:rgba(255,255,255,.03);border:0.5px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:0.5px solid rgba(255,255,255,.07)">
          <div style="width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;font-size:14px">🐱</div>
          <div style="font-size:12px;font-weight:500;color:#e8eaed">燈燈整合觀點</div>
          <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(129,140,248,.12);color:#818cf8;border:0.5px solid rgba(129,140,248,.3);margin-left:auto">🔭 前瞻資料</span>
        </div>
        <div style="padding:12px 14px">
          <div style="font-size:13px;color:#e8eaed;line-height:1.7">${f.consensus}</div>
          ${f.updatedAt ? `<div style="font-size:11px;color:${C_MUTED};margin-top:8px;text-align:right">資料截止：${f.updatedAt}</div>` : ''}
        </div>
      </div>` : ''}`);
  }

  // ── 法說會 + 法人評等 + 估值（手動）────────────────────────────────────
  if (info?.meetingDate || info?.analystRating || info?.targetPrice || info?.peRatio) {
    const today = new Date().toISOString().slice(0, 10);
    const metaItems = [];
    if (info.meetingDate) {
      const daysLeft = Math.round((new Date(info.meetingDate) - new Date(today)) / 86400000);
      metaItems.push(`<div style="flex:1;background:rgba(255,255,255,.03);border-radius:6px;padding:8px 10px;border:0.5px solid rgba(255,255,255,.07)">
        <div style="font-size:11px;color:${C_MUTED};margin-bottom:3px">法說會</div>
        <div style="font-size:13px;font-weight:500;color:#e8eaed">${info.meetingDate}</div>
        <div style="font-size:11px;color:${C_MUTED};margin-top:2px">${daysLeft >= 0 ? daysLeft + ' 天後' : '已過'}</div>
      </div>`);
    }
    if (info.analystRating || info.targetPrice) {
      const ratingColor = info.analystRating === '買進' ? C_UP : info.analystRating === '賣出' ? C_DOWN : C_AMBER;
      // 找 targetPrice 的 sources 來源
      const tpSrc = (info.sources || []).find(s => s.field === 'targetPrice');
      const srcLabel = info.targetPriceSrc || (tpSrc ? `${tpSrc.src}${tpSrc.date?' '+tpSrc.date.slice(5):''}` : null);
      metaItems.push(`<div style="flex:1;background:rgba(255,255,255,.03);border-radius:6px;padding:8px 10px;border:0.5px solid rgba(255,255,255,.07)">
        <div style="font-size:11px;color:${C_MUTED};margin-bottom:3px">法人評等</div>
        ${info.analystRating ? `<div style="font-size:14px;font-weight:500;color:${ratingColor}">${info.analystRating}</div>` : ''}
        ${info.targetPrice ? `<div style="font-size:12px;color:${C_MUTED};margin-top:2px">目標價 $${info.targetPrice}
          ${srcLabel ? `<span style="font-size:10px;color:${C_MUTED};opacity:.7;margin-left:4px">${srcLabel}</span>` : `<span style="font-size:10px;color:#ef5350;opacity:.8;margin-left:4px">⚠️ 來源不明</span>`}
        </div>` : ''}
      </div>`);
    }
    if (info.peRatio || info.pbRatio || info.dividendYield) {
      metaItems.push(`<div style="flex:1;background:rgba(255,255,255,.03);border-radius:6px;padding:8px 10px;border:0.5px solid rgba(255,255,255,.07)">
        <div style="font-size:11px;color:${C_MUTED};margin-bottom:3px">估值參考</div>
        ${info.peRatio       ? `<div style="font-size:12px;color:#e8eaed">PE ${info.peRatio}x</div>` : ''}
        ${info.pbRatio       ? `<div style="font-size:12px;color:#e8eaed">PB ${info.pbRatio}x</div>` : ''}
        ${info.dividendYield ? `<div style="font-size:12px;color:#e8eaed">殖利率 ${info.dividendYield}%</div>` : ''}
      </div>`);
    }
    if (metaItems.length) {
      parts.push(`<div style="display:flex;gap:8px;margin-bottom:10px">${metaItems.join('')}</div>`);
    }
  }

  // ── 月營收（autoData）────────────────────────────────────────────────────
  if (autoData?.revenue?.data?.length > 0) {
    const rows = [...autoData.revenue.data]
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const trs = rows.map(r => {
      const yc = r.yoy > 0 ? C_UP : r.yoy < 0 ? C_DOWN : '';
      const mc = r.mom > 0 ? C_UP : r.mom < 0 ? C_DOWN : '';
      const rev = r.revenue >= 1e8 ? (r.revenue/1e8).toFixed(1)+'億' : r.revenue >= 1e4 ? (r.revenue/1e4).toFixed(0)+'萬' : r.revenue;
      return `<tr style="border-bottom:0.5px solid rgba(255,255,255,.05)">
        <td style="padding:5px 6px;font-size:12px;color:#e8eaed">${r.date?.slice(0,7)??''}</td>
        <td style="padding:5px 6px;font-size:12px;color:#e8eaed;text-align:right">${rev}</td>
        <td style="padding:5px 6px;font-size:12px;color:${yc||C_MUTED};text-align:right">${r.yoy!=null?(r.yoy>0?'+':'')+r.yoy.toFixed(1)+'%':'-'}</td>
        <td style="padding:5px 6px;font-size:12px;color:${mc||C_MUTED};text-align:right">${r.mom!=null?(r.mom>0?'+':'')+r.mom.toFixed(1)+'%':'-'}</td>
      </tr>`;
    }).join('');
    parts.push(`<div style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:500;color:${C_MUTED};margin-bottom:7px">📈 月營收</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:0.5px solid rgba(255,255,255,.1)">
          <th style="padding:4px 6px;font-size:11px;color:${C_MUTED};text-align:left;font-weight:500">月份</th>
          <th style="padding:4px 6px;font-size:11px;color:${C_MUTED};text-align:right;font-weight:500">營收</th>
          <th style="padding:4px 6px;font-size:11px;color:${C_MUTED};text-align:right;font-weight:500">年增率</th>
          <th style="padding:4px 6px;font-size:11px;color:${C_MUTED};text-align:right;font-weight:500">月增率</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`);
  }

  // ── EPS（autoData）───────────────────────────────────────────────────────
  if (autoData?.eps?.data?.length > 0) {
    const rows = [...autoData.eps.data]
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    const trs = rows.map(r => {
      const c = r.eps > 0 ? C_UP : r.eps < 0 ? C_DOWN : '';
      return `<tr style="border-bottom:0.5px solid rgba(255,255,255,.05)">
        <td style="padding:5px 6px;font-size:12px;color:#e8eaed">${r.quarter??r.date?.slice(0,7)??''}</td>
        <td style="padding:5px 6px;font-size:12px;color:${c||'#e8eaed'};text-align:right;font-weight:500">${r.eps!=null?'$'+r.eps.toFixed(2):'-'}</td>
      </tr>`;
    }).join('');
    parts.push(`<div style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:500;color:${C_MUTED};margin-bottom:7px">💰 EPS（近期財報）</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:0.5px solid rgba(255,255,255,.1)">
          <th style="padding:4px 6px;font-size:11px;color:${C_MUTED};text-align:left;font-weight:500">季度</th>
          <th style="padding:4px 6px;font-size:11px;color:${C_MUTED};text-align:right;font-weight:500">EPS</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`);
  }

  // ── 備註 ─────────────────────────────────────────────────────────────────
  if (info?.note) {
    parts.push(`<div style="background:rgba(255,255,255,.03);border-radius:6px;padding:10px 12px;border:0.5px solid rgba(255,255,255,.07);font-size:13px;color:#c9d1d9;line-height:1.6;margin-bottom:10px">
      <div style="font-size:11px;color:${C_MUTED};margin-bottom:4px">📝 備註</div>
      ${info.note}
    </div>`);
  }

  // ── 資料來源表 ────────────────────────────────────────────────────────────
  if (info?.sources?.length > 0) {
    const srcRows = info.sources.map(s =>
      `<div style="display:flex;align-items:baseline;gap:6px;padding:4px 0;border-bottom:0.5px solid rgba(255,255,255,.04);font-size:11px">
        <span style="color:${C_MUTED};min-width:80px;flex-shrink:0">${s.field}</span>
        <span style="color:#c9d1d9">${s.src ?? '—'}</span>
        ${s.date ? `<span style="color:${C_MUTED};margin-left:auto">${s.date}</span>` : ''}
      </div>`
    ).join('');
    parts.push(`<div style="margin-bottom:10px">
      <div style="font-size:11px;color:${C_MUTED};font-weight:500;margin-bottom:6px">🔗 資料來源</div>
      ${srcRows}
    </div>`);
  }

  // ── Prompt 操作區 ─────────────────────────────────────────────────────────
  parts.push(_siPromptArea(code, C_UP, C_AMBER, C_MUTED));

  return `<div class="cao-card">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase">補充資訊</div>
      ${hasManual ? `<button class="si-verify-now-btn" data-code="${code}"
        style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;
               background:rgba(255,255,255,.06);border:0.5px solid rgba(255,255,255,.15);
               color:#8a8f99;font-size:11px;cursor:pointer;white-space:nowrap"
        title="與 FinMind 即時比對數字">
        <span class="si-verify-dot" style="width:6px;height:6px;border-radius:50%;background:#8a8f99;display:inline-block;flex-shrink:0"></span>
        <span>即時比對</span>
      </button>` : ''}
    </div>
    ${parts.join('')}
  </div>`;
}

// ── Prompt 操作區（共用）──────────────────────────────────────────────────
function _siPromptArea(code, C_UP, C_AMBER, C_MUTED) {
  return `<div style="border-top:0.5px solid rgba(255,255,255,.07);padding-top:10px;margin-top:4px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="font-size:12px;font-weight:500;color:${C_MUTED}">更新資料</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="si-copy-prompt-btn" data-si-code="${code}"
        style="flex:1;padding:8px 12px;border-radius:6px;background:rgba(239,83,80,.1);color:#ef5350;border:0.5px solid rgba(239,83,80,.3);font-size:13px;cursor:pointer;font-weight:500">
        📋 複製 Prompt
      </button>
      <button class="si-open-tab-btn"
        style="flex:1;padding:8px 12px;border-radius:6px;background:rgba(255,255,255,.05);color:#e8eaed;border:0.5px solid rgba(255,255,255,.1);font-size:13px;cursor:pointer">
        ↗ 開啟補充資訊
      </button>
    </div>
  </div>`;
}

// ── 複製 Prompt（觀點卡內用）──────────────────────────────────────────────
function _siCopyPrompt(code) {
  const prompt = `請提供台股 ${code} 的最新資訊，以下列 JSON 格式回覆，不確定的欄位填 null：

{
  "code": "${code}",
  "meetingDate": null,
  "analystRating": null,
  "targetPrice": null,
  "targetPriceSrc": null,
  "peRatio": null,
  "pbRatio": null,
  "dividendYield": null,
  "note": "",
  "forward": {
    "story": null,
    "drivers": [],
    "risks": [],
    "epsEstNext": null,
    "epsEstNextConf": null,
    "epsEstYear2": null,
    "epsEstYear2Conf": null,
    "catalysts": [],
    "moat": null,
    "riskScore": null,
    "consensus": null,
    "updatedAt": null
  },
  "sources": []
}

欄位說明：
- targetPriceSrc：目標價來源（例：「摩根士丹利 2026-05-15」），不確定填 null
- forward.story：市場現在在賭的核心故事，一句話說清楚
- forward.drivers：成長動能，條列式，3-5點
- forward.risks：主要風險，條列式，2-4點
- forward.epsEstNext：下一年度 EPS 共識預估（元）
- forward.epsEstNextConf：EPS 預估信心度（high / mid / low）
- forward.epsEstYear2：後年度 EPS 共識預估（元）
- forward.epsEstYear2Conf：後年度 EPS 預估信心度（high / mid / low）
- forward.catalysts：近期重大催化劑／時程，條列式，2-4點
- forward.moat：競爭護城河，一句話
- forward.riskScore：綜合風險評級 1-5（1最低風險，5最高風險）
- forward.consensus：整體評估一句話結論
- forward.updatedAt：資料截止日期（YYYY-MM-DD）
- sources：每個有來源的欄位獨立標記，格式 { "field": "欄位名", "src": "來源名稱", "date": "YYYY-MM-DD" }
  例：[{ "field": "targetPrice", "src": "摩根士丹利", "date": "2026-05-15" },
       { "field": "epsEstNext",  "src": "Bloomberg 共識", "date": "2026-06-01" }]

（月營收、EPS、除息資料系統已自動抓取，不需填入）
只回覆 JSON，不要其他說明文字。`;

  navigator.clipboard.writeText(prompt).then(() => {
    window.dengToast?.('Prompt 已複製！貼給你的 AI 吧 ~', { mood: 'happy', duration: 3000 });
  }).catch(() => {
    window.dengToast?.('請手動複製', { mood: 'curious', duration: 2500 });
  });
}

// ── 補充資訊 Modal ────────────────────────────────────────────────────────
function _siShowModal(code) {
  // 移除舊的
  document.getElementById('siModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'siModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#161b22;border:0.5px solid rgba(255,255,255,.12);border-radius:12px;padding:20px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:15px;font-weight:500;color:#e8eaed">📋 補充資訊 — ${code}</div>
        <button id="siModalClose" style="background:none;border:none;color:#8a8f99;font-size:18px;cursor:pointer;padding:0 4px">✕</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button id="siModalCopyPrompt" style="flex:1;padding:8px 12px;border-radius:6px;background:rgba(239,83,80,.1);color:#ef5350;border:0.5px solid rgba(239,83,80,.3);font-size:13px;cursor:pointer;font-weight:500">📋 複製 Prompt</button>
      </div>
      <div style="font-size:12px;color:#8a8f99;margin-bottom:6px">貼上 AI 回傳的 JSON</div>
      <textarea id="siModalJson" rows="10" style="width:100%;background:rgba(255,255,255,.04);border:0.5px solid rgba(255,255,255,.12);border-radius:6px;padding:10px;color:#e8eaed;font-size:13px;resize:vertical;font-family:monospace" placeholder='貼上 AI 回傳的 JSON'></textarea>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="siModalImport" style="flex:1;padding:9px;border-radius:6px;background:rgba(239,83,80,.15);color:#ef5350;border:0.5px solid rgba(239,83,80,.35);font-size:13px;cursor:pointer;font-weight:500">✅ 匯入</button>
        <button id="siModalClear" style="padding:9px 14px;border-radius:6px;background:rgba(255,255,255,.05);color:#8a8f99;border:0.5px solid rgba(255,255,255,.1);font-size:13px;cursor:pointer">🗑 清除</button>
      </div>
      <div id="siModalMsg" style="font-size:12px;color:#8a8f99;margin-top:8px;min-height:18px"></div>
    </div>`;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('siModalClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('siModalCopyPrompt').addEventListener('click', () => _siCopyPrompt(code));

  document.getElementById('siModalImport').addEventListener('click', async () => {
    const raw = document.getElementById('siModalJson')?.value?.trim();
    const msg = document.getElementById('siModalMsg');
    if (!raw) { msg.textContent = '請先貼上 JSON ~'; return; }

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
    } catch(e) { msg.textContent = 'JSON 格式有誤，請確認後再試'; return; }

    if (parsed.code && parsed.code !== code) parsed.code = code;

    // ── 結構驗證 ───────────────────────────────────────────────────────────
    const { errors, warnings } = _siValidate(parsed, code);

    if (errors.length) {
      msg.style.color = '#ef5350';
      msg.innerHTML = errors.map(e => `❌ ${e}`).join('<br>');
      return;
    }

    _siDoSave(code, parsed, warnings, msg, close);
  });

  document.getElementById('siModalClear').addEventListener('click', async () => {
    if (!confirm(`確定清除 ${code} 的補充資訊？`)) return;
    const { deleteStockInfo } = await import('./db.js');
    await deleteStockInfo(code);
    document.getElementById('siModalMsg').textContent = '已清除';
    setTimeout(close, 600);
  });
}

// ── 補充資訊 JSON 驗證（Modal 用）────────────────────────────────────────
function _siValidate(parsed, code) {
  const errors   = [];
  const warnings = [];
  const today    = new Date().toISOString().slice(0, 10);

  if (parsed.code && parsed.code !== code) {
    errors.push(`代號不符：JSON 是 ${parsed.code}，當前是 ${code}`);
  }

  const pb = parseFloat(parsed.pbRatio);
  if (parsed.pbRatio != null && (!isFinite(pb) || pb <= 0 || pb > 100)) {
    warnings.push(`股淨比 ${parsed.pbRatio} 超出合理範圍（0.1 ~ 100）`);
  }

  const dy = parseFloat(parsed.dividendYield);
  if (parsed.dividendYield != null && (!isFinite(dy) || dy < 0 || dy > 30)) {
    warnings.push(`殖利率 ${parsed.dividendYield}% 超出合理範圍（0 ~ 30%）`);
  }

  const pe = parseFloat(parsed.peRatio);
  if (parsed.peRatio != null && (!isFinite(pe) || pe < 0 || pe > 5000)) {
    warnings.push(`本益比 ${parsed.peRatio} 超出合理範圍`);
  }

  const f = parsed.forward;
  if (f) {
    if (f.updatedAt) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.updatedAt)) {
        warnings.push(`forward.updatedAt 格式有誤（應為 YYYY-MM-DD）`);
      } else if (f.updatedAt > today) {
        warnings.push(`forward.updatedAt（${f.updatedAt}）是未來日期`);
      }
    } else if (f.story || f.consensus) {
      warnings.push('前瞻資料缺少 updatedAt 截止日期，未來無法判斷是否過期');
    }
    if (f.drivers != null && !Array.isArray(f.drivers)) errors.push('forward.drivers 應為陣列格式');
    if (f.risks   != null && !Array.isArray(f.risks))   errors.push('forward.risks 應為陣列格式');
    if (f.epsEstNext  != null && typeof f.epsEstNext  !== 'number') warnings.push(`forward.epsEstNext 應為數字`);
    if (f.epsEstYear2 != null && typeof f.epsEstYear2 !== 'number') warnings.push(`forward.epsEstYear2 應為數字`);
  }

  return { errors, warnings };
}

// ── 實際存入（驗證通過後）────────────────────────────────────────────────
async function _siDoSave(code, parsed, warnings, msgEl, close) {
  // ── FinMind 交叉比對 ──────────────────────────────────────────────────────
  msgEl.style.color = '#8a8f99';
  msgEl.textContent = '正在向 FinMind 驗證數字…';

  const crossResult  = await _siCrossCheck(code, parsed);
  const allWarnings  = [...warnings, ...crossResult.warnings];

  // 差距過大 → 阻擋，讓使用者確認
  if (crossResult.errors.length) {
    msgEl.style.color = '#ef5350';
    msgEl.innerHTML = crossResult.errors.map(e => `❌ ${e}`).join('<br>') +
      `<br><button id="siModalForceImport" style="margin-top:8px;padding:4px 12px;border-radius:4px;background:rgba(239,83,80,.15);border:0.5px solid rgba(239,83,80,.4);color:#ef5350;font-size:12px;cursor:pointer">仍要強制存入</button>`;
    document.getElementById('siModalForceImport')?.addEventListener('click', () => {
      _siCommit(code, parsed, allWarnings, crossResult.finmindValues, msgEl, close);
    });
    return;
  }

  // 有警告 → 顯示後讓使用者決定
  if (allWarnings.length) {
    msgEl.style.color = '#f59e0b';
    msgEl.innerHTML = allWarnings.map(w => `⚠️ ${w}`).join('<br>') +
      `<br><button id="siModalConfirmWarn" style="margin-top:8px;padding:4px 12px;border-radius:4px;background:rgba(245,158,11,.15);border:0.5px solid rgba(245,158,11,.4);color:#f59e0b;font-size:12px;cursor:pointer">了解，仍要存入</button>`;
    document.getElementById('siModalConfirmWarn')?.addEventListener('click', () => {
      _siCommit(code, parsed, allWarnings, crossResult.finmindValues, msgEl, close);
    });
    return;
  }

  _siCommit(code, parsed, [], crossResult.finmindValues, msgEl, close);
}

async function _siCommit(code, parsed, allWarnings, finmindValues, msgEl, close) {
  parsed._verify = {
    checkedAt : new Date().toISOString().slice(0, 10),
    warnings  : allWarnings,
    source    : 'ai_prompt',
    finmind   : finmindValues,
  };
  try {
    await saveStockInfo(code, parsed);
    msgEl.style.color = '#26a69a';
    msgEl.textContent = allWarnings.length
      ? `✓ 已儲存（${allWarnings.length} 項提醒請留意）`
      : '✓ 已儲存！重新整理觀點卡中…';
    document.dispatchEvent(new CustomEvent('stockInfoUpdated', { detail: { code } }));
    setTimeout(() => {
      close();
      const body    = document.getElementById('caBody');
      const r       = window.__lastAnalysisResult;
      const candles = window.__AppState?.lastCandles ?? [];
      if (body && candles.length) _tabPerspective(body, r, candles).catch(() => {});
    }, 800);
  } catch(e) { msgEl.textContent = '儲存失敗：' + e.message; }
}

// ── FinMind 交叉比對（Modal 用）──────────────────────────────────────────
async function _siCrossCheck(code, parsed) {
  const errors = [], warnings = [];
  let finmindValues = null;
  try {
    const fm = await fetchVerifyData(code);
    if (!fm) return { errors, warnings, finmindValues };
    finmindValues = fm;

    if (parsed.pbRatio != null && fm.pbRatio != null) {
      const diff = Math.abs(parseFloat(parsed.pbRatio) - fm.pbRatio);
      if (diff > 0.5)      errors.push(`股淨比差距過大：AI ${parsed.pbRatio} vs FinMind ${fm.pbRatio}（差 ${diff.toFixed(2)}）`);
      else if (diff > 0.2) warnings.push(`股淨比略有偏差：AI ${parsed.pbRatio} vs FinMind ${fm.pbRatio}`);
    }
    if (parsed.dividendYield != null && fm.dividendYield != null) {
      const diff = Math.abs(parseFloat(parsed.dividendYield) - fm.dividendYield);
      if (diff > 1.0)      errors.push(`殖利率差距過大：AI ${parsed.dividendYield}% vs FinMind ${fm.dividendYield}%（差 ${diff.toFixed(2)}%）`);
      else if (diff > 0.5) warnings.push(`殖利率略有偏差：AI ${parsed.dividendYield}% vs FinMind ${fm.dividendYield}%`);
    }
    if (parsed.peRatio != null && fm.pe != null) {
      const diff = Math.abs(parseFloat(parsed.peRatio) - fm.pe);
      if (diff > 10) warnings.push(`本益比偏差較大：AI ${parsed.peRatio} vs FinMind ${fm.pe}（差 ${diff.toFixed(1)}）`);
    }
  } catch(e) { console.warn('[_siCrossCheck]', e.message); }
  return { errors, warnings, finmindValues };
}

// ── 觀點卡版即時比對（複用 _siCrossCheck + popup）────────────────────────
async function _siRunLiveVerify(btn, code) {
  const dot   = btn.querySelector('.si-verify-dot');
  const label = btn.querySelector('span:not(.si-verify-dot)') || btn;

  // pulse 動畫
  if (!document.getElementById('si-dot-anim')) {
    const s = document.createElement('style');
    s.id = 'si-dot-anim';
    s.textContent = `@keyframes si-dot-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }`;
    document.head.appendChild(s);
  }

  // 無 token → 明確提示
  const { getFinMindToken } = await import('./config.js');
  if (!getFinMindToken()) {
    _siShowVerifyPopup(btn, [], [], null, 'no_token');
    return;
  }

  const info = await (await import('./db.js')).loadStockInfo(code);
  if (!info) {
    _siShowVerifyPopup(btn, ['尚無已存資料'], [], null, 'error');
    return;
  }

  btn.disabled = true;
  if (dot) { dot.style.background = '#8a8f99'; dot.style.animation = 'si-dot-pulse 1s infinite'; }

  try {
    const result = await _siCrossCheck(code, info);
    const fm     = result.finmindValues;
    if (dot) dot.style.animation = '';
    btn.disabled = false;

    // API 失敗（有 token 但拿不到資料）
    if (!fm) {
      dot && (dot.style.background = '#8a8f99');
      _siShowVerifyPopup(btn, [], [], null, 'api_fail');
      return;
    }

    const level    = result.errors.length ? 'error' : result.warnings.length ? 'warn' : 'ok';
    const dotColor = level === 'error' ? '#ef5350' : level === 'warn' ? '#f59e0b' : '#26a69a';
    if (dot) dot.style.background = dotColor;
    btn.style.color = dotColor;
    btn.style.borderColor = level === 'error' ? 'rgba(239,83,80,.4)' : level === 'warn' ? 'rgba(245,158,11,.4)' : 'rgba(38,166,154,.35)';
    _siShowVerifyPopup(btn, result.errors, result.warnings, fm, level);
  } catch(e) {
    if (dot) dot.style.animation = '';
    btn.disabled = false;
    console.error('[_siRunLiveVerify]', e);
    _siShowVerifyPopup(btn, [`比對失敗：${e.message}`], [], null, 'error');
  }
}

function _siShowVerifyPopup(anchorBtn, errors, warnings, fm, level) {
  document.getElementById('siVerifyPopup')?.remove();

  // 特殊狀態
  if (level === 'no_token') {
    _siShowVerifyPopupRaw(anchorBtn,
      '<div style="color:#f59e0b">⚠️ 需要 FinMind Token 才能比對</div>' +
      '<div style="font-size:11px;color:#8a8f99;margin-top:4px">請在設定頁填入 FinMind Token</div>',
      'rgba(245,158,11,.1)', 'rgba(245,158,11,.3)');
    return;
  }
  if (level === 'api_fail') {
    _siShowVerifyPopupRaw(anchorBtn,
      '<div style="color:#8a8f99">⚠️ FinMind API 無回應</div>' +
      '<div style="font-size:11px;color:#8a8f99;margin-top:4px">請確認網路或稍後再試</div>',
      'rgba(255,255,255,.05)', 'rgba(255,255,255,.12)');
    return;
  }

  const bg     = level === 'error' ? 'rgba(239,83,80,.12)'  : level === 'warn' ? 'rgba(245,158,11,.1)' : 'rgba(38,166,154,.08)';
  const border = level === 'error' ? 'rgba(239,83,80,.4)'   : level === 'warn' ? 'rgba(245,158,11,.35)' : 'rgba(38,166,154,.3)';
  const color  = level === 'error' ? '#ef5350'              : level === 'warn' ? '#f59e0b' : '#26a69a';
  const lines  = [];
  errors.forEach(e   => lines.push(`❌ ${e}`));
  warnings.forEach(w => lines.push(`⚠️ ${w}`));
  if (!lines.length) lines.push('✅ FinMind 數字比對正常');
  if (fm) {
    const fmItems = [];
    if (fm.pbRatio != null)      fmItems.push(`PB ${fm.pbRatio}`);
    if (fm.dividendYield != null) fmItems.push(`殖利率 ${fm.dividendYield}%`);
    if (fm.pe != null)            fmItems.push(`PE ${fm.pe}`);
    if (fmItems.length) lines.push(`FinMind 實際：${fmItems.join(' · ')}`);
  }
  const popup = document.createElement('div');
  popup.id = 'siVerifyPopup';
  popup.style.cssText = `position:fixed;z-index:99999;background:#161b22;border:0.5px solid ${border};
    border-radius:8px;padding:10px 14px;font-size:12px;color:${color};line-height:1.8;
    box-shadow:0 4px 20px rgba(0,0,0,.6);max-width:320px;`;
  popup.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  document.body.appendChild(popup);
  const rect = anchorBtn.getBoundingClientRect();
  popup.style.top  = `${rect.bottom + 6}px`;
  popup.style.left = `${Math.max(8, Math.min(rect.left - 40, window.innerWidth - 340))}px`;
  const close = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorBtn) {
      popup.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}

function _siShowVerifyPopupRaw(anchorBtn, html, bg, border) {
  document.getElementById('siVerifyPopup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'siVerifyPopup';
  popup.style.cssText = `position:fixed;z-index:99999;background:#161b22;border:0.5px solid ${border};
    border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.7;
    box-shadow:0 4px 20px rgba(0,0,0,.6);max-width:300px;`;
  popup.innerHTML = html;
  document.body.appendChild(popup);
  const rect = anchorBtn.getBoundingClientRect();
  popup.style.top  = `${rect.bottom + 6}px`;
  popup.style.left = `${Math.max(8, Math.min(rect.left - 40, window.innerWidth - 320))}px`;
  const close = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorBtn) {
      popup.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}
// ============================================================================
// 根據技術面、基本面、籌碼面的組合，從 DENG_MESSAGES 挑出最貼切的場景
// 再隨機取一句，填入插值佔位符後回傳
// ============================================================================

// 台詞庫：優先用 import，fallback 用 window（處理模組快取問題）
const _getDengMessages = () => (typeof DENG_MESSAGES !== 'undefined' ? DENG_MESSAGES : null)
  ?? window.__DENG_MESSAGES
  ?? {};

function _dengPickScene(ctx) {
  const { lamps, rsiVal, sigIds, fundQuality, chips, hasFund } = ctx;

  // 特殊訊號優先
  if (sigIds.has('X2')) return 'perspective_yaogu_x2';
  if (sigIds.has('X5')) return 'perspective_yaogu_x5';

  // 三合一共振（基本面 + 籌碼 + 技術全部站多）
  if (fundQuality === 'good' && (chips?.foreignNet ?? 0) > 1000 && lamps >= 2)
    return 'perspective_triple_confirm';

  // 背離警告（技術多但基本面+法人空）
  if (lamps >= 2 && fundQuality === 'poor' && (chips?.foreignNet ?? 0) < -1000)
    return 'perspective_divergence_warning';

  // 無基本面資料
  if (!hasFund) {
    if (rsiVal > 78) return 'perspective_overheat';
    if (rsiVal < 32) return 'perspective_oversold';
    if (lamps >= 3)  return 'perspective_bull_strong_fund_neutral';
    if (lamps >= 1.5) return 'perspective_bull_mid_fund_neutral';
    if (lamps <= -3) return 'perspective_bear_strong';
    if (lamps <= -1.5) return 'perspective_bear_mid_fund_neutral';
    return 'perspective_neutral_fund_neutral';
  }

  // RSI 極值（技術層優先覆蓋）
  if (rsiVal > 78 && lamps >= 1.5) return 'perspective_overheat';
  if (rsiVal < 32) return 'perspective_oversold';

  // 外資大量流向
  if ((chips?.foreignNet ?? 0) > 3000 && lamps >= 1) return 'perspective_foreign_buy';
  if ((chips?.foreignNet ?? 0) < -3000 && lamps <= 0) return 'perspective_foreign_sell';

  // 估值判斷
  const pe = ctx.pe ?? 0;
  if (pe > 0 && pe < 15 && fundQuality === 'good') return 'perspective_value_cheap';
  if (pe > 40 && fundQuality !== 'good') return 'perspective_value_expensive';

  // 三率判斷
  if (ctx.marginImproving) return 'perspective_margin_improving';
  if (ctx.marginDeclining) return 'perspective_margin_declining';

  // 主場景：燈號 × 基本面品質
  if (lamps >= 3) {
    if (fundQuality === 'good')    return 'perspective_bull_strong_fund_good';
    if (fundQuality === 'neutral') return 'perspective_bull_strong_fund_neutral';
    return 'perspective_bull_strong_fund_poor';
  }
  if (lamps >= 1.5) {
    if (fundQuality === 'good')    return 'perspective_bull_mid_fund_good';
    if (fundQuality === 'neutral') return 'perspective_bull_mid_fund_neutral';
    return 'perspective_bull_mid_fund_poor';
  }
  if (lamps <= -3) return 'perspective_bear_strong';
  if (lamps <= -1.5) {
    if (fundQuality === 'good')    return 'perspective_bear_mid_fund_good';
    if (fundQuality === 'neutral') return 'perspective_bear_mid_fund_neutral';
    return 'perspective_bear_mid_fund_poor';
  }
  // 中性
  if (fundQuality === 'good')    return 'perspective_neutral_fund_good';
  if (fundQuality === 'poor')    return 'perspective_neutral_fund_poor';
  return 'perspective_neutral_fund_neutral';
}

function _dengPickText(scene, ctx) {
  const pool = _getDengMessages()[scene];
  if (!pool || !pool.length) return { text: '燈燈在想，等等喵 ~', tone: 'cute' };
  const entry = pool[Math.floor(Math.random() * pool.length)];
  const text = entry.text
    .replace(/\{code\}/g,          ctx.code       ?? '')
    .replace(/\{lamps\}/g,         ctx.lampsDisp  ?? '')
    .replace(/\{rsi\}/g,           ctx.rsiVal     != null ? Math.round(ctx.rsiVal) : '—')
    .replace(/\{bias\}/g,          ctx.biasDisp   ?? '—')
    .replace(/\{phase\}/g,         ctx.phase?.name ?? '—')
    .replace(/\{eps\}/g,           ctx.eps        != null ? ctx.eps.toFixed(2) : '—')
    .replace(/\{epsGrowth\}/g,     ctx.epsGrowth  != null ? (ctx.epsGrowth * 100).toFixed(0) : '—')
    .replace(/\{revenueGrowth\}/g, ctx.revenueGrowth != null ? (ctx.revenueGrowth * 100).toFixed(0) : '—')
    .replace(/\{grossMargin\}/g,   ctx.grossMargin != null ? ctx.grossMargin.toFixed(1) : '—')
    .replace(/\{pe\}/g,            ctx.pe         != null ? ctx.pe.toFixed(1) : '—')
    .replace(/\{foreignNet\}/g,    ctx.chips?.foreignNet != null ? Math.abs(ctx.chips.foreignNet).toLocaleString() : '—')
    .replace(/\{topSignal\}/g,     ctx.topSignal  ?? '—')
    .replace(/\{topWarn\}/g,       ctx.topWarn    ?? '—');
  return { text, tone: entry.tone };
}

// 判斷基本面品質（good / neutral / poor）
function _dengFundQuality(fund) {
  if (!fund) return null;
  let score = 0;
  // 獲利成長
  if (fund.earningsGrowth != null) {
    if (fund.earningsGrowth > 0.2)  score += 2;
    else if (fund.earningsGrowth > 0) score += 1;
    else score -= 1;
  }
  // 營收成長
  if (fund.revenueGrowth != null) {
    if (fund.revenueGrowth > 0.15)  score += 1;
    else if (fund.revenueGrowth > 0) score += 0.5;
    else score -= 0.5;
  }
  // 毛利率
  if (fund.grossMargin != null) {
    if (fund.grossMargin > 35) score += 1;
    else if (fund.grossMargin > 20) score += 0.5;
    else score -= 0.5;
  }
  // 淨利率
  if (fund.profitMargin != null) {
    if (fund.profitMargin > 0.1) score += 1;
    else if (fund.profitMargin > 0) score += 0.5;
    else score -= 1;
  }
  if (score >= 3) return 'good';
  if (score >= 1) return 'neutral';
  return 'poor';
}

async function _tabPerspective(body, r, candles) {
  const code    = _ctxRefs.getCode?.() ?? '';
  const signals = (window.__AppState?.signals?.[code] || []).filter(s => s && s.id);

  // 讀取補充資訊資料（stockInfo + autoData 並行）
  let _stockInfo = null;
  let _autoData  = { revenue: null, eps: null, dividend: null };
  try {
    [_stockInfo, ...[]] = await Promise.all([
      loadStockInfo(code),
      (async () => {
        try {
          const [rev, eps, div] = await Promise.allSettled([
            fsGetShared(`stocks/${code}/revenue`),
            fsGetShared(`stocks/${code}/eps`),
            fsGetShared(`stocks/${code}/dividend`),
          ]);
          _autoData = {
            revenue:  rev.status  === 'fulfilled' ? rev.value  : null,
            eps:      eps.status  === 'fulfilled' ? eps.value  : null,
            dividend: div.status  === 'fulfilled' ? div.value  : null,
          };
        } catch(_) {}
      })(),
    ]);
  } catch(_) {}
  const _forward  = _stockInfo?.forward ?? null;
  const hasForward = !!(_forward && (_forward.story || _forward.consensus || _forward.drivers?.length));


  // ── 五燈計算 ──
  const closes = candles.map(c => c.close ?? c.c ?? 0);
  let difPos = true;
  try {
    const { dif } = calcMACD(closes, 12, 26, 9);
    const n = dif?.length ?? 0;
    if (n > 0 && Number.isFinite(dif[n - 1])) difPos = dif[n - 1] > 0;
  } catch(_) {}

  const lamps = window.calcSignalLamps
    ? window.calcSignalLamps(signals, difPos)
    : 0;

  const lampCount = Math.abs(lamps);
  const lampDir   = lamps > 0 ? 'bull' : lamps < 0 ? 'bear' : 'neu';
  const lampColor = lamps > 0 ? C_UP : lamps < 0 ? C_DOWN : C_MUTED;

  // ── 分流多空訊號 ──
  const WARNING_IDS = new Set([
    'W1','W2','W3','W4','W5','W6','W7','W8','W9','W10',
    'W11','W12','W13','W14','W15','W16','W17','W18','W19','W20',
  ]);
  const STRATEGIES = window.__STRATEGIES || [];
  const bullSignals = signals.filter(s => !WARNING_IDS.has(s.id)).slice(0, 4);
  const warnSignals = signals.filter(s =>  WARNING_IDS.has(s.id)).slice(0, 3);

  // ── 波段位置 ──
  const n    = candles.length;
  const last = candles[n - 1];
  let rsiVal = 50;
  try { const ra = calcRSI(closes, 14); rsiVal = ra[ra.length - 1] ?? 50; } catch(_) {}
  const ma20arr = closes.slice(-20);
  const ma20    = ma20arr.reduce((a, b) => a + b, 0) / ma20arr.length;
  const bias    = ((last.close - ma20) / ma20) * 100;
  const vol5    = candles.slice(-5).reduce((a, c) => a + (c.volume ?? 0), 0) / 5;
  const vol20v  = candles.slice(-20).reduce((a, c) => a + (c.volume ?? 0), 0) / 20;
  const volRatio = vol20v > 0 ? vol5 / vol20v : 1;
  const sigIds   = new Set(signals.map(s => s.id));

  let phase = { key: 'correction', name: '修正', color: C_MUTED };
  if      (volRatio < 0.7 && Math.abs(bias) < 5 && Math.abs(lamps) <= 1)           phase = { key: 'accumulate', name: '蓄積',  color: C_AMBER };
  else if (rsiVal > 78 && bias > 10)                                                 phase = { key: 'overheat',   name: '過熱',  color: C_DOWN  };
  else if (lamps < -1.5)                                                             phase = { key: 'correction', name: '修正',  color: C_DOWN  };
  else if (lamps >= 2.5 && bias > 3)                                                 phase = { key: 'markup',     name: '主升',  color: C_UP    };
  else if ((sigIds.has('S20')||sigIds.has('S10')||sigIds.has('S32')||sigIds.has('S36')) && lamps >= 1)
                                                                                     phase = { key: 'breakout',   name: '啟動',  color: C_UP    };
  else if (lamps >= 1)                                                               phase = { key: 'breakout',   name: '啟動',  color: C_UP    };

  const PHASES = ['蓄積','啟動','主升','過熱','修正'];

  // ── 關鍵槓桿點 ──
  let leverage = '目前無明確訊號，建議觀望';
  if      (sigIds.has('S_ICHI_3GOOD')) leverage = '三役好轉確認，是本波最強多頭結構訊號';
  else if (sigIds.has('S17'))          leverage = '外資連買持續流入，是本波上漲最重要的資金支撐';
  else if (sigIds.has('X2'))           leverage = '天黑請閉眼啟動，飆股加速段介入，需嚴格停損';
  else if (sigIds.has('X5'))           leverage = '爆量建倉早期訊號，比主升段早5–10日的介入機會';
  else if (sigIds.has('S11'))          leverage = 'KD + MACD 雙黃金交叉站上月線，三重確認強力買點';
  else if (sigIds.has('W10'))          leverage = 'KD + MACD 雙死叉跌破月線，趨勢全面轉弱，高度警示';
  else if (sigIds.has('W11'))          leverage = '跌破一目雲層，中長線最強空頭確認訊號';
  else if (signals.length) {
    const top = signals[0];
    const st  = STRATEGIES.find(s => s.id === top?.id);
    if (st) leverage = `${st.name}觸發——${st.desc}`;
  }

  // ── 健康度 ──
  const techScore = Math.min(100, Math.max(0, 50 + lamps * 10));
  const techLabel = lamps >= 2 ? '強勢' : lamps >= 0.5 ? '偏強' : lamps <= -2 ? '弱勢' : lamps <= -0.5 ? '偏弱' : '中性';
  const techColor = lamps >= 1 ? C_UP : lamps <= -1 ? C_DOWN : C_AMBER;
  let chipScore = 50, chipLabel = '中性', chipColor = C_AMBER;
  if      (sigIds.has('S17'))  { chipScore = 80; chipLabel = '法人進場'; chipColor = C_UP;   }
  else if (sigIds.has('W13'))  { chipScore = 25; chipLabel = '量增價跌'; chipColor = C_DOWN; }
  else if (lamps >= 2)         { chipScore = 65; chipLabel = '偏多';     chipColor = C_UP;   }
  else if (lamps <= -2)        { chipScore = 30; chipLabel = '偏空';     chipColor = C_DOWN; }
  const biasScore = Math.max(0, Math.min(100, 70 - bias * 2));
  const valLabel  = bias > 10 ? '偏高' : bias > 5 ? '略高' : bias < -10 ? '超跌' : bias < -5 ? '偏低' : '合理';
  const valColor  = bias > 8 ? C_AMBER : C_UP;
  const riskScore = Math.max(0, Math.min(100, rsiVal));
  const riskLabel = rsiVal > 80 ? 'RSI過熱' : rsiVal > 70 ? 'RSI偏高' : rsiVal < 30 ? 'RSI超賣' : '風險適中';
  const riskColor = rsiVal > 75 ? C_DOWN : rsiVal < 35 ? C_UP : C_AMBER;

  const health = [
    { label: '技術結構', val: techLabel,  score: techScore,  color: techColor  },
    { label: '籌碼動能', val: chipLabel,  score: chipScore,  color: chipColor  },
    { label: '估值空間', val: valLabel,   score: biasScore,  color: valColor   },
    { label: '短線風險', val: riskLabel,  score: riskScore,  color: riskColor  },
  ];

  // ── 支撐壓力（優先用 r，fallback window.__srData）──
  const _sr    = (r?.resistance?.items?.length || r?.support?.items?.length) ? r : (window.__srData ?? {});
  const res    = _sr?.resistance?.items?.[0]?.price ?? null;
  const sup    = _sr?.support?.items?.[0]?.price    ?? null;
  const resNote = _sr?.resistance?.items?.[0]?.label ?? '壓力位';
  const supNote = _sr?.support?.items?.[0]?.label    ?? '支撐位';
  const cur     = last.close ?? 0;
  const resDist = res && cur ? (((res - cur) / cur) * 100).toFixed(1) : null;
  const supDist = sup && cur ? (((cur - sup) / cur) * 100).toFixed(1) : null;

  // ── USP 句 ──
  let usp = '目前無明確訊號，維持觀望';
  if      (sigIds.has('S_ICHI_3GOOD') && sigIds.has('S17')) usp = '外資進場 + 三役好轉，多頭結構最強確認';
  else if (sigIds.has('X2'))           usp = '飆股加速段，天黑請閉眼介入——賭高 beta 報酬';
  else if (sigIds.has('S11'))          usp = 'KD + MACD 雙黃金交叉，三重確認強力買點';
  else if (sigIds.has('W10'))          usp = '三重弱勢確認，全面轉空，不適合做多';
  else if (sigIds.has('W11'))          usp = '跌破一目雲層，中長線空頭確立，避險優先';
  else if (lamps >= 3)                 usp = '多頭訊號高度共振，趨勢強勢延伸中';
  else if (lamps >= 1.5)               usp = phase.name + '段確認，訊號持續累積中';
  else if (lamps <= -3)                usp = '空頭訊號全面壓制，建議減碼或避險';
  else if (lamps <= -1.5)              usp = '弱勢結構形成，持股風險提升';

  // ── 燈燈敘事（台詞庫版）──
  const verdict = lamps >= 1.5 ? 'buy' : lamps <= -1.5 ? 'hedge' : 'watch';
  let verdictLabel = '觀望', verdictColor = C_AMBER;
  let slText = '等方向確認再進場';

  if (verdict === 'buy') {
    verdictLabel = '可試單'; verdictColor = C_UP;
    if (sup) slText = `停損 ${(sup * 0.99).toFixed(0)}${res ? '　目標 ' + res.toFixed(0) : ''}`;
  } else if (verdict === 'hedge') {
    verdictLabel = '避險優先'; verdictColor = C_DOWN;
    slText = '建議減碼，等訊號翻多';
  }

  // ── 讀取基本面 / 籌碼資料 ──
  const _fund  = window.__lastFundamentals ?? null;
  const _chips = window.__lastChips ?? null;
  const hasFund = !!(_fund && (_fund.eps != null || _fund.earningsGrowth != null));

  // 三率趨勢判斷
  const _gm0 = _fund?._marginSeries?.[0]?.grossMargin ?? null;
  const _gm1 = _fund?._marginSeries?.[1]?.grossMargin ?? null;
  const marginImproving = _gm0 != null && _gm1 != null && _gm0 > _gm1 && (_fund?.revenueGrowth ?? 0) > 0;
  const marginDeclining = _gm0 != null && _gm1 != null && _gm0 < _gm1 - 3;

  // 基本面品質
  const fundQuality = _dengFundQuality(_fund);

  // 選句情境 context
  const _dengCtx = {
    code,
    lamps,
    lampsDisp: (lamps > 0 ? '+' : '') + lamps,
    rsiVal,
    biasDisp:  (bias >= 0 ? '+' : '') + bias.toFixed(1) + '%',
    phase,
    sigIds,
    hasFund,
    fundQuality: fundQuality ?? 'neutral',
    chips:       _chips,
    pe:          _fund?.pe ?? null,
    eps:         _fund?.eps ?? null,
    epsGrowth:   _fund?.earningsGrowth ?? null,
    revenueGrowth: _fund?.revenueGrowth ?? null,
    grossMargin: _fund?._marginSeries?.[0]?.grossMargin ?? (_fund?.profitMargin != null ? null : null),
    profitMargin: _fund?.profitMargin ?? null,
    marginImproving,
    marginDeclining,
    topSignal:   bullSignals[0] ? (STRATEGIES.find(s => s.id === bullSignals[0].id)?.name ?? '') : '',
    topWarn:     warnSignals[0] ? (STRATEGIES.find(s => s.id === warnSignals[0].id)?.name ?? '') : '',
  };

  // grossMargin 補值：優先取 _marginSeries，fallback 從 profitMargin 推算
  if (_dengCtx.grossMargin == null && _fund?._marginSeries?.[0]?.grossMargin != null) {
    _dengCtx.grossMargin = _fund._marginSeries[0].grossMargin;
  }

  const _scene = _dengPickScene(_dengCtx);
  const _picked = _dengPickText(_scene, _dengCtx);

  // ── 矛盾偵測 + forward 整合敘事 ──────────────────────────────────────────
  // 財報退化但技術面強多 = 可能是轉型期/未來面，燈燈不該說「減碼」
  const _fundDeclining = _dengCtx.fundQuality === 'poor' &&
    (_dengCtx.epsGrowth != null && _dengCtx.epsGrowth < -0.05);
  const _techStrong = lamps >= 2;
  const _isMismatch = _fundDeclining && _techStrong;

  let narText;

  if (hasForward && _forward.consensus) {
    // 有前瞻資料：燈燈說前瞻面版本
    const epsLine = (_forward.epsEstNext || _forward.epsEstYear2)
      ? `法人預估明年 EPS ${_forward.epsEstNext ?? '?'} 元${_forward.epsEstYear2 ? `、後年 ${_forward.epsEstYear2} 元` : ''}。`
      : '';
    narText = `${_forward.consensus}${epsLine ? ' ' + epsLine : ''}`;
  } else if (_isMismatch) {
    // 矛盾組合：歷史財報差但技術強，燈燈說不確定
    narText = `財報數字看起來在退步，但技術面 ${lamps > 0 ? '+' : ''}${lamps} 燈——這種背離通常代表市場在賭未來，不是反映現在。燈燈只看得到歷史財報，看不到法說會的前瞻指引。把這檔的資訊丟給 AI 分析後匯入補充資訊，燈燈才能給你更完整的判斷。`;
  } else {
    narText = _picked.text;
  }

  // ── Pipeline ──
  let pipeline;
  if (lamps >= 1) {
    pipeline = [
      { n:1, title:'試單佈局',   desc:`現價 ${cur.toFixed(0)} 附近，2成倉建立觀察位`,            state:'act'  },
      { n:2, title:'回踩確認',   desc:`拉回支撐 ${sup ? sup.toFixed(0) : '—'} 量縮止跌後加至5成`, state:'wait' },
      { n:3, title:'突破加碼',   desc:`突破壓力 ${res ? res.toFixed(0) : '—'} 放量確認加至8成`,   state:'wait' },
    ];
  } else if (lamps <= -1.5) {
    pipeline = [
      { n:1, title:'降低倉位',   desc:'反彈至壓力帶時分批減碼',                                    state:'act'  },
      { n:2, title:'設停損點',   desc:`跌破 ${sup ? sup.toFixed(0) : '—'} 立即出場，不等待`,        state:'act'  },
      { n:3, title:'等待翻多',   desc:'訊號轉正後再重新評估進場',                                    state:'wait' },
    ];
  } else {
    pipeline = [
      { n:1, title:'持續觀察',   desc:'等待方向確認，不急於進場',                                    state:'act'  },
      { n:2, title:'設定條件',   desc:`突破 ${res ? res.toFixed(0) : '—'} 或跌破 ${sup ? sup.toFixed(0) : '—'} 再行動`, state:'wait' },
      { n:3, title:'依訊號行動', desc:'多頭訊號 → 試單，空頭訊號 → 觀望',                            state:'wait' },
    ];
  }

  // ── 五燈泡 HTML ──
  const full = Math.floor(lampCount);
  const half = lampCount - full >= 0.4 ? 1 : 0;
  const empty = 5 - full - half;
  const bulbOn   = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${lampColor};margin:0 2px"></span>`;
  const bulbHalf = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:linear-gradient(90deg,${lampColor} 50%,rgba(255,255,255,0.1) 50%);margin:0 2px"></span>`;
  const bulbOff  = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,0.1);margin:0 2px"></span>`;
  const lampsHtml = bulbOn.repeat(full) + (half ? bulbHalf : '') + bulbOff.repeat(empty)
    + `<span style="font-size:13px;color:${C_MUTED};margin-left:4px">${lamps > 0 ? '+' : ''}${lamps}燈</span>`;

  // ── 標籤 ──
  const tagSet = new Set();
  for (const s of signals) {
    const st = STRATEGIES.find(st => st.id === s.id);
    if (st?.category && st.category !== '避險警示' && tagSet.size < 3) tagSet.add(st.category);
  }
  const tagsHtml = [...tagSet].map(t =>
    `<span style="font-size:13px;padding:2px 8px;border-radius:4px;font-weight:500;background:rgba(239,83,80,.1);color:${C_UP};border:0.5px solid rgba(239,83,80,.25)">${t}</span>`
  ).join('') + (warnSignals.length
    ? `<span style="font-size:13px;padding:2px 8px;border-radius:4px;font-weight:500;background:rgba(38,166,154,.1);color:${C_DOWN};border:0.5px solid rgba(38,166,154,.25)">避險警示 ${warnSignals.length} 個</span>`
    : '');

  // ── 波段位置 HTML ──
  const phaseHtml = PHASES.map(p => {
    const active = p === phase.name;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 2px;border-radius:6px;
      border:0.5px solid ${active ? 'rgba(239,83,80,.4)' : 'rgba(255,255,255,0.07)'};
      background:${active ? 'rgba(239,83,80,.08)' : 'rgba(255,255,255,0.02)'}">
      <div style="width:6px;height:6px;border-radius:50%;background:${active ? C_UP : 'rgba(255,255,255,0.15)'}"></div>
      <div style="font-size:13px;font-weight:500;color:${active ? C_UP : C_MUTED}">${p}</div>
    </div>`;
  }).join('');

  // ── 健康度 HTML ──
  const healthHtml = health.map(h =>
    `<div style="flex:1;background:rgba(255,255,255,.03);border-radius:6px;padding:7px 8px;border:0.5px solid rgba(255,255,255,.06)">
      <div style="font-size:12px;color:${C_MUTED};margin-bottom:3px">${h.label}</div>
      <div style="font-size:14px;font-weight:500;color:${h.color};margin-bottom:4px">${h.val}</div>
      <div style="height:3px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden">
        <div style="height:100%;border-radius:2px;background:${h.color};width:${h.score}%"></div>
      </div>
    </div>`
  ).join('');

  // ── 多空對立 HTML ──
  const bHtml = bullSignals.map(s => {
    const st = STRATEGIES.find(st => st.id === s.id);
    return `<div style="display:flex;align-items:flex-start;gap:6px;font-size:13px;color:${C_MUTED};line-height:1.4;margin-bottom:5px">
      <div style="width:5px;height:5px;border-radius:50%;background:${C_UP};flex-shrink:0;margin-top:4px"></div>
      <div><span style="font-weight:500;color:#e8eaed">${st?.name ?? s.id}</span><br>${st?.desc ?? ''}</div>
    </div>`;
  }).join('') || `<div style="font-size:13px;color:rgba(255,255,255,.2)">無明確買進訊號</div>`;

  const wHtml = warnSignals.map(s => {
    const st = STRATEGIES.find(st => st.id === s.id);
    return `<div style="display:flex;align-items:flex-start;gap:6px;font-size:13px;color:${C_MUTED};line-height:1.4;margin-bottom:5px">
      <div style="width:5px;height:5px;border-radius:50%;background:${C_DOWN};flex-shrink:0;margin-top:4px"></div>
      <div><span style="font-weight:500;color:#e8eaed">${st?.name ?? s.id}</span><br>${st?.desc ?? ''}</div>
    </div>`;
  }).join('') || `<div style="font-size:13px;color:rgba(255,255,255,.2)">無明確避險訊號</div>`;

  // ── Pipeline HTML ──
  const pipeHtml = pipeline.map(p =>
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">
      <div style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:13px;font-weight:500;flex-shrink:0;
        ${p.state === 'act'
          ? `background:rgba(239,83,80,.15);color:${C_UP};border:1px solid rgba(239,83,80,.35)`
          : `background:rgba(255,255,255,.05);color:${C_MUTED};border:0.5px solid rgba(255,255,255,.1)`}">${p.n}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:500;color:#e8eaed">${p.title}</div>
        <div style="font-size:13px;color:${C_MUTED};margin-top:1px">${p.desc}</div>
      </div>
      <div style="font-size:12px;padding:2px 8px;border-radius:4px;
        ${p.state === 'act'
          ? `background:rgba(239,83,80,.12);color:${C_UP}`
          : `background:rgba(255,255,255,.05);color:${C_MUTED}`}">${p.state === 'act' ? '執行' : '等待'}</div>
    </div>`
  ).join('');

  const card = s => `<div class="cao-card">${s}</div>`;

  body.innerHTML = `<div class="cao-wrap">

    ${card(`
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px">
        <div style="flex-shrink:0">
          <div style="font-size:20px;font-weight:500;color:#e8eaed">${code}</div>
          <div style="font-size:13px;color:${C_MUTED};margin-top:2px">Strategy — 為什麼看這檔</div>
          <div style="display:flex;gap:3px;align-items:center;margin-top:6px">${lampsHtml}</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">${tagsHtml}</div>
        </div>
        <div style="flex:1;min-width:0;padding-left:4px">
          <div style="background:rgba(255,255,255,.04);border:0.5px solid rgba(255,255,255,.08);border-radius:10px 10px 10px 0;padding:10px 12px">
            <div style="font-size:14px;font-weight:500;color:#e8eaed;line-height:1.6;border-left:3px solid ${lampColor};padding-left:10px">${usp}</div>
            <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span style="font-size:12px;font-weight:500;padding:3px 10px;border-radius:20px;
                background:${verdict === 'buy' ? 'rgba(239,83,80,.12)' : verdict === 'hedge' ? 'rgba(38,166,154,.12)' : 'rgba(245,158,11,.12)'};
                color:${verdictColor};border:0.5px solid ${verdictColor}44">${verdictLabel}</span>
              <span style="font-size:12px;color:${C_MUTED}">${slText}</span>
              ${hasForward ? `<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,.12);color:#818cf8;border:0.5px solid rgba(99,102,241,.3)">🔭 含前瞻資料</span>` : ''}
              ${_isMismatch && !hasForward ? `<button class="pv-goto-stockinfo" style="font-size:11px;padding:2px 10px;border-radius:4px;background:rgba(245,158,11,.12);color:${C_AMBER};border:0.5px solid rgba(245,158,11,.3);cursor:pointer">📋 補充前瞻資訊 →</button>` : ''}
            </div>
          </div>
        </div>
      </div>
    `)}

    ${card(`
      <div style="font-size:12px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase;margin-bottom:8px">波段位置</div>
      <div style="display:flex;gap:5px;margin-bottom:10px">${phaseHtml}</div>
      <div style="background:rgba(245,158,11,.06);border:0.5px solid rgba(245,158,11,.25);border-radius:6px;padding:10px 12px;display:flex;gap:8px;align-items:flex-start">
        <div style="font-size:15px;flex-shrink:0;margin-top:1px">⚡</div>
        <div>
          <div style="font-size:12px;color:${C_AMBER};font-weight:500;margin-bottom:3px">關鍵槓桿點</div>
          <div style="font-size:14px;color:#e8eaed;line-height:1.5;font-weight:500">${leverage}</div>
        </div>
      </div>
    `)}

    ${card(`
      <div style="font-size:12px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase;margin-bottom:8px">Diagnosis — 個股損益表</div>
      <div style="display:flex;gap:7px;margin-bottom:10px">${healthHtml}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:500;color:${C_UP};margin-bottom:5px">買進理由</div>
          ${bHtml}
        </div>
        <div>
          <div style="font-size:13px;font-weight:500;color:${C_DOWN};margin-bottom:5px">避險理由</div>
          ${wHtml}
        </div>
      </div>
    `)}

    ${res || sup ? card(`
      <div style="font-size:12px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase;margin-bottom:8px">市場訂價 — 願付空間</div>
      <div style="display:flex;gap:7px">
        ${res ? `<div style="flex:1;border-radius:6px;padding:8px 10px;border:0.5px solid rgba(239,83,80,.2);background:rgba(239,83,80,.05)">
          <div style="font-size:12px;color:${C_MUTED};margin-bottom:3px">壓力</div>
          <div style="font-size:17px;font-weight:500;color:${C_UP}">${res.toFixed(0)}</div>
          <div style="font-size:12px;color:${C_MUTED};margin-top:2px">${resNote}${resDist ? '　+' + resDist + '%' : ''}</div>
        </div>` : ''}
        <div style="flex:1;border-radius:6px;padding:8px 10px;border:0.5px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03)">
          <div style="font-size:12px;color:${C_MUTED};margin-bottom:3px">現價</div>
          <div style="font-size:17px;font-weight:500;color:#e8eaed">${cur.toFixed(0)}</div>
          <div style="font-size:12px;color:${C_MUTED};margin-top:2px">今日收盤</div>
        </div>
        ${sup ? `<div style="flex:1;border-radius:6px;padding:8px 10px;border:0.5px solid rgba(38,166,154,.2);background:rgba(38,166,154,.05)">
          <div style="font-size:12px;color:${C_MUTED};margin-bottom:3px">支撐</div>
          <div style="font-size:17px;font-weight:500;color:${C_DOWN}">${sup.toFixed(0)}</div>
          <div style="font-size:12px;color:${C_MUTED};margin-top:2px">${supNote}${supDist ? '　-' + supDist + '%' : ''}</div>
        </div>` : ''}
      </div>
    `) : ''}

    ${card(`
      <div style="font-size:12px;font-weight:500;letter-spacing:.07em;color:${C_MUTED};text-transform:uppercase;margin-bottom:8px">Decision — 行動計畫</div>
      ${pipeHtml}
    `)}

    ${_buildFundSummaryCard(window.__lastFundamentals, window.__lastChips, C_UP, C_DOWN, C_AMBER, C_MUTED)}

    ${_buildStockInfoSection(_stockInfo, _autoData, code, C_UP, C_DOWN, C_AMBER, C_MUTED)}

  </div>`;
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
