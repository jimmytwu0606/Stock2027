/**
 * market-pulse.js — 市場溫度計
 *
 * 功能：
 *   - Topbar 比重條：多空訊號比重一行顯示，點擊開 modal
 *   - Modal 三 Tab：
 *     1. 盤面分析（系統自動圖文）
 *     2. AI 深度分析（已匯入結果 + 訊號驗算）
 *     3. 匯入分析（prompt 產生 + JSON 貼回 + 驗算）
 *
 * 依賴：
 *   - window.__snapshot._pulse（由 fetchSnapshot 載入）
 *   - window.__snapshot._quality（驗算品質）
 */

import { getKlineCache } from './db.js';

// ── 策略名稱對照（S/W 系列顯示用）────────────────────────
const STRATEGY_NAMES = {
  S1:'量價齊揚', S2:'均線黃金交叉', S3:'強勢多頭', S4:'創高強勢',
  S5:'爆量異動', S6:'RSI底部金叉', S7:'KD站上月線', S8:'超賣反彈',
  S9:'跌深量縮', S10:'MACD金叉', S11:'三指標共振', S12:'爆量止跌',
  S13:'布林突破', S14:'KD極值上軌', S15:'布林盤整',
  S20:'站回月線', S21:'月線反彈', S22:'突破月線放量',
  S29:'低波動盤整', S30:'超賣極值', S31:'DMI多頭放量', S32:'SAR翻多',
  S33:'GMMA多頭排列', S34:'RCI轉折向上', S35:'超跌遠離月線',
  S36:'EMA多頭交叉', S37:'三重頂量縮', S38:'三重底量縮',
  S40:'紅三兵', S42:'吞噬K線',
  S_STRONG:'強勢格局', S_ICHI_3GOOD:'一目三好', S_ICHI_CLOUD:'雲上多頭',
  S_ICHI_TK_CROSS:'TK金叉', XG1:'突破月線+DMI', XG3:'奪回月線放量',
  X1:'黃金比例', X2:'天黑請閉眼', X3:'炒底王', X5:'量證明一切', X6:'盤整突破',
  W1:'跌破月線', W2:'KD+MACD死叉', W3:'MACD死叉跌破月線', W4:'月線下量縮',
  W5:'連跌爆量', W6:'RSI超買', W7:'布林上軌超買', W8:'RSI弱勢跌破月線',
  W9:'KD死叉跌破月線', W10:'三指標空頭', W11:'雲下空頭',
  W12:'均線死亡排列', W13:'爆量下殺', W14:'MACD零軸上死叉',
  W15:'反彈失敗月線壓', W16:'TK死叉', W17:'DMI空頭', W18:'月線翻空',
  W19:'遠離下跌月線', W20:'高檔遠離下跌月線',
};

// ── 狀態 ─────────────────────────────────────────────────
let _pulse        = null;
let _aiResult     = null;   // 已匯入的 AI 分析結果
let _currentTab   = 'auto';
let _historyData  = [];     // 近期多空比重歷史（從 localStorage 讀）
let _twii         = null;   // 大盤統計（_loadTwiiStats 填入，供 prompt 用）

const HISTORY_KEY = 'mp_pulse_history';
const HISTORY_MAX = 10;

// ═══════════════════════════════════════════════════════
// 公開入口
// ═══════════════════════════════════════════════════════
export function initMarketPulse() {
  _renderTopbar();
  _bindModal();
  _loadHistory();
  // 還原上次匯入的 AI 分析結果
  try {
    const stored = localStorage.getItem('mp_ai_result');
    if (stored) _aiResult = JSON.parse(stored);
  } catch(e) {}
  // 等 snapshot 載入後更新
  window.addEventListener('snapshotReady', _onSnapshotReady);
  // 若 snapshot 已載入
  if (window.__snapshot?._pulse) {
    _onSnapshotReady();
  }
}

function _onSnapshotReady() {
  const snap = window.__snapshot;
  if (!snap?._pulse) return;
  _pulse = snap._pulse;
  _recordHistory(_pulse);
  _updateTopbar();
  _loadTwiiStats();
}

// 大盤統計：close / 漲跌 / 月線乖離 / 5日20日漲跌幅
// 來源：IDB kline_cache（R2 bundle 預載），失敗則 prompt 省略大盤段
async function _loadTwiiStats() {
  if (_twii) return;
  try {
    const cache = await getKlineCache('^TWII', '1y');
    const cs = cache?.candles;
    if (!cs || cs.length < 21) return;
    const last = cs.at(-1), prev = cs.at(-2);
    const ma20 = cs.slice(-20).reduce((s, k) => s + k.close, 0) / 20;
    const pct = (a, b) => b ? +((a - b) / b * 100).toFixed(2) : 0;
    const d = new Date((last.time ?? 0) * 1000);
    _twii = {
      date: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      close: last.close,
      chg1d: pct(last.close, prev.close),
      ma20: +ma20.toFixed(2),
      bias20: pct(last.close, ma20),
      chg5d: pct(last.close, cs.at(-6)?.close),
      chg20d: pct(last.close, cs.at(-21)?.close),
    };
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════
// Topbar
// ═══════════════════════════════════════════════════════
function _renderTopbar() {
  const container = document.getElementById('mpTopbarSlot');
  if (!container) return;
  container.innerHTML = `
    <div class="mp-topbar-wrap" id="mpTopbarBtn" role="button" tabindex="0" aria-label="開啟市場溫度計">
      <span class="mp-topbar-label">市場</span>
      <div class="mp-bar-track" style="position:relative;overflow:visible">
        <div class="mp-bar-gradient" id="mpBarGradient" style="width:100%"></div>
        <div class="mp-bar-divider" id="mpDivider1" style="position:absolute;top:20%;bottom:20%;width:1px;background:rgba(255,255,255,.2)"></div>
        <div class="mp-bar-divider" id="mpDivider2" style="position:absolute;top:20%;bottom:20%;width:1px;background:rgba(255,255,255,.2)"></div>
      </div>
      <span class="mp-pct-bull" id="mpPctBull">—</span>
      <span class="mp-pct-sep">/</span>
      <span class="mp-pct-neut" id="mpPctNeut">—</span>
      <span class="mp-pct-sep">/</span>
      <span class="mp-pct-bear" id="mpPctBear">—</span>
      <span class="mp-quality-badge" id="mpQualityBadge" style="display:none"></span>
    </div>`;

  document.getElementById('mpTopbarBtn').addEventListener('click', _openModal);
  document.getElementById('mpTopbarBtn').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') _openModal();
  });
}

