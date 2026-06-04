// js/industry-slow-worker.js
// ============================================================================
// 族群回測 Slow Worker — Phase 2 完整策略計算
//
// 接收候選股（已知有 Phase 1 觸發），跑完整指標計算找最佳策略組合
//
// 通訊協定：
//   Main → Worker:  { type: 'run', payload: { entries, strategies, holdOptions } }
//   Worker → Main:  { type: 'result', code, strat, hold, sigs }
//                   { type: 'progress', done, total }
//                   { type: 'done' }
// ============================================================================

import { CONDITION_DEFS } from './screener.js';
import { STRATEGIES }     from './strategy.js';

function _tsToDate(ts) {
  if (!ts) return '—';
  if (typeof ts === 'string') return ts.replace(/-/g, '/').slice(0, 10);
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function _matchStrategyAt(sliced, strategyId) {
  if (sliced.length < 20) return false;
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return false;

  const hasPhase3 = strategy.conditions.some(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    return def?.phase === 3;
  });
  if (hasPhase3) return false;

  const allDefsExist = strategy.conditions.every(c =>
    CONDITION_DEFS.some(d => d.id === c.condId)
  );
  if (!allDefsExist) return false;

  const last   = sliced[sliced.length - 1];
  const prev   = sliced[sliced.length - 2];
  const chgPct = prev?.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
  const twseRow = { price: last.close, chgPct, volume: Math.round((last.volume ?? 0) / 1000) };

  const phase1Conds = strategy.conditions.filter(c => CONDITION_DEFS.find(d => d.id === c.condId)?.phase === 1);
  const phase2Conds = strategy.conditions.filter(c => CONDITION_DEFS.find(d => d.id === c.condId)?.phase === 2);

  if (phase1Conds.length > 0) {
    const p1Pass = phase1Conds.every(c => {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      try { return def.match(twseRow, c.value ?? def.default); } catch { return false; }
    });
    if (!p1Pass) return false;
  }

  const indicators = {};
  const calcDone   = new Set();
  for (const c of phase2Conds) {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    if (def?.calc && !calcDone.has(def.id)) {
      try { Object.assign(indicators, def.calc(sliced)); } catch {}
      calcDone.add(def.id);
    }
  }

  return phase2Conds.every(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    try { return def.match(indicators, c.value ?? def.default); } catch { return false; }
  });
}

function _calcStrategySignals(candles, strategyId, holdDays) {
  const signals = [];
  const maxIdx  = candles.length - holdDays - 1;

  // 近 20 日均量（張），用於計算量比
  const avg20vol = candles.slice(-20).reduce((s, c) => s + (c.volume ?? 0), 0) / 20 / 1000;

  for (let i = 60; i <= maxIdx; i++) {
    if (_matchStrategyAt(candles.slice(0, i + 1), strategyId)) {
      const entry    = candles[i].close;
      const exit     = candles[i + holdDays].close;
      const ret      = (exit - entry) / entry * 100;
      const volShares = candles[i].volume ?? 0;
      const volK     = Math.round(volShares / 1000);           // 張
      const volRatio = avg20vol > 0 ? +(volK / avg20vol).toFixed(2) : 1; // 量比
      signals.push({
        date: _tsToDate(candles[i].time),
        entry, exit,
        ret:      +ret.toFixed(2),
        win:      ret > 0,
        vol:      volK,       // 訊號當日成交量（張）
        volRatio,             // 量比（相對近20日均量）
      });
    }
  }
  return signals;
}

self.onmessage = function(e) {
  const { type, payload } = e.data;
  if (type !== 'run') return;

  const { entries, strategies, holdOptions } = payload;
  const total = entries.length;

  for (let ei = 0; ei < entries.length; ei++) {
    const { code, candles } = entries[ei];
    let bestScore = -Infinity, bestSigs = null, bestStrat = null, bestHold = null;

    for (const stratId of strategies) {
      for (const hold of holdOptions) {
        const sigs = _calcStrategySignals(candles, stratId, hold);
        if (!sigs.length) continue;
        const wins  = sigs.filter(s => s.win).length;
        const wr    = wins / sigs.length * 100;
        const ret   = sigs.reduce((s, x) => s + x.ret, 0) / sigs.length;
        const score = wr * 0.6 + ret * 0.4;
        if (score > bestScore) { bestScore = score; bestSigs = sigs; bestStrat = stratId; bestHold = hold; }
      }
    }

    if (bestSigs) {
      // 近 60 日均量（張），代表這支股票的流動性水準
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
