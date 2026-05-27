/**
 * auth-tier.js — 三級會員機制核心
 *
 * 等級：guest → free → pro → vvvip
 * 流程：Google 登入（Firebase Auth）+ 8碼序號（Firestore 比對，綁定 email）
 *
 * Firestore 路徑對齊：
 *   個人 tier   → users/{uid}/meta/profile  （firebase.js _ensureProfile 同路徑）
 *   序號資料    → shared/member_keys--{8碼}  （fsGetShared/fsSetShared 轉換）
 *
 * 對外 API：
 *   currentTier               ← 目前等級字串
 *   loadUserTier(uid, email)  ← 登入後呼叫
 *   activateKey(keyCode)      ← 輸入序號驗證並升級
 *   resetTier()               ← 登出時呼叫
 *   requireTier(minTier)      ← 守衛函式
 *   formatKey(raw)            ← 'ABCD1234' → 'ABCD-1234'
 *   generateKey()             ← admin 生成新序號
 */

import { fsGet, fsSet, fsGetShared, fsSetShared } from './firebase.js';

// ─── 等級順序 ─────────────────────────────────────────────────────────────
export const TIER_ORDER = { guest: 0, free: 1, pro: 2, vvvip: 3 };

// ─── 目前登入者狀態 ────────────────────────────────────────────────────────
export let currentTier = 'guest';
let _currentUid        = null;
let _currentEmail      = null;

// ─── 登入後讀取 tier ────────────────────────────────────────────────────────
/**
 * Firebase onAuthStateChanged 登入後呼叫
 * @param {string} uid
 * @param {string} email
 * @returns {Promise<string>} tier
 */
export async function loadUserTier(uid, email) {
  _currentUid   = uid;
  _currentEmail = email;

  try {
    // 路徑對齊 firebase.js _ensureProfile：users/{uid}/meta/profile
    const profile = await fsGet(uid, 'meta', 'profile');
    if (!profile) {
      // 新用戶：建立 free profile（_ensureProfile 已建基本欄位，這裡補 tier）
      await fsSet(uid, 'meta', 'profile', {
        email,
        tier:         'free',
        activatedKey: null,
        activatedAt:  null,
      }, true);   // merge:true → 不蓋掉 displayName / photoURL
      currentTier = 'free';
    } else {
      currentTier = profile.tier ?? 'free';
    }
  } catch (e) {
    console.warn('[auth-tier] loadUserTier 失敗，fallback free', e);
    currentTier = 'free';
  }

  console.log(`[auth-tier] tier = ${currentTier} (${email})`);
  return currentTier;
}

// ─── 登出時重設 ────────────────────────────────────────────────────────────
export function resetTier() {
  currentTier   = 'guest';
  _currentUid   = null;
  _currentEmail = null;
}

// ─── 序號啟用 ──────────────────────────────────────────────────────────────
/**
 * 使用者輸入 8碼序號後呼叫（可帶橫槓，自動去除）
 * @param {string} keyCode  例：'K7MX-N3PQ' 或 'K7MXN3PQ'
 * @returns {Promise<string>} 啟用後的 tier
 * @throws {Error} 序號不存在 / 已停用 / email 不符 / 已使用
 */
export async function activateKey(keyCode) {
  if (!_currentUid || !_currentEmail) throw new Error('請先登入');

  const clean = keyCode.replace(/-/g, '').toUpperCase().trim();
  if (clean.length !== 8) throw new Error('序號格式錯誤（需 8 碼）');

  // 從 Firestore shared 讀序號資料
  // fsGetShared('member_keys/ABCD1234') → shared/member_keys--ABCD1234
  const keyData = await fsGetShared(`member_keys/${clean}`);
  if (!keyData)             throw new Error('序號不存在');
  if (!keyData.isActive)    throw new Error('序號已停用，請聯絡管理員');
  if (keyData.email !== _currentEmail)
                            throw new Error('序號與您的帳號 Email 不符');
  if (keyData.activatedUid) throw new Error('此序號已被使用');

  // 寫入啟用記錄到序號 doc
  await fsSetShared(`member_keys/${clean}`, {
    ...keyData,
    activatedAt:  Date.now(),
    activatedUid: _currentUid,
  });

  // 更新個人 profile（merge，不蓋掉其他欄位）
  await fsSet(_currentUid, 'meta', 'profile', {
    tier:         keyData.tier,
    activatedKey: clean,
    activatedAt:  Date.now(),
  }, true);

  currentTier = keyData.tier;
  console.log(`[auth-tier] 升級至 ${currentTier}`);
  return currentTier;
}

// ─── 守衛函式 ──────────────────────────────────────────────────────────────
/**
 * 判斷目前 tier 是否達到最低需求
 * @param {'free'|'pro'|'vvvip'} minTier
 * @returns {boolean}
 */
export function requireTier(minTier) {
  return (TIER_ORDER[currentTier] ?? 0) >= (TIER_ORDER[minTier] ?? 99);
}

// ─── 序號格式工具 ──────────────────────────────────────────────────────────
/** 'K7MXN3PQ' → 'K7MX-N3PQ' */
export function formatKey(raw) {
  const s = (raw ?? '').replace(/-/g, '').toUpperCase();
  if (s.length < 8) return s;
  return s.slice(0, 4) + '-' + s.slice(4, 8);
}

/** 生成 8碼序號（admin 用，排除易混淆字符 0/O/1/I） */
export function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => chars[b % chars.length])
    .join('');
  return formatKey(raw);
}
