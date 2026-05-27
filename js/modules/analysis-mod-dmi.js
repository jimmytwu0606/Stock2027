/* js/modules/analysis-mod-dmi.js
 * 🌟 DMI Golden Board Module
 * 自動於 index.html 載入後 registerAnalysisModule() 到框架
 */
import { AppState } from '../state.js';
import { calcDMI } from '../indicators.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const DMIModule = {
  id: 'dmi',
  name: 'DMI 趨向指標',
  icon: '🧭',
  candleMinLen: 30,  // +14 Wilder + 14 ADX 平滑，30 根才穩定

  evaluate(candles) {
    const n = candles.length;
    const { plusDI, minusDI, adx } = calcDMI(candles);

    // 找最後有效值
    let lastIdx = n - 1;
    while (lastIdx > 0 && (plusDI[lastIdx] === null || adx[lastIdx] === null)) lastIdx--;

    const lastPlus  = plusDI[lastIdx];
    const lastMinus = minusDI[lastIdx];
    const lastADX   = adx[lastIdx];
    const prevPlus  = plusDI[lastIdx - 1] ?? lastPlus;
    const prevMinus = minusDI[lastIdx - 1] ?? lastMinus;
    const prevADX   = adx[lastIdx - 1]    ?? lastADX;

    const lastClose = candles[n - 1].close;

    // 近 3 根交叉偵測
    let crossBull = false, crossBear = false;
    for (let i = Math.max(1, lastIdx - 2); i <= lastIdx; i++) {
      if (plusDI[i-1] !== null && minusDI[i-1] !== null) {
        if (plusDI[i-1] <= minusDI[i-1] && plusDI[i] > minusDI[i]) crossBull = true;
        if (plusDI[i-1] >= minusDI[i-1] && plusDI[i] < minusDI[i]) crossBear = true;
      }
    }

    // ADX 趨勢強度分級
    const adxStrong  = lastADX >= 25;  // 趨勢確立
    const adxVStrong = lastADX >= 40;  // 強趨勢
    const adxWeak    = lastADX < 20;   // 無趨勢/盤整
    const adxDir     = lastADX > prevADX ? 'up' : lastADX < prevADX ? 'down' : 'flat';

    // DI 差距（多空力道差）
    const diDiff     = lastPlus - lastMinus;
    const diDiffPrev = prevPlus - prevMinus;

    const items = [];

    // ── 條件 1：+DI vs -DI（多空方向）──
    items.push({
      ok: lastPlus > lastMinus,
      text: lastPlus > lastMinus
        ? `<strong>多頭方向</strong>：+DI（${lastPlus.toFixed(1)}）> -DI（${lastMinus.toFixed(1)}）`
        : `<strong>空頭方向</strong>：+DI（${lastPlus.toFixed(1)}）< -DI（${lastMinus.toFixed(1)}）`,
      sub: `差距 ${diDiff > 0 ? '+' : ''}${diDiff.toFixed(1)}，${diDiff > diDiffPrev ? '差距擴大（動能增強）' : diDiff < diDiffPrev ? '差距縮小（動能減弱）' : '差距持平'}`,
      whyTitle: '為什麼 +DI > -DI 代表多頭？',
      why: '+DI（正方向指標）反映上漲力道，-DI（負方向指標）反映下跌力道。+DI > -DI 代表近期上漲動能大於下跌動能，多頭占優。兩線的差距越大，代表多空力道越懸殊、趨勢越確定。',
    });

    // ── 條件 2：ADX 強度 ──
    items.push({
      ok: adxStrong ? true : adxWeak ? false : null,
      text: adxVStrong
        ? `<strong>強趨勢</strong>：ADX ${lastADX.toFixed(1)}（≥ 40，趨勢極強）`
        : adxStrong
        ? `<strong>趨勢確立</strong>：ADX ${lastADX.toFixed(1)}（≥ 25，有明確趨勢）`
        : adxWeak
        ? `<strong>無明確趨勢</strong>：ADX ${lastADX.toFixed(1)}（< 20，盤整期）`
        : `<strong>趨勢醞釀</strong>：ADX ${lastADX.toFixed(1)}（20~25，趨勢初現）`,
      sub: `ADX ${adxDir === 'up' ? '↑ 走強' : adxDir === 'down' ? '↓ 減弱' : '→ 持平'}（本根 ${lastADX.toFixed(1)} vs 前根 ${prevADX.toFixed(1)}，變化 ${(lastADX - prevADX) > 0 ? '+' : ''}${(lastADX - prevADX).toFixed(1)}）`,
      whyTitle: '為什麼 ADX 25 這麼重要？',
      why: 'ADX 衡量趨勢的「強度」而非方向。ADX < 20：市場在盤整，+DI/-DI 的訊號不可靠，這時用 KD/RSI 更適合；ADX 20~25：趨勢初現；ADX ≥ 25：趨勢確立，可以跟著方向做；ADX ≥ 40：強趨勢，但也要留意過熱後的回調。',
    });

    // ── 條件 3：交叉訊號（近 3 根）──
    if (crossBull) {
      items.push({
        ok: true,
        text: `<strong>+DI 上穿 -DI</strong>：近 3 根多頭交叉`,
        sub: `${adxStrong ? 'ADX ≥ 25 確認趨勢，訊號可靠' : 'ADX 尚未達 25，需等趨勢確立再進場'}`,
        whyTitle: '為什麼 +DI 上穿 -DI 是買進訊號？',
        why: '+DI 上穿 -DI（多頭交叉）代表上漲力道開始超越下跌力道，是 DMI 最核心的買進訊號。搭配 ADX ≥ 25 時可靠度最高（表示趨勢確立）；若 ADX 仍低（< 20），交叉可能只是盤整中的雜訊。',
      });
    } else if (crossBear) {
      items.push({
        ok: false,
        text: `<strong>-DI 上穿 +DI</strong>：近 3 根空頭交叉`,
        sub: `${adxStrong ? 'ADX ≥ 25 確認趨勢，空頭訊號明確' : 'ADX 尚未達 25，可能是盤整雜訊'}`,
        whyTitle: '為什麼 -DI 上穿 +DI 是賣出訊號？',
        why: '-DI 上穿 +DI（空頭交叉）代表下跌力道開始超越上漲力道，是 DMI 的賣出/做空訊號。搭配 ADX 快速上升，代表空頭趨勢正在加速，這時候應該避免逆勢做多。',
      });
    } else {
      items.push({
        ok: lastPlus > lastMinus,
        text: `<strong>維持${lastPlus > lastMinus ? '多頭' : '空頭'}排列</strong>：無近期交叉`,
        sub: `+DI ${lastPlus.toFixed(1)} vs -DI ${lastMinus.toFixed(1)}，排列${lastPlus > lastMinus ? '持多' : '持空'}`,
        whyTitle: '無交叉時 DMI 怎麼看？',
        why: '無交叉時以 +DI/-DI 的相對位置判斷方向，以 ADX 判斷趨勢強度。+DI 持續在 -DI 上方 + ADX 走高 = 多頭趨勢延伸；反之亦然。',
      });
    }

    // ── 條件 4：ADX 方向（趨勢加速/減速）──
    items.push({
      ok: adxDir === 'up' && adxStrong,
      text: adxDir === 'up'
        ? `<strong>ADX 上升</strong>：趨勢動能持續增強（${prevADX.toFixed(1)} → ${lastADX.toFixed(1)}）`
        : adxDir === 'down'
        ? `<strong>ADX 下降</strong>：趨勢動能開始減弱（${prevADX.toFixed(1)} → ${lastADX.toFixed(1)}）`
        : `<strong>ADX 持平</strong>：趨勢動能等速`,
      sub: adxDir === 'down' && adxStrong
        ? '⚠️ ADX 高位回落，趨勢可能進入修正或轉換期'
        : adxDir === 'up' && !adxWeak
        ? '趨勢正在加速確立，跟著方向做效果最好'
        : adxWeak ? '盤整期 DMI 訊號雜訊多，以 KD/RSI 為主' : '',
      whyTitle: '為什麼 ADX 方向比數值更重要？',
      why: 'ADX 的方向（是否在走高）往往比絕對數值更重要。ADX 從低位（15→20→25）持續走高，代表趨勢正在成形，這時跟方向做效果最好。ADX 從高位（35→30→25）持續下滑，代表趨勢正在消退，即使方向訊號仍在，也要謹慎不要重押。',
    });

    // ── 條件 5：DI 差距動能 ──
    const diDiffAccel = diDiff - diDiffPrev;
    items.push({
      ok: (lastPlus > lastMinus) ? diDiffAccel > 0 : diDiffAccel < 0,
      text: `<strong>DI 差距動能</strong>：多空力道差 ${diDiff > 0 ? '+' : ''}${diDiff.toFixed(1)}（${diDiffAccel > 0 ? '差距擴大，動能加速' : diDiffAccel < 0 ? '差距縮小，動能減弱' : '差距持平'}）`,
      sub: `本根差距 ${diDiff.toFixed(1)} vs 前根 ${diDiffPrev.toFixed(1)}（變化 ${diDiffAccel > 0 ? '+' : ''}${diDiffAccel.toFixed(1)}）`,
      whyTitle: '為什麼 DI 差距動能重要？',
      why: '+DI 與 -DI 之間的差距（DI Spread）擴大代表主導方向的力道在加強；差距縮小代表多空力道趨於均衡，主導趨勢可能正在轉換。這是比交叉更早出現的「早期警訊」。',
    });

    // ── 綜合訊號 ──
    let signal, score;
    const bullDir = lastPlus > lastMinus;

    if (bullDir && adxStrong && crossBull) {
      signal = { name: '多頭確認突破', icon: '🧭', stars: 5,
        desc: 'ADX≥25 + +DI>-DI + 多頭交叉，趨勢確立且方向明確，最強多頭訊號。' };
      score = 5;
    } else if (!bullDir && adxStrong && crossBear) {
      signal = { name: '空頭確認突破', icon: '📉', stars: 5,
        desc: 'ADX≥25 + -DI>+DI + 空頭交叉，趨勢確立且方向向下，明確空頭訊號。' };
      score = 1;
    } else if (bullDir && adxStrong && adxDir === 'up') {
      signal = { name: '多頭趨勢延伸', icon: '🔵', stars: 4,
        desc: 'ADX≥25 且走高 + +DI>-DI，多頭趨勢強勁延伸中，順勢持多。' };
      score = 4;
    } else if (!bullDir && adxStrong && adxDir === 'up') {
      signal = { name: '空頭趨勢延伸', icon: '🔴', stars: 2,
        desc: 'ADX≥25 且走高 + -DI>+DI，空頭趨勢強勁延伸中，避免逆勢做多。' };
      score = 2;
    } else if (crossBull && !adxWeak) {
      signal = { name: '多頭交叉', icon: '✨', stars: 4,
        desc: '+DI 上穿 -DI，多頭訊號。ADX 尚未到 25，等趨勢確立再加碼。' };
      score = 4;
    } else if (crossBear && !adxWeak) {
      signal = { name: '空頭交叉', icon: '⚡', stars: 2,
        desc: '-DI 上穿 +DI，空頭訊號。ADX 未到 25，可能是過渡期雜訊。' };
      score = 2;
    } else if (adxWeak) {
      signal = { name: '盤整無趨勢', icon: '⏸', stars: 2,
        desc: `ADX ${lastADX.toFixed(1)} < 20，市場盤整中，DMI 訊號不可靠，以 KD/RSI 為主。` };
      score = 2;
    } else if (bullDir && adxDir === 'up') {
      signal = { name: '趨勢醞釀中', icon: '🟡', stars: 3,
        desc: '+DI>-DI 且 ADX 走高，多頭趨勢正在成形，等 ADX 站上 25 確認。' };
      score = 3;
    } else {
      signal = { name: '方向觀望', icon: '⏸', stars: 2,
        desc: 'DMI 方向不明確或 ADX 減弱中，等待更清晰的趨勢訊號。' };
      score = 2;
    }

    return {
      score, signal, items,
      raw: { lastPlus, lastMinus, lastADX, prevPlus, prevMinus, prevADX,
             crossBull, crossBear, adxStrong, adxVStrong, adxWeak, adxDir,
             diDiff, diDiffPrev, diDiffAccel, bullDir, lastClose, n,
             plusDI, minusDI, adx },
    };
  },

  getLegendRows(ev) {
    if (!ev.raw) return [];
    const fmt = v => v?.toFixed(1) ?? '—';
    return [
      { id: 'dmi-plus',  name: '🔴 +DI',  value: fmt(ev.raw.lastPlus),  color: '#ef5350',
        tooltip: '正方向指標，反映上漲力道' },
      { id: 'dmi-minus', name: '🟢 -DI',  value: fmt(ev.raw.lastMinus), color: '#26a69a',
        tooltip: '負方向指標，反映下跌力道' },
      { id: 'dmi-adx',   name: '🟡 ADX',  value: fmt(ev.raw.lastADX),   color: '#f59e0b',
        tooltip: 'ADX 趨勢強度，≥25 代表有趨勢，<20 代表盤整' },
    ];
  },

  renderBadge(ev, id) {
    if (!ev.signal) return `<span class="fs-mini-badge" data-mod="${id}">🧭 DMI</span>`;
    const stars = '⭐'.repeat(ev.signal.stars);
    return `<span class="fs-mini-badge" data-mod="${id}" title="${ev.signal.desc}">
      <span>${ev.signal.icon} ${ev.signal.name}</span>
      <span class="fs-mini-stars">${stars}</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw) {
      return `<div class="fs-deep-module-head">
        <span class="fs-icon">🧭</span>
        <span class="fs-title">DMI 趨向指標</span>
      </div>
      <div class="fs-deep-module-body">
        <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 30 根 K 線才能計算 DMI）</p>
      </div>`;
    }

    const r    = ev.raw;
    const fmt  = v => v?.toFixed(1) ?? '—';
    const fmt2 = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    const stars = '⭐'.repeat(ev.signal.stars);
    const code  = AppState.activeCode || '';

    // ADX 強度 bar（視覺化）
    const adxPct = Math.min(r.lastADX / 60 * 100, 100);
    const adxColor = r.lastADX >= 40 ? '#f59e0b' : r.lastADX >= 25 ? '#34d399' : '#8a8f99';

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🧭</span>
        <span class="fs-title">DMI 趨向指標</span>
        <span class="fs-subtitle">Directional Movement Index · +DI / -DI / ADX(14) 綜合判讀</span>
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
          <h4>📍 DMI 當前數值</h4>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(239,83,80,0.18);color:#fca5a5">+DI</span>
            <span class="fs-keylevel-price">${fmt(r.lastPlus)}</span>
            <span class="fs-keylevel-desc">上漲力道　${r.lastPlus > r.lastMinus ? '✅ 多頭占優' : '❌ 弱於 -DI'}</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(38,166,154,0.18);color:#6ee7b7">-DI</span>
            <span class="fs-keylevel-price">${fmt(r.lastMinus)}</span>
            <span class="fs-keylevel-desc">下跌力道　DI 差距 ${fmt2(r.diDiff)}（${r.diDiffAccel > 0 ? '↑ 擴大' : r.diDiffAccel < 0 ? '↓ 縮小' : '→ 持平'}）</span>
          </div>
          <div class="fs-keylevel-row">
            <span class="fs-keylevel-tag" style="background:rgba(245,158,11,0.18);color:#fbbf24">ADX</span>
            <span class="fs-keylevel-price" style="color:${adxColor}">${fmt(r.lastADX)}</span>
            <span class="fs-keylevel-desc">${r.adxVStrong ? '🔥 強趨勢' : r.adxStrong ? '✅ 趨勢確立' : r.adxWeak ? '⚪ 盤整無趨勢' : '🟡 趨勢醞釀'}　${r.adxDir === 'up' ? '↑ 走強' : r.adxDir === 'down' ? '↓ 減弱' : '→ 持平'}</span>
          </div>
          <!-- ADX 強度視覺 bar -->
          <div style="padding:8px 14px 4px;font-size:11px;color:var(--muted)">
            ADX 強度　<span style="color:${adxColor};font-weight:600">${fmt(r.lastADX)}</span>
            <div style="margin-top:4px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${adxPct}%;background:${adxColor};border-radius:3px;transition:width 0.3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;font-size:10px">
              <span>0 盤整</span><span>20</span><span>25 趨勢</span><span>40 強勢</span><span>60</span>
            </div>
          </div>
        </div>

        <div class="fs-action-guide">
          <div class="fs-action-guide-head">🎯 該怎麼操作 — 根據 ${ev.signal.icon} ${ev.signal.name} 訊號</div>
          <div class="fs-action-guide-body">
            ${_dmiActionRows(ev).map(row => `
              <div class="fs-action-row">
                <span class="fs-action-label">${row.label}</span>
                <span class="fs-action-detail">${row.detail}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="fs-teach" style="margin-top:22px">

          <div class="fs-teach-section">
            <h4>━━━ 🧭 DMI 指標原理 ━━━</h4>
            <p><strong>+DI（正方向指標）</strong>：衡量上漲力道，由每日高點的上漲幅度計算</p>
            <p><strong>-DI（負方向指標）</strong>：衡量下跌力道，由每日低點的下跌幅度計算</p>
            <p><strong>ADX（平均趨向指數）</strong>：衡量趨勢「強度」，不管方向。由 DX（+DI 與 -DI 的差距比率）的 Wilder 平滑均值計算</p>
            <p style="margin-top:8px">關鍵：DMI 告訴你「有沒有趨勢」（ADX）和「往哪個方向」（+DI vs -DI），兩個資訊缺一不可。</p>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ 🎯 ADX 四大區間 ━━━</h4>
            <ul>
              <li><strong>ADX < 20（盤整）</strong>：市場無明確趨勢，DMI 交叉訊號不可靠，改用 KD/RSI</li>
              <li><strong>ADX 20~25（醞釀）</strong>：趨勢初現，訊號開始有意義，可小量試單</li>
              <li><strong>ADX ≥ 25（趨勢確立）</strong>：有明確趨勢，跟著 +DI/-DI 方向做，DMI 最有效的區間</li>
              <li><strong>ADX ≥ 40（強趨勢）</strong>：趨勢極強，但要留意過熱後的均值回歸</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚡ 使用 DMI 的正確姿勢 ━━━</h4>
            <ul>
              <li><strong>第一步看 ADX</strong>：ADX < 20 就不看交叉訊號，用震盪指標代替</li>
              <li><strong>第二步看方向</strong>：ADX ≥ 25 後，+DI > -DI = 做多；-DI > +DI = 不做多</li>
              <li><strong>交叉是觸發點</strong>：+DI 上穿 -DI + ADX 走高 = 最強進場訊號</li>
              <li><strong>ADX 轉頭是警訊</strong>：ADX 從高位開始下滑，代表趨勢動能衰退，即使方向未變也要謹慎</li>
            </ul>
          </div>

          <div class="fs-teach-section">
            <h4>━━━ ⚠️ 使用限制 ━━━</h4>
            <ul>
              <li><strong>ADX 滯後</strong>：ADX 是雙重平滑，訊號比較慢，趨勢已走了一段才確認</li>
              <li><strong>盤整市完全失效</strong>：ADX < 20 時 +DI/-DI 交叉是假訊號，千萬不要跟單</li>
              <li><strong>不告訴你幅度</strong>：DMI 只說有沒有趨勢和方向，不告訴你會漲多少</li>
              <li><strong>與 MACD 搭配最佳</strong>：DMI 確認趨勢，MACD 看動能，KD 抓進出點，三者互補</li>
            </ul>
          </div>

        </div>

        ${renderAISection('dmi', 'DMI 趨向指標', '🧭', ev, (() => {
          const fmt  = v => v?.toFixed(1) ?? '—';
          const fmt2 = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

          // 近5根 +DI / -DI / ADX 走勢
          const slice = (arr) => arr.slice(-5).map((v, i) => {
            const label = i === 4 ? '【當根】' : `【-${4 - i}根】`;
            return `${label}${v?.toFixed(1)??'—'}`;
          }).join(' → ');

          const itemsSummary = ev.items.map((item, i) => {
            const status = item.ok === true ? '✅達標' : item.ok === false ? '❌未達標' : '⏸中性';
            return `條件${i + 1} ${status}：${item.text.replace(/<[^>]+>/g, '')}`;
          }).join(' | ');
          const passCount = ev.items.filter(i => i.ok === true).length;
          const failCount = ev.items.filter(i => i.ok === false).length;

          return {
            '+DI【上漲力道，正方向指標】': fmt(r.lastPlus),
            '-DI【下跌力道，負方向指標】': fmt(r.lastMinus),
            'DI差距【正=多頭占優，負=空頭占優】': fmt2(r.diDiff),
            'DI差距動能【正=差距擴大，負=差距縮小】': `${fmt2(r.diDiffAccel)}（${r.diDiffAccel > 0 ? '主導方向加速' : r.diDiffAccel < 0 ? '多空力道趨均衡' : '持平'}）`,
            'ADX【趨勢強度，不含方向】': `${fmt(r.lastADX)}（${r.adxVStrong ? '🔥 強趨勢≥40' : r.adxStrong ? '✅ 趨勢確立≥25' : r.adxWeak ? '⚪ 盤整<20' : '🟡 醞釀20~25'}）`,
            'ADX方向【正=走強，負=減弱】': `${fmt2(r.lastADX - r.prevADX)}（${r.adxDir === 'up' ? '↑ ADX走高，趨勢加速' : r.adxDir === 'down' ? '↓ ADX走低，趨勢減弱' : '→ 持平'}）`,
            '近期交叉【+DI/-DI，近3根】': r.crossBull ? '近3根 +DI 上穿 -DI（多頭交叉）'
              : r.crossBear ? '近3根 -DI 上穿 +DI（空頭交叉）' : '近3根無交叉',
            '近5根+DI走勢【由舊到新，最右為當根】': slice(r.plusDI),
            '近5根-DI走勢【由舊到新，最右為當根】': slice(r.minusDI),
            '近5根ADX走勢【由舊到新，最右為當根】': slice(r.adx),
            [`各條件達成狀態【共${ev.items.length}項，✅${passCount}達標 ❌${failCount}未達標】`]: itemsSummary,
            '綜合訊號': `${ev.signal.icon} ${ev.signal.name}（${ev.signal.desc}）`,
          };
        })())}

      </div>
    `;
  },
};

// ── helper：DMI 行動指引列 ──
function _dmiActionRows(ev) {
  const r   = ev.raw;
  const sig = ev.signal.name;
  const fmt = v => v?.toFixed(1) ?? '—';

  if (sig === '多頭確認突破') {
    return [
      { label: '進場建議', detail: `<strong>積極進場</strong>。ADX≥25 + 多頭交叉是 DMI 最高信心訊號，可進 50~70% 部位` },
      { label: '加碼條件', detail: `ADX 持續走高（趨勢加速）且 +DI 差距擴大 → 補足剩餘部位` },
      { label: '停損設置', detail: `ADX 從高位下滑 + -DI 反超 +DI → 減碼；-DI 死亡交叉確認 → 出場` },
      { label: '注意事項', detail: `搭配 MACD 柱狀體確認動能方向，避免在 ADX 已過熱（≥50）時追高` },
    ];
  }
  if (sig === '空頭確認突破') {
    return [
      { label: '操作建議', detail: `<strong>避免做多，多單出場</strong>。ADX≥25 + 空頭交叉是明確空頭訊號` },
      { label: '反彈壓力', detail: `反彈到 +DI 附近（${fmt(r.lastPlus)}）若 ADX 仍高，是再次做空機會` },
      { label: '停損設置', detail: `+DI 反超 -DI（多頭交叉）+ ADX 走高 → 停損` },
      { label: '注意事項', detail: `ADX 越高（≥40）空頭延伸的機率越大，不要輕易逆勢` },
    ];
  }
  if (sig === '多頭趨勢延伸') {
    return [
      { label: '持倉建議', detail: `<strong>多單續抱</strong>，ADX 走高代表趨勢正在加速，順勢持有最有利` },
      { label: '加碼條件', detail: `ADX 每次走高 + +DI 差距繼續擴大 → 可加碼` },
      { label: '停損設置', detail: `ADX 從高位回落超過 3 點 → 開始減碼；-DI 反超 +DI → 全出` },
      { label: '注意事項', detail: `ADX 當前 ${fmt(r.lastADX)}${r.adxVStrong ? '，已進入強趨勢區（≥40），留意均值回歸風險' : '，趨勢健康，可繼續持有'}` },
    ];
  }
  if (sig === '空頭趨勢延伸') {
    return [
      { label: '操作建議', detail: `<strong>不宜做多</strong>，空頭趨勢延伸中，逆勢風險極高` },
      { label: '觀察重點', detail: `ADX 是否開始下滑（趨勢動能衰退），-DI 差距是否開始縮小` },
      { label: '轉多條件', detail: `ADX 下滑至 25 以下 + +DI 黃金交叉 -DI → 才考慮試多` },
      { label: '注意事項', detail: `盤整期不要用 DMI，等 ADX 再次走高才有意義` },
    ];
  }
  if (sig === '盤整無趨勢') {
    return [
      { label: '操作建議', detail: `DMI 訊號<strong>不可靠</strong>，改用 <strong>KD / RSI</strong> 判斷短線高低點` },
      { label: '等待條件', detail: `ADX 從當前 ${fmt(r.lastADX)} 走高突破 25 → DMI 訊號才重新有效` },
      { label: '策略調整', detail: `盤整期以區間高出低進為主，等趨勢確立後再切換回趨勢策略` },
      { label: '注意事項', detail: `盤整越久，突破後趨勢越強。ADX 長期低位（<15）後開始快速走高是重要前兆` },
    ];
  }
  if (sig === '趨勢醞釀中') {
    return [
      { label: '操作建議', detail: `可試單 20~30%，<strong>等 ADX 站上 25 再加碼</strong>` },
      { label: '加碼條件', detail: `ADX 突破 25 + +DI 持續在 -DI 上方 → 確認趨勢，加碼至 60%` },
      { label: '停損設置', detail: `ADX 走高後又掉回 20 以下 → 趨勢未成，出場觀望` },
      { label: '注意事項', detail: `趨勢醞釀期假訊號較多，保持小部位，等確認再動` },
    ];
  }
  // 多頭交叉 / 空頭交叉 / 方向觀望
  return [
    { label: '操作建議', detail: `觀望為主，等待 <strong>ADX 站上 25 + 方向交叉同時確認</strong>再進場` },
    { label: '關鍵觀察', detail: `ADX 是否持續走高（趨勢形成），+DI/-DI 差距是否持續擴大` },
    { label: '停損設置', detail: `若已持倉，-DI 反超 +DI 或 ADX 快速下滑 → 出場` },
    { label: '注意事項', detail: `DMI 在無趨勢市場效果差，搭配 MACD 確認動能方向更可靠` },
  ];
}

registerAnalysisModule(DMIModule);
