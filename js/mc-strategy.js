// js/mc-strategy.js
// ============================================================================
// 操作建議模組 — 對 basket 每檔拉 K 線 + 跑 matchSignals，給出操作建議
// ============================================================================

// ============================================================================
// 訊號 ID → 完整說明字典（供複製給外部 AI 使用）
// ============================================================================
const SIG_DICT = {
  // ── X 系列獨家策略 ──
  'X1': { name:'X1 黃金比例',      emoji:'🪙', desc:'三軸共振（RSI≥60 + 爆量×2 + 站上MA20 + MA20連升），最穩妥進場訊號' },
  'X2': { name:'X2 天黑請閉眼',    emoji:'🌑', desc:'飆股加速確認（10日漲≥15% + 量≥30日均×3 + RSI≥70），妖股主升段最強訊號，實證勝率60%，60天報酬+43%' },
  'X3': { name:'X3 炒底王',        emoji:'🪂', desc:'V型反轉（5日跌≥5% + RSI從<30反彈≥35 + 爆量），抄底訊號' },
  'X4': { name:'X4 何時輪到我',    emoji:'🚦', desc:'族群輪動（同族群≥2檔RSI>70，本股RSI尚在40-60），等族群帶動' },
  'X5': { name:'X5 量證明一切',    emoji:'⚡', desc:'早期爆量介入（近10日均量×2.5 + 10日漲≥10% + RSI≥60 + 站上MA20），比X2早5-10天，固定20天勝率65.5%，報酬+19.4%' },
  // ── W 系列避險警示 ──
  'W6':  { name:'W6 RSI強勢驗證',  emoji:'✅', desc:'多頭核心訊號（RSI≥80），多頭年實證勝率80.2%，為最可靠進場訊號' },
  'W7':  { name:'W7 布林超買',     emoji:'📶', desc:'股價觸及布林通道上軌，強勢延續訊號（多頭年勝率59.2%，非出場訊號）' },
  'W5':  { name:'W5 急跌訊號',     emoji:'⚠️', desc:'出場前兆！出場前3天命中率78%，開始準備出場計畫' },
  'W11': { name:'W11 量縮帶量止跌',emoji:'🔵', desc:'止跌觀察訊號' },
  'W14': { name:'W14 MACD高位死叉',emoji:'⚠️', desc:'出場前兆！出場前5天命中率89%，動能開始衰退，比W5更早出現' },
  'W16': { name:'W16 週KD高檔鈍化',emoji:'📊', desc:'週線強勢鈍化，強勢延續中' },
  // ── S 系列強勢續漲 ──
  'S1':        { name:'S1 量價齊揚',      emoji:'📈', desc:'量增價漲，注意：實證勝率僅47.4%，最常用但實際效果平庸' },
  'S3':        { name:'S3 四線全過',      emoji:'📊', desc:'股價站上MA5/MA10/MA20/MA60四條均線，強勢排列' },
  'S4':        { name:'S4 近期創高',      emoji:'🏆', desc:'突破近期高點，趨勢向上確認' },
  'S5':        { name:'S5 爆量異動',      emoji:'💥', desc:'⚠️ 注意：實證勝率僅29.6%，可能是主力出貨，謹慎判斷' },
  'S_STRONG':  { name:'S_STRONG 強勢不回',emoji:'💪', desc:'強勢股維持高位，不回調特徵' },
  'S11':       { name:'S11 三箭齊發',     emoji:'🎯', desc:'精準轉折訊號（均線+KD+RSI三重確認），實證勝率80%，稀有但強力' },
  'S14':       { name:'S14 強勢鈍化',     emoji:'🔒', desc:'KD/RSI高檔鈍化，強勢延續，勝率63%（與W6高度相關）' },
  'S31':       { name:'S31 GMMA多頭',     emoji:'🌈', desc:'顧比移動平均線多頭排列（12條EMA全部向上）' },
  'S32':       { name:'S32 SAR多頭翻轉', emoji:'🔄', desc:'拋物線SAR由空翻多' },
  'S33':       { name:'S33 EMA黃金交叉', emoji:'✨', desc:'EMA5穿越EMA20向上，ADX>20確認趨勢' },
  'S36':       { name:'S36 EMA多頭加速', emoji:'🚀', desc:'EMA5>EMA20且ADX>25，趨勢強勢加速' },
  'S40':       { name:'S40 紅三兵',       emoji:'🕯️', desc:'⚠️ 連三根紅K確認。作為進場訊號勝率僅29.6%（是出場訊號！）；作為出場訊號時W6策略平均報酬+59.9%' },
  // ── 一目均衡表系列 ──
  'S_ICHI_CLOUD':    { name:'一目均衡表：站上雲層',    emoji:'☁️', desc:'股價站上一目均衡表雲層，長線多頭結構確認' },
  'S_ICHI_3GOOD':    { name:'一目均衡表：三重利多',    emoji:'⛅', desc:'轉換線>基準線+股價在雲上+遲行線在K線上，三重利多共振' },
  'S_ICHI_TK_CROSS': { name:'一目均衡表：轉換線穿越',  emoji:'🌤️', desc:'轉換線由下往上穿越基準線，短線動能轉強訊號' },
};

