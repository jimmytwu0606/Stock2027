// js/monte-carlo.js
// ============================================================================
// Phase 8 — 蒙地卡羅 K 線模擬器
// ============================================================================
// 對外 API:
//   initMonteCarlo(refs)              ← main.js 呼叫一次
//   openMonteCarloMenu()              ← 工具列「模擬」btn 點擊
//   closeMonteCarlo()                 ← 清除模擬
//   isMonteCarloActive()              ← 查詢狀態
//
// 規格:
//   - 500 條路徑，熱力圖呈現
//   - 黑底：現價以上紅色系(多)，以下綠色系(空)
//   - D2 軟約束：S1/R1 處概率偏移
//   - D3 情境線：多頭/空頭，用戶切換
//   - D4 真實K棒落點：黃色超出/紫色跌破
//   - D5 開關：全視窗btn 和 重整btn 中間
//   - D6 歷史型態中線偏移
// ============================================================================

import { findSimilarPatterns } from './chart-analysis.js';
import { dengToast }           from './loading-deng.js';

// ─── 常數 ──────────────────────────────────────────────────────────────────
const N_PATHS       = 500;    // 路徑條數
const SOFT_DAMPEN   = 0.35;   // 軟約束：碰到支撐壓力時反向概率提升量
const MC_Z          = 8;      // canvas z-index
const PATH_ALPHA    = 0.045;  // 單條路徑透明度（堆疊後自然形成密度感）
const MEDIAN_ALPHA  = 0.90;   // 中位數路徑透明度
// 右側模擬空間：K線佔左側 58%，右側 42% 給扇形
const SIM_RATIO     = 0.42;

const COLOR_BULL_RGB  = '239,83,80';    // 台股紅(多)
const COLOR_BEAR_RGB  = '38,166,154';   // 台股綠(空)
const COLOR_BULL_LINE = 'rgba(239,83,80,0.9)';   // 多頭情境線
const COLOR_BEAR_LINE = 'rgba(38,166,154,0.9)';  // 空頭情境線
const COLOR_MED_LINE  = 'rgba(255,200,50,0.95)'; // 最高概率中線（黃）
const COLOR_EXCEED    = '#fbbf24';  // 超出上緣 → 黃
const COLOR_BREACH    = '#a78bfa';  // 跌破下緣 → 紫
const COLOR_BOUND_UP  = 'rgba(239,83,80,0.55)';  // 上界線
const COLOR_BOUND_DN  = 'rgba(38,166,154,0.55)'; // 下界線

// ─── 狀態 ──────────────────────────────────────────────────────────────────
let _refs        = null;   // { getMainChart, getCandleSeries, getMainChartEl, getCandles, getAnalysis }
let _canvas      = null;
let _ctx2d       = null;
let _active      = false;
let _simBars     = 10;     // 預設模擬根數
let _showBull    = false;  // 多頭情境線
let _showBear    = false;  // 空頭情境線
let _lastResult  = null;   // 上次模擬結果(用於真實K棒對比)
let _menuEl      = null;
let _unsubTime   = null;
let _unsubLogical= null;
let _resizeObs   = null;
let _crossAbortCtrl = null;  // 跨股測試取消控制器
let _signalAbortCtrl = null; // 策略勝率測試取消控制器
let _comboAbortCtrl  = null; // 組合驗證取消控制器
let _xgxiAbortCtrl   = null; // XG/XI 組合拳取消控制器
let _x611AbortCtrl   = null; // X6~X11 特化策略驗證取消控制器
let _kangAbortCtrl   = null; // 亢龍有悔出場驗證取消控制器
let _customBasket    = null; // 使用者自選 basket（null = 使用 DEFAULT_BASKET）

// ============================================================================
// 初始化
// ============================================================================
export function initMonteCarlo(refs) {
  _refs = refs;

  // 啟動時從 IndexedDB 預載 basket（背景執行，不阻塞）
  import('./db.js').then(({ getConfig }) => {
    getConfig('mc_basket').then(saved => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        _customBasket = saved;
      }
    }).catch(() => {});
  }).catch(() => {});

  // 監聽 chartRendered → 重建 canvas + 重算
  window.addEventListener('chartRendered', () => {
    if (_active) {
      _destroyCanvas();
      _buildCanvas();
      _run();
    }
  });
}

// ============================================================================
// 對外 API
// ============================================================================
export function openMonteCarloMenu() {
  if (_menuEl) { _closeMenu(); return; }
  _buildMenu();
}

export function closeMonteCarlo() {
  _active = false;
  _lastResult = null;
  _closeSimWindow();
  _closeMenu();
  // 清除工具列按鈕 active 狀態
  document.getElementById('btnMonteCarlo')?.classList.remove('active');
}

export function isMonteCarloActive() { return _active; }

// ============================================================================
// v1.8 公式分派 (Regime-Switching) — 依個股波動率走四種公式
// ----------------------------------------------------------------------------
// 動機: v1.6 跨股測試證明「一個公式打不了全市場」
//   - 牛皮股(中華電) 反指標 36% — 用「近期 5 天」抓到雜訊
//   - 妖股(智原) 39% — 反轉密集,近期更不可靠
//   - 趨勢股(2330) 70% — 剛好「近期 5 天」抓得到,v1.6 甜蜜點
// ----------------------------------------------------------------------------
// 解法: 依 stdDev_raw 切四段,各跑不同權重 + 不同 cap
// ----------------------------------------------------------------------------
export const MC_FORMULA_VERSION = 'v1.8';

// Regime 分類表 — 兩處(computeForecastCenter / _run)共用,避免漂移
const REGIME_TABLE = [
  // [上限門檻, regime 名, 權重 {recentMean, mean, volDrift, patternDrift}, capRatio]
  { upper: 0.008, name: 'superlow', w: { rm: 0.10, m: 0.45, v: 0.20, p: 0.25 }, cap: 0.8 },
  { upper: 0.014, name: 'low',      w: { rm: 0.20, m: 0.35, v: 0.25, p: 0.20 }, cap: 0.6 },
  { upper: 0.022, name: 'mid',      w: { rm: 0.30, m: 0.20, v: 0.30, p: 0.20 }, cap: 0.4 },  // 維持 v1.6
  { upper: Infinity, name: 'high',  w: { rm: 0.20, m: 0.25, v: 0.25, p: 0.30 }, cap: 0.3 },
];

function _classifyRegime(stdDev) {
  for (const r of REGIME_TABLE) {
    if (stdDev < r.upper) return r;
  }
  return REGIME_TABLE[REGIME_TABLE.length - 1];
}

// ============================================================================
// v1.8 公式 + 診斷資料收集 — 給回測模組用 (mc-backtest.js)
// ----------------------------------------------------------------------------
// 跟 _run() 內公式邏輯完全一致,但:
//   1. 不跑 500 條路徑,直接用 driftPerBar 解析解算中線
//   2. 不畫圖、不對齊 K 線、不算 markers
//   3. 不吃 support/resistance(回測時 t 點的 S/R 抓不到)
// ----------------------------------------------------------------------------
// 回傳: { startPrice, prices, stdDev, drift, formulaVersion, diag }
//   diag.regime: 'superlow' | 'low' | 'mid' | 'high'
// ============================================================================

export function computeForecastCenter(candles, simBars, opts = {}) {
  const { withPattern = false } = opts;
  if (!candles || candles.length < 20) return null;

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume ?? 0);
  const N       = closes.length;
  const lookback = Math.min(N - 1, 60);
  const lastClose = closes[N - 1];

  // 對數報酬率序列
  const logRets = [];
  for (let i = N - lookback; i < N; i++) {
    logRets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean   = logRets.reduce((s, r) => s + r, 0) / logRets.length;
  const stdDev = Math.sqrt(logRets.reduce((s, r) => s + (r - mean) ** 2, 0) / logRets.length);

  // 成交量係數
  let volCoeff = 1.0;
  try {
    const vol5  = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const vol60 = volumes.slice(-Math.min(60, volumes.length))
                         .reduce((s, v) => s + v, 0) / Math.min(60, volumes.length);
    if (vol60 > 0) {
      const ratio = vol5 / vol60;
      volCoeff = Math.max(0.80, Math.min(1.20, 0.9 + ratio * 0.2));
    }
  } catch {}

  // 量能 drift 偏移
  let volDrift = 0;
  try {
    const recentVol  = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const avgVol     = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length);
    const recentDir  = logRets.slice(-5).reduce((s, r) => s + r, 0) / 5;
    if (avgVol > 0 && recentVol > avgVol * 1.3) {
      volDrift = Math.max(-stdDev * 0.2, Math.min(stdDev * 0.2, recentDir * 0.3));
    }
  } catch {}

  // Beta 係數
  let betaCoeff = 1.0;
  try {
    const mktAvgSigma = 0.016;
    if (stdDev > 0 && mktAvgSigma > 0) {
      const beta = stdDev / mktAvgSigma;
      betaCoeff = beta > 1.5 ? 0.92 : beta < 0.7 ? 1.0 : 1.0;
    }
  } catch {}

  const finalStdDev = stdDev * volCoeff * betaCoeff;

  // 歷史型態 drift (可選)
  let patternDrift = 0;
  if (withPattern) {
    try {
      const patResult = findSimilarPatterns(candles);
      if (patResult?.patterns?.length > 0) {
        const followLen = patResult.followLen || 10;
        let totalRet = 0;
        for (const p of patResult.patterns) {
          if (p.followPct != null) {
            totalRet += Math.log(1 + p.followPct / 100) / followLen;
          }
        }
        patternDrift = totalRet / patResult.patterns.length;
      }
    } catch { patternDrift = 0; }
  }

  // 觀察用 RSI
  const rsi = _calcRSI14(closes);

  // ─── v1.8: 依 regime 動態決定權重和 cap ──────────────────────
  const regime = _classifyRegime(stdDev);
  let driftPerBar = mean;
  let clipped = false;
  const cap = finalStdDev * regime.cap;
  let contrib = { recentMean: 0, mean: 0, volDrift: 0, patternDrift: 0 };
  let recentMeanVal = 0;
  try {
    const recentN    = Math.min(10, N - 1);
    const recentRets = logRets.slice(-recentN);
    recentMeanVal = recentRets.reduce((s, r) => s + r, 0) / recentN;

    contrib = {
      recentMean:   recentMeanVal * regime.w.rm,
      mean:         mean          * regime.w.m,
      volDrift:     volDrift      * regime.w.v,
      patternDrift: patternDrift  * regime.w.p,
    };
    driftPerBar = contrib.recentMean + contrib.mean + contrib.volDrift + contrib.patternDrift;

    if (driftPerBar > cap) { driftPerBar = cap;   clipped = true; }
    if (driftPerBar < -cap){ driftPerBar = -cap;  clipped = true; }
  } catch { driftPerBar = mean; }

  // 用解析解算中線
  const prices = [lastClose];
  for (let i = 1; i <= simBars; i++) {
    prices.push(lastClose * Math.exp(driftPerBar * i));
  }

  return {
    startPrice:     lastClose,
    prices,
    stdDev:         finalStdDev,
    drift:          driftPerBar,
    formulaVersion: MC_FORMULA_VERSION,
    // ─── 診斷資料 ─────────────────────────────────────────
    diag: {
      regime:       regime.name,    // ← v1.8 新加: 哪個公式被觸發
      regimeWeights: regime.w,       // ← 該公式的權重
      regimeCap:    regime.cap,      // ← 該公式的 cap 比例
      stdDev_raw:   stdDev,
      stdDev_final: finalStdDev,
      recentMean:   recentMeanVal,
      mean,
      volDrift,
      patternDrift,
      rsi,
      cap,
      clipped,
      driftPerBar,
      contrib,
      volCoeff,
      betaCoeff,
    },
  };
}

