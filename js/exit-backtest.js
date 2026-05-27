// js/exit-backtest.js
// ============================================================================
// 出場策略驗證 — 進場固定,出場 4 種規則對照 + 固定天數甜蜜點曲線
// ============================================================================
// 對外 API:
//   runExitBacktest(items, onProgress, opts) → 多檔批次出場回測
//   getDefaultEntries() / getDefaultExitRules() → 預設 3 進場 × 4 出場
//   findBestExitPerEntry(aggregated) → 找每個進場的最佳出場規則
//
// v1.1 新增:
//   固定天數甜蜜點曲線 — 5/10/15/20/25/30 天各自的勝率+報酬對照
//   讓「第 20 天是不是真的最佳」有實證依據
// ============================================================================

import { matchSignals } from './signal-scan.js';
import { calcMA, calcRSI } from './indicators.js';
import { getPeersOf } from './industry-groups.js';

const HORIZONS_TARGETS = [0.01, 0.02, 0.03];   // 1% / 2% / 3% 標的
const MAX_HOLD_DAYS    = 60;                    // 公平門檻
const MIN_HIST         = 30;                    // 進場切片最小歷史
const SAMPLE_STEP      = 1;

// ─── 甜蜜點曲線天數 ───────────────────────────────────────────────
const SWEET_SPOT_DAYS  = [5, 10, 15, 20, 25, 30, 45, 60];

// ─── 進場策略定義 ─────────────────────────────────────────────────
// 單策略: ids 只有一個元素
// 組合策略: ids 有多個元素, window=3 代表 3 天內都觸發過才算進場
// marketFilter: 'ma20up' = 當天 0050 MA20 需向上才允許進場
const DEFAULT_ENTRIES = [
  { id: 'W6',      ids: ['W6'],      label: 'W6 單獨',       window: 1, note: '基準 (實證 80%)' },
];

// 雙策略組合進場 — 跟 W6 配哪個最好
const COMBO_ENTRIES = [
  { id: 'W6+S40',  ids: ['W6','S40'], label: 'W6 + S40 紅三兵',   window: 3, note: '強勢動能 + K 線確認' },
  { id: 'W6+S11',  ids: ['W6','S11'], label: 'W6 + S11 三箭齊發', window: 3, note: '強勢動能 + 轉折確認' },
  { id: 'W6+S14',  ids: ['W6','S14'], label: 'W6 + S14 強勢鈍化', window: 3, note: '強勢動能 + 盤整突破' },
];

// 市況過濾器版 — 相同組合 + 0050 MA20 向上才允許進場
const FILTERED_ENTRIES = [
  { id: 'W6↑',     ids: ['W6'],      label: 'W6 + 市況↑',         window: 1, note: 'W6 + 0050 MA20 向上', marketFilter: 'ma20up' },
  { id: 'W6+S40↑', ids: ['W6','S40'], label: 'W6+S40 + 市況↑',    window: 3, note: 'K線確認 + 大盤多頭',  marketFilter: 'ma20up' },
  { id: 'W6+S11↑', ids: ['W6','S11'], label: 'W6+S11 + 市況↑',    window: 3, note: '轉折確認 + 大盤多頭', marketFilter: 'ma20up' },
  { id: 'W6+S14↑', ids: ['W6','S14'], label: 'W6+S14 + 市況↑',    window: 3, note: '鈍化突破 + 大盤多頭', marketFilter: 'ma20up' },
];

// ─── X 系列實驗策略(v2.7+)──────────────────────────────────────────
const X_ENTRIES = [
  { id: 'X1',     ids: ['X1'],      label: 'X1 黃金比例',      window: 1, note: '三軸共振 — 最穩' },
  { id: 'X2',     ids: ['X2'],      label: 'X2 天黑請閉眼',    window: 1, note: '飆股加速 — 最飆' },
  { id: 'X3',     ids: ['X3'],      label: 'X3 炒底王',         window: 1, note: 'V 型反轉 — 抄底' },
  { id: 'X4',     ids: ['X4'],      label: 'X4 何時輪到我',     window: 1, note: '族群輪動 — 跨股' },
  { id: 'X1↑',    ids: ['X1'],      label: 'X1 + 市況↑',        window: 1, note: '三軸共振 + 大盤多頭', marketFilter: 'ma20up' },
  { id: 'X2↑',    ids: ['X2'],      label: 'X2 + 市況↑',        window: 1, note: '飆股加速 + 大盤多頭', marketFilter: 'ma20up' },
  // X5 v2.8 候選策略 — 量證明一切（早期介入型）
  // 設計目的：比 X2 早 5-10 天抓到主力開始建倉爆量
  // 使用 10日均量×2.5（近期相對爆量），不用 30日均量×3（容易被前段大量拉高基期）
  // 條件：① vol_surge_short×2.5 ② gain_10d≥10% ③ RSI≥60 ④ 站上MA20 ⑤ MA20連2天上升
  // 實證前為候選策略，不影響五燈獎評分
  { id: 'X5',     ids: ['X5'],      label: 'X5 量證明一切',     window: 1, note: '早期爆量介入 — 比X2早進場' },
  { id: 'X5↑',    ids: ['X5'],      label: 'X5 + 市況↑',        window: 1, note: '早期爆量 + 大盤多頭', marketFilter: 'ma20up' },
  // S40 系列驗證 — 紅三兵單獨 + 組合（v2.8 麗正案例啟發）
  // 目的：驗證「紅三兵是否是好的進場訊號」，以及搭配什麼最好
  // 麗正 2302：S40 今天才亮，但股票從5月初就在漲
  // → 紅三兵確認的時候進場，比 X2 更早，量不需要爆
  { id: 'S40',        ids: ['S40'],           label: 'S40 紅三兵',           window: 1, note: '連三紅確認 — 主力建倉完成' },
  { id: 'S40+X1',     ids: ['S40','X1'],      label: 'S40 + X1 黃金比例',    window: 3, note: '紅三兵 + 三軸共振雙確認' },
  { id: 'S40+S14',    ids: ['S40','S14'],     label: 'S40 + S14 強勢鈍化',   window: 3, note: '紅三兵 + 盤整突破' },
  { id: 'S40+S4',     ids: ['S40','S4'],      label: 'S40 + S4 近期創高',    window: 3, note: '紅三兵 + 突破前高（最強組合？）' },
];

