/**
 * api-hist.js — 累積 K 線倉儲讀取模組（回測引擎資料源）
 *
 * 對接 Worker /hist route，讀取 GAS hist_to_r2.gs 維護的累積 K 線。
 *
 * 資料格式（slim + adjclose）：
 *   { code, symbol, updated, candles: [{t,o,h,l,c,a,v}, ...] }
 *     o/h/l/c/v = 原始價（與市場報價一致，畫圖用）
 *     a         = 還原收盤價（除權息已調整，回測報酬率必須用這個）
 *
 * 特性：
 *   - 獨立模組，不動 api.js / api-test.js
 *   - IDB 快取（store: hist_cache，有效期 1 天 — 每日 merge 後資料才變）
 *   - 批次併發 + 進度回報，介面對齊 api-test.js
 *
 * export：
 *   fetchHistOne(code)                          → {code, updated, candles} | null
 *   fetchHistAll(codes, onProgress?, signal?)   → Map<code, histObj>
 *   fetchBenchmark(symbol?)                     → candles[]（大盤基準，fallback 走 1y proxy）
 *   clearHistCache()
 */

const _HIST_WORKER = 'https://stock-2027.luffy0606.workers.dev';
const _HIST_TOKEN  = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
const _HIST_CONCUR = 8;                       // 批次併發數
const _HIST_TTL    = 24 * 3600 * 1000;        // IDB 快取 1 天

