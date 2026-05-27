/**
 * market-mini.js
 * 看盤頁右下角懸浮市場總覽
 *
 * 提供：加權指數即時數字 + 當日分時迷你 K + 漲跌家數 + 強勢前 3 類股
 * 盤中每 3 分鐘自動更新，盤後僅手動更新
 */

import { fetchQuote, fetchIntraday, getChineseName } from './api.js';
import { fsGetShared } from './firebase.js';
import { calcSignalLamps } from './strategy.js';
import { matchSignals } from './signal-scan.js';
import { AppState } from './state.js';

let _chart      = null;
let _series     = null;
let _timerId    = null;
let _isOpen     = false;
let _miCache    = null;     // 共用 market.js 的 _cache（fetchMIIndex 本身有 5min TTL）
const REFRESH_MS = 3 * 60 * 1000;
const SELF_PROXY = 'https://stock-2027.luffy0606.workers.dev/?url=';

// ─── 盤中判斷（UTC+8 週一到週五 09:00–13:35）───
function _isTradingHours() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const day = utc8.getDay();
  if (day === 0 || day === 6) return false;
  const hm = utc8.getHours() * 100 + utc8.getMinutes();
  return hm >= 900 && hm <= 1335;
}

// ─── 抓 TWSE MI_INDEX（多 proxy fallback，避免 Worker 502 卡死）───
async function _fetchMI() {
  const url = 'https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&type=IND';
  const proxies = [
    `${SELF_PROXY}${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  let json = null;
  for (const proxyUrl of proxies) {
    try {
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.trim().startsWith('<')) continue;  // HTML 錯誤頁
      json = JSON.parse(text);
      break;
    } catch (_) {}
  }
  if (!json) throw new Error('MI_INDEX 所有 proxy 失敗');
  // tables[0] 是「各指數」，tables[2] 也可能是，找含「加權」的那張
  let rows = [];
  for (const t of (json.tables ?? [])) {
    if (Array.isArray(t?.data) && t.data.length > 0) {
      rows = t.data; break;
    }
  }
  return rows.map(r => ({
    name:   r[0],
    close:  String(r[1] ?? '').replace(/,/g, ''),
    dir:    String(r[2] ?? '').includes('color:red') ? 'up' : 'down',
    points: r[3],
    chgPct: parseFloat(String(r[4] ?? '').replace(/[^\d.\-+]/g, '')) || 0,
  }));
}

// ─── 類股關鍵字（同 market.js）───
const SECTOR_KEYWORDS = [
  '水泥','塑膠','紡織','電機','電器電纜','化學','生技醫療',
  '玻璃','造紙','鋼鐵','橡膠','汽車','電子工業','半導體',
  '電腦','光電','通信網路','電子零組件','電子通路','資訊服務',
  '其他電子','建材營造','航運','觀光','金融保險','貿易百貨',
  '油電燃氣','食品','其他','機電',
];
function _isSector(name) {
  return SECTOR_KEYWORDS.some(k => name.startsWith(k));
}

// ─── 從 window.__priceCache 算漲跌家數 ───
function _calcBreadth() {
  const cache = window.__priceCache ?? {};
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
  for (const code in cache) {
    const r = cache[code];
    if (!r || typeof r.chgPct !== 'number') continue;
    if (r.chgPct > 0) up++;
    else if (r.chgPct < 0) down++;
    else flat++;
    // 台股漲跌停 10%，給點容差用 9.5
    if (r.chgPct >= 9.5)  limitUp++;
    if (r.chgPct <= -9.5) limitDown++;
  }
  return { up, down, flat, limitUp, limitDown, total: up + down + flat };
}

// ─── 初始化迷你 K 圖 ───
function _initChart() {
  if (_chart) return;
  const el = document.getElementById('mmChart');
  if (!el || !window.LightweightCharts) return;

  const w = el.clientWidth || 280;
  _chart = LightweightCharts.createChart(el, {
    width: w,
    height: 100,
    layout: {
      background: { color: 'transparent' },
      textColor: 'rgba(232,234,237,0.55)',
      fontSize: 10,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.15, bottom: 0.15 },
    },
    localization: {
      timeFormatter: (ts) => {
        // ts 是 UTC 秒，+8 小時轉台灣時間顯示
        const d = new Date((ts + 8 * 3600) * 1000);
        const h = String(d.getUTCHours()).padStart(2, '0');
        const m = String(d.getUTCMinutes()).padStart(2, '0');
        return `${h}:${m}`;
      },
    },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 2,
      tickMarkFormatter: (ts) => {
        const d = new Date((ts + 8 * 3600) * 1000);
        const h = String(d.getUTCHours()).padStart(2, '0');
        const m = String(d.getUTCMinutes()).padStart(2, '0');
        return `${h}:${m}`;
      },
    },
    handleScroll: false,
    handleScale:  false,
    crosshair:    { mode: 0 },
  });

  _series = _chart.addAreaSeries({
    lineColor:   '#3b82f6',
    topColor:    'rgba(59,130,246,0.35)',
    bottomColor: 'rgba(59,130,246,0)',
    lineWidth:   2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  // 響應式
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (_chart && el.clientWidth > 0) {
        _chart.applyOptions({ width: el.clientWidth });
      }
    }).observe(el);
  }
}

// ─── 渲染大盤燈號 ───
function _renderSignalLamps() {
  const el = document.getElementById('mmSignalLamps');
  if (!el) return;

  // 從 AppState.signals 讀取 ^TWII 的訊號
  const signals = AppState.signals?.['^TWII'] ?? [];
  const lamps   = calcSignalLamps(signals);

  if (lamps === 0) {
    el.innerHTML = '<span class="mm-lamp-label">大盤訊號</span><span class="mm-lamp-none">無訊號</span>';
    return;
  }

  // 判斷顏色
  const NEGATIVE = new Set(['避險警示']);
  const negCount = signals.filter(s => NEGATIVE.has(s.category)).length;
  const posCount = signals.length - negCount;
  const colorCls = negCount > 0 && negCount >= posCount ? 'lamps-neg'
                 : posCount > 0 ? 'lamps-pos'
                 : 'lamps-neu';

  const fullLamps = Math.floor(lamps);
  const hasHalf   = (lamps % 1) === 0.5;
  const tip = signals.map(s => s.name).join('、');

  const dots = Array.from({ length: 5 }, (_, i) => {
    if (i < fullLamps)              return '<span class="wl-lamp on"></span>';
    if (i === fullLamps && hasHalf) return '<span class="wl-lamp half"></span>';
    return '<span class="wl-lamp"></span>';
  }).join('');

  el.innerHTML = `<span class="mm-lamp-label">大盤訊號</span><div class="wl-lamps ${colorCls}" title="${tip}">${dots}</div>`;
}

// ─── 渲染加權指數 hero ───
function _renderHero(taiex) {
  const priceEl  = document.getElementById('mmPrice');
  const changeEl = document.getElementById('mmChange');
  if (!taiex) {
    if (priceEl)  priceEl.textContent = '--';
    if (changeEl) { changeEl.textContent = '資料讀取中'; changeEl.className = 'mm-change'; }
    return;
  }
  const price = parseFloat(taiex.close) || 0;
  const pts   = parseFloat(String(taiex.points ?? '').replace(/[^\d.\-+]/g, '')) || 0;
  const pct   = taiex.chgPct;
  const isUp  = taiex.dir === 'up';

  if (priceEl) priceEl.textContent = price.toLocaleString('zh-TW', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  if (changeEl) {
    const arrow = isUp ? '▲' : '▼';
    const sign  = isUp ? '+' : '';
    changeEl.textContent = `${arrow} ${Math.abs(pts).toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
    changeEl.className   = 'mm-change ' + (isUp ? 'up' : 'down');
  }
}

// ─── 渲染分時 K ───
function _renderChart(points) {
  if (!_series) return;
  if (!points || points.length === 0) return;
  // 去重（Yahoo 偶爾回重複 timestamp）
  const seen = new Set();
  const data = [];
  for (const p of points) {
    if (seen.has(p.time)) continue;
    seen.add(p.time);
    data.push(p);
  }
  data.sort((a, b) => a.time - b.time);
  _series.setData(data);
  _chart.timeScale().fitContent();
}

// ─── 渲染漲跌家數 ───
function _renderBreadth(b) {
  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v.toLocaleString();
  };
  setText('mmBreadthUp',        b.up);
  setText('mmBreadthDown',      b.down);
  setText('mmBreadthFlat',      b.flat);
  setText('mmBreadthLimitUp',   b.limitUp);
  setText('mmBreadthLimitDown', b.limitDown);

  // 沒資料時提示
  if (b.total === 0) {
    const hint = document.getElementById('mmBreadthHint');
    if (hint) hint.style.display = '';
  } else {
    const hint = document.getElementById('mmBreadthHint');
    if (hint) hint.style.display = 'none';
  }
}

