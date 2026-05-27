// js/multi-period.js
// ============================================================================
// Phase 7.4 — 多週期共振 Tab
// ============================================================================
// 對外 API:
//   initMultiPeriod({ containerSelector, getCode })  // 由 main.js 呼叫
//   renderMultiPeriod(code)                          // 切到 resonance tab 時觸發
//   refreshMultiPeriod()                             // 強制重算(目前沒人用,預留)
//
// 流程:
//   1. resolveYahooSymbol 取得 symbol(只解析一次)
//   2. Promise.all 平行抓 6 個週期的 K 線
//   3. 對每個週期跑 analyze(candles, { period })
//   4. 整合 → 共振矩陣 + 摘要卡 + 燈燈總結
//
// 效能:lazy load,點 Tab 才跑;同一檔同一 session 內結果做快取(切回不重算)
// ============================================================================

import { resolveYahooSymbol, fetchHistoryCached } from './api.js';
import { analyze, PERIOD_PROFILES } from './chart-analysis.js';
import { showDengLoading, hideDengLoading, dengToast, pickDengMessage } from './loading-deng.js';
import { pauseSignalScan, resumeSignalScan } from './signal-scan.js';

// 週期順序(短 → 長)
const PERIODS = ['5d', '1mo', '3mo', '6mo', '1y', '2y'];

// 週期顯示名稱
const PERIOD_LABELS = {
  '5d':  '5 日',
  '1mo': '1 月',
  '3mo': '3 月',
  '6mo': '6 月',
  '1y':  '1 年',
  '2y':  '2 年',
};

// 內部狀態
let _ctx = null;
let _containerEl = null;
let _lastCode = null;
let _lastResult = null;     // 同檔同 session 快取
let _running = false;       // 防止重複觸發

// ============================================================================
// 初始化
// ============================================================================
export function initMultiPeriod({ containerSelector, getCode }) {
  _ctx = { getCode };
  _containerEl = typeof containerSelector === 'string'
    ? document.querySelector(containerSelector)
    : containerSelector;
  if (!_containerEl) {
    console.warn('[multi-period] container not found:', containerSelector);
    return;
  }
  _containerEl.classList.add('mp-panel');
  _containerEl.innerHTML = `<div class="mp-empty">選擇個股後點此分頁,燈燈會分析 6 個週期 ~</div>`;
}

