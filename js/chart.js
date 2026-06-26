/**
 * chart.js
 * Lightweight Charts 初始化、渲染、指標副圖、十字線同步
 *
 * import：
 *   AppState              (state.js)
 *   calcMA, calcKD, calcRSI, calcMACD  (indicators.js)
 *
 * export：
 *   initCharts()
 *   renderChartData(candles)
 *
 * 布林通道：AppState.indicators.BB = true 時渲染（上軌/中軌/下軌，紫色虛線）
 */

import { AppState } from './state.js';
import { computeConviction } from './conviction.js';
import { calcMA, calcKD, calcRSI, calcMACD, calcBollinger,
         calcEMA, calcGMMA, calcSAR, calcDMI, calcPSY, calcRCI, calcHV, calcEnvelope,
         calcIchimoku, anchoredVWAP, resolveAVWAPAnchor,
         calcSupertrend, calcTTMSqueeze, calcOBV } from './indicators.js';
import { getYaoguRecord } from './db.js';
import { fetchBenchmark } from './api-hist.js';

// ─────────────────────────────────────────────
// 圖表實例與 Series 管理
// ─────────────────────────────────────────────
let _charts = {};   // { main, kd, rsi, macd }
let _series = {};   // 所有 series 實例

// 🔧 臨時除錯 hook（定位副圖全黑；查完會移除）。Console 跑 __dbg()
if (typeof window !== 'undefined') {
  window.__dbg = () => {
    const rg = c => { try { const r = c?.timeScale().getVisibleRange(); return r ? `${r.from}→${r.to}` : 'NULL'; } catch (e) { return 'ERR'; } };
    const dl = s => { try { return s ? s.data().length : 'noSeries'; } catch (e) { return 'ERR'; } };
    const P = document.getElementById('chartPanel');
    const bOn = ind => { const b = document.querySelector(`.ind-toggle[data-indicator="${ind}"]`); return b ? b.classList.contains('on') : '?'; };
    const o = {
      mode: `fs=${P?.classList.contains('fullscreen-mode')} studio=${P?.classList.contains('studio-mode')} edit=${!!document.querySelector('.chart-edit-active')}`,
      btnOn: `KD=${bOn('KD')} RSI=${bOn('RSI')} MACD=${bOn('MACD')} DMI=${bOn('DMI')}`,
      ind: `KD=${AppState.indicators.KD} RSI=${AppState.indicators.RSI} MACD=${AppState.indicators.MACD} DMI=${AppState.indicators.DMI} RS=${AppState.indicators.RS}`,
      mainRange: rg(_charts.main),
      kd:   `range=${rg(_charts.kd)}   data=${dl(_series.kdK)}`,
      rsi:  `range=${rg(_charts.rsi)}  data=${dl(_series.rsi)}`,
      macd: `range=${rg(_charts.macd)} data=${dl(_series.macdDif)}`,
      dmi:  `range=${rg(_charts.dmi)}  data=${dl(_series.dmiPlus)} (panel=${document.getElementById('dmiPanel')?.style.display||'?'})`,
    };
    const r = JSON.stringify(o, null, 2);
    console.log('%c'+r, 'color:#0ff'); try { copy(r); } catch (e) {}
    return o;
  };
}

// ─────────────────────────────────────────────
// Phase 7 對外存取(讓 canvas-overlay / chart-edit 拿到實例)
// ─────────────────────────────────────────────
export function getMainChart()    { return _charts.main  || null; }
export function getCandleSeries() { return _series.candle || null; }
export function getMainChartEl()  { return document.getElementById('mainChart'); }

// ── 可調 K 線高度（拖曳把手用）：存 localStorage，跨 session 記憶 ──
function _storedMainH() {
  const v = +(localStorage.getItem('mainChartH'));
  return (v >= 240 && v <= 1000) ? v : 360;
}
export function getMainChartHeight() { return _storedMainH(); }
export function applyMainChartHeight(h) {
  const SUB_PANEL_H = 160;
  const clamped = Math.max(240, Math.min(Math.round(h), 1000));
  try { localStorage.setItem('mainChartH', String(clamped)); } catch (e) {}
  document.documentElement.style.setProperty('--main-chart-h', clamped + 'px');
  // 重算 chart-area 總高（主圖 + 已開副圖數）
  const subOn = ['KD','RSI','MACD','DMI','PSY','RCI','HV','CONV','TTM','OBV','RS']
    .filter(k => AppState.indicators[k]).length;
  document.documentElement.style.setProperty('--chart-area-h', (clamped + subOn * SUB_PANEL_H) + 'px');
  try { _charts.main?.applyOptions({ height: clamped }); } catch (e) {}
  try { window._chartResize?.(); } catch (e) {}
}

// ── 工作室 K 線高度（獨立於主頁；預設滿版，可手動拉好拉滿，存 localStorage）──
function _storedStudioH() {
  const v = +(localStorage.getItem('studioChartH'));
  return (v >= 240 && v <= 4000) ? v : null;   // null = 未設定 → 用 CSS 預設（滿版）
}
export function initStudioChartHeight() {
  const v = _storedStudioH();
  if (v) document.documentElement.style.setProperty('--studio-chart-h', v + 'px');
  else   document.documentElement.style.removeProperty('--studio-chart-h');  // 還原 CSS 預設滿版
}
export function applyStudioChartHeight(h) {
  const clamped = Math.max(240, Math.min(Math.round(h), 4000));
  try { localStorage.setItem('studioChartH', String(clamped)); } catch (e) {}
  document.documentElement.style.setProperty('--studio-chart-h', clamped + 'px');
  try { _charts.main?.applyOptions({ height: clamped }); } catch (e) {}
  try { window._chartResize?.(); } catch (e) {}
}

// Phase 7.2 — 副圖 chart 存取(背離線需要在副圖上畫)
export function getMacdChart()    { return _charts.macd  || null; }
export function getKdChart()      { return _charts.kd    || null; }
export function getRsiChart()     { return _charts.rsi   || null; }
export function getMacdChartEl()  { return document.getElementById('macdChart'); }
export function getKdChartEl()    { return document.getElementById('kdChart');   }
export function getRsiChartEl()   { return document.getElementById('rsiChart');  }

// ─────────────────────────────────────────────
// 共用圖表選項
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// 台灣時間格式化工具（Yahoo 回傳 UTC Unix timestamp，需 +8hr 顯示）
// ⚠️ 踩雷備忘：LightweightCharts 的 time 是 UTC 秒數，
//   不加 +8hr 會導致 K 線結尾顯示 01:00（UTC收盤）而非 09:00（台灣收盤）
// ─────────────────────────────────────────────
function _twTime(unixSec) {
  // Unix timestamp（秒）→ 台灣時間 Date 物件
  return new Date((unixSec + 8 * 3600) * 1000);
}

function _fmtTWDate(unixSec) {
  const d = _twTime(unixSec);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  return M + '/' + D;
}

function _fmtTWDateTime(unixSec) {
  const d = _twTime(unixSec);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return M + '/' + D + ' ' + h + ':' + m;
}

