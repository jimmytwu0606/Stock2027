/**
 * run-calibration.mjs — Conviction CV-P2 校正執行腳本（本機 node 跑）
 *
 * 完整流程：讀全市場 K 線 → 時間三切 → 格點掃描各參數 → 敏感度檢查
 *           → 訓練段選候選 → 驗證段確認 → 封存段一次性審判 → 產 md 報告
 *
 * 用法：
 *   1. 準備全市場 K 線 JSON：{ "2330": [{time,open,high,low,close,volume}, ...], ... }
 *      （可從 R2 bundle 7 包合併，或本地 IndexedDB 匯出）
 *   2. node run-calibration.mjs <klineMap.json>
 *   3. 產出 CONVICTION_CALIB_MMDD.md，依結論凍結參數進 conviction.js
 *
 * ⚠ 校正鐵則：封存段只開封一次。封存不滿意 → 回訓練段重來，
 *    不准用封存段反饋調參（否則封存段就失去「最終審判」意義）。
 */

import { readFileSync, writeFileSync } from 'fs';
import {
  judge, gridScan, gridScanWeights, genWeightGrid, genSingleParamGrid,
  sensitivityCheck, JUDGE, SPLIT,
} from './js/conviction-calib.js';

const FWD_LIST = [5, 10, 20];   // P13：5/10/20 三前瞻期並列對照（不擇一）

