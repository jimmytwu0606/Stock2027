/**
 * seed-ui.js — Phase 4 種子選股 UI
 *
 * export：
 *   initSeedUI()
 */

import { AppState }            from './state.js';
import { fetchQuote, toYahooSymbol, fetchHistory, fetchFundamentals, fetchFundamentalsBatch } from './api.js';

// fund 快取（掃描完成後批次讀入）
let _srFundCache = {};
// 妖股快取
let _srYaoguMap = new Map();
import { showToast }           from './ui.js';
import {
  extractSeedFeatures, mergeTemplates, defaultWeights,
  describeTemplate, templateDivergenceWarning,
} from './seed.js';
import { runSeedScan, abortSeedScan } from './seed-scan.js';
import { getGroups, addStockToGroup, getDefaultGroupId } from './watchlist.js';
import { getAllSeedSets, saveSeedSet, deleteSeedSet, getAllSignalsCache } from './db.js';
import { getChineseName } from './api.js';
import { calcHealth, calcHealthFast, calcHealthLong, healthBadge, healthBadgeDual } from './health.js';
import { scanOneCode } from './signal-scan.js';

// 排序狀態
let _srSortKey = 'compositeScore';
let _srSortAsc = false;

// ─── 初始化 ───────────────────────────────────────────────
export async function initSeedUI() {
  _bindSeedInput();
  _bindFromWatchlist();
  _bindAnalyzeBtn();
  _bindWeightSliders();
  _bindScanConfig();
  _bindScanBtn();
  _bindSavedSets();
  _bindSeedListHeader();
  await _renderSavedSets();

  // 切換到種子 Tab 時更新選股結果計數
  document.querySelectorAll('.main-tab[data-tab="seed"], .tab-item[data-mobile-tab="seed"]')
    .forEach(btn => btn.addEventListener('click', _updateScreenerCount));
}

function _bindSeedListHeader() {
  // header 現在由 _renderResults 動態產生在 table thead，此函式保留為空
}

// ─── 種子輸入 ─────────────────────────────────────────────
function _bindSeedInput() {
  const input   = document.getElementById('seedInput');
  const addBtn  = document.getElementById('seedAddBtn');
  if (!input) return;

  async function addSeed() {
    const code = input.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return;

    // 防止重複
    if ((AppState.seed.seedCodes ?? []).includes(code)) {
      showToast('此代號已在種子清單中');
      input.value = '';
      return;
    }
    if ((AppState.seed.seedCodes ?? []).length >= 10) {
      showToast('最多 10 檔種子股');
      return;
    }

    input.disabled = true;
    try {
      const symbol = toYahooSymbol(code);
      const quote  = await fetchQuote(symbol);
      AppState.seed.seedCodes = [...(AppState.seed.seedCodes ?? []), code];
      const chName = getChineseName(code);
      _renderSeedChips(chName ?? quote.name ?? code);
      input.value = '';
    } catch {
      showToast(`⚠ 找不到代號：${code}`);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  input.addEventListener('keydown', e => { if (e.key === 'Enter') addSeed(); });
  addBtn?.addEventListener('click', addSeed);
}

function _renderSeedChips() {
  const container = document.getElementById('seedChips');
  if (!container) return;
  const codes = AppState.seed.seedCodes ?? [];

  // 重新建立 chip 列表（保留已驗證名稱）
  const existing = new Map(
    [...container.querySelectorAll('.seed-chip')].map(el => [el.dataset.code, el.querySelector('.chip-name')?.textContent ?? ''])
  );

  container.innerHTML = '';
  for (const code of codes) {
    const name = existing.get(code) ?? code;
    const chip = document.createElement('span');
    chip.className       = 'seed-chip';
    chip.dataset.code    = code;
    chip.innerHTML = `
      <span class="chip-code">${code}</span>
      <span class="chip-name">${name}</span>
      <button class="chip-remove" data-code="${code}" title="移除">×</button>
    `;
    container.appendChild(chip);
  }

  // 移除按鈕
  container.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const code = e.target.dataset.code;
      AppState.seed.seedCodes = (AppState.seed.seedCodes ?? []).filter(c => c !== code);
      _renderSeedChips();
      _resetTemplate();
    });
  });

  // 更新分析按鈕狀態
  const analyzeBtn = document.getElementById('seedAnalyzeBtn');
  if (analyzeBtn) analyzeBtn.disabled = codes.length < 2;
}

