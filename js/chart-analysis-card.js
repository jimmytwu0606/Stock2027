// js/chart-analysis-card.js
// ============================================================================
// Phase 7 — 智能分析卡片 UI
// ============================================================================
// 對外 API:
//   initAnalysisCard({ containerSelector, getCandles, getCode })
//   renderAnalysisPanel(stockCode)
//   refreshAnalysis()
// ============================================================================

import { analyze, detectFakeBreakout, analyzeEntryPlan, findSimilarPatterns, backtestSRAccuracy, stressTest, calcTimeAlerts } from './chart-analysis.js';
// Phase 7.2 — 背離偵測 + 燈號疊圖觸發
import { detectDivergences, renderSignalLayer, getActiveSignal } from './chart-signal-overlay.js';
import { dengToast } from './loading-deng.js';
import { calcHealth, calcHealthLong } from './health.js';
import { calcHealthWithSignals } from './stock-tabs.js';

let ctxRefs = null;
let containerEl = null;
let lastResult = null;
let lastCode = null;
let io = null;
let pendingComputeCode = null;

export function initAnalysisCard({ containerSelector, getCandles, getCode }) {
  ctxRefs = { getCandles, getCode };
  containerEl = typeof containerSelector === 'string'
    ? document.querySelector(containerSelector)
    : containerSelector;
  if (!containerEl) {
    console.warn('[chart-analysis-card] container not found:', containerSelector);
    return;
  }
  containerEl.classList.add('ca-panel');
  containerEl.innerHTML = `<div class="ca-empty">選擇個股後將自動產生智能分析</div>`;

  io = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      if (ent.isIntersecting && pendingComputeCode) {
        _doCompute();
      }
    }
  }, { threshold: 0.05 });
  io.observe(containerEl);
}

export function renderAnalysisPanel(code) {
  if (!containerEl) return;
  pendingComputeCode = code;
  lastCode = code;
  const rect = containerEl.getBoundingClientRect();
  const inView = rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0;
  if (inView) _doCompute();
  else {
    containerEl.innerHTML = `<div class="ca-empty">切換到「智能分析」分頁可看 ${code} 的分析</div>`;
  }
}

export function getLastAnalysisResult() { return lastResult; }

export function refreshAnalysis() {
  if (lastCode) _doCompute();
}

function _doCompute() {
  if (!ctxRefs) return;
  const candles = ctxRefs.getCandles?.() || [];
  if (!candles.length) {
    containerEl.innerHTML = `<div class="ca-empty">尚無 K 線資料</div>`;
    return;
  }
  try {
    lastResult = analyze(candles);
    _renderPanel(lastResult);
    pendingComputeCode = null;
  } catch (e) {
    console.error('[chart-analysis-card] analyze failed', e);
    containerEl.innerHTML = `<div class="ca-empty">分析失敗:${e.message}</div>`;
  }
}

// ============================================================================
// 渲染
// ============================================================================
function _renderPanel(r) {
  if (!r || r.empty) {
    containerEl.innerHTML = `<div class="ca-empty">${r?.reason || '無分析結果'}</div>`;
    return;
  }
  const candles = ctxRefs.getCandles?.() || [];
  const sections = [];

  // ── 雙健康度（最頂部）──
  if (candles.length >= 20) {
    const code = ctxRefs.getCode?.() ?? '';
    sections.push(_sectionDualHealth(candles, code));
  }

  sections.push(_sectionSupportResistance(r.support, r.resistance, r.srAdvice));
  sections.push(_sectionBox(r.box));
  sections.push(_sectionTrend(r.trend));
  sections.push(_sectionVolumePrice(r.volumePrice));
  // Phase 7.2:背離偵測區塊
  if (candles.length >= 30) {
    sections.push(_sectionDivergence(candles));
  }
  // Phase 7.5 C — 假突破
  const fakeBreakout = detectFakeBreakout(candles, r.resistance);
  if (fakeBreakout.detected) sections.push(_sectionFakeBreakout(fakeBreakout));

  // Phase 7.5 D — 分批進場計畫
  const entryPlan = analyzeEntryPlan(r);
  if (entryPlan) sections.push(_sectionEntryPlan(entryPlan));

  // Phase 7.5+ — 歷史型態搜尋
  if (candles.length >= 50) {
    const patterns = findSimilarPatterns(candles);
    sections.push(_sectionPatterns(patterns));
  }

  // Phase 7.5+ — 歷史準確度回測
  const srAccuracy = backtestSRAccuracy(candles, r.support, r.resistance);
  if (srAccuracy) sections.push(_sectionSRAccuracy(srAccuracy));

  // Phase 7.5+ — 壓力測試
  const stress = stressTest(candles);
  if (stress) sections.push(_sectionStressTest(stress));

  // Phase 7.5+ — 時間警報(事件由外部 data-events 屬性傳入)
  const eventsRaw = containerEl.dataset.events;
  if (eventsRaw) {
    try {
      const events = calcTimeAlerts(JSON.parse(eventsRaw));
      if (events.length) sections.push(_sectionTimeAlerts(events));
    } catch {}
  }

  containerEl.innerHTML = sections.join('');
  _bindSectionToggles();
}

