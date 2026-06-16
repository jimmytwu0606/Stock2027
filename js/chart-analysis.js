// js/chart-analysis.js
// ============================================================================
// Phase 7.1 — 智能分析核心(多週期參數自適應版)
// ============================================================================
// 對外 API:
//   analyze(candles, opts) → result
//   PERIOD_PROFILES                  // 各週期參數表(供其他模組用)
//
// opts 新增:
//   period: '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y'
//     不傳 → 自動選 '3mo'(中性參數)
//     傳了 → 套用對應的 swing k、tolerance、box lookback、MA 組合等
//
// candle 格式: { time, open, high, low, close, volume }
// ============================================================================

import { calcMA, calcEMA, calcRSI, calcKD, calcDMI, calcHV, calcBias, calcPSY, calcRCI, calcSAR, calcWeeklyTrend, calcWeinsteinStage, calcVolumeProfile, calcTTMSqueeze, calcSupertrend, calcOBV } from './indicators.js';

// ============================================================================
// 多週期參數表(B6 核心)
// ============================================================================
export const PERIOD_PROFILES = {
  '5d': {
    lookback:     null,       // 全部
    tolerance:    0.005,
    swingK:       3,
    maPeriods:    [5, 10],
    boxLookback:  null,       // null = 不做箱型
    profileBins:  12,
    minCandles:   5,          // ⚠ Phase 7.4 — 5d 只要 5 根就跑
    focus:        '當沖、短線即時關鍵價',
  },
  '1mo': {
    lookback:     null,
    tolerance:    0.008,
    swingK:       3,
    maPeriods:    [5, 10, 20],
    boxLookback:  20,
    profileBins:  18,
    minCandles:   10,
    focus:        '短線波段、近期高低',
  },
  '3mo': {
    lookback:     null,
    tolerance:    0.012,
    swingK:       5,
    maPeriods:    [10, 20, 60],
    boxLookback:  40,
    profileBins:  24,
    minCandles:   20,
    focus:        '主要支撐壓力、中線波段',
  },
  '6mo': {
    lookback:     120,
    tolerance:    0.015,
    swingK:       7,
    maPeriods:    [20, 60],
    boxLookback:  60,
    profileBins:  28,
    minCandles:   20,
    focus:        '大箱型、波段位置',
  },
  '1y': {
    lookback:     null,
    tolerance:    0.018,
    swingK:       8,
    maPeriods:    [20, 60, 120],
    boxLookback:  80,
    profileBins:  32,
    minCandles:   20,
    focus:        '趨勢結構、年高低',
  },
  '2y': {
    lookback:     null,
    tolerance:    0.025,
    swingK:       10,
    maPeriods:    [60, 120, 240],
    boxLookback:  100,
    profileBins:  36,
    minCandles:   20,
    focus:        '歷史百分位、估值區間',
  },
};

function _profile(opts) {
  const p = opts.period && PERIOD_PROFILES[opts.period];
  return p || PERIOD_PROFILES['3mo'];
}

// ============================================================================
// 主入口
// ============================================================================
export function analyze(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return _emptyResult('資料不足(無 K 棒)');
  }
  const profile = _profile(opts);
  // Phase 7.4:依週期動態門檻(5d=5、1mo=10、其他=20)
  const minCandles = profile.minCandles ?? 20;
  if (candles.length < minCandles) {
    return _emptyResult(`資料不足(至少需要 ${minCandles} 根 K 棒,實際 ${candles.length} 根)`);
  }
  const mergedOpts = { ...opts, profile };

  const result = {
    candleCount: candles.length,
    lastClose:   candles[candles.length - 1].close,
    period:      opts.period || '3mo',
    profile,
    asOf:        Date.now(),
    support:     null,
    resistance:  null,
    box:         null,
    trend:       null,
    volumePrice: null,
    errors:      [],
  };

  try { result.support     = analyzeSupport(candles, mergedOpts); }
  catch (e) { result.errors.push('support: ' + e.message); }

  try { result.resistance  = analyzeResistance(candles, mergedOpts); }
  catch (e) { result.errors.push('resistance: ' + e.message); }

  try { result.box         = analyzeBox(candles, mergedOpts); }
  catch (e) { result.errors.push('box: ' + e.message); }

  try { result.trend       = analyzeTrend(candles, mergedOpts); }
  catch (e) { result.errors.push('trend: ' + e.message); }

  try { result.volumePrice = analyzeVolumePrice(candles, mergedOpts); }
  catch (e) { result.errors.push('volumePrice: ' + e.message); }

  // B4 — 給每個區段加上「怎麼操作」建議
  try {
    if (result.support || result.resistance) {
      result.srAdvice    = _buildSRAdvice(result.support, result.resistance, result.lastClose);
    }
    if (result.box)         result.box.advice         = _buildBoxAdvice(result.box);
    if (result.trend)       result.trend.advice       = _buildTrendAdvice(result.trend);
    if (result.volumePrice) result.volumePrice.advice = _buildVolPriceAdvice(result.volumePrice);
  } catch (e) {
    result.errors.push('advice: ' + e.message);
  }

  return result;
}

function _emptyResult(reason) {
  return {
    candleCount: 0, empty: true, reason,
    support: null, resistance: null, box: null, trend: null, volumePrice: null,
  };
}

// ===========================================================================
// 1. 支撐 / 壓力
// ===========================================================================
export function analyzeSupport(candles, opts = {}) {
  const lastClose = candles[candles.length - 1].close;
  const levels = _collectLevels(candles, opts);
  const supports = levels
    .filter(L => L.price < lastClose)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  const tolerance = (opts.profile || PERIOD_PROFILES['3mo']).tolerance;

  return {
    items: supports.map(L => {
      // B3: 歷史驗證
      const history = _validateLevelHistory(L.price, candles, tolerance, false);
      const histDesc = _describeHistory(history, candles, false);
      const reasons = [...L.reasons];
      if (histDesc) reasons.push(histDesc);
      return {
        price:    +L.price.toFixed(2),
        strength: L.strength,
        sources:  L.sources,
        reasons,
        history,
        distance: +((lastClose - L.price) / lastClose * 100).toFixed(2),
      };
    }),
    lastClose,
  };
}

export function analyzeResistance(candles, opts = {}) {
  const lastClose = candles[candles.length - 1].close;
  const levels = _collectLevels(candles, opts);
  const resists = levels
    .filter(L => L.price > lastClose)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  const tolerance = (opts.profile || PERIOD_PROFILES['3mo']).tolerance;

  return {
    items: resists.map(L => {
      const history = _validateLevelHistory(L.price, candles, tolerance, true);
      const histDesc = _describeHistory(history, candles, true);
      const reasons = [...L.reasons];
      if (histDesc) reasons.push(histDesc);
      return {
        price:    +L.price.toFixed(2),
        strength: L.strength,
        sources:  L.sources,
        reasons,
        history,
        distance: +((L.price - lastClose) / lastClose * 100).toFixed(2),
      };
    }),
    lastClose,
  };
}

function _collectLevels(candles, opts) {
  const profile = opts.profile || PERIOD_PROFILES['3mo'];
  const lookback = profile.lookback || candles.length;
  const recent = candles.slice(-Math.min(candles.length, lookback));
  const lastClose = candles[candles.length - 1].close;
  const todayTime = candles[candles.length - 1].time;

  const all = [];
  all.push(..._findSwingPivots(recent, profile.swingK, { todayTime }));
  all.push(..._volumeProfile(recent, profile.profileBins));
  all.push(..._roundNumbers(lastClose, recent));
  all.push(..._maLevels(candles, profile.maPeriods));

  const tolerance = profile.tolerance;
  const clusters = _clusterLevels(all, tolerance);

  return clusters.map(c => {
    const sources = Array.from(new Set(c.sources));
    const weight = c.items.reduce((s, x) => s + (x.weight || 1), 0);
    const srcScore = Math.min(sources.length / 4, 1);
    const wScore   = Math.min(weight / 8, 1);
    const strength = Math.max(1, Math.round((srcScore * 0.6 + wScore * 0.4) * 5));
    const reasons  = c.items.map(x => x.reason).filter(Boolean);
    return { price: c.price, strength, sources, reasons };
  });
}

