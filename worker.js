/**
 * CORS Proxy for stock dashboard
 * Usage: https://YOUR-WORKER.workers.dev/?url=ENCODED_TARGET_URL
 *
 * 修正記錄：
 * 2026-05-19  TPEx /errors 無限 redirect → 加 redirect:'manual'，偵測 3xx 直接放棄
 * 2026-05-19  www.twse.com.tw 307 沒有 fallback → 加 _twseMainFallback
 * 2026-05-20  加 /isin route → Big5 解碼 ISIN 上市/上櫃產業分類，供 GAS 呼叫
 * 2026-05-29  K線快取 KV → R2（env.KLINE_R2）+ Cache API 邊緣快取；新增 /r2put 批次寫入端點（GAS 用）
 *             ※ 若未綁 R2，會自動 fallback 回舊 KV（env.KLINE_CACHE），方便過渡/回滾
 */

const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'mops.twse.com.tw',
  'opendata.twse.com.tw',
  'www.tpex.org.tw',
  'api.finmindtrade.com',
  'www.twse.com.tw',
  'news.google.com',
  'tw.stock.yahoo.com',
  'mis.twse.com.tw',
  'isin.twse.com.tw',   // ← 新增：ISIN 產業分類
  'etfapi.yuantaetfs.com',
  'www.yuantaetfs.com',
  'www.ezmoney.com.tw',
  'fhtrust.com.tw',
];

// ─── UA 輪換池（繞過 Yahoo rate limit）──────────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
];

// Yahoo 專用 Referer 輪換（讓請求看起來來自不同入口）
const YAHOO_REFERERS = [
  'https://finance.yahoo.com/',
  'https://tw.stock.yahoo.com/',
  'https://finance.yahoo.com/quote/',
  'https://finance.yahoo.com/chart/',
];

function _randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function _randomReferer(isYahoo = false) {
  if (isYahoo) return YAHOO_REFERERS[Math.floor(Math.random() * YAHOO_REFERERS.length)];
  return 'https://www.yuantaetfs.com/';
}

// 加隨機小延遲讓請求看起來更像真人（僅 Yahoo 用）
function _jitter(baseMs = 0) {
  return new Promise(r => setTimeout(r, baseMs + Math.random() * 300));
}

const FETCH_OPTS = {
  headers: {
    'User-Agent': UA_POOL[0],  // 預設，實際請求會用 _randomUA()
    'Accept': 'application/json, text/html, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.yuantaetfs.com/',
  },
  redirect: 'follow',
  cf: {
    resolveOverride: '1.1.1.1',
  },
};

// Yahoo 專用 fetch opts（每次隨機 UA + Referer）
function _yahooFetchOpts() {
  return {
    headers: {
      'User-Agent':      _randomUA(),
      'Accept':          'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer':         _randomReferer(true),
      'Origin':          'https://finance.yahoo.com',
      'Cache-Control':   'no-cache',
      'Pragma':          'no-cache',
      'sec-ch-ua':       '"Chromium";v="124", "Google Chrome";v="124"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest':  'empty',
      'Sec-Fetch-Mode':  'cors',
      'Sec-Fetch-Site':  'same-site',
    },
    redirect: 'follow',
  };
}

// ─── mis.twse.com.tw Session 管理 ────────────────────────────────────────────
let _misSession = null;
let _misSessionTs = 0;
const MIS_SESSION_TTL = 10 * 60 * 1000;

