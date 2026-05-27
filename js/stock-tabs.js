/**
 * stock-tabs.js
 * 個股內頁 Tab：K線圖 / 籌碼 / 基本面 / 新聞 / 公告
 * 基本面內含子 Tab：總覽 / EPS 季報 / 月營收 / 三率
 */

import {
  toYahooSymbol,
  fetchFundamentals,
  fetchFinMindRevenue,
  fetchChipData,
  fetchForeignBuyDays,
  fetchNews,
  fetchAnnouncements,
  clearFundCache,
  clearChipCache,
  getChineseName,
} from './api.js';

import { getFinMindToken } from './config.js';
import { matchSignals, getYaoguStatus, updateYaoguTracker, injectYaoguSignals } from './signal-scan.js';
import { calcSignalLamps } from './strategy.js';
import { calcMACD } from './indicators.js';
import { AppState } from './state.js';
import { setSignalsCache, getYaoguRecord, deleteYaoguRecord } from './db.js';
import { calcHealth } from './health.js';

// ─────────────────────────────────────────────
// 主 Tab 狀態
// ─────────────────────────────────────────────
const _loaded = { chip: false, fundamental: false, news: false, announcement: false };
let _currentName = '';

// 基本面子 Tab 快取
let _fundData    = null;
let _revenueData = null;
let _fundCode    = null;

// ─────────────────────────────────────────────
// 切換個股時重置所有面板
// ─────────────────────────────────────────────
export function reloadStockTabs(code, stockName = '') {
  _loaded.chip         = false;
  _loaded.fundamental  = false;
  _loaded.news         = false;
  _loaded.announcement = false;
  _currentName         = stockName;

  _fundData    = null;
  _revenueData = null;
  _fundCode    = null;

  _setLoading('chipPanel');
  _setLoading('fundamentalPanel');
  _setLoading('newsPanel');
  _setLoading('announcementPanel');

  const activeTab = document.querySelector('.stock-tab.active')?.dataset?.stockTab;
  if (activeTab && activeTab !== 'chart') _loadPanel(activeTab, code);

  // 切換個股時先清空訊號標籤，等 renderStockSignals() 被 main.js 呼叫後重繪
  _clearSignalTags();
}

// ─────────────────────────────────────────────
// 主 Tab 點擊初始化
// ─────────────────────────────────────────────
export function initStockTabs() {
  document.querySelectorAll('.stock-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab  = btn.dataset.stockTab;
      const code = window.__stockDashCode ?? null;

      document.querySelectorAll('.stock-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.stock-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`${tab}Panel`)?.classList.add('active');

      if (tab !== 'chart' && !_loaded[tab] && code) _loadPanel(tab, code);
    });
  });
}

async function _loadPanel(tab, code) {
  const symbol = toYahooSymbol(code);
  switch (tab) {
    case 'chip':         return _loadChip(code);
    case 'fundamental':  return _loadFundamental(symbol, code);
    case 'news':         return _loadNews(symbol, _currentName);
    case 'announcement': return _loadAnnouncement(code);
    case 'stockinfo':    return window.__renderStockInfo?.(code);
  }
}

// ─────────────────────────────────────────────
// 籌碼面板
// ─────────────────────────────────────────────
async function _loadChip(code) {
  const fetchTime = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const [data, foreignHist] = await Promise.allSettled([
    fetchChipData(code),
    fetchForeignBuyDays(code, 20).catch(() => []),
  ]);
  _loaded.chip = true;
  const el = document.getElementById('chipPanel');

  const chipData   = data.status === 'fulfilled' ? data.value : { institutional: null, margin: null };
  const foreignArr = foreignHist.status === 'fulfilled' ? (foreignHist.value ?? []) : [];

  const { institutional: inst, margin } = chipData;

  // 給 AI 圓桌(嘎神)用:把法人和融資資料整理成 personas 看得懂的格式
  if (inst || margin) {
    window.__lastChips = {
      foreignNet:  inst?.foreign  ?? 0,       // 外資買賣超(張)
      trustNet:    inst?.trust    ?? 0,       // 投信
      dealerNet:   inst?.dealer   ?? 0,       // 自營
      totalNet:    inst?.total    ?? 0,       // 三大法人合計
      marginChg:   margin?.marginChange ?? 0, // 融資增減
    };
    try { window.dispatchEvent(new CustomEvent('chipsUpdated')); } catch (_) {}
  }

  const instHtml = inst
    ? _renderChipBars(inst)
    : '<div class="panel-error">今日法人資料尚未更新</div>';

  const marginHtml = margin ? `
    <div class="info-grid">
      <div class="info-cell">
        <div class="info-cell-label">融資餘額（張）</div>
        <div class="info-cell-value">${_fmtNum(margin.marginBalance)}</div>
        <div class="info-cell-sub ${margin.marginChange >= 0 ? 'up' : 'down'}">
          ${margin.marginChange >= 0 ? '▲' : '▼'} ${_fmtNum(Math.abs(margin.marginChange))}
        </div>
      </div>
      <div class="info-cell">
        <div class="info-cell-label">融券餘額（張）</div>
        <div class="info-cell-value">${_fmtNum(margin.shortBalance)}</div>
        <div class="info-cell-sub ${margin.shortChange >= 0 ? 'up' : 'down'}">
          ${margin.shortChange >= 0 ? '▲' : '▼'} ${_fmtNum(Math.abs(margin.shortChange))}
        </div>
      </div>
      <div class="info-cell">
        <div class="info-cell-label">券資比</div>
        <div class="info-cell-value">
          ${margin.marginBalance > 0
            ? ((margin.shortBalance / margin.marginBalance) * 100).toFixed(1) + '%'
            : '—'}
        </div>
      </div>
    </div>` : '<div class="panel-error" style="padding:12px 16px">融資融券資料尚未更新</div>';

  // 外資歷史走勢（近 20 個交易日）
  const foreignHistHtml = foreignArr.length > 0
    ? _renderForeignHistory(foreignArr)
    : (getFinMindToken?.() ? '<div class="panel-error" style="padding:12px 16px">外資歷史載入中…</div>'
                           : '<div class="panel-error" style="padding:12px 16px">需設定 FinMind Token 才能顯示外資歷史</div>');

  el.innerHTML = `
    <div class="panel-section">
      <div class="panel-section-title-row">
        <span class="panel-section-title" style="border:none;padding-bottom:0;margin-bottom:0">三大法人買賣超（張）</span>
        <span class="chip-fetch-time">抓取於 ${fetchTime}</span>
        <button class="fund-refresh-btn" id="chipRefreshBtn" title="重新抓取籌碼資料">↺</button>
      </div>
      ${instHtml}
    </div>
    <div class="panel-section">
      <div class="panel-section-title">融資融券</div>
      ${marginHtml}
    </div>
    <div class="panel-section">
      <div class="panel-section-title">外資近期買賣超（張）</div>
      ${foreignHistHtml}
    </div>`;

  // 手動更新按鈕
  document.getElementById('chipRefreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('chipRefreshBtn');
    if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
    await clearChipCache(code);
    _loaded.chip = false;
    el.innerHTML = '<div class="panel-loading">重新載入中</div>';
    await _loadChip(code);
  });
}

