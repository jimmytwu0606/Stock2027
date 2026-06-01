/**
 * analysis-perspective.js
 * ============================================================================
 * 「觀點」Tab — 個股攻防立場卡
 *
 * 框架來源：Strategy × 診斷 × 談判時機 × 停損決策 × 簡報表達（五門課閉環）
 *
 * 資料來源：
 *   candles          → K線（evaluate 參數）
 *   AppState.signals[code]  → 已掃描的策略訊號
 *   window.__fsEvalCache    → 其他指標 evaluate 結果（由 analysis-fullscreen 橋接）
 *   r                → 支撐壓力物件（透過 window.__srData 橋接）
 *
 * 對外：
 *   自動 registerAnalysisModule，id: 'perspective'
 *   永遠排在 Tab Bar 最前面（analysis-fullscreen 特殊處理 perspective）
 * ============================================================================
 */

import { AppState } from './state.js';
import { registerAnalysisModule } from './analysis-fullscreen.js';
import { calcSignalLamps } from './strategy.js';
import { STRATEGIES } from './strategy.js';
import { calcMACD, calcRSI } from './indicators.js';

// ─── 台股慣例 ───
const C_BULL  = '#ef5350';
const C_BEAR  = '#26a69a';
const C_AMBER = '#f59e0b';

// ─── 策略分類對應 ───
const BULL_CATEGORIES = new Set(['強勢續漲','超跌反彈','轉折訊號','葛蘭碧','盤整突破','基本面','巴菲特','技術指標','K線型態','X 系列']);
const WARN_CATEGORIES = new Set(['避險警示']);

// ─── W 系列 ID 集合 ───
const WARNING_IDS = new Set([
  'W1','W2','W3','W4','W5','W6','W7','W8','W9','W10',
  'W11','W12','W13','W14','W15','W16','W17','W18','W19','W20',
]);

// ============================================================================
// evaluate — 計算觀點資料
// ============================================================================

function evaluate(candles) {
  const code    = AppState.activeCode || '';
  const signals = (AppState.signals?.[code] || []).filter(s => s && s.id);

  // ── 五燈計算 ──
  const closes  = candles.map(c => c.close);
  let difPos = true;
  try {
    const { dif } = calcMACD(closes);
    const n = dif?.length ?? 0;
    if (n > 0 && Number.isFinite(dif[n - 1])) difPos = dif[n - 1] > 0;
  } catch(_) {}

  const lamps = calcSignalLamps(signals, difPos);

  // ── 分流多空訊號 ──
  const bullSignals = signals.filter(s => !WARNING_IDS.has(s.id)).slice(0, 4);
  const warnSignals = signals.filter(s =>  WARNING_IDS.has(s.id)).slice(0, 3);

  // ── 策略標籤（最多4個，優先顯示非避險）──
  const tagSet = new Set();
  for (const s of signals) {
    const st = STRATEGIES.find(st => st.id === s.id);
    if (st?.category && !WARN_CATEGORIES.has(st.category) && tagSet.size < 3) tagSet.add(st.category);
  }

  // ── 波段位置判斷 ──
  const phase = _calcPhase(candles, signals, lamps);

  // ── 關鍵槓桿點 ──
  const leverage = _calcLeverage(signals, phase, candles);

  // ── 四維健康度 ──
  const health = _calcHealth(candles, signals, lamps);

  // ── 支撐壓力 ──
  const sr = _getSR(candles);

  // ── USP 句 ──
  const usp = _buildUSP(signals, lamps, phase);

  // ── 燈燈敘事 ──
  const narrative = _buildNarrative(signals, lamps, phase, health, sr, candles);

  return {
    code, lamps, bullSignals, warnSignals,
    tags: [...tagSet],
    phase, leverage, health, sr, usp, narrative,
    signal: { lamps },
  };
}

