// js/loading-deng.js
// ============================================================================
// Phase 7.1 — 燈燈導讀系統（招財貓版）
// ============================================================================
// 把選股台從工具變成助手的核心。
//
// 對外 API:
//   showDengLoading(opts) → handle
//     opts: {
//       messages?: string[]    台詞陣列(會自動輪替)
//       scenario?: string      場景 key,從台詞庫挑(取代 messages)
//       style?:    'overlay'|'inline'|'toast'  (預設 'overlay')
//       target?:   string|HTMLElement   style='inline' 時的目標
//       mood?:     'happy'|'curious'|'tired'|'savage'|'sleepy'|'sad'
//       autoCycle?: boolean    自動輪替台詞(預設 true)
//       cycleMs?:   number     輪替間隔(預設 3500ms)
//     }
//
//   hideDengLoading(handle?)        // 不傳 handle = 收掉所有
//   updateDengMessage(text, mood)   // 換台詞 + 表情
//   dengToast(text, opts)           // 短暫提示(3 秒消失)
//   pickDengMessage(scenario)       // 從台詞庫挑一句(純函式)
//
// 場景 scenario:
//   loading        — 載入分析中
//   analyzing      — 在跑演算法
//   complete       — 解讀完成
//   stockGood      — 個股看起來不錯
//   stockBad       — 個股看起來不妙
//   error          — 失敗
//   noData         — 資料不足
//   wakeUp         — 從背景回來
//   idle           — 用戶閒置
//   greeting       — 第一次進入
// ============================================================================

import { DENG_MESSAGES } from './deng-messages.js';

// 模組狀態
let _svgCache = null;       // 已快取的 SVG 字串
let _activeHandles = new Set();
let _handleSeq = 0;
let _toastContainer = null;

// ============================================================================
// SVG 載入（純內嵌，不依賴外部檔案）
// ============================================================================
async function _loadSVG() {
  if (_svgCache) return _svgCache;
  _svgCache = _fallbackSVG();
  return _svgCache;
}

