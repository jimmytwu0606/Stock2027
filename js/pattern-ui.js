/**
 * pattern-ui.js — Phase 3 型態辨識 UI 協調
 * 職責：
 *   - 監聽 patternScanStart 事件，啟動掃描並渲染進度
 *   - 渲染相似度結果列表（含迷你 K 線圖）
 *   - 渲染歷史回測面板
 *   - 結果點擊 → 派發 stockSelect 事件
 * 依賴：pattern-scan.js、backtest.js、state.js
 */

import { runPatternScan, abortScan } from './pattern-scan.js';
import { runBacktest, calcReturnDistribution } from './backtest.js';
import { AppState } from './state.js';
import { normalizeSeries } from './pattern.js';
import { getChineseName, fetchFundamentalsBatch } from './api.js';
import { openStockPreview } from './stock-preview.js';
import { addStockToGroup, getDefaultGroupId } from './watchlist.js';
import { initPatternImageUI } from './pattern-image-ui.js';
import { getAllSignalsCache } from './db.js';
import { listAll, createList, watchAddCode } from './portfolio.js';
import { scanOneCode } from './signal-scan.js';

// fund 快取
let _prFundCache = {};
// 妖股快取（掃描結果存這裡，重繪時用）
let _prYaoguMap = new Map();
import { calcHealth, calcHealthLong, renderHealthBadge, shortHealthScore } from './health.js';

// 排序狀態
let _prSortKey = 'score';
let _prSortAsc = false;
let _sortHeaderBound = false;  // 排序 header listener 只綁一次的 guard
let _prResults = [];
// health cache：掃描時預算，排序時直接讀
let _prHealthCache = new Map();  // code → { hs, hl }

// ─── 初始化 ────────────────────────────────────────────────
export function initPatternUI() {
  _buildResultPanel();
  _bindModal();
  _listenScanStart();
  _listenAbort();
  _initImageMode();
  _bindSearchAndWatch();
}

// ─── Modal 開關 ────────────────────────────────────────────
function _bindModal() {
  document.getElementById('pdOpenConfig')?.addEventListener('click', _openModal);
  document.getElementById('pdModalClose')?.addEventListener('click', _closeModal);
  document.getElementById('pdModalBg')?.addEventListener('click', e => {
    if (e.target.id === 'pdModalBg') _closeModal();
  });
  // Modal 內「▶ 開始掃描」
  document.getElementById('pdModalStart')?.addEventListener('click', () => {
    _closeModal();
    _triggerScan();
  });
  // toolbar「▶ 開始掃描」
  document.getElementById('pdScanBtn')?.addEventListener('click', _triggerScan);
  // 收到範本就緒通知 → 更新 chip
  document.addEventListener('patternTemplateReady', _updateTbChip);
  // 相似度滑桿
  document.getElementById('pdSimilarity')?.addEventListener('input', e => {
    const v = document.getElementById('pdSimilarityVal');
    if (v) v.textContent = e.target.value + '%';
  });
}

function _openModal() {
  const bg = document.getElementById('pdModalBg');
  if (bg) bg.style.display = 'flex';
  // 同步 canvas 寬度（modal 開啟後才有寬度）
  requestAnimationFrame(() => {
    const canvas = document.getElementById('pdCanvas');
    const wrap   = document.getElementById('pdDrawWrap');
    if (canvas && wrap) canvas.width = (wrap.clientWidth - 28) || 560;
  });
}

function _closeModal() {
  const bg = document.getElementById('pdModalBg');
  if (bg) bg.style.display = 'none';
  _updateTbChip();
}

function _updateTbChip() {
  const chips = document.getElementById('pdTbChips');
  if (!chips) return;
  const tpl = AppState.pattern?.template;
  if (!tpl?.length) {
    chips.innerHTML = '<span style="color:var(--muted);font-size:12px">未設定型態</span>';
    return;
  }
  const sim  = document.getElementById('pdSimilarity')?.value ?? 75;
  const win  = document.getElementById('pdWindow')?.value ?? 20;
  chips.innerHTML = `
    <span class="seed-chip">型態 ${tpl.length}根</span>
    <span class="seed-chip">相似度 ${sim}%</span>
    <span class="seed-chip">視窗 ${win}根</span>
  `;
  // 有範本才開放掃描
  const btn = document.getElementById('pdScanBtn');
  const mstart = document.getElementById('pdModalStart');
  if (btn) btn.disabled = false;
  if (mstart) mstart.disabled = false;
}