function _findSwingPivots(candles, k, opts = {}) {
  const out = [];
  const N = candles.length;
  k = k || Math.max(3, Math.floor(N / 30));
  const todayTime = opts.todayTime ?? candles[N - 1]?.time;
  // 算近期均量供 K 棒特徵判斷
  const vols = candles.map(c => c.volume || 0);
  const avgVol = vols.length >= 20 ? _avg(vols.slice(-20)) : _avg(vols);

  for (let i = k; i < N - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low  >= candles[i - j].low  || candles[i].low  >= candles[i + j].low)  isLow  = false;
    }
    if (isHigh) {
      const desc = _describeBar(candles[i], avgVol);
      const ago  = _timeAgo(candles[i].time, todayTime);
      const meaning = _barMarketMeaning(desc, true);
      const timePart = ago ? `${ago}` : `第 ${i + 1} 根 K 棒`;
      out.push({
        price: candles[i].high,
        source: '波段高點',
        weight: 1.5,
        // B1: 自然語言 — 「3 週前(8/15)那根長黑帶量,當天賣壓沉重,從此成為壓力」
        reason: `${timePart}那根${desc}(${candles[i].high.toFixed(2)}),${meaning}`,
      });
    }
    if (isLow) {
      const desc = _describeBar(candles[i], avgVol);
      const ago  = _timeAgo(candles[i].time, todayTime);
      const meaning = _barMarketMeaning(desc, false);
      const timePart = ago ? `${ago}` : `第 ${i + 1} 根 K 棒`;
      out.push({
        price: candles[i].low,
        source: '波段低點',
        weight: 1.5,
        reason: `${timePart}那根${desc}(${candles[i].low.toFixed(2)}),${meaning}`,
      });
    }
  }
  return out;
}

function _volumeProfile(candles, bins) {
  if (!candles.length) return [];
  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume || 0);
  const lo = Math.min(...closes), hi = Math.max(...closes);
  if (hi <= lo) return [];
  bins = bins || 24;
  const step = (hi - lo) / bins;
  const buckets = new Array(bins).fill(0);
  for (let i = 0; i < closes.length; i++) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((closes[i] - lo) / step)));
    buckets[idx] += vols[i];
  }
  const ranked = buckets
    .map((v, i) => ({ v, mid: lo + step * (i + 0.5) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  const maxV = ranked[0]?.v || 1;
  return ranked.map(r => ({
    price: r.mid,
    source: '密集成交區',
    weight: 1.2 + (r.v / maxV),
    reason: `${r.mid.toFixed(2)} 附近成交密集,籌碼沉澱在這裡`,
  }));
}

function _roundNumbers(lastClose, candles) {
  const lo = Math.min(...candles.map(c => c.low));
  const hi = Math.max(...candles.map(c => c.high));
  const step = lastClose < 50 ? 1 :
               lastClose < 100 ? 5 :
               lastClose < 500 ? 10 :
               lastClose < 1000 ? 50 : 100;
  const out = [];
  const start = Math.ceil(lo / step) * step;
  for (let p = start; p <= hi; p += step) {
    out.push({
      price: p,
      source: '整數價位',
      weight: 0.6,
      reason: `${p} 是整數心理關卡,散戶常掛單在這`,
    });
  }
  return out;
}

function _maLevels(candles, periods) {
  const closes = candles.map(c => c.close);
  const out = [];
  // B6: 用 profile 指定的 MA 組合
  const targets = periods || [20, 60, 120, 240];
  for (const period of targets) {
    if (closes.length < period) continue;
    try {
      const ma = calcMA(closes, period);
      const v = ma[ma.length - 1];
      if (v != null && Number.isFinite(v)) {
        out.push({
          price: v,
          source: `MA${period}`,
          weight: 1.0,
          reason: `MA${period} ($${v.toFixed(2)}) 是常見的均線支撐/壓力`,
        });
      }
    } catch {}
  }
  return out;
}

function _clusterLevels(items, tolerance) {
  if (!items.length) return [];
  const sorted = items.slice().sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = { items: [sorted[0]], sources: [sorted[0].source] };
  for (let i = 1; i < sorted.length; i++) {
    const last = cur.items[cur.items.length - 1];
    if (Math.abs(sorted[i].price - last.price) / last.price <= tolerance) {
      cur.items.push(sorted[i]);
      cur.sources.push(sorted[i].source);
    } else {
      cur.price = _weightedMean(cur.items);
      clusters.push(cur);
      cur = { items: [sorted[i]], sources: [sorted[i].source] };
    }
  }
  cur.price = _weightedMean(cur.items);
  clusters.push(cur);
  return clusters;
}

function _weightedMean(items) {
  let sumW = 0, sum = 0;
  for (const it of items) {
    const w = it.weight || 1;
    sum += it.price * w; sumW += w;
  }
  return sum / sumW;
}

// ===========================================================================
// 2. 箱型操作
// ===========================================================================
export function analyzeBox(candles, opts = {}) {
  const profile = opts.profile || PERIOD_PROFILES['3mo'];

  // B6: 5d 不做箱型
  if (profile.boxLookback == null) {
    return { isBox: false, skipped: true, reason: '此週期不適合箱型分析' };
  }

  const N = Math.min(candles.length, profile.boxLookback);
  const recent = candles.slice(-N);
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  const upper = Math.max(...highs);
  const lower = Math.min(...lows);
  const lastClose = candles[candles.length - 1].close;
  const range = upper - lower;

  const atr = _calcATR(candles, 14);
  const wideRatio = atr > 0 ? range / atr : 0;
  const inBox = wideRatio > 0 && wideRatio < 8;

  const entryLong  = lower + range * 0.15;
  const target     = upper;
  const stop       = lower - atr * 0.5;
  const rr = (entryLong - stop) !== 0 ? (target - entryLong) / (entryLong - stop) : 0;

  const distToUpper = range > 0 ? (upper - lastClose) / range : 0;
  const distToLower = range > 0 ? (lastClose - lower) / range : 0;

  return {
    isBox: inBox,
    upper: +upper.toFixed(2),
    lower: +lower.toFixed(2),
    range: +range.toFixed(2),
    rangePct: +((range / lastClose) * 100).toFixed(2),
    lookback: N,
    suggestion: {
      entry: +entryLong.toFixed(2),
      target: +target.toFixed(2),
      stop:  +stop.toFixed(2),
      riskReward: +rr.toFixed(2),
    },
    position: distToUpper < 0.2 ? 'near_upper' :
              distToLower < 0.2 ? 'near_lower' : 'middle',
    reasons: [
      `近 ${N} 根 K 棒區間 ${lower.toFixed(2)} ~ ${upper.toFixed(2)}`,
      `區間幅度 ${((range / lastClose) * 100).toFixed(1)}%,ATR=${atr.toFixed(2)}`,
      inBox ? '波動相對收斂,符合箱型整理' : '波動較大,非典型箱型',
      distToUpper < 0.2 ? '目前接近上緣,留意假突破' :
        distToLower < 0.2 ? '目前接近下緣,留意假跌破' :
        '目前位於箱型中段',
    ],
  };
}

function _calcATR(candles, period) {
  const N = candles.length;
  if (N < period + 1) return 0;
  let sum = 0;
  for (let i = N - period; i < N; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low  - p.close),
    );
    sum += tr;
  }
  return sum / period;
}

