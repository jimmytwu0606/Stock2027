/**
 * backtest-engine.js — 組合回測引擎
 *
 * 設計：
 *   1. 向量化指標：每檔股票的 RSI/MA/均量/KD/MACD 整段算一次 O(n)，
 *      逐日訊號判定變 O(1) 查表（比逐日呼叫 matchSignals 快 ~100 倍）
 *   2. 條件庫對齊 strategy.js 的 condId 語意（支援 X 系列全部條件）
 *   3. 組合回放：逐日推進，先出場後進場，T+1 開盤價成交（避免未來函數）
 *   4. 報酬用還原價 a 計算（含息），市值/股數全部以 a 為基準
 *
 * export：
 *   runBacktest(opts) → { equity, trades, dailyReturns, config }
 *     opts: {
 *       histMap:      Map<code, {candles:[{t,o,h,l,c,a,v}]}>   ← api-hist.js fetchHistAll
 *       entryIds:     ['X1']                进场訊號（任一觸發即進場）
 *       exitMode:     'days' | 'signal_gone'
 *       exitDays:     20                    exitMode='days' 時的持有天數
 *       capital:      1_000_000
 *       maxPositions: 10
 *       feeRate:      0.001425             買賣手續費
 *       taxRate:      0.003                賣出證交稅
 *       startTs:      可選，回測起始 unix ts（預設資料最早+60 根暖機）
 *       onProgress:   (done, total) => {}
 *     }
 *
 *   SUPPORTED_CONDS — 引擎已實作的 condId 清單（UI 用來判斷哪些策略可回測）
 *   isStrategyBacktestable(strategy) — 該策略的條件是否全部支援
 */

import { STRATEGIES } from './strategy.js';

// ─────────────────────────────────────────────────────────────────────────────
// 指標向量化（整段一次算完）
// ─────────────────────────────────────────────────────────────────────────────
function _sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function _rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const gain = Math.max(chg, 0), loss = Math.max(-chg, 0);
    if (i <= n) {
      avgGain += gain / n; avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function _kd(candles, n = 9, kS = 3, dS = 3) {
  const len = candles.length;
  const K = new Array(len).fill(null), D = new Array(len).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < len; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (candles[j].h > hh) hh = candles[j].h;
      if (candles[j].l < ll) ll = candles[j].l;
    }
    const rsv = hh === ll ? 50 : (candles[i].c - ll) / (hh - ll) * 100;
    k = (k * (kS - 1) + rsv) / kS;
    d = (d * (dS - 1) + k) / dS;
    K[i] = k; D[i] = d;
  }
  return { K, D };
}

function _macd(closes, fast = 12, slow = 26, sig = 9) {
  const len = closes.length;
  const dif = new Array(len).fill(null), dea = new Array(len).fill(null), hist = new Array(len).fill(null);
  let emaF = closes[0], emaS = closes[0], emaD = 0;
  const aF = 2 / (fast + 1), aS = 2 / (slow + 1), aD = 2 / (sig + 1);
  for (let i = 0; i < len; i++) {
    emaF = i === 0 ? closes[0] : closes[i] * aF + emaF * (1 - aF);
    emaS = i === 0 ? closes[0] : closes[i] * aS + emaS * (1 - aS);
    const d = emaF - emaS;
    dif[i] = d;
    emaD = i === 0 ? d : d * aD + emaD * (1 - aD);
    dea[i] = emaD;
    hist[i] = d - emaD;
  }
  return { dif, dea, hist };
}

/** 對單檔 candles 預算全部指標序列 */
function _precompute(candles) {
  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v ?? 0);
  const ma5    = _sma(closes, 5);
  const ma20   = _sma(closes, 20);
  const volMa10 = _sma(vols, 10);
  const volMa20 = _sma(vols, 20);
  const volMa30 = _sma(vols, 30);
  const rsi    = _rsi(closes, 14);
  const { K, D } = _kd(candles);
  const macd   = _macd(closes);
  return { closes, vols, ma5, ma20, volMa10, volMa20, volMa30, rsi, K, D, macd };
}

