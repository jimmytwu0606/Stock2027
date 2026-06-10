/**
 * chart-exit-lines.js — K 線圖出場線 overlay（妖股監控圖形化）
 *
 * 畫「單一有效防線」：跌破就出場的那條線。
 *   紅虛線 = 防線在守本金（進場價 -20%，固定）
 *   橘虛線 = 防線已上移鎖獲利（高點 -25%，跟著高點爬）
 * 兩種顏色是同一條線的兩個階段，任何時刻圖上只有一條。
 *
 * 對外 API（由 stock-tabs.js 的 _renderYaoguChip 呼叫）：
 *   setExitLines({ guardLine, guardMode })   // guardMode: 'capital' | 'profit'
 *   clearExitLines()
 *
 * chart 重建（切週期等）會清掉 priceLine → 監聽 chartRendered 自動重掛。
 */

import { getCandleSeries } from './chart.js';

let _lines = [];
let _lastParams = null;
let _bound = false;

export function setExitLines(params) {
  _lastParams = params;
  _bindRehang();
  _apply();
}

export function clearExitLines() {
  _lastParams = null;
  _removeAll();
}

function _bindRehang() {
  if (_bound) return;
  _bound = true;
  window.addEventListener('chartRendered', () => {
    _lines = [];
    if (_lastParams) setTimeout(_apply, 50);
  });
}

function _apply() {
  const series = getCandleSeries();
  if (!series || !_lastParams) return;
  _removeAll();

  const { guardLine, guardMode } = _lastParams;
  if (!(guardLine > 0)) return;
  const LS = window.LightweightCharts?.LineStyle ?? { Dashed: 2 };
  const isProfit = guardMode === 'profit';

  try {
    _lines.push(series.createPriceLine({
      price: guardLine,
      color: isProfit ? '#f97316' : '#ef4444',
      lineWidth: 1,
      lineStyle: LS.Dashed,
      axisLabelVisible: true,
      title: isProfit ? '出場線(鎖利)' : '出場線(守本)',
    }));
  } catch (e) {
    console.warn('[exit-lines] createPriceLine failed:', e.message);
  }
}

function _removeAll() {
  const series = getCandleSeries();
  if (series) {
    for (const l of _lines) {
      try { series.removePriceLine(l); } catch (_) {}
    }
  }
  _lines = [];
}