// ─── X2 妖股狀態機策略(v2.8+)──────────────────────────────────────
// 進場條件:X1 + X2 同時亮（三軸共振 + 飆股加速雙確認）
// 出場邏輯:搭配 E5「x1-exit」規則（X1 消失即出場）
// 設計哲學:
//   X1+X2 同亮 → 妖股主升段確認進場
//   X2 滅/只剩 X1 → 動能衰退警訊（用 E5 在 X1 消失時出場）
//   X1 也滅 → 趨勢結束，E5 最晚這時出場
//   W7 布林超買在此策略中不算警訊（飆股主升段的正常現象）
const YAOGU_ENTRIES = [
  {
    id:     'X1+X2',
    ids:    ['X1', 'X2'],
    label:  'X1+X2 妖股雙確認',
    window: 1,
    note:   '三軸共振+飆股加速，搭配 E5 X1消失出場',
    isYaogu: true,   // 標記為妖股策略，供 E5 出場規則識別
  },
  {
    id:     'X1+X2↑',
    ids:    ['X1', 'X2'],
    label:  'X1+X2 妖股 + 市況↑',
    window: 1,
    note:   '妖股雙確認 + 大盤多頭過濾',
    marketFilter: 'ma20up',
    isYaogu: true,
  },
];

// 完整清單
const ALL_ENTRIES = [
  ...DEFAULT_ENTRIES,
  ...COMBO_ENTRIES,
  ...FILTERED_ENTRIES,
  ...X_ENTRIES,
  ...YAOGU_ENTRIES,
];

// ─── 4 個出場規則 ─────────────────────────────────────────────────
const DEFAULT_EXIT_RULES = [
  { id: 'fixed-20d',     label: '固定 20 天',   desc: '基準對照,跟之前回測一致' },
  { id: 'trailing-5pct', label: '追蹤停損 5%',  desc: '從進場後最高收盤回落 5% 就賣' },
  { id: 'break-ma20',    label: '跌破 MA20',    desc: '收盤跌破 MA20 即賣(趨勢破壞)' },
  { id: 'rsi-below-60',  label: 'RSI < 60',     desc: '收盤 RSI 跌破 60 即賣(動能消失)' },
  // E5 v2.8 — 妖股狀態機出場規則
  // 逐日掃描 X1 訊號，X1 消失即出場
  // 搭配 X1+X2 妖股雙確認進場，形成完整妖股生命週期：
  //   X1+X2 亮 → 進場 → X2 滅(警戒) → X1 也滅 → E5 觸發出場
  { id: 'x1-exit',       label: 'X1 消失出場',  desc: '妖股狀態機:X1 動能訊號消失即離場' },
  // E6 v2.8 — 主力釣魚假說驗證
  // S40 紅三兵出現 = 散戶大量追進 = 主力倒貨時機
  // 搭配 X2 進場，看散戶接盤時出場的報酬是否優於持有到跌破MA20
  { id: 's40-exit',      label: 'S40 紅三兵出場', desc: '主力釣魚：散戶追紅三兵時出場，驗證倒貨假說' },
  // E7 v2.8 — 分批出場（S40出50% + MA20出50%）
  // 設計：S40 紅三兵出現時先出 50% 鎖利，剩 50% 等跌破 MA20 再全出
  // 理論報酬 ≈ S40報酬×50% + MA20報酬×50%
  // 驗證「保守追高、先取回現金」的避險策略是否最大化獲利
  { id: 's40-half-ma20', label: 'S40出50%+MA20出50%', desc: '分批出場：S40先鎖利一半，MA20再清倉' },
];

export function getDefaultEntries()    { return ALL_ENTRIES.map(e => ({ ...e })); }
export function getDefaultExitRules()  { return DEFAULT_EXIT_RULES.map(e => ({ ...e })); }

// ─── 出場規則實作 ─────────────────────────────────────────────────
/**
 * 從進場後逐日判定何時出場
 * @param {Candle[]} candles 完整 K 線
 * @param {number} entryIdx 進場 K 棒 index (該天收盤進場)
 * @param {string} ruleId 出場規則 ID
 * @returns {object} { exitIdx, exitReason, returnPct, holdDays }
 */
