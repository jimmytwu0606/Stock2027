/**
 * auth-ui.js — 登入 / 登出 UI + 雲端同步觸發
 *
 * 負責：
 *   1. 右上角渲染登入按鈕 / 使用者頭像
 *   2. Google OAuth 登入 / 登出
 *   3. 登入後觸發 syncLocalToCloud()（本地 → 雲端）
 *   4. 新裝置登入時觸發 syncCloudToLocal()（雲端 → 本地）
 *   5. 派發 authReady 事件，讓 main.js / watchlist.js 知道同步完成可以 re-render
 *
 * HTML 依賴（index.html 需有）：
 *   <div id="authArea"></div>   ← 放在 topbar 右側
 */

import { currentUser, signInWithGoogle, signOutUser,
         fsGetAll, fsGet }                            from './firebase.js';
import { syncLocalToCloud, syncCloudToLocal,
         dbPut, dbClear }                             from './db.js';
import { showToast }                                  from './ui.js';
import { initWatchlist }                              from './watchlist.js';
import { loadUserTier, resetTier,
         currentTier }                                from './auth-tier.js';
import { applyTierGate, loadFeatureGates, saveFeatureGates,
         getFeatureGates, DEFAULT_GATES, GATE_LABELS }  from './auth-gate.js';

// ─── 初始化 ───────────────────────────────────────────────────────────────

export function initAuthUI() {
  _render(currentUser);   // 初始狀態（可能已登入）

  // 監聽登入狀態變化（由 firebase.js 的 onAuthStateChanged 派發）
  window.addEventListener('authStateChanged', async (e) => {
    const user = e.detail?.user ?? null;
    _render(user);

    if (user) {
      await _handleSignIn(user);
    } else {
      _handleSignOut();
    }
  });
}

// ─── 登入後處理 ───────────────────────────────────────────────────────────

async function _handleSignIn(user) {
  showToast(`✓ 已登入：${user.displayName ?? user.email}`);

  // 讀取 tier + feature gates（必須在 applyTierGate 之前）
  await loadFeatureGates();
  const tier = await loadUserTier(user.uid, user.email);
  applyTierGate(tier);

  // 先試著從雲端還原（新裝置 / 本地空資料時才會真正執行）
  await syncCloudToLocal();

  // 再把本地資料上傳補齊雲端
  await syncLocalToCloud();

  // 通知其他模組同步完成，可重新讀取資料
  window.dispatchEvent(new CustomEvent('authReady', { detail: { user, tier } }));
}

function _handleSignOut() {
  resetTier();
  applyTierGate('guest');
  showToast('已登出');
  window.dispatchEvent(new CustomEvent('authReady', { detail: { user: null } }));
}

// ─── UI 渲染 ──────────────────────────────────────────────────────────────

function _render(user) {
  const area = document.getElementById('authArea');
  if (!area) return;

  if (user) {
    // 已登入：顯示頭像 + 名稱 + tier badge + 升級序號 + 同步 + 登出
    const tierLabel = { free: 'Free', pro: '🔒 Pro', vvvip: '👑 VVVIP' }[currentTier] ?? 'Free';
    area.innerHTML = `
      <div class="auth-user" id="authUserMenu">
        ${user.photoURL
          ? `<img class="auth-avatar" src="${user.photoURL}" alt="avatar" referrerpolicy="no-referrer">`
          : `<div class="auth-avatar auth-avatar-placeholder">${_initial(user)}</div>`
        }
        <span class="auth-name">${user.displayName ?? user.email}</span>
        <span class="auth-tier-badge auth-tier-${currentTier}">${tierLabel}</span>
        <button class="auth-key-btn" id="authKeyBtn" title="升級序號">🔑</button>
        <button class="auth-sync-btn" id="authSyncBtn" title="雲端同步">☁</button>
        <button class="auth-signout-btn" id="authSignOutBtn" title="登出">登出</button>
      </div>
    `;
    document.getElementById('authSignOutBtn')?.addEventListener('click', async () => {
      await signOutUser();
    });
    document.getElementById('authSyncBtn')?.addEventListener('click', () => {
      _showSyncModal();
    });
    document.getElementById('authKeyBtn')?.addEventListener('click', () => {
      _showKeyModal();
    });
  } else {
    // 未登入：顯示登入按鈕
    area.innerHTML = `
      <button class="auth-signin-btn" id="authSignInBtn">
        <svg width="16" height="16" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
          <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
          <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.58-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Google 登入
      </button>
    `;
    document.getElementById('authSignInBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('authSignInBtn');
      if (btn) { btn.disabled = true; btn.textContent = '登入中…'; }
      try {
        await signInWithGoogle();
        // 結果由 authStateChanged 事件處理，不需在這裡做額外動作
      } catch (err) {
        showToast('⚠ 登入失敗：' + err.message);
        _render(null);   // 還原按鈕
      }
    });
  }
}

