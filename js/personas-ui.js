/**
 * personas-ui.js — AI 圓桌聊天室 + 使用者互動
 *
 * 結構:
 *   <header>          標題 + 召喚按鈕(再跑一次)
 *   <chat>            訊息列(自動 scroll)
 *   <hint-row>        @ 點名提示按鈕(快速插話)
 *   <input-row>       輸入框 + 送出
 */

import { buildPersonaChat, replyToMention, replyAmongPersonas, PERSONAS } from './personas.js';

const MOOD_CLASS = {
  happy:'mood-happy', sad:'mood-sad', curious:'mood-curious', savage:'mood-savage',
};
const NAMES = Object.fromEntries(PERSONAS.map(p => [p.id, p.name]));
const ALIASES = {                              // 模糊匹配 @
  deng: ['deng','燈燈','燈'],
  niu:  ['niu','老牛','牛'],
  ga:   ['ga','嘎神','嘎'],
  aunt: ['aunt','阿姨'],
  quant:['quant','量子'],
};

let _lastRenderId = 0;
let _lastCtx = null;
let _messageHistory = [];

if (typeof window !== 'undefined' && !window.__personasListenersAddedV2) {
  window.__personasListenersAddedV2 = true;
  window.addEventListener('fundamentalsUpdated', () => {
    if (_lastCtx) {
      _lastCtx.fundamentals = window.__lastFundamentals ?? {};
      renderPersonas(_lastCtx);
    }
  });
  window.addEventListener('chipsUpdated', () => {
    if (_lastCtx) {
      _lastCtx.chips = window.__lastChips ?? {};
      renderPersonas(_lastCtx);
    }
  });
}

export function renderPersonas(ctx) {
  const el = document.getElementById('personasPanel');
  if (!el) return;

  _lastCtx = ctx;
  const renderId = ++_lastRenderId;
  const { messages } = buildPersonaChat(ctx);
  _messageHistory = [];

  if (!messages.length) {
    el.innerHTML = `<div class="rt-empty">尚無資料</div>`;
    return;
  }

  // 介面骨架
  el.innerHTML = `
    <div class="rt-header">
      <div class="rt-title">💬 AI 圓桌</div>
      <button class="rt-summon-btn" id="rtSummonBtn" title="重新召喚">🔮 再來一輪</button>
    </div>
    <div class="rt-subtitle">五門派觀點 + 你也可以 @ 他們聊聊。純規則演算,僅供腦力激盪,不構成投資建議</div>

    <div class="rt-chat" id="rtChat"></div>

    <div class="rt-mention-hints" id="rtMentionHints">
      ${PERSONAS.map(p => `<button class="rt-mention-chip" data-mention="${p.id}">${p.emoji} @${p.name}</button>`).join('')}
    </div>

    <div class="rt-input-row">
      <input type="text" id="rtInput" class="rt-input"
        placeholder="@燈燈、@老牛、@嘎神、@阿姨、@量子 ... 想插話?" />
      <button class="rt-send-btn" id="rtSendBtn">送出</button>
    </div>
  `;

  // 逐條淡入第一輪訊息
  const chatEl = document.getElementById('rtChat');
  const now = new Date();
  messages.forEach((m, i) => {
    setTimeout(() => {
      if (renderId !== _lastRenderId) return;
      const time = new Date(now.getTime() + i * 600);
      _appendMessage(chatEl, m, time);
      _messageHistory.push(m);
    }, i * 600);
  });

  // 事件綁定
  document.getElementById('rtSummonBtn')?.addEventListener('click', () => {
    if (_lastCtx) renderPersonas(_lastCtx);
  });
  document.getElementById('rtSendBtn')?.addEventListener('click', _handleUserSend);
  document.getElementById('rtInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _handleUserSend();
  });
  document.querySelectorAll('.rt-mention-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('rtInput');
      const id = btn.dataset.mention;
      const name = NAMES[id];
      input.value = (input.value || '').trim() + (input.value ? ' ' : '') + `@${name} `;
      input.focus();
    });
  });
}

