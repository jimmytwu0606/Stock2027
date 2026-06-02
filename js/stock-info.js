// js/stock-info.js
// ============================================================================
// Advanced 2 + Advanced 3 — 個股補充資訊
//   A2：Prompt 匯入系統 + 過期偵測
//   A3：自動抓 Firestore（月營收/EPS/除息）整合進卡片顯示
// ============================================================================

import { loadStockInfo, saveStockInfo, deleteStockInfo } from './db.js';
import { fsGetShared } from './firebase.js';
import { dengToast }   from './loading-deng.js';
import { fetchVerifyData } from './api.js';

let _containerEl   = null;
let _currentCode   = null;

export function initStockInfo() {
  _containerEl = document.getElementById('stockinfoContent');
  document.querySelectorAll('.stock-tab[data-stock-tab="stockinfo"]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (_currentCode) renderStockInfo(_currentCode);
    });
  });

  // ── 注入 verify banner CSS ─────────────────────────────────────────────────
  if (!document.getElementById('si-verify-style')) {
    const s = document.createElement('style');
    s.id = 'si-verify-style';
    s.textContent = `
      .si-src-label {
        font-size:10px;color:#8a8f99;opacity:.8;margin-left:5px;
      }
      .si-src-missing {
        font-size:10px;color:#ef5350;opacity:.8;margin-left:5px;
      }
      .si-moat {
        background:rgba(251,191,36,.06);border:0.5px solid rgba(251,191,36,.2);
        border-radius:6px;padding:8px 10px;margin-bottom:8px;
        font-size:12px;color:#e8eaed;line-height:1.5;
      }
      .si-risk-row {
        display:flex;align-items:center;gap:6px;margin:8px 0;
      }
      .si-risk-label { font-size:11px;color:#8a8f99; }
      .si-risk-bars  { display:flex;gap:3px; }
      .si-risk-bar   { width:16px;height:5px;border-radius:2px; }
      .si-verify-banner {
        display:flex;align-items:flex-start;gap:8px;
        padding:8px 12px;border-radius:6px;margin-bottom:8px;
        font-size:12px;line-height:1.5;
      }
      .si-verify-banner.si-verify-warn {
        background:rgba(245,158,11,.1);border:0.5px solid rgba(245,158,11,.35);color:#f59e0b;
      }
      .si-verify-banner.si-verify-error {
        background:rgba(239,83,80,.1);border:0.5px solid rgba(239,83,80,.35);color:#ef5350;
      }
      .si-verify-msg { flex:1; }
      .si-verify-banner button {
        flex-shrink:0;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;
        background:rgba(255,255,255,.08);border:0.5px solid rgba(255,255,255,.15);color:#e8eaed;
        white-space:nowrap;
      }
      .si-verify-banner .si-expiry-close {
        background:none;border:none;color:inherit;opacity:.6;font-size:12px;padding:0 2px;
      }
    `;
    document.head.appendChild(s);
  }
}

export function setStockInfoCode(code) {
  _currentCode = code;
  const panel = document.getElementById('stockinfoPanel');
  if (panel?.classList.contains('active')) renderStockInfo(code);
}

export async function renderStockInfo(code) {
  // 每次 render 都重新取 DOM，避免 tab display:none 時 init 拿到 null
  _containerEl = document.getElementById('stockinfoContent');
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
  _containerEl = _containerEl || document.getElementById('stockinfoContent');
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
      ${_renderVerifyBanner(info, code)}

      <div class="si-header">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="si-title">📋 ${code} 個股資訊</div>
          ${hasManual ? `<button class="si-verify-now-btn" data-code="${code}"
            style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:4px;
                   background:rgba(255,255,255,.06);border:0.5px solid rgba(255,255,255,.15);
                   color:#8a8f99;font-size:11px;cursor:pointer;white-space:nowrap"
            title="與 FinMind 即時比對數字">
            <span class="si-verify-dot" style="width:7px;height:7px;border-radius:50%;background:#8a8f99;display:inline-block;flex-shrink:0"></span>
            即時比對
          </button>` : ''}
        </div>
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

  // ── 即時比對按鈕 ────────────────────────────────────────────────────────────
  _containerEl.querySelectorAll('.si-verify-now-btn').forEach(btn => {
    btn.addEventListener('click', () => _runLiveVerify(btn, btn.dataset.code));
  });
}

