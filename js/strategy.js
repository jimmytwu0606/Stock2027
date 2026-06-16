/**
 * strategy.js — 策略庫（Phase 6）
 *
 * conditions 裡的 condId 直接對應 screener.js CONDITION_DEFS 的 id。
 * value 只對有數值的條件填，boolean 條件不需要（用 def.default）。
 */

// ─────────────────────────────────────────────
// 策略邏輯版號 (v2.5 新增)
// ─────────────────────────────────────────────
// 用途:IndexedDB 的 signals_cache 寫入時帶上此版號,讀回時驗證,
//      版號不符 = 舊 calc 算出的結果,直接視為失效並丟棄重掃。
//
// ⚠️ 何時要升版號(自我提醒):
//   ✅ 新增/移除策略 (STRATEGIES 陣列改動)
//   ✅ 修改任何 screener.js 的 condition calc 函式
//   ✅ 修改 condition 的 match 邏輯或預設值
//   ✅ signal-scan.js 的 MUTEX_RULES / ABSORPTION_RULES 變動
//   ✅ matchSignals 流程變動
//   ❌ 純註解 / 重構 / icon / 文案描述變動 → 不升
//
// 升版號的副作用:所有使用者下次開 app 自動清快取重掃(無痛)
// ─────────────────────────────────────────────
export const STRATEGY_VERSION = 16;  // v2.9.5 — T-1 RS Rating 三 cond（rs_strong/rs_elite/rs_line_high）

