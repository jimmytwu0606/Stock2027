/* js/modules/analysis-mod-sar.js
 * 🌟 SAR Golden Board Module
 */
import { AppState } from '../state.js';
import { calcSAR } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const SARModule = {
  id: 'sar',
  name: 'SAR 拋物線',
  icon: '☄️',
  candleMinLen: 32,

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const sarArr = calcSAR(candles);

    let lastIdx = n - 1;
    while (lastIdx > 0 && sarArr[lastIdx] === null) lastIdx--;

    const lastSAR   = sarArr[lastIdx];
    const prevSAR   = sarArr[lastIdx - 1] ?? lastSAR;
    const lastClose = closes[n - 1];
    const prevClose = closes[n - 2] ?? lastClose;

    const isBull = lastClose > lastSAR;   // SAR 在下方 = 多頭
    const wasBull = prevClose > prevSAR;

    // 近3根翻轉偵測
    let flippedBull = false, flippedBear = false;
    for (let i = Math.max(1, lastIdx - 2); i <= lastIdx; i++) {
      if (sarArr[i] === null || sarArr[i-1] === null) continue;
      const curBull  = closes[i]   > sarArr[i];
      const prevBull = closes[i-1] > sarArr[i-1];
      if (!prevBull && curBull)  flippedBull = true;
      if (prevBull  && !curBull) flippedBear = true;
    }

    // SAR 距離（%）
    const sarDist = Math.abs((lastClose - lastSAR) / lastClose * 100);
    // SAR 移動方向
    const sarMove = lastSAR - prevSAR;

    const items = [];

    // 條件 1：多空方向
    items.push({ ok: isBull,
      text: isBull
        ? `<strong>多頭格局</strong>：SAR ${lastSAR.toFixed(2)} 在收盤下方（${sarDist.toFixed(1)}%）`
        : `<strong>空頭格局</strong>：SAR ${lastSAR.toFixed(2)} 在收盤上方（${sarDist.toFixed(1)}%）`,
      sub: `收盤 ${lastClose.toFixed(2)}，SAR 在${isBull ? '下方' : '上方'} ${sarDist.toFixed(1)}%，作為${isBull ? '支撐' : '壓力'}`,
      whyTitle: '為什麼 SAR 在下方是多頭？',
      why: 'SAR（拋物線止損點）在收盤下方代表多頭趨勢，SAR 是動態支撐線；SAR 在收盤上方代表空頭趨勢，SAR 是動態壓力線。SAR 一旦翻轉（從下跳到上或從上跳到下），代表趨勢反轉，是最清晰的方向性訊號之一。',
    });

    // 條件 2：SAR 翻轉（近3根）
    if (flippedBull) {
      items.push({ ok: true,
        text: `<strong>近期翻多</strong>：近 3 根 SAR 由上跳到下方（多頭啟動）`,
        sub: `SAR 從空頭壓力點轉為多頭支撐點，趨勢反轉向上`,
        whyTitle: 'SAR 翻多是什麼訊號？',
        why: 'SAR 從收盤上方跳到下方，代表空頭趨勢結束，多頭趨勢啟動。這是 SAR 最重要的買進訊號。SAR 翻轉的特點是一次性明確，不像 KD 可能出現多次假交叉。',
      });
    } else if (flippedBear) {
      items.push({ ok: false,
        text: `<strong>近期翻空</strong>：近 3 根 SAR 由下跳到上方（空頭啟動）`,
        sub: `SAR 從多頭支撐點轉為空頭壓力點，趨勢反轉向下`,
        whyTitle: 'SAR 翻空是什麼訊號？',
        why: 'SAR 從收盤下方跳到上方，代表多頭趨勢結束，空頭趨勢啟動。是明確的賣出/止損訊號。SAR 翻空後，原本的支撐點就成了上方的壓力。',
      });
    } else {
      items.push({ ok: isBull,
        text: `<strong>趨勢延伸</strong>：${isBull ? '多頭 SAR 持續在下方' : '空頭 SAR 持續在上方'}，無近期翻轉`,
        sub: `SAR 持續朝${isBull ? '上' : '下'}移動，趨勢穩定延伸中`,
        whyTitle: '趨勢延伸中 SAR 怎麼用？',
        why: '沒有翻轉代表趨勢仍在延伸。這時候 SAR 是動態的停損/止盈參考點。多頭持有者可將停損設在 SAR 點位，跌破即停損；SAR 會隨趨勢延伸自動上移，幫助「讓利潤奔跑」。',
      });
    }

    // 條件 3：SAR 距離（越近越危險）
    items.push({ ok: sarDist > 3,
      text: sarDist < 2
        ? `<strong>SAR 極近</strong>：距現價僅 ${sarDist.toFixed(1)}%，翻轉風險高`
        : sarDist < 4
        ? `<strong>SAR 接近</strong>：距現價 ${sarDist.toFixed(1)}%，需留意`
        : `<strong>SAR 安全距離</strong>：距現價 ${sarDist.toFixed(1)}%，趨勢穩定`,
      sub: `SAR ${lastSAR.toFixed(2)}，現價 ${lastClose.toFixed(2)}，距離 ${sarDist.toFixed(1)}%`,
      whyTitle: 'SAR 距離為什麼重要？',
      why: 'SAR 到現價的距離反映趨勢的「安全邊際」。距離越近，一旦出現逆向 K 線就可能觸發翻轉；距離越遠，趨勢越穩定、安全邊際越大。距離 < 2% 時需特別留意可能翻轉的風險。',
    });

    // 條件 4：SAR 移動速度
    items.push({ ok: isBull ? sarMove > 0 : sarMove < 0,
      text: `<strong>SAR 移動方向</strong>：${sarMove > 0 ? '↑ 向上移動' : sarMove < 0 ? '↓ 向下移動' : '→ 持平'}`,
      sub: `SAR 本根 ${lastSAR.toFixed(2)} vs 前根 ${prevSAR.toFixed(2)}（移動 ${sarMove > 0 ? '+' : ''}${sarMove.toFixed(2)}）`,
      whyTitle: 'SAR 移動方向代表什麼？',
      why: '多頭趨勢中 SAR 應該持續向上移動（追著股價上升）；空頭趨勢中 SAR 應持續向下移動。SAR 的移動速度由加速因子（AF）決定，每次創新高/低點 AF 增加，SAR 追得越快。',
    });

    // 綜合訊號
    let signal, score;
    if (flippedBull) {
      signal = { name: 'SAR 翻多', icon: '☄️', stars: 5, desc: 'SAR 由上跳到下方，多頭趨勢啟動，最強方向性訊號。' }; score = 5;
    } else if (flippedBear) {
      signal = { name: 'SAR 翻空', icon: '📉', stars: 1, desc: 'SAR 由下跳到上方，空頭趨勢啟動，立即出場的訊號。' }; score = 1;
    } else if (isBull && sarDist > 4) {
      signal = { name: '多頭穩定', icon: '🟢', stars: 4, desc: `SAR 在下方 ${sarDist.toFixed(1)}%，多頭趨勢穩定，安全邊際充足。` }; score = 4;
    } else if (!isBull && sarDist > 4) {
      signal = { name: '空頭穩定', icon: '🔴', stars: 2, desc: `SAR 在上方 ${sarDist.toFixed(1)}%，空頭趨勢穩定，避免做多。` }; score = 2;
    } else if (isBull && sarDist < 2) {
      signal = { name: '多頭翻轉警示', icon: '⚠️', stars: 3, desc: `SAR 距現價僅 ${sarDist.toFixed(1)}%，稍有回落就可能翻空，需留意。` }; score = 3;
    } else if (!isBull && sarDist < 2) {
      signal = { name: '空頭翻轉觀察', icon: '🟡', stars: 3, desc: `SAR 距現價僅 ${sarDist.toFixed(1)}%，稍有反彈就可能翻多，留意機會。` }; score = 3;
    } else {
      signal = { name: isBull ? '多頭延伸' : '空頭延伸', icon: isBull ? '🔵' : '⚪', stars: 3,
        desc: `${isBull ? '多頭' : '空頭'}趨勢持續延伸，SAR 作為動態${isBull ? '支撐' : '壓力'}。` }; score = 3;
    }

    return { score, signal, items,
      raw: { lastSAR, prevSAR, lastClose, isBull, flippedBull, flippedBear, sarDist, sarMove, n } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'sar', name: ev.raw.isBull ? '🔴 SAR(多)' : '🟢 SAR(空)',
        value: ev.raw.lastSAR?.toFixed(2) ?? '—',
        color: ev.raw.isBull ? '#ef5350' : '#26a69a',
        tooltip: 'SAR 在下方=多頭支撐，在上方=空頭壓力' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">☄️ SAR</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">☄️</span><span class="fs-title">SAR 拋物線</span></div>
      <div class="fs-deep-module-body"><p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 32 根 K 線）</p></div>`;

    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';
    const sarColor = r.isBull ? '#ef5350' : '#26a69a';
    const distPct = Math.min(r.sarDist / 10 * 100, 100);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">☄️</span>
        <span class="fs-title">SAR 拋物線指標</span>
        <span class="fs-subtitle">Parabolic SAR · 動態停損追蹤 + 趨勢方向判讀</span>
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
          <h4>📍 SAR 當前狀態</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(${r.isBull?'239,83,80':'38,166,154'},0.18);color:${sarColor}">SAR 點位</span>
            <span class="fs-keylevel-price" style="color:${sarColor}">${fmt(r.lastSAR)}</span>
            <span class="fs-keylevel-desc">${r.isBull ? '🔴 多頭支撐（在下方）' : '🟢 空頭壓力（在上方）'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(59,130,246,0.18);color:#93c5fd">現價</span>
            <span class="fs-keylevel-price">${fmt(r.lastClose)}</span>
            <span class="fs-keylevel-desc">距 SAR ${r.sarDist.toFixed(1)}%（${r.sarDist < 2 ? '⚠️ 極近，高翻轉風險' : r.sarDist < 4 ? '留意翻轉' : '安全邊際充足'}）</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(${r.isBull?'239,83,80':'38,166,154'},0.12);color:${sarColor}">SAR 動向</span>
            <span class="fs-keylevel-price">${r.sarMove > 0 ? '↑' : r.sarMove < 0 ? '↓' : '→'} ${r.sarMove > 0 ? '+' : ''}${r.sarMove.toFixed(2)}</span>
            <span class="fs-keylevel-desc">${r.isBull && r.sarMove > 0 ? '多頭 SAR 正常上移（追著股價）' : !r.isBull && r.sarMove < 0 ? '空頭 SAR 正常下移' : 'SAR 移動方向'}</span>
          </div>
          ${r.flippedBull ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(16,185,129,0.18);color:#6ee7b7">翻多訊號</span>
            <span class="fs-keylevel-price" style="color:#34d399">近期發生</span>
            <span class="fs-keylevel-desc">SAR 由上方跳到下方，多頭趨勢啟動</span>
          </div>` : ''}
          ${r.flippedBear ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">翻空訊號</span>
            <span class="fs-keylevel-price" style="color:#ef4444">近期發生</span>
            <span class="fs-keylevel-desc">SAR 由下方跳到上方，空頭趨勢啟動</span>
          </div>` : ''}
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_sarActionRows(ev).map(row => `<div class="fs-action-row"><span class="fs-action-label">${row.label}</span><span class="fs-action-detail">${row.detail}</span></div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ ☄️ SAR 指標原理 ━━━</h4>
            <p>SAR = 前期 SAR + AF × (EP - 前期 SAR)</p>
            <p><strong>AF（加速因子）</strong>：初始 0.02，每次創新高/低點增加 0.02，最大 0.20</p>
            <p><strong>EP（極值點）</strong>：多頭中的最高點，或空頭中的最低點</p>
            <p style="margin-top:8px">SAR 越走越快：趨勢越持續，AF 越大，SAR 追得越緊，「自動收緊停損」的特性讓趨勢操作者可以讓利潤奔跑。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 SAR 的最佳用法 ━━━</h4>
            <ul>
              <li><strong>趨勢跟蹤停損</strong>：持多單時，將停損設在 SAR 點位，收盤跌破 SAR 就停損</li>
              <li><strong>SAR 翻轉換手</strong>：SAR 翻多時做多，SAR 翻空時做空（適合趨勢行情）</li>
              <li><strong>SAR 距離越近越危險</strong>：距離 < 2% 時，輕微回調就可能觸發翻轉</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>震盪盤完全失效</strong>：上下震盪時 SAR 頻繁翻轉，會連續停損</li>
              <li><strong>適合有明確趨勢的市場</strong>：搭配 DMI/ADX 確認有趨勢再用 SAR</li>
              <li><strong>跳空開盤會失準</strong>：大跳空後 SAR 計算會出現偏差，需人工確認</li>
            </ul>
          </div>
        </div>

        ${renderAISection('sar', 'SAR 拋物線指標', '☄️', ev, {
          'SAR點位【多頭在下=支撐，空頭在上=壓力】': `${fmt(r.lastSAR)}（${r.isBull ? '在收盤下方，多頭' : '在收盤上方，空頭'}）`,
          '現價': fmt(r.lastClose),
          'SAR距現價【越近越危險，<2%高翻轉風險】': `${r.sarDist.toFixed(1)}%（${r.sarDist < 2 ? '⚠️ 極近' : r.sarDist < 4 ? '留意' : '安全'}）`,
          '趨勢方向': r.isBull ? '多頭（SAR在下方作為支撐）' : '空頭（SAR在上方作為壓力）',
          'SAR移動方向': `${r.sarMove > 0 ? '+' : ''}${r.sarMove.toFixed(2)}（${r.sarMove > 0 ? '↑上移' : r.sarMove < 0 ? '↓下移' : '持平'}）`,
          '近期翻轉偵測【近3根】': r.flippedBull ? '✅ 翻多（SAR從上方跳到下方，多頭啟動）' : r.flippedBear ? '⚠️ 翻空（SAR從下方跳到上方，空頭啟動）' : '無翻轉',
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>
    `;
  },
};

function _sarActionRows(ev) {
  const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
  const sig = ev.signal.name;
  if (sig === 'SAR 翻多') return [
    { label: '進場建議', detail: `<strong>積極做多</strong>。SAR 翻多是最強方向性訊號，可進 50~70% 部位` },
    { label: '停損設置', detail: `將停損設在 SAR 點位 <span class="fs-price">${fmt(r.lastSAR)}</span>，收盤跌破即停損` },
    { label: '持倉管理', detail: `每天更新停損到最新 SAR 點位，讓利潤奔跑` },
    { label: '注意事項', detail: `SAR 在震盪盤中翻轉頻繁，確認 DMI/ADX ≥ 25 再進場` },
  ];
  if (sig === 'SAR 翻空') return [
    { label: '操作建議', detail: `<strong>多單立即停損出場</strong>。SAR 翻空是明確的停損訊號` },
    { label: '反彈壓力', detail: `反彈到 SAR <span class="fs-price">${fmt(r.lastSAR)}</span> 附近會受壓，是再次確認空頭的機會` },
    { label: '轉多條件', detail: `SAR 再度翻多（跳回下方）→ 才重新考慮做多` },
    { label: '注意事項', detail: `不要在 SAR 翻空後硬撐，紀律停損是 SAR 使用的核心` },
  ];
  if (sig === '多頭翻轉警示') return [
    { label: '持倉建議', detail: `<strong>留意 SAR 僅距現價 ${r.sarDist.toFixed(1)}%</strong>，稍有回落就可能翻空，適當降低部位` },
    { label: '停損設置', detail: `停損設在 SAR <span class="fs-price">${fmt(r.lastSAR)}</span>，跌破立即出場` },
    { label: '加碼條件', detail: `SAR 距離拉開到 4% 以上 → 趨勢穩定，可恢復正常部位` },
    { label: '注意事項', detail: `SAR 極近通常出現在趨勢末段，謹慎追高` },
  ];
  if (sig === '多頭穩定') return [
    { label: '持倉建議', detail: `<strong>多單穩健持有</strong>。SAR 在下方 ${r.sarDist.toFixed(1)}%，趨勢穩定` },
    { label: '停損設置', detail: `動態停損設在每日最新 SAR 點位（今日 <span class="fs-price">${fmt(r.lastSAR)}</span>）` },
    { label: '加碼條件', detail: `SAR 持續上移 + 股價創新高 → 可加碼` },
    { label: '注意事項', detail: `不要因為短線回調就出場，看 SAR 有沒有翻轉才是關鍵` },
  ];
  return [
    { label: '操作建議', detail: r.isBull ? `多單持有，停損設在 SAR <span class="fs-price">${fmt(r.lastSAR)}</span>` : `空頭趨勢，避免做多，等 SAR 翻多訊號` },
    { label: '停損設置', detail: `收盤${r.isBull ? '跌破' : '站上'} SAR <span class="fs-price">${fmt(r.lastSAR)}</span> → 出場` },
    { label: '注意事項', detail: `SAR 需搭配 DMI/ADX 確認有趨勢，震盪盤不適用` },
  ];
}

registerAnalysisModule(SARModule);
