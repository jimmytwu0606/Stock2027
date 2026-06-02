/**
 * api.js
 * 資料層：Yahoo Finance、TWSE、FinMind、新聞 RSS
 *
 * export：
 *   toYahooSymbol(code)
 *   fetchQuote(symbol)
 *   fetchHistory(symbol, period)
 *   fetchTWSEPrices()
 *   fetchScreenerData(codes, opts)
 *   fetchFundamentals(symbol, code)   ← v8 基礎版 + FinMind 完整版自動切換
 *   fetchChipData(code)
 *   fetchNews(symbol, stockName)      ← 依 Config.newsSource 切換來源
 *   fetchAnnouncements(code)
 */

import { getDataSource, getFinMindToken, getNewsSource } from './config.js';

/**
 * 今日盤中 5m K / Sparkline 功能開關
 * ★ 引信：FinMind 付費訂閱後在 config.js 填入 token → 自動 true → 開通今日走勢圖
 *   false 時完全不打 Yahoo 5m，避免 IP 被 Yahoo throttle 連帶影響 K 線 prewarm
 */
export const FEATURE_INTRADAY_5M = !!getFinMindToken();
import { getKlineCache, setKlineCache } from './db.js';
// Advanced 1 — 讀取 Cron Worker 寫入的 Firestore 共享資料
import { fsGetShared } from './firebase.js';

// ─────────────────────────────────────────────
// OTC 上櫃代號集合（由 fetchTWSEPrices 動態填充）
// ─────────────────────────────────────────────
const _otcSet = new Set();   // 上櫃代號，fetchTWSEPrices 呼叫後自動填入

/**
 * 將純代號轉為 Yahoo Finance symbol
 *   上市（TWSE）→ xxxx.TW
 *   上櫃（TPEx）→ xxxx.TWO
 * 判斷依據：_otcSet（由 fetchTWSEPrices 動態建立）
 * _otcSet 尚未載入時預設 .TW，loadStock 會透過 resolveYahooSymbol 自動 fallback
 */
export function toYahooSymbol(code) {
  if (/^\d{4,5}$/.test(code)) {
    return _otcSet.has(code) ? `${code}.TWO` : `${code}.TW`;
  }
  if (/^\d{4}[A-Z]$/i.test(code)) return `${code.toUpperCase()}.TW`;
  return code.toUpperCase();
}

/**
 * 智慧解析 Yahoo symbol：
 * 若 _otcSet 尚未載入，先試 .TW，若 404 再試 .TWO（或反之）
 * 回傳 { symbol, candles } 而不是拋出錯誤
 */
/**
 * 智慧解析 Yahoo symbol：純數字代號永遠試 .TW 和 .TWO 兩個 suffix
 *
 * ⚠️⚠️⚠️ 警告 ⚠️⚠️⚠️
 * 這個函式踩過多次坑，修改前請務必讀完以下說明：
 *
 * 1. 【絕對不要】因為 `_otcSet.size > 0` 就只試一個 suffix。
 *    _otcSet 可能不完整、過時，或在某些 race condition 下被清空。
 *    永遠 fallback 兩個 suffix 才是穩定做法。
 *
 * 2. 【絕對不要】把 _otcSet 改成「精確判斷器」。它只是「優先順序提示」。
 *
 * 3. 【絕對不要】讓上市/上櫃/ETF 走不同函式。理由：
 *    - ETF（0050、00878 等）和上市股同樣用 .TW
 *    - 5 位數代號可能是上市也可能是上櫃
 *    - 統一試 .TW 和 .TWO 比維護分類清單穩
 *
 * 4. 【回傳值是物件】{ symbol, candles }，不是字串！
 *    呼叫方務必用解構：const { candles } = await resolveYahooSymbol(code);
 *    曾經有人寫成 `const symbol = await resolveYahooSymbol(code)` →
 *    URL 變 [object Object].TW → 全市場 404。
 *
 * 5. 【fetchHistory 已內部呼叫】不要在外面再 fetchHistory 一次。
 *
 * 若 .TW / .TWO 都失敗 → throw Error
 */
export async function resolveYahooSymbol(code, period, opts = {}) {
  if (!/^\d{4,6}$/.test(code)) {
    // 非純數字代號（含 .TW 等已組好的 symbol），直接用
    const sym = toYahooSymbol(code);
    const candles = await fetchHistoryCached(sym, period, opts);
    return { symbol: sym, candles };
  }

  // 純數字代號（4-6 位數）：根據 _otcSet 決定優先順序
  // _otcSet 內有 → 先試 .TWO；否則先試 .TW
  // ⚠ 兩個都會試一遍！這是必要的容錯，不要省略
  const isOTCHint = _otcSet.has(code);
  const suffixes  = isOTCHint ? ['.TWO', '.TW'] : ['.TW', '.TWO'];

  for (const suffix of suffixes) {
    try {
      const sym = `${code}${suffix}`;
      const candles = await fetchHistoryCached(sym, period, opts);
      if (candles.length > 0) {
        // 記錄到 _otcSet 以加速下次查找
        if (suffix === '.TWO') _otcSet.add(code);
        return { symbol: sym, candles };
      }
    } catch (e) {
      const msg = String(e?.message ?? '');
      // ⚠️ 踩雷備忘（永久，2026-05-26）：
      //   502 / proxy 全死時，舊邏輯直接 throw，永遠不試下一個 suffix。
      //   6570（上櫃）送 .TW → Worker 502 → throw → 從沒試 .TWO → 健康度永遠 `-`。
      //   修法：只要不是「代號確實存在但無資料」的明確錯誤，就繼續試下一個 suffix。
      //   「代號不存在」的明確訊號：Not Found / 無法取得 / symbol may be delisted
      //   其他（502 / timeout / 限流）→ continue 試下一個 suffix，不 throw
      const isDefinitelyMissing =
        msg.includes('Not Found') ||
        msg.includes('無法取得') ||
        msg.includes('symbol may be delisted');
      const isLastSuffix = suffixes.indexOf(suffix) === suffixes.length - 1;
      // 最後一個 suffix 且明確代號不存在 → 才 throw，其餘一律 continue 試下一個
      if (isDefinitelyMissing && isLastSuffix) throw e;
      // 其他情況（502/timeout/限流/非最後一個）→ 繼續試下一個 suffix
    }
  }
  throw new Error(`無法取得 ${code} 的 K 線資料（.TW / .TWO 皆無）`);
}

// ─────────────────────────────────────────────
// CORS Proxy
// ─────────────────────────────────────────────

/**
 * 自架 Cloudflare Worker proxy（推薦，最穩定）
 * 設定方式：
 *   1. 部署你自己的 Worker（教學見 README）
 *   2. 把下面的 null 改成你的 Worker URL，例如：
 *      const SELF_PROXY = 'https://my-cors.your-name.workers.dev/?url=';
 *   3. SELF_PROXY 會優先使用，掛掉才 fallback 到公開 proxy
 */
const SELF_PROXY = 'https://stock-2027.luffy0606.workers.dev/?url=';   // 使用者自架 Worker
const PROXY_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';  // Worker 認證 Token

/**
 * Phase 7.4 — Worker 健康度追蹤
 * Worker 連續失敗 N 次後,暫時關閉 5 分鐘,避免每次都先試它再 fallback
 */
const WORKER_FAIL_THRESHOLD = 5;       // ⚠️ 5次（原3次太敏感，燈號掃描衝爆時會波及K線）
const WORKER_COOLDOWN_MS    = 2 * 60 * 1000;  // ⚠️ 2分鐘（原5分鐘，K線等不起）
let   _workerFailCount = 0;
let   _workerDisabledUntil = 0;        // timestamp,< now 表示啟用

function _isWorkerDisabled() {
  return Date.now() < _workerDisabledUntil;
}

/**
 * 查詢 Worker 是否在冷卻期（連續失敗後暫停 5 分鐘）
 * 供 signal-scan.js 在掃描前判斷要不要跳過
 * @returns {boolean}
 */
export function isWorkerCooling() {
  return Date.now() < _workerDisabledUntil;
}

/**
 * 查詢 Worker 冷卻結束的剩餘秒數（給 UI 提示用）
 * @returns {number} 秒數，0 表示未在冷卻
 */
export function workerCooldownRemainSec() {
  const remain = _workerDisabledUntil - Date.now();
  return remain > 0 ? Math.ceil(remain / 1000) : 0;
}

function _onWorkerSuccess() {
  _workerFailCount = 0;
}

function _onWorkerFail() {
  _workerFailCount++;
  if (_workerFailCount >= WORKER_FAIL_THRESHOLD) {
    _workerDisabledUntil = Date.now() + WORKER_COOLDOWN_MS;
    _workerFailCount = 0;
    console.warn(`[api] Worker 連續失敗 ${WORKER_FAIL_THRESHOLD} 次,暫停 ${WORKER_COOLDOWN_MS / 60000} 分鐘,改走公開 proxy`);
  }
}

/**
 * 公開 proxy fallback 列表（2026 仍存活的，依優先序）
 * 注意：公開 proxy 不穩定，會掛掉或限速，僅作 fallback
 * 2026-05-18 確認:
 *   ✅ codetabs   — 存活但限流時回 200 + "Edge: Too Many Requests"(已有偵測)
 *   ✅ allorigins — 存活,回 raw text
 *   ❌ corsproxy.io — 回 404 Not Found(格式改變或停服)
 */
const PROXY_LIST = [
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  // corsproxy.io 已掛,暫時移除
  // url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];
let _proxyIdx = 0;

// ─────────────────────────────────────────────
// K 線 Proxy 模式（可在設定頁切換）
//   'auto'       → Worker 優先,失敗 fallback 公開 proxy（預設）
//   'worker'     → 只用 Worker,502 直接報錯不 fallback
//   'public'     → 跳過 Worker,只用公開 proxy（Worker 壞時用）
//   'direct'     → 直連 Yahoo（localhost 開發環境 / 無 CORS 限制時用）
// ─────────────────────────────────────────────
export function getKlineProxyMode() {
  return localStorage.getItem('klineProxyMode') ?? 'auto';
}
export function setKlineProxyMode(mode) {
  localStorage.setItem('klineProxyMode', mode);
}

// 完整的 proxy 列表（依 klineProxyMode 決定組合）
function _buildProxyList() {
  const mode = getKlineProxyMode();
  if (mode === 'direct') return [];           // 直連,不用任何 proxy
  if (mode === 'public') return PROXY_LIST;   // 跳過 Worker,只用公開 proxy
  if (mode === 'worker') {                   // 只用 Worker,不 fallback
    if (SELF_PROXY) return [url => `${SELF_PROXY}${encodeURIComponent(url)}`];
    return PROXY_LIST;                        // Worker 未設定時降級公開 proxy
  }
  // 'auto'（預設）：Worker 優先,失敗才 fallback
  const list = [];
  if (SELF_PROXY && !_isWorkerDisabled()) {
    list.push(url => `${SELF_PROXY}${encodeURIComponent(url)}`);
  }
  return list.concat(PROXY_LIST);
}

/**
 * 判斷 URL 是否支援 CORS（可直接 fetch，不需要 proxy）
 * 經測試 2026 年的狀態：
 *   ✅ FinMind API（api.finmindtrade.com）
 *   ✅ TWSE OpenData（opendata.twse.com.tw）
 *   ✅ TPEx OpenAPI（www.tpex.org.tw）
 *   ❌ Yahoo Finance（query1/query2.finance.yahoo.com）
 *   ❌ MOPS（mops.twse.com.tw）
 */
function _supportsCORS(url) {
  return /^https:\/\/(?:api\.finmindtrade\.com|opendata\.twse\.com\.tw|www\.tpex\.org\.tw)\//.test(url);
}

/**
 * 智慧 fetch:
 *   - 支援 CORS 的 URL → 直接 fetch（快、穩、無限額）
 *   - 不支援 CORS 的 URL → 直接走 proxy（不浪費時間試直連）
 *   - fastFail=true → 只試 Worker 一次就放棄,避免批次操作把 Worker 額度燒光
 */
// ─────────────────────────────────────────────
// Proxy fetch（含節流、Worker 健康管理、fastFail）
// ─────────────────────────────────────────────
const PROXY_MAX_PER_SEC    = 2;  // 降低：避免 allorigins 429
const PROXY_MAX_CONCURRENT = 2;  // 降低：同時最多 2 個 proxy 請求

const _proxyWindow = [];
let   _proxyInFlight = 0;
const _proxyQueue = [];

function _proxyAcquire() {
  return new Promise(resolve => {
    _proxyQueue.push(resolve);
    _proxyDrain();
  });
}
function _proxyRelease() {
  _proxyInFlight = Math.max(0, _proxyInFlight - 1);
  _proxyDrain();
}
function _proxyDrain() {
  const now = Date.now();
  while (_proxyWindow.length && _proxyWindow[0] < now - 1000) _proxyWindow.shift();
  while (_proxyQueue.length) {
    if (_proxyInFlight >= PROXY_MAX_CONCURRENT) break;
    if (_proxyWindow.length >= PROXY_MAX_PER_SEC) {
      setTimeout(_proxyDrain, Math.max(10, 1000 - (now - _proxyWindow[0]))); break;
    }
    const resolve = _proxyQueue.shift();
    _proxyWindow.push(now);
    _proxyInFlight++;
    resolve();
  }
}

async function fetchWithProxy(url, timeoutMs = 8000, { fastFail = false } = {}) {
  // 支援 CORS 的直連
  if (_supportsCORS(url)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const text = await res.text();
        if (!_looksLikeRateLimit(text)) return text;
      }
    } catch (_) {}
  }

  // direct 模式：跳過所有 proxy，直接打 Yahoo（localhost 開發環境用）
  if (getKlineProxyMode() === 'direct') {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      throw new Error(`直連失敗（direct 模式）: ${e.message}`);
    }
  }

  await _proxyAcquire();
  try {
    const proxies = _buildProxyList();
    const maxAttempts = fastFail ? 1 : proxies.length;
    for (let i = 0; i < maxAttempts; i++) {
      const proxyUrl = proxies[i](url);
      const isWorker = SELF_PROXY && proxyUrl.startsWith(SELF_PROXY);
      try {
        // Worker 請求帶 Token，防止白嫖
        const fetchOpts = { signal: AbortSignal.timeout(timeoutMs) };
        if (isWorker && PROXY_TOKEN) {
          fetchOpts.headers = { 'X-Proxy-Token': PROXY_TOKEN };
        }
        const res = await fetch(proxyUrl, fetchOpts);
        if (res.status === 404) {
          const text = await res.text();
          if (isWorker) _onWorkerSuccess();
          return text;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (_looksLikeRateLimit(text)) {
          console.warn(`[api] proxy[${i}] 限流:`, text.slice(0, 40));
          throw new Error(`proxy[${i}] 限流`);
        }
        if (isWorker) _onWorkerSuccess();
        return text;
      } catch (e) {
        if (isWorker) {
          // ★ 只有真正的 Worker 故障才計入失敗（timeout / network error）
          // HTTP 502/503/504 = MIS 或 Yahoo 上游回錯，Worker 本身正常
          // 限流 = Yahoo 打爆，與 Worker 無關
          // ← 這兩種情況不應讓 Worker 被停用 2 分鐘，否則 MIS 一抖動就癱整個系統
          const isHttpError = /^HTTP \d+$/.test(e.message);
          const isRateLimit = e.message.includes('限流');
          if (!isHttpError && !isRateLimit) _onWorkerFail();
        }
        console.warn(`[api] proxy[${i}] failed:`, e.message);
      }
    }
    throw new Error(fastFail ? 'proxy 暫時無法使用' : '所有 proxy 都無法連線,請稍後再試');
  } finally {
    _proxyRelease();
  }
}

