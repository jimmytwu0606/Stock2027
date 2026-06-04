/**
 * auth-tier.js — 三級會員機制核心
 *
 * 等級：guest → free → pro → vvvip
 * 流程：Google 登入（Firebase Auth）→ 讀取 profile.tier
 *       升級由管理員在後台直接操作，不開放序號自助啟用
 *
 * Firestore 路徑：
 *   個人 tier → users/{uid}/meta/profile （firebase.js _ensureProfile 同路徑）
 *
 * 對外 API：
 *   currentTier               ← 目前等級字串
 *   loadUserTier(uid, email)  ← 登入後呼叫
 *   resetTier()               ← 登出時呼叫
 *   requireTier(minTier)      ← 守衛函式
 */

import { fsGet, fsSet } from './firebase.js';

// ─── 等級順序 ─────────────────────────────────────────────────────────────
export const TIER_ORDER = { guest: 0, free: 1, pro: 2, vvvip: 3 };

// ─── 目前登入者狀態 ────────────────────────────────────────────────────────
export let currentTier = 'guest';
let _currentUid        = null;
let _currentEmail      = null;

// ─── 登入後讀取 tier ───────────────────────────────────────────────────────
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
    const profile = await fsGet(uid, 'meta', 'profile');
    if (!profile) {
      await fsSet(uid, 'meta', 'profile', {
        email,
        tier:      'free',
        upgradedAt: null,
      }, true);
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

// ─── 守衛函式 ──────────────────────────────────────────────────────────────
/**
 * 判斷目前 tier 是否達到最低需求
 * @param {'free'|'pro'|'vvvip'} minTier
 * @returns {boolean}
 */
export function requireTier(minTier) {
  return (TIER_ORDER[currentTier] ?? 0) >= (TIER_ORDER[minTier] ?? 99);
}
