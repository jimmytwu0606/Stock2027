/* js/modules/analysis-mod-mtf.js
 * 🔭 多週期共振（週線級別確認）教學模組 — T-3
 * 順大勢（週線）逆小勢（日線）：日線買訊只在週線多頭時才高勝率。
 */
import { AppState } from '../state.js';
import { calcMA, calcWeeklyTrend } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const MTFModule = {
  id: 'mtf',
  name: '週線共振',
  icon: '🔭',
  candleMinLen: 1,    // 不綁圖表週期：自取 2 年日K（window.__taDaily），永不 🔒

  evaluate(candles) {
    // 優先用 2 年日K hist（ui.ensureTADaily 預取），否則退回傳入的圖表週期 candles
    const _code = AppState.activeCode || '';
    if (window.__taDaily?.code === _code && window.__taDaily.candles?.length) {
      candles = window.__taDaily.candles;
    }
    const n = candles.length;
    if (n < 70) return { score: 3, signal: null, items: [], raw: null };

    const closes = candles.map(c => c.close);
    const ma20   = calcMA(closes, 20);
    const dC     = closes[n - 1];
    const dMA    = ma20[n - 1];
    const dMAp   = ma20[n - 6] ?? dMA;
    const dailyBull = dMA != null && dC > dMA && dMA > dMAp;   // 日收 > MA20 且 MA20 上揚
    const dailyBear = dMA != null && dC < dMA && dMA < dMAp;

    const wk = calcWeeklyTrend(candles);
    if (!wk.ready) return { score: 3, signal: null, items: [], raw: null };

    const sameUp   = dailyBull && wk.bull;
    const sameDown = dailyBear && wk.bear;
    const conflict = (dailyBull && wk.bear) || (dailyBear && wk.bull);

    const items = [];
    items.push({ ok: wk.bull,
      text: wk.bull
        ? `<strong>週線多頭</strong>：週收 ${wk.close.toFixed(2)} > 週MA10 ${wk.ma10.toFixed(2)}，月線連2週上揚`
        : wk.bear
          ? `<strong>週線空頭</strong>：週收 < 週MA10 且連2週下彎，大趨勢向下`
          : `<strong>週線中性</strong>：週收 ${wk.close.toFixed(2)} 貼近週MA10 ${wk.ma10.toFixed(2)}，大趨勢未明`,
      sub: `週線距 ${wk.distPct >= 0 ? '+' : ''}${wk.distPct.toFixed(1)}%（partial 週已跳過，用上一完整週判定）`,
      whyTitle: '為什麼先看週線？',
      why: '週線代表大趨勢、主力與法人的佈局方向。「順大勢逆小勢」——日線買訊只有在週線多頭時才是高勝率順勢單；週線空頭時的日線反彈多半是逃命波，勝率大幅下降。',
    });

    items.push({ ok: dailyBull,
      text: dailyBull ? `<strong>日線多頭</strong>：日收 > MA20 且 MA20 上揚`
           : dailyBear ? `<strong>日線空頭</strong>：日收 < MA20 且 MA20 下彎`
           : `<strong>日線盤整</strong>：日收貼近 MA20`,
      sub: '日線是進場時機層；與週線同向才放行',
      whyTitle: '日週同向的意義',
      why: '兩個週期同方向 = 共振，趨勢可信度最高；背離（日多週空）通常是大趨勢中的反彈或大趨勢中的回檔，風險報酬不對等。',
    });

    if (conflict) {
      items.push({ ok: false,
        text: `<strong>日週背離</strong>：${dailyBull ? '日多週空（反彈逃命波風險）' : '日空週多（大趨勢中回檔）'}`,
        sub: dailyBull ? '週線空頭下的日線轉強多為逃命波，追多風險高' : '週線多頭下的日線走弱多為健康回檔，可待轉強再進',
        whyTitle: '背離怎麼辦',
        why: '日多週空：別追，等週線翻多再說。日空週多：是大趨勢中的回檔，回檔到支撐轉強是順勢買點。',
      });
    }

    let signal, score;
    if (sameUp) {
      signal = { name: '多頭共振', icon: '🔭', stars: 5, desc: '日線、週線同步多頭，順勢最強，買訊高勝率。' }; score = 5;
    } else if (sameDown) {
      signal = { name: '空頭共振', icon: '📉', stars: 1, desc: '日線、週線同步空頭，避開做多，反彈是逃命波。' }; score = 1;
    } else if (dailyBull && wk.bear) {
      signal = { name: '日多週空', icon: '⚠️', stars: 2, desc: '週線空頭下的日線轉強，逃命波風險，不追。' }; score = 2;
    } else if (dailyBear && wk.bull) {
      signal = { name: '日空週多', icon: '🟡', stars: 3, desc: '週線多頭下的日線回檔，待轉強為順勢買點。' }; score = 3;
    } else if (wk.bull) {
      signal = { name: '週多日整', icon: '🟢', stars: 4, desc: '大趨勢多頭，日線盤整蓄勢，偏多看待。' }; score = 4;
    } else if (wk.bear) {
      signal = { name: '週空日整', icon: '🔴', stars: 2, desc: '大趨勢空頭，日線盤整，反彈宜減碼。' }; score = 2;
    } else {
      signal = { name: '趨勢未明', icon: '⚪', stars: 3, desc: '日週皆中性，方向未明，觀望為宜。' }; score = 3;
    }

    return { score, signal, items,
      raw: { wkBull: wk.bull, wkBear: wk.bear, wkClose: wk.close, wkMA10: wk.ma10, wkDist: wk.distPct,
             dailyBull, dailyBear, sameUp, sameDown, conflict, dC, dMA, n } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const r = ev.raw;
    return [
      { id: 'mtf-wk', name: r.wkBull ? '🔴 週多頭' : r.wkBear ? '🟢 週空頭' : '⚪ 週中性',
        value: r.wkMA10?.toFixed(2) ?? '—',
        color: r.wkBull ? '#ef5350' : r.wkBear ? '#26a69a' : '#9ca3af',
        tooltip: '週MA10：大趨勢方向線（順大勢逆小勢）' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🔭 週線共振</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">🔭</span><span class="fs-title">週線共振</span></div>
      <div class="fs-deep-module-body"><p style="color:var(--muted);padding:8px 4px 14px">此週期 K 棒不足（需 ≥ 70 根，約 14 週），請切換到 6月 / 1年。</p><div class="fs-teach"><div class="fs-teach-section"><h4>━━━ 🔭 這是什麼 ━━━</h4><p>同一檔股票在不同週期樣貌不同：<strong>週線=大趨勢</strong>（主力/法人佈局方向）、<strong>日線=進場時機</strong>。原則是「順大勢、逆小勢」——只在週線多頭時買日線的回檔/買訊，這就是用週線當濾網。日週同向（共振）時趨勢最可信；週線空頭下的日線轉強多半是反彈逃命波，勝率大幅下降。</p></div></div></div>`;

    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';
    const wkColor = r.wkBull ? '#ef5350' : r.wkBear ? '#26a69a' : '#9ca3af';
    const dColor  = r.dailyBull ? '#ef5350' : r.dailyBear ? '#26a69a' : '#9ca3af';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🔭</span>
        <span class="fs-title">多週期共振（週線確認）</span>
        <span class="fs-subtitle">MTF · 順大勢逆小勢，週線濾網殺假訊號</span>
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
          <h4>📍 日週方向對照</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(96,165,250,0.18);color:#60a5fa">週線（大勢）</span>
            <span class="fs-keylevel-price" style="color:${wkColor}">${r.wkBull ? '多頭 ↗' : r.wkBear ? '空頭 ↘' : '中性 →'}</span>
            <span class="fs-keylevel-desc">週MA10 ${fmt(r.wkMA10)}，週距 ${r.wkDist >= 0 ? '+' : ''}${r.wkDist.toFixed(1)}%</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(96,165,250,0.18);color:#60a5fa">日線（時機）</span>
            <span class="fs-keylevel-price" style="color:${dColor}">${r.dailyBull ? '多頭 ↗' : r.dailyBear ? '空頭 ↘' : '盤整 →'}</span>
            <span class="fs-keylevel-desc">日收 ${fmt(r.dC)} vs 日MA20 ${fmt(r.dMA)}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:${r.sameUp ? 'rgba(239,83,80,0.18)' : r.conflict ? 'rgba(251,191,36,0.18)' : 'rgba(148,163,184,0.18)'};color:${r.sameUp ? '#fca5a5' : r.conflict ? '#fbbf24' : '#9ca3af'}">共振</span>
            <span class="fs-keylevel-price" style="color:${r.sameUp ? '#ef4444' : r.sameDown ? '#10b981' : '#9ca3af'}">${r.sameUp ? '多頭共振' : r.sameDown ? '空頭共振' : r.conflict ? '日週背離' : '部分一致'}</span>
            <span class="fs-keylevel-desc">${r.sameUp ? '順勢最強，買訊高勝率' : r.sameDown ? '避開做多' : r.conflict ? '謹慎，方向不一致' : '偏向大勢方向'}</span>
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🔭 多週期共振原理 ━━━</h4>
            <p>同一檔股票在不同週期會呈現不同樣貌。<strong>週線 = 大趨勢（主力/法人佈局方向）</strong>，<strong>日線 = 進場時機</strong>。</p>
            <p style="margin-top:8px">「順大勢、逆小勢」：只在週線多頭時，才買日線的回檔/買訊——這就是用週線當濾網。週線空頭時的日線轉強，多半是大跌中的反彈逃命波。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 週線濾網的威力 ━━━</h4>
            <ul>
              <li><strong>殺假訊號</strong>：同一套日線策略，加上「週線多頭才放行」，交易次數通常下降、勝率上升</li>
              <li><strong>多頭共振 = 最強順勢</strong>：日週同多時的買訊，是風險報酬最對等的時機</li>
              <li><strong>日空週多 = 健康回檔</strong>：大趨勢沒壞，回檔到支撐轉強就是順勢買點</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>週線反應慢</strong>：轉折確認滯後，不適合搶最低點，適合確認趨勢站穩後跟進</li>
              <li><strong>當週未完不算</strong>：partial 週用上一完整週判定，避免盤中假訊號（前視偏差）</li>
              <li><strong>新股資料不足</strong>：需 ≥ 14 週才有可靠週MA10</li>
            </ul>
          </div>
        </div>

        ${renderAISection('mtf', '多週期共振（週線確認）', '🔭', ev, {
          '週線大勢【順大勢逆小勢的「大勢」】': r.wkBull ? '多頭 ↗' : r.wkBear ? '空頭 ↘' : '中性 →',
          '日線時機': r.dailyBull ? '多頭 ↗' : r.dailyBear ? '空頭 ↘' : '盤整 →',
          '共振狀態【同多=最強，背離=謹慎】': r.sameUp ? '多頭共振' : r.sameDown ? '空頭共振' : r.conflict ? '日週背離' : '部分一致',
          '週MA10': fmt(r.wkMA10),
          '週距': `${r.wkDist >= 0 ? '+' : ''}${r.wkDist.toFixed(1)}%`,
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>
    `;
  },
};

registerAnalysisModule(MTFModule);
