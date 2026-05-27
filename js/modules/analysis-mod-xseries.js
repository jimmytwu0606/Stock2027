/* js/modules/analysis-mod-xseries.js — X 系列獨家策略 Golden Board  v3
 *
 * 渲染架構（簡化版，消除三重重複）：
 *   ① 妖股狀態卡（單一區塊，集中顯示狀態+強度+天數+操作建議）
 *   ② 訊號連燈看板（X1-X5 各策略亮滅 + 天數）
 *   ③ SVG 示意圖 Grid
 *   ④ 策略說明卡 + 回測表
 *   ⑤ AI 建議
 *
 * 不再有 readout items 列表（避免重複），
 * readout summary bar 只顯示妖股等級一行。
 *
 * 連燈看板的 inject 判斷：
 *   _yaoguInjected 可能因 IndexedDB 序列化丟失，
 *   改用 yaoguInfo.strength 推斷「哪些策略是由 DB 記錄保留的」
 */
import { AppState } from '../state.js';
import { getTriggerHistory } from '../signal-scan.js';
import { renderAISection } from '../analysis-ai-prompt.js';
import { registerAnalysisModule, _renderReadoutItem, _escapeAttr } from '../analysis-fullscreen.js';

const X_STRATEGIES = [
  {
    id: 'X1', icon: '🪙', name: '黃金比例', tagline: '三軸共振 · 最穩',
    color: '#f59e0b', colorDim: '#f59e0b44',
    conds: 'RSI ≥ 60 + 量 ≥ 10日均量×2 + 站上MA20 + MA20連3天上升',
    desc: '動能、量能、趨勢三軸同時滿足，觸發門檻最嚴但雜訊最低，是 X2 的前置訊號。',
    system: 'A', exitRule: '60天 or S40出場', backtest: '60天勝率 ~60%+', svgKey: 'x1',
  },
  {
    id: 'X2', icon: '🌑', name: '天黑請閉眼', tagline: '飆股加速 · 最飆',
    color: '#818cf8', colorDim: '#818cf844',
    conds: '10日漲 ≥ 15% + 量 ≥ 30日均量×3 + RSI ≥ 70',
    desc: '捕捉「已在飆繼續飆」。進場後閉眼持有，X 系列中期望報酬最高。',
    system: 'A', exitRule: '60天 or S40出場', backtest: '60天甜蜜點 +43.7%（勝率 59.8%）', svgKey: 'x2',
  },
  {
    id: 'X3', icon: '🪂', name: '炒底王', tagline: 'V型反轉 · 抄底',
    color: '#34d399', colorDim: '#34d39944',
    conds: '5日跌 ≥ 5% + RSI 從 <30 反彈到 ≥35 + 量 ≥ 10日均量×1.2',
    desc: '超跌 RSI 超賣反彈，有量配合的 V 型初期。目前實驗階段。',
    system: 'B', exitRule: '固定20天 or 跌破MA20', backtest: '實驗中', svgKey: 'x3',
  },
  {
    id: 'X4', icon: '🚦', name: '何時輪到我', tagline: '族群輪動 · 跨股',
    color: '#f87171', colorDim: '#f8717144',
    conds: '同族群 ≥2 檔 RSI>70 + 本股 RSI 40-60 + 量 ≥ 10日均量×1.5',
    desc: '族群強股先跑，等本股輪動補漲。需族群 K 線資料才觸發。',
    system: 'B', exitRule: '固定20天', backtest: '實驗中', svgKey: 'x4',
  },
  {
    id: 'X5', icon: '🚀', name: '量證明一切', tagline: '妖股先期 · 早進場',
    color: '#a78bfa', colorDim: '#a78bfa44',
    conds: '量 ≥ 10日均量×2.5 + RSI ≥ 60 + 站上MA20 + MA20連2天上升',
    desc: '比 X2 早 5-10 天觸發的妖股先期版。近期相對爆量，不受長期均量基期影響。',
    system: 'B快打', exitRule: '固定20天（勝率最高）', backtest: '勝率 65.5%，報酬 +19.4%', svgKey: 'x5',
  },
];

// 依 yaoguInfo.strength 推斷「哪些 X 策略應被視為保留中」
function _getRetainedIds(yaoguInfo) {
  // 對齊 signal-scan.js injectYaoguSignals 的邏輯
  // strength 分級（ROADMAP_YAOGU_SIGNAL_0526_1123）：
  //   strong = X1+X2+X5 / X1+X2 / X2+X5 → inject X2（核心）
  //   medium = X2 單獨 或 X1+X5         → inject X2+X5
  //   steady = X1 單獨                  → inject X1
  //   early  = X5 單獨                  → inject X5
  if (!yaoguInfo || yaoguInfo.status === 'exited') return new Set();
  const s = yaoguInfo.strength;
  if (s === 'strong') return new Set(['X2']);           // X1 同日通常還在，X2 量縮易失
  if (s === 'medium') return new Set(['X2', 'X5']);
  if (s === 'steady') return new Set(['X1']);
  if (s === 'early')  return new Set(['X5']);
  return new Set();
}