// ===========================================================================
// 3. 趨勢結構(用 profile.maPeriods)
// ===========================================================================
export function analyzeTrend(candles, opts = {}) {
  const profile = opts.profile || PERIOD_PROFILES['3mo'];
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const N = closes.length;
  const lastClose = closes[N - 1];

  const sub = {};
  let score = 0, maxScore = 0;

  // (1) MA 多頭排列 — 用 profile 的 MA 組合(取前三條)
  try {
    const periods = profile.maPeriods.slice(0, 3);
    const mas = periods.map(p => calcMA(closes, p)[N - 1]).filter(v => v != null);
    if (mas.length >= 2) {
      let allUp = true, allDown = true;
      for (let i = 0; i < mas.length - 1; i++) {
        if (mas[i] <= mas[i + 1]) allUp = false;
        if (mas[i] >= mas[i + 1]) allDown = false;
      }
      const valueStr = periods.map((p, i) => `MA${p}=${mas[i]?.toFixed(2)}`).join(' ');
      sub.maAlignment = {
        label: 'MA 排列',
        value: allUp ? '多頭排列' : allDown ? '空頭排列' : '糾結',
        score: allUp ? 1 : allDown ? -1 : 0,
        reason: valueStr,
      };
      score += sub.maAlignment.score * 2; maxScore += 2;
    }
  } catch { sub.maAlignment = null; }

  // (2) MA 斜率(用 profile 的第一條 MA)
  try {
    const period = profile.maPeriods[1] || profile.maPeriods[0] || 20;
    const ma = calcMA(closes, period);
    if (ma[N - 6] && ma[N - 1]) {
      const slope = (ma[N - 1] - ma[N - 6]) / ma[N - 6];
      sub.maSlope = {
        label: `MA${period} 斜率`,
        value: (slope * 100).toFixed(2) + '%',
        score: slope > 0.01 ? 1 : slope < -0.01 ? -1 : 0,
        reason: slope > 0.01 ? '均線向上,趨勢加速' :
                slope < -0.01 ? '均線向下,趨勢轉弱' : '均線走平',
      };
      score += sub.maSlope.score; maxScore += 1;
    }
  } catch { sub.maSlope = null; }

  // (3) HH/HL 波段結構
  try {
    const seg = candles.slice(-Math.min(N, 30));
    const todayTime = candles[N - 1]?.time;
    const pivots = _findSwingPivots(seg, profile.swingK, { todayTime });
    const ph = pivots.filter(p => p.source === '波段高點').slice(-2);
    const pl = pivots.filter(p => p.source === '波段低點').slice(-2);
    const hh = ph.length === 2 && ph[1].price > ph[0].price;
    const hl = pl.length === 2 && pl[1].price > pl[0].price;
    const lh = ph.length === 2 && ph[1].price < ph[0].price;
    const ll = pl.length === 2 && pl[1].price < pl[0].price;
    const value = (hh && hl) ? 'HH+HL(多頭結構)' :
                  (lh && ll) ? 'LH+LL(空頭結構)' :
                  '結構不明';
    sub.hhhl = {
      label: '波段結構',
      value,
      score: (hh && hl) ? 1 : (lh && ll) ? -1 : 0,
      reason: '檢查最近兩個波段高低點是否依序墊高或墊低',
    };
    score += sub.hhhl.score * 1.5; maxScore += 1.5;
  } catch { sub.hhhl = null; }

  // (4) ADX
  try {
    const adx = _calcADX(candles, 14);
    sub.adx = {
      label: '趨勢強度(ADX)',
      value: adx.adx.toFixed(1),
      score: adx.adx > 25 ? (adx.diPlus > adx.diMinus ? 1 : -1) :
             adx.adx > 20 ? 0 : -0.3,
      reason: adx.adx > 25 ? `ADX=${adx.adx.toFixed(1)} 趨勢明確` :
              adx.adx > 20 ? 'ADX 中等,趨勢溫和' :
                            'ADX 偏低,盤整為主',
    };
    score += sub.adx.score; maxScore += 1;
  } catch { sub.adx = null; }

  // (5) 價格 vs 長期均線(用 profile 最後一條)
  try {
    const period = profile.maPeriods[profile.maPeriods.length - 1];
    if (N >= period) {
      const ma = calcMA(closes, period);
      const v = ma[N - 1];
      if (v != null && Number.isFinite(v)) {
        const aboveMA = lastClose > v;
        const diff = ((lastClose - v) / v * 100);
        sub.longTermPos = {
          label: `價格 vs MA${period}`,
          value: aboveMA ? `+${diff.toFixed(1)}%(多方)` : `${diff.toFixed(1)}%(空方)`,
          score: aboveMA ? 1 : -1,
          reason: aboveMA ? '股價站上長期均線' : '股價跌破長期均線',
        };
        score += sub.longTermPos.score * 1.5; maxScore += 1.5;
      }
    }
  } catch { sub.longTermPos = null; }

  // (6) 突破/回測
  try {
    if (N >= 25) {
      const high20 = Math.max(...highs.slice(-25, -5));
      const recentHigh = Math.max(...highs.slice(-5));
      const recentLow  = Math.min(...lows.slice(-5));
      const breakout = recentHigh > high20 * 1.01;
      const retest   = recentLow >= high20 * 0.985 && recentLow <= high20 * 1.015;
      sub.breakout = {
        label: '突破/回測',
        value: breakout && retest ? '突破後回測(理想)' :
               breakout ? '近期突破前高' : '尚未突破',
        score: breakout && retest ? 1 : breakout ? 0.5 : 0,
        reason: `20 日內高點 ${high20.toFixed(2)},近 5 日最高 ${recentHigh.toFixed(2)}`,
      };
      score += sub.breakout.score; maxScore += 1;
    }
  } catch { sub.breakout = null; }

  // (7) 近 5 日紅黑 K
  try {
    let upDays = 0, downDays = 0;
    for (let i = N - 1; i >= Math.max(0, N - 5); i--) {
      if (candles[i].close > candles[i].open) upDays++;
      else if (candles[i].close < candles[i].open) downDays++;
    }
    sub.recentBars = {
      label: '近 5 日 K 棒',
      value: `紅 ${upDays} / 黑 ${downDays}`,
      score: upDays >= 4 ? 0.5 : downDays >= 4 ? -0.5 : 0,
      reason: '連續紅 K 動能強,連續黑 K 動能弱',
    };
    score += sub.recentBars.score; maxScore += 0.5;
  } catch { sub.recentBars = null; }

  // (8) 歷史百分位(B6 — 長週期才有意義)
  if (opts.period === '1y' || opts.period === '2y') {
    try {
      const sorted = [...closes].sort((a, b) => a - b);
      const idx = sorted.findIndex(v => v >= lastClose);
      const percentile = Math.round((idx / sorted.length) * 100);
      sub.historicalRank = {
        label: '歷史百分位',
        value: `第 ${percentile} 百分位`,
        score: 0,  // 不算分數,純資訊
        reason: percentile > 80 ? '相對高檔,留意修正風險' :
                percentile < 20 ? '相對低檔,可能價值區' :
                '中段位置',
      };
    } catch { sub.historicalRank = null; }
  }

  // ── Advanced 5 新增子指標 ──────────────────────────

  // (A5) PSY 心理線 — 市場情緒
  try {
    if (N >= 13) {
      const psyArr = calcPSY(closes, 12);
      const psyVal = psyArr[N - 1];
      if (psyVal != null) {
        const psyLabel = psyVal < 25 ? '極度悲觀（超賣）' :
                         psyVal < 40 ? '偏悲觀' :
                         psyVal > 75 ? '極度樂觀（超買）' :
                         psyVal > 60 ? '偏樂觀' : '中性';
        sub.psy = {
          label: 'PSY 心理線(12)',
          value: `${psyVal.toFixed(1)}  ${psyLabel}`,
          score: psyVal < 25 ? 0.5 : psyVal > 75 ? -0.5 : 0,
          reason: psyVal < 25
            ? `12日內只有 ${(psyVal / 100 * 12).toFixed(0)} 天上漲，市場極度悲觀，反彈機率上升`
            : psyVal > 75
            ? `12日內有 ${(psyVal / 100 * 12).toFixed(0)} 天上漲，市場過度樂觀，短線注意回調`
            : '市場情緒中性',
        };
        score += sub.psy.score; maxScore += 0.5;
      }
    }
  } catch { sub.psy = null; }

  // (A6) RCI 順位相關係數
  try {
    if (N >= 9) {
      const rciArr = calcRCI(closes, 9);
      const rciVal = rciArr[N - 1];
      const rciPrev = rciArr[N - 2];
      if (rciVal != null) {
        const rciDir = rciPrev != null ? (rciVal > rciPrev ? '↑' : rciVal < rciPrev ? '↓' : '→') : '';
        const rciLabel = rciVal > 80 ? '極強多頭' : rciVal < -80 ? '極強空頭' :
                         rciVal > 50 ? '偏多' : rciVal < -50 ? '偏空' : '中性';
        sub.rci = {
          label: 'RCI(9)',
          value: `${rciVal.toFixed(1)} ${rciDir}  ${rciLabel}`,
          score: rciVal > 80 ? 0.5 : rciVal < -80 ? -0.5 :
                 rciVal > 50 ? 0.3 : rciVal < -50 ? -0.3 : 0,
          reason: rciVal > 80
            ? '時間與價格高度正相關，趨勢強勁，但注意極值後翻轉'
            : rciVal < -80
            ? '時間與價格高度負相關，跌勢明確，等待 RCI 翻轉'
            : `RCI ${rciVal.toFixed(1)}，趨勢方向${rciDir === '↑' ? '轉強' : rciDir === '↓' ? '轉弱' : '持平'}`,
        };
        score += sub.rci.score; maxScore += 0.5;
      }
    }
  } catch { sub.rci = null; }

  // (A4) 乖離率
  try {
    if (N >= 20) {
      const biasArr = calcBias(closes, 20);
      const biasVal = biasArr[N - 1];
      if (biasVal != null) {
        const biasLabel = biasVal > 15 ? '嚴重超漲' : biasVal > 8 ? '偏高' :
                          biasVal < -15 ? '嚴重超跌' : biasVal < -8 ? '偏低' : '正常';
        sub.bias = {
          label: 'MA20 乖離率',
          value: `${biasVal >= 0 ? '+' : ''}${biasVal.toFixed(2)}%  ${biasLabel}`,
          score: biasVal > 15 ? -1 : biasVal > 8 ? -0.5 :
                 biasVal < -15 ? 0.5 : biasVal < -8 ? 0.3 : 0,
          reason: biasVal > 15
            ? `股價大幅偏離均線 +${biasVal.toFixed(1)}%，短線追高風險極高，等回踩`
            : biasVal > 8
            ? `偏離均線 +${biasVal.toFixed(1)}%，偏貴，留意獲利了結`
            : biasVal < -15
            ? `股價大幅低於均線 ${biasVal.toFixed(1)}%，嚴重超跌，反彈動能強`
            : biasVal < -8
            ? `偏離均線 ${biasVal.toFixed(1)}%，超跌區，可逢低布局`
            : `乖離率 ${biasVal.toFixed(1)}%，在正常範圍內`,
        };
        score += sub.bias.score; maxScore += 1;
      }
    }
  } catch { sub.bias = null; }

  // (A9) HV 歷史波動率
  try {
    if (N >= 21) {
      const hvArr = calcHV(closes, 20);
      const hvVal = hvArr[N - 1];
      if (hvVal != null) {
        const hvLabel = hvVal < 15 ? '超低波動' : hvVal < 25 ? '低波動' :
                        hvVal < 40 ? '正常' : hvVal < 60 ? '高波動' : '極高波動';
        sub.hv = {
          label: 'HV 歷史波動率(20日)',
          value: `${hvVal.toFixed(1)}%  ${hvLabel}`,
          score: hvVal < 15 ? 0.5 : hvVal > 60 ? -0.5 : 0,
          reason: hvVal < 15
            ? `年化波動率僅 ${hvVal.toFixed(1)}%，超低波動潛伏，等待量能引爆`
            : hvVal > 60
            ? `年化波動率高達 ${hvVal.toFixed(1)}%，行情已啟動，追高需謹慎`
            : `波動率 ${hvVal.toFixed(1)}%，屬${hvLabel}範圍`,
        };
        score += sub.hv.score; maxScore += 0.5;
      }
    }
  } catch { sub.hv = null; }

  // (A8) SAR 拋物線方向
  try {
    if (N >= 32) {
      const sarArr = calcSAR(candles);
      const sarVal = sarArr[N - 1];
      const sarPrev = sarArr[N - 2];
      if (sarVal != null) {
        const sarBull = sarVal < lastClose;
        const justTurned = sarPrev != null && ((sarBull && sarPrev > candles[N-2].close) || (!sarBull && sarPrev < candles[N-2].close));
        sub.sar = {
          label: 'SAR 拋物線',
          value: sarBull
            ? `${sarVal.toFixed(2)}（多頭${justTurned ? '，剛翻多🔄' : ''}）`
            : `${sarVal.toFixed(2)}（空頭${justTurned ? '，剛翻空🔄' : ''}）`,
          score: sarBull ? 0.5 : -0.5,
          reason: sarBull
            ? `SAR ${sarVal.toFixed(2)} 在股價下方，多頭趨勢中，可持有`
            : `SAR ${sarVal.toFixed(2)} 在股價上方，空頭趨勢中，謹慎操作`,
        };
        score += sub.sar.score; maxScore += 0.5;
      }
    }
  } catch { sub.sar = null; }

  // ── T-3 週線共振 + T-5 Weinstein 階段（用 2 年日K，window.__taDaily，不靠當前週期）──
  try {
    const taC = (typeof window !== 'undefined' && window.__taDaily?.candles?.length)
      ? window.__taDaily.candles : null;
    if (taC) {
      // T-3 週線共振
      if (taC.length >= 70) {
        const w = calcWeeklyTrend(taC);
        if (w.ready && (w.bull || w.bear)) {
          sub.weeklyMTF = {
            label: '週線共振',
            value: w.bull ? '週多頭 ↗' : '週空頭 ↘',
            score: w.bull ? 1 : -1,
            reason: w.bull
              ? `週收 > 週MA10(${w.ma10.toFixed(2)}) 且月線連2週上揚——大趨勢多頭，順大勢操作`
              : `週收 < 週MA10(${w.ma10.toFixed(2)}) 且月線連2週下彎——大趨勢空頭，反彈宜減碼`,
          };
          score += sub.weeklyMTF.score * 1.5; maxScore += 1.5;
        }
      }
      // T-5 Weinstein 階段
      if (taC.length >= 160) {
        const st = calcWeinsteinStage(taC);
        const STM = {
          1: { t: '第1階段 底部整理', s: 0,    r: '價繞週MA30橫盤、月線走平，築底中——觀察等待，待放量突破進 Stage 2' },
          2: { t: '第2階段 上升期',   s: 1,    r: '價站上週MA30、月線上揚，主升段——唯一該買的階段，回檔月線是加碼點' },
          3: { t: '第3階段 頭部整理', s: -0.5, r: '價繞週MA30橫盤於高檔、月線走平，派發中——逢高減碼，跌破月線離場' },
          4: { t: '第4階段 下降期',   s: -1,   r: '價跌破週MA30、月線下彎，主跌段——避開做多，接刀必傷' },
        };
        const meta = st.ready ? STM[st.stage] : null;
        if (meta) {
          sub.weinstein = { label: 'Weinstein 階段', value: meta.t, score: meta.s, reason: meta.r };
          score += sub.weinstein.score * 1.5; maxScore += 1.5;
        }
      }
      // T-4 Volume Profile — POC 位置
      if (taC.length >= 30) {
        const vp = calcVolumeProfile(taC, 120);
        if (vp.ready) {
          const above = lastClose > vp.poc;
          const distPct = (lastClose - vp.poc) / vp.poc * 100;
          sub.volumeProfile = {
            label: '量價分佈 POC',
            value: `${vp.poc.toFixed(2)}（現價${above ? '上方' : '下方'} ${distPct >= 0 ? '+' : ''}${distPct.toFixed(1)}%）`,
            score: above ? 0.5 : -0.5,
            reason: above
              ? `站在量最密集價位 POC ${vp.poc.toFixed(2)} 之上，上方套牢盤少、籌碼乾淨；VA [${vp.val.toFixed(2)}~${vp.vah.toFixed(2)}]`
              : `位於 POC ${vp.poc.toFixed(2)} 下方，上方有密集套牢盤，反彈遇阻；VA [${vp.val.toFixed(2)}~${vp.vah.toFixed(2)}]`,
          };
          score += sub.volumeProfile.score; maxScore += 0.5;
        }
      }
      // T-6 TTM Squeeze — 能量壓縮/釋放 + 動能方向
      if (taC.length >= 25) {
        const ttm = calcTTMSqueeze(taC);
        if (ttm.ready) {
          sub.ttm = {
            label: 'TTM Squeeze',
            value: ttm.squeezeOn ? `壓縮中（連 ${ttm.squeezeStreak} 根）`
                 : ttm.fired ? `剛釋放 ${ttm.momentumUp ? '↑偏多' : '↓偏空'}`
                 : `已釋放（動能${ttm.momentumUp ? '↑' : '↓'}）`,
            score: ttm.fired ? (ttm.momentumUp ? 1 : -1) : ttm.squeezeOn ? 0 : (ttm.momentumUp ? 0.3 : -0.3),
            reason: ttm.squeezeOn
              ? `布林帶縮進 Keltner，能量壓縮蓄勢（連 ${ttm.squeezeStreak} 根），釋放方向待確認`
              : ttm.fired
              ? `壓縮剛釋放，動能${ttm.momentumUp ? '向上 → 偏多突破' : '向下 → 偏空破位'}`
              : `動能${ttm.momentumUp ? '向上延續' : '向下延續'}`,
          };
          score += sub.ttm.score; maxScore += 1;
        }
      }
      // T-7 Supertrend — ATR 通道趨勢/移動停損
      if (taC.length >= 15) {
        const stp = calcSupertrend(taC);
        if (stp.ready) {
          const up = stp.dir === 'up';
          sub.supertrend = {
            label: 'Supertrend(10,3)',
            value: `${up ? '多頭' : '空頭'} 線 ${stp.line.toFixed(2)}${stp.flipped ? (up ? ' 剛翻多🔄' : ' 剛翻空🔄') : ''}`,
            score: up ? 0.5 : -0.5,
            reason: up
              ? `Supertrend 在股價下方(${stp.line.toFixed(2)})，趨勢偏多，可當移動停損`
              : `Supertrend 在股價上方(${stp.line.toFixed(2)})，趨勢偏空，反彈遇壓`,
          };
          score += sub.supertrend.score; maxScore += 0.5;
        }
      }
      // T-8 OBV 能量潮 — 量價背離
      if (taC.length >= 25) {
        const obv = calcOBV(taC);
        if (obv.ready) {
          sub.obv = {
            label: 'OBV 能量潮',
            value: obv.bullDiv ? '🔴 牛背離（價低量不低）' : obv.bearDiv ? '🟢 熊背離（價高量不高）'
                 : (obv.slopeUp ? '量能流入 ↑' : '量能流出 ↓'),
            score: obv.bullDiv ? 1 : obv.bearDiv ? -1 : obv.slopeUp ? 0.3 : -0.3,
            reason: obv.bullDiv
              ? '價創近低但 OBV 未破低，賣壓萎縮、量價背離，反彈醞釀'
              : obv.bearDiv
              ? '價創近高但 OBV 未創高，買盤縮手、量價背離，留意回落'
              : obv.slopeUp ? 'OBV 上行，量能持續流入支撐價格' : 'OBV 下行，量能流出，價格支撐轉弱',
          };
          score += sub.obv.score; maxScore += 1;
        }
      }
    }
  } catch { sub.weeklyMTF = sub.weeklyMTF || null; sub.weinstein = sub.weinstein || null; }

  const normalized = maxScore > 0 ? (score / maxScore) : 0;
  const health = Math.round((normalized + 1) / 2 * 100);
  const direction = normalized > 0.3 ? 'up' :
                    normalized < -0.3 ? 'down' : 'flat';

  return {
    health,
    direction,
    score: +score.toFixed(2),
    maxScore: +maxScore.toFixed(2),
    indicators: sub,
    summary: direction === 'up' ? `趨勢偏多(健康度 ${health})` :
             direction === 'down' ? `趨勢偏空(健康度 ${health})` :
             `趨勢盤整(健康度 ${health})`,
  };
}