// fetchScreener 別名（向後相容）
function fetchScreener(url, ms) { return fetchWithProxy(url, ms); }


// Phase 7.4 — 偵測 proxy 回的「假成功」限流文字
// codetabs: "Edge: Too Many Requests"
// allorigins / corsproxy: 通常會回 HTTP 4xx/5xx,但有時也會回 plain text
function _looksLikeRateLimit(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  // 太短(< 20 字)且不是 JSON 開頭 → 可疑
  if (text.length < 80) {
    const t = text.trim();
    // 不以 { 或 [ 開頭(不是 JSON),且包含限流關鍵字
    if (!t.startsWith('{') && !t.startsWith('[')) {
      if (/Too Many Requests|rate.?limit|429|throttle|Edge:|quota/i.test(t)) {
        return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Yahoo Finance：即時報價
// ─────────────────────────────────────────────
export async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
              `?interval=1d&range=1d&includePrePost=false`;
  const text   = await fetchWithProxy(url);
  const data   = JSON.parse(text);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`無法取得 ${symbol} 的報價`);
  const meta = result.meta;
  return {
    name:     meta.longName || meta.shortName || symbol,
    price:    meta.regularMarketPrice,
    prev:     meta.chartPreviousClose ?? meta.previousClose,
    open:     meta.regularMarketOpen     ?? null,
    high:     meta.regularMarketDayHigh  ?? null,
    low:      meta.regularMarketDayLow   ?? null,
    volume:   meta.regularMarketVolume   ?? null,
    currency: meta.currency ?? 'TWD',
  };
}

// ─────────────────────────────────────────────
// Yahoo Finance：歷史 OHLCV
// ─────────────────────────────────────────────
const PERIOD_MAP = {
  '5d':  { interval: '1d',  range: '5d'  },
  '1mo': { interval: '1d',  range: '1mo' },
  '3mo': { interval: '1d',  range: '3mo' },
  '6mo': { interval: '1d',  range: '6mo' },
  '1y':  { interval: '1d',  range: '1y'  },
  '2y':  { interval: '1wk', range: '2y'  },
};

// Worker KV 只存 1y，短期 period 向 1y 合併後回傳完整資料。
// fetchHistory 解析完後必須截斷到 period 對應的天數，
// 否則 3mo cache 存進 IndexedDB 的會是 250 根 1y 資料，圖表卡在 1y。
// ⚠️ 踩雷備忘（永久，2026-05-28）：
//   worker.js _yahooKvKey 把 1mo/3mo/6mo 全部 map 到 1y KV key，
//   KV HIT 時回傳 1y 完整 JSON，fetchHistory 解出 ~250 根，
//   但 fetchHistoryCached 的 IndexedDB key 是 symbol_3mo → 存了 250 根進去，
//   之後 3mo 從 cache 拿到 250 根 → 圖表顯示 1y 範圍，無法切換。
//   修法：fetchHistory 解析後根據 period 截尾，確保回傳根數符合 period。
const _PERIOD_DAYS = {
  '5d':   5,
  '1mo':  23,
  '3mo':  66,
  '6mo':  132,
  '1y':   252,
  '2y':   520,
};

function _trimCandlesToPeriod(candles, period) {
  const maxDays = _PERIOD_DAYS[period];
  if (!maxDays || candles.length <= maxDays) return candles;
  // 取最後 maxDays 根（最新資料），多出的頭部截掉
  return candles.slice(-maxDays);
}

export async function fetchHistory(symbol, period) {
  const { interval, range } = PERIOD_MAP[period] ?? PERIOD_MAP['1mo'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
              `?interval=${interval}&range=${range}&includePrePost=false`;
  // ⚠️ Worker 冷卻時直接 fallback 公開 proxy，不主動等待（等待會卡死整批）
  // Worker 冷卻中時 _buildProxyList() 會自動跳過 Worker，直接用公開 proxy
  const text   = await fetchWithProxy(url);

  // 防呆：proxy 可能回非 JSON（限流訊息、HTML 錯誤頁等）
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 把前 60 字當錯誤訊息丟出，方便 resolveYahooSymbol 判斷
    const preview = (text ?? '').slice(0, 60);
    throw new Error(`proxy 回應非 JSON: ${preview}`);
  }

  // Yahoo 明確說找不到（用 chart.error.code 判斷）
  const errCode = data?.chart?.error?.code;
  if (errCode === 'Not Found') {
    throw new Error(`Not Found: ${symbol} 可能已下市或代碼錯誤`);
  }

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`無法取得 ${symbol} 的歷史資料`);

  const timestamps = result.timestamp ?? [];
  const ohlcv      = result.indicators.quote[0];
  const candles    = [];
  for (let i = 0; i < timestamps.length; i++) {
    // open 必要（沒開盤代表沒交易日）；close 如果 null 表示Yahoo 還未結算（凌晨常見）
    if (!ohlcv.open[i]) continue;
    let close = ohlcv.close[i];
    const high = ohlcv.high[i];
    const low  = ohlcv.low[i];
    // close 為 null（Yahoo 盤後尚未結算）→ 用 (high+low)/2 估算，避免整根被丟掉
    if (close == null) {
      if (high != null && low != null) {
        close = (high + low) / 2;
      } else {
        continue; // 高低都沒有，無法估算才跳過
      }
    }
    candles.push({
      time:   timestamps[i],
      open:   +ohlcv.open[i].toFixed(2),
      high:   +(high ?? close).toFixed(2),
      low:    +(low  ?? close).toFixed(2),
      close:  +close.toFixed(2),
      volume:  ohlcv.volume[i] ?? 0,
    });
  }
  candles.sort((a, b) => a.time - b.time);
  // ★ KV HIT 時 Worker 回傳 1y 完整 JSON（1mo/3mo/6mo 全 map 到 1y key），
  //   截斷到 period 對應天數，避免短期 period 存進 IndexedDB 250 根。
  return _trimCandlesToPeriod(candles, period);
}

// ─────────────────────────────────────────────
// Phase 7.4 — fetchHistory 的快取版本
// ─────────────────────────────────────────────
// 規則:
//   1. 先讀 IndexedDB 的 kline_cache
//   2. 若 cache 還在有效期 → 直接回傳(免打 Yahoo)
//   3. 若 cache 過期/不存在 → 打 fetchHistory + 寫回 cache
//   4. opts.force = true → 跳過 cache,強制重抓(給「⟳ 刷新」按鈕用)
//
// 失效時間:
//   - 盤後抓(>= 13:35 TWT 或 週末)→ 明天 09:00 TWT
//   - 盤中抓(09:00-13:35 TWT 平日)→ 10 分鐘後
// ─────────────────────────────────────────────
export async function fetchHistoryCached(symbol, period, opts = {}) {
  if (!symbol || !period) {
    throw new Error('fetchHistoryCached:symbol / period 不可為空');
  }

  // ── staleCandles：STALE/過期快取暫存，API 失敗時 fallback 用 ──
  // ⚠️ 踩雷備忘（永久，2026-05-26）：
  //   盤中時 validUntil >= todayEndTs → 昨晚盤後快取 → STALE 重打 API。
  //   Worker 502（Yahoo 封鎖 Cloudflare IP）時 API 失敗 → throw → 健康度全 `-`。
  //   修法：STALE 快取存入 staleCandles，API 失敗時 fallback 回傳完整 1y candles。
  //   健康度用缺今天這根的完整 K 線算，誤差可接受，總比全空好。
  let staleCandles = null;

  // 1. 嘗試讀快取
  if (!opts.force) {
    try {
      const cached = await getKlineCache(symbol, period);
      // ⚠️ 踩雷備忘（2026-06-02）：
      //   快取命中時必須檢查根數是否足夠當前 period。
      //   否則 1mo 載入存了 22 根，切到 3mo/6mo/1y 時快取 hit 但只有 22 根 → 圖表異常。
      //   修法：快取根數 < period 最低需求的 60%，視為不足，重打 API。
      const _minRequired = Math.floor((_PERIOD_DAYS[period] ?? 0) * 0.6);
      if (cached && Array.isArray(cached.candles) && cached.candles.length >= Math.max(2, _minRequired)) {
        const now = Date.now();
        const isTradingNow = _isCurrentlyTrading();

        if (isTradingNow) {
          const todayEndTs = _todayTradingEndTs();
          if (cached.validUntil >= todayEndTs) {
            // validUntil 超過今天收盤 → 昨晚盤後設的 → STALE
            // allowStale=true（如 fallback 1y 截斷）→ 直接回傳，不重打 API
            if (opts.allowStale) return cached.candles;
            console.log(`[api] kline_cache STALE(盤後快取 in 盤中) → 重抓 ${symbol}_${period}`);
            staleCandles = cached.candles; // ★ 保留，API 失敗時 fallback
            // fall through → 打 API
          } else if (cached.validUntil > now) {
            return cached.candles;
          }
        } else {
          // 盤後/假日/凌晨：先判斷 validUntil
          if (cached.validUntil > now) {
            // ⚠️ ^ 開頭指數（^DJI, ^GSPC 等）跳過台灣交易日檢查：
            //   _lastTradingDayTs() 只懂台灣交易日，美股時區不同會永遠誤判「缺最近交易日」→ 無限重抓
            const isIndexSymbol = symbol.startsWith('^');
            const lastCandleTime = cached.candles[cached.candles.length - 1].time * 1000;
            const lastTradingDay = isIndexSymbol ? 0 : _lastTradingDayTs();
            if (lastTradingDay > 0 && lastCandleTime < lastTradingDay) {
              console.log(`[api] kline_cache 資料缺最近交易日 → 重抓 ${symbol}_${period}`,
                new Date(lastCandleTime).toLocaleDateString('zh-TW'),
                '應有:', new Date(lastTradingDay).toLocaleDateString('zh-TW'));
              staleCandles = cached.candles; // ★ 保留，API 失敗時 fallback
              // fall through → 打 API
            } else {
              return cached.candles;
            }
          } else {
            // validUntil 已過期，有舊資料也保留備用
            if (cached.candles?.length > 0) staleCandles = cached.candles;
          }
        }
      }
    } catch (e) {
      console.warn('[api] kline_cache 讀取失敗,改抓 API:', e?.message);
    }
  }

  // 2. 走 API
  try {
    const candles = await fetchHistory(symbol, period);

    // ⚠️ 踩雷備忘（2026-06-02）：
    //   Yahoo 對部分個股的短 period（3mo/6mo）只回 22 根左右（受限於資料授權或股票流動性）。
    //   修法：根數不足期望的 60% 時，fallback 改拿 1y（走快取優先），再截斷成目標 period。
    //   在 fetchHistoryCached 層做而非 fetchHistory，確保 fallback 走 IndexedDB/R2 快取，不重打 Yahoo。
    const minRequired = Math.floor((_PERIOD_DAYS[period] ?? 0) * 0.6);
    if (period !== '1y' && period !== '2y' && minRequired > 0 && candles.length < minRequired) {
      console.log(`[api] ${symbol} ${period} 根數不足(${candles.length}<${minRequired})，走 1y 快取截斷`);
      try {
        const candles1y = await fetchHistoryCached(symbol, '1y', { allowStale: true });
        if (candles1y.length >= minRequired) {
          const trimmed = _trimCandlesToPeriod(candles1y, period);
          // 寫回正確根數的快取
          const validUntil = _computeCacheValidUntil();
          setKlineCache(symbol, period, trimmed, validUntil).catch(() => {});
          return trimmed;
        }
      } catch (e) {
        console.warn(`[api] ${symbol} 1y fallback 失敗:`, e.message);
      }
    }

    // 3. 寫回快取(fire-and-forget,失敗不影響本次回傳)
    if (candles.length > 0) {
      const validUntil = _computeCacheValidUntil();
      setKlineCache(symbol, period, candles, validUntil).catch(e =>
        console.warn('[api] kline_cache 寫入失敗:', e?.message)
      );
    }

    return candles;
  } catch (apiErr) {
    // ★ API 全死 → fallback 到 STALE 快取（完整 1y K線，缺今天這根）
    if (staleCandles) {
      console.warn(`[api] fetchHistory 失敗，STALE fallback ${symbol}_${period}（${staleCandles.length} 根）`);
      return staleCandles;
    }
    throw apiErr; // 真的沒有任何快取，才往上丟
  }
}

// 判斷現在是否在盤中（台灣時間 週一到週五 09:00–13:35）
function _isCurrentlyTrading() {
  const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const day  = tw.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 13 * 60 + 35;
}

// 計算「最近交易日」的 09:00 TWT timestamp
// 用來檢查快取資料是否已包含最近交易日的 K 線
// 規則：
//   - 現在 >= 盤後（13:36+，平日）→ 最近交易日 = 今天
//   - 現在 < 09:00（平日凌晨）→ 最近交易日 = 昨天（或上週五）
//   - 週末 → 最近交易日 = 上週五
function _lastTradingDayTs() {
  const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const day  = tw.getUTCDay();
  const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();

  const target = new Date(tw);
  target.setUTCHours(9, 0, 0, 0); // 設為當天 09:00

  if (day === 0) {
    // 週日 → 上週五
    target.setUTCDate(target.getUTCDate() - 2);
  } else if (day === 6) {
    // 週六 → 上週五
    target.setUTCDate(target.getUTCDate() - 1);
  } else if (mins < 9 * 60) {
    // 平日開盤前（00:00-08:59）→ 昨天（若昨天是週一則可能是週五）
    target.setUTCDate(target.getUTCDate() - 1);
    // 若昨天是週日（不可能，但防禦）
    if (target.getUTCDay() === 0) target.setUTCDate(target.getUTCDate() - 2);
    if (target.getUTCDay() === 6) target.setUTCDate(target.getUTCDate() - 1);
  }
  // 盤中或盤後：最近交易日 = 今天，target 已是今天 09:00

  return target.getTime() - 8 * 60 * 60 * 1000; // 轉回 UTC timestamp
}

// 計算今天 13:35 TWT 的 UTC timestamp（用來判斷快取是否昨晚設的）
function _todayTradingEndTs() {
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  // 取今天的日期（TWT），設成 13:35
  const end = new Date(tw);
  end.setUTCHours(13, 35, 0, 0);
  // 轉回 UTC timestamp（tw 是 UTC+8，所以要減 8 小時）
  return end.getTime() - 8 * 60 * 60 * 1000;
}

// 計算快取失效時間
// 規則:
//   - 平日盤中(09:00-13:35 TWT)→ 現在 + 10 分鐘
//   - 開盤前(00:00-08:59 TWT)→ 今天 09:00 TWT
//   - 盤後 / 收盤後 / 假日(13:36-23:59 TWT)→ 明天 09:00 TWT
function _computeCacheValidUntil() {
  const now = new Date();
  // 台灣時間 UTC+8
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day  = tw.getUTCDay();      // 0=日 6=六
  const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();

  // 平日盤中 09:00-13:35 → 10 分鐘後
  const isTradingHours = (day >= 1 && day <= 5) && mins >= 9 * 60 && mins <= 13 * 60 + 35;
  if (isTradingHours) {
    return Date.now() + 10 * 60 * 1000;
  }

  // ⚠️ 修正說明：
  // 舊版：盤後設到「明天09:00」
  // 問題：5/20盤後存的快取（最新K可能只到5/19），validUntil設到5/21 09:00
  //       5/21凌晨打開app，validUntil還沒到期，吃到有缺的舊快取
  // 修法：
  //   - 盤後（13:36-23:59）→ 今天 23:59（當天結束就過期，隔天必定重抓）
  //   - 開盤前（00:00-08:59）→ 今天 09:00（開盤時重抓）
  //   - 週末 → 下週一 09:00

  const target = new Date(tw);

  if (day === 0 || day === 6) {
    // 週末 → 下週一 09:00
    const daysToMon = day === 6 ? 2 : 1;
    target.setUTCDate(target.getUTCDate() + daysToMon);
    target.setUTCHours(9, 0, 0, 0);
  } else if (mins < 9 * 60) {
    // 平日開盤前（00:00-08:59）→ 今天 09:00
    target.setUTCHours(9, 0, 0, 0);
  } else {
    // 平日盤後（13:36-23:59）→ 今天 23:59（當天就過期）
    target.setUTCHours(23, 59, 0, 0);
  }

  // target 是「TWT 物件」,getTime() 會被當 UTC 算,所以要減 8 小時轉回 UTC timestamp
  return target.getTime() - 8 * 60 * 60 * 1000;
}

// ─────────────────────────────────────────────
// 當日分時（給市場總覽迷你 K 用）
// interval=1m, range=1d；Yahoo 只保留近 7 天
// ─────────────────────────────────────────────
export async function fetchIntraday(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
              `?interval=1m&range=1d&includePrePost=false`;
  const text = await fetchWithProxy(url);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('proxy 回應非 JSON'); }

  const errCode = data?.chart?.error?.code;
  if (errCode === 'Not Found') throw new Error(`Not Found: ${symbol}`);

  const result = data?.chart?.result?.[0];
  if (!result) return { points: [], prevClose: null };
  const meta       = result.meta ?? {};
  const prevClose  = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const timestamps = result.timestamp ?? [];
  const ohlcv      = result.indicators?.quote?.[0] ?? {};
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = ohlcv.close?.[i];
    if (c == null) continue;
    // time 加 8 小時轉成台灣時間顯示（LightweightCharts 用 UTC 渲染）
    points.push({ time: timestamps[i], value: +c.toFixed(2) });
  }
  return { points, prevClose };
}

