/* ============================================================
 * game-klineRacer-core.js — K線抓取 + 賽道轉換 + 物理引擎 + AI + 存檔
 * 依賴：game-klineRacer-data.js（window.__KR.D）
 * ============================================================ */
(function () {
  'use strict';
  var KR = window.__KR;
  var D = KR.D;
  var C = {};

  /* ============ 一、K線取得（三層降級鏈） ============ */
  var _codes = null; // session 快取

  // /histcodes 掛掉時的內建熱門股清單（保證真賽道）
  var FALLBACK_CODES = ['2330','2317','2454','2308','2303','2412','2382','3711','2881','2882',
    '2886','2891','2603','2609','2615','3008','1301','1303','2002','2207',
    '5871','3034','3231','2357','2356','4938','6505','9910','1216','2912'];

  function _timeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }

  function _fetchJson(url, headers) {
    return _timeout(fetch(url, headers ? { headers: headers } : undefined).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }), 9000);
  }
  function _wkFetch(path) {
    // worker 驗證走 X-Proxy-Token header（query 參數無效 → 403）
    return _fetchJson(D.WORKER + path, { 'X-Proxy-Token': D.TOKEN });
  }

  function _normCandles(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return null; } }
    var arr = Array.isArray(raw) ? raw : (raw.candles || raw.data || raw.list || raw.k || null);
    if (arr && !Array.isArray(arr) && arr.candles) arr = arr.candles; // 再剝一層
    if (!arr || !Array.isArray(arr) || !arr.length) return null;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = arr[i];
      var o = +(k.o !== undefined ? k.o : k.open);
      var h = +(k.h !== undefined ? k.h : k.high);
      var l = +(k.l !== undefined ? k.l : k.low);
      var c = +(k.c !== undefined ? k.c : k.close);
      var v = +(k.v !== undefined ? k.v : k.volume);
      if (!isFinite(o) || !isFinite(c) || c <= 0) continue;
      if (!isFinite(h)) h = Math.max(o, c);
      if (!isFinite(l)) l = Math.min(o, c);
      if (!isFinite(v) || v < 0) v = 0;
      out.push({ o: o, h: h, l: l, c: c, v: v });
    }
    return out.length >= 25 ? out : null;
  }

  // 內建隨機漫步假K線（最終 fallback）
  function _synthCandles(n) {
    var out = [], price = 100, baseV = 5000;
    for (var i = 0; i < n; i++) {
      var slope = (Math.random() - 0.48) * 0.05;
      if (Math.random() < 0.04) slope = (Math.random() < 0.5 ? 1 : -1) * D.rnd(0.06, 0.099);
      var o = price * (Math.random() < 0.06 ? 1 + (Math.random() - 0.5) * 0.07 : 1 + (Math.random() - 0.5) * 0.01);
      var c = D.clamp(price * (1 + slope), price * 0.9, price * 1.1);
      var h = Math.max(o, c) * (1 + Math.random() * 0.015);
      var l = Math.min(o, c) * (1 - Math.random() * 0.015);
      var v = baseV * (0.5 + Math.random()) * (Math.random() < 0.08 ? D.rnd(2.5, 4) : 1);
      out.push({ o: o, h: h, l: l, c: c, v: Math.round(v) });
      price = c;
    }
    return out;
  }

  // 第一優先：主站本地 IDB stockdash/kline_cache（零網路、全市場 1y）
  function _tryLocal(ok, fail) {
    if (typeof indexedDB === 'undefined' || !indexedDB) { fail(); return; }
    var req;
    try { req = indexedDB.open('stockdash'); } catch (e) { fail(); return; }
    req.onerror = function () { fail(); };
    req.onsuccess = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('kline_cache')) {
        console.warn('[KR] stockdash 無 kline_cache store');
        db.close(); fail(); return;
      }
      try {
        var st = db.transaction('kline_cache', 'readonly').objectStore('kline_cache');
        var kq = st.getAllKeys();
        kq.onsuccess = function () {
          var keys = kq.result || [];
          if (!keys.length) { db.close(); fail(); return; }
          var key = keys[Math.floor(Math.random() * keys.length)];
          var gq = st.get(key); // 同一 tx 內同步發出，tx 仍存活
          gq.onsuccess = function () {
            var rec = gq.result;
            var cs = _normCandles(rec && (rec.candles || rec.data || rec.k || rec));
            db.close();
            if (cs) {
              var code = String((rec && (rec.code || rec.symbol)) || key).replace(/\.TWO?$/i, '');
              ok(cs, code, (rec && rec.name) || null);
            } else { console.warn('[KR] kline_cache 紀錄格式無法解析', key, rec); fail(); }
          };
          gq.onerror = function () { db.close(); fail(); };
        };
        kq.onerror = function () { db.close(); fail(); };
      } catch (e2) { console.warn('[KR] kline_cache 讀取例外', e2); try { db.close(); } catch (e3) {} fail(); }
    };
  }

  function _tryHist(code, ok, fail) {
    _wkFetch('/hist?code=' + encodeURIComponent(code)).then(function (j) {
      var cs = _normCandles(j);
      if (cs) ok(cs);
      else { console.warn('[KR] /hist 回應格式無法解析', code, j); fail(); }
    }).catch(function (e) { console.warn('[KR] /hist 失敗', code, e && e.message); fail(); });
  }

  function _tryKlineTest(code, period, ok, fail) {
    _wkFetch('/kline-test?symbol=' + encodeURIComponent(code) + '.TW&period=' + period).then(function (j) {
      var cs = _normCandles(j);
      if (cs) ok(cs);
      else { console.warn('[KR] /kline-test 回應格式無法解析', code, j); fail(); }
    }).catch(function (e) { console.warn('[KR] /kline-test 失敗', code, e && e.message); fail(); });
  }

  // 取賽道K線：cb(candles, codeLabel, isSynth, name)
  C.fetchTrack = function (bars, cb) {
    var need = bars + D.TERRAIN.volSma + 2;
    var period = bars > 260 ? '2y' : '1y';
    var slim = function (cs) { return cs.length >= need ? cs.slice(-need) : cs; };
    var synthGo = function () { cb(_synthCandles(need), '模擬賽道', true, null); };
    var workerChain = function () {
      var tryCode = function (rawCode) {
        var code = (rawCode && (rawCode.code || rawCode.symbol)) || rawCode;
        code = String(code).replace(/\.TWO?$/i, '');
        var done = function (cs) { cb(slim(cs), code, false, (rawCode && rawCode.name) || null); };
        _tryHist(code, done, function () {
          _tryKlineTest(code, period, done, synthGo);
        });
      };
      if (_codes && _codes.length) { tryCode(D.pick(_codes)); return; }
      _wkFetch('/histcodes').then(function (j) {
        var list = Array.isArray(j) ? j : (j && (j.codes || j.list)) || null;
        if (list && list.length > 50) _codes = list;
        else { console.warn('[KR] /histcodes 回應異常，改用內建熱門股清單', j); _codes = FALLBACK_CODES; }
        tryCode(D.pick(_codes));
      }).catch(function (e) {
        console.warn('[KR] /histcodes 失敗，改用內建熱門股清單', e && e.message);
        _codes = FALLBACK_CODES;
        tryCode(D.pick(_codes));
      });
    };
    // 超大型/國際賽（>260 根）本地 1y 不夠長，直接走 worker
    if (need > 260) { workerChain(); return; }
    _tryLocal(function (cs, code, name) {
      if (cs.length >= need) cb(cs.slice(-need), code, false, name);
      else workerChain(); // 本地根數不足換 worker
    }, workerChain);
  };

  /* ============ 二、賽道轉換 ============ */
  // candles → segs[{slope,rough,gap,limit,zone,pit}]，bars 段
  C.buildTrack = function (candles, raceDef, rules) {
    var T = D.TERRAIN;
    var n = Math.min(raceDef.bars, candles.length - 1);
    var start = candles.length - n; // segs 用 candles[start..end] 對前一根
    var segs = [];
    for (var i = start; i < candles.length; i++) {
      var prev = candles[i - 1], k = candles[i];
      var slope = D.clamp((k.c - prev.c) / prev.c, -T.slopeClamp, T.slopeClamp);
      if (rules && rules.invert) slope = -slope; // 空頭賽道
      var rough = D.clamp((k.h - k.l) / k.c, 0, 0.15);
      var gap = Math.abs(k.o - prev.c) / prev.c > T.gapPct;
      var limit = Math.abs(slope) >= T.limitPct;
      // 量 SMA20（往前取，不足就有多少算多少）
      var s = 0, cnt = 0;
      for (var j = Math.max(0, i - T.volSma); j < i; j++) { s += candles[j].v; cnt++; }
      var zone = cnt > 0 && k.v > (s / cnt) * T.volMul;
      segs.push({ slope: slope, rough: rough, gap: gap, limit: limit, zone: zone, pit: false, sharp: rough >= D.PLAY.qteSharp });
    }
    for (var qa = 0; qa + 1 < segs.length; qa++) {
      if (!segs[qa].sharp && segs[qa + 1].sharp) segs[qa].qteAhead = true;
    }
    if (raceDef.pit > 0) {
      for (var p = D.PHYS.pitEvery; p < segs.length - 10; p += D.PHYS.pitEvery) segs[p].pit = true;
    }
    return segs;
  };

  /* ============ 三、賽車物理引擎 ============ */
  function _carPower(car) { return car.accel + car.grip + car.climb; }
  C.carPower = _carPower;

  // 建立比賽：opts = { raceDef, segs, player:{car,stats,tired,pitAuto}, codeLabel }
  C.createRace = function (opts) {
    var P = D.PHYS, raceDef = opts.raceDef, segs = opts.segs;
    var total = segs.length * D.SEG_LEN;
    var cars = [];
    var pc = opts.player.car;
    var ptype = D.CAR_TYPES[pc.type] || D.CAR_TYPES.std;
    var tire = D.TIRES[pc.tireType] || D.TIRES.normal;
    var mods = pc.mods || [];
    var hasMod = function (id) { return mods.indexOf(id) >= 0; };
    var tm = D.TUNE_MODES[pc.tuneMode] || D.TUNE_MODES.std;
    var rnd0 = opts.player.rnd || {};
    cars.push({
      name: '你', isPlayer: true,
      accel: C.matEff(pc, 'accel') + ptype.accel + (hasMod('turbo') ? 1 : 0),
      grip: C.matEff(pc, 'grip') + tire.grip,
      climb: C.matEff(pc, 'climb') + ptype.climb,
      wearMul: ptype.wearMul * (200 / tire.life) * Math.max(D.TIRE_TECH.wearFloor, 1 - (pc.tireTech || 0) * D.TIRE_TECH.wearCut)
        * tm.wear * (1 - C.rndVal('mat', rnd0.mat) / 100),
      failMul: ptype.failMul * tm.fail * (1 - C.rndVal('rel', rnd0.rel) / 100),
      spdMul: ptype.spdMul * tm.spd,
      style: D.AI_STYLE.steady,
      tirePct: D.clamp(pc.tirePct, 0, 1), prog: 0, segIdx: -1,
      stall: 0, finished: false, broken: false, pitPlan: false, limitDone: {},
      nitro: D.PLAY.nitroBase + Math.floor((opts.player.stats.end || 0) / 10) + (hasMod('nos') ? 2 : 0),
      boostTicks: 0, curveMod: 1, nextCurveMod: 1, qtePending: false, qteResolved: false,
      spdAdd: (hasMod('carbon') ? 6 : 0) + C.rndVal('eng', rnd0.eng),
      nitroPow: D.PLAY.nitroSpeed + C.rndVal('nos', rnd0.nos),
      stallMul: hasMod('cage') ? 0.7 : 1,
      curveBase: hasMod('susp') ? 0.88 : 1, svcBuff: pc.svcBuff || 0
    });
    var camp = opts.camp || null;
    if (camp && camp.rules.wear15) cars[0].wearMul *= 1.5;
    var eff = _carPower(cars[0]);
    var rivals = D.RIVALS.slice();
    var rp = opts.rivalPow || null;
    for (var i = 0; i < 9; i++) {
      var rv = rivals[i];
      var pw;
      if (rp && rp[rv.name] !== undefined) {
        pw = D.clamp(rp[rv.name], eff * D.RIVAL.clampLo, eff * D.RIVAL.clampHi) * D.rnd(0.96, 1.04);
      } else {
        pw = eff * D.rnd(D.AI_BAND[0], D.AI_BAND[1]);
      }
      pw = Math.max(3, pw);
      var a = pw / 3 + D.rnd(-0.8, 0.8), g = pw / 3 + D.rnd(-0.8, 0.8);
      var cl = Math.max(0.5, pw - a - g);
      cars.push({
        name: rv.name, isPlayer: false,
        accel: a, grip: g, climb: cl,
        wearMul: 1, failMul: 1, spdMul: 1,
        style: D.AI_STYLE[rv.style],
        dispLv: Math.max(1, Math.round(pw / 2)),
        tirePct: 1, prog: 0, segIdx: -1,
        stall: 0, finished: false, broken: false, pitPlan: false, limitDone: {}
      });
    }
    // 征途魔王：覆蓋第一位 AI
    if (camp) {
      var boss = cars[1];
      var bpw = Math.max(3, eff * camp.band);
      boss.name = '👑' + camp.name;
      boss.isBoss = true;
      boss.skills = camp.skills;
      boss.dispLv = camp.n;
      boss.style = D.AI_STYLE.aggressive;
      boss.accel = bpw * 0.5; boss.grip = bpw * 0.3; boss.climb = bpw * 0.2;
      if (camp.skills.wearHalf) boss.wearMul = (boss.wearMul || 1) * 0.5;
      if (camp.skills.failImmune) boss.failMul = 0;
    }
    return {
      raceDef: raceDef, segs: segs, total: total, cars: cars,
      camp: camp, rules: (camp && camp.rules) || {},
      itemsLeft: opts.items ? JSON.parse(JSON.stringify(opts.items)) : null,
      itemsUsed: { banana: 0, shell: 0, zap: 0 },
      incoming: null, throwTimer: camp ? D.CAMPAIGN.throwCD : 0, dodges: 0,
      tick: 0, finishOrder: [], done: false,
      events: [], bills: [], playerTired: !!opts.player.tired,
      playerStats: opts.player.stats, codeLabel: opts.codeLabel || '？？？',
      maxTick: segs.length * 60 // 保險絲
    };
  };

  function _stopTicks(base, str, car) {
    var t = (base - (str || 0) * D.PHYS.stopStrCut) * ((car && car.stallMul) || 1);
    return Math.max(D.PHYS.stopMin, Math.round(t));
  }

  function _enterSeg(race, car, idx) {
    var P = D.PHYS, seg = race.segs[idx];
    var str = car.isPlayer ? race.playerStats.str : 8;
    var endu = car.isPlayer ? race.playerStats.end : 8;
    if (car.isPlayer) {
      if (car.qtePending) {
        if (seg.sharp) {
          if (car.qteResolved) car.curveMod = car.nextCurveMod;
          else { car.curveMod = D.PLAY.qteMissMod; race.events.push({ tick: race.tick, msg: '過彎失誤！打滑減速', type: 'bad' }); }
        } else car.curveMod = 1;
        car.qtePending = false; car.qteResolved = false; car.nextCurveMod = 1;
      } else car.curveMod = 1;
      if (seg.qteAhead) { car.qtePending = true; car.qteResolved = false; }
    }
    // 胎耗
    car.tirePct = Math.max(0, car.tirePct - (P.wearBase + seg.rough * P.wearRough * 100) * car.wearMul);
    if (car.isPlayer) car.tireBarsUsed = (car.tireBarsUsed || 0) + 1;
    // 爆胎
    if (car.tirePct <= 0 && Math.random() < P.blowoutPct) {
      car.stall = _stopTicks(P.stopBase, str, car);
      car.stallTotal = car.stall; car.stallKind = 'tire';
      if (car.isPlayer) {
        var bill = Math.round(D.rnd(P.repairBillMin, P.repairBillMax));
        race.bills.push({ name: '爆胎救援', amt: bill });
        race.events.push({ tick: race.tick, msg: '爆胎！救援中（' + D.fmt(bill) + ' 記帳）', type: 'bad' });
        car.tirePct = 0.5; // 救援換備胎
      } else {
        car.tirePct = 0.5;
        race.events.push({ tick: race.tick, msg: car.name + ' 爆胎', type: 'info' });
      }
      return;
    }
    // 故障
    var late = idx / race.segs.length >= D.TERRAIN.lateStart;
    var zoneMul = seg.zone ? P.failZoneMul * (race.rules && race.rules.surge2 ? 2 : 1) : 1;
    var fail = P.failBase * (1 + (car.overdue || 0) / P.failOverdueDiv) * zoneMul * car.failMul;
    if (late) fail *= Math.max(0.2, 1 - endu * P.failEndCut);
    fail *= (1 - (car.svcBuff || 0));
    if (Math.random() < fail) {
      car.stall = _stopTicks(P.stopBase, str, car);
      car.stallTotal = car.stall; car.stallKind = 'repair';
      if (car.isPlayer) {
        var b2 = Math.round(D.rnd(P.repairBillMin, P.repairBillMax));
        race.bills.push({ name: '故障維修', amt: b2 });
        race.events.push({ tick: race.tick, msg: '故障！維修小組出動（' + D.fmt(b2) + ' 記帳）', type: 'bad' });
      } else {
        race.events.push({ tick: race.tick, msg: car.name + ' 故障', type: 'info' });
      }
      return;
    }
    // 極限坡熄火（爬坡 < 6 級，每段只罰一次）
    if (seg.limit && seg.slope > 0 && car.climb < 6 && !car.limitDone[idx]) {
      car.limitDone[idx] = 1;
      car.stall = _stopTicks(P.limitStallTick, str, car);
      car.stallTotal = car.stall; car.stallKind = 'limit';
      if (car.isPlayer) race.events.push({ tick: race.tick, msg: '極限陡坡熄火！等待救援', type: 'bad' });
    }
    // 進站
    if (seg.pit) {
      var wantPit = car.isPlayer ? car.pitPlan : car.tirePct < 0.25;
      if (wantPit) {
        car.stall = _stopTicks(P.stopBase, str, car);
        car.stallTotal = car.stall; car.stallKind = 'pit';
        car.tirePct = 1;
        if (car.isPlayer) {
          car.pitPlan = false;
          car.pitTireNew = true;
          var tp = D.TIRES.normal.price;
          race.bills.push({ name: '進站換胎', amt: tp });
          race.events.push({ tick: race.tick, msg: '進站換胎完成（' + D.fmt(tp) + ' 記帳）', type: 'good' });
        }
      }
    }
  }

  C.stepRace = function (race) {
    if (race.done) return;
    var P = D.PHYS;
    race.tick++;
    // ── 征途：魔王丟暗器（預警 → 命中/閃避） ──
    if (race.camp) {
      var player = race.cars[0], bossCar = null;
      for (var bi = 1; bi < race.cars.length; bi++) if (race.cars[bi].isBoss) { bossCar = race.cars[bi]; break; }
      if (bossCar && !bossCar.finished && !player.finished) {
        if (!race.incoming) {
          race.throwTimer--;
          if (race.throwTimer <= 0) {
            race.throwTimer = Math.round(D.CAMPAIGN.throwCD / (race.camp.skills.thrower ? 2 : 1));
            if (Math.random() < D.CAMPAIGN.throwChance) {
              var tkeys = D.ITEM_KEYS;
              race.incoming = { type: tkeys[Math.floor(Math.random() * tkeys.length)], eta: D.CAMPAIGN.itemWarnTicks };
              race.events.push({ tick: race.tick, msg: '👑 魔王擲出' + D.ITEMS[race.incoming.type].name + '！按空白閃避', type: 'bad' });
            }
          }
        } else {
          race.incoming.eta--;
          if (race.incoming.eta <= 0) {
            var it = D.ITEMS[race.incoming.type];
            if (it.stall) {
              player.stall = it.stall;
              player.stallTotal = it.stall; player.stallKind = 'item';
              race.events.push({ tick: race.tick, msg: it.icon + ' 命中！' + it.desc, type: 'bad' });
            } else {
              player.zapTicks = it.slowTicks;
              race.events.push({ tick: race.tick, msg: '⚡ 命中！車速下降', type: 'bad' });
            }
            race.incoming = null;
          }
        }
      }
    }
    for (var i = 0; i < race.cars.length; i++) {
      var car = race.cars[i];
      if (car.finished) continue;
      if (car.stall > 0) { car.stall--; continue; }
      var idx = Math.min(race.segs.length - 1, Math.floor(car.prog / D.SEG_LEN));
      if (idx !== car.segIdx) { car.segIdx = idx; _enterSeg(race, car, idx); if (car.stall > 0) continue; }
      var seg = race.segs[idx];
      var slopePct = seg.slope * 100, roughPct = seg.rough * 100;
      var tireFactor = P.tireBase + (1 - P.tireBase) * car.tirePct;
      var up = Math.max(0, slopePct) * P.upK * Math.max(0.2, 1 - car.climb * P.climbCut);
      var down = Math.max(0, -slopePct) * P.downK;
      var curve = roughPct * P.curveK * Math.max(0.15, 1 - car.grip * P.gripCut * tireFactor);
      if (slopePct < 0) curve *= P.downCurveMul;
      if (car.isPlayer && race.playerTired) curve *= P.tiredCurveMul;
      curve *= (car.curveMod || 1) * (car.curveBase || 1);
      var speed = D.clamp(D.BASE_SPEED + (car.spdAdd || 0) + car.accel * P.accelGain - up - curve + down, D.SPEED_MIN, D.SPEED_MAX);
      if (car.isPlayer && car.boostTicks > 0) {
        if (!(race.rules && race.rules.noNitro)) speed += (car.nitroPow || D.PLAY.nitroSpeed);
        car.boostTicks--;
      }
      if (car.zapTicks > 0) { speed *= 0.85; car.zapTicks--; }
      // 魔王 GY 技能
      if (car.isBoss && car.skills) {
        var pr = car.prog / race.total;
        if (car.skills.climbBeast && slopePct > 0) speed *= 1.18;
        if (car.skills.rocket && pr < 0.2) speed *= 1.15;
        if (car.skills.closerX && pr > 0.7) speed *= 1.15;
      }
      if (seg.gap) speed *= (1 - D.TERRAIN.gapSlow * (race.rules && race.rules.gap2 ? 1.7 : 1) * Math.max(0.3, 1 - car.climb * 0.05));
      // AI 個性：前段/後段
      var phase = (car.prog / race.total) < 0.5 ? car.style.early : car.style.late;
      car.prog += speed * 0.2 * car.spdMul * phase;
      if (car.prog >= race.total) {
        car.finished = true;
        race.finishOrder.push(car);
        race.events.push({ tick: race.tick, msg: car.name + ' 完賽！第 ' + race.finishOrder.length + ' 名', type: car.isPlayer ? 'good' : 'info' });
      }
    }
    if (race.finishOrder.length >= 3 || race.tick >= race.maxTick) {
      race.done = true;
      // 未完賽者依進度排 4~10
      var rest = race.cars.filter(function (c2) { return !c2.finished; });
      rest.sort(function (a, b) { return b.prog - a.prog; });
      race.ranking = race.finishOrder.concat(rest);
    }
  };

  // 玩家發射暗器：鎖定進度在自己前方最近的車（沒有就打領頭）
  C.fireItem = function (race, type, armDmgPct) {
    if (!race.itemsLeft || (race.itemsLeft[type] || 0) <= 0) return false;
    var player = race.cars[0];
    if (player.finished) return false;
    var target = null, best = Infinity;
    for (var i = 1; i < race.cars.length; i++) {
      var c2 = race.cars[i];
      if (c2.finished) continue;
      var d = c2.prog - player.prog;
      if (d >= 0 && d < best) { best = d; target = c2; }
    }
    if (!target) {
      for (var j = 1; j < race.cars.length; j++) if (!race.cars[j].finished) { target = race.cars[j]; break; }
    }
    if (!target) return false;
    race.itemsLeft[type]--;
    race.itemsUsed[type]++;
    var it = D.ITEMS[type];
    var mul = 1 + (armDmgPct || 0) / 100;
    if (it.stall) {
      target.stall = Math.round(it.stall * mul);
      target.stallTotal = target.stall; target.stallKind = 'item';
      race.events.push({ tick: race.tick, msg: it.icon + ' 命中 ' + target.name + '！', type: 'good' });
    } else {
      target.zapTicks = Math.round(it.slowTicks * mul);
      race.events.push({ tick: race.tick, msg: '⚡ 電到 ' + target.name + '！', type: 'good' });
    }
    return true;
  };

  // 閃避來襲暗器：eta 進入窗口才算成功
  C.tryDodge = function (race, dodgeWin) {
    if (!race.incoming) return false;
    if (race.incoming.eta <= dodgeWin) {
      var nm = D.ITEMS[race.incoming.type].name;
      race.incoming = null;
      race.dodges++;
      race.events.push({ tick: race.tick, msg: '帥氣閃過' + nm + '！', type: 'good' });
      return true;
    }
    return false;
  };

  // 結算：回傳 { rank, prize, xp, billTotal, debtCut, net }
  C.settle = function (race) {
    var rd = race.raceDef;
    var rank = 10;
    for (var i = 0; i < race.ranking.length; i++) if (race.ranking[i].isPlayer) { rank = i + 1; break; }
    var prize = rank <= 3 ? rd.prize[rank - 1] : rd.appear;
    var xp = Math.round(D.XP_BASE * rd.xpMul * D.RANK_XP_MUL[rank - 1]);
    var beatBoss = false;
    if (race.camp) {
      var bossRank = 99;
      for (var k2 = 0; k2 < race.ranking.length; k2++) if (race.ranking[k2].isBoss) { bossRank = k2 + 1; break; }
      beatBoss = rank <= 3 && rank < bossRank;
    }
    var billTotal = 0;
    for (var j = 0; j < race.bills.length; j++) billTotal += race.bills[j].amt;
    return { rank: rank, prize: prize, xp: xp, billTotal: billTotal, bills: race.bills, codeLabel: race.codeLabel, beatBoss: beatBoss };
  };

  /* ============ 四、存檔（IDB + 雲端合併式） ============ */
  var IDB_NAME = 'dengGames', IDB_STORE = 'saves';

  // ⚠ dengGames 是大老二先建的 DB，版本未知 —— 不帶版本開啟相容任何現有版本；
  //   store 缺失才以 version+1 升級補建（避免低版本開啟造成 VersionError 靜默炸掉存檔）
  function _idb(cb) {
    if (typeof indexedDB === 'undefined' || !indexedDB) { setTimeout(function () { cb(null); }, 0); return; }
    var req = indexedDB.open(IDB_NAME); // 不帶版本
    req.onupgradeneeded = function (e) { // 只在 DB 全新時觸發
      e.target.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = function (e) {
      var db = e.target.result;
      if (db.objectStoreNames.contains(IDB_STORE)) { cb(db); return; }
      var v = db.version + 1;
      db.close();
      var r2 = indexedDB.open(IDB_NAME, v);
      r2.onupgradeneeded = function (ev) { ev.target.result.createObjectStore(IDB_STORE); };
      r2.onsuccess = function (ev) { cb(ev.target.result); };
      r2.onerror = function (ev) { console.warn('[KR] IDB 升級補建 store 失敗', ev && ev.target && ev.target.error); cb(null); };
    };
    req.onerror = function (e) {
      console.warn('[KR] IDB 開啟失敗', e && e.target && e.target.error);
      cb(null);
    };
  }

  C.saveGame = function (data) {
    data.updatedAt = Date.now();
    _idb(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        var st = tx.objectStore(IDB_STORE);
        // ⚠ saves store 是大老二建的，可能用 in-line key（keyPath）——執行期偵測自動適配
        if (st.keyPath && typeof st.keyPath === 'string') {
          data[st.keyPath] = D.SAVE_KEY;
          st.put(data);
        } else {
          st.put(data, D.SAVE_KEY);
        }
        tx.onerror = function (e) { console.warn('[KR] IDB 寫入失敗', e && e.target && e.target.error); };
      } catch (e) { console.warn('[KR] IDB 寫入例外', e); }
    });
    try { localStorage.setItem('kr_save', JSON.stringify(data)); } catch (e) {} // 第三層備援
    if (typeof window.__gameCloudSave === 'function') {
      try { window.__gameCloudSave(D.SAVE_KEY, data); } catch (e) {}
    }
  };

  // IDB + localStorage + 雲端三路並讀，updatedAt 最新者勝
  C.loadGame = function (cb) {
    var cands = [], pend = 1;
    var fin = function () {
      if (--pend > 0) return;
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        if (cands[i] && (!best || (cands[i].updatedAt || 0) > (best.updatedAt || 0))) best = cands[i];
      }
      cb(best ? C.migrate(best) : C.newSave());
    };
    try {
      var ls = localStorage.getItem('kr_save');
      if (ls) cands.push(JSON.parse(ls));
    } catch (e) {}
    if (typeof window.__gameCloudLoad === 'function') {
      pend++;
      try {
        window.__gameCloudLoad(D.SAVE_KEY, function (d) {
          if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
          if (d) cands.push(d);
          fin();
        });
      } catch (e) { fin(); }
    }
    _idb(function (db) {
      if (!db) { fin(); return; }
      try {
        var rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(D.SAVE_KEY);
        rq.onsuccess = function () { if (rq.result) cands.push(rq.result); fin(); };
        rq.onerror = function () { console.warn('[KR] IDB 讀取失敗'); fin(); };
      } catch (e) { console.warn('[KR] IDB 讀取例外', e); fin(); }
    });
  };

  C.newSave = function () {
    return {
      money: D.START_MONEY, debtRepair: 0,
      loans: [], credit: D.BANK.creditStart, missStreak: 0,
      lv: 1, xp: 0,
      stats: { str: D.START_STATS.str, vit: D.START_STATS.vit, end: D.START_STATS.end },
      statPts: 0, energy: D.ENERGY_BASE + D.START_STATS.vit * D.ENERGY_PER_VIT,
      house: 0, garageLv: 1,
      cars: [{
        id: 1, name: '小白', tier: 'C', type: 'std',
        accel: 1, grip: 1, climb: 1,
        tireType: 'normal', tirePct: 1, tireBarsUsed: 0, milesSinceService: 0,
        mods: [], svcBuff: 0, tireTech: 0, tuneMode: 'std',
        mats: { accel: 'lin', grip: 'lin', climb: 'lin' }
      }],
      nextCarId: 2, activeCar: 1,
      day: 1, jobCounts: { wash: 0, gas: 0, repair: 0 }, shopSpent: 0,
      rnd: { eng: 0, mat: 0, nos: 0, rel: 0, craft: 0 }, rivalPow: {},
      campaign: { stage: 1, cleared: 0 },
      items: { banana: 0, shell: 0, zap: 0 },
      armory: { dmg: 0, carry: 0, dodge: 0 },
      resortBuff: false, flags: {},
      stats2: { races: 0, wins: 0, earned: 0 },
      updatedAt: 0
    };
  };

  C.migrate = function (s) {
    var base = C.newSave();
    for (var k in base) if (s[k] === undefined) s[k] = base[k];
    if (!s.cars || !s.cars.length) s.cars = base.cars;
    if (!s.rnd) s.rnd = { eng: 0, mat: 0, nos: 0, rel: 0, craft: 0 };
    if (!s.rivalPow) s.rivalPow = {};
    if (!s.campaign) s.campaign = { stage: 1, cleared: 0 };
    if (!s.items) s.items = { banana: 0, shell: 0, zap: 0 };
    if (!s.armory) s.armory = { dmg: 0, carry: 0, dodge: 0 };
    for (var ci = 0; ci < s.cars.length; ci++) {
      if (!s.cars[ci].mods) s.cars[ci].mods = [];
      if (s.cars[ci].svcBuff === undefined) s.cars[ci].svcBuff = 0;
      if (s.cars[ci].tireTech === undefined) s.cars[ci].tireTech = 0;
      if (!s.cars[ci].tuneMode) s.cars[ci].tuneMode = 'std';
      if (!s.cars[ci].mats) s.cars[ci].mats = { accel: 'lin', grip: 'lin', climb: 'lin' };
    }
    return s;
  };

  /* ============ 五、共用 helpers ============ */
  C.energyMax = function (save) { return D.ENERGY_BASE + Math.floor(save.stats.vit) * D.ENERGY_PER_VIT; };

  C.addXp = function (save, xp) {
    save.xp += xp;
    var ups = 0;
    while (save.xp >= D.xpNeed(save.lv)) {
      save.xp -= D.xpNeed(save.lv);
      save.lv++;
      save.stats.str += D.LEVEL_UP.autoStat;
      save.stats.vit += D.LEVEL_UP.autoStat;
      save.stats.end += D.LEVEL_UP.autoStat;
      save.statPts += D.LEVEL_UP.freePts;
      ups++;
    }
    return ups;
  };

  C.activeCar = function (save) {
    for (var i = 0; i < save.cars.length; i++) if (save.cars[i].id === save.activeCar) return save.cars[i];
    return save.cars[0];
  };

  /* ---------- 征途：第 n 關確定性生成（同關永遠同規則同魔王） ---------- */
  C.campStage = function (n) {
    var s = (n * 2654435761) >>> 0;
    var rnd = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    var CP = D.CAMPAIGN;
    var pick = function (arr, count) {
      var pool = arr.slice(), out = [];
      while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      return out;
    };
    var ruleCount = Math.min(3, 1 + Math.floor((n - 1) / 4));
    var skillCount = Math.min(4, 1 + Math.floor((n - 1) / 6));
    var rules = {};
    var ruleList = pick(CP.rulePool, ruleCount);
    for (var i = 0; i < ruleList.length; i++) rules[ruleList[i].id] = true;
    var skills = {};
    var skillList = pick(CP.skillPool, skillCount);
    for (var j = 0; j < skillList.length; j++) skills[skillList[j].id] = true;
    var raceIdx = n % 10 === 0 ? 3 : (n <= 3 ? 0 : n <= 8 ? 1 : 2); // 每 10 關一場 1y 耐力魔王戰
    var reward = CP.rewardBase + CP.rewardPer * n;
    if (n % CP.milestoneEvery === 0) reward *= CP.milestoneMul;
    return {
      n: n,
      name: CP.titles[Math.floor(rnd() * CP.titles.length)] + CP.surnames[Math.floor(rnd() * CP.surnames.length)],
      band: Math.min(CP.bossBandCap, CP.bossBandBase + CP.bossBandPer * n),
      skills: skills, skillList: skillList,
      rules: rules, ruleList: ruleList,
      raceIdx: raceIdx,
      reward: Math.round(reward),
      xp: CP.xpBase + CP.xpPer * n
    };
  };

  /* ---------- 武裝研發曲線 ---------- */
  C.armVal = function (id, lv) {
    lv = lv || 0;
    if (lv <= 0) return 0;
    if (id === 'dmg') return Math.round(60 * (1 - Math.pow(0.96, lv)));   // 漸近 +60% 威力
    if (id === 'carry') return lv;                                          // 每級 +1 攜帶
    if (id === 'dodge') return Math.round(6 * Math.pow(lv, 0.6));           // 次線性 +tick
    return 0;
  };
  C.armCost = function (lv) { return Math.round(D.ARMORY.costBase * Math.pow(D.ARMORY.costGrow, lv)); };

  /* ---------- 材料路線：Lv → 有效值 ---------- */
  C.matEff = function (car, key) {
    var lv = car[key] || 0;
    var route = (car.mats || {})[key] || 'lin';
    if (route === 'pow') return Math.round(0.6 * Math.pow(lv, 1.28) * 10) / 10;
    if (route === 'log') return Math.round(3.0 * Math.log(lv + 1) * 10) / 10;
    return lv;
  };

  /* ---------- 無限研發：曲面成長公式 ---------- */
  C.rndVal = function (id, lv) {
    lv = lv || 0;
    if (lv <= 0) return 0;
    switch (id) {
      case 'eng':   return Math.round(2 * Math.pow(lv, 0.6) * 10) / 10;      // 次線性無上限
      case 'mat':   return Math.round(50 * (1 - Math.pow(0.96, lv)) * 10) / 10; // 漸近 50%
      case 'nos':   return Math.round(4 * Math.pow(lv, 0.55) * 10) / 10;
      case 'rel':   return Math.round(50 * (1 - Math.pow(0.97, lv)) * 10) / 10;
      case 'craft': return Math.round(30 * (1 - Math.pow(0.95, lv)) * 10) / 10; // 漸近 30%
    }
    return 0;
  };
  C.rndCost = function (lv) { return Math.round(D.RND.costBase * Math.pow(D.RND.costGrow, lv)); };

  /* ---------- AI 宿敵成長 ---------- */
  C.initRivals = function (save, eff) {
    if (!save.rivalPow) save.rivalPow = {};
    for (var i = 0; i < D.RIVALS.length; i++) {
      var nm = D.RIVALS[i].name;
      if (save.rivalPow[nm] === undefined) {
        save.rivalPow[nm] = eff * D.rnd(D.RIVAL.initBand[0], D.RIVAL.initBand[1]);
      }
    }
  };
  C.growRivals = function (save, eff) {
    if (!save.rivalPow) return;
    for (var i = 0; i < D.RIVALS.length; i++) {
      var rv = D.RIVALS[i];
      var p = save.rivalPow[rv.name] || eff;
      p += D.rnd(D.RIVAL.growMin, D.RIVAL.growMax) * (D.RIVAL.talents[rv.style] || 1);
      save.rivalPow[rv.name] = D.clamp(p, eff * D.RIVAL.clampLo, eff * D.RIVAL.clampHi);
    }
  };

  // 主站 window.__snapshot 查妖股（X1/X2/X5/X6 任一亮）
  C.checkYaogu = function (code) {
    try {
      var snap = window.__snapshot;
      if (!snap) return null;
      var sc = snap[code] || snap[code + '.TW'] || snap[code + '.TWO'];
      if (!sc && snap.data) sc = snap.data[code] || snap.data[code + '.TW'] || snap.data[code + '.TWO'];
      if (!sc) return null;
      var tags = [], ids = ['X1', 'X2', 'X5', 'X6'];
      for (var i = 0; i < ids.length; i++) if (sc[ids[i]] === true) tags.push(ids[i]);
      return tags.length ? { tags: tags } : null;
    } catch (e) { return null; }
  };

  // 股名：window.__nameCache 是 Map（api-names.js），備援 localStorage __nameCache_v1
  C.stockName = function (code) {
    try {
      var m = window.__nameCache;
      if (m) {
        var n = (typeof m.get === 'function')
          ? (m.get(code) || m.get(code + '.TW') || m.get(code + '.TWO'))
          : (m[code] || m[code + '.TW'] || m[code + '.TWO']);
        if (n) return n;
      }
      var ls = localStorage.getItem('__nameCache_v1');
      if (ls) {
        var parsed = JSON.parse(ls);
        if (parsed && parsed.data && parsed.data[code]) return parsed.data[code];
      }
    } catch (e) {}
    return null;
  };

  C.shopTier = function (save) {
    var t = D.SHOP.tiers[0];
    for (var i = 0; i < D.SHOP.tiers.length; i++) {
      if ((save.shopSpent || 0) >= D.SHOP.tiers[i].need) t = D.SHOP.tiers[i];
    }
    return t;
  };

  C.debtCap = function (save) { return D.DEBT_CAP_PER_LV * save.lv; };
  C.loanQuota = function (save) { return D.BANK.quotaPerLv * save.lv + D.BANK.quotaPerCredit * save.credit; };
  C.loanUsed = function (save) {
    var s = 0;
    for (var i = 0; i < save.loans.length; i++) s += save.loans[i].remaining;
    return s;
  };
  C.serviceDue = function (car) { return car.milesSinceService >= D.SERVICE_EVERY; };
  C.serviceCost = function (car, save) {
    var price = D.CAR_TIERS[car.tier].price || D.SERVICE_BASE_C;
    var c = price * D.SERVICE_RATE;
    if (save.flags.repairDiscount) c *= 0.9;
    return Math.round(c);
  };

  // 每天結束：銀行扣款 + 渡假 buff 清除。回傳訊息陣列
  C.endDay = function (save) {
    var msgs = [];
    save.day++;
    var paidAll = true;
    for (var i = save.loans.length - 1; i >= 0; i--) {
      var L = save.loans[i];
      if (save.money >= L.perDay) {
        save.money -= L.perDay;
        L.remaining = Math.max(0, L.remaining - L.perDay);
        save.credit = D.clamp(save.credit + D.BANK.creditOk, D.BANK.creditMin, D.BANK.creditMax);
        if (L.remaining <= 0) { save.loans.splice(i, 1); msgs.push('一筆貸款還清！'); }
      } else {
        paidAll = false;
        save.credit = D.clamp(save.credit + D.BANK.creditMiss, D.BANK.creditMin, D.BANK.creditMax);
        msgs.push('貸款扣款失敗！信用 −15');
      }
    }
    if (save.loans.length === 0) save.missStreak = 0;
    else save.missStreak = paidAll ? 0 : save.missStreak + 1;
    if (save.missStreak >= D.BANK.missLimit) {
      msgs.push(C.foreclose(save));
      save.missStreak = 0;
    }
    return msgs;
  };

  // 法拍：先拍非出賽車（7 折），再降房一級
  C.foreclose = function (save) {
    var victim = null;
    for (var i = 0; i < save.cars.length; i++) {
      if (save.cars.length > 1 && save.cars[i].id !== save.activeCar) { victim = i; break; }
    }
    if (victim !== null) {
      var car = save.cars.splice(victim, 1)[0];
      var cash = Math.round((D.CAR_TIERS[car.tier].price || D.SERVICE_BASE_C) * D.BANK.carAuctionRate);
      save.money += cash;
      C.payLoansFrom(save);
      return '法拍！「' + car.name + '」被拍賣（' + D.fmt(cash) + '）';
    }
    if (save.house > 0) {
      var h = D.HOUSES[save.house];
      save.house--;
      var cap = D.HOUSES[save.house].garageCap;
      if (save.garageLv > cap) save.garageLv = cap;
      save.money += Math.round(h.price * D.HOUSE_SELLBACK);
      C.payLoansFrom(save);
      return '法拍！房產降級為「' + D.HOUSES[save.house].name + '」';
    }
    return '法拍！但你已一無所有…貸款展延';
  };

  C.payLoansFrom = function (save) {
    for (var i = save.loans.length - 1; i >= 0; i--) {
      var L = save.loans[i];
      var pay = Math.min(save.money, L.remaining);
      save.money -= pay; L.remaining -= pay;
      if (L.remaining <= 0) save.loans.splice(i, 1);
    }
  };

  KR.C = C;
})();
