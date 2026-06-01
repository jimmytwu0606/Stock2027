/**
 * stock-backtest.js — 個股操作劇本 v3
 * ============================================================================
 * 功能：輸入股票代號 + 觀察起始日，自動生成完整操作劇本時間軸
 *   - 自動偵測首次進場 / 加碼 / 出場訊號
 *   - 使用者自訂停損% + 加碼觸發訊號
 *   - 各事件顯示「若照做至今報酬」
 *
 * Tier：Free（Free 策略）/ Pro（全策略）
 * 入口：openStockBacktestPanel() — 由 monte-carlo.js 呼叫
 * ============================================================================
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { STRATEGIES }   from './strategy.js';
import { matchSignals } from './signal-scan.js';

// ─── 常數 ──────────────────────────────────────────────────────────────────
const WARNING_IDS = new Set([
  'W1','W2','W3','W4','W5','W6','W7','W8','W9','W10',
  'W11','W12','W13','W14','W15','W16','W17','W18','W19','W20',
]);
const EXIT_HARD = new Set(['W1','W3','W4','W18']); // 強出場
const EXIT_WARN = new Set(['W5','W6','W14','W2','W8','W9','W10']); // 警示

// 只列做多類策略供加碼選擇（排除 W 系列、基本面、巴菲特）
const ADD_CANDIDATE_CATS = new Set([
  '強勢續漲','超跌反彈','轉折訊號','葛蘭碧','盤整突破','技術指標','K線型態','X 系列'
]);

// 預設勾選的加碼訊號
const DEFAULT_ADD_IDS = new Set(['S1','S_STRONG','S4','S33','X1','X2','X5']);

const PANEL_ID = 'sbPanel';

// ─── 所有可選策略（依 tier 過濾後渲染）─────────────────────────────────
const ALL_ADD_STRATEGIES = STRATEGIES.filter(s =>
  !WARNING_IDS.has(s.id) &&
  ADD_CANDIDATE_CATS.has(s.category)
);

// ============================================================================
// 對外入口
// ============================================================================
console.log('[stock-backtest] 模組載入 OK');

export function openStockBacktestPanel() {
  console.log('[stock-backtest] openStockBacktestPanel 被呼叫');
  document.getElementById(PANEL_ID)?.remove();
  _buildPanel();
}

// ============================================================================
// 面板建立
// ============================================================================
function _buildPanel() {
  const tier = window.__userTier ?? 'free';

  const el = document.createElement('div');
  el.id        = PANEL_ID;
  el.className = 'sb-panel';

  const d60 = new Date();
  d60.setDate(d60.getDate() - 60);
  const defaultDate = d60.toISOString().slice(0, 10);

  // 產生策略勾選清單
  const strategies = ALL_ADD_STRATEGIES.filter(s =>
    tier === 'pro' ? true : s.tier === 'free'
  );
  const checkboxHtml = strategies.map(s => {
    const checked = DEFAULT_ADD_IDS.has(s.id) ? 'checked' : '';
    return `
      <label class="sb-chk-label" title="${s.name}">
        <input type="checkbox" class="sb-chk" value="${s.id}" ${checked}/>
        <span class="sb-chk-icon">${s.icon}</span>
        <span class="sb-chk-name">${s.name}</span>
      </label>`;
  }).join('');

  el.innerHTML = `
    <div class="sb-header">
      <span class="sb-title">📅 個股操作劇本</span>
      <button class="sb-close-btn" id="sbCloseBtn">✕</button>
    </div>

    <div class="sb-form">
      <div class="sb-form-row">
        <div class="sb-field">
          <label class="sb-label">股票代號</label>
          <input class="sb-input" id="sbCode" type="text" placeholder="如 2454" maxlength="6"/>
        </div>
        <div class="sb-field">
          <label class="sb-label">觀察起始日</label>
          <input class="sb-input" id="sbDate" type="date" value="${defaultDate}"/>
        </div>
        <div class="sb-field">
          <label class="sb-label">停損 %</label>
          <input class="sb-input sb-input-sm" id="sbStopLoss" type="number"
            value="8" min="1" max="30" step="1" style="width:64px"/>
        </div>
        <button class="sb-run-btn" id="sbRunBtn">開始分析</button>
      </div>

      <div class="sb-add-sig-section">
        <div class="sb-label" style="margin-bottom:6px">加碼觸發訊號（可多選）</div>
        <div class="sb-chk-grid" id="sbChkGrid">${checkboxHtml}</div>
      </div>

      <div class="sb-hint" id="sbHint" style="display:none"></div>
    </div>

    <div id="sbResult" style="display:none"></div>
  `;

  const btPanel = document.getElementById('mcBtPanel');
  if (btPanel) {
    btPanel.innerHTML = '';
    btPanel.style.display = '';
    btPanel.appendChild(el);
  } else {
    document.body.appendChild(el);
  }

  el.querySelector('#sbCloseBtn').addEventListener('click', () => {
    el.remove();
    const bp = document.getElementById('mcBtPanel');
    if (bp) bp.style.display = 'none';
  });

  el.querySelector('#sbRunBtn').addEventListener('click', () => {
    console.log('[stock-backtest] 按鈕點擊');
    _onRun();
  });
  el.querySelector('#sbCode').addEventListener('keydown', e => {
    if (e.key === 'Enter') _onRun();
  });
}

// ============================================================================
// 主流程
// ============================================================================
async function _onRun() {
  console.log('[stock-backtest] _onRun 觸發');
  const panelEl = document.getElementById(PANEL_ID);
  if (!panelEl) return;

  const code      = panelEl.querySelector('#sbCode').value.trim().toUpperCase();
  const dateStr   = panelEl.querySelector('#sbDate').value;
  const stopLossPct = parseFloat(panelEl.querySelector('#sbStopLoss').value) || 8;
  const hint      = panelEl.querySelector('#sbHint');
  const result    = panelEl.querySelector('#sbResult');
  const btn       = panelEl.querySelector('#sbRunBtn');

  // 取使用者勾選的加碼訊號
  const addTriggerIds = new Set(
    [...panelEl.querySelectorAll('.sb-chk:checked')].map(c => c.value)
  );

  if (!code)    return _hint(hint, '⚠️ 請輸入股票代號', 'warn');
  if (!dateStr) return _hint(hint, '⚠️ 請選擇觀察起始日', 'warn');
  if (!addTriggerIds.size) return _hint(hint, '⚠️ 請至少勾選一個加碼觸發訊號', 'warn');

  const targetDate = new Date(dateStr);
  const today = new Date(); today.setHours(0,0,0,0);
  if (targetDate >= today) return _hint(hint, '⚠️ 起始日必須早於今天', 'warn');

  const tier = window.__userTier ?? 'free';

  btn.disabled = true; btn.textContent = '分析中...';
  result.style.display = 'none';
  _hint(hint, '⏳ 載入 K 線資料...', 'info');

  try {
    const symbol  = toYahooSymbol(code);
    const candles = await fetchHistoryCached(symbol, '1y');
    if (!candles || candles.length < 20)
      return _hint(hint, '❌ 無法取得 K 線資料（代號可能有誤）', 'error');

    // 找觀察起始 index
    const targetTs = Math.floor(targetDate.getTime() / 1000);
    let startIdx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= targetTs) { startIdx = i; break; }
    }
    if (startIdx < 19)
      return _hint(hint, '❌ 起始日超出可查詢範圍（最多一年）', 'error');

    _hint(hint, '⏳ 掃描訊號劇本...', 'info');

    const name       = getChineseName(code) || code;
    const todayPrice = candles[candles.length - 1].close;
    const startPrice = candles[startIdx].close;
    const maxRet     = _maxRet(candles, startIdx);

    // 建立操作劇本
    const script = _buildScript(candles, startIdx, tier, addTriggerIds, stopLossPct, todayPrice);

    // 今日建議
    const todayAdvice = _buildTodayAdvice(candles, script, todayPrice, stopLossPct);

    hint.style.display = 'none';
    result.innerHTML = _renderAll({
      code, name,
      startDate: _fmtDate(candles[startIdx].time),
      startPrice, todayPrice, maxRet,
      script, todayAdvice, tier,
    });
    result.style.display = '';

  } catch (err) {
    console.error('[stock-backtest]', err);
    _hint(hint, `❌ 分析失敗：${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '開始分析';
  }
}

// ============================================================================
// 建立操作劇本
// ============================================================================
function _buildScript(candles, startIdx, tier, addTriggerIds, stopLossPct, todayPrice) {
  const events = [];
  let entryPrice    = null;  // 首次進場價
  let entryIdx2     = null;  // 首次進場 candle index
  let stopLossPrice = null;  // 動態停損線
  let entered       = false; // 已進場
  let exited        = false; // 已出場（強出場後停止）
  let lastWarnDate  = null;  // 上次警示日期（去重）
  let addCooldown   = 0;     // 加碼冷卻
  let milestones    = new Set(); // 已觸發的里程碑

  for (let i = startIdx; i < candles.length; i++) {
    const slice   = candles.slice(0, i + 1);
    if (slice.length < 20) continue;

    const sigs    = matchSignals(slice);
    const bullSigs = sigs.filter(s => !WARNING_IDS.has(s.id));
    const warnSigs = sigs.filter(s =>  WARNING_IDS.has(s.id));
    const visBull  = _filterTier(bullSigs, tier);
    const visWarn  = _filterTier(warnSigs, tier);

    const date  = _fmtDate(candles[i].time);
    const price = candles[i].close;

    // ── 計算 MA20 做動態停損 ──
    const ma20 = _sma(candles.slice(0, i + 1).map(c => c.close), 20);

    // ── 尚未進場：找首次做多訊號 ──────────────────────────────
    if (!entered && !exited) {
      const firstEntry = visBull.filter(s => !WARNING_IDS.has(s.id));
      if (firstEntry.length > 0) {
        entered       = true;
        entryPrice    = price;
        entryIdx2     = i;
        // 停損線 = MA20 或進場價 × (1 - stopLossPct%)，取較高者
        stopLossPrice = Math.max(ma20, entryPrice * (1 - stopLossPct / 100));

        events.push({
          type: 'entry',
          date, price,
          signals: firstEntry,
          ret: null, // 進場當下報酬為 0
          addRet: _ret(price, todayPrice),
          stopLoss: stopLossPrice,
          remark: firstEntry.length >= 2
            ? '多重訊號同時確認，可積極建倉'
            : '首次訊號出現，建議試倉',
        });
        addCooldown = 3;
      }
      continue; // 進場前不處理其他事件
    }

    if (exited) continue;

    // ── 已進場：計算累積報酬 ──────────────────────────────────
    const cumRet = _ret(entryPrice, price);

    // 更新動態停損（只上移不下調）
    const newStop = Math.max(ma20, entryPrice * (1 - stopLossPct / 100));
    if (newStop > stopLossPrice) stopLossPrice = newStop;

    // ── 停損觸發 ─────────────────────────────────────────────
    if (price <= stopLossPrice) {
      events.push({
        type: 'stop',
        date, price,
        signals: [],
        ret: cumRet,
        addRet: null,
        stopLoss: stopLossPrice,
        remark: `跌破停損線 $${stopLossPrice.toFixed(0)}，執行出場`,
      });
      exited = true;
      continue;
    }

    // ── 強出場訊號 ────────────────────────────────────────────
    const hardExit = visWarn.filter(s => EXIT_HARD.has(s.id));
    if (hardExit.length > 0) {
      events.push({
        type: 'exit',
        date, price,
        signals: hardExit,
        ret: cumRet,
        addRet: null,
        stopLoss: stopLossPrice,
        remark: '強出場訊號，建議執行出場',
      });
      exited = true;
      continue;
    }

    // ── 警示訊號（去重：5 天內不重複）────────────────────────
    const warnHits = visWarn.filter(s => EXIT_WARN.has(s.id));
    if (warnHits.length > 0) {
      const daysSince = lastWarnDate
        ? (new Date(date) - new Date(lastWarnDate)) / 86400000
        : 999;
      if (daysSince >= 5) {
        events.push({
          type: 'warn',
          date, price,
          signals: warnHits,
          ret: cumRet,
          addRet: _ret(price, todayPrice),
          stopLoss: stopLossPrice,
          remark: '注意風險，考慮縮倉；停損線 $' + stopLossPrice.toFixed(0),
        });
        lastWarnDate = date;
      }
    }

    // ── 加碼訊號 ──────────────────────────────────────────────
    if (!addCooldown) {
      const addHits = visBull.filter(s => addTriggerIds.has(s.id));
      if (addHits.length > 0) {
        events.push({
          type: 'add',
          date, price,
          signals: addHits,
          ret: cumRet,
          addRet: _ret(price, todayPrice),
          stopLoss: stopLossPrice,
          remark: addHits.length >= 2
            ? '多訊號確認，可積極加碼'
            : '加碼訊號出現，酌量加碼',
        });
        addCooldown = 5;
      }
    }
    if (addCooldown > 0) addCooldown--;

    // ── 獲利里程碑 ────────────────────────────────────────────
    for (const milestone of [20, 50, 100, 200]) {
      if (cumRet >= milestone && !milestones.has(milestone)) {
        milestones.add(milestone);
        events.push({
          type: 'milestone',
          date, price,
          signals: [],
          ret: cumRet,
          addRet: _ret(price, todayPrice),
          stopLoss: stopLossPrice,
          remark: `獲利突破 +${milestone}%，上移停損至 $${stopLossPrice.toFixed(0)}`,
        });
      }
    }
  }

  // 若從未進場
  if (!entered) {
    events.push({
      type: 'no_entry',
      date: _fmtDate(candles[candles.length - 1].time),
      price: todayPrice,
      signals: [], ret: null, addRet: null, stopLoss: null,
      remark: '觀察期間未出現任何進場訊號',
    });
  }

  return events;
}

// ============================================================================
// 今日建議
// ============================================================================
function _buildTodayAdvice(candles, script, todayPrice, stopLossPct) {
  const closes  = candles.map(c => c.close);
  const n       = candles.length;
  const ma20    = _sma(closes, 20);
  const distMa20 = ma20 > 0 ? ((todayPrice - ma20) / ma20 * 100) : 0;

  const logRets = [];
  for (let i = Math.max(1, n - 20); i < n; i++)
    logRets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = logRets.reduce((s, r) => s + r, 0) / logRets.length;
  const hv = Math.sqrt(logRets.reduce((s, r) => s + (r - mu) ** 2, 0) / logRets.length)
    * Math.sqrt(252) * 100;

  const lastEvent  = script[script.length - 1];
  const isExited   = lastEvent?.type === 'exit' || lastEvent?.type === 'stop';
  const isNoEntry  = lastEvent?.type === 'no_entry';
  const entryEvent = script.find(e => e.type === 'entry');
  const entryPrice = entryEvent?.price;
  const cumRet     = entryPrice ? _ret(entryPrice, todayPrice) : null;

  // 停損線（最後更新值）
  const stopLoss = lastEvent?.stopLoss;

  // 風險等級
  let riskLevel, riskLabel;
  if (distMa20 > 30 || hv > 70)      { riskLevel = 'danger'; riskLabel = '極高風險'; }
  else if (distMa20 > 15 || hv > 50) { riskLevel = 'high';   riskLabel = '高風險';   }
  else if (distMa20 > 8  || hv > 35) { riskLevel = 'mid';    riskLabel = '中風險';   }
  else                                 { riskLevel = 'low';    riskLabel = '低風險';   }

  // 建議文字
  let holdAdvice, newAdvice, watchFor;
  if (isNoEntry) {
    holdAdvice = '觀察期間未偵測到進場訊號，目前無持倉建議';
    newAdvice  = '尚無進場時機，繼續觀察';
    watchFor   = '等待做多訊號出現後再考慮進場';
  } else if (isExited) {
    holdAdvice = `已出場（${lastEvent.date}），不在持倉中`;
    newAdvice  = riskLevel === 'low' || riskLevel === 'mid'
      ? '若有新進場訊號出現，可考慮重新建倉'
      : '風險偏高，不建議現在重新進場';
    watchFor   = '等待新一輪做多訊號確認';
  } else {
    // 持倉中
    holdAdvice = cumRet != null
      ? `持倉中，目前浮盈 ${cumRet >= 0 ? '+' : ''}${cumRet.toFixed(1)}%，停損線 $${stopLoss?.toFixed(0) ?? '—'}`
      : '持倉中';
    newAdvice  = riskLevel === 'danger'
      ? '風險極高，不建議現在追加碼'
      : riskLevel === 'high'
      ? '風險偏高，謹慎加碼'
      : '可依訊號考慮加碼';
    watchFor   = `若跌破停損線 $${stopLoss?.toFixed(0) ?? '—'} 或出現強出場訊號，執行出場`;
  }

  return {
    riskLevel, riskLabel,
    distMa20, hv,
    holdAdvice, newAdvice, watchFor,
    cumRet, stopLoss, isExited, isNoEntry,
  };
}

// ============================================================================
// 渲染
// ============================================================================
function _renderAll(d) {
  const maxRetColor = d.maxRet >= 0 ? '#ef5350' : '#26a69a';
  const maxRetSign  = d.maxRet >= 0 ? '+' : '';

  return `
    <div class="sb-summary-card">
      <div class="sb-sum-top">
        <span class="sb-sum-name">${d.name} <em class="sb-sum-code">${d.code}</em></span>
        <span class="sb-sum-maxret" style="color:${maxRetColor}">
          觀察期最大漲幅 ${maxRetSign}${d.maxRet.toFixed(1)}%
        </span>
      </div>
      <div class="sb-sum-meta">
        <span>📅 觀察起始 <b>${d.startDate}</b>（$${d.startPrice.toFixed(0)}）</span>
        <span>→ 今日 $${d.todayPrice.toFixed(0)}</span>
      </div>
    </div>

    ${_renderScript(d.script)}
    ${_renderTodayAdvice(d.todayAdvice)}

    <div class="sb-footnote">
      ⚠️ 以歷史收盤價計算，不含手續費及滑價。「若照做至今」為假設當時操作持有至今的報酬，僅供參考，非投資建議。
    </div>
  `;
}

function _renderScript(script) {
  if (!script.length) return '';

  const typeMap = {
    entry:     { dot:'#34d399', badge:'首次進場',   cls:'sb-ev-entry'    },
    add:       { dot:'#26a69a', badge:'加碼時機',   cls:'sb-ev-add'      },
    warn:      { dot:'#fbbf24', badge:'風險警示',   cls:'sb-ev-warn'     },
    exit:      { dot:'#ef5350', badge:'出場訊號',   cls:'sb-ev-exit'     },
    stop:      { dot:'#ef5350', badge:'停損出場',   cls:'sb-ev-stop'     },
    milestone: { dot:'#60a5fa', badge:'獲利里程碑', cls:'sb-ev-milestone'},
    no_entry:  { dot:'#6b7280', badge:'無進場訊號', cls:'sb-ev-noentry'  },
  };

  const thead = `
    <div class="sb-tl-table-head">
      <span class="sb-tl-col-date">日期</span>
      <span class="sb-tl-col-sig">訊號 / 說明</span>
      <span class="sb-tl-col-price">價格</span>
      <span class="sb-tl-col-ret">累積報酬</span>
      <span class="sb-tl-col-addret">若照做至今</span>
      <span class="sb-tl-col-remark">操作建議</span>
    </div>`;

  const rows = script.map(e => {
    const tm = typeMap[e.type] || typeMap.warn;

    const retHtml = e.ret != null
      ? `<span style="color:${e.ret>=0?'#ef5350':'#26a69a'};font-weight:700">${e.ret>=0?'+':''}${e.ret.toFixed(1)}%</span>`
      : '<span class="sb-tl-na">—</span>';

    const addRetHtml = e.addRet != null
      ? `<span style="color:${e.addRet>=0?'#ef5350':'#26a69a'};font-weight:700">${e.addRet>=0?'+':''}${e.addRet.toFixed(1)}%</span>`
      : '<span class="sb-tl-na">—</span>';

    const sigText = e.signals.length
      ? e.signals.map(s => `${s.icon}${s.name}`).join('、')
      : '';

    return `
      <div class="sb-tl-row2 ${tm.cls}">
        <div class="sb-tl-line">
          <div class="sb-tl-dot2" style="background:${tm.dot}"></div>
        </div>
        <div class="sb-tl-cells">
          <span class="sb-tl-col-date">${e.date}</span>
          <span class="sb-tl-col-sig">
            <span class="sb-badge sb-badge-${e.type}">${tm.badge}</span>
            ${sigText ? `<span class="sb-tl-signames">${sigText}</span>` : ''}
          </span>
          <span class="sb-tl-col-price">$${e.price.toFixed(0)}</span>
          <span class="sb-tl-col-ret">${retHtml}</span>
          <span class="sb-tl-col-addret">${addRetHtml}</span>
          <span class="sb-tl-col-remark">${e.remark}</span>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="sb-section">
      <div class="sb-section-title">📋 操作劇本時間軸</div>
      <div class="sb-tl-table">
        ${thead}
        ${rows}
      </div>
    </div>`;
}

function _renderTodayAdvice(a) {
  const lvMap = {
    low:    { color:'#26a69a', label:'低風險'   },
    mid:    { color:'#fbbf24', label:'中風險'   },
    high:   { color:'#f97316', label:'高風險'   },
    danger: { color:'#ef5350', label:'極高風險' },
  };
  const lv = lvMap[a.riskLevel];

  const cumRetHtml = a.cumRet != null
    ? `<span style="color:${a.cumRet>=0?'#ef5350':'#26a69a'};font-weight:700">${a.cumRet>=0?'+':''}${a.cumRet.toFixed(1)}%</span>`
    : '';

  return `
    <div class="sb-today-card">
      <div class="sb-today-header">
        <span class="sb-today-title">📍 今日狀況（${_fmtDateNow()}）</span>
        <span class="sb-today-risk" style="color:${lv.color}">${lv.label}</span>
        ${cumRetHtml}
      </div>
      <div class="sb-today-rows">
        <div class="sb-today-row">
          <span class="sb-today-lbl">持倉建議</span>
          <span class="sb-today-val">${a.holdAdvice}</span>
        </div>
        <div class="sb-today-row">
          <span class="sb-today-lbl">新倉建議</span>
          <span class="sb-today-val">${a.newAdvice}</span>
        </div>
        <div class="sb-today-row">
          <span class="sb-today-lbl">關注訊號</span>
          <span class="sb-today-val">${a.watchFor}</span>
        </div>
        <div class="sb-today-row">
          <span class="sb-today-lbl">技術指標</span>
          <span class="sb-today-val">乖離月線 ${a.distMa20.toFixed(1)}%　年化波動率 ${a.hv.toFixed(0)}%</span>
        </div>
      </div>
    </div>`;
}

// ============================================================================
// 工具
// ============================================================================
function _filterTier(sigs, tier) {
  return tier === 'free' ? sigs.filter(s => s.tier === 'free') : sigs;
}
function _ret(entry, current) {
  return entry > 0 ? (current - entry) / entry * 100 : 0;
}
function _maxRet(candles, startIdx) {
  const startPrice = candles[startIdx].close;
  let max = 0;
  for (let i = startIdx; i < candles.length; i++) {
    const r = _ret(startPrice, candles[i].close);
    if (r > max) max = r;
  }
  return max;
}
function _sma(arr, n) {
  const slice = arr.slice(-n);
  return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : 0;
}
function _fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function _fmtDateNow() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function _hint(el, msg, type) {
  el.style.display = '';
  el.className     = `sb-hint sb-hint-${type}`;
  el.textContent   = msg;
}
