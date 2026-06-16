/**
 * export-hist-klinemap.mjs — 從 hist 累積倉儲抓全市場還原 K 線 → klineMap.json
 *
 * 為何用 hist 而非 bundle：
 *   ① hist 是累積式（2y 初始化 + 每日 append），夠 RS 252 日回看（bundle 只有 1y）
 *   ② hist 有 adjclose（a 欄位，除權息鏈式還原）→ 解決 ROADMAP 踩雷「除權息未還原把 RS 打殘」
 *
 * 關鍵：用 a（adjclose 還原價）當 close，不是 c（原始價）。
 *       這是 RS / 動能類因子的正確口徑。
 *
 * 流程：/histcodes 列代號 → /r2bulkget 批次抓 → 用 a 當 close → klineMap.json
 *
 * 用法：node export-hist-klinemap.mjs
 * 需求：Node 18+（內建 fetch）
 */

import { writeFileSync } from 'fs';

const WORKER_BASE = 'https://stock-2027.luffy0606.workers.dev';
const PROXY_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
const BULK_CHUNK = 150;   // /r2bulkget 每批（同 api-hist.js）
const MIN_BARS = 100;     // hist 至少 100 根才收

async function main() {
  console.log('[hist-export] 列出 hist 倉儲代號...');
  const codesRes = await fetch(`${WORKER_BASE}/histcodes`, {
    headers: { 'X-Proxy-Token': PROXY_TOKEN },
  });
  if (!codesRes.ok) {
    console.error(`[hist-export] /histcodes 失敗 ${codesRes.status}。hist 倉儲可能尚未初始化（需先跑 histInitPart1~7）`);
    process.exit(1);
  }
  const { codes, total } = await codesRes.json();
  console.log(`[hist-export] hist 倉儲共 ${total} 檔代號`);
  if (total === 0) {
    console.error('[hist-export] hist 倉儲是空的！請先在 GAS 跑 histInitPart1~7 初始化');
    process.exit(1);
  }

  const klineMap = {};
  let got = 0, tooShort = 0, hasAdj = 0, noAdj = 0;
  let minLen = Infinity, maxLen = 0, sumLen = 0;

  for (let i = 0; i < codes.length; i += BULK_CHUNK) {
    const batch = codes.slice(i, i + BULK_CHUNK);
    process.stdout.write(`[hist-export] 抓 ${i}~${i + batch.length}/${total}... `);
    try {
      const res = await fetch(`${WORKER_BASE}/r2bulkget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': PROXY_TOKEN },
        body: JSON.stringify({ keys: batch.map(c => 'hist:' + c), slim: false }),
      });
      if (!res.ok) { console.log(`批次失敗 ${res.status}`); continue; }
      const j = await res.json();
      let added = 0;
      for (const code of batch) {
        const raw = j.data?.['hist:' + code];
        if (!raw) continue;
        let data;
        try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
        const cand = data?.candles;
        if (!Array.isArray(cand) || cand.length < MIN_BARS) { tooShort++; continue; }

        // 用 adjclose（a）當 close；a 為 null（無法還原段）則 fallback 原始 c
        const bars = cand.map(k => {
          const close = (k.a != null && k.a > 0) ? k.a : k.c;
          // adjclose 只還原 close，OHL 按比例縮放保持 K 棒形狀
          const ratio = (k.c > 0) ? close / k.c : 1;
          return {
            time: k.t,
            open: k.o * ratio, high: k.h * ratio, low: k.l * ratio,
            close, volume: k.v || 0,
          };
        }).filter(c => c.close > 0);
        if (bars.length < MIN_BARS) { tooShort++; continue; }

        klineMap[code] = bars;
        added++; got++;
        if (cand.some(k => k.a != null)) hasAdj++; else noAdj++;
        const L = bars.length;
        minLen = Math.min(minLen, L); maxLen = Math.max(maxLen, L); sumLen += L;
      }
      console.log(`+${added}（累計 ${got}）`);
    } catch (e) {
      console.log(`例外: ${e.message}`);
    }
  }

  const outPath = 'klineMap.json';
  writeFileSync(outPath, JSON.stringify(klineMap), 'utf8');
  const sizeMB = (JSON.stringify(klineMap).length / 1024 / 1024).toFixed(1);

  console.log('\n========================================');
  console.log(`[hist-export] 完成：${got} 檔 → ${outPath}（${sizeMB} MB）`);
  console.log(`  K 線長度：最短 ${minLen} / 最長 ${maxLen} / 平均 ${Math.round(sumLen / got)} 根`);
  console.log(`  含 adjclose：${hasAdj} 檔 / 無 adjclose：${noAdj} 檔`);
  console.log(`  太短略過：${tooShort} 檔`);
  if (maxLen < 252) {
    console.log('  ⚠ 最長不足 252 根 → RS 完整公式仍會降級，hist 可能尚未累積夠長');
  } else {
    console.log('  ✓ 資料夠長，RS 252 日回看可用完整公式');
  }
  console.log('========================================');
  console.log('[hist-export] 接著跑：node test-rs-ic.mjs klineMap.json');
}

main().catch(e => { console.error('[hist-export] 失敗:', e.message); process.exit(1); });