function _resolveYaoguInfo(code, yaoguStatus) {
  return yaoguStatus?.[code] ?? null;
}

function _operatingSystem(yaoguInfo, realSigIds) {
  const status = yaoguInfo?.status;
  const strength = yaoguInfo?.strength;

  if (status === 'exit') return {
    system: '出場確認', icon: '🔴', color: '#ef4444',
    action: '已跌破月線，應立即出場', note: '妖股底線破守，不要猶豫', expected: null,
  };
  if (status === 'warning2') return {
    system: 'W5 出貨警示', icon: '🟠', color: '#f97316',
    action: '主力可能出貨，建議縮倉至50%以下', note: '急跌訊號出現，守住利潤優先', expected: null,
  };
  if (status === 'warning1') return {
    system: 'MACD 高位死叉', icon: '🟡', color: '#fbbf24',
    action: '訊號轉弱，出場前 4-5 天前兆', note: '可開始分批出場，不要全倉等待', expected: null,
  };

  // active / watching — 依 strength 給建議
  const hasX2 = strength === 'strong' || strength === 'medium' || realSigIds.has('X2');
  const hasX5 = strength === 'early' || realSigIds.has('X5');
  const hasX1 = strength === 'steady' || realSigIds.has('X1');

  if (hasX2) return {
    system: 'A — 最大化報酬', icon: '🏆', color: '#818cf8',
    action: 'X2 進場，抱長 60 天（S40 紅三兵出場）',
    note: '持有期間回調 -10% 以內屬正常，不要出場。出場條件：優先等 S40 紅三兵出現再走；若 60 天到了 S40 仍未出現，直接在第 60 天出場。',
    expected: '預期報酬 +43.7%（60天甜蜜點 59.8%）',
  };
  if (hasX5 && !hasX1) return {
    system: 'B快打 — 妖股先期', icon: '⚡', color: '#a78bfa',
    action: 'X5 進場，固定 20 天出場',
    note: 'X2 一旦觸發可升級為系統A繼續抱。', expected: '預期報酬 +19.4%（勝率 65.5%）',
  };
  if (hasX1 && !hasX2) return {
    system: 'X1-watch — 等待 X2', icon: '👁️', color: '#f59e0b',
    action: '目前只有 X1，等待 X2「天黑請閉眼」確認後進場系統A',
    note: 'X1 是強勢前置，配合 X2 才是最強妖股組合。', expected: null,
  };
  if (status === 'watching') return {
    system: '觀察中 — 訊號暫退', icon: '⚪', color: '#9ca3af',
    action: '妖股訊號暫時消退，持續觀察 MA20',
    note: '未跌破 MA20 前不需急出，等待訊號重新觸發。', expected: null,
  };
  return null;
}