function _renderForeignHistory(hist) {
  // hist 是降冪（最新在前），反轉為升冪方便左→右顯示
  const rows = [...hist].reverse();
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.net)), 1);

  // 計算連買/連賣天數（從最新往前數）
  let streak = 0;
  for (const r of hist) {
    if (hist[0].net > 0 ? r.net > 0 : r.net < 0) streak++;
    else break;
  }
  const streakDir  = hist[0]?.net >= 0 ? '連買' : '連賣';
  const streakCls  = hist[0]?.net >= 0 ? 'down' : 'up';   // 買超紅、賣超綠
  const totalNet   = hist.reduce((s, r) => s + r.net, 0);
  const totalCls   = totalNet >= 0 ? 'down' : 'up';

  // 圖表高度 80px，中線在 50%（40px）
  // 買超 → 從中線往上長（紅色）
  // 賣超 → 從中線往下長（綠色）
  const CHART_H = 80;
  const MAX_BAR = CHART_H / 2 - 2;

  const bars = rows.map(r => {
    const h     = Math.round(Math.abs(r.net) / maxAbs * MAX_BAR);
    const cls   = r.net >= 0 ? 'down' : 'up';   // 買超紅、賣超綠
    const tip   = `${r.date}  ${r.net >= 0 ? '+' : ''}${_fmtNum(r.net)} 張`;
    // 正值：bottom 從 50% 往上；負值：top 從 50% 往下
    const style = r.net >= 0
      ? `position:absolute;bottom:50%;height:${h}px;left:1px;right:1px`
      : `position:absolute;top:50%;height:${h}px;left:1px;right:1px`;
    return `<div class="fh-bar-wrap" title="${tip}" style="position:relative;flex:1;height:${CHART_H}px">
      <div class="fh-bar ${cls}" style="${style}"></div>
    </div>`;
  }).join('');

  return `
    <div class="fh-summary">
      <span class="fh-stat">近 ${hist.length} 日合計
        <strong class="${totalCls}">${totalNet >= 0 ? '+' : ''}${_fmtNum(totalNet)}</strong> 張
      </span>
      <span class="fh-streak ${streakCls}">連續 ${streak} 日${streakDir}</span>
    </div>
    <div style="position:relative;margin:8px 16px;height:${CHART_H}px;display:flex;align-items:stretch;gap:2px">
      <div class="fh-zero-line" style="position:absolute;left:0;right:0;top:50%;border-top:1px dashed rgba(255,255,255,0.2);z-index:0"></div>
      ${bars}
    </div>
    <div class="fh-dates" style="margin:0 16px">
      <span>${rows[0]?.date?.slice(5) ?? ''}</span>
      <span>${rows[rows.length - 1]?.date?.slice(5) ?? ''}</span>
    </div>`;
}

function _renderChipBars(inst) {
  const items = [
    { name: '外資',   val: inst.foreign },
    { name: '投信',   val: inst.trust   },
    { name: '自營商', val: inst.dealer  },
    { name: '合計',   val: inst.total, highlight: true  },
  ];

  const cards = items.map(({ name, val, highlight }) => {
    const cls   = val > 0 ? 'down' : val < 0 ? 'up' : '';
    const sign  = val > 0 ? '+' : '';
    const desc  = val > 0 ? '買超' : val < 0 ? '賣超' : '持平';
    return `
      <div class="chip-card${highlight ? ' chip-card-total' : ''}">
        <div class="chip-card-name">${name}</div>
        <div class="chip-card-val ${cls}">${sign}${_fmtNum(val)}</div>
        <div class="chip-card-desc ${cls}">${desc}</div>
      </div>`;
  }).join('');

  return `<div class="chip-card-grid">${cards}</div>`;
}

