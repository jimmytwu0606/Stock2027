/**
 * mobile-screener-theme.js
 * 題材篩選：結果渲染 + 妖股查詢（近期飆股 / 谷底翻身）
 *
 * renderSetup = 妖股查詢 UI（對應桌機版 theme-ui.js _openYaoguScanModal）
 * 流程：選類型 → 填股價區間 → 複製 Prompt → 貼 JSON → 解析預覽 → 存為題材
 */

import { getChineseName } from '../api.js';

// ── Prompt 生成（直接從 theme-ui.js 移植）──────────────────────
function _buildRocketPrompt(priceMin = 0, priceMax = 0) {
  const priceCondition = priceMax > 0
    ? `- 股價介於 ${priceMin} ~ ${priceMax} 元之間`
    : priceMin > 0 ? `- 股價高於 ${priceMin} 元` : '';
  const priceExclude = priceMax > 0 ? `- 剔除股價超過 ${priceMax} 元的個股` : '';
  return `你是台股技術分析專家。請幫我找出台股近期符合以下條件的「近期飆股」：

選股條件（同時符合越多越好）：
1. 股價突破近期整理區，站上 MA20 且 MA20 > MA60
2. 成交量較近 20 日均量放大 1.5 倍以上
3. MACD 黃金交叉或多頭排列（快線在慢線上方）
4. RSI 介於 55~80（強勢但未過熱，排除 RSI < 50 的弱勢股）
5. 近 5 日漲幅 > 5%，且為「多日小漲」型態，非單日暴漲後拉回
6. 主力籌碼持續買超（外資或投信擇一買超）
7. 近 3 日無連續收黑（確認買盤持續）

嚴格排除條件：
- 排除金融股、營建股、航運股、傳產股
- 排除月 KD 死叉的長線弱勢股
- 剔除股價 < 10 元的低價股
${priceCondition}
${priceExclude}

請列出 15~25 檔，優先選擇有基本面支撐的標的。

回覆格式（只回覆 JSON，不要任何說明）：
[
  { "code": "台股代號", "name": "公司中文名", "reason": "符合條件的具體說明（30字以內）" }
]`;
}

function _buildValleyPrompt(priceMin = 0, priceMax = 0) {
  const priceCondition = priceMax > 0
    ? `- 股價介於 ${priceMin} ~ ${priceMax} 元之間`
    : priceMin > 0 ? `- 股價高於 ${priceMin} 元` : '';
  const priceExclude = priceMax > 0 ? `- 剔除股價超過 ${priceMax} 元的個股` : '';
  return `你是台股技術分析專家。請幫我找出台股近期符合以下條件的「谷底翻身」候選股：

選股條件（同時符合越多越好）：
1. 距離近期高點跌幅超過 30%，處於相對低位
2. 近期出現止跌訊號：量縮後突然爆量，或 K 線出現錘頭線/十字星
3. MACD 低位金叉，或出現底背離
4. RSI 從超賣區（< 30）回升至 40 以上
5. 週線級別出現支撐（前波低點或整數關卡）
6. 基本面未明顯惡化（EPS 正值，營收未連續衰退超過 3 季）
7. 近 3 日收紅或出現轉折 K 棒

嚴格排除條件：
- 排除金融股、營建股、航運股、傳產股
- 排除短線健康度 < 30 的極弱勢股
- 剔除股價 < 10 元的低價股
${priceCondition}
${priceExclude}

請列出 15~20 檔，優先選擇跌深但基本面尚可的標的。

回覆格式（只回覆 JSON，不要任何說明）：
[
  { "code": "台股代號", "name": "公司中文名", "reason": "符合條件的具體說明（30字以內）" }
]`;
}

// ══════════════════════════════════════════
//  結果渲染
// ══════════════════════════════════════════
export async function renderResult(body, deps) {
  const { getChineseName: gcn, onOpenSheet } = deps;
  const { getThemes } = await import('../theme.js');
  const themes = getThemes();

  if (!themes.length) {
    body.innerHTML = _emptyHTML('🏷️', '尚無題材', '請至「設定掃描 → 題材」新增題材');
    return;
  }
  body.innerHTML = `
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
            ${(t.stocks || []).slice(0, 3).map(s => `<div class="m-tc-tag">${s.code}</div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;

  body.querySelectorAll('.m-tc').forEach(el => {
    el.addEventListener('click', () => {
      const t = themes[Number(el.dataset.themeIdx)];
      onOpenSheet?.({
        icon: t.emoji || '🏷️', title: t.name,
        sub: `${(t.stocks || []).length}檔`, mode: 'theme',
        activeTags: [], filterRows: [],
        sort: ['漲幅↓', '跌幅↑', '成交量'],
        stocks: (t.stocks || []).map(s => ({
          name: gcn?.(s.code) || s.name || s.code,
          code: s.code, price: null, pct: null, up: null,
        })),
      });
    });
  });
}

