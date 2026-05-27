/**
 * game-bigTwo.js — 燈燈大老二
 * 需在 splash-game.js 之前載入
 *
 * 規則：
 *   - 4人桌（1玩家 + 3AI）
 *   - 梅花3先出
 *   - 牌型：單張/對子/三條/順子/同花/葫蘆/鐵支(四條+1)/同花順
 *   - 鐵支可壓除同花順外所有牌
 *   - 葫蘆只能壓葫蘆
 *   - 同花順最大，23456花色最大，A2345最小
 *   - 一圈全Pass → 出牌者可任意出新牌
 *   - 結算：剩餘手牌計算罰金，贏家按60/30/10%分配
 *   - IndexedDB 存取籌碼
 */
(function () {
  'use strict';

  /* ══════════════════════════════════════
     一、常數
  ══════════════════════════════════════ */
  const SUITS = ['♣','♦','♥','♠']; // 0梅花(小)~3黑桃(大)
  const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2']; // 0最小~12最大
  const RANK_VAL = {}; RANKS.forEach((r,i)=>RANK_VAL[r]=i);
  const SUIT_VAL = {}; SUITS.forEach((s,i)=>SUIT_VAL[s]=i);

  const PLAYERS = ['玩家','小明AI','阿財AI','老K AI'];
  const AI_NAMES = [1,2,3];
  const PAYOUT = [0.6,0.3,0.1]; // 第1,2,3名分配比例

  /* ══════════════════════════════════════
     二、牌組工具
  ══════════════════════════════════════ */
  function makeDeck(){
    const d=[];
    for(const s of SUITS) for(const r of RANKS) d.push({s,r,v:RANK_VAL[r],sv:SUIT_VAL[s]});
    return d;
  }
  function shuffle(arr){
    for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
    return arr;
  }
  function cardId(c){return c.r+c.s;}
  function cardScore(c){
    let base=5;
    if(c.r==='2')base*=2;
    if(c.r==='A')base*=2;
    if(['J','Q','K'].includes(c.r))base*=2;
    return base;
  }
  function handPenalty(hand){
    let base=hand.length*5;
    if(hand.length>=10)base*=2;
    for(const c of hand){
      if(c.r==='2')base*=2;
      if(c.r==='A')base*=2;
      if(['J','Q','K'].includes(c.r))base*=2;
    }
    return base;
  }

  /* ══════════════════════════════════════
     三、牌型判斷
  ══════════════════════════════════════ */
  function classify(cards){
    const n=cards.length;
    if(n===0)return null;
    const sorted=[...cards].sort((a,b)=>a.v!==b.v?a.v-b.v:a.sv-b.sv);

    if(n===1)return{type:'single',cards:sorted,key:sorted[0].v*4+sorted[0].sv};
    if(n===2){
      if(sorted[0].v===sorted[1].v)return{type:'pair',cards:sorted,key:sorted[1].v*4+sorted[1].sv};
      return null;
    }
    if(n===3){
      if(sorted[0].v===sorted[1].v&&sorted[1].v===sorted[2].v)
        return{type:'triple',cards:sorted,key:sorted[2].v*4+sorted[2].sv};
      return null;
    }
    if(n===5){
      // 同花？
      const flush=sorted.every(c=>c.s===sorted[0].s);
      // 順子？（含 A2345 和一般順）
      const straight=isStraight(sorted);
      if(flush&&straight){
        const sk=straightKey(sorted);
        return{type:'straightFlush',cards:sorted,key:sk*4+SUIT_VAL[sorted[0].s]};
      }
      if(straight){
        return{type:'straight',cards:sorted,key:straightKey(sorted)*4+sorted[4].sv};
      }
      if(flush){
        return{type:'flush',cards:sorted,key:sorted[4].v*100+sorted[4].sv};
      }
      // 鐵支
      const fourKind=findFour(sorted);
      if(fourKind!==null){
        const kicker=sorted.find(c=>c.v!==fourKind);
        return{type:'fourOfAKind',cards:sorted,key:fourKind*4+sorted[sorted.length-1].sv,fourVal:fourKind};
      }
      // 葫蘆
      const full=findFullHouse(sorted);
      if(full!==null){
        return{type:'fullHouse',cards:sorted,key:full*100};
      }
      return null;
    }
    return null;
  }

  /*
   * 順子大小（key 值）：
   *   A2345 = -1  (最小)
   *   34567 = 4   (3的val=0, 最大牌6的val=3)
   *   ...
   *   10JQKA = 11 (A的val=11)
   *   23456  = 14 (最大順，特殊key)
   *
   * RANKS index: 3=0,4=1,5=2,6=3,7=4,8=5,9=6,10=7,J=8,Q=9,K=10,A=11,2=12
   * 所以 sorted by val:
   *   一般順(34567~10JQKA): vals連續
   *   A2345: 3,4,5,A,2 → vals=[0,1,2,11,12]  → 特殊判斷
   *   23456: 3,4,5,6,2 → vals=[0,1,2,3,12]   → 特殊判斷
   */
  function isStraight(sorted){
    const vals=sorted.map(c=>c.v);
    const ranks=sorted.map(c=>c.r);
    // 一般連續順
    const normal=vals.every((v,i)=>i===0||v===vals[i-1]+1);
    if(normal)return true;
    // 23456: vals=[0,1,2,3,12], ranks含'2'含'6'不含'A'
    if(vals[4]===12&&vals[3]===3&&vals[2]===2&&vals[1]===1&&vals[0]===0&&ranks.includes('2')&&ranks.includes('6'))return true;
    // A2345: vals=[0,1,2,11,12], ranks含'A'含'2'含'3'
    if(vals[4]===12&&vals[3]===11&&vals[2]===2&&vals[1]===1&&vals[0]===0&&ranks.includes('A')&&ranks.includes('2')&&ranks.includes('3'))return true;
    return false;
  }

  function straightKey(sorted){
    const vals=sorted.map(c=>c.v);
    const ranks=sorted.map(c=>c.r);
    // 23456 最大
    if(vals[4]===12&&ranks.includes('2')&&ranks.includes('6'))return 14;
    // A2345 最小
    if(vals[4]===12&&ranks.includes('A')&&ranks.includes('2')&&ranks.includes('3'))return -1;
    // 一般順：以最大牌val為key（10JQKA→vals[4]=11, 34567→vals[4]=3）
    return vals[4];
  }

  function findFour(sorted){
    const cnt={};
    for(const c of sorted){cnt[c.v]=(cnt[c.v]||0)+1;}
    for(const [v,c] of Object.entries(cnt)){if(c===4)return Number(v);}
    return null;
  }
  function findFullHouse(sorted){
    const cnt={};
    for(const c of sorted){cnt[c.v]=(cnt[c.v]||0)+1;}
    const vals=Object.values(cnt);
    if(vals.includes(3)&&vals.includes(2)){
      return Number(Object.entries(cnt).find(([,c])=>c===3)[0]);
    }
    return null;
  }

  /* 比較兩個牌型大小，回傳 >0 表示 a > b */
  const TYPE_ORDER={single:0,pair:1,triple:2,straight:3,flush:4,fullHouse:5,fourOfAKind:6,straightFlush:7};

  function canBeat(played, attempt){
    if(!played)return true; // 任意出
    if(!attempt)return false;
    const pn=played.cards.length, an=attempt.cards.length;
    // 張數不同（五張牌型之間互比，其他不可壓）
    if(pn!==an){
      if(pn===5&&an===5){}
      else if(pn===1&&an===5&&attempt.type==='fourOfAKind'){}
      else if(pn===2&&an===5&&attempt.type==='fourOfAKind'){}
      else if(pn===3&&an===5&&attempt.type==='fourOfAKind'){}
      else return false;
    }
    // 同張數：同牌型才能壓（除鐵支/同花順特例）
    if(attempt.type==='straightFlush'){
      if(played.type==='straightFlush')return attempt.key>played.key;
      return true; // 同花順壓一切
    }
    if(attempt.type==='fourOfAKind'){
      if(played.type==='straightFlush')return false;
      if(played.type==='fourOfAKind')return attempt.key>played.key;
      return true; // 鐵支壓除同花順外所有
    }
    if(played.type==='fourOfAKind'||played.type==='straightFlush')return false;
    if(attempt.type!==played.type)return false;
    // 葫蘆只能壓葫蘆
    if(attempt.type==='fullHouse'&&played.type==='fullHouse')return attempt.key>played.key;
    return attempt.key>played.key;
  }

  /* ══════════════════════════════════════
     四、AI 策略
  ══════════════════════════════════════ */
  function aiPlay(hand, played, mustHaveClub3, targetIdx, selfIdx){
    // mustHaveClub3: 必須帶梅花3
    // 找所有合法出牌組合（簡化：列舉1,2,3,5張組合）
    const combos=[];

    function addIfValid(cards){
      const cl=classify(cards);
      if(!cl)return;
      if(mustHaveClub3&&!cards.some(c=>c.r==='3'&&c.s==='♣'))return;
      if(canBeat(played,cl))combos.push({cards,cl});
    }

    // 單張
    for(const c of hand)addIfValid([c]);
    // 對子
    for(let i=0;i<hand.length;i++)for(let j=i+1;j<hand.length;j++)
      if(hand[i].v===hand[j].v)addIfValid([hand[i],hand[j]]);
    // 三條
    for(let i=0;i<hand.length;i++)for(let j=i+1;j<hand.length;j++)for(let k=j+1;k<hand.length;k++)
      if(hand[i].v===hand[j].v&&hand[j].v===hand[k].v)addIfValid([hand[i],hand[j],hand[k]]);
    // 五張組合
    for(let i=0;i<hand.length-4;i++)
      for(let j=i+1;j<hand.length-3;j++)
        for(let k=j+1;k<hand.length-2;k++)
          for(let l=k+1;l<hand.length-1;l++)
            for(let m=l+1;m<hand.length;m++)
              addIfValid([hand[i],hand[j],hand[k],hand[l],hand[m]]);

    if(combos.length===0)return null; // PASS

    // 策略：
    // 1. 優先出最小的合法牌
    // 2. 若有針對目標：偶爾出稍大的牌壓制
    combos.sort((a,b)=>a.cl.key-b.cl.key);

    // 針對目標時，30%機率出最大牌
    if(targetIdx!==null&&Math.random()<0.3){
      return combos[combos.length-1];
    }
    // 快出完時出大牌
    if(hand.length<=4)return combos[combos.length-1];
    // 一般出最小合法牌
    return combos[0];
  }

  /* ══════════════════════════════════════
     五、IndexedDB 籌碼存取
  ══════════════════════════════════════ */
  const DB_NAME='stockDashboard', DB_STORE='settings', CHIP_KEY='bigtwo_chips';
  function loadChips(cb){
    try{
      const req=indexedDB.open(DB_NAME);
      req.onsuccess=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains(DB_STORE)){cb(1000);return;}
        const tx=db.transaction(DB_STORE,'readonly');
        const r=tx.objectStore(DB_STORE).get(CHIP_KEY);
        r.onsuccess=()=>cb(r.result?.value??1000);
        r.onerror=()=>cb(1000);
      };
      req.onerror=()=>cb(1000);
    }catch(e){cb(1000);}
  }
  function saveChips(val){
    try{
      const req=indexedDB.open(DB_NAME);
      req.onsuccess=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains(DB_STORE))return;
        const tx=db.transaction(DB_STORE,'readwrite');
        tx.objectStore(DB_STORE).put({key:CHIP_KEY,value:val});
      };
    }catch(e){}
  }

  /* ══════════════════════════════════════
     六、遊戲主體
  ══════════════════════════════════════ */
  window.__GAMES = window.__GAMES || { _q: [], register(d){ this._q.push(d); } };
  window.__GAMES.register({
    id: 'bigTwo',
    name: '🃏 燈燈大老二',
    hint: '點選手牌選牌，按出牌確認；Pass跳過',
    canvasH: 480,

    init(canvas, ctx, api){
      const W=680, H=480;

      /* ── 遊戲狀態 ── */
      let chips=[1000,1000,1000,1000]; // 0=玩家
      let hands=[[],[],[],[]];
      let finished=[]; // 出完牌的順序 [playerIdx,...]
      let currentPlayer=0;
      let played=null; // 當前桌面牌型
      let playedBy=-1;
      let passCount=0;
      let selectedCards=[];
      let gamePhase='loading'; // loading/playing/result
      let targetPlayer=null; // AI針對目標
      let targetTimer=0;
      let msgLog=[]; // 遊戲訊息
      let aiThinkTimer=0;
      let aiThinkDelay=60; // AI思考延遲幀數
      let mustFirst=true; // 第一輪必須梅花3
      let animCards=[]; // 出牌動畫
      let fr=0;
      let running=false;

      /* ── 載入籌碼 ── */
      loadChips(v=>{
        chips[0]=v;
        api.setScore(chips[0]);
        startRound();
      });

      function startRound(){
        const deck=shuffle(makeDeck());
        hands=[[],[],[],[]];
        for(let i=0;i<52;i++)hands[i%4].push(deck[i]);
        hands.forEach(h=>h.sort((a,b)=>a.v!==b.v?a.v-b.v:a.sv-b.sv));
        finished=[];
        played=null; playedBy=-1; passCount=0;
        selectedCards=[];
        mustFirst=true;
        gamePhase='playing';
        msgLog=[];
        // 梅花3的人先出
        currentPlayer=hands.findIndex(h=>h.some(c=>c.r==='3'&&c.s==='♣'));
        // 隨機設定AI針對目標（每局換）
        targetPlayer=Math.floor(Math.random()*4);
        targetTimer=0;
        addLog(`${PLAYERS[currentPlayer]} 先出（持有梅花3）`);
        if(currentPlayer!==0)scheduleAI();
      }

      function addLog(msg){
        msgLog.unshift(msg);
        if(msgLog.length>6)msgLog.pop();
      }

      /* ── 出牌 ── */
      function playCards(pidx, cards){
        const cl=classify(cards);
        if(!cl){addLog('❌ 無效牌型');return false;}
        if(mustFirst&&!cards.some(c=>c.r==='3'&&c.s==='♣')){addLog('❌ 必須帶梅花3');return false;}
        if(!canBeat(played,cl)){addLog('❌ 牌不夠大');return false;}

        // 從手牌移除
        const ids=cards.map(cardId);
        hands[pidx]=hands[pidx].filter(c=>!ids.includes(cardId(c)));
        played=cl; playedBy=pidx; passCount=0; mustFirst=false;

        // 動畫
        animCards=cards.map((c,i)=>({card:c,x:W/2-cards.length*35/2+i*35,y:H/2-40,alpha:1,vy:-2}));
        addLog(`${PLAYERS[pidx]} 出 ${cards.map(c=>c.r+c.s).join(' ')} [${cl.type}]`);

        // 出完牌
        if(hands[pidx].length===0){
          finished.push(pidx);
          addLog(`🎉 ${PLAYERS[pidx]} 第${finished.length}名！`);
          if(finished.length===3){
            // 找最後一名
            const last=[0,1,2,3].find(i=>!finished.includes(i));
            finished.push(last);
            endRound();
            return true;
          }
        }
        nextPlayer();
        return true;
      }

      function pass(pidx){
        if(played===null){addLog('❌ 不能Pass，請出牌');return;}
        if(playedBy===pidx){addLog('❌ 你出的牌，不能Pass');return;}
        passCount++;
        addLog(`${PLAYERS[pidx]} Pass`);
        // 一圈都pass
        if(passCount>=3){
          played=null; playedBy=-1; passCount=0;
          addLog(`🔄 一圈Pass，${PLAYERS[pidx===3?0:pidx+1]} 可任意出牌`);
        }
        nextPlayer();
      }

      function nextPlayer(){
        let next=(currentPlayer+1)%4;
        let count=0;
        while(finished.includes(next)&&count<4){next=(next+1)%4;count++;}
        currentPlayer=next;
        if(currentPlayer!==0)scheduleAI();
      }

      function scheduleAI(){aiThinkTimer=aiThinkDelay+Math.floor(Math.random()*40);}

      /* ── 結算 ── */
      function endRound(){
        gamePhase='result';
        running=false;
        // 計算每個輸家罰金
        const penalties=[0,0,0,0];
        for(let i=1;i<4;i++){
          const loserIdx=finished[i];
          penalties[loserIdx]=handPenalty(hands[loserIdx]);
        }
        const totalPenalty=penalties.reduce((a,b)=>a+b,0);
        // 分配給贏家
        for(let rank=0;rank<3;rank++){
          const winnerIdx=finished[rank];
          const share=Math.round(totalPenalty*PAYOUT[rank]);
          chips[winnerIdx]=Math.max(0,chips[winnerIdx]+share);
        }
        for(let i=1;i<4;i++){
          const loserIdx=finished[i];
          chips[loserIdx]=Math.max(0,chips[loserIdx]-penalties[loserIdx]);
        }
        saveChips(chips[0]);
        api.setScore(chips[0]);

        // 結算訊息
        let resultLines=finished.map((pidx,rank)=>{
          const p=penalties[pidx]?`-${penalties[pidx]}`:`+${Math.round(totalPenalty*PAYOUT[rank])}`;
          return `${rank+1}. ${PLAYERS[pidx]} ${p}元 → ${chips[pidx]}元`;
        }).join('\n');

        // 破產判斷
        const broke=chips.findIndex((c,i)=>c<=0&&i===0);
        if(broke>=0){
          api.showMsg('破產了 😭',`籌碼歸零！\n${resultLines}\n\n要繼續嗎？`,[
            {label:'重新開始(1000元)',red:true,fn:()=>{chips[0]=1000;saveChips(1000);api.hideMsg();startNewGame();}},
            {label:'看盤去',fn:()=>{window.__closeGame();window.__hideSplash&&window.__hideSplash();}},
          ]);
        } else {
          api.showMsg('本局結算',resultLines,[
            {label:'▶ 下一局',red:true,fn:()=>{api.hideMsg();startNewGame();}},
            {label:'看盤去',fn:()=>{window.__closeGame();window.__hideSplash&&window.__hideSplash();}},
          ]);
        }
      }

      function startNewGame(){
        gamePhase='loading';
        // 破產AI補新人
        for(let i=1;i<4;i++){if(chips[i]<=0)chips[i]=1000;}
        running=true;
        startRound();
      }

      /* ── 玩家點牌 ── */
      canvas.addEventListener('click',e=>{
        if(gamePhase!=='playing')return;
        if(currentPlayer!==0)return;
        const r=canvas.getBoundingClientRect();
        const mx=(e.clientX-r.left)*(W/r.width);
        const my=(e.clientY-r.top)*(H/r.height);
        // 出牌按鈕（對齊新版 drawButtons: W/2-92, H-56, 84x38）
        if(mx>W/2-92&&mx<W/2-8&&my>H-56&&my<H-18){
          if(selectedCards.length===0){addLog('❌ 請先選牌');return;}
          playCards(0,selectedCards);
          selectedCards=[];
          return;
        }
        // Pass按鈕
        if(mx>W/2+8&&mx<W/2+92&&my>H-56&&my<H-18){
          pass(0); selectedCards=[];return;
        }
        // 取消選牌按鈕（右下角）
        if(mx>W-80&&mx<W-8&&my>H-56&&my<H-18){
          selectedCards=[];
          addLog('↩ 取消選牌');return;
        }
        // 點選手牌（對齊新版 drawHand bottom: maxSpread=n*30, y=H-138, cw=46, ch=68）
        const hand=hands[0];
        const cw=46,ch=68;
        const maxSpread=Math.min(hand.length*30,W-80);
        const step=hand.length>1?maxSpread/(hand.length-1):0;
        const startX=(W-maxSpread)/2;
        for(let i=hand.length-1;i>=0;i--){
          const cx=hand.length===1?W/2-cw/2:startX+i*step;
          const isSel=selectedCards.some(sc=>cardId(sc)===cardId(hand[i]));
          const cy=H-138-(isSel?16:0);
          if(mx>=cx&&mx<=cx+cw&&my>=cy&&my<=cy+ch){
            const idx=selectedCards.findIndex(sc=>cardId(sc)===cardId(hand[i]));
            if(idx>=0){
              selectedCards.splice(idx,1); // 再點一次 → 取消選取
            } else {
              selectedCards.push(hand[i]);
            }
            return;
          }
        }
      });

      /* ── 繪製 ── */
      /* ══ 牌面常數 ══ */
      const SUIT_COLOR={'♠':'#1a1a2e','♣':'#1a2e1a','♥':'#8b0000','♦':'#8b0000'};
      const SUIT_LIGHT={'♠':'#4a4a7a','♣':'#2a6a2a','♥':'#cc4444','♦':'#cc4444'};
      const TYPE_ZH={single:'單張',pair:'對子',triple:'三條',straight:'順子',
        flush:'同花',fullHouse:'葫蘆',fourOfAKind:'鐵支',straightFlush:'同花順'};

      /* ── 精緻卡片 ── */
      function drawCard(x,y,card,selected,faceUp=true,rotate=0){
        const w=46,h=68,r=6;
        ctx.save();
        if(rotate){ctx.translate(x+w/2,y+h/2);ctx.rotate(rotate);ctx.translate(-w/2,-h/2);x=0;y=0;}
        // 選取光暈
        if(selected){
          ctx.shadowColor='#f5c400';ctx.shadowBlur=16;
        }
        if(faceUp){
          // 卡片底色：米白帶紋理感
          const bg=ctx.createLinearGradient(x,y,x+w,y+h);
          bg.addColorStop(0,'#fefefe');bg.addColorStop(1,'#f0ede8');
          ctx.fillStyle=bg;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
          ctx.shadowBlur=0;
          // 外框
          ctx.strokeStyle=selected?'#f5c400':'rgba(0,0,0,.25)';
          ctx.lineWidth=selected?2:1;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.stroke();
          // 花色顏色
          const isRed=card.s==='♥'||card.s==='♦';
          const col=isRed?'#cc2222':'#111122';
          // 左上角 rank
          ctx.fillStyle=col;
          ctx.font='bold 13px -apple-system,sans-serif';
          ctx.textAlign='left';
          ctx.fillText(card.r,x+4,y+15);
          // 左上花色
          ctx.font='11px sans-serif';
          ctx.fillText(card.s,x+4,y+27);
          // 中央大花色
          ctx.font=`bold ${w>40?28:22}px sans-serif`;
          ctx.textAlign='center';
          ctx.fillText(card.s,x+w/2,y+h/2+10);
          // 右下角（倒置）
          ctx.save();
          ctx.translate(x+w,y+h);ctx.rotate(Math.PI);
          ctx.fillStyle=col;
          ctx.font='bold 13px -apple-system,sans-serif';
          ctx.textAlign='left';
          ctx.fillText(card.r,4,15);
          ctx.font='11px sans-serif';
          ctx.fillText(card.s,4,27);
          ctx.restore();
          // 內邊框細線
          ctx.strokeStyle='rgba(0,0,0,.06)';ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(x+2,y+2,w-4,h-4,r-1);ctx.stroke();
        } else {
          // 背面：深藍質感
          const bg=ctx.createLinearGradient(x,y,x+w,y+h);
          bg.addColorStop(0,'#1a2a4a');bg.addColorStop(1,'#0d1a30');
          ctx.fillStyle=bg;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
          ctx.shadowBlur=0;
          ctx.strokeStyle='rgba(100,140,200,.3)';ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.stroke();
          // 背面花紋
          ctx.strokeStyle='rgba(100,140,200,.12)';ctx.lineWidth=1;
          for(let i=0;i<5;i++){
            ctx.beginPath();ctx.roundRect(x+3+i*1.5,y+3+i*1.5,w-6-i*3,h-6-i*3,r-1);ctx.stroke();
          }
          // 中央菱形
          ctx.fillStyle='rgba(100,150,220,.2)';
          ctx.beginPath();
          ctx.moveTo(x+w/2,y+10);ctx.lineTo(x+w-8,y+h/2);
          ctx.lineTo(x+w/2,y+h-10);ctx.lineTo(x+8,y+h/2);
          ctx.closePath();ctx.fill();
        }
        ctx.restore();
      }

      /* ── 手牌排列 ── */
      function drawHand(hand,cx,cy,dir,faceUp,selected=[]){
        const n=hand.length;if(n===0)return;
        const cw=46,ch=68;
        if(dir==='bottom'){
          const maxSpread=Math.min(n*30,W-80);
          const step=n>1?maxSpread/(n-1):0;
          const startX=(W-maxSpread)/2;
          for(let i=0;i<n;i++){
            const x=n===1?W/2-cw/2:startX+i*step;
            const isSel=selected.some(c=>cardId(c)===cardId(hand[i]));
            drawCard(x,cy-(isSel?16:0),hand[i],isSel,faceUp);
          }
        } else if(dir==='top'){
          const step=Math.min(22,Math.floor((W-80)/Math.max(n,1)));
          const startX=(W-(n-1)*step-cw)/2;
          for(let i=0;i<n;i++) drawCard(startX+i*step,cy,hand[i],false,false);
        } else if(dir==='left'){
          const step=Math.min(18,(H-160)/Math.max(n,1));
          const startY=80+(H-160-(n-1)*step)/2;
          for(let i=0;i<n;i++) drawCard(cx,startY+i*step,hand[i],false,false);
        } else if(dir==='right'){
          const step=Math.min(18,(H-160)/Math.max(n,1));
          const startY=80+(H-160-(n-1)*step)/2;
          for(let i=0;i<n;i++) drawCard(cx,startY+i*step,hand[i],false,false);
        }
      }

      /* ── 桌面中央出牌區 ── */
      function drawPlayedCards(){
        if(!played)return;
        const cards=played.cards;
        const n=cards.length;
        const cw=46,gap=50;
        const totalW=(n-1)*gap+cw;
        const startX=W/2-totalW/2;
        const cy=H/2-44;
        // 牌型標籤
        const typeZH=TYPE_ZH[played.type]||played.type;
        const label=`${PLAYERS[playedBy]}　${typeZH}`;
        ctx.fillStyle='rgba(245,196,0,.85)';
        ctx.font='bold 11px -apple-system,sans-serif';
        ctx.textAlign='center';
        ctx.fillText(label,W/2,cy-8);
        for(let i=0;i<n;i++) drawCard(startX+i*gap,cy,cards[i],false,true);
      }

      /* ── 玩家資訊面板 ── */
      function drawPlayerPanel(idx,px,py,w,h){
        const isActive=currentPlayer===idx;
        const isDone=finished.includes(idx);
        const isTarget=idx===targetPlayer&&fr%60<30;
        // 面板底
        ctx.save();
        ctx.fillStyle=isActive?'rgba(245,196,0,.12)':isDone?'rgba(80,80,80,.15)':'rgba(0,0,0,.35)';
        ctx.strokeStyle=isActive?'rgba(245,196,0,.6)':isTarget?'rgba(255,60,60,.5)':'rgba(255,255,255,.08)';
        ctx.lineWidth=isActive?1.5:1;
        ctx.beginPath();ctx.roundRect(px,py,w,h,8);ctx.fill();ctx.stroke();
        // 名字
        ctx.fillStyle=isActive?'#f5c400':isDone?'#666':'#ddd';
        ctx.font=`${isActive?'bold ':''}12px -apple-system,sans-serif`;
        ctx.textAlign='left';
        ctx.fillText(PLAYERS[idx],px+8,py+16);
        // 籌碼
        ctx.fillStyle='#f5c400';ctx.font='bold 11px monospace';
        ctx.fillText('$'+chips[idx],px+8,py+30);
        // 手牌數
        ctx.fillStyle='#888';ctx.font='10px monospace';
        ctx.fillText('手牌 '+hands[idx].length,px+w-50,py+16);
        // 名次
        if(isDone){
          const rank=finished.indexOf(idx)+1;
          const medals=['🥇','🥈','🥉','💀'];
          ctx.font='16px sans-serif';ctx.textAlign='right';
          ctx.fillText(medals[rank-1]||rank,px+w-6,py+30);
        }
        // 針對標示
        if(isTarget){
          ctx.fillStyle='rgba(255,60,60,.8)';ctx.font='bold 10px sans-serif';
          ctx.textAlign='right';
          ctx.fillText('🎯',px+w-6,py+16);
        }
        // 出牌指示燈
        if(isActive&&gamePhase==='playing'){
          const pulse=0.5+Math.sin(fr*0.15)*0.5;
          ctx.fillStyle=`rgba(245,196,0,${pulse})`;
          ctx.beginPath();ctx.arc(px+w-8,py+h-8,4,0,Math.PI*2);ctx.fill();
        }
        ctx.restore();
      }

      /* ── 訊息 log ── */
      function drawLog(){
        ctx.save();
        ctx.fillStyle='rgba(0,0,0,.55)';
        ctx.beginPath();ctx.roundRect(8,8,210,96,8);ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,.06)';ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(8,8,210,96,8);ctx.stroke();
        msgLog.forEach((m,i)=>{
          ctx.fillStyle=i===0?'#ddd':'rgba(180,180,180,.'+(7-i*1)+'0)';
          ctx.font=(i===0?'bold ':'')+'10px -apple-system,sans-serif';
          ctx.textAlign='left';
          ctx.fillText(m,16,24+i*15,196);
        });
        ctx.restore();
      }

      /* ── 操作按鈕 ── */
      function drawButtons(){
        if(currentPlayer!==0||gamePhase!=='playing')return;
        const canPlay=selectedCards.length>0;
        const canPass=played!==null&&playedBy!==0;
        // 出牌按鈕
        ctx.save();
        const pg=ctx.createLinearGradient(W/2-92,H-56,W/2-8,H-20);
        pg.addColorStop(0,canPlay?'#c0392b':'#2a2a2a');
        pg.addColorStop(1,canPlay?'#e74c3c':'#1a1a1a');
        ctx.fillStyle=pg;
        ctx.beginPath();ctx.roundRect(W/2-92,H-56,84,38,8);ctx.fill();
        ctx.strokeStyle=canPlay?'rgba(231,76,60,.8)':'rgba(80,80,80,.5)';
        ctx.lineWidth=1.5;
        ctx.beginPath();ctx.roundRect(W/2-92,H-56,84,38,8);ctx.stroke();
        ctx.fillStyle=canPlay?'#fff':'#555';
        ctx.font='bold 14px -apple-system,sans-serif';
        ctx.textAlign='center';
        ctx.fillText('出牌',W/2-50,H-31);
        // Pass按鈕
        const pg2=ctx.createLinearGradient(W/2+8,H-56,W/2+92,H-20);
        pg2.addColorStop(0,canPass?'#2980b9':'#2a2a2a');
        pg2.addColorStop(1,canPass?'#3498db':'#1a1a1a');
        ctx.fillStyle=pg2;
        ctx.beginPath();ctx.roundRect(W/2+8,H-56,84,38,8);ctx.fill();
        ctx.strokeStyle=canPass?'rgba(52,152,219,.8)':'rgba(80,80,80,.5)';
        ctx.beginPath();ctx.roundRect(W/2+8,H-56,84,38,8);ctx.stroke();
        ctx.fillStyle=canPass?'#fff':'#555';
        ctx.font='bold 14px -apple-system,sans-serif';
        ctx.fillText('Pass',W/2+50,H-31);
        // 取消選牌按鈕（只在有選牌時顯示）
        if(selectedCards.length>0){
          ctx.fillStyle='rgba(80,80,80,.6)';
          ctx.beginPath();ctx.roundRect(W-80,H-56,72,38,8);ctx.fill();
          ctx.strokeStyle='rgba(150,150,150,.4)';ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(W-80,H-56,72,38,8);ctx.stroke();
          ctx.fillStyle='#aaa';
          ctx.font='bold 13px -apple-system,sans-serif';
          ctx.textAlign='center';
          ctx.fillText('↩ 取消',W-44,H-31);
        }
        ctx.restore();
      }

      /* ── 主繪製 ── */
      function draw(){
        // 背景：深色木紋桌
        const bg=ctx.createRadialGradient(W/2,H/2,50,W/2,H/2,400);
        bg.addColorStop(0,'#1a1008');bg.addColorStop(1,'#0a0804');
        ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);

        // 絨布桌面橢圓
        const felt=ctx.createRadialGradient(W/2,H/2,20,W/2,H/2,280);
        felt.addColorStop(0,'#1a4a1a');felt.addColorStop(0.7,'#0d3010');felt.addColorStop(1,'#081808');
        ctx.fillStyle=felt;
        ctx.beginPath();ctx.ellipse(W/2,H/2,290,195,0,0,Math.PI*2);ctx.fill();
        // 絨布邊框（金色）
        const rim=ctx.createLinearGradient(W/2-290,H/2,W/2+290,H/2);
        rim.addColorStop(0,'#8b6914');rim.addColorStop(0.3,'#d4a017');
        rim.addColorStop(0.5,'#f5c400');rim.addColorStop(0.7,'#d4a017');rim.addColorStop(1,'#8b6914');
        ctx.strokeStyle=rim;ctx.lineWidth=3;
        ctx.beginPath();ctx.ellipse(W/2,H/2,290,195,0,0,Math.PI*2);ctx.stroke();
        // 內側細框
        ctx.strokeStyle='rgba(245,196,0,.2)';ctx.lineWidth=1;
        ctx.beginPath();ctx.ellipse(W/2,H/2,283,188,0,0,Math.PI*2);ctx.stroke();

        // 玩家面板（四方位）
        drawPlayerPanel(0,W/2-70,H-68,140,52);  // 下
        drawPlayerPanel(1,W/2-70,8,140,52);       // 上
        drawPlayerPanel(2,4,H/2-30,120,52);       // 左
        drawPlayerPanel(3,W-124,H/2-30,120,52);   // 右

        // 各家手牌
        drawHand(hands[0],0,H-138,'bottom',true,selectedCards);
        drawHand(hands[1],0,62,'top',false);
        drawHand(hands[2],4,0,'left',false);
        drawHand(hands[3],W-52,0,'right',false);

        drawPlayedCards();
        drawLog();
        drawButtons();

        // 出牌滑入動畫
        for(let i=animCards.length-1;i>=0;i--){
          const ac=animCards[i];
          ctx.globalAlpha=ac.alpha;
          ctx.save();
          ctx.translate(ac.x+23,ac.y+34);
          ctx.scale(1,ac.alpha*0.3+0.7);
          ctx.translate(-23,-34);
          drawCard(0,0,ac.card,false,true);
          ctx.restore();
          ac.x+=(W/2-23-ac.x)*0.15;
          ac.y+=(H/2-34-ac.y)*0.15;
          ac.alpha-=0.025;
          if(ac.alpha<=0)animCards.splice(i,1);
        }
        ctx.globalAlpha=1;

        // AI思考
        if(currentPlayer!==0&&gamePhase==='playing'){
          const dots='.'.repeat(1+(Math.floor(fr/18)%3));
          ctx.fillStyle='rgba(245,196,0,.7)';
          ctx.font='bold 12px -apple-system,sans-serif';
          ctx.textAlign='center';
          ctx.fillText(`${PLAYERS[currentPlayer]} 思考中${dots}`,W/2,H/2+8);
        }
      }

      /* ── 主循環 ── */
      function loop(){
        fr++;
        // AI行動
        if(gamePhase==='playing'&&currentPlayer!==0&&!finished.includes(currentPlayer)){
          aiThinkTimer--;
          if(aiThinkTimer<=0){
            const mustC3=mustFirst&&hands[currentPlayer].some(c=>c.r==='3'&&c.s==='♣');
            const result=aiPlay(hands[currentPlayer],played,mustC3,targetPlayer,currentPlayer);
            if(result){
              playCards(currentPlayer,result.cards);
            } else {
              pass(currentPlayer);
            }
            aiThinkTimer=aiThinkDelay+Math.floor(Math.random()*40);
          }
        }
        draw();
        api.raf(loop);
      }

      /* ── 啟動 ── */
      running=true;
      api.showMsg('🃏 燈燈大老二',
        '梅花3先出・梅花3持有者先手\n點選手牌選牌，按出牌/Pass',
        [{label:'▶ 開始',red:true,fn:()=>{api.hideMsg();api.raf(loop);}}]
      );
    }
  });
})();