// 燈燈本體 SVG（招財貓版，右手招財搖擺，金幣元寶掉落）
function _fallbackSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 225" class="deng-svg" aria-label="燈燈">
  <defs>
    <radialGradient id="dHalo" cx="50%" cy="55%" r="48%">
      <stop offset="0%" stop-color="#f5a623" stop-opacity="0.12"/>
      <stop offset="70%" stop-color="#ef5350" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#ef5350" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="dBody" cx="42%" cy="20%" r="85%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#fbf9f4"/>
      <stop offset="80%" stop-color="#ece6da"/>
      <stop offset="100%" stop-color="#d2c8b6"/>
    </radialGradient>
    <radialGradient id="dFace" cx="44%" cy="26%" r="80%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#fcfaf6"/>
      <stop offset="85%" stop-color="#efe8dc"/>
      <stop offset="100%" stop-color="#d8ceba"/>
    </radialGradient>
    <linearGradient id="dScarf" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f25548"/>
      <stop offset="100%" stop-color="#c52f28"/>
    </linearGradient>
    <linearGradient id="dCushion" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ec6a52"/>
      <stop offset="100%" stop-color="#b8332a"/>
    </linearGradient>
    <radialGradient id="dBell" cx="32%" cy="25%" r="80%">
      <stop offset="0%" stop-color="#fff7c0"/>
      <stop offset="45%" stop-color="#f2c43a"/>
      <stop offset="100%" stop-color="#9c6c08"/>
    </radialGradient>
    <radialGradient id="dCoinSm" cx="35%" cy="25%" r="70%">
      <stop offset="0%" stop-color="#fff3a8"/>
      <stop offset="55%" stop-color="#f2c43a"/>
      <stop offset="100%" stop-color="#b07e08"/>
    </radialGradient>
    <radialGradient id="dCoinBig" cx="32%" cy="20%" r="80%">
      <stop offset="0%" stop-color="#fdf2b8"/>
      <stop offset="42%" stop-color="#eaba34"/>
      <stop offset="100%" stop-color="#855a00"/>
    </radialGradient>
    <radialGradient id="dIngot" cx="30%" cy="25%" r="70%">
      <stop offset="0%" stop-color="#fff8c0"/>
      <stop offset="60%" stop-color="#e8b820"/>
      <stop offset="100%" stop-color="#a06800"/>
    </radialGradient>
    <filter id="dSoft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
    <filter id="dSoft1" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="1.1"/>
    </filter>
    <style>
      @keyframes dengPawWave {
        0%,100% { transform: rotate(0deg); }
        35%     { transform: rotate(-20deg); }
        70%     { transform: rotate(4deg); }
      }
      .deng-paw-wave { transform-origin: 134px 152px; animation: dengPawWave 1.1s ease-in-out infinite; }
      @keyframes dengTailWag2 {
        0%,100% { transform: rotate(0deg); }
        30%     { transform: rotate(-7deg); }
        70%     { transform: rotate(7deg); }
      }
      .deng-tail { transform-origin: 58px 172px; animation: dengTailWag2 2.2s ease-in-out infinite; }
      @keyframes dengCoinFall1 { 0%{transform:translateY(-30px);opacity:0} 10%{opacity:1} 80%{opacity:1} 100%{transform:translateY(58px);opacity:0} }
      @keyframes dengCoinFall2 { 0%{transform:translateY(-20px) rotate(0deg);opacity:0} 10%{opacity:1} 80%{opacity:1} 100%{transform:translateY(52px) rotate(180deg);opacity:0} }
      @keyframes dengCoinFall3 { 0%{transform:translateY(-35px);opacity:0} 15%{opacity:1} 80%{opacity:1} 100%{transform:translateY(60px);opacity:0} }
      @keyframes dengIngotFall { 0%{transform:translateY(-28px);opacity:0} 12%{opacity:1} 80%{opacity:1} 100%{transform:translateY(55px);opacity:0} }
      .dc1{animation:dengCoinFall1 2.0s ease-in infinite;animation-delay:0.0s}
      .dc2{animation:dengCoinFall2 2.0s ease-in infinite;animation-delay:0.7s}
      .dc3{animation:dengCoinFall3 2.0s ease-in infinite;animation-delay:1.3s}
      .dc4{animation:dengCoinFall1 2.0s ease-in infinite;animation-delay:0.4s}
      .di1{animation:dengIngotFall 2.4s ease-in infinite;animation-delay:0.2s}
      .di2{animation:dengIngotFall 2.4s ease-in infinite;animation-delay:1.5s}
    </style>
  </defs>

  <!-- 光暈 -->
  <circle cx="100" cy="118" r="84" fill="url(#dHalo)"/>
  <circle cx="100" cy="118" r="81" fill="none" stroke="#d4a843" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.5"/>

  <!-- 漲停箭頭 -->
  <g fill="#ef5350" opacity="0.7">
    <polygon points="100,4 96.5,14 103.5,14"/><line x1="100" y1="15" x2="100" y2="26" stroke="#ef5350" stroke-width="1.4"/>
    <polygon points="128,10 124.5,20 131.5,20"/><line x1="128" y1="21" x2="128" y2="30" stroke="#ef5350" stroke-width="1.4"/>
    <polygon points="160,16 156.5,26 163.5,26"/><line x1="160" y1="27" x2="160" y2="36" stroke="#ef5350" stroke-width="1.4"/>
  </g>

  <!-- 0. 紅座墊 -->
  <g>
    <ellipse cx="100" cy="208" rx="64" ry="8" fill="#000000" opacity="0.35" filter="url(#dSoft)"/>
    <ellipse cx="100" cy="205" rx="62" ry="13" fill="url(#dCushion)" stroke="#992a22" stroke-width="1"/>
    <ellipse cx="100" cy="201" rx="56" ry="9" fill="#f4836a" opacity="0.6"/>
    <circle cx="42" cy="207" r="2.4" fill="#f2c43a"/>
    <circle cx="158" cy="207" r="2.4" fill="#f2c43a"/>
    <g fill="#f6d98a" opacity="0.6">
      <circle cx="72" cy="206" r="1.4"/><circle cx="100" cy="209" r="1.4"/><circle cx="128" cy="206" r="1.4"/>
    </g>
  </g>

  <!-- 1. 尾巴 -->
  <g class="deng-tail">
    <path d="M 54,174 Q 26,184 24,162 Q 23,142 48,145 Q 66,147 64,164" fill="#f0eadf" stroke="#b8ae9c" stroke-width="1"/>
    <path d="M 55,171 Q 35,178 35,162 Q 36,151 50,153" fill="#fcfaf6"/>
  </g>

  <!-- 2. 身體 -->
  <ellipse cx="100" cy="166" rx="55" ry="41" fill="url(#dBody)" stroke="#aaa08c" stroke-width="1.1"/>
  <path d="M 48,178 Q 60,204 100,206 Q 140,204 152,178 Q 142,200 100,202 Q 58,200 48,178Z" fill="#a89a80" opacity="0.32" filter="url(#dSoft1)"/>
  <ellipse cx="82" cy="138" rx="26" ry="12" fill="#ffffff" opacity="0.6" filter="url(#dSoft1)"/>
  <ellipse cx="100" cy="176" rx="33" ry="24" fill="#ffffff" opacity="0.85"/>



  <!-- 5a. 貓耳（畫在頭後面，尖三角＋紅內耳） -->
  <g>
    <path d="M 60,82 Q 50,52 58,44 Q 66,38 80,62 Q 72,72 64,80Z" fill="#fcfaf6" stroke="#aaa08c" stroke-width="1.1"/>
    <path d="M 61,76 Q 56,56 60,50 Q 66,46 74,62Z" fill="#e84a3c"/>
    <path d="M 140,82 Q 150,52 142,44 Q 134,38 120,62 Q 128,72 136,80Z" fill="#fcfaf6" stroke="#aaa08c" stroke-width="1.1"/>
    <path d="M 139,76 Q 144,56 140,50 Q 134,46 126,62Z" fill="#e84a3c"/>
  </g>

  <!-- 5b. 頭部 -->
  <ellipse cx="100" cy="100" rx="49" ry="44" fill="url(#dFace)" stroke="#aaa08c" stroke-width="1.1"/>
  <path d="M 54,112 Q 62,138 100,142 Q 138,138 146,112 Q 140,134 100,138 Q 60,134 54,112Z" fill="#a89a80" opacity="0.28" filter="url(#dSoft1)"/>
  <ellipse cx="82" cy="72" rx="24" ry="13" fill="#ffffff" opacity="0.75" filter="url(#dSoft1)"/>

  <!-- 蓬鬆頰毛（金吉拉特徵：兩側炸毛） -->
  <g fill="#fcfaf6" stroke="#b8ae9c" stroke-width="0.7">
    <path d="M 54,98 Q 44,96 40,102 Q 48,103 52,106 Q 42,108 40,114 Q 50,114 54,116 Q 46,120 46,126 Q 56,123 60,122Z"/>
    <path d="M 146,98 Q 156,96 160,102 Q 152,103 148,106 Q 158,108 160,114 Q 150,114 146,116 Q 154,120 154,126 Q 144,123 140,122Z"/>
  </g>
  <ellipse cx="66" cy="111" rx="16" ry="12" fill="#ffffff" opacity="0.9"/>
  <ellipse cx="134" cy="111" rx="16" ry="12" fill="#ffffff" opacity="0.9"/>
  <ellipse cx="69" cy="115" rx="9" ry="5.5" fill="#f0907e" opacity="0.5" filter="url(#dSoft1)"/>
  <ellipse cx="131" cy="115" rx="9" ry="5.5" fill="#f0907e" opacity="0.5" filter="url(#dSoft1)"/>

  <!-- 鬍鬚 -->
  <g stroke="#a89a80" stroke-width="1" opacity="0.9" stroke-linecap="round">
    <path d="M 50,103 Q 65,105 80,107" fill="none"/>
    <path d="M 49,110 Q 64,111 80,111" fill="none"/>
    <path d="M 51,117 Q 66,116 80,115" fill="none"/>
    <path d="M 120,107 Q 135,105 150,103" fill="none"/>
    <path d="M 120,111 Q 136,111 151,110" fill="none"/>
    <path d="M 120,115 Q 134,116 149,117" fill="none"/>
  </g>

  <!-- 眼睛（粗笑弧） -->
  <g class="deng-eyes deng-eyes-default" stroke="#2e2a26" stroke-linecap="round" fill="none">
    <path d="M 72,100 Q 84,89 96,99" stroke-width="4.2"/>
    <path d="M 104,99 Q 116,89 128,100" stroke-width="4.2"/>
  </g>
  <!-- 眼尾紅勾（招財貓特徵） -->
  <g stroke="#e05545" stroke-width="1.6" stroke-linecap="round" fill="none" opacity="0.9">
    <path d="M 66,96 Q 62,93 61,89"/>
    <path d="M 134,96 Q 138,93 139,89"/>
  </g>

  <!-- 金鼻子＋嘴巴 -->
  <ellipse cx="100" cy="111" rx="4.5" ry="3.4" fill="url(#dBell)" stroke="#8c6200" stroke-width="0.7"/>
  <ellipse cx="98.5" cy="110" rx="1.6" ry="1" fill="#fff7c8" opacity="0.9"/>
  <line x1="100" y1="114.4" x2="100" y2="118.5" stroke="#bb9a78" stroke-width="0.9"/>
  <g class="deng-mouth">
    <path d="M 90,119 Q 95,127 100,123.5 Q 105,127 110,119" fill="none" stroke="#c8584a" stroke-width="1.8" stroke-linecap="round"/>
  </g>

  <!-- 紅項圈＋鈴鐺 -->
  <path d="M 62,132 Q 100,143 138,132 Q 135,145 100,149 Q 65,145 62,132Z" fill="url(#dScarf)" stroke="#a82e24" stroke-width="0.9"/>
  <path d="M 66,134 Q 100,143 134,134" fill="none" stroke="#ffd0b8" stroke-width="1" opacity="0.45"/>
  <ellipse cx="101.5" cy="146" rx="7.5" ry="6.5" fill="#5a3c00" opacity="0.45" filter="url(#dSoft1)"/>
  <circle cx="100" cy="144" r="7.5" fill="url(#dBell)" stroke="#7e5800" stroke-width="1.1"/>
  <ellipse cx="96.5" cy="140.5" rx="2.8" ry="2" fill="#fffbe0" opacity="0.95"/>
  <line x1="93" y1="145.5" x2="107" y2="145.5" stroke="#7a5200" stroke-width="0.8" opacity="0.7"/>
  <circle cx="100" cy="148" r="1.5" fill="#6e4a00"/>

  <!-- 坐姿前腳（紅趾線） -->
  <ellipse cx="76" cy="197" rx="16" ry="9" fill="#fcfaf6" stroke="#aaa08c" stroke-width="1"/>
  <ellipse cx="124" cy="197" rx="16" ry="9" fill="#fcfaf6" stroke="#aaa08c" stroke-width="1"/>
  <ellipse cx="71" cy="193" rx="8" ry="3.5" fill="#ffffff" opacity="0.75"/>
  <ellipse cx="119" cy="193" rx="8" ry="3.5" fill="#ffffff" opacity="0.75"/>
  <path d="M 67,197 Q 69,202 73,201" fill="none" stroke="#e0705e" stroke-width="1"/>
  <path d="M 74,200 Q 76,204 80,203" fill="none" stroke="#e0705e" stroke-width="1"/>
  <path d="M 114,200 Q 116,204 120,203" fill="none" stroke="#e0705e" stroke-width="1"/>
  <path d="M 121,197 Q 123,202 127,201" fill="none" stroke="#e0705e" stroke-width="1"/>

  <!-- 大金幣牌（身前落地，左手前扶，最前層） -->
  <g>
    <ellipse cx="60" cy="203" rx="27" ry="5" fill="#000000" opacity="0.4" filter="url(#dSoft1)"/>
    <ellipse cx="58" cy="163" rx="28" ry="41" fill="#5a3c00" opacity="0.5" filter="url(#dSoft1)" transform="translate(2,3)"/>
    <ellipse cx="58" cy="163" rx="28" ry="41" fill="url(#dCoinBig)" stroke="#7e5800" stroke-width="1.6"/>
    <ellipse cx="58" cy="163" rx="22" ry="34" fill="none" stroke="#8c6200" stroke-width="0.9" opacity="0.55"/>
    <ellipse cx="49" cy="139" rx="10" ry="17" fill="#fffbd8" opacity="0.65" filter="url(#dSoft1)"/>
    <text x="58" y="148" text-anchor="middle" font-size="14" font-weight="bold" fill="#5e3200" font-family="serif">千</text>
    <text x="58" y="166" text-anchor="middle" font-size="14" font-weight="bold" fill="#5e3200" font-family="serif">万</text>
    <text x="58" y="184" text-anchor="middle" font-size="14" font-weight="bold" fill="#5e3200" font-family="serif">両</text>
  </g>
  <!-- 左掌扣金幣上緣（手臂藏金幣後，只露掌） -->
  <ellipse cx="64" cy="126" rx="9" ry="7" fill="#fcfaf6" stroke="#aaa08c" stroke-width="1" transform="rotate(-30 64 126)"/>
  <ellipse cx="61.5" cy="123" rx="3.6" ry="2.1" fill="#ffffff" opacity="0.85" transform="rotate(-30 61.5 123)"/>
  <path d="M 58,129 Q 59,132.5 61.5,131.5" fill="none" stroke="#e0705e" stroke-width="1"/>
  <path d="M 63,130 Q 64,133.5 66.5,132.5" fill="none" stroke="#e0705e" stroke-width="1"/>
  <path d="M 68,128.5 Q 69,132 71,131" fill="none" stroke="#e0705e" stroke-width="1"/>

  <!-- 6. 右搖手 -->
  <g class="deng-paw-wave">
    <path d="M 134,152 Q 151,147 147,127" stroke="#d8cfbe" stroke-width="14" stroke-linecap="round" fill="none"/>
    <path d="M 134,152 Q 151,147 147,127" stroke="#fcfaf6" stroke-width="9" stroke-linecap="round" fill="none"/>
    <ellipse cx="145" cy="122" rx="12.5" ry="10.5" fill="#fcfaf6" stroke="#aaa08c" stroke-width="1"/>
    <ellipse cx="141" cy="117" rx="5" ry="3" fill="#ffffff" opacity="0.85"/>
    <ellipse cx="145" cy="124.5" rx="5.8" ry="4.6" fill="#ef9486" opacity="0.85"/>
    <circle cx="138.5" cy="118.5" r="2.2" fill="#ef9486" opacity="0.8"/>
    <circle cx="145" cy="116.5" r="2.2" fill="#ef9486" opacity="0.8"/>
    <circle cx="151.5" cy="118.5" r="2.2" fill="#ef9486" opacity="0.8"/>
  </g>

  <!-- 7. 掉落金幣元寶 -->
  <g class="dc1"><circle cx="168" cy="48" r="7.5" fill="url(#dCoinSm)" stroke="#8c6200" stroke-width="0.9"/><text x="168" y="51" text-anchor="middle" font-size="5.5" fill="#6e3a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="dc2"><circle cx="26" cy="55" r="6.5" fill="url(#dCoinSm)" stroke="#8c6200" stroke-width="0.9"/><text x="26" y="58" text-anchor="middle" font-size="5" fill="#6e3a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="dc3"><circle cx="174" cy="62" r="7.5" fill="url(#dCoinSm)" stroke="#8c6200" stroke-width="0.9"/><text x="174" y="65" text-anchor="middle" font-size="5.5" fill="#6e3a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="dc4"><circle cx="20" cy="40" r="6.5" fill="url(#dCoinSm)" stroke="#8c6200" stroke-width="0.9"/><text x="20" y="43" text-anchor="middle" font-size="5" fill="#6e3a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="di1"><rect x="156" y="72" width="18" height="9" rx="2" fill="url(#dIngot)" stroke="#8c6200" stroke-width="0.7"/><ellipse cx="165" cy="72" rx="11" ry="5" fill="url(#dIngot)" stroke="#8c6200" stroke-width="0.7"/><ellipse cx="165" cy="71" rx="7" ry="3" fill="#fff8c0" opacity="0.55"/></g>
  <g class="di2"><rect x="22" y="66" width="18" height="9" rx="2" fill="url(#dIngot)" stroke="#8c6200" stroke-width="0.7"/><ellipse cx="31" cy="66" rx="11" ry="5" fill="url(#dIngot)" stroke="#8c6200" stroke-width="0.7"/><ellipse cx="31" cy="65" rx="7" ry="3" fill="#fff8c0" opacity="0.55"/></g>
</svg>`;
}

// ============================================================================
// 台詞挑選
// ============================================================================
export function pickDengMessage(scenario, opts = {}) {
  const lib = DENG_MESSAGES[scenario];
  if (!lib || !lib.length) return '喵 ~';

  // 毒舌混合策略:從台詞庫的 cute 跟 savage 隨機抽
  const savageRatio = opts.savageRatio ?? 0.3;
  const cute = lib.filter(m => m.tone !== 'savage');
  const savage = lib.filter(m => m.tone === 'savage');

  const useSavage = savage.length > 0 && Math.random() < savageRatio;
  const pool = useSavage ? savage : (cute.length ? cute : lib);
  const picked = pool[Math.floor(Math.random() * pool.length)];

  return picked.text;
}

// ============================================================================
// 主要 API:showDengLoading
// ============================================================================
export async function showDengLoading(opts = {}) {
  const style = opts.style || 'overlay';
  const handleId = ++_handleSeq;

  const svgText = await _loadSVG();
  const messages = opts.messages || (opts.scenario ? _buildMessagesForScenario(opts.scenario) : [pickDengMessage('loading')]);
  const mood = opts.mood || 'curious';

  let el;
  if (style === 'overlay') {
    el = _createOverlay(svgText, messages, mood);
    document.body.appendChild(el);
  } else if (style === 'inline') {
    const target = typeof opts.target === 'string'
      ? document.querySelector(opts.target)
      : opts.target;
    if (!target) {
      console.warn('[deng] inline target not found:', opts.target);
      return null;
    }
    el = _createInline(svgText, messages, mood);
    target.appendChild(el);
  } else if (style === 'toast') {
    el = _createToast(svgText, messages[0], mood, opts);
    _appendToast(el);
  }

  el.dataset.dengHandle = handleId;
  el.dataset.dengStyle = style;

  // 自動輪替台詞
  let cycleTimer = null;
  if (opts.autoCycle !== false && messages.length > 1 && style !== 'toast') {
    let idx = 0;
    cycleTimer = setInterval(() => {
      idx = (idx + 1) % messages.length;
      _updateMessageText(el, messages[idx]);
    }, opts.cycleMs || 3500);
  }

  const handle = {
    id: handleId,
    el,
    style,
    cycleTimer,
    setMessage: (text, m) => _updateMessageContent(el, text, m),
    setMood: (m) => _applyMood(el, m),
    close: () => hideDengLoading(handle),
  };
  _activeHandles.add(handle);

  // toast 自動消失
  if (style === 'toast') {
    const duration = opts.duration || 3000;
    setTimeout(() => hideDengLoading(handle), duration);
  }

  // 進入動畫
  requestAnimationFrame(() => {
    el.classList.add('deng-shown');
  });

  return handle;
}

// ============================================================================
// hideDengLoading
// ============================================================================
export function hideDengLoading(handle) {
  if (handle) {
    _closeOne(handle);
  } else {
    // 收掉所有
    for (const h of _activeHandles) _closeOne(h);
  }
}

function _closeOne(handle) {
  if (!_activeHandles.has(handle)) return;
  _activeHandles.delete(handle);
  if (handle.cycleTimer) { clearInterval(handle.cycleTimer); handle.cycleTimer = null; }
  if (!handle.el) return;
  handle.el.classList.remove('deng-shown');
  handle.el.classList.add('deng-hiding');
  setTimeout(() => {
    if (handle.el && handle.el.parentNode) {
      handle.el.parentNode.removeChild(handle.el);
    }
  }, 250);
}

// ============================================================================
// updateDengMessage / Toast
// ============================================================================
export function updateDengMessage(text, mood) {
  // 更新所有目前顯示的燈燈
  for (const h of _activeHandles) {
    if (h.style !== 'toast') {
      _updateMessageContent(h.el, text, mood);
    }
  }
}

export function dengToast(text, opts = {}) {
  return showDengLoading({
    style: 'toast',
    messages: [text],
    mood: opts.mood || 'happy',
    duration: opts.duration || 3000,
    action: opts.action,
    ...opts,
  });
}

// ============================================================================
// 元素建構
// ============================================================================
function _createOverlay(svgText, messages, mood) {
  const wrap = document.createElement('div');
  wrap.className = 'deng-overlay';
  wrap.innerHTML = `
    <div class="deng-overlay-card">
      <div class="deng-avatar deng-mood-${mood} deng-blink-loop deng-tail-wag deng-talk">
        ${svgText}
      </div>
      <div class="deng-bubble">
        <div class="deng-message">${_escape(messages[0] || '')}</div>
        <div class="deng-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
  _applyMood(wrap, mood);
  return wrap;
}

