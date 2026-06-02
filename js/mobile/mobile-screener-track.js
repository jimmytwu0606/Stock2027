/**
 * mobile-screener-track.js
 * 追蹤清單結果渲染 + 策略選股設定
 *
 * 策略選股流程（對應桌機版 modal-strategy.js）：
 *   1. 策略卡片清單 → 點選策略
 *   2. 顯示 Prompt 區 → 複製 Prompt → 貼回 JSON
 *   3. 驗算（scanOneCode）→ 通過才加入追蹤
 */

import { STRATEGIES } from '../strategy.js';
import { getChineseName } from '../api.js';

// ── 類別顏色（同 modal-strategy.js）────────────────────────────
const CATEGORY_COLOR = {
  'X 系列':   { bg:'rgba(250,204,21,0.1)',  border:'rgba(250,204,21,0.5)',  text:'#facc15' },
  '強勢續漲': { bg:'rgba(38,166,154,0.1)',  border:'rgba(38,166,154,0.4)',  text:'#26a69a' },
  '超跌反彈': { bg:'rgba(59,130,246,0.1)',  border:'rgba(59,130,246,0.4)',  text:'#93c5fd' },
  '轉折訊號': { bg:'rgba(245,158,11,0.1)',  border:'rgba(245,158,11,0.4)',  text:'#f59e0b' },
  '葛蘭碧':   { bg:'rgba(167,139,250,0.1)', border:'rgba(167,139,250,0.4)', text:'#a78bfa' },
  '盤整突破': { bg:'rgba(244,114,182,0.1)', border:'rgba(244,114,182,0.4)', text:'#f472b6' },
  '基本面':   { bg:'rgba(34,197,94,0.1)',   border:'rgba(34,197,94,0.4)',   text:'#22c55e' },
  '巴菲特':   { bg:'rgba(251,191,36,0.1)',  border:'rgba(251,191,36,0.4)',  text:'#fbbf24' },
  '技術指標': { bg:'rgba(99,102,241,0.1)',  border:'rgba(99,102,241,0.4)',  text:'#818cf8' },
  'K線型態':  { bg:'rgba(236,72,153,0.1)',  border:'rgba(236,72,153,0.4)',  text:'#f9a8d4' },
  '避險警示': { bg:'rgba(239,68,68,0.1)',   border:'rgba(239,68,68,0.4)',   text:'#fca5a5' },
};
const CATEGORY_ORDER = ['X 系列','強勢續漲','超跌反彈','轉折訊號','葛蘭碧','盤整突破','基本面','巴菲特','技術指標','K線型態','避險警示'];

// condId → 中文描述（同 modal-strategy.js COND_DESC 精簡版）
const COND_DESC = {
  'above_ma20': () => '股價站上 MA20',
  'ma20_rising': v => `MA20 連漲 ${v} 天`,
  'ma5_cross_ma20': () => 'MA5 黃金交叉 MA20',
  'rsi_min': v => `RSI ≥ ${v}`,
  'rsi_max': v => `RSI ≤ ${v}`,
  'kd_golden': () => 'KD 黃金交叉',
  'macd_golden': () => 'MACD 黃金交叉',
  'vol_surge': v => `量 ≥ 均量 × ${v}`,
  'gain_10d': v => `近10日漲幅 ≥ ${v}%`,
  'chg_min': v => `今日漲幅 ≥ ${v}%`,
  'eps_positive': () => 'EPS 為正',
  'eps_growth_yoy': v => `EPS 年增率 ≥ ${v}%`,
  'foreign_buy_days': v => `外資連買 ≥ ${v} 日`,
};
function _condText(c) {
  const fn = COND_DESC[c.condId];
  return fn ? fn(c.value) : c.condId;
}

// ── 模組狀態 ────────────────────────────────────────────────────
let _selected   = null;   // 選中的策略物件
let _verified   = [];     // 驗算通過的股票
let _currentBody = null;  // 當前 DOM body，供驗算後更新