function _triggerScan() {
  const template = AppState.pattern?.template;
  if (!template?.length) { _openModal(); return; }
  AppState.pattern.similarity  = parseInt(document.getElementById('pdSimilarity')?.value  ?? 75);
  AppState.pattern.windowSize  = parseInt(document.getElementById('pdWindow')?.value      ?? 20);
  AppState.pattern.featureMode = document.getElementById('pdFeatureMode')?.value ?? 'simple';
  document.dispatchEvent(new CustomEvent('patternScanStart', { detail: { template } }));
}

// ─── 圖片模式初始化 ────────────────────────────────────────
function _initImageMode() {
  const container = document.getElementById('pdImageWrap');
  if (!container) return;

  initPatternImageUI(container, {
    onResult(normalizedPrices) {
      if (!normalizedPrices?.length) return;
      // 同步掃描參數
      AppState.pattern = AppState.pattern || {};
      AppState.pattern.similarity  = parseInt(document.getElementById('pdSimilarity')?.value || 75);
      AppState.pattern.windowSize  = parseInt(document.getElementById('pdWindow')?.value || 20);
      AppState.pattern.featureMode = document.getElementById('pdFeatureMode')?.value || 'simple';
      // 派發掃描事件，走既有流程
      document.dispatchEvent(new CustomEvent('patternScanStart', {
        detail: { template: normalizedPrices }
      }));
    }
  });
}


// ─── 結果面板 HTML 骨架 ────────────────────────────────────
function _buildResultPanel() {
  const panel = document.getElementById('patternResultPanel');
  if (!panel) return;

  panel.innerHTML = `
    <!-- 進度區 -->
    <div class="pr-progress" id="prProgress" style="display:none">
      <div class="pr-progress-bar-wrap">
        <div class="pr-progress-bar" id="prProgressBar"></div>
      </div>
      <div class="pr-progress-meta">
        <span id="prProgressText">準備中…</span>
        <button class="pr-abort-btn" id="prAbortBtn">停止</button>
      </div>
    </div>

    <!-- 彙總 -->
    <div class="pr-summary" id="prSummary" style="display:none">
      <div class="pr-summary-stat" id="prSumFound"></div>
      <div class="pr-summary-stat" id="prSumWinRate"></div>
      <div class="pr-summary-stat" id="prSumAvgRet"></div>
    </div>

    <!-- 回測面板 -->
    <div class="pr-backtest" id="prBacktest" style="display:none">
      <div class="pr-backtest-header">
        <span class="pr-backtest-title">歷史回測</span>
        <label class="pr-hold-label">
          持有
          <select id="prHoldDays">
            <option value="3">3日</option>
            <option value="5" selected>5日</option>
            <option value="10">10日</option>
            <option value="20">20日</option>
          </select>
        </label>
      </div>
      <div class="pr-backtest-stats" id="prBacktestStats"></div>
      <div class="pr-dist-chart" id="prDistChart"></div>
    </div>

    <!-- 結果列表 -->
    <div id="prListHeader" style="display:none">
      <table class="pr-tbl">
        <thead>
          <tr>
            <th class="pr-th">代號</th>
            <th class="pr-th">名稱</th>
            <th class="pr-th pr-sort-col active" data-sort="score">相似度 ↓</th>
            <th class="pr-th">現價</th>
            <th class="pr-th">漲跌幅</th>
            <th class="pr-th pr-sort-col" data-sort="hs">短線健康</th>
            <th class="pr-th pr-sort-col" data-sort="hl">長線健康</th>
            <th class="pr-th">妖股</th>
            <th class="pr-th">走勢</th>
            <th class="pr-th"></th>
          </tr>
        </thead>
        <tbody id="prList"></tbody>
      </table>
    </div>

    <!-- 空狀態 -->
    <div class="pr-empty" id="prEmpty" style="display:none">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
        <circle cx="18" cy="18" r="12" stroke="var(--muted)" stroke-width="1.5"/>
        <path d="M27 27l7 7" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M13 18h10M18 13v10" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <p>未找到相似型態</p>
      <p class="pr-empty-hint">試著降低相似度門檻</p>
    </div>
  `;
}

