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
import { runSeedScan, abortSeedScan, runSingleSeedScan } from './seed-scan.js';
import { getGroups, addStockToGroup, getDefaultGroupId } from './watchlist.js';
import { getAllSeedSets, saveSeedSet, deleteSeedSet, getAllSignalsCache } from './db.js';
import { getChineseName } from './api.js';
import { openStockPreview } from './stock-preview.js';
import { calcHealth, calcHealthFast, calcHealthLong, renderHealthBadge, shortHealthScore } from './health.js';
import { scanOneCode } from './signal-scan.js';

// 排序狀態
let _srSortKey = 'compositeScore';
let _srSortAsc = false;

// ─── 初始化 ───────────────────────────────────────────────
export async function initSeedUI() {
  _bindModeToggle();
  _bindModalOpenClose();
  _bindSeedInput();
  _bindFromWatchlist();
  _bindAnalyzeBtn();
  _bindWeightSliders();
  _bindScanConfig();
  _bindScanBtn();
  _bindSingleScan();
  _bindSavedSets();
  _bindSeedListHeader();
  await _renderSavedSets();

  document.querySelectorAll('.main-tab[data-tab="seed"], .tab-item[data-mobile-tab="seed"]')
    .forEach(btn => btn.addEventListener('click', _updateScreenerCount));

  window.__triggerSingleSeed = triggerSingleSeedFromStock;
  document.getElementById('shFindSimilar')?.addEventListener('click', () => {
    const code = (window.__stockDashCode ?? '').toString().replace(/\.[A-Z]+$/, '');
    if (!code) { showToast('請先開啟個股'); return; }
    triggerSingleSeedFromStock(code);
  });
}

// ─── Modal 開關 ───────────────────────────────────────────
function _bindModalOpenClose() {
  document.getElementById('seedOpenConfig')?.addEventListener('click', _openModal);
  document.getElementById('seedModalClose')?.addEventListener('click', _closeModal);
  document.getElementById('seedModalBg')?.addEventListener('click', e => {
    if (e.target.id === 'seedModalBg') _closeModal();
  });
  // Modal 內「▶ 開始掃描」按鈕 → 關 Modal + 觸發掃描
  document.getElementById('seedModalStart')?.addEventListener('click', () => {
    _closeModal();
    if (_seedMode === 'single') _startSingleScan();
    else _startScan();
  });
  // 儲存 Modal
  document.getElementById('seedTbSaveBtn')?.addEventListener('click', () => {
    const bg = document.getElementById('seedSaveModalBg');
    if (bg) bg.style.display = 'flex';
  });
  document.getElementById('seedSaveModalClose')?.addEventListener('click', () => {
    document.getElementById('seedSaveModalBg').style.display = 'none';
  });
  document.getElementById('seedSaveModalBg')?.addEventListener('click', e => {
    if (e.target.id === 'seedSaveModalBg')
      document.getElementById('seedSaveModalBg').style.display = 'none';
  });
}

function _openModal() {
  const bg = document.getElementById('seedModalBg');
  if (bg) bg.style.display = 'flex';
  // 同步 modal 內撥盤 active 狀態
  const toggle = document.getElementById('seedModeToggle');
  toggle?.querySelectorAll('.seed-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === _seedMode)
  );
  // 同步內容區顯示
  const multiArea  = document.getElementById('seedMultiArea');
  const singleArea = document.getElementById('seedSingleArea');
  if (multiArea)  multiArea.style.display  = _seedMode === 'multi'  ? '' : 'none';
  if (singleArea) singleArea.style.display = _seedMode === 'single' ? '' : 'none';
}

function _closeModal() {
  const bg = document.getElementById('seedModalBg');
  if (bg) bg.style.display = 'none';
  // 多股模式：modal 關閉後更新 toolbar chips 預覽
  _updateTbChips();
}

function _bindSeedListHeader() {
  // header 現在由 _renderResults 動態產生在 table thead，此函式保留為空
}

// ─── 模式切換 ─────────────────────────────────────────────
let _seedMode = 'multi';