// ─── 渲染強勢前 3 類股（Advanced 4：優先讀 Firestore 漲停族群）───
async function _renderSectors(miRows) {
  const el = document.getElementById('mmSectors');
  if (!el) return;

  // 優先讀 Firestore limit_up（Cron 14:15 寫入）
  try {
    const today = new Date().toISOString().slice(0, 10);
    const snap  = await fsGetShared(`market/${today}/limit_up`);
    if (snap?.sectorRank) {
      const top3 = snap.sectorRank.slice(0, 3);
      if (top3.length > 0) {
        el.innerHTML = top3.map((s, i) => `
          <div class="mm-sector-row">
            <span class="mm-sector-rank">${i + 1}.</span>
            <span class="mm-sector-name">${s.sector}</span>
            <span class="mm-sector-pct up">${s.count} 檔漲停</span>
          </div>`).join('');
        return;
      }
    }
  } catch (e) { /* fallback 到 MI_INDEX */ }

  // Fallback：從 MI_INDEX 取強勢類股
  const sectors = miRows
    .filter(r => _isSector(r.name))
    .filter(r => !isNaN(r.chgPct))
    .sort((a, b) => b.chgPct - a.chgPct)
    .slice(0, 3);

  if (!sectors.length) {
    el.innerHTML = '<div class="mm-empty">尚無類股資料</div>';
    return;
  }
  el.innerHTML = sectors.map((s, i) => {
    const label = s.name.replace('類指數', '').replace('類', '');
    const isUp  = s.chgPct >= 0;
    const sign  = isUp ? '+' : '';
    return `
      <div class="mm-sector-row">
        <span class="mm-sector-rank">${i + 1}.</span>
        <span class="mm-sector-name">${label}</span>
        <span class="mm-sector-pct ${isUp ? 'up' : 'down'}">${sign}${s.chgPct.toFixed(2)}%</span>
      </div>`;
  }).join('');
}

