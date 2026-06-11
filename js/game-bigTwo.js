/**
 * game-bigTwo.js — 燈燈大老二（基礎完整版）
 * 需在 splash-game.js 之前載入
 *
 * 規則（2026/06 定版）：
 *   - 4人桌（1玩家 + 3AI），梅花3持有者先出且首手必含梅花3
 *   - 牌型：單張 / 對子 / 三條 / 五張（順子、葫蘆、鐵支、同花順）
 *     ※ 無「同花」牌型（同花是13支玩法）
 *   - 同花順 > 鐵支：兩者皆可壓任何張數牌型；同花順壓一切、鐵支壓除同花順外一切
 *   - 其餘牌型：同張數、同型互壓（順子壓順子、葫蘆壓葫蘆）
 *   - 順子：A2345 最小、23456 最大；JQKA2 不合法（2 僅能出現在前述兩種）
 *   - 一圈 Pass（所有在場其他人皆 Pass）→ 最後出牌者自由出新牌；
 *     若其已出完，由其下一位在場玩家自由出牌
 *   - 結算：只有第 1 名收錢，其餘三家依剩牌罰金付給頭家
 *   - IndexedDB 存玩家籌碼
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
  const AVATARS = ['😺','🤖','🦊','🐯'];
  const TYPE_ZH = {single:'單張',pair:'對子',triple:'三條',straight:'順子',
    fullHouse:'葫蘆',fourOfAKind:'鐵支',straightFlush:'同花順'};

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
  function sortByRank(h){h.sort((a,b)=>a.v!==b.v?a.v-b.v:a.sv-b.sv);}
  function sortBySuit(h){h.sort((a,b)=>a.sv!==b.sv?a.sv-b.sv:a.v-b.v);}

  /* 剩牌罰金：每張5元；≥10張總額×2；2/A/JQK 每張再×2 */
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
      const flush=sorted.every(c=>c.s===sorted[0].s);
      const straight=isStraight(sorted);
      if(flush&&straight){
        // 同花順：以順子大小為主，花色為輔（取頂牌花色）
        return{type:'straightFlush',cards:sorted,key:straightKey(sorted)*4+SUIT_VAL[sorted[0].s]};
      }
      const four=findFour(sorted);
      if(four!==null)
        return{type:'fourOfAKind',cards:sorted,key:four};
      const full=findFullHouse(sorted);
      if(full!==null)
        return{type:'fullHouse',cards:sorted,key:full};
      if(straight)
        return{type:'straight',cards:sorted,key:straightKey(sorted)*4+sorted[4].sv};
      // 純同花（非順）不是合法牌型
      return null;
    }
    return null;
  }

  /*
   * 順子合法性：
   *   一般連續順（34567~10JQKA）：vals 連續且不含2（vals[4]<=11）
   *   A2345：vals=[0,1,2,11,12]（最小，key=-1）
   *   23456：vals=[0,1,2,3,12]（最大，key=14）
   *   JQKA2（vals=[8,9,10,11,12] 連續）→ 不合法
   */
  function isStraight(sorted){
    const vals=sorted.map(c=>c.v);
    const normal=vals.every((v,i)=>i===0||v===vals[i-1]+1);
    if(normal)return vals[4]<=11; // 排除 JQKA2
    if(vals[0]===0&&vals[1]===1&&vals[2]===2&&vals[3]===3&&vals[4]===12)return true; // 23456
    if(vals[0]===0&&vals[1]===1&&vals[2]===2&&vals[3]===11&&vals[4]===12)return true; // A2345
    return false;
  }
  function straightKey(sorted){
    const vals=sorted.map(c=>c.v);
    if(vals[4]===12&&vals[3]===3)return 14;  // 23456 最大
    if(vals[4]===12&&vals[3]===11)return -1; // A2345 最小
    return vals[4]; // 一般順：頂牌val
  }

  function findFour(sorted){
    const cnt={};
    for(const c of sorted)cnt[c.v]=(cnt[c.v]||0)+1;
    for(const [v,c] of Object.entries(cnt))if(c===4)return Number(v);
    return null;
  }
  function findFullHouse(sorted){
    const cnt={};
    for(const c of sorted)cnt[c.v]=(cnt[c.v]||0)+1;
    const vals=Object.values(cnt);
    if(vals.includes(3)&&vals.includes(2))
      return Number(Object.entries(cnt).find(([,c])=>c===3)[0]);
    return null;
  }

  /* 壓牌判定 */
  function canBeat(played, attempt){
    if(!played)return true;   // 自由出牌
    if(!attempt)return false;
    // 同花順壓一切
    if(attempt.type==='straightFlush'){
      if(played.type==='straightFlush')return attempt.key>played.key;
      return true;
    }
    // 鐵支壓除同花順外一切
    if(attempt.type==='fourOfAKind'){
      if(played.type==='straightFlush')return false;
      if(played.type==='fourOfAKind')return attempt.key>played.key;
      return true;
    }
    // 桌面是炸彈，一般牌壓不了
    if(played.type==='straightFlush'||played.type==='fourOfAKind')return false;
    // 其餘：同張數、同型互壓
    if(attempt.cards.length!==played.cards.length)return false;
    if(attempt.type!==played.type)return false;
    return attempt.key>played.key;
  }

  /* ══════════════════════════════════════
     四、合法組合列舉 + AI 策略
  ══════════════════════════════════════ */
  function legalCombos(hand, played, mustHaveClub3){
    const combos=[];
    function addIfValid(cards){
      const cl=classify(cards);
      if(!cl)return;
      if(mustHaveClub3&&!cards.some(c=>c.r==='3'&&c.s==='♣'))return;
      if(canBeat(played,cl))combos.push({cards,cl});
    }
    const n=hand.length;
    for(let i=0;i<n;i++)addIfValid([hand[i]]);
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)
      if(hand[i].v===hand[j].v)addIfValid([hand[i],hand[j]]);
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++)
      if(hand[i].v===hand[j].v&&hand[j].v===hand[k].v)addIfValid([hand[i],hand[j],hand[k]]);
    for(let i=0;i<n-4;i++)
      for(let j=i+1;j<n-3;j++)
        for(let k=j+1;k<n-2;k++)
          for(let l=k+1;l<n-1;l++)
            for(let m=l+1;m<n;m++)
              addIfValid([hand[i],hand[j],hand[k],hand[l],hand[m]]);
    combos.sort((a,b)=>{
      // 先比牌型成本（炸彈最後出），再比key
      const cost=t=>t==='straightFlush'?2:t==='fourOfAKind'?1:0;
      const ca=cost(a.cl.type),cb=cost(b.cl.type);
      if(ca!==cb)return ca-cb;
      return a.cl.key-b.cl.key;
    });
    return combos;
  }

  /**
   * AI 策略：
   *   - 一般：出最小合法牌（保留炸彈）
   *   - 自己手牌 ≤4：出最大牌衝刺
   *   - 有對手剩牌 ≤2 且需壓牌：出最大牌封鎖
   */
  function aiPlay(hand, played, mustHaveClub3, minOppLen){
    const combos=legalCombos(hand, played, mustHaveClub3);
    if(combos.length===0)return null; // PASS
    if(hand.length<=4)return combos[combos.length-1];
    if(minOppLen<=2&&played)return combos[combos.length-1];
    return combos[0];
  }


  /* ══════════════════════════════════════
     四之二、強化 AI：手牌拆解 + 計牌
  ══════════════════════════════════════ */
  /* 混花順子候選（保護對子：消耗≥2組複數張的順子放棄） */
  function findRunMixed(rest){
    const byV={};rest.forEach(c=>{(byV[c.v]=byV[c.v]||[]).push(c);});
    const vs=Object.keys(byV).map(Number).sort((a,b)=>a-b);
    for(let i=0;i<vs.length;i++){
      const run=[vs[i]];
      for(let j=i+1;j<vs.length&&run.length<5;j++){
        if(vs[j]===run[run.length-1]+1)run.push(vs[j]);else break;
      }
      if(run.length===5&&run[4]<=11){
        const pairsUsed=run.filter(v=>byV[v].length>=2).length;
        if(pairsUsed<=1)
          return run.map(v=>[...byV[v]].sort((a,b)=>a.sv-b.sv)[0]);
      }
    }
    return null;
  }
  /* 同花順候選 */
  function findRunSuited(rest){
    const bySuit={};rest.forEach(c=>{(bySuit[c.s]=bySuit[c.s]||[]).push(c);});
    for(const s in bySuit){
      const cs=[...bySuit[s]].sort((a,b)=>a.v-b.v);
      for(let i=0;i+4<cs.length;i++){
        if(cs[i+4].v-cs[i].v===4&&cs[i+4].v<=11&&new Set(cs.slice(i,i+5).map(c=>c.v)).size===5)
          return cs.slice(i,i+5);
      }
    }
    return null;
  }
  /* 手牌最優拆解：同花順→鐵支→順子→三條→對子→單張，回傳完整單位列表 */
  function partitionHand(hand){
    let rest=[...hand].sort((a,b)=>a.v-b.v||a.sv-b.sv);
    const units=[];
    const remove=cards=>{const ids=new Set(cards.map(cardId));rest=rest.filter(c=>!ids.has(cardId(c)));};
    let run;
    while((run=findRunSuited(rest))){units.push(run);remove(run);}
    // 鐵支先取出，稍後配最小單張湊成五張炸彈
    const fours=[];
    const byV4={};rest.forEach(c=>{(byV4[c.v]=byV4[c.v]||[]).push(c);});
    for(const v in byV4)if(byV4[v].length===4){fours.push([...byV4[v]]);remove(byV4[v]);}
    while((run=findRunMixed(rest))){units.push(run);remove(run);}
    const byV={};rest.forEach(c=>{(byV[c.v]=byV[c.v]||[]).push(c);});
    for(const v in byV){
      if(byV[v].length===3){units.push([...byV[v]]);remove(byV[v]);}
      else if(byV[v].length===2){units.push([...byV[v]]);remove(byV[v]);}
    }
    // 鐵支配腳：最小剩餘單張；沒有單張就拆成兩對
    for(const fc of fours){
      if(rest.length){
        const kicker=rest[0];
        units.push([...fc,kicker]);remove([kicker]);
      } else {
        units.push(fc.slice(0,2));units.push(fc.slice(2,4));
      }
    }
    rest.forEach(c=>units.push([c]));
    return units.map(cards=>({cards,cl:classify(cards)})).filter(u=>u.cl);
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
    canvasH: 600,

    init(canvas, ctx, api){
      const W=680, H=600;

      /* ── 高解析渲染（消除 DOS 感糊邊）── */
      const dpr=Math.min(window.devicePixelRatio||1,2);
      if(dpr>1){
        const rect=canvas.getBoundingClientRect();
        const cssW=rect.width>0?rect.width:W, cssH=rect.height>0?rect.height:H;
        canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px';
        canvas.width=W*dpr; canvas.height=H*dpr;
      }
      ctx.setTransform(dpr,0,0,dpr,0,0);

      /* ── 遊戲狀態 ── */
      let chips=[1000,1000,1000,1000]; // 0=玩家
      let hands=[[],[],[],[]];
      let finished=[];        // 出完牌順序 [playerIdx,...]
      let currentPlayer=0;
      let played=null;        // 桌面牌型
      let playedBy=-1;
      let passCount=0;        // 自上次出牌後的連續Pass數
      let selectedCards=[];
      let gamePhase='loading';// loading/dealing/playing/result
      let msgLog=[];
      let lastAction=['','','',''];  // 各家最後動作（面板顯示）
      let aiThinkTimer=0;
      const aiThinkDelay=55;
      let mustFirst=true;     // 首手必含梅花3
      let animCards=[];       // 出牌滑入動畫
      let tableFade=null;     // 清桌淡出 {cards,by,alpha}
      let dealT=0;            // 發牌動畫計時
      let sortMode='rank';    // rank | suit
      let playedRecord=[];    // 已亮牌（計牌用，AI 不偷看手牌）
      let fastMode=false;     // 玩家完牌後加速模擬
      let fr=0;
      let alive=true;         // init 實例存活旗標（防舊 listener / loop 殘留）

      /* ── 按鈕區（draw 與 click 共用座標）── */
      const BTNS={
        hint:  {x:W/2-160, y:H-56, w:60, h:38, label:'💡提示'},
        play:  {x:W/2-92,  y:H-56, w:84, h:38, label:'出牌'},
        pass:  {x:W/2+8,   y:H-56, w:84, h:38, label:'Pass'},
        sort:  {x:W/2+100, y:H-56, w:60, h:38, label:'⇅排序'},
        cancel:{x:W-80,    y:H-56, w:72, h:38, label:'↩ 取消'},
        skip:  {x:W-128,   y:8,    w:120,h:32, label:'⏭ 跳到結算'},
      };
      const inBtn=(b,mx,my)=>mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h;

      /* ── 載入籌碼 ── */
      loadChips(v=>{
        if(!alive)return;
        chips[0]=v;
        api.setScore(chips[0]);
        startRound();
      });

      function sortHand0(){
        if(sortMode==='rank')sortByRank(hands[0]);
        else sortBySuit(hands[0]);
      }

      function startRound(){
        const deck=shuffle(makeDeck());
        hands=[[],[],[],[]];
        for(let i=0;i<52;i++)hands[i%4].push(deck[i]);
        hands.forEach(sortByRank);
        sortHand0();
        finished=[];
        played=null; playedBy=-1; passCount=0;
        selectedCards=[];
        lastAction=['','','',''];
        animCards=[]; tableFade=null;
        mustFirst=true;
        playedRecord=[];
        fastMode=false;
        msgLog=[];
        dealT=0;
        gamePhase='dealing';
        currentPlayer=hands.findIndex(h=>h.some(c=>c.r==='3'&&c.s==='♣'));
      }

      function onDealDone(){
        gamePhase='playing';
        addLog(`${PLAYERS[currentPlayer]} 先出（持有梅花3）`);
        if(currentPlayer!==0)scheduleAI();
      }

      function addLog(msg){
        msgLog.unshift(msg);
        if(msgLog.length>6)msgLog.pop();
      }

      const activeList=()=>[0,1,2,3].filter(i=>!finished.includes(i));
      const minOppLen=(self)=>Math.min(...activeList().filter(i=>i!==self).map(i=>hands[i].length));

      /* ── 出牌 ── */
      function playCards(pidx, cards){
        const cl=classify(cards);
        if(!cl){addLog('❌ 無效牌型');return false;}
        if(mustFirst&&!cards.some(c=>c.r==='3'&&c.s==='♣')){addLog('❌ 首手必須帶梅花3');return false;}
        if(!canBeat(played,cl)){addLog('❌ 牌不夠大');return false;}

        const ids=cards.map(cardId);
        hands[pidx]=hands[pidx].filter(c=>!ids.includes(cardId(c)));
        played=cl; playedBy=pidx; passCount=0; mustFirst=false;
        playedRecord.push(...cards);
        tableFade=null;
        lastAction[pidx]=`出${TYPE_ZH[cl.type]}`;

        // 滑入動畫：從出牌者方位飛向中央
        if(!fastMode){
          const FROM=[[W/2,H-150],[W/2,120],[70,H/2],[W-70,H/2]][pidx];
          animCards=cards.map((c,i)=>({card:c,x:FROM[0]-cards.length*25+i*50,y:FROM[1]-34,alpha:1}));
        }
        addLog(`${PLAYERS[pidx]} 出 ${cards.map(c=>c.r+c.s).join(' ')}（${TYPE_ZH[cl.type]}）`);

        if(hands[pidx].length===0){
          // 第一個出完即整局結束，其餘依剩牌數排名（同張數比罰金、再比座位）
          finished.push(pidx);
          lastAction[pidx]='🎉 完牌';
          addLog(`🎉 ${PLAYERS[pidx]} 出完，本局結束！`);
          const rest=[0,1,2,3].filter(i=>i!==pidx)
            .sort((a,b)=>hands[a].length-hands[b].length
              ||handPenalty(hands[a])-handPenalty(hands[b])
              ||a-b);
          finished.push(...rest);
          endRound();
          return true;
        }
        nextPlayer();
        return true;
      }

      function pass(pidx){
        if(played===null){addLog('❌ 自由出牌，不能Pass');return;}
        if(playedBy===pidx){addLog('❌ 自己出的牌不能Pass');return;}
        passCount++;
        lastAction[pidx]='Pass';
        addLog(`${PLAYERS[pidx]} Pass`);

        // 一圈判定：除最後出牌者外，所有在場玩家都Pass了
        const needed=activeList().filter(i=>i!==playedBy).length;
        if(passCount>=needed){
          tableFade={cards:played.cards,by:playedBy,alpha:0.6};
          // 自由出牌權：最後出牌者；若其已出完 → 其下一位在場玩家
          let lead=playedBy;
          if(finished.includes(lead)){
            lead=(lead+1)%4;
            while(finished.includes(lead))lead=(lead+1)%4;
          }
          played=null; playedBy=-1; passCount=0;
          currentPlayer=lead;
          addLog(`🔄 一圈Pass，${PLAYERS[lead]} 自由出牌`);
          if(currentPlayer!==0)scheduleAI();
          return;
        }
        nextPlayer();
      }

      function nextPlayer(){
        let next=(currentPlayer+1)%4, count=0;
        while(finished.includes(next)&&count<4){next=(next+1)%4;count++;}
        currentPlayer=next;
        if(currentPlayer!==0)scheduleAI();
      }

      /* 該單張是否為「場上王牌」：所有未現身的牌都壓不過它（公平計牌：只看已亮牌+自己手牌） */
      function isBossSingle(card,pidx){
        const seen=new Set([...playedRecord,...hands[pidx]].map(cardId));
        const k=card.v*4+card.sv;
        for(const s of SUITS)for(const r of RANKS){
          if(seen.has(r+s))continue;
          if(RANK_VAL[r]*4+SUIT_VAL[s]>k)return false;
        }
        return true;
      }

      /**
       * 強化 AI 決策：
       *  1. 一手出完直接贏
       *  2. 殘局（≤8張）：出完此手後剩牌恰為一個合法牌型 → 兩步收尾
       *  3. 領出：優先丟「完整單位」中最小的；有人快出完改領多張牌型或王牌單張保控制權
       *  4. 壓牌：完整單位優先最小可壓；需拆牌時只有在危險或殘局才拆，否則 Pass 保牌型
       */
      function smartAiPlay(pidx,mustC3){
        const hand=hands[pidx];
        const combos=legalCombos(hand,played,mustC3);
        if(!combos.length)return null;
        const finish=combos.find(c=>c.cards.length===hand.length);
        if(finish)return finish;
        if(hand.length<=8){
          for(const c of combos){
            const ids=new Set(c.cards.map(cardId));
            const restCards=hand.filter(x=>!ids.has(cardId(x)));
            if(restCards.length&&classify(restCards))return c;
          }
        }
        const units=partitionHand(hand);
        const ukey=cs=>cs.map(cardId).sort().join(',');
        const unitSet=new Set(units.map(u=>ukey(u.cards)));
        const isWhole=c=>unitSet.has(ukey(c.cards));
        const danger=minOppLen(pidx)<=2;
        const whole=combos.filter(isWhole);
        if(!played){
          const pool=whole.length?whole:combos;
          if(danger){
            // 有人快出完：領王牌單張保控制權 > 多張牌型 > 最大單張
            const boss=pool.find(c=>c.cards.length===1&&isBossSingle(c.cards[0],pidx));
            if(boss)return boss;
            const multi=pool.filter(c=>c.cards.length>=2);
            if(multi.length)return multi[0];
            return pool[pool.length-1];
          }
          return pool[0];
        }
        if(whole.length){
          if(danger)return whole[whole.length-1];
          const pick=whole[0];
          // 非危急時不輕易動用含2的單張/對子，留一手（也給別人活路）
          if(pick.cl.key>=48&&(pick.cl.type==='single'||pick.cl.type==='pair')&&Math.random()<0.45)return null;
          return pick;
        }
        if(danger||hand.length<=6)return combos[0];
        // 拆單張/對子去壓低牌可接受；拆五張牌型或動用炸彈不值得 → Pass
        const cheap=combos.find(c=>c.cards.length<=2&&c.cl.type!=='fourOfAKind');
        if(cheap&&(played.type==='single'||played.type==='pair')&&played.key<8*4)return cheap;
        return null;
      }

      function scheduleAI(){
        aiThinkTimer=fastMode?5:aiThinkDelay+Math.floor(Math.random()*40);
      }

      /* 玩家完牌後直接模擬到結算 */
      function simulateToEnd(){
        let guard=500;
        while(gamePhase==='playing'&&guard-->0){
          const p=currentPlayer;
          if(finished.includes(p)){nextPlayer();continue;}
          const mustC3=mustFirst&&hands[p].some(c=>c.r==='3'&&c.s==='♣');
          const r=smartAiPlay(p,mustC3);
          if(r)playCards(p,r.cards); else pass(p);
        }
        animCards=[];
      }

      /* ── 結算：只有第1名收錢 ── */
      function endRound(){
        gamePhase='result';
        const winner=finished[0];
        const penalties=[0,0,0,0];
        let pot=0;
        for(let rank=1;rank<4;rank++){
          const idx=finished[rank];
          penalties[idx]=handPenalty(hands[idx]);
          pot+=penalties[idx];
        }
        chips[winner]+=pot;
        for(let rank=1;rank<4;rank++){
          const idx=finished[rank];
          chips[idx]=Math.max(0,chips[idx]-penalties[idx]);
        }
        saveChips(chips[0]);
        api.setScore(chips[0]);

        const resultLines=finished.map((pidx,rank)=>{
          const delta=rank===0?`+${pot}`:`-${penalties[pidx]}`;
          const cardsLeft=rank===0?'':`（剩${hands[pidx].length}張）`;
          return `${rank+1}. ${PLAYERS[pidx]} ${delta}元${cardsLeft} → ${chips[pidx]}元`;
        }).join('\n');

        if(chips[0]<=0){
          api.showMsg('破產了 😭',`籌碼歸零！\n\n${resultLines}`,[
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
        for(let i=1;i<4;i++){if(chips[i]<=0)chips[i]=1000;} // 破產AI補新人
        startRound();
      }

      /* ── 玩家操作 ── */
      function onClick(e){
        if(!alive)return;
        if(gamePhase!=='playing')return;
        const r=canvas.getBoundingClientRect();
        const mx=(e.clientX-r.left)*(W/r.width);
        const my=(e.clientY-r.top)*(H/r.height);

        if(fastMode&&inBtn(BTNS.skip,mx,my)){simulateToEnd();return;}
        if(currentPlayer!==0)return;

        if(inBtn(BTNS.play,mx,my)){
          if(selectedCards.length===0){addLog('❌ 請先選牌');return;}
          if(playCards(0,selectedCards))selectedCards=[];
          return;
        }
        if(inBtn(BTNS.pass,mx,my)){
          if(played===null||playedBy===0)return;
          pass(0); selectedCards=[]; return;
        }
        if(inBtn(BTNS.hint,mx,my)){
          const mustC3=mustFirst&&hands[0].some(c=>c.r==='3'&&c.s==='♣');
          const combos=legalCombos(hands[0],played,mustC3);
          if(combos.length===0){addLog('💡 沒有牌能壓，建議 Pass');selectedCards=[];}
          else{selectedCards=[...combos[0].cards];addLog('💡 已幫你選最小可出牌');}
          return;
        }
        if(inBtn(BTNS.sort,mx,my)){
          sortMode=sortMode==='rank'?'suit':'rank';
          sortHand0();
          addLog(`⇅ 改為${sortMode==='rank'?'點數':'花色'}排序`);
          return;
        }
        if(selectedCards.length>0&&inBtn(BTNS.cancel,mx,my)){
          selectedCards=[]; return;
        }

        // 點選手牌（座標與 drawHand bottom ×1.25 對齊）
        const hand=hands[0];
        const cw=46*1.25,ch=68*1.25;
        const maxSpread=Math.min((hand.length-1)*36+cw,W-50);
        const step=hand.length>1?(maxSpread-cw)/(hand.length-1):0;
        const startX=(W-maxSpread)/2;
        for(let i=hand.length-1;i>=0;i--){
          const cx=startX+i*step;
          const isSel=selectedCards.some(sc=>cardId(sc)===cardId(hand[i]));
          const cy=H-168-(isSel?18:0);
          if(mx>=cx&&mx<=cx+cw&&my>=cy&&my<=cy+ch){
            const idx=selectedCards.findIndex(sc=>cardId(sc)===cardId(hand[i]));
            if(idx>=0)selectedCards.splice(idx,1);
            else selectedCards.push(hand[i]);
            return;
          }
        }
      }
      // 防重入：上一局實例若未被銷毀，先清掉它的 listener
      if(canvas.__bigTwoDestroy){try{canvas.__bigTwoDestroy();}catch(e){}}
      canvas.addEventListener('click',onClick);
      const destroy=()=>{alive=false;canvas.removeEventListener('click',onClick);};
      canvas.__bigTwoDestroy=destroy;

      /* ══════════════════════════════════════
         繪製
      ══════════════════════════════════════ */
      /* 數字牌 pip 排版（相對座標 0~1）*/
      const PIPS={
        '2':[[.5,.22],[.5,.78]],
        '3':[[.5,.2],[.5,.5],[.5,.8]],
        '4':[[.33,.24],[.67,.24],[.33,.76],[.67,.76]],
        '5':[[.33,.24],[.67,.24],[.5,.5],[.33,.76],[.67,.76]],
        '6':[[.33,.22],[.67,.22],[.33,.5],[.67,.5],[.33,.78],[.67,.78]],
        '7':[[.33,.22],[.67,.22],[.5,.36],[.33,.5],[.67,.5],[.33,.78],[.67,.78]],
        '8':[[.33,.22],[.67,.22],[.5,.36],[.33,.5],[.67,.5],[.5,.64],[.33,.78],[.67,.78]],
        '9':[[.33,.2],[.67,.2],[.33,.42],[.67,.42],[.5,.5],[.33,.62],[.67,.62],[.33,.82],[.67,.82]],
        '10':[[.33,.18],[.67,.18],[.5,.3],[.33,.42],[.67,.42],[.33,.6],[.67,.6],[.5,.72],[.33,.84],[.67,.84]],
      };

      function drawCard(x,y,card,selected,faceUp=true,scale=1){
        const w=46*scale,h=68*scale,r=5*scale;
        ctx.save();
        // 投影
        ctx.shadowColor=selected?'rgba(245,196,0,.9)':'rgba(0,0,0,.45)';
        ctx.shadowBlur=selected?14:5*scale;
        ctx.shadowOffsetY=selected?0:2*scale;
        if(faceUp){
          const bg=ctx.createLinearGradient(x,y,x,y+h);
          bg.addColorStop(0,'#ffffff');bg.addColorStop(.55,'#fbf9f4');bg.addColorStop(1,'#ece8df');
          ctx.fillStyle=bg;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
          ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
          ctx.strokeStyle=selected?'#f5c400':'rgba(60,50,30,.35)';
          ctx.lineWidth=selected?2:1;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.stroke();

          const isRed=card.s==='♥'||card.s==='♦';
          const col=isRed?'#c0392b':'#1c1c30';
          ctx.fillStyle=col;
          // 角標（襯線字較有撲克質感）
          ctx.font=`bold ${12.5*scale}px Georgia,'Times New Roman',serif`;
          ctx.textAlign='center';
          ctx.fillText(card.r,x+8*scale,y+13*scale);
          ctx.font=`${9.5*scale}px sans-serif`;
          ctx.fillText(card.s,x+8*scale,y+23*scale);
          // 右下倒置角標
          ctx.save();
          ctx.translate(x+w,y+h);ctx.rotate(Math.PI);
          ctx.fillStyle=col;
          ctx.font=`bold ${12.5*scale}px Georgia,'Times New Roman',serif`;
          ctx.fillText(card.r,8*scale,13*scale);
          ctx.font=`${9.5*scale}px sans-serif`;
          ctx.fillText(card.s,8*scale,23*scale);
          ctx.restore();

          if(card.r==='A'){
            // A：中央大花色＋細光暈
            ctx.font=`${30*scale}px sans-serif`;
            ctx.fillText(card.s,x+w/2,y+h/2+11*scale);
          } else if(['J','Q','K'].includes(card.r)){
            // 人頭牌：內框 + 大字母 + 雙花色
            ctx.strokeStyle=isRed?'rgba(192,57,43,.45)':'rgba(28,28,48,.4)';
            ctx.lineWidth=1;
            ctx.beginPath();ctx.roundRect(x+10*scale,y+13*scale,w-20*scale,h-26*scale,3*scale);ctx.stroke();
            ctx.font=`bold ${21*scale}px Georgia,serif`;
            ctx.fillText(card.r,x+w/2,y+h/2+7*scale);
            ctx.font=`${9*scale}px sans-serif`;
            ctx.fillText(card.s,x+w/2,y+h/2-12*scale);
            ctx.save();
            ctx.translate(x+w/2,y+h/2+17*scale);ctx.rotate(Math.PI);
            ctx.fillText(card.s,0,3*scale);
            ctx.restore();
          } else {
            // 數字牌：pip 排版（下半倒置）
            const pips=PIPS[card.r]||[];
            ctx.font=`${10*scale}px sans-serif`;
            for(const [px,py] of pips){
              if(py>0.5){
                ctx.save();
                ctx.translate(x+px*w,y+py*h);ctx.rotate(Math.PI);
                ctx.fillText(card.s,0,3.5*scale);
                ctx.restore();
              } else {
                ctx.fillText(card.s,x+px*w,y+py*h+3.5*scale);
              }
            }
          }
        } else {
          // 背面：深藍緞面＋細格紋＋金菱
          const bg=ctx.createLinearGradient(x,y,x+w,y+h);
          bg.addColorStop(0,'#22335c');bg.addColorStop(.5,'#16244a');bg.addColorStop(1,'#0d1830');
          ctx.fillStyle=bg;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
          ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
          ctx.strokeStyle='rgba(140,170,230,.4)';ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.stroke();
          // 白邊
          ctx.strokeStyle='rgba(255,255,255,.55)';
          ctx.beginPath();ctx.roundRect(x+2,y+2,w-4,h-4,Math.max(r-1,1));ctx.stroke();
          // 斜格紋
          ctx.save();
          ctx.beginPath();ctx.roundRect(x+4,y+4,w-8,h-8,Math.max(r-2,1));ctx.clip();
          ctx.strokeStyle='rgba(120,150,210,.18)';ctx.lineWidth=1;
          for(let d=-h;d<w+h;d+=7*scale){
            ctx.beginPath();ctx.moveTo(x+d,y);ctx.lineTo(x+d+h,y+h);ctx.stroke();
            ctx.beginPath();ctx.moveTo(x+d+h,y);ctx.lineTo(x+d,y+h);ctx.stroke();
          }
          ctx.restore();
          // 中央金菱
          ctx.fillStyle='rgba(212,160,23,.55)';
          ctx.beginPath();
          ctx.moveTo(x+w/2,y+h/2-11*scale);ctx.lineTo(x+w/2+8*scale,y+h/2);
          ctx.lineTo(x+w/2,y+h/2+11*scale);ctx.lineTo(x+w/2-8*scale,y+h/2);
          ctx.closePath();ctx.fill();
          ctx.fillStyle='rgba(245,196,0,.85)';
          ctx.font=`${9*scale}px sans-serif`;ctx.textAlign='center';
          ctx.fillText('燈',x+w/2,y+h/2+3.5*scale);
        }
        ctx.restore();
      }

      /* 各家可見張數（發牌動畫進度）*/
      function visibleCount(idx){
        if(gamePhase!=='dealing')return hands[idx].length;
        const dealt=Math.floor(dealT/2); // 每2幀發1張，共104幀
        return Math.max(0,Math.min(hands[idx].length,Math.ceil((dealt-idx)/4)));
      }

      function drawHand(idx,cx,cy,dir,faceUp,selected=[]){
        const hand=hands[idx];
        const n=visibleCount(idx);
        if(n===0)return;
        const cw=46;
        if(dir==='bottom'){
          const bw=cw*1.25;
          const maxSpread=Math.min((n-1)*36+bw,W-50);
          const step=n>1?(maxSpread-bw)/(n-1):0;
          const startX=(W-maxSpread)/2;
          for(let i=0;i<n;i++){
            const x=startX+i*step;
            const isSel=selected.some(c=>cardId(c)===cardId(hand[i]));
            drawCard(x,cy-(isSel?18:0),hand[i],isSel,faceUp,1.25);
          }
        } else if(dir==='top'){
          const step=Math.min(22,Math.floor((W-200)/Math.max(n,1)));
          const startX=(W-(n-1)*step-cw)/2;
          for(let i=0;i<n;i++) drawCard(startX+i*step,cy,hand[i],false,false,0.8);
        } else if(dir==='left'||dir==='right'){
          const step=Math.min(17,(H-240)/Math.max(n,1));
          const startY=(H-(n-1)*step-54)/2;
          for(let i=0;i<n;i++) drawCard(cx,startY+i*step,hand[i],false,false,0.8);
        }
      }

      /* ── 桌面中央 ── */
      function drawTable(){
        // 清桌淡出殘影
        if(tableFade){
          ctx.save();
          ctx.globalAlpha=tableFade.alpha;
          drawCardsCenter(tableFade.cards,null);
          ctx.restore();
          tableFade.alpha-=0.015;
          if(tableFade.alpha<=0)tableFade=null;
        }
        if(!played)return;
        drawCardsCenter(played.cards,`${PLAYERS[playedBy]}　${TYPE_ZH[played.type]}`);
      }
      function drawCardsCenter(cards,label){
        const n=cards.length;
        const cw=46*1.15,gap=58;
        const totalW=(n-1)*gap+cw;
        const startX=W/2-totalW/2;
        const cy=H/2-50;
        if(label){
          ctx.font='bold 11px -apple-system,sans-serif';
          const tw=ctx.measureText(label).width;
          ctx.fillStyle='rgba(0,0,0,.55)';
          ctx.beginPath();ctx.roundRect(W/2-tw/2-10,cy-26,tw+20,18,9);ctx.fill();
          ctx.strokeStyle='rgba(245,196,0,.4)';ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(W/2-tw/2-10,cy-26,tw+20,18,9);ctx.stroke();
          ctx.fillStyle='rgba(245,196,0,.95)';
          ctx.textAlign='center';
          ctx.fillText(label,W/2,cy-13);
        }
        for(let i=0;i<n;i++) drawCard(startX+i*gap,cy,cards[i],false,true,1.15);
      }

      /* ── 玩家面板 ── */
      function drawPlayerPanel(idx,px,py,w,h){
        const isActive=currentPlayer===idx&&gamePhase==='playing';
        const isDone=finished.includes(idx);
        ctx.save();
        // 主動者外光圈
        if(isActive){
          ctx.shadowColor='rgba(245,196,0,.55)';ctx.shadowBlur=14;
        }
        const pg=ctx.createLinearGradient(px,py,px,py+h);
        if(isActive){pg.addColorStop(0,'rgba(70,56,8,.92)');pg.addColorStop(1,'rgba(40,32,4,.92)');}
        else if(isDone){pg.addColorStop(0,'rgba(50,50,55,.7)');pg.addColorStop(1,'rgba(30,30,34,.7)');}
        else{pg.addColorStop(0,'rgba(22,27,34,.92)');pg.addColorStop(1,'rgba(10,13,18,.92)');}
        ctx.fillStyle=pg;
        ctx.beginPath();ctx.roundRect(px,py,w,h,9);ctx.fill();
        ctx.shadowColor='transparent';ctx.shadowBlur=0;
        ctx.strokeStyle=isActive?'rgba(245,196,0,.75)':'rgba(255,255,255,.1)';
        ctx.lineWidth=isActive?1.5:1;
        ctx.beginPath();ctx.roundRect(px,py,w,h,9);ctx.stroke();
        // 頭像
        ctx.font='20px sans-serif';ctx.textAlign='left';
        ctx.globalAlpha=isDone?0.55:1;
        ctx.fillText(AVATARS[idx],px+7,py+h/2+8);
        ctx.globalAlpha=1;
        // 名字
        ctx.fillStyle=isActive?'#f5c400':isDone?'#777':'#e8e8e8';
        ctx.font=`${isActive?'bold ':''}12px -apple-system,sans-serif`;
        ctx.fillText(PLAYERS[idx],px+34,py+17);
        // 籌碼
        ctx.fillStyle='#f5c400';ctx.font='bold 11px monospace';
        ctx.fillText('$'+chips[idx],px+34,py+32);
        // 手牌數
        ctx.fillStyle=hands[idx].length<=3&&!isDone?'#ef5350':'#999';
        ctx.font='bold 10px monospace';
        ctx.textAlign='right';
        ctx.fillText(hands[idx].length+'張',px+w-8,py+17);
        // 最後動作
        if(lastAction[idx]&&!isDone){
          ctx.fillStyle=lastAction[idx]==='Pass'?'#7fa8d8':'#bbb';
          ctx.font='10px -apple-system,sans-serif';
          ctx.textAlign='right';
          ctx.fillText(lastAction[idx],px+w-8,py+32);
        }
        // 名次
        if(isDone){
          const rank=finished.indexOf(idx)+1;
          const medals=['🥇','🥈','🥉','💀'];
          ctx.font='16px sans-serif';ctx.textAlign='right';
          ctx.fillText(medals[rank-1]||rank,px+w-8,py+34);
        }
        // 出牌指示燈
        if(isActive){
          const pulse=0.5+Math.sin(fr*0.15)*0.5;
          ctx.fillStyle=`rgba(245,196,0,${pulse.toFixed(2)})`;
          ctx.beginPath();ctx.arc(px+w-10,py+h-9,4,0,Math.PI*2);ctx.fill();
        }
        ctx.restore();
      }

      /* ── 訊息 log ── */
      function drawLog(){
        ctx.save();
        ctx.fillStyle='rgba(0,0,0,.55)';
        ctx.beginPath();ctx.roundRect(8,8,212,96,8);ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,.06)';ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(8,8,212,96,8);ctx.stroke();
        msgLog.forEach((m,i)=>{
          ctx.fillStyle=i===0?'#ddd':`rgba(180,180,180,${Math.max(0.7-i*0.1,0.2)})`;
          ctx.font=(i===0?'bold ':'')+'10px -apple-system,sans-serif';
          ctx.textAlign='left';
          ctx.fillText(m,16,24+i*15,196);
        });
        ctx.restore();
      }

      /* ── 操作按鈕 ── */
      function drawBtn(b,enabled,baseA,baseB,borderC){
        ctx.save();
        const g=ctx.createLinearGradient(b.x,b.y,b.x+b.w,b.y+b.h);
        g.addColorStop(0,enabled?baseA:'#2a2a2a');
        g.addColorStop(1,enabled?baseB:'#1a1a1a');
        ctx.fillStyle=g;
        ctx.beginPath();ctx.roundRect(b.x,b.y,b.w,b.h,8);ctx.fill();
        ctx.strokeStyle=enabled?borderC:'rgba(80,80,80,.5)';
        ctx.lineWidth=1.5;
        ctx.beginPath();ctx.roundRect(b.x,b.y,b.w,b.h,8);ctx.stroke();
        ctx.fillStyle=enabled?'#fff':'#555';
        ctx.font='bold 13px -apple-system,sans-serif';
        ctx.textAlign='center';
        ctx.fillText(b.label,b.x+b.w/2,b.y+b.h/2+5);
        ctx.restore();
      }
      function drawButtons(){
        if(gamePhase==='playing'&&fastMode){
          drawBtn(BTNS.skip,true,'#7a4a14','#a06420','rgba(245,160,0,.6)');
        }
        if(currentPlayer!==0||gamePhase!=='playing')return;
        const canPlay=selectedCards.length>0;
        const canPass=played!==null&&playedBy!==0;
        drawBtn(BTNS.hint,true,'#5b4a14','#7a6420','rgba(245,196,0,.5)');
        drawBtn(BTNS.play,canPlay,'#c0392b','#e74c3c','rgba(231,76,60,.8)');
        drawBtn(BTNS.pass,canPass,'#2980b9','#3498db','rgba(52,152,219,.8)');
        drawBtn(BTNS.sort,true,'#3a3a4a','#4a4a5e','rgba(150,150,180,.4)');
        if(selectedCards.length>0)
          drawBtn(BTNS.cancel,true,'#4a4a4a','#5a5a5a','rgba(150,150,150,.4)');
        // 選牌牌型即時提示
        if(canPlay){
          const cl=classify(selectedCards);
          const ok=cl&&canBeat(played,cl)&&(!mustFirst||selectedCards.some(c=>c.r==='3'&&c.s==='♣'));
          ctx.fillStyle=ok?'rgba(120,220,120,.9)':'rgba(239,83,80,.9)';
          ctx.font='bold 11px -apple-system,sans-serif';
          ctx.textAlign='center';
          ctx.fillText(cl?`${TYPE_ZH[cl.type]}${ok?' ✓':' ✗壓不過'}`:'✗ 非法牌型',W/2,H-64);
        }
      }

      /* ── 主繪製 ── */
      function draw(){
        // 背景：暗室氛圍
        const bg=ctx.createRadialGradient(W/2,H/2,50,W/2,H/2,430);
        bg.addColorStop(0,'#171019');bg.addColorStop(1,'#07050a');
        ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);

        // 木質外框（雙橢圓夾層）
        const wood=ctx.createLinearGradient(W/2,H/2-265,W/2,H/2+265);
        wood.addColorStop(0,'#4a2f16');wood.addColorStop(.5,'#6b4423');wood.addColorStop(1,'#3a2410');
        ctx.fillStyle=wood;
        ctx.beginPath();ctx.ellipse(W/2,H/2,308,262,0,0,Math.PI*2);ctx.fill();
        ctx.save();
        ctx.shadowColor='rgba(0,0,0,.7)';ctx.shadowBlur=24;ctx.shadowOffsetY=6;
        ctx.strokeStyle='rgba(0,0,0,.4)';ctx.lineWidth=2;
        ctx.beginPath();ctx.ellipse(W/2,H/2,308,262,0,0,Math.PI*2);ctx.stroke();
        ctx.restore();
        // 金色滾邊
        const rim=ctx.createLinearGradient(W/2-290,H/2,W/2+290,H/2);
        rim.addColorStop(0,'#8b6914');rim.addColorStop(0.3,'#d4a017');
        rim.addColorStop(0.5,'#f5c400');rim.addColorStop(0.7,'#d4a017');rim.addColorStop(1,'#8b6914');
        ctx.strokeStyle=rim;ctx.lineWidth=2.5;
        ctx.beginPath();ctx.ellipse(W/2,H/2,292,248,0,0,Math.PI*2);ctx.stroke();

        // 絨布桌面（含頂光）
        const felt=ctx.createRadialGradient(W/2,H/2-80,20,W/2,H/2,330);
        felt.addColorStop(0,'#226b2e');felt.addColorStop(0.55,'#14491e');
        felt.addColorStop(0.85,'#0c3314');felt.addColorStop(1,'#07230d');
        ctx.fillStyle=felt;
        ctx.beginPath();ctx.ellipse(W/2,H/2,290,246,0,0,Math.PI*2);ctx.fill();
        // 內側壓邊陰影（立體感）
        ctx.save();
        ctx.beginPath();ctx.ellipse(W/2,H/2,290,246,0,0,Math.PI*2);ctx.clip();
        ctx.strokeStyle='rgba(0,0,0,.45)';ctx.lineWidth=14;
        ctx.beginPath();ctx.ellipse(W/2,H/2,295,251,0,0,Math.PI*2);ctx.stroke();
        ctx.restore();
        // 出牌定位線
        ctx.strokeStyle='rgba(245,196,0,.16)';ctx.lineWidth=1;
        ctx.setLineDash([5,6]);
        ctx.beginPath();ctx.ellipse(W/2,H/2,175,118,0,0,Math.PI*2);ctx.stroke();
        ctx.setLineDash([]);
        // 中央浮水印
        if(!played&&!tableFade&&gamePhase!=='dealing'){
          ctx.fillStyle='rgba(245,196,0,.07)';
          ctx.font='bold 52px Georgia,serif';
          ctx.textAlign='center';
          ctx.fillText('燈 燈',W/2,H/2+16);
          ctx.font='13px sans-serif';
          ctx.fillStyle='rgba(245,196,0,.1)';
          ctx.fillText('♠ ♥ ♣ ♦',W/2,H/2+42);
        }

        // 玩家面板
        drawPlayerPanel(0,8,H-68,150,56);        // 下（左下角）
        drawPlayerPanel(1,W/2-75,6,150,56);      // 上
        drawPlayerPanel(2,58,H/2-28,118,56);     // 左（牌列內側）
        drawPlayerPanel(3,W-176,H/2-28,118,56);  // 右（牌列內側）

        // 各家手牌
        drawHand(0,0,H-168,'bottom',true,selectedCards);
        drawHand(1,0,72,'top',false);
        drawHand(2,10,0,'left',false);
        drawHand(3,W-46,0,'right',false);

        // 發牌中：中央牌堆
        if(gamePhase==='dealing'){
          for(let i=0;i<3;i++)drawCard(W/2-23-i*2,H/2-34-i*2,null,false,false);
          ctx.fillStyle='rgba(245,196,0,.8)';
          ctx.font='bold 13px -apple-system,sans-serif';
          ctx.textAlign='center';
          ctx.fillText('發牌中…',W/2,H/2+72);
        }

        drawTable();
        drawLog();
        drawButtons();

        // 出牌滑入動畫
        for(let i=animCards.length-1;i>=0;i--){
          const ac=animCards[i];
          ctx.globalAlpha=Math.max(ac.alpha,0);
          drawCard(ac.x,ac.y,ac.card,false,true);
          ac.x+=(W/2-26-ac.x)*0.18;
          ac.y+=(H/2-50-ac.y)*0.18;
          ac.alpha-=0.04;
          if(ac.alpha<=0)animCards.splice(i,1);
        }
        ctx.globalAlpha=1;

        // AI思考
        if(currentPlayer!==0&&gamePhase==='playing'){
          const dots='.'.repeat(1+(Math.floor(fr/18)%3));
          ctx.fillStyle='rgba(245,196,0,.7)';
          ctx.font='bold 12px -apple-system,sans-serif';
          ctx.textAlign='center';
          ctx.fillText(`${PLAYERS[currentPlayer]} 思考中${dots}`,W/2,H/2+72);
        }
      }

      /* ── 主循環 ── */
      function loop(){
        if(!alive)return;
        fr++;
        if(gamePhase==='dealing'){
          dealT++;
          if(dealT>=110)onDealDone();
        }
        else if(gamePhase==='playing'&&currentPlayer!==0&&!finished.includes(currentPlayer)){
          aiThinkTimer--;
          if(aiThinkTimer<=0){
            const mustC3=mustFirst&&hands[currentPlayer].some(c=>c.r==='3'&&c.s==='♣');
            const result=smartAiPlay(currentPlayer,mustC3);
            if(result)playCards(currentPlayer,result.cards);
            else pass(currentPlayer);
            scheduleAI();
          }
        }
        draw();
        api.raf(loop);
      }

      /* ── 啟動 ── */
      api.showMsg('🃏 燈燈大老二',
        '梅花3持有者先手，首手必含梅花3\n同花順>鐵支可壓任意牌型\n💡提示鍵自動選牌・⇅可切換排序',
        [{label:'▶ 開始',red:true,fn:()=>{api.hideMsg();api.raf(loop);}}]
      );

      // splash-game.js 若有接 init 回傳值，可直接呼叫銷毀
      return destroy;
    }
  });
})();
