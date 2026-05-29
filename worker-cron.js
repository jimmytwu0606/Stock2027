// worker-cron.js
// ============================================================================
// stock-cron-2027 — 盤後資料定時抓取 Worker
// ============================================================================
// Cron 時間表（UTC）：
//   0 6 * * 1-5   → 台灣 14:00 全市場價格（TWSE + TPEx）
//   45 6 * * 1-5  → 台灣 14:45 三大法人
//   0 7 * * 1-5   → 台灣 15:00 處置股/注意股
//   30 7 * * 1-5  → 台灣 15:30 蒙地卡羅預測 + 歷史驗證
//
// 環境變數（Worker Secrets）：
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//
// KV Binding：
//   KV → STOCK_CRON_KV（存 FINMIND_TOKEN 等，唯讀，0 寫入）
//
// 修正記錄：
// 2026-05-29  移除 runKlineCache（14:30 UTC）
//             原因：①與 GAS kline_to_r2.gs 重複（GAS 已接手 K線 → R2）
//                   ②免費 Worker scheduled trigger 上限 ~30 秒，
//                     全市場 2000 檔 × 1.5s 批次延遲 ≈ 900 秒，一直在 timeout
//                   ③每天寫 ~2000 key 到 KLINE_CACHE KV，是 KV 1000 writes/天
//                     免費額度爆表的元凶，導致中文名每天變英文
//             K 線快取由 GAS（盤後一次）→ Worker /r2put → R2 全權負責
// ============================================================================

