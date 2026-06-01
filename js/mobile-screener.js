/**
 * mobile-screener.js — Phase 10 手機版選股 UI
 *
 * 架構：
 *   兩層：
 *     Layer 1（結果瀏覽）— 五個 seg tab，直接呼叫各資料層取結果
 *     Layer 2（設定掃描）— 全螢幕覆蓋，設定後呼叫現有掃描 AsyncGenerator
 *
 * 直接呼叫（不重寫邏輯）：
 *   題材  → theme.js    getThemes()
 *   策略  → screener.js runScreener() / AppState.screener.results
 *   追蹤  → portfolio.js listAll('watch')
 *   型態  → pattern-scan.js runPatternScan()
 *   種子  → seed-scan.js runSeedScan()
 *
 * 依賴注入（main.js 呼叫 initMobileScreener(deps) 傳入）：
 *   { AppState, showToast, getChineseName, fetchTWSEPrices }
 */

let _deps = {};
let _currentMode = 'theme';   // 目前選股子模式
let _filterOpen  = false;
let _scanAbort   = null;       // AbortController for 掃描取消

// ─── 初始化 ───────────────────────────────────────────────
export function initMobileScreener(deps) {
  _deps = deps;
  _buildDOM();
  _bindSegTabs();
  _bindSetupBtn();
  _bindSheetClose();
  _renderCurrentMode();
}

// ─── DOM 骨架注入 tabScreener ────────────────────────────
function _buildDOM() {
  const panel = document.getElementById('tabScreener');
  if (!panel) return;

  panel.innerHTML = `
    <!-- Layer 1: 結果瀏覽 -->
    <div id="mScrMain">
      <div class="m-scr-header">
        <div class="m-scr-title">選股</div>
        <button class="m-setup-btn active" id="mSetupBtn">⚙ 設定掃描</button>
      </div>

      <div class="m-seg-wrap">
        <div class="m-seg-scroll" id="mSegScroll">
          <div class="m-seg-tab active" data-mode="theme">🏷 題材<span class="m-seg-cnt" id="mCnt-theme">0</span></div>
          <div class="m-seg-tab"        data-mode="strat">⚡ 策略<span class="m-seg-cnt" id="mCnt-strat">0</span></div>
          <div class="m-seg-tab"        data-mode="track">📋 追蹤<span class="m-seg-cnt" id="mCnt-track">0</span></div>
          <div class="m-seg-tab"        data-mode="pattern">〰 型態<span class="m-seg-cnt" id="mCnt-pattern">0</span></div>
          <div class="m-seg-tab"        data-mode="seed">🌱 種子<span class="m-seg-cnt" id="mCnt-seed">0</span></div>
        </div>
        <div class="m-seg-line"></div>
      </div>

      <div class="m-result-body" id="mResultBody">
        <!-- 動態渲染 -->
      </div>
    </div>

    <!-- Layer 2: 設定掃描（全螢幕滑入） -->
    <div class="m-setup-screen" id="mSetupScreen">
      <div class="m-setup-nav">
        <button class="m-setup-back" id="mSetupBack">← 選股</button>
        <div class="m-setup-nav-title">設定掃描</div>
        <div style="width:60px"></div>
      </div>
      <div class="m-setup-tabs" id="mSetupTabs">
        <button class="m-stab active" data-stab="strat">策略</button>
        <button class="m-stab"        data-stab="pattern">型態</button>
        <button class="m-stab"        data-stab="seed">種子</button>
        <button class="m-stab"        data-stab="track">追蹤</button>
        <button class="m-stab"        data-stab="theme">題材</button>
      </div>
      <div class="m-setup-body" id="mSetupBody">
        <!-- 動態渲染 -->
      </div>
    </div>

    <!-- 掃描進度覆蓋 -->
    <div class="m-scan-overlay" id="mScanOverlay">
      <div class="m-scan-spinner"></div>
      <div class="m-scan-title" id="mScanTitle">掃描中…</div>
      <div class="m-scan-sub"   id="mScanSub">初始化中</div>
      <div class="m-scan-prog-wrap">
        <div class="m-scan-prog-fill" id="mScanProg"></div>
      </div>
      <div class="m-scan-count" id="mScanCount"></div>
      <button class="m-scan-abort" id="mScanAbort">取消掃描</button>
    </div>

    <!-- Bottom Sheet: 個股清單 -->
    <div class="m-sheet-ov" id="mSheetOv">
      <div class="m-bsheet">
        <div class="m-sh-handle"></div>
        <div class="m-sh-hd">
          <div class="m-sh-title-row">
            <div class="m-sh-icon" id="mShIcon"></div>
            <div>
              <div class="m-sh-title" id="mShTitle"></div>
              <div class="m-sh-sub"   id="mShSub"></div>
            </div>
          </div>
          <button class="m-sh-close" id="mShClose">✕</button>
        </div>
        <div class="m-sh-filter-hd" id="mShFilterHd">
          <div class="m-sh-filter-left">
            ▼ 篩選條件
            <div class="m-sh-active-tags" id="mShActiveTags"></div>
          </div>
          <span class="m-sh-filter-arr" id="mShFilterArr">⌄</span>
        </div>
        <div class="m-sh-filter-body" id="mShFilterBody">
          <div class="m-sh-filter-inner" id="mShFilterInner"></div>
        </div>
        <div class="m-sh-sort" id="mShSort"></div>
        <div class="m-sh-body">
          <div class="m-sh-stocks" id="mShStocks"></div>
        </div>
      </div>
    </div>
  `;

  // 綁定掃描取消
  document.getElementById('mScanAbort')?.addEventListener('click', _abortScan);
  // 綁定 sheet 關閉
  document.getElementById('mSheetOv')?.addEventListener('click', e => {
    if (e.target === document.getElementById('mSheetOv')) _closeSheet();
  });
  document.getElementById('mShClose')?.addEventListener('click', _closeSheet);
  // 篩選收合
  document.getElementById('mShFilterHd')?.addEventListener('click', _toggleSheetFilter);
  // setup tabs
  document.getElementById('mSetupTabs')?.querySelectorAll('.m-stab').forEach(btn => {
    btn.addEventListener('click', () => _switchSetupTab(btn.dataset.stab));
  });
  // setup back
  document.getElementById('mSetupBack')?.addEventListener('click', _closeSetup);
}