// ============================================================================
// 切換到 resonance Tab 時呼叫
// ============================================================================
export async function renderMultiPeriod(code, opts = {}) {
  if (!_containerEl || !code) return;
  const force = !!opts.force;

  // 同檔同 session 已算過,且不是強制重抓 → 直接渲染快取
  if (!force && _lastCode === code && _lastResult) {
    _renderUI(_lastResult);
    return;
  }
  // 防止重複觸發
  if (_running) return;
  _running = true;

  _lastCode = code;

  // 燈燈 inline loading 蓋在 panel 上
  _containerEl.innerHTML = `<div id="mpLoadingTarget"></div>`;
  const dengHandle = await showDengLoading({
    style: 'inline',
    target: '#mpLoadingTarget',
    messages: [
      '燈燈正在看 6 個週期 ~ 喵',
      '短線、中線、長線都要看 ~',
      '比較中,等等喔 ~',
      '快好了,燈燈在算分數 ~',
    ],
    mood: 'curious',
    cycleMs: 1500,
  });

  // Phase 7.4 — 進場前暫停訊號掃描,讓共振 Tab 的 6 個請求優先
  pauseSignalScan();

  try {
    // 1. 解析一次 symbol(避免每個週期都試 .TW/.TWO,省 5 次試探)
    //    用 1mo 做試探:它是常見預設週期,fetchHistory 通常拿得到
    const { symbol } = await resolveYahooSymbol(code, '1mo', { force });

    // 2. 平行抓 6 個週期(force 透傳到每個 fetch,跳過快取)
    //    api.js 的全域節流器會自動排隊,Worker 不會炸
    const fetchResults = await _fetchAllPeriodsThrottled(symbol, force);

    // 3. 各週期跑 analyze
    const periodReports = fetchResults.map(({ period, candles, error }) => {
      if (error || !candles.length) {
        return {
          period,
          label: PERIOD_LABELS[period],
          empty: true,
          reason: error || 'K 線無資料',
        };
      }
      let result;
      try {
        result = analyze(candles, { period });
      } catch (e) {
        return {
          period,
          label: PERIOD_LABELS[period],
          empty: true,
          reason: 'analyze 失敗:' + e.message,
        };
      }
      if (result.empty) {
        return {
          period,
          label: PERIOD_LABELS[period],
          empty: true,
          reason: result.reason || '資料不足',
        };
      }
      const trend = result.trend || { direction: 'flat', health: 50, summary: '無趨勢資料' };
      // 整理出摘要文字(從 trend.advice + box.advice + volumePrice.advice + srAdvice 抽幾條)
      const summaryLines = _buildSummaryLines(result);
      return {
        period,
        label: PERIOD_LABELS[period],
        empty: false,
        direction: trend.direction,
        health: trend.health,
        trendSummary: trend.summary,
        focus: result.profile?.focus || '',
        candleCount: result.candleCount,
        lastClose: result.lastClose,
        summaryLines,
        rawResult: result,
      };
    });

    // 4. 計算共振
    const resonance = _calcResonance(periodReports);

    // 5. 生成燈燈總結
    const dengSummary = _buildDengSummary(periodReports, resonance);

    // 收結果
    _lastResult = {
      code,
      symbol,
      asOf: Date.now(),
      periodReports,
      resonance,
      dengSummary,
    };

    // 若所有週期都失敗 → 友善錯誤頁 + 自動 retry 提示
    const allFailed = periodReports.every(r => r.empty);
    if (allFailed) {
      const throttled = periodReports.some(r =>
        /Too Many Requests|429|proxy 暫時無法|HTTP 5\d\d|timeout|timed out|Failed to fetch/i.test(r.reason || '')
      );
      _containerEl.innerHTML = `
        <div class="mp-error">
          <div class="mp-error-title">😿 燈燈這邊塞車了</div>
          <div class="mp-error-msg">
            ${throttled
              ? 'Cloudflare Worker 或 Yahoo Finance 暫時繁忙,等 10-30 秒再試 ~<br>(或先去別檔逛逛,過幾秒回來)'
              : '6 個週期都拿不到資料,可能 Yahoo Finance 異常或網路問題'}
          </div>
          <button class="mp-retry-btn" id="mpRetryBtn">重試</button>
        </div>
      `;
      _containerEl.querySelector('#mpRetryBtn')?.addEventListener('click', () => {
        _lastResult = null;
        renderMultiPeriod(code);
      });
      // 清快取,讓下次重點 Tab 會重抓
      _lastResult = null;
      return;
    }

    // 6. 渲染
    _renderUI(_lastResult);

    // 7. 燈燈在右下角丟個 toast 強調共振狀態(只在桌機)
    if (window.innerWidth >= 600) {
      // Phase 7.5 A2: 換成帶數字的活台詞
      const { text: resonanceText, mood: resonanceMood } = _dengLineForResonance(resonance);
      dengToast(resonanceText, { mood: resonanceMood, duration: 4000 });
    }
  } catch (e) {
    console.error('[multi-period] failed:', e);
    _containerEl.innerHTML = `
      <div class="mp-error">
        <div class="mp-error-title">😿 燈燈這邊有點卡</div>
        <div class="mp-error-msg">${_escape(e.message || String(e))}</div>
        <button class="mp-retry-btn" id="mpRetryBtn">重試</button>
      </div>
    `;
    _containerEl.querySelector('#mpRetryBtn')?.addEventListener('click', () => {
      _lastResult = null;
      renderMultiPeriod(code);
    });
  } finally {
    hideDengLoading(dengHandle);
    _running = false;
    // Phase 7.4 — 結束後恢復訊號掃描
    resumeSignalScan();
  }
}

export function refreshMultiPeriod() {
  if (_lastCode) {
    _lastResult = null;
    renderMultiPeriod(_lastCode);
  }
}

