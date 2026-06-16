/**
 * main.js
 * 應用程式入口 — v2（IndexedDB + 群組自選清單 + Sidebar 拖曳）
 */

// ── 關閉 console（生產環境，避免洩漏內部資訊）──────────────
// 開發時若需要看 log，在 Chrome Console 執行：
//   window.__devMode = true; location.reload();
if (!localStorage.getItem('__devMode')) {
  const _noop = () => {};
  console.log   = _noop;
  console.warn  = _noop;
  console.info  = _noop;
  console.debug = _noop;
  // console.error 保留（讓真正的錯誤還是看得到）
}
// ────────────────────────────────────────────────────────────

import { AppState, updateWatchlistPrice } from './state.js';
import { toYahooSymbol, resolveYahooSymbol, fetchQuote, fetchHistory, fetchHistoryCached, fetchTWSEPrices, getChineseName, ensureChineseName, preloadNamesFromFirestore, preloadBundles, fetchSnapshot, fetchHealthSnapshot, fetchCondHistory } from './api.js';
import {
  initCharts, renderChartData, setSubChartsActive,
  getMainChart, getCandleSeries, getMainChartEl,
  getMacdChart, getMacdChartEl,
  getKdChart,   getKdChartEl,
  getRsiChart,  getRsiChartEl,
  setChartFixed,
} from './chart.js';

// ── Phase 7：K 線編輯模式 + 智能分析 ──
import { initChartEdit, enterEditMode, exitEditMode, isEditing,
         loadAnnotationsForCode, reattachAfterReload } from './chart-edit.js';
import { initAnalysisCard, renderAnalysisPanel, refreshAnalysis, getLastAnalysisResult } from './chart-analysis-card.js';
import { renderPersonas } from './personas-ui.js';
import { initPersonasPanel, resetPersonasPanel } from './personas-panel.js';

// ── Phase 7.1：燈燈導讀系統 ──
import {
  showDengLoading, hideDengLoading,
  dengToast, pickDengMessage, initDengWakeup,
} from './loading-deng.js';
import './deng-messages.js';  // 燈燈台詞庫 → window.__DENG_MESSAGES

// ── Phase 7.2/7.3：AI 解說疊圖 + 說明區 ──
import {
  initSignalOverlay, renderSignalLayer, clearSignalLayer, getActiveSignal,
} from './chart-signal-overlay.js';
import { initAnalysisPanel } from './chart-analysis-panel.js';

// ── Phase 7.4:多週期共振 Tab ──
import { initMultiPeriod, renderMultiPeriod } from './multi-period.js';

// ── Phase 8:蒙地卡羅模擬器 ──
import { initMonteCarlo, openMonteCarloMenu, closeMonteCarlo } from './monte-carlo.js';

// ── Advanced 2:個股補充資訊 ──
import { initStockInfo, setStockInfoCode, renderStockInfo } from './stock-info.js';

import {
  startClock, setHeaderLoading, updateHeader,
  showLoading, updateDataInfo, showToast, initUIEvents,
  renderWeeklyStageBadges, ensureTADaily,
} from './ui.js';
import { initSettingsDrawer, openSettings } from './settings.js';
import { initStockTabs, reloadStockTabs, renderStockSignals, ensureFundamentals } from './stock-tabs.js';
import { initStrategyPanel, getSignalPeriod, refreshStrategyCards, calcSignalLamps, STRATEGIES } from './strategy.js';
import { initStrategyModal, renderStrategyGrid } from './modal-strategy.js';
import { initPortfolio, refreshHealthFromPrice } from './portfolio-ui.js';
import { initPatternDraw, updateScreenerCount } from './pattern-draw.js';
import { initScreenerHub } from './screener-hub.js';
import { initStrategyLab } from './strategy-lab.js';
import { initMarketMini } from './market-mini.js';
import { initMarketPulse } from './market-pulse.js';
import { initHotgroup }  from './market.js';
import { initHotgroupTabs } from './hotgroup-tabs.js';
import { initTheme, reloadThemes } from './theme.js';
import { renderThemePanel } from './theme-ui.js';

// Phase 7.3 v2 — 全視窗深度解讀
import { initFullscreenAnalysis, destroyFullscreenAnalysis, refreshFullscreenAnalysis } from './analysis-fullscreen.js';
import './analysis-perspective.js';  // 觀點 Tab — 自動 registerAnalysisModule

// ── 資料庫 / 設定 ──
import { initDB, migrateFromLocalStorage, cleanupExpiredKlineCache, loadAllLastPrices, deleteKlineCache, syncCloudToLocal, syncLocalToCloud, getKlineCache } from './db.js';
import { loadConfig }    from './config.js';
import { initWatchlist, reloadWatchlist, addStockToGroup, getDefaultGroupId, updateStockPrices, createGroup } from './watchlist.js';
import * as PriceHub from './price-hub.js';
import { initLayout }    from './layout.js';
// screener-result-store 的 UI 邏輯已整合進 screener-ui.js，不需在此 import
import { startSignalTimer, scanWatchlistSignals, restoreSignalsFromCache, scanOneCode } from './signal-scan.js';

// ── Firebase Auth UI（新增）──
import { initAuthUI } from './auth-ui.js';
import { applyTierGate, loadFeatureGates } from './auth-gate.js';
import { syncTokenFromCloud } from './config.js';
import { initStockPreview } from './stock-preview.js';