// RSI(14) — 觀察用,簡化 SMA 版
function _calcRSI14(closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = n - period; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses += -diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================================
// 選單
// ============================================================================
function _buildMenu() {
  _menuEl = document.createElement('div');
  _menuEl.className = 'mc-menu';
  _menuEl.innerHTML = `
    <div class="mc-menu-title">📈 模擬根數</div>
    <div class="mc-radio-group">
      ${[5,8,10,15,20].map(n => `
        <label class="mc-radio-label">
          <input type="radio" name="mcBars" value="${n}" ${n === _simBars ? 'checked' : ''}>
          <span>${n} 根</span>
        </label>
      `).join('')}
    </div>
    <div class="mc-menu-sep"></div>
    <label class="mc-check-label">
      <input type="checkbox" id="mcBullLine" ${_showBull ? 'checked' : ''}>
      <span>🔴 多頭情境線</span>
    </label>
    <label class="mc-check-label">
      <input type="checkbox" id="mcBearLine" ${_showBear ? 'checked' : ''}>
      <span>🟢 空頭情境線</span>
    </label>
    <div class="mc-menu-sep"></div>
    <div class="mc-menu-actions">
      <button class="mc-btn-start" id="mcBtnStart">開始模擬</button>
      <button class="mc-btn-close" id="mcBtnClose">關閉</button>
    </div>
  `;

  // 定位在工具列 btn 旁邊
  const btn = document.getElementById('btnMonteCarlo');
  const rect = btn?.getBoundingClientRect();
  if (rect) {
    _menuEl.style.top  = (rect.bottom + 6) + 'px';
    _menuEl.style.left = rect.left + 'px';
  }
  document.body.appendChild(_menuEl);

  // 綁定事件
  _menuEl.querySelector('#mcBtnStart').addEventListener('click', () => {
    _simBars  = parseInt(_menuEl.querySelector('input[name="mcBars"]:checked')?.value || 10);
    _showBull = _menuEl.querySelector('#mcBullLine')?.checked || false;
    _showBear = _menuEl.querySelector('#mcBearLine')?.checked || false;
    _closeMenu();
    _startSim();
  });
  _menuEl.querySelector('#mcBtnClose').addEventListener('click', () => {
    closeMonteCarlo();
  });

  // 點外面關閉
  setTimeout(() => {
    document.addEventListener('click', _onDocClick, { once: false });
  }, 50);
}

function _onDocClick(e) {
  if (_menuEl && !_menuEl.contains(e.target) && e.target.id !== 'btnMonteCarlo') {
    _closeMenu();
    document.removeEventListener('click', _onDocClick);
  }
}

function _closeMenu() {
  _menuEl?.remove();
  _menuEl = null;
  document.removeEventListener('click', _onDocClick);
}

// ============================================================================
// 啟動模擬 — 開啟獨立全視窗
// ============================================================================
function _startSim() {
  if (!_refs?.getCandles) return;
  const candles = _refs.getCandles();
  if (!candles?.length) {
    dengToast('沒有 K 線資料,燈燈沒辦法模擬 ~', { mood: 'sad', duration: 3000 });
    return;
  }
  _active = true;
  document.getElementById('btnMonteCarlo')?.classList.add('active');
  _openSimWindow(candles);
}

// ============================================================================
// 模擬全視窗
// ============================================================================
// 獨立開一個 fixed overlay，內建全新 LightweightCharts 實例
// 右側留 rightOffset 空白讓扇形有完整空間
// 完全不動原本的 chart / fullscreen

let _simWin     = null;   // 全視窗 DOM
let _simChart   = null;   // 模擬用的 LightweightCharts 實例
let _simSeries  = null;   // 模擬用的 candlestick series

const RIGHT_OFFSET = 180;  // 右側留給扇形的空白(px)

function _openSimWindow(candles) {
  // 已開就先關
  if (_simWin) _closeSimWindow();

  // ── 建立 overlay ───────────────────────────────────────────────────
  _simWin = document.createElement('div');
  _simWin.id = 'mcSimWindow';
  _simWin.className = 'mc-sim-window';
  _simWin.innerHTML = `
    <div class="mc-sim-topbar">
      <div class="mc-sim-title">📈 蒙地卡羅模擬　<span class="mc-sim-subtitle">${RIGHT_OFFSET}px 右側保留模擬空間</span></div>
      <div class="mc-sim-controls">
        <div class="mc-accuracy-panel" id="mcAccuracyPanel">
          <span class="mc-accuracy-loading">📊 準確率載入中...</span>
        </div>
        <div class="mc-bt-btn-row">
          <button class="mc-bt-btn" id="mcBtRun" title="用 1 年歷史 K 線,假裝站在過去每一天用 v1.8 公式分派預測,跟真實答案對照">📈 跑歷史回測</button>
          <button class="mc-bt-btn mc-bt-btn-cross" id="mcBtCross" title="跨 10 檔不同型股(大型/牛皮/妖股/ETF/空頭...)跑v1.8 公式分派回測,看公式泛化能力">🎯 跨股測試</button>
          <button class="mc-bt-btn mc-bt-btn-signal" id="mcBtSignal" title="集合回測 30+ 個技術訊號策略 (S1 量增底部 / S20 葛蘭碧 / S33 GMMA 等),9 種出場組合對照,看哪個策略真有效">⚔️ 策略勝率</button>
          <button class="mc-bt-btn mc-bt-btn-combo" id="mcBtCombo" title="三件套組合驗證 — 你指定的 5 組組合,看「三亮」vs「過濾」哪個邏輯勝率高(業界稱 Triple Confirmation)">🎰 組合驗證</button>
          <button class="mc-bt-btn mc-bt-btn-exit" id="mcBtExit" title="出場策略驗證 — 多組進場 × 全部出場規則對照（含 Supertrend 翻空 / 跌破錨定VWAP），看哪個出場最配哪個進場">🎯 出場驗證</button>
          ${window.__userTier === 'vvvip' ? `<button class="mc-bt-btn mc-bt-btn-xgxi" id="mcBtXGXI" title="🔬 XG/XI 組合拳實驗 — 葛蘭碧強化版(XG1~XG4) + 一目強化版(XI1/XI4/XI7) vs 原始版本，驗證加條件後勝率是否提升（VVVIP 限定）">🔬 組合拳驗證</button><button class="mc-bt-btn mc-bt-btn-x611" id="mcBtX611" title="🧪 X6~X11 純K線特化驗證 — 跳空缺口/缺口強勢/盤整噴出/量縮突破/均線多排/強化黃叉 vs X1~X5 對照，決定是否正式導入（VVVIP 限定）">🧪 X6~X11驗證</button><button class="mc-bt-btn mc-bt-btn-kang" id="mcBtKang" title="🐉 亢龍有悔出場驗證 — E8 W14即出 / E9 W14出50%+MA20出50% / E10 量退潮 vs 現有出場規則，找出最佳飆股出場時機（VVVIP 限定）">🐉 亢龍有悔</button>` : ''}
          <button class="mc-bt-btn mc-bt-btn-basket" id="mcBtBasketEdit" title="自選回測 basket（最多 20 檔）">🧺 自選標的</button>
          <button class="mc-bt-btn mc-bt-btn-strategy" id="mcBtStrategy" title="針對 basket 每檔股票跑所有策略，找出最適合的進出場方式">🎯 操作建議</button>
          <button class="mc-bt-btn mc-bt-btn-sandbox" id="mcBtSandbox" title="生成未來模擬K柱，自動偵測進出場訊號（沙盒模式）">🧪 沙盒K線</button>
          <button class="mc-bt-btn mc-bt-btn-copy-sim" id="mcBtCopySim" title="複製模擬摘要，方便貼給 AI 討論" style="display:none">📋 複製模擬</button>
          <button class="mc-bt-btn mc-bt-btn-stockbt" id="mcBtStockBt" title="輸入個股代號 + 起始日期，查看那天的進場訊號與持倉報酬（Free 可用）">📅 個股回測</button>
          <button class="mc-bt-btn mc-bt-btn-simulator" id="mcBtSimulator" title="逐日模擬操作，虛擬資金 $100,000，練習訊號判讀與倉位管理">🎮 策略練習器</button>
        </div>
        <div class="mc-sim-controls-bottom">
          <span class="mc-sim-hint">扇形 = 機率區間,非預測</span>
          <button class="mc-sim-close-btn" id="mcSimClose">✕ 關閉</button>
        </div>
      </div>
    </div>
    <div class="mc-sim-body">
      <div class="mc-sim-chart-wrap" id="mcSimChartWrap">
        <div id="mcSimChart" class="mc-sim-chart"></div>
        <canvas id="mcSimCanvas" class="mc-sim-canvas"></canvas>
      </div>
      <!-- 回測結果面板 (預設隱藏,點 跑歷史回測 才出現) -->
      <div class="mc-bt-panel" id="mcBtPanel" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(_simWin);

  // 關閉按鈕
  document.getElementById('mcSimClose').addEventListener('click', () => {
    closeMonteCarlo();
  });
  // ESC 關閉
  const _escHandler = (e) => {
    if (e.key === 'Escape') { closeMonteCarlo(); document.removeEventListener('keydown', _escHandler); }
  };
  document.addEventListener('keydown', _escHandler);

  // 非同步載入準確率面板(不阻塞主流程)
  const code = _refs?.getCode?.() ?? null;
  _loadAccuracyPanel(code).catch(() => {});

  // 跑歷史回測按鈕
  document.getElementById('mcBtRun')?.addEventListener('click', () => {
    _runBacktest(candles).catch(err => {
      console.error('[mc-backtest] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">回測失敗: ${err.message}</div>`;
      }
    });
  });

  // 跨股測試按鈕
  document.getElementById('mcBtCross')?.addEventListener('click', () => {
    if (_crossAbortCtrl) {
      // 已在跑 → 取消
      _crossAbortCtrl.abort();
      return;
    }
    _runCrossBacktest().catch(err => {
      console.error('[mc-cross] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">跨股測試失敗: ${err.message}</div>`;
      }
      _crossAbortCtrl = null;
      _resetCrossBtn();
    });
  });

  // 策略勝率按鈕 (集合回測 30+ 個技術訊號策略)
  document.getElementById('mcBtSignal')?.addEventListener('click', () => {
    if (_signalAbortCtrl) {
      _signalAbortCtrl.abort();
      return;
    }
    _runSignalBacktest().catch(err => {
      console.error('[signal-bt] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">策略勝率測試失敗: ${err.message}</div>`;
      }
      _signalAbortCtrl = null;
      _resetSignalBtn();
    });
  });

  // 組合驗證按鈕 (三件套 Triple Confirmation)
  document.getElementById('mcBtCombo')?.addEventListener('click', () => {
    if (_comboAbortCtrl) {
      _comboAbortCtrl.abort();
      return;
    }
    _runComboBacktest().catch(err => {
      console.error('[combo-bt] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">組合驗證失敗: ${err.message}</div>`;
      }
      _comboAbortCtrl = null;
      _resetComboBtn();
    });
  });

  // 出場驗證按鈕 (3 進場 × 4 出場)
  document.getElementById('mcBtExit')?.addEventListener('click', () => {
    if (_exitAbortCtrl) {
      _exitAbortCtrl.abort();
      return;
    }
    _runExitBacktest().catch(err => {
      console.error('[exit-bt] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">出場驗證失敗: ${err.message}</div>`;
      }
      _exitAbortCtrl = null;
      _resetExitBtn();
    });
  });

  // XG/XI 組合拳驗證按鈕（VVVIP 限定）
  document.getElementById('mcBtXGXI')?.addEventListener('click', () => {
    if (_xgxiAbortCtrl) {
      _xgxiAbortCtrl.abort();
      _xgxiAbortCtrl = null;
      const btn = document.getElementById('mcBtXGXI');
      if (btn) { btn.textContent = '🔬 組合拳驗證'; btn.classList.remove('mc-bt-btn-running'); }
      return;
    }
    _runXGXIBacktest().catch(err => {
      console.error('[xgxi-bt] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">組合拳驗證失敗: ${err.message}</div>`;
      }
      _xgxiAbortCtrl = null;
      const btn = document.getElementById('mcBtXGXI');
      if (btn) { btn.textContent = '🔬 組合拳驗證'; btn.classList.remove('mc-bt-btn-running'); }
    });
  });

  // X6~X11 純K線特化驗證按鈕（VVVIP 限定）
  document.getElementById('mcBtX611')?.addEventListener('click', () => {
    if (_x611AbortCtrl) {
      _x611AbortCtrl.abort();
      _x611AbortCtrl = null;
      const btn = document.getElementById('mcBtX611');
      if (btn) { btn.textContent = '🧪 X6~X11驗證'; btn.classList.remove('mc-bt-btn-running'); }
      return;
    }
    _runX611Backtest().catch(err => {
      console.error('[x611-bt] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">X6~X11驗證失敗: ${err.message}</div>`;
      }
      _x611AbortCtrl = null;
      const btn = document.getElementById('mcBtX611');
      if (btn) { btn.textContent = '🧪 X6~X11驗證'; btn.classList.remove('mc-bt-btn-running'); }
    });
  });

  // 亢龍有悔出場驗證按鈕（VVVIP 限定）
  document.getElementById('mcBtKang')?.addEventListener('click', () => {
    if (_kangAbortCtrl) {
      _kangAbortCtrl.abort();
      _kangAbortCtrl = null;
      const btn = document.getElementById('mcBtKang');
      if (btn) { btn.textContent = '🐉 亢龍有悔'; btn.classList.remove('mc-bt-btn-running'); }
      return;
    }
    _runKangBacktest().catch(err => {
      console.error('[kang-bt] 失敗:', err);
      const panel = document.getElementById('mcBtPanel');
      if (panel) {
        panel.style.display = '';
        panel.innerHTML = `<div class="mc-bt-error">亢龍有悔驗證失敗: ${err.message}</div>`;
      }
      _kangAbortCtrl = null;
      const btn = document.getElementById('mcBtKang');
      if (btn) { btn.textContent = '🐉 亢龍有悔'; btn.classList.remove('mc-bt-btn-running'); }
    });
  });

  // 自選 basket 按鈕
  document.getElementById('mcBtBasketEdit')?.addEventListener('click', () => {
    _openBasketEditor();
  });

  // 沙盒K線按鈕
  document.getElementById('mcBtSandbox')?.addEventListener('click', () => {
    import('./mc-sandbox.js').then(({ openSandboxPanel }) => {
      openSandboxPanel(_refs, _simChart, _simSeries);
    }).catch(err => console.error('[mc-sandbox]', err));
  });

  // 操作建議按鈕
  document.getElementById('mcBtStrategy')?.addEventListener('click', () => {
    import('./mc-strategy.js').then(({ openStrategyPanel }) => {
      openStrategyPanel(_customBasket, _lastResult, _refs);
    }).catch(err => console.error('[mc-strategy]', err));
  });

  // 個股回測按鈕
  document.getElementById('mcBtStockBt')?.addEventListener('click', () => {
    console.log('[mc] 個股回測按鈕點擊，開始 import stock-backtest.js');
    import('./stock-backtest.js').then(({ openStockBacktestPanel }) => {
      console.log('[mc] stock-backtest.js import 成功');
      openStockBacktestPanel();
    }).catch(err => {
      console.error('[stock-backtest] import 失敗:', err);
    });
  });

  document.getElementById('mcBtSimulator')?.addEventListener('click', () => {
    import('./strategy-simulator.js').then(({ openSimulator }) => {
      openSimulator();
    }).catch(err => console.error('[strategy-simulator] import 失敗:', err));
  });

  // 複製模擬摘要按鈕
  document.getElementById('mcBtCopySim')?.addEventListener('click', () => {    import('./mc-strategy.js').then(({ buildSimSummary }) => {
      const text = buildSimSummary(_lastResult, _refs, _refs?.getCandles?.());
      const btn = document.getElementById('mcBtCopySim');
      navigator.clipboard.writeText(text).then(() => {
        if (btn) { btn.textContent = '✅ 已複製！'; setTimeout(() => { btn.textContent = '📋 複製模擬'; }, 2000); }
      }).catch(() => { if (btn) btn.textContent = '❌ 複製失敗'; });
    }).catch(err => console.error('[mc-strategy]', err));
  });

  // ── 建立獨立 LightweightCharts ─────────────────────────────────────
  const chartEl = document.getElementById('mcSimChart');
  _simChart = LightweightCharts.createChart(chartEl, {
    layout: {
      background:  { color: '#0e0f11' },
      textColor:   'rgba(138,143,153,0.9)',
      fontSize:    11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    rightPriceScale: {
      borderColor:  'rgba(255,255,255,0.08)',
      // top 留更多空間給扇形向上延伸，bottom 留給向下
      scaleMargins: { top: 0.20, bottom: 0.20 },
    },
    timeScale: {
      borderColor:    'rgba(255,255,255,0.08)',
      timeVisible:    true,
      secondsVisible: false,
      // rightOffset 在 _fitKlineLeft() 中動態設定
    },
    crosshair: { mode: 1 },
    handleScroll: true,
    handleScale:  true,
  });

  _simSeries = _simChart.addCandlestickSeries({
    upColor:        '#ef5350',
    downColor:      '#26a69a',
    borderUpColor:  '#ef5350',
    borderDownColor:'#26a69a',
    wickUpColor:    '#ef5350',
    wickDownColor:  '#26a69a',
  });
  _simSeries.setData(
    candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
  );
  _simChart.timeScale().fitContent();

  // ── 建立模擬 canvas（疊在 simChart 上）─────────────────────────────
  _buildCanvas();
  // 延遲讓 chart 先 render 完，再調整 K 線縮排
  setTimeout(() => _fitKlineLeft(_simBars), 80);

  // resize 監聽
  _resizeObs = new ResizeObserver(() => {
    const wrap = document.getElementById('mcSimChartWrap');
    if (!wrap) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    _simChart.applyOptions({ width: w, height: h });
    if (_lastResult) _draw(_lastResult);
  });
  _resizeObs.observe(document.getElementById('mcSimChartWrap'));
  setTimeout(() => {
    const wrap = document.getElementById('mcSimChartWrap');
    if (wrap) {
      _simChart.applyOptions({ width: wrap.clientWidth, height: wrap.clientHeight });
    }
  }, 50);

  // ── 跑模擬 ────────────────────────────────────────────────────────
  _run(candles);
}

function _closeSimWindow() {
  try { _unsubTime?.();    } catch {}
  try { _unsubLogical?.(); } catch {}
  _unsubTime = _unsubLogical = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _canvas?.remove();
  _canvas = null;
  _ctx2d  = null;
  try { _simChart?.remove(); } catch {}
  _simChart  = null;
  _simSeries = null;
  _simWin?.remove();
  _simWin = null;
}

function _buildCanvas() {
  const wrap = document.getElementById('mcSimChartWrap');
  if (!wrap) return;

  _canvas = document.getElementById('mcSimCanvas');
  if (!_canvas) return;
  _ctx2d = _canvas.getContext('2d');

  const _syncSize = () => {
    const dpr  = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    _canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    _canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    _canvas.style.width  = rect.width  + 'px';
    _canvas.style.height = rect.height + 'px';
    _ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (_lastResult) _draw(_lastResult);
  };
  _syncSize();

  // timeScale 縮放平移 → 重畫（RAF 防抖，避免高頻滾動卡頓）
  if (_simChart) {
    const ts = _simChart.timeScale();
    let _rafPending = false;
    const requestRedraw = () => {
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => {
        if (_lastResult) _draw(_lastResult);
        _rafPending = false;
      });
    };
    try {
      ts.subscribeVisibleTimeRangeChange(requestRedraw);
      _unsubTime = () => { try { ts.unsubscribeVisibleTimeRangeChange(requestRedraw); } catch {} };
      if (typeof ts.subscribeVisibleLogicalRangeChange === 'function') {
        ts.subscribeVisibleLogicalRangeChange(requestRedraw);
        _unsubLogical = () => { try { ts.unsubscribeVisibleLogicalRangeChange(requestRedraw); } catch {} };
      }
    } catch {}
  }
}

function _destroyCanvas() {
  // 由 _closeSimWindow 統一清理，這裡是空函式保持介面一致
}

// ============================================================================
// 準確率面板 — 讀取 Firebase mc 資料，顯示個股歷史命中率
// ============================================================================
async function _loadAccuracyPanel(code) {
  const panel = document.getElementById('mcAccuracyPanel');
  if (!panel || !code) return;

  try {
    // 讀取最近 30 天的 mc 資料，找這檔個股的紀錄
    const stats = { 5: { hit: 0, total: 0 }, 10: { hit: 0, total: 0 },
                    15: { hit: 0, total: 0 }, 20: { hit: 0, total: 0 } };
    let formula = 'v1.5';
    let foundAny = false;

    // 讀最近 30 個日曆天
    const today = new Date();
    for (let d = 0; d < 30; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - d);
      const dateStr = date.toISOString().slice(0, 10);

      // 先讀 meta 知道有幾批
      const metaKey = `market--${dateStr}--mc--meta`;
      const metaSnap = await _fsGetShared(metaKey);
      if (!metaSnap?.data && !metaSnap?.batches) continue;

      const batches = metaSnap.batches ?? 1;
      formula = metaSnap.formula ?? formula;

      // 找這檔股票在哪一批（試所有批次）
      for (let b = 0; b < batches; b++) {
        const batchKey = `market--${dateStr}--mc--${b}`;
        const snap = await _fsGetShared(batchKey);
        if (!snap?.data) continue;
        const dayData = typeof snap.data === 'string' ? JSON.parse(snap.data) : snap.data;
        const rec = dayData[code];
        if (!rec) continue;

        foundAny = true;
        for (const N of [5, 10, 15, 20]) {
          const hit = rec[`hit${N}`];
          if (hit !== null && hit !== undefined) {
            stats[N].total++;
            if (hit) stats[N].hit++;
          }
        }
        break; // 找到就跳出批次迴圈
      }
    }

    // 渲染
    if (!foundAny) {
      panel.innerHTML = `<span class="mc-accuracy-loading">📊 資料累積中（基準日 ${new Date().toISOString().slice(0,10)}）</span>`;
      return;
    }

    const bars = [5, 10, 15, 20].map(N => {
      const s = stats[N];
      if (s.total === 0) return `<span class="mc-acc-item mc-acc-pending">${N}根 —</span>`;
      const pct = Math.round(s.hit / s.total * 100);
      const color = pct >= 60 ? '#4ade80' : pct >= 45 ? '#fbbf24' : '#f87171';
      return `<span class="mc-acc-item" style="color:${color}">${N}根 ${pct}% <em>(${s.total}筆)</em></span>`;
    }).join('');

    panel.innerHTML = `
      <span class="mc-acc-label">📊 ${formula}</span>
      ${bars}
    `;
  } catch (e) {
    panel.innerHTML = `<span class="mc-accuracy-loading">📊 準確率讀取失敗</span>`;
  }
}

// 讀取 Firestore shared doc(前端版)
async function _fsGetShared(safeKey) {
  try {
    const { fsGetShared } = await import('./firebase.js');
    return await fsGetShared(safeKey.replace(/--/g, '/'));
  } catch {
    return null;
  }
}

// ============================================================================
// 歷史回測 — 用 1 年 K 線跑 v1.6 公式自我驗證
// ============================================================================
async function _runBacktest(candles) {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  // 顯示載入中
  panel.style.display = '';
  panel.innerHTML = `<div class="mc-bt-loading">📊 跑歷史回測中... (約 1-2 秒)</div>`;

  // 等一個 frame 讓 loading 渲染出來,再開跑(否則 UI 卡住)
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 30));

  // 動態 import 避免循環依賴
  const { runMcBacktest } = await import('./mc-backtest.js');

  const t0 = performance.now();
  const result = runMcBacktest(candles, { withPattern: false });
  const elapsed = (performance.now() - t0).toFixed(0);

  if (!result.ok) {
    panel.innerHTML = `<div class="mc-bt-error">⚠ ${result.reason}</div>`;
    return;
  }

  _renderBacktestResult(result, elapsed);
}

function _renderBacktestResult(result, elapsedMs) {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const horizons = result.horizons;
  const rows = [5, 10, 15, 20].map(N => {
    const h = horizons[N];
    if (!h || h.total === 0) {
      return `
        <tr>
          <td>${N} 根後</td>
          <td colspan="4" class="mc-bt-na">資料不足</td>
        </tr>
      `;
    }
    const hitPct  = (h.hitRate * 100).toFixed(0);
    const dirPct  = (h.dirRate * 100).toFixed(0);
    const maePct  = (h.mae * 100).toFixed(2);

    const dirColor = h.dirRate >= 0.60 ? '#4ade80' : h.dirRate >= 0.50 ? '#fbbf24' : '#f87171';
    const hitColor = h.hitRate >= 0.55 ? '#4ade80' : h.hitRate >= 0.40 ? '#fbbf24' : '#f87171';

    return `
      <tr>
        <td><b>${N} 根後</b></td>
        <td style="color:${dirColor}"><b>${dirPct}%</b> <em>(${h.dirHit}/${h.total})</em></td>
        <td style="color:${hitColor}"><b>${hitPct}%</b> <em>(${h.hit}/${h.total})</em></td>
        <td>${maePct}%</td>
      </tr>
    `;
  }).join('');

  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">📊 歷史回測結果</span>
        <span class="mc-bt-meta">${result.formula} · ${result.samples} 樣本 · ${elapsedMs}ms</span>
      </div>
      <button class="mc-bt-close" id="mcBtClose" title="關閉">✕</button>
    </div>
    <table class="mc-bt-table">
      <thead>
        <tr>
          <th></th>
          <th>方向命中率 <em>(預測漲跌方向對)</em></th>
          <th>完整命中率 <em>(方向對 + 誤差&lt;5%)</em></th>
          <th>平均誤差 <em>MAE</em></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="mc-bt-footnote">
      說明: 從 ${result.samples} 個歷史時間點各跑一次 v1.6 公式,把當天預測跟實際結果比對。
      <br>方向命中 ≈ 50% 代表跟丟硬幣一樣;≥ 60% 才算有顯著預測力。
      <br>注意: 回測版未啟用 patternDrift(歷史型態因子,佔權重 20%),代表四因子版下限表現。
    </div>
  `;

  document.getElementById('mcBtClose')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });
}

// ============================================================================
// 跨股測試 — 對 10 檔不同型股跑v1.8 公式分派回測
// ============================================================================
function _resetCrossBtn() {
  const btn = document.getElementById('mcBtCross');
  if (!btn) return;
  btn.textContent = '🎯 跨股測試';
  btn.classList.remove('mc-bt-btn-running');
}

function _setCrossBtnCanceling() {
  const btn = document.getElementById('mcBtCross');
  if (!btn) return;
  btn.textContent = '✕ 取消跨股測試';
  btn.classList.add('mc-bt-btn-running');
}

async function _runCrossBacktest() {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  // 動態 import (避免循環)
  const { runMcBacktestMulti, getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  const basket = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const total  = basket.length;

  // 顯示載入面板
  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎯 跨股測試 (v1.8 公式分派 + 診斷, 取樣 1/5)</span>
        <span class="mc-bt-meta" id="mcCrossMeta">準備中...</span>
      </div>
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcCrossFill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcCrossText">階段 1/2:拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcCrossList"></div>
  `;

  _crossAbortCtrl = new AbortController();
  _setCrossBtnCanceling();
  const signal = _crossAbortCtrl.signal;
  const t0 = performance.now();

  // ── 階段 1: 串列拉取 K 線 (每檔間隔 400ms 避 429) ──
  const items = [];
  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      panel.querySelector('#mcCrossText').textContent = '已取消';
      _crossAbortCtrl = null;
      _resetCrossBtn();
      return;
    }
    const s = basket[i];
    const text = panel.querySelector('#mcCrossText');
    const fill = panel.querySelector('#mcCrossFill');
    if (text) text.textContent = `階段 1/2:拉取 ${s.code} ${s.name}... (${i+1}/${total})`;
    if (fill) fill.style.width = `${((i + 1) / total) * 30}%`;  // 階段 1 佔 30%

    try {
      const symbol = toYahooSymbol(s.code);
      const candles = await fetchHistory(symbol, '1y');
      items.push({ ...s, candles });
    } catch (err) {
      items.push({ ...s, candles: null, fetchError: err.message });
    }

    // 400ms 間隔避 429
    if (i < basket.length - 1) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  if (signal.aborted) {
    panel.querySelector('#mcCrossText').textContent = '已取消';
    _crossAbortCtrl = null;
    _resetCrossBtn();
    return;
  }

  // ── 階段 2: 跑回測 (每檔約 4 秒, withPattern=true, sampleStep=5) ──
  panel.querySelector('#mcCrossText').textContent = `階段 2/2:跑回測中...`;
  panel.querySelector('#mcCrossFill').style.width = '30%';

  const list = panel.querySelector('#mcCrossList');
  const onProgress = (done, total, current, partial) => {
    const fill = panel.querySelector('#mcCrossFill');
    const text = panel.querySelector('#mcCrossText');
    if (fill) fill.style.width = `${30 + (done / total) * 70}%`;
    if (text) text.textContent = `階段 2/2:已跑完 ${done}/${total} - ${current.code} ${current.name}`;

    // 即時更新已跑完的清單
    if (list) {
      list.innerHTML = partial.map(r => _renderCrossRow(r)).join('');
    }
  };

  const multi = await runMcBacktestMulti(items, onProgress, {
    withPattern: true,
    sampleStep:  5,
    signal,
  });

  _crossAbortCtrl = null;
  _resetCrossBtn();

  if (signal.aborted) {
    panel.querySelector('#mcCrossText').textContent = '已取消';
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  _renderCrossResult(multi, elapsed);
}

