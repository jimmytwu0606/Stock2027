/**
 * signal-scan.js
 * 個股訊號比對 + 自選清單定時掃描
 *
 * 功能：
 *   1. matchSignals(candles, twseRow) → Signal[]
 *      用現有 K 線比對所有策略條件，回傳符合的策略清單
 *
 *   2. scanWatchlistSignals()
 *      一次掃描所有自選清單個股，結果存入 AppState.signals
 *      觸發 'signalsUpdated' 自訂事件通知 UI 重繪
 *
 *   3. startSignalTimer(intervalMs)
 *      盤中定時呼叫 scanWatchlistSignals()，盤後自動停止
 *
 *   4. stopSignalTimer()
 *      手動停止定時掃描
 *
 * export：
 *   matchSignals, scanWatchlistSignals, startSignalTimer, stopSignalTimer
 */

import { CONDITION_DEFS } from './screener.js';
import { STRATEGIES, STRATEGY_VERSION } from './strategy.js';
import { calcKD, calcRSI, calcMACD, calcMA } from './indicators.js';
import { fetchHistory, toYahooSymbol, resolveYahooSymbol, getChineseName, isWorkerCooling } from './api.js';
import { AppState } from './state.js';
import { getPeersOf } from './industry-groups.js';
import { getYaoguRecord, putYaoguRecord } from './db.js';
import {
  getAllSignalsCache, setSignalsCache, getSignalsCache, deleteSignalsCache,
  clearAllSignalsCache,
  getKlineCache, dbGetAll,
} from './db.js';

// ─────────────────────────────────────────────
// 1. 單一個股訊號比對（純計算，不打 API）
// ─────────────────────────────────────────────

/**
 * 用現有 candles + twseRow（可選）比對所有策略
 * @param {Candle[]} candles   K 線陣列（至少 30 根）
 * @param {object}  [twseRow]  { price, chgPct, volume }，Phase A 條件需要
 * @param {object}  [opts]     擴充選項(v2.7+)
 * @param {object}  [opts.industryContext]  X4「何時輪到我」跨檔資料
 *                  { code: string, peers: [{ code, rsi }] }
 *                  沒提供時 X4 自動失敗(不報錯)
 * @returns {Signal[]}  符合的策略清單 [{ id, icon, name, category, desc }]
 */
export function matchSignals(candles, twseRow = null, opts = {}) {
  if (!candles || candles.length < 20) return [];

  // ── v2.6.2 fallback: twseRow 沒傳時用 candles 最後兩根重建 ──
  // 讓 Phase 1 條件（chg_min/vol_min/price_min/price_max）在盤後也能正確比對
  // 否則 __priceCache 沒資料時 Phase 1 全跳過，導致訊號與策略庫結果不一致
  // ⚠️ candles 的 volume 是「股」(Yahoo 單位)，vol_min 是「張」(1張=1000股)
  //    所以 volume 要 /1000 才能跟 vol_min 條件比對
  if (!twseRow && candles.length >= 2) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const chgPct = prev.close > 0
      ? (last.close - prev.close) / prev.close * 100
      : 0;
    twseRow = {
      price:  last.close,
      chgPct: chgPct,
      volume: Math.round((last.volume ?? 0) / 1000),  // 股 → 張
    };
  }

  // 比對「最後一根」(idx = null 表示比對最新)
  const signals = _matchAllStrategiesAt(candles, twseRow, null, opts);
  const deduped = _dedupeSignals(signals, candles);

  // ── v2.6: 附加 _difPos，供下游 calcSignalLamps 做零軸攔截 ──
  // DIF = EMA12 - EMA26 > 0 表示動能在零軸上方
  try {
    const closes = candles.map(c => c.close);
    const { dif } = calcMACD(closes);
    const n = dif?.length ?? 0;
    if (n > 0 && Number.isFinite(dif[n - 1])) {
      deduped._difPos = dif[n - 1] > 0;
    }
  } catch (_) { /* 計算失敗時不設定,calcSignalLamps 預設視為 true */ }

  // ── 跌停板直接注入 W5（跌停 = 最強出貨訊號，不需量能條件）────────────
  if (candles.length >= 2) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const chgPct = prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
    const isLimitDown = chgPct <= -9.5 && Math.abs(last.close - (last.low ?? last.close)) < 0.01;
    if (isLimitDown && !deduped.find(s => s.id === 'W5')) {
      deduped.push({ id: 'W5', name: '急跌訊號（跌停板）', _limitDown: true });
    }
  }

  return deduped;
}

/**
 * matchSignals 的妖股補強版：
 * 妖股 active/watching 狀態時，強制補入 X1/X2/X5 標籤（盤中量不完整時保留）
 *
 * ⚠️ 踩雷備忘（永久，2026-05-26）：
 *   盤中量不完整 → vol_surge 算不過 → X1/X2/X5 不亮 → 標籤消失。
 *   妖股追蹤期間標籤必須保留，中繼縮量是正常現象，不代表訊號消失。
 *   只有 exit（跌破MA20）才真正清除。
 *
 * 強弱分級對應補強：
 *   strong（X1+X2 / X2+X5）→ 補 X2
 *   medium（X2單獨 / X1+X5）→ 依原始訊號補
 *   weak（X1單獨 / X5單獨）→ 補對應訊號
 *
 * @param {Signal[]}    signals  matchSignals 原始結果
 * @param {object|null} record   getYaoguRecord 回傳的 DB 記錄
 * @returns {Signal[]}  補強後的訊號陣列
 */
export function injectYaoguSignals(signals, record) {
  if (!record) return signals;
  if (record.status === 'exited' || record.status === 'exit') return signals;

  const sigIds   = new Set(signals.map(s => s.id));
  const strength = record.strength ?? 'medium';
  const toInject = [];

  if (strength === 'strong') {
    // 強妖 → 補 X2（核心飆股訊號）
    if (!sigIds.has('X2')) toInject.push({
      id: 'X2', icon: '🌑', name: '天黑請閉眼', category: 'X 系列',
      desc: '妖股持續追蹤中（盤中量不完整，訊號保留）', _yaoguInjected: true,
    });
  } else if (strength === 'medium') {
    // 中妖（X2單獨）→ 補 X2；中妖（X1+X5）→ 補 X1+X5
    if (!sigIds.has('X2')) toInject.push({
      id: 'X2', icon: '🌑', name: '天黑請閉眼', category: 'X 系列',
      desc: '妖股持續追蹤中（盤中量不完整，訊號保留）', _yaoguInjected: true,
    });
    if (!sigIds.has('X5')) toInject.push({
      id: 'X5', icon: '🚀', name: '量證明一切', category: 'X 系列',
      desc: '妖股持續追蹤中（盤中量不完整，訊號保留）', _yaoguInjected: true,
    });
  } else if (strength === 'steady') {
    // 穩健型（X1單獨）→ 補 X1
    if (!sigIds.has('X1')) toInject.push({
      id: 'X1', icon: '🪙', name: '黃金比例', category: 'X 系列',
      desc: '穩健型妖股追蹤中（訊號保留）', _yaoguInjected: true,
    });
  } else if (strength === 'early') {
    // 早期型（X5單獨）→ 補 X5
    if (!sigIds.has('X5')) toInject.push({
      id: 'X5', icon: '🚀', name: '量證明一切', category: 'X 系列',
      desc: '早期型妖股追蹤中（盤中量不完整，訊號保留）', _yaoguInjected: true,
    });
  }

  if (!toInject.length) return signals;
  const result = [...toInject, ...signals];
  for (const key of Object.keys(signals)) {
    if (key.startsWith('_')) result[key] = signals[key];
  }
  return result;
}