// ─────────────────────────────────────────────
// 基本面：v8 meta 基礎版（免費，隨時可用）
// ─────────────────────────────────────────────
async function _fetchFundamentalsBasic(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
              `?interval=1d&range=1d&includePrePost=false`;
  const text   = await fetchWithProxy(url);
  const data   = JSON.parse(text);
  const meta   = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('no meta');

  return {
    _source:          'basic',
    pe:               meta.trailingPE             ?? null,
    forwardPE:        null,
    eps:              null,
    pbRatio:          null,
    dividendYield:    meta.dividendYield           ?? null,
    dividendRate:     meta.trailingAnnualDividendRate ?? null,
    marketCap:        meta.marketCap               ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh        ?? null,
    fiftyTwoWeekLow:  meta.fiftyTwoWeekLow         ?? null,
    price:            meta.regularMarketPrice         ?? null,
    revenueGrowth:    null,
    earningsGrowth:   null,
    profitMargin:     null,
    sector:           null,
    industry:         null,
    website:          null,
    longBusinessSummary: null,
  };
}

// ─────────────────────────────────────────────
// 基本面：FinMind 完整版（需 Token）
// ─────────────────────────────────────────────

function _nYearsAgo(n = 2) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

function _oneYearAgo() { return _nYearsAgo(1); }

/** 總覽用：TaiwanStockPER → PE / PB / 殖利率 最新值 */
async function _fetchFinMindPER(code, token) {
  const url = `https://api.finmindtrade.com/api/v4/data` +
              `?dataset=TaiwanStockPER&data_id=${code}` +
              `&start_date=${_nYearsAgo(2)}&token=${token}`;
  const text = await fetchWithProxy(url, 12000);
  const rows = (JSON.parse(text)?.data ?? []);
  if (!rows.length) return {};
  const latest = rows[rows.length - 1];
  return {
    pe:           parseFloat(latest.PER)            || null,
    pbRatio:      parseFloat(latest.PBR)            || null,
    dividendYield: latest.DividendYield != null
                    ? parseFloat(latest.DividendYield) / 100
                    : null,
  };
}

/** 財報用：TaiwanStockFinancialStatements → EPS / 三率（季度序列） */
async function _fetchFinMindStatements(code, token) {
  const url = `https://api.finmindtrade.com/api/v4/data` +
              `?dataset=TaiwanStockFinancialStatements&data_id=${code}` +
              `&start_date=${_nYearsAgo(2)}&token=${token}`;
  const text = await fetchWithProxy(url, 12000);
  const rows = (JSON.parse(text)?.data ?? []);
  return rows; // 原始列，由呼叫方解析
}

/** 月營收：TaiwanStockMonthRevenue */
async function _fetchFinMindRevenue(code, token) {
  const url = `https://api.finmindtrade.com/api/v4/data` +
              `?dataset=TaiwanStockMonthRevenue&data_id=${code}` +
              `&start_date=${_nYearsAgo(2)}&token=${token}`;
  const text = await fetchWithProxy(url, 12000);
  const rows = (JSON.parse(text)?.data ?? []);
  // 回傳降冪排列（最新在前）
  return rows.slice().reverse();
}

/** 從 statements rows 解析 EPS 季度序列 */
function _parseEPSSeries(rows) {
  const byQuarter = {};
  for (const r of rows) {
    if (r.type !== 'EPS') continue;
    const key = `${r.date}`; // yyyy-MM-dd
    byQuarter[key] = parseFloat(r.value);
  }
  // 轉成陣列，降冪
  return Object.entries(byQuarter)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, eps]) => ({ date, eps }));
}

/**
 * 從 statements rows 解析三率季度序列
 *
 * ⚠️⚠️⚠️ FinMind TaiwanStockFinancialStatements 真實 type 對照（2026-05-21 實測確認）
 *   Revenue                            = 營業收入(分母)
 *   GrossProfit                        = 營業毛利 → 算毛利率
 *   OperatingIncome                    = 營業利益 → 算營業利益率
 *   IncomeAfterTaxes                   = 本期淨利 → 算淨利率 ★ 真正的稅後淨利
 *   PreTaxIncome                       = 稅前淨利
 *   EquityAttributableToOwnersOfParent = 歸屬母公司淨利
 *
 * 永久踩雷:
 *   - FinMind 沒有 `NetIncome` 這個 type(舊版誤寫,靜默失敗,淨利率永遠 null)
 *   - 正確名稱是 `IncomeAfterTaxes`
 *   - FinMind 也沒有 `GrossProfitMargin` 等「率」欄位,只回原始金額
 *   - 所有「率」必須用 (金額 / Revenue) 計算
 */
