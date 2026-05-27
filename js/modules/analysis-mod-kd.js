/* js/modules/analysis-mod-kd.js
 * 🌟 KD Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcKD } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const KDModule = {
  id: 'kd',
  name: 'KD 隨機指標',
  icon: '📈',
  candleMinLen: 26,

  evaluate(candles) {
    const n = candles.length;
    const { k: kArr, d: dArr } = calcKD(candles);

    const lastK  = kArr[n - 1];
    const lastD  = dArr[n - 1];
    const prevK  = kArr[n - 2] ?? lastK;
    const prevD  = dArr[n - 2] ?? lastD;
    const lastClose = candles[n - 1].close;

    // 近 3 根是否有黃金/死亡交叉
    let crossBull = false, crossBear = false;
    for (let i = Math.max(1, n - 3); i < n; i++) {
      if (kArr[i - 1] <= dArr[i - 1] && kArr[i] > dArr[i]) crossBull = true;
      if (kArr[i - 1] >= dArr[i - 1] && kArr[i] < dArr[i]) crossBear = true;
    }

    const items = [];

    // ── 條件 1：KD 位置（超買/超賣/中性）──
    const overbought  = lastK >= 80 && lastD >= 80;
    const oversold    = lastK <= 20 && lastD <= 20;
    if (overbought) {
      items.push({
        ok: false,
        text: `<strong>超買區</strong>：K ${lastK.toFixed(1)} / D ${lastD.toFixed(1)}（≥ 80）`,
        sub: `K 值與 D 值均進入超買區，短線獲利賣壓增加`,
        whyTitle: '為什麼超買是警訊？',
        why: 'KD 的 K 值本質是「近 N 日收盤在最高最低區間的相對位置」。K≥80 代表收盤持續靠近高點，短線賣壓可能出現。但強勢股可以在超買區橫行，需搭配背離或死亡交叉確認才賣。',
      });
    } else if (oversold) {
      items.push({
        ok: true,
        text: `<strong>超賣區</strong>：K ${lastK.toFixed(1)} / D ${lastD.toFixed(1)}（≤ 20）`,
        sub: `K 值與 D 值均進入超賣區，反彈機率提升`,
        whyTitle: '為什麼超賣是機會？',
        why: 'KD 進入超賣區代表短線被過度拋售，RSV 持續接近低點。歷史上超賣後反彈機率高，但空頭趨勢中超賣可以持續很久，需搭配黃金交叉才真正進場。',
      });
    } else {
      items.push({
        ok: null,
        text: `<strong>中性區</strong>：K ${lastK.toFixed(1)} / D ${lastD.toFixed(1)}`,
        sub: `不在超買也不在超賣，位於 20~80 的正常波動區`,
        whyTitle: '中性區代表什麼？',
        why: '20~80 是 KD 的「正常波動帶」，代表多空力道均衡。這時候以趨勢方向為主，不宜單純靠 KD 決策，需搭配均線或型態判斷大方向。',
      });
    }

    // ── 條件 2：K vs D 排列（多空方向）──
    items.push({
      ok: lastK > lastD,
      text: lastK > lastD
        ? `<strong>多頭排列</strong>：K（${lastK.toFixed(1)}）> D（${lastD.toFixed(1)}）`
        : `<strong>空頭排列</strong>：K（${lastK.toFixed(1)}）< D（${lastD.toFixed(1)}）`,
      sub: `差距 ${(lastK - lastD).toFixed(1)}，K 線走勢${lastK > prevK ? '↑ 向上' : '↓ 向下'}`,
      whyTitle: '為什麼 K > D 是多頭？',
      why: 'K 線（快線）比 D 線（慢線）敏感。K 上穿 D 代表短期動能反轉向上（黃金交叉），是多頭買進訊號；K 下穿 D 是死亡交叉，為空頭賣出訊號。這個排列是當下動能方向的最直接反映。',
    });

    // ── 條件 3：黃金/死亡交叉（近 3 根）──
    if (crossBull) {
      items.push({
        ok: true,
        text: `<strong>黃金交叉</strong>：近 3 根 K 上穿 D（多頭啟動訊號）`,
        sub: `短期動能反轉向上，搭配超賣區更可靠`,
        whyTitle: '為什麼黃金交叉是買點？',
        why: 'KD 黃金交叉（K 由下穿越 D 向上）是隨機指標的核心買進訊號。超賣區（K<20）發生的交叉可靠度最高，稱為「低檔黃金交叉」；50 附近的交叉需搭配其他指標驗證。',
      });
    } else if (crossBear) {
      items.push({
        ok: false,
        text: `<strong>死亡交叉</strong>：近 3 根 K 下穿 D（空頭賣出訊號）`,
        sub: `短期動能反轉向下，搭配超買區更可靠`,
        whyTitle: '為什麼死亡交叉是賣點？',
        why: 'KD 死亡交叉（K 由上穿越 D 向下）是賣出訊號。超買區（K>80）發生的死亡交叉可靠度最高，稱為「高檔死亡交叉」；要避免在強勢多頭中只因死叉就出場，需確認 K 值真的從高位回落。',
      });
    }

    // ── 條件 4：K 值趨勢方向（動能加速/減速）──
    const kMomentum = lastK - prevK;
    items.push({
      ok: kMomentum > 0,
      text: `<strong>K 值動能</strong>：${kMomentum > 0 ? '↑ 加速向上' : kMomentum < 0 ? '↓ 轉向下滑' : '→ 持平'}`,
      sub: `K 值本根 ${lastK.toFixed(1)} vs 前根 ${prevK.toFixed(1)}（變化 ${kMomentum > 0 ? '+' : ''}${kMomentum.toFixed(1)}）`,
      whyTitle: '為什麼看 K 值變化方向？',
      why: 'K 值加速向上代表短線買盤持續涌入；K 值開始下滑（即使尚未死叉）是動能減弱的早期警訊。高位（80 以上）的 K 值開始回彎，往往比死叉早 1~2 根出現。',
    });

    // ── 綜合訊號判定 ──
    let signal = null;
    let score = 0;
    const c1ok = items[0]?.ok === true;   // 超賣
    const c1bad = items[0]?.ok === false; // 超買
    const c2ok = items[1]?.ok === true;   // K>D 多排
    const crossOk = crossBull;
    const crossBad = crossBear;

    if (c1ok && crossOk) {
      signal = { name: '低檔黃金交叉', icon: '📈', stars: 5, desc: '超賣區 + 黃金交叉，KD 最強買進訊號，歷史勝率最高的進場時機。' };
      score = 5;
    } else if (c1bad && crossBad) {
      signal = { name: '高檔死亡交叉', icon: '📉', stars: 5, desc: '超買區 + 死亡交叉，KD 最強賣出訊號，建議減碼或出場。' };
      score = 1;
    } else if (crossOk) {
      signal = { name: '黃金交叉', icon: '✨', stars: 4, desc: 'K 上穿 D，短期動能反轉向上。非超賣區的交叉需搭配其他指標確認。' };
      score = 4;
    } else if (crossBad) {
      signal = { name: '死亡交叉', icon: '⚡', stars: 2, desc: 'K 下穿 D，短期動能反轉向下。非超買區的交叉需搭配其他指標確認。' };
      score = 2;
    } else if (c2ok && !c1bad) {
      signal = { name: '多頭動能', icon: '🔼', stars: 3, desc: 'K > D 多頭排列，動能偏多，無明確交叉訊號，維持方向不追高。' };
      score = 3;
    } else if (!c2ok && !c1ok) {
      signal = { name: '空頭動能', icon: '🔽', stars: 2, desc: 'K < D 空頭排列，動能偏空，避免追多，等待超賣或黃金交叉再評估。' };
      score = 2;
    } else {
      signal = { name: '中性整理', icon: '⏸', stars: 2, desc: 'KD 在中性區波動，無明確方向，以大趨勢為主，不宜依 KD 單邊操作。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { lastK, lastD, prevK, prevD, crossBull, crossBear, kMomentum, lastClose,
             kArr, dArr, n },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const { lastK, lastD } = ev.raw;
    const fmt = v => v == null ? '—' : v.toFixed(1);
    return [
      { id: 'kd-k', name: '🟡 K 值', value: fmt(lastK), color: '#f59e0b',
        tooltip: '快線，RSV 的 1/3 平滑 EMA，反應靈敏' },
      { id: 'kd-d', name: '🔵 D 值', value: fmt(lastD), color: '#60a5fa',
        tooltip: '慢線，K 值的 1/3 平滑 EMA，較穩定' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📈 KD</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">📈</span>
        <span class="fs-title">KD 隨機指標</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 26 根 K 線才能計算 KD）</p>
      </div>`;
    }

    const r = ev.raw;
    const fmt = v => v?.toFixed(1) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';

    // ── 關鍵數值區 ──
    const kdStatus = r.lastK >= 80 ? '🔴 超買' : r.lastK <= 20 ? '🟢 超賣' : '⚪ 中性';
    const crossHint = r.crossBull ? '✅ 近期黃金交叉' : r.crossBear ? '❌ 近期死亡交叉' : '— 無交叉';

    // ── 行動指引 ──
    const actionRows = _kdActionRows(ev);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📈</span>
        <span class="fs-title">KD 隨機指標</span>
        <span class="fs-subtitle">Stochastic Oscillator · K(9,3) D(3) 綜合判讀</span>
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
          <h4>📍 KD 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(245,158,11,0.18);color:#fbbf24">K 值</span>
            <span class="fs-keylevel-price">${fmt(r.lastK)}</span>
            <span class="fs-keylevel-desc">${kdStatus}${r.crossBull ? '　' + crossHint : r.crossBear ? '　' + crossHint : ''}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(96,165,250,0.18);color:#93c5fd">D 值</span>
            <span class="fs-keylevel-price">${fmt(r.lastD)}</span>
            <span class="fs-keylevel-desc">慢線 · K-D 差距 ${(r.lastK - r.lastD).toFixed(1)}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(139,92,246,0.18);color:#c4b5fd">K 動能</span>
            <span class="fs-keylevel-price">${r.kMomentum > 0 ? '↑' : r.kMomentum < 0 ? '↓' : '→'} ${r.kMomentum > 0 ? '+' : ''}${r.kMomentum.toFixed(1)}</span>
            <span class="fs-keylevel-desc">本根 vs 前根變化</span>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${actionRows.map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">

          <div class="fs-teach-section">
            <h4>━━━ 📈 KD 指標原理 ━━━</h4>
            <p><strong>RSV（Raw Stochastic Value）</strong>：(今日收盤 - N日最低) / (N日最高 - N日最低) × 100</p>
            <p><strong>K 值</strong>：前日 K × 2/3 + 今日 RSV × 1/3（快線，反應靈敏）</p>
            <p><strong>D 值</strong>：前日 D × 2/3 + 今日 K × 1/3（慢線，較穩定）</p>
            <p style="margin-top:8px">台股常用參數 K(9,3) D(3)，即以 9 日高低為基礎，3 次平滑。本系統採用此標準設定。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🎯 三大核心訊號 ━━━</h4>
            <p><strong>📈 低檔黃金交叉（⭐⭐⭐⭐⭐ 最強買進）</strong></p>
            <ul>
              <li>K 值由下穿越 D 值（K 上穿 D）</li>
              <li>發生在 <strong>K < 20 的超賣區</strong>時可靠度最高</li>
              <li>強烈買進訊號，是台股短線操作最普遍的進場依據</li>
            </ul>
            <p><strong>📉 高檔死亡交叉（⭐⭐⭐⭐⭐ 最強賣出）</strong></p>
            <ul>
              <li>K 值由上穿越 D 值（K 下穿 D）</li>
              <li>發生在 <strong>K > 80 的超買區</strong>時可靠度最高</li>
              <li>強烈賣出訊號，持多單者應考慮減碼</li>
            </ul>
            <p><strong>⚠️ 背離（未來預計加入）</strong></p>
            <ul>
              <li>底背離：股價創新低但 KD 不創新低 → 買進訊號</li>
              <li>頂背離：股價創新高但 KD 不創新高 → 賣出訊號</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>鈍化現象</strong>：強勢股可以讓 KD 在 80 以上鈍化數週甚至數月，不要在超買後就急著賣</li>
              <li><strong>假交叉</strong>：整理盤時 KD 反覆交叉，雜訊多。需搭配成交量或均線確認</li>
              <li><strong>適用週期</strong>：日線最準，週線次之。5分/15分 K 線雜訊多，訊號可靠性低</li>
              <li><strong>趨勢行情中</strong>：死叉不一定要出場，強多頭趨勢中回檔到 50 止穩就是繼續做多的機會</li>
            </ul>
          </div>

        </div>

        ${renderAISection('kd', 'KD 隨機指標', '📈', ev, (() => {
          // 近5根走勢，標出黃金/死亡交叉發生點
          const base = r.n - 5;
          const recent = r.kArr.slice(-5).map((v, i) => {
            const ki = r.kArr[base + i];
            const di = r.dArr[base + i];
            const kiPrev = r.kArr[base + i - 1];
            const diPrev = r.dArr[base + i - 1];
            const isCross = (kiPrev != null && diPrev != null)
              ? (kiPrev <= diPrev && ki > di ? '🔺黃金交叉' : kiPrev >= diPrev && ki < di ? '🔻死亡交叉' : '')
              : '';
            const label = i === 4 ? '【當根】' : `【-${4 - i}根】`;
            return `${label}K=${ki?.toFixed(1)??'—'} D=${di?.toFixed(1)??'—'}${isCross ? ' ' + isCross : ''}`;
          }).join(' → ');

          // K 值連續方向（判斷是加速還是減速）
          const kSlice = r.kArr.slice(-4);
          const kAccel = (kSlice[3] - kSlice[2]) - (kSlice[2] - kSlice[1]);
          const kdTrend = kSlice.every((v, i) => i === 0 || v > kSlice[i-1]) ? '連續上升'
                        : kSlice.every((v, i) => i === 0 || v < kSlice[i-1]) ? '連續下降'
                        : '震盪';

          // 各條件達成狀態（攤平 ev.items，AI 可明確引用每個條件）
          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            const text = item.text.replace(/<[^>]+>/g, '');
            return `條件${i + 1} ${status}：${text}`;
          }).join(' | ');
          const passCount = ev.items.filter(item => item.ok === true).length;
          const failCount = ev.items.filter(item => item.ok === false).length;

          return {
            'K值【當前快線，反應靈敏】': fmt(r.lastK),
            'D值【當前慢線，較穩定】': fmt(r.lastD),
            'K-D差距【正=多頭排列，負=空頭排列】': `${(r.lastK - r.lastD) > 0 ? '+' : ''}${(r.lastK - r.lastD).toFixed(1)}`,
            'K值動能【本根vs前根，正=加速向上】': `${r.kMomentum > 0 ? '+' : ''}${r.kMomentum.toFixed(1)}`,
            'K值加速度【正=動能加速，負=動能減速】': `${kAccel > 0 ? '+' : ''}${kAccel.toFixed(1)}（${kAccel > 0 ? '動能加速上行' : kAccel < 0 ? '動能減速/回頭' : '等速'}）`,
            'KD區間狀態【80超買/20超賣/中性】': r.lastK >= 80 ? '超買區（K≥80）' : r.lastK <= 20 ? '超賣區（K≤20）' : `中性區（K=${fmt(r.lastK)}）`,
            '近期交叉【黃金/死亡/無】': r.crossBull ? '近3根出現黃金交叉（K上穿D）' : r.crossBear ? '近3根出現死亡交叉（K下穿D）' : '近3根無交叉',
            '近5根KD走勢【由舊到新，最右為當根，含交叉事件】': recent,
            'K值近4根趨勢方向': `${kdTrend}（${kSlice.map(v => v?.toFixed(1)).join(' → ')}）`,
            [`各條件達成狀態【共${ev.items.length}項，✅${passCount}達標 ❌${failCount}未達標】`]: itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}

      </div>
    `;
  },
};

// ── helper：KD 行動指引列 ──
function _kdActionRows(ev) {
  const r = ev.raw;
  const sig = ev.signal.name;
  const fmt = v => v?.toFixed(1) ?? '—';

  if (sig === '低檔黃金交叉') {
    return [
      { label: '進場建議', detail: `<strong>可積極進場</strong>。超賣 + 黃金交叉是 KD 最高信心訊號，可進 50~70% 部位` },
      { label: '加碼條件', detail: `K 值站穩 50 以上且持續上行時，可補足剩餘部位` },
      { label: '停損設置', detail: `K 值在 20 以下再次死亡交叉 → 認賠出場，勿攤平` },
      { label: '注意事項', detail: `即使黃金交叉，若大盤處於空頭趨勢，勝率會打折。建議同步確認 MACD / 均線多頭排列` },
    ];
  }
  if (sig === '高檔死亡交叉') {
    return [
      { label: '操作建議', detail: `<strong>建議減碼或出場</strong>。超買 + 死亡交叉為 KD 最高空頭訊號` },
      { label: '反彈壓力', detail: `若出現反彈，K 值回升到 70~80 附近常有二次死叉，是再次減碼機會` },
      { label: '停損設置', detail: `持空單若 K 值在 80 以上黃金交叉，應立即停損` },
      { label: '注意事項', detail: `強勢股鈍化時，高檔死叉可能出現多次。確認 K 值低於 70 後再確認訊號有效` },
    ];
  }
  if (sig === '黃金交叉') {
    return [
      { label: '進場建議', detail: `可試單 30% 部位，<strong>非超賣區的黃金交叉需多重確認</strong>（量能 / MACD / 均線）` },
      { label: '加碼條件', detail: `K 值站穩 50 以上，且量能配合放大` },
      { label: '停損設置', detail: `K 值再度下穿 D 值（死亡交叉）即出場` },
      { label: '注意事項', detail: `中性區黃金交叉假訊號較多，保守設小部位。等待 K 值成功站上 50 再加碼` },
    ];
  }
  if (sig === '死亡交叉') {
    return [
      { label: '操作建議', detail: `謹慎持多，<strong>非超買區的死亡交叉</strong>需搭配其他指標確認，不必急著出場` },
      { label: '觀察重點', detail: `K 值是否跌破 50，若跌破 50 + 均線空頭排列才考慮減碼` },
      { label: '停損設置', detail: `K 值跌破 20（超賣區）且無止跌跡象 → 不可死抱攤平` },
      { label: '注意事項', detail: `多頭趨勢中的死叉常只是回調，等回到 50 附近再評估方向` },
    ];
  }
  if (sig === '多頭動能') {
    return [
      { label: '操作建議', detail: `維持多頭部位，<strong>K > D 動能持續中</strong>，不宜因短線震盪提早出場` },
      { label: '加碼條件', detail: `K 值維持在 50 以上且繼續走揚，可小量加碼` },
      { label: '觀察重點', detail: `K 值接近 80 時留意高檔鈍化 / 死叉出現` },
      { label: '注意事項', detail: `無明確交叉訊號，以趨勢為主，KD 作為輔助判斷` },
    ];
  }
  // 空頭動能 / 中性整理
  return [
    { label: '操作建議', detail: `觀望為主，等待 <strong>K < 20 的超賣黃金交叉</strong>出現再評估進場` },
    { label: '加碼條件', detail: `目前不建議進場；若 K 值回升站上 50 + 黃金交叉，再重新評估` },
    { label: '觀察重點', detail: `K 值是否跌向 20 超賣區，越接近 20 反彈訊號可靠性越高` },
    { label: '注意事項', detail: `空頭動能中不宜逆勢進場。等 KD 訊號轉多再動作` },
  ];
}

registerAnalysisModule(KDModule);
