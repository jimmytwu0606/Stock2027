/* js/modules/analysis-mod-granville.js
 * 🎯 GRANVILLE Golden Board Module — 葛蘭碧八法即時診斷
 *
 * 設計三段(對應 0523_1441 合併 roadmap):
 *   段 1 — 狀態卡:目前觸發第幾法(讀 AppState.signals[code],不重算)
 *   段 2 — SVG 八法示意圖:畫 MA20 曲線 + 8 個標號,觸發點高亮
 *   段 3 — 訊號表:8 個訊號逐一說明 + 目前是否觸發
 *
 * 數據來源(0 API 成本):
 *   AppState.signals[activeCode] 已由 matchSignals 算好
 *   只需 filter id ∈ {S20,S21,S22,S23,W18,W15,W19,W20}
 *
 * 同步要求:strategy.js v2.6 中 S20~S23 / W15/W18/W19/W20 必須存在
 */
import { AppState } from '../state.js';
import { calcMA } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ─────────────────────────────────────────────
// 八法定義(順序對應 SVG 上的標號)
// ─────────────────────────────────────────────
const GRANVILLE_LAWS = [
  // ── 買入訊號 ──
  {
    no: '①', side: 'buy', id: 'S20', icon: '①',
    name: '買一·趨勢反轉',
    short: '突破月線',
    cond: 'MA20 由跌轉揚 + 股價向上突破 MA20',
    desc: '長期下跌後,均線首次走平/上揚,股價同時突破均線,趨勢反轉訊號。是葛蘭碧八法中**最強**的買進訊號。',
    op: '可分批進場 30%,後續回測 MA20 不破再加碼 40%。停損設在 MA20 下方 3%。',
  },
  {
    no: '②', side: 'buy', id: 'S21', icon: '②',
    name: '買二·回踩不破',
    short: '回踩反彈',
    cond: '股價在 MA20 上方,昨日觸碰或跌破 MA20,今日收回 MA20 上方',
    desc: '上升趨勢中股價回踩月線,**沒有真正跌破**,當日收回上方繼續上漲。是趨勢延續的買進訊號。',
    op: '加碼點。停損設在 MA20 下方 2%,若連續兩日無法站回則出場。',
  },
  {
    no: '③', side: 'buy', id: 'S22', icon: '③',
    name: '買三·假跌破收回',
    short: '假跌破',
    cond: '昨日跌破 MA20,今日收回 + MA20 仍向上',
    desc: '股價短暫跌破月線後**當日或次日**強力收回,均線仍維持上升。所謂「假跌破」,常為主力洗盤後的買進良機。',
    op: '可進場 30%。若隔日再度跌破則為真跌破,停損出場。',
  },
  {
    no: '④', side: 'buy', id: 'S23', icon: '④',
    name: '買四·嚴重超跌反彈',
    short: '超跌反彈',
    cond: '股價偏離 MA20 ≤ -10% + 今日未繼續跌',
    desc: '股價遠低於 MA20(乖離 ≤ -10%),統計上有強力反彈需求。是**逆勢**短線操作訊號,僅適合短打不適合留倉。',
    op: '快進快出,目標價為均線附近(漲幅約 8~10%)。停損設在再跌 3% 處。',
  },
  // ── 賣出訊號 ──
  {
    no: '⑤', side: 'sell', id: 'W18', icon: '①',
    name: '賣一·趨勢反轉',
    short: '跌破月線',
    cond: 'MA20 由揚轉跌 + 股價向下跌破 MA20',
    desc: '長期上漲後,均線首次走平/下彎,股價同時跌破均線,趨勢反轉訊號。葛蘭碧八法中**最強**的賣出訊號。',
    op: '出場一半,反彈到 MA20 附近再出另一半。空方可進場做空。',
  },
  {
    no: '⑥', side: 'sell', id: 'W15', icon: '②',
    name: '賣二·反彈失敗',
    short: '反彈失敗',
    cond: '股價在 MA20 下方,昨日反彈觸碰 MA20,今日跌回 MA20 下方',
    desc: '下跌趨勢中股價反彈到月線**沒有真正站上**,當日跌回下方繼續下跌。是趨勢延續的賣出訊號。',
    op: '減碼點。空單可進場,目標看前波低點。多單應全部出場。',
  },
  {
    no: '⑦', side: 'sell', id: 'W19', icon: '③',
    name: '賣三·下跌中超漲',
    short: '超漲修正',
    cond: '股價在 MA20 下方 + 短暫超漲 5% 以上 + MA20 連續下彎',
    desc: '下跌中途的反彈,股價超漲 MA20 達 5% 以上,但 MA20 仍持續下彎,**反彈即將結束**的訊號。',
    op: '反彈出貨點。不建議追多,空單可在此進場。',
  },
  {
    no: '⑧', side: 'sell', id: 'W20', icon: '④',
    name: '賣四·過熱反轉',
    short: '過熱反轉',
    cond: '股價偏離 MA20 ≥ +10% + MA20 連續下彎',
    desc: '股價遠高於 MA20(乖離 ≥ +10%)而均線下彎,過熱必須修正。**逆勢警示**訊號,即使在多頭格局也應減碼。',
    op: '高位減碼。若已有獲利可分批出場,空單可短打但要快進快出。',
  },
];