// ============================================================================
// 共振判定
// ============================================================================
function _calcResonance(periodReports) {
  // 過濾掉 empty 的週期
  const valid = periodReports.filter(r => !r.empty);
  const total = valid.length;

  if (total === 0) {
    return {
      total: 0, ups: 0, downs: 0, flats: 0,
      bias: 'unknown',
      label: '資料不足',
      scenarioForDeng: 'noData',
      mood: 'sad',
    };
  }

  const ups   = valid.filter(r => r.direction === 'up').length;
  const downs = valid.filter(r => r.direction === 'down').length;
  const flats = valid.filter(r => r.direction === 'flat').length;

  // 短線:5d + 1mo + 3mo(前 3 個有效)
  // 長線:6mo + 1y + 2y(後 3 個有效)
  const short = valid.filter(r => ['5d', '1mo', '3mo'].includes(r.period));
  const long  = valid.filter(r => ['6mo', '1y', '2y'].includes(r.period));

  const shortUps   = short.filter(r => r.direction === 'up').length;
  const shortDowns = short.filter(r => r.direction === 'down').length;
  const longUps    = long.filter(r => r.direction === 'up').length;
  const longDowns  = long.filter(r => r.direction === 'down').length;

  // 主要偏向
  let bias, label, scenarioForDeng, mood;
  if (ups >= Math.ceil(total * 0.7)) {
    bias = 'strong-bull';
    label = `${ups}/${total} 偏多 ✓`;
    scenarioForDeng = 'resonanceBull';
    mood = 'happy';
  } else if (downs >= Math.ceil(total * 0.7)) {
    bias = 'strong-bear';
    label = `${downs}/${total} 偏空 ✗`;
    scenarioForDeng = 'resonanceBear';
    mood = 'sad';
  } else if (shortDowns >= 2 && longUps >= 2) {
    bias = 'short-bear-long-bull';
    label = `短空長多 (分歧)`;
    scenarioForDeng = 'divergence';
    mood = 'curious';
  } else if (shortUps >= 2 && longDowns >= 2) {
    bias = 'short-bull-long-bear';
    label = `短多長空 (注意)`;
    scenarioForDeng = 'divergence';
    mood = 'curious';
  } else if (flats >= Math.ceil(total * 0.5)) {
    bias = 'mostly-flat';
    label = `多週期盤整`;
    scenarioForDeng = 'divergence';
    mood = 'curious';
  } else {
    bias = 'mixed';
    label = `多空交錯 (${ups}多 / ${downs}空 / ${flats}平)`;
    scenarioForDeng = 'divergence';
    mood = 'curious';
  }

  // 平均健康度
  const avgHealth = valid.length
    ? Math.round(valid.reduce((s, r) => s + (r.health || 0), 0) / valid.length)
    : 0;

  // 短長健康度
  const shortAvgHealth = short.length
    ? Math.round(short.reduce((s, r) => s + (r.health || 0), 0) / short.length)
    : null;
  const longAvgHealth = long.length
    ? Math.round(long.reduce((s, r) => s + (r.health || 0), 0) / long.length)
    : null;

  return {
    total, ups, downs, flats,
    shortUps, shortDowns, longUps, longDowns,
    avgHealth, shortAvgHealth, longAvgHealth,
    bias, label,
    scenarioForDeng, mood,
  };
}

