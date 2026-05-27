// js/chart-signal-overlay.js
// ============================================================================
// Phase 7.3 — 燈號 K 線疊圖引擎(整合說明區版)
// ============================================================================
// 修正紀錄:
//   7.2: 獨立 canvas 管理、副圖 normalize Y、說明框設計
//   7.3: 整合 chart-analysis-panel(說明框移到上方說明區 + Excel 引線風格)
//        K 線上只保留:標記點、水平線、背離連線、箱型矩形
//        說明文字全部移到說明區的卡片
//
// 對外 API:
//   initSignalOverlay(refs)
//   renderSignalLayer(signalId)
//   clearSignalLayer()
//   getActiveSignal()
//   detectDivergences(candles) → DivResult[]
//   pauseSignalOverlay()
//   resumeSignalOverlay()
// ============================================================================

import { calcMA, calcKD, calcRSI, calcMACD, calcBollinger, calcBBWidth } from './indicators.js';
import { showSignalCards, clearSignalCards } from './chart-analysis-panel.js';
// MP2: 燈燈整合(點燈號時燈燈說一句相關的話)
import { dengToast } from './loading-deng.js';

// ─── 顏色 ───
const C = {
  bull:   '#26a69a',
  bear:   '#ef5350',
  orange: '#f5a623',
  purple: '#a78bfa',
  yellow: '#fbbf24',
};

// ─── 狀態 ───
let refs     = null;
let activeId = null;
let activeData = null;
let paused   = false;
const _canvases = {};

// timeScale 訂閱管理(只訂閱一次,避免重複堆積)
let _unsubTime    = null;
let _unsubLogical = null;

// ============================================================================
// 初始化
// ============================================================================
export function initSignalOverlay(r) {
  refs = r;
  window.addEventListener('chartRendered', () => {
    _destroyCanvases();
    // chart 重建後重新訂閱 timeScale
    _resubscribeTimeScale();
    // MP1: 切週期 / reloadChart 後,如果有正在顯示的燈號,
    //      重新計算(因為 candles 換了)+ 重畫
    if (activeId && !paused) {
      _recalcAndRedraw();
    }
  });
}

// MP1: 用目前 activeId 重新跑一次計算 + 更新說明卡 + 重畫
// 注意:這是自動重算(切週期/reloadChart),不會觸發燈燈說話
function _recalcAndRedraw() {
  const candles = refs?.getCandles?.() || [];
  if (!candles.length || !activeId) return;

  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);

  try {
    if      (activeId === 'S1')  activeData = _calcS1(candles, closes, vols);
    else if (activeId === 'S2')  activeData = _calcS2(candles, closes);
    else if (activeId === 'S5')  activeData = _calcS5(candles, vols);
    else if (activeId === 'S13') activeData = _calcS13(candles, closes, vols);
    else if (activeId.startsWith('divergence_')) activeData = _calcDiv(activeId, candles, closes);
  } catch (e) {
    console.error('[signal-overlay] recalc failed', e);
    activeData = null;
  }

  if (activeData) {
    showSignalCards([{
      id:          activeData.id,
      label:       activeData.label,
      color:       activeData.color,
      lines:       activeData.explainLines,
      anchorIdx:   activeData.anchorIdx,
      anchorPrice: activeData.anchorPrice,
      anchorAbove: activeData.anchorAbove,
    }]);
    _draw();
    // (不呼叫 _dengSaySignal,避免每次切週期都跳 toast)
  } else {
    // 計算失敗(新週期可能不適用)→ 清除
    activeId = null;
    clearSignalCards();
  }
}

// timeScale 訂閱:只訂一次,重複呼叫先取消舊的
function _resubscribeTimeScale() {
  // 取消舊訂閱
  try { _unsubTime?.();    } catch {}
  try { _unsubLogical?.(); } catch {}
  _unsubTime = null;
  _unsubLogical = null;

  const chart = refs?.getMainChart?.();
  if (!chart) return;

  try {
    const ts = chart.timeScale();
    const redraw = () => { if (activeId && activeData && !paused) _draw(); };

    ts.subscribeVisibleTimeRangeChange(redraw);
    _unsubTime = () => { try { ts.unsubscribeVisibleTimeRangeChange(redraw); } catch {} };

    if (typeof ts.subscribeVisibleLogicalRangeChange === 'function') {
      ts.subscribeVisibleLogicalRangeChange(redraw);
      _unsubLogical = () => { try { ts.unsubscribeVisibleLogicalRangeChange(redraw); } catch {} };
    }
  } catch (e) {
    console.warn('[signal-overlay] subscribeTimeScale failed', e);
  }
}

