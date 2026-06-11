/**
 * api-core.js — 共用基礎層
 * Worker proxy / token / 熔斷 / proxy 輪替 / _otcSet / toYahooSymbol
 */
import { getFinMindToken } from './config.js';

export const FEATURE_INTRADAY_5M = !!getFinMindToken();

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

export { _otcSet, fetchWithProxy, fetchScreener, _looksLikeRateLimit, SELF_PROXY, PROXY_TOKEN };
export const _WORKER_ORIGIN = SELF_PROXY.replace(/\/\?url=$/, '');