// 複製時展開所有訊號說明
function _expandSignals(sigIds) {
  if (!sigIds || !sigIds.length) return '  （無訊號）';
  
  // 分類
  const xSeries  = sigIds.filter(id => id.startsWith('X'));
  const wSeries  = sigIds.filter(id => id.startsWith('W'));
  const sSeries  = sigIds.filter(id => id.startsWith('S') || id.startsWith('S_'));
  
  const lines = [];
  
  if (xSeries.length) {
    lines.push('  ⭐ 獨家訊號（X系列）:');
    xSeries.forEach(id => {
      const d = SIG_DICT[id];
      lines.push(`    ${d?.emoji ?? '•'} ${d?.name ?? id}: ${d?.desc ?? id}`);
    });
  }
  if (wSeries.length) {
    lines.push('  ⚡ 警示/確認訊號（W系列）:');
    wSeries.forEach(id => {
      const d = SIG_DICT[id];
      lines.push(`    ${d?.emoji ?? '•'} ${d?.name ?? id}: ${d?.desc ?? id}`);
    });
  }
  if (sSeries.length) {
    lines.push('  📈 技術訊號（S系列）:');
    sSeries.forEach(id => {
      const d = SIG_DICT[id];
      lines.push(`    ${d?.emoji ?? '•'} ${d?.name ?? id}: ${d?.desc ?? id}`);
    });
  }
  
  return lines.join('\n');
}

// 複製報告時的系統說明頭部（讓外部AI看得懂）
const REPORT_HEADER_FOR_AI = `【台股選股系統 — 訊號說明背景】
本報告由自建台股分析系統產生，所有訊號代碼基於歷史回測實證（2025~2026年多頭市場）。

核心策略（按重要性排序）:
  W6 RSI強勢驗證    = 實證勝率80.2%，多頭年最可靠進場訊號
  S11 三箭齊發      = 實證勝率80%，精準但稀有
  X2 天黑請閉眼     = 妖股飆升確認，60天報酬+43%
  X5 量證明一切     = 早期爆量，20天勝率65.5%
  X1 黃金比例       = 三軸共振，最穩定
  S40 紅三兵        = ⚠️ 作為進場訊號勝率僅29.6%！是出場訊號，不是進場

操作系統:
  系統A 抱長: X2確認進場 → 60天甜蜜點 +43~53%，等跌破MA20出場
  系統B 快打: X5進場 → 固定20天，勝率65.5%，報酬+19.4%
  W6 高波動: W6進場 → 抱長（報酬來自長抱，S40只是出場觸發點），整段平均報酬+59.9%（注意：S40本身進場勝率僅29.6%，勿混淆）
  出場警示: W5（前3天命中78%）/W14（前5天命中89%）出現 → 準備出場

術語說明:
  妖股 = 短期暴漲型台股，通常有爆量 + RSI超買特徵
  X2天黑 = 進場訊號，閉眼持有等主力拉抬（因主力建倉完成才會有這個形態）
  S40紅三兵 = 連三根紅K，作為出場訊號（散戶追入時主力倒貨）
`;


