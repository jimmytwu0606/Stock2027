/**
 * lab-discovered.js — 🔮 系統發現策略（VVVIP）
 *
 * 資料源：Worker GET /discovered → R2 signals:strategy:discovered
 *        （strategy_search.gs 每日 18:00 後寫入名人堂 top 10）
 *
 * 對外：bindDiscoveredRun()  ← strategy-lab.js lazy bind 呼叫
 */

import { getChineseName, fetchHistoryCached } from './api.js';
import { openLabWithCode } from './strategy-lab.js';
import { getKlineCache, loadHealthCacheBatch, dbGet, dbGetAll, dbPut, dbDelete } from './db.js';
import { fsGetShared, fsSetShared } from './firebase.js';
import { renderHealthBadge, calcHealth, calcHealthLong } from './health.js';

const WORKER_BASE = 'https://stock-2027.luffy0606.workers.dev';
const PROXY_TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';  // 同 api.js（Worker 全域 token gate）

// condition id → 中文標籤（與 heatmap_calc.gs _calcConditions 對齊）
const COND_LABELS = {
  rsi_min: 'RSI≥50', rsi_max: 'RSI≥80', rsi_revival: 'RSI脫離超賣',
  kd_k_min: 'K≤20', kd_k_max: 'K≥80', kd_golden: 'KD金叉', kd_dead: 'KD死叉',
  macd_golden: 'MACD金叉', macd_dead: 'MACD死叉', macd_hist_pos: 'MACD柱>0',
  macd_dead_above_zero: 'MACD零上死叉',
  above_ma20: '站上月線', below_ma20: '跌破月線', ma5_cross_ma20: '5日穿月線',
  ma20_turn_up: '月線翻揚', ma20_rising: '月線上彎', ma20_declining: '月線下彎',
  ma20_turn_down: '月線翻空', price_cross_ma20_up: '價穿月線', price_cross_ma20_down: '價破月線',
  price_bounce_ma20: '月線附近回測', price_far_below_ma20: '深跌破月線8%',
  price_far_above_ma20: '高乖離月線8%', price_rally_fail_ma20: '反彈月線失敗',
  bb_squeeze: '布林收斂', bb_expanding: '布林擴張', bb_upper_touch: '觸布林上軌',
  bb_lower_touch: '觸布林下軌',
  high_n_days: '創20日新高', drop_n_days: '創20日新低',
  vol_surge: '爆量1.5x', vol_shrink: '量縮', vol_surge_long: '帶量上攻',
  vol_surge_short: '帶量收紅', vol_surge_drop: '帶量下殺', limit_up: '漲停',
  psy_oversold: 'PSY超賣', psy_overbought: 'PSY超買', bias20_low: '乖離≤-8',
  rci9_turn_up: 'RCI翻揚',
  dmi_bull: 'DMI多頭', dmi_strong: 'ADX強趨勢', dmi_bear: 'DMI空頭',
  sar_bull: 'SAR多頭', hv_low: '低波動',
  ema_bull: 'EMA多頭排列', ema_cross_up: 'EMA上穿', ma_bear_array: '空頭排列',
  gmma_bull: 'GMMA多頭',
  ichi_cloud_above: '雲上', ichi_below_cloud: '雲下', ichi_bull_cloud: '多頭雲',
  ichi_tk_cross: '轉換線金叉', ichi_tk_dead: '轉換線死叉', ichi_chikou_above: '遲行線在上',
  three_peaks: '三頂', three_valleys: '三底', three_soldiers: '紅三兵',
  bullish_engulfing: '多頭吞噬', tight_consolidation: '緊密盤整帶量',
  gain_10d: '10日漲>5%', loss_5d: '5日跌>5%',
};

// X 系列條件（與 heatmap_calc.gs TECH_STRATEGIES 對齊），用 snapshot 判今日命中
const X_DEFS = {
  X2: ['gain_10d','vol_surge_long','rsi_min'],
  X1: ['rsi_min','vol_surge_short','above_ma20','ma20_rising'],
  X6: ['tight_consolidation','above_ma20'],
  X5: ['vol_surge_short','gain_10d','rsi_min','above_ma20','ma20_rising'],
};

let _bound = false;

export function bindDiscoveredRun() {
  if (_bound) return;
  _bound = true;
  document.getElementById('labRunDiscovered')?.addEventListener('click', _load);
  _load();  // 切到 tab 自動載入
}

async function _load() {
  const panel = document.getElementById('labDiscoveredResult');
  if (!panel) return;
  panel.innerHTML = '<div class="ld-loading">載入中…</div>';

  let data = null;
  try {
    const res = await fetch(WORKER_BASE + '/discovered', {
      cache: 'no-store',
      headers: { 'X-Proxy-Token': PROXY_TOKEN },
    });
    if (res.ok) data = await res.json();
  } catch (e) {
    console.warn('[discovered] fetch failed:', e.message);
  }

  if (!data || !Array.isArray(data.top) || !data.top.length) {
    panel.innerHTML = '<div class="ld-empty">尚無發現策略 — 搜尋引擎每日 18:00 對近半年歷史回測 150 組新組合，跑完即更新；首批 0 組屬正常（須通過訓練+驗證雙重門檻）</div>';
    return;
  }

  _render(panel, data);
}