// ============================================================================
// 對外 API
// ============================================================================
export function renderSignalLayer(signalId) {
  const candles = refs?.getCandles?.() || [];
  if (!candles.length) return;

  if (activeId === signalId) { clearSignalLayer(); return; }

  clearSignalLayer(false);
  activeId = signalId;

  // 確保 timeScale 訂閱存在(第一次呼叫時建立)
  if (!_unsubTime) _resubscribeTimeScale();

  const closes = candles.map(c => c.close);
  const vols   = candles.map(c => c.volume);

  try {
    if      (signalId === 'S1')  activeData = _calcS1(candles, closes, vols);
    else if (signalId === 'S2')  activeData = _calcS2(candles, closes);
    else if (signalId === 'S5')  activeData = _calcS5(candles, vols);
    else if (signalId === 'S13') activeData = _calcS13(candles, closes, vols);
    else if (signalId.startsWith('divergence_')) activeData = _calcDiv(signalId, candles, closes);
    else activeData = null;
  } catch (e) {
    console.error('[signal-overlay] calc failed', e);
    activeData = null;
  }

  if (activeData) {
    // 說明區卡片
    showSignalCards([{
      id:          activeData.id,
      label:       activeData.label,
      color:       activeData.color,
      lines:       activeData.explainLines,
      anchorIdx:   activeData.anchorIdx,
      anchorPrice: activeData.anchorPrice,
      anchorAbove: activeData.anchorAbove,
    }]);

    if (!paused) _draw();

    // MP2: 燈燈說一句相關的話
    _dengSaySignal(signalId, activeData);
  }
}

// MP2: 點燈號 → 燈燈說一句相關的話
function _dengSaySignal(signalId, data) {
  try {
    const line = _pickDengLine(signalId, data);
    if (line) {
      dengToast(line.text, { mood: line.mood || 'happy', duration: 3500 });
    }
  } catch (e) { /* 燈燈出錯不影響主流程 */ }
}

// ============================================================================
// Phase 7.5 A1+B — 精準台詞 + 表情系統
// 原則:有數字才說數字;毒舌比例 ~30%;充咕(confused)用在分歧情境
// ============================================================================

// B 區:表情對應輔助
function _moodForS1(markers, lastVolR) {
  if (lastVolR > 3)  return 'excited';
  if (markers.length >= 3) return 'happy';
  return 'curious';
}
function _moodForS2(goldenCount, deathCount) {
  if (goldenCount > 0 && deathCount === 0) return 'happy';
  if (deathCount > goldenCount) return 'sad';
  return 'curious';
}
function _moodForS5(lastIsUp, maxRatio) {
  if (maxRatio > 3 && lastIsUp) return 'excited';
  if (maxRatio > 3 && !lastIsUp) return 'sad';
  return 'curious';
}
function _moodForS13(hasBreak, segLen) {
  if (hasBreak) return 'excited';
  if (segLen > 25) return 'sleepy';
  return 'curious';
}