function _createInline(svgText, messages, mood) {
  const wrap = document.createElement('div');
  wrap.className = 'deng-inline';
  wrap.innerHTML = `
    <div class="deng-avatar deng-mood-${mood} deng-blink-loop">
      ${svgText}
    </div>
    <div class="deng-bubble">
      <div class="deng-message">${_escape(messages[0] || '')}</div>
      <div class="deng-dots"><span></span><span></span><span></span></div>
    </div>
  `;
  _applyMood(wrap, mood);
  return wrap;
}

function _createToast(svgText, message, mood, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'deng-toast';
  wrap.innerHTML = `
    <div class="deng-avatar deng-avatar-small deng-mood-${mood} deng-blink-loop">
      ${svgText}
    </div>
    <div class="deng-toast-body">
      <div class="deng-message">${_escape(message)}</div>
      ${opts.action ? `<button class="deng-toast-action">${_escape(opts.action.label)}</button>` : ''}
    </div>
    <button class="deng-toast-close" aria-label="關閉">×</button>
  `;
  _applyMood(wrap, mood);

  // 綁定 action
  if (opts.action) {
    wrap.querySelector('.deng-toast-action')?.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.action.callback?.();
      const handle = [..._activeHandles].find(h => h.el === wrap);
      if (handle) hideDengLoading(handle);
    });
  }
  wrap.querySelector('.deng-toast-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const handle = [..._activeHandles].find(h => h.el === wrap);
    if (handle) hideDengLoading(handle);
  });

  return wrap;
}

