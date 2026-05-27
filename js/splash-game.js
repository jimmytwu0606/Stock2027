/**
 * splash-game.js — 彩蛋遊戲主控
 * 負責：5秒計時器、彈層UI、遊戲清單、共用API
 * 遊戲本體各自在 game-xxx.js 用 window.__GAMES.register() 註冊
 * 引入順序：game-*.js 先，splash-game.js 最後
 */
(function () {
  'use strict';

  const IDLE_SEC = 5;

  /* ── 遊戲註冊表 ── */
  // game-*.js (defer) 可能比 splash-game.js 先跑完
  // 先把暫存搬進 registry，再掛上正式的 register
  const registry = [];
  const _pre = (window.__GAMES && window.__GAMES._q) || [];
  _pre.forEach(def => registry.push(def));
  window.__GAMES = {
    _q: registry,
    register(def) { registry.push(def); }
  };

  /* ── 狀態 ── */
  let idleTimer = null, eggShown = false;
  let currentDef = null, rafId = null;
  const best = {};

  /* ══════════════════════════════════════
     一、注入彩蛋按鈕 & 遊戲彈層
  ══════════════════════════════════════ */
  function injectUI() {
    const splash = document.getElementById('dengSplash');
    if (!splash) return;

    const btn = document.createElement('button');
    btn.id = 'dsEggBtn';
    btn.textContent = '還是要來點樂子？';
    btn.style.cssText = `
      position:absolute;bottom:72px;left:50%;transform:translateX(-50%);
      padding:8px 24px;border-radius:100px;
      border:1px solid rgba(245,196,0,.4);
      background:rgba(245,196,0,.08);color:rgba(245,196,0,.75);
      font-size:12px;font-family:-apple-system,'Segoe UI',monospace,sans-serif;
      cursor:pointer;letter-spacing:.06em;z-index:99;
      opacity:0;transition:opacity .6s ease;pointer-events:none;
    `;
    btn.addEventListener('click', openPicker);
    splash.appendChild(btn);

    const ov = document.createElement('div');
    ov.id = 'dsGameOverlay';
    ov.style.cssText = `
      position:fixed;inset:0;z-index:999999;background:#0a0a18;
      display:none;flex-direction:column;align-items:center;justify-content:center;
      font-family:-apple-system,'Segoe UI',monospace,sans-serif;
    `;
    ov.innerHTML = `
      <div id="dsGHdr" style="
        position:absolute;top:0;left:0;right:0;
        display:flex;justify-content:space-between;align-items:center;
        padding:10px 20px;background:#0f0f22;border-bottom:1px solid #1e1e3a;
        flex-wrap:wrap;gap:8px;
      ">
        <span id="dsGTitle" style="color:#f5c400;font-size:13px;font-weight:700"></span>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <span style="font-size:10px;color:#555;letter-spacing:1px">SCORE</span>
          <span id="dsGScore" style="font-size:16px;font-weight:bold;color:#fff">0</span>
          <span style="font-size:10px;color:#555;letter-spacing:1px">BEST</span>
          <span id="dsGBest"  style="font-size:16px;font-weight:bold;color:#f5c400">0</span>
          <span id="dsGHp"   style="font-size:14px">❤❤❤</span>
          <span id="dsGLv"   style="font-size:10px;color:#888;letter-spacing:1px">LV 1</span>
          <button onclick="window.__closeGame()" style="
            padding:4px 12px;border:1px solid #333;border-radius:6px;
            background:transparent;color:#666;font-size:11px;cursor:pointer;
          ">✕ 關閉</button>
        </div>
      </div>
      <canvas id="dsGCanvas" style="display:block;max-width:100%;touch-action:none;margin-top:44px"></canvas>
      <div id="dsGMsg" style="
        position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        background:rgba(10,10,24,.95);border:1px solid #2a2a4a;border-radius:10px;
        padding:24px 36px;text-align:center;min-width:280px;display:none;
      ">
        <h2 id="dsGMsgTitle" style="color:#fff;font-size:20px;margin:0 0 6px"></h2>
        <p  id="dsGMsgSub"   style="color:#aaa;font-size:12px;margin:0 0 18px"></p>
        <div id="dsGMsgBtns" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"></div>
      </div>
      <div id="dsGHint" style="
        position:absolute;bottom:0;left:0;right:0;
        text-align:center;padding:8px;color:#444;font-size:11px;border-top:1px solid #111;
      "></div>
    `;
    document.body.appendChild(ov);
  }

  /* ══════════════════════════════════════
     二、5 秒計時器
  ══════════════════════════════════════ */
  function startIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (eggShown) return;
      const btn = document.getElementById('dsEggBtn');
      if (!btn) return;
      eggShown = true;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }, IDLE_SEC * 1000);
  }

  /* ══════════════════════════════════════
     三、遊戲選擇 & 啟動
  ══════════════════════════════════════ */
  function openPicker() {
    if (!registry.length) return;
    const def = registry[Math.floor(Math.random() * registry.length)];
    launchGame(def);
  }

  function launchGame(def) {
    stopGame();
    currentDef = def;
    if (!best[def.id]) best[def.id] = 0;

    const ov = document.getElementById('dsGameOverlay');
    ov.style.display = 'flex';

    const canvas = document.getElementById('dsGCanvas');
    const maxW = Math.min(window.innerWidth, 720);
    canvas.width  = 680;
    canvas.height = def.canvasH || 240;
    canvas.style.width  = maxW + 'px';
    canvas.style.height = Math.round(maxW * (def.canvasH || 240) / 680) + 'px';

    document.getElementById('dsGTitle').textContent = def.name;
    document.getElementById('dsGHint').textContent  = def.hint || '';
    setScore(0); setHp(3); setLv(1);
    hideMsg();

    const ctx = canvas.getContext('2d');
    def.init(canvas, ctx, makeAPI(def));
  }

  window.__closeGame = function () {
    const ov = document.getElementById('dsGameOverlay');
    if (ov) ov.style.display = 'none';
    stopGame();
    currentDef = null;
  };

  function stopGame() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /* ══════════════════════════════════════
     四、共用 API（傳給各遊戲）
  ══════════════════════════════════════ */
  function makeAPI(def) {
    return {
      /* RAF 管理 */
      raf(fn) { rafId = requestAnimationFrame(fn); },
      stopRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } },

      /* HUD */
      setScore(s) { setScore(s); if (s > best[def.id]) { best[def.id] = s; setBest(s); } },
      setBest(b)  { setBest(b); },
      setHp(hp)   { setHp(hp); },
      setLv(lv)   { setLv(lv); },
      getBest()   { return best[def.id] || 0; },

      /* 訊息 */
      showMsg, hideMsg,

      /* 遊戲結束選單 */
      endGame(score) {
        const PHRASES = {
          runner:  ['跌停吃太多ㄌ 😂', '燈燈跌倒ㄌ', '玩不過癮？', '血扣光了！'],
          thunder: ['扣光ㄌ！', '燈燈破產 😭', '子彈閃不掉？', '被跌停淹沒ㄌ'],
        };
        const list = PHRASES[def.id] || ['結束ㄌ'];
        const title = list[Math.floor(Math.random() * list.length)];
        showMsg(title, '最高分：' + (best[def.id] || 0), [
          {
            label: '▶ 繼續玩', red: true,
            fn: () => { hideMsg(); launchGame(def); }
          },
          ...registry.filter(d => d.id !== def.id).map(d => ({
            label: '玩 ' + d.name,
            fn: () => { hideMsg(); launchGame(d); }
          })),
          {
            label: '看盤去',
            fn: () => {
              window.__closeGame();
              window.__hideSplash && window.__hideSplash();
            }
          },
        ]);
      },
    };
  }

  /* ══════════════════════════════════════
     五、HUD 工具
  ══════════════════════════════════════ */
  function setScore(s) { const el = document.getElementById('dsGScore'); if (el) el.textContent = Math.max(0, s); }
  function setBest(b)  { const el = document.getElementById('dsGBest');  if (el) el.textContent = b; }
  function setHp(hp)   { const el = document.getElementById('dsGHp');    if (el) el.textContent = '❤'.repeat(Math.max(0,hp)) + '🖤'.repeat(Math.max(0, 3-hp)); }
  function setLv(lv)   { const el = document.getElementById('dsGLv');    if (el) el.textContent = 'LV ' + lv; }

  function showMsg(title, sub, btns) {
    document.getElementById('dsGMsgTitle').textContent = title;
    document.getElementById('dsGMsgSub').textContent   = sub;
    const bc = document.getElementById('dsGMsgBtns');
    bc.innerHTML = '';
    (btns || []).forEach(b => {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.style.cssText = `
        padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;
        font-family:inherit;
        border:1px solid ${b.red ? '#e83030' : '#444'};
        background:${b.red ? 'rgba(232,48,48,.08)' : '#1a1a2e'};
        color:${b.red ? '#e83030' : '#fff'};
      `;
      el.onclick = b.fn;
      bc.appendChild(el);
    });
    document.getElementById('dsGMsg').style.display = 'block';
  }
  function hideMsg() { document.getElementById('dsGMsg').style.display = 'none'; }

  /* ══════════════════════════════════════
     六、初始化
  ══════════════════════════════════════ */
  function init() {
    const splash = document.getElementById('dengSplash');
    if (!splash) return;
    injectUI();
    startIdle();
    ['click','keydown','mousemove','touchstart'].forEach(ev => {
      splash.addEventListener(ev, () => { if (!eggShown) { clearTimeout(idleTimer); startIdle(); } }, { passive: true });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
