/**
 * test-rs-ic.mjs — T-1 RS Rating 預測力驗證（第一步：先確認 RS 有沒有 IC）
 *
 * 在投入完整落地前，先用校正引擎的同一套 IC 標準驗證 RS Rating：
 *   - RS 原始分 = 0.4×(C/C63−1) + 0.2×(C/C126−1) + 0.2×(C/C189−1) + 0.2×(C/C252−1)
 *   - RS Rating = 全市場橫斷面百分位 1~99（每日重排）
 *   - 測 RS Rating 對未來 5/10/20 日報酬的 IC（與 C 同口徑對照）
 *
 * 評判標準同 conviction-calib：IC 均值 > 0.03、IC t > 2、十分位 Spearman ≥ 0.8
 *
 * 用法：node test-rs-ic.mjs klineMap.json
 */

import { readFileSync, writeFileSync } from 'fs';

const FWD_LIST = [5, 10, 20];
const SPLIT = { train: 0.5, valid: 0.25, archive: 0.25 };
const JUDGE = { SPEARMAN_MIN: 0.8, IC_MEAN_MIN: 0.03, IC_T_MIN: 2.0 };

// RS 原始分回看（IBD 慣例，3個月權重加倍）
const RS_LOOKBACKS = [
  { days: 63,  weight: 0.4 },
  { days: 126, weight: 0.2 },
  { days: 189, weight: 0.2 },
  { days: 252, weight: 0.2 },
];

// ── 統計工具（與 conviction-calib 一致）──────────────────────────────────────
function _spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length; i++) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mx) * (ry[i] - my);
    vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(vx * vy);
  return den === 0 ? 0 : cov / den;
}
function _mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function _std(a) {
  if (a.length < 2) return 0;
  const m = _mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}

// ── RS 原始分（單檔單日，含 ROADMAP 等比降級）──────────────────────────────
// 資料不足 252 根時，只用「可算的回看項」並重新正規化權重（ROADMAP T-1 規格）
function _rsRaw(closes, i) {
  // 至少要能算最短的回看項（63日），否則無意義
  if (i < RS_LOOKBACKS[0].days) return null;
  let raw = 0, wSum = 0;
  for (const lb of RS_LOOKBACKS) {
    if (i < lb.days) continue;            // 這個回看項資料不夠，跳過
    const c0 = closes[i - lb.days];
    if (!(c0 > 0)) continue;
    raw += lb.weight * (closes[i] / c0 - 1);
    wSum += lb.weight;
  }
  if (wSum === 0) return null;
  return raw / wSum;                       // 權重正規化（降級時用可用項等比）
}

/**
 * 算每檔每日的 RS 原始分 + 每日橫斷面百分位（RS Rating 1~99）
 * @returns { byDate: Map<date, [{code, rsRating, fwdRet}]>, codeCount }
 */
function computeRSRatings(klineMap, fwdDays, segFrom, segTo) {
  // 先算所有 (code, dateIdx) 的 RS 原始分
  const codes = Object.keys(klineMap);
  // 以「日期」對齊：用每檔的 time 當 key 做橫斷面
  const rawByDate = new Map();   // date -> [{code, raw, fwdRet}]

  for (const code of codes) {
    const bars = klineMap[code];
    if (!bars || bars.length < 63 + fwdDays) continue;   // 最短回看63 + 前瞻
    const closes = bars.map(b => b.close);
    const n = bars.length;
    const iStart = Math.max(63, Math.floor(n * segFrom)); // 從能算的最早點起
    const iEnd = Math.floor(n * segTo);
    for (let i = iStart; i < iEnd; i++) {
      const raw = _rsRaw(closes, i);
      if (raw === null) continue;
      const fi = i + fwdDays;
      if (fi >= n) continue;
      const c0 = closes[i], c1 = closes[fi];
      if (!(c0 > 0) || !(c1 > 0)) continue;
      const fwdRet = (c1 / c0 - 1) * 100;
      const date = bars[i].time;
      if (!rawByDate.has(date)) rawByDate.set(date, []);
      rawByDate.get(date).push({ code, raw, fwdRet });
    }
  }

  // 每日橫斷面 → 百分位 RS Rating 1~99
  const byDate = new Map();
  for (const [date, arr] of rawByDate) {
    if (arr.length < 20) continue;   // 橫斷面至少 20 檔才有百分位意義
    const sorted = [...arr].sort((a, b) => a.raw - b.raw);
    const m = sorted.length;
    const out = [];
    for (let r = 0; r < m; r++) {
      const pct = Math.round((r / (m - 1)) * 98) + 1;  // 1~99
      out.push({ code: sorted[r].code, rsRating: pct, fwdRet: sorted[r].fwdRet });
    }
    byDate.set(date, out);
  }
  return byDate;
}

