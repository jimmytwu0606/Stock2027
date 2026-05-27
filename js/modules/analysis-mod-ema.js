/* js/modules/analysis-mod-ema.js
 * 🌟 EMA Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcEMA } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const EMAModule = {
  id: 'ema',
  name: 'EMA 指數移動平均',
  icon: '📐',
  candleMinLen: 60,  // EMA60 需 60 根才穩定

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const lastClose = closes[n - 1];

    // 三條 EMA（對應 chart.js 的 5/20/60，橘/紫/綠）
    const PERIODS = [5, 20, 60];
    const COLORS  = ['橘', '紫', '綠'];
    const emas = PERIODS.map(p => calcEMA(closes, p));
    const [e5, e20, e60] = emas.map(arr => arr[n - 1]);
    const [pe5, pe20, pe60] = emas.map(arr => arr[n - 2] ?? arr[n - 1]);

    // 乖離率（距 EMA20）
    const bias20 = e20 != null ? ((lastClose - e20) / e20 * 100) : null;
    const bias60 = e60 != null ? ((lastClose - e60) / e60 * 100) : null;

    // 各 EMA 斜率（本根 vs 前根）
    const slope5  = e5  != null ? e5  - pe5  : null;
    const slope20 = e20 != null ? e20 - pe20 : null;
    const slope60 = e60 != null ? e60 - pe60 : null;

    // 多頭排列判斷：收盤 > EMA5 > EMA20 > EMA60
    const bullAlign = lastClose > e5 && e5 > e20 && e20 > e60;
    // 空頭排列：收盤 < EMA5 < EMA20 < EMA60
    const bearAlign = lastClose < e5 && e5 < e20 && e20 < e60;

    // 黃金/死亡交叉（EMA5 vs EMA20，近 3 根）
    let crossBull5_20 = false, crossBear5_20 = false;
    for (let i = Math.max(1, n - 3); i < n; i++) {
      const curE5  = emas[0][i],     curE20  = emas[1][i];
      const prevE5 = emas[0][i - 1], prevE20 = emas[1][i - 1];
      if (prevE5 <= prevE20 && curE5 > curE20) crossBull5_20 = true;
      if (prevE5 >= prevE20 && curE5 < curE20) crossBear5_20 = true;
    }

    // 近 5 根 EMA5 走勢（連續上升/下降）
    const e5Slice = emas[0].slice(-5);
    const e5Trend = e5Slice.every((v, i) => i === 0 || v > e5Slice[i - 1]) ? '連續上升'
                  : e5Slice.every((v, i) => i === 0 || v < e5Slice[i - 1]) ? '連續下降'
                  : '震盪';

    const items = [];

    // ── 條件 1：三線排列 ──
    if (bullAlign) {
      items.push({
        ok: true,
        text: `<strong>多頭排列</strong>：收盤 > EMA5 > EMA20 > EMA60`,
        sub: `${lastClose.toFixed(2)} > ${e5.toFixed(2)} > ${e20.toFixed(2)} > ${e60.toFixed(2)}`,
        whyTitle: '為什麼多頭排列這麼重要？',
        why: '三條 EMA 由短到長依序排列（收盤 > EMA5 > EMA20 > EMA60），代表短中長期趨勢全面一致向上。這是趨勢最健康的狀態，機構法人常以此確認多頭趨勢成立，在此格局下回踩 EMA20 通常是加碼機會。',
      });
    } else if (bearAlign) {
      items.push({
        ok: false,
        text: `<strong>空頭排列</strong>：收盤 < EMA5 < EMA20 < EMA60`,
        sub: `${lastClose.toFixed(2)} < ${e5.toFixed(2)} < ${e20.toFixed(2)} < ${e60.toFixed(2)}`,
        whyTitle: '為什麼空頭排列是危險訊號？',
        why: '三條 EMA 由短到長依序排列（收盤 < EMA5 < EMA20 < EMA60），代表短中長期趨勢全面向下。這是最明確的空頭格局，任何反彈到 EMA5 或 EMA20 附近都可能受壓，不宜追多。',
      });
    } else {
      // 判斷多偏/空偏/混亂
      const aboveCount = [e5, e20, e60].filter(e => e != null && lastClose > e).length;
      items.push({
        ok: aboveCount >= 2 ? true : aboveCount <= 1 ? false : null,
        text: `<strong>部分排列</strong>：收盤在 ${aboveCount}/3 條 EMA 上方`,
        sub: `EMA5 ${lastClose > e5 ? '✅' : '❌'}${e5.toFixed(2)}  EMA20 ${lastClose > e20 ? '✅' : '❌'}${e20.toFixed(2)}  EMA60 ${lastClose > e60 ? '✅' : '❌'}${e60.toFixed(2)}`,
        whyTitle: '為什麼部分排列是過渡狀態？',
        why: '收盤在部分 EMA 之上，代表多空力道交錯，尚未形成完整排列。通常出現在趨勢轉換的過渡期，需要耐心等待方向確認（完整多頭排列或完整空頭排列），才能判定下一段趨勢。',
      });
    }

    // ── 條件 2：EMA5 vs EMA20 交叉（近 3 根）──
    if (crossBull5_20) {
      items.push({
        ok: true,
        text: `<strong>EMA5 黃金交叉 EMA20</strong>：近 3 根 EMA5 上穿 EMA20`,
        sub: `短期動能翻多，EMA5（${e5.toFixed(2)}）> EMA20（${e20.toFixed(2)}）`,
        whyTitle: '為什麼 EMA 黃金交叉是訊號？',
        why: 'EMA5 上穿 EMA20（黃金交叉）代表短期（5日）動能開始優於中期（20日），類似 KD 黃金交叉但更平滑，假訊號更少。搭配成交量放大時，是中短線轉折向上的可靠訊號。',
      });
    } else if (crossBear5_20) {
      items.push({
        ok: false,
        text: `<strong>EMA5 死亡交叉 EMA20</strong>：近 3 根 EMA5 下穿 EMA20`,
        sub: `短期動能轉空，EMA5（${e5.toFixed(2)}）< EMA20（${e20.toFixed(2)}）`,
        whyTitle: '為什麼死亡交叉是賣出訊號？',
        why: 'EMA5 下穿 EMA20（死亡交叉）代表短期動能開始弱於中期，是趨勢轉折向下的確認訊號。相比 MA 死亡交叉，EMA 反應更快（EMA 對近期價格加權更重），因此訊號也更早出現。',
      });
    } else {
      items.push({
        ok: e5 > e20,
        text: e5 > e20
          ? `<strong>EMA5 在 EMA20 上方</strong>：短線動能維持多頭`
          : `<strong>EMA5 在 EMA20 下方</strong>：短線動能偏空`,
        sub: `EMA5 ${e5.toFixed(2)} vs EMA20 ${e20.toFixed(2)}（差距 ${(e5 - e20) > 0 ? '+' : ''}${(e5 - e20).toFixed(2)}）`,
        whyTitle: 'EMA5 vs EMA20 的意義？',
        why: 'EMA5 代表近 5 日的加權平均動能，EMA20 代表近 20 日。EMA5 持續在 EMA20 上方，代表短線力道持續優於中線，是多頭趨勢健康延伸的表現。',
      });
    }

    // ── 條件 3：收盤與 EMA20 乖離 ──
    if (bias20 != null) {
      const overbought = bias20 > 8;
      const oversold   = bias20 < -8;
      items.push({
        ok: oversold ? true : overbought ? false : null,
        text: overbought
          ? `<strong>正乖離過大</strong>：收盤高出 EMA20 ${bias20.toFixed(2)}%（+8% 以上警戒）`
          : oversold
          ? `<strong>負乖離過大</strong>：收盤低於 EMA20 ${Math.abs(bias20).toFixed(2)}%（-8% 以下反彈機會）`
          : `<strong>乖離正常</strong>：收盤距 EMA20 ${bias20 > 0 ? '+' : ''}${bias20.toFixed(2)}%`,
        sub: `EMA20 = ${e20.toFixed(2)}，乖離率 ${bias20 > 0 ? '+' : ''}${bias20.toFixed(2)}%`,
        whyTitle: '為什麼乖離率要注意？',
        why: '乖離率衡量現價偏離均線的幅度。正乖離過大（+8% 以上）代表短線漲幅過快，均值回歸壓力增加；負乖離過大（-8% 以下）代表短線跌幅過深，反彈機率提升。但強勢趨勢中乖離率可以持續偏高，不能只靠乖離率決策。',
      });
    }

    // ── 條件 4：EMA5 近期斜率（動能方向）──
    items.push({
      ok: slope5 > 0,
      text: `<strong>EMA5 動能</strong>：${slope5 > 0 ? '↑ 向上加速' : slope5 < 0 ? '↓ 向下滑落' : '→ 持平'}`,
      sub: `EMA5 本根 ${e5.toFixed(2)} vs 前根 ${pe5.toFixed(2)}（變化 ${slope5 > 0 ? '+' : ''}${slope5.toFixed(2)}）　近5根：${e5Trend}`,
      whyTitle: '為什麼看 EMA5 斜率？',
      why: 'EMA5 的斜率反映最近 5 日的動能加速/減速。EMA5 轉為正斜率（開始向上彎）往往比收盤站上 EMA5 早出現，是最靈敏的短線動能指標。',
    });

    // ── 條件 5：EMA60 斜率（長線方向）──
    if (slope60 != null) {
      items.push({
        ok: slope60 > 0,
        text: `<strong>EMA60 方向</strong>：${slope60 > 0 ? '↑ 長線多頭（EMA60 向上）' : slope60 < 0 ? '↓ 長線空頭（EMA60 向下）' : '→ 長線持平'}`,
        sub: `EMA60 本根 ${e60.toFixed(2)} vs 前根 ${pe60.toFixed(2)}（斜率 ${slope60 > 0 ? '+' : ''}${slope60.toFixed(2)}）`,
        whyTitle: '為什麼 EMA60 的方向重要？',
        why: 'EMA60（約 3 個月均線）的斜率代表中長期趨勢的方向。EMA60 向上 = 中長期多頭；EMA60 向下 = 中長期空頭。順著 EMA60 方向操作勝率最高；逆著 EMA60 操作（如 EMA60 向下還做多）需要非常明確的短線訊號才值得冒險。',
      });
    }

    // ── 綜合訊號 ──
    let signal, score;
    const aboveAll  = lastClose > e5 && lastClose > e20 && lastClose > e60;
    const allUp     = slope5 > 0 && slope20 > 0 && (slope60 == null || slope60 > 0);

    if (bullAlign && allUp) {
      signal = { name: '多頭完美排列', icon: '📐', stars: 5,
        desc: '收盤 > EMA5 > EMA20 > EMA60，三線同向上，趨勢最健康狀態。' };
      score = 5;
    } else if (bullAlign) {
      signal = { name: '多頭排列', icon: '🔵', stars: 4,
        desc: '三線多頭排列，趨勢偏多。部分 EMA 斜率尚未完全向上，動能仍在醞釀。' };
      score = 4;
    } else if (crossBull5_20) {
      signal = { name: 'EMA 黃金交叉', icon: '✨', stars: 4,
        desc: 'EMA5 上穿 EMA20，短期動能翻多，留意是否能站穩 EMA20 之上。' };
      score = 4;
    } else if (bearAlign) {
      signal = { name: '空頭排列', icon: '🔴', stars: 1,
        desc: '三線空頭排列，趨勢偏空，反彈到 EMA5 / EMA20 常受壓，不宜追多。' };
      score = 1;
    } else if (crossBear5_20) {
      signal = { name: 'EMA 死亡交叉', icon: '⚡', stars: 2,
        desc: 'EMA5 下穿 EMA20，短期動能轉空，注意回檔空間。' };
      score = 2;
    } else if (aboveAll && slope5 > 0) {
      signal = { name: '站上均線群', icon: '🟢', stars: 3,
        desc: '收盤站上所有 EMA，多頭動能持續，但排列尚未完整，觀察是否能形成標準多頭排列。' };
      score = 3;
    } else if (bias20 < -8 && slope5 > 0) {
      signal = { name: '超跌反彈', icon: '⚡', stars: 3,
        desc: '收盤大幅低於 EMA20（乖離過大）且 EMA5 開始向上，短線反彈機率提升。' };
      score = 3;
    } else {
      signal = { name: '多空交錯', icon: '⏸', stars: 2,
        desc: '三條 EMA 排列混亂，多空力道交錯，等待明確排列再操作。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { e5, e20, e60, pe5, pe20, pe60, slope5, slope20, slope60,
             bias20, bias60, bullAlign, bearAlign, crossBull5_20, crossBear5_20,
             e5Trend, lastClose, n,
             e5Arr: emas[0], e20Arr: emas[1], e60Arr: emas[2] },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = v => v?.toFixed(2) ?? '—';
    return [
      { id: 'ema5',  name: '🟠 EMA5',  value: fmt(ev.raw.e5),  color: '#f97316',
        tooltip: '5日指數移動平均，短線動能，反應最靈敏' },
      { id: 'ema20', name: '🟣 EMA20', value: fmt(ev.raw.e20), color: '#a78bfa',
        tooltip: '20日指數移動平均，中期趨勢核心' },
      { id: 'ema60', name: '🟢 EMA60', value: fmt(ev.raw.e60), color: '#34d399',
        tooltip: '60日指數移動平均，長線方向指標' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📐 EMA</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">📐</span>
        <span class="fs-title">EMA 指數移動平均</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 60 根 K 線才能計算 EMA60）</p>
      </div>`;
    }

    const r    = ev.raw;
    const fmt  = v => v?.toFixed(2) ?? '—';
    const fmtP = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📐</span>
        <span class="fs-title">EMA 指數移動平均</span>
        <span class="fs-subtitle">Exponential Moving Average · EMA5 / EMA20 / EMA60 排列判讀</span>
      </div>
      <div class="fs-deep-module-body">

        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">
            ${ev.items.map(_renderReadoutItem).join('')}
          </div>
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
          <h4>📍 EMA 當前數值（由高到低排列）</h4>
          ${[
            { label: 'EMA5',  val: r.e5,  slope: r.slope5,  color: 'rgba(249,115,22,0.18)', tc: '#fbbf24', desc: '短期動能 · 5日加權' },
            { label: 'EMA20', val: r.e20, slope: r.slope20, color: 'rgba(167,139,250,0.18)', tc: '#c4b5fd', desc: '中期趨勢 · 20日加權' },
            { label: 'EMA60', val: r.e60, slope: r.slope60, color: 'rgba(52,211,153,0.18)',  tc: '#6ee7b7', desc: '長線方向 · 60日加權' },
          ].sort((a, b) => b.val - a.val).map(row => `
            <div class="fs-keylevel-row">
              <span class="fs-keylevel-tag" style="background:${row.color};color:${row.tc}">${row.label}</span>
              <span class="fs-keylevel-price">${fmt(row.val)}</span>
              <span class="fs-keylevel-desc">${row.desc}　斜率 ${row.slope != null ? fmtP(row.slope) : '—'}　${row.val != null && r.lastClose > row.val ? '✅ 收盤在上' : '❌ 收盤在下'}</span>
            </div>
          `).join('')}
          <div class="fs-keylevel-row" style="border-top:1px solid rgba(255,255,255,0.08);padding-top:10px;margin-top:4px">
            <span class="fs-keylevel-tag" style="background:rgba(59,130,246,0.18);color:#93c5fd">現價</span>
            <span class="fs-keylevel-price" style="color:#93c5fd">${fmt(r.lastClose)}</span>
            <span class="fs-keylevel-desc">EMA20 乖離 ${fmtP(r.bias20)}%　EMA60 乖離 ${fmtP(r.bias60)}%</span>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_emaActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">

          <div class="fs-teach-section">
            <h4>━━━ 📐 EMA vs MA 差在哪？ ━━━</h4>
            <p><strong>MA（簡單移動平均）</strong>：等權重，所有 N 日的收盤價一律同樣重要</p>
            <p><strong>EMA（指數移動平均）</strong>：近期資料給更高的權重，對最新價格反應更快</p>
            <p style="margin-top:8px">例如 EMA5：今天的收盤約占權重 33%，昨天約 22%，前天約 15%... 越早越輕。這讓 EMA 在趨勢開始轉折時比 MA 更早發出訊號。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🎯 三線排列的操作邏輯 ━━━</h4>
            <ul>
              <li><strong>完美多頭排列</strong>（收盤 > EMA5 > EMA20 > EMA60）：持多留倉，回踩 EMA20 可加碼</li>
              <li><strong>完美空頭排列</strong>（收盤 < EMA5 < EMA20 < EMA60）：反彈到 EMA5 / EMA20 附近減碼，不宜追多</li>
              <li><strong>EMA5 黃金交叉 EMA20</strong>：短線轉多的確認，搭配量能放大可試單</li>
              <li><strong>收盤跌破 EMA60</strong>：中長期趨勢可能轉空，降低部位</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 📏 乖離率的實戰意義 ━━━</h4>
            <ul>
              <li><strong>正乖離 > +8%</strong>（EMA20）：短線過熱，均值回歸壓力增加，避免追高</li>
              <li><strong>負乖離 > -8%</strong>（EMA20）：短線過度拋售，若 EMA5 開始向上，可布局反彈</li>
              <li><strong>乖離率 ±3% 以內</strong>：現價靠近均線，此時均線同時是支撐也是壓力</li>
              <li>強勢多頭趨勢中，正乖離可以持續偏高（+10%~+20%）很長時間，不能單靠乖離大就賣</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>均線滯後</strong>：EMA 對趨勢確認有效，但進場點通常已過了最佳時機，搭配 KD/MACD 抓轉折點</li>
              <li><strong>盤整市假訊號</strong>：震盪盤中 EMA5/EMA20 來回交叉，訊號失真。看 ADX 或 DMI 確認是否有趨勢</li>
              <li><strong>EMA60 需 60 根</strong>：週期太短（1mo=20根）時 EMA60 無法計算，系統會顯示 disabled</li>
            </ul>
          </div>

        </div>

        ${renderAISection('ema', 'EMA 指數移動平均', '📐', ev, (() => {
          const fmt  = v => v?.toFixed(2) ?? '—';
          const fmtP = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

          // 近5根 EMA5 走勢（含斜率方向）
          const e5Slice = r.e5Arr.slice(-5);
          const recent5e5 = e5Slice.map((v, i) => {
            const label = i === 4 ? '【當根】' : `【-${4 - i}根】`;
            const dir = i > 0
              ? (v > e5Slice[i-1] ? '↑' : v < e5Slice[i-1] ? '↓' : '→')
              : '';
            return `${label}${v?.toFixed(2)??'—'}${dir}`;
          }).join(' → ');

          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          const passCount = ev.items.filter(i => i.ok === true).length;
          const failCount = ev.items.filter(i => i.ok === false).length;

          return {
            'EMA5【短期動能，5日加權，橘色線】': fmt(r.e5),
            'EMA20【中期趨勢，20日加權，紫色線】': fmt(r.e20),
            'EMA60【長線方向，60日加權，綠色線】': fmt(r.e60),
            '三線排列狀態【多頭/空頭/混亂】': r.bullAlign
              ? `✅ 多頭排列（收盤>${fmt(r.e5)}>EMA20>${fmt(r.e20)}>EMA60>${fmt(r.e60)}）`
              : r.bearAlign
              ? `❌ 空頭排列（收盤<${fmt(r.e5)}<EMA20<${fmt(r.e20)}<EMA60<${fmt(r.e60)}）`
              : `⏸ 部分排列（多空交錯）`,
            'EMA5 vs EMA20【正=EMA5在上，負=EMA5在下】': `${fmtP(r.e5 - r.e20)}（${r.e5 > r.e20 ? 'EMA5在上，短線偏多' : 'EMA5在下，短線偏空'}）`,
            'EMA5 斜率【本根vs前根，正=向上，負=向下】': `${fmtP(r.slope5)}（${r.e5Trend}）`,
            'EMA20 斜率【中期動能方向】': fmtP(r.slope20),
            'EMA60 斜率【長線方向，正=多頭，負=空頭】': fmtP(r.slope60),
            'EMA20 乖離率【正=偏貴，負=超跌，±8%警戒】': `${fmtP(r.bias20)}%（${Math.abs(r.bias20) > 8 ? Math.abs(r.bias20) > 12 ? '⚠️ 極端乖離' : '⚠️ 警戒區' : '正常範圍'}）`,
            'EMA60 乖離率': `${fmtP(r.bias60)}%`,
            '近期交叉【EMA5 vs EMA20，近3根】': r.crossBull5_20 ? '近3根 EMA5 黃金交叉 EMA20（↑）'
              : r.crossBear5_20 ? '近3根 EMA5 死亡交叉 EMA20（↓）' : '近3根無交叉',
            '近5根EMA5走勢【由舊到新，最右為當根，含方向】': recent5e5,
            [`各條件達成狀態【共${ev.items.length}項，✅${passCount}達標 ❌${failCount}未達標】`]: itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}

      </div>
    `;
  },
};

// ── helper：EMA 行動指引列 ──
function _emaActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;
  const fmt = v => v?.toFixed(2) ?? '—';

  if (sig === '多頭完美排列') {
    return [
      { label: '持倉建議', detail: `<strong>多單續抱</strong>，多頭完美排列是最健康的趨勢狀態，不要因短線震盪提早出場` },
      { label: '加碼條件', detail: `回踩 <span class="fs-price">${fmt(r.e20)}</span>（EMA20）止穩反彈 → 加碼機會；EMA5/EMA20 同步向上則動能最強` },
      { label: '停損設置', detail: `收盤跌破 <span class="fs-price">${fmt(r.e20)}</span>（EMA20）→ 減碼；跌破 <span class="fs-price">${fmt(r.e60)}</span>（EMA60）→ 大幅減碼` },
      { label: '注意事項', detail: `EMA20 乖離率 ${r.bias20 > 0 ? '+' : ''}${r.bias20?.toFixed(1)}%${Math.abs(r.bias20) > 8 ? '，已進入警戒區，短線不宜追高' : '，乖離正常，可繼續持有'}` },
    ];
  }
  if (sig === '多頭排列') {
    return [
      { label: '持倉建議', detail: `多單留倉，三線多頭排列但動能尚未全面加速，<strong>等待 EMA5/EMA20 同步向上</strong>確認` },
      { label: '加碼條件', detail: `EMA5 斜率轉正且站穩 EMA20 上方 → 可小量加碼` },
      { label: '停損設置', detail: `收盤跌破 <span class="fs-price">${fmt(r.e20)}</span>（EMA20）→ 開始減碼` },
      { label: '注意事項', detail: `多頭排列但部分 EMA 斜率未向上，可能是整理盤，耐心等動能確認` },
    ];
  }
  if (sig === 'EMA 黃金交叉') {
    return [
      { label: '進場建議', detail: `EMA5 上穿 EMA20，可試單 30~50%，<strong>搭配成交量放大更可靠</strong>` },
      { label: '加碼條件', detail: `收盤站上 EMA20 後持續走高，形成完整多頭排列 → 加碼至滿倉` },
      { label: '停損設置', detail: `EMA5 再度死亡交叉 EMA20 → 出場` },
      { label: '注意事項', detail: `EMA60 方向${r.slope60 > 0 ? '（↑ 向上）同向，訊號更可靠' : '（↓ 向下），長線逆勢，保守操作'}` },
    ];
  }
  if (sig === '空頭排列') {
    return [
      { label: '操作建議', detail: `<strong>避免追多</strong>，三線空頭排列是明確的空頭格局` },
      { label: '反彈壓力', detail: `反彈到 <span class="fs-price">${fmt(r.e5)}</span>（EMA5）附近常受壓，可逢高減碼` },
      { label: '轉多條件', detail: `EMA5 黃金交叉 EMA20 + 收盤站上 EMA20 → 才考慮買進` },
      { label: '注意事項', detail: `EMA20 乖離率 ${r.bias20?.toFixed(1)}%${r.bias20 < -8 ? '，負乖離過大，短線可能反彈，但趨勢仍空' : '，尚未過度超跌'}` },
    ];
  }
  if (sig === '超跌反彈') {
    return [
      { label: '進場建議', detail: `負乖離過大 + EMA5 開始向上，<strong>短線反彈機率高</strong>，可輕倉試單` },
      { label: '加碼條件', detail: `EMA5 黃金交叉 EMA20 → 加碼確認` },
      { label: '停損設置', detail: `收盤再度創新低（乖離繼續擴大）→ 出場，反彈失敗` },
      { label: '注意事項', detail: `超跌反彈不等於趨勢反轉，目標設在 <span class="fs-price">${fmt(r.e20)}</span>（EMA20）附近` },
    ];
  }
  // 站上均線群 / 多空交錯
  return [
    { label: '操作建議', detail: `觀望，等待 <strong>三線完整多頭排列</strong>（收盤 > EMA5 > EMA20 > EMA60）再進場` },
    { label: '關鍵觀察', detail: `EMA5 能否持續站在 EMA20 之上，且 EMA20 斜率是否轉正` },
    { label: '停損設置', detail: `若已持多，跌破 <span class="fs-price">${fmt(r.e20)}</span>（EMA20）→ 停損` },
    { label: '注意事項', detail: `多空交錯期不要重押單邊，等方向確認` },
  ];
}

registerAnalysisModule(EMAModule);