/**
 * 核心比對引擎(v2.7+ 抽出供 matchSignals + getTriggerHistory 共用)
 *
 * @param {Candle[]} candles  完整 K 線(idx=null 表比對最後一根;否則比對 candles.slice(0, idx+1) 的最後一根)
 * @param {object}   twseRow  Phase 1 用的當日 OHLCV(必須已被 caller 準備好)
 * @param {number|null} idx   要比對的根 index;null=最後一根
 * @param {object}   opts
 * @param {object}   [opts.industryContext]  X4 跨檔資料
 * @returns {Signal[]}  未經 dedupe 的訊號(注意:呼叫端自行 dedupe)
 *
 * ⚠️ 此函式不打 API,純計算
 * ⚠️ X4「industry_leading」條件:從 indicators._industryContext 讀 peers RSI
 */
function _matchAllStrategiesAt(candles, twseRow, idx = null, opts = {}) {
  // idx=null 表「比對最新一根」,即整段 candles
  const sliced = idx == null
    ? candles
    : candles.slice(0, idx + 1);

  if (sliced.length < 20) return [];

  // 若給定 idx,需依該 idx 重建 twseRow(否則 twseRow 永遠是當下值,Phase 1 會失準)
  let useTwseRow = twseRow;
  if (idx != null && sliced.length >= 2) {
    const last = sliced[sliced.length - 1];
    const prev = sliced[sliced.length - 2];
    const chgPct = prev.close > 0
      ? (last.close - prev.close) / prev.close * 100
      : 0;
    useTwseRow = {
      price:  last.close,
      chgPct: chgPct,
      volume: Math.round((last.volume ?? 0) / 1000),
    };
  }

  const signals = [];
  const industryContext = opts.industryContext || null;

  for (const strategy of STRATEGIES) {
    // 跳過尚未實作條件的策略（condId 在 CONDITION_DEFS 找不到的）
    const allDefsExist = strategy.conditions.every(c =>
      CONDITION_DEFS.some(d => d.id === c.condId)
    );
    if (!allDefsExist) continue;

    // Phase 3 條件需要打 FinMind API，純計算無法比對，直接跳過整個策略
    const hasPhase3 = strategy.conditions.some(c => {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      return def?.phase === 3;
    });
    if (hasPhase3) continue;

    // 分 Phase 1 / Phase 2 條件
    const phase1Conds = strategy.conditions.filter(c => {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      return def?.phase === 1;
    });
    const phase2Conds = strategy.conditions.filter(c => {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      return def?.phase === 2;
    });

    // Phase 1：需要 twseRow，若沒提供則跳過 Phase 1 條件
    if (phase1Conds.length > 0 && useTwseRow) {
      const p1Pass = phase1Conds.every(c => {
        const def = CONDITION_DEFS.find(d => d.id === c.condId);
        const val = c.value ?? def.default;
        return def.match(useTwseRow, val);
      });
      if (!p1Pass) continue;
    }

    // Phase 2：計算所有需要的指標（去重）
    const indicators = {};
    const calcDone   = new Set();
    for (const c of phase2Conds) {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      if (def?.calc && !calcDone.has(def.id)) {
        try {
          Object.assign(indicators, def.calc(sliced));
        } catch (_) {}
        calcDone.add(def.id);
      }
    }

    // X 系列特殊:注入 industryContext 給 industry_leading.match 用
    // ⚠️ 永久備忘:industry_leading 是 context 依賴條件,沒 ctx 時自動失敗(不 throw)
    if (industryContext) {
      indicators._industryContext = industryContext;
    }

    const p2Pass = phase2Conds.every(c => {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      const val = c.value ?? def.default;
      return def.match(indicators, val);
    });

    if (p2Pass) {
      signals.push({
        id:       strategy.id,
        icon:     strategy.icon,
        name:     strategy.name,
        category: strategy.category,
        desc:     strategy.desc,
      });
    }
  }

  return signals;
}

/**
 * 取得各策略的「觸發歷史」(v2.7+ 新增,供篩選器 + exit-backtest 共用)
 *
 * 從最後一根往回滾,記錄每根是否觸發,計算:
 *   - streak: 連續觸發天數(從今天往回算的不間斷段)
 *   - firstTriggerDate: 該連續段的最早一根日期
 *   - isNew: 是否今天才剛觸發(streak === 1)
 *   - totalTriggers: 過去 N 根中總觸發次數(含中間斷掉的)
 *
 * @param {Candle[]} candles      完整 K 線(建議至少 120 根)
 * @param {object|null} twseRow   當日 OHLCV(可選,沒給會從 candles 重建)
 * @param {object} opts
 * @param {number} [opts.lookback=120]  回看深度(根)
 * @param {object} [opts.industryContext]  X4 跨檔資料
 * @returns {Map<strategyId, TriggerInfo>}
 *
 * @example
 *   const history = getTriggerHistory(candles, twseRow, { lookback: 120 });
 *   history.get('X2');
 *   // { streak: 3, firstTriggerDate: '2026-05-22', isNew: false, totalTriggers: 5 }
 */

// ── 計算從某時間戳到今天的交易日數（排除週六日）────────────────────────────
function _tradingDaysSince(activatedAt) {
  const start = new Date(activatedAt);
  start.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let days = 0;
  const d = new Date(start);
  while (d <= now) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days++;
    d.setDate(d.getDate() + 1);
  }
  return Math.max(days, 1);
}

export function getTriggerHistory(candles, twseRow = null, opts = {}) {
  const lookback = Math.min(opts.lookback || 120, candles?.length || 0);
  const result = new Map();

  if (!candles || candles.length < 20) return result;

  // 第一步:取「今天觸發了哪些策略」(若今天無訊號,後續完全不用回看,省效能)
  const todaySignals = _matchAllStrategiesAt(candles, twseRow, null, opts);
  if (!todaySignals.length) return result;

  // 第二步:對「今天有觸發」的策略,個別往回掃 streak
  for (const sig of todaySignals) {
    let streak           = 1;
    let firstTriggerIdx  = candles.length - 1;
    let totalTriggers    = 1;
    let streakBroken     = false;

    // 從昨天往回掃 lookback-1 根
    for (let back = 1; back < lookback; back++) {
      const idx = candles.length - 1 - back;
      if (idx < 19) break;  // 不夠 20 根算不出訊號

      // 比對該根是否觸發(只比對「這個策略」,不重跑全部 — 效能優化)
      const signalsAtIdx = _matchAllStrategiesAt(candles, twseRow, idx, opts);
      const triggered    = signalsAtIdx.some(s => s.id === sig.id);

      if (triggered) {
        totalTriggers++;
        if (!streakBroken) {
          streak++;
          firstTriggerIdx = idx;
        }
      } else {
        streakBroken = true;  // streak 斷了,但繼續計算 totalTriggers
      }
    }

    const firstDate = candles[firstTriggerIdx]?.time || candles[firstTriggerIdx]?.date || null;
    result.set(sig.id, {
      streak,
      firstTriggerDate: firstDate,
      isNew:            streak === 1,
      totalTriggers,
    });
  }

  return result;
}

