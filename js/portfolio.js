/**
 * portfolio.js — 庫存資料層(多清單版)
 *
 * 兩種清單類型(kind):
 *   - 'holding' 持股清單:有 transactions(交易紀錄)
 *   - 'watch'   追蹤清單:items 每個只有參考價 + 備註
 *
 * 資料結構 (store: portfolio_lists, keyPath: 'id'):
 *   {
 *     id: 'holding_xxx' | 'watch_xxx',
 *     kind: 'holding' | 'watch',
 *     name: '主要持股',
 *     items: [...],
 *     order: 0,
 *     createdAt, updatedAt
 *   }
 *
 *   holding.items[i]:
 *     { code, name, transactions:[{id,type,date,shares,price,note}] }
 *
 *   watch.items[i]:
 *     { code, name, refPrice, note }
 */

import { dbGetAll, dbPut, dbDelete } from './db.js';

const STORE = 'portfolio_lists';

let _lists = null;   // 全部清單 (記憶體快取)

// ─── 載入 / 初始化 ─────────────────────────────────────
export async function loadLists({ skipDefaults = false } = {}) {
  _lists = (await dbGetAll(STORE)) ?? [];

  // 從舊版 portfolio store 遷移一次
  await _migrateLegacy();

  // 確保至少各有一份預設清單
  // skipDefaults=true：由外部（initPortfolio）在雲端 sync 後才建，避免空殼覆蓋雲端
  if (!skipDefaults) {
    if (!_lists.some(l => l.kind === 'holding')) {
      await createList('holding', '主要持股');
    }
    if (!_lists.some(l => l.kind === 'watch')) {
      await createList('watch', '潛力股');
    }
  }
  return _lists;
}

