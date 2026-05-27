// js/stock-info.js
// ============================================================================
// Advanced 2 + Advanced 3 — 個股補充資訊
//   A2：Prompt 匯入系統 + 過期偵測
//   A3：自動抓 Firestore（月營收/EPS/除息）整合進卡片顯示
// ============================================================================

import { loadStockInfo, saveStockInfo, deleteStockInfo } from './db.js';
import { fsGetShared } from './firebase.js';
import { dengToast }   from './loading-deng.js';

let _containerEl   = null;
let _currentCode   = null;

export function initStockInfo() {
  _containerEl = document.getElementById('stockinfoContent');
  document.querySelectorAll('.stock-tab[data-stock-tab="stockinfo"]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (_currentCode) renderStockInfo(_currentCode);
    });
  });
}

export function setStockInfoCode(code) {
  _currentCode = code;
  const panel = document.getElementById('stockinfoPanel');
  if (panel?.classList.contains('active')) renderStockInfo(code);
}

export async function renderStockInfo(code) {
  if (!_containerEl || !code) return;
  _currentCode = code;

  // ── 顯示載入中 ─────────────────────────────────────────────────────────────
  _containerEl.innerHTML = `<div class="si-loading">⏳ 載入中…</div>`;

  // ── 並行讀取：本地 Prompt 資料 + Firestore 自動資料 ───────────────────────
  const [info, autoData] = await Promise.all([
    loadStockInfo(code),
    _loadAutoData(code),
  ]);

  _render(code, info, autoData);
}

// ============================================================================
// Advanced 3：從 Firestore 讀取自動抓取資料
// ============================================================================

async function _loadAutoData(code) {
  const result = { revenue: null, eps: null, dividend: null };
  try {
    const [revenue, eps, dividend] = await Promise.allSettled([
      fsGetShared(`stocks/${code}/revenue`),
      fsGetShared(`stocks/${code}/eps`),
      fsGetShared(`stocks/${code}/dividend`),
    ]);

    if (revenue.status === 'fulfilled' && revenue.value) {
      result.revenue = revenue.value;
    }
    if (eps.status === 'fulfilled' && eps.value) {
      result.eps = eps.value;
    }
    if (dividend.status === 'fulfilled' && dividend.value) {
      result.dividend = dividend.value;
    }
  } catch (e) {
    console.warn('[stock-info] autoData load failed:', code, e.message);
  }
  return result;
}

// ============================================================================
// 過期偵測（Prompt 匯入的資料）
// ============================================================================

function _checkExpiry(info) {
  if (!info) return [];
  const warnings  = [];
  const today     = new Date().toISOString().slice(0, 10);
  const savedAt   = info.savedAt || 0;
  const daysSince = Math.floor((Date.now() - savedAt) / 86400000);

  if (info.meetingDate && info.meetingDate < today) {
    warnings.push({ field: 'meetingDate', msg: '法說會已過期，建議重新更新' });
  }
  if (info.exdivDate && info.exdivDate < today) {
    warnings.push({ field: 'exdivDate', msg: '除息日已過，建議更新' });
  }
  if ((info.analystRating || info.targetPrice) && daysSince > 30) {
    warnings.push({ field: 'analyst', msg: `法人評等資料已 ${daysSince} 天，建議更新` });
  }
  if (info.eps && Object.keys(info.eps).length > 0 && daysSince > 100) {
    warnings.push({ field: 'eps', msg: `EPS 資料已 ${daysSince} 天，建議更新` });
  }
  if ((info.peRatio || info.pbRatio || info.dividendYield) && daysSince > 30) {
    warnings.push({ field: 'valuation', msg: `估值資料已 ${daysSince} 天，建議更新` });
  }
  return warnings;
}

function _renderExpiryBanners(warnings, code) {
  if (!warnings.length) return '';
  return warnings.map(w => `
    <div class="si-expiry-banner" data-field="${w.field}">
      <span class="si-expiry-icon">⚠️</span>
      <span class="si-expiry-msg">${w.msg}</span>
      <button class="si-expiry-btn" data-expiry-code="${code}">更新 Prompt</button>
      <button class="si-expiry-close" data-close-field="${w.field}">✕</button>
    </div>`).join('');
}

// ============================================================================
// 主渲染
// ============================================================================

