/* js/modules/analysis-mod-macd.js
 * 🌟 MACD Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcMACD } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const MACDModule = {
  id: 'macd',
  name: 'MACD',
  icon: '📊',
  candleMinLen: 35,  // EMA26 + signal9 = 35 根才穩定

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const { dif, sigLine, hist } = calcMACD(closes);

    const lastDif  = dif[n - 1];
    const lastSig  = sigLine[n - 1];
    const lastHist = hist[n - 1];
    const prevDif  = dif[n - 2]  ?? lastDif;
    const prevSig  = sigLine[n - 2] ?? lastSig;
    const prevHist = hist[n - 2] ?? lastHist;
    const lastClose = closes[n - 1];

    // 近 3 根是否有黃金/死亡交叉
    let crossBull = false, crossBear = false;
    for (let i = Math.max(1, n - 3); i < n; i++) {
      if (dif[i - 1] <= sigLine[i - 1] && dif[i] > sigLine[i]) crossBull = true;
      if (dif[i - 1] >= sigLine[i - 1] && dif[i] < sigLine[i]) crossBear = true;
    }

    // 柱狀體連續擴張/收縮根數
    let histExpand = 0, histShrink = 0;
    for (let i = n - 1; i >= 1; i--) {
      const cur  = Math.abs(hist[i]);
      const prev = Math.abs(hist[i - 1]);
      if (cur > prev) { if (histShrink > 0) break; histExpand++; }
      else if (cur < prev) { if (histExpand > 0) break; histShrink++; }
      else break;
    }

    // 背離偵測（近 12 根）
    const window = 12;
    const startIdx = Math.max(0, n - window - 1);
    let priceLow = Infinity, priceHigh = -Infinity;
    let difAtLow = lastDif, difAtHigh = lastDif;
    for (let i = startIdx; i < n - 1; i++) {
      if (closes[i] < priceLow)  { priceLow = closes[i];  difAtLow  = dif[i]; }
      if (closes[i] > priceHigh) { priceHigh = closes[i]; difAtHigh = dif[i]; }
    }
    const bullDiv = lastClose < priceLow  && lastDif > difAtLow;
    const bearDiv = lastClose > priceHigh && lastDif < difAtHigh;

    // 零軸位置
    const aboveZero = lastDif > 0;
    const histDir   = lastHist > prevHist ? 'up' : lastHist < prevHist ? 'down' : 'flat';

    const items = [];

    // ── 條件 1：DIF vs DEA 排列 ──
    items.push({
      ok: lastDif > lastSig,
      text: lastDif > lastSig
        ? `<strong>多頭排列</strong>：DIF（${lastDif.toFixed(3)}）> DEA（${lastSig.toFixed(3)}）`
        : `<strong>空頭排列</strong>：DIF（${lastDif.toFixed(3)}）< DEA（${lastSig.toFixed(3)}）`,
      sub: `差距 ${(lastDif - lastSig).toFixed(3)}，柱狀體${lastHist > 0 ? '紅柱（多頭）' : '綠柱（空頭）'}`,
      whyTitle: '為什麼 DIF > DEA 是多頭？',
      why: 'DIF（快線）由 EMA12 - EMA26 得出，DEA（慢線/訊號線）為 DIF 的 9 日 EMA。DIF 在 DEA 上方代表短期均線持續優於中期，多頭動能占優。DIF 上穿 DEA 稱為黃金交叉，是 MACD 最核心的買進訊號。',
    });

    // ── 條件 2：零軸位置 ──
    items.push({
      ok: aboveZero,
      text: aboveZero
        ? `<strong>零軸上方</strong>：DIF ${lastDif.toFixed(3)} > 0（中長期多頭區）`
        : `<strong>零軸下方</strong>：DIF ${lastDif.toFixed(3)} < 0（中長期空頭區）`,
      sub: aboveZero ? 'EMA12 > EMA26，中長期趨勢偏多' : 'EMA12 < EMA26，中長期趨勢偏空',
      whyTitle: '為什麼零軸這麼重要？',
      why: 'DIF 的正負號反映 EMA12 與 EMA26 的相對位置。DIF > 0 代表短期均線在中期均線之上，中長期趨勢偏多。零軸上的黃金交叉比零軸下的交叉可靠性更高，稱為「強勢區交叉」。',
    });

    // ── 條件 3：柱狀體方向（動能）──
    items.push({
      ok: histDir === 'up',
      text: histDir === 'up'
        ? `<strong>柱狀體擴張</strong>：動能${lastHist > 0 ? '持續增強（紅柱放大）' : '空頭減弱（綠柱縮小）'}`
        : histDir === 'down'
        ? `<strong>柱狀體收縮</strong>：動能${lastHist > 0 ? '多頭衰退（紅柱縮小）' : '空頭持續（綠柱放大）'}`
        : `<strong>柱狀體持平</strong>：動能等速`,
      sub: `當前柱 ${lastHist.toFixed(3)}，前根 ${prevHist.toFixed(3)}（變化 ${(lastHist - prevHist) > 0 ? '+' : ''}${(lastHist - prevHist).toFixed(3)}）`,
      whyTitle: '為什麼柱狀體方向重要？',
      why: 'MACD 柱狀體（Histogram）= DIF - DEA，反映兩線差距的變化速度。柱狀體由小變大代表動能加速（趨勢確立）；由大變小代表動能衰退（趨勢可能轉折）。柱狀體轉向往往比 DIF/DEA 交叉早出現 1~2 根。',
    });

    // ── 條件 4：交叉訊號（近 3 根）──
    if (crossBull) {
      items.push({
        ok: true,
        text: `<strong>黃金交叉</strong>：近 3 根 DIF 上穿 DEA`,
        sub: `DIF 由下穿越 DEA 向上，${aboveZero ? '零軸上方發生，強勢訊號' : '零軸下方發生，需多重確認'}`,
        whyTitle: '為什麼 MACD 黃金交叉是買點？',
        why: 'DIF 上穿 DEA 代表短期動能開始超越中期，是趨勢反轉向上的確認訊號。零軸上方發生的黃金交叉（強勢區）可靠度最高；零軸下方（弱勢區）的交叉需搭配 KD/RSI 或成交量確認。',
      });
    } else if (crossBear) {
      items.push({
        ok: false,
        text: `<strong>死亡交叉</strong>：近 3 根 DIF 下穿 DEA`,
        sub: `DIF 由上穿越 DEA 向下，${aboveZero ? '零軸上方發生，回檔訊號' : '零軸下方發生，空頭加速'}`,
        whyTitle: '為什麼 MACD 死亡交叉是賣點？',
        why: 'DIF 下穿 DEA 代表短期動能開始弱於中期，是趨勢反轉向下的確認訊號。零軸下方的死亡交叉（弱勢區）空頭延伸可能性高；零軸上方（強勢區）的死亡交叉常是短暫回調，不一定是趨勢反轉。',
      });
    }

    // ── 條件 5：背離 ──
    if (bullDiv) {
      items.push({
        ok: true,
        text: `<strong>底背離</strong>：股價創新低但 DIF 不創新低`,
        sub: `股價低點 ${priceLow.toFixed(2)} vs DIF 低點 ${difAtLow.toFixed(3)}，當前 DIF ${lastDif.toFixed(3)}`,
        whyTitle: '為什麼 MACD 底背離可靠？',
        why: 'MACD 底背離代表下跌趨勢的動能衰竭。股價雖然創新低，但 DIF 不再創新低，說明賣壓已在萎縮。MACD 背離比 KD/RSI 背離更穩定（因為 DIF 是雙重平滑），假訊號較少，是中線布局的重要參考。',
      });
    } else if (bearDiv) {
      items.push({
        ok: false,
        text: `<strong>頂背離</strong>：股價創新高但 DIF 不創新高`,
        sub: `股價高點 ${priceHigh.toFixed(2)} vs DIF 高點 ${difAtHigh.toFixed(3)}，當前 DIF ${lastDif.toFixed(3)}`,
        whyTitle: '為什麼 MACD 頂背離是警訊？',
        why: 'MACD 頂背離代表上漲趨勢動能衰竭。股價雖然創新高，DIF 卻不跟著創高，說明買盤力道逐漸萎縮。相比 KD/RSI，MACD 的頂背離發出較晚但更可靠，常出現在主升段末段。',
      });
    }

    // ── 綜合訊號判定 ──
    let signal, score;
    const c1 = lastDif > lastSig;   // 多頭排列
    const c2 = aboveZero;            // 零軸上方

    if (c1 && c2 && crossBull) {
      signal = { name: '強勢黃金交叉', icon: '📊', stars: 5,
        desc: '零軸上方 + DIF>DEA + 黃金交叉，MACD 最強多頭訊號，趨勢明確向上。' };
      score = 5;
    } else if (!c1 && !c2 && crossBear) {
      signal = { name: '弱勢死亡交叉', icon: '📉', stars: 1,
        desc: '零軸下方 + DIF<DEA + 死亡交叉，空頭延伸訊號，避免追多。' };
      score = 1;
    } else if (bullDiv) {
      signal = { name: '底背離', icon: '↗', stars: 4,
        desc: '股價新低但 DIF 不創新低，下跌動能衰竭，留意反轉機會。' };
      score = 4;
    } else if (bearDiv) {
      signal = { name: '頂背離', icon: '↘', stars: 2,
        desc: '股價新高但 DIF 不創新高，上漲動能衰竭，注意回檔風險。' };
      score = 2;
    } else if (crossBull) {
      signal = { name: '黃金交叉', icon: '✨', stars: 4,
        desc: 'DIF 上穿 DEA，短期動能反轉向上。零軸下方交叉需多重確認。' };
      score = 4;
    } else if (crossBear) {
      signal = { name: '死亡交叉', icon: '⚡', stars: 2,
        desc: 'DIF 下穿 DEA，短期動能反轉向下。零軸上方交叉常為短暫回調。' };
      score = 2;
    } else if (c1 && c2 && histDir === 'up') {
      signal = { name: '多頭擴張', icon: '🔼', stars: 3,
        desc: '零軸上方 + 多頭排列 + 柱狀體擴張，趨勢強勁延伸中。' };
      score = 3;
    } else if (!c1 && !c2 && histDir === 'down') {
      signal = { name: '空頭擴張', icon: '🔽', stars: 2,
        desc: '零軸下方 + 空頭排列 + 柱狀體擴大，空頭趨勢持續。' };
      score = 2;
    } else if (c1) {
      signal = { name: '多頭動能', icon: '🔵', stars: 3,
        desc: 'DIF > DEA 多頭排列，動能偏多，無明確交叉訊號。' };
      score = 3;
    } else {
      signal = { name: '空頭動能', icon: '⚪', stars: 2,
        desc: 'DIF < DEA 空頭排列，動能偏空，等待訊號確認。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: {
        lastDif, lastSig, lastHist, prevDif, prevSig, prevHist,
        crossBull, crossBear, aboveZero, histDir,
        histExpand, histShrink, bullDiv, bearDiv,
        priceLow, priceHigh, difAtLow, difAtHigh,
        lastClose, dif, sigLine, hist, n,
      },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt4 = v => v?.toFixed(3) ?? '—';
    return [
      { id: 'macd-dif', name: '🟡 DIF',  value: fmt4(ev.raw.lastDif),  color: '#f59e0b',
        tooltip: 'EMA12 - EMA26，快線，反應靈敏' },
      { id: 'macd-dea', name: '🔴 DEA',  value: fmt4(ev.raw.lastSig),  color: '#ef4444',
        tooltip: 'DIF 的 9 日 EMA，慢線/訊號線' },
      { id: 'macd-hist', name: '📊 Hist', value: fmt4(ev.raw.lastHist), color: ev.raw.lastHist >= 0 ? '#ef5350' : '#26a69a',
        tooltip: 'DIF - DEA，柱狀體，反映動能強弱' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📊 MACD</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">📊</span>
        <span class="fs-title">MACD</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 35 根 K 線才能計算 MACD）</p>
      </div>`;
    }

    const r = ev.raw;
    const fmt  = v => v?.toFixed(2)  ?? '—';
    const fmt4 = v => v?.toFixed(3)  ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📊</span>
        <span class="fs-title">MACD</span>
        <span class="fs-subtitle">指數平滑異同移動平均線 · (12,26,9) 綜合判讀</span>
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
          <h4>📍 MACD 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(245,158,11,0.18);color:#fbbf24">DIF</span>
            <span class="fs-keylevel-price">${fmt4(r.lastDif)}</span>
            <span class="fs-keylevel-desc">${r.aboveZero ? '🔵 零軸上方（多頭區）' : '🔴 零軸下方（空頭區）'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,68,68,0.18);color:#fca5a5">DEA</span>
            <span class="fs-keylevel-price">${fmt4(r.lastSig)}</span>
            <span class="fs-keylevel-desc">訊號線 · DIF-DEA = ${fmt4(r.lastHist)}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(${r.lastHist >= 0 ? '239,83,80' : '38,166,154'},0.18);color:${r.lastHist >= 0 ? '#fca5a5' : '#6ee7b7'}">柱狀體</span>
            <span class="fs-keylevel-price" style="color:${r.lastHist >= 0 ? '#ef5350' : '#26a69a'}">${fmt4(r.lastHist)}</span>
            <span class="fs-keylevel-desc">${r.histDir === 'up' ? '📈 擴張中' : r.histDir === 'down' ? '📉 收縮中' : '→ 持平'}${r.histExpand > 1 ? `　連續擴張 ${r.histExpand} 根` : r.histShrink > 1 ? `　連續收縮 ${r.histShrink} 根` : ''}</span>
          </div>
          ${r.bullDiv ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(16,185,129,0.18);color:#6ee7b7">底背離</span>
            <span class="fs-keylevel-price" style="color:#34d399">偵測到</span>
            <span class="fs-keylevel-desc">股價 ${fmt(r.priceLow)} 創低但 DIF ${fmt4(r.difAtLow)} 未創低</span>
          </div>` : ''}
          ${r.bearDiv ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">頂背離</span>
            <span class="fs-keylevel-price" style="color:#ef4444">偵測到</span>
            <span class="fs-keylevel-desc">股價 ${fmt(r.priceHigh)} 創高但 DIF ${fmt4(r.difAtHigh)} 未創高</span>
          </div>` : ''}
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_macdActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">

          <div class="fs-teach-section">
            <h4>━━━ 📊 MACD 指標原理 ━━━</h4>
            <p><strong>DIF（快線）</strong>：EMA12 − EMA26</p>
            <p><strong>DEA（慢線/訊號線）</strong>：DIF 的 9 日 EMA</p>
            <p><strong>柱狀體（Histogram）</strong>：DIF − DEA，反映兩線差距的擴大/縮小</p>
            <p style="margin-top:8px">MACD 是「趨勢 + 動能」的複合指標，不只告訴你方向，還告訴你速度。這是它比單純均線更有價值的原因。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🎯 四大核心訊號 ━━━</h4>
            <p><strong>📊 強勢黃金交叉（⭐⭐⭐⭐⭐）</strong>：零軸上方 DIF 上穿 DEA，最強多頭</p>
            <p><strong>✨ 黃金交叉（⭐⭐⭐⭐）</strong>：DIF 上穿 DEA，零軸下方需多重確認</p>
            <p><strong>↗ 底背離（⭐⭐⭐⭐）</strong>：股價新低但 DIF 不創新低，下跌動能衰竭</p>
            <p><strong>↘ 頂背離（⭐⭐）</strong>：股價新高但 DIF 不創新高，上漲動能衰竭</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚡ 柱狀體的隱藏訊息 ━━━</h4>
            <ul>
              <li><strong>柱狀體由小變大</strong>：動能加速，趨勢確立中</li>
              <li><strong>柱狀體由大變小</strong>：動能衰退，注意轉折</li>
              <li><strong>柱狀體轉向</strong>：往往比 DIF/DEA 交叉早 1~2 根出現，是「領先訊號」</li>
              <li><strong>紅柱縮短</strong>（多頭中）：多頭動能開始衰退，可先減碼</li>
              <li><strong>綠柱縮短</strong>（空頭中）：空頭動能開始衰退，可開始觀察反彈</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>滯後性</strong>：MACD 是雙重平滑指標，訊號比 KD 晚，但假訊號也少</li>
              <li><strong>盤整市失效</strong>：震盪盤中 DIF/DEA 來回交叉，雜訊多。用 KD/RSI 替代</li>
              <li><strong>零軸很重要</strong>：零軸上的訊號比零軸下可靠，不要把兩區的訊號同等對待</li>
              <li><strong>參數固定</strong>：(12,26,9) 是台股最常用標準。不同參數結果不同，換參數前請謹慎</li>
            </ul>
          </div>

        </div>

        ${renderAISection('macd', 'MACD 指數平滑異同移動平均線', '📊', ev, (() => {
          // 近5根柱狀體走勢
          const histSlice = r.hist.slice(-5);
          const recent5hist = histSlice.map((v, i) => {
            const label = i === 4 ? '【當根】' : `【-${4 - i}根】`;
            const dir = i > 0
              ? (Math.abs(v) > Math.abs(histSlice[i-1]) ? '↑擴' : Math.abs(v) < Math.abs(histSlice[i-1]) ? '↓縮' : '→')
              : '';
            return `${label}${v?.toFixed(3)??'—'}(${v >= 0 ? '紅' : '綠'}${dir})`;
          }).join(' → ');

          // DIF 近5根
          const difSlice = r.dif.slice(-5);
          const recentDif = difSlice.map((v, i) => {
            const label = i === 4 ? '【當根】' : `【-${4 - i}根】`;
            const cross = i > 0
              ? (r.sigLine[r.n - 5 + i - 1] >= difSlice[i-1] && r.sigLine[r.n - 5 + i] < v ? ' 🔺黃金交叉'
                : r.sigLine[r.n - 5 + i - 1] <= difSlice[i-1] && r.sigLine[r.n - 5 + i] > v ? ' 🔻死亡交叉' : '')
              : '';
            return `${label}DIF=${v?.toFixed(3)??'—'}${cross}`;
          }).join(' → ');

          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          const passCount = ev.items.filter(i => i.ok === true).length;
          const failCount = ev.items.filter(i => i.ok === false).length;

          return {
            'DIF【快線，EMA12-EMA26】': r.lastDif.toFixed(3),
            'DEA【慢線/訊號線，DIF的9日EMA】': r.lastSig.toFixed(3),
            'DIF-DEA差距【正=多頭排列，負=空頭排列】': `${(r.lastDif - r.lastSig) > 0 ? '+' : ''}${(r.lastDif - r.lastSig).toFixed(3)}`,
            '零軸位置【DIF正負決定中長期趨勢方向】': r.aboveZero ? `✅ 零軸上方（DIF=${r.lastDif.toFixed(3)}，多頭區）` : `❌ 零軸下方（DIF=${r.lastDif.toFixed(3)}，空頭區）`,
            '柱狀體當前值【正=紅柱多頭，負=綠柱空頭】': `${r.lastHist.toFixed(3)}（${r.lastHist >= 0 ? '紅柱' : '綠柱'}，${r.histDir === 'up' ? '擴張中' : r.histDir === 'down' ? '收縮中' : '持平'}）`,
            '柱狀體連續狀態': r.histExpand > 1 ? `連續擴張 ${r.histExpand} 根` : r.histShrink > 1 ? `連續收縮 ${r.histShrink} 根` : '無明顯連續',
            '近期交叉【黃金/死亡/無，近3根】': r.crossBull ? '近3根出現黃金交叉（DIF上穿DEA）' : r.crossBear ? '近3根出現死亡交叉（DIF下穿DEA）' : '近3根無交叉',
            '近5根柱狀體走勢【由舊到新，最右為當根，含擴縮標示】': recent5hist,
            '近5根DIF走勢【由舊到新，最右為當根，含交叉事件】': recentDif,
            '底背離偵測【近12根，股價新低但DIF不創新低=買進訊號】': r.bullDiv
              ? `✅ 偵測到：股價低點 ${r.priceLow.toFixed(2)} vs 當時DIF ${r.difAtLow.toFixed(3)}，當前DIF ${r.lastDif.toFixed(3)} 未創新低`
              : '未偵測到',
            '頂背離偵測【近12根，股價新高但DIF不創新高=賣出訊號】': r.bearDiv
              ? `⚠️ 偵測到：股價高點 ${r.priceHigh.toFixed(2)} vs 當時DIF ${r.difAtHigh.toFixed(3)}，當前DIF ${r.lastDif.toFixed(3)} 未創新高`
              : '未偵測到',
            [`各條件達成狀態【共${ev.items.length}項，✅${passCount}達標 ❌${failCount}未達標】`]: itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}

      </div>
    `;
  },
};

// ── helper：MACD 行動指引列 ──
function _macdActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;
  const fmt4 = v => v?.toFixed(3) ?? '—';

  if (sig === '強勢黃金交叉') {
    return [
      { label: '進場建議', detail: `<strong>積極進場</strong>。零軸上方黃金交叉是 MACD 最高信心訊號，可進 50~70% 部位` },
      { label: '加碼條件', detail: `柱狀體持續擴張（紅柱放大）且 DIF 持續走高，可補足剩餘部位` },
      { label: '停損設置', detail: `DIF 再度下穿 DEA（死亡交叉）→ 減碼；DIF 跌破零軸 → 出場` },
      { label: '注意事項', detail: `搭配 KD/RSI 超賣後反彈確認，勝率更高。避免在此訊號出現後立即追高` },
    ];
  }
  if (sig === '弱勢死亡交叉') {
    return [
      { label: '操作建議', detail: `<strong>避免進場，多單應出場</strong>。零軸下方死亡交叉空頭延伸機率高` },
      { label: '反彈壓力', detail: `DIF 若反彈回升到 DEA 附近（${fmt4(r.lastSig)}）但再次下穿，是第二次減碼機會` },
      { label: '停損設置', detail: `持空單若 DIF 黃金交叉 + 站回零軸，立即停損` },
      { label: '注意事項', detail: `弱勢區的背離（底背離）可能提前出現反轉訊號，需持續關注柱狀體是否開始收縮` },
    ];
  }
  if (sig === '底背離') {
    return [
      { label: '進場建議', detail: `可試單 30% 部位，等 <strong>DIF 黃金交叉</strong>確認後加碼` },
      { label: '加碼條件', detail: `DIF 上穿 DEA（黃金交叉）+ 柱狀體由綠轉紅 → 加碼至 60%` },
      { label: '停損設置', detail: `股價再破前低（背離失效）→ 立即停損，不可攤平` },
      { label: '注意事項', detail: `背離出現到實際反轉可能有 1~3 根延遲，不要在背離出現當根就重押` },
    ];
  }
  if (sig === '頂背離') {
    return [
      { label: '操作建議', detail: `<strong>開始減碼</strong>，持多單降低至 30~50%，等待死亡交叉確認後全出` },
      { label: '觀察重點', detail: `柱狀體是否開始收縮（紅柱由大變小）→ 動能衰退的早期信號` },
      { label: '停損設置', detail: `股價再破前高（背離失效）→ 停損空單，重新評估` },
      { label: '注意事項', detail: `頂背離後的跌幅通常較大，但時間可能延遲。確認死亡交叉後再做空更安全` },
    ];
  }
  if (sig === '黃金交叉') {
    return [
      { label: '進場建議', detail: `可試單 30%，<strong>零軸下方的黃金交叉需多重確認</strong>（KD 也黃金交叉或 RSI 站穩 50）` },
      { label: '加碼條件', detail: `DIF 站上零軸（由負轉正）+ 柱狀體持續擴張 → 加碼` },
      { label: '停損設置', detail: `DIF 再度死亡交叉 → 出場` },
      { label: '注意事項', detail: `弱勢區（零軸下方）的黃金交叉假訊號較多，保守設小部位` },
    ];
  }
  if (sig === '多頭擴張') {
    return [
      { label: '操作建議', detail: `<strong>持多留倉</strong>，零軸上方 + 柱狀體擴張是最健康的多頭狀態` },
      { label: '加碼條件', detail: `柱狀體連續擴張 3 根以上，可小量加碼` },
      { label: '觀察重點', detail: `柱狀體何時開始收縮（紅柱由大變小），那是動能衰退的早期警訊` },
      { label: '注意事項', detail: `多頭擴張階段不要因為短線震盪就提早出場，以趨勢為主` },
    ];
  }
  // 空頭擴張 / 多頭動能 / 空頭動能
  return [
    { label: '操作建議', detail: `觀望為主，等待 <strong>DIF 黃金交叉 + 柱狀體由綠轉紅</strong>再評估` },
    { label: '進場條件', detail: `DIF 黃金交叉 + 站上零軸 → 可考慮試單` },
    { label: '觀察重點', detail: `柱狀體是否開始收縮（空頭減弱）或擴張（多頭確立）` },
    { label: '注意事項', detail: `MACD 適合趨勢行情，震盪盤中訊號雜訊多，搭配 KD 看交叉更可靠` },
  ];
}

registerAnalysisModule(MACDModule);
