/**
 * screener.js
 * Phase 2 篩選邏輯
 *
 * 兩階段篩選：
 *   Phase A（瞬間）：TWSE STOCK_DAY_ALL → 價格、漲跌幅、成交量
 *   Phase B（批次）：Yahoo Finance K線 → 技術指標（KD、RSI、MACD、均線）
 *
 * export：
 *   runScreener(conditions, opts)   → AsyncGenerator，yield { type, payload }
 *   matchConditions(row, conds)     → boolean
 *   CONDITION_DEFS                  → 條件定義清單
 *   loadSavedSets()                 → async
 *   saveSet(name, conditions)       → async
 *   deleteSavedSet(name)            → async
 */

import { fetchTWSEPrices, fetchScreenerData, fetchScreenerDataFinMind, fetchFundamentals, fetchForeignBuyDays, getChineseName, getAllKnownCodes } from './api.js';
import { calcKD, calcRSI, calcMACD, calcMA, calcBollinger, calcBBWidth,
         calcEMA, calcGMMA, calcBias, calcPSY, calcRCI, calcDMI, calcSAR, calcHV,
         calcIchimoku } from './indicators.js';
import { Config, getFinMindToken } from './config.js';
import { getAllScreenerSets, saveScreenerSet, deleteScreenerSet } from './db.js';
import { getPeersOf } from './industry-groups.js';

// ─────────────────────────────────────────────
// 內部工具函式
// ─────────────────────────────────────────────

/**
 * v2.7+ 條件 label 完整格式化:把「半句 label」+「value」+「unit」拼成完整句
 *
 * 修法緣由(永久備忘):
 *   舊版 matchedConds 只塞 def.label,X 系列策略 label 是「XXX ≥」這種半句,
 *   結果在篩選結果頁變成「近10日累計漲幅 ≥」尾巴空空。
 *   修法是拼接 value + unit;同時處理三類特殊 label:
 *     1. 含「N」佔位符(industry_leading: 「同族群 ≥N 檔 RSI>70」)→ replace
 *     2. 含「（… ≥）」括弧內結尾運算符(vol_surge_drop)→ insert
 *     3. boolean type → 純 label,不加 value
 *
 * @param {object} cond  { def, value }  def 來自 CONDITION_DEFS
 * @returns {string} 顯示用完整字串
 */
