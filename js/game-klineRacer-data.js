/* ============================================================
 * game-klineRacer-data.js — K線賽車・人生路 常數定版
 * 載入順序：data → core → life → 主檔（皆在 splash-game.js 之前）
 * 跨檔橋接：window.__KR
 * ============================================================ */
(function () {
  'use strict';
  window.__KR = window.__KR || {};
  var D = {};

  /* ---------- 基礎 ---------- */
  D.WORKER = 'https://stock-2027.luffy0606.workers.dev';
  D.TOKEN = 'e99ecdc813d9a203d1951613de68e7a22f83e5b22ffd458f';
  D.YAO_BONUS = 0.5;            // 妖股分紅：完賽獎金 +50%
  D.SAVE_KEY = 'kline_racer';
  D.SEG_LEN = 100;              // 每根 K 棒 = 100 距離單位
  D.BASE_SPEED = 60;
  D.SPEED_MIN = 12;
  D.SPEED_MAX = 160;
  D.START_MONEY = 1500;

  /* ---------- 賽事分級 ---------- */
  D.RACES = [
    { id: 'S',  name: '小型賽',  period: '1mo', bars: 22,  lvReq: 1,  fee: 0,    prize: [800, 450, 250],          appear: 80,   xpMul: 1,  energy: 0,  pit: 0 },
    { id: 'M',  name: '中型賽',  period: '3mo', bars: 65,  lvReq: 3,  fee: 200,  prize: [2200, 1200, 600],        appear: 150,  xpMul: 2,  energy: 10, pit: 0 },
    { id: 'L',  name: '大型賽',  period: '6mo', bars: 130, lvReq: 8,  fee: 500,  prize: [6000, 3200, 1600],       appear: 300,  xpMul: 4,  energy: 20, pit: 0 },
    { id: 'XL', name: '超大型賽', period: '1y',  bars: 240, lvReq: 15, fee: 1500, prize: [16000, 8500, 4200],      appear: 800,  xpMul: 8,  energy: 35, pit: 1 },
    { id: 'GP', name: '國際賽',  period: '2y',  bars: 480, lvReq: 25, fee: 4000, prize: [45000, 24000, 12000],    appear: 2000, xpMul: 12, energy: 50, pit: 2 }
  ];
  D.XP_BASE = 40;
  D.RANK_XP_MUL = [2.0, 1.6, 1.3, 1, 1, 1, 1, 1, 1, 1]; // index = 名次-1
  D.PRIZE_DEBT_CUT = 0.10;      // 獎金自動扣 10% 還賒帳

  /* ---------- 地形門檻 ---------- */
  D.TERRAIN = {
    slopeClamp: 0.10,           // 漲跌幅 clamp ±10%
    gapPct: 0.03,               // 跳空 > 3% = 斷崖
    limitPct: 0.095,            // |漲跌| >= 9.5% = 極限坡
    volMul: 2.5,                // 量 > 2.5x SMA20 = 亂流區
    volSma: 20,
    gapSlow: 0.40,              // 斷崖通過強制減速 40%
    lateStart: 0.6              // 賽程 60% 起算「後段」（耐力生效）
  };

  /* ---------- 物理係數 ---------- */
  D.PHYS = {
    accelGain: 8,               // 每級加速 +8 速度
    upK: 9,    climbCut: 0.08,  // 上坡懲罰 / 每級爬坡減免 8%
    downK: 4,                   // 下坡免費速度
    curveK: 12, gripCut: 0.07,  // 彎道懲罰 / 每級抓地減免 7%（乘胎況）
    downCurveMul: 1.5,          // 下坡彎懲罰 x1.5
    tireBase: 0.4,              // tireFactor = 0.4 + 0.6 * tirePct
    wearBase: 0.003, wearRough: 0.001,     // 胎耗（每根）：均值 ≈ 1/200，普通胎名實相符 200 根
    blowoutPct: 0.03,           // 胎 0% 後每根爆胎機率
    failBase: 0.004,           // 故障基礎機率（每根）
    failOverdueDiv: 400,        // x (1 + 逾保里程/400)
    failZoneMul: 2,             // 亂流區 x2
    failEndCut: 0.015,          // 後段每點耐力 -1.5%
    stopBase: 120, stopStrCut: 2, stopMin: 50,  // 故障/進站停等 tick
    repairBillMin: 200, repairBillMax: 600,
    tiredCurveMul: 1.5,         // 體力不足硬上：彎道懲罰 x1.5（全程）
    pitEvery: 80,               // 耐力賽每 ~80 根一個進站區
    limitStallTick: 160          // 極限坡熄火等救援 tick（再扣力量）
  };

  /* ---------- 等級 / 屬性 ---------- */
  D.xpNeed = function (lv) { return Math.round(100 * Math.pow(lv, 1.5)); };
  D.LEVEL_UP = { autoStat: 1, freePts: 3 };
  D.ENERGY_BASE = 100; D.ENERGY_PER_VIT = 3;
  D.STAT = {
    strIncome: 0.02,            // 力量：打工收入 +2%/點
    strStopCut: 0.15,           // 力量：停等 -0.15 tick/點
    endJobCut: 0.01,            // 耐力：打工消耗 -1%/點
    endLateFail: 0.015          // 耐力：後段故障 -1.5%/點
  };
  D.START_STATS = { str: 5, vit: 5, end: 5 };

  /* ---------- 打工 / 休息 ---------- */
  D.JOBS = [
    { id: 'wash',   name: '洗車小弟', pay: 180, energy: 15, stat: 'str', gain: 0.3, note: '力量微升' },
    { id: 'gas',    name: '加油小弟', pay: 320, energy: 28, stat: 'vit', gain: 0.3, note: '體力上限微升' },
    { id: 'repair', name: '保養小弟', pay: 520, energy: 45, stat: 'end', gain: 0.3, note: '耐力微升', unlock: { count: 10, flag: 'repairDiscount', desc: '累計 10 班 → 自家保養費永久 9 折' } }
  ];
  D.JOB_MIN_ENERGY = 20;        // 體力 < 20 不能打工
  D.RESORT_BUFF = 0.20;         // 渡假村隔天打工 +20%
  D.RESTS = [
    { id: 'home',   name: '在家休息', cost: 0,    gain: 'house', note: '依房產等級' },
    { id: 'hotel',  name: '旅館',    cost: 400,  gain: 70 },
    { id: 'resort', name: '渡假村',  cost: 1500, gain: 'full', buff: true }
  ];

  /* ---------- 銀行 ---------- */
  D.BANK = {
    quotaPerLv: 2000, quotaPerCredit: 20,
    creditStart: 600, creditMin: 300, creditMax: 850,
    creditOk: 1, creditMiss: -15,
    missLimit: 6,               // 連續 6 期扣款失敗 → 法拍
    plans: [
      { terms: 6,  rate: 0.03, tag: '短痛' },
      { terms: 12, rate: 0.06, tag: '均衡' },
      { terms: 24, rate: 0.12, tag: '長痛' }
    ],
    carAuctionRate: 0.7         // 法拍車 7 折變現
  };
  D.DEBT_CAP_PER_LV = 1000;     // 賒帳上限 = 1000 x Lv

  /* ---------- 不動產 / 車庫 ---------- */
  D.HOUSES = [
    { id: 0, name: '套房', price: 0,      rest: 30,    garageCap: 1, living: 50 },
    { id: 1, name: '公寓', price: 35000,  rest: 45,    garageCap: 2, living: 80 },
    { id: 2, name: '透天', price: 90000,  rest: 60,    garageCap: 3, living: 120 },
    { id: 3, name: '豪宅', price: 220000, rest: 80,    garageCap: 4, living: 200 },
    { id: 4, name: '莊園', price: 500000, rest: 'full', garageCap: 5, living: 350 }
  ];
  // living = 每天基本生活開銷（休息/打工都會扣），房子越大養護越貴
  D.HOUSE_SELLBACK = 0.7;       // 換房舊屋 7 折回收
  D.GARAGES = [
    { lv: 1, price: 0,      slots: 1, tierCap: 'C' },
    { lv: 2, price: 8000,   slots: 2, tierCap: 'B' },
    { lv: 3, price: 20000,  slots: 3, tierCap: 'A' },
    { lv: 4, price: 50000,  slots: 5, tierCap: 'S' },
    { lv: 5, price: 120000, slots: 8, tierCap: 'X' }
  ];

  /* ---------- 車 ---------- */
  D.TIER_ORDER = ['C', 'B', 'A', 'S', 'X'];
  D.CAR_TIERS = {
    C: { name: 'C 級', price: 0,       statCap: 5,  upMul: 1 },
    B: { name: 'B 級', price: 25000,   statCap: 8,  upMul: 1.3 },
    A: { name: 'A 級', price: 80000,   statCap: 12, upMul: 1.7 },
    S: { name: 'S 級', price: 250000,  statCap: 16, upMul: 2.2 },
    X: { name: '傳奇', price: 1000000, statCap: 20, upMul: 3 }
  };
  D.CAR_TYPES = {
    std:   { name: '均衡', accel: 0, climb: 0, wearMul: 1,   failMul: 1,   spdMul: 1 },
    sprint:{ name: '短程', accel: 2, climb: 0, wearMul: 1,   failMul: 1,   spdMul: 1 },
    hill:  { name: '越野', accel: 0, climb: 2, wearMul: 1,   failMul: 1,   spdMul: 1 },
    endu:  { name: '耐力', accel: 0, climb: 0, wearMul: 0.7, failMul: 0.8, spdMul: 0.9 }
  };
  D.upgradeCost = function (targetLv, tier) {
    return Math.round(500 * Math.pow(targetLv, 1.8) * D.CAR_TIERS[tier].upMul);
  };
  D.SERVICE_EVERY = 400;        // 每車累積 400 根強制保養
  D.SERVICE_RATE = 0.02;        // 保養費 = 車價 2%（C 級無車價 → 用底價 5000 計）
  D.SERVICE_BASE_C = 5000;

  /* ---------- 輪胎 ---------- */
  D.TIRES = {
    normal: { name: '普通胎', price: 300,  life: 200, grip: 0,  tier: 1 },
    soft:   { name: '軟胎',   price: 800,  life: 120, grip: 2,  tier: 1 },
    hard:   { name: '硬胎',   price: 500,  life: 300, grip: -1, tier: 1 },
    race:   { name: '競技胎', price: 1500, life: 160, grip: 3,  tier: 2 },
    nano:   { name: '奈米胎', price: 3000, life: 250, grip: 3,  tier: 4 }
  };

  /* ---------- 材料路線（真實成長曲線：線性 / 後爆 / 前衝） ---------- */
  D.MATS = {
    accel: { name: '引擎', routes: [
      { id: 'lin', name: '鍛造曲軸', desc: '線性穩定' },
      { id: 'pow', name: '渦輪增壓', desc: '後段爆發（高Lv反超）' },
      { id: 'log', name: '機械增壓', desc: '前段湧現（低Lv即強）' }] },
    grip: { name: '輪胎科技', routes: [
      { id: 'lin', name: '街胎配方', desc: '線性穩定' },
      { id: 'pow', name: '熱熔配方', desc: '後段爆發' },
      { id: 'log', name: '拉力配方', desc: '前段湧現' }] },
    climb: { name: '傳動', routes: [
      { id: 'lin', name: '平衡齒比', desc: '線性穩定' },
      { id: 'pow', name: '高轉凸輪', desc: '後段爆發' },
      { id: 'log', name: '低速扭力', desc: '前段湧現' }] }
  };
  D.MAT_SWITCH_COST = 1000; // 切換材料路線費用 = Lv × 此值
  D.BUSY_MS = 650;          // loading 過場：每天/每班毫秒數

  D.CAP_SURGE = 1.6; // 屬性超過車階上限後，每級費用額外 ×1.6（無上限升級）
  D.TIRE_TECH = { wearCut: 0.06, wearFloor: 0.4, costMul: 0.7 }; // 輪胎科技：每級胎耗 -6%（下限 40%），升級費 7 折曲線

  /* ---------- 修配廠累進制（忠誠等級 / 保養等級 / 外掛） ---------- */
  D.SHOP = {
    tiers: [
      { lv: 1, name: '銅牌', need: 0,      slots: 0 },
      { lv: 2, name: '銀牌', need: 10000,  slots: 1 },
      { lv: 3, name: '金牌', need: 40000,  slots: 1 },   // 升級費 9 折
      { lv: 4, name: '白金', need: 120000, slots: 2 },
      { lv: 5, name: '鑽石', need: 300000, slots: 3 }    // 保養費 8 折
    ],
    svc: [
      { id: 'std',  name: '標準保養', mul: 1,   buff: 0,   tier: 1, desc: '' },
      { id: 'fine', name: '精緻保養', mul: 1.5, buff: 0.3, tier: 2, desc: '下場故障 -30%' },
      { id: 'top',  name: '頂級保養', mul: 2.5, buff: 0.5, tier: 4, desc: '故障 -50% + 胎回滿', tireFull: true }
    ],
    mods: [
      { id: 'turbo',  name: '渦輪增壓',   price: 12000, tier: 3, desc: '加速 +1' },
      { id: 'cage',   name: '防滾籠',     price: 9000,  tier: 3, desc: '維修 -30%' },
      { id: 'susp',   name: '強化懸吊',   price: 15000, tier: 4, desc: '彎道 -12%' },
      { id: 'nos',    name: '氮氣擴充',   price: 20000, tier: 5, desc: '氮氣 +2 罐' },
      { id: 'carbon', name: '碳纖輕量化', price: 30000, tier: 5, desc: '基礎速度 +6' }
    ]
  };

  /* ---------- AI 宿敵 ---------- */
  D.RIVALS = [
    { name: '疾風', style: 'aggressive' },
    { name: '夜貓', style: 'closer' },
    { name: '雷霆', style: 'aggressive' },
    { name: '老狐', style: 'steady' },
    { name: '閃電', style: 'aggressive' },
    { name: '黑馬', style: 'closer' },
    { name: '旋風', style: 'steady' },
    { name: '影子', style: 'closer' },
    { name: '火球', style: 'steady' }
  ];
  D.AI_BAND = [0.85, 1.15];     // 橡皮筋：玩家有效車力 x U(0.85,1.15)
  D.AI_STYLE = {                // 個性：前段/後段速度倍率
    aggressive: { early: 1.06, late: 0.94 },
    steady:     { early: 1.0,  late: 1.0 },
    closer:     { early: 0.94, late: 1.07 }
  };

  /* ---------- 調校模式（泵浦曲線思維：同輸出不同消耗） ---------- */
  D.TUNE_MODES = {
    eco:  { name: '🌱 節能', spd: 0.92, wear: 0.75, fail: 0.75, desc: '變頻思維：慢 8% 省 25% 耗損' },
    std:  { name: '⚙ 標準', spd: 1,    wear: 1,    fail: 1,    desc: '原廠平衡設定' },
    rage: { name: '🔥 狂暴', spd: 1.1,  wear: 1.35, fail: 1.4,  desc: '節流思維：快 10% 耗大增' }
  };

  /* ---------- AI 宿敵成長 ---------- */
  D.RIVAL = {
    initBand: [0.8, 1.1],       // 初始車力 = 玩家 x U
    growMin: 0.1, growMax: 0.4, // 每場賽後成長
    talents: { aggressive: 1.25, steady: 0.85, closer: 1.0 },
    clampLo: 0.7, clampHi: 1.3  // 永遠夾在玩家車力 70%~130%
  };

  /* ---------- 修配廠無限研發（曲面成長） ---------- */
  D.RND = {
    costBase: 5000, costGrow: 1.6, unlockTier: 3, // 金牌解鎖
    lines: [
      { id: 'eng',   name: '引擎研究',   unit: '基礎速度 +' },
      { id: 'mat',   name: '材料科學',   unit: '胎耗 −', pct: true },
      { id: 'nos',   name: '氮氣實驗室', unit: '氮氣效力 +' },
      { id: 'rel',   name: '可靠度工程', unit: '故障 −', pct: true },
      { id: 'craft', name: '工藝精進',   unit: '升級費 −', pct: true }
    ]
  };

  /* ---------- 征途模式（無限關魔王戰） ---------- */
  D.CAMPAIGN = {
    bossBandBase: 1.02, bossBandPer: 0.025, bossBandCap: 1.45, // 魔王車力 = 玩家 ×(base+per×關)
    rewardBase: 2500, rewardPer: 1500, milestoneEvery: 5, milestoneMul: 3,
    xpBase: 40, xpPer: 12,
    throwCD: 420, throwChance: 0.55, itemWarnTicks: 72, // 魔王暗器
    rulePool: [
      { id: 'noNitro', name: '禁氮氣', desc: '本關氮氣失效' },
      { id: 'gap2', name: '斷崖加倍', desc: '跳空懸崖減速加劇' },
      { id: 'surge2', name: '亂流加倍', desc: '爆量區故障率再 ×2' },
      { id: 'invert', name: '空頭賽道', desc: '坡度全反向（跌勢視角）' },
      { id: 'fog', name: '大霧', desc: '急彎閃避窗口縮小' },
      { id: 'wear15', name: '惡路', desc: '胎耗 ×1.5' }
    ],
    skillPool: [
      { id: 'failImmune', name: '鋼鐵心臟', desc: '永不故障' },
      { id: 'wearHalf', name: '胎皮怪', desc: '胎耗減半' },
      { id: 'climbBeast', name: '山道魔人', desc: '上坡 +18% 速度' },
      { id: 'rocket', name: '火箭起跑', desc: '前 20% 路程 +15%' },
      { id: 'closerX', name: '終盤殺手', desc: '後 30% 路程 +15%' },
      { id: 'thrower', name: '暗器大師', desc: '丟暗器頻率加倍' }
    ],
    titles: ['斷崖', '亂流', '山道', '空頭', '妖股', '閃電', '暗夜', '鋼鐵'],
    surnames: ['獵人', '武士', '魔人', '大師', '之王', '殺手', '幽靈', '霸主']
  };

  /* ---------- 暗器（馬力歐式） ---------- */
  D.ITEMS = {
    banana: { name: '香蕉皮', icon: '🍌', price: 600, stall: 90, desc: '命中打滑停等' },
    shell: { name: '龜殼', icon: '🐢', price: 1200, stall: 140, desc: '命中重創停等' },
    zap: { name: '電擊', icon: '⚡', price: 900, slowTicks: 120, desc: '命中降速 15% 兩秒' }
  };
  D.ITEM_KEYS = ['banana', 'shell', 'zap'];

  /* ---------- 武裝研發（修配廠第三子頁，無限） ---------- */
  D.ARMORY = {
    costBase: 3000, costGrow: 1.5,
    lines: [
      { id: 'dmg', name: '暗器強化', unit: '暗器威力 +', pct: true },
      { id: 'carry', name: '彈藥庫', unit: '各暗器攜帶上限 +' },
      { id: 'dodge', name: '反應訓練', unit: '閃避窗口 +', tick: true }
    ]
  };

  /* ---------- 操作參與（氮氣 / 過彎QTE / 搶修連打） ---------- */
  D.PLAY = {
    nitroBase: 3, nitroSpeed: 45, nitroTicks: 70,
    qteSharp: 0.045,            // 振幅 >= 4.5% 的彎觸發 QTE
    qteZone: [0.6, 0.92],       // 接近段 60%~92% = 完美煞車區
    qtePerfectMod: 0.25, qteEarlyMod: 1.1, qteMissMod: 1.6,
    qtePerfectBoost: 8,
    mashTick: 4, mashStr: 0.15  // 每點搶修 -(4 + 力量*0.15) tick
  };

  /* ---------- 顏色（台股慣例：漲紅跌綠） ---------- */
  D.COL = {
    bg: '#0d1117', card: '#161b22', line: '#21262d', border: '#30363d',
    text: '#e6edf3', sub: '#8b949e', dim: '#484f58',
    up: '#ef5350', down: '#26a69a',
    gold: '#f0a527', goldBg: '#2b2210', blue: '#388bfd',
    red: '#e5534b', green: '#26a69a', terrain: '#1a2029'
  };

  D.fmt = function (n) { return '$' + Math.round(n).toLocaleString(); };
  D.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  D.rnd = function (a, b) { return a + Math.random() * (b - a); };
  D.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

  window.__KR.D = D;
})();