function simulateTrade(candles, entryIdx, ruleId, opts = {}) {
  const entryClose = candles[entryIdx].close;
  const maxIdx = Math.min(entryIdx + MAX_HOLD_DAYS, candles.length - 1);

  // E1: 固定 20 天
  if (ruleId === 'fixed-20d') {
    const exitIdx = Math.min(entryIdx + 20, candles.length - 1);
    const exitClose = candles[exitIdx].close;
    return {
      exitIdx,
      exitReason: '達 20 天',
      returnPct:  (exitClose - entryClose) / entryClose,
      holdDays:   exitIdx - entryIdx,
    };
  }

  // E2: 追蹤停損 5% (從進場後最高收盤回落 5%)
  if (ruleId === 'trailing-5pct') {
    let highWatermark = entryClose;
    for (let i = entryIdx + 1; i <= maxIdx; i++) {
      const close = candles[i].close;
      if (close > highWatermark) highWatermark = close;
      // 回落 5% 出場
      if (close <= highWatermark * 0.95) {
        return {
          exitIdx:    i,
          exitReason: '追蹤停損觸發',
          returnPct:  (close - entryClose) / entryClose,
          holdDays:   i - entryIdx,
        };
      }
    }
    // 到達最大持有期沒觸發 → 用最後一天出場
    const exitClose = candles[maxIdx].close;
    return {
      exitIdx:    maxIdx,
      exitReason: '達最大持有 60 天',
      returnPct:  (exitClose - entryClose) / entryClose,
      holdDays:   maxIdx - entryIdx,
    };
  }

  // E3: 跌破 MA20 (D+1 起判定,收盤跌破即賣)
  if (ruleId === 'break-ma20') {
    for (let i = entryIdx + 1; i <= maxIdx; i++) {
      // 算 MA20 用切片 (entry 之前的歷史 + 包含 i 的當天)
      // 至少需要 19 根之前的資料
      if (i < 19) continue;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const ma20Arr = calcMA(closes, 20);
      const ma20Now = ma20Arr[ma20Arr.length - 1];
      if (ma20Now == null) continue;

      if (candles[i].close < ma20Now) {
        return {
          exitIdx:    i,
          exitReason: '跌破 MA20',
          returnPct:  (candles[i].close - entryClose) / entryClose,
          holdDays:   i - entryIdx,
        };
      }
    }
    // 沒觸發 → 最大持有期出場
    const exitClose = candles[maxIdx].close;
    return {
      exitIdx:    maxIdx,
      exitReason: '達最大持有 60 天',
      returnPct:  (exitClose - entryClose) / entryClose,
      holdDays:   maxIdx - entryIdx,
    };
  }

  // E4: RSI < 60
  if (ruleId === 'rsi-below-60') {
    for (let i = entryIdx + 1; i <= maxIdx; i++) {
      if (i < 14) continue;
      const closes = candles.slice(0, i + 1).map(c => c.close);
      const rsiArr = calcRSI(closes, 14);
      const rsiNow = rsiArr[rsiArr.length - 1];
      if (rsiNow == null) continue;

      if (rsiNow < 60) {
        return {
          exitIdx:    i,
          exitReason: 'RSI < 60',
          returnPct:  (candles[i].close - entryClose) / entryClose,
          holdDays:   i - entryIdx,
        };
      }
    }
    const exitClose = candles[maxIdx].close;
    return {
      exitIdx:    maxIdx,
      exitReason: '達最大持有 60 天',
      returnPct:  (exitClose - entryClose) / entryClose,
      holdDays:   maxIdx - entryIdx,
    };
  }

  // E5: X1 消失出場（妖股狀態機）
  // ⚠️ 注意：此規則需要逐日跑 matchSignals，效能比 E1-E4 慢
  //   因此 simulateTrade 在此規則下需要額外的 precomputedSignals 資訊
  //   設計上：呼叫端（runExitBacktestSingle）預建 signalCache，
  //   透過 opts.signalCache 傳入，避免重複計算
  //   signalCache: Map<idx, Set<stratId>>
  if (ruleId === 'x1-exit') {
    const signalCache = opts?.signalCache;
    for (let i = entryIdx + 1; i <= maxIdx; i++) {
      // 從 signalCache 取預算結果
      const sigSet = signalCache?.get(i);
      // sigSet 為 null/undefined 表示該天沒有訊號或未預算
      const hasX1 = sigSet ? sigSet.has('X1') : false;
      if (!hasX1) {
        return {
          exitIdx:    i,
          exitReason: 'X1 消失',
          returnPct:  (candles[i].close - entryClose) / entryClose,
          holdDays:   i - entryIdx,
        };
      }
    }
    // X1 持續亮到最大持有期 → 到期出場
    const exitClose = candles[maxIdx].close;
    return {
      exitIdx:    maxIdx,
      exitReason: '達最大持有 60 天（X1 持續）',
      returnPct:  (exitClose - entryClose) / entryClose,
      holdDays:   maxIdx - entryIdx,
    };
  }

  // E6: S40 紅三兵出現即出場（主力釣魚假說驗證）
  // 假說：S40 紅三兵是散戶追進的訊號，主力趁機倒貨
  // 驗證方式：X2 妖股進場後，等 S40 出現就出場
  // 對照組：跌破MA20出場（+22.7%）
  // 若 S40 出場報酬 > MA20 → 主力釣魚假說成立
  if (ruleId === 's40-exit') {
    const signalCache = opts?.signalCache;
    for (let i = entryIdx + 1; i <= maxIdx; i++) {
      const sigSet = signalCache?.get(i);
      const hasS40 = sigSet ? sigSet.has('S40') : false;
      if (hasS40) {
        return {
          exitIdx:    i,
          exitReason: 'S40 紅三兵出現（主力倒貨）',
          returnPct:  (candles[i].close - entryClose) / entryClose,
          holdDays:   i - entryIdx,
        };
      }
    }
    const exitClose = candles[maxIdx].close;
    return {
      exitIdx:    maxIdx,
      exitReason: '達最大持有 60 天（S40 未出現）',
      returnPct:  (exitClose - entryClose) / entryClose,
      holdDays:   maxIdx - entryIdx,
    };
  }

  // E7: 分批出場（S40出50% + MA20出50%）
  // 設計原則：
  //   S40 紅三兵出現 → 第一批 50% 出場鎖利（保守避險）
  //   跌破 MA20     → 第二批 50% 出場清倉（守住趨勢）
  //   整體報酬 = S40時報酬 × 0.5 + MA20時報酬 × 0.5
  //   若 S40 未出現 → 全倉等 MA20 出場
  //   若 MA20 未破  → 全倉等到最大持有期
  if (ruleId === 's40-half-ma20') {
    const signalCache = opts?.signalCache;
    let s40Ret  = null;   // 第一批出場報酬
    let s40Idx  = null;   // 第一批出場位置

    // 掃描：找 S40 和 MA20 的出場點
    for (let i = entryIdx + 1; i <= maxIdx; i++) {
      const sigSet = signalCache?.get(i);

      // 第一批：S40 紅三兵（還沒出過第一批）
      if (s40Idx === null && sigSet?.has('S40')) {
        s40Ret = (candles[i].close - entryClose) / entryClose;
        s40Idx = i;
      }

      // 第二批：跌破 MA20
      if (i < 19) continue;
      const closes  = candles.slice(0, i + 1).map(c => c.close);
      const ma20Arr = calcMA(closes, 20);
      const ma20Now = ma20Arr[ma20Arr.length - 1];
      if (ma20Now == null) continue;

      if (candles[i].close < ma20Now) {
        const ma20Ret = (candles[i].close - entryClose) / entryClose;
        if (s40Idx !== null) {
          // 兩批都出了：加權平均
          return {
            exitIdx:    i,
            exitReason: `S40(${s40Idx - entryIdx}天)+MA20(${i - entryIdx}天)分批`,
            returnPct:  s40Ret * 0.5 + ma20Ret * 0.5,
            holdDays:   i - entryIdx,  // 用最後出場日當持有天數
          };
        } else {
          // S40 沒出現，全倉 MA20 出場
          return {
            exitIdx:    i,
            exitReason: '跌破 MA20（S40未觸發，全倉出）',
            returnPct:  ma20Ret,
            holdDays:   i - entryIdx,
          };
        }
      }
    }

    // 都沒觸發 → 最大持有期出場
    const exitClose = candles[maxIdx].close;
    const maxRet    = (exitClose - entryClose) / entryClose;
    if (s40Idx !== null) {
      // S40 出了第一批，第二批到期出
      return {
        exitIdx:    maxIdx,
        exitReason: `S40(${s40Idx - entryIdx}天)+到期分批`,
        returnPct:  s40Ret * 0.5 + maxRet * 0.5,
        holdDays:   maxIdx - entryIdx,
      };
    }
    return {
      exitIdx:    maxIdx,
      exitReason: '達最大持有 60 天',
      returnPct:  maxRet,
      holdDays:   maxIdx - entryIdx,
    };
  }

  return null;
}

