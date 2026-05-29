/**
 * modal-strategy.js — 策略選股 Modal
 * 新增追蹤清單的「策略選股」Tab 邏輯
 * 由 main.js 的 initModalAdd 呼叫 initStrategyModal() 啟動
 */

import { STRATEGIES } from './strategy.js';
import { scanOneCode } from './signal-scan.js';
import { AppState } from './state.js';
import { getChineseName } from './api.js';

// ── condId → Gemini 看得懂的中文描述對照表 ───────────────────
const COND_DESC = {
  // 趨勢
  'above_ma20':              () => '股價站上 MA20（月線）之上',
  'below_ma20':              () => '股價跌破 MA20（月線）之下',
  'ma20_rising':             v => `MA20 連續 ${v} 天向上`,
  'ma20_declining':          v => `MA20 連續 ${v} 天向下`,
  'ma20_turn_up':            () => 'MA20 由跌轉揚（轉折向上）',
  'ma20_turn_down':          () => 'MA20 由揚轉跌（轉折向下）',
  'ma5_cross_ma20':          () => 'MA5 黃金交叉穿越 MA20',
  'ma_bear_array':           () => '均線空頭排列（短均在下、長均在上）',
  'price_cross_ma20_up':     () => '股價剛由下往上突破 MA20',
  'price_cross_ma20_down':   () => '股價剛由上往下跌破 MA20',
  'price_reclaim_ma20':      () => '股價跌破 MA20 後又快速收回',
  'price_bounce_ma20':       () => '股價回測 MA20 後反彈',
  'price_rally_fail_ma20':   () => '股價反彈到 MA20 附近但失敗回落',
  'price_far_above_ma20':    v => `股價乖離 MA20 達 +${v}% 以上（超漲）`,
  'price_far_below_ma20':    v => `股價乖離 MA20 達 -${v}% 以下（超跌）`,
  'bias20_low':              v => `MA20 乖離率 ≤ ${v}%（深度超跌）`,

  // 動能（RSI/KD/MACD）
  'rsi_min':                 v => `RSI ≥ ${v}`,
  'rsi_max':                 v => `RSI ≤ ${v}`,
  'rsi_revival':             v => `RSI 從 30 以下反彈到 ≥ ${v}`,
  'kd_golden':               () => 'KD 出現黃金交叉',
  'kd_dead':                 () => 'KD 出現死亡交叉',
  'kd_k_min':                v => `K 值 ≥ ${v}`,
  'kd_k_max':                v => `K 值 ≤ ${v}`,
  'macd_golden':             () => 'MACD 出現黃金交叉',
  'macd_dead':               () => 'MACD 出現死亡交叉',
  'macd_dead_above_zero':    () => 'MACD 在零軸上方死叉（高位轉弱）',
  'macd_hist_pos':           () => 'MACD 柱狀體翻紅（正值）',

  // 量能
  'vol_min':                 v => `成交量 ≥ ${v} 張`,
  'vol_surge':               v => `今日量 ≥ 20 日均量 × ${v}`,
  'vol_surge_short':         v => `今日量 ≥ 10 日均量 × ${v}`,
  'vol_surge_long':          v => `今日量 ≥ 30 日均量 × ${v}`,
  'vol_surge_drop':          v => `下跌日量 ≥ 均量 × ${v}（量增價跌）`,
  'vol_shrink':              v => `成交量 ≤ 均量 × ${v}（量縮）`,

  // 漲跌
  'gain_10d':                v => `近 10 日累計漲幅 ≥ ${v}%`,
  'loss_5d':                 v => `近 5 日累計跌幅 ≥ ${v}%`,
  'drop_n_days':             v => `近期連續 ${v} 日下跌`,
  'chg_min':                 v => `今日漲幅 ≥ ${v}%`,
  'high_n_days':             v => `收盤為近 ${v} 日新高`,

  // 布林通道
  'bb_expanding':            () => '布林帶開口擴大（變動率上升）',
  'bb_squeeze':              () => '布林帶極度糾結（盤整待噴）',
  'bb_upper_touch':          () => '股價貼近或突破布林上軌',

  // K 線型態
  'bullish_engulfing':       () => '出現多頭吞噬（陽吞陰）',
  'three_soldiers':          () => '紅三兵（連續 3 根遞增陽線）',
  'three_peaks':             () => '三重頂（三山型態）',
  'three_valleys':           () => '三重底（三川型態）',
  'cup_and_handle':          () => '杯柄型態突破',

  // 一目均衡表
  'ichi_3good':              () => '一目均衡表三役好轉（轉換>基準 + 站上雲帶 + 延遲線突破）',
  'ichi_cloud_above':        () => '收盤站上雲帶上緣',
  'ichi_below_cloud':        () => '收盤跌破雲帶下緣',
  'ichi_bull_cloud':         () => '未來雲帶為多頭雲',
  'ichi_tk_cross':           () => '轉換線剛黃金交叉基準線（近 3 日內）',
  'ichi_tk_dead':            () => '轉換線死亡交叉基準線',
  'ichi_chikou_above':       () => '延遲線突破 26 日前股價',

  // 技術指標
  'dmi_bull':                () => '+DI > -DI（多頭趨勢）',
  'dmi_bear':                () => '-DI > +DI（空頭趨勢）',
  'dmi_strong':              v => `ADX > ${v}（趨勢明確強度）`,
  'sar_bull':                () => 'SAR 由空翻多',
  'gmma_bull':               () => 'GMMA 顧比均線多頭排列（短組穿越長組）',
  'ema_cross_up':            () => 'EMA5 新穿越 EMA20',
  'rci9_turn_up':            () => 'RCI(9) 從 -80 以下反彈向上',
  'psy_oversold':            v => `PSY 心理線 ≤ ${v}（超賣）`,
  'hv_low':                  v => `歷史波動率 ≤ ${v}（低波動潛伏）`,
  'industry_leading':        v => `同產業已有 ${v} 檔以上 RSI > 70（族群啟動）`,

  // 基本面
  'eps_positive':            () => '最新季 EPS 為正',
  'eps_turn_positive':       () => '前一季虧損，最新季轉為獲利',
  'eps_growth_yoy':          v => `EPS 年增率 ≥ ${v}%`,
  'eps_consecutive_growth':  v => `EPS 連續 ${v} 季正成長`,
  'revenue_growth_yoy':      v => `營收年增率 ≥ ${v}%`,
  'gross_margin_min':        v => `毛利率 ≥ ${v}%`,
  'net_margin_min':          v => `淨利率 ≥ ${v}%`,
  'pe_max':                  v => `本益比 (PE) ≤ ${v} 倍`,
  'pb_max':                  v => `股價淨值比 (PB) ≤ ${v} 倍`,
  'peg_max':                 v => `PEG ≤ ${v}（成長>本益）`,
  'div_yield_min':           v => `現金殖利率 ≥ ${v}%`,
  'foreign_buy_days':        v => `外資連續買超 ≥ ${v} 日`,

  // 價格範圍
  'price_max':               v => `股價 ≤ ${v} 元`,
  'price_min':               v => `股價 ≥ ${v} 元`,
};