/** 供鑑定所首頁拉取候選清單（不渲染，只回資料）。失敗回 [] */
export async function fetchDiscoveredCandidates() {
  try {
    const res = await fetch(WORKER_BASE + '/discovered', {
      cache: 'no-store',
      headers: { 'X-Proxy-Token': PROXY_TOKEN },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.top) ? data.top : [];
  } catch (e) {
    console.warn('[discovered] fetchCandidates failed:', e.message);
    return [];
  }
}

/** 候選 → 鑑定所 payload（供鑑定所首頁點擊直接鑑定，與 _sendToTribunal 同格式）*/
export function candidateToTribunalPayload(q) {
  const label = q.conds.map(id => COND_LABELS[id] ?? id).join('+');
  let foundTs = null;
  if (q.foundAt) { const d = new Date(q.foundAt + 'T00:00:00'); if (!isNaN(d)) foundTs = Math.floor(d.getTime() / 1000); }
  return {
    kind: 'candidate',
    label: `🔮 ${label}（${q.hold}日）`,
    customStrategies: [{
      id: 'CUSTOM', name: label, icon: '🔮', category: '系統發現',
      conditions: q.conds.map(id => ({ condId: 'gas:' + id })),
      exitDays: q.hold,
    }],
    hold: q.hold, exitMode: 'trailing', stopPct: 20, trailPct: 25,
    foundTs,
    _condLabel: label,
  };
}

function _render(panel, data) {
  const rows = data.top.map((q, idx) => {
    const tags = q.conds.map(id =>
      `<span class="ld-tag" title="${id}">${COND_LABELS[id] ?? id}</span>`
    ).join('');
    const exCls = v => v >= 0 ? 'wl-up' : 'wl-dn';
    return `<tr class="ld-row">
      <td class="ld-rank">${idx + 1}</td>
      <td class="ld-conds">${tags}</td>
      <td class="ld-hold">${q.hold}日</td>
      <td class="${exCls(q.trainAvgExcess)}">${_fmtPct(q.trainAvgExcess)}</td>
      <td class="ld-muted">${q.trainWinRate}% / ${q.trainN}筆</td>
      <td class="${exCls(q.validAvgExcess)}">${_fmtPct(q.validAvgExcess)}</td>
      <td class="ld-muted">${q.validWinRate}% / ${q.validN}筆</td>
      <td class="ld-score">${q.score}</td>
      <td class="ld-muted">${q.foundAt ?? ''}</td>
      <td><button class="ld-find-btn" data-idx="${idx}">找個股</button>
          <button class="ld-find-btn ld-bt-btn" data-idx="${idx}" title="帶入組合回測跑 2 年全市場驗證">🧪 2Y</button>
          <button class="ld-find-btn ld-sc-btn" data-idx="${idx}" title="套用到個篩自訂條件">🔍 個篩</button>
          <button class="ld-find-btn ld-cc-btn" data-idx="${idx}" title="複製條件細節">📋</button>
          <button class="ld-find-btn ld-arc-btn" data-idx="${idx}" title="晉升名人堂：需先完成 1Y/2Y 實測，晉升時填驗證摘要">🏆</button></td>
    </tr>
    <tr class="ld-match-row" id="ldMatch${idx}" style="display:none"><td colspan="10" class="ld-match-cell"></td></tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="ld-header">
      <span>🔍 候選策略（GAS 每日搜尋）・更新 <b>${data.updatedAt ?? '—'}</b>・基準 ${data.benchmark ?? 'TWII'}・${data.window ?? ''}</span><br>
      <span style="font-size:11px">晉升程序：候選 → 1Y 全市場掃描（真實驗室）→ 2Y 回測（組合回測）→ 證實可靠 → 🏆 名人堂（IDB + Firebase 永久留存）</span>
    </div>
    <table class="ld-table">
      <thead><tr>
        <th>#</th><th>條件組合</th><th>持有</th>
        <th>訓練超額</th><th>訓練勝率/樣本</th>
        <th>驗證超額</th><th>驗證勝率/樣本</th>
        <th>評分</th><th>發現日</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="ld-note">${data.note ?? ''}<br>
      ⚠ 樣本窗僅約半年（120 根），通過驗證 ≠ 長期有效；正式採用前須經 MC 出場回測驗證。</div>`;

  panel.querySelectorAll('.ld-find-btn:not(.ld-bt-btn):not(.ld-arc-btn):not(.ld-sc-btn):not(.ld-cc-btn)').forEach(btn => {
    btn.addEventListener('click', () => _findMatches(data.top[+btn.dataset.idx], +btn.dataset.idx));
  });
  panel.querySelectorAll('.ld-sc-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyToScreener(data.top[+btn.dataset.idx]));
  });
  panel.querySelectorAll('.ld-cc-btn').forEach(btn => {
    btn.addEventListener('click', () => _copyCondDetail(data.top[+btn.dataset.idx], btn));
  });
  panel.querySelectorAll('.ld-bt-btn').forEach(btn => {
    btn.addEventListener('click', () => _sendToBacktest(data.top[+btn.dataset.idx]));
  });
  panel.querySelectorAll('.ld-arc-btn').forEach(btn => {
    btn.addEventListener('click', () => _sendToTribunal(data.top[+btn.dataset.idx]));
  });

  _renderHall(panel);
}

// ── 名人堂（晉升制：候選 → 1Y/2Y 實測 → 證實可靠 → 永久留存 IDB + Firebase）──
/*
 * TWII 同期報酬基準：優先 2y K 線，退 1y。
 * ⚠️ 不做外插（把多頭年外插到無資料區間會灌爆基準）：
 *   - 覆蓋 >=95%：直接同窗總報酬比較
 *   - 覆蓋 60%~95%：雙邊年化日率比較（excess = (策略日率 − TWII日率) × 240，標 annualized）
 *   - 覆蓋 <60%：不核算（回 null，鑑定顯示基準不足）
 */
async function _twiiBench(days) {
  const tryRead = async () => {
    for (const p of ['2y', '1y']) {
      try {
        const c = await getKlineCache('^TWII', p);
        const cs = c?.candles ?? c;
        if (Array.isArray(cs) && cs.length > 30) {
          const n = Math.min(days, cs.length - 1);
          if (n < days * 0.6) continue; // 覆蓋太少，試下一個 period
          const a = cs[cs.length - 1 - n].close, b = cs[cs.length - 1].close;
          const raw = +((b / a - 1) * 100).toFixed(1);
          return { ret: raw, covered: n, days, partial: n < days * 0.95, period: p };
        }
      } catch {}
    }
    return null;
  };
  let r = await tryRead();
  if (r) return r;
  // IDB 不足（R2 bundle 只寫 1y）→ 單檔抓 ^TWII 2y 進快取後重讀（自救一次）
  try {
    await fetchHistoryCached('^TWII', '2y', { allowStale: true });
    r = await tryRead();
  } catch (e) { console.warn('[discovered] ^TWII 2y 補抓失敗:', e.message); }
  return r;
}

/* 超額核算：完整覆蓋比總報酬；部分覆蓋比年化日率（×240 年化呈現） */
function _calcExcess(totalRet, bench) {
  if (totalRet == null || !bench) return null;
  if (!bench.partial) return { v: +(totalRet - bench.ret).toFixed(1), mode: 'total' };
  const stratDaily = totalRet / bench.days;
  const twiiDaily  = bench.ret / bench.covered;
  return { v: +((stratDaily - twiiDaily) * 240).toFixed(1), mode: 'annual' };
}

/* 舊名人堂項目只有 validation 字串 → regex 解析回結構（新項目存 evidence 結構） */
function _parseEvidence(item) {
  if (item.evidence) return item.evidence;
  const v = item.validation ?? '';
  const m1 = v.match(/1Y掃描\(([^)]+)\)：勝率([\-\d.]+)%／均報([\-\d.]+)%／(\d+)\s*筆/);
  const m2 = v.match(/2Y回測\(([^)]+)\)：(\d+)日／(\d+)筆／總報酬([\-\d.]+)%/);
  return {
    scan1y: m1 ? { at: m1[1], wr: +m1[2], avg: +m1[3], n: +m1[4] } : null,
    bt2y:   m2 ? { at: m2[1], days: +m2[2], trades: +m2[3], totalRet: +m2[4] } : null,
    excess2y: null,
  };
}