// ============================================================================
// 燈燈總結
// ============================================================================
function _buildDengSummary(periodReports, reso) {
  const valid = periodReports.filter(r => !r.empty);
  if (!valid.length) {
    return {
      headline: '燈燈看不出來',
      lines: ['六個週期都沒有足夠資料,可能是新上市或停牌中。'],
    };
  }

  const lines = [];
  let headline;

  switch (reso.bias) {
    case 'strong-bull':
      headline = `多週期一致看多(平均健康度 ${reso.avgHealth})`;
      lines.push(`✓ 6 個週期中有 ${reso.ups} 個偏多,結構算健康`);
      if (reso.avgHealth >= 75) {
        lines.push('• 長線:可以繼續抱,趨勢明確');
        lines.push('• 短線:不追高,等回測 MA 再進場');
      } else {
        lines.push('• 多歸多,但健康度沒很高,別重押');
        lines.push('• 等明顯回測再分批進場');
      }
      lines.push('• 真的別賭神,燈燈不負責喵 ~');
      break;

    case 'strong-bear':
      headline = `多週期一致偏空(平均健康度 ${reso.avgHealth})`;
      lines.push(`✗ 6 個週期中有 ${reso.downs} 個偏空,結構不健康`);
      lines.push('• 想做多?燈燈勸你三思');
      lines.push('• 沒有跌深量縮、KD 低檔黃金交叉前不要接');
      lines.push('• 既有部位停損優先,別想凹單');
      break;

    case 'short-bull-long-bear':
      headline = `短多長空,可能只是反彈(短線健康 ${reso.shortAvgHealth} / 長線健康 ${reso.longAvgHealth})`;
      lines.push(`⚠ 短線(5d/1m/3m)轉強,但長線(6m/1y/2y)仍空`);
      lines.push('• 這通常是空頭反彈,別當救世主');
      lines.push('• 想做短線可以,但停利停損要嚴格');
      lines.push('• 別把短線反彈當趨勢翻轉');
      break;

    case 'short-bear-long-bull':
      headline = `長多短空,長線結構好但短線轉弱(短線健康 ${reso.shortAvgHealth} / 長線健康 ${reso.longAvgHealth})`;
      lines.push(`✓ 長線(6m/1y/2y)仍偏多,但短線(5d/1m/3m)動能轉弱`);
      lines.push('• 長線:結構還在,繼續抱沒問題');
      lines.push('• 短線:不追高,等回測長線支撐再加碼');
      lines.push('• 想新進場?等短線止跌訊號');
      break;

    case 'mostly-flat':
      headline = `多週期盤整,等方向出來`;
      lines.push('— 6 個週期都偏向盤整,沒有明確趨勢');
      lines.push('• 不適合追進,適合箱型操作');
      lines.push('• 等突破或跌破關鍵價再決定');
      break;

    case 'mixed':
    default:
      headline = `多空交錯(${reso.ups}多 / ${reso.downs}空 / ${reso.flats}平)`;
      lines.push('— 各週期看法不同,沒有共振訊號');
      lines.push('• 等更多週期一致再說');
      lines.push('• 進場可以,但部位要輕,停損要設');
      break;
  }

  // 補幾條具體週期亮點(挑健康度最高 / 最低)
  const sortedByHealth = [...valid].sort((a, b) => (b.health || 0) - (a.health || 0));
  if (sortedByHealth.length >= 2) {
    const top = sortedByHealth[0];
    const bot = sortedByHealth[sortedByHealth.length - 1];
    if (top.health - bot.health >= 30) {
      lines.push(`💡 ${top.label} 最強(健康 ${top.health}),${bot.label} 最弱(健康 ${bot.health})`);
    }
  }

  return { headline, lines };
}

// ============================================================================
// 摘要文字
// ============================================================================
function _buildSummaryLines(result) {
  const lines = [];

  // 1. 趨勢
  if (result.trend?.summary) {
    lines.push(`📊 ${result.trend.summary}`);
  }

  // 2. 量價訊號(只挑一句最關鍵的)
  if (result.volumePrice && !result.volumePrice.empty) {
    const vp = result.volumePrice;
    const sigText = {
      'bullish':       '量價齊揚 ✓',
      'mild-bullish':  '量縮價跌,跌勢趨緩',
      'warning':       '價漲量縮,動能不足 ⚠',
      'bearish':       '價跌量增,賣壓沉重 ✗',
      'neutral':       '量價平淡',
    }[vp.signal] || '';
    if (sigText) lines.push(`💪 ${sigText}`);
    if (vp.surge) lines.push('💥 出現爆量');
  }

  // 3. 支撐 / 壓力(只挑最近的一條)
  const r1 = result.resistance?.items?.[0];
  const s1 = result.support?.items?.[0];
  if (r1 && s1) {
    lines.push(`🎯 支撐 $${s1.price} / 壓力 $${r1.price}`);
  } else if (r1) {
    lines.push(`🔴 壓力 $${r1.price}(+${r1.distance}%)`);
  } else if (s1) {
    lines.push(`🟢 支撐 $${s1.price}(-${s1.distance}%)`);
  }

  // 4. 箱型(若該週期有)
  if (result.box && !result.box.skipped && result.box.isBox) {
    const pos = {
      'near_upper': '靠近箱型上緣',
      'near_lower': '靠近箱型下緣',
      'middle':     '位於箱型中段',
    }[result.box.position] || '';
    if (pos) lines.push(`📦 ${pos} $${result.box.lower}~$${result.box.upper}`);
  }

  return lines.slice(0, 4);  // 摘要卡最多 4 行
}

