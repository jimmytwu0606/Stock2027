/**
 * mobile-screener-strat.js
 * 策略篩選：結果渲染 + 設定掃描 + 執行掃描
 *
 * 修正：
 * - 直接 import STRATEGIES（不靠 window.__STRATEGIES）
 * - runScan evt.payload（非 evt.item）
 * - runScan 存入 AppState.screener.results
 * - _updateCnt / _resultCardHTML / _bindResultCards / _emptyHTML 補定義
 */

import { STRATEGIES } from '../strategy.js';
import { saveResult, loadAllResults } from '../screener-result-store.js';
import { watchAddCode, createList as pfCreateList } from '../portfolio.js';

const _GRP_ICONS = {
  '強勢續漲':'📈','超跌反彈':'🔄','轉折訊號':'⚡',
  '葛蘭碧':'📐','盤整突破':'📦','基本面':'📋',
  '巴菲特':'💎','技術指標':'🔬','K線型態':'🕯️','避險警示':'⚠️','X系列':'🚀',
};
let _selectedStrats = new Set();

export function renderResult(body, deps) {
  const { AppState } = deps;
  const results = AppState?.screener?.results || [];

  if (!results.length) {
    body.innerHTML = _emptyHTML('⚡', '尚無策略結果', '點「設定掃描」選擇策略後執行掃描');
    _appendSavedList(body, deps);
    return;
  }

  const stratName = AppState?.screener?.lastStrategy || '策略篩選';
  body.innerHTML = `
    <div class="m-last-scan" style="display:flex;align-items:center;justify-content:space-between;">
      <span>${stratName} <span style="color:#58a6ff">${results.length} 檔</span></span>
      <button id="mStratSaveBtn" style="
        padding:4px 12px;border-radius:8px;border:0.5px solid rgba(88,166,255,0.4);
        background:rgba(88,166,255,0.1);color:#58a6ff;font-size:12px;cursor:pointer;
        white-space:nowrap;flex-shrink:0;
      ">💾 儲存</button>
    </div>
    <div class="m-result-list">
      ${results.slice(0, 50).map(r => _resultCardHTML(r, {
        tags: (r.matchedConds || []).slice(0, 2),
        tagClass: 'blue',
      })).join('')}
    </div>`;

  body.querySelectorAll('.m-rc').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.m-rc-add-btn')) return;
      (window.__mobileOpenPreview||window.__loadStock)?.(results[i]?.code || el.dataset.code);
    });
  });

  body.querySelectorAll('.m-rc-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openAddWlPopover(btn, btn.dataset.code, btn.dataset.name);
    });
  });

  body.querySelector('#mStratSaveBtn')?.addEventListener('click', () => {
    _showSaveDialog(stratName, results, deps);
  });

  _appendSavedList(body, deps);
}

// ── 儲存命名彈窗 ─────────────────────────────────────────────────────────────
function _showSaveDialog(defaultName, results, deps) {
  document.getElementById('mStratSaveDialog')?.remove();

  const dlg = document.createElement('div');
  dlg.id = 'mStratSaveDialog';
  dlg.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:20000;display:flex;align-items:center;justify-content:center;padding:20px;';
  dlg.innerHTML = `
    <div style="background:#161b22;border:0.5px solid #30363d;border-radius:14px;padding:20px;width:100%;max-width:340px;">
      <div style="font-size:16px;font-weight:600;color:#e6edf3;margin-bottom:14px">儲存篩選結果</div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:6px">清單名稱</div>
      <input id="mStratSaveName" type="text" value="${defaultName}"
        style="width:100%;padding:10px 12px;background:#0d1117;border:0.5px solid #30363d;border-radius:9px;color:#e6edf3;font-size:14px;box-sizing:border-box;margin-bottom:16px"
      />
      <div style="display:flex;gap:10px">
        <button id="mStratSaveCancel" style="flex:1;padding:10px;border-radius:9px;border:0.5px solid #30363d;background:transparent;color:#8b949e;font-size:14px;cursor:pointer;">取消</button>
        <button id="mStratSaveConfirm" style="flex:1;padding:10px;border-radius:9px;border:none;background:#58a6ff;color:#0d1117;font-size:14px;font-weight:600;cursor:pointer;">儲存</button>
      </div>
      <div id="mStratSaveMsg" style="font-size:12px;color:#f85149;margin-top:10px;display:none"></div>
    </div>
  `;
  document.body.appendChild(dlg);

  dlg.querySelector('#mStratSaveCancel').addEventListener('click', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });

  dlg.querySelector('#mStratSaveConfirm').addEventListener('click', async () => {
    const name = dlg.querySelector('#mStratSaveName').value.trim();
    const msg  = dlg.querySelector('#mStratSaveMsg');
    if (!name) { msg.textContent = '請輸入清單名稱'; msg.style.display=''; return; }
    try {
      await saveResult(name, results, { strategy: name, condLabels: [name] });
      dlg.remove();
      deps.showToast?.(`已儲存「${name}」（${results.length} 檔）`);
    } catch(e) {
      msg.textContent = e.message;
      msg.style.display = '';
    }
  });

  setTimeout(() => {
    const inp = dlg.querySelector('#mStratSaveName');
    inp?.focus(); inp?.select();
  }, 100);
}

