/**
 * lab-tribunal.js — ⚖️ 策略鑑定所（A8 §七 一條龍處刑場）
 *
 * 對外 API：
 *   bindTribunalRun()                    ← strategy-lab.js lazy init
 *   openTribunal(payload)                ← 外部跳轉（lab-discovered 晉升鈕帶候選進來）
 *     payload = { kind:'candidate'|'strategy', label, entryIds?, customStrategies?,
 *                 hold?, exitMode?, stopPct?, trailPct?, foundTs? }
 *
 * 流程（單一引擎）：
 *   取數(fetchHistAll + fetchBenchmark) → runBacktest 一次
 *     → calcMetrics（既有）→ calcRiskProfile + judgeGates（tribunal-core）
 *     → stepper 四關亮燈 + 八維風險報表 + 五圖 + Markdown 匯出
 *
 * 鐵律：四關與風險指標全部來自「同一次 runBacktest」，禁止各關各跑。
 */

import { fetchHistAll, fetchBenchmark, fetchAllHistCodes } from './api-hist.js';
import { runBacktest, isStrategyBacktestable } from './backtest-engine.js';
import { calcMetrics } from './backtest-metrics.js';
import { calcRiskProfile, judgeGates, wilsonInterval } from './tribunal-core.js';
import { STRATEGIES } from './strategy.js';
import { dengToast } from './loading-deng.js';

let _running = false;
let _lastReport = null;   // 供 Markdown 匯出
const _charts = [];       // LightweightCharts 實例，重跑前清理

// 台股慣例：紅漲綠跌
const C_UP = '#ef5350', C_DN = '#26a69a', C_BENCH = '#9ca3af', C_50 = '#fbbf24';

// ── 公開入口 ──────────────────────────────────────────────────────────────
export function bindTribunalRun() {
  const panel = document.getElementById('labPanelTribunal');
  if (panel && !panel.dataset.init) {
    panel.dataset.init = '1';
    panel.innerHTML = _emptyHTML();
    _bindEmptyButtons(panel);
  }
}

/** 外部跳轉：lab-discovered 晉升鈕 → 預填候選並切到鑑定所 */
export function openTribunal(payload) {
  // 用既有 sub-btn 點擊觸發 strategy-lab 的 _switchSub（panel/controls/active 一次同步）
  const btn = document.getElementById('labBtnTribunal');
  if (btn) {
    btn.style.display = '';   // 確保可見（VVVIP gate 若隱藏，跳轉時強制顯示）
    btn.click();
  } else {
    // 後備：手動切
    ['Single','MC','Compare','Experiment','Backtest','Discovered','Tribunal'].forEach(k => {
      const p = document.getElementById('labPanel'+k);
      const c = document.getElementById('labControls'+k);
      if (p) p.style.display = k === 'Tribunal' ? '' : 'none';
      if (c) c.style.display = k === 'Tribunal' ? '' : 'none';
    });
  }
  bindTribunalRun();
  setTimeout(() => _runTrial(payload), 120);
}

// ── 空狀態 UI：直接列出所有可鑑定策略 ──────────────────────────────────────
function _emptyHTML() {
  const ok = STRATEGIES.filter(s => { try { return isStrategyBacktestable(s); } catch { return false; } });
  const groups = {};
  ok.forEach(s => { (groups[s.category] = groups[s.category] || []).push(s); });
  const groupHTML = Object.entries(groups).map(([cat, list]) => `
    <div class="tbn-pick-group">
      <div class="tbn-pick-cat">${cat}</div>
      <div class="tbn-pick-chips">
        ${list.map(s => `<button class="tbn-pick-chip" data-id="${s.id}" title="${s.id}">
          <span class="tbn-pick-ico">${s.icon || '📊'}</span>${s.name}</button>`).join('')}
      </div>
    </div>`).join('');
  return `
  <div class="tbn-empty">
    <div class="tbn-empty-icon">⚖️</div>
    <div class="tbn-empty-title">策略鑑定所</div>
    <div class="tbn-empty-sub">點選任一策略，一鍵跑完 G1~G4 四關，輸出含八維風險的圖文報告。</div>
  </div>
  <div class="tbn-pick">
    <div class="tbn-pick-group" id="tbnDiscGroup">
      <div class="tbn-pick-cat">🔮 系統發現候選</div>
      <div class="tbn-pick-chips" id="tbnDiscChips"><span class="tbn-muted">載入中…</span></div>
    </div>
    <div class="tbn-pick-group">
      <div class="tbn-pick-cat">🧬 妖股世代驗證</div>
      <div class="tbn-pick-chips">
        <button class="tbn-pick-chip tbn-cohort-chip" id="tbnCohortBtn" title="一代 vs 二代妖股 forward return 對照">
          <span class="tbn-pick-ico">🧬</span>二代妖股是否更猛？</button>
      </div>
    </div>
    ${groupHTML}
  </div>
  <div class="tbn-pick-manual">
    <input class="lab-code-input" id="tbnStrategyInput" type="text"
           placeholder="或手動輸入策略 ID" maxlength="12" style="width:180px">
    <button class="lab-run-btn" id="tbnRunManual">⚖️ 鑑定</button>
  </div>`;
}
function _bindEmptyButtons(panel) {
  panel.querySelectorAll('.tbn-pick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.id;
      const s = STRATEGIES.find(x => x.id === id);
      _runTrial({ kind: 'strategy', label: `${s.icon || ''} ${s.name}（${id}）`, entryIds: [id] });
    });
  });
  panel.querySelector('#tbnRunManual')?.addEventListener('click', () => {
    const id = panel.querySelector('#tbnStrategyInput')?.value.trim().toUpperCase();
    if (!id) { dengToast('請輸入或點選策略'); return; }
    const s = STRATEGIES.find(x => x.id === id);
    _runTrial({ kind: 'strategy', label: s ? `${s.icon || ''} ${s.name}（${id}）` : id, entryIds: [id] });
  });
  // 系統發現候選：非同步載入後填入
  _loadDiscoveredChips(panel);
  // 妖股世代分析
  panel.querySelector('#tbnCohortBtn')?.addEventListener('click', () => _runCohortAnalysis(panel));
}

