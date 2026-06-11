/**
 * game-bigTwoBloody.js — 血腥大老二（階級制魔改版）
 * 需在 splash-game.js 之前載入
 *
 * 魔改規則：
 *   - 第1局照常打，名次決定階級：👑國王 / 🎩貴族 / 🧑平民 / ⛓奴隸
 *   - 之後每局發牌完先進「交換階段」：
 *       國王 → 向其餘三人各指定拿1張（可看對方手牌），各丟回1張不要的
 *       貴族 → 向平民、奴隸各拿1張、各丟回1張
 *       平民 → 向奴隸拿1張、丟回1張
 *       奴隸 → 只能被拿，靠收到的廢牌翻身
 *   - 罰金：剩牌×5；13張沒出 ×3（取代10張規則）；剩牌≥10張 ×2；手上每張2 ×2
 *   - 地表暗黑：憤怒值（炸彈+15、13張沒出+20、包圍網成立+10、鎮壓+15、每張2 +2、每局+5）
 *       跨20門檻 →「N顆喬丹之石賣給了商人」跳訊，憤怒越高跳越快
 *       滿100 → 下局降臨，附身隨機AI（玩家不會被附身）：開局掠奪每人最大1張（無回贈）、
 *       免疫階級交換、AI全力模式；每局強制全員包圍網（玩家自動參戰）
 *       血量制：HP3，沒拿第1 -1、墊底 -2、拿第1 回1HP+向每人吸50元
 *       HP歸零 → 淨化：眾人+200元、憤怒歸零
 *   - 生命/魔法：每人 HP3、魔法3。補血術耗1魔法回1HP（AI 瀕死自動施放）。
 *       HP歸零=倒地：罰 200 元、下局以 1HP 爬起。魔法瓶一次回滿3魔法。
 *   - 道具欄3格（無限疊加）：🧪補血瓶+1HP / ⚗魔法瓶回滿 / 🌿解毒藥
 *   - 雜貨店：開場與每局結算可購買（對局中不可）；裝備店待補貨
 *   - 裝備欄5格（暗黑掉落，被動常駐）：
 *       🗡弒神之刃=地獄火免疫 / 🛡暗黑骨甲=傷害50%免除 / 👹暗黑面具=掠奪改搶最小
 *       💍喬丹之石=每局回1魔法 / 📿淨化護符=免疫中毒
 *   - 暗黑挑戰機制：
 *       地獄火：每局第一個壓過暗黑的人 -1HP 且最大1張被燒毀（出頭鳥懲罰）
 *       階段狂怒：掠奪張數 = 4-HP（殘血掠3張）
 *       HP1 腐化僕從：隨機AI變走狗（退出包圍網、餵牌、絕不壓主子）
 *       下毒：每局隨機毒1人，每局結束 -1HP 直到解毒
 *       討伐期限5局：失敗=全員籌碼砍半、暗黑滿血遁走、憤怒從50起跳
 *       弒神者：淨化局頭家 +500、下局直接當國王
 *   - 包圍網：連任2局以上的霸主有機率（2連勝60%、3連勝以上90%）被AI聯合討伐
 *       檄文公告「XXX暴政被討伐，史稱XXX包圍網」
 *       階級交換後，包圍網內牌力最強者向其他盟友各指定拿1張精銳、丟回1張廢牌
 *       對局中盟友對霸主全力壓制（霸主出牌或剩牌≤4張時改出最大牌）
 *
 * 基礎規則（沿用標準版）：
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
  const RANK_TITLES = ['👑 國王','🎩 貴族','🧑 平民','⛓ 奴隸'];

  /* 魔王池：憤怒滿百降臨時加權抽一隻。技能模組化，王=參數組合 */
  const BOSSES=[
    {id:'poring', w:50, name:'波利王',   icon:'🐷', prefix:'波利·', hp:2, plunder:1, rounds:4,
     skills:{},                                            purify:150,
     drops:['hpPotion','manaPotion','refine']},
    {id:'baph',   w:35, name:'巴風特',   icon:'🐐', prefix:'魔崽·', hp:3, plunder:2, rounds:5,
     skills:{hellfire:1,tax:1},                            purify:250,
     drops:['refine','refine','equip','hpPotion','rune']},
    {id:'diablo', w:15, name:'地表暗黑', icon:'😈', prefix:'暗黑·', hp:5, plunder:0, rounds:6,
     skills:{hellfire:1,poison:1,minion:1,tax:1,quake:1,plague:1,rage:1,shop:1}, purify:400,
     drops:['equip','equip','refine','rune']},
  ];
  function rollBoss(){
    const total=BOSSES.reduce((s,b)=>s+b.w,0);
    let r=Math.random()*total;
    for(const b of BOSSES){r-=b.w;if(r<=0)return b;}
    return BOSSES[0];
  }
  const EQ_NAMES={weapon:'🗡 弒神之刃',armor:'🛡 暗黑骨甲',helm:'👹 暗黑面具',ring:'💍 喬丹之石',amulet:'📿 淨化護符'};
  /* 裝備插槽：50% 無槽，否則 1~6（低槽機率高） */
  function rollSlots(){
    if(Math.random()<0.5)return 0;
    const w=[30,25,20,12,8,5];
    let r=Math.random()*100;
    for(let i=0;i<6;i++){r-=w[i];if(r<=0)return i+1;}
    return 1;
  }
  const RANK_EMOJI  = ['👑','🎩','🧑','⛓'];
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

  /* 血腥罰金：每張5元；13張沒出×3（取代10張規則）；≥10張×2；每張2再×2 */
  function handPenalty(hand){
    let base=hand.length*5;
    if(hand.length>=13)base*=3;
    else if(hand.length>=10)base*=2;
    for(const c of hand)if(c.r==='2')base*=2;
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
  /*
   * 存檔：雙軌
   *  1) IndexedDB：專用 DB「dengGames」store「saves」（onupgradeneeded 正確建立，
   *     原版開 stockDashboard/settings 不存在 → 存檔一直是靜默 no-op，已根治）
   *  2) Firebase（選配）：透過 window.__gameCloudSave / __gameCloudLoad 橋接，
   *     由 main.js 模組側掛上（遊戲檔是 classic script 無法 import firebase.js）。
   *     load 時比較 updatedAt 取較新者；save 時 IDB 立即寫 + 雲端 3 秒 debounce。
   */
  const SAVE_DB='dengGames', SAVE_STORE='saves', SAVE_KEY='bigtwo_bloody';
  function _openSaveDB(cb){
    try{
      const req=indexedDB.open(SAVE_DB,1);
      req.onupgradeneeded=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains(SAVE_STORE))
          db.createObjectStore(SAVE_STORE,{keyPath:'key'});
      };
      req.onsuccess=e=>cb(e.target.result);
      req.onerror=()=>cb(null);
    }catch(e){cb(null);}
  }
  function idbLoad(cb){
    _openSaveDB(db=>{
      if(!db){cb(null);return;}
      try{
        const r=db.transaction(SAVE_STORE,'readonly').objectStore(SAVE_STORE).get(SAVE_KEY);
        r.onsuccess=()=>cb(r.result?.data??null);
        r.onerror=()=>cb(null);
      }catch(e){cb(null);}
    });
  }
  function idbSave(data){
    _openSaveDB(db=>{
      if(!db)return;
      try{db.transaction(SAVE_STORE,'readwrite').objectStore(SAVE_STORE).put({key:SAVE_KEY,data});}catch(e){}
    });
  }
  let _cloudTimer=null;
  function loadChips(cb){
    // IDB + 雲端並讀，取 updatedAt 較新者
    idbLoad(local=>{
      const cloudFn=window.__gameCloudLoad;
      if(typeof cloudFn!=='function'){cb(local);return;}
      Promise.resolve(cloudFn(SAVE_KEY)).then(cloud=>{
        if(cloud&&(!local||(cloud.updatedAt||0)>(local.updatedAt||0))){
          idbSave(cloud); // 雲端較新 → 回寫本機
          cb(cloud);
        } else cb(local);
      }).catch(()=>cb(local));
    });
  }
  function saveChips(data){
    data.updatedAt=Date.now();
    idbSave(data);
    if(typeof window.__gameCloudSave==='function'){
      clearTimeout(_cloudTimer);
      _cloudTimer=setTimeout(()=>{
        try{window.__gameCloudSave(SAVE_KEY,data);}catch(e){}
      },3000);
    }
  }

  /* ══════════════════════════════════════
     六、遊戲主體
  ══════════════════════════════════════ */
  window.__GAMES = window.__GAMES || { _q: [], register(d){ this._q.push(d); } };
  window.__GAMES.register({
    id: 'bigTwoBloody',
    name: '🩸 血腥大老二',
    hint: '第1局定階級；之後國王吸牌、奴隸吃渣。點選手牌選牌，按出牌確認',
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
      let ranks=null;         // 上局名次 [playerIdx,...]，null=第1局
      let roundNum=1;
      let exTasks=[],exIdx=0,exStep='demand',exTimer=0; // 交換階段
      let streakWinner=-1, streak=0;  // 連勝追蹤
      let siege=null;                 // 包圍網 {target, allies, leader, done, bannerT}
      let anger=0;                    // 憤怒值 0~100（跨局累積）
      let sojTimer=120;               // 喬丹之石跳訊計時
      let diablo=null;                // 地表暗黑 {host, hp, bannerT, rounds, minion}
      let hp=[3,3,3,3], mana=[3,3,3,3], poisoned=[false,false,false,false];
      let items={hp:0,mana:0,anti:0};        // 玩家道具欄（3格無限疊）
      let equip={weapon:0,armor:0,helm:0,ring:0,amulet:0}; // 玩家裝備欄（5格，{lv,slots,cards}）
      let mats={refine:0,rune:0};      // 素材：精煉石/符文（P3 實裝用途）
      let quakeAt=-1,quakeT=0;         // 震動：本局排程幀/震動殘餘幀
      let plague=null;                 // 瘟疫 {t,tick,immune:[4]}
      let plagueAt=-1;
      let shopPause=false;             // 對局中開商店暫停
      let hellfireUsed=false;          // 本局地獄火已觸發
      let slayerNext=false;            // 弒神者：下局玩家直接當國王
      let fr=0;
      let alive=true;         // init 實例存活旗標（防舊 listener / loop 殘留）

      /* ── 按鈕區（draw 與 click 共用座標）── */
      /* 道具快捷列（右上，對局中可用） */
      const ITEM_BTNS=[
        {kind:'hp',   icon:'🧪', x:W-198, y:30, w:44, h:38},
        {kind:'mana', icon:'⚗', x:W-148, y:30, w:44, h:38},
        {kind:'anti', icon:'🌿', x:W-98,  y:30, w:44, h:38},
        {kind:'spell',icon:'✨', x:W-48,  y:30, w:44, h:38},
      ];
      const BTNS={
        hint:  {x:W/2-160, y:H-56, w:60, h:38, label:'💡提示'},
        play:  {x:W/2-92,  y:H-56, w:84, h:38, label:'出牌'},
        pass:  {x:W/2+8,   y:H-56, w:84, h:38, label:'Pass'},
        sort:  {x:W/2+100, y:H-56, w:60, h:38, label:'⇅排序'},
        cancel:{x:W-80,    y:H-56, w:72, h:38, label:'↩ 取消'},
        skip:  {x:W-128,   y:8,    w:120,h:32, label:'⏭ 跳到結算'},
      };
      const inBtn=(b,mx,my)=>mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h;

      /* ── 載入存檔 ── */
      function saveAll(){
        saveChips({chips:chips[0],hp:hp[0],mana:mana[0],items,equip,mats});
      }
      loadChips(v=>{
        if(!alive)return;
        if(v&&typeof v==='object'){
          chips[0]=v.chips??1000;
          hp[0]=v.hp??3; mana[0]=v.mana??3;
          items=Object.assign({hp:0,mana:0,anti:0},v.items);
          equip=Object.assign({weapon:0,armor:0,helm:0,ring:0,amulet:0},v.equip);
          mats=Object.assign({refine:0,rune:0},v.mats);
        } else if(typeof v==='number'){chips[0]=v;} // 舊版只存籌碼
        api.setScore(chips[0]);
        api.setHp(hp[0]);
        startRound();
      });

      /* 傷害（骨甲：玩家 50% 免除） */
      function damage(pidx,n,why){
        if(pidx===0&&equip.armor&&Math.random()<0.5){
          addLog(`🛡 骨甲擋下了${why||'傷害'}！`);return;
        }
        hp[pidx]=Math.max(0,hp[pidx]-n);
        addLog(`💔 ${PLAYERS[pidx]} ${why||''} -${n}HP（${hp[pidx]}/3）`);
        if(pidx===0)api.setHp(hp[0]);
      }
      function heal(pidx,n){
        hp[pidx]=Math.min(3,hp[pidx]+n);
        if(pidx===0)api.setHp(hp[0]);
      }
      /* 玩家用品 */
      function useItem(kind){
        if(kind==='hp'&&items.hp>0&&hp[0]<3){items.hp--;heal(0,1);addLog(`🧪 喝下補血瓶（${hp[0]}/3）`);}
        else if(kind==='mana'&&items.mana>0&&mana[0]<3){items.mana--;mana[0]=3;addLog('⚗ 魔法全滿（3/3）');}
        else if(kind==='anti'&&items.anti>0&&(poisoned[0]||(plague&&!plague.immune[0]))){
          items.anti--;
          if(poisoned[0]){poisoned[0]=false;addLog('🌿 毒素解除');}
          else{plague.immune[0]=true;addLog('🌿 服下解毒藥，本次毒霧免疫');}
        }
        else if(kind==='spell'&&mana[0]>0&&hp[0]<3){mana[0]--;heal(0,1);addLog(`✨ 補血術（HP ${hp[0]}/3・魔 ${mana[0]}/3）`);}
        else return;
        saveAll();
      }

      function sortHand0(){
        if(sortMode==='rank')sortByRank(hands[0]);
        else sortBySuit(hands[0]);
      }

      function startRound(){
        // 地表暗黑降臨判定（需已有階級，附身只挑AI）
        if(!diablo&&anger>=100&&ranks){
          const cfg=rollBoss();
          const host=1+Math.floor(Math.random()*3);
          diablo={cfg,host,hp:cfg.hp,bannerT:240,rounds:cfg.rounds,minion:-1};
          anger=0;
          addLog(`🔥 ${cfg.name}降臨!!`);
          addLog(`${cfg.icon} 附身於 ${PLAYERS[host]}`);
        }
        // 暗黑專屬事件排程（震動/瘟疫，本局隨機時刻）
        quakeAt=-1;plagueAt=-1;quakeT=0;
        if(diablo&&diablo.cfg.skills.quake&&Math.random()<0.7)
          quakeAt=400+Math.floor(Math.random()*1200);
        if(diablo&&diablo.cfg.skills.plague&&Math.random()<0.35)
          plagueAt=400+Math.floor(Math.random()*1200);
        hellfireUsed=false;
        if(equip.ring&&mana[0]<3){mana[0]++;addLog('💍 喬丹之石：回復1魔法');}
        if(slayerNext&&ranks){
          ranks=[0,...ranks.filter(i=>i!==0)];
          addLog('👑 弒神者餘威：你直接就任國王！');
          slayerNext=false;
        }
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
        fastMode=false;
        playedRecord=[];
        msgLog=[];
        dealT=0;
        gamePhase='dealing';
        currentPlayer=hands.findIndex(h=>h.some(c=>c.r==='3'&&c.s==='♣'));
      }

      function onDealDone(){
        if(diablo)diabloPlunder();
        if(ranks)startExchange();
        else startPlaying();
      }

      /* 魔王開局掠奪：rage技能=越殘血掠越多；面具改搶玩家最小；poison技能=隨機下毒 */
      function diabloPlunder(){
        const h=diablo.host;
        const n=diablo.cfg.skills.rage
          ?Math.min(3,Math.max(1,diablo.cfg.hp+1-diablo.hp))
          :diablo.cfg.plunder;
        if(n<=0)return;
        for(let i=0;i<4;i++){
          if(i===h)continue;
          const taken=[];
          for(let k=0;k<n&&hands[i].length>1;k++){
            const sorted=[...hands[i]].sort((a,b)=>(a.v*4+a.sv)-(b.v*4+b.sv));
            const take=(i===0&&equip.helm)?sorted[0]:sorted[sorted.length-1];
            moveCard(i,h,take);
            taken.push(take.r+take.s);
          }
          if(i===0)addLog(`${diablo.cfg.icon} ${diablo.cfg.name}掠奪你的 ${taken.join(' ')}${equip.helm?'（👹面具：只搶到最小）':'！'}`);
          else addLog(`${diablo.cfg.icon} ${diablo.cfg.name}掠奪 ${PLAYERS[i]} ${taken.length}張`);
        }
        // 下毒（限有 poison 技能的王）
        if(!diablo.cfg.skills.poison)return;
        const targets=[0,1,2,3].filter(i=>i!==h&&!poisoned[i]&&!(i===0&&equip.amulet));
        if(targets.length){
          const t=targets[Math.floor(Math.random()*targets.length)];
          poisoned[t]=true;
          addLog(`☠ ${PLAYERS[t]} 中了${diablo.cfg.name}之毒！（每局結束-1HP，需解毒藥）`);
        }
      }

      function startPlaying(){
        gamePhase='playing';
        // 交換可能讓梅花3易手，重新定位
        currentPlayer=hands.findIndex(h=>h.some(c=>c.r==='3'&&c.s==='♣'));
        addLog(`${PLAYERS[currentPlayer]} 先出（持有梅花3）`);
        if(currentPlayer!==0)scheduleAI();
      }

      /* ══ 交換階段 ══ */
      function startExchange(){
        gamePhase='exchange';
        exTasks=[];
        // 高階向所有低階各拿1張：國王→3人、貴族→2人、平民→1人
        for(let r=0;r<3;r++)
          for(let t=r+1;t<4;t++){
            if(diablo&&(ranks[r]===diablo.host||ranks[t]===diablo.host))continue; // 暗黑免疫交換
            exTasks.push({from:ranks[r],to:ranks[t]});
          }
        exIdx=0; exStep='demand'; exTimer=40;
        addLog(`🩸 第${roundNum}局 階級交換開始`);

        // 包圍網成立判定
        siege=null;
        if(diablo){
          // 地表暗黑肆虐：強制全員包圍網，玩家自動參戰
          siege={target:diablo.host,
                 allies:[0,1,2,3].filter(i=>i!==diablo.host&&i!==diablo.minion),
                 leader:-1,done:false,bannerT:0,pending:false};
          addLog(`⚔ 全員圍攻${diablo.cfg.name}！`);
          if(diablo.minion>=0)addLog(`🧟 ${PLAYERS[diablo.minion]} 已被腐化，叛離討伐軍…`);
        }
        else if(streak>=2){
          const prob=streak>=3?0.9:0.6;
          if(Math.random()<prob){
            const target=streakWinner;
            const allies=[1,2,3].filter(i=>i!==target); // 只有 AI 會結盟
            if(allies.length>=2){
              siege={target,allies,leader:-1,done:false,bannerT:200,pending:target!==0};
              exTimer=210; // 檄文播完再開始交換
              addAnger(10);
              addLog(`📜 檄文！${PLAYERS[target]}暴政被討伐`);
              addLog(`⚔ 史稱「${PLAYERS[target]}包圍網」`);
              if(siege.pending)askJoinSiege();
            }
          }
        }
      }

      /* 憤怒值：地表暗黑肆虐期間凍結；跨20門檻立即跳一則喬丹之石 */
      function addAnger(n){
        if(diablo)return;
        const before=anger;
        anger=Math.min(100,anger+n);
        if(Math.floor(anger/20)>Math.floor(before/20))
          addLog(`💎 ${1+Math.floor(Math.random()*Math.max(anger,5))} 顆喬丹之石賣給了商人`);
      }

      /* 手牌牌力（包圍網選盟主用）：大牌價值 + 三條/鐵支加成 */
      function handPower(h){
        let s=0; const cnt={};
        for(const c of h){s+=Math.max(0,c.v-6); cnt[c.v]=(cnt[c.v]||0)+1;}
        for(const k in cnt){
          if(cnt[k]===4)s+=10;
          else if(cnt[k]===3)s+=3;
        }
        return s;
      }

      function askJoinSiege(){
        api.showMsg('📜 討伐檄文',
          `${PLAYERS[siege.target]}暴政，天下共擊之 —— 是否加入「${PLAYERS[siege.target]}包圍網」？`,
          [
            {label:'⚔ 加入討伐',red:true,fn:()=>{
              siege.allies.push(0);siege.pending=false;api.hideMsg();
              addLog('⚔ 你加入了包圍網！');
            }},
            {label:'🕊 袖手旁觀',fn:()=>{
              siege.pending=false;api.hideMsg();
              addLog('🕊 你選擇袖手旁觀');
            }},
          ]);
      }

      function moveCard(from,to,card){
        const id=cardId(card);
        hands[from]=hands[from].filter(c=>cardId(c)!==id);
        hands[to].push(card);
        sortByRank(hands[to]);
        if(to===0||from===0)sortHand0();
      }

      function finishExchange(){
        // 階級交換結束後，包圍網內部再換一輪：盟主吸收盟友精銳
        if(siege&&!siege.done){
          siege.done=true;
          let leader=siege.allies[0];
          for(const a of siege.allies)
            if(handPower(hands[a])>handPower(hands[leader]))leader=a;
          siege.leader=leader;
          addLog(`🗡 ${PLAYERS[leader]} 被推為盟主，盟友獻上精銳`);
          for(const a of siege.allies)
            if(a!==leader)exTasks.push({from:leader,to:a,siege:true});
          exTimer=45;
          return; // 留在交換階段跑完密謀任務
        }
        addLog('🤝 交換結束，開打！');
        startPlaying();
      }

      /* 玩家在交換階段點擊 */
      function exchangeClick(mx,my){
        const task=exTasks[exIdx];
        if(!task||task.from!==0)return;
        if(exStep==='demand'){
          const th=hands[task.to];
          const pos=exGridPos(th.length);
          for(let i=0;i<th.length;i++){
            const p=pos[i];
            if(mx>=p.x&&mx<=p.x+46&&my>=p.y&&my<=p.y+68){
              const take=th[i];
              moveCard(task.to,0,take);
              addLog(`你向 ${PLAYERS[task.to]} 拿走 ${take.r}${take.s}`);
              exStep='give';
              return;
            }
          }
        } else { // give：點自己手牌丟一張
          const hand=hands[0];
          const cw=46*1.25,ch=68*1.25;
          const maxSpread=Math.min((hand.length-1)*36+cw,W-50);
          const step=hand.length>1?(maxSpread-cw)/(hand.length-1):0;
          const startX=(W-maxSpread)/2;
          for(let i=hand.length-1;i>=0;i--){
            const cx=startX+i*step;
            const cy=H-168;
            if(mx>=cx&&mx<=cx+cw&&my>=cy&&my<=cy+ch){
              const give=hand[i];
              moveCard(0,exTasks[exIdx].to,give);
              addLog(`你丟 ${give.r}${give.s} 給 ${PLAYERS[exTasks[exIdx].to]}`);
              exIdx++; exStep='demand'; exTimer=40;
              return;
            }
          }
        }
      }

      /* 對方手牌攤開的格狀座標（兩排） */
      function exGridPos(n){
        const pos=[];
        const perRow=Math.ceil(n/2);
        const gap=Math.min(50,(W-160)/Math.max(perRow,1));
        for(let i=0;i<n;i++){
          const row=i<perRow?0:1;
          const col=row===0?i:i-perRow;
          const rowN=row===0?perRow:n-perRow;
          const startX=W/2-((rowN-1)*gap+46)/2;
          pos.push({x:startX+col*gap,y:H/2-150+row*82});
        }
        return pos;
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
        const wasDiabloPlay=diablo&&played&&playedBy===diablo.host&&pidx!==diablo.host;

        const ids=cards.map(cardId);
        hands[pidx]=hands[pidx].filter(c=>!ids.includes(cardId(c)));
        played=cl; playedBy=pidx; passCount=0; mustFirst=false;
        playedRecord.push(...cards);
        if(cl.type==='fourOfAKind'||cl.type==='straightFlush')addAnger(15);
        addAnger(cards.filter(c=>c.r==='2').length*2);
        // 地獄火：本局第一個壓過魔王的人挨燒（限有 hellfire 技能）
        if(wasDiabloPlay&&!hellfireUsed&&diablo.cfg.skills.hellfire){
          hellfireUsed=true;
          if(pidx===0&&equip.weapon){
            addLog('🗡 弒神之刃格擋了地獄火！');
          } else if(hands[pidx].length){
            const sorted=[...hands[pidx]].sort((a,b)=>(a.v*4+a.sv)-(b.v*4+b.sv));
            const burn=sorted[sorted.length-1];
            const bid=cardId(burn);
            hands[pidx]=hands[pidx].filter(c=>cardId(c)!==bid);
            if(pidx===0)sortHand0();
            addLog(`🔥 地獄火！${PLAYERS[pidx]} 的 ${burn.r}${burn.s} 被燒毀`);
            damage(pidx,1,'被地獄火灼傷');
          }
        }
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
          if(pick.cl.key>=48&&(pick.cl.type==='single'||pick.cl.type==='pair')
             &&!(diablo&&diablo.host===pidx)&&Math.random()<0.45)return null;
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
        saveAll();
        api.setScore(chips[0]);

        // 中毒結算
        let diabloLine='';
        for(let i=0;i<4;i++)if(poisoned[i]){
          damage(i,1,'毒發');
          diabloLine+=`\n☠ ${PLAYERS[i]} 毒發 -1HP`;
        }
        // 地表暗黑結算（HP制）
        if(diablo){
          const h=diablo.host, cfg=diablo.cfg;
          if(finished[0]===h){
            diablo.hp=Math.min(cfg.hp,diablo.hp+1);
            if(cfg.skills.tax){
              for(let i=0;i<4;i++)if(i!==h){
                chips[i]=Math.max(0,chips[i]-50);chips[h]+=50;
                damage(i,1,`被${cfg.name}吞噬生命`);
              }
              diabloLine+=`\n${cfg.icon} ${cfg.name}奪冠！吸取眾人 50元+1HP，回復至 ${diablo.hp}/${cfg.hp} HP`;
            } else {
              diabloLine+=`\n${cfg.icon} ${cfg.name}奪冠！回復至 ${diablo.hp}/${cfg.hp} HP`;
            }
          } else {
            const dmg=finished[3]===h?2:1;
            diablo.hp-=dmg;
            diabloLine+=`\n⚔ ${cfg.name}受創 -${dmg}HP（${Math.max(diablo.hp,0)}/${cfg.hp}）`;
            // 掉落：傷它一次依掉落表掉給頭家
            if(finished[0]===0){
              const kind=cfg.drops[Math.floor(Math.random()*cfg.drops.length)];
              if(kind==='equip'){
                const empty=Object.keys(equip).filter(k=>!equip[k]);
                if(empty.length){
                  const slot=empty[Math.floor(Math.random()*empty.length)];
                  const slots=rollSlots();
                  equip[slot]={lv:0,slots,cards:[]};
                  diabloLine+=`\n✨ 掉落【${EQ_NAMES[slot]}${slots?`〔${slots}孔〕`:''}】！已自動裝備`;
                } else {mats.refine++;diabloLine+='\n💠 掉落精煉石×1（裝備已滿）';}
              }
              else if(kind==='refine'){mats.refine++;diabloLine+=`\n💠 掉落精煉石×1（共${mats.refine}）`;}
              else if(kind==='rune'){mats.rune++;diabloLine+=`\nᚱ 掉落符文×1（共${mats.rune}）`;}
              else if(kind==='hpPotion'){items.hp++;diabloLine+='\n🧪 掉落補血瓶×1';}
              else if(kind==='manaPotion'){items.mana++;diabloLine+='\n⚗ 掉落魔法瓶×1';}
            } else {
              diabloLine+=`\n🎒 掉落物被 ${PLAYERS[finished[0]]} 撿走了…`;
            }
            if(cfg.skills.minion&&diablo.hp===1&&diablo.minion<0){
              const cands=[1,2,3].filter(i=>i!==h);
              diablo.minion=cands[Math.floor(Math.random()*cands.length)];
              diabloLine+=`\n🧟 ${cfg.name}垂死掙扎，腐化 ${PLAYERS[diablo.minion]} 為僕從！`;
            }
            if(diablo.hp<=0){
              for(let i=0;i<4;i++)if(i!==h)chips[i]+=cfg.purify;
              diabloLine+=`\n⚱ ${cfg.name}被淨化！倖存者各獲 ${cfg.purify} 元`;
              if(finished[0]===0){
                chips[0]+=500;slayerNext=true;
                diabloLine+='\n👑 你是弒神者！+500 元，下局直接就任國王';
              } else {
                diabloLine+=`\n👑 ${PLAYERS[finished[0]]} 成為弒神者`;
              }
              diablo=null;
            }
          }
          // 討伐期限
          if(diablo){
            diablo.rounds--;
            if(diablo.rounds<=0){
              for(let i=0;i<4;i++)chips[i]=Math.floor(chips[i]/2);
              anger=50;
              diabloLine+=`\n💀 討伐失敗！${diablo.cfg.name}吞噬全場：籌碼砍半、滿血遁走（憤怒50起跳）`;
              diablo=null;
            } else {
              diabloLine+=`\n⏳ 討伐期限：剩 ${diablo.rounds} 局`;
            }
          }
          siege=null; // 強制圍攻已消化，不印一般包圍網結語
        }
        // 一般局頭家撿寶（無魔王時 15%）
        if(!diablo&&finished[0]===0&&Math.random()<0.15){
          const k=['hp','mana','anti'][Math.floor(Math.random()*3)];
          items[k]++;
          const N={hp:'🧪 補血瓶',mana:'⚗ 魔法瓶',anti:'🌿 解毒藥'};
          diabloLine+=`\n🎁 路邊撿到 ${N[k]}×1`;
        }
        // 倒地懲罰
        for(let i=0;i<4;i++)if(hp[i]<=0){
          chips[i]=Math.max(0,chips[i]-200);
          hp[i]=1;
          if(i===0)api.setHp(1);
          diabloLine+=`\n🏳 ${PLAYERS[i]} 倒地！-200元，下局以 1HP 爬起`;
        }
        addAnger(5); // 每局結束
        for(let rank=1;rank<4;rank++)
          if(hands[finished[rank]].length>=13)addAnger(20);
        // 包圍網結局判定（在連勝更新前）
        let siegeLine='';
        if(siege){
          if(siege.target===finished[0]){
            siegeLine=`\n💢 ${PLAYERS[siege.target]} 鎮壓包圍網，連任成功！`;
            addAnger(15);
          } else {
            siegeLine=`\n⚔ 包圍網成功，${PLAYERS[siege.target]} 暴政終結`;
          }
          siege=null;
        }
        // 連勝統計
        if(finished[0]===streakWinner)streak++;
        else{streakWinner=finished[0];streak=1;}
        if(streak>=2)siegeLine+=`\n🔥 ${PLAYERS[streakWinner]} ${streak}連霸中，小心包圍網…`;
        ranks=finished.slice();
        roundNum++;
        const resultLines=finished.map((pidx,rank)=>{
          const delta=rank===0?`+${pot}`:`-${penalties[pidx]}`;
          const cardsLeft=rank===0?'':`（剩${hands[pidx].length}張）`;
          return `${RANK_TITLES[rank]}　${PLAYERS[pidx]} ${delta}元${cardsLeft} → ${chips[pidx]}元`;
        }).join('\n')+diabloLine+siegeLine+'\n\n下一局開打前進行階級交換';

        if(chips[0]<=0){
          api.showMsg('破產了 😭',`籌碼歸零！\n\n${resultLines}`,[
            {label:'重新開始(1000元)',red:true,fn:()=>{chips[0]=1000;saveAll();api.hideMsg();startNewGame();}},
            {label:'看盤去',fn:()=>{window.__closeGame();window.__hideSplash&&window.__hideSplash();}},
          ]);
        } else {
          const showResult=()=>api.showMsg('本局結算',resultLines,[
            {label:'▶ 下一局',red:true,fn:()=>{api.hideMsg();startNewGame();}},
            {label:'🛒 雜貨店',fn:()=>openShop(showResult)},
            {label:'🎒 裝備',fn:()=>openBag(showResult)},
            {label:'看盤去',fn:()=>{window.__closeGame();window.__hideSplash&&window.__hideSplash();}},
          ]);
          showResult();
        }
      }

      function startNewGame(){
        for(let i=1;i<4;i++){if(chips[i]<=0)chips[i]=1000;} // 破產AI補新人
        startRound();
      }

      /* ── 玩家操作 ── */
      function onClick(e){
        if(!alive)return;
        if(gamePhase!=='playing'&&gamePhase!=='exchange')return;
        const r=canvas.getBoundingClientRect();
        const mx=(e.clientX-r.left)*(W/r.width);
        const my=(e.clientY-r.top)*(H/r.height);

        // 道具/施法（playing 與 exchange 皆可用）
        for(const b of ITEM_BTNS){
          if(mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h){useItem(b.kind);return;}
        }
        // 魔王肆虐：商店常開（暫停遊戲）
        if(diablo&&diablo.cfg.skills.shop&&mx>=8&&mx<=100&&my>=110&&my<=140){
          shopPause=true;
          openShop(()=>{api.hideMsg();shopPause=false;});
          return;
        }
        if(gamePhase==='exchange'){exchangeClick(mx,my);return;}
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

      /* ── 交換階段畫面 ── */
      function drawExchange(){
        const task=exTasks[exIdx];
        if(!task)return;
        // 橫幅
        let banner;
        if(task.from===0){
          banner=exStep==='demand'
            ?`👑 向 ${PLAYERS[task.to]} 指定拿一張（點對方的牌）`
            :`選一張不要的牌丟給 ${PLAYERS[task.to]}（點自己的牌）`;
        } else {
          banner=`${RANK_EMOJI[ranks.indexOf(task.from)]} ${PLAYERS[task.from]} 交換中…`;
        }
        ctx.save();
        ctx.font='bold 14px -apple-system,sans-serif';
        const tw=ctx.measureText(banner).width;
        ctx.fillStyle='rgba(0,0,0,.65)';
        ctx.beginPath();ctx.roundRect(W/2-tw/2-16,H/2-205,tw+32,30,15);ctx.fill();
        ctx.strokeStyle='rgba(239,83,80,.5)';ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(W/2-tw/2-16,H/2-205,tw+32,30,15);ctx.stroke();
        ctx.fillStyle='#f5c400';ctx.textAlign='center';
        ctx.fillText(banner,W/2,H/2-185);
        ctx.restore();
        // 玩家要牌：攤開對方手牌
        if(task.from===0&&exStep==='demand'){
          const th=hands[task.to];
          const pos=exGridPos(th.length);
          for(let i=0;i<th.length;i++)
            drawCard(pos[i].x,pos[i].y,th[i],false,true);
        }
      }

      /* ── 包圍網狀態 ── */
      function drawSiege(){
        if(diablo){drawDiabloHud();return;}
        if(!siege)return;
        // 進行中小標
        ctx.save();
        const tag=`⚔ ${PLAYERS[siege.target]}包圍網進行中`;
        ctx.font='bold 11px -apple-system,sans-serif';
        const tw=ctx.measureText(tag).width;
        ctx.fillStyle='rgba(120,10,10,.8)';
        ctx.beginPath();ctx.roundRect(W/2-tw/2-10,H-26,tw+20,20,10);ctx.fill();
        ctx.fillStyle='#ffb3b0';ctx.textAlign='center';
        ctx.fillText(tag,W/2,H-12);
        // 檄文大橫幅
        if(siege.bannerT>0){
          siege.bannerT--;
          const a=Math.min(1,siege.bannerT/40,(200-siege.bannerT)/25+1);
          ctx.globalAlpha=Math.max(0,Math.min(a,1));
          const g=ctx.createLinearGradient(0,H/2-70,0,H/2+70);
          g.addColorStop(0,'rgba(60,5,5,0)');g.addColorStop(.5,'rgba(110,8,8,.92)');g.addColorStop(1,'rgba(60,5,5,0)');
          ctx.fillStyle=g;
          ctx.fillRect(0,H/2-70,W,140);
          ctx.strokeStyle='rgba(245,196,0,.5)';ctx.lineWidth=1;
          ctx.beginPath();ctx.moveTo(40,H/2-44);ctx.lineTo(W-40,H/2-44);ctx.stroke();
          ctx.beginPath();ctx.moveTo(40,H/2+48);ctx.lineTo(W-40,H/2+48);ctx.stroke();
          ctx.fillStyle='#ffd9b0';
          ctx.font='bold 24px Georgia,serif';ctx.textAlign='center';
          ctx.fillText(`📜 ${PLAYERS[siege.target]}暴政，天下共擊之！`,W/2,H/2-8);
          ctx.fillStyle='#f5c400';
          ctx.font='bold 17px Georgia,serif';
          ctx.fillText(`—— 史稱「${PLAYERS[siege.target]}包圍網」——`,W/2,H/2+28);
          ctx.globalAlpha=1;
        }
        ctx.restore();
      }

      /* ── 地表暗黑 HUD ── */
      function drawDiabloHud(){
        ctx.save();
        // 底部常駐標
        const tag=`${diablo.cfg.icon} ${diablo.cfg.name}肆虐中（剩${diablo.rounds}局）　${'❤'.repeat(Math.max(diablo.hp,0))}${'🖤'.repeat(Math.max(diablo.cfg.hp-diablo.hp,0))}`;
        ctx.font='bold 12px -apple-system,sans-serif';
        const tw=ctx.measureText(tag).width;
        ctx.fillStyle='rgba(70,5,5,.88)';
        ctx.beginPath();ctx.roundRect(W/2-tw/2-12,H-28,tw+24,22,11);ctx.fill();
        ctx.strokeStyle='rgba(239,83,80,.6)';ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(W/2-tw/2-12,H-28,tw+24,22,11);ctx.stroke();
        ctx.fillStyle='#ff8a80';ctx.textAlign='center';
        ctx.fillText(tag,W/2,H-13);
        // 降臨大橫幅
        if(diablo.bannerT>0){
          diablo.bannerT--;
          const a=Math.min(1,diablo.bannerT/50);
          ctx.globalAlpha=Math.max(0,a);
          const g=ctx.createLinearGradient(0,H/2-90,0,H/2+90);
          g.addColorStop(0,'rgba(30,0,0,0)');g.addColorStop(.5,'rgba(60,0,0,.95)');g.addColorStop(1,'rgba(30,0,0,0)');
          ctx.fillStyle=g;
          ctx.fillRect(0,H/2-90,W,180);
          ctx.fillStyle='#ff3b30';
          ctx.font='bold 34px Georgia,serif';ctx.textAlign='center';
          ctx.fillText(`🔥 ${diablo.cfg.name.split('').join(' ')} 降 臨 !!`,W/2,H/2-6);
          ctx.fillStyle='#ffab91';
          ctx.font='bold 16px Georgia,serif';
          ctx.fillText(`${diablo.cfg.icon} 附身於 ${PLAYERS[diablo.host]}`,W/2,H/2+34);
          ctx.globalAlpha=1;
        }
        ctx.restore();
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
        const isDiabloHost=diablo&&diablo.host===idx;
        const isMinion=diablo&&diablo.minion===idx;
        const pg=ctx.createLinearGradient(px,py,px,py+h);
        if(isDiabloHost){pg.addColorStop(0,'rgba(70,8,8,.95)');pg.addColorStop(1,'rgba(25,2,2,.95)');}
        else if(isMinion){pg.addColorStop(0,'rgba(45,15,60,.95)');pg.addColorStop(1,'rgba(18,5,26,.95)');}
        else if(isActive){pg.addColorStop(0,'rgba(70,56,8,.92)');pg.addColorStop(1,'rgba(40,32,4,.92)');}
        else if(isDone){pg.addColorStop(0,'rgba(50,50,55,.7)');pg.addColorStop(1,'rgba(30,30,34,.7)');}
        else{pg.addColorStop(0,'rgba(22,27,34,.92)');pg.addColorStop(1,'rgba(10,13,18,.92)');}
        ctx.fillStyle=pg;
        ctx.beginPath();ctx.roundRect(px,py,w,h,9);ctx.fill();
        ctx.shadowColor='transparent';ctx.shadowBlur=0;
        const isSiegeTarget=(siege&&siege.target===idx)||isDiabloHost;
        ctx.strokeStyle=isSiegeTarget?'rgba(239,83,80,.85)':isActive?'rgba(245,196,0,.75)':'rgba(255,255,255,.1)';
        ctx.lineWidth=(isActive||isSiegeTarget)?1.5:1;
        ctx.beginPath();ctx.roundRect(px,py,w,h,9);ctx.stroke();
        // 頭像
        ctx.font='20px sans-serif';ctx.textAlign='left';
        ctx.globalAlpha=isDone?0.55:1;
        ctx.fillText(isDiabloHost?diablo.cfg.icon:isMinion?'🧟':AVATARS[idx],px+7,py+h/2+8);
        ctx.globalAlpha=1;
        // 名字
        ctx.fillStyle=isDiabloHost?'#ff6659':isActive?'#f5c400':isDone?'#777':'#e8e8e8';
        ctx.font=`${(isActive||isDiabloHost)?'bold ':''}12px -apple-system,sans-serif`;
        ctx.fillText((isDiabloHost?diablo.cfg.prefix:isMinion?'僕從·':'')+PLAYERS[idx]+(poisoned[idx]?' ☠':''),px+34,py+17);
        // 籌碼 + 生命/魔法
        ctx.fillStyle='#f5c400';ctx.font='bold 11px monospace';
        ctx.fillText('$'+chips[idx],px+34,py+32);
        if(!isDiabloHost){
          ctx.font='8px sans-serif';
          ctx.fillStyle='#ef5350';
          ctx.fillText('❤'.repeat(Math.max(hp[idx],0)),px+34,py+45);
          ctx.fillStyle='#64b5f6';
          ctx.fillText('⚡'.repeat(Math.max(mana[idx],0)),px+34+hp[idx]*9+4,py+45);
        }
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
        // 階級徽章 / 宿主HP
        if(isDiabloHost){
          ctx.font='11px sans-serif';ctx.textAlign='right';
          ctx.fillText('❤'.repeat(Math.max(diablo.hp,0))+'🖤'.repeat(Math.max(diablo.cfg.hp-diablo.hp,0)),px+w-8,py+50);
        } else if(ranks){
          ctx.font='13px sans-serif';ctx.textAlign='right';
          ctx.fillText(RANK_EMOJI[ranks.indexOf(idx)],px+w-8,py+50);
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
        // 降臨震動
        let shook=false;
        if(diablo&&(diablo.bannerT>0||quakeT>0)){
          const amp=quakeT>0?14:9;
          ctx.save();
          ctx.translate((Math.random()-0.5)*amp,(Math.random()-0.5)*amp);
          shook=true;
        }
        // 背景：暗室氛圍（暗黑肆虐時轉血色）
        const bg=ctx.createRadialGradient(W/2,H/2,50,W/2,H/2,430);
        if(diablo){bg.addColorStop(0,'#241015');bg.addColorStop(1,'#0d0508');}
        else{bg.addColorStop(0,'#171019');bg.addColorStop(1,'#07050a');}
        ctx.fillStyle=bg;ctx.fillRect(-12,-12,W+24,H+24);

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
        if(!played&&!tableFade&&gamePhase==='playing'){
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

        if(gamePhase==='exchange')drawExchange();
        else drawTable();
        drawSiege();
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
        // 瘟疫毒霧
        if(plague){
          ctx.save();
          const pulse=0.10+Math.sin(fr*0.1)*0.05;
          ctx.fillStyle=`rgba(110,30,160,${(0.12+pulse).toFixed(2)})`;
          ctx.fillRect(-12,-12,W+24,H+24);
          ctx.fillStyle='rgba(200,140,255,.85)';
          ctx.font='bold 12px -apple-system,sans-serif';ctx.textAlign='center';
          ctx.fillText(`☣ 毒霧蔓延 ${Math.ceil(plague.t/60)}s${plague.immune[0]?'（你已免疫）':''}`,W/2,52);
          ctx.restore();
        }
        drawAngerBar();
        drawItemBar();
        if(shook)ctx.restore();
      }

      /* 道具快捷列 */
      function drawItemBar(){
        // 魔王肆虐：常開商店鈕
        if(diablo&&diablo.cfg.skills.shop&&(gamePhase==='playing'||gamePhase==='exchange')){
          ctx.save();
          ctx.fillStyle='rgba(40,30,12,.9)';
          ctx.beginPath();ctx.roundRect(8,110,92,30,8);ctx.fill();
          ctx.strokeStyle='rgba(245,196,0,.5)';ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(8,110,92,30,8);ctx.stroke();
          ctx.fillStyle='#f5c400';ctx.font='bold 12px -apple-system,sans-serif';
          ctx.textAlign='center';
          ctx.fillText('🛒 商店',54,130);
          ctx.restore();
        }
        if(gamePhase==='result'||gamePhase==='loading')return;
        const counts={hp:items.hp,mana:items.mana,anti:items.anti,spell:mana[0]};
        const usable={
          hp:items.hp>0&&hp[0]<3,
          mana:items.mana>0&&mana[0]<3,
          anti:items.anti>0&&(poisoned[0]||(plague&&!plague.immune[0])),
          spell:mana[0]>0&&hp[0]<3,
        };
        ctx.save();
        for(const b of ITEM_BTNS){
          const on=usable[b.kind];
          ctx.fillStyle=on?'rgba(40,30,12,.9)':'rgba(18,18,22,.75)';
          ctx.beginPath();ctx.roundRect(b.x,b.y,b.w,b.h,7);ctx.fill();
          ctx.strokeStyle=on?'rgba(245,196,0,.55)':'rgba(255,255,255,.08)';
          ctx.lineWidth=1;
          ctx.beginPath();ctx.roundRect(b.x,b.y,b.w,b.h,7);ctx.stroke();
          ctx.globalAlpha=on?1:0.4;
          ctx.font='16px sans-serif';ctx.textAlign='center';
          ctx.fillText(b.icon,b.x+b.w/2,b.y+20);
          ctx.globalAlpha=1;
          ctx.fillStyle=on?'#f5c400':'#666';
          ctx.font='bold 9px monospace';
          ctx.fillText(b.kind==='spell'?`魔${counts[b.kind]}`:'×'+counts[b.kind],b.x+b.w/2,b.y+33);
        }
        ctx.restore();
      }

      /* 憤怒值條（右上） */
      function drawAngerBar(){
        if(diablo||anger<=0)return;
        const x=228,y=10,w=138,h=12;
        ctx.save();
        ctx.fillStyle='rgba(0,0,0,.5)';
        ctx.beginPath();ctx.roundRect(x,y,w,h,6);ctx.fill();
        const g=ctx.createLinearGradient(x,y,x+w,y);
        g.addColorStop(0,'#7a3010');g.addColorStop(1,'#e8302a');
        ctx.fillStyle=g;
        ctx.beginPath();ctx.roundRect(x,y,w*anger/100,h,6);ctx.fill();
        ctx.strokeStyle='rgba(239,83,80,.4)';ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(x,y,w,h,6);ctx.stroke();
        ctx.fillStyle='rgba(255,180,160,.85)';
        ctx.font='bold 9px monospace';ctx.textAlign='right';
        ctx.fillText(`🔥 憤怒 ${anger}`,x+w-4,y+h+12);
        ctx.restore();
      }

      /* ── 主循環 ── */
      function loop(){
        if(!alive)return;
        fr++;
        // 震動 / 瘟疫事件（魔王肆虐期間）
        if(diablo&&(gamePhase==='playing'||gamePhase==='exchange')&&!shopPause){
          if(quakeAt>0){quakeAt--;
            if(quakeAt<=0){
              quakeT=55;
              addLog('🌋 大地震動！全員 -1HP');
              for(let i=0;i<4;i++)if(i!==diablo.host)damage(i,1,'被震飛');
            }
          }
          if(quakeT>0)quakeT--;
          if(plagueAt>0){plagueAt--;
            if(plagueAt<=0){
              plague={t:600,tick:180,immune:[false,false,false,false]};
              addLog('☣ 大範圍中毒事件爆發！（10秒，每3秒-1HP，解毒藥可自保）');
            }
          }
          if(plague){
            plague.t--;plague.tick--;
            if(plague.tick<=0){
              plague.tick=180;
              for(let i=0;i<4;i++)
                if(i!==diablo.host&&!plague.immune[i])damage(i,1,'毒霧侵蝕');
            }
            if(plague.t<=0){plague=null;addLog('🌬 毒霧散去');}
          }
        }
        // 喬丹之石跳訊：憤怒越高間隔越短
        if(!diablo&&anger>=20&&gamePhase!=='result'){
          sojTimer--;
          if(sojTimer<=0){
            sojTimer=Math.max(90,380-anger*2.6)+Math.random()*60;
            addLog(`💎 ${1+Math.floor(Math.random()*anger)} 顆喬丹之石賣給了商人`);
          }
        }
        if(gamePhase==='dealing'){
          dealT++;
          if(dealT>=110)onDealDone();
        }
        else if(gamePhase==='exchange'){
          if(shopPause||(siege&&siege.pending)){draw();api.raf(loop);return;}
          const task=exTasks[exIdx];
          if(!task)finishExchange();
          else if(task.from!==0){
            exTimer--;
            if(exTimer<=0){
              // AI：拿對方最大牌、丟自己最小牌
              const th=[...hands[task.to]].sort((a,b)=>(a.v*4+a.sv)-(b.v*4+b.sv));
              const fh=[...hands[task.from]].sort((a,b)=>(a.v*4+a.sv)-(b.v*4+b.sv));
              const take=th[th.length-1], give=fh[0];
              moveCard(task.to,task.from,take);
              moveCard(task.from,task.to,give);
              // 涉及玩家的交換顯示牌面，AI 互換保密
              if(task.siege&&task.to===0)
                addLog(`⚔ 盟主 ${PLAYERS[task.from]} 徵收你的 ${take.r}${take.s}，回贈 ${give.r}${give.s}`);
              else if(task.siege)
                addLog(`⚔ ${PLAYERS[task.to]} 向盟主 ${PLAYERS[task.from]} 獻牌`);
              else if(task.to===0)
                addLog(`${PLAYERS[task.from]} 拿走你的 ${take.r}${take.s}，丟回 ${give.r}${give.s}`);
              else
                addLog(`${PLAYERS[task.from]} 向 ${PLAYERS[task.to]} 換了1張`);
              exIdx++; exTimer=55;
            }
          }
        }
        else if(shopPause){/* 商店暫停：AI 不動 */}
        else if(gamePhase==='playing'&&currentPlayer!==0&&!finished.includes(currentPlayer)){
          aiThinkTimer--;
          if(aiThinkTimer<=0){
            // AI 瀕死自動補血術
            if(hp[currentPlayer]<=1&&mana[currentPlayer]>0){
              mana[currentPlayer]--;heal(currentPlayer,1);
              addLog(`✨ ${PLAYERS[currentPlayer]} 施放補血術（${hp[currentPlayer]}/3）`);
            }
            const mustC3=mustFirst&&hands[currentPlayer].some(c=>c.r==='3'&&c.s==='♣');
            let result=smartAiPlay(currentPlayer,mustC3);
            // 腐化僕從：絕不壓主子、領牌只餵最小單張
            if(diablo&&diablo.minion===currentPlayer){
              if(played&&playedBy===diablo.host)result=null;
              else if(!played&&result){
                const cs=legalCombos(hands[currentPlayer],played,mustC3);
                const single=cs.find(c=>c.cards.length===1);
                if(single)result=single;
              }
            }
            // 地獄火未觸發且自己殘血：60% 不當出頭鳥
            else if(diablo&&!hellfireUsed&&played&&playedBy===diablo.host
               &&hp[currentPlayer]<=1&&result&&Math.random()<0.6)result=null;
            // 包圍網壓制：霸主出的牌、或霸主剩牌≤4 → 盟友改出最大合法牌
            if(result&&siege&&siege.allies.includes(currentPlayer)
               &&(playedBy===siege.target||hands[siege.target].length<=4)
               &&Math.random()<(diablo?0.9:0.65)){
              const combos=legalCombos(hands[currentPlayer],played,mustC3);
              // 霸主進殘局（≤4張）前不浪費炸彈
              const pool=hands[siege.target].length<=4?combos
                :combos.filter(c=>c.cl.type!=='fourOfAKind'&&c.cl.type!=='straightFlush');
              if(pool.length)result=pool[pool.length-1];
            }
            if(result)playCards(currentPlayer,result.cards);
            else pass(currentPlayer);
            scheduleAI();
          }
        }
        draw();
        api.raf(loop);
      }

      /* ── 裝備/背包 ── */
      const EQ_DESC={
        weapon:'地獄火免疫',armor:'傷害50%機率免除',helm:'掠奪改搶最小牌',
        ring:'每局回1魔法',amulet:'免疫中毒',
      };
      function openBag(backFn){
        const sub=document.getElementById('dsGMsgSub');
        if(sub)sub.style.whiteSpace='pre-line';
        const lines=Object.keys(equip).map(k=>{
          const e=equip[k];
          if(!e)return `▫ ${EQ_NAMES[k].slice(2)}：—— 未取得 ——`;
          const lv=e.lv?` +${e.lv}`:'';
          const so=e.slots?`〔${e.slots}孔${e.cards&&e.cards.length?'·'+e.cards.length+'卡':''}〕`:'〔無孔〕';
          return `${EQ_NAMES[k]}${lv} ${so}　${EQ_DESC[k]}`;
        }).join('\n');
        const inv=`${lines}\n\n💠 精煉石×${mats.refine}　ᚱ 符文×${mats.rune}\n🧪×${items.hp} ⚗×${items.mana} 🌿×${items.anti}`;
        api.showMsg('🎒 裝備欄',inv,[
          {label:'↩ 返回',fn:backFn},
        ]);
      }

      /* ── 雜貨店 ── */
      function openShop(backFn){
        const inv=`💰${chips[0]}元　❤${hp[0]}/3 ⚡${mana[0]}/3${poisoned[0]?' ☠中毒':''}　｜　🧪×${items.hp} ⚗×${items.mana} 🌿×${items.anti}　💠×${mats.refine} ᚱ×${mats.rune}`;
        const buy=(kind,cost,name)=>()=>{
          if(chips[0]<cost){addLog('❌ 錢不夠');openShop(backFn);return;}
          chips[0]-=cost;items[kind]++;saveAll();api.setScore(chips[0]);
          addLog(`🛒 購入${name}`);
          openShop(backFn);
        };
        api.showMsg('🛒 雜貨店',inv,[
          {label:'🧪 補血瓶 $150',fn:buy('hp',150,'補血瓶')},
          {label:'⚗ 魔法瓶 $200',fn:buy('mana',200,'魔法瓶')},
          {label:'🌿 解毒藥 $100',fn:buy('anti',100,'解毒藥')},
          {label:'🎒 裝備欄',fn:()=>openBag(()=>openShop(backFn))},
          {label:'⚒ 裝備店（補貨中…）',fn:()=>openShop(backFn)},
          {label:'↩ 離開',fn:backFn},
        ]);
      }

      /* ── 啟動 ── */
      const showStartMsg=()=>api.showMsg('🩸 血腥大老二',
        '第1局定階級；國王吸牌、奴隸吃渣\n憤怒滿百，地表暗黑將會降臨…',
        [
          {label:'▶ 開始',red:true,fn:()=>{api.hideMsg();api.raf(loop);}},
          {label:'🛒 雜貨店',fn:()=>openShop(showStartMsg)},
          {label:'🎒 裝備',fn:()=>openBag(showStartMsg)},
        ]
      );
      showStartMsg();

      // splash-game.js 若有接 init 回傳值，可直接呼叫銷毀
      return destroy;
    }
  });
})();