function _appendToast(el) {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.className = 'deng-toast-container';
    document.body.appendChild(_toastContainer);
  }
  _toastContainer.appendChild(el);
}

// ============================================================================
// 內部:更新文字 / 表情
// ============================================================================
function _updateMessageText(el, text) {
  const m = el.querySelector('.deng-message');
  if (!m) return;
  m.style.opacity = 0;
  setTimeout(() => {
    m.textContent = text;
    m.style.opacity = 1;
  }, 150);
}

function _updateMessageContent(el, text, mood) {
  if (text != null) _updateMessageText(el, text);
  if (mood) _applyMood(el, mood);
}

function _applyMood(el, mood) {
  const avatar = el.querySelector('.deng-avatar') || el;
  for (const m of ['happy', 'curious', 'tired', 'savage', 'sleepy', 'sad']) {
    avatar.classList.remove('deng-mood-' + m);
  }
  avatar.classList.add('deng-mood-' + mood);

  // SVG eyes group 切換
  const eyesGroups = avatar.querySelectorAll('.deng-eyes');
  eyesGroups.forEach(g => {
    const isTarget = (mood === 'happy' && g.classList.contains('deng-eyes-default')) ||
                     (mood === 'curious' && g.classList.contains('deng-eyes-default')) ||
                     g.classList.contains('deng-eyes-' + mood);
    g.style.display = isTarget ? '' : 'none';
  });
}