// A1 — 燈號台詞:讀 data 生成有數字的活台詞
function _pickDengLine(signalId, data) {

  // ── 🚀 量價齊揚 S1 ──────────────────────────────────────────────────────
  if (signalId === 'S1') {
    const markers = data?.markers ?? [];
    const last = markers[markers.length - 1];
    const ratio = last?.volR;
    const chg   = last?.chgPct;
    const mood  = _moodForS1(markers, ratio ?? 1);

    if (ratio != null && ratio > 3) {
      return { text: `爆量 ${ratio.toFixed(1)} 倍!主力在動 — 別追高喵`, mood };
    }
    if (ratio != null && ratio > 1.5 && chg != null) {
      const savagePick = Math.random() < 0.3;
      if (savagePick) return { text: `量 ${ratio.toFixed(1)} 倍、漲 ${chg.toFixed(1)}% — 看起來不錯但燈燈不保證`, mood };
      return { text: `量增 ${ratio.toFixed(1)} 倍、漲 ${chg.toFixed(1)}%,動能健康 ~ 停損設好`, mood };
    }
    if (markers.length === 0) {
      return { text: '近期沒找到量價齊揚的 K 棒,燈燈也疑惑', mood: 'curious' };
    }
    return { text: `找到 ${markers.length} 根量增價漲 ~ 結構不錯,觀察一下`, mood };
  }

  // ── 📈 均線啟動 S2 ──────────────────────────────────────────────────────
  if (signalId === 'S2') {
    const markers = data?.markers ?? [];
    const goldenCount = markers.filter(m => m.type === 'golden').length;
    const deathCount  = markers.filter(m => m.type === 'death').length;
    const mood = _moodForS2(goldenCount, deathCount);

    if (goldenCount > 0 && deathCount === 0) {
      return { text: `近期 ${goldenCount} 次黃金交叉,沒有死叉 ~ 趨勢啟動囉`, mood };
    }
    if (goldenCount > 0 && deathCount > 0) {
      const savagePick = Math.random() < 0.35;
      if (savagePick) return { text: `黃金 ${goldenCount} 次、死叉 ${deathCount} 次,方向反覆 — 燈燈不確定`, mood: 'curious' };
      return { text: `黃金交叉 ${goldenCount} 次,但也有 ${deathCount} 次死叉,等確認再進`, mood };
    }
    if (deathCount > 0 && goldenCount === 0) {
      return { text: `近期都是死叉,均線還在整理 — 燈燈先觀望`, mood: 'sad' };
    }
    return { text: '均線尚未交叉,等方向確認再說 ~', mood: 'curious' };
  }

  // ── 💥 爆量異動 S5 ──────────────────────────────────────────────────────
  if (signalId === 'S5') {
    const surges = data?.markers ?? [];
    const last = surges[surges.length - 1];
    const maxR = surges.length ? Math.max(...surges.map(s => s.r)) : 0;
    const mood = last ? _moodForS5(last.isUp, maxR) : 'curious';

    if (surges.length === 0) {
      return { text: '爆量訊號?燈燈沒找到明顯的 — 你確定嗎', mood: 'curious' };
    }
    if (last?.isUp && maxR > 3) {
      return { text: `爆量 ${maxR.toFixed(1)} 倍拉升!熱度高,但小心一日行情`, mood };
    }
    if (!last?.isUp && maxR > 3) {
      return { text: `爆量 ${maxR.toFixed(1)} 倍下殺 — 燈燈建議先閃,別接刀`, mood };
    }
    if (maxR > 1.5) {
      return { text: `找到 ${surges.length} 根爆量棒,最大 ${maxR.toFixed(1)} 倍 ~ 觀察方向`, mood };
    }
    return { text: `量異常但方向不明,等隔日再看 ~`, mood: 'curious' };
  }

  // ── 📦 箱型突破 S13 ──────────────────────────────────────────────────────
  if (signalId === 'S13') {
    const boxData = data?.box;
    const segLen  = boxData ? (boxData.toIdx - boxData.fromIdx + 1) : 0;
    const hasBreak = (data?.markers ?? []).length > 0;
    const high = data?.hlines?.find(l => l.label?.startsWith('壓力'))?.price;
    const low  = data?.hlines?.find(l => l.label?.startsWith('支撐'))?.price;
    const mood = _moodForS13(hasBreak, segLen);

    if (hasBreak && high != null && low != null) {
      const range = ((high - low) / low * 100).toFixed(1);
      const savagePick = Math.random() < 0.3;
      if (savagePick) return { text: `突破了!區間 ${range}% — 但假突破很常見,停損別忘`, mood };
      return { text: `箱型 ${segLen} 根後突破!區間 ${range}%,帶量才算數 ~`, mood };
    }
    if (!hasBreak && segLen > 25) {
      return { text: `悶了 ${segLen} 根還沒突破,燈燈都快睡著了`, mood: 'sleepy' };
    }
    if (!hasBreak) {
      return { text: `整理 ${segLen} 根,方向還沒確認 — 等它突破再說`, mood };
    }
    return { text: '箱型整理中,帶寬收窄後往往有大行情 ~', mood: 'curious' };
  }

  // ── 背離訊號 ─────────────────────────────────────────────────────────────
  if (signalId?.startsWith('divergence_')) {
    const isBull = signalId.includes('bull');
    const indType = signalId.includes('macd') ? 'MACD' :
                    signalId.includes('kd')   ? 'KD'   : 'RSI';
    const count = data?.divPairs?.length || 0;

    if (count === 0) {
      return { text: `${indType} 沒看到明顯背離耶 ~ 燈燈也不確定`, mood: 'curious' };
    }
    if (isBull) {
      const savagePick = Math.random() < 0.3;
      if (savagePick) return { text: `${indType} 底背離 ${count} 組 — 也許要反彈,但別孤注一擲`, mood: 'curious' };
      return { text: `${indType} 底背離 ${count} 組,跌勢動能在減弱 ~ 可注意反彈`, mood: 'happy' };
    } else {
      return { text: `${indType} 頂背離 ${count} 組,上漲動能衰竭 — 別追高,燈燈警告`, mood: 'sad' };
    }
  }

  return null;
}

export function clearSignalLayer(resetId = true) {
  if (resetId) {
    activeId = null;
    activeData = null;
    // 清除時取消 timeScale 訂閱,避免殘留
    try { _unsubTime?.();    } catch {}
    try { _unsubLogical?.(); } catch {}
    _unsubTime = null;
    _unsubLogical = null;
  }
  _destroyCanvases();
  clearSignalCards();
}