function _formatCondLabel(cond) {
  const def   = cond.def;
  const value = cond.value;
  const label = def.label || def.id;
  const unit  = def.unit  || '';

  // 1) Boolean 型:純 label,不接 value
  if (def.type === 'boolean') return label;

  // 2) value 不存在 → fallback 純 label
  if (value == null) return label;

  // 數值格式化:整數不要 .00、小數保留必要位數
  const valStr = Number.isInteger(value)
    ? String(value)
    : (Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

  // 3) 含「N」佔位符 → 替換成實際 value
  //    例:「同族群 ≥N 檔 RSI>70」 + value=2 → 「同族群 ≥2 檔 RSI>70」
  if (label.includes('≥N')) {
    return label.replace('≥N', `≥${valStr}`);
  }
  if (label.includes('N天') || label.includes('N日') || label.includes('連續N')) {
    return label.replace(/N(?=天|日|根)/, valStr) + (unit && !label.includes(unit) ? unit : '');
  }

  // 4) 結尾是「≥」「×」「＞」這種運算符 → 後面接 value + unit
  //    例:「近10日累計漲幅 ≥」 + 15 + 「%」 → 「近10日累計漲幅 ≥ 15%」
  if (/[≥≤＞＜<>×=]$/.test(label)) {
    return `${label} ${valStr}${unit}`;
  }

  // 5) 含括弧結尾(例如「放量下跌（量≥1.5×MV20 且 跌≥）」)
  //    在「）」前插入 value + unit
  if (label.endsWith('）')) {
    return label.replace(/）$/, ` ${valStr}${unit}）`);
  }

  // 6) Fallback:label 後接「value + unit」
  return `${label} ${valStr}${unit}`.trim();
}

/**
 * v2.7+ 為某檔股票準備 industryContext(從 candleMap 動態計算同族群 peers 的 RSI)
 *
 * 用途:供 X4「何時輪到我」策略條件「industry_leading」使用
 *
 * @param {string} code  本股代號
 * @param {Map<string, Candle[]>} candleMap  本次篩選 Phase 2 的 K 線總集
 * @returns {object|null}  { code, peers: [{ code, rsi }] } 或 null(無同族群成員 K 線)
 *
 * ⚠️ 永久備忘:
 *   - peers 來自 hardcode 族群表(industry-groups.js),半年需更新
 *   - 若同族群成員未通過 Phase 1(沒進 candleMap)會被自然排除
 *   - 完全沒 peers 時回 null,X4 會自動失敗(industry_leading.match)
 */
function _buildIndustryContextForScreener(code, candleMap) {
  if (!candleMap || !candleMap.size) return null;
  const peers = getPeersOf(code);
  if (!peers.length) return null;

  const peerRsi = [];
  for (const peerCode of peers) {
    const peerCandles = candleMap.get(peerCode);
    if (!peerCandles || peerCandles.length < 15) continue;
    const closes = peerCandles.map(c => c.close);
    const rsi    = calcRSI(closes, 14);
    const last   = rsi?.[rsi.length - 1];
    if (Number.isFinite(last)) {
      peerRsi.push({ code: peerCode, rsi: last });
    }
  }

  if (!peerRsi.length) return null;
  return { code, peers: peerRsi };
}

/**
 * v2.7+ 計算「此條件組合」過去 N 根的觸發歷史
 *
 * 演算法:
 *   1. 從最後一根往回滾 N 根
 *   2. 每根重跑「所有 conditions 的 calc + match」
 *   3. 記錄:
 *      - streak: 從今天往回算的「不間斷觸發」天數
 *      - firstTriggerDate: streak 段的最早日期
 *      - isNew: streak === 1
 *      - totalTriggers: N 根內總觸發次數(含中間斷掉的)
 *
 * 效能考量:
 *   - 每根 calc 是 O(n),n=回看 idx 內的根數
 *   - 50 檔 × 120 根 × 平均 5 條件 ≈ 3 萬次 calc,實測 3-8 秒
 *   - 由 Config.screenerTriggerHistory 控制(預設 true)
 *
 * ⚠️ 注意:
 *   - 只跑 Phase 1 + Phase 2 條件(Phase 3 基本面條件跳過,因為歷史 fund 不可得)
 *   - twseRow 為當日值,歷史比對時會從 sliced candles 重建
 *
 * @param {Array} conditions  完整 conditions(含 Phase 1+2+3)
 * @param {Candle[]} candles
 * @param {object|null} twseRow
 * @param {Map<string, Candle[]>} candleMap  用來重建歷史 industryContext
 * @param {number} lookback   回看根數,預設 120
 * @returns {object|null}  { streak, firstTriggerDate, isNew, totalTriggers } 或 null
 */
function _calcConditionTriggerHistory(conditions, candles, twseRow, candleMap, lookback = 120) {
  // 只取 Phase 1 + Phase 2 條件(Phase 3 基本面歷史不可得)
  const histConds = conditions.filter(c => c.def.phase !== 3);
  if (!histConds.length) return null;

  const p1Conds = histConds.filter(c => c.def.phase === 1);
  const p2Conds = histConds.filter(c => c.def.phase === 2);

  const N = Math.min(lookback, candles.length);
  if (N < 20) return null;

  // 預先 build industryContext(120 根都用同一個 — peers RSI 用最新值,簡化)
  // ⚠️ 簡化決策:歷史 streak 計算時 peers 也應該用「該時點」的 RSI 才精準,
  //    但這樣計算量會 ×N 倍(每根都要重算所有 peers RSI),效能上不可行。
  //    所以這裡用「當前 industryContext」當近似值,X4 的歷史 streak 是粗估。
  //    若有人質疑 X4 歷史準度問題,再考慮加重採樣機制。
  const industryContext = _buildIndustryContextForScreener(candles._code || '', candleMap);

  // 由 candles 自身的最後一根重建 twseRow(若未提供)
  function _buildTwseAt(sliced) {
    if (sliced.length < 2) return null;
    const last = sliced[sliced.length - 1];
    const prev = sliced[sliced.length - 2];
    const chgPct = prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
    return {
      price:  last.close,
      chgPct: chgPct,
      volume: Math.round((last.volume ?? 0) / 1000),
    };
  }

  // 比對單根:回傳 true/false
  function _matchAt(idx) {
    const sliced = candles.slice(0, idx + 1);
    if (sliced.length < 20) return false;
    const twse = idx === candles.length - 1 ? twseRow : _buildTwseAt(sliced);

    // Phase 1
    if (p1Conds.length && twse) {
      const p1Pass = p1Conds.every(c => c.def.match(twse, c.value));
      if (!p1Pass) return false;
    }

    // Phase 2:跑所有 calc(去重)
    const indicators = {};
    const calcDone   = new Set();
    for (const cond of p2Conds) {
      if (cond.def.calc && !calcDone.has(cond.def.id)) {
        try {
          Object.assign(indicators, cond.def.calc(sliced));
        } catch (_) { return false; }
        calcDone.add(cond.def.id);
      }
    }
    if (industryContext) indicators._industryContext = industryContext;

    return p2Conds.every(c => c.def.match(indicators, c.value));
  }

  // 今天必須觸發(否則此股不會出現在篩選結果,但保險起見)
  const todayIdx = candles.length - 1;
  if (!_matchAt(todayIdx)) return null;

  let streak           = 1;
  let firstTriggerIdx  = todayIdx;
  let totalTriggers    = 1;
  let streakBroken     = false;

  for (let back = 1; back < N; back++) {
    const idx = todayIdx - back;
    if (idx < 19) break;
    const triggered = _matchAt(idx);
    if (triggered) {
      totalTriggers++;
      if (!streakBroken) {
        streak++;
        firstTriggerIdx = idx;
      }
    } else {
      streakBroken = true;
    }
  }

  const firstCandle = candles[firstTriggerIdx];
  const firstDate   = firstCandle?.time || firstCandle?.date || null;

  return {
    streak,
    firstTriggerDate: firstDate,
    isNew:            streak === 1,
    totalTriggers,
  };
}

/**
 * 線性回歸斜率（pattern 趨勢判定用）
 * 對序列 y[0..n-1] 配 y = a + b*x，回傳 b（斜率）
 * 正向上升、負向下跌、接近 0 為橫盤
 * @param {number[]} ys
 * @returns {number}
 */
function _linearSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (!Number.isFinite(y)) continue;
    sumX  += i;
    sumY  += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

// ─────────────────────────────────────────────
// 條件定義（供 UI 動態建立條件列使用）
// ─────────────────────────────────────────────
export const CONDITION_DEFS = [
  // ── 價格 / 量能（第一階段，TWSE 直接過濾）
  {
    id:      'price_min',
    group:   'price',
    label:   '股價 ≥',
    unit:    '元',
    type:    'number',
    default: 10,
    phase:   1,
    match: (row, v) => row.price >= v,
  },
  {
    id:      'price_max',
    group:   'price',
    label:   '股價 ≤',
    unit:    '元',
    type:    'number',
    default: 1000,
    phase:   1,
    match: (row, v) => row.price <= v,
  },
  {
    id:      'chg_min',
    group:   'price',
    label:   '漲跌幅 ≥',
    unit:    '%',
    type:    'number',
    default: 3,
    phase:   1,
    match: (row, v) => row.chgPct >= v,
  },
  {
    id:      'chg_max',
    group:   'price',
    label:   '漲跌幅 ≤',
    unit:    '%',
    type:    'number',
    default: -3,
    phase:   1,
    match: (row, v) => row.chgPct <= v,
  },
  {
    id:      'vol_min',
    group:   'volume',
    label:   '成交量 ≥',
    unit:    '張',
    type:    'number',
    default: 1000,
    phase:   1,
    match: (row, v) => row.volume >= v,
  },
  {
    id:      'vol_max',
    group:   'volume',
    label:   '成交量 ≤',
    unit:    '張',
    type:    'number',
    default: 100000,
    phase:   1,
    match: (row, v) => row.volume <= v,
  },

  // ── 技術指標（第二階段，需 K 線）
  {
    id:      'rsi_min',
    group:   'technical',
    label:   'RSI(14) ≥',
    unit:    '',
    type:    'number',
    default: 50,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const rsi    = calcRSI(closes, 14);
      return { rsi: rsi[rsi.length - 1] };
    },
    match: (indicators, v) => indicators.rsi != null && indicators.rsi >= v,
  },
  {
    id:      'rsi_max',
    group:   'technical',
    label:   'RSI(14) ≤',
    unit:    '',
    type:    'number',
    default: 30,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const rsi    = calcRSI(closes, 14);
      return { rsi: rsi[rsi.length - 1] };
    },
    match: (indicators, v) => indicators.rsi != null && indicators.rsi <= v,
  },
  {
    id:      'kd_k_min',
    group:   'technical',
    label:   'KD-K ≥',
    unit:    '',
    type:    'number',
    default: 50,
    phase:   2,
    calc: candles => {
      const { k } = calcKD(candles, 9);
      return { kdK: k[k.length - 1] };
    },
    match: (indicators, v) => indicators.kdK != null && indicators.kdK >= v,
  },
  {
    id:      'kd_k_max',
    group:   'technical',
    label:   'KD-K ≤',
    unit:    '',
    type:    'number',
    default: 20,
    phase:   2,
    calc: candles => {
      const { k } = calcKD(candles, 9);
      return { kdK: k[k.length - 1] };
    },
    match: (indicators, v) => indicators.kdK != null && indicators.kdK <= v,
  },
  {
    id:      'kd_golden',
    group:   'technical',
    label:   'KD 黃金交叉',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const { k, d } = calcKD(candles, 9);
      const n        = k.length;
      const golden   = n >= 2 && k[n-1] > d[n-1] && k[n-2] <= d[n-2];
      return { kdGolden: golden };
    },
    match: (indicators) => indicators.kdGolden === true,
  },
  {
    id:      'kd_dead',
    group:   'technical',
    label:   'KD 死亡交叉',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const { k, d } = calcKD(candles, 9);
      const n        = k.length;
      const dead     = n >= 2 && k[n-1] < d[n-1] && k[n-2] >= d[n-2];
      return { kdDead: dead };
    },
    match: (indicators) => indicators.kdDead === true,
  },
  {
    id:      'macd_golden',
    group:   'technical',
    label:   'MACD 黃金交叉',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes           = candles.map(c => c.close);
      const { dif, sigLine } = calcMACD(closes);
      const n                = dif.length;
      const golden           = n >= 2 && dif[n-1] > sigLine[n-1] && dif[n-2] <= sigLine[n-2];
      return { macdGolden: golden };
    },
    match: (indicators) => indicators.macdGolden === true,
  },
  {
    id:      'macd_dead',
    group:   'technical',
    label:   'MACD 死亡交叉',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes           = candles.map(c => c.close);
      const { dif, sigLine } = calcMACD(closes);
      const n                = dif.length;
      const dead             = n >= 2 && dif[n-1] < sigLine[n-1] && dif[n-2] >= sigLine[n-2];
      return { macdDead: dead };
    },
    match: (indicators) => indicators.macdDead === true,
  },
  {
    id:      'macd_hist_pos',
    group:   'technical',
    label:   'MACD Histogram > 0',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes   = candles.map(c => c.close);
      const { hist } = calcMACD(closes);
      return { macdHistPos: hist[hist.length - 1] > 0 };
    },
    match: (indicators) => indicators.macdHistPos === true,
  },
  {
    id:      'above_ma20',
    group:   'ma',
    label:   '股價 > MA20',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes    = candles.map(c => c.close);
      const ma20      = calcMA(closes, 20);
      const lastMA    = ma20[ma20.length - 1];
      const lastClose = closes[closes.length - 1];
      return { aboveMA20: lastMA != null && lastClose > lastMA };
    },
    match: (indicators) => indicators.aboveMA20 === true,
  },
  {
    id:      'below_ma20',
    group:   'ma',
    label:   '股價 < MA20',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes    = candles.map(c => c.close);
      const ma20      = calcMA(closes, 20);
      const lastMA    = ma20[ma20.length - 1];
      const lastClose = closes[closes.length - 1];
      return { belowMA20: lastMA != null && lastClose < lastMA };
    },
    match: (indicators) => indicators.belowMA20 === true,
  },
  {
    id:      'ma5_cross_ma20',
    group:   'ma',
    label:   'MA5 上穿 MA20',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma5    = calcMA(closes, 5);
      const ma20   = calcMA(closes, 20);
      const n      = ma5.length;
      const cross  = n >= 2
        && ma5[n-1]  != null && ma20[n-1]  != null
        && ma5[n-2]  != null && ma20[n-2]  != null
        && ma5[n-1] > ma20[n-1] && ma5[n-2] <= ma20[n-2];
      return { ma5CrossMA20: cross };
    },
    match: (indicators) => indicators.ma5CrossMA20 === true,
  },

  // ══════════════════════════════════════════════
  // ── 第二批新增條件（S4/S5/S9/S20–S23 所需）
  // ══════════════════════════════════════════════

  /**
   * high_n_days：收盤價為近 N 日最高（含今日）
   * S4「近期創高」使用，N 預設 20
   */
  {
    id:      'high_n_days',
    group:   'price',
    label:   '近N日新高（N=）',
    unit:    '日',
    type:    'number',
    default: 20,
    phase:   2,
    calc: candles => {
      // 用最近 N 根 K 棒（含今日）判斷今日收盤是否為最高
      // 實際 N 在 match 時從 value 讀取，calc 先算出近 60 日的每日最高供比較
      const closes = candles.map(c => c.close);
      return { closeSeries: closes };          // 把完整收盤序列帶入，match 再切片
    },
    match: (indicators, v) => {
      const { closeSeries } = indicators;
      if (!closeSeries || closeSeries.length < v) return false;
      const slice   = closeSeries.slice(-v);
      const maxVal  = Math.max(...slice);
      const lastVal = closeSeries[closeSeries.length - 1];
      return lastVal >= maxVal;               // 今日收盤 = 近 N 日最高
    },
  },

  /**
   * vol_surge：今日成交量 ≥ 近 N 日均量的 X 倍
   * S5「爆量異動」使用，預設 N=20, X=3
   * 格式：value = X（倍數），計算時固定用近20日均量
   */
  {
    id:      'vol_surge',
    group:   'volume',
    label:   '成交量 ≥ 近20日均量 ×',
    unit:    '倍',
    type:    'number',
    default: 3,
    phase:   2,
    calc: candles => {
      const vols   = candles.map(c => c.volume);
      const n      = Math.min(20, vols.length - 1);     // 不含今日的近20日
      if (n < 5) return { volSurgeRatio: null };
      const avgVol = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
      const ratio  = avgVol > 0 ? vols[vols.length - 1] / avgVol : null;
      return { volSurgeRatio: ratio };
    },
    match: (indicators, v) =>
      indicators.volSurgeRatio != null && indicators.volSurgeRatio >= v,
  },

  /**
   * vol_shrink：今日成交量 ≤ 近 N 日均量的 X 倍（量縮）
   * S9「跌深量縮」使用，預設 X=0.7（即量縮至均量 70% 以下）
   */
  {
    id:      'vol_shrink',
    group:   'volume',
    label:   '成交量 ≤ 近20日均量 ×',
    unit:    '倍',
    type:    'number',
    default: 0.7,
    phase:   2,
    calc: candles => {
      const vols   = candles.map(c => c.volume);
      const n      = Math.min(20, vols.length - 1);
      if (n < 5) return { volShrinkRatio: null };
      const avgVol = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
      const ratio  = avgVol > 0 ? vols[vols.length - 1] / avgVol : null;
      return { volShrinkRatio: ratio };
    },
    match: (indicators, v) =>
      indicators.volShrinkRatio != null && indicators.volShrinkRatio <= v,
  },

  /**
   * drop_n_days：近 N 日（含今日）累計跌幅 ≤ -X%
   * S9「跌深量縮」使用，預設 N=3, X=3
   * value = 跌幅下限（負數，如 -3 代表跌超過 3%）
   */
  {
    id:      'drop_n_days',
    group:   'price',
    label:   '近3日累計跌幅 ≤',
    unit:    '%',
    type:    'number',
    default: -3,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      if (closes.length < 4) return { drop3d: null };
      // 近3日：今日 vs 3日前收盤
      const now  = closes[closes.length - 1];
      const prev = closes[closes.length - 4];   // 往前3根
      const pct  = prev > 0 ? (now - prev) / prev * 100 : null;
      return { drop3d: pct };
    },
    match: (indicators, v) =>
      indicators.drop3d != null && indicators.drop3d <= v,
  },

  /**
   * ma20_turn_up：MA20 最新斜率由負轉正（或轉平）
   * 葛蘭碧買一底層條件：MA20 由跌轉平或上揚
   * 判斷：ma20[n-1] >= ma20[n-2]（今日 MA20 不低於昨日）
   */
  {
    id:      'ma20_turn_up',
    group:   'ma',
    label:   'MA20 由跌轉揚',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = ma20.length;
      // 需要至少3個 MA20 點：前2日下跌，今日轉平/上揚
      const turnUp = n >= 3
        && ma20[n-1] != null && ma20[n-2] != null && ma20[n-3] != null
        && ma20[n-1] >= ma20[n-2]        // 今日不再下跌
        && ma20[n-2] <  ma20[n-3];       // 前一日還在下跌（確認是「轉折」不是「持續上揚」）
      return { ma20TurnUp: turnUp };
    },
    match: (indicators) => indicators.ma20TurnUp === true,
  },

  /**
   * price_cross_ma20_up：股價從 MA20 下方向上突破
   * 葛蘭碧買一/買二：前一日收盤在 MA20 以下，今日突破 MA20
   */
  {
    id:      'price_cross_ma20_up',
    group:   'ma',
    label:   '股價向上突破 MA20',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      const cross  = n >= 2
        && ma20[n-1] != null && ma20[n-2] != null
        && closes[n-1] >  ma20[n-1]      // 今日在 MA20 上
        && closes[n-2] <= ma20[n-2];     // 昨日在 MA20 下（或剛好等於）
      return { priceCrossMA20Up: cross };
    },
    match: (indicators) => indicators.priceCrossMA20Up === true,
  },

  /**
   * price_above_ma20：股價目前在 MA20 上方（不需要今日才突破）
   * 葛蘭碧買二/買三共用底層：確認目前在均線上方
   * 注意：above_ma20 已存在且完全相同，此條目為別名，供策略語意更清晰
   * → 直接複用 above_ma20，不重複定義
   */

  /**
   * price_bounce_ma20：股價回踩 MA20 後今日收回 MA20 上方
   * 葛蘭碧買二：回測不破後反彈
   * 判斷：昨日收盤 ≤ MA20（碰到或跌破），今日收盤 > MA20
   */
  {
    id:      'price_bounce_ma20',
    group:   'ma',
    label:   '回踩 MA20 後反彈',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      const bounce = n >= 2
        && ma20[n-1] != null && ma20[n-2] != null
        && closes[n-2] <= ma20[n-2]      // 昨日觸碰或跌破 MA20
        && closes[n-1] >  ma20[n-1];     // 今日收回 MA20 上方
      return { priceBounceMA20: bounce };
    },
    match: (indicators) => indicators.priceBounceMA20 === true,
  },

  /**
   * price_reclaim_ma20：股價短暫跌破 MA20 後今日收回（葛蘭碧買三）
   * 與 price_bounce_ma20 相同判斷邏輯，但語意上強調「短暫跌破後收回」
   * 加上 MA20 本身仍在上揚（確保是上升趨勢中的回踩）
   */
  {
    id:      'price_reclaim_ma20',
    group:   'ma',
    label:   '跌破 MA20 後快速收回',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      // 條件：昨日跌破 MA20（< 而非 <=），今日收回，且 MA20 趨勢向上
      const reclaim = n >= 3
        && ma20[n-1] != null && ma20[n-2] != null && ma20[n-3] != null
        && closes[n-2] <  ma20[n-2]       // 昨日確實跌破（而非只是碰到）
        && closes[n-1] >  ma20[n-1]       // 今日收回
        && ma20[n-1]   >= ma20[n-3];      // MA20 整體仍向上（與2日前比）
      return { priceReclaimMA20: reclaim };
    },
    match: (indicators) => indicators.priceReclaimMA20 === true,
  },

  /**
   * price_far_below_ma20：股價遠低於 MA20（嚴重超跌）
   * 葛蘭碧買四：乖離率 ≤ -X%，預設 -10%
   * value = 乖離率下限（負數，如 -10 代表跌離 MA20 超過 10%）
   */
  {
    id:      'price_far_below_ma20',
    group:   'ma',
    label:   'MA20 乖離率 ≤',
    unit:    '%',
    type:    'number',
    default: -10,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      const lastMA = ma20[n - 1];
      if (!lastMA) return { ma20Bias: null };
      const bias   = (closes[n - 1] - lastMA) / lastMA * 100;
      return { ma20Bias: bias };
    },
    match: (indicators, v) =>
      indicators.ma20Bias != null && indicators.ma20Bias <= v,
  },

  // ══════════════════════════════════════════════
  // 布林通道條件（第三批，S13–S15）
  // ══════════════════════════════════════════════

  /**
   * bb_squeeze：布林帶極度窄縮
   * 判斷：今日帶寬（width%）≤ 近 60 日帶寬第 20 百分位數
   * value = 百分位門檻（預設 20，即帶寬排在近60日最窄的 20%）
   * S13「箱型突破」/ S15「整理待發」使用
   */
  {
    id:      'bb_squeeze',
    group:   'bollinger',
    label:   '布林帶窄縮（帶寬百分位 ≤）',
    unit:    '%',
    type:    'number',
    default: 20,
    phase:   2,
    calc: candles => {
      const closes   = candles.map(c => c.close);
      const widths   = calcBBWidth(closes, 20, 2).filter(w => w !== null);
      if (widths.length < 10) return { bbWidthPct: null };
      const sorted   = [...widths].sort((a, b) => a - b);
      const cur      = widths[widths.length - 1];
      // 今日帶寬在歷史帶寬序列中的百分位（越小 = 越窄）
      const rank     = sorted.findIndex(w => w >= cur);
      const pctRank  = rank < 0 ? 100 : +(rank / sorted.length * 100).toFixed(1);
      return { bbWidthPct: pctRank };
    },
    match: (indicators, v) =>
      indicators.bbWidthPct != null && indicators.bbWidthPct <= v,
  },

  /**
   * bb_expanding：布林帶開口放大（帶寬由小轉大）
   * 判斷：今日帶寬 > 昨日帶寬 > 前日帶寬（連續2日放大）
   * S13「箱型突破」搭配 bb_squeeze 一起用：先窄縮後放大 = 突破訊號
   */
  {
    id:      'bb_expanding',
    group:   'bollinger',
    label:   '布林帶開口放大',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes  = candles.map(c => c.close);
      const widths  = calcBBWidth(closes, 20, 2);
      const n       = widths.length;
      // 需要最後3個有效帶寬
      const last3   = widths.slice(n - 3).filter(w => w !== null);
      const expanding = last3.length === 3
        && last3[2] > last3[1]
        && last3[1] > last3[0];
      return { bbExpanding: expanding };
    },
    match: (indicators) => indicators.bbExpanding === true,
  },

  /**
   * bb_upper_touch：股價收盤貼近或觸碰布林上軌
   * 判斷：今日收盤 ≥ 上軌 × (1 - tolerance)，tolerance 預設 1%
   * value = 容許距離 %（預設 1，即收盤在上軌 1% 以內視為貼上軌）
   * S14「強勢鈍化」使用
   */
  {
    id:      'bb_upper_touch',
    group:   'bollinger',
    label:   '收盤貼近布林上軌（距離 ≤）',
    unit:    '%',
    type:    'number',
    default: 1,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const bands  = calcBollinger(closes, 20, 2);
      const last   = bands[bands.length - 1];
      if (!last) return { bbUpperDist: null };
      // 距離上軌的百分比（正 = 在上軌以下，負 = 已突破上軌）
      const dist = (last.upper - closes[closes.length - 1]) / last.upper * 100;
      return { bbUpperDist: +dist.toFixed(2) };
    },
    match: (indicators, v) =>
      indicators.bbUpperDist != null && indicators.bbUpperDist <= v,
  },

  /**
   * bb_lower_touch：股價收盤貼近或觸碰布林下軌
   * 判斷：今日收盤 ≤ 下軌 × (1 + tolerance)
   * value = 容許距離 %（預設 1，即收盤在下軌 1% 以內視為貼下軌）
   * 超跌反彈策略輔助條件
   */
  {
    id:      'bb_lower_touch',
    group:   'bollinger',
    label:   '收盤貼近布林下軌（距離 ≤）',
    unit:    '%',
    type:    'number',
    default: 1,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const bands  = calcBollinger(closes, 20, 2);
      const last   = bands[bands.length - 1];
      if (!last) return { bbLowerDist: null };
      // 距離下軌的百分比（正 = 在下軌以上，負 = 已跌破下軌）
      const dist = (closes[closes.length - 1] - last.lower) / last.lower * 100;
      return { bbLowerDist: +dist.toFixed(2) };
    },
    match: (indicators, v) =>
      indicators.bbLowerDist != null && indicators.bbLowerDist <= v,
  },

  // ══════════════════════════════════════════════
  // Advanced 5 — 新技術指標條件
  // ══════════════════════════════════════════════

  /**
   * ema_bull：EMA5 > EMA20（短期均線多頭排列）
   */
  {
    id:      'ema_bull',
    group:   'trend',
    label:   'EMA5 > EMA20（均線多頭）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      const ema5  = calcEMA(closes, 5);
      const ema20 = calcEMA(closes, 20);
      return { emaBull: ema5[n - 1] != null && ema20[n - 1] != null && ema5[n - 1] > ema20[n - 1] };
    },
    match: (indicators) => indicators.emaBull === true,
  },

  /**
   * ema_cross_up：EMA5 由下往上新穿越 EMA20（近3日內）
   */
  {
    id:      'ema_cross_up',
    group:   'trend',
    label:   'EMA5 新穿越 EMA20（上穿）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      if (n < 22) return { emaCrossUp: false };
      const ema5  = calcEMA(closes, 5);
      const ema20 = calcEMA(closes, 20);
      // 今日 EMA5 > EMA20，且昨日 EMA5 <= EMA20（穿越那根）
      const crossToday = ema5[n - 1] > ema20[n - 1] && ema5[n - 2] <= ema20[n - 2];
      const crossYest  = n >= 3 && ema5[n - 2] > ema20[n - 2] && ema5[n - 3] <= ema20[n - 3];
      return { emaCrossUp: crossToday || crossYest };
    },
    match: (indicators) => indicators.emaCrossUp === true,
  },

  /**
   * bias20_low：MA20 乖離率 < 閾值（超跌）
   * value 預設 -8（即乖離率 < -8%）
   */
  {
    id:      'bias20_low',
    group:   'trend',
    label:   'MA20 乖離率 ≤（超跌）',
    unit:    '%',
    type:    'number',
    default: -8,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const bias = calcBias(closes, 20);
      const n = closes.length;
      return { bias20: bias[n - 1] };
    },
    match: (indicators, v) => indicators.bias20 != null && indicators.bias20 <= v,
  },

  /**
   * psy_oversold：PSY(12) < 25（極度超賣）
   */
  {
    id:      'psy_oversold',
    group:   'momentum',
    label:   'PSY(12) 超賣（< 25）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const psy = calcPSY(closes, 12);
      const n = closes.length;
      return { psy12: psy[n - 1] };
    },
    match: (indicators) => indicators.psy12 != null && indicators.psy12 < 25,
  },

  /**
   * psy_overbought：PSY(12) > 75（極度超買警示）
   */
  {
    id:      'psy_overbought',
    group:   'momentum',
    label:   'PSY(12) 超買（> 75）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const psy = calcPSY(closes, 12);
      const n = closes.length;
      return { psy12ob: psy[n - 1] };
    },
    match: (indicators) => indicators.psy12ob != null && indicators.psy12ob > 75,
  },

  /**
   * rci9_turn_up：RCI(9) 從 -80 以下翻轉向上
   */
  {
    id:      'rci9_turn_up',
    group:   'momentum',
    label:   'RCI(9) 從極低翻升',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const rci = calcRCI(closes, 9);
      const n = closes.length;
      // 昨日 RCI < -80，今日 RCI > 昨日（翻轉）
      const prev = rci[n - 2];
      const cur  = rci[n - 1];
      return { rci9TurnUp: prev != null && cur != null && prev < -80 && cur > prev };
    },
    match: (indicators) => indicators.rci9TurnUp === true,
  },

  /**
   * dmi_bull：+DI > -DI 且 ADX > 20（多頭趨勢確認）
   */
  {
    id:      'dmi_bull',
    group:   'trend',
    label:   'DMI 多頭趨勢（+DI > -DI & ADX > 20）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      if (candles.length < 30) return { dmiBull: false, adxVal: null };
      const { plusDI, minusDI, adx } = calcDMI(candles, 14);
      const n = candles.length;
      const pdi = plusDI[n - 1], mdi = minusDI[n - 1], adxV = adx[n - 1];
      return {
        dmiBull: pdi != null && mdi != null && adxV != null && pdi > mdi && adxV > 20,
        adxVal:  adxV,
        dmiPlusDI: pdi,
        dmiMinusDI: mdi,
      };
    },
    match: (indicators) => indicators.dmiBull === true,
  },

  /**
   * dmi_strong：ADX > 25（強趨勢確認，避免盤整假訊號）
   */
  {
    id:      'dmi_strong',
    group:   'trend',
    label:   'ADX 強趨勢（> 25）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      if (candles.length < 30) return { adxStrong: false };
      const { adx } = calcDMI(candles, 14);
      const n = candles.length;
      const adxV = adx[n - 1];
      return { adxStrong: adxV != null && adxV > 25, adxVal2: adxV };
    },
    match: (indicators) => indicators.adxStrong === true,
  },

  /**
   * sar_bull：SAR 拋物線翻到股價下方（多頭啟動）
   */
  {
    id:      'sar_bull',
    group:   'trend',
    label:   'SAR 拋物線翻多',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      if (candles.length < 32) return { sarBull: false };
      const sarArr = calcSAR(candles);
      const n = candles.length;
      const sarNow  = sarArr[n - 1];
      const sarPrev = sarArr[n - 2];
      const closeNow  = candles[n - 1].close;
      const closePrev = candles[n - 2].close;
      // 今日 SAR < 收盤（多頭），且昨日 SAR > 昨日收盤（昨空頭）= 剛翻多
      const justTurned = sarNow != null && sarPrev != null
        && sarNow < closeNow && sarPrev > closePrev;
      // 或昨日已翻多（2日內翻多都算）
      const sarNow2  = sarArr[n - 2];
      const sarPrev2 = n >= 3 ? sarArr[n - 3] : null;
      const closePrev2 = n >= 3 ? candles[n - 3].close : null;
      const turnedYest = sarNow2 != null && sarPrev2 != null && closePrev2 != null
        && sarNow2 < closePrev && sarPrev2 > closePrev2;
      return { sarBull: justTurned || turnedYest };
    },
    match: (indicators) => indicators.sarBull === true,
  },

  /**
   * hv_low：歷史波動率（年化）< 閾值（低波動潛伏）
   * value 預設 25（即 HV < 25%）
   */
  {
    id:      'hv_low',
    group:   'volatility',
    label:   'HV 波動率 ≤（低波動）',
    unit:    '%',
    type:    'number',
    default: 25,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const hv = calcHV(closes, 20);
      const n = closes.length;
      return { hvVal: hv[n - 1] };
    },
    match: (indicators, v) => indicators.hvVal != null && indicators.hvVal <= v,
  },

  /**
   * env_touch_lower：收盤觸及包絡線下軌（超跌反彈候選）
   * 用 MA20 ± 5% 包絡線，收盤在下軌以下或下軌 1% 以內
   */
  {
    id:      'env_touch_lower',
    group:   'trend',
    label:   '包絡線下軌觸及（超跌反彈）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      if (n < 20) return { envTouchLower: false };
      const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const lower = ma20 * 0.95; // 5% 包絡線下軌
      const cur = closes[n - 1];
      return { envTouchLower: cur <= lower * 1.01 }; // 1% 容許區間
    },
    match: (indicators) => indicators.envTouchLower === true,
  },

  /**
   * gmma_bull：GMMA 顧比均線短期組全穿越長期組（強勢多頭趨勢）
   */
  {
    id:      'gmma_bull',
    group:   'trend',
    label:   'GMMA 短期組全穿越長期組（多頭）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      if (closes.length < 62) return { gmmaBull: false };
      const { short, long } = calcGMMA(closes);
      const n = closes.length;
      const shortMin = Math.min(...short.map(s => s[n - 1]));
      const longMax  = Math.max(...long.map(l => l[n - 1]));
      return { gmmaBull: shortMin > longMax };
    },
    match: (indicators) => indicators.gmmaBull === true,
  },

  // ══════════════════════════════════════════════
  // C1 — Ichimoku 一目均衡表條件（5 個）
  // 至少 52 根才有 SenkouB，三役好轉需要 26 日前資料 → 至少 52 根
  // ══════════════════════════════════════════════

  /**
   * ichi_3good：三役好轉（最強多頭訊號）
   * Tenkan > Kijun + 收盤 > 雲帶上緣 + 延遲線 > 26 日前收盤
   */
  {
    id:      'ichi_3good',
    group:   'trend',
    label:   'Ichimoku 三役好轉（最強多頭）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 52) return { ichi3Good: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready) return { ichi3Good: false };
      const last = n - 1;
      const tenkan = ichi.tenkan[last];
      const kijun  = ichi.kijun[last];
      // 雲帶上下緣：取 senkouA/B 中 time = 當下 candle 的值
      // senkouA/B 是位移後的陣列，第 i 個 value 對應 candles[i+shift] 的時間
      // 想取「當下」的雲帶值，要找 senkouA/B 中時間最接近 candles[last].time 的點
      const lastTime = candles[last].time;
      const a = ichi.senkouA.find(p => p.time === lastTime)?.value;
      const b = ichi.senkouB.find(p => p.time === lastTime)?.value;
      const close = candles[last].close;
      // Chikou 對比：candles[last - 26] 的位置畫的是 candles[last].close
      // 等價於：candles[last].close vs candles[last - 26].close
      const chikouOK = n > 26 && candles[last].close > candles[n - 27].close;
      const cloudTop = (a != null && b != null) ? Math.max(a, b) : null;
      const aboveCloud = cloudTop != null && close > cloudTop;
      const tkOK = tenkan != null && kijun != null && tenkan > kijun;
      return { ichi3Good: tkOK && aboveCloud && chikouOK };
    },
    match: (indicators) => indicators.ichi3Good === true,
  },

  /**
   * ichi_cloud_above：收盤位於雲帶上方（趨勢多頭）
   */
  {
    id:      'ichi_cloud_above',
    group:   'trend',
    label:   'Ichimoku 站上雲帶（趨勢多頭）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 52) return { ichiCloudAbove: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready) return { ichiCloudAbove: false };
      const lastTime = candles[n - 1].time;
      const a = ichi.senkouA.find(p => p.time === lastTime)?.value;
      const b = ichi.senkouB.find(p => p.time === lastTime)?.value;
      if (a == null || b == null) return { ichiCloudAbove: false };
      const cloudTop = Math.max(a, b);
      return { ichiCloudAbove: candles[n - 1].close > cloudTop };
    },
    match: (indicators) => indicators.ichiCloudAbove === true,
  },

  /**
   * ichi_tk_cross：轉換線剛黃金交叉基準線（近 3 日內）
   * Tenkan 由下往上穿越 Kijun
   */
  {
    id:      'ichi_tk_cross',
    group:   'trend',
    label:   'Ichimoku TK 黃金交叉（近 3 日）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 30) return { ichiTKCross: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready) return { ichiTKCross: false };
      // 掃描最近 3 天找黃金交叉：tenkan[i-1] <= kijun[i-1] && tenkan[i] > kijun[i]
      for (let i = Math.max(1, n - 3); i < n; i++) {
        const t0 = ichi.tenkan[i - 1], k0 = ichi.kijun[i - 1];
        const t1 = ichi.tenkan[i],     k1 = ichi.kijun[i];
        if (t0 != null && k0 != null && t1 != null && k1 != null
            && t0 <= k0 && t1 > k1) {
          return { ichiTKCross: true };
        }
      }
      return { ichiTKCross: false };
    },
    match: (indicators) => indicators.ichiTKCross === true,
  },

  /**
   * ichi_bull_cloud：未來雲帶為多頭雲（SenkouA > SenkouB 在未來 26 日）
   * 取最末（第 26 日未來）的 SenkouA/B 比較
   */
  {
    id:      'ichi_bull_cloud',
    group:   'trend',
    label:   'Ichimoku 未來雲帶為多頭',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 52) return { ichiBullCloud: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready || ichi.senkouA.length === 0) return { ichiBullCloud: false };
      // 取最遠的未來點（即 candles[n-1] 算出來的 senkouA/B）
      const lastA = ichi.senkouA[ichi.senkouA.length - 1]?.value;
      const lastB = ichi.senkouB[ichi.senkouB.length - 1]?.value;
      if (lastA == null || lastB == null) return { ichiBullCloud: false };
      return { ichiBullCloud: lastA > lastB };
    },
    match: (indicators) => indicators.ichiBullCloud === true,
  },

  /**
   * ichi_chikou_above：延遲線位於 26 日前收盤上方（中期動能向上）
   */
  {
    id:      'ichi_chikou_above',
    group:   'trend',
    label:   'Ichimoku 延遲線突破歷史價',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 27) return { ichiChikouAbove: false };
      // 延遲線：candles[n-1].close 對比 candles[n-27].close
      return { ichiChikouAbove: candles[n - 1].close > candles[n - 27].close };
    },
    match: (indicators) => indicators.ichiChikouAbove === true,
  },

  // ══════════════════════════════════════════════
  // Advanced 5 — K線型態條件
  // 嚴格閾值降低誤判；高低點差距 < 3%，配合量能
  // ══════════════════════════════════════════════

  /**
   * three_soldiers：紅三兵
   * 條件：最近3根都是陽線（收>開）且收盤遞增，每根實體 > 前根的50%
   */
  {
    id:      'three_soldiers',
    group:   'pattern',
    label:   '紅三兵（連3陽線遞增）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 3) return { threeSoldiers: false };
      const c = candles.slice(-3);
      const allBull = c.every(k => k.close > k.open);
      const closing  = c[0].close < c[1].close && c[1].close < c[2].close;
      // 每根實體不能太小（避免十字線蒙混）
      const bodies   = c.map(k => Math.abs(k.close - k.open));
      const noTiny   = bodies.every((b, i) => i === 0 || b >= bodies[i - 1] * 0.5);
      return { threeSoldiers: allBull && closing && noTiny };
    },
    match: (indicators) => indicators.threeSoldiers === true,
  },

  /**
   * bullish_engulfing：多頭吞噬（環抱線）
   * 條件：昨日陰線，今日陽線完全吞噬昨日實體
   */
  {
    id:      'bullish_engulfing',
    group:   'pattern',
    label:   '多頭吞噬（陽吞陰）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 2) return { bullishEngulfing: false };
      const prev = candles[n - 2];
      const cur  = candles[n - 1];
      // 昨陰今陽，且今日實體完全包住昨日實體
      const prevBear = prev.close < prev.open;
      const curBull  = cur.close > cur.open;
      const engulf   = cur.open <= prev.close && cur.close >= prev.open;
      return { bullishEngulfing: prevBear && curBull && engulf };
    },
    match: (indicators) => indicators.bullishEngulfing === true,
  },

  /**
   * three_valleys：三重底（三川）
   * 五道防線收嚴（v2.5 修正，與 three_peaks 完全對稱）：
   *   1. Pivot 嚴格化：左右各 5 根必須「嚴格大於」當前低點，不允許並列
   *   2. 相近門檻動態：價格 <20 用 1.5%，20-100 用 2.0%，>=100 用 3.1%
   *      （低價股 3% 太鬆，11 元股票 3% 才 0.33 元，日內就達到）
   *   3. 對立極點檢查：三個低點之間夾的兩個高點，必須每個都比相鄰低點高 ≥ 2%
   *      （確認是 N 字型,不是平台震盪）
   *   4. 形成型態前的趨勢方向：第一個低點之前 20 根 close 線性回歸「歸一化」
   *      斜率 ≤ -0.0005/根（20 根累積 ≈ -1%），代表確實是下跌中打底
   *   5. 目前趨勢狀態否決（三項全部要過,任一不過即否決）:
   *      5a. MA20 近 10 根歸一化斜率 ≥ -0.003/根（不可還在強跌中,要轉平/上揚）
   *      5b. ADX(14) < 25（不可是強趨勢,要趨勢轉弱中）
   *      5c. 第三低點之後的走勢驗證:之後到現在的收盤均值要 > 第三低點 × 1.005
   *          （已經開始走強,不只是橫盤）
   */
  {
    id:      'three_valleys',
    group:   'pattern',
    label:   '三重底（三川）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 50) return { threeValleys: false };  // 需要更多歷史檢查趨勢
      const seg = candles.slice(-60);
      const sN  = seg.length;
      // 防線 1：找局部低點，左右各 5 根「嚴格」較高
      const valleys = [];
      for (let i = 5; i < sN - 5; i++) {
        const low = seg[i].low ?? seg[i].close;
        const isLocal = [1,2,3,4,5].every(d =>
          (seg[i-d]?.low ?? seg[i-d]?.close ?? Infinity) >  low &&
          (seg[i+d]?.low ?? seg[i+d]?.close ?? Infinity) >  low
        );
        if (isLocal) valleys.push({ idx: i, low });
      }
      if (valleys.length < 3) return { threeValleys: false };
      // 取最後三個低點
      const last3 = valleys.slice(-3);
      const lows  = last3.map(v => v.low);
      const minL  = Math.min(...lows);
      const maxL  = Math.max(...lows);
      if (maxL <= 0) return { threeValleys: false };
      // 防線 2：相近門檻動態化
      const avgPrice = (minL + maxL) / 2;
      const simThreshold = avgPrice < 20 ? 0.015 : (avgPrice < 100 ? 0.020 : 0.031);
      const similar = (maxL - minL) / maxL < simThreshold;
      if (!similar) return { threeValleys: false };
      // 防線 3：對立極點檢查（兩低點之間要夾明顯較高的高點，≥2%）
      const N_VALLEY_GAP_MIN = 0.02;
      for (let k = 0; k < 2; k++) {
        const segHi = seg.slice(last3[k].idx + 1, last3[k + 1].idx);
        if (segHi.length === 0) return { threeValleys: false };
        const maxHi = Math.max(...segHi.map(c => c.high ?? c.close));
        const lowBoundary = Math.max(last3[k].low, last3[k + 1].low);
        if ((maxHi - lowBoundary) / lowBoundary < N_VALLEY_GAP_MIN) {
          return { threeValleys: false };
        }
      }
      // 防線 4：形成型態前的趨勢方向 — 歸一化斜率,要顯著向下
      // 不再用 raw slope > 0,改用歸一化(slope/avg)避免微波動誤判
      const firstIdx = last3[0].idx;
      const preStart = Math.max(0, firstIdx - 20);
      const preCloses = seg.slice(preStart, firstIdx).map(c => c.close);
      if (preCloses.length >= 5) {
        const slope = _linearSlope(preCloses);
        const avgPre = preCloses.reduce((a, b) => a + b, 0) / preCloses.length;
        const normSlope = avgPre > 0 ? slope / avgPre : 0;
        // 三川要求「下跌中打底」→ 歸一化斜率 ≤ -0.0005/根(20根累積 ≈ -1%)
        if (normSlope > -0.0005) return { threeValleys: false };
      }

      // ── 防線 5：目前趨勢狀態否決(三項全部要過) ──
      // 5a. MA20 近 10 根歸一化斜率 ≥ -0.003/根(不再強跌,要轉平/上揚)
      const allCloses = candles.map(c => c.close);
      const ma20Arr = calcMA(allCloses, 20);
      const recentMA20 = ma20Arr.slice(-10).filter(Number.isFinite);
      if (recentMA20.length >= 5) {
        const ma20Slope = _linearSlope(recentMA20);
        const ma20Avg = recentMA20.reduce((a, b) => a + b, 0) / recentMA20.length;
        const ma20NormSlope = ma20Avg > 0 ? ma20Slope / ma20Avg : 0;
        if (ma20NormSlope < -0.003) return { threeValleys: false };  // MA20 還在強跌
      }
      // 5b. ADX(14) < 25(不可是強趨勢)
      try {
        const dmi = calcDMI(candles, 14);
        if (dmi?.adx?.length) {
          const lastAdx = dmi.adx[dmi.adx.length - 1];
          if (Number.isFinite(lastAdx) && lastAdx >= 25) {
            return { threeValleys: false };  // 強趨勢中,不可能是底部反轉
          }
        }
      } catch (e) { /* DMI 失敗就略過此項檢查 */ }
      // 5c. 第三低點之後的走勢驗證:之後到現在的收盤均值要 > 第三低點 × 1.005
      //     (代表已經開始走強,不只是橫盤)
      const lastValleyIdx = last3[2].idx;
      const afterCloses = seg.slice(lastValleyIdx + 1).map(c => c.close).filter(Number.isFinite);
      if (afterCloses.length >= 2) {
        const avgAfter = afterCloses.reduce((a, b) => a + b, 0) / afterCloses.length;
        if (avgAfter <= last3[2].low * 1.005) {
          return { threeValleys: false };  // 第三低點之後沒走強,還在底部徘徊
        }
      }

      return { threeValleys: true };
    },
    match: (indicators) => indicators.threeValleys === true,
  },

  /**
   * three_peaks：三重頂（three_valleys 完全對稱版,v2.5）
   * 五道防線收嚴(對應三山,參照 three_valleys 註解)
   */
  {
    id:      'three_peaks',
    group:   'pattern',
    label:   '三重頂（三山）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 50) return { threePeaks: false };
      const seg = candles.slice(-60);
      const sN  = seg.length;
      // 防線 1：Pivot 嚴格化
      const peaks = [];
      for (let i = 5; i < sN - 5; i++) {
        const high = seg[i].high ?? seg[i].close;
        const isLocal = [1,2,3,4,5].every(d =>
          (seg[i-d]?.high ?? seg[i-d]?.close ?? 0) <  high &&
          (seg[i+d]?.high ?? seg[i+d]?.close ?? 0) <  high
        );
        if (isLocal) peaks.push({ idx: i, high });
      }
      if (peaks.length < 3) return { threePeaks: false };
      const last3 = peaks.slice(-3);
      const highs = last3.map(v => v.high);
      const minH  = Math.min(...highs);
      const maxH  = Math.max(...highs);
      if (maxH <= 0) return { threePeaks: false };
      // 防線 2：相近門檻動態化
      const avgPrice = (minH + maxH) / 2;
      const simThreshold = avgPrice < 20 ? 0.015 : (avgPrice < 100 ? 0.020 : 0.031);
      const similar = (maxH - minH) / maxH < simThreshold;
      if (!similar) return { threePeaks: false };
      // 防線 3：對立極點檢查(兩高點之間要夾明顯較低的低點,≥2%)
      const N_PEAK_GAP_MIN = 0.02;
      for (let k = 0; k < 2; k++) {
        const segLo = seg.slice(last3[k].idx + 1, last3[k + 1].idx);
        if (segLo.length === 0) return { threePeaks: false };
        const minLo = Math.min(...segLo.map(c => c.low ?? c.close));
        const highBoundary = Math.min(last3[k].high, last3[k + 1].high);
        if ((highBoundary - minLo) / highBoundary < N_PEAK_GAP_MIN) {
          return { threePeaks: false };
        }
      }
      // 防線 4：形成型態前的趨勢方向 — 歸一化斜率,要顯著向上
      const firstIdx = last3[0].idx;
      const preStart = Math.max(0, firstIdx - 20);
      const preCloses = seg.slice(preStart, firstIdx).map(c => c.close);
      if (preCloses.length >= 5) {
        const slope = _linearSlope(preCloses);
        const avgPre = preCloses.reduce((a, b) => a + b, 0) / preCloses.length;
        const normSlope = avgPre > 0 ? slope / avgPre : 0;
        // 三山要求「上漲中築頂」→ 歸一化斜率 ≥ +0.0005/根
        if (normSlope < 0.0005) return { threePeaks: false };
      }

      // ── 防線 5：目前趨勢狀態否決(三項全部要過) ──
      // 5a. MA20 近 10 根歸一化斜率 ≤ +0.003/根(不再強漲,要轉平/下彎)
      const allCloses = candles.map(c => c.close);
      const ma20Arr = calcMA(allCloses, 20);
      const recentMA20 = ma20Arr.slice(-10).filter(Number.isFinite);
      if (recentMA20.length >= 5) {
        const ma20Slope = _linearSlope(recentMA20);
        const ma20Avg = recentMA20.reduce((a, b) => a + b, 0) / recentMA20.length;
        const ma20NormSlope = ma20Avg > 0 ? ma20Slope / ma20Avg : 0;
        if (ma20NormSlope > 0.003) return { threePeaks: false };  // MA20 還在強漲
      }
      // 5b. ADX(14) < 25(不可是強趨勢)
      try {
        const dmi = calcDMI(candles, 14);
        if (dmi?.adx?.length) {
          const lastAdx = dmi.adx[dmi.adx.length - 1];
          if (Number.isFinite(lastAdx) && lastAdx >= 25) {
            return { threePeaks: false };  // 強趨勢中,不可能是頂部反轉
          }
        }
      } catch (e) { /* DMI 失敗就略過此項檢查 */ }
      // 5c. 第三高點之後的走勢驗證:之後到現在的收盤均值要 < 第三高點 × 0.995
      //     (代表已經開始走弱,不只是橫盤)
      const lastPeakIdx = last3[2].idx;
      const afterCloses = seg.slice(lastPeakIdx + 1).map(c => c.close).filter(Number.isFinite);
      if (afterCloses.length >= 2) {
        const avgAfter = afterCloses.reduce((a, b) => a + b, 0) / afterCloses.length;
        if (avgAfter >= last3[2].high * 0.995) {
          return { threePeaks: false };  // 第三高點之後沒走弱,還在高點附近
        }
      }

      return { threePeaks: true };
    },
    match: (indicators) => indicators.threePeaks === true,
  },

  /**
   * cup_and_handle：杯柄形態
   * 條件：
   *   1. 杯：前段最高點 → 回落 → 回到最高點附近（杯深 < 35%）
   *   2. 柄：回到杯緣後小幅回落（< 15%），量縮
   *   3. 最新收盤突破杯緣（杯左側高點）
   * ⚠️ 需要至少 60 根以上
   */
  {
    id:      'cup_and_handle',
    group:   'pattern',
    label:   '杯柄形態（U型整理突破）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 60) return { cupAndHandle: false };
      const seg    = candles.slice(-80);
      const sN     = seg.length;
      const closes = seg.map(c => c.close);
      const highs  = seg.map(c => c.high ?? c.close);
      const vols   = seg.map(c => c.volume ?? 0);

      // 杯左側高點（前段最高）
      const cupLeft = Math.max(...highs.slice(0, Math.floor(sN * 0.4)));
      // 杯底（最低點）
      const cupBottom = Math.min(...closes.slice(Math.floor(sN * 0.2), Math.floor(sN * 0.8)));
      // 杯深
      const cupDepth = cupLeft > 0 ? (cupLeft - cupBottom) / cupLeft : 1;
      if (cupDepth >= 0.35) return { cupAndHandle: false }; // 杯太深

      // 柄部（後段 20%）
      const handleSeg  = closes.slice(-Math.floor(sN * 0.2));
      const handleHigh = Math.max(...handleSeg);
      const handleDrop = handleHigh > 0 ? (handleHigh - closes[closes.length - 1]) / handleHigh : 1;
      if (handleDrop >= 0.15) return { cupAndHandle: false }; // 柄太深

      // 最新收盤要接近或突破杯左側高點
      const lastClose  = closes[closes.length - 1];
      const nearRim    = lastClose >= cupLeft * 0.97;

      // 柄部量縮（柄段均量 < 整體均量）
      const handleVols = vols.slice(-Math.floor(sN * 0.2));
      const handleAvgV = handleVols.reduce((a, b) => a + b, 0) / handleVols.length;
      const totalAvgV  = vols.reduce((a, b) => a + b, 0) / vols.length;
      const volShrink  = handleAvgV < totalAvgV * 0.9;

      return { cupAndHandle: nearRim && volShrink };
    },
    match: (indicators) => indicators.cupAndHandle === true,
  },

  // ══════════════════════════════════════════════
  // Phase C 條件（基本面，需 FinMind Token）
  // calc 收到的是 fundamentals 物件，而非 candles
  // ══════════════════════════════════════════════

  // PE 本益比
  {
    id:      'pe_max',
    group:   'fundamental',
    label:   'PE ≤',
    unit:    'x',
    type:    'number',
    default: 15,
    phase:   3,
    match: (fund, v) => fund.pe != null && fund.pe > 0 && fund.pe <= v,
  },

  // PB 股價淨值比
  {
    id:      'pb_max',
    group:   'fundamental',
    label:   'PB ≤',
    unit:    'x',
    type:    'number',
    default: 1.5,
    phase:   3,
    match: (fund, v) => fund.pbRatio != null && fund.pbRatio > 0 && fund.pbRatio <= v,
  },

  // 殖利率
  {
    id:      'div_yield_min',
    group:   'fundamental',
    label:   '殖利率 ≥',
    unit:    '%',
    type:    'number',
    default: 3,
    phase:   3,
    match: (fund, v) => fund.dividendYield != null && fund.dividendYield * 100 >= v,
  },

  // 最新季 EPS > 0
  {
    id:      'eps_positive',
    group:   'fundamental',
    label:   '最新季 EPS > 0',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   3,
    match: (fund) => fund.eps != null && fund.eps > 0,
  },

  // EPS 年增率（YoY）≥ N%
  {
    id:      'eps_growth_yoy',
    group:   'fundamental',
    label:   'EPS 年增率 ≥',
    unit:    '%',
    type:    'number',
    default: 10,
    phase:   3,
    match: (fund, v) => fund.earningsGrowth != null && fund.earningsGrowth * 100 >= v,
  },

  // 毛利率 ≥ N%
  {
    id:      'gross_margin_min',
    group:   'fundamental',
    label:   '毛利率 ≥',
    unit:    '%',
    type:    'number',
    default: 30,
    phase:   3,
    match: (fund, v) => {
      const m = fund._marginSeries?.[0]?.grossMargin;
      return m != null && m >= v;
    },
  },

  // 淨利率 ≥ N%
  {
    id:      'net_margin_min',
    group:   'fundamental',
    label:   '淨利率 ≥',
    unit:    '%',
    type:    'number',
    default: 10,
    phase:   3,
    match: (fund, v) => {
      const m = fund._marginSeries?.[0]?.netMargin ?? (fund.profitMargin != null ? fund.profitMargin * 100 : null);
      return m != null && m >= v;
    },
  },

  // 營收年增率 ≥ N%
  {
    id:      'revenue_growth_yoy',
    group:   'fundamental',
    label:   '營收年增率 ≥',
    unit:    '%',
    type:    'number',
    default: 10,
    phase:   3,
    match: (fund, v) => fund.revenueGrowth != null && fund.revenueGrowth * 100 >= v,
  },

  // EPS 連續成長 N 季
  {
    id:      'eps_consecutive_growth',
    group:   'fundamental',
    label:   'EPS 連續成長',
    unit:    '季',
    type:    'number',
    default: 3,
    phase:   3,
    match: (fund, v) => {
      const series = fund._epsSeries;
      if (!series || series.length < v + 1) return false;
      // series 是降冪（最新在前），檢查最新 v 季是否每季都比前一季大
      for (let i = 0; i < v; i++) {
        if (series[i].eps <= series[i + 1].eps) return false;
      }
      return true;
    },
  },

  // PEG < N（PE / EPS成長率）
  {
    id:      'peg_max',
    group:   'fundamental',
    label:   'PEG <',
    unit:    '',
    type:    'number',
    default: 1,
    phase:   3,
    match: (fund, v) => {
      if (!fund.pe || fund.pe <= 0) return false;
      if (!fund.earningsGrowth || fund.earningsGrowth <= 0) return false;
      const peg = fund.pe / (fund.earningsGrowth * 100);
      return peg < v;
    },
  },

  // 外資連續買超 N 日（走獨立 fetchForeignBuyDays API）
  {
    id:      'foreign_buy_days',
    group:   'fundamental',
    label:   '外資連續買超',
    unit:    '日',
    type:    'number',
    default: 3,
    phase:   3,
    _useForeign: true,   // 標記：需要打外資歷史 API，而非 fetchFundamentals
    match: (fund, v) => {
      // fund._foreignHistory 由 Phase C 額外注入
      const hist = fund._foreignHistory;
      if (!hist || hist.length < v) return false;
      for (let i = 0; i < v; i++) {
        if (hist[i].net <= 0) return false;
      }
      return true;
    },
  },

  // ══════════════════════════════════════════════════
  // 避險專用條件（對應 W11~W20，BEARISH_COMPLETE 0522_2340）
  // ══════════════════════════════════════════════════

  /**
   * ma20_turn_down：MA20 由揚轉跌（葛蘭碧賣一）
   * 對稱於 ma20_turn_up
   */
  {
    id:      'ma20_turn_down',
    group:   'ma',
    label:   'MA20 由揚轉跌',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = ma20.length;
      const turnDown = n >= 3
        && ma20[n-1] != null && ma20[n-2] != null && ma20[n-3] != null
        && ma20[n-1] <= ma20[n-2]      // 今日不再上揚
        && ma20[n-2] >  ma20[n-3];     // 前一日仍在上揚（確認轉折）
      return { ma20TurnDown: turnDown };
    },
    match: (indicators) => indicators.ma20TurnDown === true,
  },

  /**
   * price_cross_ma20_down：股價從 MA20 上方向下跌破（葛蘭碧賣一）
   * 對稱於 price_cross_ma20_up
   */
  {
    id:      'price_cross_ma20_down',
    group:   'ma',
    label:   '股價向下跌破 MA20',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      const cross  = n >= 2
        && ma20[n-1] != null && ma20[n-2] != null
        && closes[n-1] <  ma20[n-1]      // 今日在 MA20 下
        && closes[n-2] >= ma20[n-2];     // 昨日在 MA20 上（或剛好等於）
      return { priceCrossMA20Down: cross };
    },
    match: (indicators) => indicators.priceCrossMA20Down === true,
  },

  /**
   * price_rally_fail_ma20：月線下反彈觸線後再下跌（葛蘭碧賣二）
   * 條件：昨日 close 觸碰或站上 MA20，今日 close 又跌回 MA20 下，MA20 仍向下
   */
  {
    id:      'price_rally_fail_ma20',
    group:   'ma',
    label:   '月線下反彈失敗',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      const fail   = n >= 3
        && ma20[n-1] != null && ma20[n-2] != null && ma20[n-3] != null
        && closes[n-2] >= ma20[n-2]      // 昨日反彈觸線（碰到或站上）
        && closes[n-1] <  ma20[n-1]      // 今日跌回月線下
        && ma20[n-1]   <= ma20[n-3];     // MA20 整體仍向下（與2日前比）
      return { priceRallyFailMA20: fail };
    },
    match: (indicators) => indicators.priceRallyFailMA20 === true,
  },

  /**
   * price_far_above_ma20：股價遠高於 MA20（嚴重超漲，葛蘭碧賣三/賣四）
   * 對稱於 price_far_below_ma20
   * value = 乖離率上限（正數，如 5 代表漲離 MA20 超過 5%）
   */
  {
    id:      'price_far_above_ma20',
    group:   'ma',
    label:   'MA20 乖離率 ≥',
    unit:    '%',
    type:    'number',
    default: 5,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = closes.length;
      const lastMA = ma20[n - 1];
      if (!lastMA) return { ma20BiasUp: null };
      const bias   = (closes[n - 1] - lastMA) / lastMA * 100;
      return { ma20BiasUp: bias };
    },
    match: (indicators, v) =>
      indicators.ma20BiasUp != null && indicators.ma20BiasUp >= v,
  },

  /**
   * ma20_declining：MA20 連續 N 日下彎（葛蘭碧賣三/賣四的趨勢確認）
   * value = 連續下彎天數，預設 3
   */
  {
    id:      'ma20_declining',
    group:   'ma',
    label:   'MA20 連續下彎',
    unit:    '日',
    type:    'number',
    default: 3,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma20   = calcMA(closes, 20);
      const n      = ma20.length;
      return { ma20Series: ma20, ma20Len: n };
    },
    match: (indicators, v) => {
      const arr = indicators.ma20Series;
      const n   = indicators.ma20Len;
      if (!arr || !n || n < v + 1) return false;
      // 最後 v 天每天都比前一天低
      for (let i = 0; i < v; i++) {
        const cur  = arr[n - 1 - i];
        const prev = arr[n - 2 - i];
        if (cur == null || prev == null || cur >= prev) return false;
      }
      return true;
    },
  },

  /**
   * ma_bear_array：均線空頭排列（MA5 < MA10 < MA20，且三線皆下彎）
   * 對應 W12
   */
  {
    id:      'ma_bear_array',
    group:   'ma',
    label:   '均線空頭排列（MA5<MA10<MA20 且皆下彎）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma5  = calcMA(closes, 5);
      const ma10 = calcMA(closes, 10);
      const ma20 = calcMA(closes, 20);
      const n    = ma20.length;
      if (n < 2) return { maBearArray: false };
      const a5  = ma5[n-1],  a10 = ma10[n-1], a20 = ma20[n-1];
      const b5  = ma5[n-2],  b10 = ma10[n-2], b20 = ma20[n-2];
      if (a5 == null || a10 == null || a20 == null) return { maBearArray: false };
      if (b5 == null || b10 == null || b20 == null) return { maBearArray: false };
      const order   = a5 < a10 && a10 < a20;       // 空頭排列
      const allDown = a5 < b5 && a10 < b10 && a20 < b20;  // 三線皆下彎
      return { maBearArray: order && allDown };
    },
    match: (indicators) => indicators.maBearArray === true,
  },

  /**
   * vol_surge_drop：放量下跌（量增價跌）— W13 專用單一條件
   * 條件：vol ≥ MV20 × 1.5 且 chg ≤ -2%
   * value = 跌幅門檻（負數，預設 -2）
   */
  {
    id:      'vol_surge_drop',
    group:   'volume',
    label:   '放量下跌（量≥1.5×MV20 且 跌≥）',
    unit:    '%',
    type:    'number',
    default: -2,
    phase:   2,
    calc: candles => {
      const n      = candles.length;
      if (n < 2) return { volSurgeDropChg: null, volSurgeDropOK: false };
      const vols   = candles.map(c => c.volume);
      const win    = Math.min(20, n - 1);
      if (win < 5) return { volSurgeDropChg: null, volSurgeDropOK: false };
      const avgVol = vols.slice(-win - 1, -1).reduce((a, b) => a + b, 0) / win;
      const volOK  = avgVol > 0 && vols[n - 1] >= avgVol * 1.5;
      const prevClose = candles[n - 2].close;
      const chg    = prevClose > 0 ? (candles[n - 1].close - prevClose) / prevClose * 100 : 0;
      return { volSurgeDropChg: chg, volSurgeDropOK: volOK };
    },
    match: (indicators, v) =>
      indicators.volSurgeDropOK === true
      && indicators.volSurgeDropChg != null
      && indicators.volSurgeDropChg <= v,
  },

  /**
   * macd_dead_above_zero：MACD 高位死叉（DIF > 0 時死叉）— W14
   * 比一般 macd_dead 危險（行情已飆高才轉折）
   */
  {
    id:      'macd_dead_above_zero',
    group:   'technical',
    label:   'MACD 高位死叉（DIF>0 時死叉）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes           = candles.map(c => c.close);
      const { dif, sigLine } = calcMACD(closes);
      const n                = dif.length;
      const dead   = n >= 2 && dif[n-1] < sigLine[n-1] && dif[n-2] >= sigLine[n-2];
      const highDead = dead && dif[n-1] > 0;
      return { macdDeadAboveZero: highDead };
    },
    match: (indicators) => indicators.macdDeadAboveZero === true,
  },

  /**
   * ichi_below_cloud：收盤跌破雲層下緣（W11，最強中長線空頭確認）
   * 對應 ichi_cloud_above 的反向
   */
  {
    id:      'ichi_below_cloud',
    group:   'trend',
    label:   'Ichimoku 跌破雲層下緣（最強空頭確認）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 52) return { ichiBelowCloud: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready) return { ichiBelowCloud: false };
      const last = n - 1;
      const lastTime = candles[last].time;
      const a = ichi.senkouA.find(p => p.time === lastTime)?.value;
      const b = ichi.senkouB.find(p => p.time === lastTime)?.value;
      if (a == null || b == null) return { ichiBelowCloud: false };
      const cloudBottom = Math.min(a, b);
      const close = candles[last].close;
      return { ichiBelowCloud: close < cloudBottom };
    },
    match: (indicators) => indicators.ichiBelowCloud === true,
  },

  /**
   * ichi_in_cloud：收盤在雲層內（趨勢不明 + 壓力，W19 子集）
   */
  {
    id:      'ichi_in_cloud',
    group:   'trend',
    label:   'Ichimoku 雲層內震盪',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 52) return { ichiInCloud: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready) return { ichiInCloud: false };
      const last = n - 1;
      const lastTime = candles[last].time;
      const a = ichi.senkouA.find(p => p.time === lastTime)?.value;
      const b = ichi.senkouB.find(p => p.time === lastTime)?.value;
      if (a == null || b == null) return { ichiInCloud: false };
      const cloudTop    = Math.max(a, b);
      const cloudBottom = Math.min(a, b);
      const close = candles[last].close;
      return { ichiInCloud: close >= cloudBottom && close <= cloudTop };
    },
    match: (indicators) => indicators.ichiInCloud === true,
  },

  /**
   * ichi_tk_dead：轉換線 < 基準線（W16，早期轉弱預警）
   * 對應 ichi_tk_cross 的反向（轉換線在基準線下方）
   */
  {
    id:      'ichi_tk_dead',
    group:   'trend',
    label:   'Ichimoku 轉換線 < 基準線',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 52) return { ichiTkDead: false };
      const ichi = calcIchimoku(candles);
      if (!ichi._meta.ready) return { ichiTkDead: false };
      const last = n - 1;
      const tenkan = ichi.tenkan[last];
      const kijun  = ichi.kijun[last];
      if (tenkan == null || kijun == null) return { ichiTkDead: false };
      return { ichiTkDead: tenkan < kijun };
    },
    match: (indicators) => indicators.ichiTkDead === true,
  },

  /**
   * dmi_bear：DMI 空頭確認（-DI > +DI 且 ADX ≥ 25）— W17
   * 對稱於 dmi_bull
   */
  {
    id:      'dmi_bear',
    group:   'trend',
    label:   'DMI 空頭趨勢（-DI > +DI & ADX ≥ 25）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      if (candles.length < 30) return { dmiBear: false };
      const { plusDI, minusDI, adx } = calcDMI(candles, 14);
      const n = candles.length;
      const pdi = plusDI[n - 1], mdi = minusDI[n - 1], adxV = adx[n - 1];
      return {
        dmiBear: pdi != null && mdi != null && adxV != null && mdi > pdi && adxV >= 25,
      };
    },
    match: (indicators) => indicators.dmiBear === true,
  },

  // ═════════════════════════════════════════════════════════════
  // X 系列實驗策略專用條件（Experimental — 未進五燈獎評分）
  // 對應策略:X1 黃金比例 / X2 天黑請閉眼 / X3 炒底王 / X4 何時輪到我
  // 設計原則:單參數(value=主要門檻),其他副參數寫死在 calc 內
  // ═════════════════════════════════════════════════════════════

  /**
   * vol_surge_short:今日成交量 ≥ 近 10 日均量 × value 倍
   * X1 黃金比例(value=2)、X3 炒底王(value=1.2)使用
   * 用較短的 10 日均量基期,反應「啟動量」而非長期慣量
   */
  {
    id:      'vol_surge_short',
    group:   'volume',
    label:   '成交量 ≥ 近10日均量 ×',
    unit:    '倍',
    type:    'number',
    default: 2,
    phase:   2,
    calc: candles => {
      const vols = candles.map(c => c.volume);
      const n    = Math.min(10, vols.length - 1);
      if (n < 3) return { volSurge10: null };
      const avg = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
      const ratio = avg > 0 ? vols[vols.length - 1] / avg : null;
      return { volSurge10: ratio };
    },
    match: (indicators, v) =>
      indicators.volSurge10 != null && indicators.volSurge10 >= v,
  },

  /**
   * vol_surge_long:今日成交量 ≥ 近 30 日均量 × value 倍
   * X2 天黑請閉眼(value=3)使用
   * 用較長的 30 日均量基期,過濾「日常熱門股」,要求真正異常爆量
   */
  {
    id:      'vol_surge_long',
    group:   'volume',
    label:   '成交量 ≥ 近30日均量 ×',
    unit:    '倍',
    type:    'number',
    default: 3,
    phase:   2,
    calc: candles => {
      const vols = candles.map(c => c.volume);
      const n    = Math.min(30, vols.length - 1);
      if (n < 10) return { volSurge30: null };
      const avg = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
      // ⚠️ 踩雷備忘（永久，2026-05-26）：
      //   盤中時最後一根 volume 是「累計到現在」的量，不是全天量。
      //   若現在是盤中，用已過時間比例預估全天量，避免量被低估導致 X2 算不到。
      //   台灣盤中：09:00–13:30（270分鐘），線性外推
      let lastVol = vols[vols.length - 1];
      const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const day  = tw.getUTCDay();
      const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
      const isTradingNow = day >= 1 && day <= 5 && mins >= 9 * 60 && mins <= 13 * 60 + 30;
      if (isTradingNow && mins > 9 * 60) {
        const elapsed   = mins - 9 * 60;       // 已過幾分鐘
        const totalMins = 13 * 60 + 30 - 9 * 60; // 全天 270 分鐘
        const ratio     = elapsed / totalMins;
        if (ratio > 0.1) lastVol = lastVol / ratio; // 線性外推全天量
      }
      const surgeRatio = avg > 0 ? lastVol / avg : null;
      return { volSurge30: surgeRatio };
    },
    match: (indicators, v) =>
      indicators.volSurge30 != null && indicators.volSurge30 >= v,
  },

  /**
   * gain_10d:過去 10 個交易日累計漲幅 ≥ value(%)
   * X2 天黑請閉眼(value=15)使用 — 確認「已經在飆」
   * 計算方式:(今日收盤 - 10根前收盤) / 10根前收盤 × 100
   */
  {
    id:      'gain_10d',
    group:   'momentum',
    label:   '近10日累計漲幅 ≥',
    unit:    '%',
    type:    'number',
    default: 15,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      if (n < 11) return { gain10d: null };
      const today = closes[n - 1];
      const base  = closes[n - 11];   // 10 根前(含今日共 11 根)
      const gain  = base > 0 ? (today - base) / base * 100 : null;
      return { gain10d: gain };
    },
    match: (indicators, v) =>
      indicators.gain10d != null && indicators.gain10d >= v,
  },

  /**
   * loss_5d:過去 5 個交易日累計跌幅 ≥ value(%)
   * X3 炒底王(value=5)使用 — 確認「真的跌過」才算反彈
   * 計算方式:回傳「跌幅絕對值」,例如下跌 7% 回傳 7
   */
  {
    id:      'loss_5d',
    group:   'momentum',
    label:   '近5日累計跌幅 ≥',
    unit:    '%',
    type:    'number',
    default: 5,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      if (n < 6) return { loss5d: null };
      const today = closes[n - 1];
      const base  = closes[n - 6];    // 5 根前
      const drop  = base > 0 ? (base - today) / base * 100 : null;  // 跌幅為正
      return { loss5d: drop };
    },
    match: (indicators, v) =>
      indicators.loss5d != null && indicators.loss5d >= v,
  },

  /**
   * rsi_revival:RSI 從 <30 反彈到 ≥ value
   * X3 炒底王(value=35)使用
   * 條件:過去 5 根曾有 RSI < 30,且今日 RSI ≥ value
   *      (用「曾經低位 + 現在抬升」確認 V 轉,而非單純低 RSI 盤整)
   */
  {
    id:      'rsi_revival',
    group:   'technical',
    label:   'RSI 從<30 反彈到 ≥',
    unit:    '',
    type:    'number',
    default: 35,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const rsi    = calcRSI(closes, 14);
      const n      = rsi.length;
      if (n < 6) return { rsiRevival: false, rsiNow: null };
      const today  = rsi[n - 1];
      // 過去 5 根(不含今日)是否曾經 < 30
      const past5  = rsi.slice(-6, -1);
      const wasLow = past5.some(v => v != null && v < 30);
      return { rsiRevival: wasLow, rsiNow: today };
    },
    match: (indicators, v) =>
      indicators.rsiRevival === true &&
      indicators.rsiNow != null &&
      indicators.rsiNow >= v,
  },

  /**
   * ma20_rising:MA20 連續 value 天上升
   * X1 黃金比例(value=3)使用 — 確認趨勢方向
   * 計算方式:今日 MA20 > 1日前 > 2日前 ...連續 value 天遞增
   */
  {
    id:      'ma20_rising',
    group:   'trend',
    label:   'MA20 連續N天上升',
    unit:    '',           // label 已含「天」,unit 留空避免重複
    type:    'number',
    default: 3,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const ma     = calcMA(closes, 20);
      return { ma20Series: ma };
    },
    match: (indicators, v) => {
      const arr = indicators.ma20Series;
      if (!arr || arr.length < v + 1) return false;
      // 檢查最後 (v+1) 個值是否嚴格遞增
      const tail = arr.slice(-v - 1);
      for (let i = 1; i < tail.length; i++) {
        if (tail[i] == null || tail[i - 1] == null) return false;
        if (tail[i] <= tail[i - 1]) return false;
      }
      return true;
    },
  },

  /**
   * industry_leading:同族群已有 ≥ value 檔 RSI > 70(本股不算)
   * X4 何時輪到我(value=2)使用 — 偵測族群輪動效應
   *
   * ⚠️ 跨檔依賴特殊條件:
   *   - 需要 indicators._industryContext 提供同族群其他股的當前 RSI
   *   - context 由呼叫端注入(篩選器 / exit-backtest / signal-scan)
   *   - 沒提供 context 時:condition 自動失敗(不報錯,避免誤觸發)
   *
   * context 結構:
   *   {
   *     code:  '8021',                              // 本股代號
   *     peers: [{ code: '2383', rsi: 72.5 }, ...]   // 同族群其他股當前 RSI
   *   }
   */
  {
    id:      'industry_leading',
    group:   'industry',
    label:   '同族群 ≥N 檔 RSI>70',
    unit:    '檔',
    type:    'number',
    default: 2,
    phase:   2,
    calc: candles => {
      // calc 本身不算東西,context 從 indicators._industryContext 取
      // 這裡只是佔位,讓 calcDone 機制正常運作
      return { _industryPlaceholder: true };
    },
    match: (indicators, v) => {
      const ctx = indicators._industryContext;
      if (!ctx || !Array.isArray(ctx.peers)) return false;
      const leadingCount = ctx.peers.filter(
        p => p.rsi != null && p.rsi > 70
      ).length;
      return leadingCount >= v;
    },
  },

  // ══════════════════════════════════════════════
  // ── X6~X11 系列新增條件（Pure K 線，無需新資料）
  // ══════════════════════════════════════════════

  /**
   * gap_up：今日開盤跳空上漲 ≥ value%（跳空缺口突破）
   * X6「跳空缺口突破」使用，value 預設 1.5
   * 跳空 = 今日開盤 > 昨日最高
   */
  {
    id:      'gap_up',
    group:   'price',
    label:   '跳空缺口 ≥（開盤跳空）',
    unit:    '%',
    type:    'number',
    default: 1.5,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 2) return { gapUpPct: 0, gapHeld: false };
      const today = candles[n - 1];
      const prev  = candles[n - 2];
      const open  = today.open ?? today.close;
      const prevH = prev.high  ?? prev.close;
      const pct   = prevH > 0 ? (open - prevH) / prevH * 100 : 0;
      // 收盤仍守住跳空開盤（未回測填補）= 強勢確認
      const gapHeld = today.close >= open * 0.99;
      return { gapUpPct: pct, gapHeld };
    },
    match: (indicators, v) => indicators.gapUpPct != null && indicators.gapUpPct >= v && indicators.gapHeld,
  },

  /**
   * gap_open：今日跳空缺口仍未回補（缺口維持開放）
   * X7「缺口未回補強勢」使用
   * 條件：過去 N 日內有跳空（gap > 1%），且今日收盤 > 那根缺口底部（未回補）
   */
  {
    id:      'gap_open',
    group:   'price',
    label:   '跳空缺口未回補（近N日內）',
    unit:    '日',
    type:    'number',
    default: 5,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 3) return { gapOpenFloor: null, gapOpenDaysAgo: null };
      // 找最近 lookback 根內最後一個跳空點（今日開 > 昨日高，且幅度 ≥ 1%）
      const lookback = Math.min(10, n - 1);
      let gapFloor    = null;
      let gapDaysAgo  = null;
      for (let i = n - 1; i >= n - lookback; i--) {
        const open  = candles[i].open  ?? candles[i].close;
        const prevH = candles[i - 1].high ?? candles[i - 1].close;
        if (prevH > 0 && (open - prevH) / prevH * 100 >= 1.0) {
          gapFloor   = prevH;
          gapDaysAgo = n - 1 - i;  // 0=今日,1=昨日...
          break;
        }
      }
      // 今日收盤是否仍在缺口底部以上（未回補）
      const lastClose = candles[n - 1].close;
      const gapUnfilled = gapFloor != null && lastClose > gapFloor;
      return { gapOpenFloor: gapFloor, gapOpenDaysAgo: gapDaysAgo, gapUnfilled };
    },
    match: (indicators, v) => {
      const { gapOpenFloor, gapOpenDaysAgo, gapUnfilled } = indicators;
      if (!gapUnfilled || gapOpenFloor == null) return false;
      // value = 近幾日內，預設5；缺口必須在 v 天內發生
      return gapOpenDaysAgo != null && gapOpenDaysAgo <= v;
    },
  },

  /**
   * ema_bull_array：EMA5 > EMA10 > EMA20 且近期剛完成排列（前N日曾亂序）
   * X10「均線多頭排列完成」使用
   * 比 ema_bull（只看 EMA5>EMA20）更嚴格：三條線全部有序
   * 「剛翻多」= 5日前至少有一天不滿足，今日才滿足
   */
  {
    id:      'ema_bull_array',
    group:   'trend',
    label:   'EMA5>EMA10>EMA20 多頭排列（剛完成）',
    unit:    '',
    type:    'boolean',
    default: true,
    phase:   2,
    calc: candles => {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      if (n < 25) return { emaBullArray: false, emaBullArrayFresh: false };
      const ema5  = calcEMA(closes, 5);
      const ema10 = calcEMA(closes, 10);
      const ema20 = calcEMA(closes, 20);
      // 今日三線全部有序
      const todayOk = ema5[n-1] != null && ema10[n-1] != null && ema20[n-1] != null
        && ema5[n-1] > ema10[n-1] && ema10[n-1] > ema20[n-1];
      // 3日前是否曾亂序（「剛翻多」嚴格定義，縮窄觸發率）
      let wasMixed = false;
      for (let i = n - 4; i < n - 1; i++) {
        if (i < 0) continue;
        if (ema5[i] == null || ema10[i] == null || ema20[i] == null) continue;
        if (!(ema5[i] > ema10[i] && ema10[i] > ema20[i])) {
          wasMixed = true;
          break;
        }
      }
      return {
        emaBullArray:      todayOk,
        emaBullArrayFresh: todayOk && wasMixed,
      };
    },
    match: (indicators) => indicators.emaBullArrayFresh === true,
  },

  /**
   * tight_consolidation：近N日高低波動 < 阈值%，且今日放量突破
   * X8「高檔整理後噴出」使用
   * 定義：近5日（不含今日）收盤最高-最低 < value% × 最低，且今日放量（>均量1.5倍）向上
   */
  {
    id:      'tight_consolidation',
    group:   'volume',
    label:   '盤整後放量突破（波動<N%）',
    unit:    '%',
    type:    'number',
    default: 3,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 10) return { tightBreakout: false };
      const closes  = candles.map(c => c.close);
      const volumes = candles.map(c => c.volume ?? 0);
      // 前5日（不含今日）收盤波動
      const recent  = closes.slice(n - 6, n - 1);
      const maxC    = Math.max(...recent);
      const minC    = Math.min(...recent);
      const rangePct = minC > 0 ? (maxC - minC) / minC * 100 : 999;
      // 今日量 vs 前10日均量
      const vol10avg = volumes.slice(n - 11, n - 1).reduce((a, b) => a + b, 0) / 10;
      const volRatio = vol10avg > 0 ? volumes[n - 1] / vol10avg : 0;
      // 今日向上（收盤 > 前日收盤）
      const up = closes[n - 1] > closes[n - 2];
      return { tightBreakout: false, tightRangePct: rangePct, tightVolRatio: volRatio, tightUp: up };
    },
    match: (indicators, v) => {
      const { tightRangePct, tightVolRatio, tightUp } = indicators;
      if (tightRangePct == null) return false;
      return tightRangePct <= v && tightVolRatio >= 1.5 && tightUp;
    },
  },

  /**
   * vol_shrink_n：前N日連續縮量（每日量 < 10日均量的0.8倍）
   * X9「量縮後放量突破」前段條件
   * value = 連續縮量天數，預設3
   */
  {
    id:      'vol_shrink_n',
    group:   'volume',
    label:   '連續N日縮量',
    unit:    '日',
    type:    'number',
    default: 3,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 15) return { shrinkDays: 0 };
      const volumes = candles.map(c => c.volume ?? 0);
      // 10日均量（不含今日）
      const vol10avg = volumes.slice(n - 11, n - 1).reduce((a, b) => a + b, 0) / 10;
      if (vol10avg === 0) return { shrinkDays: 0 };
      // 往回數連續縮量天數（不含今日）
      let shrinkDays = 0;
      for (let i = n - 2; i >= Math.max(0, n - 8); i--) {
        if (volumes[i] < vol10avg * 0.8) shrinkDays++;
        else break;
      }
      return { shrinkDays };
    },
    match: (indicators, v) => indicators.shrinkDays != null && indicators.shrinkDays >= v,
  },

  /**
   * break_recent_high：今日收盤突破近N日高點且放量
   * X9「量縮後放量突破」後段條件
   * value = 近N日，預設10
   */
  {
    id:      'break_recent_high',
    group:   'price',
    label:   '放量突破近N日高點',
    unit:    '日',
    type:    'number',
    default: 10,
    phase:   2,
    calc: candles => {
      const n = candles.length;
      if (n < 15) return { breakHighVol: false, breakHighClose: null, breakHighSeries: null };
      const closes  = candles.map(c => c.close);
      const highs   = candles.map(c => c.high ?? c.close);
      const volumes = candles.map(c => c.volume ?? 0);
      const vol10avg = volumes.slice(n - 11, n - 1).reduce((a, b) => a + b, 0) / 10;
      const volOk = vol10avg > 0 && volumes[n - 1] >= vol10avg * 1.5;
      return {
        breakHighClose:  closes[n - 1],
        breakHighSeries: highs.slice(0, n - 1),
        breakHighVol:    volOk,
      };
    },
    match: (indicators, v) => {
      const { breakHighClose, breakHighSeries, breakHighVol } = indicators;
      if (!breakHighSeries || !breakHighVol || breakHighClose == null) return false;
      const recentHigh = Math.max(...breakHighSeries.slice(-v));
      return breakHighClose > recentHigh;
    },
  },

];