// ── 雙健康度區塊 ─────────────────────────────────────────
function _sectionDualHealth(candles, code = '') {
  const short = calcHealthWithSignals(candles, code);  // v2.8 含 X 系列加成
  const long  = calcHealthLong(candles);  // 基本面需另外取，此處純技術面版本

  const _bar = (val) => {
    if (val == null) return `<span class="ca-health-na">資料不足</span>`;
    const cls = val >= 80 ? 'strong' : val >= 60 ? 'mid-strong' : val >= 40 ? 'neutral' : val >= 20 ? 'mid-weak' : 'weak';
    const label = val >= 80 ? '強勢' : val >= 60 ? '偏強' : val >= 40 ? '中性' : val >= 20 ? '偏弱' : '弱勢';
    return `
      <div class="ca-dh-row">
        <div class="ca-bar"><div class="ca-bar-fill ${cls}" style="width:${val}%"></div></div>
        <span class="ca-dh-score ${cls}">${val}</span>
        <span class="ca-dh-label">${label}</span>
      </div>`;
  };

  // 綜合判斷文字
  let advice = '';
  if (short != null && long != null) {
    if (short >= 65 && long >= 65)       advice = '短長線同步強勢，可積極操作';
    else if (short >= 65 && long < 50)   advice = '短線動能強，但長線結構待修復，適合短打不宜重押';
    else if (short < 50 && long >= 65)   advice = '長線結構健康，短線暫時弱勢，可逢低布局';
    else if (short >= 50 && long >= 50)  advice = '短長線均屬中性，觀望為主';
    else if (short < 40 || long < 40)    advice = '短線或長線出現弱勢訊號，謹慎操作';
  }

  const longNote = candles.length < 120
    ? '<div class="ca-dh-note">⚠ K線根數不足，長線評分僅供參考（建議切換 1年或更長週期）</div>'
    : '';

  return `
    <div class="ca-section ca-section-health expanded" data-section="dual-health">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">💊</span>健康度評分</div>
        <div>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        ${longNote}
        <div class="ca-dh-grid">
          <div class="ca-dh-item">
            <div class="ca-dh-name">📊 短線健康度</div>
            <div class="ca-dh-sub">隔日衝・波段短打參考</div>
            ${_bar(short)}
          </div>
          <div class="ca-dh-item">
            <div class="ca-dh-name">🏔 長線健康度</div>
            <div class="ca-dh-sub">中長線布局・存股參考</div>
            ${_bar(long)}
          </div>
        </div>
        ${advice ? `<div class="ca-dh-advice">💡 ${advice}</div>` : ''}
      </div>
    </div>
  `;
}

function _sectionSupportResistance(support, resist, srAdvice) {
  if (!support && !resist) return '';

  const _renderLevel = (s, i, isResist) => {
    // B3: 把 history 從 reasons 抽出來,獨立呈現
    const histLine = (s.history && s.history.tests > 0)
      ? `<div class="ca-history">📜 ${_buildHistoryHTML(s.history, isResist)}</div>`
      : '';
    const cls = isResist ? 'ca-resist' : 'ca-support';
    const sign = isResist ? '+' : '-';
    return `
      <div class="ca-item" data-expandable="1">
        <div class="ca-item-row">
          <span class="ca-item-label">${isResist ? '壓力' : '支撐'} ${i + 1}</span>
          <span class="ca-item-value ${cls}">
            $${s.price} <small>(${sign}${s.distance}%)</small>
            ${_stars(s.strength)}
          </span>
          <span class="ca-why">為什麼?</span>
        </div>
        <div class="ca-explain">
          <div class="ca-source-line">來源:${s.sources.join(' / ')}</div>
          ${(s.reasons || []).filter(x => !x.startsWith('過去測試')).map(x => '• ' + x).join('<br>')}
          ${histLine}
        </div>
      </div>
    `;
  };

  const sItems = (support?.items || []).map((s, i) => _renderLevel(s, i, false)).join('');
  const rItems = (resist?.items  || []).map((s, i) => _renderLevel(s, i, true)).join('');
  const summary = `${(support?.items?.length || 0)} 個支撐 / ${(resist?.items?.length || 0)} 個壓力`;

  // B4: 怎麼操作
  const adviceBlock = (srAdvice && srAdvice.length)
    ? `<div class="ca-advice"><div class="ca-advice-title">💡 怎麼操作</div>${
        srAdvice.map(a => `<div class="ca-advice-line">• ${a}</div>`).join('')
      }</div>`
    : '';

  return `
    <div class="ca-section expanded" data-section="sr">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">🎯</span>支撐 / 壓力</div>
        <div>
          <span class="ca-section-summary">${summary}</span>
          <button class="ca-copy-btn" data-copy-section="sr" title="複製整段文字">📋</button>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        ${sItems || '<div class="ca-empty">下方無顯著支撐</div>'}
        ${rItems || '<div class="ca-empty">上方無顯著壓力</div>'}
        ${adviceBlock}
      </div>
    </div>
  `;
}

