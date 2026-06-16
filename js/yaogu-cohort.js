/**
 * yaogu-cohort.js — 妖股世代分析（一代 vs 二代妖股對照驗證）
 *
 * 核心問題：重生後的「二代妖股」是否真的比「一代妖股」更猛？
 *   用真實 yaogu_tracker record + K 線 forward return 對照，數據說話。
 *
 * 對外 API：
 *   analyzeYaoguCohorts() → {
 *     gen1: {...}, gen2: {...},
 *     byType: { breakout, turnover, squeeze, control },
 *     samples: [...],   // 逐檔明細
 *     verdict: string,  // 文字結論
 *   }
 *
 * ⚠ 資料誠實聲明：
 *   - record 只有「當前狀態」，沒有歷史每次二波的完整 forward return。
 *   - 本分析是「目前在追蹤的這批妖股，從各自啟動日到今天」的橫斷面快照。
 *   - 樣本量受限於當前妖股數，非完整歷史回測。樣本 < 5 時結論不可信，會明確標示。
 *   - 選擇性存活偏差：能走到二波的本就是活下來的強股，二代績效天生偏高，
 *     對照時看「啟動後 forward return」而非「能否走到二波」，並標註此偏差。
 */

import { getAllYaoguRecords } from './db.js';
import { fetchHistoryCached } from './api-kline.js';

const WORKER_BASE = 'https://stock-2027.luffy0606.workers.dev';
const PROXY_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';

/**
 * 主入口：優先讀 Worker 全市場世代分析（GAS 夜間算好的完整母體），
 *         讀不到才 fallback 本地追蹤妖股（橫斷面快照）。
 */
export async function analyzeYaoguCohorts(onProgress = null) {
  // ① 優先：Worker 全市場結果（signals:yaogu:cohort）
  try {
    if (onProgress) onProgress(0, 1);
    const res = await fetch(WORKER_BASE + '/yaogucohort', {
      cache: 'no-store', headers: { 'X-Proxy-Token': PROXY_TOKEN },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.counts && data.counts.total > 0) {
        if (onProgress) onProgress(1, 1);
        data.source = 'market';   // 標記：全市場
        data.verdict = _buildVerdict(data.gen1?.d20 ?? {}, data.gen2?.d20 ?? {}, data.byType ?? {});
        return data;
      }
    }
  } catch (e) {
    console.warn('[cohort] Worker 全市場讀取失敗，改用本地:', e.message);
  }
  // ② Fallback：本地追蹤妖股（橫斷面）
  const local = await _analyzeLocalCohorts(onProgress);
  local.source = 'local';
  return local;
}

// ── 本地 fallback：讀 IndexedDB 追蹤妖股，算 forward return ──────────────────
function _forwardReturn(candles, activatedTs, nDays) {
  if (!candles?.length || !activatedTs) return null;
  // 找啟動日對應 idx
  let aIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const ts = candles[i].time > 1e10 ? candles[i].time : candles[i].time * 1000;
    if (ts >= activatedTs - 86400000) { aIdx = i; break; }
  }
  if (aIdx < 0 || aIdx >= candles.length - 1) return null;
  const entryClose = candles[aIdx].close;
  const exitIdx = Math.min(aIdx + nDays, candles.length - 1);
  // 未到期（資料不足 nDays）標記
  const matured = (aIdx + nDays) <= candles.length - 1;
  const exitClose = candles[exitIdx].close;
  if (!entryClose) return null;
  return {
    ret: +((exitClose / entryClose - 1) * 100).toFixed(2),
    matured,
    barsHeld: exitIdx - aIdx,
    // 區間最大漲幅（衝高能力）
    maxRet: +((Math.max(...candles.slice(aIdx, exitIdx + 1).map(c => c.high ?? c.close)) / entryClose - 1) * 100).toFixed(2),
    // 區間最大回撤
    maxDd: +((Math.min(...candles.slice(aIdx, exitIdx + 1).map(c => c.low ?? c.close)) / entryClose - 1) * 100).toFixed(2),
  };
}

// 一組樣本的統計
function _cohortStats(samples, key = 'ret20') {
  const valid = samples.filter(s => s[key] != null && s[key].matured);
  if (!valid.length) return { n: 0, winRate: null, avgRet: null, medRet: null, avgMax: null };
  const rets = valid.map(s => s[key].ret).sort((a, b) => a - b);
  const wins = rets.filter(r => r > 0).length;
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  const med = rets[Math.floor(rets.length / 2)];
  const avgMax = valid.reduce((a, s) => a + s[key].maxRet, 0) / valid.length;
  return {
    n: valid.length,
    winRate: +(wins / valid.length * 100).toFixed(1),
    avgRet: +avg.toFixed(2),
    medRet: +med.toFixed(2),
    avgMax: +avgMax.toFixed(2),  // 平均衝高能力
  };
}

