/**
 * mobile-screener-theme.js
 * 題材篩選：結果渲染 + 設定（新增題材）
 */

export async function renderResult(body, deps) {
  const { getChineseName, onOpenSheet } = deps;
  const { getThemes } = await import('../theme.js');
  const themes = getThemes();

  if (!themes.length) {
    body.innerHTML = _emptyHTML('🏷️','尚無題材','請至「設定掃描 → 題材」新增題材');
    return;
  }
  body.innerHTML = `
    <div class="m-last-scan">題材清單 <span>${themes.length} 個</span></div>
    <div class="m-theme-grid">
      ${themes.map((t,i) => `
        <div class="m-tc" data-theme-idx="${i}">
          <div class="m-tc-top">
            <div class="m-tc-emoji">${t.emoji||'🏷️'}</div>
            <div class="m-tc-cnt">${(t.stocks||[]).length}檔</div>
          </div>
          <div class="m-tc-name">${_esc(t.name)}</div>
          <div class="m-tc-desc">${_esc(t.desc||'')}</div>
          <div class="m-tc-tags">
            ${(t.stocks||[]).slice(0,3).map(s=>`<div class="m-tc-tag">${s.code}</div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;

  body.querySelectorAll('.m-tc').forEach(el => {
    el.addEventListener('click', () => {
      const t = themes[Number(el.dataset.themeIdx)];
      onOpenSheet?.({
        icon: t.emoji||'🏷️', title: t.name,
        sub: `${(t.stocks||[]).length}檔`, mode: 'theme',
        activeTags: [], filterRows: [],
        sort: ['漲幅↓','跌幅↑','成交量'],
        stocks: (t.stocks||[]).map(s=>({
          name: getChineseName?.(s.code)||s.name||s.code,
          code: s.code, price:null, pct:null, up:null,
        })),
      });
    });
  });
}

export async function renderSetup(body, deps) {
  const { onClose } = deps;
  const { getThemes, saveUserTheme } = await import('../theme.js');
  const themes = getThemes();

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">現有題材（${themes.length} 個）</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
        ${themes.map(t=>`
          <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:#0d1117;border-radius:9px;border:0.5px solid #21262d">
            <span style="font-size:16px">${t.emoji||'🏷️'}</span>
            <span style="flex:1;font-size:13px;color:#e6edf3">${_esc(t.name)}</span>
            <span style="font-size:11px;color:#3d444d">${(t.stocks||[]).length}檔</span>
          </div>`).join('')}
        ${!themes.length?'<div style="color:#3d444d;font-size:13px;padding:12px 0;text-align:center">尚無題材</div>':''}
      </div>
      <div class="m-ai-card">
        <div class="m-ai-title">🤖 AI 輔助新增題材</div>
        <div class="m-ai-desc">複製 Prompt → 貼給 AI → 把 JSON 貼回來</div>
        <div class="m-ai-btns">
          <button class="m-ai-btn m-ai-btn-copy" id="mThemeCopyBtn">📋 複製 Prompt</button>
          <button class="m-ai-btn m-ai-btn-paste" id="mThemePasteBtn">📥 貼上 JSON</button>
        </div>
      </div>
    </div>`;

  body.querySelector('#mThemeCopyBtn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mobileAiCopyPrompt'));
    deps.showToast?.('Prompt 已複製');
  });
  body.querySelector('#mThemePasteBtn')?.addEventListener('click', () => {
    const json = prompt('貼上 AI 回的 JSON：');
    if (json) document.dispatchEvent(new CustomEvent('mobileAiPasteJson', { detail:{ json } }));
  });
}

function _emptyHTML(icon, title, desc) {
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
