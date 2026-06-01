/**
 * market-mini.js
 * 看盤頁右下角懸浮市場總覽
 *
 * 提供：加權指數即時數字 + 當日分時迷你 K + 漲跌家數 + 強勢前 3 類股
 * 盤中每 3 分鐘自動更新，盤後僅手動更新
 */

import { fetchIntraday, getChineseName } from './api.js';
import { fsGetShared } from './firebase.js';
import { calcSignalLamps } from './strategy.js';

import { AppState } from './state.js';

let _timerId    = null;
let _isOpen     = false;
const REFRESH_MS = 3 * 60 * 1000;
const SELF_PROXY    = 'https://stock-2027.luffy0606.workers.dev/?url=';
const PROXY_TOKEN   = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';

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
      const isWorker = proxyUrl.startsWith(SELF_PROXY);
      const opts = { signal: AbortSignal.timeout(8000) };
      if (isWorker && PROXY_TOKEN) opts.headers = { 'X-Proxy-Token': PROXY_TOKEN };
      const res = await fetch(proxyUrl, opts);
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
      const top3 = snap.sectorRank.slice(0, 10);
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
    .slice(0, 10);

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

  // 平行：MI_INDEX + 加權指數 K線（取最後收盤價）；漲跌家數從 window.__priceCache 算
  const [miRes, intradayRes] = await Promise.allSettled([
    _fetchMI(),
    fetchIntraday('^TWII'),
  ]);

  const miRows = miRes.status === 'fulfilled' ? miRes.value : [];
  const taiex  = miRows.find(r => r.name === '發行量加權股價指數')
              ?? miRows.find(r => r.name?.includes('加權'));

  // 加權指數 hero：優先用分時K最後一點（盤中即時），fallback MI_INDEX
  const intradayData   = intradayRes.status === 'fulfilled' ? intradayRes.value : null;
  const intradayPoints = intradayData?.points ?? [];
  const prevClose      = intradayData?.prevClose ?? null;

  if (intradayPoints.length > 1) {
    const last = intradayPoints[intradayPoints.length - 1];
    const base = prevClose
              ?? (taiex ? parseFloat(String(taiex.close).replace(/,/g,'')) : null)
              ?? last.value;
    const pts  = last.value - base;
    const pct  = base > 0 ? (pts / base) * 100 : 0;
    _renderHero({ close: last.value, points: pts.toFixed(2), chgPct: pct, dir: pts >= 0 ? 'up' : 'down' });
  } else if (taiex) {
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
  // 重置拖移位置，下次開啟回右下角預設位
  panel.style.left = panel.style.top = '';
  panel.style.right = '20px';
  panel.style.bottom = '20px';
  if (btn) btn.style.display = '';
  _isOpen = false;
  _stopTimer();
}

function _stopTimer() {
  if (_timerId) { clearInterval(_timerId); _timerId = null; }
}

// ─── 對外入口 ───
export function initMarketMini() {
  const btn        = document.getElementById('marketMiniBtn');
  const closeBtn   = document.getElementById('mmClose');
  const refreshBtn = document.getElementById('mmRefresh');
  if (!btn || !closeBtn) {
    console.warn('[market-mini] HTML 元素缺失，跳過初始化');
    return;
  }

  // ─── FAB 拖移邏輯 ───
  let _fabDragged = false;
  {
    let _dragging = false, _ox = 0, _oy = 0, _moved = false;
    btn.addEventListener('mousedown', e => {
      const r = btn.getBoundingClientRect();
      _ox = e.clientX - r.left;
      _oy = e.clientY - r.top;
      _dragging = true;
      _moved = false;
      btn.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!_dragging) return;
      _moved = true;
      btn.style.right  = 'auto';
      btn.style.bottom = 'auto';
      const x = Math.max(0, Math.min(window.innerWidth  - btn.offsetWidth,  e.clientX - _ox));
      const y = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, e.clientY - _oy));
      btn.style.left = x + 'px';
      btn.style.top  = y + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!_dragging) return;
      _dragging = false;
      btn.style.transition = '';
      _fabDragged = _moved;
    });
  }

  btn.addEventListener('click', e => { if (!_fabDragged) _open(); _fabDragged = false; });
  closeBtn.addEventListener('click', _close);
  refreshBtn?.addEventListener('click', _refresh);

  // ─── Panel 拖移邏輯（標題列 drag handle）───
  const header = document.getElementById('mmHeader');
  if (header) {
    let _dragging = false, _ox = 0, _oy = 0;
    header.addEventListener('mousedown', e => {
      if (e.target === closeBtn || e.target === refreshBtn) return;
      const panel = document.getElementById('marketMiniPanel');
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      // 切換成 fixed + 絕對位置
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left   = r.left + 'px';
      panel.style.top    = r.top  + 'px';
      _ox = e.clientX - r.left;
      _oy = e.clientY - r.top;
      _dragging = true;
      header.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!_dragging) return;
      const panel = document.getElementById('marketMiniPanel');
      if (!panel) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - _ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - _oy));
      panel.style.left = x + 'px';
      panel.style.top  = y + 'px';
    });
    document.addEventListener('mouseup', () => {
      _dragging = false;
      header.classList.remove('dragging');
    });
  }
}