async function _loadHall() {
  let items = [];
  try { items = await dbGetAll('strategy_hall'); } catch {}
  if (!items.length) {
    // IDB 空（換裝置/重建）→ 從 Firebase 還原
    try {
      const fs = await fsGetShared('strategy_hall');
      if (Array.isArray(fs?.items)) {
        items = fs.items;
        for (const it of items) await dbPut('strategy_hall', it).catch(() => {});
      }
    } catch {}
  }
  return items.sort((a, b) => (b.promotedAt ?? '').localeCompare(a.promotedAt ?? ''));
}

async function _saveHall(items) {
  for (const it of items) await dbPut('strategy_hall', it).catch(() => {});
  try { await fsSetShared('strategy_hall', { items, updatedAt: new Date().toISOString() }); }
  catch (e) { console.warn('[hall] Firebase 寫入失敗:', e.message); }
}

async function _promoteToHall(q, btn) {
  const key = q.conds.join('+') + '@' + q.hold;
  const items = await _loadHall();
  if (items.some(it => it.key === key)) {
    if (btn) btn.textContent = '已在堂';
    return;
  }

  // 系統鑑定：讀 1Y 掃描 / 2Y 回測自動留下的案底（IDB config: sv:組合）
  const sv = await dbGet('config', 'sv:' + key).catch(() => null);
  const hasScan = !!sv?.scan1y;
  const hasBt   = !!sv?.bt2y;

  // ④ 品質門檻：2Y 超額 = 組合總報酬 − 同期 TWII，> 0 才放行
  // （假日接刀手教訓：三步「跑過」≠「過了」，2Y 絕對報酬在世紀行情下可能仍輸大盤）
  let bench = null, excess2y = null, excessMode = 'total';
  if (hasBt && sv.bt2y.totalRet != null) {
    bench = await _twiiBench(sv.bt2y.days || 480);
    const ex = _calcExcess(sv.bt2y.totalRet, bench);
    if (ex) { excess2y = ex.v; excessMode = ex.mode; }
  }
  const hasEdge = excess2y != null && excess2y > 0;
  const canPromote = hasScan && hasBt && hasEdge;

  const stepHtml = (ok, label, detail) => `
    <div class="hc-row ${ok ? 'hc-pass' : 'hc-fail'}" style="grid-template-columns:20px 1fr">
      <div class="hc-row-icon">${ok ? '✓' : '✕'}</div>
      <div class="hc-row-body">
        <div class="hc-row-label">${label}</div>
        <div class="hc-row-sub" style="color:var(--muted)">${detail}</div>
      </div>
    </div>`;

  const zh = q.conds.map(id => COND_LABELS[id] ?? id).join('+');
  const bg = document.createElement('div');
  bg.className = 'lab-modal-bg';
  bg.style.position = 'fixed';
  bg.style.zIndex = '500';
  bg.innerHTML = `
    <div class="lab-modal" style="max-width:520px">
      <div class="lab-modal-header">
        <div class="lab-modal-title">🏆 晉升鑑定 — ${zh}（${q.hold}日）</div>
        <button class="lab-modal-close" id="ldPromoClose">✕</button>
      </div>
      <div class="lab-modal-body">
        <div class="hc-rows" style="border:1px solid var(--border);border-radius:7px;border-top:1px solid var(--border)">
          ${stepHtml(true, '① GAS 每日搜尋（候選）',
            `發現 ${q.foundAt}・訓練 ${q.trainAvgExcess}%/${q.trainN}筆・驗證 ${q.validAvgExcess}%/${q.validN}筆`)}
          ${stepHtml(hasScan, '② 1Y 全市場掃描（真實驗室）',
            hasScan ? `${sv.scan1y.at}・勝率 ${sv.scan1y.wr}%・均報 ${sv.scan1y.avg}%・${sv.scan1y.n} 筆` : '尚未執行 — 到真實驗室按「全市場掃描」')}
          ${stepHtml(hasBt, '③ 2Y 組合回測',
            hasBt ? `${sv.bt2y.at}・${sv.bt2y.days} 交易日・${sv.bt2y.trades} 筆・總報酬 ${sv.bt2y.totalRet != null ? sv.bt2y.totalRet + '%' : '—'}` : '尚未執行 — 候選列按「🧪 2Y」跑組合回測')}
          ${stepHtml(hasEdge, '④ 品質門檻：2Y 超額 vs TWII（同期）',
            excess2y != null
              ? (excessMode === 'total'
                  ? `組合 ${sv.bt2y.totalRet}% − TWII 同窗 ${bench.ret}% = <b style="color:${hasEdge ? 'var(--up,#ef5350)' : 'var(--down,#26a69a)'}">${excess2y > 0 ? '+' : ''}${excess2y}%</b>`
                  : `基準僅覆蓋 ${bench.covered}/${bench.days} 日 → 改比年化日率：策略 ${(sv.bt2y.totalRet / bench.days * 240).toFixed(1)}%/年 − TWII ${(bench.ret / bench.covered * 240).toFixed(1)}%/年 = <b style="color:${hasEdge ? 'var(--up,#ef5350)' : 'var(--down,#26a69a)'}">${excess2y > 0 ? '+' : ''}${excess2y}%/年</b>`)
                + (hasEdge ? '' : ' — 輸大盤，不予晉升')
              : (hasBt ? 'TWII 基準覆蓋 <60%（IDB 缺 ^TWII 長 K），不核算、不放行' : '需先完成 ③'))}
        </div>
        <div style="margin-top:12px">
          <label style="font-size:11px;color:var(--muted)">鑑定備註（選填，例：MC 已過 / 命名「假日接刀手」）</label>
          <input id="ldPromoNote" class="lab-code-input" style="width:100%;margin-top:4px" placeholder="…">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button class="lab-run-btn" id="ldPromoOk" ${canPromote ? '' : 'disabled'}>
            ${canPromote ? '🏆 晉升名人堂' : '證據不足，無法晉升'}
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(bg);

  const close = () => bg.remove();
  bg.querySelector('#ldPromoClose')?.addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  bg.querySelector('#ldPromoOk')?.addEventListener('click', async () => {
    if (!canPromote) return;
    const note = bg.querySelector('#ldPromoNote')?.value?.trim() ?? '';
    const validation =
      `1Y掃描(${sv.scan1y.at})：勝率${sv.scan1y.wr}%／均報${sv.scan1y.avg}%／${sv.scan1y.n}筆；` +
      `2Y回測(${sv.bt2y.at})：${sv.bt2y.days}日／${sv.bt2y.trades}筆／總報酬${sv.bt2y.totalRet ?? '—'}%；` +
      `2Y超額 vs TWII：${excess2y > 0 ? '+' : ''}${excess2y}%` +
      (note ? `；備註：${note}` : '');

    items.unshift({
      key, conds: q.conds, hold: q.hold,
      evidence: { scan1y: sv.scan1y, bt2y: sv.bt2y, excess2y, twii: bench },
      discovered: {
        foundAt: q.foundAt, score: q.score,
        trainAvgExcess: q.trainAvgExcess, trainWinRate: q.trainWinRate, trainN: q.trainN,
        validAvgExcess: q.validAvgExcess, validWinRate: q.validWinRate, validN: q.validN,
      },
      validation,
      promotedAt: new Date().toISOString().slice(0, 10),
    });
    await _saveHall(items);
    close();
    if (btn) btn.textContent = '🏆✓';
    const panel = document.getElementById('labDiscoveredResult');
    if (panel) _renderHall(panel);
  });
}

async function _renderHall(panel) {
  let box = panel.querySelector('.ld-archive');
  const items = await _loadHall();
  if (!items.length) { if (box) box.remove(); return; }

  if (!box) {
    box = document.createElement('div');
    box.className = 'ld-archive';
    panel.appendChild(box);
  }
  const rows = items.map((q, i) => {
    const tags = q.conds.map(id => `<span class="ld-tag">${COND_LABELS[id] ?? id}</span>`).join('');
    const d = q.discovered ?? {};
    return `<tr class="ld-row">
      <td class="ld-conds">${tags}</td>
      <td class="ld-hold">${q.hold}日</td>
      <td class="ld-muted" style="white-space:normal;max-width:260px">驗證：${q.validation ?? '—'}</td>
      <td class="ld-muted">發現 ${d.foundAt ?? '—'}・晉升 ${q.promotedAt ?? '—'}</td>
      <td><button class="ld-find-btn ld-hall-find" data-i="${i}">找個股</button>
          <button class="ld-find-btn ld-hall-bt" data-i="${i}">🧪 2Y</button>
          <button class="ld-find-btn ld-hall-sc" data-i="${i}" title="套用到個篩自訂條件">🔍 個篩</button>
          <button class="ld-find-btn ld-hall-cc" data-i="${i}" title="複製條件細節">📋 條件</button>
          <button class="ld-find-btn ld-hall-copy" data-i="${i}" title="複製完整導入資訊給 AI 協助轉正">📋 導入</button>
          <button class="ld-find-btn ld-hall-del" data-i="${i}" title="移出名人堂">🗑</button></td>
    </tr>
    <tr class="ld-match-row" id="ldHallMatch${i}" style="display:none"><td colspan="5" class="ld-match-cell"></td></tr>`;
  }).join('');

  box.innerHTML = `
    <div class="ld-header" style="padding-top:16px;display:flex;align-items:center;gap:10px">
      <span>🏆 名人堂（${items.length}）— 已通過 1Y/2Y 驗證，IDB + Firebase 永久留存</span>
      <button class="ld-find-btn" id="ldHallCompare" title="名人堂策略並列比較 + 嚴格審核報告">⚖ 比較</button>
    </div>
    <table class="ld-table"><tbody>${rows}</tbody></table>`;

  box.querySelector('#ldHallCompare')?.addEventListener('click', () => _compareHall(items));

  box.querySelectorAll('.ld-hall-find').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.i;
      const row = document.getElementById('ldHallMatch' + i);
      const cell = row?.querySelector('.ld-match-cell');
      if (!row || !cell) return;
      if (row.style.display !== 'none') { row.style.display = 'none'; return; }
      const snap = window.__snapshot;
      if (!snap?.stocks) { cell.innerHTML = '<span class="ld-muted">snapshot 尚未載入</span>'; row.style.display = ''; return; }
      const hits = [];
      for (const [code, sc] of Object.entries(snap.stocks)) {
        if (items[i].conds.every(id => sc[id] === true)) hits.push(code);
      }
      _renderMatchPage(cell, row, items[i], hits, snap, 0);
      row.style.display = '';
    });
  });
  box.querySelectorAll('.ld-hall-bt').forEach(btn => {
    btn.addEventListener('click', () => _sendToBacktest(items[+btn.dataset.i]));
  });
  box.querySelectorAll('.ld-hall-sc').forEach(btn => {
    btn.addEventListener('click', () => _applyToScreener(items[+btn.dataset.i]));
  });
  box.querySelectorAll('.ld-hall-cc').forEach(btn => {
    btn.addEventListener('click', () => _copyCondDetail(items[+btn.dataset.i], btn));
  });
  box.querySelectorAll('.ld-hall-copy').forEach(btn => {
    btn.addEventListener('click', () => _copyAdoptionInfo(items[+btn.dataset.i], btn));
  });
  box.querySelectorAll('.ld-hall-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定移出名人堂？')) return;
      const it = items[+btn.dataset.i];
      await dbDelete('strategy_hall', it.key).catch(() => {});
      const rest = items.filter(x => x.key !== it.key);
      await _saveHall(rest);
      _renderHall(panel);
    });
  });
}

// ── 套用到個篩自訂條件 ──────────────────────────────────────────────────
// 發送端：寫 window.__screenerPresetConds + dispatch event + 切到選股篩選 hub
// 接收端：screener-ui.js 監聽 'screener:applyConds'，勾選對應 condition 並開始篩選
function _applyToScreener(q) {
  const detail = {
    conds: q.conds.slice(),
    name: q.conds.map(id => COND_LABELS[id] ?? id).join('+') + `（${q.hold}日）`,
    source: 'discovered',
  };
  window.__screenerPresetConds = detail;
  document.dispatchEvent(new CustomEvent('screener:applyConds', { detail }));
  document.querySelector('[data-tab="hub"]')?.click();
}

// 複製條件細節（condId + 中文，可貼給 AI 或手動設定個篩）
function _copyCondDetail(q, btn) {
  const zh = q.conds.map(id => COND_LABELS[id] ?? id);
  const text = [
    `策略條件：${zh.join(' + ')}（持有 ${q.hold} 日）`,
    '',
    'condition ids（語意同 heatmap_calc.gs _calcConditions 固定門檻）：',
    ...q.conds.map((id, i) => `- ${id}　${zh[i]}`),
  ].join('\n');
  navigator.clipboard?.writeText(text).then(() => {
    if (btn) { const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = t; }, 1200); }
  }).catch(() => alert('複製失敗'));
}

// ── 名人堂並列比較 + 嚴格審核報告 ───────────────────────────────────────
async function _compareHall(items) {
  // 補算各項目的 2Y 超額（舊項目 evidence 缺 excess2y 時現算）
  const rows = [];
  let flags_annual = false;
  for (const it of items) {
    const ev = _parseEvidence(it);
    let excess = ev.excess2y ?? null;
    let bench = ev.twii ?? null;
    let exMode = 'total';
    if (excess == null && ev.bt2y?.totalRet != null) {
      bench = await _twiiBench(ev.bt2y.days || 480);
      const ex = _calcExcess(ev.bt2y.totalRet, bench);
      if (ex) { excess = ex.v; exMode = ex.mode; }
    }
    if (exMode === 'annual') flags_annual = true;
    // 自動評語旗標
    const flags = [];
    if (excess == null) flags.push('❓無超額基準');
    else if (excess <= 0) flags.push('❌輸大盤');
    else if (excess < 5) flags.push('⚠超額薄');
    if (ev.scan1y && ev.scan1y.n < 100) flags.push('⚠1Y樣本<100');
    if (ev.bt2y && ev.bt2y.trades < 50) flags.push('⚠2Y筆數<50');
    if (ev.scan1y && ev.scan1y.wr < 55) flags.push('⚠勝率<55');
    rows.push({ it, ev, excess, bench, flags });
  }

  const zh = it => it.conds.map(id => COND_LABELS[id] ?? id).join('+');
  const f = v => v == null ? '—' : (v > 0 ? '+' : '') + v + '%';
  const trHtml = rows.map(r => `
    <tr class="ld-row">
      <td style="white-space:normal;max-width:220px">${zh(r.it)}</td>
      <td>${r.it.hold}日</td>
      <td>${r.ev.scan1y ? `${r.ev.scan1y.wr}%／${f(r.ev.scan1y.avg)}／${r.ev.scan1y.n}筆` : '—'}</td>
      <td>${r.ev.bt2y ? `${f(r.ev.bt2y.totalRet)}／${r.ev.bt2y.trades}筆` : '—'}</td>
      <td style="font-weight:700;color:${r.excess > 0 ? 'var(--up,#ef5350)' : 'var(--down,#26a69a)'}">${f(r.excess)}</td>
      <td class="ld-muted" style="white-space:normal">${r.flags.join(' ') || '✅'}</td>
    </tr>`).join('');

  const bg = document.createElement('div');
  bg.className = 'lab-modal-bg';
  bg.style.position = 'fixed';
  bg.style.zIndex = '500';
  bg.innerHTML = `
    <div class="lab-modal" style="max-width:860px">
      <div class="lab-modal-header">
        <div class="lab-modal-title">⚖ 名人堂策略比較（${items.length}）</div>
        <button class="lab-modal-close" id="ldCmpClose">✕</button>
      </div>
      <div class="lab-modal-body">
        <table class="ld-table" style="width:100%">
          <thead><tr class="ld-row" style="color:var(--muted);font-size:11px">
            <th style="text-align:left">條件組合</th><th>持有</th>
            <th>1Y掃描 勝率／均報／筆</th><th>2Y回測 總報酬／筆</th>
            <th>2Y超額vsTWII</th><th>評語</th>
          </tr></thead>
          <tbody>${trHtml}</tbody>
        </table>
        <div class="ld-muted" style="margin-top:8px;font-size:11px">
          超額 = 2Y 組合總報酬 − 同窗 TWII${flags_annual ? '（部分項目基準覆蓋不足，改比年化日率，單位 %/年）' : ''}。1Y 掃描窗與發現窗重疊，數字含 in-sample 成分，超額欄才是落地依據。
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="lab-run-btn" id="ldCmpCopy">📋 複製結果（嚴格審核用）</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#ldCmpClose')?.addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  bg.querySelector('#ldCmpCopy')?.addEventListener('click', () => {
    const md = [
      '# dengdeng 名人堂策略 嚴格審核請求',
      '',
      `產出時間：${new Date().toISOString().slice(0, 16).replace('T', ' ')}・超額基準：同期 TWII（不足時線性外插）`,
      '',
      '| # | 條件組合 | 持有 | 1Y勝率 | 1Y均報 | 1Y筆數 | 2Y總報酬 | 2Y筆數 | 2Y超額vsTWII | 旗標 |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map((r, i) =>
        `| ${i + 1} | ${zh(r.it)} | ${r.it.hold}日 | ${r.ev.scan1y?.wr ?? '—'}% | ${f(r.ev.scan1y?.avg)} | ${r.ev.scan1y?.n ?? '—'} | ${f(r.ev.bt2y?.totalRet)} | ${r.ev.bt2y?.trades ?? '—'} | ${f(r.excess)} | ${r.flags.join(' ') || '✅'} |`),
      '',
      '備註：' + rows.map((r, i) => `#${i + 1} 發現${r.it.discovered?.foundAt ?? '—'}・晉升${r.it.promotedAt ?? '—'}${r.it.validation?.includes('備註') ? '・' + r.it.validation.split('備註：')[1] : ''}`).join('；'),
      '',
      '## 審核要求（請逐項嚴格執行）',
      '1. 逐一講解每個組合的條件邏輯：這是什麼市場情境的故事？條件之間是互補還是冗餘？',
      '2. 過擬合徵兆：發現窗（120根）/ 1Y 掃描窗重疊度、驗證筆數是否撐得起結論、同族組合（同條件不同持有期）是否只是同一訊號重複計數',
      '3. 超額判定：2Y 超額 ≤0 的直接判死；0~5% 的標記「邊緣」並說明風險；基準為外插估算的須提醒不確定性',
      '4. 樣本與勝率：筆數 <50 或勝率 <55% 的，評估是少樣本運氣還是低頻高賠率結構',
      '5. 結論：每個組合給「轉正 / 觀察 / 淘汰」三選一 + 一句理由；若有同族組合，指出該保留哪個持有期',
    ].join('\n');
    navigator.clipboard?.writeText(md).then(() => {
      const b = bg.querySelector('#ldCmpCopy');
      if (b) { b.textContent = '✓ 已複製'; setTimeout(() => { b.textContent = '📋 複製結果（嚴格審核用）'; }, 1500); }
    }).catch(() => alert('複製失敗'));
  });
}

