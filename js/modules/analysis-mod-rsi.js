/* js/modules/analysis-mod-rsi.js
 * 🌟 RSI Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcRSI } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const RSIModule = {
  id: 'rsi',
  name: 'RSI 相對強弱指標',
  icon: '🌀',
  candleMinLen: 20,

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const rsiArr = calcRSI(closes);

    // 找最後一個有效值
    let lastIdx = n - 1;
    while (lastIdx > 0 && rsiArr[lastIdx] === null) lastIdx--;
    const lastRSI = rsiArr[lastIdx];
    const prevRSI = rsiArr[lastIdx - 1] ?? lastRSI;
    const rsiMomentum = lastRSI - prevRSI;
    const lastClose = closes[n - 1];

    // 近 5 根的 RSI 斜率（線性回歸）
    const recentRsi = rsiArr.slice(-5).filter(v => v !== null);
    const avgSlope = recentRsi.length >= 2
      ? (recentRsi[recentRsi.length - 1] - recentRsi[0]) / (recentRsi.length - 1)
      : 0;

    // 背離偵測（近 10 根）
    const window = 10;
    const startIdx = Math.max(lastIdx - window, 0);
    let priceLow = Infinity, priceHigh = -Infinity;
    let rsiAtLow = lastRSI, rsiAtHigh = lastRSI;
    for (let i = startIdx; i < lastIdx; i++) {
      if (rsiArr[i] === null) continue;
      if (closes[i] < priceLow)  { priceLow = closes[i];  rsiAtLow  = rsiArr[i]; }
      if (closes[i] > priceHigh) { priceHigh = closes[i]; rsiAtHigh = rsiArr[i]; }
    }
    const bullDivergence = lastClose < priceLow  && lastRSI > rsiAtLow;   // 底背離
    const bearDivergence = lastClose > priceHigh && lastRSI < rsiAtHigh;  // 頂背離

    const items = [];

    // ── 條件 1：RSI 位置 ──
    if (lastRSI >= 70) {
      items.push({
        ok: false,
        text: `<strong>超買區</strong>：RSI ${lastRSI.toFixed(1)}（≥ 70）`,
        sub: `相對強弱指數偏高，短線過熱，留意回檔風險`,
        whyTitle: '為什麼 RSI 超買要小心？',
        why: 'RSI(14) > 70 代表過去 14 日平均漲幅遠超過跌幅。短線買盤過熱，理論上需要「消化」（整理或回檔）才能繼續上攻。但強多頭可讓 RSI 在 70~85 之間持續數週，不宜單靠 RSI 超買就賣出。',
      });
    } else if (lastRSI <= 30) {
      items.push({
        ok: true,
        text: `<strong>超賣區</strong>：RSI ${lastRSI.toFixed(1)}（≤ 30）`,
        sub: `相對強弱指數偏低，短線過度拋售，反彈機率提升`,
        whyTitle: '為什麼 RSI 超賣是機會？',
        why: 'RSI < 30 代表近期跌幅遠超過漲幅，短線賣壓過大。歷史上從超賣回升的反彈相當常見，但空頭趨勢中 RSI 可以長期在 30 以下（30~40 成為壓力）。確認止跌訊號（K 線低點不破）後才進場。',
      });
    } else if (lastRSI >= 50) {
      items.push({
        ok: true,
        text: `<strong>強勢區</strong>：RSI ${lastRSI.toFixed(1)}（50~70）`,
        sub: `多頭占優但未超買，趨勢健康延伸中`,
        whyTitle: 'RSI 在 50~70 代表什麼？',
        why: 'RSI 站穩 50 以上代表整體多頭動能持續，是趨勢多頭的「健康帶」。50 是多空分水嶺，站穩 50 是中線偏多的基本條件。60~70 是強勢不超買的最佳狀態，常見於好的上升趨勢中。',
      });
    } else {
      items.push({
        ok: false,
        text: `<strong>弱勢區</strong>：RSI ${lastRSI.toFixed(1)}（30~50）`,
        sub: `RSI 低於 50，空頭略占優，避免追多`,
        whyTitle: 'RSI 在 30~50 代表什麼？',
        why: 'RSI 跌破 50 代表近期跌幅開始超過漲幅，短中期動能偏空。這個區間不適合積極做多，等 RSI 重新站回 50 以上（確認動能反轉）再評估。',
      });
    }

    // ── 條件 2：RSI 動能方向 ──
    items.push({
      ok: rsiMomentum > 0,
      text: `<strong>動能方向</strong>：RSI ${rsiMomentum > 0 ? '↑ 持續走強' : rsiMomentum < 0 ? '↓ 開始回落' : '→ 持平'}`,
      sub: `本根 ${lastRSI.toFixed(1)} vs 前根 ${prevRSI.toFixed(1)}（變化 ${rsiMomentum > 0 ? '+' : ''}${rsiMomentum.toFixed(1)}）`,
      whyTitle: '為什麼看 RSI 動能方向？',
      why: 'RSI 的斜率（變化速度）往往比絕對數值更重要。高位 RSI 開始下滑 → 動能減弱，是先於死叉的早期警訊。超賣區的 RSI 開始回升 → 賣壓開始消化，是底部形成的早期確認。',
    });

    // ── 條件 3：50 線關口 ──
    const above50 = lastRSI >= 50;
    const prev50  = prevRSI >= 50;
    const crossed50Up   = !prev50 && above50;
    const crossed50Down = prev50  && !above50;
    items.push({
      ok: above50,
      text: crossed50Up   ? `<strong>突破 50 關口</strong>：RSI 由 ${prevRSI.toFixed(1)} 升破 50（動能反轉訊號）`
          : crossed50Down ? `<strong>跌破 50 關口</strong>：RSI 由 ${prevRSI.toFixed(1)} 跌破 50（空頭轉折）`
          : above50 ? `<strong>站穩 50 以上</strong>：RSI ${lastRSI.toFixed(1)}，多頭動能維持`
          :           `<strong>維持 50 以下</strong>：RSI ${lastRSI.toFixed(1)}，空頭動能持續`,
      sub: above50 ? '多空分水嶺上方，整體偏多' : '多空分水嶺下方，整體偏空',
      whyTitle: '為什麼 50 這麼重要？',
      why: 'RSI = 50 意味著過去 N 日平均漲幅 = 平均跌幅，是真正的多空均衡點。站穩 50 是中線多頭的基本條件；跌破 50 則空頭開始占優。RSI 突破 / 跌破 50 的時間點往往是中線轉折的確認訊號。',
    });

    // ── 條件 4：背離（近 10 根）──
    if (bullDivergence) {
      items.push({
        ok: true,
        text: `<strong>底背離</strong>：股價創新低但 RSI 不創新低`,
        sub: `股價低點 ${priceLow.toFixed(2)} vs RSI 低點 ${rsiAtLow.toFixed(1)}（近期 RSI ${lastRSI.toFixed(1)}）`,
        whyTitle: '為什麼底背離是買進訊號？',
        why: '股價創新低但 RSI 未跟著創新低，代表下跌力道減弱（新低是被少數極端賣盤推下去的）。背離是「動能先行價格」的表現，歷史上底背離後反彈機率高，是短線最可靠的買進訊號之一。',
      });
    } else if (bearDivergence) {
      items.push({
        ok: false,
        text: `<strong>頂背離</strong>：股價創新高但 RSI 不創新高`,
        sub: `股價高點 ${priceHigh.toFixed(2)} vs RSI 高點 ${rsiAtHigh.toFixed(1)}（近期 RSI ${lastRSI.toFixed(1)}）`,
        whyTitle: '為什麼頂背離是警訊？',
        why: '股價創新高但 RSI 未跟著創新高，代表上漲力道衰竭（新高是靠慣性推上去的）。頂背離後常出現較大幅度的回檔，是獲利了結或降低部位的訊號。',
      });
    }

    // ── 綜合訊號判定 ──
    let signal = null;
    let score  = 0;

    if (lastRSI <= 30 && bullDivergence) {
      signal = { name: '超賣底背離', icon: '🌀', stars: 5, desc: '超賣區 + 底背離，RSI 最強買進訊號，賣壓已衰竭，反彈可靠性極高。' };
      score = 5;
    } else if (lastRSI >= 70 && bearDivergence) {
      signal = { name: '超買頂背離', icon: '⚠️', stars: 5, desc: '超買區 + 頂背離，RSI 最強賣出訊號，漲力衰竭，建議大幅減碼。' };
      score = 1;
    } else if (bullDivergence) {
      signal = { name: '底背離', icon: '↗', stars: 4, desc: '股價新低但 RSI 不創新低，下跌動能衰竭，留意反彈訊號。' };
      score = 4;
    } else if (bearDivergence) {
      signal = { name: '頂背離', icon: '↘', stars: 2, desc: '股價新高但 RSI 不創新高，上漲動能衰竭，留意回檔。' };
      score = 2;
    } else if (lastRSI <= 30) {
      signal = { name: '超賣反彈', icon: '⚡', stars: 4, desc: '進入超賣區，歷史反彈機率高。等止跌確認（K 線低點不破）再進場。' };
      score = 4;
    } else if (lastRSI >= 70) {
      signal = { name: '超買警示', icon: '🔴', stars: 2, desc: '進入超買區，短線過熱。強勢可鈍化，搭配死叉或量縮才確認頂部。' };
      score = 2;
    } else if (lastRSI >= 50 && avgSlope > 0) {
      signal = { name: '強勢上行', icon: '🔼', stars: 3, desc: 'RSI 站穩 50 以上且持續走強，多頭動能健康，趨勢延伸中。' };
      score = 3;
    } else if (lastRSI < 50 && avgSlope < 0) {
      signal = { name: '弱勢下行', icon: '🔽', stars: 2, desc: 'RSI 低於 50 且持續走弱，空頭動能持續，避免追多。' };
      score = 2;
    } else {
      signal = { name: '動能中性', icon: '⏸', stars: 2, desc: 'RSI 在 50 附近震盪，多空均衡，以大趨勢方向為主。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { lastRSI, prevRSI, rsiMomentum, avgSlope, bullDivergence, bearDivergence,
             priceLow, priceHigh, rsiAtLow, rsiAtHigh, lastClose, rsiArr, n },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = v => v?.toFixed(1) ?? '—';
    return [
      { id: 'rsi', name: '🟣 RSI(14)', value: fmt(ev.raw.lastRSI), color: '#a78bfa',
        tooltip: '相對強弱指數，14 日加權平均漲跌幅比值' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🌀 RSI</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">🌀</span>
        <span class="fs-title">RSI 相對強弱指標</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 20 根 K 線才能計算 RSI）</p>
      </div>`;
    }

    const r = ev.raw;
    const fmt = v => v?.toFixed(1) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';

    const actionRows = _rsiActionRows(ev);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🌀</span>
        <span class="fs-title">RSI 相對強弱指標</span>
        <span class="fs-subtitle">Relative Strength Index · RSI(14) 綜合判讀</span>
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
          <h4>📍 RSI 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(167,139,250,0.18);color:#c4b5fd">RSI(14)</span>
            <span class="fs-keylevel-price">${fmt(r.lastRSI)}</span>
            <span class="fs-keylevel-desc">${r.lastRSI >= 70 ? '🔴 超買區' : r.lastRSI <= 30 ? '🟢 超賣區' : r.lastRSI >= 50 ? '🔵 強勢區' : '⚪ 弱勢區'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(167,139,250,0.12);color:#c4b5fd">RSI 動能</span>
            <span class="fs-keylevel-price">${r.rsiMomentum > 0 ? '↑' : r.rsiMomentum < 0 ? '↓' : '→'} ${r.rsiMomentum > 0 ? '+' : ''}${r.rsiMomentum.toFixed(1)}</span>
            <span class="fs-keylevel-desc">本根 vs 前根</span>
          </div>
          ${r.bullDivergence ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(16,185,129,0.18);color:#6ee7b7">底背離</span>
            <span class="fs-keylevel-price" style="color:#34d399">偵測到</span>
            <span class="fs-keylevel-desc">股價 ${r.priceLow.toFixed(2)} 創低但 RSI ${r.rsiAtLow.toFixed(1)} 未創低</span>
          </div>` : ''}
          ${r.bearDivergence ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">頂背離</span>
            <span class="fs-keylevel-price" style="color:#ef4444">偵測到</span>
            <span class="fs-keylevel-desc">股價 ${r.priceHigh.toFixed(2)} 創高但 RSI ${r.rsiAtHigh.toFixed(1)} 未創高</span>
          </div>` : ''}
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
            <h4>━━━ 🌀 RSI 指標原理 ━━━</h4>
            <p><strong>公式</strong>：RSI = 100 − 100 / (1 + RS)</p>
            <p><strong>RS</strong> = N 日平均漲幅 / N 日平均跌幅（本系統使用 N=14）</p>
            <p style="margin-top:8px">RSI 的本質是「過去 N 日，買方力道占總波動的比例」。RSI=70 代表買方力道占 70%；RSI=30 代表賣方力道占 70%。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🎯 四大關鍵區間 ━━━</h4>
            <ul>
              <li><strong>RSI ≥ 70（超買）</strong>：短線過熱，留意回檔。強多頭鈍化可達 80~90</li>
              <li><strong>RSI 50~70（強勢）</strong>：多頭健康帶，趨勢延伸時維持在此區間</li>
              <li><strong>RSI 30~50（弱勢）</strong>：空頭略占優，避免追多</li>
              <li><strong>RSI ≤ 30（超賣）</strong>：短線拋售過度，反彈機率高</li>
            </ul>
            <p style="margin-top:8px"><strong>50 分水嶺</strong>：RSI 站穩 50 以上 = 中線偏多基本條件；跌破 50 = 空頭開始占優</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚡ 背離（最可靠的進出場訊號）━━━</h4>
            <p><strong>底背離（買進訊號）</strong>：股價創新低，RSI 不創新低 → 下跌力道衰竭</p>
            <p><strong>頂背離（賣出訊號）</strong>：股價創新高，RSI 不創新高 → 上漲力道衰竭</p>
            <p style="margin-top:8px">背離的意義：「價格走在前面，動能走在後面」。當兩者方向不一致時，往往是動能先行反轉，不久後價格也會跟上。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>強趨勢鈍化</strong>：超買區可鈍化數週，不能只因 RSI>70 就賣</li>
              <li><strong>區間調整</strong>：空頭時 RSI 的超買點下修到 50~60；多頭時超賣點上移到 40~50</li>
              <li><strong>背離時間長</strong>：背離可以持續多根，不代表馬上反轉。需等確認訊號</li>
              <li><strong>不適合橫盤</strong>：盤整市 RSI 在 40~60 來回，訊號雜訊多，搭配 KD 看交叉更可靠</li>
            </ul>
          </div>

        </div>

        ${renderAISection('rsi', 'RSI 相對強弱指標', '🌀', ev, (() => {
          // 近5根走勢，標出50線穿越事件與區間
          const rsiSlice = r.rsiArr.slice(-5).filter(v => v !== null);
          const recent5 = rsiSlice.map((v, i) => {
            const prev = rsiSlice[i - 1];
            const zone = v >= 70 ? '超買' : v <= 30 ? '超賣' : v >= 50 ? '強勢' : '弱勢';
            const cross50 = (prev != null)
              ? (prev < 50 && v >= 50 ? ' 🔺升破50' : prev >= 50 && v < 50 ? ' 🔻跌破50' : '')
              : '';
            const label = i === rsiSlice.length - 1 ? '【當根】' : `【-${rsiSlice.length - 1 - i}根】`;
            return `${label}${v.toFixed(1)}(${zone})${cross50}`;
          }).join(' → ');

          // RSI 加速度（動能是否加快）
          const rLen = rsiSlice.length;
          const rsiAccel = rLen >= 3
            ? (rsiSlice[rLen-1] - rsiSlice[rLen-2]) - (rsiSlice[rLen-2] - rsiSlice[rLen-3])
            : 0;

          // 50 線以上連續根數 / 以下連續根數
          let above50Streak = 0, below50Streak = 0;
          for (let i = r.rsiArr.length - 1; i >= 0; i--) {
            if (r.rsiArr[i] === null) break;
            if (r.rsiArr[i] >= 50) { if (below50Streak > 0) break; above50Streak++; }
            else                   { if (above50Streak > 0) break; below50Streak++; }
          }
          const streakDesc = above50Streak > 0
            ? `連續 ${above50Streak} 根站穩50以上`
            : `連續 ${below50Streak} 根低於50`;

          return {
            'RSI(14)當前值': fmt(r.lastRSI),
            'RSI區間狀態【70超買/30超賣/50分水嶺】':
              r.lastRSI >= 70 ? `超買區（${fmt(r.lastRSI)}）` :
              r.lastRSI <= 30 ? `超賣區（${fmt(r.lastRSI)}）` :
              r.lastRSI >= 50 ? `強勢區（${fmt(r.lastRSI)}）` : `弱勢區（${fmt(r.lastRSI)}）`,
            'RSI動能方向【本根vs前根，正=走強，負=轉弱】': `${r.rsiMomentum > 0 ? '+' : ''}${r.rsiMomentum.toFixed(1)}（${r.rsiMomentum > 0 ? '↑走強' : r.rsiMomentum < 0 ? '↓轉弱' : '→持平'}）`,
            'RSI加速度【正=動能加速，負=動能減速/回頭】': `${rsiAccel > 0 ? '+' : ''}${rsiAccel.toFixed(1)}（${rsiAccel > 0 ? '加速走強' : rsiAccel < 0 ? '動能已在減速' : '等速'}）`,
            '50線持續狀態【連續根數】': streakDesc,
            '近5根RSI走勢【由舊到新，最右為當根，含穿越50事件與區間標示】': recent5,
            '底背離偵測【近10根，股價新低但RSI不創新低=買進訊號】': r.bullDivergence
              ? `✅ 偵測到：股價低點 ${r.priceLow.toFixed(2)} vs 當時RSI ${r.rsiAtLow.toFixed(1)}，當前RSI ${fmt(r.lastRSI)} 未創新低`
              : '未偵測到',
            '頂背離偵測【近10根，股價新高但RSI不創新高=賣出訊號】': r.bearDivergence
              ? `⚠️ 偵測到：股價高點 ${r.priceHigh.toFixed(2)} vs 當時RSI ${r.rsiAtHigh.toFixed(1)}，當前RSI ${fmt(r.lastRSI)} 未創新高`
              : '未偵測到',
            [`各條件達成狀態【共${ev.items.length}項，✅${ev.items.filter(i=>i.ok===true).length}達標 ❌${ev.items.filter(i=>i.ok===false).length}未達標】`]:
              ev.items.map((item, i) => {
                const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
                return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
              }).join(' | '),
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}

      </div>
    `;
  },
};

// ── helper：RSI 行動指引列 ──
function _rsiActionRows(ev) {
  const r = ev.raw;
  const sig = ev.signal.name;
  const fmt = v => v?.toFixed(1) ?? '—';

  if (sig === '超賣底背離') {
    return [
      { label: '進場建議', detail: `<strong>積極買進</strong>。超賣 + 底背離是 RSI 最高信心買進訊號，可進 50~70% 部位` },
      { label: '加碼條件', detail: `RSI 站回 50 以上 + 收盤站上前高 → 加碼至滿倉` },
      { label: '停損設置', detail: `股價再破前低（背離失效）→ 立即停損出場，不可攤平` },
      { label: '注意事項', detail: `背離確認後還需 1~3 根止跌 K 線才算真正反轉，不要在背離出現當根就重押` },
    ];
  }
  if (sig === '超買頂背離') {
    return [
      { label: '操作建議', detail: `<strong>大幅減碼</strong>。超買 + 頂背離是 RSI 最強賣出訊號，持多單應出清至少 70%` },
      { label: '反彈壓力', detail: `RSI 若反彈回升到 60~70 但再次下滑，是第二次出場機會` },
      { label: '停損設置', detail: `股價再破前高（背離失效）→ 停損空單，重新評估` },
      { label: '注意事項', detail: `頂背離後的跌幅通常較大，但時間可能有延遲。確認放量下跌再做空更安全` },
    ];
  }
  if (sig === '底背離') {
    return [
      { label: '進場建議', detail: `可試單 30% 部位，等 <strong>RSI 站回 50</strong> 確認後再加碼` },
      { label: '加碼條件', detail: `RSI 站穩 50 + 股價日 K 站上 20MA → 補足部位` },
      { label: '停損設置', detail: `股價跌破背離前低（背離失效）→ 出場` },
      { label: '注意事項', detail: `非超賣區的底背離可靠性較低，保守操作，等更多確認訊號` },
    ];
  }
  if (sig === '超賣反彈') {
    return [
      { label: '進場建議', detail: `觀察止跌訊號後試單。<strong>RSI 超賣本身不是進場點</strong>，需等止跌 K 線確認` },
      { label: '加碼條件', detail: `RSI 回升站上 40 + 股價止跌 → 加碼，站上 50 → 滿倉` },
      { label: '停損設置', detail: `股價持續破新低且 RSI 繼續下滑 → 勿進場，空頭趨勢可能持續` },
      { label: '注意事項', detail: `空頭趨勢中 RSI 可以長期在 30 以下。沒有底背離的超賣反彈成功率偏低` },
    ];
  }
  if (sig === '超買警示') {
    return [
      { label: '操作建議', detail: `持多單留倉但<strong>不追高</strong>。留意 RSI 是否出現頂背離或從高位回彎` },
      { label: '減碼時機', detail: `RSI 從超買區開始下滑（出現頂背離 or KD 死叉）→ 減碼 30~50%` },
      { label: '停損設置', detail: `RSI 快速跌破 60 + 帶量跌 → 大幅減碼` },
      { label: '注意事項', detail: `強勢股鈍化時，RSI 可在 70~85 間橫行。沒有頂背離前不要輕易全出` },
    ];
  }
  if (sig === '強勢上行') {
    return [
      { label: '操作建議', detail: `<strong>持多留倉</strong>，趨勢健康，不宜因短線震盪提早出場` },
      { label: '加碼條件', detail: `RSI 維持 60 以上且有底部不斷墊高的走勢，可分批加碼` },
      { label: '觀察重點', detail: `留意 RSI 是否接近 70 超買、是否出現頂背離` },
      { label: '注意事項', detail: `強勢上行最怕急漲後的頂背離，定期確認股價與 RSI 是否同步創高` },
    ];
  }
  // 弱勢下行 / 動能中性
  return [
    { label: '操作建議', detail: `觀望為主，等 <strong>RSI 站回 50 以上</strong>再評估進場` },
    { label: '進場條件', detail: `RSI 重新站上 50 + 股價站上 20MA → 可考慮試單` },
    { label: '觀察重點', detail: `RSI 是否接近 30 超賣區，越靠近 30 反彈機率越高` },
    { label: '注意事項', detail: `RSI 在 50 以下不宜積極做多。先等方向明確再行動` },
  ];
}

registerAnalysisModule(RSIModule);