const STRATEGY_EVIDENCE = {
  'W6':  { label: 'W6 RSI強勢驗證', winRate: 0.802, ret20d: 0.156, ret60d: 0.532, note: '多頭年核心訊號' },
  'S11': { label: 'S11 三箭齊發',   winRate: 0.800, ret20d: 0.072, ret60d: null,  note: '稀有但精準' },
  'X2':  { label: 'X2 天黑請閉眼',  winRate: 0.600, ret20d: 0.134, ret60d: 0.437, note: '飆股加速確認' },
  'X1':  { label: 'X1 黃金比例',    winRate: null,  ret20d: null,  ret60d: null,  note: '三軸共振' },
  'X5':  { label: 'X5 量證明一切',  winRate: 0.655, ret20d: 0.194, ret60d: null,  note: '早期爆量介入' },
  'S40': { label: 'S40 紅三兵',     winRate: 0.296, ret20d: 0.041, ret60d: null,  note: '⚠️ 進場勝率29.6%，是出場訊號' },
  'W5':  { label: 'W5 急跌訊號',    note: '出場前兆，前3天命中率78%' },
  'W14': { label: 'W14 MACD死叉',   note: '出場前兆，前5天命中率89%' },
};

const EXIT_EVIDENCE = {
  'fixed-20d':  { label: '固定 20 天' },
  'break-ma20': { label: '跌破 MA20' },
  's40-exit':   { label: 'S40 紅三兵出場' },
};