// ============================================================================
// UI 渲染(Phase 7.4 — Ab 並排 + Bc 多列可同時展開)
// ============================================================================
function _renderUI(data) {
  if (!_containerEl) return;
  const { periodReports, resonance, dengSummary, code } = data;

  const html = `
    <div class="mp-header">
      <div class="mp-header-title">📊 多週期共振</div>
      <div class="mp-header-sub">${code} · ${periodReports.length} 個週期已分析</div>
    </div>

    <!-- ↓↓↓ 上方雙欄:燈燈總結(左)+ 共振矩陣(右),手機自動堆疊 -->
    <div class="mp-top-grid">
      <!-- 燈燈總結卡 -->
      <div class="mp-deng-card">
        <div class="mp-deng-head">
          <span class="mp-deng-emoji">🐱</span>
          <span class="mp-deng-name">燈燈總結</span>
          <button class="mp-copy-btn" title="複製總結" data-mp-copy>📋 複製</button>
        </div>
        <div class="mp-deng-headline">${_escape(dengSummary.headline)}</div>
        <div class="mp-deng-body">
          ${dengSummary.lines.map(l => `<div class="mp-deng-line">${_escape(l)}</div>`).join('')}
        </div>
        <div class="mp-deng-foot">燈燈僅供參考,虧錢別怪我喵 ~</div>
      </div>

      <!-- 共振矩陣卡 -->
      <div class="mp-matrix-card">
        <div class="mp-matrix-title">共振矩陣</div>
        <div class="mp-matrix-table">
          ${periodReports.map(r => _renderMatrixRow(r)).join('')}
        </div>
        <div class="mp-matrix-bias mp-bias-${_biasClass(resonance.bias)}">
          <span class="mp-bias-label">共振:${resonance.label}</span>
          ${resonance.avgHealth ? `<span class="mp-matrix-avg">平均健康 ${resonance.avgHealth}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- ↓↓↓ 各週期細節表格(多列可同時展開) -->
    <div class="mp-detail-section">
      <div class="mp-detail-title">
        各週期細節
        <span class="mp-detail-hint">點任一列展開 · 可同時展開多列</span>
      </div>
      <div class="mp-detail-table">
        ${periodReports.map(r => _renderDetailRow(r)).join('')}
      </div>
    </div>
  `;
  _containerEl.innerHTML = html;

  // 綁定:複製總結
  _containerEl.querySelector('[data-mp-copy]')?.addEventListener('click', () => {
    _copyDengSummary(data);
  });

  // 綁定:每列標題列點擊 → toggle 展開
  _containerEl.querySelectorAll('[data-mp-toggle]').forEach(el => {
    el.addEventListener('click', () => {
      const period = el.dataset.mpToggle;
      const row = _containerEl.querySelector(`[data-mp-row="${period}"]`);
      if (!row) return;
      row.classList.toggle('mp-row-expanded');
    });
  });

  // 綁定:跳 K 線按鈕(stopPropagation 避免觸發外層 toggle)
  _containerEl.querySelectorAll('[data-mp-jump]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const period = btn.dataset.mpJump;
      _jumpToChartWithPeriod(period);
    });
  });

  // 綁定:矩陣每列點擊 → 跳同分頁的細節列(滑入視窗 + 展開)
  _containerEl.querySelectorAll('[data-mp-matrix-row]').forEach(el => {
    el.addEventListener('click', () => {
      const period = el.dataset.mpMatrixRow;
      const row = _containerEl.querySelector(`[data-mp-row="${period}"]`);
      if (!row) return;
      row.classList.add('mp-row-expanded');
      // 高亮一下吸引注意
      row.classList.add('mp-row-flash');
      setTimeout(() => row.classList.remove('mp-row-flash'), 1000);
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

// ─── 矩陣每列 ─────────────────────────────────────────────
function _renderMatrixRow(r) {
  if (r.empty) {
    return `
      <div class="mp-matrix-row mp-row-empty" data-mp-matrix-row="${r.period}" title="點擊看細節">
        <span class="mp-matrix-label">${r.label}</span>
        <span class="mp-matrix-arrow">—</span>
        <span class="mp-matrix-bar"></span>
        <span class="mp-matrix-health">無資料</span>
      </div>
    `;
  }
  const arrow = r.direction === 'up'   ? '▲'
             : r.direction === 'down' ? '▼'
             : '◀▶';
  const dirClass = `mp-dir-${r.direction}`;
  const pct = Math.max(0, Math.min(100, r.health));
  return `
    <div class="mp-matrix-row" data-mp-matrix-row="${r.period}" title="點擊跳到下方 ${r.label} 細節">
      <span class="mp-matrix-label">${r.label}</span>
      <span class="mp-matrix-arrow ${dirClass}">${arrow}</span>
      <span class="mp-matrix-bar">
        <span class="mp-matrix-bar-fill ${dirClass}" style="width:${pct}%"></span>
      </span>
      <span class="mp-matrix-health">${r.health}</span>
    </div>
  `;
}

// ─── 細節表格每列(可展開)───────────────────────────────
function _renderDetailRow(r) {
  if (r.empty) {
    return `
      <div class="mp-detail-row mp-detail-empty" data-mp-row="${r.period}">
        <div class="mp-detail-head" data-mp-toggle="${r.period}">
          <span class="mp-detail-chevron">▶</span>
          <span class="mp-detail-label">${r.label}</span>
          <span class="mp-detail-dir mp-dir-flat">—</span>
          <span class="mp-detail-summary">${_escape(r.reason || '無資料')}</span>
          <button class="mp-jump-btn" data-mp-jump="${r.period}" title="跳到 K 線 ${r.label}">→ K 線</button>
        </div>
        <div class="mp-detail-body">
          <div class="mp-detail-empty-text">${_escape(r.reason || '此週期無足夠資料')}</div>
        </div>
      </div>
    `;
  }
  const dirClass = `mp-dir-${r.direction}`;
  const dirText = r.direction === 'up'   ? '偏多'
               : r.direction === 'down' ? '偏空'
               : '盤整';
  // 標題列右側顯示一句最關鍵的摘要(取 summaryLines 第一條,通常是趨勢)
  const headSummary = r.summaryLines?.[0] || r.trendSummary || '';
  // 展開後的內容
  const detailHtml = _renderDetailBody(r);

  return `
    <div class="mp-detail-row" data-mp-row="${r.period}">
      <div class="mp-detail-head" data-mp-toggle="${r.period}">
        <span class="mp-detail-chevron">▶</span>
        <span class="mp-detail-label">${r.label}</span>
        <span class="mp-detail-dir ${dirClass}">${dirText}</span>
        <span class="mp-detail-health">健康 ${r.health}</span>
        <span class="mp-detail-summary">${_escape(headSummary)}</span>
        <button class="mp-jump-btn" data-mp-jump="${r.period}" title="跳到 K 線 ${r.label}">→ K 線</button>
      </div>
      <div class="mp-detail-body">
        ${detailHtml}
      </div>
    </div>
  `;
}

// ─── 展開後內容 ──────────────────────────────────────────
function _renderDetailBody(r) {
  const { rawResult, focus, candleCount, lastClose } = r;
  if (!rawResult) {
    return `<div class="mp-detail-empty-text">${_escape(r.reason || '無資料')}</div>`;
  }

  const { trend, support, resistance, box, volumePrice, srAdvice } = rawResult;

  const parts = [];

  // 焦點 + 基本資訊
  parts.push(`
    <div class="mp-detail-meta">
      <span class="mp-detail-meta-item">🎯 ${_escape(focus || '—')}</span>
      <span class="mp-detail-meta-item">${candleCount} 根 K 棒</span>
      <span class="mp-detail-meta-item">最新收盤 $${lastClose}</span>
    </div>
  `);

  // 趨勢區塊
  if (trend) {
    parts.push(`
      <div class="mp-detail-block">
        <div class="mp-detail-block-title">📊 趨勢結構</div>
        <div class="mp-detail-block-line">${_escape(trend.summary || '')}</div>
        ${(trend.advice || []).slice(0, 3).map(l =>
          `<div class="mp-detail-block-line mp-detail-block-advice">• ${_escape(l)}</div>`
        ).join('')}
      </div>
    `);
  }

  // 量價區塊
  if (volumePrice && !volumePrice.empty) {
    const vpText = {
      'bullish':       '量價齊揚 ✓',
      'mild-bullish':  '量縮價跌,跌勢趨緩',
      'warning':       '價漲量縮,動能不足 ⚠',
      'bearish':       '價跌量增,賣壓沉重 ✗',
      'neutral':       '量價平淡',
    }[volumePrice.signal] || volumePrice.signal || '';
    parts.push(`
      <div class="mp-detail-block">
        <div class="mp-detail-block-title">💪 量價分析</div>
        <div class="mp-detail-block-line">${_escape(vpText)}${volumePrice.surge ? '・💥 出現爆量' : ''}</div>
        ${(volumePrice.advice || []).slice(0, 2).map(l =>
          `<div class="mp-detail-block-line mp-detail-block-advice">• ${_escape(l)}</div>`
        ).join('')}
      </div>
    `);
  }

  // 支撐 / 壓力區塊
  const s1 = support?.items?.[0];
  const r1 = resistance?.items?.[0];
  if (s1 || r1) {
    const srParts = [];
    if (r1) srParts.push(`🔴 壓力 $${r1.price}(+${r1.distance}%)`);
    if (s1) srParts.push(`🟢 支撐 $${s1.price}(-${s1.distance}%)`);
    parts.push(`
      <div class="mp-detail-block">
        <div class="mp-detail-block-title">🎯 支撐 / 壓力</div>
        <div class="mp-detail-block-line">${srParts.join('  ·  ')}</div>
        ${(srAdvice || []).slice(0, 2).map(l =>
          `<div class="mp-detail-block-line mp-detail-block-advice">• ${_escape(l)}</div>`
        ).join('')}
      </div>
    `);
  }

  // 箱型(若該週期有)
  if (box && !box.skipped && box.isBox) {
    const posText = {
      'near_upper': '靠近箱型上緣',
      'near_lower': '靠近箱型下緣',
      'middle':     '位於箱型中段',
    }[box.position] || '';
    parts.push(`
      <div class="mp-detail-block">
        <div class="mp-detail-block-title">📦 箱型操作</div>
        <div class="mp-detail-block-line">${_escape(posText)} $${box.lower}~$${box.upper}</div>
        ${(box.advice || []).slice(0, 2).map(l =>
          `<div class="mp-detail-block-line mp-detail-block-advice">• ${_escape(l)}</div>`
        ).join('')}
      </div>
    `);
  }

  return parts.join('');
}

function _biasClass(bias) {
  switch (bias) {
    case 'strong-bull':           return 'bull';
    case 'strong-bear':           return 'bear';
    case 'short-bull-long-bear':  return 'mixed';
    case 'short-bear-long-bull':  return 'mixed';
    case 'mostly-flat':           return 'flat';
    case 'mixed':                 return 'mixed';
    default:                      return 'unknown';
  }
}

// ============================================================================
// 互動
// ============================================================================
function _jumpToChartWithPeriod(period) {
  // 1. 切到 K 線 Tab
  const chartTab = document.querySelector('.stock-tab[data-stock-tab="chart"]');
  if (chartTab) chartTab.click();

  // 2. 點對應週期按鈕(沿用既有的 .tb-btn[data-period])
  setTimeout(() => {
    const periodBtn = document.querySelector(`.tb-btn[data-period="${period}"]`);
    if (periodBtn && !periodBtn.classList.contains('active')) {
      periodBtn.click();
    }
  }, 60);
}

function _copyDengSummary(data) {
  const { code, dengSummary, resonance, periodReports, asOf } = data;
  const dateStr = new Date(asOf).toLocaleString('zh-TW');
  const lines = [];
  lines.push(`【多週期共振 — ${code}】`);
  lines.push('');
  lines.push(`共振狀態:${resonance.label}`);
  lines.push(`平均健康度:${resonance.avgHealth}`);
  lines.push('');
  lines.push('共振矩陣:');
  for (const r of periodReports) {
    if (r.empty) {
      lines.push(`  ${r.label}\t無資料`);
    } else {
      const arrow = r.direction === 'up' ? '多' : r.direction === 'down' ? '空' : '平';
      lines.push(`  ${r.label}\t${arrow}\t健康 ${r.health}`);
    }
  }
  lines.push('');
  lines.push(`燈燈總結:${dengSummary.headline}`);
  for (const l of dengSummary.lines) {
    lines.push(`  ${l}`);
  }
  lines.push('');
  lines.push(`— 由選股台產生 (${dateStr})`);

  const text = lines.join('\n');
  navigator.clipboard.writeText(text).then(() => {
    dengToast('燈燈已複製給你 ~ 喵', { mood: 'happy', duration: 2000 });
  }).catch(() => {
    dengToast('複製失敗,你的瀏覽器不太合作', { mood: 'sad', duration: 2500 });
  });
}

// ============================================================================
// Fetch 限流防護 — 分批抓 + retry
// ============================================================================

// ============================================================================
// Fetch — retry 防護(全域節流由 api.js fetchWithProxy 內部處理,這裡只管 retry)
// ============================================================================

const RETRY_DELAY_MS = 1200;  // 碰到 429 等 1.2 秒再試
const MAX_RETRY      = 1;     // 最多 retry 1 次(整體 2 次嘗試)

async function _fetchAllPeriodsThrottled(symbol, force = false) {
  // 全部丟出去,api.js 的全域節流器會自動排隊
  // (不在這裡分批,避免重複限流)
  return Promise.all(
    PERIODS.map(period => _fetchPeriodWithRetry(symbol, period, force))
  );
}

async function _fetchPeriodWithRetry(symbol, period, force = false) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const candles = await fetchHistoryCached(symbol, period, { force });
      return { period, candles, error: null };
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);

      // 對「臨時類」錯誤 retry — 限流、Worker 502/503/504、timeout 都算
      // 其他錯誤直接放棄(Not Found 等永久錯誤)
      const isTransient = /Too Many Requests|429|rate limit|proxy 暫時無法|HTTP 5\d\d|timeout|timed out|Failed to fetch/i.test(msg);
      if (!isTransient || attempt >= MAX_RETRY) {
        return { period, candles: [], error: msg };
      }

      // 退避:第一次等 1.2 秒,如果有第二次會等 2.4 秒
      await _sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return { period, candles: [], error: lastErr?.message || '取得失敗' };
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// 工具
// ============================================================================
function _escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// Phase 7.5 A2+B — 共振台詞精準化 + 表情對應
// ============================================================================
function _dengLineForResonance(reso) {
  const { bias, avgHealth, shortAvgHealth, longAvgHealth, ups, downs, total } = reso;

  if (bias === 'strong-bull') {
    if (avgHealth > 80) {
      return {
        text: `${ups}/${total} 週期全多,平均健康 ${avgHealth} ~ 長線可以抱,短線別追`,
        mood: 'savage',
      };
    }
    if (avgHealth > 65) {
      return {
        text: `多週期偏多(${ups}/${total}),健康度 ${avgHealth} 還不錯 ~ 等回測再進`,
        mood: 'happy',
      };
    }
    return {
      text: `雖然 ${ups}/${total} 偏多,但健康度才 ${avgHealth} — 別重押喵`,
      mood: 'curious',
    };
  }

  if (bias === 'strong-bear') {
    if (avgHealth < 30) {
      return {
        text: `${downs}/${total} 週期全空,健康度 ${avgHealth} — 燈燈勸你放生`,
        mood: 'sad',
      };
    }
    return {
      text: `多週期偏空(${downs}/${total}),健康度 ${avgHealth} — 先觀望比較穩`,
      mood: 'sad',
    };
  }

  if (bias === 'short-bear-long-bull') {
    const sh = shortAvgHealth ?? '?';
    const lo = longAvgHealth ?? '?';
    return {
      text: `長線健康 ${lo},短線轉弱 ${sh} — 等回測再加碼,別追`,
      mood: 'curious',
    };
  }

  if (bias === 'short-bull-long-bear') {
    const sh = shortAvgHealth ?? '?';
    const lo = longAvgHealth ?? '?';
    return {
      text: `短線反彈(健康 ${sh})但長線空頭(健康 ${lo}) — 別當救世主`,
      mood: 'curious',
    };
  }

  if (bias === 'mostly-flat') {
    return {
      text: `多週期都在盤整,平均健康 ${avgHealth} — 等突破再說,燈燈快睡著了`,
      mood: 'sleepy',
    };
  }

  // mixed / unknown
  return {
    text: `多空交錯(${ups}多/${downs}空),均健康 ${avgHealth} — 燈燈也看不準,謹慎`,
    mood: 'curious',
  };
}
