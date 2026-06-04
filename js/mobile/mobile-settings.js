/**
 * mobile-settings.js — Phase 10.3
 * 設定頁獨立模組：建立 panel + 渲染 + 事件綁定
 * mobile-nav.js 只呼叫 buildSettingsPanel()
 */

export function buildSettingsPanel() {
  document.getElementById('tabMobileSettings')?.remove();

  const panel = document.createElement('div');
  panel.id = 'tabMobileSettings';
  panel.className = 'tab-panel';
  panel.style.cssText = 'overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;width:100%;box-sizing:border-box;';
  document.querySelector('main.main')?.appendChild(panel);

  _render(panel);
  return panel;
}

export function renderIntoEl(el) {
  if (!el) return;
  _render(el);
}

function _render(panel) {
  const _radio  = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
  const _chk    = (id)   => document.getElementById(id)?.checked ?? false;
  const _selTxt = (id)   => { const el = document.getElementById(id); return el?.options[el.selectedIndex]?.text ?? ''; };
  const _range  = (id)   => document.getElementById(id)?.value ?? '';

  const dsVal  = _radio('dataSource')      || 'twse';
  const newsVal = _radio('newsSource')     || 'yahootw';
  const mobVal = _radio('mobileIndicator') || 'KD';
  const prdTxt = _selTxt('screenerPeriod') || '3 個月';
  const prxTxt = _selTxt('klineProxyMode') || '自動';
  const cncVal = _range('concurrencyVal')  || '5';

  const S   = (t) => `<div style="font-size:10px;color:#3d444d;letter-spacing:1px;text-transform:uppercase;padding:18px 16px 6px">${t}</div>`;
  const SEP = `<div style="height:0.5px;background:#21262d;margin:0 16px"></div>`;
  const INFO = (t, d='') => `<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:500;color:#e6edf3">${t}</div>${d?`<div style="font-size:11px;color:#8b949e;margin-top:2px">${d}</div>`:''}</div>`;
  const TOGGLE = (id, on) => `<div class="ms-toggle ${on?'on':''}" data-mod="${id}" style="flex-shrink:0;margin-left:12px"><div class="ms-toggle-dot"></div></div>`;

  const NEWS_OPTS = [
    { val:'yahootw',      label:'Yahoo 奇摩股市（中文，預設）' },
    { val:'googlenews',   label:'Google News（中文）' },
    { val:'yahoofinance', label:'Yahoo Finance（英文）' },
  ];

  panel.innerHTML = `
    ${S('資料來源')}
    <div style="padding:0 16px 4px;display:flex;gap:8px;box-sizing:border-box">
      ${['twse','finmind'].map(v => { const on = dsVal===v; return `
        <button class="ms-opt-btn" data-ds="${v}" style="flex:1;padding:10px 0;border-radius:10px;
          border:0.5px solid ${on?'rgba(239,83,80,0.5)':'#30363d'};
          background:${on?'rgba(239,83,80,0.1)':'transparent'};
          color:${on?'#ef5350':'#8b949e'};font-size:14px;font-weight:${on?700:400};cursor:pointer">
          ${v==='twse'?'TWSE 免費':'FinMind'}
        </button>`; }).join('')}
    </div>
    <div id="msFinmindSection" style="display:${dsVal==='finmind'?'':'none'};padding:8px 16px 4px;box-sizing:border-box">
      <div style="font-size:11px;color:#8b949e;margin-bottom:6px">FinMind API Token</div>
      <div style="display:flex;gap:8px">
        <input id="msTokenInput" type="password" placeholder="貼上你的 Token…"
          style="flex:1;padding:9px 12px;background:#161b22;border:0.5px solid #30363d;border-radius:9px;color:#e6edf3;font-size:13px;min-width:0;box-sizing:border-box">
        <button id="msTokenEye" style="padding:9px 12px;border-radius:9px;border:0.5px solid #30363d;background:transparent;color:#8b949e;font-size:12px;cursor:pointer;white-space:nowrap">顯示</button>
      </div>
    </div>

    ${S('新聞來源')}
    ${NEWS_OPTS.map((o,i) => { const on = newsVal===o.val; return `
      ${i>0?SEP:''}
      <div class="ms-news-row" data-news="${o.val}" style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;box-sizing:border-box">
        <div style="width:18px;height:18px;border-radius:50%;border:1.5px solid ${on?'#ef5350':'#30363d'};background:${on?'#ef5350':'transparent'};flex-shrink:0;display:flex;align-items:center;justify-content:center">
          ${on?'<div style="width:7px;height:7px;border-radius:50%;background:#fff"></div>':''}
        </div>
        <span style="font-size:14px;color:${on?'#e6edf3':'#8b949e'}">${o.label}</span>
      </div>`; }).join('')}

    ${S('篩選器設定')}
    <div id="msConcurrRow" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer;box-sizing:border-box">
      ${INFO('並發請求數','數值越高速度越快，但容易被封鎖')}
      <span id="msConcurrVal" style="font-size:16px;font-weight:700;color:#ef5350;flex-shrink:0;margin-left:12px">${cncVal}</span>
    </div>
    ${SEP}
    <div id="msPeriodRow" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer;box-sizing:border-box">
      ${INFO('K 線週期')}
      <span id="msPeriodVal" style="font-size:13px;color:#58a6ff;flex-shrink:0;margin-left:12px">${prdTxt}</span>
    </div>
    ${SEP}
    <div id="msProxyRow" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer;box-sizing:border-box">
      ${INFO('K 線 Proxy 來源','Worker 502 時可切換；切換後立即生效')}
      <span id="msProxyVal" style="font-size:13px;color:#58a6ff;flex-shrink:0;margin-left:12px;max-width:90px;text-align:right;line-height:1.3">${prxTxt}</span>
    </div>

    ${S('功能模組')}
    ${[
      { id:'modInstitutional', title:'三大法人買賣超', desc:'外資、投信、自營商（TWSE）' },
      { id:'modMargin',        title:'融資融券',       desc:'融資餘額、融券餘額（TWSE）' },
      { id:'modTechnical',     title:'技術指標篩選',   desc:'需呼叫 Yahoo Finance，速度較慢' },
    ].map((m,i) => `
      ${i>0?SEP:''}
      <div class="ms-mod-row" data-mod="${m.id}" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer;box-sizing:border-box">
        ${INFO(m.title, m.desc)}
        ${TOGGLE(m.id, _chk(m.id))}
      </div>`).join('')}

    ${S('手機顯示設定')}
    <div style="padding:0 16px 16px;display:flex;gap:8px;box-sizing:border-box">
      ${['KD','RSI','MACD'].map(v => { const on = mobVal===v; return `
        <button class="ms-opt-btn" data-mob="${v}" style="flex:1;padding:10px 0;border-radius:10px;
          border:0.5px solid ${on?'rgba(239,83,80,0.5)':'#30363d'};
          background:${on?'rgba(239,83,80,0.1)':'transparent'};
          color:${on?'#ef5350':'#8b949e'};font-size:14px;font-weight:${on?700:400};cursor:pointer">${v}</button>`; }).join('')}
    </div>

    <div style="padding:0 16px 40px;display:flex;gap:10px;box-sizing:border-box">
      <button id="msSaveBtn" class="m-run-btn" style="flex:1">儲存設定</button>
      <button id="msResetBtn" style="padding:12px 16px;border-radius:11px;border:0.5px solid #30363d;background:transparent;color:#8b949e;font-size:14px;cursor:pointer;white-space:nowrap">重設</button>
    </div>
  `;

  // ── 事件綁定（全部直接綁，不用委派）────────────────────────

  const tokenOrig = document.getElementById('finmindToken');
  const tokenClone = panel.querySelector('#msTokenInput');
  if (tokenOrig && tokenClone) tokenClone.value = tokenOrig.value;

  panel.querySelector('#msTokenEye')?.addEventListener('click', () => {
    const inp = panel.querySelector('#msTokenInput');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    panel.querySelector('#msTokenEye').textContent = show ? '隱藏' : '顯示';
  });

  panel.querySelector('#msTokenInput')?.addEventListener('input', e => {
    if (tokenOrig) tokenOrig.value = e.target.value;
  });

  panel.querySelectorAll('[data-ds]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelector(`input[name="dataSource"][value="${btn.dataset.ds}"]`)?.click();
    _render(panel);
  }));

  panel.querySelectorAll('.ms-news-row').forEach(row => row.addEventListener('click', () => {
    document.querySelector(`input[name="newsSource"][value="${row.dataset.news}"]`)?.click();
    _render(panel);
  }));

  panel.querySelector('#msConcurrRow')?.addEventListener('click', () => {
    _pickerSheet('並發請求數',
      Array.from({length:10}, (_,i) => ({ value:String(i+1), text:String(i+1) })),
      _range('concurrencyVal') || '5',
      val => {
        const orig = document.getElementById('concurrencyVal');
        if (orig) { orig.value = val; orig.dispatchEvent(new Event('input',{bubbles:true})); }
        const disp = document.getElementById('concurrencyDisplay');
        if (disp) disp.textContent = val;
        const v = panel.querySelector('#msConcurrVal'); if (v) v.textContent = val;
      });
  });

  panel.querySelector('#msPeriodRow')?.addEventListener('click', () => {
    const orig = document.getElementById('screenerPeriod'); if (!orig) return;
    _pickerSheet('K 線週期', Array.from(orig.options).map(o=>({value:o.value,text:o.text})), orig.value, val => {
      orig.value = val; orig.dispatchEvent(new Event('change',{bubbles:true}));
      const v = panel.querySelector('#msPeriodVal'); if (v) v.textContent = orig.options[orig.selectedIndex]?.text ?? val;
    });
  });

  panel.querySelector('#msProxyRow')?.addEventListener('click', () => {
    const orig = document.getElementById('klineProxyMode'); if (!orig) return;
    _pickerSheet('K 線 Proxy 來源', Array.from(orig.options).map(o=>({value:o.value,text:o.text})), orig.value, val => {
      orig.value = val; orig.dispatchEvent(new Event('change',{bubbles:true}));
      const v = panel.querySelector('#msProxyVal'); if (v) v.textContent = orig.options[orig.selectedIndex]?.text ?? val;
    });
  });

  panel.querySelectorAll('.ms-mod-row').forEach(row => row.addEventListener('click', () => {
    const orig = document.getElementById(row.dataset.mod); if (!orig) return;
    orig.click();
    row.querySelector('.ms-toggle')?.classList.toggle('on', orig.checked);
  }));

  panel.querySelectorAll('[data-mob]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelector(`input[name="mobileIndicator"][value="${btn.dataset.mob}"]`)?.click();
    _render(panel);
  }));

  panel.querySelector('#msSaveBtn')?.addEventListener('click', () => {
    document.getElementById('settingsSaveBtn')?.click();
    _toast('設定已儲存');
  });

  panel.querySelector('#msResetBtn')?.addEventListener('click', () => {
    document.getElementById('settingsResetBtn')?.click();
    setTimeout(() => _render(panel), 150);
  });
}

function _pickerSheet(title, opts, currentVal, onSelect) {
  document.getElementById('msPicker')?.remove();
  const sheet = document.createElement('div');
  sheet.id = 'msPicker';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:30000;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;';
  sheet.innerHTML = `
    <div style="width:100%;background:#161b22;border-radius:16px 16px 0 0;padding:16px 0 32px;max-height:60vh;overflow-y:auto">
      <div style="padding:0 16px 12px;font-size:12px;font-weight:600;color:#8b949e;border-bottom:0.5px solid #21262d;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">${title}</div>
      ${opts.map(o => `
        <div class="ms-pick-row" data-val="${o.value}" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer">
          <span style="font-size:15px;color:${o.value===currentVal?'#ef5350':'#e6edf3'}">${o.text}</span>
          ${o.value===currentVal?'<span style="color:#ef5350;font-size:13px">✓</span>':''}
        </div>`).join('')}
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelectorAll('.ms-pick-row').forEach(row =>
    row.addEventListener('click', () => { onSelect(row.dataset.val); sheet.remove(); }));
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
}

function _toast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#21262d;color:#e6edf3;font-size:13px;padding:8px 16px;border-radius:20px;z-index:40000;pointer-events:none;white-space:nowrap;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}
