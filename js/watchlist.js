/**
 * watchlist.js — 自選清單（群組版）v3
 *
 * v3 新增（2026-05-29）：
 *   - 新版行佈局：股名同行 / 股價 + 漲跌幅左欄疊放 / 走勢圖右欄（58px）
 *   - 今日 1d/5m ↔ 40日 kline_cache 走勢切換（localStorage 記憶）
 *   - 群組內五維升降冪排序：漲跌幅 / 股價 / 燈號 / 代號 / 股名
 *   - 群組工具列整合：⇅排序下拉 + ···更多下拉
 *   - 移除按鈕改 hover-only（× 浮上才出現）
 *   - ×N 跨清單重複標記
 *
 * ⚠️ 踩雷備忘（永久保留）：
 *   - MIS debounced DB flush 必須保留（5s），F5 後才拿得到最新盤中價
 *   - renderWatchlist 判斷不能只看 s.price===p.price，要連 chgPct 和 s.price!=null
 *   - main.js 自選輪詢的 await updateStockPrices 不可移除
 *   - fetchMisIntraday 用雙前綴不可反轉（見 api.js 備忘）
 */

import { AppState }    from './state.js';
import { showToast }   from './ui.js';
import {
  getAllGroups, saveGroup, deleteGroup as dbDeleteGroup,
  initDB, migrateFromLocalStorage,
} from './db.js';
import { getChineseName, toYahooSymbol, FEATURE_INTRADAY_5M } from './api.js';
import { calcSignalLamps } from './strategy.js';
import { getYaoguStatus }  from './signal-scan.js';
import { getYaoguRecord, loadStockInfo } from './db.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// ⚠️ 與 api.js SELF_PROXY / PROXY_TOKEN 保持同步
const _PROXY_URL   = 'https://stock-2027.luffy0606.workers.dev/?url=';
const _PROXY_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';

const SORT_CRITERIA = [
  { key: 'chgPct', label: '漲跌幅' },
  { key: 'price',  label: '股價'   },
  { key: 'lamps',  label: '燈號'   },
  { key: 'code',   label: '代號'   },
  { key: 'name',   label: '股名'   },
];

const _INTRADAY_TTL = 10 * 60 * 1000;   // 10 分鐘（盤中）
const _SPARK_W = 62;
const _SPARK_H = 56;
const _SPARK_PAD = 4;                   // 上下留邊

// ─── State ────────────────────────────────────────────────────────────────────

let _groups    = [];
let _siInfoCache = {};  // code → stockInfo（有 forward 時顯示邊框）
let _collapsed = new Set();
let _sortState = {};                    // { [groupId]: { key: string|null, dir: 1|-1 } }
// ★ 無 FinMind token → 強制鎖定 '40d'，完全不打 Yahoo 5m（引信：訂閱後填 token 自動開通）
// ★ 'bar' 模式：今日漲跌幅柱，不需要 K線資料，瞬間渲染
const _savedMode = localStorage.getItem('wl_spark_mode');
let _sparkMode = (_savedMode === 'bar')
  ? 'bar'
  : (FEATURE_INTRADAY_5M && _savedMode === 'day')
    ? 'day'
    : '40d';

const _kline40Cache  = new Map();       // code → number[] (close prices, last 40)
const _intradayCache = new Map();       // code → { points: number[], fetchedAt: number }
let   _sparkQueue    = new Set();       // 待載入的 codes
let   _sparkRunning  = false;
let   _drainGen      = 0;              // generation counter：切換模式時遞增，使舊 drain 失效
let   _intradayFailStreak = 0;         // 今日模式連續失敗計數
const _INTRADAY_MAX_FAIL  = 3;         // 連失 N 次後自動切回 40日

// ─── MIS debounced DB flush ───────────────────────────────────────────────────
// ⚠️ 踩雷備忘（永久，2026-05-21）：
//   MIS 盤中報價全部只活在記憶體，F5 後回到上次盤後價。
//   每次 push 都重置 5 秒 debounce，5 秒內沒新報價就寫 IndexedDB。
//   自選輪詢的 await updateStockPrices 是保險，不可移除。
let _misFlushTimer = null;
const _MIS_FLUSH_MS = 5000;