// B3: history 物件 → HTML
function _buildHistoryHTML(h, isResist) {
  if (!h || h.tests === 0) return '';
  const word = isResist ? '突破' : '跌破';
  let html = `過去測試 <b>${h.tests}</b> 次,守住 <b class="ca-support">${h.held}</b> 次,${word} <b class="ca-resist">${h.broken}</b> 次`;
  // 計算成功率
  if (h.tests >= 2) {
    const holdRate = Math.round((h.held / h.tests) * 100);
    html += `(守住率 ${holdRate}%)`;
  }
  return html;
}

function _sectionBox(box) {
  if (!box) return '';
  const positionText = {
    near_upper: '🔺 接近上緣',
    near_lower: '🔻 接近下緣',
    middle:     '⚪ 位於中段',
  }[box.position] || '';
  const summary = box.isBox
    ? `${box.lower} ~ ${box.upper}(${box.rangePct}%)`
    : (box.skipped ? '此週期不適用' : '非典型箱型');

  // 跳過的週期(5d)就只給空殼
  if (box.skipped) {
    return `
      <div class="ca-section" data-section="box">
        <div class="ca-section-header">
          <div class="ca-section-title"><span class="ca-icon">📦</span>箱型操作</div>
          <div>
            <span class="ca-section-summary">${summary}</span>
            <span class="ca-section-chevron">›</span>
          </div>
        </div>
        <div class="ca-section-body">
          <div class="ca-empty">${box.reason || '此週期不適合箱型分析'}</div>
        </div>
      </div>`;
  }

  const adviceBlock = (box.advice && box.advice.length)
    ? `<div class="ca-advice"><div class="ca-advice-title">💡 怎麼操作</div>${
        box.advice.map(a => `<div class="ca-advice-line">• ${a}</div>`).join('')
      }</div>`
    : '';

  return `
    <div class="ca-section" data-section="box">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">📦</span>箱型操作</div>
        <div>
          <span class="ca-section-summary">${summary}</span>
          <button class="ca-copy-btn" data-copy-section="box" title="複製整段文字">📋</button>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        <div class="ca-item"><span class="ca-item-label">區間上緣 / 下緣</span><span class="ca-item-value">$${box.upper} / $${box.lower}</span></div>
        <div class="ca-item"><span class="ca-item-label">區間幅度</span><span class="ca-item-value">${box.rangePct}%(近 ${box.lookback} 根)</span></div>
        <div class="ca-item"><span class="ca-item-label">目前位置</span><span class="ca-item-value">${positionText}</span></div>
        <div class="ca-item"><span class="ca-item-label">建議進場</span><span class="ca-item-value ca-support">$${box.suggestion.entry}</span></div>
        <div class="ca-item"><span class="ca-item-label">停利目標</span><span class="ca-item-value ca-resist">$${box.suggestion.target}</span></div>
        <div class="ca-item"><span class="ca-item-label">停損</span><span class="ca-item-value ca-warn">$${box.suggestion.stop}</span></div>
        <div class="ca-item"><span class="ca-item-label">風險報酬比</span><span class="ca-item-value">${box.suggestion.riskReward}:1</span></div>
        <div class="ca-alert ${box.position === 'near_upper' ? 'danger' : box.position === 'near_lower' ? 'success' : ''}">
          ${(box.reasons || []).join('<br>')}
        </div>
        ${adviceBlock}
      </div>
    </div>
  `;
}