function _condToChinese(c) {
  const fn = COND_DESC[c.condId];
  if (!fn) return `  - ${c.condId}${c.value != null ? `（值：${c.value}）` : ''}`;
  return `  - ${fn(c.value)}`;
}


// ── 狀態 ─────────────────────────────────────────────────────
let _msSelected = null;
let _msVerified = [];
let _msYaoguFound = [];  // 驗算過程中撿到的妖股（X1/X2/X5）
let _closeModal  = null;  // 由 initStrategyModal 注入
let _showToast   = null;  // 由 initStrategyModal 注入

const CATEGORY_ORDER = ['X 系列','強勢續漲','超跌反彈','轉折訊號','葛蘭碧','盤整突破','基本面','巴菲特','技術指標','K線型態','避險警示'];
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

// ── 公開 API ─────────────────────────────────────────────────

/**
 * initStrategyModal(closeModal, showToast)
 * main.js 的 initModalAdd 裡呼叫，注入 closeModal / showToast 函式
 */
export function initStrategyModal(closeModal, showToast) {
  _closeModal = closeModal;
  _showToast  = showToast;

  // 價格區間 preset
  document.querySelectorAll('.ms-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ms-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('msPriceMin').value = btn.dataset.min ?? '';
      document.getElementById('msPriceMax').value = btn.dataset.max ?? '';
    });
  });
  // 手動輸入時取消 preset active
  ['msPriceMin','msPriceMax'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      document.querySelectorAll('.ms-preset-btn').forEach(b => b.classList.remove('active'));
    });
  });

  // 複製 Prompt
  document.getElementById('msCopyPrompt')?.addEventListener('click', () => {
    if (!_msSelected) return;
    const priceMin = parseFloat(document.getElementById('msPriceMin')?.value) || 0;
    const priceMax = parseFloat(document.getElementById('msPriceMax')?.value) || 0;
    const txt = _buildStrategyPrompt(_msSelected, priceMin, priceMax);
    navigator.clipboard.writeText(txt).then(() => {
      const btn = document.getElementById('msCopyPrompt');
      if (!btn) return;
      btn.textContent = '✓ 已複製';
      setTimeout(() => { if (document.getElementById('msCopyPrompt')) btn.textContent = '複製 Prompt'; }, 2000);
    });
  });

  // 驗算並加入
  document.getElementById('msParseBtn')?.addEventListener('click', _verifyAndPreview);
}

