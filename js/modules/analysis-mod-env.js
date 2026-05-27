/* js/modules/analysis-mod-env.js
 * 🌟 ENV Golden Board Module
 */
import { AppState } from '../state.js';
import { calcEnvelope, calcMA } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const ENVModule = {
  id: 'env',
  name: 'ENV 包絡線',
  icon: '🎯',
  candleMinLen: 20,

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const env = calcEnvelope(closes, 20, 5);

    let lastIdx = n - 1;
    while (lastIdx > 0 && env[lastIdx] === null) lastIdx--;

    const { upper, mid, lower } = env[lastIdx];
    const prevEnv = env[lastIdx - 1];
    const prevUpper = prevEnv?.upper ?? upper;
    const prevMid   = prevEnv?.mid   ?? mid;
    const prevLower = prevEnv?.lower ?? lower;
    const lastClose = closes[n - 1];

    // 位置 %E：0=下軌, 0.5=中軌, 1=上軌
    const range = upper - lower;
    const pctE  = range > 0 ? (lastClose - lower) / range : 0.5;
    const prevPctE = range > 0 ? ((closes[n-2] ?? lastClose) - prevLower) / (prevUpper - prevLower) : 0.5;

    // 中軌斜率（趨勢方向）
    const midSlope = mid - prevMid;

    // 近3根觸軌偵測
    let touchUpper = false, touchLower = false;
    for (let i = Math.max(1, lastIdx - 2); i <= lastIdx; i++) {
      if (!env[i]) continue;
      if (closes[i] >= env[i].upper * 0.99) touchUpper = true;
      if (closes[i] <= env[i].lower * 1.01) touchLower = true;
    }

    const items = [];

    // 條件 1：位置
    if (pctE > 1) {
      items.push({ ok: false,
        text: `<strong>突破上軌</strong>：收盤 ${lastClose.toFixed(2)} 高於上軌 ${upper.toFixed(2)}（MA20+5%）`,
        sub: `高於中軌 ${((lastClose/mid-1)*100).toFixed(2)}%，進入過漲區`,
        whyTitle: '為什麼突破包絡線上軌是警訊？',
        why: '包絡線上軌 = MA20 × 1.05，代表股價已偏離均線 5% 以上。統計上，這種偏離程度往往觸發獲利回吐，均值回歸機率高。但強勢趨勢中可能持續突破，需搭配成交量判斷。',
      });
    } else if (pctE < 0) {
      items.push({ ok: true,
        text: `<strong>跌破下軌</strong>：收盤 ${lastClose.toFixed(2)} 低於下軌 ${lower.toFixed(2)}（MA20-5%）`,
        sub: `低於中軌 ${((1-lastClose/mid)*100).toFixed(2)}%，進入超跌區`,
        whyTitle: '為什麼跌破包絡線下軌是買機？',
        why: '包絡線下軌 = MA20 × 0.95，代表股價已偏離均線 -5% 以下。超跌後的均值回歸反彈機率高，是短線買入的觀察點。但空頭趨勢中可能繼續走低，需確認止跌訊號。',
      });
    } else if (pctE > 0.75) {
      items.push({ ok: null,
        text: `<strong>靠近上軌</strong>：%E = ${(pctE*100).toFixed(1)}%（收盤接近 MA20+5%）`,
        sub: `收盤 ${lastClose.toFixed(2)}，上軌 ${upper.toFixed(2)}，距離 ${(upper-lastClose).toFixed(2)} 元`,
        whyTitle: '靠近上軌代表什麼？', why: '收盤靠近上軌代表短線偏強，但仍在合理範圍。若上軌受壓回落，是短線減碼訊號；若帶量突破，是強勢延伸訊號。',
      });
    } else if (pctE < 0.25) {
      items.push({ ok: null,
        text: `<strong>靠近下軌</strong>：%E = ${(pctE*100).toFixed(1)}%（收盤接近 MA20-5%）`,
        sub: `收盤 ${lastClose.toFixed(2)}，下軌 ${lower.toFixed(2)}，距離 ${(lastClose-lower).toFixed(2)} 元`,
        whyTitle: '靠近下軌代表什麼？', why: '收盤靠近下軌代表短線偏弱，接近超跌區。若出現止跌 K 線（長下影線），是短線反彈候選。',
      });
    } else {
      items.push({ ok: pctE > 0.5,
        text: `<strong>通道中段</strong>：%E = ${(pctE*100).toFixed(1)}%（${pctE > 0.5 ? '中軌上方偏多' : '中軌下方偏空'}）`,
        sub: `收盤 ${lastClose.toFixed(2)}，中軌（MA20）${mid.toFixed(2)}，差 ${(lastClose-mid) > 0 ? '+' : ''}${(lastClose-mid).toFixed(2)} 元`,
        whyTitle: '通道中段代表什麼？', why: '收盤在 ±5% 之間的中間地帶，無明確極端訊號。以中軌（MA20）方向和收盤相對位置判斷方向。',
      });
    }

    // 條件 2：中軌方向
    items.push({ ok: midSlope > 0,
      text: `<strong>中軌（MA20）</strong>：${midSlope > 0 ? '↑ 向上（多頭）' : midSlope < 0 ? '↓ 向下（空頭）' : '→ 水平'}`,
      sub: `MA20 本根 ${mid.toFixed(2)} vs 前根 ${prevMid.toFixed(2)}（斜率 ${midSlope > 0 ? '+' : ''}${midSlope.toFixed(2)}）`,
      whyTitle: '為什麼中軌方向最關鍵？', why: 'ENV 的中軌就是 MA20，方向決定趨勢。中軌向上時，下軌是動態支撐；中軌向下時，上軌是動態壓力。',
    });

    // 條件 3：%E 動能
    items.push({ ok: (pctE - prevPctE) > 0,
      text: `<strong>%E 動能</strong>：${(pctE-prevPctE)>0 ? '↑ 往上軌移動' : '↓ 往下軌移動'}`,
      sub: `%E 本根 ${(pctE*100).toFixed(1)}% vs 前根 ${(prevPctE*100).toFixed(1)}%`,
      whyTitle: '為什麼看 %E 動能？', why: '%E 的變化方向反映收盤在包絡線內的移動趨勢，是比絕對位置更靈敏的方向指標。',
    });

    // 綜合訊號
    let signal, score;
    if (pctE < 0 && midSlope > 0) {
      signal = { name: '超跌反彈機會', icon: '🎯', stars: 5, desc: '多頭趨勢中跌破下軌（MA20-5%），超跌反彈機率高。' }; score = 5;
    } else if (pctE > 1 && midSlope < 0) {
      signal = { name: '超漲回落風險', icon: '⚠️', stars: 1, desc: '空頭趨勢中突破上軌，過漲反轉風險，避免追高。' }; score = 1;
    } else if (pctE < 0) {
      signal = { name: '觸及下軌', icon: '⚡', stars: 4, desc: '跌破包絡線下軌，進入超跌區，等止跌確認後可布局。' }; score = 4;
    } else if (pctE > 1) {
      signal = { name: '突破上軌', icon: '🔴', stars: 2, desc: '突破包絡線上軌，短線過漲，留意均值回歸壓力。' }; score = 2;
    } else if (pctE > 0.75 && midSlope > 0) {
      signal = { name: '強勢區間', icon: '🔵', stars: 4, desc: '靠近上軌 + 中軌向上，多頭強勢延伸中。' }; score = 4;
    } else if (pctE < 0.25 && midSlope < 0) {
      signal = { name: '弱勢區間', icon: '🔴', stars: 2, desc: '靠近下軌 + 中軌向下，空頭弱勢延伸中。' }; score = 2;
    } else if (midSlope > 0 && pctE > 0.5) {
      signal = { name: '多頭中段', icon: '🟢', stars: 3, desc: '中軌向上 + 收盤在中軌上方，多頭正常延伸。' }; score = 3;
    } else {
      signal = { name: '中性觀望', icon: '⏸', stars: 2, desc: '收盤在通道中段，無明確極端訊號，以中軌方向為主。' }; score = 2;
    }

    return { score, signal, items,
      raw: { upper, mid, lower, prevMid, midSlope, pctE, prevPctE, lastClose, touchUpper, touchLower, n } };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = v => v?.toFixed(2) ?? '—';
    return [
      { id: 'env-upper', name: '🟣 ENV+', value: fmt(ev.raw.upper), color: 'rgba(168,85,247,0.8)', tooltip: 'MA20 + 5%' },
      { id: 'env-mid',   name: '🟣 ENV中', value: fmt(ev.raw.mid),  color: 'rgba(168,85,247,0.5)', tooltip: 'MA20（中軌）' },
      { id: 'env-lower', name: '🟣 ENV-', value: fmt(ev.raw.lower), color: 'rgba(168,85,247,0.8)', tooltip: 'MA20 - 5%' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🎯 ENV</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) return `<div class="fs-deep-module-head"><span class="fs-icon">🎯</span><span class="fs-title">ENV 包絡線</span></div>
      <div class="fs-deep-module-body"><p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 20 根 K 線）</p></div>`;

    const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code = AppState.activeCode || '';
    const pctBClamped = Math.max(0, Math.min(1, r.pctE));
    const barColor = r.pctE > 0.75 ? '#ef5350' : r.pctE < 0.25 ? '#26a69a' : '#a855f7';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🎯</span>
        <span class="fs-title">ENV 包絡線</span>
        <span class="fs-subtitle">Envelope · MA20 ± 5% 均值回歸判讀</span>
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
          <h4>📍 包絡線當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(168,85,247,0.18);color:#d8b4fe">上軌 ENV+</span>
            <span class="fs-keylevel-price">${fmt(r.upper)}</span>
            <span class="fs-keylevel-desc">MA20 + 5%　${r.lastClose > r.upper ? '⚠️ 已突破' : `距現價 +${(r.upper-r.lastClose).toFixed(2)}`}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(168,85,247,0.12);color:#d8b4fe">中軌 MA20</span>
            <span class="fs-keylevel-price">${fmt(r.mid)}</span>
            <span class="fs-keylevel-desc">斜率 ${r.midSlope > 0 ? '+' : ''}${r.midSlope.toFixed(2)}　${r.midSlope > 0 ? '↑ 多頭' : r.midSlope < 0 ? '↓ 空頭' : '→ 水平'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(168,85,247,0.18);color:#d8b4fe">下軌 ENV-</span>
            <span class="fs-keylevel-price">${fmt(r.lower)}</span>
            <span class="fs-keylevel-desc">MA20 - 5%　${r.lastClose < r.lower ? '⚠️ 已跌破' : `距現價 -${(r.lastClose-r.lower).toFixed(2)}`}</span>
          </div>
          <div style="padding:8px 14px 4px;font-size:11px;color:var(--muted)">
            %E 位置　<span style="color:${barColor};font-weight:600">${(r.pctE*100).toFixed(1)}%</span>
            <div style="margin-top:4px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${pctBClamped*100}%;background:${barColor};border-radius:3px"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;font-size:10px">
              <span>0% 下軌</span><span>50% 中軌</span><span>100% 上軌</span>
            </div>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_envActionRows(ev).map(row => `<div class="fs-action-row"><span class="fs-action-label">${row.label}</span><span class="fs-action-detail">${row.detail}</span></div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🎯 ENV 包絡線原理 ━━━</h4>
            <p><strong>上軌</strong>：MA20 × (1 + 5%) = MA20 × 1.05</p>
            <p><strong>中軌</strong>：MA20（20日簡單移動平均）</p>
            <p><strong>下軌</strong>：MA20 × (1 - 5%) = MA20 × 0.95</p>
            <p style="margin-top:8px">包絡線與布林通道的差異：布林通道用「標準差」計算軌道寬度（隨市場波動率變化），包絡線用「固定百分比」（±5%），更直觀、更穩定。適合震盪型個股的高出低進策略。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>固定 5% 不適用所有股票</strong>：高波動股（日波動 3~5%）需要更寬的包絡（±8~10%）；低波動股可以用 ±3%</li>
              <li><strong>趨勢行情失效</strong>：強趨勢中股價可以沿著上/下軌持續走行，不是每次觸軌都要反轉</li>
              <li><strong>中軌方向最重要</strong>：和布林通道一樣，中軌方向決定操作方向</li>
            </ul>
          </div>
        </div>

        ${renderAISection('env', 'ENV 包絡線', '🎯', ev, {
          '上軌 ENV+【MA20+5%，超漲警戒】': fmt(r.upper),
          '中軌 MA20【趨勢基準，方向最重要】': `${fmt(r.mid)}（斜率 ${r.midSlope > 0 ? '+' : ''}${r.midSlope.toFixed(2)}，${r.midSlope > 0 ? '↑ 多頭' : r.midSlope < 0 ? '↓ 空頭' : '→ 水平'}）`,
          '下軌 ENV-【MA20-5%，超跌支撐】': fmt(r.lower),
          '現價': fmt(r.lastClose),
          '%E位置【0=下軌,0.5=中軌,1=上軌】': `${(r.pctE*100).toFixed(1)}%（${r.pctE > 1 ? '突破上軌' : r.pctE > 0.75 ? '靠近上軌' : r.pctE < 0 ? '跌破下軌' : r.pctE < 0.25 ? '靠近下軌' : '通道中段'}）`,
          '%E動能【正=往上軌，負=往下軌】': `${(r.pctE - r.prevPctE) > 0 ? '+' : ''}${((r.pctE - r.prevPctE)*100).toFixed(1)}%`,
          '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
        })}
      </div>
    `;
  },
};

function _envActionRows(ev) {
  const r = ev.raw, fmt = v => v?.toFixed(2) ?? '—';
  const sig = ev.signal.name;
  if (sig === '超跌反彈機會') return [
    { label: '進場建議', detail: `<strong>多頭趨勢中的超跌布局</strong>，可試單 30~50%` },
    { label: '加碼條件', detail: `收盤反彈站回下軌 ${fmt(r.lower)} 上方 + 中軌仍向上 → 加碼確認` },
    { label: '停損設置', detail: `繼續收跌且中軌轉向下 → 停損出場` },
    { label: '注意事項', detail: `搭配 KD/RSI 超賣確認反彈機率更高` },
  ];
  if (sig === '觸及下軌') return [
    { label: '進場建議', detail: `進入超跌區，<strong>等止跌 K 線（長下影）確認後試單</strong>` },
    { label: '加碼條件', detail: `中軌方向確認向上 + 成交量放大 → 加碼` },
    { label: '停損設置', detail: `跌破下軌且中軌持續向下 → 不接刀` },
    { label: '注意事項', detail: `中軌向下時下軌觸及是空頭走軌，不可逆勢接刀` },
  ];
  if (sig === '超漲回落風險' || sig === '突破上軌') return [
    { label: '操作建議', detail: `短線過漲，<strong>考慮分批減碼</strong>，目標回測中軌 ${fmt(r.mid)}` },
    { label: '停損設置', detail: `中軌向上 + 繼續站穩上軌 → 可能是強勢走軌，停損空單` },
    { label: '注意事項', detail: `中軌仍向上時突破上軌不一定反轉，需確認縮量才減碼` },
  ];
  return [
    { label: '操作建議', detail: `觀望，等待<strong>觸及上/下軌後的明確反應</strong>再進場` },
    { label: '關鍵觀察', detail: `中軌是否轉向，收盤是否靠近上/下軌` },
    { label: '停損設置', detail: `若已持多，收盤跌破中軌 ${fmt(r.mid)} → 停損` },
    { label: '注意事項', detail: `ENV 最適合震盪型個股，強趨勢股請配合 EMA / MACD 使用` },
  ];
}

registerAnalysisModule(ENVModule);