function _calcADX(candles, period = 14) {
  const N = candles.length;
  if (N < period * 2) return { adx: 0, diPlus: 0, diMinus: 0 };
  const tr = [], dmPlus = [], dmMinus = [];
  for (let i = 1; i < N; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const dn = p.low - c.low;
    dmPlus.push((up > dn && up > 0) ? up : 0);
    dmMinus.push((dn > up && dn > 0) ? dn : 0);
  }
  const smooth = (arr, p) => {
    let s = 0;
    for (let i = 0; i < p; i++) s += arr[i];
    const out = [s];
    for (let i = p; i < arr.length; i++) {
      s = s - s / p + arr[i];
      out.push(s);
    }
    return out;
  };
  const trS = smooth(tr, period);
  const dpS = smooth(dmPlus, period);
  const dmS = smooth(dmMinus, period);
  const lastIdx = trS.length - 1;
  if (lastIdx < 0 || trS[lastIdx] === 0) return { adx: 0, diPlus: 0, diMinus: 0 };
  const diPlus  = 100 * dpS[lastIdx] / trS[lastIdx];
  const diMinus = 100 * dmS[lastIdx] / trS[lastIdx];
  let dxSum = 100 * Math.abs(diPlus - diMinus) / (diPlus + diMinus || 1);
  for (let i = 1; i < Math.min(period, trS.length); i++) {
    const idx = lastIdx - i;
    if (idx < 0 || trS[idx] === 0) break;
    const dpi = 100 * dpS[idx] / trS[idx];
    const dmi = 100 * dmS[idx] / trS[idx];
    dxSum += 100 * Math.abs(dpi - dmi) / (dpi + dmi || 1);
  }
  const adx = dxSum / Math.min(period, trS.length);
  return { adx, diPlus, diMinus };
}