// ─── Seg Tab 切換 ────────────────────────────────────────
function _bindSegTabs() {
  document.getElementById('mSegScroll')?.querySelectorAll('.m-seg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#mSegScroll .m-seg-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _currentMode = tab.dataset.mode;
      tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      _renderCurrentMode();
    });
  });
}

// ─── 設定掃描按鈕 ────────────────────────────────────────
function _bindSetupBtn() {
  document.getElementById('mSetupBtn')?.addEventListener('click', _openSetup);
}

// ─── Sheet 關閉 ──────────────────────────────────────────
function _bindSheetClose() {
  // 已在 _buildDOM 綁定
}

// ══════════════════════════════════════════════════════════
// Layer 1：結果渲染
// ══════════════════════════════════════════════════════════

async function _renderCurrentMode() {
  const body = document.getElementById('mResultBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:20px 16px;color:#3d444d;font-size:13px;text-align:center">載入中…</div>';

  try {
    switch (_currentMode) {
      case 'theme':   await _renderTheme(body);   break;
      case 'strat':   _renderStrat(body);          break;
      case 'track':   await _renderTrack(body);   break;
      case 'pattern': _renderPattern(body);        break;
      case 'seed':    _renderSeed(body);           break;
    }
  } catch (e) {
    body.innerHTML = `<div class="m-empty"><div class="m-empty-icon">⚠️</div><div class="m-empty-title">載入失敗</div><div class="m-empty-desc">${e.message}</div></div>`;
  }
}

// ── 題材 ──────────────────────────────────────────────────
async function _renderTheme(body) {
  const { getThemes } = await import('./theme.js');
  const themes = getThemes();
  _updateCnt('theme', themes.length);

  if (!themes.length) {
    body.innerHTML = _emptyHTML('🏷️', '尚無題材', '請至「設定掃描 → 題材」新增題材');
    return;
  }

  const html = `
    <div class="m-last-scan">題材清單 <span>${themes.length} 個</span></div>
    <div class="m-theme-grid">
      ${themes.map((t, i) => `
        <div class="m-tc" data-theme-idx="${i}">
          <div class="m-tc-top">
            <div class="m-tc-emoji">${t.emoji || '🏷️'}</div>
            <div class="m-tc-cnt">${(t.stocks || []).length}檔</div>
          </div>
          <div class="m-tc-name">${_esc(t.name)}</div>
          <div class="m-tc-desc">${_esc(t.desc || '')}</div>
          <div class="m-tc-tags">
            ${(t.stocks || []).slice(0, 3).map(s =>
              `<div class="m-tc-tag">${s.code}</div>`
            ).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
  body.innerHTML = html;

  // 點擊題材 → 開 sheet
  body.querySelectorAll('.m-tc').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.themeIdx);
      const t = themes[idx];
      _openSheet({
        icon: t.emoji || '🏷️',
        title: t.name,
        sub: `${(t.stocks || []).length}檔`,
        mode: 'theme',
        activeTags: [],
        filterRows: [],
        sort: ['漲幅↓', '跌幅↑', '成交量'],
        stocks: (t.stocks || []).map(s => ({
          name: _deps.getChineseName?.(s.code) || s.name || s.code,
          code: s.code,
          price: null, pct: null, up: null,
        })),
      });
    });
  });
}

// ── 策略 ──────────────────────────────────────────────────
function _renderStrat(body) {
  const { AppState } = _deps;
  const results = AppState?.screener?.results || [];
  _updateCnt('strat', results.length);

  if (!results.length) {
    body.innerHTML = _emptyHTML('⚡', '尚無策略結果', '點「設定掃描」選擇策略後執行掃描', true);
    return;
  }

  const html = `
    <div class="m-last-scan">
      ${AppState.screener.lastStrategy || '策略篩選'}
      <span>${results.length} 檔</span>
    </div>
    <div class="m-result-list">
      ${results.slice(0, 50).map(r => _resultCardHTML(r, {
        tags: (r.matchedConds || []).slice(0, 2),
        tagClass: 'blue',
      })).join('')}
    </div>
  `;
  body.innerHTML = html;
  _bindResultCards(body, results, { icon: '⚡', title: '策略結果', mode: 'strat' });
}

// ── 追蹤 ──────────────────────────────────────────────────
async function _renderTrack(body) {
  const { listAll } = await import('./portfolio.js');
  const lists = listAll('watch');
  const total = lists.reduce((n, l) => n + (l.items || []).length, 0);
  _updateCnt('track', total);

  if (!lists.length) {
    body.innerHTML = _emptyHTML('📋', '尚無追蹤清單', '點「設定掃描 → 追蹤」新增清單');
    return;
  }

  const html = `
    <div class="m-last-scan">追蹤清單 <span>${lists.length} 個 · ${total} 檔</span></div>
    <div class="m-strat-list">
      ${lists.map(l => `
        <div class="m-strat-card" data-list-id="${l.id}">
          <div class="m-strat-icon" style="background:rgba(88,166,255,0.1);font-size:22px">
            ${l.emoji || '📋'}
          </div>
          <div class="m-strat-info">
            <div class="m-strat-name">${_esc(l.name)}</div>
            <div class="m-strat-desc">${(l.items || []).length} 檔追蹤中</div>
          </div>
          <div class="m-strat-r">
            <div class="m-strat-cnt">${(l.items || []).length}</div>
            <span style="font-size:14px;color:#3d444d">›</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  body.innerHTML = html;

  body.querySelectorAll('.m-strat-card').forEach(el => {
    el.addEventListener('click', () => {
      const list = lists.find(l => l.id === el.dataset.listId);
      if (!list) return;
      _openSheet({
        icon: list.emoji || '📋',
        title: list.name,
        sub: `${(list.items || []).length}檔`,
        mode: 'track',
        activeTags: [],
        filterRows: [],
        sort: ['預設', '漲幅↓', '距參考價'],
        stocks: (list.items || []).map(s => ({
          name: _deps.getChineseName?.(s.code) || s.name || s.code,
          code: s.code,
          price: null, pct: null, up: null,
          score: s.refPrice ? `參考 ${s.refPrice}` : '',
        })),
      });
    });
  });
}