function _renderCrossRow(r) {
  if (!r.ok) {
    return `<tr><td><b>${r.code}</b><br><span class="mc-cross-type">${r.name}</span></td>
      <td colspan="10" class="mc-bt-na">${r.reason || 'N/A'}</td></tr>`;
  }
  const h5  = r.horizons[5];
  const h10 = r.horizons[10];
  const h15 = r.horizons[15];
  const h20 = r.horizons[20];
  const _dir = (h) => {
    if (!h || h.total === 0) return '<td class="mc-bt-na">—</td>';
    const pct = Math.round(h.dirRate * 100);
    const color = pct >= 60 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171';
    return `<td style="color:${color}"><b>${pct}%</b></td>`;
  };
  const _hit = (h) => {
    if (!h || h.total === 0) return '<td class="mc-bt-na">—</td>';
    const pct = Math.round(h.hitRate * 100);
    return `<td>${pct}%</td>`;
  };
  const mae20 = h20?.mae != null ? (h20.mae * 100).toFixed(1) + '%' : '—';

  // ─── 診斷欄位 ───────────────────────────────────────
  const d = r.diag;
  let sigCell, rsiCell, clipCell, regimeCell;
  if (d) {
    // σ 中位數 (顯示 ×1000)
    const sigMed = (d.sigma.median * 1000).toFixed(1);
    // 把 σ 對應到 regime,看跟主導 regime 對不對齊
    const sigClass = d.sigma.median < 0.008 ? 'superlow'
                   : d.sigma.median < 0.014 ? 'low'
                   : d.sigma.median < 0.022 ? 'mid'
                   : 'high';
    const sigBadge = sigClass === 'superlow' ? '⚪超低'
                   : sigClass === 'low'      ? '🟢低'
                   : sigClass === 'mid'      ? '🟡中'
                   : '🔴高';
    sigCell = `<td><b>${sigMed}</b><br><span class="mc-cross-diag-sub">${sigBadge}</span></td>`;

    // RSI
    const rsiMed = d.rsi.median != null ? d.rsi.median.toFixed(0) : '—';
    const rsiHot = (d.rsi.hotPct * 100).toFixed(0);
    const rsiCold = (d.rsi.coldPct * 100).toFixed(0);
    rsiCell = `<td><b>${rsiMed}</b><br><span class="mc-cross-diag-sub">熱${rsiHot}% 冷${rsiCold}%</span></td>`;

    // Clip%
    const clipPct = (d.clipPct * 100).toFixed(0);
    const clipColor = d.clipPct > 0.5 ? '#f87171' : d.clipPct > 0.2 ? '#fbbf24' : '#8a8f99';
    clipCell = `<td style="color:${clipColor}">${clipPct}%</td>`;

    // v1.8: Regime 公式分派 — 該股主要被哪個公式驅動
    if (d.regimeMain) {
      const labels = { superlow: '⚪超低', low: '🟢低', mid: '🟡中', high: '🔴高', unknown: '—' };
      const colors = { superlow: '#a78bfa', low: '#4ade80', mid: '#fbbf24', high: '#f87171', unknown: '#8a8f99' };
      const name = d.regimeMain.name;
      const pct = (d.regimeMain.pct * 100).toFixed(0);
      regimeCell = `<td style="color:${colors[name] || '#8a8f99'}"><b>${labels[name] || name}</b><br><span class="mc-cross-diag-sub">${pct}%</span></td>`;
    } else {
      regimeCell = '<td class="mc-bt-na">—</td>';
    }
  } else {
    sigCell = rsiCell = clipCell = regimeCell = '<td class="mc-bt-na">—</td>';
  }

  return `
    <tr>
      <td><b>${r.code}</b><br><span class="mc-cross-type">${r.name} · ${r.type}</span></td>
      ${_dir(h5)}${_dir(h10)}${_dir(h15)}${_dir(h20)}
      ${_hit(h20)}
      <td>${mae20}</td>
      ${sigCell}${rsiCell}${clipCell}${regimeCell}
    </tr>
  `;
}

function _renderCrossResult(multi, elapsedSec) {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { results, formula } = multi;
  const okResults = results.filter(r => r.ok);

  // 計算摘要統計
  const avgDir = (N) => {
    const rates = okResults.map(r => r.horizons[N]?.dirRate).filter(v => v != null);
    if (!rates.length) return null;
    return rates.reduce((s, v) => s + v, 0) / rates.length;
  };
  const avgDir5  = avgDir(5);
  const avgDir10 = avgDir(10);
  const avgDir15 = avgDir(15);
  const avgDir20 = avgDir(20);

  // 找最佳/最差 (用 10 根後方向命中)
  const ranked = okResults
    .filter(r => r.horizons[10]?.total > 0)
    .sort((a, b) => (b.horizons[10].dirRate - a.horizons[10].dirRate));
  const best  = ranked[0];
  const worst = ranked[ranked.length - 1];

  const _fmt = (v) => v == null ? '—' : (v * 100).toFixed(0) + '%';
  const _color = (rate) => {
    if (rate == null) return '';
    const pct = rate * 100;
    return pct >= 60 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171';
  };

  const rows = results.map(r => _renderCrossRow(r)).join('');

  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎯 跨股測試結果 (v1.8 公式分派 + 診斷)</span>
        <span class="mc-bt-meta">${formula} · ${okResults.length}/${results.length} 檔成功 · ${elapsedSec}秒</span>
      </div>
      <button class="mc-bt-close" id="mcBtCloseCross" title="關閉">✕</button>
    </div>

    <div class="mc-cross-summary">
      <div class="mc-cross-summary-item">
        <span class="mc-cross-summary-label">平均方向命中</span>
        <span class="mc-cross-summary-val">
          5根 <b style="color:${_color(avgDir5)}">${_fmt(avgDir5)}</b> ·
          10根 <b style="color:${_color(avgDir10)}">${_fmt(avgDir10)}</b> ·
          15根 <b style="color:${_color(avgDir15)}">${_fmt(avgDir15)}</b> ·
          20根 <b style="color:${_color(avgDir20)}">${_fmt(avgDir20)}</b>
        </span>
      </div>
      ${best ? `<div class="mc-cross-summary-item">
        <span class="mc-cross-summary-label">⭐ 最佳 (10根)</span>
        <span class="mc-cross-summary-val">${best.code} ${best.name} · <b style="color:${_color(best.horizons[10].dirRate)}">${_fmt(best.horizons[10].dirRate)}</b> · ${best.type}</span>
      </div>` : ''}
      ${worst && worst !== best ? `<div class="mc-cross-summary-item">
        <span class="mc-cross-summary-label">⚠️ 最差 (10根)</span>
        <span class="mc-cross-summary-val">${worst.code} ${worst.name} · <b style="color:${_color(worst.horizons[10].dirRate)}">${_fmt(worst.horizons[10].dirRate)}</b> · ${worst.type}</span>
      </div>` : ''}
    </div>

    <table class="mc-bt-table mc-cross-table">
      <thead>
        <tr>
          <th rowspan="2">個股</th>
          <th colspan="4">方向命中率</th>
          <th rowspan="2">完整<br>20</th>
          <th rowspan="2">MAE<br>20</th>
          <th colspan="4" class="mc-diag-th">📐 公式診斷統計</th>
        </tr>
        <tr>
          <th>5</th><th>10</th><th>15</th><th>20</th>
          <th title="該股對數報酬 σ 中位數 ×1000">σ×1000</th>
          <th title="RSI(14) 中位數 / 過熱比例 / 超賣比例">RSI</th>
          <th title="drift 被 cap 截斷的樣本比例">Clip%</th>
          <th title="v1.8 該股主要被哪個 regime 公式驅動">公式</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="mc-bt-footnote">
      <b>v1.8 公式分派:</b>依個股 σ 走四種公式 — 
      ⚪超低 (σ<8) / 🟢低 (σ<14) / 🟡中 (σ<22,維持 v1.6) / 🔴高 (σ≥22)
      <br><b>📐 公式診斷統計:</b>用真實樣本告訴我們公式各零件的狀況。
      Clip% 顯示 drift 被新 regime cap 截斷的比例;
      公式欄顯示該股主要被哪個 regime 驅動 + 該 regime 樣本佔比。
      <br><b>對照基準 (v1.6 跨股結果):</b>2330 70% / 中華電 36% / 智原 39% / 聯發科 MAE 20.6%
    </div>
  `;

  document.getElementById('mcBtCloseCross')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });
}

// ============================================================================
// ⚔️ 策略勝率測試 — 集合回測 30+ 個技術訊號策略
// ============================================================================
function _resetSignalBtn() {
  const btn = document.getElementById('mcBtSignal');
  if (!btn) return;
  btn.textContent = '⚔️ 策略勝率';
  btn.classList.remove('mc-bt-btn-running');
}

function _setSignalBtnCanceling() {
  const btn = document.getElementById('mcBtSignal');
  if (!btn) return;
  btn.textContent = '✕ 取消策略測試';
  btn.classList.add('mc-bt-btn-running');
}

async function _runSignalBacktest() {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  // 動態 import
  const { runSignalBacktest, findBestComboPerStrategy } = await import('./signal-backtest.js');
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  const basket = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const total  = basket.length;

  // 顯示載入面板
  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">⚔️ 策略勝率測試 (30+ 個技術訊號, 9 種出場組合)</span>
        <span class="mc-bt-meta" id="mcSignalMeta">準備中...</span>
      </div>
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcSignalFill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcSignalText">階段 1/2:拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcSignalList"></div>
  `;

  _signalAbortCtrl = new AbortController();
  _setSignalBtnCanceling();
  const signal = _signalAbortCtrl.signal;
  const t0 = performance.now();

  // ── 階段 1: 拉 K 線 ──
  const items = [];
  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      panel.querySelector('#mcSignalText').textContent = '已取消';
      _signalAbortCtrl = null;
      _resetSignalBtn();
      return;
    }
    const s = basket[i];
    const text = panel.querySelector('#mcSignalText');
    const fill = panel.querySelector('#mcSignalFill');
    if (text) text.textContent = `階段 1/2:拉取 ${s.code} ${s.name}... (${i+1}/${total})`;
    if (fill) fill.style.width = `${((i + 1) / total) * 30}%`;

    try {
      const symbol = toYahooSymbol(s.code);
      const candles = await fetchHistory(symbol, '1y');
      items.push({ ...s, candles });
    } catch (err) {
      items.push({ ...s, candles: null, fetchError: err.message });
    }

    if (i < basket.length - 1) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  if (signal.aborted) {
    panel.querySelector('#mcSignalText').textContent = '已取消';
    _signalAbortCtrl = null;
    _resetSignalBtn();
    return;
  }

  // ── 階段 2: 跑集合回測 ──
  panel.querySelector('#mcSignalText').textContent = `階段 2/2:跑策略回測中...`;
  panel.querySelector('#mcSignalFill').style.width = '30%';

  const onProgress = (done, total, current, partial) => {
    const fill = panel.querySelector('#mcSignalFill');
    const text = panel.querySelector('#mcSignalText');
    if (fill) fill.style.width = `${30 + (done / total) * 70}%`;
    if (text) text.textContent = `階段 2/2:已跑完 ${done}/${total} - ${current.code} ${current.name}`;
  };

  const multi = await runSignalBacktest(items, onProgress, {
    sampleStep: 1,   // 每天都跑,因為訊號比較稀疏 (不像 MC 每天都觸發)
    signal,
  });

  _signalAbortCtrl = null;
  _resetSignalBtn();

  if (signal.aborted) {
    panel.querySelector('#mcSignalText').textContent = '已取消';
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const ranked = findBestComboPerStrategy(multi.aggregated);
  _renderSignalResult(multi, ranked, elapsed);
}

