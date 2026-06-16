/**
 * lab-backtest.js — 策略實驗室「組合回測」子頁
 *
 * 功能：選進場訊號 + 出場規則 + 股票池 → 跑組合回測 → 儀表板
 *   - 指標卡：年度回報 / MDD / Sharpe / Alpha / Beta / 勝率
 *   - 累計報酬對比圖（策略 vs 0050，lightweight-charts）
 *   - 年度報酬表 + 交易明細
 *
 * 掛載方式（見 strategy-lab.js patch）：
 *   _lazyBind('backtest', () => import('./lab-backtest.js'), m => m.bindBacktestRun());
 *
 * 資料源：api-hist.js（hist 累積倉儲）
 */

import { fetchHistAll, fetchBenchmark, fetchAllHistCodes } from './api-hist.js';
import { runBacktest, runBacktestAll, runParamScan, isStrategyBacktestable } from './backtest-engine.js';
import { calcMetrics } from './backtest-metrics.js';
import { STRATEGIES, TA_ENTRY_STRATEGIES } from './strategy.js';
import { dbGet, dbPut } from './db.js';
import { AppState } from './state.js';

let _bound = false;
let _chart = null;
let _lastAllResults = null;   // 全策略結果快取（點排行列載入明細用）
let _lastBench = null;

// 白話對照表（指標卡副標用）
const PLAIN = {
  cagr:    '平均一年賺多少',
  bench:   '同期買0050躺著賺多少',
  alpha:   '扣掉大盤順風車後的真本事',
  beta:    '跟大盤連動程度(1=亦步亦趨)',
  mdd:     '最慘時從高點跌掉多少',
  sharpe:  '賺得穩不穩(>1算穩)',
  winRate: '每100筆交易幾筆賺錢',
  mWin:    '每100個月幾個月是賺的',
};

async function _collectCodes(setStatus) {
  const pool = document.getElementById('btPool').value;
  if (pool === 'custom') {
    return document.getElementById('btCustomCodes').value.split(/[,，\s]+/).map(s => s.trim()).filter(s => /^\d{4}$/.test(s));
  }
  if (pool === 'market') {
    setStatus('取得全市場代號清單…');
    const codes = await fetchAllHistCodes();
    if (codes.length === 0) setStatus('⚠ 無法取得全市場清單（Worker /histcodes 未部署？）');
    return codes;
  }
  const groups = AppState.watchlistGroups ?? [];
  return [...new Set(groups.flatMap(g => g.stocks.map(s => s.code)))];
}