export const STRATEGIES = [
  // ══════════════════════════════════════════
  // 強勢續漲類
  // ══════════════════════════════════════════
  {
    id: 'S1', tier: 'pro', icon: '🚀', name: '量價齊揚', category: '強勢續漲',
    desc: '放量上漲且站上月線，趨勢啟動訊號',
    conditions: [
      { condId: 'chg_min',  value: 2    },
      { condId: 'vol_min',  value: 1000 },
      { condId: 'above_ma20'            },
    ],
  },
  {
    id: 'S2', tier: 'free', icon: '📈', name: '均線啟動', category: '強勢續漲',
    desc: '短均線上穿月線，趨勢由弱轉強',
    conditions: [
      { condId: 'ma5_cross_ma20'      },
      { condId: 'vol_min', value: 500 },
    ],
  },
  {
    id: 'S3', tier: 'pro', icon: '⚡', name: '四線全過', category: '強勢續漲',
    desc: '股價站上月線，KD 與 RSI 同步強勢，多頭確立',
    conditions: [
      { condId: 'above_ma20'           },
      { condId: 'rsi_min',  value: 50  },
      { condId: 'kd_k_min', value: 50  },
    ],
  },
  {
    id: 'S_STRONG', tier: 'free', icon: '💪', name: '強勢不回', category: '強勢續漲',
    desc: 'RSI 強勢區間、站上月線且未跌，趨勢延續',
    conditions: [
      { condId: 'rsi_min', value: 60 },
      { condId: 'above_ma20'         },
      { condId: 'chg_min', value: 0  },
    ],
  },
  {
    id: 'S4', tier: 'free', icon: '🏔️', name: '近期創高', category: '強勢續漲',
    desc: '收盤價為近20日新高，突破壓力帶訊號',
    conditions: [
      { condId: 'high_n_days', value: 20 },   // 近20日最高
      { condId: 'vol_min',     value: 500 },  // 需要一定量能確認
    ],
  },
  {
    id: 'S5', tier: 'free', icon: '💥', name: '爆量異動', category: '強勢續漲',
    desc: '今日成交量為近20日均量3倍以上，主力異常介入',
    conditions: [
      { condId: 'vol_surge', value: 3 },      // 均量3倍
      { condId: 'chg_min',   value: 0 },      // 且未跌（異常量搭配上漲或平盤）
    ],
  },
  {
    // S46 口袋支點（Pocket Pivot，O'Neil/Kacher）— v2.9.4 實驗導入
    // 定義：今日量 > 近 10 日所有「下跌日」的量，且當日上漲
    //       = 機構買盤足跡（吃掉近期全部賣壓量），通常出現在底部整理或上升趨勢回檔末端
    // 性質：實驗中，尚未進入 _SCORABLE_IDS（不影響五燈獎）
    // ⚠️ 升級條件（同 X 系列規格）：exit-backtest 60 天甜蜜點 ≥ +30%、觸發 ≥ 20 次、跨多空年穩定
    // ⚠️ 台股注意：小型股主力騙量常見，建議搭配健康分數過濾使用
    id: 'S46', tier: 'pro', icon: '🪤', name: '口袋支點', category: '強勢續漲',
    desc: '今日量吃掉近10日全部下跌日量能且收漲，機構買盤足跡',
    conditions: [
      { condId: 'pocket_pivot'        },   // 核心：量 > 近10日下跌日最大量 + 當日漲
      { condId: 'above_ma20'          },   // 品質過濾：站上月線（避開破底搶反彈的假訊號）
      { condId: 'vol_min', value: 500 },   // 流動性下限（張）
    ],
  },

  // ══════════════════════════════════════════
  // 超跌反彈類
  // ══════════════════════════════════════════
  {
    id: 'S6', tier: 'free', icon: '🔄', name: '超賣反彈', category: '超跌反彈',
    desc: 'RSI 極低後出現正報酬，短線反彈機率高',
    conditions: [
      { condId: 'rsi_max', value: 30  },
      { condId: 'chg_min', value: 0   },
      { condId: 'vol_min', value: 300 },
    ],
  },
  {
    id: 'S7', tier: 'free', icon: '💚', name: '低檔翻多', category: '超跌反彈',
    desc: 'KD 低檔黃金交叉，底部翻轉訊號',
    conditions: [
      { condId: 'kd_golden'            },
      { condId: 'kd_k_max', value: 30 },
      { condId: 'vol_min',  value: 300 },
    ],
  },
  {
    id: 'S8', tier: 'pro', icon: '🎯', name: '雙低共振', category: '超跌反彈',
    desc: 'RSI 與 KD 同時低檔翻多，訊號加倍確認',
    conditions: [
      { condId: 'rsi_max',  value: 35 },
      { condId: 'kd_golden'           },
    ],
  },
  {
    id: 'S9', tier: 'free', icon: '📉', name: '跌深量縮', category: '超跌反彈',
    desc: '近3日跌幅超過3%且成交量萎縮，籌碼洗盤後等待反彈',
    conditions: [
      { condId: 'drop_n_days', value: -3  },  // 近3日累跌 ≥ 3%
      { condId: 'vol_shrink',  value: 0.7 },  // 成交量縮至均量70%以下
      { condId: 'rsi_max',     value: 40  },  // RSI 偏低，確認超跌
    ],
  },

  // ══════════════════════════════════════════
  // 轉折訊號類
  // ══════════════════════════════════════════
  {
    id: 'S10', tier: 'pro', icon: '⚙️', name: '動能翻正', category: '轉折訊號',
    desc: 'MACD 黃金交叉且柱狀翻正，動能由空轉多',
    conditions: [
      { condId: 'macd_golden'   },
      { condId: 'macd_hist_pos' },
      { condId: 'above_ma20'    },
    ],
  },
  {
    id: 'S11', tier: 'pro', icon: '🏹', name: '三箭齊發', category: '轉折訊號',
    desc: 'KD + MACD 雙黃金交叉並站上月線，強力買點',
    conditions: [
      { condId: 'kd_golden'   },
      { condId: 'macd_golden' },
      { condId: 'above_ma20'  },
    ],
  },
  {
    id: 'S12', tier: 'free', icon: '🏔️', name: '量增底部', category: '轉折訊號',
    desc: '放量止跌，RSI 未過熱，底部蓄積動能',
    conditions: [
      { condId: 'vol_min', value: 500 },
      { condId: 'chg_min', value: -1  },
      { condId: 'rsi_max', value: 50  },
    ],
  },

  // ══════════════════════════════════════════
  // 葛蘭碧八法（第二批新增）
  // ══════════════════════════════════════════
  {
    id: 'S20', tier: 'free', icon: '①', name: '葛蘭碧買一', category: '葛蘭碧',
    desc: 'MA20 由跌轉揚，股價從下方突破 MA20，趨勢反轉買進',
    conditions: [
      { condId: 'ma20_turn_up'        },   // MA20 由跌轉平/上揚
      { condId: 'price_cross_ma20_up' },   // 股價今日突破 MA20
    ],
  },
  {
    id: 'S21', tier: 'pro', icon: '②', name: '葛蘭碧買二', category: '葛蘭碧',
    desc: '股價在 MA20 上方回踩後反彈，趨勢延續買進',
    conditions: [
      { condId: 'above_ma20'         },    // 目前仍在 MA20 上方
      { condId: 'price_bounce_ma20'  },    // 昨日觸碰 MA20，今日收回
      { condId: 'vol_min', value: 300 },
    ],
  },
  {
    id: 'S22', tier: 'pro', icon: '③', name: '葛蘭碧買三', category: '葛蘭碧',
    desc: '上升趨勢中短暫跌破 MA20 後快速收回，假跌破買進',
    conditions: [
      { condId: 'price_reclaim_ma20' },    // 昨日跌破，今日收回，MA20 仍向上
      { condId: 'vol_min', value: 300 },
    ],
  },
  {
    id: 'S23', tier: 'pro', icon: '④', name: '葛蘭碧買四', category: '葛蘭碧',
    desc: '股價嚴重偏離 MA20（乖離 ≤ -10%），超跌強力反彈訊號',
    conditions: [
      { condId: 'price_far_below_ma20', value: -10 }, // 乖離率 ≤ -10%
      { condId: 'chg_min',              value: 0   }, // 今日未繼續跌（止跌訊號）
      { condId: 'vol_min',              value: 300 },
    ],
  },

  // ── 葛蘭碧強化版（XG 組合拳，實證通過）─────────────────────────────
  // XG1：葛蘭碧買一 + DMI 趨勢確認
  //   實證：MC exit-backtest 9檔妖股 basket，勝率提升 +30%
  //   vs S20 原始版（20%勝率/-0.9%均報）→ 強化版（50%勝率/+3.8%均報）
  // XG3：葛蘭碧買三 + 量價齊揚
  //   實證：勝率提升 +18%（31.6%→50%），均報 +0.7%
  {
    id: 'XG1', tier: 'pro', icon: '①⚡', name: '葛蘭碧買一強化', category: '葛蘭碧',
    desc: 'MA20 翻揚突破 + DMI趨勢確認（ADX>20），過濾假穿越。實證勝率50%/均報+3.8%',
    conditions: [
      { condId: 'ma20_turn_up'        },   // MA20 由跌轉平/上揚
      { condId: 'price_cross_ma20_up' },   // 股價今日突破 MA20
      { condId: 'dmi_bull'            },   // +DI > -DI 且 ADX > 20（趨勢強度確認）
    ],
  },
  {
    id: 'XG3', tier: 'pro', icon: '③⚡', name: '葛蘭碧買三強化', category: '葛蘭碧',
    desc: '上升趨勢假跌破後快速收回 + 量價齊揚確認。實證勝率50%/均報+0.2%',
    conditions: [
      { condId: 'price_reclaim_ma20'  },   // 昨日跌破，今日收回，MA20 仍向上
      { condId: 'vol_surge_short', value: 1.2 }, // 量能確認（10日均量×1.2）
      { condId: 'chg_min',         value: 0   }, // 今日收正（強勢收復）
    ],
  },

  // ══════════════════════════════════════════
  // 盤整突破類（布林通道，第三批新增）
  // ══════════════════════════════════════════
  {
    id: 'S13', tier: 'free', icon: '📦', name: '箱型突破', category: '盤整突破',
    desc: '布林帶先窄縮後開口放大且放量，盤整後的方向性突破',
    conditions: [
      { condId: 'bb_squeeze',   value: 20  }, // 帶寬處於近期最窄 20% 分位（曾窄縮）
      { condId: 'bb_expanding'             }, // 今日起放大
      { condId: 'vol_surge',    value: 1.5 }, // 放量確認（均量 1.5 倍以上）
      { condId: 'chg_min',      value: 1   }, // 上漲方向突破
    ],
  },
  {
    id: 'S14', tier: 'pro', icon: '🔝', name: '強勢鈍化', category: '盤整突破',
    desc: 'KD 高檔且股價持續貼布林上軌，強勢鈍化延伸段',
    conditions: [
      { condId: 'kd_k_min',      value: 80 }, // KD 高檔鈍化（K ≥ 80）
      { condId: 'bb_upper_touch', value: 2  }, // 收盤在布林上軌 2% 以內
      { condId: 'above_ma20'               }, // 確認在月線上方
    ],
  },
  {
    id: 'S15', tier: 'free', icon: '🌀', name: '整理待發', category: '盤整突破',
    desc: '布林帶極度糾結且量能萎縮，蓄勢待發等待方向選擇',
    conditions: [
      { condId: 'bb_squeeze',  value: 15  }, // 帶寬處於近期最窄 15% 分位
      { condId: 'vol_shrink',  value: 0.6 }, // 量縮至均量 60% 以下
    ],
  },

  // ── 基本面輔助類（Phase C，需 FinMind Token）─────────────────────────────
  // ══════════════════════════════════════════
  // 基本面 / 巴菲特類（S16~S19、S24~S27）— v2.9.4 移除
  // ──────────────────────────────────────────
  // 移除原因：全部條件為 phase 3（FinMind 基本面），實務上不可用：
  //   1. 無 Token → phase 3 整批跳過 → 策略退化成「全市場都過」（1873/1928 假命中）
  //   2. 免費 Token → FinMind 擋 TaiwanStockMonthRevenue / FinancialStatements
  //      批次 dataset，全市場掃描必然失敗
  //   3. S19 的 condId 'eps_turn_positive' 根本不存在於 screener.js
  // 復原條件：FinMind 包月（批次 dataset 解鎖）後從 git 歷史取回，
  //   並補齊 eps_turn_positive condition 定義
  // ══════════════════════════════════════════

  // ══════════════════════════════════════════
  // 避險警示類（賣出/減碼參考，綠色燈號）
  // ══════════════════════════════════════════
  // ── Advanced 5 — 技術指標策略 (S29–S36) ───
  // ══════════════════════════════════════════

  {
    id: 'S29', tier: 'pro', icon: '🥷', name: '低波動潛伏', category: '技術指標',
    desc: '歷史波動率低，乖離率超跌，等待爆發啟動。隔日衝低風險進場型',
    conditions: [
      { condId: 'hv_low',    value: 25 },   // HV < 25%（年化低波動）
      { condId: 'bias20_low', value: -5 },   // 乖離率 < -5%（適度超跌）
    ],
  },
  {
    id: 'S30', tier: 'pro', icon: '🌀', name: 'PSY超賣反彈', category: '技術指標',
    desc: 'PSY心理線極度超賣，RSI進入弱勢區，量能萎縮，短線反彈候選',
    conditions: [
      { condId: 'psy_oversold' },           // PSY(12) < 25
      { condId: 'rsi_max', value: 40 },     // RSI < 40
      { condId: 'vol_shrink' },             // 量縮
    ],
  },
  {
    id: 'S31', tier: 'pro', icon: '⚡', name: 'DMI趨勢確認', category: '技術指標',
    desc: '+DI > -DI 且 ADX > 25，趨勢明確多頭。ADX 過濾盤整假訊號，追強用',
    conditions: [
      { condId: 'dmi_bull' },               // +DI > -DI 且 ADX > 20
      { condId: 'dmi_strong' },             // ADX > 25（強趨勢確認）
      { condId: 'above_ma20' },             // 站上 MA20
    ],
  },
  {
    id: 'S32', tier: 'pro', icon: '🔄', name: 'SAR翻多', category: '技術指標',
    desc: '拋物線 SAR 由空翻多，MACD 柱由負翻正，雙重轉折確認。隔日衝最佳進場訊號',
    conditions: [
      { condId: 'sar_bull' },               // SAR 翻到股價下方
      { condId: 'macd_hist_pos' },          // MACD 柱由負轉正
    ],
  },
  {
    id: 'S33', tier: 'pro', icon: '🐉', name: 'GMMA多頭排列', category: '技術指標',
    desc: '顧比均線短期組（6條EMA）全部穿越長期組（6條EMA）往上，中長期趨勢確立',
    conditions: [
      { condId: 'gmma_bull' },              // 短期組全 > 長期組
      { condId: 'above_ma20' },
    ],
  },
  {
    id: 'S34', tier: 'pro', icon: '🎯', name: 'RCI短線買進', category: '技術指標',
    desc: 'RCI(9)從 -80 以下極值翻轉向上，量能放大確認，短線訊號精準',
    conditions: [
      { condId: 'rci9_turn_up' },           // RCI 從 -80 翻轉向上
      { condId: 'vol_surge', value: 1.3 },  // 量能放大 1.3x
    ],
  },
  {
    id: 'S35', tier: 'pro', icon: '📉', name: '乖離超跌', category: '技術指標',
    desc: 'MA20 乖離率大幅超跌，RSI < 30，量縮止跌，三重確認反彈力道強',
    conditions: [
      { condId: 'bias20_low', value: -10 }, // 乖離率 < -10%（嚴重超跌）
      { condId: 'rsi_max', value: 35 },     // RSI < 35
      { condId: 'vol_shrink' },             // 量縮止跌
    ],
  },
  {
    id: 'S36', tier: 'pro', icon: '🚀', name: 'EMA均線啟動', category: '技術指標',
    desc: 'EMA5 新穿越 EMA20，ADX > 20 確認非盤整假穿越，動能起漲訊號',
    conditions: [
      { condId: 'ema_cross_up' },           // EMA5 新穿越 EMA20
      { condId: 'dmi_bull' },               // ADX > 20，過濾盤整
    ],
  },

  // ══════════════════════════════════════════
  // ── C1 — Ichimoku 一目均衡表策略 (S_ICHI_*) ──
  // 經典日本長線指標，雲帶 + 五條線綜合判斷
  // ══════════════════════════════════════════

  {
    id: 'S_ICHI_3GOOD', tier: 'free', icon: '☁️', name: '三役好轉', category: '技術指標',
    desc: '一目均衡表三役好轉：轉換線>基準線、收盤站上雲帶、延遲線突破26日前價。最強多頭訊號',
    conditions: [
      { condId: 'ichi_3good' },             // 一條件就含所有三役判定
    ],
  },
  {
    id: 'S_ICHI_CLOUD', tier: 'free', icon: '🌥️', name: '雲帶上行', category: '技術指標',
    desc: '收盤站上雲帶上緣，趨勢進入多頭區。未來雲帶為多頭雲時加倍可信',
    conditions: [
      { condId: 'ichi_cloud_above' },       // 收盤 > 雲帶上緣
      { condId: 'ichi_bull_cloud' },        // 未來 26 日雲帶為多頭
    ],
  },
  {
    id: 'S_ICHI_TK_CROSS', tier: 'free', icon: '⚡', name: 'TK 黃金交叉', category: '技術指標',
    desc: '轉換線剛由下往上穿越基準線（近3日內）+ 延遲線突破26日前價，短期啟動訊號',
    conditions: [
      { condId: 'ichi_tk_cross' },          // 近3日內 Tenkan 上穿 Kijun
      { condId: 'ichi_chikou_above' },      // 延遲線突破歷史價
    ],
  },

  // ══════════════════════════════════════════
  // ── Advanced 5 — K線型態策略 (S37–S45) ───
  // 保留準度高的5種，移除誤判率高的型態
  // ══════════════════════════════════════════

  {
    id: 'S40', tier: 'free', icon: '🪖', name: '紅三兵', category: 'K線型態',
    desc: '連續3根陽線，每根收盤遞增，強勢延續訊號。條件嚴格、辨識明確',
    conditions: [
      { condId: 'three_soldiers' },
    ],
  },
  {
    id: 'S42', tier: 'pro', icon: '🫶', name: '多頭吞噬', category: 'K線型態',
    desc: '第二根陽線完全吞噬前一根陰線，最可靠的2根K線反轉訊號',
    conditions: [
      { condId: 'bullish_engulfing' },
    ],
  },
  {
    id: 'S38', tier: 'pro', icon: '🏔️', name: '三重底（三川）', category: 'K線型態',
    desc: '出現三個相近低點，第三底量縮，底部反轉訊號，配合量能確認誤判少',
    conditions: [
      { condId: 'three_valleys' },
      { condId: 'vol_shrink' },
    ],
  },
  {
    id: 'S37', tier: 'pro', icon: '⛰️', name: '三重頂（三山）', category: 'K線型態',
    desc: '出現三個相近高點並量縮，頂部反轉訊號，辨識條件明確',
    conditions: [
      { condId: 'three_peaks' },
      { condId: 'vol_shrink' },
    ],
  },
  {
    id: 'S45', tier: 'free', icon: '☕', name: '杯柄突破', category: 'K線型態',
    desc: 'U型整理後帶量突破，杯深<35%、柄部量縮、突破量放。中長線最可靠突破型態',
    conditions: [
      { condId: 'cup_and_handle' },
      { condId: 'vol_surge', value: 1.5 },
    ],
  },

  // ══════════════════════════════════════════

  // ── 趨勢轉弱 ──────────────────────────────
  {
    id: 'W1', tier: 'free', icon: '🔻', name: '跌破月線', category: '避險警示',
    desc: '收盤跌破 MA20，趨勢轉弱，考慮減碼或停損',
    conditions: [
      { condId: 'below_ma20' },
    ],
  },
  {
    id: 'W2', tier: 'pro', icon: '☠️', name: 'KD＋MACD 雙死叉', category: '避險警示',
    desc: 'KD 與 MACD 同時出現死亡交叉，多空力道快速轉換',
    conditions: [
      { condId: 'kd_dead'   },
      { condId: 'macd_dead' },
    ],
  },
  {
    id: 'W3', tier: 'pro', icon: '📉', name: 'MACD 死叉跌破月線', category: '避險警示',
    desc: 'MACD 死叉且股價跌破月線，中期趨勢確認轉弱',
    conditions: [
      { condId: 'macd_dead'  },
      { condId: 'below_ma20' },
    ],
  },
  {
    id: 'W4', tier: 'pro', icon: '💧', name: '量縮跌破月線', category: '避險警示',
    desc: '跌破月線且成交量萎縮，賣壓主導，反彈無力',
    conditions: [
      { condId: 'below_ma20' },
      { condId: 'vol_shrink' },
    ],
  },
  {
    id: 'W5', tier: 'free', icon: '🌊', name: '急跌訊號', category: '避險警示',
    desc: '近3日累跌超過 5%，短期賣壓沉重',
    conditions: [
      { condId: 'drop_n_days', value: -5 },
    ],
  },

  // ── 超買警示 ──────────────────────────────
  {
    id: 'W6', tier: 'free', icon: '🔥', name: 'RSI 超買', category: '避險警示',
    desc: 'RSI > 80，股價短期漲幅過大，注意拉回風險',
    conditions: [
      { condId: 'rsi_min', value: 80 },
    ],
  },
  {
    id: 'W7', tier: 'pro', icon: '🎯', name: '布林上軌超買', category: '避險警示',
    desc: '股價貼近布林上軌且帶寬放大，且 RSI > 85 極度過熱，注意回落',
    conditions: [
      { condId: 'bb_upper_touch', value: 1 },
      { condId: 'bb_expanding'             },
      { condId: 'rsi_min',        value: 85 },  // v2.8 加門檻：RSI > 85 才算真正過熱
      // ⚠️ 永久備忘(2026-05-25 修正):
      //   原版 W7 條件只有 bb_upper_touch + bb_expanding
      //   導致飆股主升段（X2 天黑請閉眼）必然同時觸發 W7
      //   產生「多頭訊號多卻只有 2 燈」的假警告
      //   加 RSI > 85 後：主升段初期(RSI 70-84)不再被 W7 扣燈
      //   RSI 85+ 才是真正過熱需要警戒的區間
    ],
  },
  {
    id: 'W8', tier: 'pro', icon: '⚡', name: 'RSI 超買跌破月線', category: '避險警示',
    desc: 'RSI 曾在高位後股價跌破月線，高點確認，建議減碼',
    conditions: [
      { condId: 'rsi_min',   value: 70 },
      { condId: 'below_ma20'           },
    ],
  },

  // ── 趨勢疲弱 ──────────────────────────────
  {
    id: 'W9', tier: 'pro', icon: '🧊', name: 'KD 死叉月線下', category: '避險警示',
    desc: 'KD 死叉且位於月線以下，短期動能持續轉弱',
    conditions: [
      { condId: 'kd_dead'    },
      { condId: 'below_ma20' },
    ],
  },
  {
    id: 'W10', tier: 'pro', icon: '🕳️', name: '三重弱勢', category: '避險警示',
    desc: 'KD死叉 + MACD死叉 + 跌破月線，趨勢全面轉弱，高度警示',
    conditions: [
      { condId: 'kd_dead'    },
      { condId: 'macd_dead'  },
      { condId: 'below_ma20' },
    ],
  },

  // ══════════════════════════════════════════
  // 避險警示類 — W11~W20（BEARISH_COMPLETE 0522_2340）
  // 補足做多/避險不對稱的缺口：一目空頭、均線空排、量增價跌、葛蘭碧賣出系列、DMI 空頭
  // ══════════════════════════════════════════
  {
    id: 'W11', tier: 'pro', icon: '☁️', name: '一目雲層跌破', category: '避險警示',
    desc: '收盤跌破雲層下緣，最強中長線空頭確認',
    conditions: [
      { condId: 'ichi_below_cloud' },
    ],
  },
  {
    id: 'W12', tier: 'pro', icon: '🪨', name: '均線空頭排列', category: '避險警示',
    desc: 'MA5<MA10<MA20 且三線皆下彎，四線空頭全下',
    conditions: [
      { condId: 'ma_bear_array' },
    ],
  },
  {
    id: 'W13', tier: 'pro', icon: '🩸', name: '量增價跌', category: '避險警示',
    desc: '放量 ≥ 1.5×MV20 且跌 ≥ 2%，主力出貨訊號',
    conditions: [
      { condId: 'vol_surge_drop', value: -2 },
    ],
  },
  {
    id: 'W14', tier: 'pro', icon: '⛈️', name: 'MACD 高位死叉', category: '避險警示',
    desc: 'DIF > 0 時死叉，比零軸下死叉更危險（飆漲後轉折）',
    conditions: [
      { condId: 'macd_dead_above_zero' },
    ],
  },
  {
    id: 'W15', tier: 'pro', icon: '②', name: '葛蘭碧賣二', category: '避險警示',
    desc: '月線下反彈觸線後再下跌，反彈失敗確認',
    conditions: [
      { condId: 'below_ma20'           },
      { condId: 'price_rally_fail_ma20' },
    ],
  },
  {
    id: 'W16', tier: 'pro', icon: '🌫️', name: '一目轉換跌破基準', category: '避險警示',
    desc: 'Tenkan < Kijun，一目均衡早期轉弱預警',
    conditions: [
      { condId: 'ichi_tk_dead' },
    ],
  },
  {
    id: 'W17', tier: 'pro', icon: '⚔️', name: 'DMI 空頭確認', category: '避險警示',
    desc: '-DI > +DI 且 ADX ≥ 25，趨勢明確空頭',
    conditions: [
      { condId: 'dmi_bear' },
    ],
  },
  {
    id: 'W18', tier: 'pro', icon: '①', name: '葛蘭碧賣一', category: '避險警示',
    desc: 'MA20 由揚轉跌 + 股價跌破 MA20，趨勢反轉賣出',
    conditions: [
      { condId: 'ma20_turn_down'        },
      { condId: 'price_cross_ma20_down' },
    ],
  },
  {
    id: 'W19', tier: 'pro', icon: '③', name: '葛蘭碧賣三', category: '避險警示',
    desc: '月線下短暫超漲後回落 + MA20 下彎，超漲修正',
    conditions: [
      { condId: 'below_ma20'          },
      { condId: 'price_far_above_ma20', value: 5 },
      { condId: 'ma20_declining',       value: 3 },
    ],
  },
  {
    id: 'W20', tier: 'pro', icon: '④', name: '葛蘭碧賣四', category: '避險警示',
    desc: '月線上乖離過大 + 月線下彎，過熱反轉',
    conditions: [
      { condId: 'price_far_above_ma20', value: 10 },
      { condId: 'ma20_declining',       value: 3  },
    ],
  },

  // ══════════════════════════════════════════
  // X 系列 — 獨家實驗策略(v2.7 新增)
  // ──────────────────────────────────────────
  // 設計依據:ROADMAP_ADVANCED5_0524_0149.md 階段 7 「策略生成藍圖」
  // 性質:實驗中,尚未進入 _SCORABLE_IDS(不影響五燈獎)
  // 用途:篩選器 + exit-backtest 實證驗證
  //
  // 設計光譜:
  //   X1 黃金比例    — 最穩(三軸過濾,動能+量能+趨勢)
  //   X2 天黑請閉眼  — 最飆(已飆續飆,高 beta 賭報酬)
  //   X3 炒底王      — 抄底(超跌反彈,適合震盪/空頭年)
  //   X4 何時輪到我  — 跨股(同族群輪動補漲)
  //
  // ⚠️ 升級條件(從實驗區進入正式評分):
  //   1. exit-backtest 跑出 60 天甜蜜點 ≥ +30%
  //   2. 觸發次數 ≥ 20 次(樣本足夠)
  //   3. 跨多空頭年驗證(2026 多頭年 + 2022 空頭年)結果穩定
  // ══════════════════════════════════════════
  {
    id: 'X1', tier: 'pro', icon: '🪙', name: '黃金比例', category: 'X 系列',
    desc: '量能、動能、趨勢三軸共振 — 最穩進場',
    conditions: [
      { condId: 'rsi_min',          value: 60 },   // 動能:RSI 強勢
      { condId: 'vol_surge_short',  value: 2  },   // 量能:10日均量 × 2
      { condId: 'above_ma20'                  },   // 趨勢:站上月線
      { condId: 'ma20_rising',      value: 3  },   // 趨勢方向:MA20 連續 3 天上升
    ],
  },
  {
    id: 'X2', tier: 'pro', icon: '🌑', name: '天黑請閉眼', category: 'X 系列',
    desc: '飆股加速期介入,賭高 beta 報酬(需嚴格停損)',
    conditions: [
      { condId: 'gain_10d',         value: 15 },   // 10 日累計漲幅 ≥ 15%(已飆)
      { condId: 'vol_surge_long',   value: 3  },   // 30日均量 × 3(主力續攻)
      { condId: 'rsi_min',          value: 70 },   // RSI > 70(動能未頂背離)
    ],
  },
  {
    id: 'X3', tier: 'pro', icon: '🪂', name: '炒底王', category: 'X 系列',
    desc: 'V 型反轉確認:有實跌 + RSI 低位反彈 + 量增',
    conditions: [
      { condId: 'loss_5d',          value: 5  },   // 過去 5 日跌幅 ≥ 5%(真有跌)
      { condId: 'rsi_revival',      value: 35 },   // RSI 從<30 反彈 ≥ 35
      { condId: 'vol_surge_short',  value: 1.2 },  // 量 ≥ 10日均量 × 1.2(止跌量)
    ],
  },
  {
    id: 'X4', tier: 'pro', icon: '🚦', name: '何時輪到我', category: 'X 系列',
    desc: '同族群已啟動,本股還沒動 — 等待補漲',
    conditions: [
      { condId: 'industry_leading', value: 2  },   // 同族群 ≥ 2 檔 RSI > 70
      { condId: 'rsi_min',          value: 40 },   // 本股 RSI ≥ 40(下限)
      { condId: 'rsi_max',          value: 60 },   // 本股 RSI ≤ 60(尚未飆)
      { condId: 'vol_surge_short',  value: 1.5 },  // 今日量增 ≥ 10日均量 × 1.5
    ],
  },
  {
    // X5 v2.8 候選策略 — 潛龍勿用（早期介入型）
    // 核心差異：X2 用 30日均量×3，容易被前段大量拉高基期
    //           X5 用 10日均量×2.5，近期相對爆量，不受長期基期影響
    // 適合：低基期爆量型（麗正）/ 慢牛爆發型（微星）/ 主升段中繼早期（鴻名5/14）
    // 實證狀態：候選策略，未進 _SCORABLE_IDS，不影響五燈獎
    id: 'X5', tier: 'pro', icon: '🌊', name: '潛龍勿用', category: 'X 系列',
    desc: '主力悄悄爆量建倉，量先於價，比天黑請閉眼早 5-10 天介入',
    conditions: [
      { condId: 'vol_surge_short', value: 2.5 },  // 今日量 ≥ 10日均量×2.5（近期相對爆量）
      { condId: 'gain_10d',        value: 10  },  // 10日漲幅 ≥ 10%（確認趨勢）
      { condId: 'rsi_min',         value: 60  },  // RSI ≥ 60（動能啟動）
      { condId: 'above_ma20'               },  // 站上 MA20
      { condId: 'ma20_rising',     value: 2  },  // MA20 連2天上升（比X1寬鬆）
    ],
  },

  // ══════════════════════════════════════════
  // ══════════════════════════════════════════
  // X6 見龍在田（原 X8，v2.9.1 實證通過正式導入）
  // 實證：妖股 basket 9檔，勝率35.1%/均報+1.6%，兩輪穩定達標
  // 最佳搭配出場：X1消失出場（40.5%/+1.8%）或 X2消失出場（43.2%/+1.5%）
  // ══════════════════════════════════════════
  {
    id: 'X6', tier: 'pro', icon: '🐉', name: '見龍在田', category: 'X 系列',
    desc: '5日波動<3%盤整後今日放量向上突破，蓄勢完畢啟動。實證勝率35.1%/均報+1.6%',
    conditions: [
      { condId: 'tight_consolidation', value: 3 },  // 5日波動 < 3% 且今日放量突破
      { condId: 'above_ma20'                    },  // 站上 MA20
    ],
  },
];

