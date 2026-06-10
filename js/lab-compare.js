/**
 * lab-compare.js — 策略比較子模組
 */

import { fetchHistoryCached, toYahooSymbol, getChineseName } from './api.js';
import { CONDITION_DEFS } from './screener.js';
import { STRATEGIES } from './strategy.js';
import { dengToast } from './loading-deng.js';
import { resolveCode, tsToDate, checkProLimit, consumeProLimit, COMPARE_STRATEGIES } from './lab-utils.js';

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

export { _bindCompareRun as bindCompareRun };
