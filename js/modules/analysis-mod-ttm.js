/* js/modules/analysis-mod-ttm.js
 * 🔋 TTM Squeeze（能量壓縮 → 釋放）教學模組 — T-6
 * 布林帶縮進 Keltner = 波動壓縮蓄勢；釋放瞬間 + 動能方向 = 高勝率突破。
 */
import { AppState } from '../state.js';
import { calcTTMSqueeze } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const TTMModule = {
  id: 'ttm',
  name: 'TTM Squeeze',
  icon: '🔋',
  candleMinLen: 1,

  evaluate(candles) {
    const _code = AppState.activeCode || '';
    if (window.__taDaily?.code === _code && window.__taDaily.candles?.length) candles = window.__taDaily.candles;
    if (candles.length < 25) return { score: 3, signal: null, items: [], raw: null };
    const t = calcTTMSqueeze(candles);
    if (!t.ready) return { score: 3, signal: null, items: [], raw: null };

    const items = [];
    items.push({ ok: !t.squeezeOn,
      text: t.squeezeOn
        ? `<strong>壓縮中（Squeeze ON）</strong>：已連 ${t.squeezeStreak} 根，能量蓄積`
        : t.fired
          ? `<strong>剛釋放（Squeeze 解除）</strong>：壓縮 ${t.squeezeStreak} 根後爆發`
          : `<strong>釋放後延續</strong>：無壓縮，趨勢進行中`,
      sub: '壓縮 = 布林帶(20,2) 完全縮進 Keltner(20EMA±1.5ATR) 內',
      whyTitle: 'Squeeze 在看什麼？',
      why: '布林帶量測「近期波動」、Keltner 量測「常態波動」。當布林帶縮進 Keltner 內，代表近期波動壓到比常態還低——市場像彈簧被壓緊，醞釀大行情。壓得越久（連續根數越多），釋放時的爆發力通常越強。',
    });
    items.push({ ok: t.momentumUp,
      text: `<strong>動能方向：${t.momentumUp ? '向上 ↑' : '向下 ↓'}</strong>`,
      sub: t.momentumUp ? '動能柱在零軸上方，偏多' : '動能柱在零軸下方，偏空',
      whyTitle: '為什麼要配動能',
      why: 'Squeeze 只說「要爆」，不說「往哪爆」。動能（close 與中線差的線性回歸）給方向：釋放當下動能向上 = 偏多突破、向下 = 偏空破位。壓縮+釋放+動能同向，才是完整訊號。',
    });
    if (t.fired) {
      items.push({ ok: t.momentumUp,
        text: `<strong>釋放訊號${t.firedLong ? '（強：壓縮≥6根+動能向上）' : ''}</strong>`,
        sub: t.momentumUp ? '壓縮釋放且動能向上，偏多突破點' : '壓縮釋放且動能向下，偏空破位',
        whyTitle: '釋放怎麼操作',
        why: '釋放第一根是關鍵：順動能方向進場、以壓縮區間另一端為停損。壓得越久（≥6根）釋放力道通常越大。',
      });
    }

    let signal, score;
    if (t.fired && t.momentumUp)      { signal = { name: '壓縮釋放↑', icon: '🚀', stars: 5, desc: '能量壓縮剛釋放且動能向上，偏多突破。' }; score = 5; }
    else if (t.fired && !t.momentumUp){ signal = { name: '壓縮釋放↓', icon: '💥', stars: 1, desc: '能量壓縮剛釋放且動能向下，偏空破位。' }; score = 1; }
    else if (t.squeezeOn)             { signal = { name: '壓縮蓄勢', icon: '🔋', stars: 3, desc: `連 ${t.squeezeStreak} 根壓縮，醞釀中，待釋放定方向。` }; score = 3; }
    else if (t.momentumUp)            { signal = { name: '多頭延續', icon: '🟢', stars: 4, desc: '已釋放、動能向上延續，偏多。' }; score = 4; }
    else                             { signal = { name: '空頭延續', icon: '🔴', stars: 2, desc: '已釋放、動能向下延續，偏空。' }; score = 2; }

    return { score, signal, items, raw: { squeezeOn: t.squeezeOn, streak: t.squeezeStreak, fired: t.fired, firedLong: t.firedLong, momentum: t.momentum, momentumUp: t.momentumUp } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [{ id: 'ttm-state', name: ev.raw.squeezeOn ? '🔋 壓縮中' : '⚡ 已釋放',
      value: ev.raw.momentumUp ? '動能↑' : '動能↓',
      color: ev.raw.squeezeOn ? '#fbbf24' : ev.raw.momentumUp ? '#ef5350' : '#26a69a',
      tooltip: 'TTM Squeeze：壓縮蓄勢 / 釋放方向' }];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🔋 TTM</span>`;
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}"><span>${ev.signal.icon} ${ev.signal.name}</span><span class="fs-mini-stars">${'⭐'.repeat(ev.signal.stars)}</span></span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">🔋</span><span class="fs-title">TTM Squeeze</span></div><div class="fs-deep-module-body"><p style="color:var(--muted);padding:8px 4px 14px">此週期 K 棒不足（需 ≥ 25 根），請切換到 3月 / 6月 / 1年。</p><div class="fs-teach"><div class="fs-teach-section"><h4>━━━ 🔋 這是什麼 ━━━</h4><p>TTM Squeeze 用「布林帶是否縮進 Keltner 通道」判斷<strong>波動壓縮（蓄勢）</strong>——市場像彈簧被壓緊。壓縮釋放的瞬間，配合<strong>動能方向</strong>（向上偏多突破 / 向下偏空破位）決定進場方向。壓得越久，釋放力道通常越強。</p></div></div></div>`;
    const r = ev.raw, code = AppState.activeCode || '';
    const stars = '⭐'.repeat(ev.signal.stars);
    const stColor = r.squeezeOn ? '#fbbf24' : r.momentumUp ? '#ef5350' : '#26a69a';
    return `
      <div class="fs-deep-module-head"><span class="fs-icon">🔋</span><span class="fs-title">TTM Squeeze（壓縮釋放）</span><span class="fs-subtitle">BB×Keltner 波動壓縮 + 動能方向</span></div>
      <div class="fs-deep-module-body">
        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">${ev.items.map(_renderReadoutItem).join('')}</div>
          <div class="fs-readout-summary"><span class="fs-signal-icon">${ev.signal.icon}</span><div class="fs-signal-text"><span class="fs-signal-name">${ev.signal.name}</span><span class="fs-signal-desc">${ev.signal.desc}</span></div><span class="fs-signal-stars">${stars}</span></div>
        </div>
        <div class="fs-keylevels">
          <h4>📍 壓縮狀態</h4>
          <div class="fs-keylevel-row"><span class="fs-keylevel-tag" style="background:${stColor}22;color:${stColor}">狀態</span><span class="fs-keylevel-price" style="color:${stColor}">${r.squeezeOn ? '壓縮中' : '已釋放'}</span><span class="fs-keylevel-desc">${r.squeezeOn ? `布林帶縮進 Keltner，連 ${r.streak} 根` : `動能${r.momentumUp ? '向上' : '向下'}（前次壓縮 ${r.streak} 根）`}</span></div>
          <div class="fs-keylevel-row"><span class="fs-keylevel-tag" style="background:${r.momentumUp ? 'rgba(239,83,80,0.18)' : 'rgba(38,166,154,0.18)'};color:${r.momentumUp ? '#fca5a5' : '#26a69a'}">動能</span><span class="fs-keylevel-price" style="color:${r.momentumUp ? '#ef4444' : '#10b981'}">${r.momentumUp ? '↑ 偏多' : '↓ 偏空'}</span><span class="fs-keylevel-desc">釋放方向由動能決定</span></div>
        </div>
        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section"><h4>━━━ 🔋 壓縮→釋放 能量觀 ━━━</h4>
            <p>市場波動會在「壓縮」與「擴張」間循環。<strong>布林帶縮進 Keltner = 壓縮</strong>，像彈簧被壓緊；<strong>布林帶衝出 Keltner = 釋放</strong>，能量爆發。</p>
            <p style="margin-top:8px">壓得越久（連續根數越多），釋放時的行情通常越猛。盤整末端的低波動，往往是大行情的前夜。</p></div>
          <div class="fs-teach-section"><h4>━━━ 🎯 怎麼用 ━━━</h4>
            <ul><li><strong>壓縮中</strong>：別急著進，等釋放確認方向（避免假突破）</li>
            <li><strong>釋放 + 動能向上</strong>：偏多突破，順勢做多、壓縮區下緣停損</li>
            <li><strong>釋放 + 動能向下</strong>：偏空破位，做多者應退場</li>
            <li><strong>壓縮 ≥ 6 根後釋放</strong>：蓄能足，爆發力通常更強</li></ul></div>
          <div class="fs-teach-section"><h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul><li><strong>只說「要爆」不說「往哪」</strong>：務必配動能方向，單看壓縮會兩面挨打</li>
            <li><strong>假釋放</strong>：釋放首根可能反覆，激進者首根進、穩健者等回測壓縮上緣不破</li></ul></div>
        </div>
        ${renderAISection('ttm', 'TTM Squeeze 壓縮釋放', '🔋', ev, {
          '壓縮狀態【壓縮=蓄勢/釋放=爆發】': r.squeezeOn ? `壓縮中（連 ${r.streak} 根）` : `已釋放（前次壓 ${r.streak} 根）`,
          '動能方向【釋放往哪爆】': r.momentumUp ? '向上 ↑ 偏多' : '向下 ↓ 偏空',
          '釋放訊號': r.fired ? (r.firedLong ? '剛釋放（強）' : '剛釋放') : '無',
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>`;
  },
};
registerAnalysisModule(TTMModule);
