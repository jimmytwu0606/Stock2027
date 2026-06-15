/**
 * game-bigTwoBloody-core.js — 血腥大老二共用核心
 * 牌規 / 牌型 / AI 決策 / 雙軌存檔 / 牌面繪製
 *
 * classic script，跨檔以 window.__BB 橋接（classic script 無法 import ES module）
 * 載入順序（index.html）：
 *   core → data → rpg → game-bigTwoBloody.js（主檔）→ splash-game.js
 */
(function () {
  'use strict';

  /* ══════ 常數 ══════ */
  const SUITS = ['♣','♦','♥','♠']; // 0梅花(小)~3黑桃(大)
  const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
  const RANK_VAL = {}; RANKS.forEach((r,i)=>RANK_VAL[r]=i);
  const SUIT_VAL = {}; SUITS.forEach((s,i)=>SUIT_VAL[s]=i);
  const TYPE_ZH = {single:'單張',pair:'對子',triple:'三條',straight:'順子',
    fullHouse:'葫蘆',fourOfAKind:'鐵支',straightFlush:'同花順'};
  const EQ_NAMES={weapon:'🗡 弒神之刃',armor:'🛡 暗黑骨甲',helm:'👹 暗黑面具',ring:'💍 喬丹之石',amulet:'📿 淨化護符'};
  const EQ_DESC={
    weapon:'地獄火免疫',armor:'傷害50%機率免除',helm:'掠奪改搶最小牌',
    ring:'每局回1魔法',amulet:'免疫中毒',
  };

  /* ══════ 牌組工具 ══════ */
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

  /* ══════ 牌型判斷 ══════ */
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
      if(flush&&straight)
        return{type:'straightFlush',cards:sorted,key:straightKey(sorted)*4+SUIT_VAL[sorted[0].s]};
      const four=findFour(sorted);
      if(four!==null)return{type:'fourOfAKind',cards:sorted,key:four};
      const full=findFullHouse(sorted);
      if(full!==null)return{type:'fullHouse',cards:sorted,key:full};
      if(straight)return{type:'straight',cards:sorted,key:straightKey(sorted)*4+sorted[4].sv};
      return null; // 純同花（非順）不是合法牌型
    }
    return null;
  }
  /* 順子：A2345 最小(key=-1)、23456 最大(key=14)、JQKA2 不合法 */
  function isStraight(sorted){
    const vals=sorted.map(c=>c.v);
    const normal=vals.every((v,i)=>i===0||v===vals[i-1]+1);
    if(normal)return vals[4]<=11; // 排除 JQKA2
    if(vals[0]===0&&vals[1]===1&&vals[2]===2&&vals[3]===3&&vals[4]===12)return true;  // 23456
    if(vals[0]===0&&vals[1]===1&&vals[2]===2&&vals[3]===11&&vals[4]===12)return true; // A2345
    return false;
  }
  function straightKey(sorted){
    const vals=sorted.map(c=>c.v);
    if(vals[4]===12&&vals[3]===3)return 14;
    if(vals[4]===12&&vals[3]===11)return -1;
    return vals[4];
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

  /* 壓牌判定：同花順壓一切；鐵支壓除同花順外一切；其餘同張數同型互壓 */
  function canBeat(played, attempt){
    if(!played)return true;
    if(!attempt)return false;
    if(attempt.type==='straightFlush'){
      if(played.type==='straightFlush')return attempt.key>played.key;
      return true;
    }
    if(attempt.type==='fourOfAKind'){
      if(played.type==='straightFlush')return false;
      if(played.type==='fourOfAKind')return attempt.key>played.key;
      return true;
    }
    if(played.type==='straightFlush'||played.type==='fourOfAKind')return false;
    if(attempt.cards.length!==played.cards.length)return false;
    if(attempt.type!==played.type)return false;
    return attempt.key>played.key;
  }

  /* ══════ 合法組合 + AI ══════ */
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
      const cost=t=>t==='straightFlush'?2:t==='fourOfAKind'?1:0;
      const ca=cost(a.cl.type),cb=cost(b.cl.type);
      if(ca!==cb)return ca-cb;
      return a.cl.key-b.cl.key;
    });
    return combos;
  }

  /* 基礎 AI（保留給簡單場景） */
  function aiPlay(hand, played, mustHaveClub3, minOppLen){
    const combos=legalCombos(hand, played, mustHaveClub3);
    if(combos.length===0)return null;
    if(hand.length<=4)return combos[combos.length-1];
    if(minOppLen<=2&&played)return combos[combos.length-1];
    return combos[0];
  }

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
  /* 手牌最優拆解：同花順→鐵支(配最小腳/拆兩對)→順子→三條→對子→單張 */
  function partitionHand(hand){
    let rest=[...hand].sort((a,b)=>a.v-b.v||a.sv-b.sv);
    const units=[];
    const remove=cards=>{const ids=new Set(cards.map(cardId));rest=rest.filter(c=>!ids.has(cardId(c)));};
    let run;
    while((run=findRunSuited(rest))){units.push(run);remove(run);}
    const fours=[];
    const byV4={};rest.forEach(c=>{(byV4[c.v]=byV4[c.v]||[]).push(c);});
    for(const v in byV4)if(byV4[v].length===4){fours.push([...byV4[v]]);remove(byV4[v]);}
    while((run=findRunMixed(rest))){units.push(run);remove(run);}
    const byV={};rest.forEach(c=>{(byV[c.v]=byV[c.v]||[]).push(c);});
    for(const v in byV){
      if(byV[v].length===3){units.push([...byV[v]]);remove(byV[v]);}
      else if(byV[v].length===2){units.push([...byV[v]]);remove(byV[v]);}
    }
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

  /* 該單張是否「場上王牌」（公平計牌：seen = 已亮牌 + 自己手牌的 cardId Set）*/
  function isBossSingleSeen(card, seen){
    const k=card.v*4+card.sv;
    for(const s of SUITS)for(const r of RANKS){
      if(seen.has(r+s))continue;
      if(RANK_VAL[r]*4+SUIT_VAL[s]>k)return false;
    }
    return true;
  }

  /**
   * 強化 AI 決策（純函式，殿堂/冒險兩模式共用）
   * opts: { hand, played, mustC3, seen(Set cardId), oppLens(number[]), keepTwoProb=0.45 }
   *  1. 一手出完直接贏
   *  2. 殘局（≤8張）：出完此手後剩牌恰為一個合法牌型 → 兩步收尾
   *  3. 領出：完整單位最小優先；有人快出完改領王牌單張/多張牌型保控制
   *  4. 壓牌：完整單位最小可壓；拆牌只在危險或殘局，否則 Pass 保牌型
   */
  function smartAiPlay(opts){
    const {hand,played,mustC3,seen,oppLens}=opts;
    const keepTwoProb=opts.keepTwoProb??0.45;
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
    const danger=(oppLens&&oppLens.length?Math.min(...oppLens):99)<=2;
    const whole=combos.filter(isWhole);
    if(!played){
      const pool=whole.length?whole:combos;
      if(danger){
        const boss=pool.find(c=>c.cards.length===1&&isBossSingleSeen(c.cards[0],seen));
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
      // 非危急不輕易動用含2的單張/對子（keepTwoProb=0 → 魔王全力模式）
      if(pick.cl.key>=48&&(pick.cl.type==='single'||pick.cl.type==='pair')
         &&Math.random()<keepTwoProb)return null;
      return pick;
    }
    if(danger||hand.length<=6)return combos[0];
    const cheap=combos.find(c=>c.cards.length<=2&&c.cl.type!=='fourOfAKind');
    if(cheap&&(played.type==='single'||played.type==='pair')&&played.key<8*4)return cheap;
    return null;
  }

  /* ══════ 雙軌存檔（IDB dengGames/saves + 雲端橋）══════
   * ⚠ indexedDB.open 必須帶 onupgradeneeded 自建 store（永久踩雷）
   * 殿堂/冒險共用同一份存檔 key 'bigtwo_bloody'，各自只增欄位不互刪 */
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
    idbLoad(local=>{
      const cloudFn=window.__gameCloudLoad;
      if(typeof cloudFn!=='function'){cb(local);return;}
      // ⚠ 雲端橋可能永不 resolve（未登入/網路懸住）→ 4 秒超時回退本機，避免黑畫面
      const timeout=new Promise(res=>setTimeout(()=>res('__TIMEOUT__'),4000));
      Promise.race([Promise.resolve(cloudFn(SAVE_KEY)),timeout]).then(cloud=>{
        if(cloud==='__TIMEOUT__'){cb(local);return;}
        if(cloud&&(!local||(cloud.updatedAt||0)>(local.updatedAt||0))){
          idbSave(cloud);
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

  /* ══ 共享狀態：殿堂/冒險引用同一物件，persist 合併寫回（互不覆蓋彼此欄位）══ */
  let _S=null,_pend=null;
  function loadShared(cb){
    if(_S){cb(_S);return;}
    if(_pend){_pend.push(cb);return;}
    _pend=[cb];
    loadChips(v=>{
      if(!_S){
        if(typeof v==='number')_S={chips:v}; // 舊版只存籌碼
        else _S=(v&&typeof v==='object')?v:{};
      }
      const q=_pend;_pend=null;
      q.forEach(f=>{try{f(_S);}catch(e){}});
    });
  }
  function persist(partial){
    if(!_S)_S={};
    if(partial)Object.assign(_S,partial);
    saveChips(_S);
  }

  /* 裝備插槽：50% 無槽，否則 1~6（低槽機率高）；bonus=鑲嵌技能加權上移 */
  function rollSlots(bonus){
    bonus=bonus||0;
    if(Math.random()<Math.max(0.2,0.5-bonus*0.12))return 0;
    const w=[30,25,20,12,8,5];
    let r=Math.random()*100, slot=1;
    for(let i=0;i<6;i++){r-=w[i];if(r<=0){slot=i+1;break;}}
    if(bonus&&Math.random()<bonus*0.35)slot++;
    return Math.min(6,slot);
  }

  /* ══════ 牌面繪製（綁定 ctx 的工廠）══════ */
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
  function makeCardPainter(ctx){
    return function drawCard(x,y,card,selected,faceUp=true,scale=1){
      const w=46*scale,h=68*scale,r=5*scale;
      ctx.save();
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
        ctx.font=`bold ${12.5*scale}px Georgia,'Times New Roman',serif`;
        ctx.textAlign='center';
        ctx.fillText(card.r,x+8*scale,y+13*scale);
        ctx.font=`${9.5*scale}px sans-serif`;
        ctx.fillText(card.s,x+8*scale,y+23*scale);
        ctx.save();
        ctx.translate(x+w,y+h);ctx.rotate(Math.PI);
        ctx.fillStyle=col;
        ctx.font=`bold ${12.5*scale}px Georgia,'Times New Roman',serif`;
        ctx.fillText(card.r,8*scale,13*scale);
        ctx.font=`${9.5*scale}px sans-serif`;
        ctx.fillText(card.s,8*scale,23*scale);
        ctx.restore();

        if(card.r==='A'){
          ctx.font=`${30*scale}px sans-serif`;
          ctx.fillText(card.s,x+w/2,y+h/2+11*scale);
        } else if(['J','Q','K'].includes(card.r)){
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
        const bg=ctx.createLinearGradient(x,y,x+w,y+h);
        bg.addColorStop(0,'#22335c');bg.addColorStop(.5,'#16244a');bg.addColorStop(1,'#0d1830');
        ctx.fillStyle=bg;
        ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
        ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
        ctx.strokeStyle='rgba(140,170,230,.4)';ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.stroke();
        ctx.strokeStyle='rgba(255,255,255,.55)';
        ctx.beginPath();ctx.roundRect(x+2,y+2,w-4,h-4,Math.max(r-1,1));ctx.stroke();
        ctx.save();
        ctx.beginPath();ctx.roundRect(x+4,y+4,w-8,h-8,Math.max(r-2,1));ctx.clip();
        ctx.strokeStyle='rgba(120,150,210,.18)';ctx.lineWidth=1;
        for(let d=-h;d<w+h;d+=7*scale){
          ctx.beginPath();ctx.moveTo(x+d,y);ctx.lineTo(x+d+h,y+h);ctx.stroke();
          ctx.beginPath();ctx.moveTo(x+d+h,y);ctx.lineTo(x+d,y+h);ctx.stroke();
        }
        ctx.restore();
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
    };
  }

  /* ══════ 橋接輸出 ══════ */
  window.__BB={
    SUITS,RANKS,RANK_VAL,SUIT_VAL,TYPE_ZH,EQ_NAMES,EQ_DESC,
    makeDeck,shuffle,cardId,sortByRank,sortBySuit,handPenalty,
    classify,canBeat,legalCombos,aiPlay,partitionHand,
    isBossSingleSeen,smartAiPlay,
    loadChips,saveChips,loadShared,persist,rollSlots,
    get state(){return _S;},
    makeCardPainter,
  };
})();