// ─────────────────────────────────────────────
// 載入完整股票資料
// ─────────────────────────────────────────────
async function loadStock(code, opts = {}) {
  AppState.activeCode    = code;
  window.__stockDashCode = code;
  const force = !!opts.force;

  // 點開個股時先跑 scanOneCode，確保妖股狀態在渲染前更新完畢
  // force:true 確保不用舊快取，渲染時 AppState.yaoguStatus[code] 已是最新
  scanOneCode(code, { force: true }).catch(() => {});

  showLoading(true);
  setHeaderLoading(code);
  updateDataInfo('載入中…');
  _switchStockTab('chart');
  // 手機版：推出個股全頁
  window.__mobileOpenStock?.();

  // ── Phase 7.1:燈燈導讀 loading ──
  let dengHandle = null;
  showDengLoading({
    scenario: 'loading',
    style: 'overlay',
    mood: 'curious',
  }).then(h => {
    dengHandle = h;
    // 1.2 秒後換台詞
    setTimeout(() => {
      dengHandle?.setMessage(pickDengMessage('analyzing'), 'curious');
    }, 1200);
  });

  try {
    // resolveYahooSymbol 會自動處理上市/上櫃判斷,_otcSet 未載入時 fallback 試兩個 suffix
    // force=true 時跳過 K 線快取

    // ── 名稱修正：先確保中文名到位，不等批次 TWSE ──
    // ensureChineseName 有三道防線（TWSE單筆 → TPEx → FinMind直連），FinMind支援CORS不需proxy
    // 與 resolveYahooSymbol 並行，不影響載入速度
    const [{ symbol, candles }] = await Promise.all([
      resolveYahooSymbol(code, AppState.period, { force }),
      getChineseName(code) ? Promise.resolve() : ensureChineseName(code).catch(() => {}),
    ]);

    // fetchQuote 失敗時 fallback：優先用 IDB R2 K 線最後一根（當天今收，最可靠），
    // 再 fallback priceCache。盤後 Yahoo 502 時 priceCache 可能是過期昨收或壞資料，
    // 而 R2 bundle 是 GAS 盤後抓的今收。
    const [quote] = await Promise.all([
      fetchQuote(symbol).catch(async () => {
        // 1) 先試 IDB K 線最後一根（兩個 suffix）
        try {
          const sym1 = symbol;
          const sym2 = sym1.endsWith('.TW') ? sym1.replace('.TW', '.TWO') : sym1.replace('.TWO', '.TW');
          const hit  = await getKlineCache(sym1, '1y').catch(() => null)
                    || await getKlineCache(sym2, '1y').catch(() => null);
          const cs   = hit?.candles;
          if (cs && cs.length >= 2) {
            const last = cs[cs.length - 1];
            const prev = cs[cs.length - 2];
            const chgPct = prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
            return {
              price:  last.close,
              prev:   prev.close,
              chgPct: chgPct,
              open:   last.open  ?? null,
              high:   last.high  ?? null,
              low:    last.low   ?? null,
              volume: last.volume ?? null,
              name:   null,
            };
          }
        } catch (_) {}
        // 2) 再 fallback priceCache（可能過期）
        const cached = window.__priceCache?.[code];
        return cached ? {
          price:  cached.price,
          prev:   cached.prev  ?? cached.price,
          chgPct: cached.chgPct ?? 0,
          open: null, high: null, low: null, volume: null, name: null,
        } : { price: 0, prev: 0, chgPct: 0, open: null, high: null, low: null, volume: null, name: null };
      }),
    ]);

    const { chg, chgPct } = updateHeader(code, quote);

    // ── 補刷中文名：立刻補 + 二次保險 ──
    // ⚠️ 踩雷備忘：
    //   ensureChineseName 與 resolveYahooSymbol 並行，但 fetchQuote 比它快
    //   updateHeader 跑的當下中文名可能還沒到，填了 Yahoo 英文名
    //   修法：updateHeader 後立刻 await ensureChineseName 結果補填；
    //         再用 Promise.race 等 Firebase/TWSE 批次做二次保險
    {
      const chName = getChineseName(code)
        || window.__nameCache?.get?.(code)
        || await ensureChineseName(code).catch(() => null);
      if (chName && AppState.activeCode === code) {
        const el = document.getElementById('shName');
        if (el && el.textContent !== chName) el.textContent = chName;
      }
    }
    Promise.race([
      window.__namesReady      ?? Promise.resolve(),
      window.__twsePricesReady ?? Promise.resolve(),
    ]).then(() => {
      const chName = getChineseName(code) || window.__nameCache?.get?.(code);
      if (chName && AppState.activeCode === code) {
        const el = document.getElementById('shName');
        if (el && el.textContent !== chName) el.textContent = chName;
        // ⚠️ namefix push 必須帶 prev：否則 PriceHub 存入時 prev 缺失，
        //   被當成 prev=price → chgPct 算錯（昨收=今收）。
        //   quote.prev 來自 fetchQuote（或失敗 fallback 的 IDB K 線前一根），是正確昨收。
        PriceHub.push({ [code]: { price: quote.price, prev: quote.prev, chg, chgPct, name: chName } }, { persist: false, updateHeader: false, source: 'loadStock-namefix' });
        reloadStockTabs(code, chName);
        window.__mobileUpdateTitle?.(`${chName}（${code}）`);
        window.__mobileRenderWatchlist?.();
      }
    });

    // 優先用中文名（_nameCache 由 ensureChineseName/TWSE/FinMind 填入），fallback 才用 Yahoo 英文名
    const displayName = getChineseName(code) || quote.name;

    // ── Yahoo fetchQuote 含 open/high/low，是最完整的報價來源 → 統一走 PriceHub ──
    PriceHub.push({
      [code]: {
        price:  quote.price,
        prev:   quote.prev,
        open:   quote.open,
        high:   quote.high,
        low:    quote.low,
        volume: quote.volume,
        name:   displayName,
      }
    }, { persist: false, updateHeader: false, source: 'yahoo-quote' });
    // ⚠️ updateHeader: false 因為上方已呼叫 updateHeader(code, quote)，避免重複渲染

    reloadStockTabs(code, displayName);
    setStockInfoCode(code);
    initCharts();
    renderChartData(candles);
    updateDataInfo(`${candles.length} 根K棒 · 最後更新 ${new Date().toLocaleTimeString('zh-TW')}`);

    // ── 訊號計算週期（與圖表顯示週期分開）────────────────────────────────
    // 用 getSignalPeriod() 查詢全策略最低需求，決定訊號計算要用哪個週期。
    // 結果快取在 window.__signalPeriod，避免每次進股票都重算（策略定義不會在 runtime 改變）。
    // ⚠️ 踩雷備忘(2026-05-23):
    //   訊號計算與圖表顯示必須用不同週期，否則 1mo(22根) 不夠 Ichimoku(需52根)，
    //   导致篩選找得到但個股訊號跑不出來。詳見 ROADMAP_SIGNAL_PERIOD_0523_1730.md
    if (!window.__signalPeriod) {
      window.__signalPeriod = getSignalPeriod().period;
      console.log(`[main] 訊號計算週期: ${window.__signalPeriod}（依全策略最低需求自動決定）`);
    }
    const signalPeriod = window.__signalPeriod;
    // 週期根數對照（用根數比較，避免 1y > 6mo 反而去拉更短的）
    const _PC = { '5d':5,'1mo':22,'3mo':65,'6mo':130,'1y':250,'2y':500 };
    const currentCandles = _PC[AppState.period] ?? 65;
    const neededCandles  = _PC[signalPeriod]    ?? 130;

    if (currentCandles < neededCandles) {
      // 圖表週期根數不足 → 另外拉訊號週期的 K 線（IndexedDB 快取優先，通常免打 API）
      fetchHistoryCached(symbol, signalPeriod).then(longCandles => {
        if (AppState.activeCode !== code) return;  // 已切換到別支股票
        renderStockSignals(longCandles?.length >= 30 ? longCandles : candles, code);
        // v2.8 訊號掃完才跑分析卡片，確保 AppState.signals[code] 已填入
        // 讓 calcHealthWithSignals 能拿到 X 系列加成
        renderAnalysisPanel(code);
        ensureFundamentals(code).catch(() => {});  // 預先載入基本面，觀點卡用
      }).catch(() => {
        renderStockSignals(candles, code);
        renderAnalysisPanel(code);
        ensureFundamentals(code).catch(() => {});  // 預先載入基本面，觀點卡用
      });
    } else {
      // 圖表週期根數已足夠（6mo/1y/2y），直接用，不多打 API
      renderStockSignals(candles, code);
      // v2.8 同步路徑：renderStockSignals 是同步的，訊號已寫入，直接接著跑
      renderAnalysisPanel(code);
      ensureFundamentals(code).catch(() => {});  // 預先載入基本面，觀點卡用
    }

    // ── Phase 7：載入該檔的標註 + 跑智能分析 ──
    loadAnnotationsForCode(code);
    // renderAnalysisPanel 已移入上方各路徑（訊號掃完後才跑）

    // 更新標題列「加入自選」按鈕狀態
    _updateAddToWatchlistBtn(code, quote);

    // ── 盤中輪詢：看哪檔就追那檔的即時報價 + K線 ──
    window.__startIntradayPolling?.(code);

    // ── Phase 7.1：完成,燈燈說完成台詞後淡出 ──
    // Phase 7.5 A3: 完成後延遲一下,讀 analyze 結果說一句個股活台詞
    if (dengHandle) {
      dengHandle.setMessage(pickDengMessage('complete'), 'happy');
      setTimeout(() => hideDengLoading(dengHandle), 900);
    }
    // A3: 1.5 秒後 analyze 結果出來,燈燈說一句跟這檔有關的話(只在有明顯訊號時)
    setTimeout(() => {
      try {
        const r = getLastAnalysisResult();
        const line = _dengLineForStock(r);
        if (line) dengToast(line.text, { mood: line.mood, duration: 4000 });

        // AI 圓桌:5 門派觀點
        try {
          // 從 lastCandles 算 quote(現價、漲跌幅、爆量旗標)
          const candles = AppState?.lastCandles ?? [];
          const last = candles[candles.length - 1];
          const prev = candles[candles.length - 2];
          const quote = last ? {
            price:  last.close,
            prev:   prev?.close ?? last.close,
            chgPct: prev ? ((last.close - prev.close) / prev.close) * 100 : 0,
          } : {};
          // priceCache 有的話覆蓋(更新)
          const cached = window.__priceCache?.[AppState?.activeCode];
          if (cached?.chgPct != null) { quote.price = cached.price; quote.chgPct = cached.chgPct; }

          resetPersonasPanel();  // 切換個股時重置 AI 圓桌 Panel
          renderPersonas({
            analysis: r,
            quote,
            fundamentals: window.__lastFundamentals ?? {},   // 由基本面 Tab 載入時填
            chips:        window.__lastChips ?? {},          // 由籌碼 Tab 載入時填
            signals:      AppState?.signals?.[AppState.activeCode] ?? [],
            taiex:        window.__taiexState ?? {},
          });
        } catch (e) { console.warn('[personas] render failed:', e); }
      } catch (_) { /* 不影響主流程 */ }
    }, 1500);
  } catch (e) {
    showToast('⚠ 無法取得資料：' + e.message);
    updateDataInfo('載入失敗');
    console.error('[main] loadStock error:', e);
    // ── Phase 7.1：失敗讓燈燈表達 ──
    if (dengHandle) {
      dengHandle.setMessage(pickDengMessage('error'), 'sad');
      setTimeout(() => hideDengLoading(dengHandle), 2500);
    }
  } finally {
    showLoading(false);
  }
}

// ─────────────────────────────────────────────
// 僅重刷圖表
// ─────────────────────────────────────────────
let _reloadInFlight = false;
let _reloadPending  = false;

async function reloadChart(opts = {}) {
  if (!AppState.activeCode) return;
  const force = !!opts.force;

  // 已在 reload 中 → 排隊一次,最新狀態為準
  if (_reloadInFlight) {
    _reloadPending = true;
    return;
  }
  _reloadInFlight = true;

  showLoading(true);
  const symbol = toYahooSymbol(AppState.activeCode);
  try {
    const candles = await fetchHistoryCached(symbol, AppState.period, { force });
    initCharts();
    renderChartData(candles);
    updateDataInfo(`${candles.length} 根K棒 · 最後更新 ${new Date().toLocaleTimeString('zh-TW')}`);
    // Phase 7:時間週期切換後刷新智能分析
    refreshAnalysis();
  } catch (e) {
    showToast('⚠ 圖表更新失敗:' + e.message);
  } finally {
    showLoading(false);
    _reloadInFlight = false;

    // 處理排隊:如果在 reload 過程中又有人按了,再跑一次(最新狀態)
    if (_reloadPending) {
      _reloadPending = false;
      reloadChart();
    }
  }
}

// ─────────────────────────────────────────────
// 個股內頁 Tab 切換
// ─────────────────────────────────────────────
// 手機版橋接
window.__switchStockTab = (tab) => _switchStockTab(tab);
window.__loadStock = (code) => loadStock(code);
const _isMobile = () => window.matchMedia('(max-width: 767px)').matches;

function _switchStockTab(tab) {
  document.querySelectorAll('.stock-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.stockTab === tab);
  });
  document.querySelectorAll('.stock-panel').forEach(p => {
    p.classList.toggle('active', p.id === `${tab}Panel`);
  });
}
window.__switchStockTab = _switchStockTab;
window.__loadStock = (code) => loadStock(code);

// ─────────────────────────────────────────────
// 桌面主 Tab
// ─────────────────────────────────────────────
function initMainTabs() {
  document.querySelectorAll('.main-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const activePanel = document.getElementById(`tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
      if (activePanel) {
        activePanel.style.display = '';  // 清除 inline style，讓 CSS class 生效
        activePanel.classList.add('active');
      }
      // 強勢族群 Tab 懶載入（等 panel display 後再 init，避免 canvas 尺寸 0）
      if (tab === 'hotgroup') requestAnimationFrame(() => { initHotgroup(); initHotgroupTabs(); });
      // AI 圓桌 Tab：動態渲染（VVVIP 限定，personas-panel.js）
      if (tab === 'personas') requestAnimationFrame(() => initPersonasPanel());
      // 題材追蹤 Tab 懶載入：每次切入都重讀，避免 IndexedDB/雲端同步時序問題
      if (tab === 'theme') {
        requestAnimationFrame(async () => {
          await reloadThemes();
          renderThemePanel();
        });
      }
      // 庫存 Tab：每次切入也重讀（同步時序保護）
      if (tab === 'portfolio') {
        requestAnimationFrame(() => window.__portfolioAPI?.reload?.());
      }
      // 選股篩選 Hub（個股篩選 / 型態比對 / 種子選股）
      if (tab === 'hub') {
        requestAnimationFrame(() => window.__screenerHubSwitch?.());
      }
      // 策略實驗室（lazy init）
      if (tab === 'lab') {
        requestAnimationFrame(() => initStrategyLab().catch(e => console.error('[main] initStrategyLab:', e)));
      }
    });
  });
}

// ─────────────────────────────────────────────
// 手機 Tab Bar
// ─────────────────────────────────────────────
function initMobileTabs() {
  if (!window.matchMedia('(max-width: 767px)').matches) return;

  document.querySelectorAll('.tab-item[data-mobile-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.mobileTab;

      if (tab === 'settings') { openSettings(); return; }

      // active 狀態
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 所有 tab-panel 隱藏
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      // 對應 panel 顯示
      const panelId = {
        chart:     'tabChart',
        watchlist: 'tabWatchlist',
        screener:  'tabScreener',
        theme:     'tabTheme',
      }[tab];
      if (panelId) document.getElementById(panelId)?.classList.add('active');

      // 題材頁：觸發重載
      if (tab === 'theme') {
        document.dispatchEvent(new CustomEvent('mobileRefreshTheme'));
      }

      // 自選頁：手機版由 mobile-watchlist.js 獨立管理，不同步桌機版 HTML
    });
  });
}

// 把 sidebar 的 watchlistContainer 內容同步到手機版 panel
// Phase 10.1：手機版 watchlist 由 mobile-watchlist.js 獨立管理，不同步桌機版 HTML
function _syncMobileWatchlist() {}

function _bridgeWlButtons() {
  const pairs = [
    ['wlMobileRescan',  'watchlistRescanAll'],
    ['wlMobileAddStock','watchlistAddStock'],
    ['wlMobileAddGroup','watchlistAddGroup'],
    ['wlMobileImport',  'watchlistImportBtn'],
    ['wlMobileMenuBtn', 'wlMenuBtn'],
  ];
  pairs.forEach(([mobileId, desktopId]) => {
    const mobileBtn  = document.getElementById(mobileId);
    const desktopBtn = document.getElementById(desktopId);
    if (!mobileBtn || !desktopBtn) return;
    mobileBtn.onclick = () => desktopBtn.click();
  });
}