// ─── 從自選群組帶入 ───────────────────────────────────────
function _bindFromWatchlist() {
  const btn      = document.getElementById('seedFromWatchlist');
  const dropdown = document.getElementById('seedGroupDropdown');
  if (!btn || !dropdown) return;

  // 點擊按鈕 → 顯示/隱藏群組選單
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display === 'block';
    if (isOpen) { dropdown.style.display = 'none'; return; }

    const groups = getGroups();
    const validGroups = groups.filter(g => (g.stocks ?? []).length > 0);
    if (validGroups.length === 0) { showToast('自選清單為空'); return; }

    dropdown.innerHTML = '';
    for (const g of validGroups) {
      const item = document.createElement('div');
      item.className = 'seed-group-item';
      item.innerHTML = `
        <span class="sgi-name">${g.name ?? '自選清單'}</span>
        <span class="sgi-count">${g.stocks.length} 檔</span>
      `;
      item.addEventListener('click', () => {
        _importFromGroup(g);
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(item);
    }

    dropdown.style.display = 'block';
  });

  // 點擊外部關閉
  document.addEventListener('click', () => { dropdown.style.display = 'none'; });
}

function _importFromGroup(group) {
  const stocks = (group.stocks ?? []).slice(0, 10);
  if (stocks.length === 0) { showToast('此群組沒有股票'); return; }

  AppState.seed.seedCodes = stocks.map(s => s.code);

  const container = document.getElementById('seedChips');
  if (container) {
    container.innerHTML = '';
    for (const s of stocks) {
      const chip = document.createElement('span');
      chip.className    = 'seed-chip';
      chip.dataset.code = s.code;
      chip.innerHTML = `
        <span class="chip-code">${s.code}</span>
        <span class="chip-name">${s.name ?? s.code}</span>
        <button class="chip-remove" data-code="${s.code}" title="移除">×</button>
      `;
      container.appendChild(chip);
    }
    container.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        const code = e.currentTarget.dataset.code;
        AppState.seed.seedCodes = (AppState.seed.seedCodes ?? []).filter(c => c !== code);
        _renderSeedChips();
        _resetTemplate();
      });
    });
  }

  const analyzeBtn = document.getElementById('seedAnalyzeBtn');
  if (analyzeBtn) analyzeBtn.disabled = stocks.length < 2;
  _resetTemplate();
  showToast(`✓ 已從「${group.name ?? '自選清單'}」帶入 ${stocks.length} 檔`);
}

// ─── 分析種子（建立模板） ──────────────────────────────────
function _bindAnalyzeBtn() {
  document.getElementById('seedAnalyzeBtn')?.addEventListener('click', _analyzeSeeds);
}

async function _analyzeSeeds() {
  const codes = AppState.seed.seedCodes ?? [];
  if (codes.length < 2) { showToast('請輸入至少 2 檔種子股'); return; }

  const analyzeBtn = document.getElementById('seedAnalyzeBtn');
  if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.textContent = '分析中…'; }

  const windowSize = AppState.seed.windowSize ?? 20;
  const features   = [];

  for (const code of codes) {
    try {
      const symbol       = toYahooSymbol(code);
      const [candles, fundamentals] = await Promise.all([
        fetchHistory(symbol, '6mo'),
        fetchFundamentals(symbol, code).catch(() => ({})),
      ]);
      const f = extractSeedFeatures(candles, { ...fundamentals, code }, windowSize);
      if (f) features.push(f);
    } catch (e) {
      console.warn(`[seed-ui] failed to fetch ${code}:`, e);
    }
  }

  if (features.length < 2) {
    showToast('⚠ 無法取得足夠資料，請確認代號是否正確');
    if (analyzeBtn) { analyzeBtn.disabled = false; analyzeBtn.textContent = '分析種子'; }
    return;
  }

  const template = mergeTemplates(features);
  AppState.seed.features = features;
  AppState.seed.template = template;

  _renderTemplatePreview(template);

  if (analyzeBtn) { analyzeBtn.disabled = false; analyzeBtn.textContent = '重新分析'; }
  document.getElementById('seedScanBtn')?.removeAttribute('disabled');
  showToast(`✓ 已分析 ${features.length} 檔種子股，模板建立完成`);
}