/**
 * renderStrategyGrid()
 * Tab 切換到「策略選股」時呼叫，渲染策略卡片（只建一次）
 */
export function renderStrategyGrid() {
  const grid = document.getElementById('msStrategyGrid');
  if (!grid || grid.dataset.built === '1') return;
  grid.dataset.built = '1';

  const grouped = {};
  STRATEGIES.forEach(s => {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  });

  let html = '';
  CATEGORY_ORDER.forEach(cat => {
    const list = grouped[cat];
    if (!list?.length) return;
    const c = CATEGORY_COLOR[cat] ?? { bg:'rgba(107,114,128,0.1)', border:'rgba(107,114,128,0.4)', text:'#9ca3af' };
    html += `<div class="ms-cat-title" style="color:${c.text}">${cat}</div><div class="ms-cat-group">`;
    list.forEach(s => {
      html += `<button class="ms-strategy-btn" data-id="${s.id}"
        style="--ms-bg:${c.bg};--ms-border:${c.border};--ms-text:${c.text}">
        <span class="ms-s-icon">${s.icon}</span>
        <span class="ms-s-name">${s.name}</span>
        <span class="ms-s-desc">${s.desc}</span>
      </button>`;
    });
    html += `</div>`;
  });
  grid.innerHTML = html;

  grid.querySelectorAll('.ms-strategy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      _msSelected = STRATEGIES.find(s => s.id === id);
      if (!_msSelected) return;
      grid.querySelectorAll('.ms-strategy-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _showPromptStep();
    });
  });

  _rebuildGroupSelect();
}

// ── 內部函式 ─────────────────────────────────────────────────

function _rebuildGroupSelect() {
  const sel = document.getElementById('msGroupSelect');
  if (!sel) return;
  const groups = AppState.watchlistGroups ?? [];
  sel.innerHTML = groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
}

function _showPromptStep() {
  document.getElementById('msStepSelect').style.display = 'none';
  document.getElementById('msStepPrompt').style.display = '';
  _msVerified = [];
  document.getElementById('msPreviewList').innerHTML = '';
  document.getElementById('msParseResult').textContent = '';
  document.getElementById('msJsonInput').value = '';

  const s = _msSelected;
  const c = CATEGORY_COLOR[s.category] ?? { bg:'rgba(107,114,128,0.1)', border:'rgba(107,114,128,0.4)', text:'#9ca3af' };
  document.getElementById('msSelectedBar').innerHTML = `
    <div class="ms-selected-card" style="--ms-bg:${c.bg};--ms-border:${c.border};--ms-text:${c.text}">
      <span class="ms-s-icon">${s.icon}</span>
      <div>
        <div class="ms-s-name" style="color:${c.text}">${s.id} ${s.name}</div>
        <div class="ms-s-desc">${s.desc}</div>
      </div>
      <button class="ms-back-btn" id="msBackBtn">← 換策略</button>
    </div>`;

  document.getElementById('msBackBtn')?.addEventListener('click', () => {
    document.getElementById('msStepSelect').style.display = '';
    document.getElementById('msStepPrompt').style.display = 'none';
  });

  _rebuildGroupSelect();
}

