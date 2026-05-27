/**
 * analysis-ai-prompt.js  v2.0
 * 全視窗模式 — AI 深度分析框架
 *
 * export:
 *   renderAISection(modId, modName, icon, ev, extraData) → HTML string
 *   bindAIEvents()   ← refreshFullscreenAnalysis 每次渲染後呼叫
 *   loadAIResults(code) ← 全視窗開啟時預載該股所有 AI 快取
 */

import { AppState } from './state.js';
import {
  getAIAnalysis, setAIAnalysis,
  deleteAIAnalysis, getAllAIAnalysisByCode,
} from './db.js';

// ─────────────────────────────────────────────
// Prompt 產生器（v2 強化可靠性版）
// ─────────────────────────────────────────────

/**
 * 產生給 AI 的分析 prompt
 * v2 改進：
 *   1. 加入精確時間戳記（台灣時間）
 *   2. 明確要求 AI 基於數值推導，不憑感覺
 *   3. 風險段聚焦指標本身的結構性弱點
 *   4. 要求 AI 標明不確定性（而非給絕對預測）
 */
export function buildPrompt(modName, icon, ev, extraData = {}) {
  const code    = AppState.activeCode || '未知';
  const candles = AppState.lastCandles || [];
  const last    = candles[candles.length - 1];
  const price   = last?.close?.toFixed(2) ?? '—';
  const period  = AppState.period || '—';

  // 台灣時間時間戳記
  const now = new Date();
  const twTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const timestamp = twTime.toISOString().replace('T', ' ').substring(0, 19) + ' (台灣時間)';

  const sig = ev.signal
    ? `${ev.signal.icon} ${ev.signal.name}（${ev.signal.stars} 星）\n   說明：${ev.signal.desc}`
    : '無明確訊號';

  const items = (ev.items || [])
    .map(it => {
      const mark = it.ok === true ? '✅' : it.ok === false ? '❌' : '⏸';
      const text = (it.text || '').replace(/<[^>]+>/g, '');
      const sub  = it.sub
        ? `\n     └ ${it.sub.replace(/<[^>]+>/g, '')}`
        : '';
      return `  ${mark} ${text}${sub}`;
    })
    .join('\n');

  const extra = Object.entries(extraData)
    .filter(([, v]) => v != null && v !== '—')
    .map(([k, v]) => `  • ${k}：${v}`)
    .join('\n');

  return `【分析請求時間】${timestamp}
【股票】${code}（${period} 週期）｜收盤價 ${price} 元

━━━ ${icon} ${modName} 即時數據 ━━━

系統訊號：${sig}

條件判讀：
${items || '  （無詳細條件）'}

關鍵數值：
${extra || '  （無）'}

━━━ 請先完成以下推導（再開始撰寫分析）━━━

在撰寫分析前，請先在腦中完成以下計算，並將推導結果反映在分析內容中：
1. 各數值之間的「差距與比例」：例如現價與各支撐線的距離（元數與百分比）
2. 「當前狀態 vs 未來狀態」的趨勢方向：例如當前雲帶位置 vs 未來先行帶位置的變化方向
3. 訊號的「強度評估」：條件達成數量 / 總條件數，以及各條件的邊際強弱
4. 「若訊號失敗」的第一個徵兆會出現在哪個數值上

━━━ 分析要求 ━━━

你是台灣股市技術分析師，請根據以上客觀數據與推導結果進行分析。

注意事項（違反以下規則將嚴重影響分析可靠性）：
• 所有數字必須來自上方數據，嚴禁憑感覺填寫或使用未提供的數值
• 若訊號矛盾（例如部分條件不達標），必須如實指出，不得強行單一解讀
• 每個操作建議必須是「若...（條件）...則...（行動）」格式
• 停損、停利、觀察點位三者都要給出（不可只給其中一項）
• 潛在風險段：只討論「${modName}本身的結構性弱點」
  嚴禁填寫：地緣政治、黑天鵝、市場情緒、總體經濟等通用風險

請依以下格式回覆（繁體中文，語氣精準）：

## 技術態勢解讀
（3~4 行：完整說明各數值呈現的技術意涵，引用具體數字與計算結果）

## 短線操作（1~5 日）
• 多方情境（若...）：進場/加碼條件 + 目標價
• 空方情境（若...）：減碼/出場條件
• 停損設置：具體價位 + 技術意義

## 中線研判（2~4 週）
• 趨勢方向與主要支撐壓力
• 不確定性來源（具體說明，非泛泛而談）

## 三個關鍵技術點位
• 停損點：___元（說明技術意義，失守後影響）
• 停利/目標點：___元（說明依據）
• 觀察點：___元（說明觸發何種重新評估）

## 本指標潛在失準情境
（2個具體情境，每個說明：在什麼技術條件下 → 指標會出現什麼具體偏差）

字數控制在 400 字以內，數字具體，避免「可能」「或許」等模糊語言（確實不確定時除外）。`.trim();
}