// ══════════════════════════════════════════
//  設定：妖股查詢（近期飆股 / 谷底翻身）
// ══════════════════════════════════════════
export async function renderSetup(body, deps) {
  let _scanType    = 'rocket';   // 'rocket' | 'valley'
  let _parsedStocks = [];

  body.innerHTML = `
    <!-- ① 類型選擇 -->
    <div class="m-s-section" style="padding-bottom:8px">
      <div class="m-s-label">① 掃描類型</div>
      <div class="mth-type-row">
        <button class="mth-type-btn active" data-type="rocket">
          <span class="mth-type-icon">🚀</span>
          <div>
            <div class="mth-type-label">近期飆股</div>
            <div class="mth-type-desc">主升段、強者恆強</div>
          </div>
        </button>
        <button class="mth-type-btn" data-type="valley">
          <span class="mth-type-icon">🌱</span>
          <div>
            <div class="mth-type-label">谷底翻身</div>
            <div class="mth-type-desc">跌深反彈、等待確認</div>
          </div>
        </button>
      </div>
    </div>

    <!-- ② 股價區間 -->
    <div class="m-s-section">
      <div class="m-s-label">② 價格區間（選填，帶入 Prompt）</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button class="mtr-preset-btn" data-min="0" data-max="50">50以下</button>
        <button class="mtr-preset-btn" data-min="0" data-max="100">100以下</button>
        <button class="mtr-preset-btn" data-min="0" data-max="300">300以下</button>
        <button class="mtr-preset-btn" data-min="0" data-max="500">500以下</button>
        <button class="mtr-preset-btn active" data-min="0" data-max="0">不限</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input id="mThPriceMin" type="number" class="m-phase-a-field" placeholder="最低" style="flex:1" inputmode="numeric">
        <span style="color:#3d444d;font-size:12px">—</span>
        <input id="mThPriceMax" type="number" class="m-phase-a-field" placeholder="最高" style="flex:1" inputmode="numeric">
        <span style="font-size:12px;color:#8b949e">元</span>
      </div>
    </div>

    <!-- ③ 複製 Prompt（大按鈕）-->
    <div class="m-run-wrap" style="padding-bottom:0">
      <button class="m-run-btn mtr-copy-big-btn" id="mThCopyBtn">
        📋 複製 Prompt 給 AI
      </button>
      <div style="text-align:center;font-size:11px;color:#3d444d;margin-top:6px">
        複製後貼給 Gemini / ChatGPT，把 JSON 貼回下方
      </div>
    </div>

    <!-- ④ JSON 貼入 -->
    <div class="m-s-section" style="padding-top:14px">
      <div class="m-s-label">④ 貼上 AI 回覆的 JSON</div>
      <textarea id="mThJsonInput"
        style="width:100%;min-height:96px;background:#0d1117;border:0.5px solid #30363d;border-radius:9px;
               padding:10px 12px;font-size:12px;color:#e6edf3;font-family:monospace;resize:vertical;box-sizing:border-box"
        placeholder='[{ "code": "2330", "name": "台積電", "reason": "..." }]'></textarea>
      <div id="mThParseResult" style="font-size:12px;color:#8b949e;min-height:16px;margin-top:4px"></div>
    </div>

    <!-- ⑤ 預覽（先隱藏）-->
    <div id="mThPreviewWrap" style="display:none" class="m-s-section">
      <div class="m-s-label">預覽 <span id="mThPreviewCount"></span></div>
      <div id="mThPreviewList" class="m-result-list"></div>
    </div>

    <!-- ⑥ 執行 -->
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mThParseBtn">解析並預覽</button>
    </div>`;

  // ── 類型切換 ──────────────────────────────────────────────────
  body.querySelectorAll('.mth-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.mth-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _scanType = btn.dataset.type;
      _parsedStocks = [];
      body.querySelector('#mThPreviewWrap').style.display = 'none';
      body.querySelector('#mThJsonInput').value = '';
      body.querySelector('#mThParseResult').textContent = '';
      body.querySelector('#mThParseBtn').textContent = '解析並預覽';
    });
  });

  // ── Preset 股價 ──────────────────────────────────────────────
  body.querySelectorAll('.mtr-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.mtr-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      body.querySelector('#mThPriceMin').value = btn.dataset.min || '';
      body.querySelector('#mThPriceMax').value = btn.dataset.max || '';
    });
  });
  ['#mThPriceMin', '#mThPriceMax'].forEach(sel => {
    body.querySelector(sel)?.addEventListener('input', () => {
      body.querySelectorAll('.mtr-preset-btn').forEach(b => b.classList.remove('active'));
    });
  });

  // ── 複製 Prompt ──────────────────────────────────────────────
  body.querySelector('#mThCopyBtn')?.addEventListener('click', () => {
    const priceMin = parseFloat(body.querySelector('#mThPriceMin')?.value) || 0;
    const priceMax = parseFloat(body.querySelector('#mThPriceMax')?.value) || 0;
    const txt = _scanType === 'rocket'
      ? _buildRocketPrompt(priceMin, priceMax)
      : _buildValleyPrompt(priceMin, priceMax);
    navigator.clipboard?.writeText(txt).then(() => {
      const btn = body.querySelector('#mThCopyBtn');
      if (btn) { btn.textContent = '✓ 已複製'; setTimeout(() => { btn.textContent = '📋 複製 Prompt 給 AI'; }, 2000); }
    }).catch(() => deps.showToast?.('請長按複製'));
  });

  // ── 解析並預覽 ────────────────────────────────────────────────
  body.querySelector('#mThParseBtn')?.addEventListener('click', async () => {
    const raw = body.querySelector('#mThJsonInput')?.value.trim() || '';
    const resultEl = body.querySelector('#mThParseResult');
    const parseBtn = body.querySelector('#mThParseBtn');

    if (!raw) {
      if (resultEl) { resultEl.textContent = '請先貼上 JSON'; resultEl.style.color = '#fca5a5'; }
      return;
    }

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

    // 股名修正 + 代號驗證
    const nameCache = window.__nameCache ?? new Map();
    let invalidCodes = [];
    _parsedStocks = parsed.map(s => {
      const code    = String(s.code ?? s['代號'] ?? '').trim();
      const aiName  = String(s.name ?? s['股名'] ?? s['名稱'] ?? '').trim();
      const reason  = String(s.reason ?? s['理由'] ?? '').trim();
      if (!code) return null;
      const realName = nameCache.get(code) || getChineseName(code)
                     || (window.__priceCache ?? {})[code]?.name || aiName;
      if (!realName) { invalidCodes.push(code); return null; }
      return { code, name: realName, reason };
    }).filter(Boolean);

    if (!_parsedStocks.length) {
      if (resultEl) { resultEl.textContent = '所有代號均無效，請確認格式'; resultEl.style.color = '#fca5a5'; }
      return;
    }

    // 股價區間過濾
    const priceMin = parseFloat(body.querySelector('#mThPriceMin')?.value) || 0;
    const priceMax = parseFloat(body.querySelector('#mThPriceMax')?.value) || Infinity;
    let priceFiltered = 0;
    if (priceMax < Infinity || priceMin > 0) {
      const before = _parsedStocks.length;
      _parsedStocks = _parsedStocks.filter(s => {
        const p = (window.__priceCache ?? {})[s.code]?.price;
        return p == null || (p >= priceMin && p <= priceMax);
      });
      priceFiltered = before - _parsedStocks.length;
    }

    if (!_parsedStocks.length) {
      if (resultEl) { resultEl.textContent = `所有股票都超出價格區間（過濾 ${priceFiltered} 檔）`; resultEl.style.color = '#fca5a5'; }
      return;
    }

    // 訊號掃描（signals_cache → 3天內有 X 訊號標記）
    if (parseBtn) { parseBtn.disabled = true; parseBtn.textContent = '掃描妖股訊號…'; }
    if (resultEl) { resultEl.textContent = `掃描中… 0/${_parsedStocks.length}`; resultEl.style.color = ''; }

    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let xTagged = 0;

    try {
      const { getAllSignalsCache } = await import('../db.js');
      const { scanOneCode } = await import('../signal-scan.js');
      const allCache = await getAllSignalsCache().catch(() => []);

      for (const [i, s] of _parsedStocks.entries()) {
        if (resultEl) resultEl.textContent = `掃描中… ${i + 1}/${_parsedStocks.length}`;
        try {
          const cached = allCache.find(r => r.code === s.code);
          const isFresh = cached && (now - (cached.scannedAt ?? 0)) < THREE_DAYS;
          const sigs = isFresh
            ? (cached.signals ?? [])
            : await Promise.race([
                scanOneCode(s.code, { silent: true }),
                new Promise(res => setTimeout(() => res([]), 5000)),
              ]);
          const x1 = sigs.some(sg => sg.id === 'X1');
          const x2 = sigs.some(sg => sg.id === 'X2');
          const x5 = sigs.some(sg => sg.id === 'X5');
          if (x1 || x2 || x5) {
            s._sigs = { x1, x2, x5, strongest: x2 ? 'X2' : x1 ? 'X1' : 'X5' };
            xTagged++;
          }
        } catch(e) {}
      }
    } catch(e) {}

    // 結果摘要
    const msgs = [`✓ 找到 ${_parsedStocks.length} 檔`];
    if (invalidCodes.length)  msgs.push(`無效代號剔除 ${invalidCodes.length} 筆`);
    if (priceFiltered)        msgs.push(`價格過濾 ${priceFiltered} 檔`);
    if (xTagged)              msgs.push(`🚀 ${xTagged} 檔有 X 訊號`);
    if (resultEl) { resultEl.textContent = msgs.join('，'); resultEl.style.color = '#86efac'; }
    if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = '重新解析'; }

    _renderPreview(body, deps, _parsedStocks, _scanType);
  });
}

