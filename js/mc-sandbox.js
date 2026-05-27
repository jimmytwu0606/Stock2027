// js/mc-sandbox.js
// ============================================================================
// 沙盒 K 線模擬器 v3
// ============================================================================

import { computeForecastCenter } from './monte-carlo.js';

// ── 狀態 ────────────────────────────────────────────────────────────────────
let _refs          = null;
let _simChart      = null;
let _simSeries     = null;   // monte-carlo.js 的 _simSeries，setData(真實+沙盒)
let _origCandles   = null;   // 沙盒開啟前的真實K線備份（關閉時還原用）
let _sandboxBars   = 5;
let _sandboxPeriod = '1y';   // '1y'=日K, '2y'=週K, '3mo'=月K合成
let _sandboxStocks = [];
let _sandboxResults= {};
let _activeTab     = null;

// ============================================================================
// 主入口
// ============================================================================
export function openSandboxPanel(refs, simChart, simSeries) {
  _refs      = refs;
  _simChart  = simChart;
  _simSeries = simSeries;

  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  // 預設帶入當前個股
  const code = refs?.getCode?.() ?? null;
  if (code && !_sandboxStocks.find(s => s.code === code)) {
    const name = window.__nameCache?.get?.(code) ?? code;
    _sandboxStocks = [{ code, name }];
  }

  _renderSandboxUI(panel);
}

export function closeSandbox() { _clearSandboxSeries(); }