// ============================================================================
// 主入口：開啟操作建議面板
// ============================================================================
export async function openStrategyPanel(customBasket, lastResult, refs) {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { fetchHistory, toYahooSymbol } = await import('./api.js');
  const { matchSignals } = await import('./signal-scan.js');

  // basket 來源
  const code = refs?.getCode?.() ?? null;
  const basket = (customBasket && customBasket.length > 0)
    ? customBasket
    : (code ? [{ code, name: refs?.getName?.() ?? code, type: '當前個股' }] : []);

  if (!basket.length) {
    panel.style.display = '';
    panel.innerHTML = `<div class="mc-bt-error">⚠️ 請先設定自選標的或開啟一檔個股</div>`;
    return;
  }

  // 顯示進度面板
  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎯 操作建議 — 拉取 K 線中...</span>
        <span class="mc-bt-meta" id="mcStratMeta">共 ${basket.length} 檔</span>
      </div>
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar">
        <div class="mc-cross-progress-fill" id="mcStratFill" style="width:0%"></div>
      </div>
      <div class="mc-cross-progress-text" id="mcStratText">準備中...</div>
    </div>
  `;

  // 逐檔拉 K 線 + 跑訊號
  const results = [];
  for (let i = 0; i < basket.length; i++) {
    const s = basket[i];
    const fill = document.getElementById('mcStratFill');
    const text = document.getElementById('mcStratText');
    if (fill) fill.style.width = `${((i + 1) / basket.length) * 100}%`;
    if (text) text.textContent = `${i+1}/${basket.length} — ${s.code} ${s.name}`;

    let candles = null;
    let activeSigs = [];
    let fetchErr = null;

    try {
      const sym = toYahooSymbol(s.code);
      candles = await fetchHistory(sym, '1y');
    } catch (e) {
      fetchErr = e.message;
    }

    if (candles && candles.length >= 30) {
      try {
        const sigs = matchSignals(candles, null, {});
        activeSigs = (sigs ?? []).map(s => s.id ?? s).filter(Boolean);
      } catch {}
    }

    results.push(_analyzeStock(s, activeSigs, candles, lastResult));

    // 每檔間隔 350ms 避 429
    if (i < basket.length - 1) await new Promise(r => setTimeout(r, 350));
  }

  const overall   = _calcOverallAdvice(results);
  const reportTxt = _buildReportText(results, overall, basket);
  _renderStrategyPanel(panel, results, overall, reportTxt, basket);
}

// ============================================================================
// 分析單一股票（已有 candles + activeSigs）
// ============================================================================
function _analyzeStock(stock, activeSigs, candles, lastResult) {
  const { code, name } = stock;

  const has = (id) => activeSigs.includes(id);
  const hasW6  = has('W6'),  hasX2 = has('X2'), hasX1 = has('X1');
  const hasX5  = has('X5'),  hasS11= has('S11'), hasS40= has('S40');
  const hasW5  = has('W5'),  hasW14= has('W14');

  // 年化波動率（從 K 線算）
  let annualVol = null;
  if (candles && candles.length >= 20) {
    try {
      const closes  = candles.slice(-60).map(c => c.close);
      const logRets = closes.slice(1).map((c,i) => Math.log(c / closes[i]));
      const mean    = logRets.reduce((s,r) => s+r, 0) / logRets.length;
      const std     = Math.sqrt(logRets.reduce((s,r) => s+(r-mean)**2, 0) / logRets.length);
      annualVol     = +(std * Math.sqrt(252) * 100).toFixed(1);
    } catch {}
  }

  // 若是當前個股且有 simMeta，用 simMeta 的值覆蓋（更準）
  if (lastResult?._simMeta?.code === code && lastResult._simMeta.annualVol != null) {
    annualVol = lastResult._simMeta.annualVol;
  }

  const isHighVol = annualVol != null ? annualVol > 40 : (hasX2 || hasX5);
  // ⚠️ 妖股系統A 必須有 X2（飆股加速確認），X1+X5 不夠
  const isYaogu      = hasX2;
  // 早期妖股：有 X5 但還沒 X2（等升格）
  const isEarlyYaogu = hasX5 && !hasX2;
  // X1 單獨：三軸共振但非妖股，搭配 W6 或其他
  const hasX1only    = hasX1 && !hasX2 && !hasX5;
  const isExitWarn   = hasW5 || hasW14;
  const hasBadS40    = hasS40 && !hasX2; // S40 單獨出現，是倒貨訊號

  // 有多個強勢技術訊號但沒有主要訊號
  const techBull = activeSigs.filter(s =>
    ['S31','S32','S33','S_ICHI_CLOUD','S_ICHI_3GOOD','S_ICHI_TK_CROSS','S36','S3'].includes(s)
  ).length >= 3;

  // 推薦系統
  let system, exitRule, urgency;
  if (isExitWarn)       { urgency='exit-warn'; system='exit';       exitRule='break-ma20'; }
  else if (isYaogu)     { urgency='entry';     system='A';          exitRule='s40-exit'; }    // X2妖股→S40出場
  else if (hasS11)      { urgency='entry';     system='S11';        exitRule='fixed-20d'; }
  else if (hasW6 && isHighVol) { urgency='entry'; system='W6-high'; exitRule='s40-exit'; }
  else if (hasW6)       { urgency='entry';     system='W6-mid';     exitRule='break-ma20'; }
  else if (isEarlyYaogu && hasX1) { urgency='watch'; system='X1-watch'; exitRule=null; } // X1+X5→等X2確認，不急進
  else if (isEarlyYaogu){ urgency='entry';     system='B';          exitRule='fixed-20d'; }   // 純X5未升X2→快打
  else if (hasX1only)   { urgency='watch';     system='X1-watch';  exitRule=null; }           // X1等配對
  else if (hasBadS40)   { urgency='normal';    system='S40-warn';  exitRule=null; }
  else if (techBull)    { urgency='watch';     system='tech-bull'; exitRule=null; }           // 多技術訊號等主要
  else if (activeSigs.length > 0) { urgency='watch'; system='watch'; exitRule=null; }
  else                  { urgency='normal';    system='none';      exitRule=null; }

  // 最近健康度快速指標（5日漲跌）
  let recentChg = null;
  if (candles && candles.length >= 6) {
    const last  = candles[candles.length - 1].close;
    const prev5 = candles[candles.length - 6].close;
    recentChg = +((last - prev5) / prev5 * 100).toFixed(1);
  }

  return { code, name, annualVol, isHighVol, isYaogu, isEarlyYaogu,
           isExitWarn, activeSigs, system, exitRule, urgency, recentChg,
           hasCandles: !!(candles && candles.length >= 30) };
}

// ============================================================================
// 整體建議
// ============================================================================
function _calcOverallAdvice(results) {
  const exitCount  = results.filter(r => r.urgency === 'exit-warn').length;
  const entryCount = results.filter(r => r.urgency === 'entry').length;
  const yaoguCount = results.filter(r => r.isYaogu).length;
  const noSigCount = results.filter(r => r.system === 'none').length;
  const noDataCount= results.filter(r => !r.hasCandles).length;

  let summary, color;
  if (exitCount > results.length * 0.4) {
    summary = `⚠️ ${exitCount} 檔出現出場前兆，整體偏謹慎`;
    color = '#f87171';
  } else if (entryCount > results.length * 0.5) {
    summary = `🚀 ${entryCount} 檔有進場訊號${yaoguCount ? `，其中 ${yaoguCount} 檔妖股` : ''}`;
    color = '#4ade80';
  } else if (entryCount > 0) {
    summary = `📊 ${entryCount} 檔有訊號，其餘觀望`;
    color = '#fbbf24';
  } else if (noDataCount > 0) {
    summary = `⚠️ ${noDataCount} 檔無法取得 K 線`;
    color = '#f87171';
  } else {
    summary = `⏳ ${noSigCount} 檔無明顯訊號，整體宜觀望`;
    color = '#8a8f99';
  }
  return { summary, color, exitCount, entryCount, yaoguCount, noSigCount };
}

// ============================================================================
// 渲染面板
// ============================================================================
function _renderStrategyPanel(panel, results, overall, reportTxt, basket) {
  const urgencyOrder = { 'exit-warn':0, 'entry':1, 'watch':2, 'normal':3 };
  const sorted = [...results].sort((a,b) =>
    (urgencyOrder[a.urgency]??9) - (urgencyOrder[b.urgency]??9));

  const rows = sorted.map(r => _renderRow(r)).join('');

  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎯 操作建議 — ${basket.length} 檔</span>
        <span class="mc-bt-meta" style="color:${overall.color}">${overall.summary}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="mc-bt-copy-btn" id="mcStratCopyBtn">📋 複製建議</button>
        <button class="mc-bt-close" id="mcStratClose">✕</button>
      </div>
    </div>

    <div class="mc-strat-legend">
      <span class="mc-strat-badge exit-warn">⚠️ 出場警示</span>
      <span class="mc-strat-badge entry">🚀 進場訊號</span>
      <span class="mc-strat-badge watch">👀 觀察中</span>
      <span class="mc-strat-badge none">⏳ 無訊號</span>
    </div>

    <div class="mc-strat-table-wrap">
      <table class="mc-strat-table">
        <thead>
          <tr>
            <th>代號/名稱</th>
            <th>5日漲跌</th>
            <th>當前訊號</th>
            <th>建議操作</th>
            <th>推薦出場</th>
            <th>實證報酬</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="mc-strat-systems">
      <div class="mc-strat-sys-title">📚 操作系統說明</div>
      ${_renderSystemLegend()}
    </div>

    <div class="mc-bt-footnote">
      ⚠️ 操作建議基於歷史回測數據（1年多頭），不構成投資建議。樣本 &lt; 20 次者可信度較低。
    </div>
  `;

  panel.querySelector('#mcStratClose')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });
  panel.querySelector('#mcStratCopyBtn')?.addEventListener('click', () => {
    const btn = panel.querySelector('#mcStratCopyBtn');
    navigator.clipboard.writeText(reportTxt).then(() => {
      if (btn) { btn.textContent = '✅ 已複製！'; setTimeout(() => { btn.textContent = '📋 複製建議'; }, 2500); }
      // 跳出說明視窗
      _showCopyNotice();
    }).catch(() => { if (btn) btn.textContent = '❌ 複製失敗'; });
  });
}