// ── 歷史清單（摺疊區）────────────────────────────────────────────────────────
function _appendSavedList(body, deps) {
  const wrap = document.createElement('div');
  wrap.id = 'mStratSavedWrap';
  wrap.style.cssText = 'border-top:0.5px solid #21262d;margin-top:8px;padding:4px 0;';
  wrap.innerHTML = `
    <div id="mStratSavedHd" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;user-select:none;">
      <span style="font-size:13px;font-weight:600;color:#8b949e">📂 已儲存清單</span>
      <span id="mStratSavedArrow" style="font-size:12px;color:#3d444d">⌄</span>
    </div>
    <div id="mStratSavedBody" style="display:none;padding:0 10px 8px"></div>
  `;
  body.appendChild(wrap);

  const hd    = wrap.querySelector('#mStratSavedHd');
  const bd    = wrap.querySelector('#mStratSavedBody');
  const arrow = wrap.querySelector('#mStratSavedArrow');
  let loaded  = false;

  hd.addEventListener('click', async () => {
    const open = bd.style.display !== 'none';
    bd.style.display = open ? 'none' : '';
    arrow.style.transform = open ? '' : 'rotate(180deg)';
    if (!open && !loaded) {
      loaded = true;
      bd.innerHTML = '<div style="font-size:12px;color:#3d444d;padding:8px 4px">載入中…</div>';
      try {
        const all = await loadAllResults();
        if (!all.length) {
          bd.innerHTML = '<div style="font-size:12px;color:#3d444d;padding:8px 4px">尚無儲存清單</div>';
          return;
        }
        bd.innerHTML = all.map(r => `
          <div class="m-saved-row" data-id="${r.id}" style="display:flex;align-items:center;justify-content:space-between;padding:9px 6px;border-bottom:0.5px solid #21262d;cursor:pointer;">
            <div>
              <div style="font-size:13px;color:#e6edf3">${r.name}</div>
              <div style="font-size:11px;color:#3d444d">${r.results?.length ?? 0} 檔 · ${_fmtDate(r.savedAt)}</div>
            </div>
            <button class="m-saved-del" data-id="${r.id}" style="padding:4px 8px;border-radius:7px;border:0.5px solid #f85149;background:transparent;color:#f85149;font-size:11px;cursor:pointer;">刪除</button>
          </div>`).join('');

        bd.querySelectorAll('.m-saved-row').forEach(row => {
          row.addEventListener('click', e => {
            if (e.target.closest('.m-saved-del')) return;
            const rec = all.find(r => r.id === row.dataset.id);
            if (!rec) return;
            if (deps.AppState?.screener) {
              deps.AppState.screener.results        = rec.results ?? [];
              deps.AppState.screener.lastStrategy   = rec.name;
            }
            deps.onDone?.('strat');
          });
        });

        bd.querySelectorAll('.m-saved-del').forEach(btn => {
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            const { deleteResult } = await import('../screener-result-store.js');
            await deleteResult(btn.dataset.id);
            loaded = false;
            btn.closest('.m-saved-row').remove();
            if (!bd.querySelector('.m-saved-row'))
              bd.innerHTML = '<div style="font-size:12px;color:#3d444d;padding:8px 4px">尚無儲存清單</div>';
            deps.showToast?.('已刪除');
          });
        });
      } catch(e) {
        bd.innerHTML = `<div style="font-size:12px;color:#f85149;padding:8px 4px">${e.message}</div>`;
      }
    }
  });
}

