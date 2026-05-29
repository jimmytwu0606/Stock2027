/**
 * theme-etf.js — ETF 撥盤資料存取
 *
 * 被動型 ETF：Firestore shared/etf_passive（管理員預設，不常變）
 * 主動型 ETF：Firestore shared/etf_active（管理員手動維護）
 *
 * 資料格式：
 * [
 *   {
 *     etfCode: '0050',
 *     etfName: '元大台灣50',
 *     stocks:  [{ code: '2330', name: '台積電' }, ...],
 *     updatedAt: 1716000000000
 *   }
 * ]
 */

import { fsGetShared, fsSetShared } from './firebase.js';

const PASSIVE_KEY = 'etf/passive';
const ACTIVE_KEY  = 'etf/active';

// 記憶體快取（同一 session 不重複打 Firestore）
let _passiveCache = null;
let _activeCache  = null;

// ── 被動型 ETF ────────────────────────────────────────────────────────────────

export async function loadEtfPassive() {
  if (_passiveCache) return _passiveCache;
  try {
    const data = await fsGetShared(PASSIVE_KEY);
    _passiveCache = Array.isArray(data) ? data : _defaultPassive();
  } catch(e) {
    console.warn('[theme-etf] loadEtfPassive 失敗', e);
    _passiveCache = _defaultPassive();
  }
  return _passiveCache;
}

export async function saveEtfPassive(list) {
  _passiveCache = list;
  await fsSetShared(PASSIVE_KEY, list);
}

// ── 主動型 ETF ────────────────────────────────────────────────────────────────

export async function loadEtfActive() {
  if (_activeCache) return _activeCache;
  try {
    const data = await fsGetShared(ACTIVE_KEY);
    _activeCache = Array.isArray(data) ? data : [];
  } catch(e) {
    console.warn('[theme-etf] loadEtfActive 失敗', e);
    _activeCache = [];
  }
  return _activeCache;
}

export async function saveEtfActive(list) {
  _activeCache = list;
  await fsSetShared(ACTIVE_KEY, list);
}

// ── 快取清除（手動重整用）────────────────────────────────────────────────────

export function clearEtfCache() {
  _passiveCache = null;
  _activeCache  = null;
}

// ── 預設被動型 ETF（Firestore 尚未設定時的初始資料）────────────────────────

function _defaultPassive() {
  return [
    {
      etfCode: '0050',
      etfName: '元大台灣50',
      stocks: [
        { code: '2330', name: '台積電' },
        { code: '2454', name: '聯發科' },
        { code: '2308', name: '台達電' },
        { code: '2317', name: '鴻海' },
        { code: '3711', name: '日月光投控' },
        { code: '2303', name: '聯電' },
        { code: '2383', name: '台光電' },
        { code: '3037', name: '欣興' },
        { code: '2345', name: '智邦' },
        { code: '2327', name: '國巨' },
        // 其餘由管理員匯入完整名單
      ],
      updatedAt: Date.now(),
    },
    {
      etfCode: '006208',
      etfName: '富邦台灣50',
      stocks: [
        { code: '2330', name: '台積電' },
        { code: '2454', name: '聯發科' },
        { code: '2308', name: '台達電' },
        { code: '2317', name: '鴻海' },
        { code: '3711', name: '日月光投控' },
      ],
      updatedAt: Date.now(),
    },
  ];
}