// ─── 使用者送出 ──────────────────────────────────────
async function _handleUserSend() {
  const input = document.getElementById('rtInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  input.value = '';

  const chatEl = document.getElementById('rtChat');
  const now = new Date();

  // 1. 加使用者訊息
  const userMsg = {
    id: 'user', name: '我', emoji: '🙂', sect: '', side: 'user', text,
  };
  _appendMessage(chatEl, userMsg, now);
  _messageHistory.push(userMsg);

  // 2. 解析 @ 點名
  const mentioned = _parseMentions(text);

  // 3. 找回應對象
  if (mentioned.length === 0) {
    // 沒 @ 任何人 → 隨機挑一個對立面回
    const ids = ['deng','niu','ga','aunt','quant'];
    mentioned.push(ids[Math.floor(Math.random() * ids.length)]);
  }

  // 4. 依序讓被點到的人格回話
  for (let i = 0; i < mentioned.length; i++) {
    const id = mentioned[i];
    await new Promise(r => setTimeout(r, 700 + i * 600));
    const reply = replyToMention(id, text, _lastCtx, _messageHistory);
    if (reply) {
      _appendMessage(chatEl, reply, new Date());
      _messageHistory.push(reply);
      // 5. 隨機機率:其他人格可能插話回嘴(讓對話更熱絡)
      if (Math.random() < 0.5 && i === mentioned.length - 1) {
        await _maybeChainReply(reply);
      }
    }
  }
}

// 機率讓其他人格插話回嘴
async function _maybeChainReply(lastMsg) {
  const ids = ['deng','niu','ga','aunt','quant'].filter(x => x !== lastMsg.id);
  const target = ids[Math.floor(Math.random() * ids.length)];
  await new Promise(r => setTimeout(r, 900));
  const chatEl = document.getElementById('rtChat');
  const reply = replyAmongPersonas(target, lastMsg, _lastCtx);
  if (reply) {
    _appendMessage(chatEl, reply, new Date());
    _messageHistory.push(reply);
  }
}

// 解析 @ 點名 → 回傳人格 id 陣列
function _parseMentions(text) {
  const found = new Set();
  for (const [id, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) {
      const re = new RegExp(`@\\s*${a}`, 'i');
      if (re.test(text)) { found.add(id); break; }
    }
  }
  return [...found];
}

// ─── 追加訊息(逐條淡入)─────────────────────────
function _appendMessage(chatEl, m, time) {
  if (!chatEl) return;
  chatEl.insertAdjacentHTML('beforeend', _msgHTML(m, time));
  chatEl.scrollTop = chatEl.scrollHeight;
}

function _msgHTML(m, time) {
  if (m.side === 'user') {
    return `
      <div class="rt-msg side-user">
        <div class="rt-msg-body">
          <div class="rt-msg-meta">
            <span class="rt-msg-name">${m.name}</span>
            <span class="rt-msg-time">${_t(time)}</span>
          </div>
          <div class="rt-msg-bubble">${_escape(m.text)}</div>
        </div>
        <div class="rt-msg-avatar">${m.emoji}</div>
      </div>`;
  }

  const sideCls = m.side === 'bull' ? 'side-bull'
                : m.side === 'bear' ? 'side-bear'
                : 'side-neutral';
  const moodCls = MOOD_CLASS[m.mood] ?? '';
  const replyTag = m.replyTo && m.replyTo !== 'user'
    ? `<div class="rt-msg-reply">↪ 回應 ${NAMES[m.replyTo] ?? m.replyTo}</div>`
    : (m.replyTo === 'user' ? `<div class="rt-msg-reply">↪ 回應 你</div>` : '');
  const scoreBadge = `<span class="rt-score-badge ${m.score >= 0 ? 'up' : 'down'}">${m.score > 0 ? '+' : ''}${m.score}</span>`;
  const textHtml = _renderText(m.text);

  return `
    <div class="rt-msg ${sideCls} ${moodCls}">
      <div class="rt-msg-avatar">${m.emoji}</div>
      <div class="rt-msg-body">
        <div class="rt-msg-meta">
          <span class="rt-msg-name">${m.name}</span>
          <span class="rt-msg-sect">${m.sect}</span>
          ${scoreBadge}
          <span class="rt-msg-time">${_t(time)}</span>
        </div>
        ${replyTag}
        <div class="rt-msg-bubble">${textHtml}</div>
      </div>
    </div>`;
}

// 把訊息中的 @XXX 變成高亮
function _renderText(text) {
  return _escape(text).replace(/@([\u4e00-\u9fa5\w]+)/g, '<span class="rt-mention">@$1</span>');
}

function _t(d) {
  return d.toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', hour12:false });
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
}