// ── 波段位置判斷 ──────────────────────────────────────────────────────────
function _calcPhase(candles, signals, lamps) {
  const n      = candles.length;
  const last   = candles[n - 1];
  const closes = candles.map(c => c.close);

  // RSI
  let rsiVal = 50;
  try {
    const rsiArr = calcRSI(closes, 14);
    rsiVal = rsiArr[rsiArr.length - 1] ?? 50;
  } catch(_) {}

  // MA20 乖離
  const ma20Arr = closes.slice(-20);
  const ma20    = ma20Arr.reduce((a, b) => a + b, 0) / ma20Arr.length;
  const bias    = ((last.close - ma20) / ma20) * 100;

  // 量比（近5日均量 / 近20日均量）
  const vol5  = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
  const vol20 = candles.slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1;

  const sigIds = new Set(signals.map(s => s.id));

  // 判斷
  if (volRatio < 0.7 && Math.abs(bias) < 5 && Math.abs(lamps) <= 1) {
    return { key: 'accumulate', name: '蓄積', sub: '量縮整理，等待方向', color: C_AMBER };
  }
  if (rsiVal > 78 && bias > 10) {
    return { key: 'overheat', name: '過熱', sub: 'RSI 鈍化，乖離擴大', color: C_BEAR };
  }
  if (lamps < -1.5) {
    return { key: 'correction', name: '修正', sub: '量縮回測，找支撐', color: C_BEAR };
  }
  if (lamps >= 2.5 && bias > 3) {
    return { key: 'markup', name: '主升', sub: '趨勢確立，法人追買', color: C_BULL };
  }
  if ((sigIds.has('S20') || sigIds.has('S10') || sigIds.has('S32') || sigIds.has('S36')) && lamps >= 1) {
    return { key: 'breakout', name: '啟動', sub: '突破訊號，量能放大', color: C_BULL };
  }
  if (lamps >= 1) {
    return { key: 'breakout', name: '啟動', sub: '訊號浮現，觀察確認', color: C_BULL };
  }
  return { key: 'correction', name: '修正', sub: '多空不明，保守應對', color: C_AMBER };
}

// ── 關鍵槓桿點 ────────────────────────────────────────────────────────────
function _calcLeverage(signals, phase, candles) {
  if (!signals.length) return '目前無明確訊號，建議觀望';

  const sigIds = new Set(signals.map(s => s.id));

  if (sigIds.has('S_ICHI_3GOOD')) return '三役好轉確認，是本波最強多頭結構訊號';
  if (sigIds.has('S17'))          return '外資連買持續流入，是本波上漲最重要的資金支撐';
  if (sigIds.has('X2'))           return '天黑請閉眼啟動，飆股加速段介入，賭報酬需嚴格停損';
  if (sigIds.has('X5'))           return '爆量建倉早期訊號，比主升段早5–10日的介入機會';
  if (sigIds.has('S11'))          return 'KD + MACD 雙黃金交叉站上月線，三重確認強力買點';
  if (sigIds.has('S13'))          return '箱型突破放量，盤整蓄積的方向性爆發';
  if (sigIds.has('W10'))          return 'KD + MACD 雙死叉跌破月線，趨勢全面轉弱，高度警示';
  if (sigIds.has('W11'))          return '跌破一目雲層，中長線最強空頭確認訊號';
  if (sigIds.has('W2'))           return 'KD + MACD 同時死叉，多空力道快速反轉';

  // 依波段位置給通用說法
  const top = signals[0];
  const st  = STRATEGIES.find(s => s.id === top?.id);
  if (st) return `${st.name}觸發——${st.desc}`;

  return '多個訊號共振，結構方向明確';
}

