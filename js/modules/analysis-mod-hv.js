/* js/modules/analysis-mod-hv.js
 * 🌟 HV Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcHV } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ═══════════════════════════════════════════════════════
// 🌟 HVModule — Golden Board
// HV 歷史波動率：年化波動率 % + 波動擴張/收縮 + 風險評估
// ═══════════════════════════════════════════════════════
const HVModule = {
  id: 'hv',
  name: 'HV 歷史波動率',
  icon: '📉',
  candleMinLen: 21,  // calcHV(n=20) 需要 21 根

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const hvArr = calcHV(closes, 20);

    let lastIdx = n - 1;
    while (lastIdx > 0 && hvArr[lastIdx] === null) lastIdx--;

    const lastHV = hvArr[lastIdx];
    const prevHV = hvArr[lastIdx - 1] ?? lastHV;
    const hvMom  = lastHV - prevHV;

    // 近 20 根 HV 的統計（相對高低位）
    const recentHV = hvArr.slice(Math.max(0, lastIdx - 19), lastIdx + 1).filter(v => v !== null);
    const minHV    = Math.min(...recentHV);
    const maxHV    = Math.max(...recentHV);
    const avgHV    = recentHV.reduce((a, b) => a + b, 0) / recentHV.length;
    const hvRank   = maxHV > minHV ? (lastHV - minHV) / (maxHV - minHV) * 100 : 50; // 近20根的百分位

    // 波動率分類（台股一般標準）
    const isLow    = lastHV < 20;   // 低波動
    const isNormal = lastHV >= 20 && lastHV < 40;  // 正常
    const isHigh   = lastHV >= 40 && lastHV < 60;  // 高波動
    const isExtreme= lastHV >= 60;  // 極高波動

    // 波動擴張/收縮判斷（近5根斜率）
    const hv5 = recentHV.slice(-5);
    const isExpanding  = hv5.length >= 3 && hv5[hv5.length-1] > hv5[0];
    const isContracting= hv5.length >= 3 && hv5[hv5.length-1] < hv5[0];

    // 近5根的變化量
    const hv5Change = hv5.length >= 2 ? hv5[hv5.length-1] - hv5[0] : 0;

    const items = [];

    // ── 條件 1：HV 絕對水準 ──
    if (isExtreme) {
      items.push({
        ok: false,
        text: `<strong>極高波動</strong>：HV ${lastHV.toFixed(1)}%（≥ 60%，異常波動）`,
        sub: `年化波動率極高，市場情緒極度不穩定，日波動約 ${(lastHV / Math.sqrt(252)).toFixed(1)}%`,
        whyTitle: '為什麼極高波動是風險訊號？',
        why: '年化波動率 ≥ 60% 代表市場處於恐慌或極度亢奮的狀態。日波動幅度可達 3~5%，是正常時期的 2~3 倍。這種環境下技術指標失準、停損點難以設定，風險管理難度極高。極高 HV 後通常出現均值回歸（波動率回落）。',
      });
    } else if (isHigh) {
      items.push({
        ok: null,
        text: `<strong>高波動</strong>：HV ${lastHV.toFixed(1)}%（40~60%，偏高）`,
        sub: `波動率高於正常水準，日波動約 ${(lastHV / Math.sqrt(252)).toFixed(1)}%，需適當縮小部位`,
        whyTitle: '高波動環境下如何操作？',
        why: '年化波動率 40~60% 代表市場波動明顯高於正常。這可能是趨勢行情的爆發期（好的波動），也可能是恐慌性賣壓（壞的波動）。高 HV 環境中，停損點應設更寬（否則會被正常回調洗出），部位相應縮小。',
      });
    } else if (isNormal) {
      items.push({
        ok: true,
        text: `<strong>正常波動</strong>：HV ${lastHV.toFixed(1)}%（20~40%，正常範圍）`,
        sub: `波動率在正常水準，日波動約 ${(lastHV / Math.sqrt(252)).toFixed(1)}%`,
        whyTitle: '正常波動代表什麼？',
        why: '年化波動率 20~40% 是多數台股的正常波動區間。在這個範圍內，技術指標相對可靠，停損點設定有依據，是最適合操作的環境。',
      });
    } else {
      items.push({
        ok: null,
        text: `<strong>低波動</strong>：HV ${lastHV.toFixed(1)}%（< 20%，市場沉寂）`,
        sub: `波動率極低，市場成交縮量或橫盤整理，日波動約 ${(lastHV / Math.sqrt(252)).toFixed(1)}%`,
        whyTitle: '為什麼低波動反而值得注意？',
        why: '年化波動率 < 20% 代表市場進入極度平靜的狀態，類似布林通道的 Squeeze。歷史上長時間的低波動後，往往出現一波大幅波動（波動聚集效應）。低 HV 本身不告訴你方向，但是「蓄力即將爆發」的前兆。',
      });
    }

    // ── 條件 2：近20根百分位（相對高低）──
    items.push({
      ok: hvRank < 30,
      text: hvRank > 70
        ? `<strong>波動高位</strong>：近20根百分位 ${hvRank.toFixed(0)}%（波動率相對偏高）`
        : hvRank < 30
        ? `<strong>波動低位</strong>：近20根百分位 ${hvRank.toFixed(0)}%（波動率相對偏低，蓄力中）`
        : `<strong>波動中位</strong>：近20根百分位 ${hvRank.toFixed(0)}%（波動率在正常範圍）`,
      sub: `近20根 HV 最低 ${minHV.toFixed(1)}% / 平均 ${avgHV.toFixed(1)}% / 最高 ${maxHV.toFixed(1)}%`,
      whyTitle: '為什麼看相對百分位比絕對值更重要？',
      why: '不同股票的正常波動率差異很大（小型股通常比大型股高）。用百分位排名（相對自身歷史水準）比用固定閾值（如40%）更客觀。HV 在近期最低點附近（百分位 < 30%），代表波動率相對壓縮，爆發機率高。',
    });

    // ── 條件 3：波動趨勢（擴張/收縮）──
    items.push({
      ok: isContracting,
      text: isExpanding
        ? `<strong>波動擴張</strong>：近5根 HV 持續走高（+${hv5Change.toFixed(1)}%）`
        : isContracting
        ? `<strong>波動收縮</strong>：近5根 HV 持續走低（${hv5Change.toFixed(1)}%）`
        : `<strong>波動持平</strong>：近5根 HV 無明顯趨勢`,
      sub: `本根 ${lastHV.toFixed(1)}% vs 前根 ${prevHV.toFixed(1)}%（本根變化 ${hvMom > 0 ? '+' : ''}${hvMom.toFixed(1)}%）`,
      whyTitle: '波動擴張 vs 收縮代表什麼？',
      why: '波動率擴張（HV 走高）代表市場不確定性增加，可能是趨勢行情開始或恐慌拋售；波動率收縮（HV 走低）代表市場趨於平靜，通常對應整理盤或 Squeeze 蓄力。波動從高位快速收縮後再次上升，往往是新一輪行情的起點。',
    });

    // ── 條件 4：每日等效波動（實用風管數字）──
    const dailyVol = lastHV / Math.sqrt(252);
    const closePrice = closes[n - 1];
    const dailyRange = closePrice * dailyVol / 100;
    items.push({
      ok: dailyVol < 2.5,
      text: `<strong>日波動估計</strong>：約 ±${dailyVol.toFixed(1)}%（每日約 ±${dailyRange.toFixed(0)} 元）`,
      sub: `以現價 ${closePrice.toFixed(2)} 元計算，1σ 日波動範圍 ${(closePrice - dailyRange).toFixed(0)} ~ ${(closePrice + dailyRange).toFixed(0)} 元`,
      whyTitle: '日波動估計有什麼用？',
      why: '日波動 = 年化波動率 / √252。這個數字直接告訴你「在 68% 的交易日（1個標準差），這支股票的波動範圍是多少」。設定停損點時，停損距離應至少是日波動的 1~2 倍，否則正常波動就會觸發停損（被洗出）。',
    });

    // ── 綜合訊號 ──
    let signal, score;

    if (isLow && isContracting) {
      signal = { name: '低波蓄力爆發前', icon: '📉', stars: 3,
        desc: `年化波動率僅 ${lastHV.toFixed(1)}% 且持續收縮，市場極度平靜，蓄力爆發前兆。` };
      score = 3;
    } else if (isExtreme && isExpanding) {
      signal = { name: '極端波動擴張', icon: '⚠️', stars: 2,
        desc: `年化波動率高達 ${lastHV.toFixed(1)}% 且仍在擴大，風險極高，建議縮小部位。` };
      score = 2;
    } else if (isExtreme && isContracting) {
      signal = { name: '極端波動回落', icon: '🟡', stars: 3,
        desc: `年化波動率 ${lastHV.toFixed(1)}% 開始收縮，市場情緒從極端狀態回穩，但仍偏高。` };
      score = 3;
    } else if (isNormal && isContracting) {
      signal = { name: '波動正常收縮', icon: '✅', stars: 4,
        desc: `波動率 ${lastHV.toFixed(1)}% 在正常範圍且收縮中，市場趨於穩定，技術訊號可靠性高。` };
      score = 4;
    } else if (isNormal && isExpanding) {
      signal = { name: '波動正常擴張', icon: '📊', stars: 3,
        desc: `波動率 ${lastHV.toFixed(1)}% 上升中，市場活躍度提升，趨勢行情可能正在形成。` };
      score = 3;
    } else if (isHigh) {
      signal = { name: '高波動風險區', icon: '🔴', stars: 2,
        desc: `年化波動率 ${lastHV.toFixed(1)}%，市場波動偏高，操作需縮減部位、放寬停損。` };
      score = 2;
    } else if (isLow) {
      signal = { name: '低波動整理中', icon: '⏸', stars: 3,
        desc: `年化波動率僅 ${lastHV.toFixed(1)}%，市場平靜整理，等待方向性突破。` };
      score = 3;
    } else {
      signal = { name: '波動率正常', icon: '✅', stars: 3,
        desc: `年化波動率 ${lastHV.toFixed(1)}%，在正常範圍內，技術指標環境良好。` };
      score = 3;
    }

    return {
      score, signal, items,
      raw: { lastHV, prevHV, hvMom, minHV, maxHV, avgHV, hvRank,
             isLow, isNormal, isHigh, isExtreme,
             isExpanding, isContracting, hv5Change, dailyVol, dailyRange,
             hvArr, n, lastIdx, closePrice: closes[n-1] },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'hv', name: '🟢 HV(20)', value: `${ev.raw.lastHV?.toFixed(1) ?? '—'}%`, color: '#34d399',
        tooltip: '歷史波動率（年化%），20日對數報酬標準差 × √252' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📉 HV</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">📉</span><span class="fs-title">HV 歷史波動率</span>
      </div><div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 21 根 K 線）</p>
      </div>`;
    }
    const r = ev.raw;
    const fmt = v => `${v?.toFixed(1) ?? '—'}%`;
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';
    const hvColor = r.isExtreme ? '#ef5350' : r.isHigh ? '#f59e0b' : r.isNormal ? '#34d399' : '#8a8f99';
    const hvPct = Math.min(r.lastHV / 80 * 100, 100);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📉</span>
        <span class="fs-title">HV 歷史波動率</span>
        <span class="fs-subtitle">Historical Volatility · HV(20) 年化波動率風險評估</span>
      </div>
      <div class="fs-deep-module-body">
        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">${ev.items.map(_renderReadoutItem).join('')}</div>
          <div class="fs-readout-summary">
            <span class="fs-signal-icon">${ev.signal.icon}</span>
            <div class="fs-signal-text">
              <span class="fs-signal-name">${ev.signal.name}</span>
              <span class="fs-signal-desc">${ev.signal.desc}</span>
            </div>
            <span class="fs-signal-stars">${stars}</span>
          </div>
        </div>

        <div class="fs-keylevels">
          <h4>📍 HV 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(52,211,153,0.18);color:#6ee7b7">HV(20)</span>
            <span class="fs-keylevel-price" style="color:${hvColor}">${fmt(r.lastHV)}</span>
            <span class="fs-keylevel-desc">${r.isExtreme ? '🔴 極高波動' : r.isHigh ? '🟡 高波動' : r.isNormal ? '✅ 正常' : '⚪ 低波動'}　${r.hvMom > 0 ? '↑ 走高' : r.hvMom < 0 ? '↓ 走低' : '→ 持平'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(52,211,153,0.12);color:#6ee7b7">日波動</span>
            <span class="fs-keylevel-price">±${r.dailyVol.toFixed(1)}%</span>
            <span class="fs-keylevel-desc">每日約 ±${r.dailyRange.toFixed(0)} 元（現價 ${r.closePrice.toFixed(2)} 元）</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(52,211,153,0.10);color:#6ee7b7">近20根</span>
            <span class="fs-keylevel-price">${r.hvRank.toFixed(0)}%位</span>
            <span class="fs-keylevel-desc">最低 ${r.minHV.toFixed(1)}% / 均值 ${r.avgHV.toFixed(1)}% / 最高 ${r.maxHV.toFixed(1)}%</span>
          </div>
          <div style="padding:8px 14px 4px;font-size:11px;color:var(--muted)">
            HV 水準（0~80%+）
            <div style="margin-top:4px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${hvPct}%;background:${hvColor};border-radius:3px"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;font-size:10px">
              <span>0 沉寂</span><span>20 正常↓</span><span>40 正常↑</span><span>60 高</span><span>80%+</span>
            </div>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 風險管理建議 — 根據 ${ev.signal.icon} ${ev.signal.name}</div>
          <div class="fs-action-guide-body">
            ${_hvActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 📉 HV 指標原理 ━━━</h4>
            <p><strong>公式</strong>：HV = σ(近N日對數報酬率) × √252 × 100%</p>
            <p>本系統使用 N=20（約一個月），年化係數 √252（每年交易日數）</p>
            <p style="margin-top:8px">HV 回答的問題：<strong>「這支股票過去一個月平均每天在動多少？」</strong> 年化後可以和選擇權的隱含波動率（IV）比較，判斷期權是否被高估。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 HV 的實戰用途 ━━━</h4>
            <ul>
              <li><strong>設定停損點</strong>：停損距離 ≥ 1.5~2 倍日波動，避免被正常波動洗出</li>
              <li><strong>決定部位大小</strong>：HV 高 → 部位縮小；HV 低 → 部位可適當放大</li>
              <li><strong>判斷波動率週期</strong>：HV 從低位擴張 = 趨勢行情開始；HV 從高位收縮 = 市場回穩</li>
              <li><strong>與其他指標搭配</strong>：HV 低位 + 布林 Squeeze = 雙重蓄力訊號，突破後動能更強</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>只看過去，不預測未來</strong>：HV 是歷史數據，不直接告訴你未來波動率</li>
              <li><strong>波動率聚集效應</strong>：高波動後往往還是高波動（一次大跌後還有大跌），低波動後也相對平靜</li>
              <li><strong>無方向訊號</strong>：HV 只告訴你波動大小，不告訴你漲還是跌，需搭配方向性指標</li>
            </ul>
          </div>
        </div>

        ${renderAISection('hv', 'HV 歷史波動率', '📉', ev, (() => {
          const fmt = v => `${v?.toFixed(1) ?? '—'}%`;
          const recent5 = r.hvArr.slice(-5).filter(v => v !== null).map((v, i, a) => {
            const label = i === a.length - 1 ? '【當根】' : `【-${a.length - 1 - i}根】`;
            const lvl = v >= 60 ? '極高' : v >= 40 ? '高' : v >= 20 ? '正常' : '低';
            return `${label}${v.toFixed(1)}%(${lvl})`;
          }).join(' → ');
          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          return {
            'HV(20)年化波動率': `${fmt(r.lastHV)}（${r.isExtreme ? '極高≥60%' : r.isHigh ? '高40~60%' : r.isNormal ? '正常20~40%' : '低<20%'}）`,
            'HV動能【正=波動擴張，負=收縮】': `${r.hvMom > 0 ? '+' : ''}${r.hvMom.toFixed(1)}%（${r.isExpanding ? '擴張中' : r.isContracting ? '收縮中' : '持平'}）`,
            '近20根百分位【低位=蓄力，高位=過熱】': `${r.hvRank.toFixed(0)}%（最低${r.minHV.toFixed(1)}% / 均值${r.avgHV.toFixed(1)}% / 最高${r.maxHV.toFixed(1)}%）`,
            '每日等效波動【停損設定參考】': `±${r.dailyVol.toFixed(1)}%（現價${r.closePrice.toFixed(2)}元 → 每日±${r.dailyRange.toFixed(0)}元）`,
            '建議停損距離【至少1.5~2倍日波動】': `±${(r.dailyVol * 1.5).toFixed(1)}% ~ ±${(r.dailyVol * 2).toFixed(1)}%（約±${(r.dailyRange * 1.5).toFixed(0)} ~ ±${(r.dailyRange * 2).toFixed(0)}元）`,
            '近5根HV走勢【由舊到新，最右為當根】': recent5,
            [`各條件達成狀態【共${ev.items.length}項，✅${ev.items.filter(i=>i.ok===true).length}達標 ❌${ev.items.filter(i=>i.ok===false).length}未達標】`]:
              itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}
      </div>
    `;
  },
};

function _hvActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;
  const stopPct  = (r.dailyVol * 1.5).toFixed(1);
  const stopPct2 = (r.dailyVol * 2).toFixed(1);
  const stopAmt  = (r.dailyRange * 1.5).toFixed(0);

  if (sig === '低波蓄力爆發前') return [
    { label: '策略', detail: `<strong>等待突破方向</strong>。低波動是蓄力期，突破時動能通常很猛，準備好方向後跟上` },
    { label: '停損設定', detail: `目前日波動 ±${r.dailyVol.toFixed(1)}%，建議停損設在 <strong>±${stopPct2}%</strong>（約 ±${(r.dailyRange * 2).toFixed(0)} 元）` },
    { label: '部位建議', detail: `低波動期可維持正常部位，突破後若 HV 快速擴張，可縮減到 70%` },
    { label: '注意事項', detail: `低波動 + 布林 Squeeze 同時出現，突破後的行情往往更大` },
  ];
  if (sig === '極端波動擴張') return [
    { label: '風險警告', detail: `<strong>大幅縮減部位</strong>。日波動達 ±${r.dailyVol.toFixed(1)}%，正常持倉風險是平時的 ${(r.lastHV / 25).toFixed(1)} 倍` },
    { label: '停損設定', detail: `停損需放寬至 ±${stopPct2}%（約 ±${(r.dailyRange * 2).toFixed(0)} 元），否則正常波動就會觸發` },
    { label: '部位建議', detail: `建議縮減至正常部位的 ${Math.max(30, 100 - r.lastHV).toFixed(0)}%，用小部位換心安` },
    { label: '注意事項', detail: `極端波動通常是非理性的，等 HV 從高位開始收縮再恢復正常操作` },
  ];
  if (sig === '波動正常收縮') return [
    { label: '操作環境', detail: `<strong>最佳操作環境</strong>。波動正常且收縮，技術訊號可靠，停損點清晰` },
    { label: '停損設定', detail: `建議停損設在 ±${stopPct}%（約 ±${stopAmt} 元，1.5倍日波動）` },
    { label: '部位建議', detail: `可維持正常部位，環境良好，依技術訊號操作即可` },
    { label: '注意事項', detail: `若 HV 持續收縮接近歷史低位，可能進入蓄力期，留意突破訊號` },
  ];
  // 其他情境
  return [
    { label: '停損設定', detail: `依當前日波動 ±${r.dailyVol.toFixed(1)}%，建議停損 ±${stopPct}% ~ ±${stopPct2}%（約 ±${stopAmt} 元）` },
    { label: '部位建議', detail: r.isHigh ? `高波動環境建議縮減部位至 60~70%` : r.isLow ? `低波動可維持正常部位，等待方向突破` : `波動正常，正常部位操作` },
    { label: '關鍵觀察', detail: `HV 是否從低位擴張（趨勢行情開始），或從高位收縮（市場回穩）` },
    { label: '注意事項', detail: `HV 無方向訊號，需搭配 KD/MACD/EMA 判斷買賣方向` },
  ];
}

registerAnalysisModule(HVModule);
