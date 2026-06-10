/**
 * lab-experiment.js — 真實驗室子模組（VVVIP 專屬）
 *
 * 模式 A：單股回測
 * 模式 B：全市場掃描（地圖炮）
 *
 * v2 修正（2026-06-08）：
 *   - 所有策略加「同股去重」：同一股票 N 日內只計一次觸發（N = holdDays）
 *   - Z1：RSI 門檻 75→70
 *   - Z2：加 RSI>70 過濾慢牛；同股去重
 *   - Z3：持有天數縮短至 10 日效果更好；同股去重
 *   - Z4：同股去重（最關鍵，過濾 1589 連跌 9 天污染）
 *   - Z5：改條件「跌破 MA20 當天量增（量>均量 0.8x）」
 *   - Z6：條件改為「高位連跌第 2 根確認」，避免洗盤假訊號
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { dengToast } from './loading-deng.js';
import { resolveCode, tsToDate } from './lab-utils.js';
import { dbGetAll } from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Z 系列實驗策略
// ─────────────────────────────────────────────────────────────────────────────
export const EXPERIMENTAL_STRATEGIES = {

  // Z1：雙重超買確認（RSI>80 + 布林上軌 + BB擴張）
  Z1: {
    id: 'Z1', name: '雙重超買確認', icon: '🔥',
    desc: 'RSI>80 + 布林上軌觸及 + BB擴張（W6+W7雙超買組合）',
    minCandles: 25, direction: 'short',
    calc(candles) {
      const n = candles.length;
      if (n < 25) return false;
      const closes = candles.map(c => c.close);
      const rsi = _calcRSI(closes, 14);
      if ((rsi[n-1] ?? 0) < 80) return false;
      const avg = closes.slice(n-20).reduce((a,b)=>a+b,0)/20;
      const std = Math.sqrt(closes.slice(n-20).reduce((s,v)=>s+(v-avg)**2,0)/20);
      if (candles[n-1].close < (avg+2*std)*0.99) return false;
      const avg5p = closes.slice(n-25,n-5).reduce((a,b)=>a+b,0)/20;
      const std5p = Math.sqrt(closes.slice(n-25,n-5).reduce((s,v)=>s+(v-avg5p)**2,0)/20);
      if (std5p > 0 && std < std5p*1.3) return false;
      return true;
    },
  },

  // Z2：亢龍有悔進場（加 RSI>70 過濾慢牛，條件更嚴格）
  Z2: {
    id: 'Z2', name: '亢龍有悔進場', icon: '☯️',
    desc: 'MA20 正乖離>15% + RSI>70 + 今收黑 + 量縮',
    minCandles: 25, direction: 'short',
    calc(candles) {
      const n = candles.length;
      if (n < 25) return false;
      const closes = candles.map(c => c.close);
      // 正乖離 > 15%
      const ma20 = _ma(closes, 20);
      const m = ma20[n-1]; if (!m || m <= 0) return false;
      if ((closes[n-1] - m) / m * 100 < 15) return false;
      // RSI > 70（新增：過濾慢牛，只抓真正過熱）
      const rsi = _calcRSI(closes, 14);
      if ((rsi[n-1] ?? 0) < 70) return false;
      // 今日收黑
      const last = candles[n-1], prev = candles[n-2];
      if (last.close >= last.open) return false;
      // 量縮（今日量 < 昨日量 × 0.85）
      if ((prev.volume ?? 0) > 0 && (last.volume ?? 0) > (prev.volume ?? 0) * 0.85) return false;
      return true;
    },
  },

  // Z3：死亡交叉確認（條件不變，靠去重提升品質）
  Z3: {
    id: 'Z3', name: '死亡交叉確認', icon: '💀',
    desc: 'MA5 下穿 MA20 + MACD<0 + 量放大',
    minCandles: 28, direction: 'short',
    calc(candles) {
      const n = candles.length;
      if (n < 28) return false;
      const closes = candles.map(c => c.close);
      const ma5  = _ma(closes, 5);
      const ma20 = _ma(closes, 20);
      if (!ma5[n-1] || !ma5[n-2] || !ma20[n-1] || !ma20[n-2]) return false;
      if (!(ma5[n-2] >= ma20[n-2] && ma5[n-1] < ma20[n-1])) return false;
      const { dif } = _calcMACD(closes);
      if ((dif[n-1] ?? 0) >= 0) return false;
      const avgVol = candles.slice(-11,-1).reduce((s,c) => s+(c.volume??0), 0) / 10;
      if (avgVol > 0 && (candles[n-1].volume??0) < avgVol * 1.2) return false;
      return true;
    },
  },

  // Z4：跌停板確認（同股去重是關鍵，條件不變）
  Z4: {
    id: 'Z4', name: '死叉量增放大', icon: '📉',
    desc: 'KD死叉 + MACD死叉(柱轉負) + 今量≥均量1.5x（W2強化版）',
    minCandles: 28, direction: 'short',
    calc(candles) {
      const n = candles.length;
      if (n < 28) return false;
      const closes = candles.map(c => c.close);
      // KD 死叉
      const { k, d } = _calcKD(candles);
      if (!k[n-1]||!d[n-1]||!k[n-2]||!d[n-2]) return false;
      if (!(k[n-2] >= d[n-2] && k[n-1] < d[n-1])) return false;
      // MACD 柱轉負
      const { hist } = _calcMACD(closes);
      if (hist[n-2] == null || hist[n-1] == null) return false;
      if (!(hist[n-2] >= 0 && hist[n-1] < 0)) return false;
      // 量增放大
      const avgVol = candles.slice(-11,-1).reduce((s,c)=>s+(c.volume??0),0)/10;
      return avgVol > 0 && (candles[n-1].volume??0) >= avgVol*1.5;
    },
  },

  // Z5：葛蘭碧賣出強化（正乖離>10% + MA20下彎 + RSI>75 + 今收黑）
  Z5: {
    id: 'Z5', name: '葛蘭碧賣出強化', icon: '④',
    desc: '曾漲≥15% → 跌破MA20 + 量增（今量>均量0.8x），量增跌更可信',
    minCandles: 25, direction: 'short',
    calc(candles) {
      const n = candles.length;
      if (n < 25) return false;
      const closes = candles.map(c => c.close);
      const ma20 = _ma(closes, 20);
      const m = ma20[n-1]; if (!m || m <= 0) return false;
      if ((closes[n-1] - m) / m * 100 < 10) return false;
      if (!ma20[n-2] || ma20[n-1] >= ma20[n-2]) return false;
      const rsi = _calcRSI(closes, 14);
      if ((rsi[n-1] ?? 0) < 75) return false;
      if (candles[n-1].close >= candles[n-1].open) return false;
      return true;
    },
  },

  // Z6：高位連跌第2根確認（改：需連續兩日收黑，避免單日洗盤假訊號）
  Z6: {
    id: 'Z6', name: '高位連跌確認', icon: '📉',
    desc: '創近20日新高後連跌2根 + 今日爆量收黑，確認出貨',
    minCandles: 23, direction: 'short',
    calc(candles) {
      const n = candles.length;
      if (n < 23) return false;
      const last  = candles[n-1];
      const prev  = candles[n-2];
      const prev2 = candles[n-3];
      // 今日和昨日都收黑（連續兩根陰線）
      if (last.close >= last.open) return false;
      if (prev.close >= prev.open) return false;
      // 昨日高點碰近20日新高附近（高位）
      const high20 = Math.max(...candles.slice(-22,-2).map(c=>c.high));
      if (prev.high < high20 * 0.98) return false;
      // 今日量爆（> 近10日均量 × 1.3）
      const avgVol = candles.slice(-11,-1).reduce((s,c)=>s+(c.volume??0),0)/10;
      return avgVol > 0 && (last.volume??0) >= avgVol * 1.3;
    },
  },
};

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
  for (let i = strat.minCandles; i <= max; i++) {
    const sliced = candles.slice(0, i+1);
    let hit = false;
    try { hit = strat.calc(sliced); } catch {}
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
            <th style="padding:7px 10px;text-align:right">均報（做空）</th>
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
  const lines = ['Z 系列掃描結果'];
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
  document.getElementById('labRunExperiment')?.addEventListener('click', _loadGasResult);

  // 序列回測按鈕
  document.getElementById('labRunSeq')?.addEventListener('click', function() {
    _loadSeqResult(this);
  });

  // 出場機制比較按鈕
  document.getElementById('labRunExit')?.addEventListener('click', function() {
    _loadExitResult(this);
  });

  document.getElementById('labExpAbortBtn')?.addEventListener('click', () => {
    _expAbort?.abort();
    document.getElementById('labExpAbortBtn').style.display = 'none';
    document.getElementById('labRunExperiment').style.display = '';
  });

  document.getElementById('labExpSingleBtn')?.addEventListener('click', _runSingle);
  document.getElementById('labExpCopyBtn')?.addEventListener('click', _copyResult);

}

async function _runSingle() {
  if (window.__userTier !== 'vvvip') { dengToast('真實驗室為 VVVIP 專屬'); return; }
  const stratId  = document.getElementById('expStrategySelect')?.value ?? '';
  const codeRaw  = document.getElementById('expCodeInput')?.value?.trim() ?? '';
  const holdDays = parseInt(document.getElementById('expHoldSelect')?.value ?? '10');
  const resultEl  = document.getElementById('labExpResult');
  const emptyEl   = document.getElementById('labExpEmpty');
  const progressEl = document.getElementById('labProgress');
  const progressBar= document.getElementById('labProgressBar');

  if (!stratId) { dengToast('請選擇策略'); return; }
  const code = resolveCode(codeRaw);
  if (!code)  { dengToast('請輸入有效代號'); return; }

  progressEl.style.display = '';
  progressBar.style.width  = '40%';
  if (emptyEl) emptyEl.style.display = 'none';

  try {
    let candles = await fetchHistoryCached(toYahooSymbol(code), '1y', { allowStale: false });
    if (!candles || candles.length < 25)
      candles = await fetchHistoryCached(code+'.TWO', '1y', { allowStale: false }).catch(()=>null);
    if (!candles || candles.length < 25) { dengToast('K 線不足'); return; }
    progressBar.style.width = '90%';
    const name    = getChineseName(code) || code;
    const signals = _backtestOne(candles, stratId, holdDays, code);
    _renderSingleResult(resultEl, { stratId, code, name, holdDays, signals });
  } catch(e) {
    dengToast('回測失敗：' + e.message);
  } finally {
    progressEl.style.display = 'none';
  }
}