// ─────────────────────────────────────────────────────────────────────────────
// 條件庫（condId → (ind, i, val) => bool）對齊 strategy.js 語意
//   ind = _precompute 結果，i = 當日 index，val = 條件參數
// ─────────────────────────────────────────────────────────────────────────────
const COND_LIB = {
  rsi_min:    (ind, i, v) => ind.rsi[i] != null && ind.rsi[i] >= v,
  rsi_max:    (ind, i, v) => ind.rsi[i] != null && ind.rsi[i] <= v,
  above_ma20: (ind, i)    => ind.ma20[i] != null && ind.closes[i] > ind.ma20[i],
  ma20_rising:(ind, i, v) => {
    const n = v ?? 3;
    if (i < n || ind.ma20[i - n] == null) return false;
    for (let k = 0; k < n; k++) if (!(ind.ma20[i - k] > ind.ma20[i - k - 1])) return false;
    return true;
  },
  vol_surge_short: (ind, i, v) => ind.volMa10[i - 1] != null && ind.volMa10[i - 1] > 0 && ind.vols[i] >= ind.volMa10[i - 1] * v,
  vol_surge_long:  (ind, i, v) => ind.volMa30[i - 1] != null && ind.volMa30[i - 1] > 0 && ind.vols[i] >= ind.volMa30[i - 1] * v,
  vol_surge:       (ind, i, v) => ind.volMa20[i - 1] != null && ind.volMa20[i - 1] > 0 && ind.vols[i] >= ind.volMa20[i - 1] * v,
  vol_shrink:      (ind, i, v) => ind.volMa20[i - 1] != null && ind.volMa20[i - 1] > 0 && ind.vols[i] <= ind.volMa20[i - 1] * v,
  gain_10d:   (ind, i, v) => i >= 10 && ind.closes[i - 10] > 0 && (ind.closes[i] / ind.closes[i - 10] - 1) * 100 >= v,
  loss_5d:    (ind, i, v) => i >= 5  && ind.closes[i - 5] > 0 && (1 - ind.closes[i] / ind.closes[i - 5]) * 100 >= v,
  drop_n_days:(ind, i, v) => i >= 3  && ind.closes[i - 3] > 0 && (ind.closes[i] / ind.closes[i - 3] - 1) * 100 <= v,
  kd_golden:  (ind, i)    => i >= 1 && ind.K[i] != null && ind.K[i - 1] != null && ind.K[i - 1] <= ind.D[i - 1] && ind.K[i] > ind.D[i],
  kd_k_min:   (ind, i, v) => ind.K[i] != null && ind.K[i] >= v,
  kd_k_max:   (ind, i, v) => ind.K[i] != null && ind.K[i] <= v,
  macd_golden:(ind, i)    => i >= 1 && ind.macd.dif[i - 1] <= ind.macd.dea[i - 1] && ind.macd.dif[i] > ind.macd.dea[i],
  macd_hist_pos: (ind, i) => ind.macd.hist[i] > 0,
  ma5_cross_ma20:(ind, i) => i >= 1 && ind.ma5[i - 1] != null && ind.ma20[i - 1] != null && ind.ma5[i - 1] <= ind.ma20[i - 1] && ind.ma5[i] > ind.ma20[i],
  high_n_days:(ind, i, v) => {
    if (i < v) return false;
    for (let k = 1; k <= v; k++) if (ind.closes[i - k] >= ind.closes[i]) return false;
    return true;
  },
  chg_min:    (ind, i, v) => i >= 1 && ind.closes[i - 1] > 0 && (ind.closes[i] / ind.closes[i - 1] - 1) * 100 >= v,
  vol_min:    (ind, i, v) => ind.vols[i] / 1000 >= v,   // strategy.js 的 vol_min 單位是「張」
  rsi_revival:(ind, i, v) => {
    if (ind.rsi[i] == null || ind.rsi[i] < v) return false;
    for (let k = 1; k <= 5; k++) { if (i - k < 0) return false; if (ind.rsi[i - k] != null && ind.rsi[i - k] < 30) return true; }
    return false;
  },
  tight_consolidation: (ind, i, v) => {
    if (i < 6 || ind.volMa10[i - 1] == null) return false;
    let hh = -Infinity, ll = Infinity;
    for (let k = 1; k <= 5; k++) { hh = Math.max(hh, ind.closes[i - k]); ll = Math.min(ll, ind.closes[i - k]); }
    const rangePct = ll > 0 ? (hh - ll) / ll * 100 : 999;
    const breakout = ind.closes[i] > hh && ind.vols[i] >= ind.volMa10[i - 1] * 1.5;
    return rangePct < v && breakout;
  },
};