function _sectionTrend(trend) {
  if (!trend) return '';
  const dirIcon = trend.direction === 'up' ? '📈' :
                  trend.direction === 'down' ? '📉' : '➖';

  // 指標分組：基礎（原有）vs Advanced 5（新增）
  const basicKeys    = ['maAlignment','maSlope','hhhl','adx','longTermPos','breakout','recentBars','historicalRank'];
  const advancedKeys = ['psy','rci','bias','hv','sar'];

  const _makeItems = (keys) => keys
    .map(k => trend.indicators[k])
    .filter(Boolean)
    .map(it => `
    <div class="ca-item" data-expandable="1">
      <div class="ca-item-row">
        <span class="ca-item-label">${it.label}</span>
        <span class="ca-item-value ${_scoreClass(it.score)}">${it.value}</span>
        <span class="ca-why">?</span>
      </div>
      <div class="ca-explain">${it.reason || ''}</div>
    </div>
  `).join('');

  const basicItems    = _makeItems(basicKeys);
  const advancedItems = _makeItems(advancedKeys);

  // 指標快速標籤（顯示在 header 下方）
  const ind = trend.indicators;
  const tags = [];
  if (ind.adx?.value)   tags.push(`<span class="ca-ind-tag ${_scoreClass(ind.adx.score)}">ADX ${ind.adx.value}</span>`);
  if (ind.psy?.value) {
    const psyNum = parseFloat(ind.psy.value);
    tags.push(`<span class="ca-ind-tag ${_scoreClass(ind.psy.score)}">PSY ${psyNum.toFixed(0)}</span>`);
  }
  if (ind.rci?.value) {
    const rciNum = parseFloat(ind.rci.value);
    tags.push(`<span class="ca-ind-tag ${_scoreClass(ind.rci.score)}">RCI ${rciNum.toFixed(0)}</span>`);
  }
  if (ind.bias?.value) {
    const biasNum = parseFloat(ind.bias.value);
    tags.push(`<span class="ca-ind-tag ${_scoreClass(ind.bias.score)}">乖離 ${biasNum >= 0 ? '+' : ''}${biasNum.toFixed(1)}%</span>`);
  }
  if (ind.hv?.value) {
    const hvNum = parseFloat(ind.hv.value);
    tags.push(`<span class="ca-ind-tag neutral">HV ${hvNum.toFixed(1)}%</span>`);
  }
  if (ind.sar?.value) {
    const sarBull = ind.sar.score > 0;
    tags.push(`<span class="ca-ind-tag ${sarBull ? 'ca-positive' : 'ca-negative'}">SAR ${sarBull ? '多▲' : '空▼'}</span>`);
  }
  const tagBar = tags.length
    ? `<div class="ca-ind-tagbar">${tags.join('')}</div>`
    : '';

  const adviceBlock = (trend.advice && trend.advice.length)
    ? `<div class="ca-advice"><div class="ca-advice-title">💡 怎麼操作</div>${
        trend.advice.map(a => `<div class="ca-advice-line">• ${a}</div>`).join('')
      }</div>`
    : '';

  const advancedSection = advancedItems
    ? `<div class="ca-subsection-title">📡 Advanced 指標</div>${advancedItems}`
    : '';

  return `
    <div class="ca-section" data-section="trend">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">${dirIcon}</span>趨勢結構</div>
        <div>
          <span class="ca-section-summary">${trend.summary}</span>
          <button class="ca-copy-btn" data-copy-section="trend" title="複製整段文字">📋</button>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        ${tagBar}
        <div class="ca-item">
          <span class="ca-item-label">健康度</span>
          <div class="ca-bar"><div style="width:${trend.health}%"></div></div>
          <span class="ca-item-value">${trend.health}/100</span>
        </div>
        ${basicItems}
        ${advancedSection}
        ${adviceBlock}
      </div>
    </div>
  `;
}


function _sectionVolumePrice(vp) {
  if (!vp || vp.empty) return '';
  const signalClass = {
    bullish:        'ca-support',
    'mild-bullish': 'ca-support',
    bearish:        'ca-resist',
    warning:        'ca-warn',
    neutral:        '',
  }[vp.signal] || '';

  const alerts = [];
  if (vp.divergence) alerts.push(`<div class="ca-alert danger">⚠ ${vp.divergence.desc}</div>`);
  if (vp.surge)      alerts.push(`<div class="ca-alert danger">💥 ${vp.surge.desc}</div>`);
  if (vp.dried)      alerts.push(`<div class="ca-alert">💤 ${vp.dried.desc}</div>`);

  const adviceBlock = (vp.advice && vp.advice.length)
    ? `<div class="ca-advice"><div class="ca-advice-title">💡 怎麼操作</div>${
        vp.advice.map(a => `<div class="ca-advice-line">• ${a}</div>`).join('')
      }</div>`
    : '';

  return `
    <div class="ca-section" data-section="volprice">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">📊</span>量價分析</div>
        <div>
          <span class="ca-section-summary ${signalClass}">${vp.pattern}</span>
          <button class="ca-copy-btn" data-copy-section="volprice" title="複製整段文字">📋</button>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        <div class="ca-item"><span class="ca-item-label">型態</span><span class="ca-item-value ${signalClass}">${vp.pattern}</span></div>
        <div class="ca-item"><span class="ca-item-label">今日量 / 20 日均量</span><span class="ca-item-value">${vp.volRatio}x</span></div>
        <div class="ca-item"><span class="ca-item-label">今日量</span><span class="ca-item-value">${_fmtNum(vp.todayVol)}</span></div>
        <div class="ca-alert">${(vp.reasons || []).join('<br>')}</div>
        ${alerts.join('')}
        ${adviceBlock}
      </div>
    </div>
  `;
}

// ============================================================================
// 互動
// ============================================================================
function _bindSectionToggles() {
  containerEl.querySelectorAll('.ca-section-header').forEach(h => {
    h.addEventListener('click', () => {
      h.parentElement.classList.toggle('expanded');
    });
  });
  containerEl.querySelectorAll('.ca-item[data-expandable] .ca-item-row').forEach(row => {
    row.addEventListener('click', () => {
      row.parentElement.classList.toggle('expanded');
    });
  });
  // Phase 7.2:背離「畫線」按鈕
  containerEl.querySelectorAll('.ca-div-draw-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const signalId = btn.dataset.signal;
      renderSignalLayer(signalId);
      containerEl.querySelectorAll('.ca-div-draw-btn').forEach(b => b.classList.remove('active'));
      if (getActiveSignal()) btn.classList.add('active');
    });
  });
  // Phase 7.1 Batch 2 — B5 複製按鈕
  containerEl.querySelectorAll('.ca-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const section = btn.dataset.copySection;
      const text = _buildSectionText(section, lastResult, lastCode);
      if (!text) return;
      _copyToClipboard(text, btn);
    });
  });
}

