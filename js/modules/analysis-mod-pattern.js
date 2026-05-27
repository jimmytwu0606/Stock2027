/* js/modules/analysis-mod-pattern.js
 * 🌟 Pattern Golden Board Module
 * K 線型態：紅三兵 / 多頭吞噬 / 三重底 / 三重頂 / 杯柄形態
 * 直接複用 screener.js 的偵測邏輯，確保與全市場掃描結果一致
 */
import { AppState } from '../state.js';
import { calcMA, calcDMI } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ── 內部工具（與 screener.js 保持一致）──
function _linearSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - xMean) * (y - yMean); den += (i - xMean) ** 2; });
  return den === 0 ? 0 : num / den;
}

// ═══════════════════════════════════════════════════════
// 🌟 PatternModule — Golden Board
// K 線型態偵測：五大型態一次判讀
// ═══════════════════════════════════════════════════════
const PatternModule = {
  id: 'pattern',
  name: 'K 線型態',
  icon: '🕯️',
  candleMinLen: 10,

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);

    // ── 1. 紅三兵 ──
    let threeSoldiers = false, threeSoldiersDetail = null;
    if (n >= 3) {
      const c = candles.slice(-3);
      const allBull = c.every(k => k.close > k.open);
      const closing  = c[0].close < c[1].close && c[1].close < c[2].close;
      const bodies   = c.map(k => Math.abs(k.close - k.open));
      const noTiny   = bodies.every((b, i) => i === 0 || b >= bodies[i - 1] * 0.5);
      threeSoldiers = allBull && closing && noTiny;
      if (threeSoldiers) {
        threeSoldiersDetail = {
          gains: c.map(k => ((k.close - k.open) / k.open * 100).toFixed(2)),
          closes: c.map(k => k.close.toFixed(2)),
        };
      }
    }

    // ── 2. 多頭吞噬 ──
    let bullishEngulfing = false, engulfDetail = null;
    if (n >= 2) {
      const prev = candles[n - 2];
      const cur  = candles[n - 1];
      const prevBear = prev.close < prev.open;
      const curBull  = cur.close > cur.open;
      const engulf   = cur.open <= prev.close && cur.close >= prev.open;
      bullishEngulfing = prevBear && curBull && engulf;
      if (bullishEngulfing) {
        const engulfRatio = Math.abs(cur.close - cur.open) / Math.abs(prev.close - prev.open);
        engulfDetail = {
          prevBody:  Math.abs(prev.close - prev.open).toFixed(2),
          curBody:   Math.abs(cur.close  - cur.open).toFixed(2),
          ratio:     engulfRatio.toFixed(2),
          prevClose: prev.close.toFixed(2),
          curClose:  cur.close.toFixed(2),
        };
      }
    }

    // ── 3. 三重底（三川）── 複用 screener.js 邏輯
    let threeValleys = false, valleyDetail = null;
    if (n >= 50) {
      const seg = candles.slice(-60);
      const sN  = seg.length;
      const valleys = [];
      for (let i = 5; i < sN - 5; i++) {
        const low = seg[i].low ?? seg[i].close;
        const isLocal = [1,2,3,4,5].every(d =>
          (seg[i-d]?.low ?? seg[i-d]?.close ?? Infinity) > low &&
          (seg[i+d]?.low ?? seg[i+d]?.close ?? Infinity) > low
        );
        if (isLocal) valleys.push({ idx: i, low });
      }
      if (valleys.length >= 3) {
        const last3 = valleys.slice(-3);
        const lows  = last3.map(v => v.low);
        const minL  = Math.min(...lows), maxL = Math.max(...lows);
        const avgPrice = (minL + maxL) / 2;
        const simThreshold = avgPrice < 20 ? 0.015 : (avgPrice < 100 ? 0.020 : 0.031);
        const similar = maxL > 0 && (maxL - minL) / maxL < simThreshold;

        let pass3 = true;
        if (similar) {
          for (let k = 0; k < 2; k++) {
            const segHi = seg.slice(last3[k].idx + 1, last3[k + 1].idx);
            if (segHi.length === 0) { pass3 = false; break; }
            const maxHi = Math.max(...segHi.map(c => c.high ?? c.close));
            const lowBoundary = Math.max(last3[k].low, last3[k + 1].low);
            if ((maxHi - lowBoundary) / lowBoundary < 0.02) { pass3 = false; break; }
          }
        }

        let pass4 = true;
        const firstIdx = last3[0].idx;
        const preCloses = seg.slice(Math.max(0, firstIdx - 20), firstIdx).map(c => c.close);
        if (preCloses.length >= 5) {
          const slope = _linearSlope(preCloses);
          const avgPre = preCloses.reduce((a, b) => a + b, 0) / preCloses.length;
          const normSlope = avgPre > 0 ? slope / avgPre : 0;
          if (normSlope > -0.0005) pass4 = false;
        }

        let pass5a = true, pass5b = true, pass5c = true;
        const ma20Arr = calcMA(closes, 20);
        const recentMA20 = ma20Arr.slice(-10).filter(Number.isFinite);
        if (recentMA20.length >= 5) {
          const s = _linearSlope(recentMA20);
          const avg = recentMA20.reduce((a,b)=>a+b,0)/recentMA20.length;
          if (avg > 0 && s/avg < -0.003) pass5a = false;
        }
        try {
          const dmi = calcDMI(candles, 14);
          const lastAdx = dmi?.adx?.[dmi.adx.length - 1];
          if (Number.isFinite(lastAdx) && lastAdx >= 25) pass5b = false;
        } catch(e) {}
        const afterCloses = seg.slice(last3[2].idx + 1).map(c=>c.close).filter(Number.isFinite);
        if (afterCloses.length >= 2) {
          const avgAfter = afterCloses.reduce((a,b)=>a+b,0)/afterCloses.length;
          if (avgAfter <= last3[2].low * 1.005) pass5c = false;
        }

        threeValleys = similar && pass3 && pass4 && pass5a && pass5b && pass5c;
        if (similar) {
          valleyDetail = {
            lows: lows.map(v => v.toFixed(2)),
            spread: ((maxL - minL) / maxL * 100).toFixed(2),
            pass3, pass4, pass5a, pass5b, pass5c,
          };
        }
      }
    }

    // ── 4. 三重頂（三山）── 複用 screener.js 邏輯
    let threePeaks = false, peakDetail = null;
    if (n >= 50) {
      const seg = candles.slice(-60);
      const sN  = seg.length;
      const peaks = [];
      for (let i = 5; i < sN - 5; i++) {
        const high = seg[i].high ?? seg[i].close;
        const isLocal = [1,2,3,4,5].every(d =>
          (seg[i-d]?.high ?? seg[i-d]?.close ?? 0) < high &&
          (seg[i+d]?.high ?? seg[i+d]?.close ?? 0) < high
        );
        if (isLocal) peaks.push({ idx: i, high });
      }
      if (peaks.length >= 3) {
        const last3 = peaks.slice(-3);
        const highs = last3.map(v => v.high);
        const minH  = Math.min(...highs), maxH = Math.max(...highs);
        const avgPrice = (minH + maxH) / 2;
        const simThreshold = avgPrice < 20 ? 0.015 : (avgPrice < 100 ? 0.020 : 0.031);
        const similar = maxH > 0 && (maxH - minH) / maxH < simThreshold;

        let pass3 = true;
        if (similar) {
          for (let k = 0; k < 2; k++) {
            const segLo = seg.slice(last3[k].idx + 1, last3[k + 1].idx);
            if (segLo.length === 0) { pass3 = false; break; }
            const minLo = Math.min(...segLo.map(c => c.low ?? c.close));
            const highBoundary = Math.min(last3[k].high, last3[k + 1].high);
            if ((highBoundary - minLo) / highBoundary < 0.02) { pass3 = false; break; }
          }
        }

        let pass4 = true;
        const firstIdx = last3[0].idx;
        const preCloses = seg.slice(Math.max(0, firstIdx - 20), firstIdx).map(c => c.close);
        if (preCloses.length >= 5) {
          const slope = _linearSlope(preCloses);
          const avgPre = preCloses.reduce((a,b)=>a+b,0)/preCloses.length;
          const normSlope = avgPre > 0 ? slope / avgPre : 0;
          if (normSlope < 0.0005) pass4 = false;
        }

        let pass5a = true, pass5b = true, pass5c = true;
        const ma20Arr = calcMA(closes, 20);
        const recentMA20 = ma20Arr.slice(-10).filter(Number.isFinite);
        if (recentMA20.length >= 5) {
          const s = _linearSlope(recentMA20);
          const avg = recentMA20.reduce((a,b)=>a+b,0)/recentMA20.length;
          if (avg > 0 && s/avg > 0.003) pass5a = false;
        }
        try {
          const dmi = calcDMI(candles, 14);
          const lastAdx = dmi?.adx?.[dmi.adx.length - 1];
          if (Number.isFinite(lastAdx) && lastAdx >= 25) pass5b = false;
        } catch(e) {}
        const afterCloses = seg.slice(last3[2].idx + 1).map(c=>c.close).filter(Number.isFinite);
        if (afterCloses.length >= 2) {
          const avgAfter = afterCloses.reduce((a,b)=>a+b,0)/afterCloses.length;
          if (avgAfter >= last3[2].high * 0.995) pass5c = false;
        }

        threePeaks = similar && pass3 && pass4 && pass5a && pass5b && pass5c;
        if (similar) {
          peakDetail = {
            highs: highs.map(v => v.toFixed(2)),
            spread: ((maxH - minH) / maxH * 100).toFixed(2),
            pass3, pass4, pass5a, pass5b, pass5c,
          };
        }
      }
    }

    // ── 5. 杯柄形態 ──
    let cupAndHandle = false, cupDetail = null;
    if (n >= 60) {
      const seg    = candles.slice(-80);
      const sN     = seg.length;
      const segClose = seg.map(c => c.close);
      const highs  = seg.map(c => c.high ?? c.close);
      const vols   = seg.map(c => c.volume ?? 0);

      const cupLeft   = Math.max(...highs.slice(0, Math.floor(sN * 0.4)));
      const cupBottom = Math.min(...segClose.slice(Math.floor(sN * 0.2), Math.floor(sN * 0.8)));
      const cupDepth  = cupLeft > 0 ? (cupLeft - cupBottom) / cupLeft : 1;

      const handleSeg  = segClose.slice(-Math.floor(sN * 0.2));
      const handleHigh = Math.max(...handleSeg);
      const handleDrop = handleHigh > 0 ? (handleHigh - segClose[segClose.length - 1]) / handleHigh : 1;
      const lastClose  = segClose[segClose.length - 1];
      const nearRim    = lastClose >= cupLeft * 0.97;
      const handleVols = vols.slice(-Math.floor(sN * 0.2));
      const handleAvgV = handleVols.reduce((a,b)=>a+b,0) / handleVols.length;
      const totalAvgV  = vols.reduce((a,b)=>a+b,0) / vols.length;
      const volShrink  = handleAvgV < totalAvgV * 0.9;

      cupAndHandle = cupDepth < 0.35 && handleDrop < 0.15 && nearRim && volShrink;
      cupDetail = {
        cupLeft:    cupLeft.toFixed(2),
        cupBottom:  cupBottom.toFixed(2),
        cupDepth:   (cupDepth * 100).toFixed(1),
        handleDrop: (handleDrop * 100).toFixed(1),
        lastClose:  lastClose.toFixed(2),
        nearRim,
        volShrink,
        handleAvgV: handleAvgV.toFixed(0),
        totalAvgV:  totalAvgV.toFixed(0),
        // 判斷當前階段（即使未完成也要給分析）
        stage: cupAndHandle ? 'breakout'
             : nearRim && !volShrink ? 'handle_no_shrink'
             : cupDepth < 0.35 && handleDrop < 0.15 ? 'handle_forming'
             : cupDepth < 0.35 ? 'cup_complete'
             : 'cup_forming',
      };
    }

    // ── 建構 items ──
    const items = [];
    const lastClose = closes[n - 1];

    // 紅三兵
    items.push({
      ok: threeSoldiers ? true : null,
      text: threeSoldiers
        ? `<strong>✅ 紅三兵確立</strong>：連續 3 根實體遞增陽線`
        : `<strong>紅三兵</strong>：未出現（需連續 3 根遞增陽線）`,
      sub: threeSoldiers
        ? `3根漲幅：${threeSoldiersDetail.gains.map(g => '+'+g+'%').join(' / ')}，收盤遞增 ${threeSoldiersDetail.closes.join(' → ')}`
        : `最近 3 根未同時滿足：全陽線 + 收盤遞增 + 實體不縮小`,
      whyTitle: '紅三兵代表什麼？',
      why: '連續 3 根陽線且收盤依次遞增，代表多方連續三天主動進攻並守住戰果。是強勢突破後的延伸確認訊號，也是底部反轉的強力訊號之一。出現在低檔盤整後勝率最高，高檔出現要小心「最後一棒」。',
    });

    // 多頭吞噬
    items.push({
      ok: bullishEngulfing ? true : null,
      text: bullishEngulfing
        ? `<strong>✅ 多頭吞噬確立</strong>：今日陽線完全吞噬昨日陰線`
        : `<strong>多頭吞噬</strong>：未出現（需昨陰今陽且今日實體完全吞噬）`,
      sub: bullishEngulfing
        ? `昨陰實體 ${engulfDetail.prevBody} 元，今陽實體 ${engulfDetail.curBody} 元（吞噬比 ${engulfDetail.ratio}x），今收 ${engulfDetail.curClose}`
        : `昨日收盤 ${candles[n-2]?.close?.toFixed(2)}，今日收盤 ${lastClose.toFixed(2)}，未形成完整吞噬`,
      whyTitle: '多頭吞噬為什麼是強力反轉訊號？',
      why: '昨日陰線代表空方控盤，今日陽線不但收復昨日跌幅，更完全吞噬昨日實體，代表多方大力反攻成功。吞噬比率越大（今日實體 > 昨日實體）、配合成交量放大，可靠性越高。是 K 線型態中最直觀的短線買入訊號。',
    });

    // 三重底
    items.push({
      ok: threeValleys ? true : valleyDetail ? null : null,
      text: threeValleys
        ? `<strong>✅ 三重底確立</strong>：五道防線全部通過`
        : valleyDetail
        ? `<strong>三重底偵測中</strong>：找到相近三低點，部分防線未通過`
        : `<strong>三重底</strong>：未偵測到（需 ≥ 50 根 K 線）`,
      sub: threeValleys
        ? `三低點 ${valleyDetail.lows.join(' / ')}，差距 ${valleyDetail.spread}%`
        : valleyDetail
        ? `三低點 ${valleyDetail.lows.join(' / ')}，差距 ${valleyDetail.spread}%　防線：3${valleyDetail.pass3?'✅':'❌'} 4${valleyDetail.pass4?'✅':'❌'} 5a${valleyDetail.pass5a?'✅':'❌'} 5b${valleyDetail.pass5b?'✅':'❌'} 5c${valleyDetail.pass5c?'✅':'❌'}`
        : `需要至少 50 根 K 線才能計算`,
      whyTitle: '三重底五道防線是什麼？',
      why: '防線1: 左右各5根嚴格低點（不允許並列）。防線2: 三低點差距動態門檻（低價股1.5%/高價股3.1%）。防線3: 兩低點之間的反彈高點要夠明顯（≥2%）。防線4: 第一低點之前要有明顯下跌趨勢（真的在打底）。防線5: MA20不再強跌 + ADX<25 + 第三低點後已走強。五道防線確保不是強勢整理或假底。',
    });

    // 三重頂
    items.push({
      ok: threePeaks ? false : peakDetail ? null : null,
      text: threePeaks
        ? `<strong>⚠️ 三重頂確立</strong>：五道防線全部通過，頂部型態成立`
        : peakDetail
        ? `<strong>三重頂偵測中</strong>：找到相近三高點，部分防線未通過`
        : `<strong>三重頂</strong>：未偵測到`,
      sub: threePeaks
        ? `三高點 ${peakDetail.highs.join(' / ')}，差距 ${peakDetail.spread}%，建議降低部位`
        : peakDetail
        ? `三高點 ${peakDetail.highs.join(' / ')}，差距 ${peakDetail.spread}%　防線：3${peakDetail.pass3?'✅':'❌'} 4${peakDetail.pass4?'✅':'❌'} 5a${peakDetail.pass5a?'✅':'❌'} 5b${peakDetail.pass5b?'✅':'❌'} 5c${peakDetail.pass5c?'✅':'❌'}`
        : `未在近 60 根內發現相近三高點`,
      whyTitle: '三重頂為什麼是危險訊號？',
      why: '股價三度衝高都以失敗告終，代表該價位有大量賣壓（籌碼套牢區），多方攻擊力道耗盡。五道防線確保三高點真的相近、來自上漲趨勢末段、且之後已開始走弱。確認後通常預示一波較大回檔。',
    });

    // 杯柄
    if (cupDetail) {
      const stageText = {
        breakout:          '✅ 突破杯緣',
        handle_no_shrink:  '⚠️ 柄部量未縮，待確認',
        handle_forming:    '🔄 柄部形成中',
        cup_complete:      '🔄 杯形完成，等待柄部',
        cup_forming:       '🔄 杯形形成中',
      }[cupDetail.stage];

      items.push({
        ok: cupAndHandle ? true : cupDetail.stage === 'cup_complete' || cupDetail.stage === 'handle_forming' ? null : null,
        text: `<strong>杯柄形態</strong>：${stageText}`,
        sub: `杯左側高點 ${cupDetail.cupLeft}，杯底 ${cupDetail.cupBottom}，杯深 ${cupDetail.cupDepth}%，柄回落 ${cupDetail.handleDrop}%`,
        whyTitle: '杯柄形態為什麼是強力突破訊號？',
        why: '杯形（U型整理）代表籌碼在低位充分換手、浮額洗清；柄部（小幅回落量縮）代表最後一批不堅定的持股者離場；突破杯緣時放量，代表主力正式啟動。這是 William O\'Neil CAN SLIM 選股法的核心型態，蘋果、輝達等成長股都曾多次形成後展開大波段。',
      });
    } else {
      items.push({
        ok: null,
        text: `<strong>杯柄形態</strong>：資料不足（需 ≥ 60 根 K 線）`,
        sub: `目前 ${n} 根，至少需要 60 根才能偵測杯柄`,
        whyTitle: '杯柄形態需要多少資料？', why: '杯形通常持續 7~65 週，柄部 1~5 週。偵測需要至少 60 根 K 線，建議使用 6mo 或 1y 週期進行分析。',
      });
    }

    // ── 綜合訊號 ──
    const bullCount = [threeSoldiers, bullishEngulfing, threeValleys, cupAndHandle].filter(Boolean).length;
    const hasBearWarning = threePeaks;

    let signal, score;
    if (hasBearWarning && bullCount === 0) {
      signal = { name: '三重頂警示', icon: '⚠️', stars: 1,
        desc: '三重頂型態確立，頂部訊號明確，建議降低多頭部位。' };
      score = 1;
    } else if (cupAndHandle) {
      signal = { name: '杯柄突破', icon: '🕯️', stars: 5,
        desc: '杯柄形態完成突破，中長線最強買入訊號，柄部量縮 + 突破放量。' };
      score = 5;
    } else if (threeValleys && (threeSoldiers || bullishEngulfing)) {
      signal = { name: '底部型態群', icon: '🏔️', stars: 5,
        desc: '三重底確立且出現多頭延伸型態，底部反轉訊號完整，可靠性極高。' };
      score = 5;
    } else if (threeValleys) {
      signal = { name: '三重底確立', icon: '🏔️', stars: 4,
        desc: '三重底五道防線通過，底部反轉訊號，可布局多頭。' };
      score = 4;
    } else if (threeSoldiers) {
      signal = { name: '紅三兵啟動', icon: '🪖', stars: 4,
        desc: '連續三根遞增陽線，多方連續主動進攻，強勢延伸中。' };
      score = 4;
    } else if (bullishEngulfing) {
      signal = { name: '多頭吞噬', icon: '🫶', stars: 3,
        desc: '今日陽線完全吞噬昨日陰線，短線多方大力反攻，注意成交量確認。' };
      score = 3;
    } else if (cupDetail && (cupDetail.stage === 'handle_forming' || cupDetail.stage === 'cup_complete')) {
      signal = { name: '杯柄醞釀中', icon: '☕', stars: 3,
        desc: `杯形${cupDetail.stage === 'cup_complete' ? '已完成' : '形成中'}，${cupDetail.stage === 'cup_complete' ? '等待柄部量縮後突破' : '等待形成柄部'}。` };
      score = 3;
    } else if (hasBearWarning) {
      signal = { name: '頂部型態觀察', icon: '⛰️', stars: 2,
        desc: '三重頂型態偵測中，部分防線未通過，謹慎看待高位繼續做多。' };
      score = 2;
    } else {
      signal = { name: '無明顯型態', icon: '🕯️', stars: 2,
        desc: '目前 K 線未形成明確的多/空型態訊號，以其他技術指標方向為主。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: {
        threeSoldiers, threeSoldiersDetail,
        bullishEngulfing, engulfDetail,
        threeValleys, valleyDetail,
        threePeaks, peakDetail,
        cupAndHandle, cupDetail,
        lastClose, n,
      },
    };
  },

  getLegendRows(ev) { return []; },  // 型態無圖例線條

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🕯️ K線型態</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    const r = ev.raw;
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';

    // 杯柄階段說明
    const stageDesc = {
      breakout:         { label: '✅ 突破完成', color: '#34d399', desc: '已突破杯緣，標準買點。突破時量能放大是關鍵確認。' },
      handle_no_shrink: { label: '⚠️ 柄部量未縮', color: '#fbbf24', desc: '柄部已形成但量能未充分縮小，等待量縮確認後再進場。' },
      handle_forming:   { label: '🔄 柄部形成中', color: '#93c5fd', desc: '杯形完成，正在形成柄部整理，等待量縮 + 突破。' },
      cup_complete:     { label: '🔄 杯形完成', color: '#93c5fd', desc: 'U型整理完成，等待柄部（小幅回落量縮）形成後突破。' },
      cup_forming:      { label: '🔄 杯形形成中', color: '#8a8f99', desc: '正在形成 U 型整理，型態尚未完成，持續觀察。' },
    }[r.cupDetail?.stage ?? 'cup_forming'];

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🕯️</span>
        <span class="fs-title">K 線型態分析</span>
        <span class="fs-subtitle">五大型態同步偵測 · 與全市場掃描邏輯完全一致</span>
      </div>
      <div class="fs-deep-module-body">

        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">
            ${ev.items.map(_renderReadoutItem).join('')}
          </div>
          <div class="fs-readout-summary">
            <span class="fs-signal-icon">${ev.signal.icon}</span>
            <div class="fs-signal-text">
              <span class="fs-signal-name">${ev.signal.name}</span>
              <span class="fs-signal-desc">${ev.signal.desc}</span>
            </div>
            <span class="fs-signal-stars">${stars}</span>
          </div>
        </div>

        ${r.cupDetail ? `
        <div class="fs-keylevels">
          <h4>☕ 杯柄形態進度</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(59,130,246,0.18);color:#93c5fd">目前階段</span>
            <span class="fs-keylevel-price" style="color:${stageDesc.color}">${stageDesc.label}</span>
            <span class="fs-keylevel-desc">${stageDesc.desc}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(251,191,36,0.18);color:#fbbf24">杯緣（突破點）</span>
            <span class="fs-keylevel-price">${r.cupDetail.cupLeft}</span>
            <span class="fs-keylevel-desc">杯左側高點 = 標準突破買點　${r.lastClose >= r.cupDetail.cupLeft * 0.97 ? '✅ 現價已接近杯緣' : `距杯緣 ${((r.cupDetail.cupLeft - r.lastClose) / r.lastClose * 100).toFixed(1)}%`}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(38,166,154,0.18);color:#6ee7b7">杯底</span>
            <span class="fs-keylevel-price">${r.cupDetail.cupBottom}</span>
            <span class="fs-keylevel-desc">杯深 ${r.cupDetail.cupDepth}%（≤35% 為合格）</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(139,92,246,0.18);color:#c4b5fd">柄部回落</span>
            <span class="fs-keylevel-price">${r.cupDetail.handleDrop}%</span>
            <span class="fs-keylevel-desc">${parseFloat(r.cupDetail.handleDrop) < 15 ? '✅ 合格（≤15%）' : '❌ 過深（>15%）'}　量縮：${r.cupDetail.volShrink ? '✅ 柄部量縮確認' : '❌ 量未縮（' + r.cupDetail.handleAvgV + ' vs 均量 ' + r.cupDetail.totalAvgV + '）'}</span>
          </div>
        </div>` : ''}

        ${r.threeValleys && r.valleyDetail ? `
        <div class="fs-keylevels" style="margin-top:16px">
          <h4>🏔️ 三重底詳情</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(16,185,129,0.18);color:#6ee7b7">三低點</span>
            <span class="fs-keylevel-price">${r.valleyDetail.lows.join(' / ')}</span>
            <span class="fs-keylevel-desc">差距 ${r.valleyDetail.spread}%，五道防線全部通過 ✅</span>
          </div>
        </div>` : ''}

        ${r.threePeaks && r.peakDetail ? `
        <div class="fs-keylevels" style="margin-top:16px">
          <h4>⛰️ 三重頂詳情</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">三高點</span>
            <span class="fs-keylevel-price">${r.peakDetail.highs.join(' / ')}</span>
            <span class="fs-keylevel-desc">差距 ${r.peakDetail.spread}%，頂部型態確立，建議降低部位</span>
          </div>
        </div>` : ''}

        <div class="fs-action-guide" style="margin-top:16px">
          <div class="fs-action-guide-head">🎯 操作建議</div>
          <div class="fs-action-guide-body">
            ${_patternActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🕯️ 五大型態速查 ━━━</h4>
            <p><strong>🪖 紅三兵</strong>：連3陽線遞增，多頭主動進攻。低檔出現 = 底部翻轉；中段出現 = 趨勢延伸</p>
            <p><strong>🫶 多頭吞噬</strong>：今陽完全吞噬昨陰，最直觀的短線反攻訊號。量放大可靠性更高</p>
            <p><strong>🏔️ 三重底</strong>：三次試底不破，籌碼充分換手。五道防線確保是真底部</p>
            <p><strong>⛰️ 三重頂</strong>：三次衝高失敗，大量套牢賣壓存在。確立後通常預示一波回檔</p>
            <p><strong>☕ 杯柄形態</strong>：U型整理 + 小幅柄部量縮 + 突破。中長線最強買點，蘋果/輝達都用過</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 型態偵測說明 ━━━</h4>
            <ul>
              <li><strong>與全市場掃描完全一致</strong>：本模組使用與選股篩選器完全相同的偵測邏輯</li>
              <li><strong>三重底/頂有五道防線</strong>：不是單純找三個相近點，需通過趨勢、ADX、走勢驗證</li>
              <li><strong>杯柄需 ≥ 60 根 K 線</strong>：建議用 6mo 或 1y 週期分析，1mo 資料不足</li>
              <li><strong>型態是結果，不是理由</strong>：出現型態後需搭配 KD/MACD/RSI 等指標確認動能</li>
            </ul>
          </div>
        </div>

        ${renderAISection('pattern', 'K線型態', '🕯️', ev, (() => {
          const detected = [];
          if (r.threeSoldiers) detected.push('✅ 紅三兵');
          if (r.bullishEngulfing) detected.push('✅ 多頭吞噬');
          if (r.threeValleys) detected.push('✅ 三重底（五道防線通過）');
          if (r.threePeaks) detected.push('⚠️ 三重頂（五道防線通過）');
          if (r.cupAndHandle) detected.push('✅ 杯柄突破');

          const partial = [];
          if (!r.threeValleys && r.valleyDetail) partial.push(`三重底偵測中（差距${r.valleyDetail.spread}%，5a${r.valleyDetail.pass5a?'✅':'❌'} 5b${r.valleyDetail.pass5b?'✅':'❌'} 5c${r.valleyDetail.pass5c?'✅':'❌'}）`);
          if (!r.threePeaks && r.peakDetail) partial.push(`三重頂偵測中（差距${r.peakDetail.spread}%，5a${r.peakDetail.pass5a?'✅':'❌'} 5b${r.peakDetail.pass5b?'✅':'❌'} 5c${r.peakDetail.pass5c?'✅':'❌'}）`);
          if (r.cupDetail && !r.cupAndHandle) partial.push(`杯柄${({breakout:'突破但量未縮',handle_no_shrink:'柄部量未縮',handle_forming:'柄部形成中',cup_complete:'杯形完成等待柄',cup_forming:'杯形形成中'})[r.cupDetail.stage]}（杯深${r.cupDetail.cupDepth}%，柄回落${r.cupDetail.handleDrop}%）`);

          const cupRows = r.cupDetail ? {
            '杯緣突破點【標準進場位】': r.cupDetail.cupLeft,
            '杯底': r.cupDetail.cupBottom,
            '杯深【≤35%合格】': `${r.cupDetail.cupDepth}%`,
            '柄部回落【≤15%合格】': `${r.cupDetail.handleDrop}%`,
            '柄部量縮【柄段均量<整體均量90%】': r.cupDetail.volShrink ? `✅ 量縮確認（${r.cupDetail.handleAvgV} < ${r.cupDetail.totalAvgV}×90%）` : `❌ 未縮量（${r.cupDetail.handleAvgV} vs 均量${r.cupDetail.totalAvgV}）`,
            '杯柄當前階段': ({breakout:'✅ 突破完成（標準買點）',handle_no_shrink:'⚠️ 柄部量未縮',handle_forming:'🔄 柄部形成中',cup_complete:'🔄 杯形完成等待柄',cup_forming:'🔄 杯形形成中'})[r.cupDetail.stage],
          } : {};

          return {
            '已確立型態': detected.length > 0 ? detected.join('、') : '無',
            '偵測中型態【防線未全過】': partial.length > 0 ? partial.join('、') : '無',
            '紅三兵': r.threeSoldiers ? `✅ 確立（${r.threeSoldiersDetail?.gains.map(g=>'+'+g+'%').join('/')})` : '未出現',
            '多頭吞噬': r.bullishEngulfing ? `✅ 確立（吞噬比${r.engulfDetail?.ratio}x）` : '未出現',
            '三重底': r.threeValleys ? `✅ 五道防線通過（低點${r.valleyDetail?.lows.join('/')}）` : r.valleyDetail ? `偵測中（差距${r.valleyDetail.spread}%）` : '未偵測到',
            '三重頂': r.threePeaks ? `⚠️ 五道防線通過（高點${r.peakDetail?.highs.join('/')}）` : r.peakDetail ? `偵測中（差距${r.peakDetail.spread}%）` : '未偵測到',
            ...cupRows,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}
      </div>
    `;
  },
};

function _patternActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;

  if (sig === '杯柄突破') return [
    { label: '進場建議', detail: `<strong>積極進場</strong>。突破杯緣（${r.cupDetail.cupLeft}）+ 量放大是標準買點，可進 50~70%` },
    { label: '加碼條件', detail: `突破後回測杯緣不破，量縮後再放量 → 加碼確認` },
    { label: '停損設置', detail: `跌回柄部低點 → 型態失敗，停損出場。目標價 = 杯深（${r.cupDetail.cupDepth}%）從杯緣向上量` },
    { label: '注意事項', detail: `假突破特徵：突破當天量不大，次日縮量回落。量是關鍵` },
  ];
  if (sig === '底部型態群' || sig === '三重底確立') return [
    { label: '進場建議', detail: `<strong>可積極布局</strong>。三重底五道防線通過，底部反轉訊號可靠性高` },
    { label: '加碼條件', detail: `突破頸線（兩底之間高點連線）+ 放量 → 加碼確認，型態正式成立` },
    { label: '停損設置', detail: `跌破第三低點 ${r.valleyDetail?.lows[2]} → 底部失效，停損` },
    { label: '注意事項', detail: `三重底後的第一波反彈常見回測頸線，回測不破才是真突破` },
  ];
  if (sig === '紅三兵啟動') return [
    { label: '持倉建議', detail: `<strong>多單續抱</strong>，紅三兵是強勢延伸訊號，不要因短線震盪提早出場` },
    { label: '進場建議', detail: `若未持多，紅三兵第三根收盤後可試單，第四根開盤回踩不破第三根收盤 → 加碼` },
    { label: '停損設置', detail: `跌破第一根陽線低點 → 型態失敗，停損` },
    { label: '注意事項', detail: `高檔出現紅三兵要小心「最後一棒」；低檔出現勝率最高` },
  ];
  if (sig === '多頭吞噬') return [
    { label: '進場建議', detail: `可試單 20~30%，<strong>今日收盤買入最優</strong>，吞噬當天量放大更可靠` },
    { label: '加碼條件', detail: `次日不跌破今日開盤價 → 多方守穩，加碼` },
    { label: '停損設置', detail: `跌破今日開盤價（昨日收盤附近）→ 吞噬失效，停損` },
    { label: '注意事項', detail: `配合 RSI/KD 超賣出現，勝率最高；高位吞噬可靠性較低` },
  ];
  if (sig === '三重頂警示') return [
    { label: '操作建議', detail: `<strong>降低多頭部位</strong>，三重頂確立代表高位賣壓沉重` },
    { label: '觀察重點', detail: `是否跌破頸線（三頂之間低點連線）。跌破 + 放量 = 正式確認，加速離場` },
    { label: '轉多條件', detail: `股價帶量重新站上三重頂高點附近 → 型態失效，重新評估` },
    { label: '注意事項', detail: `三重頂確認跌破頸線後通常有一次反彈（拉回頸線），那是減碼機會` },
  ];
  if (sig === '杯柄醞釀中') return [
    { label: '策略', detail: `<strong>等待柄部完成 + 突破放量</strong>再進場，不要在醞釀中追入` },
    { label: '突破條件', detail: `收盤站上杯緣 ${r.cupDetail?.cupLeft} + 成交量明顯放大（> 20天均量）→ 標準買點` },
    { label: '停損設置', detail: `柄部跌破杯深 15% 以上 → 型態失效，不等突破` },
    { label: '注意事項', detail: `柄部整理越久、量縮越充分，突破後動能越大` },
  ];
  return [
    { label: '操作建議', detail: `目前無明顯型態訊號，以 KD/MACD/RSI 等動能指標方向為主` },
    { label: '觀察重點', detail: `留意是否出現底部型態（三重底/多頭吞噬）或頂部警示（三重頂）` },
    { label: '注意事項', detail: `K 線型態是確認訊號，不是預測訊號，出現後才操作` },
  ];
}

registerAnalysisModule(PatternModule);