// ─────────────────────────────────────────────
// 基本面面板（子 Tab 架構）
// ─────────────────────────────────────────────
async function _loadFundamental(symbol, code) {
  if (_fundCode !== code) {
    _fundData    = null;
    _revenueData = null;
    _fundCode    = code;
    // 清掉舊財報/籌碼資料,避免人格用到前一檔的資料
    window.__lastFundamentals = null;
    window.__lastChips = null;
  }

  const el       = document.getElementById('fundamentalPanel');
  const hasToken = !!getFinMindToken();

  el.innerHTML = `
    <div class="fund-subtab-bar">
      <button class="fund-subtab active" data-fund-tab="overview">總覽</button>
      <button class="fund-subtab" data-fund-tab="eps">EPS 季報</button>
      <button class="fund-subtab" data-fund-tab="revenue">月營收</button>
      <button class="fund-subtab" data-fund-tab="margin">三率</button>
      <button class="fund-refresh-btn" id="fundRefreshBtn" title="清除快取，重新抓取">↺</button>
    </div>
    <div id="fundOverview" class="fund-subpanel active"><div class="panel-loading">載入中</div></div>
    <div id="fundEps"      class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>
    <div id="fundRevenue"  class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>
    <div id="fundMargin"   class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>`;

  el.querySelectorAll('.fund-subtab').forEach(btn => {
    btn.addEventListener('click', async () => {
      el.querySelectorAll('.fund-subtab').forEach(b => b.classList.remove('active'));
      el.querySelectorAll('.fund-subpanel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tab     = btn.dataset.fundTab;
      const panelEl = document.getElementById(`fund${_cap(tab)}`);
      if (panelEl) {
        panelEl.classList.add('active');
        if (!panelEl.dataset.loaded) {
          panelEl.innerHTML = '<div class="panel-loading">載入中</div>';
        }
      }
      await _renderFundTab(tab, code, hasToken);
    });
  });

  // 重新整理按鈕：清快取後重新載入
  document.getElementById('fundRefreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('fundRefreshBtn');
    if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
    await clearFundCache(code);
    _fundData    = null;
    _revenueData = null;
    // 清除所有子面板的 loaded 旗標
    el.querySelectorAll('.fund-subpanel').forEach(p => delete p.dataset.loaded);
    // 重新載入目前顯示的子頁
    const activeTab = el.querySelector('.fund-subtab.active')?.dataset?.fundTab ?? 'overview';
    const activePanel = document.getElementById(`fund${_cap(activeTab)}`);
    if (activePanel) activePanel.innerHTML = '<div class="panel-loading">載入中</div>';
    await _renderFundTab(activeTab, code, hasToken);
    if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
  });

  await _renderFundTab('overview', code, hasToken);
  _loaded.fundamental = true;
}

function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function _renderFundTab(tab, code, hasToken) {
  const panelEl = document.getElementById(`fund${_cap(tab)}`);
  if (!panelEl || panelEl.dataset.loaded === '1') return;
  try {
    switch (tab) {
      case 'overview': await _fundOverview(panelEl, code, hasToken); break;
      case 'eps':      await _fundEps(panelEl, code, hasToken);      break;
      case 'revenue':  await _fundRevenue(panelEl, code, hasToken);  break;
      case 'margin':   await _fundMargin(panelEl, code, hasToken);   break;
    }
    panelEl.dataset.loaded = '1';
  } catch (e) {
    panelEl.innerHTML = `<div class="panel-error">載入失敗：${_escHtml(e.message)}</div>`;
  }
}

async function _ensureFund(symbol, code) {
  if (!_fundData) _fundData = await fetchFundamentals(symbol, code);
  // 讓 AI 圓桌(personas)的老牛能讀到財報資料
  if (_fundData) {
    window.__lastFundamentals = _fundData;
    // 同步觸發 personas 重渲染(若 AI 圓桌 panel 已開過)
    try {
      window.dispatchEvent(new CustomEvent('fundamentalsUpdated', { detail: { code, data: _fundData } }));
    } catch (_) {}
  }
  return _fundData;
}

