/**
 * stock-tabs.js
 * 個股內頁 Tab：K線圖 / 籌碼 / 基本面 / 新聞 / 公告
 * 基本面內含子 Tab：總覽 / EPS 季報 / 月營收 / 三率
 */

import {
  toYahooSymbol,
  fetchFundamentals,
  fetchFinMindRevenue,
  fetchHealthData,
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
      <button class="fund-subtab" data-fund-tab="healthcheck">健診</button>
      <button class="fund-subtab" data-fund-tab="eps">EPS 季報</button>
      <button class="fund-subtab" data-fund-tab="revenue">月營收</button>
      <button class="fund-subtab" data-fund-tab="margin">三率</button>
      <button class="fund-refresh-btn" id="fundRefreshBtn" title="清除快取，重新抓取">↺</button>
    </div>
    <div id="fundOverview"     class="fund-subpanel active"><div class="panel-loading">載入中</div></div>
    <div id="fundHealthcheck"  class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>
    <div id="fundEps"          class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>
    <div id="fundRevenue"      class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>
    <div id="fundMargin"       class="fund-subpanel"><div class="panel-loading" style="display:none"></div></div>`;

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
      case 'overview':     await _fundOverview(panelEl, code, hasToken);    break;
      case 'healthcheck':  await _fundHealthcheck(panelEl, code, hasToken); break;
      case 'eps':          await _fundEps(panelEl, code, hasToken);         break;
      case 'revenue':      await _fundRevenue(panelEl, code, hasToken);     break;
      case 'margin':       await _fundMargin(panelEl, code, hasToken);      break;
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

// ── 股票健診 ──────────────────────────────────
async function _fundHealthcheck(el, code, hasToken) {
  const symbol = toYahooSymbol(code);
  await _ensureFund(symbol, code);
  const f = _fundData;
  if (!f) { el.innerHTML = '<div class="panel-error">基本面資料載入失敗</div>'; return; }

  // 載入健診專屬資料（BS / CF / Dividend）
  el.innerHTML = '<div class="panel-loading">載入健診資料中…</div>';
  const hd = await fetchHealthData(code).catch(() => null);

  // ── 輔助：取 bsMap 最新季某欄位 ──
  function _bsLatest(key) {
    if (!hd?.bsMap?.size) return null;
    const dates = [...hd.bsMap.keys()].sort((a,b) => b.localeCompare(a));
    for (const d of dates) {
      const v = hd.bsMap.get(d)?.[key];
      if (v != null) return v;
    }
    return null;
  }

  // ── 輔助：取 cfMap 最新 N 季 operatingCF 序列（升冪）──
  function _cfSeries(n) {
    if (!hd?.cfMap?.size) return [];
    return [...hd.cfMap.entries()]
      .sort((a,b) => a[0].localeCompare(b[0]))
      .slice(-n)
      .map(([date, v]) => ({ date, operatingCF: v.operatingCF ?? null }));
  }

  // ── 輔助：Dividend 近 N 年平均現金股利 ──
  function _avgCashDiv(years) {
    if (!hd?.divRows?.length) return null;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutStr = cutoff.toISOString().slice(0,10);
    const rows = hd.divRows.filter(r => r.date >= cutStr && r.CashEarningsDistribution > 0);
    if (!rows.length) return null;
    const total = rows.reduce((s,r) => s + r.CashEarningsDistribution + (r.CashStatutorySurplus||0), 0);
    return total / rows.length;
  }

  // ── 輔助：連續配息年數 ──
  function _consecutiveDivYears() {
    if (!hd?.divRows?.length) return 0;
    const byYear = {};
    for (const r of hd.divRows) {
      const y = r.date.slice(0,4);
      if (r.CashEarningsDistribution > 0) byYear[y] = true;
    }
    const curYear = new Date().getFullYear();
    let count = 0;
    for (let y = curYear - 1; y >= curYear - 10; y--) {
      if (byYear[String(y)]) count++;
      else break;
    }
    return count;
  }

  // ── 輔助：近 N 季現金流為正的比例 ──
  function _cfPositiveRatio(n) {
    const series = _cfSeries(n);
    if (!series.length) return null;
    const valid = series.filter(s => s.operatingCF != null);
    if (!valid.length) return null;
    return valid.filter(s => s.operatingCF > 0).length / valid.length;
  }

  // ── 計算衍生指標 ──
  const liabilities   = _bsLatest('Liabilities');
  const totalAssets   = _bsLatest('TotalAssets');
  const currentAssets = _bsLatest('CurrentAssets');
  const currentLiab   = _bsLatest('CurrentLiabilities');
  const equity        = _bsLatest('Equity');
  const debtRatio     = (liabilities != null && totalAssets) ? liabilities / totalAssets : null;
  const currentRatio  = (currentAssets != null && currentLiab) ? currentAssets / currentLiab : null;
  const cfPositive    = _cfPositiveRatio(8);
  const avgDiv5y      = _avgCashDiv(5);
  const consecDivYrs  = _consecutiveDivYears();
  // ROE = 淨利 / 股東權益（用 profitMargin × revenue 近似）
  const netIncome = (f.profitMargin != null && f.eps != null && equity)
    ? f.profitMargin * (f.eps > 0 ? equity * 0.1 : null)  // 近似值
    : null;
  // 直接從 marginSeries 拿最新季 netIncome / equity
  const ms0 = f._marginSeries?.[0];
  const roe = (ms0?.netIncome != null && equity && equity > 0)
    ? (ms0.netIncome / equity) * 100 * 4  // 季轉年化
    : null;

  const epsSeries    = (f._epsSeries    || []).slice(0, 8);
  const marginSeries = (f._marginSeries || []).slice(0, 8);

  // ════════════════════════════════════════════
  // SAR 折線圖
  // ════════════════════════════════════════════
  function _sarChart(data, colorPos, colorNeg, yKey, W=260, H=64) {
    if (!data || data.length < 2) return '';
    const pts = data.slice().reverse().map(d => d[yKey] ?? null);
    const valid = pts.filter(v => v !== null);
    if (valid.length < 2) return '';
    const min = Math.min(...valid), max = Math.max(...valid);
    const range = max - min || 1;
    const pad = 8;
    const coords = pts.map((v, i) => {
      if (v === null) return null;
      const x = pad + (i / (pts.length - 1)) * (W - pad * 2);
      const y = pad + (1 - (v - min) / range) * (H - pad * 2);
      return { x, y, v };
    });
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">`;
    const base0 = pad + (1 - (0 - min) / range) * (H - pad * 2);
    const cb = Math.min(H - pad, Math.max(pad, base0));
    svg += `<line x1="${pad}" y1="${cb.toFixed(1)}" x2="${W-pad}" y2="${cb.toFixed(1)}" stroke="#2d3748" stroke-width="0.5" stroke-dasharray="3,2"/>`;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i+1];
      if (!a || !b) continue;
      svg += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${a.v >= 0 ? colorPos : colorNeg}" stroke-width="1" stroke-opacity="0.5"/>`;
    }
    for (const c of coords) {
      if (!c) continue;
      svg += `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="${c.v >= 0 ? colorPos : colorNeg}" stroke="#0d1117" stroke-width="1.5"/>`;
    }
    svg += '</svg>';
    return svg;
  }

  function _sarMultiChart(data, lines, W=260, H=72) {
    if (!data || data.length < 2) return '';
    const reversed = data.slice().reverse();
    const allVals = lines.flatMap(l => reversed.map(d => d[l.key] ?? null).filter(v => v !== null));
    if (allVals.length < 2) return '';
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const range = max - min || 1;
    const pad = 8;
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">`;
    const base0 = pad + (1 - (0 - min) / range) * (H - pad * 2);
    const cb = Math.min(H - pad, Math.max(pad, base0));
    svg += `<line x1="${pad}" y1="${cb.toFixed(1)}" x2="${W-pad}" y2="${cb.toFixed(1)}" stroke="#2d3748" stroke-width="0.5" stroke-dasharray="3,2"/>`;
    for (const l of lines) {
      const coords = reversed.map((d, i) => {
        const v = d[l.key] ?? null;
        if (v === null) return null;
        const x = pad + (i / (reversed.length - 1)) * (W - pad * 2);
        const y = pad + (1 - (v - min) / range) * (H - pad * 2);
        return { x, y };
      });
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i+1];
        if (!a || !b) continue;
        svg += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${l.color}" stroke-width="1" stroke-opacity="0.6"/>`;
      }
      for (const c of coords) {
        if (!c) continue;
        svg += `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.5" fill="${l.color}" stroke="#0d1117" stroke-width="1.2"/>`;
      }
    }
    svg += '</svg>';
    return svg;
  }

  function _quarterLabels(data, W=260) {
    if (!data || !data.length) return '';
    const items = data.slice().reverse();
    const n = items.length;
    const pad = 8;
    const indices = n <= 2 ? [0, n-1] : [0, Math.floor((n-1)/2), n-1];
    const unique = [...new Set(indices)];
    const toLabel = d => {
      const m = parseInt(d.date.slice(5,7));
      return d.date.slice(0,4) + 'Q' + Math.ceil(m/3);
    };
    const ticks = unique.map(i => {
      const x = pad + (i / (n-1||1)) * (W - pad*2);
      const anchor = i === 0 ? 'start' : i === n-1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="10" text-anchor="${anchor}" font-size="9" fill="#6e7681" font-family="monospace">${toLabel(items[i])}</text>`;
    });
    return `<svg width="${W}" height="14" viewBox="0 0 ${W} 14" style="display:block">${ticks.join('')}</svg>`;
  }

  // ── 年份分組表格 ──
  function _groupedTable(items) {
    if (!items.length) return '<span style="font-size:11px;color:#6e7681">無資料</span>';
    const groups = [];
    let curYear = null, curGroup = null;
    for (const item of items) {
      const year = item.lbl.slice(0,4);
      if (year !== curYear) { curYear = year; curGroup = { year, rows:[] }; groups.push(curGroup); }
      curGroup.rows.push(item);
    }
    let html = '<div style="display:inline-flex;flex-direction:column;gap:0;min-width:160px">';
    for (const g of groups) {
      html += `<div style="display:flex;align-items:flex-start;border-bottom:1px solid #21262d">
        <div style="width:38px;flex-shrink:0;padding:5px 0;font-size:11px;font-weight:600;color:#e6edf3;line-height:1.8">${g.year}</div>
        <div style="display:flex;flex-direction:column">`;
      for (const row of g.rows) {
        html += `<div style="display:flex;align-items:center;gap:12px;padding:4px 0;border-bottom:1px solid #1c2128">
          <span style="font-size:12px;color:#6e7681;width:20px">${row.lbl.slice(4)}</span>
          <span style="font-size:13px;font-weight:500;color:${row.color}">${row.val}</span>
        </div>`;
      }
      html += '</div></div>';
    }
    return html + '</div>';
  }

  // ── Detail 產生器 ──
  function _epsDetail() {
    const chart  = _sarChart(epsSeries, '#26a69a', '#ef5350', 'eps');
    const labels = _quarterLabels(epsSeries);
    const items  = epsSeries.map(d => {
      const m = parseInt(d.date.slice(5,7));
      return { lbl: d.date.slice(0,4)+'Q'+Math.ceil(m/3), val: (d.eps>=0?'+':'')+d.eps.toFixed(2), color: d.eps>=0?'#26a69a':'#ef5350' };
    });
    return `<div class="hc-detail"><div>${chart}${labels}</div><div style="margin-top:10px">${_groupedTable(items)}</div></div>`;
  }

  function _marginDetail(key, posColor='#58a6ff') {
    const chart  = _sarChart(marginSeries, posColor, '#ef5350', key);
    const labels = _quarterLabels(marginSeries);
    const items  = marginSeries.map(d => {
      const v = d[key]; if (v == null) return null;
      const m = parseInt(d.date.slice(5,7));
      return { lbl: d.date.slice(0,4)+'Q'+Math.ceil(m/3), val: (v>=0?'+':'')+v.toFixed(1)+'%', color: v>=0?posColor:'#ef5350' };
    }).filter(Boolean);
    return `<div class="hc-detail"><div>${chart}${labels}</div><div style="margin-top:10px">${_groupedTable(items)}</div></div>`;
  }

  function _threeRateDetail() {
    const chart  = _sarMultiChart(marginSeries, [
      { key:'grossMargin',     color:'#ffa726' },
      { key:'operatingMargin', color:'#58a6ff' },
      { key:'netMargin',       color:'#26a69a' },
    ]);
    const labels = _quarterLabels(marginSeries);
    const legend = `<div style="display:flex;gap:12px;font-size:10px;color:#8b949e;margin-top:4px">
      <span><span style="color:#ffa726">●</span> 毛利率</span>
      <span><span style="color:#58a6ff">●</span> 營業利益率</span>
      <span><span style="color:#26a69a">●</span> 淨利率</span>
    </div>`;
    const items3 = marginSeries.map(d => {
      const m = parseInt(d.date.slice(5,7));
      return { lbl: d.date.slice(0,4)+'Q'+Math.ceil(m/3), gm:d.grossMargin, om:d.operatingMargin, nm:d.netMargin };
    });
    const fmt = (v,c) => v!=null ? `<span style="font-size:12px;font-weight:500;color:${c}">${v>=0?'+':''}${v.toFixed(1)}%</span>` : '<span style="color:#444">—</span>';
    const groups = []; let cy=null, cg=null;
    for (const item of items3) {
      const y = item.lbl.slice(0,4);
      if (y!==cy) { cy=y; cg={year:y,rows:[]}; groups.push(cg); }
      cg.rows.push(item);
    }
    let tbl = '<div style="display:inline-flex;flex-direction:column;gap:0;min-width:220px">';
    tbl += `<div style="display:flex;align-items:center;padding:3px 0;border-bottom:1px solid #21262d">
      <div style="width:38px"></div><div style="width:24px"></div>
      <div style="width:52px;text-align:right;font-size:10px;color:#ffa726">毛利率</div>
      <div style="width:52px;text-align:right;font-size:10px;color:#58a6ff">營業</div>
      <div style="width:52px;text-align:right;font-size:10px;color:#26a69a">淨利率</div>
    </div>`;
    for (const g of groups) {
      tbl += `<div style="display:flex;align-items:flex-start;border-bottom:1px solid #21262d">
        <div style="width:38px;flex-shrink:0;padding:5px 0;font-size:11px;font-weight:600;color:#e6edf3;line-height:1.8">${g.year}</div>
        <div style="display:flex;flex-direction:column">`;
      for (const row of g.rows) {
        tbl += `<div style="display:flex;align-items:center;padding:3px 0;border-bottom:1px solid #1c2128">
          <span style="font-size:12px;color:#6e7681;width:24px">${row.lbl.slice(4)}</span>
          <div style="width:52px;text-align:right">${fmt(row.gm,'#ffa726')}</div>
          <div style="width:52px;text-align:right">${fmt(row.om,'#58a6ff')}</div>
          <div style="width:52px;text-align:right">${fmt(row.nm,'#26a69a')}</div>
        </div>`;
      }
      tbl += '</div></div>';
    }
    tbl += '</div>';
    return `<div class="hc-detail"><div>${chart}${labels}${legend}</div><div style="margin-top:10px">${tbl}</div></div>`;
  }

  function _bsDetail() {
    if (!hd?.bsMap?.size) return `<div class="hc-detail"><span style="font-size:12px;color:#8b949e">GAS 尚未建庫，資料待補充。目前依賴 FinMind 即時抓取。</span></div>`;
    const dates = [...hd.bsMap.keys()].sort((a,b)=>b.localeCompare(a)).slice(0,8);
    const items = dates.map(d => {
      const v = hd.bsMap.get(d);
      const dr = (v.Liabilities && v.TotalAssets) ? (v.Liabilities/v.TotalAssets*100) : null;
      const m = parseInt(d.slice(5,7));
      return dr != null ? { lbl: d.slice(0,4)+'Q'+Math.ceil(m/3), val: dr.toFixed(1)+'%', color: dr<60?'#26a69a':'#ef5350' } : null;
    }).filter(Boolean);
    const chartData = dates.map(d => {
      const v = hd.bsMap.get(d);
      const dr = (v.Liabilities && v.TotalAssets) ? v.Liabilities/v.TotalAssets*100 : null;
      return { date: d, debtRatio: dr };
    }).filter(r=>r.debtRatio!=null).reverse();
    const chart  = _sarChart(chartData, '#26a69a', '#ef5350', 'debtRatio');
    const labels = _quarterLabels(chartData);
    return `<div class="hc-detail"><div style="font-size:10px;color:#6e7681;margin-bottom:4px">負債比率趨勢</div><div>${chart}${labels}</div><div style="margin-top:10px">${_groupedTable(items)}</div></div>`;
  }

  function _cfDetail() {
    if (!hd?.cfMap?.size) return `<div class="hc-detail"><span style="font-size:12px;color:#8b949e">GAS 尚未建庫，資料待補充。</span></div>`;
    const series = _cfSeries(8);
    const items = series.slice().reverse().map(d => {
      if (d.operatingCF == null) return null;
      const m = parseInt(d.date.slice(5,7));
      const yi = d.operatingCF / 100000;
      return { lbl: d.date.slice(0,4)+'Q'+Math.ceil(m/3), val: (yi>=0?'+':'')+yi.toFixed(1)+'億', color: yi>=0?'#26a69a':'#ef5350' };
    }).filter(Boolean);
    const chart  = _sarChart(series, '#26a69a', '#ef5350', 'operatingCF');
    const labels = _quarterLabels(series);
    return `<div class="hc-detail"><div style="font-size:10px;color:#6e7681;margin-bottom:4px">營業現金流（千元）</div><div>${chart}${labels}</div><div style="margin-top:10px">${_groupedTable(items)}</div></div>`;
  }

  function _divDetail() {
    if (!hd?.divRows?.length) return `<div class="hc-detail"><span style="font-size:12px;color:#8b949e">GAS 尚未建庫，資料待補充。</span></div>`;
    const items = hd.divRows.slice(0,10).map(r => {
      const cash = r.CashEarningsDistribution + (r.CashStatutorySurplus||0);
      return { lbl: r.date.slice(0,4)+'  ', val: cash.toFixed(2)+'元', color: cash>0?'#ffa726':'#6e7681' };
    });
    const chartData = hd.divRows.slice(0,10).slice().reverse().map(r => ({
      date: r.date,
      cash: r.CashEarningsDistribution + (r.CashStatutorySurplus||0),
    }));
    const chart  = _sarChart(chartData, '#ffa726', '#6e7681', 'cash');
    const labels = _quarterLabels(chartData);
    return `<div class="hc-detail"><div style="font-size:10px;color:#6e7681;margin-bottom:4px">現金股利（元）</div><div>${chart}${labels}</div><div style="margin-top:10px">${_groupedTable(items)}</div></div>`;
  }

  // ════════════════════════════════════════════
  // 健診條目定義（三模組，無重複）
  // ════════════════════════════════════════════

  // 🛡️ 地雷股：財務安全性
  const landmineChecks = [
    {
      label: '負債比 < 60%',
      pass:  debtRatio != null ? debtRatio < 0.6 : null,
      hint:  `負債比 ${debtRatio!=null?(debtRatio*100).toFixed(1)+'%':'N/A'}，財務結構穩健`,
      failHint: `負債比 ${debtRatio!=null?(debtRatio*100).toFixed(1)+'%':'N/A'}，槓桿偏高需留意`,
      detail: () => _bsDetail(),
    },
    {
      label: '流動比率 > 1',
      pass:  currentRatio != null ? currentRatio > 1 : null,
      hint:  `流動比率 ${currentRatio!=null?currentRatio.toFixed(2):'N/A'}，短期償債能力充足`,
      failHint: `流動比率 ${currentRatio!=null?currentRatio.toFixed(2):'N/A'}，短期流動性偏緊`,
      detail: () => `<div class="hc-detail"><span style="font-size:12px;color:#8b949e">流動比率 = 流動資產 ÷ 流動負債，> 1 代表短期資產能覆蓋短期負債。目前 ${currentRatio!=null?currentRatio.toFixed(2):'N/A'}，${currentRatio!=null&&currentRatio>2?'財務彈性充裕':'注意流動性風險'}。</span></div>`,
    },
    {
      label: '營業現金流近兩年多為正',
      pass:  cfPositive != null ? cfPositive >= 0.5 : null,
      hint:  `近8季中 ${cfPositive!=null?Math.round(cfPositive*8):'-'} 季現金流為正，獲利品質佳`,
      failHint: `近8季現金流為正比例偏低，獲利含金量不足`,
      detail: () => _cfDetail(),
    },
    {
      label: 'EPS 近四季無連虧',
      pass:  (() => { const s=epsSeries.slice(0,4); return s.length>=2 && s.every(q=>q.eps>=0); })(),
      hint:  '近4季均有獲利，公司營運穩定',
      failHint: '近期有虧損季度，需留意獲利能力',
      detail: () => _epsDetail(),
    },
  ];

  // 💰 定存股：股息穩定性
  const dividendChecks = [
    {
      label: '現金殖利率 ≥ 4%',
      pass:  f.dividendYield != null ? f.dividendYield >= 0.04 : null,
      hint:  `殖利率 ${f.dividendYield!=null?(f.dividendYield*100).toFixed(2)+'%':'N/A'}，高於定存水準`,
      failHint: `殖利率 ${f.dividendYield!=null?(f.dividendYield*100).toFixed(2)+'%':'N/A'}，股息吸引力有限`,
      detail: () => `<div class="hc-detail"><span style="font-size:12px;color:#8b949e">現金殖利率 = 現金股利 ÷ 股價。4% 為台股定存股常用門檻。目前殖利率 ${f.dividendYield!=null?(f.dividendYield*100).toFixed(2)+'%':'N/A'}，現金股利 ${f.dividendRate!=null?f.dividendRate.toFixed(2):'N/A'} 元。</span></div>`,
    },
    {
      label: '連續配息 ≥ 3 年',
      pass:  consecDivYrs >= 3 ? true : (consecDivYrs === 0 && !hd?.divRows?.length ? null : false),
      hint:  `連續配息 ${consecDivYrs} 年，股利發放穩定`,
      failHint: `連續配息僅 ${consecDivYrs} 年，配息穩定性不足`,
      detail: () => _divDetail(),
    },
    {
      label: '近5年平均現金股利 > 0',
      pass:  avgDiv5y != null ? avgDiv5y > 0 : null,
      hint:  `近5年平均現金股利 ${avgDiv5y!=null?avgDiv5y.toFixed(2):'N/A'} 元`,
      failHint: `近5年平均現金股利偏低`,
      detail: () => _divDetail(),
    },
    {
      label: 'EPS 為正（支撐配息）',
      pass:  f.eps != null ? f.eps > 0 : null,
      hint:  `EPS ${f.eps!=null?f.eps.toFixed(2):'N/A'} 元，具備配息能力`,
      failHint: `EPS ${f.eps!=null?f.eps.toFixed(2):'N/A'}，獲利不足以支撐長期配息`,
      detail: () => '',
    },
  ];

  // 🚀 成長股：成長動能
  const growthChecks = [
    {
      label: 'EPS 年增率為正',
      pass:  f.earningsGrowth != null ? f.earningsGrowth > 0 : null,
      hint:  `EPS 年增 ${f.earningsGrowth!=null?(f.earningsGrowth*100).toFixed(1)+'%':'N/A'}，獲利持續成長`,
      failHint: `EPS 年增 ${f.earningsGrowth!=null?(f.earningsGrowth*100).toFixed(1)+'%':'N/A'}，獲利出現衰退`,
      detail: () => _epsDetail(),
    },
    {
      label: '營收年增率為正',
      pass:  f.revenueGrowth != null ? f.revenueGrowth > 0 : null,
      hint:  `營收年增 ${f.revenueGrowth!=null?(f.revenueGrowth*100).toFixed(1)+'%':'N/A'}，業績持續擴張`,
      failHint: `營收年增 ${f.revenueGrowth!=null?(f.revenueGrowth*100).toFixed(1)+'%':'N/A'}，業績成長動能不足`,
      detail: () => '',  // 月營收頁已有詳細，不重複
    },
    {
      label: '毛利率趨勢向上',
      pass:  (() => {
        const gm = marginSeries.filter(d=>d.grossMargin!=null).slice(0,4);
        if (gm.length < 3) return null;
        return gm[0].grossMargin > gm[gm.length-1].grossMargin;
      })(),
      hint:  `毛利率最新 ${marginSeries[0]?.grossMargin!=null?(marginSeries[0].grossMargin.toFixed(1)+'%'):'N/A'}，呈上升趨勢`,
      failHint: `毛利率呈下滑趨勢，需留意競爭壓力`,
      detail: () => _threeRateDetail(),
    },
    {
      label: 'ROE > 15%',
      pass:  roe != null ? roe > 15 : null,
      hint:  `ROE ${roe!=null?roe.toFixed(1)+'%':'N/A'}（年化），股東報酬率佳`,
      failHint: `ROE ${roe!=null?roe.toFixed(1)+'%':'N/A'}，股東報酬率偏低`,
      detail: () => _marginDetail('netMargin', '#26a69a'),
    },
  ];

  // ════════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════════
  let _moduleIdx = 0;
  const renderModule = (title, icon, iconBg, checks, desc) => {
    const mid    = `hcm${_moduleIdx++}`;
    const valid  = checks.filter(c => c.pass !== null);
    const passed = valid.filter(c => c.pass === true).length;
    const total  = valid.length;
    const pct    = total > 0 ? Math.round((passed / total) * 100) : 0;
    const radius = 34, circ = 2 * Math.PI * radius;
    const dash   = (pct / 100) * circ;
    const color  = pct >= 80 ? '#26a69a' : pct >= 50 ? '#ffa726' : '#ef5350';

    const rows = checks.map((c, i) => {
      if (c.pass === null) {
        return `<div class="hc-row hc-na">
          <span class="hc-row-icon" style="color:#6e7681">—</span>
          <div class="hc-row-body">
            <span class="hc-row-label">${c.label}</span>
          </div>
          <span class="hc-badge" style="background:#2d3748;color:#6e7681">資料不足</span>
        </div>`;
      }
      const detailHtml = c.detail();
      const badgeBg  = c.pass ? '#0d2b22' : '#2b1215';
      const badgeFg  = c.pass ? '#26a69a' : '#ef5350';
      return `<div class="hc-row hc-clickable ${c.pass?'hc-pass':'hc-fail'}"
          onclick="(function(el){
            const det=el.querySelector('.hc-detail-wrap');
            if(!det||det.dataset.empty==='1')return;
            const open=det.style.display==='block';
            det.style.display=open?'none':'block';
            el.querySelector('.hc-chevron').style.transform=open?'rotate(0deg)':'rotate(180deg)';
          })(this)" style="${detailHtml?'':'cursor:default'}">
        <span class="hc-row-icon">${c.pass?'✓':'✗'}</span>
        <div class="hc-row-body">
          <span class="hc-row-label">${c.label}</span>
          <span class="hc-row-sub" style="color:${c.pass?'#8b949e':'#ef5350'}">${c.pass?c.hint:c.failHint}</span>
          <div class="hc-detail-wrap" style="display:none" data-empty="${detailHtml?'0':'1'}">${detailHtml}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          <span class="hc-badge" style="background:${badgeBg};color:${badgeFg}">${c.pass?'通過':'未通過'}</span>
          ${detailHtml?`<span class="hc-chevron" style="font-size:10px;color:#6e7681;transition:transform .2s;display:block">▼</span>`:''}
        </div>
      </div>`;
    }).join('');

    return `
    <div class="hc-card">
      <div class="hc-top">
        <div class="hc-ring-col">
          <div class="hc-ring-wrap">
            <svg width="84" height="84" viewBox="0 0 84 84">
              <circle cx="42" cy="42" r="${radius}" fill="none" stroke="#21262d" stroke-width="7"/>
              <circle cx="42" cy="42" r="${radius}" fill="none" stroke="${color}" stroke-width="7"
                stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
                stroke-dashoffset="${(circ/4).toFixed(1)}"
                stroke-linecap="round"/>
            </svg>
            <div class="hc-ring-center">
              <span class="hc-ring-num" style="color:${color}">${passed}</span>
              <span class="hc-ring-denom">/${total}</span>
            </div>
          </div>
          <div class="hc-ring-label">通過 ${pct}%</div>
        </div>
        <div class="hc-info">
          <div class="hc-head">
            <div class="hc-icon-wrap" style="background:${iconBg}">${icon}</div>
            <span class="hc-title">${title}</span>
          </div>
          <div class="hc-pct-bar"><div class="hc-pct-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="hc-desc">${desc}</div>
        </div>
      </div>
      <div class="hc-rows">${rows}</div>
    </div>`;
  };

  el.innerHTML = `
  <div class="hc-wrap">
    <div class="hc-disclaimer">⚠️ 健診為輔助參考，不構成投資建議。數據來源：FinMind / Yahoo Finance</div>
    ${renderModule('地雷股健診','🛡️','#0d2416', landmineChecks,'排除財務危險訊號，評估公司財務安全性。')}
    ${renderModule('定存股健診','💰','#2b1e0a', dividendChecks,'評估股息穩定性與殖利率吸引力，適合追求被動收入的長期持有者。')}
    ${renderModule('成長股健診','🚀','#0d1f2b', growthChecks,  '評估業績成長動能與獲利品質，適合追求資本利得的成長型投資人。')}
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
  let _yaoguRecord = await getYaoguRecord(code).catch(() => null);

  // 篩選器來源且是 X 系列策略，但 IDB 無記錄 → 建 stub record 讓 updateYaoguTracker 能進入主流程
  // 根因：篩選器用 snapshot/65根算到 X 系列，但個股頁重算時可能不足再次觸發 X
  // strategyId 優先；舊存檔只有 strategyName，用名稱 fallback
  if (fromScreener && !_yaoguRecord) {
    const sid   = AppState.screenerContext?.strategyId ?? null;
    const sname = AppState.screenerContext?.strategyId  // 先看 id
      ? null  // id 存在，不需 name fallback
      : (AppState.screenerContext?.matchedConds ?? []).join(',');  // matchedConds 不含策略名稱，略過
    // strategyId 直接比對；沒有 id 時看 matchedConds 有無 X 系列策略名稱
    const X_ID_MAP = { X1: 'steady', X2: 'medium', X5: 'early', X6: 'medium' };
    const X_NAME_MAP = { '黃金比例': 'steady', '天黑請閉眼': 'medium', '潛龍勿用': 'early', '見龍在田': 'medium' };
    let xStrength = null;
    if (sid && X_ID_MAP[sid]) {
      xStrength = X_ID_MAP[sid];
    } else {
      // 舊存檔：從 screenerContext.strategyName（新存的）或 matchedConds 掃
      const ctxStratName = AppState.screenerContext?.strategyName ?? '';
      if (X_NAME_MAP[ctxStratName]) {
        xStrength = X_NAME_MAP[ctxStratName];
      }
    }
    if (xStrength) {
      _yaoguRecord = { code, status: 'active', strength: xStrength, activatedAt: Date.now(), streak: 1, lastUpdated: Date.now() };
    } else {
      // strategyId/strategyName 都沒有（舊 screenerContext 或快速篩未更新）
      // 仍建 stub，strength 暫用 medium，updateYaoguTracker 內部會用 K 線重算
      _yaoguRecord = { code, status: 'active', strength: 'medium', activatedAt: Date.now(), streak: 1, lastUpdated: Date.now() };
    }
  }

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
  _renderSignalBubbles(signals);
  // ── 篩選器來源：在燈號後方加一排篩選條件標籤 ──
  _renderScreenerCondTags(container, code);

  // v2.8 妖股狀態機：個股頁明確提示
  // 先用 AppState 快速渲染一次（可能沒有 streak）
  _renderYaoguChip(code, signals, candles);

  // 監聽 updateYaoguTracker 算完的事件，streak 算好後重繪一次
  const _onYaoguUpdated = async (e) => {
    if (e.detail?.code !== code) return;
    const evtYs = e.detail?.ys;
    // 只有 ys 有實質內容（status 不是 null/watching+無 streak）才認為是最終結果
    // 避免 stock-tabs 自己的 updateYaoguTracker（signals 無 X，回 null/watching）
    // 先到並移除監聽，導致後來 signal-scan.js 的完整結果收不到
    const isSubstantial = evtYs && (evtYs.status === 'active' || evtYs.status === 'warning1' || evtYs.status === 'warning2' || evtYs.status === 'exit' || evtYs.status === 'exited');
    if (!isSubstantial) return;  // 繼續等更完整的 event
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
        _renderSignalBubbles(injected);
      }
    } catch(e) { /* silent */ }

    // 重繪妖股狀態 chip
    _renderYaoguChip(code, AppState.signals?.[code] ?? signals, candles);
  };
  document.addEventListener('yaoguUpdated', _onYaoguUpdated);
  // 10 秒後自動清除監聽（防止 memory leak）
  setTimeout(() => document.removeEventListener('yaoguUpdated', _onYaoguUpdated), 10000);
}