async function _loadDiscoveredChips(panel) {
  const box = panel.querySelector('#tbnDiscChips');
  if (!box) return;
  try {
    const mod = await import('./lab-discovered.js');
    const cands = await mod.fetchDiscoveredCandidates();
    if (!cands.length) {
      panel.querySelector('#tbnDiscGroup')?.remove();  // 無候選則整區移除
      return;
    }
    box.innerHTML = cands.map((q, i) => {
      const p = mod.candidateToTribunalPayload(q);
      return `<button class="tbn-pick-chip tbn-disc-chip" data-idx="${i}" title="${q.conds.join('+')}（${q.hold}日）">
        <span class="tbn-pick-ico">🔮</span>${p._condLabel}（${q.hold}日）</button>`;
    }).join('');
    box.querySelectorAll('.tbn-disc-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = cands[+chip.dataset.idx];
        _runTrial(mod.candidateToTribunalPayload(q));
      });
    });
  } catch (e) {
    console.warn('[tribunal] 載入系統發現候選失敗:', e.message);
    panel.querySelector('#tbnDiscGroup')?.remove();
  }
}

// ── 🧬 妖股世代分析（一代 vs 二代 forward return 對照）──────────────────────
async function _runCohortAnalysis(panel) {
  if (_running) { dengToast('分析進行中…'); return; }
  _running = true;
  _disposeCharts();
  panel.innerHTML = `
    <div class="tbn-head">
      <span class="tbn-head-label">
        <button class="tbn-back" id="tbnCohortBack" title="返回">←</button>
        🧬 妖股世代分析</span>
      <span class="tbn-status" id="tbnCohortStatus">讀取妖股記錄…</span>
    </div>
    <div class="tbn-note">問題：重生後的「二代妖股」是否比「一代」更猛？用真實 yaogu 記錄 + K 線 forward return 對照。</div>
    <div id="tbnCohortBody"></div>`;
  panel.querySelector('#tbnCohortBack')?.addEventListener('click', () => {
    if (_running) { dengToast('分析進行中…'); return; }
    panel.innerHTML = _emptyHTML();
    _bindEmptyButtons(panel);
  });
  const setStatus = t => { const el = panel.querySelector('#tbnCohortStatus'); if (el) el.textContent = t; };

  try {
    const mod = await import('./yaogu-cohort.js');
    const R = await mod.analyzeYaoguCohorts((d, t) => setStatus(`分析 ${d}/${t} 檔…`));
    if (R.error) { setStatus('⚠ ' + R.error); _running = false; return; }
    const srcTxt = R.source === 'market'
      ? `🌐 全市場 ${R.counts.total} 個啟動事件（一代 ${R.counts.gen1} / 二代 ${R.counts.gen2}）`
      : `📍 本地追蹤 ${R.counts.total} 檔（一代 ${R.counts.gen1} / 二代 ${R.counts.gen2}）`;
    setStatus('✓ ' + srcTxt);
    _renderCohort(panel.querySelector('#tbnCohortBody'), R);
  } catch (e) {
    console.error('[cohort]', e);
    setStatus('⚠ ' + e.message);
  } finally {
    _running = false;
  }
}