// ══════════════════════════════════════════
// 進階指標進場策略（回測專用，經 customStrategies 注入組合回測，不參與即時信號燈/篩選）
// 條件對應 backtest-engine.js COND_LIB：weekly_bull / weinstein_stage / above_poc / supertrend_up
// ══════════════════════════════════════════
export const TA_ENTRY_STRATEGIES = [
  { id: 'TA_WK',  tier: 'pro', icon: '🔭', name: '週線多頭', category: '進階指標',
    desc: '週MA10之上且週線連走揚（順大勢）',
    conditions: [{ condId: 'weekly_bull' }] },
  { id: 'TA_ST2', tier: 'pro', icon: '🌀', name: 'Weinstein 上升期', category: '進階指標',
    desc: '30週線翻揚的 Stage 2 買進期',
    conditions: [{ condId: 'weinstein_stage', value: 2 }] },
  { id: 'TA_POC', tier: 'pro', icon: '📊', name: '站上 POC', category: '進階指標',
    desc: '站上近120日量價最密集價（主力成本帶）',
    conditions: [{ condId: 'above_poc' }] },
  { id: 'TA_SUP', tier: 'pro', icon: '🛡️', name: 'Supertrend 多頭', category: '進階指標',
    desc: 'Supertrend(10,3) 處於多頭趨勢',
    conditions: [{ condId: 'supertrend_up' }] },
  // 組合範例：順大勢 + 籌碼乾淨
  { id: 'TA_WK_POC', tier: 'pro', icon: '🎯', name: '週多頭＋站POC', category: '進階指標',
    desc: '週線多頭且站上POC，順勢且站穩主力成本帶',
    conditions: [{ condId: 'weekly_bull' }, { condId: 'above_poc' }] },
  { id: 'TA_ST2_SUP', tier: 'pro', icon: '🚀', name: 'Stage2＋Supertrend多', category: '進階指標',
    desc: 'Weinstein 上升期且 Supertrend 多頭，雙趨勢確認',
    conditions: [{ condId: 'weinstein_stage', value: 2 }, { condId: 'supertrend_up' }] },
];