function _mmdd() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}${dd}_${hh}${mi}`;
}

function runOneFwd(klineMap, FWD_DAYS, log) {
  log(`# 前瞻期 ${FWD_DAYS} 日 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log('');

  // ── 階段1：基準（demo 預設參數）三段 ──
  log(`## [${FWD_DAYS}日] 階段1：基準參數三段審判`);
  log('');
  log('| 時段 | IC均值 | IC t值 | 十分位Spearman | pass |');
  log('|------|--------|--------|----------------|------|');
  for (const seg of ['train', 'valid', 'archive']) {
    const range = {
      train: [0, SPLIT.train],
      valid: [SPLIT.train, SPLIT.train + SPLIT.valid],
      archive: [SPLIT.train + SPLIT.valid, 1],
    }[seg];
    const j = judge(klineMap, {}, FWD_DAYS, range[0], range[1]);
    log(`| ${seg} | ${j.icMean} | ${j.icT} | ${j.spearmanDecile} | ${j.pass ? '✓' : '✗'} |`);
  }
  log('');

  // ── 階段2：單參數格點掃描（訓練段）──
  log(`## [${FWD_DAYS}日] 階段2：單參數格點掃描（訓練段）`);
  log('');
  const singleParams = [
    { name: 'MOM_LOOKBACK', values: [10, 20, 40, 60] },
    { name: 'Z_WINDOW', values: [40, 60, 120, 252] },
    { name: 'WINSOR', values: [2.5, 3, 3.5] },
    { name: 'EMA_SPAN', values: [3, 5, 8] },
    { name: 'KAPPA', values: [1.0, 1.5, 2.0] },
  ];
  const bestSingle = {};
  for (const sp of singleParams) {
    const grid = genSingleParamGrid(sp.name, sp.values);
    const scan = gridScan(klineMap, grid, FWD_DAYS, 'train');
    const sens = sensitivityCheck(scan);
    log(`### ${sp.name}`);
    log('| 值 | IC均值 | IC t值 | 十分位 | pass |');
    log('|----|--------|--------|--------|------|');
    scan.forEach(r => log(`| ${r.name.split('=')[1]} | ${r.icMean} | ${r.icT} | ${r.spearmanDecile} | ${r.pass ? '✓' : '✗'} |`));
    log(`敏感度：${sens.smooth ? '✓ 平緩' : '⚠ 不平緩（過擬合風險）'}，最大跳變 ${sens.maxJump}${sens.worst ? `（${sens.worst.join(' vs ')}）` : ''}`);
    bestSingle[sp.name] = sens.smooth ? scan[0] : (scan[1] || scan[0]);
    log(`→ 選用：${bestSingle[sp.name].name}${sens.smooth ? '（最佳）' : '（敏感，取穩健次優）'}`);
    log('');
  }

  // ── 階段3：權重格點（快掃）──
  log(`## [${FWD_DAYS}日] 階段3：權重組合格點（訓練段，單純形步長 0.05）`);
  log('');
  const wgrid = genWeightGrid(0.05);
  const wBase = {
    ...bestSingle.MOM_LOOKBACK?.params,
    ...bestSingle.Z_WINDOW?.params,
    ...bestSingle.WINSOR?.params,
    ...bestSingle.EMA_SPAN?.params,
    ...bestSingle.KAPPA?.params,
  };
  const wscan = gridScanWeights(klineMap, wgrid, FWD_DAYS, 'train', wBase);
  log(`掃描 ${wgrid.length} 組權重，訓練段前 10 名：`);
  log('| 權重(動能/量能/勝率) | IC均值 | IC t值 | 十分位 | pass |');
  log('|---------------------|--------|--------|--------|------|');
  wscan.slice(0, 10).forEach(r => log(`| ${r.name} | ${r.icMean} | ${r.icT} | ${r.spearmanDecile} | ${r.pass ? '✓' : '✗'} |`));
  const bestW = wscan[0];
  log('');

  // ── 階段4：候選 → 驗證段 ──
  log(`## [${FWD_DAYS}日] 階段4：訓練段最優組合 → 驗證段確認`);
  log('');
  const candidate = {
    ...bestSingle.MOM_LOOKBACK?.params,
    ...bestSingle.Z_WINDOW?.params,
    ...bestSingle.WINSOR?.params,
    ...bestSingle.EMA_SPAN?.params,
    ...bestSingle.KAPPA?.params,
    ...bestW.params,
  };
  log('訓練段選出候選參數：');
  log('```json');
  log(JSON.stringify(candidate, null, 2));
  log('```');
  log('');
  const vTrain = judge(klineMap, candidate, FWD_DAYS, 0, SPLIT.train);
  const vValid = judge(klineMap, candidate, FWD_DAYS, SPLIT.train, SPLIT.train + SPLIT.valid);
  log('| 時段 | IC均值 | IC t值 | 十分位 | pass |');
  log('|------|--------|--------|--------|------|');
  log(`| 訓練 | ${vTrain.icMean} | ${vTrain.icT} | ${vTrain.spearmanDecile} | ${vTrain.pass ? '✓' : '✗'} |`);
  log(`| 驗證 | ${vValid.icMean} | ${vValid.icT} | ${vValid.spearmanDecile} | ${vValid.pass ? '✓' : '✗'} |`);
  log('');

  // ── 階段5：封存段（只開封一次）──
  log(`## [${FWD_DAYS}日] 階段5：封存段最終審判（⚠ 只開封一次）`);
  log('');
  let verdict = { fwd: FWD_DAYS, pass: false, candidate, vValid };
  if (!vValid.pass) {
    log('🔴 驗證段未過 → **不開封封存段**。');
    log(`結論：前瞻 ${FWD_DAYS} 日候選未通過驗證。`);
  } else {
    const vArchive = judge(klineMap, candidate, FWD_DAYS, SPLIT.train + SPLIT.valid, 1);
    log('驗證段已過，開封封存段：');
    log('| 時段 | IC均值 | IC t值 | 十分位 | pass |');
    log('|------|--------|--------|--------|------|');
    log(`| 封存 | ${vArchive.icMean} | ${vArchive.icT} | ${vArchive.spearmanDecile} | ${vArchive.pass ? '✓' : '✗'} |`);
    log('十分位報酬曲線：' + JSON.stringify(vArchive.decileRets));
    verdict.pass = vArchive.pass;
    verdict.vArchive = vArchive;
    if (vArchive.pass) {
      log('🟢 **封存段通過** → 此前瞻期參數可凍結。');
      log('```json');
      log(JSON.stringify(candidate, null, 2));
      log('```');
    } else {
      log('🔴 封存段未過 → 此前瞻期 C 不上線。');
    }
  }
  log('');
  log('');
  return verdict;
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('用法: node run-calibration.mjs <klineMap.json>');
    process.exit(1);
  }
  console.log('[calib] 讀取 K 線:', path);
  const klineMap = JSON.parse(readFileSync(path, 'utf8'));
  const codes = Object.keys(klineMap);
  console.log(`[calib] 全市場 ${codes.length} 檔，前瞻期 ${FWD_LIST.join('/')} 日`);

  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };

  log(`# CONVICTION 校正報告（多前瞻期對照）— ${_mmdd()}`);
  log('');
  log(`- 資料：全市場 ${codes.length} 檔`);
  log(`- 前瞻期對照：${FWD_LIST.join(' / ')} 日（P13：三期並列不擇一）`);
  log(`- 時間三切：訓練 ${SPLIT.train} / 驗證 ${SPLIT.valid} / 封存 ${SPLIT.archive}`);
  log(`- 評判標準（寫死）：十分位 Spearman ≥ ${JUDGE.SPEARMAN_MIN}、IC 均值 > ${JUDGE.IC_MEAN_MIN}、IC t > ${JUDGE.IC_T_MIN}`);
  log('');
  log('---');
  log('');

  const verdicts = [];
  for (const fwd of FWD_LIST) {
    console.log(`\n[calib] === 前瞻期 ${fwd} 日 ===`);
    verdicts.push(runOneFwd(klineMap, fwd, log));
  }

  // ── 總結對照表 ──
  log('# 📊 多前瞻期總結對照');
  log('');
  log('| 前瞻期 | 驗證IC | 驗證十分位 | 封存段 | 最終 |');
  log('|--------|--------|-----------|--------|------|');
  for (const v of verdicts) {
    const arch = v.vArchive ? `IC=${v.vArchive.icMean} 十分位=${v.vArchive.spearmanDecile}` : '未開封';
    log(`| ${v.fwd}日 | ${v.vValid.icMean} | ${v.vValid.spearmanDecile} | ${arch} | ${v.pass ? '🟢通過' : '🔴未過'} |`);
  }
  log('');
  const anyPass = verdicts.some(v => v.pass);
  if (anyPass) {
    const best = verdicts.filter(v => v.pass).sort((a,b)=>(b.vArchive?.icMean||0)-(a.vArchive?.icMean||0))[0];
    log(`🟢 **結論：前瞻 ${best.fwd} 日通過全套審判**，可凍結其參數進 conviction.js（升 CONVICTION_VERSION，附校正日期）。`);
    log('```json');
    log(JSON.stringify(best.candidate, null, 2));
    log('```');
  } else {
    log('🔴 **結論：三個前瞻期皆未通過驗證/封存**。v1 三成分 C 不具穩定預測力，暫不上線（誠實承認失敗也是結果）。');
    log('建議：① 維持 C 為個股觀察工具（CV-P3 副窗保留）；② 升級 v1.5/v2 成分（pooled 勝率、籌碼流）後重校。');
  }
  log('');
  log(`---`);
  log(`校正完成時間：${new Date().toISOString()}`);

  const outPath = `CONVICTION_CALIB_${_mmdd()}.md`;
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\n[calib] 報告已寫入 ${outPath}`);
}

main();
