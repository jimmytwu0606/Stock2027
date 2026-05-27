// js/combo-backtest.js
// ============================================================================
// 三件套組合回測 — 驗證「組合拳」是否真的勝率優於單一策略
// ============================================================================
// 對外 API:
//   runComboBacktest(items, onProgress, opts) → 多檔批次組合回測
//   getDefaultCombos() → 預設 5 組組合
//
// 設計原則:
//   1. 復用 signal-scan.js 的 matchSignals() — 不重寫
//   2. 每個 t 點切片,看當天有哪些訊號觸發
//   3. 對每個組合判定兩種條件:
//      - "all" 三亮: A + B + C 都觸發
//      - "filter" 過濾: A + B 觸發 AND C 沒觸發
//   4. 同一天觸發定義 = 同一個 t 點
// ============================================================================
// 業界共識:組合拳優於單一指標(來自:RSI+布林、MACD+EMA、R3 Strategy 等)
// 這次驗證:在實證資料下,哪種組合真的有加分
// ============================================================================

import { matchSignals } from './signal-scan.js';

const HOLD_DAYS    = [5, 10, 20];
const WIN_TARGETS  = [0.01, 0.02, 0.03];
const MIN_HIST     = 30;
const SAMPLE_STEP  = 1;

// ─── 預設 5 組組合(使用者敲定的「1+2+3+5+6 雙國五側」) ──────────────
const DEFAULT_COMBOS = [
  {
    key:     'combo1',
    name:    '雙王 + 急跌過濾',
    A:       { id: 'W6',  label: 'RSI 強勢驗證' },
    B:       { id: 'S11', label: '三箭齊發' },
    C:       { id: 'W5',  label: '急跌訊號' },
    desc:    '兩個 80% 王者 + 急跌作為過濾',
  },
  {
    key:     'combo2',
    name:    '強勢動能 + K 線確認',
    A:       { id: 'W6',  label: 'RSI 強勢驗證' },
    B:       { id: 'S40', label: '紅三兵' },
    C:       { id: 'W17', label: 'DMI 空頭確認' },
    desc:    'RSI 強勢 + K 線型態驗證 + 空方未現',
  },
  {
    key:     'combo3',
    name:    '強勢續漲 + 一目過濾',
    A:       { id: 'W6',  label: 'RSI 強勢驗證' },
    B:       { id: 'S14', label: '強勢鈍化' },
    C:       { id: 'W11', label: '一目雲層跌破' },
    desc:    '強勢 + 中段平台 + 一目作為過濾',
  },
  {
    key:     'combo5',
    name:    '標準多頭 + 安全',
    A:       { id: 'S2',  label: '均線啟動' },
    B:       { id: 'S22', label: '葛蘭碧買三' },
    C:       { id: 'W5',  label: '急跌訊號' },
    desc:    '趨勢起步 + 中段確認 + 急跌過濾',
  },
  {
    key:     'combo6',
    name:    '強勢標準 + 量縮過濾',
    A:       { id: 'S_STRONG', label: '強勢不回' },
    B:       { id: 'S4',  label: '近期創高' },
    C:       { id: 'W4',  label: '量縮跌破月線' },
    desc:    '強勢續漲標準雙策略 + 過濾風險',
  },
];

export function getDefaultCombos() {
  return DEFAULT_COMBOS.map(c => ({ ...c }));
}

// ─── 單檔組合回測 ──────────────────────────────────────────────────────
function runComboBacktestSingle(candles, combos, opts = {}) {
  const { sampleStep = SAMPLE_STEP } = opts;

  if (!candles || candles.length < MIN_HIST + Math.max(...HOLD_DAYS) + 5) {
    return { ok: false, reason: `K線不足` };
  }

  // 初始化每個 combo × 條件 × 出場組合 的統計
  // stats[comboKey][condType][outKey] = { triggers, wins, returns, returnSum }
  // condType: 'all' (三亮) | 'filter' (過濾)
  const stats = {};
  for (const combo of combos) {
    stats[combo.key] = {
      all:    {},
      filter: {},
    };
    for (const D of HOLD_DAYS) {
      for (const T of WIN_TARGETS) {
        const key = `${D}d-${(T*100).toFixed(0)}pct`;
        stats[combo.key].all[key]    = _newStat(D, T);
        stats[combo.key].filter[key] = _newStat(D, T);
      }
    }
  }

  const maxH = Math.max(...HOLD_DAYS);

  // 主回測迴圈
  for (let t = MIN_HIST; t < candles.length - maxH; t += sampleStep) {
    const sliced = candles.slice(0, t);

    // 合成 twseRow
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
        volume: Math.round((last.volume ?? 0) / 1000),
      };
    }

    let signals;
    try {
      signals = matchSignals(sliced, twseRow);
    } catch { continue; }

    if (!signals || signals.length === 0) continue;

    const sigIds = new Set(signals.map(s => s.id));
    const entryClose = sliced[sliced.length - 1].close;

    // 對每個組合判定
    for (const combo of combos) {
      const hasA = sigIds.has(combo.A.id);
      const hasB = sigIds.has(combo.B.id);
      const hasC = sigIds.has(combo.C.id);

      // 條件 "all":A + B + C 都觸發
      const allTrigger    = hasA && hasB && hasC;
      // 條件 "filter":A + B 觸發, C 沒觸發
      const filterTrigger = hasA && hasB && !hasC;

      if (!allTrigger && !filterTrigger) continue;

      // 對 9 種出場組合各算一次
      for (const D of HOLD_DAYS) {
        const exitCandle = candles[t - 1 + D];
        if (!exitCandle) continue;
        const ret = (exitCandle.close - entryClose) / entryClose;

        for (const T of WIN_TARGETS) {
          const key = `${D}d-${(T*100).toFixed(0)}pct`;
          if (allTrigger) {
            const s = stats[combo.key].all[key];
            s.triggers++;
            s.returnSum += ret;
            if (ret >= T) s.wins++;
            if (ret > s.maxGain) s.maxGain = ret;
            if (ret < s.maxLoss) s.maxLoss = ret;
          }
          if (filterTrigger) {
            const s = stats[combo.key].filter[key];
            s.triggers++;
            s.returnSum += ret;
            if (ret >= T) s.wins++;
            if (ret > s.maxGain) s.maxGain = ret;
            if (ret < s.maxLoss) s.maxLoss = ret;
          }
        }
      }
    }
  }

  // 算最終比率
  for (const comboKey in stats) {
    for (const condType of ['all', 'filter']) {
      for (const outKey in stats[comboKey][condType]) {
        const s = stats[comboKey][condType][outKey];
        if (s.triggers === 0) {
          s.winRate   = null;
          s.avgReturn = null;
          s.maxGain   = null;
          s.maxLoss   = null;
        } else {
          s.winRate   = s.wins / s.triggers;
          s.avgReturn = s.returnSum / s.triggers;
        }
        delete s.returnSum;
      }
    }
  }

  return { ok: true, stats };
}