/**
 * v2.8 個股頁妖股狀態 chip（明確提示版）
 * 插入到 #stockYaoguChip 容器（若無則自動插入到 stockSignalTags 之前）
 */
/**
 * 三線出場監控（X2 全市場實證參數：停損 -20% / 高點回落 25%）
 * 進場基準 = 妖股啟動日收盤價（record.activatedAt）
 * 回傳 null（資料不足）或 { html, breach }
 */
function _calcExitLines(record, candles, code) {
  if (!record?.activatedAt || !candles?.length) return null;

  const STOP_PCT  = 20;   // 2026-06-10 全市場 1950 檔回測實證
  const TRAIL_PCT = 25;

  // 找啟動日對應的 K 棒（取 ≥ activatedAt 的第一根；K 線 time 多為秒級或 'YYYY-MM-DD'）
  const actTs = Math.floor(record.activatedAt / 1000);
  let entryIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const t = typeof candles[i].time === 'number'
      ? candles[i].time
      : Math.floor(new Date(candles[i].time + 'T00:00:00+08:00').getTime() / 1000);
    if (t >= actTs - 86400) { entryIdx = i; break; }
  }
  if (entryIdx < 0) entryIdx = Math.max(0, candles.length - (record.streak ?? 1));

  const closes = candles.map(c => c.close);
  const entry  = closes[entryIdx];
  if (!entry) return null;

  const cur   = window.__priceCache?.[code]?.price ?? closes[closes.length - 1];
  const peak  = Math.max(...closes.slice(entryIdx), cur);
  const stopLine  = entry * (1 - STOP_PCT / 100);
  const trailLine = peak  * (1 - TRAIL_PCT / 100);
  const retPct    = (cur / entry - 1) * 100;

  const stopHit  = cur <= stopLine;
  const trailHit = retPct > 0 && cur <= trailLine;
  const distStop  = (cur / stopLine  - 1) * 100;
  const distTrail = (cur / trailLine - 1) * 100;

  const fmt = v => v >= 100 ? v.toFixed(0) : v.toFixed(2);
  let html, breach = stopHit || trailHit;

  if (stopHit) {
    html = `<div class="yaogu-chip-row-warning" style="border-top:1px solid rgba(239,83,80,.3)">
      <span class="yaogu-chip-label" style="color:#ef4444">📏 跌破停損線 ${fmt(stopLine)}</span>
      <span class="yaogu-chip-desc" style="color:#ef4444">自啟動日 ${retPct.toFixed(1)}%，超出妖股容錯邊界（-${STOP_PCT}%），建議出場</span>
    </div>`;
  } else if (trailHit) {
    html = `<div class="yaogu-chip-row-warning" style="border-top:1px solid rgba(239,83,80,.3)">
      <span class="yaogu-chip-label" style="color:#f59e0b">📏 觸發回落停利線 ${fmt(trailLine)}</span>
      <span class="yaogu-chip-desc" style="color:#f59e0b">高點 ${fmt(peak)} 已回落 ${(100 - cur / peak * 100).toFixed(1)}%（警戒 ${TRAIL_PCT}%），建議鎖住獲利出場</span>
    </div>`;
  } else {
    const trailTxt = retPct > 0
      ? `回落線 ${fmt(trailLine)}（距 ${distTrail >= 0 ? '+' : ''}${distTrail.toFixed(1)}%）`
      : `回落線未啟用（尚未獲利）`;
    html = `<div class="yaogu-chip-row-warning" style="border-top:1px solid rgba(255,255,255,.06)">
      <span class="yaogu-chip-label" style="color:var(--muted)">📏 出場線</span>
      <span class="yaogu-chip-desc" style="color:var(--muted)">停損 ${fmt(stopLine)}（距 +${distStop.toFixed(1)}%）｜高點 ${fmt(peak)}，${trailTxt}</span>
    </div>`;
  }
  return { html, breach };
}