function _initial(user) {
  return (user.displayName ?? user.email ?? '?')[0].toUpperCase();
}

// ─── 同步 Modal ───────────────────────────────────────────────────────────

function _showSyncModal() {
  // 防止重複
  document.getElementById('syncModalOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'syncModalOverlay';
  overlay.className = 'sync-modal-overlay';
  overlay.innerHTML = `
    <div class="sync-modal">
      <h3>☁ 雲端同步</h3>
      <p>選擇同步方向。<br>
         <strong>上傳</strong>：本地資料覆蓋雲端<br>
         <strong>下載</strong>：雲端資料覆蓋本地（自選清單會重新載入）
      </p>
      <div class="sync-modal-btns">
        <button class="sync-btn-upload" id="syncUploadBtn">
          ↑ 上傳本地 → 雲端
        </button>
        <button class="sync-btn-download" id="syncDownloadBtn">
          ↓ 下載雲端 → 本地
        </button>
        <button class="sync-btn-cancel" id="syncCancelBtn">取消</button>
      </div>
      <div class="sync-modal-status" id="syncModalStatus"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const status  = document.getElementById('syncModalStatus');

  const _setStatus = (msg) => { if (status) status.textContent = msg; };
  const _close     = () => overlay.remove();

  document.getElementById('syncCancelBtn')?.addEventListener('click', _close);
  overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });

  // 上傳
  document.getElementById('syncUploadBtn')?.addEventListener('click', async () => {
    _setStatus('上傳中…');
    document.querySelectorAll('.sync-modal-btns button').forEach(b => b.disabled = true);
    try {
      await syncLocalToCloud();
      _setStatus('✓ 上傳完成');
      showToast('✓ 已上傳至雲端');
      setTimeout(_close, 1200);
    } catch (err) {
      _setStatus('⚠ 上傳失敗：' + err.message);
      document.querySelectorAll('.sync-modal-btns button').forEach(b => b.disabled = false);
    }
  });

  // 下載
  document.getElementById('syncDownloadBtn')?.addEventListener('click', async () => {
    _setStatus('下載中…');
    document.querySelectorAll('.sync-modal-btns button').forEach(b => b.disabled = true);
    try {
      // 強制下載（略過本地有資料的保護）
      await _forceCloudToLocal();
      // 重新載入自選清單
      await initWatchlist();
      window.dispatchEvent(new CustomEvent('authReady', { detail: { user: currentUser } }));
      _setStatus('✓ 下載完成，清單已更新');
      showToast('✓ 已從雲端還原資料');
      setTimeout(_close, 1200);
    } catch (err) {
      _setStatus('⚠ 下載失敗：' + err.message);
      document.querySelectorAll('.sync-modal-btns button').forEach(b => b.disabled = false);
    }
  });
}

// 強制從雲端下載（不檢查本地是否有資料）
async function _forceCloudToLocal() {
  if (!currentUser) throw new Error('未登入');
  const uid = currentUser.uid;

  const stores = [
    { fs: 'watchlist',        idb: 'watchlistGroups' },
    { fs: 'screener_sets',    idb: 'screenerSets' },
    { fs: 'screener_results', idb: 'screenerResults' },
    { fs: 'seed_sets',        idb: 'seedSets' },
  ];

  for (const { fs, idb } of stores) {
    const rows = await fsGetAll(uid, fs);
    await dbClear(idb);
    for (const row of rows) await dbPut(idb, row);
  }

  // config
  const cfgDoc = await fsGet(uid, 'config', 'appConfig');
  if (cfgDoc) {
    for (const [k, v] of Object.entries(cfgDoc)) {
      await dbPut('config', { key: k, value: v });
    }
  }
}

// ─── 序號升級 Modal ──────────────────────────────────────────────────────

function _showKeyModal() {
  document.getElementById('keyModalOverlay')?.remove();

  const isVvvip = currentTier === 'vvvip';

  const _tierLabel = { free:'Free', pro:'Pro', vvvip:'VVVIP' };
  const _tierOrder = { guest:0, free:1, pro:2, vvvip:3 };
  const _myLvl = _tierOrder[currentTier] ?? 0;

  const _row = (label, guest, free, pro) => {
    const _cell = (minLvl) => {
      const ok = _myLvl >= minLvl;
      const active = _myLvl === minLvl || (minLvl === 2 && _myLvl >= 2);
      return `<td style="text-align:center;padding:6px 4px;font-size:13px;color:${ok ? 'var(--up)' : 'var(--hint)'}">
        ${ok ? '✓' : '—'}
      </td>`;
    };
    return `<tr style="border-bottom:1px solid var(--hint)">
      <td style="padding:6px 8px;font-size:12px;color:var(--text)">${label}</td>
      ${_cell(guest ? 0 : 99)}
      ${_cell(free ? 1 : 99)}
      ${_cell(pro ? 2 : 99)}
    </tr>`;
  };

  const _featTable = `
    <div style="margin:14px 0 10px;border-top:1px solid var(--hint);padding-top:12px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px;letter-spacing:0.05em;text-transform:uppercase">功能對照</div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="padding:4px 8px;font-size:11px;color:var(--muted);font-weight:500;text-align:left"></th>
            <th style="padding:4px 4px;font-size:11px;font-weight:500;text-align:center;color:${currentTier==='guest'?'var(--accent)':'var(--muted)'}">訪客</th>
            <th style="padding:4px 4px;font-size:11px;font-weight:500;text-align:center;color:${currentTier==='free'?'var(--accent)':'var(--muted)'}">Free</th>
            <th style="padding:4px 4px;font-size:11px;font-weight:500;text-align:center;color:${currentTier==='pro'||currentTier==='vvvip'?'var(--accent)':'var(--muted)'}">Pro</th>
          </tr>
        </thead>
        <tbody>
          ${_row('K線看盤 / 強勢族群', true, true, true)}
          ${_row('題材追蹤', false, true, true)}
          ${_row('妖股查詢', false, false, true)}
          ${_row('庫存 / 策略選股', false, false, true)}
          ${_row('個股篩選 / 型態 / 種子', false, false, true)}
          ${_row('智能分析 / 基本面 / 新聞', false, true, true)}
          ${_row('多週期共振', false, false, true)}
          ${_row('Ichimoku / EMA / BB', false, true, true)}
          ${_row('進階指標（ENV/SAR/GMMA…）', false, false, true)}
          ${_row('雲端備份同步', false, true, true)}
        </tbody>
      </table>
    </div>`;

  const overlay = document.createElement('div');
  overlay.id        = 'keyModalOverlay';
  overlay.className = 'sync-modal-overlay';
  overlay.innerHTML = `
    <div class="sync-modal auth-key-modal" style="max-width:480px">
      <h3>🔑 會員等級</h3>
      <p>目前等級：<strong>${_tierLabel[currentTier] ?? 'Free'}</strong></p>
      <p class="auth-key-hint">如需升級請聯絡管理員。</p>
      ${_featTable}
      ${isVvvip ? `<button class="setting-btn" id="adminPanelBtn" style="margin-top:12px">🔧 管理後台</button>` : ''}
      <button class="sync-btn-cancel" id="keyCancelBtn" style="margin-top:8px">關閉</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const _close = () => overlay.remove();
  document.getElementById('keyCancelBtn')?.addEventListener('click', _close);
  overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });

  document.getElementById('adminPanelBtn')?.addEventListener('click', () => {
    _close();
    _showAdminPanel();
  });
}