function _renderRow(r) {
  const urgencyColor = { 'exit-warn':'#f87171','entry':'#4ade80','watch':'#fbbf24','normal':'#8a8f99' }[r.urgency]??'#8a8f99';
  const dot = `<span class="mc-strat-dot" style="background:${urgencyColor}"></span>`;

  // 5日漲跌
  const chgCell = r.recentChg != null
    ? `<td style="color:${r.recentChg>=0?'#ef5350':'#26a69a'};font-weight:600">${r.recentChg>=0?'+':''}${r.recentChg}%</td>`
    : `<td style="color:#555b66">—</td>`;

  // 訊號 chip（沒 K 線顯示提示）
  let sigCell;
  if (!r.hasCandles) {
    sigCell = `<td><span style="color:#f87171;font-size:11px">⚠️ K線失敗</span></td>`;
  } else if (r.activeSigs.length === 0) {
    sigCell = `<td><span style="color:#555b66;font-size:11px">—</span></td>`;
  } else {
    const chips = r.activeSigs.map(sig => {
      const isWarn = ['W5','W14','S40'].includes(sig);
      const isStrong = ['X2','X1','W6','S11','X5'].includes(sig);
      const cls = isWarn ? 'mc-strat-sig-warn' : isStrong ? 'mc-strat-sig-ok' : 'mc-strat-sig-neutral';
      return `<span class="mc-strat-sig ${cls}">${sig}</span>`;
    }).join('');
    sigCell = `<td class="mc-strat-sigs">${chips}</td>`;
  }

  const { opLabel, opColor } = _getOpLabel(r);
  const exitLabel = r.exitRule ? (EXIT_EVIDENCE[r.exitRule]?.label ?? r.exitRule) : '—';
  const retLabel  = _getBestRetLabel(r);

  return `
    <tr class="mc-strat-row mc-strat-row-${r.urgency}">
      <td>
        ${dot}
        <span class="mc-strat-code">${r.code}</span>
        <span class="mc-strat-name">${r.name}</span>
        ${r.annualVol!=null?`<br><span class="mc-strat-vol">年化 ${r.annualVol}%${r.isHighVol?' 🔴高波動':''}</span>`:''}
      </td>
      ${chgCell}
      ${sigCell}
      <td style="color:${opColor};font-size:12px;font-weight:600">${opLabel}</td>
      <td style="font-size:11.5px;color:var(--muted)">${exitLabel}</td>
      <td style="font-size:11.5px">${retLabel}</td>
    </tr>
  `;
}