// ============================================================================
// Advanced 3：自動資料區塊渲染
// ============================================================================

function __renderAutoSection(autoData) {
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

function __renderInfoCards(info) {
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
    const tpSrc = (info.sources || []).find(s => s.field === 'targetPrice');
    const srcLabel = info.targetPriceSrc || (tpSrc ? `${tpSrc.src}${tpSrc.date?' '+tpSrc.date.slice(5):''}` : null);
    cards.push(`<div class="si-card">
      <div class="si-card-title">🏦 法人評等</div>
      ${info.analystRating ? `<div class="si-card-row">評等：<span class="${cls}">${info.analystRating}</span></div>` : ''}
      ${info.targetPrice ? `<div class="si-card-row">目標價：$${info.targetPrice}
        ${srcLabel ? `<span class="si-src-label">${srcLabel}</span>` : `<span class="si-src-missing">⚠️ 來源不明</span>`}
      </div>` : ''}
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

  // ── 前瞻面分析（forward）──────────────────────────────────────────────────
  if (info.forward && (info.forward.story || info.forward.drivers?.length || info.forward.consensus)) {
    const f = info.forward;
    const driversHtml = (f.drivers || []).map(d =>
      `<div class="si-forward-item si-forward-bull">
        <span class="si-forward-dot" style="background:#ef5350"></span>${d}
      </div>`
    ).join('');
    const risksHtml = (f.risks || []).map(r =>
      `<div class="si-forward-item si-forward-bear">
        <span class="si-forward-dot" style="background:#26a69a"></span>${r}
      </div>`
    ).join('');
    const epsHtml = (f.epsEstNext || f.epsEstYear2) ? `
      <div class="si-forward-eps-row">
        ${f.epsEstNext  ? `<div class="si-forward-eps-item"><div class="si-forward-eps-label">法人 EPS 預估（明年）</div><div class="si-forward-eps-val">${f.epsEstNext} 元</div></div>` : ''}
        ${f.epsEstYear2 ? `<div class="si-forward-eps-item"><div class="si-forward-eps-label">法人 EPS 預估（後年）</div><div class="si-forward-eps-val">${f.epsEstYear2} 元</div></div>` : ''}
      </div>` : '';
    const updatedHtml = f.updatedAt ? `<div class="si-forward-updated">資料截止：${f.updatedAt}</div>` : '';

    // riskScore bar
    const riskBar = f.riskScore != null ? (() => {
      const rColor = f.riskScore<=2?'#26a69a':f.riskScore<=3?'#f59e0b':'#ef5350';
      const rLabel = f.riskScore<=2?'偏低':f.riskScore<=3?'中等':f.riskScore<=4?'偏高':'高風險';
      const bars = [1,2,3,4,5].map(i =>
        `<div class="si-risk-bar" style="background:${i<=f.riskScore?rColor:'rgba(255,255,255,.1)'}"></div>`).join('');
      return `<div class="si-risk-row"><span class="si-risk-label">綜合風險</span><div class="si-risk-bars">${bars}</div><span style="font-size:11px;color:${rColor}">${rLabel}</span></div>`;
    })() : '';

    const catalystsHtml = (f.catalysts?.length) ? `
      <div class="si-forward-section-title" style="color:#f59e0b;margin-top:10px">⚡ 近期催化劑</div>
      ${f.catalysts.map(c => `<div class="si-forward-item"><span class="si-forward-dot" style="background:#f59e0b"></span>${c}</div>`).join('')}` : '';

    const moatHtml = f.moat ? `<div class="si-moat">🏰 ${f.moat}</div>` : '';

    cards.push(`<div class="si-card si-card-forward">
      <div class="si-card-title">🔭 前瞻面分析</div>
      ${f.story ? `<div class="si-forward-story">${f.story}</div>` : ''}
      ${moatHtml}
      ${epsHtml}
      ${driversHtml || risksHtml ? `
        <div class="si-forward-grid">
          ${driversHtml ? `<div><div class="si-forward-section-title" style="color:#ef5350">成長動能</div>${driversHtml}</div>` : ''}
          ${risksHtml  ? `<div><div class="si-forward-section-title" style="color:#26a69a">主要風險</div>${risksHtml}</div>`  : ''}
        </div>` : ''}
      ${catalystsHtml}
      ${riskBar}
      ${f.consensus ? `<div class="si-forward-consensus"><span class="si-forward-consensus-label">燈燈整合觀點</span>${f.consensus}</div>` : ''}
      ${updatedHtml}
    </div>`);
  }

  if (info.sources?.length > 0) {
    const srcRows = info.sources.map(s =>
      `<div class="si-card-row" style="display:flex;gap:6px;font-size:11px">
        <span style="color:#8a8f99;min-width:90px;flex-shrink:0">${s.field}</span>
        <span>${s.src ?? '—'}</span>
        ${s.date ? `<span style="margin-left:auto;color:#8a8f99">${s.date}</span>` : ''}
      </div>`).join('');
    cards.push(`<div class="si-card"><div class="si-card-title">🔗 資料來源</div>${srcRows}</div>`);
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
  "targetPriceSrc": null,
  "peRatio": null,
  "pbRatio": null,
  "dividendYield": null,
  "note": "",
  "forward": {
    "story": null,
    "drivers": [],
    "risks": [],
    "epsEstNext": null,
    "epsEstNextConf": null,
    "epsEstYear2": null,
    "epsEstYear2Conf": null,
    "catalysts": [],
    "moat": null,
    "riskScore": null,
    "consensus": null,
    "updatedAt": null
  },
  "sources": []
}

欄位說明：
- meetingDate：最新法說會日期（YYYY-MM-DD）
- analystRating：法人評等（買進 / 中立 / 賣出）
- targetPrice：法人目標價（數字，元）
- targetPriceSrc：目標價來源（例：「摩根士丹利 2026-05-15」），不確定填 null
- forward.story：市場現在在賭的核心故事，一句話說清楚
- forward.drivers：成長動能，條列式，3-5點
- forward.risks：主要風險，條列式，2-4點
- forward.epsEstNext：下一年度 EPS 共識預估（元）
- forward.epsEstNextConf：EPS 預估信心度（high / mid / low）
- forward.epsEstYear2：後年度 EPS 共識預估（元）
- forward.epsEstYear2Conf：後年度 EPS 預估信心度（high / mid / low）
- forward.catalysts：近期重大催化劑／時程，條列式，2-4點
- forward.moat：競爭護城河，一句話
- forward.riskScore：綜合風險評級 1-5（1最低風險，5最高風險）
- forward.consensus：整體評估一句話結論
- forward.updatedAt：資料截止日期（YYYY-MM-DD）
- sources：每個有來源的欄位獨立標記，格式 { "field": "欄位名", "src": "來源名稱", "date": "YYYY-MM-DD" }

（月營收、EPS、除息資料系統已自動抓取，Prompt 只需上方欄位）
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
// JSON 驗證層
// ============================================================================

/**
 * 結構 + 數值合理性驗證（純前端，無網路）
 * 回傳 { errors: [], warnings: [] }
 * errors   → 阻擋存入（必修）
 * warnings → 提示但允許存入（黃色警示）
 */
function _validateStructure(parsed, code) {
  const errors   = [];
  const warnings = [];
  const today    = new Date().toISOString().slice(0, 10);

  // code 必須一致
  if (parsed.code && parsed.code !== code) {
    errors.push(`代號不符：JSON 是 ${parsed.code}，當前股票是 ${code}`);
  }

  // 數值合理範圍
  const pb = parseFloat(parsed.pbRatio);
  if (parsed.pbRatio != null && (!isFinite(pb) || pb <= 0 || pb > 100)) {
    warnings.push(`股淨比 ${parsed.pbRatio} 超出合理範圍（0.1 ~ 100），請確認`);
  }

  const dy = parseFloat(parsed.dividendYield);
  if (parsed.dividendYield != null && (!isFinite(dy) || dy < 0 || dy > 30)) {
    warnings.push(`殖利率 ${parsed.dividendYield}% 超出合理範圍（0 ~ 30%），請確認`);
  }

  const pe = parseFloat(parsed.peRatio);
  if (parsed.peRatio != null && (!isFinite(pe) || pe < 0 || pe > 5000)) {
    warnings.push(`本益比 ${parsed.peRatio} 超出合理範圍，請確認`);
  }

  // forward 欄位驗證
  const f = parsed.forward;
  if (f) {
    // updatedAt 格式 + 不超過今天
    if (f.updatedAt) {
      const isDateFmt = /^\d{4}-\d{2}-\d{2}$/.test(f.updatedAt);
      if (!isDateFmt) {
        warnings.push(`forward.updatedAt 格式有誤（應為 YYYY-MM-DD），收到：${f.updatedAt}`);
      } else if (f.updatedAt > today) {
        warnings.push(`forward.updatedAt（${f.updatedAt}）是未來日期，請確認`);
      }
    }

    // drivers / risks 應為陣列
    if (f.drivers != null && !Array.isArray(f.drivers)) {
      errors.push('forward.drivers 應為陣列格式');
    }
    if (f.risks != null && !Array.isArray(f.risks)) {
      errors.push('forward.risks 應為陣列格式');
    }

    // epsEst 應為數字
    if (f.epsEstNext != null && typeof f.epsEstNext !== 'number') {
      warnings.push(`forward.epsEstNext 應為數字，收到：${f.epsEstNext}`);
    }
    if (f.epsEstYear2 != null && typeof f.epsEstYear2 !== 'number') {
      warnings.push(`forward.epsEstYear2 應為數字，收到：${f.epsEstYear2}`);
    }
  }

  return { errors, warnings };
}

/**
 * 過期偵測（針對已存入的舊資料）
 * 回傳 { stale: bool, msg: string }[]
 */
function _detectStaleForward(info) {
  const staleItems = [];
  if (!info?.forward) return staleItems;
  const f = info.forward;
  const today = new Date().toISOString().slice(0, 10);

  if (f.updatedAt) {
    const days = Math.floor((Date.now() - new Date(f.updatedAt).getTime()) / 86400000);
    if (days > 60) {
      staleItems.push({ field: 'forward', days, msg: `前瞻資料已 ${days} 天未更新（截止：${f.updatedAt}），市場情況可能已大幅改變` });
    } else if (days > 30) {
      staleItems.push({ field: 'forward', days, msg: `前瞻資料已 ${days} 天（截止：${f.updatedAt}），建議重新確認` });
    }
  } else if (f.story || f.consensus) {
    // 有前瞻內容但沒有 updatedAt，無法判斷新鮮度
    staleItems.push({ field: 'forward_no_date', days: null, msg: '前瞻資料缺少截止日期，無法判斷是否過期，建議重新更新' });
  }
  return staleItems;
}

/**
 * 渲染驗證狀態列（用於 _render 時顯示舊資料提醒）
 */
function _renderVerifyBanner(info, code) {
  const staleItems = _detectStaleForward(info);
  if (!staleItems.length) return '';

  return staleItems.map(item => {
    const urgency = item.days == null || item.days > 60 ? 'si-verify-error' : 'si-verify-warn';
    const icon    = item.days == null || item.days > 60 ? '🔴' : '🟡';
    return `
      <div class="si-verify-banner ${urgency}">
        <span class="si-verify-icon">${icon}</span>
        <span class="si-verify-msg">${item.msg}</span>
        <button class="si-expiry-btn" data-expiry-code="${code}">重新更新 Prompt</button>
        <button class="si-expiry-close" data-close-field="${item.field}">✕</button>
      </div>`;
  }).join('');
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

  // ── 結構驗證 ──────────────────────────────────────────────────────────────
  const { errors, warnings } = _validateStructure(parsed, code);

  if (errors.length) {
    dengToast('匯入失敗：' + errors[0], { mood: 'sad', duration: 4000 });
    // 在輸入框下方顯示錯誤
    const existingErr = document.getElementById('siImportErrors');
    if (existingErr) existingErr.remove();
    const errDiv = document.createElement('div');
    errDiv.id = 'siImportErrors';
    errDiv.style.cssText = 'margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(239,83,80,.12);border:0.5px solid rgba(239,83,80,.4);font-size:12px;color:#ef5350';
    errDiv.innerHTML = errors.map(e => `❌ ${e}`).join('<br>');
    document.getElementById('siJsonInput')?.insertAdjacentElement('afterend', errDiv);
    return;
  }

  // ── 清理 code ────────────────────────────────────────────────────────────
  if (parsed.code && parsed.code !== code) parsed.code = code;

  // ── FinMind 交叉比對 ──────────────────────────────────────────────────────
  dengToast('正在向 FinMind 驗證數字…', { mood: 'curious', duration: 2000 });
  const crossResult = await _crossCheck(code, parsed);
  const allWarnings = [...warnings, ...crossResult.warnings];

  // 差距過大 → 阻擋存入
  if (crossResult.errors.length) {
    const existingErr = document.getElementById('siImportErrors');
    if (existingErr) existingErr.remove();
    const errDiv = document.createElement('div');
    errDiv.id = 'siImportErrors';
    errDiv.style.cssText = 'margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(239,83,80,.12);border:0.5px solid rgba(239,83,80,.4);font-size:12px;color:#ef5350;line-height:1.7';
    errDiv.innerHTML = crossResult.errors.map(e => `❌ ${e}`).join('<br>');
    document.getElementById('siJsonInput')?.insertAdjacentElement('afterend', errDiv);
    dengToast('FinMind 數據不符，請確認後再試', { mood: 'sad', duration: 4000 });
    return;
  }

  // 有警告 → confirm 後繼續
  if (allWarnings.length) {
    const warnMsg = allWarnings.map(w => `⚠️ ${w}`).join('\n');
    if (!confirm(`注意以下項目：\n\n${warnMsg}\n\n確定仍要存入嗎？`)) return;
  }

  // ── 附加驗證元資料後存入 ─────────────────────────────────────────────────
  parsed._verify = {
    checkedAt : new Date().toISOString().slice(0, 10),
    warnings  : allWarnings,
    source    : 'ai_prompt',
    finmind   : crossResult.finmindValues,
  };

  await saveStockInfo(code, parsed);
  dengToast(
    allWarnings.length ? `已儲存（${allWarnings.length} 項提醒請留意）~` : '資料已儲存！燈燈幫你記好了 ~',
    { mood: allWarnings.length ? 'curious' : 'happy', duration: 3000 }
  );
  renderStockInfo(code);
}

// ============================================================================
// FinMind 交叉比對
// ============================================================================

/**
 * 拿 FinMind TaiwanStockPER 最新值，與 AI 給的 pe / pbRatio / dividendYield 比對
 * 容差：
 *   pbRatio      差距 > 0.5  → error（明顯錯誤）
 *   dividendYield 差距 > 1%  → error
 *   peRatio      差距 > 10   → warning（PE 波動大，僅提醒）
 * 無 token / API 失敗 → 跳過（回傳空結果）
 */
async function _crossCheck(code, parsed) {
  const errors        = [];
  const warnings      = [];
  let   finmindValues = null;

  try {
    const fm = await fetchVerifyData(code);
    if (!fm) return { errors, warnings, finmindValues };  // 無 token，跳過

    finmindValues = fm;

    // ── pbRatio ──────────────────────────────────────────────────────────────
    if (parsed.pbRatio != null && fm.pbRatio != null) {
      const aiPB = parseFloat(parsed.pbRatio);
      const diff  = Math.abs(aiPB - fm.pbRatio);
      if (diff > 0.5) {
        errors.push(`股淨比差距過大：AI 給 ${aiPB}，FinMind 實際 ${fm.pbRatio}（差 ${diff.toFixed(2)}）`);
      } else if (diff > 0.2) {
        warnings.push(`股淨比略有偏差：AI ${aiPB} vs FinMind ${fm.pbRatio}（差 ${diff.toFixed(2)}）`);
      }
    }

    // ── dividendYield ─────────────────────────────────────────────────────────
    if (parsed.dividendYield != null && fm.dividendYield != null) {
      const aiDY = parseFloat(parsed.dividendYield);
      const diff  = Math.abs(aiDY - fm.dividendYield);
      if (diff > 1.0) {
        errors.push(`殖利率差距過大：AI 給 ${aiDY}%，FinMind 實際 ${fm.dividendYield}%（差 ${diff.toFixed(2)}%）`);
      } else if (diff > 0.5) {
        warnings.push(`殖利率略有偏差：AI ${aiDY}% vs FinMind ${fm.dividendYield}%（差 ${diff.toFixed(2)}%）`);
      }
    }

    // ── peRatio（僅 warning，PE 本身波動大）───────────────────────────────────
    if (parsed.peRatio != null && fm.pe != null) {
      const aiPE = parseFloat(parsed.peRatio);
      const diff  = Math.abs(aiPE - fm.pe);
      if (diff > 10) {
        warnings.push(`本益比偏差較大：AI 給 ${aiPE}，FinMind 實際 ${fm.pe}（差 ${diff.toFixed(1)}）`);
      }
    }

  } catch (e) {
    console.warn('[_crossCheck] 驗證失敗，跳過：', e.message);
  }

  return { errors, warnings, finmindValues };
}

// ============================================================================
// 即時比對（title 旁按鈕觸發）
// ============================================================================

async function _runLiveVerify(btn, code) {
  const dot   = btn.querySelector('.si-verify-dot');
  const label = btn.querySelector('span:not(.si-verify-dot)') || btn;

  // ── 確保 pulse 動畫存在 ──────────────────────────────────────────────────
  if (!document.getElementById('si-dot-anim')) {
    const s = document.createElement('style');
    s.id = 'si-dot-anim';
    s.textContent = `@keyframes si-dot-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }`;
    document.head.appendChild(s);
  }

  // ── 無 token → 直接告知，不靜默 ────────────────────────────────────────
  const { getFinMindToken } = await import('./config.js');
  if (!getFinMindToken()) {
    _showVerifyPopup(btn, [], [], null, 'no_token');
    return;
  }

  // ── 取已存資料 ────────────────────────────────────────────────────────────
  const info = await loadStockInfo(code);
  if (!info) {
    _showVerifyPopup(btn, ['尚無已存資料'], [], null, 'error');
    return;
  }

  // ── 按鈕載入中狀態 ────────────────────────────────────────────────────────
  btn.disabled = true;
  if (dot) { dot.style.background = '#8a8f99'; dot.style.animation = 'si-dot-pulse 1s infinite'; }

  try {
    const result   = await _crossCheck(code, info);
    const hasError = result.errors.length > 0;
    const hasWarn  = result.warnings.length > 0;
    const fm       = result.finmindValues;

    if (dot) dot.style.animation = '';
    btn.disabled = false;

    // ── 無法取得 FinMind 資料（API 失敗）────────────────────────────────────
    if (!fm) {
      dot && (dot.style.background = '#8a8f99');
      btn.style.color = '#8a8f99';
      _showVerifyPopup(btn, [], [], null, 'api_fail');
      return;
    }

    if (hasError) {
      dot && (dot.style.background = '#ef5350');
      btn.style.color = '#ef5350';
      btn.style.borderColor = 'rgba(239,83,80,.4)';
      _showVerifyPopup(btn, result.errors, result.warnings, fm, 'error');
    } else if (hasWarn) {
      dot && (dot.style.background = '#f59e0b');
      btn.style.color = '#f59e0b';
      btn.style.borderColor = 'rgba(245,158,11,.4)';
      _showVerifyPopup(btn, [], result.warnings, fm, 'warn');
    } else {
      dot && (dot.style.background = '#26a69a');
      btn.style.color = '#26a69a';
      btn.style.borderColor = 'rgba(38,166,154,.35)';
      _showVerifyPopup(btn, [], [], fm, 'ok');
    }
  } catch (e) {
    if (dot) dot.style.animation = '';
    btn.disabled = false;
    console.error('[_runLiveVerify]', e);
    _showVerifyPopup(btn, [`比對失敗：${e.message}`], [], null, 'error');
  }
}

/** 比對結果小 popup（點按鈕旁邊浮出） */
function _showVerifyPopup(anchorBtn, errors, warnings, fm, level) {
  document.getElementById('siVerifyPopup')?.remove();

  // 特殊狀態
  if (level === 'no_token') {
    _showVerifyPopupRaw(anchorBtn,
      '<div style="color:#f59e0b">⚠️ 需要 FinMind Token 才能比對</div>' +
      '<div style="font-size:11px;color:#8a8f99;margin-top:4px">請在設定頁填入 FinMind Token</div>',
      'rgba(245,158,11,.1)', 'rgba(245,158,11,.3)');
    return;
  }
  if (level === 'api_fail') {
    _showVerifyPopupRaw(anchorBtn,
      '<div style="color:#8a8f99">⚠️ FinMind API 無回應</div>' +
      '<div style="font-size:11px;color:#8a8f99;margin-top:4px">請確認網路或稍後再試</div>',
      'rgba(255,255,255,.05)', 'rgba(255,255,255,.12)');
    return;
  }

  const bg     = level === 'error' ? 'rgba(239,83,80,.12)'  : level === 'warn' ? 'rgba(245,158,11,.1)' : 'rgba(38,166,154,.08)';
  const border = level === 'error' ? 'rgba(239,83,80,.4)'   : level === 'warn' ? 'rgba(245,158,11,.35)' : 'rgba(38,166,154,.3)';
  const color  = level === 'error' ? '#ef5350'               : level === 'warn' ? '#f59e0b' : '#26a69a';

  const lines = [];
  errors.forEach(e  => lines.push(`❌ ${e}`));
  warnings.forEach(w => lines.push(`⚠️ ${w}`));
  if (!lines.length) lines.push('✅ FinMind 數字比對正常');

  if (fm) {
    const fmItems = [];
    if (fm.pbRatio != null)      fmItems.push(`PB ${fm.pbRatio}`);
    if (fm.dividendYield != null) fmItems.push(`殖利率 ${fm.dividendYield}%`);
    if (fm.pe != null)            fmItems.push(`PE ${fm.pe}`);
    if (fmItems.length) lines.push(`FinMind 實際：${fmItems.join(' · ')}`);
  }

  const popup = document.createElement('div');
  popup.id = 'siVerifyPopup';
  popup.style.cssText = `position:absolute;z-index:9999;background:#161b22;border:0.5px solid ${border};
    border-radius:8px;padding:10px 14px;font-size:12px;color:${color};line-height:1.7;
    box-shadow:0 4px 20px rgba(0,0,0,.5);max-width:300px;white-space:normal;`;
  popup.innerHTML = lines.map(l => `<div>${l}</div>`).join('');

  // 定位到按鈕下方
  document.body.appendChild(popup);
  const rect = anchorBtn.getBoundingClientRect();
  popup.style.top  = `${rect.bottom + window.scrollY + 6}px`;
  popup.style.left = `${Math.max(8, rect.left + window.scrollX - 40)}px`;

  // 點其他地方關閉
  const close = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorBtn) {
      popup.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}

function _showVerifyPopupRaw(anchorBtn, html, bg, border) {
  document.getElementById('siVerifyPopup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'siVerifyPopup';
  popup.style.cssText = `position:fixed;z-index:99999;background:#161b22;border:0.5px solid ${border};
    border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.7;
    box-shadow:0 4px 20px rgba(0,0,0,.5);max-width:300px;`;
  popup.innerHTML = html;
  document.body.appendChild(popup);
  const rect = anchorBtn.getBoundingClientRect();
  popup.style.top  = `${rect.bottom + 6}px`;
  popup.style.left = `${Math.max(8, Math.min(rect.left - 40, window.innerWidth - 320))}px`;
  const close = (e) => {
    if (!popup.contains(e.target) && e.target !== anchorBtn) {
      popup.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}

async function _deleteInfo(code) {
  if (!confirm(`確定要清除 ${code} 的手動補充資訊嗎？`)) return;
  await deleteStockInfo(code);
  dengToast('已清除 ~', { mood: 'curious', duration: 2000 });
  renderStockInfo(code);
}