// ─── 管理後台 Panel（VVVIP 限定）────────────────────────────────────────

async function _showAdminPanel() {
  if (currentTier !== 'vvvip') return;
  document.getElementById('adminPanelOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'adminPanelOverlay';
  overlay.className = 'sync-modal-overlay';
  overlay.innerHTML = `
    <div class="sync-modal admin-panel">
      <div class="admin-header">
        <h3>🔧 管理後台</h3>
        <nav class="admin-tab-bar">
          <button class="admin-tab active" data-admin-tab="members">👥 會員管理</button>
          <button class="admin-tab" data-admin-tab="gates">🔐 功能權限</button>
        </nav>
      </div>

      <!-- 會員管理 Tab -->
      <div class="admin-tab-panel active" id="adminTabMembers">
        <div class="admin-section">
          <div class="admin-section-title">升級會員</div>
          <div class="admin-add-row">
            <input id="adminEmail" class="auth-key-input" type="email" placeholder="會員 Email" style="flex:2"/>
            <select id="adminTier" class="auth-key-input" style="flex:1">
              <option value="pro">Pro</option>
              <option value="vvvip">VVVIP</option>
            </select>
            <button class="auth-key-submit" id="adminUpgradeBtn">升級</button>
          </div>
          <div class="admin-key-result" id="adminKeyResult"></div>
        </div>
        <div class="admin-section">
          <div class="admin-section-title">
            會員列表
            <button class="auth-key-submit" id="adminRefreshBtn" style="font-size:11px;padding:2px 8px">重整</button>
          </div>
          <div class="admin-list" id="adminList">載入中…</div>
        </div>
      </div>

      <!-- 功能權限 Tab -->
      <div class="admin-tab-panel" id="adminTabGates">
        <div class="admin-gates-hint">
          設定各功能的最低所需等級。改完按「儲存設定」即時生效，不需重整頁面。
        </div>
        <div id="adminGatesList">載入中…</div>
        <div class="admin-gates-footer">
          <button class="sync-btn-cancel" id="adminGatesResetBtn">還原預設</button>
          <button class="auth-key-submit" id="adminGatesSaveBtn">💾 儲存設定</button>
        </div>
      </div>

      <button class="sync-btn-cancel" id="adminCloseBtn" style="margin-top:12px">關閉</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const _close = () => overlay.remove();
  document.getElementById('adminCloseBtn')?.addEventListener('click', _close);
  overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });

  _loadAdminList();
  document.getElementById('adminRefreshBtn')?.addEventListener('click', _loadAdminList);

  // ── admin Tab 切換 ──────────────────────────────────
  overlay.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      overlay.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tabId = btn.dataset.adminTab === 'members' ? 'adminTabMembers' : 'adminTabGates';
      document.getElementById(tabId)?.classList.add('active');
      if (btn.dataset.adminTab === 'gates') _renderGatesPanel();
    });
  });

  document.getElementById('adminUpgradeBtn')?.addEventListener('click', async () => {
    const email  = document.getElementById('adminEmail')?.value?.trim().toLowerCase();
    const tier   = document.getElementById('adminTier')?.value;
    const result = document.getElementById('adminKeyResult');
    if (!email) { if (result) result.textContent = '請輸入 Email'; return; }
    const { fsGetShared, fsSetShared } = await import('./firebase.js');
    try {
      // 寫入 pending_upgrades，用戶下次登入自動生效
      const pending = await fsGetShared('admin/pending_upgrades') ?? {};
      pending[email] = { tier, createdAt: Date.now() };
      await fsSetShared('admin/pending_upgrades', pending);
      if (result) result.innerHTML =
        `✅ 已加入待升級<br>Email：${email}　等級：<strong>${tier}</strong><br>` +
        `<span style="color:var(--muted);font-size:11px">用戶下次登入自動生效</span>`;
      document.getElementById('adminEmail').value = '';
      _loadAdminList();
    } catch (err) {
      if (result) result.textContent = `❌ 失敗：${err.message}`;
    }
  });
}

async function _loadAdminList() {
  const listEl = document.getElementById('adminList');
  if (!listEl) return;
  listEl.textContent = '載入中…';
  try {
    const { fsGetShared, fsSetShared, fsGet, fsSet } = await import('./firebase.js');
    const membersMap = await fsGetShared('admin/members') ?? {};
    const pending    = await fsGetShared('admin/pending_upgrades') ?? {};
    const uids = Object.keys(membersMap);

    // 批次讀 profile
    const activated = await Promise.all(uids.map(async uid => {
      const p = await fsGet(uid, 'meta', 'profile');
      return { uid, email: membersMap[uid].email ?? p?.email ?? uid, tier: p?.tier ?? 'free' };
    }));

    // 找出還在 pending（尚未登入）的 email
    const activatedEmails = new Set(activated.map(m => m.email.toLowerCase()));
    const pendingList = Object.entries(pending)
      .filter(([email]) => !activatedEmails.has(email.toLowerCase()));

    const hasData = activated.length > 0 || pendingList.length > 0;
    if (!hasData) {
      listEl.innerHTML = '<div style="color:var(--muted)">尚無會員紀錄</div>';
      return;
    }

    let html = '';

    // 已登入會員
    if (activated.length > 0) {
      html += activated.map(m => `
        <div class="admin-list-row">
          <span class="admin-key-email" title="${m.email}">${m.email}</span>
          <select class="admin-tier-sel auth-key-input" data-uid="${m.uid}" style="width:68px;font-size:11px;padding:2px 4px">
            <option value="free"  ${m.tier==='free'  ? 'selected':''}>Free</option>
            <option value="pro"   ${m.tier==='pro'   ? 'selected':''}>Pro</option>
            <option value="vvvip" ${m.tier==='vvvip' ? 'selected':''}>VVVIP</option>
          </select>
          <button class="admin-delete-btn" data-uid="${m.uid}" data-email="${m.email}">🗑</button>
        </div>`).join('');
    }

    // 待升級（尚未登入）
    if (pendingList.length > 0) {
      html += `<div style="font-size:11px;color:var(--muted);margin:8px 0 4px">待登入升級</div>`;
      html += pendingList.map(([email, info]) => `
        <div class="admin-list-row">
          <span class="admin-key-email" style="color:var(--muted)">${email}</span>
          <span style="font-size:11px;color:var(--muted);flex:1">${info.tier} · 待登入</span>
          <button class="admin-pending-del-btn" data-email="${email}">🗑</button>
        </div>`).join('');
    }

    listEl.innerHTML = html;

    // tier 下拉變更
    listEl.querySelectorAll('.admin-tier-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const uid = sel.dataset.uid; const newTier = sel.value;
        try {
          await fsSet(uid, 'meta', 'profile', { tier: newTier }, true);
          showToast(`✓ 等級已改為 ${newTier}`);
        } catch (err) { showToast(`❌ 變更失敗：${err.message}`); _loadAdminList(); }
      });
    });

    // 已登入降回 free
    listEl.querySelectorAll('.admin-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid; const email = btn.dataset.email;
        if (!confirm(`確定將 ${email} 降回 Free？`)) return;
        try {
          await fsSet(uid, 'meta', 'profile', { tier: 'free', upgradedAt: null }, true);
          showToast(`✓ ${email} 已降回 Free`); _loadAdminList();
        } catch (err) { showToast(`❌ 失敗：${err.message}`); }
      });
    });

    // 刪除待升級
    listEl.querySelectorAll('.admin-pending-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.email;
        if (!confirm(`確定移除待升級 ${email}？`)) return;
        try {
          const p = await fsGetShared('admin/pending_upgrades') ?? {};
          delete p[email];
          await fsSetShared('admin/pending_upgrades', p);
          showToast(`✓ 已移除`); _loadAdminList();
        } catch (err) { showToast(`❌ 失敗：${err.message}`); }
      });
    });

  } catch (err) {
    listEl.textContent = `載入失敗：${err.message}`;
  }
}

// ─── 功能權限面板 ────────────────────────────────────────────────────────

function _renderGatesPanel() {
  const listEl = document.getElementById('adminGatesList');
  if (!listEl) return;

  const currentGates = getFeatureGates();
  const TIER_OPTS = ['guest', 'free', 'pro', 'vvvip'];
  const TIER_NAMES = { guest: '訪客', free: 'Free', pro: 'Pro', vvvip: 'VVVIP' };

  // 依 group 分組
  const groups = {};
  for (const [gateId, meta] of Object.entries(GATE_LABELS)) {
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push({ gateId, label: meta.label });
  }

  listEl.innerHTML = Object.entries(groups).map(([groupName, items]) => `
    <div class="admin-gates-group">
      <div class="admin-gates-group-title">${groupName}</div>
      ${items.map(({ gateId, label }) => {
        const current = currentGates[gateId] ?? DEFAULT_GATES[gateId] ?? 'free';
        const isDefault = current === (DEFAULT_GATES[gateId] ?? 'free');
        return `
          <div class="admin-gates-row">
            <span class="admin-gates-label ${!isDefault ? 'admin-gates-modified' : ''}">${label}</span>
            <select class="admin-gates-select auth-key-input" data-gate-id="${gateId}">
              ${TIER_OPTS.map(t => `
                <option value="${t}" ${t === current ? 'selected' : ''}>${TIER_NAMES[t]}</option>
              `).join('')}
            </select>
            ${!isDefault ? `<button class="admin-gates-reset-one" data-gate-id="${gateId}" title="還原預設">↺</button>` : '<span style="width:20px"></span>'}
          </div>
        `;
      }).join('')}
    </div>
  `).join('');

  // 單項還原預設
  listEl.querySelectorAll('.admin-gates-reset-one').forEach(btn => {
    btn.addEventListener('click', () => {
      const gateId = btn.dataset.gateId;
      const sel    = listEl.querySelector(`[data-gate-id="${gateId}"]`);
      if (sel) sel.value = DEFAULT_GATES[gateId] ?? 'free';
      btn.remove();
      sel?.parentElement?.querySelector('.admin-gates-label')?.classList.remove('admin-gates-modified');
    });
  });

  // 還原全部預設
  document.getElementById('adminGatesResetBtn')?.addEventListener('click', () => {
    if (!confirm('確定還原所有功能權限為預設值？')) return;
    listEl.querySelectorAll('.admin-gates-select').forEach(sel => {
      sel.value = DEFAULT_GATES[sel.dataset.gateId] ?? 'free';
    });
    _renderGatesPanel();
    showToast('已還原預設值（尚未儲存）');
  });

  // 儲存設定（含確認 Modal）
  document.getElementById('adminGatesSaveBtn')?.addEventListener('click', () => {
    _showGatesSaveConfirm(listEl);
  });
}

function _showGatesSaveConfirm(listEl) {
  // 收集目前面板的設定
  const newGates = {};
  listEl.querySelectorAll('.admin-gates-select').forEach(sel => {
    newGates[sel.dataset.gateId] = sel.value;
  });

  // 找出有變更的項目
  const current = getFeatureGates();
  const changed = Object.entries(newGates).filter(([k, v]) => v !== (current[k] ?? DEFAULT_GATES[k]));

  document.getElementById('gatesConfirmOverlay')?.remove();

  const confirmOverlay = document.createElement('div');
  confirmOverlay.id        = 'gatesConfirmOverlay';
  confirmOverlay.className = 'sync-modal-overlay';
  confirmOverlay.style.zIndex = '9999';
  confirmOverlay.innerHTML = `
    <div class="sync-modal" style="max-width:380px">
      <h3>💾 確認儲存功能權限</h3>
      ${changed.length === 0
        ? '<p>沒有變更項目。</p>'
        : `<p>以下 <strong>${changed.length}</strong> 項將變更：</p>
           <div class="admin-gates-diff">
             ${changed.map(([k, v]) => {
               const TIER_NAMES = { guest:'訪客', free:'Free', pro:'Pro', vvvip:'VVVIP' };
               const oldV = current[k] ?? DEFAULT_GATES[k] ?? 'free';
               const label = GATE_LABELS[k]?.label ?? k;
               return `<div class="admin-diff-row">
                 <span class="admin-diff-label">${label}</span>
                 <span class="admin-diff-arrow">${TIER_NAMES[oldV]} → <strong>${TIER_NAMES[v]}</strong></span>
               </div>`;
             }).join('')}
           </div>
           <p style="color:var(--muted);font-size:11px;margin-top:8px">儲存後立即生效，不需重整頁面。</p>`
      }
      <div class="sync-modal-btns" style="flex-direction:row;gap:8px;margin-top:16px">
        <button class="sync-btn-cancel" id="gatesConfirmCancel" style="flex:1">取消</button>
        ${changed.length > 0 ? `<button class="auth-key-submit" id="gatesConfirmOk" style="flex:1">確認儲存</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(confirmOverlay);

  const _closeConfirm = () => confirmOverlay.remove();
  document.getElementById('gatesConfirmCancel')?.addEventListener('click', _closeConfirm);
  confirmOverlay.addEventListener('click', e => { if (e.target === confirmOverlay) _closeConfirm(); });

  document.getElementById('gatesConfirmOk')?.addEventListener('click', async () => {
    try {
      await saveFeatureGates(newGates);
      // 即時重新套用 gate
      const { currentTier } = await import('./auth-tier.js');
      applyTierGate(currentTier);
      showToast('✅ 功能權限已儲存並即時生效');
      _closeConfirm();
      // 重新渲染 gates 面板（顯示最新狀態）
      _renderGatesPanel();
    } catch (err) {
      showToast(`❌ 儲存失敗：${err.message}`);
    }
  });
}