function _newStat(D, T) {
  return {
    holdDays:  D,
    winTarget: T,
    triggers:  0,
    wins:      0,
    returnSum: 0,
    maxGain:   -Infinity,
    maxLoss:   Infinity,
  };
}

// ─── 多檔批次組合回測 ──────────────────────────────────────────────────
export async function runComboBacktest(items, onProgress, opts = {}) {
  const { sampleStep = 1, signal = null, combos = DEFAULT_COMBOS } = opts;
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
        const bt = runComboBacktestSingle(candles, combos, { sampleStep });
        result = { code, name, type, ...bt };
      } catch (err) {
        result = { code, name, type, ok: false, reason: err.message || 'unknown' };
      }
    }

    perStock.push(result);
    try { await onProgress?.(i + 1, items.length, item, perStock); } catch {}
    await new Promise(r => setTimeout(r, 0));
  }

  // 跨股彙總
  const aggregated = _aggregateAcrossStocks(perStock, combos);

  return {
    ok: true,
    perStock,
    aggregated,
    combos,
    aborted,
    formula: 'combo-bt-v1',
  };
}

// 跨股彙整每個組合的「三亮」/ 「過濾」勝率
function _aggregateAcrossStocks(perStock, combos) {
  const agg = {};

  for (const combo of combos) {
    agg[combo.key] = {
      ...combo,
      all:    {},
      filter: {},
    };
    for (const D of HOLD_DAYS) {
      for (const T of WIN_TARGETS) {
        const key = `${D}d-${(T*100).toFixed(0)}pct`;
        agg[combo.key].all[key]    = _newAggStat(D, T);
        agg[combo.key].filter[key] = _newAggStat(D, T);
      }
    }
  }

  // 累加
  for (const stock of perStock) {
    if (!stock.ok || !stock.stats) continue;
    for (const comboKey in stock.stats) {
      for (const condType of ['all', 'filter']) {
        for (const outKey in stock.stats[comboKey][condType]) {
          const sc = stock.stats[comboKey][condType][outKey];
          const ac = agg[comboKey][condType][outKey];
          if (!ac || sc.triggers === 0) continue;
          ac.triggers  += sc.triggers;
          ac.wins      += sc.wins;
          ac.returnSum += sc.avgReturn * sc.triggers;
          if (sc.maxGain != null && sc.maxGain > ac.maxGain) ac.maxGain = sc.maxGain;
          if (sc.maxLoss != null && sc.maxLoss < ac.maxLoss) ac.maxLoss = sc.maxLoss;
        }
      }
    }
  }

  // 算最終
  for (const comboKey in agg) {
    for (const condType of ['all', 'filter']) {
      for (const outKey in agg[comboKey][condType]) {
        const c = agg[comboKey][condType][outKey];
        if (c.triggers === 0) {
          c.winRate = c.avgReturn = c.maxGain = c.maxLoss = null;
        } else {
          c.winRate   = c.wins / c.triggers;
          c.avgReturn = c.returnSum / c.triggers;
        }
        delete c.returnSum;
      }
    }
  }

  return agg;
}

function _newAggStat(D, T) {
  return {
    holdDays:  D,
    winTarget: T,
    triggers:  0,
    wins:      0,
    returnSum: 0,
    maxGain:   -Infinity,
    maxLoss:   Infinity,
  };
}

// 找每個組合 × 每種條件的最佳出場
export function findBestComboCondition(aggregated) {
  const result = [];
  for (const comboKey in aggregated) {
    const combo = aggregated[comboKey];

    const _findBest = (combos) => {
      let best = null;
      let bestScore = -Infinity;
      for (const key in combos) {
        const c = combos[key];
        if (c.triggers < 3) continue;  // 樣本至少 3 才算 (組合更稀有)
        if (c.winRate == null || c.avgReturn == null) continue;
        const score = c.winRate * (c.avgReturn + 0.01);
        if (score > bestScore) {
          bestScore = score;
          best = { key, ...c };
        }
      }
      return best;
    };

    result.push({
      ...combo,
      bestAll:    _findBest(combo.all),
      bestFilter: _findBest(combo.filter),
    });
  }
  return result;
}