export function getActiveSignal() { return activeId; }

export function pauseSignalOverlay() {
  paused = true;
  _destroyCanvases();
  clearSignalCards();
}

export function resumeSignalOverlay() {
  paused = false;
  if (activeId && activeData) {
    showSignalCards([{
      id:          activeData.id,
      label:       activeData.label,
      color:       activeData.color,
      lines:       activeData.explainLines,
      anchorIdx:   activeData.anchorIdx,
      anchorPrice: activeData.anchorPrice,
      anchorAbove: activeData.anchorAbove,
    }]);
    _draw();
  }
}

// ============================================================================
// 背離偵測
// ============================================================================
export function detectDivergences(candles) {
  if (!candles || candles.length < 30) return [];
  const closes = candles.map(c => c.close);
  const out = [];

  const { dif } = calcMACD(closes);
  const macdDiv = _findDivPairs(candles, closes, dif);
  if (macdDiv.bull.length) out.push({ id: 'divergence_macd_bull', label: 'MACD 底背離', desc: '下跌動能逐漸減弱,注意築底訊號', pairs: macdDiv.bull });
  if (macdDiv.bear.length) out.push({ id: 'divergence_macd_bear', label: 'MACD 頂背離', desc: '上漲動能逐漸衰竭,注意高點反轉', pairs: macdDiv.bear });

  const { k } = calcKD(candles);
  const kdDiv = _findDivPairs(candles, closes, k);
  if (kdDiv.bull.length) out.push({ id: 'divergence_kd_bull', label: 'KD 底背離',   desc: 'KD 未跟隨股價創低,下跌動能減弱', pairs: kdDiv.bull });
  if (kdDiv.bear.length) out.push({ id: 'divergence_kd_bear', label: 'KD 頂背離',   desc: 'KD 未跟隨股價創高,追高風險升高', pairs: kdDiv.bear });

  const rsi = calcRSI(closes);
  const rsiDiv = _findDivPairs(candles, closes, rsi);
  if (rsiDiv.bull.length) out.push({ id: 'divergence_rsi_bull', label: 'RSI 底背離',  desc: 'RSI 未跟隨股價創低,反彈動能積累', pairs: rsiDiv.bull });
  if (rsiDiv.bear.length) out.push({ id: 'divergence_rsi_bear', label: 'RSI 頂背離',  desc: 'RSI 未跟隨股價創高,高檔風險升高', pairs: rsiDiv.bear });

  return out;
}

// ============================================================================
// 各燈號計算(回傳 K 線繪圖指令 + 說明卡資料)
// ============================================================================
function _calcS1(candles, closes, vols) {
  const ma20 = calcMA(closes, 20);
  const N = candles.length;
  const n = Math.min(20, vols.length - 1);
  const avgVol = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n || 1;
  const markers = [];
  for (let i = Math.max(0, N - 20); i < N; i++) {
    const c = candles[i];
    const chgPct = (c.close - c.open) / c.open * 100;
    const volR   = c.volume / avgVol;
    if (chgPct >= 2 && volR >= 1.5 && ma20[i] != null && c.close > ma20[i])
      markers.push({ idx: i, c, volR, chgPct });
  }
  const last = markers[markers.length - 1];
  const firstMarker = markers[0];
  return {
    id: 'S1', label: '🚀 量價齊揚', color: C.bull,
    markers, hlines: [ma20[N-1] ? { price: ma20[N-1], color: '#60a5fa', label: `MA20 ${ma20[N-1]}` } : null].filter(Boolean),
    // 框選區間:從第一個標記到最後一個
    range: markers.length ? { fromIdx: firstMarker.idx, toIdx: last.idx } : null,
    explainLines: [
      `近 20 根找到 ${markers.length} 根量增價漲 K 棒`,
      `股價站上 MA20（${ma20[N-1]?.toFixed(2)}）`,
      last ? `最近：漲 ${last.chgPct.toFixed(1)}%，量 ${last.volR.toFixed(1)}x 均量` : '',
      `趨勢啟動，多方動能強`,
    ].filter(Boolean),
    anchorIdx: last?.idx ?? N - 1,
    anchorPrice: last?.c.high ?? candles[N-1].high,
    anchorAbove: true,
  };
}

