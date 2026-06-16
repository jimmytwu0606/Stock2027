/* js/modules/analysis-mod-vprofile.js
 * 📊 Volume Profile（成交量分佈 / POC / Value Area）教學模組 — T-4
 * 量堆積的價位 = 真實籌碼成本密集區，比趨勢線更可靠的支撐壓力。
 * 主圖由「📊 分價量」overlay 呈現；本 Tab 隨該開關顯示。
 */
import { AppState } from '../state.js';
import { calcVolumeProfile } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

const VP_LOOKBACK = 120;

const VProfileModule = {
  id: 'vprofile',
  name: '量價分佈',
  icon: '📊',
  candleMinLen: 1,   // 讀 2 年日K（window.__taDaily），不綁圖表週期

  evaluate(candles) {
    const _code = AppState.activeCode || '';
    if (window.__taDaily?.code === _code && window.__taDaily.candles?.length) {
      candles = window.__taDaily.candles;
    }
    const vp = calcVolumeProfile(candles, VP_LOOKBACK);
    if (!vp.ready) return { score: 3, signal: null, items: [], raw: null };

    const lastC = candles[candles.length - 1].close;
    const todayRed = (() => {
      const c = candles[candles.length - 1];
      return c.close >= c.open;   // 台股紅 = 收 ≥ 開
    })();

    const abovePOC = lastC > vp.poc;
    const inVA     = lastC >= vp.val && lastC <= vah(vp);
    const pocDistPct = (lastC - vp.poc) / vp.poc * 100;
    const nearPOC  = Math.abs(pocDistPct) <= 2;
    // 最近的 HVN（量牆）
    let nearestHVN = null, hvnDist = Infinity;
    for (const h of vp.hvn) { const d = Math.abs(h - lastC); if (d < hvnDist) { hvnDist = d; nearestHVN = h; } }
    const hvnPct = nearestHVN != null ? Math.abs(nearestHVN - lastC) / lastC * 100 : null;

    const items = [];
    items.push({ ok: abovePOC,
      text: abovePOC
        ? `<strong>站在 POC 之上</strong>：收盤 ${lastC.toFixed(2)} > POC ${vp.poc.toFixed(2)}（+${pocDistPct.toFixed(1)}%）`
        : `<strong>位於 POC 之下</strong>：收盤 ${lastC.toFixed(2)} < POC ${vp.poc.toFixed(2)}（${pocDistPct.toFixed(1)}%）`,
      sub: `POC = 近 ${vp.lookback} 日成交量最密集的價位（換手最多 = 主力成本帶）`,
      whyTitle: 'POC 代表什麼？',
      why: 'POC（Point of Control）是回看期內成交量最大的價位，代表最多籌碼換手、多空認同度最高的「公平價」。價格站上 POC = 上方套牢盤少、籌碼乾淨；跌破 POC = 上方一堆解套賣壓，反彈遇阻。它是用真實成交量堆出來的支撐壓力，比趨勢線可靠。',
    });

    items.push({ ok: inVA,
      text: inVA
        ? `<strong>位於價值區內</strong>：VA [${vp.val.toFixed(2)} ~ ${vah(vp).toFixed(2)}]`
        : lastC > vah(vp)
          ? `<strong>高於價值區</strong>：突破 VAH ${vah(vp).toFixed(2)}，進入低量區`
          : `<strong>低於價值區</strong>：跌破 VAL ${vp.val.toFixed(2)}，進入低量區`,
      sub: 'Value Area = 涵蓋 70% 成交量的價帶，多空主戰場',
      whyTitle: '價值區（VA）的意義',
      why: 'VA 包住 70% 的成交量，是「合理價」區間。價格在 VA 內 = 區間震盪；突破 VAH 或跌破 VAL 進入低量區 = 脫離平衡，常伴隨趨勢啟動（上方無套牢壓力 / 下方無接手）。',
    });

    if (nearPOC) {
      items.push({ ok: todayRed,
        text: `<strong>逼近 POC 量區</strong>：距 POC 僅 ${Math.abs(pocDistPct).toFixed(1)}%${todayRed ? '，今日紅K' : ''}`,
        sub: todayRed ? '回測量區支撐 + 今日收紅 = 支撐確認訊號' : '貼近量區，留意是支撐還是壓力',
        whyTitle: '量區支撐確認',
        why: '回檔到 POC 量牆且當日收紅，代表密集成本區有買盤承接，是經典的量區支撐確認；反之貼著 POC 但收黑，量區可能由支撐轉壓力。',
      });
    }

    if (hvnPct != null && hvnPct <= 3) {
      items.push({ ok: true,
        text: `<strong>貼近量牆（HVN）</strong>：${nearestHVN.toFixed(2)}（距 ${hvnPct.toFixed(1)}%）`,
        sub: '高量節點 = 強支撐/壓力，價格常在此停頓或反轉',
        whyTitle: 'HVN 量牆',
        why: 'HVN（High Volume Node）是局部成交量高峰，大量籌碼堆積處。價格接近 HVN 容易停頓、震盪或反轉——上漲遇 HVN 是壓力、下跌遇 HVN 是支撐。',
      });
    }

    let signal, score;
    if (nearPOC && todayRed) {
      signal = { name: '量區支撐', icon: '📊', stars: 4, desc: '回測 POC 量牆且收紅，密集成本區買盤承接。' }; score = 4;
    } else if (abovePOC && lastC > vah(vp)) {
      signal = { name: '突破價值區', icon: '🔴', stars: 4, desc: '站上 POC 並突破 VAH，上方低套牢，籌碼乾淨。' }; score = 4;
    } else if (abovePOC) {
      signal = { name: 'POC 之上', icon: '🟢', stars: 4, desc: '收盤站在 POC 上方，籌碼相對乾淨，偏多。' }; score = 4;
    } else if (!abovePOC && lastC < vp.val) {
      signal = { name: '跌破價值區', icon: '🟢', stars: 2, desc: '跌破 VAL 進入下方低量區，上有套牢壓力。' }; score = 2;
    } else {
      signal = { name: 'POC 之下', icon: '🟡', stars: 3, desc: '位於 POC 下方，上方套牢盤多，反彈遇阻。' }; score = 3;
    }

    return { score, signal, items,
      raw: { poc: vp.poc, val: vp.val, vah: vah(vp), lastC, abovePOC, inVA, pocDistPct, nearPOC, todayRed,
             nearestHVN, hvnPct, hvnCount: vp.hvn.length, lvnCount: vp.lvn.length, lookback: vp.lookback } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'vp-poc', name: '📊 POC',
        value: ev.raw.poc?.toFixed(2) ?? '—',
        color: '#f59e0b',
        tooltip: 'Point of Control：成交量最密集價位（主力成本帶）' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📊 量價分佈</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">📊</span><span class="fs-title">量價分佈</span></div>
      <div class="fs-deep-module-body"><p style="color:var(--muted);padding:8px 4px 14px">資料不足（建議切 1 年取完整 hist）。</p><div class="fs-teach"><div class="fs-teach-section"><h4>━━━ 📊 這是什麼 ━━━</h4><p>量價分佈把回看期內<strong>每個價位成交了多少量</strong>橫向堆出來，回答「籌碼卡在哪些價位」。<strong>POC</strong>=量最大的價位（多空最認同的公平價、主力成本帶）；<strong>Value Area</strong>=涵蓋 70% 量的價帶（合理價區間）；<strong>HVN 量牆</strong>=強支撐/壓力、<strong>LVN 真空帶</strong>=價格易快速通過。站上 POC=籌碼乾淨偏多、跌破=上方套牢壓力重，是用真實成交量堆出的支撐壓力，比趨勢線可靠。</p></div></div></div>`;

    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';
    const pocColor = r.abovePOC ? '#ef5350' : '#26a69a';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📊</span>
        <span class="fs-title">Volume Profile（量價分佈）</span>
        <span class="fs-subtitle">POC · Value Area · 量牆支撐壓力（近 ${r.lookback} 日）</span>
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
          <h4>📍 關鍵量價位</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(245,158,11,0.18);color:#f59e0b">POC</span>
            <span class="fs-keylevel-price" style="color:${pocColor}">${fmt(r.poc)}</span>
            <span class="fs-keylevel-desc">成本最密集價位，現價${r.abovePOC ? '在其上方（籌碼乾淨）' : '在其下方（上有套牢）'}（${r.pocDistPct >= 0 ? '+' : ''}${r.pocDistPct.toFixed(1)}%）</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(96,165,250,0.18);color:#60a5fa">Value Area</span>
            <span class="fs-keylevel-price" style="color:#60a5fa">${fmt(r.val)} ~ ${fmt(r.vah)}</span>
            <span class="fs-keylevel-desc">涵蓋 70% 成交量的價帶；現價${r.inVA ? '在區內（震盪）' : r.lastC > r.vah ? '突破上緣（脫離平衡）' : '跌破下緣（脫離平衡）'}</span>
          </div>
          ${r.nearestHVN != null ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">最近量牆</span>
            <span class="fs-keylevel-price" style="color:#ef4444">${fmt(r.nearestHVN)}</span>
            <span class="fs-keylevel-desc">高量節點（HVN）= 強支撐/壓力，距現價 ${r.hvnPct?.toFixed(1)}%</span>
          </div>` : ''}
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 📊 量價分佈是什麼 ━━━</h4>
            <p>把回看期內每個價位「成交了多少量」橫向堆出來，就是 Volume Profile。它回答一個關鍵問題：<strong>籌碼到底卡在哪些價位</strong>。</p>
            <ul>
              <li><strong>POC</strong>（控制點）：量最大的價位 = 多空最認同的公平價、主力成本帶</li>
              <li><strong>Value Area（VA）</strong>：涵蓋 70% 量的價帶 = 合理價區間（VAH 上緣 / VAL 下緣）</li>
              <li><strong>HVN 量牆</strong>：局部量峰 = 強支撐/壓力；<strong>LVN 真空帶</strong>：局部量谷 = 價格易快速通過</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 怎麼用 ━━━</h4>
            <ul>
              <li><strong>POC 當支撐壓力</strong>：站上 POC 上方=籌碼乾淨偏多；跌破=上方套牢壓力重</li>
              <li><strong>回測 POC 收紅</strong>：密集成本區買盤承接 = 量區支撐確認，是進場參考</li>
              <li><strong>突破 VAH / 跌破 VAL</strong>：脫離平衡進入低量區，常是趨勢啟動訊號</li>
              <li><strong>真空帶（LVN）快速通過</strong>：價格進入低量區易快速移動，不易停留</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>日K是近似口徑</strong>：真正的 VP 需逐筆（tick）資料，日K版把每根量均攤到 [低,高]，形狀近似但 POC 價位通常足夠準</li>
              <li><strong>回看期影響結果</strong>：本頁固定回看 ${VP_LOOKBACK} 日；不同回看期 POC 會移動</li>
              <li><strong>除權息會位移</strong>：價位採還原口徑，與盤面原始價可能有差</li>
            </ul>
          </div>
        </div>

        ${renderAISection('vprofile', 'Volume Profile 量價分佈', '📊', ev, {
          'POC控制點【主力成本帶/最強支撐壓力】': `${fmt(r.poc)}（現價${r.abovePOC ? '在上方' : '在下方'}，${r.pocDistPct >= 0 ? '+' : ''}${r.pocDistPct.toFixed(1)}%）`,
          '價值區VA【70%量帶】': `${fmt(r.val)} ~ ${fmt(r.vah)}（現價${r.inVA ? '區內' : r.lastC > r.vah ? '突破上緣' : '跌破下緣'}）`,
          '最近量牆HVN': r.nearestHVN != null ? `${fmt(r.nearestHVN)}（距 ${r.hvnPct?.toFixed(1)}%）` : '無明顯量牆',
          '量牆數/真空帶數': `${r.hvnCount} / ${r.lvnCount}`,
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>
    `;
  },
};

// VAH 取值（calcVolumeProfile 回 vah 鍵；此 helper 防呆）
function vah(vp) { return vp.vah; }

registerAnalysisModule(VProfileModule);