// ── 四維健康度 ────────────────────────────────────────────────────────────
function _calcHealth(candles, signals, lamps) {
  const n      = candles.length;
  const closes = candles.map(c => c.close);
  const last   = candles[n - 1];

  // 技術結構（燈號為主）
  const techScore  = Math.min(100, Math.max(0, 50 + lamps * 10));
  const techLabel  = lamps >= 2 ? '強勢' : lamps >= 0.5 ? '偏強' : lamps <= -2 ? '弱勢' : lamps <= -0.5 ? '偏弱' : '中性';
  const techColor  = lamps >= 1 ? C_BULL : lamps <= -1 ? C_BEAR : C_AMBER;

  // 籌碼動能（法人訊號）
  const sigIds = new Set(signals.map(s => s.id));
  let chipScore = 50;
  let chipLabel = '中性';
  let chipColor = C_AMBER;
  if (sigIds.has('S17')) { chipScore = 80; chipLabel = '法人進場'; chipColor = C_BULL; }
  else if (sigIds.has('W13')) { chipScore = 25; chipLabel = '量增價跌'; chipColor = C_BEAR; }
  else if (lamps >= 2) { chipScore = 65; chipLabel = '偏多'; chipColor = C_BULL; }
  else if (lamps <= -2) { chipScore = 30; chipLabel = '偏空'; chipColor = C_BEAR; }

  // 估值空間（MA20 乖離）
  const ma20    = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const bias    = ((last.close - ma20) / ma20) * 100;
  let valScore  = Math.max(0, Math.min(100, 70 - bias * 2));
  let valLabel  = bias > 10 ? '偏高' : bias > 5 ? '略高' : bias < -10 ? '超跌' : bias < -5 ? '偏低' : '合理';
  let valColor  = bias > 8 ? C_AMBER : bias > 15 ? C_BEAR : bias < -8 ? C_BULL : C_BULL;

  // 短線風險（RSI）
  let rsiVal = 50;
  try {
    const rsiArr = calcRSI(closes, 14);
    rsiVal = rsiArr[rsiArr.length - 1] ?? 50;
  } catch(_) {}
  const riskScore = Math.max(0, Math.min(100, rsiVal));
  const riskLabel = rsiVal > 80 ? 'RSI 過熱' : rsiVal > 70 ? 'RSI 偏高' : rsiVal < 30 ? 'RSI 超賣' : rsiVal < 40 ? 'RSI 偏低' : '風險適中';
  const riskColor = rsiVal > 75 ? C_BEAR : rsiVal < 35 ? C_BULL : C_AMBER;

  return [
    { label: '技術結構', val: techLabel,  score: techScore,  color: techColor  },
    { label: '籌碼動能', val: chipLabel,  score: chipScore,  color: chipColor  },
    { label: '估值空間', val: valLabel,   score: valScore,   color: valColor   },
    { label: '短線風險', val: riskLabel,  score: riskScore,  color: riskColor  },
  ];
}

// ── 支撐壓力 ──────────────────────────────────────────────────────────────
function _getSR(candles) {
  const r = window.__srData;
  const last = candles[candles.length - 1]?.close ?? 0;

  const res = r?.resistance?.items?.[0]?.price ?? null;
  const sup = r?.support?.items?.[0]?.price    ?? null;

  const resNote = r?.resistance?.items?.[0]?.label ?? (res ? '壓力位' : '—');
  const supNote = r?.support?.items?.[0]?.label    ?? (sup ? '支撐位' : '—');

  const resDist = res && last ? (((res - last) / last) * 100).toFixed(1) : null;
  const supDist = sup && last ? (((last - sup) / last) * 100).toFixed(1) : null;

  return { res, sup, resNote, supNote, resDist, supDist, cur: last };
}

// ── USP 句 ────────────────────────────────────────────────────────────────
function _buildUSP(signals, lamps, phase) {
  if (!signals.length) return '目前無明確訊號，維持觀望';

  const sigIds = new Set(signals.map(s => s.id));

  if (sigIds.has('S_ICHI_3GOOD') && sigIds.has('S17'))
    return '外資進場 + 三役好轉，多頭結構最強確認';
  if (sigIds.has('X2'))
    return '飆股加速段，天黑請閉眼介入——賭高 beta 報酬';
  if (sigIds.has('X5') && sigIds.has('S17'))
    return '爆量 + 法人進場，主升段前的最佳佈局時機';
  if (sigIds.has('S11'))
    return 'KD + MACD 雙黃金交叉，三重確認強力買點';
  if (sigIds.has('W10'))
    return '三重弱勢確認，全面轉空，不適合做多';
  if (sigIds.has('W11'))
    return '跌破一目雲層，中長線空頭確立，避險優先';

  if (lamps >= 3)  return '多頭訊號高度共振，趨勢強勢延伸中';
  if (lamps >= 1.5) return phase.name + '段確認，訊號持續累積中';
  if (lamps <= -3)  return '空頭訊號全面壓制，建議減碼或避險';
  if (lamps <= -1.5) return '弱勢結構形成，持股風險提升';

  return '多空訊號混合，方向尚不明確';
}

