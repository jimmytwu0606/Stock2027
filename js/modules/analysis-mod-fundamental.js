/* js/modules/analysis-mod-fundamental.js
 * 🌟 Fundamental Golden Board Module
 * 基本面分析：EPS / 毛利率 / PE / PB / 殖利率 / 營收成長
 * 直接複用 health.js 的長線健康度邏輯，確保與健康度系統一致
 * 資料來源：window.__lastFundamentals（基本面 Tab 載入後注入）
 */
import { AppState } from '../state.js';
import { calcHealthLong } from '../health.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ═══════════════════════════════════════════════════════
// 🌟 FundamentalModule — Golden Board
// 基本面六大維度：獲利 / 估值 / 股利 / 成長 / 利潤率 / 長線健康度
// ═══════════════════════════════════════════════════════
const FundamentalModule = {
  id: 'fundamental',
  name: '基本面分析',
  icon: '📋',
  candleMinLen: 20,

  evaluate(candles) {
    const fund = window.__lastFundamentals ?? null;
    const n = candles.length;

    // 無基本面資料時回傳特殊 raw
    if (!fund) {
      return {
        score: 0, signal: null, items: [],
        raw: { noData: true, n },
      };
    }

    // 從 fund 取所有欄位
    const pe             = fund.pe   ?? null;
    const pb             = fund.pbRatio ?? null;
    const divYield       = fund.dividendYield ?? null;   // 小數，如 0.04 = 4%
    const eps            = fund.eps  ?? null;
    const earningsGrowth = fund.earningsGrowth ?? null;  // 小數
    const profitMargin   = fund.profitMargin   ?? null;  // 小數
    const revenueGrowth  = fund.revenueGrowth  ?? null;  // 小數
    const epsSeries      = fund._epsSeries     ?? [];    // [{ date, eps }] 由新到舊
    const marginSeries   = fund._marginSeries  ?? [];    // [{ grossMargin, netMargin }]

    // 長線健康度（複用 health.js）
    let longScore = null;
    try { longScore = calcHealthLong(candles, fund); } catch(e) {}

    // 毛利率 / 淨利率（從 marginSeries 取最新）
    const grossMargin  = marginSeries[0]?.grossMargin ?? null;
    const netMargin    = marginSeries[0]?.netMargin   ?? null;
    const opMargin     = marginSeries[0]?.operatingMargin ?? null;

    // EPS 連續成長季數
    let epsConsecutiveGrowth = 0;
    if (epsSeries.length >= 2) {
      for (let i = 0; i < epsSeries.length - 1; i++) {
        if (epsSeries[i].eps > epsSeries[i + 1].eps) epsConsecutiveGrowth++;
        else break;
      }
    }

    // EPS 連續衰退偵測
    const epsConsecutiveDecline = epsSeries.length >= 4 &&
      epsSeries[0].eps < epsSeries[1].eps &&
      epsSeries[1].eps < epsSeries[2].eps &&
      epsSeries[2].eps < epsSeries[3].eps;

    // PEG = PE / (EPS成長率%)
    const peg = (pe != null && pe > 0 && earningsGrowth != null && earningsGrowth > 0)
      ? pe / (earningsGrowth * 100)
      : null;

    const items = [];
    const fmt  = (v, d=2) => v == null ? '—' : v.toFixed(d);
    const fmtP = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;

    // ── 條件 1：EPS 獲利品質 ──
    if (eps != null) {
      const epsOk = eps > 0;
      items.push({
        ok: epsOk,
        text: epsOk
          ? `<strong>EPS 正值</strong>：最新季 EPS ${fmt(eps)} 元（獲利中）`
          : `<strong>EPS 虧損</strong>：最新季 EPS ${fmt(eps)} 元（虧損中）`,
        sub: epsConsecutiveDecline
          ? `⚠️ 近4季 EPS 連續衰退：${epsSeries.slice(0,4).map(e=>e.eps.toFixed(2)).join(' → ')}`
          : epsConsecutiveGrowth >= 2
          ? `✅ 連續 ${epsConsecutiveGrowth} 季成長：${epsSeries.slice(0, Math.min(epsConsecutiveGrowth+1, 4)).map(e=>e.eps.toFixed(2)).join(' → ')}`
          : epsSeries.length >= 2 ? `近4季：${epsSeries.slice(0,4).map(e=>e.eps.toFixed(2)).join(' / ')}` : '—',
        whyTitle: '為什麼 EPS 是最重要的基本面指標？',
        why: 'EPS（每股盈餘）是企業獲利能力的直接體現。正值代表企業賺錢，連續成長代表獲利品質持續改善。連續3季以上成長的企業，往往是法人主動增持的對象；連續衰退則是警訊，代表競爭力或景氣周期出問題。',
      });
    } else {
      items.push({
        ok: null,
        text: `<strong>EPS</strong>：無資料`,
        sub: '需先開啟基本面 Tab 載入財務資料',
        whyTitle: '為什麼 EPS 重要？', why: 'EPS 是企業獲利的核心指標，連續成長代表競爭力。',
      });
    }

    // ── 條件 2：盈餘成長率 ──
    if (earningsGrowth != null) {
      const eg = earningsGrowth * 100;
      items.push({
        ok: eg > 0,
        text: eg >= 20
          ? `<strong>高速成長</strong>：EPS 年增率 +${eg.toFixed(1)}%（≥ 20%，強力成長）`
          : eg >= 10
          ? `<strong>穩健成長</strong>：EPS 年增率 +${eg.toFixed(1)}%（10~20%，健康成長）`
          : eg >= 0
          ? `<strong>小幅成長</strong>：EPS 年增率 +${eg.toFixed(1)}%（0~10%，緩慢增長）`
          : eg >= -10
          ? `<strong>小幅衰退</strong>：EPS 年增率 ${eg.toFixed(1)}%（0~-10%，輕微衰退）`
          : `<strong>嚴重衰退</strong>：EPS 年增率 ${eg.toFixed(1)}%（< -10%，獲利大幅下滑）`,
        sub: peg != null ? `PEG = ${peg.toFixed(2)}（PE ${fmt(pe,1)}x ÷ 成長率 ${eg.toFixed(1)}%）${peg < 1 ? '　✅ PEG < 1 物超所值' : peg < 2 ? '　⚠️ PEG 合理偏貴' : '　❌ PEG > 2 高估'}` : '',
        whyTitle: '為什麼 EPS 成長率比 EPS 絕對值更重要？',
        why: 'EPS 的成長速度反映企業的競爭力走向。即使目前 EPS 不高，只要持續高速成長（20%+），未來的獲利能力可期。PEG = PE / EPS成長率，PEG < 1 代表股價相對成長潛力被低估，是 Peter Lynch 最愛的選股指標。',
      });
    }

    // ── 條件 3：獲利能力（毛利率/淨利率）──
    const marginOk = grossMargin != null || netMargin != null;
    if (marginOk) {
      const gm = grossMargin, nm = netMargin ?? (profitMargin != null ? profitMargin * 100 : null);
      items.push({
        ok: (gm != null && gm >= 30) || (nm != null && nm >= 10) ? true : (gm != null && gm < 10) || (nm != null && nm < 0) ? false : null,
        text: `<strong>獲利能力</strong>：毛利率 ${gm != null ? gm.toFixed(1)+'%' : '—'}　淨利率 ${nm != null ? nm.toFixed(1)+'%' : '—'}`,
        sub: [
          gm != null ? `毛利率 ${gm.toFixed(1)}%（${gm >= 50 ? '⭐ 高護城河' : gm >= 30 ? '✅ 健康' : gm >= 20 ? '⚠️ 中等' : '❌ 偏低'}）` : '',
          nm != null ? `淨利率 ${nm.toFixed(1)}%（${nm >= 20 ? '⭐ 超強' : nm >= 10 ? '✅ 健康' : nm >= 5 ? '⚠️ 一般' : nm < 0 ? '❌ 虧損' : '⚠️ 偏薄'}）` : '',
          marginSeries.length >= 2 ? `趨勢：${marginSeries.slice(0,4).map(m => m.netMargin?.toFixed(1)+'%').filter(Boolean).join(' → ')}` : '',
        ].filter(Boolean).join('　'),
        whyTitle: '為什麼毛利率是護城河指標？',
        why: '毛利率高（≥50%）代表企業有定價權，不需要靠低價搶市場，是「護城河」的直接體現（如台積電、鴻海等）。淨利率反映扣除所有費用後的實際獲利能力。毛利率趨勢比單一季數字更重要，持續提升代表競爭力增強。',
      });
    }

    // ── 條件 4：估值合理性（PE / PB）──
    if (pe != null || pb != null) {
      const peOk = pe != null && pe > 0 && pe <= 25;
      const pbOk = pb != null && pb > 0 && pb <= 2;
      items.push({
        ok: peOk && pbOk ? true : (pe != null && pe > 50) || (pb != null && pb > 4) ? false : null,
        text: `<strong>估值</strong>：PE ${pe != null && pe > 0 ? pe.toFixed(1)+'x' : '—'}　PB ${pb != null ? pb.toFixed(2)+'x' : '—'}`,
        sub: [
          pe != null && pe > 0 ? `PE ${pe.toFixed(1)}x（${pe <= 10 ? '⭐ 極低估' : pe <= 15 ? '✅ 便宜' : pe <= 25 ? '✅ 合理' : pe <= 40 ? '⚠️ 偏貴' : '❌ 高估'}）` : '',
          pb != null && pb > 0 ? `PB ${pb.toFixed(2)}x（${pb <= 1 ? '⭐ 低於淨值' : pb <= 2 ? '✅ 合理' : pb <= 4 ? '⚠️ 偏貴' : '❌ 過高'}）` : '',
        ].filter(Boolean).join('　'),
        whyTitle: '為什麼 PE/PB 不能單看絕對值？',
        why: 'PE（本益比）= 股價 / EPS，反映市場願意為每元盈餘付出多少倍的代價。同一個 PE，對成長股可能便宜（因為未來盈餘會大幅增加），對衰退股可能昂貴。PB（股價淨值比）= 股價 / 每股淨值，PB < 1 代表股價低於帳面價值，是深度價值投資的目標。',
      });
    }

    // ── 條件 5：股息殖利率 ──
    if (divYield != null) {
      const divPct = divYield * 100;
      items.push({
        ok: divPct >= 3,
        text: divPct >= 5
          ? `<strong>高殖利率</strong>：${divPct.toFixed(2)}%（≥ 5%，存股首選）`
          : divPct >= 3
          ? `<strong>穩定配息</strong>：殖利率 ${divPct.toFixed(2)}%（3~5%，優質配息）`
          : divPct >= 1
          ? `<strong>低殖利率</strong>：${divPct.toFixed(2)}%（1~3%，成長股常見）`
          : `<strong>幾乎不配息</strong>：殖利率 ${divPct.toFixed(2)}%（保留盈餘再投資）`,
        sub: `現金殖利率 ${divPct.toFixed(2)}%${divPct >= 3 && pe != null && pe > 0 ? `，本益比 ${pe.toFixed(1)}x，股利政策穩定` : ''}`,
        whyTitle: '殖利率怎麼看才對？',
        why: '殖利率 = 現金股利 / 股價，反映持有股票的現金報酬率。台股殖利率 ≥ 3% 通常被視為「值得存股」的門檻。但高殖利率有時是股價大跌的結果，不代表公司好。應搭配 EPS 成長性判斷：配息穩定 + EPS 成長 = 最佳存股標的。',
      });
    }

    // ── 條件 6：營收成長率 ──
    if (revenueGrowth != null) {
      const rg = revenueGrowth * 100;
      items.push({
        ok: rg >= 10,
        text: rg >= 20
          ? `<strong>高速營收成長</strong>：YoY +${rg.toFixed(1)}%（業務快速擴張中）`
          : rg >= 10
          ? `<strong>穩健營收成長</strong>：YoY +${rg.toFixed(1)}%（業務持續拓展）`
          : rg >= 0
          ? `<strong>營收小幅成長</strong>：YoY +${rg.toFixed(1)}%（業務緩慢增長）`
          : `<strong>營收衰退</strong>：YoY ${rg.toFixed(1)}%（業務萎縮中）`,
        sub: `營收年增率 ${rg >= 0 ? '+' : ''}${rg.toFixed(1)}%${earningsGrowth != null ? `，EPS 年增率 ${(earningsGrowth*100) >= 0 ? '+' : ''}${(earningsGrowth*100).toFixed(1)}%` : ''}`,
        whyTitle: '為什麼營收成長率配合 EPS 成長率一起看？',
        why: '營收成長代表業務在擴張，EPS 成長代表獲利在增加。最理想的組合是兩者都成長，且 EPS 成長率 > 營收成長率（代表經營效率提升，利潤率在改善）。只有營收成長但 EPS 衰退，可能是在燒錢搶市場，需要謹慎。',
      });
    }

    // ── 長線健康度 ──
    if (longScore != null) {
      const lsOk = longScore >= 65;
      items.push({
        ok: lsOk,
        text: `<strong>長線健康度</strong>：${longScore} 分（${longScore >= 80 ? '⭐ 優質' : longScore >= 65 ? '✅ 健康' : longScore >= 50 ? '⚠️ 一般' : '❌ 偏差'}）`,
        sub: `綜合大趨勢 + 基本面 + 估值 + 量能 + 歷史百分位，滿分 100`,
        whyTitle: '長線健康度怎麼算？',
        why: '長線健康度整合8個維度：大趨勢結構（MA60/120/240排列）±20、基本面獲利品質±20、歷史百分位±15、週K RSI±12、波段結構HH/HL±10、估值合理性±10、長期量能±8、月K趨勢±5。有基本面資料時計算更準確，無資料時降格為技術面評估。',
      });
    }

    // ── 綜合訊號 ──
    const hasGoodEPS   = eps != null && eps > 0 && epsConsecutiveGrowth >= 2;
    const hasGoodGrowth = earningsGrowth != null && earningsGrowth * 100 >= 10;
    const hasGoodValue  = pe != null && pe > 0 && pe <= 25;
    const hasGoodDiv    = divYield != null && divYield * 100 >= 3;
    const hasHighMargin = (grossMargin != null && grossMargin >= 30) || (netMargin != null && netMargin >= 10);
    const hasBadEPS     = eps != null && eps < 0;
    const hasBadGrowth  = earningsGrowth != null && earningsGrowth * 100 < -10;

    let signal, score;

    if (hasBadEPS && hasBadGrowth) {
      signal = { name: '基本面惡化', icon: '🚨', stars: 1,
        desc: 'EPS 虧損且盈餘嚴重衰退，基本面已惡化，不適合長線持有。' };
      score = 1;
    } else if (hasGoodEPS && hasGoodGrowth && hasGoodValue && hasHighMargin) {
      signal = { name: '基本面優質', icon: '📋', stars: 5,
        desc: 'EPS 持續成長 + 高速盈餘增長 + 估值合理 + 利潤率健康，四維度全部達標。' };
      score = 5;
    } else if (hasGoodEPS && hasGoodGrowth && hasGoodDiv) {
      signal = { name: '成長配息兼具', icon: '⭐', stars: 5,
        desc: 'EPS 持續成長 + 高速盈餘增長 + 高殖利率，攻守兼備的優質標的。' };
      score = 5;
    } else if (hasGoodEPS && hasGoodGrowth) {
      signal = { name: '獲利成長強勁', icon: '🔵', stars: 4,
        desc: 'EPS 正值且持續成長，盈餘年增率達標，獲利品質良好。' };
      score = 4;
    } else if (hasGoodValue && hasGoodDiv && eps != null && eps > 0) {
      signal = { name: '價值型存股', icon: '💰', stars: 4,
        desc: 'EPS 正值 + 低估值 + 高殖利率，典型的價值型存股標的。' };
      score = 4;
    } else if (eps != null && eps > 0 && epsConsecutiveGrowth >= 1) {
      signal = { name: '獲利穩定', icon: '🟢', stars: 3,
        desc: 'EPS 正值且有成長跡象，基本面尚可，仍需觀察成長持續性。' };
      score = 3;
    } else if (hasBadEPS) {
      signal = { name: 'EPS 虧損', icon: '🔴', stars: 2,
        desc: 'EPS 為負值，企業目前虧損中，長線持有需承擔轉虧為盈的不確定性。' };
      score = 2;
    } else {
      signal = { name: '基本面中性', icon: '⏸', stars: 2,
        desc: '基本面資料有限或各項指標表現中等，難以明確判斷優劣。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: {
        pe, pb, divYield, eps, earningsGrowth, profitMargin, revenueGrowth,
        grossMargin, netMargin, opMargin,
        epsSeries, marginSeries,
        epsConsecutiveGrowth, epsConsecutiveDecline,
        peg, longScore,
        noData: false, n,
      },
    };
  },

  getLegendRows(ev) { return []; },

  renderBadge(ev, id) {
    if (ev.raw?.noData) {
      return `<span class="fs-mini-badge" data-mod="${id}" title="請先開啟基本面 Tab 載入資料">📋 基本面（無資料）</span>`;
    }
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">📋 基本面</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    const r    = ev.raw;
    const code = AppState.activeCode || '';
    const fmt  = (v, d=2) => v == null ? '—' : v.toFixed(d);
    const fmtP = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;

    // 無資料狀態 — 顯示載入按鈕
    if (r.noData) {
      const code = AppState.activeCode || '';
      return `
        <div class="fs-deep-module-head">
          <span class="fs-icon">📋</span>
          <span class="fs-title">基本面分析</span>
        </div>
        <div class="fs-deep-module-body">
          <div style="text-align:center;padding:40px 20px">
            <div style="font-size:40px;margin-bottom:14px">📊</div>
            <div style="color:var(--text);font-size:15px;font-weight:600;margin-bottom:8px">
              尚未載入 ${code} 的基本面資料
            </div>
            <div style="color:var(--muted);font-size:12px;line-height:1.8;margin-bottom:20px">
              點擊下方按鈕直接載入，或切換到「基本面」Tab 後再回來
            </div>
            <button id="fsFundLoadBtn"
              style="background:#3b82f6;color:#fff;border:none;border-radius:8px;
                     padding:10px 28px;font-size:13px;font-weight:600;cursor:pointer;
                     transition:background 0.2s"
              onmouseover="this.style.background='#2563eb'"
              onmouseout="this.style.background='#3b82f6'">
              📥 載入 ${code} 基本面資料
            </button>
            <div id="fsFundLoadStatus" style="margin-top:12px;font-size:12px;color:var(--muted);min-height:18px"></div>
          </div>
        </div>`;
    }

    const stars = '⭐'.repeat(ev.signal.stars);

    // EPS 趨勢 bar（近4季）
    const eps4 = r.epsSeries.slice(0, 4);
    const maxEps = Math.max(...eps4.map(e => Math.abs(e.eps)), 0.01);
    const epsBarHTML = eps4.length >= 2 ? `
      <div class="fs-keylevels" style="margin-top:16px">
        <h4>📈 EPS 近季走勢</h4>
        <div style="display:flex;gap:8px;align-items:flex-end;height:60px;padding:0 4px">
          ${[...eps4].reverse().map((e, i) => {
            const h = Math.round(Math.abs(e.eps) / maxEps * 50);
            const color = e.eps >= 0 ? '#34d399' : '#ef4444';
            const isLatest = i === eps4.length - 1;
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
              <span style="font-size:10px;color:${color}">${e.eps.toFixed(2)}</span>
              <div style="width:100%;height:${h}px;background:${color};border-radius:2px;${isLatest ? 'outline:1px solid #fbbf24' : ''}"></div>
              <span style="font-size:9px;color:var(--muted)">${e.date?.slice(0,7) ?? ''}</span>
            </div>`;
          }).join('')}
        </div>
        ${r.epsConsecutiveDecline ? `<div style="margin-top:6px;font-size:11px;color:#ef4444;padding:0 4px">⚠️ 近4季 EPS 連續衰退，長線警訊</div>` : ''}
        ${r.epsConsecutiveGrowth >= 3 ? `<div style="margin-top:6px;font-size:11px;color:#34d399;padding:0 4px">✅ 連續 ${r.epsConsecutiveGrowth} 季 EPS 成長，獲利動能強勁</div>` : ''}
      </div>` : '';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">📋</span>
        <span class="fs-title">基本面分析</span>
        <span class="fs-subtitle">${code} · EPS / 估值 / 獲利能力 / 股利 六維度判讀</span>
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
          <h4>📍 基本面數值總覽</h4>
          ${[
            { label: 'EPS（最新季）', val: r.eps != null ? `${fmt(r.eps,2)} 元` : '—', color: r.eps != null && r.eps > 0 ? '#34d399' : '#ef4444' },
            { label: 'EPS 年增率',   val: r.earningsGrowth != null ? `${(r.earningsGrowth*100)>=0?'+':''}${(r.earningsGrowth*100).toFixed(1)}%` : '—', color: r.earningsGrowth != null && r.earningsGrowth > 0 ? '#34d399' : '#ef4444' },
            { label: 'PE 本益比',    val: r.pe != null && r.pe > 0 ? `${fmt(r.pe,1)}x` : '—', color: '#e8eaed' },
            { label: 'PB 股價淨值', val: r.pb != null ? `${fmt(r.pb,2)}x` : '—', color: '#e8eaed' },
            { label: '殖利率',       val: r.divYield != null ? `${(r.divYield*100).toFixed(2)}%` : '—', color: r.divYield != null && r.divYield*100 >= 3 ? '#34d399' : '#e8eaed' },
            { label: '毛利率',       val: r.grossMargin != null ? `${r.grossMargin.toFixed(1)}%` : '—', color: r.grossMargin != null && r.grossMargin >= 30 ? '#34d399' : '#e8eaed' },
            { label: '淨利率',       val: r.netMargin != null ? `${r.netMargin.toFixed(1)}%` : r.profitMargin != null ? `${(r.profitMargin*100).toFixed(1)}%` : '—', color: '#e8eaed' },
            { label: '營收年增率',   val: r.revenueGrowth != null ? `${(r.revenueGrowth*100)>=0?'+':''}${(r.revenueGrowth*100).toFixed(1)}%` : '—', color: '#e8eaed' },
            { label: 'PEG',          val: r.peg != null ? `${r.peg.toFixed(2)}` : '—', color: r.peg != null && r.peg < 1 ? '#34d399' : r.peg != null && r.peg > 2 ? '#ef4444' : '#e8eaed' },
            { label: '長線健康度',   val: r.longScore != null ? `${r.longScore} 分` : '—', color: r.longScore != null && r.longScore >= 65 ? '#34d399' : '#e8eaed' },
          ].filter(item => item.val !== '—').map(item => `
            <div class="fs-keylevel-row">
              <span class="fs-keylevel-tag" style="background:rgba(59,130,246,0.12);color:#93c5fd">${item.label}</span>
              <span class="fs-keylevel-price" style="color:${item.color}">${item.val}</span>
              <span class="fs-keylevel-desc"></span>
            </div>
          `).join('')}
        </div>

        ${epsBarHTML}

        <div class="fs-action-guide" style="margin-top:16px">
          <div class="fs-action-guide-head">🎯 投資建議 — 根據 ${ev.signal.icon} ${ev.signal.name}</div>
          <div class="fs-action-guide-body">
            ${_fundActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 📋 六大維度速查 ━━━</h4>
            <ul>
              <li><strong>EPS</strong>：最直接的獲利指標，正值且持續成長是長線持有的基本條件</li>
              <li><strong>EPS 成長率</strong>：≥20% 高速成長，≥10% 健康，負值代表衰退</li>
              <li><strong>毛利率</strong>：護城河指標，≥50% 表示有定價權；<20% 競爭激烈</li>
              <li><strong>PE 本益比</strong>：不能只看絕對值，需搭配成長率（PEG 更準確）</li>
              <li><strong>殖利率</strong>：≥3% 存股門檻，但要確認配息來自盈餘而非舉債</li>
              <li><strong>PEG</strong>：PEG = PE/EPS成長率，< 1 代表物超所值</li>
            </ul>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 基本面分析限制 ━━━</h4>
            <ul>
              <li><strong>資料延遲</strong>：季報有 45 天延遲，使用最新可得資料</li>
              <li><strong>產業差異大</strong>：電子業毛利率標準與金融業/傳產不同，跨產業比較需謹慎</li>
              <li><strong>基本面好≠股價漲</strong>：還需要技術面的進場時機確認</li>
              <li><strong>前瞻性</strong>：財報是過去式，更重要的是未來的成長預期</li>
            </ul>
          </div>
        </div>

        ${renderAISection('fundamental', '基本面分析', '📋', ev, (() => {
          const fmt  = (v, d=2) => v == null ? '—' : v.toFixed(d);
          const fmtG = (v) => v == null ? '—' : `${(v*100)>=0?'+':''}${(v*100).toFixed(1)}%`;
          const eps4str = r.epsSeries.slice(0,4).map(e=>`${e.date?.slice(0,7)}:${e.eps.toFixed(2)}`).join(' / ');
          const m4str   = r.marginSeries.slice(0,4).map(m=>`毛${m.grossMargin?.toFixed(1)}%淨${m.netMargin?.toFixed(1)}%`).join(' → ');
          const itemsSummary = ev.items.map((item,i) => {
            const status = item.ok===true?'✅達標':item.ok===false?'❌未達標':'⏸中性';
            return `條件${i+1} ${status}：${item.text.replace(/<[^>]+>/g,'')}`;
          }).join(' | ');
          return {
            'EPS最新季【正值=獲利，負值=虧損】': r.eps!=null ? `${fmt(r.eps,2)}元` : '無資料',
            'EPS連續成長季數': r.epsConsecutiveGrowth >= 1 ? `✅ 連續${r.epsConsecutiveGrowth}季成長` : r.epsConsecutiveDecline ? '⚠️ 連續衰退' : '—',
            'EPS年增率【≥20%高速/≥10%健康/<0%衰退】': fmtG(r.earningsGrowth),
            '近4季EPS走勢【由舊到新】': eps4str || '—',
            'PE本益比【≤15便宜/≤25合理/≥50高估】': r.pe!=null&&r.pe>0 ? `${fmt(r.pe,1)}x` : '—',
            'PB股價淨值比': r.pb!=null ? `${fmt(r.pb,2)}x` : '—',
            'PEG【PE÷EPS成長率，<1物超所值】': r.peg!=null ? `${r.peg.toFixed(2)}（${r.peg<1?'✅物超所值':r.peg<2?'⚠️合理偏貴':'❌高估'}）` : '—',
            '殖利率【≥3%存股門檻】': r.divYield!=null ? `${(r.divYield*100).toFixed(2)}%` : '—',
            '毛利率最新季【≥50%護城河/≥30%健康】': r.grossMargin!=null ? `${r.grossMargin.toFixed(1)}%` : '—',
            '淨利率最新季': r.netMargin!=null ? `${r.netMargin.toFixed(1)}%` : r.profitMargin!=null ? `${(r.profitMargin*100).toFixed(1)}%` : '—',
            '近4季利潤率趨勢': m4str || '—',
            '營收年增率': fmtG(r.revenueGrowth),
            '長線健康度【滿分100，≥65健康】': r.longScore!=null ? `${r.longScore}分` : '—',
            [`各條件達成狀態【共${ev.items.length}項，✅${ev.items.filter(i=>i.ok===true).length}達標 ❌${ev.items.filter(i=>i.ok===false).length}未達標】`]: itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}
      </div>
    `;
  },
};