function _render(code, info, autoData) {
  if (!_containerEl) return;

  const hasManual  = info && Object.keys(info).filter(k => k !== 'code' && k !== 'savedAt').length > 0;
  const hasAuto    = autoData.revenue?.data?.length > 0 ||
                     autoData.eps?.data?.length > 0 ||
                     autoData.dividend?.data?.length > 0;
  const savedAt    = info?.savedAt ? new Date(info.savedAt).toLocaleString('zh-TW') : null;
  const warnings   = _checkExpiry(info);

  _containerEl.innerHTML = `
    <div class="si-panel">
      ${_renderExpiryBanners(warnings, code)}

      <div class="si-header">
        <div class="si-title">📋 ${code} 個股資訊</div>
        ${savedAt ? `<div class="si-saved-at">手動資料：${savedAt}</div>` : ''}
      </div>

      ${hasAuto ? _renderAutoSection(autoData) : ''}

      ${hasManual ? _renderInfoCards(info) : `
        <div class="si-empty">
          <div class="si-empty-icon">📭</div>
          <div class="si-empty-text">尚未手動補充資訊</div>
          <div class="si-empty-hint">法說會日期、法人評等等請透過下方 Prompt 補充</div>
        </div>`}

      <div class="si-actions">
        <div class="si-step">
          <div class="si-step-num">1</div>
          <div class="si-step-content">
            <div class="si-step-title">產生 Prompt</div>
            <div class="si-step-desc">複製後貼給你的 AI（ChatGPT / Claude）</div>
            <button class="si-btn si-btn-primary" id="siBtnGenPrompt">📋 複製 Prompt</button>
          </div>
        </div>
        <div class="si-step">
          <div class="si-step-num">2</div>
          <div class="si-step-content">
            <div class="si-step-title">貼上 AI 回傳的 JSON</div>
            <textarea class="si-json-input" id="siJsonInput"
              placeholder='貼上 AI 回傳的 JSON' rows="8"></textarea>
            <div class="si-btn-row">
              <button class="si-btn si-btn-primary" id="siBtnImport">✅ 匯入</button>
              ${hasManual ? `<button class="si-btn si-btn-danger" id="siBtnDelete">🗑 清除</button>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('siBtnGenPrompt')?.addEventListener('click', () => _copyPrompt(code));
  document.getElementById('siBtnImport')?.addEventListener('click', () => _importJSON(code));
  document.getElementById('siBtnDelete')?.addEventListener('click', () => _deleteInfo(code));

  _containerEl.querySelectorAll('.si-expiry-btn').forEach(btn => {
    btn.addEventListener('click', () => _copyPrompt(btn.dataset.expiryCode));
  });
  _containerEl.querySelectorAll('.si-expiry-close').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.si-expiry-banner')?.remove());
  });
}

// ============================================================================
// Advanced 3：自動資料區塊渲染
// ============================================================================

