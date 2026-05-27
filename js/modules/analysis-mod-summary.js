/* js/modules/analysis-mod-summary.js
 * 🌟 Summary Golden Board Module
 * 綜合技術報告：整合所有已啟用模組的評分，出一份完整研判
 * ⚠️ 必須最後 register（需等所有其他 module 都 register 完才有意義）
 *    在 index.html 排在所有其他 module script 的最後
 */
import { AppState } from '../state.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ── 取得 _evalCache（從框架層讀，不重新計算）──
// analysis-fullscreen.js 沒有 export _evalCache，改用事件/全域橋接
// 做法：Summary 的 evaluate 收到 candles，但主要邏輯靠 window.__fsEvalCache
// 框架層在 refreshFullscreenAnalysis 結束時把 _evalCache 寫進 window.__fsEvalCache

// ── 指標分組定義（決定報告呈現順序）──
const GROUPS = [
  {
    id: 'trend',
    label: '趨勢方向',
    icon: '📐',
    mods: ['ichimoku', 'ema', 'gmma', 'sar'],
  },
  {
    id: 'momentum',
    label: '動能指標',
    icon: '⚡',
    mods: ['kd', 'rsi', 'macd', 'psy', 'rci'],
  },
  {
    id: 'volatility',
    label: '波動通道',
    icon: '📡',
    mods: ['bb', 'env', 'hv'],
  },
  {
    id: 'structure',
    label: '市場結構',
    icon: '🧭',
    mods: ['dmi'],
  },
  {
    id: 'pattern',
    label: 'K線型態',
    icon: '🕯️',
    mods: ['pattern'],
  },
  {
    id: 'fundamental',
    label: '基本面',
    icon: '📋',
    mods: ['fundamental'],
  },
];

// 評分轉換：把各 module 的 score(1~5) 統一換算成方向（bull/bear/neutral）
function _scoreToDir(score) {
  if (score >= 4) return 'bull';
  if (score <= 2) return 'bear';
  return 'neutral';
}