const CATEGORY_COLOR = {
  '強勢續漲': { bg: 'rgba(38,166,154,0.12)',  border: 'rgba(38,166,154,0.35)',  text: '#26a69a' },
  '超跌反彈': { bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.35)',  text: '#3b82f6' },
  '轉折訊號': { bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.35)',  text: '#f59e0b' },
  '葛蘭碧':   { bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.35)', text: '#a78bfa' },
  '盤整突破': { bg: 'rgba(244,114,182,0.12)', border: 'rgba(244,114,182,0.35)', text: '#f472b6' },
  '基本面':   { bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.35)',   text: '#22c55e' },
  '巴菲特':   { bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)',  text: '#fbbf24' },
  '避險警示': { bg: 'rgba(38,166,154,0.12)',  border: 'rgba(38,166,154,0.35)',  text: '#26a69a' },
  'X 系列':   { bg: 'rgba(250,204,21,0.12)',  border: 'rgba(250,204,21,0.45)',  text: '#facc15' },  // 金色,實驗區
};

export function initStrategyPanel() {
  _renderPreFilter();
  _renderStrategyCards();
  _bindLeftTabs();
  _bindStrategyListEvents();
}

function _bindStrategyListEvents() {
  const list = document.getElementById('strategyList');
  if (!list) return;
  // 委派事件只綁一次，避免 _renderStrategyCards 重複呼叫時多次綁定
  list.addEventListener('click', (e) => {
    // 點卡片 → 套用策略
    const card = e.target.closest('.sc-strategy-card');
    if (card) { applyStrategy(card.dataset.strategyId); return; }

    // 點分類標題 → 折疊/展開
    const header = e.target.closest('.sc-strategy-cat-header');
    if (header) {
      const body    = header.nextElementSibling;   // .sc-strategy-cat-body
      const chevron = header.querySelector('.sc-strategy-cat-chevron');
      if (!body) return;
      const isOpen  = body.style.display !== 'none';
      body.style.display       = isOpen ? 'none' : '';
      chevron.textContent      = isOpen ? '▸' : '▾';
      header.dataset.collapsed = isOpen ? '1' : '';
    }
  });
}