export function bindBacktestRun() {
  if (_bound) return;
  _bound = true;
  _renderPanel();
  // 系統發現 → 2Y 回測對接：lab-discovered 設好 window.__btCustomEntry 後 dispatch
  document.addEventListener('bt:customEntry', _applyCustomEntry);
  _applyCustomEntry();  // bind 時已有就直接套（lazy bind 在切 tab 後才發生）
  document.getElementById('btRunBtn')?.addEventListener('click', _run);
  document.getElementById('btRunAllBtn')?.addEventListener('click', _runAll);
  document.getElementById('btScanBtn')?.addEventListener('click', _runScan);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI 骨架（動態生成，index.html 只需空殼 div）
// ─────────────────────────────────────────────────────────────────────────────
function _renderPanel() {
  const panel = document.getElementById('labPanelBacktest');
  if (!panel) return;

  // 可回測的訊號清單（引擎支援的條件）
  const backtestable = STRATEGIES.filter(isStrategyBacktestable);
  const xSeries = backtestable.filter(s => s.category === 'X 系列');
  const others  = backtestable.filter(s => s.category !== 'X 系列');

  const optHtml = [
    '<optgroup label="X 系列">',
    ...xSeries.map(s => `<option value="${s.id}" ${s.id === 'X1' ? 'selected' : ''}>${s.icon} ${s.id} ${s.name}</option>`),
    '</optgroup>',
    '<optgroup label="其他訊號">',
    ...others.map(s => `<option value="${s.id}">${s.icon} ${s.id} ${s.name}</option>`),
    '</optgroup>',
    '<optgroup label="進階指標">',
    ...TA_ENTRY_STRATEGIES.filter(isStrategyBacktestable).map(s => `<option value="${s.id}">${s.icon} ${s.name}</option>`),
    '</optgroup>',
  ].join('');

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;padding:14px">

      <!-- 控制列 -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;color:var(--hint)">進場訊號（可多選）</label>
          <select id="btEntrySelect" multiple size="4" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:4px;font-size:12px;min-width:200px">
            ${optHtml}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;color:var(--hint)">出場規則</label>
          <select id="btExitMode" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px">
            <option value="days">固定天數</option>
            <option value="signal_gone">訊號消失</option>
            <option value="trailing">停損+移動停利</option>
            <option value="supertrend">Supertrend 翻空</option>
            <option value="avwap">跌破錨定VWAP</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;color:var(--hint)">持有天數</label>
          <input id="btExitDays" type="number" value="20" min="1" max="120"
                 style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px;width:70px" />
        </div>
        <div id="btTrailWrap" style="display:none;gap:10px">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;color:var(--hint)">停損 %</label>
            <input id="btStopPct" type="number" value="8" min="1" max="30"
                   style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px;width:60px" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;color:var(--hint)">回落停利 %</label>
            <input id="btTrailPct" type="number" value="15" min="3" max="50"
                   style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px;width:60px" />
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;color:var(--hint)">股票池</label>
          <select id="btPool" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px">
            <option value="watchlist">全部自選清單</option>
            <option value="market">🌏 全市場（~1950檔）</option>
            <option value="custom">手動輸入</option>
          </select>
        </div>
        <div id="btCustomWrap" style="display:none;flex-direction:column;gap:4px">
          <label style="font-size:11px;color:var(--hint)">代號（逗號分隔）</label>
          <input id="btCustomCodes" type="text" placeholder="2330,2317,6116"
                 style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px;width:200px" />
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;color:var(--hint)">持股上限</label>
          <input id="btMaxPos" type="number" value="10" min="1" max="30"
                 style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:6px;font-size:12px;width:60px" />
        </div>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer;padding-bottom:7px">
          <input type="checkbox" id="btRegime" checked style="accent-color:var(--accent)" />
          大盤濾網
          <span style="font-size:10px;color:var(--hint)">(0050>MA60才進場)</span>
        </label>
        <button id="btRunBtn" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">
          ▶ 開始回測
        </button>
        <button id="btRunAllBtn" style="background:none;color:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:8px 14px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">
          🏁 全策略比較
        </button>
        <button id="btScanBtn" style="background:none;color:var(--muted);border:1px solid var(--border2);border-radius:6px;padding:8px 14px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit" title="對選中訊號掃描停損×回落停利參數組合">
          🔬 參數掃描
        </button>
        <span id="btStatus" style="font-size:12px;color:var(--hint)"></span>
      </div>

      <!-- 進場濾網（AND-gate，疊在進場訊號上：勾選者全部成立才進場）-->
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
        <span style="font-size:11px;color:var(--hint)">🧲 進場濾網<span style="color:var(--muted)">（疊在訊號上，全部成立才進）</span></span>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer"><input type="checkbox" id="btFltWk"  style="accent-color:var(--accent)" />🔭 週線多頭</label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer"><input type="checkbox" id="btFltSt2" style="accent-color:var(--accent)" />🌀 Stage 2</label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer"><input type="checkbox" id="btFltPoc" style="accent-color:var(--accent)" />📊 站上POC</label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer"><input type="checkbox" id="btFltSup" style="accent-color:var(--accent)" />🛡️ Supertrend多</label>
      </div>

      <!-- 全策略排行榜 -->
      <div id="btRankWrap" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="display:flex;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;color:var(--hint)">全策略排行 · 點任一列看明細 · <b>怎麼看：</b>交易數&lt;30的排名是運氣別信；年化高但MDD也深=賺得多但過程嚇死人</span>
          <button id="btCopyRank" style="margin-left:auto;background:none;border:1px solid var(--border2);border-radius:5px;padding:4px 10px;font-size:11px;color:var(--muted);cursor:pointer;font-family:inherit">📋 複製結果</button>
        </div>
        <div style="max-height:400px;overflow-y:auto">
          <table id="btRank" style="width:100%;font-size:12px;border-collapse:collapse"></table>
        </div>
      </div>

      <!-- 參數掃描矩陣 -->
      <div id="btScanWrap" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="font-size:12px;color:var(--hint);margin-bottom:8px" id="btScanTitle">參數掃描矩陣（停損% × 回落停利%，每格：年化 / MDD / 勝率）</div>
        <table id="btScanMatrix" style="border-collapse:collapse;font-size:12px"></table>
      </div>

      <!-- 指標卡列 -->
      <div id="btMetricCards" style="display:none;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px"></div>

      <!-- 對比結論 -->
      <div id="btVerdict" style="display:none;padding:12px 16px;border-radius:8px;font-size:14px;font-weight:500"></div>

      <!-- 累計報酬對比圖 -->
      <div id="btChartWrap" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="font-size:12px;color:var(--hint);margin-bottom:8px">
          累計報酬走勢　<span style="color:#ef5350">━ 策略</span>　<span style="color:#9ca3af">━ 0050（含息）</span>
        </div>
        <div id="btChart" style="height:320px"></div>
      </div>

      <!-- 年度報酬表 -->
      <div id="btYearlyWrap" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="font-size:12px;color:var(--hint);margin-bottom:8px">年度報酬（策略 vs 大盤）</div>
        <div id="btYearly" style="display:flex;gap:18px;flex-wrap:wrap"></div>
      </div>

      <!-- 交易明細 -->
      <div id="btTradesWrap" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="font-size:12px;color:var(--hint);margin-bottom:8px">交易明細（最近 50 筆）</div>
        <div style="max-height:300px;overflow-y:auto">
          <table id="btTrades" style="width:100%;font-size:12px;border-collapse:collapse"></table>
        </div>
      </div>

    </div>
  `;

  document.getElementById('btPool')?.addEventListener('change', e => {
    document.getElementById('btCustomWrap').style.display = e.target.value === 'custom' ? 'flex' : 'none';
  });
  document.getElementById('btExitMode')?.addEventListener('change', e => {
    const isTrail = e.target.value === 'trailing';
    document.getElementById('btTrailWrap').style.display = isTrail ? 'flex' : 'none';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 執行回測
// ─────────────────────────────────────────────────────────────────────────────
// ── 自訂進場（系統發現策略）注入 select ──────────────────────────────────
function _applyCustomEntry() {
  const combo = window.__btCustomEntry;
  const sel = document.getElementById('btEntrySelect');
  if (!combo || !sel) return;

  // 移除舊的 CUSTOM option，插入新的並單獨選取
  sel.querySelector('option[value="CUSTOM"]')?.remove();
  const opt = document.createElement('option');
  opt.value = 'CUSTOM';
  opt.textContent = `🔮 ${combo.name}`;
  opt.selected = true;
  sel.insertBefore(opt, sel.firstChild);
  [...sel.options].forEach(o => { if (o.value !== 'CUSTOM') o.selected = false; });

  // 帶入發現時的持有期（固定天數出場）
  if (combo.exitDays) {
    const mode = document.getElementById('btExitMode');
    const days = document.getElementById('btExitDays');
    if (mode) { mode.value = 'days'; mode.dispatchEvent(new Event('change')); }
    if (days) days.value = combo.exitDays;
  }
}

async function _run() {
  const status = document.getElementById('btStatus');
  const btn = document.getElementById('btRunBtn');
  const setStatus = m => { if (status) status.textContent = m; };

  try {
    btn.disabled = true;

    // 1. 收集參數
    let entryIds = [...document.getElementById('btEntrySelect').selectedOptions].map(o => o.value);
    const useCustom = entryIds.includes('CUSTOM') && window.__btCustomEntry;
    entryIds = entryIds.filter(id => id !== 'CUSTOM');
    // 進階指標策略走 customStrategies 注入（不在 live STRATEGIES，引擎靠 customStrategies 評估）
    const taSelected = TA_ENTRY_STRATEGIES.filter(s => entryIds.includes(s.id) && isStrategyBacktestable(s));
    const taIds = new Set(taSelected.map(s => s.id));
    entryIds = entryIds.filter(id => !taIds.has(id));
    if (entryIds.length === 0 && taSelected.length === 0 && !useCustom) { setStatus('⚠ 請至少選一個進場訊號'); btn.disabled = false; return; }
    // 進場濾網（AND-gate）
    const entryFilters = [];
    if (document.getElementById('btFltWk')?.checked)  entryFilters.push({ condId: 'weekly_bull' });
    if (document.getElementById('btFltSt2')?.checked) entryFilters.push({ condId: 'weinstein_stage', value: 2 });
    if (document.getElementById('btFltPoc')?.checked) entryFilters.push({ condId: 'above_poc' });
    if (document.getElementById('btFltSup')?.checked) entryFilters.push({ condId: 'supertrend_up' });
    const exitMode = document.getElementById('btExitMode').value;
    const exitDays = parseInt(document.getElementById('btExitDays').value, 10) || 20;
    let maxPositions = parseInt(document.getElementById('btMaxPos').value, 10) || 10;
    if (maxPositions < 1 || maxPositions > 30) {
      maxPositions = Math.min(Math.max(maxPositions, 1), 30);
      document.getElementById('btMaxPos').value = maxPositions;
      setStatus(`持股上限已修正為 ${maxPositions}（範圍 1-30）`);
    }

    // 2. 股票池
    const codes = await _collectCodes(setStatus);
    if (codes.length === 0) { setStatus('⚠ 股票池為空'); btn.disabled = false; return; }

    // 3. 拉資料
    setStatus(`載入 ${codes.length} 檔歷史資料…`);
    const [histMap, benchCandles] = await Promise.all([
      fetchHistAll(codes, (done, total) => setStatus(`載入資料 ${done}/${total}…`)),
      fetchBenchmark('0050'),
    ]);
    if (histMap.size === 0) { setStatus('⚠ 無法取得歷史資料（hist 倉儲尚未初始化？）'); btn.disabled = false; return; }

    // 4. 回測
    setStatus('回測運算中…');
    await new Promise(r => setTimeout(r, 30));   // 讓 UI 先刷新
    const stopPct  = parseFloat(document.getElementById('btStopPct')?.value) || 8;
    const trailPct = parseFloat(document.getElementById('btTrailPct')?.value) || 15;
    const useRegime = document.getElementById('btRegime')?.checked;
    const result = runBacktest({
      histMap, entryIds, exitMode, exitDays, stopPct, trailPct,
      customStrategies: [...(useCustom ? [window.__btCustomEntry] : []), ...taSelected],
      entryFilters,
      regimeCandles: useRegime ? benchCandles : null,
      capital: 1_000_000, maxPositions,
    });

    // 5. 指標
    const m = calcMetrics({ ...result, benchCandles, capital: 1_000_000 });

    // 6. 渲染
    _renderMetrics(m, result);
    setStatus(`✓ 完成（${histMap.size} 檔 / ${result.config.days} 交易日 / ${m.tradeCount} 筆交易）`);

    // 自動留案底：系統發現策略的 2Y 回測結果寫 IDB（晉升名人堂鑑定用）
    if (useCustom && window.__btCustomEntry) {
      try {
        const ce = window.__btCustomEntry;
        const conds = ce.conditions.map(x => x.condId.replace(/^gas:/, ''));
        const key = 'sv:' + conds.join('+') + '@' + (ce.exitDays ?? exitDays);
        const totalRet = result.equity?.length
          ? +((result.equity[result.equity.length - 1].value / result.equity[0].value - 1) * 100).toFixed(1)
          : null;
        const prev = await dbGet('config', key).catch(() => null);
        await dbPut('config', {
          ...(prev ?? {}), key,
          bt2y: { days: result.config.days, trades: m.tradeCount, totalRet, at: new Date().toISOString().slice(0, 10) },
        });
      } catch (e) { console.warn('[bt] 案底寫入失敗:', e.message); }
    }
  } catch (e) {
    console.error('[backtest]', e);
    setStatus('⚠ ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 全策略比較
// ─────────────────────────────────────────────────────────────────────────────
async function _runAll() {
  const status = document.getElementById('btStatus');
  const btn = document.getElementById('btRunAllBtn');
  const setStatus = m => { if (status) status.textContent = m; };

  try {
    btn.disabled = true;
    const exitMode = document.getElementById('btExitMode').value;
    const exitDays = parseInt(document.getElementById('btExitDays').value, 10) || 20;
    let maxPositions = parseInt(document.getElementById('btMaxPos').value, 10) || 10;
    maxPositions = Math.min(Math.max(maxPositions, 1), 30);
    document.getElementById('btMaxPos').value = maxPositions;

    const codes = await _collectCodes(setStatus);
    if (codes.length === 0) { setStatus('⚠ 股票池為空'); btn.disabled = false; return; }

    setStatus(`載入 ${codes.length} 檔歷史資料…`);
    const [histMap, benchCandles] = await Promise.all([
      fetchHistAll(codes, (done, total) => setStatus(`載入資料 ${done}/${total}…`)),
      fetchBenchmark('0050'),
    ]);
    if (histMap.size === 0) { setStatus('⚠ 無法取得歷史資料'); btn.disabled = false; return; }
    _lastBench = benchCandles;

    setStatus('全策略回測中…');
    await new Promise(r => setTimeout(r, 30));
    const stopPct  = parseFloat(document.getElementById('btStopPct')?.value) || 8;
    const trailPct = parseFloat(document.getElementById('btTrailPct')?.value) || 15;
    const useRegime = document.getElementById('btRegime')?.checked;
    const results = runBacktestAll({
      histMap, exitMode, exitDays, stopPct, trailPct, capital: 1_000_000, maxPositions,
      regimeCandles: useRegime ? benchCandles : null,
      onProgress: (done, total) => setStatus(`回測中 ${done}/${total} 策略…`),
    });
    _lastAllResults = results;

    // 算每策略摘要指標並排序（年化由高到低）
    const rows = results.map(r => {
      let m;
      try { m = calcMetrics({ ...r, benchCandles, capital: 1_000_000 }); }
      catch { m = null; }
      return { r, m };
    }).filter(x => x.m);
    rows.sort((a, b) => b.m.cagr - a.m.cagr);

    _renderRank(rows);
    setStatus(`✓ 完成（${results.length} 個策略 / ${histMap.size} 檔）`);
  } catch (e) {
    console.error('[backtest-all]', e);
    setStatus('⚠ ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 參數掃描
// ─────────────────────────────────────────────────────────────────────────────
const SCAN_STOPS  = [8, 10, 15, 20];
const SCAN_TRAILS = [15, 20, 25, 30];

async function _runScan() {
  const status = document.getElementById('btStatus');
  const btn = document.getElementById('btScanBtn');
  const setStatus = m => { if (status) status.textContent = m; };

  try {
    btn.disabled = true;
    const entryIds = [...document.getElementById('btEntrySelect').selectedOptions].map(o => o.value);
    if (entryIds.length === 0) { setStatus('⚠ 請先選進場訊號'); btn.disabled = false; return; }
    let maxPositions = Math.min(Math.max(parseInt(document.getElementById('btMaxPos').value, 10) || 10, 1), 30);

    const codes = await _collectCodes(setStatus);
    if (codes.length === 0) { setStatus('⚠ 股票池為空'); btn.disabled = false; return; }

    setStatus(`載入 ${codes.length} 檔資料…`);
    const [histMap, benchCandles] = await Promise.all([
      fetchHistAll(codes, (d, t) => setStatus(`載入 ${d}/${t}…`)),
      fetchBenchmark('0050'),
    ]);
    if (histMap.size === 0) { setStatus('⚠ 無資料'); btn.disabled = false; return; }
    const useRegime = document.getElementById('btRegime')?.checked;

    setStatus('掃描中…');
    await new Promise(r => setTimeout(r, 30));
    const scan = runParamScan({
      histMap, entryIds, stops: SCAN_STOPS, trails: SCAN_TRAILS,
      maxPositions, regimeCandles: useRegime ? benchCandles : null,
      onProgress: (d, t) => setStatus(`掃描 ${d}/${t} 組…`),
    });

    // 算每組指標
    const cells = scan.map(r => {
      let m = null;
      try { m = calcMetrics({ ...r, benchCandles, capital: 1_000_000 }); } catch {}
      return { stopPct: r.stopPct, trailPct: r.trailPct, m };
    });

    _renderScanMatrix(cells, entryIds);
    setStatus(`✓ 掃描完成（${entryIds.join('+')} × ${cells.length} 組參數）`);
  } catch (e) {
    console.error('[scan]', e);
    setStatus('⚠ ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function _renderScanMatrix(cells, entryIds) {
  const wrap = document.getElementById('btScanWrap');
  wrap.style.display = 'block';
  document.getElementById('btScanTitle').textContent =
    `${entryIds.join('+')} 參數掃描 · 每格＝年化/最大回檔/勝率 · 怎麼看：要找「一片好的區域」不是單一好格子，孤立的好格子是運氣`;

  const best = cells.reduce((a, b) => (b.m && (!a.m || b.m.cagr > a.m.cagr)) ? b : a, cells[0]);

  let html = '<tr><th style="padding:6px 10px;color:var(--hint)">停損\\回落</th>' +
    SCAN_TRAILS.map(t => `<th style="padding:6px 10px;color:var(--hint)">${t}%</th>`).join('') + '</tr>';

  for (const s of SCAN_STOPS) {
    html += `<tr><td style="padding:6px 10px;color:var(--hint);font-weight:600">${s}%</td>`;
    for (const t of SCAN_TRAILS) {
      const cell = cells.find(c => c.stopPct === s && c.trailPct === t);
      const m = cell?.m;
      const isBest = cell === best;
      html += `<td style="padding:8px 12px;text-align:center;border:1px solid ${isBest ? 'var(--up)' : 'var(--border)'};border-radius:4px;${isBest ? 'background:rgba(38,166,154,.08)' : ''}">
        ${m ? `<div style="font-weight:600;color:${m.cagr >= 0 ? 'var(--up)' : 'var(--down)'}">${m.cagr >= 0 ? '+' : ''}${m.cagr}%</div>
        <div style="font-size:10px;color:var(--down)">${m.mdd}%</div>
        <div style="font-size:10px;color:var(--hint)">${m.winRate}%</div>` : '—'}
      </td>`;
    }
    html += '</tr>';
  }
  document.getElementById('btScanMatrix').innerHTML = html;
}

function _renderRank(rows) {
  const wrap = document.getElementById('btRankWrap');
  wrap.style.display = 'block';
  const benchCagr = rows[0]?.m?.benchCagr;

  // 複製按鈕：輸出自帶說明書的 markdown 報告（方便貼給 AI 或存檔）
  const copyBtn = document.getElementById('btCopyRank');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const cfg = rows[0]?.r?.config ?? {};
      const lines = [
        `# 全策略組合回測排行`,
        `回測條件：股票池 ${cfg.stockCount} 檔 / ${cfg.days} 交易日 / 出場=${cfg.exitMode === 'days' ? `固定${cfg.exitDays}天` : cfg.exitMode === 'trailing' ? '停損+移動停利' : '訊號消失'} / 持股上限 ${cfg.maxPositions} / 大盤濾網=${document.getElementById('btRegime')?.checked ? '開' : '關'} / 初始資金 100萬 / T+1開盤成交含手續費稅`,
        `大盤基準：0050 含息，同期年化 ${benchCagr != null ? (benchCagr >= 0 ? '+' : '') + benchCagr + '%' : '—'}`,
        `指標說明：年化=CAGR、Alpha=扣除Beta×大盤後的超額年化、MDD=最大回檔、交易數<10標⚠表樣本不足`,
        ``,
        `| # | 策略 | 年化 | Alpha | MDD | 勝率 | 交易數 | 月勝率 | vs大盤 |`,
        `|---|------|------|-------|-----|------|--------|--------|--------|`,
        ...rows.map(({ r, m }, i) =>
          `| ${i + 1} | ${r.id} ${r.name} | ${m.cagr >= 0 ? '+' : ''}${m.cagr}% | ${m.alpha != null ? (m.alpha >= 0 ? '+' : '') + m.alpha + '%' : '—'} | ${m.mdd}% | ${m.winRate}% | ${m.tradeCount}${m.tradeCount < 10 ? '⚠' : ''} | ${m.monthlyWinRate}% | ${m.benchCagr != null && m.cagr > m.benchCagr ? '🏆打贏' : '落後'} |`
        ),
      ];
      navigator.clipboard.writeText(lines.join('\n')).then(() => {
        copyBtn.textContent = '✓ 已複製';
        setTimeout(() => { copyBtn.textContent = '📋 複製結果'; }, 1500);
      });
    };
  }

  document.getElementById('btRank').innerHTML = `
    <tr style="color:var(--hint);text-align:left;position:sticky;top:0;background:var(--bg2)">
      <th style="padding:5px 8px">#</th><th style="padding:5px 8px">策略</th>
      <th style="padding:5px 8px;text-align:right">年化</th>
      <th style="padding:5px 8px;text-align:right">Alpha</th>
      <th style="padding:5px 8px;text-align:right">MDD</th>
      <th style="padding:5px 8px;text-align:right">勝率</th>
      <th style="padding:5px 8px;text-align:right">交易數</th>
      <th style="padding:5px 8px;text-align:right">月勝率</th>
      <th style="padding:5px 8px">vs 大盤${benchCagr != null ? `(${benchCagr >= 0 ? '+' : ''}${benchCagr}%)` : ''}</th>
    </tr>` + rows.map(({ r, m }, idx) => {
      const beat = m.benchCagr != null && m.cagr > m.benchCagr;
      return `
    <tr style="border-top:1px solid var(--border);cursor:pointer" data-bt-strat="${r.id}"
        onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
      <td style="padding:5px 8px;color:var(--hint)">${idx + 1}</td>
      <td style="padding:5px 8px;font-weight:600">${r.icon} ${r.id} ${r.name}</td>
      <td style="padding:5px 8px;text-align:right;font-weight:600;color:${m.cagr >= 0 ? 'var(--up)' : 'var(--down)'}">${m.cagr >= 0 ? '+' : ''}${m.cagr}%</td>
      <td style="padding:5px 8px;text-align:right;color:${m.alpha > 0 ? 'var(--up)' : 'var(--down)'}">${m.alpha != null ? (m.alpha >= 0 ? '+' : '') + m.alpha + '%' : '—'}</td>
      <td style="padding:5px 8px;text-align:right;color:var(--down)">${m.mdd}%</td>
      <td style="padding:5px 8px;text-align:right">${m.winRate}%</td>
      <td style="padding:5px 8px;text-align:right;color:${m.tradeCount < 10 ? 'var(--hint)' : 'var(--text)'}">${m.tradeCount}${m.tradeCount < 10 ? '⚠' : ''}</td>
      <td style="padding:5px 8px;text-align:right">${m.monthlyWinRate}%</td>
      <td style="padding:5px 8px">${beat ? '<span style="color:var(--up)">🏆 打贏</span>' : '<span style="color:var(--hint)">落後</span>'}</td>
    </tr>`;
    }).join('');

  // 點列 → 載入該策略完整明細
  document.querySelectorAll('[data-bt-strat]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.btStrat;
      const result = _lastAllResults?.find(r => r.id === id);
      if (!result) return;
      const m = calcMetrics({ ...result, benchCandles: _lastBench, capital: 1_000_000 });
      _renderMetrics(m, result);
      document.getElementById('btMetricCards')?.scrollIntoView({ behavior: 'smooth' });
      // 同步選單選中該策略
      [...document.getElementById('btEntrySelect').options].forEach(o => o.selected = o.value === id);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染結果
// ─────────────────────────────────────────────────────────────────────────────
function _renderMetrics(m, result) {
  // 指標卡
  const cards = [
    { label: '年度回報', plain: PLAIN.cagr, value: _pct(m.cagr), color: m.cagr >= 0 ? 'var(--up)' : 'var(--down)' },
    { label: '大盤年化', plain: PLAIN.bench, value: _pct(m.benchCagr), color: 'var(--muted)' },
    { label: '超額本事 Alpha', plain: PLAIN.alpha, value: m.alpha != null ? _pct(m.alpha) : '—', color: m.alpha > 0 ? 'var(--up)' : 'var(--down)' },
    { label: '連動度 Beta', plain: PLAIN.beta, value: m.beta ?? '—', color: 'var(--text)' },
    { label: '最大回檔', plain: PLAIN.mdd, value: _pct(m.mdd), color: 'var(--down)' },
    { label: '穩定度 夏普', plain: PLAIN.sharpe, value: m.sharpe, color: 'var(--text)' },
    { label: '逐筆勝率', plain: PLAIN.winRate, value: _pct(m.winRate), color: 'var(--text)' },
    { label: '月勝率', plain: PLAIN.mWin, value: `${_pct(m.monthlyWinRate)} (${m.monthlyWins}/${m.monthlyTotal})`, color: 'var(--text)' },
  ];
  const cardEl = document.getElementById('btMetricCards');
  cardEl.style.display = 'grid';
  cardEl.innerHTML = cards.map(c => `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="font-size:11px;color:var(--hint)">${c.label}</div>
      <div style="font-size:18px;font-weight:600;color:${c.color};margin:3px 0">${c.value}</div>
      <div style="font-size:10px;color:var(--hint);opacity:.8">${c.plain}</div>
    </div>
  `).join('');

  // 結論 banner（直接回答「打贏大盤了嗎」）
  const verdict = document.getElementById('btVerdict');
  verdict.style.display = 'block';
  if (m.benchCagr != null) {
    const diff = +(m.cagr - m.benchCagr).toFixed(1);
    const win = diff > 0;
    verdict.style.background = win ? 'rgba(38,166,154,.12)' : 'rgba(239,83,80,.12)';
    verdict.style.border = `1px solid ${win ? 'rgba(38,166,154,.4)' : 'rgba(239,83,80,.4)'}`;
    verdict.style.color = win ? 'var(--up)' : 'var(--down)';
    verdict.textContent = win
      ? `🏆 策略打贏大盤：年化 ${_pct(m.cagr)} vs 0050 的 ${_pct(m.benchCagr)}（超額 +${diff}%）`
      : `📉 策略輸給大盤：年化 ${_pct(m.cagr)} vs 0050 的 ${_pct(m.benchCagr)}（落後 ${diff}%）`;
  } else {
    verdict.textContent = '⚠ 無法取得大盤基準，僅顯示策略絕對績效';
  }

  // 對比曲線（lightweight-charts）
  const wrap = document.getElementById('btChartWrap');
  wrap.style.display = 'block';
  const chartEl = document.getElementById('btChart');
  chartEl.innerHTML = '';
  if (_chart) { try { _chart.remove(); } catch (_) {} _chart = null; }

  _chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: 'transparent' }, textColor: '#9ca3af' },
    grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,.1)' },
    timeScale: { borderColor: 'rgba(255,255,255,.1)' },
    height: 320,
  });
  const sLine = _chart.addLineSeries({ color: '#ef5350', lineWidth: 2, priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' } });
  sLine.setData(m.curve.map(p => ({ time: p.t, value: p.strategy })));
  if (m.curve.some(p => p.bench != null)) {
    const bLine = _chart.addLineSeries({ color: '#9ca3af', lineWidth: 1 });
    bLine.setData(m.curve.filter(p => p.bench != null).map(p => ({ time: p.t, value: p.bench })));
  }
  _chart.timeScale().fitContent();

  // 年度表
  const yWrap = document.getElementById('btYearlyWrap');
  yWrap.style.display = 'block';
  document.getElementById('btYearly').innerHTML = m.yearlyReturns.map(y => `
    <div style="text-align:center">
      <div style="font-size:12px;font-weight:600;color:var(--text)">${y.year}</div>
      <div style="font-size:14px;font-weight:600;color:${y.strategy >= 0 ? 'var(--up)' : 'var(--down)'}">${_pct(y.strategy)}</div>
      <div style="font-size:11px;color:var(--hint)">大盤 ${y.bench != null ? _pct(y.bench) : '—'}</div>
    </div>
  `).join('');

  // 交易明細
  const tWrap = document.getElementById('btTradesWrap');
  tWrap.style.display = 'block';
  const recent = [...result.trades].reverse().slice(0, 50);
  document.getElementById('btTrades').innerHTML = `
    <tr style="color:var(--hint);text-align:left">
      <th style="padding:4px 8px">代號</th><th style="padding:4px 8px">訊號</th>
      <th style="padding:4px 8px">進場</th><th style="padding:4px 8px">出場</th>
      <th style="padding:4px 8px">持有</th><th style="padding:4px 8px;text-align:right">報酬</th>
      <th style="padding:4px 8px">原因</th>
    </tr>` + recent.map(t => `
    <tr style="border-top:1px solid var(--border)">
      <td style="padding:4px 8px;font-weight:600">${t.code}</td>
      <td style="padding:4px 8px">${t.signalId}</td>
      <td style="padding:4px 8px;color:var(--muted)">${_d(t.entryTs)}</td>
      <td style="padding:4px 8px;color:var(--muted)">${_d(t.exitTs)}</td>
      <td style="padding:4px 8px">${t.holdDays}天</td>
      <td style="padding:4px 8px;text-align:right;font-weight:600;color:${t.retPct >= 0 ? 'var(--up)' : 'var(--down)'}">${t.retPct >= 0 ? '+' : ''}${t.retPct}%</td>
      <td style="padding:4px 8px;color:var(--hint)">${t.reason}</td>
    </tr>`).join('');
}

const _pct = v => v != null ? `${v >= 0 ? '+' : ''}${v}%` : '—';
const _d = ts => new Date(ts * 1000).toISOString().slice(5, 10).replace('-', '/');