// ===========================================================================
// 4. 量價分析
// ===========================================================================
export function analyzeVolumePrice(candles, opts = {}) {
  const N = candles.length;
  if (N < 25) return { empty: true, reason: '量價分析需要至少 25 根 K 棒' };

  const vols = candles.map(c => c.volume || 0);
  const last = candles[N - 1];
  const prev = candles[N - 2];

  const avgVol20 = _avg(vols.slice(-21, -1));
  const volRatio = avgVol20 ? last.volume / avgVol20 : 1;

  const priceUp   = last.close > prev.close;
  const priceDown = last.close < prev.close;
  const volUp     = volRatio > 1.3;
  const volDown   = volRatio < 0.7;
  const volFlat   = !volUp && !volDown;

  let pattern = '量價平淡';
  let signal = 'neutral';
  let reason = '';

  if (priceUp && volUp) {
    pattern = '價漲量增'; signal = 'bullish';
    reason = '價量齊揚,買盤積極(健康多方)';
  } else if (priceUp && volFlat) {
    pattern = '價漲量平'; signal = 'neutral';
    reason = '股價上漲但量能未配合,動能存疑';
  } else if (priceUp && volDown) {
    pattern = '價漲量縮'; signal = 'warning';
    reason = '價漲量縮,警惕背離,動能不足';
  } else if (priceDown && volUp) {
    pattern = '價跌量增'; signal = 'bearish';
    reason = '價跌量增,賣壓沉重,留意止跌訊號';
  } else if (priceDown && volFlat) {
    pattern = '價跌量平'; signal = 'neutral';
    reason = '股價下跌但量能持平,觀望氣氛濃';
  } else if (priceDown && volDown) {
    pattern = '價跌量縮'; signal = 'mild-bullish';
    reason = '價跌量縮,跌勢趨緩,可能築底';
  } else if (!priceUp && !priceDown && volUp) {
    pattern = '價平量增'; signal = 'warning';
    reason = '價平量增,籌碼換手中,留意方向';
  } else if (!priceUp && !priceDown && volDown) {
    pattern = '價平量縮'; signal = 'neutral';
    reason = '價平量縮,市場觀望';
  }

  let divergence = null;
  try {
    const last5 = candles.slice(-5);
    const prev5 = candles.slice(-10, -5);
    if (last5.length === 5 && prev5.length === 5) {
      const priceChg = (_last(last5).close - _first(last5).close) / _first(last5).close;
      const v1 = _avg(last5.map(c => c.volume));
      const v0 = _avg(prev5.map(c => c.volume));
      const volChg = v0 ? (v1 - v0) / v0 : 0;
      if (priceChg > 0.03 && volChg < -0.15) {
        divergence = { type: 'top', desc: '高檔量價背離(價漲量縮)' };
      } else if (priceChg < -0.03 && volChg < -0.15) {
        divergence = { type: 'bottom', desc: '低檔量價背離(價跌量縮)' };
      }
    }
  } catch {}

  let surge = null;
  if (volRatio >= 2.0) {
    surge = { ratio: +volRatio.toFixed(2), desc: `今日量能是 20 日均量的 ${volRatio.toFixed(2)} 倍` };
  }
  let dried = null;
  if (volRatio <= 0.4 && volRatio > 0) {
    dried = { ratio: +volRatio.toFixed(2), desc: `今日量能僅 20 日均量的 ${(volRatio * 100).toFixed(0)}%,窒息量` };
  }

  const reasons = [
    `價:${priceUp ? '漲' : priceDown ? '跌' : '平'} ${((last.close - prev.close) / prev.close * 100).toFixed(2)}%`,
    `量:${volUp ? '增' : volDown ? '縮' : '平'},是 20 日均量的 ${volRatio.toFixed(2)} 倍`,
    reason,
  ];
  if (divergence) reasons.push(divergence.desc);
  if (surge)      reasons.push(surge.desc);
  if (dried)      reasons.push(dried.desc);

  return {
    pattern, signal, reason,
    volRatio: +volRatio.toFixed(2),
    avgVol20: Math.round(avgVol20),
    todayVol: last.volume || 0,
    divergence, surge, dried,
    reasons,
  };
}