// ── 型態 ──────────────────────────────────────────────────
function _renderPattern(body) {
  const { AppState } = _deps;
  const results = AppState?.pattern?.scanResults || [];
  _updateCnt('pattern', results.length);

  if (!results.length) {
    body.innerHTML = _emptyHTML('〰', '尚無型態結果', '點「設定掃描 → 型態」手繪走勢後執行掃描', true);
    return;
  }

  const html = `
    <div class="m-last-scan">
      相似度 ≥ ${AppState.pattern.similarity || 75}%
      <span>${results.length} 檔</span>
    </div>
    <div class="m-result-list">
      ${results.slice(0, 50).map(r => _resultCardHTML({
        code: r.code,
        name: r.name,
        price: null,
        chgPct: null,
      }, {
        tags: [`相似 ${r.score}%`],
        tagClass: 'blue',
        score: `${r.score}%`,
      })).join('')}
    </div>
  `;
  body.innerHTML = html;
  _bindResultCards(body, results.map(r => ({
    code: r.code, name: r.name, price: null, chgPct: null,
    score: `${r.score}%`,
  })), { icon: '〰', title: '型態比對', mode: 'pattern' });
}

// ── 種子 ──────────────────────────────────────────────────
function _renderSeed(body) {
  const { AppState } = _deps;
  const results = AppState?.seed?.scanResults || [];
  _updateCnt('seed', results.length);

  if (!results.length) {
    body.innerHTML = _emptyHTML('🌱', '尚無種子結果', '點「設定掃描 → 種子」輸入種子股後執行掃描', true);
    return;
  }

  const html = `
    <div class="m-last-scan">
      門檻 ${AppState.seed.threshold || 60}分
      <span>${results.length} 檔</span>
    </div>
    <div class="m-result-list">
      ${results.slice(0, 50).map(r => _resultCardHTML({
        code: r.code,
        name: r.name,
        price: r.price,
        chgPct: r.chgPct,
      }, {
        tags: [`綜合 ${r.compositeScore}分`],
        tagClass: 'blue',
        score: `線型${r.patternScore} 指標${r.indicatorScore}`,
      })).join('')}
    </div>
  `;
  body.innerHTML = html;
  _bindResultCards(body, results.map(r => ({
    code: r.code, name: r.name,
    price: r.price, chgPct: r.chgPct,
    score: `綜合 ${r.compositeScore}分`,
  })), { icon: '🌱', title: '種子選股', mode: 'seed' });
}

// ── 結果卡片 HTML ─────────────────────────────────────────
function _resultCardHTML(r, opts = {}) {
  const up = r.chgPct > 0;
  const dn = r.chgPct < 0;
  const pctStr = r.chgPct != null
    ? `${r.chgPct > 0 ? '+' : ''}${Number(r.chgPct).toFixed(2)}%`
    : '—';
  const priceStr = r.price != null ? String(r.price) : '—';

  // 簡易 sparkline（無資料時顯示佔位）
  const spark = `
    <div class="m-rc-spark">
      ${[40,55,48,72,68,85,100].map((h,i) =>
        `<div class="m-rcb" style="height:${h}%;background:rgba(${up?'239,83,80':'38,166,154'},${0.3+h/200})"></div>`
      ).join('')}
    </div>
  `;

  return `
    <div class="m-rc" data-code="${r.code}">
      <div class="m-rc-info">
        <div class="m-rc-name">${_esc(r.name || r.code)}</div>
        <div class="m-rc-code">${r.code}${opts.score ? ' · ' + opts.score : ''}</div>
        <div class="m-rc-badge">
          ${(opts.tags || []).map(tag =>
            `<div class="m-rc-tag ${opts.tagClass || ''}">${_esc(tag)}</div>`
          ).join('')}
        </div>
      </div>
      ${spark}
      <div class="m-rc-r">
        <div class="m-rc-price ${up?'m-up':dn?'m-dn':''}">${priceStr}</div>
        <div class="m-rc-pct ${up?'m-up-bg':dn?'m-dn-bg':''}">${pctStr}</div>
      </div>
    </div>
  `;
}

function _bindResultCards(body, results, sheetMeta) {
  body.querySelectorAll('.m-rc').forEach((el, i) => {
    el.addEventListener('click', () => {
      const r = results[i];
      if (!r) return;
      _openSheet({
        icon: sheetMeta.icon,
        title: r.name || r.code,
        sub: r.code,
        mode: sheetMeta.mode,
        activeTags: [],
        filterRows: [],
        sort: ['漲幅↓', '成交量', '信號'],
        stocks: [r],
      });
    });
  });
}

// ══════════════════════════════════════════════════════════
// Layer 2：設定掃描
// ══════════════════════════════════════════════════════════

function _openSetup() {
  document.getElementById('mSetupScreen')?.classList.add('open');
  _renderSetupTab('strat');
}

function _closeSetup() {
  document.getElementById('mSetupScreen')?.classList.remove('open');
}

function _switchSetupTab(tab) {
  document.querySelectorAll('#mSetupTabs .m-stab').forEach(b => {
    b.classList.toggle('active', b.dataset.stab === tab);
  });
  _renderSetupTab(tab);
}

async function _renderSetupTab(tab) {
  const body = document.getElementById('mSetupBody');
  if (!body) return;

  switch (tab) {
    case 'strat':   _renderSetupStrat(body);         break;
    case 'pattern': _renderSetupPattern(body);        break;
    case 'seed':    _renderSetupSeed(body);           break;
    case 'track':   await _renderSetupTrack(body);   break;
    case 'theme':   await _renderSetupTheme(body);   break;
  }
}