// ══════════════════════════════════════════
//  結果渲染
// ══════════════════════════════════════════
export async function renderResult(body, deps) {
  const { getChineseName: gcn, onOpenSheet } = deps;
  const { listAll } = await import('../portfolio.js');
  const lists = listAll('watch');
  const total = lists.reduce((n, l) => n + (l.items || []).length, 0);

  if (!total) {
    body.innerHTML = _emptyHTML('📋', '尚無追蹤清單', '請至「設定掃描 → 追蹤 → 策略選股」新增');
    return;
  }

  let html = `<div class="m-last-scan">追蹤清單 <span>${total} 檔</span></div>`;
  lists.forEach(list => {
    if (!(list.items || []).length) return;
    html += `
      <div class="m-last-scan" style="padding-top:6px">${_esc(list.name)}<span>${list.items.length}檔</span></div>
      <div class="m-result-list">
        ${list.items.map(item => `
          <div class="m-rc" data-code="${item.code}">
            <div class="m-rc-info">
              <div class="m-rc-name">${_esc(item.name || item.code)}</div>
              <div class="m-rc-code">${item.code}</div>
              ${item.note ? `<div class="m-rc-code" style="color:#8b949e">${_esc(item.note)}</div>` : ''}
            </div>
            <div class="m-rc-r">
              <div class="m-rc-price" style="color:#e6edf3">—</div>
            </div>
          </div>`).join('')}
      </div>`;
  });
  body.innerHTML = html;
  body.querySelectorAll('.m-rc').forEach(el => {
    el.addEventListener('click', () => window.__loadStock?.(el.dataset.code));
  });
}

// ══════════════════════════════════════════
//  設定：策略選股（兩個子步驟）
// ══════════════════════════════════════════
export async function renderSetup(body, deps) {
  _currentBody = body;
  _selected = null;
  _verified = [];
  _renderStepSelect(body, deps);
}

// ── Step 1：策略卡片列表（可收折群組）────────────────────────────
function _renderStepSelect(body, deps) {
  const grouped = {};
  STRATEGIES.forEach(s => {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  });

  let catHtml = '';
  CATEGORY_ORDER.forEach((cat, idx) => {
    const list = grouped[cat];
    if (!list?.length) return;
    const c = CATEGORY_COLOR[cat] ?? { bg:'rgba(107,114,128,0.1)', border:'rgba(107,114,128,0.4)', text:'#9ca3af' };
    // 預設只展開第一個群組，其餘收折
    const isOpen = idx === 0;
    catHtml += `
      <div class="mtr-grp" data-cat="${_esc(cat)}">
        <div class="mtr-grp-hd" style="border-left:3px solid ${c.border}">
          <div class="mtr-grp-left">
            <span class="mtr-grp-name" style="color:${c.text}">${cat}</span>
            <span class="mtr-grp-cnt" style="background:${c.bg};color:${c.text};border-color:${c.border}">${list.length}</span>
          </div>
          <span class="mtr-grp-arrow${isOpen ? ' open' : ''}">⌄</span>
        </div>
        <div class="mtr-grp-body${isOpen ? ' open' : ''}">
          ${list.map(s => `
            <button class="mtr-strat-btn" data-id="${s.id}"
              style="background:${c.bg};border-color:${c.border}">
              <span class="mtr-s-icon">${s.icon}</span>
              <div class="mtr-s-info">
                <div class="mtr-s-name" style="color:${c.text}">${s.name}</div>
                <div class="mtr-s-desc">${_esc(s.desc)}</div>
              </div>
              <span class="mtr-cond-cnt">${(s.conditions?.length ?? 0)} 個條件</span>
            </button>`).join('')}
        </div>
      </div>`;
  });

  body.innerHTML = `
    <div class="m-s-section" style="padding-bottom:6px">
      <div class="m-s-label">選擇策略</div>
      <div id="mTrStratGrid">${catHtml}</div>
    </div>`;

  // 群組標題收折
  body.querySelectorAll('.mtr-grp-hd').forEach(hd => {
    hd.addEventListener('click', () => {
      const grp   = hd.closest('.mtr-grp');
      const body_ = grp.querySelector('.mtr-grp-body');
      const arrow = grp.querySelector('.mtr-grp-arrow');
      body_.classList.toggle('open');
      arrow.classList.toggle('open');
    });
  });

  // 策略按鈕點選
  body.querySelectorAll('.mtr-strat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _selected = STRATEGIES.find(s => s.id === btn.dataset.id);
      if (!_selected) return;
      _renderStepPrompt(body, deps);
    });
  });
}

