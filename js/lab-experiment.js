/**
 * lab-experiment.js — 真實驗室子模組（VVVIP 專屬）
 *
 * 模式 A：單股回測
 * 模式 B：全市場掃描（地圖炮）
 *
 * v3（2026-06-10）：Z1~Z6 全數移除，策略來源改為系統發現名人堂（/discovered）
 *   - bindExperimentRun 動態註冊 D1, D2, ...（gasConds → backtest-engine GAS_LIB 逐根判定）
 *   - 全市場掃描 / 序列回測 / 出場比較三個 R2 viewer 保留（歷史 Z 數據仍可查）
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { dengToast } from './loading-deng.js';
import { resolveCode, tsToDate } from './lab-utils.js';
import { dbGetAll, dbGet, dbPut } from './db.js';
import { buildGasEvaluator } from './backtest-engine.js';

// ─────────────────────────────────────────────────────────────────────────────
// Z 系列實驗策略
// ─────────────────────────────────────────────────────────────────────────────
export const EXPERIMENTAL_STRATEGIES = {};
// Z1~Z6 已於 2026-06-10 全數移除（實用性不及系統發現策略；Z6 出場確認邏輯仍留在 signal-scan.js）
// 策略改為動態註冊：bindExperimentRun 時讀 /discovered 名人堂，註冊為 D1, D2, ...

const _COND_ZH = {
  rsi_min:'RSI≥50',rsi_max:'RSI≥80',rsi_revival:'RSI脫離超賣',kd_k_min:'K≤20',kd_k_max:'K≥80',
  kd_golden:'KD金叉',kd_dead:'KD死叉',macd_golden:'MACD金叉',macd_dead:'MACD死叉',macd_hist_pos:'MACD柱>0',
  macd_dead_above_zero:'MACD零上死叉',above_ma20:'站上月線',below_ma20:'跌破月線',ma5_cross_ma20:'5日穿月線',
  ma20_turn_up:'月線翻揚',ma20_rising:'月線上彎',ma20_declining:'月線下彎',ma20_turn_down:'月線翻空',
  price_cross_ma20_up:'價穿月線',price_cross_ma20_down:'價破月線',price_bounce_ma20:'月線附近回測',
  price_far_below_ma20:'深跌破月線8%',price_far_above_ma20:'高乖離月線8%',price_rally_fail_ma20:'反彈月線失敗',
  bb_squeeze:'布林收斂',bb_expanding:'布林擴張',bb_upper_touch:'觸布林上軌',bb_lower_touch:'觸布林下軌',
  high_n_days:'創20日新高',drop_n_days:'創20日新低',vol_surge:'爆量1.5x',vol_shrink:'量縮',
  vol_surge_long:'帶量上攻',vol_surge_short:'帶量收紅',vol_surge_drop:'帶量下殺',limit_up:'漲停',
  psy_oversold:'PSY超賣',psy_overbought:'PSY超買',bias20_low:'乖離≤-8',rci9_turn_up:'RCI翻揚',
  dmi_bull:'DMI多頭',dmi_strong:'ADX強趨勢',dmi_bear:'DMI空頭',sar_bull:'SAR多頭',hv_low:'低波動',
  ema_bull:'EMA多頭排列',ema_cross_up:'EMA上穿',ma_bear_array:'空頭排列',gmma_bull:'GMMA多頭',
  ichi_cloud_above:'雲上',ichi_below_cloud:'雲下',ichi_bull_cloud:'多頭雲',ichi_tk_cross:'轉換線金叉',
  ichi_tk_dead:'轉換線死叉',ichi_chikou_above:'遲行線在上',three_peaks:'三頂',three_valleys:'三底',
  three_soldiers:'紅三兵',bullish_engulfing:'多頭吞噬',tight_consolidation:'緊密盤整帶量',
  gain_10d:'10日漲>5%',loss_5d:'5日跌>5%',
};

async function _loadDiscoveredStrategies() {
  const sel = document.getElementById('expStrategySelect');
  try {
    const WORKER = 'https://stock-2027.luffy0606.workers.dev';
    const TOKEN  = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
    const res = await fetch(`${WORKER}/discovered`, { headers: { 'X-Proxy-Token': TOKEN }, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    (data.top ?? []).forEach((q, i) => {
      const id = 'D' + (i + 1);
      const label = q.conds.map(cid => _COND_ZH[cid] ?? cid).join('+');
      EXPERIMENTAL_STRATEGIES[id] = {
        id, name: `${label}（${q.hold}日）`, icon: '🔮',
        desc: `系統發現（${q.foundAt}）驗證超額 ${q.validAvgExcess}%/${q.hold}日`,
        minCandles: 80, direction: 'long',
        gasConds: q.conds, hold: q.hold,
      };
      if (sel) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `🔮 ${id} ${label}（${q.hold}日）`;
        sel.appendChild(opt);
      }
    });
  } catch (e) {
    console.warn('[exp] discovered 載入失敗:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 技術指標（內建）
// ─────────────────────────────────────────────────────────────────────────────
function _ma(closes, p) {
  return closes.map((_, i) =>
    i < p-1 ? null : closes.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p
  );
}
function _calcRSI(closes, p=14) {
  const r = new Array(closes.length).fill(null);
  if (closes.length < p+1) return r;
  let g=0, l=0;
  for (let i=1; i<=p; i++) { const d=closes[i]-closes[i-1]; if(d>0)g+=d; else l-=d; }
  let ag=g/p, al=l/p;
  r[p] = al===0 ? 100 : 100-100/(1+ag/al);
  for (let i=p+1; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
    r[i] = al===0 ? 100 : 100-100/(1+ag/al);
  }
  return r;
}
function _calcKD(candles, kp=9, sm=3) {
  const n=candles.length, k=new Array(n).fill(null), d=new Array(n).fill(null);
  for (let i=kp-1; i<n; i++) {
    const sl=candles.slice(i-kp+1,i+1);
    const hi=Math.max(...sl.map(c=>c.high)), lo=Math.min(...sl.map(c=>c.low));
    const rsv=hi===lo ? 50 : (candles[i].close-lo)/(hi-lo)*100;
    k[i]=i===kp-1 ? rsv : (k[i-1]*(sm-1)+rsv)/sm;
    d[i]=i===kp-1 ? k[i] : (d[i-1]*(sm-1)+k[i])/sm;
  }
  return {k,d};
}
function _calcMACD(closes, fast=12, slow=26, sig=9) {
  const ema=(arr,p,st)=>{
    const k=2/(p+1), r=new Array(arr.length).fill(null);
    r[st]=arr.slice(0,st+1).reduce((a,b)=>a+b,0)/(st+1);
    for(let i=st+1;i<arr.length;i++) r[i]=arr[i]*k+r[i-1]*(1-k);
    return r;
  };
  const ef=ema(closes,fast,fast-1), es=ema(closes,slow,slow-1);
  const dif=closes.map((_,i)=>ef[i]!=null&&es[i]!=null ? ef[i]-es[i] : null);
  const dc=dif.map(v=>v??0);
  const es2=ema(dc,sig,slow+sig-2);
  const hist=dif.map((v,i)=>v!=null&&es2[i]!=null ? v-es2[i] : null);
  return {dif,signal:es2,hist};
}

// ─────────────────────────────────────────────────────────────────────────────
// 同股去重：同一 code 在 cooldown 天內只保留第一次觸發
// ─────────────────────────────────────────────────────────────────────────────
function _dedup(signals, cooldownDays) {
  const lastHit = new Map(); // code → lastTimestamp
  const out = [];
  for (const s of signals) {
    const prev = lastHit.get(s.code);
    if (prev !== undefined) {
      // 用日期字串比較（s.date = 'YYYY/MM/DD'）
      const daysDiff = _daysBetween(prev, s.date);
      if (daysDiff < cooldownDays) continue;
    }
    lastHit.set(s.code, s.date);
    out.push(s);
  }
  return out;
}

function _daysBetween(d1, d2) {
  // d1, d2 are 'YYYY/MM/DD'
  const t1 = new Date(d1.replace(/\//g, '-')).getTime();
  const t2 = new Date(d2.replace(/\//g, '-')).getTime();
  return Math.round(Math.abs(t2 - t1) / 86400000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 單股回測（傳回帶 code 的 signals，供 dedup 使用）
// ─────────────────────────────────────────────────────────────────────────────
function _backtestOne(candles, stratId, holdDays, code) {
  const strat = EXPERIMENTAL_STRATEGIES[stratId];
  if (!strat || candles.length < strat.minCandles) return [];
  const signals = [], max = candles.length - holdDays - 1;

  // 系統發現策略：engine GAS evaluator（預算一次，逐根 O(1)；只取新觸發避免連續灌水）
  const gasEval = strat.gasConds ? buildGasEvaluator(candles) : null;

  for (let i = strat.minCandles; i <= max; i++) {
    let hit = false;
    if (gasEval) {
      hit = gasEval(i, strat.gasConds) && !gasEval(i - 1, strat.gasConds);
    } else {
      const sliced = candles.slice(0, i+1);
      try { hit = strat.calc(sliced); } catch {}
    }
    if (!hit) continue;
    const entry = candles[i].close, exit = candles[i+holdDays].close;
    const ret = strat.direction === 'short'
      ? (entry - exit) / entry * 100
      : (exit - entry) / entry * 100;
    signals.push({
      code, date: tsToDate(candles[i].time),
      entry, exit, ret: +ret.toFixed(2), win: ret > 0,
    });
  }
  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// 全市場掃描
// ─────────────────────────────────────────────────────────────────────────────
let _expAbort = null;
let _scanAborted = false;

// ── D 系列即時全市場掃描（2026-06-10）──────────────────────────────────
// 吃 IDB kline_cache（bundle 每日灌入全市場 1y），engine GAS evaluator 逐根判定
// 取代舊的 Z 系列 R2 閱讀器（_loadGasResult 保留未綁定，要查歷史 Z 數據可手動呼叫）
async function _runMarketScan() {
  if (window.__userTier !== 'vvvip') { dengToast('真實驗室為 VVVIP 專屬'); return; }
  const strats = Object.values(EXPERIMENTAL_STRATEGIES).filter(s => s.gasConds);
  if (!strats.length) { dengToast('系統發現策略尚未載入（R2 可能還沒有名人堂）'); return; }

  const holdDays = parseInt(document.getElementById('expHoldSelect')?.value ?? '10');
  const resultEl  = document.getElementById('labExpResult');
  const emptyEl   = document.getElementById('labExpEmpty');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressTxt = document.getElementById('labProgressText');
  const runBtn   = document.getElementById('labRunExperiment');
  const abortBtn = document.getElementById('labExpAbortBtn');

  _scanAborted = false;
  if (runBtn)   runBtn.style.display = 'none';
  if (abortBtn) abortBtn.style.display = '';
  if (emptyEl)  emptyEl.style.display = 'none';
  if (progressEl) progressEl.style.display = '';

  try {
    // 全市場 K 線：IDB kline_cache（bundle 灌入，1y）
    const rows = (await dbGetAll('kline_cache'))
      .filter(r => r.period === '1y' && /^\d{4,5}$/.test(r.symbol?.split('.')[0] ?? '') &&
                   !r.symbol.startsWith('00') && (r.candles?.length ?? 0) >= 80);

    const rawSignals = {};   // sid → signals[]
    strats.forEach(s => { rawSignals[s.id] = []; });

    for (let si = 0; si < rows.length; si++) {
      if (_scanAborted) break;
      const row = rows[si];
      const code = row.symbol.split('.')[0];
      const candles = row.candles;
      let ev;
      try { ev = buildGasEvaluator(candles); } catch { continue; }

      for (const strat of strats) {
        const hd = strat.hold ?? holdDays;   // 各策略自帶持有期（名人堂發現值）
        const max = candles.length - hd - 1;
        for (let i = 61; i <= max; i++) {
          if (!ev(i, strat.gasConds)) continue;
          if (ev(i - 1, strat.gasConds)) continue;   // 只取新觸發
          const entry = candles[i].close, exit = candles[i + hd].close;
          if (!(entry > 0)) continue;
          const ret = (exit - entry) / entry * 100;
          rawSignals[strat.id].push({
            code, name: getChineseName(code) || '',
            date: tsToDate(candles[i].time),
            entry, exit, ret: +ret.toFixed(2), win: ret > 0,
          });
        }
      }

      if (si % 50 === 0) {
        const pct = Math.round(si / rows.length * 100);
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressTxt) progressTxt.textContent = `掃描中 ${si}/${rows.length}（${strats.length} 個系統發現策略）`;
        await new Promise(r => setTimeout(r, 0));   // 讓出 UI
      }
    }

    // 同股去重 + 統計
    const stats = {};
    for (const strat of strats) {
      const sorted  = rawSignals[strat.id].sort((a, b) => a.date.localeCompare(b.date));
      const deduped = _dedup(sorted, strat.hold ?? holdDays);
      const wins = deduped.filter(s => s.win).length;
      const avg  = deduped.length ? deduped.reduce((a, s) => a + s.ret, 0) / deduped.length : 0;
      stats[strat.id] = {
        wins, total: deduped.length, rawTotal: sorted.length,
        avgRet: avg, samples: deduped.slice(-20).reverse(),
      };
    }

    resultEl.style.display = 'block';
    _renderScanResult(resultEl, { stats, total: rows.length, holdDays });
    const copyBtn = document.getElementById('labExpCopyBtn');
    if (copyBtn) copyBtn.style.display = '';

    // 自動留案底：1Y 掃描結果寫 IDB，晉升名人堂時系統鑑定用
    const today = new Date().toISOString().slice(0, 10);
    for (const strat of strats) {
      const st = stats[strat.id];
      if (!st) continue;
      const key = 'sv:' + strat.gasConds.join('+') + '@' + (strat.hold ?? holdDays);
      const prev = await dbGet('config', key).catch(() => null);
      await dbPut('config', {
        ...(prev ?? {}), key,
        scan1y: { wr: +((st.wins / Math.max(st.total, 1)) * 100).toFixed(1), avg: +st.avgRet.toFixed(2), n: st.total, at: today },
      }).catch(() => {});
    }
  } catch (e) {
    dengToast('掃描失敗：' + e.message);
  } finally {
    if (progressEl) progressEl.style.display = 'none';
    if (runBtn)   runBtn.style.display = '';
    if (abortBtn) abortBtn.style.display = 'none';
  }
}

// ── 共用：全市場收集各 D 策略觸發點（只取新觸發）─────────────────────────
async function _collectTriggers(strats, progressLabel) {
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressTxt = document.getElementById('labProgressText');
  if (progressEl) progressEl.style.display = '';

  const rows = (await dbGetAll('kline_cache'))
    .filter(r => r.period === '1y' && /^\d{4,5}$/.test(r.symbol?.split('.')[0] ?? '') &&
                 !r.symbol.startsWith('00') && (r.candles?.length ?? 0) >= 80);

  const triggers = {};   // sid → [{code, candles, i}]
  strats.forEach(s => { triggers[s.id] = []; });

  for (let si = 0; si < rows.length; si++) {
    if (_scanAborted) break;
    const row = rows[si];
    const code = row.symbol.split('.')[0];
    const candles = row.candles;
    let ev;
    try { ev = buildGasEvaluator(candles); } catch { continue; }
    for (const strat of strats) {
      for (let i = 61; i < candles.length - 1; i++) {
        if (!ev(i, strat.gasConds)) continue;
        if (ev(i - 1, strat.gasConds)) continue;
        triggers[strat.id].push({ code, candles, i });
      }
    }
    if (si % 50 === 0) {
      if (progressBar) progressBar.style.width = Math.round(si / rows.length * 100) + '%';
      if (progressTxt) progressTxt.textContent = `${progressLabel} ${si}/${rows.length}`;
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return { triggers, total: rows.length };
}

function _statLine(rets) {
  if (!rets.length) return { wr: 0, avg: 0, n: 0 };
  const wins = rets.filter(r => r > 0).length;
  return { wr: wins / rets.length * 100, avg: rets.reduce((a, b) => a + b, 0) / rets.length, n: rets.length };
}
const _stCell = (st, bold) => {
  const col = st.avg > 0 ? '#ef5350' : '#26a69a';   // 台股慣例：正紅負綠
  return `<td style="padding:8px 10px;text-align:right;${bold ? 'font-weight:700;' : ''}color:${col}">
    ${st.n ? `${st.avg > 0 ? '+' : ''}${st.avg.toFixed(2)}%<div style="font-size:10px;color:var(--muted)">${st.wr.toFixed(0)}% / ${st.n}筆</div>` : '<span style="color:var(--muted)">—</span>'}
  </td>`;
};

// ── 本機驗證 ①：持有期比較（取代 Z 序列回測閱讀器）────────────────────────
const _HOLD_GRID = [5, 10, 20, 40, 60];

async function _runHoldCompare() {
  if (window.__userTier !== 'vvvip') { dengToast('真實驗室為 VVVIP 專屬'); return; }
  const strats = Object.values(EXPERIMENTAL_STRATEGIES).filter(s => s.gasConds);
  if (!strats.length) { dengToast('系統發現策略尚未載入'); return; }

  const resultEl = document.getElementById('labExpResult');
  const emptyEl  = document.getElementById('labExpEmpty');
  const progressEl = document.getElementById('labProgress');
  _scanAborted = false;
  if (emptyEl) emptyEl.style.display = 'none';

  try {
    // 同條件組合去重（不同持有期的 D 在矩陣裡完全相同）
    const seen = new Set();
    const uniq = strats.filter(s => {
      const k = s.gasConds.join('+');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const { triggers, total } = await _collectTriggers(uniq, '持有期比較');

    const rows = uniq.map(strat => {
      const cells = _HOLD_GRID.map(hd => {
        const rets = [];
        for (const t of triggers[strat.id]) {
          const exitIdx = t.i + hd;
          if (exitIdx >= t.candles.length) continue;
          const e = t.candles[t.i].close, x = t.candles[exitIdx].close;
          if (e > 0) rets.push((x - e) / e * 100);
        }
        return _statLine(rets);
      });
      const bestIdx = cells.reduce((b, st, idx) => st.avg > cells[b].avg ? idx : b, 0);
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px;font-size:12px">🔮 <b>${strat.id}</b> <span style="color:var(--muted);font-size:11px">${strat.name}</span></td>
        ${cells.map((st, idx) => _stCell(st, idx === bestIdx)).join('')}
      </tr>`;
    }).join('');

    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;font-weight:600">⛓️ 持有期比較（本機・1y K線・收盤進出）<span style="font-size:11px;color:var(--muted);font-weight:400;margin-left:8px">掃描 ${total} 支・粗體 = 該策略最佳持有期</span></div>
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--bg2);font-size:11px;color:var(--muted)">
            <th style="padding:7px 10px;text-align:left">策略</th>
            ${_HOLD_GRID.map(h => `<th style="padding:7px 10px;text-align:right">${h}日</th>`).join('')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:8px">⚠ 窗口與發現窗重疊（in-sample），用於看持有期的相對形狀，絕對數字以組合回測為準</div>`;
  } catch (e) {
    dengToast('持有期比較失敗：' + e.message);
  } finally {
    if (progressEl) progressEl.style.display = 'none';
  }
}

// ── 本機驗證 ②：出場機制比較（取代 Z 出場比較閱讀器）──────────────────────
async function _runExitCompare() {
  if (window.__userTier !== 'vvvip') { dengToast('真實驗室為 VVVIP 專屬'); return; }
  const strats = Object.values(EXPERIMENTAL_STRATEGIES).filter(s => s.gasConds);
  if (!strats.length) { dengToast('系統發現策略尚未載入'); return; }

  const resultEl = document.getElementById('labExpResult');
  const emptyEl  = document.getElementById('labExpEmpty');
  const progressEl = document.getElementById('labProgress');
  _scanAborted = false;
  if (emptyEl) emptyEl.style.display = 'none';

  const MAX_HOLD = 60;
  const EXITS = ['fixed', 'stop8', 'threeLine', 'ma20Break'];
  const EXIT_LABELS = { fixed: '固定持有（名人堂值）', stop8: '停損8%+滿期', threeLine: '三線出場（-20%/高點-25%）', ma20Break: '跌破MA20' };

  try {
    const { triggers, total } = await _collectTriggers(strats, '出場比較');

    const rows = strats.map(strat => {
      const buckets = { fixed: [], stop8: [], threeLine: [], ma20Break: [] };
      const holdSum = { fixed: 0, stop8: 0, threeLine: 0, ma20Break: 0 };

      for (const t of triggers[strat.id]) {
        const { candles, i } = t;
        const entry = candles[i].close;
        if (!(entry > 0)) continue;
        const lim = Math.min(candles.length - 1, i + MAX_HOLD);
        const fixedIdx = i + (strat.hold ?? 20);

        // ma20 即算（只算需要的範圍）
        const ma20At = idx => {
          if (idx < 19) return null;
          let s = 0; for (let k = idx - 19; k <= idx; k++) s += candles[k].close;
          return s / 20;
        };

        let peak = entry;
        let done = { fixed: false, stop8: false, threeLine: false, ma20Break: false };

        for (let j = i + 1; j <= lim; j++) {
          const px = candles[j].close;
          peak = Math.max(peak, px);

          if (!done.fixed && (j >= fixedIdx || j === lim)) {
            buckets.fixed.push((px - entry) / entry * 100); holdSum.fixed += j - i; done.fixed = true;
          }
          if (!done.stop8 && (px <= entry * 0.92 || j >= fixedIdx || j === lim)) {
            buckets.stop8.push((px - entry) / entry * 100); holdSum.stop8 += j - i; done.stop8 = true;
          }
          if (!done.threeLine) {
            const line = Math.max(entry * 0.80, peak * 0.75);
            if (px < line || j === lim) {
              buckets.threeLine.push((px - entry) / entry * 100); holdSum.threeLine += j - i; done.threeLine = true;
            }
          }
          if (!done.ma20Break) {
            const m = ma20At(j);
            if ((m != null && px < m) || j === lim) {
              buckets.ma20Break.push((px - entry) / entry * 100); holdSum.ma20Break += j - i; done.ma20Break = true;
            }
          }
          if (done.fixed && done.stop8 && done.threeLine && done.ma20Break) break;
        }
      }

      const cells = EXITS.map(k => ({ ...(_statLine(buckets[k])), avgHold: buckets[k].length ? holdSum[k] / buckets[k].length : 0 }));
      const bestIdx = cells.reduce((b, st, idx) => st.avg > cells[b].avg ? idx : b, 0);
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px;font-size:12px">🔮 <b>${strat.id}</b> <span style="color:var(--muted);font-size:11px">${strat.name}</span></td>
        ${cells.map((st, idx) => {
          const col = st.avg > 0 ? '#ef5350' : '#26a69a';
          return `<td style="padding:8px 10px;text-align:right;${idx === bestIdx ? 'font-weight:700;' : ''}color:${col}">
            ${st.n ? `${st.avg > 0 ? '+' : ''}${st.avg.toFixed(2)}%<div style="font-size:10px;color:var(--muted)">${st.wr.toFixed(0)}%・均持 ${st.avgHold.toFixed(0)}天・${st.n}筆</div>` : '—'}
          </td>`;
        }).join('')}
      </tr>`;
    }).join('');

    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;font-weight:600">🎯 出場機制比較（本機・1y K線・收盤判定收盤出場）<span style="font-size:11px;color:var(--muted);font-weight:400;margin-left:8px">掃描 ${total} 支・上限 ${MAX_HOLD} 日・粗體 = 該策略最佳出場</span></div>
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--bg2);font-size:11px;color:var(--muted)">
            <th style="padding:7px 10px;text-align:left">策略</th>
            ${EXITS.map(k => `<th style="padding:7px 10px;text-align:right">${EXIT_LABELS[k]}</th>`).join('')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:8px">⚠ 出場用收盤判定收盤成交（樂觀近似，實際 T+1 開盤會差一截）；三線出場參數沿用妖股實證（停損-20% / 高點回落25%）</div>`;
  } catch (e) {
    dengToast('出場比較失敗：' + e.message);
  } finally {
    if (progressEl) progressEl.style.display = 'none';
  }
}


async function _loadExitResult(btn) {
  const el  = document.getElementById('labExpResult');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '讀取中…'; btn.disabled = true; }
  try {
    const WORKER = 'https://stock-2027.luffy0606.workers.dev';
    const TOKEN  = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
    const res = await fetch(`${WORKER}/exit-comparison`, {
      headers: { 'X-Proxy-Token': TOKEN }, cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    el.style.display = 'block';
    document.getElementById('labExpEmpty').style.display = 'none';
    _renderExitResult(el, data);
  } catch(e) {
    dengToast('❌ 出場比較讀取失敗：' + e.message);
  } finally {
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}

async function _loadSeqResult(btn) {
  const el  = document.getElementById('labExpResult');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '讀取中…'; btn.disabled = true; }
  try {
    const WORKER = 'https://stock-2027.luffy0606.workers.dev';
    const TOKEN  = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
    const res = await fetch(`${WORKER}/z-seq`, {
      headers: { 'X-Proxy-Token': TOKEN }, cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    el.style.display = 'block';
    document.getElementById('labExpEmpty').style.display = 'none';
    _renderSeqResult(el, data, 5);
  } catch(e) {
    dengToast('❌ 序列結果讀取失敗：' + e.message);
    console.error('[lab-experiment] seq', e);
  } finally {
    if (btn) { btn.textContent = old; btn.disabled = false; }
  }
}


async function _loadGasResult() {
  if (window.__userTier !== 'vvvip') { dengToast('真實驗室為 VVVIP 專屬'); return; }

  const holdDays    = parseInt(document.getElementById('expHoldSelect')?.value ?? '10');
  const runBtn      = document.getElementById('labRunExperiment');
  const abortBtn    = document.getElementById('labExpAbortBtn');
  const resultEl    = document.getElementById('labExpResult');
  const emptyEl     = document.getElementById('labExpEmpty');
  const progressEl  = document.getElementById('labProgress');
  const progressBar = document.getElementById('labProgressBar');
  const progressText= document.getElementById('labProgressText');
  const copyBtn     = document.getElementById('labExpCopyBtn');

  runBtn.style.display     = 'none';
  if (copyBtn) copyBtn.style.display = 'none';
  emptyEl.style.display    = 'none';
  resultEl.style.display   = 'none';
  progressEl.style.display = '';
  progressBar.style.width  = '30%';
  progressText.textContent = '讀取 GAS 回測結果...';

  try {
    const WORKER = 'https://stock-2027.luffy0606.workers.dev';
    const TOKEN  = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
    const res = await fetch(`${WORKER}/z-backtest`, {
      headers: { 'X-Proxy-Token': TOKEN },
      cache: 'no-store',
    });

    if (res.status === 404) {
      emptyEl.innerHTML = `
        <div style="text-align:center;padding:40px 20px">
          <div style="font-size:32px;margin-bottom:12px">🧪</div>
          <div style="font-size:14px;color:var(--text);margin-bottom:8px">尚無回測結果</div>
          <div style="font-size:12px;color:var(--muted)">請先在 GAS 執行 <code style="background:#1a1a1a;padding:2px 6px;border-radius:4px">runZBacktest()</code></div>
        </div>`;
      emptyEl.style.display = '';
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);

    progressBar.style.width  = '80%';
    progressText.textContent = '解析結果...';

    const data = await res.json();
    _renderGasResult(resultEl, data, holdDays);
    resultEl.style.display = '';
    if (copyBtn) copyBtn.style.display = '';

  } catch(e) {
    dengToast('讀取失敗：' + e.message);
    console.error('[lab-experiment]', e);
  } finally {
    progressEl.style.display = 'none';
    runBtn.style.display     = '';
    if (abortBtn) abortBtn.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染：GAS 回測結果（三組 holdDays，可切換）
// ─────────────────────────────────────────────────────────────────────────────
// 出場機制比較渲染
// ─────────────────────────────────────────────────────────────────────────────
function _renderExitResult(el, data) {
  const mechs   = data.mechanisms ?? {};
  const ids     = Object.keys(mechs);
  const runAt   = data.runAt ? new Date(data.runAt).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'}) : '—';

  // 找最高 avgRet 和最高 efficiency 的機制（用於標示最佳）
  const bestRet = ids.reduce((b,id) => mechs[id].avgRet > mechs[b].avgRet ? id : b, ids[0]);
  const bestMG  = ids.reduce((b,id) => (mechs[id].avgMaxGainAtExit??0) > (mechs[b].avgMaxGainAtExit??0) ? id : b, ids[0]);

  const rows = ids.map(id => {
    const m   = mechs[id];
    const wr  = m.winRate ?? 0;
    const ar  = m.avgRet  ?? 0;
    const mg  = m.avgMaxGain ?? 0;
    const hd  = m.avgHoldDays ?? 0;
    const mg2 = m.avgMaxGainAtExit ?? 0;
    const tr  = m.triggerRate ?? 0;
    const isBestRet = id === bestRet;
    const isBestMG  = id === bestMG;
    const retColor = ar > 0 ? '#26a69a' : '#ef5350';
    const wrColor  = wr >= 55 ? '#26a69a' : wr >= 40 ? '#fbbf24' : '#ef5350';
    return `<tr style="border-bottom:1px solid var(--border)${isBestRet?' background:rgba(38,166,154,0.06)':''}">
      <td style="padding:9px 10px">
        <span style="font-size:15px">${m.icon}</span>
        <span style="font-weight:700;margin-left:4px;font-size:13px">${id}</span>
        ${isBestRet ? '<span style="font-size:10px;color:#26a69a;margin-left:4px;border:1px solid #26a69a55;padding:1px 5px;border-radius:3px">最高均報</span>' : ''}
        ${isBestMG  ? '<span style="font-size:10px;color:#fbbf24;margin-left:4px;border:1px solid #fbbf2455;padding:1px 5px;border-radius:3px">最高浮盈</span>' : ''}
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${m.name}</div>
      </td>
      <td style="padding:9px 10px;text-align:right;font-weight:700;color:${wrColor}">${wr.toFixed(1)}%</td>
      <td style="padding:9px 10px;text-align:right;font-weight:700;color:${retColor}">${ar>0?'+':''}${ar.toFixed(2)}%</td>
      <td style="padding:9px 10px;text-align:right;color:#26a69a">+${mg.toFixed(2)}%</td>
      <td style="padding:9px 10px;text-align:right;color:#26a69a">+${mg2.toFixed(2)}%</td>
      <td style="padding:9px 10px;text-align:right;font-size:11px;color:${tr>=50?'#26a69a':'var(--muted)'}">${tr.toFixed(1)}%</td>
      <td style="padding:9px 10px;text-align:right;color:var(--muted);font-size:11px">${hd.toFixed(1)}天</td>
      <td style="padding:9px 10px;text-align:right;color:var(--muted);font-size:11px">${m.total}</td>
    </tr>`;
  }).join('');

  // 樣本明細
  const details = ids.map(id => {
    const m = mechs[id];
    const samples = m.samples ?? [];
    if (!samples.length) return '';
    const ar = m.avgRet ?? 0;
    const eff = m.avgMaxGainAtExit ?? 0;
    const rows2 = samples.slice().sort((a,b) => b.ret - a.ret).slice(0, 30).map(s => `
      <tr>
        <td style="padding:3px 7px;font-size:11px;color:var(--muted)">${s.entryDate}</td>
        <td style="padding:3px 7px;font-size:11px;color:var(--muted)">${s.exitDate}</td>
        <td style="padding:3px 7px;font-size:11px">${s.code}</td>
        <td style="padding:3px 7px;text-align:right;font-size:11px">${s.entry}</td>
        <td style="padding:3px 7px;text-align:right;font-size:11px">${s.exit}</td>
        <td style="padding:3px 7px;text-align:right;font-size:11px;font-weight:600;color:${s.ret>0?'#26a69a':'#ef5350'}">${s.ret>0?'+':''}${s.ret}%</td>
        <td style="padding:3px 7px;text-align:right;font-size:11px;color:#26a69a">+${s.maxGainAtExit??0}%</td>
        <td style="padding:3px 7px;text-align:right;font-size:11px;color:var(--muted)">${s.holdDays}日</td>
      </tr>`).join('');
    return `
      <details style="margin-bottom:8px;border:1px solid var(--border);border-radius:7px;overflow:hidden">
        <summary style="padding:8px 12px;cursor:pointer;background:var(--bg2);display:flex;align-items:center;gap:7px;list-style:none">
          <span style="font-size:14px">${m.icon}</span>
          <span style="font-weight:600;font-size:13px">${m.name}</span>
          <span style="margin-left:auto;font-size:11px;color:${ar>0?'#26a69a':'#ef5350'}">${ar>0?'+':''}${ar.toFixed(2)}% ・ 最高+${(m.avgMaxGainAtExit??0).toFixed(2)}%</span>
          <span style="color:var(--muted);font-size:11px">▾</span>
        </summary>
        <div style="padding:8px;overflow-x:auto">
          <div style="font-size:11px;color:var(--muted);margin-bottom:5px">${m.desc}</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="color:var(--muted);font-size:10px">
              <th style="padding:3px 7px;text-align:left">進場日</th>
              <th style="padding:3px 7px;text-align:left">出場日</th>
              <th style="padding:3px 7px;text-align:left">代號</th>
              <th style="padding:3px 7px;text-align:right">進場</th>
              <th style="padding:3px 7px;text-align:right">出場</th>
              <th style="padding:3px 7px;text-align:right">報酬</th>
              <th style="padding:3px 7px;text-align:right">最大浮盈</th>
              <th style="padding:3px 7px;text-align:right">持有期最高</th>
              <th style="padding:3px 7px;text-align:right">持有</th>
            </tr></thead>
            <tbody>${rows2}</tbody>
          </table>
        </div>
      </details>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="font-size:13px;font-weight:600">🎯 X系列出場機制比較</div>
      <div style="font-size:11px;color:var(--muted)">${data.total} 支 · ${runAt}</div>
      <button class="lab-copy-btn" id="exitCopyBtn" style="margin-left:auto;font-size:11px;padding:2px 10px">📋 複製結果</button>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:10px">持有期最高 = 進場到出場期間，股價觸及的最高報酬（最多賺過多少）・訊號觸發率 = 真正有訊號觸發出場的比例</div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px;margin-bottom:14px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--bg2);font-size:10px;color:var(--muted)">
          <th style="padding:6px 10px;text-align:left">機制</th>
          <th style="padding:6px 10px;text-align:right">勝率</th>
          <th style="padding:6px 10px;text-align:right">均報</th>
          <th style="padding:6px 10px;text-align:right">最大浮盈</th>
          <th style="padding:6px 10px;text-align:right">持有期最高</th>
          <th style="padding:6px 10px;text-align:right">訊號觸發率</th>
          <th style="padding:6px 10px;text-align:right">平均持有</th>
          <th style="padding:6px 10px;text-align:right">樣本</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">各機制樣本明細（點擊展開）</div>
    <div id="exitDetails">${details}</div>`;

  el.querySelector('#exitCopyBtn')?.addEventListener('click', () => {
    const lines = ['X系列出場機制比較'];
    lines.push('執行時間：' + runAt);
    lines.push('掃描支數：' + data.total);
    lines.push('');
    lines.push('機制\t勝率\t均報\t持有期最高\t訊號觸發率\t平均持有\t樣本');
    ids.forEach(function(id) {
      const m = mechs[id];
      lines.push([m.name,
        (m.winRate??0).toFixed(1)+'%', (m.avgRet??0).toFixed(2)+'%',
        '+'+(m.avgMaxGainAtExit??0).toFixed(2)+'%',
        (m.triggerRate??0).toFixed(1)+'%', (m.avgHoldDays??0).toFixed(1)+'天', m.total].join('\t'));
    });
    navigator.clipboard?.writeText(lines.join('\n')).then(() => dengToast('✓ 已複製出場比較結果'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 序列回測渲染（SEQ_A / SEQ_B / SEQ_C 三組比較）
// ─────────────────────────────────────────────────────────────────────────────
function _renderSeqResult(el, data, activeHold) {
  const holdDays   = data.holdDays ?? [5, 10, 20];
  const stopLosses = data.stopLoss ?? [3, 5, 8];
  const strategies = data.strategies ?? {};
  const stratIds   = Object.keys(strategies);
  const runAt      = data.runAt ? new Date(data.runAt).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'}) : '—';

  let activeSL = stopLosses[1] ?? stopLosses[0];  // 預設停損 5%

  function getSt(sid, hd, sl) {
    const bySL = strategies[sid]?.byHold?.[hd]?.bySL?.[sl];
    return bySL ?? {};
  }

  function renderTable(hd, sl) {
    return stratIds.map(sid => {
      const s  = strategies[sid];
      const st = getSt(sid, hd, sl);
      const wr = st.winRate ?? 0, ar = st.avgRet ?? 0, mg = st.avgMaxGain ?? 0;
      const wrColor  = wr >= 55 ? '#26a69a' : wr >= 40 ? '#fbbf24' : '#ef5350';
      const retColor = ar > 0 ? '#26a69a' : '#ef5350';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px">
          <span style="font-size:14px">${s.icon}</span>
          <span style="font-weight:700;margin-left:4px">${sid}</span>
          <span style="color:var(--muted);font-size:11px;margin-left:4px">${s.name}</span>
        </td>
        <td style="padding:8px 10px;text-align:right;font-weight:700;color:${wrColor}">${wr.toFixed(1)}%</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700;color:${retColor}">${ar>0?'+':''}${ar.toFixed(2)}%</td>
        <td style="padding:8px 10px;text-align:right;color:#26a69a">+${mg.toFixed(2)}%</td>
        <td style="padding:8px 10px;text-align:right;color:var(--muted);font-size:11px">${st.slRate??0}%</td>
        <td style="padding:8px 10px;text-align:right;color:var(--muted);font-size:11px">${st.total??0}</td>
        <td style="padding:8px 10px;text-align:center">
          ${st.pass
            ? '<span style="color:#26a69a;font-size:11px;background:#0d2018;padding:2px 7px;border-radius:4px;border:1px solid #26a69a55">✅ 達標</span>'
            : '<span style="color:#ef5350;font-size:11px;background:#200d0d;padding:2px 7px;border-radius:4px;border:1px solid #ef535055">❌ 未達</span>'}
        </td>
      </tr>`;
    }).join('');
  }

  function renderDetails(hd, sl) {
    return stratIds.map(sid => {
      const s = strategies[sid];
      const st = getSt(sid, hd, sl);
      const samples = st.samples ?? [];
      if (!samples.length) return '';
      const wr = st.winRate??0, ar = st.avgRet??0;
      const col = st.pass ? '#26a69a' : '#ef5350';
      const rows = samples.map(sp => `
        <tr>
          <td style="padding:3px 7px;font-size:11px;color:var(--muted)">${sp.predictDate??sp.z1Date??'—'}</td>
          <td style="padding:3px 7px;font-size:11px;color:var(--muted)">${sp.date}</td>
          <td style="padding:3px 7px;font-size:11px">${sp.code}</td>
          <td style="padding:3px 7px;text-align:center;font-size:11px;color:#fbbf24">+${sp.gap??'?'}天</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px">${sp.entry}</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px;font-weight:600;color:${sp.win?'#26a69a':'#ef5350'}">${sp.ret>0?'+':''}${sp.ret}%</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px;color:#26a69a">+${sp.maxGain??0}%</td>
        </tr>`).join('');
      return `
        <details style="margin-bottom:8px;border:1px solid var(--border);border-radius:7px;overflow:hidden">
          <summary style="padding:8px 12px;cursor:pointer;background:var(--bg2);display:flex;align-items:center;gap:7px;list-style:none">
            <span style="font-size:14px">${s.icon}</span>
            <span style="font-weight:600;font-size:13px">${sid} ${s.name}</span>
            <span style="margin-left:auto;font-size:11px;color:${col}">${wr.toFixed(1)}% / ${ar>0?'+':''}${ar.toFixed(2)}%</span>
            <span style="color:var(--muted);font-size:11px">▾</span>
          </summary>
          <div style="padding:8px;overflow-x:auto">
            <div style="font-size:11px;color:var(--muted);margin-bottom:5px">${s.desc}</div>
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="color:var(--muted);font-size:10px">
                <th style="padding:3px 7px;text-align:left">預告日</th>
                <th style="padding:3px 7px;text-align:left">進場日</th>
                <th style="padding:3px 7px;text-align:left">代號</th>
                <th style="padding:3px 7px;text-align:center">間距</th>
                <th style="padding:3px 7px;text-align:right">進場</th>
                <th style="padding:3px 7px;text-align:right">報酬</th>
                <th style="padding:3px 7px;text-align:right">最大浮盈</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </details>`;
    }).join('');
  }

  const holdTabHtml = holdDays.map(hd =>
    `<button class="lab-copy-btn seq-hold-tab${hd===activeHold?' active':''}" data-hd="${hd}"
      style="font-size:12px;padding:3px 9px${hd===activeHold?';color:var(--down);border-color:var(--down)':''}">${hd}日</button>`
  ).join('');

  const slTabHtml = stopLosses.map(sl =>
    `<button class="lab-copy-btn seq-sl-tab${sl===activeSL?' active':''}" data-sl="${sl}"
      style="font-size:11px;padding:2px 8px${sl===activeSL?';color:#fbbf24;border-color:#fbbf24':''}"
      >停損${sl}%</button>`
  ).join('');

  el.innerHTML = `
    <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="font-size:13px;font-weight:600">⛓️ Z 序列回測：妖股進行中 → 預告 → 進場</div>
      <div style="font-size:11px;color:var(--muted)">${data.total} 支 · 間距≤${data.seqMaxGap??5}天 · ${runAt}</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted)">持有：</span>${holdTabHtml}
      <span style="font-size:11px;color:var(--muted);margin-left:8px">停損：</span>${slTabHtml}
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px;margin-bottom:14px">
      <table style="width:100%;border-collapse:collapse" id="seqSummaryTable">
        <thead><tr style="background:var(--bg2);font-size:10px;color:var(--muted)">
          <th style="padding:6px 10px;text-align:left">序列</th>
          <th style="padding:6px 10px;text-align:right">勝率</th>
          <th style="padding:6px 10px;text-align:right">均報</th>
          <th style="padding:6px 10px;text-align:right">最大浮盈</th>
          <th style="padding:6px 10px;text-align:right">停損率</th>
          <th style="padding:6px 10px;text-align:right">樣本</th>
          <th style="padding:6px 10px;text-align:center">狀態</th>
        </tr></thead>
        <tbody id="seqTableBody">${renderTable(activeHold, activeSL)}</tbody>
      </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-size:11px;color:var(--muted)">各序列樣本明細（點擊展開）</div>
      <button class="lab-copy-btn" id="seqCopyBtn" style="font-size:11px;padding:2px 10px">📋 複製結果</button>
    </div>
    <div id="seqDetails">${renderDetails(activeHold, activeSL)}</div>`;

  function refresh() {
    document.getElementById('seqTableBody').innerHTML = renderTable(activeHold, activeSL);
    document.getElementById('seqDetails').innerHTML   = renderDetails(activeHold, activeSL);
    el.querySelectorAll('.seq-hold-tab').forEach(b => {
      const a = parseInt(b.dataset.hd)===activeHold;
      b.style.color=a?'var(--down)':''; b.style.borderColor=a?'var(--down)':'';
    });
    el.querySelectorAll('.seq-sl-tab').forEach(b => {
      const a = parseInt(b.dataset.sl)===activeSL;
      b.style.color=a?'#fbbf24':''; b.style.borderColor=a?'#fbbf24':'';
    });
  }

  el.querySelectorAll('.seq-hold-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeHold=parseInt(btn.dataset.hd); refresh(); });
  });
  el.querySelectorAll('.seq-sl-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeSL=parseInt(btn.dataset.sl); refresh(); });
  });

  el.querySelector('#seqCopyBtn')?.addEventListener('click', () => {
    const lines = ['Z 序列回測結果'];
    lines.push('執行時間：' + (data.runAt ? new Date(data.runAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}) : '—'));
    lines.push('掃描支數：' + data.total + '・間距≤' + (data.seqMaxGap??5) + '天');
    lines.push('');
    (data.holdDays??[5,10,20]).forEach(function(hd) {
      (data.stopLoss??[3,5,8]).forEach(function(sl) {
        lines.push('=== 持有'+hd+'日・停損'+sl+'% ===');
        lines.push('序列	勝率	均報	最大浮盈	停損率	樣本	狀態');
        Object.entries(data.strategies).forEach(([sid,s]) => {
          const st = s.byHold?.[hd]?.bySL?.[sl] ?? {};
          lines.push([sid+' '+s.name,
            (st.winRate??0).toFixed(1)+'%', (st.avgRet??0).toFixed(2)+'%',
            '+'+(st.avgMaxGain??0).toFixed(2)+'%', (st.slRate??0).toFixed(0)+'%',
            st.total??0, st.pass?'✅達標':'❌未達'].join('	'));
        });
        lines.push('');
      });
    });
    navigator.clipboard?.writeText(lines.join('\n')).then(() => dengToast('✓ 已複製序列結果'));
  });

  el._seqData = data;
}

// ─────────────────────────────────────────────────────────────────────────────
function _renderGasResult(el, data, activeHold) {
  const holdDays   = data.holdDays ?? [5, 10, 20];
  const stopLosses = data.stopLoss ?? [3, 5, 8];
  const runAt      = data.runAt ? new Date(data.runAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '—';
  const strategies = data.strategies ?? {};
  const stratIds   = Object.keys(strategies);

  // 當前選擇的停損/停利門檻
  let activeSL = stopLosses[0];
  const takeProfits = data.takeProfit ?? [];
  const tpOptions   = [0].concat(takeProfits);  // 0 = 不設停利
  let activeTP = 0;

  // 取某個 hd+sl+tp 組合的 st
  function getSt(sid, hd, sl) {
    const byHold = strategies[sid]?.byHold?.[hd];
    if (!byHold) return {};
    // 有 byTP 時讀 activeTP 那組
    const bySL = byHold.bySL?.[sl];
    if (bySL?.byTP) return bySL.byTP[activeTP] ?? bySL.byTP[0] ?? {};
    return bySL ?? byHold ?? {};
  }

  function getBest(sid, hd) {
    return strategies[sid]?.byHold?.[hd]?.best ?? null;
  }

  // 摘要表格（hd + sl 組合）
  function renderTable(hd, sl) {
    return stratIds.map(sid => {
      const s   = strategies[sid];
      const st  = getSt(sid, hd, sl);
      const wr  = st.winRate ?? 0;
      const ar  = st.avgRet  ?? 0;
      const mg  = st.avgMaxGain ?? 0;
      const slr = st.slRate ?? 0;
      const best = getBest(sid, hd);
      const isBest = best == sl;
      const wrColor  = wr >= 55 ? '#26a69a' : wr >= 40 ? '#fbbf24' : '#ef5350';
      const retColor = ar > 0 ? '#26a69a' : '#ef5350';
      const mgColor  = '#26a69a';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:7px 10px;font-size:13px">
          <span style="font-size:14px;margin-right:4px">${s.icon}</span>
          <span style="font-weight:600">${sid}</span>
          <span style="color:var(--muted);font-size:11px;margin-left:4px">${s.name}</span>
          ${isBest ? '<span style="font-size:10px;color:#fbbf24;margin-left:4px">★最佳</span>' : ''}
        </td>
        <td style="padding:7px 10px;text-align:right;font-size:14px;font-weight:700;color:${wrColor}">${wr.toFixed(1)}%</td>
        <td style="padding:7px 10px;text-align:right;font-size:14px;font-weight:700;color:${retColor}">${ar>0?'+':''}${ar.toFixed(2)}%</td>
        <td style="padding:7px 10px;text-align:right;font-size:13px;color:${mgColor}">+${mg.toFixed(2)}%</td>
        <td style="padding:7px 10px;text-align:right;font-size:11px;color:var(--muted)">${slr.toFixed(0)}%</td>
        <td style="padding:7px 10px;text-align:right;font-size:11px;color:${activeTP>0?'#4ade80':'var(--muted)'}">${(st.tpRate??0).toFixed(0)}%</td>
        <td style="padding:7px 10px;text-align:right;font-size:11px;color:var(--muted)">${st.total ?? 0}</td>
        <td style="padding:7px 10px;text-align:center">
          ${st.pass
            ? '<span style="color:#26a69a;font-size:11px;background:#0d2018;padding:2px 7px;border-radius:4px;border:1px solid #26a69a55">✅ 達標</span>'
            : '<span style="color:#ef5350;font-size:11px;background:#200d0d;padding:2px 7px;border-radius:4px;border:1px solid #ef535055">❌ 未達</span>'}
        </td>
      </tr>`;
    }).sort((a, b) => (b.includes('✅') ? 1 : 0) - (a.includes('✅') ? 1 : 0)).join('');
  }

  // 樣本明細
  function renderDetails(hd, sl) {
    return stratIds.map(sid => {
      const s   = strategies[sid];
      const st  = getSt(sid, hd, sl);
      const samples = st.samples ?? [];
      if (!samples.length) return '';
      const wr = st.winRate ?? 0, ar = st.avgRet ?? 0, mg = st.avgMaxGain ?? 0;
      const col = wr >= 35 && ar > 0 ? '#26a69a' : '#ef5350';
      const sRows = samples.map(sp => `
        <tr>
          <td style="padding:3px 7px;font-size:11px;color:var(--muted)">${sp.date}</td>
          <td style="padding:3px 7px;font-size:11px">${sp.code}</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px">${sp.entry}</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px">${sp.exit}</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px;font-weight:600;color:${sp.win?'#26a69a':'#ef5350'}">${sp.ret>0?'+':''}${sp.ret}%</td>
          <td style="padding:3px 7px;text-align:right;font-size:11px;color:#26a69a">+${sp.maxGain??0}%</td>
          <td style="padding:3px 7px;text-align:center;font-size:10px;color:${sp.stoppedOut?'#ef5350':'var(--muted)'}">${sp.stoppedOut?'停損':'時間'}</td>
        </tr>`).join('');
      return `
        <details style="margin-bottom:8px;border:1px solid var(--border);border-radius:7px;overflow:hidden">
          <summary style="padding:8px 12px;cursor:pointer;background:var(--bg2);display:flex;align-items:center;gap:7px;list-style:none">
            <span style="font-size:14px">${s.icon}</span>
            <span style="font-weight:600;font-size:13px">${sid} ${s.name}</span>
            <span style="margin-left:auto;font-size:11px;color:${col}">${wr.toFixed(1)}% 勝率 / ${ar>0?'+':''}${ar.toFixed(2)}% 均報 / 最大浮盈 +${mg.toFixed(2)}%</span>
            <span style="color:var(--muted);font-size:11px">▾</span>
          </summary>
          <div style="padding:8px;overflow-x:auto">
            <div style="font-size:11px;color:var(--muted);margin-bottom:5px">${s.desc} · 持有${hd}日 · 停損${sl}%</div>
            <table style="width:100%;border-collapse:collapse;font-size:11px">
              <thead><tr style="color:var(--muted);font-size:10px">
                <th style="padding:3px 7px;text-align:left">日期</th><th style="padding:3px 7px;text-align:left">代號</th>
                <th style="padding:3px 7px;text-align:right">進場</th><th style="padding:3px 7px;text-align:right">出場</th>
                <th style="padding:3px 7px;text-align:right">報酬</th><th style="padding:3px 7px;text-align:right">最大浮盈</th>
                <th style="padding:3px 7px;text-align:center">出場方式</th>
              </tr></thead>
              <tbody>${sRows}</tbody>
            </table>
          </div>
        </details>`;
    }).join('');
  }

  const passCount = (hd, sl) => stratIds.filter(sid => getSt(sid, hd, sl).pass).length;

  const holdTabHtml = holdDays.map(hd =>
    `<button class="lab-copy-btn exp-hold-tab${hd===activeHold?' active':''}" data-hd="${hd}"
      style="font-size:12px;padding:3px 9px${hd===activeHold?';color:var(--down);border-color:var(--down)':''}">${hd}日</button>`
  ).join('');

  const slTabHtml = stopLosses.map(sl =>
    `<button class="lab-copy-btn exp-sl-tab${sl===activeSL?' active':''}" data-sl="${sl}"
      style="font-size:11px;padding:2px 8px${sl===activeSL?';color:#fbbf24;border-color:#fbbf24':''}"
      title="反彈超過 ${sl}% 停損">停損${sl}%</button>`
  ).join('');

  const tpTabHtml = tpOptions.map(tp =>
    `<button class="lab-copy-btn exp-tp-tab${tp===activeTP?' active':''}" data-tp="${tp}"
      style="font-size:11px;padding:2px 8px${tp===activeTP?';color:#4ade80;border-color:#4ade80':''}"
      title="${tp===0?'不設停利':'下跌超過 '+tp+'% 停利出場'}">${tp===0?'不設停利':'停利'+tp+'%'}</button>`
  ).join('');

  el.innerHTML = `
    <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="font-size:13px;font-weight:600">🧪 Z 系列回測（GAS 2Y K線・次日開盤進場）</div>
      <div style="font-size:11px;color:var(--muted)">掃描 ${data.total} 支 · ${runAt}${data.timedOut?' · ⚠️ 未完整':''}</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted)">持有：</span>${holdTabHtml}
      <span style="font-size:11px;color:var(--muted);margin-left:8px">停損：</span>${slTabHtml}
      <span style="font-size:11px;color:var(--muted);margin-left:8px">停利：</span>${tpTabHtml}
      <div id="expPassBadge" style="margin-left:auto;font-size:11px;padding:3px 9px;background:#0d2018;border:1px solid #26a69a44;border-radius:5px;color:#26a69a">
        ${passCount(activeHold,activeSL)}/${stratIds.length} 達標
      </div>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px;margin-bottom:14px">
      <table style="width:100%;border-collapse:collapse" id="expSummaryTable">
        <thead><tr style="background:var(--bg2);font-size:10px;color:var(--muted)">
          <th style="padding:6px 10px;text-align:left">策略</th>
          <th style="padding:6px 10px;text-align:right">勝率</th>
          <th style="padding:6px 10px;text-align:right">均報</th>
          <th style="padding:6px 10px;text-align:right">最大浮盈</th>
          <th style="padding:6px 10px;text-align:right">停損率</th>
          <th style="padding:6px 10px;text-align:right">停利率</th>
          <th style="padding:6px 10px;text-align:right">樣本</th>
          <th style="padding:6px 10px;text-align:center">狀態</th>
        </tr></thead>
        <tbody id="expTableBody">${renderTable(activeHold, activeSL)}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">各策略樣本明細（點擊展開）</div>
    <div id="expDetails">${renderDetails(activeHold, activeSL)}</div>`;

  // tab 切換
  function refresh() {
    document.getElementById('expTableBody').innerHTML = renderTable(activeHold, activeSL);
    document.getElementById('expDetails').innerHTML   = renderDetails(activeHold, activeSL);
    document.getElementById('expPassBadge').textContent = `${passCount(activeHold,activeSL)}/${stratIds.length} 達標`;
    el.querySelectorAll('.exp-hold-tab').forEach(b => {
      const active = parseInt(b.dataset.hd) === activeHold;
      b.style.color = active ? 'var(--down)' : ''; b.style.borderColor = active ? 'var(--down)' : '';
    });
    el.querySelectorAll('.exp-sl-tab').forEach(b => {
      const active = parseInt(b.dataset.sl) === activeSL;
      b.style.color = active ? '#fbbf24' : ''; b.style.borderColor = active ? '#fbbf24' : '';
    });
    el.querySelectorAll('.exp-tp-tab').forEach(b => {
      const active = parseInt(b.dataset.tp) === activeTP;
      b.style.color = active ? '#4ade80' : ''; b.style.borderColor = active ? '#4ade80' : '';
    });
  }

  el.querySelectorAll('.exp-hold-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeHold = parseInt(btn.dataset.hd); refresh(); });
  });
  el.querySelectorAll('.exp-sl-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeSL = parseInt(btn.dataset.sl); refresh(); });
  });

  el.querySelectorAll('.exp-tp-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeTP = parseInt(btn.dataset.tp); refresh(); });
  });

  el._gasData = data;
  // 供 _copyResult 讀取當前 tab 狀態
  Object.defineProperty(el, "_getState", { value: function(){ return { activeHold, activeSL, activeTP }; }, configurable: true });
}


// ─────────────────────────────────────────────────────────────────────────────
// 渲染：全市場掃描結果
// ─────────────────────────────────────────────────────────────────────────────
function _renderScanResult(el, { stats, total, holdDays }) {
  const rows = Object.entries(stats).map(([sid, st]) => {
    const strat  = EXPERIMENTAL_STRATEGIES[sid];
    const wr     = st.total > 0 ? st.wins / st.total * 100 : 0;
    const pass   = wr >= 35 && st.avgRet > 0 && st.total >= 10;
    const wrColor  = wr >= 55 ? '#26a69a' : wr >= 40 ? '#fbbf24' : '#ef5350';
    const retColor = st.avgRet > 0 ? '#26a69a' : '#ef5350';
    const dedupNote = st.rawTotal !== st.total
      ? `<span style="font-size:10px;color:var(--muted)">（原 ${st.rawTotal}，去重後 ${st.total}）</span>`
      : '';
    return { sid, strat, wr, pass, st, wrColor, retColor, dedupNote };
  }).sort((a,b) => {
    // 達標的排前面，其次按均報降序
    if (a.pass !== b.pass) return b.pass - a.pass;
    return b.st.avgRet - a.st.avgRet;
  });

  const summaryRows = rows.map(r => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 10px;font-size:13px">
        <span style="font-size:15px;margin-right:5px">${r.strat.icon}</span>
        <span style="font-weight:600;color:var(--text)">${r.sid}</span>
        <span style="color:var(--muted);font-size:11px;margin-left:5px">${r.strat.name}</span>
      </td>
      <td style="padding:8px 10px;text-align:right;font-size:15px;font-weight:700;color:${r.wrColor}">${r.wr.toFixed(1)}%</td>
      <td style="padding:8px 10px;text-align:right;font-size:15px;font-weight:700;color:${r.retColor}">${r.st.avgRet>0?'+':''}${r.st.avgRet.toFixed(2)}%</td>
      <td style="padding:8px 10px;text-align:right;font-size:12px;color:var(--muted)">${r.st.total}${r.dedupNote}</td>
      <td style="padding:8px 10px;text-align:center">
        ${r.pass
          ? '<span style="color:#26a69a;font-size:11px;background:#0d2018;padding:2px 8px;border-radius:4px;border:1px solid #26a69a55">✅ 達標</span>'
          : '<span style="color:#ef5350;font-size:11px;background:#200d0d;padding:2px 8px;border-radius:4px;border:1px solid #ef535055">❌ 未達</span>'}
      </td>
    </tr>`).join('');

  const detailSections = rows.filter(r => r.st.samples.length > 0).map(r => {
    const sampleRows = r.st.samples.map(s => `
      <tr>
        <td style="padding:4px 8px;font-size:11px;color:var(--muted)">${s.date}</td>
        <td style="padding:4px 8px;font-size:11px">${s.code} ${s.name}</td>
        <td style="padding:4px 8px;text-align:right;font-size:11px">${s.entry.toFixed(2)}</td>
        <td style="padding:4px 8px;text-align:right;font-size:11px">${s.exit.toFixed(2)}</td>
        <td style="padding:4px 8px;text-align:right;font-size:11px;font-weight:600;color:${s.win?'#26a69a':'#ef5350'}">${s.ret>0?'+':''}${s.ret}%</td>
      </tr>`).join('');
    const color = r.wr >= 35 && r.st.avgRet > 0 ? '#26a69a' : '#ef5350';
    const dedupInfo = r.st.rawTotal !== r.st.total
      ? ` · 原 ${r.st.rawTotal} 筆去重為 ${r.st.total} 筆`
      : '';
    return `
      <details style="margin-bottom:8px;border:1px solid var(--border);border-radius:7px;overflow:hidden">
        <summary style="padding:9px 12px;cursor:pointer;background:var(--bg2);display:flex;align-items:center;gap:8px;list-style:none">
          <span style="font-size:15px">${r.strat.icon}</span>
          <span style="font-weight:600;color:var(--text)">${r.sid} ${r.strat.name}</span>
          <span style="margin-left:auto;font-size:12px;color:${color}">${r.wr.toFixed(1)}% / ${r.st.avgRet>0?'+':''}${r.st.avgRet.toFixed(2)}% / ${r.st.total} 樣本${dedupInfo}</span>
          <span style="color:var(--muted);font-size:11px">▾</span>
        </summary>
        <div style="padding:8px;overflow-x:auto">
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px;padding:0 4px">${r.strat.desc}（持有 ${holdDays} 日，最近 20 筆）</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="color:var(--muted);font-size:10px">
              <th style="padding:3px 8px;text-align:left">日期</th>
              <th style="padding:3px 8px;text-align:left">標的</th>
              <th style="padding:3px 8px;text-align:right">進場</th>
              <th style="padding:3px 8px;text-align:right">出場</th>
              <th style="padding:3px 8px;text-align:right">報酬</th>
            </tr></thead>
            <tbody>${sampleRows}</tbody>
          </table>
        </div>
      </details>`;
  }).join('');

  const passCount = rows.filter(r => r.pass).length;

  el.innerHTML = `
    <div style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="font-size:13px;font-weight:600;color:var(--text)">🧪 全市場掃描結果</div>
      <div style="font-size:11px;color:var(--muted)">掃描 ${total} 支 · 持有 ${holdDays} 日 · 同股去重（${holdDays}日冷卻）</div>
      <div style="margin-left:auto;font-size:11px;padding:3px 9px;background:#0d2018;border:1px solid #26a69a44;border-radius:5px;color:#26a69a">
        ${passCount}/${rows.length} 達標（勝率≥35%，均報>0，樣本≥10）
      </div>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px;margin-bottom:16px">
      <table style="width:100%;border-collapse:collapse" id="expSummaryTable">
        <thead>
          <tr style="background:var(--bg2);font-size:11px;color:var(--muted)">
            <th style="padding:7px 10px;text-align:left">策略</th>
            <th style="padding:7px 10px;text-align:right">勝率</th>
            <th style="padding:7px 10px;text-align:right">均報（做多）</th>
            <th style="padding:7px 10px;text-align:right">樣本</th>
            <th style="padding:7px 10px;text-align:center">狀態</th>
          </tr>
        </thead>
        <tbody>${summaryRows}</tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">各策略樣本明細（點擊展開）</div>
    ${detailSections}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 單股渲染
// ─────────────────────────────────────────────────────────────────────────────
function _renderSingleResult(el, { stratId, code, name, holdDays, signals }) {
  const strat   = EXPERIMENTAL_STRATEGIES[stratId];
  const emptyEl = document.getElementById('labExpEmpty');
  const deduped = _dedup(signals.slice().sort((a,b)=>a.date.localeCompare(b.date)), holdDays);

  if (!deduped.length) {
    if (emptyEl) emptyEl.style.display = '';
    el.style.display = 'none';
    dengToast('無觸發訊號');
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  el.style.display = '';

  const wins   = deduped.filter(s=>s.win).length;
  const wr     = (wins/deduped.length*100).toFixed(1);
  const avgRet = (deduped.reduce((s,x)=>s+x.ret,0)/deduped.length).toFixed(2);
  const pass   = parseFloat(wr)>=35 && parseFloat(avgRet)>0 && deduped.length>=10;
  const dedupNote = signals.length !== deduped.length
    ? `（原 ${signals.length} 筆，去重後 ${deduped.length} 筆）`
    : '';

  const rows = deduped.slice().reverse().map(s=>`
    <tr><td style="padding:5px 8px;color:var(--muted);font-size:12px">${s.date}</td>
    <td style="padding:5px 8px;text-align:right;font-size:12px">${s.entry.toFixed(2)}</td>
    <td style="padding:5px 8px;text-align:right;font-size:12px">${s.exit.toFixed(2)}</td>
    <td style="padding:5px 8px;text-align:right;font-size:12px;font-weight:600;color:${s.win?'#26a69a':'#ef5350'}">${s.ret>0?'+':''}${s.ret}%</td>
    </tr>`).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      <span style="font-size:16px">${strat?.icon??'🧪'}</span>
      <div>
        <div style="font-size:13px;font-weight:600">${strat?.name??stratId} — ${name}（${code}）</div>
        <div style="font-size:11px;color:var(--muted)">持有 ${holdDays} 日 · 做空收益 ${dedupNote}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">勝率</div>
        <div style="font-size:20px;font-weight:700;color:${parseFloat(wr)>=55?'#26a69a':parseFloat(wr)>=35?'#fbbf24':'#ef5350'}">${wr}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">均報</div>
        <div style="font-size:20px;font-weight:700;color:${parseFloat(avgRet)>0?'#26a69a':'#ef5350'}">${parseFloat(avgRet)>0?'+':''}${avgRet}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:7px;padding:9px 11px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">樣本</div>
        <div style="font-size:20px;font-weight:700">${deduped.length}</div>
      </div>
    </div>
    <div style="margin-bottom:10px;padding:7px 10px;background:#111;border:1px solid #333;border-radius:6px;font-size:11px;color:var(--muted)">
      達標：勝率≥35%，均報>0，樣本≥10
      <span style="margin-left:8px;color:${pass?'#26a69a':'#ef5350'}">${pass?'✅ 達標':'❌ 未達標'}</span>
    </div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:7px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--bg2)">
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">日期</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">進場</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">出場</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">報酬（放空）</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 複製結果（純文字摘要，貼進 Excel / Notes 都好用）
// ─────────────────────────────────────────────────────────────────────────────
function _copyResult() {
  const resultEl = document.getElementById('labExpResult');
  const gasData  = resultEl?._gasData;

  // GAS 模式：複製三組 holdDays 完整結果
  if (gasData?.strategies) {
    const lines = ['Z 系列回測結果（GAS 2Y K線）'];
    lines.push('執行時間：' + (gasData.runAt ? new Date(gasData.runAt).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'}) : '—'));
    lines.push('掃描支數：' + gasData.total);
    lines.push('');

    // 讀取當前 tab 狀態
    const state = resultEl._getState ? resultEl._getState() : {};
    const curTP = state.activeTP ?? 0;
    const tpLabel = curTP === 0 ? '不設停利' : ('停利' + curTP + '%');
    lines.push('當前停利：' + tpLabel);
    lines.push('');

    for (const hd of (gasData.holdDays ?? [5,10,20])) {
      for (const sl of (gasData.stopLoss ?? [3,5,8])) {
        lines.push('=== 持有 ' + hd + ' 日 · 停損 ' + sl + '% · ' + tpLabel + ' ===');
        lines.push('策略\t勝率\t均報\t最大浮盈\t停損率\t停利率\t樣本\t狀態');
        Object.entries(gasData.strategies)
          .map(([sid, s]) => {
            const bySL = s.byHold?.[hd]?.bySL?.[sl];
            const st = (bySL && bySL.byTP) ? (bySL.byTP[curTP] ?? bySL.byTP[0] ?? {}) : (bySL ?? {});
            return { sid, s, st };
          })
          .sort((a,b) => (b.st.pass?1:0)-(a.st.pass?1:0))
          .forEach(({ sid, s, st }) => {
            lines.push([
              sid + ' ' + s.name,
              (st.winRate ?? 0).toFixed(1) + '%',
              (st.avgRet  ?? 0).toFixed(2) + '%',
              '+' + (st.avgMaxGain ?? 0).toFixed(2) + '%',
              (st.slRate  ?? 0).toFixed(0) + '%',
              (st.tpRate  ?? 0).toFixed(0) + '%',
              st.total ?? 0,
              st.pass ? '✅達標' : '❌未達',
            ].join('\t'));
          });
        lines.push('');
      }
    }

    navigator.clipboard?.writeText(lines.join('\n')).then(() => {
      dengToast('✓ 已複製（' + tpLabel + '）');
    }).catch(() => dengToast('複製失敗'));
    return;
  }

  // 舊模式：複製摘要表格
  const table = document.getElementById('expSummaryTable');
  if (!table) { dengToast('尚無結果可複製'); return; }
  const lines = ['系統發現策略 全市場掃描結果'];
  table.querySelectorAll('tbody tr').forEach(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim().replace(/\s+/g,' '));
    lines.push(cells.join('\t'));
  });
  navigator.clipboard?.writeText(lines.join('\n')).then(() => {
    dengToast('✓ 已複製');
  }).catch(() => dengToast('複製失敗'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 公開 API
// ─────────────────────────────────────────────────────────────────────────────
export function bindExperimentRun() {
  _loadDiscoveredStrategies();   // 系統發現策略動態註冊進策略下拉
  document.getElementById('labRunExperiment')?.addEventListener('click', _runMarketScan);

  // 持有期比較（本機，原 Z 序列回測閱讀器改造）
  document.getElementById('labRunSeq')?.addEventListener('click', _runHoldCompare);

  // 出場機制比較（本機，原 Z 出場比較閱讀器改造）
  document.getElementById('labRunExit')?.addEventListener('click', _runExitCompare);

  document.getElementById('labExpAbortBtn')?.addEventListener('click', () => {
    _scanAborted = true;
    _expAbort?.abort();
    document.getElementById('labExpAbortBtn').style.display = 'none';
    document.getElementById('labRunExperiment').style.display = '';
  });

  document.getElementById('labExpCopyBtn')?.addEventListener('click', _copyResult);

}