// ─── 模板預覽 ─────────────────────────────────────────────
function _renderTemplatePreview(template) {
  const section = document.getElementById('seedTemplatePreview');
  if (!section) return;
  section.style.display = 'block';

  // Canvas 折線圖
  const canvas = document.getElementById('seedPreviewCanvas');
  if (canvas) _drawTemplateCanvas(canvas, template);

  // 產業徽章
  const badge = document.getElementById('seedSectorBadge');
  if (badge) {
    badge.textContent = template.topSector
      ? `${template.topSector}${template.topIndustry ? ' › ' + template.topIndustry : ''}`
      : '無產業資料';
    badge.style.opacity = template.topSector ? '1' : '0.4';
  }

  // 指標輪廓
  const profile = document.getElementById('seedIndicatorProfile');
  if (profile) {
    const { indProfile: p } = template;
    const macdTxt  = p.macdSign > 0 ? '↑ 多方' : p.macdSign < 0 ? '↓ 空方' : '→ 中性';
    const maTxt    = p.maAbove20 ? '> MA20 偏多' : '< MA20 偏空';
    profile.innerHTML = `
      <div class="ip-row"><span class="ip-label">RSI</span>
        <span class="ip-val">${p.rsi.median.toFixed(0)}
          <span class="ip-range">（${p.rsi.q1.toFixed(0)}–${p.rsi.q3.toFixed(0)}）</span>
        </span>
      </div>
      <div class="ip-row"><span class="ip-label">KD-K</span>
        <span class="ip-val">${p.kdK.median.toFixed(0)}
          <span class="ip-range">（${p.kdK.q1.toFixed(0)}–${p.kdK.q3.toFixed(0)}）</span>
        </span>
      </div>
      <div class="ip-row"><span class="ip-label">MACD</span>
        <span class="ip-val">${macdTxt}</span>
      </div>
      <div class="ip-row"><span class="ip-label">均線</span>
        <span class="ip-val">${maTxt}</span>
      </div>
    `;
  }

  // 分歧度警示
  const warning = templateDivergenceWarning(template);
  const warnEl  = document.getElementById('seedDivergenceWarning');
  if (warnEl) {
    warnEl.textContent    = warning ?? '';
    warnEl.style.display  = warning ? 'block' : 'none';
  }
}

