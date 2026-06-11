/**
 * api-snapshot.js — 盤後 snapshot / 健康快照 / 條件歷史序列
 */
import { _WORKER_ORIGIN, PROXY_TOKEN } from './api-core.js';


// ── signals snapshot（GAS 每日預算，全市場 condition boolean）────────────
// ─── fetchHealthSnapshot：載入全市場健康度快照（GAS 每日算好）─────────────
// 存 window.__healthSnapshot = { date, data: { code: { ll: number } } }
// health.js calcHealthLong 優先讀快照，快照缺才本機算

let _healthSnapshotLoading = null;

export async function fetchHealthSnapshot({ force = false } = {}) {
  if (!force && window.__healthSnapshot) return window.__healthSnapshot;
  if (_healthSnapshotLoading) return _healthSnapshotLoading;

  _healthSnapshotLoading = (async () => {
    try {
      const url = `${_WORKER_ORIGIN}/health-snapshot`;
      const res = await fetch(url, {
        cache: 'no-store',
        headers: PROXY_TOKEN ? { 'X-Proxy-Token': PROXY_TOKEN } : {},
      });
      if (!res.ok) throw new Error(`health-snapshot ${res.status}`);
      const data = await res.json();
      window.__healthSnapshot = data;
      console.log(`[health-snapshot] 載入完成：${Object.keys(data.data || {}).length} 支，日期 ${data.date}`);
      return data;
    } catch (e) {
      console.warn('[health-snapshot] 載入失敗:', e.message);
      return null;
    } finally {
      _healthSnapshotLoading = null;
    }
  })();

  return _healthSnapshotLoading;
}

// 存 window.__snapshot = { date, stocks: { code: { condId: true/number } } }
// 前端用來做預設策略快速篩（不需要本機 K 線運算）

let _snapshotLoading = null;

export async function fetchSnapshot({ force = false } = {}) {
  // 已載入且不強制重取
  if (!force && window.__snapshot) return window.__snapshot;
  // 防重複發請求
  if (_snapshotLoading) return _snapshotLoading;

  _snapshotLoading = (async () => {
    try {
      const url = `${_WORKER_ORIGIN}/snapshot`;
      const res = await fetch(url, {
        cache: 'no-store',
        headers: PROXY_TOKEN ? { 'X-Proxy-Token': PROXY_TOKEN } : {},
      });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const data = await res.json();

      // ── 防火牆：檢查 GAS 驗算結果 ──────────────────────────────────────
      const quality = data._quality;
      if (quality) {
        if (!quality.pass) {
          // 驗算失敗：不使用 snapshot，fallback 本機算
          console.warn(`[snapshot] ⚠️ 品質驗算未通過（偏差率 ${quality.rate}%，原因 ${quality.reason}）→ 導向本機模式`);
          window.__snapshotQualityFail = quality;
          return null;  // 讓 main.js 顯示警告，screener 走 needKline
        }
        console.log(`[snapshot] 品質驗算通過（偏差率 ${quality.rate}%，抽樣 ${quality.sampled} 支）`);
      }

      window.__snapshot = data;
      console.log(`[snapshot] 載入完成：${Object.keys(data.stocks || {}).length} 支，日期 ${data.date}`);
      return data;
    } catch (e) {
      console.warn('[snapshot] 載入失敗:', e.message);
      return null;
    } finally {
      _snapshotLoading = null;
    }
  })();

  return _snapshotLoading;
}

let _condHistoryLoading = null;

// ── 載入條件歷史序列（signals:cond:part:1~7）→ window.__condHistory ──────────
// 格式：{ stocks: { code: { len, seq: [trueCondIds[]] } } }，seq 由舊到新
// 供 screener snapshot 路徑算 triggerHistory（streak），不需重算指標
export async function fetchCondHistory({ force = false } = {}) {
  if (!force && window.__condHistory) return window.__condHistory;
  if (_condHistoryLoading) return _condHistoryLoading;

  _condHistoryLoading = (async () => {
    try {
      const merged = { date: null, stocks: {} };
      // 7 個 part 並行載入
      const parts = await Promise.allSettled(
        [1,2,3,4,5,6,7].map(async (p) => {
          const url = `${_WORKER_ORIGIN}/cond-raw?part=${p}`;
          const res = await fetch(url, {
            cache: 'no-store',
            headers: PROXY_TOKEN ? { 'X-Proxy-Token': PROXY_TOKEN } : {},
          });
          if (!res.ok) throw new Error(`cond part${p} ${res.status}`);
          return res.json();
        })
      );
      let okCount = 0;
      parts.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value?.stocks) {
          if (!merged.date) merged.date = r.value.date;
          Object.assign(merged.stocks, r.value.stocks);
          okCount++;
        } else {
          console.warn(`[cond-hist] part${i+1} 載入失敗`);
        }
      });
      if (okCount === 0) { window.__condHistory = null; return null; }
      window.__condHistory = merged;
      console.log(`[cond-hist] 載入完成：${Object.keys(merged.stocks).length} 支（${okCount}/7 part），日期 ${merged.date}`);
      return merged;
    } catch (e) {
      console.warn('[cond-hist] 載入失敗:', e.message);
      return null;
    } finally {
      _condHistoryLoading = null;
    }
  })();

  return _condHistoryLoading;
}

// 用 snapshot 跑預設策略篩選，回傳 { strategyId: [{ code, name, price, chgPct, vol }] }
export function runSnapshotScreener(strategies, snapshot) {
  if (!snapshot?.stocks) return {};
  const result = {};

  strategies.forEach(strat => {
    const hits = [];
    Object.entries(snapshot.stocks).forEach(([code, conds]) => {
      const match = strat.conditions.every(condDef => {
        const id  = condDef.id;
        const val = conds[id];
        if (val === undefined || val === null) return false;

        // 數值型 condition（chg_min, price_min, price_max, vol_min）
        if (condDef.type === 'number') {
          const threshold = condDef.params?.[0]?.value ?? condDef.default ?? 0;
          if (id === 'price_max' || id === 'chg_max' || id === 'vol_max' || id === 'rsi_max' || id === 'kd_k_max') {
            return typeof val === 'number' && val <= threshold;
          }
          return typeof val === 'number' && val >= threshold;
        }
        // boolean condition
        return val === true;
      });
      if (match) hits.push(code);
    });
    if (hits.length > 0) result[strat.id] = hits;
  });

  return result;
}
