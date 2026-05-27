/* js/modules/analysis-mod-rci.js
 * 🌟 RCI Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcRCI } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ═══════════════════════════════════════════════════════
// 🌟 RCIModule — Golden Board
// RCI 順位相關係數：RCI9(橘)/RCI26(藍) 雙線 + 極值翻轉
// ═══════════════════════════════════════════════════════
const RCIModule = {
  id: 'rci',
  name: 'RCI 順位相關係數',
  icon: '🌀',
  candleMinLen: 27,  // calcRCI(n=26) 需要 26 根

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const rci9Arr  = calcRCI(closes, 9);
    const rci26Arr = calcRCI(closes, 26);

    let lastIdx = n - 1;
    while (lastIdx > 0 && (rci9Arr[lastIdx] === null || rci26Arr[lastIdx] === null)) lastIdx--;

    const lastRCI9  = rci9Arr[lastIdx];
    const lastRCI26 = rci26Arr[lastIdx];
    const prevRCI9  = rci9Arr[lastIdx - 1]  ?? lastRCI9;
    const prevRCI26 = rci26Arr[lastIdx - 1] ?? lastRCI26;

    const mom9  = lastRCI9  - prevRCI9;
    const mom26 = lastRCI26 - prevRCI26;

    // 近3根交叉偵測（RCI9 vs RCI26）
    let crossBull = false, crossBear = false;
    for (let i = Math.max(1, lastIdx - 2); i <= lastIdx; i++) {
      if (rci9Arr[i-1] !== null && rci26Arr[i-1] !== null) {
        if (rci9Arr[i-1] <= rci26Arr[i-1] && rci9Arr[i] > rci26Arr[i]) crossBull = true;
        if (rci9Arr[i-1] >= rci26Arr[i-1] && rci9Arr[i] < rci26Arr[i]) crossBear = true;
      }
    }

    // 極值翻轉偵測（±80 以上反轉，是最強訊號）
    const rci9Extreme  = Math.abs(prevRCI9)  >= 80 && Math.abs(lastRCI9)  < Math.abs(prevRCI9);
    const rci26Extreme = Math.abs(prevRCI26) >= 80 && Math.abs(lastRCI26) < Math.abs(prevRCI26);
    const bullReversal = (prevRCI9 <= -80 && mom9 > 0) || (prevRCI26 <= -80 && mom26 > 0);
    const bearReversal = (prevRCI9 >=  80 && mom9 < 0) || (prevRCI26 >=  80 && mom26 < 0);

    const items = [];

    // ── 條件 1：RCI9 位置 ──
    if (lastRCI9 >= 80) {
      items.push({
        ok: false,
        text: `<strong>RCI9 超買</strong>：${lastRCI9.toFixed(1)}（≥ +80，短線過熱）`,
        sub: `時間順序與價格順序高度正相關，近9日持續創新高`,
        whyTitle: 'RCI ≥ +80 為什麼是超買？',
        why: 'RCI ≥ +80 代表「最新的收盤最高、較舊的收盤較低」的相關性極強，即近N日價格持續上漲。這種高度正相關是短線過熱的表現，均值回歸機率高。極值翻轉（從+80以上開始下滑）是最強的賣出訊號。',
      });
    } else if (lastRCI9 <= -80) {
      items.push({
        ok: true,
        text: `<strong>RCI9 超賣</strong>：${lastRCI9.toFixed(1)}（≤ -80，短線超跌）`,
        sub: `時間順序與價格順序高度負相關，近9日持續創新低`,
        whyTitle: 'RCI ≤ -80 為什麼是超賣？',
        why: 'RCI ≤ -80 代表「最新的收盤最低、較舊的收盤較高」的相關性極強，即近N日持續下跌。這種高度負相關是短線超跌的表現。極值翻轉（從-80以下開始回升）是 RCI 最可靠的買進訊號。',
      });
    } else {
      items.push({
        ok: lastRCI9 > 0,
        text: `<strong>RCI9 中性區</strong>：${lastRCI9.toFixed(1)}（${lastRCI9 > 0 ? '偏多' : '偏空'}）`,
        sub: `短線時間價格相關性適中，${lastRCI9 > 0 ? '多方略占優' : '空方略占優'}`,
        whyTitle: 'RCI 在 ±80 之間代表什麼？',
        why: 'RCI 在 ±80 之間代表時間與價格的排序沒有極端的一致性，市場沒有明確的單邊趨勢。RCI > 0 偏多，RCI < 0 偏空，但可靠性不如極值翻轉訊號強。',
      });
    }

    // ── 條件 2：RCI26 位置（中長線）──
    if (lastRCI26 >= 80) {
      items.push({
        ok: false,
        text: `<strong>RCI26 超買</strong>：${lastRCI26.toFixed(1)}（中長線過熱）`,
        sub: `近26日時間與價格高度正相關，中長線動能過熱`,
        whyTitle: '為什麼 RCI26 更重要？',
        why: 'RCI26 涵蓋約一個月的交易週期，代表中長線趨勢動能。RCI26 達到極值時，代表中長線動能已經到頂（或底），後續均值回歸的力道比 RCI9 更強、持續時間更長。',
      });
    } else if (lastRCI26 <= -80) {
      items.push({
        ok: true,
        text: `<strong>RCI26 超賣</strong>：${lastRCI26.toFixed(1)}（中長線超跌）`,
        sub: `近26日時間與價格高度負相關，中長線動能超跌`,
        whyTitle: '為什麼 RCI26 更重要？',
        why: 'RCI26 超賣（≤-80）後的反轉，代表中長線動能轉換，往往是一段較大幅度反彈的起點，可靠性高於 RCI9 的訊號。',
      });
    } else {
      items.push({
        ok: lastRCI26 > 0,
        text: `<strong>RCI26 中性區</strong>：${lastRCI26.toFixed(1)}（${lastRCI26 > 0 ? '中線偏多' : '中線偏空'}）`,
        sub: `中長線時間價格相關性中等`,
        whyTitle: 'RCI26 的意義？',
        why: 'RCI26 > 0 代表中長線多方稍占優；RCI26 < 0 代表中長線空方稍占優。在 ±80 以內的 RCI26 主要作為方向確認，不作為交易訊號。',
      });
    }

    // ── 條件 3：極值翻轉（最強訊號）──
    if (bullReversal) {
      items.push({
        ok: true,
        text: `<strong>極值翻轉（買進）</strong>：RCI 從超賣極值（≤-80）開始回升`,
        sub: `${prevRCI9 <= -80 ? `RCI9: ${prevRCI9.toFixed(1)} → ${lastRCI9.toFixed(1)}` : ''}${prevRCI26 <= -80 ? ` RCI26: ${prevRCI26.toFixed(1)} → ${lastRCI26.toFixed(1)}` : ''}`,
        whyTitle: '為什麼極值翻轉是最強訊號？',
        why: 'RCI 從極值（±80 以上）開始反轉，代表過度的時間-價格相關性開始鬆動，是趨勢反轉的最早訊號之一。這個訊號在 RCI 的應用中可靠度最高，是日本技術分析師最重視的 RCI 訊號。',
      });
    } else if (bearReversal) {
      items.push({
        ok: false,
        text: `<strong>極值翻轉（賣出）</strong>：RCI 從超買極值（≥+80）開始下滑`,
        sub: `${prevRCI9 >= 80 ? `RCI9: ${prevRCI9.toFixed(1)} → ${lastRCI9.toFixed(1)}` : ''}${prevRCI26 >= 80 ? ` RCI26: ${prevRCI26.toFixed(1)} → ${lastRCI26.toFixed(1)}` : ''}`,
        whyTitle: '為什麼極值翻轉是最強訊號？',
        why: 'RCI 從高位極值（+80 以上）開始回落，代表短線過熱開始降溫，是獲利了結的訊號。RCI26 的高位翻轉影響更大，可能代表中長線頂部的形成。',
      });
    }

    // ── 條件 4：RCI9 vs RCI26 交叉（近3根）──
    if (crossBull) {
      items.push({
        ok: true,
        text: `<strong>RCI9 上穿 RCI26</strong>：短線動能超越中長線，多頭訊號`,
        sub: `RCI9(${lastRCI9.toFixed(1)}) > RCI26(${lastRCI26.toFixed(1)})，短線動能加速`,
        whyTitle: '為什麼 RCI9 上穿 RCI26？',
        why: 'RCI9（快線）上穿 RCI26（慢線）代表短線時間-價格相關性開始強於中線，類似 KD 的黃金交叉。搭配兩條 RCI 都從低位上穿，是最強的買進確認訊號。',
      });
    } else if (crossBear) {
      items.push({
        ok: false,
        text: `<strong>RCI9 下穿 RCI26</strong>：短線動能弱於中長線，空頭訊號`,
        sub: `RCI9(${lastRCI9.toFixed(1)}) < RCI26(${lastRCI26.toFixed(1)})，短線動能減弱`,
        whyTitle: '為什麼 RCI9 下穿 RCI26？',
        why: 'RCI9 下穿 RCI26 代表短線動能開始弱化，類似 KD 死亡交叉。搭配兩條 RCI 都從高位下穿，是空頭確認訊號。',
      });
    } else {
      items.push({
        ok: lastRCI9 > lastRCI26,
        text: lastRCI9 > lastRCI26
          ? `<strong>RCI9 > RCI26</strong>：短線動能優於中線，方向偏多`
          : `<strong>RCI9 < RCI26</strong>：短線動能弱於中線，方向偏空`,
        sub: `RCI9(${lastRCI9.toFixed(1)}) vs RCI26(${lastRCI26.toFixed(1)})，差距 ${(lastRCI9 - lastRCI26).toFixed(1)}`,
        whyTitle: 'RCI9 vs RCI26 的相對位置？',
        why: 'RCI9 和 RCI26 同時在 +80 以上或 -80 以下，代表短中期趨勢高度一致；分歧則代表多空轉換正在進行中。',
      });
    }

    // ── 條件 5：RCI9 動能 ──
    items.push({
      ok: mom9 > 0,
      text: `<strong>RCI9 動能</strong>：${mom9 > 0 ? '↑ 向上' : mom9 < 0 ? '↓ 向下' : '→ 持平'}`,
      sub: `RCI9 本根 ${lastRCI9.toFixed(1)} vs 前根 ${prevRCI9.toFixed(1)}（變化 ${mom9 > 0 ? '+' : ''}${mom9.toFixed(1)}）`,
      whyTitle: '為什麼看 RCI9 的動能方向？',
      why: 'RCI9 的斜率反映短線動能的加速/減速。在極值區（±80）附近，RCI 的方向轉換往往先於股價反轉，是領先訊號。',
    });

    // ── 綜合訊號 ──
    let signal, score;
    const bothBull = lastRCI9 > 0 && lastRCI26 > 0;
    const bothBear = lastRCI9 < 0 && lastRCI26 < 0;

    if (bullReversal && (prevRCI26 <= -80 || Math.abs(prevRCI9) >= 80)) {
      signal = { name: '極值買進翻轉', icon: '🌀', stars: 5,
        desc: 'RCI 從超賣極值（≤-80）開始回升，最強買進訊號，時間-價格反相關開始鬆動。' };
      score = 5;
    } else if (bearReversal && (prevRCI26 >= 80 || Math.abs(prevRCI9) >= 80)) {
      signal = { name: '極值賣出翻轉', icon: '⚠️', stars: 1,
        desc: 'RCI 從超買極值（≥+80）開始回落，最強賣出訊號，獲利了結或做空機會。' };
      score = 1;
    } else if (lastRCI26 <= -80) {
      signal = { name: 'RCI26 深度超賣', icon: '⚡', stars: 4,
        desc: '中長線 RCI 達超賣極值，等待極值翻轉確認後進場，反彈幅度通常較大。' };
      score = 4;
    } else if (lastRCI26 >= 80) {
      signal = { name: 'RCI26 深度超買', icon: '🔴', stars: 2,
        desc: '中長線 RCI 達超買極值，短線風險高，等待翻轉訊號再出場。' };
      score = 2;
    } else if (crossBull && bothBull) {
      signal = { name: '多頭雙線確認', icon: '✨', stars: 4,
        desc: 'RCI9 上穿 RCI26 + 兩條均正值，短中線多頭雙重確認。' };
      score = 4;
    } else if (crossBear && bothBear) {
      signal = { name: '空頭雙線確認', icon: '⚡', stars: 2,
        desc: 'RCI9 下穿 RCI26 + 兩條均負值，短中線空頭雙重確認。' };
      score = 2;
    } else if (bothBull && mom9 > 0) {
      signal = { name: '多頭動能延伸', icon: '🔵', stars: 3,
        desc: 'RCI9/RCI26 均為正值且短線動能持續走強，多頭趨勢健康延伸。' };
      score = 3;
    } else if (bothBear && mom9 < 0) {
      signal = { name: '空頭動能延伸', icon: '⚪', stars: 2,
        desc: 'RCI9/RCI26 均為負值且短線動能持續走弱，空頭趨勢延伸。' };
      score = 2;
    } else {
      signal = { name: '多空分歧', icon: '⏸', stars: 2,
        desc: 'RCI9/RCI26 方向不一致，短中線動能分歧，等待明確方向。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { lastRCI9, lastRCI26, prevRCI9, prevRCI26, mom9, mom26,
             crossBull, crossBear, bullReversal, bearReversal,
             rci9Arr, rci26Arr, n, lastIdx },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'rci9',  name: '🟠 RCI(9)',  value: ev.raw.lastRCI9?.toFixed(1)  ?? '—', color: '#f97316', tooltip: '短線RCI，9日順位相關係數，±80為極值' },
      { id: 'rci26', name: '🔵 RCI(26)', value: ev.raw.lastRCI26?.toFixed(1) ?? '—', color: '#60a5fa', tooltip: '中線RCI，26日順位相關係數，更穩定' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🌀 RCI</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">🌀</span><span class="fs-title">RCI 順位相關係數</span>
      </div><div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 27 根 K 線）</p>
      </div>`;
    }
    const r = ev.raw;
    const fmt = v => v?.toFixed(1) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';

    const rci9Color  = r.lastRCI9  >= 80 ? '#ef5350' : r.lastRCI9  <= -80 ? '#26a69a' : r.lastRCI9  > 0 ? '#f97316' : '#8a8f99';
    const rci26Color = r.lastRCI26 >= 80 ? '#ef5350' : r.lastRCI26 <= -80 ? '#26a69a' : r.lastRCI26 > 0 ? '#60a5fa' : '#8a8f99';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🌀</span>
        <span class="fs-title">RCI 順位相關係數</span>
        <span class="fs-subtitle">Rank Correlation Index · RCI(9) + RCI(26) 雙線判讀</span>
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
          <h4>📍 RCI 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(249,115,22,0.18);color:#fbbf24">RCI(9)</span>
            <span class="fs-keylevel-price" style="color:${rci9Color}">${fmt(r.lastRCI9)}</span>
            <span class="fs-keylevel-desc">${r.lastRCI9 >= 80 ? '🔴 超買極值' : r.lastRCI9 <= -80 ? '🟢 超賣極值' : r.lastRCI9 > 0 ? '偏多' : '偏空'}　動能 ${r.mom9 > 0 ? '↑' : r.mom9 < 0 ? '↓' : '→'} ${r.mom9 > 0 ? '+' : ''}${r.mom9.toFixed(1)}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(96,165,250,0.18);color:#93c5fd">RCI(26)</span>
            <span class="fs-keylevel-price" style="color:${rci26Color}">${fmt(r.lastRCI26)}</span>
            <span class="fs-keylevel-desc">${r.lastRCI26 >= 80 ? '🔴 超買極值' : r.lastRCI26 <= -80 ? '🟢 超賣極值' : r.lastRCI26 > 0 ? '偏多' : '偏空'}　動能 ${r.mom26 > 0 ? '↑' : r.mom26 < 0 ? '↓' : '→'} ${r.mom26 > 0 ? '+' : ''}${r.mom26.toFixed(1)}</span>
          </div>
          ${r.bullReversal ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(16,185,129,0.18);color:#6ee7b7">極值翻轉</span>
            <span class="fs-keylevel-price" style="color:#34d399">買進訊號</span>
            <span class="fs-keylevel-desc">RCI 從超賣極值（≤-80）開始回升，最強買進訊號</span>
          </div>` : ''}
          ${r.bearReversal ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">極值翻轉</span>
            <span class="fs-keylevel-price" style="color:#ef4444">賣出訊號</span>
            <span class="fs-keylevel-desc">RCI 從超買極值（≥+80）開始回落，最強賣出訊號</span>
          </div>` : ''}
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_rciActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🌀 RCI 指標原理 ━━━</h4>
            <p><strong>公式</strong>：RCI = (1 - 6Σd² / (N³ - N)) × 100</p>
            <p>d = 時間排序（越新=1）- 價格排序（越高=1）</p>
            <p style="margin-top:8px">RCI 衡量「時間與價格的順位相關性」。RCI = +100 代表最新的收盤最高，最舊的最低（完美上升趨勢）；RCI = -100 代表完美下降趨勢；RCI = 0 代表時間與價格完全無關聯（隨機盤整）。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 核心交易邏輯 ━━━</h4>
            <ul>
              <li><strong>極值翻轉（最強訊號）</strong>：RCI9 或 RCI26 從 ±80 以外開始反轉 → 買進/賣出</li>
              <li><strong>雙線同向</strong>：RCI9 和 RCI26 都在 0 以上且走高 = 多頭確認</li>
              <li><strong>RCI9 上穿 RCI26</strong>：類似 KD 黃金交叉，短線動能轉強</li>
              <li><strong>避免在 ±80 以外追漲殺跌</strong>：RCI 極值正是反轉的起點</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>台股較少見，需多練習</strong>：RCI 在日本廣泛使用，台灣相對陌生，建議搭配 KD 交叉確認</li>
              <li><strong>趨勢行情中鈍化</strong>：強勢多頭時 RCI9 可以長期維持在 +80 以上</li>
              <li><strong>RCI26 更可靠</strong>：RCI9 快但假訊號多，RCI26 慢但更穩定</li>
            </ul>
          </div>
        </div>

        ${renderAISection('rci', 'RCI 順位相關係數', '🌀', ev, (() => {
          const fmt = v => v?.toFixed(1) ?? '—';
          const slice = (arr) => arr.slice(-5).map((v, i, a) => {
            const label = i === a.length - 1 ? '【當根】' : `【-${a.length - 1 - i}根】`;
            const zone = v >= 80 ? '超買' : v <= -80 ? '超賣' : v > 0 ? '偏多' : '偏空';
            return `${label}${v?.toFixed(1)??'—'}(${zone})`;
          }).join(' → ');
          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          return {
            'RCI(9)當前值【短線，±80為極值】': `${fmt(r.lastRCI9)}（${r.lastRCI9 >= 80 ? '超買' : r.lastRCI9 <= -80 ? '超賣' : r.lastRCI9 > 0 ? '偏多' : '偏空'}）`,
            'RCI(26)當前值【中線，更穩定可靠】': `${fmt(r.lastRCI26)}（${r.lastRCI26 >= 80 ? '超買' : r.lastRCI26 <= -80 ? '超賣' : r.lastRCI26 > 0 ? '偏多' : '偏空'}）`,
            'RCI9動能【正=走多，負=走空】': `${r.mom9 > 0 ? '+' : ''}${r.mom9.toFixed(1)}`,
            'RCI26動能': `${r.mom26 > 0 ? '+' : ''}${r.mom26.toFixed(1)}`,
            '極值翻轉偵測【最強訊號】': r.bullReversal ? '✅ 買進翻轉（從超賣極值≤-80回升）' : r.bearReversal ? '⚠️ 賣出翻轉（從超買極值≥+80回落）' : '未偵測到極值翻轉',
            '近期交叉【RCI9 vs RCI26，近3根】': r.crossBull ? '近3根 RCI9 上穿 RCI26（多頭）' : r.crossBear ? '近3根 RCI9 下穿 RCI26（空頭）' : '近3根無交叉',
            '近5根RCI9走勢【由舊到新，最右為當根】': slice(r.rci9Arr),
            '近5根RCI26走勢【由舊到新，最右為當根】': slice(r.rci26Arr),
            [`各條件達成狀態【共${ev.items.length}項，✅${ev.items.filter(i=>i.ok===true).length}達標 ❌${ev.items.filter(i=>i.ok===false).length}未達標】`]:
              itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}
      </div>
    `;
  },
};

function _rciActionRows(ev) {
  const sig = ev.signal.name;
  const r   = ev.raw;
  const fmt = v => v?.toFixed(1) ?? '—';
  if (sig === '極值買進翻轉') return [
    { label: '進場建議', detail: `<strong>積極進場</strong>。RCI 極值翻轉是最強訊號，可進 50~70% 部位` },
    { label: '加碼條件', detail: `RCI9 持續回升站上 0 + RCI26 也開始翻正 → 加碼確認` },
    { label: '停損設置', detail: `RCI9 再度跌回 -80 以下 → 翻轉失敗，停損出場` },
    { label: '注意事項', detail: `搭配 KD 低檔黃金交叉或 MACD 底背離，勝率更高` },
  ];
  if (sig === '極值賣出翻轉') return [
    { label: '操作建議', detail: `<strong>減碼或出場</strong>。RCI 極值翻轉是強烈賣出訊號` },
    { label: '觀察重點', detail: `RCI9 是否持續回落，RCI26 是否也開始翻負` },
    { label: '停損設置', detail: `RCI9 再度站回 +80 以上 → 翻轉失敗，停損空單` },
    { label: '注意事項', detail: `搭配 MACD 頂背離或 KD 死亡交叉確認，可靠性更高` },
  ];
  if (sig === '多頭雙線確認') return [
    { label: '進場建議', detail: `<strong>可進場</strong>，RCI9/RCI26 雙線正值 + 黃金交叉是可靠多頭訊號` },
    { label: '加碼條件', detail: `兩條 RCI 持續走高，遠離 0 軸 → 趨勢確立，加碼` },
    { label: '停損設置', detail: `RCI9 下穿 RCI26（死亡交叉）→ 減碼` },
    { label: '注意事項', detail: `若兩條 RCI 都接近 +80，不宜追高，等回調再進` },
  ];
  return [
    { label: '操作建議', detail: `觀望為主，等待 <strong>RCI 進入極值區（±80）後的翻轉訊號</strong>` },
    { label: '關鍵觀察', detail: `RCI26 是否接近 ±80，接近時翻轉訊號的可靠度最高` },
    { label: '停損設置', detail: `若已持多，RCI9 跌破 0 + RCI26 也轉負 → 減碼` },
    { label: '注意事項', detail: `RCI 最好搭配 KD/MACD 使用，單靠 RCI 訊號在台股效果有限` },
  ];
}

registerAnalysisModule(RCIModule);