// ===========================================================================
// 共用工具
// ===========================================================================
function _avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + (x || 0), 0) / arr.length;
}
function _first(arr) { return arr[0]; }
function _last(arr)  { return arr[arr.length - 1]; }

// ===========================================================================
// B1 — K 棒特徵描述(長黑、長紅、十字、帶量等)
// ===========================================================================
function _describeBar(candle, avgVol) {
  if (!candle) return '';
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const bodyRatio = range > 0 ? body / range : 0;
  const isUp = candle.close > candle.open;
  const isDown = candle.close < candle.open;
  const isFlat = !isUp && !isDown;

  let shape = '';
  if (bodyRatio < 0.15) {
    shape = '十字';
  } else if (bodyRatio > 0.7) {
    // 長實體
    if (isUp) shape = '長紅';
    else if (isDown) shape = '長黑';
    else shape = '長';
  } else {
    // 中等實體
    if (isUp) shape = '紅';
    else if (isDown) shape = '黑';
    else shape = '中';
  }

  // 上下影線
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const longUpper = range > 0 && upperWick / range > 0.4;
  const longLower = range > 0 && lowerWick / range > 0.4;

  if (longUpper && shape.includes('紅')) shape = '上影紅';
  else if (longUpper && shape.includes('黑')) shape = '上影黑';
  else if (longLower && shape.includes('紅')) shape = '下影紅';
  else if (longLower && shape.includes('黑')) shape = '下影黑';

  // 量能
  let volTag = '';
  if (avgVol && candle.volume) {
    const r = candle.volume / avgVol;
    if (r >= 2)   volTag = '帶量';
    else if (r >= 1.5) volTag = '量增';
    else if (r <= 0.5) volTag = '量縮';
  }

  return volTag ? `${shape}${volTag}` : shape;
}

// 用 K 棒特徵推測市場意義(用於 swing 點的 reason)
function _barMarketMeaning(barDesc, isHigh) {
  // isHigh = true: 高點;false: 低點
  if (isHigh) {
    if (barDesc.includes('長黑') || barDesc.includes('上影')) return '當天賣壓沉重';
    if (barDesc.includes('十字')) return '當天多空拉鋸';
    if (barDesc.includes('黑'))   return '當天買盤後繼無力';
    if (barDesc.includes('紅'))   return '當天衝高未能延續';
    return '當天形成高點';
  } else {
    if (barDesc.includes('長紅') || barDesc.includes('下影')) return '當天買盤強勁,出現止跌';
    if (barDesc.includes('十字')) return '當天多空拉鋸,跌勢趨緩';
    if (barDesc.includes('紅'))   return '當天買盤承接,跌勢止穩';
    if (barDesc.includes('黑'))   return '當天破底但收盤未追低';
    return '當天形成低點';
  }
}

// ===========================================================================
// B2 — 時間描述自然化
// ===========================================================================
// barTime 可以是 unix timestamp (sec) 或 'YYYY-MM-DD'
function _timeAgo(barTime, todayTime) {
  if (!barTime) return '';
  const barDate = _toDate(barTime);
  const today   = _toDate(todayTime);
  if (!barDate || !today) return '';
  const dayMs = 86400 * 1000;
  const diffDays = Math.round((today - barDate) / dayMs);
  const mdStr = `${barDate.getMonth() + 1}/${barDate.getDate()}`;

  if (diffDays < 0) return mdStr;                   // 未來日期(理論不該發生)
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  if (diffDays <= 7)  return `${diffDays} 天前`;
  if (diffDays <= 21) return `${Math.round(diffDays / 7)} 週前(${mdStr})`;
  if (diffDays <= 90) return `${Math.round(diffDays / 30)} 個月前(${mdStr})`;
  if (diffDays <= 365) return `${barDate.getFullYear()}/${mdStr}`;
  // 超過一年
  return `${barDate.getFullYear()}/${mdStr}`;
}

function _toDate(t) {
  if (t == null) return null;
  if (typeof t === 'number') {
    // Lightweight Charts 用 unix 秒
    return new Date(t * 1000);
  }
  if (typeof t === 'string') {
    // 'YYYY-MM-DD'
    const d = new Date(t);
    return isNaN(d) ? null : d;
  }
  if (t instanceof Date) return t;
  return null;
}

// ===========================================================================
// B3 — 歷史驗證:某條支撐/壓力過去被測試的次數
// ===========================================================================
// 回傳: { tests, held, broken, lastBreakBar?, lastBreakDesc? }
function _validateLevelHistory(price, candles, tolerance, isResistance) {
  if (!Array.isArray(candles) || candles.length < 30 || !price) {
    return { tests: 0, held: 0, broken: 0 };
  }
  // 用 close 跟價位的距離判斷是否「靠近」
  const tol = price * (tolerance || 0.015);   // 預設 1.5%
  let tests = 0, held = 0, broken = 0;
  let lastBreak = null;
  let inZone = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    // 進入測試區間:K 棒的 high/low 觸及 price ± tol
    const touched = (c.low <= price + tol && c.high >= price - tol);

    if (touched && !inZone) {
      inZone = true;
      tests++;
      // 判斷是否被突破:之後 3 根之內是否明顯穿越
      const lookahead = Math.min(3, candles.length - i - 1);
      let didBreak = false;
      for (let j = 1; j <= lookahead; j++) {
        const next = candles[i + j];
        if (isResistance) {
          // 壓力被突破 = 收盤明顯站上
          if (next.close > price + tol * 1.5) { didBreak = true; break; }
        } else {
          // 支撐被跌破 = 收盤明顯跌破
          if (next.close < price - tol * 1.5) { didBreak = true; break; }
        }
      }
      if (didBreak) {
        broken++;
        lastBreak = { idx: i, candle: c };
      } else {
        held++;
      }
    }
    // 離開測試區間:K 棒不再觸及
    if (!touched) inZone = false;
  }

  return {
    tests,
    held,
    broken,
    lastBreakIdx:  lastBreak?.idx,
    lastBreakTime: lastBreak?.candle?.time,
  };
}

// 把 history 物件變成自然語句
function _describeHistory(history, candles, isResistance) {
  if (!history || history.tests === 0) return '';
  const todayTime = candles[candles.length - 1]?.time;
  const t = history.tests, h = history.held, b = history.broken;
  let s = `過去測試 ${t} 次,守住 ${h} 次,${isResistance ? '突破' : '跌破'} ${b} 次`;
  if (history.lastBreakTime != null) {
    const ago = _timeAgo(history.lastBreakTime, todayTime);
    if (ago) s += `(最近一次${isResistance ? '突破' : '跌破'}:${ago})`;
  }
  return s;
}