export default {
  // HTTP 請求入口（手動測試用）
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/run/prices') {
      await runPrices(env);
      return new Response('prices done', { status: 200 });
    }
    if (path === '/run/chips') {
      await runChips(env);
      return new Response('chips done', { status: 200 });
    }
    if (path === '/run/disposal') {
      await runDisposal(env);
      return new Response('disposal done', { status: 200 });
    }
    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path === '/test/write') {
      await _fsSet(env, 'test/ping', { ok: true, ts: Date.now() });
      return new Response('test write OK', { status: 200 });
    }
    if (path === '/run/limitup') {
      const date = url.searchParams.get('date') || null;
      await runLimitUp(env, date);
      return new Response('limitup done', { status: 200 });
    }
    if (path === '/run/commentary') {
      await runCommentary(env);
      return new Response('commentary done', { status: 200 });
    }
    if (path === '/run/revenue') {
      await runRevenue(env);
      return new Response('revenue done', { status: 200 });
    }
    if (path === '/run/eps') {
      await runEPS(env);
      return new Response('eps done', { status: 200 });
    }
    if (path === '/run/dividend') {
      await runDividend(env);
      return new Response('dividend done', { status: 200 });
    }
    // ★ /run/kline 已移除（K線改由 GAS → R2，見修正記錄）
    if (path === '/run/kline') {
      return new Response('K線快取已由 GAS kline_to_r2 接手，此路由停用', { status: 410 });
    }
    if (path === '/run/mc') {
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const limit  = 500;
      await runMcPredictAndVerify(env, offset, limit);
      return new Response(`mc done (offset=${offset}, limit=${limit})`, { status: 200 });
    }
    if (path === '/debug/prices') {
      const today = _today();
      const snap  = await _fsGetShared(env, `market/${today}/prices`);
      if (!snap) return new Response('snap is null', { status: 200 });
      const dataType = typeof snap.data;
      const dataLen  = snap.data ? String(snap.data).length : 0;
      const preview  = snap.data ? String(snap.data).slice(0, 200) : 'empty';
      return new Response(JSON.stringify({ dataType, dataLen, preview }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('stock-cron-2027 is running', { status: 200 });
  },

  // Cron 定時觸發
  async scheduled(event, env, ctx) {
    const t   = new Date(event.scheduledTime);
    const hour = t.getUTCHours();
    const min  = t.getUTCMinutes();
    const day  = t.getUTCDate();
    const mon  = t.getUTCMonth() + 1;

    console.log(`[cron] triggered at UTC ${hour}:${String(min).padStart(2,'0')}`);

    // 06:00 UTC = 台灣 14:00 → 全市場價格
    if (hour === 6 && min === 0) {
      await runPrices(env);
    }
    // ★ 06:30 UTC（台灣 14:30）→ runKlineCache 已移除，K線由 GAS 負責
    // 06:45 UTC = 台灣 14:45 → 三大法人
    else if (hour === 6 && min === 45) {
      await runChips(env);
    }
    // 07:00 UTC = 台灣 15:00 → 處置股
    else if (hour === 7 && min === 0) {
      await runDisposal(env);
    }
    // 07:30 UTC = 台灣 15:30 → 蒙地卡羅預測 + 歷史驗證
    else if (hour === 7 && min === 30) {
      await runMcPredictAndVerify(env, 0, 0);
    }
    // 06:15 UTC = 台灣 14:15 → 漲停族群
    else if (hour === 6 && min === 15) {
      await runLimitUp(env);
    }
    // 06:20 UTC = 台灣 14:20 → 盤面摘要
    else if (hour === 6 && min === 20) {
      await runCommentary(env);
    }
    // 02:00 UTC = 台灣 10:00 → 月營收（每月 11 日）
    else if (hour === 2 && min === 0 && day === 11) {
      await runRevenue(env);
    }
    // 02:00 UTC = 台灣 10:00 → EPS（3/15, 5/15, 8/15, 11/15）
    else if (hour === 2 && min === 0 && day === 15 && [3, 5, 8, 11].includes(mon)) {
      await runEPS(env);
    }
    // 02:00 UTC = 台灣 10:00 → 除息/除權（配息季 3-8 月每日）
    else if (hour === 2 && min === 0 && mon >= 3 && mon <= 8) {
      await runDividend(env);
    }
  },
};

// ============================================================================
// 任務 1 — 全市場價格（TWSE + TPEx）
// ============================================================================
async function runPrices(env) {
  console.log('[cron] runPrices start');
  const today = _today();
  const map = {};

  try {
    const json = JSON.parse(await _fetch('https://opendata.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 20000));
    let rows;
    if (Array.isArray(json)) {
      rows = json.map(r => ({
        code:  r.Code,
        name:  r.Name ?? '',
        close: parseFloat(String(r.ClosingPrice ?? '').replace(/,/g, '')),
        prev:  parseFloat(String(r.YesterdayClosingPrice ?? r.ClosingPrice).replace(/,/g, '')),
        vol:   parseFloat(String(r.TradeVolume ?? '0').replace(/,/g, '')),
      }));
    } else if (json.stat === 'OK' && Array.isArray(json.data)) {
      rows = json.data.map(r => {
        const close  = parseFloat(String(r[7] ?? '').replace(/,/g, ''));
        const diff   = parseFloat(String(r[8] ?? '0').replace(/,/g, ''));
        const prev   = isNaN(diff) ? close : close - diff;
        const vol    = parseFloat(String(r[2] ?? '0').replace(/,/g, ''));
        return { code: r[0], name: r[1] ?? '', close, prev, vol };
      });
    } else {
      throw new Error('TWSE: unknown response format');
    }

    for (const r of rows) {
      if (!r.code) continue;
      const price = r.close;
      if (isNaN(price) || price <= 0) continue;
      const prev   = isNaN(r.prev) ? price : r.prev;
      const change = price - prev;
      const chgPct = prev > 0 ? (change / prev * 100) : 0;
      const vol    = Math.round(r.vol / 1000);
      map[r.code] = {
        name:   r.name,
        price:  +price.toFixed(2),
        prev:   +prev.toFixed(2),
        chgPct: +chgPct.toFixed(2),
        vol,
        market: 'twse',
      };
    }
    console.log(`[cron] TWSE loaded ${Object.keys(map).length} stocks`);
  } catch (e) {
    console.error('[cron] TWSE failed:', e.message);
  }

  try {
    const rows = JSON.parse(await _fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', 20000));
    for (const r of rows) {
      const code = r.SecuritiesCompanyCode;
      if (!code) continue;
      const price = parseFloat(String(r.Close ?? '').replace(/,/g, ''));
      if (isNaN(price) || price <= 0) continue;
      const change = parseFloat(String(r.Change ?? '0').trim().replace(/,/g, ''));
      const prev   = price - (isNaN(change) ? 0 : change);
      const chgPct = prev > 0 ? (change / prev * 100) : 0;
      const vol    = Math.round(parseFloat(String(r.TradingShares ?? '0').replace(/,/g, '')) / 1000);
      map[code] = {
        name:   r.CompanyName ?? '',
        price:  +price.toFixed(2),
        prev:   +prev.toFixed(2),
        chgPct: +chgPct.toFixed(2),
        vol,
        market: 'tpex',
      };
    }
    console.log(`[cron] TPEx loaded, total ${Object.keys(map).length} stocks`);
  } catch (e) {
    console.warn('[cron] TPEx failed (will use TWSE only):', e.message);
  }

  if (Object.keys(map).length === 0) {
    console.warn('[cron] runPrices: no data at all, skip write');
    return;
  }

  await _fsSet(env, `market/${today}/prices`, { data: map, updatedAt: Date.now() });
  console.log(`[cron] runPrices done → market/${today}/prices (${Object.keys(map).length} stocks)`);

  try {
    const entries = Object.entries(map)
      .filter(([, info]) => info.name)
      .map(([code, info]) => [code, info.name]);
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batchNum = Math.floor(i / BATCH);
      await _fsSet(env, `names/batch${batchNum}`, {
        data: Object.fromEntries(entries.slice(i, i + BATCH)),
        updatedAt: Date.now(),
      });
    }
    const totalBatches = Math.ceil(entries.length / BATCH);
    await _fsSet(env, 'names/meta', { total: entries.length, batches: totalBatches, updatedAt: Date.now() });
    console.log(`[cron] names written → ${entries.length} stocks in ${totalBatches} batches`);
  } catch (e) {
    console.warn('[cron] names write failed:', e.message);
  }

  await _cleanOldDates(env, 'market', 90);
}

// ============================================================================
// 任務 2 — 三大法人（TWSE）
// ============================================================================
async function runChips(env) {
  console.log('[cron] runChips start');
  const today = _today();

  try {
    const date  = today.replace(/-/g, '');
    const rawUrl = `https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`;
    const json = JSON.parse(await _fetch(rawUrl, 20000));

    if (!json.data || json.stat !== 'OK') {
      console.warn('[cron] runChips: no data from TWSE');
      return;
    }

    const chips = {};
    for (const row of json.data) {
      const code = row[0]?.trim();
      if (!code) continue;
      chips[code] = {
        foreign: _parseInt(row[4]),
        invest:  _parseInt(row[10]),
        dealer:  _parseInt(row[16]),
        total:   _parseInt(row[4]) + _parseInt(row[10]) + _parseInt(row[16]),
      };
    }

    await _fsSet(env, `market/${today}/chips`, { data: chips, updatedAt: Date.now() });
    console.log(`[cron] runChips done → ${Object.keys(chips).length} stocks`);
  } catch (e) {
    console.error('[cron] runChips failed:', e.message);
  }
}

// ============================================================================
// 任務 3 — 處置股 / 注意股
// ============================================================================
async function runDisposal(env) {
  console.log('[cron] runDisposal start');
  const today = _today();

  const endpoints = [
    'https://opendata.twse.com.tw/v1/exchangeReport/BFIAUU',
    'https://opendata.twse.com.tw/v1/exchangeReport/TWT93U',
    `https://www.twse.com.tw/exchangeReport/BFIAUU?response=json&date=${today.replace(/-/g, '')}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const text = await _fetch(endpoint, 15000);
      let rows;
      try { rows = JSON.parse(text); } catch { continue; }
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const disposal = rows.map(r => ({
        code: r.Code ?? r['證券代號'] ?? '',
        name: r.Name ?? r['證券名稱'] ?? '',
        type: r['處置原因'] ?? r['注意原因'] ?? '',
      })).filter(r => r.code);

      await _fsSet(env, `market/${today}/disposal`, { data: disposal, updatedAt: Date.now() });
      console.log(`[cron] runDisposal done → ${disposal.length} stocks`);
      return;
    } catch (e) {
      console.warn(`[cron] runDisposal: ${endpoint} failed → ${e.message}`);
    }
  }
  console.error('[cron] runDisposal: all endpoints failed');
}

// ============================================================================
// 任務 4 — 月營收
// ============================================================================
async function runRevenue(env) {
  console.log('[cron] runRevenue start');

  const now    = new Date();
  const lastMon = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const rocYear = lastMon.getFullYear() - 1911;
  const month   = lastMon.getMonth() + 1;
  const yearMonth = `${lastMon.getFullYear()}-${String(month).padStart(2, '0')}`;

  const urls = [
    `https://mops.twse.com.tw/nas/t21/sii/t21sc03_${rocYear}_${month}_0.csv`,
    `https://mops.twse.com.tw/nas/t21/otc/t21sc03_${rocYear}_${month}_0.csv`,
  ];

  const byCode = {};

  for (const url of urls) {
    try {
      const proxyUrl = `${CORS_PROXY}${encodeURIComponent(url)}`;
      const res  = await fetch(proxyUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const lines = text.split('\n');
      for (const line of lines) {
        const cols = line.split(',').map(s => s.trim().replace(/"/g, ''));
        const code = cols[0];
        if (!code || !/^\d{4,6}$/.test(code)) continue;
        const revenue = parseInt(cols[2]?.replace(/,/g, '') ?? '0') || 0;
        if (revenue <= 0) continue;
        const mom = parseFloat(cols[5]) || null;
        const yoy = parseFloat(cols[6]) || null;
        byCode[code] = [{ date: `${yearMonth}-10`, revenue, mom, yoy }];
      }
    } catch (e) {
      console.warn(`[cron] runRevenue fetch failed: ${url}`, e.message);
    }
  }

  const codes = Object.keys(byCode);
  if (!codes.length) {
    console.warn('[cron] runRevenue: no data parsed');
    return;
  }

  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    await Promise.allSettled(chunk.map(code =>
      _fsSet(env, `stocks/${code}/revenue`, {
        data: JSON.stringify(byCode[code]),
        yearMonth,
        updatedAt: Date.now(),
      })
    ));
  }
  console.log(`[cron] runRevenue done → ${yearMonth}, ${codes.length} stocks`);
}

// ============================================================================
// 任務 5 — EPS（未實作）
// ============================================================================
async function runEPS(env) {
  console.log('[cron] runEPS: 暫未實作，skip');
}

// ============================================================================
// 任務 6 — 除息/除權
// ============================================================================
async function runDividend(env) {
  console.log('[cron] runDividend start');
  const year = new Date().getFullYear();

  try {
    const url  = 'https://opendata.twse.com.tw/v1/exchangeReport/TWT48U';
    const text = await _fetch(url, 20000);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || !rows.length) {
      console.warn('[cron] runDividend: no data');
      return;
    }

    const byCode = {};
    for (const r of rows) {
      const code = r['Code'] ?? r['股票代號'] ?? '';
      if (!code) continue;
      if (!byCode[code]) byCode[code] = [];
      byCode[code].push({
        exdivDate:   r['除息交易日'] ?? '',
        exrightDate: r['除權交易日'] ?? '',
        cashDiv:     parseFloat(r['現金股利'] ?? '0') || 0,
        stockDiv:    parseFloat(r['股票股利'] ?? '0') || 0,
      });
    }

    const codes = Object.keys(byCode);
    for (let i = 0; i < codes.length; i += 50) {
      const chunk = codes.slice(i, i + 50);
      await Promise.allSettled(chunk.map(code =>
        _fsSet(env, `stocks/${code}/dividend`, {
          data: JSON.stringify(byCode[code]),
          year,
          updatedAt: Date.now(),
        })
      ));
    }
    console.log(`[cron] runDividend done → ${codes.length} stocks`);
  } catch (e) {
    console.error('[cron] runDividend failed:', e.message);
  }
}

// ── FinMind Token ──────────────────────────────────────────────────────────
async function _getFinMindToken(env) {
  if (env.FINMIND_TOKEN) return env.FINMIND_TOKEN;
  try { const t = await env.KV?.get('FINMIND_TOKEN'); if (t) return t; } catch {}
  return null;
}

// ============================================================================
// 任務 A4-1 — 漲停族群
// ============================================================================
async function runLimitUp(env, forceDate = null) {
  const today = forceDate || _today();
  console.log(`[cron] runLimitUp start → ${today}`);

  try {
    const snap = await _fsGetShared(env, `market/${today}/prices`);
    if (!snap?.data) { console.warn('[cron] runLimitUp: no prices data'); return; }

    const priceMap = typeof snap.data === 'string' ? JSON.parse(snap.data) : snap.data;

    const limitUpStocks = Object.entries(priceMap)
      .filter(([, r]) => r.chgPct >= 9.5)
      .map(([code, r]) => ({
        code,
        name:    r.name ?? '',
        price:   r.price,
        chgPct:  r.chgPct,
        vol:     r.vol ?? 0,
        sector:  _sectorByCode(code),
        market:  r.market ?? 'twse',
      }));

    const bySector = {};
    for (const s of limitUpStocks) {
      if (!bySector[s.sector]) bySector[s.sector] = [];
      bySector[s.sector].push(s);
    }

    const sectorRank = Object.entries(bySector)
      .map(([sector, stocks]) => ({ sector, count: stocks.length, stocks }))
      .sort((a, b) => b.count - a.count);

    const result = {
      date:       today,
      total:      limitUpStocks.length,
      sectorRank,
      updatedAt:  Date.now(),
    };

    await _fsSet(env, `market/${today}/limit_up`, { data: JSON.stringify(result), updatedAt: Date.now() });
    console.log(`[cron] runLimitUp done → ${limitUpStocks.length} stocks, ${sectorRank.length} sectors`);
  } catch (e) {
    console.error('[cron] runLimitUp failed:', e.message);
  }
}

function _sectorByCode(code) {
  const n = parseInt(code);
  if (n >= 2300 && n <= 2399) return '半導體';
  if (n >= 2400 && n <= 2499) return '光電';
  if (n >= 2500 && n <= 2599) return '電腦週邊';
  if (n >= 2600 && n <= 2699) return '通信網路';
  if (n >= 2700 && n <= 2799) return '電子零組件';
  if (n >= 2800 && n <= 2899) return '金融';
  if (n >= 2900 && n <= 2999) return '貿易百貨';
  if (n >= 3000 && n <= 3099) return '電子零組件';
  if (n >= 3100 && n <= 3199) return '其他電子';
  if (n >= 1300 && n <= 1499) return '塑化';
  if (n >= 1500 && n <= 1699) return '機電';
  if (n >= 1700 && n <= 1799) return '紡織';
  if (n >= 1800 && n <= 1999) return '食品';
  if (n >= 2000 && n <= 2099) return '鋼鐵';
  if (n >= 2100 && n <= 2199) return '汽車';
  if (n >= 2200 && n <= 2299) return '航運';
  if (n >= 4000 && n <= 4999) return '建材營造';
  if (n >= 5000 && n <= 5999) return '航運';
  if (n >= 6000 && n <= 6999) return '電子';
  if (n >= 8000 && n <= 8999) return '其他';
  return '其他';
}

// ============================================================================
// 任務 A4-2 — 盤面摘要
// ============================================================================
async function runCommentary(env) {
  console.log('[cron] runCommentary start');
  const today = _today();

  try {
    const [priceSnap, limitSnap] = await Promise.all([
      _fsGetShared(env, `market/${today}/prices`),
      _fsGetShared(env, `market/${today}/limit_up`),
    ]);

    if (!priceSnap?.data) { console.warn('[cron] runCommentary: no prices'); return; }

    const priceMap  = typeof priceSnap.data === 'string' ? JSON.parse(priceSnap.data) : priceSnap.data;
    const limitData = limitSnap?.data ? (typeof limitSnap.data === 'string' ? JSON.parse(limitSnap.data) : limitSnap.data) : null;

    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
    for (const r of Object.values(priceMap)) {
      if (r.chgPct > 0) up++;
      else if (r.chgPct < 0) down++;
      else flat++;
      if (r.chgPct >= 9.5)  limitUp++;
      if (r.chgPct <= -9.5) limitDown++;
    }

    const topSector  = limitData?.sectorRank?.[0]?.sector ?? null;
    const limitTotal = limitData?.total ?? limitUp;
    const bias       = up > down * 1.5 ? '買氣偏多' : down > up * 1.5 ? '賣壓偏重' : '多空分歧';
    const sectorTxt  = topSector ? `，${topSector}族群為今日強勢主軸` : '';

    const commentary = `今日市場${bias}，` +
      `漲跌家數 ${up}:${down}，` +
      `漲停 ${limitTotal} 檔、跌停 ${limitDown} 檔${sectorTxt}。`;

    await _fsSet(env, `market/${today}/commentary`, {
      text:      commentary,
      stats:     JSON.stringify({ up, down, flat, limitUp: limitTotal, limitDown }),
      updatedAt: Date.now(),
    });
    console.log(`[cron] runCommentary done → "${commentary}"`);
  } catch (e) {
    console.error('[cron] runCommentary failed:', e.message);
  }
}

// ============================================================================
// 任務 5 — 蒙地卡羅預測 + 歷史驗證
// ============================================================================
const MC_FORMULA_VERSION = 'v1.5';
const MC_N_PATHS_CRON = 100;
const MC_N_PATHS_HTTP = 10;
const MC_SIM_BARS     = [5, 10, 15, 20];

async function runMcPredictAndVerify(env, offset = 0, limit = 0) {
  const isCron = limit === 0;
  const nPaths = isCron ? MC_N_PATHS_CRON : MC_N_PATHS_HTTP;
  console.log(`[mc] start offset=${offset} limit=${limit||'全量'} paths=${nPaths}`);
  const today = _today();

  const todayPrices = await _fsGetShared(env, `market/${today}/prices`);
  if (!todayPrices?.data) {
    console.warn('[mc] 今天收盤價尚未寫入，跳過');
    return;
  }
  const priceMap = typeof todayPrices.data === 'string'
    ? JSON.parse(todayPrices.data)
    : todayPrices.data;

  let codes = Object.keys(priceMap);
  if (limit > 0) codes = codes.slice(offset, offset + limit);
  else if (offset > 0) codes = codes.slice(offset);
  console.log(`[mc] 共 ${codes.length} 檔股票需要處理`);

  const HISTORY_DAYS = 30;
  const dateList = _pastDates(HISTORY_DAYS + 10);
  const priceHistory = {};
  let historyFetched = 0;

  for (const date of dateList) {
    if (date >= today) continue;
    if (historyFetched >= HISTORY_DAYS) break;
    try {
      const snap = await _fsGetShared(env, `market/${date}/prices`);
      if (!snap?.data) continue;
      historyFetched++;
      const dayMap = typeof snap.data === 'string' ? JSON.parse(snap.data) : snap.data;
      for (const code of codes) {
        if (!dayMap[code]?.price) continue;
        if (!priceHistory[code]) priceHistory[code] = [];
        priceHistory[code].push(dayMap[code].price);
      }
    } catch (e) {}
  }
  console.log(`[mc] 歷史資料：讀取 ${historyFetched} 個交易日`);

  const mcToday = {};

  for (const code of codes) {
    const prices     = priceHistory[code] || [];
    const startPrice = priceMap[code]?.price;
    if (!startPrice) continue;

    const fullPrices = [...prices];
    if (fullPrices[fullPrices.length - 1] !== startPrice) fullPrices.push(startPrice);

    const result = _runMC(fullPrices, startPrice, nPaths);
    if (!result) continue;

    mcToday[code] = {
      start:   +startPrice.toFixed(2),
      formula: MC_FORMULA_VERSION,
      pred5:      +result.pred[5].toFixed(2),
      predChg5:   +result.chg[5].toFixed(4),
      dir5:       result.dir[5],
      pred10:     +result.pred[10].toFixed(2),
      predChg10:  +result.chg[10].toFixed(4),
      dir10:      result.dir[10],
      pred15:     +result.pred[15].toFixed(2),
      predChg15:  +result.chg[15].toFixed(4),
      dir15:      result.dir[15],
      pred20:     +result.pred[20].toFixed(2),
      predChg20:  +result.chg[20].toFixed(4),
      dir20:      result.dir[20],
      actual5: null,  hit5: null,  actualChg5: null,
      actual10: null, hit10: null, actualChg10: null,
      actual15: null, hit15: null, actualChg15: null,
      actual20: null, hit20: null, actualChg20: null,
    };
  }

  const VERIFY_BARS = limit > 0 ? [] : [5, 10, 15, 20];
  for (const N of VERIFY_BARS) {
    const pastDate = await _findNthTradingDayBefore(env, today, N);
    if (!pastDate) continue;

    try {
      const pastDoc = await _fsGetShared(env, `market/${pastDate}/mc`);
      if (!pastDoc?.data) continue;
      const pastMc = typeof pastDoc.data === 'string' ? JSON.parse(pastDoc.data) : pastDoc.data;

      let updated = false;
      for (const code of codes) {
        const rec = pastMc[code];
        if (!rec) continue;
        const key = `hit${N}`;
        if (rec[key] !== null && rec[key] !== undefined) continue;

        const actualPrice = priceMap[code]?.price;
        if (!actualPrice) continue;

        const actualChg = (actualPrice - rec.start) / rec.start;
        const predDir   = rec[`dir${N}`];
        const actualDir = actualChg >= 0 ? 'bull' : 'bear';
        const dirHit    = predDir === actualDir;
        const predChg   = rec[`predChg${N}`] ?? 0;
        const chgErr    = Math.abs(actualChg - predChg);
        const hit       = dirHit && chgErr < 0.05;

        pastMc[code][`actual${N}`]    = +actualPrice.toFixed(2);
        pastMc[code][`actualChg${N}`] = +actualChg.toFixed(4);
        pastMc[code][`hit${N}`]       = hit;
        updated = true;
      }

      if (updated) {
        await _fsSet(env, `market/${pastDate}/mc`, { data: JSON.stringify(pastMc), updatedAt: Date.now() });
        console.log(`[mc] 驗證回填完成 → market/${pastDate}/mc (N=${N})`);
      }
    } catch (e) {
      console.warn(`[mc] 驗證 N=${N} 失敗:`, e.message);
    }
  }

  if (Object.keys(mcToday).length === 0) {
    console.warn('[mc] 沒有任何股票完成預測，跳過寫入');
    return;
  }

  const BATCH_SIZE   = 500;
  const allCodes     = Object.keys(mcToday);
  const totalBatches = Math.ceil(allCodes.length / BATCH_SIZE);

  for (let b = 0; b < totalBatches; b++) {
    const batchCodes = allCodes.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const batchData  = {};
    for (const code of batchCodes) batchData[code] = mcToday[code];

    const batchNum = Math.floor(offset / BATCH_SIZE) + b;
    await _fsSet(env, `market/${today}/mc--${batchNum}`, {
      data:      JSON.stringify(batchData),
      formula:   MC_FORMULA_VERSION,
      updatedAt: Date.now(),
    });
    console.log(`[mc] 寫入 mc--${batchNum}，${batchCodes.length} 檔`);
  }

  try {
    const metaKey    = `market/${today}/mc--meta`;
    const existing   = await _fsGetShared(env, metaKey);
    const prevBatches = existing?.batches ?? 0;
    const newBatches  = Math.floor(offset / BATCH_SIZE) + totalBatches;
    await _fsSet(env, metaKey, {
      batches:   Math.max(prevBatches, newBatches),
      formula:   MC_FORMULA_VERSION,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.warn('[mc] meta 更新失敗:', e.message);
  }

  console.log(`[mc] 全部完成，共 ${allCodes.length} 檔，${totalBatches} 個批次`);
}

function _runMC(prices, startPrice, nPaths = 100) {
  try {
    const N = prices.length;
    const logRets = [];
    for (let i = 1; i < N; i++) logRets.push(Math.log(prices[i] / prices[i - 1]));

    const DEFAULT_STD  = 0.016;
    const DEFAULT_MEAN = 0.0003;

    const mean     = logRets.length > 0 ? logRets.reduce((s, r) => s + r, 0) / logRets.length : DEFAULT_MEAN;
    const variance = logRets.length > 1 ? logRets.reduce((s, r) => s + (r - mean) ** 2, 0) / logRets.length : DEFAULT_STD ** 2;
    const stdDev   = Math.sqrt(variance) || DEFAULT_STD;

    const recentN    = Math.max(1, Math.min(10, logRets.length - 1));
    const recentRets = logRets.length > 1 ? logRets.slice(-recentN) : [];
    const recentMean = recentRets.length > 0 ? recentRets.reduce((s, r) => s + r, 0) / recentRets.length : mean;

    const annualVol  = stdDev * Math.sqrt(252) * 100;
    const betaCoeff  = annualVol > 40 ? 0.92 : 1.0;
    const finalStd   = stdDev * betaCoeff;

    let driftPerBar = recentMean * 0.45 + mean * 0.55;
    const cap = finalStd * 0.4;
    driftPerBar = Math.max(-cap, Math.min(cap, driftPerBar));

    const pred = {}, chg = {}, dir = {};
    for (const N of MC_SIM_BARS) {
      const med  = startPrice * Math.exp(driftPerBar * N);
      pred[N]    = med;
      chg[N]     = (med - startPrice) / startPrice;
      dir[N]     = med >= startPrice ? 'bull' : 'bear';
    }
    return { pred, chg, dir };
  } catch (e) {
    console.warn('[mc] _runMC error:', e.message);
    return null;
  }
}

async function _findNthTradingDayBefore(env, fromDate, N) {
  try {
    const candidates = _pastDates(N + 15, fromDate);
    let count = 0;
    for (const d of candidates) {
      if (d >= fromDate) continue;
      const snap = await _fsGetShared(env, `market/${d}/prices`);
      if (snap?.data) {
        count++;
        if (count >= N) return d;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// Firestore REST API 輔助
// ============================================================================
async function _fsGetShared(env, docPath) {
  try {
    const token     = await _getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const safeKey   = docPath.replace(/\//g, '--');
    const url       = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/shared/${encodeURIComponent(safeKey)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return null;
    const body   = await res.json();
    const fields = body.fields ?? {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v.stringValue  !== undefined) out[k] = v.stringValue;
      else if (v.doubleValue  !== undefined) out[k] = v.doubleValue;
      else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
      else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
      else if (v.nullValue    !== undefined) out[k] = null;
    }
    return out;
  } catch (e) {
    return null;
  }
}

function _pastDates(n, fromDate) {
  const dates = [];
  const base  = fromDate ? new Date(fromDate) : new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

let _cachedToken = null;
let _tokenExpiry = 0;

async function _getFirebaseToken(env) {
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) return _cachedToken;

  const projectId   = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  };

  const b64 = obj => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const sigInput = `${b64(header)}.${b64(payload)}`;

  const keyData = privateKey
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const encoder   = new TextEncoder();
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(sigInput));
  const sig       = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${sigInput}.${sig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return _cachedToken;
}

async function _fsSet(env, docPath, data) {
  const token     = await _getFirebaseToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/shared/${encodeURIComponent(docPath.replace(/\//g, '--'))}`;
  const fields = _toFirestoreFields(data);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore write failed: ${res.status} ${err}`);
  }
}

function _toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')       fields[k] = { stringValue: v };
    else if (typeof v === 'number')  fields[k] = { doubleValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (v === null)             fields[k] = { nullValue: null };
    else                             fields[k] = { stringValue: JSON.stringify(v) };
  }
  return fields;
}

async function _cleanOldDates(env, collection, keepDays) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    console.log(`[cron] cleanup: remove ${collection}/* before ${cutoff.toISOString().slice(0, 10)}`);
  } catch (e) {
    console.warn('[cron] cleanup failed:', e.message);
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────
function _today() { return new Date().toISOString().slice(0, 10); }
function _parseInt(str) {
  if (!str) return 0;
  return parseInt(String(str).replace(/,/g, ''), 10) || 0;
}

const CORS_PROXY = 'https://stock-2027.luffy0606.workers.dev/?url=';

async function _fetch(url, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const text = await res.text();
      if (!text.includes('error code: 530') && !text.includes('Too Many Requests')) return text;
    }
  } catch (e) {}

  if (url.includes('opendata.twse.com.tw')) {
    const reportName = url.split('/').pop().split('?')[0];
    const fb = `https://www.twse.com.tw/exchangeReport/${reportName}?response=json`;
    try {
      const res2 = await fetch(fb, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, */*',
          'Referer': 'https://www.twse.com.tw/',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res2.ok) {
        console.log(`[cron] TWSE fallback OK: ${fb}`);
        return res2.text();
      }
    } catch (e) {
      console.warn(`[cron] TWSE fallback failed: ${e.message}`);
    }
  }

  throw new Error(`fetch failed: ${url}`);
}

function _daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function _toQuarter(dateStr) {
  if (!dateStr) return '';
  const m = parseInt(dateStr.slice(5, 7), 10);
  return `${dateStr.slice(0, 4)}Q${Math.ceil(m / 3)}`;
}