function _getOpLabel(r) {
  const map = {
    'exit':      { opLabel:'⚠️ 準備出場',          opColor:'#f87171' },
    'A':         { opLabel:'🔥 抱長 60天（X2妖股）',opColor:'#ef5350' },
    'B':         { opLabel:'⚡ X5快打 20天，等X2升格',opColor:'#fb923c' },
    'S11':       { opLabel:'🎯 精準進場（三箭齊發）',opColor:'#4ade80' },
    'W6-high':   { opLabel:'🚀 W6 持長（高波動）',  opColor:'#4ade80' },
    'W6-mid':    { opLabel:'📊 W6 組合進場',        opColor:'#60a5fa' },
    'X1-watch':  { opLabel:'👁️ X1已亮，等X2或W6確認',opColor:'#a78bfa' },
    'tech-bull': { opLabel:'📈 技術多頭，等主要訊號',opColor:'#fbbf24' },
    'S40-warn':  { opLabel:'❌ 勿追（S40=倒貨）',   opColor:'#f87171' },
    'watch':     { opLabel:'👀 觀察等訊號',         opColor:'#fbbf24' },
    'none':      { opLabel:'⏳ 暫無訊號',           opColor:'#8a8f99' },
  };
  return map[r.system] ?? { opLabel:'—', opColor:'#8a8f99' };
}