// ── 燈燈敘事 ──────────────────────────────────────────────────────────────
function _buildNarrative(signals, lamps, phase, health, sr, candles) {
  const sigIds  = new Set(signals.map(s => s.id));
  const last    = candles[candles.length - 1]?.close ?? 0;
  const verdict = lamps >= 1.5 ? 'buy' : lamps <= -1.5 ? 'hedge' : 'watch';

  let text = '';
  let verdictLabel = '';
  let verdictClass = '';
  let slText = '';

  // 主體敘事
  if (sigIds.has('X2')) {
    text = '飆股加速段，主力續攻訊號明確。這種行情追高有道理，但停損要鐵紀律——RSI 一旦頂背離或量縮就是訊號。';
  } else if (sigIds.has('W10') || sigIds.has('W11')) {
    text = '技術面全面轉弱，多頭結構已破。現在的問題不是「要不要買」，而是「手上的還要不要留」。趨勢未翻多前，減碼優先。';
  } else if (lamps >= 2.5) {
    const topReason = signals.filter(s => !WARNING_IDS.has(s.id))[0];
    const st = STRATEGIES.find(s => s.id === topReason?.id);
    text = `結構是多頭，${st ? st.name : '訊號'}是主要依據。${health[2].val === '偏高' || health[2].val === '略高' ? '不過估值偏高，追高要有心理準備接受短線回測。' : '現在進場賠率尚可，依計畫執行。'}`;
  } else if (lamps >= 1) {
    text = `訊號在啟動中，但尚未全面確認。可以小量試單觀察，不要重壓。${phase.key === 'accumulate' ? '整理期入場是好策略，但方向還沒確認前倉位要輕。' : ''}`;
  } else if (lamps <= -2) {
    text = '空頭訊號持續壓制，這時候做多是逆勢。如果是持股，考慮停損或減碼；如果還沒進場，等訊號翻多再說。';
  } else {
    text = '多空訊號混合，方向不明。這種時候最好的策略是等——等一個更清楚的進場訊號，不要因為閒著就下單。';
  }

  // 決策
  if (verdict === 'buy') {
    verdictLabel = '可試單';
    verdictClass = 'vp-buy';
    if (sr.sup) {
      const stopLoss = (sr.sup * 0.99).toFixed(0);
      slText = `停損 ${stopLoss}${sr.res ? `｜目標 ${sr.res}` : ''}`;
    }
  } else if (verdict === 'hedge') {
    verdictLabel = '避險優先';
    verdictClass = 'vp-hedge';
    slText = '建議減碼，等訊號翻多';
  } else {
    verdictLabel = '觀望';
    verdictClass = 'vp-watch';
    slText = '等方向確認再進場';
  }

  return { text, verdictLabel, verdictClass, slText };
}