function _chartOptions(height) {
  return {
    height,   // ⚠️ 0610 修正：原本收了 height 參數卻沒放進 options，
              // 導致 display:none 容器內建立的副圖(DMI/PSY/RCI/HV)高度鎖死 0
    layout: {
      background: { color: 'transparent' },
      textColor:  'rgba(138,143,153,0.9)',
      fontSize:   10,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: {
      borderColor:  'rgba(255,255,255,0.08)',
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor:    'rgba(255,255,255,0.08)',
      timeVisible:    true,
      secondsVisible: false,
    },
    localization: {
      // crosshair 懸停時顯示台灣時間（日K 只顯示日期，不顯示時分）
      timeFormatter: (unixSec) => {
        const d = _twTime(unixSec);
        const h = d.getUTCHours(), m = d.getUTCMinutes();

        // 判斷是否為「今天」的資料點
        const nowTW   = _twTime(Math.floor(Date.now() / 1000));
        const isToday = (
          d.getUTCFullYear() === nowTW.getUTCFullYear() &&
          d.getUTCMonth()    === nowTW.getUTCMonth()    &&
          d.getUTCDate()     === nowTW.getUTCDate()
        );

        // 今天且盤中（台灣時間 09:00-13:35）→ 顯示目前時間
        const nowH = nowTW.getUTCHours(), nowM = nowTW.getUTCMinutes();
        const isTrading = nowH >= 9 && (nowH < 13 || (nowH === 13 && nowM <= 35));
        if (isToday && isTrading) {
          // 顯示目前台灣時間（不是 K 棒的時間）
          return String(nowH).padStart(2, '0') + ':' + String(nowM).padStart(2, '0');
        }

        // 盤後日K：只顯示日期（Yahoo 日K timestamp 通常是 UTC 01:00 = 台灣 09:00）
        // h===1, m===0 是日K 的典型時間點（UTC 01:00 = 台灣 09:00 開盤）
        const isDailyBar = (h === 1 && m === 0) || (h === 0 && m === 0);
        if (isDailyBar) return _fmtTWDate(unixSec);

        // 分K 或 週K：顯示完整日期+時間
        return _fmtTWDateTime(unixSec);
      },
    },
    crosshair:    { mode: 1 },
    handleScroll: true,
    handleScale:  true,
    height,
    width: 0,
  };
}

// ─────────────────────────────────────────────
// 初始化所有圖表（舊的先銷毀）
// ─────────────────────────────────────────────
export function initCharts() {
  Object.values(_charts).forEach(c => { try { c.remove(); } catch (e) { /**/ } });
  _charts = {};
  _series = {};

  // ⚠️ Ichimoku 模組級狀態必須一併清理,否則切週期重建 chart 後:
  //   - _ichiCanvas 還指向上一輪的 DOM 元素(已從 chart 移除但變數還在)
  //   - _ichiUnsubs 內的 unsubscribe 對的是舊 chart 的 timeScale(已 remove,呼叫會炸)
  //   - canvas 元素本身可能還掛在 #mainChart 上(因為 chart.remove 不會清外部 appendChild)
  // 用 _clearIchimoku 做完整清理,但要在 _charts 清空後跑(因為它呼叫 removeSeries 會抓 _charts.main,
  // 此時 _charts.main 已不存在,內部 try/catch 會吃掉)
  _clearIchimoku();
  // 再保險:即使 _ichiCanvas 變數丟了,也把 #mainChart 裡所有 .ichi-cloud-canvas 都清掉
  const mainElForClean = document.getElementById('mainChart');
  if (mainElForClean) {
    mainElForClean.querySelectorAll('.ichi-cloud-canvas').forEach(el => {
      try { el.remove(); } catch(e){}
    });
  }
  // BB/ENV 通道填色 canvas 清理（同 Ichimoku：chart.remove 不清外部 appendChild）
  _clearAllBandFills();
  // C3 分價量表清理
  _clearPVD();

  const mainEl = document.getElementById('mainChart');
  const kdEl   = document.getElementById('kdChart');
  const rsiEl  = document.getElementById('rsiChart');
  const macdEl = document.getElementById('macdChart');

  const dmiEl  = document.getElementById('dmiChart');
  const psyEl  = document.getElementById('psyChart');
  const rciEl  = document.getElementById('rciChart');
  const hvEl   = document.getElementById('hvChart');
  const convEl = document.getElementById('convChart');
  const ttmEl  = document.getElementById('ttmChart');
  const obvEl  = document.getElementById('obvChart');
  const rsEl   = document.getElementById('rsChart');

  // ─────────────────────────────────────────────────────────────
  // 固定高度策略 (v3 — 0523 修正副圖擠壓)
  //  - 主圖永遠 360px,副圖永遠 160px (含 label ~25px,內 chart 135px)
  //  - 啟用幾個副圖就在 chart-area 寫入幾倍的高度,
  //    讓 .stock-panel 自然出捲軸 (.stock-panel 已有 overflow-y:auto)
  //  - 全視窗模式有自己的 --fs-tb-h 高度邏輯,不會跟 --chart-area-h 衝突
  //    (.fullscreen-mode .chart-area 在 analysis-panel.css 用 !important 蓋掉)
  // ─────────────────────────────────────────────────────────────
  const MAIN_H     = _storedMainH();
  const SUB_PANEL_H = 160;   // ind-panel 整個高度 (含 label)
  document.documentElement.style.setProperty('--main-chart-h', MAIN_H + 'px');
  const SUB_CHART_H = 135;   // ind-panel 內 chart 部份高度 (160 - label ~25)

  // 算出啟用了幾個副圖
  const subOn = ['KD','RSI','MACD','DMI','PSY','RCI','HV','CONV','TTM','OBV','RS']
    .filter(k => AppState.indicators[k]).length;

  // 寫入 CSS 變數讓 chart-area 撐高
  // (全視窗模式被 fullscreen-mode 蓋掉,這個變數不影響)
  const chartAreaH = MAIN_H + subOn * SUB_PANEL_H;
  document.documentElement.style.setProperty('--chart-area-h', chartAreaH + 'px');

  const mainH = MAIN_H;
  const barSpacing = AppState.period === '5d' ? 20 : 8;

  _charts.main = LightweightCharts.createChart(mainEl, {
    ..._chartOptions(Math.max(mainH, 140)),
    timeScale: {
      borderColor:    'rgba(255,255,255,0.08)',
      timeVisible:    true,
      secondsVisible: false,
      barSpacing,
    },
  });

  // 副圖 chart 統一用 SUB_CHART_H (135px),含 label 後整個 ind-panel = 160px
  _charts.kd   = LightweightCharts.createChart(kdEl,   { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } } });
  _charts.rsi  = LightweightCharts.createChart(rsiEl,  { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } } });
  _charts.macd = LightweightCharts.createChart(macdEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.1,  bottom: 0.1  } } });

  // Advanced 5 副圖
  if (dmiEl) _charts.dmi = LightweightCharts.createChart(dmiEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } } });
  if (psyEl) _charts.psy = LightweightCharts.createChart(psyEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } } });
  if (rciEl) _charts.rci = LightweightCharts.createChart(rciEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } } });
  if (hvEl)  _charts.hv  = LightweightCharts.createChart(hvEl,  { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } } });
  if (convEl) _charts.conviction = LightweightCharts.createChart(convEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } } });
  if (ttmEl) _charts.ttm = LightweightCharts.createChart(ttmEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.1, bottom: 0.1 } } });
  if (obvEl) _charts.obv = LightweightCharts.createChart(obvEl, { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.1, bottom: 0.1 } } });
  if (rsEl)  _charts.rs  = LightweightCharts.createChart(rsEl,  { ..._chartOptions(SUB_CHART_H), rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.1, bottom: 0.1 } } });

  _charts.main.applyOptions({
    watermark: {
      visible:    true,
      fontSize:   36,
      horzAlign:  'center',
      vertAlign:  'center',
      color:      'rgba(255,255,255,0.03)',
      text:       AppState.activeCode || '',
    },
  });

  _syncCrosshair();
  _setupResize(mainEl);
}

// ─────────────────────────────────────────────
// 十字線跨圖表同步
// ─────────────────────────────────────────────
function _syncCrosshair() {
  const all = [_charts.main, _charts.kd, _charts.rsi, _charts.macd,
               _charts.dmi, _charts.psy, _charts.rci, _charts.hv, _charts.conviction,
               _charts.ttm, _charts.obv, _charts.rs].filter(Boolean);
  all.forEach((chart, idx) => {
    chart.subscribeCrosshairMove(param => {
      if (!param.time) return;
      all.forEach((other, oidx) => {
        if (oidx !== idx) {
          try {
            other.setCrosshairPosition(NaN, param.time, Object.values(_series)[0]);
          } catch (e) { /**/ }
        }
      });
    });
  });
}

// ─────────────────────────────────────────────
// RWD resize（只改 width，height 由 initCharts 決定）
// ─────────────────────────────────────────────
function _setupResize(refEl) {
  if (window._chartResize) window.removeEventListener('resize', window._chartResize);
  window._chartResize = () => {
    const w = refEl.parentElement.clientWidth;
    if (!w) return;  // 0610: 整個 chart-area 隱藏時不要把 width 寫成 0
    Object.values(_charts).forEach(c => c.applyOptions({ width: w }));
    if (!_charts.main) return;
    const panel = document.getElementById('chartPanel');
    if (panel?.classList.contains('fullscreen-mode')) {
      // 全視窗（閱讀室 62vh / 工作室 --studio-chart-h）：主圖 canvas 填滿 #mainChart 容器高。
      // 新版面副圖為 flex:0 0 排在下方可捲，主圖填滿不會擠到副圖。
      const h = refEl.clientHeight;
      if (h > 100) _charts.main.applyOptions({ height: h });
    } else {
      // 主頁：用設定高度（可手動拉），副圖各自固定高度不受影響
      _charts.main.applyOptions({ height: _storedMainH() });
    }
  };
  window.addEventListener('resize', window._chartResize);
  setTimeout(window._chartResize, 50);
}

// ─────────────────────────────────────────────
// 副圖時間軸對齊主圖（讀主圖目前可視範圍，套到所有副圖）
// 主圖範圍為 null（容器 0 寬時）就跳過，留給之後的 rAF 再對齊
// ─────────────────────────────────────────────
function _syncSubRangesToMain() {
  try {
    const range = _charts.main?.timeScale().getVisibleRange();
    if (!range) return;
    [_charts.kd, _charts.rsi, _charts.macd, _charts.dmi, _charts.psy, _charts.rci, _charts.hv, _charts.conviction, _charts.ttm, _charts.obv, _charts.rs]
      .filter(Boolean)
      .forEach(c => { try { c.timeScale().setVisibleRange(range); } catch (e) { /**/ } });
  } catch (e) { /**/ }
}

// ─────────────────────────────────────────────
// 渲染 K 線 + 所有指標
// ─────────────────────────────────────────────
export function renderChartData(candles) {
  if (!candles.length) return;
  AppState.lastCandles = candles;
  const closes = candles.map(c => c.close);

  _renderCandlestick(candles);
  _renderVolume(candles);
  _renderMA(candles, closes);
  if (AppState.indicators.BB) _renderBollinger(candles, closes);
  else _clearBandFill('bb');   // BB 關閉時清掉填色 canvas 殘留

  // Advanced 5 主圖 overlay（開關在 AppState.indicators）
  if (AppState.indicators.EMA)  _renderEMA(candles, closes);
  if (AppState.indicators.GMMA) _renderGMMA(candles, closes);
  if (AppState.indicators.SAR)  _renderSAR(candles);
  if (AppState.indicators.SUPERTREND) _renderSupertrend(candles);
  // T-2 Anchored VWAP（妖股 active 自動掛啟動日錨，否則可見區間起算 ≈）
  if (AppState.indicators.AVWAP) _renderAVWAP(candles);
  else _clearAVWAP();
  if (AppState.indicators.ENV)  _renderEnvelope(candles, closes);
  else _clearBandFill('env');  // ENV 關閉時清掉填色 canvas 殘留
  // C1 一目均衡表（雲帶 + 5 條線）
  if (AppState.indicators.ICHI) {
    _renderIchimoku(candles);
  } else {
    // ⚠️ ICHI 關閉時主動清理殘留(5條 LineSeries + canvas overlay + 訂閱)
    // 否則切週期/取消勾選時會留下殘影
    _clearIchimoku();
  }
  // C3 分價量表
  if (AppState.indicators.PVD) {
    renderPVD(candles);
  } else {
    clearPVD();
  }

  // 原有副圖
  if (AppState.indicators.KD)   _renderKD(candles);
  if (AppState.indicators.RSI)  _renderRSI(candles, closes);
  if (AppState.indicators.MACD) _renderMACD(candles, closes);

  // Advanced 5 副圖
  if (AppState.indicators.DMI)  _renderDMI(candles);
  if (AppState.indicators.PSY)  _renderPSY(candles, closes);
  if (AppState.indicators.RCI)  _renderRCI(candles, closes);
  if (AppState.indicators.HV)   _renderHV(candles, closes);
  if (AppState.indicators.CONV) _renderConviction(candles);
  if (AppState.indicators.TTM)  _renderTTM(candles);
  if (AppState.indicators.OBV)  _renderOBV(candles);
  if (AppState.indicators.RS)   _renderRS(candles);

  // Ichimoku 真正渲染成功時,_renderIchimoku 內已設可視範圍涵蓋未來 26 日,
  // 此處跳過 fitContent 避免覆蓋(否則 SenkouA/B 未來段會被切掉)
  // ⚠️ 用 _ichiData 而不是 AppState.indicators.ICHI:
  //   ICHI 開啟但 candles 不足 52 根時,calcIchimoku ready=false,
  //   _ichiData 會是 null,此時應該照常 fitContent,否則 K 線停在預設右側位置
  // ⚠️ fitContent 必須在「副圖對齊主圖之前」做：否則副圖拿到的是還沒 fit 的
  //   預設範圍（全視窗變寬時兩者差很多 → 副圖畫在錯誤/空白範圍，看起來全黑）
  if (!_ichiData) {
    _charts.main.timeScale().fitContent();
  }
  // 副圖時間軸對齊主圖（fit 後的有效範圍）
  _syncSubRangesToMain();

  // Phase 7: 廣播一次「K 線已渲染」事件,讓 overlay 重新 attach
  try {
    window.dispatchEvent(new CustomEvent('chartRendered', {
      detail: { code: AppState.activeCode, candleCount: candles.length },
    }));
  } catch (e) { /**/ }

  // 全視窗/重建後修正：版面 flush 後再強制重量一次尺寸 + 重新對齊副圖。
  // 副圖在 initCharts 重建的當下若容器尺寸尚未 flush（0 寬），canvas 建在 0 寬、
  // 且主圖 getVisibleRange() 會回 null → 同步對齊抓不到範圍 → 副圖空白（全黑）。
  // rAF 保證版面 flush 後執行，此時容器有尺寸、主圖範圍有效，再對齊一次就有圖。
  requestAnimationFrame(() => {
    try { window._chartResize?.(); } catch (e) {}
    _syncSubRangesToMain();
  });
}