async function _renderYaoguChip(code, signals, candles = null) {
  let el = document.getElementById('stockYaoguChip');
  if (!el) {
    const signalContainer = document.getElementById('stockSignalTags');
    if (!signalContainer) return;
    el = document.createElement('div');
    el.id = 'stockYaoguChip';
    signalContainer.parentNode.insertBefore(el, signalContainer);
  }

  try {
    const record = await getYaoguRecord(code);

    // close < MA20 直接在渲染層判斷 exit（不依賴 AppState.yaoguStatus 快取）
    // 原因：AppState.yaoguStatus 由 updateYaoguTracker 寫入，可能是舊狀態
    // 渲染層直接算，確保跌破月線立即顯示出場確認
    // candles 由 renderStockSignals 傳入
    let forceExit = false;
    if (candles?.length >= 20) {
      const closes   = candles.map(c => c.close);
      const ma20arr  = closes.map((_, i) => {
        if (i < 19) return null;
        return closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      });
      const lastMA20  = ma20arr[closes.length - 1];
      const lastClose = closes[closes.length - 1];
      if (lastMA20 && lastClose < lastMA20 && record) forceExit = true;
    }

    if (forceExit) {
      el.innerHTML = `
        <div class="yaogu-chip" style="border-color:#ef4444;color:#ef4444">
          <div class="yaogu-chip-row-active">
            <span class="yaogu-chip-label">🔴 出場確認</span>
            <span class="yaogu-chip-desc" style="color:var(--muted)">跌破月線，妖股出場底線，請立刻出場</span>
          </div>
        </div>`;
      return;
    }

    // 優先從 AppState 讀（updateYaoguTracker 跑完後寫入，含最新 streak）
    // 第一次呼叫時 AppState 可能無值，先顯示空白；
    // renderStockSignals 的 updateYaoguTracker 完成後 dispatch yaoguUpdated，
    // _onYaoguUpdated 重繪時 AppState 已有值，才真正顯示
    const ys = AppState.yaoguStatus?.[code] ?? null;

    if (!ys) { el.innerHTML = ''; return; }
    const exitBtn = '';  // 重置按鈕已移除

    // 三線出場監控（停損線/回落停利線，X2 實證參數 20/25）
    const exitLines = (ys.status === 'active' || ys.status === 'watching' || ys.status === 'warning1' || ys.status === 'warning2')
      ? _calcExitLines(record, candles, code)
      : null;

    // 盤中急跌警示（active 狀態下今日跌幅 < -5% 才顯示）
    const liveChgPct  = window.__priceCache?.[code]?.chgPct ?? 0;
    const isBigDrop   = liveChgPct <= -5;
    const dropWarnHtml = (ys.status === 'active' || ys.status === 'watching') && isBigDrop
      ? `<div class="yaogu-chip-row-warning" style="border-top:1px solid rgba(239,83,80,.3)">
           <span class="yaogu-chip-label" style="color:#ef5350">⚠️ 今日急跌 ${liveChgPct.toFixed(1)}%</span>
           <span class="yaogu-chip-desc" style="color:#ef5350">注意風險，留意是否觸發出貨警示</span>
         </div>`
      : '';

    // exit 狀態：紅色單行，最高優先顯示
    if (ys.status === 'exit' || ys.status === 'exited') {
      el.innerHTML = `
        <div class="yaogu-chip" style="border-color:#ef4444;color:#ef4444">
          <div class="yaogu-chip-row-active">
            <span class="yaogu-chip-label">🔴 出場確認</span>
            <span class="yaogu-chip-desc" style="color:var(--muted)">跌破月線，妖股出場底線，請立刻出場</span>
          </div>
        </div>`;
      return;
    }

    // warning 狀態：同時顯示妖股主升段（上行）+ 警示（下行）
    const isWarning = ys.status === 'warning1' || ys.status === 'warning2';
    if (isWarning && ys.activeLabel) {
      el.innerHTML = `
        <div class="yaogu-chip yaogu-chip-dual" style="border-color:${ys.color}">
          <div class="yaogu-chip-row-active">
            <span class="yaogu-chip-label" style="color:#4ade80">${ys.activeLabel}</span>
            <span class="yaogu-chip-desc" style="color:var(--muted)">${ys.activeDesc ?? ''}</span>
          </div>
          <div class="yaogu-chip-row-warning">
            <span class="yaogu-chip-label" style="color:${ys.color}">${ys.label}</span>
            <span class="yaogu-chip-desc" style="color:${ys.color}">${ys.desc ?? ''}</span>
          </div>
          ${exitLines?.html ?? ''}
          ${exitBtn}
        </div>`;
    } else {
      el.innerHTML = `
        <div class="yaogu-chip yaogu-chip-dual${dropWarnHtml ? ' ' : ''}" style="border-color:${ys.color};color:${ys.color}">
          <div class="yaogu-chip-row-active" style="color:${ys.color}">
            <span class="yaogu-chip-label">${ys.label}</span>
            <span class="yaogu-chip-desc" style="color:var(--muted)">${ys.desc ?? ''}</span>
          </div>
          ${dropWarnHtml}
          ${exitLines?.html ?? ''}
          ${exitBtn}
        </div>`;
    }


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

/**
 * 個股 Header 右欄圓圈燈陣
 * 目標容器：#stockSignalBubbles（.sh-signals，A 版細框膠囊）
 */
function _renderSignalBubbles(signals) {
  const host = document.getElementById('stockSignalBubbles');
  if (!host) return;

  if (!Array.isArray(signals) || !signals.length) {
    host.innerHTML = '';
    return;
  }

  // 分類 → CSS class（顏色對應原本 _renderSignalTags 的 CATEGORY_COLOR 邏輯）
  const CAT_MAP = {
    '強勢續漲':  { cls: 'cat-teal',   label: '趨勢' },
    '超跌反彈':  { cls: 'cat-blue',   label: '反彈' },
    '轉折訊號':  { cls: 'cat-orange', label: '轉折' },
    '盤整突破':  { cls: 'cat-purple', label: '突破' },
    '葛蘭碧':    { cls: 'cat-purple', label: '葛蘭碧' },
    'K線型態':   { cls: 'cat-teal',   label: 'K線' },
    '基本面':    { cls: 'cat-gray',   label: '基本面' },
    '技術指標':  { cls: 'cat-blue',   label: '指標' },
    '一目均衡表':{ cls: 'cat-teal',   label: '一目' },
    '避險警示':  { cls: 'cat-red',    label: '警示' },
    'X 系列':    { cls: 'cat-gold',   label: '妖股' },
    '巴菲特':    { cls: 'cat-gray',   label: '價值' },
  };

  // 依分類分組
  const groups = new Map();
  for (const s of signals) {
    const cat = s.category ?? '其他';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(s);
  }

  // 優先排序：X系列 > 避險警示 > 強勢續漲 > 其他
  const ORDER = ['X 系列', '避險警示', '強勢續漲', '超跌反彈', '轉折訊號', '盤整突破', '葛蘭碧', 'K線型態', '一目均衡表', '技術指標', '基本面', '巴菲特'];
  const sortedEntries = [...groups.entries()].sort((a, b) => {
    const ai = ORDER.indexOf(a[0]);
    const bi = ORDER.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  host.innerHTML = sortedEntries.map(([cat, sigs]) => {
    const meta = CAT_MAP[cat] ?? { cls: 'cat-gray', label: cat };
    const pills = sigs.map(s =>
      `<span class="sh-pill ${meta.cls}" title="${_escHtml(s.desc ?? s.name)}">` +
      `<span class="sh-pill-dot"></span>` +
      `<span class="sh-pill-txt">${_escHtml(s.name)}</span>` +
      `</span>`
    ).join('');
    return `<div class="sh-cat-group">` +
      `<span class="sh-cat-label">${meta.label}</span>` +
      `<div class="sh-cat-pills">${pills}</div>` +
      `</div>`;
  }).join('');
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