function _parseMarginSeries(rows) {
  // 嘗試直接有 margin 欄位(FinMind 實際沒回,保留是為了相容外部其他資料源)
  const MARGIN_TYPES = {
    GrossProfitMargin:     'grossMargin',
    OperatingProfitMargin: 'operatingMargin',
    NetProfitMargin:       'netMargin',
    // 備用名稱
    'gross_profit_margin':     'grossMargin',
    'operating_profit_margin': 'operatingMargin',
    'net_profit_margin':       'netMargin',
  };

  // FinMind 實際回的是這些絕對金額欄位
  // ⚠️ IncomeAfterTaxes 才是稅後淨利,不是 NetIncome
  const ABS_TYPES = {
    GrossProfit:      'grossProfit',
    OperatingIncome:  'operatingIncome',
    IncomeAfterTaxes: 'netIncome',     // ★ 本期淨利(稅後),取代錯誤的 NetIncome
    Revenue:          'revenue',
  };

  const byDate = {};

  for (const r of rows) {
    const date = r.date;
    if (!byDate[date]) byDate[date] = { date };

    if (MARGIN_TYPES[r.type]) {
      byDate[date][MARGIN_TYPES[r.type]] = parseFloat(r.value);
    }
    if (ABS_TYPES[r.type]) {
      byDate[date][ABS_TYPES[r.type]] = parseFloat(r.value);
    }
  }

  // 若無直接 margin，從絕對值計算
  for (const q of Object.values(byDate)) {
    if (q.revenue && q.revenue !== 0) {
      if (q.grossMargin == null && q.grossProfit != null)
        q.grossMargin = (q.grossProfit / q.revenue) * 100;
      if (q.operatingMargin == null && q.operatingIncome != null)
        q.operatingMargin = (q.operatingIncome / q.revenue) * 100;
      if (q.netMargin == null && q.netIncome != null)
        q.netMargin = (q.netIncome / q.revenue) * 100;
    }
  }

  return Object.values(byDate)
    .filter(q => q.grossMargin != null || q.operatingMargin != null || q.netMargin != null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 股利政策：TaiwanStockDividend → 現金股利 */
async function _fetchFinMindDividend(code, token) {
  const url = `https://api.finmindtrade.com/api/v4/data` +
              `?dataset=TaiwanStockDividend&data_id=${code}` +
              `&start_date=${_nYearsAgo(3)}&token=${token}`;
  const text = await fetchWithProxy(url, 12000);
  const rows = (JSON.parse(text)?.data ?? []);
  if (!rows.length) return { cashDividend: null };
  // 取最新一筆
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const latest = rows[0];
  // CashEarningsDistribution = 盈餘分配現金股利
  // CashStatutoryReserveTransfer = 公積金轉現金
  const v1 = parseFloat(latest.CashEarningsDistribution ?? 0);
  const v2 = parseFloat(latest.CashStatutoryReserveTransfer ?? 0);
  const cashDividend = (isNaN(v1) ? 0 : v1) + (isNaN(v2) ? 0 : v2);
  return { cashDividend: cashDividend > 0 ? cashDividend : null };
}

async function _fetchFundamentalsFinMind(code, token) {
  // 同時打 PER + Statements + Dividend，Yahoo basic 補市值/52週
  const [perData, stmtRows, divData, basicData] = await Promise.all([
    _fetchFinMindPER(code, token).catch(() => ({})),
    _fetchFinMindStatements(code, token).catch(() => []),
    _fetchFinMindDividend(code, token).catch(() => ({ cashDividend: null })),
    _fetchFundamentalsBasic(`${code}.TW`).catch(() => null),
  ]);

  if (!stmtRows.length && !Object.keys(perData).length)
    throw new Error('FinMind no data');

  const getVal = (type) => {
    const r = stmtRows.filter(x => x.type === type).pop();
    return r ? parseFloat(r.value) : null;
  };

  // 成長率：比較最新季與4季前
  const calcGrowth = (type) => {
    const series = stmtRows.filter(x => x.type === type).map(x => parseFloat(x.value));
    if (series.length < 5) return null;
    const cur = series[series.length - 1];
    const prev = series[series.length - 5];
    if (!prev || Math.abs(prev) < 0.001) return null;
    return (cur - prev) / Math.abs(prev);
  };

  // 淨利率（最新季）
  const calcNetMargin = () => {
    const series = _parseMarginSeries(stmtRows);
    return series.length ? (series[0].netMargin ?? null) : null;
  };

  // 殖利率：現金股利 / Yahoo 現價（basicData 有 price）
  const cashDiv = divData.cashDividend ?? basicData?.dividendRate ?? null;
  let dividendYield = basicData?.dividendYield ?? perData.dividendYield ?? null;
  if (dividendYield == null && cashDiv && basicData?.price) {
    dividendYield = cashDiv / basicData.price;
  }

  return {
    _source:          'finmind',
    pe:               perData.pe       ?? basicData?.pe      ?? null,
    forwardPE:        null,
    eps:              getVal('EPS'),
    pbRatio:          perData.pbRatio  ?? basicData?.pbRatio ?? null,
    dividendYield,
    dividendRate:     cashDiv,
    marketCap:        basicData?.marketCap        ?? null,
    fiftyTwoWeekHigh: basicData?.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow:  basicData?.fiftyTwoWeekLow  ?? null,
    revenueGrowth:    calcGrowth('Revenue'),
    earningsGrowth:   calcGrowth('EPS'),
    profitMargin:     calcNetMargin() != null ? calcNetMargin() / 100 : null,
    sector:           basicData?.sector   ?? null,
    industry:         basicData?.industry ?? null,
    website:          null,
    longBusinessSummary: null,
    _epsSeries:    _parseEPSSeries(stmtRows),
    _marginSeries: _parseMarginSeries(stmtRows),
  };
}

// ─────────────────────────────────────────────
// 基本面快取（IndexedDB）
// key 格式：
//   fund_{code}     → fetchFundamentals 結果
//   rev_{code}      → fetchFinMindRevenue 結果
//
// TTL 策略：依台灣法規公布截止日 + 2天緩衝判斷，而非固定時間
//   月營收：每月 10 號前公布 → 12 號後才視為「新週期已開始」
//   季財報：5/15、8/14、11/14、3/31 → 各加 2 天
// ─────────────────────────────────────────────
const _NAME_TTL    = 90 * 24 * 60 * 60 * 1000; // 90 天（名稱快取專用）
const _CACHE_STORE = 'fundCache';
const _NAME_STORE  = 'nameCache';
let _cacheDB = null;

/**
 * 計算「最近一個應更新點」的時間戳（ms）
 * 規則：月營收 12 號、季財報各截止日 +2 天
 * 快取的 ts 若早於此時間點 → 視為過期
 */
function _lastUpdatePoint() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const day   = now.getDate();

  // 季報更新點（月/日，均已 +2 天緩衝）
  // [月(0-indexed), 日]
  const quarterPoints = [
    [4-1, 2],   // Q4+年報：3/31 → 4/2
    [5-1, 17],  // Q1：5/15 → 5/17
    [8-1, 16],  // Q2：8/14 → 8/16
    [11-1, 16], // Q3：11/14 → 11/16
  ];

  // 找出今年所有候選時間點（季報 + 每月 12 號）
  const candidates = [];

  // 月營收更新點：每月 12 號
  for (let m = 0; m <= 11; m++) {
    candidates.push(new Date(year, m, 12).getTime());
    candidates.push(new Date(year - 1, m, 12).getTime()); // 去年同期
  }

  // 季報更新點
  for (const [m, d] of quarterPoints) {
    candidates.push(new Date(year, m, d).getTime());
    candidates.push(new Date(year - 1, m, d).getTime()); // 去年同期
  }

  // 找出「所有 <= 今天的更新點」中最大的一個
  const nowTs = Date.now();
  const past  = candidates.filter(t => t <= nowTs);
  return Math.max(...past);
}

async function _openCacheDB() {
  if (_cacheDB) return _cacheDB;
  return new Promise((resolve, reject) => {
    // version 2：新增 nameCache store
    const req = indexedDB.open('stockdash_cache', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // v1 的 fundCache（保留）
      if (!db.objectStoreNames.contains(_CACHE_STORE)) {
        db.createObjectStore(_CACHE_STORE, { keyPath: 'key' });
      }
      // v2 新增：nameCache（一筆存整張名稱表）
      if (!db.objectStoreNames.contains(_NAME_STORE)) {
        db.createObjectStore(_NAME_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { _cacheDB = e.target.result; resolve(_cacheDB); };
    req.onerror   = () => reject(req.error);
  });
}

/** 讀名稱快取，回傳 { [code]: name } 或 null（不存在/過期） */
async function _namesCacheGet() {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_NAME_STORE, 'readonly');
    const store = tx.objectStore(_NAME_STORE);
    const item  = await new Promise((res, rej) => {
      const r = store.get('all');
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    if (!item) return null;
    if (Date.now() - item.ts > _NAME_TTL) return null;  // 過期（90天）
    return { names: item.names, ts: item.ts };
  } catch (e) {
    console.warn('[nameCache] get failed:', e.message);
    return null;
  }
}

/** 寫名稱快取 */
async function _namesCacheSet(names) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_NAME_STORE, 'readwrite');
    const store = tx.objectStore(_NAME_STORE);
    store.put({ key: 'all', names, ts: Date.now() });
  } catch (e) {
    console.warn('[nameCache] set failed:', e.message);
  }
}

async function _cacheGet(key) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readonly');
    const store = tx.objectStore(_CACHE_STORE);
    const item  = await new Promise((res, rej) => {
      const r = store.get(key);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    if (!item) return null;
    // 智慧判斷：快取時間點早於「最近一個應更新點」→ 過期
    // 例如今天 5/15，最近更新點是 5/12（月營收），
    // 若快取是 5/11 存的 → 過期；5/13 存的 → 還有效
    if (item.ts < _lastUpdatePoint()) {
      console.log(`[cache] expired ${key}（快取早於最近更新點，重新抓取）`);
      return null;
    }
    return item.value;
  } catch (e) {
    console.warn('[cache] get failed:', e.message);
    return null;
  }
}

async function _cacheSet(key, value) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(_CACHE_STORE);
    store.put({ key, value, ts: Date.now() });
  } catch (e) {
    console.warn('[cache] set failed:', e.message);
  }
}

/** 給 AI 圓桌預載用 — 只讀快取,沒有不打 API */
export async function getCachedFundamentals(code) {
  return _cacheGet(`fund_${code}`);
}
export async function getCachedChipData(code) {
  return _cacheGet(`chip_${code}`);
}

/** 清除單一個股的快取（手動重新整理時用） */
export async function clearFundCache(code) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(_CACHE_STORE);
    store.delete(`fund_${code}`);
    store.delete(`rev_${code}`);
    console.log(`[cache] cleared fund ${code}`);
  } catch (e) {
    console.warn('[cache] clear failed:', e.message);
  }
}

/** 清除籌碼快取（手動更新籌碼時用） */
export async function clearChipCache(code) {
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(_CACHE_STORE);
    store.delete(`chip_${code}`);
    console.log(`[cache] cleared chip ${code}`);
  } catch (e) {
    console.warn('[cache] clear chip failed:', e.message);
  }
}

// ─────────────────────────────────────────────
// 基本面：FinMind 月營收（獨立 export，供子 Tab 懶載入）
// ─────────────────────────────────────────────
export async function fetchFinMindRevenue(code) {
  const cacheKey = `rev_${code}`;

  // ── Advanced 3: 優先讀 Firestore ──
  try {
    const fsData = await fsGetShared(`stocks/${code}/revenue`);
    if (fsData && Array.isArray(fsData.data) && fsData.data.length > 0) {
      const ageDays = (Date.now() - (fsData.updatedAt ?? 0)) / 86400000;
      if (ageDays < 40) {
        _cacheSet(cacheKey, fsData.data).catch(() => {});
        return fsData.data;
      }
    }
  } catch (e) { /* fallback */ }

  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const token = getFinMindToken();
  if (!token) throw new Error('no token');
  const data = await _fetchFinMindRevenue(code, token);
  await _cacheSet(cacheKey, data);
  return data;
}