function _toggleMobileSidebar(show) {
  // v2：sidebar 改為抽屜式，由 layout.js 統一管理開關
  if (show) window.__drawerOpen?.();
  else      window.__drawerClose?.();
}

// ─────────────────────────────────────────────
// 標題列「加入自選」按鈕
// ─────────────────────────────────────────────
function _updateAddToWatchlistBtn(code, quote) {
  const btn = document.getElementById('shAddToWatchlist');
  if (!btn) return;

  const groups = AppState.watchlistGroups ?? [];
  const isInAny = groups.some(g => g.stocks.some(s => s.code === code));

  btn.textContent  = isInAny ? '✓ 已加入' : '＋ 加入自選';
  btn.className    = isInAny ? 'sh-add-btn sh-add-btn--added' : 'sh-add-btn';
  btn.disabled     = isInAny;
  btn.dataset.code = code;

  // 只綁一次（換個股時只更新外觀，不重複 addEventListener）
  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const c      = btn.dataset.code;
      const gid    = getDefaultGroupId();
      const name   = getChineseName(c) ?? quote?.name ?? c;
      const price  = window.__priceCache?.[c]?.price ?? quote?.price ?? null;
      const chg    = window.__priceCache?.[c]?.chg    ?? null;
      const chgPct = window.__priceCache?.[c]?.chgPct ?? null;
      await addStockToGroup({ code: c, name, price, chg, chgPct }, gid);
      _updateAddToWatchlistBtn(c, quote);
    });
  }
}

// ─────────────────────────────────────────────
// 搜尋列：代號/股名 autocomplete + info card
// ─────────────────────────────────────────────
function initSearchAdd() {
  const searchInput = document.getElementById('searchInput');
  const searchBtn   = document.querySelector('.search-btn');
  const dropdown    = document.getElementById('searchDropdown');

  let _focusIdx = -1;
  let _results  = [];

  // ── 執行搜尋並載入個股 ────────────────────────
  async function doSearch(code) {
    code = (code || searchInput.value.trim()).toUpperCase();
    if (!code) return;
    _closeDropdown();
    loadStock(code);
    searchInput.value = '';
    try {
      const symbol = toYahooSymbol(code);
      const quote  = await fetchQuote(symbol);
      _showSearchCard(code, quote);
    } catch (e) {
      showToast('⚠ 找不到此代號：' + code);
    }
  }

  // ── 渲染 dropdown ─────────────────────────────
  function _renderDropdown(q) {
    if (!dropdown) return;
    if (!q) { _closeDropdown(); return; }

    _results  = _searchStocks(q).slice(0, 12);
    _focusIdx = -1;

    if (_results.length === 0) {
      // 純數字就直接允許查（可能是剛上市沒在快取裡）
      if (/^\d+$/.test(q)) {
        dropdown.innerHTML = `<div class="search-dd-item" data-code="${q}">
          <span class="search-dd-code">${q}</span>
          <span class="search-dd-name">直接查詢</span>
        </div>`;
      } else {
        dropdown.innerHTML = `<div class="search-dd-empty">找不到「${q}」相關個股</div>`;
      }
    } else {
      dropdown.innerHTML = _results.map((r, i) => {
        // 高亮匹配（用 indexOf 避免 RegExp 跳脫問題）
        function _hl(str, kw) {
          const idx = str.toLowerCase().indexOf(kw.toLowerCase());
          if (idx < 0) return str;
          return str.slice(0, idx)
            + '<mark style="background:rgba(96,165,250,.25);color:#93c5fd;border-radius:2px">'
            + str.slice(idx, idx + kw.length) + '</mark>'
            + str.slice(idx + kw.length);
        }
        const nameHl = _hl(r.name, q);
        const codeHl = r.code.toUpperCase().startsWith(q.toUpperCase())
          ? '<mark style="background:rgba(96,165,250,.25);color:#93c5fd;border-radius:2px">'
            + r.code.slice(0, q.length) + '</mark>' + r.code.slice(q.length)
          : r.code;
        return `<div class="search-dd-item" data-code="${r.code}" data-idx="${i}">
          <span class="search-dd-code">${codeHl}</span>
          <span class="search-dd-name">${nameHl}</span>
        </div>`;
      }).join('');
    }

    dropdown.classList.add('open');

    // 點擊選項
    dropdown.querySelectorAll('.search-dd-item[data-code]').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();  // 避免 input blur 先觸發
        doSearch(item.dataset.code);
      });
    });
  }

  function _closeDropdown() {
    dropdown?.classList.remove('open');
    _focusIdx = -1;
  }

  function _moveFocus(dir) {
    const items = dropdown?.querySelectorAll('.search-dd-item[data-code]');
    if (!items?.length) return;
    _focusIdx = Math.max(-1, Math.min(items.length - 1, _focusIdx + dir));
    items.forEach((el, i) => el.classList.toggle('focused', i === _focusIdx));
    if (_focusIdx >= 0) searchInput.value = items[_focusIdx].dataset.code;
  }

  // ── 事件綁定 ──────────────────────────────────
  searchInput?.addEventListener('input', () => _renderDropdown(searchInput.value.trim()));

  searchInput?.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); _moveFocus(1); return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); _moveFocus(-1); return; }
    if (e.key === 'Escape')     { _closeDropdown(); return; }
    if (e.key === 'Enter')      { doSearch(); return; }
  });

  searchBtn?.addEventListener('click', () => doSearch());

  // 點擊外部關閉
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-box')) _closeDropdown();
  });

  // 取得焦點時若有內容就重開
  searchInput?.addEventListener('focus', () => {
    if (searchInput.value.trim()) _renderDropdown(searchInput.value.trim());
  });
}

// ─────────────────────────────────────────────
// 搜尋 info card（顯示個股簡介 + 選群組加入）
// ─────────────────────────────────────────────
function _showSearchCard(code, quote) {
  document.getElementById('searchInfoCard')?.remove();

  const { getGroups } = window.__watchlistAPI ?? {};
  const groups = typeof getGroups === 'function' ? getGroups() : [];

  const chg    = (quote.price ?? 0) - (quote.prev ?? 0);
  const chgPct = quote.prev ? (chg / quote.prev * 100) : 0;
  const cls    = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
  const sign   = chg >= 0 ? '+' : '';

  const card = document.createElement('div');
  card.id        = 'searchInfoCard';
  card.className = 'search-info-card';
  card.innerHTML = `
    <div class="sic-header">
      <div>
        <span class="sic-code">${code}</span>
        <span class="sic-name">${quote.name ?? code}</span>
      </div>
      <button class="sic-close" id="searchCardClose">✕</button>
    </div>
    <div class="sic-price ${cls}">
      ${quote.price?.toFixed(2) ?? '—'}
      <span class="sic-chg">${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)</span>
    </div>
    <div class="sic-actions">
      <span class="sic-label">加入自選：</span>
      <div class="sic-group-list" id="sicGroupList">
        ${groups.length === 0
          ? '<span class="sic-no-groups">無群組</span>'
          : groups.map(g => `<button class="sic-group-btn" data-gid="${g.id}" data-gname="${g.name}">${g.name}</button>`).join('')
        }
      </div>
    </div>
  `;

  const searchBox = document.querySelector('.search-box');
  searchBox?.parentNode?.insertBefore(card, searchBox.nextSibling);

  card.querySelector('#searchCardClose')?.addEventListener('click', () => card.remove());

  card.querySelectorAll('.sic-group-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid   = btn.dataset.gid;
      const gname = btn.dataset.gname;
      await addStockToGroup(
        { code, name: quote.name ?? code, price: quote.price ?? null, chg: null, chgPct: null },
        gid
      );
      showToast(`✓ ${code} 已加入「${gname}」`);
      btn.textContent = '✓';
      btn.disabled    = true;
    });
  });

  const timer = setTimeout(() => card.remove(), 8000);
  card.addEventListener('mouseenter', () => clearTimeout(timer));
}