// ─────────────────────────────────────────────
const XSeriesModule = {
  id: 'xseries',
  name: 'X 系列獨家策略',
  icon: '🏆',
  candleMinLen: 30,

  evaluate(candles) {
    const code = AppState.activeCode || '';
    const allSignals = AppState.signals?.[code] ?? [];
    const realSigIds = new Set(allSignals.filter(s => !s._yaoguInjected).map(s => s.id));
    const allSigIds  = new Set(allSignals.map(s => s.id));

    const yaoguInfo = _resolveYaoguInfo(code, AppState.yaoguStatus);
    const retainedIds = _getRetainedIds(yaoguInfo);

    // 合併：真實觸發 + DB 保留（去重）
    const effectiveSigIds = new Set([...allSigIds, ...retainedIds]);

    // 各策略狀態
    const stratStatus = X_STRATEGIES.map(x => {
      const real     = realSigIds.has(x.id);
      const retained = !real && retainedIds.has(x.id);  // DB 保留但 K 線今天沒亮
      const on       = real || retained;
      return { ...x, real, retained, on };
    });

    const activeStrats = stratStatus.filter(x => x.on);

    // getTriggerHistory — 只對真實觸發的跑
    let histMap = new Map();
    if (realSigIds.size > 0) {
      try { histMap = getTriggerHistory(candles, null, { lookback: 120 }); } catch(e) {}
    }

    // 近期曾觸發但今天完全沒有（真實 + 保留都沒有）的策略
    const recentButGone = X_STRATEGIES.filter(x => {
      if (effectiveSigIds.has(x.id)) return false;
      const hist = histMap.get(x.id);
      return hist && hist.totalTriggers > 0;
    });

    const opSys = _operatingSystem(yaoguInfo, realSigIds);

    const score = activeStrats.length > 0
      ? (effectiveSigIds.has('X2') ? 5 : effectiveSigIds.has('X1') && effectiveSigIds.has('X5') ? 4 : 3)
      : (yaoguInfo?.status === 'watching' ? 2 : 0);

    const signal = yaoguInfo
      ? { name: yaoguInfo.label, icon: yaoguInfo.label.split(' ')[0],
          stars: score, desc: opSys ? opSys.action : yaoguInfo.desc }
      : activeStrats.length > 0
      ? { name: `${activeStrats[0].icon} ${activeStrats[0].name}`, icon: activeStrats[0].icon,
          stars: score, desc: opSys ? opSys.action : activeStrats[0].desc }
      : { name: '尚無 X 系列訊號', icon: '⏸', stars: 0, desc: '等待 X1/X2/X5 觸發' };

    return {
      score, signal,
      items: [],  // 不用 readout items，用獨立卡片取代
      raw: {
        n: candles.length, code,
        stratStatus, activeStrats, histMap,
        recentButGone, yaoguInfo, opSys,
        realSigIds, effectiveSigIds, retainedIds,
      },
    };
  },

  getLegendRows(ev) {
    return ev.raw.activeStrats.map(x => {
      const hist = ev.raw.histMap?.get(x.id);
      const streak = x.retained ? (ev.raw.yaoguInfo?.streak || 1) : (hist?.streak || 1);
      return { id: x.id, name: `${x.icon} ${x.name}`,
        value: x.retained ? `保留·第${streak}天` : `第${streak}天`,
        color: x.color, tooltip: x.conds };
    });
  },

  renderBadge(ev, id) {
    const r = ev.raw;
    const yi = r.yaoguInfo;
    if (yi && r.activeStrats.length > 0) {
      return `<span class="fs-mini-badge" data-mod="${id}" style="border-color:${yi.color}44">
        <span>${yi.label.split('·')[0].trim()}</span>
        ${yi.streak ? `<span class="fs-mini-stars" style="color:${yi.color}">第${yi.streak}天</span>` : ''}
      </span>`;
    }
    if (!r.activeStrats.length) return `<span class="fs-mini-badge" data-mod="${id}">🏆 X系列</span>`;
    const x = r.activeStrats[0];
    const hist = r.histMap?.get(x.id);
    const streak = x.retained ? (yi?.streak || 1) : (hist?.streak || 1);
    return `<span class="fs-mini-badge" data-mod="${id}" style="border-color:${x.color}66">
      <span>${x.icon} ${x.name}</span>
      <span class="fs-mini-stars" style="color:${x.color}">第${streak}天</span>
    </span>`;
  },

  renderFull(ev) {
    if (!ev.raw || ev.raw.n < 30) {
      return `<div class="fs-deep-module-head"><span class="fs-icon">🏆</span>
        <span class="fs-title">X 系列獨家策略</span></div>
        <div class="fs-deep-module-body">
          <p style="color:var(--muted);text-align:center;padding:20px">資料不足（需 ≥ 30 根日K）</p>
        </div>`;
    }

    const r = ev.raw;
    const stars = '⭐'.repeat(ev.signal.stars);

    return `
      <div class="fs-deep-module-head">
        <span class="fs-icon">🏆</span>
        <span class="fs-title">X 系列獨家策略</span>
        <span class="fs-subtitle">X1-X5 獨家系統 · 妖股識別 · 進出場建議</span>
      </div>
      <div class="fs-deep-module-body">

        ${_renderMainCard(r, ev.signal, stars)}
        ${_renderStreakBoard(r)}
        ${_renderXSvgGrid(r)}
        ${_renderStrategyCards()}
        ${_renderBacktestTable()}
        ${renderAISection('xseries', 'X 系列獨家策略', '🏆', ev, _buildExtraData(r))}

      </div>`;
  },
};

