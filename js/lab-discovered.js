/**
 * lab-discovered.js — 🔮 系統發現策略（VVVIP）
 *
 * 資料源：Worker GET /discovered → R2 signals:strategy:discovered
 *        （strategy_search.gs 每日 18:00 後寫入名人堂 top 10）
 *
 * 對外：bindDiscoveredRun()  ← strategy-lab.js lazy bind 呼叫
 */

import { getChineseName } from './api.js';
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

  panel.querySelectorAll('.ld-find-btn:not(.ld-bt-btn)').forEach(btn => {
    btn.addEventListener('click', () => _findMatches(data.top[+btn.dataset.idx], +btn.dataset.idx));
  });
  panel.querySelectorAll('.ld-bt-btn').forEach(btn => {
    btn.addEventListener('click', () => _sendToBacktest(data.top[+btn.dataset.idx]));
  });
  panel.querySelectorAll('.ld-arc-btn').forEach(btn => {
    btn.addEventListener('click', () => _promoteToHall(data.top[+btn.dataset.idx], btn));
  });

  _renderHall(panel);
}

// ── 名人堂（晉升制：候選 → 1Y/2Y 實測 → 證實可靠 → 永久留存 IDB + Firebase）──
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
  const canPromote = hasScan && hasBt;

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
      `2Y回測(${sv.bt2y.at})：${sv.bt2y.days}日／${sv.bt2y.trades}筆／總報酬${sv.bt2y.totalRet ?? '—'}%` +
      (note ? `；備註：${note}` : '');

    items.unshift({
      key, conds: q.conds, hold: q.hold,
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
          <button class="ld-find-btn ld-hall-copy" data-i="${i}" title="複製完整導入資訊給 AI 協助轉正">📋 導入</button>
          <button class="ld-find-btn ld-hall-del" data-i="${i}" title="移出名人堂">🗑</button></td>
    </tr>
    <tr class="ld-match-row" id="ldHallMatch${i}" style="display:none"><td colspan="5" class="ld-match-cell"></td></tr>`;
  }).join('');

  box.innerHTML = `
    <div class="ld-header" style="padding-top:16px">🏆 名人堂（${items.length}）— 已通過 1Y/2Y 驗證，IDB + Firebase 永久留存</div>
    <table class="ld-table"><tbody>${rows}</tbody></table>`;

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