function _renderAutoSection(autoData) {
  const sections = [];

  // ── 月營收 ──────────────────────────────────────────────────────────────────
  if (autoData.revenue?.data?.length > 0) {
    const rows = [...autoData.revenue.data]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 6);

    const updatedAt = autoData.revenue.updatedAt
      ? new Date(autoData.revenue.updatedAt).toLocaleDateString('zh-TW')
      : '';

    const tableRows = rows.map(r => {
      const yoyCls = r.yoy > 0 ? 'si-up' : r.yoy < 0 ? 'si-down' : '';
      const momCls = r.mom > 0 ? 'si-up' : r.mom < 0 ? 'si-down' : '';
      return `<tr>
        <td>${r.date?.slice(0, 7) ?? ''}</td>
        <td>${_formatRevenue(r.revenue)}</td>
        <td class="${yoyCls}">${r.yoy != null ? (r.yoy > 0 ? '+' : '') + r.yoy.toFixed(1) + '%' : '-'}</td>
        <td class="${momCls}">${r.mom != null ? (r.mom > 0 ? '+' : '') + r.mom.toFixed(1) + '%' : '-'}</td>
      </tr>`;
    }).join('');

    sections.push(`
      <div class="si-auto-section">
        <div class="si-auto-title">
          📈 月營收
          <span class="si-auto-badge auto">🤖 自動更新</span>
          ${updatedAt ? `<span class="si-auto-date">${updatedAt}</span>` : ''}
        </div>
        <table class="si-table">
          <thead><tr><th>月份</th><th>營收</th><th>年增率</th><th>月增率</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`);
  }

  // ── EPS ─────────────────────────────────────────────────────────────────────
  if (autoData.eps?.data?.length > 0) {
    const rows = [...autoData.eps.data]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8);

    const updatedAt = autoData.eps.updatedAt
      ? new Date(autoData.eps.updatedAt).toLocaleDateString('zh-TW')
      : '';

    const tableRows = rows.map(r => {
      const cls = r.eps > 0 ? 'si-up' : r.eps < 0 ? 'si-down' : '';
      return `<tr>
        <td>${r.quarter ?? r.date?.slice(0, 7) ?? ''}</td>
        <td class="${cls}">${r.eps != null ? '$' + r.eps.toFixed(2) : '-'}</td>
      </tr>`;
    }).join('');

    sections.push(`
      <div class="si-auto-section">
        <div class="si-auto-title">
          💰 EPS（近期財報）
          <span class="si-auto-badge auto">🤖 自動更新</span>
          ${updatedAt ? `<span class="si-auto-date">${updatedAt}</span>` : ''}
        </div>
        <table class="si-table">
          <thead><tr><th>季度</th><th>EPS</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`);
  }

  // ── 除息/除權 ───────────────────────────────────────────────────────────────
  if (autoData.dividend?.data?.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const rows  = [...autoData.dividend.data]
      .filter(r => r.exdivDate || r.exrightDate)
      .slice(0, 5);

    const updatedAt = autoData.dividend.updatedAt
      ? new Date(autoData.dividend.updatedAt).toLocaleDateString('zh-TW')
      : '';

    const divRows = rows.map(r => {
      const date  = r.exdivDate || r.exrightDate || '';
      const daysLeft = date ? Math.round((new Date(date) - new Date(today)) / 86400000) : null;
      const urgency  = daysLeft != null && daysLeft >= 0 && daysLeft <= 14 ? 'si-warn-row' : '';
      const type     = r.exdivDate ? '除息' : '除權';
      return `<tr class="${urgency}">
        <td>${date}</td>
        <td>${type}</td>
        <td>${r.cashDiv > 0 ? '$' + r.cashDiv : '-'}</td>
        <td>${daysLeft != null && daysLeft >= 0 ? `${daysLeft} 天後` : daysLeft != null ? '已過' : '-'}</td>
      </tr>`;
    }).join('');

    sections.push(`
      <div class="si-auto-section">
        <div class="si-auto-title">
          📅 除息/除權
          <span class="si-auto-badge auto">🤖 自動更新</span>
          ${updatedAt ? `<span class="si-auto-date">${updatedAt}</span>` : ''}
        </div>
        <table class="si-table">
          <thead><tr><th>日期</th><th>類型</th><th>現金股利</th><th>距今</th></tr></thead>
          <tbody>${divRows}</tbody>
        </table>
      </div>`);
  }

  if (!sections.length) return '';
  return `<div class="si-auto-wrapper">${sections.join('')}</div>`;
}

function _formatRevenue(v) {
  if (v == null) return '-';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '億';
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '萬';
  return v.toString();
}

// ============================================================================
// 手動 Prompt 資料卡片（A2 原版）
// ============================================================================