const _BUY_IDS  = ['S20','S21','S22','S23'];
const _SELL_IDS = ['W18','W15','W19','W20'];

const GranvilleModule = {
  id: 'granville',
  name: '葛蘭碧八法',
  icon: '🎯',
  candleMinLen: 30,  // MA20 + 多日比對最少要 30 根

  evaluate(candles) {
    const n = candles.length;
    const code = AppState.activeCode || '';

    // 從 AppState.signals 撈出已掃出的訊號(matchSignals 算過)
    const allSignals = AppState.signals?.[code] ?? [];
    const triggeredIds = new Set(allSignals.map(s => s.id));

    // 算 MA20 + 乖離率(供 SVG 與行動指引用)
    const closes = candles.map(c => c.close);
    const ma20   = calcMA(closes, 20);
    const last   = n - 1;
    const close  = candles[last]?.close;
    const ma     = ma20[last];
    const bias   = (close != null && ma != null && ma > 0)
      ? (close - ma) / ma * 100
      : null;

    // 標記八法觸發狀態
    const laws = GRANVILLE_LAWS.map(L => ({
      ...L,
      triggered: triggeredIds.has(L.id),
    }));

    // 觸發中的訊號
    const triggeredBuy  = laws.filter(L => L.side === 'buy'  && L.triggered);
    const triggeredSell = laws.filter(L => L.side === 'sell' && L.triggered);

    // ── 即時判讀 items(沿用 ichimoku 風格) ──
    const items = [];

    // 條件 1: 股價相對 MA20 位置
    if (close != null && ma != null) {
      const above = close > ma;
      items.push({
        ok: above,
        lineRef: 'ma20',
        text: `<strong>K 線位置</strong>:${above ? '在 MA20 上方(多頭區)' : '在 MA20 下方(空頭區)'}`,
        sub: `收盤 ${close.toFixed(2)} ${above ? '>' : '<'} MA20 ${ma.toFixed(2)}（乖離 ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}%）`,
        whyTitle: '為什麼 MA20 是關鍵?',
        why: '葛蘭碧八法的核心是 20 日移動平均線(月線)。月線代表近一個月所有持有者的平均成本,股價在月線上方時市場多頭氣氛濃厚,反之則弱勢。葛蘭碧用「股價 vs 月線」+「月線方向」兩個維度組合出 8 個交易訊號。',
      });
    }

    // 條件 2: MA20 方向
    const m1 = ma20[last];
    const m3 = ma20[last - 3];
    if (m1 != null && m3 != null) {
      const slope = m1 - m3;
      const up   = slope > 0;
      items.push({
        ok: up,
        lineRef: 'ma20',
        text: `<strong>MA20 方向</strong>:${up ? '上揚(多頭趨勢)' : slope === 0 ? '走平(整理中)' : '下彎(空頭趨勢)'}`,
        sub: `近 3 日 MA20 ${slope > 0 ? '+' : ''}${slope.toFixed(2)}（${ma20[last-3]?.toFixed(2)} → ${ma20[last]?.toFixed(2)}）`,
        whyTitle: '為什麼月線方向重要?',
        why: '月線方向決定主趨勢。月線上揚時,葛蘭碧買一/二/三/四 都更可信;月線下彎時,賣一/二/三/四 才會啟動。錯把空頭中的反彈當買進訊號是葛蘭碧八法最常見的誤用。',
      });
    }

    // 條件 3: 目前觸發狀況(綜合)
    const totalTriggered = triggeredBuy.length + triggeredSell.length;
    if (totalTriggered === 0) {
      items.push({
        ok: null,
        lineRef: 'ma20',
        text: `<strong>目前狀態</strong>:無葛蘭碧訊號`,
        sub: `8 個訊號全部未觸發,等待方向明確`,
      });
    } else {
      const trig = [...triggeredBuy, ...triggeredSell];
      items.push({
        ok: triggeredBuy.length > triggeredSell.length ? true
          : triggeredBuy.length < triggeredSell.length ? false
          : null,
        lineRef: 'ma20',
        text: `<strong>目前觸發</strong>:${trig.map(L => `${L.no} ${L.short}`).join('、')}`,
        sub: `${triggeredBuy.length} 個買進 / ${triggeredSell.length} 個賣出`,
        whyTitle: '同時觸發多個怎麼辦?',
        why: '葛蘭碧八法在同一時點通常只會觸發 1~2 個訊號(因為條件邏輯互斥)。若同時觸發買賣訊號(罕見),代表股價在過渡狀態,應該觀望而非加倉/減倉。',
      });
    }

    // 綜合訊號判定
    let signal = null;
    let score  = 0;
    if (triggeredBuy.length > 0 && triggeredSell.length === 0) {
      const strongest = triggeredBuy[0];
      signal = {
        name: strongest.name,
        icon: '▲',
        stars: strongest.id === 'S20' ? 5 : strongest.id === 'S21' ? 4 : strongest.id === 'S22' ? 4 : 3,
        desc: strongest.desc,
      };
      score = signal.stars;
    } else if (triggeredSell.length > 0 && triggeredBuy.length === 0) {
      const strongest = triggeredSell[0];
      signal = {
        name: strongest.name,
        icon: '▼',
        stars: strongest.id === 'W18' ? 5 : strongest.id === 'W15' ? 4 : strongest.id === 'W19' ? 3 : 3,
        desc: strongest.desc,
      };
      score = signal.stars;
    } else if (triggeredBuy.length > 0 && triggeredSell.length > 0) {
      signal = { name: '多空交錯', icon: '⚡', stars: 2,
        desc: '同時觸發買進與賣出訊號,訊號矛盾,建議觀望等待方向明確。' };
      score = 2;
    } else {
      // 沒觸發 — 看股價位置給定基本提示
      if (close != null && ma != null) {
        const above = close > ma;
        signal = above
          ? { name: '月線之上', icon: '🟢', stars: 2,
              desc: '股價在月線上方但未觸發明確訊號,持有股票可繼續觀察。' }
          : { name: '月線之下', icon: '🔴', stars: 1,
              desc: '股價在月線下方但未觸發明確訊號,持有股票應警惕。' };
        score = signal.stars;
      } else {
        signal = { name: '資料不足', icon: '🌫️', stars: 0,
          desc: '需要至少 30 根 K 線才能完整判讀,目前資料不足。' };
        score = 0;
      }
    }

    return {
      score, signal, items,
      raw: {
        close, ma20: ma, bias, n,
        ma20Series: ma20,
        candles,
        laws,
        triggeredBuy,
        triggeredSell,
      },
    };
  },

  // v3 圖例(因葛蘭碧只有 MA20 一條線,圖例極簡)
  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = (v) => v == null ? '—' : v.toFixed(2);
    return [
      { id: 'ma20', name: '🟡 MA20(月線)', value: fmt(ev.raw.ma20), color: '#fbbf24',
        tooltip: '20 日移動平均線 — 葛蘭碧八法的唯一基準線' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🎯 葛蘭碧</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${_escapeAttr(ev.signal.desc)}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw || ev.raw.n < 30) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">🎯</span>
        <span class="fs-title">葛蘭碧八法</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足(需 ≥ 30 根日 K 才能判讀葛蘭碧八法)</p>
      </div>`;
    }

    const stars = '⭐'.repeat(ev.signal.stars);
    const r     = ev.raw;
    const fmt   = (v) => v == null ? '—' : v.toFixed(2);
    const code  = AppState.activeCode || '';

    const svgHTML       = _granvilleSVG(r);
    const statusCardHTML= _granvilleStatusCard(ev);
    const signalTableHTML = _granvilleSignalTable(ev);
    const actionGuideHTML = _granvilleActionGuide(ev);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🎯</span>
        <span class="fs-title">葛蘭碧八法</span>
        <span class="fs-subtitle">經典 MA20 戰術 · 4 買 4 賣完整訊號清單</span>
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

        ${statusCardHTML}
        ${svgHTML}
        ${signalTableHTML}
        ${actionGuideHTML}

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 📚 葛蘭碧八法的歷史背景 ━━━</h4>
            <p>葛蘭碧八法(Granville's Eight Rules)是美國股市分析師 <strong>Joseph E. Granville</strong> 於 1960 年代提出的經典技術分析法則。Granville 觀察道瓊指數的長期走勢,發現股價與其長期移動平均線之間存在 8 種固定的相對位置變化,每種變化都對應一個明確的買賣訊號。</p>
            <p>葛蘭碧自己使用的是 <strong>200 日均線</strong>,後人改良為適用台股短中線的 <strong>20 日均線(月線)</strong>。在台灣,月線是法人與技術派最重視的均線之一,因為它代表「近一個月所有買進者的平均成本」,股價跌破月線等於這些人都套牢,反之則大家都有獲利。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🔍 4 個買進訊號 ━━━</h4>
            <p><strong>① 買一(趨勢反轉)— ⭐⭐⭐⭐⭐</strong>:長期跌勢後,MA20 由下降轉為走平/上揚,股價同時突破 MA20。這是葛蘭碧八法中**勝率最高**的訊號,因為它捕捉到了趨勢的真正反轉點。</p>
            <p><strong>② 買二(回踩不破)— ⭐⭐⭐⭐</strong>:已在多頭趨勢中,股價回測 MA20 但未真正跌破,當日就收回上方。趨勢延續的加碼點。</p>
            <p><strong>③ 買三(假跌破)— ⭐⭐⭐⭐</strong>:短暫跌破 MA20 後快速收回,且 MA20 仍向上。常為主力洗盤後的進場機會。</p>
            <p><strong>④ 買四(嚴重超跌)— ⭐⭐⭐</strong>:股價乖離 MA20 達 -10% 以下時的反彈機會。**逆勢操作**,只適合短打,不要留倉。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🔍 4 個賣出訊號 ━━━</h4>
            <p><strong>① 賣一(趨勢反轉)— ⭐⭐⭐⭐⭐</strong>:長期漲勢後,MA20 由上揚轉為走平/下彎,股價同時跌破 MA20。**最強的賣出訊號**,代表頭部已成。</p>
            <p><strong>② 賣二(反彈失敗)— ⭐⭐⭐⭐</strong>:已在空頭趨勢中,股價反彈到 MA20 但未真正站上,當日跌回下方。趨勢延續的減碼點。</p>
            <p><strong>③ 賣三(超漲修正)— ⭐⭐⭐</strong>:下跌中途的反彈超漲 MA20 達 5% 以上,但 MA20 仍持續下彎。反彈即將結束。</p>
            <p><strong>④ 賣四(過熱反轉)— ⭐⭐⭐</strong>:股價乖離 MA20 達 +10% 以上,且 MA20 下彎。即使多頭格局也應減碼。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 葛蘭碧八法的使用陷阱 ━━━</h4>
            <ul>
              <li><strong>不看趨勢就用</strong>:在橫盤整理區,假突破/假跌破會頻繁出現,容易來回打巴掌</li>
              <li><strong>忽略 MA20 方向</strong>:買一/賣一 必須搭配 MA20 方向反轉才成立,不能只看股價穿越 MA20</li>
              <li><strong>把賣四當作買進</strong>:股價乖離 +10% 不是「強勢」訊號,是過熱訊號,新手最常誤判的地方</li>
              <li><strong>逆勢操作買四/賣三</strong>:這兩個是逆勢訊號,只適合短打,不要因此重押反向部位</li>
            </ul>
          </div>
        </div>

        <div class="fs-application">
          <h4>💡 實戰應用 — 你該怎麼用</h4>
          <p><strong>長線投資人</strong>:只看買一/賣一,這兩個訊號可靠度最高且發生頻率低(一年數次),適合分批進出。</p>
          <p><strong>波段操作</strong>:買一進場,賣二減碼一半,賣一全出。完整波段約 1~3 個月。</p>
          <p><strong>短線交易</strong>:買二/買三 / 賣二/賣三 為主,搭配量能確認(放量更佳)。停損嚴格設在 MA20 上下 2~3%。</p>
          <p><strong>該避開時</strong>:股價在 MA20 附近上下震盪超過 5 個交易日 → 進入盤整區,任何葛蘭碧訊號都不可信,等待方向明確。</p>
        </div>

        ${renderAISection('granville', '葛蘭碧八法', '🎯', ev, (() => {
          const pct = (a, b) => (a != null && b != null && b !== 0)
            ? ` (${((a - b) / b * 100).toFixed(2)}%)` : '';
          const trigBuy  = r.triggeredBuy.map(L => `${L.no} ${L.short}`).join('、') || '無';
          const trigSell = r.triggeredSell.map(L => `${L.no} ${L.short}`).join('、') || '無';
          const ma20Dir = (() => {
            const m1 = r.ma20Series[r.n - 1];
            const m3 = r.ma20Series[r.n - 4];
            if (m1 == null || m3 == null) return '—';
            return m1 > m3 ? `上揚 +${(m1 - m3).toFixed(2)}` : m1 < m3 ? `下彎 ${(m1 - m3).toFixed(2)}` : '走平';
          })();
          return {
            '收盤價': fmt(r.close),
            'MA20(月線)': fmt(r.ma20),
            '股價相對 MA20 乖離率': r.bias != null ? `${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(2)}%` : '—',
            'MA20 近 3 日方向': ma20Dir,
            '觸發中的買進訊號【可進場】': trigBuy,
            '觸發中的賣出訊號【應出場】': trigSell,
            '訊號總數': `買 ${r.triggeredBuy.length} 個 / 賣 ${r.triggeredSell.length} 個`,
          };
        })())}

      </div>
    `;
  },
};