// B5: 把某個分析區塊變成純文字
function _buildSectionText(section, r, code) {
  if (!r) return '';
  const header = `【選股台分析 — ${code || ''}】`;
  let body = '';

  if (section === 'sr') {
    body = '🎯 支撐 / 壓力\n';
    (r.support?.items || []).forEach((s, i) => {
      body += `\n支撐 ${i + 1}:$${s.price}(距現價 -${s.distance}%)${'★'.repeat(s.strength)}\n`;
      body += `  來源:${s.sources.join(' / ')}\n`;
      (s.reasons || []).filter(x => !x.startsWith('過去測試')).forEach(x => { body += `  • ${x}\n`; });
      if (s.history?.tests > 0) {
        body += `  📜 過去測試 ${s.history.tests} 次,守住 ${s.history.held} 次,跌破 ${s.history.broken} 次\n`;
      }
    });
    (r.resistance?.items || []).forEach((s, i) => {
      body += `\n壓力 ${i + 1}:$${s.price}(距現價 +${s.distance}%)${'★'.repeat(s.strength)}\n`;
      body += `  來源:${s.sources.join(' / ')}\n`;
      (s.reasons || []).filter(x => !x.startsWith('過去測試')).forEach(x => { body += `  • ${x}\n`; });
      if (s.history?.tests > 0) {
        body += `  📜 過去測試 ${s.history.tests} 次,守住 ${s.history.held} 次,突破 ${s.history.broken} 次\n`;
      }
    });
    if (r.srAdvice?.length) {
      body += `\n💡 怎麼操作:\n`;
      r.srAdvice.forEach(a => { body += `  • ${a}\n`; });
    }
  }

  if (section === 'box' && r.box && !r.box.skipped) {
    const b = r.box;
    body = `📦 箱型操作\n`;
    body += `區間:$${b.lower} ~ $${b.upper}(${b.rangePct}%,近 ${b.lookback} 根)\n`;
    body += `建議進場:$${b.suggestion.entry}\n`;
    body += `停利目標:$${b.suggestion.target}\n`;
    body += `停損:$${b.suggestion.stop}\n`;
    body += `風險報酬比:${b.suggestion.riskReward}:1\n`;
    body += `\n${(b.reasons || []).join('\n')}\n`;
    if (b.advice?.length) {
      body += `\n💡 怎麼操作:\n`;
      b.advice.forEach(a => { body += `  • ${a}\n`; });
    }
  }

  if (section === 'trend' && r.trend) {
    const t = r.trend;
    body = `📊 趨勢結構\n${t.summary}\n健康度:${t.health}/100\n`;
    Object.values(t.indicators).filter(Boolean).forEach(it => {
      body += `\n${it.label}:${it.value}\n  ${it.reason || ''}\n`;
    });
    if (t.advice?.length) {
      body += `\n💡 怎麼操作:\n`;
      t.advice.forEach(a => { body += `  • ${a}\n`; });
    }
  }

  if (section === 'volprice' && r.volumePrice && !r.volumePrice.empty) {
    const vp = r.volumePrice;
    body = `📊 量價分析\n型態:${vp.pattern}\n今日量 / 20 日均量:${vp.volRatio}x\n\n`;
    body += (vp.reasons || []).join('\n') + '\n';
    if (vp.advice?.length) {
      body += `\n💡 怎麼操作:\n`;
      vp.advice.forEach(a => { body += `  • ${a}\n`; });
    }
  }

  if (section === 'divergence' && r) {
    const candles = ctxRefs?.getCandles?.() || [];
    let divResults = [];
    try { divResults = detectDivergences(candles); } catch {}
    if (!divResults.length) return '';
    body = `🔀 指標背離\n`;
    divResults.forEach(d => {
      const isBull = d.id.includes('bull');
      body += `\n${isBull ? '↗' : '↘'} ${d.label}(${d.pairs?.length || 0} 組)\n  ${d.desc}\n`;
    });
  }

  return `${header}\n\n${body}\n— 選股台 Phase 7.1`;
}

// 複製到剪貼簿並回饋
async function _copyToClipboard(text, btnEl) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    if (btnEl) {
      const orig = btnEl.textContent;
      btnEl.textContent = '✓';
      btnEl.classList.add('copied');
      setTimeout(() => {
        btnEl.textContent = orig;
        btnEl.classList.remove('copied');
      }, 1200);
    }
  } catch (e) {
    console.warn('[copy] failed', e);
    if (btnEl) {
      btnEl.textContent = '✗';
      setTimeout(() => { btnEl.textContent = '📋'; }, 1200);
    }
  }
}

// ============================================================================
// 工具
// ============================================================================
function _stars(n) {
  n = Math.max(1, Math.min(5, n || 1));
  const filled = '★'.repeat(n);
  const empty  = '<span class="ca-star-empty">' + '☆'.repeat(5 - n) + '</span>';
  return `<span class="ca-stars">${filled}${empty}</span>`;
}

