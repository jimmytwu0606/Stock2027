/* js/modules/analysis-mod-psy.js
 * 🌟 PSY Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcPSY } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

// ═══════════════════════════════════════════════════════
// 🌟 PSYModule — Golden Board
// 心理線：N日內上漲天數比率，75/25 超買超賣 + 趨勢方向
// ═══════════════════════════════════════════════════════
const PSYModule = {
  id: 'psy',
  name: 'PSY 心理線',
  icon: '🧠',
  candleMinLen: 13,  // calcPSY(n=12) 需要 13 根

  evaluate(candles) {
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const psyArr = calcPSY(closes, 12);

    let lastIdx = n - 1;
    while (lastIdx > 0 && psyArr[lastIdx] === null) lastIdx--;

    const lastPSY = psyArr[lastIdx];
    const prevPSY = psyArr[lastIdx - 1] ?? lastPSY;
    const psyMomentum = lastPSY - prevPSY;

    // 近 5 根斜率
    const recentPSY = psyArr.slice(-5).filter(v => v !== null);
    const avgSlope  = recentPSY.length >= 2
      ? (recentPSY[recentPSY.length - 1] - recentPSY[0]) / (recentPSY.length - 1)
      : 0;

    // 50 線（多空分水嶺）穿越
    const above50     = lastPSY >= 50;
    const prevAbove50 = prevPSY >= 50;
    const crossed50Up   = !prevAbove50 && above50;
    const crossed50Down = prevAbove50  && !above50;

    // 連續上漲/下跌天數（近 12 日）
    let upStreak = 0, downStreak = 0;
    for (let i = n - 1; i > 0; i--) {
      if (closes[i] > closes[i - 1])      { if (downStreak > 0) break; upStreak++;   }
      else if (closes[i] < closes[i - 1]) { if (upStreak > 0)   break; downStreak++; }
      else break;
    }

    const items = [];

    // ── 條件 1：PSY 位置（超買/超賣/中性）──
    if (lastPSY >= 75) {
      items.push({
        ok: false,
        text: `<strong>超買區</strong>：PSY ${lastPSY.toFixed(1)}（≥ 75，近12日上漲天數過多）`,
        sub: `近 12 日有 ${Math.round(lastPSY / 100 * 12)} 天收漲，買方情緒過熱`,
        whyTitle: '為什麼 PSY ≥ 75 是警訊？',
        why: 'PSY = 近N日上漲天數 / N × 100。PSY ≥ 75 代表過去 12 日有 9 天以上收漲，多方情緒過度樂觀。根據均值回歸原理，連續多天上漲後下跌的機率增加。但強勢多頭可以讓 PSY 在 75 附近鈍化，需搭配其他指標確認。',
      });
    } else if (lastPSY <= 25) {
      items.push({
        ok: true,
        text: `<strong>超賣區</strong>：PSY ${lastPSY.toFixed(1)}（≤ 25，近12日下跌天數過多）`,
        sub: `近 12 日有 ${12 - Math.round(lastPSY / 100 * 12)} 天收跌，空方情緒過度悲觀`,
        whyTitle: '為什麼 PSY ≤ 25 是機會？',
        why: 'PSY ≤ 25 代表過去 12 日有 9 天以上收跌，空方情緒過度悲觀。投資人恐慌程度高，短線反彈機率提升。但空頭趨勢中 PSY 可以長期在低位，需搭配止跌 K 線確認。',
      });
    } else if (lastPSY > 50) {
      items.push({
        ok: true,
        text: `<strong>多方情緒占優</strong>：PSY ${lastPSY.toFixed(1)}（50~75 正常多頭區）`,
        sub: `近 12 日有 ${Math.round(lastPSY / 100 * 12)} 天收漲，買方情緒正常偏樂觀`,
        whyTitle: 'PSY 在 50~75 代表什麼？',
        why: '這是多頭趨勢的正常運作區間，不過熱也不過冷。買賣雙方以多方略占優，適合持多或觀察加碼機會。',
      });
    } else {
      items.push({
        ok: false,
        text: `<strong>空方情緒占優</strong>：PSY ${lastPSY.toFixed(1)}（25~50 正常空頭區）`,
        sub: `近 12 日有 ${12 - Math.round(lastPSY / 100 * 12)} 天收跌，賣方情緒正常偏悲觀`,
        whyTitle: 'PSY 在 25~50 代表什麼？',
        why: '空方情緒略占優，適合觀望不追多。等待 PSY 站回 50 以上（多空情緒轉換）才考慮進場。',
      });
    }

    // ── 條件 2：50 線穿越 ──
    items.push({
      ok: above50,
      text: crossed50Up
        ? `<strong>升破 50</strong>：PSY 由 ${prevPSY.toFixed(1)} 升破多空分水嶺`
        : crossed50Down
        ? `<strong>跌破 50</strong>：PSY 由 ${prevPSY.toFixed(1)} 跌破多空分水嶺`
        : above50
        ? `<strong>站穩 50 以上</strong>：多方情緒持續`
        : `<strong>維持 50 以下</strong>：空方情緒持續`,
      sub: `PSY ${lastPSY.toFixed(1)}，50 線多空分水嶺${above50 ? '上方' : '下方'}`,
      whyTitle: 'PSY 的 50 線為什麼重要？',
      why: 'PSY = 50 代表近 12 日上漲下跌各半，是完美的多空均衡點。PSY 站上 50 代表多方情緒開始占優；PSY 跌破 50 代表空方開始主導。PSY 穿越 50 是中短期情緒轉換的確認訊號。',
    });

    // ── 條件 3：PSY 動能 ──
    items.push({
      ok: psyMomentum > 0,
      text: `<strong>情緒動能</strong>：${psyMomentum > 0 ? '↑ 多方情緒走強' : psyMomentum < 0 ? '↓ 空方情緒走強' : '→ 情緒持平'}`,
      sub: `本根 ${lastPSY.toFixed(1)} vs 前根 ${prevPSY.toFixed(1)}（變化 ${psyMomentum > 0 ? '+' : ''}${psyMomentum.toFixed(1)}）`,
      whyTitle: '為什麼看 PSY 的動能方向？',
      why: 'PSY 的斜率反映市場情緒的轉換速度。PSY 快速上升代表買方積極進場；PSY 快速下降代表賣方主導。高位（≥75）的 PSY 開始下滑，是情緒反轉的早期訊號，往往比股價下跌早出現。',
    });

    // ── 條件 4：連續漲跌天數 ──
    if (upStreak >= 3) {
      items.push({
        ok: false,
        text: `<strong>連續上漲 ${upStreak} 天</strong>：短線過熱，回調機率提升`,
        sub: `連續 ${upStreak} 個交易日收漲，短線買方情緒偏高`,
        whyTitle: '連續上漲多天為什麼要注意？',
        why: '連續 3 天以上的上漲，代表短線買方力道持續。但連漲越多天，均值回歸的機率越高。通常連漲 5 天以上後至少有 1 天的休息（整理或小跌）。這不代表要馬上賣，但要注意停利時機。',
      });
    } else if (downStreak >= 3) {
      items.push({
        ok: true,
        text: `<strong>連續下跌 ${downStreak} 天</strong>：短線超跌，反彈機率提升`,
        sub: `連續 ${downStreak} 個交易日收跌，短線賣方情緒偏高`,
        whyTitle: '連續下跌多天為什麼是機會？',
        why: '連續 3 天以上的下跌，代表短線賣方力道持續。但連跌越多天，均值回歸（反彈）的機率越高。在 PSY 低位（≤25）發生的連跌後反彈，是 PSY 最可靠的買進訊號之一。',
      });
    }

    // ── 綜合訊號 ──
    let signal, score;

    if (lastPSY <= 25 && psyMomentum > 0) {
      signal = { name: '超賣回升', icon: '🧠', stars: 5,
        desc: '超賣區 + PSY 開始回升，空方情緒極度悲觀後出現轉機，反彈可靠性高。' };
      score = 5;
    } else if (lastPSY >= 75 && psyMomentum < 0) {
      signal = { name: '超買回落', icon: '⚠️', stars: 2,
        desc: '超買區 + PSY 開始回落，多方情緒過熱後開始降溫，短線獲利了結訊號。' };
      score = 2;
    } else if (lastPSY <= 25) {
      signal = { name: '超賣觀察', icon: '⚡', stars: 4,
        desc: '進入超賣區，空方情緒極度悲觀。等 PSY 開始回升確認再進場。' };
      score = 4;
    } else if (lastPSY >= 75) {
      signal = { name: '超買警示', icon: '🔴', stars: 2,
        desc: '進入超買區，多方情緒過熱。強勢可鈍化，搭配其他指標才確認頂部。' };
      score = 2;
    } else if (crossed50Up) {
      signal = { name: '情緒翻多', icon: '🟢', stars: 4,
        desc: 'PSY 升破 50，多空情緒由空轉多，短線動能轉換訊號。' };
      score = 4;
    } else if (crossed50Down) {
      signal = { name: '情緒翻空', icon: '🔴', stars: 2,
        desc: 'PSY 跌破 50，多空情緒由多轉空，短線動能轉弱訊號。' };
      score = 2;
    } else if (above50 && avgSlope > 0) {
      signal = { name: '多方情緒強化', icon: '🔵', stars: 3,
        desc: 'PSY 站穩 50 以上且持續走強，多方情緒健康延伸。' };
      score = 3;
    } else if (!above50 && avgSlope < 0) {
      signal = { name: '空方情緒延伸', icon: '⚪', stars: 2,
        desc: 'PSY 低於 50 且持續走弱，空方情緒持續主導，避免追多。' };
      score = 2;
    } else {
      signal = { name: '情緒中性', icon: '⏸', stars: 2,
        desc: 'PSY 在中性區震盪，多空情緒均衡，以其他指標方向為主。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { lastPSY, prevPSY, psyMomentum, avgSlope, above50,
             crossed50Up, crossed50Down, upStreak, downStreak,
             psyArr, n, lastIdx },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    return [
      { id: 'psy', name: '🟣 PSY(12)', value: ev.raw.lastPSY?.toFixed(1) ?? '—', color: '#a78bfa',
        tooltip: '心理線，近12日上漲天數比率，75超買/25超賣' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🧠 PSY</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">🧠</span><span class="fs-title">PSY 心理線</span>
      </div><div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 13 根 K 線）</p>
      </div>`;
    }
    const r = ev.raw, fmt = v => v?.toFixed(1) ?? '—';
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';
    const psyPct = Math.max(0, Math.min(100, r.lastPSY));
    const psyColor = r.lastPSY >= 75 ? '#ef5350' : r.lastPSY <= 25 ? '#26a69a' : r.lastPSY > 50 ? '#93c5fd' : '#8a8f99';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🧠</span>
        <span class="fs-title">PSY 心理線</span>
        <span class="fs-subtitle">Psychological Line · PSY(12) 市場情緒判讀</span>
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
          <h4>📍 PSY 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(167,139,250,0.18);color:#c4b5fd">PSY(12)</span>
            <span class="fs-keylevel-price" style="color:${psyColor}">${fmt(r.lastPSY)}</span>
            <span class="fs-keylevel-desc">${r.lastPSY >= 75 ? '🔴 超買' : r.lastPSY <= 25 ? '🟢 超賣' : r.lastPSY > 50 ? '🔵 多方占優' : '⚪ 空方占優'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(167,139,250,0.12);color:#c4b5fd">情緒動能</span>
            <span class="fs-keylevel-price">${r.psyMomentum > 0 ? '↑' : r.psyMomentum < 0 ? '↓' : '→'} ${r.psyMomentum > 0 ? '+' : ''}${r.psyMomentum.toFixed(1)}</span>
            <span class="fs-keylevel-desc">本根 vs 前根</span>
          </div>
          ${r.upStreak >= 3 ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">連漲</span>
            <span class="fs-keylevel-price">${r.upStreak} 天</span>
            <span class="fs-keylevel-desc">短線過熱警示</span>
          </div>` : ''}
          ${r.downStreak >= 3 ? `<div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(38,166,154,0.18);color:#6ee7b7">連跌</span>
            <span class="fs-keylevel-price">${r.downStreak} 天</span>
            <span class="fs-keylevel-desc">短線超跌，反彈機率提升</span>
          </div>` : ''}
          <div style="padding:8px 14px 4px;font-size:11px;color:var(--muted)">
            PSY 位置
            <div style="margin-top:4px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${psyPct}%;background:${psyColor};border-radius:3px"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;font-size:10px">
              <span>0 超賣</span><span>25</span><span>50 中性</span><span>75</span><span>100 超買</span>
            </div>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_psyActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">
          <div class="fs-teach-section">
            <h4>━━━ 🧠 PSY 指標原理 ━━━</h4>
            <p><strong>公式</strong>：PSY = (近N日上漲天數 / N) × 100</p>
            <p>本系統使用 N=12（約2.5週），是台股最常用的標準設定。</p>
            <p style="margin-top:8px">PSY 的本質是「市場多空情緒的溫度計」。PSY=75 代表近12日有9天上漲，多方情緒偏熱；PSY=25 代表有9天下跌，空方情緒偏冷。</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ 🎯 四大關鍵區間 ━━━</h4>
            <ul>
              <li><strong>PSY ≥ 75（超買）</strong>：多方情緒過熱，注意回調風險</li>
              <li><strong>PSY 50~75（多頭正常區）</strong>：多方略占優，趨勢健康</li>
              <li><strong>PSY 25~50（空頭正常區）</strong>：空方略占優，觀望為主</li>
              <li><strong>PSY ≤ 25（超賣）</strong>：空方情緒過冷，反彈機率高</li>
            </ul>
            <p style="margin-top:8px"><strong>PSY=50 分水嶺</strong>：PSY 站上 50 = 多方情緒開始主導；跌破 50 = 空方開始主導</p>
          </div>
          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>只計算漲跌天數，不考慮幅度</strong>：漲 0.1% 和漲 5% 對 PSY 的貢獻一樣</li>
              <li><strong>趨勢行情中會鈍化</strong>：強多頭時 PSY 可以在 75 以上停留很久</li>
              <li><strong>搭配使用效果更好</strong>：PSY 反映情緒，KD/MACD 反映動能，兩者互補</li>
              <li><strong>適合短線判斷</strong>：PSY(12) 對應約 2~3 週的情緒週期</li>
            </ul>
          </div>
        </div>

        ${renderAISection('psy', 'PSY 心理線', '🧠', ev, (() => {
          const recent5 = r.psyArr.slice(-5).filter(v => v !== null).map((v, i, arr) => {
            const label = i === arr.length - 1 ? '【當根】' : `【-${arr.length - 1 - i}根】`;
            const zone = v >= 75 ? '超買' : v <= 25 ? '超賣' : v > 50 ? '偏多' : '偏空';
            return `${label}${v.toFixed(1)}(${zone})`;
          }).join(' → ');
          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          return {
            'PSY(12)當前值【近12日上漲天數比率】': `${fmt(r.lastPSY)}（近12日約${Math.round(r.lastPSY / 100 * 12)}天上漲）`,
            'PSY區間【75超買/25超賣/50分水嶺】': r.lastPSY >= 75 ? `超買區(${fmt(r.lastPSY)})` : r.lastPSY <= 25 ? `超賣區(${fmt(r.lastPSY)})` : r.lastPSY > 50 ? `多頭正常區(${fmt(r.lastPSY)})` : `空頭正常區(${fmt(r.lastPSY)})`,
            'PSY動能【正=多方情緒走強，負=空方走強】': `${r.psyMomentum > 0 ? '+' : ''}${r.psyMomentum.toFixed(1)}`,
            '50線狀態': r.crossed50Up ? '本根升破50（情緒由空轉多）' : r.crossed50Down ? '本根跌破50（情緒由多轉空）' : r.above50 ? `站穩50以上(${fmt(r.lastPSY)})` : `維持50以下(${fmt(r.lastPSY)})`,
            '連續漲跌': r.upStreak >= 3 ? `連漲${r.upStreak}天（短線過熱）` : r.downStreak >= 3 ? `連跌${r.downStreak}天（短線超跌）` : '無明顯連續',
            '近5根PSY走勢【由舊到新，最右為當根】': recent5,
            [`各條件達成狀態【共${ev.items.length}項，✅${ev.items.filter(i=>i.ok===true).length}達標 ❌${ev.items.filter(i=>i.ok===false).length}未達標】`]:
              itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}
      </div>
    `;
  },
};

function _psyActionRows(ev) {
  const sig = ev.signal.name;
  const r   = ev.raw;
  if (sig === '超賣回升') return [
    { label: '進場建議', detail: `<strong>積極進場</strong>。超賣 + PSY 回升是心理線最強買進訊號，可進 50% 部位` },
    { label: '加碼條件', detail: `PSY 站回 50 以上 + 其他指標（KD/MACD）同步翻多 → 加碼` },
    { label: '停損設置', detail: `PSY 再度下滑低於 25 且股價破新低 → 停損出場` },
    { label: '注意事項', detail: `超賣後反彈往往很快，不要等太完美的進場時機` },
  ];
  if (sig === '超買回落') return [
    { label: '操作建議', detail: `<strong>考慮減碼</strong>。PSY 高位回落代表多方情緒開始降溫` },
    { label: '觀察重點', detail: `PSY 是否跌破 50（情緒由多轉空），跌破才是確認出場訊號` },
    { label: '停損設置', detail: `PSY 跌破 50 + KD 死亡交叉 → 大幅減碼` },
    { label: '注意事項', detail: `強勢股 PSY 在高位可以鈍化很久，沒有死叉不要急著全出` },
  ];
  if (sig === '情緒翻多') return [
    { label: '進場建議', detail: `PSY 升破 50，可試單 30%，<strong>等待 PSY 站穩 50 以上再加碼</strong>` },
    { label: '加碼條件', detail: `PSY 維持 50 以上且趨勢向上 → 加碼` },
    { label: '停損設置', detail: `PSY 再度跌破 50 → 出場觀望` },
    { label: '注意事項', detail: `情緒翻多需搭配價量確認，單靠 PSY 升破 50 不夠` },
  ];
  // 其他情境
  return [
    { label: '操作建議', detail: `觀望為主，等 <strong>PSY 進入超賣區（≤25）後回升</strong>再考慮進場` },
    { label: '關鍵觀察', detail: `PSY 是否持續走向 25 超賣區，或是否能站回 50 以上` },
    { label: '停損設置', detail: `若已持多，PSY 跌破 25 且持續下滑 → 停損` },
    { label: '注意事項', detail: `PSY 最適合搭配 KD/RSI 一起看，情緒 + 動能雙確認效果最好` },
  ];
}

registerAnalysisModule(PSYModule);