function _fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth()+1}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export function renderSetup(body, deps) {
  const groups = new Map();
  STRATEGIES.forEach(s => {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  });
  const tier = window.__userTier || 'free';

  body.innerHTML = `
    <div class="mss-summary" id="mssSummary">
      <span class="mss-label">已選：</span>
      ${_selectedStrats.size
        ? `<span class="mss-pills">${[..._selectedStrats].map(n => `<span class="mss-pill">${n}</span>`).join('')}</span><button class="mss-clear" id="mssClear">清除</button>`
        : '<span class="mss-none">尚未選取</span>'}
    </div>
    <div id="mssGroups"></div>
    <div class="m-s-section" style="padding-top:10px">
      <div class="m-s-label">股價範圍</div>
      <div class="m-phase-a-row">
        <div class="m-phase-a-col">
          <div class="m-phase-a-field-label">最低（元）</div>
          <input class="m-phase-a-field" id="mPhaseAMin" type="number" value="10" inputmode="numeric">
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:8px;color:#3d444d">—</div>
        <div class="m-phase-a-col">
          <div class="m-phase-a-field-label">最高（元）</div>
          <input class="m-phase-a-field" id="mPhaseAMax" type="number" value="9999" inputmode="numeric">
        </div>
        <div class="m-phase-a-col">
          <div class="m-phase-a-field-label">成交量≥（張）</div>
          <input class="m-phase-a-field" id="mPhaseAVol" type="number" value="0" inputmode="numeric">
        </div>
      </div>
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mStratRunBtn">開始掃描全市場 →</button>
    </div>`;

  const grpWrap = body.querySelector('#mssGroups');
  groups.forEach((strats, category) => {
    const selInGroup = strats.filter(s => _selectedStrats.has(s.name)).length;
    const icon = _GRP_ICONS[category] || '📌';
    const grpEl = document.createElement('div');
    grpEl.className = 'mss-grp';
    grpEl.innerHTML = `
      <div class="mss-grp-hd">
        <div class="mss-grp-left">
          <span class="mss-grp-icon">${icon}</span>
          <span class="mss-grp-name">${category}</span>
          <span class="mss-grp-cnt ${selInGroup ? 'has-sel' : ''}">${selInGroup ? selInGroup + ' 選' : strats.length + ' 項'}</span>
        </div>
        <span class="mss-grp-arrow">⌄</span>
      </div>
      <div class="mss-grp-body mss-collapsed">
        ${strats.map(s => {
          const locked = s.tier === 'pro' && tier === 'free';
          const checked = _selectedStrats.has(s.name);
          return `<div class="mss-row ${checked ? 'selected' : ''} ${locked ? 'locked' : ''}" data-name="${s.name}">
            <div class="mss-dot ${checked ? 'checked' : ''}"></div>
            <div class="mss-info">
              <div class="mss-sname">${s.icon || ''} ${s.name}</div>
              <div class="mss-sdesc">${s.desc || ''}</div>
            </div>
            ${locked ? '<span class="mss-pro-badge">Pro</span>' : ''}
          </div>`;
        }).join('')}
      </div>`;

    grpEl.querySelector('.mss-grp-hd').addEventListener('click', () => {
      const b = grpEl.querySelector('.mss-grp-body');
      const a = grpEl.querySelector('.mss-grp-arrow');
      b.classList.toggle('mss-collapsed');
      a.style.transform = b.classList.contains('mss-collapsed') ? '' : 'rotate(180deg)';
    });
    grpEl.querySelectorAll('.mss-row:not(.locked)').forEach(row => {
      row.addEventListener('click', () => {
        const name = row.dataset.name;
        if (_selectedStrats.has(name)) _selectedStrats.delete(name);
        else _selectedStrats.add(name);
        renderSetup(body, deps);
      });
    });
    grpWrap.appendChild(grpEl);
  });

  body.querySelector('#mssClear')?.addEventListener('click', () => {
    _selectedStrats.clear();
    renderSetup(body, deps);
  });

  body.querySelector('#mStratRunBtn')?.addEventListener('click', async () => {
    if (!_selectedStrats.size) { deps.showToast?.('請至少選擇一個策略'); return; }
    // 掃描前清空舊結果
    const as = deps.AppState;
    if (as?.screener) as.screener.results = [];
    deps.onClose?.();
    await runScan({
      priceMin:   Number(body.querySelector('#mPhaseAMin')?.value || 10),
      priceMax:   Number(body.querySelector('#mPhaseAMax')?.value || 9999),
      volumeMin:  Number(body.querySelector('#mPhaseAVol')?.value || 0),
      strategies: [..._selectedStrats],
    }, deps);
  });
}

