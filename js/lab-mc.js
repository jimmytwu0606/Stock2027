/**
 * lab-mc.js — MC 模擬子模組
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { dengToast } from './loading-deng.js';
import { resolveCode, tsToDate } from './lab-utils.js';

// ── MC 模擬（搬遷自 monte-carlo.js）──────────────────────────────────────
function _bindMCRun() {
  document.getElementById('labRunMC')?.addEventListener('click', _runMC);
  document.getElementById('labMCCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _runMC();
  });
}

async function _runMC() {
  const _mcInput = (document.getElementById('labMCCodeInput')?.value ?? '').trim();
  const codeRaw = resolveCode(_mcInput);
  const simBars = parseInt(document.getElementById('labMCBarsSelect')?.value ?? '10');

  if (!codeRaw) { dengToast('請輸入股票代號或名稱'); return; }

  const resultEl   = document.getElementById('labMCResult');
  const emptyEl    = document.getElementById('labMCEmpty');
  const runBtn     = document.getElementById('labRunMC');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressText = document.getElementById('labProgressText');

  runBtn.disabled = true;
  emptyEl.style.display  = 'none';
  resultEl.style.display = 'none';
  progressEl.style.display = '';
  progressBar.style.width  = '15%';
  progressText.textContent = `載入 ${codeRaw} K 線...`;

  try {
    const symbol = toYahooSymbol(codeRaw);
    progressBar.style.width  = '40%';
    progressText.textContent = '拉取 1 年 K 線...';

    let candles = await fetchHistoryCached(symbol, '1y', { allowStale: false });
    if (!candles || candles.length < 30) {
      candles = await fetchHistoryCached(codeRaw + '.TWO', '1y', { allowStale: false }).catch(() => null);
    }
    if (!candles || candles.length < 30) throw new Error('K 線資料不足');

    progressBar.style.width  = '65%';
    progressText.textContent = `執行 500 條路徑 MC 模擬...`;

    await new Promise(r => requestAnimationFrame(r));

    // 動態 import mc-backtest 核心公式
    const { runMcBacktest } = await import('./mc-backtest.js');
    const { computeForecastCenter } = await import('./monte-carlo.js');
    const result = runMcBacktest(candles, { withPattern: false });

    // 用最新 K 線跑一次預測，取得當前方向和幅度
    const forecast = computeForecastCenter(candles, 20, { withPattern: false });

    progressBar.style.width  = '100%';
    progressText.textContent = '完成';

    await new Promise(r => setTimeout(r, 200));
    progressEl.style.display = 'none';

    const name = getChineseName(codeRaw) || codeRaw;
    _renderMCResult(resultEl, { code: codeRaw, name, simBars, candles, result, forecast });
    resultEl.style.display = '';

  } catch (e) {
    progressEl.style.display = 'none';
    emptyEl.style.display    = '';
    dengToast(`MC 模擬失敗：${e.message}`);
    console.error('[lab] MC error:', e);
  } finally {
    runBtn.disabled = false;
  }
}

function _renderMCResult(el, { code, name, simBars, result, forecast }) {
  if (!result?.ok) {
    el.innerHTML = `<div class="lab-empty-state"><p>MC 模擬失敗：${result?.reason ?? '未知錯誤'}</p></div>`;
    return;
  }

  // 命中率 → 色階（50%=基準，低於50%=深綠最差，65%+=紅最精準）
  function _rateToColor(rate) {
    // 低於 50% 直接深綠（比隨機差），50%~65% 漸層，65%+ 紅
    const t = rate < 0.50
      ? Math.max(0, rate / 0.50) * 0.15   // 0~50% 壓縮到色階 0~0.15（深綠區）
      : Math.min(1, 0.15 + (rate - 0.50) / (0.65 - 0.50) * 0.85); // 50%~65%+ 映射到 0.15~1
    const stops = [[15,110,86],[38,166,154],[240,180,41],[230,100,20],[210,35,35]];
    const seg = t * (stops.length - 1);
    const i = Math.min(Math.floor(seg), stops.length - 2);
    const f = seg - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i+1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function _textOnRate(rate) {
    const t = rate < 0.50
      ? Math.max(0, rate / 0.50) * 0.15
      : Math.min(1, 0.15 + (rate - 0.50) / (0.65 - 0.50) * 0.85);
    return (t > 0.25 && t < 0.70) ? '#1a1a1a' : '#fff';
  }

  // ── 當前預測方向和幅度 ──────────────────────────────────────────
  const curPrice = forecast?.startPrice ?? 0;
  const predRows = forecast ? [5, 10, 15, 20].map(N => {
    const predPrice = forecast.prices?.[N];
    if (!predPrice || !curPrice) return null;
    const chgPct = (predPrice - curPrice) / curPrice * 100;
    const isUp   = chgPct >= 0;
    const col    = isUp ? '#ef5350' : '#26a69a';
    const arrow  = isUp ? '▲' : '▼';
    return { N, predPrice, chgPct, col, arrow };
  }).filter(Boolean) : [];

  const predHTML = predRows.length ? `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      ${predRows.map(r => `
        <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:6px;padding:8px 10px;text-align:center">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${r.N} 日後預測</div>
          <div style="font-size:14px;font-weight:500;color:${r.col}">${r.arrow} ${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(1)}%</div>
          <div style="font-size:11px;color:var(--muted)">→ $${r.predPrice.toFixed(2)}</div>
        </div>`).join('')}
    </div>` : '';

  // ── 色塊準確率矩陣 ───────────────────────────────────────────────
  const horizons = result.horizons;
  const NS = [5, 10, 15, 20];
  const colHeaders = ['方向命中率', '完整命中率', 'MAE（越低越好）'];

  // MAE 的色階反轉：mae 小 = 紅（精準），mae 大 = 綠（不準）
  function _maeToColor(mae) {
    const t = Math.max(0, Math.min(1, 1 - (mae - 0.02) / (0.12 - 0.02)));
    const stops = [[15,110,86],[38,166,154],[240,180,41],[230,100,20],[210,35,35]];
    const seg = t * (stops.length - 1);
    const i = Math.min(Math.floor(seg), stops.length - 2);
    const f = seg - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i+1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  const matrixRows = NS.map(N => {
    const h = horizons[N];
    if (!h || h.total === 0) return `
      <tr>
        <td style="color:var(--text);font-weight:500">${N} 日後</td>
        <td colspan="3" style="color:var(--muted);text-align:center">資料不足</td>
      </tr>`;
    const dirBg  = _rateToColor(h.dirRate);
    const dirTc  = _textOnRate(h.dirRate);
    const hitBg  = _rateToColor(h.hitRate);
    const hitTc  = _textOnRate(h.hitRate);
    const maeBg  = _maeToColor(h.mae);
    const maeTc  = _textOnRate(1 - (h.mae - 0.02) / 0.10);
    return `<tr>
      <td style="color:var(--text);font-weight:500;padding:4px 8px">${N} 日後</td>
      <td style="padding:3px">
        <div style="background:${dirBg};border-radius:4px;padding:8px 10px;text-align:center" title="${h.dirHit}/${h.total} 次方向正確">
          <div style="font-size:14px;font-weight:600;color:${dirTc}">${(h.dirRate*100).toFixed(0)}%</div>
        </div>
      </td>
      <td style="padding:3px">
        <div style="background:${hitBg};border-radius:4px;padding:8px 10px;text-align:center" title="${h.hit}/${h.total} 次完整命中（方向對且誤差<5%）">
          <div style="font-size:14px;font-weight:600;color:${hitTc}">${(h.hitRate*100).toFixed(0)}%</div>
        </div>
      </td>
      <td style="padding:3px">
        <div style="background:${maeBg};border-radius:4px;padding:6px 10px;text-align:center">
          <div style="font-size:13px;font-weight:600;color:${maeTc}">${(h.mae*100).toFixed(1)}%</div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // 圖例
  const legendStops = [0,0.167,0.333,0.5,0.667,0.833,1].map(t => {
    const s = [5,10,15,20][0];
    const r = 0.48 + t * (0.68 - 0.48);
    return `<div style="flex:1;height:6px;background:${_rateToColor(r)}"></div>`;
  }).join('');

  // ── 五種操作模式建議 ─────────────────────────────────────────────
  const modeHTML = _mcModeAdvice(result, forecast);

  // ── 複製文字 ──────────────────────────────────────────────────────
  const copyText = [
    `${code} ${name} — MC 模擬回測結果`,
    `${result.formula} · ${result.samples} 樣本 · 現價 ${curPrice ? '$' + curPrice.toFixed(2) : '—'}`,
    '',
    '預測漲跌幅：',
    ...predRows.map(r => `  ${r.N}日後：${r.arrow} ${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(1)}% → $${r.predPrice.toFixed(2)}`),
    '',
    '歷史回測準確率：',
    '時間\t方向命中率\t完整命中率\tMAE',
    ...NS.map(N => {
      const h = horizons[N];
      if (!h || h.total === 0) return `${N}日後\t資料不足`;
      return `${N}日後\t${(h.dirRate*100).toFixed(0)}% (${h.dirHit}/${h.total})\t${(h.hitRate*100).toFixed(0)}% (${h.hit}/${h.total})\t${(h.mae*100).toFixed(2)}%`;
    }),
  ].join('\n');

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px">
      <div>
        <div class="lab-result-title" style="border:none;padding:0">${code} ${name} — MC 模擬回測結果</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${result.formula} · ${result.samples} 樣本 · 現價 ${curPrice ? '$' + curPrice.toFixed(2) : '—'}</div>
      </div>
      <button class="lab-copy-btn" id="labMCCopyBtn">⎘ 複製</button>
    </div>
    ${predHTML}
    <div style="font-size:12px;font-weight:500;color:var(--text);margin-bottom:6px">歷史回測準確率</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="padding:4px 8px;text-align:left;color:var(--muted);font-weight:400;white-space:nowrap">時間</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted);font-weight:400">方向命中率</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted);font-weight:400">完整命中率</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted);font-weight:400">MAE 誤差</th>
        </tr></thead>
        <tbody>${matrixRows}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:6px;margin-bottom:14px;font-size:10px;color:var(--muted)">
      <span>弱</span>
      <div style="display:flex;flex:1;height:6px;border-radius:3px;overflow:hidden">${legendStops}</div>
      <span>強</span>
      <span style="margin-left:4px">命中率強度（&lt;50%=差，≥65%=優）</span>
    </div>
    ${modeHTML}
    <div class="lab-result-hint">方向命中率 ≥ 60% 才具顯著預測力；50% 等同隨機。預測為 MC 中線，非保證。</div>
  `;

  document.getElementById('labMCCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(copyText).then(() => {
      const btn = document.getElementById('labMCCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => btn.textContent = '⎘ 複製', 2000); }
    });
  });
}

// ── 操作模式建議 ──────────────────────────────────────────────────────────
function _mcModeAdvice(result, forecast) {
  const h5  = result.horizons[5]  || {};
  const h10 = result.horizons[10] || {};
  const h15 = result.horizons[15] || {};
  const h20 = result.horizons[20] || {};

  const dir5  = h5.dirRate  || 0;
  const dir10 = h10.dirRate || 0;
  const dir15 = h15.dirRate || 0;
  const dir20 = h20.dirRate || 0;
  const mae5  = h5.mae  || 0.99;
  const mae10 = h10.mae || 0.99;
  const mae15 = h15.mae || 0.99;
  const mae20 = h20.mae || 0.99;

  const regime  = forecast?.diag?.regime ?? 'mid';
  const stdDev  = forecast?.stdDev ?? 0.02;
  const annualV = stdDev * Math.sqrt(252) * 100;

  const pred5chg = forecast?.prices?.[5] && forecast?.startPrice
    ? (forecast.prices[5] - forecast.startPrice) / forecast.startPrice * 100
    : null;
  const pred20chg = forecast?.prices?.[20] && forecast?.startPrice
    ? (forecast.prices[20] - forecast.startPrice) / forecast.startPrice * 100
    : null;
  const predUp = pred5chg !== null ? pred5chg >= 0 : null;

  // 找最佳命中率窗口
  const dirMap = { 5: dir5, 10: dir10, 15: dir15, 20: dir20 };
  const bestN   = Object.entries(dirMap).sort((a,b) => b[1]-a[1])[0];
  const bestDir = bestN[1];
  const bestDay = +bestN[0];

  // 趨勢是否隨持有天數遞增（長線型）
  const isLongTrend = dir20 >= dir10 && dir10 >= dir5 && dir20 >= 0.58;
  // 中期節奏：10或15日最高且 ≥ 60%，20日反而下降
  const isMidRhythm = (bestDay === 10 || bestDay === 15) && bestDir >= 0.60 && dir20 < bestDir - 0.05;
  // 短線最強：5日命中率最高且高於其他
  const isShortBest = bestDay === 5 && dir5 >= 0.60 && dir5 > dir20 + 0.03;

  const MODES = [
    {
      name: '短線突破',
      icon: '⚡',
      condition: (isShortBest || (dir5 >= 0.60 && mae5 < 0.08)) && predUp === true,
      holdRange: '3~5 日',
      entry: 'X6 見龍在田、X2 天黑請閉眼、S5 爆量異動',
      exit: 'W6 RSI超買、W14 MACD高位死叉、X2訊號消失',
      reason: `5日命中率 ${(dir5*100).toFixed(0)}% 最強，MAE ${(mae5*100).toFixed(1)}%，短線預測${predUp?'偏多':'偏空'}`,
    },
    {
      name: '中期節奏型',
      icon: '🎯',
      condition: isMidRhythm,
      holdRange: `${bestDay} 日為主`,
      entry: 'S2 均線啟動、S31 DMI趨勢確認、S33 GMMA多頭排列',
      exit: `持有 ${bestDay} 日後主動出場，不等訊號，超過後趨勢易轉`,
      reason: `${bestDay}日命中率 ${(bestDir*100).toFixed(0)}% 最佳，20日（${(dir20*100).toFixed(0)}%）反而下降`,
    },
    {
      name: '波段持有',
      icon: '📈',
      condition: isLongTrend && !isMidRhythm,
      holdRange: '15~20 日',
      entry: 'S33 GMMA多頭排列、S_ICHI_CLOUD 雲帶上行、S4 近期創高',
      exit: 'W12 均線空頭排列、W3 MACD死叉跌破月線、跌破MA20',
      reason: `命中率隨時間遞增（5日${(dir5*100).toFixed(0)}%→20日${(dir20*100).toFixed(0)}%），趨勢延伸性強`,
    },
    {
      name: '超跌反彈',
      icon: '🔄',
      condition: (regime === 'superlow' || regime === 'low') && bestDir >= 0.55 && predUp === true,
      holdRange: '5~10 日',
      entry: 'S6 超賣反彈、S35 乖離超跌、S7 低檔翻多、S9 跌深量縮',
      exit: '反彈至MA20壓力、W6 RSI超買、達到目標漲幅後了結',
      reason: `Regime: ${regime}，超跌反彈行情，最佳${bestDay}日命中率 ${(bestDir*100).toFixed(0)}%`,
    },
    {
      name: '區間震盪',
      icon: '↔️',
      condition: bestDir < 0.55 && annualV < 45,
      holdRange: '輕倉等訊號',
      entry: 'S13 箱型突破、S14 強勢鈍化確認方向後輕倉進場',
      exit: '突破失敗立即停損，以箱頂/箱底為停損參考點',
      reason: `最高命中率僅 ${(bestDir*100).toFixed(0)}%（${bestDay}日），年化波動 ${annualV.toFixed(0)}%，建議輕倉`,
    },
    {
      name: '高波動觀望',
      icon: '⚠️',
      condition: annualV >= 60 || mae20 >= 0.15,
      holdRange: '輕倉短線為主',
      entry: `⚠️ 風險警示：S5 爆量異動、X6 見龍在田（輕倉，嚴設停損）`,
      exit: `觸及停損立即出場，MAE ${(mae20*100).toFixed(1)}% 代表誤差範圍大，建議停損設 3~5%`,
      reason: `年化波動 ${annualV.toFixed(0)}%，20日MAE ${(mae20*100).toFixed(1)}%，模型誤差偏高，操作需控制倉位`,
    },
  ];

  // 若無條件匹配，加中性觀察
  if (!MODES.some(m => m.condition)) {
    MODES.push({
      name: '中性觀察',
      icon: '🔍',
      condition: true,
      holdRange: '等待訊號',
      entry: 'S12 量增底部、XG1 葛蘭碧買一強化、S_ICHI_TK_CROSS TK黃金交叉',
      exit: '進場後以MA20為參考停損，命中率中等需嚴控部位',
      reason: '命中率中等，無明確強勢模式，可輕倉佈局等待訊號確認',
    });
  }

  const rows = MODES.map(m => {
    const isMatch = m.condition;
    const rowBg   = isMatch ? 'background:rgba(239,83,80,.08);' : 'opacity:0.55;';
    const nameCol = isMatch ? '#ef5350' : 'var(--muted)';
    const textCol = isMatch ? 'var(--text)' : 'var(--muted)';
    const badge   = isMatch
      ? `<span style="font-size:10px;background:rgba(239,83,80,.15);color:#ef5350;padding:1px 6px;border-radius:10px;margin-left:5px">符合</span>`
      : '';
    return `<tr style="${rowBg}">
      <td style="padding:7px 8px;white-space:nowrap;color:${nameCol};font-weight:${isMatch?'600':'400'};font-size:13px">${m.icon} ${m.name}${badge}</td>
      <td style="padding:7px 8px;color:${textCol};font-size:12px;white-space:nowrap;font-weight:${isMatch?'500':'400'}">${m.holdRange}</td>
      <td style="padding:7px 8px;color:${isMatch?'#ff9800':'var(--muted)'};font-size:12px;font-weight:${isMatch?'500':'400'}">${m.entry}</td>
      <td style="padding:7px 8px;color:${isMatch?'#4dd0e1':'var(--muted)'};font-size:12px;font-weight:${isMatch?'500':'400'}">${m.exit}</td>
      <td style="padding:7px 8px;color:${isMatch?'var(--text)':'var(--muted)'};font-size:12px">${m.reason}</td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-top:14px">
      <div style="font-size:12px;font-weight:500;color:var(--text);margin-bottom:8px">操作模式建議（符合條件以紅色標示）</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px;border:0.5px solid var(--border);border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:var(--bg2)">
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;white-space:nowrap;font-size:12px">模式</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;white-space:nowrap;font-size:12px">建議持有</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;font-size:12px">進場策略</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;font-size:12px">出場策略</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;font-size:12px">判斷依據</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── 策略比較 ──────────────────────────────────────────────────────────────
// 所有可回測策略（排除 W 系列避險警示、S24~S27 巴菲特需基本面資料）
export { _bindMCRun as bindMCRun };
