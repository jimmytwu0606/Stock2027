/* ============================================================
 * game-klineRacer.js — 主檔：splash-game 註冊 + 選單 + 比賽 + 結算
 * 依賴：data + core + life（window.__KR.D / .C / .L / .UI）
 * index.html：三個輔檔在本檔之前，本檔在 splash-game.js 之前
 * ============================================================ */
(function () {
  'use strict';

  function init(canvas, ctx0, api) {
    api = api || {};
    var KR = window.__KR, D = KR.D, C = KR.C, UI = KR.UI;
    canvas = canvas || document.getElementById('dsGCanvas');
    if (!canvas || !KR || !D || !C || !UI) return function () {};
    if (canvas.__krDestroy) { try { canvas.__krDestroy(); } catch (e) {} }

    // launchGame 已設 canvas.width=680 / height=canvasH，CSS 另行縮放顯示
    var W = 680, H = canvas.height || 620;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = ctx0 || canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var alive = true, save = null, screen = 'boot';
    var raceDef = null, race = null, view = null, tired = false, result = null;
    var speedMul = 1, rafId = null, btns = [], toasts = [], toastTimer = null, loadTimer = null;

    /* ---------- 共用 ---------- */
    function persist() { C.saveGame(save); hud(); }

    function btn(x, y, w, h, label, fn, opt) {
      opt = opt || {};
      var dis = !!opt.disabled;
      ctx.save();
      if (!dis) { ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2; }
      var g = ctx.createLinearGradient(0, y, 0, y + h);
      if (dis) { g.addColorStop(0, '#1a1f26'); g.addColorStop(1, '#161a20'); }
      else if (opt.gold) { g.addColorStop(0, '#3e2f0f'); g.addColorStop(1, '#241a08'); }
      else { g.addColorStop(0, '#2b323c'); g.addColorStop(1, '#1c222a'); }
      ctx.fillStyle = g; UI.rr(ctx, x, y, w, h, 7); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = dis ? '#222831' : (opt.gold ? '#9e6a03' : '#4a525e');
      ctx.lineWidth = 1; UI.rr(ctx, x, y, w, h, 7); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(x + 6, y + 1.5); ctx.lineTo(x + w - 6, y + 1.5); ctx.stroke();
      UI.text(ctx, label, x + w / 2, y + h / 2 + 4.5, opt.size || 12,
        dis ? D.COL.dim : (opt.gold ? D.COL.gold : D.COL.text), 'center');
      if (!dis) btns.push({ x: x, y: y, w: w, h: h, fn: fn });
    }

    function toast(msg) {
      toasts.push({ msg: msg, until: Date.now() + 2800 });
      tickToasts();
    }
    function drawToasts() {
      var now = Date.now();
      toasts = toasts.filter(function (t) { return t.until > now; });
      for (var i = 0; i < toasts.length; i++) {
        var t = toasts[i], y = 14 + i * 30;
        ctx.fillStyle = 'rgba(22,27,34,0.95)';
        var tw = Math.min(W - 80, ctx.measureText(t.msg).width + 60);
        UI.rr(ctx, (W - tw) / 2, y, tw, 24, 12); ctx.fill();
        ctx.strokeStyle = '#444c56'; UI.rr(ctx, (W - tw) / 2, y, tw, 24, 12); ctx.stroke();
        UI.text(ctx, t.msg, W / 2, y + 16, 11, D.COL.gold, 'center');
      }
    }
    function tickToasts() {
      if (toastTimer) clearTimeout(toastTimer);
      if (!toasts.length || !alive) return;
      repaint();
      toastTimer = setTimeout(tickToasts, 250);
    }
    function repaint() {
      if (!alive) return;
      if (screen === 'race') return; // raf 迴圈自己畫
      if (screen === 'life') { KR.L.draw(); drawToasts(); }
      else draw();
    }

    /* ---------- 啟動 ---------- */
    function hud() {
      if (!save) return;
      if (api.setLv) try { api.setLv(save.lv); } catch (e) {}
      if (api.setScore) try { api.setScore(Math.round(save.money)); } catch (e) {}
    }
    C.loadGame(function (s) {
      if (!alive) return;
      save = s; screen = 'menu'; hud(); draw();
    });

    /* ---------- 點擊 ---------- */
    function onClick(e) {
      if (!alive) return;
      var r = canvas.getBoundingClientRect();
      var x = (e.clientX - r.left) * (W / r.width);
      var y = (e.clientY - r.top) * (H / r.height);
      if (screen === 'life') {
        if (KR.L.click(x, y)) drawToasts();
        return;
      }
      for (var i = btns.length - 1; i >= 0; i--) {
        var b = btns[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.fn(); return; }
      }
    }
    canvas.addEventListener('click', onClick);
    function onKey(e) {
      if (!alive || screen !== 'race' || !race || race.done) return;
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); contextAction(); }
      if (e.key === '1') fireItem('banana');
      if (e.key === '2') fireItem('shell');
      if (e.key === '3') fireItem('zap');
    }
    if (window.addEventListener) window.addEventListener('keydown', onKey);

    /* ---------- 畫面分派 ---------- */
    function draw() {
      if (!alive || !save) return;
      btns = [];
      if (screen === 'menu') drawMenu();
      else if (screen === 'select') drawSelect();
      else if (screen === 'camp') drawCamp();
      else if (screen === 'loading') drawLoading();
      else if (screen === 'result') drawResult();
      drawToasts();
    }

    function enterLife(tab) {
      screen = 'life';
      KR.L.enter({
        ctx: ctx, W: W, H: H, save: save,
        persist: persist, toast: toast,
        exit: function (target) {
          screen = target === 'race' ? 'select' : 'menu';
          draw();
        },
        repaint: repaint
      }, tab);
    }

    /* ---------- 主選單 ---------- */
    var TIER_COLOR = { C: '#8a93a3', B: '#58a6ff', A: '#a371f7', S: '#f0a527', X: '#ef5350' };
    function seededRnd(i) { var x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); }
    function drawBackdrop() {
      for (var i = 0; i < 18; i++) {
        var x = 24 + i * ((W - 48) / 18);
        var up = seededRnd(i) > 0.45;
        var h2 = 24 + seededRnd(i + 7) * 70;
        var y2 = H - 70 - seededRnd(i + 3) * 130;
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = up ? D.COL.up : D.COL.down;
        ctx.fillRect(x, y2, 12, h2);
        ctx.fillRect(x + 5, y2 - 14, 2, h2 + 28);
        ctx.globalAlpha = 1;
      }
    }
    function drawMenu() {
      ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
      var g0 = ctx.createLinearGradient(0, 0, 0, 280);
      g0.addColorStop(0, '#16202e'); g0.addColorStop(1, 'rgba(13,17,23,0)');
      ctx.fillStyle = g0; ctx.fillRect(0, 0, W, 280);
      drawBackdrop();
      ctx.save(); ctx.shadowColor = 'rgba(240,165,39,0.35)'; ctx.shadowBlur = 18;
      UI.text(ctx, 'K線賽車', W / 2, 66, 36, D.COL.text, 'center', true);
      ctx.restore();
      UI.text(ctx, '— 人生路 —', W / 2, 94, 14, D.COL.gold, 'center');
      ctx.strokeStyle = 'rgba(158,106,3,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(W / 2 - 140, 104); ctx.lineTo(W / 2 + 140, 104); ctx.stroke();
      UI.text(ctx, '隨機台股 K 線就是你的賽道 · 賽後揭曉跑的是哪一檔', W / 2, 124, 11, D.COL.sub, 'center');

      var s = save, car = C.activeCar(s);
      UI.card(ctx, W / 2 - 250, 148, 500, 140);
      UI.text(ctx, '第 ' + s.day + ' 天 · Lv.' + s.lv + ' · ' + D.fmt(s.money) + (s.debtRepair > 0 ? ' · 賒帳 ' + D.fmt(s.debtRepair) : ''), W / 2 - 230, 178, 13, D.COL.text, 'left', true);
      UI.text(ctx, '力 ' + s.stats.str.toFixed(1) + ' · 體 ' + s.stats.vit.toFixed(1) + ' · 耐 ' + s.stats.end.toFixed(1) + ' · 體力 ' + Math.round(s.energy) + '/' + C.energyMax(s), W / 2 - 230, 200, 11, D.COL.sub);
      UI.text(ctx, '出賽車：' + car.name + ' · ' + D.CAR_TIERS[car.tier].name + D.CAR_TYPES[car.type].name, W / 2 - 230, 224, 12, D.COL.gold);
      UI.text(ctx, '加速 ' + car.accel + ' · 抓地 ' + car.grip + ' · 爬坡 ' + car.climb + ' · 胎 ' + Math.round(car.tirePct * 100) + '%' + (C.serviceDue(car) ? ' · 逾保養！' : ''), W / 2 - 230, 244, 11, C.serviceDue(car) ? D.COL.red : D.COL.sub);
      UI.text(ctx, '戰績：' + s.stats2.races + ' 場 · ' + s.stats2.wins + ' 冠 · 累積獎金 ' + D.fmt(s.stats2.earned), W / 2 - 230, 266, 10, D.COL.sub);
      // 出賽車插畫
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(W / 2 + 168, 252, 56, 8, 0, 0, Math.PI * 2); ctx.fill();
      UI.car(ctx, W / 2 + 168, 250, 4.6, TIER_COLOR[car.tier] || '#8a93a3', { glow: car.tier === 'X' ? 'rgba(239,83,80,0.8)' : 'rgba(0,0,0,0.5)' });

      btn(W / 2 - 232, 310, 110, 42, '前往賽場', function () { screen = 'select'; draw(); }, { gold: true, size: 13 });
      btn(W / 2 - 114, 310, 110, 42, '⚔ 征途', function () { screen = 'camp'; draw(); }, { size: 13 });
      btn(W / 2 + 4, 310, 110, 42, '修配廠', function () { enterLife('tune'); }, { size: 13 });
      btn(W / 2 + 122, 310, 110, 42, '生活模式', function () { enterLife(); }, { size: 13 });
      UI.text(ctx, '比賽 / 打工 / 休息各佔 1 天 · 貸款每天扣款', W / 2, 384, 10, D.COL.dim, 'center');
    }

    /* ---------- 賽事選擇 ---------- */
    function drawSelect() {
      ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
      var s = save, car = C.activeCar(s);
      UI.text(ctx, '選擇賽事', 20, 32, 15, D.COL.text, 'left', true);
      UI.text(ctx, D.fmt(s.money) + ' · 體力 ' + Math.round(s.energy) + '/' + C.energyMax(s), W - 20, 32, 12, D.COL.gold, 'right');
      var due = C.serviceDue(car);
      if (due) UI.text(ctx, '出賽車逾期未保養，禁止出賽（生活模式 → 改裝）', 20, 54, 11, D.COL.red);

      var ry = due ? 66 : 52;
      for (var i = 0; i < D.RACES.length; i++) {
        (function (rd, yy) {
          var lvOk = s.lv >= rd.lvReq;
          var feeOk = s.money >= rd.fee;
          var debtLock = i >= 2 && s.debtRepair > 0;
          var ok = lvOk && feeOk && !debtLock && !due;
          var tiredWarn = s.energy < rd.energy;
          UI.card(ctx, 20, yy, W - 40, 76, ok ? null : '#22262c');
          UI.text(ctx, rd.name + ' · ' + rd.period + ' · ' + rd.bars + ' 路段', 36, yy + 24, 13, ok ? D.COL.text : D.COL.dim, 'left', true);
          UI.text(ctx, '報名 ' + (rd.fee ? D.fmt(rd.fee) : '免費') + ' · 冠軍 ' + D.fmt(rd.prize[0]) + ' · 出場費 ' + D.fmt(rd.appear) + ' · XP ×' + rd.xpMul + (rd.pit ? ' · 耐力賽（建議進站 ' + rd.pit + ' 次+）' : ''), 36, yy + 44, 11, D.COL.sub);
          var note = !lvOk ? '需 Lv.' + rd.lvReq : debtLock ? '賒帳鎖定' : !feeOk ? '報名費不足' :
            tiredWarn ? '體力不足：硬上全程失誤 +50%' : '體力 −' + rd.energy;
          UI.text(ctx, note, 36, yy + 62, 10, (!ok || tiredWarn) ? D.COL.red : D.COL.sub);
          btn(W - 130, yy + 22, 90, 32, '出賽', function () { startRace(rd); }, { gold: true, disabled: !ok });
        })(D.RACES[i], ry);
        ry += 84;
      }
      btn(20, ry + 6, 120, 30, '← 回主選單', function () { screen = 'menu'; draw(); });
      btn(150, ry + 6, 120, 30, '修配廠', function () { enterLife('tune'); });
      btn(280, ry + 6, 120, 30, '生活模式', function () { enterLife(); });
    }

    /* ---------- 開賽 ---------- */
    function drawCamp() {
      ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
      drawBackdrop();
      var s = save;
      var n = s.campaign.stage;
      var st2 = C.campStage(n);
      var rd = D.RACES[st2.raceIdx];
      UI.text(ctx, '⚔ 征途模式 — 第 ' + n + ' 關（無限挑戰）', W / 2, 48, 18, D.COL.text, 'center', true);
      UI.text(ctx, '已通關 ' + s.campaign.cleared + ' 關 · 魔王逐關線性成長，永無止境', W / 2, 72, 11, D.COL.sub, 'center');
      // 魔王卡
      UI.card(ctx, 40, 92, W - 80, 150);
      UI.text(ctx, '👑 ' + st2.name + '  Lv.' + n, 64, 122, 16, '#ef5350', 'left', true);
      UI.text(ctx, '車力：玩家 ×' + st2.band.toFixed(2) + ' · 賽事：' + rd.name + '（' + rd.bars + ' 根）', 64, 146, 11, D.COL.sub);
      var sk = [];
      for (var i = 0; i < st2.skillList.length; i++) sk.push(st2.skillList[i].name + '（' + st2.skillList[i].desc + '）');
      UI.text(ctx, 'GY 技能：' + sk.join('、'), 64, 168, 11, D.COL.gold);
      var ru = [];
      for (var j = 0; j < st2.ruleList.length; j++) ru.push(st2.ruleList[j].name);
      UI.text(ctx, '關卡規則：' + (ru.length ? ru.join('、') : '無'), 64, 188, 11, D.COL.blue);
      UI.text(ctx, '通關獎勵：' + D.fmt(st2.reward) + ' + ' + st2.xp + ' XP' + (n % D.CAMPAIGN.milestoneEvery === 0 ? ' 🏆 里程碑 ×3！' : ''), 64, 210, 12, D.COL.green);
      UI.text(ctx, '勝利條件：完賽前三 且 名次在魔王之前 · 魔王會丟暗器（按空白閃避）', 64, 230, 10, D.COL.dim);
      // 攜帶暗器
      var cap = 1 + C.armVal('carry', s.armory.carry);
      UI.text(ctx, '🗡 攜帶暗器（修配廠購買，每種上限 ' + cap + '）：', 40, 268, 12, D.COL.text);
      var keys = D.ITEM_KEYS;
      for (var k = 0; k < keys.length; k++) {
        var it = D.ITEMS[keys[k]];
        UI.text(ctx, it.icon + ' ' + it.name + ' ×' + (s.items[keys[k]] || 0), 70 + k * 160, 290, 12, (s.items[keys[k]] || 0) > 0 ? D.COL.gold : D.COL.dim);
      }
      UI.text(ctx, '比賽中按 1 / 2 / 3 發射，自動鎖定前方車輛', 40, 312, 10, D.COL.dim);
      var fee = rd.fee;
      var ok = s.money >= fee && !C.serviceDue(C.activeCar(s));
      btn(W / 2 - 140, 340, 130, 40, '開戰（' + D.fmt(fee) + '）', function () { startRace(rd, st2); }, { gold: true, disabled: !ok, size: 13 });
      btn(W / 2 + 10, 340, 130, 40, '🗡 武裝補給', function () { enterLife('tune'); }, { size: 13 });
      btn(20, H - 50, 120, 30, '← 回主選單', function () { screen = 'menu'; draw(); });
    }

    function startRace(rd, camp) {
      var s = save;
      s.money -= rd.fee;
      tired = s.energy < rd.energy;
      raceDef = rd; race = null; result = null;
      speedMul = rd.bars > 200 ? 2 : 1;
      screen = 'loading'; draw();
      var pc0 = C.activeCar(s);
      C.initRivals(s, pc0.accel + pc0.grip + pc0.climb);
      var carry = {};
      if (camp) {
        var cap2 = 1 + C.armVal('carry', s.armory.carry);
        for (var ik = 0; ik < D.ITEM_KEYS.length; ik++) {
          carry[D.ITEM_KEYS[ik]] = Math.min(s.items[D.ITEM_KEYS[ik]] || 0, cap2);
        }
      }
      C.fetchTrack(rd.bars, function (candles, label, synth, name) {
        if (!alive) return;
        var segs = C.buildTrack(candles, rd, camp ? camp.rules : null);
        race = C.createRace({
          raceDef: rd, segs: segs,
          player: { car: C.activeCar(s), stats: s.stats, tired: tired, rnd: s.rnd },
          rivalPow: s.rivalPow,
          camp: camp || null,
          items: camp ? carry : null,
          codeLabel: label
        });
        race.isSynth = synth;
        race.codeName = name || null;
        if (synth) toast('K 線抓取失敗，本場改用模擬賽道（錯誤見 console）');
        view = buildView(race);
        screen = 'race';
        loop();
      });
    }

    function drawLoading() {
      ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
      drawBackdrop();
      var n = 1 + (Math.floor(Date.now() / 280) % 3);
      var dots = '...'.slice(0, n);
      UI.text(ctx, '抽選神秘賽道中' + dots, W / 2, H / 2 - 40, 18, D.COL.text, 'center', true);
      UI.text(ctx, '從 1,900+ 檔台股隨機抽取 K 線地形', W / 2, H / 2 - 12, 11, D.COL.sub, 'center');
      var cx = ((Date.now() / 5) % (W + 200)) - 100;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(cx, H / 2 + 62, 36, 6, 0, 0, Math.PI * 2); ctx.fill();
      UI.car(ctx, cx, H / 2 + 60, 3, '#f0a527');
      ctx.strokeStyle = 'rgba(139,148,158,0.25)'; ctx.lineWidth = 1;
      ctx.setLineDash([10, 12]);
      ctx.beginPath(); ctx.moveTo(0, H / 2 + 64); ctx.lineTo(W, H / 2 + 64); ctx.stroke();
      ctx.setLineDash([]);
      if (loadTimer) clearTimeout(loadTimer);
      loadTimer = setTimeout(function () { if (alive && screen === 'loading') draw(); }, 70);
    }

    /* ---------- 比賽渲染 ---------- */
    var TR = { x0: 24, yTop: 96, yBot: 322 };
    function buildView(rc) {
      var pts = [0], v = 0, mn = 0, mx = 0;
      for (var i = 0; i < rc.segs.length; i++) {
        v += rc.segs[i].slope;
        pts.push(v);
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      if (mx - mn < 0.02) mx = mn + 0.02;
      return { pts: pts, mn: mn, mx: mx, n: rc.segs.length };
    }
    function xAt(i) { return TR.x0 + (W - TR.x0 * 2) * i / view.n; }
    function yAt(val) {
      return TR.yBot - 12 - (val - view.mn) / (view.mx - view.mn) * (TR.yBot - TR.yTop - 24);
    }
    function carXY(prog) {
      var f = Math.min(view.n - 0.001, prog / D.SEG_LEN);
      var i = Math.floor(f), t = f - i;
      var x0 = xAt(i), x1 = xAt(i + 1);
      var y0 = yAt(view.pts[i]), y1 = yAt(view.pts[i + 1]);
      return {
        x: x0 + (x1 - x0) * t,
        y: y0 + (y1 - y0) * t,
        ang: Math.atan2(y1 - y0, x1 - x0)
      };
    }

    var STALL_NAME = { repair: '維修中', tire: '換胎中', limit: '熄火救援', pit: '進站中' };
    var MEDAL = ['#f5c542', '#c3cad6', '#cd8a4d'];
    var AI_COLORS = ['#5d6b7e', '#6e5d7e', '#5d7e6e', '#7e6e5d', '#5d6e7e', '#7e5d6b', '#6b7e5d', '#5d5d7e', '#7e6b5d'];
    function smokePuffs(x, y, tick) {
      for (var i = 0; i < 3; i++) {
        var t = (tick * 1.2 + i * 45) % 130;
        var a = 0.42 * (1 - t / 130);
        if (a <= 0.02) continue;
        ctx.fillStyle = 'rgba(168,176,188,' + a.toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(x - 10 - t / 10, y - 18 - t / 4.5, 2.5 + t / 24, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    function drawRace() {
      btns = [];
      ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
      var s = save, pcar = race.cars[0];

      // 天空 + 賽道區網格
      var sky = ctx.createLinearGradient(0, 74, 0, TR.yBot + 14);
      sky.addColorStop(0, '#16212f'); sky.addColorStop(1, '#0d1117');
      ctx.fillStyle = sky; ctx.fillRect(0, 74, W, TR.yBot - 60);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
      for (var gl = TR.yTop; gl < TR.yBot; gl += 36) {
        ctx.beginPath(); ctx.moveTo(TR.x0, gl); ctx.lineTo(W - TR.x0, gl); ctx.stroke();
      }

      // 即時排名
      var order = race.cars.slice().sort(function (a, b) {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        return b.prog - a.prog;
      });
      if (race.finishOrder.length) {
        var fins = race.finishOrder.slice();
        var rest = race.cars.filter(function (cc) { return !cc.finished; }).sort(function (a, b) { return b.prog - a.prog; });
        order = fins.concat(rest);
      }
      var myRank = order.indexOf(pcar) + 1;

      // HUD
      UI.text(ctx, raceDef.name + ' · 神秘賽道', 20, 26, 14, D.COL.text, 'left', true);
      UI.text(ctx, '第 ' + myRank + ' 名 / 10 · 路段 ' + Math.min(view.n, (pcar.segIdx + 1)) + '/' + view.n, 230, 26, 12, D.COL.gold);
      UI.text(ctx, D.fmt(s.money), W - 20, 26, 12, D.COL.gold, 'right');
      UI.text(ctx, '胎', 20, 48, 11, D.COL.text);
      UI.bar(ctx, 40, 39, 110, 9, pcar.tirePct, pcar.tirePct < 0.25 ? D.COL.red : D.COL.gold);
      UI.text(ctx, Math.round(pcar.tirePct * 100) + '%', 156, 48, 11, D.COL.sub);
      btn(196, 36, 46, 18, '棄賽', function () { quitRace(); }, { size: 10 });
      if (tired) UI.text(ctx, '疲勞出賽（失誤 +50%）', 252, 48, 10, D.COL.red);
      var muls = [1, 2, 4];
      for (var m = 0; m < 3; m++) {
        (function (mu, x) {
          btn(x, 36, 36, 18, '×' + mu, function () { speedMul = mu; }, { size: 11, gold: speedMul === mu });
        })(muls[m], W - 248 + m * 42);
      }
      if (raceDef.pit > 0) {
        btn(W - 116, 36, 96, 18, pcar.pitPlan ? '進站已預約' : '下個進站區進站',
          function () { pcar.pitPlan = !pcar.pitPlan; }, { size: 10, gold: pcar.pitPlan });
      }
      UI.bar(ctx, 20, 62, W - 40, 5, pcar.prog / race.total, D.COL.blue);

      // 地形填色（漸層）
      var tg = ctx.createLinearGradient(0, TR.yTop, 0, TR.yBot + 14);
      tg.addColorStop(0, '#27313f'); tg.addColorStop(1, '#11161c');
      ctx.beginPath();
      ctx.moveTo(xAt(0), yAt(view.pts[0]));
      for (var j = 1; j <= view.n; j++) ctx.lineTo(xAt(j), yAt(view.pts[j]));
      ctx.lineTo(xAt(view.n), TR.yBot + 14);
      ctx.lineTo(xAt(0), TR.yBot + 14);
      ctx.closePath();
      ctx.fillStyle = tg; ctx.fill();

      // 亂流區整柱淡染
      for (var i = 0; i < view.n; i++) {
        if (race.segs[i].zone) {
          ctx.fillStyle = 'rgba(210,153,34,0.08)';
          ctx.fillRect(xAt(i), TR.yTop - 8, xAt(i + 1) - xAt(i), TR.yBot - TR.yTop + 20);
        }
      }

      // 分段路面上色（漲紅跌綠 + 微光暈）
      var glow = view.n <= 130;
      for (var k = 0; k < view.n; k++) {
        var sg = race.segs[k];
        var col = sg.slope >= 0 ? D.COL.up : D.COL.down;
        ctx.strokeStyle = col;
        ctx.lineWidth = view.n > 200 ? 1.6 : 2.6;
        ctx.setLineDash(sg.gap ? [4, 4] : []);
        if (glow) { ctx.shadowColor = col; ctx.shadowBlur = 5; }
        ctx.beginPath();
        ctx.moveTo(xAt(k), yAt(view.pts[k]));
        ctx.lineTo(xAt(k + 1), yAt(view.pts[k + 1]));
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (sg.pit) {
          ctx.setLineDash([]);
          var px = xAt(k), py0 = yAt(view.pts[k]);
          ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px, py0 - 4); ctx.lineTo(px, py0 - 24); ctx.stroke();
          ctx.fillStyle = '#1158a8';
          UI.rr(ctx, px, py0 - 26, 16, 12, 3); ctx.fill();
          UI.text(ctx, 'P', px + 8, py0 - 16.5, 10, '#cfe4ff', 'center', true);
        }
        if (sg.sharp && glow) {
          ctx.setLineDash([]);
          var sx = (xAt(k) + xAt(k + 1)) / 2;
          var sy2 = Math.min(yAt(view.pts[k]), yAt(view.pts[k + 1])) - 12;
          ctx.fillStyle = 'rgba(240,165,39,0.95)';
          ctx.beginPath(); ctx.arc(sx, sy2, 5, 0, Math.PI * 2); ctx.fill();
          UI.text(ctx, '!', sx, sy2 + 3.5, 9, '#231703', 'center', true);
        }
      }
      ctx.setLineDash([]);

      // 終點旗
      var fx = xAt(view.n), fy = yAt(view.pts[view.n]);
      ctx.strokeStyle = '#aab2bd'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 32); ctx.stroke();
      for (var fr = 0; fr < 2; fr++) for (var fc = 0; fc < 3; fc++) {
        ctx.fillStyle = (fr + fc) % 2 === 0 ? '#e6edf3' : '#22262e';
        ctx.fillRect(fx + fc * 6, fy - 32 + fr * 6 + (fc === 1 ? 1 : 0), 6, 6);
      }

      // 車（後名次先畫，玩家最上層）
      for (var ci = race.cars.length - 1; ci >= 0; ci--) {
        var car = race.cars[ci];
        if (car.finished && !car.isPlayer) continue;
        var p = car.finished ? { x: fx, y: fy, ang: 0 } : carXY(car.prog);
        var col2 = car.isPlayer ? '#f0a527' : AI_COLORS[(ci - 1) % AI_COLORS.length];
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y - 1, car.isPlayer ? 13 : 9, 2.5, p.ang || 0, 0, Math.PI * 2); ctx.fill();
        if (car.isPlayer && car.boostTicks > 0) {
          ctx.save(); ctx.translate(p.x, p.y - 2); ctx.rotate(p.ang || 0);
          var fl = 16 + (race.tick % 3) * 5;
          var fg = ctx.createLinearGradient(-12, 0, -12 - fl, 0);
          fg.addColorStop(0, 'rgba(255,205,60,0.95)'); fg.addColorStop(1, 'rgba(239,83,80,0)');
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.moveTo(-12, -9); ctx.lineTo(-12 - fl, -4.5); ctx.lineTo(-12, -1);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        UI.car(ctx, p.x, p.y - 2, car.isPlayer ? 1.35 : 0.95, col2,
          { angle: p.ang, glow: car.isPlayer ? 'rgba(240,165,39,0.75)' : (car.boostTicks > 0 ? 'rgba(255,160,40,0.6)' : null) });
        if (car.stall > 0 && !car.finished) {
          smokePuffs(p.x, p.y, race.tick + ci * 17);
          UI.text(ctx, '🔧', p.x + 14, p.y - 22 + Math.sin(race.tick / 7 + ci) * 2.5, 13, D.COL.text, 'center');
        }
        if (car.isPlayer) UI.text(ctx, '你', p.x, p.y - 26, 11, D.COL.gold, 'center', true);
      }

      // QTE 時機條（急彎接近中）
      var qteOn = pcar.qtePending && !pcar.qteResolved && !pcar.finished;
      if (qteOn) {
        var qp = Math.max(0, Math.min(1, (pcar.prog / D.SEG_LEN) - pcar.segIdx));
        var qx = W / 2 - 130, qy = TR.yTop, qw = 260;
        ctx.save(); ctx.shadowColor = 'rgba(38,166,154,0.6)'; ctx.shadowBlur = 12;
        ctx.fillStyle = 'rgba(10,22,20,0.94)';
        UI.rr(ctx, qx, qy, qw, 36, 9); ctx.fill(); ctx.restore();
        ctx.strokeStyle = '#2fbfae'; ctx.lineWidth = 1.5;
        UI.rr(ctx, qx, qy, qw, 36, 9); ctx.stroke();
        UI.text(ctx, '急彎！綠區內按「煞車」', qx + 12, qy + 14, 10, '#7fd8cc', 'left', true);
        ctx.fillStyle = '#0a0e13'; UI.rr(ctx, qx + 12, qy + 20, qw - 24, 10, 5); ctx.fill();
        var z0 = qx + 12 + (qw - 24) * D.PLAY.qteZone[0];
        var z1 = qx + 12 + (qw - 24) * D.PLAY.qteZone[1];
        ctx.fillStyle = 'rgba(38,166,154,0.6)'; UI.rr(ctx, z0, qy + 20, z1 - z0, 10, 5); ctx.fill();
        var nx2 = qx + 12 + (qw - 24) * qp;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(nx2, qy + 17); ctx.lineTo(nx2, qy + 33); ctx.stroke();
      }

      // 玩家搶修橫幅（維修小組 · 連打加速）
      if (pcar.stall > 0 && !pcar.finished) {
        var by0 = qteOn ? TR.yTop + 42 : TR.yTop;
        var pct2 = Math.round((1 - pcar.stall / Math.max(1, pcar.stallTotal || pcar.stall)) * 100);
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
        ctx.fillStyle = 'rgba(43,34,16,0.94)';
        UI.rr(ctx, W / 2 - 150, by0, 300, 32, 9); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = '#9e6a03'; ctx.lineWidth = 1;
        UI.rr(ctx, W / 2 - 150, by0, 300, 32, 9); ctx.stroke();
        UI.text(ctx, '⛑ ' + (STALL_NAME[pcar.stallKind] || '搶修中') + '… ' + pct2 + '% · 連點搶修！', W / 2 - 64, by0 + 21, 12, D.COL.gold, 'center', true);
        UI.bar(ctx, W / 2 + 56, by0 + 12, 80, 8, pct2 / 100, D.COL.gold);
      }

      // 名次面板
      var py = TR.yBot + 26, half = (W - 50) / 2;
      UI.card(ctx, 20, py, half, H - py - 16);
      UI.text(ctx, '即時名次 · 前 3 完賽即結束', 36, py + 22, 11, D.COL.sub);
      var rows = Math.min(6, Math.floor((H - py - 52) / 22));
      var shown = order.slice(0, rows);
      if (shown.indexOf(pcar) < 0) shown[rows - 1] = pcar;
      for (var q = 0; q < shown.length; q++) {
        var cq = shown[q], rk = order.indexOf(cq) + 1;
        var ry2 = py + 44 + q * 22;
        if (cq.isPlayer) {
          ctx.fillStyle = 'rgba(240,165,39,0.08)';
          UI.rr(ctx, 28, ry2 - 14, half - 16, 20, 5); ctx.fill();
        }
        if (rk <= 3) {
          ctx.fillStyle = MEDAL[rk - 1];
          ctx.beginPath(); ctx.arc(40, ry2 - 4, 4.5, 0, Math.PI * 2); ctx.fill();
        }
        var col3 = cq.isPlayer ? D.COL.gold : (cq.stall > 0 ? D.COL.red : D.COL.text);
        var tag = cq.finished ? '（完賽）' : (cq.stall > 0 ? '（' + (STALL_NAME[cq.stallKind] || '停等') + '）' : '');
        var nm2 = cq.isPlayer ? cq.name : cq.name + ' Lv' + (cq.dispLv || 1);
        UI.text(ctx, rk + '  ' + nm2 + tag, 52, ry2, 11, col3, 'left', cq.isPlayer);
        UI.text(ctx, Math.min(100, Math.round(cq.prog / race.total * 100)) + '%', 20 + half - 16, ry2, 11, cq.isPlayer ? D.COL.gold : D.COL.sub, 'right');
      }
      // 事件面板
      var ex = 30 + half;
      UI.card(ctx, ex, py, half, H - py - 16);
      if (race.camp) {
        var ruNames = [];
        for (var ri2 = 0; ri2 < race.camp.ruleList.length; ri2++) ruNames.push(race.camp.ruleList[ri2].name);
        UI.text(ctx, '賽況 · ⚔第' + race.camp.n + '關 ' + race.camp.name + (ruNames.length ? '（' + ruNames.join('·') + '）' : ''), ex + 16, py + 22, 11, '#ef5350');
      } else {
        UI.text(ctx, '賽況', ex + 16, py + 22, 11, D.COL.sub);
      }
      var evs = race.events.slice(-5);
      for (var ev = 0; ev < evs.length; ev++) {
        var E = evs[ev];
        UI.text(ctx, E.msg, ex + 16, py + 44 + ev * 20, 10,
          E.type === 'bad' ? D.COL.red : E.type === 'good' ? D.COL.green : D.COL.sub);
      }
      // 情境行動鍵（手機點擊 / 電腦空白鍵）
      var mode = qteOn ? 'qte' : (pcar.stall > 0 ? 'mash' : 'nitro');
      var nitroOut = mode === 'nitro' && (pcar.nitro <= 0 || pcar.boostTicks > 0);
      // 征途暗器列：賽況面板底部（按 1/2/3 或點擊發射）
      if (race.camp && race.itemsLeft) {
        var ks = D.ITEM_KEYS;
        UI.text(ctx, '🗡 暗器（1/2/3 或點擊 · 鎖定前車）', ex + 16, H - 64, 9, D.COL.dim);
        for (var ii = 0; ii < ks.length; ii++) {
          (function (t, x) {
            var it = D.ITEMS[t], left = race.itemsLeft[t] || 0;
            btn(x, H - 54, 62, 26, (ii + 1) + ' ' + it.icon + '×' + left, function () { fireItem(t); },
              { size: 11, disabled: left <= 0, gold: left > 0 });
          })(ks[ii], ex + 16 + ii * 68);
        }
      }
      var bx = W - 62, by = H - 62, br = 38;
      var pulse = mode !== 'nitro' ? (Math.sin(race.tick / 4) + 1) / 2 : 0;
      ctx.save();
      if (!nitroOut) {
        ctx.shadowColor = mode === 'qte' ? 'rgba(47,191,174,0.9)' : mode === 'mash' ? 'rgba(229,83,75,0.9)' : 'rgba(240,165,39,0.7)';
        ctx.shadowBlur = 12 + pulse * 16;
      }
      var bgBtn = ctx.createLinearGradient(0, by - br, 0, by + br);
      if (nitroOut) { bgBtn.addColorStop(0, '#222831'); bgBtn.addColorStop(1, '#171b21'); }
      else if (mode === 'qte') { bgBtn.addColorStop(0, '#1d6e63'); bgBtn.addColorStop(1, '#0c3a34'); }
      else if (mode === 'mash') { bgBtn.addColorStop(0, '#8a322d'); bgBtn.addColorStop(1, '#4a1a17'); }
      else { bgBtn.addColorStop(0, '#3e2f0f'); bgBtn.addColorStop(1, '#241a08'); }
      ctx.fillStyle = bgBtn;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = nitroOut ? '#2c333d' : (mode === 'qte' ? '#2fbfae' : mode === 'mash' ? '#e5534b' : '#9e6a03');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.stroke();
      var lbl = mode === 'qte' ? '煞車！' : mode === 'mash' ? '🔧搶修' : (pcar.boostTicks > 0 ? '加速中' : '氮氣×' + pcar.nitro);
      UI.text(ctx, lbl, bx, by + 5, 13, nitroOut ? D.COL.dim : (mode === 'nitro' ? D.COL.gold : '#fff'), 'center', true);
      // 來襲警示（最上層）
      if (race.camp && race.incoming) {
        var eta2 = race.incoming.eta, warnT2 = D.CAMPAIGN.itemWarnTicks;
        var winT2 = warnT2 * 0.42 * (race.rules.fog ? 0.5 : 1) + C.armVal('dodge', save.armory.dodge);
        var inWin2 = eta2 <= winT2;
        ctx.fillStyle = inWin2 ? 'rgba(46,160,67,0.20)' : 'rgba(239,83,80,0.16)';
        ctx.fillRect(0, 74, W, TR.yBot - 60);
        UI.text(ctx, '⚠ ' + D.ITEMS[race.incoming.type].icon + ' 暗器來襲！' + (inWin2 ? '按空白閃避！！' : '預備…'), W / 2, 112, 16, inWin2 ? D.COL.green : '#ef5350', 'center', true);
        UI.bar(ctx, W / 2 - 110, 124, 220, 8, eta2 / warnT2, inWin2 ? D.COL.green : '#ef5350');
      }
      btns.push({ x: bx - br, y: by - br, w: br * 2, h: br * 2, fn: contextAction });
      UI.text(ctx, '空白鍵', bx, by + br + 13, 9, D.COL.dim, 'center');

      drawToasts();
    }

    function loop() {
      if (!alive || screen !== 'race') return;
      var pc0 = race.cars[0];
      var steps = (pc0.qtePending && !pc0.qteResolved && !pc0.finished) ? 1 : speedMul * 2;
      for (var i = 0; i < steps && !race.done; i++) C.stepRace(race);
      drawRace();
      if (race.done) { finalize(); screen = 'result'; draw(); return; }
      rafId = requestAnimationFrame(loop);
    }

    function quitRace() {
      if (!race || race.done) return;
      race.quit = true;
      race.done = true;
      var fins = race.finishOrder.slice();
      var rest = race.cars.filter(function (c) { return !c.finished; }).sort(function (a, b) { return b.prog - a.prog; });
      race.ranking = fins.concat(rest);
    }

    /* ---------- 玩家主動操作 ---------- */
    function useNitro() {
      var pcar = race && race.cars[0];
      if (!pcar || pcar.finished || pcar.stall > 0) return;
      if (pcar.nitro <= 0 || pcar.boostTicks > 0) return;
      pcar.nitro--;
      pcar.boostTicks = D.PLAY.nitroTicks;
      race.events.push({ tick: race.tick, msg: '氮氣全開！', type: 'good' });
    }
    function mashRepair() {
      var pcar = race && race.cars[0];
      if (!pcar || pcar.stall <= 0) return;
      pcar.stall = Math.max(0, pcar.stall - (D.PLAY.mashTick + race.playerStats.str * D.PLAY.mashStr));
    }
    function cornerTap() {
      var pcar = race && race.cars[0];
      if (!pcar || !pcar.qtePending || pcar.qteResolved) return;
      var p = (pcar.prog / D.SEG_LEN) - pcar.segIdx;
      pcar.qteResolved = true;
      if (p >= D.PLAY.qteZone[0] && p <= D.PLAY.qteZone[1]) {
        pcar.nextCurveMod = D.PLAY.qtePerfectMod;
        pcar.prog += D.PLAY.qtePerfectBoost;
        race.events.push({ tick: race.tick, msg: '完美過彎！', type: 'good' });
      } else {
        pcar.nextCurveMod = D.PLAY.qteEarlyMod;
        race.events.push({ tick: race.tick, msg: '煞車太早，小失速', type: 'info' });
      }
    }
    function contextAction() {
      var pcar = race && race.cars[0];
      if (!pcar || pcar.finished) return;
      if (race.incoming) {
        var win = D.CAMPAIGN.itemWarnTicks * 0.42 * (race.rules.fog ? 0.5 : 1) + C.armVal('dodge', save.armory.dodge);
        C.tryDodge(race, win);
        return;
      }
      if (pcar.qtePending && !pcar.qteResolved) cornerTap();
      else if (pcar.stall > 0) mashRepair();
      else useNitro();
    }

    function fireItem(type) {
      if (!race || race.done || !race.itemsLeft) return;
      var dmg = C.armVal('dmg', save.armory.dmg);
      C.fireItem(race, type, dmg);
    }

    /* ---------- 結算 ---------- */
    function finalize() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      var s = save;
      var res = C.settle(race);
      var prize = race.quit ? 0 : res.prize;
      var xp = race.quit ? 0 : res.xp;
      var debtCut = 0;
      if (s.debtRepair > 0 && prize > 0) {
        debtCut = Math.min(s.debtRepair, Math.round(prize * D.PRIZE_DEBT_CUT));
        s.debtRepair -= debtCut;
      }
      s.money += prize - debtCut;
      // 妖股分紅：賽道是現役妖股 → 獎金 +50%
      var yao = null, yaoBonus = 0;
      if (!race.quit && !race.isSynth && prize > 0) {
        yao = C.checkYaogu(race.codeLabel);
        if (yao) {
          yaoBonus = Math.round(prize * D.YAO_BONUS);
          s.money += yaoBonus;
        }
      }
      var bill = res.billTotal;
      var paid = Math.min(s.money, bill);
      s.money -= paid;
      var owe = bill - paid;
      if (owe > 0) s.debtRepair += owe;
      var ups = xp > 0 ? C.addXp(s, xp) : 0;
      // 車況寫回
      var pc = C.activeCar(s), rcar = race.cars[0];
      var barsRun = Math.max(0, Math.min(race.segs.length, rcar.segIdx + 1));
      pc.tirePct = rcar.tirePct;
      pc.milesSinceService += barsRun;
      pc.tireBarsUsed = (pc.tireBarsUsed || 0) + barsRun;
      pc.svcBuff = 0; // 保養 buff 一場有效
      if (rcar.pitTireNew) pc.tireType = 'normal';
      // 體力 / 天
      if (tired) s.energy = 0;
      else s.energy = Math.max(0, s.energy - raceDef.energy);
      s.stats2.races++;
      if (!race.quit && res.rank === 1) s.stats2.wins++;
      s.stats2.earned += prize;
      C.growRivals(s, pc.accel + pc.grip + pc.climb);
      // 征途結算：扣耗用暗器、勝利推進關卡
      var campWin = false, campReward = 0;
      if (race.camp) {
        for (var ck = 0; ck < D.ITEM_KEYS.length; ck++) {
          var tk = D.ITEM_KEYS[ck];
          s.items[tk] = Math.max(0, (s.items[tk] || 0) - (race.itemsUsed[tk] || 0));
        }
        if (!race.quit && res.beatBoss) {
          campWin = true;
          campReward = race.camp.reward;
          s.money += campReward;
          C.addXp(s, race.camp.xp);
          s.campaign.cleared = Math.max(s.campaign.cleared, race.camp.n);
          s.campaign.stage = race.camp.n + 1;
        }
      }
      var msgs = C.endDay(s);
      result = { res: res, prize: prize, xp: xp, debtCut: debtCut, bill: bill, owe: owe, ups: ups, msgs: msgs, quit: !!race.quit, yao: yao, yaoBonus: yaoBonus, campWin: campWin, campReward: campReward, camp: race.camp };
      persist();
      for (var i = 0; i < msgs.length; i++) toast(msgs[i]);
      if (ups > 0) toast('升級！Lv.' + s.lv + ' · 配點 +' + (ups * 3));
      if (yaoBonus > 0) toast('🔥 妖股分紅 +' + D.fmt(yaoBonus) + '！');
      if (race.camp) toast(campWin ? '👑 擊敗 ' + race.camp.name + '！+' + D.fmt(campReward) + '，第 ' + (race.camp.n + 1) + ' 關解鎖' : '魔王戰失敗…可重新挑戰');
    }

    function drawResult() {
      ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
      drawBackdrop();
      var R = result, s = save;
      var top3 = !R.quit && R.res.rank <= 3;
      // 名次徽章
      ctx.save();
      if (top3) { ctx.shadowColor = 'rgba(240,165,39,0.7)'; ctx.shadowBlur = 26; }
      var bg2 = ctx.createLinearGradient(0, 46, 0, 122);
      if (R.quit) { bg2.addColorStop(0, '#4a2226'); bg2.addColorStop(1, '#2a1416'); }
      else if (top3) { bg2.addColorStop(0, '#f5c542'); bg2.addColorStop(1, '#9e6a03'); }
      else { bg2.addColorStop(0, '#3a4250'); bg2.addColorStop(1, '#22262e'); }
      ctx.fillStyle = bg2;
      ctx.beginPath(); ctx.arc(W / 2, 84, 38, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = R.quit ? '#e5534b' : (top3 ? '#ffe08a' : '#4a525e');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(W / 2, 84, 38, 0, Math.PI * 2); ctx.stroke();
      if (R.quit) UI.text(ctx, '棄賽', W / 2, 91, 17, '#ffb3ae', 'center', true);
      else {
        UI.text(ctx, String(R.res.rank), W / 2, 92, 30, top3 ? '#231703' : D.COL.text, 'center', true);
        UI.text(ctx, '第　　名', W / 2, 90, 11, top3 ? 'rgba(35,23,3,0.7)' : D.COL.sub, 'center');
      }
      UI.text(ctx, raceDef.name + ' 結束', W / 2, 142, 12, D.COL.sub, 'center');
      var nm = race.codeName || C.stockName(race.codeLabel);
      var label = race.isSynth ? '模擬賽道（離線）'
        : race.codeLabel + (nm ? ' ' + nm : '') + ' 過去 ' + raceDef.period + ' 的 K 線' + (R.yao ? ' 🔥妖股' : '');
      UI.text(ctx, '賽道揭曉：' + label, W / 2, 164, 13, D.COL.blue, 'center', true);

      UI.card(ctx, W / 2 - 200, 178, 400, 196);
      var ly = 206;
      function row(name, val, col) {
        UI.text(ctx, name, W / 2 - 180, ly, 12, D.COL.sub);
        UI.text(ctx, val, W / 2 + 180, ly, 12, col || D.COL.text, 'right');
        ly += 24;
      }
      row('獎金', '+' + D.fmt(R.prize), D.COL.gold);
      if (R.yaoBonus > 0) row('🔥 妖股分紅（' + R.yao.tags.join('+') + '）', '+' + D.fmt(R.yaoBonus), D.COL.up);
      if (R.debtCut > 0) row('賒帳自動扣 10%', '−' + D.fmt(R.debtCut), D.COL.red);
      row('賽中帳單（' + R.res.bills.length + ' 筆）', '−' + D.fmt(R.bill), R.bill > 0 ? D.COL.red : D.COL.sub);
      if (R.owe > 0) row('付不出 → 轉賒帳', D.fmt(R.owe), D.COL.red);
      row('XP', '+' + R.xp + (R.ups > 0 ? '（升級 ×' + R.ups + '）' : ''), D.COL.blue);
      row('目前現金', D.fmt(s.money), D.COL.gold);
      if (s.debtRepair > 0) row('賒帳餘額', D.fmt(s.debtRepair), D.COL.red);
      if (R.bill > 0) UI.text(ctx, '車有受損？去「修配廠」保養、補強再戰', W / 2, 392, 10, D.COL.sub, 'center');

      btn(W / 2 - 232, 404, 108, 34, R.camp ? '⚔ 征途' : '再來一場', function () { screen = R.camp ? 'camp' : 'select'; draw(); }, { gold: true });
      btn(W / 2 - 116, 404, 108, 34, '修配廠', function () { enterLife('tune'); });
      btn(W / 2, 404, 108, 34, '生活模式', function () { enterLife(); });
      btn(W / 2 + 116, 404, 116, 34, '回主選單', function () { screen = 'menu'; draw(); });
    }

    /* ---------- destroy ---------- */
    function destroy() {
      alive = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (toastTimer) clearTimeout(toastTimer);
      if (loadTimer) clearTimeout(loadTimer);
      canvas.removeEventListener('click', onClick);
      if (window.removeEventListener) window.removeEventListener('keydown', onKey);
      if (KR.L && KR.L.stop) { try { KR.L.stop(); } catch (e) {} }
      canvas.__krDestroy = null;
    }
    canvas.__krDestroy = destroy;
    return destroy;
  }

  /* ---------- 註冊 ---------- */
  if (!window.__GAMES) {
    window.__GAMES = { _q: [], register: function (d) { this._q.push(d); } };
  }
  window.__GAMES.register({
    id: 'klineRacer',
    name: '🏁 K線賽車・人生路',
    hint: '隨機台股K線當賽道，打工買房養車的賽車人生 · 點按鈕操作',
    canvasH: 620,
    init: init
  });
})();