function _scheduleMisFlush() {
  if (_misFlushTimer) clearTimeout(_misFlushTimer);
  _misFlushTimer = setTimeout(async () => {
    _misFlushTimer = null;
    try {
      await Promise.all(_groups.map(g => saveGroup(g)));
    } catch (e) {
      console.warn('[watchlist] MIS debounced flush failed:', e.message);
    }
  }, _MIS_FLUSH_MS);
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

export async function initWatchlist() {
  await initDB();
  await migrateFromLocalStorage();
  _groups = await getAllGroups();

  if (_groups.length === 0) {
    const def = _makeGroup('預設清單', 0);
    _groups = [def];
    await saveGroup(def);
  }

  await _ensureDefaultIndices();
  AppState.watchlistGroups = _groups;
  renderWatchlist();
  _bindSidebarEvents();
  window.__showSiListPanel = _showSiListPanel;

  if (!document.body.dataset.signalWlBound) {
    document.body.dataset.signalWlBound = '1';

    document.addEventListener('signalsUpdated', async (e) => {
      const updatedCodes = Object.keys(e.detail ?? {});
      if (!AppState.yaoguStatus) AppState.yaoguStatus = {};
      for (const code of updatedCodes) {
        try {
          const record  = await getYaoguRecord(code);
          const signals = AppState.signals?.[code] ?? [];
          const streak  = record?.streak ?? null;
          const ys = getYaoguStatus(code, signals, record, streak);
          if (ys) AppState.yaoguStatus[code] = ys;
          else    delete AppState.yaoguStatus[code];
        } catch (_) {}
      }
      renderWatchlist();
    });

    document.addEventListener('pricesUpdated', (e) => {
      const { map, persist } = e.detail ?? {};
      if (!map || persist) return;

      let dirty = false;
      for (const g of _groups) {
        for (const s of g.stocks) {
          const p = map[s.code];
          if (!p) continue;
          s.price  = p.price;
          s.chg    = p.chg;
          s.chgPct = p.chgPct;
          dirty = true;
        }
      }
      if (dirty) renderWatchlist();
    });

    // ★ stockInfo 更新（輸入 JSON 後即時刷新跑馬燈邊框）
    document.addEventListener('stockInfoUpdated', async (e) => {
      const code = e.detail?.code;
      if (!code) return;
      try {
        const { loadStockInfo } = await import('./db.js');
        const info = await loadStockInfo(code);
        const had  = !!_siInfoCache[code];
        if (info) _siInfoCache[code] = info;
        else      delete _siInfoCache[code];
        if (!!_siInfoCache[code] !== had) renderWatchlist();
      } catch (_) {}
    });
  }
}

export async function reloadWatchlist() {
  _groups = await getAllGroups();
  if (_groups.length === 0) {
    const def = _makeGroup('預設清單', 0);
    _groups = [def];
    await saveGroup(def);
  }
  // ⚠️ 不可在此呼叫 _ensureDefaultIndices：
  //   雲端下載後若 defGroup 沒有指數代號（因為使用者已把它們移到大盤群組），
  //   會一直重複塞入 → 無性繁殖。只有 initWatchlist（首次安裝）才補預設。
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

// ─── 預設指數 ─────────────────────────────────────────────────────────────────

const _DEFAULT_INDICES = [
  { code: '^TWII', name: '加權指數' },
  { code: '^DJI',  name: '道瓊指數' },
  { code: '^SOX',  name: '費城半導體' },
];

async function _ensureDefaultIndices() {
  // ⚠️ 只在 initWatchlist（首次安裝/全空）時呼叫，reloadWatchlist 不可呼叫此函式。
  // 查重範圍改為「全部群組」：使用者若已把指數移到大盤群組，就不再塞入 defGroup。
  const defGroup = _groups.find(g => g.name.includes('預設')) ?? _groups[0];
  if (!defGroup) return;
  let changed = false;
  for (const idx of _DEFAULT_INDICES) {
    const existsAnywhere = _groups.some(g => g.stocks.some(s => s.code === idx.code));
    if (!existsAnywhere) {
      defGroup.stocks.push({ code: idx.code, name: idx.name });
      changed = true;
    }
  }
  if (changed) await saveGroup(defGroup);
}

// ─── v3: Sparkline 資料層 ──────────────────────────────────────────────────────

/** 將收盤價陣列轉為 SVG polyline points 字串 */
function _pricesToSvgPts(prices) {
  if (!prices || prices.length < 2) return null;
  const valid = prices.filter(p => p != null && !isNaN(p));
  if (valid.length < 2) return null;
  const mn    = Math.min(...valid);
  const mx    = Math.max(...valid);
  const range = mx - mn || 1;
  const n     = valid.length;
  return valid.map((p, i) => {
    const x = (i / (n - 1)) * _SPARK_W;
    const y = _SPARK_H - _SPARK_PAD - ((p - mn) / range) * (_SPARK_H - _SPARK_PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** 今日 K 棒 SVG（從 __priceCache 的 open/high/low/price/prev 畫真實 K 棒）
 *  有影線（high/low）+ 實體（open/close）
 *  62×56px，價格範圍自動縮放到畫布高度
 */
function _svgDayBar(chgPct, color, priceData) {
  const W = _SPARK_W, H = _SPARK_H, PAD = 6;
  const barW = 16;
  const barX = (W - barW) / 2;
  const wickX = W / 2;

  // 從 priceData 取 OHLC，fallback 用 chgPct 估算柱體
  const close = priceData?.price ?? 0;
  const open  = priceData?.open  ?? close;
  const high  = priceData?.high  ?? close;
  const low   = priceData?.low   ?? close;
  const prev  = priceData?.prev  ?? close;

  // 價格範圍：只用 OHLC，不含昨收（昨收差距大會把 K 棒壓縮到看不見）
  const allPrices = [open, high, low, close].filter(v => v > 0);
  if (allPrices.length < 2 || close <= 0) {
    // 無 OHLC 資料（停牌/未成交）→ 畫漲跌幅柱 fallback
    const pct  = Math.max(-10, Math.min(10, chgPct ?? 0));
    const midY = H / 2;
    const maxH = H / 2 - PAD;
    const bH   = Math.max(Math.abs(pct) / 10 * maxH, 1.5);
    const bY   = pct >= 0 ? midY - bH : midY;
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">
  <line x1="${barX}" y1="${midY.toFixed(1)}" x2="${barX + barW}" y2="${midY.toFixed(1)}"
        stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
  <rect x="${barX}" y="${bY.toFixed(1)}" width="${barW}" height="${bH.toFixed(1)}"
        fill="${color}" rx="2" opacity="${Math.abs(pct) > 0.01 ? 0.85 : 0.3}"/>
</svg>`;
  }

  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  // 以昨收為中心，固定 ±6% 對應畫布高度（統一比例，K棒大小一致）
  const center  = prev > 0 ? prev : close;
  const span    = center * 0.06;  // ±6%
  const minPY   = center - span;
  const maxPY   = center + span;

  // Y 座標換算（高價在上，以昨收為中心軸）
  const toY = v => PAD + (1 - (v - minPY) / (maxPY - minPY)) * (H - PAD * 2);

  const yOpen  = toY(open);
  const yClose = toY(close);
  const yHigh  = toY(high);
  const yLow   = toY(low);
  const yPrev  = toY(prev);

  const bodyTop    = Math.min(yOpen, yClose);
  const bodyH      = Math.max(Math.abs(yClose - yOpen), 1.5);  // 十字星至少 1.5px
  // 台股慣例：對比昨收判斷漲跌色（不是對比開盤）
  const isUp       = close >= prev;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">
  <line x1="${wickX}" y1="${yHigh.toFixed(1)}" x2="${wickX}" y2="${yLow.toFixed(1)}"
        stroke="${color}" stroke-width="1.5"/>
  <rect x="${barX}" y="${bodyTop.toFixed(1)}" width="${barW}" height="${bodyH.toFixed(1)}"
        fill="${color}" stroke="${color}" stroke-width="1.5" rx="1"/>
</svg>`;
}

/** 從 points string 生成 SVG markup */
function _svgFromPts(pts, color) {
  const last = pts.split(' ').pop().split(',');
  return `<svg width="${_SPARK_W}" height="${_SPARK_H}" viewBox="0 0 ${_SPARK_W} ${_SPARK_H}" style="display:block;">
  <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${last[0]}" cy="${last[1]}" r="2.3" fill="${color}"/>
</svg>`;
}

/** 同步取得 sparkline HTML（快取優先；未命中則排隊載入並回傳 placeholder） */
function _sparkHtmlSync(code, isUp, domId) {
  const color = isUp ? '#ef5350' : '#26a69a';

  // ★ bar 模式：從 __priceCache 拿 OHLC 畫今日 K 棒，不需要 IndexedDB，瞬間完成
  if (_sparkMode === 'bar') {
    const p = (window.__priceCache ?? {})[code];
    return _svgDayBar(p?.chgPct ?? 0, color, p);
  }

  let prices = null;
  if (_sparkMode === '40d') {
    prices = _kline40Cache.get(code) ?? null;
  } else {
    const c = _intradayCache.get(code);
    if (c && Date.now() - c.fetchedAt < _INTRADAY_TTL) prices = c.points;
  }

  if (prices?.length >= 2) {
    const pts = _pricesToSvgPts(prices);
    if (pts) return _svgFromPts(pts, color);
  }

  // 未命中 → 排隊
  _sparkQueue.add(code);
  return `<div class="wl-spark-ph"></div>`;
}

/** 更新已渲染 DOM 中的 sparkline 元素 */
function _updateSparkDom(code) {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  const p = (window.__priceCache ?? {})[code];
  const isUp = (p?.chgPct ?? 0) >= 0;
  const color = isUp ? '#ef5350' : '#26a69a';

  // ★ bar 模式：從 __priceCache 拿 OHLC 畫今日 K 棒
  if (_sparkMode === 'bar') {
    const svg = _svgDayBar(p?.chgPct ?? 0, color, p);
    container.querySelectorAll(`.wl-item[data-code="${CSS.escape(code)}"] .wl-item-right`)
      .forEach(el => { el.innerHTML = svg; });
    return;
  }

  let prices = null;
  if (_sparkMode === '40d') {
    prices = _kline40Cache.get(code) ?? null;
  } else {
    const c = _intradayCache.get(code);
    if (c) prices = c.points;
  }

  if (!prices?.length) return;
  const pts = _pricesToSvgPts(prices);
  if (!pts) return;

  // 找到所有含此 code 的 .wl-item-right 並更新
  container.querySelectorAll(`.wl-item[data-code="${CSS.escape(code)}"] .wl-item-right`)
    .forEach(el => { el.innerHTML = _svgFromPts(pts, color); });
}

/** 批次啟動 sparkline 載入（renderWatchlist 後呼叫，next tick） */
function _kickoffSparkLoads() {
  const allCodes = [...new Set(_groups.flatMap(g => g.stocks.map(s => s.code)))];
  // 只加尚未在快取中的 code（已有快取的在 renderWatchlist 裡同步畫了）
  // drain 已在跑時，只補 queue 不重啟，避免 _sparkRunning 鎖造成 code 永遠不畫
  for (const code of allCodes) {
    if (_sparkMode === '40d' && _kline40Cache.has(code)) continue;  // 已有快取，跳過
    _sparkQueue.add(code);
  }
  _drainSparkQueue();
}

async function _drainSparkQueue() {
  if (_sparkRunning) return;
  _sparkRunning = true;
  const myGen = _drainGen;   // 本次 drain 的世代，切換模式後會失效

  try {
    while (_sparkQueue.size > 0) {
      // 世代失效（_setSparkMode 被呼叫）→ 立刻棄場
      if (myGen !== _drainGen) break;

      // 今日模式連失太多 → 自動切回 40日
      if (_sparkMode === 'day' && _intradayFailStreak >= _INTRADAY_MAX_FAIL) {
        _sparkQueue.clear();
        // 用 setTimeout 避免在 drain 執行期間直接呼叫 _setSparkMode（會重設 _sparkRunning 造成競態）
        setTimeout(() => {
          showToast('⚠ 今日走勢暫時無法取得，已切換為 40 日');
          _intradayFailStreak = 0;
          _sparkMode = '40d';
          localStorage.setItem('wl_spark_mode', '40d');
          renderWatchlist();
        }, 0);
        break;
      }

      const code = _sparkQueue.values().next().value;
      _sparkQueue.delete(code);
      await _loadSparkForCode(code);

      // 今日模式：請求之間拉開間隔，減少 proxy 過載
      if (_sparkMode === 'day' && myGen === _drainGen) await _delay(600);
    }
  } finally {
    // 只有本世代才重設旗標；舊世代的 drain 失效後 _setSparkMode 已自己重設
    if (myGen === _drainGen) _sparkRunning = false;
  }
}

async function _loadSparkForCode(code) {
  if (_sparkMode === '40d') {
    if (_kline40Cache.has(code)) { _updateSparkDom(code); return; }
    // 直接傳 code，_readKline40 內部自動試 .TW / .TWO（與 theme-ui.js 一致）
    const candles = await _readKline40(code);
    const closes  = candles.length >= 2
      ? candles.slice(-40).map(c => c.close).filter(v => v != null)
      : [];
    _kline40Cache.set(code, closes);
  } else {
    const cached = _intradayCache.get(code);
    if (cached && Date.now() - cached.fetchedAt < _INTRADAY_TTL) { _updateSparkDom(code); return; }
    const points = await _fetchIntraday(code);
    _intradayCache.set(code, { points, fetchedAt: Date.now() });
  }
  _updateSparkDom(code);
}

/** 從 IndexedDB kline_cache 讀取 K 線
 *  先試 .TW，找不到自動試 .TWO（與 theme-ui.js _drawSparkline 一致）
 *  period 順序：1y → 3mo
 */
async function _readKline40(code) {
  try {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('stockdash');
      req.onsuccess       = () => res(req.result);
      req.onerror         = () => rej(req.error);
      req.onupgradeneeded = () => {};   // 純讀取，不改 schema
    });
    if (!db.objectStoreNames.contains('kline_cache')) return [];

    const _get = (symbol, period) => new Promise(res => {
      const tx  = db.transaction('kline_cache', 'readonly');
      const req = tx.objectStore('kline_cache').get(`${symbol}_${period}`);
      req.onsuccess = () => res(req.result?.candles ?? []);
      req.onerror   = () => res([]);
    });

    // 指數（^ 開頭）直接用 code 當 key，不加 suffix
    if (code.startsWith('^')) {
      for (const period of ['1y', '3mo']) {
        const candles = await _get(code, period);
        if (candles.length > 0) return candles;
      }
      return [];
    }

    // 一般股票：4碼以下先試 .TW，5碼以上先試 .TWO
    const sym1 = code.length <= 4 ? `${code}.TW` : `${code}.TWO`;
    const sym2 = code.length <= 4 ? `${code}.TWO` : `${code}.TW`;

    for (const symbol of [sym1, sym2]) {
      for (const period of ['1y', '3mo']) {
        const candles = await _get(symbol, period);
        if (candles.length > 0) return candles;
      }
    }
    return [];
  } catch (e) {
    console.warn('[watchlist] _readKline40 error:', e.message);
    return [];
  }
}

/**
 * 今日盤中 1d/5m — Yahoo Finance via proxy
 * ⚠️ 與 api.js 同一個 proxy，同一個 Token
 */
async function _fetchIntraday(code) {
  try {
    const symbol = toYahooSymbol(code);
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=5m`;
    const resp   = await fetch(_PROXY_URL + encodeURIComponent(url), {
      headers: { 'X-Proxy-Token': _PROXY_TOKEN },
      signal:  AbortSignal.timeout(5000),   // 5s 快失敗，不要卡太久
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data   = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no result');
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const valid  = closes.filter(c => c != null && !isNaN(c));
    _intradayFailStreak = 0;   // 成功 → 重設連失計數
    return valid;
  } catch (e) {
    _intradayFailStreak++;
    console.warn(`[watchlist] intraday ${code}: ${e.message} (連失 ${_intradayFailStreak}/${_INTRADAY_MAX_FAIL})`);
    return [];
  }
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── v3: 排序 ─────────────────────────────────────────────────────────────────

function _getSortedStocks(group) {
  const state = _sortState[group.id];
  if (!state?.key) return [...group.stocks];

  return [...group.stocks].sort((a, b) => {
    let va, vb;
    if (state.key === 'lamps') {
      // 燈號以帶正負號的 lamps 值排序（正=多頭，負=空頭）
      const sigsA = AppState.signals?.[a.code] ?? [];
      const sigsB = AppState.signals?.[b.code] ?? [];
      va = calcSignalLamps(sigsA, sigsA?._difPos !== false);
      vb = calcSignalLamps(sigsB, sigsB?._difPos !== false);
    } else if (state.key === 'name') {
      va = getChineseName(a.code) || a.name || '';
      vb = getChineseName(b.code) || b.name || '';
    } else {
      va = a[state.key] ?? 0;
      vb = b[state.key] ?? 0;
    }
    if (typeof va === 'string') return state.dir * va.localeCompare(vb, 'zh-TW');
    return state.dir * (va - vb);
  });
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────

let _renderLocked = false;

export function renderWatchlist() {
  if (_renderLocked) return;
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  // ── 背景批次讀 stockInfo（有 JSON 的個股顯示邊框）──
  const _allCodes = [...new Set(_groups.flatMap(g => g.stocks.map(s => s.code)))];
  Promise.all(_allCodes.map(c => loadStockInfo(c).then(info => [c, info]).catch(() => [c, null])))
    .then(pairs => {
      const newCache = {};
      pairs.forEach(([c, info]) => { if (info) newCache[c] = info; });
      // 有變化才重繪
      const changed = _allCodes.some(c => !!newCache[c] !== !!_siInfoCache[c]);
      _siInfoCache = newCache;
      if (changed) renderWatchlist();
    });

  // ── 從 __priceCache 補最新報價 ──
  // ⚠️ 判斷不能只看 s.price === p.price：chgPct 可能已更新，初次載入 s.price 是 undefined
  const cache = window.__priceCache ?? {};
  let _cacheUpdated = false;
  for (const g of _groups) {
    for (const s of g.stocks) {
      const p = cache[s.code];
      if (!p?.price) continue;
      if (s.price === p.price && s.chgPct === p.chgPct && s.price != null) continue;
      s.price  = p.price;
      s.chg    = p.chg  ?? (p.price - (p.prev ?? p.price));
      s.chgPct = p.chgPct ?? 0;
      _cacheUpdated = true;
    }
  }
  if (_cacheUpdated) _scheduleMisFlush();

  _groups.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  container.innerHTML = _renderSparkModeBar() + _groups.map(g => _renderGroup(g)).join('');
  _bindGroupEvents();

  // DOM 重建後，立即把已快取的 sparkline 同步畫上去（解決 drain race condition）
  if (_sparkMode === '40d') {
    // _kline40Cache 已有資料的 code 不需要等 drain，直接更新新 DOM
    for (const [code] of _kline40Cache) {
      _updateSparkDom(code);
    }
  } else if (_sparkMode === 'bar') {
    // bar 模式：全部同步畫，不需要 drain
    const allCodes = [...new Set(_groups.flatMap(g => g.stocks.map(s => s.code)))];
    for (const code of allCodes) {
      _updateSparkDom(code);
    }
  }

  // v3: 下一 tick 啟動 sparkline 載入（DOM 已就緒才可查 getElementById）
  setTimeout(_kickoffSparkLoads, 0);
}

/** 走勢圖切換 bar（今日 / 40日） */
function _renderSparkModeBar() {
  return `<div class="wl-spark-mode-bar">
  <span class="wl-spm-label">走勢圖</span>
  <div class="wl-sptg">
    ${FEATURE_INTRADAY_5M ? `<button class="wl-spt${_sparkMode === 'day' ? ' wl-spt-on' : ''}"
            data-action="set-spark-mode" data-mode="day">今日</button>` : ''}
    <button class="wl-spt${_sparkMode === 'bar' ? ' wl-spt-on' : ''}"
            data-action="set-spark-mode" data-mode="bar">今日K</button>
    <button class="wl-spt${_sparkMode === '40d' ? ' wl-spt-on' : ''}"
            data-action="set-spark-mode" data-mode="40d">40日</button>
  </div>
</div>`;
}

/** 渲染單一群組 */
function _renderGroup(group) {
  const isCollapsed = _collapsed.has(group.id);
  const sort = _sortState[group.id] || { key: null, dir: -1 };
  const sc   = SORT_CRITERIA.find(c => c.key === sort.key);
  const arr  = sort.dir === -1 ? '↓' : '↑';

  const sortItems = SORT_CRITERIA.map(c => {
    const act = sort.key === c.key;
    return `<div class="wl-ddi ${act ? 'wl-ddi-act' : ''}"
               data-action="sort-by" data-group-id="${group.id}" data-sort-key="${c.key}">
      <span>${c.label}</span><span class="wl-da">${act ? arr : ''}</span>
    </div>`;
  }).join('');

  const items = isCollapsed ? '' :
    _getSortedStocks(group).map(s => _renderStock(s, group.id)).join('');

  return `
<div class="wl-group" data-group-id="${group.id}" draggable="false">
  <div class="wl-group-header">
    <span class="wl-group-drag-handle" data-action="drag-group" title="拖曳排序">⠿</span>
    <span class="wl-chevron" data-action="toggle-group" data-group-id="${group.id}"
          aria-hidden="true">${isCollapsed ? '▶' : '▼'}</span>
    <span class="wl-group-name" data-action="toggle-group"
          data-group-id="${group.id}">${_esc(group.name)}</span>
    <span class="wl-group-count">${group.stocks.length}</span>

    <div class="wl-dd-wrap">
      <button class="wl-gb${sc ? ' wl-sort-on' : ''}"
              data-action="toggle-sort-dd" data-group-id="${group.id}" title="排序">
        ⇅${sc ? `<span class="wl-sort-label">${sc.label}${arr}</span>` : ''}
      </button>
      <div class="wl-sort-dd" id="sort-dd-${group.id}">
        <div class="wl-dd-lbl">排序方式</div>
        ${sortItems}
        <div class="wl-dd-sep"></div>
        <div class="wl-ddi ${!sort.key ? 'wl-ddi-act' : ''}"
             data-action="sort-by" data-group-id="${group.id}" data-sort-key="">
          <span>預設順序</span><span class="wl-da">${!sort.key ? '✓' : ''}</span>
        </div>
      </div>
    </div>

    <div class="wl-dd-wrap">
      <button class="wl-gb" data-action="toggle-more-dd"
              data-group-id="${group.id}" title="群組選項">···</button>
      <div class="wl-more-dd" id="more-dd-${group.id}">
        <div class="wl-ddi" data-action="export-group" data-group-id="${group.id}">
          <i class="ti ti-download" style="font-size:13px;" aria-hidden="true"></i>匯出 JSON
        </div>
        <div class="wl-ddi" data-action="rename-group" data-group-id="${group.id}">
          <i class="ti ti-edit" style="font-size:13px;" aria-hidden="true"></i>重新命名
        </div>
        <div class="wl-dd-sep"></div>
        <div class="wl-ddi wl-ddi-danger" data-action="delete-group"
             data-group-id="${group.id}">
          <i class="ti ti-trash" style="font-size:13px;" aria-hidden="true"></i>刪除群組
        </div>
      </div>
    </div>
  </div>

  <div class="wl-group-body ${isCollapsed ? 'collapsed' : ''}">
    ${items}
  </div>
</div>`;
}

/** 渲染單一個股行 */
function _renderStock(stock, groupId) {
  const displayName = getChineseName(stock.code) || stock.name || stock.code;
  const isUp   = (stock.chgPct ?? 0) >= 0;
  const color  = isUp ? '#ef5350' : '#26a69a';
  const sign   = isUp ? '+' : '';

  const priceStr = stock.price != null ? _formatPrice(stock.price) : '—';
  const chgStr   = stock.chgPct != null
    ? `${sign}${stock.chgPct.toFixed(2)}%` : '—';

  // 五燈獎
  const signals = AppState.signals?.[stock.code] ?? [];
  const lamps   = calcSignalLamps(signals, signals?._difPos !== false);
  const lampHtml = lamps !== 0 ? _renderLamps(lamps, signals) : '';

  // 妖股圓點
  const ys        = AppState.yaoguStatus?.[stock.code] ?? null;
  const yaoguDot  = ys ? _renderYaoguDot(ys) : '';

  // ×N 重複標記
  const dupCount = _groups.filter(g => g.stocks.some(s => s.code === stock.code)).length;
  const dupBadge = dupCount > 1
    ? `<span class="wl-dup-badge" title="出現在 ${dupCount} 個清單">×${dupCount}</span>`
    : '';

  // 走勢圖（同步取快取；未命中 → placeholder + 排隊載入）
  const sparkHtml = _sparkHtmlSync(stock.code, isUp);

  // stockInfo 邊框 class + pill（只有過期才顯示，新鮮資料不干擾 UI）
  const _si = _siInfoCache[stock.code] ?? null;
  let _siBorderCls = '';
  let _siPillHtml  = '';
  if (_si?.forward?.story || _si?.forward?.consensus) {
    const _updatedAt = _si.forward.updatedAt;
    const daysSince  = _updatedAt
      ? Math.floor((Date.now() - new Date(_updatedAt).getTime()) / 86400000)
      : null;
    if (daysSince == null || daysSince < 30) {
      // 30天內：只加邊框，不顯示 pill
      _siBorderCls = 'wl-si-fresh';
    } else if (daysSince < 60) {
      _siBorderCls = 'wl-si-warn';
      _siPillHtml  = `<span class="wl-si-pill wl-si-pill-warn">${daysSince}天前更新</span>`;
    } else {
      _siBorderCls = 'wl-si-stale';
      _siPillHtml  = `<span class="wl-si-pill wl-si-pill-stale">${daysSince}天前更新</span>`;
    }
  }

  return `
<div class="wl-item ${_siBorderCls}" data-code="${stock.code}" data-group-id="${groupId}"
     draggable="true" data-action="select-stock">
  <button class="wl-remove-btn" data-action="remove-stock"
          data-code="${stock.code}" data-group-id="${groupId}" title="移除">×</button>

  <div class="wl-item-left">
    <div class="wl-code-row">
      <span class="wl-code">${_esc(stock.code)}</span>
      ${dupBadge}
      ${_siPillHtml}
    </div>
    <div class="wl-name-row" style="font-size:12px;color:#8a8f99;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
      <span class="wl-name">${_esc(displayName)}</span>
    </div>
    <div class="wl-price">${priceStr}</div>
    <div class="wl-chg ${isUp ? 'wl-chg-up' : 'wl-chg-dn'}">${chgStr}</div>
    ${lampHtml || yaoguDot
      ? `<div class="wl-lamps-row">${lampHtml}${yaoguDot}</div>`
      : ''}
  </div>

  <div class="wl-item-right">${sparkHtml}</div>
</div>`;
}

/** 股價格式化 */
function _formatPrice(p) {
  if (p == null || isNaN(p)) return '—';
  const hasDec = p % 1 !== 0;
  if (p >= 1000) return p.toLocaleString('zh-TW', {
    minimumFractionDigits: hasDec ? 1 : 0,
    maximumFractionDigits: hasDec ? 1 : 0,
  });
  return hasDec ? p.toFixed(1) : String(p);
}

/**
 * 妖股狀態小圓點（v2.8 原版，保留）
 */
// ── 妖股燈五階段設定 ─────────────────────────────────────────
// watching（觀察中）超過 _YAOGU_HISTORY_DAYS 天後不再顯示
const _YAOGU_HISTORY_DAYS = 5;

const _YAOGU_CFG = {
  active:   { color: '#f59e0b', cls: 'wl-yaogu-active'   }, // 金閃  主升段
  warning1: { color: '#f59e0b', cls: 'wl-yaogu-warn1'    }, // 金亮  弱妖
  warning2: { color: '#ef4444', cls: 'wl-yaogu-warn2'    }, // 紅閃  出貨警示
  exit:     { color: '#38bdf8', cls: 'wl-yaogu-exit'     }, // 藍閃  最後出場警示
  exited:   { color: '#38bdf8', cls: 'wl-yaogu-exit'     }, // 相容舊版 status 字串
  watching: { color: '#6b7280', cls: 'wl-yaogu-watching' }, // 灰亮  曾是妖股（5日內）
};

function _renderYaoguDot(ys) {
  if (!ys) return '';

  // 觀察中超過 5 個交易日 → 不顯示，歷史訊號已失效
  if (ys.status === 'watching' && (ys.daysSince ?? 99) > _YAOGU_HISTORY_DAYS) return '';

  const cfg  = _YAOGU_CFG[ys.status] ?? _YAOGU_CFG.watching;
  const days = ys.daysSince != null ? ` · 第${ys.daysSince}天` : '';
  const tip  = `${ys.label}${days}\n${ys.desc ?? ''}`;

  return `<span class="wl-yaogu-dot ${cfg.cls}"
               style="background:${cfg.color}" title="${tip}"></span>`;
}

/**
 * 五燈 HTML（v2.6 — 支援負數綠燈、金燈、危險綠燈）
 * ⚠️ 台股：紅=多頭買進訊號，綠=空頭/避險訊號
 */
function _renderLamps(lamps, signals) {
  const abs      = Math.abs(lamps);
  const isBull   = lamps > 0;
  const isBear   = lamps < 0;
  const isGolden = isBull && abs >= 5.0;
  const isDanger = isBear && abs >= 5.0;

  let colorCls;
  if      (isGolden) colorCls = 'lamps-golden';
  else if (isDanger) colorCls = 'lamps-danger';
  else if (isBull)   colorCls = 'lamps-pos';
  else               colorCls = 'lamps-neg';

  const sigList = Array.isArray(signals) ? signals : [];
  const tip     = sigList.map(s => s.name).join('、');

  const fullLamps = Math.floor(abs);
  const hasHalf   = (abs % 1) === 0.5;

  const dots = Array.from({ length: 5 }, (_, i) => {
    if (i < fullLamps)              return `<span class="wl-lamp on"></span>`;
    if (i === fullLamps && hasHalf) return `<span class="wl-lamp half"></span>`;
    return `<span class="wl-lamp"></span>`;
  }).join('');

  return `<div class="wl-lamps ${colorCls}" title="${tip}">${dots}</div>`;
}

// ─── v3: Dropdown helpers ─────────────────────────────────────────────────────

function _closeAllDropdowns() {
  document.querySelectorAll('.wl-sort-dd.open, .wl-more-dd.open')
    .forEach(dd => dd.classList.remove('open'));
}

function _toggleDropdown(id) {
  const dd = document.getElementById(id);
  if (!dd) return;
  const wasOpen = dd.classList.contains('open');
  _closeAllDropdowns();
  if (!wasOpen) dd.classList.add('open');
}

function _setSparkMode(mode) {
  if (mode !== 'day' && mode !== '40d' && mode !== 'bar') return;
  if (mode === 'day' && !FEATURE_INTRADAY_5M) return;  // ★ 無 FinMind token，今日模式鎖定
  _drainGen++;                           // 使當前正在跑的 drain 世代失效
  _sparkRunning = false;                 // 強制釋放鎖（舊 drain 的 finally 會跳過重設）
  _sparkQueue.clear();
  _sparkMode = mode;
  localStorage.setItem('wl_spark_mode', mode);
  if (mode === 'day') _intradayFailStreak = 0;  // 手動切回今日 → 重新計數
  renderWatchlist();
}

function _applySort(groupId, rawKey) {
  _closeAllDropdowns();
  const key = rawKey || null;
  if (!_sortState[groupId]) _sortState[groupId] = { key: null, dir: -1 };
  const cur = _sortState[groupId];
  if (!key) {
    cur.key = null;
  } else if (cur.key === key) {
    cur.dir *= -1;   // 再點一次 → 翻轉升降冪
  } else {
    cur.key = key;
    // 文字類預設升冪（A→Z），數值類預設降冪（大→小）
    cur.dir = (key === 'code' || key === 'name') ? 1 : -1;
  }
  renderWatchlist();
}

// ─── 群組內事件委派 ──────────────────────────────────────────────────────────

function _bindGroupEvents() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  if (container.dataset.bound === '1') {
    _bindDragDrop();
    _bindHandles();
    return;
  }
  container.dataset.bound = '1';
  container.addEventListener('click', _handleGroupClick);
  _bindDragDrop();
  _bindHandles();
}

function _handleGroupClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action  = btn.dataset.action;
  const groupId = btn.dataset.groupId;
  const code    = btn.dataset.code;

  // 阻止冒泡到父層 toggle-group
  const stopList = [
    'rename-group', 'delete-group', 'remove-stock', 'export-group',
    'toggle-sort-dd', 'toggle-more-dd', 'sort-by', 'set-spark-mode',
  ];
  if (stopList.includes(action)) e.stopPropagation();

  switch (action) {
    case 'toggle-group':
      _toggleGroup(groupId);
      break;
    case 'export-group':
      _closeAllDropdowns();
      exportGroupJSON(groupId);
      break;
    case 'rename-group':
      _closeAllDropdowns();
      _promptRenameGroup(groupId);
      break;
    case 'delete-group':
      _closeAllDropdowns();
      _confirmDeleteGroup(groupId);
      break;
    case 'remove-stock':
      removeStockFromGroup(code, groupId);
      break;
    case 'select-stock':
      document.dispatchEvent(new CustomEvent('stockSelect', { detail: { code } }));
      break;

    // ── v3: 新增 actions ──────────────────────────────────────
    case 'set-spark-mode':
      _setSparkMode(btn.dataset.mode);
      break;
    case 'toggle-sort-dd':
      _toggleDropdown(`sort-dd-${groupId}`);
      break;
    case 'toggle-more-dd':
      _toggleDropdown(`more-dd-${groupId}`);
      break;
    case 'sort-by':
      _applySort(groupId, btn.dataset.sortKey);
      break;
  }
}

// ─── Sidebar 工具列事件 ────────────────────────────────────────────────────────

let _importFileInput = null;

function _bindSidebarEvents() {
  const addGroupBtn = document.getElementById('watchlistAddGroup');
  const importBtn   = document.getElementById('watchlistImportBtn');
  const siListBtn   = document.getElementById('watchlistSiListBtn');

  if (addGroupBtn && !addGroupBtn.dataset.bound) {
    addGroupBtn.dataset.bound = '1';
    addGroupBtn.addEventListener('click', () => _promptCreateGroup());
  }
  if (importBtn && !importBtn.dataset.bound) {
    importBtn.dataset.bound = '1';
    importBtn.addEventListener('click', () => _triggerImport());
  }
  if (siListBtn && !siListBtn.dataset.bound) {
    siListBtn.dataset.bound = '1';
    siListBtn.addEventListener('click', () => { _closeAllDropdowns(); _showSiListPanel(); });
  }

  // ── v3: 點 dropdown 外部時關閉所有 dropdown ──────────────────
  if (!document.body.dataset.wlDdBound) {
    document.body.dataset.wlDdBound = '1';
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.wl-dd-wrap') && !e.target.closest('.wl-spark-mode-bar')) {
        _closeAllDropdowns();
      }
    });
  }
}

// ─── 補充資訊清單面板 ──────────────────────────────────────────────────────────

function _showSiListPanel() {
  // 收集所有有 stockInfo 的個股
  const allCodes = [...new Set(_groups.flatMap(g => g.stocks.map(s => s.code)))];
  const rows = [];
  for (const code of allCodes) {
    const info = _siInfoCache[code];
    if (!info?.forward?.story && !info?.forward?.consensus) continue;
    const name       = getChineseName(code) || code;
    const updatedAt  = info.forward.updatedAt ?? null;
    const daysSince  = updatedAt
      ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000)
      : null;
    rows.push({ code, name, updatedAt, daysSince });
  }

  // 排序：過期最久的優先
  rows.sort((a, b) => (b.daysSince ?? 0) - (a.daysSince ?? 0));

  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  // CSS 注入（只注入一次）
  if (!document.getElementById('wl-si-list-style')) {
    const s = document.createElement('style');
    s.id = 'wl-si-list-style';
    s.textContent = `
      .wl-si-panel { padding: 10px 12px; }
      .wl-si-panel-header {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 10px; padding-bottom: 8px;
        border-bottom: 0.5px solid rgba(255,255,255,.08);
      }
      .wl-si-panel-title { font-size: 13px; font-weight: 500; color: #e8eaed; flex: 1; }
      .wl-si-panel-close {
        background: none; border: none; color: #8a8f99;
        font-size: 16px; cursor: pointer; padding: 0 4px;
      }
      .wl-si-panel-close:hover { color: #e8eaed; }
      .wl-si-row {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 4px; border-bottom: 0.5px solid rgba(255,255,255,.05);
        cursor: pointer;
      }
      .wl-si-row:hover { background: rgba(255,255,255,.04); border-radius: 4px; }
      .wl-si-row-code { font-size: 13px; font-weight: 500; color: #e8eaed; font-family: monospace; min-width: 44px; }
      .wl-si-row-name { font-size: 12px; color: #c9d1d9; flex: 1; }
      .wl-si-row-arrow { font-size: 14px; color: #8a8f99; }
      .wl-si-empty { font-size: 13px; color: #8a8f99; padding: 20px 0; text-align: center; }
      .wl-si-pill {
        font-size: 10px; font-weight: 500;
        padding: 2px 6px; border-radius: 3px; white-space: nowrap; flex-shrink: 0;
      }
      .wl-si-pill-ok    { background: #ef5350; color: #fff; }
      .wl-si-pill-warn  { background: #f59e0b; color: #fff; }
      .wl-si-pill-stale { background: #26a69a; color: #fff; }
      .wl-si-fresh { border-left: 2px solid #ef5350; padding-left: 6px; }
      .wl-si-warn  { border-left: 2px solid #f59e0b; padding-left: 6px; }
      .wl-si-stale { border-left: 2px solid #26a69a; padding-left: 6px; }
    `;
    document.head.appendChild(s);
  }

  // 渲染清單
  const rowsHtml = rows.length === 0
    ? `<div class="wl-si-empty">目前沒有補充資訊</div>`
    : rows.map(r => {
        let pillCls, pillText, rowCls;
        if (r.daysSince == null || r.daysSince < 30) {
          pillCls = 'wl-si-pill-ok';   pillText = '正常';               rowCls = 'wl-si-fresh';
        } else if (r.daysSince < 60) {
          pillCls = 'wl-si-pill-warn';  pillText = `${r.daysSince}天前更新`; rowCls = 'wl-si-warn';
        } else {
          pillCls = 'wl-si-pill-stale'; pillText = `${r.daysSince}天前更新`; rowCls = 'wl-si-stale';
        }
        return `<div class="wl-si-row ${rowCls}" data-si-code="${r.code}">
          <span class="wl-si-row-code">${r.code}</span>
          <span class="wl-si-row-name">${r.name}</span>
          <span class="wl-si-pill ${pillCls}">${pillText}</span>
          <span class="wl-si-row-arrow">›</span>
        </div>`;
      }).join('');

  container.innerHTML = `
    <div class="wl-si-panel">
      <div class="wl-si-panel-header">
        <span class="wl-si-panel-title">補充資訊清單</span>
        <button class="wl-si-panel-close" id="wlSiPanelClose">✕</button>
      </div>
      ${rowsHtml}
    </div>`;

  // 關閉按鈕
  document.getElementById('wlSiPanelClose')?.addEventListener('click', () => renderWatchlist());

  // 點列 → 開啟個股補充資訊
  container.querySelectorAll('.wl-si-row[data-si-code]').forEach(row => {
    row.addEventListener('click', () => {
      const code = row.dataset.siCode;
      // 發送 stockSelect 事件（讓 main.js 切換個股）
      document.dispatchEvent(new CustomEvent('stockSelect', { detail: { code } }));
      // 切換到補充資訊 tab（stockinfo）
      setTimeout(() => {
        const siTab = document.querySelector('.stock-tab[data-stock-tab="stockinfo"]');
        siTab?.click();
      }, 300);
    });
  });
}

function _triggerImport() {
  if (!_importFileInput) {
    _importFileInput = document.createElement('input');
    _importFileInput.type   = 'file';
    _importFileInput.accept = '.json';
    _importFileInput.style.display = 'none';
    document.body.appendChild(_importFileInput);
    _importFileInput.addEventListener('change', () => _handleImportFile(_importFileInput));
  }
  _importFileInput.value = '';
  _importFileInput.click();
}

// ─── 匯出 JSON ────────────────────────────────────────────────────────────────

export function exportGroupJSON(groupId) {
  const g = _groups.find(g => g.id === groupId);
  if (!g) return;
  const json = JSON.stringify({ name: g.name, stocks: g.stocks }, null, 2);
  const blob  = new Blob([json], { type: 'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `watchlist_${g.name}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 匯入 JSON ────────────────────────────────────────────────────────────────

async function _handleImportFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text   = await file.text();
    const data   = JSON.parse(text);
    const groups = Array.isArray(data) ? data : [data];
    for (const g of groups) {
      if (!Array.isArray(g.stocks)) continue;
      const name     = g.name ?? file.name.replace('.json', '');
      const stocks   = g.stocks.filter(s => s?.code);
      const newGroup = _makeGroup(`${name}（匯入）`, _groups.length);
      newGroup.stocks = stocks;
      _groups.push(newGroup);
      await saveGroup(newGroup);
    }
    AppState.watchlistGroups = _groups;
    renderWatchlist();
    showToast('✓ 匯入成功，已建立新群組');
  } catch (err) {
    showToast('⚠ 匯入失敗：' + err.message);
  }
}

// ─── 群組操作 ─────────────────────────────────────────────────────────────────

function _toggleGroup(id) {
  _collapsed.has(id) ? _collapsed.delete(id) : _collapsed.add(id);
  renderWatchlist();
}

export async function createGroup(name) {
  const g = _makeGroup(name, _groups.length);
  _groups.push(g);
  await saveGroup(g);
  renderWatchlist();
  return g.id;
}

async function _confirmDeleteGroup(id) {
  const g = _groups.find(g => g.id === id);
  if (!g) return;
  if (g.id === 'default' && _groups.length === 1) { showToast('至少保留一個清單'); return; }
  _showConfirm(
    `刪除「${g.name}」？`,
    '群組內個股將一併移除，無法復原。',
    () => deleteGroup(id),
  );
}

export async function deleteGroup(id) {
  _groups = _groups.filter(g => g.id !== id);
  await dbDeleteGroup(id);
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

// ─── v3: 自訂確認 Modal（取代原生 confirm()，手機友善） ───────────────────────

/**
 * 顯示自訂確認框（取代 window.confirm）
 * @param {string} title   主標題（粗）
 * @param {string} body    說明文字
 * @param {Function} onOk  按下確認後的 callback
 * @param {string} okLabel 確認按鈕文字，預設「刪除」
 */
function _showConfirm(title, body, onOk, okLabel = '刪除') {
  let overlay = document.getElementById('wl-confirm-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'wl-confirm-overlay';
    overlay.className = 'wl-confirm-overlay';
    overlay.innerHTML = `
      <div class="wl-confirm-modal" role="dialog" aria-modal="true">
        <p class="wl-confirm-title"></p>
        <p class="wl-confirm-body"></p>
        <div class="wl-confirm-btns">
          <button class="wl-confirm-cancel">取消</button>
          <button class="wl-confirm-ok"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // 點遮罩取消
    overlay.addEventListener('click', e => { if (e.target === overlay) _closeConfirm(); });
  }

  overlay.querySelector('.wl-confirm-title').textContent = title;
  overlay.querySelector('.wl-confirm-body').textContent  = body;
  overlay.querySelector('.wl-confirm-ok').textContent    = okLabel;
  overlay.style.display = 'flex';

  // 換掉舊 listener（clone node 清除之前綁的事件）
  const oldOk     = overlay.querySelector('.wl-confirm-ok');
  const oldCancel = overlay.querySelector('.wl-confirm-cancel');
  const newOk     = oldOk.cloneNode(true);
  const newCancel = oldCancel.cloneNode(true);
  oldOk.replaceWith(newOk);
  oldCancel.replaceWith(newCancel);

  newOk.addEventListener('click', () => { _closeConfirm(); onOk(); });
  newCancel.addEventListener('click', _closeConfirm);
}

function _closeConfirm() {
  const el = document.getElementById('wl-confirm-overlay');
  if (el) el.style.display = 'none';
}

async function _promptCreateGroup() {
  const name = prompt('新群組名稱：');
  if (!name?.trim()) return;
  await createGroup(name.trim());
}

async function _promptRenameGroup(id) {
  const g = _groups.find(g => g.id === id);
  if (!g) return;
  const name = prompt('重新命名：', g.name);
  if (!name?.trim() || name.trim() === g.name) return;
  g.name = name.trim();
  await saveGroup(g);
  renderWatchlist();
}

// ─── 個股操作 ─────────────────────────────────────────────────────────────────

export async function addStockToGroup(stock, groupId) {
  const g = _groups.find(g => g.id === groupId);
  if (!g) return;

  if (g.stocks.some(s => s.code === stock.code)) {
    showToast(`${stock.code} 已在「${g.name}」`);
    return;
  }

  const chName = getChineseName(stock.code);
  if (chName) stock = { ...stock, name: chName };

  g.stocks.push(stock);
  await saveGroup(g);
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

export async function removeStockFromGroup(code, groupId) {
  const g = _groups.find(g => g.id === groupId);
  if (!g) return;
  g.stocks = g.stocks.filter(s => s.code !== code);
  await saveGroup(g);
  AppState.watchlistGroups = _groups;
  renderWatchlist();
}

export async function updateStockPrices(priceMap) {
  let dirty = false;
  for (const g of _groups) {
    for (const s of g.stocks) {
      const p = priceMap[s.code];
      if (!p) continue;
      s.price  = p.price;
      s.chg    = p.chg;
      s.chgPct = p.chgPct;
      dirty = true;
    }
  }
  if (dirty) {
    for (const g of _groups) await saveGroup(g);
    renderWatchlist();
  }
}

/**
 * updateStockPricesFromMis — 盤中輪詢專用
 * ⚠️ 踩雷備忘（永久，2026-05-21）：
 *   舊版完全不寫 IndexedDB，F5 後回到上次盤後價。
 *   新邏輯：每次 push 都重置 5 秒 debounce timer。
 *   ⚠️ 自選輪詢的 await updateStockPrices 仍要保留（整輪強制 flush 的保險）。
 */
export function updateStockPricesFromMis(misMap) {
  let dirty = false;
  for (const g of _groups) {
    for (const s of g.stocks) {
      const p = misMap[s.code];
      if (!p) continue;
      s.price  = p.price;
      s.chgPct = p.chgPct;
      s.chg    = p.price - p.prev;
      dirty    = true;
    }
  }
  if (dirty) {
    renderWatchlist();
    _scheduleMisFlush();
  }
}

export function getDefaultGroupId() { return _groups[0]?.id ?? 'default'; }
export function getGroups()         { return _groups; }

// ─── 拖曳排序（個股跨群組移動） ───────────────────────────────────────────────

function _bindDragDrop() {
  const container = document.getElementById('watchlistContainer');
  if (!container || container.dataset.dragBound === '1') return;
  container.dataset.dragBound = '1';

  let dragCode = null, dragGroupId = null;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.wl-item');
    if (!item) return;
    dragCode    = item.dataset.code;
    dragGroupId = item.dataset.groupId;
    e.dataTransfer.effectAllowed = 'copyMove';
    item.classList.add('dragging');
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest('.wl-item');
    if (item) item.classList.remove('dragging');
    dragCode = dragGroupId = null;
    container.querySelectorAll('.wl-group').forEach(el => el.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragCode) return;
    const groupEl    = e.target.closest('.wl-group');
    const currentOver = container.querySelector('.wl-group.drag-over');
    if (currentOver !== groupEl) {
      if (currentOver) currentOver.classList.remove('drag-over');
      if (groupEl) groupEl.classList.add('drag-over');
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.querySelectorAll('.wl-group').forEach(el => el.classList.remove('drag-over'));
    const targetGroup = e.target.closest('.wl-group');
    if (!targetGroup || !dragCode) return;
    const toGroupId = targetGroup.dataset.groupId;
    if (toGroupId === dragGroupId) return;

    const fromGroup = _groups.find(g => g.id === dragGroupId);
    const toGroup   = _groups.find(g => g.id === toGroupId);
    if (!fromGroup || !toGroup) return;

    const stock = fromGroup.stocks.find(s => s.code === dragCode);
    if (!stock) return;

    if (!toGroup.stocks.some(s => s.code === stock.code)) {
      toGroup.stocks.push({ ...stock });
      await saveGroup(toGroup);
      AppState.watchlistGroups = _groups;
      if (_collapsed.has(toGroupId)) _collapsed.delete(toGroupId);
      renderWatchlist();
      showToast(`${stock.code} 已複製到「${toGroup.name}」`);
    } else {
      showToast(`${stock.code} 已在「${toGroup.name}」`);
    }
    dragCode = dragGroupId = null;
  });
}

// ─── 群組拖曳排序 ─────────────────────────────────────────────────────────────

let _draggingGroupEl = null;

async function _saveGroupOrder() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;
  [...container.querySelectorAll('.wl-group')].forEach((el, i) => {
    const g = _groups.find(g => g.id === el.dataset.groupId);
    if (g) g.order = i;
  });
  await Promise.all(_groups.map(g => saveGroup(g)));
  AppState.watchlistGroups = _groups;
}

function _bindHandles() {
  const container = document.getElementById('watchlistContainer');
  if (!container) return;

  container.querySelectorAll('[data-action="drag-group"]').forEach(handle => {
    if (handle.dataset.handleBound) return;
    handle.dataset.handleBound = '1';

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const groupEl = handle.closest('.wl-group');
      if (!groupEl) return;
      _draggingGroupEl = groupEl;
      _renderLocked    = true;
      groupEl.classList.add('dragging-group');

      const onMove = (ev) => {
        if (!_draggingGroupEl) return;
        _draggingGroupEl.style.pointerEvents = 'none';
        const elBelow = document.elementFromPoint(ev.clientX, ev.clientY);
        _draggingGroupEl.style.pointerEvents = '';
        const overGroup = elBelow?.closest('.wl-group');
        if (!overGroup || overGroup === _draggingGroupEl) return;
        const rect = overGroup.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          container.insertBefore(_draggingGroupEl, overGroup);
        } else {
          container.insertBefore(_draggingGroupEl, overGroup.nextSibling);
        }
      };

      const onUp = async () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        if (_draggingGroupEl) {
          _draggingGroupEl.classList.remove('dragging-group');
          _draggingGroupEl = null;
          await _saveGroupOrder();
          _renderLocked = false;
          renderWatchlist();
        } else {
          _renderLocked = false;
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function _makeGroup(name, order) {
  return { id: _uuid(), name, order, stocks: [] };
}

function _uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function _esc(str) {
  return str?.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) ?? '';
}