function _scoreClass(score) {
  if (score > 0.3) return 'ca-support';
  if (score < -0.3) return 'ca-resist';
  if (score < 0) return 'ca-warn';
  return '';
}

function _fmtNum(n) {
  if (n == null) return '-';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 億';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 萬';
  return n.toLocaleString();
}

// ============================================================================
// Phase 7.2:背離偵測區塊
// ============================================================================
function _sectionDivergence(candles) {
  let divResults = [];
  try { divResults = detectDivergences(candles); } catch (e) {}

  if (!divResults.length) {
    return `
      <div class="ca-section" data-section="divergence">
        <div class="ca-section-header">
          <div class="ca-section-title"><span class="ca-icon">🔀</span>指標背離</div>
          <div><span class="ca-section-summary">未偵測到</span><span class="ca-section-chevron">›</span></div>
        </div>
        <div class="ca-section-body">
          <div class="ca-empty">目前無 MACD / KD / RSI 背離訊號</div>
        </div>
      </div>`;
  }

  const items = divResults.map(d => {
    const isBull = d.id.includes('bull');
    const colorClass = isBull ? 'ca-support' : 'ca-resist';
    const icon = isBull ? '↗' : '↘';
    const pairsDesc = d.pairs?.length ? `${d.pairs.length} 組` : '';
    return `
      <div class="ca-item" data-expandable="1">
        <div class="ca-item-row">
          <span class="ca-item-label">${icon} ${d.label}</span>
          <span class="ca-item-value ${colorClass}">${pairsDesc || '已偵測'}</span>
          <button class="ca-div-draw-btn" data-signal="${d.id}" title="在 K 線上畫出背離說明">
            📐 畫線
          </button>
        </div>
        <div class="ca-explain">
          ${d.desc}
          <div style="margin-top:6px;font-size:11px;color:var(--accent)">
            點「畫線」按鈕會在 K 線上自動標出背離的兩個${isBull ? '低' : '高'}點連線與說明
          </div>
        </div>
      </div>`;
  }).join('');

  const summary = `${divResults.filter(d => d.id.includes('bull')).length} 底 / ${divResults.filter(d => d.id.includes('bear')).length} 頂`;

  return `
    <div class="ca-section" data-section="divergence">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">🔀</span>指標背離</div>
        <div>
          <span class="ca-section-summary">${summary}</span>
          <button class="ca-copy-btn" data-copy-section="divergence" title="複製整段文字">📋</button>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        ${items}
      </div>
    </div>`;
}


// ============================================================================
// Phase 7.5 C — 假突破識別器 UI
// ============================================================================
function _sectionFakeBreakout(fb) {
  if (!fb || !fb.detected) return '';
  const daysAgoText = fb.daysAgo === 0 ? '今天' :
                      fb.daysAgo === 1 ? '昨天' :
                      `${fb.daysAgo} 根前`;
  return `
    <div class="ca-section ca-section--fake-breakout" data-section="fakeBreakout">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">⚠️</span>假突破警示</div>
        <div>
          <span class="ca-section-summary">$${fb.level} 曾假突破</span>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        <div class="ca-alert danger">
          <strong>$${fb.level}</strong> 曾在 ${daysAgoText}出現假突破 — 突破後短期內跌回原位
        </div>
        <div class="ca-item">
          <span class="ca-item-label">假突破壓力位</span>
          <span class="ca-item-value ca-resist">$${fb.level}</span>
        </div>
        <div class="ca-item">
          <span class="ca-item-label">跌回時間</span>
          <span class="ca-item-value">${daysAgoText}</span>
        </div>
        <div class="ca-advice">
          <div class="ca-advice-title">💡 注意事項</div>
          <div class="ca-advice-line">• 此價位曾有假突破紀錄,再次突破需更嚴格確認</div>
          <div class="ca-advice-line">• 至少需帶量突破 + 次日站穩才算有效</div>
          <div class="ca-advice-line">• 無效突破進場者易被巴,等確認再追</div>
        </div>
      </div>
    </div>`;
}