// ── 預覽列表 ──────────────────────────────────────────────────
function _renderPreview(body, deps, stocks, scanType) {
  const wrap  = body.querySelector('#mThPreviewWrap');
  const list  = body.querySelector('#mThPreviewList');
  const count = body.querySelector('#mThPreviewCount');
  if (!wrap || !list) return;

  wrap.style.display = '';
  if (count) count.textContent = `（${stocks.length} 檔）`;

  list.innerHTML = stocks.map((s, i) => {
    const p = (window.__priceCache ?? {})[s.code];
    const chgPct = p?.chgPct ?? p?.changePercent;
    const isUp   = (chgPct ?? 0) >= 0;
    const clr    = isUp ? '#ef5350' : '#26a69a';
    const sg     = s._sigs;
    const pills  = sg ? [
      sg.x2 ? `<span class="th-yaogu-pill th-yaogu-pill--x2">X2</span>` : '',
      sg.x1 ? `<span class="th-yaogu-pill th-yaogu-pill--x1">X1</span>` : '',
      sg.x5 ? `<span class="th-yaogu-pill th-yaogu-pill--x5">X5</span>` : '',
    ].join('') : '';

    return `
      <div class="m-rc" style="position:relative">
        <div class="m-rc-info">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="m-rc-name">${_esc(s.name)}</span>
            <span class="m-rc-code">${s.code}</span>
            ${pills}
          </div>
          ${s.reason ? `<div style="font-size:11px;color:#8b949e;margin-top:3px">${_esc(s.reason)}</div>` : ''}
        </div>
        <div class="m-rc-r" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          ${chgPct != null ? `<div class="m-rc-pct ${isUp ? 'm-up-bg' : 'm-dn-bg'}">${isUp ? '+' : ''}${Number(chgPct).toFixed(2)}%</div>` : ''}
          <button class="mth-del-btn" data-i="${i}"
            style="background:none;border:none;color:#3d444d;font-size:13px;cursor:pointer;padding:2px 6px">✕</button>
        </div>
      </div>`;
  }).join('');

  // 刪除個別
  list.querySelectorAll('.mth-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      stocks.splice(+btn.dataset.i, 1);
      _renderPreview(body, deps, stocks, scanType);
    });
  });

  // 儲存為題材按鈕（追加在預覽下方）
  const saveWrap = document.createElement('div');
  saveWrap.className = 'm-run-wrap';
  saveWrap.innerHTML = `<button class="m-run-btn" id="mThSaveBtn">
    ${scanType === 'rocket' ? '🚀' : '🌱'} 存為題材
  </button>`;
  list.appendChild(saveWrap);

  list.querySelector('#mThSaveBtn')?.addEventListener('click', async () => {
    if (!stocks.length) return;
    const isRocket = scanType === 'rocket';
    try {
      const { saveUserTheme } = await import('../theme.js');
      const data = {
        id:       'th_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        emoji:    isRocket ? '🚀' : '🌱',
        name:     isRocket ? '近期飆股掃描' : '谷底翻身觀察',
        desc:     isRocket
          ? 'AI 掃描近期主升段強勢股，技術面 + 量能雙確認'
          : 'AI 掃描跌深反彈訊號股，等待底部確認進場',
        color:    isRocket ? 'red' : 'green',
        order:    window.__themeData?.themes?.length ?? 0,
        stocks:   stocks.map(s => ({ code: s.code, name: s.name, reason: s.reason })),
        _yaoguType: scanType,
      };
      await saveUserTheme(data);
      deps.showToast?.(`✓ 已存為題材「${data.name}」`);
      deps.onClose?.();
      deps.onDone?.('theme');
    } catch(e) {
      deps.showToast?.('儲存失敗：' + e.message);
    }
  });
}

// ── 工具 ─────────────────────────────────────────────────────
function _emptyHTML(icon, title, desc) {
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
