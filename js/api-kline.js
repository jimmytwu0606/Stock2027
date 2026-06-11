/**
 * api-kline.js — K 線 / 報價 / 篩選批次 / R2 bundle 預載
 */
import { getDataSource, getFinMindToken } from './config.js';
import { getKlineCache, setKlineCache, bulkSetKlineCache, countKlineCache } from './db.js';
import { fsGetShared } from './firebase.js';
import { fetchWithProxy, fetchScreener, _looksLikeRateLimit, toYahooSymbol, _otcSet,
         SELF_PROXY, PROXY_TOKEN, _WORKER_ORIGIN, FEATURE_INTRADAY_5M } from './api-core.js';
import { _namesCacheGet, _namesCacheSet } from './api-cache.js';


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
            // ⚠️ 踩雷備忘（2026-06-02）：
            //   盤後 GAS 寫入 R2 後，前端從 R2 拿到今天的資料存進 IndexedDB，validUntil 設到今天 23:59。
            //   但 _lastTradingDayTs() 回今天開盤時間，lastCandleTime 是今天收盤 → 仍觸發「缺最近交易日」重抓。
            //   修法：validUntil 是今天設的（同一天），代表今天已經更新過，直接回傳不再重抓。
            const validUntilDate = new Date(cached.validUntil).toDateString();
            const todayDate = new Date().toDateString();
            const isFreshToday = validUntilDate === todayDate;
            if (isIndexSymbol || isFreshToday) {
              return cached.candles; // 今天設的快取，不做交易日檢查
            }
            const lastCandleTime = cached.candles[cached.candles.length - 1].time * 1000;
            const lastTradingDay = _lastTradingDayTs();
            if (lastTradingDay > 0 && lastCandleTime < lastTradingDay) {
              // ★ allowStale：批次掃描（篩選器/族群回測）明確接受「差一天」的快取，
              //   不為了最近一根重抓——避免 GAS 今日尚未更新 R2 時整批打 Worker。
              if (opts.allowStale) return cached.candles;
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

  // ── 方案 B：IDB 預檢分兩組 ──────────────────────────────────────────────
  // ⚠️ 踩雷備忘（2026-06-02）：
  //   1713 檔全部並發打 Worker → Cloudflare Edge 限流（Too Many Requests）。
  //   修法：先對所有 code 做 IDB 快取預檢（純本地，極快），
  //   有快取的一組高速跑（concurrency=8，無延遲），
  //   沒快取的一組低速跑（concurrency=2，delay=600ms），
  //   避免 R2 miss 的股票 burst 炸 Worker。
  const _minReq = Math.floor((_PERIOD_DAYS['1y'] ?? 0) * 0.6);
  const cachedCodes   = [];
  const uncachedCodes = [];

  // 並發預檢（純 IDB，不打 network）
  // ⚠️ 上櫃股在 IDB 可能存成 .TWO，toYahooSymbol 給 .TW → miss → 被誤判為無快取
  // 同時試兩個 suffix，任一命中即算有快取
  await Promise.allSettled(normalCodes.map(async code => {
    try {
      const sym1 = toYahooSymbol(code);
      const sym2 = sym1.endsWith('.TW') ? sym1.replace('.TW', '.TWO') : sym1.replace('.TWO', '.TW');
      const [hit1, hit2] = await Promise.all([
        getKlineCache(sym1, '1y').catch(() => null),
        getKlineCache(sym2, '1y').catch(() => null),
      ]);
      const hit = hit1 || hit2;
      if (hit && Array.isArray(hit.candles) && hit.candles.length >= Math.max(2, _minReq)) {
        cachedCodes.push(code);
      } else {
        uncachedCodes.push(code);
      }
    } catch {
      uncachedCodes.push(code);
    }
  }));

  console.log(`[screener] IDB預檢完成：有快取 ${cachedCodes.length} 檔（高速），無快取 ${uncachedCodes.length} 檔（低速）`);

  const result = new Map();
  let done = 0;
  const total = normalCodes.length;

  // ── 單一 code 的抓取邏輯 ──
  // ⚠️ 踩雷備忘（2026-06-02）：
  //   GAS kline_to_r2.gs 依 market 決定 suffix（tpex → .TWO，twse → .TW）。
  //   前端 toYahooSymbol 預設 .TW（_otcSet 冷啟動為空）→ 上櫃股 R2 key 對不上。
  //   R2 MISS → Worker 打 Yahoo → Yahoo 404（.TW 不存在）→ Worker 502。
  //   修法：Worker 502 或 Not Found 都觸發 suffix 切換重試。
  async function _fetchOne(code) {
    try {
      let candles = [];
      const sym1 = toYahooSymbol(code);
      try {
        candles = await fetchHistoryCached(sym1, '1y', { allowStale: true });
      } catch (e1) {
        // 502（R2 miss + Yahoo 封）或 Not Found（suffix 錯誤）→ 試另一個 suffix
        const shouldRetry = /Not Found/i.test(e1.message) || /HTTP 502/.test(e1.message) || /所有 proxy/.test(e1.message);
        if (shouldRetry) {
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
  }

  // ── 有快取：高速（concurrency=8，無延遲，IDB命中不打network）──
  const fastConc = 8;
  for (let i = 0; i < cachedCodes.length; i += fastConc) {
    await Promise.allSettled(cachedCodes.slice(i, i + fastConc).map(_fetchOne));
  }

  // ── 無快取：低速（concurrency=2，delay=600ms，避免Worker限流）──
  const slowConc  = 2;
  const slowDelay = 600;
  for (let i = 0; i < uncachedCodes.length; i += slowConc) {
    await Promise.allSettled(uncachedCodes.slice(i, i + slowConc).map(_fetchOne));
    if (i + slowConc < uncachedCodes.length) await new Promise(r => setTimeout(r, slowDelay));
  }

  return result;
}

// ─────────────────────────────────────────────
// Bundle 預載：開站時抓 GAS 預打包好的全市場 K 線（7 包 gzip），
// 一次性 bulk 灌入 IndexedDB kline_cache。之後 fetchHistoryCached /
// fetchScreenerData 照原邏輯跑，發現 IDB 全命中 → 走高速組、0 Worker。
//
// bundle 內容：{ "2330.TW": [{t,o,h,l,c,v},...], ... }（key=完整 symbol）
// 寫進 IDB 的 candle 格式對齊 fetchHistory：{ time,open,high,low,close,volume }
// 每日只灌一次（localStorage 旗標防重跑）。
// ─────────────────────────────────────────────
const _BUNDLE_PARTS  = 7;
// _WORKER_ORIGIN 已移至 api-core.js

// 明早 09:00 TWT 失效（與盤後快取一致）
function _bundleValidUntil() {
  const now = new Date();
  const tw  = new Date(now.getTime() + 8 * 3600 * 1000);     // → TWT
  const next = new Date(tw);
  next.setUTCHours(1, 0, 0, 0);                              // 09:00 TWT = 01:00 UTC
  if (tw.getUTCHours() >= 1) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

// 防呆解壓：先試 res.json()（瀏覽器自動解 gzip），失敗再用 DecompressionStream 手動解
async function _fetchBundlePart(part) {
  const url = `${_WORKER_ORIGIN}/bundle?part=${part}`;
  const res = await fetch(url, {
    headers: PROXY_TOKEN ? { 'X-Proxy-Token': PROXY_TOKEN } : {},
    cache:   'no-store',
  });
  if (!res.ok) throw new Error(`bundle part${part} HTTP ${res.status}`);

  // 複製一份以便兩種解法都能讀 body
  const buf = await res.clone().arrayBuffer();
  // 1) 嘗試當未壓縮 / 已被瀏覽器解壓的 JSON 直接 parse
  try {
    const txt = new TextDecoder().decode(buf);
    return JSON.parse(txt);
  } catch (_) { /* 落到手動解壓 */ }
  // 2) 手動 gzip 解壓（瀏覽器沒自動解時）
  try {
    const ds  = new DecompressionStream('gzip');
    const out = new Response(new Blob([buf]).stream().pipeThrough(ds));
    return await out.json();
  } catch (e) {
    throw new Error(`bundle part${part} 解壓/解析失敗: ${e.message}`);
  }
}

let _bundlePreloading = null;  // 進行中的 Promise（避免重複觸發）

/**
 * 預載全市場 K 線 bundle → 灌 IDB。
 * @param {Object} opts
 *   @param {boolean} opts.force  跳過每日旗標，強制重灌
 * @returns {Promise<{seeded:number, skipped:boolean}>}
 */
export async function preloadBundles(opts = {}) {
  if (_bundlePreloading) return _bundlePreloading;

  _bundlePreloading = (async () => {
    // 每日旗標：今天已灌過就跳過（除非 force）
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const flagKey = 'bundle_seeded_date';
    if (!opts.force) {
      try {
        if (localStorage.getItem(flagKey) === today) {
          // 自癒檢查（2026-06-10）：旗標在但 IDB 可能被重建清空（旗標活在 localStorage 不隨 IDB 死）
          // kline_cache 筆數遠低於全市場 → 視為空殼，無視旗標重灌
          const n = await countKlineCache();
          if (n >= 0 && n < 500) {
            console.warn(`[bundle] 旗標在但 kline_cache 僅 ${n} 筆（疑似 IDB 重建），無視旗標重灌`);
          } else {
            console.log('[bundle] 今日已灌入，跳過');
            return { seeded: 0, skipped: true };
          }
        }
      } catch (_) {}
    }

    const validUntil = _bundleValidUntil();
    let totalSeeded = 0;
    const t0 = Date.now();

    // 7 包並發抓（各自獨立，一包失敗不影響其他）
    const parts = await Promise.allSettled(
      Array.from({ length: _BUNDLE_PARTS }, (_, i) => _fetchBundlePart(i + 1))
    );

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.status !== 'fulfilled' || !p.value) {
        const msg = p.reason?.message || 'no data';
        console.warn(`[bundle] part${i + 1} 失敗:`, msg);
        try { window.__bundleError = (window.__bundleError || '') + `part${i+1}:${msg}; `; } catch(_){}
        continue;
      }
      const map = p.value;
      const entries = [];
      for (const [symbol, slim] of Object.entries(map)) {
        if (!Array.isArray(slim) || !slim.length) continue;
        // {t,o,h,l,c,v} → {time,open,high,low,close,volume}
        const candles = slim.map(k => ({
          time:   k.t,
          open:   k.o,
          high:   k.h,
          low:    k.l,
          close:  k.c,
          volume: k.v ?? 0,
        }));
        entries.push({ symbol, period: '1y', candles, validUntil });
      }
      try {
        const n = await bulkSetKlineCache(entries);
        totalSeeded += n;
        console.log(`[bundle] part${i + 1} 灌入 ${n} 檔`);
      } catch (e) {
        const msg = e?.message || 'IDB error';
        console.warn(`[bundle] part${i + 1} IDB 寫入失敗:`, msg);
        try { window.__bundleError = (window.__bundleError || '') + `part${i+1}-idb:${msg}; `; } catch(_){}
      }
    }

    // ⚠️ 只有實際灌入成功才立旗標（2026-06-10）：
    // 否則 part 全失敗 / IDB 被清空後，旗標殘留導致每天「今日已灌入」永久跳過
    if (totalSeeded > 0) {
      try { localStorage.setItem(flagKey, today); } catch (_) {}
    }
    console.log(`[bundle] 預載完成：共 ${totalSeeded} 檔，耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { seeded: totalSeeded, skipped: false };
  })();

  try {
    return await _bundlePreloading;
  } finally {
    _bundlePreloading = null;
  }
}

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