/**
 * 為某檔股票準備 industryContext(供篩選器/exit-backtest 注入給 X4)
 *
 * @param {string} code           本股代號
 * @param {Map<string, Candle[]>} candleMap  全 basket 的 K 線(用來算 peers RSI)
 * @returns {object|null}  { code, peers: [{ code, rsi }] } 或 null(無同族群)
 *
 * 使用範例:
 *   const ctx = buildIndustryContext('8021', candleMap);
 *   matchSignals(candles, twseRow, { industryContext: ctx });
 */
export function buildIndustryContext(code, candleMap) {
  const peers = getPeersOf(code);
  if (!peers.length) return null;

  const peerRsi = [];
  for (const peerCode of peers) {
    const peerCandles = candleMap?.get?.(peerCode);
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

// ═══════════════════════════════════════════════════════════════════
// v2.8 妖股狀態機（Yaogu Tracker）
// 數據依據：ROADMAP_YAOGU_EXIT_0525_1304
// ═══════════════════════════════════════════════════════════════════

/**
 * 計算妖股當前狀態（純計算，不打 DB）
 *
 * 強弱分級：
 *   🔴 強妖：X1+X2+X5 / X1+X2 / X2+X5（多重確認）
 *   🟠 中妖：X2 單獨 / X1+X5（穩健型，趨勢+主力）
 *   🟡 穩健型：X1 單獨（趨勢確認，穩健上車）
 *   🟡 早期型：X5 單獨（主力早期建倉，觀察期）
 *   🟡 弱妖：W14 亮起（訊號轉弱，可考慮出場）
 *
 * 狀態機：
 *   active    🟢 主升段    X1/X2/X5 任一亮
 *   warning1  🟡 準備警示  W14 MACD高位死叉（出場前4-5天前兆）
 *   warning2  🟠 出貨警示  W5 急跌訊號（出場前3-4天前兆）
 *   exit      🔴 出場確認  跌破 MA20（W1 或 W18）
 *   watching  ⚪ 觀察中   曾是妖股但目前無相關訊號
 *   null      未追蹤（從未是妖股）
 *
 * @param {string}     code     股票代號
 * @param {Signal[]}   signals  當前訊號（AppState.signals[code]）
 * @param {object|null} record  DB 記錄（getYaoguRecord 回傳，null=從未追蹤）
 * @returns {object|null}  { status, label, color, daysSince, activatedAt } | null
 */
export function getYaoguStatus(code, signals, record, streak = null, klineCtx = {}) {
  const sigIds = new Set((signals || []).map(s => s.id));

  const hasX1  = sigIds.has('X1');
  const hasX2  = sigIds.has('X2');
  const hasX5  = sigIds.has('X5');
  // W1 可能被複合訊號（W3/W4/W8/W9/W10）吸收而消失
  // exit 判斷改為「W1 或任何包含 W1 語義的超集訊號」
  const W1_FAMILY = new Set(['W1','W3','W4','W8','W9','W10']);
  const hasW1  = [...sigIds].some(id => W1_FAMILY.has(id));
  const hasW18 = sigIds.has('W18');
  const hasW14 = sigIds.has('W14');
  const hasW5  = sigIds.has('W5');

  // K 線輔助判斷（由 scanOneCode 預算傳入）
  const { belowMA10, kdHighDeadCross, testMA20, warningPeak, warningPeakDrop } = klineCtx;

  // 弱妖（warning1）K 線條件：
  // 1. KD 從高位（K>70）死叉
  // 2. 跌破 MA10
  // 3. 測試 MA20 當天守住（低點 < MA20 但收盤 ≥ MA20）
  const hasKlineWarn1 = kdHighDeadCross || belowMA10 || testMA20;

  // 出貨警示（warning2）K 線條件：
  // 近 10 根內距高點跌幅 ≥ 10%
  const hasKlineWarn2 = warningPeakDrop >= 10;

  const now = Date.now();

  // ── 強弱分級 ──────────────────────────────────────────────────────
  // 🔴 強妖：X1+X2+X5 / X1+X2 / X2+X5（多重確認）
  // 🟠 中妖：X2 單獨（標準飆股）/ X1+X5（穩健型妖股）
  // 🟡 穩健型：X1 單獨（趨勢確認，穩健上車）
  // 🟡 早期型：X5 單獨（主力早期建倉，觀察期）
  // 🟡 弱妖：W14 開始，訊號轉弱，可考慮出場（由 warning1 狀態顯示）
  let strength = 'none';
  if      (hasX2 && (hasX1 || hasX5)) strength = 'strong';
  else if (hasX2)                       strength = 'medium';
  else if (hasX1 && hasX5)             strength = 'medium';  // 穩健型妖股
  else if (hasX1)                       strength = 'steady'; // 穩健型
  else if (hasX5)                       strength = 'early';  // 早期型

  const _strengthTag = {
    strong: '🔴 強妖',
    medium: '🟠 中妖',
    steady: '🟡 穩健型',  // X1 單獨：趨勢確認，穩健上車
    early:  '🟡 早期型',  // X5 單獨：主力早期建倉
    none:   '',
  };
  // 弱妖（🟡）專門保留給 W14 警示階段（訊號開始轉弱，可考慮出場）
  const _strengthDesc = {
    strong: hasX1 && hasX2 && hasX5 ? 'X1+X2+X5 三重確認，最強妖股'
          : hasX1 && hasX2           ? 'X1+X2 趨勢+飆股雙確認'
          :                            'X2+X5 飆股+主力雙確認',
    medium: hasX2                    ? 'X2 天黑請閉眼，飆股主升段確認'
          :                            'X1+X5 穩健型妖股，趨勢確認+主力建倉',
    steady: 'X1 黃金比例，趨勢確認穩健上車',
    early:  'X5 量證明一切，主力建倉早期介入，持續觀察',
    none:   '',
  };

  // streak 顯示：妖股啟動天數（activatedAt）
  const streakLabel = streak != null ? ` · 第 ${streak} 天` : '';
  // 警示天數：從 warningAt 算（warning1/warning2 獨立計算，不混用妖股天數）
  const warningDays  = record?.warningAt ? _tradingDaysSince(record.warningAt) : null;
  const warningLabel = warningDays != null ? ` · 第 ${warningDays} 天` : streakLabel;

  // ── 底線：跌破 MA20 → 有記錄才出場確認 ──
  if ((hasW1 || hasW18) && record) {
    return {
      status:   'exit',
      label:    '🔴 出場確認',
      color:    '#ef4444',
      desc:     '跌破月線，妖股出場底線，請立刻出場',
      strength,
      streak,
      streakLabel,
      activatedAt: record?.activatedAt ?? null,
    };
  }

  // ── 沒記錄：X1/X2/X5 任一亮就啟動 ──
  if (!record || record.status === 'exited') {
    if (hasX1 || hasX2 || hasX5) {
      const stTag = _strengthTag[strength];
      const desc  = _strengthDesc[strength] || '';
      return {
        status:   'active',
        label:    `🟢 主升段${streakLabel}`,
        color:    '#4ade80',
        desc:     `${stTag} ${desc}`,
        strength,
        streak:   streak ?? 1,
        streakLabel,
        activatedAt: now,
        isNew:    true,
      };
    }
    return null;
  }

  // ── 有記錄：依訊號層次判斷 ──
  if (hasW5 || hasKlineWarn2) {
    return {
      status:      'warning2',
      label:       `🟠 出貨警示${warningLabel}`,
      color:       '#f97316',
      desc:        `${_strengthTag[record.strength ?? strength]} W5 急跌訊號出現，主力可能出貨，建議縮倉`,
      strength:    record.strength ?? strength,
      streak,
      streakLabel,
      activatedAt: record.activatedAt,
      warningAt:   record.warningAt ?? null,
      warningDays,
      // 同時回傳妖股主升段資訊（供 chip 雙行顯示）
      activeLabel: `🟢 主升段${streakLabel}`,
      activeDesc:  `${_strengthTag[record.strength ?? 'none']} 啟動已 ${streak ?? '?'} 個交易日`,
    };
  }
  if (hasW14 || hasKlineWarn1) {
    return {
      status:      'warning1',
      label:       `🟡 弱妖${warningLabel}`,
      color:       '#fbbf24',
      desc:        `${_strengthTag[record.strength ?? strength]} MACD 高位死叉，訊號轉弱，出場前 4-5 天前兆，可考慮出場`,
      strength:    record.strength ?? strength,
      streak,
      streakLabel,
      activatedAt: record.activatedAt,
      warningAt:   record.warningAt ?? null,
      warningDays,
      // 同時回傳妖股主升段資訊（供 chip 雙行顯示）
      activeLabel: `🟢 主升段${streakLabel}`,
      activeDesc:  `${_strengthTag[record.strength ?? 'none']} 啟動已 ${streak ?? '?'} 個交易日`,
    };
  }
  if (hasX1 || hasX2 || hasX5) {
    const stTag = _strengthTag[strength];
    const desc  = _strengthDesc[strength] || '';
    return {
      status:   'active',
      label:    `🟢 主升段${streakLabel}`,
      color:    '#4ade80',
      desc:     `${stTag} ${desc}，持續持倉`,
      strength,
      streak,
      streakLabel,
      activatedAt: record.activatedAt,
    };
  }

  // 有記錄但訊號暫退 → 觀察中
  return {
    status:   'watching',
    label:    `⚪ 觀察中${streakLabel}`,
    color:    '#9ca3af',
    desc:     `${_strengthTag[record.strength ?? 'none']} 訊號暫時消退，持續觀察 MA20，未跌破前不需急出`,
    strength: record.strength ?? 'none',
    streak,
    streakLabel,
    activatedAt: record.activatedAt,
  };
}

/**
 * 更新妖股追蹤記錄（讀 DB → 計算 → 寫 DB）
 * 在 scanOneCode / scanWatchlistSignals 結束後自動呼叫
 *
 * @param {string}   code
 * @param {Signal[]} signals  當前訊號
 * @param {Candle[]} candles  K線（用來算 X2/X5 streak，不傳則 streak=null）
 * @returns {Promise<object|null>}  最新的妖股狀態
 *
 * 設計原則（永久備忘）：
 *   ① 先確認 signals 有 X2 或 X5 才計算 streak — 不浪費 K線計算
 *   ② streak 用 getTriggerHistory 從 K 線上算「連續幾根有觸發」
 *      不用 Date.now() 毫秒差 — 假日/週末不是 K 線，毫秒差不準確
 *   ③ 取 X2.streak 和 X5.streak 的最大值作為「妖股已亮幾天」
 */
export async function updateYaoguTracker(code, signals, candles = null) {
  try {
    const record = await getYaoguRecord(code);
    const sigIds = new Set((signals || []).map(s => s.id));
    const hasX1  = sigIds.has('X1');
    const hasX2  = sigIds.has('X2');
    const hasX5  = sigIds.has('X5');

    // ① 先確認有妖股訊號才繼續（不浪費計算）
    const isYaoguSignal = hasX1 || hasX2 || hasX5;
    if (!isYaoguSignal && !record) return null;

    // ② 從今天往回找 X 系列起點：遇到連續 3 根無 X 就停
    //   這波妖股的起點 = 最早連續觸發 X 的那根
    //   漲停板已豁免 vol_surge 條件，所以漲停板期間 X 系列能正確觸發
    let _klineActivatedAt = null;
    let _klineWarningAt   = null;
    if (candles?.length >= 20) {
      const warnIds = new Set(['W5', 'W14']);
      let noXCount  = 0;
      const MAX_GAP = 3;

      // 警示根判斷：W5/W14 觸發 OR 當日跌幅 ≥ 5%（不依賴 loss_5d 5日累計）
      const WARNING_DROP = 5.0;
      const _isWarnCandle = (idx) => {
        if (idx <= 0 || idx >= candles.length) return false;
        const chg = (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
        return chg <= -WARNING_DROP;
      };

      // 從今天往回，連續累積「警示根」直到遇到非警示根才停
      // 警示根 = W5/W14 觸發 OR 跌幅 ≥ 5%
      // 今天單獨算 X；warningAt 回溯從 back=0 開始（今天也算）
      let warnStopped = false;
      for (let back = 0; back < candles.length - 20; back++) {
        const idx    = candles.length - 1 - back;
        const sliced = back === 0 ? candles : candles.slice(0, idx + 1);
        const sigs   = matchSignals(sliced, null);
        const hasX   = sigs.some(s => s.id === 'X1' || s.id === 'X2' || s.id === 'X5');
        const hasW   = sigs.some(s => warnIds.has(s.id));
        const isWarn = hasW || _isWarnCandle(idx);
        const c      = candles[idx];
        const ts     = c.time > 1e10 ? c.time : c.time * 1000;

        // X 回溯：獨立處理，不受 warnStopped 影響
        if (hasX) { _klineActivatedAt = ts; noXCount = 0; }
        else { noXCount++; if (_klineActivatedAt && noXCount >= MAX_GAP) break; }

        // warningAt 回溯：連續警示根往回延伸，遇非警示根停止
        if (!warnStopped) {
          if (isWarn) {
            _klineWarningAt = ts;   // 持續更新，保留最早的連續警示起點
          } else {
            warnStopped = true;     // 遇到非警示根，停止往回延伸
          }
        }
      }
    }

    // ③ streak 計算：用 K 線校正後的 activatedAt
    let streak = null;
    if (isYaoguSignal) {
      const activatedAt = _klineActivatedAt ?? record?.activatedAt ?? Date.now();
      streak = _tradingDaysSince(activatedAt);
    }

    // ── K 線輔助判斷（傳入 getYaoguStatus）──────────────────────────
    const klineCtx = (() => {
      if (!candles || candles.length < 20) return {};
      const closes  = candles.map(c => c.close);
      const highs   = candles.map(c => c.high ?? c.close);
      const lows    = candles.map(c => c.low  ?? c.close);
      const n       = closes.length;
      const last    = candles[n - 1];
      const prev    = candles[n - 2];

      // MA10 / MA20
      const ma10arr = calcMA(closes, 10);
      const ma20arr = calcMA(closes, 20);
      const lastMA10  = ma10arr[n - 1];
      const lastMA20  = ma20arr[n - 1];
      const lastClose = closes[n - 1];
      const lastLow   = lows[n - 1];

      // 跌破 MA10
      const belowMA10 = lastMA10 != null && lastClose < lastMA10;

      // 測試 MA20 當天守住（低點 < MA20 但收盤 ≥ MA20）
      const testMA20 = lastMA20 != null && lastLow < lastMA20 && lastClose >= lastMA20;

      // KD 從高位（K>70）死叉：需要 calcKD
      let kdHighDeadCross = false;
      try {
        const kdResult = calcKD(candles);
        const kArr = kdResult.k;
        const dArr = kdResult.d;
        if (kArr && kArr.length >= 2) {
          const kNow  = kArr[n - 1], kPrev = kArr[n - 2];
          const dNow  = dArr[n - 1], dPrev = dArr[n - 2];
          // K 從 >70 往下穿越 D
          kdHighDeadCross = kPrev > 70 && kPrev >= dPrev && kNow < dNow;
        }
      } catch(_) {}

      // warningPeak：若有 warningAt，取 warningAt 到今天的最高 high
      // 同時計算近 10 根距高點跌幅（不依賴 warningAt）
      const last10Highs = highs.slice(Math.max(0, n - 10));
      const peak10 = Math.max(...last10Highs);
      const warningPeakDrop = peak10 > 0 ? (peak10 - lastClose) / peak10 * 100 : 0;

      // warningPeak：這波警示段（warningAt 起）的最高 high
      let warningPeak = peak10;
      if (record?.warningAt) {
        const warnDate = new Date(record.warningAt).toDateString();
        let wIdx = n - 1;
        for (let i = n - 1; i >= 0; i--) {
          const cDate = new Date(candles[i].time > 1e10 ? candles[i].time : candles[i].time * 1000).toDateString();
          if (cDate === warnDate) { wIdx = i; break; }
        }
        warningPeak = Math.max(...highs.slice(wIdx));
      }

      return { belowMA10, testMA20, kdHighDeadCross, warningPeak, warningPeakDrop };
    })();

    // close < MA20 直接強制 exit（不依賴 screener W1 策略條件）
    let status = getYaoguStatus(code, signals, record, streak, klineCtx);
    if (!status) return null;

    if (status.status !== 'exit' && record && candles?.length >= 20) {
      const closes    = candles.map(c => c.close);
      const ma20arr   = calcMA(closes, 20);
      const lastMA20  = ma20arr[closes.length - 1];
      const lastClose = closes[closes.length - 1];
      if (lastMA20 && lastClose < lastMA20) {
        status = {
          status:      'exit',
          label:       '🔴 出場確認',
          color:       '#ef4444',
          desc:        '跌破月線，妖股出場底線，請立刻出場',
          strength:    status.strength,
          streak,
          streakLabel: status.streakLabel ?? '',
          activatedAt: record.activatedAt,
        };
      }
    }

    // warning2 解除：收盤突破 warningPeak → 退回 active
    if (status.status === 'warning2' && record && klineCtx.warningPeak) {
      const lastClose = candles[candles.length - 1].close;
      if (lastClose > klineCtx.warningPeak) {
        // 壓力有效突破，重新判斷為 active（讓 X 系列決定最終狀態）
        const hasX = signals.some(s => s.id === 'X1' || s.id === 'X2' || s.id === 'X5');
        if (hasX) {
          status = { ...status, status: 'active', label: '🟢 主升段' + (status.streakLabel ?? '') };
        }
      }
    }

    const now = Date.now();

    if (status.isNew) {
      const activatedAt     = _klineActivatedAt ?? now;
      const activatedStreak = _tradingDaysSince(activatedAt);
      const newRecord = {
        code,
        activatedAt,
        streak:      activatedStreak,
        strength:    status.strength,
        status:      'active',
        lastUpdated: now,
        exitedAt:    null,
      };
      await putYaoguRecord(newRecord);
      console.log(`[yaogu] 🟢 新妖股啟動: ${code} activatedAt=${new Date(activatedAt).toISOString().slice(0,10)} streak=${activatedStreak}`);
      return status;
    }

    if (status.status === 'exit' && record?.status !== 'exited') {
      const updated = { ...record, status: 'exited', exitedAt: now, lastUpdated: now };
      await putYaoguRecord(updated);
      console.log(`[yaogu] 🔴 妖股出場確認: ${code}`);
      return status;
    }

    // 一般更新：streak 和 strength 每次都更新
    if (record) {
      const newWarningAt = (() => {
        const isWarning = status.status === 'warning1' || status.status === 'warning2';
        if (!isWarning) return null;
        return _klineWarningAt ?? record.warningAt ?? null;
      })();
      const needUpdate = record.status !== status.status
        || record.streak !== streak
        || record.strength !== status.strength
        || (newWarningAt !== record.warningAt);  // warningAt 校正也觸發更新
      if (needUpdate) {
        // warningAt：用上方預算的 newWarningAt（已含 K 線校正）
        const warningAt = newWarningAt;

        // activatedAt 自動校正：若 K 線找到更早的觸發點，更新記錄
        const correctedActivatedAt = (_klineActivatedAt && _klineActivatedAt < (record.activatedAt ?? Infinity))
          ? _klineActivatedAt : record.activatedAt;
        const correctedStreak = correctedActivatedAt ? _tradingDaysSince(correctedActivatedAt) : (streak ?? record.streak);

        const updated = {
          ...record,
          status:      status.status,
          activatedAt: correctedActivatedAt ?? record.activatedAt,
          streak:      correctedStreak,
          strength:    status.strength,
          lastUpdated: now,
          warningAt,
        };
        await putYaoguRecord(updated);
        if (record.status !== status.status) {
          console.log(`[yaogu] 狀態更新 ${code}: ${record.status} → ${status.status} streak=${streak} warningAt=${warningAt}`);
        }
      }
    }

    // 把最新狀態存進 AppState.yaoguStatus（讓 UI 不需要再查 DB 才能顯示 streak）
    if (status && typeof AppState !== 'undefined') {
      if (!AppState.yaoguStatus) AppState.yaoguStatus = {};
      AppState.yaoguStatus[code] = status;
    }

    return status;
  } catch (e) {
    console.warn(`[yaogu] updateYaoguTracker(${code}) 失敗:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 策略去重邏輯（v2.2 — 三山三川互斥 + 警示包含關係吸收）
// ─────────────────────────────────────────────

/**
 * 互斥規則：兩個策略邏輯上不可能同時成立，同時觸發時依 tiebreak 取勝者
 * tiebreak(candles) → 回傳贏家 id
 *
 * 三山/三川互斥規則：
 *   - 上漲趨勢中築頂 → 三山贏（即將反轉向下）
 *   - 下跌趨勢中打底 → 三川贏（即將反轉向上）
 *   - 趨勢方向以最近 30 根收盤的線性回歸斜率判定
 */
const MUTEX_RULES = [
  {
    ids: ['S37', 'S38'],
    tiebreak: (candles) => {
      // 最近 30 根 close 的線性回歸斜率
      const seg = candles.slice(-30);
      const closes = seg.map(c => c.close).filter(Number.isFinite);
      if (closes.length < 5) return 'S38';  // 資料太少預設給三川（保守看跌）
      const slope = _linearSlope(closes);
      // 正歸一化斜率（除以平均價）讓不同價位股票可比較
      const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
      const normSlope = avg > 0 ? slope / avg : 0;
      // |normSlope| < 0.0003/根（30 根累積 ≈ 0.9%）視為橫盤，兩者都不亮
      if (Math.abs(normSlope) < 0.0003) return null;
      return normSlope >= 0 ? 'S37' : 'S38';
    },
  },
];

/**
 * 吸收規則：[強者, 被吸收者]，強者亮時弱者不亮（強者是弱者的更詳細版本）
 *
 * 跌破月線系列：W1（純跌破月線）會被任何複合警示吸收
 * 三重弱勢 W10 是其他三個的超集，亮 W10 時其他都應吸收
 */
const ABSORPTION_RULES = [
  // 跌破月線被各種複合版吸收（按你的指示：量縮跌破月線優先）
  ['W3',  'W1'],   // MACD死叉跌破月線 ⊃ 跌破月線
  ['W4',  'W1'],   // 量縮跌破月線 ⊃ 跌破月線
  ['W8',  'W1'],   // RSI超買跌破月線 ⊃ 跌破月線
  ['W9',  'W1'],   // KD死叉月線下 ⊃ 跌破月線
  ['W10', 'W1'],   // 三重弱勢 ⊃ 跌破月線
  // 三重弱勢吸收其他子集
  ['W10', 'W2'],   // 三重弱勢 ⊃ KD+MACD雙死叉
  ['W10', 'W3'],   // 三重弱勢 ⊃ MACD死叉跌破月線
  ['W10', 'W9'],   // 三重弱勢 ⊃ KD死叉月線下
  // ── v2.6 新增 W11~W20 母子關係 ──
  ['W12', 'W1'],   // 均線空頭排列 ⊃ 跌破月線
  ['W18', 'W1'],   // 葛蘭碧賣一 ⊃ 跌破月線
  ['W15', 'W1'],   // 葛蘭碧賣二 ⊃ 跌破月線（W15 含 below_ma20）
  ['W19', 'W1'],   // 葛蘭碧賣三 ⊃ 跌破月線（W19 含 below_ma20）
  ['W14', 'W2'],   // MACD高位死叉 ⊃ KD+MACD雙死叉（高位死叉更具體）
  ['W11', 'W19'],  // 雲層跌破 ⊃ 雲層內震盪
  ['W11', 'W16'],  // 雲層跌破 ⊃ 轉換跌破基準（雲層跌破已含早期轉弱）
  ['W18', 'W15'],  // 葛蘭碧賣一 ⊃ 葛蘭碧賣二（賣一是更確定的轉折）
];

/**
 * 線性回歸斜率（與 screener.js 同公式，獨立副本避免循環依賴）
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

/**
 * 對策略清單套用互斥與吸收規則
 * @param {Signal[]} signals
 * @param {Candle[]} candles
 * @returns {Signal[]}
 */
function _dedupeSignals(signals, candles) {
  if (!signals || signals.length === 0) return signals;
  const idSet = new Set(signals.map(s => s.id));
  const toRemove = new Set();

  // 1. 互斥規則：同時觸發時依 tiebreak 取勝者
  for (const rule of MUTEX_RULES) {
    const triggered = rule.ids.filter(id => idSet.has(id) && !toRemove.has(id));
    if (triggered.length >= 2) {
      const winner = rule.tiebreak(candles);
      if (winner === null) {
        // 橫盤無方向，全部移除
        triggered.forEach(id => toRemove.add(id));
      } else {
        // 移除非贏家
        triggered.filter(id => id !== winner).forEach(id => toRemove.add(id));
      }
    }
  }

  // 2. 吸收規則：強者亮時弱者移除
  for (const [strong, weak] of ABSORPTION_RULES) {
    if (idSet.has(strong) && !toRemove.has(strong) && idSet.has(weak)) {
      toRemove.add(weak);
    }
  }

  return signals.filter(s => !toRemove.has(s.id));
}

// ─────────────────────────────────────────────
// 2. Lazy 模式(Phase 7.4)— 單檔掃描 + 持久化
// ─────────────────────────────────────────────

/**
 * 啟動時從 IndexedDB 還原上次的訊號結果到 AppState.signals
 * 這樣使用者打開選股台時就能看到燈號(雖然可能是上次的)
 *
 * v2.5 — 版號驗證:讀回時若 _v !== STRATEGY_VERSION,代表是舊 calc 算出的快取,
 *        直接整批清掉並回傳 0,讓使用者下次掃描用新邏輯重算。
 *        這是避免「修了 calc 卻看到舊燈號」的系統性陷阱。
 */
export async function restoreSignalsFromCache() {
  try {
    const all = await getAllSignalsCache();
    if (!AppState.signals) AppState.signals = {};

    // ── v2.5 版號預檢:抽樣看快取版號 ──
    // 若所有 row 都沒有 _v 或 _v 不是當前版本,表示這批是舊 calc 結果
    // 直接整批清光(下次自然會用新邏輯重掃)
    const hasValidVersion = all.some(row => row?._v === STRATEGY_VERSION);
    const hasAnyData = all.length > 0;
    if (hasAnyData && !hasValidVersion) {
      const n = await clearAllSignalsCache();
      console.log(`[signal-scan] ⚠ 偵測到舊版策略快取 (STRATEGY_VERSION=${STRATEGY_VERSION}),已清空 ${n} 檔,等待重新掃描`);
      return 0;
    }

    let count = 0;
    let oldestAt = Date.now();
    let skipped = 0;
    for (const row of all) {
      // 個別 row 也驗證一次:過渡期可能 mixed(部分新部分舊)
      if (row?._v !== STRATEGY_VERSION) {
        // 個別舊版 row,順手清掉
        if (row?.code) deleteSignalsCache(row.code).catch(() => {});
        skipped++;
        continue;
      }
      if (row.code && Array.isArray(row.signals)) {
        AppState.signals[row.code] = row.signals;
        // 也順帶把 scannedAt 存起來供 UI 顯示「上次掃描時間」
        AppState.signals[row.code]._scannedAt = row.scannedAt;
        count++;
        if (row.scannedAt < oldestAt) oldestAt = row.scannedAt;
      }
    }
    if (count > 0) {
      const ageMin = Math.round((Date.now() - oldestAt) / 60000);
      const skipMsg = skipped > 0 ? `, 略過 ${skipped} 檔舊版快取` : '';
      console.log(`[signal-scan] 從 IndexedDB 還原 ${count} 檔訊號(最舊 ${ageMin} 分前${skipMsg})`);
      // 通知 UI 更新燈號
      document.dispatchEvent(new CustomEvent('signalsUpdated', { detail: AppState.signals }));
    } else if (skipped > 0) {
      console.log(`[signal-scan] 略過 ${skipped} 檔舊版快取,等待新版掃描`);
    }
    return count;
  } catch (e) {
    console.warn('[signal-scan] restoreSignalsFromCache failed:', e?.message);
    return 0;
  }
}

/**
 * Phase 7.4 — 從 K 線快取重算燈號(主要版本)
 *
 * 流程:
 *   1. 讀 kline_cache 裡所有快取過的 K 線(自選清單有的 + 今天打開過的)
 *   2. 對每個快取命中的股票跑 matchSignals(純計算,0 API)
 *   3. 沒有快取的股票 → 回傳 miss 清單供呼叫者決定要不要打 API
 *
 * @param {string[]} codes  要重算的代號清單
 * @returns {object}  { hit: { [code]: Signal[] }, miss: string[] }
 */
export async function recalcSignalsFromKlineCache(codes) {
  if (!codes || !codes.length) return { hit: {}, miss: [] };

  const priceCache = window.__priceCache ?? {};
  const now = Date.now();
  const hit  = {};
  const miss = [];

  // 盡量取每檔最長的有效 K 線(3mo 最常用,fallback 到其他週期)
  const PREFERRED_PERIODS = ['1y'];  // 改為 1y，確保 SAR(≥32根)/GMMA(≥62根)/杯柄(≥60根) 有足夠資料

  for (const code of codes) {
    let found = null;
    for (const period of PREFERRED_PERIODS) {
      // 需要先知道 symbol,但 kline_cache 的 key 是 `${symbol}_${period}`
      // 上市用 .TW,上櫃用 .TWO
      // 用 _guessSymbols 試兩個
      const symbols = _guessSymbols(code);
      for (const sym of symbols) {
        try {
          const cached = await getKlineCache(sym, period);
          if (cached && cached.validUntil > now && cached.candles?.length >= 5) {
            found = cached.candles;
            break;
          }
        } catch (e) { /* continue */ }
      }
      if (found) break;
    }

    if (found) {
      const twseRow = priceCache[code] ?? null;
      const signals = matchSignals(found, twseRow);
      hit[code] = signals;

      // 寫進 AppState + IndexedDB
      if (!AppState.signals) AppState.signals = {};
      AppState.signals[code] = signals;
      AppState.signals[code]._scannedAt = now;
      setSignalsCache(code, signals, STRATEGY_VERSION).catch(() => {});
    } else {
      miss.push(code);
    }
  }

  return { hit, miss };
}

// 猜測一個 code 對應的 Yahoo symbol 可能是什麼
// (不打 API,純靠 _otcSet 快速猜)
function _guessSymbols(code) {
  // 非純數字代號(已帶 suffix)
  if (!/^\d{4,6}$/.test(code)) return [code.toUpperCase()];
  // 純數字:試 .TW 和 .TWO
  return [`${code}.TW`, `${code}.TWO`];
}

/**
 * 掃描單一個股(Lazy 模式核心)
 * 用 K 線快取(走 resolveYahooSymbol → fetchHistoryCached),通常 0 個 Worker request
 * 結果存進 AppState.signals + IndexedDB
 *
 * @param {string} code           個股代碼
 * @param {object} opts
 *   - opts.force {boolean}       force=true 跳過 K 線快取,強制重抓
 *   - opts.silent {boolean}      silent=true 不觸發 signalsUpdated 事件
 * @returns {Signal[]}
 */
export async function scanOneCode(code, opts = {}) {
  if (!code) return [];
  try {
    const priceCache = window.__priceCache ?? {};
    const { candles } = await resolveYahooSymbol(code, '1y', { force: !!opts.force });
    const twseRow = priceCache[code] ?? null;
    const rawSignals = matchSignals(candles, twseRow);

    // v2.8 妖股保留注入：盤中縮量時 X 訊號可能暫滅，但 DB 記錄為 active/watching
    // 先讀 DB 記錄，再注入缺失的 X 訊號（injectYaoguSignals 依 strength 決定補哪些）
    let signals = rawSignals;
    try {
      const yaoguRec = await getYaoguRecord(code);
      if (yaoguRec && yaoguRec.status !== 'exited') {
        signals = injectYaoguSignals(rawSignals, yaoguRec);
      }
    } catch(_e) { /* silent — 不擋主流程 */ }

    // 寫入 AppState + IndexedDB
    if (!AppState.signals) AppState.signals = {};
    AppState.signals[code] = signals;
    AppState.signals[code]._scannedAt = Date.now();

    // 非同步寫 IndexedDB,不擋回傳
    setSignalsCache(code, signals, STRATEGY_VERSION).catch(e =>
      console.warn(`[signal-scan] setSignalsCache(${code}) 失敗:`, e?.message)
    );

    // v2.8 妖股狀態機：等 updateYaoguTracker 算完 streak 再觸發重繪
    updateYaoguTracker(code, signals, candles).then(ys => {
      if (ys && document.getElementById('stockYaoguChip')) {
        // chip 容器存在代表使用者在個股頁，重新渲染一次（含 streak）
        document.dispatchEvent(new CustomEvent('yaoguUpdated', { detail: { code, ys } }));
      }
    }).catch(() => {});

    // 通知 UI(watchlist.js 監聽這個事件,refresh 燈號)
    if (!opts.silent) {
      document.dispatchEvent(new CustomEvent('signalsUpdated', {
        detail: { [code]: signals },
      }));
    }
    return signals;
  } catch (e) {
    console.warn(`[signal-scan] scanOneCode(${code}) 失敗:`, e?.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// 3. 全自選清單批次掃描(只在「⟳ 更新全部」按鈕觸發)
// ─────────────────────────────────────────────

let _scanning = false;
let _paused   = false;  // Phase 7.4 — 共振 Tab 等優先功能可暫停掃描

/**
 * 暫停掃描(在批次間隔時實際生效;當前 in-flight 的 2 檔會跑完)
 * Phase 7.4:當 multi-period 在抓資料時,讓 signal-scan 讓路
 */
export function pauseSignalScan() {
  _paused = true;
  console.log('[signal-scan] 已暫停');
}

/**
 * 恢復掃描
 */
export function resumeSignalScan() {
  _paused = false;
  console.log('[signal-scan] 已恢復');
}

/**
 * 批次掃描自選清單(由「⟳ 更新全部燈號」按鈕觸發)
 *
 * Phase 7.4 最佳化策略:
 *   1. 先用 recalcSignalsFromKlineCache 從已有的 K 線快取重算(0 API)
 *   2. 快取 miss 的股票才打 API(通常是從沒打開過的股)
 *   3. force=true 跳過 k 線快取,強制所有檔都打 API
 */
export async function scanWatchlistSignals(opts = {}) {
  if (_scanning) {
    console.log('[signal-scan] 已有掃描進行中,跳過');
    return { aborted: false, total: 0, success: 0, failed: 0, throttled: 0, fromCache: 0 };
  }

  // ⚠️ Worker 冷卻保護：若 Worker 正在 5 分鐘冷卻中，不打 API 掃描
  // 理由：Worker 暫停時 fallback 走公開 proxy，公開 proxy 扛不住 signal scan 的並發量，全掛
  // 快取命中（recalcSignalsFromKlineCache）仍然可以跑，所以這裡只擋 API 部分
  const workerDown = isWorkerCooling();
  if (workerDown && !opts.force) {
    console.warn('[signal-scan] Worker 冷卻中，跳過 API 掃描（快取重算仍執行）');
    // 提示 UI（若有 showToast 全域函式）
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('代理伺服器暫時冷卻中，僅從快取更新燈號', 'warn');
    }
    // 只跑快取重算，不打 API
    opts = { ...opts, _skipApi: true };
  }

  _scanning = true;

  // 決定要掃哪些 codes
  let codes;
  if (Array.isArray(opts.codes)) {
    codes = opts.codes;
  } else {
    const groups = AppState.watchlistGroups ?? [];
    const codeSet = new Set();
    for (const g of groups) {
      for (const s of g.stocks) codeSet.add(s.code);
    }
    codes = [...codeSet];
  }

  const totalCodes = codes.length;
  console.log(`[signal-scan] 批次掃描 ${totalCodes} 檔 (force=${!!opts.force})`);
  if (!totalCodes) {
    _scanning = false;
    return { aborted: false, total: 0, success: 0, failed: 0, throttled: 0, fromCache: 0 };
  }

  let fromCacheCount = 0;
  let missedCodes = codes;

  // Phase 1:從 kline_cache 重算(0 API)— force 時跳過
  if (!opts.force) {
    const { hit, miss } = await recalcSignalsFromKlineCache(codes);
    fromCacheCount = Object.keys(hit).length;
    missedCodes = miss;

    // 通知 UI 已從快取算完的部分
    if (fromCacheCount > 0) {
      document.dispatchEvent(new CustomEvent('signalsUpdated', { detail: hit }));
      opts.onProgress?.(fromCacheCount, totalCodes);
      console.log(`[signal-scan] 快取命中 ${fromCacheCount} 檔(0 API),需打 API: ${missedCodes.length} 檔`);
    }
  }

  // Phase 2:對 miss 的打 API
  const results = {};
  let throttledCount = 0;
  let successCount   = 0;
  let consecFails    = 0;
  let aborted        = false;
  let done = fromCacheCount;  // 進度從快取命中數開始計

  // Worker 冷卻中，或呼叫方明確標記跳過 API
  if (opts._skipApi) {
    console.log('[signal-scan] 跳過 API 掃描（Worker 冷卻或明確標記 _skipApi）');
    missedCodes = [];  // 清空，不打 API
  }

  if (missedCodes.length > 0) {
    const priceCache = window.__priceCache ?? {};
    const CONCURRENCY = 2;
    const BATCH_DELAY = 800;
    const ABORT_AFTER_CONSECUTIVE_FAILS = 5;

    outer: for (let i = 0; i < missedCodes.length; i += CONCURRENCY) {
      while (_paused) {
        await new Promise(r => setTimeout(r, 500));
      }

      // 首批請求加隨機分散延遲（0–400ms），避免多檔同時打到 Worker
      // 非首批已有 BATCH_DELAY，不需要額外分散
      const isFirstBatch = (i === 0);
      if (isFirstBatch && missedCodes.length > 1) {
        await new Promise(r => setTimeout(r, Math.random() * 400));
      }

      const batch = missedCodes.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (code, batchIdx) => {
        // 每個 request 之間再加小間隔（避免同批 2 個同時打）
        if (batchIdx > 0) await new Promise(r => setTimeout(r, 300 * batchIdx));

        try {
          const { candles } = await resolveYahooSymbol(code, '1y', { force: !!opts.force });
          const twseRow = priceCache[code] ?? null;
          const signals = matchSignals(candles, twseRow);
          results[code] = signals;
          successCount++;
          consecFails = 0;
          setSignalsCache(code, signals, STRATEGY_VERSION).catch(e =>
            console.warn(`[signal-scan] setSignalsCache(${code}) 失敗:`, e?.message)
          );
        } catch (e) {
          const msg = e?.message || String(e);
          if (/Too Many Requests|429|502|proxy|Edge|Failed to fetch/i.test(msg)) throttledCount++;
          consecFails++;
          console.warn(`[signal-scan] ${code} 失敗:`, msg);
          results[code] = [];
        } finally {
          done++;
          opts.onProgress?.(done, totalCodes);
        }
      }));

      if (consecFails >= ABORT_AFTER_CONSECUTIVE_FAILS) {
        aborted = true;
        console.warn(`[signal-scan] 連續失敗 ${consecFails} 次,提早中止`);
        break outer;
      }

      if (i + CONCURRENCY < missedCodes.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }
  }

  // 合進 AppState
  if (!AppState.signals) AppState.signals = {};
  for (const [code, signals] of Object.entries(results)) {
    AppState.signals[code] = signals;
    AppState.signals[code]._scannedAt = Date.now();
  }

  const totalSignals = [
    ...Object.values(results),
    ...Object.values(AppState.signals).filter((s, _, a) => !results[a]),
  ].reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

  console.log(`[signal-scan] 完成 | 快取 ${fromCacheCount} / API ${successCount} / 失敗 ${done - fromCacheCount - successCount}`);
  if (throttledCount > 0) console.warn(`[signal-scan] ⚠ ${throttledCount} 檔被限流`);

  if (Object.keys(results).length > 0) {
    document.dispatchEvent(new CustomEvent('signalsUpdated', { detail: results }));
  }
  _scanning = false;

  return {
    aborted,
    workerCooling: workerDown,   // Worker 是否在冷卻（供 UI 判斷要不要顯示提示）
    total:     totalCodes,
    fromCache: fromCacheCount,
    processed: done,
    success:   fromCacheCount + successCount,
    failed:    done - fromCacheCount - successCount,
    throttled: throttledCount,
  };
}

// ─────────────────────────────────────────────
// 4. 定時掃描（已廢棄）
// ─────────────────────────────────────────────

let _timer = null;

/**
 * 啟動定時掃描
 * @param {number} intervalMs  掃描間隔(預設 10 分鐘,Phase 7.4 從 5 分鐘調整)
 */
/**
 * 啟動定時掃描
 * ⚠ Phase 7.4 — Lazy 模式之後此函式已 deprecated,不再做任何事。
 *   訊號改成「開哪檔掃哪檔」(loadStock → scanOneCode)。
 *   想批次更新時,UI 上點「⟳ 更新全部燈號」按鈕觸發 scanWatchlistSignals。
 *
 * 保留 export 以維持向後相容,但不再啟動 timer。
 * @param {number} intervalMs  (已忽略)
 */
export function startSignalTimer(intervalMs = 10 * 60 * 1000) {
  stopSignalTimer();
  console.log('[signal-scan] Lazy 模式啟用,定時掃描已停用');
  // 不再啟動 setInterval
}

export function stopSignalTimer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** 判斷目前是否在盤中時段（台灣時間 09:00–13:35） */
function _isTradingHours() {
  const now = new Date();
  // 台灣 UTC+8
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const h    = utc8.getUTCHours();
  const m    = utc8.getUTCMinutes();
  const mins = h * 60 + m;
  // 週一到週五 09:00–13:35
  const day  = utc8.getUTCDay();   // 0=日, 6=六
  if (day === 0 || day === 6) return false;
  return mins >= 9 * 60 && mins <= 13 * 60 + 35;
}