// ── 複製導入資訊（給 AI 協助正式轉正用）─────────────────────────────────
function _copyAdoptionInfo(q, btn) {
  const d = q.discovered ?? {};
  const zh = q.conds.map(id => COND_LABELS[id] ?? id);
  const text = `# dengdeng 策略導入需求

## 策略
- 名稱（暫定）：${zh.join('+')}
- 條件組合（condition ids，GAS heatmap_calc.gs _calcConditions 固定門檻語意）：
${q.conds.map((id, i) => `  - ${id}（${zh[i]}）`).join('\n')}
- 建議持有期：${q.hold} 日（系統發現驗證值）
- 方向：做多

## 績效紀錄
- 發現日：${d.foundAt ?? '—'}（GAS 120根 訓練${d.trainAvgExcess}%/${d.trainN}筆・驗證${d.validAvgExcess}%/${d.validN}筆，超額 vs TWII）
- 實測驗證：${q.validation ?? '—'}
- 晉升名人堂：${q.promotedAt ?? '—'}

## 導入 checklist（dengdeng 慣例）
1. strategy.js：STRATEGIES 加定義 { id, name, icon, category, conds:[${q.conds.map(x => `'${x}'`).join(', ')}] }，id 待指定
2. strategy.js：加入 _SCORABLE_IDS
3. watchlist.js：策略分類加入 POSITIVE set
4. strategy.js：STRATEGY_VERSION +1（讓 signals 快取失效重算）
5. heatmap_calc.gs：TECH_STRATEGIES 同步加同一組 conds（前後端對齊）
6. GAS：重跑 runSnapshotPart1~7 讓 snapshot 含新策略
7. 確認所有 condition 在 heatmap_calc.gs _calcConditions 已存在（本組合全部existing，無需新增 condition）

請依照以上 checklist 協助產生對應的程式修改。`;

  navigator.clipboard?.writeText(text).then(() => {
    if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => { btn.textContent = '📋 導入'; }, 1500); }
  }).catch(() => alert('複製失敗，請手動複製'));
}