async function _verifyAndPreview() {
  if (!_msSelected) return;
  const raw    = document.getElementById('msJsonInput').value.trim();
  const result = document.getElementById('msParseResult');
  if (!raw) { result.textContent = '請先貼上 JSON'; result.style.color = '#fca5a5'; return; }

  let parsed;
  try {
    const clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error('需要陣列格式');
  } catch(e) {
    result.textContent = `JSON 解析失敗：${e.message}`; result.style.color = '#fca5a5'; return;
  }

  // 股名修正 + 代號驗證
  const nameCache = window.__nameCache ?? new Map();
  let stocks = parsed.map(s => {
    const code   = String(s.code ?? s['代號'] ?? '').trim();
    const aiName = String(s.name ?? s['股名'] ?? s['名稱'] ?? '').trim();
    const realName = nameCache.get(code)
      || getChineseName(code)
      || (window.__priceCache ?? {})[code]?.name
      || aiName;
    if (!realName) return null;
    return { code, name: realName, reason: String(s.reason ?? s['理由'] ?? '').trim() };
  }).filter(Boolean);

  if (!stocks.length) {
    result.textContent = '所有代號均無效，請確認格式'; result.style.color = '#fca5a5'; return;
  }

  // 價格區間過濾
  const priceMin = parseFloat(document.getElementById('msPriceMin')?.value) || 0;
  const priceMax = parseFloat(document.getElementById('msPriceMax')?.value) || Infinity;
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
    result.textContent = `所有股票都超出價格區間（過濾 ${priceFiltered} 檔）`;
    result.style.color = '#fca5a5'; return;
  }

  result.textContent = `驗算中… 0/${stocks.length}${priceFiltered ? `（已過濾 ${priceFiltered} 檔）` : ''}`;
  result.style.color = '';
  _msVerified = [];
  _msYaoguFound = [];
  let passed = 0, failed = 0;

  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    try {
      const sigs = await scanOneCode(s.code, { silent: true });
      const hit  = sigs.some(sg => sg.id === _msSelected.id);
      if (hit) { _msVerified.push(s); passed++; }
      else failed++;

      // 撿妖股（不管當前策略是否命中，X1/X2/X5 都撿起來）
      const x1 = sigs.some(sg => sg.id === 'X1');
      const x2 = sigs.some(sg => sg.id === 'X2');
      const x5 = sigs.some(sg => sg.id === 'X5');
      if (x1 || x2 || x5) {
        _msYaoguFound.push({
          ...s,
          _sigs: { x1, x2, x5, strongest: x2?'X2':x1?'X1':'X5' }
        });
      }
    } catch(e) {
      console.warn(`[modal-strategy] 驗算失敗 ${s.code}:`, e.message);
      failed++;
    }
    result.textContent = `驗算中… ${i+1}/${stocks.length}（通過 ${passed} 檔）`;
  }

  const filterMsg = priceFiltered ? `，價格過濾 ${priceFiltered} 檔` : '';
  result.textContent = `✓ 通過 ${passed} 檔，未符合策略 ${failed} 檔${filterMsg}${_msYaoguFound.length ? `，🚨 撿到 ${_msYaoguFound.length} 檔妖股` : ''}`;
  result.style.color = passed > 0 ? '#86efac' : '#fca5a5';
  _renderPreview();

  // EVA 警告：找到妖股優先彈窗（不阻擋預覽渲染）
  if (_msYaoguFound.length) {
    setTimeout(() => _showYaoguAlert(), 300);
  }
}

function _renderPreview() {
  const list = document.getElementById('msPreviewList');
  if (!list) return;
  if (!_msVerified.length) {
    list.innerHTML = `<div class="ms-empty">無符合策略的個股<br><small>策略條件嚴格，可嘗試換一個策略或重新生成 Prompt</small></div>`;
    return;
  }

  list.innerHTML = `
    <div class="ms-preview-header">
      驗算通過 ${_msVerified.length} 檔
      <span class="ms-preview-hint">（已確認符合 ${_msSelected.icon} ${_msSelected.name} 策略）</span>
    </div>
    ${_msVerified.map(s => `
      <div class="ms-preview-row">
        <span class="ms-p-code">${s.code}</span>
        <span class="ms-p-name">${s.name}</span>
        <span class="ms-p-reason">${s.reason}</span>
        <button class="ms-p-del" data-code="${s.code}">✕</button>
      </div>`).join('')}
    <button class="ms-add-all-btn" id="msAddAllBtn">✓ 全部加入追蹤</button>`;

  list.querySelectorAll('.ms-p-del').forEach(btn => {
    btn.addEventListener('click', () => {
      _msVerified = _msVerified.filter(s => s.code !== btn.dataset.code);
      _renderPreview();
    });
  });

  document.getElementById('msAddAllBtn')?.addEventListener('click', _addToWatchlist);
}

async function _addToWatchlist() {
  const groupId = document.getElementById('msGroupSelect')?.value;
  const groups  = AppState.watchlistGroups ?? [];
  const group   = groups.find(g => g.id === groupId) ?? groups[0];
  if (!group) return;

  let added = 0;
  for (const s of _msVerified) {
    if (group.stocks?.some(st => st.code === s.code)) continue;
    group.stocks = [...(group.stocks ?? []), { code: s.code, name: s.name, note: s.reason }];
    added++;
  }

  const { saveGroup } = await import('./db.js');
  await saveGroup(group);
  document.dispatchEvent(new CustomEvent('watchlistUpdated'));
  _closeModal?.();
  _showToast?.(`✓ 加入 ${added} 檔到「${group.name}」`);
}

