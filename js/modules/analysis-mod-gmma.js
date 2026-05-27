/* js/modules/analysis-mod-gmma.js
 * 🌟 GMMA Golden Board Module
 */
import { AppState } from '../state.js';
import { calcGMMA } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const GMMAModule = {
  id: 'gmma',
  name: 'GMMA 顧比均線',
  icon: '🌊',
  candleMinLen: 62,  // EMA60 需 62 根

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const { short, long } = calcGMMA(closes);

    // 短期組最新值：EMA(3,5,8,10,12,15)
    const shortVals = short.map(arr => arr[n - 1]);
    const longVals  = long.map(arr  => arr[n - 1]);
    const shortMin  = Math.min(...shortVals);
    const shortMax  = Math.max(...shortVals);
    const longMin   = Math.min(...longVals);
    const longMax   = Math.max(...longVals);

    // 前一根
    const shortPrev = short.map(arr => arr[n - 2] ?? arr[n - 1]);
    const longPrev  = long.map(arr  => arr[n - 2] ?? arr[n - 1]);

    // 多頭/空頭排列判斷
    const bullAlign = shortMin > longMax;   // 短期全部 > 長期全部
    const bearAlign = shortMax < longMin;   // 短期全部 < 長期全部

    // 短期組方向（多數線是否向上）
    const shortUp   = shortVals.filter((v, i) => v > shortPrev[i]).length;
    const longUp    = longVals.filter((v,  i) => v > longPrev[i]).length;
    const shortBull = shortUp >= 4;  // 6條中至少4條向上
    const longBull  = longUp  >= 4;

    // 短期組間距（壓縮=醞釀，擴張=確認）
    const shortSpread = shortMax - shortMin;
    const longSpread  = longMax  - longMin;
    const prevShortMin = Math.min(...shortPrev);
    const prevShortMax = Math.max(...shortPrev);
    const shortExpanding = shortSpread > (prevShortMax - prevShortMin);

    // 穿越偵測：短期組整體是否剛穿越長期組
    const wasBull = Math.min(...shortPrev) > Math.max(...longPrev);
    const wasBear = Math.max(...shortPrev) < Math.min(...longPrev);
    const crossBull = !wasBull && bullAlign;  // 剛形成多頭排列
    const crossBear = !wasBear && bearAlign;  // 剛形成空頭排列

    // 中間地帶（兩組交錯）
    const interleaved = !bullAlign && !bearAlign;

    const items = [];

    // 條件 1：多空排列
    if (bullAlign) {
      items.push({ ok: true,
        text: `<strong>多頭排列</strong>：短期組（${shortMin.toFixed(0)}~${shortMax.toFixed(0)}）完全高於長期組（${longMin.toFixed(0)}~${longMax.toFixed(0)}）`,
        sub: `短期 6 條均線全部在長期 6 條上方，趨勢一致向上`,
        whyTitle: '為什麼 GMMA 多頭排列這麼重要？',
        why: '短期均線群（EMA3~15）代表投機/短線資金方向；長期均線群（EMA30~60）代表機構/長線資金方向。兩群都向上 + 短期在長期上方，代表不同週期的資金全部站多，是最強的多頭確認訊號，假訊號極少。',
      });
    } else if (bearAlign) {
      items.push({ ok: false,
        text: `<strong>空頭排列</strong>：短期組（${shortMin.toFixed(0)}~${shortMax.toFixed(0)}）完全低於長期組（${longMin.toFixed(0)}~${longMax.toFixed(0)}）`,
        sub: `短期 6 條均線全部在長期 6 條下方，趨勢一致向下`,
        whyTitle: '為什麼 GMMA 空頭排列是強烈警訊？',
        why: '短期均線群全部在長期均線群下方，代表投機資金和機構資金都已轉空，是最強的空頭確認訊號，這種格局下反彈通常只是賣出機會。',
      });
    } else {
      const aboveCount = shortVals.filter(v => v > longMax).length;
      items.push({ ok: null,
        text: `<strong>交錯整理</strong>：短期組與長期組交錯，無明確排列`,
        sub: `短期組 ${shortMin.toFixed(0)}~${shortMax.toFixed(0)}，長期組 ${longMin.toFixed(0)}~${longMax.toFixed(0)}，方向混亂中`,
        whyTitle: '交錯整理代表什麼？',
        why: '兩組均線交錯代表短線資金和長線資金方向不一致，市場正在尋找新的方向。這個狀態下以等待為主，等待明確的多頭或空頭排列形成。',
      });
    }

    // 條件 2：短期組方向（動能）
    items.push({ ok: shortBull,
      text: `<strong>短期組動能</strong>：${shortVals.filter((v,i) => v > shortPrev[i]).length}/6 條向上`,
      sub: `短期均線群（EMA3~15）方向：${shortBull ? '多數向上，短線買氣強' : '多數向下，短線賣壓重'}`,
      whyTitle: '為什麼看短期組的方向？',
      why: '短期均線群反映近期投機資金的動向，是趨勢的「引擎」。短期組多數向上代表短線買氣持續，趨勢延伸中；短期組開始轉向，即使長期組仍向上，也是趨勢動能衰退的早期訊號。',
    });

    // 條件 3：長期組方向（趨勢結構）
    items.push({ ok: longBull,
      text: `<strong>長期組方向</strong>：${longVals.filter((v,i) => v > longPrev[i]).length}/6 條向上`,
      sub: `長期均線群（EMA30~60）方向：${longBull ? '多數向上，機構資金做多' : '多數向下，機構資金偏空'}`,
      whyTitle: '為什麼長期組方向更重要？',
      why: '長期均線群代表機構法人和長線投資者的成本。長期組向上代表機構整體持多；長期組向下代表機構整體偏空。沿著長期組方向操作，等於跟著最大資金的方向走。',
    });

    // 條件 4：均線間距（壓縮 or 擴張）
    items.push({ ok: shortExpanding && bullAlign,
      text: `<strong>短期組間距</strong>：${shortExpanding ? '擴張（動能確立）' : '壓縮（醞釀方向）'}`,
      sub: `短期組間距 ${shortSpread.toFixed(2)}，長期組間距 ${longSpread.toFixed(2)}`,
      whyTitle: '為什麼均線間距很重要？',
      why: '均線群壓縮（間距收窄）代表不同週期的均線集中在一起，是蓄力整理的訊號；間距擴張代表趨勢確立，資金朝同一方向集中加速。多頭排列 + 短期組間距擴張 = 趨勢最強狀態。',
    });

    // 綜合訊號
    let signal, score;
    if (crossBull) {
      signal = { name: '多頭穿越', icon: '🌊', stars: 5, desc: '短期均線群剛全部穿越長期均線群上方，趨勢啟動訊號，可靠性極高。' }; score = 5;
    } else if (crossBear) {
      signal = { name: '空頭穿越', icon: '📉', stars: 1, desc: '短期均線群剛全部跌破長期均線群下方，空頭趨勢啟動，立即出場。' }; score = 1;
    } else if (bullAlign && shortBull && longBull && shortExpanding) {
      signal = { name: '多頭完美排列', icon: '🌊', stars: 5, desc: '多頭排列 + 兩組同向上 + 間距擴張，趨勢最強狀態，順勢持多。' }; score = 5;
    } else if (bullAlign && shortBull) {
      signal = { name: '多頭趨勢', icon: '🔵', stars: 4, desc: '短期組在長期組上方且短線向上，多頭趨勢延伸中。' }; score = 4;
    } else if (bullAlign) {
      signal = { name: '多頭排列', icon: '🟢', stars: 3, desc: '多頭排列確立，但短期組動能稍緩，等待再次確認。' }; score = 3;
    } else if (bearAlign && !shortBull && !longBull) {
      signal = { name: '空頭趨勢', icon: '🔴', stars: 2, desc: '空頭排列 + 兩組向下，空頭趨勢持續，避免做多。' }; score = 2;
    } else if (bearAlign) {
      signal = { name: '空頭排列', icon: '⚪', stars: 2, desc: '空頭排列確立，做多風險高。' }; score = 2;
    } else if (interleaved && shortBull) {
      signal = { name: '多頭醞釀', icon: '🟡', stars: 3, desc: '兩組交錯但短線向上，可能正在形成多頭排列，小量試單。' }; score = 3;
    } else {
      signal = { name: '方向混沌', icon: '⏸', stars: 2, desc: '兩組均線交錯，多空不明，等待方向確認。' }; score = 2;
    }

    return { score, signal, items,
      raw: { shortVals, longVals, shortMin, shortMax, longMin, longMax,
             bullAlign, bearAlign, crossBull, crossBear, interleaved,
             shortBull, longBull, shortExpanding, shortSpread, longSpread, n } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'gmma-short', name: '🔴 短期組', value: `${ev.raw.shortMin.toFixed(0)}~${ev.raw.shortMax.toFixed(0)}`, color: 'rgba(239,83,80,0.7)', tooltip: 'EMA(3,5,8,10,12,15)，投機資金方向' },
      { id: 'gmma-long',  name: '🟢 長期組', value: `${ev.raw.longMin.toFixed(0)}~${ev.raw.longMax.toFixed(0)}`,  color: 'rgba(38,166,154,0.7)', tooltip: 'EMA(30,35,40,45,50,60)，機構資金方向' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🌊 GMMA</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">🌊</span><span class="fs-title">GMMA 顧比均線</span></div>
      <div class="fs-deep-module-body"><p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 62 根 K 線）</p></div>`;

    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';

    const shortLabel = r.bullAlign ? '🔴 短期（上）' : r.bearAlign ? '🔴 短期（下）' : '🔴 短期（交錯）';
    const longLabel  = r.bullAlign ? '🟢 長期（下）' : r.bearAlign ? '🟢 長期（上）' : '🟢 長期（交錯）';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🌊</span>
        <span class="fs-title">GMMA 顧比均線</span>
        <span class="fs-subtitle">Guppy Multiple Moving Average · 12條 EMA 雙群排列判讀</span>
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
          <h4>📍 GMMA 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">${shortLabel}</span>
            <span class="fs-keylevel-price">${r.shortMin.toFixed(0)} ~ ${r.shortMax.toFixed(0)}</span>
            <span class="fs-keylevel-desc">EMA3~15　${r.shortBull ? '多數↑ 短線買氣強' : '多數↓ 短線賣壓重'}　間距 ${r.shortSpread.toFixed(1)}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(38,166,154,0.18);color:#6ee7b7">${longLabel}</span>
            <span class="fs-keylevel-price">${r.longMin.toFixed(0)} ~ ${r.longMax.toFixed(0)}</span>
            <span class="fs-keylevel-desc">EMA30~60　${r.longBull ? '多數↑ 機構資金做多' : '多數↓ 機構資金偏空'}　間距 ${r.longSpread.toFixed(1)}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(59,130,246,0.18);color:#93c5fd">排列狀態</span>
            <span class="fs-keylevel-price">${r.bullAlign ? '多頭✅' : r.bearAlign ? '空頭❌' : '交錯⏸'}</span>
            <span class="fs-keylevel-desc">${r.crossBull ? '🌊 剛形成多頭穿越！' : r.crossBear ? '⚠️ 剛形成空頭穿越！' : r.shortExpanding ? '短期組間距擴張（趨勢確立）' : '短期組間距收縮（醞釀中）'}</span>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_gmmaActionRows(ev).map(row => `<div class="fs-action-row"><span class="fs-action-label">${row.label}</span><span class="fs-action-detail">${row.detail}</span></div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🌊 GMMA 指標原理 ━━━</h4>
            <p><strong>短期均線群</strong>：EMA(3, 5, 8, 10, 12, 15) — 反映投機者/短線資金動向</p>
            <p><strong>長期均線群</strong>：EMA(30, 35, 40, 45, 50, 60) — 反映機構法人/長線資金動向</p>
            <p style="margin-top:8px">GMMA 由澳洲交易員 Daryl Guppy 開發。核心洞見：不同週期的資金使用不同的均線，將它們分成兩群，可以直觀看出「投機資金和長線資金是否一致」。兩群一致向上時，趨勢最可靠。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 核心訊號 ━━━</h4>
            <ul>
              <li><strong>多頭穿越</strong>：短期群剛全部穿越長期群 → 最強買進訊號，假訊號極少</li>
              <li><strong>多頭完美排列</strong>：兩群都向上 + 短期在長期上方 + 間距擴張 → 最強持多狀態</li>
              <li><strong>短期群壓縮後穿越長期群</strong>：Squeeze 後的 GMMA 穿越，動能最強</li>
              <li><strong>長期群向上但短期群轉向下</strong>：短線回調，長線仍多，可能是加碼機會</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>需要 62 根 K 線</strong>：1mo(20根)、3mo(60根) 都不夠，建議 6mo 以上</li>
              <li><strong>12 條線視覺較複雜</strong>：初學者可先只看兩群的整體方向，不必看每一條</li>
              <li><strong>滯後性</strong>：12條均線都有滯後，趨勢剛啟動時訊號還不明確</li>
              <li><strong>震盪盤兩群交錯嚴重</strong>：交錯期不要操作，等待分離</li>
            </ul>
          </div>
        </div>

        ${renderAISection('gmma', 'GMMA 顧比均線', '🌊', ev, {
          '短期均線群範圍【EMA3~15，投機資金】': `${r.shortMin.toFixed(1)} ~ ${r.shortMax.toFixed(1)}（間距${r.shortSpread.toFixed(1)}，${r.shortBull ? '多數向上' : '多數向下'}）`,
          '長期均線群範圍【EMA30~60，機構資金】': `${r.longMin.toFixed(1)} ~ ${r.longMax.toFixed(1)}（間距${r.longSpread.toFixed(1)}，${r.longBull ? '多數向上' : '多數向下'}）`,
          '雙群排列狀態': r.bullAlign ? '✅ 多頭排列（短期全在長期上方）' : r.bearAlign ? '❌ 空頭排列（短期全在長期下方）' : '⏸ 交錯整理（兩群混合）',
          '近期穿越事件': r.crossBull ? '🌊 剛形成多頭穿越（最強買進訊號）' : r.crossBear ? '⚠️ 剛形成空頭穿越（立即出場訊號）' : '無穿越',
          '短期組動能【6條中向上根數】': `${r.shortVals.filter((v,i) => v > (r.shortVals[i] ?? v)).length}/6 向上（短線${r.shortBull ? '買氣強' : '賣壓重'}）`,
          '長期組動能【6條中向上根數】': `${r.longBull ? '多數向上（機構做多）' : '多數向下（機構偏空）'}`,
          '短期組間距變化【擴=趨勢確立，縮=醞釀】': `${r.shortExpanding ? '擴張中（動能確立）' : '收縮中（醞釀方向）'}，間距 ${r.shortSpread.toFixed(1)}`,
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>
    `;
  },
};

function _gmmaActionRows(ev) {
  const r = ev.raw, fmt = v => v?.toFixed(1) ?? '—';
  const sig = ev.signal.name;
  if (sig === '多頭穿越' || sig === '多頭完美排列') return [
    { label: '進場建議', detail: `<strong>積極做多</strong>。GMMA 穿越/完美排列是最可靠的多頭訊號，可進 50~70%` },
    { label: '加碼條件', detail: `短期組間距持續擴張 + 長期組也向上拉開 → 趨勢加速，加碼至滿倉` },
    { label: '停損設置', detail: `短期組整體跌入長期組（兩群開始交錯）→ 減碼；穿越失效 → 出場` },
    { label: '注意事項', detail: `GMMA 穿越後的第一波反彈到長期組附近通常是加碼機會，不是出場訊號` },
  ];
  if (sig === '多頭趨勢' || sig === '多頭排列') return [
    { label: '持倉建議', detail: `<strong>多單留倉</strong>，兩群分離清楚，趨勢健康` },
    { label: '加碼條件', detail: `短期組壓縮後再度擴張 → 趨勢再加速，可加碼` },
    { label: '停損設置', detail: `短期組整體開始向下切入長期組 → 減碼` },
    { label: '注意事項', detail: `${r.shortBull ? '短線動能強，趨勢延伸中' : '短線動能稍緩，等確認再加碼'}` },
  ];
  if (sig === '空頭趨勢' || sig === '空頭排列' || sig === '空頭穿越') return [
    { label: '操作建議', detail: `<strong>避免做多</strong>，空頭格局明確，等待 GMMA 穿越向上再評估` },
    { label: '反彈壓力', detail: `短期組反彈到長期組下緣附近受壓，是再次確認空頭的機會` },
    { label: '轉多條件', detail: `短期群穿越長期群上方（多頭穿越）→ 才考慮做多` },
    { label: '注意事項', detail: `GMMA 空頭排列是強力訊號，不要輕易逆勢` },
  ];
  if (sig === '多頭醞釀') return [
    { label: '進場建議', detail: `可試單 20~30%，短線向上但排列未完成，<strong>等穿越確認再加碼</strong>` },
    { label: '加碼條件', detail: `短期群全部站上長期群上方（完成多頭穿越）→ 加碼至 60%` },
    { label: '停損設置', detail: `短期群再度跌回長期群下方 → 出場` },
    { label: '注意事項', detail: `醞釀期假訊號多，保守操作` },
  ];
  return [
    { label: '操作建議', detail: `觀望，等待 <strong>兩群分離確認方向</strong>再進場` },
    { label: '關鍵觀察', detail: `短期群是否開始穿越長期群，間距是否開始擴張` },
    { label: '注意事項', detail: `GMMA 交錯期不操作，以其他指標（KD/MACD）的方向為主` },
  ];
}

registerAnalysisModule(GMMAModule);