function _drawTemplateCanvas(canvas, template) {
  const ctx = canvas.getContext('2d');
  const w   = canvas.offsetWidth || 240;
  const h   = canvas.height;
  canvas.width = w;
  ctx.clearRect(0, 0, w, h);

  const series = template.patternSeries;
  const std    = template.patternStd;
  const n      = series.length;
  if (n < 2) return;

  const pad = 8;
  const xs  = i => pad + (i / (n - 1)) * (w - pad * 2);
  const ys  = v => pad + (1 - v) * (h - pad * 2);

  // 標準差範圍填色
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xs(i);
    const y = ys(Math.min(1, series[i] + std[i]));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    ctx.lineTo(xs(i), ys(Math.max(0, series[i] - std[i])));
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(59,130,246,0.12)';
  ctx.fill();

  // 主折線
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xs(i), y = ys(series[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

function _resetTemplate() {
  AppState.seed.template  = null;
  AppState.seed.features  = [];
  const section = document.getElementById('seedTemplatePreview');
  if (section) section.style.display = 'none';
  document.getElementById('seedScanBtn')?.setAttribute('disabled', 'true');
}

// ─── 評分權重滑桿 ─────────────────────────────────────────
function _bindWeightSliders() {
  const ids    = ['seedWeightSector', 'seedWeightPattern', 'seedWeightIndicator'];
  const keys   = ['sector', 'pattern', 'indicator'];
  const sliders = ids.map(id => document.getElementById(id));
  if (!sliders[0]) return;

  function updateLabels() {
    const w = AppState.seed.weights ?? defaultWeights();
    sliders.forEach((sl, i) => {
      if (sl) {
        sl.value = Math.round(w[keys[i]] * 100);
        const label = document.getElementById(ids[i] + 'Label');
        if (label) label.textContent = sl.value + '%';
      }
    });
  }

  sliders.forEach((sl, changed) => {
    if (!sl) return;
    sl.addEventListener('input', () => {
      const newVal = parseInt(sl.value) / 100;
      const w = { ...AppState.seed.weights };
      const oldVal = w[keys[changed]];
      const delta  = newVal - oldVal;
      w[keys[changed]] = newVal;

      // 其他兩項等比縮放補足差額
      const otherIdxs = [0, 1, 2].filter(i => i !== changed);
      const otherSum  = otherIdxs.reduce((s, i) => s + w[keys[i]], 0);
      if (otherSum > 0) {
        for (const i of otherIdxs) {
          w[keys[i]] = Math.max(0.05, w[keys[i]] - delta * (w[keys[i]] / otherSum));
        }
      }

      // 正規化使總和 = 1
      const total = w.sector + w.pattern + w.indicator;
      w.sector    /= total;
      w.pattern   /= total;
      w.indicator /= total;
      AppState.seed.weights = w;
      updateLabels();
    });
  });

  updateLabels();
}

// ─── 掃描範圍設定 ─────────────────────────────────────────
function _bindScanConfig() {
  const fromScreenerCb = document.getElementById('seedFromScreener');
  if (fromScreenerCb) {
    fromScreenerCb.addEventListener('change', _updateScreenerCount);
  }
}

function _updateScreenerCount() {
  const el = document.getElementById('seedScreenerCount');
  if (!el) return;
  const n = AppState.screener.results?.length ?? 0;
  el.textContent = n > 0 ? `（${n} 檔）` : '';
}

// ─── 掃描 ────────────────────────────────────────────────
function _bindScanBtn() {
  document.getElementById('seedScanBtn')?.addEventListener('click', _startScan);
  document.getElementById('seedAbortBtn')?.addEventListener('click', () => {
    abortSeedScan();
    document.getElementById('seedAbortBtn').style.display = 'none';
  });
}

async function _startScan() {
  const template = AppState.seed.template;
  if (!template) { showToast('請先點擊「分析種子」建立模板'); return; }

  const opts = {
    weights:            AppState.seed.weights ?? defaultWeights(),
    priceMin:           parseFloat(document.getElementById('seedPriceMin')?.value) || 0,
    priceMax:           parseFloat(document.getElementById('seedPriceMax')?.value) || 99999,
    volumeMin:          parseFloat(document.getElementById('seedVolumeMin')?.value) || 0,
    useScreenerResults: document.getElementById('seedFromScreener')?.checked ?? false,
    windowSize:         AppState.seed.windowSize ?? 20,
    threshold:          AppState.seed.threshold  ?? 60,
  };

  // 重置結果
  AppState.seed.scanResults = [];
  _renderResults([]);

  const progressWrap = document.getElementById('seedProgress');
  const progressBar  = document.getElementById('seedProgressBar');
  const progressText = document.getElementById('seedProgressText');
  const scanBtn      = document.getElementById('seedScanBtn');
  const abortBtn     = document.getElementById('seedAbortBtn');
  const summary      = document.getElementById('seedSummary');

  if (progressWrap) progressWrap.style.display = 'block';
  if (summary)      summary.style.display = 'none';
  if (scanBtn)      scanBtn.disabled = true;
  if (abortBtn)     abortBtn.style.display = '';

  let found = 0, scanned = 0;
  const startTime = Date.now();

  for await (const ev of runSeedScan(template, opts)) {
    switch (ev.type) {
      case 'progress':
        scanned = ev.done;
        if (progressBar && ev.total > 0) {
          progressBar.style.width = (ev.done / ev.total * 100).toFixed(1) + '%';
        }
        if (progressText) {
          progressText.textContent = ev.rateLimited
            ? `rate limit，等待中… (${ev.done}/${ev.total})`
            : ev.message || `掃描中 ${ev.done}/${ev.total}`;
        }
        break;

      case 'result':
        found++;
        if (found % 10 === 0 || found <= 5) {
          _renderResults(AppState.seed.scanResults);
        }
        break;

      case 'done':
      case 'aborted':
        if (progressWrap) progressWrap.style.display = 'none';
        if (scanBtn)      scanBtn.disabled = false;
        if (abortBtn)     abortBtn.style.display = 'none';
        _renderResults(AppState.seed.scanResults);
        if (summary) {
          summary.style.display = '';
          summary.textContent   = `掃描完成：${found} 檔符合，共掃描 ${scanned} 檔，耗時 ${((Date.now() - startTime) / 1000).toFixed(0)}s`;
        }
        if (AppState.seed.scanResults?.length > 0) {
          const codes = AppState.seed.scanResults.map(r => r.code);
          fetchFundamentalsBatch(codes).then(fundMap => {
            fundMap.forEach((f, code) => { _srFundCache[code] = f ?? null; });
            _renderResults(AppState.seed.scanResults);
          }).catch(() => {});
          _scanYaoguForSeedResults(AppState.seed.scanResults);
        }
        _maybeSavePattern();
        break;

      case 'error':
        showToast('⚠ ' + ev.message);
        if (scanBtn) scanBtn.disabled = false;
        if (abortBtn) abortBtn.style.display = 'none';
        break;
    }
  }
}

// ─── 妖股掃描（背景執行）────────────────────────────────────
async function _scanYaoguForSeedResults(results) {
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let xCount = 0;
  let allCache = [];
  try { allCache = await getAllSignalsCache(); } catch(e) {}

  for (const item of results) {
    try {
      const cached  = allCache.find(r => r.code === item.code);
      const isFresh = cached && (now - (cached.scannedAt ?? 0)) < THREE_DAYS;
      let sigs = [];
      if (isFresh) {
        sigs = cached.signals ?? [];
      } else {
        sigs = await Promise.race([
          scanOneCode(item.code, { silent: true }),
          new Promise(res => setTimeout(() => res([]), 5000)),
        ]);
      }
      const x1 = sigs.some(s => s.id === 'X1');
      const x2 = sigs.some(s => s.id === 'X2');
      const x5 = sigs.some(s => s.id === 'X5');
      if (x1 || x2 || x5) {
        _srYaoguMap.set(item.code, { x1, x2, x5, strongest: x2?'X2':x1?'X1':'X5' });
        xCount++;
      }
    } catch(e) {
      console.warn(`[seed-ui] 妖股掃描失敗 ${item.code}:`, e.message);
    }
  }
  if (xCount > 0) {
    _renderResults(results);
    _showSeedYaoguAlert(xCount);
  }
}

function _showSeedYaoguAlert(count) {
  if (document.getElementById('srYaoguAlert')) return;
  const alert = document.createElement('div');
  alert.id = 'srYaoguAlert';
  alert.className = 'sr-yaogu-alert';
  alert.innerHTML = `
    <span>🚀</span>
    <span>篩選結果中有 <strong>${count}</strong> 檔出現妖股訊號（X1/X2/X5）</span>
    <button class="sr-yaogu-alert-close" id="srYaoguAlertClose">✕</button>
  `;
  const summary = document.getElementById('seedSummary');
  summary?.insertAdjacentElement('afterend', alert);
  document.getElementById('srYaoguAlertClose')?.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), 8000);
}

// ─── 結果列表 ─────────────────────────────────────────────
function _renderResults(items) {
  const list = document.getElementById('seedResultList');
  if (!list) return;

  if (!items || items.length === 0) {
    list.innerHTML = '<div class="seed-result-empty">尚無結果</div>';
    _srYaoguMap = new Map();
    return;
  }

  // 排序
  const sorted = [...items].sort((a, b) => {
    let av, bv;
    if (_srSortKey === 'hs') {
      const _s = c => c?.length > 65 ? c.slice(-65) : c;
      av = calcHealth(_s(a.miniCandles)) ?? -1;
      bv = calcHealth(_s(b.miniCandles)) ?? -1;
    } else if (_srSortKey === 'hl') {
      av = calcHealthLong(a.miniCandles, _srFundCache[a.code] ?? null) ?? -1;
      bv = calcHealthLong(b.miniCandles, _srFundCache[b.code] ?? null) ?? -1;
    } else if (_srSortKey === 'chg') {
      av = a.chgPct ?? 0; bv = b.chgPct ?? 0;
    } else if (_srSortKey === 'price') {
      av = a.price ?? 0; bv = b.price ?? 0;
    } else {
      av = a[_srSortKey] ?? 0; bv = b[_srSortKey] ?? 0;
    }
    return _srSortAsc ? av - bv : bv - av;
  });

  // table 結構：代號 / 股名 / 現價 / 漲跌 / 短線健康 / 長線健康 / 妖股 / 走勢 / ＋
  const cols = [
    { key: 'code',  label: '代號' },
    { key: 'name',  label: '股名' },
    { key: 'price', label: '現價' },
    { key: 'chg',   label: '漲跌幅' },
    { key: 'hs',    label: '短線健康' },
    { key: 'hl',    label: '長線健康' },
    { key: 'yaogu', label: '妖股', noSort: true },
    { key: 'chart', label: '走勢',  noSort: true },
    { key: 'add',   label: '',      noSort: true },
  ];

  let thead = '<tr>';
  cols.forEach(col => {
    if (col.noSort) {
      thead += `<th class="sr-tbl-th no-sort">${col.label}</th>`;
      return;
    }
    const isSorted = _srSortKey === col.key;
    const arrow = isSorted ? (_srSortAsc ? ' ▲' : ' ▼') : '';
    thead += `<th class="sr-tbl-th${isSorted ? ' sorted' : ''}" data-col="${col.key}">${col.label}${arrow}</th>`;
  });
  thead += '</tr>';

  let tbody = '';
  for (const item of sorted) {
    const _candlesShort = item.miniCandles?.length > 65 ? item.miniCandles.slice(-65) : item.miniCandles;
    const hs = _candlesShort?.length >= 20 ? calcHealth(_candlesShort) : null;
    const hl = item.miniCandles?.length >= 120 ? calcHealthLong(item.miniCandles, _srFundCache[item.code] ?? null) : null;
    const yg = _srYaoguMap.get(item.code);
    const chgCls = item.chgPct >= 0 ? 'up' : 'down';
    const chgStr = (item.chgPct >= 0 ? '+' : '') + item.chgPct.toFixed(2) + '%';

    tbody += `<tr class="sr-tbl-row" data-code="${item.code}">
      <td class="sr-tbl-td"><span class="sr-tbl-code">${item.code}</span></td>
      <td class="sr-tbl-td"><span class="sr-tbl-name">${item.name}</span></td>
      <td class="sr-tbl-td"><span class="sr-tbl-price">${item.price.toFixed(item.price >= 100 ? 0 : 1)}</span></td>
      <td class="sr-tbl-td"><span class="sr-tbl-chg ${chgCls}">${chgStr}</span></td>
      <td class="sr-tbl-td">${healthBadge(hs, 'hg')}</td>
      <td class="sr-tbl-td">${healthBadge(hl, 'hg')}</td>
      <td class="sr-tbl-td">${yg ? `<span class="sr-yaogu-pill sr-yaogu-pill--${yg.strongest.toLowerCase()}">${yg.strongest}</span>` : ''}</td>
      <td class="sr-tbl-td"><canvas class="sr-mini-chart" height="36" data-code="${item.code}"></canvas></td>
      <td class="sr-tbl-td">
        <div class="sr-add-wrap">
          <button class="sr-add-btn" data-code="${item.code}" title="加入自選群組">＋</button>
          <div class="sr-add-dropdown" style="display:none"></div>
        </div>
      </td>
    </tr>`;
  }

  const wrap = document.createElement('div');
  wrap.className = 'sr-tbl-wrap';
  wrap.innerHTML = `<table class="sr-tbl"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  list.innerHTML = '';
  list.appendChild(wrap);

  // 排序 header
  wrap.querySelectorAll('.sr-tbl-th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_srSortKey === col) _srSortAsc = !_srSortAsc;
      else { _srSortKey = col; _srSortAsc = false; }
      _renderResults(AppState.seed.scanResults);
    });
  });

  // 點列 → 跳看盤
  wrap.querySelectorAll('.sr-tbl-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sr-add-btn') || e.target.closest('.sr-add-dropdown')) return;
      const code = row.dataset.code;
      document.dispatchEvent(new CustomEvent('stockSelect', { detail: { code } }));
      document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
      document.querySelector('.main-tab[data-tab="chart"]')?.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tabChart')?.classList.add('active');
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.tab-item[data-mobile-tab="chart"]')?.classList.add('active');
    });
  });

  // ＋ 加入自選群組
  wrap.querySelectorAll('.sr-add-btn').forEach(btn => {
    const code = btn.dataset.code;
    const item = sorted.find(i => i.code === code);
    const addDrop = btn.nextElementSibling;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (addDrop.style.display === 'block') { addDrop.style.display = 'none'; return; }
      const groups = getGroups();
      addDrop.innerHTML = '';
      for (const g of groups) {
        const gi = document.createElement('div');
        gi.className = 'sr-add-group-item';
        gi.textContent = g.name ?? '自選清單';
        gi.addEventListener('click', async (e2) => {
          e2.stopPropagation();
          addDrop.style.display = 'none';
          await addStockToGroup(
            { code: item.code, name: item.name, price: item.price, chg: null, chgPct: item.chgPct },
            g.id
          );
        });
        addDrop.appendChild(gi);
      }
      addDrop.style.display = 'block';
    });
    document.addEventListener('click', () => { addDrop.style.display = 'none'; }, { once: true });
  });

  // 迷你 K 線圖
  wrap.querySelectorAll('.sr-mini-chart').forEach(canvas => {
    const code = canvas.dataset.code;
    const item = sorted.find(i => i.code === code);
    if (item?.miniCandles?.length) {
      requestAnimationFrame(() => _drawMiniChart(canvas, item.miniCandles));
    }
  });
}

function _drawMiniChart(canvas, candles) {
  const w   = canvas.offsetWidth || 60;
  const h   = canvas.height;
  canvas.width = w;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const closes = candles.map(c => c.close);
  const min    = Math.min(...closes);
  const max    = Math.max(...closes);
  const range  = max - min || 1;
  const n      = closes.length;

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h - ((closes[i] - min) / range) * h * 0.85 - h * 0.075;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  const lastUp = closes[closes.length - 1] >= closes[0];
  ctx.strokeStyle = lastUp ? '#ef5350' : '#26a69a';
  ctx.lineWidth   = 1.2;
  ctx.stroke();
}

// ─── 範本儲存提示 ─────────────────────────────────────────
function _maybeSavePattern() {
  // 掃描完成後，提示儲存種子組合
  const saveArea = document.getElementById('seedSaveArea');
  if (saveArea) saveArea.style.display = 'block';
}

// ─── 儲存 / 載入種子組合（改走 db.js，雲端自動同步）────────
function _bindSavedSets() {
  document.getElementById('seedSaveBtn')?.addEventListener('click', async () => {
    const name  = document.getElementById('seedSaveName')?.value.trim();
    const codes = AppState.seed.seedCodes ?? [];
    if (!name)            { showToast('請輸入組合名稱'); return; }
    if (codes.length < 2) { showToast('請先輸入至少 2 檔種子股'); return; }

    try {
      const sets = await getAllSeedSets();
      if (sets.length >= 10) { showToast('最多儲存 10 組'); return; }

      await saveSeedSet({
        id:      `seed_${Date.now()}`,
        name,
        codes,
        weights: AppState.seed.weights ?? defaultWeights(),
        savedAt: Date.now(),
      });

      await _renderSavedSets();
      const nameInput = document.getElementById('seedSaveName');
      if (nameInput) nameInput.value = '';
      showToast(`✓ 已儲存「${name}」`);
    } catch (e) {
      showToast('⚠ 儲存失敗：' + e.message);
    }
  });
}

async function _renderSavedSets() {
  const container = document.getElementById('seedSavedSets');
  if (!container) return;

  let sets = [];
  try { sets = await getAllSeedSets(); } catch { sets = []; }

  if (sets.length === 0) {
    container.innerHTML = '<div class="seed-saved-empty">尚無儲存的組合</div>';
    return;
  }

  // 依儲存時間排序（新的在前）
  sets.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));

  container.innerHTML = '';
  for (const s of sets) {
    const row = document.createElement('div');
    row.className = 'seed-saved-row';
    row.innerHTML = `
      <span class="ss-name">${s.name}</span>
      <span class="ss-codes">${(s.codes ?? []).join(', ')}</span>
      <button class="ss-load" data-id="${s.id}">載入</button>
      <button class="ss-del"  data-id="${s.id}">✕</button>
    `;
    container.appendChild(row);
  }

  container.querySelectorAll('.ss-load').forEach(btn => {
    btn.addEventListener('click', async e => {
      const allSets = await getAllSeedSets();
      const set = allSets.find(s => s.id === e.target.dataset.id);
      if (!set) return;
      AppState.seed.seedCodes = set.codes;
      if (set.weights) AppState.seed.weights = set.weights;
      _renderSeedChips();
      _resetTemplate();
      showToast(`✓ 已載入「${set.name}」，請點擊「分析種子」建立模板`);
    });
  });

  container.querySelectorAll('.ss-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      await deleteSeedSet(e.target.dataset.id);
      await _renderSavedSets();
    });
  });
}