// ─────────────────────────────────────────────
// 基本面：自動選擇來源（含快取）
// ─────────────────────────────────────────────
// fetchEarningsDate — 法說/財報日期
// ─────────────────────────────────────────────
// 打 Yahoo Finance quoteSummary?modules=calendarEvents
// 回傳 { earningsDate: 'YYYY-MM-DD' | null, earningsDates: string[] }
//
// ⚠️ 預留引信：
//   - 若 Firestore stocks/{code}/events 有資料（GAS 寫入），優先使用
//   - Yahoo 沒有台股財報日，通常回傳 null → 此時顯示「—」不報錯
//   - GAS 可從 TWSE MOPS 爬財報日寫入 stocks/{code}/events { earningsDate, meetingDate, updatedAt }
// ─────────────────────────────────────────────
export async function fetchEarningsDate(symbol, code) {
  // 1. 先查 Firestore（引信：GAS 補資料後自動生效）
  try {
    const fs = await fsGetShared(`stocks/${code}/events`);
    if (fs && (fs.earningsDate || fs.meetingDate)) {
      return {
        earningsDate: fs.earningsDate ?? null,
        meetingDate:  fs.meetingDate  ?? null,
        source: 'firestore',
      };
    }
  } catch (_) {}

  // 2. fallback：Yahoo quoteSummary calendarEvents
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}` +
                `?modules=calendarEvents`;
    const text = await fetchWithProxy(url, 6000, { fastFail: true });
    const cal  = JSON.parse(text)?.quoteSummary?.result?.[0]?.calendarEvents;
    const ts   = cal?.earnings?.earningsDate?.[0]?.raw ?? null;
    return {
      earningsDate: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
      meetingDate:  null,
      source: 'yahoo',
    };
  } catch (_) {}

  return { earningsDate: null, meetingDate: null, source: 'none' };
}

//
// ⚠️ Phase 2 修正:GAS 寫入格式是 { data: stringified_fund, updatedAt },
//    fsGetShared 會 parse data 為物件 → 必須攤平回傳給 health.js 用
// ─────────────────────────────────────────────
export async function fetchFundamentals(symbol, code) {
  const cacheKey = `fund_${code}`;

  // ── Advanced 3: 優先讀 Firestore ──
  try {
    const fsData = await fsGetShared(`stocks/${code}/fundamentals`);
    if (fsData && fsData.updatedAt) {
      const ageDays = (Date.now() - fsData.updatedAt) / 86400000;
      if (ageDays < 7) {
        // ⚠️ GAS 寫入時是 { data: JSON.stringify(fundObj), updatedAt },
        //    fsGetShared 已自動 parse,fsData.data 是攤平後的 fund 物件
        //    要把 data 攤出來,且把 updatedAt 蓋進 fund 物件
        // ⚠️ _source 一律標為 'finmind':資料本來就是 FinMind 來的,
        //    只是經 GAS 中轉到 Firestore;前端 UI 看 _source==='finmind' 判斷完整版
        const fundObj = fsData.data && typeof fsData.data === 'object'
          ? { ...fsData.data, _source: 'finmind', updatedAt: fsData.updatedAt }
          : fsData;  // 舊資料 fallback:沒有 data 欄位的直接用
        _cacheSet(cacheKey, fundObj).catch(() => {});
        return fundObj;
      }
    }
  } catch (e) { /* fallback */ }

  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const token = getFinMindToken();
  let data = null;

  // 有 FinMind Token 且是台股代號 → 嘗試完整版
  if (token && /^\d{4}/.test(code)) {
    try {
      data = await _fetchFundamentalsFinMind(code, token);
    } catch (e) {
      console.warn('[api] FinMind fundamentals failed, fallback to basic:', e.message);
    }
  }

  // fallback：v8 meta 基礎版
  if (!data) {
    try {
      data = await _fetchFundamentalsBasic(symbol);
    } catch (e) {
      console.warn('[api] fetchFundamentals basic failed:', e.message);
      return null;
    }
  }

  // 存快取（只有成功才存）
  if (data) await _cacheSet(cacheKey, data);
  return data;
}

// ─────────────────────────────────────────────
// Phase 2 — 從 Firestore 純讀 fundamentals
//
// 設計:
//   - 完全不打 FinMind/Yahoo,純讀 Firestore
//   - 失敗回 null,絕不報錯,絕不阻塞
//   - 給 portfolio-ui / market 預載長線健康度用
//   - 不寫快取(避免污染既有 fund_{code} key 的 7 天判斷邏輯)
//
// 回傳:fund 物件(攤平,含 updatedAt) 或 null
// ─────────────────────────────────────────────
export async function fetchFundamentalsFromFirestore(code) {
  if (!/^\d{4}/.test(code)) return null;
  try {
    const fsData = await fsGetShared(`stocks/${code}/fundamentals`);
    if (!fsData) return null;

    let fund = null;
    if (fsData.data && typeof fsData.data === 'object') {
      fund = { ...fsData.data, _source: 'finmind', updatedAt: fsData.updatedAt };
    } else if (fsData.eps !== undefined || fsData._epsSeries) {
      fund = { ...fsData, _source: 'finmind' };
    }
    if (!fund) return null;

    // ── 月營收引信：額外讀 revenue，計算 MoM / YoY ──
    try {
      const revData = await fsGetShared(`stocks/${code}/revenue`);
      if (revData?.data) {
        let revArr = typeof revData.data === 'string'
          ? JSON.parse(revData.data) : revData.data;
        if (Array.isArray(revArr) && revArr.length >= 13) {
          // 已是降冪（新到舊），GAS 寫入時已排序
          const r0 = revArr[0].revenue;   // 最新月
          const r1 = revArr[1].revenue;   // 上個月
          const r12 = revArr[12].revenue; // 去年同月
          fund._revenueGrowthMoM = r1 > 0 ? (r0 - r1)  / r1  : null;
          fund._revenueGrowthYoY = r12 > 0 ? (r0 - r12) / r12 : null;
          fund._revenueSeries = revArr.slice(0, 12); // 最近12個月
        }
      }
    } catch (_) {}

    return fund;
  } catch (e) {
    return null;
  }
}

/**
 * Phase 2 — 批次從 Firestore 讀 fundamentals
 * 並行讀,失敗回 null 不影響其他
 * 回傳:Map<code, fund | null>
 */
export async function fetchFundamentalsBatch(codes) {
  const arr = await Promise.all(
    codes.map(code => fetchFundamentalsFromFirestore(code).then(
      fund => [code, fund],
      _    => [code, null]
    ))
  );
  return new Map(arr);
}

// ─────────────────────────────────────────────
// 健診資料：BalanceSheet / CashFlow / Dividend
//
// 設計：
//   - 優先讀 Firestore（GAS 寫入）→ 存 IndexedDB cache（TTL 7天）
//   - Firestore 無資料 → 直接打 FinMind（需 token）
//   - 回傳三包資料：{ bsMap, cfMap, divRows }
//     bsMap: Map<date, { Liabilities, TotalAssets, CurrentAssets, CurrentLiabilities, Equity }>
//     cfMap: Map<date, { operatingCF }>
//     divRows: [{ date, year, CashEarningsDistribution, CashStatutorySurplus }, ...]
// ─────────────────────────────────────────────
export async function fetchHealthData(code) {
  if (!/^\d{4}/.test(code)) return null;

  const cacheKey = `health_${code}`;
  const cached   = await _cacheGet(cacheKey);
  if (cached) return cached;

  // ── 從 Firestore 讀（GAS 寫入路徑）──
  const [bsRaw, cfRaw, divRaw] = await Promise.all([
    fsGetShared(`stocks/${code}/balance_sheet`).catch(() => null),
    fsGetShared(`stocks/${code}/cash_flow`).catch(() => null),
    fsGetShared(`stocks/${code}/dividend`).catch(() => null),
  ]);

  // ── 解析 BalanceSheet → Map<date, {欄位}> ──
  const bsMap = new Map();
  const bsArr = _parseHealthRaw(bsRaw);
  for (const r of bsArr) {
    if (!bsMap.has(r.date)) bsMap.set(r.date, {});
    bsMap.get(r.date)[r.type] = parseFloat(r.value);
  }

  // ── 解析 CashFlow → Map<date, {operatingCF}> ──
  const cfMap = new Map();
  const cfArr = _parseHealthRaw(cfRaw);
  for (const r of cfArr) {
    if (!cfMap.has(r.date)) cfMap.set(r.date, {});
    const v = parseFloat(r.value);
    // 兩個 type 取較精確的那個（CashFlowsFromOperatingActivities 優先）
    if (r.type === 'CashFlowsFromOperatingActivities') {
      cfMap.get(r.date).operatingCF = v;
    } else if (r.type === 'NetCashInflowFromOperatingActivities' &&
               cfMap.get(r.date).operatingCF == null) {
      cfMap.get(r.date).operatingCF = v;
    }
  }

  // ── 解析 Dividend ──
  let divRows = [];
  if (divRaw) {
    const arr = Array.isArray(divRaw) ? divRaw
      : (divRaw.data ? (typeof divRaw.data === 'string' ? JSON.parse(divRaw.data) : divRaw.data) : []);
    divRows = Array.isArray(arr) ? arr : [];
  }

  // ── Firestore 無資料 → fallback 直打 FinMind ──
  const token = getFinMindToken();
  if (bsMap.size === 0 && token) {
    try {
      const startDate = _nYearsAgo(3);
      const bsFallback = await _fetchFinMindHealthRaw('TaiwanStockBalanceSheet', code, token, startDate);
      for (const r of bsFallback) {
        if (!bsMap.has(r.date)) bsMap.set(r.date, {});
        bsMap.get(r.date)[r.type] = parseFloat(r.value);
      }
    } catch (_) {}
  }
  if (cfMap.size === 0 && token) {
    try {
      const startDate = _nYearsAgo(3);
      const cfFallback = await _fetchFinMindHealthRaw('TaiwanStockCashFlowsStatement', code, token, startDate);
      for (const r of cfFallback) {
        if (!cfMap.has(r.date)) cfMap.set(r.date, {});
        const v = parseFloat(r.value);
        if (r.type === 'CashFlowsFromOperatingActivities') cfMap.get(r.date).operatingCF = v;
        else if (r.type === 'NetCashInflowFromOperatingActivities' && cfMap.get(r.date).operatingCF == null)
          cfMap.get(r.date).operatingCF = v;
      }
    } catch (_) {}
  }
  if (divRows.length === 0 && token) {
    try {
      const startDate = _nYearsAgo(5);
      const text = await fetchWithProxy(
        `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${code}&start_date=${startDate}&token=${token}`,
        12000
      );
      const rows = JSON.parse(text)?.data ?? [];
      divRows = rows.map(r => ({
        date:  r.date,
        year:  r.year,
        CashEarningsDistribution: parseFloat(r.CashEarningsDistribution) || 0,
        CashStatutorySurplus:     parseFloat(r.CashStatutorySurplus)     || 0,
      })).sort((a, b) => b.date.localeCompare(a.date));
    } catch (_) {}
  }

  if (bsMap.size === 0 && cfMap.size === 0 && divRows.length === 0) return null;

  const result = { bsMap, cfMap, divRows };
  await _cacheSet(cacheKey, result).catch(() => {});
  return result;
}

/** 輔助：從 fsGetShared 回傳值中解出 rows 陣列 */
function _parseHealthRaw(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw
    : (raw.data ? (typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data) : raw);
  return Array.isArray(arr) ? arr : [];
}

/** 輔助：打 FinMind 並回傳 rows（給 fetchHealthData fallback 用）*/
async function _fetchFinMindHealthRaw(dataset, code, token, startDate) {
  const BS_KEEP = new Set(['Liabilities','TotalAssets','CurrentAssets','CurrentLiabilities','Equity']);
  const CF_KEEP = new Set(['CashFlowsFromOperatingActivities','NetCashInflowFromOperatingActivities']);
  const keep    = dataset === 'TaiwanStockBalanceSheet' ? BS_KEEP : CF_KEEP;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${code}&start_date=${startDate}&token=${token}`;
  const text = await fetchWithProxy(url, 15000);
  const rows = JSON.parse(text)?.data ?? [];
  return rows.filter(r => keep.has(r.type));
}

