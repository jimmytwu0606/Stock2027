/**
 * game-thunder.js — 燈燈雷電
 * 需在 splash-game.js 之前載入
 *
 * 機制：
 *   - 血量 3 格，HP=0 GG
 *   - 100分後每+50分速度+5%，無上限
 *   - 300分後吃到綠K/跌停 → 持續扣%（1次1%/s, 2次5%/s, 3次10%/s），補血丸清除
 *   - 子彈：碰到持續扣血，補血丸清除
 *   - 補血丸：清除持續扣分 & 子彈狀態 + 回1血
 */
(function () {
  'use strict';

  const DRAIN_RATES = [0, 0.01, 0.05, 0.10];

  // 若 splash-game.js 還沒跑，先存進 _q 暫存；若已跑，直接 register
  window.__GAMES = window.__GAMES || { _q: [], register(d){ this._q.push(d); } };
  window.__GAMES.register({
    id: 'thunder',
    name: '⚡ 燈燈雷電',
    hint: '← → 鍵盤 或 滑鼠移動控制燈燈',
    canvasH: 320,

    init(canvas, ctx, api) {
      const W = 680, H = 320;

      /* ── 狀態 ── */
      let fr = 0, score = 0, hp = 3;
      let drainLevel = 0, drainTimer = 0;
      let bulletTouching = false, bulletDmgTimer = 0;
      let invincible = 0;
      let running = false;
      let mouseX = W / 2;
      const keys = {};

      let cat = { x: W/2-22, y: H-65, tx: W/2-22 };
      let items = [], bullets = [], parts = [], ftxts = [];

      /* ── 速度 ── */
      function calcSpd() {
        let s = 1.8;
        if (score >= 100) s += Math.floor((score - 100) / 50) * 0.09;
        return s;
      }

      /* ── 物品類型 ── */
      const ITYPES = [
        { id:'rk',   pts: 15, col:'#e03030', w:16, h:30, wt:38 },
        { id:'gk',   pts:-10, col:'#229944', w:16, h:25, wt:32 },
        { id:'lu',   pts: 60, col:'#e03030', w:22, h:48, wt:10 },
        { id:'ld',   pts:-50, col:'#229944', w:22, h:44, wt:10 },
        { id:'heal', pts:  0, col:'#f5c400', w:20, h:20, wt: 8 },
      ];
      const totalWt = ITYPES.reduce((a,t)=>a+t.wt,0);
      function pickItem(){let r=Math.random()*totalWt;for(const t of ITYPES){r-=t.wt;if(r<=0)return t;}return ITYPES[0];}
      function spawnItem(){
        const t=pickItem();
        return {x:20+Math.random()*(W-40),y:-20,w:t.w,h:t.h,
                id:t.id,pts:t.pts,col:t.col,
                spd:calcSpd()+Math.random()*1.2,
                hit:false,wobble:Math.random()*Math.PI*2};
      }
      function spawnBullet(){
        return {x:20+Math.random()*(W-40),y:-10,w:6,h:20,
                spd:calcSpd()*1.2+Math.random()*.8,touching:false};
      }

      /* ── 粒子/浮字 ── */
      function burst(x,y,col,n=10){for(let i=0;i<n;i++)parts.push({x,y,vx:(Math.random()-.5)*5,vy:-(Math.random()*3+.5),col,l:30});}
      function addFt(x,y,v,col){ftxts.push({x,y,v,col,life:60});}

      /* ── 碰撞 ── */
      function boxHit(ax,ay,aw,ah,bx,by,bw,bh){return ax+aw>bx&&ax<bx+bw&&ay+ah>by&&ay<by+bh;}

      /* ── 輸入 ── */
      function onMouse(e){const r=canvas.getBoundingClientRect();mouseX=(e.clientX-r.left)*(W/r.width);}
      function onKey(e){keys[e.code]=true;}
      function onKeyUp(e){keys[e.code]=false;}
      canvas.addEventListener('mousemove',onMouse);
      document.addEventListener('keydown',onKey);
      document.addEventListener('keyup',onKeyUp);

      /* ── 傷害 & 治療 ── */
      function takeDamage(){
        if(invincible>0)return;
        hp--; invincible=90;
        api.setHp(hp);
        addFt(cat.x+22,cat.y,'💔','#ff4444');
        burst(cat.x+22,cat.y+22,'#ff4444',12);
        if(hp<=0)die();
      }
      function heal(){
        drainLevel=0; drainTimer=0;
        bulletTouching=false; bulletDmgTimer=0;
        if(hp<3){hp++;api.setHp(hp);}
        addFt(cat.x+22,cat.y-10,'❤ +1','#f5c400');
        burst(cat.x+22,cat.y+22,'#f5c400',10);
      }
      function die(){
        running=false;
        canvas.removeEventListener('mousemove',onMouse);
        document.removeEventListener('keydown',onKey);
        document.removeEventListener('keyup',onKeyUp);
        api.endGame(score);
      }

      /* ── 繪製金吉拉（垂直飛行版）── */
      function drawCat(x,y){
        if(invincible>0&&Math.floor(fr/5)%2===0)return;
        const bob=Math.sin(fr*.12)*3;
        const tilt=(cat.tx-cat.x)*.015;
        ctx.save();ctx.translate(x+22,y+22+bob);ctx.rotate(tilt);
        // 耳
        [[-10,-16,-.3],[10,-16,.3]].forEach(([ex,ey,ang])=>{
          ctx.fillStyle='#c0c0d8';ctx.beginPath();ctx.ellipse(ex,ey,5,8,ang,0,Math.PI*2);ctx.fill();
          ctx.fillStyle='#f0b8c8';ctx.beginPath();ctx.ellipse(ex,ey,3,5,ang,0,Math.PI*2);ctx.fill();
        });
        // 頭
        ctx.fillStyle='#c8c8e0';ctx.beginPath();ctx.arc(0,-6,14,0,Math.PI*2);ctx.fill();
        // 身體
        ctx.fillStyle='#c8c8e0';ctx.beginPath();ctx.ellipse(0,10,12,16,0,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#e4e4f4';ctx.beginPath();ctx.ellipse(0,12,7,10,0,0,Math.PI*2);ctx.fill();
        // 眼
        ctx.fillStyle='#1a1a3a';
        ctx.beginPath();ctx.arc(-5,-7,3.5,0,Math.PI*2);ctx.fill();
        ctx.beginPath();ctx.arc(5,-7,3.5,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#fff';
        ctx.beginPath();ctx.arc(-4,-8,1.2,0,Math.PI*2);ctx.fill();
        ctx.beginPath();ctx.arc(6,-8,1.2,0,Math.PI*2);ctx.fill();
        // 鼻/嘴/鬍鬚
        ctx.fillStyle='#f0a0b0';ctx.beginPath();ctx.arc(0,-2,2,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle='#d090a0';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(-3,3,-5,1);ctx.stroke();
        ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(3,3,5,1);ctx.stroke();
        ctx.strokeStyle='rgba(210,210,230,.6)';ctx.lineWidth=.8;
        [[-2,-2,-16,-4],[-2,-1,-16,1],[2,-2,16,-4],[2,-1,16,1]].forEach(([x1,y1,x2,y2])=>{
          ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
        });
        // 尾巴
        ctx.fillStyle='#a8a8c8';ctx.beginPath();ctx.ellipse(0,26,5,10,Math.sin(fr*.15)*.3,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#ccccdf';ctx.beginPath();ctx.ellipse(0,24,3,7,Math.sin(fr*.15)*.3,0,Math.PI*2);ctx.fill();
        // 推進器
        const ta=.5+Math.sin(fr*.3)*.3;ctx.globalAlpha=ta;ctx.fillStyle='#88ccff';
        ctx.beginPath();ctx.ellipse(-6,26,4,6+Math.sin(fr*.4)*2,0,0,Math.PI*2);ctx.fill();
        ctx.beginPath();ctx.ellipse(6,26,4,6+Math.sin(fr*.4+1)*2,0,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#fff';
        ctx.beginPath();ctx.ellipse(-6,24,2,3,0,0,Math.PI*2);ctx.fill();
        ctx.beginPath();ctx.ellipse(6,24,2,3,0,0,Math.PI*2);ctx.fill();
        ctx.globalAlpha=1;
        // 持續扣分光暈
        if(drainLevel>0){
          ctx.globalAlpha=.2+Math.sin(fr*.2)*.15;
          ctx.fillStyle=drainLevel>=3?'#ff2222':drainLevel===2?'#ff8800':'#ffcc00';
          ctx.beginPath();ctx.arc(0,6,28,0,Math.PI*2);ctx.fill();
          ctx.globalAlpha=1;
        }
        // 子彈接觸閃爍
        if(bulletTouching&&fr%6<3){
          ctx.globalAlpha=.35;ctx.fillStyle='#4488ff';
          ctx.beginPath();ctx.arc(0,6,24,0,Math.PI*2);ctx.fill();
          ctx.globalAlpha=1;
        }
        ctx.restore();
      }

      function drawItem(o){
        if(o.id==='heal'){
          ctx.fillStyle='#f5c400';
          ctx.beginPath();ctx.roundRect(o.x-10,o.y,20,20,4);ctx.fill();
          ctx.fillStyle='#fff';ctx.font='bold 13px monospace';ctx.textAlign='center';
          ctx.fillText('❤',o.x,o.y+15);return;
        }
        const mx=o.x,wk=8+Math.sin(o.wobble)*2;
        ctx.fillStyle=o.col;
        ctx.fillRect(mx-1,o.y-wk,2,wk);
        ctx.fillRect(mx-o.w/2,o.y,o.w,o.h);
        ctx.fillRect(mx-1,o.y+o.h,2,wk/2);
        if(o.id==='lu'||o.id==='ld'){
          ctx.strokeStyle=o.id==='lu'?'rgba(255,150,150,.8)':'rgba(100,255,100,.8)';
          ctx.lineWidth=1.5;ctx.strokeRect(mx-o.w/2,o.y,o.w,o.h);
          ctx.fillStyle='rgba(255,255,255,.95)';
          ctx.font='bold 7px monospace';ctx.textAlign='center';
          ctx.fillText(o.id==='lu'?'漲停':'跌停',mx,o.y+o.h/2+3);
        }
      }

      function drawBullet(b){
        const pulse=.7+Math.sin(fr*.4)*.3;
        ctx.globalAlpha=pulse;
        ctx.fillStyle='#4488ff';ctx.beginPath();ctx.roundRect(b.x-3,b.y,6,20,3);ctx.fill();
        ctx.fillStyle='#aaccff';ctx.beginPath();ctx.roundRect(b.x-1.5,b.y+2,3,9,2);ctx.fill();
        ctx.globalAlpha=1;
        if(b.touching){ctx.globalAlpha=.25;ctx.fillStyle='#4488ff';ctx.beginPath();ctx.arc(b.x,b.y+10,14,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;}
      }

      function drawHUD(){
        ctx.textAlign='right';
        if(drainLevel>0){
          const col=drainLevel>=3?'#ff2222':drainLevel===2?'#ff8800':'#ffcc00';
          ctx.fillStyle=col;ctx.font='bold 11px monospace';ctx.globalAlpha=.9;
          ctx.fillText(`⚠ 持續扣 ${DRAIN_RATES[drainLevel]*100}%/s (x${drainLevel})`,W-12,20);
          ctx.globalAlpha=1;
        }
        if(bulletTouching){
          ctx.fillStyle='#4488ff';ctx.font='bold 11px monospace';ctx.globalAlpha=.9;
          ctx.fillText('💙 子彈扣血中！',W-12,36);
          ctx.globalAlpha=1;
        }
      }

      /* ── 主循環 ── */
      function loop(){
        if(!running)return;
        fr++;
        const spd=calcSpd();
        if(invincible>0)invincible--;

        /* 移動 */
        cat.tx=mouseX-22;
        if(keys['ArrowLeft']||keys['KeyA'])cat.tx-=6;
        if(keys['ArrowRight']||keys['KeyD'])cat.tx+=6;
        cat.tx=Math.max(10,Math.min(W-54,cat.tx));
        cat.x+=(cat.tx-cat.x)*.18;

        /* 生成 */
        const iRate=Math.max(50-Math.floor(score/100)*3,20);
        if(fr%iRate===0)items.push(spawnItem());
        const bRate=Math.max(85-Math.floor(score/100)*5,28);
        if(fr%bRate===0)bullets.push(spawnBullet());

        /* 更新物品 */
        for(let i=items.length-1;i>=0;i--){
          const o=items[i];o.y+=o.spd;o.wobble+=.05;
          if(!o.hit&&boxHit(cat.x,cat.y,44,44,o.x-o.w/2,o.y,o.w,o.h)){
            o.hit=true;
            if(o.id==='heal'){
              heal();
            } else if(o.id==='ld'){
              // 跌停：直接扣一命 + 固定扣分 + 300分後疊加持續扣%
              takeDamage();
              score+=o.pts;
              burst(o.x,o.y,o.col,14);
              addFt(o.x,o.y-10,'💔 跌停！','#ff2222');
              if(score>=300){
                drainLevel=Math.min(drainLevel+1,3);
                addFt(o.x,o.y-28,`⚠ x${drainLevel}`,'#ff8800');
              }
            } else if(o.pts<0&&score>=300){
              // 綠K 300分後持續扣%
              drainLevel=Math.min(drainLevel+1,3);
              burst(o.x,o.y,o.col);
              addFt(o.x,o.y-10,`⚠ x${drainLevel}`,'#ff8800');
            } else {
              score+=o.pts;
              burst(o.x,o.y,o.col);
              addFt(o.x,o.y-10,(o.pts>0?'+':'')+o.pts,o.pts>0?'#f5c400':'#ff5555');
            }
          }
          if(o.y>H+30||o.hit)items.splice(i,1);
        }

        /* 持續扣分 */
        if(drainLevel>0&&score>=300){
          drainTimer++;
          if(drainTimer>=60){
            drainTimer=0;
            const cut=Math.ceil(score*DRAIN_RATES[drainLevel]);
            score-=cut;
            addFt(cat.x+22,cat.y,`-${cut}`,'#ff8800');
          }
        }

        /* 更新子彈 */
        bulletTouching=false;
        for(let i=bullets.length-1;i>=0;i--){
          const b=bullets[i];b.y+=b.spd;
          b.touching=boxHit(cat.x+4,cat.y+4,36,36,b.x-3,b.y,6,20);
          if(b.touching)bulletTouching=true;
          if(b.y>H+20)bullets.splice(i,1);
        }
        /* 子彈持續扣血：每90幀（1.5秒）扣1血 */
        if(bulletTouching){
          bulletDmgTimer++;
          if(bulletDmgTimer>=90){bulletDmgTimer=0;takeDamage();}
        } else {
          bulletDmgTimer=0;
        }

        /* 分數自增 */
        score+=Math.floor(spd*.12);
        api.setScore(score);
        api.setLv(Math.floor(score/200)+1);

        /* 粒子/浮字 */
        for(let i=parts.length-1;i>=0;i--){const p=parts[i];p.x+=p.vx;p.y+=p.vy;p.vy+=.2;p.l--;if(p.l<=0)parts.splice(i,1);}
        for(let i=ftxts.length-1;i>=0;i--){ftxts[i].y-=.9;ftxts[i].life--;if(ftxts[i].life<=0)ftxts.splice(i,1);}

        if(hp<=0)return;

        /* ── 繪製 ── */
        ctx.fillStyle='#0a0a18';ctx.fillRect(0,0,W,H);
        ctx.fillStyle='rgba(160,160,255,.2)';
        for(let i=0;i<10;i++){const sx=((fr*.1+i*67)%W),sy=((i*53+fr*.05)%H);ctx.fillRect(sx,sy,2,2);}
        if(fr%120<40){
          const t=(fr%120)/40;
          ctx.strokeStyle='rgba(200,200,255,.3)';ctx.lineWidth=1;
          ctx.beginPath();ctx.moveTo(100+t*200,20+t*60);ctx.lineTo(100+t*200-30,20+t*60-10);ctx.stroke();
        }
        items.forEach(drawItem);
        bullets.forEach(drawBullet);
        parts.forEach(p=>{ctx.globalAlpha=p.l/30;ctx.fillStyle=p.col;ctx.fillRect(p.x,p.y,3,3);});
        ctx.globalAlpha=1;
        ftxts.forEach(f=>{ctx.globalAlpha=Math.min(1,f.life/18);ctx.fillStyle=f.col;ctx.font='bold 15px monospace';ctx.textAlign='center';ctx.fillText(f.v,f.x,f.y);});
        ctx.globalAlpha=1;
        drawCat(cat.x,cat.y);
        drawHUD();

        api.raf(loop);
      }

      api.showMsg('燈燈雷電 ⚡',
        '滑鼠移動或左右鍵・吃紅K加分・碰子彈扣血・補血丸清狀態',
        [{label:'▶ 開始',red:true,fn:()=>{api.hideMsg();running=true;api.raf(loop);}}]
      );
    }
  });
})();