// ─────────────────────────────────────────────
// HTML 渲染
// ─────────────────────────────────────────────

export function renderAISection(modId, modName, icon, ev, extraData = {}) {
  const prompt  = buildPrompt(modName, icon, ev, extraData);
  const domBase = `ai-${modId}`;

  return `
<div class="fs-ai-section" id="${domBase}-wrap" data-mod-id="${modId}">

  <div class="fs-ai-head">
    <span class="fs-ai-icon">🤖</span>
    <span class="fs-ai-title">AI 深度分析</span>
    <span class="fs-ai-sub" id="${domBase}-meta"></span>
  </div>

  <div class="fs-ai-result" id="${domBase}-result">
    <p class="fs-ai-placeholder">尚未分析 — 點「📋 複製 Prompt」後詢問 AI，拿到回覆點「📝 貼上」</p>
  </div>

  <div class="fs-ai-actions">
    <button class="fs-ai-btn fs-ai-copy"
      data-prompt="${_encodeAttr(prompt)}"
      data-dom-base="${domBase}">📋 複製 Prompt</button>
    <button class="fs-ai-btn fs-ai-paste-toggle"
      data-dom-base="${domBase}">📝 貼上 AI 回覆 ▾</button>
    <button class="fs-ai-btn fs-ai-edit"
      data-dom-base="${domBase}"
      style="display:none">✏️ 編輯</button>
    <button class="fs-ai-btn fs-ai-delete"
      data-dom-base="${domBase}"
      style="display:none">🗑 刪除</button>
  </div>

  <div class="fs-ai-paste-area" id="${domBase}-paste" style="display:none">
    <textarea class="fs-ai-textarea" id="${domBase}-ta"
      placeholder="將 AI 回覆貼在這裡，支援 Markdown（## 標題、- 清單、**粗體**）…"
      rows="7"></textarea>
    <button class="fs-ai-btn fs-ai-submit"
      data-dom-base="${domBase}"
      data-prompt="${_encodeAttr(prompt)}">✅ 儲存並顯示分析</button>
  </div>

</div>`.trim();
}

// ─────────────────────────────────────────────
// 預載快取（全視窗開啟時呼叫）
// ─────────────────────────────────────────────

/**
 * 讀取該股所有 AI 分析快取並渲染到對應區塊
 * 由 analysis-fullscreen.js 的 initFullscreenAnalysis 呼叫
 */
export async function loadAIResults(code) {
  if (!code) return;
  try {
    const all = await getAllAIAnalysisByCode(code, AppState.period);
    for (const [modId, record] of Object.entries(all)) {
      const domBase = `ai-${modId}`;
      const resultEl = document.getElementById(`${domBase}-result`);
      if (!resultEl || !record?.result) continue;
      _renderResult(domBase, record.result, record.savedAt);
    }
  } catch(e) {
    console.warn('[ai-prompt] loadAIResults failed:', e);
  }
}