// ── 帶入組合回測（2Y 全市場驗證）────────────────────────────────────────
function _sendToBacktest(q) {
  const label = q.conds.map(id => COND_LABELS[id] ?? id).join('+');
  window.__btCustomEntry = {
    id: 'CUSTOM',
    name: `系統發現 ${label}`,
    icon: '🔮',
    category: '系統發現',
    // gas: 前綴 → backtest-engine GAS_LIB（固定門檻，語意同 heatmap_calc.gs）
    conditions: q.conds.map(id => ({ condId: 'gas:' + id })),
    exitDays: q.hold,
  };
  openLabWithCode('', 'backtest');
  document.dispatchEvent(new CustomEvent('bt:customEntry'));
}

// ── 🏆 → ⚖️ 鑑定所一條龍（G1~G4 + 八維風險 + 圖文報告）──
async function _sendToTribunal(q) {
  const label = q.conds.map(id => COND_LABELS[id] ?? id).join('+');
  // 發現日 → timestamp（秒）；foundAt 形如 YYYY-MM-DD
  let foundTs = null;
  if (q.foundAt) { const d = new Date(q.foundAt + 'T00:00:00'); if (!isNaN(d)) foundTs = Math.floor(d.getTime() / 1000); }
  const payload = {
    kind: 'candidate',
    label: `🔮 ${label}（${q.hold}日）`,
    customStrategies: [{
      id: 'CUSTOM', name: label, icon: '🔮', category: '系統發現',
      conditions: q.conds.map(id => ({ condId: 'gas:' + id })),
      exitDays: q.hold,
    }],
    hold: q.hold, exitMode: 'trailing', stopPct: 20, trailPct: 25,
    foundTs,
  };
  const mod = await import('./lab-tribunal.js');
  mod.openTribunal(payload);
}