// ── Step 2：已選策略 → 股價區間 → 複製Prompt → 貼JSON → 驗算 ──
function _renderStepPrompt(body, deps) {
  const s = _selected;
  const c = CATEGORY_COLOR[s.category] ?? { bg:'rgba(107,114,128,0.1)', border:'rgba(107,114,128,0.4)', text:'#9ca3af' };

  body.innerHTML = `
    <!-- ① 已選策略 -->
    <div class="m-s-section" style="padding-bottom:0">
      <div class="mtr-selected-card" style="background:${c.bg};border-color:${c.border}">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <span style="font-size:18px;flex-shrink:0">${s.icon}</span>
          <div style="min-width:0">
            <div class="mtr-sel-name" style="color:${c.text}">${s.name}</div>
            <div class="mtr-sel-desc">${_esc(s.desc)}</div>
          </div>
        </div>
        <button id="mTrBackBtn" class="mtr-back-btn">← 換策略</button>
      </div>
    </div>

    <!-- ② 股價區間（先填好，Prompt 才帶入）-->
    <div class="m-s-section" style="padding-top:12px">
      <div class="m-s-label">💰 股價區間（選填，會帶入 Prompt）</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button class="mtr-preset-btn" data-min="0" data-max="50">50以下</button>
        <button class="mtr-preset-btn" data-min="0" data-max="100">100以下</button>
        <button class="mtr-preset-btn" data-min="0" data-max="300">300以下</button>
        <button class="mtr-preset-btn" data-min="0" data-max="500">500以下</button>
        <button class="mtr-preset-btn active" data-min="0" data-max="0">不限</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input id="mTrPriceMin" type="number" class="m-phase-a-field" placeholder="最低" style="flex:1" inputmode="numeric">
        <span style="color:#3d444d;font-size:12px">—</span>
        <input id="mTrPriceMax" type="number" class="m-phase-a-field" placeholder="最高" style="flex:1" inputmode="numeric">
        <span style="font-size:12px;color:#8b949e">元</span>
      </div>
    </div>

    <!-- ③ 複製 Prompt（大按鈕）-->
    <div class="m-run-wrap" style="padding-bottom:0">
      <button class="m-run-btn mtr-copy-big-btn" id="mTrCopyBtn">
        📋 複製 Prompt 給 AI
      </button>
      <div style="text-align:center;font-size:11px;color:#3d444d;margin-top:6px">
        複製後貼給 Gemini / ChatGPT，再把 JSON 貼回下方
      </div>
    </div>

    <!-- ④ JSON 貼入 -->
    <div class="m-s-section" style="padding-top:14px">
      <div class="m-s-label">📥 貼上 AI 回覆的 JSON</div>
      <textarea id="mTrJsonInput"
        style="width:100%;min-height:96px;background:#0d1117;border:0.5px solid #30363d;border-radius:9px;
               padding:10px 12px;font-size:12px;color:#e6edf3;font-family:monospace;resize:vertical;box-sizing:border-box"
        placeholder='[{ "code": "2330", "name": "台積電", "reason": "..." }]'></textarea>
      <div id="mTrParseResult" style="font-size:12px;color:#8b949e;min-height:16px;margin-top:4px"></div>
    </div>

    <!-- ⑤ 驗算結果預覽（先隱藏）-->
    <div id="mTrPreview" style="display:none" class="m-s-section">
      <div class="m-s-label">驗算結果</div>
      <div id="mTrPreviewList"></div>
    </div>

    <!-- ⑥ 執行 -->
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mTrVerifyBtn">驗算並加入追蹤 →</button>
    </div>`;

  // ── 返回 ──
  body.querySelector('#mTrBackBtn')?.addEventListener('click', () => {
    _renderStepSelect(body, deps);
  });

  // ── Preset 股價 ──
  body.querySelectorAll('.mtr-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.mtr-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      body.querySelector('#mTrPriceMin').value = btn.dataset.min || '';
      body.querySelector('#mTrPriceMax').value = btn.dataset.max || '';
    });
  });
  body.querySelectorAll('#mTrPriceMin, #mTrPriceMax').forEach(el => {
    el.addEventListener('input', () => {
      body.querySelectorAll('.mtr-preset-btn').forEach(b => b.classList.remove('active'));
    });
  });

  // ── 複製 Prompt ──
  body.querySelector('#mTrCopyBtn')?.addEventListener('click', () => {
    const priceMin = parseFloat(body.querySelector('#mTrPriceMin')?.value) || 0;
    const priceMax = parseFloat(body.querySelector('#mTrPriceMax')?.value) || 0;
    const txt = _buildPrompt(s, priceMin, priceMax);
    navigator.clipboard?.writeText(txt).then(() => {
      const btn = body.querySelector('#mTrCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => { btn.textContent = '📋 複製 Prompt'; }, 2000); }
    }).catch(() => {
      deps.showToast?.('請長按複製');
    });
  });

  // ── 驗算並加入 ──
  body.querySelector('#mTrVerifyBtn')?.addEventListener('click', async () => {
    await _verifyAndAdd(body, deps);
  });
}