function _renderInfoCards(info) {
  const cards = [];
  const today = new Date().toISOString().slice(0, 10);

  if (info.exdivDate || info.exrightDate) {
    const nearest  = [info.exdivDate, info.exrightDate].filter(Boolean).sort()[0];
    const daysLeft = nearest ? Math.round((new Date(nearest) - new Date(today)) / 86400000) : null;
    const urgency  = daysLeft != null && daysLeft >= 0 && daysLeft <= 7 ? 'warn' : '';
    cards.push(`<div class="si-card ${urgency}">
      <div class="si-card-title">📅 除息/除權（手動補充）</div>
      ${info.exdivDate   ? `<div class="si-card-row">除息：${info.exdivDate}${daysLeft != null && daysLeft >= 0 ? ` <span class="si-days">(${daysLeft}天後)</span>` : ''}</div>` : ''}
      ${info.exrightDate ? `<div class="si-card-row">除權：${info.exrightDate}</div>` : ''}
    </div>`);
  }

  if (info.meetingDate) {
    const daysLeft = Math.round((new Date(info.meetingDate) - new Date(today)) / 86400000);
    const urgency  = daysLeft >= 0 && daysLeft <= 7 ? 'warn' : '';
    cards.push(`<div class="si-card ${urgency}">
      <div class="si-card-title">🎤 法說會</div>
      <div class="si-card-row">${info.meetingDate} ${daysLeft >= 0 ? `<span class="si-days">(${daysLeft}天後)</span>` : '(已過)'}</div>
    </div>`);
  }

  if (info.eps && Object.keys(info.eps).length > 0) {
    const rows = Object.entries(info.eps)
      .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 4)
      .map(([q, v]) => `<div class="si-card-row"><span>${q}</span><span class="${v >= 0 ? 'si-up' : 'si-down'}">$${v}</span></div>`)
      .join('');
    cards.push(`<div class="si-card"><div class="si-card-title">💰 EPS（手動補充）</div>${rows}</div>`);
  }

  if (info.analystRating || info.targetPrice) {
    const cls = info.analystRating === '買進' ? 'si-up' : info.analystRating === '賣出' ? 'si-down' : '';
    cards.push(`<div class="si-card">
      <div class="si-card-title">🏦 法人評等</div>
      ${info.analystRating ? `<div class="si-card-row">評等：<span class="${cls}">${info.analystRating}</span></div>` : ''}
      ${info.targetPrice   ? `<div class="si-card-row">目標價：$${info.targetPrice}</div>` : ''}
    </div>`);
  }

  if (info.peRatio || info.pbRatio || info.dividendYield) {
    cards.push(`<div class="si-card">
      <div class="si-card-title">📊 估值參考</div>
      ${info.peRatio       ? `<div class="si-card-row">本益比：${info.peRatio}x</div>` : ''}
      ${info.pbRatio       ? `<div class="si-card-row">股淨比：${info.pbRatio}x</div>` : ''}
      ${info.dividendYield ? `<div class="si-card-row">殖利率：${info.dividendYield}%</div>` : ''}
    </div>`);
  }

  if (info.note) {
    cards.push(`<div class="si-card"><div class="si-card-title">📝 備註</div><div class="si-card-note">${info.note}</div></div>`);
  }

  return cards.length ? `<div class="si-cards">${cards.join('')}</div>` : '';
}

// ============================================================================
// Prompt 複製
// ============================================================================

function _copyPrompt(code) {
  const prompt = `請提供台股 ${code} 的最新資訊，以下列 JSON 格式回覆，不確定的欄位填 null：

{
  "code": "${code}",
  "meetingDate": null,
  "analystRating": null,
  "targetPrice": null,
  "peRatio": null,
  "pbRatio": null,
  "dividendYield": null,
  "note": ""
}

（月營收、EPS、除息資料系統已自動抓取，Prompt 只需法說會日期、法人評等、估值、備註）
只回覆 JSON，不要其他說明文字。`;

  navigator.clipboard.writeText(prompt).then(() => {
    dengToast('Prompt 已複製！貼給你的 AI 吧 ~', { mood: 'happy', duration: 3000 });
  }).catch(() => {
    const ta = document.getElementById('siJsonInput');
    if (ta) { ta.value = prompt; ta.select(); }
    dengToast('請手動複製上方文字', { mood: 'curious', duration: 3000 });
  });
}

// ============================================================================
// JSON 匯入 / 刪除
// ============================================================================

async function _importJSON(code) {
  const ta  = document.getElementById('siJsonInput');
  const raw = ta?.value?.trim();
  if (!raw) { dengToast('請先貼上 JSON ~', { mood: 'curious', duration: 2500 }); return; }

  let parsed;
  try {
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    dengToast('JSON 格式有誤，請確認後再試 ~', { mood: 'sad', duration: 3000 });
    return;
  }

  if (parsed.code && parsed.code !== code) parsed.code = code;
  await saveStockInfo(code, parsed);
  dengToast('資料已儲存！燈燈幫你記好了 ~', { mood: 'happy', duration: 3000 });
  renderStockInfo(code);
}

async function _deleteInfo(code) {
  if (!confirm(`確定要清除 ${code} 的手動補充資訊嗎？`)) return;
  await deleteStockInfo(code);
  dengToast('已清除 ~', { mood: 'curious', duration: 2000 });
  renderStockInfo(code);
}