// ─────────────────────────────────────────────
// 籌碼：三大法人 + 融資融券
// ─────────────────────────────────────────────
export async function fetchChipData(code) {
  const result = { institutional: null, margin: null };

  // ── Advanced 2: 優先讀 Firestore（Cron 已在 14:45 寫入全市場三大法人）──────
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const fsChips = await fsGetShared(`market/${today}/chips`);
    if (fsChips && fsChips[code]) {
      const c = fsChips[code];
      result.institutional = {
        foreign: c.foreign ?? 0,
        trust:   c.invest  ?? 0,
        dealer:  c.dealer  ?? 0,
        total:   c.total   ?? 0,
      };
      console.log(`[api] 三大法人 Firestore 命中 → ${code}`);
      // 融資融券仍走原本路徑（Cron 尚未收錄）
    }
  } catch (e) {
    console.warn('[api] Firestore 三大法人讀取失敗，fallback:', e.message);
  }

  // ── Fallback: Firestore 無資料時打 TWSE ────────────────────────────────────
  if (!result.institutional) {
  // 三大法人
  try {
    const url  = `https://www.twse.com.tw/fund/T86?response=json&date=&selectType=ALLBUT0999`;
    const text = await fetchWithProxy(url, 10000);
    const data = JSON.parse(text);
    const rows = data?.data ?? [];
    const row  = rows.find(r => r[0] === code);
    if (row) {
      const toNum = s => parseInt(String(s).replace(/,/g, ''), 10) || 0;
      // TWSE T86 欄位順序（實測確認）：
      //   [4]  外資買賣超
      //   [7]  投信買賣超
      //   [10] 自營商買賣超（自行）
      //   [11] 自營商買進（避險）← 這不是 dealer 合計！
      //   [13] 自營商買賣超（避險）
      //   [14] 自營商合計（自行+避險）
      //   [15] 三大法人合計
      // ⚠️ 踩雷：[10] 只是自行部分，[11] 是避險買進數，
      //           必須用 [14] 才是完整自營商，[15] 才是三大合計
      result.institutional = {
        foreign: toNum(row[4]),
        trust:   toNum(row[7]),
        dealer:  toNum(row[14]),   // 自營商合計（自行+避險）
        total:   toNum(row[15]),   // 三大法人合計
      };
    }
  } catch (e) {
    console.warn('[api] institutional failed:', e.message);
  }
  } // end if (!result.institutional)

  // 融資融券
  try {
    const url  = `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&selectType=ALL`;
    const text = await fetchWithProxy(url, 10000);
    const data = JSON.parse(text);
    const rows = data?.data ?? [];
    const row  = rows.find(r => r[0] === code);
    if (row) {
      const toNum = s => parseInt(String(s).replace(/,/g, ''), 10) || 0;
      result.margin = {
        marginBalance: toNum(row[6]),
        shortBalance:  toNum(row[12]),
        marginChange:  toNum(row[5]),
        shortChange:   toNum(row[11]),
      };
    }
  } catch (e) {
    console.warn('[api] margin failed:', e.message);
  }

  return result;
}

// ─────────────────────────────────────────────
// 籌碼歷史：外資近 N 日買賣超（FinMind，含快取）
// 用於 S17 外資連買篩選 + 籌碼 Tab 歷史走勢
// ─────────────────────────────────────────────
export async function fetchForeignBuyDays(code, days = 30) {
  const cacheKey = `chip_${code}`;

  // 快取：走智慧更新點（盤後資料，每個交易日更新）
  // 用 24 小時 TTL 即可（盤後一天一次）
  try {
    const db    = await _openCacheDB();
    const tx    = db.transaction(_CACHE_STORE, 'readonly');
    const store = tx.objectStore(_CACHE_STORE);
    const item  = await new Promise((res, rej) => {
      const r = store.get(cacheKey);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    if (item && item.ts >= _lastUpdatePoint()) {
      return item.value;
    }
  } catch (e) { /* 快取失敗繼續打 API */ }

  const token = getFinMindToken();
  if (!token) throw new Error('no FinMind token');

  // 抓近 60 天資料（確保有足夠交易日）
  const startDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  const url  = `https://api.finmindtrade.com/api/v4/data` +
               `?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${code}` +
               `&start_date=${startDate}&token=${token}`;
  const text = await fetchWithProxy(url, 12000);
  const rows = (JSON.parse(text)?.data ?? [])
    .filter(r => r.name === 'Foreign_Investor')  // FinMind 欄位名稱
    .sort((a, b) => b.date.localeCompare(a.date))  // 降冪（最新在前）
    .slice(0, days);

  const result = rows.map(r => ({
    date: r.date,
    buy:  Math.round(Number(r.buy)  / 1000),  // 股 → 張
    sell: Math.round(Number(r.sell) / 1000),
    net:  Math.round((Number(r.buy) - Number(r.sell)) / 1000),
  }));

  // 存快取
  try { await _cacheSet(cacheKey, result); } catch (e) { /* 忽略 */ }
  return result;
}

// ─────────────────────────────────────────────
// 新聞：依設定切換來源
//
// yahootw     → Yahoo 奇摩股市 RSS（中文）
// googlenews  → Google News RSS（中文，搜尋股票名稱）
// yahoofinance→ Yahoo Finance search API（英文）
// ─────────────────────────────────────────────
export async function fetchNews(symbol, stockName = '') {
  const source = getNewsSource();
  try {
    switch (source) {
      case 'googlenews':   return await _newsGoogleNews(stockName || symbol);
      case 'yahoofinance': return await _newsYahooFinance(symbol);
      default:             return await _newsYahooTW(symbol);
    }
  } catch (e) {
    console.warn('[api] fetchNews failed:', e.message);
    return [];
  }
}

// Yahoo 奇摩股市 RSS
async function _newsYahooTW(symbol) {
  // 去掉 .TW / .TWO 後綴取純代號
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const url  = `https://tw.stock.yahoo.com/rss?s=${code}`;
  const text = await fetchWithProxy(url, 8000);
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'text/xml');
  const items  = doc.querySelectorAll('item');
  return Array.from(items).slice(0, 20).map(item => ({
    title:       item.querySelector('title')?.textContent?.trim() ?? '',
    link:        item.querySelector('link')?.textContent?.trim()  ?? '',
    publisher:   'Yahoo 奇摩',
    publishTime: _rssDateToEpoch(item.querySelector('pubDate')?.textContent),
  })).filter(n => n.title);
}

// Google News RSS
async function _newsGoogleNews(query) {
  const q   = encodeURIComponent(`${query} 股票`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const text = await fetchWithProxy(url, 8000);
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'text/xml');
  const items  = doc.querySelectorAll('item');
  return Array.from(items).slice(0, 20).map(item => ({
    title:       item.querySelector('title')?.textContent?.trim() ?? '',
    link:        item.querySelector('link')?.textContent?.trim()  ?? '',
    publisher:   item.querySelector('source')?.textContent?.trim() ?? 'Google News',
    publishTime: _rssDateToEpoch(item.querySelector('pubDate')?.textContent),
  })).filter(n => n.title);
}

// Yahoo Finance Search API（英文）
async function _newsYahooFinance(symbol) {
  const url  = `https://query1.finance.yahoo.com/v1/finance/search` +
               `?q=${encodeURIComponent(symbol)}&newsCount=20&quotesCount=0`;
  const text = await fetchWithProxy(url);
  const data = JSON.parse(text);
  return (data?.news ?? []).map(n => ({
    title:       n.title,
    link:        n.link,
    publisher:   n.publisher,
    publishTime: n.providerPublishTime,
  }));
}

function _rssDateToEpoch(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : Math.floor(d.getTime() / 1000);
}

// ─────────────────────────────────────────────
// TWSE 公告
// ─────────────────────────────────────────────
export async function fetchAnnouncements(code) {
  try {
    const url  = `https://mops.twse.com.tw/mops/web/ajax_t05st01` +
                 `?encodeURIComponent=1&step=1&firstin=1&off=1` +
                 `&keyword4=&code1=&TYPEK2=&checkbtn=&queryName=co_id` +
                 `&inpuType=co_id&TYPEK=all&isnew=false&co_id=${code}&keyword2=`;
    const text = await fetchWithProxy(url, 10000);
    const parser = new DOMParser();
    const doc    = parser.parseFromString(text, 'text/html');
    const rows   = doc.querySelectorAll('table.hasBorder tr');
    const result = [];
    rows.forEach((row, i) => {
      if (i === 0) return;
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) return;
      const date    = cells[0]?.textContent?.trim();
      const subject = cells[2]?.textContent?.trim();
      const href    = cells[2]?.querySelector('a')?.href ?? '';
      if (date && subject) result.push({ date, subject, url: href });
    });
    return result.slice(0, 20);
  } catch (e) {
    console.warn('[api] fetchAnnouncements failed:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// 盤中即時批次報價（mis.twse.com.tw）
// ─────────────────────────────────────────────
/**
 * fetchMisIntraday(codes)
 * 用 TWSE mis API 一次拉多檔盤中即時報價，Worker 白名單已包含此網域。
 * 盤中輪詢用，取代逐檔打 Yahoo Finance，避免限流。
 *
 * @param {string[]} codes  純代號陣列，如 ['2330', '2317', '6488']
 * @returns {Object}  { [code]: { price, prev, chgPct, volume, name } }
 *
 * mis API 格式：
 *   ex_ch=tse_2330.tw|otc_6488.tw（上市 tse_ / 上櫃 otc_）
 *   回傳欄位：z=現價, y=昨收, u=漲停, w=跌停, v=成交量(股), n=名稱
 *   注意：停牌或尚未開盤時 z='-'，需過濾
 */
export async function fetchMisIntraday(codes) {
  if (!codes || codes.length === 0) return {};

  // ── 內部：打一次 MIS 批次，解析回傳 ──────────────────────────────────────
  async function _fetchBatch(exCh) {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;
    const text = await fetchWithProxy(url, 8000);
    if (!text || text.trim().startsWith('<')) return {};
    let data;
    try { data = JSON.parse(text); } catch (_) { return {}; }
    const out = {};
    for (const item of data?.msgArray ?? []) {
      const code = item.c;
      if (!code) continue;
      const priceRaw = item.z;
      const prevRaw  = item.y;
      const name     = item.n ?? code;
      if (!priceRaw || priceRaw === '-' || priceRaw === '0') continue;
      const price = parseFloat(priceRaw);
      const prev  = parseFloat(prevRaw ?? priceRaw);
      if (isNaN(price) || price <= 0) continue;
      const change = price - prev;
      const chgPct = prev > 0 ? (change / prev) * 100 : 0;
      const volume = Math.round(parseFloat(item.v ?? '0') / 1000);
      // ★ 補解析今日 OHLC（供今日K棒 sparkline 使用）
      const open = parseFloat(item.o) || price;
      const high = parseFloat(item.h) || price;
      const low  = parseFloat(item.l) || price;
      out[code] = { price, prev, chgPct, volume, name, open, high, low };
      // 順帶記錄上櫃（MIS 回傳 ex='o' 表示上櫃）
      if (item.ex === 'o') _otcSet.add(code);
      if (name && name !== code) _nameCache[code] = name;
    }
    return out;
  }

  // ⚠️ 踩雷備忘(永久,2026-05-21 第二輪修):
  //   雙前綴並送會讓 URL 變長(每檔 2 個 ex_ch),BATCH=50 時 100 個 ex_ch,
  //   加上 URL encode 後超過 Worker 的 URL 長度上限 → 502 → 整批全死
  //   修法:
  //   1. BATCH 50 → 20(雙前綴後最多 40 ex_ch,URL 安全範圍)
  //   2. missed 雙前綴拆批送(每批 ≤ 10 檔,即 20 ex_ch)
  //   3. _otcSet 有資料時跳過雙前綴(預判 → 單前綴即可)
  //
  // ⚠️ 絕對不要為了「省 request」把 BATCH 改大,寧可多打幾批也要避免 502
  const BATCH = 20;
  const MISSED_BATCH = 10;  // missed 雙前綴拆批用
  const result = {};

  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);

    try {
      // ── 第一次:依 _otcSet 決定前綴(_otcSet 空時全部 tse_)──────────────
      const exCh1 = batch.map(code =>
        `${_otcSet.has(code) ? 'otc' : 'tse'}_${code}.tw`
      ).join('|');
      const map1 = await _fetchBatch(exCh1).catch(() => ({}));
      Object.assign(result, map1);

      // ── 第二次:第一次沒拿到的 code,雙前綴並送 ────────────────────────
      // ⚠️ 踩雷備忘(永久):
      //   舊版用「反轉前綴」(tse↔otc),會把第一次沒回的上市股
      //   錯誤地用 otc_2330.tw 去打,永遠拿不到 → 必須 tse_ + otc_ 都送
      // ⚠️ 智慧優化:
      //   _otcSet 有 100+ 筆代表 TPEx 已載入完成,代號判斷可信
      //   → 只對「_otcSet 完全沒記錄」的 code 用雙前綴(可能是新股或 missing)
      //   → 對「_otcSet 已記錄為 otc」或「_otcSet 已知為非 otc」的 code 用單前綴
      //
      //   這樣可以把雙前綴的範圍降到極小,大幅減少 URL 長度
      const missed = batch.filter(code => !result[code]);
      if (missed.length > 0) {
        const _otcReady = _otcSet.size >= 100;  // TPEx 載入完成的標誌

        const exChItems = missed.flatMap(code => {
          if (_otcReady) {
            // _otcSet 可信:依判斷送單前綴的「反向」(第一次已試過正向)
            // 若 _otcSet 有此 code,第一次已用 otc_,這次用 tse_
            // 若 _otcSet 沒有,第一次已用 tse_,這次用 otc_
            // (第二次反轉是為了補刷,因為第一次的 prefix 已試過沒回)
            return [`${_otcSet.has(code) ? 'tse' : 'otc'}_${code}.tw`];
          }
          // _otcSet 還沒備齊:用雙前綴雙保險
          return [`tse_${code}.tw`, `otc_${code}.tw`];
        });

        // ── 雙前綴拆批送,避免 URL 過長害 Worker 502 ────────────────────
        for (let j = 0; j < exChItems.length; j += MISSED_BATCH * 2) {
          const sub = exChItems.slice(j, j + MISSED_BATCH * 2);
          const exCh2 = sub.join('|');
          const map2 = await _fetchBatch(exCh2).catch(() => ({}));
          Object.assign(result, map2);
          if (j + MISSED_BATCH * 2 < exChItems.length) {
            await new Promise(r => setTimeout(r, 150));  // 拆批之間短暫間隔
          }
        }
      }
    } catch (e) {
      console.warn('[api] fetchMisIntraday batch failed:', e.message);
    }

    if (i + BATCH < codes.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// 中文名稱 cache（由 fetchTWSEPrices 填充）
// ─────────────────────────────────────────────
const _nameCache = {};   // { '2330': '台積電', ... }

/**
 * 查詢中文股票名稱（需先呼叫過 fetchTWSEPrices）
 * @param {string} code  純代號，如 '2330'
 * @returns {string|null}
 */
export function getChineseName(code) {
  return _nameCache[code] ?? null;
}

export async function preloadNamesFromFirestore() {
  // ── localStorage 快取：24 小時內不重打 Firestore ──────────────────────
  const CACHE_KEY = '__nameCache_v1';
  const TTL_MS    = 24 * 60 * 60 * 1000; // 24 小時
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < TTL_MS && data && typeof data === 'object') {
        let filled = 0;
        for (const [code, name] of Object.entries(data)) {
          if (!_nameCache[code] && name) { _nameCache[code] = name; filled++; }
        }
        // 同步到 window.__nameCache（modal-strategy.js 等模組用）
        if (!window.__nameCache) window.__nameCache = new Map();
        for (const [code, name] of Object.entries(data)) {
          if (!window.__nameCache.has(code) && name) window.__nameCache.set(code, name);
        }
        console.log(`[api] preloadNamesFromFirestore → localStorage 命中 ${filled} 筆`);
        return;
      }
    }
  } catch (_) { /* localStorage 失敗就繼續讀 Firestore */ }

  // ── 快取過期或不存在：讀 Firestore ────────────────────────────────────
  try {
    const meta = await fsGetShared('names/meta');
    if (!meta?.batches) return;
    const batches = Number(meta.batches);
    let filled = 0;
    const freshData = {};
    for (let b = 0; b < batches; b++) {
      const chunk = await fsGetShared(`names/batch${b}`);
      if (!chunk) continue;
      const entries = Array.isArray(chunk) ? chunk : Object.entries(chunk);
      for (const [code, name] of entries) {
        if (name && typeof name === 'string') {
          freshData[code] = name;
          if (!_nameCache[code]) { _nameCache[code] = name; filled++; }
        }
      }
    }
    // 寫回 localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: freshData }));
    } catch (_) { /* 超過 5MB quota 靜默略過 */ }
    // 同步到 window.__nameCache（modal-strategy.js 等模組用）
    if (!window.__nameCache) window.__nameCache = new Map();
    for (const [code, name] of Object.entries(freshData)) {
      if (!window.__nameCache.has(code) && name) window.__nameCache.set(code, name);
    }
    console.log(`[api] preloadNamesFromFirestore → Firestore ${filled} 筆，已快取`);
  } catch (e) {
    console.warn('[api] preloadNamesFromFirestore failed:', e.message);
  }
}