// ===========================================================================
// B4 — 可執行建議生成器
// ===========================================================================
function _buildSRAdvice(supports, resists, lastClose) {
  const advice = [];
  const s1 = supports?.items?.[0];
  const r1 = resists?.items?.[0];

  if (s1) {
    advice.push(`想做多:可在 $${s1.price} 附近找進場(距現價 -${s1.distance}%)`);
    advice.push(`停損可設 $${(s1.price * 0.985).toFixed(2)} 以下(跌破支撐 1.5%)`);
  }
  if (r1) {
    advice.push(`短線壓力在 $${r1.price}(距現價 +${r1.distance}%),靠近可先停利或減碼`);
    if (r1.strength >= 3) {
      advice.push(`要突破 $${r1.price} 需要量能配合,沒帶量別追`);
    }
  }
  if (!s1 && !r1) advice.push('上下方都沒有明顯關鍵價,等趨勢明朗再說');
  return advice;
}

function _buildBoxAdvice(box) {
  if (!box || box.skipped || !box.isBox) return [];
  const advice = [];
  if (box.position === 'near_upper') {
    advice.push(`接近上緣 $${box.upper},站不上去就回到下緣 → 短線可先減碼`);
    advice.push(`站穩 $${box.upper} 才視為向上突破`);
  } else if (box.position === 'near_lower') {
    advice.push(`接近下緣 $${box.lower},止跌訊號出現可考慮承接`);
    advice.push(`跌破 $${box.lower} 視為向下突破,停損快`);
  } else {
    advice.push(`目前位於箱型中段,等靠近上下緣再做決定`);
  }
  if (box.suggestion?.riskReward >= 2) {
    advice.push(`風險報酬比 ${box.suggestion.riskReward}:1,值得操作`);
  } else if (box.suggestion?.riskReward > 0 && box.suggestion.riskReward < 1.5) {
    advice.push(`風險報酬比僅 ${box.suggestion.riskReward}:1,不夠誘人`);
  }
  return advice;
}

function _buildTrendAdvice(trend) {
  if (!trend) return [];
  const advice = [];
  if (trend.direction === 'up') {
    advice.push('趨勢偏多,適合順勢操作(回測買、突破續抱)');
    if (trend.health < 70) advice.push('健康度偏低,別重押,留意短線過熱');
  } else if (trend.direction === 'down') {
    advice.push('趨勢偏空,觀望為主,別逆勢攤平');
    advice.push('等止跌訊號出現再考慮進場(KD 低檔交叉、量縮止跌等)');
  } else {
    advice.push('趨勢盤整,等方向明確再進場');
    advice.push('盤整中可考慮箱型操作:下緣買、上緣賣');
  }
  return advice;
}

function _buildVolPriceAdvice(vp) {
  if (!vp || vp.empty) return [];
  const advice = [];
  switch (vp.signal) {
    case 'bullish':
      advice.push('價量齊揚是健康多方,可考慮續抱或加碼');
      advice.push('留意是否一日行情,觀察隔日是否有跟進量');
      break;
    case 'mild-bullish':
      advice.push('價跌量縮代表跌勢趨緩,可注意止跌訊號');
      break;
    case 'warning':
      advice.push('價漲量縮警告,動能不足,別追高');
      advice.push('既有部位可考慮先停利,等量能回來再考慮');
      break;
    case 'bearish':
      advice.push('價跌量增,賣壓沉重,先觀望');
      advice.push('等收盤止跌或量縮再考慮承接');
      break;
    default:
      advice.push('量價平淡,沒有明確方向,觀望為主');
  }
  if (vp.surge)      advice.push('爆量是雙面刃:漲不上去往往是出貨,要小心');
  if (vp.divergence) advice.push(`偵測到${vp.divergence.type === 'top' ? '高檔' : '低檔'}量價背離,留意反轉`);
  return advice;
}


// ===========================================================================
// Phase 7.5 C — 假突破識別器
// ===========================================================================
// 找最近一次「突破壓力後 N 天內跌回」的假突破事件
// 回傳: { detected, level, breakoutIdx, breakoutDate, retraceIdx, retraceDate, daysAgo }
// ===========================================================================
export function detectFakeBreakout(candles, resistance, opts = {}) {
  const N = 5;          // 突破後幾根內跌回才算假突破
  const tolerance = 0.012;  // 站上 tol 才算突破,跌回 tol 以下算假突破

  if (!candles || candles.length < N + 2) return { detected: false };

  // 找最近一條壓力(取第一條)
  const r1 = resistance?.items?.[0];
  if (!r1) return { detected: false };
  const level = r1.price;

  const len = candles.length;
  // 從倒數第 60 根往後掃(太舊的不管)
  const start = Math.max(0, len - 60);

  let result = { detected: false };

  for (let i = start; i < len - 1; i++) {
    const c = candles[i];
    // 條件1: 這根收盤站上壓力(突破)
    if (c.close <= level * (1 + tolerance)) continue;

    // 條件2: 前一根還沒站上(確認是剛突破)
    if (i > 0 && candles[i - 1].close > level * (1 + tolerance)) continue;

    // 條件3: 後 N 根內有跌回 level 以下
    let retrace = false;
    let retraceIdx = -1;
    const lookEnd = Math.min(len - 1, i + N);
    for (let j = i + 1; j <= lookEnd; j++) {
      if (candles[j].close < level * (1 - tolerance)) {
        retrace = true;
        retraceIdx = j;
        break;
      }
    }

    if (retrace) {
      // 找到假突破,記錄最近一次(繼續迴圈找更新的)
      const daysAgo = len - 1 - retraceIdx;
      result = {
        detected:     true,
        level:        +level.toFixed(2),
        breakoutIdx:  i,
        breakoutDate: candles[i].time,
        retraceIdx,
        retraceDate:  candles[retraceIdx].time,
        daysAgo,
      };
    }
  }

  return result;
}

// ===========================================================================
// Phase 7.5 D — 分批進場計畫
// ===========================================================================
// 基於 support / resistance / box 自動建議三批進場 + 停損停利
// ===========================================================================
export function analyzeEntryPlan(result) {
  if (!result || result.empty) return null;

  const lastClose = result.lastClose;
  const s1 = result.support?.items?.[0];
  const s2 = result.support?.items?.[1];
  const r1 = result.resistance?.items?.[0];

  // 需要至少一個支撐 + 一個壓力才能計算
  if (!s1 || !r1) return null;

  // 三批進場價
  const entry1 = +(lastClose * 1.001).toFixed(2);              // 30% — 現價附近直接進
  const entry2 = +(s1.price).toFixed(2);                       // 40% — S1 附近
  const entry3 = s2 ? +(s2.price).toFixed(2) : +(s1.price * 0.97).toFixed(2); // 30% — S2 or S1-3%

  // 加權平均成本 (30/40/30)
  const avgCost = +((entry1 * 0.3 + entry2 * 0.4 + entry3 * 0.3)).toFixed(2);

  // 停損:S2 以下 1.5%,或 S1 以下 3%
  const stopBase = s2 ? s2.price : s1.price * 0.97;
  const stop = +(stopBase * 0.985).toFixed(2);

  // 停利:R1 以下 1%
  const target = +(r1.price * 0.99).toFixed(2);

  // 整體風報比(用平均成本算)
  const riskPerShare   = avgCost - stop;
  const rewardPerShare = target - avgCost;
  const rr = riskPerShare > 0 ? +(rewardPerShare / riskPerShare).toFixed(1) : 0;

  // 健康度(供燈燈判斷說法)
  const health = result.trend?.health ?? 50;

  return {
    entry1, entry2, entry3,
    weights: { e1: 30, e2: 40, e3: 30 },
    avgCost,
    stop,
    target,
    rr,
    health,
    s1Price: s1.price,
    s2Price: s2?.price ?? null,
    r1Price: r1.price,
  };
}

