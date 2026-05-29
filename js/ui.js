/**
 * ui.js
 * UI 控制層：toolbar、modal、toast、時鐘、股票標題列更新
 *
 * import：
 *   AppState, addToWatchlist  (state.js)
 *   toYahooSymbol             (api.js)
 *   renderWatchlist           (watchlist.js)
 *
 * export：
 *   fmt(v)
 *   fmtVol(v)
 *   startClock()
 *   setHeaderLoading(code)
 *   updateHeader(code, quote)  → { chg, chgPct }
 *   showLoading(on)
 *   updateDataInfo(msg)
 *   showToast(msg, duration)
 *   initUIEvents()             ← 取代所有 inline onclick
 */

import { AppState } from './state.js';
import { toYahooSymbol } from './api.js';
import { getChineseName } from './api.js';

// ─────────────────────────────────────────────
// 格式化工具
// ─────────────────────────────────────────────
export function fmt(v) {
  if (v == null || isNaN(v)) return '—';
  return v >= 100 ? v.toFixed(1) : v.toFixed(2);
}

export function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + ' 億';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' 百萬';
  if (v >= 1e4) return (v / 1e3).toFixed(0) + ' 千';
  return v.toLocaleString();
}

// ─────────────────────────────────────────────
// 時鐘 & 盤中/盤後狀態
// ─────────────────────────────────────────────
function _updateClock() {
  const now = new Date();
  document.getElementById('nowTime').textContent =
    now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

  const h = now.getHours(), m = now.getMinutes();
  const isTrading = h >= 9 && (h < 13 || (h === 13 && m <= 30));
  document.getElementById('statusLabel').textContent     = isTrading ? '盤中' : '盤後';
  document.querySelector('.status-dot').style.background = isTrading ? 'var(--up)' : 'var(--hint)';
}

export function startClock() {
  _updateClock();
  setInterval(_updateClock, 30000);
}

// ─────────────────────────────────────────────
// 股票標題列
// ─────────────────────────────────────────────
export function setHeaderLoading(code) {
  document.getElementById('shName').textContent = code;
  document.getElementById('shCode').textContent = toYahooSymbol(code);
  ['shPrice', 'shChange', 'sOpen', 'sHigh', 'sLow', 'sPrev', 'sVol', 'sPE'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '—';
    el.className   = el.className.replace(/\b(up|down|flat)\b/g, 'flat');
  });
}

export function updateHeader(code, quote) {
  const chg    = quote.price - quote.prev;
  const chgPct = (chg / quote.prev) * 100;
  const cls    = chg > 0 ? 'down' : chg < 0 ? 'up' : 'flat';  // ⚠️ 台股：漲=紅(--down) 跌=綠(--up)，class 名與 CSS 變數相反
  // 名稱優先順序：api._nameCache → window.__nameCache（Map）→ Yahoo 英文名 → code
  const chName = getChineseName(code)
    || window.__nameCache?.get?.(code)
    || quote.name
    || code;
  document.getElementById('shName').textContent = chName;
  document.getElementById('shCode').textContent   = toYahooSymbol(code);
  document.getElementById('shPrice').textContent  = fmt(quote.price);
  document.getElementById('shPrice').className    = 'sh-price ' + cls;
  document.getElementById('shChange').textContent = `${chg > 0 ? '+' : ''}${chg.toFixed(2)} (${chg > 0 ? '+' : ''}${chgPct.toFixed(2)}%)`;
  document.getElementById('shChange').className   = 'sh-change ' + cls;
  document.getElementById('sHigh').textContent    = fmt(quote.high);
  document.getElementById('sLow').textContent     = fmt(quote.low);
  document.getElementById('sPrev').textContent    = fmt(quote.prev);
  document.getElementById('sVol').textContent     = fmtVol(quote.volume);
  return { chg, chgPct };
}

// ─────────────────────────────────────────────
// Loading badge
// ─────────────────────────────────────────────
export function showLoading(on) {
  document.getElementById('loadingBadge').style.display = on ? '' : 'none';
}

// ─────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────
export function updateDataInfo(msg) {
  document.getElementById('dataInfo').innerHTML = `<b>${msg}</b>`;
}

