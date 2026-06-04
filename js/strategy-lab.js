/**
 * strategy-lab.js
 * 策略實驗室 — 單股回測 / 族群回測 / MC 模擬
 *
 * 對外 API：
 *   initStrategyLab()   ← screener-hub.js lazy init 呼叫
 *   openLabWithCode(code, subPage)  ← 外部跳轉（從族群 modal 點個股 → MC）
 *
 * 權限：
 *   vvvip → 完整功能，無限制
 *   pro   → 單股回測每日 1 次，族群回測每日 1 次，MC 不開放
 *   其他  → 顯示升級提示，不執行
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { CONDITION_DEFS } from './screener.js';
import { STRATEGIES } from './strategy.js';
import { dengToast }       from './loading-deng.js';
import { getIndustryCache, setIndustryCache } from './db.js';

// ── 股名/代號反查 ─────────────────────────────────────────────────────────
// 輸入可能是 "2330"、"台積電"、"台積"，回傳標準代號
function _resolveCode(input) {
  if (!input) return null;
  const s = input.trim();
  // 純數字 → 直接當代號
  if (/^\d{4,6}$/.test(s)) return s;
  // 有包含數字前綴如 "2330台積電" → 取前面的數字
  const m = s.match(/^(\d{4,6})/);
  if (m) return m[1];
  // 股名模糊比對：從 window.__nameCache（Map 結構）反查
  try {
    const cache = window.__nameCache;
    if (cache instanceof Map) {
      // 完全比對
      for (const [code, name] of cache.entries()) {
        if (name === s) return code;
      }
      // 部分比對
      for (const [code, name] of cache.entries()) {
        if (name && (name.includes(s) || s.includes(name))) return code;
      }
    }
  } catch {}
  return s; // fallback 原樣回傳
}

// ── 常數 ──────────────────────────────────────────────────────────────────
const INDUSTRY_MAP_URL = './industry_map.js';   // 動態 import
const HOLD_DAYS_OPTIONS = [5, 10, 20];

// 族群回測：每批 K 線請求並發數（避免 Worker 過載）
const INDUSTRY_BATCH = 15;

// Pro 每日限制次數（存 localStorage）
const PRO_LIMIT_KEY_SINGLE   = 'lab_pro_single_today';
const PRO_LIMIT_KEY_INDUSTRY = 'lab_pro_industry_today';

// ── 狀態 ──────────────────────────────────────────────────────────────────
let _inited        = false;
let _currentSub    = 'single';   // 'single' | 'industry' | 'mc'
let _industryAbort = null;       // AbortController
let _industryMap   = null;       // { code: industry } 懶載入
let _lastIndustryResult = null;  // 族群回測結果，供 modal 使用

// ── 公開入口 ──────────────────────────────────────────────────────────────
export async function initStrategyLab() {
  if (_inited) return;
  _inited = true;

  _bindSubTabs();
  _bindSingleRun();
  _bindIndustryRun();
  _bindMCRun();
  _bindCompareRun();
  _bindIndModal();
  _applyTierUI();
  _switchSub('single');  // 初始顯示單股回測

  // 監聽 tier 變更（登入/登出）
  window.addEventListener('authReady', () => _applyTierUI());
}

/** 外部跳轉：族群回測結果點個股 → 切到 MC 子頁並帶入代號 */
export function openLabWithCode(code, subPage = 'mc') {
  _switchSub(subPage);
  if (subPage === 'mc') {
    const inp = document.getElementById('labMCCodeInput');
    if (inp) inp.value = code;
  } else if (subPage === 'single') {
    const inp = document.getElementById('labCodeInput');
    if (inp) inp.value = code;
  }
}

// ── 子頁切換 ──────────────────────────────────────────────────────────────
function _bindSubTabs() {
  document.querySelectorAll('.lab-sub-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.lab;
      if (sub) _switchSub(sub);
    });
  });
}

function _switchSub(sub) {
  _currentSub = sub;

  document.querySelectorAll('.lab-sub-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lab === sub);
  });

  const panels = { single: 'labPanelSingle', industry: 'labPanelIndustry', mc: 'labPanelMC', compare: 'labPanelCompare' };
  Object.entries(panels).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === sub ? '' : 'none';
  });

  const controls = { single: 'labControlsSingle', industry: 'labControlsIndustry', mc: 'labControlsMC', compare: 'labControlsCompare' };
  Object.entries(controls).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === sub ? '' : 'none';
  });
}

// ── 權限 UI ───────────────────────────────────────────────────────────────
function _applyTierUI() {
  const tier = window.__userTier ?? 'guest';
  const isVVVIP = tier === 'vvvip';
  const isPro   = tier === 'pro';
  const hasAccess = isVVVIP || isPro;

  // 策略實驗室按鈕顯隱（VVVIP + Pro 才看得到）
  const labBtn = document.getElementById('hubBtnLab');
  if (labBtn) labBtn.style.display = hasAccess ? '' : 'none';

  // Pro 限制 banner
  const banner = document.getElementById('labProBanner');
  if (banner) banner.style.display = isPro ? '' : 'none';

  // MC 子頁按鈕：Pro 不開放
  const mcBtn = document.getElementById('labBtnMC');
  if (mcBtn) {
    mcBtn.style.display = isVVVIP ? '' : 'none';
  }

  // Pro 限制：MC run btn 鎖住
  const mcRunBtn = document.getElementById('labRunMC');
  if (mcRunBtn) mcRunBtn.disabled = !isVVVIP;
}

// ── Pro 每日限制計數 ───────────────────────────────────────────────────────
function _checkProLimit(key) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved?.date === today && saved.count >= 1) return false;  // 已達限制
  } catch {}
  return true;
}

function _consumeProLimit(key) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    const count = (saved?.date === today ? saved.count : 0) + 1;
    localStorage.setItem(key, JSON.stringify({ date: today, count }));
  } catch {}
}

// ── 單股回測 ──────────────────────────────────────────────────────────────
function _bindSingleRun() {
  document.getElementById('labRunSingle')?.addEventListener('click', _runSingleBacktest);
  document.getElementById('labCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _runSingleBacktest();
  });
}

async function _runSingleBacktest() {
  const tier = window.__userTier ?? 'guest';
  if (tier !== 'vvvip' && tier !== 'pro') {
    dengToast('策略實驗室需要 Pro 以上會員');
    return;
  }
  if (tier === 'pro' && !_checkProLimit(PRO_LIMIT_KEY_SINGLE)) {
    dengToast('Pro 方案今日單股分析次數已用完');
    return;
  }

  const _singleInput = (document.getElementById('labCodeInput')?.value ?? '').trim();
  const codeRaw = _resolveCode(_singleInput);
  if (!codeRaw) { dengToast('請輸入股票代號或名稱'); return; }

  const HOLD_OPTIONS = [5, 10, 20, 30, 60, 90, 120];
  const HOLD_LABELS  = ['5日','10日','20日','30日','60日','90日','120日'];

  const resultEl   = document.getElementById('labSingleResult');
  const emptyEl    = document.getElementById('labSingleEmpty');
  const runBtn     = document.getElementById('labRunSingle');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressText = document.getElementById('labProgressText');

  if (!resultEl) return;
  runBtn.disabled = true;
  emptyEl.style.display  = 'none';
  resultEl.style.display = 'none';
  progressEl.style.display = '';
  progressBar.style.width = '10%';
  progressText.textContent = `載入 ${codeRaw} K 線...`;

  try {
    const symbol = toYahooSymbol(codeRaw);
    progressBar.style.width = '30%';
    progressText.textContent = '拉取 1 年 K 線...';

    let candles = await fetchHistoryCached(symbol, '1y', { allowStale: false });
    if (!candles || candles.length < 60) {
      candles = await fetchHistoryCached(codeRaw + '.TWO', '1y', { allowStale: false }).catch(() => null);
    }
    if (!candles || candles.length < 60) throw new Error('K 線資料不足（請確認代號正確）');

    progressBar.style.width = '50%';
    progressText.textContent = `計算所有策略（${COMPARE_STRATEGIES.length} 個）× 持有天數...`;
    await new Promise(r => requestAnimationFrame(r));

    // 跟策略比較一樣：全策略 × 全持有天數，取最佳
    const results = [];
    for (const stratId of COMPARE_STRATEGIES) {
      const stratDef = STRATEGIES.find(s => s.id === stratId);
      if (!stratDef) continue;

      const holdData = HOLD_OPTIONS.map(hold => {
        const sigs = _calcStrategySignals(candles, stratId, hold);
        if (!sigs.length) return { wr: 0, ret: 0, score: 0, cnt: 0, firstDate: null, lastDate: null };
        const wins      = sigs.filter(s => s.win).length;
        const wr        = +(wins / sigs.length * 100).toFixed(1);
        const ret       = +(sigs.reduce((s, x) => s + x.ret, 0) / sigs.length).toFixed(2);
        const score     = +(wr * 0.6 + ret * 0.4).toFixed(1);
        const firstDate = sigs[0].date;
        const lastDate  = sigs[sigs.length - 1].date;
        return { wr, ret, score, cnt: sigs.length, firstDate, lastDate };
      });

      let bestIdx = 0;
      holdData.forEach((d, i) => { if (d.score > holdData[bestIdx].score) bestIdx = i; });
      const best = holdData[bestIdx];

      results.push({
        stratId,
        name:      stratDef.name,
        category:  stratDef.category,
        holdData,
        bestIdx,
        cnt:       best.cnt,
        wr:        best.wr,
        ret:       best.ret,
        score:     best.score,
        firstDate: best.firstDate,
        lastDate:  best.lastDate,
      });
    }
    results.sort((a, b) => b.score - a.score);

    progressBar.style.width = '100%';
    await new Promise(r => setTimeout(r, 150));
    progressEl.style.display = 'none';

    const name = getChineseName(codeRaw) || codeRaw;
    // 用策略比較的渲染，傳單股資料
    _renderCompareResult(resultEl, {
      allStockResults: [{ code: codeRaw, name, results }],
      HOLD_OPTIONS,
      HOLD_LABELS,
    });
    resultEl.style.display = '';

    if (tier === 'pro') _consumeProLimit(PRO_LIMIT_KEY_SINGLE);

  } catch (e) {
    progressEl.style.display = 'none';
    emptyEl.style.display    = '';
    dengToast(`分析失敗：${e.message}`);
    console.error('[lab] single backtest error:', e);
  } finally {
    runBtn.disabled = false;
  }
}


