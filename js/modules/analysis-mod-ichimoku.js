/* js/modules/analysis-mod-ichimoku.js
 * 🌟 ICHIMOKU Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcIchimoku } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const IchimokuModule = {
  id: 'ichimoku',
  name: 'Ichimoku 一目均衡表',
  icon: '☁️',
  candleMinLen: 52,

  evaluate(candles) {
    const n = candles.length;
    const ichi = calcIchimoku(candles);
    if (!ichi._meta.ready) {
      return { score: 0, signal: null, items: [], raw: null };
    }

    const last     = candles[n - 1];
    const close    = last.close;
    const tenkan   = ichi.tenkan[n - 1];
    const kijun    = ichi.kijun[n - 1];
    const lastTime = last.time;
    const a = ichi.senkouA.find(p => p.time === lastTime)?.value ?? null;
    const b = ichi.senkouB.find(p => p.time === lastTime)?.value ?? null;
    const cloudTop = (a != null && b != null) ? Math.max(a, b) : null;
    const cloudBot = (a != null && b != null) ? Math.min(a, b) : null;
    const cloudThick = (cloudTop != null && cloudBot != null) ? cloudTop - cloudBot : null;

    // 未來雲帶（取最遠的 26 日後）
    const futA = ichi.senkouA[ichi.senkouA.length - 1]?.value ?? null;
    const futB = ichi.senkouB[ichi.senkouB.length - 1]?.value ?? null;

    // Chikou：今日收盤 vs 26 日前收盤
    const chikouRef = n > 26 ? candles[n - 27].close : null;

    const items = [];

    // ── 條件 1：K 線位置（含 lineRef='cloud'）──
    if (cloudTop != null && cloudBot != null) {
      if (close > cloudTop) {
        items.push({
          ok: true,
          lineRef: 'cloud',
          text: `<strong>K 線位置</strong>：站上雲帶（多頭區）`,
          sub: `收盤 ${close.toFixed(2)} > 雲帶上緣 ${cloudTop.toFixed(2)}（距離 +${((close-cloudTop)/cloudTop*100).toFixed(2)}%）`,
          whyTitle: '為什麼這算多頭區？',
          why: '一目均衡表的雲帶是「動態支撐/壓力」。K 線在雲帶上方時，雲帶就轉為下方的支撐區；只要不跌破雲帶上緣，趨勢視為多頭。日本機構交易員常以此判定中長期方向。',
        });
      } else if (close < cloudBot) {
        items.push({
          ok: false,
          lineRef: 'cloud',
          text: `<strong>K 線位置</strong>：跌破雲帶（空頭區）`,
          sub: `收盤 ${close.toFixed(2)} < 雲帶下緣 ${cloudBot.toFixed(2)}（距離 ${((close-cloudBot)/cloudBot*100).toFixed(2)}%）`,
          whyTitle: '為什麼這算空頭區？',
          why: 'K 線跌破雲帶後，雲帶轉為上方的壓力區。除非帶量重新站回雲帶上方，否則視為空頭趨勢延續。',
        });
      } else {
        items.push({
          ok: null,
          lineRef: 'cloud',
          text: `<strong>K 線位置</strong>：位於雲帶中（整理區）`,
          sub: `${cloudBot.toFixed(2)} ~ ${cloudTop.toFixed(2)}（收盤 ${close.toFixed(2)}）`,
          whyTitle: '為什麼這算整理區？',
          why: '雲帶內部是多空力道僵持的區域，這時候不適合追多也不適合追空，等待方向明確（突破上緣或跌破下緣）再動作。',
        });
      }
    }

    // ── 條件 2：轉換線 vs 基準線（lineRef='tenkan'）──
    if (tenkan != null && kijun != null) {
      const diff = ((tenkan - kijun) / kijun * 100);
      items.push({
        ok: tenkan > kijun,
        lineRef: 'tenkan',
        text: `<strong>趨勢結構</strong>：轉換線 ${tenkan > kijun ? '> 基準線（短期動能優於中期）' : '≤ 基準線（短期動能偏弱）'}`,
        sub: `轉換線(藍) ${tenkan.toFixed(2)} vs 基準線(紅) ${kijun.toFixed(2)}（差距 ${diff > 0 ? '+' : ''}${diff.toFixed(2)}%）`,
        whyTitle: '為什麼轉換線 > 基準線是好事？',
        why: '轉換線=9日中點、基準線=26日中點，前者比後者敏感。轉換線上穿基準線稱為「TK 黃金交叉」，代表短期動能反轉向上，類似 KD 黃金交叉但更穩定（一目均衡表用「中位數」而非加權平均，較不受異常 K 干擾）。',
      });
    }

    // ── 條件 3：未來雲帶顏色（lineRef='futCloud'）──
    if (futA != null && futB != null) {
      items.push({
        ok: futA > futB,
        lineRef: 'futCloud',
        text: `<strong>未來雲帶</strong>：${futA > futB ? '橘色為主（多頭雲）' : '紫色為主（空頭雲）'}`,
        sub: `未來 26 日 先行帶A ${futA.toFixed(2)} ${futA > futB ? '>' : '<'} 先行帶B ${futB.toFixed(2)}`,
        whyTitle: '為什麼雲帶顏色重要？',
        why: '先行帶 A（橘）反映短中期動能合成，先行帶 B（紫）反映 52 日大區間中位數。A > B 時雲帶往未來「向上延伸」，代表多空主力對未來 26 日的共識偏多。雲帶轉色（橘變紫或反之）常是中期反轉的領先訊號。',
      });
    }

    // ── 條件 4：延遲線 Chikou（lineRef='chikou'）──
    if (chikouRef != null) {
      const chDiff = ((close - chikouRef) / chikouRef * 100);
      items.push({
        ok: close > chikouRef,
        lineRef: 'chikou',
        text: `<strong>延遲線確認</strong>：${close > chikouRef ? '今日收盤 > 26 日前收盤（中期動能向上）' : '今日收盤 ≤ 26 日前收盤（中期動能轉弱）'}`,
        sub: `今 ${close.toFixed(2)} vs 26日前 ${chikouRef.toFixed(2)}（${chDiff > 0 ? '+' : ''}${chDiff.toFixed(2)}%）`,
        whyTitle: '延遲線是什麼意思？',
        why: '延遲線（Chikou）= 今天的收盤畫在 26 日前的位置。等價於「今天的價格 vs 一個多月前」。這條線突破歷史 K 線時，代表中期動能真正轉強，是日本傳統判斷的「最後確認訊號」。三役好轉的第三役就是這個。',
      });
    }

    // ── 綜合訊號判定 ──
    let signal = null;
    let score = 0;
    const c1 = items[0]?.ok === true;
    const c2 = items[1]?.ok === true;
    const c3 = items[2]?.ok === true;
    const c4 = items[3]?.ok === true;

    if (c1 && c2 && c4) {
      signal = {
        name: '三役好轉',
        icon: '☁️',
        stars: c3 ? 5 : 4,
        desc: '最強多頭訊號 — 公認的台股「全押多單」訊號之一。' + (c3 ? '未來雲帶也是多頭，可靠度極高。' : '惟未來雲帶尚未完全轉多。'),
      };
      score = c3 ? 5 : 4;
    } else if (c1 && c3) {
      signal = { name: '雲帶上行', icon: '🌥️', stars: 3, desc: '收盤站上雲帶，未來雲帶為多頭，趨勢進入多頭區。' };
      score = 3;
    } else if (c1 || c2) {
      signal = { name: '部分多頭', icon: '⚡', stars: 2, desc: '部分多頭條件達成，但未形成完整三役好轉，可關注但不宜重押。' };
      score = 2;
    } else if (items[0]?.ok === false && items[1]?.ok === false) {
      signal = { name: '空頭格局', icon: '🌧️', stars: 1, desc: '跌破雲帶 + 轉換線下穿基準線，空頭明確，避免追多。' };
      score = 1;
    } else {
      signal = { name: '盤整觀望', icon: '🌫️', stars: 1, desc: '多空條件交錯，目前無明確方向，建議等待訊號明朗。' };
      score = 1;
    }

    return {
      score, signal, items,
      raw: { tenkan, kijun, close, cloudTop, cloudBot, cloudThick, futA, futB, chikouRef },
    };
  },

  // v3: 圖例卡內容（極簡，只列顏色 + 當前值）
  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = (v) => v == null ? '—' : v.toFixed(2);
    return [
      { id: 'tenkan',   name: '🔵 轉換線',  value: fmt(ev.raw.tenkan), color: '#3b82f6',
        tooltip: '9 日最高+最低中位數，短期動能。點此跳到詳細說明' },
      { id: 'kijun',    name: '🔴 基準線',  value: fmt(ev.raw.kijun),  color: '#ef4444',
        tooltip: '26 日最高+最低中位數，中期支撐/壓力' },
      { id: 'chikou',   name: '🟢 延遲線',  value: fmt(ev.raw.close),  color: '#10b981',
        tooltip: '今日收盤畫在 26 日前的位置' },
      { id: 'cloud',    name: '🟠 先行帶 A', value: fmt(ev.raw.futA),  color: '#fb923c', area: true,
        tooltip: '雲帶前緣 — (轉換+基準)/2，前移 26 日' },
      { id: 'futCloud', name: '🟣 先行帶 B', value: fmt(ev.raw.futB),  color: '#a855f7', area: true,
        tooltip: '雲帶後緣 — 52 日最高+最低/2，前移 26 日' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">☁️ Ichimoku</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">☁️</span>
        <span class="fs-title">Ichimoku 一目均衡表</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 52 根日 K 才能完整計算雲帶）</p>
      </div>`;
    }

    const stars = '⭐'.repeat(ev.signal.stars);
    const r = ev.raw;
    const fmt = (v) => v == null ? '—' : v.toFixed(2);
    const code = AppState.activeCode || '';

    const actionGuideHTML = _ichiActionGuide(ev);
    const keyLevelsHTML   = _ichiKeyLevels(ev);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">☁️</span>
        <span class="fs-title">Ichimoku 一目均衡表</span>
        <span class="fs-subtitle">日本經典長線指標 · 5 條線 + 雲帶綜合判斷</span>
      </div>
      <div class="fs-deep-module-body">

        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}<span style="margin-left:auto;font-size:11px;color:var(--muted);font-weight:400">點任一條 → K 線閃爍提示</span></div>
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

        ${keyLevelsHTML}
        ${actionGuideHTML}

        <div class="fs-teach" style="margin-top:22px">

          <div class="fs-teach-section">
            <h4>━━━ 🎨 五條線詳細說明 ━━━</h4>
            <div class="fs-line-row">
              <span class="fs-line-swatch" style="background:#3b82f6"></span>
              <div>
                <span class="fs-line-name">🔵 轉換線（Tenkan-sen）— 短期動能 <strong style="color:#fbbf24">${fmt(r.tenkan)}</strong></span>
                <div class="fs-line-desc">公式：(9 日最高 + 9 日最低) / 2。類似加強版的 9 日均線，反映最近 9 日的中位數價格。</div>
              </div>
            </div>
            <div class="fs-line-row">
              <span class="fs-line-swatch" style="background:#ef4444"></span>
              <div>
                <span class="fs-line-name">🔴 基準線（Kijun-sen）— 中期支撐 / 壓力 <strong style="color:#fbbf24">${fmt(r.kijun)}</strong></span>
                <div class="fs-line-desc">公式：(26 日最高 + 26 日最低) / 2。是一目均衡表的「主軸線」，回測這條線常見支撐反彈。</div>
              </div>
            </div>
            <div class="fs-line-row">
              <span class="fs-line-swatch" style="background:#10b981"></span>
              <div>
                <span class="fs-line-name">🟢 延遲線（Chikou Span）— 歷史對照</span>
                <div class="fs-line-desc">今日收盤價畫在 26 日前的位置。等於問：「今天的價，比一個多月前漲還是跌？」突破當時 K 線 = 中期動能轉強。</div>
              </div>
            </div>
            <div class="fs-line-row">
              <span class="fs-line-swatch is-area" style="background:#fb923c"></span>
              <div>
                <span class="fs-line-name">🟠 先行帶 A（Senkou Span A）— 雲帶前緣 <strong style="color:#fbbf24">${fmt(r.futA)}</strong></span>
                <div class="fs-line-desc">公式：(轉換線 + 基準線) / 2，前移 26 日畫到未來。短中期動能合成，反應較快。</div>
              </div>
            </div>
            <div class="fs-line-row">
              <span class="fs-line-swatch is-area" style="background:#a855f7"></span>
              <div>
                <span class="fs-line-name">🟣 先行帶 B（Senkou Span B）— 雲帶後緣 <strong style="color:#fbbf24">${fmt(r.futB)}</strong></span>
                <div class="fs-line-desc">公式：(52 日最高 + 52 日最低) / 2，前移 26 日畫到未來。大區間中位數，反應較慢、較穩定。</div>
              </div>
            </div>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ☁️ 雲帶（Kumo）— 一目均衡表的靈魂 ━━━</h4>
            <p>雲帶是橘色與紫色兩條 Area 互相疊加形成。<strong>它是這個指標的核心</strong>，所有判斷都圍繞著「K 線 vs 雲帶」的相對位置。</p>
            <p>目前雲帶厚度：<strong>${fmt(r.cloudThick)}</strong>${r.cloudTop && r.cloudThick ? '（占當前價約 ' + (r.cloudThick / r.close * 100).toFixed(2) + '%）' : ''}。${r.cloudThick && r.cloudThick / r.close > 0.05 ? '雲帶較厚 → 支撐 / 壓力堅實，難以穿越' : '雲帶較薄 → 方向容易翻轉，留意突破'}。</p>
            <ul>
              <li><strong>K 線在雲帶上方 ✅</strong>：多頭區，雲帶轉為動態支撐</li>
              <li><strong>K 線在雲帶下方 ❌</strong>：空頭區，雲帶轉為動態壓力</li>
              <li><strong>K 線位於雲帶內 ⏸</strong>：整理區，多空僵持，等待方向</li>
              <li><strong>雲帶橘色為主（A 大於 B）</strong>：多頭雲，未來偏多</li>
              <li><strong>雲帶紫色為主（A 小於 B）</strong>：空頭雲，未來偏空</li>
              <li><strong>雲帶轉色</strong>：中期反轉的領先訊號</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🎯 三大訊號（系統會自動偵測） ━━━</h4>
            <p><strong>☁️ 三役好轉（⭐⭐⭐⭐⭐ 最強多頭）</strong></p>
            <ul>
              <li>條件 1：轉換線 大於 基準線</li>
              <li>條件 2：收盤 大於 雲帶上緣</li>
              <li>條件 3：延遲線 大於 26 日前收盤</li>
              <li>三個條件同時達成才算數，是公認的台股「全押多單」訊號</li>
            </ul>
            <p><strong>🌥️ 雲帶上行（⭐⭐⭐ 趨勢多頭）</strong></p>
            <ul>
              <li>收盤站上雲帶上緣 + 未來雲帶為多頭雲</li>
              <li>趨勢明確進入多頭區，可分批進場</li>
            </ul>
            <p><strong>⚡ TK 黃金交叉（⭐⭐ 啟動訊號）</strong></p>
            <ul>
              <li>轉換線由下穿越基準線（近 3 日內）</li>
              <li>類似 KD 黃金交叉但更穩定，是短期動能反轉訊號</li>
            </ul>
          </div>

        </div>

        <div class="fs-application">
          <h4>💡 實戰應用 — 你該怎麼用</h4>
          <p><strong>長線投資人：</strong>等待「☁️ 三役好轉」出現再進場，是日本機構交易員過去半世紀證明過的高勝率訊號。回測雲帶上緣不破時可加碼。</p>
          <p><strong>波段操作：</strong>K 線跌破雲帶上緣 = 第一停損；跌破基準線（紅線）= 第二停損；雲帶轉色 = 重新評估方向。</p>
          <p><strong>看不懂時的捷徑：</strong>只需要看一件事 —「K 線在雲帶上面還是下面」。上面 = 可看買進，下面 = 別追多。其他細節讓系統自動判斷三大訊號就好。</p>
          <p><strong>什麼時候會失準：</strong>大事件（財報、政策、地緣政治）導致跳空時，一目均衡表的延遲性會放大判斷誤差。這種時候 5 條線會像義大利麵糾纏，等待 5~10 個交易日重新收斂後再看。</p>
        </div>

        ${renderAISection('ichimoku', 'Ichimoku 一目均衡表', '☁️', ev, (() => {
          const fmt = v => v?.toFixed(2) ?? '—';
          const pct = (a, b) => (a != null && b != null && b !== 0)
            ? ` (${((a - b) / b * 100).toFixed(2)}%)` : '';
          const cloudTrend = (r.futA != null && r.cloudTop != null)
            ? (r.futA > r.cloudTop
                ? `↑ 上升（未來${fmt(r.futA)} > 當前${fmt(r.cloudTop)}，雲帶墊高中）`
                : r.futA < r.cloudTop
                ? `↓ 下降（未來${fmt(r.futA)} < 當前${fmt(r.cloudTop)}，雲帶下壓中）`
                : '→ 持平')
            : '—';
          return {
            '轉換線Tenkan【短期動能，9日中位數】': fmt(r.tenkan),
            '基準線Kijun【中期支撐壓力，26日中位數】': fmt(r.kijun),
            '轉換線-基準線差距【正=短期動能優於中期】':
              (r.tenkan != null && r.kijun != null)
                ? `${(r.tenkan - r.kijun).toFixed(2)}元${pct(r.tenkan, r.kijun)}`
                : '—',
            '當前雲帶上緣【現在K棒時間點的先行帶高點】': fmt(r.cloudTop),
            '當前雲帶下緣【現在K棒時間點的先行帶低點】': fmt(r.cloudBot),
            '當前雲帶厚度': fmt(r.cloudThick),
            '未來先行帶A【26日後預覽，=(轉換+基準)/2前移】': fmt(r.futA),
            '未來先行帶B【26日後預覽，=52日中位數前移】': fmt(r.futB),
            '雲帶趨勢方向【未來雲帶是否在墊高】': cloudTrend,
            '現價距當前雲帶上緣乖離':
              (r.close != null && r.cloudTop != null)
                ? `+${((r.close - r.cloudTop) / r.cloudTop * 100).toFixed(2)}%`
                : '—',
            '延遲線基準(26日前收盤)': fmt(r.chikouRef),
            '現價相對26日前漲幅':
              (r.close != null && r.chikouRef != null)
                ? pct(r.close, r.chikouRef)
                : '—',
          };
        })())}

      </div>
    `;
  },
};

// ═══════════════════════════════════════════════════════
// v3 helper：Ichimoku 的「關鍵價位」表
// ═══════════════════════════════════════════════════════
function _ichiKeyLevels(ev) {
  const r = ev.raw;
  if (!r) return '';
  const close = r.close;

  const rows = [];
  if (r.cloudTop != null) {
    const above = close > r.cloudTop;
    rows.push({
      type: above ? 'support' : 'resist',
      tag: above ? '第一支撐' : '第一壓力',
      price: r.cloudTop,
      desc: above ? '雲帶上緣 — 跌破將進入雲帶整理區' : '雲帶上緣 — 突破將進入多頭區',
    });
  }
  if (r.cloudBot != null) {
    const above = close > r.cloudBot;
    rows.push({
      type: above ? 'support' : 'resist',
      tag: above ? (close > r.cloudTop ? '第二支撐' : '雲帶下緣') : '雲帶下緣',
      price: r.cloudBot,
      desc: above ? '雲帶下緣 — 跌破將進入空頭區' : '反彈第一壓力',
    });
  }
  if (r.kijun != null) {
    rows.push({
      type: 'pivot',
      tag: '中軸線',
      price: r.kijun,
      desc: '基準線 — 一目均衡表的主軸，常見支撐 / 壓力',
    });
  }
  if (r.tenkan != null) {
    rows.push({
      type: 'pivot',
      tag: '動能線',
      price: r.tenkan,
      desc: '轉換線 — 短期動能，反映近 9 日中位數',
    });
  }

  rows.sort((a, b) => b.price - a.price);

  return `
    <div class="fs-keylevels">
      <h4>📍 關鍵價位（依價位由高到低）</h4>
      ${rows.map(row => `
        <div class="fs-keylevel-row">
          <span class="fs-keylevel-tag is-${row.type}">${row.tag}</span>
          <span class="fs-keylevel-price">${row.price.toFixed(2)}</span>
          <span class="fs-keylevel-desc">${row.desc}</span>
        </div>
      `).join('')}
      <div class="fs-keylevel-row" style="border-top:1px solid rgba(255,255,255,0.1);padding-top:10px;margin-top:4px">
        <span class="fs-keylevel-tag" style="background:rgba(59,130,246,0.18);color:#93c5fd">現價</span>
        <span class="fs-keylevel-price" style="color:#93c5fd">${close.toFixed(2)}</span>
        <span class="fs-keylevel-desc">當前收盤價</span>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════
// v3 helper：Ichimoku 的「行動指引」
// 根據訊號強度 + K 線位置生成「該怎麼操作」具體建議
// ═══════════════════════════════════════════════════════
function _ichiActionGuide(ev) {
  const r = ev.raw;
  if (!r) return '';
  const signal = ev.signal;

  let rows = [];

  if (signal.name === '三役好轉') {
    rows = [
      { label: '短線操作', detail: `續抱，跌破 <span class="fs-price">${r.tenkan?.toFixed(2)}</span>（轉換線）時減碼一半` },
      { label: '中長線',   detail: `<strong>可進場</strong>。建議分批：現價 30% + 回測 <span class="fs-price">${r.kijun?.toFixed(2)}</span>（基準線）40% + 跌至 <span class="fs-price">${r.cloudTop?.toFixed(2)}</span>（雲帶上緣）30%` },
      { label: '停損設置', detail: `跌破 <span class="fs-price">${r.cloudTop?.toFixed(2)}</span>（雲帶上緣）= 第一停損；跌破 <span class="fs-price">${r.cloudBot?.toFixed(2)}</span>（雲帶下緣）= 認賠出場` },
      { label: '該注意什麼', detail: signal.stars === 5
        ? `<strong>訊號可靠度極高</strong>，但仍建議分批建倉；若 RSI 已超買（大於 80）可等回檔再進`
        : `未來雲帶尚未完全轉多，獲利目標保守設在前波高點；若雲帶轉成空頭雲就降低部位` },
    ];
  } else if (signal.name === '雲帶上行') {
    rows = [
      { label: '短線操作', detail: `多單留倉，留意 <span class="fs-price">${r.tenkan?.toFixed(2)}</span>（轉換線）支撐` },
      { label: '中長線',   detail: `<strong>可關注</strong>。等延遲線突破歷史 K 線（升級為三役好轉）再加碼，目前可先試單 30% 部位` },
      { label: '停損設置', detail: `跌破 <span class="fs-price">${r.cloudTop?.toFixed(2)}</span>（雲帶上緣）= 退出觀望` },
      { label: '該注意什麼', detail: `三役好轉的「延遲線確認」尚未完成 — 等今日收盤連續站上 26 日前的高點，可靠度才會升級` },
    ];
  } else if (signal.name === '部分多頭') {
    rows = [
      { label: '短線操作', detail: `謹慎觀望，不宜重押。若已持有可繼續抱，未持有不必急著進場` },
      { label: '中長線',   detail: `<strong>建議等待</strong>。多空條件未完全達成，等更明確訊號（雲帶上行 / 三役好轉）再評估` },
      { label: '可能進場價', detail: `若回測 <span class="fs-price">${r.cloudTop?.toFixed(2)}</span>（雲帶上緣）止跌反彈 + TK 黃金交叉，可視為小量試單訊號` },
      { label: '該注意什麼', detail: `目前是「過渡狀態」，可能往多 / 空任一方發展，看接下來 5~10 個交易日是否站穩雲帶上緣` },
    ];
  } else if (signal.name === '空頭格局') {
    rows = [
      { label: '短線操作', detail: `<strong>避免追多</strong>，多單盡早出場。反彈到 <span class="fs-price">${r.cloudBot?.toFixed(2)}</span>（雲帶下緣）可能受壓` },
      { label: '中長線',   detail: `<strong>停看聽</strong>。等待跌深反彈訊號（K 線重新站上雲帶 + TK 黃金交叉）再評估` },
      { label: '可能反彈價', detail: `第一壓力 <span class="fs-price">${r.cloudBot?.toFixed(2)}</span>（雲帶下緣），第二壓力 <span class="fs-price">${r.cloudTop?.toFixed(2)}</span>（雲帶上緣）` },
      { label: '該注意什麼', detail: `空頭趨勢可能持續一段時間，不要逆勢攤平。等雲帶轉色（紫變橘）作為轉折領先訊號` },
    ];
  } else {
    rows = [
      { label: '短線操作', detail: `<strong>等待方向明確</strong>。可短線高出低進，但不宜重押` },
      { label: '突破上緣 ↑', detail: `若收盤站上 <span class="fs-price">${r.cloudTop?.toFixed(2)}</span> + 帶量 → 進入多頭區，可看買進` },
      { label: '跌破下緣 ↓', detail: `若收盤跌破 <span class="fs-price">${r.cloudBot?.toFixed(2)}</span> + 帶量 → 進入空頭區，避免追多` },
      { label: '該注意什麼', detail: `盤整時間越久，突破時動能越大。耐心等 5~10 個交易日方向明朗化` },
    ];
  }

  return `
    <div class="fs-action-guide">
      <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${signal.icon} ${signal.name} 訊號</div>
      <div class="fs-action-guide-body">
        ${rows.map(row => `
          <div class="fs-action-row">
            <span class="fs-action-label">${row.label}</span>
            <span class="fs-action-detail">${row.detail}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// 註冊內建模組
registerAnalysisModule(IchimokuModule);