// ─────────────────────────────────────────────
// 渲染 AI 結果（含 meta 時間 + 編輯/刪除 btn）
// ─────────────────────────────────────────────

function _renderResult(domBase, rawText, savedAt) {
  const resultEl = document.getElementById(`${domBase}-result`);
  if (!resultEl) return;

  const html = _mdToHtml(rawText);
  resultEl.innerHTML = `<div class="fs-ai-rendered">${html}</div>`;

  // meta：顯示儲存時間
  const metaEl = document.getElementById(`${domBase}-meta`);
  if (metaEl && savedAt) {
    const d = new Date(savedAt + 8 * 60 * 60 * 1000);
    const ts = d.toISOString().replace('T', ' ').substring(0, 16);
    metaEl.textContent = `上次分析：${ts} 台灣時間`;
  }

  // 顯示編輯/刪除按鈕
  const wrap = document.getElementById(`${domBase}-wrap`);
  wrap?.querySelector('.fs-ai-edit')  ?.style?.setProperty('display', '');
  wrap?.querySelector('.fs-ai-delete')?.style?.setProperty('display', '');
}

// ─────────────────────────────────────────────
// 事件綁定
// ─────────────────────────────────────────────

export function bindAIEvents() {
  // ── 複製 Prompt ──
  document.querySelectorAll('.fs-ai-copy:not([data-ai-bound])').forEach(btn => {
    btn.dataset.aiBound = '1';
    btn.addEventListener('click', () => {
      const prompt = decodeURIComponent(btn.dataset.prompt || '');
      if (!prompt) return;
      const _fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = prompt;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch(e){}
        document.body.removeChild(ta);
      };
      (navigator.clipboard?.writeText(prompt) ?? Promise.reject())
        .catch(_fallback)
        .finally(() => {
          const orig = btn.textContent;
          btn.textContent = '✅ 已複製！';
          setTimeout(() => { btn.textContent = orig; }, 1800);
        });
    });
  });

  // ── 切換貼上區 ──
  document.querySelectorAll('.fs-ai-paste-toggle:not([data-ai-bound])').forEach(btn => {
    btn.dataset.aiBound = '1';
    btn.addEventListener('click', () => {
      const db     = btn.dataset.domBase;
      const area   = document.getElementById(`${db}-paste`);
      if (!area) return;
      const show = area.style.display === 'none';
      area.style.display = show ? '' : 'none';
      btn.textContent = show ? '📝 收起 ▴' : '📝 貼上 AI 回覆 ▾';
      if (show) setTimeout(() => document.getElementById(`${db}-ta`)?.focus(), 60);
    });
  });

  // ── 儲存並顯示分析 ──
  document.querySelectorAll('.fs-ai-submit:not([data-ai-bound])').forEach(btn => {
    btn.dataset.aiBound = '1';
    btn.addEventListener('click', async () => {
      const db      = btn.dataset.domBase;
      const modId   = db.replace(/^ai-/, '');
      const ta      = document.getElementById(`${db}-ta`);
      const area    = document.getElementById(`${db}-paste`);
      if (!ta) return;
      const raw = ta.value.trim();
      if (!raw) {
        ta.style.borderColor = 'rgba(239,83,80,0.6)';
        setTimeout(() => { ta.style.borderColor = ''; }, 1200);
        return;
      }
      // 存進 IndexedDB
      const code   = AppState.activeCode || '';
      const prompt = decodeURIComponent(btn.dataset.prompt || '');
      try {
        await setAIAnalysis(code, modId, {
          prompt, result: raw, period: AppState.period || '',
        });
      } catch(e) {
        console.warn('[ai-prompt] setAIAnalysis failed:', e);
      }
      // 渲染
      _renderResult(db, raw, Date.now());
      // 收起貼上區
      if (area) area.style.display = 'none';
      const toggleBtn = document.querySelector(`.fs-ai-paste-toggle[data-dom-base="${db}"]`);
      if (toggleBtn) toggleBtn.textContent = '📝 貼上 AI 回覆 ▾';
      // 滾動到結果
      document.getElementById(`${db}-result`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  // ── 編輯：把已儲存的回覆放回 textarea ──
  document.querySelectorAll('.fs-ai-edit:not([data-ai-bound])').forEach(btn => {
    btn.dataset.aiBound = '1';
    btn.addEventListener('click', async () => {
      const db    = btn.dataset.domBase;
      const modId = db.replace(/^ai-/, '');
      const code  = AppState.activeCode || '';
      const area  = document.getElementById(`${db}-paste`);
      const ta    = document.getElementById(`${db}-ta`);
      if (!ta || !area) return;
      // 從 DB 讀回原文
      try {
        const rec = await getAIAnalysis(code, modId, AppState.period);
        if (rec?.result) ta.value = rec.result;
      } catch(e) {}
      // 展開貼上區
      area.style.display = '';
      ta.focus();
      const toggleBtn = document.querySelector(`.fs-ai-paste-toggle[data-dom-base="${db}"]`);
      if (toggleBtn) toggleBtn.textContent = '📝 收起 ▴';
    });
  });

  // ── 刪除 ──
  document.querySelectorAll('.fs-ai-delete:not([data-ai-bound])').forEach(btn => {
    btn.dataset.aiBound = '1';
    btn.addEventListener('click', async () => {
      if (!confirm('確定刪除此 AI 分析結果？')) return;
      const db    = btn.dataset.domBase;
      const modId = db.replace(/^ai-/, '');
      const code  = AppState.activeCode || '';
      try {
        await deleteAIAnalysis(code, modId, AppState.period);
      } catch(e) {
        console.warn('[ai-prompt] deleteAIAnalysis failed:', e);
      }
      // 還原到初始狀態
      const resultEl = document.getElementById(`${db}-result`);
      if (resultEl) {
        resultEl.innerHTML =
          '<p class="fs-ai-placeholder">尚未分析 — 點「📋 複製 Prompt」後詢問 AI，拿到回覆點「📝 貼上」</p>';
      }
      const metaEl = document.getElementById(`${db}-meta`);
      if (metaEl) metaEl.textContent = '';
      // 隱藏編輯/刪除按鈕
      const wrap = document.getElementById(`${db}-wrap`);
      wrap?.querySelector('.fs-ai-edit')  ?.style?.setProperty('display', 'none');
      wrap?.querySelector('.fs-ai-delete')?.style?.setProperty('display', 'none');
    });
  });
}

// ─────────────────────────────────────────────
// Markdown → HTML
// ─────────────────────────────────────────────

function _mdToHtml(text) {
  if (!text?.trim()) return '';
  const lines = text.split('\n');
  const out   = [];
  let inUL    = false;

  for (let line of lines) {
    line = line.trim();
    if (/^##\s+/.test(line)) {
      if (inUL) { out.push('</ul>'); inUL = false; }
      out.push(`<h3>${_inline(line.replace(/^##\s+/, ''))}</h3>`);
    } else if (/^[-*•]\s+/.test(line)) {
      if (!inUL) { out.push('<ul>'); inUL = true; }
      out.push(`<li>${_inline(line.replace(/^[-*•]\s+/, ''))}</li>`);
    } else if (!line) {
      if (inUL) { out.push('</ul>'); inUL = false; }
    } else {
      if (inUL) { out.push('</ul>'); inUL = false; }
      out.push(`<p>${_inline(line)}</p>`);
    }
  }
  if (inUL) out.push('</ul>');
  return out.join('');
}

function _inline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*元/g, '<span class="ai-price">$1 元</span>');
}

function _encodeAttr(str) {
  return encodeURIComponent(str);
}