// ── 審判：RS Rating 對未來報酬的 IC + 十分位 ─────────────────────────────────
function judgeRS(klineMap, fwdDays, segFrom, segTo) {
  const byDate = computeRSRatings(klineMap, fwdDays, segFrom, segTo);

  // 每日 IC（RS Rating vs fwdRet）
  const dailyIC = [];
  const pooled = [];
  for (const [, arr] of byDate) {
    if (arr.length < 20) continue;
    const ic = _spearman(arr.map(x => x.rsRating), arr.map(x => x.fwdRet));
    if (ic != null) dailyIC.push(ic);
    for (const x of arr) pooled.push(x);
  }
  const icMean = _mean(dailyIC);
  const icStd = _std(dailyIC);
  const icT = icStd > 0 ? icMean / (icStd / Math.sqrt(dailyIC.length)) : 0;

  // 十分位：按 RS Rating 分組
  pooled.sort((a, b) => a.rsRating - b.rsRating);
  const decileRets = [];
  const dN = Math.floor(pooled.length / 10);
  if (dN >= 5) {
    for (let d = 0; d < 10; d++) {
      const slice = pooled.slice(d * dN, (d + 1) * dN);
      decileRets.push(+_mean(slice.map(x => x.fwdRet)).toFixed(3));
    }
  }
  const spearmanDecile = decileRets.length === 10
    ? _spearman([1,2,3,4,5,6,7,8,9,10], decileRets) : null;

  return {
    icMean: +icMean.toFixed(4), icStd: +icStd.toFixed(4), icT: +icT.toFixed(2),
    icDays: dailyIC.length,
    spearmanDecile: spearmanDecile != null ? +spearmanDecile.toFixed(3) : null,
    decileRets,
    pass: (spearmanDecile != null && spearmanDecile >= JUDGE.SPEARMAN_MIN
           && icMean > JUDGE.IC_MEAN_MIN && icT > JUDGE.IC_T_MIN),
  };
}

function main() {
  const path = process.argv[2];
  if (!path) { console.error('用法: node test-rs-ic.mjs klineMap.json'); process.exit(1); }
  const klineMap = JSON.parse(readFileSync(path, 'utf8'));
  const codes = Object.keys(klineMap);
  console.log(`[RS-IC] 全市場 ${codes.length} 檔，前瞻期 ${FWD_LIST.join('/')} 日`);

  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };

  log('# RS Rating 預測力驗證報告');
  log('');
  log(`- 資料：全市場 ${codes.length} 檔`);
  log(`- RS 公式：0.4×63日 + 0.2×126 + 0.2×189 + 0.2×252 報酬 → 全市場百分位 1~99`);
  log(`- 評判標準（與 C 同口徑）：IC 均值 > ${JUDGE.IC_MEAN_MIN}、IC t > ${JUDGE.IC_T_MIN}、十分位 Spearman ≥ ${JUDGE.SPEARMAN_MIN}`);
  log('');

  for (const fwd of FWD_LIST) {
    log(`## 前瞻期 ${fwd} 日`);
    log('');
    log('| 時段 | IC均值 | IC t值 | 十分位Spearman | pass |');
    log('|------|--------|--------|----------------|------|');
    for (const seg of ['train', 'valid', 'archive']) {
      const range = {
        train: [0, SPLIT.train],
        valid: [SPLIT.train, SPLIT.train + SPLIT.valid],
        archive: [SPLIT.train + SPLIT.valid, 1],
      }[seg];
      const j = judgeRS(klineMap, fwd, range[0], range[1]);
      log(`| ${seg} | ${j.icMean} | ${j.icT} | ${j.spearmanDecile} | ${j.pass ? '✓' : '✗'} |`);
    }
    // 全段十分位曲線（最直觀）
    const full = judgeRS(klineMap, fwd, 0, 1);
    log('');
    log(`全段十分位報酬曲線（RS 低→高分 10 組）：`);
    log('```');
    log(JSON.stringify(full.decileRets));
    log('```');
    log(`全段 IC 均值 ${full.icMean}、t 值 ${full.icT}、十分位單調 ${full.spearmanDecile}`);
    log('');
  }

  log('---');
  log('## 結論判讀');
  log('');
  // 三段一致性檢查
  const allFull = FWD_LIST.map(fwd => ({ fwd, ...judgeRS(klineMap, fwd, 0, 1) }));
  const anyStrong = allFull.some(r => r.icMean > 0.02 && r.spearmanDecile > 0.7);
  if (anyStrong) {
    log('🟢 RS Rating 顯示出預測力訊號（IC 為正且十分位單調）——值得投入完整落地。');
    log('對照：C 的 IC 在三前瞻期皆為負或近零。RS 明顯優於 C → 校正引擎可信，RS 方向正確。');
  } else {
    log('🟡 RS Rating 在此資料上 IC 訊號也偏弱。可能原因：');
    log('  ① bundle K 線未還原除權息（ROADMAP 踩雷：除權息未還原會把 RS 打殘）');
    log('  ② 台股 20 日級別動能反轉性質（與美股不同）');
    log('  ③ 母體含 ETF/權證未排除（槓桿 ETF 霸榜扭曲百分位）');
    log('需先釐清資料口徑再判斷 RS 是否適用。');
  }
  log('');
  log(`校正完成時間：${new Date().toISOString()}`);

  const outPath = `RS_IC_TEST_${new Date().toISOString().slice(5,16).replace(/[-:T]/g,'').replace(/(\d{4})(\d{4})/,'$1_$2')}.md`;
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\n[RS-IC] 報告已寫入 ${outPath}`);
}

main();