// ─── 單檔出場回測 ──────────────────────────────────────────────────
function runExitBacktestSingle(candles, entries, exitRules, opts = {}) {
  const {
    sampleStep = SAMPLE_STEP,
    etf0050Candles = null,
    industryOpts = null,   // v2.7+ { code, basketRsiSeries, basketCandleMap }
  } = opts;

  if (!candles || candles.length < MIN_HIST + MAX_HOLD_DAYS + 5) {
    return { ok: false, reason: 'K線不足' };
  }

  // ─── v2.7+ industry context builder(每個 t 點查表,O(1) 查找) ────
  // 從預算好的 basketRsiSeries 查 peers 在「該 t 點」的 RSI 值
  // 注意:peers 來自 hardcode 族群表,可能很多不在 basket 裡,
  //      不在 basket 內的 peers 直接跳過(無資料可比)
  //
  // ⚠️ 時間軸對齊:basket 內各檔 candles 長度不一,query 時要先找出
  //    對應的 candles index(用「最近的日期」或「等距估算」)。
  //    這裡簡化做法:假設所有 candles 都是同期間的日 K,直接用相對 idx 對齊。
  //    若 peer candles 較短,fallback 用最後可用值。
  let buildContextAt = null;
  if (industryOpts && industryOpts.code) {
    const { code, basketRsiSeries, basketCandleMap } = industryOpts;
    const peers = getPeersOf(code);
    // 只挑同時在 basket 內的 peers,省時間
    const availablePeers = peers.filter(p => basketRsiSeries.has(p));

    if (availablePeers.length > 0) {
      // 計算本股 candles 跟每個 peer candles 的對應 offset
      // 假設今天(最後一根)兩邊都對齊,往前走時用相同步幅
      const myLastIdx = candles.length - 1;
      const peerLastIdx = new Map();   // peer code → 該 peer candles 的最後 idx
      for (const p of availablePeers) {
        const pc = basketCandleMap.get(p);
        if (pc) peerLastIdx.set(p, pc.length - 1);
      }

      buildContextAt = (t) => {
        // t 是本股 candles 的進場點(1-indexed,sliced.length=t,當前根=t-1)
        const myIdx       = t - 1;
        const backOffset  = myLastIdx - myIdx;   // 距今天幾根
        const peerRsi     = [];
        for (const p of availablePeers) {
          const lastIdx = peerLastIdx.get(p);
          if (lastIdx == null) continue;
          const pIdx = lastIdx - backOffset;
          if (pIdx < 14) continue;   // RSI(14) 需要至少 15 根
          const rsiArr = basketRsiSeries.get(p);
          const v = rsiArr?.[pIdx];
          if (Number.isFinite(v)) peerRsi.push({ code: p, rsi: v });
        }
        if (!peerRsi.length) return null;
        return { code, peers: peerRsi };
      };
    }
  }

  // ── 預建 0050 MA20 方向 cache ──────────────────────────────────
  // ma20UpSet: Set<t> — 在 t 點時 0050 MA20 是向上的
  // 對齊方式: 假設個股 candles[i].time 跟 0050 candles[j].time 相同日期
  // 簡化做法: 用 index 對齊(兩者都是日 K,長度可能略不同,取 min)
  const ma20UpCache = new Map();   // key=t(1-indexed), value=boolean
  if (etf0050Candles && etf0050Candles.length >= 21) {
    const etfCloses = etf0050Candles.map(c => c.close);
    // 對每個 t 點算 0050 MA20 是否向上
    for (let t = MIN_HIST; t < candles.length - MAX_HOLD_DAYS; t++) {
      // 0050 的 index 對齊:用相同 t,如果 0050 比個股短就用最後一根
      const etfT = Math.min(t, etfCloses.length - 1);
      if (etfT < 20) { ma20UpCache.set(t, true); continue; }  // 資料不足,不過濾
      const ma20Now  = etfCloses.slice(etfT - 20, etfT).reduce((s, v) => s + v, 0) / 20;
      const ma20Prev = etfCloses.slice(etfT - 21, etfT - 1).reduce((s, v) => s + v, 0) / 20;
      ma20UpCache.set(t, ma20Now > ma20Prev);
    }
  }

  // stats[entryId][exitRuleId][target%] = { trades, wins, returns, exitReasonCounts }
  const stats = {};
  for (const entry of entries) {
    stats[entry.id] = {};
    // ── 甜蜜點槽位初始化 ──────────────────────────────────────────
    stats[entry.id]._sweetSpot = {};
    for (const d of SWEET_SPOT_DAYS) {
      stats[entry.id]._sweetSpot[d] = {
        day:      d,
        count:    0,
        wins:     0,      // 報酬 >= 1%
        returnSum: 0,
        maxGain:  -Infinity,
        maxLoss:  Infinity,
      };
    }
    for (const exitRule of exitRules) {
      stats[entry.id][exitRule.id] = {};
      for (const T of HORIZONS_TARGETS) {
        const tKey = `${(T*100).toFixed(0)}pct`;
        stats[entry.id][exitRule.id][tKey] = {
          target:        T,
          trades:        0,
          wins:          0,
          returnSum:     0,
          maxGain:       -Infinity,
          maxLoss:       Infinity,
          holdDaysSum:   0,
          exitReasonCounts: {},  // { '跌破 MA20': 5, '達最大持有': 3 }
        };
      }
    }
  }

  // 預建 triggerHistory cache:記錄每個 t 點觸發的訊號 ID set
  // 用來支援「3 天內都觸發過」的組合進場條件
  // key = t (1-indexed), value = Set<stratId>
  const triggerHistory = new Map();

  // v2.8 signalCache:E5「X1 消失出場」需要查每個 idx 的 X1 是否亮
  // 跟 triggerHistory 共用同一份資料（triggerHistory 本身就是 Map<t, Set<id>>）
  // E5 出場掃描時直接查 triggerHistory.get(i)，不需要額外預算
  // ⚠️ 但因為主迴圈是 sampleStep 採樣，可能跳過某些 idx
  //    E5 需要「每天」的訊號，所以需要補全缺漏的 idx
  //    解法：主迴圈跑完後，對「有 X1+X2 進場的 entryIdx」到 entryIdx+MAX_HOLD_DAYS
  //    的每個 idx 補算訊號（lazy，只補需要的範圍）
  const needFullScan = entries.some(e => e.isYaogu);  // 有妖股策略才需要補全

  // v2.8 前兆溯源分析用：記錄「X2進場 + 跌破MA20出場」的所有交易
  // 格式：[{ entryIdx, exitIdx }]
  // 只收集「X2 or X1+X2 策略 + break-ma20 出場」的交易
  const ma20Trades = [];

  // 主回測迴圈
  for (let t = MIN_HIST; t < candles.length - MAX_HOLD_DAYS; t += sampleStep) {
    const sliced = candles.slice(0, t);

    // 合成 twseRow
    let twseRow = null;
    if (sliced.length >= 2) {
      const last = sliced[sliced.length - 1];
      const prev = sliced[sliced.length - 2];
      const chgPct = prev.close > 0 ? (last.close - prev.close) / prev.close * 100 : 0;
      twseRow = {
        price:  last.close,
        chgPct: chgPct,
        volume: Math.round((last.volume ?? 0) / 1000),
      };
    }

    let signals;
    try {
      // v2.7+ 帶 industryContext 給 X4「何時輪到我」用
      const industryContext = buildContextAt ? buildContextAt(t) : null;
      signals = matchSignals(sliced, twseRow, { industryContext });
    } catch { continue; }
    if (!signals || signals.length === 0) {
      triggerHistory.set(t, new Set());
      continue;
    }

    const sigIds = new Set(signals.map(s => s.id));
    triggerHistory.set(t, sigIds);
    const entryIdx = t - 1;

    // 對每個進場定義(單策略 or 組合策略)
    for (const entry of entries) {
      // ── 判斷是否觸發進場 ────────────────────────────────────────
      // 單策略(window=1): 今天有觸發 entry.ids[0] 就算
      // 組合策略(window=3): 過去 window 天內,每個 id 都至少觸發過一次
      // marketFilter='ma20up': 額外要求當天 0050 MA20 向上
      let triggered = false;
      if (entry.window <= 1) {
        triggered = entry.ids.every(id => sigIds.has(id));
      } else {
        const recentIds = new Set();
        for (let back = 0; back < entry.window; back++) {
          const hist = triggerHistory.get(t - back);
          if (hist) hist.forEach(id => recentIds.add(id));
        }
        triggered = entry.ids.every(id => recentIds.has(id));
      }
      if (!triggered) continue;

      // 市況過濾器
      if (entry.marketFilter === 'ma20up') {
        const isUp = ma20UpCache.get(t);
        // 沒有 0050 資料時預設不過濾(向上)
        if (isUp === false) continue;
      }

      const entryClose = candles[entryIdx].close;

      // ── 甜蜜點曲線:逐日記錄固定天數的報酬 ──────────────────────
      for (const d of SWEET_SPOT_DAYS) {
        const exitIdx = entryIdx + d;
        if (exitIdx >= candles.length) continue;
        const ret = (candles[exitIdx].close - entryClose) / entryClose;
        const sw = stats[entry.id]._sweetSpot[d];
        sw.count++;
        sw.returnSum += ret;
        if (ret >= 0.01) sw.wins++;
        if (ret > sw.maxGain) sw.maxGain = ret;
        if (ret < sw.maxLoss) sw.maxLoss = ret;
      }

      // 對每個出場規則模擬
      for (const exitRule of exitRules) {
        // v2.8 E5 x1-exit：需要 signalCache（逐日 X1 狀態）
        // 直接傳 triggerHistory（主迴圈已預建），E5 內部用 sigSet.has('X1') 查詢
        // ⚠️ 注意：triggerHistory 只有 sampleStep 採樣的點有資料
        //    E5 在採樣間隔內的 idx 會拿到 undefined（視為 X1 不亮 → 提早出場）
        //    妖股策略預設 sampleStep=1（每天都掃），所以通常沒問題
        //    若 sampleStep > 1 跑妖股策略，E5 結果會偏保守（提早出場）
        const tradeOpts = (exitRule.id === 'x1-exit' || exitRule.id === 's40-exit' || exitRule.id === 's40-half-ma20')
          ? { signalCache: triggerHistory }
          : undefined;
        const trade = simulateTrade(candles, entryIdx, exitRule.id, tradeOpts);
        if (!trade) continue;

        // v2.8 前兆溯源：收集 X2系列 + 跌破MA20 的交易記錄
        if (exitRule.id === 'break-ma20' &&
            (entry.id === 'X2' || entry.id === 'X2↑' || entry.id === 'X1+X2' || entry.id === 'X1+X2↑') &&
            trade.exitReason === '跌破 MA20') {
          ma20Trades.push({ entryIdx, exitIdx: trade.exitIdx, entryId: entry.id });
        }

        // 對每個標的判勝
        for (const T of HORIZONS_TARGETS) {
          const tKey = `${(T*100).toFixed(0)}pct`;
          const s = stats[entry.id][exitRule.id][tKey];
          s.trades++;
          s.returnSum   += trade.returnPct;
          s.holdDaysSum += trade.holdDays;
          if (trade.returnPct >= T) s.wins++;
          if (trade.returnPct > s.maxGain) s.maxGain = trade.returnPct;
          if (trade.returnPct < s.maxLoss) s.maxLoss = trade.returnPct;
          // 出場理由統計 (只在 target=1% 那層存,避免重複)
          if (T === 0.01) {
            s.exitReasonCounts[trade.exitReason] = (s.exitReasonCounts[trade.exitReason] || 0) + 1;
          }
        }
      }
    }
  }

  // 算最終比率
  for (const entryId in stats) {
    for (const ruleId in stats[entryId]) {
      if (ruleId === '_sweetSpot') continue;  // 甜蜜點槽位不在這裡處理
      for (const tKey in stats[entryId][ruleId]) {
        const s = stats[entryId][ruleId][tKey];
        if (s.trades === 0) {
          s.winRate = s.avgReturn = s.avgHoldDays = null;
        } else {
          s.winRate     = s.wins / s.trades;
          s.avgReturn   = s.returnSum / s.trades;
          s.avgHoldDays = s.holdDaysSum / s.trades;
        }
        delete s.returnSum;
        delete s.holdDaysSum;
      }
    }
  }

  return {
    ok: true,
    stats,
    ma20Trades,        // v2.8 前兆分析用
    triggerHistory,    // v2.8 前兆分析用（Map<idx, Set<signalId>>）
  };
}

