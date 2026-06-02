/**
 * mobile-screener-track.js
 * 追蹤清單：結果渲染 + 設定
 */

export async function renderResult(body, deps) {
  const { getChineseName, onOpenSheet } = deps;
  const { listAll } = await import('../portfolio.js');
  const lists = listAll('watch');
  const total = lists.reduce((n,l) => n+(l.items||[]).length, 0);

  if (!total) {
    body.innerHTML = _emptyHTML('📋','尚無追蹤清單','請至「設定掃描 → 追蹤」新增');
    return;
  }
  let html = `<div class="m-last-scan">追蹤清單 <span>${total} 檔</span></div>`;
  lists.forEach(list => {
    if (!(list.items||[]).length) return;
    html += `<div class="m-last-scan" style="padding-top:6px">${_esc(list.name)}<span>${list.items.length}檔</span></div>
      <div class="m-result-list">
        ${list.items.map(item => `
          <div class="m-rc" data-code="${item.code}">
            <div class="m-rc-info">
              <div class="m-rc-name">${_esc(item.name||item.code)}</div>
              <div class="m-rc-code">${item.code}</div>
              ${item.note?`<div class="m-rc-code" style="color:#8b949e">${_esc(item.note)}</div>`:''}
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

export async function renderSetup(body, deps) {
  const { listAll, createList, watchAddCode } = await import('../portfolio.js');
  const lists = listAll('watch');

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">追蹤清單（${lists.length} 個）</div>
      ${lists.map(l=>`
        <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:#0d1117;border-radius:9px;border:0.5px solid #21262d;margin-bottom:6px">
          <span style="flex:1;font-size:13px;color:#e6edf3">${_esc(l.name)}</span>
          <span style="font-size:11px;color:#3d444d">${(l.items||[]).length}檔</span>
        </div>`).join('')}
      ${!lists.length?'<div style="color:#3d444d;font-size:13px;padding:12px 0;text-align:center">尚無清單</div>':''}
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mTrackRunBtn">載入追蹤清單</button>
    </div>`;

  body.querySelector('#mTrackRunBtn')?.addEventListener('click', () => {
    deps.onClose?.();
    deps.onDone?.('track');
  });
}

function _emptyHTML(icon, title, desc) {
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