// ─── 主圖：K 線 ───
function _renderCandlestick(candles) {
  _series.candle = _charts.main.addCandlestickSeries({
// 改成（台股邏輯）—— 對的
upColor:       '#ef5350',  // 漲 → 紅
downColor:     '#26a69a',  // 跌 → 綠
borderUpColor: '#ef5350',
borderDownColor:'#26a69a',
wickUpColor:   '#ef5350',
wickDownColor: '#26a69a',
  });
  _series.candle.setData(
    candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
  );
}

// ─── 主圖：成交量 ───
function _renderVolume(candles) {
  _series.volume = _charts.main.addHistogramSeries({
    priceFormat:  { type: 'volume' },
    priceScaleId: 'volume',
    color:        'rgba(138,143,153,0.3)',
  });
  _charts.main.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  _series.volume.setData(
    candles.map(c => ({
      time:  c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(239,83,80,0.4)' : 'rgba(38,166,154,0.4)',
    }))
  );
}

// ─── 主圖：均線 ───
const MA_COLORS = { 5: '#f59e0b', 10: '#26a69a', 20: '#60a5fa', 60: '#f472b6' };

function _renderMA(candles, closes) {
  [5, 10, 20, 60].forEach(n => {
    if (!AppState.ma[n]) return;
    // GMMA 開啟時自動隱藏 MA5/10/20（與顧比短軸語意重複，疊圖變義大利麵），MA60 保留
    if (AppState.indicators?.GMMA && n !== 60) return;
    const ma  = calcMA(closes, n);
    const key = `ma${n}`;
    _series[key] = _charts.main.addLineSeries({
      color:                  MA_COLORS[n],
      lineWidth:              1,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    _series[key].setData(
      candles
        .map((c, i) => ma[i] !== null ? { time: c.time, value: ma[i] } : null)
        .filter(Boolean)
    );
  });
}

// ─── 主圖：布林通道（Bollinger Bands）───
function _renderBollinger(candles, closes) {
  const bands = calcBollinger(closes, 20, 2);

  // 上軌
  _series.bbUpper = _charts.main.addLineSeries({
    color:                  'rgba(189,166,247,0.95)',
    lineWidth:              2,
    lineStyle:              1,   // dashed
    priceLineVisible:       false,
    lastValueVisible:       false,
    crosshairMarkerVisible: false,
  });
  // 中軌（MA20 同色但虛線）
  _series.bbMid = _charts.main.addLineSeries({
    color:                  'rgba(189,166,247,0.55)',
    lineWidth:              1,
    lineStyle:              2,
    priceLineVisible:       false,
    lastValueVisible:       false,
    crosshairMarkerVisible: false,
  });
  // 下軌
  _series.bbLower = _charts.main.addLineSeries({
    color:                  'rgba(189,166,247,0.95)',
    lineWidth:              2,
    lineStyle:              1,
    priceLineVisible:       false,
    lastValueVisible:       false,
    crosshairMarkerVisible: false,
  });

  const upperData = [], midData = [], lowerData = [];
  candles.forEach((c, i) => {
    const b = bands[i];
    if (!b) return;
    upperData.push({ time: c.time, value: b.upper });
    midData.push(  { time: c.time, value: b.mid   });
    lowerData.push({ time: c.time, value: b.lower });
  });

  _series.bbUpper.setData(upperData);
  _series.bbMid.setData(midData);
  _series.bbLower.setData(lowerData);

  // ── 上下軌間淡填色（通用 band fill，BB/ENV 共用）──
  _setBandFill('bb', upperData, lowerData, 'rgba(189,166,247,0.07)');
}

// ─── 通用通道填色 overlay（BB/ENV 共用，name 區分各自 canvas/訂閱）───
const _bandFills = {};   // name → { canvas, data, unsubs, color }

function _setBandFill(name, upperData, lowerData, color) {
  _clearBandFill(name);
  const mainEl = document.getElementById('mainChart');
  if (!mainEl || !_charts.main) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'band-fill-canvas';
  canvas.dataset.band = name;
  canvas.style.cssText = `
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 1;
  `;
  if (getComputedStyle(mainEl).position === 'static') {
    mainEl.style.position = 'relative';
  }
  mainEl.appendChild(canvas);

  const entry = { canvas, data: { upperData, lowerData }, unsubs: [], color };
  _bandFills[name] = entry;

  const ts = _charts.main.timeScale();
  const redraw = () => _drawBandFill(name);
  ts.subscribeVisibleTimeRangeChange(redraw);
  ts.subscribeVisibleLogicalRangeChange(redraw);
  const ro = new ResizeObserver(redraw);
  ro.observe(mainEl);
  entry.unsubs.push(() => ts.unsubscribeVisibleTimeRangeChange(redraw));
  entry.unsubs.push(() => ts.unsubscribeVisibleLogicalRangeChange(redraw));
  entry.unsubs.push(() => ro.disconnect());
  requestAnimationFrame(redraw);
}

function _clearBandFill(name) {
  const entry = _bandFills[name];
  if (!entry) return;
  entry.unsubs.forEach(unsub => { try { unsub(); } catch(e){} });
  try { entry.canvas.remove(); } catch(e){}
  delete _bandFills[name];
}

function _clearAllBandFills() {
  Object.keys(_bandFills).forEach(_clearBandFill);
  // 防累積殘留：掃掉 #mainChart 內所有 band-fill canvas（同 ichi-cloud-canvas 處理）
  const mainEl = document.getElementById('mainChart');
  if (mainEl) {
    mainEl.querySelectorAll('.band-fill-canvas').forEach(el => {
      try { el.remove(); } catch(e){}
    });
  }
}

function _drawBandFill(name) {
  const entry = _bandFills[name];
  if (!entry || !_charts.main) return;
  const candleSeries = _series.candle;
  if (!candleSeries) return;
  const mainEl = document.getElementById('mainChart');
  if (!mainEl) return;

  const canvas = entry.canvas;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = mainEl.clientWidth;
  const cssH = mainEl.clientHeight;
  if (canvas.width  !== cssW * dpr) canvas.width  = cssW * dpr;
  if (canvas.height !== cssH * dpr) canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // 以 time 配對上下軌，轉像素座標；視窗外/null 斷點切段
  const lowMap = new Map();
  entry.data.lowerData.forEach(p => lowMap.set(p.time, p.value));
  const timeScale = _charts.main.timeScale();
  const segs = [];
  let seg = [];
  for (const p of entry.data.upperData) {
    const lo = lowMap.get(p.time);
    const x  = timeScale.timeToCoordinate(p.time);
    const yu = (lo != null) ? candleSeries.priceToCoordinate(p.value) : null;
    const yl = (lo != null) ? candleSeries.priceToCoordinate(lo)      : null;
    if (x == null || yu == null || yl == null) {
      if (seg.length > 1) segs.push(seg);
      seg = [];
      continue;
    }
    seg.push({ x, yu, yl });
  }
  if (seg.length > 1) segs.push(seg);

  ctx.fillStyle = entry.color;
  for (const s of segs) {
    ctx.beginPath();
    ctx.moveTo(s[0].x, s[0].yu);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].yu);
    for (let i = s.length - 1; i >= 0; i--) ctx.lineTo(s[i].x, s[i].yl);
    ctx.closePath();
    ctx.fill();
  }
}


