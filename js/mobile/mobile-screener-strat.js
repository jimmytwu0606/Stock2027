/**
 * mobile-screener-strat.js
 * 策略篩選：結果渲染 + 設定掃描 + 執行掃描
 */

const _GRP_ICONS = {
  '強勢續漲':'📈','超跌反彈':'🔄','轉折訊號':'⚡',
  '葛蘭碧':'📐','盤整突破':'📦','基本面':'📋',
  '巴菲特':'💎','技術指標':'🔬','K線型態':'🕯️','避險警示':'⚠️','X系列':'🚀',
};
let _selectedStrats = new Set();

export function renderResult(body, deps) {
    const { AppState } = deps;
  const results = AppState?.screener?.results || [];
  _updateCnt('strat', results.length);

  if (!results.length) {
    body.innerHTML = _emptyHTML('⚡', '尚無策略結果', '點「設定掃描」選擇策略後執行掃描', true);
    return;
  }

  const html = `
    <div class="m-last-scan">
      ${AppState.screener.lastStrategy || '策略篩選'}
      <span>${results.length} 檔</span>
    </div>
    <div class="m-result-list">
      ${results.slice(0, 50).map(r => _resultCardHTML(r, {
        tags: (r.matchedConds || []).slice(0, 2),
        tagClass: 'blue',
      })).join('')}
    </div>
  `;
  body.innerHTML = html;
  _bindResultCards(body, results, { icon: '⚡', title: '策略結果', mode: 'strat' });
}

export function renderSetup(body, deps) {
  const strategies = (window.__STRATEGIES || []);
  const groups = new Map();
  strategies.forEach(s => {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  });
  const tier = window.__userTier || 'free';

  body.innerHTML = `
    <div class="mss-summary" id="mssSummary">
      <span class="mss-label">已選：</span>
      ${_selectedStrats.size
        ? `<span class="mss-pills">${[..._selectedStrats].map(n=>`<span class="mss-pill">${n}</span>`).join('')}</span><button class="mss-clear" id="mssClear">清除</button>`
        : '<span class="mss-none">尚未選取</span>'}
    </div>
    <div id="mssGroups"></div>
    <div class="m-s-section" style="padding-top:10px">
      <div class="m-s-label">股價範圍</div>
      <div class="m-phase-a-row">
        <div class="m-phase-a-col">
          <div class="m-phase-a-field-label">最低（元）</div>
          <input class="m-phase-a-field" id="mPhaseAMin" type="number" value="10" inputmode="numeric">
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:8px;color:#3d444d">—</div>
        <div class="m-phase-a-col">
          <div class="m-phase-a-field-label">最高（元）</div>
          <input class="m-phase-a-field" id="mPhaseAMax" type="number" value="9999" inputmode="numeric">
        </div>
        <div class="m-phase-a-col">
          <div class="m-phase-a-field-label">成交量≥（張）</div>
          <input class="m-phase-a-field" id="mPhaseAVol" type="number" value="0" inputmode="numeric">
        </div>
      </div>
    </div>
    <div class="m-run-wrap">
      <button class="m-run-btn" id="mStratRunBtn">開始掃描全市場 →</button>
    </div>
  `;

  const grpWrap = body.querySelector('#mssGroups');
  groups.forEach((strats, category) => {
    const selInGroup = strats.filter(s => _selectedStrats.has(s.name)).length;
    const icon = _GRP_ICONS[category] || '📌';
    const grpEl = document.createElement('div');
    grpEl.className = 'mss-grp';
    grpEl.innerHTML = `
      <div class="mss-grp-hd">
        <div class="mss-grp-left">
          <span class="mss-grp-icon">${icon}</span>
          <span class="mss-grp-name">${category}</span>
          <span class="mss-grp-cnt ${selInGroup?'has-sel':''}">${selInGroup?selInGroup+' 選':strats.length+' 項'}</span>
        </div>
        <span class="mss-grp-arrow">⌄</span>
      </div>
      <div class="mss-grp-body mss-collapsed">
        ${strats.map(s => {
          const locked = s.tier==='pro' && tier==='free';
          const checked = _selectedStrats.has(s.name);
          return `<div class="mss-row ${checked?'selected':''} ${locked?'locked':''}" data-name="${s.name}">
            <div class="mss-dot ${checked?'checked':''}"></div>
            <div class="mss-info">
              <div class="mss-sname">${s.icon||''} ${s.name}</div>
              <div class="mss-sdesc">${s.desc||''}</div>
            </div>
            ${locked?'<span class="mss-pro-badge">Pro</span>':''}
          </div>`;
        }).join('')}
      </div>
    `;
    grpEl.querySelector('.mss-grp-hd').addEventListener('click', () => {
      const b = grpEl.querySelector('.mss-grp-body');
      const a = grpEl.querySelector('.mss-grp-arrow');
      b.classList.toggle('mss-collapsed');
      a.style.transform = b.classList.contains('mss-collapsed') ? '' : 'rotate(180deg)';
    });
    grpEl.querySelectorAll('.mss-row:not(.locked)').forEach(row => {
      row.addEventListener('click', () => {
        const name = row.dataset.name;
        if (_selectedStrats.has(name)) _selectedStrats.delete(name);
        else _selectedStrats.add(name);
        renderSetup(body, deps);
      });
    });
    grpWrap.appendChild(grpEl);
  });

  body.querySelector('#mssClear')?.addEventListener('click', () => {
    _selectedStrats.clear();
    renderSetup(body, deps);
  });

  body.querySelector('#mStratRunBtn')?.addEventListener('click', async () => {
    if (!_selectedStrats.size) { deps.showToast?.('請至少選擇一個策略'); return; }
    deps.onClose?.();
    await runScan({
      priceMin:  Number(body.querySelector('#mPhaseAMin')?.value||10),
      priceMax:  Number(body.querySelector('#mPhaseAMax')?.value||9999),
      volumeMin: Number(body.querySelector('#mPhaseAVol')?.value||0),
      strategies: [..._selectedStrats],
    }, deps);
  });
}

export async function runScan(opts, deps) {
  const { showScanOverlay, hideScanOverlay, updateProgress, onResult, onDone, AppState } = deps;
  showScanOverlay?.('策略掃描中…');
  try {
    const { runScreener } = await import('../screener.js');
    const gen = runScreener({ ...opts, strategies: opts.strategies });
    for await (const evt of gen) {
      if (evt.type === 'progress') updateProgress?.(evt.done, evt.total, evt.message);
      if (evt.type === 'result')   onResult?.(evt.item);
      if (evt.type === 'done')     break;
    }
    if (AppState) AppState.screener.lastStrategy = opts.strategies.join('＋');
    onDone?.('strat');
  } catch(e) {
    deps.showToast?.('掃描失敗：'+e.message);
  } finally {
    hideScanOverlay?.();
  }
}
