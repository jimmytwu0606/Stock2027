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
    <radialGradient id="dHalo" cx="50%" cy="55%" r="45%">
      <stop offset="0%" stop-color="#ef5350" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#ef5350" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="dBody" cx="50%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#dcdce8"/>
    </radialGradient>
    <radialGradient id="dFace" cx="50%" cy="38%" r="55%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e8e8f2"/>
    </radialGradient>
    <radialGradient id="dCoinSm" cx="35%" cy="25%" r="65%">
      <stop offset="0%" stop-color="#fff0a0"/>
      <stop offset="55%" stop-color="#f0c030"/>
      <stop offset="100%" stop-color="#b07800"/>
    </radialGradient>
    <radialGradient id="dCoinBig" cx="30%" cy="25%" r="65%">
      <stop offset="0%" stop-color="#fff5b0"/>
      <stop offset="50%" stop-color="#e8b820"/>
      <stop offset="100%" stop-color="#a06800"/>
    </radialGradient>
    <radialGradient id="dIngot" cx="30%" cy="25%" r="65%">
      <stop offset="0%" stop-color="#fff8c0"/>
      <stop offset="60%" stop-color="#e8b820"/>
      <stop offset="100%" stop-color="#a06800"/>
    </radialGradient>
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
  <circle cx="100" cy="118" r="82" fill="url(#dHalo)"/>
  <circle cx="100" cy="118" r="81" fill="none" stroke="#d4a843" stroke-width="0.7" stroke-dasharray="3 2" opacity="0.6"/>

  <!-- 漲停箭頭 -->
  <g fill="#ef5350" opacity="0.65">
    <polygon points="100,4 97,14 103,14"/><line x1="100" y1="16" x2="100" y2="26" stroke="#ef5350" stroke-width="1.1"/>
    <polygon points="128,10 125,20 131,20"/><line x1="128" y1="22" x2="128" y2="30" stroke="#ef5350" stroke-width="1.1"/>
    <polygon points="160,16 157,26 163,26"/><line x1="160" y1="28" x2="160" y2="36" stroke="#ef5350" stroke-width="1.1"/>
  </g>

  <!-- 1. 尾巴（最底層） -->
  <g class="deng-tail">
    <path d="M 52,172 Q 28,182 26,164 Q 24,146 48,147 Q 64,146 64,162" fill="#d8d8e4" stroke="#b8b8c8" stroke-width="0.8"/>
    <path d="M 54,170 Q 34,178 35,162 Q 36,150 50,152" fill="#eeeef6"/>
  </g>

  <!-- 2. 身體 -->
  <ellipse cx="100" cy="168" rx="54" ry="40" fill="url(#dBody)" stroke="#c0c0cc" stroke-width="0.6"/>
  <ellipse cx="100" cy="175" rx="32" ry="24" fill="white" opacity="0.6"/>

  <!-- 3. 左手（扶金幣） -->
  <path d="M 60,154 Q 50,158 48,168" stroke="#d0d0dc" stroke-width="11" stroke-linecap="round" fill="none"/>
  <path d="M 60,154 Q 50,158 48,168" stroke="#f2f2f8" stroke-width="7" stroke-linecap="round" fill="none"/>
  <ellipse cx="47" cy="170" rx="11" ry="8" fill="#f2f2f8" stroke="#c0c0cc" stroke-width="0.7"/>

  <!-- 4. 大金幣牌（左手前） -->
  <ellipse cx="36" cy="155" rx="22" ry="34" fill="url(#dCoinBig)" stroke="#a07000" stroke-width="1.2"/>
  <ellipse cx="36" cy="155" rx="17" ry="28" fill="none" stroke="#a07000" stroke-width="0.7" opacity="0.5"/>
  <text x="36" y="142" text-anchor="middle" font-size="10" font-weight="bold" fill="#7a3a00" font-family="serif">千</text>
  <text x="36" y="156" text-anchor="middle" font-size="10" font-weight="bold" fill="#7a3a00" font-family="serif">万</text>
  <text x="36" y="170" text-anchor="middle" font-size="10" font-weight="bold" fill="#7a3a00" font-family="serif">兩</text>

  <!-- 5. 頭部 -->
  <ellipse cx="100" cy="100" rx="48" ry="44" fill="url(#dFace)" stroke="#c0c0cc" stroke-width="0.5"/>

  <!-- 頭頂蓬毛 -->
  <path d="M 68,62 Q 66,50 74,54 Q 72,42 80,50 Q 80,38 88,48 Q 90,36 96,46 Q 102,36 104,48 Q 112,38 112,50 Q 120,42 118,54 Q 126,50 124,62" fill="#eeeef6" stroke="#c8c8d4" stroke-width="0.5"/>
  <path d="M 72,64 Q 71,54 78,57 Q 77,46 84,53 Q 84,42 91,51 Q 93,39 96,48 Q 99,39 101,51 Q 108,42 108,53 Q 115,46 114,57 Q 121,54 120,64" fill="#f8f8fc"/>

  <!-- 耳朵 -->
  <path d="M 58,80 Q 48,58 62,52 Q 74,46 77,68 Q 70,74 64,80" fill="#d8d8e4" stroke="#b8b8c8" stroke-width="0.7"/>
  <path d="M 61,78 Q 54,62 64,57 Q 73,52 76,68" fill="#f0c0c8" opacity="0.5"/>
  <path d="M 142,80 Q 152,58 138,52 Q 126,46 123,68 Q 130,74 136,80" fill="#d8d8e4" stroke="#b8b8c8" stroke-width="0.7"/>
  <path d="M 139,78 Q 146,62 136,57 Q 127,52 124,68" fill="#f0c0c8" opacity="0.5"/>

  <!-- 臉頰毛 -->
  <ellipse cx="66" cy="108" rx="17" ry="13" fill="#f0f0f8" opacity="0.8"/>
  <ellipse cx="134" cy="108" rx="17" ry="13" fill="#f0f0f8" opacity="0.8"/>
  <ellipse cx="68" cy="113" rx="9" ry="5.5" fill="#f4b0b8" opacity="0.22"/>
  <ellipse cx="132" cy="113" rx="9" ry="5.5" fill="#f4b0b8" opacity="0.22"/>

  <!-- 鬍鬚 -->
  <g stroke="#d8d8e0" stroke-width="0.5" opacity="0.85">
    <line x1="53" y1="107" x2="82" y2="110"/>
    <line x1="52" y1="111" x2="81" y2="113"/>
    <line x1="54" y1="115" x2="82" y2="116"/>
    <line x1="118" y1="110" x2="147" y2="107"/>
    <line x1="119" y1="113" x2="148" y2="111"/>
    <line x1="118" y1="116" x2="146" y2="115"/>
  </g>

  <!-- 眼睛（笑瞇瞇） -->
  <g class="deng-eyes deng-eyes-default">
    <path d="M 76,100 Q 86,92 96,99" fill="none" stroke="#3a3a4a" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M 78,99 Q 76,93 80,91" fill="none" stroke="#3a3a4a" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M 84,95 Q 83,89 87,88" fill="none" stroke="#3a3a4a" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M 91,94 Q 92,88 96,88" fill="none" stroke="#3a3a4a" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M 104,99 Q 114,92 124,99" fill="none" stroke="#3a3a4a" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M 122,99 Q 124,93 120,91" fill="none" stroke="#3a3a4a" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M 116,95 Q 117,89 113,88" fill="none" stroke="#3a3a4a" stroke-width="0.9" stroke-linecap="round"/>
    <path d="M 109,94 Q 108,88 104,88" fill="none" stroke="#3a3a4a" stroke-width="0.9" stroke-linecap="round"/>
  </g>

  <!-- 鼻子嘴巴 -->
  <path d="M 97,112 Q 100,109 103,112 Q 101,115 100,116 Q 99,115 97,112Z" fill="#e8a0a8" stroke="#c07888" stroke-width="0.4"/>
  <line x1="100" y1="116" x2="100" y2="119" stroke="#c09090" stroke-width="0.7"/>
  <g class="deng-mouth">
    <path d="M 91,121 Q 96,128 100,125 Q 104,128 109,121" fill="none" stroke="#a08080" stroke-width="1.2" stroke-linecap="round"/>
  </g>

  <!-- 紅領巾 -->
  <path d="M 64,132 Q 100,141 136,132 Q 132,143 100,147 Q 68,143 64,132Z" fill="#ef5350" opacity="0.88"/>
  <circle cx="100" cy="140" r="6" fill="url(#dCoinSm)" stroke="#a07000" stroke-width="0.8"/>
  <circle cx="100" cy="142" r="1.5" fill="#906000" opacity="0.5"/>

  <!-- 坐姿前腳 -->
  <ellipse cx="76" cy="198" rx="15" ry="8" fill="#f0f0f8" stroke="#c0c0cc" stroke-width="0.6"/>
  <ellipse cx="124" cy="198" rx="15" ry="8" fill="#f0f0f8" stroke="#c0c0cc" stroke-width="0.6"/>
  <path d="M 65,198 Q 67,203 72,202" fill="none" stroke="#a8a8b8" stroke-width="0.6"/>
  <path d="M 72,201 Q 74,205 79,204" fill="none" stroke="#a8a8b8" stroke-width="0.6"/>
  <path d="M 113,201 Q 115,205 120,204" fill="none" stroke="#a8a8b8" stroke-width="0.6"/>
  <path d="M 120,198 Q 122,203 127,202" fill="none" stroke="#a8a8b8" stroke-width="0.6"/>

  <!-- 6. 右搖手（最前層） -->
  <g class="deng-paw-wave">
    <path d="M 134,152 Q 150,147 146,128" stroke="#d0d0dc" stroke-width="13" stroke-linecap="round" fill="none"/>
    <path d="M 134,152 Q 150,147 146,128" stroke="#f2f2f8" stroke-width="8" stroke-linecap="round" fill="none"/>
    <ellipse cx="144" cy="124" rx="12" ry="10" fill="#f2f2f8" stroke="#c0c0cc" stroke-width="0.8"/>
    <ellipse cx="144" cy="126" rx="5.5" ry="4.5" fill="#f4c0c8" opacity="0.55"/>
    <circle cx="138" cy="121" r="2" fill="#f4c0c8" opacity="0.5"/>
    <circle cx="144" cy="119" r="2" fill="#f4c0c8" opacity="0.5"/>
    <circle cx="150" cy="121" r="2" fill="#f4c0c8" opacity="0.5"/>
    <path d="M 139,129 Q 140,133 142,132" fill="none" stroke="#c0a0a8" stroke-width="0.6"/>
    <path d="M 144,130 Q 145,134 147,133" fill="none" stroke="#c0a0a8" stroke-width="0.6"/>
    <path d="M 149,129 Q 150,133 152,132" fill="none" stroke="#c0a0a8" stroke-width="0.6"/>
  </g>

  <!-- 7. 掉落金幣元寶（最前層） -->
  <g class="dc1"><circle cx="168" cy="48" r="7" fill="url(#dCoinSm)" stroke="#a07000" stroke-width="0.7"/><text x="168" y="51" text-anchor="middle" font-size="5" fill="#7a4a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="dc2"><circle cx="26" cy="55" r="6" fill="url(#dCoinSm)" stroke="#a07000" stroke-width="0.7"/><text x="26" y="58" text-anchor="middle" font-size="4.5" fill="#7a4a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="dc3"><circle cx="174" cy="62" r="7" fill="url(#dCoinSm)" stroke="#a07000" stroke-width="0.7"/><text x="174" y="65" text-anchor="middle" font-size="5" fill="#7a4a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="dc4"><circle cx="20" cy="40" r="6" fill="url(#dCoinSm)" stroke="#a07000" stroke-width="0.7"/><text x="20" y="43" text-anchor="middle" font-size="4.5" fill="#7a4a00" font-family="serif" font-weight="bold">財</text></g>
  <g class="di1"><rect x="156" y="72" width="18" height="9" rx="2" fill="url(#dIngot)" stroke="#a07000" stroke-width="0.6"/><ellipse cx="165" cy="72" rx="11" ry="5" fill="url(#dIngot)" stroke="#a07000" stroke-width="0.6"/><ellipse cx="165" cy="71" rx="7" ry="3" fill="#fff8c0" opacity="0.5"/></g>
  <g class="di2"><rect x="22" y="66" width="18" height="9" rx="2" fill="url(#dIngot)" stroke="#a07000" stroke-width="0.6"/><ellipse cx="31" cy="66" rx="11" ry="5" fill="url(#dIngot)" stroke="#a07000" stroke-width="0.6"/><ellipse cx="31" cy="65" rx="7" ry="3" fill="#fff8c0" opacity="0.5"/></g>
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