// ─────────────────────────────────────────────
// Modal 新增股票（＋ 按鈕）→ 選群組加入
// ─────────────────────────────────────────────
function initModalAdd() {
  const addBtn  = document.getElementById('watchlistAddStock');
  const modalBg = document.getElementById('modalBg');
  if (!addBtn || !modalBg) return;
  if (addBtn.dataset.bound === '1') return;
  addBtn.dataset.bound = '1';

  // ── 開關 Modal ────────────────────────────
  function openModal() {
    _rebuildModalGroupSelect();
    _rebuildBatchGroupSelect();
    document.getElementById('modalInput').value           = '';
    document.getElementById('modalBatchInput').value      = '';
    document.getElementById('modalBatchPreview').innerHTML = '';
    document.getElementById('modalSuggestList').innerHTML  = '';
    // 重設為單筆 tab
    modalBg.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    modalBg.querySelector('.modal-tab[data-modal-tab="single"]')?.classList.add('active');
    document.getElementById('modalPanelSingle').style.display = '';
    document.getElementById('modalPanelBatch').style.display  = 'none';
    document.getElementById('modalConfirmBtn').textContent    = '新增';
    modalBg.classList.add('open');
    setTimeout(() => document.getElementById('modalInput').focus(), 50);
  }
  function closeModal() { modalBg.classList.remove('open'); }

  addBtn.addEventListener('click', openModal);
  document.getElementById('modalCancelBtn')?.addEventListener('click', closeModal);
  modalBg.addEventListener('click', (e) => { if (e.target === modalBg) closeModal(); });

  // ── Tab 切換 ──────────────────────────────
  modalBg.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modalBg.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.modalTab;
      document.getElementById('modalPanelSingle').style.display   = which === 'single'   ? '' : 'none';
      document.getElementById('modalPanelBatch').style.display    = which === 'batch'    ? '' : 'none';
      document.getElementById('modalPanelStrategy').style.display = which === 'strategy' ? '' : 'none';
      document.getElementById('modalConfirmBtn').style.display    = which === 'strategy' ? 'none' : '';
      document.getElementById('modalConfirmBtn').textContent      = which === 'batch' ? '批次新增' : '新增';
      if (which === 'strategy') renderStrategyGrid();
    });
  });

  // ── 策略選股（獨立模組）────────────────────────────
  initStrategyModal(closeModal, showToast);


  // ── 單筆：中文名稱即時搜尋建議 ───────────
  const modalInput       = document.getElementById('modalInput');
  const modalSuggestList = document.getElementById('modalSuggestList');
  let _suggestDebounce = null;
  let _selectedCode    = null;

  modalInput.addEventListener('input', () => {
    _selectedCode = null;
    clearTimeout(_suggestDebounce);
    const q = modalInput.value.trim();
    if (!q) { modalSuggestList.innerHTML = ''; return; }
    _suggestDebounce = setTimeout(() => _updateSuggest(q), 180);
  });

  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')     { e.preventDefault(); _confirmSingle(); }
    if (e.key === 'Escape')    closeModal();
    if (e.key === 'ArrowDown') _moveSuggest(1);
    if (e.key === 'ArrowUp')   _moveSuggest(-1);
  });

  function _updateSuggest(q) {
    const results = _searchStocks(q);
    if (!results.length) { modalSuggestList.innerHTML = ''; return; }
    modalSuggestList.innerHTML = results.slice(0, 8).map(r =>
      `<div class="modal-suggest-item" data-code="${r.code}">
        <span class="sug-code">${r.code}</span>
        <span class="sug-name">${r.name}</span>
      </div>`
    ).join('');
    modalSuggestList.querySelectorAll('.modal-suggest-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _selectedCode = item.dataset.code;
        modalInput.value = _selectedCode;
        modalSuggestList.innerHTML = '';
      });
    });
  }

  function _moveSuggest(dir) {
    const items = [...modalSuggestList.querySelectorAll('.modal-suggest-item')];
    if (!items.length) return;
    const cur = modalSuggestList.querySelector('.modal-suggest-item.focused');
    let idx = items.indexOf(cur) + dir;
    idx = Math.max(0, Math.min(items.length - 1, idx));
    items.forEach(i => i.classList.remove('focused'));
    items[idx].classList.add('focused');
    _selectedCode = items[idx].dataset.code;
    modalInput.value = _selectedCode;
  }

  // ── 單筆確認 ──────────────────────────────
  async function _confirmSingle() {
    modalSuggestList.innerHTML = '';
    const raw = modalInput.value.trim();
    if (!raw) return;
    const parsed = _parseOneLine(raw);
    const code = (_selectedCode || parsed?.code || raw).toUpperCase();
    const select  = document.getElementById('modalGroupSelect');
    const groupId = select?.value || getDefaultGroupId();
    closeModal();
    try {
      const symbol = toYahooSymbol(code);
      const quote  = await fetchQuote(symbol);
      const name   = getChineseName(code) || parsed?.name || quote.name || code;
      await addStockToGroup(
        { code, name, price: quote.price ?? null, chg: null, chgPct: null },
        groupId
      );
      loadStock(code);
    } catch {
      showToast('⚠ 找不到此代號：' + code);
    }
  }

  // ── 批次：群組選單聯動 ────────────────────
  document.getElementById('modalBatchGroupSelect')?.addEventListener('change', (e) => {
    document.getElementById('modalNewGroupRow').style.display =
      e.target.value === '__new__' ? '' : 'none';
  });

  document.getElementById('modalBatchInput')?.addEventListener('input', _updateBatchPreview);

  // ── 確認按鈕 ─────────────────────────────
  document.getElementById('modalConfirmBtn')?.addEventListener('click', () => {
    const activeTab = modalBg.querySelector('.modal-tab.active')?.dataset.modalTab;
    if (activeTab === 'batch') _confirmBatch();
    else _confirmSingle();
  });
}

// ── nameCache 搜尋（代號 or 中文名） ─────────────────────────────────────
function _searchStocks(q) {
  const cache = window.__nameCache;  // Map<code, name>，由 fetchTWSEPrices 填入
  if (!cache || cache.size === 0) {
    if (/^\d+$/.test(q)) return [{ code: q, name: q }];
    return [];
  }
  const results = [];
  for (const [code, name] of cache) {
    if (code.startsWith(q) || name.includes(q)) {
      results.push({ code, name });
    }
  }
  results.sort((a, b) => {
    const aExact = a.code === q ? 0 : 1;
    const bExact = b.code === q ? 0 : 1;
    return aExact - bExact || a.code.localeCompare(b.code);
  });
  return results;
}

// ── 解析單行文字 → { code, name } | null ────────────────────────────────
function _parseOneLine(line) {
  line = line.trim();
  if (!line) return null;
  // 格式1：鴻名（3021） 或 鴻名(3021)
  let m = line.match(/^(.+?)[（(](\w+)[）)]$/);
  if (m) return { name: m[1].trim(), code: m[2].trim().toUpperCase() };
  // 格式2：3021 鴻名
  m = line.match(/^(\d{4,6})\s+(.+)$/);
  if (m) return { code: m[1], name: m[2].trim() };
  // 格式3：鴻名 3021
  m = line.match(/^(.+)\s+(\d{4,6})$/);
  if (m) return { code: m[2], name: m[1].trim() };
  // 格式4：純代號
  m = line.match(/^([A-Za-z]{1,5}|\d{4,6})$/);
  if (m) return { code: m[1].toUpperCase(), name: '' };
  return null;
}

// ── 批次預覽 ─────────────────────────────────────────────────────────────
function _updateBatchPreview() {
  const raw     = document.getElementById('modalBatchInput').value;
  const preview = document.getElementById('modalBatchPreview');
  const lines   = raw.split('\n').filter(l => l.trim());
  if (!lines.length) { preview.innerHTML = ''; return; }
  const parsed = lines.map(l => _parseOneLine(l));
  const ok  = parsed.filter(Boolean).length;
  const bad = parsed.filter(p => !p).length;
  preview.innerHTML = `
    <div class="batch-preview-stats">
      解析到 <b>${ok}</b> 檔${bad ? `，<span class="batch-err">${bad} 行無法識別</span>` : ''}
    </div>
    <div class="batch-preview-list">
      ${lines.map((l, i) => {
        const p = parsed[i];
        return p
          ? `<span class="batch-tag ok">${p.code}${p.name ? ' ' + p.name : ''}</span>`
          : `<span class="batch-tag err" title="${l}">⚠ 無法解析</span>`;
      }).join('')}
    </div>`;
}

// ── 批次確認 ─────────────────────────────────────────────────────────────
async function _confirmBatch() {
  const raw    = document.getElementById('modalBatchInput').value;
  const lines  = raw.split('\n').filter(l => l.trim());
  const parsed = lines.map(l => _parseOneLine(l)).filter(Boolean);
  if (!parsed.length) { showToast('⚠ 沒有可解析的個股'); return; }

  const batchSelect = document.getElementById('modalBatchGroupSelect');
  let groupId;
  if (batchSelect?.value === '__new__') {
    const newName = document.getElementById('modalNewGroupName').value.trim()
      || `批次匯入 ${new Date().toLocaleDateString('zh-TW')}`;
    groupId = await createGroup(newName);
  } else {
    groupId = batchSelect?.value || getDefaultGroupId();
  }

  document.getElementById('modalBg').classList.remove('open');

  // ── Step 1：立即全部加入（用盤後快取價，不等 API）─────────────────────
  const priceCache = PriceHub.snapshot();  // 唯讀快取，由 PriceHub 統一管理
  let added = 0;
  for (const { code, name } of parsed) {
    try {
      const displayName = getChineseName(code) || name || code;
      const cached      = priceCache[code];
      await addStockToGroup({
        code,
        name:    displayName,
        price:   cached?.price  ?? null,
        chg:     cached?.chg    ?? null,
        chgPct:  cached?.chgPct ?? null,
      }, groupId);
      added++;
    } catch (err) {
      console.warn('[batch] skip', code, err);
    }
  }
  showToast(`✓ 已加入 ${added} 檔，背景更新報價中…`);

  // ── Step 2：並行 fetchQuote 補即時報價（不擋 UI）─────────────────────
  const toFetch = parsed.filter(({ code }) => !priceCache[code]);
  if (!toFetch.length) return;

  // 每批 4 筆並行，避免 Yahoo 429
  const BATCH = 4;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const chunk = toFetch.slice(i, i + BATCH);
    await Promise.allSettled(chunk.map(async ({ code, name }) => {
      try {
        const q = await fetchQuote(toYahooSymbol(code));
        if (q?.price != null) {
          // ── 統一走 PriceHub，含 open/high/low ──────────────────────────────
          PriceHub.push({ [code]: q }, { persist: false, updateHeader: false, source: 'batch-add' });
        }
      } catch {}
    }));
    // 批次間短暫等待，降低 429 機率
    if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, 300));
  }
}

// ── 重建群組下拉（單筆）──────────────────────────────────────────────────
function _rebuildModalGroupSelect() {
  const { getGroups } = window.__watchlistAPI ?? {};
  const groups = typeof getGroups === 'function' ? getGroups() : [];
  const select = document.getElementById('modalGroupSelect');
  if (!select) return;
  select.innerHTML = groups.map(g =>
    `<option value="${g.id}">${g.name}</option>`
  ).join('');
}

// ── 重建群組下拉（批次）──────────────────────────────────────────────────
function _rebuildBatchGroupSelect() {
  const { getGroups } = window.__watchlistAPI ?? {};
  const groups = typeof getGroups === 'function' ? getGroups() : [];
  const select = document.getElementById('modalBatchGroupSelect');
  if (!select) return;
  select.innerHTML =
    `<option value="__new__">🆕 自動建立新群組</option>` +
    groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
  document.getElementById('modalNewGroupRow').style.display = '';
}

