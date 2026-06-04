// js/firebase.js
// Firebase 初始化模組 — 所有模組統一從這裡 import，不重複初始化
// 使用 Firebase CDN ESM 版本，相容 npx serve 靜態部署

import { initializeApp }       from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore,
         doc, getDoc, setDoc,
         collection, getDocs,
         query, orderBy, startAt, endAt,
         deleteDoc, serverTimestamp }
                                from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth,
         GoogleAuthProvider,
         signInWithPopup,
         signOut,
         onAuthStateChanged }  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ─── Firebase 設定 ────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyCwwADv9WGYUO-iPSJHkGUtJfm8ljxCOd0',
  authDomain:        'stock-2027.firebaseapp.com',
  projectId:         'stock-2027',
  storageBucket:     'stock-2027.firebasestorage.app',
  messagingSenderId: '1076986546579',
  appId:             '1:1076986546579:web:bdadb54d497ba42006c066',
};

// ─── 備援 Firebase（quota 爆時 fallback 用）─────────────────────────────────
const firebaseConfigBakup = {
  apiKey:            'AIzaSyBAcR30kknzHgLkdr9sWwRSi-VTTuPYdec',
  authDomain:        'stock-2027-bakup.firebaseapp.com',
  projectId:         'stock-2027-bakup',
  storageBucket:     'stock-2027-bakup.firebasestorage.app',
  messagingSenderId: '25469285139',
  appId:             '1:25469285139:web:c6a3cbdb9b7652cce6e0e6',
};

// ─── 初始化（只執行一次）─────────────────────────────────────────────────────
const app      = initializeApp(firebaseConfig);
const db       = getFirestore(app);
const auth     = getAuth(app);
const appBakup = initializeApp(firebaseConfigBakup, 'bakup');
const dbBakup  = getFirestore(appBakup);

// ─── Auth 輔助 ────────────────────────────────────────────────────────────────

/** 目前登入的 user（未登入為 null） */
export let currentUser = null;

/** 登入狀態變化時更新 currentUser，並通知全站 */
onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (user) await _ensureProfile(user);
  window.dispatchEvent(new CustomEvent('authStateChanged', { detail: { user } }));
});

/** Google 登入（Popup） */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    // 首次登入：寫入 profile
    await _ensureProfile(result.user);
    return result.user;
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return null;
    throw err;
  }
}

/** 登出 */
export async function signOutUser() {
  await signOut(auth);
}

/** 登入時建立或更新 profile doc，並檢查 pending_upgrades 自動升級 */
async function _ensureProfile(user) {
  const ref  = doc(db, 'users', user.uid, 'meta', 'profile');
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      email:       user.email,
      displayName: user.displayName,
      photoURL:    user.photoURL,
      tier:        'free',
      createdAt:   serverTimestamp(),
    });
  }
  // 每次登入都檢查 pending_upgrades，有對應 email 就自動升級
  try {
    const pendingRef  = doc(db, 'shared', 'admin--pending_upgrades');
    const pendingSnap = await getDoc(pendingRef);
    if (pendingSnap.exists()) {
      const pending = JSON.parse(pendingSnap.data().data ?? '{}');
      const email   = user.email.toLowerCase();
      const match   = Object.keys(pending).find(k => k.toLowerCase() === email);
      if (match) {
        const { tier } = pending[match];
        await setDoc(ref, { tier, upgradedAt: serverTimestamp() }, { merge: true });
        // 從 pending 移除
        delete pending[match];
        await setDoc(pendingRef, { data: JSON.stringify(pending), updatedAt: serverTimestamp() }, { merge: true });
        console.log(`[firebase] pending 升級完成：${email} → ${tier}`);
      }
    }
  } catch (e) {
    console.warn('[firebase] pending_upgrades 檢查失敗', e.message);
  }
}

// ─── Firestore CRUD 輔助（路徑慣例：users/{uid}/{collection}/{docId}） ────────

/**
 * 讀取單一 doc
 * @param {string} uid
 * @param {string} colName  e.g. 'config' | 'watchlist' | 'screener_sets' | 'seed_sets'
 * @param {string} docId
 * @returns {object|null}
 */
export async function fsGet(uid, colName, docId) {
  const snap = await getDoc(doc(db, 'users', uid, colName, docId));
  return snap.exists() ? snap.data() : null;
}

/**
 * 寫入 / 覆蓋單一 doc（merge: true → 只更新傳入欄位）
 */