// ===========================================================================
// Phase 7.5+ — 歷史型態搜尋
// ===========================================================================
// 在自身 K 線中找與「最近 N 根」最相似的歷史片段
// 用正規化後的 cosine similarity
// 回傳最多 3 個相似片段 + 之後走勢
// ===========================================================================
export function findSimilarPatterns(candles, opts = {}) {
  const windowLen = opts.windowLen || 20;  // 拿最近 20 根當 query
  const topK      = opts.topK      || 3;
  const minGap    = opts.minGap    || 5;   // 相似段不能跟 query 重疊

  const N = candles.length;
  if (N < windowLen * 2 + minGap) return { patterns: [], windowLen };

  const closes = candles.map(c => c.close);

  // 正規化函式:把一段 closes 轉成「變化率序列」再 z-score
  function _normalize(arr) {
    const ret = [];
    for (let i = 1; i < arr.length; i++) {
      ret.push((arr[i] - arr[i - 1]) / arr[i - 1]);
    }
    const mean = ret.reduce((s, v) => s + v, 0) / ret.length;
    const std  = Math.sqrt(ret.reduce((s, v) => s + (v - mean) ** 2, 0) / ret.length) || 1;
    return ret.map(v => (v - mean) / std);
  }

  // cosine similarity
  function _cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2;
    }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }

  // query = 最近 windowLen 根
  const queryStart = N - windowLen;
  const queryVec   = _normalize(closes.slice(queryStart));

  // 掃描所有可能的歷史片段
  const candidates = [];
  for (let i = 0; i <= N - windowLen - minGap - 1; i++) {
    if (i + windowLen > queryStart - minGap) break; // 不跟 query 重疊
    const seg = closes.slice(i, i + windowLen);
    const vec = _normalize(seg);
    const sim = _cosine(queryVec, vec);
    candidates.push({ startIdx: i, sim });
  }

  // 取 top K,且彼此距離 > windowLen(去重複)
  candidates.sort((a, b) => b.sim - a.sim);
  const picked = [];
  for (const c of candidates) {
    if (picked.every(p => Math.abs(p.startIdx - c.startIdx) > windowLen)) {
      picked.push(c);
      if (picked.length >= topK) break;
    }
  }

  // 組裝結果:歷史片段 + 之後 10 根的走勢
  const followLen = 10;
  const patterns = picked.map(p => {
    const endIdx     = p.startIdx + windowLen - 1;
    const followEnd  = Math.min(N - 1, endIdx + followLen);
    const followCandles = candles.slice(endIdx + 1, followEnd + 1);
    const followPct  = followCandles.length
      ? +((followCandles[followCandles.length - 1].close - candles[endIdx].close)
          / candles[endIdx].close * 100).toFixed(2)
      : null;
    const followDir  = followPct == null ? 'unknown' :
                       followPct > 2  ? 'up' :
                       followPct < -2 ? 'down' : 'flat';

    // 時間描述
    const todayTime = candles[N - 1].time;
    const ago = _timeAgo(candles[p.startIdx].time, todayTime);

    return {
      startIdx:   p.startIdx,
      endIdx,
      similarity: +(p.sim * 100).toFixed(1),   // 百分比顯示
      startTime:  candles[p.startIdx].time,
      endTime:    candles[endIdx].time,
      ago:        ago || `第 ${p.startIdx + 1} 根`,
      entryClose: +candles[endIdx].close.toFixed(2),
      followPct,
      followDir,
      followLen:  followCandles.length,
    };
  });

  // 統計:幾次上漲 / 下跌
  const ups   = patterns.filter(p => p.followDir === 'up').length;
  const downs = patterns.filter(p => p.followDir === 'down').length;
  const bias  = ups > downs ? 'up' : downs > ups ? 'down' : 'mixed';

  return { patterns, windowLen, followLen, ups, downs, bias };
}

// ===========================================================================
// Phase 7.5+ — 歷史準確度回測
// ===========================================================================
// 回測 analyze() 找出的支撐壓力在歷史上的命中率
// 用「最近 N 根內,接近該價位後是否守住」來衡量
// ===========================================================================
export function backtestSRAccuracy(candles, support, resistance) {
  if (!candles || candles.length < 20) return null;
  const tolerance = 0.015;

  function _testLevel(price, isResist) {
    let touches = 0, success = 0;
    const tol = price * tolerance;
    let inZone = false;

    for (let i = 0; i < candles.length - 3; i++) {
      const c = candles[i];
      const touched = c.low <= price + tol && c.high >= price - tol;
      if (touched && !inZone) {
        inZone = true;
        touches++;
        // 看接下來 3 根是否守住
        let held = true;
        for (let j = 1; j <= 3; j++) {
          const nx = candles[i + j];
          if (!nx) break;
          if (isResist && nx.close > price + tol * 2) { held = false; break; }
          if (!isResist && nx.close < price - tol * 2) { held = false; break; }
        }
        if (held) success++;
      }
      if (!touched) inZone = false;
    }
    return { touches, success, rate: touches ? +(success / touches * 100).toFixed(0) : null };
  }

  const srResults = [];

  (support?.items || []).forEach((s, i) => {
    const r = _testLevel(s.price, false);
    srResults.push({
      type: 'support', index: i + 1, price: s.price,
      ...r,
      label: `支撐 ${i + 1} $${s.price}`,
    });
  });

  (resistance?.items || []).forEach((s, i) => {
    const r = _testLevel(s.price, true);
    srResults.push({
      type: 'resistance', index: i + 1, price: s.price,
      ...r,
      label: `壓力 ${i + 1} $${s.price}`,
    });
  });

  // 整體平均命中率
  const withData = srResults.filter(r => r.touches > 0);
  const avgRate  = withData.length
    ? +(withData.reduce((s, r) => s + r.rate, 0) / withData.length).toFixed(0)
    : null;

  return { srResults, avgRate };
}

// ===========================================================================
// Phase 7.5+ — 壓力測試模擬(Beta 法)
// ===========================================================================
// 用自身 K 線與大盤估算 Beta,預測大盤跌 X% 時此股大約跌多少
// 無法拿大盤資料時用常見台股 beta 分佈做保守估計
// ===========================================================================
export function stressTest(candles, opts = {}) {
  const scenarios = opts.scenarios || [-5, -10, -15, -20]; // 大盤跌幅情境(%)

  if (!candles || candles.length < 20) return null;

  const closes = candles.map(c => c.close);
  const N = closes.length;

  // 用近 60 根自身日漲跌幅的標準差估算波動率
  const rets = [];
  for (let i = 1; i < Math.min(N, 61); i++) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const stdDev = Math.sqrt(rets.reduce((s, r) => s + r ** 2, 0) / rets.length);
  const annualVol = +(stdDev * Math.sqrt(252) * 100).toFixed(1);

  // 台股大盤平均日波動約 1%,年化約 16%
  // Beta 估算:個股年化波動 / 16%(大盤年化波動) × 相關係數(保守假設 0.7)
  const marketAnnualVol = 16;
  const correlation = 0.70;
  const beta = +(annualVol / marketAnnualVol * correlation).toFixed(2);

  // 各情境預估
  const lastClose = closes[N - 1];
  const results = scenarios.map(mktPct => {
    const stockPct  = +(mktPct * beta).toFixed(1);
    const stockPrice = +(lastClose * (1 + stockPct / 100)).toFixed(2);
    return { mktPct, stockPct, stockPrice };
  });

  // 最大回撤參考(近 60 根)
  let maxDD = 0;
  let peak = closes[0];
  for (let i = 0; i < Math.min(N, 60); i++) {
    if (closes[i] > peak) peak = closes[i];
    const dd = (closes[i] - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    beta,
    annualVol,
    lastClose,
    results,
    maxDrawdown: +maxDD.toFixed(1),
  };
}

// ===========================================================================
// Phase 7.5+ — 時間警報(除息/法說會倒數)
// ===========================================================================
// 從已知事件計算倒數天數
// 實際日期需由外部傳入(從 TWSE/FinMind 取得後存入)
// 這裡提供計算與格式化工具函式
// ===========================================================================
export function calcTimeAlerts(events = []) {
  // events: [{ type: 'exdiv'|'meeting'|'custom', date: 'YYYY-MM-DD', label: string }]
  if (!events.length) return [];

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return events
    .map(ev => {
      const d = new Date(ev.date);
      d.setHours(0, 0, 0, 0);
      const diffMs   = d - now;
      const diffDays = Math.round(diffMs / 86400000);
      return {
        ...ev,
        diffDays,
        passed: diffDays < 0,
        urgency: diffDays <= 0  ? 'passed' :
                 diffDays <= 3  ? 'urgent' :
                 diffDays <= 14 ? 'soon'   : 'normal',
      };
    })
    .filter(ev => ev.diffDays >= -30)   // 過去 30 天內的也顯示(已通過)
    .sort((a, b) => a.diffDays - b.diffDays);
}