function _renderSignalResult(multi, ranked, elapsedSec) {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { perStock, formula, aggregated } = multi;
  const okStocks = perStock.filter(r => r.ok);

  // 篩出有觸發的策略 (樣本至少 5 才有意義)
  const withData = ranked.filter(r => r.bestCombo && r.bestCombo.triggers >= 5);
  const noData   = ranked.filter(r => !r.bestCombo || r.bestCombo.triggers < 5);

  const _fmtPct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const _fmtRet = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const _winColor = (rate) => {
    if (rate == null) return '#8a8f99';
    const pct = rate * 100;
    return pct >= 65 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171';
  };
  const _retColor = (ret) => {
    if (ret == null) return '#8a8f99';
    return ret >= 0.01 ? '#4ade80' : ret >= -0.005 ? '#fbbf24' : '#f87171';
  };

  // 渲染主表格 (有觸發資料的策略)
  const rows = withData.map((r, idx) => {
    const best = r.bestCombo;
    const winColor = _winColor(best.winRate);
    const retColor = _retColor(best.avgReturn);

    // 排名標記
    let rankBadge = '';
    if (idx === 0)      rankBadge = '🏆';
    else if (idx === 1) rankBadge = '🥈';
    else if (idx === 2) rankBadge = '🥉';
    else if (idx < 5)   rankBadge = '⭐';

    return `
      <tr>
        <td>${rankBadge}</td>
        <td><b>${r.stratId}</b><br><span class="mc-cross-type">${r.icon} ${r.name}</span></td>
        <td><span class="mc-strat-cat">${r.category}</span></td>
        <td><b>${best.holdDays}天</b><br><span class="mc-cross-diag-sub">${(best.winTarget*100).toFixed(0)}%標的</span></td>
        <td style="color:${winColor}"><b>${_fmtPct(best.winRate)}</b><br><span class="mc-cross-diag-sub">${best.wins}/${best.triggers}</span></td>
        <td style="color:${retColor}"><b>${_fmtRet(best.avgReturn)}</b></td>
        <td><span style="color:#4ade80">${_fmtRet(best.maxGain)}</span> / <span style="color:#f87171">${_fmtRet(best.maxLoss)}</span></td>
        <td>${r.stockCount}/${okStocks.length}</td>
      </tr>
    `;
  }).join('');

  // 渲染「資料不足」清單 (折疊)
  const noDataRows = noData.map(r => `<span class="mc-strat-no-data">${r.icon} ${r.stratId}</span>`).join(', ');

  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">⚔️ 策略勝率測試結果</span>
        <span class="mc-bt-meta">${formula} · ${okStocks.length}/${perStock.length} 檔 · ${withData.length}/${ranked.length} 策略有觸發 · ${elapsedSec}秒</span>
      </div>
      <button class="mc-bt-close" id="mcBtCloseSignal" title="關閉">✕</button>
    </div>

    <div class="mc-cross-summary">
      <div class="mc-cross-summary-item">
        <span class="mc-cross-summary-label">說明</span>
        <span class="mc-cross-summary-val" style="font-size:11px">
          每個策略都跑 9 種出場組合 (5/10/20 天 × 1%/2%/3% 標的),
          表格顯示<b>最佳出場組合</b>(勝率 × 平均報酬最大者)。
          <br>排名依勝率高低,只列出觸發 ≥ 5 次的策略。
        </span>
      </div>
    </div>

    <table class="mc-bt-table mc-signal-table">
      <thead>
        <tr>
          <th></th>
          <th>策略</th>
          <th>分類</th>
          <th>最佳組合</th>
          <th>勝率</th>
          <th>平均報酬</th>
          <th>最佳/最差</th>
          <th>命中股</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="8" class="mc-bt-na">無策略觸發,可能 K 線資料不足</td></tr>'}</tbody>
    </table>

    ${noDataRows ? `
      <div class="mc-bt-footnote">
        <b>未觸發或樣本 < 5 的策略 (${noData.length}):</b>
        <br>${noDataRows}
      </div>
    ` : ''}

    <div class="mc-bt-footnote">
      <b>解讀指引:</b>
      <br>• 勝率 ≥ 65% 綠燈 = 策略可信
      <br>• 勝率 50-65% 黃燈 = 表現平庸,可參考
      <br>• 勝率 < 50% 紅燈 = 反指標!考慮反向操作或拿掉
      <br>• 「命中股」= 該策略在多少檔有觸發過 (10 檔中)
      <br><b>注意:</b>樣本只有 10 檔股票 × 1 年,大樣本驗證待全市場 Worker Cron 版本
    </div>
  `;

  document.getElementById('mcBtCloseSignal')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });
}

// ============================================================================
// 🎰 組合驗證 — 三件套 Triple Confirmation
// ============================================================================
function _resetComboBtn() {
  const btn = document.getElementById('mcBtCombo');
  if (!btn) return;
  btn.textContent = '🎰 組合驗證';
  btn.classList.remove('mc-bt-btn-running');
}

function _setComboBtnCanceling() {
  const btn = document.getElementById('mcBtCombo');
  if (!btn) return;
  btn.textContent = '✕ 取消組合驗證';
  btn.classList.add('mc-bt-btn-running');
}

async function _runComboBacktest() {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { runComboBacktest, getDefaultCombos, findBestComboCondition } = await import('./combo-backtest.js');
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  const basket = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const combos = getDefaultCombos();
  const total  = basket.length;

  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎰 組合驗證 (5 組三件套, 兩種觸發邏輯)</span>
        <span class="mc-bt-meta" id="mcComboMeta">準備中...</span>
      </div>
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcComboFill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcComboText">階段 1/2:拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcComboList"></div>
  `;

  _comboAbortCtrl = new AbortController();
  _setComboBtnCanceling();
  const signal = _comboAbortCtrl.signal;
  const t0 = performance.now();

  // 階段 1: 拉 K 線
  const items = [];
  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      panel.querySelector('#mcComboText').textContent = '已取消';
      _comboAbortCtrl = null;
      _resetComboBtn();
      return;
    }
    const s = basket[i];
    const text = panel.querySelector('#mcComboText');
    const fill = panel.querySelector('#mcComboFill');
    if (text) text.textContent = `階段 1/2:拉取 ${s.code} ${s.name}... (${i+1}/${total})`;
    if (fill) fill.style.width = `${((i + 1) / total) * 30}%`;

    try {
      const symbol = toYahooSymbol(s.code);
      const candles = await fetchHistory(symbol, '1y');
      items.push({ ...s, candles });
    } catch (err) {
      items.push({ ...s, candles: null, fetchError: err.message });
    }
    if (i < basket.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  if (signal.aborted) {
    panel.querySelector('#mcComboText').textContent = '已取消';
    _comboAbortCtrl = null;
    _resetComboBtn();
    return;
  }

  // 階段 2: 跑回測
  panel.querySelector('#mcComboText').textContent = `階段 2/2:跑組合回測中...`;
  panel.querySelector('#mcComboFill').style.width = '30%';

  const onProgress = (done, total, current, partial) => {
    const fill = panel.querySelector('#mcComboFill');
    const text = panel.querySelector('#mcComboText');
    if (fill) fill.style.width = `${30 + (done / total) * 70}%`;
    if (text) text.textContent = `階段 2/2:已跑完 ${done}/${total} - ${current.code} ${current.name}`;
  };

  const multi = await runComboBacktest(items, onProgress, {
    sampleStep: 1,
    signal,
    combos,
  });

  _comboAbortCtrl = null;
  _resetComboBtn();

  if (signal.aborted) {
    panel.querySelector('#mcComboText').textContent = '已取消';
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const ranked = findBestComboCondition(multi.aggregated);
  _renderComboResult(multi, ranked, elapsed);
}

function _renderComboResult(multi, ranked, elapsedSec) {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { perStock, formula } = multi;
  const okStocks = perStock.filter(r => r.ok);

  const _fmtPct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const _fmtRet = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const _winColor = (rate) => {
    if (rate == null) return '#8a8f99';
    const pct = rate * 100;
    return pct >= 70 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171';
  };

  // 排序:用「三亮」勝率最高的組合排
  const sortedRanked = [...ranked].sort((a, b) => {
    const aWin = a.bestAll?.winRate ?? -1;
    const bWin = b.bestAll?.winRate ?? -1;
    return bWin - aWin;
  });

  // 每個組合渲染 2 行(三亮 + 過濾)
  const rows = sortedRanked.flatMap((r, idx) => {
    const rankBadge = idx === 0 ? '🏆' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '⭐';
    const _renderRow = (condType, condLabel, best, isFirstRow) => {
      if (!best) {
        return `<tr class="mc-combo-row-${condType}">
          ${isFirstRow ? `<td rowspan="2" style="vertical-align:middle">${rankBadge}</td>
          <td rowspan="2"><b>${r.name}</b><br><span class="mc-cross-type">${r.A.id}+${r.B.id}+${r.C.id}</span></td>` : ''}
          <td><span class="mc-combo-cond-${condType}">${condLabel}</span></td>
          <td colspan="6" class="mc-bt-na">樣本 < 3,信賴度不足</td>
        </tr>`;
      }
      const winColor = _winColor(best.winRate);
      return `<tr class="mc-combo-row-${condType}">
        ${isFirstRow ? `<td rowspan="2" style="vertical-align:middle;font-size:16px">${rankBadge}</td>
        <td rowspan="2"><b>${r.name}</b><br><span class="mc-cross-type">${r.A.id}+${r.B.id}+${r.C.id}</span></td>` : ''}
        <td><span class="mc-combo-cond-${condType}">${condLabel}</span></td>
        <td><b>${best.holdDays}天 ${(best.winTarget*100).toFixed(0)}%標的</b></td>
        <td style="color:${winColor}"><b>${_fmtPct(best.winRate)}</b><br><span class="mc-cross-diag-sub">${best.wins}/${best.triggers}</span></td>
        <td>${_fmtRet(best.avgReturn)}</td>
        <td><span style="color:#4ade80">${_fmtRet(best.maxGain)}</span> / <span style="color:#f87171">${_fmtRet(best.maxLoss)}</span></td>
        <td colspan="2" class="mc-combo-desc">${r.desc}</td>
      </tr>`;
    };

    return [
      _renderRow('all',    '🔴 三亮',  r.bestAll,    true),
      _renderRow('filter', '🟢 過濾',  r.bestFilter, false),
    ];
  }).join('');

  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎰 組合驗證結果 (Triple Confirmation)</span>
        <span class="mc-bt-meta">${formula} · ${okStocks.length}/${perStock.length} 檔 · 5 組 × 2 條件 · ${elapsedSec}秒</span>
      </div>
      <button class="mc-bt-close" id="mcBtCloseCombo" title="關閉">✕</button>
    </div>

    <div class="mc-cross-summary">
      <div class="mc-cross-summary-item">
        <span class="mc-cross-summary-label">📌 兩種觸發邏輯</span>
        <span class="mc-cross-summary-val" style="font-size:11px">
          <span class="mc-combo-cond-all">🔴 三亮</span> = A+B+C 三個訊號同一天都觸發
          ·
          <span class="mc-combo-cond-filter">🟢 過濾</span> = A+B 觸發 但 C 沒觸發
          <br>每個組合測試兩種條件,看哪種勝率高
        </span>
      </div>
    </div>

    <table class="mc-bt-table mc-combo-table">
      <thead>
        <tr>
          <th></th>
          <th>組合</th>
          <th>條件</th>
          <th>最佳出場</th>
          <th>勝率</th>
          <th>平均報酬</th>
          <th>最佳/最差</th>
          <th colspan="2">說明</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="mc-bt-footnote">
      <b>解讀:</b>
      <br>• 若「三亮 > 過濾」→ 該避險訊號實際是「強勢驗證」(在多頭裡有用)
      <br>• 若「過濾 > 三亮」→ 避險訊號真的當「警告」用,沒觸發才安全
      <br>• 若兩者勝率差不多 → 避險訊號根本沒區別力
      <br>• 樣本 < 3 顯示 N/A,組合稀有性使然
      <br><b>提醒:</b>組合的觸發次數通常 5-30 次,信賴度比單一策略低
    </div>
  `;

  document.getElementById('mcBtCloseCombo')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });
}

// ============================================================================
// 🎯 出場驗證 — 3 進場 × 4 出場
// ============================================================================
function _resetExitBtn() {
  const btn = document.getElementById('mcBtExit');
  if (!btn) return;
  btn.textContent = '🎯 出場驗證';
  btn.classList.remove('mc-bt-btn-running');
}

function _setExitBtnCanceling() {
  const btn = document.getElementById('mcBtExit');
  if (!btn) return;
  btn.textContent = '✕ 取消出場驗證';
  btn.classList.add('mc-bt-btn-running');
}

// ─── 自選 Basket 編輯器 ──────────────────────────────────────────────
async function _openBasketEditor() {
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { getConfig, setConfig }     = await import('./db.js');

  // ── 初始化：優先從 IndexedDB 載入，沒有才用預設 ──────────────────────
  if (!_customBasket) {
    try {
      const saved = await getConfig('mc_basket');
      _customBasket = (saved && Array.isArray(saved) && saved.length > 0)
        ? saved
        : getDefaultBacktestBasket();
    } catch {
      _customBasket = getDefaultBacktestBasket();
    }
  }

  // ── 儲存到 IndexedDB ────────────────────────────────────────────────
  const _saveBasket = async () => {
    try { await setConfig('mc_basket', _customBasket); } catch {}
  };

  // ── 解析一行文字 → { code, name } | null ──────────────────────────
  // 支援格式：「3021」「3021 鴻名」「鴻名 3021」「鴻名（3021）」「鴻名(3021)」
  const _parseLine = (line) => {
    line = line.trim().replace(/[,，、\t]+/g, ' ');
    if (!line) return null;
    let m;
    m = line.match(/^(.+?)[（(](\d{4,6})[）)]$/);
    if (m) return { code: m[2], name: m[1].trim() };
    m = line.match(/^(\d{4,6})\s+(.+)$/);
    if (m) return { code: m[1], name: m[2].trim() };
    m = line.match(/^(.+)\s+(\d{4,6})$/);
    if (m) return { code: m[2], name: m[1].trim() };
    m = line.match(/^(\d{4,6})$/);
    if (m) return { code: m[1], name: window.__nameCache?.get?.(m[1]) ?? m[1] };
    // 嘗試用中文名查 nameCache
    const cache = window.__nameCache;
    if (cache) {
      for (const [code, name] of cache) {
        if (name === line || name.includes(line)) return { code, name };
      }
    }
    return null;
  };

  // ── 批次解析多行 ──────────────────────────────────────────────────
  const _parseMultiLine = (raw) => {
    // 支援空格/逗號/換行分隔
    const lines = raw.split(/[\n\r]+/).flatMap(l => l.split(/[,，、\s]+/)).filter(l => l.trim());
    return lines.map(_parseLine).filter(Boolean);
  };

  // ── 建立 modal ────────────────────────────────────────────────────
  let modal = document.getElementById('mcBasketModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'mcBasketModal';
  modal.className = 'mc-basket-modal';

  const _render = () => {
    const count = _customBasket.length;
    modal.innerHTML = `
      <div class="mc-basket-inner">
        <div class="mc-basket-header">
          <span class="mc-basket-title">🧺 自選回測標的 <span class="mc-basket-count">${count}/20</span></span>
          <button class="mc-basket-close" id="mcBasketClose">✕</button>
        </div>

        <!-- Tab 列 -->
        <div class="mc-basket-tabs">
          <button class="mc-basket-tab active" data-tab="search">🔍 搜尋</button>
          <button class="mc-basket-tab" data-tab="batch">📋 批次匯入</button>
          <button class="mc-basket-tab" data-tab="watchlist">⭐ 從自選匯入</button>
        </div>

        <!-- 搜尋 Tab -->
        <div class="mc-basket-tab-panel active" id="mcBskPanelSearch">
          <div class="mc-basket-search-row">
            <input class="mc-basket-input" id="mcBasketInput" placeholder="輸入代號或股名搜尋..." autocomplete="off" />
            <button class="mc-basket-reset-btn" id="mcBasketReset">↺ 恢復預設</button>
          </div>
          <div class="mc-basket-suggestions" id="mcBasketSuggestions"></div>
        </div>

        <!-- 批次匯入 Tab -->
        <div class="mc-basket-tab-panel" id="mcBskPanelBatch">
          <div class="mc-basket-batch-wrap">
            <textarea class="mc-basket-batch-input" id="mcBasketBatchInput"
              placeholder="貼上代號或股名，空白/逗號/換行皆可分隔&#10;例如：2330 2317 2454&#10;或：台積電,鴻海&#10;或每行一個"></textarea>
            <div class="mc-basket-batch-preview" id="mcBasketBatchPreview"></div>
            <button class="mc-basket-batch-add-btn" id="mcBasketBatchAdd">➕ 批次加入</button>
          </div>
        </div>

        <!-- 從自選清單匯入 Tab -->
        <div class="mc-basket-tab-panel" id="mcBskPanelWatchlist">
          <div class="mc-basket-wl-wrap" id="mcBasketWlWrap">
            ${_renderWatchlistImport()}
          </div>
        </div>

        <!-- 目前清單 -->
        <div class="mc-basket-list" id="mcBasketList">
          ${_customBasket.map((s, i) => `
            <div class="mc-basket-item" data-idx="${i}">
              <span class="mc-basket-item-code">${s.code}</span>
              <span class="mc-basket-item-name">${s.name}</span>
              <span class="mc-basket-item-type">${s.type ?? ''}</span>
              <button class="mc-basket-item-remove" data-idx="${i}">✕</button>
            </div>
          `).join('')}
        </div>

        <div class="mc-basket-footer">
          <span class="mc-basket-saved-hint" id="mcBasketSavedHint"></span>
          <button class="mc-basket-confirm" id="mcBasketConfirm">✅ 確認儲存（${count} 檔）</button>
        </div>
      </div>
    `;

    // ── Tab 切換 ────────────────────────────────────────────────────
    modal.querySelectorAll('.mc-basket-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.mc-basket-tab').forEach(t => t.classList.remove('active'));
        modal.querySelectorAll('.mc-basket-tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panelId = { search: 'mcBskPanelSearch', batch: 'mcBskPanelBatch', watchlist: 'mcBskPanelWatchlist' }[tab.dataset.tab];
        modal.querySelector('#' + panelId)?.classList.add('active');
        if (tab.dataset.tab === 'search') modal.querySelector('#mcBasketInput')?.focus();
        if (tab.dataset.tab === 'batch')  modal.querySelector('#mcBasketBatchInput')?.focus();
      });
    });

    // ── 關閉 ────────────────────────────────────────────────────────
    modal.querySelector('#mcBasketClose')?.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // ── 恢復預設 ────────────────────────────────────────────────────
    modal.querySelector('#mcBasketReset')?.addEventListener('click', () => {
      _customBasket = getDefaultBacktestBasket();
      _saveBasket();
      _render();
    });

    // ── 移除個股 ────────────────────────────────────────────────────
    modal.querySelectorAll('.mc-basket-item-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        _customBasket.splice(parseInt(btn.dataset.idx), 1);
        _render();
      });
    });

    // ── 確認儲存 ────────────────────────────────────────────────────
    modal.querySelector('#mcBasketConfirm')?.addEventListener('click', async () => {
      await _saveBasket();
      const hint = modal.querySelector('#mcBasketSavedHint');
      if (hint) { hint.textContent = '✅ 已儲存'; setTimeout(() => { hint.textContent = ''; }, 2000); }
      modal.remove();
    });

    // ── 搜尋 Tab 邏輯 ───────────────────────────────────────────────
    const input  = modal.querySelector('#mcBasketInput');
    const sugBox = modal.querySelector('#mcBasketSuggestions');

    const _addStock = (code, name) => {
      if (_customBasket.length >= 20) { alert('最多 20 檔！請先移除一些標的'); return false; }
      if (_customBasket.some(s => s.code === code)) { if (sugBox) sugBox.innerHTML = '<div class="mc-basket-sug-empty">已在清單中</div>'; return false; }
      _customBasket.push({ code, name: name || window.__nameCache?.get?.(code) || code, type: '自選' });
      return true;
    };

    const _showSuggestions = (q) => {
      if (!q) { sugBox.innerHTML = ''; return; }
      const cache = window.__nameCache;
      const results = [];
      if (cache) {
        for (const [code, name] of cache) {
          if (code.startsWith(q) || name.includes(q)) results.push({ code, name });
        }
        results.sort((a, b) => (a.code === q ? -1 : b.code === q ? 1 : a.code.localeCompare(b.code)));
      }
      const top = results.slice(0, 8);
      if (!top.length) {
        sugBox.innerHTML = /^\d{4,6}$/.test(q)
          ? `<div class="mc-basket-sug-direct">⚠️ 快取找不到「${q}」（可能是興櫃/特殊板）<br>按 Enter 直接加入</div>`
          : '<div class="mc-basket-sug-empty">找不到符合的股票</div>';
        return;
      }
      sugBox.innerHTML = top.map(r =>
        `<div class="mc-basket-sug-item" data-code="${r.code}" data-name="${r.name}"><b>${r.code}</b> ${r.name}</div>`
      ).join('');
      sugBox.querySelectorAll('.mc-basket-sug-item').forEach(el => {
        el.addEventListener('click', () => {
          if (_addStock(el.dataset.code, el.dataset.name)) {
            input.value = ''; sugBox.innerHTML = '';
            _render();
          }
        });
      });
    };

    input?.addEventListener('input', (e) => _showSuggestions(e.target.value.trim()));
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = e.target.value.trim();
        if (/^\d{4,6}$/.test(q)) {
          if (_addStock(q, window.__nameCache?.get?.(q) ?? q)) {
            input.value = ''; sugBox.innerHTML = '';
            _render();
          }
        }
      }
    });

    // ── 批次匯入 Tab 邏輯 ───────────────────────────────────────────
    const batchInput   = modal.querySelector('#mcBasketBatchInput');
    const batchPreview = modal.querySelector('#mcBasketBatchPreview');
    const batchAddBtn  = modal.querySelector('#mcBasketBatchAdd');

    const _updateBatchPreview = () => {
      const raw = batchInput?.value ?? '';
      if (!raw.trim()) { batchPreview.innerHTML = ''; return; }
      const parsed = _parseMultiLine(raw);
      const newOnes = parsed.filter(p => !_customBasket.some(s => s.code === p.code));
      const dups    = parsed.filter(p =>  _customBasket.some(s => s.code === p.code));
      batchPreview.innerHTML = `
        <div class="mc-basket-batch-stats">
          解析 <b>${parsed.length}</b> 檔，可新增 <b style="color:#4ade80">${newOnes.length}</b> 檔
          ${dups.length ? `，已在清單 <span style="color:#8a8f99">${dups.length}</span> 檔` : ''}
          ${_customBasket.length + newOnes.length > 20 ? `<span style="color:#f87171">（超過 20 檔上限，只取前 ${20 - _customBasket.length} 檔）</span>` : ''}
        </div>
        <div class="mc-basket-batch-tags">
          ${newOnes.map(p => `<span class="mc-basket-tag-ok">${p.code} ${p.name}</span>`).join('')}
          ${dups.map(p => `<span class="mc-basket-tag-dup">${p.code} ${p.name}</span>`).join('')}
        </div>
      `;
    };

    batchInput?.addEventListener('input', _updateBatchPreview);

    batchAddBtn?.addEventListener('click', () => {
      const raw = batchInput?.value ?? '';
      const parsed = _parseMultiLine(raw);
      const newOnes = parsed.filter(p => !_customBasket.some(s => s.code === p.code));
      const canAdd  = Math.max(0, 20 - _customBasket.length);
      const toAdd   = newOnes.slice(0, canAdd);
      toAdd.forEach(p => _customBasket.push({ code: p.code, name: p.name, type: '批次匯入' }));
      if (batchInput) batchInput.value = '';
      _render();
    });

    // ── 自選清單匯入 Tab 邏輯 ───────────────────────────────────────
    modal.querySelectorAll('.mc-basket-wl-import-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const codes = btn.dataset.codes?.split(',') ?? [];
        const names = btn.dataset.names?.split('|') ?? [];
        let added = 0;
        codes.forEach((code, i) => {
          if (_customBasket.length >= 20) return;
          if (_customBasket.some(s => s.code === code)) return;
          _customBasket.push({ code, name: names[i] || window.__nameCache?.get?.(code) || code, type: '自選匯入' });
          added++;
        });
        if (added) _render();
        else alert('這個群組的股票都已在清單中了');
      });
    });
  };

  _render();
  document.body.appendChild(modal);
  modal.querySelector('#mcBasketInput')?.focus();
}

// ── 渲染自選清單匯入面板 ────────────────────────────────────────────────────
function _renderWatchlistImport() {
  const groups = window.AppState?.watchlistGroups ?? [];
  if (!groups.length) {
    return '<div class="mc-basket-wl-empty">尚無自選群組，請先在庫存Tab新增</div>';
  }
  return groups.map(g => {
    const stocks = g.stocks ?? [];
    if (!stocks.length) return '';
    const codes = stocks.map(s => s.code).join(',');
    const names = stocks.map(s => s.name || window.__nameCache?.get?.(s.code) || s.code).join('|');
    return `
      <div class="mc-basket-wl-group">
        <div class="mc-basket-wl-group-header">
          <span class="mc-basket-wl-group-name">${g.name ?? '未命名群組'}</span>
          <span class="mc-basket-wl-group-count">${stocks.length} 檔</span>
          <button class="mc-basket-wl-import-btn"
            data-codes="${codes}"
            data-names="${names}"
            title="匯入此群組所有股票">全部加入</button>
        </div>
        <div class="mc-basket-wl-stocks">
          ${stocks.slice(0, 10).map(s => `<span class="mc-basket-wl-stock">${s.code}</span>`).join('')}
          ${stocks.length > 10 ? `<span class="mc-basket-wl-stock-more">+${stocks.length - 10}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}


async function _runExitBacktest() {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { runExitBacktest, getDefaultEntries, getDefaultExitRules, findBestExitPerEntry } = await import('./exit-backtest.js');
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  // 使用自選 basket（若有），否則用預設
  const basket    = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const entries   = getDefaultEntries();
  const exitRules = getDefaultExitRules();
  const total     = basket.length;

  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎯 出場驗證 (W6 單獨 vs 3 組雙策略 × 全出場規則)</span>
        <span class="mc-bt-meta" id="mcExitMeta">準備中...</span>
      </div>
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcExitFill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcExitText">階段 1/2:拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcExitList"></div>
  `;

  _exitAbortCtrl = new AbortController();
  _setExitBtnCanceling();
  const signal = _exitAbortCtrl.signal;
  const t0 = performance.now();

  // 階段 1: 拉 K 線(個股 + 0050 市況)
  const items = [];

  // 先拉 0050(市況過濾器用)
  let etf0050Candles = null;
  try {
    const sym0050 = toYahooSymbol('0050');
    panel.querySelector('#mcExitText').textContent = `階段 1/2:拉取 0050 市況資料...`;
    etf0050Candles = await fetchHistory(sym0050, '1y');
  } catch (err) {
    console.warn('[exit-bt] 0050 拉取失敗,市況過濾器停用:', err.message);
  }
  await new Promise(r => setTimeout(r, 400));

  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      panel.querySelector('#mcExitText').textContent = '已取消';
      _exitAbortCtrl = null;
      _resetExitBtn();
      return;
    }
    const s = basket[i];
    const text = panel.querySelector('#mcExitText');
    const fill = panel.querySelector('#mcExitFill');
    if (text) text.textContent = `階段 1/2:拉取 ${s.code} ${s.name}... (${i+1}/${total})`;
    if (fill) fill.style.width = `${((i + 1) / total) * 30}%`;

    try {
      const symbol = toYahooSymbol(s.code);
      const candles = await fetchHistory(symbol, '1y');
      items.push({ ...s, candles });
    } catch (err) {
      items.push({ ...s, candles: null, fetchError: err.message });
    }
    if (i < basket.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  if (signal.aborted) {
    panel.querySelector('#mcExitText').textContent = '已取消';
    _exitAbortCtrl = null;
    _resetExitBtn();
    return;
  }

  // 階段 2: 跑回測
  panel.querySelector('#mcExitText').textContent = `階段 2/2:跑出場回測中...`;
  panel.querySelector('#mcExitFill').style.width = '30%';

  const onProgress = (done, total, current, partial) => {
    const fill = panel.querySelector('#mcExitFill');
    const text = panel.querySelector('#mcExitText');
    if (fill) fill.style.width = `${30 + (done / total) * 70}%`;
    if (text) text.textContent = `階段 2/2:已跑完 ${done}/${total} - ${current.code} ${current.name}`;
  };

  const multi = await runExitBacktest(items, onProgress, {
    sampleStep: 1,
    signal,
    entries,
    exitRules,
    etf0050Candles,
  });

  _exitAbortCtrl = null;
  _resetExitBtn();

  if (signal.aborted) {
    panel.querySelector('#mcExitText').textContent = '已取消';
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const ranked = findBestExitPerEntry(multi.aggregated);
  _renderExitResult(multi, ranked, elapsed, multi.healthReport);
}

function _renderExitResult(multi, ranked, elapsedSec, healthReport = '') {
  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  // 對應 exit-backtest.js 的 SWEET_SPOT_DAYS
  const SWEET_SPOT_DAYS_UI = [5, 10, 15, 20, 25, 30, 45, 60];

  const { perStock, formula } = multi;
  const okStocks = perStock.filter(r => r.ok);

  const _fmtPct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const _fmtRet = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const _winColor = (rate) => {
    if (rate == null) return '#8a8f99';
    const pct = rate * 100;
    return pct >= 70 ? '#4ade80' : pct >= 55 ? '#fbbf24' : '#f87171';
  };
  const _retColor = (ret) => {
    if (ret == null) return '#8a8f99';
    return ret >= 0.03 ? '#4ade80' : ret >= 0 ? '#fbbf24' : '#f87171';
  };

  // 渲染每個進場策略的區塊
  const blocks = ranked.map(entry => {
    // ── 甜蜜點折線圖 ──────────────────────────────────────────────
    const sw = entry.sweetSpot;
    let sweetSpotHtml = '';
    if (sw) {
      const days = SWEET_SPOT_DAYS_UI;
      const rets  = days.map(d => sw[d]?.avgReturn ?? null);
      const wins  = days.map(d => sw[d]?.winRate   ?? null);
      const validRets = rets.filter(v => v != null);
      if (validRets.length >= 2) {
        const minR = Math.min(...validRets);
        const maxR = Math.max(...validRets);
        const rng  = Math.max(maxR - minR, 0.005);
        const W = 340, H = 70, PAD_L = 32, PAD_R = 8, PAD_T = 8, PAD_B = 22;
        const iw = W - PAD_L - PAD_R;
        const ih = H - PAD_T - PAD_B;

        // 找甜蜜點(avgReturn 最大的那天)
        let peakIdx = 0;
        for (let i = 1; i < rets.length; i++) {
          if ((rets[i] ?? -Infinity) > (rets[peakIdx] ?? -Infinity)) peakIdx = i;
        }
        const peakDay = days[peakIdx];
        const peakRet = rets[peakIdx];

        const xPos = (i) => PAD_L + (i / (days.length - 1)) * iw;
        const yPos = (r) => PAD_T + ih - ((r - minR) / rng) * ih;

        // 折線點
        const pts = days.map((d, i) => {
          const r = rets[i];
          return r != null ? `${xPos(i).toFixed(1)},${yPos(r).toFixed(1)}` : null;
        }).filter(Boolean);

        // 填色漸層
        const fillPts = [...pts,
          `${xPos(days.length - 1).toFixed(1)},${(PAD_T + ih).toFixed(1)}`,
          `${xPos(0).toFixed(1)},${(PAD_T + ih).toFixed(1)}`
        ].join(' ');

        // Y 軸刻度
        const yLabelMid = ((minR + maxR) / 2 * 100).toFixed(1) + '%';
        const yLabelMax = (maxR * 100).toFixed(1) + '%';

        sweetSpotHtml = `
          <div class="mc-sweet-wrap">
            <div class="mc-sweet-title">📈 甜蜜點曲線 <span class="mc-sweet-peak">⭐ 第 ${peakDay} 天 (${(peakRet * 100).toFixed(2)}%)</span></div>
            <svg viewBox="0 0 ${W} ${H}" class="mc-sweet-svg">
              <!-- 格線 -->
              <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + ih}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
              <line x1="${PAD_L}" y1="${PAD_T + ih}" x2="${PAD_L + iw}" y2="${PAD_T + ih}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
              <!-- Y 軸標籤 -->
              <text x="${PAD_L - 3}" y="${PAD_T + 4}" text-anchor="end" fill="#6b7280" font-size="8">${yLabelMax}</text>
              <text x="${PAD_L - 3}" y="${PAD_T + ih / 2 + 3}" text-anchor="end" fill="#6b7280" font-size="8">${yLabelMid}</text>
              <!-- 填色面積 -->
              <polygon points="${fillPts}" fill="rgba(244,114,182,0.10)"/>
              <!-- 折線 -->
              <polyline points="${pts.join(' ')}" fill="none" stroke="#f472b6" stroke-width="1.8" stroke-linejoin="round"/>
              <!-- X 軸刻度 + 標籤 -->
              ${days.map((d, i) => {
                const x = xPos(i).toFixed(1);
                const y = PAD_T + ih;
                const isPeak = i === peakIdx;
                return `
                  <line x1="${x}" y1="${y}" x2="${x}" y2="${parseFloat(y) + 3}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                  <text x="${x}" y="${parseFloat(y) + 10}" text-anchor="middle" fill="${isPeak ? '#f9a8d4' : '#6b7280'}" font-size="8" font-weight="${isPeak ? '600' : '400'}">${d}</text>
                  ${rets[i] != null ? `<circle cx="${x}" cy="${yPos(rets[i]).toFixed(1)}" r="${isPeak ? 4 : 2.5}" fill="${isPeak ? '#f9a8d4' : '#f472b6'}" stroke="${isPeak ? '#fff' : 'none'}" stroke-width="${isPeak ? 1 : 0}"/>` : ''}
                `;
              }).join('')}
            </svg>
            <div class="mc-sweet-table">
              <table>
                <tr>
                  ${days.map((d, i) => {
                    const r = rets[i];
                    const w = wins[i];
                    const isPeak = i === peakIdx;
                    const col = r == null ? '#6b7280' : r >= 0.05 ? '#4ade80' : r >= 0.02 ? '#fbbf24' : r >= 0 ? '#f9a8d4' : '#f87171';
                    return `<td class="mc-sweet-td${isPeak ? ' mc-sweet-peak-td' : ''}" title="勝率 ${w != null ? (w*100).toFixed(0) + '%' : '—'}">
                      <b>${d}天</b><br>
                      <span style="color:${col}">${r != null ? (r >= 0 ? '+' : '') + (r * 100).toFixed(1) + '%' : '—'}</span>
                    </td>`;
                  }).join('')}
                </tr>
              </table>
            </div>
          </div>
        `;
      }
    }
    // 4 條出場規則一一渲染
    const rows = entry.allExits.map(exit => {
      const c = exit.summary;
      if (!c || c.trades < 5) {
        return `<tr>
          <td><b>${exit.label}</b><br><span class="mc-cross-diag-sub">${exit.desc}</span></td>
          <td colspan="7" class="mc-bt-na">樣本不足 (< 5 次觸發)</td>
        </tr>`;
      }
      const isBaseline = exit.ruleId === 'fixed-20d';
      const isBest = entry.bestExit?.ruleId === exit.ruleId;
      const rowClass = isBest ? 'mc-exit-row-best' : isBaseline ? 'mc-exit-row-baseline' : '';
      const labelBadge = isBest ? '⭐ 最佳' : isBaseline ? '📐 基準' : '';

      // 與基準的差距
      const base = entry.baseline?.summary;
      let deltaWin = '', deltaRet = '';
      if (!isBaseline && base && base.trades >= 5) {
        const dw = (c.winRate - base.winRate) * 100;
        const dr = (c.avgReturn - base.avgReturn) * 100;
        deltaWin = `<br><span style="font-size:9.5px;color:${dw >= 0 ? '#4ade80' : '#f87171'}">${dw >= 0 ? '+' : ''}${dw.toFixed(1)}%</span>`;
        deltaRet = `<br><span style="font-size:9.5px;color:${dr >= 0 ? '#4ade80' : '#f87171'}">${dr >= 0 ? '+' : ''}${dr.toFixed(2)}%</span>`;
      }

      // 出場理由前 2 名
      const reasons = Object.entries(c.exitReasonCounts || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([r, n]) => `${r} ${n}`)
        .join('<br>');

      const avgHold = c.avgHoldDays != null ? c.avgHoldDays.toFixed(1) : '—';

      return `<tr class="${rowClass}">
        <td>
          <b>${exit.label}</b>
          ${labelBadge ? `<br><span class="mc-exit-badge">${labelBadge}</span>` : ''}
          <br><span class="mc-cross-diag-sub">${exit.desc}</span>
        </td>
        <td style="color:${_winColor(c.winRate)}"><b>${_fmtPct(c.winRate)}</b><br><span class="mc-cross-diag-sub">${c.wins}/${c.trades}</span>${deltaWin}</td>
        <td style="color:${_retColor(c.avgReturn)}"><b>${_fmtRet(c.avgReturn)}</b>${deltaRet}</td>
        <td>${avgHold} 天</td>
        <td><span style="color:#4ade80">${_fmtRet(c.maxGain)}</span> / <span style="color:#f87171">${_fmtRet(c.maxLoss)}</span></td>
        <td colspan="3"><span class="mc-cross-diag-sub">${reasons || '—'}</span></td>
      </tr>`;
    }).join('');

    return `
      <div class="mc-exit-block">
        <div class="mc-exit-block-header">
          <span class="mc-exit-entry-id">${entry.id}</span>
          <span class="mc-exit-entry-label">${entry.label}</span>
          <span class="mc-exit-entry-note">${entry.note}</span>
        </div>
        ${sweetSpotHtml}
        <table class="mc-bt-table mc-exit-table">
          <thead>
            <tr>
              <th>出場規則</th>
              <th>勝率<br><span style="font-weight:400;font-size:10px">(1% 標的)</span></th>
              <th>平均報酬</th>
              <th>平均持有</th>
              <th>最佳/最差</th>
              <th colspan="3">主要出場原因</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }).join('');

  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🎯 出場驗證結果 (W6 單獨 vs 雙策略組合)</span>
        <span class="mc-bt-meta">${formula} · ${okStocks.length}/${perStock.length} 檔 · ${elapsedSec}秒</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="mc-bt-copy-btn" id="mcBtCopyExit" title="複製健檢報告文字">📋 複製報告</button>
        <button class="mc-bt-close" id="mcBtCloseExit" title="關閉">✕</button>
      </div>
    </div>

    <div class="mc-cross-summary">
      <div class="mc-cross-summary-item">
        <span class="mc-cross-summary-label">📌 設計</span>
        <span class="mc-cross-summary-val" style="font-size:11px">
          4 組進場 (W6 單獨 / W6+S40 / W6+S11 / W6+S14) × 全部出場規則對照（固定天數 / 追蹤停損 / 跌破MA20 / RSI / 妖股狀態機 / W14 / Supertrend 翻空 / 跌破錨定VWAP …）
          ·  最大持有 60 天  ·  收盤判定  ·  D+1 起判出場
          <br>雙策略組合 = 3 天內兩個訊號都觸發過才進場 · <b>📐 基準</b> = W6 單獨固定 20 天 · <b>⭐ 最佳</b> = 勝率 × 平均報酬最高
          <br>看雙策略組合是否比 W6 單獨更好 → 驗證「組合進場讓甜蜜點更陡」的假說
        </span>
      </div>
    </div>

    ${blocks}

    <div class="mc-bt-footnote">
      <b>解讀:</b>
      <br>• <b>勝率提升 + 平均報酬提升</b>:該出場規則完勝固定 20 天
      <br>• <b>勝率降但平均報酬大升</b>:適合「彩券型」(出場讓大賺照吃)
      <br>• <b>勝率升但平均報酬降</b>:適合「保守型」(早出場守住下檔)
      <br>• <b>都退步</b>:對該進場策略沒幫助
      <br><b>注意:</b>「出場原因」顯示哪些是真的觸發,哪些只是達 60 天到期被迫出場
    </div>
  `;

  document.getElementById('mcBtCloseExit')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  document.getElementById('mcBtCopyExit')?.addEventListener('click', () => {
    const btn = document.getElementById('mcBtCopyExit');
    navigator.clipboard.writeText(healthReport ?? '').then(() => {
      if (btn) { btn.textContent = '✅ 已複製！'; setTimeout(() => { btn.textContent = '📋 複製報告'; }, 2000); }
    }).catch(() => {
      if (btn) btn.textContent = '❌ 複製失敗';
    });
  });
}

// ============================================================================
// 核心計算
// ============================================================================
function _run(candles) {
  candles = candles || _refs?.getCandles?.() || [];
  if (!candles.length || !_canvas) return;

  const analysis = _refs?.getAnalysis?.();
  const s1Price  = analysis?.support?.items?.[0]?.price    || null;
  const r1Price  = analysis?.resistance?.items?.[0]?.price || null;
  const lastClose = candles[candles.length - 1].close;

  // ── 1. 基礎資料準備 ──────────────────────────────────────────────────
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume ?? 0);
  const N       = closes.length;
  const lookback = Math.min(N - 1, 60);

  // 對數報酬率序列
  const logRets = [];
  for (let i = N - lookback; i < N; i++) {
    logRets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean   = logRets.reduce((s, r) => s + r, 0) / logRets.length;
  const stdDev = Math.sqrt(logRets.reduce((s, r) => s + (r - mean) ** 2, 0) / logRets.length);

  // ── 2. 成交量係數 ────────────────────────────────────────────────────
  // 近 5 根均量 vs 近 60 根均量，判斷量能擴縮
  // 爆量 → σ 放大（不確定性高）；縮量 → σ 縮小（市場安靜）
  let volCoeff = 1.0;
  try {
    const vol5  = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const vol60 = volumes.slice(-Math.min(60, volumes.length))
                         .reduce((s, v) => s + v, 0) / Math.min(60, volumes.length);
    if (vol60 > 0) {
      const ratio = vol5 / vol60;
      // 爆量（>1.5x）→ 最多放大 20%；縮量（<0.6x）→ 最多縮小 20%
      volCoeff = Math.max(0.80, Math.min(1.20, 0.9 + ratio * 0.2));
    }
  } catch {}

  // ── 3. 量能 drift 偏移 ───────────────────────────────────────────────
  // 近期爆量上漲 → 量能支撐多方；爆量下跌 → 量能支撐空方
  let volDrift = 0;
  try {
    const recentVol  = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const avgVol     = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length);
    const recentDir  = logRets.slice(-5).reduce((s, r) => s + r, 0) / 5;  // 近5根平均方向
    if (avgVol > 0 && recentVol > avgVol * 1.3) {
      // 爆量：量能強化近期方向，但限制在 ±0.2σ
      volDrift = Math.max(-stdDev * 0.2, Math.min(stdDev * 0.2, recentDir * 0.3));
    }
  } catch {}

  // ── 4. 大盤 Beta 係數 ────────────────────────────────────────────────
  // 用個股近期波動率 vs 一般台股平均波動率估算 beta
  // 高 beta → 大盤影響大；低 beta → 防禦型，波動縮小
  // 注意：保守估計，beta 只用來收斂 σ，不做方向判斷
  let betaCoeff = 1.0;
  try {
    // 台股日K平均年化波動率約 25-30%，換算成每根 bar 約 0.015-0.018
    const mktAvgSigma = 0.016;
    if (stdDev > 0 && mktAvgSigma > 0) {
      const beta = stdDev / mktAvgSigma;
      // beta > 1.5 → 高波動股，σ 稍微收斂（保守）
      // beta < 0.7 → 防禦型，σ 維持
      betaCoeff = beta > 1.5 ? 0.92 : beta < 0.7 ? 1.0 : 1.0;
    }
  } catch {}

  // ── 5. 最終 σ（保守化：量能係數 × beta 係數）────────────────────────
  const finalStdDev = stdDev * volCoeff * betaCoeff;

  // ── 5.5 D6 歷史型態中線偏移 ─────────────────────────────────────────
  let patternDrift = 0;
  try {
    const patResult = findSimilarPatterns(candles);
    if (patResult?.patterns?.length > 0) {
      const followLen = patResult.followLen || 10;
      let totalRet = 0;
      for (const p of patResult.patterns) {
        if (p.followPct != null) {
          totalRet += Math.log(1 + p.followPct / 100) / followLen;
        }
      }
      patternDrift = totalRet / patResult.patterns.length;
    }
  } catch { patternDrift = 0; }

  // ── 6. v1.8 公式分派 — 依 stdDev 走四種 regime 各自的權重與 cap ─────
  const regime = _classifyRegime(stdDev);
  let driftPerBar = mean;
  try {
    const recentN    = Math.min(10, N - 1);
    const recentRets = logRets.slice(-recentN);
    const recentMean = recentRets.reduce((s, r) => s + r, 0) / recentN;

    driftPerBar = recentMean   * regime.w.rm
                + mean         * regime.w.m
                + volDrift     * regime.w.v
                + patternDrift * regime.w.p;

    const cap = finalStdDev * regime.cap;
    driftPerBar = Math.max(-cap, Math.min(cap, driftPerBar));
  } catch { driftPerBar = mean; }

  // ── 7. 跑 500 條路徑 ────────────────────────────────────────────────
  const paths = [];
  for (let p = 0; p < N_PATHS; p++) {
    const path = [lastClose];
    for (let i = 0; i < _simBars; i++) {
      const prev = path[path.length - 1];
      // 正態亂數（Box-Muller）
      const u1 = Math.random(), u2 = Math.random();
      const z  = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
      let ret   = driftPerBar + finalStdDev * z;

      // D2 軟約束：支撐壓力處概率偏移
      if (r1Price && prev < r1Price && prev * Math.exp(ret) > r1Price) {
        if (Math.random() < SOFT_DAMPEN) ret = -Math.abs(ret) * 0.3;
      }
      if (s1Price && prev > s1Price && prev * Math.exp(ret) < s1Price) {
        if (Math.random() < SOFT_DAMPEN) ret = Math.abs(ret) * 0.3;
      }

      path.push(prev * Math.exp(ret));
    }
    paths.push(path);
  }

  // ── 4. D3 情境路徑計算 ──────────────────────────────────────────────
  let bullPath = null, bearPath = null;

  if (_showBull && r1Price) {
    // 多頭情境：第一根直接站上 R1，之後依偏多 drift 延伸
    bullPath = [lastClose];
    const bullDrift = Math.abs(driftPerBar) + stdDev * 0.3;
    for (let i = 0; i < _simBars; i++) {
      const prev = bullPath[bullPath.length - 1];
      const next = i === 0 ? Math.max(prev * 1.015, r1Price * 1.002) : prev * Math.exp(bullDrift);
      bullPath.push(next);
    }
  }

  if (_showBear && s1Price) {
    // 空頭情境：第一根直接跌破 S1，之後依偏空 drift 延伸
    bearPath = [lastClose];
    const bearDrift = -(Math.abs(driftPerBar) + stdDev * 0.3);
    for (let i = 0; i < _simBars; i++) {
      const prev = bearPath[bearPath.length - 1];
      const next = i === 0 ? Math.min(prev * 0.985, s1Price * 0.998) : prev * Math.exp(bearDrift);
      bearPath.push(next);
    }
  }

  // ── 5. D4 真實K棒落點對比 ──────────────────────────────────────────
  const exceedMarkers = [];
  const breachMarkers = [];
  if (_lastResult) {
    const { upperBand, lowerBand, startCandle } = _lastResult;
    const startIdx = candles.findIndex(c => c.time >= startCandle);
    if (startIdx >= 0) {
      for (let i = 1; i <= _simBars && startIdx + i < candles.length; i++) {
        const c   = candles[startIdx + i];
        const ub  = upperBand?.[i];
        const lb  = lowerBand?.[i];
        if (ub != null && c.close > ub) exceedMarkers.push({ candle: c, idx: startIdx + i });
        if (lb != null && c.close < lb) breachMarkers.push({ candle: c, idx: startIdx + i });
      }
    }
  }

  // ── 6. 計算上下界供 D4 ───────────────────────────────────────────
  // 每個未來 bar 的 5th / 95th percentile
  const upperBand = [lastClose];
  const lowerBand = [lastClose];
  for (let i = 1; i <= _simBars; i++) {
    const prices = paths.map(p => p[i]).sort((a, b) => a - b);
    upperBand.push(prices[Math.floor(N_PATHS * 0.95)]);
    lowerBand.push(prices[Math.floor(N_PATHS * 0.05)]);
  }

  // 儲存結果供下次對比
  _lastResult = {
    paths,
    bullPath,
    bearPath,
    upperBand,
    lowerBand,
    startCandle: candles[candles.length - 1].time,
    startPrice:  lastClose,
    simBars:     _simBars,
    s1Price,
    r1Price,
    exceedMarkers,
    breachMarkers,
  };

  _draw(_lastResult);

  // 模擬完成 → 存摘要資料 + 顯示複製按鈕
  _lastResult._simMeta = {
    code: _refs?.getCode?.() ?? '?',
    name: _refs?.getName?.() ?? (window.__nameCache?.get?.(_refs?.getCode?.()) ?? ''),
    annualVol: +(finalStdDev * Math.sqrt(252) * 100).toFixed(1),
    driftPerBar, finalStdDev, simBars: _simBars,
    lastClose, s1Price, r1Price, regime: regime.name, volCoeff: +volCoeff.toFixed(3),
  };
  const copySimBtn = document.getElementById('mcBtCopySim');
  if (copySimBtn) copySimBtn.style.display = '';

  // 燈燈說一句
  _dengSayStart(finalStdDev, driftPerBar, s1Price, r1Price, volCoeff);
}

// ============================================================================
// K線縮排：讓右側有足夠空間顯示扇形
// ============================================================================
function _fitKlineLeft(simBars) {
  if (!_simChart) return;
  const ts = _simChart.timeScale();
  try {
    const logRange = ts.getVisibleLogicalRange();
    if (!logRange) return;
    const visibleBars = logRange.to - logRange.from;
    // 右側留 SIM_RATIO 比例 + simBars 根 + 緩衝 5 根
    // 確保扇形（上下都有路徑）完整顯示在右側空白區
    const rightOffset = Math.ceil(visibleBars * SIM_RATIO) + simBars + 5;
    ts.applyOptions({ rightOffset });
  } catch {}

  // Y 軸縱向留空（確保扇形上下不被截）
  try {
    _simChart.applyOptions({
      rightPriceScale: {
        scaleMargins: { top: 0.22, bottom: 0.18 },
      },
    });
  } catch {}
}

// ============================================================================
// 繪製 — 線條路徑模式（颱風路徑風格）
// ============================================================================
function _draw(result) {
  if (!_canvas || !_ctx2d || !_simChart || !_simSeries) return;

  const ts      = _simChart.timeScale();
  const candles = _refs?.getCandles?.() || [];
  if (!candles.length) return;

  const W = parseFloat(_canvas.style.width)  || _canvas.width;
  const H = parseFloat(_canvas.style.height) || _canvas.height;

  _ctx2d.clearRect(0, 0, W, H);

  const lastCandle = candles[candles.length - 1];
  const { paths, bullPath, bearPath, upperBand, lowerBand,
          startPrice, simBars, exceedMarkers, breachMarkers } = result;

  // ── X 座標：從最後一根往右推 ───────────────────────────────────────
  let logicalLast;
  try { logicalLast = ts.coordinateToLogical(ts.timeToCoordinate(lastCandle.time)); } catch { return; }
  if (logicalLast == null) return;

  const xCoords = [];
  for (let i = 0; i <= simBars; i++) {
    xCoords.push(ts.logicalToCoordinate(logicalLast + i));
  }

  // 確認至少第一個未來 X 可見
  const x0 = xCoords[0];
  if (x0 == null) return;

  // ── Y 轉換 ────────────────────────────────────────────────────────
  const priceToY = (price) => {
    try { return _simSeries.priceToCoordinate(price); } catch { return null; }
  };
  const currentY = priceToY(startPrice);
  if (currentY == null) return;

  // ── 1. 繪製 500 條半透明路徑線（颱風路徑核心）────────────────────
  // 每條線用現價以上紅/以下綠，半透明堆疊形成密度感
  _ctx2d.save();
  _ctx2d.lineWidth = 0.8;
  _ctx2d.setLineDash([]);

  for (const path of paths) {
    // 決定這條路徑的終點顏色（上漲=紅，下跌=綠）
    const finalPrice = path[path.length - 1];
    const isUp = finalPrice >= startPrice;
    const rgb  = isUp ? COLOR_BULL_RGB : COLOR_BEAR_RGB;
    _ctx2d.strokeStyle = `rgba(${rgb},${PATH_ALPHA})`;
    _ctx2d.beginPath();
    let started = false;
    for (let i = 0; i < path.length && i < xCoords.length; i++) {
      const x = xCoords[i];
      const y = priceToY(path[i]);
      if (x == null || y == null) { started = false; continue; }
      if (!started) { _ctx2d.moveTo(x, y); started = true; }
      else _ctx2d.lineTo(x, y);
    }
    _ctx2d.stroke();
  }
  _ctx2d.restore();

  // ── 2. 最高概率中線（各 bar 的中位數連線）────────────────────────
  const medianPath = [];
  for (let i = 0; i <= simBars; i++) {
    const prices = paths.map(p => p[i]).sort((a, b) => a - b);
    medianPath.push(prices[Math.floor(prices.length * 0.5)]);
  }
  _ctx2d.save();
  _ctx2d.lineWidth   = 2.5;
  _ctx2d.strokeStyle = COLOR_MED_LINE;
  _ctx2d.setLineDash([]);
  _ctx2d.shadowColor = 'rgba(255,200,50,0.4)';
  _ctx2d.shadowBlur  = 6;
  _ctx2d.beginPath();
  let medStarted = false;
  for (let i = 0; i <= simBars; i++) {
    const x = xCoords[i];
    const y = priceToY(medianPath[i]);
    if (x == null || y == null) { medStarted = false; continue; }
    if (!medStarted) { _ctx2d.moveTo(x, y); medStarted = true; }
    else _ctx2d.lineTo(x, y);
  }
  _ctx2d.stroke();
  _ctx2d.shadowBlur = 0;
  _ctx2d.restore();

  // ── 3. 上下界線（5th / 95th percentile）─────────────────────────
  _drawSolidLine(upperBand, xCoords, priceToY, COLOR_BOUND_UP, 1.5, [5, 3]);
  _drawSolidLine(lowerBand, xCoords, priceToY, COLOR_BOUND_DN, 1.5, [5, 3]);

  // ── 4. 現價水平延伸虛線 ────────────────────────────────────────────
  _ctx2d.save();
  _ctx2d.setLineDash([4, 4]);
  _ctx2d.strokeStyle = 'rgba(255,255,255,0.20)';
  _ctx2d.lineWidth   = 1;
  const xLast = xCoords[simBars] ?? xCoords[xCoords.length - 1];
  if (x0 != null && xLast != null && currentY != null) {
    _ctx2d.beginPath();
    _ctx2d.moveTo(x0, currentY);
    _ctx2d.lineTo(xLast, currentY);
    _ctx2d.stroke();
  }
  _ctx2d.restore();

  // ── 5. D3 情境路徑線 ─────────────────────────────────────────────
  if (bullPath) _drawSolidLine(bullPath, xCoords, priceToY, COLOR_BULL_LINE, 2, [8, 4]);
  if (bearPath) _drawSolidLine(bearPath, xCoords, priceToY, COLOR_BEAR_LINE, 2, [8, 4]);

  // ── 6. D4 落點標記 ───────────────────────────────────────────────
  _drawMarkers(exceedMarkers, ts, priceToY, COLOR_EXCEED, candles);
  _drawMarkers(breachMarkers, ts, priceToY, COLOR_BREACH, candles);

  // ── 7. 未來時間標記 ──────────────────────────────────────────
  _drawTimeLabels(xCoords, result, candles);
}

// ── 繪製輔助 ──────────────────────────────────────────────────────────────

function _drawSolidLine(band, xCoords, priceToY, color, lineWidth, dash) {
  if (!band?.length) return;
  _ctx2d.save();
  _ctx2d.setLineDash(dash || []);
  _ctx2d.strokeStyle = color;
  _ctx2d.lineWidth   = lineWidth || 1;
  _ctx2d.beginPath();
  let started = false;
  for (let i = 0; i < band.length && i < xCoords.length; i++) {
    const x = xCoords[i];
    const y = priceToY(band[i]);
    if (x == null || y == null) { started = false; continue; }
    if (!started) { _ctx2d.moveTo(x, y); started = true; }
    else _ctx2d.lineTo(x, y);
  }
  _ctx2d.stroke();
  _ctx2d.restore();
}

// 保留舊名稱相容性
function _drawBandLine(band, xCoords, priceToY, color, dash) {
  _drawSolidLine(band, xCoords, priceToY, color, 1, dash);
}

function _drawPathLine(path, xCoords, priceToY, color, lineWidth) {
  _drawSolidLine(path, xCoords, priceToY, color, lineWidth, [8, 4]);
}


// ============================================================================
// 未來時間標記 — 在 canvas 底部畫每根模擬 bar 的時間
// ============================================================================
function _drawTimeLabels(xCoords, result, candles) {
  if (!xCoords?.length || !candles?.length) return;
  const { simBars } = result;
  const lastCandle = candles[candles.length - 1];

  // 時間間隔
  const timeInterval = candles.length >= 2
    ? candles[candles.length - 1].time - candles[candles.length - 2].time
    : 86400;

  const secPerMonth = 86400 * 30;
  const secPerWeek  = 86400 * 7;

  function _fmtTime(unixSec) {
    const d = new Date(unixSec * 1000);
    const M = d.getMonth() + 1;
    const D = d.getDate();
    if (timeInterval >= secPerMonth) return `${d.getFullYear()}/${String(M).padStart(2,'0')}`;
    return `${M}/${String(D).padStart(2,'0')}`;
  }

  // 標記哪幾根：第1根 + 最後一根 + 中間等距，最多 5 個
  const step = Math.max(1, Math.ceil(simBars / 5));
  const labelSet = new Set([1, simBars]);
  for (let i = step; i < simBars; i += step) labelSet.add(i);

  _ctx2d.save();
  _ctx2d.font         = 'bold 10px -apple-system, sans-serif';
  _ctx2d.textAlign    = 'center';
  _ctx2d.textBaseline = 'top';

  for (let i = 1; i <= simBars; i++) {
    if (!labelSet.has(i)) continue;
    const x = xCoords[i];
    if (x == null || x < 0) continue;

    const futureTime = lastCandle.time + timeInterval * i;
    const label = _fmtTime(futureTime);

    // 標籤固定在 canvas 底部往上 24px，不隨價格移動
    const canvasH = _canvas.height / (window.devicePixelRatio || 1);
    const baseY   = canvasH - 24;
    if (baseY <= 0) continue;

    const tw = _ctx2d.measureText(label).width;

    // 膠囊背景
    _ctx2d.fillStyle = 'rgba(167,139,250,0.18)';
    if (_ctx2d.roundRect) {
      _ctx2d.beginPath();
      _ctx2d.roundRect(x - tw/2 - 4, baseY, tw + 8, 15, 3);
      _ctx2d.fill();
    } else {
      _ctx2d.fillRect(x - tw/2 - 4, baseY, tw + 8, 15);
    }

    // 細邊框
    _ctx2d.strokeStyle = 'rgba(167,139,250,0.45)';
    _ctx2d.lineWidth = 0.8;
    _ctx2d.setLineDash([]);
    if (_ctx2d.roundRect) {
      _ctx2d.beginPath();
      _ctx2d.roundRect(x - tw/2 - 4, baseY, tw + 8, 15, 3);
      _ctx2d.stroke();
    }

    // 文字
    _ctx2d.fillStyle = 'rgba(210,200,255,0.95)';
    _ctx2d.fillText(label, x, baseY + 2);
  }

  _ctx2d.restore();
}

function _drawMarkers(markers, ts, priceToY, color, candles) {
  if (!markers?.length) return;
  _ctx2d.save();
  _ctx2d.fillStyle = color;
  for (const m of markers) {
    let x;
    try { x = ts.timeToCoordinate(m.candle.time); } catch { continue; }
    const y = priceToY(m.candle.close);
    if (x == null || y == null) continue;
    // 菱形標記
    _ctx2d.beginPath();
    _ctx2d.moveTo(x,     y - 7);
    _ctx2d.lineTo(x + 5, y);
    _ctx2d.lineTo(x,     y + 7);
    _ctx2d.lineTo(x - 5, y);
    _ctx2d.closePath();
    _ctx2d.fill();
  }
  _ctx2d.restore();
}

// ============================================================================
// 燈燈台詞
// ============================================================================
function _dengSayStart(stdDev, drift, s1, r1, volCoeff = 1.0) {
  const annualVol = +(stdDev * Math.sqrt(252) * 100).toFixed(1);
  const biasDir   = drift > 0.0003 ? '偏多' : drift < -0.0003 ? '偏空' : '中性';
  const volState  = volCoeff > 1.1 ? '爆量' : volCoeff < 0.9 ? '縮量' : '正常量';

  let text, mood;

  if (annualVol > 40) {
    text = `這檔波動超大(年化 ${annualVol}%)，扇形很寬，保守參考就好 ~`;
    mood = 'curious';
  } else if (volState === '爆量' && biasDir === '偏多') {
    text = `量增價漲，扇形偏多 ~ 但爆量後容易震盪，停損設好`;
    mood = 'happy';
  } else if (volState === '爆量' && biasDir === '偏空') {
    text = `爆量下跌，扇形偏空 — 小心恐慌性賣壓，燈燈建議觀望`;
    mood = 'sad';
  } else if (volState === '縮量') {
    text = `縮量整理中，扇形收窄，方向${biasDir} ~ 等量能回來再判斷`;
    mood = 'curious';
  } else if (biasDir === '偏多') {
    text = `近期趨勢偏多，扇形往上傾斜 ~ 停損還是要設`;
    mood = 'happy';
  } else if (biasDir === '偏空') {
    text = `近期趨勢偏空，扇形往下傾斜 — 燈燈建議小心`;
    mood = 'sad';
  } else {
    text = `蒙地卡羅跑好了，扇形是保守估計的機率區間 ~ 僅供參考喵`;
    mood = 'curious';
  }

  if (s1 && r1) {
    text += `　支撐 $${s1} / 壓力 $${r1} 已設為錨點`;
  }

  dengToast(text, { mood, duration: 4500 });
}

// ============================================================================
// 🔬 XG/XI 組合拳驗證（v2.9，VVVIP 限定）
// 葛蘭碧強化版(XG1~XG4) + 一目強化版(XI1/XI4/XI7) vs 原始版本對照
// ============================================================================
async function _runXGXIBacktest() {
  if (window.__userTier !== 'vvvip') return;

  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { runExitBacktest, getDefaultExitRules, findBestExitPerEntry } = await import('./exit-backtest.js');
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  const basket    = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const exitRules = getDefaultExitRules();
  const total     = basket.length;

  // 只跑 XG/XI + 對照組原始版本
  const XGXI_ENTRIES = [
    // ── 對照組（葛蘭碧原始版）────────────────────────────────────────
    { id: 'S20', ids: ['S20'], label: 'S20 葛蘭碧買一（原始）', window: 1, note: '基準對照' },
    { id: 'S21', ids: ['S21'], label: 'S21 葛蘭碧買二（原始）', window: 1, note: '基準對照' },
    { id: 'S22', ids: ['S22'], label: 'S22 葛蘭碧買三（原始）', window: 1, note: '基準對照' },
    { id: 'S23', ids: ['S23'], label: 'S23 葛蘭碧買四（原始）', window: 1, note: '基準對照' },
    // ── 對照組（一目原始版）──────────────────────────────────────────
    { id: 'S_ICHI_CLOUD',    ids: ['S_ICHI_CLOUD'],    label: '一目雲層上行（原始）',   window: 1, note: '基準對照' },
    { id: 'S_ICHI_TK_CROSS', ids: ['S_ICHI_TK_CROSS'], label: '一目TK交叉（原始）',     window: 1, note: '基準對照' },
    { id: 'S_ICHI_3GOOD',    ids: ['S_ICHI_3GOOD'],    label: '一目三役好轉（原始）',   window: 1, note: '基準對照' },
    // ── XG 強化版（葛蘭碧組合拳）v2.9.1 修正 ────────────────────────
    { id: 'XG1', ids: ['S20', 'S31'],           label: 'XG1 葛蘭碧買一+DMI確認',   window: 3, note: '均線突破+趨勢強度，v2.9實證+30%勝率' },
    { id: 'XG2', ids: ['S21', 'S_ICHI_CLOUD'],  label: 'XG2 均線撐回+雲層上方',    window: 3, note: '拉回買點+一目雲層確認（同為中線型）' },
    { id: 'XG3', ids: ['S22', 'S1'],            label: 'XG3 快速收復+量價齊揚',    window: 2, note: '假跌破急彈+量能確認，v2.9實證+18%勝率' },
    { id: 'XG4', ids: ['S23', 'S30'],           label: 'XG4 超跌回均+PSY超賣',     window: 3, note: '均值回歸+心理線雙確認（S23樣本少）' },
    // ── XI 強化版（一目組合拳）v2.9.1 修正：改用同屬趨勢型條件 ────────
    { id: 'XI1', ids: ['S_ICHI_CLOUD', 'S33'],           label: 'XI1 雲層上行+EMA黃金交叉',  window: 3, note: '趨勢對趨勢，時間尺度匹配' },
    { id: 'XI4', ids: ['S_ICHI_TK_CROSS', 'S_ICHI_CLOUD'], label: 'XI4 TK交叉+雲層上方',      window: 3, note: '純一目系列雙確認' },
    { id: 'XI7', ids: ['S_ICHI_3GOOD', 'S33'],           label: 'XI7 三役好轉+EMA確認',      window: 3, note: '最強一目多頭+EMA趨勢確認' },
  ];

  // 只跑核心出場規則（省時）
  const CORE_EXIT_RULES = exitRules.filter(r =>
    ['fixed-20d', 'break-ma20', 'rsi-below-60', 'trailing-5pct'].includes(r.id)
  );

  const btn = document.getElementById('mcBtXGXI');
  if (btn) { btn.textContent = '✕ 取消組合拳驗證'; btn.classList.add('mc-bt-btn-running'); }

  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🔬 XG/XI 組合拳驗證 — 葛蘭碧 & 一目強化版 vs 原始版</span>
        <span class="mc-bt-meta" id="mcXGXIMeta">準備中...</span>
      </div>
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcXGXIFill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcXGXIText">拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcXGXIList"></div>
  `;

  _xgxiAbortCtrl = new AbortController();
  const signal = _xgxiAbortCtrl.signal;
  const t0 = performance.now();

  // 階段 1：拉 K 線
  const items = [];
  let etf0050Candles = null;
  try {
    const sym0050 = toYahooSymbol('0050');
    panel.querySelector('#mcXGXIText').textContent = '拉取 0050 市況資料...';
    etf0050Candles = await fetchHistory(sym0050, '1y');
  } catch (err) {
    console.warn('[xgxi-bt] 0050 拉取失敗:', err.message);
  }
  await new Promise(r => setTimeout(r, 300));

  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      panel.querySelector('#mcXGXIText').textContent = '已取消';
      if (btn) { btn.textContent = '🔬 組合拳驗證'; btn.classList.remove('mc-bt-btn-running'); }
      _xgxiAbortCtrl = null;
      return;
    }
    const { code, name, type } = basket[i];
    const pct = Math.round((i + 1) / total * 40);
    panel.querySelector('#mcXGXIFill').style.width = pct + '%';
    panel.querySelector('#mcXGXIText').textContent = `拉取 K 線 (${i + 1}/${total})：${name}`;
    try {
      const sym = toYahooSymbol(code);
      const candles = await fetchHistory(sym, '1y');
      items.push({ code, name, type, candles });
    } catch {
      items.push({ code, name, type, candles: null });
    }
    await new Promise(r => setTimeout(r, 250));
  }

  // 階段 2：跑回測
  panel.querySelector('#mcXGXIText').textContent = '跑回測中...';
  let done = 0;

  const result = await runExitBacktest(items, async (d, t) => {
    done = d;
    const pct = 40 + Math.round(d / t * 55);
    panel.querySelector('#mcXGXIFill').style.width = pct + '%';
    panel.querySelector('#mcXGXIText').textContent = `回測進度 (${d}/${t})...`;
  }, {
    sampleStep: 1,
    signal,
    entries:   XGXI_ENTRIES,
    exitRules: CORE_EXIT_RULES,
    etf0050Candles,
  });

  panel.querySelector('#mcXGXIFill').style.width = '100%';

  if (signal.aborted || result.aborted) {
    panel.querySelector('#mcXGXIText').textContent = '已取消';
    if (btn) { btn.textContent = '🔬 組合拳驗證'; btn.classList.remove('mc-bt-btn-running'); }
    _xgxiAbortCtrl = null;
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const bestList = findBestExitPerEntry(result.aggregated);

  // ── 渲染結果 ────────────────────────────────────────────────────────
  // 分三組：對照組葛蘭碧 / 對照組一目 / XG+XI 強化版
  const GROUPS = [
    { label: '📊 葛蘭碧 — 原始 vs 強化', ids: ['S20','S21','S22','S23','XG1','XG2','XG3','XG4'] },
    { label: '☁️ 一目均衡表 — 原始 vs 強化', ids: ['S_ICHI_CLOUD','S_ICHI_TK_CROSS','S_ICHI_3GOOD','XI1','XI4','XI7'] },
  ];

  // 差異計算工具
  const _diff = (enhanced, baseline) => {
    if (!enhanced || !baseline) return '';
    const d = ((enhanced - baseline) * 100).toFixed(1);
    return d > 0 ? `<span style="color:#ef5350">+${d}%</span>` : `<span style="color:#26a69a">${d}%</span>`;
  };

  // 找對照組基準
  const _baseline = (id) => bestList.find(e => e.id === id);

  let html = `
    <div class="mc-bt-header" style="margin-top:8px">
      <span class="mc-bt-title">🔬 XG/XI 組合拳驗證結果（${items.filter(i=>i.candles).length} 檔 × ${elapsed}s）</span>
    </div>
    <div style="font-size:11px;color:#8a8f99;padding:4px 8px;margin-bottom:4px">
      ✦ 強化版 = 原始策略 + 第二條件（window=2~3天），驗證加條件後勝率是否提升<br>
      ✦ 出場規則：固定20天 / 跌破MA20 / RSI&lt;60 / 追蹤停損5%（取最佳）
    </div>`;

  for (const group of GROUPS) {
    html += `<div style="margin:8px 0 4px 8px;font-size:12px;font-weight:600;color:#facc15">${group.label}</div>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr style="color:#8a8f99;border-bottom:1px solid #30363d">
          <th style="text-align:left;padding:3px 6px">策略</th>
          <th style="text-align:right;padding:3px 6px">次數</th>
          <th style="text-align:right;padding:3px 6px">勝率</th>
          <th style="text-align:right;padding:3px 6px">均報</th>
          <th style="text-align:right;padding:3px 6px">最佳出場</th>
        </tr>
      </thead>
      <tbody>`;

    for (const id of group.ids) {
      const entry = bestList.find(e => e.id === id);
      if (!entry) continue;
      const best = entry.bestExit;
      const c = best?.targets?.['1pct'];
      const isEnhanced = id.startsWith('XG') || id.startsWith('XI');
      const rowColor = isEnhanced ? 'rgba(250,204,21,0.05)' : '';

      // 找對應對照組
      let baselineId = null;
      if (id === 'XG1') baselineId = 'S20';
      else if (id === 'XG2') baselineId = 'S21';
      else if (id === 'XG3') baselineId = 'S22';
      else if (id === 'XG4') baselineId = 'S23';
      else if (id === 'XI1') baselineId = 'S_ICHI_CLOUD';
      else if (id === 'XI4') baselineId = 'S_ICHI_TK_CROSS';
      else if (id === 'XI7') baselineId = 'S_ICHI_3GOOD';

      const baseEntry = baselineId ? bestList.find(e => e.id === baselineId) : null;
      const baseC = baseEntry?.bestExit?.targets?.['1pct'];

      const wr = c?.winRate != null ? (c.winRate * 100).toFixed(1) + '%' : '—';
      const ar = c?.avgReturn != null ? (c.avgReturn * 100).toFixed(1) + '%' : '—';
      const trades = c?.trades ?? 0;

      const wrDiff = isEnhanced && baseC?.winRate != null && c?.winRate != null
        ? _diff(c.winRate, baseC.winRate) : '';
      const arDiff = isEnhanced && baseC?.avgReturn != null && c?.avgReturn != null
        ? _diff(c.avgReturn, baseC.avgReturn) : '';

      html += `<tr style="border-bottom:1px solid #21262d;background:${rowColor}">
        <td style="padding:4px 6px;color:${isEnhanced ? '#facc15' : '#e6edf3'}">
          ${isEnhanced ? '↑ ' : ''}${entry.label}
          ${isEnhanced ? `<br><span style="color:#8a8f99;font-size:10px">${entry.note}</span>` : ''}
        </td>
        <td style="text-align:right;padding:4px 6px;color:#8a8f99">${trades}</td>
        <td style="text-align:right;padding:4px 6px">${wr} ${wrDiff}</td>
        <td style="text-align:right;padding:4px 6px">${ar} ${arDiff}</td>
        <td style="text-align:right;padding:4px 6px;color:#8a8f99;font-size:10px">${best?.label ?? '—'}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `<div style="font-size:10px;color:#8a8f99;padding:6px 8px;margin-top:4px">
    ✦ 差異值（紅=提升 / 綠=下降）= 強化版 − 原始版<br>
    ✦ 觸發次數少（&lt;5）的結果不可信，請以大樣本為主<br>
    ✦ 建議搭配「出場驗證」完整版做更深入比較
  </div>
  <div style="padding:6px 8px;margin-top:2px">
    <button id="mcXGXICopyBtn" class="mc-bt-copy-btn" style="font-size:11px">📋 複製結果</button>
  </div>`;

  panel.querySelector('#mcXGXIList').innerHTML = html;
  panel.querySelector('#mcXGXIMeta').textContent = `完成 ${items.filter(i=>i.candles).length} 檔，耗時 ${elapsed}s`;

  // 複製按鈕邏輯
  panel.querySelector('#mcXGXICopyBtn')?.addEventListener('click', () => {
    const copyBtn = panel.querySelector('#mcXGXICopyBtn');
    const lines = [
      `🔬 XG/XI 組合拳驗證結果（${items.filter(i=>i.candles).length} 檔 × ${elapsed}s）`,
      `v2.9.1 修正版：葛蘭碧強化(XG) + 一目強化(XI) vs 原始對照`,
      `${'─'.repeat(60)}`,
      `策略\t次數\t勝率\t均報\t最佳出場\t備註`,
    ];
    for (const group of GROUPS) {
      lines.push('');
      lines.push(group.label);
      for (const id of group.ids) {
        const entry = bestList.find(e => e.id === id);
        if (!entry) continue;
        const best = entry.bestExit;
        const c = best?.targets?.['1pct'];
        const isEnhanced = id.startsWith('XG') || id.startsWith('XI');
        const wr  = c?.winRate  != null ? (c.winRate  * 100).toFixed(1) + '%' : '—';
        const ar  = c?.avgReturn != null ? (c.avgReturn * 100).toFixed(1) + '%' : '—';
        const trades = c?.trades ?? 0;

        // 對照組基準
        let baselineId = null;
        if (id === 'XG1') baselineId = 'S20';
        else if (id === 'XG2') baselineId = 'S21';
        else if (id === 'XG3') baselineId = 'S22';
        else if (id === 'XG4') baselineId = 'S23';
        else if (id === 'XI1') baselineId = 'S_ICHI_CLOUD';
        else if (id === 'XI4') baselineId = 'S_ICHI_TK_CROSS';
        else if (id === 'XI7') baselineId = 'S_ICHI_3GOOD';
        const baseEntry = baselineId ? bestList.find(e => e.id === baselineId) : null;
        const baseC = baseEntry?.bestExit?.targets?.['1pct'];

        let diffStr = '';
        if (isEnhanced && baseC) {
          const wrD = c?.winRate  != null && baseC.winRate  != null ? ((c.winRate  - baseC.winRate)  * 100).toFixed(1) : null;
          const arD = c?.avgReturn != null && baseC.avgReturn != null ? ((c.avgReturn - baseC.avgReturn) * 100).toFixed(1) : null;
          if (wrD != null) diffStr = `勝率${wrD > 0 ? '+' : ''}${wrD}% 均報${arD > 0 ? '+' : ''}${arD}%`;
        }

        const prefix = isEnhanced ? '↑ ' : '  ';
        lines.push(`${prefix}${entry.label}\t${trades}\t${wr}\t${ar}\t${best?.label ?? '—'}\t${diffStr || entry.note || ''}`);
      }
    }
    lines.push('');
    lines.push('✦ 差異值 = 強化版 − 原始版（正值=提升）');
    lines.push('✦ 觸發次數 < 5 的結果不可信');
    lines.push(`✦ basket: ${items.filter(i=>i.candles).map(i=>i.name).join('、')}`);

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      if (copyBtn) { copyBtn.textContent = '✅ 已複製！'; setTimeout(() => { copyBtn.textContent = '📋 複製結果'; }, 2000); }
    }).catch(() => {
      if (copyBtn) copyBtn.textContent = '❌ 複製失敗';
    });
  });

  if (btn) { btn.textContent = '🔬 組合拳驗證'; btn.classList.remove('mc-bt-btn-running'); }
  _xgxiAbortCtrl = null;
}

// ============================================================================
// 🧪 X6~X11 純K線特化策略驗證（v2.9，VVVIP 限定）
// 在正式導入 strategy.js 前先用 MC 回測驗證有效性
// 對照組：X1/X2/X5 現有實證版本
// ============================================================================
async function _runX611Backtest() {
  if (window.__userTier !== 'vvvip') return;

  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { runExitBacktest, getDefaultExitRules, findBestExitPerEntry } = await import('./exit-backtest.js');
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  const basket    = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const exitRules = getDefaultExitRules();
  const total     = basket.length;

  // 只跑 X6~X11 + 對照組，核心出場規則省時
  const X611_ENTRIES = [
    { id: 'X1_ref', ids: ['X1'], label: 'X1 黃金比例（對照）',   window: 1, note: '實證基準' },
    { id: 'X2_ref', ids: ['X2'], label: 'X2 天黑請閉眼（對照）', window: 1, note: '實證基準' },
    { id: 'X5_ref', ids: ['X5'], label: 'X5 潛龍勿用（對照）', window: 1, note: '實證基準' },
    { id: 'X6',  ids: ['X6'],  label: 'X6 跳空缺口突破',     window: 1, note: '跳空≥1.5% + 放量 + MA20上' },
    { id: 'X7',  ids: ['X7'],  label: 'X7 缺口未回補強勢',   window: 1, note: '近期缺口開放 + RSI>50' },
    { id: 'X6',  ids: ['X6'],  label: 'X6 見龍在田',          window: 1, note: '5日波動<3%盤整後放量突破，實證達標' },
    { id: 'X9',  ids: ['X9'],  label: 'X9 量縮後放量突破',   window: 1, note: '連3日縮量後爆量突破前高' },
    { id: 'X10', ids: ['X10'], label: 'X10 均線多頭排列完成', window: 1, note: 'EMA三線剛完成多頭排列' },
    { id: 'X11', ids: ['X11'], label: 'X11 強化黃金交叉',    window: 1, note: 'EMA穿越+量+MACD三重確認' },
  ];

  const CORE_RULES = exitRules.filter(r =>
    ['fixed-20d', 'break-ma20', 'rsi-below-60', 'trailing-5pct'].includes(r.id)
  );

  const btn = document.getElementById('mcBtX611');
  if (btn) { btn.textContent = '✕ 取消驗證'; btn.classList.add('mc-bt-btn-running'); }

  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🧪 X6~X11 純K線特化驗證 — vs X1/X2/X5 對照</span>
        <span class="mc-bt-meta" id="mcX611Meta">準備中...</span>
      </div>
    </div>
    <div style="font-size:11px;color:#8a8f99;padding:4px 8px 0">
      ⚠️ 需已覆蓋含新 condId 的 screener.js，否則 X6~X11 觸發次數全為 0
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcX611Fill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcX611Text">拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcX611List"></div>
  `;

  _x611AbortCtrl = new AbortController();
  const signal = _x611AbortCtrl.signal;
  const t0 = performance.now();

  // 拉 K 線
  const items = [];
  let etf0050Candles = null;
  try {
    panel.querySelector('#mcX611Text').textContent = '拉取 0050 市況資料...';
    etf0050Candles = await fetchHistory(toYahooSymbol('0050'), '1y');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));

  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      if (btn) { btn.textContent = '🧪 X6~X11驗證'; btn.classList.remove('mc-bt-btn-running'); }
      _x611AbortCtrl = null;
      return;
    }
    const { code, name, type } = basket[i];
    panel.querySelector('#mcX611Fill').style.width = Math.round((i + 1) / total * 40) + '%';
    panel.querySelector('#mcX611Text').textContent = `拉取 K 線 (${i + 1}/${total})：${name}`;
    try {
      const candles = await fetchHistory(toYahooSymbol(code), '1y');
      items.push({ code, name, type, candles });
    } catch {
      items.push({ code, name, type, candles: null });
    }
    await new Promise(r => setTimeout(r, 250));
  }

  panel.querySelector('#mcX611Text').textContent = '跑回測中...';

  const result = await runExitBacktest(items, async (d, t) => {
    panel.querySelector('#mcX611Fill').style.width = (40 + Math.round(d / t * 55)) + '%';
    panel.querySelector('#mcX611Text').textContent = `回測進度 (${d}/${t})...`;
  }, { sampleStep: 1, signal, entries: X611_ENTRIES, exitRules: CORE_RULES, etf0050Candles });

  panel.querySelector('#mcX611Fill').style.width = '100%';

  if (signal.aborted || result.aborted) {
    if (btn) { btn.textContent = '🧪 X6~X11驗證'; btn.classList.remove('mc-bt-btn-running'); }
    _x611AbortCtrl = null;
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const bestList = findBestExitPerEntry(result.aggregated);

  // 判斷是否所有 X6~X11 都是 0 次（screener.js 未更新）
  const x6_11ids = ['X6'];  // 只保留 X6 見龍在田（其餘已移除）
  const allZero = x6_11ids.every(id => {
    const e = bestList.find(b => b.id === id);
    return !e || (e.bestExit?.targets?.['1pct']?.trades ?? 0) === 0;
  });

  const GROUPS = [
    { label: '📊 對照組（X1~X5 實證版）', ids: ['X1_ref','X2_ref','X5_ref'] },
    { label: '🧪 X6~X11 新策略（實驗中）', ids: x6_11ids },
  ];

  const _fmt = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const _diff = (a, refId) => {
    const refE = bestList.find(e => e.id === refId);
    const refC = refE?.bestExit?.targets?.['1pct'];
    const myE  = bestList.find(e => e.id === a);
    const myC  = myE?.bestExit?.targets?.['1pct'];
    if (!refC?.winRate || !myC?.winRate) return '';
    const d = ((myC.winRate - refC.winRate) * 100).toFixed(1);
    return Number(d) > 0
      ? `<span style="color:#ef5350">+${d}%</span>`
      : `<span style="color:#26a69a">${d}%</span>`;
  };

  let html = `
    <div class="mc-bt-header" style="margin-top:8px">
      <span class="mc-bt-title">🧪 X6~X11 驗證結果（${items.filter(i=>i.candles).length} 檔 × ${elapsed}s）</span>
    </div>`;

  if (allZero) {
    html += `<div style="padding:12px 8px;color:#f59e0b;font-size:12px;background:rgba(245,158,11,0.1);border-radius:6px;margin:8px">
      ⚠️ X6~X11 觸發次數全為 0，請先覆蓋含新 condId 的 screener.js 再重跑
    </div>`;
  }

  html += `<div style="font-size:11px;color:#8a8f99;padding:4px 8px;margin-bottom:4px">
    ✦ 差異值 = vs X1 對照（正紅=優於X1，負綠=不如X1）<br>
    ✦ 觸發次數 &lt; 5 結果不可信｜目標：勝率 ≥ X1 且均報 &gt; 0
  </div>`;

  const copyLines = [
    `🧪 X6~X11 純K線特化驗證結果（${items.filter(i=>i.candles).length} 檔 × ${elapsed}s）`,
    `對照：X1/X2/X5 實證版，目標：勝率≥X1 且均報>0`,
    '─'.repeat(60),
    '策略\t次數\t勝率\t均報\t最佳出場\t備註',
  ];

  for (const group of GROUPS) {
    html += `<div style="margin:8px 0 4px 8px;font-size:12px;font-weight:600;color:#facc15">${group.label}</div>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="color:#8a8f99;border-bottom:1px solid #30363d">
        <th style="text-align:left;padding:3px 6px">策略</th>
        <th style="text-align:right;padding:3px 6px">次數</th>
        <th style="text-align:right;padding:3px 6px">勝率</th>
        <th style="text-align:right;padding:3px 6px">均報</th>
        <th style="text-align:right;padding:3px 6px">最佳出場</th>
      </tr></thead><tbody>`;

    copyLines.push('');
    copyLines.push(group.label);

    for (const id of group.ids) {
      const entry = bestList.find(e => e.id === id);
      if (!entry) continue;
      const best   = entry.bestExit;
      const c      = best?.targets?.['1pct'];
      const isNew  = x6_11ids.includes(id);
      const wr     = _fmt(c?.winRate);
      const ar     = _fmt(c?.avgReturn);
      const trades = c?.trades ?? 0;
      const diff   = isNew ? _diff(id, 'X1_ref') : '';
      const verdict = isNew && trades >= 5
        ? (c?.winRate > 0.34 && c?.avgReturn > 0
            ? '<span style="color:#ef5350;font-weight:600">✅ 達標</span>'
            : '<span style="color:#26a69a">❌ 未達標</span>')
        : '';

      html += `<tr style="border-bottom:1px solid #21262d;background:${isNew ? 'rgba(250,204,21,0.04)' : ''}">
        <td style="padding:4px 6px;color:${isNew ? '#facc15' : '#e6edf3'}">
          ${entry.label} ${verdict}
          ${isNew ? `<br><span style="color:#8a8f99;font-size:10px">${entry.note}</span>` : ''}
        </td>
        <td style="text-align:right;padding:4px 6px;color:#8a8f99">${trades}</td>
        <td style="text-align:right;padding:4px 6px">${wr} ${diff}</td>
        <td style="text-align:right;padding:4px 6px">${ar}</td>
        <td style="text-align:right;padding:4px 6px;color:#8a8f99;font-size:10px">${best?.label ?? '—'}</td>
      </tr>`;

      const diffTxt = isNew && bestList.find(e=>e.id==='X1_ref')?.bestExit?.targets?.['1pct']?.winRate != null && c?.winRate != null
        ? `vs X1 ${((c.winRate - (bestList.find(e=>e.id==='X1_ref').bestExit.targets['1pct'].winRate)) * 100).toFixed(1)}%` : '';
      copyLines.push(`${isNew ? '↑ ' : '  '}${entry.label}\t${trades}\t${wr}\t${ar}\t${best?.label ?? '—'}\t${diffTxt || entry.note}`);
    }
    html += `</tbody></table>`;
  }

  html += `<div style="font-size:10px;color:#8a8f99;padding:6px 8px;margin-top:4px">
    ✦ 達標條件：勝率 &gt; X1（~34%）且均報 &gt; 0%<br>
    ✦ 達標 → 正式覆蓋 strategy.js｜未達標 → 調整條件後再測
  </div>
  <div style="padding:6px 8px">
    <button id="mcX611CopyBtn" class="mc-bt-copy-btn" style="font-size:11px">📋 複製結果</button>
  </div>`;

  panel.querySelector('#mcX611List').innerHTML = html;
  panel.querySelector('#mcX611Meta').textContent = `完成 ${items.filter(i=>i.candles).length} 檔，耗時 ${elapsed}s`;

  panel.querySelector('#mcX611CopyBtn')?.addEventListener('click', () => {
    const copyBtn = panel.querySelector('#mcX611CopyBtn');
    copyLines.push('');
    copyLines.push(`✦ basket: ${items.filter(i=>i.candles).map(i=>i.name).join('、')}`);
    navigator.clipboard.writeText(copyLines.join('\n')).then(() => {
      if (copyBtn) { copyBtn.textContent = '✅ 已複製！'; setTimeout(() => { copyBtn.textContent = '📋 複製結果'; }, 2000); }
    }).catch(() => { if (copyBtn) copyBtn.textContent = '❌ 複製失敗'; });
  });

  if (btn) { btn.textContent = '🧪 X6~X11驗證'; btn.classList.remove('mc-bt-btn-running'); }
  _x611AbortCtrl = null;
}

// ============================================================================
// 🐉 亢龍有悔出場驗證（v2.9，VVVIP 限定）
// 比較 E8/E9/E10 三種新出場規則 vs 現有 MA20/追蹤停損/固定20天
// 進場固定用 X2（飆股加速）和 X1+X2（妖股雙確認），聚焦飆股場景
// ============================================================================
async function _runKangBacktest() {
  if (window.__userTier !== 'vvvip') return;

  const panel = document.getElementById('mcBtPanel');
  if (!panel) return;

  const { runExitBacktest, findBestExitPerEntry } = await import('./exit-backtest.js');
  const { getDefaultBacktestBasket } = await import('./mc-backtest.js');
  const { fetchHistory, toYahooSymbol } = await import('./api.js');

  const basket = (_customBasket && _customBasket.length > 0) ? _customBasket : getDefaultBacktestBasket();
  const total  = basket.length;

  // 進場：X2 單獨 + X1+X2 雙確認（飆股場景）
  const KANG_ENTRIES = [
    { id: 'X2_kang',   ids: ['X2'],       label: 'X2 天黑請閉眼',    window: 1, note: '飆股加速進場', isYaogu: true },
    { id: 'X1X2_kang', ids: ['X1','X2'],  label: 'X1+X2 妖股雙確認', window: 1, note: '最強妖股進場', isYaogu: true },
    { id: 'X6_kang',   ids: ['X6'],       label: 'X6 見龍在田',       window: 1, note: '盤整噴出進場', isYaogu: true },
  ];

  // 出場規則：現有 vs 新三種
  const KANG_EXIT_RULES = [
    { id: 'fixed-20d',     label: '固定 20 天',             desc: '基準對照' },
    { id: 'break-ma20',    label: '跌破 MA20',              desc: '現有主力出場' },
    { id: 'trailing-5pct', label: '追蹤停損 5%',            desc: '現有止損出場' },
    { id: 'x1-exit',       label: 'X1 消失出場',            desc: '妖股狀態機' },
    { id: 'w14-exit',      label: '🐉 亢龍有悔（W14）',     desc: 'MACD高位死叉，純K線計算' },
    { id: 'w14-half-ma20', label: '🐉 分批亢龍（W14+MA20）',desc: 'W14出50%+MA20出50%' },
    { id: 'vol-fade-exit', label: '🌊 量退潮',               desc: '連2日量縮收黑，最早偵測' },
    { id: 'x2-exit',       label: '🌑 X2 消失出場',          desc: '飆股加速訊號消失即離場' },
  ];

  const btn = document.getElementById('mcBtKang');
  if (btn) { btn.textContent = '✕ 取消驗證'; btn.classList.add('mc-bt-btn-running'); }

  panel.style.display = '';
  panel.innerHTML = `
    <div class="mc-bt-header">
      <div>
        <span class="mc-bt-title">🐉 亢龍有悔出場驗證 — E8/E9/E10 vs 現有出場規則</span>
        <span class="mc-bt-meta" id="mcKangMeta">準備中...</span>
      </div>
    </div>
    <div style="font-size:11px;color:#8a8f99;padding:4px 8px 0">
      進場：X2 飆股加速 / X1+X2 妖股雙確認 / X6 見龍在田<br>
      出場：固定20天 / MA20 / 追蹤5% / X1消失 / W14即出 / W14+MA20分批 / 量退潮
    </div>
    <div class="mc-cross-progress">
      <div class="mc-cross-progress-bar"><div class="mc-cross-progress-fill" id="mcKangFill" style="width:0%"></div></div>
      <div class="mc-cross-progress-text" id="mcKangText">拉取 ${total} 檔 K 線資料...</div>
    </div>
    <div class="mc-cross-list" id="mcKangList"></div>
  `;

  _kangAbortCtrl = new AbortController();
  const signal = _kangAbortCtrl.signal;
  const t0 = performance.now();

  // 拉 K 線
  const items = [];
  let etf0050Candles = null;
  try {
    panel.querySelector('#mcKangText').textContent = '拉取 0050 市況資料...';
    etf0050Candles = await fetchHistory(toYahooSymbol('0050'), '1y');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));

  for (let i = 0; i < basket.length; i++) {
    if (signal.aborted) {
      if (btn) { btn.textContent = '🐉 亢龍有悔'; btn.classList.remove('mc-bt-btn-running'); }
      _kangAbortCtrl = null;
      return;
    }
    const { code, name, type } = basket[i];
    panel.querySelector('#mcKangFill').style.width = Math.round((i + 1) / total * 40) + '%';
    panel.querySelector('#mcKangText').textContent = `拉取 K 線 (${i + 1}/${total})：${name}`;
    try {
      const candles = await fetchHistory(toYahooSymbol(code), '1y');
      items.push({ code, name, type, candles });
    } catch {
      items.push({ code, name, type, candles: null });
    }
    await new Promise(r => setTimeout(r, 250));
  }

  panel.querySelector('#mcKangText').textContent = '跑回測中...';

  const result = await runExitBacktest(items, async (d, t) => {
    panel.querySelector('#mcKangFill').style.width = (40 + Math.round(d / t * 55)) + '%';
    panel.querySelector('#mcKangText').textContent = `回測進度 (${d}/${t})...`;
  }, { sampleStep: 1, signal, entries: KANG_ENTRIES, exitRules: KANG_EXIT_RULES, etf0050Candles });

  panel.querySelector('#mcKangFill').style.width = '100%';

  if (signal.aborted || result.aborted) {
    if (btn) { btn.textContent = '🐉 亢龍有悔'; btn.classList.remove('mc-bt-btn-running'); }
    _kangAbortCtrl = null;
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const bestList = findBestExitPerEntry(result.aggregated);

  // 渲染：每個進場策略 × 所有出場規則對照表
  const NEW_EXITS = ['w14-exit', 'w14-half-ma20', 'vol-fade-exit'];
  const copyLines = [
    `🐉 亢龍有悔出場驗證結果（${items.filter(i=>i.candles).length} 檔 × ${elapsed}s）`,
    '進場：X2 / X1+X2 / X6　出場：7種規則對照',
    '─'.repeat(70),
  ];

  let html = `
    <div class="mc-bt-header" style="margin-top:8px">
      <span class="mc-bt-title">🐉 亢龍有悔驗證結果（${items.filter(i=>i.candles).length} 檔 × ${elapsed}s）</span>
    </div>
    <div style="font-size:11px;color:#8a8f99;padding:4px 8px;margin-bottom:6px">
      ✦ 新出場（🐉/🌊）= 亢龍有悔系列，紅色框線標示<br>
      ✦ 目標：新出場均報 &gt; 跌破MA20，且勝率不低於追蹤停損5%
    </div>`;

  for (const entry of KANG_ENTRIES) {
    const aggEntry = result.aggregated[entry.id];
    if (!aggEntry) continue;

    copyLines.push('');
    copyLines.push(`【進場：${entry.label}】`);
    copyLines.push('出場規則\t次數\t勝率(1%)\t均報\t平均持有');

    html += `<div style="margin:10px 0 4px 8px;font-size:12px;font-weight:600;color:#e6edf3">
      進場：${entry.label} <span style="color:#8a8f99;font-weight:400;font-size:11px">${entry.note}</span>
    </div>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:6px">
      <thead><tr style="color:#8a8f99;border-bottom:1px solid #30363d">
        <th style="text-align:left;padding:3px 8px">出場規則</th>
        <th style="text-align:right;padding:3px 6px">次數</th>
        <th style="text-align:right;padding:3px 6px">勝率(1%)</th>
        <th style="text-align:right;padding:3px 6px">均報</th>
        <th style="text-align:right;padding:3px 6px">平均持有</th>
      </tr></thead><tbody>`;

    // 找 MA20 基準
    const baseC = aggEntry.exitRules?.['break-ma20']?.targets?.['1pct'];

    for (const exitRule of KANG_EXIT_RULES) {
      const ruleData = aggEntry.exitRules?.[exitRule.id]?.targets?.['1pct'];
      if (!ruleData) continue;
      const isNew = NEW_EXITS.includes(exitRule.id);
      const trades = ruleData.trades ?? 0;
      const wr  = ruleData.winRate   != null ? (ruleData.winRate   * 100).toFixed(1) + '%' : '—';
      const ar  = ruleData.avgReturn != null ? (ruleData.avgReturn * 100).toFixed(1) + '%' : '—';
      const hd  = ruleData.avgHoldDays != null ? ruleData.avgHoldDays.toFixed(1) + '天' : '—';

      // vs MA20 差異
      let diffHtml = '';
      if (isNew && baseC?.avgReturn != null && ruleData.avgReturn != null) {
        const d = ((ruleData.avgReturn - baseC.avgReturn) * 100).toFixed(1);
        diffHtml = Number(d) > 0
          ? ` <span style="color:#ef5350;font-size:10px">+${d}%↑</span>`
          : ` <span style="color:#26a69a;font-size:10px">${d}%↓</span>`;
      }

      const rowStyle = isNew
        ? 'border-bottom:1px solid #30363d;background:rgba(239,83,80,0.06);border-left:2px solid rgba(239,83,80,0.4)'
        : 'border-bottom:1px solid #21262d';

      html += `<tr style="${rowStyle}">
        <td style="padding:4px 8px;color:${isNew ? '#ef5350' : '#8a8f99'}">${exitRule.label}</td>
        <td style="text-align:right;padding:4px 6px;color:#8a8f99">${trades}</td>
        <td style="text-align:right;padding:4px 6px">${wr}</td>
        <td style="text-align:right;padding:4px 6px">${ar}${diffHtml}</td>
        <td style="text-align:right;padding:4px 6px;color:#8a8f99">${hd}</td>
      </tr>`;

      copyLines.push(`${isNew ? '🐉 ' : '  '}${exitRule.label}\t${trades}\t${wr}\t${ar}\t${hd}`);
    }
    html += `</tbody></table>`;
  }

  html += `<div style="font-size:10px;color:#8a8f99;padding:6px 8px;margin-top:4px">
    ✦ 差異值 = 新出場均報 − MA20出場均報（正紅=優於MA20）<br>
    ✦ 平均持有天數越短 = 出場越早（量退潮應最短，W14次之）<br>
    ✦ 達標：均報 &gt; MA20 且 平均持有 &lt; MA20
  </div>
  <div style="padding:6px 8px">
    <button id="mcKangCopyBtn" class="mc-bt-copy-btn" style="font-size:11px">📋 複製結果</button>
  </div>`;

  panel.querySelector('#mcKangList').innerHTML = html;
  panel.querySelector('#mcKangMeta').textContent = `完成 ${items.filter(i=>i.candles).length} 檔，耗時 ${elapsed}s`;

  panel.querySelector('#mcKangCopyBtn')?.addEventListener('click', () => {
    const copyBtn = panel.querySelector('#mcKangCopyBtn');
    copyLines.push('');
    copyLines.push(`✦ basket: ${items.filter(i=>i.candles).map(i=>i.name).join('、')}`);
    navigator.clipboard.writeText(copyLines.join('\n')).then(() => {
      if (copyBtn) { copyBtn.textContent = '✅ 已複製！'; setTimeout(() => { copyBtn.textContent = '📋 複製結果'; }, 2000); }
    }).catch(() => { if (copyBtn) copyBtn.textContent = '❌ 複製失敗'; });
  });

  if (btn) { btn.textContent = '🐉 亢龍有悔'; btn.classList.remove('mc-bt-btn-running'); }
  _kangAbortCtrl = null;
}