// ============================================================================
// Phase 7.5 D — 分批進場計畫 UI
// ============================================================================
function _sectionEntryPlan(plan) {
  if (!plan) return '';
  const rrClass  = plan.rr >= 2 ? 'ca-support' : plan.rr >= 1.5 ? '' : 'ca-warn';
  const healthOk = plan.health >= 60;
  const dengLine = healthOk
    ? `燈燈幫你規劃好了,平均成本 $${plan.avgCost},停損設 $${plan.stop} — 嚴守計畫喵 ~`
    : `計畫給你,但健康度 ${plan.health} 不高,燈燈不強烈建議現在進場`;

  return `
    <div class="ca-section" data-section="entryPlan">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">📋</span>分批進場計畫</div>
        <div>
          <span class="ca-section-summary">風報比 ${plan.rr}:1</span>
          <button class="ca-copy-btn" data-copy-section="entryPlan" title="複製計畫">📋</button>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        <div class="ca-entry-plan">
          <div class="ca-entry-row">
            <span class="ca-entry-label">進場 1 <small>(30%)</small></span>
            <span class="ca-entry-value ca-support">$${plan.entry1}</span>
            <span class="ca-entry-note">現價附近</span>
          </div>
          <div class="ca-entry-row">
            <span class="ca-entry-label">進場 2 <small>(40%)</small></span>
            <span class="ca-entry-value ca-support">$${plan.entry2}</span>
            <span class="ca-entry-note">S1 $${plan.s1Price} 附近</span>
          </div>
          <div class="ca-entry-row">
            <span class="ca-entry-label">進場 3 <small>(30%)</small></span>
            <span class="ca-entry-value ca-support">$${plan.entry3}</span>
            <span class="ca-entry-note">${plan.s2Price ? 'S2 $' + plan.s2Price + ' 附近' : 'S1 下 3%'}</span>
          </div>
          <div class="ca-entry-divider"></div>
          <div class="ca-entry-row ca-entry-row--summary">
            <span class="ca-entry-label">平均成本</span>
            <span class="ca-entry-value">$${plan.avgCost}</span>
          </div>
          <div class="ca-entry-row">
            <span class="ca-entry-label">停損</span>
            <span class="ca-entry-value ca-resist">$${plan.stop}</span>
            <span class="ca-entry-note">S2/S1 下 1.5%</span>
          </div>
          <div class="ca-entry-row">
            <span class="ca-entry-label">停利目標</span>
            <span class="ca-entry-value ca-support">$${plan.target}</span>
            <span class="ca-entry-note">R1 $${plan.r1Price} 下 1%</span>
          </div>
          <div class="ca-entry-row ca-entry-row--rr">
            <span class="ca-entry-label">整體風報比</span>
            <span class="ca-entry-value ${rrClass}">${plan.rr}:1</span>
          </div>
        </div>
        <div class="ca-alert ${healthOk ? 'success' : ''}">
          🐱 ${dengLine}
        </div>
      </div>
    </div>`;
}