function _renderCohort(body, R) {
  if (!body) return;
  const cell = (s) => s.n
    ? `${s.winRate}% <span class="tbn-cohort-sub">${s.avgRet > 0 ? '+' : ''}${s.avgRet}%·n${s.n}</span>`
    : '<span class="tbn-muted">—</span>';
  const row = (label, g, cls = '') => `
    <tr class="${cls}">
      <td>${label}</td>
      <td>${cell(g.d5)}</td><td>${cell(g.d10)}</td><td>${cell(g.d20)}</td>
    </tr>`;
  const typeNames = { breakout: '🔴 二波猛妖', turnover: '🔄 換手型', squeeze: '⚡ 軋空型', control: '🔵 控盤型' };
  const typeRows = Object.entries(R.byType)
    .filter(([, g]) => g.d20.n > 0)
    .map(([t, g]) => row('　' + (typeNames[t] || t), g, 'tbn-cohort-sub-row')).join('');

  body.innerHTML = `
    <div class="tbn-verdict ${(R.gen2.d20.winRate ?? 0) > (R.gen1.d20.winRate ?? 0) ? 'tbn-pass' : 'tbn-fail'}">
      ${R.verdict}
    </div>
    <div class="tbn-section-title">勝率對照（啟動後 N 日，括號內=均報·樣本數）</div>
    <table class="tbn-cohort-table">
      <thead><tr><th>世代</th><th>5日</th><th>10日</th><th>20日</th></tr></thead>
      <tbody>
        ${row('🥇 一代妖股', R.gen1)}
        ${row('🥈 二代妖股', R.gen2, 'tbn-cohort-gen2')}
        ${typeRows}
      </tbody>
    </table>
    <div class="tbn-section-title">逐檔明細（依 20 日報酬排序）</div>
    <div class="tbn-cohort-samples">
      ${R.samples.slice(0, 30).map(s => {
        const r20 = s.ret20?.matured ? `${s.ret20.ret > 0 ? '+' : ''}${s.ret20.ret}%` : '未到期';
        const genTag = s.isGen2 ? `🧬 ${s.gen}代${s.rebirthType ? '·' + ({breakout:'猛妖',turnover:'換手',squeeze:'軋空',control:'控盤'}[s.rebirthType] || '') : ''}` : '一代';
        const col = s.ret20?.matured ? (s.ret20.ret > 0 ? '#ef5350' : '#26a69a') : '#8b949e';
        return `<div class="tbn-cohort-sample">
          <span class="tbn-cohort-code">${s.code}</span>
          <span class="tbn-cohort-gen ${s.isGen2 ? 'g2' : ''}">${genTag}</span>
          <span style="color:${col};font-weight:600">${r20}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="tbn-note" style="margin-top:14px">⚠ 此為當前追蹤妖股的橫斷面快照，非完整歷史回測；樣本受限於現有妖股數。能走到二波的本就是存活強股（選擇性偏差），二代數據天生偏高。待 Phase 0 累積完整二波事件後，可在鑑定所跑正式 A/B 回測。</div>`;
}

// ── 主流程：一條龍鑑定 ────────────────────────────────────────────────────
async function _runTrial(payload) {
  if (_running) { dengToast('鑑定進行中…'); return; }
  _running = true;
  _disposeCharts();
  const panel = document.getElementById('labPanelTribunal');
  if (!panel) { _running = false; return; }

  const label = payload.label || '未命名策略';
  panel.innerHTML = _stepperShell(label);
  panel.querySelector('#tbnBack')?.addEventListener('click', () => {
    if (_running) { dengToast('鑑定進行中，請稍候…'); return; }
    _disposeCharts();
    panel.innerHTML = _emptyHTML();
    _bindEmptyButtons(panel);
  });
  const setStage = (n, state, txt) => _setStage(panel, n, state, txt);
  const setStatus = (t) => { const el = panel.querySelector('#tbStatus'); if (el) el.textContent = t; };

  try {
    // ── Stage 0：取數 + 單一引擎回測 ──
    setStatus('取得全市場代號清單…');
    const codes = await fetchAllHistCodes();
    if (!codes || codes.length === 0) {
      throw new Error('無法取得全市場清單（Worker /histcodes 未部署或 hist 倉儲未初始化）');
    }
    setStatus(`載入 ${codes.length} 檔歷史…`);
    const [histMap, benchCandles] = await Promise.all([
      fetchHistAll(codes, (d, t) => setStatus(`載入歷史 ${d}/${t}…`)),
      fetchBenchmark('0050'),
    ]);
    if (!histMap || histMap.size === 0) {
      throw new Error('歷史倉儲尚未初始化，無法鑑定（請先在組合回測載入資料）');
    }

    setStatus('單一引擎回測中（四關與風險指標同源）…');
    const btOpts = {
      histMap,
      capital: 1_000_000,
      maxPositions: payload.maxPositions ?? 10,
      exitMode: payload.exitMode ?? 'trailing',
      exitDays: payload.hold ?? 0,
      stopPct: payload.stopPct ?? 20,
      trailPct: payload.trailPct ?? 25,
      regimeCandles: benchCandles,  // 大盤濾網 + regime 分格皆用得到
    };
    if (payload.customStrategies && payload.customStrategies.length) {
      btOpts.customStrategies = payload.customStrategies;
      btOpts.entryIds = [];   // 只跑候選，杜絕引擎預設 X1 混入
    } else {
      btOpts.entryIds = payload.entryIds ?? [payload.label];
    }

    const result = runBacktest(btOpts);
    const metrics = calcMetrics({ ...result, benchCandles, capital: 1_000_000 });

    // regime 標記注入 trades（進場日大盤狀態）
    _tagTradeRegime(result.trades, benchCandles);

    const profile = calcRiskProfile({
      equity: result.equity, trades: result.trades, dailyReturns: result.dailyReturns,
      metrics, capital: 1_000_000, foundTs: payload.foundTs ?? null,
    });
    const gates = judgeGates(profile, metrics, { benchTotalReturn: metrics.benchTotalReturn });

    // ── 四關亮燈 ──
    setStage(1, gates.G1 ? 'pass' : 'fail', `總報酬 ${_sign(metrics.totalReturn)}%`);
    setStage(2, gates.G2 ? 'pass' : 'fail', `MDD ${metrics.mdd}%`);
    setStage(3, gates.G3 ? 'pass' : 'fail', `超額 ${_sign(gates.excess)}%`);
    setStage(4, gates.G4 ? 'pass' : 'fail',
      `窗外勝率下界 ${profile.overfit.oosWilson.lo}%（n=${profile.overfit.oosCount}）`);

    // ── 渲染完整報告 ──
    _lastReport = { label, metrics, profile, gates, payload };
    _renderReport(panel, _lastReport);
    setStatus(gates.pass ? '✓ 通過全部門檻' : `✗ ${gates.fails.length} 關未過`);

  } catch (e) {
    console.error('[tribunal]', e);
    setStatus('⚠ ' + e.message);
    const body = panel.querySelector('#tbReport');
    if (body) body.innerHTML = `<div class="tbn-error">鑑定中斷：${e.message}</div>`;
  } finally {
    _running = false;
  }
}

// ── regime 標記：進場日大盤 > MA60 且 MA60 上揚 = bull ──
function _tagTradeRegime(trades, bench) {
  if (!bench?.length) return;
  const closes = bench.map(c => c.a ?? c.c);
  const ma60 = closes.map((_, i) => i < 59 ? null
    : closes.slice(i - 59, i + 1).reduce((a, b) => a + b, 0) / 60);
  const tsIdx = new Map(bench.map((c, i) => [c.t, i]));
  trades.forEach(t => {
    const i = tsIdx.get(t.entryTs);
    if (i == null || i < 60 || ma60[i] == null) { t.regime = 'range'; return; }
    const above = closes[i] > ma60[i];
    const rising = ma60[i] > ma60[i - 5];
    t.regime = (above && rising) ? 'bull' : (!above && !rising) ? 'bear' : 'range';
  });
}

// ── Stepper 外殼 ──────────────────────────────────────────────────────────
function _stepperShell(label) {
  const stage = (n, g, title, desc) => `
    <div class="tbn-stage" id="tbStage${n}" data-state="pending">
      <div class="tbn-stage-light"></div>
      <div class="tbn-stage-body">
        <div class="tbn-stage-title">${g} · ${title}</div>
        <div class="tbn-stage-desc" id="tbStage${n}Desc">${desc}</div>
      </div>
    </div>`;
  return `
  <div class="tbn-head">
    <span class="tbn-head-label">
      <button class="tbn-back" id="tbnBack" title="返回策略清單">←</button>
      ⚖️ 鑑定中：${label}</span>
    <span class="tbn-status" id="tbStatus">準備中…</span>
  </div>
  <div class="tbn-note">回測語意：「新觸發」進場，T+1 開盤成交，含費稅 0.585%。窗外段才是審判依據。</div>
  <div class="tbn-stepper">
    ${stage(1, 'G1', '獲利底線', '2Y 組合回測總報酬 > 0')}
    ${stage(2, 'G2', '回撤可控', 'MDD 不深於 −35%')}
    ${stage(3, 'G3', '勝過大盤', '純窗外超額 > 同期 0050')}
    ${stage(4, 'G4', '非運氣', '窗外勝率 Wilson 下界 > 45%')}
  </div>
  <div id="tbReport"></div>`;
}
function _setStage(panel, n, state, txt) {
  const el = panel.querySelector('#tbStage' + n);
  if (el) el.dataset.state = state;
  const d = panel.querySelector('#tbStage' + n + 'Desc');
  if (d && txt) d.textContent = txt;
}

// ── 完整報告渲染 ──────────────────────────────────────────────────────────
function _renderReport(panel, R) {
  const { metrics: m, profile: p, gates: g } = R;
  const verdict = g.pass
    ? `<div class="tbn-verdict tbn-pass">🏆 通過鑑定 — 建議晉升名人堂</div>`
    : `<div class="tbn-verdict tbn-fail">⛔ 未通過 — ${g.fails.join('；')}</div>`;

  const body = panel.querySelector('#tbReport');
  body.innerHTML = `
    ${verdict}
    <div class="tbn-section-title">風險評估（八維）</div>
    <div class="tbn-risk-grid">
      ${_riskCard('回撤', `MDD ${m.mdd}%`, p.drawdown.recoverDays != null
        ? `最深套牢 ${m.mdd}%，約 ${p.drawdown.recoverDays} 個交易日回本；水下時間占 ${p.drawdown.underwaterRatio}%`
        : `最深套牢 ${m.mdd}%，期末尚未回本；水下時間占 ${p.drawdown.underwaterRatio}%`,
        m.mdd < -25 ? 'warn' : 'ok')}
      ${_riskCard('連虧', `最長 ${p.streak.maxLoseStreak} 連敗`,
        `心理測試：最慘連續 ${p.streak.maxLoseStreak} 次踩空，能不能抱得住`,
        p.streak.maxLoseStreak >= 6 ? 'warn' : 'ok')}
      ${_riskCard('左尾', p.leftTail.worstTrade != null ? `單筆最慘 ${p.leftTail.worstTrade}%` : '—',
        `每 20 筆約 1 筆虧破 ${p.leftTail.p5}%；偏度 ${p.leftTail.skew ?? '—'}${_skewNote(p.leftTail.skew)}`,
        (p.leftTail.p5 != null && p.leftTail.p5 < -10) ? 'warn' : 'ok')}
      ${_riskCard('風險調整', `Sharpe ${m.sharpe}`,
        `Sortino ${p.riskAdj.sortino ?? '—'}（只罰下行）／ Calmar ${p.riskAdj.calmar ?? '—'}（報酬÷最大痛苦）`,
        m.sharpe < 0.5 ? 'warn' : 'ok')}
      ${_regimeCard(p.regime)}
      ${_riskCard('過擬合', `窗外 ${p.overfit.oosCount} 筆`,
        `窗外勝率 ${p.overfit.oosWinRate ?? '—'}%，95% 信賴 [${p.overfit.oosWilson.lo}, ${p.overfit.oosWilson.hi}]；in-sample 占 ${p.overfit.inSampleRatio}%`,
        p.overfit.oosCount < 30 ? 'warn' : 'ok')}
      ${_riskCard('集中度', p.concentration.topCodeShare != null ? `龍頭 ${p.concentration.topCodeShare}%` : '—',
        p.concentration.topCode
          ? `${p.concentration.topCodeShare}% 報酬來自 ${p.concentration.topCode} 一檔，複製性${p.concentration.topCodeShare > 40 ? '存疑' : '尚可'}`
          : '報酬分散，無單一個股主導',
        (p.concentration.topCodeShare ?? 0) > 40 ? 'warn' : 'ok')}
      ${_riskCard('存活者偏差', '結構性', '⚠ 回測池不含已下市股票，高波動策略實際績效可能低於顯示值', 'warn')}
    </div>

    <div class="tbn-section-title">權益曲線（策略 vs 0050）</div>
    <div class="tbn-chart" id="tbChartEquity"></div>
    <div class="tbn-section-title">水下曲線（回撤深度）</div>
    <canvas class="tbn-canvas" id="tbCanvasUnderwater"></canvas>
    <div class="tbn-chart-row">
      <div class="tbn-chart-col">
        <div class="tbn-section-title">單筆報酬分佈</div>
        <canvas class="tbn-canvas" id="tbCanvasHist"></canvas>
      </div>
      <div class="tbn-chart-col">
        <div class="tbn-section-title">分市況勝率</div>
        <canvas class="tbn-canvas" id="tbCanvasRegime"></canvas>
      </div>
    </div>
    <div class="tbn-section-title">月報酬熱力</div>
    <div class="tbn-heatmap" id="tbHeatmap"></div>

    <div class="tbn-actions">
      <button class="lab-run-btn" id="tbExportMd">📋 複製報告（Markdown）</button>
      ${g.pass ? '<button class="lab-run-btn tbn-promote" id="tbPromote">🏆 晉升名人堂</button>' : ''}
    </div>`;

  // 圖表渲染
  _drawEquity(R);
  _drawUnderwater(R);
  _drawHist(R);
  _drawRegime(R);
  _drawHeatmap(R);

  body.querySelector('#tbExportMd')?.addEventListener('click', () => _exportMarkdown(R));
  body.querySelector('#tbPromote')?.addEventListener('click', () => _promote(R));
}

function _riskCard(name, head, desc, state) {
  return `<div class="tbn-risk-card tbn-${state}">
    <div class="tbn-risk-name">${name}</div>
    <div class="tbn-risk-head">${head}</div>
    <div class="tbn-risk-desc">${desc}</div>
  </div>`;
}
function _regimeCard(regime) {
  if (!regime) return _riskCard('市況脆弱性', '未分市況', '此次回測無足夠 regime 樣本', 'ok');
  const fmt = (k, zh) => regime[k] && regime[k].n
    ? `${zh} ${regime[k].winRate}%(${regime[k].n})` : `${zh} 無樣本`;
  const bearN = regime.bear ? regime.bear.n : 0;
  const bearWeak = regime.bear && regime.bear.winRate != null && bearN >= 5 && regime.bear.winRate < 40;
  const noBear = bearN === 0;
  let desc = `${fmt('bull','多頭')}｜${fmt('bear','空頭')}｜${fmt('range','盤整')}`;
  if (bearWeak) desc += '——空頭市明顯轉弱';
  else if (noBear) desc += '——此期間大盤未進空頭，空頭抗壓性未受測';
  return _riskCard('市況脆弱性',
    bearWeak ? '⚠ 靠天吃飯' : (noBear ? '未經空頭' : '跨市況'),
    desc,
    bearWeak ? 'warn' : 'ok');
}

// ── 圖表：權益三線（LightweightCharts）──
function _drawEquity(R) {
  const el = document.getElementById('tbChartEquity');
  if (!el || !window.LightweightCharts) return;
  const chart = window.LightweightCharts.createChart(el, {
    width: el.clientWidth, height: 240,
    layout: { background: { color: '#161b22' }, textColor: '#8b949e', fontSize: 10 },
    grid: { vertLines: { color: 'rgba(33,38,45,.6)' }, horzLines: { color: 'rgba(33,38,45,.6)' } },
    rightPriceScale: { borderColor: '#21262d' }, timeScale: { borderColor: '#21262d' },
  });
  const sStrat = chart.addLineSeries({ color: C_UP, lineWidth: 2, priceLineVisible: false });
  const sBench = chart.addLineSeries({ color: C_50, lineWidth: 1, priceLineVisible: false });
  const curve = R.metrics.curve || [];
  sStrat.setData(curve.map(c => ({ time: c.t, value: c.strategy })));
  sBench.setData(curve.filter(c => c.bench != null).map(c => ({ time: c.t, value: c.bench })));
  chart.timeScale().fitContent();
  _charts.push(chart);
}

// ── 圖表：水下曲線（自繪 canvas）──
function _drawUnderwater(R) {
  const cv = document.getElementById('tbCanvasUnderwater');
  if (!cv) return;
  const dd = R.metrics.drawdown || [];
  _prepCanvas(cv, 140);
  const ctx = cv.getContext('2d');
  const W = cv.clientWidth, H = 140, PADL = 6, PADR = 48, PADT = 8, PADB = 6;
  const minDd = Math.min(-1, ...dd.map(d => d.dd));
  const y = v => PADT + (v - 0) / (minDd - 0) * (H - PADT - PADB);
  const x = i => PADL + i / (dd.length - 1 || 1) * (W - PADL - PADR);
  // 0 軸
  ctx.strokeStyle = 'rgba(139,148,158,.4)'; ctx.beginPath(); ctx.moveTo(PADL, y(0)); ctx.lineTo(W - PADR, y(0)); ctx.stroke();
  // 填色
  ctx.beginPath(); ctx.moveTo(x(0), y(0));
  dd.forEach((d, i) => ctx.lineTo(x(i), y(d.dd)));
  ctx.lineTo(x(dd.length - 1), y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(38,166,154,.18)'; ctx.fill();
  ctx.beginPath(); dd.forEach((d, i) => i ? ctx.lineTo(x(i), y(d.dd)) : ctx.moveTo(x(i), y(d.dd)));
  ctx.strokeStyle = C_DN; ctx.lineWidth = 1.4; ctx.stroke();
  // MDD 標記（圖文同源驗證點）
  const mi = R.profile.drawdown.mddIdx;
  if (dd[mi]) {
    ctx.fillStyle = C_UP; ctx.beginPath(); ctx.arc(x(mi), y(dd[mi].dd), 3, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#c9d1d9'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'left';
    ctx.fillText(`MDD ${R.metrics.mdd}%`, Math.min(x(mi) + 6, W - PADR - 50), y(dd[mi].dd));
  }
  // 軸標
  ctx.fillStyle = '#8b949e'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'left';
  ctx.fillText('0%', W - PADR + 4, y(0)); ctx.fillText(minDd.toFixed(0) + '%', W - PADR + 4, y(minDd));
}

// ── 圖表：報酬分佈直方圖（自繪）──
function _drawHist(R) {
  const cv = document.getElementById('tbCanvasHist');
  if (!cv) return;
  _prepCanvas(cv, 150);
  const ctx = cv.getContext('2d');
  const W = cv.clientWidth, H = 150, PADL = 6, PADR = 6, PADT = 10, PADB = 18;
  const rets = R.profile.rets || [];
  if (!rets.length) return;
  const lo = Math.min(...rets), hi = Math.max(...rets);
  const BINS = 20, span = (hi - lo) || 1, bw = span / BINS;
  const bins = new Array(BINS).fill(0);
  rets.forEach(r => { const b = Math.min(BINS - 1, Math.floor((r - lo) / bw)); bins[b]++; });
  const maxC = Math.max(...bins);
  const x = i => PADL + i / BINS * (W - PADL - PADR);
  const bwPx = (W - PADL - PADR) / BINS;
  bins.forEach((c, i) => {
    const binMid = lo + (i + 0.5) * bw;
    const h = c / maxC * (H - PADT - PADB);
    ctx.fillStyle = binMid >= 0 ? 'rgba(239,83,80,.7)' : 'rgba(38,166,154,.7)';
    ctx.fillRect(x(i) + 1, H - PADB - h, bwPx - 2, h);
  });
  // 0 線
  if (lo < 0 && hi > 0) {
    const zx = PADL + (0 - lo) / span * (W - PADL - PADR);
    ctx.strokeStyle = 'rgba(139,148,158,.6)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(zx, PADT); ctx.lineTo(zx, H - PADB); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = '#8b949e'; ctx.font = '10px Segoe UI';
  ctx.textAlign = 'left'; ctx.fillText(lo.toFixed(0) + '%', PADL, H - 4);
  ctx.textAlign = 'right'; ctx.fillText('+' + hi.toFixed(0) + '%', W - PADR, H - 4);
}

// ── 圖表：分市況勝率長條（自繪）──
function _drawRegime(R) {
  const cv = document.getElementById('tbCanvasRegime');
  if (!cv) return;
  _prepCanvas(cv, 150);
  const ctx = cv.getContext('2d');
  const W = cv.clientWidth, H = 150, PADT = 12, PADB = 22;
  const rg = R.profile.regime;
  const items = [['多頭', 'bull', C_UP], ['空頭', 'bear', C_DN], ['盤整', 'range', '#9ca3af']];
  const bw = W / 3;
  items.forEach(([zh, k, col], i) => {
    const wr = rg && rg[k] && rg[k].winRate != null ? rg[k].winRate : 0;
    const n = rg && rg[k] ? rg[k].n : 0;
    const h = wr / 100 * (H - PADT - PADB);
    ctx.fillStyle = col; ctx.globalAlpha = n ? 0.8 : 0.2;
    ctx.fillRect(i * bw + bw * 0.2, H - PADB - h, bw * 0.6, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#c9d1d9'; ctx.font = '11px Segoe UI'; ctx.textAlign = 'center';
    ctx.fillText(n ? wr + '%' : '—', i * bw + bw / 2, H - PADB - h - 4);
    ctx.fillStyle = '#8b949e'; ctx.font = '10px Segoe UI';
    ctx.fillText(`${zh}(${n})`, i * bw + bw / 2, H - 6);
  });
  // 50% 參考線
  const y50 = PADT + 0.5 * (H - PADT - PADB);
  ctx.strokeStyle = 'rgba(139,148,158,.4)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, y50); ctx.lineTo(W, y50); ctx.stroke(); ctx.setLineDash([]);
}

// ── 月報酬熱力（div grid）──
function _drawHeatmap(R) {
  const el = document.getElementById('tbHeatmap');
  if (!el) return;
  const yr = R.metrics.yearlyReturns;  // 既有；若無月資料則退月勝率摘要
  const curve = R.metrics.curve || [];
  // 由 curve 推月報酬
  const byMonth = {};
  let prev = null;
  curve.forEach(c => {
    const d = new Date(c.t * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth[key] = c.strategy;
  });
  const keys = Object.keys(byMonth).sort();
  const cells = [];
  let last = 0;
  keys.forEach(k => {
    const cum = byMonth[k]; const mret = +(cum - last).toFixed(1); last = cum;
    const intensity = Math.min(1, Math.abs(mret) / 15);
    const col = mret >= 0
      ? `rgba(239,83,80,${0.15 + intensity * 0.6})`
      : `rgba(38,166,154,${0.15 + intensity * 0.6})`;
    cells.push(`<div class="tbn-hm-cell" style="background:${col}" title="${k}">
      <span class="tbn-hm-m">${k.slice(2)}</span><span class="tbn-hm-v">${mret > 0 ? '+' : ''}${mret}</span></div>`);
  });
  el.innerHTML = cells.join('') || '<div class="tbn-muted">月資料不足</div>';
}

// ── Markdown 匯出 ─────────────────────────────────────────────────────────
function _exportMarkdown(R) {
  const { metrics: m, profile: p, gates: g } = R;
  const ck = b => b ? '✅' : '❌';
  const md = [
    `# ⚖️ 鑑定報告 — ${R.label}`,
    `鑑定日期：${new Date().toISOString().slice(0, 10)}　回測語意：新觸發進場・T+1・含費稅0.585%`,
    ``,
    `## 判定：${g.pass ? '🏆 通過' : '⛔ 未通過'}`,
    g.pass ? '建議晉升名人堂。' : `敗因：${g.fails.join('；')}`,
    ``,
    `| 關卡 | 標準 | 結果 | 判定 |`,
    `|---|---|---|---|`,
    `| G1 獲利底線 | 總報酬 > 0 | ${m.totalReturn}% | ${ck(g.G1)} |`,
    `| G2 回撤可控 | MDD > −35% | ${m.mdd}% | ${ck(g.G2)} |`,
    `| G3 勝過大盤 | 超額 > 0 | ${g.excess}% | ${ck(g.G3)} |`,
    `| G4 非運氣 | Wilson下界 > 45% | ${p.overfit.oosWilson.lo}%（n=${p.overfit.oosCount}） | ${ck(g.G4)} |`,
    ``,
    `## 八維風險評估`,
    `- **回撤**：MDD ${m.mdd}%，${p.drawdown.recoverDays != null ? `約 ${p.drawdown.recoverDays} 交易日回本` : '期末未回本'}，水下占 ${p.drawdown.underwaterRatio}%`,
    `- **連虧**：最長 ${p.streak.maxLoseStreak} 連敗`,
    `- **左尾**：單筆最慘 ${p.leftTail.worstTrade}%，P5 ${p.leftTail.p5}%，偏度 ${p.leftTail.skew ?? '—'}${_skewNote(p.leftTail.skew)}`,
    `- **風險調整**：Sharpe ${m.sharpe}／Sortino ${p.riskAdj.sortino ?? '—'}／Calmar ${p.riskAdj.calmar ?? '—'}`,
    `- **市況脆弱性**：${p.regime ? ['bull','bear','range'].map(k => p.regime[k] && p.regime[k].n ? `${({bull:'多',bear:'空',range:'盤'})[k]}${p.regime[k].winRate}%(${p.regime[k].n})` : '').filter(Boolean).join('｜') : '未分市況'}`,
    `- **過擬合**：窗外 ${p.overfit.oosCount} 筆，勝率 ${p.overfit.oosWinRate ?? '—'}%，95%信賴 [${p.overfit.oosWilson.lo}, ${p.overfit.oosWilson.hi}]，in-sample 占 ${p.overfit.inSampleRatio}%`,
    `- **集中度**：${p.concentration.topCode ? `${p.concentration.topCodeShare}% 來自 ${p.concentration.topCode}` : '分散'}`,
    `- **存活者偏差**：⚠ 回測池不含已下市股，高波動策略實際恐低於顯示`,
    ``,
    `## 績效摘要`,
    `年化 ${m.cagr}%｜總報酬 ${m.totalReturn}%（0050 同期 ${m.benchTotalReturn ?? '—'}%）｜交易 ${m.tradeCount} 筆｜勝率 ${m.winRate}%｜平均持有 ${m.avgHoldDays} 日`,
  ].join('\n');
  navigator.clipboard?.writeText(md).then(
    () => dengToast('✓ 報告已複製'),
    () => dengToast('複製失敗，請手動選取')
  );
}