function _calcS2(candles, closes) {
  const ma5  = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const N = candles.length;
  const crosses = [];
  for (let i = 1; i < N; i++) {
    if (!ma5[i] || !ma20[i] || !ma5[i-1] || !ma20[i-1]) continue;
    if (ma5[i] > ma20[i] && ma5[i-1] <= ma20[i-1])
      crosses.push({ idx: i, type: 'golden', c: candles[i], price: ma5[i] });
    else if (ma5[i] < ma20[i] && ma5[i-1] >= ma20[i-1])
      crosses.push({ idx: i, type: 'death',  c: candles[i], price: ma5[i] });
  }
  const recent = crosses.slice(-4);
  const lastGolden = [...crosses].reverse().find(p => p.type === 'golden');
  return {
    id: 'S2', label: '📈 均線啟動', color: C.yellow,
    markers: recent,
    hlines: [
      ma5[N-1]  ? { price: ma5[N-1],  color: '#f59e0b', label: `MA5 ${ma5[N-1]}`  } : null,
      ma20[N-1] ? { price: ma20[N-1], color: '#60a5fa', label: `MA20 ${ma20[N-1]}` } : null,
    ].filter(Boolean),
    // 框選最近黃金交叉到現在的區間
    range: lastGolden ? { fromIdx: lastGolden.idx, toIdx: N - 1 } : null,
    explainLines: [
      `黃金交叉 ${recent.filter(c => c.type==='golden').length} 次 / 死叉 ${recent.filter(c => c.type==='death').length} 次`,
      lastGolden ? `最近黃金交叉：K棒 #${lastGolden.idx + 1}` : '尚未出現黃金交叉',
      `MA5 上穿 MA20 為趨勢啟動訊號`,
      `可觀察成交量是否同步放大`,
    ].filter(Boolean),
    anchorIdx: lastGolden?.idx ?? N - 1,
    anchorPrice: lastGolden?.c.high ?? candles[N-1].high,
    anchorAbove: true,
  };
}

function _calcS5(candles, vols) {
  const N = candles.length;
  const n = Math.min(20, vols.length - 1);
  const avgVol = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n || 1;
  const surges = [];
  for (let i = Math.max(0, N - 30); i < N; i++) {
    const r = candles[i].volume / avgVol;
    if (r >= 2.5) surges.push({ idx: i, c: candles[i], r, isUp: candles[i].close >= candles[i].open });
  }
  const last = surges[surges.length - 1];
  return {
    id: 'S5', label: '💥 爆量異動', color: C.orange,
    markers: surges, hlines: [],
    range: surges.length ? { fromIdx: surges[0].idx, toIdx: surges[surges.length-1].idx } : null,
    explainLines: [
      `近 30 根找到 ${surges.length} 根爆量 K 棒`,
      last ? `最大量：${Math.max(...surges.map(s => s.r)).toFixed(1)}x 均量` : '',
      last ? (last.isUp ? '主力積極買進，動能偏多' : '籌碼快速換手，留意方向') : '',
      `爆量後走勢為關鍵觀察點`,
    ].filter(Boolean),
    anchorIdx: last?.idx ?? N - 1,
    anchorPrice: last?.isUp ? last?.c.high : last?.c.low,
    anchorAbove: last?.isUp ?? true,
  };
}

function _calcS13(candles, closes, vols) {
  const N = candles.length;
  const bands  = calcBollinger(closes, 20, 2);
  const widths = calcBBWidth(closes, 20, 2);
  const n = Math.min(20, vols.length - 1);
  const avgVol = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n || 1;
  const valid = widths.map((w, i) => ({ w, i })).filter(x => x.w != null);
  const minW = Math.min(...valid.map(x => x.w));
  const sqStart = valid.find(x => x.w <= minW * 1.15)?.i ?? N - 20;
  let breakIdx = -1;
  for (let i = sqStart + 1; i < N; i++) {
    if (!widths[i] || !widths[i-1] || !widths[i-2]) continue;
    if (widths[i] > widths[i-1] && widths[i-1] > widths[i-2] && candles[i].volume / avgVol >= 1.5)
      breakIdx = i;
  }
  const seg = candles.slice(sqStart, breakIdx > 0 ? breakIdx + 1 : N);
  const boxH = Math.max(...seg.map(c => c.high));
  const boxL = Math.min(...seg.map(c => c.low));
  const bb = bands[N - 1];
  return {
    id: 'S13', label: '📦 箱型突破', color: C.purple,
    markers: breakIdx > 0 ? [{ idx: breakIdx, c: candles[breakIdx], type: 'breakout' }] : [],
    box: { fromIdx: sqStart, toIdx: N - 1, high: boxH, low: boxL },
    range: { fromIdx: sqStart, toIdx: N - 1 },   // 箱型整理整段
    hlines: [
      { price: boxH, color: C.bear,   label: `壓力 ${boxH.toFixed(2)}` },
      { price: boxL, color: C.bull,   label: `支撐 ${boxL.toFixed(2)}`  },
      bb ? { price: bb.upper, color: 'rgba(167,139,250,0.7)', label: `BB上 ${bb.upper}` } : null,
      bb ? { price: bb.lower, color: 'rgba(167,139,250,0.7)', label: `BB下 ${bb.lower}` } : null,
    ].filter(Boolean),
    explainLines: [
      `箱型整理 ${seg.length} 根，區間 ${boxL.toFixed(2)}~${boxH.toFixed(2)}`,
      breakIdx > 0 ? `K棒 #${breakIdx + 1} 放量突破訊號` : '尚未突破，等待方向',
      bb ? `布林上軌 ${bb.upper} / 下軌 ${bb.lower}` : '',
      breakIdx > 0 ? '突破站穩後可考慮進場' : '帶寬收窄後往往有大波動',
    ].filter(Boolean),
    anchorIdx: breakIdx > 0 ? breakIdx : N - 1,
    anchorPrice: breakIdx > 0 ? candles[breakIdx].high : boxH,
    anchorAbove: true,
  };
}

