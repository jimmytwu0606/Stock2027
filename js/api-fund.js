/**
 * api-fund.js — 基本面 / 財報 / 健診 / 籌碼 / FinMind
 */
import { getFinMindToken } from './config.js';
import { fsGetShared } from './firebase.js';
import { fetchWithProxy, toYahooSymbol, _WORKER_ORIGIN, PROXY_TOKEN } from './api-core.js';
import { _openCacheDB, _cacheGet, _cacheSet, _lastUpdatePoint } from './api-cache.js';


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
// ─────────────────────────────────────────────
// 基本面 R2 快照（signals:fund:latest，GAS fund_to_r2.gs 每日 18:30 打包）
// 一次請求載入全市場基本面 → window.__fundSnapshot
// 取代逐檔 Firestore read；Firestore 降為 fallback（快照缺/過期才打）
// ─────────────────────────────────────────────
let _fundSnapshotLoading = null;

export async function fetchFundSnapshot({ force = false } = {}) {
  if (!force && window.__fundSnapshot) return window.__fundSnapshot;
  if (!force && _fundSnapshotLoading) return _fundSnapshotLoading;

  _fundSnapshotLoading = (async () => {
    try {
      const res = await fetch(`${_WORKER_ORIGIN}/fund-snapshot`, {
        headers: { 'X-Proxy-Token': PROXY_TOKEN },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.stocks || !data.count) return null;
      // 過期保護：>8 天視為失效（GAS 管線斷線時自動退回 Firestore）
      if (data.updatedAt && Date.now() - data.updatedAt > 8 * 86400000) {
        console.warn('[api-fund] fund snapshot 過期', data.date, '→ 退回 Firestore');
        return null;
      }
      window.__fundSnapshot = data;
      console.log(`[api-fund] fund snapshot 載入：${data.count} 檔（${data.date}）`);
      return data;
    } catch (e) {
      console.warn('[api-fund] fund snapshot 載入失敗:', e.message);
      return null;
    } finally {
      _fundSnapshotLoading = null;
    }
  })();
  return _fundSnapshotLoading;
}

// slim → 完整 fund 物件（對齊 fetchFundamentals 既有回傳格式，health.js / UI 零改動）
function _expandSlimFund(s, updatedAt) {
  if (!s) return null;
  return {
    _source:          'finmind',
    pe:               s.pe,
    forwardPE:        null,
    eps:              s.eps,
    pbRatio:          s.pb,
    dividendYield:    s.dy,
    dividendRate:     null,
    marketCap:        null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow:  null,
    revenueGrowth:    s.rg,
    earningsGrowth:   s.eg,
    profitMargin:     s.pm,
    sector: null, industry: null, website: null, longBusinessSummary: null,
    _epsSeries:    (s.es ?? []).map(([date, eps]) => ({ date, eps })),
    _marginSeries: (s.ms ?? []).map(([date, grossMargin, operatingMargin, netMargin]) =>
                     ({ date, grossMargin, operatingMargin, netMargin })),
    _revenueSeries: (s.rv ?? []).slice(0, 12).map(([revenue_year, revenue_month, revenue]) =>
                     ({ revenue_year, revenue_month, revenue })),
    _revenueGrowthMoM: s.mom ?? null,
    _revenueGrowthYoY: s.yoy ?? null,
    updatedAt: updatedAt ?? Date.now(),
  };
}

// 快照查單檔（同步，需先 await fetchFundSnapshot）
function _fundFromSnapshot(code) {
  const snap = window.__fundSnapshot;
  if (!snap?.stocks?.[code]) return null;
  return _expandSlimFund(snap.stocks[code], snap.updatedAt);
}

export async function fetchFundamentals(symbol, code) {
  const cacheKey = `fund_${code}`;

  // ── Advanced 7: 最優先讀 R2 全市場快照（一次請求涵蓋全市場）──
  try {
    await fetchFundSnapshot();
    const snapFund = _fundFromSnapshot(code);
    if (snapFund) return snapFund;
  } catch (_) { /* fallback Firestore */ }

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

  // R2 快照優先（快照含預算好的 mom/yoy/revSeries，不需再讀 revenue doc）
  try {
    await fetchFundSnapshot();
    const snapFund = _fundFromSnapshot(code);
    if (snapFund) return snapFund;
  } catch (_) { /* fallback Firestore */ }

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
  const result = new Map();

  // R2 快照 O(1) 直查（全市場一次請求已含）
  await fetchFundSnapshot().catch(() => null);
  const missing = [];
  for (const code of codes) {
    const snapFund = _fundFromSnapshot(code);
    if (snapFund) result.set(code, snapFund);
    else missing.push(code);
  }

  // 快照缺的才走 Firestore，併發上限 10（原版無上限會瞬間打爆）
  const CONCUR = 10;
  for (let i = 0; i < missing.length; i += CONCUR) {
    const batch = missing.slice(i, i + CONCUR);
    const arr = await Promise.all(
      batch.map(code => fetchFundamentalsFromFirestore(code).then(
        fund => [code, fund],
        _    => [code, null]
      ))
    );
    arr.forEach(([code, fund]) => result.set(code, fund));
  }
  return result;
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
// ─────────────────────────────────────────────
// 籌碼 R2 快照（signals:chips:latest，GAS chips_to_r2.gs 每日 15:30 打包）
// 三大法人近 20 日序列 + 最新日融資融券，一次請求全市場
// ─────────────────────────────────────────────
let _chipSnapshotLoading = null;

export async function fetchChipSnapshot({ force = false } = {}) {
  if (!force && window.__chipSnapshot) return window.__chipSnapshot;
  if (!force && _chipSnapshotLoading) return _chipSnapshotLoading;

  _chipSnapshotLoading = (async () => {
    try {
      const res = await fetch(`${_WORKER_ORIGIN}/chips-snapshot`, {
        headers: { 'X-Proxy-Token': PROXY_TOKEN },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.stocks || !data?.days?.length) return null;
      // 過期保護：>5 天視為失效（盤後資料，連假最多 4 天）
      if (data.updatedAt && Date.now() - data.updatedAt > 5 * 86400000) {
        console.warn('[api-fund] chips snapshot 過期', data.date, '→ 退回既有路徑');
        return null;
      }
      window.__chipSnapshot = data;
      console.log(`[api-fund] chips snapshot 載入：${Object.keys(data.stocks).length} 檔 × ${data.days.length} 日`);
      return data;
    } catch (e) {
      console.warn('[api-fund] chips snapshot 載入失敗:', e.message);
      return null;
    } finally {
      _chipSnapshotLoading = null;
    }
  })();
  return _chipSnapshotLoading;
}

export async function fetchChipData(code) {
  const result = { institutional: null, margin: null };

  // ── Advanced 8: 最優先讀 R2 籌碼快照（最新交易日 + 融資融券）──
  try {
    const snap = await fetchChipSnapshot();
    const s = snap?.stocks?.[code];
    if (s) {
      const li = snap.days.length - 1;  // 最新交易日 index
      if (s.f[li] != null) {
        result.institutional = {
          foreign: s.f[li] ?? 0,
          trust:   s.t[li] ?? 0,
          dealer:  s.d[li] ?? 0,
          total:   (s.f[li] ?? 0) + (s.t[li] ?? 0) + (s.d[li] ?? 0),
        };
      }
      const m = snap.margin?.[code];
      if (m) {
        result.margin = {
          marginBalance: m.mb, marginChange: m.mc,
          shortBalance:  m.sb, shortChange:  m.sc,
        };
      }
      if (result.institutional) return result;
    }
  } catch (_) { /* fallback 既有路徑 */ }

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

  // ── R2 籌碼快照優先：外資序列直接取，免 FinMind / 免 token ──
  try {
    const snap = await fetchChipSnapshot();
    const s = snap?.stocks?.[code];
    if (s?.f?.length) {
      const result = [];
      for (let i = snap.days.length - 1; i >= 0 && result.length < days; i--) {
        if (s.f[i] == null) continue;
        // 快照只有買賣超淨額（無分買/賣），buy/sell 以 net 正負拆分供 UI 沿用
        const net = s.f[i];
        result.push({ date: snap.days[i], buy: net > 0 ? net : 0, sell: net < 0 ? -net : 0, net });
      }
      if (result.length > 0) {
        try { await _cacheSet(cacheKey, result); } catch (_) {}
        return result;
      }
    }
  } catch (_) { /* fallback FinMind */ }

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
