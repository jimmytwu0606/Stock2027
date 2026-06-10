/**
 * lab-industry.js — 族群回測子模組
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { CONDITION_DEFS } from './screener.js';
import { STRATEGIES } from './strategy.js';
import { dengToast } from './loading-deng.js';
import { getIndustryCache, setIndustryCache, getHeatmapMeta, saveHeatmapMeta, listIndustryCacheKeys, dbGetAll } from './db.js';
import { fsGetShared } from './firebase.js';
import { resolveCode, tsToDate, checkProLimit, consumeProLimit, COMPARE_STRATEGIES } from './lab-utils.js';

const INDUSTRY_MAP_URL = './industry_map.js';
const INDUSTRY_BATCH   = 15;
const PRO_LIMIT_KEY_INDUSTRY = 'lab_pro_industry_today';

let _industryAbort     = null;
let _industryMap       = null;
let _lastIndustryResult = null;

function _bindIndustryRun() {
  document.getElementById('labRunIndustry')?.addEventListener('click', _startIndustryBacktest);
  document.getElementById('labAbortIndustry')?.addEventListener('click', () => {
    _industryAbort?.abort();
    document.getElementById('labAbortIndustry').style.display = 'none';
    document.getElementById('labRunIndustry').style.display  = '';
  });

  // ── 讀取 Firebase meta，顯示「上次結果」banner ────────────────────
  _loadHeatmapBanner();

  // 設定按鈕
  const settingBtn   = document.getElementById('labIndSettingBtn');
  const settingPanel = document.getElementById('labIndSettingPanel');
  const closeBtn     = document.getElementById('labIndSettingClose');
  const selectAll    = document.getElementById('labIndSelectAll');
  const selectNone   = document.getElementById('labIndSelectNone');
  const countEl      = document.getElementById('labIndSelectedCount');
  const checksEl     = document.getElementById('labIndSectorChecks');

  if (!settingBtn) return;

  settingBtn.addEventListener('click', async () => {
    const isOpen = settingPanel.style.display !== 'none';
    settingPanel.style.display = isOpen ? 'none' : '';
    if (!isOpen) {
      // 每次開啟都重新渲染，確保熱度資料是最新的
      checksEl.innerHTML = '<span style="color:var(--muted);font-size:11px">載入中...</span>';
      // 確保 heatMap 已從 Firebase 載入（preload 是 async，可能還沒跑完）
      if (!_cachedHeatMap && !_lastIndustryResult?.length) {
        await _preloadHeatMap();
      }
      await _populateSectorChecks(checksEl, countEl);
    }
  });

  closeBtn?.addEventListener('click', () => { settingPanel.style.display = 'none'; });

  document.getElementById('labIndSettingConfirm')?.addEventListener('click', () => {
    settingPanel.style.display = 'none';
  });

  selectAll?.addEventListener('click', () => {
    checksEl.querySelectorAll('.sector-tile').forEach(tile => {
      tile.querySelector('input[type=checkbox]').checked = true;
      tile.dataset.checked = 'true';
      tile.style.border = '2px solid rgba(239,83,80,.7)';
      const mark = tile.querySelector('span');
      if (mark) mark.style.display = '';
    });
    _updateSectorCount(countEl, checksEl);
  });

  selectNone?.addEventListener('click', () => {
    checksEl.querySelectorAll('.sector-tile').forEach(tile => {
      tile.querySelector('input[type=checkbox]').checked = false;
      tile.dataset.checked = 'false';
      tile.style.border = '2px solid rgba(255,255,255,.08)';
      const mark = tile.querySelector('span');
      if (mark) mark.style.display = 'none';
    });
    _updateSectorCount(countEl, checksEl);
  });
}

// 族群分類定義
const SECTOR_GROUPS = {
  '電子科技': ['半導體業','光電業','電子零組件業','電腦及週邊設備業','其他電子業','電子通路業','電機機械','電器電纜','數位雲端'],
  '通信網路': ['通信網路業','資訊服務業'],
  '電力能源': ['油電燃氣業','綠能環保'],
  '建築地產': ['建材營造業','玻璃陶瓷業','水泥工業'],
  '化工材料': ['化學工業','橡膠工業','塑膠工業','鋼鐵工業'],
  '金融貿易': ['金融保險業','貿易百貨業'],
  '傳產民生': ['紡織纖維','食品工業','造紙工業','汽車工業'],
  '航運物流': ['航運業'],
  '生醫觀光': ['生技醫療業','農業科技業','觀光餐旅','運動休閒'],
  '文創其他': ['文化創意業','居家生活','其他業'],
};

function _updateSectorCount(countEl, checksEl) {
  if (!countEl || !checksEl) return;
  const total   = checksEl.querySelectorAll('input[type=checkbox]').length;
  const checked = checksEl.querySelectorAll('input[type=checkbox]:checked').length;
  countEl.textContent = `已選 ${checked} / ${total} 族群`;
}

// 計算近30日各族群熱度（來自上次回測結果）
// 近30日熱度快取（從 Firebase meta 讀回，頁面重載後仍有效）
let _cachedHeatMap = null;
let _firebaseMatrix = null;  // Firebase GAS 算好的全粒度 matrix

function _getSectorHeatMap() {
  // 完整回測結果（有真實 stocks.sigs）才從記憶體計算
  if (_lastIndustryResult?.length) {
    // 檢查是否有真實訊號資料（非空 stocks）
    const hasSigs = _lastIndustryResult.some(({ stocks }) =>
      Object.values(stocks ?? {}).some(d => (d.sigs ?? []).length > 0)
    );
    if (hasSigs) {
      const heatMap = {};
      const now = Date.now();
      const MS30 = 30 * 86400000;
      _lastIndustryResult.forEach(({ ind, stocks }) => {
        let recentCnt = 0, vrSum = 0, vrCnt = 0;
        Object.values(stocks ?? {}).forEach(data => {
          (data.sigs ?? []).forEach(sig => {
            const d = new Date((sig.date ?? '').replace(/\//g, '-'));
            if (now - d.getTime() <= MS30) {
              recentCnt++;
              if (sig.volRatio != null) { vrSum += sig.volRatio; vrCnt++; }
            }
          });
        });
        const avgVr = vrCnt > 0 ? vrSum / vrCnt : 1;
        const heat  = recentCnt * Math.min(avgVr, 5);
        if (heat > 0) heatMap[ind] = { heat: +heat.toFixed(1), cnt: recentCnt, avgVr: +avgVr.toFixed(2) };
      });
      return heatMap;
    }
  }
  // fallback：使用 Firebase/IDB meta 中儲存的 heatMap（跨裝置重開頁面仍有 badge）
  return _cachedHeatMap ?? {};
}

// 初始化時從 Firebase 預載 heatMap
// 若 Firebase meta 沒有 heatMap（舊版資料），fallback 到 IDB 完整快取重算
async function _preloadHeatMap() {
  // 1. 優先從 Firebase shared/industry--heatmap 讀（GAS 每天算好的結果）
  try {
    const shared = await fsGetShared('industry--heatmap');
    if (shared?.heatMap && Object.keys(shared.heatMap).length > 0) {
      _cachedHeatMap   = shared.heatMap;
      _firebaseMatrix  = shared.matrix ?? null;
      console.log('[lab] heatMap 從 Firebase shared 載入，族群數:', Object.keys(_cachedHeatMap).length,
        '| matrix粒度:', _firebaseMatrix ? Object.keys(Object.values(_firebaseMatrix)[0] ?? {}).join(',') : 'none');
      return;
    }
  } catch (_) {}

  // 2. fallback：IDB meta
  try {
    const meta = await getHeatmapMeta();
    if (meta?.heatMap && Object.keys(meta.heatMap).length > 0) {
      _cachedHeatMap = meta.heatMap;
      return;
    }
  } catch (_) {}

  // 3. 最終 fallback：IDB 完整快取重算
  try {
    const keys = await listIndustryCacheKeys();
    if (!keys.length) return;
    for (const k of keys) {
      const rec = await getIndustryCache(k);
      if (!rec?.length) continue;
      _lastIndustryResult = rec;
      await saveHeatmapMeta(rec, k);
      break;
    }
    const meta2 = await getHeatmapMeta();
    if (meta2?.heatMap) _cachedHeatMap = meta2.heatMap;
  } catch (e) {
    console.warn('[lab] _preloadHeatMap fallback failed:', e.message);
  }
}

// badge 百分位門檻（依 _cachedHeatMap 動態計算）
function _getBadgeThresholds() {
  const vals = Object.values(_cachedHeatMap ?? {}).map(v => v.heat ?? 0).filter(h => h > 0).sort((a,b) => a-b);
  if (!vals.length) return { p25:1, p50:5, p75:20, p90:100 };
  return {
    p25: vals[Math.floor(vals.length*0.25)] ?? 1,
    p50: vals[Math.floor(vals.length*0.50)] ?? 5,
    p75: vals[Math.floor(vals.length*0.75)] ?? 20,
    p90: vals[Math.floor(vals.length*0.90)] ?? 100,
  };
}

function _heatBadge(heatInfo) {
  if (!heatInfo) return '<span style="font-size:11px;color:rgba(100,116,139,.5);margin-left:5px">—</span>';
  const { heat, cnt, avgVr } = heatInfo;
  const { p25, p50, p75, p90 } = _getBadgeThresholds();
  let col, bg, label;
  if (heat >= p90) {
    col = '#fca5a5'; bg = 'rgba(239,68,68,.28)'; label = '🔥';
  } else if (heat >= p75) {
    col = '#fdba74'; bg = 'rgba(251,146,60,.25)'; label = '↑';
  } else if (heat >= p50) {
    col = '#fde68a'; bg = 'rgba(234,179,8,.22)'; label = '○';
  } else if (heat >= p25) {
    col = '#94a3b8'; bg = 'rgba(148,163,184,.15)'; label = '·';
  } else if (heat > 0) {
    col = '#93c5fd'; bg = 'rgba(59,130,246,.18)'; label = '↓';
  } else {
    col = '#60a5fa'; bg = 'rgba(37,99,235,.22)'; label = '❄';
  }
  return `<span style="font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:${bg};color:${col};margin-left:5px;flex-shrink:0" title="近30日訊號${cnt}筆，均量比${avgVr}x">${label}</span>`;
}

async function _populateSectorChecks(checksEl, countEl) {
  if (!checksEl) return;

  if (!_industryMap) {
    checksEl.innerHTML = '<span style="color:var(--muted);font-size:13px">載入族群中...</span>';
    _industryMap = await _loadIndustryMap();
  }

  const heatMap   = _getSectorHeatMap();
  const hasHeat   = Object.keys(heatMap).length > 0;
  const allSectors = [...new Set(Object.values(_industryMap))].sort();

  // 排序狀態（預設熱→冷）
  if (typeof checksEl._sortAsc === 'undefined') checksEl._sortAsc = false;

  function _sortedSectors() {
    return [...allSectors].sort((a, b) => {
      const ha = heatMap[a]?.heat ?? -1;
      const hb = heatMap[b]?.heat ?? -1;
      return checksEl._sortAsc ? ha - hb : hb - ha;
    });
  }

  // 相對百分位色階（依實際 heatMap 資料動態計算）
  const _heatVals = Object.values(heatMap).map(v => v.heat ?? 0).filter(h => h > 0).sort((a,b) => a-b);
  const _tp25 = _heatVals[Math.floor(_heatVals.length * 0.25)] ?? 1;
  const _tp50 = _heatVals[Math.floor(_heatVals.length * 0.50)] ?? 5;
  const _tp75 = _heatVals[Math.floor(_heatVals.length * 0.75)] ?? 20;
  const _tp90 = _heatVals[Math.floor(_heatVals.length * 0.90)] ?? 100;

  function _tileColor(heat) {
    if (!hasHeat || !heat)  return '#1e3a5f';   // 無資料：深藍（最冷）
    if (heat >= _tp90)      return '#b91c1c';   // top 10%：深紅
    if (heat >= _tp75)      return '#ea580c';   // top 25%：橙
    if (heat >= _tp50)      return '#ca8a04';   // top 50%：黃
    if (heat >= _tp25)      return '#6b7280';   // top 75%：灰
    if (heat > 0)           return '#3b82f6';   // bottom 25%：淺藍
    return '#1e3a5f';                           // 零訊號：深藍
  }
  function _tileBorder(heat, checked) {
    if (!checked) return '2px solid rgba(255,255,255,.08)';
    if (heat >= _tp90) return '2px solid #ef5350';
    if (heat >= _tp75) return '2px solid #fb923c';
    return '2px solid rgba(255,255,255,.15)';
  }
  function _tileText(heat) {
    if (!hasHeat || !heat) return '#93c5fd';   // 深藍底：淺藍字
    if (heat >= _tp25)     return '#fff';      // 灰以上：白字
    return '#fff';                             // 淺藍底：白字
  }

  // 分類快選列
  const groupBtns = Object.keys(SECTOR_GROUPS).map(g => {
    const inGroup = SECTOR_GROUPS[g].filter(s => allSectors.includes(s));
    const avgHeat = inGroup.length
      ? inGroup.reduce((s, sec) => s + (heatMap[sec]?.heat ?? 0), 0) / inGroup.length : 0;
    const { p50: _dp50, p75: _dp75 } = _getBadgeThresholds();
    const dotCol = avgHeat >= _dp75 ? '#ef5350' : avgHeat >= _dp50 ? '#f0b429' : 'var(--muted)';
    return `<button class="lab-copy-btn sector-group-btn" data-group="${g}"
      style="font-size:13px;padding:3px 10px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;color:var(--text)">
      <span style="width:7px;height:7px;border-radius:50%;background:${dotCol};flex-shrink:0"></span>${g}
    </button>`;
  }).join('');

  function _renderTiles(sortedList, checkedSet) {
    return sortedList.map(s => {
      const heat    = heatMap[s]?.heat ?? (hasHeat ? 0 : -1);
      const checked = checkedSet.has(s);
      const bg      = _tileColor(heat);
      const border  = _tileBorder(heat, checked);
      const tc      = _tileText(heat);
      const checkMark = checked
        ? `<span style="position:absolute;top:3px;right:5px;font-size:10px;color:rgba(255,255,255,.9)">✓</span>`
        : '';
      return `<div class="sector-tile" data-sector="${s}" data-checked="${checked}"
        style="position:relative;padding:7px 8px;border-radius:6px;background:${bg};border:${border};
               cursor:pointer;text-align:center;font-size:12px;font-weight:500;color:${tc};
               transition:transform .1s,box-shadow .1s;user-select:none"
        title="${s}${hasHeat && heatMap[s] ? '｜近30日訊號'+heatMap[s].cnt+'筆，量比'+heatMap[s].avgVr+'x' : ''}">
        ${checkMark}${s}
        <input type="checkbox" value="${s}" ${checked ? 'checked' : ''} style="display:none">
      </div>`;
    }).join('');
  }

  const warningBanner = !hasHeat ? `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(240,180,41,.08);border:0.5px solid rgba(240,180,41,.3);border-radius:6px;margin-bottom:10px">
      <span style="font-size:16px">⚠️</span>
      <span style="font-size:13px;color:#f0b429">先跑一次<b>全市場掃描</b>，即可顯示各族群近期熱度，協助快速篩選</span>
    </div>` : '';

  const sortLabel = checksEl._sortAsc ? '↑ 冷→熱' : '↓ 熱→冷';
  const allChecked = allSectors.every(s => true); // 預設全選
  const checkedSet = new Set(allSectors); // 初始全選

  checksEl.innerHTML = `
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      ${groupBtns}
    </div>
    ${warningBanner}
    <div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:6px">
      <button id="sectorSortBtn" style="font-size:12px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">${sortLabel}</button>
    </div>
    <div id="sectorTileGrid" style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px">
      ${_renderTiles(_sortedSectors(), checkedSet)}
    </div>
    ${hasHeat ? `<div style="margin-top:10px;padding:5px 10px;background:rgba(255,255,255,.03);border-radius:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text)">熱</span>
      ${['#b91c1c','#ea580c','#ca8a04','#6b7280','#3b82f6','#1e3a5f'].map(c =>
        `<div style="width:20px;height:10px;border-radius:3px;background:${c}"></div>`).join('<span style="color:var(--muted);opacity:.4;font-size:11px">&gt;</span>')}
      <span style="font-size:12px;color:var(--text)">冷</span>
      <span style="font-size:11px;color:var(--muted);opacity:.5;margin-left:4px">近30日訊號密度 × 均量比</span>
    </div>` : ''}`;

  // 恢復已儲存的勾選狀態
  const savedChecks = [...checksEl.querySelectorAll('input[type=checkbox]')];
  // （初始全選，不需額外操作）

  // 排序按鈕
  checksEl.querySelector('#sectorSortBtn')?.addEventListener('click', () => {
    checksEl._sortAsc = !checksEl._sortAsc;
    const btn = checksEl.querySelector('#sectorSortBtn');
    if (btn) btn.textContent = checksEl._sortAsc ? '↑ 冷→熱' : '↓ 熱→冷';
    const grid = checksEl.querySelector('#sectorTileGrid');
    if (!grid) return;
    const curChecked = new Set(
      [...grid.querySelectorAll('.sector-tile[data-checked="true"]')].map(t => t.dataset.sector)
    );
    grid.innerHTML = _renderTiles(_sortedSectors(), curChecked);
    _bindTiles(grid, countEl, checksEl);
  });

  function _bindTiles(grid, countEl, checksEl) {
    grid.querySelectorAll('.sector-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const s = tile.dataset.sector;
        const cb = tile.querySelector('input[type=checkbox]');
        const nowChecked = tile.dataset.checked === 'true';
        const nextChecked = !nowChecked;
        cb.checked = nextChecked;
        tile.dataset.checked = nextChecked;
        // 更新邊框
        const heat = heatMap[s]?.heat ?? (hasHeat ? 0 : -1);
        tile.style.border = _tileBorder(heat, nextChecked);
        // 更新打勾標示
        const mark = tile.querySelector('span');
        if (mark) mark.style.display = nextChecked ? '' : 'none';
        _updateSectorCount(countEl, checksEl);
      });
    });
  }

  _bindTiles(checksEl.querySelector('#sectorTileGrid'), countEl, checksEl);

  // 分類按鈕點擊 → 勾選該分類
  checksEl.querySelectorAll('.sector-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      const targets = SECTOR_GROUPS[group] ?? [];
      const grid = checksEl.querySelector('#sectorTileGrid');
      if (!grid) return;
      const tiles = [...grid.querySelectorAll('.sector-tile')].filter(t => targets.includes(t.dataset.sector));
      const allChk = tiles.every(t => t.dataset.checked === 'true');
      tiles.forEach(t => {
        const cb = t.querySelector('input[type=checkbox]');
        const next = !allChk;
        cb.checked = next;
        t.dataset.checked = next;
        const heat = heatMap[t.dataset.sector]?.heat ?? (hasHeat ? 0 : -1);
        t.style.border = _tileBorder(heat, next);
        const mark = t.querySelector('span');
        if (mark) mark.style.display = next ? '' : 'none';
      });
      _updateSectorCount(countEl, checksEl);
    });
  });

  _updateSectorCount(countEl, checksEl);
}

// ── 上次結果 banner（從 Firebase meta 讀取，跨裝置顯示）─────────────────────
async function _loadHeatmapBanner() {
  const emptyEl = document.getElementById('labIndustryEmpty');
  if (!emptyEl) return;
  try {
    const meta = await getHeatmapMeta();
    if (!meta?.indStatsMeta?.length) return;

    const d = new Date(meta.savedAt);
    const dateStr = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    const top3 = meta.indStatsMeta
      .slice().sort((a, b) => b.wr - a.wr).slice(0, 3)
      .map(s => `<span style="color:var(--up)">${s.ind}</span> ${s.wr}%`).join('　');

    // 在 empty state 插入 banner（不取代原按鈕提示）
    const banner = document.createElement('div');
    banner.id = 'labHeatmapBanner';
    banner.style.cssText = `
      margin-top:14px;padding:10px 14px;
      border:1px solid rgba(239,83,80,.2);border-radius:7px;
      background:rgba(239,83,80,.05);text-align:left;
      max-width:360px;width:100%
    `;
    banner.innerHTML = `
      <div style="font-size:11px;color:var(--muted);margin-bottom:5px">📋 上次族群回測記錄</div>
      <div style="font-size:12px;color:var(--text);margin-bottom:3px">掃描時間：<span style="color:var(--accent)">${dateStr}</span></div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:7px">族群數 ${meta.indStatsMeta.length}　前三：${top3}</div>
      <button id="labLoadLastMeta" style="
        padding:4px 12px;font-size:11px;border-radius:5px;cursor:pointer;
        background:transparent;border:1px solid rgba(239,83,80,.35);color:var(--up)
      ">載入上次排行榜</button>
      <span style="font-size:10px;color:var(--muted);margin-left:8px">（只含統計摘要，不含熱力圖月份格子）</span>
    `;
    emptyEl.appendChild(banner);

    document.getElementById('labLoadLastMeta')?.addEventListener('click', () => {
      const resultEl = document.getElementById('labIndustryResult');
      if (!resultEl) return;
      // 不覆寫 _lastIndustryResult，讓 _getSectorHeatMap() 繼續用 _cachedHeatMap
      // 只把 meta 輕量版傳給 _renderIndustryResult 顯示排行榜
      const displayStats = meta.indStatsMeta.map(s => ({ ...s, stocks: {} }));
      emptyEl.style.display = 'none';
      _renderIndustryResult(resultEl, { indStats: displayStats });
      resultEl.style.display = '';
      dengToast('✓ 已載入上次排行榜摘要（重新掃描可取得完整熱力圖）');
    });
  } catch (e) {
    // 靜默失敗
  }
}

async function _startIndustryBacktest() {
  const tier = window.__userTier ?? 'guest';
  if (tier !== 'vvvip' && tier !== 'pro') {
    dengToast('策略實驗室需要 Pro 以上會員');
    return;
  }
  if (tier === 'pro' && !checkProLimit(PRO_LIMIT_KEY_INDUSTRY)) {
    dengToast('Pro 方案今日族群回測次數已用完');
    return;
  }

  const runBtn   = document.getElementById('labRunIndustry');
  const abortBtn = document.getElementById('labAbortIndustry');
  const resultEl = document.getElementById('labIndustryResult');
  const emptyEl  = document.getElementById('labIndustryEmpty');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressText = document.getElementById('labProgressText');

  runBtn.style.display   = 'none';
  abortBtn.style.display = '';
  emptyEl.style.display  = 'none';
  resultEl.style.display = 'none';
  progressEl.style.display = '';
  progressBar.style.width  = '0%';

  _industryAbort = new AbortController();
  const signal = _industryAbort.signal;

  try {
    // 讀取勾選的持有天數
    const checkedBoxes = document.querySelectorAll('#labIndHoldChecks input[type=checkbox]:checked');
    const HOLD_OPTIONS = checkedBoxes.length
      ? [...checkedBoxes].map(cb => parseInt(cb.value)).sort((a,b) => a-b)
      : [5, 10, 20, 30];
    if (!HOLD_OPTIONS.length) { dengToast('請至少勾選一個持有天數'); return; }

    // 讀取勾選的族群
    const checkedSectors = new Set(
      [...document.querySelectorAll('#labIndSectorChecks input[type=checkbox]:checked')]
        .map(cb => cb.value)
    );

    // ── 先查 IndexedDB 快取（當天已跑過且相同設定直接用）──────────────
    const sectorKey = checkedSectors.size > 0 ? [...checkedSectors].sort().join(',') : 'ALL';
    const cacheKey  = 'industry_backtest_' + HOLD_OPTIONS.join('_') + '_' + sectorKey.slice(0, 40);
    progressText.textContent = '檢查今日快取...';
    const cached = await getIndustryCache(cacheKey);
    if (cached) {
      progressEl.style.display = 'none';
      abortBtn.style.display   = 'none';
      runBtn.style.display     = '';
      _lastIndustryResult = cached;
      _renderIndustryResult(resultEl, { indStats: cached });
      resultEl.style.display = '';
      dengToast('✓ 使用今日快取結果');
      // 快取命中也補寫 Firebase meta（確保跨裝置同步）
      saveHeatmapMeta(cached, cacheKey).catch(e =>
        console.warn('[lab] saveHeatmapMeta(cache) failed:', e.message)
      );
      return;
    }

    if (!_industryMap) {
      progressText.textContent = '載入產業別對照表...';
      _industryMap = await _loadIndustryMap();
    }

    // 若設定 panel 未開啟過（沒有 checkbox），視為全選
    const allCodes = Object.keys(_industryMap);
    const codes = checkedSectors.size > 0
      ? allCodes.filter(code => checkedSectors.has(_industryMap[code]))
      : allCodes;
    const total = codes.length;

    // ── Bundle 確保灌入（避免 race condition：bundle 用 requestIdleCallback 延後，
    //   若用戶進 app 後立即跑族群回測，IDB 可能還空著 → 一條一條抓。先等 bundle 完成。）
    if (window.__bundleReady) {
      progressText.textContent = `Phase 1／2　等待 K 線快取就緒…`;
      await window.__bundleReady;
    }

    // ── Phase 1：從 IDB 一次性讀取全市場 K 線 ──────────────────────────────
    // ⚠️ 踩雷備忘（2026-06-06）：
    //   舊版逐批 fetchHistoryCached（130 批 × yield）雖然 IDB 全命中，但每批 setTimeout yield
    //   導致 UI 看起來慢慢跑約 3~5 秒。
    //   修法：改用 dbGetAll('kline_cache') 一次性撈全部，~0.5 秒完成，IDB miss 才補抓。
    progressText.textContent = `Phase 1／2　讀取本機快取…`;
    const candleMap = new Map();

    // 一次性從 IDB 撈全部 kline_cache
    const allCache = await dbGetAll('kline_cache').catch(() => []);
    const cacheBySymbol = new Map((allCache || []).map(r => [r.symbol, r.candles]));

    for (const code of codes) {
      if (signal.aborted) break;
      const sym1 = toYahooSymbol(code);
      const sym2 = sym1.endsWith('.TW') ? sym1.replace('.TW', '.TWO') : sym1.replace('.TWO', '.TW');
      const c = cacheBySymbol.get(sym1) || cacheBySymbol.get(sym2);
      if (c && c.length >= 60) candleMap.set(code, c);
    }

    // IDB miss 的補抓（bundle 正常灌入後應幾乎為 0）
    const missedCodes = codes.filter(code => !candleMap.has(code));
    if (missedCodes.length > 0) {
      progressText.textContent = `Phase 1／2　補抓 ${missedCodes.length} 檔…`;
      let dlDone = 0;
      for (let i = 0; i < missedCodes.length; i += INDUSTRY_BATCH) {
        if (signal.aborted) break;
        const batch = missedCodes.slice(i, i + INDUSTRY_BATCH);
        await Promise.allSettled(batch.map(async code => {
          try {
            const sym = toYahooSymbol(code);
            let c = await fetchHistoryCached(sym, '1y', { allowStale: true });
            if (!c || c.length < 60)
              c = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: true }).catch(() => null);
            if (c && c.length >= 60) candleMap.set(code, c);
          } catch {}
        }));
        dlDone += batch.length;
        const pct = Math.round(dlDone / missedCodes.length * 45);
        progressBar.style.width  = pct + '%';
        progressText.textContent = `Phase 1／2　補抓 ${dlDone}/${missedCodes.length}（${Math.round(dlDone/missedCodes.length*100)}%）...`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    progressBar.style.width  = '45%';
    progressText.textContent = `Phase 1／2　K 線載入完成（${candleMap.size}/${total}）`;

    if (signal.aborted) { emptyEl.style.display = ''; return; }

    // ── 拉取 condition 歷史序列（GAS 預算，供 Phase 2 直接查詢）──────────
    // R2 signals:cond:part:N，每 Part 約 300~600KB gzip
    const WORKER_BASE  = 'https://stock-2027.luffy0606.workers.dev';
    const WORKER_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
    const condMap = new Map();  // code → { len, seq: [trueCondIds[]] }
    let condReady = false;

    try {
      progressText.textContent = 'Phase 2／2　載入策略條件快取...';
      const partFetches = Array.from({ length: 7 }, (_, i) =>
        fetch(`${WORKER_BASE}/cond-raw?part=${i + 1}`, {
          headers: { 'X-Proxy-Token': WORKER_TOKEN },
          cache: 'no-store',
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      );
      const partResults = await Promise.all(partFetches);
      partResults.forEach(data => {
        if (!data?.stocks) return;
        Object.entries(data.stocks).forEach(([code, info]) => {
          condMap.set(code, info);
        });
      });
      condReady = condMap.size > 0;
      console.log(`[lab] condition 序列載入：${condMap.size} 支，condReady=${condReady}`);
    } catch(e) {
      console.warn('[lab] condition 序列載入失敗，fallback 本機計算:', e.message);
    }

    // ── Phase 2：Web Worker 計算（並行，不佔主執行緒）────────────────
    const cachedCodes = [...candleMap.keys()];
    const calcTotal   = cachedCodes.length;

    progressBar.style.width  = '45%';
    progressText.textContent = `Phase 2／2　啟動 Worker 計算 ${calcTotal} 支...`;
    await new Promise(r => setTimeout(r, 0));

    const byIndustry = {};
    // condReady 時只傳 code（Worker 查 condMap），否則傳 candles（本機算）
    // condReady：同時傳 candles（Phase1+報酬計算）和 condSeq（Phase2 查序列）
    // fallback：只傳 candles，Worker 自行算指標
    const allEntries = cachedCodes.map(code => ({
      code,
      candles: candleMap.get(code),
      condSeq: condReady ? (condMap.get(code) ?? null) : null,
    }));
    const NUM_SLOW   = Math.min(4, navigator.hardwareConcurrency || 2);
    const chunkSz    = Math.ceil(allEntries.length / NUM_SLOW);
    const chunks     = Array.from({ length: NUM_SLOW }, (_, i) =>
      allEntries.slice(i * chunkSz, (i + 1) * chunkSz)).filter(c => c.length);

    // 全域累計：每次 Worker 回報 progress，加上增量
    const workerPrev = new Array(chunks.length).fill(0); // 記錄各 Worker 上次回報值
    let globalDone   = 0;

    await Promise.all(chunks.map((chunk, wi) => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./industry-slow-worker.js', import.meta.url), { type: 'module' });
      // condDefs：序列化 CONDITION_DEFS（去掉 calc/match 函式，只傳 id/phase），
      // 讓 Worker 不需 import screener.js（避免 firebase.js window 錯誤）
      const condDefs = CONDITION_DEFS.map(d => ({ id: d.id, phase: d.phase }));
      w.postMessage({ type: 'run', payload: { entries: chunk, strategies: COMPARE_STRATEGIES, holdOptions: HOLD_OPTIONS, condReady, condDefs } });
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'result') {
          const { code, strat, hold, sigs, avg60vol } = msg;
          const ind = _industryMap[code];
          if (ind) {
            if (!byIndustry[ind]) byIndustry[ind] = { stocks: {} };
            byIndustry[ind].stocks[code] = { sigs, strat, hold, avg60vol: avg60vol ?? 0 };
          }
        } else if (msg.type === 'progress') {
          if (signal.aborted) { w.terminate(); resolve(); return; }
          // 用增量更新全域計數，避免不同 Worker 的 done 相互覆蓋造成倒退
          const delta   = msg.done - workerPrev[wi];
          workerPrev[wi] = msg.done;
          globalDone    += delta;
          const pct = 45 + Math.round(globalDone / calcTotal * 53);
          progressBar.style.width  = Math.min(98, pct) + '%';
          progressText.textContent = `Phase 2／2　計算 ${globalDone}/${calcTotal}（${Math.min(98, pct)}%）...`;
        } else if (msg.type === 'done') {
          w.terminate(); resolve();
        }
      };
      w.onerror = (err) => { w.terminate(); reject(new Error(err.message)); };
    })));

    progressEl.style.display = 'none';
    abortBtn.style.display   = 'none';
    runBtn.style.display     = '';

    if (signal.aborted) { emptyEl.style.display = ''; return; }

    const indStats = Object.entries(byIndustry).map(([ind, data]) => {
      const stockList = Object.entries(data.stocks);
      if (!stockList.length) return null;
      const allSigs = stockList.flatMap(([, d]) => d.sigs);
      const wins    = allSigs.filter(s => s.win).length;
      const wr      = +(wins / allSigs.length * 100).toFixed(1);
      const ret     = +(allSigs.reduce((s, x) => s + x.ret, 0) / allSigs.length).toFixed(2);

      // 量能統計
      const sigsWithVol = allSigs.filter(s => s.volRatio != null);
      const avgVolRatio = sigsWithVol.length
        ? +(sigsWithVol.reduce((s, x) => s + x.volRatio, 0) / sigsWithVol.length).toFixed(2)
        : 1;
      const avgVol = stockList.length
        ? Math.round(stockList.reduce((s, [, d]) => s + (d.avg60vol ?? 0), 0) / stockList.length)
        : 0;

      return { ind, wr, ret, cnt: allSigs.length, stockCount: stockList.length, avgVolRatio, avgVol, stocks: data.stocks };
    }).filter(Boolean).sort((a, b) => b.wr - a.wr);

    // ── 存入 IndexedDB 快取 + Firebase meta ──────────────────────────
    await setIndustryCache(indStats, cacheKey);
    // 無條件寫入 Firebase meta（heatMap 跨裝置同步）
    saveHeatmapMeta(indStats, cacheKey).catch(e =>
      console.warn('[lab] saveHeatmapMeta failed:', e.message)
    );

    _lastIndustryResult = indStats;
    _renderIndustryResult(resultEl, { indStats });
    resultEl.style.display = '';


  } catch (e) {
    progressEl.style.display = 'none';
    abortBtn.style.display   = 'none';
    runBtn.style.display     = '';
    if (!signal.aborted) {
      dengToast(`族群回測失敗：${e.message}`);
      console.error('[lab] industry backtest error:', e);
    }
  }
}


async function _loadIndustryMap() {
  try {
    const mod = await import('./industry_map.js');
    return mod.INDUSTRY_MAP ?? {};
  } catch (e) {
    console.error('[lab] 無法載入 industry_map.js:', e);
    return {};
  }
}

// ── 族群回測結果渲染 ──────────────────────────────────────────────────────
function _renderIndustryResult(el, { indStats }) {
  if (!indStats.length) {
    el.innerHTML = `<div class="lab-empty-state"><p>本次掃描無有效訊號</p></div>`;
    return;
  }

  // ── 熱力圖工具函式 ──────────────────────────────────────────────────
  // 色階：冷=深色底→暖→橙→紅（台股慣例：熱=紅）
  function _heatColor(heat) {
    if (!heat) return 'rgba(255,255,255,.03)';
    if (heat < 2)  return 'rgba(22,101,52,.55)';    // 深綠（冷）
    if (heat < 5)  return 'rgba(161,98,7,.65)';     // 深黃（微溫）
    if (heat < 10) return 'rgba(194,65,12,.80)';    // 橙（升溫）
    if (heat < 18) return 'rgba(185,28,28,.85)';    // 紅（熱）
    return 'rgba(220,38,38,.95)';                   // 亮紅（爆熱）
  }
  function _heatTextColor(heat) {
    if (!heat) return 'rgba(156,163,175,.4)';
    if (heat < 2) return '#86efac';    // 低熱：亮綠字
    if (heat < 5) return '#fde68a';    // 微溫：亮黃字
    return '#fff';                     // 熱以上：白字
  }
  // 熱度標準化為 0~1（供漸層計算，保留舊 _heatColor 分段）
  function _heatOpacity(heat) {
    return Math.min(heat / 20, 1);
  }

  // 從 indStats 建立月份 × 族群的熱力矩陣
  function _buildHeatMatrix() {
    const monthSet = new Set();
    const matrix   = {}; // { ind: { "2026/03": { cnt, avgVolRatio, stocks:[{code,sigs}] } } }

    indStats.forEach(({ ind, stocks }) => {
      matrix[ind] = {};
      Object.entries(stocks).forEach(([code, data]) => {
        data.sigs.forEach(sig => {
          const m = sig.date?.slice(0, 7);
          if (!m) return;
          monthSet.add(m);
          if (!matrix[ind][m]) matrix[ind][m] = { cnt: 0, volRatioSum: 0, volRatioCnt: 0, stocks: [] };
          matrix[ind][m].cnt++;
          if (sig.volRatio != null) {
            matrix[ind][m].volRatioSum += sig.volRatio;
            matrix[ind][m].volRatioCnt++;
          }
          // 記錄個股（不重複）
          if (!matrix[ind][m].stocks.find(s => s.code === code)) {
            matrix[ind][m].stocks.push({ code, strat: data.strat, hold: data.hold });
          }
        });
      });
    });

    // 計算平均量比和熱度分
    Object.values(matrix).forEach(indMonths => {
      Object.values(indMonths).forEach(cell => {
        cell.avgVolRatio = cell.volRatioCnt > 0
          ? +(cell.volRatioSum / cell.volRatioCnt).toFixed(2) : 1;
        cell.heat = +(cell.cnt * Math.min(cell.avgVolRatio, 5)).toFixed(1);
      });
    });

    const months = [...monthSet].sort();
    return { matrix, months };
  }

  // ── 排行榜 ──────────────────────────────────────────────────────────
  let _sortKey = 'wr';
  let _sortAsc  = false;

  function _sortedStats() {
    return [...indStats].sort((a, b) => {
      const v = _sortAsc ? 1 : -1;
      if (_sortKey === 'wr')         return (a.wr - b.wr) * v;
      if (_sortKey === 'ret')        return (a.ret - b.ret) * v;
      if (_sortKey === 'cnt')        return (a.cnt - b.cnt) * v;
      if (_sortKey === 'stockCount')  return (a.stockCount - b.stockCount) * v;
      if (_sortKey === 'avgVolRatio') return ((a.avgVolRatio ?? 1) - (b.avgVolRatio ?? 1)) * v;
      if (_sortKey === 'avgVol')      return ((a.avgVol ?? 0) - (b.avgVol ?? 0)) * v;
      return 0;
    });
  }

  function _renderRows(sorted) {
    return sorted.map((s, i) => {
      const barW   = Math.min(100, Math.abs(s.ret) / 3 * 100);
      const retCol = s.ret >= 0 ? '#ef5350' : '#26a69a';
      const wrCol  = s.wr >= 70 ? '#ef5350' : s.wr >= 50 ? '#f0b429' : 'var(--text)';
      const vrCol  = (s.avgVolRatio ?? 1) >= 2 ? '#ef5350' : (s.avgVolRatio ?? 1) >= 1.3 ? '#f0b429' : 'var(--muted)';
      const vr     = s.avgVolRatio ?? 1;
      return `<tr class="lab-ind-row" data-ind="${s.ind}" style="cursor:pointer">
        <td style="color:var(--muted);width:28px">${i + 1}</td>
        <td style="color:var(--text)">${s.ind}</td>
        <td style="color:${wrCol}">${s.wr}%</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;background:var(--bg3);border-radius:2px;height:4px">
              <div style="width:${barW}%;height:4px;border-radius:2px;background:${retCol}"></div>
            </div>
            <span style="color:${retCol};min-width:50px">${s.ret >= 0 ? '+' : ''}${s.ret}%</span>
          </div>
        </td>
        <td style="color:var(--text)">${s.cnt}</td>
        <td style="color:var(--muted)">${s.stockCount} 支</td>
        <td style="color:${vrCol};white-space:nowrap;font-size:12px">${vr}x</td>
        <td style="color:var(--muted);font-size:11px;white-space:nowrap">${(s.avgVol ?? 0).toLocaleString()} 張</td>
        <td><button class="lab-ind-detail-btn" data-ind="${s.ind}">明細</button></td>
      </tr>`;
    }).join('');
  }

  function _thStyle(key) {
    const active = _sortKey === key;
    return `style="cursor:pointer;user-select:none;color:${active ? 'var(--accent)' : 'var(--text)'}" data-sort="${key}"`;
  }

  function _rebuildRank() {
    const sorted = _sortedStats();
    el.querySelector('#indRankBody').innerHTML = _renderRows(sorted);
    el.querySelectorAll('#indRankTable th[data-sort]').forEach(th => {
      const key = th.dataset.sort;
      th.style.color = _sortKey === key ? 'var(--accent)' : 'var(--text)';
    });
    _bindRowClicks();
  }

  function _bindRowClicks() {
    el.querySelectorAll('.lab-ind-detail-btn, .lab-ind-row').forEach(btn => {
      btn.addEventListener('click', e => {
        if (e.target.classList.contains('lab-ind-detail-btn')) {
          _openIndModal(e.target.dataset.ind);
        } else {
          const ind = e.currentTarget.dataset.ind;
          if (ind) _openIndModal(ind);
        }
      });
    });
  }

  // ── 熱力圖渲染 ────────────────────────────────────────────────────────
  // 粒度定義
  const GRAN_DEFS = [
    { key: 'day',     label: '日' },
    { key: 'week',    label: '週' },
    { key: 'month',   label: '月' },
    { key: 'quarter', label: '季' },
    { key: 'half',    label: '半年' },
    { key: 'year',    label: '年' },
  ];

  // 從 Firebase matrix 建立指定粒度的熱力資料
  function _buildHeatFromFirebase(granKey) {
    if (!_firebaseMatrix) return null;
    const periodSet = new Set();
    const matrix = {};
    Object.entries(_firebaseMatrix).forEach(([ind, grans]) => {
      const granData = grans[granKey];
      if (!granData) return;
      matrix[ind] = {};
      Object.entries(granData).forEach(([period, cell]) => {
        periodSet.add(period);
        matrix[ind][period] = { cnt: cell.cnt, avgVolRatio: cell.avgVr ?? 1, heat: cell.heat };
      });
    });
    const periods = [...periodSet].sort();
    return periods.length ? { matrix, periods } : null;
  }

  function _renderHeatmap(granKey) {
    granKey = granKey || 'month';

    // 優先用 Firebase matrix（GAS 算好的）
    const fbData = _buildHeatFromFirebase(granKey);
    if (fbData) {
      return _renderHeatTable(fbData.matrix, fbData.periods, granKey, true);
    }

    // fallback：本機回測結果（月粒度）
    const { matrix, months } = _buildHeatMatrix();
    if (!months.length) return '<div style="color:var(--muted);padding:20px">資料不足（請先跑族群回測或等待 GAS 更新）</div>';
    return _renderHeatTable(matrix, months, 'month', false);
  }

  function _renderHeatTable(matrix, periods, granKey, isFirebase) {
    if (!periods.length) return '<div style="color:var(--muted);padding:20px">資料不足</div>';

    // 依「最新一個時間點熱度」排序族群
    const lastPeriod = periods[periods.length - 1];
    // 所有有資料的族群（Firebase 或本機）
    const allInds = isFirebase
      ? Object.keys(matrix)
      : [...indStats].map(s => s.ind);
    const sortedInds = [...allInds]
      .sort((a, b) => (matrix[b]?.[lastPeriod]?.heat ?? 0) - (matrix[a]?.[lastPeriod]?.heat ?? 0));

    let html = `<div style="position:relative">` +
      `<div id="heatScrollWrap" style="overflow-x:auto;max-height:calc(100vh - 280px);overflow-y:auto;border:1px solid var(--border);border-radius:7px 7px 0 0;cursor:grab;user-select:none;scrollbar-width:none;-ms-overflow-style:none">` +
      `<style>#heatScrollWrap::-webkit-scrollbar{display:none}</style>` +
      `<table style="border-collapse:separate;border-spacing:2px;font-size:11px;white-space:nowrap;padding:6px">` +
      `<thead><tr>` +
      `<th style="text-align:right;padding:4px 10px 4px 4px;color:var(--muted);font-weight:400;min-width:88px;position:sticky;left:0;top:0;background:var(--bg2);z-index:3;border-bottom:1px solid var(--border)">族群</th>`;
    // 計算全域最大熱度（相對色階）
    let maxHeat = 1;
    sortedInds.forEach(ind => periods.forEach(p => {
      const h = matrix[ind]?.[p]?.heat ?? 0;
      if (h > maxHeat) maxHeat = h;
    }));
    const heatVals = sortedInds.flatMap(ind => periods.map(p => matrix[ind]?.[p]?.heat ?? 0)).filter(h => h > 0).sort((a,b)=>a-b);
    const p25 = heatVals[Math.floor(heatVals.length*0.25)] ?? 2;
    const p50 = heatVals[Math.floor(heatVals.length*0.50)] ?? 5;
    const p75 = heatVals[Math.floor(heatVals.length*0.75)] ?? 15;
    const p90 = heatVals[Math.floor(heatVals.length*0.90)] ?? 40;

    function _relHeatColor(heat) {
      if (!heat) return 'rgba(255,255,255,.03)';
      if (heat >= p90) return 'rgba(220,38,38,.95)';
      if (heat >= p75) return 'rgba(185,28,28,.80)';
      if (heat >= p50) return 'rgba(194,65,12,.70)';
      if (heat >= p25) return 'rgba(161,98,7,.60)';
      return 'rgba(22,101,52,.50)';
    }
    function _relHeatText(heat) {
      if (!heat) return 'rgba(156,163,175,.4)';
      if (heat >= p50) return '#fff';
      if (heat >= p25) return '#fde68a';
      return '#86efac';
    }

    periods.forEach(p => {
      const isLast = p === lastPeriod;
      html += `<th style="text-align:center;color:${isLast ? 'var(--up)' : 'var(--muted)'};font-weight:${isLast ? '600' : '400'};min-width:56px;padding:4px 2px;position:sticky;top:0;background:var(--bg2);z-index:2;border-bottom:1px solid var(--border)">${p}</th>`;
    });
    html += `</tr></thead><tbody>`;

    sortedInds.forEach((ind, ri) => {
      const rowBg = ri % 2 === 0 ? 'var(--bg)' : 'var(--bg2)';
      html += `<tr data-hm-row="${ind}"><td style="text-align:right;padding:2px 10px 2px 4px;color:var(--text);font-size:11px;position:sticky;left:0;background:${rowBg};z-index:1;white-space:nowrap">${ind}</td>`;
      periods.forEach(p => {
        const cell = matrix[ind]?.[p];
        if (!cell) {
          html += `<td style="width:56px;height:32px;border-radius:4px;border:1px dashed rgba(255,255,255,.06)"></td>`;
        } else {
          const bg = _relHeatColor(cell.heat);
          const tc = _relHeatText(cell.heat);
          const vr = cell.avgVolRatio ?? cell.avgVr ?? 1;
          const pulse = cell.heat >= p90 ? 'outline:1px solid rgba(239,83,80,.5);' : '';
          html += `<td class="hm-cell" style="width:56px;height:32px;border-radius:4px;background:${bg};text-align:center;cursor:pointer;vertical-align:middle;${pulse}"` +
            ` title="${ind} ${p}\n訊號 ${cell.cnt} 筆｜均量比 ${vr}x\n點擊查看個股"` +
            ` data-hm-ind="${ind}" data-hm-period="${p}">` +
            `<div style="color:${tc};font-size:11px;font-weight:700;line-height:1.3">${cell.cnt}</div>` +
            `<div style="color:${tc};font-size:10px;opacity:.85;line-height:1.1">${vr}x</div>` +
            `</td>`;
        }
      });
      html += `</tr>`;
    });

    html += `</tbody></table></div></div>` +
      `<div id="heatScrollTrack" style="height:14px;background:var(--bg2);border:1px solid var(--border);border-top:none;border-radius:0 0 7px 7px;overflow:hidden;position:relative;cursor:pointer">` +
      `<div id="heatScrollThumb" style="position:absolute;top:2px;height:10px;background:rgba(255,255,255,.2);border-radius:5px;cursor:grab;transition:background .15s"></div>` +
      `</div>` +
      `</div>`;

    // 圖例
    const src = isFirebase ? '（GAS 每日更新）' : '（本機回測）';
    html += `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--muted);flex-wrap:wrap">` +
      `<span>冷</span>` +
      `<div style="display:flex;gap:2px">` +
      ['rgba(22,101,52,.50)','rgba(161,98,7,.60)','rgba(194,65,12,.70)','rgba(185,28,28,.80)','rgba(220,38,38,.95)'].map(c =>
        `<div style="width:22px;height:10px;border-radius:2px;background:${c}"></div>`).join('') +
      `</div><span>熱</span>` +
      `<span style="margin-left:6px;opacity:.5">色階依相對百分位　訊號 × min(量比,5)　${src}</span>` +
      `<span style="color:var(--up)">▌ 最新</span>` +
      `</div>`;

    return html;
  }

  // ── 組裝 HTML ─────────────────────────────────────────────────────────
  const sorted = _sortedStats();

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:10px">
      <div class="lab-result-title" style="border:none;padding:0">全策略族群分析</div>
      <div style="display:flex;gap:4px">
        <button class="lab-copy-btn ind-view-btn active" data-view="rank" style="font-size:12px">📊 排行榜</button>
        <button class="lab-copy-btn ind-view-btn" data-view="heat" style="font-size:12px">🔥 輪動熱力圖</button>
      </div>
    </div>

    <div id="indViewRank">
      <div class="lab-table-wrap">
        <table class="lab-table" id="indRankTable">
          <thead><tr>
            <th style="color:var(--muted)">#</th>
            <th style="color:var(--text)">族群</th>
            <th ${_thStyle('wr')}>勝率 ▼</th>
            <th ${_thStyle('ret')}>平均報酬 ⇅</th>
            <th ${_thStyle('cnt')}>訊號數 ⇅</th>
            <th ${_thStyle('stockCount')}>股票數 ⇅</th>
            <th ${_thStyle('avgVolRatio')}>量比 ⇅</th>
            <th ${_thStyle('avgVol')}>均量 ⇅</th>
            <th></th>
          </tr></thead>
          <tbody id="indRankBody">${_renderRows(sorted)}</tbody>
        </table>
      </div>
      <div class="lab-result-hint">點擊欄位標題排序；點擊族群列或「明細」查看個股排行</div>
    </div>

    <div id="indViewHeat" style="display:none">
      <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11px;color:var(--muted);margin-right:4px">粒度：</span>
        ${GRAN_DEFS.map(g =>
          `<button class="lab-copy-btn gran-btn${g.key === 'month' ? ' active' : ''}" data-gran="${g.key}" style="font-size:11px;padding:2px 8px">${g.label}</button>`
        ).join('')}
        <div style="margin-left:auto;position:relative">
          <input id="heatSearchInput" type="text" placeholder="🔍 代號 / 股名" autocomplete="off" spellcheck="false"
            style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:4px 10px;width:170px;outline:none">
          <div id="heatSearchResults" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;min-width:220px;max-height:280px;overflow-y:auto;background:var(--bg2);border:1px solid var(--border);border-radius:6px;z-index:20;box-shadow:0 6px 20px rgba(0,0,0,.45)"></div>
        </div>
      </div>
      <div id="indHeatContent">${_renderHeatmap('month')}</div>
    </div>
  `;

  // Tab 切換
  el.querySelectorAll('.ind-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.ind-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      el.querySelector('#indViewRank').style.display = view === 'rank' ? '' : 'none';
      el.querySelector('#indViewHeat').style.display = view === 'heat' ? '' : 'none';
    });
  });

  // 粒度切換
  el.querySelectorAll('.gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.gran-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const gran = btn.dataset.gran;
      const contentEl = el.querySelector('#indHeatContent');
      if (contentEl) contentEl.innerHTML = _renderHeatmap(gran);
      // 重新綁定格子點擊
      _bindHeatmapCellClick(el.querySelector('#indHeatContent'));
      _bindHeatmapDrag(el.querySelector('#indHeatContent'));
    });
  });

  // ── 個股熱力搜尋 bar ─────────────────────────────────────────────────────
  // 輸入代號/股名 → 過濾 → 選中定位該股所屬族群那一列並高亮
  // （熱力是族群級，個股的熱力狀態 = 看它族群的那排）
  function _focusSector(ind, code) {
    const content = el.querySelector('#indHeatContent');
    if (!content) return;
    let row = null;
    try { row = content.querySelector(`tr[data-hm-row="${CSS.escape(ind)}"]`); } catch (_) {}
    if (!row) row = [...content.querySelectorAll('tr[data-hm-row]')].find(r => r.getAttribute('data-hm-row') === ind);
    if (!row) { dengToast(`${code} 屬「${ind}」，熱力表暫無此族群資料`); return; }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const cells = row.querySelectorAll('td');
    cells.forEach(td => { td.style.transition = 'outline .2s'; td.style.outline = '2px solid var(--up)'; });
    setTimeout(() => cells.forEach(td => { td.style.outline = ''; }), 1800);
  }

  (function _bindHeatSearch() {
    const input = el.querySelector('#heatSearchInput');
    const box   = el.querySelector('#heatSearchResults');
    if (!input || !box) return;

    let _items = null;  // [{ code, name, ind }]
    async function _ensureItems() {
      if (_items) return _items;
      if (!_industryMap) { try { _industryMap = await _loadIndustryMap(); } catch (_) {} }
      _items = Object.keys(_industryMap || {}).map(code => ({
        code, ind: _industryMap[code], name: getChineseName(code) || '',
      }));
      return _items;
    }
    const _hide = () => { box.style.display = 'none'; box.innerHTML = ''; };

    async function _onInput() {
      const q = input.value.trim();
      if (!q) { _hide(); return; }
      const items = await _ensureItems();
      const ql = q.toLowerCase();
      const hits = items.filter(it =>
        it.code.includes(q) || (it.name && it.name.toLowerCase().includes(ql))
      ).slice(0, 10);
      if (!hits.length) {
        box.innerHTML = `<div style="padding:8px 10px;color:var(--muted);font-size:12px">查無「${q}」</div>`;
        box.style.display = 'block';
        return;
      }
      box.innerHTML = hits.map(h =>
        `<div class="heat-search-item" data-code="${h.code}" data-ind="${h.ind}" ` +
        `style="padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border);white-space:nowrap">` +
        `<span style="color:var(--accent);font-weight:600">${h.code}</span> ` +
        `<span style="color:var(--text)">${h.name}</span> ` +
        `<span style="color:var(--muted);font-size:11px">· ${h.ind}</span></div>`
      ).join('');
      box.style.display = 'block';
      box.querySelectorAll('.heat-search-item').forEach(itEl => {
        itEl.addEventListener('mouseenter', () => itEl.style.background = 'rgba(255,255,255,.06)');
        itEl.addEventListener('mouseleave', () => itEl.style.background = '');
        itEl.addEventListener('click', () => {
          _focusSector(itEl.dataset.ind, itEl.dataset.code);
          input.value = `${itEl.dataset.code} ${(itEl.querySelector('span:nth-child(2)')?.textContent || '').trim()}`.trim();
          _hide();
        });
      });
    }

    input.addEventListener('input', _onInput);
    input.addEventListener('focus', () => { if (input.value.trim()) _onInput(); });
    document.addEventListener('click', (e) => {
      if (!box.contains(e.target) && e.target !== input) _hide();
    });
  })();

  // 熱力圖格子點擊 → 開 Modal
  // 熱力圖拖移滾動 + 自訂滑軌
  function _bindHeatmapDrag(container) {
    const wrap  = container?.querySelector('#heatScrollWrap');
    const track = container?.querySelector('#heatScrollTrack');
    const thumb = container?.querySelector('#heatScrollThumb');
    if (!wrap) return;

    // 更新 thumb 位置和寬度
    function _updateThumb() {
      if (!track || !thumb) return;
      const ratio     = wrap.clientWidth / wrap.scrollWidth;
      const thumbW    = Math.max(track.clientWidth * ratio, 40);
      const thumbLeft = (wrap.scrollLeft / (wrap.scrollWidth - wrap.clientWidth)) * (track.clientWidth - thumbW);
      thumb.style.width = thumbW + 'px';
      thumb.style.left  = (thumbLeft || 0) + 'px';
      thumb.style.display = ratio >= 1 ? 'none' : 'block';
    }
    wrap.addEventListener('scroll', _updateThumb);
    setTimeout(_updateThumb, 100); // 等渲染完

    // 滑軌點擊跳轉
    if (track) {
      track.addEventListener('click', e => {
        if (e.target === thumb) return;
        const rect  = track.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / track.clientWidth;
        wrap.scrollLeft = ratio * (wrap.scrollWidth - wrap.clientWidth);
      });
    }

    // Thumb 拖移
    if (thumb) {
      let thumbDrag = false, thumbStartX = 0, thumbScrollStart = 0;
      thumb.addEventListener('mousedown', e => {
        thumbDrag = true;
        thumbStartX = e.clientX;
        thumbScrollStart = wrap.scrollLeft;
        thumb.style.cursor = 'grabbing';
        e.stopPropagation();
      });
      document.addEventListener('mousemove', e => {
        if (!thumbDrag) return;
        const dx    = e.clientX - thumbStartX;
        const ratio = dx / (track.clientWidth - thumb.clientWidth);
        wrap.scrollLeft = thumbScrollStart + ratio * (wrap.scrollWidth - wrap.clientWidth);
      });
      document.addEventListener('mouseup', () => {
        if (thumbDrag) { thumbDrag = false; thumb.style.cursor = 'grab'; }
      });
      thumb.addEventListener('mouseenter', () => { thumb.style.background = 'rgba(255,255,255,.35)'; });
      thumb.addEventListener('mouseleave', () => { if (!thumbDrag) thumb.style.background = 'rgba(255,255,255,.2)'; });
    }

    // 表格本體拖移（滑鼠）
    let isDragging = false, startX = 0, startY = 0, scrollLeft = 0, scrollTop = 0;
    wrap.addEventListener('mousedown', e => {
      if (e.target.closest('.hm-cell')) return;
      isDragging = true;
      wrap.style.cursor = 'grabbing';
      startX = e.pageX - wrap.offsetLeft;
      startY = e.pageY - wrap.offsetTop;
      scrollLeft = wrap.scrollLeft;
      scrollTop  = wrap.scrollTop;
    });
    wrap.addEventListener('mouseleave', () => { isDragging = false; wrap.style.cursor = 'grab'; });
    wrap.addEventListener('mouseup',    () => { isDragging = false; wrap.style.cursor = 'grab'; });
    wrap.addEventListener('mousemove',  e => {
      if (!isDragging) return;
      e.preventDefault();
      wrap.scrollLeft = scrollLeft - (e.pageX - wrap.offsetLeft - startX) * 1.2;
      wrap.scrollTop  = scrollTop  - (e.pageY - wrap.offsetTop  - startY) * 1.2;
    });

    // 觸控
    wrap.addEventListener('touchstart', e => {
      startX = e.touches[0].pageX; startY = e.touches[0].pageY;
      scrollLeft = wrap.scrollLeft; scrollTop = wrap.scrollTop;
    }, { passive: true });
    wrap.addEventListener('touchmove', e => {
      wrap.scrollLeft = scrollLeft - (e.touches[0].pageX - startX);
      wrap.scrollTop  = scrollTop  - (e.touches[0].pageY - startY);
    }, { passive: true });
  }

  function _bindHeatmapCellClick(container) {
    (container || el).querySelectorAll('[data-hm-ind]').forEach(td => {
      td.addEventListener('click', () => _openIndModal(td.dataset.hmInd));
    });
  }
  _bindHeatmapCellClick(el.querySelector('#indHeatContent'));
  _bindHeatmapDrag(el.querySelector('#indHeatContent'));

  // 排行榜排序
  el.querySelectorAll('#indRankTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) _sortAsc = !_sortAsc;
      else { _sortKey = key; _sortAsc = false; }
      _rebuildRank();
    });
  });

  _bindRowClicks();
}


// ── 族群個股 Modal ────────────────────────────────────────────────────────
function _bindIndModal() {
  document.getElementById('labIndModalClose')?.addEventListener('click', _closeIndModal);
  document.getElementById('labIndModalBg')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) _closeIndModal();
  });
}

function _openIndModal(ind) {
  if (!_lastIndustryResult) return;
  const indData = _lastIndustryResult.find(x => x.ind === ind);
  if (!indData) return;

  document.getElementById('labIndModalTitle').textContent = `${ind} — 個股排行`;

  const statsEl = document.getElementById('labIndModalStats');
  statsEl.innerHTML = `
    <div class="lab-modal-kpi-row">
      <div class="lab-modal-kpi"><div class="lab-kpi-label">族群勝率</div><div class="lab-kpi-val" style="color:#ef5350">${indData.wr}%</div></div>
      <div class="lab-modal-kpi"><div class="lab-kpi-label">平均報酬</div><div class="lab-kpi-val" style="color:${indData.ret >= 0 ? '#ef5350' : '#26a69a'}">${indData.ret >= 0 ? '+' : ''}${indData.ret}%</div></div>
      <div class="lab-modal-kpi"><div class="lab-kpi-label">訊號總數</div><div class="lab-kpi-val" style="color:var(--accent)">${indData.cnt}</div></div>
    </div>
  `;

  const HOLD_LABELS_IND  = ['5日','10日','20日','30日','60日','90日','120日'];
  const HOLD_OPTIONS_IND = [5, 10, 20, 30, 60, 90, 120];

  let _sortKey = 'wr';
  let _sortAsc  = false;

  const allStocks = Object.entries(indData.stocks).map(([code, data]) => {
    const sigs  = data.sigs;
    const wins  = sigs.filter(s => s.win).length;
    const wr    = +(wins / sigs.length * 100).toFixed(1);
    const ret   = +(sigs.reduce((s, x) => s + x.ret, 0) / sigs.length).toFixed(2);
    const first = sigs[0]?.date ?? '—';
    const last  = sigs[sigs.length - 1]?.date ?? '—';
    const holdLabel = HOLD_LABELS_IND[HOLD_OPTIONS_IND.indexOf(data.hold)] || data.hold + '日';
    // 量能：訊號觸發時的平均量比
    const sigsWithVol = sigs.filter(s => s.volRatio != null);
    const avgVolRatio = sigsWithVol.length
      ? +(sigsWithVol.reduce((s, x) => s + x.volRatio, 0) / sigsWithVol.length).toFixed(2)
      : null;
    return { code, name: getChineseName(code) || code, wr, ret, cnt: sigs.length, first, last,
      strat: data.strat, stratName: STRATEGIES.find(s => s.id === data.strat)?.name || data.strat,
      hold: holdLabel, avgVol: data.avg60vol ?? 0, avgVolRatio };
  });

  function _sortedStocks() {
    return [...allStocks].sort((a, b) => {
      const v = _sortAsc ? 1 : -1;
      if (_sortKey === 'wr')          return (a.wr - b.wr) * v;
      if (_sortKey === 'ret')         return (a.ret - b.ret) * v;
      if (_sortKey === 'cnt')         return (a.cnt - b.cnt) * v;
      if (_sortKey === 'avgVolRatio') return ((a.avgVolRatio ?? 0) - (b.avgVolRatio ?? 0)) * v;
      if (_sortKey === 'avgVol')      return ((a.avgVol ?? 0) - (b.avgVol ?? 0)) * v;
      if (_sortKey === 'first')       return (a.first || '').localeCompare(b.first || '') * v;
      if (_sortKey === 'last')        return (a.last || '').localeCompare(b.last || '') * v;
      return 0;
    });
  }

  function _thStyle(key) {
    const active = _sortKey === key;
    return `style="cursor:pointer;user-select:none;color:${active ? 'var(--accent)' : 'var(--text)'}" data-msort="${key}"`;
  }

  function _renderModalRows(sorted) {
    return sorted.map(s => {
      const ldColor = (() => {
        if (!s.last || s.last === '—') return 'var(--muted)';
        const days = (Date.now() - new Date(s.last.replace(/\//g,'-')).getTime()) / 86400000;
        return days <= 30 ? '#ef5350' : days <= 90 ? '#f0b429' : 'var(--muted)';
      })();
      return `<tr>
        <td style="color:var(--accent)">${s.code}</td>
        <td style="color:var(--text)">${s.name}</td>
        <td style="color:${s.wr >= 70 ? '#ef5350' : s.wr >= 50 ? '#f0b429' : 'var(--text)'}">${s.wr}%</td>
        <td style="color:${s.ret >= 0 ? '#ef5350' : '#26a69a'}">${s.ret >= 0 ? '+' : ''}${s.ret}%</td>
        <td style="color:var(--text)">${s.cnt}</td>
        <td style="color:var(--accent);font-size:11px;white-space:nowrap">${s.strat} <span style="color:var(--text)">${s.stratName}</span></td>
        <td style="color:var(--muted);font-size:11px;white-space:nowrap">${s.hold}</td>
        <td style="color:${s.avgVolRatio >= 2 ? '#ef5350' : s.avgVolRatio >= 1.3 ? '#f0b429' : 'var(--muted)'};font-size:11px;white-space:nowrap">${s.avgVolRatio != null ? s.avgVolRatio + 'x' : '—'}</td>
        <td style="color:var(--muted);font-size:11px;white-space:nowrap">${s.avgVol > 0 ? s.avgVol.toLocaleString() + '張' : '—'}</td>
        <td style="color:var(--muted);font-size:11px;white-space:nowrap">${s.first}</td>
        <td style="color:${ldColor};font-size:11px;white-space:nowrap">${s.last}</td>
        <td>
          <button class="lab-ind-mc-btn" data-code="${s.code}">MC</button>
          <button class="lab-ind-single-btn" data-code="${s.code}">回測</button>
        </td>
      </tr>`;
    }).join('');
  }

  const bodyEl = document.getElementById('labIndModalBody');

  function _rebuild() {
    const sorted = _sortedStocks();
    bodyEl.querySelector('tbody').innerHTML = _renderModalRows(sorted);
    bodyEl.querySelectorAll('th[data-msort]').forEach(th => {
      const key = th.dataset.msort;
      const active = _sortKey === key;
      th.style.color = active ? 'var(--accent)' : 'var(--text)';
    });
    _bindModalBtns();
  }

  function _bindModalBtns() {
    bodyEl.querySelectorAll('.lab-ind-mc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.code;
        _closeIndModal();
        // 直接填入代號並觸發 MC
        _switchSub('mc');
        const inp = document.getElementById('labMCCodeInput');
        if (inp) inp.value = code;
        const sel = document.getElementById('labMCBarsSelect');
        if (sel) sel.value = '30';
        setTimeout(() => _runMC(), 50);
      });
    });
    bodyEl.querySelectorAll('.lab-ind-single-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _closeIndModal();
        openLabWithCode(btn.dataset.code, 'single');
      });
    });
  }

  // ── 個股熱力圖（全粒度 日/週/月/季/半年/年，沿用族群熱力計算與色階）──────
  const STOCK_GRAN_DEFS = [
    { key: 'day',     label: '日' },
    { key: 'week',    label: '週' },
    { key: 'month',   label: '月' },
    { key: 'quarter', label: '季' },
    { key: 'half',    label: '半年' },
    { key: 'year',    label: '年' },
  ];

  // 訊號日期(YYYY/MM/DD) → 指定粒度的 period key
  function _stockPeriodKey(dateStr, gran) {
    if (!dateStr) return null;
    const s = dateStr.replace(/-/g, '/');
    const [y, mo, d] = s.split('/').map(Number);
    if (!y || !mo) return null;
    if (gran === 'day')     return s.slice(0, 10);
    if (gran === 'month')   return `${y}/${String(mo).padStart(2, '0')}`;
    if (gran === 'quarter') return `${y}/Q${Math.ceil(mo / 3)}`;
    if (gran === 'half')    return `${y}/H${mo <= 6 ? 1 : 2}`;
    if (gran === 'year')    return `${y}`;
    if (gran === 'week') {
      const dt = new Date(Date.UTC(y, mo - 1, d || 1));
      const dayNum = (dt.getUTCDay() + 6) % 7;          // Mon=0
      dt.setUTCDate(dt.getUTCDate() - dayNum + 3);       // 取該週週四
      const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
      const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
      return `${dt.getUTCFullYear()}/W${String(week).padStart(2, '0')}`;
    }
    return s.slice(0, 10);
  }

  // 個股熱力圖狀態（粒度 + 排序 + 模式）
  let _heatGran    = 'month';
  let _heatSortKey = 'latest';   // latest | total | first | last
  let _heatSortAsc = false;
  let _heatMode    = 'signal';   // signal（訊號,紅）| volume（交易量,藍）
  let _volCandles  = null;       // { code: candles[] } 懶載入（從 IDB/bundle）

  // 連續期間軸 + 每期間結束時間（滾動視窗用）；day 維持稀疏避免 244 欄
  function _buildAxis(gran, minDateStr, maxDateStr, sigPeriodSet) {
    const endMs = {};
    if (gran === 'day') {
      [...sigPeriodSet].forEach(k => {
        const d = new Date(k.replace(/\//g, '-'));
        if (!isNaN(d)) endMs[k] = d.getTime() + 86400000 - 1;
      });
      return { periods: [...sigPeriodSet].sort(), endMs };
    }
    const d   = new Date(minDateStr.replace(/\//g, '-'));
    const end = new Date(maxDateStr.replace(/\//g, '-'));
    if (isNaN(d) || isNaN(end)) return { periods: [...sigPeriodSet].sort(), endMs };
    let guard = 0;
    while (d <= end && guard++ < 4000) {
      const k = _stockPeriodKey(`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, gran);
      if (k) endMs[k] = Math.max(endMs[k] || 0, d.getTime() + 86400000 - 1);
      d.setDate(d.getDate() + 1);
    }
    return { periods: Object.keys(endMs).sort(), endMs };
  }

  // 各粒度滾動視窗天數（仿族群「近 N 日」概念，讓訊號暈成連續熱區）
  const _WIN_DAYS = { day: 20, week: 60, month: 120, quarter: 250, half: 365, year: 365 };

  function _renderModalHeatmap() {
    const granKey = _heatGran;

    // 蒐集每檔訊號（時間戳 + 量比）+ 全域日期範圍 + 出現過的 period
    const sigPeriodSet = new Set();
    const sigsByCode   = {};
    let minDate = null, maxDate = null;
    allStocks.forEach(s => {
      const arr = (indData.stocks[s.code]?.sigs ?? []).map(g => {
        const ds = (g.date || '').replace(/-/g, '/').slice(0, 10);
        return { t: new Date(ds.replace(/\//g, '-')).getTime(), vr: g.volRatio, ds };
      }).filter(x => !isNaN(x.t)).sort((a, b) => a.t - b.t);
      sigsByCode[s.code] = arr;
      arr.forEach(x => {
        const p = _stockPeriodKey(x.ds, granKey);
        if (p) sigPeriodSet.add(p);
        if (!minDate || x.ds < minDate) minDate = x.ds;
        if (!maxDate || x.ds > maxDate) maxDate = x.ds;
      });
    });
    if (!sigPeriodSet.size) return '<div style="color:var(--muted);padding:20px">資料不足</div>';

    const { periods, endMs } = _buildAxis(granKey, minDate, maxDate, sigPeriodSet);
    if (!periods.length) return '<div style="color:var(--muted);padding:20px">資料不足</div>';
    const lastPeriod = periods[periods.length - 1];
    const winMs = (_WIN_DAYS[granKey] ?? 120) * 86400000;

    // 滾動視窗：每格 = 近 winDays 內訊號數 × min(均量比,5) → 連續密度場
    const stockMap = {}; // code → { period: { cnt, avgVolRatio, heat } }
    allStocks.forEach(s => {
      const sigs = sigsByCode[s.code];
      stockMap[s.code] = {};
      if (!sigs.length) return;
      periods.forEach(p => {
        const end = endMs[p]; if (!end) return;
        const start = end - winMs;
        let cnt = 0, vrSum = 0, vrCnt = 0;
        for (const g of sigs) {
          if (g.t > start && g.t <= end) { cnt++; if (g.vr != null) { vrSum += g.vr; vrCnt++; } }
        }
        if (cnt > 0) {
          const vr = vrCnt > 0 ? +(vrSum / vrCnt).toFixed(2) : 1;
          stockMap[s.code][p] = { cnt, avgVolRatio: vr, heat: +(cnt * Math.min(vr, 5)).toFixed(1) };
        }
      });
    });

    // 每股活躍區間（首末有值的期間 index）
    const spanOf = {};
    allStocks.forEach(s => {
      const ks = Object.keys(stockMap[s.code]).sort();
      spanOf[s.code] = ks.length ? [periods.indexOf(ks[0]), periods.indexOf(ks[ks.length - 1])] : [-1, -1];
    });

    // ── 排序（升降冪）──
    function _sortVal(code) {
      const cells = stockMap[code];
      const ks = Object.keys(cells).sort();
      if (_heatSortKey === 'total')  return Object.values(cells).reduce((a, c) => a + c.cnt, 0);
      if (_heatSortKey === 'first')  return ks[0] ?? '';
      if (_heatSortKey === 'last')   return ks[ks.length - 1] ?? '';
      return cells[lastPeriod]?.heat ?? 0;  // latest
    }
    const sortedStocks = [...allStocks].sort((a, b) => {
      const va = _sortVal(a.code), vb = _sortVal(b.code);
      const cmp = (typeof va === 'string')
        ? String(va).localeCompare(String(vb))
        : (va - vb);
      return _heatSortAsc ? cmp : -cmp;
    });

    // 相對百分位色階（與族群熱力 _renderHeatTable 同設計）
    const heatVals = sortedStocks
      .flatMap(s => periods.map(p => stockMap[s.code]?.[p]?.heat ?? 0))
      .filter(h => h > 0).sort((a, b) => a - b);
    const p25 = heatVals[Math.floor(heatVals.length * 0.25)] ?? 2;
    const p50 = heatVals[Math.floor(heatVals.length * 0.50)] ?? 5;
    const p75 = heatVals[Math.floor(heatVals.length * 0.75)] ?? 15;
    const p90 = heatVals[Math.floor(heatVals.length * 0.90)] ?? 40;
    function hc(heat) {
      if (!heat) return 'rgba(255,255,255,.03)';
      if (heat >= p90) return 'rgba(220,38,38,.95)';
      if (heat >= p75) return 'rgba(185,28,28,.80)';
      if (heat >= p50) return 'rgba(194,65,12,.70)';
      if (heat >= p25) return 'rgba(161,98,7,.60)';
      return 'rgba(22,101,52,.50)';
    }
    function htc(heat) {
      if (!heat) return 'rgba(156,163,175,.4)';
      if (heat >= p50) return '#fff';
      if (heat >= p25) return '#fde68a';
      return '#86efac';
    }

    let html = `<div style="overflow:auto;max-height:calc(100vh - 340px);border:1px solid var(--border);border-radius:7px">` +
      `<table style="border-collapse:separate;border-spacing:2px;font-size:11px;white-space:nowrap;padding:6px">` +
      `<thead><tr>` +
      `<th style="text-align:right;padding:4px 10px 4px 4px;color:var(--muted);font-weight:400;min-width:96px;position:sticky;left:0;top:0;background:var(--bg2);z-index:3;border-bottom:1px solid var(--border)">個股</th>`;
    periods.forEach(p => {
      const isLast = p === lastPeriod;
      html += `<th style="text-align:center;color:${isLast ? 'var(--up)' : 'var(--muted)'};font-weight:${isLast ? '600' : '400'};min-width:52px;padding:4px 2px;position:sticky;top:0;background:var(--bg2);z-index:2;border-bottom:1px solid var(--border)">${p}</th>`;
    });
    html += `</tr></thead><tbody>`;

    sortedStocks.forEach((s, ri) => {
      const rowBg = ri % 2 === 0 ? 'var(--bg)' : 'var(--bg2)';
      const [fi, li] = spanOf[s.code] ?? [-1, -1];
      html += `<tr>` +
        `<td style="text-align:right;padding:2px 10px 2px 4px;color:var(--accent);font-size:11px;position:sticky;left:0;background:${rowBg};z-index:1;cursor:pointer;white-space:nowrap"` +
        ` onclick="openLabWithCode('${s.code}','single')">${s.code} ${s.name}</td>`;
      periods.forEach((p, pi) => {
        const cell = stockMap[s.code]?.[p];
        if (!cell) {
          // 活躍區間內的空格給淡底色，框出「從何時熱到何時」
          const inSpan = fi >= 0 && pi > fi && pi < li;
          const spanBg = inSpan ? 'background:rgba(239,83,80,.07);' : '';
          const spanBorder = inSpan ? 'border:1px solid rgba(239,83,80,.10)' : 'border:1px dashed rgba(255,255,255,.05)';
          html += `<td style="width:52px;height:30px;border-radius:4px;${spanBg}${spanBorder}"></td>`;
        } else {
          const bg = hc(cell.heat);
          const tc = htc(cell.heat);
          const pulse = cell.heat >= p90 ? 'outline:1px solid rgba(239,83,80,.5);' : '';
          html += `<td class="hm-cell" style="width:52px;height:30px;border-radius:4px;background:${bg};text-align:center;cursor:pointer;vertical-align:middle;${pulse}"` +
            ` title="${s.code} ${s.name} ${p}\n近${_WIN_DAYS[granKey]}日訊號 ${cell.cnt} 筆｜均量比 ${cell.avgVolRatio}x"` +
            ` onclick="openLabWithCode('${s.code}','single')">` +
            `<div style="color:${tc};font-size:11px;font-weight:700;line-height:1.25">${cell.cnt}</div>` +
            `<div style="color:${tc};font-size:10px;opacity:.85;line-height:1.1">${cell.avgVolRatio}x</div>` +
            `</td>`;
        }
      });
      html += `</tr>`;
    });

    const legendColors2 = [
      'rgba(22,101,52,.50)', 'rgba(161,98,7,.60)', 'rgba(194,65,12,.70)',
      'rgba(185,28,28,.80)', 'rgba(220,38,38,.95)',
    ];
    html += `</tbody></table></div>` +
      `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--muted);flex-wrap:wrap">` +
      `<span>冷</span><div style="display:flex;gap:2px">` +
      legendColors2.map((c, i) =>
        `<div style="width:22px;height:10px;border-radius:2px;background:${c}${i === 4 ? ';outline:1px solid rgba(239,83,80,.4)' : ''}"></div>`
      ).join('') +
      `</div><span>熱</span>` +
      `<span style="margin-left:6px;opacity:.5">色階依相對百分位　近${_WIN_DAYS[_heatGran] ?? 120}日滾動訊號 × min(量比,5)　淡框=活躍區間</span>` +
      `<span style="color:var(--up)">▌ 最新</span></div>`;
    return html;
  }

  // 載入該族群每檔 K 線（從 IDB/bundle，量能熱力用）
  async function _ensureVolCandles() {
    if (_volCandles) return _volCandles;
    _volCandles = {};
    await Promise.allSettled(allStocks.map(async s => {
      try {
        const sym = toYahooSymbol(s.code);
        let c = await fetchHistoryCached(sym, '1y', { allowStale: true });
        if (!c || c.length < 20)
          c = await fetchHistoryCached(s.code + '.TWO', '1y', { allowStale: true }).catch(() => null);
        if (c && c.length) _volCandles[s.code] = c;
      } catch (_) {}
    }));
    return _volCandles;
  }

  function _volDateStr(ms) { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; }

  function _volSortVal(cells, lastP) {
    const ks = Object.keys(cells).sort();
    if (_heatSortKey === 'total') return Object.values(cells).reduce((a, c) => a + c, 0);
    if (_heatSortKey === 'first') return ks[0] ?? '';
    if (_heatSortKey === 'last')  return ks[ks.length - 1] ?? '';
    return cells[lastP] ?? 0;  // latest
  }

  // 交易量熱力（單色藍，越藍日均量越大）
  function _renderVolumeHeat() {
    const granKey = _heatGran;
    const codes = Object.keys(_volCandles || {});
    if (!codes.length) return '<div style="color:var(--muted);padding:20px">無 K 線資料（請先確認 bundle 已載入）</div>';

    const map = {};            // code → { period: 日均量(張) }
    const periodSet = new Set();
    codes.forEach(code => {
      map[code] = {};
      const agg = {};
      _volCandles[code].forEach(k => {
        const p = _stockPeriodKey(_volDateStr(k.time * 1000), granKey);
        if (!p) return;
        periodSet.add(p);
        if (!agg[p]) agg[p] = { vs: 0, n: 0 };
        agg[p].vs += (k.volume || 0); agg[p].n++;
      });
      Object.entries(agg).forEach(([p, a]) => { map[code][p] = a.n ? Math.round(a.vs / a.n / 1000) : 0; }); // 張/日均
    });

    let periods = [...periodSet].sort();
    if (granKey === 'day' && periods.length > 90) periods = periods.slice(-90);  // 日粒度只看最近 90 天
    if (!periods.length) return '<div style="color:var(--muted);padding:20px">資料不足</div>';
    const lastPeriod = periods[periods.length - 1];

    // 相對百分位（藍階）
    const vals = codes.flatMap(c => periods.map(p => map[c][p] ?? 0)).filter(v => v > 0).sort((a, b) => a - b);
    const q = f => vals[Math.floor(vals.length * f)] ?? 0;
    const b10 = q(.10), b30 = q(.30), b50 = q(.50), b70 = q(.70), b90 = q(.90);
    function vc(v) {
      if (!v) return 'rgba(255,255,255,.03)';
      if (v >= b90) return '#0b2e5e';
      if (v >= b70) return '#1c4e8f';
      if (v >= b50) return '#3d85c6';
      if (v >= b30) return '#6fa8dc';
      if (v >= b10) return '#9dc3e6';
      return '#cfe0f2';
    }
    function vtc(v) { if (!v) return 'rgba(156,163,175,.4)'; return v >= b50 ? '#fff' : '#0b2e5e'; }
    function fmtV(v) { return v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v; }

    const sorted = [...allStocks].filter(s => map[s.code]).sort((a, b) => {
      const va = _volSortVal(map[a.code], lastPeriod), vb = _volSortVal(map[b.code], lastPeriod);
      const cmp = (typeof va === 'string') ? String(va).localeCompare(String(vb)) : (va - vb);
      return _heatSortAsc ? cmp : -cmp;
    });

    let html = `<div style="overflow:auto;max-height:calc(100vh - 340px);border:1px solid var(--border);border-radius:7px">` +
      `<table style="border-collapse:separate;border-spacing:2px;font-size:11px;white-space:nowrap;padding:6px">` +
      `<thead><tr>` +
      `<th style="text-align:right;padding:4px 10px 4px 4px;color:var(--muted);font-weight:400;min-width:96px;position:sticky;left:0;top:0;background:var(--bg2);z-index:3;border-bottom:1px solid var(--border)">個股</th>`;
    periods.forEach(p => {
      const isLast = p === lastPeriod;
      html += `<th style="text-align:center;color:${isLast ? '#6fa8dc' : 'var(--muted)'};font-weight:${isLast ? '600' : '400'};min-width:52px;padding:4px 2px;position:sticky;top:0;background:var(--bg2);z-index:2;border-bottom:1px solid var(--border)">${p}</th>`;
    });
    html += `</tr></thead><tbody>`;

    sorted.forEach((s, ri) => {
      const rowBg = ri % 2 === 0 ? 'var(--bg)' : 'var(--bg2)';
      html += `<tr>` +
        `<td style="text-align:right;padding:2px 10px 2px 4px;color:var(--accent);font-size:11px;position:sticky;left:0;background:${rowBg};z-index:1;cursor:pointer;white-space:nowrap"` +
        ` onclick="openLabWithCode('${s.code}','single')">${s.code} ${s.name}</td>`;
      periods.forEach(p => {
        const v = map[s.code]?.[p] ?? 0;
        if (!v) {
          html += `<td style="width:52px;height:30px;border-radius:4px;border:1px dashed rgba(255,255,255,.05)"></td>`;
        } else {
          html += `<td style="width:52px;height:30px;border-radius:4px;background:${vc(v)};text-align:center;vertical-align:middle"` +
            ` title="${s.code} ${s.name} ${p}\n日均量 ${v.toLocaleString()} 張">` +
            `<div style="color:${vtc(v)};font-size:10px;font-weight:700;line-height:1.3">${fmtV(v)}</div>` +
            `<div style="color:${vtc(v)};font-size:9px;opacity:.7;line-height:1">張</div>` +
            `</td>`;
        }
      });
      html += `</tr>`;
    });

    const blues = ['#cfe0f2', '#9dc3e6', '#6fa8dc', '#3d85c6', '#1c4e8f', '#0b2e5e'];
    html += `</tbody></table></div>` +
      `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--muted);flex-wrap:wrap">` +
      `<span>量小</span><div style="display:flex;gap:2px">` +
      blues.map(c => `<div style="width:22px;height:10px;border-radius:2px;background:${c}"></div>`).join('') +
      `</div><span>量大</span>` +
      `<span style="margin-left:6px;opacity:.5">色階依相對百分位　每格=該期間日均成交量(張)　越藍量越大</span></div>`;
    return html;
  }

  // 重繪個股熱力內容（粒度/排序/模式變更時呼叫）
  async function _refreshStockHeat() {
    const c = bodyEl.querySelector('#modalHeatContent');
    bodyEl.querySelectorAll('.stock-gran-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.sgran === _heatGran));
    bodyEl.querySelectorAll('.stock-hsort-btn').forEach(b => {
      const on = b.dataset.hsort === _heatSortKey;
      b.classList.toggle('active', on);
      b.textContent = b.dataset.label + (on ? (_heatSortAsc ? ' ▲' : ' ▼') : '');
    });
    bodyEl.querySelectorAll('.stock-mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.smode === _heatMode));
    if (!c) return;
    if (_heatMode === 'volume') {
      c.innerHTML = '<div style="color:var(--muted);padding:20px">載入交易量資料…</div>';
      await _ensureVolCandles();
      c.innerHTML = _renderVolumeHeat();
    } else {
      c.innerHTML = _renderModalHeatmap();
    }
  }

  bodyEl.innerHTML = `
    <div style="display:flex;gap:4px;margin-bottom:10px">
      <button class="lab-copy-btn modal-view-btn active" data-mview="rank" style="font-size:12px">📋 個股排行</button>
      <button class="lab-copy-btn modal-view-btn" data-mview="heat" style="font-size:12px">🔥 個股熱力圖</button>
    </div>

    <div id="modalViewRank">
      <div class="lab-table-wrap">
        <table class="lab-table">
          <thead><tr>
            <th style="color:var(--text)">代號</th>
            <th style="color:var(--text)">名稱</th>
            <th ${_thStyle('wr')}>勝率 ▼</th>
            <th ${_thStyle('ret')}>平均報酬 ⇅</th>
            <th ${_thStyle('cnt')}>訊號數 ⇅</th>
            <th style="color:var(--text)">最佳策略</th>
            <th style="color:var(--text)">最佳持有</th>
            <th ${_thStyle('avgVolRatio')}>量比 ⇅</th>
            <th ${_thStyle('avgVol')}>均量 ⇅</th>
            <th ${_thStyle('first')}>首次觸發 ⇅</th>
            <th ${_thStyle('last')}>近期觸發 ⇅</th>
            <th></th>
          </tr></thead>
          <tbody>${_renderModalRows(_sortedStocks())}</tbody>
        </table>
      </div>
    </div>

    <div id="modalViewHeat" style="display:none">
      <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11px;color:var(--muted);margin-right:4px">觀察：</span>
        <button class="lab-copy-btn stock-mode-btn active" data-smode="signal" style="font-size:11px;padding:2px 10px">🔥 訊號熱力</button>
        <button class="lab-copy-btn stock-mode-btn" data-smode="volume" style="font-size:11px;padding:2px 10px">💧 交易量熱力</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11px;color:var(--muted);margin-right:4px">粒度：</span>
        ${STOCK_GRAN_DEFS.map(g =>
          `<button class="lab-copy-btn stock-gran-btn${g.key === 'month' ? ' active' : ''}" data-sgran="${g.key}" style="font-size:11px;padding:2px 8px">${g.label}</button>`
        ).join('')}
      </div>
      <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11px;color:var(--muted);margin-right:4px">排序：</span>
        ${[['latest','最新'],['total','總量'],['first','首期'],['last','近期']].map(([k,l]) =>
          `<button class="lab-copy-btn stock-hsort-btn${k === 'latest' ? ' active' : ''}" data-hsort="${k}" data-label="${l}" style="font-size:11px;padding:2px 8px">${l}${k === 'latest' ? ' ▼' : ''}</button>`
        ).join('')}
      </div>
      <div id="modalHeatContent">${_renderModalHeatmap()}</div>
    </div>
  `;

  // Tab 切換
  bodyEl.querySelectorAll('.modal-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      bodyEl.querySelectorAll('.modal-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const v = btn.dataset.mview;
      bodyEl.querySelector('#modalViewRank').style.display = v === 'rank' ? '' : 'none';
      bodyEl.querySelector('#modalViewHeat').style.display = v === 'heat' ? '' : 'none';
    });
  });

  // 個股熱力觀察模式切換（訊號 / 交易量）
  bodyEl.querySelectorAll('.stock-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _heatMode = btn.dataset.smode;
      _refreshStockHeat();
    });
  });

  // 個股熱力圖粒度切換
  bodyEl.querySelectorAll('.stock-gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _heatGran = btn.dataset.sgran;
      _refreshStockHeat();
    });
  });

  // 個股熱力圖排序（點同一鍵切升降）
  bodyEl.querySelectorAll('.stock-hsort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.hsort;
      if (_heatSortKey === k) _heatSortAsc = !_heatSortAsc;
      else { _heatSortKey = k; _heatSortAsc = false; }
      _refreshStockHeat();
    });
  });

  bodyEl.querySelectorAll('th[data-msort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.msort;
      if (_sortKey === key) _sortAsc = !_sortAsc;
      else { _sortKey = key; _sortAsc = false; }
      _rebuild();
    });
  });

  _bindModalBtns();
  document.getElementById('labIndModalBg').style.display = '';
}


function _closeIndModal() {
  document.getElementById('labIndModalBg').style.display = 'none';
}

export { _startIndustryBacktest as startIndustryBacktest };
export { _preloadHeatMap as preloadHeatMap };
export { _loadHeatmapBanner as loadHeatmapBanner };
export { _bindIndModal as bindIndModal };
export { _bindIndustryRun as bindIndustryRun };