// ─────────────────────────────────────────────────────────────────────────────
// 單檔讀取
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchHistOne(code) {
  const cached = await _idbGet(code);
  if (cached) return cached;

  const hist = await _fetchOneHist(code);
  if (hist?.candles?.length >= 100) {
    _idbSet(code, hist).catch(() => {});
  }
  return hist;
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次讀取（回測全市場 / 自選清單）
// 回傳 Map<code, histObj>；onProgress(done, total) 可選
// ≤20 檔走單檔 /hist；>20 檔走 /r2bulkget（每批 150，1950 檔約 13 請求）
// ─────────────────────────────────────────────────────────────────────────────
const _BULK_CHUNK = 150;

export async function fetchHistAll(codes, onProgress = null, signal = null) {
  const result  = new Map();
  const toFetch = [];

  // 1. 先查 IDB
  for (const code of codes) {
    const cached = await _idbGet(code);
    if (cached) result.set(code, cached);
    else        toFetch.push(code);
  }
  if (onProgress) onProgress(result.size, codes.length);

  if (toFetch.length === 0) return result;
  let done = result.size;

  // 2a. 大量：走 bulkget
  if (toFetch.length > 20) {
    for (let i = 0; i < toFetch.length; i += _BULK_CHUNK) {
      if (signal?.aborted) break;
      const batch = toFetch.slice(i, i + _BULK_CHUNK);
      try {
        const res = await fetch(`${_HIST_WORKER}/r2bulkget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': _HIST_TOKEN },
          body: JSON.stringify({ keys: batch.map(c => 'hist:' + c), slim: false }),
        });
        if (res.ok) {
          const j = await res.json();
          for (const code of batch) {
            const raw = j.data?.['hist:' + code];
            if (!raw) continue;
            try {
              const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (data?.candles?.length >= 100) {
                result.set(code, data);
                _idbSet(code, data).catch(() => {});
              }
            } catch {}
          }
        }
      } catch {}
      done += batch.length;
      if (onProgress) onProgress(Math.min(done, codes.length), codes.length);
    }
    return result;
  }

  // 2b. 少量：單檔併發
  for (let i = 0; i < toFetch.length; i += _HIST_CONCUR) {
    if (signal?.aborted) break;
    const batch = toFetch.slice(i, i + _HIST_CONCUR);
    const settled = await Promise.allSettled(batch.map(c => _fetchOneHist(c)));
    settled.forEach((res, idx) => {
      const code = batch[idx];
      if (res.status === 'fulfilled' && res.value?.candles?.length >= 100) {
        result.set(code, res.value);
        _idbSet(code, res.value).catch(() => {});
      }
    });
    done += batch.length;
    if (onProgress) onProgress(Math.min(done, codes.length), codes.length);
    await new Promise(r => setTimeout(r, 50));
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 取得 hist 倉儲全部代號（全市場掃描用，1hr edge cache）
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchAllHistCodes() {
  try {
    const res = await fetch(`${_HIST_WORKER}/histcodes`, {
      headers: { 'X-Proxy-Token': _HIST_TOKEN },
    });
    if (!res.ok) return [];
    const j = await res.json();
    return j.codes ?? [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 大盤基準（回測比較用）
// hist 倉儲只涵蓋個股/ETF；指數 ^TWII 走既有 1y proxy fallback。
// 建議基準：'0050'（含息 ETF，若 hist 有建檔就直接用，最省事）
//          fallback '^TWII'（加權指數，不含息，會低估大盤 → 對策略有利，需註明）
// 回傳統一格式 candles: [{t,o,h,l,c,a,v}]（^TWII 無 adjclose 時 a=c）
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchBenchmark(symbol = '0050') {
  // 優先試 hist（0050 等 ETF 若在 ISIN 清單內會被每日 merge 涵蓋）
  if (!symbol.startsWith('^')) {
    const hist = await fetchHistOne(symbol);
    if (hist?.candles?.length >= 100) return hist.candles;
  }

  // fallback：走 Worker proxy 抓 Yahoo 1y raw（指數或 hist 未建檔）
  try {
    const sym = symbol.startsWith('^') ? symbol : symbol + '.TW';
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y&includePrePost=false`;
    const res = await fetch(`${_HIST_WORKER}/?url=${encodeURIComponent(target)}`, {
      headers: { 'X-Proxy-Token': _HIST_TOKEN },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    if (!r) return null;
    const ts  = r.timestamp ?? [];
    const q   = r.indicators?.quote?.[0] ?? {};
    const adj = r.indicators?.adjclose?.[0]?.adjclose ?? null;
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue;
      candles.push({
        t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i],
        c: q.close[i],
        a: adj ? (adj[i] ?? q.close[i]) : q.close[i],
        v: q.volume?.[i] ?? 0,
      });
    }
    return candles;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 清除快取（merge 後想立即看新資料時手動呼叫）
// ─────────────────────────────────────────────────────────────────────────────
export async function clearHistCache() {
  try {
    const db = await _openIdb();
    const store = db.transaction('hist_cache', 'readwrite').objectStore('hist_cache');
    await _idbReq(store.clear());
    console.log('[api-hist] hist_cache 清除完成');
  } catch (e) {
    console.warn('[api-hist] clearHistCache 失敗:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 內部：打 Worker /hist
// ─────────────────────────────────────────────────────────────────────────────
async function _fetchOneHist(code) {
  try {
    const res = await fetch(`${_HIST_WORKER}/hist?code=${encodeURIComponent(code)}`, {
      headers: { 'X-Proxy-Token': _HIST_TOKEN },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.candles?.length) return null;
    return data;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDB：獨立 db stockdash_hist / store hist_cache
// ─────────────────────────────────────────────────────────────────────────────
let _idbInstance = null;

function _openIdb() {
  if (_idbInstance) return Promise.resolve(_idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('stockdash_hist', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('hist_cache', { keyPath: 'code' });
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

async function _idbGet(code) {
  try {
    const db = await _openIdb();
    const store = db.transaction('hist_cache', 'readonly').objectStore('hist_cache');
    const rec = await _idbReq(store.get(code));
    if (!rec) return null;
    if (Date.now() - (rec.ts ?? 0) > _HIST_TTL) return null;
    return rec.data ?? null;
  } catch { return null; }
}

async function _idbSet(code, data) {
  const db = await _openIdb();
  const store = db.transaction('hist_cache', 'readwrite').objectStore('hist_cache');
  await _idbReq(store.put({ code, data, ts: Date.now() }));
}
