/**
 * strategy-simulator.js — 策略練習器 v2（看盤風格）
 * ============================================================================
 * Tier：Free（Free 策略）/ Pro（全策略）
 * 入口：openSimulator() — 由 monte-carlo.js 呼叫
 * ============================================================================
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { STRATEGIES }  from './strategy.js';
import { matchSignals } from './signal-scan.js';

console.log('[strategy-simulator] 模組載入 OK');

// ─── 自動注入 CSS（不需要外部 link 標籤）──────────────────────────────────
(function() {
  if (document.getElementById('ss-style')) return;
  const style = document.createElement('style');
  style.id = 'ss-style';
  style.textContent = '/* ============================================================\n   strategy-simulator.css — 策略練習器 v2（看盤風格）\n   ============================================================ */\n\n.ss-panel {\n  background: #0d1117;\n  color: #e2e8f0;\n  font-size: 13px;\n  display: flex;\n  flex-direction: column;\n  gap: 0;\n}\n\n/* ── 設定畫面 ────────────────────────────────────────────── */\n.ss-setup-wrap {\n  padding: 14px 18px;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n.ss-setup-title {\n  font-size: 13px; font-weight: 700; color: #e2e8f0;\n  display: flex; align-items: center; gap: 8px;\n}\n.ss-setup-desc {\n  font-size: 11px; color: #6b7280; line-height: 1.6;\n}\n.ss-form-row {\n  display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;\n}\n.ss-field { display: flex; flex-direction: column; gap: 4px; }\n.ss-label { font-size: 11px; color: #6b7280; }\n.ss-input {\n  padding: 5px 10px; background: #161b22;\n  border: 1px solid #2a2d3a; border-radius: 6px;\n  color: #e2e8f0; font-size: 13px; outline: none;\n  width: 100px; transition: border-color .15s;\n}\n.ss-input-sm { width: 60px; text-align: center; }\n.ss-input:focus { border-color: #3b82f6; }\n.ss-start-btn {\n  padding: 7px 18px; background: #1d4ed8; border: none;\n  border-radius: 6px; color: #fff; font-size: 13px;\n  font-weight: 700; cursor: pointer; transition: background .15s;\n}\n.ss-start-btn:hover { background: #2563eb; }\n.ss-hint { font-size: 11px; padding: 5px 10px; border-radius: 5px; }\n.ss-hint-warn  { background: rgba(251,191,36,.1);  color: #fbbf24; }\n.ss-hint-error { background: rgba(239,83,80,.1);   color: #ef5350; }\n.ss-hint-info  { background: rgba(59,130,246,.08); color: #93c5fd; }\n\n/* ── 模擬主畫面 ─────────────────────────────────────────── */\n\n/* 頂部：股票資訊列 */\n.ss-stock-bar {\n  display: flex; align-items: center; gap: 16px;\n  padding: 10px 18px;\n  background: #161b22;\n  border-bottom: 1px solid #1e2028;\n  flex-wrap: wrap;\n}\n.ss-stock-name  { font-size: 15px; font-weight: 700; }\n.ss-stock-code  { font-size: 12px; color: #6b7280; margin-left: 4px; }\n.ss-stock-price { font-size: 22px; font-weight: 700; margin-left: 8px; }\n.ss-stock-chg   { font-size: 13px; font-weight: 600; }\n.ss-stock-date  { font-size: 11px; color: #6b7280; margin-left: auto; }\n.ss-stock-day   { font-size: 11px; color: #6b7280; }\n\n/* 停損觸發警告 */\n.ss-stop-bar {\n  background: rgba(239,83,80,.12);\n  border-bottom: 1px solid rgba(239,83,80,.3);\n  color: #ef5350; font-size: 12px; font-weight: 600;\n  padding: 6px 18px;\n  display: flex; align-items: center; gap: 8px;\n}\n\n/* 主體：左右分欄 */\n.ss-main {\n  display: flex; gap: 0;\n  align-items: flex-start;\n}\n\n/* 左側：訊號 + 建議 */\n.ss-left {\n  flex: 1;\n  padding: 12px 18px;\n  display: flex; flex-direction: column; gap: 10px;\n  border-right: 1px solid #1e2028;\n  overflow: hidden;\n}\n\n/* 訊號標籤區 */\n.ss-sig-section { display: flex; flex-direction: column; gap: 6px; }\n.ss-sig-label   { font-size: 10px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }\n.ss-sig-tags    { display: flex; flex-wrap: wrap; gap: 5px; }\n.ss-sig-tag {\n  display: inline-flex; align-items: center; gap: 3px;\n  padding: 3px 9px; border-radius: 20px;\n  font-size: 12px; font-weight: 600; border: 1px solid;\n  white-space: nowrap;\n}\n.ss-sig-tag-bull { border-color: rgba(52,211,153,.4); background: rgba(52,211,153,.1); color: #34d399; }\n.ss-sig-tag-warn { border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.1); color: #fbbf24; }\n.ss-sig-tag-exit { border-color: rgba(239,83,80,.4);  background: rgba(239,83,80,.1);  color: #ef5350; }\n.ss-no-sig       { font-size: 12px; color: #4b5563; }\n\n/* 系統建議 */\n.ss-advice {\n  display: flex; align-items: flex-start; gap: 8px;\n  padding: 9px 12px; border-radius: 7px; border: 1px solid;\n}\n.ss-advice-neutral  { border-color: #1e2028; background: #111827; }\n.ss-advice-hold     { border-color: rgba(96,165,250,.2);  background: rgba(96,165,250,.05); }\n.ss-advice-buy      { border-color: rgba(52,211,153,.3);  background: rgba(52,211,153,.06); }\n.ss-advice-add      { border-color: rgba(38,166,154,.3);  background: rgba(38,166,154,.06); }\n.ss-advice-strong   { border-color: rgba(52,211,153,.5);  background: rgba(52,211,153,.1);  }\n.ss-advice-caution  { border-color: rgba(251,191,36,.3);  background: rgba(251,191,36,.06); }\n.ss-advice-warn     { border-color: rgba(249,115,22,.3);  background: rgba(249,115,22,.06); }\n.ss-advice-exit     { border-color: rgba(239,83,80,.35);  background: rgba(239,83,80,.07);  }\n.ss-advice-danger   { border-color: rgba(239,83,80,.5);   background: rgba(239,83,80,.1);   }\n.ss-advice-icon     { font-size: 18px; flex-shrink: 0; margin-top: 1px; }\n.ss-advice-body     { display: flex; flex-direction: column; gap: 2px; }\n.ss-advice-title    { font-size: 13px; font-weight: 700; }\n.ss-advice-desc     { font-size: 11px; color: #9ca3af; line-height: 1.5; }\n\n/* 操作記錄（左側底部） */\n.ss-trades-mini { display: flex; flex-direction: column; gap: 0; }\n.ss-trades-mini-title { font-size: 10px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }\n.ss-trade-row {\n  display: grid;\n  grid-template-columns: 78px 40px 50px 50px 72px 1fr;\n  gap: 6px; font-size: 11px; padding: 4px 0;\n  border-bottom: 1px solid #1e2028; align-items: center;\n}\n.ss-trade-row:last-child { border-bottom: none; }\n.ss-trade-date   { color: #6b7280; }\n.ss-trade-type   { font-weight: 700; font-size: 11px; }\n.ss-trade-buy    { color: #34d399; }\n.ss-trade-sell   { color: #fbbf24; }\n.ss-trade-price  { color: #e2e8f0; }\n.ss-trade-shares { color: #9ca3af; }\n.ss-trade-amt    { font-weight: 600; }\n.ss-trade-note   { color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n\n/* 右側：持倉面板 */\n.ss-right {\n  width: 200px; flex-shrink: 0;\n  padding: 12px 14px;\n  display: flex; flex-direction: column; gap: 8px;\n  background: #0d1117;\n  position: sticky; top: 0;\n}\n.ss-right-title { font-size: 10px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }\n\n/* 持股數字顯示 */\n.ss-hold-block {\n  display: flex; flex-direction: column; gap: 5px;\n  padding: 8px 10px; background: #161b22;\n  border: 1px solid #1e2028; border-radius: 7px;\n}\n.ss-hold-row { display: flex; justify-content: space-between; align-items: baseline; gap: 4px; }\n.ss-hold-lbl { font-size: 10px; color: #6b7280; white-space: nowrap; }\n.ss-hold-val { font-size: 12px; color: #e2e8f0; font-weight: 600; text-align: right; }\n.ss-hold-val.up   { color: #ef5350; }\n.ss-hold-val.down { color: #26a69a; }\n.ss-hold-divider  { border: none; border-top: 1px solid #1e2028; margin: 2px 0; }\n.ss-total-val  { font-size: 14px; font-weight: 700; }\n\n/* 操作按鈕（右側） */\n.ss-action-grid {\n  display: grid; grid-template-columns: 1fr 1fr;\n  gap: 5px;\n}\n.ss-btn {\n  padding: 6px 4px; border: 1px solid; border-radius: 6px;\n  font-size: 11px; font-weight: 600; cursor: pointer;\n  transition: all .15s; text-align: center; white-space: nowrap;\n}\n.ss-btn:disabled { opacity: .3; cursor: default; }\n.ss-btn-buy    { background: rgba(52,211,153,.1); border-color: rgba(52,211,153,.3); color: #34d399; }\n.ss-btn-buy:not(:disabled):hover { background: rgba(52,211,153,.2); }\n.ss-btn-add    { background: rgba(38,166,154,.1); border-color: rgba(38,166,154,.3); color: #26a69a; }\n.ss-btn-add:not(:disabled):hover { background: rgba(38,166,154,.2); }\n.ss-btn-reduce { background: rgba(251,191,36,.08); border-color: rgba(251,191,36,.3); color: #fbbf24; }\n.ss-btn-reduce:not(:disabled):hover { background: rgba(251,191,36,.18); }\n.ss-btn-watch  { background: rgba(107,114,128,.08); border-color: #2a2d3a; color: #9ca3af; }\n.ss-btn-watch:hover { background: rgba(107,114,128,.18); }\n.ss-btn-exit   { background: rgba(239,83,80,.1);  border-color: rgba(239,83,80,.3); color: #ef5350; grid-column: span 2; }\n.ss-btn-exit:not(:disabled):hover { background: rgba(239,83,80,.2); }\n\n/* GO 按鈕 */\n.ss-go-btn {\n  width: 100%; padding: 9px; background: #1d4ed8; border: none;\n  border-radius: 7px; color: #fff; font-size: 13px;\n  font-weight: 700; cursor: pointer; transition: background .15s;\n  margin-top: auto;\n}\n.ss-go-btn:hover:not(:disabled) { background: #2563eb; }\n.ss-go-btn:disabled { opacity: .4; cursor: default; background: #374151; }\n\n/* ── 結算畫面 ─────────────────────────────────────────────── */\n.ss-settle-wrap {\n  padding: 14px 18px;\n  display: flex; flex-direction: column; gap: 12px;\n}\n.ss-settle-header {\n  display: flex; align-items: center; justify-content: space-between;\n}\n.ss-settle-title  { font-size: 14px; font-weight: 700; }\n.ss-settle-period { font-size: 11px; color: #6b7280; }\n\n.ss-settle-compare {\n  display: flex; gap: 12px; align-items: stretch;\n}\n.ss-settle-col {\n  flex: 1; padding: 12px 14px; border-radius: 8px;\n  border: 1px solid; display: flex; flex-direction: column; gap: 4px;\n}\n.ss-settle-col-user { border-color: rgba(96,165,250,.3); background: rgba(96,165,250,.06); }\n.ss-settle-col-hold { border-color: #2a2d3a; background: #161b22; }\n.ss-settle-col-label { font-size: 11px; color: #6b7280; }\n.ss-settle-col-ret   { font-size: 26px; font-weight: 700; }\n.ss-settle-col-amt   { font-size: 12px; color: #9ca3af; }\n\n.ss-settle-badge {\n  text-align: center; font-size: 13px; font-weight: 700;\n  padding: 8px; border-radius: 6px;\n}\n.ss-win  { background: rgba(52,211,153,.1); color: #34d399; }\n.ss-lose { background: rgba(107,114,128,.1); color: #9ca3af; }\n\n.ss-deng-comment {\n  display: flex; align-items: flex-start; gap: 10px;\n  padding: 10px 12px; background: rgba(59,130,246,.05);\n  border: 1px solid rgba(59,130,246,.2); border-radius: 7px;\n}\n.ss-deng-icon { font-size: 22px; flex-shrink: 0; }\n.ss-deng-text { font-size: 12px; color: #9ca3af; line-height: 1.7; }\n\n/* 結算操作記錄（全部） */\n.ss-settle-trades { display: flex; flex-direction: column; gap: 0; }\n.ss-settle-trades-title { font-size: 10px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }\n.ss-trades-head {\n  display: grid; grid-template-columns: 78px 40px 50px 50px 72px 1fr;\n  gap: 6px; font-size: 10px; color: #6b7280; padding: 3px 0;\n  border-bottom: 1px solid #2a2d3a;\n}\n\n.ss-restart-btn {\n  padding: 8px 18px; background: #374151; border: none;\n  border-radius: 6px; color: #e2e8f0; font-size: 12px;\n  font-weight: 600; cursor: pointer; transition: background .15s;\n  align-self: flex-start;\n}\n.ss-restart-btn:hover { background: #4b5563; }\n\n/* mc 按鈕 */\n.mc-bt-btn-simulator {\n  background: rgba(52,211,153,.12);\n  border-color: rgba(52,211,153,.35);\n  color: #34d399;\n}\n.mc-bt-btn-simulator:hover {\n  background: rgba(52,211,153,.22);\n  border-color: #34d399;\n}\n';
  document.head.appendChild(style);
})();