// ─── 監聽掃描開始事件 ──────────────────────────────────────
function _listenScanStart() {
  document.addEventListener('patternScanStart', async e => {
    const { template } = e.detail;
    if (!template?.length) return;

    _resetUI();
    _showProgress(true);
    // 掃描開始前預填妖股 map（async，不阻塞主流程）
    (async () => {
      let allCache = [];
      try { allCache = await getAllSignalsCache(); } catch(_) {}
      allCache.forEach(row => {
        const sigs = row.signals ?? [];
        const x1 = sigs.some(s => s.id === 'X1');
        const x2 = sigs.some(s => s.id === 'X2');
        const x5 = sigs.some(s => s.id === 'X5');
        const x6 = sigs.some(s => s.id === 'X6');
        if (x1||x2||x5||x6) _prYaoguMap.set(row.code, { x1, x2, x5, x6, strongest: x2?'X2':x1?'X1':x6?'X6':'X5' });
      });
    })();

    // 讀取篩選條件
    const priceMin  = parseFloat(document.getElementById('pdPriceMin')?.value  || 0)   || 0;
    const priceMax  = parseFloat(document.getElementById('pdPriceMax')?.value  || 0)   || 99999;
    const volumeMin = parseFloat(document.getElementById('pdVolumeMin')?.value || 0)   || 0;
    const fromScreener = document.getElementById('pdFromScreener')?.checked || false;

    const opts = {
      similarity:   AppState.pattern.similarity,
      windowSize:   AppState.pattern.windowSize,
      featureMode:  AppState.pattern.featureMode || 'simple',
      priceMin,
      priceMax,
      volumeMin,
      fromScreener,
    };

    const results = [];

    try {
      for await (const event of runPatternScan(template, opts)) {
        if (event.type === 'progress') {
          _updateProgress(event.done, event.total, event.message);
        } else if (event.type === 'result') {
          results.push(event.item);
          _renderResult(event.item, results.length);
        } else if (event.type === 'done') {
          _onScanDone(results, template);
          break;
        } else if (event.type === 'aborted') {
          _onScanDone(results, template, true);
          break;
        } else if (event.type === 'error') {
          _showError(event.message);
          break;
        }
      }
    } catch (err) {
      _showError(err.message);
    }
  });
}

function _listenAbort() {
  document.addEventListener('click', e => {
    if (!e.target.closest('#prAbortBtn')) return;
    abortScan();
  });
}

// ─── 進度條 ────────────────────────────────────────────────
function _showProgress(show) {
  const bar  = document.getElementById('prProgressBar');
  const text = document.getElementById('prProgressText');
  if (bar)  { bar.style.width = '0%'; bar.closest('.seed-progress')?.style && (bar.closest('.seed-progress').style.display = show ? '' : 'none'); }
  if (text) text.style.display = show ? '' : 'none';
  // toolbar 掃描中切換按鈕
  const scanBtn  = document.getElementById('pdScanBtn');
  const abortBtn = document.getElementById('prAbortBtn');
  if (scanBtn)  scanBtn.style.display  = show ? 'none' : '';
  if (abortBtn) abortBtn.style.display = show ? '' : 'none';
}

function _updateProgress(done, total, message) {
  const bar  = document.getElementById('prProgressBar');
  const text = document.getElementById('prProgressText');
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bar)  bar.style.width  = pct + '%';
  if (text) text.textContent = message + (total > 0 ? ` (${done}/${total})` : '');
  // toolbar summary
  const sum = document.getElementById('prSummaryText');
  if (sum && done > 0) sum.textContent = `找到 ${_prResults.length} 檔`;
}