export async function runScan(opts, deps) {
  const { showScanOverlay, hideScanOverlay, updateProgress, onResult, onDone, AppState } = deps;
  showScanOverlay?.('策略掃描中…');

  // 清空舊結果
  if (AppState?.screener) AppState.screener.results = [];

  try {
    // ⚠️ 關鍵：等桌機版的 __twsePricesReady（同 screener-ui.js 的做法）
    // __priceCache 有資料時，runScreener Phase A 直接用快取，不打 TWSE
    // 沒等這個的話 __priceCache 可能是空的，Phase A 要重新打 TWSE + Phase B 打 Worker
    if (window.__twsePricesReady) {
      updateProgress?.(0, 0, '等待市場資料…');
      try { await window.__twsePricesReady; } catch(_) {}
    }

    const { runScreener, CONDITION_DEFS } = await import('../screener.js');

    // 把策略名稱 → strategy 物件 → conditions（{ condId, value }）→ { def, value }
    const conditions = [];
    const seen = new Set();
    for (const stratName of opts.strategies) {
      const strat = STRATEGIES.find(s => s.name === stratName);
      if (!strat) continue;
      for (const c of (strat.conditions || [])) {
        if (seen.has(c.condId)) continue;
        seen.add(c.condId);
        const def = CONDITION_DEFS.find(d => d.id === c.condId);
        if (def) conditions.push({ id: c.condId, def, value: c.value ?? def.default });
      }
    }
    // 加入股價/量能過濾
    const priceMinDef = CONDITION_DEFS.find(d => d.id === 'price_min');
    const priceMaxDef = CONDITION_DEFS.find(d => d.id === 'price_max');
    const volDef      = CONDITION_DEFS.find(d => d.id === 'vol_min');
    if (opts.priceMin > 0     && priceMinDef && !seen.has('price_min')) conditions.push({ id:'price_min', def:priceMinDef, value:opts.priceMin });
    if (opts.priceMax < 99999 && priceMaxDef && !seen.has('price_max')) conditions.push({ id:'price_max', def:priceMaxDef, value:opts.priceMax });
    if (opts.volumeMin > 0    && volDef      && !seen.has('vol_min'))   conditions.push({ id:'vol_min',   def:volDef,      value:opts.volumeMin });

    if (!conditions.length) { deps.showToast?.('策略條件轉換失敗'); return; }

    const gen = runScreener(conditions);

    // Phase B 進度透過 CustomEvent 發出，監聽後更新 overlay
    let _phase1Passed = 0;
    const _onPhase2Progress = (e) => {
      const { done, total } = e.detail ?? {};
      updateProgress?.(done ?? 0, total ?? _phase1Passed, `技術指標 ${done} / ${total ?? _phase1Passed} 檔…`);
    };
    document.addEventListener('screenerPhase2Progress', _onPhase2Progress);

    try {
      for await (const evt of gen) {
        if (evt.type === 'status')      updateProgress?.(0, 0, evt.payload?.message ?? '');
        if (evt.type === 'progress')    updateProgress?.(evt.payload?.done ?? 0, evt.payload?.total ?? 0, evt.payload?.message ?? '掃描中…');
        if (evt.type === 'phase1_done') {
          _phase1Passed = evt.payload?.passed ?? 0;
          updateProgress?.(0, _phase1Passed, `Phase 1 通過 ${_phase1Passed} 檔，計算技術指標…`);
        }
        if (evt.type === 'warning')     deps.showToast?.(evt.payload?.message ?? '');
        if (evt.type === 'error')       { deps.showToast?.('⚠ ' + (evt.payload?.message ?? '')); break; }
        if (evt.type === 'result') {
          const item = evt.payload;
          if (item) onResult?.(item);
        }
        if (evt.type === 'done') break;
      }
    } finally {
      document.removeEventListener('screenerPhase2Progress', _onPhase2Progress);
    }

    if (AppState?.screener) AppState.screener.lastStrategy = opts.strategies.join('＋');

    // 存入 IDB + Firebase（同桌機版 screener-result-store.js）
    const results = AppState?.screener?.results ?? [];
    if (results.length > 0) {
      const stratName = opts.strategies.join('＋');
      saveResult(stratName, results, {
        strategy:   stratName,
        condLabels: opts.strategies,
      }).catch(e => console.warn('[mobile-screener] saveResult failed:', e.message));
    }

    onDone?.('strat');
  } catch(e) {
    deps.showToast?.('掃描失敗：' + e.message);
  } finally {
    hideScanOverlay?.();
  }
}