// ── 今日命中個股（直接查 window.__snapshot，O(1) boolean 比對）──────────
async function _findMatches(q, idx) {
  const row = document.getElementById('ldMatch' + idx);
  if (!row) return;
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }  // toggle 收合

  const cell = row.querySelector('.ld-match-cell');
  const snap = window.__snapshot;
  if (!snap?.stocks) {
    cell.innerHTML = '<span class="ld-muted">snapshot 尚未載入，稍後再試</span>';
    row.style.display = '';
    return;
  }

  const hits = [];
  for (const [code, sc] of Object.entries(snap.stocks)) {
    // ⚠️ snapshot 只存 true 的 condition，必須用 sc[id] === true 判斷
    if (q.conds.every(id => sc[id] === true)) hits.push(code);
  }

  if (!hits.length) {
    cell.innerHTML = `<span class="ld-muted">今日（${snap.date}）全市場無命中——此組合觸發頻率本來就低，屬正常</span>`;
    row.style.display = '';
    return;
  }

  // 渲染題材式小卡（複用 theme.css 的 theme-stock-card 樣式），15 張/頁分頁
  await _renderMatchPage(cell, row, q, hits, snap, 0);
}

const PAGE_SIZE = 15;

async function _renderMatchPage(cell, row, q, hits, snap, page) {
  const totalPages = Math.ceil(hits.length / PAGE_SIZE);
  page = Math.max(0, Math.min(page, totalPages - 1));
  const shown = hits.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // 健康度：IDB stockInfo 批次讀（已掃過的股票）；缺的用 K 線本機現算
  const healthMap = await loadHealthCacheBatch(shown).catch(() => new Map());

  // K 線一次讀齊（健康度現算 + sparkline 共用，不重複查 IDB）
  const candleMap = new Map();
  for (const code of shown) {
    candleMap.set(code, await _getCandles(code));
  }

  const cards = shown.map(code => {
    const pc  = (window.__priceCache ?? {})[code] ?? {};
    const price = pc.price != null ? Number(pc.price).toFixed(pc.price >= 100 ? 1 : 2) : '—';
    const chg = pc.chgPct;
    const chgCls  = chg == null ? '' : (chg >= 0 ? 'up' : 'down');
    const chgTxt  = chg == null ? '' : `${chg >= 0 ? '+' : ''}${Number(chg).toFixed(2)}%`;

    const h  = healthMap.get(code);
    const candles = candleMap.get(code);
    // 短線分：IDB 沒有就本機算（命中名單多是沒掃過的股票）
    const hs = h?.healthShort ?? (candles ? calcHealth(candles) : null);
    // 長線分：calcHealthLong 內建優先讀 __healthSnapshot，缺才本機算
    const hl = h?.healthLong ?? calcHealthLong(candles, null, code);

    const sc = snap.stocks[code];
    const xPills = ['X2','X1','X6','X5']
      .filter(id => X_DEFS[id].every(cid => sc[cid] === true))
      .map(id => `<span class="th-yaogu-pill th-yaogu-pill--${id.toLowerCase()}">${id}</span>`)
      .join('');

    return `<div class="theme-stock-card theme-card--compact ld-card" data-code="${code}"
      style="--t-border:#f0b429;--t-bg:rgba(240,180,41,.10)">
      <div class="theme-stock-header">
        <span class="theme-stock-code">${code}</span>
        <span class="theme-stock-name">${getChineseName(code) || ''}</span>
        <span class="theme-stock-price ${chgCls}">${price} ${chgTxt}</span>
      </div>
      <div class="th-compact-health">
        ${renderHealthBadge(hs, hl)}
        ${xPills}
      </div>
      <canvas class="th-sparkline ld-spark" data-code="${code}" width="220" height="56"></canvas>
    </div>`;
  }).join('');

  const pager = totalPages > 1 ? `
    <div class="ld-pager">
      <button class="ld-page-btn" data-pg="${page - 1}" ${page === 0 ? 'disabled' : ''}>‹</button>
      ${Array.from({ length: totalPages }, (_, i) =>
        `<button class="ld-page-btn ${i === page ? 'active' : ''}" data-pg="${i}">${i + 1}</button>`
      ).join('')}
      <button class="ld-page-btn" data-pg="${page + 1}" ${page === totalPages - 1 ? 'disabled' : ''}>›</button>
    </div>` : '';

  cell.innerHTML = `<span class="ld-muted">今日（${snap.date}）命中 ${hits.length} 檔${totalPages > 1 ? `・第 ${page + 1}/${totalPages} 頁` : ''}：</span>
    <div class="theme-stocks-grid theme-stocks-grid--compact ld-card-grid">${cards}</div>${pager}`;

  cell.querySelectorAll('.ld-page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _renderMatchPage(cell, row, q, hits, snap, +btn.dataset.pg);
    });
  });

  cell.querySelectorAll('.ld-card').forEach(card => {
    card.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('stockSelect', {
        detail: {
          code: card.dataset.code,
          matchedConds: q.conds.map(id => COND_LABELS[id] ?? id),
          strategyId: null,
          strategyName: '系統發現：' + q.conds.map(id => COND_LABELS[id] ?? id).join('+'),
          fromScreener: true,
        }
      }));
    });
  });
  row.style.display = '';

  // sparkline 逐張畫（K 線已在 candleMap，無 IDB 查詢）
  cell.querySelectorAll('.ld-spark').forEach(cv => {
    _drawSpark(cv, candleMap.get(cv.dataset.code));
  });
}

