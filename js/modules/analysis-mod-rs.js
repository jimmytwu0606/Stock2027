/* js/modules/analysis-mod-rs.js
 * 🏅 RS Rating 相對強度（IBD 百分位）教學模組 — T-1
 * rs_v 由 GAS 夜間 _injectRSRating 算全市場百分位寫入 snapshot（前端單股算不出百分位）。
 * 本模組讀 window.__snapshot 的 rs_v / rs_line_high，呈現判讀 + 教學。
 */
import { AppState } from '../state.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem } from '../analysis-fullscreen.js';

function _readRS() {
  const code = AppState.activeCode || '';
  const row  = window.__snapshot?.stocks?.[code];
  if (!row || row.rs_v == null) return null;
  return { rsv: row.rs_v, lineHigh: row.rs_line_high === true };
}

const RSModule = {
  id: 'rs',
  name: 'RS 相對強度',
  icon: '🏅',
  candleMinLen: 1,

  evaluate(/* candles */) {
    const r = _readRS();
    if (!r) return { score: 3, signal: null, items: [], raw: null };

    const { rsv, lineHigh } = r;
    const tier = rsv >= 95 ? 'elite' : rsv >= 87 ? 'strong' : rsv >= 50 ? 'mid' : 'weak';
    const items = [];

    items.push({ ok: rsv >= 87,
      text: `<strong>RS Rating：${rsv}</strong>（強於 ${rsv}% 個股）`,
      sub: tier === 'elite' ? '精英級（≥95）——全市場最強前 5%'
         : tier === 'strong' ? '強勢級（≥87）——歐尼爾選股的最低門檻'
         : tier === 'mid' ? '中性偏強，未達 87 強勢門檻'
         : '弱於大盤多數個股，動能不足',
      whyTitle: 'RS Rating 是什麼？',
      why: 'RS Rating（相對強度評等）是 IBD（投資人財經日報）體系的核心指標：把個股近 3/6/9/12 個月的漲幅加權（3 個月權重加倍），再拿到<strong>全市場 1,900 檔排百分位 1~99</strong>。RS 85 = 這檔的近期表現強過全市場 85% 的股票。它衡量的是「相對」強弱，不是絕對漲跌——空頭市場裡 RS 90 的股票可能還在跌，但跌得比別人少。',
    });

    items.push({ ok: lineHigh,
      text: lineHigh
        ? `<strong>RS 線創 60 日新高 ↗</strong>`
        : `RS 線未創新高`,
      sub: lineHigh
        ? '個股/大盤比值創新高，資金正相對流入此股'
        : 'RS 線盤整或走弱，相對強度未轉強',
      whyTitle: 'RS 線領先性（歐尼爾體系最強前兆）',
      why: 'RS 線 = 個股收盤 / 大盤收盤。當<strong>價格還沒創新高、RS 線就先創高</strong>，代表這檔在大盤休息時仍被資金相對買超——這是歐尼爾觀察到「主升段啟動前」最可靠的領先訊號之一，常出現在突破前的最後整理。',
    });

    let signal, score;
    if (tier === 'elite')      { signal = { name: 'RS 精英', icon: '🏅', stars: 5, desc: `RS ${rsv}，全市場前 5% 強勢股${lineHigh ? '、RS 線創高領先' : ''}。` }; score = 5; }
    else if (tier === 'strong'){ signal = { name: 'RS 強勢', icon: '🥇', stars: 4, desc: `RS ${rsv}，達歐尼爾 87 強勢門檻${lineHigh ? '、RS 線創高' : ''}。` }; score = lineHigh ? 4.5 : 4; }
    else if (tier === 'mid')   { signal = { name: 'RS 中性', icon: '➖', stars: 3, desc: `RS ${rsv}，相對強度普通，未達強勢門檻。` }; score = 3; }
    else                       { signal = { name: 'RS 偏弱', icon: '🥶', stars: 2, desc: `RS ${rsv}，相對強度落後，動能不足。` }; score = 2; }

    return { score, signal, items, raw: { rsv, lineHigh, tier } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const c = ev.raw.rsv >= 87 ? '#e3b341' : ev.raw.rsv >= 50 ? '#8b9dc3' : '#26a69a';
    return [{ id: 'rs-rating', name: `🏅 RS ${ev.raw.rsv}`,
      value: ev.raw.lineHigh ? '線創高↗' : '—',
      color: c, tooltip: 'RS Rating：全市場相對強度百分位（snapshot 夜算）' }];
  },

  renderBadge(ev, id) {
    if (!ev.raw) return `<span class="fs-mini-badge" data-mod="${id}">🏅 RS</span>`;
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}"><span>${ev.signal.icon} RS ${ev.raw.rsv}${ev.raw.lineHigh ? ' ↗' : ''}</span><span class="fs-mini-stars">${'⭐'.repeat(ev.signal.stars)}</span></span>`;
  },

  _teachBlock() {
    return `
      <div class="fs-teach" style="margin-top:22px">
        <div class="fs-teach-section"><h4>━━━ 🏅 相對強度，不是絕對漲跌 ━━━</h4>
          <p>RS Rating 把個股近 <strong>3/6/9/12 個月</strong>漲幅加權（近 3 月權重加倍，IBD 慣例），再拿到全市場排<strong>百分位 1~99</strong>。RS 85 = 強過 85% 的股票。它衡量的是「相對」——空頭市場裡領先股 RS 仍可高，因為它跌得比別人少。</p></div>
        <div class="fs-teach-section"><h4>━━━ 🎯 87 / 95 門檻典故 ━━━</h4>
          <ul><li><strong>RS ≥ 87</strong>：歐尼爾（CAN SLIM）選股的最低門檻——主升段個股啟動時 RS 多已站上 80+</li>
          <li><strong>RS ≥ 95</strong>：精英級，全市場最強前 5%，領導股的常態區間</li>
          <li>RS &lt; 50：相對弱勢，逆勢操作勝率低</li></ul></div>
        <div class="fs-teach-section"><h4>━━━ 📈 RS 線：領先價格的前兆 ━━━</h4>
          <p>RS 線 = 個股收盤 / 大盤收盤。<strong>價格未創高、RS 線先創高</strong>是歐尼爾體系最可靠的領先訊號——代表大盤休息時資金仍相對買超此股，常出現在突破前的最後整理。本站以 <strong>0050</strong> 為大盤基準（含息），副圖 RS 線正規化到首點 = 100。</p></div>
        <div class="fs-teach-section"><h4>━━━ ⚠️ 使用限制 ━━━</h4>
          <ul><li><strong>百分位需全市場排序</strong>：rs_v 由系統夜間算好寫入，盤中／假日可能尚無當日值</li>
          <li><strong>RS 高 ≠ 立刻買</strong>：是「選對池子」的篩網，進場時機仍需配合型態/量能/支撐</li>
          <li><strong>除權息會短暫打亂</strong>：本站用還原價計算，除權息日附近仍可能小幅失真</li></ul></div>
      </div>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head"><span class="fs-icon">🏅</span><span class="fs-title">RS 相對強度</span></div>`
        + `<div class="fs-deep-module-body"><p style="color:var(--muted);padding:8px 4px 14px">此股目前無 RS 值——RS Rating 是<strong>全市場百分位</strong>，由系統每日夜間排序後寫入快照，盤中／假日或新股可能尚未產生當日值。下方為指標教學。</p>${this._teachBlock()}</div>`;
    }
    const r = ev.raw, code = AppState.activeCode || '';
    const stars = '⭐'.repeat(ev.signal.stars);
    const tierColor = r.rsv >= 95 ? '#e3b341' : r.rsv >= 87 ? '#e3b341' : r.rsv >= 50 ? '#8b9dc3' : '#26a69a';
    return `
      <div class="fs-deep-module-head"><span class="fs-icon">🏅</span><span class="fs-title">RS Rating 相對強度（IBD 百分位）</span><span class="fs-subtitle">全市場排名 · 強於 ${r.rsv}% 個股</span></div>
      <div class="fs-deep-module-body">
        <div class="fs-readout">
          <div class="fs-readout-title">📊 即時判讀 — ${code}</div>
          <div class="fs-readout-items">${ev.items.map(_renderReadoutItem).join('')}</div>
          <div class="fs-readout-summary"><span class="fs-signal-icon">${ev.signal.icon}</span><div class="fs-signal-text"><span class="fs-signal-name">${ev.signal.name}</span><span class="fs-signal-desc">${ev.signal.desc}</span></div><span class="fs-signal-stars">${stars}</span></div>
        </div>
        <div class="fs-keylevels">
          <h4>📍 相對強度狀態</h4>
          <div class="fs-keylevel-row"><span class="fs-keylevel-tag" style="background:${tierColor}22;color:${tierColor}">RS Rating</span><span class="fs-keylevel-price" style="color:${tierColor}">${r.rsv}</span><span class="fs-keylevel-desc">${r.rsv >= 95 ? '精英級（前 5%）' : r.rsv >= 87 ? '強勢級（≥87 門檻）' : r.rsv >= 50 ? '中性偏強' : '相對弱勢'}</span></div>
          <div class="fs-keylevel-row"><span class="fs-keylevel-tag" style="background:${r.lineHigh ? '#ef535022' : '#8b9dc322'};color:${r.lineHigh ? '#ef5350' : '#8b9dc3'}">RS 線</span><span class="fs-keylevel-price" style="color:${r.lineHigh ? '#ef5350' : '#8b9dc3'}">${r.lineHigh ? '創 60 日新高 ↗' : '未創高'}</span><span class="fs-keylevel-desc">${r.lineHigh ? '相對大盤資金流入，領先價格的前兆' : '相對強度未轉強'}</span></div>
        </div>
        ${this._teachBlock()}
        ${renderAISection('rs', 'RS 相對強度', '🏅', ev, {
          'RS Rating【全市場百分位】': `${r.rsv}（強於 ${r.rsv}% 個股，${r.rsv >= 95 ? '精英級' : r.rsv >= 87 ? '強勢級' : r.rsv >= 50 ? '中性偏強' : '偏弱'}）`,
          'RS 線【領先價格的前兆】': r.lineHigh ? '創 60 日新高（資金相對流入）' : '未創新高',
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>`;
  },
};
registerAnalysisModule(RSModule);
