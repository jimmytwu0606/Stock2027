/**
 * export-klinemap.mjs — 校正資料準備：從 R2 bundle 抓全市場 K 線 → klineMap.json
 *
 * 把 Worker /bundle-raw?part=1~7（slim {t,o,h,l,c,v}）合併、轉成標準 candle，
 * 輸出 conviction 校正腳本（run-calibration.mjs）要吃的格式。
 *
 * 用法（本機 node）：
 *   node export-klinemap.mjs
 *   → 產出 klineMap.json
 *   → 接著跑 node run-calibration.mjs klineMap.json
 *
 * 需求：Node 18+（內建 fetch）。若你的 Node < 18，先 npm i node-fetch 並改 import。
 */

import { writeFileSync } from 'fs';

const WORKER_BASE = 'https://stock-2027.luffy0606.workers.dev';
const PROXY_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
const TOTAL_PARTS = 7;
const MIN_BARS = 90;   // C 需要 ~90 根才有意義，太短的股票直接濾掉

async function fetchBundlePart(partNo) {
  const url = `${WORKER_BASE}/bundle-raw?part=${partNo}`;
  const res = await fetch(url, { headers: { 'X-Proxy-Token': PROXY_TOKEN } });
  if (!res.ok) {
    console.error(`[export] part${partNo} 回應 ${res.status}`);
    return null;
  }
  let text = await res.text();
  // 截斷修補（與 GAS 一致）
  if (text.charAt(text.length - 1) !== '}') {
    const last = text.lastIndexOf('"}');
    if (last !== -1) text = text.substring(0, last + 2) + '}';
  }
  return JSON.parse(text);
}

async function main() {
  console.log('[export] 開始抓取全市場 K 線 bundle...');
  const klineMap = {};
  let totalStocks = 0;

  for (let part = 1; part <= TOTAL_PARTS; part++) {
    process.stdout.write(`[export] 抓 part${part}/${TOTAL_PARTS}... `);
    const bundle = await fetchBundlePart(part);
    if (!bundle) { console.log('失敗，跳過'); continue; }

    let added = 0;
    for (const sym of Object.keys(bundle)) {
      const code = sym.replace(/\.(TW|TWO)$/, '');
      const slim = bundle[sym];
      if (!Array.isArray(slim) || slim.length < MIN_BARS) continue;

      // slim {t,o,h,l,c,v} → 標準 candle {time,open,high,low,close,volume}
      const candles = slim
        .map(k => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v || 0 }))
        .filter(c => c.close > 0);
      if (candles.length < MIN_BARS) continue;

      klineMap[code] = candles;
      added++;
    }
    totalStocks += added;
    console.log(`${added} 檔（累計 ${totalStocks}）`);
  }

  const outPath = 'klineMap.json';
  writeFileSync(outPath, JSON.stringify(klineMap), 'utf8');
  const sizeMB = (JSON.stringify(klineMap).length / 1024 / 1024).toFixed(1);
  console.log(`\n[export] 完成：${totalStocks} 檔 → ${outPath}（${sizeMB} MB）`);
  console.log('[export] 接著跑：node run-calibration.mjs klineMap.json');
}

main().catch(e => { console.error('[export] 失敗:', e.message); process.exit(1); });
