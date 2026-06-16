/* js/modules/analysis-mod-obv.js
 * 🌊 OBV 能量潮（量價背離）教學模組 — T-8
 * 成交量是因、價格是果。OBV 累計量能，與價格背離常領先反轉。
 */
import { AppState } from '../state.js';
import { calcOBV } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const OBVModule = {
  id: 'obv',
  name: 'OBV 能量潮',
  icon: '🌊',
  candleMinLen: 1,

  evaluate(candles) {
    const _code = AppState.activeCode || '';
    if (window.__taDaily?.code === _code && window.__taDaily.candles?.length) candles = window.__taDaily.candles;
    if (candles.length < 25) return { score: 3, signal: null, items: [], raw: null };
    const o = calcOBV(candles);
    if (!o.ready) return { score: 3, signal: null, items: [], raw: null };

    const items = [];
    items.push({ ok: o.slopeUp,
      text: `<strong>量能方向：${o.slopeUp ? '流入 ↑' : '流出 ↓'}</strong>`,
      sub: o.slopeUp ? 'OBV 近 5 日上行，買盤量能累積' : 'OBV 近 5 日下行，賣盤量能流出',
      whyTitle: 'OBV 是什麼？',
      why: 'OBV（On-Balance Volume，能量潮）把「上漲日的量」累加、「下跌日的量」累減，畫成一條量能累計線。它的核心信念是「量先價行」——資金的進出（量）往往領先價格表態。OBV 持續走高 = 量能真實流入支撐漲勢。',
    });
    if (o.bullDiv || o.bearDiv) {
      items.push({ ok: o.bullDiv,
        text: o.bullDiv
          ? `<strong>牛背離 🔴</strong>：價創近低，但 OBV 未破低`
          : `<strong>熊背離 🟢</strong>：價創近高，但 OBV 未創高`,
        sub: o.bullDiv ? '價跌量縮、賣壓萎縮，反彈醞釀' : '價漲量縮、買盤縮手，留意回落',
        whyTitle: '量價背離的威力',
        why: o.bullDiv
          ? '價格續創新低，但 OBV 沒有同步破底——代表下跌時的賣壓在萎縮，恐慌性賣出已近尾聲，量能偷偷轉強，是經典的底部背離訊號。'
          : '價格續創新高，但 OBV 沒有同步創高——代表上漲缺乏量能支撐、買盤縮手，漲勢虛弱，常領先價格回落。',
      });
    } else {
      items.push({ ok: o.slopeUp,
        text: `<strong>量價同步</strong>：OBV 與價格方向一致`,
        sub: '無明顯背離，趨勢由量能背書',
        whyTitle: '量價同步的意義',
        why: '價漲 OBV 同步漲 = 量能確認漲勢（健康）；價跌 OBV 同步跌 = 賣壓真實。同步時趨勢可信，背離時才是警訊。',
      });
    }

    let signal, score;
    if (o.bullDiv)      { signal = { name: '牛背離', icon: '🔴', stars: 4, desc: '價創低、OBV 未破低，賣壓萎縮，反彈醞釀。' }; score = 4; }
    else if (o.bearDiv) { signal = { name: '熊背離', icon: '🟢', stars: 2, desc: '價創高、OBV 未創高，買盤縮手，留意回落。' }; score = 2; }
    else if (o.slopeUp) { signal = { name: '量能流入', icon: '🌊', stars: 4, desc: 'OBV 上行，量能支撐價格，偏多。' }; score = 4; }
    else                { signal = { name: '量能流出', icon: '🌧️', stars: 2, desc: 'OBV 下行，量能流出，支撐轉弱。' }; score = 2; }

    return { score, signal, items, raw: { obv: o.obv, bullDiv: o.bullDiv, bearDiv: o.bearDiv, slopeUp: o.slopeUp, priceAtLow: o.priceAtLow, priceAtHigh: o.priceAtHigh } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [{ id: 'obv-flow', name: ev.raw.slopeUp ? '🌊 量入' : '🌧️ 量出',
      value: (ev.raw.bullDiv ? '牛背離' : ev.raw.bearDiv ? '熊背離' : '同步'),
      color: ev.raw.bullDiv ? '#ef5350' : ev.raw.bearDiv ? '#26a69a' : ev.raw.slopeUp ? '#ef5350' : '#26a69a',
      tooltip: 'OBV 能量潮：量能流向 / 量價背離' }];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🌊 OBV</span>`;
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}"><span>${ev.signal.icon} ${ev.signal.name}</span><span class="fs-mini-stars">${'⭐'.repeat(ev.signal.stars)}</span></span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">🌊</span><span class="fs-title">OBV 能量潮</span></div><div class="fs-deep-module-body"><p style="color:var(--muted);padding:8px 4px 14px">此週期 K 棒不足（需 ≥ 25 根），請切換到 3月 / 6月 / 1年。</p><div class="fs-teach"><div class="fs-teach-section"><h4>━━━ 🌊 這是什麼 ━━━</h4><p>OBV（能量潮）把<strong>上漲日的量累加、下跌日的量累減</strong>，畫成一條量能累計線，核心信念是「量先價行」——資金進出往往領先價格。重點看方向（上行=量能流入）與<strong>量價背離</strong>：價創新低但 OBV 未破低 = 賣壓萎縮的底部訊號；價創新高但 OBV 未創高 = 買盤縮手的頭部警訊。</p></div></div></div>`;
    const r = ev.raw, code = AppState.activeCode || '';
    const stars = '⭐'.repeat(ev.signal.stars);
    const divColor = r.bullDiv ? '#ef5350' : r.bearDiv ? '#26a69a' : r.slopeUp ? '#ef5350' : '#26a69a';
    return `
      <div class="fs-deep-module-head"><span class="fs-icon">🌊</span><span class="fs-title">OBV 能量潮（量價背離）</span><span class="fs-subtitle">量先價行 · 累計量能 + 背離偵測</span></div>
      <div class="fs-deep-module-body">
        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">${ev.items.map(_renderReadoutItem).join('')}</div>
          <div class="fs-readout-summary"><span class="fs-signal-icon">${ev.signal.icon}</span><div class="fs-signal-text"><span class="fs-signal-name">${ev.signal.name}</span><span class="fs-signal-desc">${ev.signal.desc}</span></div><span class="fs-signal-stars">${stars}</span></div>
        </div>
        <div class="fs-keylevels">
          <h4>📍 量能狀態</h4>
          <div class="fs-keylevel-row"><span class="fs-keylevel-tag" style="background:${divColor}22;color:${divColor}">量能流向</span><span class="fs-keylevel-price" style="color:${divColor}">${r.slopeUp ? '流入 ↑' : '流出 ↓'}</span><span class="fs-keylevel-desc">${r.bullDiv ? '牛背離：價低量不低' : r.bearDiv ? '熊背離：價高量不高' : '量價同步，無背離'}</span></div>
        </div>
        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section"><h4>━━━ 🌊 量先價行 ━━━</h4>
            <p>OBV 把上漲日的量累加、下跌日的量累減。它相信<strong>「成交量是因、價格是果」</strong>——資金進出（量）往往領先價格。OBV 走勢能揭露價格背後的真實量能。</p></div>
          <div class="fs-teach-section"><h4>━━━ 🎯 核心：量價背離 ━━━</h4>
            <ul><li><strong>牛背離</strong>：價創新低、OBV 未破低 → 賣壓萎縮，底部訊號</li>
            <li><strong>熊背離</strong>：價創新高、OBV 未創高 → 買盤縮手，頭部警訊</li>
            <li><strong>量價同步</strong>：OBV 與價同向 → 趨勢由量能背書，可信</li></ul></div>
          <div class="fs-teach-section"><h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul><li><strong>對單日爆量敏感</strong>：本頁已先 EMA3 平滑再判背離，降低雜訊</li>
            <li><strong>背離是領先指標</strong>：可能提早出現、需配合價格確認（如轉強 K 棒）再動作</li></ul></div>
        </div>
        ${renderAISection('obv', 'OBV 能量潮', '🌊', ev, {
          '量能流向【量先價行】': r.slopeUp ? '流入 ↑' : '流出 ↓',
          '量價背離【領先反轉訊號】': r.bullDiv ? '牛背離（價低量不低，偏多）' : r.bearDiv ? '熊背離（價高量不高，偏空）' : '無背離（量價同步）',
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>`;
  },
};
registerAnalysisModule(OBVModule);