// ─────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────
export function showToast(msg, duration = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

// ─────────────────────────────────────────────
// C1 — Ichimoku 週期適用性
// ─────────────────────────────────────────────
// Ichimoku 需要至少 52 根 K 才能算 SenkouB,且雲帶要從畫面左側就完整,
// 實務上建議 ≥ 78 根才會「雲帶看起來完整」。
//   5d  ( 5 根)/1mo ( 20 根)/3mo ( 60 根)  → 不足或雲帶空白 → 不允許
//   6mo (120 根)/1y (250 根)                → 完美呈現(日K)
//   2y  (104 週)                            → 完美呈現(週K)→ 長線視角,未來雲帶涵蓋半年
// ─────────────────────────────────────────────
const ICHI_OK_PERIODS  = new Set(['6mo', '1y', '2y']);
const ICHI_BAD_PERIODS = new Set(['5d', '1mo', '3mo']);

function _isIchiPeriodOK(period) {
  return ICHI_OK_PERIODS.has(period);
}

// 週期 hint 文字
function _periodHintForIchi(period) {
  if (period === '2y') return '☁️ 2年 K(週K)— 看「未來半年」的長線雲帶趨勢';
  if (period === '1y') return '☁️ 1年 K — Ichimoku 最佳工作週期';
  if (period === '6mo') return '☁️ 6月 K — 雲帶完整可看';
  return '☁️ Ichimoku 建議切換到 6月以上週期看完整雲帶';
}

// ─────────────────────────────────────────────
// 重算「指標 N ▾」下拉按鈕的標籤
// index.html 內 IIFE 的 _updateBtnLabel 只能透過 dropdown 點擊觸發,
// ui.js 自己改了 .on class 時(初始化、_setPeriod 自動關 ICHI)拿不到那個函式,
// 這裡複製一份邏輯,任何改完 .on 之後都呼叫一次
// ─────────────────────────────────────────────
function _refreshIndMoreLabel() {
  const btn = document.getElementById('indMoreBtn');
  const dropdown = document.getElementById('indMoreDropdown');
  if (!btn || !dropdown) return;
  const all  = dropdown.querySelectorAll('.ind-toggle');
  const onCt = [...all].filter(b => b.classList.contains('on')).length;
  btn.textContent = onCt > 0 ? `指標 ${onCt} ▾` : '指標 ▾';
  btn.classList.toggle('active', onCt > 0);
}

// ─────────────────────────────────────────────
// Toolbar:週期切換
// ─────────────────────────────────────────────
function _setPeriod(period, btn) {
  const prevPeriod = AppState.period;
  AppState.period = period;
  document.querySelectorAll('.tb-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // ── C1 — 切到不適合 Ichimoku 的週期,自動停用 + 提示 ──
  if (AppState.indicators.ICHI && !_isIchiPeriodOK(period)) {
    AppState.indicators.ICHI = false;
    const ichiBtn = document.querySelector('.ind-toggle[data-indicator="ICHI"]');
    if (ichiBtn) ichiBtn.classList.remove('on');
    _exitIchimokuMode();  // 還原其他指標
    _refreshIndMoreLabel();  // 同步「指標 N ▾」計數
    showToast(`☁️ ${period.toUpperCase()} 週期 K 線不足以呈現完整雲帶,Ichimoku 已自動關閉`);
  }
  // ── 顯示週期 + Ichimoku 相關 hint(僅在 Ichimoku 開啟時) ──
  else if (AppState.indicators.ICHI && _isIchiPeriodOK(period)) {
    showToast(_periodHintForIchi(period));
  }

  document.dispatchEvent(new CustomEvent('chartReload'));
}

// ─────────────────────────────────────────────
// Toolbar：均線開關
// ─────────────────────────────────────────────
function _toggleMA(n, btn) {
  AppState.ma[n] = !AppState.ma[n];
  btn.classList.toggle('on', AppState.ma[n]);
  document.dispatchEvent(new CustomEvent('chartReload'));
}

// ─────────────────────────────────────────────
// Toolbar：副圖指標開關
// ─────────────────────────────────────────────
function _toggleInd(name, btn) {
  // ── C1 — Ichimoku 開啟前檢查週期是否適合 ──
  if (name === 'ICHI' && !AppState.indicators.ICHI && !_isIchiPeriodOK(AppState.period)) {
    showToast(`☁️ Ichimoku 需要至少 52 根 K 線,${AppState.period.toUpperCase()} 週期 K 數不足。建議切換到 6月 / 1年 / 2年(長線版) 後再開啟`, 5000);
    return;  // 阻止開啟
  }

  AppState.indicators[name] = !AppState.indicators[name];
  btn.classList.toggle('on', AppState.indicators[name]);
  // panel 不一定存在（EMA/GMMA/SAR/ENV/ICHI 是主圖 overlay，沒有獨立 panel）
  const panel = document.getElementById(name.toLowerCase() + 'Panel');
  if (panel) panel.style.display = AppState.indicators[name] ? '' : 'none';
  // GMMA 效能警告
  if (name === 'GMMA' && AppState.indicators[name]) {
    showToast('⚡ GMMA 共12條線，效能較重，低階裝置可能稍慢');
  }
  // C1 — Ichimoku 獨佔模式
  if (name === 'ICHI') {
    if (AppState.indicators.ICHI) {
      _enterIchimokuMode();
      // 開啟時順帶提示當前週期意義
      showToast(_periodHintForIchi(AppState.period));
    } else {
      _exitIchimokuMode();
    }
  }
  document.dispatchEvent(new CustomEvent('chartReload'));
}

// ─────────────────────────────────────────────
// C1 — Ichimoku 獨佔模式
// 進入：暫存當前其他指標狀態 → 全部關閉（含 BB/EMA/GMMA/SAR/ENV/DMI/PSY/RCI/HV）
// 離開：從暫存還原
// 設計：方案 A — 預設關別的，但使用者勾選回來就生效（不阻止）
// ─────────────────────────────────────────────
const _ICHI_OCCUPY_KEYS = ['BB','EMA','GMMA','SAR','ENV','DMI','PSY','RCI','HV'];

function _enterIchimokuMode() {
  // 已在獨佔模式就不重複（避免使用者手動開回的指標被再次蓋掉）
  if (AppState._indicatorsBackup) return;
  // 把當前狀態快照存起來
  const backup = {};
  _ICHI_OCCUPY_KEYS.forEach(k => { backup[k] = AppState.indicators[k]; });
  AppState._indicatorsBackup = backup;
  // 關閉所有干擾指標 + 同步按鈕視覺
  _ICHI_OCCUPY_KEYS.forEach(k => {
    if (!AppState.indicators[k]) return;
    AppState.indicators[k] = false;
    const otherBtn = document.querySelector(`.ind-toggle[data-indicator="${k}"]`);
    if (otherBtn) otherBtn.classList.remove('on');
    const otherPanel = document.getElementById(k.toLowerCase() + 'Panel');
    if (otherPanel) otherPanel.style.display = 'none';
  });
  showToast('☁️ Ichimoku 模式：其他指標已暫時隱藏，可手動再開');
}

function _exitIchimokuMode() {
  if (!AppState._indicatorsBackup) return;
  // 從備份還原
  const backup = AppState._indicatorsBackup;
  Object.keys(backup).forEach(k => {
    AppState.indicators[k] = backup[k];
    const otherBtn = document.querySelector(`.ind-toggle[data-indicator="${k}"]`);
    if (otherBtn) otherBtn.classList.toggle('on', backup[k]);
    const otherPanel = document.getElementById(k.toLowerCase() + 'Panel');
    if (otherPanel) otherPanel.style.display = backup[k] ? '' : 'none';
  });
  AppState._indicatorsBackup = null;
  showToast('🔁 已還原原本的指標設定');
}

// ─────────────────────────────────────────────
// 統一事件綁定（DOMContentLoaded 後呼叫）
// ─────────────────────────────────────────────
export function initUIEvents() {
  // 週期按鈕（toolbar）
  document.querySelectorAll('.tb-btn[data-period]').forEach(btn => {
    btn.addEventListener('click', () => _setPeriod(btn.dataset.period, btn));
  });

  // 均線開關
  document.querySelectorAll('.ind-toggle[data-ma]').forEach(btn => {
    btn.addEventListener('click', () => _toggleMA(Number(btn.dataset.ma), btn));
  });

  // 副圖指標開關
  document.querySelectorAll('.ind-toggle[data-indicator]').forEach(btn => {
    btn.addEventListener('click', () => _toggleInd(btn.dataset.indicator, btn));
  });

  // 初始化：把所有按鈕的視覺狀態與 AppState 同步
  // （HTML 寫死的 .on class 可能跟 state 預設值不一致；以 state 為準）
  document.querySelectorAll('.ind-toggle[data-indicator]').forEach(btn => {
    const name = btn.dataset.indicator;
    if (name in AppState.indicators) {
      btn.classList.toggle('on', !!AppState.indicators[name]);
    }
  });
  document.querySelectorAll('.ind-toggle[data-ma]').forEach(btn => {
    const n = Number(btn.dataset.ma);
    if (n in AppState.ma) {
      btn.classList.toggle('on', !!AppState.ma[n]);
    }
  });

  // C1 — Ichimoku 若預設開啟，初次載入也要進入獨佔模式
  // 但因為其他指標預設都關閉，這時候 backup 全 false，等同於只記錄狀態
  if (AppState.indicators.ICHI && !AppState._indicatorsBackup) {
    _enterIchimokuMode();
  }

  // 上面把按鈕視覺與 state 同步後,觸發指標下拉的「指標 N ▾」標籤重算
  _refreshIndMoreLabel();
}