function _fundActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;
  const fmt = (v, d=2) => v==null ? '—' : v.toFixed(d);

  if (sig === '基本面優質' || sig === '成長配息兼具') return [
    { label: '長線評估', detail: `<strong>優質長線標的</strong>。EPS 持續成長 + 財務健康，值得中長線持有` },
    { label: '進場時機', detail: `技術面配合（KD 超賣反彈、突破均線）+ 基本面優質 = 最強買進組合` },
    { label: '持有策略', detail: `跌回支撐（MA20/MA60）時加碼，以長線健康度 ${r.longScore != null ? r.longScore+'分' : '—'} 確認底部質量` },
    { label: '風險提示', detail: `財報發布後需重新確認 EPS 是否維持成長趨勢，成長率若下滑需評估減碼` },
  ];
  if (sig === '獲利成長強勁') return [
    { label: '長線評估', detail: `<strong>成長型標的</strong>。EPS 持續成長，值得中線持有觀察` },
    { label: '進場時機', detail: `等技術面確認（突破均線/KD 黃金交叉）後進場，不宜只憑基本面追高` },
    { label: '觀察重點', detail: `下一季 EPS 是否維持成長動能，${r.epsConsecutiveGrowth}季連續成長能否延續` },
    { label: '風險提示', detail: `成長股 PE 通常偏高（當前 ${r.pe != null && r.pe > 0 ? r.pe.toFixed(1)+'x' : '—'}），景氣轉折時估值壓縮風險較大` },
  ];
  if (sig === '價值型存股') return [
    { label: '存股評估', detail: `<strong>價值型存股標的</strong>。低估值 + 高殖利率，適合長期持有領息` },
    { label: '進場時機', detail: `股價回測低點 + 殖利率 ${r.divYield != null ? (r.divYield*100).toFixed(2)+'%' : '—'} 提高時，是分批買進時機` },
    { label: '觀察重點', detail: `確認配息來自真實盈餘（EPS > 每股配息），而非舉債配息` },
    { label: '風險提示', detail: `存股最怕配息政策改變，需定期確認公司獲利是否穩定` },
  ];
  if (sig === 'EPS 虧損' || sig === '基本面惡化') return [
    { label: '投資建議', detail: `<strong>謹慎持有</strong>，EPS 虧損代表企業目前入不敷出，長線風險高` },
    { label: '觀察重點', detail: `虧損原因（一次性費用 vs 結構性虧損），以及何時可能轉虧為盈` },
    { label: '停損設置', detail: `若技術面也走壞（跌破重要均線），不宜攤平，應以技術面停損為主` },
    { label: '注意事項', detail: `虧損企業有轉機題材時常出現投機行情，但基本面未改善前不宜長線持有` },
  ];
  return [
    { label: '投資建議', detail: `基本面指標有限，以技術面訊號為主要操作依據` },
    { label: '觀察重點', detail: `等待基本面 Tab 完整載入後，可看到更完整的 EPS 和財務分析` },
    { label: '注意事項', detail: `基本面是長線底氣，技術面決定進出場時機，兩者結合效果最好` },
  ];
}

registerAnalysisModule(FundamentalModule);