// ─── 結果渲染 ──────────────────────────────────────────────
function _resetUI() {
  _prResults = [];
  _prSortKey = 'score';
  _prSortAsc = false;
  _prFundCache = {};
  _prYaoguMap = new Map();
  _prHealthCache = new Map();
  _prSearchQuery = '';
  const searchEl  = document.getElementById('prSearchInput');
  const watchBtnEl = document.getElementById('prAddWatchBtn');
  if (searchEl)   { searchEl.value = ''; searchEl.style.display = 'none'; }
  if (watchBtnEl) watchBtnEl.style.display = 'none';
  document.getElementById('prList')?.replaceChildren();
  ['prSummary','prBacktest','prListHeader','prEmpty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function _renderResult(item, rank) {
  // 加入時預算 health，存 cache，排序時不重算
  const allCandles   = item.fullCandles ?? item.candles;
  const candlesShort = allCandles?.length > 65 ? allCandles.slice(-65) : allCandles;
  _prHealthCache.set(item.code, {
    hs: shortHealthScore({ code: item.code, candles: candlesShort }),
    hl: allCandles?.length >= 120 ? calcHealthLong(allCandles, _prFundCache[item.code] ?? null) : null,
  });

  _prResults.push(item);
  if (rank === 1) {
    const header = document.getElementById('prListHeader');
    if (header) header.style.display = '';
    _renderAllResults();
  } else if (rank % 10 === 0) {
    _renderAllResults();
  }
}

function _renderAllResults() {
  const list = document.getElementById('prList');
  if (!list) return;

  // 排序（tbody）
  const sorted = [..._prResults].sort((a, b) => {
    let av, bv;
    if (_prSortKey === 'hs') {
      av = (_prHealthCache.get(a.code)?.hs) ?? -1;
      bv = (_prHealthCache.get(b.code)?.hs) ?? -1;
    } else if (_prSortKey === 'hl') {
      av = (_prHealthCache.get(a.code)?.hl) ?? -1;
      bv = (_prHealthCache.get(b.code)?.hl) ?? -1;
    } else if (_prSortKey === 'code') {
      return _prSortAsc
        ? (a.code ?? '').localeCompare(b.code ?? '')
        : (b.code ?? '').localeCompare(a.code ?? '');
    } else if (_prSortKey === 'yaogu') {
      const ygScore = code => {
        const yg = _prYaoguMap.get(code);
        if (!yg) return 0;
        return yg.x2 ? 4 : yg.x1 ? 3 : yg.x6 ? 2 : yg.x5 ? 1 : 0;
      };
      av = ygScore(a.code);
      bv = ygScore(b.code);
    } else {
      av = a[_prSortKey] ?? 0;
      bv = b[_prSortKey] ?? 0;
    }
    return _prSortAsc ? av - bv : bv - av;
  });

  // 搜尋過濾
  const displayed = _prSearchQuery
    ? sorted.filter(item =>
        item.code.toLowerCase().includes(_prSearchQuery) ||
        (item.name ?? '').toLowerCase().includes(_prSearchQuery)
      )
    : sorted;

  list.innerHTML = '';
  for (const item of displayed) {
    const row = document.createElement('tr');
    row.className = 'pr-row';
    row.dataset.code = item.code;

    const scoreColor = item.score >= 90 ? 'var(--down)' :
                       item.score >= 75 ? 'var(--accent)' : 'var(--muted)';

    // 健康度從 cache 讀取（_renderResult 時已預算）
    const cached = _prHealthCache.get(item.code) ?? {};
    const healthShort = cached.hs ?? null;
    const healthLong  = cached.hl ?? null;

    // 妖股 pill（複用 th-yaogu-pill 樣式，支援多標籤）
    const yg = _prYaoguMap.get(item.code);
    const ygHtml = `<div class="pr-yaogu-cell">${
      yg ? ['X2','X1','X6','X5'].filter(id => yg[id.toLowerCase()])
               .map(id => `<span class="th-yaogu-pill th-yaogu-pill--${id.toLowerCase()}">${id}</span>`)
               .join('') : ''
    }</div>`;

    const priceVal = isFinite(item.price) ? item.price : 0;
    const chgCls   = (item.chgPct ?? 0) >= 0 ? 'up' : 'down';
    const chgStr   = ((item.chgPct ?? 0) >= 0 ? '+' : '') + (item.chgPct ?? 0).toFixed(2) + '%';
    row.innerHTML = `
      <td class="pr-td"><span class="pr-row-code">${item.code}</span></td>
      <td class="pr-td"><span class="pr-row-name">${item.name || '–'}</span></td>
      <td class="pr-td pr-td-score" style="color:${scoreColor}">${item.score.toFixed(1)}%</td>
      <td class="pr-td"><span class="pr-row-price">${priceVal > 0 ? priceVal.toFixed(priceVal >= 100 ? 0 : 1) : '—'}</span></td>
      <td class="pr-td"><span class="pr-row-chg ${chgCls}">${chgStr}</span></td>
      <td class="pr-td">${renderHealthBadge(healthShort, null, { compact: true })}</td>
      <td class="pr-td">${renderHealthBadge(healthLong, null, { compact: true })}</td>
      <td class="pr-td">${yg ? ['X2','X1','X6','X5'].filter(id=>yg[id.toLowerCase()]).map(id=>'<span class="th-yaogu-pill th-yaogu-pill--'+id.toLowerCase()+'">'+id+'</span>').join('') : ''}</td>
      <td class="pr-td"><canvas class="pr-mini-chart" width="100" height="36" data-code="${item.code}"></canvas></td>
      <td class="pr-td">
        <div class="sr-add-wrap">
          <button class="sr-add-btn" data-code="${item.code}" title="加入自選群組">＋</button>
          <div class="sr-add-dropdown" style="display:none"></div>
        </div>
      </td>
    `;

    list.appendChild(row);

    // Canvas 在 row 附加到 DOM 後才有尺寸，用 requestAnimationFrame 畫
    const canvas = row.querySelector('.pr-mini-chart');
    if (canvas && item.candles?.length) {
      requestAnimationFrame(() => _drawMiniChart(canvas, item.candles, item.startIdx, item.endIdx, item.fullCandles));
    }

    row.addEventListener('click', () => {
      // 點列 → 個股速覽 modal；進入個股頁後才派發 patternHighlight（高亮比對區間）
      openStockPreview(item.code, {
        _afterEnter: () => document.dispatchEvent(new CustomEvent('patternHighlight', {
          detail: { code: item.code, startIdx: item.startIdx, endIdx: item.endIdx }
        })),
      });
    });
  }

  // 排序 header 點擊（只綁一次，避免每次 _renderAllResults 疊加 listener
  //   → 重複觸發 toggle，偶數次等於沒變 → 升降冪「壞掉」）
  if (!_sortHeaderBound) {
    _sortHeaderBound = true;
    document.getElementById('prListHeader')?.querySelectorAll('.pr-sort-col').forEach(col => {
      col.addEventListener('click', () => {
        const key = col.dataset.sort;
        if (_prSortKey === key) _prSortAsc = !_prSortAsc;
        else { _prSortKey = key; _prSortAsc = false; }
        document.getElementById('prListHeader')?.querySelectorAll('.pr-sort-col').forEach(c => {
          const isActive = c.dataset.sort === _prSortKey;
          c.classList.toggle('active', isActive);
          const label = c.dataset.sort === 'score' ? '相似度' : c.dataset.sort === 'hs' ? '短線健康' : '長線健康';
          c.textContent = isActive ? `${label} ${_prSortAsc ? '↑' : '↓'}` : label;
        });
        _renderAllResults();
      });
    });
  }
}

function _drawMiniChart(canvas, candles, startIdx, endIdx, fullCandles = null) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const closes = candles.map(c => c.close);
  const norm   = normalizeSeries(closes);
  const n      = norm.length;

  // 底色
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, w, h);

  // 高亮比對區間（匹配的型態段，貼齊右端）：填色 + 左邊界虛線
  if (startIdx != null && endIdx != null && n > 1) {
    const x1 = (startIdx / (n - 1)) * w;
    const x2 = (endIdx   / (n - 1)) * w;
    // 填色
    ctx.fillStyle = 'rgba(59,130,246,0.22)';
    ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
    // 左邊界虛線（分隔 context 與匹配段）
    ctx.strokeStyle = 'rgba(59,130,246,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const xAt = i => (n > 1 ? (i / (n - 1)) * (w - 2) + 1 : w / 2);
  const yAt = v => h - 2 - v * (h - 4);

  // ── MA20 均線（疊在最底層，與題材小卡同風格的灰線）──
  //   用 fullCandles 算才有前 19 根暖機資料；正規化沿用 closes 的 min/max，
  //   超出可視範圍的值 clamp 在邊緣。
  if (fullCandles && fullCandles.length >= 20 && n > 1) {
    const all    = fullCandles.map(c => c.close);
    const offset = all.length - n;          // drawCandles 在 fullCandles 的起點
    const min    = Math.min(...closes);
    const max    = Math.max(...closes);
    const range  = (max - min) || 1;

    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.lineWidth   = 1;
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    let started = false;
    let sum = 0;
    // 先累積 offset 之前的視窗
    const firstIdx = Math.max(0, offset - 19);
    for (let g = firstIdx; g < offset && g < all.length; g++) sum += all[g];
    for (let i = 0; i < n; i++) {
      const g = offset + i;                 // fullCandles 全域索引
      sum += all[g];
      if (g >= 20) sum -= all[g - 20];
      if (g < 19) continue;                 // 不足 20 根，無 MA 值
      const ma = sum / 20;
      const v  = Math.max(0, Math.min(1, (ma - min) / range));
      const x = xAt(i), y = yAt(v);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }

  // 前置 context 段（匹配段之前）先畫淡灰線
  if (startIdx != null && startIdx > 0) {
    ctx.strokeStyle = 'rgba(148,163,184,0.7)';
    ctx.lineWidth = 1.2;
    ctx.lineJoin  = 'round';
    ctx.beginPath();
    for (let i = 0; i <= startIdx; i++) {
      const x = xAt(i), y = yAt(norm[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 匹配段（最新 tLen 根，貼右端）：實藍粗線
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.6;
  ctx.lineJoin  = 'round';
  ctx.beginPath();
  const matchStart = (startIdx != null && startIdx >= 0) ? startIdx : 0;
  for (let i = matchStart; i < n; i++) {
    const x = xAt(i), y = yAt(norm[i]);
    i === matchStart ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ─── 掃描完成 ──────────────────────────────────────────────
function _onScanDone(results, template, aborted = false) {
  _showProgress(false);

  if (!results.length) {
    const empty = document.getElementById('prEmpty');
    if (empty) empty.style.display = '';
    return;
  }

  // toolbar summary
  const sumText = document.getElementById('prSummaryText');
  if (sumText) sumText.textContent = `找到 ${results.length} 檔`;

  // 顯示列表 header
  const header = document.getElementById('prListHeader');
  if (header) header.style.display = '';

  // 批次讀 fund → 只更新 cache，不重繪（避免蓋掉妖股標籤）
  const codes = results.map(r => r.code);
  fetchFundamentalsBatch(codes).then(fundMap => {
    fundMap.forEach((f, code) => { _prFundCache[code] = f ?? null; });
    // 不在此重繪，由 _scanYaoguForResults 統一負責最終渲染
  }).catch(() => {});

  // 回測
  _renderBacktest(results, template);

  // 顯示搜尋欄 + 加入追蹤清單 btn
  const searchEl  = document.getElementById('prSearchInput');
  const watchBtnEl = document.getElementById('prAddWatchBtn');
  if (searchEl)   searchEl.style.display   = '';
  if (watchBtnEl) watchBtnEl.style.display = '';

  // 妖股掃描（全撈 cache，不串行打 API）
  _scanYaoguForResults(results);
}

// 妖股掃描（全撈 cache，對齊 theme-ui 做法）
async function _scanYaoguForResults(results) {
  let xCount = 0;
  const codeSet = new Set(results.map(r => r.code));
  let allCache = [];
  try { allCache = await getAllSignalsCache(); } catch(e) {}

  allCache.forEach(row => {
    if (!codeSet.has(row.code)) return;
    const sigs = row.signals ?? [];
    const x1 = sigs.some(s => s.id === 'X1');
    const x2 = sigs.some(s => s.id === 'X2');
    const x5 = sigs.some(s => s.id === 'X5');
    const x6 = sigs.some(s => s.id === 'X6');
    if (x1||x2||x5||x6) {
      _prYaoguMap.set(row.code, { x1, x2, x5, x6, strongest: x2?'X2':x1?'X1':x6?'X6':'X5' });
      xCount++;
    }
  });

  // 無論有無妖股都重繪（修正 fundamentals 覆蓋問題）
  _renderAllResults();
  if (xCount > 0) _showYaoguAlert(xCount);
}

// ─── 搜尋 + 加入追蹤清單 ──────────────────────────────────
let _prSearchQuery = '';

function _bindSearchAndWatch() {
  // 搜尋：即時過濾
  document.getElementById('prSearchInput')?.addEventListener('input', e => {
    _prSearchQuery = e.target.value.trim().toLowerCase();
    _renderAllResults();
  });

  // 加入追蹤清單
  document.getElementById('prAddWatchBtn')?.addEventListener('click', async () => {
    if (!_prResults.length) return;

    // 取得所有追蹤清單
    const watchLists = listAll('watch');

    // 建立選項 HTML：現有清單 + 新增選項
    const opts = watchLists.map(l =>
      `<option value="${l.id}">${l.name}（${l.items.length} 檔）</option>`
    ).join('');

    // 用 pfPromptModal 借用框架，但這裡需要 select
    // 改用 window.prompt fallback 或自建簡易 modal
    // 用最簡單的 confirm + prompt 組合
    let listId;
    if (!watchLists.length) {
      const name = await _prPrompt('尚無追蹤清單，請輸入新清單名稱：', '型態比對結果');
      if (!name) return;
      const newList = await createList('watch', name);
      listId = newList.id;
    } else {
      // 建一個簡易選擇 modal
      listId = await _prPickWatchList(watchLists);
      if (!listId) return;
      if (listId === '__new__') {
        const name = await _prPrompt('輸入新追蹤清單名稱：', '型態比對結果');
        if (!name) return;
        const newList = await createList('watch', name);
        listId = newList.id;
      }
    }

    // 批次加入
    let added = 0, skipped = 0;
    for (const item of _prResults) {
      const result = await watchAddCode(listId, item.code, item.name, item.price ?? 0, '型態比對');
      if (result) added++; else skipped++;
    }

    const listName = listAll('watch').find(l => l.id === listId)?.name ?? '';
    _showToastPr(`✓ 已加入「${listName}」${added} 檔${skipped ? `（${skipped} 檔已存在）` : ''}`);
  });
}

// 借用 pfPromptModal 顯示文字輸入
function _prPrompt(message, defaultVal = '') {
  const modal = document.getElementById('pfPromptModal');
  if (!modal) return Promise.resolve(prompt(message, defaultVal));
  return new Promise(resolve => {
    document.getElementById('pfPromptMessage').textContent = message;
    const input = document.getElementById('pfPromptInput');
    input.value = defaultVal;
    modal.classList.add('open');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const close = val => {
      modal.classList.remove('open');
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBg);
      resolve(val);
    };
    const btnOk     = document.getElementById('pfPromptConfirm');
    const btnCancel = document.getElementById('pfPromptCancel');
    const onOk      = () => close(input.value.trim() || null);
    const onCancel  = () => close(null);
    const onKey     = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    const onBg      = e => { if (e.target === modal) onCancel(); };
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBg);
  });
}

// 選追蹤清單（下拉選單 modal）
function _prPickWatchList(lists) {
  return new Promise(resolve => {
    // 動態建一個小 modal
    const bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center';
    bg.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px 24px;min-width:280px;max-width:360px">
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:14px">選擇追蹤清單</div>
        <select id="_prListPickSel" style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 8px;font-size:13px;margin-bottom:14px">
          ${lists.map(l => `<option value="${l.id}">${l.name}（${l.items.length} 檔）</option>`).join('')}
          <option value="__new__">＋ 新增清單…</option>
        </select>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="_prListPickCancel" style="padding:5px 14px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--muted);font-size:12px;cursor:pointer">取消</button>
          <button id="_prListPickOk" style="padding:5px 14px;border-radius:6px;border:none;background:var(--accent);color:#fff;font-size:12px;cursor:pointer">確定</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    const close = val => { bg.remove(); resolve(val); };
    bg.querySelector('#_prListPickOk').addEventListener('click', () =>
      close(bg.querySelector('#_prListPickSel').value));
    bg.querySelector('#_prListPickCancel').addEventListener('click', () => close(null));
    bg.addEventListener('click', e => { if (e.target === bg) close(null); });
  });
}

function _showToastPr(msg) {
  document.dispatchEvent(new CustomEvent('showToast', { detail: msg }));
}

// 妖股確認視窗
function _showYaoguAlert(count) {
  // 已存在就不重複
  if (document.getElementById('prYaoguAlert')) return;

  const alert = document.createElement('div');
  alert.id = 'prYaoguAlert';
  alert.className = 'pr-yaogu-alert';
  alert.innerHTML = `
    <span class="pr-yaogu-alert-icon">🚀</span>
    <span class="pr-yaogu-alert-text">篩選結果中有 <strong>${count}</strong> 檔出現妖股訊號（X1/X2/X5/X6）</span>
    <button class="pr-yaogu-alert-close" id="prYaoguAlertClose">✕</button>
  `;

  // 插在 prSummary 後面
  const sum = document.getElementById('prSummary');
  sum?.insertAdjacentElement('afterend', alert);

  document.getElementById('prYaoguAlertClose')?.addEventListener('click', () => alert.remove());

  // 5 秒後自動消失
  setTimeout(() => alert.remove(), 8000);
}

// ─── 回測面板 ──────────────────────────────────────────────
function _renderBacktest(results, template) {
  const panel = document.getElementById('prBacktest');
  if (!panel) return;
  panel.style.display = '';

  const holdSelect = document.getElementById('prHoldDays');
  const _run = () => {
    const holdDays = parseInt(holdSelect?.value || 5);

    const stockList = results
      .filter(r => r.fullCandles?.length >= template.length + holdDays)
      .map(r => ({ code: r.code, candles: r.fullCandles }));

    if (!stockList.length) {
      document.getElementById('prBacktestStats').innerHTML =
        '<span style="color:var(--muted)">K線資料不足，無法回測</span>';
      return;
    }

    // 彙總回測（簡化版：只用各股最近一次命中）
    const indivResults = stockList.map(({ code, candles }) => {
      const bt = runBacktest(template, candles, { holdDays, minScore: AppState.pattern.similarity });
      return { code, ...bt };
    }).filter(r => r.totalHits > 0);

    if (!indivResults.length) {
      document.getElementById('prBacktestStats').innerHTML =
        '<span style="color:var(--muted)">歷史命中次數不足</span>';
      return;
    }

    const allHits  = indivResults.flatMap(r => r.hits);
    const wins     = allHits.filter(h => h.win).length;
    const rets     = allHits.map(h => h.returnPct);
    const winRate  = Math.round((wins / allHits.length) * 1000) / 10;
    const avgRet   = rets.reduce((a, b) => a + b, 0) / rets.length;
    const maxGain  = Math.max(...rets);
    const maxLoss  = Math.min(...rets);

    document.getElementById('prBacktestStats').innerHTML = `
      <div class="pr-bt-stat">
        <div class="pr-bt-val ${winRate >= 50 ? 'up' : 'down'}">${winRate}%</div>
        <div class="pr-bt-label">勝率</div>
      </div>
      <div class="pr-bt-stat">
        <div class="pr-bt-val ${avgRet >= 0 ? 'up' : 'down'}">${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(2)}%</div>
        <div class="pr-bt-label">平均報酬</div>
      </div>
      <div class="pr-bt-stat">
        <div class="pr-bt-val up">+${maxGain.toFixed(2)}%</div>
        <div class="pr-bt-label">最大獲利</div>
      </div>
      <div class="pr-bt-stat">
        <div class="pr-bt-val down">${maxLoss.toFixed(2)}%</div>
        <div class="pr-bt-label">最大虧損</div>
      </div>
      <div class="pr-bt-stat">
        <div class="pr-bt-val">${allHits.length}</div>
        <div class="pr-bt-label">樣本次數</div>
      </div>
    `;

    // 報酬分布長條圖
    const dist = calcReturnDistribution(allHits);
    _renderDistChart(dist);
  };

  _run();
  holdSelect?.addEventListener('change', _run);
}

function _renderDistChart(dist) {
  const container = document.getElementById('prDistChart');
  if (!container || !dist.length) return;

  const maxCount = Math.max(...dist.map(d => d.count), 1);

  container.innerHTML = `
    <div class="pr-dist-title">報酬分布（${dist.reduce((a, b) => a + b.count, 0)} 次）</div>
    <div class="pr-dist-bars">
      ${dist.map(d => `
        <div class="pr-dist-bar-wrap" title="${d.label}: ${d.count}次">
          <div class="pr-dist-bar ${d.isPositive ? 'up' : 'down'}"
               style="height:${Math.round((d.count / maxCount) * 60)}px"></div>
          <div class="pr-dist-bar-label">${d.label}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── 錯誤顯示 ──────────────────────────────────────────────
function _showError(msg) {
  _showProgress(false);
  const list = document.getElementById('prList');
  if (list) {
    list.innerHTML = `<div class="pr-error">掃描失敗：${msg}</div>`;
  }
}