function _calcDiv(signalId, candles, closes) {
  const isBull = signalId.includes('bull');
  const type   = signalId.includes('macd') ? 'macd' : signalId.includes('kd') ? 'kd' : 'rsi';
  let indArr, indLabel;
  if (type === 'macd')    { const { dif } = calcMACD(closes); indArr = dif; indLabel = 'MACD DIF'; }
  else if (type === 'kd') { const { k } = calcKD(candles);    indArr = k;   indLabel = 'KD-K';    }
  else                    { indArr = calcRSI(closes);          indLabel = 'RSI(14)';               }
  const pairs = _findDivPairs(candles, closes, indArr);
  const active = isBull ? pairs.bull : pairs.bear;
  const last   = active[active.length - 1];
  return {
    id: signalId, label: isBull ? `↗ ${indLabel} 底背離` : `↘ ${indLabel} 頂背離`,
    color: C.orange,
    isBull, type, indArr, indLabel,
    divPairs: active,
    markers: [], hlines: [],
    range: last ? { fromIdx: last.idx1, toIdx: last.idx2 } : null,
    explainLines: active.length ? [
      isBull ? '價格逐漸往下走' : '價格逐漸往上走',
      isBull ? `${indLabel} 卻持續往上` : `${indLabel} 卻持續往下`,
      isBull ? '意味著下跌動能在逐漸減弱' : '意味著上漲動能在逐漸衰竭',
      `偵測到 ${active.length} 組${isBull ? '底' : '頂'}背離`,
    ] : [`未偵測到明顯${isBull ? '底' : '頂'}背離`],
    anchorIdx: last ? last.idx2 : candles.length - 1,
    anchorPrice: last ? (isBull ? candles[last.idx2].low : candles[last.idx2].high) : candles[candles.length-1].close,
    anchorAbove: !isBull,
  };
}

// ============================================================================
// 背離演算法
// ============================================================================
function _findDivPairs(candles, closes, indArr, lookback = 40) {
  const N = candles.length;
  const start = Math.max(0, N - lookback);
  const k = 3;
  const lows = [], highs = [];
  for (let i = start + k; i < N - k; i++) {
    if (indArr[i] == null) continue;
    let isPL = true, isPH = true;
    for (let j = 1; j <= k; j++) {
      if (closes[i] >= closes[i-j] || closes[i] >= closes[i+j]) isPL = false;
      if (closes[i] <= closes[i-j] || closes[i] <= closes[i+j]) isPH = false;
    }
    if (isPL) lows.push({ idx: i, price: closes[i], ind: indArr[i] ?? 0 });
    if (isPH) highs.push({ idx: i, price: closes[i], ind: indArr[i] ?? 0 });
  }
  const bull = [], bear = [];
  for (let i = 1; i < lows.length; i++) {
    const a = lows[i-1], b = lows[i];
    if (b.price < a.price && b.ind > a.ind) bull.push({ idx1: a.idx, idx2: b.idx, price1: a.price, price2: b.price, ind1: a.ind, ind2: b.ind });
  }
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i-1], b = highs[i];
    if (b.price > a.price && b.ind < a.ind) bear.push({ idx1: a.idx, idx2: b.idx, price1: a.price, price2: b.price, ind1: a.ind, ind2: b.ind });
  }
  return { bull: bull.slice(-2), bear: bear.slice(-2) };
}