function _buildStrategyPrompt(strategy, priceMin = 0, priceMax = 0) {
  const condDesc = strategy.conditions?.map(_condToChinese).join('\n') ?? '';
  const priceCondition = priceMax > 0
    ? `\n【股價限制】只選股價在 ${priceMin} ~ ${priceMax} 元之間的個股，超出此區間的請勿列入`
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

// ── EVA 風格妖股警告 ────────────────────────────────────────
function _showYaoguAlert() {
  if (!_msYaoguFound.length) return;

  // 移除舊的（避免重複）
  document.getElementById('msYaoguAlert')?.remove();

  const html = `
    <div class="ms-yaogu-alert" id="msYaoguAlert">
      <div class="ms-yaogu-backdrop"></div>
      <div class="ms-yaogu-box">
        <div class="ms-yaogu-marquee">
          ⚠ WARNING ⚠ ANOMALY DETECTED ⚠ WARNING ⚠ YAOGU FOUND ⚠
          WARNING ⚠ ANOMALY DETECTED ⚠ WARNING ⚠ YAOGU FOUND ⚠
        </div>
        <div class="ms-yaogu-header">
          <div class="ms-yaogu-icon">⚠</div>
          <div class="ms-yaogu-title">
            <div class="ms-yaogu-title-main">妖股訊號偵測</div>
            <div class="ms-yaogu-title-sub">YAOGU PATTERN ANALYSIS COMPLETE</div>
          </div>
          <div class="ms-yaogu-icon">⚠</div>
        </div>
        <div class="ms-yaogu-stats">
          掃描過程中發現 <span class="ms-yaogu-num">${_msYaoguFound.length}</span> 檔具備妖股訊號
        </div>
        <div class="ms-yaogu-list">
          ${_msYaoguFound.map((s, i) => `
            <label class="ms-yaogu-item" data-code="${s.code}">
              <input type="checkbox" class="ms-yaogu-check" data-i="${i}" checked />
              <div class="ms-yaogu-pills">
                ${s._sigs.x2 ? '<span class="th-yaogu-pill th-yaogu-pill--x2">X2</span>' : ''}
                ${s._sigs.x1 ? '<span class="th-yaogu-pill th-yaogu-pill--x1">X1</span>' : ''}
                ${s._sigs.x5 ? '<span class="th-yaogu-pill th-yaogu-pill--x5">X5</span>' : ''}
              </div>
              <span class="ms-yaogu-code">${s.code}</span>
              <span class="ms-yaogu-name">${s.name}</span>
              <span class="ms-yaogu-reason">${s.reason}</span>
            </label>`).join('')}
        </div>
        <div class="ms-yaogu-actions">
          <button class="ms-yaogu-btn ms-yaogu-btn--skip" id="msYaoguSkip">忽略</button>
          <button class="ms-yaogu-btn ms-yaogu-btn--add" id="msYaoguAdd">⚡ 加入追蹤</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  const close = () => document.getElementById('msYaoguAlert')?.remove();

  document.getElementById('msYaoguSkip')?.addEventListener('click', close);
  document.querySelector('.ms-yaogu-backdrop')?.addEventListener('click', close);

  document.getElementById('msYaoguAdd')?.addEventListener('click', async () => {
    const checked = Array.from(document.querySelectorAll('.ms-yaogu-check'))
      .filter(c => c.checked)
      .map(c => _msYaoguFound[+c.dataset.i]);
    if (!checked.length) { close(); return; }

    // 把妖股直接加入當前追蹤清單
    try {
      const { getList, watchAddCode } = await import('./portfolio.js').catch(() => ({}));
      // portfolio.js 可能不存在，fallback：用全局 API
      const api = window.__portfolioAPI;
      if (api?.addToActive) {
        for (const s of checked) {
          await api.addToActive(s.code, s.name, s.reason || '妖股訊號');
        }
      } else {
        // 直接觸發 portfolio-ui 的批次新增邏輯
        document.dispatchEvent(new CustomEvent('msYaoguAddRequest', {
          detail: { stocks: checked }
        }));
      }
      _showToast?.(`⚡ 已加入 ${checked.length} 檔妖股到追蹤`);
    } catch(e) {
      console.warn('[ms-yaogu] 加入失敗:', e.message);
      _showToast?.('加入失敗，請查看 console');
    }
    close();
  });
}