/**
 * 取得所有已知股票代號（從中文名快取）
 * 用途：TWSE/TPEx 全掛時，篩選器的清單來源 fallback
 * @returns {string[]}  e.g. ['2330','2317',...]
 */
export function getAllKnownCodes() {
  return Object.keys(_nameCache).filter(c => /^\d{4,6}$/.test(c));
}

/**
 * 指數/特殊代號靜態對照表
 * ⚠️ 踩雷備忘：^TWII / ^DJI / ^SOX 等指數代號不是台股代號，
 *   不可送去 TWSE opendata 查詢（會 ERR_NAME_NOT_RESOLVED / 404）。
 *   在這裡直接給中文名，ensureChineseName 的三道防線完全跳過。
 * 新增指數時只需在這裡加一行，不需動其他邏輯。
 */
const _INDEX_NAMES = {
  '^TWII':  '加權指數',
  '^DJI':   '道瓊指數',
  '^IXIC':  '那斯達克',
  '^GSPC':  'S&P 500',
  '^SOX':   '費城半導體',
  '^N225':  '日經225',
  '^HSI':   '恆生指數',
  '^FTSE':  '富時100',
  '^VIX':   '恐慌指數',
  'GC=F':   '黃金期貨',
  'CL=F':   '原油期貨',
  'BTC-USD': '比特幣',
};

/**
 * 確保 _nameCache 有該代號的中文名。
 * 若 _nameCache 已有就直接回傳，否則打 TWSE 個股 API 補填。
 * 不拋錯，失敗靜默略過。
 * @param {string} code  純代號，如 '2330'
 * @returns {Promise<string|null>}
 */
export async function ensureChineseName(code) {
  // ── 指數/特殊代號：直接回靜態中文名，不打任何 API ──
  // ⚠️ ^TWII 等代號送 TWSE 會 ERR_NAME_NOT_RESOLVED，務必在此攔截
  if (_INDEX_NAMES[code]) {
    _nameCache[code] = _INDEX_NAMES[code];
    return _INDEX_NAMES[code];
  }

  // ── 非純數字代號（如 ^開頭、已帶.TW suffix）→ 不是台股，不查 TWSE ──
  if (!/^\d{4,6}$/.test(code)) {
    return null;  // 靜默略過，沒有中文名也無妨
  }

  // ── _nameCache 已有就直接回傳（preloadNamesFromFirestore 預載後命中率很高）──
  if (_nameCache[code]) return _nameCache[code];

  // ⚠️ 踩雷備忘：
  //   Firebase names/batch* 是自己的資料庫，優先查，不要先打外部 API
  //   preloadNamesFromFirestore 在 main.js 啟動時已背景執行，
  //   但若 loadStock 比預載更早觸發（race condition），這裡補查一次個股

  // 第一道：Firebase names/batch*（自己的資料，優先）
  // 逐批搜尋，找到就停止（不需要讀全部批次）
  try {
    const meta = await fsGetShared('names/meta');
    if (meta?.batches > 0) {
      for (let b = 0; b < meta.batches; b++) {
        const chunk = await fsGetShared(`names/batch${b}`);
        if (!chunk) continue;
        const entries = Array.isArray(chunk) ? chunk : Object.entries(chunk);
        // 順帶填充整批進 _nameCache（下次就不用再查了）
        for (const [c, n] of entries) {
          if (n && typeof n === 'string' && !_nameCache[c]) _nameCache[c] = n;
        }
        if (_nameCache[code]) return _nameCache[code];
      }
    }
  } catch (_) {}

  // ── _nameCache 預載後可能已有了，再查一次 ──
  if (_nameCache[code]) return _nameCache[code];

  // 第二道：FinMind TaiwanStockInfo（外部 API，CORS 友善）
  try {
    const token = getFinMindToken?.() ?? '';
    const url   = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&data_id=${code}${token ? `&token=${token}` : ''}`;
    const text  = await fetchDirect(url, 6000);
    const name  = JSON.parse(text)?.data?.[0]?.stock_name;
    if (name) { _nameCache[code] = name; return name; }
  } catch (_) {}

  return null;
}

// ─────────────────────────────────────────────
// 全市場盤後批次（上市 TWSE + 上櫃 TPEx）
// ─────────────────────────────────────────────
export async function fetchTWSEPrices() {
  const map = {};
  let twseOK = false;   // 用來判斷是否要啟動 FinMind 備援抓中文名


// ── Advanced 0: 優先讀即時報價(GAS 每 5 分鐘寫入)─────────────────────────
// realtime 在收盤後定格在最後一筆(≈ 收盤價)，盤後也可用 → 不限時段
// 好處: F5 後直接拿到最近一次 GAS 寫的即時報價,不用等 TWSE/TPEx API
//       資料筆數比盤後快取多（1800+ vs ~900），中文名也比較完整
try {
  const rtData = await fsGetShared('market/realtime/prices');
  if (rtData && typeof rtData === 'object' && Object.keys(rtData).length > 100) {
    let filled = 0;
    for (const [code, info] of Object.entries(rtData)) {
      if (!info || typeof info !== 'object') continue;
      if (info.name) _nameCache[code] = info.name;
      if (info.market === 'tpex') _otcSet.add(code);
      map[code] = info;
      filled++;
    }
    // 同步到 window.__nameCache（modal-strategy / theme-ui 等讀此處）
    if (!window.__nameCache) window.__nameCache = new Map();
    for (const [code, info] of Object.entries(rtData)) {
      if (info?.name && !window.__nameCache.has(code)) {
        window.__nameCache.set(code, info.name);
      }
    }
    console.log(`[api] realtime prices 命中 → ${filled} 檔,跳過盤後快取`);
    return map;
  }
} catch (e) {
  console.warn('[api] realtime prices 讀取失敗,fallback 盤後快取:', e.message);
}


  // ── Advanced 1: 優先讀 Firestore（Cron Worker 已在盤後寫入）────────────────
  // 讀取最近一個有資料的交易日快照，命中則直接回傳，不打 TWSE/TPEx API
  // ⚠️ 週末/假日今天沒有資料，要往前找（最多找 5 天）
  try {
    let fsData = null;
    for (let i = 0; i < 5; i++) {
      const d = new Date(Date.now() + 8 * 3600 * 1000 - i * 86400 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const snap = await fsGetShared(`market/${dateStr}/prices`);
      if (snap && typeof snap === 'object' && Object.keys(snap).length > 100) {
        fsData = snap;
        console.log(`[api] Firestore 快取命中 → ${Object.keys(snap).length} 檔（${dateStr}${i > 0 ? '，往前 ' + i + ' 日' : ''}）`);
        break;
      }
    }
    if (fsData) {
      let nameFilled = 0;
      for (const [code, info] of Object.entries(fsData)) {
        if (info.name)           { _nameCache[code] = info.name; nameFilled++; }
        if (info.market === 'tpex') _otcSet.add(code);
        map[code] = info;
      }

      // ── 補刷中文名：從 Firestore names/batch* 讀取（不打 TWSE/TPEx）──
      try {
        const meta = await fsGetShared('names/meta');
        if (meta && meta.batches > 0) {
          let extraFilled = 0;
          for (let b = 0; b < meta.batches; b++) {
            const chunk = await fsGetShared(`names/batch${b}`);
            if (!chunk) continue;
            for (const [code, name] of Object.entries(chunk)) {
              if (!_nameCache[code]) { _nameCache[code] = name; extraFilled++; }
              if (map[code] && !map[code].name) map[code].name = name;
            }
          }
          if (extraFilled > 0) console.log(`[api] names/batch* 補刷 ${extraFilled} 檔中文名`);
        }
      } catch (e) { /* 忽略 */ }

      return map;
    }
  } catch (e) {
    console.warn('[api] Firestore 讀取失敗，fallback 到 TWSE/TPEx:', e.message);
  }

  // ── Firestore 無資料（盤中/非交易日/首次）→ fallback 原本路徑 ──────────────
  // ── 上市 TWSE ──────────────────────────────
  // ⚠️ 踩雷：STOCK_DAY_ALL 盤中回傳空物件 {} 非陣列 → rows is not iterable → map 空 → 清單沒更新
  const _skipTwseBatch = _isCurrentlyTrading();
  if (_skipTwseBatch) {
    console.log('[api] 盤中：跳過 TWSE STOCK_DAY_ALL，由 MIS 即時報價填充');
  }
  if (!_skipTwseBatch) try {
    const url  = 'https://opendata.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
    const text = await fetchWithProxy(url, 10000);
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { throw new Error('TWSE 非 JSON: ' + String(text).slice(0, 60)); }
    if (!Array.isArray(parsed)) throw new Error(`TWSE 非陣列: ${JSON.stringify(parsed).slice(0, 80)}`);
    const rows = parsed;
    for (const r of rows) {
      if (!r.Code || !r.ClosingPrice) continue;
      const price = parseFloat(r.ClosingPrice.replace(/,/g, ''));
      if (isNaN(price)) continue;
      const prevRaw = r.PreviousClosingPrice ?? r.YesterdayClosingPrice ?? r.OpeningPrice ?? r.ClosingPrice;
      const prev    = parseFloat(String(prevRaw).replace(/,/g, ''));
      const volumeShares = parseFloat((r.TradeVolume ?? r.Volume ?? '0').replace(/,/g, ''));
      const volume  = Math.round(volumeShares / 1000);
      const change  = parseFloat((r.Change ?? '0').replace(/,/g, ''));
      const chgPct  = prev > 0 ? (change / prev) * 100 : 0;
      map[r.Code]   = { name: r.Name, price, prev, volume, chgPct, market: 'twse' };
      if (r.Name) _nameCache[r.Code] = r.Name;
    }
    twseOK = Object.keys(map).length > 0;
    console.log(`[api] TWSE 載入 ${Object.keys(map).length} 檔`);
  } catch (e) {
    console.warn('[api] TWSE batch failed:', e.message);
  }

  // ── TWSE 失敗 → FinMind TaiwanStockPrice fallback（CORS 直連，含上市全市場單日價格）
  if (!twseOK) {
    try {
      const token = getFinMindToken?.() ?? '';
      // 取今天日期（YYYY-MM-DD），FinMind 自動回最近一個交易日
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&start_date=${today}${token ? `&token=${token}` : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const json = JSON.parse(await res.text());
        const rows = json?.data ?? [];
        let finmindCount = 0;
        for (const r of rows) {
          const code = r.stock_id;
          if (!code || !/^\d{4,5}$/.test(code)) continue;
          const price  = parseFloat(r.close);
          if (isNaN(price) || price <= 0) continue;
          const prev   = parseFloat(r.open) || price;  // FinMind 沒給 prev_close，先用 open 估
          const volume = Math.round((parseFloat(r.Trading_Volume) || 0) / 1000);
          const change = parseFloat(r.spread) || 0;  // FinMind 'spread' 是漲跌
          const realPrev = price - change;
          const chgPct = realPrev > 0 ? (change / realPrev) * 100 : 0;
          if (!map[code]) {
            map[code] = { name: code, price, prev: realPrev, volume, chgPct, market: 'twse' };
            finmindCount++;
          }
        }
        if (finmindCount > 0) {
          twseOK = true;
          console.log(`[api] FinMind TaiwanStockPrice fallback 載入 ${finmindCount} 檔`);
        }
      }
    } catch (e) {
      console.warn('[api] FinMind TaiwanStockPrice fallback failed:', e.message);
    }
  }

  // ── 上櫃 TPEx ──────────────────────────────
  // TPEx OpenAPI 實際欄位（由真實 API 回傳確認）：
  //   SecuritiesCompanyCode, CompanyName, Close, Change（含+/-符號及尾空格）, TradingShares
  //   注意：無 PreviousClose，prev = Close - Change 反推
  //   TPEx 回應資料量大（800+檔），corsproxy.io 會回 413，改用直接 fetch 優先
  try {
    const url  = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
    // 先直接 fetch（TPEx API 有開 CORS header），失敗才走 proxy
    let text;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      console.warn('[api] TPEx direct fetch failed, trying proxy:', e.message);
      text = await fetchWithProxy(url, 10000);   // 試所有 proxy
    }
    const rows = JSON.parse(text);
    let otcCount = 0;
    for (const r of rows) {
      const code = r.SecuritiesCompanyCode;
      if (!code) continue;
      const price = parseFloat(String(r.Close ?? '').replace(/,/g, ''));
      if (isNaN(price) || price <= 0) continue;
      // Change 帶 +/- 符號且可能有尾空格，如 "+1.11" 或 "-0.02 "
      const change = parseFloat(String(r.Change ?? '0').trim().replace(/,/g, ''));
      const prev   = price - (isNaN(change) ? 0 : change);
      const volume = Math.round(parseFloat(String(r.TradingShares ?? '0').replace(/,/g, '')) / 1000);
      const chgPct = prev > 0 ? (change / prev) * 100 : 0;
      const name   = r.CompanyName ?? code;
      map[code]     = { name, price, prev, volume, chgPct, market: 'tpex' };
      if (name) _nameCache[code] = name;
      _otcSet.add(code);   // 動態填充，供 toYahooSymbol 判斷 .TWO
      otcCount++;
    }
    console.log(`[api] TPEx 載入 ${otcCount} 檔`);
  } catch (e) {
    console.warn('[api] TPEx batch failed:', e.message);
  }

  // ── 中文名備援:TWSE 失敗時補上市股中文名 ──
  // 名稱不常變，存 IndexedDB（TTL 90 天），快取命中直接用，過期才打 FinMind
  if (!twseOK) {
    let fromCache = false;
    try {
      const cached = await _namesCacheGet();
      if (cached) {
        let filled = 0;
        for (const [code, name] of Object.entries(cached.names)) {
          if (!_nameCache[code]) { _nameCache[code] = name; filled++; }
        }
        const daysLeft = Math.ceil((_NAME_TTL - (Date.now() - cached.ts)) / 86400000);
        console.log(`[api] 中文名從 IndexedDB 快取載入 ${filled} 檔（剩 ${daysLeft} 天過期）`);
        fromCache = true;
      }
    } catch (e) {
      console.warn('[api] 讀取中文名快取失敗:', e.message);
    }

    // ── Advanced 2: 從 Firestore 分批讀取中文名（每批 500 筆）──────────────────
    if (!fromCache) {
      try {
        const meta = await fsGetShared('names/meta');
        if (meta && meta.batches > 0) {
          let filled = 0;
          for (let b = 0; b < meta.batches; b++) {
            const chunk = await fsGetShared(`names/batch${b}`);
            if (!chunk) continue;
            for (const [code, name] of Object.entries(chunk)) {
              if (!_nameCache[code]) { _nameCache[code] = name; filled++; }
            }
          }
          if (filled > 0) {
            console.log(`[api] 中文名 Firestore 雲端命中 → ${filled} 檔（${meta.batches} 批）`);
            fromCache = true;
          }
        }
      } catch (e) {
        console.warn('[api] Firestore 中文名讀取失敗:', e.message);
      }
    }

    // 快取不存在或已過期 → 打 FinMind，結果存回 IndexedDB
    if (!fromCache) {
      try {
        const token = getFinMindToken?.() ?? '';
        const url   = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo${token ? `&token=${token}` : ''}`;
        const text  = await fetchDirect(url, 12000);
        const rows  = (JSON.parse(text)?.data ?? []);
        const names = {};
        let filled  = 0;
        for (const r of rows) {
          const code = r.stock_id;
          const name = r.stock_name;
          if (!code || !name) continue;
          names[code] = name;
          if (!_nameCache[code]) { _nameCache[code] = name; filled++; }
        }
        await _namesCacheSet(names);
        console.log(`[api] FinMind 中文名備援:補上 ${filled} 檔，已寫入 IndexedDB（90天有效）`);
      } catch (e) {
        console.warn('[api] FinMind 中文名備援失敗:', e.message);
      }
    }
  }

  return map;
}