// ═══════════════════════════════════════════════════════
// ① 主卡片（合併：妖股狀態 + 操作建議，一個區塊搞定）
// ═══════════════════════════════════════════════════════
function _renderMainCard(r, signal, stars) {
  const yi = r.yaoguInfo;
  const o  = r.opSys;

  if (!yi && !r.activeStrats.length) {
    // 完全沒有任何 X 系列活動
    return `<div class="xs-main-card xs-main-none">
      <div class="xs-main-icon">⏸</div>
      <div class="xs-main-body">
        <div class="xs-main-title">尚無 X 系列訊號</div>
        <div class="xs-main-sub">等待 X1/X2/X5 任一訊號觸發，系統將自動建立妖股追蹤記錄。X2「天黑請閉眼」觸發 = 最值得進場。</div>
      </div>
    </div>`;
  }

  const strengthMap = {
    strong: { label: '🔴 強妖', color: '#ef4444' },
    medium: { label: '🟠 中妖', color: '#f97316' },
    steady: { label: '🟡 穩健型', color: '#eab308' },
    early:  { label: '🟡 早期型', color: '#eab308' },
    none:   { label: '', color: '#6b7280' },
  };
  const sb = strengthMap[yi?.strength || 'none'];
  const statusColor = yi?.color || '#4ade80';
  const streakLabel = yi?.streak ? `第 ${yi.streak} 天` : '';
  const activatedStr = yi?.activatedAt
    ? `啟動：${new Date(yi.activatedAt).toLocaleDateString('zh-TW')}`
    : '';

  // 哪些策略保留中（顯示於副標題）
  const retainedLabels = r.activeStrats
    .filter(x => x.retained)
    .map(x => `${x.icon}${x.name}`)
    .join('、');

  return `
    <div class="xs-main-card" style="--xs-mc:${statusColor}">
      <!-- 頂行：狀態 + 強度 + 天數 -->
      <div class="xs-main-top">
        <span class="xs-main-label" style="color:${statusColor}">${signal.name}</span>
        ${streakLabel ? `<span class="xs-main-streak">${streakLabel}</span>` : ''}
        ${sb.label ? `<span class="xs-strength-badge" style="color:${sb.color};border-color:${sb.color}44">${sb.label}</span>` : ''}
      </div>

      <!-- 妖股描述 -->
      ${yi ? `<div class="xs-main-desc">${yi.desc}</div>` : ''}

      <!-- 保留訊號提示 -->
      ${retainedLabels ? `<div class="xs-main-hint">🔄 ${retainedLabels} 盤中量縮，訊號由 DB 記錄保留，持續追蹤中</div>` : ''}

      <!-- watching 提示 -->
      ${yi?.status === 'watching' ? `<div class="xs-main-hint">💡 訊號暫退屬正常（盤中縮量/基期拉高），觀察 MA20，未跌破前不需出場</div>` : ''}

      <!-- 出場警示 -->
      ${yi?.status === 'exit' ? `<div class="xs-main-hint is-danger">⚠️ 已跌破月線，應立即出場，不要抱僥倖心態</div>` : ''}

      <!-- 操作建議區 -->
      ${o ? `<div class="xs-main-opsys" style="border-color:${o.color}33">
        <span class="xs-main-opsys-icon">${o.icon}</span>
        <div class="xs-main-opsys-body">
          <div class="xs-main-opsys-sys" style="color:${o.color}">${o.system}</div>
          <div class="xs-main-opsys-action">📌 ${o.action}</div>
          <div class="xs-main-opsys-note">⚠️ ${o.note}</div>
          ${o.expected ? `<div class="xs-main-opsys-expected">📈 ${o.expected}</div>` : ''}
        </div>
      </div>` : ''}

      <!-- 啟動時間 -->
      ${activatedStr ? `<div class="xs-main-meta">${activatedStr}</div>` : ''}
    </div>`;
}

// ═══════════════════════════════════════════════════════
// ② 訊號連燈看板
// ═══════════════════════════════════════════════════════
function _renderStreakBoard(r) {
  const rows = r.stratStatus.map(x => {
    const hist  = r.histMap?.get(x.id);
    const streak = x.retained
      ? (r.yaoguInfo?.streak || 1)
      : x.real ? (hist?.streak || 1) : 0;
    const total = hist?.totalTriggers || 0;
    const isGone = r.recentButGone.includes(x);

    let statusText = '— 未觸發';
    let statusColor = '';
    if (x.retained) { statusText = `🔄 保留中 · 第 ${streak} 天`; statusColor = x.color; }
    else if (x.real && hist?.isNew) { statusText = '✨ 今天新亮'; statusColor = x.color; }
    else if (x.real) { statusText = `第 ${streak} 天`; statusColor = x.color; }
    else if (isGone) { statusText = `近期共 ${total} 次`; statusColor = '#6b7280'; }

    const dotCount = 7;
    const dots = [...Array(dotCount)].map((_, i) =>
      `<span class="xs-dot ${i < streak && x.on ? 'is-on' : isGone && i === 0 ? 'is-ghost' : ''}"
        style="${i < streak && x.on ? `background:${x.color}` : ''}"></span>`
    ).join('');

    return `
      <div class="xs-streak-row ${x.on ? 'is-on' : isGone ? 'is-ghost' : 'is-off'}">
        <span class="xs-streak-icon">${x.icon}</span>
        <div class="xs-streak-info">
          <span class="xs-streak-name">${x.name}</span>
          <span class="xs-streak-tag" style="${statusColor ? `color:${statusColor}` : ''}">${statusText}</span>
        </div>
        <div class="xs-streak-dots">${dots}</div>
      </div>`;
  });

  return `
    <div class="xs-streak-board">
      <div class="xs-board-title">📡 訊號連燈狀態</div>
      ${rows.join('')}
    </div>`;
}