function initPatternSelectOnChart() {
  const toggle     = document.getElementById('patternSelectToggle');
  const bar        = document.getElementById('patternSelectBar');
  const barText    = document.getElementById('patternSelectBarText');
  const confirmBtn = document.getElementById('patternSelectConfirm');
  const cancelBtn  = document.getElementById('patternSelectCancel');
  const overlay    = document.getElementById('patternSelectOverlay');
  const rect       = document.getElementById('patternSelectRect');
  const mainChart  = document.getElementById('mainChart');

  if (!toggle) return;

  let selecting     = false;
  let dragStartX    = 0;
  let selectedRange = null;

  toggle.addEventListener('click', () => {
    const on = toggle.classList.toggle('on');
    bar.style.display     = on ? 'flex' : 'none';
    overlay.style.display = on ? 'block' : 'none';
    if (!on) _clearRect();
  });

  cancelBtn.addEventListener('click', () => {
    toggle.classList.remove('on');
    bar.style.display     = 'none';
    overlay.style.display = 'none';
    _clearRect();
    selectedRange = null;
    confirmBtn.style.display = 'none';
    barText.textContent = '在 K 線圖上按住滑鼠左鍵拖曳，框選一段走勢';
  });

  confirmBtn.addEventListener('click', () => {
    if (!selectedRange) return;
    document.dispatchEvent(new CustomEvent('patternRangeSelect', {
      detail: { ...selectedRange }
    }));
    cancelBtn.click();
    setTimeout(() => {
      document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
      document.querySelector('.main-tab[data-tab="pattern"]')?.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tabPattern')?.classList.add('active');
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.tab-item[data-mobile-tab="pattern"]')?.classList.add('active');
      showToast('✓ 已設定型態範本，可調整設定後點擊「開始掃描」');
    }, 50);
  });

  overlay.addEventListener('mousedown', e => {
    selecting  = true;
    dragStartX = e.offsetX;
    overlay.style.pointerEvents = '';
    _clearRect();
    confirmBtn.style.display = 'none';
    barText.textContent = '放開滑鼠確認選取';
  });

  overlay.addEventListener('mousemove', e => {
    if (!selecting) return;
    const x1 = Math.min(dragStartX, e.offsetX);
    const x2 = Math.max(dragStartX, e.offsetX);
    _showRect(x1, mainChart.offsetTop, x2 - x1, mainChart.clientHeight);
  });

  overlay.addEventListener('mouseup', e => {
    if (!selecting) return;
    selecting = false;
    const x1 = Math.min(dragStartX, e.offsetX);
    const x2 = Math.max(dragStartX, e.offsetX);
    if (x2 - x1 < 10) { _clearRect(); barText.textContent = '在 K 線圖上按住滑鼠左鍵拖曳，框選一段走勢'; return; }

    const chartW   = overlay.clientWidth;
    const n        = AppState.lastCandles.length;
    if (n === 0) { barText.textContent = '請先載入股票K線'; return; }

    const startIdx = Math.max(0,     Math.floor((x1 / chartW) * n));
    const endIdx   = Math.min(n - 1, Math.floor((x2 / chartW) * n));
    const len      = endIdx - startIdx + 1;

    if (len < 5) { barText.textContent = '請選取至少 5 根 K 棒'; _clearRect(); return; }

    selectedRange = { startIdx, endIdx };
    barText.textContent = `已選取 ${len} 根 K 棒`;
    confirmBtn.style.display = '';
    overlay.style.pointerEvents = 'none';
  });

  // 觸控
  overlay.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0], r = overlay.getBoundingClientRect();
    selecting = true; dragStartX = t.clientX - r.left;
    _clearRect(); confirmBtn.style.display = 'none';
  }, { passive: false });

  overlay.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!selecting) return;
    const t = e.touches[0], r = overlay.getBoundingClientRect();
    const curX = t.clientX - r.left;
    _showRect(Math.min(dragStartX, curX), mainChart.offsetTop, Math.abs(curX - dragStartX), mainChart.clientHeight);
  }, { passive: false });

  overlay.addEventListener('touchend', e => {
    if (!selecting) return;
    selecting = false;
    const t = e.changedTouches[0], r = overlay.getBoundingClientRect();
    const endX = t.clientX - r.left;
    const x1 = Math.min(dragStartX, endX), x2 = Math.max(dragStartX, endX);
    if (x2 - x1 < 10) { _clearRect(); return; }

    const chartW = overlay.clientWidth, n = AppState.lastCandles.length;
    if (n === 0) return;
    const startIdx = Math.max(0, Math.floor((x1 / chartW) * n));
    const endIdx   = Math.min(n - 1, Math.floor((x2 / chartW) * n));
    if (endIdx - startIdx + 1 < 5) { _clearRect(); return; }
    selectedRange = { startIdx, endIdx };
    barText.textContent = `已選取 ${endIdx - startIdx + 1} 根 K 棒`;
    confirmBtn.style.display = '';
  });

  function _showRect(x, y, w, h) {
    rect.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  }
  function _clearRect() { rect.style.display = 'none'; }
}

// ─────────────────────────────────────────────
// Phase 3：型態高亮跳轉
// ─────────────────────────────────────────────
function _listenPatternHighlight() {
  document.addEventListener('patternHighlight', e => {
    const { code } = e.detail;
    if (AppState.activeCode !== code) loadStock(code);
    showToast(`已跳轉至 ${code}，比對區間在最近 K 棒`);
  });
}

// ─────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Phase 7：K 線編輯模式 + 智能分析卡片
// ─────────────────────────────────────────────
function initPhase7() {
  const chartContainer = getMainChartEl();
  if (!chartContainer) {
    console.warn('[phase7] #mainChart not found, abort');
    return;
  }

  // 編輯模式
  initChartEdit({
    chartContainer,
    getChart:       () => getMainChart(),
    getSeries:      () => getCandleSeries(),
    getCode:        () => AppState.activeCode,
    getCandles:     () => AppState.lastCandles,
    getMacdChart:   () => getMacdChart(),
    getMacdChartEl: () => getMacdChartEl(),
    getKdChart:     () => getKdChart(),
    getKdChartEl:   () => getKdChartEl(),
    getRsiChart:    () => getRsiChart(),
    getRsiChartEl:  () => getRsiChartEl(),
    onReloadChart: () => {
      initCharts();
      if (AppState.lastCandles?.length) {
        renderChartData(AppState.lastCandles);
      }
    },
  });

  // ── Phase 7.2/7.3：AI 解說疊圖引擎初始化 ──
  initSignalOverlay({
    getMainChart:    () => getMainChart(),
    getCandleSeries: () => getCandleSeries(),
    getMainChartEl:  () => getMainChartEl(),
    getMacdChart:    () => getMacdChart(),
    getMacdChartEl:  () => getMacdChartEl(),
    getKdChart:      () => getKdChart(),
    getKdChartEl:    () => getKdChartEl(),
    getRsiChart:     () => getRsiChart(),
    getRsiChartEl:   () => getRsiChartEl(),
    getCandles:      () => AppState.lastCandles,
  });

  // ── Phase 7.3：說明區初始化 ──
  initAnalysisPanel({
    getMainChart:    () => getMainChart(),
    getCandleSeries: () => getCandleSeries(),
    getMainChartEl:  () => getMainChartEl(),
  });

  // 「進入編輯」按鈕(index.html 已加 #btnChartEdit)
  const btn = document.getElementById('btnChartEdit');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      if (!AppState.activeCode) {
        showToast('請先選擇一檔股票');
        return;
      }
      if (isEditing()) { exitEditMode();  btn.classList.remove('active'); }
      else             { enterEditMode(); btn.classList.add('active');    }
    });
  }

  // 智能分析卡片
  initAnalysisCard({
    containerSelector: '#chartAnalysisPanel',
    getCandles: () => AppState.lastCandles,
    getCode:    () => AppState.activeCode,
  });

  // 每次 chartRendered 後若仍在編輯模式,重新 attach overlay
  // (處理 reloadChart 後 chart instance 改變的情況)
  window.addEventListener('chartRendered', (e) => {
    if (isEditing()) reattachAfterReload();
    // T-3/T-5 header 徽章（先用現有快取畫一次）
    try { renderWeeklyStageBadges(); } catch(e2) {}
    // 預取 2 年日K hist（週線/階段資料源，不綁圖表週期）→ 就緒後重繪徽章 + 全視窗 Tab
    const _code = e?.detail?.code || AppState.activeCode;
    if (_code) {
      ensureTADaily(_code).then(() => {
        try { renderWeeklyStageBadges(); } catch(e2) {}
        try { refreshFullscreenAnalysis(); } catch(e2) {}
        try { refreshAnalysis(); } catch(e2) {}   // 智能分析重算，帶入週線/階段
      });
    }
    // Phase 7.3 — 全視窗模式下切週期/股票/指標後重新渲染深度解讀
    // 保住捲動位置，避免頁面跳走
    const panel = document.getElementById('chartPanel');
    const scrollTop = panel?.scrollTop || 0;
    try { refreshFullscreenAnalysis(); } catch(e) {}
    if (panel && scrollTop > 0) panel.scrollTop = scrollTop;
  });

  // 切到「智能分析」子 Tab 時,確保跑過一次分析
  document.querySelectorAll('.stock-tab[data-stock-tab="analysis"]').forEach(t => {
    t.addEventListener('click', () => {
      if (AppState.activeCode && AppState.lastCandles?.length) {
        refreshAnalysis();
      }
    });
  });

  // ── Phase 7.4:多週期共振 ──
  initMultiPeriod({
    containerSelector: '#multiPeriodPanel',
    getCode: () => AppState.activeCode,
  });
  document.querySelectorAll('.stock-tab[data-stock-tab="resonance"]').forEach(t => {
    t.addEventListener('click', () => {
      if (AppState.activeCode) {
        renderMultiPeriod(AppState.activeCode);
      }
    });
  });

  // ── Phase 7.1：燈燈喚醒系統 + 第一次打招呼 ──
  initDengWakeup();

  if (!sessionStorage.getItem('dengGreeted')) {
    sessionStorage.setItem('dengGreeted', '1');
    setTimeout(() => {
      dengToast(pickDengMessage('greeting'), { mood: 'happy', duration: 4500 });
    }, 1500);
  }

  // 讓燈燈喚醒系統的「幫我刷新」可以呼叫 loadStock
  window.reloadCurrentStock = () => {
    if (AppState.activeCode) loadStock(AppState.activeCode);
  };

  // ── Phase 7.3:全視窗模式 ──
  _initFullscreen();

  // ── Phase 8:蒙地卡羅模擬器 ──
  _initMonteCarlo();

  // ── Phase 7.4:強制刷新 K 線按鈕 ──
  _initRefreshKline();
  // ── 自選清單 toolbar：更新按鈕 + 下拉選單 ──
  _initWatchlistToolbar();
}

// ── 自選清單 toolbar 初始化 ─────────────────────────────────────────────────
function _initWatchlistToolbar() {
  // 讓 watchlist.js 設定 Modal 的搜尋框可以用 main.js 的 _searchStocks
  window.__searchStocks = _searchStocks;

  // ⚙ 設定按鈕 → 開啟 watchlist 設定 Modal
  const settingsBtn = document.getElementById('wlSettingsBtn');
  if (settingsBtn && !settingsBtn.dataset.bound) {
    settingsBtn.dataset.bound = '1';
    settingsBtn.addEventListener('click', () => {
      window.__openWatchlistSettings?.();
    });
  }

  // 更新按鈕：報價 + 燈號 合一
  _initRescanAll();
}

// Phase 7.4 — 強制刷新 K 線(跳過 IndexedDB 快取)
function _initRefreshKline() {
  const btn = document.getElementById('btnRefreshKline');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!AppState.activeCode) {
      showToast('請先選擇一檔股票');
      return;
    }
    // 簡單視覺反饋:按鈕轉一圈
    btn.classList.add('refreshing');
    try {
      // force: true → 跳過 K 線快取,重新打 Yahoo
      // 同時刪除 IndexedDB 快取，確保真的重抓而非讀舊資料
      const _code = AppState.activeCode;
      const _sym  = toYahooSymbol(_code);
      for (const p of ['5d','1mo','3mo','6mo','1y','2y']) {
        await deleteKlineCache(_sym, p).catch(() => {});
      }
      await loadStock(_code, { force: true });
      showToast('已重新抓取 K 線 ~');
    } catch (e) {
      showToast('⚠ 刷新失敗:' + e.message);
    } finally {
      btn.classList.remove('refreshing');
    }
  });
}