// ── 三階段行動計畫 ────────────────────────────────────────────────────────
function _buildPipeline(lamps, sr, candles) {
  const last = candles[candles.length - 1]?.close ?? 0;
  const sup  = sr.sup ?? (last * 0.95);
  const res  = sr.res ?? (last * 1.05);

  if (lamps >= 1) {
    return [
      { num: 1, title: '試單佈局',   desc: `現價 ${last.toFixed(0)} 附近，2成倉建立觀察位`, state: 'act' },
      { num: 2, title: '回踩確認',   desc: `拉回支撐 ${sup.toFixed(0)} 量縮止跌後加至5成`,   state: 'wait' },
      { num: 3, title: '突破加碼',   desc: `突破壓力 ${res.toFixed(0)} 放量確認加至8成`,      state: 'wait' },
    ];
  } else if (lamps <= -1.5) {
    return [
      { num: 1, title: '降低倉位',   desc: '反彈至壓力帶時分批減碼',                          state: 'act' },
      { num: 2, title: '設停損點',   desc: `跌破 ${sup.toFixed(0)} 立即出場，不等待`,          state: 'act' },
      { num: 3, title: '等待翻多',   desc: '訊號轉正後再重新評估進場',                          state: 'wait' },
    ];
  } else {
    return [
      { num: 1, title: '持續觀察',   desc: '等待方向確認，不急於進場',                          state: 'act' },
      { num: 2, title: '設定條件',   desc: `突破 ${res.toFixed(0)} 或跌破 ${sup.toFixed(0)} 再行動`, state: 'wait' },
      { num: 3, title: '依訊號行動', desc: '多頭訊號 → 試單，空頭訊號 → 觀望',                  state: 'wait' },
    ];
  }
}

// ============================================================================
// renderFull — 完整 HTML
// ============================================================================