// ─── 多檔批次 ──────────────────────────────────────────────────────
export async function runExitBacktest(items, onProgress, opts = {}) {
  const {
    sampleStep = 1,
    signal = null,
    entries = DEFAULT_ENTRIES,
    exitRules = DEFAULT_EXIT_RULES,
    etf0050Candles = null,   // 市況過濾器用的 0050 K 線
  } = opts;

  // ─── v2.7+ 預建 X4「同族群 peers RSI」cache ────────────────────────
  // 入口處先把 basket 整個跑一輪算每檔的 RSI series,讓 single 可以 O(1) 查表
  // 避免 single 內每個 t 點都重算 peers RSI(會 ×N 倍計算量)
  //
  // 結構:basketRsiSeries.get(code) → number[](RSI 14 序列,index 對齊 candles)
  //      basketCandleMap.get(code) → Candle[]
  //
  // 注意:items 結構是 { code, name, type, candles },可能有些 code 缺 candles
  const basketRsiSeries = new Map();
  const basketCandleMap = new Map();
  for (const it of items) {
    if (!it.candles || it.candles.length < 15) continue;
    basketCandleMap.set(it.code, it.candles);
    try {
      const closes = it.candles.map(c => c.close);
      const rsi    = calcRSI(closes, 14);
      basketRsiSeries.set(it.code, rsi);
    } catch (_) { /* 算不出來不擋 */ }
  }

  // 注意 X 系列有沒有在 entries 裡,沒有就不用算 industryContext(省事)
  const hasXStrategy = entries.some(e => e.ids.some(id => /^X\d/.test(id)));

  const perStock = [];
  let aborted = false;

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) { aborted = true; break; }
    const item = items[i];
    const { code, name, type, candles } = item;

    let result;
    if (!candles || candles.length < MIN_HIST + MAX_HOLD_DAYS + 5) {
      result = { code, name, type, ok: false, reason: 'K線不足' };
    } else {
      try {
        const bt = runExitBacktestSingle(candles, entries, exitRules, {
          sampleStep,
          etf0050Candles,
          industryOpts: hasXStrategy ? {
            code,
            basketRsiSeries,
            basketCandleMap,
          } : null,
        });
        // v2.8 合併 ma20Trades 跟 triggerHistory 到 perStock 結果
        result = { code, name, type, ...bt };
      } catch (err) {
        result = { code, name, type, ok: false, reason: err.message || 'unknown' };
      }
    }
    perStock.push(result);
    try { await onProgress?.(i + 1, items.length, item, perStock); } catch {}
    await new Promise(r => setTimeout(r, 0));
  }

  const aggregated = _aggregateAcrossStocks(perStock, entries, exitRules);

  // v2.8 前兆溯源分析：跨股彙整所有 ma20Trades + triggerHistory
  const precursorAnalysis = _analyzePrecursorSignals(perStock);

  // v2.8 健檢報告：可一鍵複製的文字摘要
  const healthReport = _generateHealthReport(aggregated, entries, exitRules, precursorAnalysis);

  return {
    ok: true,
    perStock,
    aggregated,
    entries,
    exitRules,
    aborted,
    precursorAnalysis,   // v2.8 前兆分析結果
    healthReport,        // v2.8 健檢報告文字（可直接複製）
    formula: 'exit-bt-v1.5-precursor',
  };
}