// ═══════════════════════════════════════════════════════
// ③ SVG Grid
// ═══════════════════════════════════════════════════════
function _renderXSvgGrid(r) {
  const svgs = r.stratStatus.map(x => {
    const hist = r.histMap?.get(x.id);
    const streak = x.retained ? (r.yaoguInfo?.streak || 1) : (hist?.streak || 0);
    const gone = r.recentButGone.some(g => g.id === x.id);

    let badge = '';
    if (x.retained) badge = `<span class="xs-svg-badge is-hold">🔄 第${streak}天保留</span>`;
    else if (x.real) badge = `<span class="xs-svg-badge is-on">亮燈 · 第${streak}天</span>`;
    else if (gone)   badge = `<span class="xs-svg-badge is-ghost">近期曾觸發</span>`;

    return `
      <div class="xs-svg-cell ${x.on ? 'is-on' : gone ? 'is-ghost' : ''}" style="${x.on ? `--xs-border:${x.color}` : ''}">
        <div class="xs-svg-label" style="${x.on ? `color:${x.color}` : gone ? 'color:#6b7280' : ''}">
          ${x.icon} ${x.name} ${badge}
        </div>
        ${_xSvg(x, x.on, gone)}
        <div class="xs-svg-tagline">${x.tagline}</div>
      </div>`;
  });

  return `
    <div class="xs-svg-section">
      <div class="xs-board-title">🎨 策略示意圖</div>
      <div class="xs-svg-grid">${svgs.join('')}</div>
    </div>`;
}

// ─── SVG 繪圖（各策略） ────────────────────────────────
function _xSvg(x, on, gone) {
  const c    = on ? x.color : gone ? '#4b5563' : '#374151';
  const cDim = on ? x.colorDim : '#37415133';
  switch (x.svgKey) {
    case 'x1': return _svgX1(c, cDim, on);
    case 'x2': return _svgX2(c, cDim, on);
    case 'x3': return _svgX3(c, cDim, on);
    case 'x4': return _svgX4(c, cDim, on);
    case 'x5': return _svgX5(c, cDim, on);
    default: return '';
  }
}

