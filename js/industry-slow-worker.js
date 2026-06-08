// js/industry-slow-worker.js
// ============================================================================
// 族群回測 Slow Worker — Phase 2 完整策略計算（效能優化版）
//
// 優化項目（不破壞 screener.js 介面相容性）：
//   1. CONDITION_DEFS 改用 Map（O(1) 查詢，消除每根K線的 find）
//   2. 策略條件分類在 Worker 啟動時預處理，不在每根K線重複分類
//   3. 同一策略的 indCache：每支股票 × 每個策略只算一次指標（hold 不影響指標）
//   4. 消除 candles.slice(0, i+1) → 改用 candles.subarray 或直接傳 endIdx
//      注意：calc(sliced) 介面不變，仍 slice（但從快取取結果不重複 calc）
//
// 通訊協定：
//   Main → Worker:  { type: 'run', payload: { entries, strategies, holdOptions } }
//   Worker → Main:  { type: 'result', code, strat, hold, sigs }
//                   { type: 'progress', done, total }
//                   { type: 'done' }
// ============================================================================

import { STRATEGIES } from './strategy.js';

// ── Phase 1 內建 match（不依賴 screener.js，避免 firebase.js 鏈）────────────
const _P1_MATCH = {
  price_min: (row, v) => row.price >= v,
  price_max: (row, v) => row.price <= v,
  chg_min:   (row, v) => row.chgPct >= v,
  chg_max:   (row, v) => row.chgPct <= v,
  vol_min:   (row, v) => row.volume >= v,
  vol_max:   (row, v) => row.volume <= v,
};
const _P1_DEFAULT = { price_min:10, price_max:9999, chg_min:3, chg_max:-3, vol_min:1000, vol_max:9999999 };

// ── CONDITION_DEFS Map（由主執行緒傳入 id+phase，Worker 只用於分類 p1/p2）──
let _condMap = null;
function getCondMap() {
  return _condMap;
}
function initCondMap(condDefs) {
  // condDefs 只含 {id, phase}，函式不可序列化
  _condMap = new Map(condDefs.map(d => [d.id, d]));
}

