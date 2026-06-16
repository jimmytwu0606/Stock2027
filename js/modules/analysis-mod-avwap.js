/* js/modules/analysis-mod-avwap.js
 * ⚓ Anchored VWAP（錨定量加權均價線）教學模組 — T-2
 *
 * 主圖 overlay（chart.js _renderAVWAP）以「妖股啟動日」為錨；
 * 本教學模組為求 evaluate() 同步可算，錨點固定取「近 120 根波段低點」，
 * 兩者口徑各自誠實標註，不混為一談。
 */
import { AppState } from '../state.js';
import { anchoredVWAP, resolveAVWAPAnchor } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const ANCHOR_LOOKBACK = 120;   // 教學版錨點搜尋窗（近 N 根找波段低點）

const AVWAPModule = {
  id: 'avwap',
  name: '錨定VWAP',
  icon: '⚓',
  candleMinLen: 20,

  evaluate(candles) {
    const n = candles.length;
    if (n < 20) return { score: 3, signal: null, items: [], raw: null };

    // ── 錨點：與主圖共用解析器，口徑一致 ──
    //   妖股 active/rebirth → 啟動日（主升段成本，AppState.yaoguStatus 同步快取）
    //   否則 → 近 ANCHOR_LOOKBACK 日波段低點
    const code = AppState.activeCode || '';
    const ys = AppState.yaoguStatus?.[code] || null;
    let actSec = null;
    if (ys && (ys.status === 'active' || ys.status === 'rebirth' || ys.status === 'pullback') && ys.activatedAt) {
      const s = Math.floor(new Date(ys.activatedAt).getTime() / 1000);
      if (!Number.isNaN(s)) actSec = s;
    }
    const { anchorIdx, source } = resolveAVWAPAnchor(candles, actSec, ANCHOR_LOOKBACK);
    const anchorLabel = source === 'yaogu'
      ? '妖股啟動日（主升段成本）'
      : `近 ${ANCHOR_LOOKBACK} 日波段低點`;

    const av = anchoredVWAP(candles, anchorIdx);
    const lastAV   = av[n - 1];
    const lastC    = candles[n - 1].close;
    const prevAV   = av[n - 2] ?? lastAV;
    const prevC    = candles[n - 2]?.close ?? lastC;
    if (lastAV == null) return { score: 3, signal: null, items: [], raw: null };

    const isAbove = lastC > lastAV;
    const wasAbove = prevC > prevAV;
    const distPct = (lastC - lastAV) / lastAV * 100;

    // 成本線斜率（近 5 根）：上揚 = 平均成本墊高 = 買盤有承接
    const ref = av[Math.max(anchorIdx, n - 6)] ?? lastAV;
    const slope = lastAV - ref;
    const rising = slope > 0;

    // 洗盤收復 / 跌破成本（昨今交叉）
    const reclaim   = !wasAbove && isAbove;
    const breakdown = wasAbove && !isAbove;

    // 錨點起算天數
    const sinceDays = n - 1 - anchorIdx;

    const items = [];

    items.push({ ok: isAbove,
      text: isAbove
        ? `<strong>站上成本線</strong>：收盤 ${lastC.toFixed(2)} > AVWAP ${lastAV.toFixed(2)}（高 ${distPct.toFixed(1)}%）`
        : `<strong>跌破成本線</strong>：收盤 ${lastC.toFixed(2)} < AVWAP ${lastAV.toFixed(2)}（低 ${Math.abs(distPct).toFixed(1)}%）`,
      sub: `錨點為${anchorLabel}（${sinceDays} 個交易日前），此線為自錨點以來所有買盤的平均成本`,
      whyTitle: '站上 / 跌破 AVWAP 代表什麼？',
      why: 'AVWAP 是自錨點以來「成交量加權」的平均成本。收盤站上 = 錨點後進場者整體獲利、買方掌控；收盤跌破 = 整體套牢、賣壓隨時湧出。它比一般 MA 更貼近真實籌碼成本，因為它用量加權（大量成交的價位權重更高）。',
    });

    items.push({ ok: rising,
      text: rising
        ? `<strong>成本線上揚</strong>：近 5 日 AVWAP 墊高 ${slope.toFixed(2)}（買盤持續承接）`
        : `<strong>成本線下彎</strong>：近 5 日 AVWAP 走低 ${slope.toFixed(2)}（承接力道轉弱）`,
      sub: rising ? '平均成本墊高代表後進買盤願意用更高價承接，趨勢健康' : '平均成本下移代表新進買盤縮手或殺低，留意動能衰竭',
      whyTitle: '為什麼看成本線斜率？',
      why: 'AVWAP 上揚代表越晚進場的人成本越高、仍願意買，是主升段的特徵；下彎則代表買盤縮手。站上但下彎要小心——是反彈而非反轉。',
    });

    if (reclaim) {
      items.push({ ok: true,
        text: `<strong>洗盤收復</strong>：昨日跌破、今日重新站回 AVWAP`,
        sub: '跌破後快速收復是經典洗盤訊號，常見於主力甩轎後再拉',
        whyTitle: '收復成本線的意義',
        why: '價格短暫跌破成本線觸發停損賣壓，隨即被買回站上——代表破線是假摔，籌碼換手後續攻機率高。',
      });
    } else if (breakdown) {
      items.push({ ok: false,
        text: `<strong>跌破成本線</strong>：昨日站上、今日跌破 AVWAP`,
        sub: '由賺轉套的分水嶺，錨點以來的買盤開始虧損，賣壓易擴大',
        whyTitle: '跌破成本線的風險',
        why: '一旦多數持有者由賺轉套，任何反彈都會遇到解套賣壓（套牢盤回本就跑），AVWAP 由支撐反轉為壓力。',
      });
    }

    // 乖離過大提醒
    if (isAbove && distPct > 15) {
      items.push({ ok: false,
        text: `<strong>正乖離過大</strong>：高於成本線 ${distPct.toFixed(1)}%`,
        sub: '短線獲利了結壓力升高，常有回測成本線的需求',
        whyTitle: '乖離與回測',
        why: 'AVWAP 像橡皮筋的固定端，價格拉太遠後容易回測。乖離過大時站上不代表可追，宜等回測不破再進。',
      });
    }

    // ── 訊號評分 ──
    let signal, score;
    if (reclaim) {
      signal = { name: '洗盤收復', icon: '⚓', stars: 5, desc: '跌破後重新站回成本線，洗盤甩轎經典訊號，攻擊機率高。' }; score = 5;
    } else if (breakdown) {
      signal = { name: '跌破成本', icon: '📉', stars: 1, desc: '由賺轉套分水嶺，AVWAP 由支撐轉壓力，留意賣壓擴大。' }; score = 1;
    } else if (isAbove && rising && distPct <= 12) {
      signal = { name: '成本之上健康', icon: '🟢', stars: 4, desc: `站穩 AVWAP 上方 ${distPct.toFixed(1)}% 且成本線上揚，買盤掌控。` }; score = 4;
    } else if (isAbove && distPct > 15) {
      signal = { name: '正乖離過大', icon: '⚠️', stars: 3, desc: `高於成本線 ${distPct.toFixed(1)}%，獲利壓力大，宜等回測。` }; score = 3;
    } else if (isAbove && !rising) {
      signal = { name: '站上待確認', icon: '🟡', stars: 3, desc: '站上成本線但成本線下彎，反彈與反轉待分辨。' }; score = 3;
    } else if (!isAbove && rising) {
      signal = { name: '逼近成本線', icon: '🟠', stars: 3, desc: '收盤在成本線下方但成本線仍上揚，反攻成本線觀察中。' }; score = 3;
    } else {
      signal = { name: '成本之下弱勢', icon: '🔴', stars: 2, desc: `跌破成本線 ${Math.abs(distPct).toFixed(1)}% 且成本線走弱，反彈遇壓。` }; score = 2;
    }

    return { score, signal, items,
      raw: { lastAV, lastC, distPct, slope, rising, isAbove, reclaim, breakdown, anchorIdx, sinceDays, source, anchorLabel, n } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'avwap', name: '⚓ AVWAP',
        value: ev.raw.lastAV?.toFixed(2) ?? '—',
        color: '#fbbf24',
        tooltip: '錨定量加權均價（波段底以來平均成本）；站上=多方掌控，跌破=整體套牢' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">⚓ AVWAP</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">⚓</span><span class="fs-title">錨定 VWAP</span></div>
      <div class="fs-deep-module-body"><p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 20 根 K 線）</p></div>`;

    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';
    const avColor = r.isAbove ? '#ef5350' : '#26a69a';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">⚓</span>
        <span class="fs-title">錨定 VWAP（成本均線）</span>
        <span class="fs-subtitle">Anchored VWAP · 量加權平均成本 + 籌碼掌控判讀</span>
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
          <h4>📍 成本線當前狀態</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(251,191,36,0.18);color:#fbbf24">AVWAP</span>
            <span class="fs-keylevel-price" style="color:${avColor}">${fmt(r.lastAV)}</span>
            <span class="fs-keylevel-desc">錨點：${r.anchorLabel}（${r.sinceDays} 個交易日前起算）</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(96,165,250,0.18);color:#60a5fa">現價乖離</span>
            <span class="fs-keylevel-price" style="color:${r.isAbove ? '#ef5350' : '#26a69a'}">${r.distPct > 0 ? '+' : ''}${r.distPct.toFixed(1)}%</span>
            <span class="fs-keylevel-desc">${r.isAbove ? '站上成本線，錨點後買盤整體獲利' : '跌破成本線，錨點後買盤整體套牢'}</span>
          </div>
          ${r.reclaim ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">洗盤收復</span>
            <span class="fs-keylevel-price" style="color:#ef4444">今日發生</span>
            <span class="fs-keylevel-desc">跌破後重新站回，常見主力甩轎再拉</span>
          </div>` : ''}
          ${r.breakdown ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(38,166,154,0.18);color:#6ee7b7">跌破成本</span>
            <span class="fs-keylevel-price" style="color:#10b981">今日發生</span>
            <span class="fs-keylevel-desc">由賺轉套分水嶺，成本線轉為壓力</span>
          </div>` : ''}
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ ⚓ 錨定 VWAP 是什麼 ━━━</h4>
            <p>AVWAP = Σ[錨點→今]( (高+低+收)/3 × 量 ) ÷ Σ[錨點→今]( 量 )</p>
            <p>從一個指定起點（錨點）開始，把每天的「典型價」用成交量加權累計平均。它代表<strong>自錨點以來所有買盤的真實平均成本</strong>。</p>
            <p style="margin-top:8px">站上 = 多數人賺錢、買方有底氣；跌破 = 多數人套牢、解套賣壓沉重。這條線常成為主力進出與大資金的心理防線。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 錨點怎麼選 ━━━</h4>
            <ul>
              <li><strong>妖股啟動日</strong>（主圖自動）：主升段進場者的平均成本——跌破代表這波買盤全面套牢，是妖股系統最強的防線</li>
              <li><strong>波段低點</strong>（本頁判讀採用）：整個波段持有者的成本</li>
              <li><strong>除權息日 / 利多日</strong>：事件後新買盤的成本基準</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🔍 與一般均線（MA）的本質差異 ━━━</h4>
            <ul>
              <li><strong>量加權 vs 時間平均</strong>：MA 每天權重相同；AVWAP 給「爆量日」更高權重，更貼近真實籌碼成本</li>
              <li><strong>有起點 vs 滾動窗</strong>：MA 永遠看固定 N 天；AVWAP 從你指定的事件錨點起算，回答「從那件事之後，大家賺還賠」</li>
              <li><strong>累計計算</strong>：AVWAP 是累計量，錨點之後的 K 線必須完整，不能只看一段</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>錨點選錯就失真</strong>：錨在無意義的日子，這條線就沒有籌碼意義</li>
              <li><strong>日 K 為近似口徑</strong>：真正的 VWAP 需要逐筆（tick）資料，日 K 版用 (高+低+收)/3 近似</li>
              <li><strong>正乖離過大別追</strong>：拉離成本線太遠時容易回測，等回測不破再進場較穩</li>
            </ul>
          </div>
        </div>

        ${renderAISection('avwap', '錨定 VWAP 成本均線', '⚓', ev, {
          'AVWAP成本線【站上=獲利掌控，跌破=套牢壓力】': `${fmt(r.lastAV)}（錨點：${r.anchorLabel}，${r.sinceDays}日前）`,
          '現價': fmt(r.lastC),
          '現價乖離【>15%正乖離過大宜等回測】': `${r.distPct > 0 ? '+' : ''}${r.distPct.toFixed(1)}%`,
          '成本線斜率【上揚=買盤承接，下彎=承接轉弱】': `${r.slope > 0 ? '+' : ''}${r.slope.toFixed(2)}（${r.rising ? '↑上揚' : '↓下彎'}）`,
          '今昨交叉': r.reclaim ? '⚓ 洗盤收復（昨破今站回，攻擊訊號）' : r.breakdown ? '📉 跌破成本（昨站今破，套牢警示）' : '無交叉',
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>
    `;
  },
};

registerAnalysisModule(AVWAPModule);