function _svgX1(c, cDim, on) {
  const id = 'x1' + Math.random().toString(36).slice(2,6);
  const glow = on ? `<filter id="${id}"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  const sc = on ? '#fbbf24' : '#4b5563';
  return `<svg viewBox="0 0 300 175" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block"><defs>${glow}</defs>
    <circle cx="128" cy="78" r="50" fill="${cDim}" stroke="${c}55" stroke-width="1.5"/>
    <circle cx="172" cy="78" r="50" fill="${cDim}" stroke="${c}55" stroke-width="1.5"/>
    <circle cx="150" cy="115" r="50" fill="${cDim}" stroke="${c}55" stroke-width="1.5"/>
    <text x="106" y="54" fill="${c}99" font-size="10" text-anchor="middle" font-family="system-ui">🟢 動能 RSI≥60</text>
    <text x="194" y="54" fill="${c}99" font-size="10" text-anchor="middle" font-family="system-ui">🟡 量能 ×2</text>
    <text x="150" y="168" fill="${c}99" font-size="10" text-anchor="middle" font-family="system-ui">🔵 趨勢 MA20↑×3天</text>
    <circle cx="150" cy="97" r="18" fill="${on?'#fbbf2433':'#1f293755'}" stroke="${sc}" stroke-width="${on?2:1}"/>
    <text x="150" y="103" fill="${sc}" font-size="20" text-anchor="middle" ${on?'filter="url(#'+id+')'+'"' : ''}>⭐</text>
    <text x="150" y="20" fill="${c}" font-size="11" text-anchor="middle" font-weight="600" font-family="system-ui">三軸共振 → 進場</text>
  </svg>`;
}

function _svgX2(c, cDim, on) {
  const id = 'x2' + Math.random().toString(36).slice(2,6);
  const glow = on ? `<filter id="${id}"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  const gc = on ? '#34d399' : '#374151';
  return `<svg viewBox="0 0 300 175" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">
    <defs><marker id="a${id}" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6Z" fill="${c}"/></marker>${glow}</defs>
    <rect x="15" y="18" width="118" height="130" rx="6" fill="#0f2218" opacity="0.8"/>
    <text x="74" y="34" fill="${gc}99" font-size="9" text-anchor="middle" font-family="system-ui">☀️ 10日漲≥15%</text>
    <line x1="30" y1="125" x2="30" y2="82" stroke="${gc}" stroke-width="1"/><rect x="25" y="82" width="10" height="43" fill="${gc}" rx="1" opacity="0.5"/>
    <line x1="50" y1="118" x2="50" y2="73" stroke="${gc}" stroke-width="1"/><rect x="45" y="73" width="10" height="45" fill="${gc}" rx="1" opacity="0.65"/>
    <line x1="70" y1="108" x2="70" y2="60" stroke="${gc}" stroke-width="1"/><rect x="65" y="60" width="10" height="48" fill="${gc}" rx="1" opacity="0.8"/>
    <line x1="90" y1="95" x2="90" y2="46" stroke="${gc}" stroke-width="1"/><rect x="85" y="46" width="10" height="49" fill="${gc}" rx="1" opacity="1"/>
    <rect x="25" y="142" width="10" height="8" fill="${gc}" opacity="0.35" rx="1"/>
    <rect x="45" y="136" width="10" height="14" fill="${gc}" opacity="0.5" rx="1"/>
    <rect x="65" y="128" width="10" height="22" fill="${gc}" opacity="0.7" rx="1"/>
    <rect x="85" y="116" width="10" height="34" fill="${gc}" opacity="0.95" rx="1"/>
    <rect x="148" y="18" width="138" height="130" rx="6" fill="#0d0b2a" opacity="0.8"/>
    <text x="217" y="34" fill="${c}88" font-size="9" text-anchor="middle" font-family="system-ui">🌑 量×3爆 RSI≥70</text>
    <text x="217" y="100" font-size="38" text-anchor="middle" ${on?'filter="url(#'+id+')'+'"' : ''}>😑</text>
    <text x="217" y="132" fill="${c}" font-size="10" text-anchor="middle" font-weight="600" font-family="system-ui">閉眼買進</text>
    <line x1="136" y1="88" x2="148" y2="88" stroke="${c}" stroke-width="1.5" marker-end="url(#a${id})"/>
    <text x="150" y="170" fill="${c}" font-size="10" text-anchor="middle" font-weight="600" font-family="system-ui">已飆繼續飆 → 系統A 抱長</text>
  </svg>`;
}

function _svgX3(c, cDim, on) {
  const id = 'x3' + Math.random().toString(36).slice(2,6);
  const glow = on ? `<filter id="${id}"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  return `<svg viewBox="0 0 300 175" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block"><defs>${glow}</defs>
    <polyline points="18,38 50,58 82,80 112,108 135,130" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="80" y="115" width="88" height="34" rx="4" fill="#ef444418" stroke="#ef444466" stroke-width="1" stroke-dasharray="4,3"/>
    <text x="124" y="136" fill="#f87171" font-size="9" text-anchor="middle" font-family="system-ui">RSI &lt; 30 超賣區</text>
    <polyline points="135,130 162,110 192,88 222,66 250,46" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="127" y="142" width="14" height="22" fill="${c}" opacity="0.7" rx="2"/>
    <text x="134" y="170" fill="${c}88" font-size="8" text-anchor="middle" font-family="system-ui">量×1.2</text>
    <text x="250" y="42" font-size="22" text-anchor="middle" ${on?'filter="url(#'+id+')'+'"' : ''}>👑</text>
    <text x="150" y="20" fill="${c}" font-size="10" text-anchor="middle" font-weight="600" font-family="system-ui">RSI 超賣反彈 → 炒底進場</text>
  </svg>`;
}

function _svgX4(c, cDim, on) {
  const id = 'x4' + Math.random().toString(36).slice(2,6);
  const glow = on ? `<filter id="${id}"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  const bar = (x, y, h, col, op) => `<rect x="${x}" y="${y}" width="22" height="${h}" fill="${col}" opacity="${op}" rx="2"/>`;
  return `<svg viewBox="0 0 300 175" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">
    <defs>${glow}<marker id="a${id}" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6Z" fill="${c}"/></marker></defs>
    <text x="40" y="162" fill="#34d39988" font-size="9" text-anchor="middle" font-family="system-ui">族群A</text>
    ${bar(18,118,37,'#34d399',0.5)}${bar(18,85,33,'#34d399',0.7)}${bar(18,52,33,'#34d399',0.9)}
    <text x="40" y="42" fill="#34d39988" font-size="9" text-anchor="middle" font-family="system-ui">RSI≥70</text>
    <text x="108" y="162" fill="#60a5fa88" font-size="9" text-anchor="middle" font-family="system-ui">族群B</text>
    ${bar(86,122,33,'#60a5fa',0.5)}${bar(86,85,37,'#60a5fa',0.7)}${bar(86,48,37,'#60a5fa',0.9)}
    <text x="108" y="38" fill="#60a5fa88" font-size="9" text-anchor="middle" font-family="system-ui">RSI≥70</text>
    <text x="176" y="162" fill="${c}88" font-size="9" text-anchor="middle" font-family="system-ui">本股</text>
    ${bar(154,125,28,'#6b728066',1)}${bar(154,117,8,'#6b728066',1)}${bar(154,109,8,'#6b728066',1)}
    <text x="176" y="100" fill="${c}88" font-size="9" text-anchor="middle" font-family="system-ui">RSI 40-60</text>
    <line x1="154" y1="118" x2="150" y2="118" stroke="${c}" stroke-width="1.5" stroke-dasharray="3,2" marker-end="url(#a${id})"/>
    <text x="252" y="108" font-size="26" text-anchor="middle" ${on?'filter="url(#'+id+')'+'"' : ''}>🙋</text>
    <text x="252" y="130" fill="${c}" font-size="9" text-anchor="middle" font-family="system-ui">輪到我了？</text>
    <text x="150" y="20" fill="${c}" font-size="10" text-anchor="middle" font-weight="600" font-family="system-ui">族群輪動 → 補漲進場</text>
  </svg>`;
}

