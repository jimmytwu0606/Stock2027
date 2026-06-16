/* js/modules/analysis-mod-supertrend.js
 * 🛡️ Supertrend（ATR 通道趨勢線 / 移動停損）教學模組 — T-7
 * 定位：趨勢跟蹤 + 移動停損，不是搶轉折的進場訊號。
 */
import { AppState } from '../state.js';
import { calcSupertrend } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const SupertrendModule = {
  id: 'supertrend',
  name: 'Supertrend',
  icon: '🛡️',
  candleMinLen: 1,

  evaluate(candles) {
    const _code = AppState.activeCode || '';
    if (window.__taDaily?.code === _code && window.__taDaily.candles?.length) candles = window.__taDaily.candles;
    if (candles.length < 15) return { score: 3, signal: null, items: [], raw: null };
    const s = calcSupertrend(candles);
    if (!s.ready) return { score: 3, signal: null, items: [], raw: null };

    const up = s.dir === 'up';
    const lastC = candles[candles.length - 1].close;
    const distPct = (lastC - s.line) / s.line * 100;

    const items = [];
    items.push({ ok: up,
      text: up
        ? `<strong>多頭趨勢</strong>：Supertrend 線 ${s.line.toFixed(2)} 在股價下方${s.flippedUp ? '（剛翻多 🔄）' : ''}`
        : `<strong>空頭趨勢</strong>：Supertrend 線 ${s.line.toFixed(2)} 在股價上方${s.flippedDown ? '（剛翻空 🔄）' : ''}`,
      sub: `現價距翻轉線 ${distPct >= 0 ? '+' : ''}${distPct.toFixed(1)}%`,
      whyTitle: 'Supertrend 是什麼？',
      why: 'Supertrend 用 ATR（平均真實波幅）在股價上下築一條「通道翻轉線」。多頭時線貼在股價下方當支撐/移動停損；股價跌破即翻空，線跳到上方變壓力。它把波動納入計算，不會像固定百分比停損那樣被正常震盪洗掉。',
    });
    if (s.flipped) {
      items.push({ ok: up,
        text: `<strong>趨勢剛翻轉：${up ? '翻多' : '翻空'}</strong>`,
        sub: up ? '由空轉多，趨勢偏多訊號' : '由多轉空，多單應執行停損',
        whyTitle: '翻轉怎麼操作',
        why: '翻轉「以收盤確認、次日開盤執行」最穩健，避免盤中假翻轉。翻空 = 移動停損被觸發，紀律離場勝過凹單。',
      });
    }
    items.push({ ok: up,
      text: `<strong>移動停損參考</strong>：${s.line.toFixed(2)}`,
      sub: up ? '多單可將停損上移至此線，鎖住獲利' : '空頭中此線為反彈壓力',
      whyTitle: '當移動停損用',
      why: 'Supertrend 最佳用途不是進場、而是「續抱還是該走」。多頭波段中沿著線移動停損，趨勢不死就抱、跌破就走，是順勢交易的紀律工具。',
    });

    let signal, score;
    if (s.flippedUp)        { signal = { name: '剛翻多', icon: '🔄', stars: 4, desc: 'Supertrend 由空翻多，趨勢轉強。' }; score = 4; }
    else if (s.flippedDown) { signal = { name: '剛翻空', icon: '🔻', stars: 1, desc: 'Supertrend 由多翻空，移動停損觸發。' }; score = 1; }
    else if (up)            { signal = { name: '多頭續抱', icon: '🛡️', stars: 4, desc: '線在股價下方，趨勢偏多，沿線移動停損。' }; score = 4; }
    else                   { signal = { name: '空頭壓制', icon: '🔴', stars: 2, desc: '線在股價上方，趨勢偏空，反彈遇壓。' }; score = 2; }

    return { score, signal, items, raw: { dir: s.dir, line: s.line, lastC, distPct, flipped: s.flipped, flippedUp: s.flippedUp, flippedDown: s.flippedDown } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const up = ev.raw.dir === 'up';
    return [{ id: 'st-line', name: up ? '🛡️ 多頭線' : '🔴 空頭線', value: ev.raw.line?.toFixed(2) ?? '—',
      color: up ? '#ef5350' : '#26a69a', tooltip: 'Supertrend(10,3) 翻轉線 / 移動停損' }];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🛡️ Supertrend</span>`;
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}"><span>${ev.signal.icon} ${ev.signal.name}</span><span class="fs-mini-stars">${'⭐'.repeat(ev.signal.stars)}</span></span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">🛡️</span><span class="fs-title">Supertrend</span></div><div class="fs-deep-module-body"><p style="color:var(--muted);padding:8px 4px 14px">此週期 K 棒不足（需 ≥ 15 根），請切換到 1月 / 3月 以上。</p><div class="fs-teach"><div class="fs-teach-section"><h4>━━━ 🛡️ 這是什麼 ━━━</h4><p>Supertrend 用 ATR（平均真實波幅）在價格上下築一條<strong>動態通道翻轉線</strong>。多頭時線貼在股價下方當支撐／移動停損；股價跌破即翻空、線跳到上方變壓力。它把波動納入計算，不會像固定百分比停損那樣被正常震盪洗掉，<strong>定位是趨勢跟蹤與續抱判斷，不是搶轉折的進場訊號</strong>。</p></div></div></div>`;
    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—', code = AppState.activeCode || '';
    const up = r.dir === 'up', col = up ? '#ef5350' : '#26a69a';
    const stars = '⭐'.repeat(ev.signal.stars);
    return `
      <div class="fs-deep-module-head"><span class="fs-icon">🛡️</span><span class="fs-title">Supertrend（趨勢 / 移動停損）</span><span class="fs-subtitle">ATR(10,3) 通道翻轉線</span></div>
      <div class="fs-deep-module-body">
        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">${ev.items.map(_renderReadoutItem).join('')}</div>
          <div class="fs-readout-summary"><span class="fs-signal-icon">${ev.signal.icon}</span><div class="fs-signal-text"><span class="fs-signal-name">${ev.signal.name}</span><span class="fs-signal-desc">${ev.signal.desc}</span></div><span class="fs-signal-stars">${stars}</span></div>
        </div>
        <div class="fs-keylevels">
          <h4>📍 翻轉線</h4>
          <div class="fs-keylevel-row"><span class="fs-keylevel-tag" style="background:${col}22;color:${col}">${up ? '多頭線' : '空頭線'}</span><span class="fs-keylevel-price" style="color:${col}">${fmt(r.line)}</span><span class="fs-keylevel-desc">在股價${up ? '下方（支撐/移動停損）' : '上方（壓力）'}，距現價 ${r.distPct >= 0 ? '+' : ''}${r.distPct.toFixed(1)}%</span></div>
        </div>
        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section"><h4>━━━ 🛡️ Supertrend 原理 ━━━</h4>
            <p>用 ATR 在股價上下築一條動態通道線。多頭時線在下方撐住、空頭時線在上方壓制；股價穿越即翻轉。<strong>把波動納入計算</strong>，所以不會被正常震盪輕易洗掉。</p></div>
          <div class="fs-teach-section"><h4>━━━ 🎯 定位：續抱 / 移動停損 ━━━</h4>
            <ul><li><strong>不是搶轉折的進場訊號</strong>：它落後，適合「確認趨勢後跟」</li>
            <li><strong>多頭波段</strong>：沿線移動停損，趨勢不死就抱、跌破就走</li>
            <li><strong>翻轉執行</strong>：以收盤確認、次日開盤執行，避免盤中假翻轉</li></ul></div>
          <div class="fs-teach-section"><h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul><li><strong>盤整易被巴</strong>：橫盤時頻繁翻轉、兩面挨打，需搭趨勢過濾（如週線多頭才用多單）</li>
            <li><strong>參數固定 (10,3)</strong>：越敏感越多假訊號，本頁採通用值</li></ul></div>
        </div>
        ${renderAISection('supertrend', 'Supertrend 趨勢線', '🛡️', ev, {
          '趨勢方向': up ? '多頭（線在下方）' : '空頭（線在上方）',
          '翻轉線/移動停損': fmt(r.line),
          '距現價': `${r.distPct >= 0 ? '+' : ''}${r.distPct.toFixed(1)}%`,
          '是否剛翻轉': r.flipped ? (up ? '剛翻多 🔄' : '剛翻空 🔄') : '否',
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>`;
  },
};
registerAnalysisModule(SupertrendModule);