// ─── 常數 ──────────────────────────────────────────────────────────────────
const WARNING_IDS = new Set([
  'W1','W2','W3','W4','W5','W6','W7','W8','W9','W10',
  'W11','W12','W13','W14','W15','W16','W17','W18','W19','W20',
]);
const EXIT_HARD  = new Set(['W1','W3','W4','W18']);
const INIT_FUND  = 100000;
const BUY_AMT    = 10000;
const ADD_AMT    = 5000;
const PANEL_ID   = 'ssPanel';

let _state = null;

// ============================================================================
// 對外入口
// ============================================================================
export function openSimulator() {
  document.getElementById(PANEL_ID)?.remove();
  _state = null;
  _mountPanel(_buildSetupHTML());
  _bindSetup();
}

// ============================================================================
// 設定面板 HTML
// ============================================================================
function _buildSetupHTML() {
  const d90 = new Date();
  d90.setDate(d90.getDate() - 90);
  const defaultDate = d90.toISOString().slice(0, 10);

  return `
    <div class="ss-panel" id="${PANEL_ID}">
      <div class="ss-setup-wrap">
        <div class="ss-setup-title">🎮 策略練習器
          <button class="ss-close-btn" id="ssClose">✕</button>
        </div>
        <div class="ss-setup-desc">
          用歷史 K 線逐日重演，練習訊號判讀與倉位管理。虛擬資金 $100,000，結算時對比「抱到底」報酬。
        </div>
        <div class="ss-form-row">
          <div class="ss-field">
            <label class="ss-label">股票代號</label>
            <input class="ss-input" id="ssCode" type="text" placeholder="如 3021" maxlength="6"/>
          </div>
          <div class="ss-field">
            <label class="ss-label">觀察起始日</label>
            <input class="ss-input" id="ssDate" type="date" value="${defaultDate}"/>
          </div>
          <div class="ss-field">
            <label class="ss-label">停損 %</label>
            <input class="ss-input ss-input-sm" id="ssStop" type="number" value="8" min="1" max="30"/>
          </div>
          <button class="ss-start-btn" id="ssStart">🚀 開始模擬</button>
        </div>
        <div class="ss-hint" id="ssHint" style="display:none"></div>
      </div>
    </div>`;
}