function renderFull(ev) {
  const { code, lamps, bullSignals, warnSignals, tags, phase, leverage, health, sr, usp, narrative } = ev;
  const candles  = AppState.lastCandles || [];
  const pipeline = _buildPipeline(lamps, sr, candles);

  const lampCount = Math.abs(lamps);
  const lampDir   = lamps > 0 ? 'bull' : lamps < 0 ? 'bear' : 'neu';
  const lampColor = lamps > 0 ? C_BULL : lamps < 0 ? C_BEAR : '#8a8f99';

  // 五燈泡 HTML
  const lampsHtml = (() => {
    const full = Math.floor(lampCount);
    const half = lampCount - full >= 0.4 ? 1 : 0;
    const empty = 5 - full - half;
    const bulb = (cls) => `<span class="pv-lamp ${cls}"></span>`;
    return Array(full).fill(bulb('on ' + lampDir)).join('')
      + (half ? bulb('half ' + lampDir) : '')
      + Array(empty).fill(bulb('off')).join('');
  })();

  // 策略 tags
  const tagsHtml = tags.map(t => `<span class="pv-tag pv-tag-bull">${t}</span>`).join('')
    + (warnSignals.length ? `<span class="pv-tag pv-tag-bear">避險警示 ${warnSignals.length} 個</span>` : '');

  // 波段位置
  const phases = ['蓄積','啟動','主升','過熱','修正'];
  const phaseHtml = phases.map(p => {
    const isActive = p === phase.name;
    return `<div class="pv-phase ${isActive ? 'active' : ''}">
      <div class="pv-phase-dot"></div>
      <div class="pv-phase-name">${p}</div>
    </div>`;
  }).join('');

  // 健康度
  const healthHtml = health.map(h => `
    <div class="pv-health-item">
      <div class="pv-health-label">${h.label}</div>
      <div class="pv-health-val" style="color:${h.color}">${h.val}</div>
      <div class="pv-health-bar"><div class="pv-health-fill" style="width:${h.score}%;background:${h.color}"></div></div>
    </div>`).join('');

  // 買進/避險對立
  const bullHtml = bullSignals.map(s => {
    const st = STRATEGIES.find(st => st.id === s.id);
    return `<div class="pv-vs-item">
      <div class="pv-vs-dot bull"></div>
      <div><span class="pv-vs-name">${st?.name ?? s.id}</span><br>${st?.desc ?? ''}</div>
    </div>`;
  }).join('') || '<div class="pv-vs-empty">無明確買進訊號</div>';

  const warnHtml = warnSignals.map(s => {
    const st = STRATEGIES.find(st => st.id === s.id);
    return `<div class="pv-vs-item">
      <div class="pv-vs-dot warn"></div>
      <div><span class="pv-vs-name">${st?.name ?? s.id}</span><br>${st?.desc ?? ''}</div>
    </div>`;
  }).join('') || '<div class="pv-vs-empty">無明確避險訊號</div>';

  // 市場訂價
  const priceHtml = `
    <div class="pv-price-item res">
      <div class="pv-price-label">壓力（訂價上限）</div>
      <div class="pv-price-val" style="color:${C_BULL}">${sr.res ? sr.res.toFixed(0) : '—'}</div>
      <div class="pv-price-note">${sr.resNote}${sr.resDist ? `　距現價 +${sr.resDist}%` : ''}</div>
    </div>
    <div class="pv-price-item cur">
      <div class="pv-price-label">現價</div>
      <div class="pv-price-val">${sr.cur ? sr.cur.toFixed(0) : '—'}</div>
      <div class="pv-price-note">今日收盤</div>
    </div>
    <div class="pv-price-item sup">
      <div class="pv-price-label">支撐（停損基準）</div>
      <div class="pv-price-val" style="color:${C_BEAR}">${sr.sup ? sr.sup.toFixed(0) : '—'}</div>
      <div class="pv-price-note">${sr.supNote}${sr.supDist ? `　距現價 -${sr.supDist}%` : ''}</div>
    </div>`;

  // 行動計畫
  const pipelineHtml = pipeline.map(p => `
    <div class="pv-step">
      <div class="pv-step-num ${p.state}">${p.num}</div>
      <div class="pv-step-body">
        <div class="pv-step-title">${p.title}</div>
        <div class="pv-step-desc">${p.desc}</div>
      </div>
      <div class="pv-step-badge ${p.state}">${p.state === 'act' ? '執行' : '等待'}</div>
    </div>`).join('');

  return `
<style>
.pv-wrap{display:flex;flex-direction:column;gap:10px;padding:4px 0}
.pv-card{background:var(--card-bg,#161b22);border:0.5px solid rgba(255,255,255,0.07);border-radius:10px;padding:14px 16px}
.pv-sec-label{font-size:10px;font-weight:500;letter-spacing:.07em;color:#8a8f99;text-transform:uppercase;margin-bottom:8px}

.pv-usp-header{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.pv-usp-left{flex:1}
.pv-usp-code{font-size:18px;font-weight:500;color:#e8eaed}
.pv-usp-name{font-size:12px;color:#8a8f99;margin-top:2px}
.pv-lamps-wrap{display:flex;gap:3px;align-items:center}
.pv-lamp{width:11px;height:11px;border-radius:50%}
.pv-lamp.off{background:rgba(255,255,255,0.1)}
.pv-lamp.on.bull{background:${C_BULL}}
.pv-lamp.on.bear{background:${C_BEAR}}
.pv-lamp.half.bull{background:linear-gradient(90deg,${C_BULL} 50%,rgba(255,255,255,0.1) 50%)}
.pv-lamp.half.bear{background:linear-gradient(90deg,${C_BEAR} 50%,rgba(255,255,255,0.1) 50%)}
.pv-lamp-val{font-size:11px;color:#8a8f99;margin-left:4px}
.pv-usp-sentence{font-size:14px;font-weight:500;color:#e8eaed;line-height:1.5;border-left:3px solid ${lampColor};padding-left:10px;margin-bottom:10px}
.pv-tags{display:flex;flex-wrap:wrap;gap:5px}
.pv-tag{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
.pv-tag-bull{background:rgba(239,83,80,.1);color:${C_BULL};border:0.5px solid rgba(239,83,80,.25)}
.pv-tag-bear{background:rgba(38,166,154,.1);color:${C_BEAR};border:0.5px solid rgba(38,166,154,.25)}
.pv-tag-neu{background:rgba(255,255,255,.06);color:#8a8f99;border:0.5px solid rgba(255,255,255,.1)}

.pv-phase-row{display:flex;gap:5px;margin-bottom:10px}
.pv-phase{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 3px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03)}
.pv-phase.active{border-color:rgba(239,83,80,.4);background:rgba(239,83,80,.08)}
.pv-phase-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.15)}
.pv-phase.active .pv-phase-dot{background:${C_BULL}}
.pv-phase-name{font-size:11px;color:#8a8f99;font-weight:500}
.pv-phase.active .pv-phase-name{color:${C_BULL}}

.pv-leverage{background:rgba(245,158,11,.06);border:0.5px solid rgba(245,158,11,.25);border-radius:6px;padding:10px 12px;display:flex;gap:8px;align-items:flex-start}
.pv-lev-label{font-size:10px;color:${C_AMBER};font-weight:500;margin-bottom:3px}
.pv-lev-text{font-size:12px;color:#e8eaed;line-height:1.5;font-weight:500}

.pv-health-row{display:flex;gap:7px;margin-bottom:10px}
.pv-health-item{flex:1;background:rgba(255,255,255,.03);border-radius:6px;padding:7px 8px;border:0.5px solid rgba(255,255,255,.06)}
.pv-health-label{font-size:10px;color:#8a8f99;margin-bottom:3px}
.pv-health-val{font-size:12px;font-weight:500;margin-bottom:4px}
.pv-health-bar{height:3px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden}
.pv-health-fill{height:100%;border-radius:2px}

.pv-vs-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pv-vs-col{display:flex;flex-direction:column;gap:5px}
.pv-vs-title{font-size:11px;font-weight:500;margin-bottom:2px}
.pv-vs-title.bull{color:${C_BULL}}
.pv-vs-title.warn{color:${C_BEAR}}
.pv-vs-item{display:flex;align-items:flex-start;gap:6px;font-size:11px;color:#8a8f99;line-height:1.4}
.pv-vs-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;margin-top:4px}
.pv-vs-dot.bull{background:${C_BULL}}
.pv-vs-dot.warn{background:${C_BEAR}}
.pv-vs-name{font-weight:500;color:#e8eaed}
.pv-vs-empty{font-size:11px;color:rgba(255,255,255,0.2);padding:4px 0}

.pv-price-row{display:flex;gap:7px}
.pv-price-item{flex:1;border-radius:6px;padding:8px 10px;border:0.5px solid rgba(255,255,255,.07)}
.pv-price-item.res{background:rgba(239,83,80,.05);border-color:rgba(239,83,80,.2)}
.pv-price-item.sup{background:rgba(38,166,154,.05);border-color:rgba(38,166,154,.2)}
.pv-price-item.cur{background:rgba(255,255,255,.03)}
.pv-price-label{font-size:10px;color:#8a8f99;margin-bottom:3px}
.pv-price-val{font-size:15px;font-weight:500;color:#e8eaed}
.pv-price-note{font-size:10px;color:#8a8f99;margin-top:2px}

.pv-pipeline{display:flex;flex-direction:column;gap:7px}
.pv-step{display:flex;align-items:center;gap:10px}
.pv-step-num{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;flex-shrink:0}
.pv-step-num.act{background:rgba(239,83,80,.15);color:${C_BULL};border:1px solid rgba(239,83,80,.35)}
.pv-step-num.wait{background:rgba(255,255,255,.05);color:#8a8f99;border:0.5px solid rgba(255,255,255,.1)}
.pv-step-body{flex:1}
.pv-step-title{font-size:12px;font-weight:500;color:#e8eaed}
.pv-step-desc{font-size:11px;color:#8a8f99;margin-top:1px}
.pv-step-badge{font-size:10px;padding:2px 8px;border-radius:4px}
.pv-step-badge.act{background:rgba(239,83,80,.12);color:${C_BULL}}
.pv-step-badge.wait{background:rgba(255,255,255,.05);color:#8a8f99}

.pv-deng-wrap{display:flex;gap:10px;align-items:flex-start}
.pv-deng-av{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.07);border:0.5px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.pv-deng-bub{background:rgba(255,255,255,.04);border:0.5px solid rgba(255,255,255,.08);border-radius:0 10px 10px 10px;padding:10px 12px;flex:1}
.pv-deng-line{font-size:13px;color:#e8eaed;line-height:1.65}
.pv-deng-footer{margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pv-vp{font-size:11px;font-weight:500;padding:3px 10px;border-radius:20px}
.vp-buy{background:rgba(239,83,80,.12);color:${C_BULL};border:0.5px solid rgba(239,83,80,.3)}
.vp-hedge{background:rgba(38,166,154,.12);color:${C_BEAR};border:0.5px solid rgba(38,166,154,.3)}
.vp-watch{background:rgba(245,158,11,.12);color:${C_AMBER};border:0.5px solid rgba(245,158,11,.3)}
.pv-sl{font-size:11px;color:#8a8f99}
</style>

<div class="pv-wrap">

  <div class="pv-card">
    <div class="pv-sec-label">Strategy — 為什麼看這檔</div>
    <div class="pv-usp-header">
      <div class="pv-usp-left">
        <div class="pv-usp-code">${code}</div>
      </div>
      <div class="pv-lamps-wrap">
        ${lampsHtml}
        <span class="pv-lamp-val">${lamps > 0 ? '+' : ''}${lamps}燈</span>
      </div>
    </div>
    <div class="pv-usp-sentence">${usp}</div>
    <div class="pv-tags">${tagsHtml}</div>
  </div>

  <div class="pv-card">
    <div class="pv-sec-label">波段位置 — 現在在哪裡</div>
    <div class="pv-phase-row">${phaseHtml}</div>
    <div class="pv-leverage">
      <div style="font-size:14px;flex-shrink:0;margin-top:1px">⚡</div>
      <div>
        <div class="pv-lev-label">關鍵槓桿點</div>
        <div class="pv-lev-text">${leverage}</div>
      </div>
    </div>
  </div>

  <div class="pv-card">
    <div class="pv-sec-label">Diagnosis — 個股損益表</div>
    <div class="pv-health-row">${healthHtml}</div>
    <div class="pv-vs-grid">
      <div class="pv-vs-col">
        <div class="pv-vs-title bull">買進理由</div>
        ${bullHtml}
      </div>
      <div class="pv-vs-col">
        <div class="pv-vs-title warn">避險理由</div>
        ${warnHtml}
      </div>
    </div>
  </div>

  <div class="pv-card">
    <div class="pv-sec-label">市場訂價 — 願付空間</div>
    <div class="pv-price-row">${priceHtml}</div>
  </div>

  <div class="pv-card">
    <div class="pv-sec-label">Decision — 行動計畫</div>
    <div class="pv-pipeline">${pipelineHtml}</div>
  </div>

  <div class="pv-card">
    <div class="pv-sec-label">燈燈說</div>
    <div class="pv-deng-wrap">
      <div class="pv-deng-av">🐱</div>
      <div class="pv-deng-bub">
        <div class="pv-deng-line">${narrative.text}</div>
        <div class="pv-deng-footer">
          <span class="pv-vp ${narrative.verdictClass}">${narrative.verdictLabel}</span>
          <span class="pv-sl">${narrative.slText}</span>
        </div>
      </div>
    </div>
  </div>

</div>`;
}

// ============================================================================
// renderBadge — mini chip
// ============================================================================

function renderBadge(ev, id) {
  const { lamps } = ev;
  const color = lamps > 0 ? C_BULL : lamps < 0 ? C_BEAR : '#8a8f99';
  const label = lamps > 0 ? `+${lamps}燈` : lamps < 0 ? `${lamps}燈` : '中性';
  return `<span class="fs-mini-badge" data-mod="${id}" style="border-color:${color};color:${color}">
    👁 觀點 ${label}
  </span>`;
}

// ============================================================================
// 註冊模組
// ============================================================================

registerAnalysisModule({
  id:           'perspective',
  name:         '觀點',
  icon:         '👁',
  candleMinLen: 30,
  evaluate,
  renderFull,
  renderBadge,
});