// ── 核心比對引擎（使用真實 CONDITION_DEFS + STRATEGIES）────────────────────
// 與 signal-scan.js 的 _matchAllStrategiesAt 相同邏輯
function _matchStrategyAt(sliced, strategyId) {
  if (sliced.length < 20) return false;
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return false;

  // 跳過有 Phase 3 條件的策略（需要 FinMind API）
  const hasPhase3 = strategy.conditions.some(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    return def?.phase === 3;
  });
  if (hasPhase3) return false;

  // 跳過有未實作條件的策略
  const allDefsExist = strategy.conditions.every(c =>
    CONDITION_DEFS.some(d => d.id === c.condId)
  );
  if (!allDefsExist) return false;

  // 重建 twseRow（Phase 1 用）
  const last = sliced[sliced.length - 1];
  const prev = sliced[sliced.length - 2];
  const chgPct = prev?.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
  const twseRow = {
    price:  last.close,
    chgPct: chgPct,
    volume: Math.round((last.volume ?? 0) / 1000),
  };

  const phase1Conds = strategy.conditions.filter(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    return def?.phase === 1;
  });
  const phase2Conds = strategy.conditions.filter(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    return def?.phase === 2;
  });

  // Phase 1 比對
  if (phase1Conds.length > 0) {
    const p1Pass = phase1Conds.every(c => {
      const def = CONDITION_DEFS.find(d => d.id === c.condId);
      const val = c.value ?? def.default;
      try { return def.match(twseRow, val); } catch { return false; }
    });
    if (!p1Pass) return false;
  }

  // Phase 2 計算指標並比對
  const indicators = {};
  const calcDone = new Set();
  for (const c of phase2Conds) {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    if (def?.calc && !calcDone.has(def.id)) {
      try { Object.assign(indicators, def.calc(sliced)); } catch {}
      calcDone.add(def.id);
    }
  }

  return phase2Conds.every(c => {
    const def = CONDITION_DEFS.find(d => d.id === c.condId);
    const val = c.value ?? def.default;
    try { return def.match(indicators, val); } catch { return false; }
  });
}

function _calcStrategySignals(candles, strategyId, holdDays) {
  const signals = [];
  const N = candles.length;
  const minIdx = 60;  // 足夠的暖機根數
  const maxIdx = N - holdDays - 1;

  for (let i = minIdx; i <= maxIdx; i++) {
    const slice = candles.slice(0, i + 1);
    if (_matchStrategyAt(slice, strategyId)) {
      const entry = candles[i].close;
      const exit  = candles[i + holdDays].close;
      const ret   = (exit - entry) / entry * 100;
      signals.push({
        date:  _tsToDate(candles[i].time),
        entry,
        exit,
        ret:   +ret.toFixed(2),
        win:   ret > 0,
      });
    }
  }
  return signals;
}