// ── 驗算流程 ────────────────────────────────────────────────────
async function _verifyAndAdd(body, deps) {
  const raw = body.querySelector('#mTrJsonInput')?.value.trim() || '';
  const resultEl = body.querySelector('#mTrParseResult');
  const runBtn = body.querySelector('#mTrVerifyBtn');

  if (!raw) { if (resultEl) { resultEl.textContent = '請先貼上 JSON'; resultEl.style.color = '#fca5a5'; } return; }

  // JSON 解析
  let parsed;
  try {
    const clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error('需要陣列格式');
  } catch(e) {
    if (resultEl) { resultEl.textContent = `JSON 解析失敗：${e.message}`; resultEl.style.color = '#fca5a5'; }
    return;
  }

  // 代號驗證 + 股名修正（同 modal-strategy.js）
  const nameCache = window.__nameCache ?? new Map();
  let stocks = parsed.map(s => {
    const code    = String(s.code ?? s['代號'] ?? '').trim();
    const aiName  = String(s.name ?? s['股名'] ?? s['名稱'] ?? '').trim();
    const realName = nameCache.get(code) || getChineseName(code)
                   || (window.__priceCache ?? {})[code]?.name || aiName;
    if (!realName || !/^\d{4,6}[A-Z]?$/i.test(code)) return null;
    return { code, name: realName, reason: String(s.reason ?? s['理由'] ?? '').trim() };
  }).filter(Boolean);

  if (!stocks.length) {
    if (resultEl) { resultEl.textContent = '所有代號均無效，請確認格式'; resultEl.style.color = '#fca5a5'; }
    return;
  }

  // 股價區間過濾
  const priceMin = parseFloat(body.querySelector('#mTrPriceMin')?.value) || 0;
  const priceMax = parseFloat(body.querySelector('#mTrPriceMax')?.value) || Infinity;
  let priceFiltered = 0;
  if (priceMax < Infinity || priceMin > 0) {
    const before = stocks.length;
    stocks = stocks.filter(s => {
      const p = (window.__priceCache ?? {})[s.code]?.price;
      if (p == null) return true;
      return p >= priceMin && p <= priceMax;
    });
    priceFiltered = before - stocks.length;
  }

  if (!stocks.length) {
    if (resultEl) { resultEl.textContent = `所有股票都超出價格區間（過濾 ${priceFiltered} 檔）`; resultEl.style.color = '#fca5a5'; }
    return;
  }

  // 禁用按鈕，開始驗算
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '驗算中…'; }
  if (resultEl) { resultEl.textContent = `驗算中… 0/${stocks.length}`; resultEl.style.color = ''; }

  _verified = [];
  const { scanOneCode } = await import('../signal-scan.js');
  let passed = 0, failed = 0;

  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    try {
      const sigs = await scanOneCode(s.code, { silent: true });
      const hit = sigs.some(sg => sg.id === _selected.id);
      if (hit) { _verified.push(s); passed++; }
      else failed++;
    } catch(e) {
      failed++;
    }
    if (resultEl) resultEl.textContent = `驗算中… ${i+1}/${stocks.length}（通過 ${passed} 檔）`;
  }

  const filterMsg = priceFiltered ? `，價格過濾 ${priceFiltered} 檔` : '';
  if (resultEl) {
    resultEl.textContent = `✓ 通過 ${passed} 檔，未符合 ${failed} 檔${filterMsg}`;
    resultEl.style.color = passed > 0 ? '#86efac' : '#fca5a5';
  }

  if (runBtn) { runBtn.disabled = false; runBtn.textContent = '驗算並加入追蹤 →'; }

  _renderVerifyPreview(body, deps);
}

