/**
 * mobile-screener-seed.js
 * 種子選股：結果渲染 + 設定 + 執行掃描
 */

export function renderResult(body, deps) {
  const { AppState } = deps;
  const results = AppState?.seed?.scanResults || [];

  if (!results.length) {
    body.innerHTML = _emptyHTML('🌱','尚無種子選股結果','請至「設定掃描 → 種子」設定種子後執行');
    return;
  }
  body.innerHTML = `
    <div class="m-last-scan">種子選股 <span>${results.length} 檔</span></div>
    <div class="m-result-list">
      ${results.slice(0,50).map(r => _resultCardHTML(r, {
        tags:[
          r.sectorScore!=null?`產業 ${r.sectorScore}`:null,
          `型態 ${r.patternScore}`,
          `指標 ${r.indicatorScore}`,
        ].filter(Boolean),
        tagClass:'blue',
      })).join('')}
    </div>`;
  body.querySelectorAll('.m-rc').forEach((el,i)=>{
    el.addEventListener('click',()=>window.__loadStock?.(results[i]?.code||el.dataset.code));
  });
}

export async function renderSetup(body, deps) {
  const { AppState } = deps;
  const seedCodes = AppState?.seed?.seedCodes || [];

  body.innerHTML = `
    <div class="m-s-section">
      <div class="m-s-label">種子股（相似股為基準）</div>
      <div style="display:flex;gap:7px;margin-bottom:8px">
        <input id="mSeedInput" style="flex:1;padding:8px 10px;background:#0d1117;border:0.5px solid #30363d;border-radius:9px;color:#e6edf3;font-size:14px" placeholder="輸入代號（如 2330）" inputmode="numeric">
        <button id="mSeedAddBtn" style="padding:8px 14px;border-radius:9px;background:rgba(88,166,255,0.12);border:0.5px solid rgba(88,166,255,0.3);color:#58a6ff;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">加入</button>
      </div>
      <div id="mSeedChips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        ${seedCodes.map(c=>`
          <div class="m-seed-chip" data-code="${c}">
            <span>${c}</span>
            <span class="m-seed-chip-rm" data-rm="${c}">✕</span>
          </div>`).join('')}
        ${!seedCodes.length?'<span style="font-size:12px;color:#3d444d">尚未加入種子股</span>':''}
      </div>
      <div class="m-s-label">評分權重</div>
      <div style="margin-bottom:14px">
        ${[['型態','pattern',50],['指標','indicator',25],['產業','sector',25]].map(([label,key,def])=>`
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="font-size:12px;color:#8b949e;width:36px">${label}</span>
            <input type="range" id="mSeedW_${key}" min="0" max="100" value="${def}" style="flex:1">
            <span id="mSeedWV_${key}" style="font-size:12px;font-weight:600;color:#58a6ff;min-width:30px">${def}%</span>
          </div>`).join('')}
      </div>
      <div class="m-s-label">門檻</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <input type="range" id="mSeedThreshold" min="30" max="90" value="60" style="flex:1">
        <span id="mSeedThresholdV" style="font-size:12px;font-weight:600;color:#58a6ff;min-width:36px">60%</span>
      </div>
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mSeedRunBtn">開始種子掃描 →</button>
    </div>`;

  // 加入種子
  body.querySelector('#mSeedAddBtn')?.addEventListener('click', () => {
    const code = body.querySelector('#mSeedInput')?.value?.trim();
    if (!code) return;
    if (!AppState.seed) AppState.seed = { seedCodes:[], scanResults:[] };
    if (!AppState.seed.seedCodes.includes(code)) AppState.seed.seedCodes.push(code);
    body.querySelector('#mSeedInput').value = '';
    renderSetup(body, deps);
  });

  // 移除種子
  body.querySelectorAll('.m-seed-chip-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.rm;
      if (AppState?.seed?.seedCodes) {
        AppState.seed.seedCodes = AppState.seed.seedCodes.filter(c=>c!==code);
      }
      renderSetup(body, deps);
    });
  });

  // 權重滑桿
  ['pattern','indicator','sector'].forEach(key => {
    body.querySelector(`#mSeedW_${key}`)?.addEventListener('input', e => {
      body.querySelector(`#mSeedWV_${key}`).textContent = e.target.value + '%';
    });
  });
  body.querySelector('#mSeedThreshold')?.addEventListener('input', e => {
    body.querySelector('#mSeedThresholdV').textContent = e.target.value + '%';
  });

  body.querySelector('#mSeedRunBtn')?.addEventListener('click', async () => {
    const codes = AppState?.seed?.seedCodes || [];
    if (!codes.length) { deps.showToast?.('請先加入種子股'); return; }
    const weights = {
      pattern:   Number(body.querySelector('#mSeedW_pattern')?.value||50)/100,
      indicator: Number(body.querySelector('#mSeedW_indicator')?.value||25)/100,
      sector:    Number(body.querySelector('#mSeedW_sector')?.value||25)/100,
    };
    const threshold = Number(body.querySelector('#mSeedThreshold')?.value||60);
    deps.onClose?.();
    await runScan({ codes, weights, threshold }, deps);
  });
}

