/**
 * market.js
 * 大盤總覽 Tab：大盤 / 台指期 / 類股熱力圖 / 題材指標
 *
 * export：initMarket()
 *
 * 資料來源：
 *   大盤/類股：www.twse.com.tw/exchangeReport/MI_INDEX（走 Worker proxy）
 *   台指期：  mis.twse.com.tw/stock/api/getStockInfo.jsp（走 Worker proxy）
 *   個股產業：FinMind TaiwanStockInfo（已在 api.js _nameCache 中有產業資訊）
 *   今日個股：window.__priceCache（由 fetchTWSEPrices 填入）
 */

import { getFinMindToken } from './config.js';
import { fsGetShared } from './firebase.js';
import { fetchIntraday, fetchHistoryCached, toYahooSymbol, fetchFundamentalsFromFirestore } from './api.js';
import { dbGetAll, dbPut, dbDelete, dbGet, getKlineCache } from './db.js';
import { calcHealth, calcHealthLong, healthBadge, healthBadgeDual, shortHealthScore } from './health.js';
import { calcHealthWithSignals } from './stock-tabs.js';

// ─────────────────────────────────────────────
// Proxy fetch（複用 api.js 的 Worker）
// ─────────────────────────────────────────────
const SELF_PROXY = 'https://stock-2027.luffy0606.workers.dev/?url=';