// ─────────────────────────────────────────────
export async function* runScreener(conditions) {
  const phase1Conds = conditions.filter(c => c.def.phase === 1);
  const phase2Conds = conditions.filter(c => c.def.phase === 2);
  const phase3Conds = conditions.filter(c => c.def.phase === 3);
  const period      = Config.screenerPeriod ?? '3mo';
  const concurrency = Config.concurrency    ?? 5;
  const hasToken    = !!getFinMindToken();

  // Phase C 需要 Token，無 Token 時跳過並提示
  if (phase3Conds.length > 0 && !hasToken) {
    yield { type: 'warning', payload: { message: '基本面篩選需要 FinMind Token，請先在設定中填入' } };
  }

  // ── Phase A：全市場價格資料 ─────────────────────────────────────────────────
  // 取得策略：
  //   盤中 → 直接用 __priceCache（MIS 每 3 分鐘更新，夠新），完全不打 TWSE
  //   盤後 → fetchTWSEPrices()（Firestore 優先 → TWSE/TPEx fallback）
  //
  // ⚠️ 踩雷備忘：盤中呼叫 fetchTWSEPrices() 必然失敗（TWSE STOCK_DAY_ALL 盤中沒有今日資料）
  //   每次篩選都會浪費 2-3 個 proxy 請求 + 等待逾時，改成盤中直接跳過省掉全部浪費

  function _isTradingNow() {
    const tw  = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const day = tw.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
    return mins >= 9 * 60 && mins <= 13 * 60 + 35;
  }

  let twsePrices;
  const cachedPrices = window.__priceCache ?? {};
  const hasCachedPrices = Object.keys(cachedPrices).length > 0;

  if (_isTradingNow() && hasCachedPrices) {
    // 盤中：直接用快取，不打 TWSE（盤中打必然失敗）
    console.log('[screener] 盤中模式 → 直接用 __priceCache:', Object.keys(cachedPrices).length, '檔（MIS 每 3 分鐘更新）');
    twsePrices = cachedPrices;
  } else {
    // 盤後或快取空：走正常抓取流程
    try {
      twsePrices = await fetchTWSEPrices();
    } catch (e) {
      if (hasCachedPrices) {
        console.warn('[screener] TWSE 失敗，改用 __priceCache fallback:', Object.keys(cachedPrices).length, '檔');
        twsePrices = cachedPrices;
      } else {
        yield { type: 'error', payload: { message: '無法取得市場資料，請稍後再試（' + e.message + '）' } };
        return;
      }
    }
    // fetchTWSEPrices 成功但回傳空 → fallback
    if (!twsePrices || Object.keys(twsePrices).length === 0) {
      if (hasCachedPrices) {
        console.warn('[screener] TWSE 回傳空資料，改用 __priceCache fallback:', Object.keys(cachedPrices).length, '檔');
        twsePrices = cachedPrices;
      } else {
        // 終極 fallback：用中文名快取代號清單（無價格，Phase 1 條件失效）
        const codes = getAllKnownCodes();
        if (codes.length > 0) {
          console.warn('[screener] 無價格資料，用名稱快取代號清單 fallback:', codes.length, '檔（Phase 1 條件失效）');
          twsePrices = {};
          codes.forEach(c => {
            twsePrices[c] = { name: getChineseName(c) ?? c, price: 0, volume: 0, chgPct: 0 };
          });
        } else {
          yield { type: 'error', payload: { message: '市場資料完全無法取得，請稍後再試' } };
          return;
        }
      }
    }
  }

  const allCodes   = Object.keys(twsePrices);
  // 偵測是否為「無價格 fallback 清單」：所有 price 都 0
  const isNoPriceMode = allCodes.length > 0 && allCodes.every(c => (twsePrices[c]?.price ?? 0) === 0);
  if (isNoPriceMode) {
    console.warn('[screener] 偵測到無價格 fallback 模式，Phase 1 條件全部放行（價格資料缺失）');
  }
  const phase1Pass = allCodes.filter(code => {
    const row = twsePrices[code];
    if (isNoPriceMode) return true;  // 無價格 fallback：Phase 1 全部放行，靠 Phase 2 K線篩
    return phase1Conds.every(c => c.def.match(row, c.value));
  });

  yield { type: 'phase1_done', payload: { total: allCodes.length, passed: phase1Pass.length } };

  if (!phase2Conds.length) {
    for (const code of phase1Pass) {
      const row = twsePrices[code];
      yield {
        type: 'result',
        payload: {
          code,
          name:         getChineseName(code) ?? row.name,
          price:        row.price,
          chgPct:       row.chgPct,
          volume:       row.volume,
          indicators:   {},
          matchedConds: conditions.map(c => _formatCondLabel(c)),
        },
      };
    }
    yield { type: 'done', payload: { total: phase1Pass.length } };
    return;
  }

  // ── Phase B：批次拉 K 線（並發 concurrency=5，比逐一+350ms 快 5 倍）
  yield { type: 'status', payload: { message: `計算技術指標中（共 ${phase1Pass.length} 檔）…` } };
  const phase2Pass = [];
  const yield_buf  = [];
  let candleMap = new Map();
  try {
    candleMap = await fetchScreenerData(phase1Pass, {
      period,
      concurrency,
      onProgress: (done, total) => {
        document.dispatchEvent(new CustomEvent('screenerPhase2Progress', {
          detail: { done, total }
        }));
      },
    });
  } catch (e) {
    console.warn('[screener] fetchScreenerData 失敗:', e.message);
  }

  for (const code of phase1Pass) {
    const candles = candleMap.get(code);
    if (!candles || candles.length < 30) continue;

    // 合併所有 calc 的結果（同一個 calc key 只算一次）
    const indicators = {};
    const calcDone   = new Set();
    for (const cond of phase2Conds) {
      if (cond.def.calc && !calcDone.has(cond.def.id)) {
        Object.assign(indicators, cond.def.calc(candles));
        calcDone.add(cond.def.id);
      }
    }

    // X 系列 industry_leading 需要 context:從 candleMap 動態建構
    // 這裡只設一次,讓 indicators 跟 match 都拿到
    const industryContext = _buildIndustryContextForScreener(code, candleMap);
    if (industryContext) {
      indicators._industryContext = industryContext;
    }

    const pass = phase2Conds.every(c => c.def.match(indicators, c.value));
    if (!pass) continue;

    // 清理不需要傳給 UI 的大型序列（closeSeries 僅供 match 內部使用）
    const indicatorsForUI = Object.fromEntries(
      Object.entries(indicators).filter(
        ([k]) => k !== 'closeSeries' && k !== '_industryContext'
      )
    );

    const row = twsePrices[code];

    // v2.7+ 訊號觸發歷史:算「此條件組合」過去 120 根的 streak
    // 預設啟用,可由 Config.screenerTriggerHistory = false 關掉(省 3-8 秒)
    let triggerHistory = null;
    if (Config.screenerTriggerHistory !== false) {
      try {
        triggerHistory = _calcConditionTriggerHistory(
          conditions, candles, row, candleMap, 120
        );
      } catch (e) {
        console.warn(`[screener] triggerHistory failed for ${code}:`, e.message);
      }
    }

    // 無 Phase C 條件 → 直接 yield 結果
    if (!phase3Conds.length || !hasToken) {
      yield {
        type: 'result',
        payload: {
          code,
          name:         getChineseName(code) ?? row?.name ?? code,
          price:        row?.price ?? null,
          chgPct:       row?.chgPct ?? null,
          volume:       row?.volume ?? null,
          indicators:   indicatorsForUI,
          candles,      // ← 供 screener-ui.js calcHealth / calcHealthLong 使用
          matchedConds: conditions.map(c => _formatCondLabel(c)),
          triggerHistory,  // v2.7+ { streak, firstTriggerDate, isNew, totalTriggers } | null
        },
      };
    } else {
      // 有 Phase C → 先存起來，等下批次打基本面
      phase2Pass.push({ code, row, indicatorsForUI, triggerHistory });
    }
  }

  // ── Phase C：基本面篩選（FinMind，並發 3 檔，有 IndexedDB 快取）
  if (phase3Conds.length > 0 && hasToken && phase2Pass.length > 0) {
    yield { type: 'status', payload: { message: `基本面篩選中（共 ${phase2Pass.length} 檔）…` } };

    let fundDone = 0;
    const CONCURRENCY = 3;
    for (let i = 0; i < phase2Pass.length; i += CONCURRENCY) {
      const batch = phase2Pass.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async ({ code, row, indicatorsForUI, triggerHistory }) => {
        try {
          // fetchFundamentals 有 IndexedDB 快取（智慧更新點判斷），不會重複打 API
          const symbol = `${code}.TW`;
          const fund   = await fetchFundamentals(symbol, code);
          if (!fund) return;

          // 有需要外資歷史的條件 → 額外打 fetchForeignBuyDays 並注入
          const needForeign = phase3Conds.some(c => c.def._useForeign);
          if (needForeign) {
            try {
              fund._foreignHistory = await fetchForeignBuyDays(code, 20);
            } catch (e) {
              fund._foreignHistory = [];
            }
          }

          const pass = phase3Conds.every(c => c.def.match(fund, c.value));
          if (!pass) return;

          yield_buf.push({
            type: 'result',
            payload: {
              code,
              name:         getChineseName(code) ?? row?.name ?? code,
              price:        row?.price ?? null,
              chgPct:       row?.chgPct ?? null,
              volume:       row?.volume ?? null,
              indicators:   {
                ...indicatorsForUI,
                pe:           fund.pe,
                pb:           fund.pbRatio,
                eps:          fund.eps,
                dividendYield: fund.dividendYield,
                revenueGrowth: fund.revenueGrowth,
                earningsGrowth: fund.earningsGrowth,
              },
              candles,      // ← 供 screener-ui.js calcHealth / calcHealthLong 使用
              matchedConds: conditions.map(c => _formatCondLabel(c)),
              triggerHistory,  // v2.7+ Phase 2 階段已預算,延用到 Phase 3
            },
          });
        } catch (e) {
          console.warn(`[screener] Phase C failed for ${code}:`, e.message);
        } finally {
          fundDone++;
          document.dispatchEvent(new CustomEvent('screenerPhase3Progress', {
            detail: { done: fundDone, total: phase2Pass.length }
          }));
        }
      }));

      // flush yield_buf
      for (const item of yield_buf) yield item;
      yield_buf.length = 0;

      // 批次間隔（避免打太快）
      if (i + CONCURRENCY < phase2Pass.length) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }

  yield { type: 'done', payload: { total: phase1Pass.length } };
}

// ─────────────────────────────────────────────
// 儲存 / 讀取篩選組合（改走 db.js，雲端自動同步）
// ─────────────────────────────────────────────

export async function loadSavedSets() {
  try {
    return await getAllScreenerSets();
  } catch {
    return [];
  }
}

export async function saveSet(name, conditions) {
  const sets = await loadSavedSets();
  if (sets.length >= 20) {
    throw new Error('最多儲存 20 組篩選條件');
  }
  const existing = sets.find(s => s.name === name);
  const entry = {
    id:         existing?.id ?? `screener_${Date.now()}`,
    name,
    conditions: conditions.map(c => ({ id: c.def.id, value: c.value })),
    savedAt:    Date.now(),
  };
  await saveScreenerSet(entry);
}

export async function deleteSavedSet(id) {
  await deleteScreenerSet(id);
}