/**
 * refreshStrategyCards()
 * auth 完成後重渲染策略卡片（tier 確認後補刷，避免 Pro 策略因時序問題不顯示）
 * 在 main.js 的 authReady 事件裡呼叫
 */
export function refreshStrategyCards() {
  const list = document.getElementById('strategyList');
  if (!list) return;
  // 清掉舊的策略分類卡片（保留搜尋列 + prefilter，不重複建）
  list.querySelectorAll('.sc-strategy-category').forEach(el => el.remove());
  _renderStrategyCards();
}

// ─── 預過濾欄位（股價區間 + 成交量）────────────────────────────────────────
function _renderPreFilter() {
  const list = document.getElementById('strategyList');
  if (!list) return;

  const filterHtml = `
  <div class="sc-prefilter">
    <div class="sc-prefilter-title">預先過濾（Phase A）</div>
    <div class="sc-prefilter-row">
      <div class="sc-prefilter-field">
        <label class="sc-prefilter-label">股價（元）</label>
        <div class="sc-prefilter-range">
          <input class="sc-prefilter-input" id="pfPriceMin" type="number" placeholder="10"   min="0" step="1" value="10" />
          <span class="sc-prefilter-sep">～</span>
          <input class="sc-prefilter-input" id="pfPriceMax" type="number" placeholder="9999" min="0" step="1" value="9999" />
        </div>
      </div>
      <div class="sc-prefilter-field">
        <label class="sc-prefilter-label">成交量 ≥（張）</label>
        <input class="sc-prefilter-input" id="pfVolMin" type="number" placeholder="0" min="0" step="100" value="0" style="width:100%" />
      </div>
    </div>
    <div class="sc-prefilter-hint">套用策略時自動加入以上條件。成交量填 0 = 不限（純技術策略建議填 0）</div>
  </div>`;

  list.insertAdjacentHTML('beforebegin', filterHtml);
}