// ═══════════════════════════════════════════════════════
// helper:狀態卡(段 1)
// ═══════════════════════════════════════════════════════
function _granvilleStatusCard(ev) {
  const r = ev.raw;
  const trigBuy  = r.triggeredBuy;
  const trigSell = r.triggeredSell;
  const total    = trigBuy.length + trigSell.length;

  if (total === 0) {
    return `
      <div class="fs-granville-card is-neutral">
        <div class="fs-granville-card-icon">⏸</div>
        <div class="fs-granville-card-body">
          <div class="fs-granville-card-title">目前無葛蘭碧訊號</div>
          <div class="fs-granville-card-sub">8 個訊號全部未觸發 — 等待方向明確,目前不適合進出場</div>
        </div>
      </div>
    `;
  }

  const mainTrig = trigBuy[0] || trigSell[0];
  const cardCls  = trigBuy.length >= trigSell.length ? 'is-buy' : 'is-sell';
  const sideTag  = mainTrig.side === 'buy' ? '▲ 買入訊號' : '▼ 賣出訊號';

  const allTrigs = [...trigBuy, ...trigSell];
  const extraList = allTrigs.length > 1
    ? `<div class="fs-granville-card-extra">
         同時觸發:${allTrigs.map(L => `<span class="fs-granville-tag is-${L.side}">${L.no} ${L.short}</span>`).join(' ')}
       </div>`
    : '';

  return `
    <div class="fs-granville-card ${cardCls}">
      <div class="fs-granville-card-icon">${mainTrig.no}</div>
      <div class="fs-granville-card-body">
        <div class="fs-granville-card-title">${mainTrig.name}</div>
        <div class="fs-granville-card-side">${sideTag}</div>
        <div class="fs-granville-card-sub">${mainTrig.cond}</div>
        <div class="fs-granville-card-op">💡 ${mainTrig.op}</div>
        ${extraList}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════
// helper:SVG 八法示意圖(段 2)
// 方案 C:真實 K 線蠟燭 + 圓圈移至 K 柱外側(買入=下方, 賣出=上方) + 虛線引線
// 觸發中的訊號:halo 呼吸動畫 + 白色描邊放大
// ═══════════════════════════════════════════════════════
function _granvilleSVG(r) {
  const triggeredSet = new Set([
    ...r.triggeredBuy.map(L => L.id),
    ...r.triggeredSell.map(L => L.id),
  ]);

  // ── K 線資料定義 ──────────────────────────────────────
  // 每欄:{ x中心, high_y, low_y, open_y, close_y }
  // y 值:數值越大=畫面越低(SVG 座標)。K 線主體在 open~close 之間。
  // 台股色：close < open = 綠(跌), close > open = 紅(漲)
  // 整體趨勢:築底→上升→頭部→下跌
  // viewBox: 0 0 700 360 (底部留空間給買入圓圈+文字)

  const candles = [
    // 築底3根(小跌)
    { x:  38, H:198, L:218, O:215, C:210 },  // 0
    { x:  53, H:205, L:228, O:215, C:220 },  // 1
    { x:  68, H:210, L:232, O:225, C:218 },  // 2
    // 買一:突破月線(大陽線)
    { x:  83, H:192, L:228, O:226, C:198 },  // 3  ← S20 觸發K
    // 上升段
    { x:  98, H:178, L:210, O:208, C:183 },  // 4
    { x: 113, H:165, L:195, O:194, C:170 },  // 5
    { x: 128, H:170, L:195, O:175, C:185 },  // 6 (小回)
    // 買二:回踩MA20不破後反彈
    { x: 143, H:165, L:200, O:197, C:170 },  // 7  ← S21 觸發K
    // 續漲
    { x: 158, H:148, L:178, O:177, C:153 },  // 8
    { x: 173, H:138, L:162, O:160, C:143 },  // 9
    // 買三:假跌破後收回(下影線長)
    { x: 188, H:135, L:170, O:163, C:140 },  // 10 ← S22 觸發K
    // 續創高
    { x: 203, H:122, L:148, O:147, C:126 },  // 11
    { x: 218, H:112, L:138, O:137, C:116 },  // 12
    { x: 233, H:108, L:130, O:129, C:112 },  // 13
    { x: 248, H:106, L:126, O:114, C:118 },  // 14 (小陰)
    // 賣四:乖離過大孤立高點
    { x: 263, H: 72, L: 92, O: 90, C: 76 },  // 15 ← W20 觸發K (大陽漲離MA20)
    // 頭部盤整
    { x: 278, H:112, L:132, O:125, C:118 },  // 16 (陰)
    { x: 293, H:114, L:130, O:120, C:116 },  // 17 (小陰)
    // 賣一:跌破月線(大陰線)
    { x: 308, H:122, L:158, O:128, C:155 },  // 18 ← W18 觸發K
    // 下跌段
    { x: 323, H:140, L:172, O:158, C:168 },  // 19 (陰)
    { x: 338, H:148, L:178, O:170, C:162 },  // 20 (小陽,反彈)
    // 賣二:反彈觸MA20失敗
    { x: 353, H:150, L:186, O:162, C:178 },  // 21 ← W15 觸發K (上影觸MA20)
    // 繼續下跌
    { x: 368, H:172, L:202, O:182, C:195 },  // 22
    { x: 383, H:185, L:215, O:198, C:210 },  // 23
    { x: 398, H:190, L:215, O:212, C:200 },  // 24 (小陽)
    // 賣三:月線下反彈超漲
    { x: 413, H:185, L:222, O:215, C:192 },  // 25 ← W19 觸發K
    // 再跌
    { x: 428, H:200, L:230, O:208, C:222 },  // 26
    { x: 443, H:212, L:242, O:225, C:238 },  // 27
    { x: 458, H:225, L:252, O:240, C:248 },  // 28
    // 買四孤立低點(乖離 -10%,在左側築底附近)
    { x:  38, H:255, L:282, O:258, C:268 },  // 29 ← S23 低點K
  ];

  // MA20 貝茲路徑(穿越 K 線群)
  const maPath = 'M 25,212 C 80,212 120,195 160,170 S 220,140 270,118 S 310,112 330,125 S 370,155 410,188 S 450,218 470,232';

  // 高點/低點虛線
  // 上升區高點: y≈108 (x=210~270)
  // 下跌後低點: y≈248 (x=420~460)
  // 買四低點: y≈268 (x=25~55)

  // ── 每根 K 線渲染 ────────────────────────────────────
  function renderCandle(c) {
    const isUp = c.C <= c.O;   // 台股:收<開=綠(跌),收>開=紅(漲)
    const col  = isUp ? '#26a69a' : '#ef5350';
    const bodyT = Math.min(c.O, c.C);
    const bodyH = Math.max(Math.abs(c.O - c.C), 2);
    return `<g>
      <line x1="${c.x}" y1="${c.H}" x2="${c.x}" y2="${c.L}" stroke="${col}" stroke-width="0.9" opacity="0.8"/>
      <rect x="${c.x - 5}" y="${bodyT}" width="10" height="${bodyH}" fill="${col}" opacity="0.9"/>
    </g>`;
  }

  // ── 訊號點渲染:圓圈在 K 柱外側 + 虛線引線 + 文字 ──
  // 買入訊號:圓圈在 K 柱 low_y 下方 28px
  // 賣出訊號:圓圈在 K 柱 high_y 上方 28px
  // 引線:K 柱端點 → 圓圈邊緣(垂直虛線)
  // 文字:圓圈再往外 16px

  const signals = [
    { id: 'S20', no: '①', side: 'buy',  ci: 3,  label: '買一', sub: '突破月線' },
    { id: 'S21', no: '②', side: 'buy',  ci: 7,  label: '買二', sub: '回踩不破' },
    { id: 'S22', no: '③', side: 'buy',  ci: 10, label: '買三', sub: '假跌破' },
    { id: 'S23', no: '④', side: 'buy',  ci: 29, label: '買四', sub: '超跌' },
    { id: 'W18', no: '①', side: 'sell', ci: 18, label: '賣一', sub: '跌破月線' },
    { id: 'W15', no: '②', side: 'sell', ci: 21, label: '賣二', sub: '反彈失敗' },
    { id: 'W19', no: '③', side: 'sell', ci: 25, label: '賣三', sub: '超漲修正' },
    { id: 'W20', no: '④', side: 'sell', ci: 15, label: '賣四', sub: '過熱' },
  ];

  function renderSignal(sig) {
    const c      = candles[sig.ci];
    const isTrig = triggeredSet.has(sig.id);
    const isBuy  = sig.side === 'buy';
    const color  = isBuy ? '#ef5350' : '#26a69a';
    const R      = isTrig ? 11 : 10;       // 觸發中略大
    const sw     = isTrig ? 1.8 : 1;

    // 圓圈中心:buy = low + 38, sell = high - 38
    // 間距拉大到 38px 確保引線 + 圓圈邊緣都不貼 K 柱
    const cx = c.x;
    const cy = isBuy ? c.L + 38 : c.H - 38;

    // 引線:K 柱端 (+2px buffer) → 圓圈邊緣
    const lineY1 = isBuy ? c.L + 2 : c.H - 2;
    const lineY2 = isBuy ? cy - R  : cy + R;

    // 文字:圓圈邊緣再往外 14px(標題) + 13px(副標)
    const txtY = isBuy ? cy + R + 14 : cy - R - 14;
    const subY = isBuy ? txtY + 13   : txtY - 13;

    const halo = isTrig
      ? `<circle cx="${cx}" cy="${cy}" r="${R + 7}" fill="${color}" opacity="0.2" class="gv-point-halo"/>`
      : '';

    return `
      <g class="gv-point ${isTrig ? 'is-trig' : ''}" data-id="${sig.id}">
        ${halo}
        <line x1="${cx}" y1="${lineY1}" x2="${cx}" y2="${lineY2}"
              stroke="${color}" stroke-width="0.8" stroke-dasharray="3,2" opacity="0.7"/>
        <circle cx="${cx}" cy="${cy}" r="${R}"
                fill="${color}" stroke="${isTrig ? '#fff' : 'rgba(255,255,255,0.4)'}" stroke-width="${sw}"/>
        <text x="${cx}" y="${cy + 4}" text-anchor="middle"
              fill="#fff" font-size="10" font-weight="700">${sig.no}</text>
        <text x="${cx}" y="${txtY}" text-anchor="middle"
              fill="${color}" font-size="10" font-weight="600">${sig.label}</text>
        <text x="${cx}" y="${subY}" text-anchor="middle"
              fill="${color}" font-size="9" opacity="0.75">${sig.sub}</text>
      </g>`;
  }

  const candleSVG  = candles.slice(0, 29).map(renderCandle).join('');  // 排除買四孤立K(索引29)
  const s23candle  = renderCandle(candles[29]);                          // 買四孤立K單獨繪製
  const signalSVG  = signals.map(renderSignal).join('');

  return `
    <div class="fs-granville-svg-wrap">
      <h4 class="fs-granville-svg-title">📍 葛蘭碧八法示意圖
        <span class="fs-granville-svg-hint">紅 = 買入 · 綠 = 賣出 · 已觸發者高亮</span>
      </h4>
      <svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg" class="fs-granville-svg">

        <!-- 背景格線 -->
        <line x1="20" y1="75"  x2="680" y2="75"  stroke="rgba(255,255,255,0.03)" stroke-dasharray="2,5"/>
        <line x1="20" y1="155" x2="680" y2="155" stroke="rgba(255,255,255,0.03)" stroke-dasharray="2,5"/>
        <line x1="20" y1="235" x2="680" y2="235" stroke="rgba(255,255,255,0.03)" stroke-dasharray="2,5"/>

        <!-- 區間高點虛線(上升段頂部) -->
        <line x1="200" y1="108" x2="300" y2="108"
              stroke="rgba(239,83,80,0.35)" stroke-width="0.8" stroke-dasharray="4,3"/>
        <text x="302" y="112" fill="rgba(239,83,80,0.6)" font-size="9">區間高點</text>

        <!-- 買四低點虛線(築底區) -->
        <line x1="20" y1="282" x2="68" y2="282"
              stroke="rgba(38,166,154,0.35)" stroke-width="0.8" stroke-dasharray="4,3"/>
        <text x="70" y="286" fill="rgba(38,166,154,0.6)" font-size="9">超跌低點</text>

        <!-- 下跌後低點虛線 -->
        <line x1="425" y1="248" x2="470" y2="248"
              stroke="rgba(38,166,154,0.35)" stroke-width="0.8" stroke-dasharray="4,3"/>
        <text x="472" y="252" fill="rgba(38,166,154,0.6)" font-size="9">區間低點</text>

        <!-- 買四孤立K線(左下角超跌) -->
        ${s23candle}

        <!-- 主體K線群 -->
        ${candleSVG}

        <!-- MA20 黃線(在K線之上繪製,確保可見) -->
        <path d="${maPath}" stroke="#fbbf24" stroke-width="2" fill="none"/>
        <text x="478" y="228" fill="#fbbf24" font-size="10" font-weight="600">MA20</text>

        <!-- 訊號點(在最上層) -->
        ${signalSVG}

        <!-- 趨勢區標籤 -->
        <text x="200" y="392" text-anchor="middle" fill="rgba(232,234,237,0.3)" font-size="10">↑ 上升趨勢區（買一~三）</text>
        <text x="420" y="392" text-anchor="middle" fill="rgba(232,234,237,0.3)" font-size="10">↓ 下降趨勢區（賣一~三）</text>
      </svg>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════
// helper:訊號表(段 3)
// 列出 8 個訊號,標示目前觸發狀態
// ═══════════════════════════════════════════════════════
function _granvilleSignalTable(ev) {
  const laws = ev.raw.laws;

  const rows = laws.map(L => {
    const sideCls = L.side === 'buy' ? 'is-buy' : 'is-sell';
    const sideTag = L.side === 'buy' ? '▲ 買' : '▼ 賣';
    const trigCls = L.triggered ? 'is-trig' : '';
    const trigTag = L.triggered
      ? `<span class="fs-granville-trigged">✓ 觸發中</span>`
      : `<span class="fs-granville-not-trig">— 未觸發</span>`;
    return `
      <div class="fs-granville-row ${sideCls} ${trigCls}">
        <span class="fs-granville-no">${L.no}</span>
        <div class="fs-granville-row-main">
          <div class="fs-granville-row-head">
            <span class="fs-granville-side ${sideCls}">${sideTag}</span>
            <span class="fs-granville-name">${L.name}</span>
            ${trigTag}
          </div>
          <div class="fs-granville-row-cond">${L.cond}</div>
          <div class="fs-granville-row-desc">${L.desc}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="fs-granville-table">
      <h4 class="fs-granville-table-title">📋 八法訊號逐一說明</h4>
      <div class="fs-granville-rows">
        ${rows}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════
// helper:行動指引(根據觸發訊號生成建議)
// ═══════════════════════════════════════════════════════
function _granvilleActionGuide(ev) {
  const r = ev.raw;
  const trigBuy  = r.triggeredBuy;
  const trigSell = r.triggeredSell;
  const ma       = r.ma20;

  let rows = [];

  if (trigBuy.length > 0 && trigSell.length === 0) {
    const main = trigBuy[0];
    rows = [
      { label: '操作方向', detail: `<strong>偏多進場</strong>(${main.no} ${main.name})` },
      { label: '具體做法', detail: main.op },
      { label: '停損位置', detail: ma != null ? `跌破 <span class="fs-price">${(ma * 0.97).toFixed(2)}</span>(MA20 下方 3%)出場` : '參考 MA20 下方 2~3%' },
      { label: '該注意什麼', detail: main.id === 'S23'
        ? `<strong>買四是逆勢訊號</strong>,僅適合短打,股價回到 MA20 附近(漲幅 8~10%)就應出場,不要留倉` :
        main.id === 'S20'
        ? `<strong>買一是最強訊號</strong>,但仍應分批進場,避免一次重押` :
        `搭配量能確認(放量更佳),若量能不足訊號可靠度打折` },
    ];
  } else if (trigSell.length > 0 && trigBuy.length === 0) {
    const main = trigSell[0];
    rows = [
      { label: '操作方向', detail: `<strong>偏空出場</strong>(${main.no} ${main.name})` },
      { label: '具體做法', detail: main.op },
      { label: '反彈壓力', detail: ma != null ? `反彈到 <span class="fs-price">${ma.toFixed(2)}</span>(MA20)附近會受壓` : '反彈到 MA20 附近會受壓' },
      { label: '該注意什麼', detail: main.id === 'W20'
        ? `<strong>賣四是過熱訊號</strong>,即使多頭格局也應減碼,不要因為持續上漲而忽略` :
        main.id === 'W18'
        ? `<strong>賣一是最強賣出訊號</strong>,代表頭部已成,反彈都應視為出貨機會` :
        `下跌趨勢中的反彈往往短促,不要逆勢攤平` },
    ];
  } else if (trigBuy.length > 0 && trigSell.length > 0) {
    rows = [
      { label: '操作方向', detail: `<strong>觀望等待</strong> — 多空訊號同時出現` },
      { label: '為何觀望', detail: `葛蘭碧八法的條件通常互斥,同時觸發代表股價在過渡狀態,方向不明` },
      { label: '建議', detail: `等待其中一邊訊號消失(通常 3~5 個交易日內)再決定方向` },
      { label: '該注意什麼', detail: `若已有持股可繼續持有但不加碼,未持有則不要進場` },
    ];
  } else {
    rows = [
      { label: '操作方向', detail: `<strong>等待訊號</strong> — 目前無明確葛蘭碧八法訊號` },
      { label: '可能觸發點', detail: ma != null
        ? `若股價突破 <span class="fs-price">${ma.toFixed(2)}</span>(MA20)+ MA20 走平/上揚 → 買一` : '需 MA20 資料齊備' },
      { label: '反向風險', detail: ma != null
        ? `若股價跌破 <span class="fs-price">${ma.toFixed(2)}</span> + MA20 下彎 → 賣一` : '需 MA20 資料齊備' },
      { label: '該注意什麼', detail: `葛蘭碧八法不是隨時都有訊號,沒訊號就不操作是正確的紀律` },
    ];
  }

  return `
    <div class="fs-action-guide">
      <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據葛蘭碧八法</div>
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
registerAnalysisModule(GranvilleModule);
