(function(){
  var _md = null, _td = null, _yd = null;
  var _msgs = ['外資在買，注意籌碼', '今日漲停族群已更新', '開盤前做好功課喵', '記得看籌碼面喵~'];
  var _mi = 0, _bubble = null;

  function _setAll(key, text) {
    document.querySelectorAll('[data-sv="' + key + '"]').forEach(function(el){ el.textContent = text; });
  }
  function _setAllCls(key, text, cls) {
    document.querySelectorAll('[data-sv="' + key + '"]').forEach(function(el){ el.textContent = text; el.className = cls; });
  }

  function _fillCurves() {
    // 上方曲線（紅）：漲停個股 + 妖股
    var topParts = [];
    if (_md) {
      (_md.sectorRank || []).forEach(function(g){
        (g.stocks || []).forEach(function(s){
          if (s.chgPct >= 9.5) topParts.push(s);
        });
      });
      topParts.sort(function(a,b){ return b.chgPct - a.chgPct; });
      topParts = topParts.slice(0, 8).map(function(s){
        return '▲ ' + s.code + ' ' + s.name + ' +' + (s.chgPct).toFixed(2) + '%';
      });
    }
    if (_yd && _yd.length) {
      _yd.slice(0, 3).forEach(function(y){
        topParts.push('⚡ ' + y.name + ' ' + (y.signals || []).join('+'));
      });
    }
    var topEl = document.getElementById('dsTpTopText');
    if (topEl && topParts.length) topEl.textContent = topParts.join('　·　') + '　·　';

    // 下方曲線（青）：族群 + 市場 + 題材
    var botParts = [];
    if (_md) {
      (_md.sectorRank || []).slice(0, 4).forEach(function(g){ botParts.push(g.sector + ' ' + g.count + '檔'); });
      var s = _md.stats;
      botParts.push('漲停 ' + s.limitUp + '檔');
      var f = Math.round((s.foreign || 0) / 1000);
      if (f !== 0) botParts.push('外資' + (f > 0 ? '買超 +' : '賣超 ') + Math.abs(f) + '億');
    }
    if (_td && _td.length) {
      botParts.push('題材命中：' + _td.slice(0, 2).map(function(h){ return h.name + '(' + h.count + ')'; }).join(' · '));
    }
    var botEl = document.getElementById('dsTpBotText');
    if (botEl && botParts.length) botEl.textContent = botParts.join('　·　') + '　·　';
  }

  function _fillStraight() {
    if (!_md) return;
    var s = _md.stats, sr = _md.sectorRank || [];
    _setAll('limit-up', s.limitUp + '檔');
    _setAll('sectors', [sr[0] && sr[0].sector, sr[1] && sr[1].sector].filter(Boolean).join(' · ') || '—');
    _setAll('up-count', s.up + '');
    _setAll('down-count', s.down + '');
    _setAll('limit-down', s.limitDown + '檔');
    _setAll('main-axis', sr[0] ? sr[0].sector : '—');
    var f = Math.round((s.foreign || 0) / 1000);
    var inv = Math.round((s.invest || 0) / 1000);
    _setAllCls('foreign', (f >= 0 ? '+' : '') + f + '億', f >= 0 ? 'ds-up' : 'ds-dn');
    _setAllCls('invest', (inv >= 0 ? '+' : '') + inv + '億', inv >= 0 ? 'ds-up' : 'ds-dn');
  }

  function _fillThemes() {
    if (!_td || !_td.length) return;
    _setAll('theme-hit', _td.slice(0, 3).map(function(h){ return h.name + ' ' + h.count + '檔'; }).join(' · '));
  }

  function _fillYaogu() {
    if (!_yd || !_yd.length) return;
    _setAll('yaogu-hit', _yd.slice(0, 3).map(function(y){ return y.name + ' ' + (y.signals||[]).join('+'); }).join(' · '));
  }

  function _buildMsgs() {
    var m = [];
    if (_md) {
      var s = _md.stats, sr = _md.sectorRank || [];
      if (s.limitUp > 0) m.push('今日漲停 ' + s.limitUp + ' 檔！');
      if (sr[0]) m.push(sr[0].sector + ' 族群強熱 ' + sr[0].count + ' 檔');
      var f = Math.round((s.foreign || 0) / 1000);
      if (f > 0)  m.push('外資買超 +' + f + '億 注意籌碼');
      if (f < 0)  m.push('外資賣超 ' + Math.abs(f) + '億，留意風險');
      m.push('漲跌家數 ' + s.up + ':' + s.down);
    }
    if (_td && _td.length) {
      m.push('題材命中：' + _td.slice(0,2).map(function(h){ return h.name + ' ' + h.count + '檔'; }).join(' · '));
    }
    if (_yd && _yd.length) {
      m.push('妖股偵測！' + _yd.slice(0,2).map(function(y){ return y.name + ' ' + (y.signals||[]).join('+'); }).join(' · '));
    }
    if (!m.length) m = ['外資在買，注意籌碼', '今日漲停族群已更新', '開盤前做好功課喵'];
    _msgs = m;
  }

  // ── 公開介面：主程式呼叫 ──────────────────────────────────
  // 市場資料：window.__splashFeed('market', {stats:{up,down,flat,limitUp,limitDown,totalVol,foreign,invest}, sectorRank:[{sector,count,stocks:[{code,name,chgPct}]}]})
  // 題材命中：window.__splashFeed('themes', [{name, count, dateLabel}])
  // 妖股偵測：window.__splashFeed('yaogu', [{code, name, signals:['X2','X1']}])
  window.__splashFeed = function(type, data) {
    var el = document.getElementById('dengSplash');
    if (!el || el.classList.contains('ds-gone')) return;
    if (type === 'market') { _md = data; _fillStraight(); _fillCurves(); _buildMsgs(); }
    else if (type === 'themes') { _td = data; _fillThemes(); _fillCurves(); _buildMsgs(); }
    else if (type === 'yaogu')  { _yd = data; _fillYaogu();  _fillCurves(); _buildMsgs(); }
  };

  // 台詞輪播
  function rotatMsg() {
    _mi = (_mi + 1) % _msgs.length;
    if (!_bubble) _bubble = document.getElementById('dsBubble');
    if (!_bubble) return;
    _bubble.style.opacity = '0';
    _bubble.style.transform = 'translateY(-4px)';
    setTimeout(function(){
      _bubble.textContent = _msgs[_mi];
      _bubble.style.opacity = '1';
      _bubble.style.transform = 'translateY(0)';
    }, 300);
  }
  setInterval(rotatMsg, 3800);

  // 日期
  var dl = document.getElementById('dsDateline');
  if (dl) {
    var d = new Date();
    var yy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
    dl.textContent = yy + ' · ' + mm + ' · ' + dd + ' · 盤後版';
  }

  window.__hideSplash = function() {
    var el = document.getElementById('dengSplash');
    if (!el || el.classList.contains('ds-gone')) return;
    el.classList.add('ds-exit');
    setTimeout(function(){ el.classList.add('ds-gone'); }, 520);
  };
})();