function _tsToDate(ts) {
  if (!ts) return '—';
  if (typeof ts === 'string') return ts.replace(/-/g, '/').slice(0, 10);
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

// ── 策略預處理（Worker 啟動後每個策略只做一次）────────────────────────────
function _prepareStrategy(strategyId) {
  const condMap  = getCondMap();
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return null;

  const p1 = [], p2 = [];
  for (const c of strategy.conditions) {
    const def = condMap?.get(c.condId);
    // condMap 為 null（未傳入）時視為 phase=2
    const phase = def?.phase ?? 2;
    if (phase === 3) return null;
    if (phase === 1) {
      p1.push({ def: { id: c.condId, phase: 1 }, value: c.value ?? _P1_DEFAULT[c.condId] });
    } else {
      // Phase2：只需 condId 供 condSeqAt 查詢
      p2.push({ def: { id: c.condId, phase: 2, calc: def?.calc, match: def?.match }, value: c.value ?? def?.default });
    }
  }

  // Phase2 需要的 calc 函式（condReady=false 的 fallback）
  const calcFns = [];
  const seen = new Set();
  for (const { def } of p2) {
    if (def?.calc && !seen.has(def.id)) { calcFns.push(def); seen.add(def.id); }
  }

  return { id: strategyId, p1, p2, calcFns };
}

// ── 指標快取（每支股票 × 每個策略只算一次，不因 holdDays 重算）─────────────
// 回傳 indCache[i] = indicators（candles[0..i] 的指標結果）
function _buildIndCache(candles, stratInfo) {
  if (!stratInfo.calcFns.length) return null;
  const cache = new Array(candles.length).fill(null);
  for (let i = 59; i < candles.length; i++) {
    const sliced = candles.slice(0, i + 1); // 仍需 slice 保持 calc 介面相容
    const ind = {};
    for (const def of stratInfo.calcFns) {
      try { Object.assign(ind, def.calc(sliced)); } catch {}
    }
    cache[i] = ind;
  }
  return cache;
}

// ── 單點匹配（優先查 GAS condition 序列，fallback 本機指標快取）──────────
// condSeqAt: 該根 K 線命中的 condition id Set（來自 GAS R2）
function _matchAt(candles, i, stratInfo, indCache, condSeqAt) {
  if (i < 19) return false;

  const last   = candles[i];
  const prev   = candles[i - 1];
  const chgPct = prev?.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
  const twseRow = { price: last.close, chgPct, volume: Math.round((last.volume ?? 0) / 1000) };

  // Phase1（內建 match，不依賴 def.match 函式）
  for (const { def, value } of stratInfo.p1) {
    const matchFn = _P1_MATCH[def?.id];
    if (!matchFn) continue;
    try { if (!matchFn(twseRow, value)) return false; } catch { return false; }
  }

  // Phase2（優先查 GAS condition 序列）
  if (stratInfo.p2.length > 0) {
    if (condSeqAt) {
      // GAS 序列：直接查 Set，O(1)，極快
      for (const { def } of stratInfo.p2) {
        if (!condSeqAt.has(def.id)) return false;
      }
    } else {
      // Fallback：本機指標快取
      const ind = indCache?.[i];
      if (!ind) return false;
      for (const { def, value } of stratInfo.p2) {
        try { if (!def.match(ind, value)) return false; } catch { return false; }
      }
    }
  }
  return true;
}

// ── 訊號計算────────────────────────────────────────────────────────────────
// condSeqSets: Array<Set<string>>，index 對應 candles（由 GAS 序列轉換）
// condSeqOffset: candles 總長度 - condSeqSets 長度（序列從哪根 candle 開始）
function _calcSignals(candles, stratInfo, indCache, holdDays, condSeqSets, condSeqOffset) {
  const signals  = [];
  const maxIdx   = candles.length - holdDays - 1;
  const avg20vol = candles.slice(-20).reduce((s, c) => s + (c.volume ?? 0), 0) / 20 / 1000;

  for (let i = 60; i <= maxIdx; i++) {
    // 查 GAS condition 序列（若有）
    const seqIdx = condSeqSets ? i - condSeqOffset : -1;
    const condSeqAt = (condSeqSets && seqIdx >= 0 && seqIdx < condSeqSets.length)
      ? condSeqSets[seqIdx] : null;

    if (_matchAt(candles, i, stratInfo, indCache, condSeqAt)) {
      const entry    = candles[i].close;
      const exit     = candles[i + holdDays].close;
      const ret      = (exit - entry) / entry * 100;
      const volK     = Math.round((candles[i].volume ?? 0) / 1000);
      const volRatio = avg20vol > 0 ? +(volK / avg20vol).toFixed(2) : 1;
      signals.push({
        date: _tsToDate(candles[i].time),
        entry, exit,
        ret:      +ret.toFixed(2),
        win:      ret > 0,
        vol:      volK,
        volRatio,
      });
    }
  }
  return signals;
}

// ── Worker 主流程 ──────────────────────────────────────────────────────────
self.onmessage = function(e) {
  const { type, payload } = e.data;
  if (type !== 'run') return;

  const { entries, strategies, holdOptions, condReady, condDefs } = payload;
  if (condDefs) initCondMap(condDefs);
  const total = entries.length;

  // 預處理所有策略（整個 run 只做一次）
  const stratInfos = strategies.map(id => _prepareStrategy(id)).filter(Boolean);

  for (let ei = 0; ei < entries.length; ei++) {
    const { code, candles: rawCandles, condSeq } = entries[ei];

    // condReady 模式：從 condSeq 轉換成 Set 陣列，candles 仍需用於 Phase1 + 持有報酬計算
    // condSeq.seq: Array<string[]>（true condition ids，由舊到新）
    // condSeq.len: 序列長度
    let condSeqSets = null, condSeqOffset = 0;
    const candles = rawCandles;  // condReady 時 strategy-lab 仍傳 candles（Phase1 + 報酬計算需要）

    if (condReady && condSeq?.seq) {
      condSeqSets = condSeq.seq.map(ids => new Set(ids));
      // offset = candles 總長 - seq 長（seq 從哪根 candle 開始）
      condSeqOffset = (candles?.length ?? condSeq.len) - condSeq.len;
    }

    if (!candles || candles.length < 60) continue;

    let bestScore = -Infinity, bestSigs = null, bestStrat = null, bestHold = null;

    for (const stratInfo of stratInfos) {
      // condReady 模式下 Phase2 查序列，indCache 只在 fallback 時需要
      const indCache = condSeqSets ? null : _buildIndCache(candles, stratInfo);

      for (const hold of holdOptions) {
        const sigs = _calcSignals(candles, stratInfo, indCache, hold, condSeqSets, condSeqOffset);
        if (!sigs.length) continue;
        const wins  = sigs.filter(s => s.win).length;
        const wr    = wins / sigs.length * 100;
        const ret   = sigs.reduce((s, x) => s + x.ret, 0) / sigs.length;
        const score = wr * 0.6 + ret * 0.4;
        if (score > bestScore) {
          bestScore = score; bestSigs = sigs;
          bestStrat = stratInfo.id; bestHold = hold;
        }
      }
    }

    if (bestSigs) {
      const avg60vol = Math.round(
        candles.slice(-60).reduce((s, c) => s + (c.volume ?? 0), 0) / 60 / 1000
      );
      self.postMessage({ type: 'result', code, strat: bestStrat, hold: bestHold, sigs: bestSigs, avg60vol });
    }

    if ((ei + 1) % 10 === 0 || ei + 1 === total) {
      self.postMessage({ type: 'progress', done: ei + 1, total });
    }
  }

  self.postMessage({ type: 'done' });
};