export async function fsSet(uid, colName, docId, data, merge = false) {
  await setDoc(doc(db, 'users', uid, colName, docId), data, { merge });
}

/**
 * 讀取整個 collection，回傳 Array<{ id, ...data }>
 */
export async function fsGetAll(uid, colName) {
  const snap = await getDocs(collection(db, 'users', uid, colName));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * 刪除單一 doc
 */
export async function fsDelete(uid, colName, docId) {
  await deleteDoc(doc(db, 'users', uid, colName, docId));
}

// ─── 共享資料讀取（shared collection，Cron Worker 寫入，前端公共讀）────────────
// Advanced 1: 讀取 Cron Worker 寫入的全市場資料
// 路徑：shared/{docPath}，例如 shared/market/2026-05-18/prices

/**
 * 讀取 shared collection 的單一 doc（不需要登入）
 * @param {string} docPath  e.g. 'market/2026-05-18/prices'
 * @returns {object|null}
 */
export async function fsGetShared(docPath) {
  const safeKey = docPath.replace(/\//g, '--');

  // ── 主 Firebase ──────────────────────────────────────────
  try {
    const snap = await getDoc(doc(db, 'shared', safeKey));
    if (snap.exists()) {
      const data = snap.data();
      if (data.data && typeof data.data === 'string') return JSON.parse(data.data);
      return data.data ?? data;
    }
  } catch (e) {
    // 429 quota 或其他錯誤 → fallback 到備援 Firebase
    console.warn('[firebase] fsGetShared 主庫失敗，嘗試備援:', docPath, e.message);
  }

  // ── 備援 Firebase（quota 爆時自動切換）──────────────────
  try {
    const snapB = await getDoc(doc(dbBakup, 'shared', safeKey));
    if (snapB.exists()) {
      console.log('[firebase] fsGetShared 備援命中:', docPath);
      const dataB = snapB.data();
      if (dataB.data && typeof dataB.data === 'string') return JSON.parse(dataB.data);
      return dataB.data ?? dataB;
    }
  } catch (e) {
    console.warn('[firebase] fsGetShared 備援也失敗:', docPath, e.message);
  }

  return null;
}

/**
 * 寫入 shared collection 的單一 doc
 * @param {string} docPath  e.g. 'member_keys/ABCD1234'
 * @param {object} data
 */
export async function fsSetShared(docPath, data) {
  const safeKey = docPath.replace(/\//g, '--');
  // data 統一存成 JSON string（與 fsGetShared 讀取方式一致）
  await setDoc(doc(db, 'shared', safeKey), {
    data: JSON.stringify(data),
    _path: docPath,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 刪除 shared collection 的單一 doc
 * @param {string} docPath  e.g. 'member_keys/ABCD1234'
 */
export async function fsDeleteShared(docPath) {
  const safeKey = docPath.replace(/\//g, '--');
  await deleteDoc(doc(db, 'shared', safeKey));
}

/**
 * 讀取 shared collection 中符合前綴的所有 doc
 * @param {string} prefix  e.g. 'member_keys'  → 找所有 shared/member_keys--* 的 doc
 * @returns {Array<{ _id: string, ...data }>}
 */
export async function fsGetAllShared(prefix) {
  try {
    // ⚠️ 不用 getDocs(collection) 全掃，改用範圍 query 避免讀整個 shared collection
    // Firestore 文件 ID 排序是字典序，safePrefix 開頭 >= start，< end（末字元+1）
    const safePrefix = prefix.replace(/\//g, '--') + '--';
    const startKey   = safePrefix;
    const endKey     = safePrefix.slice(0, -1) + String.fromCharCode(safePrefix.charCodeAt(safePrefix.length - 1) + 1);
    const col  = collection(db, 'shared');
    const q    = query(col, orderBy('__name__'), startAt(startKey), endAt(endKey));
    const snap = await getDocs(q);
    const results = [];
    snap.docs.forEach(d => {
      const raw = d.data();
      let parsed = raw;
      if (raw.data && typeof raw.data === 'string') {
        try { parsed = JSON.parse(raw.data); } catch (_) { parsed = raw; }
      }
      const _id = d.id.slice(safePrefix.length).replace(/--/g, '/');
      results.push({ _id, ...parsed });
    });
    return results;
  } catch (e) {
    console.warn('[firebase] fsGetAllShared failed:', prefix, e.message);
    return [];
  }
}

// ─── 重新匯出常用 Firestore 工具（給需要直接操作的模組用）─────────────────────
export { db, auth, serverTimestamp };