function _bindSetup() {
  document.getElementById('ssClose')?.addEventListener('click', _close);
  document.getElementById('ssStart')?.addEventListener('click', _onStart);
  document.getElementById('ssCode')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _onStart();
  });
}

// ============================================================================
// 載入資料
// ============================================================================
async function _onStart() {
  const code    = document.getElementById('ssCode')?.value.trim().toUpperCase();
  const dateStr = document.getElementById('ssDate')?.value;
  const stopPct = parseFloat(document.getElementById('ssStop')?.value) || 8;
  const hint    = document.getElementById('ssHint');
  const btn     = document.getElementById('ssStart');

  if (!code)    return _hint(hint, '⚠️ 請輸入股票代號', 'warn');
  if (!dateStr) return _hint(hint, '⚠️ 請選擇起始日', 'warn');

  const targetDate = new Date(dateStr);
  const today = new Date(); today.setHours(0,0,0,0);
  if (targetDate >= today) return _hint(hint, '⚠️ 起始日必須早於今天', 'warn');

  btn.disabled = true; btn.textContent = '載入中...';
  _hint(hint, '⏳ 載入 K 線資料...', 'info');

  try {
    const symbol  = toYahooSymbol(code);
    const candles = await fetchHistoryCached(symbol, '1y');
    if (!candles || candles.length < 20)
      return _hint(hint, '❌ 無法取得 K 線資料', 'error');

    const targetTs = Math.floor(targetDate.getTime() / 1000);
    let startIdx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= targetTs) { startIdx = i; break; }
    }
    if (startIdx < 19)
      return _hint(hint, '❌ 起始日超出可查詢範圍（最多一年）', 'error');

    _state = {
      code, name: getChineseName(code) || code,
      candles, startIdx, currentIdx: startIdx,
      tier: window.__userTier ?? 'free',
      stopPct, fund: INIT_FUND,
      shares: 0, avgCost: 0,
      trades: [], entryPrice: null,
    };

    _renderDay();
  } catch (err) {
    console.error('[strategy-simulator]', err);
    _hint(hint, `❌ 載入失敗：${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🚀 開始模擬';
  }
}

// ============================================================================
// 每日模擬渲染
// ============================================================================
function _renderDay() {
  const s = _state;
  const { candles, currentIdx, tier } = s;
  const c      = candles[currentIdx];
  const price  = c.close;
  const prev   = currentIdx > 0 ? candles[currentIdx - 1].close : price;
  const dayChg = _ret(prev, price);
  const isLast = currentIdx >= candles.length - 1;
  const dayNum = currentIdx - s.startIdx + 1;

  // 跑訊號
  const slice    = candles.slice(0, currentIdx + 1);
  const allSigs  = matchSignals(slice);
  const bullSigs = _filterTier(allSigs.filter(s => !WARNING_IDS.has(s.id)), tier);
  const warnSigs = _filterTier(allSigs.filter(s =>  WARNING_IDS.has(s.id)), tier);
  const advice   = _getAdvice(bullSigs, warnSigs, s, price);

  // 持倉計算
  const holdVal   = s.shares * price;
  const totalVal  = s.fund + holdVal;
  const floatPnl  = s.shares > 0 ? holdVal - s.shares * s.avgCost : 0;
  const floatPct  = s.shares > 0 ? _ret(s.avgCost, price) : null;
  const totalRet  = _ret(INIT_FUND, totalVal);
  const stopPrice = s.avgCost > 0 ? s.avgCost * (1 - s.stopPct / 100) : null;
  const stopHit   = stopPrice && price <= stopPrice;

  const dayColor = dayChg >= 0 ? '#ef5350' : '#26a69a';
  const daySign  = dayChg >= 0 ? '+' : '';

  // 訊號標籤
  const bullTags = bullSigs.map(sg =>
    `<span class="ss-sig-tag ss-sig-tag-bull">${sg.icon} ${sg.name}</span>`
  ).join('');
  const warnTags = warnSigs.map(sg => {
    const cls = EXIT_HARD.has(sg.id) ? 'ss-sig-tag-exit' : 'ss-sig-tag-warn';
    return `<span class="ss-sig-tag ${cls}">${sg.icon} ${sg.name}</span>`;
  }).join('');

  const el = document.getElementById(PANEL_ID);
  el.innerHTML = `
    <!-- 股票資訊列 -->
    <div class="ss-stock-bar">
      <span class="ss-stock-name">${s.name}<em class="ss-stock-code"> ${s.code}</em></span>
      <span class="ss-stock-price" style="color:${dayColor}">$${price.toFixed(0)}</span>
      <span class="ss-stock-chg" style="color:${dayColor}">${daySign}${dayChg.toFixed(2)}%</span>
      <span class="ss-stock-day">第 ${dayNum} 個交易日</span>
      <span class="ss-stock-date">${_fmtDate(c.time)}${isLast ? '　🔴 今日' : ''}</span>
      <button class="ss-close-btn" id="ssClose" style="margin-left:8px">✕</button>
    </div>

    ${stopHit ? `<div class="ss-stop-bar">🚨 已觸及停損線 $${stopPrice.toFixed(0)}（-${s.stopPct}%），建議考慮出場！</div>` : ''}

    <!-- 主體：左右分欄 -->
    <div class="ss-main">

      <!-- 左側：訊號 + 建議 + 操作記錄 -->
      <div class="ss-left">

        <!-- 訊號標籤 -->
        <div class="ss-sig-section">
          <div class="ss-sig-label">今日訊號</div>
          <div class="ss-sig-tags">
            ${bullTags || warnTags
              ? bullTags + warnTags
              : '<span class="ss-no-sig">今日無特殊訊號</span>'}
          </div>
        </div>

        <!-- 系統建議 -->
        <div class="ss-advice ss-advice-${advice.level}">
          <span class="ss-advice-icon">${advice.icon}</span>
          <div class="ss-advice-body">
            <div class="ss-advice-title">${advice.title}</div>
            <div class="ss-advice-desc">${advice.desc}</div>
          </div>
        </div>

        <!-- 操作記錄 -->
        ${s.trades.length ? `
          <div class="ss-trades-mini">
            <div class="ss-trades-mini-title">操作記錄（最近 5 筆）</div>
            ${s.trades.slice(-5).map(t => {
              const isOut = t.type === '出場' || t.type === '減碼';
              return `<div class="ss-trade-row">
                <span class="ss-trade-date">${t.date}</span>
                <span class="ss-trade-type ss-trade-${isOut?'sell':'buy'}">${t.type}</span>
                <span class="ss-trade-price">$${t.price.toFixed(0)}</span>
                <span class="ss-trade-shares">${t.shares}股</span>
                <span class="ss-trade-amt" style="color:${isOut?'#26a69a':'#ef5350'}">${isOut?'+':'-'}$${_fmt(t.amount)}</span>
                <span class="ss-trade-note">${t.note}</span>
              </div>`;
            }).join('')}
          </div>` : ''}
      </div>

      <!-- 右側：持倉 + 操作按鈕 -->
      <div class="ss-right">
        <div class="ss-right-title">持倉狀況</div>

        <div class="ss-hold-block">
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">可用資金</span>
            <span class="ss-hold-val">$${_fmt(s.fund)}</span>
          </div>
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">持股</span>
            <span class="ss-hold-val">${s.shares > 0 ? s.shares + ' 股' : '—'}</span>
          </div>
          ${s.shares > 0 ? `
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">均價</span>
            <span class="ss-hold-val">$${s.avgCost.toFixed(1)}</span>
          </div>
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">市值</span>
            <span class="ss-hold-val">$${_fmt(holdVal)}</span>
          </div>
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">浮盈</span>
            <span class="ss-hold-val ${floatPnl>=0?'up':'down'}">
              ${floatPnl>=0?'+':''}$${_fmt(floatPnl)}（${floatPct>=0?'+':''}${floatPct?.toFixed(1)}%）
            </span>
          </div>
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">停損線</span>
            <span class="ss-hold-val" style="color:${stopHit?'#ef5350':'#6b7280'}">$${stopPrice?.toFixed(0)}</span>
          </div>` : ''}
          <hr class="ss-hold-divider"/>
          <div class="ss-hold-row">
            <span class="ss-hold-lbl">總資產</span>
            <span class="ss-hold-val ss-total-val ${totalRet>=0?'up':'down'}">
              $${_fmt(totalVal)}<br/>
              <small style="font-size:11px">${totalRet>=0?'+':''}${totalRet.toFixed(1)}%</small>
            </span>
          </div>
        </div>

        <!-- 操作按鈕 -->
        <div class="ss-action-grid">
          <button class="ss-btn ss-btn-buy"    id="ssBuy"    ${s.fund < price*10 ? 'disabled':''}>🏗️ 建倉<br/><small>$${_fmt(BUY_AMT)}</small></button>
          <button class="ss-btn ss-btn-add"    id="ssAdd"    ${s.shares===0||s.fund<price*5?'disabled':''}>➕ 加碼<br/><small>$${_fmt(ADD_AMT)}</small></button>
          <button class="ss-btn ss-btn-reduce" id="ssReduce" ${s.shares===0?'disabled':''}>➖ 減碼<br/><small>50%</small></button>
          <button class="ss-btn ss-btn-watch"  id="ssWatch">👀 觀察<br/><small>持倉不動</small></button>
          <button class="ss-btn ss-btn-exit"   id="ssExit"   ${s.shares===0?'disabled':''}>🚪 出場結算</button>
        </div>

        <button class="ss-go-btn" id="ssGo" ${isLast?'disabled':''}>
          ${isLast ? '✅ 已到今日，結算' : '▶ GO 下一天'}
        </button>
      </div>
    </div>
  `;

  // 事件
  document.getElementById('ssClose')?.addEventListener('click', _close);
  document.getElementById('ssBuy')?.addEventListener('click',    () => _trade('buy',    price, _fmtDate(c.time)));
  document.getElementById('ssAdd')?.addEventListener('click',    () => _trade('add',    price, _fmtDate(c.time)));
  document.getElementById('ssReduce')?.addEventListener('click', () => _trade('reduce', price, _fmtDate(c.time)));
  document.getElementById('ssWatch')?.addEventListener('click',  _go);
  document.getElementById('ssExit')?.addEventListener('click',   () => _exit(price, _fmtDate(c.time)));
  document.getElementById('ssGo')?.addEventListener('click', () => {
    if (isLast) _settle(price, _fmtDate(c.time));
    else        _go();
  });
}

// ============================================================================
// 操作邏輯
// ============================================================================
function _trade(type, price, date) {
  const s = _state;
  let shares, amount, label, note;

  if (type === 'buy') {
    amount = Math.min(BUY_AMT, s.fund);
    shares = Math.floor(amount / price);
    if (shares <= 0) return;
    label  = '建倉';
  } else if (type === 'add') {
    amount = Math.min(ADD_AMT, s.fund);
    shares = Math.floor(amount / price);
    if (shares <= 0) return;
    label  = '加碼';
  } else {
    shares = Math.floor(s.shares / 2);
    if (shares <= 0) return;
    amount = shares * price;
    label  = '減碼';
  }

  if (type === 'buy' || type === 'add') {
    const cost = shares * price;
    s.avgCost  = (s.avgCost * s.shares + cost) / (s.shares + shares);
    s.shares  += shares;
    s.fund    -= cost;
    if (!s.entryPrice) s.entryPrice = price;
    note = `均價 $${s.avgCost.toFixed(1)}`;
  } else {
    s.fund   += amount;
    s.shares -= shares;
    if (s.shares === 0) s.avgCost = 0;
    note = `剩 ${s.shares} 股`;
  }

  s.trades.push({ date, type: label, price, shares, amount, note });
  _renderDay();
}

function _exit(price, date) {
  const s = _state;
  if (!s.shares) return;
  const amount = s.shares * price;
  s.trades.push({ date, type: '出場', price, shares: s.shares, amount, note: '全數出清' });
  s.fund  += amount;
  s.shares = 0; s.avgCost = 0;
  _settle(price, date);
}

function _go() {
  const s = _state;
  if (s.currentIdx >= s.candles.length - 1) {
    _settle(s.candles[s.currentIdx].close, _fmtDate(s.candles[s.currentIdx].time));
    return;
  }
  s.currentIdx++;
  _renderDay();
}

// ============================================================================
// 結算畫面
// ============================================================================
function _settle(exitPrice, exitDate) {
  const s          = _state;
  const startPrice = s.candles[s.startIdx].close;
  const lastPrice  = s.candles[s.candles.length - 1].close;
  const finalVal   = s.fund + s.shares * exitPrice;
  const userRet    = _ret(INIT_FUND, finalVal);
  const holdShares = Math.floor(INIT_FUND / startPrice);
  const holdFinal  = holdShares * lastPrice + (INIT_FUND - holdShares * startPrice);
  const holdRet    = _ret(INIT_FUND, holdFinal);
  const win        = userRet >= holdRet;
  const comment    = _dengComment(userRet, holdRet, s.trades, s.stopPct);

  const userRetColor = userRet >= 0 ? '#ef5350' : '#26a69a';
  const holdRetColor = holdRet >= 0 ? '#ef5350' : '#26a69a';
  const sign = r => r >= 0 ? '+' : '';

  const el = document.getElementById(PANEL_ID);
  el.innerHTML = `
    <div class="ss-settle-wrap">
      <div class="ss-settle-header">
        <div>
          <div class="ss-settle-title">🏁 ${s.name} ${s.code}　模擬結算</div>
          <div class="ss-settle-period">${_fmtDate(s.candles[s.startIdx].time)} ～ ${exitDate}</div>
        </div>
        <button class="ss-close-btn" id="ssClose">✕</button>
      </div>

      <div class="ss-settle-compare">
        <div class="ss-settle-col ss-settle-col-user">
          <div class="ss-settle-col-label">你的操作</div>
          <div class="ss-settle-col-ret" style="color:${userRetColor}">${sign(userRet)}${userRet.toFixed(1)}%</div>
          <div class="ss-settle-col-amt">$${_fmt(finalVal)}</div>
        </div>
        <div class="ss-settle-col ss-settle-col-hold">
          <div class="ss-settle-col-label">抱到底</div>
          <div class="ss-settle-col-ret" style="color:${holdRetColor}">${sign(holdRet)}${holdRet.toFixed(1)}%</div>
          <div class="ss-settle-col-amt">$${_fmt(holdFinal)}</div>
        </div>
      </div>

      <div class="ss-settle-badge ${win ? 'ss-win' : 'ss-lose'}">
        ${win ? '🏆 你贏過抱到底！' : '📉 這次抱到底更划算'}
      </div>

      <div class="ss-deng-comment">
        <span class="ss-deng-icon">🐱</span>
        <div class="ss-deng-text">${comment}</div>
      </div>

      ${s.trades.length ? `
      <div class="ss-settle-trades">
        <div class="ss-settle-trades-title">完整操作記錄</div>
        <div class="ss-trades-head">
          <span>日期</span><span>操作</span><span>價格</span><span>股數</span><span>金額</span><span>備註</span>
        </div>
        ${s.trades.map(t => {
          const isOut = t.type === '出場' || t.type === '減碼';
          return `<div class="ss-trade-row">
            <span class="ss-trade-date">${t.date}</span>
            <span class="ss-trade-type ss-trade-${isOut?'sell':'buy'}">${t.type}</span>
            <span class="ss-trade-price">$${t.price.toFixed(0)}</span>
            <span class="ss-trade-shares">${t.shares}股</span>
            <span class="ss-trade-amt" style="color:${isOut?'#26a69a':'#ef5350'}">${isOut?'+':'-'}$${_fmt(t.amount)}</span>
            <span class="ss-trade-note">${t.note}</span>
          </div>`;
        }).join('')}
      </div>` : ''}

      <button class="ss-restart-btn" id="ssRestart">🔄 重新模擬</button>
    </div>
  `;

  document.getElementById('ssClose')?.addEventListener('click', _close);
  document.getElementById('ssRestart')?.addEventListener('click', () => {
    _state = null;
    document.getElementById(PANEL_ID)?.remove();
    _mountPanel(_buildSetupHTML());
    _bindSetup();
  });
}

// ============================================================================
// 系統建議
// ============================================================================
function _getAdvice(bullSigs, warnSigs, state, price) {
  const hardExit  = warnSigs.filter(s => EXIT_HARD.has(s.id));
  const softWarn  = warnSigs.filter(s => !EXIT_HARD.has(s.id));
  const stopPrice = state.avgCost > 0 ? state.avgCost * (1 - state.stopPct / 100) : null;
  const stopHit   = stopPrice && price <= stopPrice;

  if (stopHit)            return { level:'danger',  icon:'🚨', title:'停損觸發！',
    desc:`跌破停損線 $${stopPrice.toFixed(0)}，建議立即出場避免更大虧損。` };
  if (hardExit.length)    return { level:'exit',    icon:'🔴', title:'強出場訊號',
    desc:`${hardExit.map(s=>s.icon+s.name).join('、')} — 趨勢轉弱，建議出場保留獲利。` };
  if (softWarn.length>=2) return { level:'warn',    icon:'⚠️', title:'多重警示',
    desc:`${softWarn.map(s=>s.icon+s.name).join('、')} — 建議縮倉，不追加碼。` };
  if (softWarn.length===1)return { level:'caution', icon:'🟡', title:'出現警示訊號',
    desc:`${softWarn[0].icon}${softWarn[0].name} — 持倉觀察，注意停損線。` };
  if (bullSigs.length>=3) return { level:'strong',  icon:'🚀', title:'強烈做多訊號！',
    desc:`${bullSigs.slice(0,3).map(s=>s.icon+s.name).join('、')} 等 ${bullSigs.length} 個訊號齊亮，可積極建倉或加碼。` };
  if (bullSigs.length>=1&&state.shares===0) return { level:'buy', icon:'🟢', title:'進場訊號出現',
    desc:`${bullSigs.map(s=>s.icon+s.name).join('、')} — 建議試倉。` };
  if (bullSigs.length>=2&&state.shares>0)  return { level:'add', icon:'➕', title:'訊號強化，可加碼',
    desc:`${bullSigs.slice(0,2).map(s=>s.icon+s.name).join('、')} 持續亮起，趨勢強勁。` };
  if (bullSigs.length===1&&state.shares>0) return { level:'hold', icon:'📊', title:'持倉觀察',
    desc:`${bullSigs[0].icon}${bullSigs[0].name} 維持，繼續持有，留意停損線。` };
  return { level:'neutral', icon:'😐', title:'無明顯訊號',
    desc: state.shares > 0 ? '目前無特殊訊號，持倉觀察，注意停損線。' : '目前無進場訊號，繼續觀察。' };
}

// ============================================================================
// 燈燈評語
// ============================================================================
function _dengComment(userRet, holdRet, trades, stopPct) {
  const diff   = userRet - holdRet;
  const buys   = trades.filter(t=>t.type==='建倉'||t.type==='加碼').length;
  const exits  = trades.filter(t=>t.type==='出場').length;
  if (diff >= 10)  return `哇！比抱到底還強 ${diff.toFixed(1)}%！訊號判讀精準，倉位管理得當，繼續保持！`;
  if (diff >= 0)   return `跟抱到底差不多，但你多了操作的掌控感。下次試著在強訊號時更果斷加碼。`;
  if (buys === 0)  return `這次一直在觀察沒有操作，下次試著在訊號出現時果斷建倉看看！`;
  if (exits > 0)   return `抱到底贏了 ${Math.abs(diff).toFixed(1)}%，主要是出場稍早。停損 ${stopPct}% 可能偏緊，試試放寬到 MA20。`;
  return `差了 ${Math.abs(diff).toFixed(1)}%，持倉期間可以在強訊號出現時積極加碼，拉高平均報酬。`;
}

// ============================================================================
// 工具
// ============================================================================
function _mountPanel(html) {
  const btPanel = document.getElementById('mcBtPanel');
  if (btPanel) {
    btPanel.innerHTML = html;
    btPanel.style.display = '';
  } else {
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
  }
}

function _close() {
  document.getElementById(PANEL_ID)?.remove();
  const bp = document.getElementById('mcBtPanel');
  if (bp) bp.style.display = 'none';
}

function _filterTier(sigs, tier) {
  return tier === 'free' ? sigs.filter(s => s.tier === 'free') : sigs;
}
function _ret(a, b)  { return a > 0 ? (b - a) / a * 100 : 0; }
function _fmt(n)     { return Math.round(n).toLocaleString('zh-TW'); }
function _fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function _hint(el, msg, type) {
  el.style.display = '';
  el.className = `ss-hint ss-hint-${type}`;
  el.textContent = msg;
}