/**
 * 本地 fallback：讀全部 IndexedDB record，分組算 forward return 對照
 * （Worker 全市場讀不到時用，樣本受限於本地追蹤妖股）
 */
async function _analyzeLocalCohorts(onProgress = null) {
  const records = await getAllYaoguRecords();
  // 篩出有啟動日的妖股記錄（排除純 watching/無啟動）
  const tracked = records.filter(r => r.activatedAt && (r.gen != null));
  if (!tracked.length) {
    return { error: '尚無妖股追蹤記錄（需先有妖股啟動歷史）' };
  }

  const samples = [];
  let done = 0;
  for (const r of tracked) {
    if (onProgress) onProgress(done++, tracked.length);
    let candles = null;
    try {
      const sym = /^\d{4}$/.test(r.code) ? r.code + '.TW' : r.code;
      const res = await fetchHistoryCached(sym, '1y');
      candles = res?.candles ?? res;
    } catch (_) { /* 取不到 K 線跳過 */ }
    if (!candles?.length) continue;

    // 二代妖股用 rebirthAt（二波啟動日）；一代用 activatedAt
    const isGen2 = (r.gen ?? 1) >= 2;
    // 二波啟動日：升級時 activatedAt 已改為 rebirthAt，所以直接用 activatedAt
    const entryTs = r.activatedAt;

    const ret5  = _forwardReturn(candles, entryTs, 5);
    const ret10 = _forwardReturn(candles, entryTs, 10);
    const ret20 = _forwardReturn(candles, entryTs, 20);
    if (!ret5 && !ret10 && !ret20) continue;

    samples.push({
      code: r.code,
      gen: r.gen ?? 1,
      isGen2,
      rebirthType: r.rebirthType ?? null,  // breakout/turnover/squeeze/control
      prevStrength: r.prevStrength ?? r.strength ?? 'none',
      prevPeak: r.prevPeak ?? null,
      status: r.status,
      ret5, ret10, ret20,
    });
  }
  if (onProgress) onProgress(tracked.length, tracked.length);

  const gen1Samples = samples.filter(s => !s.isGen2);
  const gen2Samples = samples.filter(s => s.isGen2);

  // 各週期統計
  const periodStats = (subset) => ({
    d5:  _cohortStats(subset, 'ret5'),
    d10: _cohortStats(subset, 'ret10'),
    d20: _cohortStats(subset, 'ret20'),
  });

  const gen1 = periodStats(gen1Samples);
  const gen2 = periodStats(gen2Samples);

  // 二代各類型（breakout 理論最猛）
  const byType = {};
  ['breakout', 'turnover', 'squeeze', 'control'].forEach(t => {
    byType[t] = periodStats(gen2Samples.filter(s => s.rebirthType === t));
  });

  // 文字結論（誠實標註樣本量與偏差）
  const verdict = _buildVerdict(gen1.d20, gen2.d20, byType);

  return {
    gen1, gen2, byType,
    samples: samples.sort((a, b) => (b.ret20?.ret ?? -999) - (a.ret20?.ret ?? -999)),
    counts: { total: samples.length, gen1: gen1Samples.length, gen2: gen2Samples.length },
    verdict,
  };
}

function _buildVerdict(g1, g2, byType) {
  if (g2.n < 5) {
    return `⚠ 二代妖股樣本僅 ${g2.n} 檔（< 5），統計不可信。目前只能觀察、無法下結論——需累積更多二代案例。`;
  }
  if (g1.n < 5) {
    return `⚠ 一代妖股對照組樣本僅 ${g1.n} 檔，無法可靠對照。`;
  }
  const diff = (g2.winRate ?? 0) - (g1.winRate ?? 0);
  const retDiff = (g2.avgRet ?? 0) - (g1.avgRet ?? 0);
  let core;
  if (diff > 10 && retDiff > 0) {
    core = `📊 二代妖股 20 日勝率 ${g2.winRate}% 顯著高於一代 ${g1.winRate}%（+${diff.toFixed(0)}pp），均報亦較高（${g2.avgRet}% vs ${g1.avgRet}%）。「重生更猛」獲初步數據支持。`;
  } else if (diff < -10) {
    core = `📊 二代妖股 20 日勝率 ${g2.winRate}% 反而低於一代 ${g1.winRate}%。「重生更猛」不成立，可能多為死貓跳。`;
  } else {
    core = `📊 二代 ${g2.winRate}% vs 一代 ${g1.winRate}%，差異不顯著。「重生更猛」目前無數據支持，與一代相當。`;
  }
  // breakout 類型特別點評
  const bo = byType.breakout?.d20;
  if (bo && bo.n >= 3) {
    core += ` 其中「二波猛妖（突破前高）」${bo.n} 檔，勝率 ${bo.winRate}%、均報 ${bo.avgRet}%——這是理論最強的二波型態。`;
  }
  core += ` ⚠ 選擇性存活偏差：能走到二波的本就是活下來的強股，二代數據天生偏高，此對照僅供參考。`;
  return core;
}
