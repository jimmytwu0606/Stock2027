/* js/modules/analysis-mod-bb.js
 * 🌟 BB Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcBollinger } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ═══════════════════════════════════════════════════════
// 🌟 BBModule — Golden Board
// 布林通道：上軌/中軌/下軌 + 帶寬 + 壓縮/擴張 + 突破
// ═══════════════════════════════════════════════════════
const BBModule = {
  id: 'bb',
  name: '布林通道',
  icon: '📡',
  candleMinLen: 20,

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const bands = calcBollinger(closes, 20, 2);

    // 找最後有效值
    let lastIdx = n - 1;
    while (lastIdx > 0 && bands[lastIdx] === null) lastIdx--;

    const last     = bands[lastIdx];
    const prev     = bands[lastIdx - 1];
    const lastClose = closes[n - 1];
    const prevClose = closes[n - 2] ?? lastClose;

    const { upper, mid, lower, width } = last;
    const prevUpper = prev?.upper ?? upper;
    const prevLower = prev?.lower ?? lower;
    const prevMid   = prev?.mid   ?? mid;
    const prevWidth = prev?.width ?? width;

    // 帶寬變化（擴張/收縮）
    const widthChange = width - prevWidth;
    const widthPct    = prevWidth > 0 ? (widthChange / prevWidth * 100) : 0;

    // 近 10 根帶寬，找最低點（Squeeze 判斷）
    const recentWidths = bands.slice(Math.max(0, lastIdx - 9), lastIdx + 1)
      .filter(b => b !== null).map(b => b.width);
    const minWidth  = Math.min(...recentWidths);
    const maxWidth  = Math.max(...recentWidths);
    const isSqueeze = recentWidths.length >= 5 && width <= minWidth * 1.05; // 在近10根最窄的 5% 內

    // 位置：%B 指標（0=下軌, 0.5=中軌, 1=上軌, >1=突破上軌, <0=跌破下軌）
    const bandRange = upper - lower;
    const pctB      = bandRange > 0 ? (lastClose - lower) / bandRange : 0.5;
    const prevPctB  = bandRange > 0 ? (prevClose - (prev?.lower ?? lower)) / ((prev?.upper ?? upper) - (prev?.lower ?? lower)) : 0.5;

    // 突破偵測（近 3 根）
    let breakUpper = false, breakLower = false;
    for (let i = Math.max(1, lastIdx - 2); i <= lastIdx; i++) {
      if (!bands[i] || !bands[i-1]) continue;
      if (closes[i] > bands[i].upper && closes[i-1] <= bands[i-1].upper) breakUpper = true;
      if (closes[i] < bands[i].lower && closes[i-1] >= bands[i-1].lower) breakLower = true;
    }

    // 中軌斜率（方向）
    const midSlope = mid - prevMid;

    const items = [];

    // ── 條件 1：收盤位置（%B）──
    if (pctB > 1) {
      items.push({
        ok: false,
        text: `<strong>突破上軌</strong>：收盤 ${lastClose.toFixed(2)} 高於上軌 ${upper.toFixed(2)}`,
        sub: `%B = ${(pctB * 100).toFixed(1)}%，短線過熱，留意回測上軌`,
        whyTitle: '為什麼突破上軌要小心？',
        why: '收盤突破布林上軌代表股價進入統計上的「超漲區」（距中軌 2 個標準差以上）。在震盪市中這通常是賣出訊號；但在強趨勢中，突破上軌後可能持續沿著上軌爬行（稱為「走軌」）。需搭配成交量判斷是突破還是過熱。',
      });
    } else if (pctB < 0) {
      items.push({
        ok: true,
        text: `<strong>跌破下軌</strong>：收盤 ${lastClose.toFixed(2)} 低於下軌 ${lower.toFixed(2)}`,
        sub: `%B = ${(pctB * 100).toFixed(1)}%，短線過跌，留意反彈機會`,
        whyTitle: '為什麼跌破下軌是反彈機會？',
        why: '收盤跌破布林下軌代表股價進入統計上的「超跌區」。歷史上跌破下軌後反彈機率相當高，但空頭趨勢中可能出現「沿著下軌滑落」的走軌現象。需搭配 KD/RSI 超賣確認。',
      });
    } else if (pctB > 0.8) {
      items.push({
        ok: null,
        text: `<strong>靠近上軌</strong>：收盤在上軌附近（%B = ${(pctB * 100).toFixed(1)}%）`,
        sub: `收盤 ${lastClose.toFixed(2)}，上軌 ${upper.toFixed(2)}，距離 ${(upper - lastClose).toFixed(2)} 元`,
        whyTitle: '%B 靠近 1.0 代表什麼？',
        why: '%B 接近 1.0（靠近上軌）代表股價相對強勢。這本身不是賣點，但在此位置若帶量突破上軌，是強勢訊號；若縮量回落，是短線壓力位。',
      });
    } else if (pctB < 0.2) {
      items.push({
        ok: null,
        text: `<strong>靠近下軌</strong>：收盤在下軌附近（%B = ${(pctB * 100).toFixed(1)}%）`,
        sub: `收盤 ${lastClose.toFixed(2)}，下軌 ${lower.toFixed(2)}，距離 ${(lastClose - lower).toFixed(2)} 元`,
        whyTitle: '%B 靠近 0.0 代表什麼？',
        why: '%B 接近 0.0（靠近下軌）代表股價相對弱勢。這本身不是買點，但在此位置若帶量反彈，是弱轉強的初期訊號；若繼續破底，要留意走軌現象。',
      });
    } else {
      items.push({
        ok: true,
        text: `<strong>位於通道中段</strong>：收盤在中軌附近（%B = ${(pctB * 100).toFixed(1)}%）`,
        sub: `收盤 ${lastClose.toFixed(2)}，中軌（MA20）${mid.toFixed(2)}，差距 ${(lastClose - mid) > 0 ? '+' : ''}${(lastClose - mid).toFixed(2)} 元`,
        whyTitle: '收盤在通道中段代表什麼？',
        why: '%B 在 0.2~0.8 之間是正常波動區間，代表股價在合理範圍內。中軌（MA20）是最重要的參考點，收盤在中軌上方偏多、下方偏空。',
      });
    }

    // ── 條件 2：帶寬（擴張/收縮）──
    if (isSqueeze) {
      items.push({
        ok: null,
        text: `<strong>帶寬壓縮（Squeeze）</strong>：帶寬 ${width.toFixed(2)}% 處於近10根低點`,
        sub: `近10根帶寬範圍 ${minWidth.toFixed(2)}% ~ ${maxWidth.toFixed(2)}%，目前接近最窄`,
        whyTitle: '為什麼 Squeeze 是重要訊號？',
        why: '布林通道壓縮（帶寬極窄）代表市場進入低波動整理期，多空力道均衡。歷史上，Squeeze 結束後往往出現一波明確的方向性行情（大漲或大跌）。Squeeze 本身不告訴你方向，但它是「蓄力即將爆發」的前兆。',
      });
    } else if (widthPct > 10) {
      items.push({
        ok: null,
        text: `<strong>帶寬快速擴張</strong>：帶寬 ${width.toFixed(2)}%（較前根擴大 ${widthPct.toFixed(1)}%）`,
        sub: `前根帶寬 ${prevWidth.toFixed(2)}%，帶寬擴張代表波動率正在放大`,
        whyTitle: '帶寬擴張代表什麼？',
        why: '帶寬快速擴張代表市場波動率增加，通常伴隨趨勢行情的起點。若配合收盤突破上軌，是多頭爆發訊號；配合跌破下軌，是空頭加速訊號。帶寬擴張後通常要等帶寬再次收縮才能判斷下一次爆發方向。',
      });
    } else if (widthPct < -10) {
      items.push({
        ok: null,
        text: `<strong>帶寬快速收縮</strong>：帶寬 ${width.toFixed(2)}%（較前根縮小 ${Math.abs(widthPct).toFixed(1)}%）`,
        sub: `前根帶寬 ${prevWidth.toFixed(2)}%，波動率正在降低，蓄力整理中`,
        whyTitle: '帶寬收縮代表什麼？',
        why: '帶寬快速收縮代表波動率下降，市場進入整理。收縮的過程是多空力道互相耗損的過程，越縮越緊，突破時的動能越大。',
      });
    } else {
      items.push({
        ok: null,
        text: `<strong>帶寬穩定</strong>：帶寬 ${width.toFixed(2)}%（變化 ${widthPct > 0 ? '+' : ''}${widthPct.toFixed(1)}%）`,
        sub: `近10根帶寬範圍 ${minWidth.toFixed(2)}% ~ ${maxWidth.toFixed(2)}%，目前在中段`,
        whyTitle: '帶寬穩定代表什麼？',
        why: '帶寬在穩定的範圍內波動，代表市場波動率正常，無明顯的壓縮或擴張趨勢。這種狀態下以 %B 位置和中軌方向作為主要判斷依據。',
      });
    }

    // ── 條件 3：中軌方向（趨勢方向）──
    items.push({
      ok: midSlope > 0,
      text: midSlope > 0
        ? `<strong>中軌向上</strong>：MA20 斜率 +${midSlope.toFixed(2)}（多頭趨勢方向）`
        : midSlope < 0
        ? `<strong>中軌向下</strong>：MA20 斜率 ${midSlope.toFixed(2)}（空頭趨勢方向）`
        : `<strong>中軌持平</strong>：MA20 幾乎水平`,
      sub: `中軌（MA20）本根 ${mid.toFixed(2)} vs 前根 ${prevMid.toFixed(2)}`,
      whyTitle: '為什麼中軌方向是關鍵？',
      why: '布林通道的中軌就是 MA20（20日移動平均線），它的方向決定了中期趨勢方向。中軌向上 = 多頭趨勢，上軌是動態壓力、下軌是動態支撐；中軌向下 = 空頭趨勢，上下軌的意義對調。只看收盤位置不看中軌方向，會誤判訊號。',
    });

    // ── 條件 4：近期突破（近3根）──
    if (breakUpper) {
      items.push({
        ok: true,
        text: `<strong>近期突破上軌</strong>：近 3 根出現收盤站上上軌`,
        sub: `上軌 ${upper.toFixed(2)}，突破後留意是否能站穩`,
        whyTitle: '突破上軌是多頭還是超買？',
        why: '突破上軌有兩種解讀：1. 強勢突破（帶量、中軌向上）= 多頭爆發，沿軌走高；2. 過熱觸軌（縮量、中軌水平）= 短線超漲，均值回歸壓力。判斷關鍵是成交量和中軌方向。',
      });
    } else if (breakLower) {
      items.push({
        ok: false,
        text: `<strong>近期跌破下軌</strong>：近 3 根出現收盤跌破下軌`,
        sub: `下軌 ${lower.toFixed(2)}，跌破後留意是否出現止跌訊號`,
        whyTitle: '跌破下軌是反彈機會還是空頭加速？',
        why: '跌破下軌也有兩種解讀：1. 反彈機會（帶量止跌、KD/RSI 超賣）= 超跌反彈；2. 空頭走軌（中軌持續向下）= 空頭加速，不要接刀。判斷關鍵是中軌方向和止跌 K 線型態。',
      });
    }

    // ── 條件 5：%B 趨勢（動能方向）──
    const pctBChange = pctB - prevPctB;
    items.push({
      ok: pctBChange > 0,
      text: `<strong>%B 動能</strong>：${pctBChange > 0 ? '↑ 向上軌移動' : pctBChange < 0 ? '↓ 向下軌移動' : '→ 持平'}`,
      sub: `%B 本根 ${(pctB * 100).toFixed(1)}% vs 前根 ${(prevPctB * 100).toFixed(1)}%（變化 ${pctBChange > 0 ? '+' : ''}${(pctBChange * 100).toFixed(1)}%）`,
      whyTitle: '為什麼看 %B 的動能方向？',
      why: '%B 的變化方向反映收盤在通道內的移動趨勢。%B 持續向上（往上軌移動）代表多頭動能；%B 持續向下（往下軌移動）代表空頭動能。這比單看 %B 絕對位置更早反映動能轉換。',
    });

    // ── 綜合訊號 ──
    let signal, score;
    const bullTrend = midSlope > 0;

    if (isSqueeze) {
      signal = { name: '帶寬壓縮蓄力', icon: '🔮', stars: 3,
        desc: '布林通道 Squeeze，波動率極低，即將出現方向性突破，方向待確認。' };
      score = 3;
    } else if (breakUpper && bullTrend) {
      signal = { name: '強勢突破上軌', icon: '📡', stars: 5,
        desc: '中軌向上 + 收盤突破上軌，多頭爆發訊號，強勢走軌可能持續。' };
      score = 5;
    } else if (breakLower && !bullTrend) {
      signal = { name: '空頭跌破下軌', icon: '📉', stars: 1,
        desc: '中軌向下 + 收盤跌破下軌，空頭加速訊號，避免逆勢接刀。' };
      score = 1;
    } else if (breakUpper && !bullTrend) {
      signal = { name: '觸軌超買警示', icon: '⚠️', stars: 2,
        desc: '收盤突破上軌但中軌水平/向下，過熱反轉風險，均值回歸壓力大。' };
      score = 2;
    } else if (breakLower && bullTrend) {
      signal = { name: '超跌反彈機會', icon: '⚡', stars: 4,
        desc: '收盤跌破下軌但中軌向上，多頭趨勢中的超跌，反彈機率高。' };
      score = 4;
    } else if (pctB > 0.8 && bullTrend) {
      signal = { name: '多頭強勢區', icon: '🔵', stars: 4,
        desc: '靠近上軌 + 中軌向上，多頭趨勢健康，%B 維持高位。' };
      score = 4;
    } else if (pctB < 0.2 && !bullTrend) {
      signal = { name: '空頭弱勢區', icon: '🔴', stars: 2,
        desc: '靠近下軌 + 中軌向下，空頭趨勢持續，避免追多。' };
      score = 2;
    } else if (bullTrend && pctB > 0.5) {
      signal = { name: '多頭中段', icon: '🟢', stars: 3,
        desc: '中軌向上 + 收盤在中軌上方，多頭趨勢正常延伸。' };
      score = 3;
    } else if (!bullTrend && pctB < 0.5) {
      signal = { name: '空頭中段', icon: '⚪', stars: 2,
        desc: '中軌向下 + 收盤在中軌下方，空頭趨勢延伸中，觀望為主。' };
      score = 2;
    } else {
      signal = { name: '中性整理', icon: '⏸', stars: 2,
        desc: '收盤在通道中段，帶寬正常，無明確方向訊號，以中軌方向為主。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { upper, mid, lower, width, prevWidth, widthChange, widthPct,
             pctB, prevPctB, pctBChange, midSlope, isSqueeze, breakUpper, breakLower,
             minWidth, maxWidth, lastClose, bandRange, bands, closes, n, lastIdx },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = v => v?.toFixed(2) ?? '—';
    return [
      { id: 'bb-upper', name: '🔴 上軌', value: fmt(ev.raw.upper), color: '#ef5350',
        tooltip: 'MA20 + 2σ，統計上的超漲區域' },
      { id: 'bb-mid',   name: '⚪ 中軌', value: fmt(ev.raw.mid),   color: '#8a8f99',
        tooltip: 'MA20，布林通道的趨勢基準線' },
      { id: 'bb-lower', name: '🟢 下軌', value: fmt(ev.raw.lower), color: '#26a69a',
        tooltip: 'MA20 - 2σ，統計上的超跌區域' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📡 BB</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">📡</span>
        <span class="fs-title">布林通道</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 20 根 K 線才能計算布林通道）</p>
      </div>`;
    }

    const r    = ev.raw;
    const fmt  = v => v?.toFixed(2) ?? '—';
    const fmtP = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';

    // %B 視覺 bar
    const pctBClamped = Math.max(0, Math.min(1, r.pctB));
    const pctBColor = r.pctB > 0.8 ? '#ef5350' : r.pctB < 0.2 ? '#26a69a' : '#93c5fd';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📡</span>
        <span class="fs-title">布林通道</span>
        <span class="fs-subtitle">Bollinger Bands · MA20 ± 2σ 綜合判讀</span>
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
          <h4>📍 布林通道當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">上軌</span>
            <span class="fs-keylevel-price">${fmt(r.upper)}</span>
            <span class="fs-keylevel-desc">MA20 + 2σ　${r.lastClose > r.upper ? '⚠️ 收盤已突破' : `距現價 +${(r.upper - r.lastClose).toFixed(2)}`}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(138,143,153,0.18);color:#d1d5db">中軌</span>
            <span class="fs-keylevel-price">${fmt(r.mid)}</span>
            <span class="fs-keylevel-desc">MA20　斜率 ${fmtP(r.midSlope)}　${r.midSlope > 0 ? '↑ 向上（多頭）' : r.midSlope < 0 ? '↓ 向下（空頭）' : '→ 水平'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(38,166,154,0.18);color:#6ee7b7">下軌</span>
            <span class="fs-keylevel-price">${fmt(r.lower)}</span>
            <span class="fs-keylevel-desc">MA20 - 2σ　${r.lastClose < r.lower ? '⚠️ 收盤已跌破' : `距現價 -${(r.lastClose - r.lower).toFixed(2)}`}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(245,158,11,0.18);color:#fbbf24">帶寬</span>
            <span class="fs-keylevel-price">${r.width.toFixed(2)}%</span>
            <span class="fs-keylevel-desc">${r.isSqueeze ? '🔮 Squeeze 壓縮中' : r.widthPct > 10 ? '📈 快速擴張' : r.widthPct < -10 ? '📉 快速收縮' : '穩定'}　近10根最窄 ${r.minWidth.toFixed(2)}% / 最寬 ${r.maxWidth.toFixed(2)}%</span>
          </div>
          <!-- %B 視覺 bar -->
          <div style="padding:8px 14px 4px;font-size:11px;color:var(--muted)">
            %B 位置　<span style="color:${pctBColor};font-weight:600">${(r.pctB * 100).toFixed(1)}%</span>
            <div style="margin-top:4px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;position:relative">
              <div style="height:100%;width:${pctBClamped * 100}%;background:${pctBColor};border-radius:3px;transition:width 0.3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;font-size:10px">
              <span>0% 下軌</span><span>50% 中軌</span><span>100% 上軌</span>
            </div>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_bbActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">

          <div class="fs-teach-section">
            <h4>━━━ 📡 布林通道原理 ━━━</h4>
            <p><strong>中軌</strong>：MA20（20日移動平均）</p>
            <p><strong>上軌</strong>：MA20 + 2 × 標準差（σ）</p>
            <p><strong>下軌</strong>：MA20 − 2 × 標準差（σ）</p>
            <p style="margin-top:8px">統計上，約 <strong>95% 的收盤價</strong>會落在上下軌之間。突破通道代表進入統計上的極端區域，是異常事件（不代表一定要反轉，但代表有異常的力道）。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 📏 %B 指標詳解 ━━━</h4>
            <p>%B = (收盤 − 下軌) / (上軌 − 下軌)</p>
            <ul>
              <li><strong>%B > 1.0</strong>：突破上軌，超強勢或超熱</li>
              <li><strong>%B 0.8~1.0</strong>：靠近上軌，強勢區</li>
              <li><strong>%B 0.5</strong>：剛好在中軌</li>
              <li><strong>%B 0.0~0.2</strong>：靠近下軌，弱勢區</li>
              <li><strong>%B < 0.0</strong>：跌破下軌，超跌或超弱</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🔮 Squeeze（帶寬壓縮）━━━</h4>
            <p>布林通道帶寬收縮到歷史低點 → 蓄力爆發前兆</p>
            <ul>
              <li>Squeeze 本身不告訴你方向，需等突破方向確認</li>
              <li>Squeeze 後若帶量突破上軌 = 多頭爆發</li>
              <li>Squeeze 後若帶量跌破下軌 = 空頭爆發</li>
              <li>Squeeze 越久（帶寬越窄越長），突破後的行情越大</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>走軌現象</strong>：強趨勢中收盤可以沿著上/下軌持續走行，不是每次觸軌都要反轉</li>
              <li><strong>中軌方向最重要</strong>：中軌向上時上軌是壓力但也是強勢表現；中軌向下時下軌是支撐但也是弱勢表現</li>
              <li><strong>帶寬擴張後要等收縮</strong>：帶寬大幅擴張後，需等再次壓縮才有新的突破方向</li>
              <li><strong>搭配使用效果最好</strong>：BB 告訴你位置和波動率，KD/RSI 告訴你動能，MACD 告訴你趨勢，三者互補</li>
            </ul>
          </div>

        </div>

        ${renderAISection('bb', '布林通道', '📡', ev, (() => {
          const fmt  = v => v?.toFixed(2) ?? '—';
          const fmtP = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

          // 近5根 %B 走勢
          const recent5pctB = (() => {
            const result = [];
            for (let i = Math.max(0, r.lastIdx - 4); i <= r.lastIdx; i++) {
              const b = r.bands[i];
              if (!b) continue;
              const br = b.upper - b.lower;
              const pB = br > 0 ? (r.bands[i] ? (r.closes[i] - b.lower) / br : 0.5) : 0.5;
              const label = i === r.lastIdx ? '【當根】' : `【-${r.lastIdx - i}根】`;
              const zone = pB > 1 ? '突破上軌' : pB > 0.8 ? '靠近上軌' : pB < 0 ? '跌破下軌' : pB < 0.2 ? '靠近下軌' : '通道中段';
              result.push(`${label}%B=${(pB * 100).toFixed(1)}%(${zone})`);
            }
            return result.join(' → ');
          })();

          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          const passCount = ev.items.filter(i => i.ok === true).length;
          const failCount = ev.items.filter(i => i.ok === false).length;

          return {
            '上軌【MA20+2σ，超漲警戒線】': fmt(r.upper),
            '中軌【MA20，趨勢基準線】': fmt(r.mid),
            '下軌【MA20-2σ，超跌支撐線】': fmt(r.lower),
            '現價': fmt(r.lastClose),
            '%B位置【0=下軌,0.5=中軌,1=上軌,>1突破上,<0跌破下】': `${(r.pctB * 100).toFixed(1)}%（${r.pctB > 1 ? '突破上軌' : r.pctB > 0.8 ? '靠近上軌' : r.pctB < 0 ? '跌破下軌' : r.pctB < 0.2 ? '靠近下軌' : '通道中段'}）`,
            '%B動能【正=往上軌移動，負=往下軌移動】': `${r.pctBChange > 0 ? '+' : ''}${(r.pctBChange * 100).toFixed(1)}%`,
            '帶寬【波動率指標，越小越壓縮】': `${r.width.toFixed(2)}%（近10根最窄${r.minWidth.toFixed(2)}%，最寬${r.maxWidth.toFixed(2)}%）`,
            '帶寬狀態': r.isSqueeze ? '🔮 Squeeze壓縮（近10根低點，即將爆發）'
              : r.widthPct > 10 ? `📈 快速擴張（較前根+${r.widthPct.toFixed(1)}%）`
              : r.widthPct < -10 ? `📉 快速收縮（較前根${r.widthPct.toFixed(1)}%）`
              : `穩定（較前根${r.widthPct > 0 ? '+' : ''}${r.widthPct.toFixed(1)}%）`,
            '中軌方向【正=向上多頭，負=向下空頭】': `${fmtP(r.midSlope)}（${r.midSlope > 0 ? '↑ 多頭趨勢' : r.midSlope < 0 ? '↓ 空頭趨勢' : '→ 水平'}）`,
            '近期突破【近3根】': r.breakUpper ? '近3根出現突破上軌' : r.breakLower ? '近3根出現跌破下軌' : '近3根無突破',
            [`各條件達成狀態【共${ev.items.length}項，✅${passCount}達標 ❌${failCount}未達標】`]: itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}

      </div>
    `;
  },
};

// ── helper：BB 行動指引列 ──
function _bbActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;
  const fmt = v => v?.toFixed(2) ?? '—';

  if (sig === '強勢突破上軌') {
    return [
      { label: '持倉建議', detail: `<strong>多單續抱</strong>，中軌向上 + 突破上軌是走軌強勢訊號，不要因碰上軌就急著賣` },
      { label: '加碼條件', detail: `帶寬持續擴張 + %B 維持在 0.8 以上 → 趨勢延伸，可小量加碼` },
      { label: '停損設置', detail: `收盤跌破中軌 <span class="fs-price">${fmt(r.mid)}</span>（MA20）→ 趨勢轉弱，開始減碼` },
      { label: '注意事項', detail: `帶寬若開始快速收縮，代表爆發力衰退，留意回調` },
    ];
  }
  if (sig === '超跌反彈機會') {
    return [
      { label: '進場建議', detail: `中軌向上 + 跌破下軌，多頭趨勢中的超跌，<strong>可試單 30~50%</strong>` },
      { label: '加碼條件', detail: `收盤反彈站回下軌 <span class="fs-price">${fmt(r.lower)}</span> 上方 + KD/RSI 同步反彈 → 加碼確認` },
      { label: '停損設置', detail: `繼續跌破且中軌轉頭向下 → 趨勢可能已轉空，出場` },
      { label: '注意事項', detail: `多頭趨勢中下軌是動態支撐，跌破下軌通常是回調而非反轉，等止跌確認再進` },
    ];
  }
  if (sig === '帶寬壓縮蓄力') {
    return [
      { label: '策略', detail: `<strong>等待方向確認</strong>，Squeeze 本身不告訴你方向，不要提前猜測` },
      { label: '多方突破條件', detail: `帶量收盤站上上軌 <span class="fs-price">${fmt(r.upper)}</span> + 中軌轉向上 → 追多` },
      { label: '空方突破條件', detail: `帶量收盤跌破下軌 <span class="fs-price">${fmt(r.lower)}</span> + 中軌轉向下 → 不追多` },
      { label: '注意事項', detail: `Squeeze 壓縮越久動能越大，突破後的行情往往比預期更猛，設好停損跟上` },
    ];
  }
  if (sig === '多頭強勢區') {
    return [
      { label: '持倉建議', detail: `多單留倉，%B 高位 + 中軌向上是多頭趨勢健康延伸` },
      { label: '加碼條件', detail: `%B 若短暫拉回到 0.5（中軌）止穩反彈 → 加碼機會` },
      { label: '停損設置', detail: `%B 跌破 0.5（收盤跌破中軌）→ 開始減碼` },
      { label: '注意事項', detail: `%B 長期維持 0.8 以上是強勢走軌，不要因「太貴了」就輕易出場` },
    ];
  }
  if (sig === '觸軌超買警示') {
    return [
      { label: '操作建議', detail: `<strong>謹慎追高</strong>，中軌水平/向下 + 碰上軌是超買反轉風險，考慮減碼` },
      { label: '觀察重點', detail: `帶寬是否開始收縮（動能衰退）、中軌是否轉向下` },
      { label: '停損設置', detail: `%B 從 1.0 快速掉回 0.5 以下 → 出場` },
      { label: '注意事項', detail: `中軌水平時布林通道是震盪通道，上下軌都是反轉點而非突破點` },
    ];
  }
  if (sig === '空頭跌破下軌') {
    return [
      { label: '操作建議', detail: `<strong>避免接刀</strong>，中軌向下 + 跌破下軌是空頭加速，空頭走軌可能延續` },
      { label: '反彈壓力', detail: `反彈到下軌 <span class="fs-price">${fmt(r.lower)}</span> 附近若受壓，是再次確認空頭` },
      { label: '轉多條件', detail: `%B 持續反彈回升超過 0.5（站上中軌）+ 中軌轉向上 → 才考慮做多` },
      { label: '注意事項', detail: `空頭走軌可能讓 %B 長期維持 0.0 以下，不要因為「太便宜了」就逆勢接刀` },
    ];
  }
  // 多頭中段 / 空頭中段 / 中性整理
  return [
    { label: '操作建議', detail: `觀望為主，等待 <strong>帶寬壓縮後突破</strong> 或 <strong>%B 觸軌</strong>再評估` },
    { label: '關鍵觀察', detail: `帶寬是否開始壓縮（Squeeze 醞釀），中軌方向是否改變` },
    { label: '停損設置', detail: `若已持多，收盤跌破中軌 <span class="fs-price">${fmt(r.mid)}</span> → 減碼` },
    { label: '注意事項', detail: `通道中段缺乏明確訊號，以 KD/MACD 的方向為主，BB 作輔助` },
  ];
}

registerAnalysisModule(BBModule);