// ── 總覽 ──────────────────────────────────────
async function _fundOverview(el, code, hasToken) {
  const symbol = toYahooSymbol(code);
  const data   = await _ensureFund(symbol, code);
  if (!data) { el.innerHTML = '<div class="panel-error">基本面資料無法取得</div>'; return; }

  const pct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const num = v => v != null ? Number(v).toFixed(2) : '—';
  const cap = v => {
    if (v == null) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(1) + ' 兆';
    if (v >= 1e8)  return (v / 1e8).toFixed(1)  + ' 億';
    return Number(v).toLocaleString();
  };

  const sourceNote = data._source === 'finmind'
    ? '<span style="color:var(--accent)">FinMind 完整版</span>'
    : hasToken
      ? '<span style="color:var(--down)">FinMind 載入失敗，顯示基礎版</span>'
      : `基礎版 · <span style="color:var(--accent);cursor:pointer" id="goSetToken">設定 Token →</span>`;

  // 淨利率：優先從三率最新季補算
  let profitMargin = data.profitMargin;
  if (profitMargin == null && data._marginSeries?.length) {
    const nm = data._marginSeries[0]?.netMargin;
    if (nm != null) profitMargin = nm / 100;
  }

  // 最新毛利率
  const grossMargin = data._marginSeries?.[0]?.grossMargin;
  const opMargin    = data._marginSeries?.[0]?.operatingMargin;

  el.innerHTML = `
    <div class="fund-overview-note">資料來源：${sourceNote}</div>
    <div class="info-grid">
      ${_cell('本益比（PE）',         num(data.pe))}
      ${_cell('EPS（最新季）',        num(data.eps))}
      ${_cell('股價淨值比（PB）',     num(data.pbRatio))}
      ${_cell('股息殖利率',           pct(data.dividendYield))}
      ${_cell('現金股利',             data.dividendRate != null ? Number(data.dividendRate).toFixed(2) + ' 元' : '—')}
      ${_cell('市值',                 cap(data.marketCap))}
      ${_cell('52週高點',             num(data.fiftyTwoWeekHigh))}
      ${_cell('52週低點',             num(data.fiftyTwoWeekLow))}
      ${_cellColor('毛利率（最新季）', grossMargin != null ? grossMargin.toFixed(1) + '%' : '—', grossMargin)}
      ${_cellColor('營益率（最新季）', opMargin    != null ? opMargin.toFixed(1)    + '%' : '—', opMargin)}
      ${_cellColor('淨利率（最新季）', profitMargin != null ? pct(profitMargin) : '—',            profitMargin)}
      ${_cellColor('營收成長率（YoY）', pct(data.revenueGrowth),  data.revenueGrowth)}
      ${_cellColor('獲利成長率（YoY）', pct(data.earningsGrowth), data.earningsGrowth)}
    </div>
    ${data.sector || data.industry ? `
    <div class="panel-section">
      <div class="panel-section-title">產業資訊</div>
      <div class="info-grid">
        ${data.sector   ? _cell('產業類別', data.sector)   : ''}
        ${data.industry ? _cell('細分產業', data.industry) : ''}
      </div>
    </div>` : ''}`;

  document.getElementById('goSetToken')?.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('openSettings')));
}

function _renderEpsMini(series) {
  // series 是升冪（舊→新），最多8季
  // 圖表高度 40px，中線在 50%（20px）
  // 正值：從中線往上，負值：從中線往下
  const CHART_H = 40;
  const maxAbs  = Math.max(...series.map(r => Math.abs(r.eps)), 0.01);

  const bars = series.map((r, i) => {
    const h      = Math.round(Math.abs(r.eps) / maxAbs * (CHART_H / 2 - 2));
    const cls    = r.eps >= 0 ? 'down' : 'up';   // 台股：正值紅，負值綠
    const q      = r.date?.slice(0, 7) ?? '';
    const tip    = `${q}  EPS: ${r.eps}`;
    const isLatest = i === series.length - 1;
    // 正值：bottom 從 50% 往上；負值：top 從 50% 往下
    const style  = r.eps >= 0
      ? `position:absolute;bottom:50%;height:${h}px;left:0;right:0`
      : `position:absolute;top:50%;height:${h}px;left:0;right:0`;
    return `<div class="eps-bar-wrap${isLatest ? ' fh-bar-latest' : ''}" title="${tip}" style="position:relative;flex:1;max-width:32px;height:${CHART_H}px">
      <div class="fh-bar ${cls}" style="${style}"></div>
      ${isLatest ? `<div class="fh-bar-label">${r.eps >= 0 ? '+' : ''}${r.eps}</div>` : ''}
    </div>`;
  }).join('');

  return `
    <div style="position:relative;margin:4px 16px;height:${CHART_H}px;display:flex;align-items:stretch;gap:6px">
      <div class="fh-zero-line" style="position:absolute;left:0;right:0;top:50%"></div>
      ${bars}
    </div>
    <div class="fh-dates" style="margin:0 16px 4px">
      <span>${series[0]?.date?.slice(0, 7) ?? ''}</span>
      <span>${series[series.length-1]?.date?.slice(0, 7) ?? ''}</span>
    </div>`;
}

function _cell(label, value) {
  return `<div class="info-cell">
    <div class="info-cell-label">${label}</div>
    <div class="info-cell-value">${value}</div>
  </div>`;
}
function _cellColor(label, display, raw) {
  const cls = raw != null ? (raw >= 0 ? 'up' : 'down') : '';
  return `<div class="info-cell">
    <div class="info-cell-label">${label}</div>
    <div class="info-cell-value ${cls}">${display}</div>
  </div>`;
}

