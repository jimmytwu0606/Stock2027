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
  var ctx = canvas.getContext('2d');
  var W = 110, H = 110;

  // 5×5 grid，每顆燈獨立隨機閃爍
  var COLS = 5, ROWS = 5;
  var PAD = 12, SP = (W - PAD * 2) / (COLS - 1);
  var dots = [];
  for (var r = 0; r < ROWS; r++) {
    for (var c = 0; c < COLS; c++) {
      var x = PAD + c * SP;
      var y = PAD + r * SP;
      var dist = Math.sqrt((c - 2) * (c - 2) + (r - 2) * (r - 2));
      var color = dist < 1 ? '#ff6b6b' : dist < 2 ? '#ef5350' : dist < 3 ? '#ff7043' : '#c0392b';
      var baseR  = dist < 1 ? 8.5 : dist < 2 ? 7 : dist < 3 ? 6 : 5;
      dots.push({
        x: x, y: y, color: color, baseR: baseR,
        phase   : Math.random() * Math.PI * 2,
        speed   : 0.4 + Math.random() * 1.2,
        minAlpha: 0.08 + Math.random() * 0.12,
        maxAlpha: 0.55 + Math.random() * 0.4
      });
    }
  }

  var t = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var wave = Math.sin(d.phase + t * d.speed * 0.04);
      var alpha = d.minAlpha + (wave * 0.5 + 0.5) * (d.maxAlpha - d.minAlpha);
      var radius = d.baseR * (0.88 + wave * 0.12);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(d.x, d.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    t++;
    requestAnimationFrame(draw);
  }
  draw();
})();