function _updateTopbar() {
  if (!_pulse) return;
  const cb = _pulse.cbullRatio ?? 0;
  const cn = _pulse.cneutRatio ?? 0;
  const cs = _pulse.cbearRatio ?? 0;
  const neutEnd = cb + cn;

  const grad   = document.getElementById('mpBarGradient');
  const div1   = document.getElementById('mpDivider1');
  const div2   = document.getElementById('mpDivider2');
  const pctB   = document.getElementById('mpPctBull');
  const pctN   = document.getElementById('mpPctNeut');
  const pctS   = document.getElementById('mpPctBear');
  const qBadge = document.getElementById('mpQualityBadge');

  if (grad) grad.style.background =
    `linear-gradient(to right, #ef5350 0%, #ef5350 ${cb}%, #26a69a ${neutEnd}%, #26a69a 100%)`;
  if (div1) div1.style.left = cb + '%';
  if (div2) div2.style.left = neutEnd + '%';
  if (pctB) pctB.textContent = '多 ' + cb + '%';
  if (pctN) pctN.textContent = cn + '%';
  if (pctS) pctS.textContent = cs + '% 空';

  const quality = window.__snapshot?._quality;
  if (qBadge && quality) {
    qBadge.style.display = '';
    if (quality.pass) {
      qBadge.textContent = '驗算 ✓';
      qBadge.classList.remove('fail');
    } else {
      qBadge.textContent = '驗算 ✗';
      qBadge.classList.add('fail');
    }
  }
}

// ═══════════════════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════════════════
function _bindModal() {
  document.getElementById('mpModalClose')?.addEventListener('click', _closeModal);
  document.getElementById('mpModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('mpModal')) _closeModal();
  });
  document.querySelectorAll('.mp-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });
}

function _openModal() {
  if (!_pulse) return;
  // 匯入分析 Tab 只有 VVVIP 才能看到
  const isVvvip = (window.__userTier === 'vvvip');
  const importTab = document.querySelector('.mp-tab[data-tab="import"]');
  if (importTab) importTab.style.display = isVvvip ? '' : 'none';
  // 非 VVVIP 若目前在 import tab，切回 ai tab
  if (!isVvvip && _currentTab === 'import') _currentTab = 'ai';
  document.getElementById('mpModal')?.classList.add('active');
  _renderCurrentTab();
}

function _closeModal() {
  document.getElementById('mpModal')?.classList.remove('active');
}