// ── EPS 季報 ──────────────────────────────────
async function _fundEps(el, code, hasToken) {
  if (!hasToken) { _noToken(el); return; }
  const symbol = toYahooSymbol(code);
  const data   = await _ensureFund(symbol, code);
  const series = data?._epsSeries ?? [];
  if (!series.length) { el.innerHTML = '<div class="panel-error">無 EPS 歷史資料</div>'; return; }

  // EPS 走勢 mini 圖（升冪，舊→新）
  const epsAsc     = [...series].reverse();
  const epsBarHtml = _renderEpsMini(epsAsc.slice(-8));

  const rows = series.map((item, i) => {
    const prev4  = series[i + 4];
    const yoy    = prev4 && Math.abs(prev4.eps) > 0.001
      ? ((item.eps - prev4.eps) / Math.abs(prev4.eps)) * 100
      : null;
    const yoyHtml = yoy != null
      ? `<span class="${yoy >= 0 ? 'up' : 'down'}">${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%</span>`
      : '<span class="fund-muted">—</span>';
    return `<tr>
      <td>${_fmtQ(item.date)}</td>
      <td class="${item.eps >= 0 ? '' : 'down'}">${item.eps.toFixed(2)}</td>
      <td>${yoyHtml}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="panel-section" style="margin-bottom:4px">
      <div class="panel-section-title">EPS 走勢（近 8 季）</div>
      ${epsBarHtml}
    </div>
    ${_tbl('<tr><th>季度</th><th>EPS（元）</th><th>YoY</th></tr>', rows)}`;
}

// ── 月營收 ────────────────────────────────────
async function _fundRevenue(el, code, hasToken) {
  if (!hasToken) { _noToken(el); return; }
  if (!_revenueData) _revenueData = await fetchFinMindRevenue(code);
  const rows = _revenueData;
  if (!rows.length) { el.innerHTML = '<div class="panel-error">無月營收資料</div>'; return; }

  // FinMind revenue 欄位單位為千元
  const toAmt = v => {
    const n = Number(v) * 1000;   // 千元 → 元
    if (isNaN(n)) return '—';
    if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 億';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 萬';
    return n.toLocaleString();
  };
  const fmtP = v => v == null
    ? '<span class="fund-muted">—</span>'
    : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;

  const tableRows = rows.map((r, i) => {
    const rev    = Number(r.revenue);
    const prev1  = rows[i + 1]  ? Number(rows[i + 1].revenue)  : null;
    const prev12 = rows[i + 12] ? Number(rows[i + 12].revenue) : null;
    const mom = prev1  && prev1  > 0 ? ((rev - prev1)  / prev1)  * 100 : null;
    const yoy = prev12 && prev12 > 0 ? ((rev - prev12) / prev12) * 100 : null;
    return `<tr>
      <td>${r.date?.slice(0, 7) ?? '—'}</td>
      <td>${toAmt(rev)}</td>
      <td>${fmtP(mom)}</td>
      <td>${fmtP(yoy)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = _tbl('<tr><th>月份</th><th>營收</th><th>MoM</th><th>YoY</th></tr>', tableRows);
}

// ── 三率 ──────────────────────────────────────
async function _fundMargin(el, code, hasToken) {
  if (!hasToken) { _noToken(el); return; }
  const symbol = toYahooSymbol(code);
  const data   = await _ensureFund(symbol, code);
  const series = data?._marginSeries ?? [];
  if (!series.length) { el.innerHTML = '<div class="panel-error">無三率歷史資料</div>'; return; }

  const pct = v => v != null
    ? `<span class="${v >= 0 ? 'up' : 'down'}">${v.toFixed(1)}%</span>`
    : '<span class="fund-muted">—</span>';

  const tableRows = series.map(r => `<tr>
    <td>${_fmtQ(r.date)}</td>
    <td>${pct(r.grossMargin)}</td>
    <td>${pct(r.operatingMargin)}</td>
    <td>${pct(r.netMargin)}</td>
  </tr>`).join('');

  el.innerHTML = _tbl('<tr><th>季度</th><th>毛利率</th><th>營益率</th><th>淨利率</th></tr>', tableRows);
}

// ── 共用 helpers ─────────────────────────────
function _tbl(thead, tbody) {
  return `<div class="fund-table-wrap">
    <table class="fund-table">
      <thead>${thead}</thead>
      <tbody>${tbody}</tbody>
    </table>
  </div>`;
}

function _noToken(el) {
  el.innerHTML = `
    <div class="fund-notoken">
      <p>需設定 FinMind Token 才能查看歷史資料</p>
      <button id="goSetTokenFund">前往設定 →</button>
    </div>`;
  document.getElementById('goSetTokenFund')?.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('openSettings')));
}

function _fmtQ(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr.slice(0, 7);
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `${d.getFullYear()} Q${q}`;
}

// ─────────────────────────────────────────────
// 新聞面板
// ─────────────────────────────────────────────
async function _loadNews(symbol, stockName) {
  const items = await fetchNews(symbol, stockName);
  _loaded.news = true;
  const el = document.getElementById('newsPanel');
  if (!items.length) { el.innerHTML = '<div class="panel-error">目前沒有相關新聞</div>'; return; }
  el.innerHTML = `<div class="news-list">
    ${items.map(n => {
      const date = n.publishTime
        ? new Date(n.publishTime * 1000).toLocaleDateString('zh-TW', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
          })
        : '';
      return `<a class="news-item" href="${n.link}" target="_blank" rel="noopener">
        <div class="news-title">${_escHtml(n.title)}</div>
        <div class="news-meta">
          <span class="news-publisher">${_escHtml(n.publisher ?? '')}</span>
          <span>${date}</span>
        </div>
      </a>`;
    }).join('')}
  </div>`;
}

// ─────────────────────────────────────────────
// 公告面板
// ─────────────────────────────────────────────
async function _loadAnnouncement(code) {
  const items = await fetchAnnouncements(code);
  _loaded.announcement = true;
  const el = document.getElementById('announcementPanel');
  if (!items.length) { el.innerHTML = '<div class="panel-error">目前沒有重大訊息公告</div>'; return; }
  el.innerHTML = `<div class="announcement-list">
    ${items.map(a => `
      <a class="announcement-item" href="${a.url || '#'}" target="_blank" rel="noopener"
         ${!a.url ? 'style="cursor:default"' : ''}>
        <div class="announcement-date">${_escHtml(a.date)}</div>
        <div class="announcement-subject">${_escHtml(a.subject)}</div>
      </a>`).join('')}
  </div>`;
}

// ─────────────────────────────────────────────
// 工具函式
// ─────────────────────────────────────────────
function _setLoading(panelId) {
  const el = document.getElementById(panelId);
  if (el) el.innerHTML = '<div class="panel-loading">載入中</div>';
}
function _fmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString();
}
function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// 個股訊號標籤（供 main.js 在 candles 載入後呼叫）
// ─────────────────────────────────────────────

/**
 * 用已載入的 candles 比對策略，渲染訊號標籤到 #stockSignalTags
 * @param {Candle[]} candles
 * @param {string}  code
 */
/**
 * ensureFundamentals：供外部呼叫（如全視窗基本面模組的「載入」按鈕）
 * 確保 _fundData 已載入並注入 window.__lastFundamentals
 * 若已有快取則直接回傳，不重複打 API
 */
export async function ensureFundamentals(code) {
  const symbol = toYahooSymbol(code);
  return await _ensureFund(symbol, code);
}

export async function renderStockSignals(candles, code) {
  const container = document.getElementById('stockSignalTags');
  if (!container) return;

  if (!AppState.signals) AppState.signals = {};

  // ── 若今天已有掃描結果，直接用，不重算（避免 candles 長度差異造成燈號跳動）
  // ⚠️ 例外：從篩選器點進來的股票，篩選器用 3mo(65根) 算，
  //   自選快取用 6mo(130根) 算，週期不同可能造成 X2 等訊號不一致。
  //   必須強制用 slice(-65) 重算，讓個股頁與篩選結果一致。
  const existing   = AppState.signals[code];
  const scannedAt  = existing?._scannedAt ?? 0;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const fromScreener = AppState.screenerContext?.code === code;
  const isFresh    = scannedAt >= todayStart && Array.isArray(existing) && !fromScreener;

  let signals;
  // ── 妖股補強：不管快取或重算，都要補強 ──
  // isFresh 快取中沒有妖股補強，要每次進個股都補
  const _yaoguRecord = await getYaoguRecord(code).catch(() => null);

  if (isFresh) {
    // 今天已掃過（非篩選器來源）→ 直接用，但仍補強妖股標籤
    signals = injectYaoguSignals(existing, _yaoguRecord);
  } else {
    // 從篩選器來：強制用 slice(-65) 與篩選器一致；其他：用完整 candles 重算
    const twseRow    = window.__priceCache?.[code] ?? null;
    const calcCandles = fromScreener
      ? (candles.length > 65 ? candles.slice(-65) : candles)
      : candles;
    signals = matchSignals(calcCandles, twseRow);
    signals = injectYaoguSignals(signals, _yaoguRecord);

    AppState.signals[code] = signals;
    AppState.signals[code]._scannedAt = Date.now();

    // 寫進 IndexedDB
    setSignalsCache(code, signals).catch(e =>
      console.warn(`[stock-tabs] setSignalsCache(${code}) 失敗:`, e?.message)
    );

    document.dispatchEvent(new CustomEvent('signalsUpdated', {
      detail: { [code]: signals },
    }));
  }

  // v2.8 妖股狀態機：不管快取或重算，都要更新 yaogu tracker（算 streak）
  updateYaoguTracker(code, signals, candles).then(ys => {
    if (ys) {
      if (!AppState.yaoguStatus) AppState.yaoguStatus = {};
      AppState.yaoguStatus[code] = ys;
      document.dispatchEvent(new CustomEvent('yaoguUpdated', { detail: { code, ys } }));
    }
  }).catch(() => {});

  // ── v2.6 雙保險：若 signals 來自快取（isFresh=true），可能沒帶 _difPos
  //   這裡用當下 candles 重新計算一次,確保 calcSignalLamps 拿得到 DIF 狀態
  if (signals && signals._difPos === undefined) {
    try {
      const closes = candles.map(c => c.close);
      const { dif } = calcMACD(closes);
      const n = dif?.length ?? 0;
      if (n > 0 && Number.isFinite(dif[n - 1])) {
        signals._difPos = dif[n - 1] > 0;
      }
    } catch (_) {}
  }

  _renderSignalTags(container, signals);
  _renderSignalLamps(signals);
  // ── 篩選器來源：在燈號後方加一排篩選條件標籤 ──
  _renderScreenerCondTags(container, code);

  // v2.8 妖股狀態機：個股頁明確提示
  // 先用 AppState 快速渲染一次（可能沒有 streak）
  _renderYaoguChip(code, signals);

  // 監聽 updateYaoguTracker 算完的事件，streak 算好後重繪一次
  const _onYaoguUpdated = async (e) => {
    if (e.detail?.code !== code) return;
    document.removeEventListener('yaoguUpdated', _onYaoguUpdated);

    // streak 寫進 DB 後，重新 inject 確保 X 系列 chip 拿到最新保留訊號
    try {
      const latestRecord = await getYaoguRecord(code).catch(() => null);
      if (latestRecord) {
        const injected = injectYaoguSignals(
          AppState.signals?.[code] ?? signals,
          latestRecord
        );
        // 更新 AppState（讓全視窗 evaluate 也能拿到）
        if (!AppState.signals) AppState.signals = {};
        AppState.signals[code] = injected;
        injected._scannedAt = AppState.signals[code]?._scannedAt ?? Date.now();

        // 重繪 chip 列（X 系列標籤）
        if (container) _renderSignalTags(container, injected);
        _renderSignalLamps(injected);
      }
    } catch(e) { /* silent */ }

    // 重繪妖股狀態 chip
    _renderYaoguChip(code, AppState.signals?.[code] ?? signals);
  };
  document.addEventListener('yaoguUpdated', _onYaoguUpdated);
  // 10 秒後自動清除監聽（防止 memory leak）
  setTimeout(() => document.removeEventListener('yaoguUpdated', _onYaoguUpdated), 10000);
}

/**
 * v2.8 個股頁妖股狀態 chip（明確提示版）
 * 插入到 #stockYaoguChip 容器（若無則自動插入到 stockSignalTags 之前）
 */
async function _renderYaoguChip(code, signals) {
  let el = document.getElementById('stockYaoguChip');
  if (!el) {
    const signalContainer = document.getElementById('stockSignalTags');
    if (!signalContainer) return;
    el = document.createElement('div');
    el.id = 'stockYaoguChip';
    signalContainer.parentNode.insertBefore(el, signalContainer);
  }

  try {
    // 優先從 AppState 讀（updateYaoguTracker 跑完後寫入，含最新 streak）
    let ys = AppState.yaoguStatus?.[code] ?? null;
    if (!ys) {
      const record = await getYaoguRecord(code);
      const streak = record?.streak ?? null;
      ys = getYaoguStatus(code, signals, record, streak);
    }

    if (!ys) { el.innerHTML = ''; return; }

    // 有 DB 記錄才顯示重置按鈕
    const record = await getYaoguRecord(code);
    const exitBtn = record
      ? `<button class="yaogu-reset-btn" data-code="${code}" title="重置妖股追蹤記錄">↺ 重置</button>`
      : '';

    el.innerHTML = `
      <div class="yaogu-chip" style="border-color:${ys.color};color:${ys.color}">
        <span class="yaogu-chip-label">${ys.label}</span>
        <span class="yaogu-chip-desc">${ys.desc ?? ''}</span>
        ${exitBtn}
      </div>`;

    el.querySelector('.yaogu-reset-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteYaoguRecord(code);
      delete AppState.yaoguStatus?.[code];
      _renderYaoguChip(code, signals);
      console.log(`[yaogu] 手動重置: ${code}`);
    });
  } catch (e) {
    console.warn('[yaogu] _renderYaoguChip 失敗:', e.message);
    el.innerHTML = '';
  }
}

/**
 * v2.8 短線健康度 + X 系列訊號加成（公用 helper）
 *
 * 讓任何地方只需一行就能取得「含 X 系列加成」的短線健康度：
 *   const score = calcHealthWithSignals(candles, code);
 *
 * 內部邏輯：
 *   1. 從 AppState.signals[code] 取當前訊號（signal-scan 已掃過）
 *   2. 傳給 calcHealth(candles, signals) 計算含加成的健康度
 *   3. 若 signals 不存在或沒有 X 系列 → 行為與原版 calcHealth 一致
 *
 * ⚠️ 呼叫端（market.js / portfolio-ui.js / chart-analysis-card.js）
 *    只需把原本的 calcHealth(candles) 改成 calcHealthWithSignals(candles, code)
 *    health.js 的 calcHealth 本身向後相容，不影響其他呼叫點
 *
 * @param {Candle[]} candles
 * @param {string}   code     股票代號，用來查 AppState.signals[code]
 * @returns {number|null}
 */
export function calcHealthWithSignals(candles, code) {
  const signals = AppState.signals?.[code] ?? [];
  return calcHealth(candles, signals);
}

/**
 * 渲染個股頁籤的五燈號（v2.6）
 * 目標容器：#stockSignalLamps（個股 K 線標題列附近）
 * 若 DOM 找不到容器則靜默跳過（避免報錯）
 */
function _renderSignalLamps(signals) {
  const host = document.getElementById('stockSignalLamps');
  if (!host) return;

  const lamps = calcSignalLamps(signals, signals?._difPos !== false);

  if (lamps === 0) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }
  host.style.display = '';

  const abs = Math.abs(lamps);
  const isBull   = lamps > 0;
  const isBear   = lamps < 0;
  const isGolden = isBull && abs >= 5.0;
  const isDanger = isBear && abs >= 5.0;

  let rowClass = 'lamp-row ';
  if      (isGolden) rowClass += 'lamp-golden';
  else if (isDanger) rowClass += 'lamp-danger';
  else if (isBull)   rowClass += 'lamp-bull';
  else               rowClass += 'lamp-bear';

  const dots = [];
  for (let i = 1; i <= 5; i++) {
    const filled = abs >= i;
    const half   = !filled && abs >= i - 0.5;
    const cls    = filled ? 'full' : half ? 'half' : 'empty';
    dots.push(`<span class="lamp-dot ${cls}"></span>`);
  }

  // tooltip：列出所有觸發策略
  const sigList = Array.isArray(signals) ? signals : [];
  const tip = sigList.map(s => `${s.icon ?? ''} ${s.name}`).join('、');
  const labelTxt = isGolden ? '🏆 金燈'
                  : isDanger ? '⛔ 死亡綠燈'
                  : isBull   ? `${abs.toFixed(1)} 燈 (做多)`
                  :            `${abs.toFixed(1)} 燈 (避險)`;

  host.innerHTML =
    `<span class="lamp-label" title="${_escHtml(tip)}">${labelTxt}</span>` +
    `<div class="${rowClass}" title="${_escHtml(tip)}">${dots.join('')}</div>`;
}

/**
 * 篩選器條件標籤：在 #stockSignalTags 後面加一排來自篩選器的符合條件
 * AppState.screenerContext = { code, matchedConds[] }
 */
function _renderScreenerCondTags(container, code) {
  // 移除舊的篩選條件區塊
  container.parentElement?.querySelectorAll('.screener-cond-tags').forEach(el => el.remove());

  const ctx = AppState.screenerContext;
  if (!ctx || ctx.code !== code || !ctx.matchedConds?.length) return;

  const wrap = document.createElement('div');
  wrap.className = 'screener-cond-tags';
  wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;padding:6px 8px;background:rgba(99,102,241,0.08);border-radius:8px;border:1px solid rgba(99,102,241,0.2)';
  wrap.innerHTML =
    `<span class="screener-cond-label" style="font-size:11px;color:var(--muted);white-space:nowrap">🔍 篩出原因</span>` +
    ctx.matchedConds.map(label =>
      `<span class="screener-cond-tag" style="font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3)">${label}</span>`
    ).join('');

  // 插在 stockSignalTags 之後
  container.insertAdjacentElement('afterend', wrap);
}

function _clearSignalTags() {
  const container = document.getElementById('stockSignalTags');
  if (container) container.innerHTML = '';
  // 同時清除篩選條件標籤
  document.querySelectorAll('.screener-cond-tags').forEach(el => el.remove());
}

function _renderSignalTags(container, signals) {
  if (!signals.length) {
    container.innerHTML = '';
    _removeMobileSummary(container);
    return;
  }

  const CATEGORY_COLOR = {
    '強勢續漲': '#26a69a',
    '超跌反彈': '#3b82f6',
    '轉折訊號': '#f59e0b',
    '葛蘭碧':   '#a78bfa',
    'X 系列':   '#facc15',
  };

  const tagsHtml = signals.map(s => {
    const color = CATEGORY_COLOR[s.category] ?? '#8a8f99';
    return `<span class="signal-tag" style="border-color:${color};color:${color}" title="${_escHtml(s.desc)}">
      ${s.icon} ${_escHtml(s.name)}
    </span>`;
  }).join('');

  // 桌面版：正常渲染
  container.innerHTML = tagsHtml;

  // 手機版：額外渲染折疊 summary（插在 container 後面）
  _renderMobileSignalSummary(container, signals, tagsHtml, CATEGORY_COLOR);
}

/**
 * 手機版訊號標籤折疊 summary
 * 顯示：「3.5燈 🔴🔴🔴🔘○ + N個訊號 ▾」，點開展開全部標籤
 */
function _renderMobileSignalSummary(container, signals, tagsHtml, CATEGORY_COLOR) {
  // 移除舊的 summary
  _removeMobileSummary(container);

  const summary = document.createElement('div');
  summary.className = 'signal-tags-summary';

  const count = signals.length;
  // 取前 2 個訊號顯示為預覽 pill
  const preview = signals.slice(0, 2).map(s => {
    const color = CATEGORY_COLOR[s.category] ?? '#8a8f99';
    return `<span class="signal-tag" style="border-color:${color};color:${color};font-size:10px;padding:1px 6px">
      ${s.icon} ${_escHtml(s.name)}
    </span>`;
  }).join('');

  const moreCount = count > 2 ? count - 2 : 0;

  summary.innerHTML = `
    ${preview}
    ${moreCount > 0 ? `<button class="signal-tags-toggle" id="signalTagsToggle">
      +${moreCount} 個 <span style="font-size:9px">▾</span>
    </button>` : ''}
    <div class="signal-tags-expanded" id="signalTagsExpanded">
      ${tagsHtml}
    </div>
  `;

  container.insertAdjacentElement('afterend', summary);

  // 展開/收起
  summary.querySelector('#signalTagsToggle')?.addEventListener('click', () => {
    const exp    = summary.querySelector('#signalTagsExpanded');
    const toggle = summary.querySelector('#signalTagsToggle');
    if (!exp) return;
    const isOpen = exp.classList.toggle('open');
    if (toggle) toggle.innerHTML = isOpen
      ? `收起 <span style="font-size:9px">▴</span>`
      : `+${moreCount} 個 <span style="font-size:9px">▾</span>`;
  });
}

function _removeMobileSummary(container) {
  container.nextElementSibling?.classList.contains('signal-tags-summary') &&
    container.nextElementSibling.remove();
}