// ─── 主更新 ───
async function _refresh() {
  const tsEl = document.getElementById('mmTime');
  if (tsEl) tsEl.textContent = '更新中…';

  // 平行：分時 K + MI_INDEX；漲跌家數從 window.__priceCache 算（純本地）
  const [intradayRes, miRes] = await Promise.allSettled([
    fetchIntraday('^TWII'),
    _fetchMI(),
  ]);

  // 1) 分時 K（fetchIntraday 現在回傳 { points, prevClose }）
  const intradayData   = intradayRes.status === 'fulfilled' ? intradayRes.value : { points: [], prevClose: null };
  const intradayPoints = intradayData.points ?? [];
  const prevClose      = intradayData.prevClose ?? null;
  if (intradayPoints.length > 0) {
    _renderChart(intradayPoints);
  }

  // 2) 加權指數 hero + 類股
  // ⚠️ 踩雷：MI_INDEX 的 close 是盤後收盤價，盤中不更新
  //   → 不管 MI_INDEX 成不成功，只要有分時K就用分時K最後一點當現價
  const miRows = miRes.status === 'fulfilled' ? miRes.value : [];
  const taiex  = miRows.find(r => r.name === '發行量加權股價指數')
              ?? miRows.find(r => r.name?.includes('加權'));

  if (intradayPoints.length > 0) {
    // 有分時K → 現價用即時，方向/漲跌幅自己算
    const last = intradayPoints[intradayPoints.length - 1];
    const base = prevClose
              ?? (taiex ? parseFloat(String(taiex.close).replace(/,/g,'')) : null)
              ?? last.value;
    const pts  = last.value - base;
    const pct  = base > 0 ? (pts / base) * 100 : 0;
    _renderHero({ close: last.value, points: pts.toFixed(2), chgPct: pct, dir: pts >= 0 ? 'up' : 'down' });
  } else if (taiex) {
    // 沒有分時K → fallback 到 MI_INDEX（盤後收盤，標示清楚）
    _renderHero(taiex);
  } else {
    _renderHero(null);
  }
  await _renderSectors(miRows);

  // 3) 漲跌家數（從 priceCache 算）
  _renderBreadth(_calcBreadth());

  if (tsEl) {
    const now = new Date();
    tsEl.textContent = '更新：' + now.toLocaleTimeString('zh-TW', { hour12: false });
  }

  // 大盤燈號（從 AppState.signals['^TWII'] 讀，無需重算）
  _renderSignalLamps();
}

// ─── 開關 ───
function _open() {
  const panel = document.getElementById('marketMiniPanel');
  const btn   = document.getElementById('marketMiniBtn');
  if (!panel) return;

  panel.classList.add('open');
  if (btn) btn.style.display = 'none';
  _isOpen = true;

  _initChart();
  _refresh();

  // 啟動定時器（只在盤中）
  if (_isTradingHours()) {
    _stopTimer();
    _timerId = setInterval(() => {
      if (!_isTradingHours()) { _stopTimer(); return; }
      _refresh();
    }, REFRESH_MS);
  }
}

function _close() {
  const panel = document.getElementById('marketMiniPanel');
  const btn   = document.getElementById('marketMiniBtn');
  if (!panel) return;
  panel.classList.remove('open');
  if (btn) btn.style.display = '';
  _isOpen = false;
  _stopTimer();
}

function _stopTimer() {
  if (_timerId) { clearInterval(_timerId); _timerId = null; }
}

// ─── 對外入口 ───
export function initMarketMini() {
  const btn       = document.getElementById('marketMiniBtn');
  const closeBtn  = document.getElementById('mmClose');
  const refreshBtn = document.getElementById('mmRefresh');
  if (!btn || !closeBtn) {
    console.warn('[market-mini] HTML 元素缺失，跳過初始化');
    return;
  }

  btn.addEventListener('click', _open);
  closeBtn.addEventListener('click', _close);
  refreshBtn?.addEventListener('click', _refresh);
}