// ── 設定：策略 ────────────────────────────────────────────
function _renderSetupStrat(body) {
  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">預先過濾（Phase A）</div>
      <div class="m-phase-a">
        <div class="m-phase-a-hint">符合條件才進入策略計算</div>
        <div class="m-phase-a-row">
          <div class="m-phase-a-col">
            <div class="m-phase-a-field-label">股價最低（元）</div>
            <input class="m-phase-a-field" id="mPhaseAMin" type="number" value="10" inputmode="numeric">
          </div>
          <div style="display:flex;align-items:flex-end;padding-bottom:8px;color:#3d444d">—</div>
          <div class="m-phase-a-col">
            <div class="m-phase-a-field-label">股價最高</div>
            <input class="m-phase-a-field" id="mPhaseAMax" type="number" value="9999" inputmode="numeric">
          </div>
          <div class="m-phase-a-col">
            <div class="m-phase-a-field-label">成交量≥（張）</div>
            <input class="m-phase-a-field" id="mPhaseAVol" type="number" value="0" inputmode="numeric">
          </div>
        </div>
      </div>

      <div id="mStratGroupsWrap">
        <!-- 由 screener-ui.js 資料動態載入，先顯示佔位 -->
        <div class="m-strat-section-hd">
          <div class="m-strat-section-name">強勢續漲</div>
          <div class="m-strat-section-cnt">6</div>
        </div>
        <div class="m-sg-grid" id="mSgGrid1">
          ${_sgCardHTML('🚀','量價齊揚','放量上漲且站上月線')}
          ${_sgCardHTML('📈','均線啟動','短均線上穿月線')}
          ${_sgCardHTML('⚡','四線全過','KD與RSI同步強勢')}
          ${_sgCardHTML('🎯','強勢不回','高點不破回測不跌')}
        </div>
        <div class="m-strat-section-hd">
          <div class="m-strat-section-name">X 系列</div>
          <div class="m-strat-section-cnt">5</div>
        </div>
        <div class="m-sg-grid">
          ${_sgCardHTML('💰','黃金比例','量能動能趨勢三軸共振')}
          ${_sgCardHTML('🌊','量證明一切','主力爆量建倉早期訊號')}
          ${_sgCardHTML('🎪','天黑請閉眼','飆股加速期介入')}
          ${_sgCardHTML('🔄','何時輪到我','同族群已啟動等待補漲')}
          ${_sgCardHTML('🦁','炒底王','V型反轉確認 RSI低位反彈')}
        </div>
      </div>

      <div class="m-ai-card">
        <div class="m-ai-title">🤖 AI 掃描協助</div>
        <div class="m-ai-desc">複製 Prompt → 貼給 AI → 把 JSON 貼回來，系統自動驗證後加入結果</div>
        <div class="m-ai-btns">
          <button class="m-ai-btn m-ai-btn-copy" id="mAiCopyBtn">📋 複製 Prompt</button>
          <button class="m-ai-btn m-ai-btn-paste" id="mAiPasteBtn">📥 貼上 JSON</button>
        </div>
      </div>
    </div>

    <div class="m-run-wrap">
      <button class="m-run-btn" id="mStratRunBtn">開始掃描全市場 →</button>
    </div>
  `;

  // 策略卡片選取
  body.querySelectorAll('.m-sg-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('selected'));
  });

  // AI 按鈕 → 轉交給桌機版現有邏輯（透過 CustomEvent）
  document.getElementById('mAiCopyBtn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mobileAiCopyPrompt'));
    _deps.showToast?.('Prompt 已複製，貼給 AI 後把 JSON 貼回來');
  });

  document.getElementById('mAiPasteBtn')?.addEventListener('click', () => {
    const json = prompt('貼上 AI 回的 JSON：');
    if (!json) return;
    document.dispatchEvent(new CustomEvent('mobileAiPasteJson', { detail: { json } }));
  });

  // 執行掃描
  document.getElementById('mStratRunBtn')?.addEventListener('click', async () => {
    const selected = [...body.querySelectorAll('.m-sg-card.selected')]
      .map(el => el.dataset.name);
    if (!selected.length) {
      _deps.showToast?.('請至少選擇一個策略');
      return;
    }
    _closeSetup();
    await _runStratScan({
      priceMin: Number(document.getElementById('mPhaseAMin')?.value || 10),
      priceMax: Number(document.getElementById('mPhaseAMax')?.value || 9999),
      volumeMin: Number(document.getElementById('mPhaseAVol')?.value || 0),
      strategies: selected,
    });
  });
}

function _sgCardHTML(emoji, name, desc, selected = false) {
  return `
    <div class="m-sg-card${selected ? ' selected' : ''}" data-name="${name}">
      <div class="m-sg-check">✓</div>
      <span class="m-sg-emoji">${emoji}</span>
      <div class="m-sg-name">${name}</div>
      <div class="m-sg-desc">${desc}</div>
    </div>
  `;
}

// ── 設定：型態 ────────────────────────────────────────────
function _renderSetupPattern(body) {
  const { AppState } = _deps;
  const sim  = AppState?.pattern?.similarity  || 75;
  const win  = AppState?.pattern?.windowSize  || 20;
  const mode = AppState?.pattern?.featureMode || 'simple';

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">型態輸入</div>
      <div class="m-draw-wrap">
        <div class="m-draw-mode-tabs">
          <button class="m-dmt active" data-dmode="draw">✏️ 手繪</button>
          <button class="m-dmt"        data-dmode="image">🖼 圖片</button>
        </div>
        <div class="m-canvas-wrap">
          <canvas id="mobileDrawCanvas"></canvas>
          <button class="m-canvas-clear" id="mCanvasClear">清除</button>
          <div class="m-canvas-hint">在上方畫布繪製理想走勢</div>
        </div>
      </div>

      <div class="m-slider-wrap">
        <div class="m-sl-row">
          <span class="m-sl-label">相似度門檻</span>
          <span class="m-sl-val" id="mSimVal">${sim}%</span>
        </div>
        <input class="m-slider" id="mSimSlider" type="range" min="60" max="95" value="${sim}">
      </div>

      <div class="m-params-grid">
        <div class="m-param">
          <div class="m-param-label">比對視窗</div>
          <div class="m-pchips">
            ${[15,20,30].map(n =>
              `<div class="m-pchip${n===win?' on':''}" data-win="${n}">${n}根</div>`
            ).join('')}
          </div>
        </div>
        <div class="m-param">
          <div class="m-param-label">特徵模式</div>
          <div class="m-pchips">
            <div class="m-pchip${mode==='simple'?' on':''}" data-fmode="simple">收盤價</div>
            <div class="m-pchip${mode==='multi'?' on':''}"  data-fmode="multi">多維</div>
          </div>
        </div>
        <div class="m-param">
          <div class="m-param-label">K線週期</div>
          <div class="m-pchips">
            ${['1mo','3mo','6mo'].map(p =>
              `<div class="m-pchip${p==='3mo'?' on':''}" data-period="${p}">${p==='1mo'?'1月':p==='3mo'?'3月':'6月'}</div>`
            ).join('')}
          </div>
        </div>
        <div class="m-param">
          <div class="m-param-label">掃描來源</div>
          <div class="m-pchips">
            <div class="m-pchip on" data-src="all">全市場</div>
            <div class="m-pchip"    data-src="screener">選股結果</div>
          </div>
        </div>
      </div>

      <div class="m-range-card">
        <div class="m-range-title">縮小掃描範圍（可選）</div>
        <div class="m-range-row">
          <div class="m-range-label">股價（元）</div>
          <div class="m-range-inputs">
            <input class="m-range-field" id="mPatPriceMin" placeholder="最低" type="number" inputmode="numeric">
            <div class="m-range-sep">—</div>
            <input class="m-range-field" id="mPatPriceMax" placeholder="最高" type="number" inputmode="numeric">
          </div>
        </div>
        <div class="m-range-row">
          <div class="m-range-label">成交量≥</div>
          <div class="m-range-inputs">
            <input class="m-range-field" id="mPatVolMin" placeholder="不限" type="number" inputmode="numeric" style="max-width:120px">
          </div>
        </div>
      </div>
    </div>

    <div class="m-run-wrap">
      <button class="m-run-btn disabled" id="mPatternRunBtn" disabled>請先繪製型態</button>
    </div>
  `;

  // 初始化 canvas
  _initMobileCanvas(body);

  // slider
  document.getElementById('mSimSlider')?.addEventListener('input', e => {
    document.getElementById('mSimVal').textContent = e.target.value + '%';
  });

  // chips 單選
  body.querySelectorAll('.m-pchips').forEach(group => {
    group.querySelectorAll('.m-pchip').forEach(chip => {
      chip.addEventListener('click', () => {
        group.querySelectorAll('.m-pchip').forEach(c => c.classList.remove('on'));
        chip.classList.add('on');
      });
    });
  });

  // draw mode tabs
  body.querySelectorAll('.m-dmt').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.m-dmt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // 執行按鈕
  document.getElementById('mPatternRunBtn')?.addEventListener('click', async () => {
    const { AppState } = _deps;
    if (!AppState?.pattern?.template) return;
    _closeSetup();
    AppState.pattern.similarity  = Number(document.getElementById('mSimSlider')?.value || 75);
    AppState.pattern.windowSize  = Number(body.querySelector('.m-pchip[data-win].on')?.dataset.win || 20);
    AppState.pattern.featureMode = body.querySelector('.m-pchip[data-fmode].on')?.dataset.fmode || 'simple';
    await _runPatternScan({
      similarity:  AppState.pattern.similarity,
      windowSize:  AppState.pattern.windowSize,
      featureMode: AppState.pattern.featureMode,
      period:      body.querySelector('.m-pchip[data-period].on')?.dataset.period || '3mo',
      priceMin:    Number(document.getElementById('mPatPriceMin')?.value || 0),
      priceMax:    Number(document.getElementById('mPatPriceMax')?.value || 99999),
      volumeMin:   Number(document.getElementById('mPatVolMin')?.value || 0),
    });
  });
}