export async function runScan(opts, deps) {
  const { showScanOverlay, hideScanOverlay, updateProgress, onResult, onDone, AppState } = deps;
  showScanOverlay?.('種子掃描中…');
  try {
    const { runSeedScan } = await import('../seed-scan.js');
    const { extractSeedFeatures, mergeTemplates } = await import('../seed.js');
    const { fetchHistoryCached } = await import('../api.js');

    // 抓種子 K線 → 建模板
    const features = [];
    for (const code of opts.codes) {
      try {
        let candles = null;
        try { candles = await fetchHistoryCached(code + '.TW',  '3mo'); } catch(_) {}
        if (!candles?.length) {
          try { candles = await fetchHistoryCached(code + '.TWO', '3mo'); } catch(_) {}
        }
        if (candles?.length > 20) {
          const f = extractSeedFeatures(candles, { code });
          if (f) features.push(f);
        }
      } catch(_) {}
    }
    if (!features.length) { deps.showToast?.('種子股 K線取得失敗'); return; }
    const template = mergeTemplates(features);
    if (!template) { deps.showToast?.('無法建立種子模板'); return; }

    // 等 __twsePricesReady（同 strat 做法）
    // __priceCache 有資料時，seed-scan Phase A 直接用快取，不重打 TWSE
    if (window.__twsePricesReady) {
      updateProgress?.(0, 0, '等待市場資料…');
      try { await window.__twsePricesReady; } catch(_) {}
    }

    const gen = runSeedScan(template, { weights: opts.weights, threshold: opts.threshold });
    for await (const evt of gen) {
      if (evt.type === 'progress') updateProgress?.(evt.done, evt.total, evt.message);
      if (evt.type === 'result')   { onResult?.(evt.item); }
      if (evt.type === 'warning')  deps.showToast?.(evt.message ?? '');
      if (evt.type === 'error')    { deps.showToast?.('⚠ ' + (evt.message ?? '')); break; }
      if (evt.type === 'aborted')  break;
      if (evt.type === 'done')     break;
    }
    onDone?.('seed');
  } catch(e) {
    deps.showToast?.('掃描失敗：'+e.message);
  } finally {
    hideScanOverlay?.();
  }
}

function _resultCardHTML(r, opts={}) {
  const up=(r.pct??r.chgPct??0)>=0;
  const clr=up?'#ef5350':'#26a69a';
  return `<div class="m-rc" data-code="${r.code}">
    <div class="m-rc-info">
      <div class="m-rc-name">${r.name||r.code}</div>
      <div class="m-rc-code">${r.code}</div>
      <div class="m-rc-badge">${(opts.tags||[]).map(t=>`<span class="m-rc-tag ${opts.tagClass||''}">${t}</span>`).join('')}</div>
    </div>
    <div class="m-rc-r">
      <div class="m-rc-price" style="color:${clr}">${r.price?Number(r.price).toFixed(2):'—'}</div>
    </div>
  </div>`;
}
function _emptyHTML(icon,title,desc){
  return `<div class="m-empty"><div class="m-empty-icon">${icon}</div><div class="m-empty-title">${title}</div><div class="m-empty-desc">${desc}</div></div>`;
}
