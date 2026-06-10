/**
 * api-test.js — 實驗室 K 線擷取模組
 *
 * 對接 Worker /kline-test route，讀取 GAS test-lab.gs 存入的 2Y K 線。
 * 供 lab-experiment.js 全市場掃描使用。
 *
 * 特性：
 *   - 獨立模組，不修改 api.js / fetchHistoryCached
 *   - IDB 快取（key: {symbol}_test_{period}），避免每次重打 Worker
 *   - 批次讀取：Promise.allSettled 並發，控制 concurrency
 *   - 失敗靜默跳過，不影響主系統
 */

const _TEST_WORKER  = 'https://stock-2027.luffy0606.workers.dev';
const _TEST_TOKEN   = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
const _TEST_PERIOD  = '2y';
const _TEST_CONCUR  = 8;   // 並發數
const _TEST_IDB_KEY = (sym, period) => `${sym}_test_${period}`;

// ─────────────────────────────────────────────────────────────────────────────
// 主要入口：全市場 2Y K 線批次讀取
// 回傳 Map<code, candles[]>（slim 格式 {t,o,h,l,c,v}，c = 收盤）
// onProgress(done, total) 可選，供進度條更新
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchTestKlineAll(codes, onProgress = null, signal = null) {
  const result   = new Map();
  const toFetch  = [];

  // 1. 先查 IDB 快取
  for (const code of codes) {
    const cached = await _idbGet(code, _TEST_PERIOD);
    if (cached?.length >= 100) {
      result.set(code, cached);
    } else {
      toFetch.push(code);
    }
  }

  if (onProgress) onProgress(result.size, codes.length);

  // 2. 分批並發打 Worker
  let done = result.size;
  for (let i = 0; i < toFetch.length; i += _TEST_CONCUR) {
    if (signal?.aborted) break;
    const batch = toFetch.slice(i, i + _TEST_CONCUR);
    const settled = await Promise.allSettled(
      batch.map(code => _fetchOneTestKline(code, _TEST_PERIOD))
    );
    settled.forEach((res, idx) => {
      const code = batch[idx];
      if (res.status === 'fulfilled' && res.value?.length >= 100) {
        result.set(code, res.value);
        // 寫 IDB 快取（不阻塞）
        _idbSet(code, _TEST_PERIOD, res.value).catch(() => {});
      }
    });
    done += batch.length;
    if (onProgress) onProgress(Math.min(done, codes.length), codes.length);
    // 小 jitter 避免 Worker 瞬間壓力
    await new Promise(r => setTimeout(r, 50));
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 單股讀取（公開，供單股模式用）
// 回傳 candle[]（slim）或 null
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchTestKlineOne(code, period = _TEST_PERIOD) {
  // IDB 快取優先
  const cached = await _idbGet(code, period);
  if (cached?.length >= 100) return cached;

  const candles = await _fetchOneTestKline(code, period);
  if (candles?.length >= 100) {
    _idbSet(code, period, candles).catch(() => {});
  }
  return candles;
}

// ─────────────────────────────────────────────────────────────────────────────
// 清除 IDB 實驗室快取（手動呼叫，方便重跑）
// ─────────────────────────────────────────────────────────────────────────────
export async function clearTestKlineCache() {
  try {
    const db    = await _openIdb();
    const store = db.transaction('kline_test', 'readwrite').objectStore('kline_test');
    await _idbReq(store.clear());
    console.log('[api-test] IDB kline_test 清除完成');
  } catch (e) {
    console.warn('[api-test] clearTestKlineCache 失敗:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 內部：打 Worker /kline-test
// ─────────────────────────────────────────────────────────────────────────────
async function _fetchOneTestKline(code, period) {
  // 試 .TW 再試 .TWO（Worker 有 suffix fallback 但前端也試一下）
  const symbols = [code + '.TW', code + '.TWO'];
  for (const sym of symbols) {
    try {
      const url = `${_TEST_WORKER}/kline-test?symbol=${encodeURIComponent(sym)}&period=${period}`;
      const res = await fetch(url, {
        headers: { 'X-Proxy-Token': _TEST_TOKEN },
        cache:   'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.candles?.length >= 100) {
        // 轉成標準 candle 格式（前端 OHLCV）
        return data.candles.map(c => ({
          time:   c.t,
          open:   c.o,
          high:   c.h,
          low:    c.l,
          close:  c.c,
          volume: c.v ?? 0,
        }));
      }
    } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// IDB：獨立的 kline_test store（不污染主系統 kline_cache）
// ─────────────────────────────────────────────────────────────────────────────
let _idbInstance = null;

function _openIdb() {
  if (_idbInstance) return Promise.resolve(_idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('stockdash_test', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('kline_test', { keyPath: 'key' });
    };
    req.onsuccess = e => { _idbInstance = e.target.result; resolve(_idbInstance); };
    req.onerror   = e => reject(e.target.error);
  });
}

function _idbReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function _idbGet(code, period) {
  try {
    const db    = await _openIdb();
    const store = db.transaction('kline_test', 'readonly').objectStore('kline_test');
    const rec   = await _idbReq(store.get(_TEST_IDB_KEY(code, period)));
    if (!rec) return null;
    // 實驗快取有效期：7 天（2y 資料不需要每日刷新）
    if (Date.now() - (rec.ts ?? 0) > 7 * 86400 * 1000) return null;
    return rec.candles ?? null;
  } catch { return null; }
}

async function _idbSet(code, period, candles) {
  const db    = await _openIdb();
  const store = db.transaction('kline_test', 'readwrite').objectStore('kline_test');
  await _idbReq(store.put({ key: _TEST_IDB_KEY(code, period), candles, ts: Date.now() }));
}