async function _proxyFetch(url, timeoutMs = 10000) {
  const proxyUrl = `${SELF_PROXY}${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ─────────────────────────────────────────────
// 快取（記憶體，5分鐘TTL）
// ─────────────────────────────────────────────
const _cache = {};
const _CACHE_TTL = 5 * 60 * 1000;

async function _cachedFetch(key, fetchFn) {
  const now = Date.now();
  if (_cache[key] && now - _cache[key].ts < _CACHE_TTL) {
    return _cache[key].data;
  }
  const data = await fetchFn();
  _cache[key] = { data, ts: now };
  return data;
}

// ─────────────────────────────────────────────
// K 線：抓取指數/期貨歷史（走現有 api.js proxy）
// ─────────────────────────────────────────────
const PERIOD_MAP = {
  '1mo': { interval: '1d', range: '1mo' },
  '3mo': { interval: '1d', range: '3mo' },
  '6mo': { interval: '1d', range: '6mo' },
  '1y':  { interval: '1d', range: '1y'  },
  '2y':  { interval: '1wk', range: '2y' },
};

function _periodLabel(p) {
  return { '1mo':'1月', '3mo':'3月', '6mo':'6月', '1y':'1年', '2y':'2年' }[p] ?? p;
}

async function _fetchIndexCandles(symbol, period = '3mo') {
  const { interval, range } = PERIOD_MAP[period] ?? PERIOD_MAP['3mo'];
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
               `?interval=${interval}&range=${range}&includePrePost=false`;
  const text = await _proxyFetch(url, 10000);
  const data = JSON.parse(text);
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp ?? [];
  const ohlcv      = result.indicators.quote[0];
  return timestamps.map((t, i) => ({
    time:   t,
    open:   +( ohlcv.open[i]  ?? 0).toFixed(2),
    high:   +( ohlcv.high[i]  ?? 0).toFixed(2),
    low:    +( ohlcv.low[i]   ?? 0).toFixed(2),
    close:  +( ohlcv.close[i] ?? 0).toFixed(2),
    volume:  ohlcv.volume[i]  ?? 0,
  })).filter(c => c.close > 0);
}

// 用 LightweightCharts 畫 K 棒（跟個股一樣）+ MA5/10/20/60
function _renderIndexChart(el, candles, symbol) {
  if (!candles || !candles.length) {
    el.innerHTML = '<div class="panel-error" style="height:100%;display:flex;align-items:center;justify-content:center">K線資料不足</div>';
    return;
  }
  el.innerHTML = '';

  // 取得目前實際尺寸（若元素還未顯示則 fallback）
  const initW = el.clientWidth  || el.parentElement?.clientWidth  || 800;
  const initH = el.clientHeight || 220;

  const chart = LightweightCharts.createChart(el, {
    layout: {
      background: { color: 'transparent' },
      textColor: 'rgba(138,143,153,0.9)',
      fontSize: 10,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.08)',
      scaleMargins: { top: 0.1, bottom: 0.15 },
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.08)',
      timeVisible: false,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 6,
    },
    crosshair: { mode: 1 },
    handleScroll: true,
    handleScale: true,
    height: initH,
    width: initW,
  });

  // 主圖：K 棒（台股漲紅跌綠）
  const candleSeries = chart.addCandlestickSeries({
    upColor:         '#ef5350',
    downColor:       '#26a69a',
    borderUpColor:   '#ef5350',
    borderDownColor: '#26a69a',
    wickUpColor:     '#ef5350',
    wickDownColor:   '#26a69a',
  });
  candleSeries.setData(candles.map(c => ({
    time:  c.time,
    open:  c.open,
    high:  c.high,
    low:   c.low,
    close: c.close,
  })));

  // 加均線
  _addMA(chart, candles, 5,  '#f59e0b');
  _addMA(chart, candles, 10, '#26a69a');
  _addMA(chart, candles, 20, '#60a5fa');
  _addMA(chart, candles, 60, '#f472b6');

  chart.timeScale().fitContent();

  // ResizeObserver：元素一旦尺寸變動（含從隱藏變顯示）就重新調整
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0) {
          chart.applyOptions({ width, height: height || initH });
          chart.timeScale().fitContent();
        }
      }
    });
    ro.observe(el);
  }

  // RWD resize（fallback）
  const onResize = () => {
    if (el.clientWidth > 0) {
      chart.applyOptions({ width: el.clientWidth });
      chart.timeScale().fitContent();
    }
  };
  window.addEventListener('resize', onResize);
}

function _addMA(chart, candles, n, color) {
  const closes = candles.map(c => c.close);
  const data   = candles.map((c, i) => {
    if (i < n - 1) return null;
    const sum = closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0);
    return { time: c.time, value: +(sum / n).toFixed(2) };
  }).filter(Boolean);

  const series = chart.addLineSeries({
    color,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  series.setData(data);
}

// ─────────────────────────────────────────────
// API：TWSE MI_INDEX（大盤 + 類股）
// ─────────────────────────────────────────────
async function fetchMIIndex() {
  return _cachedFetch('mi_index', async () => {
    const text = await _proxyFetch(
      'https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&type=IND'
    );
    const json = JSON.parse(text);
    // tables[0] = 價格指數
    const rows = json?.tables?.[0]?.data ?? [];
    return rows.map(r => ({
      name:    r[0],
      close:   r[1]?.replace(/,/g, '') ?? '—',
      dir:     r[2]?.includes('color:red') ? 'up' : 'down',
      points:  r[3],
      chgPct:  r[4],
    }));
  });
}

// ─────────────────────────────────────────────
// API：台指期（mis.twse.com.tw）
// ─────────────────────────────────────────────
async function fetchFutures() {
  return _cachedFetch('futures', async () => {
    // 台指近月合約代碼：TX00（近月）
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
                `?ex_ch=tse_TX00.tw&json=1&delay=0`;
    const text = await _proxyFetch(url, 8000);
    const json = JSON.parse(text);
    const d    = json?.msgArray?.[0];
    if (!d) return null;
    return {
      name:    d.n ?? '台指期近月',
      price:   d.z ?? d.v ?? '—',
      high:    d.h ?? '—',
      low:     d.l ?? '—',
      prev:    d.y ?? '—',
      volume:  d.v ?? '—',
      time:    d.t ?? '—',
    };
  });
}

// ─────────────────────────────────────────────
// 分類：類股 vs 合成指數
// ─────────────────────────────────────────────
const SECTOR_KEYWORDS = [
  '水泥', '塑膠', '紡織', '電機', '電器電纜', '化學', '生技醫療',
  '玻璃', '造紙', '鋼鐵', '橡膠', '汽車', '電子工業', '半導體',
  '電腦', '光電', '通信網路', '電子零組件', '電子通路', '資訊服務',
  '其他電子', '建材營造', '航運', '觀光', '金融保險', '貿易百貨',
  '油電燃氣', '食品', '其他', '機電',
];

function _isSectorIndex(name) {
  return SECTOR_KEYWORDS.some(k => name.startsWith(k));
}

// ─────────────────────────────────────────────
// FinMind 產業分類快取（從已有資料抓）
// ─────────────────────────────────────────────
let _stockInfoCache = null;

async function fetchStockInfo() {
  if (_stockInfoCache) return _stockInfoCache;
  const token = getFinMindToken?.() ?? '';
  if (!token) return [];
  try {
    const url  = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&token=${token}`;
    const text = await _proxyFetch(url, 12000);
    const rows = JSON.parse(text)?.data ?? [];
    _stockInfoCache = rows.filter(r => r.type === 'twse' || r.type === 'tpex');
    return _stockInfoCache;
  } catch (e) {
    console.warn('[market] fetchStockInfo failed:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────
function _fmtPct(v) {
  if (v == null || v === '—') return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function _pctColor(v) {
  const n = parseFloat(v);
  if (isNaN(n) || n === 0) return '';
  return n > 0 ? 'up' : 'down';
}

// 熱力圖顏色（台股：漲紅跌綠）
function _heatColor(pctStr) {
  const v = parseFloat(pctStr);
  if (isNaN(v)) return 'rgba(255,255,255,0.05)';
  if (v >= 3)   return 'rgba(239,83,80,0.85)';
  if (v >= 2)   return 'rgba(239,83,80,0.65)';
  if (v >= 1)   return 'rgba(239,83,80,0.45)';
  if (v >= 0.3) return 'rgba(239,83,80,0.25)';
  if (v <= -3)  return 'rgba(38,166,154,0.85)';
  if (v <= -2)  return 'rgba(38,166,154,0.65)';
  if (v <= -1)  return 'rgba(38,166,154,0.45)';
  if (v <= -0.3)return 'rgba(38,166,154,0.25)';
  return 'rgba(255,255,255,0.05)';
}

// ─────────────────────────────────────────────
// 渲染：大盤子 Tab
// ─────────────────────────────────────────────
async function renderTaiex(el) {
  el.innerHTML = '<div class="panel-loading">載入中</div>';
  try {
    const [rows, candles, intradayRes] = await Promise.allSettled([
      fetchMIIndex(),
      _fetchIndexCandles('^TWII', '3mo'),
      fetchIntraday('^TWII'),
    ]);

    const miRows  = rows.status === 'fulfilled' ? rows.value : [];
    const taiex   = miRows.find(r => r.name === '發行量加權股價指數');
    const listed  = miRows.find(r => r.name === '未含金融指數');

    // ⚠️ 踩雷：MI_INDEX close 是昨收，盤中不更新
    //   → 有分時K就用分時K即時現價，MI_INDEX 只取類股/方向用
    const intradayData = intradayRes.status === 'fulfilled' ? intradayRes.value : null;
    const iPoints   = intradayData?.points ?? [];
    const prevClose = intradayData?.prevClose ?? null;

    let displayPrice, displayPts, displayPct, displayDir;

    // 優先順序：分時K最後一點 > K線最後一根 > MI_INDEX（昨收）
    const klineCandles = candles.status === 'fulfilled' ? candles.value : [];
    const klineLast    = klineCandles.length > 0 ? klineCandles[klineCandles.length - 1] : null;

    if (iPoints.length > 0) {
      // 分時K有資料 → 最即時
      const last = iPoints[iPoints.length - 1];
      const base = prevClose ?? klineLast?.close ?? (taiex ? Number(String(taiex.close).replace(/,/g,'')) : last.value);
      displayPrice = last.value;
      displayPts   = last.value - base;
      displayPct   = base > 0 ? (displayPts / base) * 100 : 0;
      displayDir   = displayPts >= 0 ? 'up' : 'down';
    } else if (klineLast) {
      // 分時K失敗 → 用日K最後一根（含今日收盤）
      const base = prevClose ?? (klineCandles.length >= 2 ? klineCandles[klineCandles.length - 2].close : klineLast.close);
      displayPrice = klineLast.close;
      displayPts   = klineLast.close - base;
      displayPct   = base > 0 ? (displayPts / base) * 100 : 0;
      displayDir   = displayPts >= 0 ? 'up' : 'down';
    } else if (taiex) {
      // 都失敗 → fallback MI_INDEX（昨收）
      displayPrice = Number(String(taiex.close).replace(/,/g,''));
      displayPts   = parseFloat(taiex.points) || 0;
      displayPct   = parseFloat(taiex.chgPct) || 0;
      displayDir   = taiex.dir ?? 'up';
    }

    const cls = displayDir;
    const hasData = displayPrice !== null;

    el.innerHTML = `
      ${hasData ? `
      <div class="mkt-taiex-hero">
        <div class="mkt-taiex-name">加權指數</div>
        <div class="mkt-taiex-value ${cls}">${displayPrice.toLocaleString('zh-TW', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        <div class="mkt-taiex-change ${cls}">
          ${displayDir === 'up' ? '▲' : '▼'} ${Math.abs(displayPts).toFixed(2)} (${displayDir === 'up' ? '+' : ''}${displayPct.toFixed(2)}%)
        </div>
      </div>` : '<div class="mkt-taiex-hero"><div class="mkt-taiex-name">加權指數（資料讀取中）</div></div>'}
      <div class="mkt-chart-toolbar">
        <span class="mkt-chart-label">^TWII 加權指數</span>
        <div class="mkt-period-btns">
          ${['1mo','3mo','6mo','1y','2y'].map(p =>
            `<button class="mkt-period-btn${p==='3mo'?' active':''}" data-period="${p}">${_periodLabel(p)}</button>`
          ).join('')}
        </div>
      </div>
      <div class="mkt-chart-wrap" id="mktTaiexChart" style="height:220px"></div>
      ${taiex ? `
      <div class="info-grid" style="margin:8px 16px 16px">
        ${listed ? `
          <div class="info-cell">
            <div class="info-cell-label">未含金融</div>
            <div class="info-cell-value ${listed.dir}">${Number(listed.close).toLocaleString()}</div>
            <div class="info-cell-sub ${listed.dir}">${_fmtPct(listed.chgPct)}</div>
          </div>` : ''}
      </div>
      <div class="panel-section">
        <div class="panel-section-title">今日前 5 強類股</div>
        ${_renderTopSectors(miRows, 5, 'top')}
      </div>
      <div class="panel-section">
        <div class="panel-section-title">今日前 5 弱類股</div>
        ${_renderTopSectors(miRows, 5, 'bottom')}
      </div>` : ''}`;

    // 畫 K 線
    const chartEl = document.getElementById('mktTaiexChart');
    if (chartEl) {
      const cd = candles.status === 'fulfilled' ? candles.value : [];
      _renderIndexChart(chartEl, cd, '^TWII');
    }

    // 週期切換
    el.querySelectorAll('.mkt-period-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        el.querySelectorAll('.mkt-period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const chartEl2 = document.getElementById('mktTaiexChart');
        if (chartEl2) chartEl2.innerHTML = '<div class="panel-loading">載入中</div>';
        const cd2 = await _fetchIndexCandles('^TWII', btn.dataset.period);
        if (chartEl2) _renderIndexChart(chartEl2, cd2, '^TWII');
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="panel-error">載入失敗：${e.message}</div>`;
  }
}

function _renderTopSectors(rows, n, dir) {
  const sectors = rows
    .filter(r => _isSectorIndex(r.name))
    .map(r => ({ ...r, pct: parseFloat(r.chgPct) }))
    .filter(r => !isNaN(r.pct))
    .sort((a, b) => dir === 'top' ? b.pct - a.pct : a.pct - b.pct)
    .slice(0, n);

  if (!sectors.length) return '<div class="panel-error">無資料</div>';

  return `<div class="mkt-sector-list">${sectors.map(r => `
    <div class="mkt-sector-row" data-sector="${r.name}">
      <span class="mkt-sector-name">${r.name.replace('類指數', '').replace('類', '')}</span>
      <span class="mkt-sector-pct ${r.dir}">${_fmtPct(r.chgPct)}</span>
    </div>`).join('')}</div>`;
}

// ─────────────────────────────────────────────
// FinMind 今日股價批次查（TWSE 失敗時 fallback）
// ─────────────────────────────────────────────
const _todayPriceCache = {};   // { [code]: { price, chgPct, ... } | null }

async function _fetchTodayPriceFinMind(codes) {
  const token = getFinMindToken?.() ?? '';
  if (!token || !codes.length) return {};

  // 今天的日期
  const today = new Date();
  const yyyy  = today.getFullYear();
  const mm    = String(today.getMonth() + 1).padStart(2, '0');
  const dd    = String(today.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  // 過濾已快取的
  const uncached = codes.filter(c => !(c in _todayPriceCache));
  if (!uncached.length) return _todayPriceCache;

  // 並發 5 個，每批間隔 300ms
  const CONC = 5;
  for (let i = 0; i < uncached.length; i += CONC) {
    const batch = uncached.slice(i, i + CONC);
    await Promise.all(batch.map(async code => {
      try {
        const url  = `https://api.finmindtrade.com/api/v4/data` +
                     `?dataset=TaiwanStockPrice&data_id=${code}` +
                     `&start_date=${dateStr}&token=${token}`;
        const text = await _proxyFetch(url, 8000);
        const rows = JSON.parse(text)?.data ?? [];
        const last = rows[rows.length - 1];
        if (last) {
          const chg    = last.spread ?? 0;
          const prev   = last.close - chg;
          const chgPct = prev > 0 ? (chg / prev) * 100 : 0;
          _todayPriceCache[code] = {
            price:  last.close,
            chg,
            chgPct,
            // 不存 name，讓 stockInfo 的 stock_name 保留
          };
        } else {
          _todayPriceCache[code] = null;
        }
      } catch (e) {
        _todayPriceCache[code] = null;
      }
    }));
    if (i + CONC < uncached.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return _todayPriceCache;
}

// ─────────────────────────────────────────────
// 渲染：類股熱力圖子 Tab
// ─────────────────────────────────────────────
async function renderSector(el) {
  el.innerHTML = '<div class="panel-loading">載入中</div>';
  try {
    const rows    = await fetchMIIndex();
    const sectors = rows
      .filter(r => _isSectorIndex(r.name))
      .map(r => ({ ...r, pct: parseFloat(r.chgPct) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));  // 依名稱排序，跟 Yahoo 類似

    if (!sectors.length) {
      el.innerHTML = '<div class="panel-error">類股資料尚未更新（盤後才有）</div>';
      return;
    }

    // Yahoo 風格：文字連結網格，顏色代表漲跌
    const tagLinks = sectors.map(r => {
      const label = r.name.replace('類指數', '').replace('類', '');
      const cls   = r.dir;  // up = 漲（紅）, down = 跌（綠）
      const pct   = _fmtPct(r.chgPct);
      return `<span class="mkt-sector-tag ${cls}" data-sector="${r.name}"
                    title="${r.name} ${pct}">${label}</span>`;
    }).join('');

    el.innerHTML = `
      <div class="mkt-sector-tags-section">
        <div class="mkt-sector-tags-label">集中市場類股</div>
        <div class="mkt-sector-tags">${tagLinks}</div>
      </div>
      <div id="mktSectorDetail" class="mkt-sector-detail-wrap"></div>`;

    // 點擊類股標籤 → 展開個股排行
    el.querySelectorAll('.mkt-sector-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const sectorName = tag.dataset.sector;
        el.querySelectorAll('.mkt-sector-tag').forEach(t => t.classList.remove('active'));
        tag.classList.add('active');
        _renderSectorStocks(sectorName, document.getElementById('mktSectorDetail'));
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="panel-error">載入失敗：${e.message}</div>`;
  }
}

// 個股排行（從 window.__priceCache + FinMind 產業資料交叉）
async function _renderSectorStocks(sectorName, el) {
  const label = sectorName.replace('類指數', '').replace('類', '');
  el.innerHTML = `
    <div class="mkt-sector-detail-header">
      <span>${label} 個股今日排行</span>
    </div>
    <div class="panel-loading" style="padding:16px">載入個股資料</div>`;
  try {
    const priceCache = window.__priceCache ?? {};
    const stockInfo  = await fetchStockInfo();
    const cacheSize  = Object.keys(priceCache).length;

    const keyword = sectorName.replace('類指數', '').replace('類', '');
    const matched = stockInfo.filter(r =>
      r.industry_category?.includes(keyword) ||
      r.stock_name?.includes(keyword)
    );

    if (!matched.length) {
      el.innerHTML = `
        <div class="mkt-sector-detail-header"><span>${label} 個股今日排行</span></div>
        <div class="mkt-theme-hint">此類股目前無個股資料（FinMind Token 未設定或產業分類不符）</div>`;
      return;
    }

    // 先試 priceCache
    let matchedWithPrice = matched.map(r => {
      const p = priceCache[r.stock_id];
      return p
        ? { code: r.stock_id, name: r.stock_name, ...p, name: r.stock_name, _hasPrice: true }
        : { code: r.stock_id, name: r.stock_name, price: null, chgPct: null, _hasPrice: false };
    });

    let hasAnyPrice  = matchedWithPrice.some(r => r._hasPrice);
    let usingFinMind = false;

    // priceCache 空 → 只查前 20 支省 API 額度
    if (!hasAnyPrice && getFinMindToken?.()) {
      const loadingEl = el.querySelector('.panel-loading');
      if (loadingEl) loadingEl.textContent = '透過 FinMind 載入今日股價（前 20 支）…';
      const top20    = matched.slice(0, 20).map(r => r.stock_id);
      const fmPrices = await _fetchTodayPriceFinMind(top20);

      matchedWithPrice = matched.slice(0, 20).map(r => {
        const p = fmPrices[r.stock_id];
        return p
          ? { code: r.stock_id, name: r.stock_name, ...p, name: r.stock_name, _hasPrice: true }
          : { code: r.stock_id, name: r.stock_name, price: null, chgPct: null, _hasPrice: false };
      });
      hasAnyPrice  = matchedWithPrice.some(r => r._hasPrice);
      usingFinMind = true;
    }

    // 排序後只取前 10
    const results = [...matchedWithPrice].sort((a, b) => {
      if (a._hasPrice && !b._hasPrice) return -1;
      if (!a._hasPrice && b._hasPrice) return 1;
      if (a._hasPrice && b._hasPrice) return (b.chgPct ?? 0) - (a.chgPct ?? 0);
      return 0;
    }).slice(0, 10);

    const sourceNote = usingFinMind
      ? '<div class="mkt-theme-hint" style="padding:4px 16px;font-size:10px;color:var(--hint)">資料來源：FinMind（TWSE 尚未更新），顯示前 10 名</div>'
      : (!hasAnyPrice ? '<div class="mkt-theme-hint" style="padding:4px 16px;font-size:10px">⚠ 無今日價格資料，請設定 FinMind Token 或等 TWSE 更新</div>' : '');

    el.innerHTML = `
      <div class="mkt-sector-detail-header">
        <span>${label} 個股今日排行</span>
        <span class="mkt-detail-count">${results.length} 支</span>
      </div>
      ${sourceNote}
      <div class="mkt-stock-list">
        ${results.slice(0, 10).map(r => `
          <div class="mkt-stock-row" data-code="${r.code}">
            <span class="mkt-stock-code">${r.code}</span>
            <span class="mkt-stock-name">${r.name}</span>
            <span class="mkt-stock-price">${r.price ?? '—'}</span>
            <span class="mkt-stock-chg ${(r.chgPct ?? 0) >= 0 ? 'up' : 'down'}">
              ${r.chgPct != null ? `${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(2)}%` : '—'}
            </span>
          </div>`).join('')}
      </div>`;

    // 點個股 → 切回看盤並載入該股
    el.querySelectorAll('.mkt-stock-row').forEach(row => {
      row.addEventListener('click', () => {
        const code = row.dataset.code;
        document.querySelector('.main-tab[data-tab="chart"]')?.click();
        // ⚠️ 踩雷：Tab 切換後 chartPanel 仍 display:none，LightweightCharts 寬度為 0
        // 必須等下一個 rAF 讓 DOM 更新後再派發，否則 K 線畫不出來
        requestAnimationFrame(() =>
          document.dispatchEvent(new CustomEvent('loadStockByCode', { detail: { code } }))
        );
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="panel-error">載入失敗：${e.message}</div>`;
  }
}


// ─────────────────────────────────────────────
// 渲染：今日漲停族群（Advanced 4）
// 資料來源：Firestore market/{today}/limit_up（Cron 14:15 寫入）
// ─────────────────────────────────────────────
async function renderLimitUp(el) {
  if (!el) return;
  el.innerHTML = '<div class="panel-loading">載入中</div>';

  try {
    // 找最近有資料的交易日（往前最多找 7 天）
    let snap = null;
    let dataDate = null;
    const base = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      snap = await fsGetShared(`market/${dateStr}/limit_up`);
      if (snap?.sectorRank) { dataDate = dateStr; break; }
    }

    if (!snap?.sectorRank) {
      el.innerHTML = '<div class="mkt-limitup-empty">近期無漲停資料（非交易日或盤後 14:15 前）</div>';
      return;
    }

    const data = snap;
    const { total, sectorRank = [] } = data;

    el.innerHTML = `
      <div class="mkt-limitup-header">
        漲停族群 <span class="mkt-limitup-total up">${total}</span> 檔
        <span class="mkt-limitup-date">${dataDate}</span>
      </div>
      <div class="mkt-limitup-sectors">
        ${sectorRank.map((s, i) => `
          <div class="mkt-limitup-sector">
            <div class="mkt-limitup-sector-header">
              <span class="mkt-limitup-rank">${i + 1}</span>
              <span class="mkt-limitup-sector-name">${s.sector}</span>
              <span class="mkt-limitup-count up">${s.count} 檔漲停</span>
            </div>
            <div class="mkt-limitup-stocks">
              ${s.stocks.slice(0, 8).map(st => `
                <div class="mkt-limitup-stock" data-code="${st.code}">
                  <span class="mkt-stock-code">${st.code}</span>
                  <span class="mkt-stock-name">${st.name}</span>
                  <span class="mkt-stock-price">${st.price}</span>
                  <span class="mkt-stock-chg up">+${st.chgPct?.toFixed(2)}%</span>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>`;

    // 點擊個股跳轉
    el.querySelectorAll('.mkt-limitup-stock').forEach(row => {
      row.addEventListener('click', () => {
        const code = row.dataset.code;
        document.querySelector('.main-tab[data-tab="chart"]')?.click();
        // ⚠️ 踩雷：Tab 切換後 chartPanel 仍 display:none，LightweightCharts 寬度為 0
        // 必須等下一個 rAF 讓 DOM 更新後再派發，否則 K 線畫不出來
        requestAnimationFrame(() =>
          document.dispatchEvent(new CustomEvent('loadStockByCode', { detail: { code } }))
        );
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="panel-error">載入失敗：${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────
// 渲染：題材指標子 Tab
// ─────────────────────────────────────────────
async function renderTheme(keyword) {
  const resultEl = document.getElementById('mktThemeResult');
  if (!resultEl) return;

  if (!keyword?.trim()) {
    resultEl.innerHTML = '<div class="mkt-theme-hint">輸入關鍵字搜尋題材，或點選類股 Tab 選取產業</div>';
    return;
  }

  resultEl.innerHTML = '<div class="panel-loading">搜尋中</div>';

  try {
    const stockInfo  = await fetchStockInfo();
    const priceCache = window.__priceCache ?? {};
    const kw         = keyword.trim().toLowerCase();

    const matched = stockInfo.filter(r =>
      r.industry_category?.toLowerCase().includes(kw) ||
      r.stock_name?.toLowerCase().includes(kw)        ||
      r.stock_id?.includes(kw)
    );

    const results = matched
      .map(r => {
        const p = priceCache[r.stock_id];
        return p ? { code: r.stock_id, name: r.stock_name, industry: r.industry_category, ...p } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.chgPct - a.chgPct);

    if (!results.length) {
      resultEl.innerHTML = `<div class="mkt-theme-hint">找不到「${keyword}」相關個股（需先載入 TWSE 批次資料，或 FinMind Token 未設定）</div>`;
      return;
    }

    resultEl.innerHTML = `
      <div class="mkt-theme-result-header">
        找到 ${results.length} 支「${keyword}」相關個股，依今日漲跌幅排列
      </div>
      <div class="mkt-stock-list">
        ${results.slice(0, 30).map(r => `
          <div class="mkt-stock-row" data-code="${r.code}">
            <span class="mkt-stock-code">${r.code}</span>
            <span class="mkt-stock-name">${r.name}</span>
            <span class="mkt-stock-industry">${r.industry ?? ''}</span>
            <span class="mkt-stock-price">${r.price}</span>
            <span class="mkt-stock-chg ${r.chgPct >= 0 ? 'up' : 'down'}">
              ${r.chgPct >= 0 ? '+' : ''}${r.chgPct?.toFixed(2)}%
            </span>
          </div>`).join('')}
      </div>`;

    resultEl.querySelectorAll('.mkt-stock-row').forEach(row => {
      row.addEventListener('click', () => {
        const code = row.dataset.code;
        document.querySelector('.main-tab[data-tab="chart"]')?.click();
        // ⚠️ 踩雷：Tab 切換後 chartPanel 仍 display:none，LightweightCharts 寬度為 0
        // 必須等下一個 rAF 讓 DOM 更新後再派發，否則 K 線畫不出來
        requestAnimationFrame(() =>
          document.dispatchEvent(new CustomEvent('loadStockByCode', { detail: { code } }))
        );
      });
    });
  } catch (e) {
    resultEl.innerHTML = `<div class="panel-error">搜尋失敗：${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────
// 初始化（sub Tab 切換 + 事件綁定）
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// 強勢族群 Tab（F1/F2/F4/F6）
// ─────────────────────────────────────────────

// 顏色池
const DONUT_COLORS = [
  '#ef5350','#f59e0b','#3b82f6','#26a69a','#a78bfa',
  '#f472b6','#fb923c','#34d399','#60a5fa','#e879f9',
  '#facc15','#4ade80','#38bdf8','#c084fc','#f87171',
  '#818cf8','#fb7185','#fcd34d','#6ee7b7','#93c5fd',
];

let _donutChart   = null;
let _hgData       = null;   // 漲停族群資料
let _hgDownData   = null;   // 跌停族群資料
let _activeSector = null;
let _hgMode       = 'up';   // 'up' | 'down'

// ── 追蹤模組狀態 ──
let _trackMode     = false;
let _checkedCodes  = new Set();
let _subscriptions = {};
let _currentSector = null;
let _hgSortCol     = 'chgPct';   // 目前排序欄位
let _hgSortAsc     = false;      // 升冪/降冪

// ── 健康度快取 ──
const _hgHealthCache     = {};
const _hgHealthLongCache = {};
const _hgFundCache       = {};   // Phase 2: fund 快取(從 Firestore)
const _hgFetching        = new Set();

// Firebase 健康度快取有效期：7 天（盤後 GAS 每日寫入，7 天內視為有效）
const _FS_HEALTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 健康度取得：三層 fallback，由快到慢
 *
 * Layer 1 — Firebase `stocks/{code}/health` { h, hl, ts }
 *           GAS 盤後寫入，直接讀，0 K線請求
 * Layer 2 — IndexedDB kline_cache（已快取的 K線）
 *           有快取就算，不打 Yahoo
 * Layer 3 — Yahoo fetchHistoryCached
 *           最後才打，有 IndexedDB 寫回快取供下次用
 *
 * 完成後即時更新對應 DOM cell
 */
async function _fetchHealthAsync(code) {
  if (_hgFetching.has(code)) return;
  // ── Layer 0: rsClean（GAS 夜間算的全市場百分位，已驗證取代短線健康度）──────
  // snapshot 有 rsclean_v 就直接用，連 K 線都不用抓（最快）；長線仍走下面三層
  const _rsclean = window.__snapshot?.stocks?.[code]?.rsclean_v;
  if (_rsclean != null) _hgHealthCache[code] = _rsclean;
  _hgFetching.add(code);
  try {
    // ── Layer 1: Firebase ────────────────────────────────────────────────
    try {
      const fsHealth = await fsGetShared(`stocks/${code}/health`);
      if (fsHealth?.ts && Date.now() - fsHealth.ts * 1000 < _FS_HEALTH_TTL_MS) {
        // Firebase 有有效快取，直接用
        _hgHealthCache[code]     = (window.__snapshot?.stocks?.[code]?.rsclean_v) ?? fsHealth.h ?? null;
        _hgHealthLongCache[code] = fsHealth.hl ?? null;
        _patchHealthCell(code);
        return;
      }
    } catch (_) { /* Firebase 失敗繼續下一層 */ }

    // fund 並行先讀（後續兩層都需要）
    if (_hgFundCache[code] === undefined) {
      _hgFundCache[code] = await fetchFundamentalsFromFirestore(code).catch(() => null);
    }
    const fund = _hgFundCache[code];

    // ── Layer 2: IndexedDB K線快取 ───────────────────────────────────────
    try {
      const symbol = toYahooSymbol(code);
      const cached = await getKlineCache(symbol, '1y');
      if (cached?.candles?.length >= 20) {
        const candles = cached.candles;
        _hgHealthCache[code]     = shortHealthScore({ code, candles });  // rsClean 優先，缺才退回舊算法
        _hgHealthLongCache[code] = candles.length >= 60
          ? calcHealthLong(candles, fund) : null;
        _patchHealthCell(code);
        return;
      }
    } catch (_) { /* IndexedDB 失敗繼續下一層 */ }

    // ── Layer 3: Yahoo Finance ───────────────────────────────────────────
    const symbol  = toYahooSymbol(code);
    const candles = await fetchHistoryCached(symbol, '1y');
    if (candles?.length >= 20) {
      _hgHealthCache[code]     = shortHealthScore({ code, candles });  // rsClean 優先，缺才退回舊算法
      _hgHealthLongCache[code] = candles.length >= 60
        ? calcHealthLong(candles, fund) : null;
      _patchHealthCell(code);
    }
  } catch(_) { /* 全部失敗靜默跳過，cell 保持 — */ }
  finally { _hgFetching.delete(code); }
}

/** 即時更新單一 cell（三層 fallback 都用同一個更新點） */
function _patchHealthCell(code) {
  const td = document.querySelector(`.hg-tbl-row[data-code="${code}"] .hg-tbl-health`);
  if (td) td.innerHTML = healthBadgeDual(
    _hgHealthCache[code],
    _hgHealthLongCache[code],
    'hg'
  );
}

/**
 * 批次取得健康度（並發 5 檔，取代逐一串行+150ms 延遲）
 * 每批 5 檔並發，批次間隔 200ms（避免 Worker 瞬間爆量）
 */
async function _fetchHealthBatch(stocks) {
  const CONCURRENCY = 5;
  const needFetch = stocks.filter(st => _hgHealthCache[st.code] == null);
  for (let i = 0; i < needFetch.length; i += CONCURRENCY) {
    const batch = needFetch.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(st => _fetchHealthAsync(st.code)));
    if (i + CONCURRENCY < needFetch.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

// ── 訂閱 CRUD ──
async function _loadSubscriptions() {
  try {
    const rows = await dbGetAll('sector_subscriptions');
    _subscriptions = {};
    (rows ?? []).forEach(r => { _subscriptions[r.sectorKey] = r; });
  } catch(e) { console.warn('[track]', e); }
}
async function _saveSubscription(sub) {
  try { await dbPut('sector_subscriptions', sub); } catch(e) {}
  _subscriptions[sub.sectorKey] = sub;
}
async function _deleteSubscription(sectorKey) {
  try { await dbDelete('sector_subscriptions', sectorKey); } catch(e) {}
  delete _subscriptions[sectorKey];
}
function _sectorKey(mode, sector) { return mode + '_' + sector; }

// ── 工具 ──
function _showToastLocal(msg) {
  if (typeof window.showToast === 'function') { window.showToast(msg); return; }
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
    'background:#333;color:#fff;padding:8px 18px;border-radius:8px;font-size:13px;z-index:9999;pointer-events:none';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}
function _isInPortfolioWatch(code) {
  return !!(window.__portfolioAPI?.isInWatch?.(code));
}
function _getTrackedAt(code, sKey) {
  return _subscriptions[sKey]?.trackedStocks?.find(s => s.code === code)?.addedAt?.slice(0,10) ?? null;
}
function _priceOf(code) {
  return window.__priceCache?.[code]?.price ?? null;
}

/** 讀 Firestore limit_up 或 limit_down，往前找最近 7 天 */
async function _loadHotgroupData(type) {
  const key = type === 'down' ? 'limit_down' : 'limit_up';
  const base = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const snap = await fsGetShared(`market/${dateStr}/${key}`);
    if (snap?.sectorRank) return snap;
  }
  return null;
}

/** 讀盤面分析文字 */
async function _loadCommentary() {
  const base = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const snap = await fsGetShared(`market/${dateStr}/commentary`);
    if (snap?.text) return { ...snap, date: dateStr };
  }
  return null;
}

/** 渲染盤面分析橫幅 */
async function _renderCommentary() {
  const el = document.getElementById('hgCommentary');
  if (!el) return;
  try {
    const snap = await _loadCommentary();
    if (!snap) { el.innerHTML = '<div class="hg-commentary-empty">盤面分析尚未更新（GAS 盤後 14:30 寫入）</div>'; return; }

    let stats = {};
    try { stats = JSON.parse(snap.stats ?? '{}'); } catch (_) {}

    el.innerHTML = `
      <div class="hg-commentary-body">
        <span class="hg-commentary-icon">📊</span>
        <span class="hg-commentary-text">${snap.text.replace(/^今日市場/, snap.date + ' 盤後，市場')}</span>
        ${stats.up != null ? `
        <div class="hg-commentary-stats">
          <span class="hg-stat up">↑ ${stats.up}</span>
          <span class="hg-stat down">↓ ${stats.down}</span>
          <span class="hg-stat">平 ${stats.flat ?? 0}</span>
          <span class="hg-stat up">漲停 ${stats.limitUp}</span>
          <span class="hg-stat down">跌停 ${stats.limitDown}</span>
        </div>` : ''}
      </div>`;
  } catch (e) {
    el.innerHTML = '<div class="hg-commentary-empty">盤面分析讀取失敗</div>';
  }
}

/** Treemap 族群熱力圖（取代甜甜圈 + chip 列） */
function _renderTreemap(sectorRank, data) {
  const el = document.getElementById('hgTreemap');
  if (!el) return;
  const isDown = _hgMode === 'down';
  const maxCount = sectorRank[0]?.count || 1;

  // 色階：漲停紅色系 / 跌停綠色系，由深到淺
  const UP_COLORS = [
    { bg: '#c0392b', text: '#fde8e8' },
    { bg: '#a93226', text: '#fde8e8' },
    { bg: '#922b21', text: '#fde8e8' },
    { bg: '#7b241c', text: '#fde8e8' },
    { bg: '#641e16', text: '#fde8e8' },
    { bg: '#4e1511', text: '#fde8e8' },
    { bg: '#3c100c', text: '#fde8e8' },
    { bg: '#2c0b09', text: '#fde8e8' },
    { bg: '#1f0806', text: '#fde8e8' },
    { bg: '#150504', text: '#fde8e8' },
  ];
  const DOWN_COLORS = [
    { bg: '#1e8449', text: '#d5f5e3' },
    { bg: '#196f3d', text: '#d5f5e3' },
    { bg: '#145a32', text: '#d5f5e3' },
    { bg: '#0f4626', text: '#d5f5e3' },
    { bg: '#0b3a1e', text: '#d5f5e3' },
    { bg: '#082d17', text: '#d5f5e3' },
    { bg: '#052110', text: '#d5f5e3' },
    { bg: '#03160a', text: '#d5f5e3' },
  ];
  const COLORS = isDown ? DOWN_COLORS : UP_COLORS;

  // 每格 col-span：12欄制，按比例分配
  function colSpan(count) {
    const r = count / maxCount;
    if (r >= 0.85) return 12;
    if (r >= 0.65) return 10;
    if (r >= 0.48) return 8;
    if (r >= 0.32) return 6;
    if (r >= 0.20) return 5;
    if (r >= 0.12) return 4;
    if (r >= 0.06) return 3;
    return 2;
  }

  el.innerHTML = sectorRank.map((s, i) => {
    const span  = colSpan(s.count);
    const col   = COLORS[Math.min(i, COLORS.length - 1)];
    const sz    = span <= 2 ? 'hg-tm-xs' : span <= 4 ? 'hg-tm-sm' : '';
    return `<div class="hg-tm-cell ${sz}" data-idx="${i}"
      style="grid-column:span ${span};background:${col.bg};color:${col.text}">
      <div class="hg-tm-name">${s.sector}</div>
      <div class="hg-tm-count">${s.count}</div>
      ${span >= 5 ? `<div class="hg-tm-sub">${isDown ? '跌停' : '漲停'}</div>` : ''}
    </div>`;
  }).join('');

  el.querySelectorAll('.hg-tm-cell').forEach(cell => {
    cell.addEventListener('click', () => _selectSector(Number(cell.dataset.idx), data));
  });
}

/** 選取族群（data = 當前模式的資料，不依賴全域 _hgData）*/
function _selectSector(idx, data) {
  data = data || _hgData;
  _activeSector = idx;
  const color = DONUT_COLORS[idx % DONUT_COLORS.length];
  const isDown = _hgMode === 'down';

  // treemap cell 高亮
  document.querySelectorAll('.hg-tm-cell').forEach((c, i) => c.classList.toggle('hg-tm-active', i === idx));

  const sector = data?.sectorRank?.[idx];
  if (!sector) return;
  const el = document.getElementById('hgStocksSection');
  if (!el) return;

  // 記錄當前族群
  _currentSector = { sector: sector.sector, mode: _hgMode, stocks: sector.stocks, color };
  _trackMode = false;
  _checkedCodes.clear();

  const sKey = _sectorKey(_hgMode, sector.sector);
  const isSubscribed = !!_subscriptions[sKey];
  const subInfo = _subscriptions[sKey];

  _renderSectorTable(el, sector, sKey, isDown, isSubscribed, subInfo, color);
}

/** 渲染個股表格（可獨立呼叫以更新排序/badge）*/
function _renderSectorTable(el, sector, sKey, isDown, isSubscribed, subInfo, color) {
  // 排序
  const sorted = [...sector.stocks].sort((a, b) => {
    let va, vb;
    if (_hgSortCol === 'code')    { va = a.code;    vb = b.code; }
    else if (_hgSortCol === 'name') { va = a.name ?? ''; vb = b.name ?? ''; }
    else if (_hgSortCol === 'price') {
      va = _priceOf(a.code) ?? 0; vb = _priceOf(b.code) ?? 0;
    } else if (_hgSortCol === 'health') {
      va = _hgHealthCache[a.code] ?? -1; vb = _hgHealthCache[b.code] ?? -1;
    } else { // chgPct default
      va = a.chgPct ?? 0; vb = b.chgPct ?? 0;
    }
    if (typeof va === 'string') return _hgSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return _hgSortAsc ? va - vb : vb - va;
  });

  const thSort = (col, label) => {
    const active = _hgSortCol === col;
    const arrow  = active ? (_hgSortAsc ? ' ↑' : ' ↓') : '';
    return `<th class="hg-tbl-th${active ? ' active' : ''}" data-col="${col}">${label}${arrow}</th>`;
  };

  el.innerHTML = `
    <div class="hg-stocks-section-header">
      <span class="hg-stocks-section-title" style="color:${color}">${sector.sector}</span>
      <span class="hg-stocks-section-count">${sector.count} 檔${isDown ? '跌停' : '漲停'}</span>
      <div class="hg-track-actions">
        <button class="hg-track-btn" id="hgTrackSelectBtn">☑ 勾選追蹤</button>
        <button class="hg-track-btn ${isSubscribed ? 'subscribed' : ''}" id="hgTrackSectorBtn">
          ${isSubscribed ? '🔔 訂閱中' : '🔕 訂閱族群'}
        </button>
      </div>
    </div>
    ${isSubscribed ? `<div class="hg-track-sub-info">📌 訂閱至「${subInfo.listName}」追蹤清單・${subInfo.subscribedAt?.slice(0,10)}</div>` : ''}
    <div class="hg-track-toolbar" id="hgTrackToolbar" style="display:none">
      <label class="hg-track-check-all"><input type="checkbox" id="hgCheckAll"> 全選</label>
      <span class="hg-track-selected-count" id="hgTrackCount">已選 0 檔</span>
      <button class="hg-track-confirm-btn" id="hgTrackConfirmBtn">加入追蹤清單 →</button>
      <button class="hg-track-cancel-btn" id="hgTrackCancelBtn">取消</button>
    </div>
    <div class="hg-tbl-wrap">
      <table class="hg-tbl">
        <thead><tr>
          ${thSort('code',   '代號')}
          ${thSort('name',   '股名')}
          ${thSort('price',  '現價')}
          ${thSort('chgPct', isDown ? '跌幅' : '漲幅')}
          ${thSort('health', '健康度')}
          <th class="hg-tbl-th hg-tbl-th-track">追蹤</th>
        </tr></thead>
        <tbody id="hgTblBody">
          ${sorted.map(st => {
            const price     = _priceOf(st.code);
            const trackedAt = _getTrackedAt(st.code, sKey);
            const inWatch   = _isInPortfolioWatch(st.code);
            const health     = _hgHealthCache[st.code];
            const healthLong = _hgHealthLongCache[st.code];
            const chgColor  = isDown ? 'var(--up)' : 'var(--down)';
            return `
            <tr class="hg-tbl-row" data-code="${st.code}">
              <td class="hg-tbl-code">
                <span class="hg-tbl-market ${st.market === 'tpex' ? 'tpex' : 'twse'}">${st.market === 'tpex' ? '櫃' : '市'}</span>
                ${st.code}
              </td>
              <td class="hg-tbl-name">${st.name ?? ''}</td>
              <td class="hg-tbl-price">${price != null ? price.toFixed(2) : '—'}</td>
              <td class="hg-tbl-chg" style="color:${chgColor};font-weight:700">
                ${st.chgPct >= 0 ? '+' : ''}${st.chgPct?.toFixed(2)}%
              </td>
              <td class="hg-tbl-health hg-health-cell" data-code="${st.code}">${healthBadgeDual(health, healthLong, 'hg')}</td>
              <td class="hg-tbl-track">
                <input type="checkbox" class="hg-stock-check" data-code="${st.code}" style="display:none">
                ${trackedAt
                  ? `<span class="hg-chip-tracked-badge" title="追蹤於 ${trackedAt}">✓ ${trackedAt}</span>`
                  : inWatch
                    ? `<span class="hg-chip-wl-badge" title="已在追蹤清單">📋</span>`
                    : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  // ── 排序點擊 ──
  el.querySelectorAll('.hg-tbl-th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_hgSortCol === col) _hgSortAsc = !_hgSortAsc;
      else { _hgSortCol = col; _hgSortAsc = col === 'code' || col === 'name'; }
      _renderSectorTable(el, sector, sKey, isDown, isSubscribed, subInfo, color);
    });
  });

  // ── 行點擊：跳看盤 ──
  el.querySelectorAll('.hg-tbl-row').forEach(tr => {
    tr.addEventListener('click', e => {
      if (_trackMode) {
        const cb = tr.querySelector('.hg-stock-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        if (cb.checked) _checkedCodes.add(tr.dataset.code);
        else _checkedCodes.delete(tr.dataset.code);
        tr.classList.toggle('hg-row-checking', cb.checked);
        _updateTrackCount();
        return;
      }
      if (e.target.closest('.hg-chip-tracked-badge,.hg-chip-wl-badge,.hg-stock-check')) return;
      document.querySelector('.main-tab[data-tab="chart"]')?.click();
      requestAnimationFrame(() =>
        document.dispatchEvent(new CustomEvent('loadStockByCode', { detail: { code: tr.dataset.code } }))
      );
    });
  });

  // ── 非同步抓健康度（三層 fallback，並發 5 檔）──
  const needHealth = sector.stocks.filter(st => _hgHealthCache[st.code] == null);
  if (needHealth.length) {
    _fetchHealthBatch(needHealth);  // 非同步，不 await，逐批完成後即時更新 DOM
  }

  // ── 追蹤工具列事件 ──
  document.getElementById('hgTrackSelectBtn')?.addEventListener('click', () => {
    _trackMode = true;
    _checkedCodes.clear();
    document.getElementById('hgTrackToolbar').style.display = 'flex';
    document.getElementById('hgTrackSelectBtn').style.display = 'none';
    el.querySelectorAll('.hg-stock-check').forEach(cb => cb.style.display = 'inline-block');
    el.querySelectorAll('.hg-tbl-row').forEach(r => r.classList.add('hg-row-select-mode'));
  });
  document.getElementById('hgTrackCancelBtn')?.addEventListener('click', () => _exitTrackMode(el));
  document.getElementById('hgCheckAll')?.addEventListener('change', e => {
    el.querySelectorAll('.hg-stock-check').forEach(cb => {
      cb.checked = e.target.checked;
      const row = cb.closest('.hg-tbl-row');
      if (e.target.checked) { _checkedCodes.add(cb.dataset.code); row?.classList.add('hg-row-checking'); }
      else { _checkedCodes.delete(cb.dataset.code); row?.classList.remove('hg-row-checking'); }
    });
    _updateTrackCount();
  });
  document.getElementById('hgTrackConfirmBtn')?.addEventListener('click', () => {
    if (_checkedCodes.size === 0) { _showToastLocal('請先勾選個股'); return; }
    _openTrackModal('stocks');
  });
  document.getElementById('hgTrackSectorBtn')?.addEventListener('click', () => {
    isSubscribed ? _confirmUnsubscribe(sKey, sector.sector) : _openTrackModal('sector');
  });
}

// ── 離開勾選模式 ──
function _exitTrackMode(el) {
  _trackMode = false;
  _checkedCodes.clear();
  const tb = document.getElementById('hgTrackToolbar');
  if (tb) tb.style.display = 'none';
  const sb = document.getElementById('hgTrackSelectBtn');
  if (sb) sb.style.display = '';
  el?.querySelectorAll('.hg-stock-check').forEach(cb => { cb.checked = false; cb.style.display = 'none'; });
  el?.querySelectorAll('.hg-tbl-row').forEach(r => r.classList.remove('hg-row-select-mode','hg-row-checking'));
  const allCb = document.getElementById('hgCheckAll');
  if (allCb) allCb.checked = false;
  _updateTrackCount();
}
function _updateTrackCount() {
  const el = document.getElementById('hgTrackCount');
  if (el) el.textContent = `已選 ${_checkedCodes.size} 檔`;
}
function _confirmUnsubscribe(sectorKey, sectorName) {
  const sub = _subscriptions[sectorKey];
  if (!sub) return;
  if (!confirm(`取消訂閱「${sectorName}」族群？
（已加入追蹤清單的個股不會被刪除）`)) return;
  _deleteSubscription(sectorKey).then(() => {
    _showToastLocal(`已取消訂閱「${sectorName}」`);
    const data = _hgMode === 'down' ? _hgDownData : _hgData;
    if (data) _selectSector(_activeSector, data);
  });
}
function _openTrackModal(type) {
  const modal = document.getElementById('hgTrackModal');
  if (!modal) return;
  const sector = _currentSector?.sector ?? '';
  const today  = new Date().toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit'}).replace('/','/');
  modal.querySelector('#hgTrackListName').value =
    type === 'sector' ? `${sector}・族群追蹤` : `${sector}・${today}`;
  const sel = modal.querySelector('#hgTrackListSelect');
  const watchLists = window.__portfolioAPI?.getWatchLists?.() ?? [];
  sel.innerHTML = `<option value="">── 新建追蹤清單 ──</option>` +
    watchLists.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  modal.querySelector('#hgTrackModalTitle').textContent =
    type === 'sector' ? `訂閱「${sector}」族群` : `加入追蹤清單`;
  modal.querySelector('#hgTrackModalInfo').textContent =
    type === 'sector'
      ? `每日盤後「${sector}」族群個股自動累加進追蹤清單`
      : `將已勾選的 ${_checkedCodes.size} 檔個股加入庫存追蹤清單`;
  modal.querySelector('#hgTrackAutoRow').style.display = type === 'sector' ? 'none' : '';
  modal.querySelector('#hgTrackModalType').value = type;
  modal.classList.add('active');
}
async function _executeTrack() {
  const modal = document.getElementById('hgTrackModal');
  if (!modal) return;
  const type      = modal.querySelector('#hgTrackModalType').value;
  const rawName   = modal.querySelector('#hgTrackListName').value.trim();
  const selListId = modal.querySelector('#hgTrackListSelect').value;
  const sector = _currentSector?.sector ?? '';
  const mode   = _currentSector?.mode   ?? _hgMode;
  const sKey   = _sectorKey(mode, sector);
  const today  = new Date().toISOString().slice(0,10);
  const stocks = _currentSector?.stocks ?? [];
  const { createList, watchAddCode, listAll } = await import('./portfolio.js').catch(() => ({}));
  if (!watchAddCode) { _showToastLocal('載入 portfolio 失敗'); return; }
  let listId, listName;
  if (selListId) {
    listId   = selListId;
    listName = listAll('watch').find(l => l.id === selListId)?.name ?? selListId;
  } else {
    const name = rawName || `${sector}追蹤`;
    const list = await createList('watch', name);
    listId = list.id; listName = list.name;
  }
  const targetCodes = type === 'sector' ? stocks.map(s => s.code) : [..._checkedCodes];
  let added = 0;
  for (const code of targetCodes) {
    const st = stocks.find(s => s.code === code) ?? { code, name: code };
    try {
      await watchAddCode(listId, code, st.name,
        _priceOf(code) ?? 0,
        `來自${mode==='down'?'跌停':'漲停'}族群「${sector}」`, today);
      added++;
    } catch(e) {}
  }
  const existingSub = _subscriptions[sKey] ?? { sectorKey: sKey, sector, mode, trackedStocks: [] };
  const existingSet = new Set(existingSub.trackedStocks?.map(s => s.code) ?? []);
  for (const code of targetCodes) {
    if (!existingSet.has(code)) {
      existingSub.trackedStocks = existingSub.trackedStocks ?? [];
      existingSub.trackedStocks.push({ code, addedAt: today });
      existingSet.add(code);
    }
  }
  existingSub.listId = listId; existingSub.listName = listName;
  existingSub.subscribedAt = existingSub.subscribedAt ?? today;
  existingSub.lastSyncAt   = today;
  if (type === 'sector') existingSub.autoSync = true;
  await _saveSubscription(existingSub);
  modal.classList.remove('active');
  _exitTrackMode(document.getElementById('hgStocksSection'));
  _showToastLocal(`✅ 已加入 ${added} 檔到「${listName}」追蹤清單`);
  if (window.__portfolioAPI?.reload) await window.__portfolioAPI.reload();
  const data = _hgMode === 'down' ? _hgDownData : _hgData;
  if (data) _selectSector(_activeSector, data);
}
async function _syncSectorSubscriptions(upData, downData) {
  const autoSubs = Object.values(_subscriptions).filter(s => s.autoSync);
  if (!autoSubs.length) return;
  const today = new Date().toISOString().slice(0,10);
  const { watchAddCode, listAll } = await import('./portfolio.js').catch(() => ({}));
  if (!watchAddCode) return;
  for (const sub of autoSubs) {
    if (sub.lastSyncAt === today) continue;
    const data = sub.mode === 'down' ? downData : upData;
    const sectorData = data?.sectorRank?.find(s => s.sector === sub.sector);
    if (!sectorData) continue;
    if (!listAll('watch').find(l => l.id === sub.listId)) continue;
    const existingSet = new Set(sub.trackedStocks?.map(s => s.code) ?? []);
    let count = 0;
    for (const st of sectorData.stocks) {
      if (existingSet.has(st.code)) continue;
      try {
        await watchAddCode(sub.listId, st.code, st.name, _priceOf(st.code) ?? 0,
          `自動累加・${sub.sector}・${today}`, today);
        sub.trackedStocks = sub.trackedStocks ?? [];
        sub.trackedStocks.push({ code: st.code, addedAt: today });
        existingSet.add(st.code);
        count++;
      } catch(e) {}
    }
    sub.lastSyncAt = today;
    await _saveSubscription(sub);
    if (count > 0) console.log(`[track] 自動累加「${sub.sector}」${count} 檔 → ${sub.listName}`);
  }
}

/** 切換漲停/跌停模式並重新渲染 */
async function _switchHgMode(mode) {
  _hgMode = mode;
  const isDown = mode === 'down';

  // toggle 按鈕狀態
  document.querySelectorAll('.hg-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // 顏色主題：漲停=紅色系，跌停=綠色系
  document.getElementById('tabHotgroup')?.setAttribute('data-hg-mode', mode);

  const data = isDown ? _hgDownData : _hgData;
  const metaEl   = document.getElementById('hgMeta');
  const treemapEl = document.getElementById('hgTreemap');
  const stocksEl = document.getElementById('hgStocksSection');

  if (!data?.sectorRank?.length) {
    if (treemapEl) treemapEl.innerHTML = `<div class="hg-empty" style="grid-column:span 12">${isDown ? '近期無跌停資料' : '近期無漲停資料'}</div>`;
    if (stocksEl) stocksEl.innerHTML = '';
    return;
  }

  const total   = data.total ?? data.sectorRank.reduce((s, r) => s + r.count, 0);
  const sectors = data.sectorRank.length;
  if (metaEl) metaEl.innerHTML = `${data.date ?? ''}<br>${total} 檔 / ${sectors} 族群`;

  // 直接把 data 傳入 _renderTreemap + _selectSector，不 swap 全域 _hgData
  _renderTreemap(data.sectorRank, data);
  if (data.sectorRank.length > 0) _selectSector(0, data);
}

/** 強勢族群 Tab 主入口 */
export async function initHotgroup() {
  const el = document.getElementById('tabHotgroup');
  if (!el || el.dataset.hgLoaded) return;
  el.dataset.hgLoaded = '1';

  _renderCommentary();

  // toggle 事件綁定
  document.querySelectorAll('.hg-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchHgMode(btn.dataset.mode));
  });

  const metaEl    = document.getElementById('hgMeta');
  const treemapEl = document.getElementById('hgTreemap');

  try {
    // 平行載入漲停和跌停
    [_hgData, _hgDownData] = await Promise.all([
      _loadHotgroupData('up'),
      _loadHotgroupData('down'),
    ]);

    if (!_hgData?.sectorRank?.length) {
      if (treemapEl) treemapEl.innerHTML = '<div class="hg-empty" style="grid-column:span 12">近期無漲停資料（非交易日或 GAS 盤後排程前）</div>';
      return;
    }

    // 載入訂閱紀錄 + 自動累加
    await _loadSubscriptions();
    _syncSectorSubscriptions(_hgData, _hgDownData);

    // 預設顯示漲停
    await _switchHgMode('up');

  } catch (e) {
    if (chipsEl) chipsEl.innerHTML = `<div class="hg-empty">載入失敗：${e.message}</div>`;
  }

  // ── 追蹤 Modal 事件綁定（只綁一次）──
  const modal = document.getElementById('hgTrackModal');
  if (modal && !modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.querySelector('#hgTrackModalClose')?.addEventListener('click',  () => modal.classList.remove('active'));
    modal.querySelector('#hgTrackModalCancel')?.addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
    modal.querySelector('#hgTrackModalConfirm')?.addEventListener('click', _executeTrack);
    modal.querySelector('#hgTrackListSelect')?.addEventListener('change', e => {
      const inp = modal.querySelector('#hgTrackListName');
      if (inp) inp.disabled = !!e.target.value;
    });
  }
}


export function initMarket() {
  // 子 Tab 切換
  document.querySelectorAll('.market-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.market-subtab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.market-subpanel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tab   = btn.dataset.marketTab;
      const panel = document.getElementById(`mkt${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
      panel?.classList.add('active');
      _loadMarketTab(tab);
    });
  });

  // 主 Tab 切換到大盤時，自動載入當前子 Tab
  document.querySelector('.main-tab[data-tab="market"]')?.addEventListener('click', () => {
    const active = document.querySelector('.market-subtab.active')?.dataset.marketTab ?? 'taiex';
    _loadMarketTab(active);
  });

  // 題材搜尋
  const searchInput = document.getElementById('mktThemeSearch');
  const searchBtn   = document.getElementById('mktThemeSearchBtn');
  searchBtn?.addEventListener('click', () => renderTheme(searchInput?.value));
  searchInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') renderTheme(searchInput.value);
  });

  // 盤中：每 30 秒自動刷新大盤子 Tab（更新即時現價）
  {
    function _isTradingNow() {
      const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const day  = tw.getUTCDay();
      if (day === 0 || day === 6) return false;
      const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
      return mins >= 9 * 60 && mins <= 13 * 60 + 35;
    }
    setInterval(() => {
      if (!_isTradingNow()) return;
      const active = document.querySelector('.market-subtab.active')?.dataset.marketTab;
      // 只刷新大盤子 Tab（taiex），且必須在大盤頁可見
      if (active !== 'taiex') return;
      const marketPanel = document.getElementById('mktTaiex');
      if (!marketPanel) return;
      // 強制清快取（讓 fetchMIIndex 重抓）
      delete _cache['mi_index'];
      _loadMarketTab('taiex');
    }, 30 * 1000);
  }

  // 接收類股 Tab 傳來的選取（從大盤子 Tab 點類股 → 題材指標）
  document.addEventListener('marketSectorSelect', e => {
    const sectorName = e.detail?.name ?? '';
    document.querySelector('.market-subtab[data-market-tab="theme"]')?.click();
    if (searchInput) searchInput.value = sectorName.replace('類指數', '').replace('類', '');
    renderTheme(searchInput?.value);
  });

  // 不預載 — 等使用者真的切到大盤 Tab 才載入（避免 K 線在隱藏狀態渲染導致尺寸壞掉）
}

const _loaded = {};
async function _loadMarketTab(tab) {
  if (_loaded[tab]) return;
  _loaded[tab] = true;
  try {
    switch (tab) {
      case 'taiex':   await renderTaiex(document.getElementById('mktTaiex'));     break;
      case 'sector':  await renderSector(document.getElementById('mktSector'));   break;
      case 'theme':   /* 等使用者搜尋 */                                          break;
      case 'limitup': await renderLimitUp(document.getElementById('mktLimitup')); break;
    }
  } catch (e) {
    _loaded[tab] = false;  // 失敗清掉，下次能重試
    console.warn(`[market] render ${tab} failed:`, e.message);
  }
}
