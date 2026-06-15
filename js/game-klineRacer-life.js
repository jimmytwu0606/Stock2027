/* ============================================================
 * game-klineRacer-life.js — 生活模式：打工/休息/銀行/房產/車庫/改裝
 * 依賴：data + core（window.__KR.D / .C）
 * 對主檔介面：KR.L.enter(env) / KR.L.draw() / KR.L.click(x,y) / KR.UI
 * env = { ctx, W, H, save, persist(), toast(msg), exit(), repaint() }
 * ============================================================ */
(function () {
  'use strict';
  var KR = window.__KR;
  var D = KR.D, C = KR.C;

  /* ---------- 共用 canvas UI（主檔也用） ---------- */
  var UI = {
    rr: function (ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },
    shade: function (hex, amt) {
      var n = parseInt(hex.slice(1), 16);
      var r = D.clamp(((n >> 16) & 255) + amt, 0, 255);
      var g = D.clamp(((n >> 8) & 255) + amt, 0, 255);
      var b = D.clamp((n & 255) + amt, 0, 255);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    },
    card: function (ctx, x, y, w, h, stroke) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
      var g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#1c222c'); g.addColorStop(1, '#12171e');
      ctx.fillStyle = g; UI.rr(ctx, x, y, w, h, 10); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = stroke || '#2c333d'; ctx.lineWidth = 1;
      UI.rr(ctx, x, y, w, h, 10); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x + 10, y + 1.5); ctx.lineTo(x + w - 10, y + 1.5); ctx.stroke();
    },
    text: function (ctx, s, x, y, size, color, align, bold) {
      ctx.fillStyle = color || D.COL.text;
      ctx.font = (bold ? '600 ' : '') + (size || 13) + 'px sans-serif';
      ctx.textAlign = align || 'left';
      ctx.fillText(s, x, y);
      ctx.textAlign = 'left';
    },
    bar: function (ctx, x, y, w, h, pct, color) {
      ctx.fillStyle = '#0a0e13';
      UI.rr(ctx, x, y, w, h, h / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.8;
      UI.rr(ctx, x, y, w, h, h / 2); ctx.stroke();
      var p = D.clamp(pct, 0, 1);
      if (p > 0.02) {
        var hex = color.charAt(0) === '#' ? color : '#888780';
        var g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, UI.shade(hex, 25)); g.addColorStop(1, UI.shade(hex, -35));
        ctx.fillStyle = g;
        UI.rr(ctx, x + 1, y + 1, Math.max(h - 2, (w - 2) * p), h - 2, (h - 2) / 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        UI.rr(ctx, x + 2, y + 1.6, Math.max(h - 4, (w - 4) * p), Math.max(1.2, (h - 2) / 2.6), (h - 2) / 4); ctx.fill();
      }
    },
    // 側視小賽車插畫：原點在輪胎著地處，s=縮放
    car: function (ctx, x, y, s, color, opt) {
      opt = opt || {};
      var hex = color && color.charAt(0) === '#' ? color : '#5d6b7e';
      ctx.save();
      ctx.translate(x, y);
      if (opt.angle) ctx.rotate(opt.angle);
      if (opt.glow) { ctx.shadowColor = opt.glow; ctx.shadowBlur = 12; }
      var g = ctx.createLinearGradient(0, -10 * s, 0, -2 * s);
      g.addColorStop(0, UI.shade(hex, 38)); g.addColorStop(1, UI.shade(hex, -12));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-9 * s, -2.5 * s);
      ctx.lineTo(-8.2 * s, -6 * s);
      ctx.lineTo(-3.5 * s, -7 * s);
      ctx.lineTo(-1.5 * s, -10 * s);
      ctx.lineTo(4 * s, -10 * s);
      ctx.lineTo(6.5 * s, -6.6 * s);
      ctx.lineTo(9.2 * s, -5.6 * s);
      ctx.lineTo(9.6 * s, -2.5 * s);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(170,215,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(-0.8 * s, -9.2 * s); ctx.lineTo(3.4 * s, -9.2 * s);
      ctx.lineTo(5 * s, -6.9 * s); ctx.lineTo(-0.8 * s, -6.9 * s);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = UI.shade(hex, -40);
      ctx.fillRect(-10.4 * s, -8.2 * s, 2.2 * s, 1.5 * s);
      ctx.fillStyle = 'rgba(255,236,160,0.9)';
      ctx.fillRect(8.6 * s, -5.2 * s, 1.4 * s, 1.2 * s);
      var wx = [-5.2 * s, 5.2 * s];
      for (var wi = 0; wi < 2; wi++) {
        ctx.fillStyle = '#0e1218';
        ctx.beginPath(); ctx.arc(wx[wi], -1.4 * s, 2.9 * s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#454f5e';
        ctx.beginPath(); ctx.arc(wx[wi], -1.4 * s, 1.25 * s, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  };
  KR.UI = UI;

  /* ---------- 生活模式 ---------- */
  var L = {};
  var env = null;
  var st = { tab: 'job', btns: [], selCar: 0, loanAmt: 10000, loanPlan: 1 };

  var busyTimer = null;

  L.enter = function (e, tab) {
    env = e;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    st.busy = null;
    st.tab = tab || 'job'; st.selCar = e.save.activeCar;
    L.draw();
  };

  L.stop = function () {
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    st.busy = null;
    env = null;
  };

  // loading 過場：steps 步，每步 stepFn(i) 回傳 false 表示中斷
  function runBusy(title, steps, stepFn, doneMsg) {
    st.busy = { title: title, total: steps, done: 0, msg: '準備中…' };
    var tick = function () {
      busyTimer = null;
      if (!env || !st.busy) return;
      var cont = stepFn(st.busy.done);
      st.busy.done++;
      if (cont === false || st.busy.done >= st.busy.total) {
        var fin = st.busy.msg;
        st.busy = null;
        env.persist();
        if (doneMsg && cont !== false) env.toast(doneMsg);
        else if (fin) env.toast(fin);
        L.draw();
        return;
      }
      L.draw();
      busyTimer = setTimeout(tick, D.BUSY_MS);
    };
    L.draw();
    busyTimer = setTimeout(tick, 420);
  }

  function drawBusy(ctx, W, H) {
    ctx.fillStyle = 'rgba(5,8,12,0.88)';
    ctx.fillRect(0, 0, W, H);
    var b = st.busy;
    UI.card(ctx, W / 2 - 190, H / 2 - 80, 380, 150);
    UI.text(ctx, b.title, W / 2, H / 2 - 46, 16, D.COL.text, 'center', true);
    UI.text(ctx, '第 ' + Math.min(b.done + 1, b.total) + ' / ' + b.total + ' 天', W / 2, H / 2 - 22, 11, D.COL.sub, 'center');
    UI.bar(ctx, W / 2 - 150, H / 2 - 8, 300, 12, b.done / b.total, D.COL.gold);
    UI.text(ctx, b.msg, W / 2, H / 2 + 28, 11, D.COL.blue, 'center');
    var dots = ['·', '··', '···'][Math.floor(Date.now() / 350) % 3];
    UI.text(ctx, (b.title.indexOf('休息') >= 0 ? '😴 zzZ' : '💪') + ' ' + dots, W / 2, H / 2 + 52, 13, D.COL.dim, 'center');
  }

  function btn(x, y, w, h, label, fn, opt) {
    opt = opt || {};
    var ctx = env.ctx;
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
      dis ? D.COL.dim : (opt.gold ? D.COL.gold : (opt.color || D.COL.text)), 'center');
    if (!dis) st.btns.push({ x: x, y: y, w: w, h: h, fn: fn });
  }

  L.click = function (x, y) {
    for (var i = st.btns.length - 1; i >= 0; i--) {
      var b = st.btns[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.fn(); return true; }
    }
    return false;
  };

  function act(fn) { fn(); env.persist(); L.draw(); }

  // 每天基本生活開銷：付不出 → 轉賒帳
  function payLiving(s) {
    var living = D.HOUSES[s.house].living || 0;
    if (s.money >= living) { s.money -= living; return '生活費 -' + D.fmt(living); }
    var short = living - s.money;
    s.money = 0;
    s.debtRepair += short;
    return '生活費付不出，' + D.fmt(short) + ' 轉賒帳！';
  }
  function dayEnd() {
    var msgs = C.endDay(env.save);
    for (var i = 0; i < msgs.length; i++) env.toast(msgs[i]);
  }

  /* ---------- 行為 ---------- */
  function jobOneShift(job) {
    var s = env.save;
    var cost = Math.round(job.energy * Math.max(0.5, 1 - s.stats.end * D.STAT.endJobCut));
    var pay = job.pay * (1 + s.stats.str * D.STAT.strIncome);
    if (s.resortBuff) { pay *= 1 + D.RESORT_BUFF; s.resortBuff = false; }
    pay = Math.round(pay);
    s.energy = Math.max(0, s.energy - cost);
    s.money += pay;
    s.stats[job.stat] = Math.round((s.stats[job.stat] + job.gain) * 10) / 10;
    s.jobCounts[job.id]++;
    if (job.unlock && s.jobCounts[job.id] >= job.unlock.count && !s.flags[job.unlock.flag]) {
      s.flags[job.unlock.flag] = true;
      env.toast('技術學成！自家保養費永久 9 折');
    }
    return pay;
  }

  function startJob(job, shifts) {
    var s = env.save;
    if (s.energy < D.JOB_MIN_ENERGY) { env.toast('體力不足 20，無法打工'); return; }
    var total = 0;
    runBusy(job.name + '上工中', shifts, function (i) {
      if (s.energy < D.JOB_MIN_ENERGY) {
        st.busy.msg = '體力見底，提前收工（共賺 ' + D.fmt(total) + '）';
        return false;
      }
      var pay = jobOneShift(job);
      total += pay;
      var lv = payLiving(s);
      var msgs = C.endDay(s);
      st.busy.msg = '第 ' + (i + 1) + ' 班：+' + D.fmt(pay) + ' · ' + lv + (msgs.length ? ' · ' + msgs[0] : '');
      return true;
    }, shifts + ' 班結束，共賺 ' + '?'); // doneMsg 用 busy.msg 帶總額
  }

  function startRest(r, days) {
    var s = env.save;
    var perCost = (r.cost || 0) + (D.HOUSES[s.house].living || 0);
    runBusy(r.name + '休息中', days, function (i) {
      var roomMsg = '';
      if (r.cost > 0) {
        if (s.money >= r.cost) { s.money -= r.cost; roomMsg = '房費 -' + D.fmt(r.cost); }
        else { st.busy.msg = '付不起' + r.name + '費用，提前退房'; return false; }
      }
      var max = C.energyMax(s);
      var hv = D.HOUSES[s.house].rest;
      var gain = r.gain === 'house' ? hv : r.gain;
      if (gain === 'full') s.energy = max;
      else s.energy = Math.min(max, s.energy + gain);
      if (r.buff && i === days - 1) s.resortBuff = true;
      var lv = payLiving(s);
      var msgs = C.endDay(s);
      st.busy.msg = '第 ' + (i + 1) + ' 天：體力 ' + Math.round(s.energy) + '/' + max + (roomMsg ? ' · ' + roomMsg : '') + ' · ' + lv + (msgs.length ? ' · ' + msgs[0] : '');
      return true;
    }, '休息結束！體力 ' + '?');
  }

  function doLoan() {
    var s = env.save;
    var plan = D.BANK.plans[st.loanPlan];
    var quota = C.loanQuota(s) - C.loanUsed(s);
    if (st.loanAmt > quota) { env.toast('超過可貸額度'); return; }
    var total = Math.round(st.loanAmt * (1 + plan.rate));
    s.loans.push({ principal: st.loanAmt, remaining: total, perDay: Math.ceil(total / plan.terms), paid: 0 });
    s.money += st.loanAmt;
    env.toast('核貸 ' + D.fmt(st.loanAmt) + '，' + plan.terms + ' 期每天還 ' + D.fmt(Math.ceil(total / plan.terms)));
  }

  function payDebt() {
    var s = env.save;
    var pay = Math.min(s.money, s.debtRepair);
    if (pay <= 0) { env.toast('沒有可還的賒帳或現金不足'); return; }
    s.money -= pay; s.debtRepair -= pay;
    env.toast('還賒帳 ' + D.fmt(pay));
  }

  function prepay() {
    var s = env.save;
    if (!s.loans.length) { env.toast('沒有貸款'); return; }
    var L0 = s.loans[0];
    if (s.money < L0.remaining) { env.toast('現金不足以清償整筆'); return; }
    s.money -= L0.remaining; s.loans.shift();
    s.credit = D.clamp(s.credit + 5, D.BANK.creditMin, D.BANK.creditMax);
    env.toast('提前清償！信用 +5');
  }

  function buyHouse() {
    var s = env.save;
    if (s.house >= D.HOUSES.length - 1) return;
    var cur = D.HOUSES[s.house], nx = D.HOUSES[s.house + 1];
    var cost = nx.price - Math.round(cur.price * D.HOUSE_SELLBACK);
    if (s.money < cost) { env.toast('現金不足（含舊屋折抵共需 ' + D.fmt(cost) + '）'); return; }
    s.money -= cost; s.house++;
    env.toast('搬進「' + nx.name + '」！');
  }

  function upGarage() {
    var s = env.save;
    if (s.garageLv >= D.GARAGES.length) return;
    var g = D.GARAGES[s.garageLv]; // 下一級（lv 從 1 起，index = lv）
    if (D.HOUSES[s.house].garageCap < g.lv) { env.toast('房產等級不足，先換房！'); return; }
    if (s.money < g.price) { env.toast('現金不足'); return; }
    s.money -= g.price; s.garageLv = g.lv;
    env.toast('車庫升級 Lv.' + g.lv + '，車位 ' + g.slots);
  }

  var TYPE_NAMES = { std: '小灰', sprint: '紅色閃電', hill: '山猴', endu: '老牛' };
  function buyCar(tier, type) {
    var s = env.save;
    var g = D.GARAGES[s.garageLv - 1];
    if (s.cars.length >= g.slots) { env.toast('車位已滿，升級車庫'); return; }
    if (D.TIER_ORDER.indexOf(tier) > D.TIER_ORDER.indexOf(g.tierCap)) { env.toast('車庫等級不足以停 ' + D.CAR_TIERS[tier].name); return; }
    var t = D.CAR_TIERS[tier];
    if (s.money < t.price) { env.toast('現金不足'); return; }
    s.money -= t.price;
    var base = D.TIER_ORDER.indexOf(tier) + 1;
    s.cars.push({
      id: s.nextCarId++, name: TYPE_NAMES[type] + '#' + (s.nextCarId - 1),
      tier: tier, type: type, accel: base, grip: base, climb: base,
      tireType: 'normal', tirePct: 1, tireBarsUsed: 0, milesSinceService: 0,
      mods: [], svcBuff: 0, tireTech: 0
    });
    env.toast('購入 ' + t.name + D.CAR_TYPES[type].name + '車！');
  }

  function sellCar(car) {
    var s = env.save;
    if (s.cars.length <= 1) { env.toast('最後一台車不能賣'); return; }
    if (car.id === s.activeCar) { env.toast('出賽車不能賣，先換車'); return; }
    var cash = Math.round((D.CAR_TIERS[car.tier].price || D.SERVICE_BASE_C) * 0.7);
    for (var i = 0; i < s.cars.length; i++) if (s.cars[i].id === car.id) { s.cars.splice(i, 1); break; }
    s.money += cash;
    if (st.selCar === car.id) st.selCar = s.activeCar;
    env.toast('賣出，回收 ' + D.fmt(cash));
  }

  function shopAddSpend(amt) {
    var s = env.save;
    var before = C.shopTier(s).lv;
    s.shopSpent = (s.shopSpent || 0) + amt;
    var after = C.shopTier(s);
    if (after.lv > before) env.toast('🔥 修配廠升級：' + after.name + '！新服務解鎖');
  }

  function tuneCost(car, key) {
    var c0 = D.upgradeCost(car[key] + 1, car.tier);
    if (key === 'tireTech') c0 *= D.TIRE_TECH.costMul;
    var cap = D.CAR_TIERS[car.tier].statCap;
    if (car[key] + 1 > cap) c0 *= Math.pow(D.CAP_SURGE, car[key] + 1 - cap); // 超規無上限，越貴越多
    if (C.shopTier(env.save).lv >= 3) c0 *= 0.9;
    c0 *= 1 - C.rndVal('craft', (env.save.rnd || {}).craft) / 100; // 工藝精進
    return Math.round(c0);
  }

  function switchMat(car, key) {
    var s = env.save;
    var routes = D.MATS[key].routes;
    var cur = (car.mats || {})[key] || 'lin';
    var idx = 0;
    for (var i = 0; i < routes.length; i++) if (routes[i].id === cur) idx = i;
    var next = routes[(idx + 1) % routes.length];
    var cost = (car[key] || 0) * D.MAT_SWITCH_COST;
    if (s.money < cost) { env.toast('切換需 ' + D.fmt(cost) + '（Lv×1000）'); return; }
    s.money -= cost;
    if (!car.mats) car.mats = { accel: 'lin', grip: 'lin', climb: 'lin' };
    car.mats[key] = next.id;
    if (cost > 0) shopAddSpend(cost);
    st.curveKey = key; st.curveTab = 'grow';
    env.toast('換裝 ' + next.name + '！' + next.desc + (cost ? '（' + D.fmt(cost) + '）' : ''));
  }

  function setTuneMode(car, id) {
    car.tuneMode = id;
    env.toast('切換 ' + D.TUNE_MODES[id].name + '調校');
  }

  function buyItem(t) {
    var s = env.save;
    var it = D.ITEMS[t];
    var cap = 1 + C.armVal('carry', s.armory.carry);
    if ((s.items[t] || 0) >= cap) { env.toast('攜帶已滿（彈藥庫研發可擴充）'); return; }
    if (s.money < it.price) { env.toast('現金不足 ' + D.fmt(it.price)); return; }
    s.money -= it.price;
    s.items[t] = (s.items[t] || 0) + 1;
    shopAddSpend(it.price);
    env.toast(it.icon + ' ' + it.name + ' +1');
  }

  function armUp(id) {
    var s = env.save;
    var cost = C.armCost(s.armory[id] || 0);
    if (s.money < cost) { env.toast('現金不足 ' + D.fmt(cost)); return; }
    s.money -= cost;
    s.armory[id] = (s.armory[id] || 0) + 1;
    shopAddSpend(cost);
    env.toast('武裝研發完成！Lv.' + s.armory[id]);
  }

  function rndUp(id) {
    var s = env.save;
    if (C.shopTier(s).lv < D.RND.unlockTier) { env.toast('研發中心需金牌等級'); return; }
    if (!s.rnd) s.rnd = { eng: 0, mat: 0, nos: 0, rel: 0, craft: 0 };
    var cost = C.rndCost(s.rnd[id] || 0);
    if (s.money < cost) { env.toast('現金不足 ' + D.fmt(cost)); return; }
    s.money -= cost;
    s.rnd[id] = (s.rnd[id] || 0) + 1;
    shopAddSpend(cost);
    env.toast('研發完成！Lv.' + s.rnd[id]);
  }

  function upStat(car, key) {
    var s = env.save;
    if (s.debtRepair > 0) { env.toast('有賒帳未還，升級鎖定'); return; }
    var cost = tuneCost(car, key);
    if (s.money < cost) { env.toast('現金不足 ' + D.fmt(cost)); return; }
    s.money -= cost; car[key]++;
    shopAddSpend(cost);
    env.toast('升級完成' + (C.shopTier(s).lv >= 3 ? '（高級料件 9 折）' : ''));
  }

  function buyTire(car, tid) {
    var s = env.save, t = D.TIRES[tid];
    if (C.shopTier(s).lv < (t.tier || 1)) { env.toast('修配廠等級不足，多消費累積忠誠！'); return; }
    if (s.money < t.price) { env.toast('現金不足'); return; }
    s.money -= t.price;
    car.tireType = tid; car.tirePct = 1; car.tireBarsUsed = 0;
    shopAddSpend(t.price);
    env.toast('換上' + t.name);
  }

  function doService(car, svc) {
    var s = env.save, tier = C.shopTier(s);
    if (tier.lv < svc.tier) { env.toast('修配廠等級不足'); return; }
    var cost = Math.round(C.serviceCost(car, s) * svc.mul * (tier.lv >= 5 ? 0.8 : 1));
    if (s.money < cost) { env.toast('現金不足 ' + D.fmt(cost)); return; }
    s.money -= cost; car.milesSinceService = 0;
    car.svcBuff = svc.buff || 0;
    if (svc.tireFull) car.tirePct = 1;
    shopAddSpend(cost);
    env.toast(svc.name + '完成 ' + D.fmt(cost) + (svc.buff ? '，下場故障 -' + Math.round(svc.buff * 100) + '%' : ''));
  }

  function buyMod(car, mod) {
    var s = env.save, tier = C.shopTier(s);
    if (tier.lv < mod.tier) { env.toast('需修配廠' + D.SHOP.tiers[mod.tier - 1].name + '等級'); return; }
    if (car.mods.indexOf(mod.id) >= 0) { env.toast('已安裝'); return; }
    if (car.mods.length >= (tier.slots || 0)) { env.toast('外掛欄已滿（' + tier.slots + ' 格）'); return; }
    if (s.money < mod.price) { env.toast('現金不足'); return; }
    s.money -= mod.price;
    car.mods.push(mod.id);
    shopAddSpend(mod.price);
    env.toast('安裝 ' + mod.name + '！' + mod.desc);
  }

  /* ---------- 繪製 ---------- */
  var TABS = [
    { id: 'job', name: '打工' }, { id: 'rest', name: '休息' }, { id: 'bank', name: '銀行' },
    { id: 'estate', name: '房產' }, { id: 'garage', name: '車庫' }, { id: 'tune', name: '修配廠' }
  ];

  L.draw = function () {
    if (!env) return;
    var ctx = env.ctx, W = env.W, H = env.H, s = env.save;
    st.btns = [];
    ctx.fillStyle = D.COL.bg; ctx.fillRect(0, 0, W, H);
    if (st.busy) { drawBusy(ctx, W, H); return; } // loading 期間鎖全部操作

    // header
    UI.text(ctx, '生活模式 · 第 ' + s.day + ' 天', 20, 28, 15, D.COL.text, 'left', true);
    UI.text(ctx, D.fmt(s.money), W - 20, 26, 14, D.COL.gold, 'right', true);
    var sub = 'Lv.' + s.lv + ' · 力 ' + s.stats.str.toFixed(1) + ' · 體 ' + s.stats.vit.toFixed(1) + ' · 耐 ' + s.stats.end.toFixed(1) + (s.statPts > 0 ? ' · 配點 ' + s.statPts : '');
    UI.text(ctx, sub, 20, 48, 11, D.COL.sub);
    if (s.debtRepair > 0) UI.text(ctx, '賒帳 ' + D.fmt(s.debtRepair), W - 20, 44, 11, D.COL.red, 'right');
    var emax = C.energyMax(s);
    UI.text(ctx, '體力', 20, 68, 11, D.COL.text);
    UI.bar(ctx, 52, 60, 200, 9, s.energy / emax, s.energy / emax < 0.2 ? D.COL.red : D.COL.gold);
    UI.text(ctx, Math.round(s.energy) + '/' + emax, 260, 68, 11, D.COL.sub);
    if (s.statPts > 0) {
      btn(W - 230, 56, 60, 18, '力+1', function () { act(function () { s.statPts--; s.stats.str++; }); }, { size: 11 });
      btn(W - 165, 56, 60, 18, '體+1', function () { act(function () { s.statPts--; s.stats.vit++; }); }, { size: 11 });
      btn(W - 100, 56, 60, 18, '耐+1', function () { act(function () { s.statPts--; s.stats.end++; }); }, { size: 11 });
    }
    ctx.strokeStyle = D.COL.line; ctx.beginPath(); ctx.moveTo(0, 80); ctx.lineTo(W, 80); ctx.stroke();

    // tabs
    var tw = 78;
    for (var i = 0; i < TABS.length; i++) {
      (function (t, x) {
        var on = st.tab === t.id;
        if (on) { ctx.fillStyle = D.COL.goldBg; UI.rr(ctx, x, 90, tw - 8, 26, 6); ctx.fill(); }
        UI.text(ctx, t.name, x + (tw - 8) / 2, 107, 12, on ? D.COL.gold : D.COL.sub, 'center', on);
        st.btns.push({ x: x, y: 90, w: tw - 8, h: 26, fn: function () { st.tab = t.id; L.draw(); } });
      })(TABS[i], 20 + i * tw);
    }

    var y0 = 130;
    if (st.tab === 'job') drawJob(ctx, W, y0, s);
    else if (st.tab === 'rest') drawRest(ctx, W, y0, s);
    else if (st.tab === 'bank') drawBank(ctx, W, y0, s);
    else if (st.tab === 'estate') drawEstate(ctx, W, y0, s);
    else if (st.tab === 'garage') drawGarage(ctx, W, y0, s);
    else if (st.tab === 'tune') drawTune(ctx, W, y0, s);

    // footer
    ctx.strokeStyle = D.COL.line; ctx.beginPath(); ctx.moveTo(0, H - 52); ctx.lineTo(W, H - 52); ctx.stroke();
    btn(20, H - 42, 120, 30, '← 回主選單', function () { env.exit(); }, {});
    btn(150, H - 42, 120, 30, '前往賽場 →', function () { env.exit('race'); }, { gold: true });
  };

  function drawJob(ctx, W, y, s) {
    st.jobShifts = st.jobShifts || 1;
    var living = D.HOUSES[s.house].living || 0;
    UI.text(ctx, '打工賺錢（一班 = 1 天 · 每天生活費 ' + D.fmt(living) + '）' + (s.resortBuff ? ' · 渡假 buff +20%' : ''), 20, y, 11, D.COL.sub);
    UI.text(ctx, '連上班數：', 20, y + 22, 11, D.COL.text);
    var opts = [1, 2, 3, 5];
    for (var oi = 0; oi < opts.length; oi++) {
      (function (n, x) {
        btn(x, y + 10, 44, 20, n + ' 班', function () { st.jobShifts = n; L.draw(); }, { size: 11, gold: st.jobShifts === n });
      })(opts[oi], 86 + oi * 50);
    }
    var cw = Math.min(290, (W - 60) / 3);
    for (var i = 0; i < D.JOBS.length; i++) {
      (function (j2, x) {
        UI.card(ctx, x, y + 40, cw, 152);
        UI.text(ctx, j2.name, x + 14, y + 64, 13, D.COL.text, 'left', true);
        var pay = Math.round(j2.pay * (1 + s.stats.str * D.STAT.strIncome) * (s.resortBuff ? 1.2 : 1));
        var cost = Math.round(j2.energy * Math.max(0.5, 1 - s.stats.end * D.STAT.endJobCut));
        var n = st.jobShifts;
        UI.text(ctx, '收入 ' + D.fmt(pay) + ' / 班', x + 14, y + 86, 11, D.COL.sub);
        UI.text(ctx, n + ' 班預估：+' + D.fmt(pay * n - living * n) + '（含生活費）', x + 14, y + 104, 11, D.COL.gold);
        UI.text(ctx, '體力 −' + cost + '/班 · ' + j2.note, x + 14, y + 122, 10, D.COL.blue);
        if (j2.unlock) UI.text(ctx, j2.unlock.desc + '（' + s.jobCounts[j2.id] + '/' + j2.unlock.count + '）', x + 14, y + 140, 9, s.flags[j2.unlock.flag] ? D.COL.green : D.COL.dim);
        btn(x + 14, y + 150, 100, 24, '上工 ×' + n, function () { startJob(j2, st.jobShifts); },
          { disabled: s.energy < D.JOB_MIN_ENERGY, gold: j2.id === 'repair', size: 11 });
      })(D.JOBS[i], 20 + i * (cw + 10));
    }
    if (s.energy < D.JOB_MIN_ENERGY) UI.text(ctx, '體力低於 20，先去休息', 20, y + 216, 12, D.COL.red);
  }

  function drawRest(ctx, W, y, s) {
    st.restDays = st.restDays || 1;
    var max = C.energyMax(s);
    var living = D.HOUSES[s.house].living || 0;
    var gap = Math.max(0, max - s.energy);
    var homeGain = D.HOUSES[s.house].rest;
    var sug = homeGain === 'full' ? 1 : Math.max(1, Math.ceil(gap / homeGain));
    UI.text(ctx, '休息恢復（一晚 = 1 天 · 每天生活費 ' + D.fmt(living) + '）· 在家補滿建議休 ' + sug + ' 天', 20, y, 11, D.COL.sub);
    UI.text(ctx, '休息天數：', 20, y + 22, 11, D.COL.text);
    var opts = [1, 2, 3, 5];
    for (var oi = 0; oi < opts.length; oi++) {
      (function (n, x) {
        btn(x, y + 10, 44, 20, n + ' 天', function () { st.restDays = n; L.draw(); }, { size: 11, gold: st.restDays === n });
      })(opts[oi], 86 + oi * 50);
    }
    var cw = Math.min(290, (W - 60) / 3);
    for (var i = 0; i < D.RESTS.length; i++) {
      (function (r, x) {
        UI.card(ctx, x, y + 40, cw, 132);
        UI.text(ctx, r.name, x + 14, y + 64, 13, D.COL.text, 'left', true);
        var g = r.gain === 'house' ? D.HOUSES[s.house].rest : r.gain;
        var gs = g === 'full' ? '全滿' : '+' + g + '/天';
        var n = st.restDays;
        var totalCost = ((r.cost || 0) + living) * n;
        UI.text(ctx, (r.cost ? D.fmt(r.cost) + '/晚' : '免房費') + ' · 體力 ' + gs, x + 14, y + 86, 11, D.COL.sub);
        UI.text(ctx, n + ' 天總開銷 ' + D.fmt(totalCost) + '（含生活費）', x + 14, y + 104, 11, totalCost > s.money ? D.COL.red : D.COL.gold);
        if (r.buff) UI.text(ctx, '退房隔天打工效率 +20%', x + 14, y + 122, 10, D.COL.green);
        btn(x + 14, y + 132, 100, 24, '休息 ×' + n, function () { startRest(r, st.restDays); }, { size: 11 });
      })(D.RESTS[i], 20 + i * (cw + 10));
    }
  }

  function drawBank(ctx, W, y, s) {
    var half = (W - 50) / 2;
    UI.card(ctx, 20, y, half, 280);
    UI.text(ctx, '燈燈銀行', 36, y + 24, 13, D.COL.text, 'left', true);
    UI.text(ctx, '信用分 ' + s.credit + (s.credit >= 700 ? ' · 優良' : s.credit >= 500 ? ' · 普通' : ' · 危險'), 20 + half - 16, y + 24, 11, s.credit >= 500 ? D.COL.green : D.COL.red, 'right');
    var quota = C.loanQuota(s), used = C.loanUsed(s);
    UI.text(ctx, '可貸額度 ' + D.fmt(quota - used) + '（已借 ' + D.fmt(used) + '）', 36, y + 48, 11, D.COL.sub);
    UI.bar(ctx, 36, y + 58, half - 60, 7, used / Math.max(1, quota), D.COL.blue);
    // 金額選擇
    UI.text(ctx, '借款金額：' + D.fmt(st.loanAmt), 36, y + 90, 12, D.COL.text);
    var amts = [5000, 10000, 20000, 50000];
    for (var i = 0; i < amts.length; i++) {
      (function (a, x) {
        btn(x, y + 100, 62, 20, (a / 1000) + 'k', function () { st.loanAmt = a; L.draw(); },
          { size: 11, gold: st.loanAmt === a });
      })(amts[i], 36 + i * 68);
    }
    // 分期
    for (var p = 0; p < D.BANK.plans.length; p++) {
      (function (pl, idx, yy) {
        var per = Math.ceil(st.loanAmt * (1 + pl.rate) / pl.terms);
        btn(36, yy, half - 70, 26, pl.terms + ' 期 · 利率 ' + Math.round(pl.rate * 100) + '% · 每天還 ' + D.fmt(per) + '（' + pl.tag + '）',
          function () { st.loanPlan = idx; L.draw(); }, { size: 11, gold: st.loanPlan === idx });
      })(D.BANK.plans[p], p, y + 130 + p * 32);
    }
    btn(36, y + 232, 110, 26, '申請貸款', function () { act(doLoan); }, { gold: true, disabled: st.loanAmt > quota - used });
    btn(156, y + 232, 110, 26, '提前還款', function () { act(prepay); }, { disabled: !s.loans.length });

    var rx = 30 + half;
    UI.card(ctx, rx, y, half, 280);
    UI.text(ctx, '我的負債', rx + 16, y + 24, 13, D.COL.text, 'left', true);
    var ly = y + 48;
    if (!s.loans.length) UI.text(ctx, '無貸款', rx + 16, ly, 11, D.COL.sub);
    for (var j = 0; j < Math.min(5, s.loans.length); j++) {
      var Ln = s.loans[j];
      UI.text(ctx, '貸款 ' + D.fmt(Ln.principal) + ' · 剩 ' + D.fmt(Ln.remaining) + ' · 每天 ' + D.fmt(Ln.perDay), rx + 16, ly, 11, D.COL.text);
      ly += 20;
    }
    ly += 8;
    UI.text(ctx, '維修賒帳（無息 · 鎖升級與大型賽）', rx + 16, ly, 11, D.COL.sub); ly += 18;
    UI.text(ctx, D.fmt(s.debtRepair) + ' / 上限 ' + D.fmt(C.debtCap(s)), rx + 16, ly, 13, s.debtRepair > 0 ? D.COL.red : D.COL.green, 'left', true);
    btn(rx + 16, ly + 12, 110, 24, '清償賒帳', function () { act(payDebt); }, { disabled: s.debtRepair <= 0 || s.money <= 0 });
    UI.text(ctx, '扣款連續失敗 ' + s.missStreak + '/' + D.BANK.missLimit + ' 次 → 法拍', rx + 16, ly + 56, 10, D.COL.sub);
    UI.text(ctx, '每場賽事獎金自動扣 10% 還賒帳', rx + 16, ly + 72, 10, D.COL.sub);
  }

  function drawEstate(ctx, W, y, s) {
    var h = D.HOUSES[s.house];
    UI.card(ctx, 20, y, W - 40, 70);
    UI.text(ctx, '目前：' + h.name, 36, y + 26, 13, D.COL.text, 'left', true);
    UI.text(ctx, '在家恢復 ' + (h.rest === 'full' ? '全滿' : '+' + h.rest) + '/天 · 車庫上限 Lv.' + h.garageCap + ' · 估值 ' + D.fmt(h.price), 36, y + 48, 11, D.COL.sub);
    if (s.house < D.HOUSES.length - 1) {
      var nx = D.HOUSES[s.house + 1];
      var cost = nx.price - Math.round(h.price * D.HOUSE_SELLBACK);
      UI.card(ctx, 20, y + 80, W - 40, 80, '#9e6a03');
      UI.text(ctx, '升級：' + nx.name + '（舊屋 7 折折抵後實付 ' + D.fmt(cost) + '）', 36, y + 106, 12, D.COL.gold, 'left', true);
      UI.text(ctx, '在家恢復 ' + (nx.rest === 'full' ? '全滿' : '+' + nx.rest) + '/天 · 車庫上限 Lv.' + nx.garageCap, 36, y + 126, 11, D.COL.sub);
      btn(36, y + 134, 90, 20, '買房', function () { act(buyHouse); }, { gold: true, disabled: s.money < cost, size: 11 });
    } else {
      UI.text(ctx, '已是莊園，人生勝利組', 20, y + 100, 12, D.COL.green);
    }
    // 車庫
    var g = D.GARAGES[s.garageLv - 1];
    UI.card(ctx, 20, y + 172, W - 40, 70);
    UI.text(ctx, '車庫 Lv.' + s.garageLv + ' · 車位 ' + s.cars.length + '/' + g.slots + ' · 可購 ' + D.CAR_TIERS[g.tierCap].name + ' 以下', 36, y + 198, 12, D.COL.text, 'left', true);
    if (s.garageLv < D.GARAGES.length) {
      var ng = D.GARAGES[s.garageLv];
      var needHouse = D.HOUSES[s.house].garageCap < ng.lv;
      UI.text(ctx, '升級 Lv.' + ng.lv + '：' + D.fmt(ng.price) + ' · 車位 ' + ng.slots + ' · 可購 ' + D.CAR_TIERS[ng.tierCap].name + (needHouse ? ' · 需先換房！' : ''), 36, y + 220, 11, needHouse ? D.COL.red : D.COL.sub);
      btn(W - 150, y + 192, 100, 24, '升級車庫', function () { act(upGarage); }, { disabled: needHouse || s.money < ng.price });
    }
  }

  function drawGarage(ctx, W, y, s) {
    UI.text(ctx, '我的車（點選設定出賽 · 升級請到「修配廠」）', 20, y, 11, D.COL.sub);
    var ry = y + 12;
    for (var i = 0; i < s.cars.length && i < 6; i++) {
      (function (car, yy) {
        var active = car.id === s.activeCar;
        UI.card(ctx, 20, yy, W - 40, 44, active ? '#9e6a03' : null);
        var t = D.CAR_TIERS[car.tier], tp = D.CAR_TYPES[car.type];
        UI.text(ctx, car.name + ' · ' + t.name + tp.name, 36, yy + 19, 12, active ? D.COL.gold : D.COL.text, 'left', true);
        UI.text(ctx, '加速 ' + car.accel + ' · 抓地 ' + car.grip + ' · 爬坡 ' + car.climb + ' · 胎 ' + Math.round(car.tirePct * 100) + '% · 保養 ' + car.milesSinceService + '/' + D.SERVICE_EVERY, 36, yy + 36, 10, D.COL.sub);
        if (active) UI.text(ctx, '出賽中', W - 36, yy + 20, 11, D.COL.green, 'right');
        else {
          btn(W - 180, yy + 10, 70, 24, '出賽', function () { act(function () { s.activeCar = car.id; st.selCar = car.id; }); }, { size: 11 });
          btn(W - 104, yy + 10, 64, 24, '賣 7 折', function () { act(function () { sellCar(car); }); }, { size: 11 });
        }
      })(s.cars[i], ry);
      ry += 50;
    }
    // 購車
    ry += 6;
    UI.text(ctx, '購車（受車庫等級限制）', 20, ry + 4, 11, D.COL.sub); ry += 12;
    var g = D.GARAGES[s.garageLv - 1];
    var types = ['std', 'sprint', 'hill', 'endu'];
    st._buyType = st._buyType || 'std';
    for (var ti = 0; ti < types.length; ti++) {
      (function (tp, x) {
        btn(x, ry, 70, 20, D.CAR_TYPES[tp].name, function () { st._buyType = tp; L.draw(); }, { size: 11, gold: st._buyType === tp });
      })(types[ti], 20 + ti * 76);
    }
    var tiers = ['B', 'A', 'S', 'X'];
    for (var bi = 0; bi < tiers.length; bi++) {
      (function (tr, x) {
        var ok = D.TIER_ORDER.indexOf(tr) <= D.TIER_ORDER.indexOf(g.tierCap);
        btn(x, ry + 26, 130, 24, D.CAR_TIERS[tr].name + ' ' + D.fmt(D.CAR_TIERS[tr].price), function () { act(function () { buyCar(tr, st._buyType); }); },
          { size: 11, disabled: !ok || s.money < D.CAR_TIERS[tr].price || s.cars.length >= g.slots });
      })(tiers[bi], 20 + bi * 138);
    }
  }

  function _curveFrame(ctx, x, y, w, h, title) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    UI.rr(ctx, x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = '#2c333d'; UI.rr(ctx, x, y, w, h, 6); ctx.stroke();
    UI.text(ctx, title, x + 8, y + 12, 9, D.COL.sub);
  }

  function drawCurves(ctx, x, y, w, h, car, s) {
    st.curveTab = st.curveTab || 'power';
    st.curveKey = st.curveKey || 'accel';
    // mini tabs
    var tabs = [['power', '動力'], ['grow', '成長'], ['tire', '胎耗']];
    for (var ti = 0; ti < 3; ti++) {
      (function (id, name, tx) {
        var on = st.curveTab === id;
        if (on) { ctx.fillStyle = D.COL.goldBg; UI.rr(ctx, tx, y, 42, 16, 5); ctx.fill(); }
        UI.text(ctx, name, tx + 21, y + 12, 9, on ? D.COL.gold : D.COL.dim, 'center', on);
        st.btns.push({ x: tx, y: y, w: 42, h: 16, fn: function () { st.curveTab = id; L.draw(); } });
      })(tabs[ti][0], tabs[ti][1], x + ti * 46);
    }
    var gy = y + 20, gh = h - 20;
    if (st.curveTab === 'power') {
      _curveFrame(ctx, x, gy, w, gh, '坡度→車速');
      var P = D.PHYS;
      var eng = C.rndVal('eng', (s.rnd || {}).eng);
      var ea = C.matEff(car, 'accel'), ec = C.matEff(car, 'climb');
      var spd = function (sl, ac, cl) {
        return D.clamp(D.BASE_SPEED + eng + ac * P.accelGain - sl * P.upK * Math.max(0.2, 1 - cl * P.climbCut), D.SPEED_MIN, D.SPEED_MAX);
      };
      var px = function (sl) { return x + 8 + (w - 16) * sl / 10; };
      var pyv = function (v) { return gy + gh - 8 - (gh - 24) * D.clamp((v - 10) / 130, 0, 1); };
      var lines = [
        { ac: ea, cl: ec, col: '#f0a527', dash: [] },
        { ac: ea + 1, cl: ec, col: '#58a6ff', dash: [3, 3] },
        { ac: ea, cl: ec + 1, col: '#2fbfae', dash: [3, 3] }
      ];
      for (var li = 0; li < 3; li++) {
        var L2 = lines[li];
        ctx.strokeStyle = L2.col; ctx.lineWidth = li === 0 ? 1.8 : 1;
        ctx.setLineDash(L2.dash);
        ctx.beginPath();
        for (var sl = 0; sl <= 10; sl++) {
          var vx = px(sl), vy = pyv(spd(sl, L2.ac, L2.cl));
          if (sl === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0a527';
      ctx.beginPath(); ctx.arc(px(3), pyv(spd(3, ea, ec)), 3, 0, Math.PI * 2); ctx.fill();
    } else if (st.curveTab === 'grow') {
      var mk = st.curveKey;
      _curveFrame(ctx, x, gy, w, gh, D.MATS[mk].name + '：Lv→有效值');
      var maxLv = Math.max(16, (car[mk] || 0) + 4);
      var cols = { lin: '#8b949e', pow: '#58a6ff', log: '#2fbfae' };
      var maxEff = 0;
      var effOf = function (route, lv) {
        if (route === 'pow') return 0.6 * Math.pow(lv, 1.28);
        if (route === 'log') return 3.0 * Math.log(lv + 1);
        return lv;
      };
      for (var rr = 0; rr < 3; rr++) maxEff = Math.max(maxEff, effOf(D.MATS[mk].routes[rr].id, maxLv));
      var gx = function (lv) { return x + 8 + (w - 16) * lv / maxLv; };
      var gyv = function (v) { return gy + gh - 8 - (gh - 24) * v / maxEff; };
      var curRoute = (car.mats || {})[mk] || 'lin';
      for (var ri = 0; ri < 3; ri++) {
        var route = D.MATS[mk].routes[ri].id;
        ctx.strokeStyle = cols[route];
        ctx.lineWidth = route === curRoute ? 2 : 1;
        ctx.setLineDash(route === curRoute ? [] : [3, 3]);
        ctx.beginPath();
        for (var lv = 0; lv <= maxLv; lv++) {
          var vx2 = gx(lv), vy2 = gyv(effOf(route, lv));
          if (lv === 0) ctx.moveTo(vx2, vy2); else ctx.lineTo(vx2, vy2);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = cols[curRoute];
      ctx.beginPath(); ctx.arc(gx(car[mk] || 0), gyv(effOf(curRoute, car[mk] || 0)), 3, 0, Math.PI * 2); ctx.fill();
    } else {
      _curveFrame(ctx, x, gy, w, gh, '里程→胎況（各胎種）');
      var tids = ['normal', 'soft', 'hard', 'race', 'nano'];
      var tcols = { normal: '#8b949e', soft: '#d4537e', hard: '#58a6ff', race: '#f0a527', nano: '#2fbfae' };
      var maxBars = 320;
      var tx2 = function (b) { return x + 8 + (w - 16) * b / maxBars; };
      var ty2 = function (p) { return gy + gh - 8 - (gh - 24) * p; };
      var tech = Math.max(D.TIRE_TECH.wearFloor, 1 - (car.tireTech || 0) * D.TIRE_TECH.wearCut);
      for (var ki = 0; ki < tids.length; ki++) {
        var tt2 = D.TIRES[tids[ki]];
        var wearPerBar = 0.005 * (200 / tt2.life) * tech; // 均值近似
        ctx.strokeStyle = tcols[tids[ki]];
        ctx.lineWidth = tids[ki] === car.tireType ? 2 : 1;
        ctx.setLineDash(tids[ki] === car.tireType ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(tx2(0), ty2(1));
        ctx.lineTo(tx2(Math.min(maxBars, 1 / wearPerBar)), ty2(Math.max(0, 1 - wearPerBar * Math.min(maxBars, 1 / wearPerBar))));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  function drawTune(ctx, W, y, s) {
    var car = C.activeCar(s);
    var t = D.CAR_TIERS[car.tier];
    var tier = C.shopTier(s);
    var nextT = D.SHOP.tiers[tier.lv] || null;
    var BADGE = ['#cd8a4d', '#c3cad6', '#f5c542', '#9fd3e8', '#7ee0d0'];
    // 忠誠等級列
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    UI.rr(ctx, 20, y - 12, W - 40, 30, 8); ctx.fill();
    ctx.fillStyle = BADGE[tier.lv - 1];
    ctx.beginPath(); ctx.arc(36, y + 3, 7, 0, Math.PI * 2); ctx.fill();
    UI.text(ctx, '修配廠 ' + tier.name + ' · 累計消費 ' + D.fmt(s.shopSpent || 0) + (tier.lv >= 5 ? ' · 保養 8 折' : ''), 50, y + 7, 11, D.COL.text, 'left', true);
    if (nextT) {
      UI.bar(ctx, W - 256, y - 2, 150, 8, D.clamp((s.shopSpent || 0) / nextT.need, 0, 1), '#f0a527');
      UI.text(ctx, nextT.name + ' ' + D.fmt(nextT.need), W - 36, y + 7, 10, D.COL.sub, 'right');
    } else UI.text(ctx, '鑽石最高級', W - 36, y + 7, 10, D.COL.green, 'right');

    // 子頁切換
    st.tuneSub = st.tuneSub || 'mod';
    btn(20, y + 26, 74, 22, '🔧 改裝', function () { st.tuneSub = 'mod'; L.draw(); }, { size: 11, gold: st.tuneSub === 'mod' });
    btn(100, y + 26, 74, 22, '🧪 研發', function () { st.tuneSub = 'rnd'; L.draw(); }, { size: 11, gold: st.tuneSub === 'rnd' });
    btn(180, y + 26, 74, 22, '🗡 武裝', function () { st.tuneSub = 'arm'; L.draw(); }, { size: 11, gold: st.tuneSub === 'arm' });
    if (st.tuneSub === 'rnd') { drawRnd(ctx, W, y + 62, s, tier); return; }
    if (st.tuneSub === 'arm') { drawArmory(ctx, W, y + 62, s); return; }

    var cy = y + 58;
    UI.text(ctx, '出賽車：' + car.name + ' · ' + t.name + ' · 上限 Lv.' + t.statCap + (tier.lv >= 3 ? ' · 料件 9 折' : '') + (s.debtRepair > 0 ? ' · 賒帳鎖升級！' : ''), 20, cy, 11, s.debtRepair > 0 ? D.COL.red : D.COL.sub);
    var keys = [['accel', '加速'], ['grip', '抓地'], ['climb', '爬坡'], ['tireTech', '輪胎科技']];
    for (var i = 0; i < keys.length; i++) {
      (function (k, name, ry) {
        var isTire = k === 'tireTech';
        var over = car[k] - t.statCap;
        var eff = isTire ? null : C.matEff(car, k);
        var lbl = name + ' ' + car[k]
          + (eff !== null && eff !== car[k] ? '→' + eff : '')
          + (isTire && car[k] > 0 ? '（-' + Math.round(Math.min(60, car[k] * 6)) + '%耗）' : '')
          + (over > 0 ? '（超規+' + over + '）' : '');
        UI.text(ctx, lbl, 20, ry + 12, 11, over > 0 ? D.COL.gold : D.COL.text);
        if (!isTire) st.btns.push({ x: 20, y: ry, w: 100, h: 18, fn: function () { st.curveKey = k; st.curveTab = 'grow'; L.draw(); } });
        UI.bar(ctx, 124, ry + 4, 188, 8, Math.min(1, car[k] / t.statCap), over > 0 ? D.COL.gold : (isTire ? D.COL.gold : D.COL.blue));
        var cost = tuneCost(car, k);
        btn(322, ry, 138, 20, '升級 ' + D.fmt(cost),
          function () { act(function () { upStat(car, k); }); },
          { size: 11, disabled: s.money < cost || s.debtRepair > 0, gold: over >= 0 });
      })(keys[i][0], keys[i][1], cy + 8 + i * 27);
    }
    // 右欄：曲線三 tab + 材料路線
    drawCurves(ctx, 472, cy - 2, 188, 92, car, s);
    var mk2 = st.curveKey || 'accel';
    var curR = null;
    var rs = D.MATS[mk2].routes;
    for (var z2 = 0; z2 < rs.length; z2++) if (rs[z2].id === ((car.mats || {})[mk2] || 'lin')) curR = rs[z2];
    var swCost = (car[mk2] || 0) * D.MAT_SWITCH_COST;
    btn(472, cy + 96, 188, 20, D.MATS[mk2].name + '：' + (curR ? curR.name : '') + ' ⇆ ' + D.fmt(swCost),
      function () { act(function () { switchMat(car, mk2); }); }, { size: 10, disabled: s.money < swCost });
    UI.text(ctx, curR ? curR.desc : '', 472, cy + 128, 9, D.COL.dim);

    // 調校模式
    var tt = cy + 126;
    UI.text(ctx, '調校：' + (D.TUNE_MODES[car.tuneMode] || D.TUNE_MODES.std).desc, 20, tt, 10, D.COL.sub);
    var tmIds = ['eco', 'std', 'rage'];
    for (var tmi = 0; tmi < 3; tmi++) {
      (function (id, x) {
        btn(x, tt + 6, 120, 24, D.TUNE_MODES[id].name, function () { act(function () { setTuneMode(car, id); }); },
          { size: 11, gold: (car.tuneMode || 'std') === id });
      })(tmIds[tmi], 20 + tmi * 126);
    }

    // 輪胎
    var ty = tt + 40;
    var tire = D.TIRES[car.tireType];
    UI.text(ctx, '輪胎：' + tire.name + ' · 胎況 ' + Math.round(car.tirePct * 100) + '%', 20, ty, 11, car.tirePct < 0.3 ? D.COL.red : D.COL.sub);
    var tids = ['normal', 'soft', 'hard', 'race', 'nano'];
    for (var j2 = 0; j2 < tids.length; j2++) {
      (function (tid, x) {
        var tt2 = D.TIRES[tid];
        var lock = tier.lv < (tt2.tier || 1);
        btn(x, ty + 6, 122, 28,
          lock ? tt2.name + ' 🔒' + D.SHOP.tiers[(tt2.tier || 1) - 1].name : tt2.name + ' ' + D.fmt(tt2.price),
          function () { act(function () { buyTire(car, tid); }); },
          { size: 10, disabled: lock || s.money < tt2.price, gold: tid === 'race' || tid === 'nano' });
      })(tids[j2], 20 + j2 * 128);
    }

    // 保養
    var sy = ty + 44;
    var due = C.serviceDue(car);
    UI.text(ctx, '保養：' + car.milesSinceService + '/' + D.SERVICE_EVERY + (due ? ' · 逾期鎖出賽！' : '') + (car.svcBuff > 0 ? ' · buff：故障 -' + Math.round(car.svcBuff * 100) + '%' : ''), 20, sy, 11, due ? D.COL.red : D.COL.sub);
    for (var sv = 0; sv < D.SHOP.svc.length; sv++) {
      (function (svc, x) {
        var lock = tier.lv < svc.tier;
        var cost = Math.round(C.serviceCost(car, s) * svc.mul * (tier.lv >= 5 ? 0.8 : 1));
        btn(x, sy + 6, 202, 28,
          lock ? svc.name + ' 🔒' + D.SHOP.tiers[svc.tier - 1].name : svc.name + ' ' + D.fmt(cost) + (svc.desc ? '｜' + svc.desc : ''),
          function () { act(function () { doService(car, svc); }); },
          { size: 10, gold: due && !lock, disabled: lock || s.money < cost });
      })(D.SHOP.svc[sv], 20 + sv * 210);
    }

    // 外掛商店
    var my = sy + 44;
    var modNames = [];
    for (var mi3 = 0; mi3 < car.mods.length; mi3++) {
      for (var z3 = 0; z3 < D.SHOP.mods.length; z3++) if (D.SHOP.mods[z3].id === car.mods[mi3]) modNames.push(D.SHOP.mods[z3].name);
    }
    UI.text(ctx, '外掛商店（' + car.mods.length + '/' + (tier.slots || 0) + (modNames.length ? '：' + modNames.join('·') : '') + '）', 20, my, 11, D.COL.sub);
    for (var mi = 0; mi < D.SHOP.mods.length; mi++) {
      (function (mod, x, ry2) {
        var lock = tier.lv < mod.tier;
        var owned = car.mods.indexOf(mod.id) >= 0;
        var full = !owned && car.mods.length >= (tier.slots || 0);
        btn(x, ry2, 206, 28,
          owned ? mod.name + ' ✓' : lock ? mod.name + ' 🔒' + D.SHOP.tiers[mod.tier - 1].name : mod.name + ' ' + D.fmt(mod.price) + '｜' + mod.desc,
          function () { act(function () { buyMod(car, mod); }); },
          { size: 10, disabled: lock || owned || full || s.money < mod.price });
      })(D.SHOP.mods[mi], 20 + (mi % 3) * 214, my + 8 + Math.floor(mi / 3) * 32);
    }
  }

  function drawArmory(ctx, W, y, s) {
    var cap = 1 + C.armVal('carry', s.armory.carry);
    UI.text(ctx, '征途暗器補給（賽中按 1/2/3 發射，鎖定前車）· 每種攜帶上限 ' + cap, 20, y + 4, 11, D.COL.sub);
    var ks = D.ITEM_KEYS;
    var cw = Math.min(208, (W - 60) / 3);
    for (var i = 0; i < ks.length; i++) {
      (function (t, x) {
        var it = D.ITEMS[t];
        UI.card(ctx, x, y + 14, cw, 100);
        UI.text(ctx, it.icon + ' ' + it.name + ' ×' + (s.items[t] || 0), x + 14, y + 38, 13, D.COL.text, 'left', true);
        UI.text(ctx, it.desc, x + 14, y + 58, 10, D.COL.sub);
        btn(x + 14, y + 70, 110, 26, '購買 ' + D.fmt(it.price), function () { act(function () { buyItem(t); }); },
          { size: 11, disabled: s.money < it.price || (s.items[t] || 0) >= cap });
      })(ks[i], 20 + i * (cw + 10));
    }
    UI.text(ctx, '⚒ 武裝研發（無限 · 費用 ×1.5^Lv · 計入忠誠消費）', 20, y + 136, 11, D.COL.sub);
    var dodgeBase = Math.round(D.CAMPAIGN.itemWarnTicks * 0.42);
    for (var j = 0; j < D.ARMORY.lines.length; j++) {
      (function (ln, ry) {
        var lv = s.armory[ln.id] || 0;
        var now = C.armVal(ln.id, lv);
        var nxt = C.armVal(ln.id, lv + 1);
        var cost = C.armCost(lv);
        UI.card(ctx, 20, ry, W - 40, 52);
        UI.text(ctx, ln.name + ' Lv.' + lv, 36, ry + 21, 12, D.COL.text, 'left', true);
        var unit = function (v) { return ln.unit + v + (ln.pct ? '%' : ln.tick ? ' tick（基礎 ' + dodgeBase + '）' : ''); };
        UI.text(ctx, unit(now) + '  →  ' + unit(nxt), 36, ry + 40, 11, D.COL.blue);
        btn(W - 180, ry + 12, 140, 28, '研發 ' + D.fmt(cost),
          function () { act(function () { armUp(ln.id); }); },
          { size: 11, gold: true, disabled: s.money < cost });
      })(D.ARMORY.lines[j], y + 146 + j * 58);
    }
  }

  function drawRnd(ctx, W, y, s, tier) {
    if (tier.lv < D.RND.unlockTier) {
      UI.card(ctx, 20, y + 10, W - 40, 90);
      UI.text(ctx, '🔒 研發中心', 40, y + 44, 14, D.COL.sub, 'left', true);
      UI.text(ctx, '修配廠達「金牌」（累計消費 ' + D.fmt(D.SHOP.tiers[2].need) + '）解鎖無限研發', 40, y + 68, 11, D.COL.dim);
      return;
    }
    if (!s.rnd) s.rnd = { eng: 0, mat: 0, nos: 0, rel: 0, craft: 0 };
    UI.text(ctx, '無限研發：費用 ×1.6^Lv 無上限，效果曲面成長（漸近極限不破平衡）· 計入忠誠消費', 20, y + 4, 10, D.COL.sub);
    for (var i = 0; i < D.RND.lines.length; i++) {
      (function (ln, ry) {
        var lv = s.rnd[ln.id] || 0;
        var now = C.rndVal(ln.id, lv);
        var nxt = C.rndVal(ln.id, lv + 1);
        var cost = C.rndCost(lv);
        UI.card(ctx, 20, ry, W - 40, 56);
        UI.text(ctx, ln.name + ' Lv.' + lv, 36, ry + 22, 12, D.COL.text, 'left', true);
        UI.text(ctx, ln.unit + now + (ln.pct ? '%' : '') + '  →  ' + ln.unit + nxt + (ln.pct ? '%' : ''), 36, ry + 42, 11, D.COL.blue);
        UI.bar(ctx, 300, ry + 16, 160, 7, ln.pct ? now / 50 : D.clamp(lv / 30, 0, 1), D.COL.gold);
        btn(W - 180, ry + 14, 140, 28, '研發 ' + D.fmt(cost),
          function () { act(function () { rndUp(ln.id); }); },
          { size: 11, gold: true, disabled: s.money < cost });
      })(D.RND.lines[i], y + 14 + i * 62);
    }
  }

  KR.L = L;
})();