// ── 驗算結果預覽 ─────────────────────────────────────────────────
function _renderVerifyPreview(body, deps) {
  const wrap = body.querySelector('#mTrPreview');
  const list = body.querySelector('#mTrPreviewList');
  if (!wrap || !list) return;

  if (!_verified.length) {
    wrap.style.display = '';
    list.innerHTML = `<div class="m-empty" style="padding:16px 0"><div class="m-empty-title">無符合策略的個股</div><div class="m-empty-desc">嘗試降低相似度或換一個策略</div></div>`;
    return;
  }

  wrap.style.display = '';
  list.innerHTML = `
    <div class="m-last-scan" style="padding:0 0 8px">
      驗算通過 <span>${_verified.length} 檔</span>
    </div>
    <div class="m-result-list">
      ${_verified.map(s => `
        <div class="m-rc" style="position:relative">
          <div class="m-rc-info">
            <div class="m-rc-name">${_esc(s.name)}</div>
            <div class="m-rc-code">${s.code}</div>
            ${s.reason ? `<div class="m-rc-code" style="color:#8b949e;margin-top:2px">${_esc(s.reason)}</div>` : ''}
          </div>
          <button class="mtr-del-btn" data-code="${s.code}"
            style="background:none;border:none;color:#3d444d;font-size:14px;cursor:pointer;padding:4px 8px;flex-shrink:0">✕</button>
        </div>`).join('')}
    </div>`;

  // 刪除個別股票
  list.querySelectorAll('.mtr-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _verified = _verified.filter(s => s.code !== btn.dataset.code);
      _renderVerifyPreview(body, deps);
    });
  });

  // 全部加入追蹤
  const addBtn = document.createElement('div');
  addBtn.className = 'm-run-wrap';
  addBtn.innerHTML = `<button class="m-run-btn" id="mTrAddAllBtn">✓ 全部加入追蹤清單</button>`;
  list.appendChild(addBtn);

  list.querySelector('#mTrAddAllBtn')?.addEventListener('click', async () => {
    await _addAllToWatch(body, deps);
  });
}

// ── 加入追蹤清單 ─────────────────────────────────────────────────
async function _addAllToWatch(body, deps) {
  if (!_verified.length) return;

  try {
    const { listAll, watchAddCode } = await import('../portfolio.js');
    const lists = listAll('watch');
    const targetList = lists[0];   // 預設加入第一個追蹤清單
    if (!targetList) { deps.showToast?.('找不到追蹤清單，請先建立'); return; }

    const existing = new Set((targetList.items || []).map(it => it.code));
    let added = 0;
    for (const s of _verified) {
      if (existing.has(s.code)) continue;
      const refPx = (window.__priceCache ?? {})[s.code]?.price || 0;
      await watchAddCode(targetList.id, s.code, s.name, refPx, s.reason || `✓ ${_selected?.name}`);
      added++;
    }

    deps.showToast?.(`✓ 已加入 ${added} 檔到「${targetList.name}」`);
    deps.onClose?.();
    deps.onDone?.('track');
  } catch(e) {
    deps.showToast?.('加入失敗：' + e.message);
  }
}

// ── Prompt 生成（同 modal-strategy.js _buildStrategyPrompt）────
function _buildPrompt(strategy, priceMin = 0, priceMax = 0) {
  const condDesc = strategy.conditions?.map(c => `  - ${_condText(c)}`).join('\n') ?? '';
  const priceCondition = priceMax > 0
    ? `\n【股價限制】只選股價在 ${priceMin} ~ ${priceMax} 元之間的個股`
    : priceMin > 0
      ? `\n【股價限制】只選股價高於 ${priceMin} 元的個股`
      : '';

  return `你是台股技術分析與選股專家。

請幫我找出台股近期符合以下策略條件的個股：

【策略名稱】${strategy.icon} ${strategy.name}（${strategy.category}）
【策略說明】${strategy.desc}
【核心條件】
${condDesc || '  請依策略說明判斷'}
${priceCondition}

【選股要求】
- 列出 15~25 檔符合此策略條件的台股個股
- 包含上市（TWSE）和上櫃（TPEx）
- 優先選擇有基本面支撐的標的
- 排除金融股、營建股
- 每檔說明符合此策略的具體原因（30字以內）

【注意】系統會用策略條件對每一檔進行嚴格驗算，不符合的會自動剔除。

只回覆 JSON，不要任何說明文字：
[
  { "code": "台股代號", "name": "公司中文名", "reason": "符合 ${strategy.name} 的具體說明" }
]`;
}

// ── 工具函式 ─────────────────────────────────────────────────────
function _emptyHTML(icon, title, desc) {
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