function _switchTab(tab) {
  _currentTab = tab;
  document.querySelectorAll('.mp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.mp-tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('mpPanel_' + tab);
  if (panel) panel.style.display = 'flex';
  _renderCurrentTab();
}

function _renderCurrentTab() {
  if (!_pulse) return;
  if (_currentTab === 'auto')   _renderAutoTab();
  if (_currentTab === 'ai')     _renderAiTab();
  if (_currentTab === 'import') _renderImportTab();
}

// ── Tab 1：盤面分析（系統自動）───────────────────────────
function _renderAutoTab() {
  const panel = document.getElementById('mpPanel_auto');
  if (!panel) return;

  const cb = _pulse.cbullRatio ?? 0;
  const cn = _pulse.cneutRatio ?? 0;
  const cs = _pulse.cbearRatio ?? 0;
  const bullRatio = cb;
  const bearRatio = cs;
  const topBull   = _getTopSignal('bull');
  const topBear   = _getTopSignal('bear');
  const date      = window.__snapshot?.date ?? '—';
  const total     = _pulse.total ?? 0;

  const sigBarsHtml = _buildSigBarsHtml();
  const trendHtml   = _buildTrendHtml();
  const autoText    = _buildAutoAnalysis(bullRatio, bearRatio, topBull, topBear);
  const verdictHtml = _buildVerdict(bullRatio, bearRatio, topBear);

  panel.innerHTML = `
    <div class="mp-card">
      <div class="mp-card-label">多空訊號比重 · S / W 系列全市場</div>
      <div class="mp-ratio-bar">
        <div class="mp-ratio-gradient" style="background:linear-gradient(to right,#ef5350 0%,#ef5350 ${cb}%,#26a69a ${cb+cn}%,#26a69a 100%)"></div>
        <div class="mp-ratio-divider" style="left:${cb}%"></div>
        <div class="mp-ratio-divider" style="left:${cb+cn}%"></div>
        <span class="mp-ratio-bull">${cb}%</span>
        <span class="mp-ratio-neut" style="left:${cb + cn/2}%">${cn}%</span>
        <span class="mp-ratio-bear">${cs}%</span>
      </div>
      <div class="mp-ratio-foot">
        <span><span class="bull">確定多頭</span> <span class="cnt">${_fmtN(_pulse.confirmedBull ?? 0)} 支</span></span>
        <span><span style="color:var(--muted)">中性</span> <span class="cnt">${_fmtN(_pulse.confirmedNeutral ?? 0)} 支</span></span>
        <span><span class="cnt">${_fmtN(_pulse.confirmedBear ?? 0)} 支</span> <span class="bear">確定空頭</span></span>
      </div>
    </div>

    <div class="mp-sig2">
      <div class="mp-sig-chip">
        <div class="mp-sig-chip-label">最強多頭</div>
        <div class="mp-sig-chip-id bull">${topBull?.id ?? '—'}</div>
        <div class="mp-sig-chip-name">${topBull ? (STRATEGY_NAMES[topBull.id] ?? topBull.id) : '—'}</div>
        <div class="mp-sig-chip-count">${topBull ? _fmtN(topBull.count) + ' 支命中' : '無資料'}</div>
      </div>
      <div class="mp-sig-chip">
        <div class="mp-sig-chip-label">最強空頭</div>
        <div class="mp-sig-chip-id bear">${topBear?.id ?? '—'}</div>
        <div class="mp-sig-chip-name">${topBear ? (STRATEGY_NAMES[topBear.id] ?? topBear.id) : '—'}</div>
        <div class="mp-sig-chip-count">${topBear ? _fmtN(topBear.count) + ' 支命中' : '無資料'}</div>
      </div>
    </div>

    <div class="mp-card">
      <div class="mp-card-label">近期多頭訊號比重趨勢</div>
      <div class="mp-trend-bars" id="mpTrendBars">${trendHtml}</div>
    </div>

    <div class="mp-card">
      <div class="mp-card-label">今日訊號命中分布（前 6 名）</div>
      <div class="mp-bar-chart">${sigBarsHtml}</div>
    </div>

    <div class="mp-divider"></div>

    <div class="mp-auto-analysis">${autoText}</div>

    ${verdictHtml}

    <div style="font-size:10px;color:var(--hint);text-align:right">
      ${date} · ${_fmtN(total)} 支 · GAS Snapshot
    </div>`;
}

// ── Tab 2：AI 深度分析 ────────────────────────────────────
function _renderAiTab() {
  const panel = document.getElementById('mpPanel_ai');
  if (!panel) return;

  // 若本地沒有結果，先嘗試從 R2 讀取共享分析
  if (!_aiResult) {
    panel.innerHTML = `<div class="mp-empty">載入中...</div>`;
    _loadAiResultFromR2().then(r2Result => {
      if (r2Result) {
        _aiResult = r2Result;
        localStorage.setItem('mp_ai_result', JSON.stringify(r2Result));
        _renderAiTab();  // 重新渲染
      } else {
        const isVvvip = window.__userTier === 'vvvip';
        panel.innerHTML = `<div class="mp-empty">尚未有 AI 分析<br><span style="font-size:12px;color:var(--hint)">${isVvvip ? '請至「匯入分析」頁面操作' : '等待每日 VVVIP 更新'}</span></div>`;
      }
    });
    return;
  }

  const ai = _aiResult;
  const verify = _verifyAiResult(ai);
  const sentimentCls = ai.sentiment === 'bullish' ? 'bull' : ai.sentiment === 'bearish' ? 'bear' : 'warn';
  const sentimentLabel = ai.sentiment === 'bullish' ? '偏多' : ai.sentiment === 'bearish' ? '偏空' : '中性';
  const positionLabel = ai.strength >= 4 ? '觀望' : ai.strength >= 3 ? '輕倉' : '正常';

  const verifyRows = verify.rows.map(r => `
    <div class="mp-verify-row">
      <span class="mp-verify-icon">${r.pass ? '✓' : r.warn ? '△' : '✗'}</span>
      <span class="mp-verify-text">${r.text}</span>
      <span class="mp-verify-result ${r.pass ? '' : r.warn ? 'warn' : 'fail'}">${r.result}</span>
    </div>`).join('');

  const watchHtml = (ai.watchSignals ?? []).map(id => {
    const name = STRATEGY_NAMES[id] ?? id;  // 有中文名用中文，沒有才顯示 id
    const isBear = id.startsWith('W');
    const color = isBear ? 'var(--up)' : 'var(--down)';
    return `<span title="${id}" style="font-size:11px;padding:2px 8px;border-radius:5px;background:var(--bg3);color:${color};border:1px solid var(--border);white-space:nowrap">${name}</span>`;
  }).join('');

  // key_signals HTML
  const ksHtml = ai.key_signals ? `
    <div style="display:flex;gap:8px;margin-bottom:9px">
      ${ai.key_signals.bull ? `<div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:8px 10px">
        <div style="font-size:10px;color:var(--muted);font-weight:600;margin-bottom:3px">📈 多頭主訊號</div>
        <div style="font-size:13px;font-weight:700;color:var(--down)">${_esc(ai.key_signals.bull.name ?? ai.key_signals.bull.id)}</div>
        <div style="font-size:11px;color:var(--text);line-height:1.5;margin-top:3px">${_esc(ai.key_signals.bull.meaning ?? '')}</div>
        <div style="font-size:10px;color:var(--hint);margin-top:4px">${_fmtN(ai.key_signals.bull.count ?? 0)} 支命中</div>
      </div>` : ''}
      ${ai.key_signals.bear ? `<div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:8px 10px">
        <div style="font-size:10px;color:var(--muted);font-weight:600;margin-bottom:3px">📉 空頭主訊號</div>
        <div style="font-size:13px;font-weight:700;color:var(--up)">${_esc(ai.key_signals.bear.name ?? ai.key_signals.bear.id)}</div>
        <div style="font-size:11px;color:var(--text);line-height:1.5;margin-top:3px">${_esc(ai.key_signals.bear.meaning ?? '')}</div>
        <div style="font-size:10px;color:var(--hint);margin-top:4px">${_fmtN(ai.key_signals.bear.count ?? 0)} 支命中</div>
      </div>` : ''}
    </div>` : '';

  // 三段式分析
  const analysisHtml = [
    ai.trend         ? `<div class="mp-aa-section bear"><div class="mp-aa-title">趨勢</div><div class="mp-aa-text">${_esc(ai.trend)}</div></div>` : '',
    ai.risk_opportunity ? `<div class="mp-aa-section neutral"><div class="mp-aa-title">風險與機會</div><div class="mp-aa-text">${_esc(ai.risk_opportunity)}</div></div>` : '',
    ai.suggestion    ? `<div class="mp-aa-section bull"><div class="mp-aa-title">操作建議</div><div class="mp-aa-text">${_esc(ai.suggestion)}</div></div>` : '',
  ].filter(Boolean).join('');

  panel.innerHTML = `
    <div class="mp-ai-blk">
      <div class="mp-ai-hd">
        <i class="ti ti-brain" style="font-size:15px;color:var(--muted)" aria-hidden="true"></i>
        <span class="mp-ai-hd-title">AI 盤面深度分析</span>
        <span class="mp-ai-badge ${verify.pass ? 'ok' : verify.warn ? 'wait' : 'fail'}">${verify.pass ? '已驗算' : verify.warn ? '部分警告' : '驗算失敗'}</span>
      </div>
      <div class="mp-ai-bd">
        <div class="mp-ai-summary">${_esc(ai.summary ?? '')}</div>
        ${ai.market_story ? `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-bottom:9px;padding:6px 10px;border-left:2px solid var(--border2)">市場故事：${_esc(ai.market_story)}</div>` : ''}
        <div class="mp-ai-3col">
          <div class="mp-ai-3c"><div class="mp-ai-3c-label">市場情緒</div><div class="mp-ai-3c-val ${sentimentCls}">${sentimentLabel}</div></div>
          <div class="mp-ai-3c">
            <div class="mp-ai-3c-label">強度 / 風險</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:2px">
              <span class="mp-ai-3c-val ${ai.strength >= 4 ? 'bear' : ai.strength >= 3 ? 'warn' : 'bull'}" style="font-size:13px">${ai.strength ?? '—'}<span style="font-size:9px;color:var(--hint)">/5</span></span>
              <span style="color:var(--hint);font-size:10px">·</span>
              <span class="mp-ai-3c-val ${(ai.riskScore ?? 0) >= 4 ? 'bull' : (ai.riskScore ?? 0) >= 3 ? 'warn' : 'bear'}" style="font-size:13px">${ai.riskScore ?? '—'}<span style="font-size:9px;color:var(--hint)">/5</span></span>
            </div>
          </div>
          <div class="mp-ai-3c"><div class="mp-ai-3c-label">整體評估</div><div class="mp-ai-3c-val warn" style="font-size:11px">${_esc(ai.consensus ?? positionLabel)}</div></div>
        </div>
        ${ksHtml}
        ${analysisHtml ? `<div class="mp-auto-analysis" style="margin-bottom:9px">${analysisHtml}</div>` : ''}
        <div class="mp-verify-blk">
          <div class="mp-verify-title">訊號驗算 · 系統交叉比對</div>
          ${verifyRows}
        </div>
        ${watchHtml ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px">${watchHtml}</div>` : ''}
        ${ai.outlook ? `<div class="mp-outlook-blk"><div class="mp-outlook-title">未來 1–3 日展望</div><div class="mp-outlook-text">${_esc(ai.outlook)}</div></div>` : ''}
        <div style="font-size:10px;color:var(--hint);margin-top:8px;text-align:right">AI 推理，僅供參考 · ${ai.checkedAt ?? '—'}</div>
      </div>
    </div>`;
}

// ── Tab 3：匯入分析 ───────────────────────────────────────
function _renderImportTab() {
  const panel = document.getElementById('mpPanel_import');
  if (!panel) return;

  const promptStr = _buildPrompt();

  panel.innerHTML = `
    <div class="mp-ai-blk">
      <div class="mp-ai-hd">
        <i class="ti ti-clipboard-text" style="font-size:15px;color:var(--muted)" aria-hidden="true"></i>
        <span class="mp-ai-hd-title">複製 Prompt → 貼給 AI → 匯入 JSON</span>
        <span class="mp-ai-badge wait">待匯入</span>
      </div>
      <div class="mp-ai-bd">
        <div class="mp-prompt-area" id="mpPromptArea">${_esc(promptStr)}</div>
        <div class="mp-btn-row">
          <button class="mp-btn-copy" id="mpBtnCopy">
            <i class="ti ti-copy" style="font-size:12px;vertical-align:-1px" aria-hidden="true"></i> 複製 Prompt
          </button>
        </div>
        <div class="mp-import-label">貼上 AI 回傳的 JSON</div>
        <textarea class="mp-import-ta" id="mpImportJson"
          placeholder='{"sentiment":"bearish","strength":4,"summary":"...","analysis":"...","keyRisk":"...","suggestion":"...","watchSignals":["W1","S5"],"outlook":"...","checkedAt":"2026-06-07"}'></textarea>
        <button class="mp-btn-import" id="mpBtnImport">匯入並驗算</button>
        <div id="mpVerifyResult"></div>
      </div>
    </div>`;

  document.getElementById('mpBtnCopy')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(promptStr).catch(() => {});
    const btn = document.getElementById('mpBtnCopy');
    if (btn) {
      btn.textContent = '已複製！';
      setTimeout(() => {
        btn.innerHTML = '<i class="ti ti-copy" style="font-size:12px;vertical-align:-1px"></i> 複製 Prompt';
      }, 1500);
    }
    window.dengToast?.('Prompt 已複製，貼給你的 AI 吧', { mood: 'happy', duration: 2500 });
  });

  document.getElementById('mpBtnImport')?.addEventListener('click', _handleImport);
}

function _handleImport() {
  const raw = (document.getElementById('mpImportJson')?.value ?? '').trim();
  const el  = document.getElementById('mpVerifyResult');
  if (!el) return;

  if (!raw) {
    el.innerHTML = '<div class="mp-verify-result-blk warn">請先貼上 AI 回傳的 JSON</div>';
    return;
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch(e) {
    el.innerHTML = '<div class="mp-verify-result-blk fail">JSON 格式錯誤，請確認格式</div>';
    return;
  }

  const verify = _verifyAiResult(parsed);
  if (!verify.pass && !verify.warn) {
    el.innerHTML = `<div class="mp-verify-result-blk fail">驗算失敗<br>${verify.rows.filter(r=>!r.pass&&!r.warn).map(r=>'✗ '+r.text+' · '+r.result).join('<br>')}</div>`;
    return;
  }

  _aiResult = parsed;
  localStorage.setItem('mp_ai_result', JSON.stringify(parsed));

  // VVVIP：匯入成功後寫入 R2，讓所有用戶共享
  if (window.__userTier === 'vvvip') {
    _writeAiResultToR2(parsed).then(() => {
      console.log('[market-pulse] AI 分析已寫入 R2 共享');
    }).catch(e => console.warn('[market-pulse] R2 寫入失敗:', e.message));
  }

  if (verify.warn) {
    el.innerHTML = `<div class="mp-verify-result-blk warn">驗算通過，有警告<br>${verify.rows.filter(r=>r.warn).map(r=>'△ '+r.text+' · '+r.result).join('<br>')}<br>已匯入，可切換至「AI 深度分析」查看</div>`;
  } else {
    el.innerHTML = `<div class="mp-verify-result-blk ok">驗算通過，已匯入<br>情緒：${parsed.sentiment} · 強度：${parsed.strength}/5<br>切換至「AI 深度分析」查看完整內容</div>`;
  }
}

// ═══════════════════════════════════════════════════════
// R2 共享 AI 分析結果
// ═══════════════════════════════════════════════════════
const _AI_R2_KEY    = 'signals:market:ai_analysis';
const _WORKER_BASE  = 'https://stock-2027.luffy0606.workers.dev';
const _PROXY_TOKEN  = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';

/** VVVIP 匯入後寫入 R2，供所有用戶共享 */
async function _writeAiResultToR2(parsed) {
  const payload = JSON.stringify({
    ...parsed,
    _sharedAt: new Date().toISOString(),
    _sharedDate: new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '-'),
  });
  const res = await fetch(_WORKER_BASE + '/r2put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': _PROXY_TOKEN },
    body: JSON.stringify([{ key: _AI_R2_KEY, value: payload }]),
  });
  if (!res.ok) throw new Error('R2 write failed: ' + res.status);
}

/** 從 R2 讀取共享 AI 分析結果（今日有效才使用）*/
async function _loadAiResultFromR2() {
  try {
    const res = await fetch(_WORKER_BASE + '/market-ai', {
      headers: { 'X-Proxy-Token': _PROXY_TOKEN },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.sentiment) return null;
    // 只用今日的分析
    const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '-');
    if (data._sharedDate && data._sharedDate !== today) {
      console.log('[market-pulse] R2 AI 分析是昨日的，仍使用（未有今日更新）');
    }
    return data;
  } catch(e) {
    console.warn('[market-pulse] 讀取 R2 AI 分析失敗:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// 計算工具
// ═══════════════════════════════════════════════════════

function _calcBullRatio() {
  if (!_pulse) return 50;
  // bullTotal/bearTotal 不在 GAS _pulse 裡，改用各 id 命中次數加總
  const b = Object.values(_pulse.bullCounts ?? {}).reduce((s, n) => s + n, 0);
  const s = Object.values(_pulse.bearCounts ?? {}).reduce((s, n) => s + n, 0);
  const total = b + s;
  if (total === 0) return 50;
  return Math.round(b / total * 100);
}

function _calcBullTotal() {
  if (!_pulse) return 0;
  return Object.values(_pulse.bullCounts ?? {}).reduce((s, n) => s + n, 0);
}

function _calcBearTotal() {
  if (!_pulse) return 0;
  return Object.values(_pulse.bearCounts ?? {}).reduce((s, n) => s + n, 0);
}

function _getTopSignal(side) {
  if (!_pulse) return null;
  const counts = side === 'bull' ? (_pulse.bullCounts ?? {}) : (_pulse.bearCounts ?? {});
  let topId = null, topCount = 0;
  Object.entries(counts).forEach(([id, cnt]) => {
    if (cnt > topCount) { topCount = cnt; topId = id; }
  });
  return topId ? { id: topId, count: topCount } : null;
}

function _getTopSignals(side, n = 6) {
  if (!_pulse) return [];
  const counts = side === 'bull' ? (_pulse.bullCounts ?? {}) : (_pulse.bearCounts ?? {});
  return Object.entries(counts)
    .filter(([,cnt]) => cnt > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, count]) => ({ id, count, side }));
}

function _buildSigBarsHtml() {
  const bulls = _getTopSignals('bull', 3);
  const bears = _getTopSignals('bear', 3);
  const all = [...bears, ...bulls].sort((a, b) => b.count - a.count).slice(0, 6);
  if (!all.length) return '<div style="color:var(--hint);font-size:12px">無資料</div>';
  const maxC = Math.max(...all.map(s => s.count));
  return all.map(s => {
    const w = Math.round(s.count / maxC * 100);
    const c = s.side === 'bull' ? 'var(--down)' : 'var(--up)';
    const cls = s.side === 'bull' ? 'bull' : 'bear';
    return `<div class="mp-bc-row">
      <span class="mp-bc-id ${cls}">${s.id}</span>
      <div class="mp-bc-track"><div class="mp-bc-fill" style="width:${w}%;background:${c}"></div></div>
      <span class="mp-bc-num">${_fmtN(s.count)}</span>
    </div>`;
  }).join('');
}

function _buildTrendHtml() {
  if (!_historyData.length) return '<div style="color:var(--hint);font-size:11px">歷史資料累積中</div>';
  const recent = _historyData.slice(-7);
  const maxV = Math.max(...recent.map(d => d.bullRatio), 1);
  return recent.map((d, i) => {
    const h = Math.round((d.bullRatio / maxV) * 38) + 4;
    const c = d.bullRatio >= 55 ? 'var(--down)' : d.bullRatio >= 40 ? '#f59e0b' : 'var(--up)';
    const op = i === recent.length - 1 ? 1 : 0.45;
    const label = d.date?.slice(5) ?? '';
    return `<div class="mp-trend-col">
      <div class="mp-trend-bar" style="height:${h}px;background:${c};opacity:${op}"></div>
      <span class="mp-trend-date">${label}</span>
    </div>`;
  }).join('');
}

function _buildAutoAnalysis(bullRatio, bearRatio, topBull, topBear) {
  const topBullName = topBull ? (STRATEGY_NAMES[topBull.id] ?? topBull.id) : '—';
  const topBearName = topBear ? (STRATEGY_NAMES[topBear.id] ?? topBear.id) : '—';
  const topBullPct  = topBull && _pulse.total ? ((topBull.count / _pulse.total) * 100).toFixed(1) : '—';
  const topBearPct  = topBear && _pulse.total ? ((topBear.count / _pulse.total) * 100).toFixed(1) : '—';

  // 趨勢判斷
  let trendText = '';
  if (bearRatio >= 65) {
    trendText = `空方全面主導，<span class="mp-aa-hl bear">${topBear?.id} ${topBearName}</span>觸發 ${_fmtN(topBear?.count ?? 0)} 支（佔全市場 ${topBearPct}%），賣壓結構性擴散。`;
  } else if (bullRatio >= 65) {
    trendText = `多方全面主導，<span class="mp-aa-hl bull">${topBull?.id} ${topBullName}</span>觸發 ${_fmtN(topBull?.count ?? 0)} 支（佔全市場 ${topBullPct}%），買盤積極。`;
  } else if (bullRatio >= 50) {
    trendText = `多空均衡偏多，<span class="mp-aa-hl bull">${topBull?.id} ${topBullName}</span>為最強多頭訊號（${topBullPct}%），整體偏樂觀。`;
  } else {
    trendText = `多空均衡偏空，<span class="mp-aa-hl bear">${topBear?.id} ${topBearName}</span>為最強空頭訊號（${topBearPct}%），需審慎。`;
  }

  // 風險與機會（用確定多空股票數，直觀易懂）
  const cBull = _pulse.confirmedBull ?? 0;
  const cBear = _pulse.confirmedBear ?? 0;
  const cNeut = _pulse.confirmedNeutral ?? 0;
  let riskText = '';

  if (bearRatio >= 45) {
    // 空方強勢
    const extraBull = topBull && topBull.count > 150
      ? `，但 <span class="mp-aa-hl bull">${topBull.id} ${topBullName}</span>（${_fmtN(topBull.count)} 支）仍顯示逢低承接跡象`
      : '';
    riskText = `確定空頭 <span class="mp-aa-hl bear">${_fmtN(cBear)} 支（${bearRatio}%）</span>，確定多頭 ${_fmtN(cBull)} 支（${bullRatio}%）${extraBull}。中性觀望 ${_fmtN(cNeut)} 支待方向確立。`;
  } else if (bullRatio >= 45) {
    // 多方強勢
    riskText = `確定多頭 <span class="mp-aa-hl bull">${_fmtN(cBull)} 支（${bullRatio}%）</span>強勢領跑，確定空頭僅 ${_fmtN(cBear)} 支（${bearRatio}%）。仍有 ${_fmtN(cNeut)} 支（${Math.round(_pulse.cneutRatio ?? 0)}%）處於中性區間，可能成為下一波追漲動能。`;
  } else {
    // 均衡
    riskText = `確定多頭 <span class="mp-aa-hl bull">${_fmtN(cBull)} 支（${bullRatio}%）</span>與確定空頭 <span class="mp-aa-hl bear">${_fmtN(cBear)} 支（${bearRatio}%）</span>力道接近，中性盤整 ${_fmtN(cNeut)} 支（${Math.round(_pulse.cneutRatio ?? 0)}%）待方向選擇。建議精選強勢族群，避免全面押注。`;
  }

  // 操作建議
  let suggText = '';
  if (bearRatio >= 70) {
    suggText = `空頭比重 <span class="mp-aa-hl warn">${bearRatio}%</span> 已達高警戒區間（&gt;70%），建議以空倉觀望為主。若明日空頭比重縮減至 60% 以下且多頭比重同步提升，可視為止跌訊號出現。`;
  } else if (bearRatio >= 55) {
    suggText = `空頭比重 <span class="mp-aa-hl warn">${bearRatio}%</span> 偏高，短線操作宜輕倉。可追蹤 ${topBull?.id ?? 'S5'} 等逆勢強勢個股，設定嚴格停損。`;
  } else if (bullRatio >= 65) {
    suggText = `多頭比重 <span class="mp-aa-hl bull">${bullRatio}%</span> 強勢，市場環境有利做多。可積極尋找符合 ${topBull?.id ?? 'S1'} 等強勢策略的個股，順勢操作。`;
  } else {
    suggText = `多空比重接近均衡（多 ${bullRatio}% / 空 ${bearRatio}%），建議精選個股而非追方向。族群輪動訊號需重點觀察。`;
  }

  return `
    <div class="mp-aa-section bear">
      <div class="mp-aa-title">趨勢</div>
      <div class="mp-aa-text">${trendText}</div>
    </div>
    <div class="mp-aa-section neutral">
      <div class="mp-aa-title">風險與機會</div>
      <div class="mp-aa-text">${riskText}</div>
    </div>
    <div class="mp-aa-section bull">
      <div class="mp-aa-title">操作建議</div>
      <div class="mp-aa-text">${suggText}</div>
    </div>`;
}

function _buildVerdict(bullRatio, bearRatio, topBear) {
  let icon, main, sub;
  if (bearRatio >= 70) {
    icon = '⚠️'; main = '空方主導，建議觀望';
    sub = `${bearRatio}% 個股空頭訊號 · 等待量縮止跌`;
  } else if (bearRatio >= 55) {
    icon = '⚡'; main = '偏空格局，輕倉為宜';
    sub = `空頭比重 ${bearRatio}% · 選擇性操作`;
  } else if (bullRatio >= 65) {
    icon = '🚀'; main = '多方主導，積極做多';
    sub = `多頭比重 ${bullRatio}% · 順勢佈局`;
  } else {
    icon = '⚖️'; main = '多空均衡，精選個股';
    sub = `多 ${bullRatio}% / 空 ${bearRatio}% · 族群輪動`;
  }
  return `<div class="mp-verdict">
    <span class="mp-verdict-icon">${icon}</span>
    <div>
      <div class="mp-verdict-main">${main}</div>
      <div class="mp-verdict-sub">${sub}</div>
    </div>
  </div>`;
}

function _verifyAiResult(ai) {
  if (!_pulse || !ai) return { pass: false, warn: false, rows: [] };
  const cb = _pulse.cbullRatio ?? 0;
  const cs = _pulse.cbearRatio ?? 0;
  const topBull = _getTopSignal('bull');
  const topBear = _getTopSignal('bear');
  const rows = [];
  let hasError = false, hasWarn = false;

  // 1. 情緒方向 vs 確定多空比重
  const sentimentLabel = { bullish:'偏多', bearish:'偏空', neutral:'中性' }[ai.sentiment] ?? ai.sentiment;
  if (ai.sentiment === 'bearish' && cs >= 30) {
    rows.push({ pass:true, warn:false, text:`AI 判斷${sentimentLabel}`, result:`確定空頭 ${cs}% · 吻合` });
  } else if (ai.sentiment === 'bullish' && cb >= 40) {
    rows.push({ pass:true, warn:false, text:`AI 判斷${sentimentLabel}`, result:`確定多頭 ${cb}% · 吻合` });
  } else if (ai.sentiment === 'neutral' && Math.abs(cb - cs) < 20) {
    rows.push({ pass:true, warn:false, text:`AI 判斷${sentimentLabel}`, result:`多空差距 ${Math.abs(cb-cs)}% · 吻合` });
  } else {
    rows.push({ pass:false, warn:false, text:`AI 判斷${sentimentLabel}`, result:`確定多頭 ${cb}% / 空頭 ${cs}% · 方向矛盾` });
    hasError = true;
  }

  // 2. 強度評分合理性
  // strength = 「方向」的強度：bearish + 極端空頭給高分是一致，不是矛盾
  const extremeBear = cs >= 35, extremeBull = cb >= 55;
  if (ai.strength >= 4 && extremeBear && ai.sentiment !== 'bearish') {
    rows.push({ pass:false, warn:true, text:`強度評分 ${ai.strength}/5 偏高`, result:`確定空頭 ${cs}% 但情緒非偏空 · 建議降至 3` });
    hasWarn = true;
  } else if (ai.strength >= 4 && extremeBull && ai.sentiment !== 'bullish') {
    rows.push({ pass:false, warn:true, text:`強度評分 ${ai.strength}/5 偏高`, result:`確定多頭 ${cb}% 但情緒非偏多 · 建議降至 3` });
    hasWarn = true;
  } else if (ai.strength <= 2 && (extremeBear || extremeBull)) {
    rows.push({ pass:false, warn:true, text:`強度評分 ${ai.strength}/5 偏低`, result:`市場方向明確 · 建議提高` });
    hasWarn = true;
  } else {
    rows.push({ pass:true, warn:false, text:`強度評分 ${ai.strength}/5`, result:'合理' });
  }

  // 3. key_signals 驗算（AI 說的最強多空是否與實際吻合）
  if (ai.key_signals?.bull?.id && topBull) {
    if (ai.key_signals.bull.id === topBull.id) {
      rows.push({ pass:true, warn:false, text:`多頭主訊號 ${ai.key_signals.bull.id}`, result:`命中 ${_fmtN(topBull.count)} 支 · 吻合` });
      if (ai.key_signals.bull.count !== topBull.count) {
        rows.push({ pass:false, warn:true, text:`多頭主訊號 count ${_fmtN(ai.key_signals.bull.count)}`, result:`實際 ${_fmtN(topBull.count)} 支 · AI 數字錯誤` });
        hasWarn = true;
      }
    } else {
      const aiCount = (_pulse.bullCounts ?? {})[ai.key_signals.bull.id] ?? 0;
      rows.push({ pass:false, warn:true, text:`多頭主訊號 ${ai.key_signals.bull.id}`, result:`實際最強為 ${topBull.id}（${_fmtN(topBull.count)} 支）` });
      hasWarn = true;
    }
  }
  if (ai.key_signals?.bear?.id && topBear) {
    if (ai.key_signals.bear.id === topBear.id) {
      rows.push({ pass:true, warn:false, text:`空頭主訊號 ${ai.key_signals.bear.id}`, result:`命中 ${_fmtN(topBear.count)} 支 · 吻合` });
      if (ai.key_signals.bear.count !== topBear.count) {
        rows.push({ pass:false, warn:true, text:`空頭主訊號 count ${_fmtN(ai.key_signals.bear.count)}`, result:`實際 ${_fmtN(topBear.count)} 支 · AI 數字錯誤` });
        hasWarn = true;
      }
    } else {
      rows.push({ pass:false, warn:true, text:`空頭主訊號 ${ai.key_signals.bear.id}`, result:`實際最強為 ${topBear.id}（${_fmtN(topBear.count)} 支）` });
      hasWarn = true;
    }
  }

  // 4. watchSignals 覆蓋度（必須包含 key_signals 的 bull/bear id）
  const watched = ai.watchSignals ?? [];
  const keyBullId = ai.key_signals?.bull?.id;
  const keyBearId = ai.key_signals?.bear?.id;
  const keyBullInWatch = keyBullId && watched.includes(keyBullId);
  const keyBearInWatch = keyBearId && watched.includes(keyBearId);
  if (keyBullInWatch && keyBearInWatch) {
    rows.push({ pass:true, warn:false, text:'觀察清單覆蓋主訊號', result:'多空主訊號均已列入' });
  } else {
    if (!keyBullInWatch && keyBullId) {
      rows.push({ pass:false, warn:true, text:`${keyBullId} 未列入觀察`, result:`為 key_signals.bull，應加入 watchSignals` });
      hasWarn = true;
    }
    if (!keyBearInWatch && keyBearId) {
      rows.push({ pass:false, warn:true, text:`${keyBearId} 未列入觀察`, result:`為 key_signals.bear，應加入 watchSignals` });
      hasWarn = true;
    }
  }

  // 4b. watchSignals id 合法性（幻覺 id 防呆）
  const knownIds = new Set([...Object.keys(_pulse.bullCounts ?? {}), ...Object.keys(_pulse.bearCounts ?? {}), ...Object.keys(STRATEGY_NAMES)]);
  const unknownIds = watched.filter(id => !knownIds.has(id));
  if (unknownIds.length) {
    rows.push({ pass:false, warn:true, text:`未知訊號 id：${unknownIds.join('、')}`, result:'不存在於系統，AI 幻覺' });
    hasWarn = true;
  }

  // 5. riskScore 合理性
  if (ai.riskScore != null) {
    const expectRisk = cs >= 35 ? 4 : cs >= 20 ? 3 : 2;
    if (Math.abs(ai.riskScore - expectRisk) <= 1) {
      rows.push({ pass:true, warn:false, text:`風險評分 ${ai.riskScore}/5`, result:'合理' });
    } else {
      rows.push({ pass:false, warn:true, text:`風險評分 ${ai.riskScore}/5`, result:`建議 ${expectRisk}（依確定空頭比重推算）` });
      hasWarn = true;
    }
  }

  // 6. Snapshot 品質
  const quality = window.__snapshot?._quality;
  if (quality?.pass) {
    rows.push({ pass:true, warn:false, text:'Snapshot 驗算品質', result:`偏差率 ${quality.rate}% · 數據可信` });
  } else if (quality) {
    rows.push({ pass:false, warn:true, text:'Snapshot 驗算品質', result:`偏差率 ${quality.rate}% · 數據可信度降低` });
    hasWarn = true;
  }

  return { pass: !hasError, warn: hasWarn, rows };
}

function _buildPrompt() {
  if (!_pulse) return '';
  const date    = window.__snapshot?.date ?? '—';
  const total   = _pulse.total ?? 0;
  const cb = _pulse.cbullRatio ?? 0;
  const cs = _pulse.cbearRatio ?? 0;
  const cn = _pulse.cneutRatio ?? 0;
  const cBull = _pulse.confirmedBull ?? 0;
  const cBear = _pulse.confirmedBear ?? 0;
  const cNeut = _pulse.confirmedNeutral ?? 0;
  const bullTop5 = _getTopSignals('bull', 5).map(s => `${s.id} ${STRATEGY_NAMES[s.id] ?? s.id}:${s.count}支`).join('、');
  const bearTop5 = _getTopSignals('bear', 5).map(s => `${s.id} ${STRATEGY_NAMES[s.id] ?? s.id}:${s.count}支`).join('、');

  // 大盤段（_loadTwiiStats 已完成才附）
  let twiiBlock = '';
  if (_twii) {
    const twiiStale = _twii.date && date !== '—' && !String(date).endsWith(_twii.date);
    twiiBlock = `
加權指數（資料日 ${_twii.date}${twiiStale ? '，較訊號數據舊一日，僅供趨勢參考' : ''}）：${_fmtN(_twii.close)} 點（當日 ${_twii.chg1d >= 0 ? '+' : ''}${_twii.chg1d}%）
指數月線（MA20）：${_fmtN(_twii.ma20)}，乖離 ${_twii.bias20 >= 0 ? '+' : ''}${_twii.bias20}%
近5日漲跌幅：${_twii.chg5d >= 0 ? '+' : ''}${_twii.chg5d}%，近20日：${_twii.chg20d >= 0 ? '+' : ''}${_twii.chg20d}%
`;
  }

  // 近5日確定多空序列（≥2 筆才附，含今日）
  let histBlock = '';
  const hist = (_historyData ?? []).filter(d => d.cbull != null).slice(-5);
  if (hist.length >= 2) {
    histBlock = `
近${hist.length}日確定多空比重變化（舊→新）：
${hist.map(d => `${d.date.slice(5)} 多${d.cbull}%/空${d.cbear}%`).join(' → ')}
`;
  }

  return `你是台股量化分析師，請根據以下全市場技術訊號數據，提供具深度參考價值的盤面分析。

【市場數據】資料基準日：${date}，樣本：${_fmtN(total)} 支股票

確定多頭（站上月線且月線上揚）：${_fmtN(cBull)} 支（${cb}%）
確定空頭（跌破月線且月線下彎）：${_fmtN(cBear)} 支（${cs}%）
中性盤整（月線附近或方向未明）：${_fmtN(cNeut)} 支（${cn}%）
${twiiBlock}${histBlock}
多頭訊號前5（目前符合條件的股票數，為當前狀態統計，非當日新增）：${bullTop5 || '無'}
空頭訊號前5（同上，為當前狀態統計，非當日新增）：${bearTop5 || '無'}

台股慣例：紅=漲=多頭，綠=跌=空頭。

【硬性限制】
- 只能根據上方提供的數據分析。未提供的資訊（產業輪動、外資買賣超、個別族群、營收、消息面）一律禁止臆測或編造。
- 文中引用的所有數字必須與上方數據一致，不可自行推算未提供的統計。
- key_signals 的 count 必須照抄上方訊號命中次數，不可改動。
- watchSignals 只能使用上方出現過的訊號 id。

【分析要求】
1. market_story：用一句話描述數據呈現的市場結構核心狀態（例：指數守穩月線但個股普遍轉弱的背離格局），只根據數據，不講題材故事
2. trend：趨勢結構（月線分布意義、主導力量${histBlock ? '、多空比重變化方向' : ''}${twiiBlock ? '、指數與個股廣度的關係' : ''}），約60字
3. risk_opportunity：當前最大風險與潛在機會（從訊號分布推論，例如哪種技術型態的股票風險高/有機會），約60字
4. suggestion：操作建議（部位、節奏、選股條件，具體可執行），約40字
5. key_signals：從上方前5名中各選最強多頭與空頭訊號，name 只填中文名稱（不含 id），meaning 用一般投資人聽得懂的白話說明

【文字風格】淺白易懂、像跟朋友解釋盤勢，但描述必須精準：分清楚「目前處於某狀態」和「今天剛發生」，不可混用；數字照抄不改寫。

只回覆以下 JSON，不要加 markdown 標記或其他說明。請確認用語正確，不要有錯別字：
{
  "sentiment": "bullish|bearish|neutral",
  "strength": 1-5,
  "summary": "一句話盤面總結，30字內，專業精準",
  "market_story": "數據呈現的市場結構，一句話",
  "trend": "趨勢分析，約60字",
  "risk_opportunity": "風險與機會，約60字",
  "suggestion": "操作建議，約40字",
  "key_signals": {
    "bull": { "id": "訊號id", "name": "訊號名稱", "count": 0, "meaning": "此訊號的市場意義，20字內" },
    "bear": { "id": "訊號id", "name": "訊號名稱", "count": 0, "meaning": "此訊號的市場意義，20字內" }
  },
  "watchSignals": ["S33", "W1", "S5"],
  "outlook": "未來1-3日展望，50字內",
  "riskScore": 1-5,
  "consensus": "整體評估一句話結論，20字內",
  "checkedAt": "${date}"
}

watchSignals 規則：必須包含 key_signals.bull.id 與 key_signals.bear.id，再加 1-3 個值得追蹤的訊號 id，共 3-5 個，全部為純 id 字串。`;
}

// ── 歷史記錄 ─────────────────────────────────────────────
function _recordHistory(pulse) {
  if (!pulse?.date) return;
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    const exists = stored.findIndex(d => d.date === pulse.date);
    const bullRatio = _calcBullRatio();
    const entry = { date: pulse.date, bullRatio, cbull: pulse.cbullRatio ?? null, cbear: pulse.cbearRatio ?? null };
    if (exists >= 0) stored[exists] = entry;
    else stored.push(entry);
    // 保留最近 N 筆
    if (stored.length > HISTORY_MAX) stored.splice(0, stored.length - HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(stored));
    _historyData = stored;
  } catch(e) {}
}

function _loadHistory() {
  try {
    _historyData = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch(e) { _historyData = []; }
}

// ── 工具 ─────────────────────────────────────────────────
function _fmtN(n) { return Number(n).toLocaleString(); }
function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