export const SUPPORTED_CONDS = Object.keys(COND_LIB);

export function isStrategyBacktestable(strategy) {
  return strategy.conditions.every(c => COND_LIB[c.condId]);
}

/** 該日該檔是否觸發指定訊號 */
function _signalAt(ind, i, strategy) {
  if (i < 35) return false;   // 暖機保護（MACD/RSI 需要 ~35 根）
  return strategy.conditions.every(c => {
    const fn = COND_LIB[c.condId];
    return fn ? fn(ind, i, c.value) : false;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 組合回放主體
// ─────────────────────────────────────────────────────────────────────────────
export function runBacktest(opts) {
  const {
    histMap, entryIds = ['X1'],
    exitMode = 'days', exitDays = 20,
    capital = 1_000_000, maxPositions = 10,
    feeRate = 0.001425, taxRate = 0.003,
    stopPct = 8, trailPct = 15, maxHoldDays = 120,
    regimeCandles = null,
    startTs = null, onProgress = null,
  } = opts;

  const entryStrats = STRATEGIES.filter(s => entryIds.includes(s.id) && isStrategyBacktestable(s));
  if (entryStrats.length === 0) throw new Error('無可回測的進場訊號（條件未支援）');

  const prep = _prepStocks(histMap, startTs, onProgress);
  const regime = _prepRegime(regimeCandles);
  const result = _replay(prep, entryStrats, { exitMode, exitDays, capital, maxPositions, feeRate, taxRate, stopPct, trailPct, maxHoldDays, regime });
  if (onProgress) onProgress(1, 1);
  return {
    ...result,
    config: { entryIds, exitMode, exitDays, capital, maxPositions, stockCount: prep.stocks.length, days: prep.days.length },
  };
}

/**
 * 全策略比較：每個可回測策略各跑一輪（共用指標預算，快）
 * 回傳 [{ id, name, icon, category, equity, trades, dailyReturns, config }]
 */
export function runBacktestAll(opts) {
  const {
    histMap, exitMode = 'days', exitDays = 20,
    capital = 1_000_000, maxPositions = 10,
    feeRate = 0.001425, taxRate = 0.003,
    stopPct = 8, trailPct = 15, maxHoldDays = 120,
    regimeCandles = null,
    startTs = null, onProgress = null,
  } = opts;

  const strats = STRATEGIES.filter(isStrategyBacktestable);
  const prep = _prepStocks(histMap, startTs, null);
  const regime = _prepRegime(regimeCandles);
  const results = [];

  strats.forEach((strat, idx) => {
    const r = _replay(prep, [strat], { exitMode, exitDays, capital, maxPositions, feeRate, taxRate, stopPct, trailPct, maxHoldDays, regime });
    results.push({
      id: strat.id, name: strat.name, icon: strat.icon, category: strat.category,
      ...r,
      config: { entryIds: [strat.id], exitMode, exitDays, capital, maxPositions, stockCount: prep.stocks.length, days: prep.days.length },
    });
    if (onProgress) onProgress(idx + 1, strats.length);
  });

  return results;
}

// ── 內部：股票池預處理（指標預算 + 交易日曆）──────────────────────────────
function _prepStocks(histMap, startTs, onProgress) {
  const stocks = [];
  const allTs  = new Set();
  const codes = [...histMap.keys()];
  let prepDone = 0;

  for (const code of codes) {
    const hist = histMap.get(code);
    const candles = (hist?.candles ?? []).filter(c => c.a != null && c.c > 0);
    if (candles.length < 60) { prepDone++; continue; }
    const ind = _precompute(candles);
    const tsIndex = new Map();
    candles.forEach((c, i) => { tsIndex.set(c.t, i); allTs.add(c.t); });
    stocks.push({ code, candles, ind, tsIndex });
    prepDone++;
    if (onProgress) onProgress(prepDone, codes.length);
  }
  if (stocks.length === 0) throw new Error('無有效股票資料');

  const calendar = [...allTs].sort((a, b) => a - b);
  const warmupTs = calendar[Math.min(60, calendar.length - 1)];
  const beginTs  = startTs ? Math.max(startTs, warmupTs) : warmupTs;
  const days = calendar.filter(ts => ts >= beginTs);
  return { stocks, days };
}

/**
 * 參數掃描：對指定進場訊號，grid 掃 trailing 出場參數（共用指標預算）
 * 回傳 [{ stopPct, trailPct, equity, trades, dailyReturns, config }]
 */
export function runParamScan(opts) {
  const {
    histMap, entryIds = ['X2'],
    stops = [10, 15, 20], trails = [15, 20, 25],
    capital = 1_000_000, maxPositions = 10,
    feeRate = 0.001425, taxRate = 0.003, maxHoldDays = 120,
    regimeCandles = null, startTs = null, onProgress = null,
  } = opts;

  const entryStrats = STRATEGIES.filter(s => entryIds.includes(s.id) && isStrategyBacktestable(s));
  if (entryStrats.length === 0) throw new Error('無可回測的進場訊號');

  const prep = _prepStocks(histMap, startTs, null);
  const regime = _prepRegime(regimeCandles);
  const results = [];
  const total = stops.length * trails.length;
  let done = 0;

  for (const stopPct of stops) {
    for (const trailPct of trails) {
      const r = _replay(prep, entryStrats, {
        exitMode: 'trailing', exitDays: 0, capital, maxPositions,
        feeRate, taxRate, stopPct, trailPct, maxHoldDays, regime,
      });
      results.push({
        stopPct, trailPct, ...r,
        config: { entryIds, exitMode: 'trailing', stopPct, trailPct, capital, maxPositions, stockCount: prep.stocks.length, days: prep.days.length },
      });
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  return results;
}

// ── 內部：大盤濾網預處理（指數/0050 收盤 > MA60 = 可進場）────────────────
function _prepRegime(candles) {
  if (!candles || candles.length < 80) return null;
  const closes = candles.map(c => c.a ?? c.c);
  const ma60 = _sma(closes, 60);
  const riskOn = new Map();   // ts → bool
  for (let i = 0; i < candles.length; i++) {
    riskOn.set(candles[i].t, ma60[i] != null && closes[i] > ma60[i]);
  }
  // 提供「找 ≤ts 最近一筆」的查詢（個股與基準交易日曆可能略有差異）
  const sortedTs = candles.map(c => c.t);
  return {
    canEnter(ts) {
      // 二分找 ≤ ts 的最近基準日
      let lo = 0, hi = sortedTs.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTs[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans < 0) return true;   // 基準資料尚未開始，不擋
      return riskOn.get(sortedTs[ans]) !== false;
    },
  };
}

// ── 內部：回放核心 ──────────────────────────────────────────────────────────
function _replay(prep, entryStrats, cfg) {
  const { stocks, days } = prep;
  const { exitMode, exitDays, capital, maxPositions, feeRate, taxRate } = cfg;

  let cash = capital;
  const positions = new Map();
  const trades = [];
  const equity = [];
  const perSlot = capital / maxPositions;
  const stockByCode = new Map(stocks.map(s => [s.code, s]));

  for (let d = 0; d < days.length; d++) {
    const ts = days[d];

    // (a) 出場
    for (const [code, pos] of [...positions]) {
      const st = stockByCode.get(code);
      const i  = st.tsIndex.get(ts);
      if (i == null) continue;
      pos.entryDayCount++;

      let shouldExit = false, reason = '';
      if (exitMode === 'days' && pos.entryDayCount >= exitDays) {
        shouldExit = true; reason = `滿${exitDays}天`;
      } else if (exitMode === 'signal_gone' && i >= 1) {
        const strat = entryStrats.find(s => s.id === pos.signalId) ?? entryStrats[0];
        if (!_signalAt(st.ind, i - 1, strat)) { shouldExit = true; reason = '訊號消失'; }
      } else if (exitMode === 'trailing' && i >= 1) {
        // 停損 + 移動停利：用昨日收盤判定（今日開盤執行）
        const prevA = st.candles[i - 1].a;
        pos.peakA = Math.max(pos.peakA ?? pos.entryA, prevA);
        const fromEntry = prevA / pos.entryA - 1;
        const fromPeak  = prevA / pos.peakA - 1;
        if (fromEntry <= -(cfg.stopPct ?? 8) / 100) {
          shouldExit = true; reason = `停損${cfg.stopPct ?? 8}%`;
        } else if (fromPeak <= -(cfg.trailPct ?? 15) / 100 && fromEntry > 0) {
          shouldExit = true; reason = `回落停利${cfg.trailPct ?? 15}%`;
        } else if (pos.entryDayCount >= (cfg.maxHoldDays ?? 120)) {
          shouldExit = true; reason = `滿${cfg.maxHoldDays ?? 120}天上限`;
        }
      }

      if (shouldExit) {
        const c = st.candles[i];
        const openA = c.a * (c.o / c.c);
        const proceeds = pos.shares * openA * (1 - feeRate - taxRate);
        cash += proceeds;
        trades.push({
          code, signalId: pos.signalId, entryTs: pos.entryTs, exitTs: ts,
          entryPrice: pos.entryC, exitPrice: c.o,
          holdDays: pos.entryDayCount, retPct: +((proceeds / pos.cost - 1) * 100).toFixed(2), reason,
        });
        positions.delete(code);
      }
    }

    // (b) 進場（大盤濾網：用前一交易日的大盤狀態判定，T+1 一致）
    const regimeOk = !cfg.regime || d === 0 || cfg.regime.canEnter(days[d - 1]);
    if (regimeOk && positions.size < maxPositions) {
      const candidates = [];
      for (const st of stocks) {
        if (positions.has(st.code)) continue;
        const i = st.tsIndex.get(ts);
        if (i == null || i < 1) continue;
        for (const strat of entryStrats) {
          if (_signalAt(st.ind, i - 1, strat)) { candidates.push({ st, i, signalId: strat.id }); break; }
        }
      }
      candidates.sort((a, b) => a.st.code.localeCompare(b.st.code));
      for (const cand of candidates) {
        if (positions.size >= maxPositions) break;
        const budget = Math.min(perSlot, cash);
        if (budget < perSlot * 0.5) break;
        const c = cand.st.candles[cand.i];
        const openA = c.a * (c.o / c.c);
        if (openA <= 0) continue;
        const shares = budget * (1 - feeRate) / openA;
        cash -= budget;
        positions.set(cand.st.code, {
          shares, cost: budget, entryA: openA, entryC: c.o, entryTs: ts,
          entryDayCount: 0, signalId: cand.signalId,
        });
      }
    }

    // (c) 結算
    let mv = 0;
    for (const [code, pos] of positions) {
      const st = stockByCode.get(code);
      const i  = st.tsIndex.get(ts);
      let a = null;
      if (i != null) a = st.candles[i].a;
      else {
        for (let k = st.candles.length - 1; k >= 0; k--) {
          if (st.candles[k].t <= ts) { a = st.candles[k].a; break; }
        }
      }
      mv += a != null ? pos.shares * a : pos.cost;
    }
    equity.push({ t: ts, value: cash + mv });
  }

  // 期末平倉
  const lastTs = days[days.length - 1];
  for (const [code, pos] of positions) {
    const st = stockByCode.get(code);
    const last = st.candles[st.candles.length - 1];
    const proceeds = pos.shares * last.a * (1 - feeRate - taxRate);
    trades.push({
      code, signalId: pos.signalId, entryTs: pos.entryTs, exitTs: lastTs,
      entryPrice: pos.entryC, exitPrice: last.c,
      holdDays: pos.entryDayCount, retPct: +((proceeds / pos.cost - 1) * 100).toFixed(2), reason: '期末持有',
    });
  }

  const dailyReturns = [];
  for (let i = 1; i < equity.length; i++) {
    dailyReturns.push({ t: equity[i].t, r: equity[i].value / equity[i - 1].value - 1 });
  }
  return { equity, trades, dailyReturns };
}