// ── 工具函式 ─────────────────────────────────────────────────
function _resultCardHTML(r, opts = {}) {
  const up  = (r.chgPct ?? 0) >= 0;
  const clr = up ? '#ef5350' : '#26a69a';
  return `<div class="m-rc" data-code="${r.code}">
    <div class="m-rc-info">
      <div class="m-rc-name">${r.name || r.code}</div>
      <div class="m-rc-code">${r.code}</div>
      <div class="m-rc-badge">
        ${(opts.tags || []).map(t => `<span class="m-rc-tag ${opts.tagClass || ''}">${t}</span>`).join('')}
      </div>
    </div>
    <div class="m-rc-r">
      <div class="m-rc-price" style="color:${clr}">${r.price ? Number(r.price).toFixed(2) : '—'}</div>
      ${r.chgPct != null ? `<div class="m-rc-pct ${up ? 'm-up-bg' : 'm-dn-bg'}">${up ? '+' : ''}${Number(r.chgPct).toFixed(2)}%</div>` : ''}
      <button class="m-rc-add-btn" data-code="${r.code}" data-name="${_escAttr(r.name ?? r.code)}" title="加入追蹤清單"
        style="margin-top:4px;width:26px;height:26px;border-radius:7px;border:0.5px solid rgba(88,166,255,0.35);background:rgba(88,166,255,0.08);color:#58a6ff;font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;">＋</button>
    </div>
  </div>`;
}