// ============================================================================
// UI
// ============================================================================
function _renderSandboxUI(panel) {
  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🧪 沙盒 K 線模擬</span>
        <span class="mc-bt-meta">最高機率中線路徑 · 自動偵測進出場訊號</span>
      </div>
      <button class="mc-bt-close" id="mcSbClose">✕</button>
    </div>

    <!-- 設定列 -->
    <div class="mc-sandbox-config">

      <!-- 根數 -->
      <div class="mc-sandbox-row-cfg">
        <span class="mc-sandbox-label">模擬根數：</span>
        ${[3,5,8,10].map(n=>`
          <button class="mc-sandbox-bar-btn${n===_sandboxBars?' active':''}" data-bars="${n}">${n}根</button>
        `).join('')}
        <span class="mc-sandbox-warn" id="mcSbWarn" style="${_sandboxBars>8?'':'display:none'}">⚠️ 超過8根準確率下降</span>
      </div>

      <!-- K線型態 -->
      <div class="mc-sandbox-row-cfg">
        <span class="mc-sandbox-label">K線型態：</span>
        <button class="mc-sandbox-period-btn${_sandboxPeriod==='1y'?' active':''}" data-period="1y">日K</button>
        <button class="mc-sandbox-period-btn${_sandboxPeriod==='2y'?' active':''}" data-period="2y">週K</button>
        <button class="mc-sandbox-period-btn${_sandboxPeriod==='3mo'?' active':''}" data-period="3mo">月K</button>
        <span class="mc-sandbox-period-hint" id="mcSbPeriodHint">${_periodHint(_sandboxPeriod)}</span>
      </div>

      <!-- 個股標題 -->
      <div class="mc-sandbox-row-cfg">
        <span class="mc-sandbox-label">模擬標的 <b id="mcSbCount">${_sandboxStocks.length}</b> 檔</span>
        <button class="mc-sandbox-add-btn mc-sandbox-wl-btn" id="mcSbWlBtn">⭐ 從自選匯入</button>
        <button class="mc-sandbox-add-btn mc-sandbox-clear-all-btn" id="mcSbClearAll">清空</button>
      </div>

      <!-- 搜尋框（永遠顯示）-->
      <div class="mc-sandbox-search-wrap">
        <input class="mc-basket-input" id="mcSbSearchInput"
          placeholder="輸入代號或股名搜尋，Enter 加入..." autocomplete="off"/>
        <div class="mc-basket-suggestions" id="mcSbSuggestions"></div>
      </div>

      <!-- 批次輸入（永遠顯示）-->
      <div class="mc-sandbox-batch-section">
        <textarea class="mc-basket-batch-input" id="mcSbBatchInput"
          placeholder="批次貼上代號，空格 / 逗號 / 換行均可&#10;例：2330 2317 6609 瀧澤科 晶達"></textarea>
        <div class="mc-sandbox-batch-footer">
          <span class="mc-basket-batch-preview" id="mcSbBatchPreview"></span>
          <button class="mc-basket-batch-add-btn" id="mcSbBatchAdd">➕ 批次加入</button>
        </div>
      </div>

      <!-- 個股 chips -->
      <div class="mc-sandbox-chips" id="mcSbChips">${_renderChips()}</div>
    </div>

    <!-- 執行按鈕 -->
    <div class="mc-sandbox-actions">
      <button class="mc-sandbox-run-btn" id="mcSbRun" ${_sandboxStocks.length?'':'disabled'}>
        🎲 開始模擬${_sandboxStocks.length?` (${_sandboxStocks.length}檔)`:''}
      </button>
    </div>

    <!-- 進度 -->
    <div id="mcSbProgress" style="display:none" class="mc-cross-progress">
      <div class="mc-cross-progress-bar">
        <div class="mc-cross-progress-fill" id="mcSbFill" style="width:0%"></div>
      </div>
      <div class="mc-cross-progress-text" id="mcSbProgressText">準備中...</div>
    </div>

    <!-- Tabs + 結果 -->
    <div id="mcSbResultArea" style="display:none">
      <div class="mc-sandbox-tabs" id="mcSbTabs"></div>
      <div id="mcSbResultPanel"></div>
    </div>

    <div class="mc-bt-footnote">
      K柱為 MC v1.8 最高機率中線路徑（解析解），半透明顯示於圖表右側。<br>
      日K 5根方向命中率約 55~70%；週K/月K為較長週期模擬。
    </div>
  `;

  _bindEvents(panel);
}

function _periodHint(p) {
  return { '1y':'日K·短期精準', '2y':'週K·中期趨勢', '3mo':'月K·長線方向' }[p] ?? '';
}

function _renderChips() {
  if (!_sandboxStocks.length)
    return '<span style="color:#555b66;font-size:11px">尚無標的，請搜尋或批次匯入</span>';
  return _sandboxStocks.map((s,i) => `
    <span class="mc-sandbox-chip">
      <b>${s.code}</b> ${s.name}
      <button class="mc-sandbox-chip-remove" data-idx="${i}">✕</button>
    </span>
  `).join('');
}

// ============================================================================
// 事件綁定
// ============================================================================
function _bindEvents(panel) {
  // 關閉
  panel.querySelector('#mcSbClose')?.addEventListener('click', () => {
    _clearSandboxSeries();
    panel.style.display = 'none';
  });

  // 根數
  panel.querySelectorAll('.mc-sandbox-bar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.mc-sandbox-bar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _sandboxBars = parseInt(btn.dataset.bars);
      const warn = panel.querySelector('#mcSbWarn');
      if (warn) warn.style.display = _sandboxBars > 8 ? '' : 'none';
    });
  });

  // K線型態
  panel.querySelectorAll('.mc-sandbox-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.mc-sandbox-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _sandboxPeriod = btn.dataset.period;
      const hint = panel.querySelector('#mcSbPeriodHint');
      if (hint) hint.textContent = _periodHint(_sandboxPeriod);
    });
  });

  // 從自選匯入
  panel.querySelector('#mcSbWlBtn')?.addEventListener('click', () => {
    const groups = window.AppState?.watchlistGroups ?? [];
    if (!groups.length) { alert('尚無自選群組'); return; }
    groups.forEach(g => (g.stocks ?? []).forEach(s => {
      if (_sandboxStocks.length >= 20) return;
      if (_sandboxStocks.find(x => x.code === s.code)) return;
      _sandboxStocks.push({ code: s.code, name: s.name || window.__nameCache?.get?.(s.code) || s.code });
    }));
    _refreshList(panel);
  });

  // 清空
  panel.querySelector('#mcSbClearAll')?.addEventListener('click', () => {
    _sandboxStocks = [];
    _refreshList(panel);
  });

  // chip 移除（用事件委派）
  panel.querySelector('#mcSbChips')?.addEventListener('click', e => {
    const btn = e.target.closest('.mc-sandbox-chip-remove');
    if (!btn) return;
    _sandboxStocks.splice(parseInt(btn.dataset.idx), 1);
    _refreshList(panel);
  });

  // 搜尋輸入
  const input  = panel.querySelector('#mcSbSearchInput');
  const sugBox = panel.querySelector('#mcSbSuggestions');

  const _showSug = (q) => {
    if (!q) { sugBox.innerHTML = ''; return; }
    const cache = window.__nameCache;
    const results = [];
    if (cache) {
      for (const [code, name] of cache) {
        if (code.startsWith(q) || name.includes(q)) results.push({ code, name });
      }
      results.sort((a,b) => a.code===q?-1:b.code===q?1:a.code.localeCompare(b.code));
    }
    const top = results.slice(0, 8);
    if (!top.length) {
      sugBox.innerHTML = /^\d{4,6}$/.test(q)
        ? `<div class="mc-basket-sug-direct">⚠️ 快取找不到，按 Enter 直接加入</div>`
        : '<div class="mc-basket-sug-empty">找不到符合的股票</div>';
      return;
    }
    sugBox.innerHTML = top.map(r =>
      `<div class="mc-basket-sug-item" data-code="${r.code}" data-name="${r.name}">
        <b>${r.code}</b> ${r.name}
      </div>`
    ).join('');
    sugBox.querySelectorAll('.mc-basket-sug-item').forEach(el => {
      el.addEventListener('click', () => {
        _addStock(el.dataset.code, el.dataset.name, panel);
        input.value = ''; sugBox.innerHTML = '';
      });
    });
  };

  input?.addEventListener('input', e => _showSug(e.target.value.trim()));
  input?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    if (!q) return;
    // 純代號
    if (/^\d{4,6}$/.test(q)) {
      _addStock(q, window.__nameCache?.get?.(q) ?? q, panel);
      input.value = ''; sugBox.innerHTML = '';
      return;
    }
    // 從搜尋結果取第一筆
    const first = sugBox.querySelector('.mc-basket-sug-item');
    if (first) {
      _addStock(first.dataset.code, first.dataset.name, panel);
      input.value = ''; sugBox.innerHTML = '';
    }
  });

  // 批次輸入
  const batchInput   = panel.querySelector('#mcSbBatchInput');
  const batchPreview = panel.querySelector('#mcSbBatchPreview');

  batchInput?.addEventListener('input', () => {
    const parsed  = _parseMultiLine(batchInput.value);
    const newOnes = parsed.filter(p => !_sandboxStocks.find(s => s.code === p.code));
    if (!parsed.length) { batchPreview.innerHTML = ''; return; }
    batchPreview.innerHTML =
      `解析 <b>${parsed.length}</b> 檔，可新增 <b style="color:#4ade80">${newOnes.length}</b> 檔` +
      ((_sandboxStocks.length + newOnes.length > 20) ? ' <span style="color:#f87171">（超過20檔上限）</span>' : '');
  });

  panel.querySelector('#mcSbBatchAdd')?.addEventListener('click', () => {
    console.log('[sandbox] batch btn clicked, value:', JSON.stringify(batchInput?.value ?? 'NULL'));
    if (!batchInput?.value?.trim()) { console.log('[sandbox] empty input'); return; }
    const parsed  = _parseMultiLine(batchInput.value);
    const newOnes = parsed.filter(p => !_sandboxStocks.find(s => s.code === p.code));
    const canAdd  = Math.max(0, 20 - _sandboxStocks.length);
    newOnes.slice(0, canAdd).forEach(p =>
      _sandboxStocks.push({ code: p.code, name: p.name })
    );
    batchInput.value = '';
    batchPreview.innerHTML = '';
    _refreshList(panel);
  });

  // 開始模擬
  panel.querySelector('#mcSbRun')?.addEventListener('click', () => {
    if (_sandboxStocks.length) _runAll(panel);
  });
}

// ── 新增個股 ────────────────────────────────────────────────────────────────
function _addStock(code, name, panel) {
  if (_sandboxStocks.length >= 20) { alert('最多 20 檔'); return; }
  if (_sandboxStocks.find(s => s.code === code)) return;
  _sandboxStocks.push({ code, name: name || window.__nameCache?.get?.(code) || code });
  _refreshList(panel);
}

function _refreshList(panel) {
  // 重繪 chips
  const chipsEl = panel.querySelector('#mcSbChips');
  if (chipsEl) chipsEl.innerHTML = _renderChips();

  // 更新計數
  const count = panel.querySelector('#mcSbCount');
  if (count) count.textContent = _sandboxStocks.length;

  // 更新執行按鈕
  const runBtn = panel.querySelector('#mcSbRun');
  if (runBtn) {
    runBtn.disabled = !_sandboxStocks.length;
    runBtn.textContent = `🎲 開始模擬${_sandboxStocks.length ? ` (${_sandboxStocks.length}檔)` : ''}`;
  }

  // 重新綁定 chip 移除（事件委派，只需綁一次，但重繪後要重綁）
  chipsEl?.addEventListener('click', e => {
    const btn = e.target.closest('.mc-sandbox-chip-remove');
    if (!btn) return;
    _sandboxStocks.splice(parseInt(btn.dataset.idx), 1);
    _refreshList(panel);
  });
}

// ── 解析多行文字 ─────────────────────────────────────────────────────────────
function _parseMultiLine(raw) {
  // 支援空格/逗號/換行/頓號分隔，也支援「2330 台積電」格式
  // 先把常見格式正規化：把逗號/頓號/換行全換成空格，再 split
  const normalized = raw.replace(/[,，、\r\n]+/g, ' ');
  // 逐行也支援「2330台積電」黏在一起的格式
  const tokens = normalized.split(/\s+/).map(t => t.trim()).filter(Boolean);

  const cache   = window.__nameCache;
  const results = [];
  const added   = new Set();

  for (const token of tokens) {
    if (!token) continue;

    // ① 「中文名（代號）」或「中文名(代號)」格式 → 最優先
    let m = token.match(/^.+[（(](\d{4,6})[）)]$/);
    if (m) {
      const code = m[1];
      if (!added.has(code)) {
        const name = cache?.get?.(code) ?? token.replace(/[（(]\d{4,6}[）)]$/, '').trim();
        results.push({ code, name });
        added.add(code);
      }
      continue;
    }

    // ② 純數字代號（4~6碼）
    if (/^\d{4,6}$/.test(token)) {
      if (!added.has(token)) {
        const name = cache?.get?.(token) ?? token;
        results.push({ code: token, name });
        added.add(token);
      }
      continue;
    }

    // ③ 「2330台積電」黏連格式
    m = token.match(/^(\d{4,6})(.+)$/);
    if (m) {
      const code = m[1];
      if (!added.has(code)) {
        const name = cache?.get?.(code) ?? m[2];
        results.push({ code, name });
        added.add(code);
      }
      continue;
    }

    // ④ 純中文名完整比對
    if (cache && token.length >= 2) {
      let found = false;
      for (const [code, name] of cache) {
        if (added.has(code)) continue;
        if (name === token) {
          results.push({ code, name });
          added.add(code);
          found = true; break;
        }
      }
      // ⑤ 模糊比對
      if (!found) {
        for (const [code, name] of cache) {
          if (added.has(code)) continue;
          if (name.includes(token)) {
            results.push({ code, name });
            added.add(code);
            break;
          }
        }
      }
    }
  }

  console.log('[sandbox batch] input tokens:', tokens, '→ parsed:', results.map(r=>r.code));
  return results;
}

// ============================================================================
// 批次跑模擬
// ============================================================================
async function _runAll(panel) {
  const { fetchHistory, toYahooSymbol } = await import('./api.js');
  const { matchSignals } = await import('./signal-scan.js');

  _sandboxResults = {};
  _clearSandboxSeries();

  panel.querySelector('#mcSbProgress').style.display = '';
  panel.querySelector('#mcSbResultArea').style.display = 'none';
  panel.querySelector('#mcSbRun').disabled = true;

  const stocks = [..._sandboxStocks];

  for (let i = 0; i < stocks.length; i++) {
    const s    = stocks[i];
    const fill = panel.querySelector('#mcSbFill');
    const text = panel.querySelector('#mcSbProgressText');
    if (fill) fill.style.width = `${((i+1)/stocks.length)*100}%`;
    if (text) text.textContent = `${i+1}/${stocks.length} — ${s.code} ${s.name}`;

    try {
      const sym     = toYahooSymbol(s.code);
      // 依週期決定拉取範圍
      const fetchPeriod = _sandboxPeriod === '3mo' ? '1y' : _sandboxPeriod;
      let   candles = await fetchHistory(sym, fetchPeriod);

      if (!candles || candles.length < 30) {
        _sandboxResults[s.code] = { ok: false, reason: 'K線不足', ...s };
        continue;
      }

      // 月K：把日K合成月K
      if (_sandboxPeriod === '3mo') {
        candles = _toMonthlyCandles(candles);
        if (candles.length < 6) {
          _sandboxResults[s.code] = { ok: false, reason: '月K合成不足', ...s };
          continue;
        }
      }

      const forecast = computeForecastCenter(candles, _sandboxBars, { withPattern: false });
      if (!forecast) {
        _sandboxResults[s.code] = { ok: false, reason: '公式計算失敗', ...s };
        continue;
      }

      const sandboxCandles = _generateOHLCV(candles, forecast.drift, forecast.stdDev, _sandboxBars);
      const combined       = [...candles, ...sandboxCandles];

      // 逐根掃訊號（matchSignals 以日K為主，週K/月K僅跑基本判斷）
      const realLen  = candles.length;
      const prevSigs = new Set((matchSignals(candles, null, {}) ?? []).map(sig => sig.id ?? sig));
      const sigHistory = [];
      for (let j = 1; j <= _sandboxBars; j++) {
        const sliced  = combined.slice(0, realLen + j);
        const barSigs = (matchSignals(sliced, null, {}) ?? []).map(sig => sig.id ?? sig);
        sigHistory.push({ barIdx: j, sigs: barSigs, candle: sandboxCandles[j-1] });
      }

      // 進出場點
      const entryPoints = [], exitPoints = [];
      const prevSet = new Set(prevSigs);
      sigHistory.forEach(({ barIdx, sigs, candle }) => {
        const sigSet = new Set(sigs);
        ['X2','X1','X5','W6','S11'].forEach(id => {
          if (sigSet.has(id) && !prevSet.has(id)) entryPoints.push({ barIdx, sigId: id, candle });
        });
        ['W5','W14'].forEach(id => {
          if (sigSet.has(id) && !prevSet.has(id)) exitPoints.push({ barIdx, sigId: id, candle });
        });
        sigs.forEach(id => prevSet.add(id));
      });

      const lastClose  = sandboxCandles[_sandboxBars-1].close;
      const startClose = candles[candles.length-1].close;
      const totalRet   = +((lastClose - startClose) / startClose * 100).toFixed(1);

      _sandboxResults[s.code] = {
        ok: true, ...s,
        candles, sandboxCandles, forecast,
        sigHistory, entryPoints, exitPoints, totalRet,
        period: _sandboxPeriod,
      };
    } catch (e) {
      _sandboxResults[s.code] = { ok: false, reason: e.message, ...s };
    }

    if (i < stocks.length - 1) await new Promise(r => setTimeout(r, 350));
  }

  panel.querySelector('#mcSbProgress').style.display = 'none';
  panel.querySelector('#mcSbRun').disabled = false;
  panel.querySelector('#mcSbResultArea').style.display = '';

  _activeTab = stocks[0]?.code ?? null;
  _renderTabs(panel, stocks);
  if (_activeTab) _showTabResult(panel, _activeTab);
}

// ── 日K合成月K ──────────────────────────────────────────────────────────────
function _toMonthlyCandles(dailyCandles) {
  const months = {};
  dailyCandles.forEach(c => {
    const d   = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    if (!months[key]) months[key] = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, time: c.time };
    else {
      months[key].high    = Math.max(months[key].high, c.high);
      months[key].low     = Math.min(months[key].low, c.low);
      months[key].close   = c.close;
      months[key].volume += c.volume ?? 0;
    }
  });
  return Object.values(months).sort((a,b) => a.time - b.time);
}

// ============================================================================
// Tabs
// ============================================================================
function _renderTabs(panel, stocks) {
  const tabsEl = panel.querySelector('#mcSbTabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = stocks.map(s => {
    const r   = _sandboxResults[s.code];
    const ok  = r?.ok;
    const ret = ok ? r.totalRet : null;
    const col = !ok ? '#8a8f99' : ret >= 0 ? '#ef5350' : '#26a69a';
    const hasEntry = ok && r.entryPoints?.length > 0;
    return `
      <button class="mc-sandbox-tab${s.code===_activeTab?' active':''}" data-code="${s.code}">
        <span class="mc-sandbox-tab-code">${s.code}</span>
        ${ok
          ? `<span class="mc-sandbox-tab-ret" style="color:${col}">${ret>=0?'+':''}${ret}%</span>
             ${hasEntry?'<span class="mc-sandbox-tab-dot">▲</span>':''}`
          : '<span style="color:#f87171;font-size:10px">✕</span>'
        }
      </button>
    `;
  }).join('');

  tabsEl.querySelectorAll('.mc-sandbox-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.mc-sandbox-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeTab = btn.dataset.code;
      _showTabResult(panel, _activeTab);
    });
  });
}

function _showTabResult(panel, code) {
  const r = _sandboxResults[code];
  if (!r) return;
  if (r.ok && r.sandboxCandles) _drawSandboxOnChart(r.candles, r.sandboxCandles);
  else _clearSandboxSeries();

  const resultPanel = panel.querySelector('#mcSbResultPanel');
  if (!resultPanel) return;

  if (!r.ok) {
    resultPanel.innerHTML = `<div class="mc-bt-error" style="margin:12px 14px">⚠️ ${r.code} ${r.name}: ${r.reason}</div>`;
    return;
  }

  const { sigHistory, entryPoints, exitPoints, forecast, totalRet, sandboxCandles } = r;
  const retColor   = totalRet >= 0 ? '#ef5350' : '#26a69a';
  const startClose = r.candles[r.candles.length-1].close;
  const periodLabel = { '1y':'日K', '2y':'週K', '3mo':'月K' }[r.period] ?? '';

  const sigNames = { X2:'X2 天黑請閉眼', X1:'X1 黃金比例', X5:'X5 量證明一切', W6:'W6 RSI強勢驗證', S11:'S11 三箭齊發' };

  const entryHtml = entryPoints.length
    ? entryPoints.map(ep => {
        const col = ['X2','W6','S11'].includes(ep.sigId) ? '#4ade80' : '#fb923c';
        const ret = +((sandboxCandles[_sandboxBars-1].close - ep.candle.close) / ep.candle.close * 100).toFixed(1);
        return `<div class="mc-sandbox-entry-card" style="border-left:3px solid ${col}">
          <span class="mc-sandbox-entry-sig" style="color:${col}">▲ ${sigNames[ep.sigId]??ep.sigId}</span>
          <span class="mc-sandbox-entry-bar">+${ep.barIdx}根後</span>
          <span class="mc-sandbox-entry-price">進場 ${ep.candle.close.toFixed(2)}</span>
          <span class="mc-sandbox-entry-ret" style="color:${ret>=0?'#ef5350':'#26a69a'}">${ret>=0?'+':''}${ret}%</span>
        </div>`;
      }).join('')
    : `<div style="color:#8a8f99;font-size:12px;padding:6px 0">本次路徑未觸發主要進場訊號（X2/W6/S11）</div>`;

  const timelineRows = sigHistory.map(({ barIdx, sigs, candle }) => {
    const newEntry = entryPoints.filter(e => e.barIdx===barIdx).map(e => e.sigId);
    const newExit  = exitPoints.filter(e => e.barIdx===barIdx).map(e => e.sigId);
    const ret = +((candle.close - startClose) / startClose * 100).toFixed(1);
    return `<tr class="${newEntry.length?'mc-sandbox-row-entry':newExit.length?'mc-sandbox-row-exit':''}">
      <td class="mc-sandbox-bar-idx">+${barIdx}</td>
      <td class="mc-sandbox-price">${candle.close.toFixed(2)}
        <span style="color:${ret>=0?'#ef5350':'#26a69a'};font-size:10px"> ${ret>=0?'+':''}${ret}%</span>
      </td>
      <td class="mc-sandbox-signals">
        ${newEntry.map(id=>`<span class="mc-sandbox-sig-entry">▲${id}</span>`).join('')}
        ${newExit.map(id=>`<span class="mc-sandbox-sig-exit">▼${id}</span>`).join('')}
        ${!newEntry.length&&!newExit.length
          ? `<span style="color:#555b66;font-size:10px">${sigs.slice(0,4).join(' ')||'—'}</span>`
          : ''}
      </td>
    </tr>`;
  }).join('');

  resultPanel.innerHTML = `
    <div class="mc-sandbox-result-header">
      <span class="mc-sandbox-result-name">${r.name}</span>
      <span class="mc-sandbox-result-ret" style="color:${retColor}">
        ${periodLabel} ${_sandboxBars}根 ${totalRet>=0?'+':''}${totalRet}%
      </span>
      <span class="mc-sandbox-result-regime">
        Regime: ${forecast.diag?.regime??'—'} · 年化波動 ${+(forecast.stdDev*Math.sqrt(252)*100).toFixed(1)}%
      </span>
    </div>
    <div class="mc-sandbox-section-title">🎯 模擬進場點</div>
    <div class="mc-sandbox-entries">${entryHtml}</div>
    <div class="mc-sandbox-section-title">📊 逐根訊號</div>
    <table class="mc-sandbox-timeline">
      <thead><tr><th>+N根</th><th>收盤 / 漲跌</th><th>新增訊號</th></tr></thead>
      <tbody>${timelineRows}</tbody>
    </table>
  `;
}

// ============================================================================
// 生成 OHLCV（最高機率中線解析解）
// ============================================================================
// ── _generateOHLCV ──────────────────────────────────────────────────────────
// 最高機率中線路徑（解析解） + 個股 ATR/sigma 決定每根高低範圍
//
// close：用 drift 的累積解析解（不隨機，代表中線方向）
// open：前一根 close（連續不跳空）
// high/low：用 sigma + ATR 混合決定，反映個股真實波動度
//   ‣ halfRange = max(ATR × 0.5, sigma × lastClose × 1.5)
//   ‣ 上漲根：high = close + halfRange×0.4，low = open - halfRange×0.3
//   ‣ 下跌根：high = open + halfRange×0.3，low = close - halfRange×0.4
//   → 高波動股（sigma大）→ 影線長；低波動股 → 影線短，與ATR保持一致
// ── ────────────────────────────────────────────────────────────────────────
function _generateOHLCV(realCandles, drift, sigma, bars) {
  const lastReal     = realCandles[realCandles.length-1];
  const N            = realCandles.length;

  // ATR(14)
  const atrLen = Math.min(14, N - 1);
  let atrSum   = 0;
  for (let i = N - atrLen; i < N; i++) {
    const c = realCandles[i], p = realCandles[i - 1];
    atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atr = atrSum / atrLen;

  const avgVol = realCandles.slice(-10).reduce((s, c) => s + (c.volume ?? 0), 0) / 10;
  const timeInterval = N >= 2
    ? realCandles[N - 1].time - realCandles[N - 2].time
    : 86400;

  // sigma 換算成「每根絕對波動範圍」（對數報酬 → 金額）
  // sigma 是每根對數報酬的標準差，乘上價格 = 每根 1σ 的金額波動
  const sigmaAbs = sigma * lastReal.close;

  const result   = [];
  let prevClose  = lastReal.close;
  let prevTime   = lastReal.time;

  for (let i = 0; i < bars; i++) {
    // 中線收盤（解析解，代表最高機率方向）
    const close = lastReal.close * Math.exp(drift * (i + 1));
    const open  = prevClose;
    const isUp  = close >= open;

    // 高低範圍：取 ATR 和 sigma 的較大者，確保反映個股波動特性
    const bodySize  = Math.abs(close - open);
    const halfRange = Math.max(atr * 0.5, sigmaAbs * 1.2);

    let high, low;
    if (isUp) {
      // 上漲根：上影線較短，下影線較長
      high = close + halfRange * 0.35;
      low  = open  - halfRange * 0.25;
      // 確保 low 不超過 body 下方太多（最多 halfRange）
      low  = Math.max(low, open - halfRange);
    } else {
      // 下跌根：下影線較短，上影線較長
      high = open  + halfRange * 0.25;
      low  = close - halfRange * 0.35;
      low  = Math.max(low, close - halfRange);
    }

    // 至少要包住實體
    high = Math.max(high, Math.max(open, close));
    low  = Math.min(low,  Math.min(open, close));

    const time = prevTime + timeInterval;
    result.push({
      time,
      open:   +open.toFixed(2),
      high:   +high.toFixed(2),
      low:    +low.toFixed(2),
      close:  +close.toFixed(2),
      volume: Math.round(avgVol),
      _isSandbox: true,
    });

    prevClose = close;
    prevTime  = time;
  }
  return result;
}

// ============================================================================
// 繪製沙盒 K 柱
// ── 核心規則：絕對不 addCandlestickSeries，LightweightCharts 同一 chart 上
//    多個 candlestick series 切換後會炸（第2個以後變線條）
// ── 做法：直接操作 _simSeries（真實K線所在的 series）
//    setData( 真實K線 + 沙盒K柱 )，沙盒K柱用 per-bar color override 做半透明
// ── _origCandles：第一次進入沙盒時備份真實K線，關閉時還原
// ============================================================================
function _drawSandboxOnChart(realCandles, sandboxCandles) {
  if (!_simSeries) { console.warn('[sandbox] _simSeries 未傳入'); return; }

  // 第一次進入沙盒：備份 _simChart 上的真實K線
  // （之後切Tab不重複備份，一直用最一開始的 _origCandles）
  if (!_origCandles) {
    _origCandles = realCandles;
  }

  // 組合資料：真實K線（原色）+ 沙盒K柱（半透明 override）
  const combined = [
    ...realCandles.map(c => ({
      time:  c.time,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
      // 真實K線不設 color，使用 _simSeries 預設顏色
    })),
    ...sandboxCandles.map(c => ({
      time:        c.time,
      open:        c.open,
      high:        c.high,
      low:         c.low,
      close:       c.close,
      // per-bar color override：沙盒K柱半透明
      color:       c.close >= c.open ? 'rgba(239,83,80,0.45)'  : 'rgba(38,166,154,0.45)',
      borderColor: c.close >= c.open ? 'rgba(239,83,80,0.85)'  : 'rgba(38,166,154,0.85)',
      wickColor:   c.close >= c.open ? 'rgba(239,83,80,0.65)'  : 'rgba(38,166,154,0.65)',
    })),
  ];

  // 隱藏 MC 模擬 canvas（沙盒期間不需要扇形路徑干擾）
  const mcCanvas = document.getElementById('mcSimCanvas');
  if (mcCanvas) mcCanvas.style.opacity = '0';

  try {
    _simSeries.setData(combined);
  } catch (e) {
    console.warn('[sandbox] setData 失敗:', e);
    if (mcCanvas) mcCanvas.style.opacity = '';
    return;
  }

  // 沙盒起點 marker
  try {
    _simSeries.setMarkers([{
      time:     sandboxCandles[0].time,
      position: 'aboveBar',
      color:    '#fbbf24',
      shape:    'arrowDown',
      text:     '🧪',
      size:     1,
    }]);
  } catch {}

  // ── 重要：沙盒換股後時間軸完全不同，必須先 fitContent 對齊，
  //    再把右側延伸到沙盒末根 + 留 3 根空白
  try {
    const ts = _simChart.timeScale();
    ts.fitContent();
    // fitContent 是非同步渲染，延遲一幀再 scrollToRealTime
    requestAnimationFrame(() => {
      try {
        const lr = ts.getVisibleLogicalRange();
        if (lr) {
          // 讓沙盒K柱完整露出，右側留 3 根空白
          ts.setVisibleLogicalRange({
            from: lr.from,
            to:   lr.to + sandboxCandles.length + 3,
          });
        }
      } catch {}
    });
  } catch {}
}

// 還原真實K線（關閉沙盒 / 面板關閉時呼叫）
function _clearSandboxSeries() {
  // 還原 MC canvas 顯示
  const mcCanvas = document.getElementById('mcSimCanvas');
  if (mcCanvas) mcCanvas.style.opacity = '';

  if (!_simSeries || !_origCandles) return;
  try {
    _simSeries.setData(_origCandles.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    _simSeries.setMarkers([]);
    // 還原後 fitContent 讓原本那檔 K 線回到正常視角
    _simChart?.timeScale()?.fitContent();
  } catch {}
  _origCandles = null;
}