// ============================================================================
// K 線繪製(只畫標記/水平線/背離連線/箱型,說明文字在說明區)
// ============================================================================
function _draw() {
  if (!activeData || !refs) return;
  const d = activeData;
  const candles = refs.getCandles?.() || [];
  if (!candles.length) return;

  const mainEl  = refs.getMainChartEl?.();
  const chart   = refs.getMainChart?.();
  const series  = refs.getCandleSeries?.();
  if (!mainEl || !chart || !series) return;

  const canvas = _getOrCreateCanvas('main', mainEl);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const h = _makeHelpers(chart, series, canvas);

  _clearCanvas(canvas);

  // 0. 對應條件的 K 線區間半透明框選(最先畫,在最底層)
  if (d.range) _drawRangeHighlight(ctx, h, d.range, d.color);

  // 箱型矩形
  if (d.box) _drawBox(ctx, h, d.box, d.color);

  // 水平線
  for (const hl of d.hlines || []) _drawHLine(ctx, h, hl);

  // K 棒標記點
  for (const m of d.markers || []) _drawMarker(ctx, h, m, d);

  // 背離連線(主圖 — 連接價格低/高點)
  if (d.divPairs?.length) {
    for (const p of d.divPairs) _drawDivLineMain(ctx, h, candles, p, d.isBull);
    // 副圖
    _drawSubScene(d, candles, h);
  }

  // 均線交叉圓圈(S2)
  if (d.id === 'S2') {
    for (const m of d.markers || []) _drawCrossMarker(ctx, h, m);
  }
}

// ─── 個別繪圖 ───

// 區間半透明框選 + 頂部色條
function _drawRangeHighlight(ctx, h, range, color) {
  const x1 = h.lx(range.fromIdx);
  const x2 = h.lx(range.toIdx);
  if (!_ok(x1, x2)) return;
  const left  = Math.min(x1, x2);
  const width = Math.abs(x2 - x1) + 20; // 稍微寬一點讓最後一根 K 棒也進去

  ctx.save();
  // 半透明填色
  ctx.fillStyle = color + '18'; // ~10% 透明度
  ctx.fillRect(left - 10, 0, width, h.H);

  // 頂部細色條
  ctx.fillStyle = color + '60'; // ~38% 透明度
  ctx.fillRect(left - 10, 0, width, 3);

  // 左側邊線
  ctx.strokeStyle = color + '50';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(left - 10, 0);
  ctx.lineTo(left - 10, h.H);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function _drawBox(ctx, h, box, color) {
  const x1 = h.lx(box.fromIdx), x2 = h.lx(box.toIdx);
  const y1 = h.py(box.high),    y2 = h.py(box.low);
  if (!_ok(x1, x2, y1, y2)) return;
  ctx.save();
  ctx.strokeStyle = color || C.purple;
  ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.fillStyle = 'rgba(167,139,250,0.06)'; ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  ctx.setLineDash([]); ctx.restore();
}

function _drawHLine(ctx, h, hl) {
  const y = h.py(hl.price);
  if (y == null) return;
  ctx.save();
  ctx.strokeStyle = hl.color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(h.W, y); ctx.stroke();
  ctx.setLineDash([]);
  if (hl.label) {
    ctx.font = '11px system-ui'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    const tw = ctx.measureText(hl.label).width;
    ctx.fillStyle = hl.color; ctx.fillRect(h.W - tw - 10, y - 9, tw + 8, 18);
    ctx.fillStyle = '#fff'; ctx.fillText(hl.label, h.W - 4, y);
  }
  ctx.restore();
}

function _drawMarker(ctx, h, m, d) {
  const x = h.lx(m.idx);
  if (x == null) return;
  let y, sym, color;
  if (d.id === 'S5') {
    color = m.isUp ? C.bull : C.bear;
    y = m.isUp ? (h.py(m.c.high) ?? 0) - 14 : (h.py(m.c.low) ?? h.H) + 14;
    sym = m.isUp ? '▲' : '▼';
  } else if (d.id === 'S13' && m.type === 'breakout') {
    color = C.purple; y = (h.py(m.c.high) ?? 0) - 14; sym = '⬆';
  } else {
    color = d.color || C.bull; y = (h.py(m.c.low) ?? h.H) + 14; sym = '↑';
  }
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(sym, x, y);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.4;
  ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1; ctx.restore();
}

function _drawCrossMarker(ctx, h, m) {
  const x = h.lx(m.idx), y = h.py(m.price);
  if (!_ok(x, y)) return;
  const color = m.type === 'golden' ? C.yellow : '#9ca3af';
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = color; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
  ctx.restore();
}

function _drawDivLineMain(ctx, h, candles, pair, isBull) {
  const x1 = h.lx(pair.idx1), x2 = h.lx(pair.idx2);
  const y1 = isBull ? h.py(candles[pair.idx1].low) : h.py(candles[pair.idx1].high);
  const y2 = isBull ? h.py(candles[pair.idx2].low) : h.py(candles[pair.idx2].high);
  if (!_ok(x1, x2, y1, y2)) return;
  _drawArrowLine(ctx, x1, y1, x2, y2, C.orange, 2);
}

// 副圖背離線
function _drawSubScene(d, candles, mainH) {
  const subElFn  = d.type === 'macd' ? refs.getMacdChartEl  : d.type === 'kd' ? refs.getKdChartEl  : refs.getRsiChartEl;
  const subChFn  = d.type === 'macd' ? refs.getMacdChart    : d.type === 'kd' ? refs.getKdChart    : refs.getRsiChart;
  const subEl    = subElFn?.();
  const subChart = subChFn?.();
  if (!subEl || !subChart) return;

  const subCanvas = _getOrCreateCanvas(d.type, subEl);
  if (!subCanvas) return;
  const subCtx = subCanvas.getContext('2d');
  _clearCanvas(subCanvas);

  const vals = (d.indArr || []).filter(v => v != null);
  if (!vals.length) return;
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const norm = v => maxV === minV ? 0.5 : (v - minV) / (maxV - minV);

  const ts = subChart.timeScale?.();
  const lx = idx => { try { const x = ts?.logicalToCoordinate(idx); return _ok(x) ? x : null; } catch { return null; } };
  const ch = subEl.clientHeight || 80;
  const pad = ch * 0.1;
  const ny = v => ch - pad - norm(v) * (ch - pad * 2);

  for (const p of d.divPairs) {
    const x1 = lx(p.idx1), x2 = lx(p.idx2);
    const y1 = ny(p.ind1), y2 = ny(p.ind2);
    if (!_ok(x1, x2)) continue;
    _drawArrowLine(subCtx, x1, y1, x2, y2, C.orange, 2);
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      subCtx.fillStyle = C.orange; subCtx.beginPath(); subCtx.arc(x, y, 4, 0, Math.PI * 2); subCtx.fill();
    }
    // 副圖小標籤
    const label = d.isBull ? '底背離' : '頂背離';
    subCtx.save();
    subCtx.fillStyle = 'rgba(14,17,23,0.90)';
    const tw = subCtx.measureText(label).width;
    _roundRect(subCtx, 8, 4, tw + 14, 20, 4); subCtx.fill();
    subCtx.strokeStyle = C.orange; subCtx.lineWidth = 1;
    _roundRect(subCtx, 8, 4, tw + 14, 20, 4); subCtx.stroke();
    subCtx.fillStyle = C.orange; subCtx.font = 'bold 11px system-ui';
    subCtx.textBaseline = 'middle'; subCtx.textAlign = 'left';
    subCtx.fillText(label, 15, 14);
    subCtx.restore();
  }
}