function _escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ============================================================================
// 內部:依場景組裝多句台詞
// ============================================================================
function _buildMessagesForScenario(scenario) {
  // 從場景庫隨機抽 3 句作為輪替序列
  const lib = DENG_MESSAGES[scenario];
  if (!lib || !lib.length) return [pickDengMessage('loading')];

  const out = [];
  const used = new Set();
  while (out.length < Math.min(3, lib.length) && used.size < lib.length) {
    const idx = Math.floor(Math.random() * lib.length);
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(lib[idx].text);
  }
  return out;
}

// ============================================================================
// 喚醒系統(D6)
// ============================================================================
let _wakeupInited = false;
const WAKEUP_THRESHOLD_MS = 5 * 60 * 1000;   // 5 分鐘以上才提示
const WAKEUP_SHORT_MS = 60 * 1000;            // 1 分鐘以上歡迎回來

export function initDengWakeup() {
  if (_wakeupInited) return;
  _wakeupInited = true;

  // 初始化時記錄
  sessionStorage.setItem('dengLastSeen', String(Date.now()));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const lastSeen = +sessionStorage.getItem('dengLastSeen') || Date.now();
      const elapsed = Date.now() - lastSeen;

      if (elapsed > WAKEUP_THRESHOLD_MS) {
        const minutes = Math.floor(elapsed / 60000);
        dengToast(`歐 ~ 你回來啦,離開 ${minutes} 分鐘了 K 線都變了喔`, {
          mood: 'sleepy',
          duration: 8000,
          action: {
            label: '幫我刷新',
            callback: () => {
              if (typeof window.reloadCurrentStock === 'function') {
                window.reloadCurrentStock();
              } else {
                location.reload();
              }
            },
          },
        });
      } else if (elapsed > WAKEUP_SHORT_MS) {
        dengToast(pickDengMessage('wakeUp') || '歡迎回來喵 ~', {
          mood: 'happy',
          duration: 3000,
        });
      }
      sessionStorage.setItem('dengLastSeen', String(Date.now()));
    } else {
      sessionStorage.setItem('dengLastSeen', String(Date.now()));
    }
  });

  // 閒置偵測(用戶 5 分鐘沒滑鼠/觸控)
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      dengToast(pickDengMessage('idle'), { mood: 'sleepy', duration: 4000 });
    }, 5 * 60 * 1000);
  };
  ['mousemove', 'touchstart', 'keydown', 'scroll'].forEach(ev => {
    document.addEventListener(ev, resetIdle, { passive: true });
  });
  resetIdle();
}
