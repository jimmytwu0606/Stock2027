// js/signal-backtest.js
// ============================================================================
// 技術訊號集合回測 — 一次驗證 30+ 個策略的歷史勝率
// ============================================================================
// 對外 API:
//   runSignalBacktest(items, onProgress, opts) → 多檔批次集合回測
//   getDefaultBacktestBasket() → 復用 mc-backtest.js 的 10 檔 basket
//
// 設計原則:
//   1. 直接呼叫 signal-scan.js 的 matchSignals() — 不重寫,避免邏輯漂移
//      → 回測勝率 = 線上看到的訊號的真實勝率
//   2. 每個 t 點切片 candles.slice(0, t),只看「過去」(避免 look-ahead bias)
//   3. 9 種出場組合同時跑:5/10/20 天 × 1%/2%/3% 標的
//   4. 每個策略獨立統計勝率 + 平均報酬 + 最大連敗 + 樣本數
// ----------------------------------------------------------------------------
// 進場規則:
//   訊號當天收盤進場 (entryClose = candles[t-1].close)
//   N 天後檢查 candles[t-1+N].close
//   報酬 = (exit - entry) / entry
//   勝負: 報酬 >= 標的(1/2/3%) → 贏
// ----------------------------------------------------------------------------
// 與 MC 回測的差異:
//   - MC 公式:每天都有預測 → 評估「方向命中 + MAE」
//   - 訊號回測:只在訊號觸發時進場 → 評估「勝率 + 平均報酬 + 風報比」
// ============================================================================

import { matchSignals } from './signal-scan.js';
import { STRATEGIES, STRATEGY_VERSION } from './strategy.js';

// 持有期與標的組合 — 9 個對照
const HOLD_DAYS    = [5, 10, 20];
const WIN_TARGETS  = [0.01, 0.02, 0.03];  // 1% / 2% / 3%
const MIN_HIST     = 30;                  // 切片最小歷史長度 (matchSignals 內部需要 20+ 但保守一點)
const SAMPLE_STEP  = 1;                   // 取樣步長 (1 = 每天都跑;5 = 每 5 天跑一次以加速)

/**
 * 單檔集合回測 — 跑所有策略對該股的歷史勝率
 * @param {Candle[]} candles 完整 K 線
 * @param {object} opts
 * @param {number}  [opts.sampleStep=1] 取樣步長
 * @returns {object} { ok, strategies: { [stratId]: { combos: { '5d-2pct': {...} } } } }
 */