// ── Canvas 手繪 ───────────────────────────────────────────
function _initMobileCanvas(body) {
  const cvs = document.getElementById('mobileDrawCanvas');
  if (!cvs) return;

  const W = cvs.parentElement.clientWidth - 24 || 327;
  cvs.width  = W;
  cvs.height = 110;
  const ctx = cvs.getContext('2d');

  let isDrawing = false, pts = [];

  function _clearCvs() {
    ctx.clearRect(0, 0, W, 110);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth   = 1;
    [28, 56, 84].forEach(y => {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, 55); ctx.lineTo(W, 55); ctx.stroke();
    ctx.setLineDash([]);
    pts = [];
    const runBtn = document.getElementById('mPatternRunBtn');
    if (runBtn) { runBtn.textContent = '請先繪製型態'; runBtn.disabled = true; runBtn.classList.add('disabled'); }
    _deps.AppState && (_deps.AppState.pattern.template = null);
  }

  function _redraw() {
    _clearCvs();
    if (pts.length < 2) return;
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }

  function _pt(e)     { const r = cvs.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function _ptT(e)    { const r = cvs.getBoundingClientRect(), t = e.touches[0]; return { x: t.clientX - r.left, y: t.clientY - r.top }; }

  function _onEnd() {
    isDrawing = false;
    if (pts.length < 5) return;
    // 轉成虛擬 Candle[] 存入 AppState
    const now = Math.floor(Date.now() / 1000);
    const sampled = _downsample(pts, 40);
    const template = sampled.map((p, i) => {
      const close = ((110 - p.y) / 110) * 100;
      return { time: now - (sampled.length - 1 - i) * 86400, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
    });
    if (_deps.AppState) _deps.AppState.pattern.template = template;
    const runBtn = document.getElementById('mPatternRunBtn');
    if (runBtn) { runBtn.textContent = '開始掃描全市場 →'; runBtn.disabled = false; runBtn.classList.remove('disabled'); }
  }

  cvs.addEventListener('mousedown',  e => { isDrawing = true; pts = [_pt(e)]; });
  cvs.addEventListener('mousemove',  e => { if (!isDrawing) return; pts.push(_pt(e)); _redraw(); });
  cvs.addEventListener('mouseup',    () => _onEnd());
  cvs.addEventListener('mouseleave', () => { if (isDrawing) _onEnd(); });
  cvs.addEventListener('touchstart', e => { e.preventDefault(); isDrawing = true; pts = [_ptT(e)]; }, { passive: false });
  cvs.addEventListener('touchmove',  e => { e.preventDefault(); if (!isDrawing) return; pts.push(_ptT(e)); _redraw(); }, { passive: false });
  cvs.addEventListener('touchend',   () => _onEnd());

  document.getElementById('mCanvasClear')?.addEventListener('click', _clearCvs);
  _clearCvs();
}

function _downsample(pts, max) {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]);
}

// ── 設定：種子 ────────────────────────────────────────────
function _renderSetupSeed(body) {
  const { AppState } = _deps;
  const w = AppState?.seed?.weights || { sector: 0.25, pattern: 0.50, indicator: 0.25 };
  const thresh = AppState?.seed?.threshold || 60;

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-seed-input-card">
        <div class="m-seed-title">種子股（2–10 檔）</div>
        <div class="m-seed-hint">輸入標竿股，系統找出相似個股</div>
        <div class="m-seed-row">
          <input class="m-seed-field" id="mSeedInput" placeholder="輸入代號，如 2330…" inputmode="numeric">
          <button class="m-seed-add" id="mSeedAdd">新增</button>
        </div>
        <button class="m-seed-from" id="mSeedFrom">
          📋 從自選群組帶入 ⌄
        </button>
        <div class="m-seed-chips" id="mSeedChips">
          ${(AppState?.seed?.seedCodes || []).map(c =>
            `<div class="m-seed-chip" data-code="${c}">${c} ${_deps.getChineseName?.(c)||''}<span class="m-seed-chip-rm">✕</span></div>`
          ).join('')}
        </div>
      </div>

      <div class="m-weights-card">
        <div class="m-weights-title">評分權重</div>
        <div class="m-weight-row">
          <div class="m-weight-top"><span class="m-weight-label">產業</span><span class="m-weight-val" id="mW1v">${Math.round(w.sector*100)}%</span></div>
          <input class="m-slider" id="mW1" type="range" min="0" max="60" value="${Math.round(w.sector*100)}">
        </div>
        <div class="m-weight-row">
          <div class="m-weight-top"><span class="m-weight-label">線型</span><span class="m-weight-val" id="mW2v">${Math.round(w.pattern*100)}%</span></div>
          <input class="m-slider" id="mW2" type="range" min="20" max="70" value="${Math.round(w.pattern*100)}">
        </div>
        <div class="m-weight-row">
          <div class="m-weight-top"><span class="m-weight-label">指標</span><span class="m-weight-val" id="mW3v">${Math.round(w.indicator*100)}%</span></div>
          <input class="m-slider" id="mW3" type="range" min="0" max="50" value="${Math.round(w.indicator*100)}">
        </div>
      </div>

      <div class="m-slider-wrap">
        <div class="m-sl-row">
          <span class="m-sl-label">評分門檻</span>
          <span class="m-sl-val" id="mThreshVal">${thresh}分</span>
        </div>
        <input class="m-slider" id="mThreshSlider" type="range" min="40" max="85" value="${thresh}">
      </div>

      <div class="m-range-card">
        <div class="m-range-title">縮小掃描範圍</div>
        <div class="m-range-row">
          <div class="m-range-label">股價（元）</div>
          <div class="m-range-inputs">
            <input class="m-range-field" id="mSeedPMin" placeholder="最低" type="number" inputmode="numeric">
            <div class="m-range-sep">—</div>
            <input class="m-range-field" id="mSeedPMax" placeholder="最高" type="number" inputmode="numeric">
          </div>
        </div>
        <div class="m-range-row">
          <div class="m-range-label">成交量≥</div>
          <div class="m-range-inputs">
            <input class="m-range-field" id="mSeedVMin" placeholder="不限" type="number" inputmode="numeric" style="max-width:120px">
          </div>
        </div>
        <div class="m-from-scr-row">
          <button class="m-toggle" id="mFromScrToggle"><div class="m-toggle-knob"></div></button>
          <span class="m-from-scr-label">從「選股結果」掃描</span>
          <span class="m-from-scr-cnt">${(_deps.AppState?.screener?.results||[]).length} 檔</span>
        </div>
      </div>
    </div>

    <div class="m-run-wrap">
      <button class="m-run-btn" id="mSeedRunBtn">分析種子 → 開始掃描</button>
    </div>
  `;

  // slider 事件
  [['mW1','mW1v','%'],['mW2','mW2v','%'],['mW3','mW3v','%'],['mThreshSlider','mThreshVal','分']].forEach(([sid,vid,unit]) => {
    document.getElementById(sid)?.addEventListener('input', e => {
      document.getElementById(vid).textContent = e.target.value + unit;
    });
  });

  // toggle
  document.getElementById('mFromScrToggle')?.addEventListener('click', function() {
    this.classList.toggle('on');
  });

  // 新增種子
  document.getElementById('mSeedAdd')?.addEventListener('click', _addSeedChip);
  document.getElementById('mSeedInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _addSeedChip();
  });

  // 種子刪除（委派）
  document.getElementById('mSeedChips')?.addEventListener('click', e => {
    if (e.target.classList.contains('m-seed-chip-rm')) {
      e.target.closest('.m-seed-chip')?.remove();
    }
  });

  // 執行
  document.getElementById('mSeedRunBtn')?.addEventListener('click', async () => {
    const codes = [...document.querySelectorAll('#mSeedChips .m-seed-chip')]
      .map(el => el.dataset.code).filter(Boolean);
    if (codes.length < 2) {
      _deps.showToast?.('請至少輸入 2 檔種子股');
      return;
    }
    if (_deps.AppState) {
      _deps.AppState.seed.seedCodes = codes;
      _deps.AppState.seed.threshold = Number(document.getElementById('mThreshSlider')?.value || 60);
      _deps.AppState.seed.weights   = {
        sector:    Number(document.getElementById('mW1')?.value || 25) / 100,
        pattern:   Number(document.getElementById('mW2')?.value || 50) / 100,
        indicator: Number(document.getElementById('mW3')?.value || 25) / 100,
      };
    }
    _closeSetup();
    await _runSeedScan({
      codes,
      threshold: _deps.AppState?.seed?.threshold || 60,
      weights:   _deps.AppState?.seed?.weights,
      priceMin:  Number(document.getElementById('mSeedPMin')?.value || 0),
      priceMax:  Number(document.getElementById('mSeedPMax')?.value || 99999),
      volumeMin: Number(document.getElementById('mSeedVMin')?.value || 0),
      useScreenerResults: document.getElementById('mFromScrToggle')?.classList.contains('on'),
    });
  });
}

function _addSeedChip() {
  const inp = document.getElementById('mSeedInput');
  const code = (inp?.value || '').trim().replace(/\s/g,'');
  if (!code || !/^\d{4}$/.test(code)) {
    _deps.showToast?.('請輸入 4 位數股票代號');
    return;
  }
  const chips = document.getElementById('mSeedChips');
  if (chips?.querySelector(`[data-code="${code}"]`)) {
    _deps.showToast?.('已存在');
    return;
  }
  if (chips?.children.length >= 10) {
    _deps.showToast?.('最多 10 檔');
    return;
  }
  const div = document.createElement('div');
  div.className = 'm-seed-chip';
  div.dataset.code = code;
  div.innerHTML = `${code} ${_deps.getChineseName?.(code)||''}<span class="m-seed-chip-rm">✕</span>`;
  chips?.appendChild(div);
  if (inp) inp.value = '';
}

// ── 設定：追蹤 ────────────────────────────────────────────
async function _renderSetupTrack(body) {
  const { listAll, createList } = await import('./portfolio.js');
  const lists = listAll('watch');

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">追蹤清單</div>
      <div class="m-strat-list" id="mTrackLists">
        ${lists.map(l => `
          <div class="m-strat-card" data-list-id="${l.id}">
            <div class="m-strat-icon" style="background:rgba(88,166,255,0.1);font-size:22px">${l.emoji||'📋'}</div>
            <div class="m-strat-info">
              <div class="m-strat-name">${_esc(l.name)}</div>
              <div class="m-strat-desc">${(l.items||[]).length} 檔</div>
            </div>
            <span style="font-size:16px;color:#8b949e">✎</span>
          </div>
        `).join('')}
      </div>
      <div style="display:flex;align-items:center;gap:8px;padding:11px 14px;background:rgba(88,166,255,0.05);border:0.5px dashed rgba(88,166,255,0.3);border-radius:12px;cursor:pointer;color:#58a6ff;font-size:13px;font-weight:600;margin-top:8px;" id="mTrackAdd">
        ＋ 新增追蹤清單
      </div>
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mTrackRunBtn">更新追蹤清單價格</button>
    </div>
  `;

  document.getElementById('mTrackAdd')?.addEventListener('click', async () => {
    const name = prompt('清單名稱：');
    if (!name) return;
    await createList('watch', name);
    await _renderSetupTrack(body);
  });

  document.getElementById('mTrackRunBtn')?.addEventListener('click', () => {
    _closeSetup();
    _deps.showToast?.('追蹤清單價格更新中…');
    // 觸發現有 watchlist 更新邏輯
    document.dispatchEvent(new CustomEvent('mobileRefreshTrack'));
    _currentMode = 'track';
    _renderCurrentMode();
  });
}

// ── 設定：題材 ────────────────────────────────────────────
async function _renderSetupTheme(body) {
  const { getThemes, reloadThemes } = await import('./theme.js');
  const themes = getThemes();

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">我的題材</div>
      <div class="m-strat-list">
        ${themes.map((t, i) => `
          <div class="m-strat-card">
            <div class="m-strat-icon" style="font-size:22px">${t.emoji||'🏷️'}</div>
            <div class="m-strat-info">
              <div class="m-strat-name">${_esc(t.name)}</div>
              <div class="m-strat-desc">${(t.stocks||[]).length} 檔 · ${_esc(t.desc||'')}</div>
            </div>
            <span style="font-size:16px;color:#8b949e">✎</span>
          </div>
        `).join('')}
      </div>
      <div style="display:flex;align-items:center;gap:8px;padding:11px 14px;background:rgba(88,166,255,0.05);border:0.5px dashed rgba(88,166,255,0.3);border-radius:12px;cursor:pointer;color:#58a6ff;font-size:13px;font-weight:600;margin-top:8px;" id="mThemeAdd">
        ＋ 新增題材
      </div>
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mThemeRunBtn">更新題材個股行情</button>
    </div>
  `;

  document.getElementById('mThemeAdd')?.addEventListener('click', () => {
    // 導向桌機版題材新增（切到 theme tab）
    _closeSetup();
    _deps.showToast?.('請在桌機版新增題材，手機版即時同步');
  });

  document.getElementById('mThemeRunBtn')?.addEventListener('click', () => {
    _closeSetup();
    _deps.showToast?.('題材行情更新中…');
    document.dispatchEvent(new CustomEvent('mobileRefreshTheme'));
    _currentMode = 'theme';
    _renderCurrentMode();
  });
}

// ══════════════════════════════════════════════════════════
// 掃描執行
// ══════════════════════════════════════════════════════════

async function _runStratScan(opts) {
  _showScanOverlay('策略篩選');
  try {
    const { runScreener } = await import('./screener.js');
    // 轉換策略名稱 → 條件組
    const { AppState } = _deps;
    // 直接觸發現有策略掃描流程
    document.dispatchEvent(new CustomEvent('mobileRunStrat', { detail: opts }));
    // 監聽結果回傳
    await _waitForEvent('screenerDone', 60000);
    _hideScanOverlay();
    _currentMode = 'strat';
    _renderCurrentMode();
  } catch (e) {
    _hideScanOverlay();
    _deps.showToast?.('掃描失敗：' + e.message);
  }
}

async function _runPatternScan(opts) {
  _showScanOverlay('型態比對');
  try {
    const { runPatternScan, abortScan } = await import('./pattern-scan.js');
    _scanAbort = new AbortController();
    const { AppState } = _deps;
    const template = AppState?.pattern?.template;
    if (!template) throw new Error('無型態範本');

    AppState.pattern.scanResults = [];
    let done = 0, total = 0;

    const gen = runPatternScan(template, { ...opts, signal: _scanAbort.signal });
    for await (const evt of gen) {
      if (evt.type === 'progress') {
        done  = evt.done  || done;
        total = evt.total || total;
        _updateScanProgress(done, total, evt.message);
      } else if (evt.type === 'result') {
        AppState.pattern.scanResults.push(evt.item);
      } else if (evt.type === 'done' || evt.type === 'aborted') {
        break;
      }
    }

    _hideScanOverlay();
    _currentMode = 'pattern';
    _renderCurrentMode();
  } catch (e) {
    _hideScanOverlay();
    if (e.name !== 'AbortError') _deps.showToast?.('掃描失敗：' + e.message);
  }
}

async function _runSeedScan(opts) {
  _showScanOverlay('種子選股');
  try {
    const { runSeedScan }          = await import('./seed-scan.js');
    const { extractSeedFeatures, mergeTemplates } = await import('./seed.js');
    const { fetchHistoryCached, toYahooSymbol } = await import('./api.js');
    const { AppState } = _deps;

    // Phase A：提取種子特徵
    _updateScanProgress(0, opts.codes.length, '分析種子中…');
    const features = [];
    for (const code of opts.codes) {
      const candles = await fetchHistoryCached(toYahooSymbol(code), '3mo');
      if (candles?.length >= 20) {
        const feat = extractSeedFeatures(candles, { code });
        if (feat) features.push(feat);
      }
    }
    if (!features.length) throw new Error('種子股資料不足');
    const template = mergeTemplates(features);
    AppState.seed.template = template;

    // Phase B：全市場掃描
    AppState.seed.scanResults = [];
    const gen = runSeedScan(template, {
      weights:            opts.weights,
      priceMin:           opts.priceMin,
      priceMax:           opts.priceMax,
      volumeMin:          opts.volumeMin,
      threshold:          opts.threshold,
      useScreenerResults: opts.useScreenerResults,
    });

    for await (const evt of gen) {
      if (evt.type === 'progress') {
        _updateScanProgress(evt.done, evt.total, evt.message);
      } else if (evt.type === 'result') {
        AppState.seed.scanResults.push(evt.item);
      } else if (evt.type === 'done' || evt.type === 'aborted') {
        break;
      }
    }

    _hideScanOverlay();
    _currentMode = 'seed';
    _renderCurrentMode();
  } catch (e) {
    _hideScanOverlay();
    _deps.showToast?.('掃描失敗：' + e.message);
  }
}

function _abortScan() {
  _scanAbort?.abort();
  _hideScanOverlay();
}

// ══════════════════════════════════════════════════════════
// Bottom Sheet
// ══════════════════════════════════════════════════════════

function _openSheet({ icon, title, sub, mode, activeTags, filterRows, sort, stocks }) {
  document.getElementById('mShIcon').textContent  = icon;
  document.getElementById('mShTitle').textContent = title;
  document.getElementById('mShSub').textContent   = sub;

  // active tags
  document.getElementById('mShActiveTags').innerHTML =
    activeTags.map(t => `<div class="m-sh-atag">${_esc(t)}</div>`).join('');

  // filter rows
  const filterInner = document.getElementById('mShFilterInner');
  const filterHd    = document.getElementById('mShFilterHd');
  if (!filterRows.length) {
    filterHd.style.display = 'none';
  } else {
    filterHd.style.display = '';
    filterInner.innerHTML = filterRows.map(row => `
      <div class="m-frow">
        <div class="m-frow-label">${row.label}</div>
        <div class="m-fchips">
          ${row.opts.map(o =>
            `<div class="m-fchip${o===row.def?' on':''}">${o}</div>`
          ).join('')}
        </div>
      </div>
    `).join('');
    filterInner.querySelectorAll('.m-frow').forEach(row => {
      row.querySelectorAll('.m-fchip').forEach(chip => {
        chip.addEventListener('click', () => {
          row.querySelectorAll('.m-fchip').forEach(c => c.classList.remove('on'));
          chip.classList.add('on');
        });
      });
    });
  }

  // sort pills
  document.getElementById('mShSort').innerHTML = sort.map((s, i) =>
    `<div class="m-sh-pill${i===0?' on':''}">${s}</div>`
  ).join('');
  document.getElementById('mShSort').querySelectorAll('.m-sh-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#mShSort .m-sh-pill').forEach(p => p.classList.remove('on'));
      pill.classList.add('on');
    });
  });

  // stocks
  document.getElementById('mShStocks').innerHTML = stocks.slice(0, 30).map(s => `
    <div class="m-ss-card">
      <div class="m-ss-info">
        <div class="m-ss-name">${_esc(s.name || s.code)}</div>
        <div class="m-ss-code">${s.code}</div>
        ${s.score ? `<div class="m-ss-score">${_esc(s.score)}</div>` : ''}
      </div>
      <div class="m-ss-spark">
        ${[40,55,65,78,70,88,100].map(h =>
          `<div class="m-ssb" style="height:${h}%;background:rgba(239,83,80,${0.3+h/200})"></div>`
        ).join('')}
      </div>
      <div class="m-ss-r">
        <div class="m-ss-price ${s.up?'m-up':s.up===false?'m-dn':''}">${s.price != null ? s.price : '—'}</div>
        <div class="m-ss-pct ${s.up?'m-up-bg':s.up===false?'m-dn-bg':''}">${s.pct != null ? s.pct : '—'}</div>
      </div>
    </div>
  `).join('');

  // reset filter state
  _filterOpen = false;
  document.getElementById('mShFilterBody').classList.remove('open');
  document.getElementById('mShFilterArr').classList.remove('open');

  document.getElementById('mSheetOv').classList.add('open');
}

function _closeSheet() {
  document.getElementById('mSheetOv')?.classList.remove('open');
}

function _toggleSheetFilter() {
  _filterOpen = !_filterOpen;
  document.getElementById('mShFilterBody').classList.toggle('open', _filterOpen);
  document.getElementById('mShFilterArr').classList.toggle('open', _filterOpen);
}

// ══════════════════════════════════════════════════════════
// 掃描進度 UI
// ══════════════════════════════════════════════════════════

function _showScanOverlay(label) {
  document.getElementById('mScanTitle').textContent = `${label}掃描中…`;
  document.getElementById('mScanSub').textContent   = '初始化中';
  document.getElementById('mScanCount').textContent = '';
  document.getElementById('mScanProg').style.width  = '0%';
  document.getElementById('mScanOverlay')?.classList.add('open');
}

function _hideScanOverlay() {
  document.getElementById('mScanOverlay')?.classList.remove('open');
  _scanAbort = null;
}

function _updateScanProgress(done, total, msg) {
  document.getElementById('mScanSub').textContent   = msg || '';
  document.getElementById('mScanCount').textContent = total ? `${done} / ${total}` : '';
  if (total > 0) {
    document.getElementById('mScanProg').style.width = `${Math.round(done / total * 100)}%`;
  }
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

function _updateCnt(mode, n) {
  const el = document.getElementById(`mCnt-${mode}`);
  if (el) el.textContent = n;
}

function _emptyHTML(icon, title, desc, showBtn = false) {
  return `
    <div class="m-empty">
      <div class="m-empty-icon">${icon}</div>
      <div class="m-empty-title">${title}</div>
      <div class="m-empty-desc">${desc}</div>
      ${showBtn ? `<button class="m-empty-btn" onclick="document.getElementById('mSetupBtn').click()">設定掃描</button>` : ''}
    </div>
  `;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function _waitForEvent(name, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeout);
    document.addEventListener(name, () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