function _tsToDate(ts) {
  if (!ts) return '—';
  // 字串格式 "2025-08-01" 或 "2025/08/01"
  if (typeof ts === 'string') {
    const s = ts.replace(/-/g, '/').slice(0, 10);
    return s.replace(/\//g, '/');
  }
  // 毫秒時間戳（>1e12）或秒時間戳
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ── 單股回測結果渲染 ──────────────────────────────────────────────────────
function _renderSingleResult(el, { code, name, strategy, holdDays, signals }) {
  if (!signals.length) {
    el.innerHTML = `<div class="lab-empty-state"><p>回測期間內未找到 ${strategy} 訊號</p><p class="hint">K 線資料可能不足，或該策略條件未觸發</p></div>`;
    return;
  }

  const wins    = signals.filter(s => s.win).length;
  const winRate = (wins / signals.length * 100).toFixed(1);
  const avgRet  = (signals.reduce((s, x) => s + x.ret, 0) / signals.length).toFixed(2);
  const maxRet  = Math.max(...signals.map(s => s.ret)).toFixed(2);
  const minRet  = Math.min(...signals.map(s => s.ret)).toFixed(2);
  const retPos  = parseFloat(avgRet) >= 0;

  const rows = signals.slice().reverse().slice(0, 30).map(s => `
    <tr>
      <td style="color:var(--muted)">${s.date}</td>
      <td style="color:var(--up)">${s.entry.toFixed(2)}</td>
      <td style="color:var(--up)">${s.exit.toFixed(2)}</td>
      <td style="color:${s.ret >= 0 ? '#ef5350' : '#26a69a'}">${s.ret >= 0 ? '+' : ''}${s.ret}%</td>
      <td><span class="lab-badge ${s.win ? 'lab-badge-win' : 'lab-badge-loss'}">${s.win ? '獲利' : '虧損'}</span></td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="lab-result-kpi">
      <div class="lab-kpi">
        <div class="lab-kpi-label">訊號次數</div>
        <div class="lab-kpi-val" style="color:var(--accent)">${signals.length}</div>
      </div>
      <div class="lab-kpi">
        <div class="lab-kpi-label">勝率</div>
        <div class="lab-kpi-val" style="color:var(--up)">${winRate}%</div>
      </div>
      <div class="lab-kpi">
        <div class="lab-kpi-label">平均報酬（${holdDays}日）</div>
        <div class="lab-kpi-val" style="color:${retPos ? '#ef5350' : '#26a69a'}">${retPos ? '+' : ''}${avgRet}%</div>
      </div>
      <div class="lab-kpi">
        <div class="lab-kpi-label">最佳報酬 / 最差報酬</div>
        <div class="lab-kpi-val" style="color:var(--muted)">${parseFloat(maxRet)>=0?'+':''}${maxRet}% / ${parseFloat(minRet)>0?'+':''}${minRet}%</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:6px;border-bottom:1px solid var(--border)">
      <div class="lab-result-title" style="border:none;padding:0">${code} ${name} — ${strategy} 近 30 筆訊號明細</div>
      <button class="lab-copy-btn" id="labSingleCopyBtn">⎘ 複製</button>
    </div>
    <div class="lab-table-wrap">
      <table class="lab-table">
        <thead><tr>
          <th>觸發日</th><th>進場價</th><th>出場價（${holdDays}日後）</th><th>報酬</th><th>結果</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="lab-result-hint">顯示最近 30 筆，共 ${signals.length} 筆歷史訊號（1 年 K 線）</div>
  `;

  document.getElementById('labSingleCopyBtn')?.addEventListener('click', () => {
    const header = `${code} ${name} — ${strategy} 回測（持有${holdDays}日）\n勝率 ${winRate}%｜平均報酬 ${retPos?'+':''}${avgRet}%｜訊號數 ${signals.length}\n\n觸發日\t進場價\t出場價\t報酬\t結果\n`;
    const body = signals.slice().reverse().slice(0,30)
      .map(s => `${s.date}\t${s.entry.toFixed(2)}\t${s.exit.toFixed(2)}\t${s.ret>=0?'+':''}${s.ret}%\t${s.win?'獲利':'虧損'}`)
      .join('\n');
    navigator.clipboard.writeText(header + body).then(() => {
      const btn = document.getElementById('labSingleCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => btn.textContent = '⎘ 複製', 2000); }
    });
  });
}
function _bindIndustryRun() {
  document.getElementById('labRunIndustry')?.addEventListener('click', _startIndustryBacktest);
  document.getElementById('labAbortIndustry')?.addEventListener('click', () => {
    _industryAbort?.abort();
    document.getElementById('labAbortIndustry').style.display = 'none';
    document.getElementById('labRunIndustry').style.display  = '';
  });

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
      await _populateSectorChecks(checksEl, countEl);
    }
  });

  closeBtn?.addEventListener('click', () => { settingPanel.style.display = 'none'; });

  document.getElementById('labIndSettingConfirm')?.addEventListener('click', () => {
    settingPanel.style.display = 'none';
  });

  selectAll?.addEventListener('click', () => {
    checksEl.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
    _updateSectorCount(countEl, checksEl);
  });

  selectNone?.addEventListener('click', () => {
    checksEl.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
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
function _getSectorHeatMap() {
  if (!_lastIndustryResult?.length) return {};
  const heatMap = {};
  const now = Date.now();
  const MS30 = 30 * 86400000;

  _lastIndustryResult.forEach(({ ind, stocks }) => {
    let recentCnt = 0, vrSum = 0, vrCnt = 0;
    Object.values(stocks).forEach(data => {
      data.sigs.forEach(sig => {
        const d = new Date(sig.date?.replace(/\//g, '-'));
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

function _heatBadge(heatInfo) {
  if (!heatInfo) return '';
  const { heat, cnt, avgVr } = heatInfo;
  const col = heat >= 10 ? '#991b1b' : heat >= 6 ? '#c2410c' : heat >= 3 ? '#ca8a04' : '#166534';
  const bg  = heat >= 10 ? 'rgba(153,27,27,.15)' : heat >= 6 ? 'rgba(194,65,12,.15)' : heat >= 3 ? 'rgba(202,138,4,.12)' : 'rgba(22,101,52,.12)';
  const label = heat >= 10 ? '🔥 熱' : heat >= 6 ? '↑ 升溫' : heat >= 3 ? '○ 微溫' : '— 冷';
  return `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${bg};color:${col};margin-left:3px" title="近30日訊號${cnt}筆，均量比${avgVr}x">${label}</span>`;
}

async function _populateSectorChecks(checksEl, countEl) {
  if (!checksEl) return;

  if (!_industryMap) {
    checksEl.innerHTML = '<span style="color:var(--muted);font-size:11px">載入族群中...</span>';
    _industryMap = await _loadIndustryMap();
  }

  const heatMap  = _getSectorHeatMap();
  const hasHeat  = Object.keys(heatMap).length > 0;
  const allSectors = [...new Set(Object.values(_industryMap))].sort();

  // 分類快選列（橫排一行）
  const groupBtns = Object.keys(SECTOR_GROUPS).map(g => {
    const inGroup = SECTOR_GROUPS[g].filter(s => allSectors.includes(s));
    const avgHeat = inGroup.length
      ? inGroup.reduce((s, sec) => s + (heatMap[sec]?.heat ?? 0), 0) / inGroup.length : 0;
    const dotCol = avgHeat >= 6 ? '#ef5350' : avgHeat >= 3 ? '#f0b429' : 'var(--muted)';
    return `<button class="lab-copy-btn sector-group-btn" data-group="${g}"
      style="font-size:12px;padding:3px 10px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap">
      <span style="width:7px;height:7px;border-radius:50%;background:${dotCol};flex-shrink:0"></span>${g}
    </button>`;
  }).join('');

  // checkbox（依熱度排序，字體 13px）
  const sortedSectors = [...allSectors].sort((a, b) =>
    (heatMap[b]?.heat ?? 0) - (heatMap[a]?.heat ?? 0));

  const checkboxes = sortedSectors.map(s => {
    const badge = hasHeat ? _heatBadge(heatMap[s]) : '';
    return `<label style="display:flex;align-items:center;gap:5px;font-size:13px;color:var(--text);cursor:pointer;white-space:nowrap;padding:2px 0">
      <input type="checkbox" value="${s}" checked style="accent-color:#ef5350;width:14px;height:14px">${s}${badge}
    </label>`;
  }).join('');

  const warningBanner = !hasHeat ? `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(240,180,41,.08);border:0.5px solid rgba(240,180,41,.3);border-radius:6px;margin-bottom:10px">
      <span style="font-size:16px">⚠️</span>
      <span style="font-size:12px;color:#f0b429">先跑一次<b>全市場掃描</b>，即可顯示各族群近期熱度，協助快速篩選</span>
    </div>` : '';

  checksEl.innerHTML = `
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      ${groupBtns}
    </div>
    ${warningBanner}
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px 10px">
      ${checkboxes}
    </div>`;

  // 分類按鈕點擊 → 勾選該分類
  checksEl.querySelectorAll('.sector-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      const targets = SECTOR_GROUPS[group] ?? [];
      // 判斷目前是否全選 → 切換
      const boxes = checksEl.querySelectorAll('input[type=checkbox]');
      const groupBoxes = [...boxes].filter(cb => targets.includes(cb.value));
      const allChecked = groupBoxes.every(cb => cb.checked);
      groupBoxes.forEach(cb => { cb.checked = !allChecked; });
      _updateSectorCount(countEl, checksEl);
    });
  });

  checksEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => _updateSectorCount(countEl, checksEl));
  });

  _updateSectorCount(countEl, checksEl);
}

async function _startIndustryBacktest() {
  const tier = window.__userTier ?? 'guest';
  if (tier !== 'vvvip' && tier !== 'pro') {
    dengToast('策略實驗室需要 Pro 以上會員');
    return;
  }
  if (tier === 'pro' && !_checkProLimit(PRO_LIMIT_KEY_INDUSTRY)) {
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

    // ── Phase 1：批次並發下載 K 線 ──────────────────────────────────
    progressText.textContent = `Phase 1／2　下載 K 線 0/${total}${checkedSectors.size > 0 ? `（${checkedSectors.size} 族群）` : '（全市場）'}...`;
    const candleMap = new Map();
    let dlDone = 0;

    for (let i = 0; i < total; i += INDUSTRY_BATCH) {
      if (signal.aborted) break;
      const batch = codes.slice(i, i + INDUSTRY_BATCH);

      await Promise.allSettled(batch.map(async code => {
        try {
          const sym = toYahooSymbol(code);
          let c = await fetchHistoryCached(sym, '1y', {});
          if (!c || c.length < 60)
            c = await fetchHistoryCached(code + '.TWO', '1y', {}).catch(() => null);
          if (c && c.length >= 60) candleMap.set(code, c);
        } catch {}
      }));

      dlDone += batch.length;
      const pct = Math.round(dlDone / total * 45);
      progressBar.style.width  = pct + '%';
      progressText.textContent = `Phase 1／2　下載 K 線 ${dlDone}/${total}（${Math.round(dlDone/total*100)}%）...`;
      await new Promise(r => setTimeout(r, 0));
    }

    if (signal.aborted) { emptyEl.style.display = ''; return; }

    // ── Phase 2：Web Worker 計算（並行，不佔主執行緒）────────────────
    const cachedCodes = [...candleMap.keys()];
    const calcTotal   = cachedCodes.length;

    progressBar.style.width  = '45%';
    progressText.textContent = `Phase 2／2　啟動 Worker 計算 ${calcTotal} 支...`;
    await new Promise(r => setTimeout(r, 0));

    const byIndustry = {};
    const allEntries = cachedCodes.map(code => ({ code, candles: candleMap.get(code) }));
    const NUM_SLOW   = Math.min(4, navigator.hardwareConcurrency || 2);
    const chunkSz    = Math.ceil(allEntries.length / NUM_SLOW);
    const chunks     = Array.from({ length: NUM_SLOW }, (_, i) =>
      allEntries.slice(i * chunkSz, (i + 1) * chunkSz)).filter(c => c.length);

    // 全域累計：每次 Worker 回報 progress，加上增量
    const workerPrev = new Array(chunks.length).fill(0); // 記錄各 Worker 上次回報值
    let globalDone   = 0;

    await Promise.all(chunks.map((chunk, wi) => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./industry-slow-worker.js', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'run', payload: { entries: chunk, strategies: COMPARE_STRATEGIES, holdOptions: HOLD_OPTIONS } });
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

    // ── 存入 IndexedDB 快取 ────────────────────────────────────────────
    await setIndustryCache(indStats, cacheKey);

    _lastIndustryResult = indStats;
    _renderIndustryResult(resultEl, { indStats });
    resultEl.style.display = '';

    if (tier === 'pro') _consumeProLimit(PRO_LIMIT_KEY_INDUSTRY);

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
  function _heatColor(heat) {
    if (!heat) return 'transparent';
    if (heat < 1)  return '#1e3a2f';
    if (heat < 3)  return '#166534';
    if (heat < 6)  return '#ca8a04';
    if (heat < 10) return '#c2410c';
    return '#991b1b';
  }
  function _heatTextColor(heat) {
    if (!heat) return 'transparent';
    return heat < 3 ? '#9ca3af' : '#fff';
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
  function _renderHeatmap() {
    const { matrix, months } = _buildHeatMatrix();
    if (!months.length) return '<div style="color:var(--muted);padding:20px">資料不足</div>';

    // 依「最近一個月熱度」排序族群
    const lastMonth = months[months.length - 1];
    const sortedInds = [...indStats]
      .sort((a, b) => (matrix[b.ind]?.[lastMonth]?.heat ?? 0) - (matrix[a.ind]?.[lastMonth]?.heat ?? 0))
      .map(s => s.ind);

    let html = `<div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 200px)">
      <table style="border-collapse:separate;border-spacing:3px;font-size:11px;white-space:nowrap">
        <thead><tr>
          <th style="text-align:right;padding-right:8px;color:var(--muted);font-weight:400;min-width:90px;position:sticky;left:0;background:var(--bg2);z-index:2">族群</th>`;
    months.forEach(m => {
      html += `<th style="text-align:center;color:var(--muted);font-weight:400;min-width:52px;padding:3px 2px">${m.slice(2)}</th>`;
    });
    html += `</tr></thead><tbody>`;

    sortedInds.forEach(ind => {
      html += `<tr><td style="text-align:right;padding-right:8px;color:var(--text);font-size:11px;position:sticky;left:0;background:var(--bg2);z-index:1;white-space:nowrap">${ind}</td>`;
      months.forEach(m => {
        const cell = matrix[ind]?.[m];
        if (!cell) {
          html += `<td style="width:52px;height:30px;border-radius:3px;border:0.5px dashed rgba(255,255,255,.08)"></td>`;
        } else {
          const bg = _heatColor(cell.heat);
          const tc = _heatTextColor(cell.heat);
          const vr = cell.avgVolRatio;
          html += `<td style="width:52px;height:30px;border-radius:3px;background:${bg};text-align:center;cursor:pointer;vertical-align:middle"
            title="${ind} ${m}&#10;訊號 ${cell.cnt} 筆｜均量比 ${vr}x&#10;點擊查看個股"
            data-hm-ind="${ind}" data-hm-month="${m}">
            <div style="color:${tc};font-size:11px;font-weight:600;line-height:1">${cell.cnt}</div>
            <div style="color:${tc};font-size:10px;opacity:.85">${vr}x</div>
          </td>`;
        }
      });
      html += `</tr>`;
    });

    html += `</tbody></table></div>`;

    // 圖例
    html += `<div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--muted)">
      <span>冷</span>
      <div style="display:flex;gap:2px">
        ${['#1e3a2f','#166534','#ca8a04','#c2410c','#991b1b'].map(c =>
          `<div style="width:18px;height:8px;border-radius:2px;background:${c}"></div>`).join('')}
      </div>
      <span>熱</span>
      <span style="margin-left:8px">格子 = 訊號數（上）× 均量比（下）；熱度 = 訊號數 × min(量比,5)</span>
    </div>`;

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
      ${_renderHeatmap()}
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

  // 熱力圖格子點擊 → 開 Modal
  el.querySelectorAll('[data-hm-ind]').forEach(td => {
    td.addEventListener('click', () => _openIndModal(td.dataset.hmInd));
  });

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

  // ── 個股熱力圖 ────────────────────────────────────────────────────────
  function _renderModalHeatmap() {
    const monthSet = new Set();
    const stockMap = {}; // code → { "2026/03": { cnt, avgVolRatio } }

    allStocks.forEach(s => {
      const code = s.code;
      stockMap[code] = {};
      const rawSigs = indData.stocks[code]?.sigs ?? [];
      rawSigs.forEach(sig => {
        const m = sig.date?.slice(0, 7);
        if (!m) return;
        monthSet.add(m);
        if (!stockMap[code][m]) stockMap[code][m] = { cnt: 0, vrSum: 0, vrCnt: 0 };
        stockMap[code][m].cnt++;
        if (sig.volRatio != null) { stockMap[code][m].vrSum += sig.volRatio; stockMap[code][m].vrCnt++; }
      });
      Object.values(stockMap[code]).forEach(cell => {
        cell.avgVolRatio = cell.vrCnt > 0 ? +(cell.vrSum / cell.vrCnt).toFixed(2) : 1;
        cell.heat = +(cell.cnt * Math.min(cell.avgVolRatio, 5)).toFixed(1);
      });
    });

    const months = [...monthSet].sort();
    if (!months.length) return '<div style="color:var(--muted);padding:20px">資料不足</div>';

    const lastMonth = months[months.length - 1];
    const sortedStocks = [...allStocks].sort((a, b) =>
      (stockMap[b.code]?.[lastMonth]?.heat ?? 0) - (stockMap[a.code]?.[lastMonth]?.heat ?? 0));

    function hc(heat) {
      if (!heat) return 'transparent';
      if (heat < 1) return '#1e3a2f';
      if (heat < 3) return '#166534';
      if (heat < 6) return '#ca8a04';
      if (heat < 10) return '#c2410c';
      return '#991b1b';
    }
    function htc(heat) { return (!heat || heat < 3) ? '#9ca3af' : '#fff'; }

    let html = `<div style="overflow-x:auto">
      <table style="border-collapse:separate;border-spacing:3px;font-size:11px;white-space:nowrap">
        <thead><tr>
          <th style="text-align:right;padding-right:8px;color:var(--muted);font-weight:400;min-width:70px;position:sticky;left:0;background:#1c2128;z-index:2">個股</th>`;
    months.forEach(m => {
      html += `<th style="text-align:center;color:var(--muted);font-weight:400;min-width:52px;padding:3px 2px">${m.slice(2)}</th>`;
    });
    html += `</tr></thead><tbody>`;

    sortedStocks.forEach(s => {
      html += `<tr>
        <td style="text-align:right;padding-right:8px;color:var(--accent);font-size:11px;position:sticky;left:0;background:#1c2128;z-index:1;cursor:pointer"
          onclick="openLabWithCode('${s.code}','single')">${s.code} ${s.name}</td>`;
      months.forEach(m => {
        const cell = stockMap[s.code]?.[m];
        if (!cell) {
          html += `<td style="width:52px;height:30px;border-radius:3px;border:0.5px dashed rgba(255,255,255,.08)"></td>`;
        } else {
          const bg = hc(cell.heat);
          const tc = htc(cell.heat);
          html += `<td style="width:52px;height:30px;border-radius:3px;background:${bg};text-align:center;cursor:pointer;vertical-align:middle"
            title="${s.code} ${s.name} ${m}&#10;訊號 ${cell.cnt} 筆｜量比 ${cell.avgVolRatio}x"
            onclick="openLabWithCode('${s.code}','single')">
            <div style="color:${tc};font-size:11px;font-weight:600;line-height:1">${cell.cnt}</div>
            <div style="color:${tc};font-size:10px;opacity:.85">${cell.avgVolRatio}x</div>
          </td>`;
        }
      });
      html += `</tr>`;
    });

    html += `</tbody></table></div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--muted)">
      <span>冷</span>
      <div style="display:flex;gap:2px">
        ${['#1e3a2f','#166534','#ca8a04','#c2410c','#991b1b'].map(c =>
          `<div style="width:18px;height:8px;border-radius:2px;background:${c}"></div>`).join('')}
      </div>
      <span>熱</span>
    </div>`;
    return html;
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
      ${_renderModalHeatmap()}
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

// ── MC 模擬（搬遷自 monte-carlo.js）──────────────────────────────────────
function _bindMCRun() {
  document.getElementById('labRunMC')?.addEventListener('click', _runMC);
  document.getElementById('labMCCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _runMC();
  });
}

async function _runMC() {
  if (window.__userTier !== 'vvvip') {
    dengToast('MC 模擬為 VVVIP 限定功能');
    return;
  }

  const _mcInput = (document.getElementById('labMCCodeInput')?.value ?? '').trim();
  const codeRaw = _resolveCode(_mcInput);
  const simBars = parseInt(document.getElementById('labMCBarsSelect')?.value ?? '10');

  if (!codeRaw) { dengToast('請輸入股票代號或名稱'); return; }

  const resultEl   = document.getElementById('labMCResult');
  const emptyEl    = document.getElementById('labMCEmpty');
  const runBtn     = document.getElementById('labRunMC');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressText = document.getElementById('labProgressText');

  runBtn.disabled = true;
  emptyEl.style.display  = 'none';
  resultEl.style.display = 'none';
  progressEl.style.display = '';
  progressBar.style.width  = '15%';
  progressText.textContent = `載入 ${codeRaw} K 線...`;

  try {
    const symbol = toYahooSymbol(codeRaw);
    progressBar.style.width  = '40%';
    progressText.textContent = '拉取 1 年 K 線...';

    let candles = await fetchHistoryCached(symbol, '1y', { allowStale: false });
    if (!candles || candles.length < 30) {
      candles = await fetchHistoryCached(codeRaw + '.TWO', '1y', { allowStale: false }).catch(() => null);
    }
    if (!candles || candles.length < 30) throw new Error('K 線資料不足');

    progressBar.style.width  = '65%';
    progressText.textContent = `執行 500 條路徑 MC 模擬...`;

    await new Promise(r => requestAnimationFrame(r));

    // 動態 import mc-backtest 核心公式
    const { runMcBacktest } = await import('./mc-backtest.js');
    const { computeForecastCenter } = await import('./monte-carlo.js');
    const result = runMcBacktest(candles, { withPattern: false });

    // 用最新 K 線跑一次預測，取得當前方向和幅度
    const forecast = computeForecastCenter(candles, 20, { withPattern: false });

    progressBar.style.width  = '100%';
    progressText.textContent = '完成';

    await new Promise(r => setTimeout(r, 200));
    progressEl.style.display = 'none';

    const name = getChineseName(codeRaw) || codeRaw;
    _renderMCResult(resultEl, { code: codeRaw, name, simBars, candles, result, forecast });
    resultEl.style.display = '';

  } catch (e) {
    progressEl.style.display = 'none';
    emptyEl.style.display    = '';
    dengToast(`MC 模擬失敗：${e.message}`);
    console.error('[lab] MC error:', e);
  } finally {
    runBtn.disabled = false;
  }
}

function _renderMCResult(el, { code, name, simBars, result, forecast }) {
  if (!result?.ok) {
    el.innerHTML = `<div class="lab-empty-state"><p>MC 模擬失敗：${result?.reason ?? '未知錯誤'}</p></div>`;
    return;
  }

  // 命中率 → 色階（50%=基準，低於50%=深綠最差，65%+=紅最精準）
  function _rateToColor(rate) {
    // 低於 50% 直接深綠（比隨機差），50%~65% 漸層，65%+ 紅
    const t = rate < 0.50
      ? Math.max(0, rate / 0.50) * 0.15   // 0~50% 壓縮到色階 0~0.15（深綠區）
      : Math.min(1, 0.15 + (rate - 0.50) / (0.65 - 0.50) * 0.85); // 50%~65%+ 映射到 0.15~1
    const stops = [[15,110,86],[38,166,154],[240,180,41],[230,100,20],[210,35,35]];
    const seg = t * (stops.length - 1);
    const i = Math.min(Math.floor(seg), stops.length - 2);
    const f = seg - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i+1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function _textOnRate(rate) {
    const t = rate < 0.50
      ? Math.max(0, rate / 0.50) * 0.15
      : Math.min(1, 0.15 + (rate - 0.50) / (0.65 - 0.50) * 0.85);
    return (t > 0.25 && t < 0.70) ? '#1a1a1a' : '#fff';
  }

  // ── 當前預測方向和幅度 ──────────────────────────────────────────
  const curPrice = forecast?.startPrice ?? 0;
  const predRows = forecast ? [5, 10, 15, 20].map(N => {
    const predPrice = forecast.prices?.[N];
    if (!predPrice || !curPrice) return null;
    const chgPct = (predPrice - curPrice) / curPrice * 100;
    const isUp   = chgPct >= 0;
    const col    = isUp ? '#ef5350' : '#26a69a';
    const arrow  = isUp ? '▲' : '▼';
    return { N, predPrice, chgPct, col, arrow };
  }).filter(Boolean) : [];

  const predHTML = predRows.length ? `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      ${predRows.map(r => `
        <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:6px;padding:8px 10px;text-align:center">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${r.N} 日後預測</div>
          <div style="font-size:14px;font-weight:500;color:${r.col}">${r.arrow} ${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(1)}%</div>
          <div style="font-size:11px;color:var(--muted)">→ $${r.predPrice.toFixed(2)}</div>
        </div>`).join('')}
    </div>` : '';

  // ── 色塊準確率矩陣 ───────────────────────────────────────────────
  const horizons = result.horizons;
  const NS = [5, 10, 15, 20];
  const colHeaders = ['方向命中率', '完整命中率', 'MAE（越低越好）'];

  // MAE 的色階反轉：mae 小 = 紅（精準），mae 大 = 綠（不準）
  function _maeToColor(mae) {
    const t = Math.max(0, Math.min(1, 1 - (mae - 0.02) / (0.12 - 0.02)));
    const stops = [[15,110,86],[38,166,154],[240,180,41],[230,100,20],[210,35,35]];
    const seg = t * (stops.length - 1);
    const i = Math.min(Math.floor(seg), stops.length - 2);
    const f = seg - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i+1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  const matrixRows = NS.map(N => {
    const h = horizons[N];
    if (!h || h.total === 0) return `
      <tr>
        <td style="color:var(--text);font-weight:500">${N} 日後</td>
        <td colspan="3" style="color:var(--muted);text-align:center">資料不足</td>
      </tr>`;
    const dirBg  = _rateToColor(h.dirRate);
    const dirTc  = _textOnRate(h.dirRate);
    const hitBg  = _rateToColor(h.hitRate);
    const hitTc  = _textOnRate(h.hitRate);
    const maeBg  = _maeToColor(h.mae);
    const maeTc  = _textOnRate(1 - (h.mae - 0.02) / 0.10);
    return `<tr>
      <td style="color:var(--text);font-weight:500;padding:4px 8px">${N} 日後</td>
      <td style="padding:3px">
        <div style="background:${dirBg};border-radius:4px;padding:8px 10px;text-align:center" title="${h.dirHit}/${h.total} 次方向正確">
          <div style="font-size:14px;font-weight:600;color:${dirTc}">${(h.dirRate*100).toFixed(0)}%</div>
        </div>
      </td>
      <td style="padding:3px">
        <div style="background:${hitBg};border-radius:4px;padding:8px 10px;text-align:center" title="${h.hit}/${h.total} 次完整命中（方向對且誤差<5%）">
          <div style="font-size:14px;font-weight:600;color:${hitTc}">${(h.hitRate*100).toFixed(0)}%</div>
        </div>
      </td>
      <td style="padding:3px">
        <div style="background:${maeBg};border-radius:4px;padding:6px 10px;text-align:center">
          <div style="font-size:13px;font-weight:600;color:${maeTc}">${(h.mae*100).toFixed(1)}%</div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // 圖例
  const legendStops = [0,0.167,0.333,0.5,0.667,0.833,1].map(t => {
    const s = [5,10,15,20][0];
    const r = 0.48 + t * (0.68 - 0.48);
    return `<div style="flex:1;height:6px;background:${_rateToColor(r)}"></div>`;
  }).join('');

  // ── 五種操作模式建議 ─────────────────────────────────────────────
  const modeHTML = _mcModeAdvice(result, forecast);

  // ── 複製文字 ──────────────────────────────────────────────────────
  const copyText = [
    `${code} ${name} — MC 模擬回測結果`,
    `${result.formula} · ${result.samples} 樣本 · 現價 ${curPrice ? '$' + curPrice.toFixed(2) : '—'}`,
    '',
    '預測漲跌幅：',
    ...predRows.map(r => `  ${r.N}日後：${r.arrow} ${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(1)}% → $${r.predPrice.toFixed(2)}`),
    '',
    '歷史回測準確率：',
    '時間\t方向命中率\t完整命中率\tMAE',
    ...NS.map(N => {
      const h = horizons[N];
      if (!h || h.total === 0) return `${N}日後\t資料不足`;
      return `${N}日後\t${(h.dirRate*100).toFixed(0)}% (${h.dirHit}/${h.total})\t${(h.hitRate*100).toFixed(0)}% (${h.hit}/${h.total})\t${(h.mae*100).toFixed(2)}%`;
    }),
  ].join('\n');

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px">
      <div>
        <div class="lab-result-title" style="border:none;padding:0">${code} ${name} — MC 模擬回測結果</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${result.formula} · ${result.samples} 樣本 · 現價 ${curPrice ? '$' + curPrice.toFixed(2) : '—'}</div>
      </div>
      <button class="lab-copy-btn" id="labMCCopyBtn">⎘ 複製</button>
    </div>
    ${predHTML}
    <div style="font-size:12px;font-weight:500;color:var(--text);margin-bottom:6px">歷史回測準確率</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="padding:4px 8px;text-align:left;color:var(--muted);font-weight:400;white-space:nowrap">時間</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted);font-weight:400">方向命中率</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted);font-weight:400">完整命中率</th>
          <th style="padding:4px 8px;text-align:center;color:var(--muted);font-weight:400">MAE 誤差</th>
        </tr></thead>
        <tbody>${matrixRows}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:6px;margin-bottom:14px;font-size:10px;color:var(--muted)">
      <span>弱</span>
      <div style="display:flex;flex:1;height:6px;border-radius:3px;overflow:hidden">${legendStops}</div>
      <span>強</span>
      <span style="margin-left:4px">命中率強度（&lt;50%=差，≥65%=優）</span>
    </div>
    ${modeHTML}
    <div class="lab-result-hint">方向命中率 ≥ 60% 才具顯著預測力；50% 等同隨機。預測為 MC 中線，非保證。</div>
  `;

  document.getElementById('labMCCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(copyText).then(() => {
      const btn = document.getElementById('labMCCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => btn.textContent = '⎘ 複製', 2000); }
    });
  });
}

// ── 操作模式建議 ──────────────────────────────────────────────────────────
function _mcModeAdvice(result, forecast) {
  const h5  = result.horizons[5]  || {};
  const h10 = result.horizons[10] || {};
  const h15 = result.horizons[15] || {};
  const h20 = result.horizons[20] || {};

  const dir5  = h5.dirRate  || 0;
  const dir10 = h10.dirRate || 0;
  const dir15 = h15.dirRate || 0;
  const dir20 = h20.dirRate || 0;
  const mae5  = h5.mae  || 0.99;
  const mae10 = h10.mae || 0.99;
  const mae15 = h15.mae || 0.99;
  const mae20 = h20.mae || 0.99;

  const regime  = forecast?.diag?.regime ?? 'mid';
  const stdDev  = forecast?.stdDev ?? 0.02;
  const annualV = stdDev * Math.sqrt(252) * 100;

  const pred5chg = forecast?.prices?.[5] && forecast?.startPrice
    ? (forecast.prices[5] - forecast.startPrice) / forecast.startPrice * 100
    : null;
  const pred20chg = forecast?.prices?.[20] && forecast?.startPrice
    ? (forecast.prices[20] - forecast.startPrice) / forecast.startPrice * 100
    : null;
  const predUp = pred5chg !== null ? pred5chg >= 0 : null;

  // 找最佳命中率窗口
  const dirMap = { 5: dir5, 10: dir10, 15: dir15, 20: dir20 };
  const bestN   = Object.entries(dirMap).sort((a,b) => b[1]-a[1])[0];
  const bestDir = bestN[1];
  const bestDay = +bestN[0];

  // 趨勢是否隨持有天數遞增（長線型）
  const isLongTrend = dir20 >= dir10 && dir10 >= dir5 && dir20 >= 0.58;
  // 中期節奏：10或15日最高且 ≥ 60%，20日反而下降
  const isMidRhythm = (bestDay === 10 || bestDay === 15) && bestDir >= 0.60 && dir20 < bestDir - 0.05;
  // 短線最強：5日命中率最高且高於其他
  const isShortBest = bestDay === 5 && dir5 >= 0.60 && dir5 > dir20 + 0.03;

  const MODES = [
    {
      name: '短線突破',
      icon: '⚡',
      condition: (isShortBest || (dir5 >= 0.60 && mae5 < 0.08)) && predUp === true,
      holdRange: '3~5 日',
      entry: 'X6 見龍在田、X2 天黑請閉眼、S5 爆量異動',
      exit: 'W6 RSI超買、W14 MACD高位死叉、X2訊號消失',
      reason: `5日命中率 ${(dir5*100).toFixed(0)}% 最強，MAE ${(mae5*100).toFixed(1)}%，短線預測${predUp?'偏多':'偏空'}`,
    },
    {
      name: '中期節奏型',
      icon: '🎯',
      condition: isMidRhythm,
      holdRange: `${bestDay} 日為主`,
      entry: 'S2 均線啟動、S31 DMI趨勢確認、S33 GMMA多頭排列',
      exit: `持有 ${bestDay} 日後主動出場，不等訊號，超過後趨勢易轉`,
      reason: `${bestDay}日命中率 ${(bestDir*100).toFixed(0)}% 最佳，20日（${(dir20*100).toFixed(0)}%）反而下降`,
    },
    {
      name: '波段持有',
      icon: '📈',
      condition: isLongTrend && !isMidRhythm,
      holdRange: '15~20 日',
      entry: 'S33 GMMA多頭排列、S_ICHI_CLOUD 雲帶上行、S4 近期創高',
      exit: 'W12 均線空頭排列、W3 MACD死叉跌破月線、跌破MA20',
      reason: `命中率隨時間遞增（5日${(dir5*100).toFixed(0)}%→20日${(dir20*100).toFixed(0)}%），趨勢延伸性強`,
    },
    {
      name: '超跌反彈',
      icon: '🔄',
      condition: (regime === 'superlow' || regime === 'low') && bestDir >= 0.55 && predUp === true,
      holdRange: '5~10 日',
      entry: 'S6 超賣反彈、S35 乖離超跌、S7 低檔翻多、S9 跌深量縮',
      exit: '反彈至MA20壓力、W6 RSI超買、達到目標漲幅後了結',
      reason: `Regime: ${regime}，超跌反彈行情，最佳${bestDay}日命中率 ${(bestDir*100).toFixed(0)}%`,
    },
    {
      name: '區間震盪',
      icon: '↔️',
      condition: bestDir < 0.55 && annualV < 45,
      holdRange: '輕倉等訊號',
      entry: 'S13 箱型突破、S14 強勢鈍化確認方向後輕倉進場',
      exit: '突破失敗立即停損，以箱頂/箱底為停損參考點',
      reason: `最高命中率僅 ${(bestDir*100).toFixed(0)}%（${bestDay}日），年化波動 ${annualV.toFixed(0)}%，建議輕倉`,
    },
    {
      name: '高波動觀望',
      icon: '⚠️',
      condition: annualV >= 60 || mae20 >= 0.15,
      holdRange: '輕倉短線為主',
      entry: `⚠️ 風險警示：S5 爆量異動、X6 見龍在田（輕倉，嚴設停損）`,
      exit: `觸及停損立即出場，MAE ${(mae20*100).toFixed(1)}% 代表誤差範圍大，建議停損設 3~5%`,
      reason: `年化波動 ${annualV.toFixed(0)}%，20日MAE ${(mae20*100).toFixed(1)}%，模型誤差偏高，操作需控制倉位`,
    },
  ];

  // 若無條件匹配，加中性觀察
  if (!MODES.some(m => m.condition)) {
    MODES.push({
      name: '中性觀察',
      icon: '🔍',
      condition: true,
      holdRange: '等待訊號',
      entry: 'S12 量增底部、XG1 葛蘭碧買一強化、S_ICHI_TK_CROSS TK黃金交叉',
      exit: '進場後以MA20為參考停損，命中率中等需嚴控部位',
      reason: '命中率中等，無明確強勢模式，可輕倉佈局等待訊號確認',
    });
  }

  const rows = MODES.map(m => {
    const isMatch = m.condition;
    const rowBg   = isMatch ? 'background:rgba(239,83,80,.08);' : 'opacity:0.55;';
    const nameCol = isMatch ? '#ef5350' : 'var(--muted)';
    const textCol = isMatch ? 'var(--text)' : 'var(--muted)';
    const badge   = isMatch
      ? `<span style="font-size:10px;background:rgba(239,83,80,.15);color:#ef5350;padding:1px 6px;border-radius:10px;margin-left:5px">符合</span>`
      : '';
    return `<tr style="${rowBg}">
      <td style="padding:7px 8px;white-space:nowrap;color:${nameCol};font-weight:${isMatch?'600':'400'};font-size:13px">${m.icon} ${m.name}${badge}</td>
      <td style="padding:7px 8px;color:${textCol};font-size:12px;white-space:nowrap;font-weight:${isMatch?'500':'400'}">${m.holdRange}</td>
      <td style="padding:7px 8px;color:${isMatch?'#ff9800':'var(--muted)'};font-size:12px;font-weight:${isMatch?'500':'400'}">${m.entry}</td>
      <td style="padding:7px 8px;color:${isMatch?'#4dd0e1':'var(--muted)'};font-size:12px;font-weight:${isMatch?'500':'400'}">${m.exit}</td>
      <td style="padding:7px 8px;color:${isMatch?'var(--text)':'var(--muted)'};font-size:12px">${m.reason}</td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-top:14px">
      <div style="font-size:12px;font-weight:500;color:var(--text);margin-bottom:8px">操作模式建議（符合條件以紅色標示）</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px;border:0.5px solid var(--border);border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:var(--bg2)">
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;white-space:nowrap;font-size:12px">模式</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;white-space:nowrap;font-size:12px">建議持有</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;font-size:12px">進場策略</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;font-size:12px">出場策略</th>
              <th style="padding:6px 8px;text-align:left;color:var(--text);font-weight:600;font-size:12px">判斷依據</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── 策略比較 ──────────────────────────────────────────────────────────────
// 所有可回測策略（排除 W 系列避險警示、S24~S27 巴菲特需基本面資料）
const COMPARE_STRATEGIES = [
  // X 系列（妖股/特化）
  'X1','X2','X3','X4','X5','X6',
  // XG 系列（葛蘭碧特化）
  'XG1','XG3',
  // 強勢續漲
  'S1','S2','S3','S_STRONG','S4','S5',
  // 超跌反彈
  'S6','S7','S8','S9',
  // 轉折訊號
  'S10','S11','S12',
  // 葛蘭碧
  'S20','S21','S22','S23',
  // 盤整突破
  'S13','S14','S15',
  // 基本面（phase3 會自動跳過）
  'S16','S17','S18','S19',
  // 巴菲特（phase3 會自動跳過）
  'S24','S25','S26','S27',
  // 技術指標
  'S29','S30','S31','S32','S33','S34','S35','S36',
  // 一目均衡
  'S_ICHI_3GOOD','S_ICHI_CLOUD','S_ICHI_TK_CROSS',
  // K線型態
  'S37','S38','S40','S42','S45',
];

function _bindCompareRun() {
  document.getElementById('labRunCompare')?.addEventListener('click', _runCompare);
  document.getElementById('labCompareCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _runCompare();
  });
}

async function _runCompare() {
  const tier = window.__userTier ?? 'guest';
  if (tier !== 'vvvip' && tier !== 'pro') { dengToast('策略實驗室需要 Pro 以上會員'); return; }

  const rawInput = (document.getElementById('labCompareCodeInput')?.value ?? '').trim();
  if (!rawInput) { dengToast('請輸入股票代號'); return; }
  const codes = rawInput.split(/[\s,，]+/).filter(Boolean).slice(0, 5).map(_resolveCode).filter(Boolean);

  const resultEl    = document.getElementById('labCompareResult');
  const emptyEl     = document.getElementById('labCompareEmpty');
  const runBtn      = document.getElementById('labRunCompare');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressText = document.getElementById('labProgressText');

  runBtn.disabled = true;
  emptyEl.style.display  = 'none';
  resultEl.style.display = 'none';
  progressEl.style.display = '';

  // 1年220根，持有最多120日
  const HOLD_OPTIONS  = [5, 10, 20, 30, 60, 90, 120];
  const HOLD_LABELS   = ['5日','10日','20日','30日','60日','90日','120日'];

  try {
    const allStockResults = [];

    for (let ci = 0; ci < codes.length; ci++) {
      const code = codes[ci];
      progressBar.style.width  = `${Math.round((ci / codes.length) * 70 + 5)}%`;
      progressText.textContent = `載入 ${code} K 線... (${ci+1}/${codes.length})`;

      const symbol = toYahooSymbol(code);
      let candles  = await fetchHistoryCached(symbol, '1y', { allowStale: false });
      if (!candles || candles.length < 60) {
        candles = await fetchHistoryCached(code + '.TWO', '1y', { allowStale: false }).catch(() => null);
      }
      if (!candles || candles.length < 60) {
        allStockResults.push({ code, name: getChineseName(code) || code, error: 'K 線資料不足' });
        continue;
      }

      progressText.textContent = `計算 ${code} 所有策略 × ${HOLD_OPTIONS.length} 種持有天數...`;
      await new Promise(r => requestAnimationFrame(r));

      // 每個策略跑所有持有天數
      const results = [];
      for (const stratId of COMPARE_STRATEGIES) {
        const stratDef = STRATEGIES.find(s => s.id === stratId);
        if (!stratDef) continue;

        const holdData = HOLD_OPTIONS.map(hold => {
          const sigs = _calcStrategySignals(candles, stratId, hold);
          if (!sigs.length) return { wr: 0, ret: 0, score: 0, cnt: 0, firstDate: null, lastDate: null };
          const wins   = sigs.filter(s => s.win).length;
          const wr     = +(wins / sigs.length * 100).toFixed(1);
          const ret    = +(sigs.reduce((s, x) => s + x.ret, 0) / sigs.length).toFixed(2);
          const score  = +(wr * 0.6 + ret * 0.4).toFixed(1);
          const firstDate = sigs[0].date;
          const lastDate  = sigs[sigs.length - 1].date;
          return { wr, ret, score, cnt: sigs.length, firstDate, lastDate };
        });

        // 最佳持有天數（最高 score）
        let bestIdx = 0;
        holdData.forEach((d, i) => { if (d.score > holdData[bestIdx].score) bestIdx = i; });
        const best = holdData[bestIdx];

        results.push({
          stratId,
          name:      stratDef.name,
          category:  stratDef.category,
          holdData,
          bestIdx,
          cnt:       best.cnt,
          wr:        best.wr,
          ret:       best.ret,
          score:     best.score,
          firstDate: best.firstDate,
          lastDate:  best.lastDate,
        });
      }

      // 依最佳 score 排序
      results.sort((a, b) => b.score - a.score);
      allStockResults.push({ code, name: getChineseName(code) || code, results });
    }

    progressBar.style.width  = '100%';
    await new Promise(r => setTimeout(r, 100));
    progressEl.style.display = 'none';

    _renderCompareResult(resultEl, { allStockResults, HOLD_OPTIONS, HOLD_LABELS });
    resultEl.style.display = '';

  } catch (e) {
    progressEl.style.display = 'none';
    emptyEl.style.display    = '';
    dengToast(`策略比較失敗：${e.message}`);
    console.error('[lab] compare error:', e);
  } finally {
    runBtn.disabled = false;
  }
}

// ── 色階：綠→淺綠→黃→橙→紅 ─────────────────────────────────────────────
function _scoreToColor(t) {
  const stops = [
    [15,110,86],    // 深綠
    [38,166,154],   // 中綠
    [240,180,41],   // 黃
    [230,100,20],   // 深橙
    [210,35,35],    // 深紅
  ];
  t = Math.max(0, Math.min(1, t));
  const seg = t * (stops.length - 1);
  const i   = Math.min(Math.floor(seg), stops.length - 2);
  const f   = seg - i;
  const c   = stops[i].map((v, k) => Math.round(v + (stops[i+1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function _textOnScore(t) {
  // t: 0=深綠, 0.25=中綠, 0.5=黃, 0.75=橙, 1=深紅
  // 黃/淺橙段（0.4~0.65）用深色字，其餘用白字
  if (t >= 0.35 && t <= 0.65) return '#1a1a1a';
  return '#fff';
}

// ── 股性標籤 ──────────────────────────────────────────────────────────────
function _stockBadge(results) {
  const valid = results.filter(r => r.cnt > 0);
  if (!valid.length) return { label: '資料不足', bg: 'rgba(100,100,100,.1)', color: '#888', border: 'rgba(100,100,100,.3)' };

  const avgWR = valid.reduce((s, r) => s + r.wr, 0) / valid.length;

  // 最多策略的最佳持有天數
  const holdVotes = {};
  valid.forEach(r => holdVotes[r.bestIdx] = (holdVotes[r.bestIdx] || 0) + 1);
  const dominantIdx = +Object.entries(holdVotes).sort((a,b) => b[1]-a[1])[0][0];

  let label;
  if (avgWR >= 65 && dominantIdx >= 4) {       // 60日以上
    label = '趨勢確立型，中長線回報優';
  } else if (avgWR >= 65 && dominantIdx <= 1) { // 5~10日
    label = '短線爆發型，快進快出效果佳';
  } else if (avgWR >= 65) {
    label = '均衡型，各持有天數表現穩定';
  } else if (avgWR >= 50) {
    label = '中效型，建議選強訊號進場';
  } else {
    label = '低效型，策略勝率普遍偏低';
  }

  const isLong  = dominantIdx >= 4;
  const isShort = dominantIdx <= 1;
  if (isLong && avgWR >= 60)  return { label, bg: 'rgba(38,166,154,.1)',   color: '#26a69a', border: 'rgba(38,166,154,.3)' };
  if (isShort && avgWR >= 60) return { label, bg: 'rgba(239,83,80,.1)',    color: '#ef5350', border: 'rgba(239,83,80,.3)' };
  if (avgWR >= 65)            return { label, bg: 'rgba(240,180,41,.1)',   color: '#f0b429', border: 'rgba(240,180,41,.3)' };
  return                             { label, bg: 'rgba(100,100,100,.08)', color: '#888',    border: 'rgba(100,100,100,.25)' };
}

// ── 文字分析 ──────────────────────────────────────────────────────────────
function _analyzeStock({ code, name, results }) {
  if (!results || !results.length) return '資料不足，無法分析。';
  const withSig = results.filter(r => r.cnt > 0);
  if (!withSig.length) return '回測期間所有策略均無訊號觸發。';

  const holdVotes = {};
  withSig.forEach(r => holdVotes[r.bestIdx] = (holdVotes[r.bestIdx] || 0) + 1);
  const holdSorted = Object.entries(holdVotes).sort((a,b) => b[1]-a[1]);

  const HOLD_LABELS = ['5日','10日','20日','30日','60日','90日','120日'];
  const holdDesc = holdSorted.filter(([,v]) => v > 0)
    .map(([h, v]) => `${HOLD_LABELS[+h]}（${v}個策略）`).join('、');

  const byCategory = {};
  withSig.forEach(r => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r.wr);
  });
  const catAvg = Object.entries(byCategory)
    .map(([cat, wrs]) => ({ cat, avg: +(wrs.reduce((a,b)=>a+b,0)/wrs.length).toFixed(1) }))
    .sort((a,b) => b.avg - a.avg);
  const topCats = catAvg.slice(0, 2).map(c => `${c.cat}（均勝率 ${c.avg}%）`).join('、');

  const avgWR = +(withSig.reduce((s,r)=>s+r.wr,0)/withSig.length).toFixed(1);
  const top3  = withSig.slice(0, 3);
  const recLines = top3.map((r, i) =>
    `${i+1}. ${r.name}（${r.stratId}）— 勝率 ${r.wr}%，${r.ret >= 0 ? '+' : ''}${r.ret}%，持有 ${HOLD_LABELS[r.bestIdx]}（${r.cnt} 筆${r.cnt < 3 ? '，樣本有限' : ''}）`
  ).join('\n');

  const lowSample = withSig.filter(r => r.cnt < 3);
  const lowNote = lowSample.length > 0
    ? `注意：${lowSample.slice(0,3).map(r=>`${r.name}（${r.cnt}筆）`).join('、')}等策略訊號數偏少，結果僅供參考。`
    : '';

  let text = '';
  text += `最強策略群組：${topCats}\n`;
  text += `最佳持有天數：${holdDesc}\n`;
  text += `有效策略整體勝率均值：${avgWR}%\n`;
  text += `\n推薦策略（依綜合分排序）：\n${recLines}`;
  if (lowNote) text += `\n\n${lowNote}`;
  return text;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────
function _renderCompareResult(el, { allStockResults, HOLD_OPTIONS, HOLD_LABELS }) {
  // 注入 CSS（只注入一次）
  if (!document.getElementById('labCompareCSS')) {
    const style = document.createElement('style');
    style.id = 'labCompareCSS';
    style.textContent = `
.lab-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1500;display:flex;align-items:center;justify-content:center}
.lab-modal{background:#1c2128;border:1px solid var(--border);border-radius:10px;width:92vw;max-width:1000px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
.lab-modal-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);flex-shrink:0}
.lab-modal-title{font-size:15px;font-weight:500;color:var(--text)}
.lab-modal-close{background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
.lab-modal-stats{padding:12px 18px;border-bottom:1px solid var(--border);flex-shrink:0}
.lab-modal-kpi-row{display:flex;gap:20px}
.lab-modal-kpi{display:flex;flex-direction:column;gap:3px}
.lab-kpi-label{font-size:11px;color:var(--muted)}
.lab-kpi-val{font-size:20px;font-weight:600}
.lab-modal-body{flex:1;overflow-y:auto;overflow-x:auto;padding:0 18px 14px}
.lab-table{width:100%;border-collapse:collapse;font-size:12px}
.lab-table th{padding:7px 10px;text-align:left;color:var(--text);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;background:#1c2128;z-index:1}
.lab-table td{padding:7px 10px;border-bottom:0.5px solid var(--border);white-space:nowrap;color:var(--text)}
.lab-table tr:last-child td{border-bottom:none}
.lab-table tr:hover td{background:rgba(255,255,255,.03)}
.lbc-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px}
.lbc-header{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px}
.lbc-title{display:flex;align-items:baseline;gap:7px}
.lbc-code{font-size:14px;font-weight:500;color:var(--accent)}
.lbc-name{font-size:12px;color:var(--muted)}
.lbc-badge{font-size:11px;padding:2px 9px;border-radius:20px;white-space:nowrap;flex-shrink:0}
.lbc-section{padding:10px 14px;border-bottom:1px solid var(--border)}
.lbc-sec-label{font-size:11px;color:var(--text);margin-bottom:8px;font-weight:500;letter-spacing:.3px}
.lbc-hm-wrap{overflow-x:auto}
.lbc-hm{border-collapse:collapse;font-size:11px}
.lbc-hm th{padding:3px 4px;color:var(--text);font-weight:500;text-align:center;white-space:nowrap;font-size:11px}
.lbc-hm td{padding:2px}
.lbc-strat-td{font-size:12px;color:var(--text);padding-right:10px!important;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis}
.lbc-cell{height:34px;border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;min-width:48px;cursor:default}
.lbc-cell-wr{font-size:12px;font-weight:600;line-height:1.2}
.lbc-cell-ret{font-size:11px;line-height:1.2;font-weight:500}
.lbc-legend{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--text)}
.lbc-legend-bar{display:flex;height:6px;border-radius:3px;overflow:hidden;flex:1}
.lbc-analysis{padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text);white-space:pre-line;line-height:1.8}
.lbc-recs{padding:10px 14px;border-bottom:1px solid var(--border)}
.lbc-t3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:4px}
.lbc-t3-card{border-radius:8px;padding:12px 10px 10px;display:flex;flex-direction:column;gap:7px}
.lbc-t3-rank{font-size:11px;color:var(--text);display:flex;align-items:center;gap:5px}
.lbc-t3-badge{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;flex-shrink:0}
.lbc-t3-name{font-size:13px;font-weight:500;color:var(--text);line-height:1.3}
.lbc-t3-id{font-size:11px;color:var(--accent)}
.lbc-t3-bar-row{display:flex;align-items:center;gap:6px}
.lbc-t3-bar-label{font-size:11px;color:var(--text);width:28px;flex-shrink:0}
.lbc-t3-bar-track{flex:1;height:7px;background:var(--border);border-radius:4px;overflow:hidden}
.lbc-t3-bar-fill{height:7px;border-radius:4px}
.lbc-t3-bar-val{font-size:12px;font-weight:500;min-width:40px;text-align:right}
.lbc-t3-pills{display:flex;gap:4px;flex-wrap:wrap}
.lbc-t3-pill{font-size:11px;padding:2px 6px;border-radius:20px;background:var(--bg3,#21262d);color:var(--text)}
.lbc-toggle{padding:8px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none}
.lbc-full{display:none;padding:0 14px 10px;overflow-x:auto}
.lbc-tbl{width:100%;border-collapse:collapse;font-size:12px}
.lbc-tbl th{padding:5px 8px;text-align:left;color:var(--text);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap}
.lbc-tbl td{padding:5px 8px;border-bottom:0.5px solid var(--border);white-space:nowrap;color:var(--text)}
.lbc-tbl tr:last-child td{border-bottom:none}
.lbc-tbl tr:hover td{background:var(--bg2)}
    `;
    document.head.appendChild(style);
  }

  const sections = allStockResults.map((stockData, cardIdx) => {
    const { code, name, results, error } = stockData;
    if (error) return `<div style="padding:10px 0;color:var(--muted);font-size:12px">${code} ${name}：${error}</div>`;

    const badge   = _stockBadge(results);
    const withSig = results.filter(r => r.cnt > 0);
    const top15   = results.slice(0, 15);

    // 全局 score range for color scale
    const allScores = top15.flatMap(r => r.holdData.map(d => d.score));
    const minS = Math.min(...allScores), maxS = Math.max(...allScores);
    const norm = s => maxS > minS ? (s - minS) / (maxS - minS) : 0.5;

    // 熱力圖
    let hmHTML = `<table class="lbc-hm"><thead><tr><th style="text-align:left">策略</th>`;
    HOLD_LABELS.forEach(l => hmHTML += `<th>${l}</th>`);
    hmHTML += '</tr></thead><tbody>';
    top15.forEach(r => {
      hmHTML += `<tr><td class="lbc-strat-td" title="${r.name}">${r.name}</td>`;
      r.holdData.forEach((d, hi) => {
        const isBest = hi === r.bestIdx && d.cnt > 0;
        const t   = norm(d.score);
        const bg  = d.cnt > 0 ? _scoreToColor(t) : 'transparent';
        const tc  = d.cnt > 0 ? _textOnScore(t)  : 'var(--muted)';
        const outline = isBest ? '2px solid var(--text)' : 'none';
        const emptyBorder = d.cnt === 0 ? ';border:1px dashed rgba(120,120,120,.25)' : '';
        hmHTML += `<td style="padding:2px"><div class="lbc-cell" style="background:${bg};outline:${outline};outline-offset:-2px${emptyBorder}">
          ${d.cnt > 0
            ? `<span class="lbc-cell-wr" style="color:${tc}">${d.wr}%</span><span class="lbc-cell-ret" style="color:${tc}">${d.ret>=0?'+':''}${d.ret}%</span>`
            : `<span style="font-size:12px;color:rgba(120,120,120,.35)">—</span>`}
        </div></td>`;
      });
      hmHTML += '</tr>';
    });
    hmHTML += '</tbody></table>';

    // 圖例
    const legendStops = [0,0.167,0.333,0.5,0.667,0.833,1].map(t =>
      `<div style="flex:1;background:${_scoreToColor(t)}"></div>`).join('');

    // 文字分析
    const analysis = _analyzeStock(stockData);

    // 推薦前三 — 卡片式
    const top3 = withSig.slice(0, 3);
    const maxRet3 = Math.max(...top3.map(r => Math.abs(r.ret)), 1);
    const BADGE_STYLES = [
      { bg:'#f0b429', color:'#412402', cardBg:'rgba(240,180,41,.08)', cardBorder:'rgba(240,180,41,.35)' },
      { bg:'var(--bg3,#21262d)', color:'var(--text)', cardBg:'var(--bg2)', cardBorder:'var(--border)' },
      { bg:'var(--bg3,#21262d)', color:'var(--text)', cardBg:'var(--bg2)', cardBorder:'var(--border)' },
    ];
    const recRows = '<div class="lbc-t3">' + top3.map((r, i) => {
      const bs = BADGE_STYLES[i];
      const wrCol  = r.wr >= 80 ? 'var(--up)' : r.wr >= 60 ? '#f0b429' : 'var(--text)';
      const retCol = r.ret >= 0 ? '#ef5350' : '#26a69a';
      const wrPct  = r.wr;
      const retPct = Math.min(100, Math.abs(r.ret) / maxRet3 * 100).toFixed(1);
      const lowPill = r.cnt < 3 ? '<span class="lbc-t3-pill" style="color:#f0b429">\u26a0 少樣本</span>' : '';
      return '<div class="lbc-t3-card" style="background:' + bs.cardBg + ';border:0.5px solid ' + bs.cardBorder + '">'
        + '<div class="lbc-t3-rank">'
        +   '<div class="lbc-t3-badge" style="background:' + bs.bg + ';color:' + bs.color + '">' + (i+1) + '</div>'
        +   '<span>' + r.category + '</span>'
        + '</div>'
        + '<div>'
        +   '<div class="lbc-t3-name">' + r.name + '</div>'
        +   '<div class="lbc-t3-id">' + r.stratId + '</div>'
        + '</div>'
        + '<div style="display:flex;flex-direction:column;gap:5px">'
        +   '<div class="lbc-t3-bar-row">'
        +     '<span class="lbc-t3-bar-label">勝率</span>'
        +     '<div class="lbc-t3-bar-track"><div class="lbc-t3-bar-fill" style="width:' + wrPct + '%;background:' + wrCol + '"></div></div>'
        +     '<span class="lbc-t3-bar-val" style="color:' + wrCol + '">' + r.wr + '%</span>'
        +   '</div>'
        +   '<div class="lbc-t3-bar-row">'
        +     '<span class="lbc-t3-bar-label">報酬</span>'
        +     '<div class="lbc-t3-bar-track"><div class="lbc-t3-bar-fill" style="width:' + retPct + '%;background:' + retCol + '"></div></div>'
        +     '<span class="lbc-t3-bar-val" style="color:' + retCol + '">' + (r.ret >= 0 ? '+' : '') + r.ret + '%</span>'
        +   '</div>'
        + '</div>'
        + '<div class="lbc-t3-pills">'
        +   '<span class="lbc-t3-pill">持有 ' + HOLD_LABELS[r.bestIdx] + '</span>'
        +   '<span class="lbc-t3-pill">' + r.cnt + ' 筆</span>'
        +   lowPill
        + '</div>'
        + '</div>';
    }).join('') + '</div>';
    const recHeader = '';

    // 完整表格
    const tblRows = top15.map(r => {
      const isLow  = r.cnt < 3;
      const wrCol  = r.wr >= 80 ? 'var(--up)' : r.wr >= 60 ? '#f0b429' : 'var(--muted)';
      const retCol = r.ret >= 0 ? '#ef5350' : '#26a69a';
      const fd = r.firstDate || '—';
      const ld = r.lastDate  || '—';
      const ldColor = (() => {
        if (!r.lastDate) return 'var(--text)';
        const days = (Date.now() - new Date(r.lastDate.replace(/\//g, '-')).getTime()) / 86400000;
        return days <= 30 ? '#ef5350' : days <= 90 ? '#f0b429' : 'var(--text)';
      })();
      return `<tr style="${isLow ? 'opacity:0.6' : ''}">
        <td style="color:var(--accent)">${r.stratId}</td>
        <td style="color:var(--text)">${r.name}${isLow?' ⚠':''}</td>
        <td style="color:var(--text)">${r.category}</td>
        <td style="text-align:center;color:var(--text)">${r.cnt}</td>
        <td style="text-align:center;color:${wrCol}">${r.wr}%</td>
        <td style="text-align:center;color:${retCol}">${r.ret>=0?'+':''}${r.ret}%</td>
        <td style="text-align:center;color:var(--text)">${HOLD_LABELS[r.bestIdx]}</td>
        <td style="text-align:center;color:var(--text)">${r.score}</td>
        <td style="text-align:center;color:var(--muted);font-size:11px">${fd}</td>
        <td style="text-align:center;color:${ldColor};font-size:11px">${ld}</td>
      </tr>`;
    }).join('');

    return `<div class="lbc-card">
      <div class="lbc-header">
        <div class="lbc-title">
          <span class="lbc-code">${code}</span>
          <span class="lbc-name">${name}</span>
        </div>
        <span class="lbc-badge" style="background:${badge.bg};color:${badge.color};border:0.5px solid ${badge.border}">${badge.label}</span>
      </div>
      <div class="lbc-section">
        <div class="lbc-sec-label">持有天數熱力圖（前15策略）— 綠弱→紅強，黑框 = 該策略最佳持有天數</div>
        <div class="lbc-hm-wrap">${hmHTML}</div>
        <div class="lbc-legend">
          <span>弱</span>
          <div class="lbc-legend-bar">${legendStops}</div>
          <span>強</span>
          <span style="margin-left:6px;color:var(--text)">勝率 × 報酬綜合強度</span>
        </div>
      </div>
      <div class="lbc-analysis"><span style="font-size:13px;font-weight:500;color:var(--accent)">${code}</span> <span style="font-size:13px;font-weight:500;color:var(--text)">${name}</span> <span style="font-size:11px;color:var(--muted)">分析報告</span>
${analysis}</div>
      <div class="lbc-recs">
        <div class="lbc-sec-label">推薦策略前三名（依綜合分排序）</div>
        ${recHeader}${recRows}
      </div>
      <div class="lbc-toggle" id="lbc-toggle-${cardIdx}" onclick="document.getElementById('lbc-full-${cardIdx}').style.display==='none'?(document.getElementById('lbc-full-${cardIdx}').style.display='block',this.querySelector('i').style.transform='rotate(180deg)'):(document.getElementById('lbc-full-${cardIdx}').style.display='none',this.querySelector('i').style.transform='')">
        <span style="font-size:12px;color:var(--text)">完整策略表（${top15.length} 筆）</span>
        <i class="ti ti-chevron-down" style="font-size:14px;color:var(--text);transition:transform .2s" aria-hidden="true"></i>
      </div>
      <div class="lbc-full" id="lbc-full-${cardIdx}">
        <table class="lbc-tbl">
          <thead><tr>
            <th>策略ID</th><th>策略名稱</th><th>類別</th>
            <th style="text-align:center">訊號數</th><th style="text-align:center">最佳勝率</th>
            <th style="text-align:center">最佳報酬</th><th style="text-align:center">最佳持有</th>
            <th style="text-align:center">綜合分</th>
            <th style="text-align:center">首次觸發</th><th style="text-align:center">近期觸發</th>
          </tr></thead>
          <tbody>${tblRows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  // 複製文字
  const copyText = allStockResults.map(({ code, name, results, error }) => {
    if (error) return `【${code} ${name}】\n${error}`;
    const HOLD_LABELS_LOC = ['5日','10日','20日','30日','60日','90日','120日'];
    const analysis = _analyzeStock({ code, name, results });
    const stockTitle = `【${code} ${name}】`;
    const header = `\n策略ID\t策略名稱\t類別\t訊號數\t最佳勝率\t最佳報酬\t最佳持有\t綜合分\t首次觸發\t近期觸發`;
    const body = results.slice(0, 15).filter(r => r.cnt > 0)
      .map(r => `${r.stratId}\t${r.name}\t${r.category}\t${r.cnt}\t${r.wr}%\t${r.ret>=0?'+':''}${r.ret}%\t${HOLD_LABELS_LOC[r.bestIdx]}\t${r.score}\t${r.firstDate||'—'}\t${r.lastDate||'—'}`)
      .join('\n');
    return stockTitle + '\n' + analysis + header + '\n' + body;
  }).join('\n\n' + '─'.repeat(40) + '\n\n');

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:12px">
      <div class="lab-result-title" style="border:none;padding:0">全策略分析（持有 5~120 日自動最佳）</div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:11px;color:var(--muted)">熱力圖縮放</span>
        <button class="lab-copy-btn" id="labZoomOut" style="padding:2px 8px;font-size:12px">−</button>
        <span id="labZoomVal" style="font-size:11px;color:var(--muted);min-width:32px;text-align:center">100%</span>
        <button class="lab-copy-btn" id="labZoomIn" style="padding:2px 8px;font-size:12px">＋</button>
        <button class="lab-copy-btn" id="labCompareCopyBtn">⎘ 複製</button>
      </div>
    </div>
    ${sections}
    <div class="lab-result-hint">熱力圖：每格顯示該策略在該持有天數的勝率與平均報酬。黑框 = 該策略最佳持有天數。⚠ = 訊號數 &lt; 3，樣本有限。</div>
  `;

  document.getElementById('labCompareCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(copyText).then(() => {
      const btn = document.getElementById('labCompareCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => btn.textContent = '⎘ 複製', 2000); }
    });
  });

  // 縮放控制
  let _zoom = 100;
  function _applyZoom() {
    document.getElementById('labZoomVal').textContent = _zoom + '%';
    document.querySelectorAll('.lbc-hm-wrap').forEach(w => {
      w.style.fontSize = (_zoom / 100) + 'em';
    });
    // 格子寬高隨縮放
    const cellH = Math.round(34 * _zoom / 100);
    const cellMinW = Math.round(44 * _zoom / 100);
    document.querySelectorAll('.lbc-cell').forEach(c => {
      c.style.height = cellH + 'px';
      c.style.minWidth = cellMinW + 'px';
    });
  }
  document.getElementById('labZoomIn')?.addEventListener('click', () => {
    _zoom = Math.min(200, _zoom + 10);
    _applyZoom();
  });
  document.getElementById('labZoomOut')?.addEventListener('click', () => {
    _zoom = Math.max(70, _zoom - 10);
    _applyZoom();
  });
}