function _escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 「＋追蹤清單」popover ─────────────────────────────────────────────────
function _openAddWlPopover(anchor, code, name) {
  document.getElementById('mStratAddPop')?.remove();

  const api    = window.__portfolioAPI;
  const lists  = api ? api.getWatchLists() : [];
  const px     = window.__priceCache?.[code]?.price ?? 0;

  const pop = document.createElement('div');
  pop.id = 'mStratAddPop';
  pop.style.cssText = [
    'position:fixed;z-index:30000;min-width:180px;max-width:260px',
    'background:#161b22;border:0.5px solid #30363d;border-radius:12px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden',
  ].join(';');

  const rows = lists.map(l => {
    const already = l.items?.some(it => it.code === code);
    return `<div class="mStratAddRow" data-id="${l.id}" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:${already?'default':'pointer'};opacity:${already?'0.45':'1'}">
      <span style="font-size:13px;color:#e6edf3">${l.name}</span>
      ${already ? '<span style="font-size:11px;color:#3d444d">✓</span>' : ''}
    </div>`;
  }).join('<div style="height:0.5px;background:#21262d;margin:0 10px"></div>');

  pop.innerHTML = `
    <div style="padding:10px 14px 8px;font-size:11px;color:#8b949e;border-bottom:0.5px solid #21262d">加入追蹤清單</div>
    ${rows || '<div style="padding:10px 14px;font-size:12px;color:#3d444d">尚無追蹤清單</div>'}
    <div style="height:0.5px;background:#21262d"></div>
    <div id="mStratAddNew" style="padding:10px 14px;font-size:13px;color:#58a6ff;cursor:pointer">＋ 新建追蹤清單</div>`;

  document.body.appendChild(pop);

  // 定位
  const rect = anchor.getBoundingClientRect();
  const top  = rect.bottom + 6;
  const left = Math.min(rect.right - 180, window.innerWidth - 270);
  pop.style.top  = `${Math.max(top, 10)}px`;
  pop.style.left = `${Math.max(left, 8)}px`;

  // 點清單加入
  pop.querySelectorAll('.mStratAddRow').forEach(row => {
    const listId = row.dataset.id;
    const already = lists.find(l => l.id === listId)?.items?.some(it => it.code === code);
    if (already) return;
    row.addEventListener('click', async () => {
      try {
        await watchAddCode(listId, code, name, px, '');
        pop.remove();
        _showMiniToast(`已加入「${lists.find(l=>l.id===listId)?.name}」`);
      } catch(e) {
        _showMiniToast('加入失敗：' + e.message);
      }
    });
  });

  // 新建清單
  pop.querySelector('#mStratAddNew')?.addEventListener('click', () => {
    pop.remove();
    _openNewListDialog(code, name, px);
  });

  // 點外部關閉
  const _outside = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      document.removeEventListener('pointerdown', _outside, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', _outside, true), 0);
}

function _openNewListDialog(code, name, px) {
  document.getElementById('mStratNewListDlg')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'mStratNewListDlg';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:30001;display:flex;align-items:center;justify-content:center;padding:20px;';
  dlg.innerHTML = `
    <div style="background:#161b22;border:0.5px solid #30363d;border-radius:14px;padding:20px;width:100%;max-width:320px;">
      <div style="font-size:15px;font-weight:600;color:#e6edf3;margin-bottom:14px">新建追蹤清單</div>
      <input id="mStratNewListName" type="text" placeholder="清單名稱"
        style="width:100%;padding:9px 12px;background:#0d1117;border:0.5px solid #30363d;border-radius:9px;color:#e6edf3;font-size:14px;box-sizing:border-box;margin-bottom:14px">
      <div style="display:flex;gap:10px">
        <button id="mStratNewListCancel" style="flex:1;padding:9px;border-radius:9px;border:0.5px solid #30363d;background:transparent;color:#8b949e;font-size:14px;cursor:pointer">取消</button>
        <button id="mStratNewListConfirm" style="flex:1;padding:9px;border-radius:9px;border:none;background:#58a6ff;color:#0d1117;font-size:14px;font-weight:600;cursor:pointer">建立並加入</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  dlg.querySelector('#mStratNewListCancel').addEventListener('click', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
  dlg.querySelector('#mStratNewListConfirm').addEventListener('click', async () => {
    const n = dlg.querySelector('#mStratNewListName').value.trim();
    if (!n) return;
    try {
      const list = await pfCreateList('watch', n);
      await watchAddCode(list.id, code, name, px, '');
      dlg.remove();
      _showMiniToast(`已建立「${n}」並加入`);
    } catch(e) {
      _showMiniToast('失敗：' + e.message);
    }
  });
  setTimeout(() => dlg.querySelector('#mStratNewListName')?.focus(), 100);
}

function _showMiniToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#21262d;color:#e6edf3;font-size:13px;padding:8px 16px;border-radius:20px;z-index:40000;pointer-events:none;white-space:nowrap;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function _emptyHTML(icon, title, desc) {
  return `<div class="m-empty">
    <div class="m-empty-icon">${icon}</div>
    <div class="m-empty-title">${title}</div>
    <div class="m-empty-desc">${desc}</div>
  </div>`;
}