// ── K 線讀取（.TW / .TWO 雙試）─────────────────────────────────────────
async function _getCandles(code) {
  const sym1 = code.length <= 4 ? `${code}.TW` : `${code}.TWO`;
  let cached = await getKlineCache(sym1, '1y').catch(() => null);
  if (!cached?.candles?.length) {
    const sym2 = code.length <= 4 ? `${code}.TWO` : `${code}.TW`;
    cached = await getKlineCache(sym2, '1y').catch(() => null);
  }
  return cached?.candles?.length ? cached.candles : null;
}

// ── sparkline（精簡版，同 theme-ui.js 畫法：近 40 根 + MA20）─────────────
function _drawSpark(canvas, candles) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const closes = (candles ?? []).slice(-40).map(c => c.close ?? c[4] ?? null).filter(v => v != null);
  if (closes.length < 5) {
    ctx.fillStyle = 'rgba(148,163,184,.4)';
    ctx.font = '10px sans-serif';
    ctx.fillText('無快取資料', 8, H / 2);
    return;
  }

  const PAD = 5;
  const minV = Math.min(...closes), maxV = Math.max(...closes);
  const range = maxV - minV || 1;
  const xOf = i => PAD + (i / (closes.length - 1)) * (W - PAD * 2);
  const yOf = v => PAD + (1 - (v - minV) / range) * (H - PAD * 2);

  // MA20（灰）
  if (closes.length >= 20) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148,163,184,.5)';
    ctx.lineWidth = 1;
    for (let i = 19; i < closes.length; i++) {
      const ma = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      if (i === 19) ctx.moveTo(xOf(i), yOf(ma)); else ctx.lineTo(xOf(i), yOf(ma));
    }
    ctx.stroke();
  }

  // 收盤線：40日漲紅跌綠（台股慣例）
  const upTrend = closes[closes.length - 1] >= closes[0];
  ctx.beginPath();
  ctx.strokeStyle = upTrend ? '#ef5350' : '#26a69a';
  ctx.lineWidth = 1.5;
  closes.forEach((v, i) => { if (i === 0) ctx.moveTo(xOf(i), yOf(v)); else ctx.lineTo(xOf(i), yOf(v)); });
  ctx.stroke();
}

function _fmtPct(v) {
  if (typeof v !== 'number') return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