async function _getMisSession() {
  const now = Date.now();
  if (_misSession && now - _misSessionTs < MIS_SESSION_TTL) return _misSession;
  try {
    const res = await fetch('https://mis.twse.com.tw/stock/index.jsp', {
      headers: { 'User-Agent': FETCH_OPTS.headers['User-Agent'], 'Accept': 'text/html,*/*' },
      redirect: 'follow',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/JSESSIONID=([^;]+)/);
    if (match) {
      _misSession = match[1];
      _misSessionTs = now;
      console.log('[proxy] mis session 取得:', _misSession.slice(0, 8) + '...');
    }
  } catch (e) {
    console.log('[proxy] mis session 失敗:', e.message);
  }
  return _misSession;
}

// ─── Proxy Token（防白嫖）────────────────────────────────────────────────────
// Token 存在 Worker Secret: PROXY_TOKEN
// api.js / GAS 每次打 Worker 帶 X-Proxy-Token header
const TOKEN_EXEMPT_PATHS = ['/isin', '/health'];  // 這些路徑不需要 Token

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    // ★ Token 驗證（exempt: OPTIONS + /isin + /health）
    const expectedToken = env?.PROXY_TOKEN;
    if (expectedToken && !TOKEN_EXEMPT_PATHS.includes(url.pathname)) {
      const incoming = request.headers.get('X-Proxy-Token');
      if (incoming !== expectedToken) {
        return errResponse('Unauthorized', 403);
      }
    }

    // ─── /isin route：Big5 解碼 ISIN 產業分類，回傳 JSON ──────────────────
    if (url.pathname === '/isin') {
      const mode = url.searchParams.get('mode') || '2';
      if (!['2', '4'].includes(mode)) return errResponse('mode must be 2 or 4', 400);
      return _fetchIsin(mode);
    }

    // ─── /r2put route：GAS 批次寫入 R2（K線快取）──────────────────────────
    // POST body: [{ key, value }, ...] 或 { key: value, ... }
    //   value = 原始 Yahoo K線 JSON 字串
    // Token：非豁免路徑，已於上方驗證（GAS 必須帶 X-Proxy-Token）
    if (url.pathname === '/r2put') {
      if (request.method !== 'POST') return errResponse('POST only', 405);
      if (!env?.KLINE_R2)            return errResponse('R2 not bound (KLINE_R2)', 500);
      let items;
      try { items = await request.json(); } catch { return errResponse('bad json body', 400); }
      const arr = Array.isArray(items)
        ? items
        : Object.entries(items).map(([key, value]) => ({ key, value }));
      const ts = String(Date.now());
      // ★ 並發寫入：所有 R2 put 同時發出（I/O 並行，比逐一 await 快數十倍）
      const putResults = await Promise.allSettled(
        arr
          .filter(it => it && it.key && it.value != null)
          .map(it => {
            const val = typeof it.value === 'string' ? it.value : JSON.stringify(it.value);
            return env.KLINE_R2.put(it.key, val, { customMetadata: { ts } });
          })
      );
      const ok = putResults.filter(r => r.status === 'fulfilled').length;
      console.log(`[r2put] 寫入 ${ok}/${arr.length} 筆`);
      return new Response(JSON.stringify({ ok, total: arr.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const target = url.searchParams.get('url');
    if (!target) return errResponse('Missing ?url= parameter', 400);

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return errResponse('Invalid url', 400);
    }

    if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
      return errResponse(`Host not allowed: ${targetUrl.hostname}`, 403);
    }

    if (targetUrl.hostname === 'mis.twse.com.tw') return _fetchMis(targetUrl);

    // ★ Yahoo K線：先查快取（R2 優先；未綁 R2 才 fallback 舊 KV）
    const isYahoo = targetUrl.hostname.includes('finance.yahoo.com');
    if (isYahoo) {
      if (env?.KLINE_R2) {
        const hit = await _r2GetYahoo(env, targetUrl, ctx);
        if (hit) { console.log(`[proxy] R2 HIT: ${targetUrl.pathname}`); return hit; }
      } else if (env?.KLINE_CACHE) {
        const kvResult = await _kvGetYahoo(env.KLINE_CACHE, targetUrl);
        if (kvResult) { console.log(`[proxy] KV HIT: ${targetUrl.pathname}`); return kvResult; }
      }
    }

    // 先試主要 URL（Yahoo 用隨機 UA + jitter，其他用 FETCH_OPTS）
    try {
      const fetchOpts = isYahoo ? _yahooFetchOpts() : FETCH_OPTS;
      if (isYahoo) await _jitter(50);  // Yahoo 請求前隨機延遲
      const res = await fetch(targetUrl.toString(), fetchOpts);
      if (res.ok || res.status === 304) {
        // Yahoo K線成功 → 順手寫回快取給下次用
        if (isYahoo) {
          if (env?.KLINE_R2) {
            ctx.waitUntil(_r2PutYahoo(env, targetUrl, res.clone()).catch(() => {}));
          } else if (env?.KLINE_CACHE) {
            ctx.waitUntil(_kvPutYahoo(env.KLINE_CACHE, targetUrl, res.clone()).catch(() => {}));
          }
        }
        return wrapResponse(res);
      }
      console.log(`[proxy] ${targetUrl.hostname} returned ${res.status}, trying fallback`);
    } catch (e) {
      console.log(`[proxy] ${targetUrl.hostname} fetch error: ${e.message}, trying fallback`);
    }

    const fallbackRes = await _tryFallback(targetUrl);
    if (fallbackRes) return fallbackRes;

    return errResponse('Upstream unavailable', 502);
  },
};

// ─── ISIN Big5 解碼 + HTML 解析 ───────────────────────────────────────────────
async function _fetchIsin(mode) {
  const isinUrl = `https://isin.twse.com.tw/isin/C_public.jsp?strMode=${mode}`;
  try {
    const res = await fetch(isinUrl, {
      headers: {
        'User-Agent': FETCH_OPTS.headers['User-Agent'],
        'Accept': 'text/html,*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) return errResponse(`ISIN upstream ${res.status}`, 502);

    const buf  = await res.arrayBuffer();
    const html = new TextDecoder('big5').decode(buf);

    const result = _parseIsinHtml(html);
    console.log(`[isin] mode=${mode} parsed ${result.length} entries`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    console.log(`[isin] error: ${e.message}`);
    return errResponse(`ISIN fetch failed: ${e.message}`, 502);
  }
}

function _parseIsinHtml(html) {
  const result = [];
  const rows = html.split(/<tr/i);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cells = [];
    const tdParts = row.split(/<td/i);
    for (let j = 1; j < tdParts.length; j++) {
      const inner = tdParts[j].replace(/^[^>]*>/, '').split(/<\/td/i)[0];
      const text  = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      cells.push(text);
    }
    if (cells.length < 5) continue;
    const parts = cells[0].split(/[\s　]+/);
    const code  = parts[0].trim();
    const name  = parts.slice(1).join(' ').trim();
    if (!code || !/^\d{4}$/.test(code)) continue;
    if (!name) continue;
    const industryRaw = cells[4].trim();
    if (!industryRaw || industryRaw.length < 2) continue;
    const industry = industryRaw.replace(/工?業$/, '').trim();
    if (!industry) continue;
    result.push({ code, name, industry });
  }
  return result;
}

// ─── mis 專用 fetch ───────────────────────────────────────────────────────────
async function _fetchMis(targetUrl) {
  const session = await _getMisSession();
  const headers = {
    'User-Agent': FETCH_OPTS.headers['User-Agent'],
    'Accept': 'application/json, */*',
    'Referer': 'https://mis.twse.com.tw/stock/index.jsp',
  };
  if (session) headers['Cookie'] = `JSESSIONID=${session}`;
  try {
    const res = await fetch(targetUrl.toString(), { headers, redirect: 'follow' });
    if (res.ok) return wrapResponse(res);
    if (res.status === 403 && session) {
      console.log('[proxy] mis 403，清 session 重試');
      _misSession = null;
      const session2 = await _getMisSession();
      if (session2) {
        headers['Cookie'] = `JSESSIONID=${session2}`;
        const res2 = await fetch(targetUrl.toString(), { headers, redirect: 'follow' });
        if (res2.ok) return wrapResponse(res2);
      }
    }
    return errResponse(`mis upstream ${res.status}`, 502);
  } catch (e) {
    return errResponse(`mis fetch error: ${e.message}`, 502);
  }
}

// ─── Fallback 策略 ────────────────────────────────────────────────────────────
async function _tryFallback(targetUrl) {
  const host = targetUrl.hostname;
  if (host === 'opendata.twse.com.tw') return _twseFallback(targetUrl);
  if (host === 'www.tpex.org.tw')      return _tpexFallback(targetUrl);
  if (host === 'www.twse.com.tw')      return _twseMainFallback(targetUrl);
  return null;
}

async function _twseFallback(targetUrl) {
  const reportName = targetUrl.pathname.split('/').pop();
  const fb = `https://www.twse.com.tw/exchangeReport/${reportName}?response=json`;
  try {
    const res = await fetch(fb, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Referer': 'https://www.twse.com.tw/',
      },
    });
    if (res.ok) {
      console.log(`[proxy] TWSE fallback OK: ${fb}`);
      return wrapResponse(res);
    }
    console.log(`[proxy] TWSE fallback ${res.status}`);
  } catch (e) {
    console.log(`[proxy] TWSE fallback error: ${e.message}`);
  }
  return null;
}

async function _twseMainFallback(targetUrl) {
  const path = targetUrl.pathname;
  if (path.includes('T86')) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const retry = `https://www.twse.com.tw/fund/T86?response=json&date=${today}&selectType=ALLBUT0999`;
    try {
      const res = await fetch(retry, FETCH_OPTS);
      if (res.ok) {
        console.log(`[proxy] TWSE T86 retry OK: ${retry}`);
        return wrapResponse(res);
      }
      console.log(`[proxy] TWSE T86 retry failed: ${res.status}`);
    } catch (e) {
      console.log(`[proxy] TWSE T86 retry error: ${e.message}`);
    }
  }
  if (path.includes('MI_MARGN')) {
    console.log('[proxy] MI_MARGN 307，無備用路徑');
  }
  return null;
}

async function _tpexFallback(targetUrl) {
  try {
    const res = await fetch(targetUrl.toString(), {
      headers: FETCH_OPTS.headers,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      console.log(`[proxy] TPEx fallback: got ${res.status} redirect, giving up`);
      return null;
    }
    if (res.ok) return wrapResponse(res);
    console.log(`[proxy] TPEx fallback: ${res.status}`);
  } catch (e) {
    console.log(`[proxy] TPEx fallback error: ${e.message}`);
  }
  return null;
}

// ─── K線快取 key（Yahoo）─────────────────────────────────────────────────────
// key 格式：yahoo:{symbol}:{period}，例 yahoo:2330.TW:1y
// ★ 1mo/3mo/6mo 全部 map 到 1y（1y 日K包含所有短期資料）；前端拿到後自己截區間
// ※ R2 與 KV 共用同一 key 格式，GAS 寫的 key 也是這個 → 兩邊對齊
function _yahooKvKey(targetUrl) {
  const pathParts = targetUrl.pathname.split('/');
  const symbol    = pathParts[pathParts.length - 1];  // 2330.TW
  const range     = targetUrl.searchParams.get('range') || '1y';
  const kvRange   = ['1mo', '3mo', '6mo'].includes(range) ? '1y' : range;
  return `yahoo:${symbol}:${kvRange}`;
}

// ─── R2 快取工具（Yahoo K線）─────────────────────────────────────────────────
// 讀取順序：Cache API（邊緣，最快）→ R2 物件 → 新鮮度檢查
// 新鮮度沿用舊 KV 行為：盤中 10 分鐘、盤後 24 小時（用 customMetadata.ts 判斷）
async function _r2GetYahoo(env, targetUrl, ctx) {
  try {
    const key      = _yahooKvKey(targetUrl);
    const cache    = caches.default;
    const cacheKey = new Request('https://kline-cache.internal/' + encodeURIComponent(key));

    // 1. 邊緣快取（命中最快，等同舊 KV 熱 key 速度）
    const edge = await cache.match(cacheKey);
    if (edge) return edge;

    // 2. R2
    const obj = await env.KLINE_R2.get(key);
    if (!obj) return null;

    // 3. 新鮮度（過期回 null，讓上層重抓 Yahoo）
    const ts             = Number(obj.customMetadata?.ts || 0);
    const hTW            = (new Date().getUTCHours() + 8) % 24;
    const isTradingHours = hTW >= 9 && hTW < 14;
    const maxAgeMs       = isTradingHours ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (ts && (Date.now() - ts) > maxAgeMs) return null;

    const body = await obj.text();
    const resp = new Response(body, {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               isTradingHours ? 'public, max-age=120' : 'public, max-age=1800',
        'X-R2-Cache':                  'HIT',
      },
    });
    // 4. 寫進邊緣快取，下次重讀走 Cache API（追平 KV 速度）
    if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return null;
  }
}

// 把 Yahoo 回應寫進 R2（cache miss 時的 on-demand 回填；customMetadata 記時間）
async function _r2PutYahoo(env, targetUrl, res) {
  try {
    const key    = _yahooKvKey(targetUrl);
    const body   = await res.text();
    const parsed = JSON.parse(body);
    if (!parsed?.chart?.result?.[0]?.indicators) return;
    await env.KLINE_R2.put(key, body, { customMetadata: { ts: String(Date.now()) } });
  } catch (e) {
    // 寫入失敗不影響主流程
  }
}

// ─── 舊 KV 快取工具（未綁 R2 時的 fallback，保留以利過渡/回滾）──────────────
async function _kvGetYahoo(kv, targetUrl) {
  try {
    const key  = _yahooKvKey(targetUrl);
    const data = await kv.get(key);
    if (!data) return null;
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=300',
        'X-KV-Cache':                  'HIT',
      },
    });
  } catch (e) {
    return null;
  }
}

async function _kvPutYahoo(kv, targetUrl, res) {
  try {
    const key  = _yahooKvKey(targetUrl);
    const body = await res.text();
    const parsed = JSON.parse(body);
    if (!parsed?.chart?.result?.[0]?.indicators) return;
    const now    = new Date();
    const hTW    = (now.getUTCHours() + 8) % 24;
    const isTradingHours = hTW >= 9 && hTW < 14;
    const ttl    = isTradingHours ? 600 : 86400;
    await kv.put(key, body, { expirationTtl: ttl });
  } catch (e) {
    // 寫入失敗不影響主流程
  }
}

// ─── 工具函式 ─────────────────────────────────────────────────────────────────
async function wrapResponse(upstream) {
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=10',
    },
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errResponse(msg, status = 500) {
  return new Response(msg, {
    status,
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}