// ─────────────────────────────────────────────
// Phase 2：批次拉取 K 線
// ─────────────────────────────────────────────
export async function fetchScreenerData(codes, {
  period      = '3mo',
  concurrency = 5,
  onProgress  = null,
} = {}) {
  // 過濾掉 ETF/權證/債券等非一般股，避免大量 Yahoo 404 浪費時間
  const normalCodes = codes.filter(_isNormalStock);
  const skipped = codes.length - normalCodes.length;
  if (skipped > 0) {
    console.log(`[screener] 跳過 ${skipped} 個非一般股（ETF/權證等），剩 ${normalCodes.length} 檔`);
  }
  const result = new Map();
  let done = 0;
  const total = normalCodes.length;
  for (let i = 0; i < total; i += concurrency) {
    const batch = normalCodes.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async code => {
        try {
          // ⚠️ 固定用 1y + allowStale，走 R2 快取不打 Yahoo
          //   上櫃股用 toYahooSymbol 可能猜錯 suffix → Not Found
          //   改用雙 suffix fallback：先試 .TW，404 再試 .TWO
          let candles = [];
          const sym1 = toYahooSymbol(code);
          try {
            candles = await fetchHistoryCached(sym1, '1y', { allowStale: true });
          } catch (e1) {
            if (/Not Found/i.test(e1.message)) {
              const sym2 = sym1.endsWith('.TW') ? sym1.replace('.TW', '.TWO') : sym1.replace('.TWO', '.TW');
              candles = await fetchHistoryCached(sym2, '1y', { allowStale: true });
            } else {
              throw e1;
            }
          }
          if (candles.length) result.set(code, candles);
        } catch (e) {
          console.warn(`[screener] failed for ${code}:`, e.message);
        } finally {
          done++;
          onProgress?.(done, total);
        }
      })
    );
    if (i + concurrency < total) await new Promise(r => setTimeout(r, 300));
  }
  return result;
}

// ─────────────────────────────────────────────
// 篩選器 K 線：用 Yahoo Finance 逐檔查詢
// FinMind 免費版不支援批次多代碼，統一走 Yahoo
// 過濾非一般股（ETF/權證/特別股），避免無效請求
// ─────────────────────────────────────────────

function _isNormalStock(code) {
  // 接受 4碼（上市/上櫃）或 5碼（部分上櫃）純數字代號
  if (!/^\d{4,5}$/.test(code)) return false;
  // 排除 ETF（00 開頭，如 0050、00878）
  if (code.startsWith('00')) return false;
  return true;
}

export async function fetchScreenerDataFinMind(codes, {
  period      = '3mo',
  onProgress  = null,
} = {}) {
  // 過濾非一般股（ETF/權證等），避免無效請求
  const normalCodes = codes.filter(_isNormalStock);
  const skipped     = codes.length - normalCodes.length;
  if (skipped > 0) {
    console.log(`[screener] 跳過 ${skipped} 個非一般股，剩 ${normalCodes.length} 檔`);
  }

  const result = new Map();
  let done              = 0;
  let consecutive429    = 0;
  const total           = normalCodes.length;
  const BASE_DELAY      = 350;   // 每股間隔 ms
  const MAX_EXTRA_DELAY = 8000;  // 最長退避 ms

  // 逐一查詢（同 pattern-scan.js），配合指數退避，避免 Yahoo 429
  for (const code of normalCodes) {
    const symbol = toYahooSymbol(code);

    let success = false;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const candles = await fetchHistory(symbol, period);
        if (candles.length >= 20) result.set(code, candles);
        consecutive429 = Math.max(0, consecutive429 - 1);
        success = true;
        break;
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes('429')) {
          consecutive429++;
          // 429 不重試，直接跳下一檔
          console.warn(`[screener] ${code} 429，退避中`);
          break;
        }
        // 其他錯誤：短暫等待後重試
        if (attempt < 2) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }

    done++;
    onProgress?.(done, total);

    // 動態間隔：正常 350ms，每次 429 額外加 1 秒（最多 8 秒）
    const extraDelay = Math.min(consecutive429 * 1000, MAX_EXTRA_DELAY);
    await new Promise(r => setTimeout(r, BASE_DELAY + extraDelay));
  }

  console.log(`[screener] 完成：${result.size} / ${normalCodes.length} 檔有 K 線資料`);
  return result;
}

// ============================================================================
// fetchVerifyData — 補充資訊 JSON 勘誤用
// 用 FinMind TaiwanStockPER 取得最新 PE / PB / 殖利率，與 AI 給的數字比對
// ============================================================================

/**
 * 取得 FinMind 最新一筆 PE / PB / 殖利率，用於補充資訊勘誤
 * @param {string} code  股票代號，例如 '2330'
 * @returns {Promise<{pe:number|null, pbRatio:number|null, dividendYield:number|null, fetchedAt:string}>}
 *          無 token 或 API 失敗時回 null
 */
export async function fetchVerifyData(code) {
  const token = getFinMindToken();
  if (!token) return null;                   // 無 token → 跳過驗證
  try {
    const data = await _fetchFinMindPER(code, token);
    return {
      pe            : data.pe            ?? null,
      pbRatio       : data.pbRatio       ?? null,
      dividendYield : data.dividendYield != null
                        ? parseFloat((data.dividendYield * 100).toFixed(2))  // 轉成 % 格式，對齊 AI 給的值
                        : null,
      fetchedAt     : new Date().toISOString().slice(0, 10),
    };
  } catch (e) {
    console.warn('[fetchVerifyData] failed:', code, e.message);
    return null;
  }
}