function _svgX5(c, cDim, on) {
  const id = 'x5' + Math.random().toString(36).slice(2,6);
  const glow = on ? `<filter id="${id}"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  const kx = [18,36,54,72,90,108,126,144,162,180];
  const kCl = [132,128,125,122,118,113,107,100,90,74];
  const kOp = [138,135,132,128,125,119,114,108,100,90];
  const vH  = [7,8,9,10,11,12,14,16,20,42];
  const bars = kx.map((x,i) => {
    const big = i===9; const fc = big?(on?c:'#9ca3af'):'#34d399';
    return `<line x1="${x+7}" y1="${kCl[i]-2}" x2="${x+7}" y2="${kOp[i]+2}" stroke="${fc}" stroke-width="1"/>
      <rect x="${x}" y="${kCl[i]}" width="14" height="${kOp[i]-kCl[i]}" fill="${fc}" opacity="${big?1:0.55+i*0.04}" rx="1"/>
      <rect x="${x}" y="${152-vH[i]}" width="14" height="${vH[i]}" fill="${fc}" opacity="${big?0.9:0.35}" rx="1"/>`;
  }).join('');
  return `<svg viewBox="0 0 300 175" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block"><defs>${glow}</defs>
    ${bars}
    <line x1="14" y1="142" x2="197" y2="142" stroke="#6b7280" stroke-width="1" stroke-dasharray="4,3"/>
    <text x="204" y="145" fill="#6b728088" font-size="8" font-family="system-ui">均量</text>
    <text x="196" y="118" fill="${c}" font-size="9" text-anchor="middle" font-weight="700" font-family="system-ui" ${on?'filter="url(#'+id+')'+'"' : ''}>×2.5</text>
    <path d="M18,130 Q80,122 140,108 Q170,100 196,90" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5,3"/>
    <text x="202" y="89" fill="#f59e0b" font-size="8" font-family="system-ui">MA20↑</text>
    <text x="250" y="90" font-size="28" text-anchor="middle" ${on?'filter="url(#'+id+')'+'"' : ''}>🚀</text>
    <text x="150" y="170" fill="${c}" font-size="10" text-anchor="middle" font-weight="600" font-family="system-ui">近期爆量 → 妖股先期</text>
  </svg>`;
}

// ═══════════════════════════════════════════════════════
// ④ 策略說明卡
// ═══════════════════════════════════════════════════════
function _renderStrategyCards() {
  const cards = X_STRATEGIES.map(x => `
    <div class="xs-strat-card">
      <div class="xs-strat-hd">
        <span class="xs-strat-icon">${x.icon}</span>
        <span class="xs-strat-name" style="color:${x.color}">${x.name}</span>
        <span class="xs-strat-tag">${x.tagline}</span>
      </div>
      <div class="xs-strat-cond"><span class="xs-strat-lbl">條件</span>${x.conds}</div>
      <div class="xs-strat-desc">${x.desc}</div>
      <div class="xs-strat-ft">
        <span class="xs-strat-sys">系統 ${x.system}</span>
        <span class="xs-strat-exit">出場：${x.exitRule}</span>
        <span class="xs-strat-bt">${x.backtest}</span>
      </div>
    </div>`).join('');
  return `<div class="xs-board-title" style="margin-top:22px">📋 策略說明</div>
    <div class="xs-strat-list">${cards}</div>`;
}

// ═══════════════════════════════════════════════════════
// ⑤ 回測表
// ═══════════════════════════════════════════════════════
function _renderBacktestTable() {
  return `
    <div class="xs-board-title" style="margin-top:22px">📊 實證數據（20檔 basket，1年回測）</div>
    <table class="xs-bt-table">
      <thead><tr><th>策略</th><th>出場方式</th><th>勝率</th><th>報酬</th><th>持有</th></tr></thead>
      <tbody>
        <tr class="is-hl"><td>🌑 X2 天黑</td><td>S40出場</td><td>60%</td><td class="pos">+43.7%</td><td>~48天</td></tr>
        <tr><td>🌑 X2 天黑</td><td>固定20天</td><td>55%</td><td class="pos">+13.4%</td><td>20天</td></tr>
        <tr class="is-hl"><td>🚀 X5 量證明</td><td>固定20天</td><td class="pos">65.5%</td><td class="pos">+19.4%</td><td>20天</td></tr>
        <tr><td>🚀 X5 量證明</td><td>S40出場</td><td>58.6%</td><td class="pos">+41.6%</td><td>~56天</td></tr>
        <tr><td>🪙 X1 黃金</td><td>固定20天</td><td>~60%</td><td class="pos">+12%+</td><td>20天</td></tr>
        <tr><td>🪂 X3 / 🚦 X4</td><td colspan="4" style="color:var(--muted);text-align:center">實驗中</td></tr>
      </tbody>
    </table>
    <div class="xs-bt-note">※ S40 紅三兵：+59.9% 來自「W6進場抱長60天到S40出場」整段報酬，作為出場最佳；作為進場訊號僅 +4.1%，方向完全相反。</div>`;
}

// ═══════════════════════════════════════════════════════
// extraData for AI
// ═══════════════════════════════════════════════════════
function _buildExtraData(r) {
  const yi = r.yaoguInfo;
  const activeStr = r.activeStrats.map(x =>
    `${x.icon}${x.name}（${x.retained ? `DB保留·第${yi?.streak||1}天` : `K線觸發`}）`
  ).join('、') || '無';
  const goneStr = r.recentButGone.map(x => {
    const hist = r.histMap?.get(x.id);
    return `${x.icon}${x.name}（近期共${hist?.totalTriggers||0}次）`;
  }).join('、') || '無';
  return {
    '當前股票': r.code,
    '妖股狀態': yi ? `${yi.label} / ${yi.desc}${yi.streak ? ` / 第${yi.streak}天` : ''}` : '無記錄',
    '妖股強度': yi?.strength || '—',
    '今日有效 X 訊號（含DB保留）': activeStr,
    '近期曾觸發但今日消退': goneStr,
    '建議操作系統': r.opSys ? `${r.opSys.system} — ${r.opSys.action}` : '等待訊號',
    '歷史實證': r.opSys?.expected || '—',
    '策略背景': 'X1黃金比例三軸共振最穩；X2天黑請閉眼飆股加速60天甜蜜點+43.7%；X3炒底王V型反轉實驗中；X4族群輪動實驗中；X5量證明一切妖股先期固定20天勝率65.5%；S40作為出場最佳+59.9%，作為進場僅+4.1%；watching狀態觀察MA20不需急出',
  };
}

registerAnalysisModule(XSeriesModule);

// ─── yaoguUpdated 監聽器 ────────────────────────────────
// updateYaoguTracker 是非同步的，全視窗 evaluate() 跑時 AppState.yaoguStatus
// 可能還沒寫入 → X 系列訊號全部判為未觸發。
// yaoguUpdated 事件在 streak 算完後才發出，此時重刷全視窗確保拿到最新狀態。
document.addEventListener('yaoguUpdated', async (e) => {
  // 只在全視窗模式下重刷，且只在 xseries tab 是 active 或已渲染過時才需要
  const panel = document.getElementById('chartPanel');
  if (!panel?.classList.contains('fullscreen-mode')) return;

  // 動態 import 避免循環依賴（analysis-fullscreen.js → analysis-mod-xseries.js 已 import）
  try {
    const { refreshFullscreenAnalysis } = await import('../analysis-fullscreen.js');
    await refreshFullscreenAnalysis();
  } catch(e) {
    console.warn('[xseries] yaoguUpdated refresh failed:', e);
  }
});