function _getBestRetLabel(r) {
  if (!r.hasCandles) return '<span style="color:#555b66">—</span>';
  if (r.isYaogu)                        return `<span style="color:#ef5350">60天 +43~53%</span>`;
  if (r.activeSigs.includes('W6'))      return `<span style="color:#4ade80">20天+15.6%<br>60天+53.2%</span>`;
  if (r.activeSigs.includes('S11'))     return `<span style="color:#4ade80">20天 +7.2%</span>`;
  if (r.activeSigs.includes('X5'))      return `<span style="color:#fb923c">20天 +19.4%</span>`;
  return '<span style="color:#555b66">—</span>';
}

function _renderSystemLegend() {
  const systems = [
    { icon:'🔥', label:'系統A 抱長',   desc:'X2 確認進場，目標持有 60 天。60天甜蜜點 +53%，需要耐心。' },
    { icon:'⚡', label:'系統B 快打',   desc:'X5 早期爆量進場，固定 20 天出場。勝率 65.5%，報酬 +19.4%。' },
    { icon:'🚀', label:'W6 高波動',    desc:'W6 訊號 + 高波動股，不用雙策略（會過濾最好進場點），S40 出場報酬最高 +59.9%。' },
    { icon:'📊', label:'W6 組合',      desc:'W6 + 中波動，搭配過濾邏輯（91.7% 勝率），跌破 MA20 出場。' },
    { icon:'🎯', label:'S11 三箭齊發', desc:'稀有但精準（勝率 80%），出現必重視，固定 20 天出場。' },
    { icon:'⚠️', label:'出場警示',    desc:'W5/W14 前兆出現，開始準備出場計畫，等跌破 MA20 確認後清倉。' },
  ];
  return systems.map(s => `
    <div class="mc-strat-sys-item">
      <span class="mc-strat-sys-icon">${s.icon}</span>
      <span class="mc-strat-sys-label">${s.label}</span>
      <span class="mc-strat-sys-desc">${s.desc}</span>
    </div>
  `).join('');
}

// ============================================================================
// 複製完成提示視窗
// ============================================================================
function _showCopyNotice() {
  // 避免重複
  document.getElementById('mcCopyNotice')?.remove();

  const el = document.createElement('div');
  el.id = 'mcCopyNotice';
  el.className = 'mc-copy-notice';
  el.innerHTML = `
    <div class="mc-copy-notice-inner">
      <div class="mc-copy-notice-icon">📋</div>
      <div class="mc-copy-notice-text">
        <b>已複製操作建議報告</b>
        <span>報告已附加完整訊號說明（X1/X2/W6 等均有中文解釋），可直接貼給 Gemini、ChatGPT 等 AI 討論</span>
      </div>
      <button class="mc-copy-notice-close" id="mcCopyNoticeClose">✕</button>
    </div>
  `;
  document.body.appendChild(el);

  // 自動消失 5 秒
  const timer = setTimeout(() => el.remove(), 5000);
  el.querySelector('#mcCopyNoticeClose')?.addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
  });

  // 進場動畫
  requestAnimationFrame(() => el.classList.add('mc-copy-notice-in'));
}