// ============================================================================
// Canvas 管理
// ============================================================================
function _getOrCreateCanvas(key, containerEl) {
  if (_canvases[key] && _canvases[key].parentNode === containerEl) return _canvases[key];
  if (_canvases[key]) { try { _canvases[key].parentNode?.removeChild(_canvases[key]); } catch {} }
  if (!containerEl) return null;
  const cs = getComputedStyle(containerEl);
  if (cs.position === 'static') containerEl.style.position = 'relative';
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, containerEl.clientWidth);
  const h = Math.max(1, containerEl.clientHeight);
  const canvas = document.createElement('canvas');
  canvas.id = `signal-canvas-${key}`;
  canvas.width  = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  Object.assign(canvas.style, { position: 'absolute', top: '0', left: '0', width: w + 'px', height: h + 'px', pointerEvents: 'none', zIndex: '6' });
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  containerEl.appendChild(canvas);
  _canvases[key] = canvas;
  return canvas;
}

function _clearCanvas(canvas) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
}

function _destroyCanvases() {
  for (const [key, canvas] of Object.entries(_canvases)) {
    try { canvas.parentNode?.removeChild(canvas); } catch {}
    delete _canvases[key];
  }
}

// ============================================================================
// 座標工具(不再負責訂閱,訂閱已移到 initSignalOverlay)
// ============================================================================
function _makeHelpers(chart, series, canvas) {
  const ts = chart.timeScale();
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  const py = p => { if (p == null) return null; try { const y = series.priceToCoordinate(p); return _ok(y) ? y : null; } catch { return null; } };
  const lx = i => { if (i == null) return null; try { const x = ts.logicalToCoordinate(i); return _ok(x) ? x : null; } catch { return null; } };
  return { py, lx, W, H };
}

// ============================================================================
// 繪圖工具
// ============================================================================
function _drawArrowLine(ctx, x1, y1, x2, y2, color, lw = 2) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash([4, 3]); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  const angle = Math.atan2(y2 - y1, x2 - x1), al = 9;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - al * Math.cos(angle - 0.38), y2 - al * Math.sin(angle - 0.38));
  ctx.lineTo(x2 - al * Math.cos(angle + 0.38), y2 - al * Math.sin(angle + 0.38));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _ok(...vals) { return vals.every(v => v != null && isFinite(v)); }