// 「⟳ 更新」按鈕：① 先 MIS 更新全自選報價 → ② 再掃燈號
function _initRescanAll() {
  const btn = document.getElementById('watchlistRescanAll');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('refreshing')) return;

    const groups = AppState.watchlistGroups ?? [];
    const allCodes = [...new Set(
      groups.flatMap(g => g.stocks ?? []).map(s => s.code)
    )];
    const misCodes = allCodes.filter(c => /^\d{4,6}$/.test(c));

    if (!allCodes.length) { showToast('自選清單是空的'); return; }

    btn.classList.add('refreshing');
    btn.textContent = '⟳ 報價中…';

    try {
      // ── 步驟 1：MIS 更新報價（不打 Yahoo/TWSE，快且省）──────────────────
      if (misCodes.length > 0) {
        const { fetchMisIntraday } = await import('./api.js');
        const BATCH = 50;
        const allMap = {};
        for (let i = 0; i < misCodes.length; i += BATCH) {
          const map = await fetchMisIntraday(misCodes.slice(i, i + BATCH)).catch(() => ({}));
          Object.assign(allMap, map);
          if (i + BATCH < misCodes.length) await new Promise(r => setTimeout(r, 200));
        }
        if (Object.keys(allMap).length > 0) {
          PriceHub.push(allMap, { persist: true, updateHeader: true, source: 'manual-refresh' });  // persist:true → 存 IndexedDB，下次開啟即顯示最新報價
        }
      }

      // ── 步驟 2：掃燈號（K線 + 指標，走 Yahoo + Worker）──────────────────
      btn.textContent = '⟳ 燈號中…';
      const stat = await scanWatchlistSignals({
        force: true,
        onProgress: (done, t) => {
          btn.textContent = `⟳ ${done}/${t}`;
        },
      });

      // 結果 toast
      const gotPrice = Object.keys(window.__priceCache ?? {}).length;
      if (stat.aborted) {
        showToast(`報價 ${misCodes.length} 檔 ✓ ｜燈號中止（快取 ${stat.fromCache} 成功 ${stat.success - stat.fromCache}）`);
      } else if (stat.failed === 0) {
        showToast(`報價 ${misCodes.length} 檔 ✓ ｜燈號 ${stat.success} 檔 ✓`);
      } else {
        showToast(`報價 ${misCodes.length} 檔 ✓ ｜燈號 ${stat.success} 成功 / ${stat.failed} 失敗`);
      }
    } catch (e) {
      showToast('⚠ 更新失敗：' + e.message);
    } finally {
      btn.classList.remove('refreshing');
      btn.textContent = '⟳ 更新';
    }
  });
}

function _initMonteCarlo() {
  // 初始化模擬器，傳入所有需要的 refs
  initMonteCarlo({
    getMainChart:    () => getMainChart(),
    getCandleSeries: () => getCandleSeries(),
    getMainChartEl:  () => getMainChartEl(),
    getCandles:      () => AppState.lastCandles || [],
    getAnalysis:     () => getLastAnalysisResult(),
    getCode:         () => AppState.activeCode || null,
    getName:         () => window.__nameCache?.get?.(AppState.activeCode) ?? '',
  });

  // 綁定工具列「模擬」按鈕
  const btn = document.getElementById('btnMonteCarlo');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    if (!AppState.activeCode) {
      showToast('請先選擇一檔股票');
      return;
    }
    openMonteCarloMenu();
  });

  // 切換週期/重整後，若模擬中則重算
  window.addEventListener('chartRendered', () => {
    // monte-carlo.js 內部已監聽 chartRendered，此處不需要額外處理
  });
}

function _initFullscreen() {
  const btn = document.getElementById('btnFullscreen');
  if (!btn) return;

  // ESC 提示(v2.6.1:緊貼 ✕ 按鈕右側,避免與 toolbar 上的「📖 說明書」重疊)
  let hint = document.querySelector('.fullscreen-esc-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'fullscreen-esc-hint';
    hint.textContent = 'ESC 退出全視窗';
    // 插到 btnFullscreen 之後;若 btn 沒有 parent(極少數情況)fallback 到 body
    if (btn.parentNode) {
      btn.parentNode.insertBefore(hint, btn.nextSibling);
    } else {
      document.body.appendChild(hint);
    }
  }

  let _isFS = false;

  function enterFS() {
    _isFS = true;
    document.getElementById('chartPanel')?.classList.add('fullscreen-mode');
    document.body.classList.add('fullscreen-chart');
    btn.classList.add('active');
    btn.title = '退出全視窗 (ESC)';
    btn.textContent = '✕';
    setTimeout(() => {
      // 量測 sticky toolbar 實際高度，寫入 CSS 變數供 chart-area height calc 使用
      const tb1 = document.querySelector('#chartPanel .chart-toolbar');
      const tbH = tb1 ? (tb1.offsetHeight || 0) : 0;
      if (tbH > 0) document.documentElement.style.setProperty('--fs-tb-h', tbH + 'px');
      // 進入全視窗時強制滾回頂部，確保 K 線在首屏
      document.getElementById('chartPanel')?.scrollTo({ top: 0 });
      // 顯示 Fixed 按鈕
      const fixedBtn = document.getElementById('btnFixedChart');
      if (fixedBtn) fixedBtn.style.display = '';
      window._chartResize?.();
      window.dispatchEvent(new CustomEvent('chartRendered', {
        detail: { code: AppState.activeCode, candleCount: AppState.lastCandles?.length || 0 }
      }));
      try { initFullscreenAnalysis(); } catch(e) { console.warn('[fs-analysis] init failed:', e); }
      // 全視窗下副圖不可見，停止 crosshair/scroll 計算，降低 CPU
      try { setSubChartsActive(false); } catch(e) {}
    }, 80);
  }

  function exitFS() {
    _isFS = false;
    clearSignalLayer();
    try { destroyFullscreenAnalysis(); } catch(e) {}
    document.documentElement.style.removeProperty('--fs-tb-h');
    document.getElementById('chartPanel')?.classList.remove('fullscreen-mode');
    document.getElementById('chartPanel')?.classList.remove('fixed-chart');
    document.body.classList.remove('fullscreen-chart');
    btn.classList.remove('active');
    btn.title = '全視窗模式 (ESC 退出)';
    btn.textContent = '⛶';
    // 隱藏 Fixed 按鈕，重置狀態
    const fixedBtn = document.getElementById('btnFixedChart');
    if (fixedBtn) { fixedBtn.style.display = 'none'; fixedBtn.classList.remove('active'); }
    // 還原 chart 的滾輪縮放
    try { setChartFixed(false); } catch(e) {}
    // 還原副圖 crosshair/scroll
    try { setSubChartsActive(true); } catch(e) {}
    setTimeout(() => { window._chartResize?.(); }, 80);
  }

  btn.addEventListener('click', () => { _isFS ? exitFS() : enterFS(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _isFS) exitFS();
  });

  // ── Fixed 凍結按鈕：全視窗時顯示，點擊後 K 線 sticky 固定在頂 ──
  const fixedBtn = document.getElementById('btnFixedChart');
  if (fixedBtn) {
    fixedBtn.addEventListener('click', () => {
      const panel = document.getElementById('chartPanel');
      const isFixed = panel?.classList.toggle('fixed-chart');
      fixedBtn.classList.toggle('active', isFixed);
      fixedBtn.title = isFixed ? '取消凍結（還原 K 線縮放）' : '凍結 K 線（滾輪捲動頁面，不縮放 K 線）';
      fixedBtn.textContent = isFixed ? '📌 已凍結' : '📌 Fixed';
      // 關閉/開啟所有子圖的滾輪縮放與拖拽
      try { setChartFixed(isFixed); } catch(e) {}
    });
  }

  // ── AI 工具列已移除（由全視窗 Golden Board Tab 取代） ──
}

