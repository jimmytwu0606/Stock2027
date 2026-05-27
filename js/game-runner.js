/**
 * game-runner.js — 燈燈跑酷
 * 需在 splash-game.js 之前載入
 *
 * 機制：
 *   - 血量 3 格，HP=0 GG
 *   - 障礙物（柱子）固定地上，隨畫面捲動，被推出左邊扣 1 血
 *   - K棒：紅K+分 / 綠K-分 / 漲停大+分 / 跌停大-分 / 補血丸清狀態+1血
 *   - 100分後每+50分速度+5%，無上限
 *   - 300分後吃到綠K/跌停 → 持續扣%（1次1%/s, 2次5%/s, 3次10%/s），補血丸清除
 *   - 二段跳
 */
(function () {
  'use strict';

  const DRAIN_RATES = [0, 0.01, 0.05, 0.10]; // 0=無, 1次=1%, 2次=5%, 3次=10%

  // 若 splash-game.js 還沒跑，先存進 _q 暫存；若已跑，直接 register
  window.__GAMES = window.__GAMES || { _q: [], register(d){ this._q.push(d); } };
  window.__GAMES.register({
    id: 'runner',
    name: '🐾 燈燈跑酷',
    hint: '空白鍵 / 點擊 跳躍　|　二段跳支援',
    canvasH: 220,

    init(canvas, ctx, api) {
      const W = 680, H = 220, GY = 168;

      /* ── 狀態 ── */
      let fr = 0, score = 0, hp = 3, jc = 0;
      let drainLevel = 0;   // 0~3，持續扣分層級
      let drainTimer = 0;   // 每60幀扣一次
      let invincible = 0;   // 吃障礙物後無敵幀
      let running = false;

      let cat = { x: 80, y: GY - 44, vy: 0 };
      let kbars = [], obstacles = [], parts = [], ftxts = [];

      /* ── 速度計算 ── */
      function calcSpd() {
        let s = 3;
        if (score >= 100) s += Math.floor((score - 100) / 50) * 0.15;
        return s;
      }

      /* ── K棒類型 ── */
      const KBAR_TYPES = [
        { id: 'rk',   pts:  15, col: '#e03030', wr: 18, hr: [28, 52], wt: 40 },
        { id: 'gk',   pts: -10, col: '#229944', wr: 18, hr: [22, 42], wt: 33 },
        { id: 'lu',   pts:  50, col: '#e03030', wr: 24, hr: [60, 78], wt: 10 },
        { id: 'ld',   pts: -40, col: '#229944', wr: 24, hr: [58, 75], wt: 10 },
        { id: 'heal', pts:   0, col: '#f5c400', wr: 20, hr: [20, 28], wt:  7 },
      ];
      const totalWt = KBAR_TYPES.reduce((a, t) => a + t.wt, 0);
      function pickKbar() {
        let r = Math.random() * totalWt;
        for (const t of KBAR_TYPES) { r -= t.wt; if (r <= 0) return t; }
        return KBAR_TYPES[0];
      }
      function spawnKbar() {
        const t = pickKbar();
        const h = t.hr[0] + Math.floor(Math.random() * (t.hr[1] - t.hr[0]));
        return {
          x: W + 20, y: GY - h, w: t.wr, h,
          id: t.id, pts: t.pts, col: t.col,
          wk: 6 + Math.floor(Math.random() * 10),
          hit: false,
        };
      }

      /* ── 障礙物（柱子/岩石）── */
      const OBS_SHAPES = [
        // 仙人掌型：高柱 + 兩側小刺
        { type: 'cactus', w: 20, h: 40 },
        { type: 'cactus', w: 20, h: 55 },
        // 岩石型：矮寬
        { type: 'rock', w: 34, h: 22 },
        { type: 'rock', w: 28, h: 30 },
      ];
      function spawnObstacle() {
        const s = OBS_SHAPES[Math.floor(Math.random() * OBS_SHAPES.length)];
        return {
          x: W + 30, y: GY - s.h,
          w: s.w, h: s.h, type: s.type,
          pushed: false,
        };
      }

      /* ── 粒子 / 浮字 ── */
      function burst(x, y, col, n = 10) {
        for (let i = 0; i < n; i++)
          parts.push({ x, y, vx: (Math.random() - .5) * 5, vy: -(Math.random() * 4 + 1), col, l: 28 });
      }
      function addFt(x, y, v, col) { ftxts.push({ x, y, v, col, life: 60 }); }

      /* ── 碰撞 ── */
      function hitKbar(o) {
        return cat.x + 38 > o.x + 2 && cat.x + 6 < o.x + o.w - 2 &&
               cat.y + 38 > o.y + 2 && cat.y + 4  < o.y + o.h;
      }
      function hitObs(o) {
        return cat.x + 36 > o.x + 2 && cat.x + 4 < o.x + o.w - 2 &&
               cat.y + 40 > o.y + 2 && cat.y + 4  < o.y + o.h;
      }

      /* ── 輸入 ── */
      function jump() {
        if (jc < 2) { cat.vy = jc === 0 ? -11 : -9; jc++; }
      }
      function onKey(e) { if (e.code === 'Space') { e.preventDefault(); jump(); } }
      canvas.addEventListener('click', jump);
      document.addEventListener('keydown', onKey);

      /* ── 傷害 & 治療 ── */
      function takeDamage(src) {
        if (invincible > 0) return;
        hp--;
        invincible = 90; // 1.5秒無敵
        api.setHp(hp);
        addFt(cat.x + 22, cat.y - 10, '💔', '#ff4444');
        burst(cat.x + 22, cat.y + 20, '#ff4444', 12);
        if (hp <= 0) die();
      }
      function heal() {
        drainLevel = 0; drainTimer = 0;
        if (hp < 3) { hp++; api.setHp(hp); }
        addFt(cat.x + 22, cat.y - 10, '❤ +1', '#f5c400');
        burst(cat.x + 22, cat.y + 20, '#f5c400', 10);
      }
      function die() {
        running = false;
        document.removeEventListener('keydown', onKey);
        canvas.removeEventListener('click', jump);
        api.endGame(score);
      }

      /* ── 繪製金吉拉 ── */
      function drawCat(x, y) {
        const run = Math.floor(fr / 7) % 4;
        const legA = [[.35,-.35,.25,-.25],[.05,-.55,.05,.45],[-.35,.35,-.25,.25],[.05,.55,.05,-.45]];
        const la = legA[run];

        // 無敵閃爍
        if (invincible > 0 && Math.floor(fr / 5) % 2 === 0) return;

        ctx.save();
        // 尾巴
        ctx.translate(x + 2, y + 22); ctx.rotate(Math.sin(fr * .25) * .3 - .5);
        ctx.fillStyle = '#a8a8c8'; ctx.beginPath(); ctx.ellipse(0,0,6,14,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ccccdf'; ctx.beginPath(); ctx.ellipse(0,-2,4,10,0,0,Math.PI*2); ctx.fill();
        ctx.restore();

        // 後腳
        ctx.strokeStyle = '#a8a8c8'; ctx.lineWidth = 4; ctx.lineCap = 'round';
        [[x+12,y+36,la[2]],[x+7,y+36,la[3]]].forEach(([px,py,a]) => {
          ctx.save(); ctx.translate(px,py); ctx.rotate(a);
          ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,11); ctx.stroke(); ctx.restore();
        });
        // 身體
        ctx.fillStyle = '#c8c8e0'; ctx.beginPath(); ctx.ellipse(x+22,y+26,20,13,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#e4e4f4'; ctx.beginPath(); ctx.ellipse(x+23,y+28,12,8,0,0,Math.PI*2); ctx.fill();
        // 前腳
        ctx.strokeStyle = '#b0b0cc';
        [[x+30,y+36,la[0]],[x+25,y+36,la[1]]].forEach(([px,py,a]) => {
          ctx.save(); ctx.translate(px,py); ctx.rotate(a);
          ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,11); ctx.stroke(); ctx.restore();
        });
        // 頭
        ctx.fillStyle = '#c8c8e0'; ctx.beginPath(); ctx.arc(x+33,y+13,14,0,Math.PI*2); ctx.fill();
        // 耳朵
        [[-.35,x+24,y+3],[.35,x+40,y+2]].forEach(([ang,ex,ey]) => {
          ctx.fillStyle='#c0c0d8'; ctx.beginPath(); ctx.ellipse(ex,ey,5,8,ang,0,Math.PI*2); ctx.fill();
          ctx.fillStyle='#f0b8c8'; ctx.beginPath(); ctx.ellipse(ex,ey,3,5,ang,0,Math.PI*2); ctx.fill();
        });
        // 眼
        ctx.fillStyle='#1a1a3a';
        ctx.beginPath(); ctx.arc(x+28,y+13,3.5,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(x+38,y+13,3.5,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#fff';
        ctx.beginPath(); ctx.arc(x+29,y+12,1.2,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(x+39,y+12,1.2,0,Math.PI*2); ctx.fill();
        // 鼻/嘴
        ctx.fillStyle='#f0a0b0'; ctx.beginPath(); ctx.arc(x+33,y+17,2,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle='#d090a0'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(x+33,y+19); ctx.quadraticCurveTo(x+30,y+22,x+28,y+20); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x+33,y+19); ctx.quadraticCurveTo(x+36,y+22,x+38,y+20); ctx.stroke();
        // 鬍鬚
        ctx.strokeStyle='rgba(210,210,230,.6)'; ctx.lineWidth=.8;
        [[x+31,y+17,x+16,y+15],[x+31,y+18,x+16,y+19],
         [x+35,y+17,x+50,y+15],[x+35,y+18,x+50,y+19]].forEach(([x1,y1,x2,y2])=>{
          ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
        });
        // 持續扣分警示光暈
        if (drainLevel > 0) {
          ctx.globalAlpha = .2 + Math.sin(fr * .2) * .15;
          ctx.fillStyle = drainLevel >= 3 ? '#ff2222' : drainLevel === 2 ? '#ff8800' : '#ffcc00';
          ctx.beginPath(); ctx.arc(x+22, y+20, 28, 0, Math.PI*2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      /* ── 繪製 K棒 ── */
      function drawKbar(o) {
        if (o.id === 'heal') {
          ctx.fillStyle = '#f5c400';
          ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 4); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
          ctx.fillText('❤', o.x + o.w/2, o.y + o.h - 4);
          return;
        }
        const mx = o.x + o.w / 2;
        ctx.fillStyle = o.col;
        ctx.fillRect(mx-1, o.y-o.wk, 2, o.wk);
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.fillRect(mx-1, o.y+o.h, 2, Math.floor(o.wk/2));
        if (o.id === 'lu' || o.id === 'ld') {
          ctx.strokeStyle = o.id==='lu' ? 'rgba(255,150,150,.8)' : 'rgba(100,255,100,.8)';
          ctx.lineWidth = 1.5; ctx.strokeRect(o.x, o.y, o.w, o.h);
          ctx.fillStyle = 'rgba(255,255,255,.95)';
          ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
          ctx.fillText(o.id==='lu'?'漲停':'跌停', mx, o.y+o.h/2+3);
        }
      }

      /* ── 繪製障礙物 ── */
      function drawObstacle(o) {
        if (o.type === 'cactus') {
          // 主幹
          ctx.fillStyle = '#2a6e2a';
          ctx.beginPath(); ctx.roundRect(o.x+6, o.y, 8, o.h, 3); ctx.fill();
          // 左刺
          ctx.beginPath(); ctx.roundRect(o.x, o.y+10, 8, 5, 2); ctx.fill();
          ctx.beginPath(); ctx.roundRect(o.x, o.y+8, 5, 12, 2); ctx.fill();
          // 右刺
          ctx.beginPath(); ctx.roundRect(o.x+12, o.y+10, 8, 5, 2); ctx.fill();
          ctx.beginPath(); ctx.roundRect(o.x+15, o.y+8, 5, 12, 2); ctx.fill();
          // 高光
          ctx.fillStyle = 'rgba(120,220,120,.25)';
          ctx.beginPath(); ctx.roundRect(o.x+8, o.y+2, 3, o.h-4, 2); ctx.fill();
        } else {
          // 岩石
          ctx.fillStyle = '#5a5a6a';
          ctx.beginPath(); ctx.roundRect(o.x, o.y+8, o.w, o.h-8, 6); ctx.fill();
          ctx.fillStyle = '#4a4a5a';
          ctx.beginPath(); ctx.roundRect(o.x+4, o.y, o.w-8, o.h, 8); ctx.fill();
          ctx.fillStyle = 'rgba(200,200,220,.15)';
          ctx.beginPath(); ctx.roundRect(o.x+6, o.y+4, 8, 6, 3); ctx.fill();
        }
      }

      /* ── 繪製血條 & 持續扣分狀態 ── */
      function drawHUD() {
        if (drainLevel > 0) {
          const pct = DRAIN_RATES[drainLevel] * 100;
          const col = drainLevel >= 3 ? '#ff2222' : drainLevel === 2 ? '#ff8800' : '#ffcc00';
          ctx.fillStyle = col;
          ctx.font = 'bold 11px monospace'; ctx.textAlign = 'right';
          ctx.globalAlpha = .9;
          ctx.fillText(`⚠ 持續扣 ${pct}%/s (x${drainLevel})`, W - 12, 18);
          ctx.globalAlpha = 1;
        }
      }

      /* ── 主循環 ── */
      function loop() {
        if (!running) return;
        fr++;
        const spd = calcSpd();
        if (invincible > 0) invincible--;

        /* 物理 */
        cat.vy += .58; cat.y += cat.vy;
        if (cat.y >= GY - 44) { cat.y = GY - 44; cat.vy = 0; jc = 0; }

        /* 生成 K棒 */
        const lastK = kbars.length ? kbars[kbars.length-1].x : 0;
        const kGap = Math.max(200 - score * .025, 100);
        if (!kbars.length || lastK < W - kGap - Math.random()*80) kbars.push(spawnKbar());

        /* 生成障礙物（每隔一段距離，分數>30後才出現）*/
        if (score > 30) {
          const lastO = obstacles.length ? obstacles[obstacles.length-1].x : -999;
          const oGap = Math.max(380 - score * .04, 180);
          if (!obstacles.length || lastO < W - oGap - Math.random()*120) obstacles.push(spawnObstacle());
        }

        /* 更新 K棒 */
        for (let i = kbars.length-1; i >= 0; i--) {
          const o = kbars[i];
          o.x -= spd;
          if (!o.hit && hitKbar(o)) {
            o.hit = true;
            if (o.id === 'heal') {
              heal();
            } else if (o.pts < 0 && score >= 300) {
              // 持續扣分模式
              drainLevel = Math.min(drainLevel + 1, 3);
              burst(o.x+o.w/2, o.y, o.col);
              addFt(o.x+o.w/2, o.y-8, `⚠ x${drainLevel}`, '#ff8800');
            } else {
              score += o.pts;
              burst(o.x+o.w/2, o.y, o.col);
              addFt(o.x+o.w/2, o.y-8, (o.pts>0?'+':'')+o.pts, o.pts>0?'#f5c400':'#ff5555');
            }
          }
          if (o.x+o.w < 0) kbars.splice(i,1);
        }

        /* 持續扣分 */
        if (drainLevel > 0 && score >= 300) {
          drainTimer++;
          if (drainTimer >= 60) {
            drainTimer = 0;
            const cut = Math.ceil(score * DRAIN_RATES[drainLevel]);
            score -= cut;
            addFt(cat.x+22, cat.y-8, `-${cut}`, '#ff8800');
          }
        }

        /* 更新障礙物 */
        for (let i = obstacles.length-1; i >= 0; i--) {
          const o = obstacles[i];
          o.x -= spd;
          // 撞到貓
          if (!o.pushed && hitObs(o)) {
            o.pushed = true;
            takeDamage('obs');
          }
          // 被推出左邊
          if (o.x + o.w < 0) obstacles.splice(i,1);
        }

        /* 分數自增 */
        score += Math.floor(spd * .18);
        api.setScore(score);
        api.setLv(Math.floor(score / 200) + 1);

        /* 粒子/浮字 */
        for (let i=parts.length-1;i>=0;i--){const p=parts[i];p.x+=p.vx;p.y+=p.vy;p.vy+=.25;p.l--;if(p.l<=0)parts.splice(i,1);}
        for (let i=ftxts.length-1;i>=0;i--){ftxts[i].y-=.8;ftxts[i].life--;if(ftxts[i].life<=0)ftxts.splice(i,1);}

        /* 死亡判定 */
        if (hp <= 0) return;

        /* ── 繪製 ── */
        ctx.fillStyle = '#0d0d1a'; ctx.fillRect(0,0,W,H);
        // 星
        ctx.fillStyle='rgba(180,180,255,.18)';
        for(let i=0;i<7;i++){ctx.fillRect(((fr*.15+i*97)%W),10+i*7,2,2);}
        // 地面
        ctx.fillStyle='#181830'; ctx.fillRect(0,GY,W,H-GY);
        ctx.fillStyle='#f5c400'; ctx.fillRect(0,GY,W,2);
        ctx.fillStyle='rgba(245,196,0,.06)';
        for(let i=0;i<10;i++){ctx.fillRect(((fr*spd*.3+i*72)%W),GY+2,44,3);}

        obstacles.forEach(drawObstacle);
        kbars.forEach(drawKbar);

        parts.forEach(p=>{ctx.globalAlpha=p.l/28;ctx.fillStyle=p.col;ctx.fillRect(p.x,p.y,3,3);});
        ctx.globalAlpha=1;
        ftxts.forEach(f=>{
          ctx.globalAlpha=Math.min(1,f.life/18);
          ctx.fillStyle=f.col;ctx.font='bold 15px monospace';ctx.textAlign='center';
          ctx.fillText(f.v,f.x,f.y);
        });
        ctx.globalAlpha=1;

        drawCat(cat.x, cat.y);
        drawHUD();

        api.raf(loop);
      }

      /* ── 開始 ── */
      api.showMsg('燈燈跑酷 🐾',
        '吃紅K加分・吃綠K扣分・漲停大加・跌停大扣・補血丸清狀態',
        [{ label:'▶ 開始', red:true, fn:()=>{ api.hideMsg(); running=true; api.raf(loop); } }]
      );
    }
  });
})();