// ============================================================================
// Phase 7.5+ — 歷史型態搜尋 UI
// ============================================================================
function _sectionPatterns(result) {
  if (!result || !result.patterns.length) {
    return `
      <div class="ca-section" data-section="patterns">
        <div class="ca-section-header">
          <div class="ca-section-title"><span class="ca-icon">🔍</span>歷史型態搜尋</div>
          <div><span class="ca-section-summary">找不到相似型態</span><span class="ca-section-chevron">›</span></div>
        </div>
        <div class="ca-section-body">
          <div class="ca-empty">K 棒數量不足或近期走勢較為特殊,找不到相似歷史片段</div>
        </div>
      </div>`;
  }

  const { patterns, windowLen, followLen, ups, downs, bias } = result;
  const biasText = bias === 'up'   ? `後續偏多(${ups}/${patterns.length} 次上漲)` :
                   bias === 'down' ? `後續偏空(${downs}/${patterns.length} 次下跌)` :
                   '後續方向不定';
  const biasClass = bias === 'up' ? 'ca-support' : bias === 'down' ? 'ca-resist' : '';

  const items = patterns.map((p, i) => {
    const dirIcon  = p.followDir === 'up' ? '📈' : p.followDir === 'down' ? '📉' : '➖';
    const dirClass = p.followDir === 'up' ? 'ca-support' : p.followDir === 'down' ? 'ca-resist' : '';
    const followText = p.followPct != null
      ? `${p.followPct > 0 ? '+' : ''}${p.followPct}%(${followLen} 根後)`
      : '資料不足';
    return `
      <div class="ca-item" data-expandable="1">
        <div class="ca-item-row">
          <span class="ca-item-label">相似段 ${i + 1}</span>
          <span class="ca-item-value">相似度 ${p.similarity}%</span>
          <span class="ca-why">詳細</span>
        </div>
        <div class="ca-explain">
          <div>📅 發生於:${p.ago}</div>
          <div>📌 進場收盤:$${p.entryClose}</div>
          <div>${dirIcon} 後續 ${p.followLen} 根:<span class="${dirClass}">${followText}</span></div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="ca-section" data-section="patterns">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">🔍</span>歷史型態搜尋</div>
        <div>
          <span class="ca-section-summary ${biasClass}">${biasText}</span>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        <div class="ca-alert">近 ${windowLen} 根型態在歷史中找到 ${patterns.length} 個相似片段</div>
        ${items}
      </div>
    </div>`;
}

// ============================================================================
// Phase 7.5+ — 歷史準確度回測 UI
// ============================================================================
function _sectionSRAccuracy(acc) {
  if (!acc || !acc.srResults.length) return '';

  const rows = acc.srResults.map(r => {
    if (r.touches === 0) {
      return `
        <div class="ca-item">
          <span class="ca-item-label">${r.label}</span>
          <span class="ca-item-value ca-muted">尚未測試</span>
        </div>`;
    }
    const rateClass = r.rate >= 70 ? 'ca-support' : r.rate >= 40 ? '' : 'ca-resist';
    const stars = r.rate >= 70 ? '★★★' : r.rate >= 50 ? '★★' : '★';
    return `
      <div class="ca-item">
        <span class="ca-item-label">${r.label}</span>
        <span class="ca-item-value ${rateClass}">${r.rate}% ${stars}</span>
        <span class="ca-entry-note">${r.success}/${r.touches} 次守住</span>
      </div>`;
  }).join('');

  const avgText = acc.avgRate != null ? `平均命中率 ${acc.avgRate}%` : '資料不足';
  const avgClass = acc.avgRate >= 60 ? 'ca-support' : acc.avgRate < 40 ? 'ca-resist' : '';

  return `
    <div class="ca-section" data-section="srAccuracy">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">📊</span>支撐壓力準確度</div>
        <div>
          <span class="ca-section-summary ${avgClass}">${avgText}</span>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        ${rows}
        <div class="ca-alert" style="margin-top:8px;font-size:11px;">
          以接近價位後 3 根 K 棒是否守住為判斷標準
        </div>
      </div>
    </div>`;
}

// ============================================================================
// Phase 7.5+ — 壓力測試 UI
// ============================================================================
function _sectionStressTest(stress) {
  if (!stress) return '';

  const rows = stress.results.map(r => {
    const cls = r.stockPct <= -15 ? 'ca-resist' : r.stockPct <= -8 ? 'ca-warn' : '';
    return `
      <div class="ca-item">
        <span class="ca-item-label">大盤跌 ${Math.abs(r.mktPct)}%</span>
        <span class="ca-item-value ${cls}">此股約 ${r.stockPct}%</span>
        <span class="ca-entry-note">→ $${r.stockPrice}</span>
      </div>`;
  }).join('');

  const betaClass = stress.beta > 1.3 ? 'ca-resist' : stress.beta < 0.7 ? 'ca-support' : '';

  return `
    <div class="ca-section" data-section="stressTest">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">🧪</span>壓力測試模擬</div>
        <div>
          <span class="ca-section-summary ${betaClass}">Beta ≈ ${stress.beta}</span>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        <div class="ca-item">
          <span class="ca-item-label">估算 Beta</span>
          <span class="ca-item-value ${betaClass}">${stress.beta}</span>
          <span class="ca-entry-note">${stress.beta > 1.2 ? '波動大於大盤' : stress.beta < 0.8 ? '波動小於大盤' : '接近大盤波動'}</span>
        </div>
        <div class="ca-item">
          <span class="ca-item-label">年化波動率</span>
          <span class="ca-item-value">${stress.annualVol}%</span>
        </div>
        <div class="ca-item">
          <span class="ca-item-label">近 60 根最大回撤</span>
          <span class="ca-item-value ca-resist">${stress.maxDrawdown}%</span>
        </div>
        <div class="ca-stress-divider"></div>
        ${rows}
        <div class="ca-alert" style="margin-top:8px;font-size:11px;">
          Beta 以近期日波動率估算(無真實大盤資料),僅供參考
        </div>
      </div>
    </div>`;
}

// ============================================================================
// Phase 7.5+ — 時間警報 UI
// ============================================================================
function _sectionTimeAlerts(events) {
  if (!events || !events.length) return '';

  const urgencyIcon = { urgent: '🔴', soon: '🟡', normal: '🟢', passed: '⚫' };
  const urgencyLabel = { urgent: '即將到來', soon: '近期', normal: '預定', passed: '已過' };

  const items = events.map(ev => {
    const icon  = urgencyIcon[ev.urgency] || '⚪';
    const label = urgencyLabel[ev.urgency] || '';
    const dayText = ev.passed ? `${Math.abs(ev.diffDays)} 天前` :
                    ev.diffDays === 0 ? '今天' :
                    ev.diffDays === 1 ? '明天' :
                    `${ev.diffDays} 天後`;
    const typeLabel = ev.type === 'exdiv'   ? '除息' :
                      ev.type === 'meeting' ? '法說會' : ev.type;
    const cls = ev.urgency === 'urgent' ? 'ca-resist' :
                ev.urgency === 'soon'   ? 'ca-warn'   : '';
    return `
      <div class="ca-item">
        <span class="ca-item-label">${icon} ${typeLabel}</span>
        <span class="ca-item-value ${cls}">${dayText}</span>
        <span class="ca-entry-note">${ev.label || ev.date}</span>
      </div>`;
  }).join('');

  const urgent = events.filter(e => e.urgency === 'urgent').length;
  const summary = urgent ? `${urgent} 個即將到來` : `${events.length} 個事件`;

  return `
    <div class="ca-section" data-section="timeAlerts">
      <div class="ca-section-header">
        <div class="ca-section-title"><span class="ca-icon">⏰</span>時間警報</div>
        <div>
          <span class="ca-section-summary ${urgent ? 'ca-warn' : ''}">${summary}</span>
          <span class="ca-section-chevron">›</span>
        </div>
      </div>
      <div class="ca-section-body">
        ${items}
      </div>
    </div>`;
}


// end of chart-analysis-card.js