(async function init() {
  // 1. 先啟動 IndexedDB 並遷移舊資料
  await initDB();
  // ⚠️ 踩雷備忘：migrate 在「乾淨新機」可能丟錯（預期的舊 localStorage 不存在），
  //   若不 catch → init() 整個 reject → 後面的 bundle 預載 kick 從未註冊 → 新機不下載 K 線包。
  //   包 try/catch，遷移失敗只記 log，不連累後續初始化。
  try {
    await migrateFromLocalStorage();
  } catch (e) {
    console.warn('[main] migrateFromLocalStorage 失敗(忽略,不影響後續):', e?.message);
  }
  // Phase 7.4 — 背景清理過期 K 線快取(不 await,不擋初始化)
  cleanupExpiredKlineCache();

  // Bundle 預載：背景抓 GAS 預打包的全市場 K 線（7 包 gzip）→ 灌 IDB kline_cache
  //   每日只灌一次（localStorage 旗標防重跑）。完成後篩選器/型態/種子掃描全本機命中。
  //   用 requestIdleCallback 延後到瀏覽器空檔，完全不影響首屏與既有初始化。
  window.__bundleReady = new Promise(resolve => {
    const kick = () => preloadBundles().then(resolve).catch(e => {
      console.warn('[main] preloadBundles 失敗:', e?.message);
      resolve(null);
    });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 4000 });
    else setTimeout(kick, 1500);
  });

  // 1.5 Firebase 名稱庫預載（最高優先，背景執行不擋後續）
  // ⚠️ 踩雷備忘：之前有 export preloadNamesFromFirestore 但沒有呼叫
  //   → _nameCache 啟動時空的 → ensureChineseName 去打外部 API
  //   → 小公司(7704等)查不到，shName 顯示 code 而非中文名
  //   修法：最早期預載 Firebase names/batch*，loadStock 時 _nameCache 已有資料
  // ⚠️ 存到 window.__namesReady，讓 loadStock 的補刷邏輯可以等它完成
  window.__namesReady = preloadNamesFromFirestore().catch(() => {});

  // 1.6 Snapshot 預載（GAS 每日盤後預算的全市場 condition snapshot）
  //   背景靜默載入，載入完成後篩選器自動走快速路徑（不需本機算 K 線）
  //   週末/假日也能正常使用（顯示最近交易日的資料）
  // 預載全市場健康度快照（GAS 每日算好，getHealthScore 優先讀此）
  fetchHealthSnapshot().catch(() => {});
  // 預載條件歷史序列（screener snapshot 路徑算 triggerHistory 用）
  fetchCondHistory().catch(() => {});

  fetchSnapshot().then(snap => {
    const el = document.getElementById('screenerSnapshotStatus');
    if (!el) return;
    if (!snap) {
      // 有可能是品質驗算失敗（api.js 回 null + 設 window.__snapshotQualityFail）
      const qFail = window.__snapshotQualityFail;
      if (qFail) {
        el.textContent = `⚠️ 策略快取驗算異常（偏差率 ${qFail.rate}%）・已切換本機模式`;
        el.style.color   = '#ef5350';
        el.style.display = '';
        console.warn('[main] snapshot 品質異常，screener 將走本機 K 線計算');
      }
      return;
    }
    el.textContent = `⚡ 策略快取已就緒・${snap.date}・共 ${Object.keys(snap.stocks || {}).length} 支`;
    el.style.color   = '';
    el.style.display = '';
    console.log(`[main] snapshot 就緒：${snap.date}`);
    window.dispatchEvent(new CustomEvent('snapshotReady'));
  }).catch(() => {});

  // 2. 載入設定（async）
  await loadConfig();

  // 3. UI 基礎
  initUIEvents();
  initSettingsDrawer();
  initStockTabs();
  initMainTabs();
  initStockPreview();   // 個股速覽 modal（篩選結果點擊入口）

  // 觀點 Tab 所需的 window 橋接
  window.__STRATEGIES        = STRATEGIES;
  window.calcSignalLamps     = calcSignalLamps;
  window.__AppState          = AppState;
  window.__ensureFundamentals = ensureFundamentals;  // 觀點卡背景預拉基本面用
  initMobileTabs();

  // ── 手機版：統一入口（js/mobile/index.js）──────────────────────────────
  if (window.matchMedia('(max-width: 767px)').matches) {
    const { initMobile } = await import('./mobile/index.js');
    await initMobile({
      AppState,
      showToast,
      getChineseName,
      fetchTWSEPrices,
      openSettings,
    });
  }

  // Phase 10 已移至 js/mobile/index.js

  // 4. 新版自選清單（群組版）
  await initWatchlist();

  // 手機版 watchlist 接管（inline，不依賴外部檔）
  if (window.matchMedia('(max-width: 767px)').matches) {
    try {
      const { initMobileWatchlist } = await import('./mobile/mobile-watchlist.js');
      await initMobileWatchlist();
    } catch(e) { console.warn('[main] mobile watchlist init failed', e); }
  }

  const { getGroups: _wlGetGroups } = await import('./watchlist.js');
  window.__watchlistAPI = { getGroups: _wlGetGroups };

  // 4.5 PriceHub 初始化（注入 UI 函式，統一報價分配）
  {
    const { updateStockPricesFromMis } = await import('./watchlist.js');
    PriceHub.initPriceHub({
      updateHeader,
      updateStockPrices,
      updateStockPricesFromMis,
      getChineseName,   // 注入中文名查詢，讓 price-hub 可以補中文名
    });

    // ── 啟動時預填上次價格（stockInfo.lastPrice → PriceHub）──────────────
    // 讓題材/篩選等 Tab 一開就有舊價格，不需等 fetchTWSEPrices API 回來
    // TWSE 批次完成後會用最新值覆蓋（chg/chgPct 也會修正）
    loadAllLastPrices().then(map => {
      if (Object.keys(map).length > 0) {
        PriceHub.push(map, { persist: false, updateHeader: false, source: 'lastprice-restore' });
        console.log(`[main] lastPrice 預填 ${Object.keys(map).length} 檔`);
      }
    }).catch(() => {});
  }

  // 5. Sidebar 拖曳 / 手機滑桿
  await initLayout();

  // 6. 搜尋 & Modal 新增
  initSearchAdd();
  initModalAdd();

  // 6.5 大盤總覽（市場資料）

  // 7. 選股篩選 Hub（個股篩選 / 型態比對 / 種子選股 統一入口）
  initScreenerHub();
  initStrategyPanel();
  initTheme();  // 預載題材資料（IndexedDB + Firestore），不阻塞 UI
  initPortfolio();

  // ── Splash 跑馬燈：背景拉今日市場摘要（fire-and-forget，不擋 init）──────
  (async () => {
    try {
      const { db } = await import('./firebase.js');
      const sdk = window.__firestoreSDK;
      if (!db || !sdk?.getDoc || !sdk?.doc) return;
      const d = new Date(Date.now() + 8 * 3600000);
      const dateStr = d.toISOString().slice(0, 10);
      const toRef = (key) => sdk.doc(db, 'shared', key.replace(/\//g, '--'));
      const [cmSnap, luSnap] = await Promise.all([
        sdk.getDoc(toRef(`market/${dateStr}/commentary`)),
        sdk.getDoc(toRef(`market/${dateStr}/limit_up`)),
      ]);
      if (!cmSnap.exists() || !luSnap.exists()) return;
      const cm = cmSnap.data();
      const lu = luSnap.data();
      const stats = typeof cm.stats === 'string' ? JSON.parse(cm.stats) : (cm.stats ?? {});
      const luParsed = typeof lu.data === 'string' ? JSON.parse(lu.data) : (lu.data ?? {});
      window.__splashFeed?.('market', { stats, sectorRank: luParsed.sectorRank ?? [] });
    } catch (_) { /* splash 資料失敗不影響主流程 */ }
  })();

  // 策略庫事件橋接（strategy.js → screener-ui.js）
  // strategyClear：清空現有條件
  document.addEventListener('strategyClear', () => {
    document.getElementById('screenerClearConds')?.click();
  });
  // strategyApplyCond：逐條填入條件（screener-ui 需 export addConditionFromStrategy）
  document.addEventListener('strategyApplyCond', (e) => {
    document.dispatchEvent(new CustomEvent('screenerAddCondition', { detail: e.detail }));
  });
  // showToast 橋接
  document.addEventListener('showToast', (e) => showToast(e.detail));

  // 8. 篩選結果儲存：UI 邏輯已整合進 screener-ui.js，initScreener() 內部自動處理

  // 9. 型態比對 / 種子選股 → 由 screener-hub.js lazy init（切到 hub tab 才觸發）
  initPatternDraw();
  initPatternSelectOnChart();
  _listenPatternHighlight();
  document.addEventListener('stockSelect', e => {
    const { code, matchedConds, fromScreener } = e.detail ?? {};
    // 篩選器來的：存篩選條件到 AppState，讓 stock-tabs 渲染篩選標籤
    if (fromScreener && matchedConds?.length) {
      AppState.screenerContext = { code, matchedConds, matchedCondIds: e.detail?.matchedCondIds ?? [], strategyId: e.detail?.strategyId ?? null, strategyName: e.detail?.strategyName ?? null };
    } else if (AppState.screenerContext?.code !== code) {
      // 切換到非篩選器來源的股票時，清除篩選 context
      AppState.screenerContext = null;
    }
    loadStock(code);
  });
  document.addEventListener('loadStockByCode', e => loadStock(e.detail.code));
  document.addEventListener('chartReload', () => reloadChart());

  // ── Step 4 新增：Auth UI 初始化 ──────────────────────────────────────
  // 初始狀態先載入 feature gates，再套訪客限制
  loadFeatureGates().then(() => applyTierGate('guest'));
  initAuthUI();

  // 登入/登出後重新渲染自選清單（確保資料同步後 UI 更新）
  window.addEventListener('authReady', async (e) => {
    // Token 同步（登入時從雲端拉回 FinMind Token）
    if (e.detail?.user) await syncTokenFromCloud();

    // tier gate 更新（登入後重新套用權限，登出後退回訪客）
    const tier = e.detail?.tier ?? (e.detail?.user ? 'free' : 'guest');
    applyTierGate(tier);
    refreshStrategyCards();  // tier 確認後補刷策略卡片（避免 Pro 策略因時序問題不顯示）

    if (e.detail?.user) {
      // ── 雲端 ↔ 本地同步（登入時才跑）──
      // 順序：先拉雲端（merge），再上傳本地
      // ⚠️ 必須在 reloadWatchlist / portfolioAPI.reload 之前完成
      await syncCloudToLocal().catch(err => console.warn('[main] syncCloudToLocal failed:', err));
      syncLocalToCloud().catch(err => console.warn('[main] syncLocalToCloud failed:', err));
    }

    // 自選清單重繪（雲端同步完成後）
    // 用 reloadWatchlist 而非 initWatchlist，避免工具列按鈕被重複綁定
    await reloadWatchlist();
    const groups = AppState.watchlistGroups ?? [];
    const first  = groups[0]?.stocks?.[0];
    if (first && !AppState.activeCode) loadStock(first.code);

    // portfolio 重載（sync 完成後更新 UI）
    if (e.detail?.user) {
      window.__portfolioAPI?.reload?.().catch(() => {});
    }
  });
  // ─────────────────────────────────────────────────────────────────────

  startClock();

  // Phase 7.4 — Lazy 模式:啟動時不批次掃描,改成「開哪檔掃哪檔」(loadStock 自帶)
  // 1. 先從 IndexedDB 還原上次的訊號結果(自選清單一打開就有燈號)
  // 2. fetchTWSEPrices 拉盤後價格(只這一個 batch API,Worker 負擔可控)
  // 3. 不再啟動定時掃描 + 不再批次掃自選 → Worker 流量大幅下降

  // 11. 還原上次的訊號結果(背景,不擋初始化)
  restoreSignalsFromCache();

  // ── Splash 跑馬燈：收集 yaoguUpdated 事件，3s debounce 後批次推送 ──────
  {
    let _splashYaoguTimer = null;
    document.addEventListener('yaoguUpdated', () => {
      clearTimeout(_splashYaoguTimer);
      _splashYaoguTimer = setTimeout(() => {
        if (!window.__splashFeed) return;
        const detected = Object.entries(AppState.yaoguStatus ?? {})
          .filter(([, ys]) => ys?.color)
          .map(([code, ys]) => {
            const sigs = (AppState.signals?.[code] ?? [])
              .filter(s => s.category === 'X 系列')
              .map(s => { const m = (s.name ?? '').match(/X\d/); return m ? m[0] : 'X'; });
            return { code, name: getChineseName(code) || code, signals: [...new Set(sigs)] };
          })
          .filter(d => d.signals.length);
        if (detected.length) window.__splashFeed('yaogu', detected);
      }, 3000);
    });
  }

  // 11b. 初次掃描延遲 90 秒：等 loadStock K線穩定完成再掃
  // ⚠️ 踩雷備忘：延遲太短（5秒）會與 loadStock K線並發衝爆 Worker，造成 K線 25 分鐘空白
  setTimeout(async () => {
    console.log('[main] 初次自動掃描燈號');
    scanWatchlistSignals({ silent: true });

    // ── 每日自動重建 yaogu 記錄：對所有自選清單個股跑 scanOneCode ──────
    // 確保 activatedAt/warningAt 每天從 K 線重算，不沿用可能錯誤的舊值
    const today = new Date().toISOString().slice(0, 10);
    const yaoguRebuildKey = 'yaogu_rebuild_date';
    if (localStorage.getItem(yaoguRebuildKey) !== today) {
      try {
        const groups = AppState.watchlistGroups ?? [];
        const codes = [...new Set(groups.flatMap(g => g.stocks?.map(s => s.code) ?? []))];
        console.log(`[main] yaogu 每日重建：${codes.length} 支`);
        for (const code of codes) {
          await scanOneCode(code, { force: false }).catch(() => {});
        }
        localStorage.setItem(yaoguRebuildKey, today);
        console.log('[main] yaogu 每日重建完成');
      } catch(e) {
        console.warn('[main] yaogu rebuild failed:', e.message);
      }
    }
  }, 90 * 1000);

  setInterval(() => {
    console.log('[main] 定時自動掃描燈號（每小時）');
    scanWatchlistSignals({ silent: true });
  }, 60 * 60 * 1000);

  // 12. 背景批次更新價格(TWSE 盤後)
  // ⚠️ Promise 存到 window.__twsePricesReady，供 loadStock 等待中文名填入
  window.__twsePricesReady = fetchTWSEPrices().then(map => {
    // 同時建立 nameCache 供搜尋建議使用
    const nameCache = new Map();
    for (const [code, d] of Object.entries(map)) {
      if (d.name) nameCache.set(code, d.name);
    }

    // TWSE/TPEx 失敗時 map 是空的 → 用 api.js 的 _nameCache 補中文名
    if (nameCache.size === 0) {
      const allCodes = (AppState.watchlistGroups ?? [])
        .flatMap(g => g.stocks ?? [])
        .map(s => s.code);
      for (const code of allCodes) {
        const name = getChineseName(code);
        if (name) nameCache.set(code, name);
      }
      console.log(`[main] TWSE 批次失敗,以 getChineseName 補 nameCache ${nameCache.size} 筆`);
    }
    // merge 而非覆蓋：保留 preloadNamesFromFirestore 已同步的 7000+ 筆
    if (!window.__nameCache) {
      window.__nameCache = nameCache;
    } else {
      // 把 TWSE 批次的最新價格名稱補進去，不蓋掉已有的
      nameCache.forEach((name, code) => {
        window.__nameCache.set(code, name);
      });
    }

    // ── 統一走 PriceHub（persist:true = 盤後批次，寫 IndexedDB）────────────
    if (Object.keys(map).length > 0) {
      PriceHub.push(map, { persist: true, updateHeader: true, source: 'twse-batch' });
    }

    // 補刷個股標頭中文名（解決「名稱顯示英文」bug）
    const activeCode = AppState.activeCode;
    if (activeCode) {
      const chineseName = getChineseName(activeCode) || nameCache.get(activeCode);
      const el = document.getElementById('shName');
      if (el && chineseName) el.textContent = chineseName;
    }

    // ── 盤中補刷：TWSE 盤中跳過批次 → 自選清單上市股 price 為空 → MIS 補一次 ──
    try {
      const _tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const _day  = _tw.getUTCDay();
      const _mins = _tw.getUTCHours() * 60 + _tw.getUTCMinutes();
      const _isNowTrading = (_day >= 1 && _day <= 5) && _mins >= 9 * 60 && _mins <= 13 * 60 + 35;
      if (_isNowTrading) {
        const cache = PriceHub.snapshot();
        const missCodes = (AppState.watchlistGroups ?? [])
          .flatMap(g => g.stocks ?? [])
          .map(s => s.code)
          .filter(c => /^\d{4,6}$/.test(c) && !cache[c]);
        if (missCodes.length > 0) {
          console.log(`[main] 盤中補刷：${missCodes.length} 檔自選上市股用 MIS 補價格`);
          import('./api.js').then(async ({ fetchMisIntraday }) => {
            const misMap = await fetchMisIntraday(missCodes).catch(() => ({}));
            if (Object.keys(misMap).length > 0) {
              PriceHub.push(misMap, { persist: false, updateHeader: true, source: 'mis-patch' });
              console.log(`[main] 盤中補刷完成 ${Object.keys(misMap).length} 檔`);
            }
          });
        }

        // ── Firestore realtime 訂閱（盤中啟動，GAS 每分鐘寫入全市場快照）──
        import('./firebase.js').then(({ db }) => {
          if (!db) return;
          const sdk = window.__firestoreSDK;
          if (sdk?.onSnapshot && sdk?.doc) {
            PriceHub.startFirestoreRealtime(sdk.onSnapshot, (path) => sdk.doc(db, path));
          }
        }).catch(() => {});
      }
    } catch (_) {}

    // ⚠ Phase 7.4 — 不再啟動定時掃描、不再批次掃自選
  }).catch(e => {
    console.warn('[main] fetchTWSEPrices 失敗:', e.message);
  });

  // 12. 載入第一檔
  const groups = AppState.watchlistGroups ?? [];
  const first  = groups[0]?.stocks?.[0];
  if (first) loadStock(first.code);

initMarketMini();
initMarketPulse();

// ── 盤中即時報價（mis.twse.com.tw）+ K線定時更新 ───────────────────────────
// Worker 已加 mis session 管理，可直接打即時 API
// 分兩條線：
//   1. mis 每 15 秒拉「當前個股」即時報價 → 更新標頭 + 自選清單（無延遲）
//   2. Yahoo K線 每 5 分鐘 force reload → 更新 K線圖（Yahoo 有 15-20 分鐘延遲，但K線形狀夠用）
{
  let _quoteTimer  = null;
  let _klineTimer  = null;
  let _pollingCode = null;

  function _isTradingNow() {
    const tw   = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const day  = tw.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = tw.getUTCHours() * 60 + tw.getUTCMinutes();
    return mins >= 9 * 60 && mins <= 13 * 60 + 35;
  }

  function _stopPolling() {
    if (_quoteTimer) { clearInterval(_quoteTimer); _quoteTimer = null; }
    if (_klineTimer) { clearInterval(_klineTimer); _klineTimer = null; }
    _pollingCode = null;
  }

  // mis 即時報價（15 秒一次，只打 1 個 request）
  async function _pollMisQuote(code) {
    if (!_isTradingNow() || AppState.activeCode !== code) { _stopPolling(); return; }
    try {
      const { fetchMisIntraday } = await import('./api.js');
      const map = await fetchMisIntraday([code]);
      const d   = map[code];
      if (!d) return;

      // ── 統一走 PriceHub（persist:false = 盤中，不寫 DB）────────────────────
      PriceHub.push({ [code]: d }, { persist: false, updateHeader: true, source: 'mis-poll' });
      console.log(`[main] mis 即時 ${code} → ${d.price} (${d.chgPct >= 0 ? '+' : ''}${d.chgPct.toFixed(2)}%)`);
    } catch (e) {
      // mis 失敗靜默，等下次
    }
  }

  // Yahoo K線（5 分鐘一次，只影響圖形，不影響標頭報價）
  async function _pollKline(code) {
    if (!_isTradingNow() || AppState.activeCode !== code) return;
    try {
      await reloadChart({ force: true });
    } catch (e) { /* 失敗靜默 */ }
  }

  window.__startIntradayPolling = function(code) {
    _stopPolling();
    if (!_isTradingNow()) return;

    _pollingCode = code;
    // mis 即時報價：立即 + 每 15 秒
    _pollMisQuote(code);
    _quoteTimer = setInterval(() => _pollMisQuote(code), 15 * 1000);
    // K線：每 5 分鐘（Yahoo 延遲所以不需要太快）
    _klineTimer = setInterval(() => _pollKline(code), 5 * 60 * 1000);
    console.log(`[main] 盤中輪詢啟動 → ${code}（mis報價 15s / K線 5min）`);
  };

  // ── 自選清單盤中背景更新（慢速，每 3 分鐘輪一輪）────────────────────────
  // 每批 5 檔，批次間隔 3 秒，不影響主輪詢，MIS 失敗靜默略過
  let _wlPollRunning = false;

  async function _pollWatchlistPrices() {
    if (!_isTradingNow() || _wlPollRunning) return;
    _wlPollRunning = true;

    try {
      const { fetchMisIntraday } = await import('./api.js');

      const codes = [...new Set(
        (AppState.watchlistGroups ?? [])
          .flatMap(g => g.stocks ?? [])
          .map(s => s.code)
          .filter(c => /^\d{4,6}$/.test(c))  // 排除 ^TWII 等指數
      )];

      if (!codes.length) return;

      const BATCH = 5;
      const allMap = {};  // 收集整輪結果，最後一次 persist:true 存 DB

      for (let i = 0; i < codes.length; i += BATCH) {
        if (!_isTradingNow()) break;
        const batch = codes.slice(i, i + BATCH);
        try {
          const map = await fetchMisIntraday(batch);
          if (Object.keys(map).length > 0) {
            // 每批先 persist:false 即時更新 UI
            PriceHub.push(map, { persist: false, updateHeader: false, source: 'mis-wl-poll' });
            Object.assign(allMap, map);
          }
        } catch (e) { /* 靜默 */ }

        if (i + BATCH < codes.length) {
          await new Promise(r => setTimeout(r, 3000));  // 批次間隔 3 秒
        }
      }

      // ── 整輪跑完，直接 await updateStockPrices 確保 saveGroup 完成再 log ──
      // ⚠️ PriceHub.push 是同步，_updateWatchlistFn 沒有 await，saveGroup 可能未完成就關頁
      if (Object.keys(allMap).length > 0) {
        PriceHub.push(allMap, { persist: false, updateHeader: false, source: 'mis-wl-poll-final' });
        await updateStockPrices(allMap);
      }
      console.log(`[main] 自選清單盤中更新完成 ${codes.length} 檔（已存 DB）`);
      // 報價更新完畢，重算庫存健康度（接入即時價）
      refreshHealthFromPrice();
    } catch (e) {
      console.warn('[main] _pollWatchlistPrices failed:', e.message);
    } finally {
      _wlPollRunning = false;
    }
  }

  // 盤中才啟動：立刻跑第一次（讓清單開啟就有最新報價），之後每 3 分鐘一輪
  // ⚠️ 之前 10 秒後才跑，導致清單要點個股才更新
  if (_isTradingNow()) {
    _pollWatchlistPrices();
    setInterval(_pollWatchlistPrices, 3 * 60 * 1000);
  }
}

// ── Phase 7：K 線編輯模式 + 智能分析卡片 ──
initPhase7();

// ── Advanced 2：個股補充資訊 ──
initStockInfo();
window.__renderStockInfo = renderStockInfo;
})();

