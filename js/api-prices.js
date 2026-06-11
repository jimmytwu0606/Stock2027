/**
 * api-prices.js — 全市場價格 / MIS 即時報價
 */
import { getFinMindToken } from './config.js';
import { fsGetShared } from './firebase.js';
import { fetchWithProxy, toYahooSymbol, _otcSet } from './api-core.js';
import { _namesCacheGet, _namesCacheSet } from './api-cache.js';
import { _nameCache } from './api-names.js';


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
  if (rtData && typeof rtData === 'object' && Object.keys(rtData).length >= 1500) {
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