function _renderKD(candles) {
  const { k, d } = calcKD(candles);
  _series.kdK = _charts.kd.addLineSeries({ color: '#f59e0b', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true });
  _series.kdD = _charts.kd.addLineSeries({ color: '#60a5fa', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true });
  _series.kdK.setData(candles.map((c, i) => ({ time: c.time, value: k[i] })));
  _series.kdD.setData(candles.map((c, i) => ({ time: c.time, value: d[i] })));

  _series.kd80 = _charts.kd.addLineSeries({ color: 'rgba(239,83,80,0.3)',  lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.kd20 = _charts.kd.addLineSeries({ color: 'rgba(38,166,154,0.3)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.kd80.setData(candles.map(c => ({ time: c.time, value: 80 })));
  _series.kd20.setData(candles.map(c => ({ time: c.time, value: 20 })));
}

// ─── 副圖：RSI ───
function _renderRSI(candles, closes) {
  const rsi = calcRSI(closes);
  _series.rsi = _charts.rsi.addLineSeries({ color: '#a78bfa', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true });
  _series.rsi.setData(
    candles.map((c, i) => rsi[i] !== null ? { time: c.time, value: rsi[i] } : null).filter(Boolean)
  );

  _series.rsi70 = _charts.rsi.addLineSeries({ color: 'rgba(239,83,80,0.3)',  lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.rsi30 = _charts.rsi.addLineSeries({ color: 'rgba(38,166,154,0.3)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.rsi70.setData(candles.map(c => ({ time: c.time, value: 70 })));
  _series.rsi30.setData(candles.map(c => ({ time: c.time, value: 30 })));
}

// ─── 副圖：MACD ───
function _renderMACD(candles, closes) {
  const { dif, sigLine, hist } = calcMACD(closes);

  _series.macdHist = _charts.macd.addHistogramSeries({ color: 'rgba(138,143,153,0.5)', priceLineVisible: false, lastValueVisible: false });
  _series.macdHist.setData(candles.map((c, i) => ({
    time:  c.time,
    value: hist[i],
    color: hist[i] >= 0 ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,80,0.6)',
  })));

  _series.macdDif = _charts.macd.addLineSeries({ color: '#f59e0b', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true });
  _series.macdSig = _charts.macd.addLineSeries({ color: '#ef5350', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true });
  _series.macdDif.setData(candles.map((c, i) => ({ time: c.time, value: dif[i] })));
  _series.macdSig.setData(candles.map((c, i) => ({ time: c.time, value: sigLine[i] })));
}

// ══════════════════════════════════════════════════════
// Advanced 5 — 主圖 Overlay 指標
// ══════════════════════════════════════════════════════

// ── EMA(5/20/60) 均線 ──
function _renderEMA(candles, closes) {
  const periods = [5, 20, 60];
  const colors  = ['#f97316', '#a78bfa', '#34d399']; // 橘/紫/綠
  periods.forEach((p, idx) => {
    if (candles.length < p) return;
    const ema  = calcEMA(closes, p);
    const key  = `ema${p}`;
    if (_series[key]) { try { _charts.main.removeSeries(_series[key]); } catch(e){} }
    _series[key] = _charts.main.addLineSeries({
      color: colors[idx], lineWidth: 1.2, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false,  // 右軸標籤堆疊互蓋，關閉（crosshair 仍可讀值）
      title: `EMA${p}`,
    });
    _series[key].setData(candles.map((c, i) => ({ time: c.time, value: ema[i] })).filter(d => d.value != null));
  });
}

// ── GMMA 顧比均線（12條，預設隱藏，效能考量）──
function _renderGMMA(candles, closes) {
  if (candles.length < 62) return;
  const { short, long } = calcGMMA(closes);
  // alpha 漸層拉寬（外圈最亮→內圈最淡），群組輪廓更清楚
  const shortColors = ['rgba(239,83,80,0.9)','rgba(239,83,80,0.72)','rgba(239,83,80,0.56)',
                       'rgba(239,83,80,0.44)','rgba(239,83,80,0.34)','rgba(239,83,80,0.26)'];
  const longColors  = ['rgba(38,166,154,0.9)','rgba(38,166,154,0.72)','rgba(38,166,154,0.56)',
                       'rgba(38,166,154,0.44)','rgba(38,166,154,0.34)','rgba(38,166,154,0.26)'];

  [...short.map((s, i) => ({ arr: s, color: shortColors[i], key: `gmmaS${i}` })),
   ...long.map((l, i)  => ({ arr: l, color: longColors[i],  key: `gmmaL${i}` }))
  ].forEach(({ arr, color, key }) => {
    if (_series[key]) { try { _charts.main.removeSeries(_series[key]); } catch(e){} }
    _series[key] = _charts.main.addLineSeries({
      color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    _series[key].setData(candles.map((c, i) => ({ time: c.time, value: arr[i] })).filter(d => d.value != null));
  });
}

// ── SAR 拋物線（scatter 點，多頭在下/空頭在上）──
function _renderSAR(candles) {
  if (candles.length < 32) return;
  const sarArr = calcSAR(candles);
  const key    = 'sar';
  if (_series[key]) { try { _charts.main.removeSeries(_series[key]); } catch(e){} }

  // 多頭（SAR < 收盤）用紅色點在下，空頭用綠色點在上
  const bullData = [], bearData = [];
  candles.forEach((c, i) => {
    if (sarArr[i] == null) return;
    if (sarArr[i] < c.close) bullData.push({ time: c.time, value: sarArr[i] });
    else                     bearData.push({ time: c.time, value: sarArr[i] });
  });

  // ⚠️ lineWidth:0 在 LightweightCharts v4 會被強制成 1 仍畫連線（翻轉處拉出長對角假線）
  //   必須用 lineVisible:false 關掉線段，只留 pointMarkers 純點
  _series.sarBull = _charts.main.addLineSeries({
    color: '#ef5350', lineVisible: false, pointMarkersVisible: true,
    pointMarkersRadius: 2, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  _series.sarBear = _charts.main.addLineSeries({
    color: '#26a69a', lineVisible: false, pointMarkersVisible: true,
    pointMarkersRadius: 2, priceLineVisible: false, lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  if (bullData.length) _series.sarBull.setData(bullData);
  if (bearData.length) _series.sarBear.setData(bearData);
}

// ── T-7 Supertrend（ATR 通道翻轉線，多頭紅線貼底 / 空頭綠線貼頂）──
//   多/空分兩條 series，非當前方向以 whitespace {time} 留缺口 → 翻轉處乾淨斷線（不拉對角假線）
function _renderSupertrend(candles) {
  if (candles.length < 15) return;
  const st = calcSupertrend(candles, 10, 3);
  if (!st.ready) return;
  if (_series.stUp)   { try { _charts.main.removeSeries(_series.stUp);   } catch(e){} }
  if (_series.stDown) { try { _charts.main.removeSeries(_series.stDown); } catch(e){} }

  const upData = [], dnData = [];
  candles.forEach((c, i) => {
    const v = st.lineArr[i];
    if (v == null) { upData.push({ time: c.time }); dnData.push({ time: c.time }); return; }
    if (st.dirArr[i] === 'up') { upData.push({ time: c.time, value: v }); dnData.push({ time: c.time }); }
    else                       { dnData.push({ time: c.time, value: v }); upData.push({ time: c.time }); }
  });

  // 台股：多頭=紅、空頭=綠
  _series.stUp = _charts.main.addLineSeries({
    color: '#ef5350', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    crosshairMarkerVisible: false, title: 'ST↑',
  });
  _series.stDown = _charts.main.addLineSeries({
    color: '#26a69a', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    crosshairMarkerVisible: false, title: 'ST↓',
  });
  _series.stUp.setData(upData);
  _series.stDown.setData(dnData);
}

// ── T-6 TTM Squeeze 副圖（零軸壓縮點 + 動能柱）──
//   動能柱：紅(動能向上)/綠(動能向下)；壓縮點：零軸上 ON=琥珀、OFF=灰
function _renderTTM(candles) {
  if (!_charts.ttm) return;
  const labelEl = document.querySelector('#ttmPanel .ind-panel-label');
  const _NORMAL = '<span style="color:#fbbf24">● 壓縮點</span>' +
    '<span style="color:#ef5350">▮ 動能↑</span>' +
    '<span style="color:#26a69a">▮ 動能↓</span>' +
    '<span style="color:var(--hint);margin-left:4px">TTM Squeeze (20,2/1.5)</span>';
  const t = candles.length >= 25 ? calcTTMSqueeze(candles, 20, 2, 1.5) : { ready: false };
  if (!t.ready) {
    if (labelEl) labelEl.innerHTML = '<span style="color:var(--hint)">🔋 TTM Squeeze 此週期 K 棒不足（需 ≥ 25 根），請切換到 3月 / 6月 / 1年 週期</span>';
    return;
  }
  if (labelEl) labelEl.innerHTML = _NORMAL;

  // 動能柱
  _series.ttmHist = _charts.ttm.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, base: 0 });
  const histData = [];
  candles.forEach((c, i) => {
    const m = t.momArr[i];
    if (m == null) return;
    histData.push({ time: c.time, value: m, color: m >= 0 ? 'rgba(239,83,80,0.8)' : 'rgba(38,166,154,0.8)' });
  });
  _series.ttmHist.setData(histData);

  // 壓縮點（零軸）：ON=琥珀 / OFF=灰，分兩條 series（pointMarkers 無法逐點上色）
  const onDots = [], offDots = [];
  candles.forEach((c, i) => {
    if (t.onArr[i] == null) return;
    (t.onArr[i] ? onDots : offDots).push({ time: c.time, value: 0 });
  });
  _series.ttmOn = _charts.ttm.addLineSeries({ color: '#fbbf24', lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.ttmOff = _charts.ttm.addLineSeries({ color: 'rgba(148,163,184,0.7)', lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  if (onDots.length)  _series.ttmOn.setData(onDots);
  if (offDots.length) _series.ttmOff.setData(offDots);
}

// ── T-8 OBV 能量潮副圖（EMA3 平滑累計量能線）──
function _renderOBV(candles) {
  if (!_charts.obv) return;
  const labelEl = document.querySelector('#obvPanel .ind-panel-label');
  const _NORMAL = '<span style="color:#a78bfa">● OBV</span>' +
    '<span style="color:var(--hint);margin-left:4px">能量潮（EMA3 平滑）</span>';
  const o = candles.length >= 25 ? calcOBV(candles, 20) : { ready: false };
  if (!o.ready) {
    if (labelEl) labelEl.innerHTML = '<span style="color:var(--hint)">🌊 OBV 此週期 K 棒不足（需 ≥ 25 根），請切換到 3月 / 6月 / 1年 週期</span>';
    return;
  }
  if (labelEl) labelEl.innerHTML = _NORMAL;
  // OBV 絕對值無意義、數字龐大 → 軸改台股慣用「億/萬」縮寫
  _charts.obv.applyOptions({ localization: { priceFormatter: (v) => {
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + '億';
    if (a >= 1e4) return (v / 1e4).toFixed(0) + '萬';
    return v.toFixed(0);
  } } });
  _series.obvLine = _charts.obv.addLineSeries({ color: '#a78bfa', lineWidth: 1.4, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true });
  const data = [];
  candles.forEach((c, i) => { const v = o.obvArr[i]; if (v != null) data.push({ time: c.time, value: v }); });
  _series.obvLine.setData(data);
}

// ── T-1 RS 相對強度線副窗（個股還原收盤 / 大盤基準，正規化首點=100）──
//   基準：0050（含息 ETF，hist 還原價），fallback ^TWII；以 UTC 日對齊（容忍盤中時戳偏移）
//   價未創高但 RS 線先創高 = 歐尼爾體系最強領先訊號 → 末點若為近 60 日新高加紅箭頭
let _rsToken = 0;
let _rsBenchCache = null, _rsBenchAt = 0;
async function _getBench() {
  const now = Date.now();
  if (_rsBenchCache && (now - _rsBenchAt) < 30 * 60 * 1000) return _rsBenchCache;
  const b = await fetchBenchmark('0050');
  if (b && b.length) { _rsBenchCache = b; _rsBenchAt = now; }
  return b;
}
async function _renderRS(candles) {
  if (!_charts.rs) return;
  const labelEl = document.querySelector('#rsPanel .ind-panel-label');
  const _NORMAL = '<span style="color:#e3b341">● RS 相對強度線</span>' +
    '<span style="color:var(--hint);margin-left:4px">個股/大盤(0050)，正規化100 · 創高=領先大盤</span>';
  const _hint = (t) => { if (labelEl) labelEl.innerHTML = `<span style="color:var(--hint)">📈 RS 線：${t}</span>`; };
  if (!candles || candles.length < 20) { _hint('資料不足（需 ≥ 20 根），請切換到 3月 / 6月 / 1年 週期'); return; }

  const code  = AppState.activeCode || '';
  const token = ++_rsToken;
  let bench = null;
  try { bench = await _getBench(); } catch (e) {}
  // 競態防呆：抓基準期間若切股/切週期/關指標/重建圖，丟棄
  if (token !== _rsToken) return;
  if (code !== (AppState.activeCode || '') || !AppState.indicators.RS || !_charts.rs) return;
  if (!bench || bench.length < 20) { _hint('大盤基準暫時取得失敗'); return; }

  const dayKey = (sec) => Math.floor(sec / 86400);
  const bMap = new Map();
  bench.forEach(b => { const c = b.a ?? b.c; if (c != null) bMap.set(dayKey(b.t), c); });

  const pts = [];
  let base = null;
  candles.forEach(c => {
    const bc = bMap.get(dayKey(c.time));
    if (bc == null || !bc) return;
    const ratio = c.close / bc;
    if (base == null) base = ratio;
    pts.push({ time: c.time, value: +((ratio / base) * 100).toFixed(2) });
  });
  if (pts.length < 5) { _hint('與大盤日期對齊不足'); return; }

  if (labelEl) labelEl.innerHTML = _NORMAL;
  _series.rsLine = _charts.rs.addLineSeries({ color: '#e3b341', lineWidth: 1.6, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true });
  _series.rsLine.setData(pts);

  // 末點是否為近 60 日 RS 線新高（價未必創高，RS 先創高 = 領先訊號）
  const N = Math.min(60, pts.length);
  const recent = pts.slice(-N);
  const lastV  = recent[recent.length - 1].value;
  if (recent.every(p => p.value <= lastV + 1e-9)) {
    try { _series.rsLine.setMarkers([{ time: pts[pts.length - 1].time, position: 'aboveBar', color: '#ef5350', shape: 'arrowUp', text: 'RS創高' }]); } catch (e) {}
  }
}

// ── T-2 Anchored VWAP（錨定量加權均價，妖股 active 自動掛啟動日錨）──
//   錨點優先序：妖股啟動日（主升段成本）→ 可見區間首根（波段成本近似，標 ≈）
//   getYaoguRecord 為 async，期間若切股/切週期/關閉 → token 比對放棄繪製
let _avwapToken = 0;
async function _renderAVWAP(candles) {
  if (!candles || candles.length < 2) { _clearAVWAP(); return; }
  const code  = AppState.activeCode || '';
  const token = ++_avwapToken;

  // 妖股 active/rebirth → 取啟動日 unix 秒，否則 null（解析器自動退波段低點）
  let actSec = null;
  try {
    const rec = code ? await getYaoguRecord(code) : null;
    const act = rec && (rec.status === 'active' || rec.status === 'rebirth' || rec.status === 'pullback') ? rec.activatedAt : null;
    if (act) {
      const s = Math.floor(new Date(act).getTime() / 1000);
      if (!Number.isNaN(s)) actSec = s;
    }
  } catch (e) { /* 妖股庫缺失 → 用波段低點 */ }

  // async 競態防呆
  if (token !== _avwapToken) return;
  if (code !== (AppState.activeCode || '') || !AppState.indicators.AVWAP || !_charts.main) return;

  const { anchorIdx, source } = resolveAVWAPAnchor(candles, actSec);
  const av = anchoredVWAP(candles, anchorIdx);
  if (_series.avwap) { try { _charts.main.removeSeries(_series.avwap); } catch (e) {} }
  _series.avwap = _charts.main.addLineSeries({
    color: '#fbbf24', lineWidth: 2, lineStyle: 2,   // 琥珀虛線
    priceLineVisible: false, lastValueVisible: false,  // 右軸與 MA 標籤互蓋，關閉（crosshair 仍可讀）
    crosshairMarkerVisible: true,
    title: source === 'yaogu' ? '⚓AVWAP啟動' : '⚓AVWAP波段',
  });
  _series.avwap.setData(
    candles.map((c, i) => av[i] != null ? { time: c.time, value: av[i] } : null).filter(Boolean)
  );
}

function _clearAVWAP() {
  if (_series.avwap) {
    try { _charts.main.removeSeries(_series.avwap); } catch (e) {}
    _series.avwap = null;
  }
}

// ── ENV 包絡線（MA20 ± 5%）──
function _renderEnvelope(candles, closes) {
  if (closes.length < 20) return;
  const env = calcEnvelope(closes, 20, 5);
  ['upper', 'mid', 'lower'].forEach((band, idx) => {
    const colors = ['rgba(192,132,252,0.9)', 'rgba(192,132,252,0.45)', 'rgba(192,132,252,0.9)'];
    const styles = [2, 1, 2]; // 虛線/實線/虛線
    const key = `env${band}`;
    if (_series[key]) { try { _charts.main.removeSeries(_series[key]); } catch(e){} }
    _series[key] = _charts.main.addLineSeries({
      color: colors[idx], lineWidth: idx === 1 ? 1 : 2,
      lineStyle: styles[idx],
      priceLineVisible: false, lastValueVisible: false,  // 右軸 ENV± 標籤與收盤互蓋，關閉
      title: idx === 0 ? 'ENV+' : idx === 2 ? 'ENV-' : '',
    });
    _series[key].setData(
      candles.map((c, i) => env[i] ? ({ time: c.time, value: env[i][band] }) : null).filter(Boolean)
    );
  });

  // 上下軌間淡填色（與 BB 共用通用 band fill）
  const upperData = [], lowerData = [];
  candles.forEach((c, i) => {
    if (!env[i]) return;
    upperData.push({ time: c.time, value: env[i].upper });
    lowerData.push({ time: c.time, value: env[i].lower });
  });
  _setBandFill('env', upperData, lowerData, 'rgba(192,132,252,0.06)');
}

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// C1 一目均衡表 Ichimoku Cloud（v2.3 完美雲帶版）
// ──────────────────────────────────────────────────────
// 【最佳使用週期(以 K 數 ≥ 52 為硬門檻,≥ 78 為視覺完美)】
//   ❌ 5d ( 5 根)  K 數遠不足,calcIchimoku 直接 ready:false
//   ❌ 1mo (20 根) 同上
//   ⚠️ 3mo (60 根) Tenkan/Kijun 有,但 SenkouB 只有最後 8 根,雲帶幾乎空白
//   ✅ 6mo (120 根日K)  雲帶完整可看
//   ✅ 1y  (250 根日K)  Ichimoku 最佳工作週期(細田悟一原始設計)
//   ✅ 2y  (104 根週K)  注意!2y 是「週K」不是日K
//                       Tenkan 9 週 ≈ 45 天,Kijun 26 週 ≈ 半年
//                       未來雲帶涵蓋未來 26 週 ≈ 半年
//                       → 長線視角的 Ichimoku,適合存股/長線布局
// ──────────────────────────────────────────────────────
// 5 條線 + 雲帶填色 = 6 個視覺元素
// 雲帶實作策略:
//   LightweightCharts v4.1 沒有「兩線間填色」原生 API,
//   也沒有 ISeriesPrimitive(v4.2+ 才有)。
//   採用「獨立 canvas overlay」蓋在 main chart 之上,
//   訂閱 visibleTimeRangeChange / sizeChange 動態重繪。
//   - SenkouA > SenkouB → 多頭雲(綠)
//   - SenkouA < SenkouB → 空頭雲(紅)
//   - 顏色翻轉處自動形成鋸齒邊界(找零交叉點精準插值)
// ══════════════════════════════════════════════════════
const ICHI_KEYS = ['ichiTenkan', 'ichiKijun', 'ichiChikou', 'ichiSenkouA', 'ichiSenkouB'];
let _ichiCanvas = null;          // 雲帶 canvas overlay
let _ichiData   = null;          // 最近一次 calcIchimoku 的結果
let _ichiUnsubs = [];            // 訂閱清理函式

function _clearIchimoku() {
  // 1. 移除 5 條 LineSeries
  ICHI_KEYS.forEach(k => {
    if (_series[k]) {
      try { _charts.main?.removeSeries(_series[k]); } catch(e){}
      _series[k] = null;
    }
  });
  // 2. 取消所有訂閱(包在 try 內,因為訂閱對的可能是已 remove 的 chart)
  _ichiUnsubs.forEach(unsub => { try { unsub(); } catch(e){} });
  _ichiUnsubs = [];
  // 3. 移除 canvas overlay
  //    - 先用變數指向的元素移除(快路徑)
  //    - 再掃 #mainChart 找所有 .ichi-cloud-canvas(防累積殘留)
  if (_ichiCanvas) {
    try { _ichiCanvas.remove(); } catch(e){}
    _ichiCanvas = null;
  }
  const mainEl = document.getElementById('mainChart');
  if (mainEl) {
    mainEl.querySelectorAll('.ichi-cloud-canvas').forEach(el => {
      try { el.remove(); } catch(e){}
    });
  }
  // 4. 清資料快照
  _ichiData = null;
}

/**
 * 建立雲帶 canvas overlay
 * 蓋在 main chart container 上,絕對定位,pointer-events:none
 */
function _createIchiCanvas() {
  const mainEl = document.getElementById('mainChart');
  if (!mainEl) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'ichi-cloud-canvas';
  canvas.style.cssText = `
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2;
  `;
  // 確保 mainEl 是 relative,canvas 才能正確定位
  if (getComputedStyle(mainEl).position === 'static') {
    mainEl.style.position = 'relative';
  }
  mainEl.appendChild(canvas);
  return canvas;
}

/**
 * 重繪雲帶填色
 * 對每對相鄰時間點 (t_i, t_{i+1}):
 *   - 取 senkouA / senkouB 在這兩點的值
 *   - 用 timeToCoordinate / priceToCoordinate 轉成像素座標
 *   - 若兩點 A-B 同號 → 直接畫梯形
 *   - 若兩點 A-B 異號 → 找零交叉點(線性插值),拆兩個三角形分別上色
 */
function _drawIchiCloud() {
  if (!_ichiCanvas || !_ichiData || !_charts.main) return;
  const candleSeries = _series.candle;
  if (!candleSeries) return;

  const mainEl = document.getElementById('mainChart');
  if (!mainEl) return;

  // 配合 devicePixelRatio 讓線銳利
  const dpr  = window.devicePixelRatio || 1;
  const cssW = mainEl.clientWidth;
  const cssH = mainEl.clientHeight;
  if (_ichiCanvas.width  !== cssW * dpr) _ichiCanvas.width  = cssW * dpr;
  if (_ichiCanvas.height !== cssH * dpr) _ichiCanvas.height = cssH * dpr;
  _ichiCanvas.style.width  = cssW + 'px';
  _ichiCanvas.style.height = cssH + 'px';

  const ctx = _ichiCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { senkouA, senkouB } = _ichiData;
  if (!senkouA?.length || !senkouB?.length) return;

  // 對齊兩條線(用 time 為 key 配對),產出 {time, a, b}[]
  const bMap = new Map();
  senkouB.forEach(p => bMap.set(p.time, p.value));
  const pairs = [];
  senkouA.forEach(p => {
    const b = bMap.get(p.time);
    if (b != null && Number.isFinite(p.value) && Number.isFinite(b)) {
      pairs.push({ time: p.time, a: p.value, b: b });
    }
  });
  if (pairs.length < 2) return;

  const timeScale = _charts.main.timeScale();
  // 轉成像素座標,過濾掉視窗外的點
  const pts = pairs.map(p => {
    const x  = timeScale.timeToCoordinate(p.time);
    const ya = candleSeries.priceToCoordinate(p.a);
    const yb = candleSeries.priceToCoordinate(p.b);
    return (x == null || ya == null || yb == null) ? null
         : { x, ya, yb, diff: p.a - p.b };
  });

  // 顏色設定(與標準 Ichimoku 對齊)
  const BULL = 'rgba(38, 166, 154, 0.18)';   // 多頭雲(綠,跟 candle up 同色系但更淡)
  const BEAR = 'rgba(239, 83, 80, 0.18)';    // 空頭雲(紅)
  const BULL_EDGE = 'rgba(38, 166, 154, 0.32)';
  const BEAR_EDGE = 'rgba(239, 83, 80, 0.32)';

  // 對相鄰的兩個點(都不是 null 才畫)一段段畫梯形
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    if (!p1 || !p2) continue;
    if (p1.diff === 0 && p2.diff === 0) continue;  // 完全重合,跳過

    // Case A: 兩點同向 → 一個梯形
    if (Math.sign(p1.diff) === Math.sign(p2.diff) || p1.diff === 0 || p2.diff === 0) {
      const isBull = (p1.diff + p2.diff) >= 0;
      ctx.fillStyle   = isBull ? BULL : BEAR;
      ctx.strokeStyle = isBull ? BULL_EDGE : BEAR_EDGE;
      ctx.lineWidth   = 0.6;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.ya);
      ctx.lineTo(p2.x, p2.ya);
      ctx.lineTo(p2.x, p2.yb);
      ctx.lineTo(p1.x, p1.yb);
      ctx.closePath();
      ctx.fill();
    }
    // Case B: 兩點 A-B 異號 → 在這段內必有交叉點,拆兩個梯形
    else {
      // 用「a-b 差」線性插值找交叉 x
      // diff(x) = p1.diff + (p2.diff - p1.diff) * t , t∈[0,1]
      // diff=0 時 t = p1.diff / (p1.diff - p2.diff)
      const t = p1.diff / (p1.diff - p2.diff);
      const xC  = p1.x  + (p2.x  - p1.x)  * t;
      const yC  = p1.ya + (p2.ya - p1.ya) * t;  // A 在交叉點的 y(此處 A=B,所以等於 B 的 y)

      // 第一段 p1 → 交叉:顏色取 p1 的方向
      const isBull1 = p1.diff > 0;
      ctx.fillStyle = isBull1 ? BULL : BEAR;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.ya);
      ctx.lineTo(xC,   yC);
      ctx.lineTo(xC,   yC);   // 交叉點 A=B,退化為三角形
      ctx.lineTo(p1.x, p1.yb);
      ctx.closePath();
      ctx.fill();

      // 第二段 交叉 → p2:顏色取 p2 的方向
      const isBull2 = p2.diff > 0;
      ctx.fillStyle = isBull2 ? BULL : BEAR;
      ctx.beginPath();
      ctx.moveTo(xC,   yC);
      ctx.lineTo(p2.x, p2.ya);
      ctx.lineTo(p2.x, p2.yb);
      ctx.lineTo(xC,   yC);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function _renderIchimoku(candles) {
  // 先清舊的(切週期 / toggle 時避免殘留)
  _clearIchimoku();

  const ichi = calcIchimoku(candles);
  if (!ichi._meta.ready) return;  // 資料不足靜默跳過

  _ichiData = ichi;

  // ── 標準配色(對齊 TradingView / StockCharts) ──
  // 轉換線(Tenkan):  橘紅,最敏感的線
  // 基準線(Kijun):   深藍,中速線
  // 延遲線(Chikou):  深綠,後移 26 日
  // 先行帶 A:        淡綠(雲頂候選色之一)
  // 先行帶 B:        淡紅(雲頂候選色之一)
  // 雲帶填色:        A>B 綠雲 / A<B 紅雲(canvas overlay 動態畫)

  // 1. 轉換線(Tenkan)— 橘紅
  _series.ichiTenkan = _charts.main.addLineSeries({
    color: '#f59e0b', lineWidth: 1.4, priceLineVisible: false, lastValueVisible: true,
    title: '轉換',
  });
  _series.ichiTenkan.setData(
    candles.map((c, i) => ichi.tenkan[i] != null
      ? ({ time: c.time, value: +ichi.tenkan[i].toFixed(4) }) : null).filter(Boolean)
  );

  // 2. 基準線(Kijun)— 深藍
  _series.ichiKijun = _charts.main.addLineSeries({
    color: '#3b82f6', lineWidth: 1.6, priceLineVisible: false, lastValueVisible: true,
    title: '基準',
  });
  _series.ichiKijun.setData(
    candles.map((c, i) => ichi.kijun[i] != null
      ? ({ time: c.time, value: +ichi.kijun[i].toFixed(4) }) : null).filter(Boolean)
  );

  // 3. 延遲線(Chikou)— 深綠
  _series.ichiChikou = _charts.main.addLineSeries({
    color: '#10b981', lineWidth: 1.2, lineStyle: 0,
    priceLineVisible: false, lastValueVisible: true,
    title: '延遲',
  });
  _series.ichiChikou.setData(
    candles.map((c, i) => ichi.chikou[i] != null
      ? ({ time: c.time, value: +ichi.chikou[i].toFixed(4) }) : null).filter(Boolean)
  );

  // 4. 先行帶 A(SenkouA)— 純線淡綠(雲帶填色由 canvas overlay 處理)
  _series.ichiSenkouA = _charts.main.addLineSeries({
    color: 'rgba(38, 166, 154, 0.75)',  // 淡綠
    lineWidth: 1,
    priceLineVisible: false, lastValueVisible: true,
    title: '先行A',
  });
  _series.ichiSenkouA.setData(ichi.senkouA);

  // 5. 先行帶 B(SenkouB)— 純線淡紅
  _series.ichiSenkouB = _charts.main.addLineSeries({
    color: 'rgba(239, 83, 80, 0.75)',   // 淡紅
    lineWidth: 1,
    priceLineVisible: false, lastValueVisible: true,
    title: '先行B',
  });
  _series.ichiSenkouB.setData(ichi.senkouB);

  // ── 雲帶 canvas overlay ──
  _ichiCanvas = _createIchiCanvas();
  if (_ichiCanvas) {
    // 訂閱可視範圍變化 / 大小變化 → 自動重繪
    const ts = _charts.main.timeScale();
    const onRangeChange = () => _drawIchiCloud();
    const onSizeChange  = () => _drawIchiCloud();
    ts.subscribeVisibleTimeRangeChange(onRangeChange);
    ts.subscribeVisibleLogicalRangeChange(onRangeChange);
    // 同時掛 ResizeObserver 監聽 container 大小變化
    const ro = new ResizeObserver(onSizeChange);
    ro.observe(document.getElementById('mainChart'));
    _ichiUnsubs.push(() => ts.unsubscribeVisibleTimeRangeChange(onRangeChange));
    _ichiUnsubs.push(() => ts.unsubscribeVisibleLogicalRangeChange(onRangeChange));
    _ichiUnsubs.push(() => ro.disconnect());
    // 首次繪製(下一個 frame 讓 chart 完成佈局)
    requestAnimationFrame(() => _drawIchiCloud());
  }

  // ── 設可視範圍:涵蓋未來 26 日 + 近期較可靠的歷史 ──
  // 取近 120 根(約半年日K)+ 未來 26 天,落在「最近乎可靠」的範圍
  try {
    const n = candles.length;
    const fromIdx = Math.max(0, n - 120);
    const fromTime = candles[fromIdx].time;
    // 取 senkouA 最後一筆的 time 作為未來右邊界(已含 +26 日)
    const lastSenkouTime = ichi.senkouA.length
      ? ichi.senkouA[ichi.senkouA.length - 1].time
      : candles[n - 1].time;
    _charts.main.timeScale().setVisibleRange({
      from: fromTime,
      to:   lastSenkouTime,
    });
  } catch (e) { /**/ }

  // 廣播 Ichimoku 已渲染
  try {
    window.dispatchEvent(new CustomEvent('ichimokuRendered', {
      detail: {
        code: AppState.activeCode,
        ready: true,
        meta: ichi._meta,
      },
    }));
  } catch(e){}
}

// ══════════════════════════════════════════════════════
// Advanced 5 — 副圖指標
// ══════════════════════════════════════════════════════

// ── DMI（+DI/-DI/ADX）──
function _renderDMI(candles) {
  // 門檻 16：calcDMI 第 15 根起即有 +DI/-DI（畫得出線）；ADX 需第 28 根，不足時自動空著，
  // 切到 3月/6月/1年 才會補上 ADX。原本卡 30 會把 1個月(≈23根)整個擋掉且靜默無提示。
  const _dmiLabel = document.querySelector('#dmiPanel .ind-panel-label');
  if (!_charts.dmi || candles.length < 16) {
    if (_dmiLabel) _dmiLabel.innerHTML = `<span style="color:var(--hint)">📊 DMI：資料不足（需 ≥ 16 根），請切換到 3月 / 6月 / 1年 週期</span>`;
    return;
  }
  // 成功渲染：還原 +DI/-DI/ADX 圖例（避免從短週期切過來時標籤卡在提示）；ADX 不足時加註
  if (_dmiLabel) {
    const adxNote = candles.length < 28 ? ' <span style="color:var(--hint)">· ADX 需 ≥ 28 根</span>' : '';
    _dmiLabel.innerHTML = '<span style="color:#ef5350">● +DI</span> <span style="color:#26a69a">● -DI</span> <span style="color:#f59e0b">● ADX</span> <span style="color:var(--hint);margin-left:4px">DMI (14)</span>' + adxNote;
  }
  const { plusDI, minusDI, adx } = calcDMI(candles, 14);
  const t = (c, i) => ({ time: c.time, value: v => v });

  _series.dmiPlus = _charts.dmi.addLineSeries({ color: '#ef5350', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true, title: '+DI' });
  _series.dmiMinus = _charts.dmi.addLineSeries({ color: '#26a69a', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true, title: '-DI' });
  _series.dmiAdx   = _charts.dmi.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, title: 'ADX' });
  // ADX=20 基準線
  _series.dmiAdx20 = _charts.dmi.addLineSeries({ color: 'rgba(255,255,255,0.15)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  const filter = (arr) => candles.map((c, i) => arr[i] != null ? { time: c.time, value: arr[i] } : null).filter(Boolean);
  _series.dmiPlus.setData(filter(plusDI));
  _series.dmiMinus.setData(filter(minusDI));
  _series.dmiAdx.setData(filter(adx));
  _series.dmiAdx20.setData(candles.map(c => ({ time: c.time, value: 20 })));
}

// ── PSY 心理線 ──
function _renderPSY(candles, closes) {
  if (!_charts.psy || closes.length < 13) return;
  const psyArr = calcPSY(closes, 12);
  _series.psy    = _charts.psy.addLineSeries({ color: '#a78bfa', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true, title: 'PSY' });
  _series.psy75  = _charts.psy.addLineSeries({ color: 'rgba(239,83,80,0.3)',  lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.psy25  = _charts.psy.addLineSeries({ color: 'rgba(38,166,154,0.3)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const filter = (arr) => candles.map((c, i) => arr[i] != null ? { time: c.time, value: arr[i] } : null).filter(Boolean);
  _series.psy.setData(filter(psyArr));
  _series.psy75.setData(candles.map(c => ({ time: c.time, value: 75 })));
  _series.psy25.setData(candles.map(c => ({ time: c.time, value: 25 })));
}

// ── RCI 順位相關係數 ──
function _renderRCI(candles, closes) {
  if (!_charts.rci || closes.length < 9) return;
  const rci9  = calcRCI(closes, 9);
  const rci26 = calcRCI(closes, 26);
  _series.rci9   = _charts.rci.addLineSeries({ color: '#f97316', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true, title: 'RCI(9)' });
  _series.rci26  = _charts.rci.addLineSeries({ color: '#60a5fa', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true, title: 'RCI(26)' });
  _series.rci80  = _charts.rci.addLineSeries({ color: 'rgba(239,83,80,0.3)',  lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.rciN80 = _charts.rci.addLineSeries({ color: 'rgba(38,166,154,0.3)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const filter = (arr) => candles.map((c, i) => arr[i] != null ? { time: c.time, value: arr[i] } : null).filter(Boolean);
  _series.rci9.setData(filter(rci9));
  _series.rci26.setData(filter(rci26));
  _series.rci80.setData(candles.map(c => ({ time: c.time, value: 80 })));
  _series.rciN80.setData(candles.map(c => ({ time: c.time, value: -80 })));
}

// ── HV 歷史波動率（年化%）──
function _renderHV(candles, closes) {
  if (!_charts.hv || closes.length < 21) return;
  const hvArr = calcHV(closes, 20);
  _series.hv = _charts.hv.addLineSeries({ color: '#34d399', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: true, title: 'HV(20)' });
  _series.hv.setData(
    candles.map((c, i) => hvArr[i] != null ? { time: c.time, value: hvArr[i] } : null).filter(Boolean)
  );
}

// Advanced 8 — Conviction C 曲線副窗
function _renderConviction(candles) {
  if (!_charts.conviction) return;
  // C 需要 z 窗 60 + 暖機，至少 ~80 根才有意義 → 短週期（5日/1月/3月）資料不足
  const labelEl = document.querySelector('#convPanel .ind-panel-label');
  if (candles.length < 90) {
    if (labelEl) labelEl.innerHTML =
      '<span style="color:var(--hint)">⚡ 確信度 C 需要較長資料（z 窗 60 日），請切換到 6月 / 1年 / 2年 週期</span>';
    // 清掉舊線
    ['conviction', 'convP80', 'convP20', 'convZero'].forEach(k => {
      if (_series[k]) { try { _charts.conviction.removeSeries(_series[k]); } catch (e) {} _series[k] = null; }
    });
    return;
  }
  // 恢復正常 label
  if (labelEl) labelEl.innerHTML =
    '<span style="color:#fbbf24">● C 確信度</span>' +
    '<span style="color:rgba(96,165,250,.6)">▬ 股性帶 P20-P80</span>' +
    '<span style="color:var(--hint);margin-left:4px">動能×量能流×勝率 · 觀察工具非進場訊號</span>';
  const bars = candles.map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close,
    volume: c.volume ?? c.value ?? 0,
  }));
  const res = computeConviction(bars);
  if (!res.C.length) return;

  // P20-P80 股性帶（藍色淡帶，先畫帶再畫線，帶在底層）
  const upperData = candles.map((c, i) => res.p80[i] != null ? { time: c.time, value: res.p80[i] } : null).filter(Boolean);
  const lowerData = candles.map((c, i) => res.p20[i] != null ? { time: c.time, value: res.p20[i] } : null).filter(Boolean);
  // 帶的上下界線（淡，本身不顯眼，靠填色）
  _series.convP80 = _charts.conviction.addLineSeries({ color: 'rgba(96,165,250,0.25)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.convP20 = _charts.conviction.addLineSeries({ color: 'rgba(96,165,250,0.25)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.convP80.setData(upperData);
  _series.convP20.setData(lowerData);

  // 0 軸虛線（C 正負分界）
  _series.convZero = _charts.conviction.addLineSeries({ color: 'rgba(255,255,255,0.18)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _series.convZero.setData(candles.map(c => ({ time: c.time, value: 0 })));

  // C 曲線（琥珀 #fbbf24）
  _series.conviction = _charts.conviction.addLineSeries({ color: '#fbbf24', lineWidth: 1.6, priceLineVisible: false, lastValueVisible: true, title: 'C' });
  _series.conviction.setData(
    candles.map((c, i) => res.C[i] != null ? { time: c.time, value: +res.C[i].toFixed(3) } : null).filter(Boolean)
  );

  // Guard 事件標記（guard 由 1 掉到 veto 的那一日 = 爆量長黑硬否決）
  const markers = [];
  for (let i = 1; i < res.guard.length; i++) {
    if (res.guard[i] < 1 && res.guard[i - 1] >= 0.95 && res.C[i] != null) {
      markers.push({ time: candles[i].time, position: 'belowBar', color: '#ef5350', shape: 'arrowDown', text: 'Guard' });
    }
  }
  if (markers.length) _series.conviction.setMarkers(markers);
}

// ── Export helpers for Advanced 5 sub-charts ──
export function getDmiChart()  { return _charts.dmi  || null; }
export function getPsyChart()  { return _charts.psy  || null; }
export function getRciChart2() { return _charts.rci  || null; }
export function getHvChart()   { return _charts.hv   || null; }

// Fixed 模式：關閉/開啟 K 線的滾輪縮放與拖拽，讓滾輪回歸頁面捲動
export function setChartFixed(fixed) {
  const opts = { handleScroll: !fixed, handleScale: !fixed };
  Object.values(_charts).forEach(c => { try { c.applyOptions(opts); } catch(e){} });
}

/**
 * 全視窗模式進出時暫停/還原副圖渲染
 * 全視窗下副圖不可見，但 LightweightCharts 仍持續渲染 + crosshair 計算，吃 CPU
 * active=false：副圖 chart 停止互動（crosshair/scroll/scale 全關）
 * active=true：還原原本設定
 */
export function setSubChartsActive(active) {
  const subCharts = [_charts.kd, _charts.rsi, _charts.macd,
                     _charts.dmi, _charts.psy, _charts.rci, _charts.hv, _charts.conviction].filter(Boolean);
  subCharts.forEach(c => {
    try {
      c.applyOptions({
        handleScroll:    active,
        handleScale:     active,
        crosshair: {
          vertLine: { visible: active },
          horzLine: { visible: active },
        },
      });
    } catch(e) {}
  });
}

// ══════════════════════════════════════════════════════
// C3 分價量表（Price Volume Distribution, PVD）
// ──────────────────────────────────────────────────────
// 架構：右側獨立 canvas overlay，緊貼價格軸左邊
// 統計：可視範圍內 K 棒，依 high-low 把量均攤到各價格區間
// 顏色：多頭 K（close≥open）藍色左側 / 空頭 K 紅色右側
//       POC（最大量價位）橘色實心 + 橘色橫線
// 訂閱：visibleTimeRangeChange + visibleLogicalRangeChange + ResizeObserver
//       可視範圍拖動/縮放/視窗 resize → 自動重繪
//
// ⚠️ 踩雷：
//   - PVD canvas 要在 #mainChart 上 right 對齊，不是 chart-area
//     chart-area 包含副圖，PVD 只對應主圖高度
//   - canvas right = 價格軸寬度，動態取得避免遮蔽價格數字
//   - resize 後要重新計算 right，每次 _drawPVD 都更新
// ══════════════════════════════════════════════════════

const PVD_BINS      = 40;     // 價格分格數
const PVD_MAX_RATIO = 0.15;   // 長條最大寬度 = 主圖寬度 15%（不壓 K 棒）
const PVD_VA_RATIO  = 0.70;   // Value Area 涵蓋成交量比例

let _pvdCanvas = null;  // canvas DOM（覆蓋整個 mainChart，長條靠右繪製）
let _pvdUnsubs = [];    // 清理函式陣列
let _pvdState  = null;  // 最近一次繪製的 bin 統計，供 hover 查詢
let _pvdTip    = null;  // hover tooltip DOM

/**
 * 動態取得 LightweightCharts 右側價格軸寬度
 * 避免 PVD canvas 蓋住價格數字
 */
function _getPriceAxisWidth() {
  try {
    const ps = _charts.main?.priceScale('right');
    if (ps && typeof ps.width === 'function') return ps.width();
  } catch(e) {}
  return 65; // fallback（實測預設值）
}

/**
 * 清理 PVD canvas + tooltip + 所有訂閱
 */
function _clearPVD() {
  if (_pvdCanvas) {
    try { _pvdCanvas.remove(); } catch(e){}
    _pvdCanvas = null;
  }
  if (_pvdTip) {
    try { _pvdTip.remove(); } catch(e){}
    _pvdTip = null;
  }
  _pvdState = null;
  _pvdUnsubs.forEach(fn => { try { fn(); } catch(e){} });
  _pvdUnsubs = [];
}

/**
 * 建立 PVD canvas，附加到 #mainChart
 * 0610 改版：canvas 覆蓋整個主圖（扣掉價格軸），長條靠右繪製
 *   → POC 線 / Value Area 帶才能橫貫整張圖
 */
function _createPVDCanvas() {
  const mainEl = document.getElementById('mainChart');
  if (!mainEl) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'pvd-canvas';
  const priceAxisW = _getPriceAxisWidth();
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: ${priceAxisW}px;
    height: 100%;
    pointer-events: none;
    z-index: 3;
  `;
  if (getComputedStyle(mainEl).position === 'static') {
    mainEl.style.position = 'relative';
  }
  mainEl.appendChild(canvas);
  return canvas;
}

/**
 * 核心繪製：可視範圍統計、台股紅漲綠跌買賣力、POC 橫貫線、Value Area 帶
 * @param {Candle[]} candles - 全部 candles（從 AppState.lastCandles 來）
 */
function _drawPVD(candles) {
  if (!_pvdCanvas || !_charts.main || !candles?.length) return;

  // 取得可視範圍，只統計可視範圍內的 K 棒
  let visibleCandles = candles;
  try {
    const range = _charts.main.timeScale().getVisibleRange();
    if (range) {
      visibleCandles = candles.filter(c => c.time >= range.from && c.time <= range.to);
    }
  } catch(e) {}
  if (!visibleCandles.length) return;

  // 動態更新 canvas right（resize 後價格軸寬度可能改變）
  const priceAxisW = _getPriceAxisWidth();
  _pvdCanvas.style.right = priceAxisW + 'px';

  // DPR 補償，避免 Retina 模糊
  const mainEl = document.getElementById('mainChart');
  const dpr  = window.devicePixelRatio || 1;
  const cssH = _pvdCanvas.offsetHeight || mainEl?.clientHeight || 400;
  const cssW = (mainEl?.clientWidth || 600) - priceAxisW;
  _pvdCanvas.width  = Math.round(cssW * dpr);
  _pvdCanvas.height = Math.round(cssH * dpr);
  _pvdCanvas.style.width  = cssW + 'px';
  _pvdCanvas.style.height = cssH + 'px';

  const ctx = _pvdCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // 找價格範圍
  const highArr = visibleCandles.map(c => c.high ?? c.close);
  const lowArr  = visibleCandles.map(c => c.low  ?? c.close);
  const priceHigh = Math.max(...highArr);
  const priceLow  = Math.min(...lowArr);
  if (priceHigh <= priceLow) return;

  const binSize = (priceHigh - priceLow) / PVD_BINS;

  // 統計各 bin 的收紅/收綠成交量（台股慣例：紅=漲=吃貨，綠=跌=出貨）
  const upVol   = new Array(PVD_BINS).fill(0);  // 收紅日的量
  const downVol = new Array(PVD_BINS).fill(0);  // 收綠日的量

  for (const c of visibleCandles) {
    const vol  = c.volume || 0;
    const high = c.high ?? c.close;
    const low  = c.low  ?? c.close;
    const span = high - low;
    if (span <= 0 || vol <= 0) continue;
    const isUp = (c.close ?? c.open) >= (c.open ?? c.close);
    // 把量按 high-low 比例均攤到橫跨的 bin
    for (let b = 0; b < PVD_BINS; b++) {
      const binLow  = priceLow + b * binSize;
      const binHigh = binLow + binSize;
      const overlap = Math.min(high, binHigh) - Math.max(low, binLow);
      if (overlap <= 0) continue;
      const portion = overlap / span;
      if (isUp) upVol[b]   += vol * portion;
      else      downVol[b] += vol * portion;
    }
  }

  const totalVol = upVol.map((v, i) => v + downVol[i]);
  const sumVol   = totalVol.reduce((a, b) => a + b, 0);
  const maxVol   = Math.max(...totalVol, 1);

  // POC（最大成交量 bin）
  const pocIdx = totalVol.indexOf(Math.max(...totalVol));

  // Value Area：從 POC 向上下擴張（每次納入量較大的鄰 bin），直到涵蓋 70% 總量
  let vaLo = pocIdx, vaHi = pocIdx, vaSum = totalVol[pocIdx];
  while (vaSum < sumVol * PVD_VA_RATIO && (vaLo > 0 || vaHi < PVD_BINS - 1)) {
    const nextLo = vaLo > 0            ? totalVol[vaLo - 1] : -1;
    const nextHi = vaHi < PVD_BINS - 1 ? totalVol[vaHi + 1] : -1;
    if (nextHi >= nextLo) { vaHi++; vaSum += Math.max(nextHi, 0); }
    else                  { vaLo--; vaSum += Math.max(nextLo, 0); }
  }

  const candleSeries = _series.candle;
  if (!candleSeries) return;

  const BAR_MAX = Math.max(60, Math.round(cssW * Math.min(PVD_MAX_RATIO, 0.22)));  // 長條最大長度（封頂 22% 圖寬，避免蓋住右半邊 K 棒）
  const binY = (b) => {  // bin → { yTop, barH }
    const binLow  = priceLow + b * binSize;
    const yTop = candleSeries.priceToCoordinate(binLow + binSize);
    const yBot = candleSeries.priceToCoordinate(binLow);
    if (yTop == null || yBot == null) return null;
    return { y: Math.min(yTop, yBot), h: Math.max(Math.abs(yBot - yTop) - 1, 1) };
  };

  // 1. Value Area 帶（橫貫整圖，極淡橘）
  const vaTop = binY(vaHi), vaBot = binY(vaLo);
  if (vaTop && vaBot) {
    ctx.fillStyle = 'rgba(251, 146, 60, 0.05)';
    ctx.fillRect(0, vaTop.y, cssW, (vaBot.y + vaBot.h) - vaTop.y);
  }

  // 2. 分價量長條：靠右繪製，紅段（收紅量）在外、綠段（收綠量）在內
  for (let b = 0; b < PVD_BINS; b++) {
    const total = totalVol[b];
    if (total <= 0) continue;
    const pos = binY(b);
    if (!pos) continue;

    const totalW = Math.round((total / maxVol) * BAR_MAX);
    const upW    = Math.round((upVol[b] / total) * totalW);
    const downW  = totalW - upW;
    const alpha  = b === pocIdx ? 0.55 : 0.3;  // 降透明度，POC 仍突出

    // 從右緣往左：紅段
    if (upW > 0) {
      ctx.fillStyle = `rgba(239, 83, 80, ${alpha})`;
      ctx.fillRect(cssW - upW, pos.y, upW, pos.h);
    }
    // 綠段接續往左
    if (downW > 0) {
      ctx.fillStyle = `rgba(38, 166, 154, ${alpha})`;
      ctx.fillRect(cssW - upW - downW, pos.y, downW, pos.h);
    }
  }

  // 3. POC 橫貫虛線 + 價位標籤
  const pocMid = priceLow + (pocIdx + 0.5) * binSize;
  const pocY   = candleSeries.priceToCoordinate(pocMid);
  if (pocY != null) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.85)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, pocY);
    ctx.lineTo(cssW, pocY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(251, 146, 60, 0.95)';
    ctx.fillText(`POC ${pocMid.toFixed(2)}`, 4, pocY - 4);
  }

  // 暫存統計結果供 hover 查詢
  _pvdState = { priceLow, binSize, upVol, downVol, totalVol, sumVol, cssW, barZoneW: BAR_MAX, candleSeries };
}

/**
 * hover：滑到右側長條區顯示「價位區間 + 張數 + 佔比」
 * 監聽掛在 mainChart（PVD canvas 維持 pointer-events:none，不干擾圖表互動）
 */
function _setupPVDHover() {
  const mainEl = document.getElementById('mainChart');
  if (!mainEl) return;

  _pvdTip = document.createElement('div');
  _pvdTip.className = 'pvd-tooltip';
  _pvdTip.style.cssText = `
    position: absolute;
    display: none;
    padding: 3px 8px;
    background: rgba(22, 27, 34, 0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 4px;
    font-size: 11px;
    color: #e8eaed;
    pointer-events: none;
    z-index: 8;
    white-space: nowrap;
  `;
  mainEl.appendChild(_pvdTip);

  const onMove = (e) => {
    const st = _pvdState;
    if (!st || !_pvdTip) return;
    const rect = mainEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 只在右側長條區反應
    if (x < st.cssW - st.barZoneW || x > st.cssW) { _pvdTip.style.display = 'none'; return; }
    const price = st.candleSeries.coordinateToPrice?.(y);
    if (price == null) { _pvdTip.style.display = 'none'; return; }
    const b = Math.floor((price - st.priceLow) / st.binSize);
    if (b < 0 || b >= PVD_BINS || st.totalVol[b] <= 0) { _pvdTip.style.display = 'none'; return; }

    const lo = st.priceLow + b * st.binSize;
    const hi = lo + st.binSize;
    const lots = Math.round(st.totalVol[b] / 1000);            // 股 → 張
    const pct  = (st.totalVol[b] / st.sumVol * 100).toFixed(1);
    _pvdTip.textContent = `${lo.toFixed(2)}–${hi.toFixed(2)} · ${lots.toLocaleString()}張 · ${pct}%`;
    _pvdTip.style.display = 'block';
    _pvdTip.style.left = Math.max(4, x - 170) + 'px';
    _pvdTip.style.top  = Math.max(2, y - 24) + 'px';
  };
  const onLeave = () => { if (_pvdTip) _pvdTip.style.display = 'none'; };

  mainEl.addEventListener('mousemove', onMove);
  mainEl.addEventListener('mouseleave', onLeave);
  _pvdUnsubs.push(() => {
    mainEl.removeEventListener('mousemove', onMove);
    mainEl.removeEventListener('mouseleave', onLeave);
  });
}

/**
 * 啟動 PVD — export，供 renderChartData 呼叫
 */
export function renderPVD(candles) {
  _clearPVD();  // 先清舊的
  _pvdCanvas = _createPVDCanvas();
  if (!_pvdCanvas) return;

  const draw = () => _drawPVD(candles);
  const ts = _charts.main?.timeScale();
  if (ts) {
    ts.subscribeVisibleTimeRangeChange(draw);
    ts.subscribeVisibleLogicalRangeChange(draw);
    _pvdUnsubs.push(() => ts.unsubscribeVisibleTimeRangeChange(draw));
    _pvdUnsubs.push(() => ts.unsubscribeVisibleLogicalRangeChange(draw));
  }
  const ro = new ResizeObserver(draw);
  ro.observe(document.getElementById('mainChart') || document.body);
  _pvdUnsubs.push(() => ro.disconnect());

  _setupPVDHover();
  requestAnimationFrame(draw);
}

/**
 * 關閉 PVD — export，供 renderChartData 呼叫
 */
export function clearPVD() {
  _clearPVD();
}
