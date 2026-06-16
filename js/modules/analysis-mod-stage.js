/* js/modules/analysis-mod-stage.js
 * 🌀 Weinstein 四階段分類教學模組 — T-5
 * 軸線=週MA30。只買 2（上升）、賣 3（頭部）、避 4（下降）、等 1（底部）。
 */
import { AppState } from '../state.js';
import { calcWeinsteinStage } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const STAGE_META = {
  1: { name: '第一階段 · 底部整理', icon: '🔵', color: '#9ca3af', short: 'S1 底部',
       desc: '價格繞週MA30 橫盤、月線走平，跌勢結束但未轉強，築底中。', action: '觀察等待，待放量突破進 Stage 2 再進場' },
  2: { name: '第二階段 · 上升期',   icon: '🔴', color: '#ef5350', short: 'S2 上升',
       desc: '價格站上週MA30 且月線上揚，主升段，最佳持有期。', action: '★ 唯一該買的階段：回檔到週MA30 是加碼點' },
  3: { name: '第三階段 · 頭部整理', icon: '🟠', color: '#f59e0b', short: 'S3 頭部',
       desc: '價格繞週MA30 橫盤、月線走平於高檔，漲勢力竭，派發中。', action: '逢高減碼/出場，不戀棧，跌破月線即離場' },
  4: { name: '第四階段 · 下降期',   icon: '🟢', color: '#26a69a', short: 'S4 下降',
       desc: '價格跌破週MA30 且月線下彎，主跌段，最該迴避。', action: '避開做多，接刀必傷，等走完跌勢進 Stage 1' },
  0: { name: '資料不足',           icon: '⚪', color: '#9ca3af', short: '—',
       desc: '週K不足 32 根（約 150 根日K），週MA30 無法成形。', action: '資料累積後再分類' },
};

const STAGE_STARS = { 2: 5, 1: 3, 0: 3, 3: 2, 4: 1 };