// 跨股彙整
function _aggregateAcrossStocks(perStock, entries, exitRules) {
  const agg = {};

  for (const entry of entries) {
    agg[entry.id] = { ...entry, exitRules: {}, sweetSpot: {} };
    // 甜蜜點槽位
    for (const d of SWEET_SPOT_DAYS) {
      agg[entry.id].sweetSpot[d] = {
        day: d, count: 0, wins: 0, returnSum: 0,
        maxGain: -Infinity, maxLoss: Infinity,
      };
    }
    for (const exitRule of exitRules) {
      agg[entry.id].exitRules[exitRule.id] = { ...exitRule, targets: {} };
      for (const T of HORIZONS_TARGETS) {
        const tKey = `${(T*100).toFixed(0)}pct`;
        agg[entry.id].exitRules[exitRule.id].targets[tKey] = {
          target:        T,
          trades:        0,
          wins:          0,
          returnSum:     0,
          maxGain:       -Infinity,
          maxLoss:       Infinity,
          holdDaysSum:   0,
          exitReasonCounts: {},
        };
      }
    }
  }

  for (const stock of perStock) {
    if (!stock.ok || !stock.stats) continue;
    for (const entryId in stock.stats) {
      if (!agg[entryId]) continue;

      // 甜蜜點累加 — 注意 _sweetSpot 是 stats[entryId] 的屬性
      const sw = stock.stats[entryId]._sweetSpot;
      if (sw) {
        for (const d of SWEET_SPOT_DAYS) {
          const slot = sw[d];
          const ac   = agg[entryId].sweetSpot[d];
          if (!slot || !ac || slot.count === 0) continue;
          ac.count     += slot.count;
          ac.wins      += slot.wins;
          ac.returnSum += slot.returnSum;
          if (slot.maxGain !== -Infinity && slot.maxGain > ac.maxGain) ac.maxGain = slot.maxGain;
          if (slot.maxLoss !==  Infinity && slot.maxLoss < ac.maxLoss) ac.maxLoss = slot.maxLoss;
        }
      }

      // 出場規則累加
      for (const ruleId in stock.stats[entryId]) {
        if (ruleId === '_sweetSpot') continue;
        for (const tKey in stock.stats[entryId][ruleId]) {
          const sc = stock.stats[entryId][ruleId][tKey];
          const ac = agg[entryId]?.exitRules?.[ruleId]?.targets?.[tKey];
          if (!ac || !sc || typeof sc.trades !== 'number' || sc.trades === 0) continue;
          ac.trades       += sc.trades;
          ac.wins         += sc.wins;
          ac.returnSum    += (sc.avgReturn ?? 0) * sc.trades;
          ac.holdDaysSum  += (sc.avgHoldDays ?? 0) * sc.trades;
          if (sc.maxGain != null && sc.maxGain > ac.maxGain) ac.maxGain = sc.maxGain;
          if (sc.maxLoss != null && sc.maxLoss < ac.maxLoss) ac.maxLoss = sc.maxLoss;
          if (sc.exitReasonCounts) {
            for (const reason in sc.exitReasonCounts) {
              ac.exitReasonCounts[reason] = (ac.exitReasonCounts[reason] || 0) + sc.exitReasonCounts[reason];
            }
          }
        }
      }
    }
  }

  // 算最終
  for (const entryId in agg) {
    // 甜蜜點曲線計算
    for (const d of SWEET_SPOT_DAYS) {
      const sw = agg[entryId].sweetSpot[d];
      if (sw.count === 0) {
        sw.avgReturn = null; sw.winRate = null;
      } else {
        sw.avgReturn = sw.returnSum / sw.count;
        sw.winRate   = sw.wins / sw.count;
      }
      delete sw.returnSum;
    }
    // 出場規則
    for (const ruleId in agg[entryId].exitRules) {
      for (const tKey in agg[entryId].exitRules[ruleId].targets) {
        const c = agg[entryId].exitRules[ruleId].targets[tKey];
        if (c.trades === 0) {
          c.winRate = c.avgReturn = c.avgHoldDays = null;
        } else {
          c.winRate     = c.wins / c.trades;
          c.avgReturn   = c.returnSum / c.trades;
          c.avgHoldDays = c.holdDaysSum / c.trades;
        }
        delete c.returnSum;
        delete c.holdDaysSum;
      }
    }
  }

  return agg;
}