// ── 晉升（沿用 lab-discovered 名人堂寫入；此處發事件交由其處理）──
function _promote(R) {
  window.__tribunalPromote = R;
  document.dispatchEvent(new CustomEvent('tribunal:promote', { detail: R }));
  dengToast('已送出晉升（名人堂寫入）');
}

// ── 工具 ──────────────────────────────────────────────────────────────────
function _prepCanvas(cv, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.parentElement.clientWidth || 300;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
  cv.getContext('2d').scale(dpr, dpr);
}
function _collectRets(R) {
  // 報告未保留原始 rets 時，由集中度無法回推；改存於 profile 計算時
  return R._rets || [];
}
function _sign(v) { return (v > 0 ? '+' : '') + v; }
// 偏度判讀：正=右尾肥（少數大賺）、負=左尾肥（少數大賠）
function _skewNote(skew) {
  if (skew == null) return '';
  if (skew > 0.5) return '（右尾肥·少數大賺帶動）';
  if (skew < -0.5) return '（左尾肥·少數大賠拖累）';
  return '（分佈大致對稱）';
}
function _disposeCharts() {
  _charts.forEach(c => { try { c.remove(); } catch {} });
  _charts.length = 0;
  // class-sweep 清外掛 canvas（pitfall：chart.remove 不清 appendChild 的）
  document.querySelectorAll('#labPanelTribunal .tbn-canvas').forEach(cv => {
    const ctx = cv.getContext && cv.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
  });
}