// ============================================================================
// 生成可複製純文字報告
// ============================================================================
function _buildReportText(results, overall, basket) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const urgencyOrder = { 'exit-warn':0,'entry':1,'watch':2,'normal':3 };
  const sorted = [...results].sort((a,b) => (urgencyOrder[a.urgency]??9)-(urgencyOrder[b.urgency]??9));

  const lines = [
    REPORT_HEADER_FOR_AI,
    `${'═'.repeat(55)}`,
    `🎯 操作建議報告 ${dateStr}`,
    `分析標的: ${basket.length} 檔 | 整體: ${overall.summary}`,
    '',
    '─'.repeat(55),
  ];

  sorted.forEach(r => {
    const { opLabel } = _getOpLabel(r);
    const exitLabel   = r.exitRule ? (EXIT_EVIDENCE[r.exitRule]?.label ?? r.exitRule) : '—';
    lines.push(`${r.code} ${r.name}${r.annualVol!=null?` (年化${r.annualVol}%)`:''}`);
    if (!r.hasCandles) {
      lines.push('  ⚠️ K線拉取失敗');
    } else {
      lines.push(`  5日漲跌: ${r.recentChg!=null?(r.recentChg>=0?'+':'')+r.recentChg+'%':'—'}`);
      lines.push(`  建議: ${opLabel}  出場: ${exitLabel}`);
      if (r.isExitWarn) lines.push('  ⚠️ 出場前兆已出現，開始準備清倉計畫');
      // 訊號展開說明（讓外部AI看得懂）
      lines.push(_expandSignals(r.activeSigs));
    }
    lines.push('');
  });

  lines.push('─'.repeat(55));
  lines.push('📚 操作系統:');
  lines.push('  系統A 抱長: X2進場→60天甜蜜點+53%，等跌破MA20出場');
  lines.push('  系統B 快打: X5進場→固定20天，勝率65.5%，報酬+19.4%');
  lines.push('  W6 高波動:  W6進場→抱長，【S40紅三兵是出場訊號，不是進場訊號】等到S40出現時出場，整段平均報酬+59.9%（報酬來自抱長，非S40本身）');
  lines.push('  出場警示:   W5/W14→等跌破MA20清倉');
  lines.push('');
  lines.push('⚠️ 以上基於歷史回測，不構成投資建議。');
  return lines.join('\n');
}

// ============================================================================
// 複製模擬摘要（📋 複製模擬 按鈕用）
// ============================================================================
export function buildSimSummary(lastResult, refs, candles) {
  const meta = lastResult?._simMeta;
  if (!meta) return '尚未跑模擬，請先點選「開始模擬」';

  const { code, name, annualVol, simBars, lastClose, s1Price, r1Price, regime, volCoeff } = meta;
  const upper  = lastResult?.upperBand?.[simBars];
  const lower  = lastResult?.lowerBand?.[simBars];
  const midPct = (meta.driftPerBar * simBars * 100).toFixed(2);

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const recent = (candles ?? []).slice(-10).map(c => {
    const chg = ((c.close - c.open) / c.open * 100).toFixed(1);
    const d = new Date(c.time * 1000);
    return `  ${d.getMonth()+1}/${d.getDate()} O:${c.open} H:${c.high} L:${c.low} C:${c.close}(${chg>0?'+':''}${chg}%)`;
  }).join('\n');

  return [
    `📈 蒙地卡羅模擬摘要 ${dateStr}`,
    `${'═'.repeat(50)}`,
    `個股: ${code} ${name}`,
    `現價: ${lastClose}  支撐: ${s1Price??'—'}  壓力: ${r1Price??'—'}`,
    '',
    `模擬設定:`,
    `  模擬根數: ${simBars} 根`,
    `  年化波動率: ${annualVol}%  Regime: ${regime}  量能係數: ${volCoeff}`,
    '',
    `${simBars} 根後機率區間:`,
    `  上界(95%): ${upper!=null?upper.toFixed(2):'—'}`,
    `  中線預期: ${midPct>=0?'+':''}${midPct}%`,
    `  下界(5%):  ${lower!=null?lower.toFixed(2):'—'}`,
    '',
    `近 10 根 K 線:`,
    recent,
    '',
    `${'─'.repeat(50)}`,
    `⚠️ 此為機率模擬非預測，請結合基本面籌碼面判斷。`,
  ].join('\n');
}