export function runSignalBacktestSingle(candles, opts = {}) {
  const { sampleStep = SAMPLE_STEP } = opts;

  if (!candles || candles.length < MIN_HIST + Math.max(...HOLD_DAYS) + 5) {
    return { ok: false, reason: `K線不足,至少 ${MIN_HIST + Math.max(...HOLD_DAYS) + 5} 根` };
  }

  // strategyStats[stratId][combo] = { triggers, wins, returns: [], maxStreakLoss }
  const strategyStats = {};
  // 初始化所有策略的 stats 槽位 (即使從未觸發也存在)
  for (const s of STRATEGIES) {
    strategyStats[s.id] = {
      id:       s.id,
      icon:     s.icon,
      name:     s.name,
      category: s.category,
      desc:     s.desc,
      combos:   {},
    };
    for (const D of HOLD_DAYS) {
      for (const T of WIN_TARGETS) {
        const key = `${D}d-${(T*100).toFixed(0)}pct`;
        strategyStats[s.id].combos[key] = {
          holdDays:    D,
          winTarget:   T,
          triggers:    0,
          wins:        0,
          returns:     [],   // 每次觸發的實際報酬
        };
      }
    }
  }

  const maxH = Math.max(...HOLD_DAYS);

  // 主回測迴圈
  for (let t = MIN_HIST; t < candles.length - maxH; t += sampleStep) {
    // 切片: 看 [0, t-1] 這段歷史 (假裝站在 t-1 收盤後)
    const sliced = candles.slice(0, t);

    // 合成 twseRow (matchSignals 內部會 fallback 但這裡明確傳更穩)
    let twseRow = null;
    if (sliced.length >= 2) {
      const last = sliced[sliced.length - 1];
      const prev = sliced[sliced.length - 2];
      const chgPct = prev.close > 0
        ? (last.close - prev.close) / prev.close * 100
        : 0;
      twseRow = {
        price:  last.close,
        chgPct: chgPct,
        volume: Math.round((last.volume ?? 0) / 1000),  // 股 → 張 (matchSignals 慣例)
      };
    }

    let signals;
    try {
      signals = matchSignals(sliced, twseRow);
    } catch (err) {
      continue;  // 該 t 點 matchSignals 出錯就跳過
    }

    if (!signals || signals.length === 0) continue;

    const entryClose = sliced[sliced.length - 1].close;

    // 每個觸發的策略,對 9 種出場組合各算一次
    for (const sig of signals) {
      const stat = strategyStats[sig.id];
      if (!stat) continue;  // 萬一策略 ID 沒在初始化清單裡

      for (const D of HOLD_DAYS) {
        const exitCandle = candles[t - 1 + D];
        if (!exitCandle) continue;
        const ret = (exitCandle.close - entryClose) / entryClose;

        for (const T of WIN_TARGETS) {
          const key = `${D}d-${(T*100).toFixed(0)}pct`;
          const combo = stat.combos[key];
          combo.triggers++;
          combo.returns.push(ret);
          if (ret >= T) combo.wins++;
        }
      }
    }
  }

  // 算最終比率
  for (const stratId in strategyStats) {
    const stat = strategyStats[stratId];
    for (const key in stat.combos) {
      const c = stat.combos[key];
      if (c.triggers === 0) {
        c.winRate = null;
        c.avgReturn = null;
        c.maxGain = null;
        c.maxLoss = null;
        continue;
      }
      c.winRate   = c.wins / c.triggers;
      c.avgReturn = c.returns.reduce((s, v) => s + v, 0) / c.triggers;
      c.maxGain   = Math.max(...c.returns);
      c.maxLoss   = Math.min(...c.returns);
      // 不存原始 returns 陣列,降低 transfer 成本
      delete c.returns;
    }
  }

  return { ok: true, strategies: strategyStats };
}

/**
 * 多檔批次集合回測
 * @param {Array<{code, name, type, candles}>} items
 * @param {function} onProgress (done, total, currentItem)
 * @param {object} opts
 *   - sampleStep
 *   - signal (AbortSignal)
 * @returns {Promise<{ok, perStock, aggregated, formula, aborted}>}
 */
export async function runSignalBacktest(items, onProgress, opts = {}) {
  const { sampleStep = 1, signal = null } = opts;
  const perStock = [];
  let aborted = false;

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) { aborted = true; break; }

    const item = items[i];
    const { code, name, type, candles } = item;

    let result;
    if (!candles || candles.length < MIN_HIST + Math.max(...HOLD_DAYS) + 5) {
      result = { code, name, type, ok: false, reason: 'K線不足' };
    } else {
      try {
        const bt = runSignalBacktestSingle(candles, { sampleStep });
        result = { code, name, type, ...bt };
      } catch (err) {
        result = { code, name, type, ok: false, reason: err.message || 'unknown' };
      }
    }

    perStock.push(result);

    // yield 讓 UI 渲染進度
    try { await onProgress?.(i + 1, items.length, item, perStock); } catch {}
    await new Promise(r => setTimeout(r, 0));
  }

  // 彙整跨股總勝率
  const aggregated = _aggregateAcrossStocks(perStock);

  return {
    ok: true,
    perStock,
    aggregated,
    formula:  `signal-bt-v${STRATEGY_VERSION}` + (sampleStep > 1 ? `-s${sampleStep}` : ''),
    aborted,
  };
}

/**
 * 跨股彙總:把所有股的策略觸發合併,算每個策略的「全市場勝率」
 * @returns {object} { [stratId]: { combos: { '5d-2pct': {...} }, info } }
 */