const SummaryModule = {
  id: 'summary',
  name: '綜合報告',
  icon: '📊',
  candleMinLen: 10,

  evaluate(candles) {
    // 從 window.__fsEvalCache 讀所有已算好的 evaluation
    const cache = window.__fsEvalCache ?? new Map();
    const lastClose = candles[candles.length - 1]?.close ?? 0;

    // 整理各 group 的得分
    const groupResults = GROUPS.map(group => {
      const modResults = group.mods
        .map(modId => {
          const cached = cache.get(modId);
          if (!cached || cached.disabled) return null;
          const ev = cached.evaluation;
          if (!ev || !ev.signal) return null;
          return {
            modId,
            name:   cached.mod.name,
            icon:   cached.mod.icon,
            signal: ev.signal.name,
            score:  ev.score,
            stars:  ev.signal.stars,
            desc:   ev.signal.desc,
            dir:    _scoreToDir(ev.score),
          };
        })
        .filter(Boolean);

      const activeCount = modResults.length;
      if (activeCount === 0) return { ...group, modResults: [], avgScore: null, dir: 'neutral' };

      const avgScore = modResults.reduce((s, m) => s + m.score, 0) / activeCount;
      const bullCount = modResults.filter(m => m.dir === 'bull').length;
      const bearCount = modResults.filter(m => m.dir === 'bear').length;

      return {
        ...group,
        modResults,
        avgScore,
        bullCount,
        bearCount,
        dir: bullCount > bearCount ? 'bull' : bearCount > bullCount ? 'bear' : 'neutral',
      };
    }).filter(g => g.modResults.length > 0);

    // 整體評分（加權：趨勢/動能/結構最重，其餘次之）
    const WEIGHTS = { trend: 3, momentum: 3, structure: 2, pattern: 2, volatility: 1, fundamental: 2 };
    let totalWeight = 0, weightedScore = 0;
    groupResults.forEach(g => {
      if (g.avgScore == null) return;
      const w = WEIGHTS[g.id] ?? 1;
      weightedScore += g.avgScore * w;
      totalWeight   += w;
    });
    const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 3;

    // 多空統計
    const allMods    = groupResults.flatMap(g => g.modResults);
    const totalMods  = allMods.length;
    const bullMods   = allMods.filter(m => m.dir === 'bull').length;
    const bearMods   = allMods.filter(m => m.dir === 'bear').length;
    const neutralMods = totalMods - bullMods - bearMods;
    const bullPct    = totalMods > 0 ? Math.round(bullMods / totalMods * 100) : 0;

    // 強訊號擷取（stars >= 4 的）
    const strongBull = allMods.filter(m => m.dir === 'bull' && m.stars >= 4);
    const strongBear = allMods.filter(m => m.dir === 'bear' && m.stars >= 4);

    // 基本面未載入時的提示
    const fundNoData = cache.get('fundamental')?.evaluation?.raw?.noData === true;

    // 建構 items（每個 group 一個）
    const items = groupResults.map(g => ({
      ok: g.dir === 'bull' ? true : g.dir === 'bear' ? false : null,
      text: `<strong>${g.icon} ${g.label}</strong>：${g.dir === 'bull' ? '偏多' : g.dir === 'bear' ? '偏空' : '中性'}（${g.bullCount}多/${g.bearCount}空/${g.modResults.length - g.bullCount - g.bearCount}中）`,
      sub: g.modResults.map(m => `${m.icon} ${m.signal}`).join('　'),
      whyTitle: `${g.label} 怎麼計算？`,
      why: `${g.label} 包含 ${g.modResults.map(m => m.name).join('、')} 等指標。評分偏多（≥4分）算多頭票，偏空（≤2分）算空頭票，綜合各指標給出分組方向。`,
    }));

    // 綜合訊號
    let signal, score;
    if (bullPct >= 75 && overallScore >= 4) {
      signal = { name: '強烈多頭共識', icon: '📊', stars: 5,
        desc: `${bullMods}/${totalMods} 個指標偏多（${bullPct}%），多空共識強烈，趨勢明確向上。` };
      score = 5;
    } else if (bullPct >= 60 && overallScore >= 3.5) {
      signal = { name: '多頭占優', icon: '🔵', stars: 4,
        desc: `${bullMods}/${totalMods} 個指標偏多（${bullPct}%），多頭略占優勢，趨勢偏多。` };
      score = 4;
    } else if (bearMods >= bullMods && overallScore <= 2.5 && totalMods >= 3) {
      signal = { name: '空頭占優', icon: '🔴', stars: 2,
        desc: `${bearMods}/${totalMods} 個指標偏空，空頭占優，避免追多。` };
      score = 2;
    } else if (bearMods > bullMods * 1.5 && overallScore <= 2) {
      signal = { name: '強烈空頭', icon: '📉', stars: 1,
        desc: `${bearMods}/${totalMods} 個指標偏空，多空共識偏空，不宜做多。` };
      score = 1;
    } else if (Math.abs(bullMods - bearMods) <= 1) {
      signal = { name: '多空分歧', icon: '⏸', stars: 2,
        desc: `多空指標勢均力敵（${bullMods}多 vs ${bearMods}空），等待方向明朗再行動。` };
      score = 2;
    } else {
      signal = { name: '偏多觀望', icon: '🟡', stars: 3,
        desc: `${bullMods}多/${bearMods}空，多頭稍多但未形成強共識，謹慎參與。` };
      score = 3;
    }

    return {
      score, signal, items,
      raw: {
        groupResults, allMods, totalMods,
        bullMods, bearMods, neutralMods, bullPct,
        overallScore, strongBull, strongBear, lastClose,
      },
    };
  },

  getLegendRows(ev) { return []; },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📊 綜合報告</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    const r    = ev.raw;
    const code = AppState.activeCode || '';
    const stars = '⭐'.repeat(ev.signal.stars);
    const bullColor = '#34d399', bearColor = '#ef5350', neutColor = '#8a8f99';

    // 多空比例 bar
    const bullPx = r.totalMods > 0 ? Math.round(r.bullMods / r.totalMods * 200) : 0;
    const bearPx = r.totalMods > 0 ? Math.round(r.bearMods / r.totalMods * 200) : 0;
    const neutPx = 200 - bullPx - bearPx;

    // 整體評分顏色
    const scoreColor = r.overallScore >= 4 ? bullColor : r.overallScore <= 2.5 ? bearColor : '#fbbf24';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📊</span>
        <span class="fs-title">綜合技術報告</span>
        <span class="fs-subtitle">${code} · ${r.totalMods} 個指標綜合研判</span>
      </div>
      <div class="fs-deep-module-body">

        <!-- 整體評分卡 -->
        <div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="font-size:36px;font-weight:700;color:${scoreColor}">${r.overallScore.toFixed(1)}</div>
            <div>
              <div style="font-size:18px;font-weight:700;color:${scoreColor}">${ev.signal.icon} ${ev.signal.name}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px">${ev.signal.desc}</div>
            </div>
            <div style="margin-left:auto;text-align:right">
              <div style="font-size:11px;color:var(--muted)">指標共識</div>
              <div style="font-size:20px;font-weight:600">
                <span style="color:${bullColor}">▲${r.bullMods}</span>
                <span style="color:var(--muted);font-size:14px">／</span>
                <span style="color:${neutColor}">●${r.neutralMods}</span>
                <span style="color:var(--muted);font-size:14px">／</span>
                <span style="color:${bearColor}">▼${r.bearMods}</span>
              </div>
            </div>
          </div>

          <!-- 多空比例條 -->
          <div style="margin-bottom:6px;font-size:11px;color:var(--muted)">多空分布（共 ${r.totalMods} 個指標）</div>
          <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;gap:1px">
            ${bullPx > 0 ? `<div style="width:${bullPx}px;background:${bullColor};border-radius:4px 0 0 4px"></div>` : ''}
            ${neutPx > 0 ? `<div style="flex:1;background:${neutColor}"></div>` : ''}
            ${bearPx > 0 ? `<div style="width:${bearPx}px;background:${bearColor};border-radius:0 4px 4px 0"></div>` : ''}
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px">
            <span style="color:${bullColor}">多頭 ${r.bullPct}%</span>
            <span style="color:${neutColor}">中性</span>
            <span style="color:${bearColor}">空頭 ${Math.round(r.bearMods/r.totalMods*100)}%</span>
          </div>
        </div>

        <!-- 強訊號彙整 -->
        ${r.strongBull.length > 0 ? `
        <div style="background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-size:12px;font-weight:600;color:${bullColor};margin-bottom:8px">⭐⭐⭐⭐ 強烈多頭訊號</div>
          ${r.strongBull.map(m => `
            <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px">
              <span style="font-size:11px;color:${bullColor};font-weight:600">${m.icon} ${m.name}</span>
              <span style="font-size:11px;color:#93c5fd">${m.signal}</span>
              <span style="font-size:10px;color:var(--muted);flex:1">${m.desc}</span>
            </div>`).join('')}
        </div>` : ''}

        ${r.strongBear.length > 0 ? `
        <div style="background:rgba(239,83,80,0.06);border:1px solid rgba(239,83,80,0.2);border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-size:12px;font-weight:600;color:${bearColor};margin-bottom:8px">⭐⭐⭐⭐ 強烈空頭訊號</div>
          ${r.strongBear.map(m => `
            <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px">
              <span style="font-size:11px;color:${bearColor};font-weight:600">${m.icon} ${m.name}</span>
              <span style="font-size:11px;color:#fca5a5">${m.signal}</span>
              <span style="font-size:10px;color:var(--muted);flex:1">${m.desc}</span>
            </div>`).join('')}
        </div>` : ''}

        <!-- 分組詳細 -->
        <div class="fs-readout">
          <div class="fs-readout-title">📋 分組研判</div>
          <div class="fs-readout-items">
            ${ev.items.map(_renderReadoutItem).join('')}
          </div>
        </div>

        <!-- 各指標評分表 -->
        <div class="fs-keylevels" style="margin-top:16px">
          <h4>📊 所有指標評分明細</h4>
          ${r.groupResults.map(g => `
            <div style="margin-bottom:10px">
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${g.icon} ${g.label}</div>
              ${g.modResults.map(m => `
                <div class="fs-keylevel-row" style="padding:5px 0">
                  <span class="fs-keylevel-tag" style="background:rgba(${m.dir==='bull'?'52,211,153':m.dir==='bear'?'239,83,80':'138,143,153'},0.15);color:${m.dir==='bull'?bullColor:m.dir==='bear'?bearColor:neutColor};min-width:80px">${m.icon} ${m.name}</span>
                  <span class="fs-keylevel-price" style="color:${m.dir==='bull'?bullColor:m.dir==='bear'?bearColor:neutColor};font-size:12px">${m.dir==='bull'?'▲':m.dir==='bear'?'▼':'●'} ${m.signal}</span>
                  <span class="fs-keylevel-desc" style="font-size:11px">${'⭐'.repeat(m.stars)}　${m.desc.slice(0,40)}${m.desc.length>40?'…':''}</span>
                </div>`).join('')}
            </div>`).join('')}
        </div>

        <!-- 基本面未載入提示 -->
        ${(() => {
          const fundNoData = r.groupResults.every(g => g.id !== 'fundamental') &&
            (window.__lastFundamentals == null);
          return fundNoData ? `
            <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);
                        border-radius:8px;padding:10px 14px;margin-bottom:12px;
                        display:flex;align-items:center;gap:10px;font-size:12px">
              <span style="font-size:18px">📋</span>
              <span style="color:#fbbf24;flex:1">基本面資料未載入，綜合評分不含基本面維度。
                切到「基本面」Tab 或在全視窗基本面 Tab 點「載入」按鈕後，報告會更完整。</span>
            </div>` : '';
        })()}

        <!-- 操作建議 -->
        <div class="fs-action-guide" style="margin-top:16px">
          <div class="fs-action-guide-head">🎯 綜合操作建議</div>
          <div class="fs-action-guide-body">
            ${_summaryActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 📊 綜合報告計算方式 ━━━</h4>
            <p>每個指標的評分（1~5分）轉換為方向：≥4分算多頭票、≤2分算空頭票、3分算中性票。</p>
            <p style="margin-top:8px"><strong>加權方式</strong>（重要性排序）：趨勢×3、動能×3、基本面×2、市場結構×2、K線型態×2、波動通道×1</p>
            <p style="margin-top:8px"><strong>注意</strong>：只有已啟用的指標才計入統計。指標開啟越多，報告越完整。建議至少開啟 KD / RSI / MACD / EMA 四個基本指標。</p>
          </div>
        </div>

      </div>
    `;
  },
};

function _summaryActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;

  const strongBullStr = r.strongBull.length > 0
    ? r.strongBull.map(m => `${m.icon} ${m.name}`).join(' + ')
    : null;
  const strongBearStr = r.strongBear.length > 0
    ? r.strongBear.map(m => `${m.icon} ${m.name}`).join(' + ')
    : null;

  if (sig === '強烈多頭共識') return [
    { label: '操作方向', detail: `<strong>積極做多</strong>。${r.bullMods}/${r.totalMods} 個指標偏多，多空共識強烈${strongBullStr ? `，特別是 ${strongBullStr}` : ''}` },
    { label: '進場策略', detail: `短線回踩不破支撐可加碼；強勢行情中不要因小幅回檔就出場` },
    { label: '停損設置', detail: `以技術面停損為主（如跌破 MA20 或 KD 死亡交叉）；基本面若同時偏多，可寬鬆停損` },
    { label: '注意事項', detail: `多頭共識強烈時反而要注意「過熱」，若 RSI > 80 或 BB 突破上軌，可先減碼 30% 等回調` },
  ];
  if (sig === '多頭占優') return [
    { label: '操作方向', detail: `<strong>偏多操作</strong>，${r.bullMods}/${r.totalMods} 個指標偏多，趨勢偏多但非強共識` },
    { label: '進場策略', detail: `正常部位（50~70%），等待更多指標轉多或強訊號出現再加碼` },
    { label: '停損設置', detail: `設在近期支撐位，若指標共識轉為中性以下，考慮減碼` },
    { label: '注意事項', detail: strongBearStr ? `留意空頭訊號：${strongBearStr}，需密切觀察` : `目前無強烈空頭訊號，但仍需注意高位風險` },
  ];
  if (sig === '強烈空頭' || sig === '空頭占優') return [
    { label: '操作方向', detail: `<strong>避免做多</strong>，${r.bearMods}/${r.totalMods} 個指標偏空${strongBearStr ? `，特別是 ${strongBearStr}` : ''}` },
    { label: '持倉處理', detail: `多單逐步減碼；若指標共識進一步轉空，加速出場` },
    { label: '轉多條件', detail: `等待多頭指標比例回升至 60% 以上，且出現強烈多頭訊號（如低檔黃金交叉）再評估` },
    { label: '注意事項', detail: `空頭共識時不宜逆勢抄底，等技術面訊號明確轉多再行動` },
  ];
  if (sig === '多空分歧') return [
    { label: '操作方向', detail: `<strong>觀望為主</strong>，多空各 ${r.bullMods} vs ${r.bearMods} 個指標，勢均力敵，方向不明` },
    { label: '等待條件', detail: `等多頭比例站上 60%（${Math.ceil(r.totalMods * 0.6)} 個以上偏多）再進場` },
    { label: '風險控制', detail: `若已持倉，確保停損明確；分歧期不宜加碼` },
    { label: '注意事項', detail: `多空分歧常出現在趨勢轉換點，方向一旦確立往往力道較強，保持耐心等待` },
  ];
  // 偏多觀望
  return [
    { label: '操作方向', detail: `偏多但謹慎，多頭稍多（${r.bullMods}/${r.totalMods}）但未形成強共識` },
    { label: '進場策略', detail: `小部位試單（30%），等指標共識增強再加碼` },
    { label: '停損設置', detail: `設在近期支撐，若多頭比例下降到中性以下立即停損` },
    { label: '注意事項', detail: `目前訊號模糊，不宜重倉，以風險控制為優先` },
  ];
}

registerAnalysisModule(SummaryModule);