// 從舊版單一 portfolio store 遷移到新 store
async function _migrateLegacy() {
  try {
    const legacy = await dbGetAll('portfolio');
    if (!legacy?.length) return;
    if (_lists.some(l => l.kind === 'holding' && l.id === 'holding_default')) {
      // 已經遷移過
      for (const h of legacy) {
        await dbDelete('portfolio', h.code);
      }
      return;
    }
    const list = {
      id: 'holding_default',
      kind: 'holding',
      name: '主要持股',
      items: legacy.map(h => ({
        code: h.code,
        name: h.name || h.code,
        transactions: h.transactions || [],
      })),
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await dbPut(STORE, list);
    _lists.push(list);
    // 清舊 store
    for (const h of legacy) {
      await dbDelete('portfolio', h.code);
    }
    console.log(`[portfolio] 已從舊版遷移 ${legacy.length} 檔持股`);
  } catch (e) {
    console.warn('[portfolio] 遷移失敗:', e.message);
  }
}

export function listAll(kind) {
  return (_lists ?? []).filter(l => l.kind === kind).sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getList(id) {
  return (_lists ?? []).find(l => l.id === id) ?? null;
}

// ─── 清單 CRUD ─────────────────────────────────────────
export async function createList(kind, name) {
  if (!_lists) await loadLists();
  const list = {
    id: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    kind,
    name: name || (kind === 'holding' ? '新持股清單' : '新追蹤清單'),
    items: [],
    order: _lists.filter(l => l.kind === kind).length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  _lists.push(list);
  await dbPut(STORE, list);
  return list;
}

export async function renameList(id, newName) {
  const list = getList(id);
  if (!list) return null;
  list.name = newName;
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

export async function deleteList(id) {
  _lists = (_lists ?? []).filter(l => l.id !== id);
  await dbDelete(STORE, id);
}

// ─── Holding 操作 ──────────────────────────────────────
export async function holdingAddTx(listId, code, name, tx) {
  const list = getList(listId);
  if (!list || list.kind !== 'holding') return null;
  let item = list.items.find(it => it.code === code);
  if (!item) {
    item = { code, name: name || code, transactions: [] };
    list.items.push(item);
  }
  const newTx = {
    id:     'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type:   tx.type ?? 'buy',
    date:   tx.date || new Date().toISOString().slice(0, 10),
    shares: Number(tx.shares) || 0,
    price:  Number(tx.price)  || 0,
    note:   tx.note ?? '',
  };
  item.transactions.push(newTx);
  if (name && name !== code) item.name = name;
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

export async function holdingUpdateTx(listId, code, txId, patch) {
  const list = getList(listId);
  if (!list || list.kind !== 'holding') return null;
  const item = list.items.find(it => it.code === code);
  if (!item) return null;
  const tx = item.transactions.find(t => t.id === txId);
  if (!tx) return null;
  if (patch.type   != null) tx.type   = patch.type;
  if (patch.date   != null) tx.date   = patch.date;
  if (patch.shares != null) tx.shares = Number(patch.shares) || 0;
  if (patch.price  != null) tx.price  = Number(patch.price)  || 0;
  if (patch.note   != null) tx.note   = patch.note;
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

export async function holdingRemoveTx(listId, code, txId) {
  const list = getList(listId);
  if (!list || list.kind !== 'holding') return null;
  const item = list.items.find(it => it.code === code);
  if (!item) return null;
  item.transactions = item.transactions.filter(t => t.id !== txId);
  if (item.transactions.length === 0) {
    list.items = list.items.filter(it => it.code !== code);
  }
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

export async function holdingRemoveCode(listId, code) {
  const list = getList(listId);
  if (!list || list.kind !== 'holding') return null;
  list.items = list.items.filter(it => it.code !== code);
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

// ─── Watch 操作 ────────────────────────────────────────
export async function watchAddCode(listId, code, name, refPrice = 0, note = '', refAt = null) {
  const list = getList(listId);
  if (!list || list.kind !== 'watch') return null;
  if (list.items.find(it => it.code === code)) return list;  // 已存在
  list.items.push({
    code,
    name: name || code,
    refPrice: Number(refPrice) || 0,
    refAt:    refAt || (refPrice > 0 ? Date.now() : null),   // 鎖定參考價的時間
    note:     note || '',
  });
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

export async function watchUpdate(listId, code, patch) {
  const list = getList(listId);
  if (!list || list.kind !== 'watch') return null;
  const item = list.items.find(it => it.code === code);
  if (!item) return null;
  if (patch.name     != null) item.name     = patch.name;
  if (patch.refPrice != null) {
    item.refPrice = Number(patch.refPrice) || 0;
    item.refAt    = patch.refAt ?? Date.now();   // 更新價格時順手記下時間
  }
  if (patch.note     != null) item.note     = patch.note;
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

export async function watchRemoveCode(listId, code) {
  const list = getList(listId);
  if (!list || list.kind !== 'watch') return null;
  list.items = list.items.filter(it => it.code !== code);
  list.updatedAt = Date.now();
  await dbPut(STORE, list);
  return list;
}

// ─── 計算 ──────────────────────────────────────────────
/** 算出持股 item 目前狀態 */
export function calcHoldingItem(item) {
  if (!item?.transactions?.length) {
    return { shares: 0, avgCost: 0, totalCost: 0 };
  }
  let totalBuyShares = 0, totalBuyCost = 0, totalSellShares = 0;
  for (const t of item.transactions) {
    const s = Number(t.shares) || 0;
    const p = Number(t.price)  || 0;
    if (t.type === 'sell') {
      totalSellShares += s;
    } else {
      totalBuyShares += s;
      totalBuyCost   += s * p;
    }
  }
  const avgCost = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;
  const shares  = totalBuyShares - totalSellShares;
  return {
    shares,
    avgCost,
    totalCost: avgCost * Math.max(0, shares),
  };
}

export function calcHoldingPL(item, currentPrice) {
  const { shares, avgCost, totalCost } = calcHoldingItem(item);
  if (shares <= 0 || !currentPrice || !avgCost) {
    return { pl: 0, plPct: 0, marketValue: 0 };
  }
  const marketValue = currentPrice * shares;
  return {
    pl: marketValue - totalCost,
    plPct: (currentPrice - avgCost) / avgCost * 100,
    marketValue,
  };
}

/** 算持股清單彙總 */
export function calcListTotals(list, priceLookup) {
  if (!list || list.kind !== 'holding') return null;
  let totalCost = 0, totalMV = 0;
  for (const item of list.items) {
    const { shares, avgCost, totalCost: c } = calcHoldingItem(item);
    if (shares <= 0) continue;
    const px = priceLookup(item.code);
    totalCost += c;
    totalMV   += (px ?? avgCost) * shares;
  }
  const totalPL    = totalMV - totalCost;
  const totalPLPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  return { totalCost, totalMarketValue: totalMV, totalPL, totalPLPct };
}

/** 追蹤清單距離參考價 */
export function calcWatchDistance(item, currentPrice) {
  if (!currentPrice || !item?.refPrice) return { distPct: 0 };
  return { distPct: (currentPrice - item.refPrice) / item.refPrice * 100 };
}