function _getPreFilter() {
  const rawMax = parseFloat(document.getElementById('pfPriceMax')?.value);
  return {
    priceMin: parseFloat(document.getElementById('pfPriceMin')?.value) || 0,
    priceMax: (!isNaN(rawMax) && rawMax > 0) ? rawMax : 99999,
    volMin:   parseFloat(document.getElementById('pfVolMin')?.value)   || 0,
  };
}

function _renderStrategyCards() {
  const list = document.getElementById('strategyList');
  if (!list) return;

  // ── 搜尋列（只建一次）──────────────────────────────
  if (!document.getElementById('strategySearch')) {
    const searchWrap = document.createElement('div');
    searchWrap.className = 'sc-strategy-search-wrap';
    searchWrap.innerHTML = `
      <input
        id="strategySearch"
        class="sc-strategy-search"
        type="text"
        placeholder="搜尋策略名稱、描述或條件…"
        autocomplete="off"
      />
      <span class="sc-strategy-search-icon">🔍</span>`;
    list.insertAdjacentElement('beforebegin', searchWrap);

    document.getElementById('strategySearch')
      ?.addEventListener('input', (e) => _filterStrategies(e.target.value.trim()));
  }

  // ── 依 tier 過濾（只顯示使用者等級能用的策略）──────
  const TIER_ORDER = { guest: 0, free: 1, pro: 2, vvvip: 3 };
  const userLvl = TIER_ORDER[window.__userTier ?? 'free'] ?? 1;
  const visibleStrategies = STRATEGIES.filter(s =>
    (TIER_ORDER[s.tier ?? 'free'] ?? 1) <= userLvl
  );

  // ── 依分類分群渲染 ──────────────────────────────────
  const categories = {};
  for (const s of visibleStrategies) {
    if (!categories[s.category]) categories[s.category] = [];
    categories[s.category].push(s);
  }

  let html = '';
  for (const [cat, strategies] of Object.entries(categories)) {
    const col = CATEGORY_COLOR[cat] ?? {
      bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)', text: '#8a8f99',
    };
    // 分類標題（可折疊）
    html += `
    <div class="sc-strategy-category" data-cat="${cat}">
      <button class="sc-strategy-cat-header" data-cat="${cat}">
        <span class="sc-strategy-cat-label" style="color:${col.text}">${cat}</span>
        <span class="sc-strategy-cat-count" style="color:${col.text}">${strategies.length}</span>
        <span class="sc-strategy-cat-chevron">▾</span>
      </button>
      <div class="sc-strategy-cat-body">`;

    for (const s of strategies) {
      // 把條件 condId 串成關鍵字供搜尋用
      const condKeywords = s.conditions.map(c => c.condId).join(' ');
      html += `
        <button class="sc-strategy-card"
          data-strategy-id="${s.id}"
          data-search="${s.name} ${s.desc} ${cat} ${condKeywords}"
          style="border-color:${col.border}">
          <span class="sc-strategy-icon">${s.icon}</span>
          <div class="sc-strategy-info">
            <span class="sc-strategy-name">${s.name}</span>
            <span class="sc-strategy-desc">${s.desc}</span>
          </div>
          <span class="sc-strategy-badge" style="background:${col.bg};color:${col.text}">
            ${s.conditions.length} 個條件
          </span>
        </button>`;
    }
    html += `</div></div>`;
  }
  list.innerHTML = html;

}

// ── 關鍵字篩選（搜尋時用）──────────────────────────────
function _filterStrategies(keyword) {
  const list = document.getElementById('strategyList');
  if (!list) return;

  const kw = keyword.toLowerCase();

  // 先讓所有分類展開
  list.querySelectorAll('.sc-strategy-cat-body').forEach(b => {
    b.style.display = '';
  });
  list.querySelectorAll('.sc-strategy-cat-chevron').forEach(c => {
    c.textContent = '▾';
  });

  if (!kw) {
    // 無關鍵字：顯示全部
    list.querySelectorAll('.sc-strategy-card').forEach(c => c.style.display = '');
    list.querySelectorAll('.sc-strategy-category').forEach(g => g.style.display = '');
    return;
  }

  // 依關鍵字過濾卡片
  list.querySelectorAll('.sc-strategy-category').forEach(group => {
    let anyVisible = false;
    group.querySelectorAll('.sc-strategy-card').forEach(card => {
      const match = card.dataset.search?.toLowerCase().includes(kw);
      card.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    });
    // 分類下沒有符合的，整個分類隱藏
    group.style.display = anyVisible ? '' : 'none';
  });
}

// ─── 各 condId 需要的最低 K 線根數 ──────────────────────────────────────────
// 對應 screener.js 各 calc 函式的 if (n < X) return false 門檻
// 安全邊際：需求根數 × 1.3（避免假日/停牌/新股邊緣值）
const _COND_MIN_CANDLES = {
  ichi_3good:         68,  // 52 × 1.3 ≈ 68
  ichi_cloud_above:   68,
  ichi_bull_cloud:    68,
  ichi_below_cloud:   68,
  ichi_in_cloud:      68,
  ichi_tk_dead:       68,
  ichi_tk_cross:      40,
  ichi_chikou_above:  36,
  cup_and_handle:     80,  // 60 × 1.3 ≈ 80
  sar_bull:           42,  // 32 × 1.3
  dmi_bull:           40,
  dmi_strong:         40,
  dmi_bear:           40,
  gmma_bull:          70,  // GMMA 需要長期 EMA（最長 60 期）

  // X 系列新增條件最低根數
  vol_surge_short:    14,  // 近 10 日均量 → 至少 11 根,+3 緩衝
  vol_surge_long:     40,  // 近 30 日均量 → 至少 31 根,+9 緩衝
  gain_10d:           14,  // 過去 10 日比較 → 11 根 + 緩衝
  loss_5d:             8,  // 過去 5 日比較 → 6 根 + 緩衝
  rsi_revival:        25,  // RSI(14) + 過去 5 根判斷 → 20 根 + 緩衝
  ma20_rising:        25,  // MA20 + 連續 3 天比較 → 22 根 + 緩衝
  industry_leading:   20,  // 需要算自己的 RSI,跟 rsi_min 同等級
  // X6 見龍在田（tight_consolidation）所需最低根數
  tight_consolidation: 15, // 5日盤整 + 10日均量 + 緩衝
  // 保留以下（screener.js 仍有定義，其他功能可用）
  gap_up:              3,
  gap_open:           12,
  ema_bull_array:     28,
  vol_shrink_n:       15,
  break_recent_high:  15,
};

// 週期 → 預估交易日根數（台股一年約 248 日）
const _PERIOD_CANDLES = {
  '1mo': 22, '3mo': 65, '6mo': 130, '1y': 250,
};

// 根據策略條件自動計算需要的最低週期
function _requiredPeriodForStrategy(strategy) {
  let maxNeeded = 0;
  for (const cond of strategy.conditions) {
    const min = _COND_MIN_CANDLES[cond.condId] ?? 20;
    if (min > maxNeeded) maxNeeded = min;
  }
  // 找最小可滿足的週期
  for (const [period, candles] of Object.entries(_PERIOD_CANDLES)) {
    if (candles >= maxNeeded) return { period, minCandles: maxNeeded };
  }
  return { period: '1y', minCandles: maxNeeded };
}