(function() {
  var canvas = document.getElementById('dsDotCanvas');
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var SIZE = 320;
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  var W = SIZE, H = SIZE, CX = W / 2, CY = H / 2, N = 120;

  function pad(pts, col) {
    while (pts.length < N) pts.push({ x: CX, y: CY, color: col || '#c0392b', baseR: 0.8, ringR: 0 });
    return pts.slice(0, N);
  }
  function lineDots(x1, y1, x2, y2, n, col, r) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      pts.push({ x: x1+(x2-x1)*t, y: y1+(y2-y1)*t, color: col, baseR: r || 4, ringR: 0 });
    }
    return pts;
  }
  function bezierDots(p0, p1, p2, p3, n, col, r) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i/n, mt = 1-t;
      var x = mt*mt*mt*p0[0]+3*mt*mt*t*p1[0]+3*mt*t*t*p2[0]+t*t*t*p3[0];
      var y = mt*mt*mt*p0[1]+3*mt*mt*t*p1[1]+3*mt*t*t*p2[1]+t*t*t*p3[1];
      pts.push({ x: x, y: y, color: col, baseR: r || 4.5, ringR: 0 });
    }
    return pts;
  }

  var scenes = [];

  // S0: 10×10 grid + 外圈20
  (function() {
    var pts = [], PAD = 16, SP = (W - PAD * 2) / 9;
    for (var r = 0; r < 10; r++) for (var c = 0; c < 10; c++) {
      var x = PAD + c * SP, y = PAD + r * SP;
      var dist = Math.sqrt((c-4.5)*(c-4.5)+(r-4.5)*(r-4.5));
      pts.push({ x: x, y: y, ringR: 0,
        color: dist<1.5?'#ff6b6b':dist<3?'#ef5350':dist<5?'#ff7043':'#c0392b',
        baseR: dist<1.5?8:dist<3?6.5:dist<5?5:4 });
    }
    for (var i = 0; i < 20; i++) {
      var a = (i/20)*Math.PI*2;
      pts.push({ x: CX+140*Math.cos(a), y: CY+140*Math.sin(a), color: '#c0392b', baseR: 3.5, ringR: 0 });
    }
    scenes.push(pts.slice(0, N));
  })();

  // S1: 晶片AI
  (function() {
    var pts = [], cs = 110;
    for (var i = 0; i < 8; i++) pts.push({ x: CX-cs+i*(cs*2/7), y: CY-cs, color: '#ff8c42', baseR: 4.5, ringR: 0 });
    for (var i = 0; i < 8; i++) pts.push({ x: CX-cs+i*(cs*2/7), y: CY+cs, color: '#ff8c42', baseR: 4.5, ringR: 0 });
    for (var i = 1; i <= 6; i++) pts.push({ x: CX-cs, y: CY-cs+i*(cs*2/7), color: '#ff8c42', baseR: 4.5, ringR: 0 });
    for (var i = 1; i <= 6; i++) pts.push({ x: CX+cs, y: CY-cs+i*(cs*2/7), color: '#ff8c42', baseR: 4.5, ringR: 0 });
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(function(s) { pts.push({ x: CX+s[0]*cs, y: CY+s[1]*cs, color: '#ff8c42', baseR: 5.5, ringR: 0 }); });
    [-36,-24,-12,0,12,24,36].forEach(function(o) {
      pts.push({ x: CX+o, y: CY-cs-20, color: '#ffcc02', baseR: 4, ringR: 0 });
      pts.push({ x: CX+o, y: CY+cs+20, color: '#ffcc02', baseR: 4, ringR: 0 });
    });
    [-24,-12,0,12,24].forEach(function(o) {
      pts.push({ x: CX-cs-20, y: CY+o, color: '#ffcc02', baseR: 4, ringR: 0 });
      pts.push({ x: CX+cs+20, y: CY+o, color: '#ffcc02', baseR: 4, ringR: 0 });
    });
    [[-34,24],[-27,10],[-20,-4],[-13,-18],[-6,-4],[1,10],[8,24],[-26,6],[-20,6],[-14,6]].forEach(function(p) {
      pts.push({ x: CX+p[0]-8, y: CY+p[1], color: '#ef5350', baseR: 6, ringR: 0 });
    });
    [[28,-18],[28,-6],[28,6],[28,18]].forEach(function(p) {
      pts.push({ x: CX+p[0]-8, y: CY+p[1], color: '#ef5350', baseR: 6, ringR: 0 });
    });
    scenes.push(pad(pts, '#ff8c42'));
  })();

  // S2: favicon 同心（ringR 驅動漣漪閃爍）
  (function() {
    var pts = [], R2 = 52, R3 = 88, R4 = 118, R5 = 148;
    pts.push({ x: CX, y: CY, color: '#ff6b6b', baseR: 10, ringR: 0 });
    [[CX,CY-R2],[CX,CY+R2],[CX-R2,CY],[CX+R2,CY]].forEach(function(p) { pts.push({ x: p[0], y: p[1], color: '#ef5350', baseR: 8, ringR: R2 }); });
    var r3 = R3*0.707;
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(function(s) { pts.push({ x: CX+s[0]*r3, y: CY+s[1]*r3, color: '#ff7043', baseR: 7, ringR: R3 }); });
    for (var i = 0; i < 24; i++) { var a=(i/24)*Math.PI*2; pts.push({ x: CX+R4*Math.cos(a), y: CY+R4*Math.sin(a), color: '#c0392b', baseR: 4.5, ringR: R4 }); }
    for (var i = 0; i < 20; i++) { var a=(i/20)*Math.PI*2+Math.PI/20; pts.push({ x: CX+R3*Math.cos(a), y: CY+R3*Math.sin(a), color: '#ef5350', baseR: 5, ringR: R3 }); }
    for (var i = 0; i < 16; i++) { var a=(i/16)*Math.PI*2; pts.push({ x: CX+R2*Math.cos(a), y: CY+R2*Math.sin(a), color: '#ff6b6b', baseR: 4, ringR: R2 }); }
    for (var i = 0; i < 28; i++) { var a=(i/28)*Math.PI*2; pts.push({ x: CX+R5*Math.cos(a), y: CY+R5*Math.sin(a), color: '#c0392b', baseR: 3.5, ringR: R5 }); }
    scenes.push(pad(pts, '#ff6b6b'));
  })();

  // S3: K線10根
  (function() {
    var pts = [];
    [{x:18,y1:256,y2:204,up:1},{x:48,y1:220,y2:164,up:1},{x:78,y1:240,y2:200,up:0},
     {x:108,y1:204,y2:144,up:1},{x:138,y1:228,y2:180,up:0},{x:168,y1:180,y2:120,up:1},
     {x:198,y1:196,y2:144,up:1},{x:228,y1:148,y2:88,up:1},{x:258,y1:164,y2:116,up:0},{x:288,y1:120,y2:60,up:1}
    ].forEach(function(b) {
      var col = b.up ? '#ef5350' : '#26a69a';
      var steps = Math.round((b.y1-b.y2)/18);
      for (var i = 0; i <= steps; i++) pts.push({ x: b.x, y: b.y2+i*18, color: col, baseR: 5.5, ringR: 0 });
      pts.push({ x: b.x, y: b.y2-12, color: col, baseR: 3.5, ringR: 0 });
      pts.push({ x: b.x, y: b.y1+12, color: col, baseR: 3.5, ringR: 0 });
    });
    scenes.push(pad(pts, '#ef5350'));
  })();

  // S4: 上升箭頭
  (function() {
    var pts = [];
    for (var i = 0; i < 80; i++) {
      var t2 = i/79;
      pts.push({ x: 20+t2*220, y: 295-t2*240,
        color: t2<0.35?'#c0392b':t2<0.65?'#ef5350':'#ff6b6b', baseR: 3+t2*5, ringR: 0 });
    }
    [{x:242,y:52},{x:224,y:38},{x:264,y:42},{x:222,y:66},{x:262,y:70},{x:242,y:82},{x:218,y:54},{x:268,y:56}].forEach(function(p) {
      pts.push({ x: p.x, y: p.y, color: '#ff6b6b', baseR: 7, ringR: 0 });
    });
    scenes.push(pad(pts, '#ff7043'));
  })();

  // S5: 螺旋星場
  (function() {
    var pts = [];
    for (var i = 0; i < N; i++) {
      var a = i*2.399, r = 8+Math.sqrt(i)*13.5, frac = i/N;
      pts.push({ x: CX+r*Math.cos(a), y: CY+r*Math.sin(a), ringR: 0,
        color: frac<0.25?'#ff6b6b':frac<0.55?'#ef5350':frac<0.78?'#ff7043':'#c0392b',
        baseR: frac<0.15?9:frac<0.45?7:frac<0.7?5.5:4.5 });
    }
    scenes.push(pts);
  })();

  // S6: 漣漪爆開
  (function() {
    var pts = [];
    var rings = [
      { r:0,   n:1,  color:'#ff6b6b', baseR:10 },
      { r:36,  n:8,  color:'#ff6b6b', baseR:8  },
      { r:68,  n:14, color:'#ef5350', baseR:6.5 },
      { r:100, n:20, color:'#ff7043', baseR:5.5 },
      { r:132, n:26, color:'#c0392b', baseR:4.5 },
      { r:155, n:28, color:'#c0392b', baseR:3.5 },
      { r:50,  n:13, color:'#ef5350', baseR:5   }
    ];
    rings.forEach(function(ring) {
      if (ring.r === 0) {
        pts.push({ x: CX, y: CY, color: ring.color, baseR: ring.baseR, ringR: 0 });
      } else {
        for (var i = 0; i < ring.n; i++) {
          var a = (i/ring.n)*Math.PI*2;
          pts.push({ x: CX+ring.r*Math.cos(a), y: CY+ring.r*Math.sin(a),
            color: ring.color, baseR: ring.baseR, ringR: ring.r });
        }
      }
    });
    scenes.push(pad(pts, '#c0392b'));
  })();

  // S7: 東京鐵塔
  (function() {
    var pts = [];
    var col = '#ef5350', col2 = '#ff7043', col3 = '#ffcc02';
    var peak = 8, mainTop = 42, obs1 = 148, obs2 = 198, base = 292;

    // 天線
    lineDots(CX,peak,CX,mainTop,7,col3,2.5).forEach(function(p){pts.push(p);});

    // 左腿上段（極窄）
    bezierDots([CX-2,mainTop],[CX-8,88],[CX-16,118],[CX-18,obs1],10,col,4).forEach(function(p){pts.push(p);});
    // 左腿下段（外撇）
    bezierDots([CX-18,obs1],[CX-24,218],[CX-55,258],[CX-92,base],12,col,5).forEach(function(p){pts.push(p);});

    // 右腿上段
    bezierDots([CX+2,mainTop],[CX+8,88],[CX+16,118],[CX+18,obs1],10,col,4).forEach(function(p){pts.push(p);});
    // 右腿下段
    bezierDots([CX+18,obs1],[CX+24,218],[CX+55,258],[CX+92,base],12,col,5).forEach(function(p){pts.push(p);});

    // 展望台1（大）
    lineDots(CX-22,obs1,CX+22,obs1,6,col2,5.5).forEach(function(p){pts.push(p);});
    lineDots(CX-22,obs1+14,CX+22,obs1+14,5,col2,4.5).forEach(function(p){pts.push(p);});
    // 展望台2（小）
    lineDots(CX-12,obs2,CX+12,obs2,4,col2,5).forEach(function(p){pts.push(p);});

    // 橫向桁架
    [68,95,122,165,205,245,272].forEach(function(y) {
      var hw = y<=obs1 ? 2+(y-mainTop)/(obs1-mainTop)*16 : 18+(y-obs1)/(base-obs1)*74;
      lineDots(CX-hw,y,CX+hw,y,Math.round(hw/20)+2,col,3).forEach(function(p){pts.push(p);});
    });

    // 底座
    lineDots(CX-98,base+8,CX+98,base+8,8,'#c0392b',4).forEach(function(p){pts.push(p);});

    scenes.push(pad(pts, col));
  })();

  var RIPPLE_IDX = 6, FAV_IDX = 2;
  var NS = scenes.length, _last = 0, _curScene = 0, _rippleFrame = 0;

  function _nextIdx() {
    var pool = [];
    for (var i = 0; i < NS; i++) if (i !== _last) pool.push(i);
    var p = pool[Math.floor(Math.random() * pool.length)];
    _last = p; return p;
  }

  var dots = [];
  for (var i = 0; i < N; i++) {
    var s = scenes[0][i];
    dots.push({
      x: s.x, y: s.y, tx: s.x, ty: s.y,
      color: s.color, tcolor: s.color,
      baseR: s.baseR, tbaseR: s.baseR,
      phase: Math.random()*Math.PI*2,
      speed: 0.4+Math.random()*1.2,
      minAlpha: 0.08+Math.random()*0.12,
      maxAlpha: 0.55+Math.random()*0.4,
      rippleDelay: 0, _dist: 0
    });
  }

  function assignScene(si) {
    _curScene = si;
    var sc = scenes[si];
    var maxDist = 0;
    for (var i = 0; i < N; i++) {
      var dist = Math.sqrt((dots[i].x-CX)*(dots[i].x-CX)+(dots[i].y-CY)*(dots[i].y-CY));
      if (dist > maxDist) maxDist = dist;
      dots[i]._dist = dist;
    }
    for (var i = 0; i < N; i++) {
      dots[i].tx = sc[i].x; dots[i].ty = sc[i].y;
      dots[i].tcolor = sc[i].color; dots[i].tbaseR = sc[i].baseR;
      dots[i].rippleDelay = dots[i]._dist / (maxDist || 1) * 40;
    }
    _rippleFrame = 0;
  }

  assignScene(0);
  setInterval(function() { assignScene(_nextIdx()); }, 3800);

  var t = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    _rippleFrame++;
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var sc = scenes[_curScene];
      var ringR = sc[i].ringR || 0;

      if (_curScene === RIPPLE_IDX) {
        d.x += (d.tx-d.x)*0.04; d.y += (d.ty-d.y)*0.04; d.baseR += (d.tbaseR-d.baseR)*0.06;
        var wave = Math.sin(d.phase+t*d.speed*0.04-ringR*0.045);
        var alpha = d.minAlpha+(wave*0.5+0.5)*(d.maxAlpha-d.minAlpha);
        var burstWave = Math.max(0, Math.sin(t*0.03-ringR*0.04));
        alpha = Math.min(1, alpha+burstWave*0.5);
        var rad = d.baseR*(0.88+wave*0.12);
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(d.x,d.y,rad,0,Math.PI*2);
        ctx.fillStyle = d.tcolor; ctx.fill();
      } else {
        if (_rippleFrame >= d.rippleDelay) {
          d.x += (d.tx-d.x)*0.045; d.y += (d.ty-d.y)*0.045; d.baseR += (d.tbaseR-d.baseR)*0.06;
        }
        var phaseOff = (_curScene === FAV_IDX) ? ringR*0.04 : 0;
        var wave = Math.sin(d.phase+t*d.speed*0.04-phaseOff);
        var alpha = d.minAlpha+(wave*0.5+0.5)*(d.maxAlpha-d.minAlpha);
        var rad = d.baseR*(0.88+wave*0.12);
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(d.x,d.y,rad,0,Math.PI*2);
        ctx.fillStyle = d.tcolor; ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    t++;
    requestAnimationFrame(draw);
  }
  draw();
})();