function _bindModeToggle() {
  const toggle = document.getElementById('seedModeToggle');
  if (!toggle) return;
  toggle.addEventListener('click', e => {
    const btn = e.target.closest('.seed-mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === _seedMode) return;
    _seedMode = mode;
    toggle.querySelectorAll('.seed-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('seedMultiArea').style.display  = mode === 'multi'  ? '' : 'none';
    document.getElementById('seedSingleArea').style.display = mode === 'single' ? '' : 'none';
    document.getElementById('seedTbChips').style.display    = mode === 'multi'  ? '' : 'none';
    document.getElementById('seedTbSingle').style.display   = mode === 'single' ? '' : 'none';
    // 掃描按鈕狀態重設
    const scanBtn = document.getElementById('seedScanBtn');
    if (scanBtn) scanBtn.disabled = mode === 'multi'
      ? !(AppState.seed.template)
      : !_singleSeedCode;
    // 結果 header 更新
    const hdr = document.querySelector('#tabSeed .seed-result-list');
    if (hdr && AppState.seed.scanResults?.length === 0) {
      hdr.innerHTML = `<div class="seed-empty-state"><p>尚未開始掃描</p><p class="hint">點擊「⚙ 設定」設定種子 → 「▶ 開始掃描」</p></div>`;
    }
  });
}

function _updateTbChips() {
  const el = document.getElementById('seedTbChips');
  if (!el) return;
  const codes = AppState.seed.seedCodes ?? [];
  if (codes.length === 0) { el.innerHTML = '<span style="color:var(--hint);font-size:12px">尚未設定種子股</span>'; return; }
  el.innerHTML = codes.map(c => {
    const n = getChineseName(c) ?? c;
    return `<span class="seed-tb-chip">${c} <span style="color:var(--muted)">${n}</span></span>`;
  }).join('');
}

// 對外橋接：從個股頁「🔍 找相似」觸發單股掃描
export function triggerSingleSeedFromStock(code) {
  // 切換到種子 Tab
  const seedTabBtn = document.querySelector('.main-tab[data-tab="seed"]');
  if (seedTabBtn) seedTabBtn.click();
  // 切換到單股模式
  const singleBtn = document.querySelector('.seed-mode-btn[data-mode="single"]');
  if (singleBtn && _seedMode !== 'single') singleBtn.click();
  // 填入代號
  _setSingleSeedCode(code);
  // 直接開始掃描（不開 modal，快速觸發）
  _startSingleScan();
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
      // 先試 .TW，失敗再試 .TWO（上櫃股）
      let symbol = toYahooSymbol(code);
      let quote  = null;
      try {
        quote = await fetchQuote(symbol);
      } catch (_) {
        // .TW 找不到 → 試 .TWO
        symbol = code + '.TWO';
        quote  = await fetchQuote(symbol);  // 若還是失敗就拋到外層 catch
      }
      AppState.seed.seedCodes = [...(AppState.seed.seedCodes ?? []), code];
      const chName = getChineseName(code);
      _renderSeedChips(chName ?? quote?.name ?? code);
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
// ─── 單股模式 ─────────────────────────────────────────────
let _singleSeedCode = null;

function _bindSingleScan() {
  const addBtn = document.getElementById('seedSingleAddBtn');
  const inp    = document.getElementById('seedSingleInput');
  if (!addBtn || !inp) return;
  addBtn.addEventListener('click', () => {
    const code = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return;
    _setSingleSeedCode(code);
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  document.getElementById('seedAbortBtn')?.addEventListener('click', () => { abortSeedScan(); });
}

function _setSingleSeedCode(code) {
  _singleSeedCode = code;
  const name = getChineseName(code) ?? code;
  // Modal 內 chip
  const chip = document.getElementById('seedSingleChip');
  if (chip) {
    chip.innerHTML = `<span class="seed-chip">${code} ${name}<span class="seed-chip-del" data-code="${code}">✕</span></span>`;
    chip.querySelector('.seed-chip-del')?.addEventListener('click', () => {
      _singleSeedCode = null;
      chip.innerHTML = '';
      const tb = document.getElementById('seedTbSingleCode');
      if (tb) tb.textContent = '未設定';
      document.getElementById('seedScanBtn').disabled = true;
    });
  }
  // Toolbar 顯示
  const tbCode = document.getElementById('seedTbSingleCode');
  if (tbCode) tbCode.textContent = `${code} ${name}`;
  const inp = document.getElementById('seedSingleInput');
  if (inp) inp.value = '';
  document.getElementById('seedScanBtn').disabled = false;
}

async function _startSingleScan() {
  if (!_singleSeedCode) { showToast('請先設定種子個股（⚙ 設定）'); return; }

  const simMode   = document.querySelector('input[name="seedSimMode"]:checked')?.value   ?? 'technical';
  const scanScope = document.querySelector('input[name="seedScanScope"]:checked')?.value ?? 'fast';
  const priceMin  = parseFloat(document.getElementById('seedSinglePriceMin')?.value) || 0;
  const priceMax  = parseFloat(document.getElementById('seedSinglePriceMax')?.value) || 99999;
  const threshold = simMode === 'marketcap' ? 0.5 : 0.75;

  AppState.seed.scanResults = [];
  _srYaoguMap = new Map();
  _renderResults([]);
  // 掃描開始前先填入已有 cache 的妖股（async，不擋主流程）
  (async () => {
    let allCache = [];
    try { allCache = await getAllSignalsCache(); } catch(e) {}
    allCache.forEach(row => {
      const sigs = row.signals ?? [];
      const x1 = sigs.some(s => s.id === 'X1');
      const x2 = sigs.some(s => s.id === 'X2');
      const x5 = sigs.some(s => s.id === 'X5');
      const x6 = sigs.some(s => s.id === 'X6');
      if (x1||x2||x5||x6) _srYaoguMap.set(row.code, { x1, x2, x5, x6, strongest: x2?'X2':x1?'X1':x6?'X6':'X5' });
    });
  })();
  _scanStart();

  let found = 0, scanned = 0;
  const startTime = Date.now();

  for await (const ev of runSingleSeedScan(_singleSeedCode, { simMode, scanScope, threshold, priceMin, priceMax })) {
    switch (ev.type) {
      case 'progress':
        scanned = ev.done;
        _scanProgress(ev);
        break;
      case 'result':
        found++;
        if (found % 3 === 0 || found <= 3) _renderResults(AppState.seed.scanResults);
        break;
      case 'done':
      case 'aborted':
        _scanEnd(found, scanned, startTime, ev.type === 'aborted');
        _renderResults(AppState.seed.scanResults);
        if (AppState.seed.scanResults?.length > 0) {
          const codes = AppState.seed.scanResults.map(r => r.code);
          fetchFundamentalsBatch(codes).then(fundMap => {
            fundMap.forEach((f, c) => { _srFundCache[c] = f ?? null; });
            // 不在此重繪，由 _scanYaoguForSeedResults 統一負責最終渲染
          }).catch(() => {});
          _scanYaoguForSeedResults(AppState.seed.scanResults);
        }
        break;
      case 'error':
        showToast(ev.message);
        _scanEnd(0, 0, startTime, true);
        break;
    }
  }
}

function _bindScanBtn() {
  document.getElementById('seedScanBtn')?.addEventListener('click', () => {
    if (_seedMode === 'single') _startSingleScan();
    else _startScan();
  });
  document.getElementById('seedAbortBtn')?.addEventListener('click', () => abortSeedScan());
}

// ─── 掃描進度 toolbar helpers ─────────────────────────────
function _scanStart() {
  const scanBtn  = document.getElementById('seedScanBtn');
  const abortBtn = document.getElementById('seedAbortBtn');
  const saveBtn  = document.getElementById('seedTbSaveBtn');
  const progress = document.getElementById('seedProgress');
  const statusEl = document.getElementById('seedProgressText');
  const summary  = document.getElementById('seedSummary');
  if (scanBtn)  { scanBtn.disabled = true; scanBtn.style.display = 'none'; }
  if (abortBtn) abortBtn.style.display = '';
  if (saveBtn)  saveBtn.style.display  = 'none';
  if (progress) progress.style.display = 'block';
  if (statusEl) { statusEl.textContent = '準備中…'; statusEl.style.display = ''; }
  if (summary)  summary.textContent = '';
  const bar = document.getElementById('seedProgressBar');
  if (bar) bar.style.width = '0%';
}

function _scanProgress(ev) {
  const bar      = document.getElementById('seedProgressBar');
  const statusEl = document.getElementById('seedProgressText');
  const pct = ev.total > 0 ? (ev.done / ev.total * 100).toFixed(1) + '%' : '0%';
  const msg = ev.rateLimited
    ? `⏳ rate limit… (${ev.done}/${ev.total})`
    : ev.total > 0 ? `掃描中 ${ev.done}/${ev.total}` : (ev.message || '準備中…');
  if (bar)      bar.style.width       = pct;
  if (statusEl) statusEl.textContent  = msg;
}

function _scanEnd(found, scanned, startTime, aborted) {
  const scanBtn  = document.getElementById('seedScanBtn');
  const abortBtn = document.getElementById('seedAbortBtn');
  const saveBtn  = document.getElementById('seedTbSaveBtn');
  const progress = document.getElementById('seedProgress');
  const statusEl = document.getElementById('seedProgressText');
  const summary  = document.getElementById('seedSummary');
  if (scanBtn)  { scanBtn.disabled = false; scanBtn.style.display = ''; }
  if (abortBtn) abortBtn.style.display  = 'none';
  if (progress) progress.style.display  = 'none';
  if (statusEl) statusEl.style.display  = 'none';
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  if (summary) summary.textContent = aborted
    ? `已停止，找到 ${found} 檔`
    : `找到 ${found} 檔，掃描 ${scanned} 檔，耗時 ${elapsed}s`;
  if (saveBtn && _seedMode === 'multi' && found > 0) saveBtn.style.display = '';
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

  AppState.seed.scanResults = [];
  _renderResults([]);
  _scanStart();

  let found = 0, scanned = 0;
  const startTime = Date.now();

  for await (const ev of runSeedScan(template, opts)) {
    switch (ev.type) {
      case 'progress':
        scanned = ev.done;
        _scanProgress(ev);
        break;
      case 'result':
        found++;
        if (found % 5 === 0 || found <= 3) _renderResults(AppState.seed.scanResults);
        break;
      case 'done':
      case 'aborted':
        _scanEnd(found, scanned, startTime, ev.type === 'aborted');
        _renderResults(AppState.seed.scanResults);
        if (AppState.seed.scanResults?.length > 0) {
          const codes = AppState.seed.scanResults.map(r => r.code);
          fetchFundamentalsBatch(codes).then(fundMap => {
            fundMap.forEach((f, c) => { _srFundCache[c] = f ?? null; });
            // 不在此重繪，由 _scanYaoguForSeedResults 統一負責最終渲染
          }).catch(() => {});
          _scanYaoguForSeedResults(AppState.seed.scanResults);
        }
        _maybeSavePattern();
        break;
      case 'error':
        showToast('⚠ ' + ev.message);
        _scanEnd(0, 0, startTime, true);
        break;
    }
  }
}


async function _scanYaoguForSeedResults(results) {
  let xCount = 0;
  const codeSet = new Set(results.map(r => r.code));
  let allCache = [];
  try { allCache = await getAllSignalsCache(); } catch(e) {}

  // 跟 theme-ui 一樣，不做 isFresh 判斷，直接全撈
  allCache.forEach(row => {
    if (!codeSet.has(row.code)) return;
    const sigs = row.signals ?? [];
    const x1 = sigs.some(s => s.id === 'X1');
    const x2 = sigs.some(s => s.id === 'X2');
    const x5 = sigs.some(s => s.id === 'X5');
    const x6 = sigs.some(s => s.id === 'X6');
    if (x1 || x2 || x5 || x6) {
      _srYaoguMap.set(row.code, { x1, x2, x5, x6, strongest: x2?'X2':x1?'X1':x6?'X6':x5?'X5':'X5' });
      xCount++;
    }
  });

  _renderResults(AppState.seed.scanResults ?? results);
  if (xCount > 0) _showSeedYaoguAlert(xCount);
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
      av = shortHealthScore({ code: a.code, candles: _s(a.miniCandles) }) ?? -1;
      bv = shortHealthScore({ code: b.code, candles: _s(b.miniCandles) }) ?? -1;
    } else if (_srSortKey === 'hl') {
      av = (a.miniCandles?.length >= 120 ? calcHealthLong(a.miniCandles, _srFundCache[a.code] ?? null, a.code) : null) ?? -1;
      bv = (b.miniCandles?.length >= 120 ? calcHealthLong(b.miniCandles, _srFundCache[b.code] ?? null, b.code) : null) ?? -1;
    } else if (_srSortKey === 'yaogu') {
      const _yv = c => { const yg = _srYaoguMap.get(c); if (!yg) return 0; return yg.x2?3:yg.x1?2:yg.x5?1:0; };
      av = _yv(a.code); bv = _yv(b.code);
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
    { key: 'yaogu', label: '妖股' },
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
    const hs = shortHealthScore({ code: item.code, candles: _candlesShort });
    const hl = item.miniCandles?.length >= 120 ? calcHealthLong(item.miniCandles, _srFundCache[item.code] ?? null, item.code) : null;
    const yg = _srYaoguMap.get(item.code);
    const chgCls = item.chgPct >= 0 ? 'up' : 'down';
    const chgStr = (item.chgPct >= 0 ? '+' : '') + (item.chgPct ?? 0).toFixed(2) + '%';
    const priceVal = typeof item.price === 'number' && isFinite(item.price) ? item.price : 0;

    tbody += `<tr class="sr-tbl-row" data-code="${item.code}">
      <td class="sr-tbl-td"><span class="sr-tbl-code">${item.code}</span></td>
      <td class="sr-tbl-td"><span class="sr-tbl-name">${item.name}</span></td>
      <td class="sr-tbl-td"><span class="sr-tbl-price">${priceVal.toFixed(priceVal >= 100 ? 0 : 1)}</span></td>
      <td class="sr-tbl-td"><span class="sr-tbl-chg ${chgCls}">${chgStr}</span></td>
      <td class="sr-tbl-td">${renderHealthBadge(hs, null, { compact: true })}</td>
      <td class="sr-tbl-td">${renderHealthBadge(hl, null, { compact: true })}</td>
      <td class="sr-tbl-td">${yg ? ['X2','X1','X6','X5'].filter(id => yg[id.toLowerCase()]).map(id => `<span class="th-yaogu-pill th-yaogu-pill--${id.toLowerCase()}">${id}</span>`).join('') : ''}</td>
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
      openStockPreview(code);   // 點列 → 個股速覽 modal
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

  // 只畫最近 60 根（240 根擠在小圖裡 MA20 會貼著價格線，看不出對照意義）
  // MA20 用畫面外的前 19 根暖機，第一根就有正確 MA 值
  const SHOW = 60;
  const allCloses = candles.map(c => c.close);
  const closes    = allCloses.slice(-SHOW);
  const offset    = allCloses.length - closes.length;
  const min    = Math.min(...closes);
  const max    = Math.max(...closes);
  const range  = max - min || 1;
  const n      = closes.length;

  const xAt = i => (i / (n - 1)) * w;
  const yAt = v => h - ((v - min) / range) * h * 0.85 - h * 0.075;

  // ── MA20 灰線（疊底層）──
  if (allCloses.length >= 20) {
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    let sum = 0, started = false;
    const firstIdx = Math.max(0, offset - 19);
    for (let g = firstIdx; g < offset; g++) sum += allCloses[g];
    for (let i = 0; i < n; i++) {
      const g = offset + i;
      sum += allCloses[g];
      if (g >= 20) sum -= allCloses[g - 20];
      if (g < 19) continue;
      const x = xAt(i), y = yAt(Math.max(min, Math.min(max, sum / 20)));
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i);
    const y = yAt(closes[i]);
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
      document.getElementById('seedSaveModalBg').style.display = 'none';
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
