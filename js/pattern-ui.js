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

// fund 快取
let _prFundCache = {};
import { calcHealth, calcHealthLong, healthBadgeDual } from './health.js';

// 排序狀態
let _prSortKey = 'score';
let _prSortAsc = false;
let _prResults = [];

// ─── 初始化 ────────────────────────────────────────────────
export function initPatternUI() {
  _buildResultPanel();
  _listenScanStart();
  _listenAbort();
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
    <div class="pr-list-header" id="prListHeader" style="display:none">
      <span>代號 / 名稱</span>
      <span class="pr-sort-col active" data-sort="score">相似度 ↓</span>
      <span class="pr-sort-col" data-sort="health">健康度</span>
      <span>型態預覽</span>
    </div>
    <div class="pr-list" id="prList"></div>

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
  const el = document.getElementById('prProgress');
  if (el) el.style.display = show ? '' : 'none';
}

function _updateProgress(done, total, message) {
  const bar  = document.getElementById('prProgressBar');
  const text = document.getElementById('prProgressText');
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bar)  bar.style.width  = pct + '%';
  if (text) text.textContent = message + (total > 0 ? ` (${done}/${total})` : '');
}

// ─── 結果渲染 ──────────────────────────────────────────────
function _resetUI() {
  _prResults = [];
  _prSortKey = 'score';
  _prSortAsc = false;
  document.getElementById('prList')?.replaceChildren();
  ['prSummary','prBacktest','prListHeader','prEmpty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function _renderResult(item, rank) {
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

  // 排序
  const sorted = [..._prResults].sort((a, b) => {
    let av, bv;
    if (_prSortKey === 'health') {
      // 短線固定取最後 65 根（≈3mo）統一基底
      const _s = c => c?.length > 65 ? c.slice(-65) : c;
      av = calcHealth(_s(a.candles)) ?? -1;
      bv = calcHealth(_s(b.candles)) ?? -1;
    } else {
      av = a[_prSortKey] ?? 0;
      bv = b[_prSortKey] ?? 0;
    }
    return _prSortAsc ? av - bv : bv - av;
  });

  list.innerHTML = '';
  for (const item of sorted) {
    const row = document.createElement('div');
    row.className = 'pr-row';
    row.dataset.code = item.code;

    const scoreColor = item.score >= 90 ? 'var(--down)' :
                       item.score >= 75 ? 'var(--accent)' : 'var(--muted)';
    // 短線固定取最後 65 根（≈3mo），長線用完整 candles
    const candlesShort = item.candles?.length > 65 ? item.candles.slice(-65) : item.candles;
    const healthShort = calcHealth(candlesShort);
    const healthLong  = item.candles?.length >= 120 ? calcHealthLong(item.candles, _prFundCache[item.code] ?? null) : null;

    row.innerHTML = `
      <div class="pr-row-info">
        <span class="pr-row-code">${item.code}</span>
        <span class="pr-row-name">${item.name || '–'}</span>
      </div>
      <div class="pr-row-score" style="color:${scoreColor}">
        ${item.score.toFixed(1)}%
      </div>
      <div class="pr-row-health">${healthBadgeDual(healthShort, healthLong, 'pr')}</div>
      <canvas class="pr-mini-chart" width="120" height="40" data-code="${item.code}"></canvas>
    `;

    list.appendChild(row);

    const canvas = row.querySelector('.pr-mini-chart');
    if (canvas && item.candles?.length) {
      _drawMiniChart(canvas, item.candles, item.startIdx, item.endIdx);
    }

    row.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('stockSelect', { detail: { code: item.code } }));
      document.dispatchEvent(new CustomEvent('patternHighlight', {
        detail: { code: item.code, startIdx: item.startIdx, endIdx: item.endIdx }
      }));
    });
  }

  // 排序 header 點擊（每次重繪後重新綁定）
  const header = document.getElementById('prListHeader');
  header?.querySelectorAll('.pr-sort-col').forEach(col => {
    col.addEventListener('click', () => {
      const key = col.dataset.sort;
      if (_prSortKey === key) _prSortAsc = !_prSortAsc;
      else { _prSortKey = key; _prSortAsc = false; }
      // 更新 header 箭頭
      header.querySelectorAll('.pr-sort-col').forEach(c => {
        const isActive = c.dataset.sort === _prSortKey;
        c.classList.toggle('active', isActive);
        const label = c.dataset.sort === 'score' ? '相似度' : '健康度';
        c.textContent = isActive ? `${label} ${_prSortAsc ? '↑' : '↓'}` : label;
      });
      _renderAllResults();
    });
  });
}

function _drawMiniChart(canvas, candles, startIdx, endIdx) {
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

  // 高亮比對區間
  if (startIdx != null && endIdx != null && n > 0) {
    const x1 = (startIdx / (n - 1)) * w;
    const x2 = (endIdx   / (n - 1)) * w;
    ctx.fillStyle = 'rgba(59,130,246,0.15)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // 折線
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.lineJoin  = 'round';
  ctx.beginPath();
  norm.forEach((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * (w - 2) + 1 : w / 2;
    const y = h - 2 - v * (h - 4);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
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

  // 彙總列
  const sum = document.getElementById('prSummary');
  if (sum) {
    sum.style.display = '';
    document.getElementById('prSumFound').textContent = `找到 ${results.length} 檔`;
  }

  // 批次讀 fund → 長線健康度吃基本面，讀完重繪
  const codes = results.map(r => r.code);
  fetchFundamentalsBatch(codes).then(fundMap => {
    fundMap.forEach((f, code) => { _prFundCache[code] = f ?? null; });
    _renderAllResults();
  }).catch(() => {});

  // 回測
  _renderBacktest(results, template);
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