/**
 * 根據指定的策略 ID 清單，計算訊號計算需要的最低 K 線週期
 * 若不傳 ids → 掃描全部策略（Phase 1+2 有效策略）
 *
 * @param {string[]} [strategyIds]  策略 ID 陣列；省略則掃全部
 * @returns {{ period: string, minCandles: number }}
 *   period    = '1mo' | '3mo' | '6mo' | '1y'
 *   minCandles = 對應週期的預估根數
 *
 * 使用範例（main.js）:
 *   import { getSignalPeriod } from './strategy.js';
 *   const { period } = getSignalPeriod();   // 全策略最高需求
 *   const candles = await fetchHistoryCached(symbol, period);
 *   renderStockSignals(candles, code);
 */
export function getSignalPeriod(strategyIds = null) {
  const targets = strategyIds
    ? STRATEGIES.filter(s => strategyIds.includes(s.id))
    : STRATEGIES.filter(s => {
        // 只考慮 Phase 1+2 策略（Phase 3 需要 FinMind，matchSignals 會跳過）
        return s.conditions.every(c => {
          // 找對應的 condId 最低需求，沒有的視為預設 20
          return true;  // 全部納入，由 _COND_MIN_CANDLES 決定需求
        });
      });

  let maxNeeded = 20;  // 預設最低需求（所有指標都能算的最低值）
  for (const strategy of targets) {
    for (const cond of strategy.conditions) {
      const min = _COND_MIN_CANDLES[cond.condId] ?? 20;
      if (min > maxNeeded) maxNeeded = min;
    }
  }

  // 找最小可滿足的週期
  for (const [period, candles] of Object.entries(_PERIOD_CANDLES)) {
    if (candles >= maxNeeded) return { period, minCandles: maxNeeded };
  }
  return { period: '1y', minCandles: maxNeeded };
}

export function applyStrategy(strategyId) {
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return;

  _switchToCustomTab();
  document.dispatchEvent(new CustomEvent('strategyClear'));

  // ── v2.6.2 自動週期升級 ──────────────────────────────────────────────────
  // 根據策略需要的最低 K 線根數,自動升級篩選週期
  // 例：Ichimoku 需要 68 根安全邊際 → 3mo(65根) 不夠 → 自動切到 6mo(130根)
  const { period: requiredPeriod, minCandles } = _requiredPeriodForStrategy(strategy);
  const periodEl = document.getElementById('screenerPeriod');
  const currentPeriod = periodEl?.value ?? '3mo';
  const currentCandles = _PERIOD_CANDLES[currentPeriod] ?? 65;

  if (_PERIOD_CANDLES[requiredPeriod] > currentCandles) {
    // 自動升級週期：改 select DOM 值 + 派發專屬事件讓外部同步 Config
    if (periodEl) periodEl.value = requiredPeriod;
    document.dispatchEvent(new CustomEvent('screenerPeriodUpgrade', {
      detail: { period: requiredPeriod, reason: `${strategy.name} 需 ≥ ${minCandles} 根 K 線` },
    }));
    document.dispatchEvent(new CustomEvent('showToast', {
      detail: `📅 已自動切換 K 線週期為「${requiredPeriod}」（${strategy.name} 需 ≥ ${minCandles} 根）`,
    }));
    console.log(`[strategy] 自動升級週期 ${currentPeriod} → ${requiredPeriod}（${strategy.name} 需 ≥ ${minCandles} 根）`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // 策略條件先加(screener-ui 的去重邏輯以「先到先得」為準)
  for (const cond of strategy.conditions) {
    document.dispatchEvent(new CustomEvent('screenerAddCondition', {
      detail: { condId: cond.condId, value: cond.value },
    }));
  }

  // 策略條件已包含的 condId 集合
  const strategyConds = new Set(strategy.conditions.map(c => c.condId));

  // 預過濾條件後加 — 若策略已有相同 condId,screener-ui 會自動去重(先到先得)
  // 此處雙重保護:strategy 有的不發,避免邊界情況
  const { priceMin, priceMax, volMin } = _getPreFilter();
  if (priceMin > 0     && !strategyConds.has('price_min')) document.dispatchEvent(new CustomEvent('screenerAddCondition', { detail: { condId: 'price_min', value: priceMin } }));
  if (priceMax < 99999 && !strategyConds.has('price_max')) document.dispatchEvent(new CustomEvent('screenerAddCondition', { detail: { condId: 'price_max', value: priceMax } }));
  if (volMin > 0       && !strategyConds.has('vol_min')  ) document.dispatchEvent(new CustomEvent('screenerAddCondition', { detail: { condId: 'vol_min',   value: volMin   } }));

  // 計算實際加入的條件數
  const preCount = (priceMin > 0     && !strategyConds.has('price_min') ? 1 : 0)
                 + (priceMax < 99999 && !strategyConds.has('price_max') ? 1 : 0)
                 + (volMin > 0       && !strategyConds.has('vol_min')   ? 1 : 0);
  const total = strategy.conditions.length + preCount;

  const strategyBanner = document.getElementById('strategyActiveBanner');
  if (strategyBanner) {
    // 組合實際套用的預過濾說明文字
    const preDesc = [];
    if (priceMin > 0     && !strategyConds.has('price_min')) preDesc.push(`股價≥${priceMin}元`);
    if (priceMax < 99999 && !strategyConds.has('price_max')) preDesc.push(`股價≤${priceMax}元`);
    if (volMin > 0       && !strategyConds.has('vol_min')  ) preDesc.push(`量≥${volMin}張`);
    const preText = preDesc.length ? `（預過濾：${preDesc.join('、')}）` : '';

    strategyBanner.style.display = '';
    strategyBanner.innerHTML =
      `<span class="strategy-banner-icon">${strategy.icon}</span>` +
      `<span class="strategy-banner-name">已套用「${strategy.name}」</span>` +
      `<span class="strategy-banner-desc">${strategy.desc}</span>` +
      (preText ? `<span class="strategy-banner-filter">${preText}</span>` : '') +
      `<button class="strategy-banner-clear" id="strategyBannerClear">✕ 清除</button>`;
    document.getElementById('strategyBannerClear')?.addEventListener('click', () => {
      strategyBanner.style.display = 'none';
      document.dispatchEvent(new CustomEvent('strategyClear'));
    });
  }

  const status = document.getElementById('screenerStatus');
  if (status) status.textContent = `已套用「${strategy.name}」— ${strategy.desc}（股價 ${priceMin}–${priceMax}元，量 ≥ ${volMin}張）`;

  document.dispatchEvent(new CustomEvent('showToast', {
    detail: `✓ 已套用「${strategy.name}」，共 ${total} 個條件（含預過濾）`,
  }));

  // 通知 screener-ui 記錄當前策略名稱（供結果列顯示）
  document.dispatchEvent(new CustomEvent('strategyApplied', {
    detail: { name: strategy.name, id: strategy.id },
  }));
}

function _bindLeftTabs() {
  const tabs = document.querySelectorAll('.sc-left-tab');
  if (!tabs.length) return;
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.leftTab;
      document.getElementById('scPanelCustom').style.display   = which === 'custom'   ? '' : 'none';
      document.getElementById('scPanelStrategy').style.display = which === 'strategy' ? '' : 'none';
    });
  });
}

function _switchToCustomTab() {
  document.querySelectorAll('.sc-left-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.sc-left-tab[data-left-tab="custom"]')?.classList.add('active');
  document.getElementById('scPanelCustom').style.display   = '';
  document.getElementById('scPanelStrategy').style.display = 'none';
}

// ─────────────────────────────────────────────
// 五燈獎：訊號強度計算
// ─────────────────────────────────────────────

// Phase 1+2 可比對的策略（排除 Phase 3）
const _SCORABLE_IDS = new Set([
  'S1','S2','S3','S_STRONG','S4','S5',
  'S6','S7','S8','S9',
  'S10','S11','S12',
  'S20','S21','S22','S23',
  'XG1','XG3',  // 葛蘭碧強化版（實證通過）
  'S13','S14','S15',
  'W1','W2','W3','W4','W5','W6','W7','W8','W9','W10',
  // W11~W20（避險強化，BEARISH_COMPLETE 0522_2340）
  'W11','W12','W13','W14','W15','W16','W17','W18','W19','W20',
  // Advanced 5 — 技術指標
  'S29','S30','S31','S32','S33','S34','S35','S36',
  // Advanced 5 — K線型態
  'S37','S38','S40','S42','S45',
  // X 系列 — 黃金獨家策略（v2.8 正式導入）
  'X1','X2',  // 三軸共振 / 天黑請閉眼
  'X5',       // 潛龍勿用（妖股先期版）
              // 實證：固定20天勝率65.5%/+19.4%，60天甜蜜點43.5%
              // X3/X4 尚未通過實證，暫不加入
  // X6 見龍在田（原 X8，v2.9.1 正式導入）
  'X6',
]);