// 找每個進場策略的「最佳出場」(按 target=1% 的 winRate × avgReturn 排序)
export function findBestExitPerEntry(aggregated) {
  const result = [];
  for (const entryId in aggregated) {
    const entry = aggregated[entryId];
    let best = null;
    let bestScore = -Infinity;
    const allExits = [];

    for (const ruleId in entry.exitRules) {
      const rule = entry.exitRules[ruleId];
      // 用 target=1% 的數據評估(最寬鬆)
      const c = rule.targets['1pct'];
      if (!c || c.trades < 5) {
        allExits.push({ ruleId, ...rule, summary: c, score: -Infinity });
        continue;
      }
      const score = c.winRate * (c.avgReturn + 0.01);
      allExits.push({ ruleId, ...rule, summary: c, score });
      if (score > bestScore) {
        bestScore = score;
        best = { ruleId, ...rule, summary: c };
      }
    }

    // 把當前的「固定 20 天」當基準
    const baseline = allExits.find(e => e.ruleId === 'fixed-20d');

    result.push({
      ...entry,
      bestExit:   best,
      baseline,
      allExits,
      sweetSpot:  entry.sweetSpot || null,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// v2.8 前兆溯源分析
// 對所有「X2進場 + 跌破MA20出場」的交易，分析出場前 N 天各訊號出現率
// ═══════════════════════════════════════════════════════════════════

/**
 * 彙整跨股的前兆訊號統計
 * @param {Array} perStock  runExitBacktest 的 perStock 結果（含 ma20Trades + triggerHistory）
 * @returns {object|null}   precursorAnalysis 結果
 */
function _analyzePrecursorSignals(perStock) {
  // 收集所有 ma20Trades
  const allTrades = [];
  for (const s of perStock) {
    if (!s.ok || !s.ma20Trades?.length) continue;
    for (const trade of s.ma20Trades) {
      allTrades.push({
        ...trade,
        triggerHistory: s.triggerHistory,
      });
    }
  }

  if (allTrades.length === 0) return null;

  // 要分析的前兆訊號
  const PRECURSORS = [
    { id: 'W14', name: 'MACD 高位死叉',  layer: 1 },
    { id: 'W5',  name: '急跌訊號',        layer: 1 },
    { id: 'W13', name: '量增價跌',         layer: 2 },
    { id: 'W2',  name: 'KD+MACD 雙死叉',  layer: 2 },
    { id: 'W17', name: 'DMI 空頭確認',     layer: 2 },
    { id: 'W9',  name: 'KD 死叉月線下',    layer: 2 },
    { id: 'W6',  name: 'RSI 超買消失',     layer: 1, checkAbsence: true },  // 消失才是警訊
    { id: 'X2',  name: 'X2 天黑消失',      layer: 1, checkAbsence: true },
    { id: 'X1',  name: 'X1 黃金比例消失',  layer: 1, checkAbsence: true },
  ];

  const LOOKBACKS = [1, 3, 5, 10];

  const result = {};

  for (const precursor of PRECURSORS) {
    const stats = {};
    for (const lb of LOOKBACKS) stats[lb] = { hit: 0, total: 0 };

    // 記錄「首次出現（或消失）距出場日的天數」
    const leadDays = [];

    for (const trade of allTrades) {
      const { exitIdx, triggerHistory } = trade;

      for (const lb of LOOKBACKS) {
        stats[lb].total++;

        // 檢查出場前 lb 天內是否有此訊號（或消失）
        let found = false;
        for (let back = 0; back < lb; back++) {
          const idx = exitIdx - back;
          if (idx < 0) break;
          const sigSet = triggerHistory?.get(idx);

          if (precursor.checkAbsence) {
            // 「消失」型：要找到「之前亮 → 現在不亮」的轉折點
            const isGone = !sigSet?.has(precursor.id);
            if (isGone) {
              // 確認更早之前是否亮過（5天內曾亮）
              const wasThere = Array.from({ length: 5 }, (_, i) => exitIdx - lb - i)
                .some(i2 => i2 >= 0 && triggerHistory?.get(i2)?.has(precursor.id));
              if (wasThere) { found = true; break; }
            }
          } else {
            // 「出現」型：直接找訊號
            if (sigSet?.has(precursor.id)) { found = true; break; }
          }
        }
        if (found) stats[lb].hit++;
      }

      // 算「平均領先天數」：找最早出現（或消失）的天數
      let firstAppear = null;
      for (let back = 30; back >= 0; back--) {
        const idx = exitIdx - back;
        if (idx < 0) continue;
        const sigSet = triggerHistory?.get(idx);

        if (precursor.checkAbsence) {
          // 「消失型」：找「由亮轉滅」的轉折點
          // 條件：第 back 天不亮，且第 back+1 天（更早）是亮的
          const isGoneNow = !sigSet?.has(precursor.id);
          const prevIdx = exitIdx - back - 1;
          const wasOnPrev = prevIdx >= 0 && triggerHistory?.get(prevIdx)?.has(precursor.id);
          if (isGoneNow && wasOnPrev) {
            firstAppear = back;  // 距出場幾天前「消失」
          }
        } else {
          // 「出現型」：找最早出現的那天
          if (sigSet?.has(precursor.id)) firstAppear = back;
        }
      }
      if (firstAppear != null) leadDays.push(firstAppear);
    }

    const hitRates = {};
    for (const lb of LOOKBACKS) {
      hitRates[lb] = stats[lb].total > 0
        ? (stats[lb].hit / stats[lb].total * 100).toFixed(0) + '%'
        : '—';
    }

    const avgLead = leadDays.length > 0
      ? (leadDays.reduce((a, b) => a + b, 0) / leadDays.length).toFixed(1)
      : null;

    result[precursor.id] = {
      name:     precursor.name,
      layer:    precursor.layer,
      isAbsence: !!precursor.checkAbsence,
      hitRates,       // { 1: '78%', 3: '89%', 5: '92%', 10: '95%' }
      avgLeadDays: avgLead,  // 平均領先出場幾天
      sampleCount: allTrades.length,
    };
  }

  return {
    totalTrades: allTrades.length,
    precursors:  result,
    // 按「出場前3天命中率」排序的前兆訊號清單
    ranked: Object.entries(result)
      .map(([id, v]) => ({ id, ...v, score: parseFloat(v.hitRates[3]) || 0 }))
      .sort((a, b) => b.score - a.score),
  };
}

// ═══════════════════════════════════════════════════════════════════
// v2.8 健檢報告生成（一鍵複製）
// ═══════════════════════════════════════════════════════════════════

/**
 * 生成可複製的文字健檢報告
 * @param {object} aggregated   _aggregateAcrossStocks 的結果
 * @param {Array}  entries
 * @param {Array}  exitRules
 * @param {object} precursor    _analyzePrecursorSignals 的結果
 * @returns {string}  純文字報告
 */
function _generateHealthReport(aggregated, entries, exitRules, precursor) {
  const now  = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const lines = [];

  lines.push(`📊 出場回測健檢報告 ${date}`);
  lines.push('═'.repeat(52));

  // 每個 entry 的最佳出場
  const entryOrder = entries.map(e => e.id);
  for (const entryId of entryOrder) {
    const agg = aggregated[entryId];
    if (!agg) continue;

    const entryDef = entries.find(e => e.id === entryId);
    const sweet60  = agg.sweetSpot?.[60];
    const sweet60Pct = (sweet60?.count >= 3 && sweet60?.avgReturn != null)
      ? (sweet60.avgReturn * 100).toFixed(1) + '%'
      : '樣本不足';

    // 找最佳出場規則
    let bestRule = null, bestScore = -Infinity;
    for (const ruleId of Object.keys(agg.exitRules || {})) {
      const c = agg.exitRules[ruleId]?.targets?.['1pct'];
      if (!c || c.trades < 5) continue;
      const score = c.winRate * (c.avgReturn + 0.01);
      if (score > bestScore) { bestScore = score; bestRule = { ruleId, ...c }; }
    }

    const c20 = agg.exitRules?.['fixed-20d']?.targets?.['1pct'];
    const trades = c20?.trades ?? 0;

    if (trades < 5) {
      lines.push(`\n${entryId.padEnd(10)} ${entryDef?.label ?? entryId}`);
      lines.push(`  樣本不足（${trades} 次觸發）`);
      continue;
    }

    lines.push(`\n${entryId.padEnd(10)} ${entryDef?.label ?? entryId}`);
    lines.push(`  60天甜蜜點: ${sweet60Pct}  樣本: ${trades}次`);
    if (c20) {
      lines.push(`  固定20天:  勝率${(c20.winRate*100).toFixed(0)}%  報酬${(c20.avgReturn*100).toFixed(1)}%`);
    }
    if (bestRule && bestRule.ruleId !== 'fixed-20d') {
      const ruleDef = exitRules.find(r => r.id === bestRule.ruleId);
      const holdDays = bestRule.avgHoldDays != null ? `  持有${bestRule.avgHoldDays.toFixed(1)}天` : '';
      lines.push(`  最佳出場:  ${ruleDef?.label ?? bestRule.ruleId}  勝率${(bestRule.winRate*100).toFixed(0)}%  報酬${(bestRule.avgReturn*100).toFixed(1)}%${holdDays}`);
    }

    // S40 出場命中率（S40 在持有期間內實際出現的比例）
    const cS40 = agg.exitRules?.['s40-exit']?.targets?.['1pct'];
    if (cS40 && cS40.trades >= 5) {
      // 從 exitReasonCounts 算出 S40 實際觸發次數
      const s40Reasons = agg.exitRules?.['s40-exit']?.exitReasonCounts ?? {};
      const s40Hit  = s40Reasons['S40 紅三兵出現（主力倒貨）'] ?? 0;
      const s40Miss = cS40.trades - s40Hit;
      const hitRate = (s40Hit / cS40.trades * 100).toFixed(0);
      lines.push(`  S40命中率: ${hitRate}%（${s40Hit}/${cS40.trades}次出現，${s40Miss}次未出現到期）`);
    }

    // E7 分批出場固定顯示（不管是不是最佳，單獨列出供比較）
    const cE7 = agg.exitRules?.['s40-half-ma20']?.targets?.['1pct'];
    if (cE7 && cE7.trades >= 5) {
      const holdE7 = cE7.avgHoldDays != null ? `  持有${cE7.avgHoldDays.toFixed(1)}天` : '';
      lines.push(`  分批出場:  S40出50%+MA20出50%  勝率${(cE7.winRate*100).toFixed(0)}%  報酬${(cE7.avgReturn*100).toFixed(1)}%${holdE7}`);
    }
  }

  // 前兆分析
  if (precursor?.totalTrades > 0) {
    lines.push('');
    lines.push('─'.repeat(52));
    lines.push(`🔬 妖股出場前兆分析（${precursor.totalTrades} 筆 X2 + 跌破MA20 交易）`);
    lines.push('');
    lines.push('訊號           前1天  前3天  前5天  前10天  平均領先');
    lines.push('─'.repeat(52));

    for (const p of precursor.ranked) {
      const label = (p.isAbsence ? p.name : p.name).padEnd(16);
      const h1  = String(p.hitRates[1]).padStart(5);
      const h3  = String(p.hitRates[3]).padStart(5);
      const h5  = String(p.hitRates[5]).padStart(5);
      const h10 = String(p.hitRates[10]).padStart(6);
      const lead = p.avgLeadDays ? p.avgLeadDays + '天' : '—';
      lines.push(`${label}${h1}  ${h3}  ${h5}  ${h10}  ${lead}`);
    }

    // 結論
    const top = precursor.ranked[0];
    if (top && parseFloat(top.hitRates[3]) >= 60) {
      lines.push('');
      lines.push(`✅ 最可靠前兆: ${top.name}`);
      lines.push(`   出場前3天命中率 ${top.hitRates[3]}，平均領先 ${top.avgLeadDays ?? '?'} 天`);
    }
  }

  lines.push('');
  lines.push('─'.repeat(52));
  lines.push('⚠️  注意: 回測結果僅供參考，實際市況可能不同');
  lines.push('   樣本數 < 20 次者結論可信度較低');

  return lines.join('\n');
}