const StageModule = {
  id: 'stage',
  name: 'Weinstein 階段',
  icon: '🌀',
  candleMinLen: 1,    // 不綁圖表週期：自取 2 年日K（window.__taDaily），永不 🔒

  evaluate(candles) {
    const _code = AppState.activeCode || '';
    if (window.__taDaily?.code === _code && window.__taDaily.candles?.length) {
      candles = window.__taDaily.candles;
    }
    const n = candles.length;
    const w = calcWeinsteinStage(candles);
    const stage = w.ready ? w.stage : 0;
    const meta  = STAGE_META[stage];

    const items = [];
    items.push({ ok: stage === 2 || stage === 1,
      text: `<strong>${meta.name}</strong>${w.ready ? `：收盤 ${w.close.toFixed(2)} ${w.above ? '≥' : '<'} 週MA30 ${w.ma30.toFixed(2)}` : ''}`,
      sub: meta.desc,
      whyTitle: 'Weinstein 四階段是什麼？',
      why: 'Stan Weinstein 用 30 週均線（週MA30）把所有走勢分成四個循環階段：①底部整理 → ②上升 → ③頭部整理 → ④下降 → 回到①。紀律核心是「只買 2、賣 3、避 4、等 1」。',
    });

    if (w.ready) {
      items.push({ ok: w.slopePct > 0,
        text: `<strong>週MA30 ${w.flat ? '走平' : w.slopePct > 0 ? '上揚' : '下彎'}</strong>：近 5 週斜率 ${w.slopePct >= 0 ? '+' : ''}${w.slopePct.toFixed(1)}%`,
        sub: w.flat ? '月線走平 = 整理階段（1 或 3，靠價格高低檔區分）' : w.slopePct > 0 ? '月線上揚撐住趨勢' : '月線下彎，趨勢向下',
        whyTitle: '為什麼看週MA30 斜率？',
        why: '週MA30 是 Weinstein 體系的生命線。月線方向 + 價格在月線上/下，就決定了階段。月線走平代表趨勢進入整理，是 1↔2 或 3↔4 的轉折帶。',
      });

      if (stage === 2) {
        items.push({ ok: true, text: `<strong>主升段進行中</strong>：唯一該持有/加碼的階段`,
          sub: '回檔到週MA30 不破是加碼點；跌破月線進入 Stage 3/4 警戒', whyTitle: '為何只買 Stage 2',
          why: 'Stage 2 是趨勢、量能、籌碼三者最一致的時期，順勢做多風險報酬最佳。其餘三階段做多都是逆勢或賭轉折。' });
      } else if (stage === 4) {
        items.push({ ok: false, text: `<strong>主跌段</strong>：最該迴避，接刀必傷`,
          sub: '反彈到週MA30 受壓是減碼點，不是買點', whyTitle: '為何避 Stage 4',
          why: 'Stage 4 月線下彎壓制每一次反彈，任何抄底都在跟大趨勢對作，勝率極低。' });
      } else if (stage === 3) {
        items.push({ ok: false, text: `<strong>頭部派發</strong>：漲勢力竭，逢高出場`,
          sub: '跌破週MA30 即確認進入 Stage 4，不可戀棧', whyTitle: '為何賣 Stage 3',
          why: '頭部整理是主力派發期，價量背離常見，再不走就會被 Stage 4 套住。' });
      }
    }

    const stars = STAGE_STARS[stage] ?? 3;
    const signal = { name: meta.short, icon: meta.icon, stars, desc: meta.desc };
    const score  = stars;

    return { score, signal, items,
      raw: { stage, ready: w.ready, ma30: w.ma30, close: w.close, slopePct: w.slopePct, above: w.above, flat: w.flat, n } };
  },

  getLegendRows(ev) {
    if (!ev.raw || !ev.raw.ready) return [];
    const m = STAGE_META[ev.raw.stage];
    return [
      { id: 'stage-ma30', name: `${m.icon} 週MA30`,
        value: ev.raw.ma30?.toFixed(2) ?? '—',
        color: m.color,
        tooltip: 'Weinstein 軸線：價在上/下 + 月線方向 → 四階段' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🌀 階段</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const meta = STAGE_META[r ? r.stage : 0];
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';

    // 四階段循環視覺（當前階段高亮）
    const cycle = [1, 2, 3, 4].map(s => {
      const mm = STAGE_META[s];
      const on = r && r.stage === s;
      return `<div style="flex:1;text-align:center;padding:8px 4px;border-radius:8px;background:${on ? mm.color + '33' : 'rgba(148,163,184,0.08)'};border:1px solid ${on ? mm.color : 'transparent'}">
        <div style="font-size:18px">${mm.icon}</div>
        <div style="font-size:12px;color:${on ? mm.color : 'var(--muted)'};font-weight:${on ? '700' : '400'}">${mm.short}</div>
      </div>`;
    }).join('<div style="align-self:center;color:var(--muted)">→</div>');

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🌀</span>
        <span class="fs-title">Weinstein 四階段分類</span>
        <span class="fs-subtitle">Stage Analysis · 軸線週MA30 · 只買2賣3避4等1</span>
      </div>
      <div class="fs-deep-module-body">
        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">${ev.items.map(_renderReadoutItem).join('')}</div>
          <div class="fs-readout-summary">
            <span class="fs-signal-icon">${ev.signal.icon}</span>
            <div class="fs-signal-text">
              <span class="fs-signal-name">${meta.name}</span>
              <span class="fs-signal-desc">${meta.action}</span>
            </div>
            <span class="fs-signal-stars">${stars}</span>
          </div>
        </div>

        <div class="fs-keylevels">
          <h4>📍 四階段循環</h4>
          <div style="display:flex;gap:6px;align-items:stretch;margin:6px 0 14px">${cycle}</div>
          ${r && r.ready ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:${meta.color}33;color:${meta.color}">週MA30</span>
            <span class="fs-keylevel-price" style="color:${r.above ? '#ef5350' : '#26a69a'}">${fmt(r.ma30)}</span>
            <span class="fs-keylevel-desc">收盤 ${fmt(r.close)} 在月線${r.above ? '上方' : '下方'}，月線${r.flat ? '走平' : r.slopePct > 0 ? '上揚' : '下彎'}（${r.slopePct >= 0 ? '+' : ''}${r.slopePct.toFixed(1)}%/5週）</span>
          </div>` : `<div class="fs-keylevel-row"><span class="fs-keylevel-desc" style="color:var(--muted)">資料不足，需 ≥ 160 根日 K（約 32 週）才能成形週MA30</span></div>`}
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🌀 四階段循環 ━━━</h4>
            <p><strong>① 底部整理</strong>：跌勢止穩，價繞月線橫盤，月線走平 → 築底</p>
            <p><strong>② 上升期</strong>：站上月線、月線上揚 → 主升段（唯一該買）</p>
            <p><strong>③ 頭部整理</strong>：漲勢力竭，價繞月線橫盤於高檔 → 派發（該賣）</p>
            <p><strong>④ 下降期</strong>：跌破月線、月線下彎 → 主跌段（該避）</p>
            <p style="margin-top:8px">四階段周而復始：1→2→3→4→1。月線（週MA30）是判斷的生命線。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 操作紀律：只買 2 賣 3 避 4 ━━━</h4>
            <ul>
              <li><strong>只買 Stage 2</strong>：趨勢、量能、籌碼最一致，順勢風險報酬最佳</li>
              <li><strong>賣 Stage 3</strong>：頭部派發，再不走就被 Stage 4 套住</li>
              <li><strong>避 Stage 4</strong>：主跌段接刀必傷，月線壓制每次反彈</li>
              <li><strong>等 Stage 1</strong>：築底期觀察，放量突破進 2 再進場</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>週MA30 反應慢</strong>：階段轉換確認滯後，不搶轉折點，適合中長線定位</li>
              <li><strong>1↔3 靠位置區分</strong>：走平期以「價格在近兩年區間高低檔」判底部/頭部</li>
              <li><strong>新股不分類</strong>：資料不足 32 週標「資料不足」，不硬猜</li>
            </ul>
          </div>
        </div>

        ${renderAISection('stage', 'Weinstein 四階段', '🌀', ev, {
          '當前階段【只買2賣3避4等1】': `${meta.icon} ${meta.name}`,
          '操作指引': meta.action,
          '週MA30【軸線】': r && r.ready ? fmt(r.ma30) : '資料不足',
          '價格相對月線': r && r.ready ? (r.above ? '在月線上方' : '在月線下方') : '—',
          '月線方向【近5週】': r && r.ready ? (r.flat ? '走平' : r.slopePct > 0 ? '上揚' : '下彎') + `（${r.slopePct >= 0 ? '+' : ''}${(r.slopePct ?? 0).toFixed(1)}%）` : '—',
          '綜合訊號': `${meta.name}（${meta.desc}）`,
        })}
      </div>
    `;
  },
};

registerAnalysisModule(StageModule);