// 避險訊號 ID 集合（用於分流計算燈號顏色與權重）
const _WARNING_IDS = new Set([
  'W1','W2','W3','W4','W5','W6','W7','W8','W9','W10',
  'W11','W12','W13','W14','W15','W16','W17','W18','W19','W20',
]);

// 各策略最高分數（用於 calcSignalLamps 的 ceil 天花板查表）
// 規則：≥10→5.0, ≥9→4.5, ≥8→4.0, 7→3.5, <7→3.0
// 註：分數高低代表訊號可信度，沿用 BEARISH_COMPLETE roadmap 的設計
const _STRATEGY_SCORE = {
  // 做多（沿用既有等級，新增的給 8 為基準）
  'S1':8,'S2':7,'S3':8,'S_STRONG':7,'S4':7,'S5':7,
  'S6':7,'S7':7,'S8':8,'S9':7,
  'S10':8,'S11':9,'S12':6,
  'S20':7,'S21':7,'S22':7,'S23':6,
  'XG1':8,'XG3':8,  // 葛蘭碧強化版：實證達標
  'S13':8,'S14':7,'S15':6,
  'S29':6,'S30':7,'S31':8,'S32':7,'S33':8,'S34':7,'S35':7,'S36':7,
  'S37':7,'S38':7,'S40':7,'S42':8,'S45':8,
  // X 系列（v2.8 正式導入）
  // X1 三軸共振：穩健型，7分
  // X2 天黑請閉眼：飆股加速，8分（60天甜蜜點59.8%）
  // X5 潛龍勿用：妖股先期，7分（固定20天勝率65.5%）
  'X1':7,'X2':8,'X5':7,
  // X6~X11（v2.9 新增，實驗中，初始分數 7）
  'X6':8,  // 見龍在田：實證通過（勝率35.1%/均報+1.6%）
  // 避險（依 SIGNAL_BEARISH roadmap 表格）
  'W1':6,'W2':8,'W3':8,'W4':8,'W5':5,
  'W6':6,'W7':7,'W8':9,'W9':8,'W10':10,
  'W11':9,'W12':8,'W13':8,'W14':8,'W15':7,
  'W16':7,'W17':7,'W18':7,'W19':6,'W20':6,
};

// ceil 天花板查表
function _ceilByScore(maxScore) {
  if (maxScore >= 10) return 5.0;
  if (maxScore >= 9)  return 4.5;
  if (maxScore >= 8)  return 4.0;
  if (maxScore >= 7)  return 3.5;
  return 3.0;
}

// 預計算每個策略的條件數（快取）
let _weightMap = null;
function _getWeightMap() {
  if (_weightMap) return _weightMap;
  _weightMap = {};
  let total = 0;
  for (const s of STRATEGIES) {
    if (!_SCORABLE_IDS.has(s.id)) continue;
    const n = s.conditions.length;
    _weightMap[s.id] = n;
    total += n;
  }
  // 正規化：每個策略權重 = 條件數 / 總條件數
  for (const id in _weightMap) {
    _weightMap[id] = _weightMap[id] / total;
  }
  return _weightMap;
}

/**
 * 根據符合的訊號列表，計算五燈數
 *
 * v2.6 新公式 (方案 A — Gemini 合體版，指數加重)
 * ─────────────────────────────────────────────
 * 正向（紅燈）：
 *   w_i  = score/10 (≥7) 或 score/20 (<7)
 *   ceil = 依最高分查表 (10→5.0, 9→4.5, 8→4.0, 7→3.5, <7→3.0)
 *   red  = ceil × (1 - 0.5^Σw)
 *
 * 負向（綠燈）：指數加重 (WM=45, WA=1.5)
 *   warn_pts = warn[0]/10×45 + Σwarn[i]/10×5×(1+i×1.5)  (i 從 1 開始)
 *   green    = min(100, warn_pts) / 20
 *
 * 零軸攔截：
 *   DIF < 0 時 S10/S11 失效（移出做多計分）— difPos=false 時觸發
 *
 * 淨值：
 *   net = red - green
 *   net > 0 → snapHalf(net)  紅燈
 *   net < 0 → -snapHalf(|net|)  綠燈（負數）
 *   net = 0 → 0  無燈
 *
 * ⚠️ 回傳值語意變更（v2.6）
 *   舊版：0~5 正數（0=無燈，正數=紅燈）
 *   新版：-5~5（0=無燈，正數=紅燈，負數=綠燈，|value| 為燈數）
 *
 * @param {Signal[]} signals
 * @param {boolean}  [difPos]  MACD DIF 是否在零軸上方（由 signal-scan/stock-tabs 傳入）
 * @returns {number} -5 ~ 5，0.5 倍數
 */
export function calcSignalLamps(signals, difPos = true) {
  if (!signals || !signals.length) return 0;

  const sigIds = new Set(signals.map(s => s.id));

  // 分流：做多 vs 避險
  let bullSignals  = signals.filter(s => !_WARNING_IDS.has(s.id));
  let warnSignals  = signals.filter(s =>  _WARNING_IDS.has(s.id));

  // 零軸攔截：DIF < 0 時，S10/S11 移出做多列（這些是 MACD 相關的多頭策略）
  if (difPos === false) {
    bullSignals = bullSignals.filter(s => s.id !== 'S10' && s.id !== 'S11');
  }

  // ── v2.8 妖股模式：X2/X5 亮時，W6/W7 降權 ──
  // X2「天黑請閉眼」或 X5「潛龍勿用」亮 = 妖股主升段
  // RSI 高是強勢副作用，W6(RSI>80)/W7(布林超買) 不應扣燈
  if (sigIds.has('X2') || sigIds.has('X5')) {
    warnSignals = warnSignals.filter(s => s.id !== 'W7' && s.id !== 'W6');
  }

  // ── 正向紅燈 ──
  let red = 0;
  if (bullSignals.length > 0) {
    let sumW = 0;
    let maxScore = 0;
    for (const s of bullSignals) {
      const sc = _STRATEGY_SCORE[s.id] ?? 6;
      const w  = sc >= 7 ? sc / 10 : sc / 20;
      sumW += w;
      if (sc > maxScore) maxScore = sc;
    }
    const ceil = _ceilByScore(maxScore);
    red = ceil * (1 - Math.pow(0.5, sumW));
  }

  // ── 負向綠燈（指數加重 WM=45, WA=1.5）──
  let green = 0;
  if (warnSignals.length > 0) {
    // 依分數由高到低排序，最強訊號用 WM=45 加權
    const sorted = [...warnSignals].sort((a, b) =>
      (_STRATEGY_SCORE[b.id] ?? 6) - (_STRATEGY_SCORE[a.id] ?? 6)
    );
    const WM = 45;
    const WA = 1.5;
    let warnPts = 0;
    sorted.forEach((s, i) => {
      const sc = _STRATEGY_SCORE[s.id] ?? 6;
      if (i === 0) {
        warnPts += sc / 10 * WM;
      } else {
        warnPts += sc / 10 * 5 * (1 + i * WA);
      }
    });
    green = Math.min(100, warnPts) / 20;
  }

  // ── 淨值抵消 ──
  const net = red - green;
  if (net === 0 || (Math.abs(net) < 0.25)) return 0;  // 小於半燈視為無燈
  if (net > 0) return Math.min(5,  _snapHalf(net));
  return -Math.min(5, _snapHalf(-net));
}

/** 四捨五入到最近的 0.5 */
function _snapHalf(x) {
  return Math.round(x * 2) / 2;
}