function _aggregateAcrossStocks(perStock) {
  const agg = {};

  // 初始化 — 從 STRATEGIES 取得所有策略 metadata
  for (const s of STRATEGIES) {
    agg[s.id] = {
      id:       s.id,
      icon:     s.icon,
      name:     s.name,
      category: s.category,
      desc:     s.desc,
      combos:   {},
      stockCount: 0,  // 該策略在幾檔有觸發
    };
    for (const D of HOLD_DAYS) {
      for (const T of WIN_TARGETS) {
        const key = `${D}d-${(T*100).toFixed(0)}pct`;
        agg[s.id].combos[key] = {
          holdDays:  D,
          winTarget: T,
          triggers:  0,
          wins:      0,
          returnSum: 0,   // 用 sum 不存原始陣列 (記憶體優化)
          maxGain:   -Infinity,
          maxLoss:   Infinity,
        };
      }
    }
  }

  // 累加每檔的觸發
  for (const stock of perStock) {
    if (!stock.ok || !stock.strategies) continue;

    for (const stratId in stock.strategies) {
      const stockStrat = stock.strategies[stratId];
      const aggStrat = agg[stratId];
      if (!aggStrat) continue;

      // 該策略在這檔有沒有觸發 (任一 combo triggers > 0 就算)
      const anyTrigger = Object.values(stockStrat.combos).some(c => c.triggers > 0);
      if (anyTrigger) aggStrat.stockCount++;

      for (const key in stockStrat.combos) {
        const sc = stockStrat.combos[key];
        const ac = aggStrat.combos[key];
        if (sc.triggers === 0) continue;
        ac.triggers += sc.triggers;
        ac.wins     += sc.wins;
        ac.returnSum += sc.avgReturn * sc.triggers;
        if (sc.maxGain != null && sc.maxGain > ac.maxGain) ac.maxGain = sc.maxGain;
        if (sc.maxLoss != null && sc.maxLoss < ac.maxLoss) ac.maxLoss = sc.maxLoss;
      }
    }
  }

  // 算最終 winRate / avgReturn
  for (const stratId in agg) {
    const stratAgg = agg[stratId];
    for (const key in stratAgg.combos) {
      const c = stratAgg.combos[key];
      if (c.triggers === 0) {
        c.winRate   = null;
        c.avgReturn = null;
        c.maxGain   = null;
        c.maxLoss   = null;
        continue;
      }
      c.winRate   = c.wins / c.triggers;
      c.avgReturn = c.returnSum / c.triggers;
      delete c.returnSum;
    }
  }

  return agg;
}

/**
 * 找出每個策略的「最佳出場組合」(勝率 × 平均報酬最大者)
 * @param {object} aggregated _aggregateAcrossStocks 的回傳
 * @returns {Array<{ stratId, info, bestCombo }>}
 */
export function findBestComboPerStrategy(aggregated) {
  const result = [];
  for (const stratId in aggregated) {
    const stratAgg = aggregated[stratId];
    let best = null;
    let bestScore = -Infinity;

    for (const key in stratAgg.combos) {
      const c = stratAgg.combos[key];
      if (c.triggers < 5) continue;  // 樣本太少 (< 5) 不可信
      // 評分 = 勝率 × 平均報酬 (越大越好)
      // 注意 avgReturn 可能為負,所以用 max 取最佳
      if (c.winRate == null || c.avgReturn == null) continue;
      const score = c.winRate * (c.avgReturn + 0.01);  // +0.01 避免 avgReturn 是 0 時失真
      if (score > bestScore) {
        bestScore = score;
        best = { key, ...c };
      }
    }

    result.push({
      stratId,
      icon:     stratAgg.icon,
      name:     stratAgg.name,
      category: stratAgg.category,
      desc:     stratAgg.desc,
      stockCount: stratAgg.stockCount,
      bestCombo:  best,
      allCombos:  stratAgg.combos,
    });
  }

  // 按最佳組合的勝率排序
  result.sort((a, b) => {
    const aWin = a.bestCombo?.winRate ?? -1;
    const bWin = b.bestCombo?.winRate ?? -1;
    return bWin - aWin;
  });

  return result;
}