// ============================================================================
// Phase 7.5 A3 — 個股載入台詞(讀 analyze 結果說一句跟這檔有關的話)
// 原則:只在有明顯訊號時才說,避免噪音
// ============================================================================
function _dengLineForStock(result) {
  if (!result || result.empty) return null;

  const trend = result.trend;
  const vp    = result.volumePrice;
  const box   = result.box;

  // 爆量下殺 — 最優先說
  if (vp?.surge && trend?.direction === 'down') {
    return { text: `爆量下殺 — 這檔燈燈先觀望`, mood: 'sad' };
  }
  // 爆量拉升
  if (vp?.surge && trend?.direction === 'up') {
    const h = trend.health;
    if (h > 70) return { text: `爆量拉升!動能強(健康 ${h}) ~ 停損設好再進`, mood: 'savage' };
    return { text: `爆量拉升,但健康度 ${h} 不算高 — 別追高喵`, mood: 'curious' };
  }
  // 趨勢很健康
  if (trend?.health > 80 && trend?.direction === 'up') {
    const h = trend.health;
    return { text: `趨勢健康度 ${h} ~ 結構不錯,燈燈覺得可以觀察`, mood: 'happy' };
  }
  // 趨勢很差
  if (trend?.health < 35) {
    const h = trend.health;
    return { text: `健康度只有 ${h}... 燈燈覺得先觀望比較好`, mood: 'sad' };
  }
  // 接近箱型下緣
  if (box?.position === 'near_lower' && box?.lower) {
    return { text: `接近箱型下緣 $${Number(box.lower).toFixed(2)} ~ 可注意止跌訊號`, mood: 'curious' };
  }

  // 沒特別情況 → 不說(避免噪音)
  return null;
}
