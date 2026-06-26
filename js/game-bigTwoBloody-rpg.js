/**
 * game-bigTwoBloody-rpg.js — 血腥大老二・冒險之路（RPG 戰役模式）
 * 依賴：game-bigTwoBloody-core.js（window.__BB）、game-bigTwoBloody-data.js（window.__BBD）
 * 由主檔模式選單呼叫 window.__BB_RPG.start(canvas,ctx,api,{backToMenu})
 *
 * 戰鬥模型（1v3 純逆境）：玩家(座0) vs 魔王(座1,頂部) + 小怪兵×2(座2/3)
 *   玩家奪頭家 → 王 -1HP（王剩牌≥暴擊門檻 → -2，王可閃避、破甲可削）
 *   怪方奪頭家 → 玩家 -1HP + 王技能（吸魂/吞金…）
 *   王 HP 歸零 → 通關（復活可擋一次）；玩家歸零 → 戰敗（不死鳥可擋一次）
 *   星級：⭐通關 ⭐⭐無傷 ⭐⭐⭐ 無傷+（王HP+1）局內速殺
 * 場景機：world / battle / bag / tree；點擊 immediate-mode（draw 塞 hot[]，onClick 反向掃）
 */
(function(){
  'use strict';
  window.__BB_RPG={start};

  function start(canvas,ctx,api,opts){
    const BB=window.__BB, BBD=window.__BBD;
    if(!BB||!BBD){
      // ⚠ 缺檔不可無聲失敗（會變純黑畫面）：大聲報哪個檔沒載到
      const miss=(!BB?'game-bigTwoBloody-core.js（window.__BB）':'')
        +(!BBD?' game-bigTwoBloody-data.js（window.__BBD）':'');
      try{api.showMsg('⚠ 冒險模組缺檔','未載入：'+miss+'\n檢查 index.html script 路徑/404',
        [{label:'知道了',fn:function(){api.hideMsg();}}]);}catch(e){}
      return function(){};
    }
    const W=680,H=600;
    const cardId=BB.cardId, classify=BB.classify, canBeat=BB.canBeat,
          legalCombos=BB.legalCombos, handPenalty=BB.handPenalty,
          sortByRank=BB.sortByRank, sortBySuit=BB.sortBySuit,
          makeDeck=BB.makeDeck, shuffle=BB.shuffle, TYPE_ZH=BB.TYPE_ZH,
          EQ_NAMES=BB.EQ_NAMES, EQ_DESC=BB.EQ_DESC,
          smartAiPlay=BB.smartAiPlay, rollSlots=BB.rollSlots, partitionHand=BB.partitionHand;
    const drawCard=BB.makeCardPainter(ctx);
    const MAPS=BBD.MAPS, PSK=BBD.PSKILLS, MSKILL=BBD.MSKILL, TAUNTS=BBD.TAUNTS, CARD_FX=BBD.CARD_FX||{};

    /* ── 共享存檔（與階級殿堂同一份，persist 合併不互洗）── */
    const S=BB.state||{};
    S.chips=S.chips!=null?S.chips:1000;
    S.items=Object.assign({hp:0,mana:0,anti:0,sub:0,bomb:0,fore:0},S.items); // sub替身/bomb炸裂/fore預知（魔法屋一次性卡）
    S.equip=Object.assign({weapon:0,armor:0,helm:0,ring:0,amulet:0},S.equip);
    S.mats=Object.assign({refine:0,rune:0,refine2:0},S.mats); // refine2=💠華麗精煉石
    if(S.stam==null)S.stam=10; // 💪 體力（打工消耗；戰鬥後回復、提神飲料可買）
    const adv=S.adv=Object.assign({lv:1,xp:0,sp:0,sk:{},maps:[],cards:{},clears:0,abyss:{depth:0,best:0}},S.adv||{});
    adv.sk=adv.sk||{}; adv.cards=adv.cards||{}; adv.abyss=adv.abyss||{depth:0,best:0};
    if(!Array.isArray(S.bag))S.bag=[]; // 🎒 倉庫：未穿的裝備件 [{slot,q,lv,slots,cards:[],affixes:[]}]
    const BAG_MAX=24;
    if(!Array.isArray(adv.maps))adv.maps=[];
    MAPS.forEach(function(m,i){
      if(!Array.isArray(adv.maps[i]))adv.maps[i]=m.stages.map(function(){return 0;});
      while(adv.maps[i].length<m.stages.length)adv.maps[i].push(0);
    });
    function save(){
      BB.persist({chips:S.chips,items:S.items,equip:S.equip,mats:S.mats,adv:adv,bag:S.bag});
      api.setScore(S.chips);
    }

    /* ── 裝備稀有度（RO 式安定值）──
       q: 0白/1藍/2黃/3金/4暗金；安定值內精煉 100% 必成，超過/暗金需擲骰
       舊存檔無 q 視為黃裝（q=2） */
    const RAR={
      name:['白','藍','黃','金','暗金'],
      col:['#d8d8d8','#6ab0f3','#f3d36a','#f5a623','#b8860b'],
      safe:[7,6,5,4,0],
      // 各槽位依稀有度的效果表
      armor:[0.30,0.40,0.50,0.60,0.70],          // 基礎擋傷
      weaponCrit:[0,0,1,1,2],                     // 暴擊門檻額外 -N
      helmLoot:[0,2,4,6,10],                      // 撿寶 +%
      ringMana:[1,1,1,2,2],                       // 每局回魔
    };
    const eqQ=function(k){const e=S.equip[k];return e?(e.q==null?2:e.q):2;};
    const safeOf=function(k){return RAR.safe[eqQ(k)];};
    function rollRarity(mi,isBoss){
      // T 索引即 q：[白,藍,黃,金,暗金] 權重，總和 100
      const T=mi<=1?[55,30,12,3,0]:mi<=3?[35,30,22,10,3]:[15,25,28,20,12];
      let r=Math.random()*100;
      if(isBoss)r=Math.min(99.9,r+12); // 王掉落往高稀有偏移（r 越大越稀有）
      let acc=0;
      for(let q=4;q>=0;q--){ // 從暗金往下累加：r 落在最頂端區段 = 最稀有
        acc+=T[q];
        if(r>=100-acc)return q;
      }
      return 0;
    }

    /* ── 詞綴系統（Slice 2）：掉裝依稀有度 roll，全身加總生效 ── */
    const AFFIX={
      crit :{n:'鋒銳',v:1, c:'#ef9a9a',d:'暴擊門檻 -1'},
      loot :{n:'貪婪',v:5, c:'#f5d36a',d:'撿寶 +5%'},
      mana :{n:'通靈',v:1, c:'#8ab4ff',d:'魔力上限 +1'},
      block:{n:'堅壁',v:5, c:'#9fe0c0',d:'格擋 +5%（需防具）'},
      plun :{n:'守財',v:1, c:'#c0a060',d:'王開局掠奪 -1 張'},
      gold :{n:'生財',v:30,c:'#f5c400',d:'奪頭家 +30 元'},
      regen:{n:'回春',v:1, c:'#ef5350',d:'每局結算 +1HP'},
    };
    const AFFIX_KEYS=Object.keys(AFFIX);
    const AFFIX_N=[0,1,1,2,3]; // 白藍黃金暗金各 roll 幾條
    function rollAffixes(q){
      const n=AFFIX_N[q==null?2:q]||0; if(!n)return [];
      const pool=AFFIX_KEYS.slice(), out=[];
      for(let i=0;i<n&&pool.length;i++){
        const t=pool.splice(Math.floor(Math.random()*pool.length),1)[0];
        out.push({t:t,v:AFFIX[t].v});
      }
      return out;
    }
    function affixSum(t){
      return ['weapon','armor','helm','ring','amulet'].reduce(function(s,k){
        const e=S.equip[k]; if(!e||!e.affixes)return s;
        return s+e.affixes.reduce(function(a,af){return a+(af.t===t?af.v:0);},0);
      },0);
    }
    /* 怪物卡效加總（Slice 3）：掃所有穿戴件的鑲嵌卡，同卡疊加 */
    function cardFx(fx){
      return ['weapon','armor','helm','ring','amulet'].reduce(function(s,k){
        const e=S.equip[k]; if(!e||!e.cards)return s;
        return s+e.cards.reduce(function(a,cid){
          const f=CARD_FX[cid];return a+(f&&f.fx===fx?f.v:0);},0);
      },0);
    }
    /* 套裝（Batch D）：詞綴型 set bonus，2/3 件啟用，併入 affixSum 掛點 */
    const SETS={
      dark :{n:'暗黑',c:'#b8860b',b2:{crit:1}, b3:{loot:15}},
      holy :{n:'聖殿',c:'#9fe0c0',b2:{regen:1},b3:{mana:2}},
      greed:{n:'貪狼',c:'#fff176',b2:{gold:30},b3:{loot:20}},
    };
    const SET_KEYS=Object.keys(SETS);
    function mkItem(slot,q,setChance){
      const it={slot:slot,lv:0,q:q,slots:rollSlots(sk('sock')),cards:[],affixes:rollAffixes(q)};
      if(Math.random()<(setChance||0))it.set=SET_KEYS[Math.floor(Math.random()*SET_KEYS.length)];
      return it;
    }
    function setCount(){
      const c={};
      ['weapon','armor','helm','ring','amulet'].forEach(function(k){
        const e=S.equip[k]; if(e&&e.set)c[e.set]=(c[e.set]||0)+1;});
      return c;
    }
    function setSum(t){
      const c=setCount(); let s=0;
      Object.keys(c).forEach(function(id){
        const st=SETS[id]; if(!st)return;
        if(c[id]>=2&&st.b2&&st.b2[t])s+=st.b2[t];
        if(c[id]>=3&&st.b3&&st.b3[t])s+=st.b3[t];
      });
      return s;
    }

    /* ── 衍生數值 ── */
    const sk=function(id){return adv.sk[id]||0;};
    const refLv=function(k){return (S.equip[k]&&S.equip[k].lv)||0;};
    const sockN=function(){
      return ['weapon','armor','helm','ring','amulet'].reduce(function(s,k){
        return s+((S.equip[k]&&S.equip[k].cards)?S.equip[k].cards.length:0);},0);
    };
    const maxHp=function(){return Math.min(8,3+Math.floor(adv.lv/3));};
    const maxMana=function(){return 3+sk('medit')+affixSum('mana')+cardFx('mana')+setSum('mana');};
    const critTh=function(){return Math.max(5,10-sk('hit')-Math.floor(refLv('weapon')/3)-(S.equip.weapon?RAR.weaponCrit[eqQ('weapon')]:0)-affixSum('crit')-cardFx('crit')-setSum('crit'));};
    const lootPct=function(){return sk('loot')*10+(refLv('helm')+refLv('amulet'))*2+(S.equip.helm?RAR.helmLoot[eqQ('helm')]:0)+affixSum('loot')+cardFx('loot')+setSum('loot');};
    const blockPct=function(){return S.equip.armor?Math.min(0.85,RAR.armor[eqQ('armor')]+refLv('armor')*0.05+(affixSum('block')+setSum('block'))/100):0;};
    const needXp=function(){return adv.lv*80;};
    const branchPts=function(key){
      return PSK[key].list.reduce(function(s,n){return s+(adv.sk[n.id]||0);},0);
    };
    const bossIdx=function(mi){
      for(let i=0;i<MAPS[mi].stages.length;i++)
        if(MAPS[mi].stages[i].boss&&!MAPS[mi].stages[i].hidden)return i;
      return MAPS[mi].stages.length-1;
    };
    const mapUnlocked=function(mi){return mi===0||adv.maps[mi-1][bossIdx(mi-1)]>0;};
    const stageUnlocked=function(mi,si){
      const st=MAPS[mi].stages[si];
      if(st.hidden)return adv.maps[mi][bossIdx(mi)]>0;
      return si===0||adv.maps[mi][si-1]>0;
    };
    const mapStars=function(mi){
      return MAPS[mi].stages.reduce(function(s,st,si){
        return s+(st.hidden?0:adv.maps[mi][si]);},0);
    };
    function firstUncleared(){
      for(let i=0;i<MAPS.length;i++)
        if(mapUnlocked(i)&&adv.maps[i][bossIdx(i)]===0)return i;
      return MAPS.length-1;
    }
    const lossOf=function(mi){return 100*(mi+1);};

    /* ── 場景狀態 ── */
    let alive=true, scene='world', selMap=firstUncleared(), fr=0;
    let hot=[];        // 本幀可點區
    let bagSel=null;   // 裝備頁選取槽位
    let floats=[];     // 浮動字
    let B=null;        // 戰鬥狀態
    let Wk=null;       // 打工狀態 {n總輪數,done,t,gain,log[],ev}
    const MAPBG=[['#16240f','#070b05'],['#2e2410','#0d0a04'],['#160f28','#06040d'],
                 ['#1c1c26','#08080d'],['#2c0e08','#0d0402'],['#1c0a20','#070208']];

    function rr(x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);}
    function addFloat(x,y,txt,col){floats.push({x:x,y:y,txt:txt,col:col||'#ffd54f',t:70});}
    function drawFloats(){
      for(let i=floats.length-1;i>=0;i--){
        const f=floats[i];
        ctx.save();ctx.globalAlpha=Math.min(1,f.t/30);
        ctx.fillStyle=f.col;ctx.font='bold 16px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText(f.txt,f.x,f.y);
        ctx.restore();
        f.y-=0.55;f.t--;
        if(f.t<=0)floats.splice(i,1);
      }
    }
    function btn(x,y,w,h,label,fn,style){
      const on=!!fn;
      ctx.save();
      const g=ctx.createLinearGradient(x,y,x+w,y+h);
      const cs=style==='red'?['#c0392b','#e74c3c','rgba(231,76,60,.8)']
        :style==='gold'?['#5b4a14','#7a6420','rgba(245,196,0,.5)']
        :['#2b2b38','#3a3a4c','rgba(150,150,180,.4)'];
      g.addColorStop(0,on?cs[0]:'#222');g.addColorStop(1,on?cs[1]:'#181818');
      ctx.fillStyle=g;rr(x,y,w,h,8);ctx.fill();
      ctx.strokeStyle=on?cs[2]:'rgba(80,80,80,.5)';ctx.lineWidth=1.5;
      rr(x,y,w,h,8);ctx.stroke();
      ctx.fillStyle=on?'#fff':'#555';
      ctx.font='bold 12px -apple-system,sans-serif';ctx.textAlign='center';
      ctx.fillText(label,x+w/2,y+h/2+4);
      ctx.restore();
      if(on)hot.push({x:x,y:y,w:w,h:h,fn:fn});
    }
    /* 中文逐字斷行 */
    function wrap(txt,font,maxW){
      ctx.save();ctx.font=font;
      const lines=[];let cur='';
      for(const ch of txt){
        if(ctx.measureText(cur+ch).width>maxW){lines.push(cur);cur=ch;}
        else cur+=ch;
      }
      if(cur)lines.push(cur);
      ctx.restore();
      return lines;
    }

    /* ══════════════ 世界地圖 ══════════════ */
    function drawWorld(){
      const bg=ctx.createLinearGradient(0,0,0,H);
      bg.addColorStop(0,'#141022');bg.addColorStop(1,'#060409');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      ctx.fillStyle='rgba(255,255,255,.10)';
      for(let i=0;i<26;i++){
        ctx.fillRect((i*97+((i*53)%37)*7)%W,(i*61)%150,1.6,1.6);
      }
      // 頂欄
      ctx.fillStyle='rgba(0,0,0,.45)';rr(8,8,W-16,56,10);ctx.fill();
      ctx.strokeStyle='rgba(245,196,0,.25)';ctx.lineWidth=1;rr(8,8,W-16,56,10);ctx.stroke();
      ctx.font='26px sans-serif';ctx.textAlign='left';
      ctx.fillText('😺',18,46);
      ctx.fillStyle='#f5c400';ctx.font='bold 14px -apple-system,sans-serif';
      ctx.fillText('Lv '+adv.lv+'　燈燈騎士',54,28);
      ctx.fillStyle='rgba(255,255,255,.12)';rr(54,36,150,7,3);ctx.fill();
      ctx.fillStyle='#7f77dd';rr(54,36,150*Math.min(1,adv.xp/needXp()),7,3);ctx.fill();
      ctx.fillStyle='#999';ctx.font='9px monospace';
      ctx.fillText('XP '+adv.xp+'/'+needXp(),54,56);
      ctx.fillStyle='#f5c400';ctx.font='bold 13px monospace';
      ctx.fillText('💰 '+S.chips,220,30);
      ctx.fillStyle='#ef5350';ctx.font='11px sans-serif';
      ctx.fillText('❤×'+maxHp()+'  ⚡×'+maxMana()+'  💪'+S.stam+'/10',220,50);
      if(adv.sp>0){
        ctx.fillStyle='#ba7517';rr(312,16,70,18,9);ctx.fill();
        ctx.fillStyle='#fff';ctx.font='bold 10px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText('技能點 '+adv.sp,347,29);
        ctx.textAlign='left';
      }
      btn(W-272,18,60,34,'🎒裝備',function(){bagSel=null;scene='bag';});
      btn(W-206,18,60,34,'🌳技能',function(){scene='tree';},adv.sp>0?'gold':null);
      btn(W-140,18,60,34,'🛒商店',openShop);
      btn(W-74,18,60,34,'↩離開',leaveAdventure);

      // 地圖卡 3×2
      const cw=206,chh=92,gx=15,gy=10,x0=13,y0=78;
      MAPS.forEach(function(m,i){
        const x=x0+(i%3)*(cw+gx), y=y0+Math.floor(i/3)*(chh+gy);
        const un=mapUnlocked(i), sel=selMap===i;
        ctx.save();
        const g=ctx.createLinearGradient(x,y,x,y+chh);
        g.addColorStop(0,un?MAPBG[i][0]:'#15151a');g.addColorStop(1,un?MAPBG[i][1]:'#0a0a0d');
        ctx.fillStyle=g;rr(x,y,cw,chh,10);ctx.fill();
        ctx.strokeStyle=sel?'rgba(245,196,0,.9)':un?'rgba(255,255,255,.18)':'rgba(255,255,255,.06)';
        ctx.lineWidth=sel?2:1;rr(x,y,cw,chh,10);ctx.stroke();
        ctx.globalAlpha=un?1:0.35;
        ctx.font='30px sans-serif';ctx.textAlign='left';
        ctx.fillText(un?m.icon:'🔒',x+10,y+38);
        ctx.fillStyle=un?'#eee':'#666';ctx.font='bold 14px -apple-system,sans-serif';
        ctx.fillText((i+1)+'. '+m.name,x+50,y+26);
        ctx.fillStyle='#999';ctx.font='9px -apple-system,sans-serif';
        wrap(m.desc,'9px -apple-system,sans-serif',cw-62).slice(0,2)
          .forEach(function(l,li){ctx.fillText(l,x+50,y+41+li*12);});
        ctx.fillStyle='#f5c400';ctx.font='11px sans-serif';
        ctx.fillText('⭐ '+mapStars(i)+'/12',x+10,y+chh-10);
        let ix=x+cw-16;
        for(let si=m.stages.length-1;si>=0;si--){
          const st=m.stages[si];
          if(st.hidden&&adv.maps[i][bossIdx(i)]===0)continue;
          ctx.globalAlpha=(un&&adv.maps[i][si]>0)?1:0.28;
          ctx.font=(st.boss?'16px':'13px')+' sans-serif';ctx.textAlign='center';
          ctx.fillText(st.icon,ix,y+chh-9);
          ix-=st.boss?22:18;
        }
        ctx.restore();
        if(un)hot.push({x:x,y:y,w:cw,h:chh,fn:function(){selMap=i;}});
        else hot.push({x:x,y:y,w:cw,h:chh,fn:function(){
          addFloat(x+cw/2,y+chh/2,'🔒 先擊敗前一張地圖的大魔王','#aaa');
        }});
      });

      // 關卡列
      const m=MAPS[selMap], sy=y0+2*(chh+gy)+8;
      ctx.fillStyle='rgba(0,0,0,.4)';rr(8,sy,W-16,H-sy-8,12);ctx.fill();
      ctx.strokeStyle='rgba(245,196,0,.18)';rr(8,sy,W-16,H-sy-8,12);ctx.stroke();
      ctx.fillStyle='#f5c400';ctx.font='bold 14px -apple-system,sans-serif';ctx.textAlign='left';
      ctx.fillText(m.icon+' '+m.name+'　— 討伐名單 —',22,sy+24);
      ctx.fillStyle='#888';ctx.font='10px -apple-system,sans-serif';
      ctx.fillText('小怪兵：'+m.mobIcon+' '+m.mob+' ×2 隨王赴宴',22,sy+40);
      if(abyssUnlocked())
        btn(W-168,sy+8,150,30,'🕳 無盡深淵'+(adv.abyss.best?'・最深'+adv.abyss.best:''),confirmAbyss,'red');
      const vis=m.stages.filter(function(st){
        return !st.hidden||adv.maps[selMap][bossIdx(selMap)]>0;});
      const nw=112,nh=H-sy-62,ng=12;
      let nx=W/2-(vis.length*nw+(vis.length-1)*ng)/2;
      vis.forEach(function(st){
        const si=m.stages.indexOf(st);
        const un=stageUnlocked(selMap,si);
        const stars=adv.maps[selMap][si];
        const ny=sy+50;
        ctx.save();
        ctx.fillStyle=st.boss?'rgba(60,18,8,.85)':'rgba(20,24,32,.9)';
        rr(nx,ny,nw,nh,10);ctx.fill();
        ctx.strokeStyle=st.boss?'rgba(245,160,0,.7)':'rgba(255,255,255,.14)';
        ctx.lineWidth=st.boss?1.6:1;rr(nx,ny,nw,nh,10);ctx.stroke();
        ctx.globalAlpha=un?1:0.32;
        ctx.font='32px sans-serif';ctx.textAlign='center';
        ctx.fillText(st.icon,nx+nw/2,ny+40);
        ctx.fillStyle='#eee';ctx.font='bold 12px -apple-system,sans-serif';
        ctx.fillText((st.hidden?'💀':st.boss?'👑':'')+st.name,nx+nw/2,ny+58);
        ctx.fillStyle='#ef5350';ctx.font='9px sans-serif';
        ctx.fillText('❤×'+st.hp,nx+nw/2,ny+72);
        ctx.fillStyle='#f5c400';ctx.font='12px sans-serif';
        ctx.fillText(stars>0?'⭐'.repeat(stars):un?'未討伐':'🔒',nx+nw/2,ny+nh-10);
        ctx.restore();
        if(un){
          const xx=nx;
          hot.push({x:xx,y:ny,w:nw,h:nh,fn:function(){confirmStage(selMap,si);}});
        }
        nx+=nw+ng;
      });
    }

    function confirmStage(mi,si){
      const st=MAPS[mi].stages[si];
      const skills=Object.keys(st.skills||{});
      const lines=(st.boss?'👑 大魔王':'⚔ 小魔王')+'　❤×'+st.hp
        +'\n\n'+(skills.length?skills.map(function(k){return MSKILL[k]||k;}).join('\n')
                              :'（沒有特殊技能，純粹想打牌）')
        +'\n\n戰敗損失：'+lossOf(mi)+' 元　淨化金：'+st.purify+' 元';
      api.showMsg(st.icon+' '+st.name,lines,[
        {label:'⚔ 開戰',red:true,fn:function(){api.hideMsg();maybeEvent(mi,si);}},
        {label:'↩ 再想想',fn:function(){api.hideMsg();}},
      ]);
    }
    /* 進關前隨機事件（Batch D）：不改地圖，選關後 25% 偶發 */
    function maybeEvent(mi,si){
      const go=function(){startBattle(mi,si);};
      if(Math.random()<0.25){
        const evs=[evMerchant,evChest,evGamble,evSmith];
        evs[Math.floor(Math.random()*evs.length)](go);
      } else go();
    }
    function evMerchant(go){
      const q=Math.random()<0.5?3:2, price=q===3?700:450;
      api.showMsg('🧳 流浪商人','「赴宴前…要不要看看我的好貨？」\n\n💰 你的籌碼：'+S.chips,[
        {label:'🛍 買〔'+RAR.name[q]+'〕裝備 $'+price,fn:function(){
          if(S.chips<price)addFloat(W/2,H/2,'❌ 錢不夠','#ef9a9a');
          else{S.chips-=price;const slot=SLOT_KEYS[Math.floor(Math.random()*SLOT_KEYS.length)];
            const it=mkItem(slot,q,0.3);
            if(!S.equip[slot])S.equip[slot]=it; else if(S.bag.length<BAG_MAX)S.bag.push(it); else S.mats.refine+=salvageYield(it);
            addFloat(W/2,H/2,'🧳 入手〔'+RAR.name[q]+'〕'+eqName(slot),'#f5d36a');}
          save();api.hideMsg();go();}},
        {label:'ᚱ 買符文×2 $300',fn:function(){
          if(S.chips<300)addFloat(W/2,H/2,'❌ 錢不夠','#ef9a9a');
          else{S.chips-=300;S.mats.rune+=2;addFloat(W/2,H/2,'ᚱ 符文×2','#c9b6f0');}
          save();api.hideMsg();go();}},
        {label:'↩ 不買，開戰',fn:function(){api.hideMsg();go();}},
      ]);
    }
    function evChest(go){
      api.showMsg('📦 神秘寶箱','路邊有個沒上鎖的箱子…\n（80% 有寶／20% 是陷阱）',[
        {label:'🔓 打開',red:true,fn:function(){
          api.hideMsg();
          if(Math.random()<0.8){
            const r=Math.random();
            if(r<0.4){S.mats.refine+=3;addFloat(W/2,H/2,'💠 精煉石×3','#b0c4de');}
            else if(r<0.7){S.mats.rune+=2;addFloat(W/2,H/2,'ᚱ 符文×2','#c9b6f0');}
            else{S.items.hp+=2;addFloat(W/2,H/2,'🧪 補血瓶×2','#80cbc4');}
          } else {const lose=Math.min(S.chips,150);S.chips-=lose;addFloat(W/2,H/2,'💥 陷阱！-'+lose+'元','#ef9a9a');}
          save();go();}},
        {label:'🚶 不碰，開戰',fn:function(){api.hideMsg();go();}},
      ]);
    }
    function evGamble(go){
      const bet=200;
      api.showMsg('🎲 賭徒之骰','「敢不敢賭一把？押 $'+bet+'，擲骰定生死。」\n\n💰 籌碼：'+S.chips,[
        {label:'🎲 賭！（50% 雙倍 / 50% 全失）',red:true,fn:function(){
          api.hideMsg();
          if(S.chips<bet)addFloat(W/2,H/2,'❌ 籌碼不足','#ef9a9a');
          else if(Math.random()<0.5){S.chips+=bet;addFloat(W/2,H/2,'🎉 中了！+'+bet+'元','#f5d36a');}
          else{S.chips-=bet;addFloat(W/2,H/2,'💸 槓龜…-'+bet+'元','#ef9a9a');}
          save();go();}},
        {label:'🙅 不賭，開戰',fn:function(){api.hideMsg();go();}},
      ]);
    }
    function evSmith(go){
      const worn=SLOT_KEYS.filter(function(k){return S.equip[k];});
      if(!worn.length){go();return;}
      api.showMsg('⚒ 旅途鐵匠','「免費幫你敲一下，要精煉還是鑿孔？」',[
        {label:'⚒ 免費精煉一件（+1 必成）',fn:function(){
          const k=worn[Math.floor(Math.random()*worn.length)];
          if(S.equip[k].lv<10){S.equip[k].lv++;addFloat(W/2,H/2,'⚒ '+eqName(k)+' +'+S.equip[k].lv,'#ffd54f');}
          save();api.hideMsg();go();}},
        {label:'🔩 免費鑿孔一件（+1 孔，上限6）',fn:function(){
          const cand=worn.filter(function(k){return (S.equip[k].slots||0)<6;});
          if(cand.length){const k=cand[Math.floor(Math.random()*cand.length)];S.equip[k].slots=(S.equip[k].slots||0)+1;addFloat(W/2,H/2,'🔩 '+eqName(k)+' 孔+1','#b9a4e8');}
          save();api.hideMsg();go();}},
        {label:'↩ 不用，開戰',fn:function(){api.hideMsg();go();}},
      ]);
    }
    function confirmAbyss(){
      api.showMsg('🕳 無盡深淵',
        '六界魔王已淨化，深淵之門開啟。\n\n單王連戰，越深越強（HP／閃避／詞綴隨層成長）。\n每 5 層保底高稀有裝備 + 符文。\n戰敗僅止步、不扣錢，紀錄你的最深層數。\n\n最深紀錄：'+adv.abyss.best+' 層',
        [{label:'⬇ 潛入第 1 層',red:true,fn:function(){api.hideMsg();startAbyss(1);}},
         {label:'↩ 再想想',fn:function(){api.hideMsg();}}]);
    }
    function leaveAdventure(){
      save();
      destroy();
      if(opts&&typeof opts.backToMenu==='function')opts.backToMenu();
    }

    /* ══════════════ 戰鬥 ══════════════ */
    /* ── 菁英／變異王（Batch A）：怪物詞綴，battle 內生成、clone 套用 ── */
    const MON_AFFIX={
      rage2:{n:'暴怒',c:'#ef5350',d:'掠奪+1',  ap:function(m){m.plunder=(m.plunder||0)+1;}},
      tough:{n:'堅韌',c:'#a5d6a7',d:'HP+1',     ap:function(m){m.hp=(m.hp||1)+1;}},
      swift:{n:'迅捷',c:'#90caf9',d:'出手更快', ap:function(m){m.sup=Math.min(0.95,(m.sup||0.6)+0.08);}},
      toxic:{n:'淬毒',c:'#ce93d8',d:'附帶毒',   ap:function(m){m.skills=Object.assign({},m.skills,{poison:1});}},
      thorn:{n:'反震',c:'#ffb74d',d:'你奪頭家30%反彈-1HP', ap:function(m){m._thorn=1;}},
      greed:{n:'貪婪',c:'#fff176',d:'你的罰金×1.5', ap:function(m){m._greed=1;}},
    };
    const MON_AFFIX_KEYS=Object.keys(MON_AFFIX);
    const ELITE_RATE=[0.10,0.13,0.18,0.24,0.30,0.35]; // 各地圖菁英出現率
    function rollEliteAffixes(mi,base){
      if(base.boss)return []; // 大魔王不菁英化
      if(Math.random()>=(ELITE_RATE[mi]||0.1))return [];
      const keys=MON_AFFIX_KEYS.slice(), n=mi>=4?2:1, out=[];
      for(let i=0;i<n&&keys.length;i++)out.push(keys.splice(Math.floor(Math.random()*keys.length),1)[0]);
      return out;
    }
    function applyElite(base,keys){
      const m=Object.assign({},base);
      keys.forEach(function(k){if(MON_AFFIX[k])MON_AFFIX[k].ap(m);});
      m.elite=true;return m;
    }

    function startBattle(mi,si){
      const base=MAPS[mi].stages[si];
      const elite=rollEliteAffixes(mi,base);
      const mon=elite.length?applyElite(base,elite):base;
      _enterBattle(mi,si,mon,elite,0);
    }
    /* ── 無盡深淵（Batch C）── */
    const ABYSS_TPL=MAPS.map(function(m,i){return m.stages[bossIdx(i)];}); // 6 大魔王當模板
    function abyssUnlocked(){return MAPS.every(function(m,i){return adv.maps[i][bossIdx(i)]>0;});}
    function genAbyssBoss(L){
      const tpl=ABYSS_TPL[(L-1)%ABYSS_TPL.length];
      const m=Object.assign({},tpl);
      m.hp=tpl.hp+Math.floor(L/2);
      m.sup=Math.min(0.95,(tpl.sup||0.7)+L*0.01);
      m.dodge=Math.min(0.5,(tpl.dodge||0)+L*0.02);
      m.plunder=(tpl.plunder||0)+Math.floor(L/4);
      m.skills=Object.assign({},tpl.skills);
      m.drops=['equip','refine','rune','card'];
      m.purify=120+L*30;
      m.name='深淵·'+tpl.name+' L'+L;
      m.boss=true;m.hidden=false;m.id=tpl.id;
      const eliteN=Math.min(3,Math.floor(L/3)), keys=MON_AFFIX_KEYS.slice(), el=[];
      for(let i=0;i<eliteN&&keys.length;i++)el.push(keys.splice(Math.floor(Math.random()*keys.length),1)[0]);
      el.forEach(function(k){MON_AFFIX[k].ap(m);});
      return {mon:m,elite:el};
    }
    function startAbyss(L){
      const g=genAbyssBoss(L), mi=(L-1)%MAPS.length;
      _enterBattle(mi,bossIdx(mi),g.mon,g.elite,L);
    }
    function _enterBattle(mi,si,mon,elite,abyss){
      const m=MAPS[mi];
      B={
        mi:mi,si:si,mon:mon,elite:elite,abyss:abyss||0,
        names:['玩家',mon.name,m.mob+'甲',m.mob+'乙'],
        icons:['😺',mon.icon,m.mobIcon,m.mobIcon],
        bhp:mon.hp, php:maxHp(), pmana:maxMana(),
        round:0, hurt:0, resUsed:false, phUsed:false, lastWin:-1, cardRevive:cardFx('revive'), momentum:0,
        hands:[[],[],[],[]], finished:[], cur:0, played:null, playedBy:-1,
        passCnt:0, mustFirst:true, sel:[], phase:'deal', dealT:0, aiT:0,
        lastAct:['','','',''], seen:new Set(), log:[], anim:[], fade:null,
        sortMode:'rank',
        hellUsed:false, sandIds:new Set(), sealedId:null, lockedPot:null,
        stunArmed:false, quakeAt:-1, quakeT:0, plagueAt:-1, plague:null, plagueImm:false,
        poisoned:false, clearStreak:0, comboUsed:false,
        scryT:0, sealCharge:0, tstop:false, bombUsed:false, subShield:false,
        bubble:null, idleT:480, enraged:false,
      };
      api.setHp(B.php);
      scene='battle';
      if(abyss)bLog('🕳 深淵第 '+abyss+' 層降臨！'+(elite.length?'（✦'+elite.map(function(k){return MON_AFFIX[k].n;}).join('·')+'）':''));
      else if(elite.length)bLog('✦ 菁英'+mon.name+'現身！詞綴：'+elite.map(function(k){return MON_AFFIX[k].n;}).join('·'));
      bLog('⚔ 討伐 '+mon.name+' 開始！');
      taunt('start');
      bDeal();
    }
    function bLog(t){if(!B)return;B.log.unshift(t);if(B.log.length>6)B.log.pop();}
    function taunt(kind){
      if(!B)return;
      const pool=(B.mon.t&&B.mon.t[kind])||TAUNTS[kind];
      if(!pool||!pool.length)return;
      B.bubble={text:pool[Math.floor(Math.random()*pool.length)],t:240,shown:0};
      B.idleT=480+Math.random()*300;
    }

    function bDeal(){
      B.round++;
      const deck=shuffle(makeDeck());
      B.hands=[[],[],[],[]];
      for(let i=0;i<52;i++)B.hands[i%4].push(deck[i]);
      B.hands.forEach(sortByRank);
      sortP();
      B.finished=[];B.played=null;B.playedBy=-1;B.passCnt=0;
      B.sel=[];B.mustFirst=true;B.lastAct=['','','',''];
      B.seen=new Set();B.anim=[];B.fade=null;
      B.hellUsed=false;B.sandIds.clear();B.sealedId=null;B.lockedPot=null;
      B.stunArmed=false;B.clearStreak=0;B.comboUsed=false;
      B.stunBoss=false;B.dodgeOff=0;B.fxFour=false;B.fxFull=false;
      B.quakeAt=-1;B.plagueAt=-1;B.quakeT=0;B.plague=null;B.plagueImm=false;
      B.phase='deal';B.dealT=0;
    }
    function sortP(){
      if(B.sortMode==='rank')sortByRank(B.hands[0]);else sortBySuit(B.hands[0]);
    }
    function mvCard(from,to,card){
      const id=cardId(card);
      B.hands[from]=B.hands[from].filter(function(c){return cardId(c)!==id;});
      B.hands[to].push(card);
      sortByRank(B.hands[to]);
      if(to===0||from===0)sortP();
    }
    function bActive(){return [0,1,2,3].filter(function(i){return !B.finished.includes(i);});}
    /* 掠奪 AI：以「最佳拆組組數」評牌力（越少＝越接近出完＝越強）── */
    function handScore(cards){
      if(!cards.length)return 0;
      try{ return partitionHand(cards).length; }catch(e){ return cards.length; }
    }
    function lexLt(a,b){ for(let i=0;i<a.length;i++){ if(a[i]<b[i])return true; if(a[i]>b[i])return false; } return false; }
    // 拿哪張：最能融入王牌組(加入後組數最少)；同分優先高點數(奪控場)，再優先重創玩家
    function bestTake(playerHand,bossHand){
      let best=null,bk=null;
      const pBase=handScore(playerHand);
      playerHand.forEach(function(c){
        const fit=handScore(bossHand.concat([c]));                 // 越小越好
        const hurt=handScore(playerHand.filter(function(x){return cardId(x)!==cardId(c);}))-pBase; // 越大越好(玩家變弱)
        const key=[fit,-(c.v*4+c.sv),-hurt];
        if(!best||lexLt(key,bk)){best=c;bk=key;}
      });
      return best;
    }
    // 丟哪張：拿掉後王最強(組數最少)的最沒用牌；同分丟最小點數
    function bestGive(bossHand,takeId){
      let best=null,bk=null;
      bossHand.forEach(function(c){
        if(cardId(c)===takeId)return;
        const after=handScore(bossHand.filter(function(x){return cardId(x)!==cardId(c);}));
        const key=[after,(c.v*4+c.sv)];
        if(!best||lexLt(key,bk)){best=c;bk=key;}
      });
      return best;
    }
    function bOppLens(self){
      return bActive().filter(function(i){return i!==self;})
        .map(function(i){return B.hands[i].length;});
    }
    function bAiTimer(){B.aiT=50+Math.floor(Math.random()*40);}

    function bOnDealDone(){
      const sks=B.mon.skills||{};
      // 掠奪（rage：越殘血搶越多；面具：改搶最小）
      let n=sks.rage?Math.min(3,Math.max(1,B.mon.hp+1-B.bhp)):(B.mon.plunder||0);
      if(B.enraged)n+=1; // 狂暴：掠奪 +1
      n=Math.max(0,n-affixSum('plun')-setSum('plun'));
      if(cardFx('plunImm')>0)n=0;
      if(n>0){
        const taken=[], given=[];
        for(let k=0;k<n&&B.hands[0].length>1;k++){
          let take;
          if(S.equip.helm){ // 面具：王只偷你最小張（防禦效果）
            take=[...B.hands[0]].sort(function(a,b){return (a.v*4+a.sv)-(b.v*4+b.sv);})[0];
          } else {
            take=bestTake(B.hands[0],B.hands[1]); // 算對王最有利的牌
          }
          if(!take)break;
          mvCard(0,1,take);taken.push(take.r+take.s);
          // 拿1丟1：丟回王手上最沒用的牌（排除剛拿走的）
          const give=bestGive(B.hands[1],cardId(take));
          if(give){mvCard(1,0,give);given.push(give.r+give.s);}
        }
        if(taken.length)
          bLog(B.mon.icon+' 掠奪你的 '+taken.join(' ')+'，丟回 '+(given.join(' ')||'無')
            +(S.equip.helm?'（👹面具：只搶最小）':''));
      }
      // 幻象：偷最大塞最小
      if(sks.illusion){
        const ph=[...B.hands[0]].sort(function(a,b){return (a.v*4+a.sv)-(b.v*4+b.sv);});
        const bh=[...B.hands[1]].sort(function(a,b){return (a.v*4+a.sv)-(b.v*4+b.sv);});
        if(ph.length>1&&bh.length){
          const take=ph[ph.length-1],give=bh[0];
          mvCard(0,1,take);mvCard(1,0,give);
          bLog('🦊 幻象！你的 '+take.r+take.s+' 被換成 '+give.r+give.s);
        }
      }
      if(sks.freshmeat&&B.round===1){pDmg(1,'Fresh meat!!');taunt('win');if(B.php<=0){bSettleDeath();if(!B)return;}}
      // 下毒
      if((sks.poison||sks.venom)&&!B.poisoned&&Math.random()<0.5){
        const pim=cardFx('poisonImm');
        const amuletBlocks=S.equip.amulet&&(!sks.venom||eqQ('amulet')===4); // 暗金護符連劇毒都擋
        const cardBlocks=pim>=1&&(!sks.venom||pim>=2);                      // 卡：普通毒v>=1、劇毒需v>=2
        if(amuletBlocks||cardBlocks){
          bLog(cardBlocks&&!amuletBlocks?'🃏 抗毒卡效，毒素無效！'
            :('📿 '+(sks.venom?'暗金護符灼灼生輝，劇毒退散！':'護符閃耀，毒素無效！')));
        } else {
          B.poisoned=true;
          bLog('☠ 你中了'+(sks.venom?'劇毒（護符無效）':'毒')+'！每局結束 -1HP');
        }
      }
      // 沙暴：蓋 2 張（避開梅花3）
      if(sks.sandstorm){
        const cands=B.hands[0].filter(function(c){return !(c.r==='3'&&c.s==='♣');});
        shuffle(cands).slice(0,2).forEach(function(c){B.sandIds.add(cardId(c));});
        if(B.sandIds.size)bLog('🌪 沙暴蓋住你 '+B.sandIds.size+' 張牌（出過一手後散去）');
      }
      // 戰吼：封最大單張（避開梅花3）
      if(sks.warcry&&cardFx('fearWard')<=0){
        const cands=B.hands[0].filter(function(c){return !(c.r==='3'&&c.s==='♣');});
        if(cands.length){
          const top=cands.sort(function(a,b){return (b.v*4+b.sv)-(a.v*4+a.sv);})[0];
          B.sealedId=cardId(top);
          bLog('🗯 戰吼！你的 '+top.r+top.s+' 本局被封印');
        }
      }
      // 魅惑：鎖一格藥水
      if(sks.charm){
        B.lockedPot=['hp','mana','anti'][Math.floor(Math.random()*3)];
        bLog('💋 魅惑！本局 '+({hp:'🧪補血瓶',mana:'⚗魔法瓶',anti:'🌿解毒藥'})[B.lockedPot]+' 被鎖住');
      }
      if(sks.burrow&&Math.random()<0.25)B.stunArmed=true;
      if(sks.quake&&Math.random()<0.5)B.quakeAt=300+Math.floor(Math.random()*900);
      if(sks.plague&&Math.random()<0.3)B.plagueAt=300+Math.floor(Math.random()*900);
      // 喬丹之石
      if(S.equip.ring){
        const back=Math.max(RAR.ringMana[eqQ('ring')],refLv('ring')>=5?2:1);
        B.pmana=Math.min(maxMana(),B.pmana+back);
        bLog('💍 喬丹之石：回復'+back+'魔');
      }
      if(B.enraged&&B.pmana>0){B.pmana--;bLog('🔥 狂暴威壓！你被奪去 1 點魔力');}
      B.phase='play';
      const pk=cardFx('peek');
      if(pk>0){B.scryT=Math.max(B.scryT,pk*60);bLog('👁 讀心卡效：開局看穿'+B.mon.name+'手牌 '+pk+' 秒');}
      B.cur=B.hands.findIndex(function(h){return h.some(function(c){return c.r==='3'&&c.s==='♣';});});
      bLog(B.names[B.cur]+' 先出（持有梅花3）');
      if(B.cur!==0)bAiTimer();
    }

    function bPlay(pidx,cards){
      const cl=classify(cards);
      if(!cl){bLog('❌ 無效牌型');return false;}
      if(B.mustFirst&&!cards.some(function(c){return c.r==='3'&&c.s==='♣';})){bLog('❌ 首手必須帶梅花3');return false;}
      if(pidx===0&&B.sealedId&&cards.some(function(c){return cardId(c)===B.sealedId;})){
        // 死鎖防護：自由出牌（不能Pass）且所有合法組合都含封印牌 → 封印碎裂
        // （實戰案例：最後一張牌被戰吼封住，無法出也無法Pass，遊戲卡死）
        const mustC3b=B.mustFirst&&B.hands[0].some(function(c){return c.r==='3'&&c.s==='♣';});
        const hasAlt=legalCombos(B.hands[0],B.played,mustC3b)
          .some(function(c){return !c.cards.some(function(cc){return cardId(cc)===B.sealedId;});});
        const canPassNow=B.played!==null&&B.playedBy!==0;
        if(!hasAlt&&!canPassNow){
          B.sealedId=null;
          bLog('🗯 封印承受不住你的氣勢，碎裂了！');
          // 不 return：本次出牌直接放行
        } else {
          bLog('🗯 那張牌被戰吼封印了！');
          return false;
        }
      }
      if(!canBeat(B.played,cl)){bLog('❌ 牌不夠大');return false;}
      const beatBoss=B.played&&B.playedBy===1&&pidx!==1;
      const ids=cards.map(cardId);
      B.hands[pidx]=B.hands[pidx].filter(function(c){return !ids.includes(cardId(c));});
      B.played=cl;B.playedBy=pidx;B.passCnt=0;B.mustFirst=false;
      cards.forEach(function(c){B.seen.add(cardId(c));});
      B.fade=null;
      B.lastAct[pidx]='出'+TYPE_ZH[cl.type];
      if(pidx===0&&B.sandIds.size){B.sandIds.clear();bLog('🌬 沙暴散去，牌面重現');}
      // 弒神：同花順直擊
      if(pidx===0&&cl.type==='straightFlush'&&sk('godslay')&&B.bhp>0)
        bossDmg(1,'⚔ 弒神一閃！');
      if(!B)return true;
      // 牌型觸發效果（玩家）
      if(pidx===0){
        if(cl.type==='fourOfAKind'&&!B.fxFour){
          B.fxFour=true;B.stunBoss=true;
          bLog('💫 鐵支威壓！'+B.mon.name+' 下一手將被眩暈');
          addFloat(W/2,H/2,'💫 王眩暈！','#ffe082');
        } else if(cl.type==='fullHouse'&&!B.fxFull){
          B.fxFull=true;B.scryT=Math.max(B.scryT,180);
          bLog('🔎 葫蘆窺探：看穿'+B.mon.name+'手牌 3 秒');
        } else if(cl.type==='straight'&&B.pmana<maxMana()){
          B.pmana=Math.min(maxMana(),B.pmana+1);bLog('🌀 順子凝魔 +1');
        } else if(cl.type==='triple'&&!B.dodgeOff){
          B.dodgeOff=0.2;bLog('🎯 三條破勢！'+B.mon.name+' 本局閃避 -20%');
        }
      }
      if(pidx===0&&(cl.type==='fourOfAKind'||cl.type==='straightFlush'))taunt('bomb');
      // 搶劫：玩家出五張牌型
      if(pidx===0&&cl.cards.length===5&&(B.mon.skills||{}).steal){
        S.chips=Math.max(0,S.chips-50);
        addFloat(W/2,H/2+90,'👺 -50元','#ef9a9a');
        bLog('👺 出大牌的瞬間被搜刮了 50 元！');
      }
      // 地獄火：本局第一個壓過王的玩家
      if(beatBoss&&pidx===0&&!B.hellUsed&&(B.mon.skills||{}).hellfire){
        B.hellUsed=true;
        if(cardFx('hellRefl')>0){
          bLog('🛡🔥 業火反噬！地獄火被彈回 '+B.mon.name);
          bossDmg(1,'🔥 業火反噬！');
          if(!B)return true;
        } else if(S.equip.weapon){
          bLog('🗡 弒神之刃格擋了地獄火！');
        } else if(B.hands[0].length){
          const sorted=[...B.hands[0]].sort(function(a,b){return (a.v*4+a.sv)-(b.v*4+b.sv);});
          const burn=sorted[sorted.length-1];
          B.hands[0]=B.hands[0].filter(function(c){return cardId(c)!==cardId(burn);});
          sortP();
          bLog('🔥 地獄火！你的 '+burn.r+burn.s+' 被燒毀');
          pDmg(1,'被地獄火灼傷');
          if(B.php<=0){bSettleDeath();if(!B)return true;}
        }
      }
      const FROM=[[W/2,H-150],[W/2,120],[70,H/2],[W-70,H/2]][pidx];
      B.anim=cards.map(function(c,i){
        return {card:c,x:FROM[0]-cards.length*25+i*50,y:FROM[1]-34,alpha:1};});
      bLog(B.names[pidx]+' 出 '+cards.map(function(c){return c.r+c.s;}).join(' ')+'（'+TYPE_ZH[cl.type]+'）');

      if(B.hands[pidx].length===0){
        B.finished.push(pidx);
        B.lastAct[pidx]='🎉 完牌';
        const rest=[0,1,2,3].filter(function(i){return i!==pidx;})
          .sort(function(a,b){
            return B.hands[a].length-B.hands[b].length
              ||handPenalty(B.hands[a])-handPenalty(B.hands[b])||a-b;});
        B.finished=B.finished.concat(rest);
        bSettle();
        return true;
      }
      // 時停：玩家出牌後直接清桌再領
      if(pidx===0&&B.tstop){
        B.tstop=false;
        B.fade={cards:B.played.cards,alpha:0.6};
        B.played=null;B.playedBy=-1;B.passCnt=0;
        B.cur=0;
        bLog('⏳ 時停！桌面凝固，你再度自由出牌');
        return true;
      }
      bNext();
      return true;
    }

    function bPass(pidx){
      if(B.played===null){bLog('❌ 自由出牌，不能Pass');return;}
      if(B.playedBy===pidx){bLog('❌ 自己出的牌不能Pass');return;}
      B.passCnt++;
      B.lastAct[pidx]='Pass';
      bLog(B.names[pidx]+' Pass');
      if(pidx===0&&(B.mon.skills||{}).fear&&cardFx('fearWard')<=0&&Math.random()<0.2){
        S.chips=Math.max(0,S.chips-20);
        addFloat(W/2,H/2+90,'👻 嚇掉 20元','#b39ddb');
      }
      const needed=bActive().filter(function(i){return i!==B.playedBy;}).length;
      if(B.passCnt>=needed){
        B.fade={cards:B.played.cards,alpha:0.6};
        let lead=B.playedBy;
        if(B.finished.includes(lead)){
          lead=(lead+1)%4;
          while(B.finished.includes(lead))lead=(lead+1)%4;
        }
        B.played=null;B.playedBy=-1;B.passCnt=0;
        B.cur=lead;
        bLog('🔄 一圈Pass，'+B.names[lead]+' 自由出牌');
        // 憎恨：王清桌奪權 → 吸 1 魔
        if(lead===1&&(B.mon.skills||{}).hatred&&cardFx('fearWard')<=0&&B.pmana>0){
          B.pmana--;
          bLog('👿 憎恨吞噬，你被吸走 1 點魔力');
          taunt('win');
        }
        // 連斬：玩家連續 2 次清桌奪權
        if(lead===0){
          B.clearStreak++;
          if(B.clearStreak>=2&&sk('combo2')&&!B.comboUsed&&B.bhp>0){
            B.comboUsed=true;
            bossDmg(1,'🗡 連斬！');
            if(!B)return;
          }
        } else B.clearStreak=0;
        if(B.cur!==0)bAiTimer();
        return;
      }
      bNext();
    }
    function bNext(){
      let next=(B.cur+1)%4,c=0;
      while(B.finished.includes(next)&&c<4){next=(next+1)%4;c++;}
      B.cur=next;
      if(B.cur!==0)bAiTimer();
    }
    function bossDmg(n,why,instant){
      if(instant===undefined)instant=true;
      const dodge=Math.max(0,(B.mon.dodge||0)*(1-0.5*sk('pierce'))-(B.dodgeOff||0));
      if(dodge>0&&Math.random()<dodge){
        bLog('💨 '+B.mon.name+' 閃避了攻擊！');
        addFloat(W/2,96,'MISS','#90a4ae');
        return;
      }
      B.bhp=Math.max(0,B.bhp-n);
      B.quakeT=Math.max(B.quakeT,16);
      addFloat(W/2,96,'-'+n+' HP','#ef5350');
      if(why)bLog(why+' '+B.mon.name+' -'+n+'HP（'+B.bhp+'/'+B.mon.hp+'）');
      if(sk('blood')){
        const g=30*sk('blood')*n;
        S.chips+=g;addFloat(W/2,118,'+'+g+'元','#ffd54f');
      }
      taunt('hit');
      // 場中即死：炸裂卡/連斬/弒神打到 0 血直接結算（結算路徑 instant=false 交給 bSettle 處理復活與勝負）
      if(instant&&B.bhp<=0){
        const sks=B.mon.skills||{};
        if(sks.resurrect&&!B.resUsed){
          B.resUsed=true;B.bhp=B.mon.hp;
          bLog('⚰ '+B.mon.name+' 滿血復活了！！');taunt('start');
        } else {
          victory([(why||'致命一擊')+'　'+B.mon.name+' 被打到沒血了！']);
        }
      }
    }
    function pDmg(n,why){
      if(B.subShield){
        B.subShield=false;
        bLog('🃏 替身卡碎裂，替你擋下了'+(why||'傷害')+'！');
        return;
      }
      if(S.equip.armor&&Math.random()<blockPct()){
        bLog('🛡 骨甲擋下了'+(why||'傷害')+'！');return;
      }
      B.php=Math.max(0,B.php-n);
      B.hurt+=n;
      api.setHp(B.php);
      addFloat(120,H-90,'-'+n+' HP','#ef5350');
      bLog('💔 '+(why||'受創')+' -'+n+'HP（'+B.php+'/'+maxHp()+'）');
    }

    /* ── 局結算 ── */
    function bSettle(){
      B.phase='between';
      const winner=B.finished[0];
      B.lastWin=winner;
      if(winner!==0)B.momentum=0;
      const sks=B.mon.skills||{};
      const lines=[];
      // 金流（只有玩家籌碼是真的）
      if(winner===0){
        let pot=0;
        for(let r=1;r<4;r++)pot+=handPenalty(B.hands[B.finished[r]]);
        const gbonus=affixSum('gold')+cardFx('gold')+setSum('gold');
        if(gbonus)pot+=gbonus;
        S.chips+=pot;
        lines.push('🥇 你奪下頭家！收下怪物們的罰金 +'+pot+'元'+(gbonus?'（含生財 +'+gbonus+'）':''));
      } else {
        let pen=handPenalty(B.hands[0]);
        if(winner===1&&sks.gold){pen=Math.floor(pen*1.5);lines.push('🪙 吞金獸加倍索賠！');}
        if(B.mon._greed){pen=Math.floor(pen*1.5);lines.push('💰 貪婪菁英敲詐！罰金加重');}
        S.chips=Math.max(0,S.chips-pen);
        lines.push('💸 你的剩牌罰金 -'+pen+'元');
      }
      // 戰況裁決
      if(winner===0){
        const crit=B.hands[1].length>=critTh();
        let dmg=1+(crit?1:0);
        if(crit)lines.push('💥 暴擊！'+B.mon.name+' 剩 '+B.hands[1].length+' 張（門檻 '+critTh()+'）');
        if(B.momentum>=100){dmg*=2;B.momentum=0;lines.push('🔥 氣勢爆發！頭家裁決傷害翻倍！');}
        else B.momentum=Math.min(100,B.momentum+34);
        const before=B.bhp;
        bossDmg(dmg,'⚔ 頭家裁決！',false);
        if(B.bhp<before)
          lines.push('⚔ '+B.mon.name+' -'+(before-B.bhp)+'HP（'+B.bhp+'/'+B.mon.hp+'）');
        else lines.push('💨 '+B.mon.name+' 閃避了頭家裁決！');
        if(B.mon._thorn&&cardFx('quakeWard')<=0&&Math.random()<0.3){
          pDmg(1,'菁英反震');
          lines.push('🌵 反震！菁英尖刺扎了你 -1HP（'+B.php+'/'+maxHp()+'）');
        }
        if(Math.random()<0.25){
          const k=['hp','mana','anti'][Math.floor(Math.random()*3)];
          S.items[k]++;
          lines.push('🎁 戰利品：'+({hp:'🧪補血瓶',mana:'⚗魔法瓶',anti:'🌿解毒藥'})[k]+'×1');
        }
      } else if(winner===1){
        pDmg(1,'被'+B.mon.name+'踐踏');
        lines.push('💔 魔王奪冠，你 -1HP（'+B.php+'/'+maxHp()+'）');
        {
          taunt('win');
          if(sks.tax&&cardFx('taxWard')<=0){
            S.chips=Math.max(0,S.chips-50);
            B.bhp=Math.min(B.mon.hp,B.bhp+1);
            lines.push('💀 吸魂！-50元，'+B.mon.name+' 回復至 '+B.bhp+'/'+B.mon.hp);
          }
        }
      } else {
        // 小怪兵奪冠：只有玩家墊底才挨羞辱拳
        if(B.finished[3]===0){
          pDmg(1,'墊底被'+B.names[winner]+'羞辱');
          lines.push('💔 你墊底了，-1HP（'+B.php+'/'+maxHp()+'）');
        } else {
          lines.push('😮‍💨 '+B.names[winner]+'搶了頭香，你逃過一劫');
        }
      }
      // 狂暴階段：大魔王血量首次跌破半血（abyss 也算 boss）
      if(B.mon.boss&&!B.enraged&&B.bhp>0&&B.bhp<=Math.ceil(B.mon.hp*0.5)){
        B.enraged=true;
        lines.push('🔥🔥 '+B.mon.name+' 狂暴了！出手更兇、掠奪加劇、每局奪你 1 魔！');
        taunt('hit');
      }
      if(B.poisoned&&B.php>0){
        pDmg(1,'毒發');
        lines.push('☠ 毒發 -1HP（解毒藥可解）');
      }
      if(sk('usury')&&S.chips>0){
        const g=Math.min(200,Math.floor(S.chips*0.03*sk('usury')));
        if(g>0){S.chips+=g;lines.push('🍀 高利貸利息 +'+g+'元');}
      }
      save();

      if(B.bhp<=0){
        if(sks.resurrect&&!B.resUsed){
          B.resUsed=true;
          B.bhp=B.mon.hp;
          lines.push('⚰ '+B.mon.name+' 滿血復活了！！');
          taunt('start');
        } else { victory(lines); return; }
      }
      if(B.php<=0){
        if(B.cardRevive>0){
          B.cardRevive--;B.php=1;api.setHp(1);
          lines.push('⚰ 冥王庇佑！你以 1HP 撐住（剩 '+B.cardRevive+' 次）');
        } else if(sk('phoenix')&&!B.phUsed&&Math.random()<0.3){
          B.phUsed=true;B.php=1;api.setHp(1);
          lines.push('🪽 不死鳥之力！你以 1HP 浴火重生');
        } else { defeat(lines); return; }
      }
      const rg=affixSum('regen')+setSum('regen');
      if(rg&&B.php<maxHp()){
        const heal=Math.min(rg,maxHp()-B.php);
        B.php+=heal;api.setHp(B.php);
        lines.push('🌱 回春 +'+heal+'HP（'+B.php+'/'+maxHp()+'）');
      }
      api.showMsg('第 '+B.round+' 局結算',
        lines.join('\n')+'\n\n'+B.mon.icon+' '+B.mon.name+'　'
        +'❤'.repeat(Math.max(B.bhp,0))+'🖤'.repeat(Math.max(B.mon.hp-B.bhp,0))
        +'　你 ❤'+B.php+'/'+maxHp(),
        [{label:'▶ 下一局',red:true,fn:function(){api.hideMsg();bDeal();}},
         {label:'🏳 撤退',fn:function(){api.hideMsg();retreat();}}]);
    }

    function victory(prevLines){
      if(B.abyss){abyssVictory(prevLines);return;}
      const mon=B.mon, mi=B.mi, si=B.si;
      taunt('die');
      let stars=1;
      const fast=B.round<=mon.hp+1;
      if(B.hurt===0)stars=fast?3:2;
      else if(fast)stars=2;
      const old=adv.maps[mi][si];
      adv.maps[mi][si]=Math.max(old,stars);
      adv.clears++;
      const lines=prevLines.concat(['','⚱ '+mon.name+' 被淨化！',
        '⭐'.repeat(stars)+'（通關'+(B.hurt===0?'・無傷':'')+(fast?'・速殺':'')+'）']);
      S.chips+=mon.purify;
      lines.push('💰 淨化金 +'+mon.purify+'元');
      let rolls=1+(mon.boss?1:0)+((sk('exec')&&B.lastWin===0)?1:0)+((B.elite&&B.elite.length)?1:0);
      if(Math.random()<lootPct()/100)rolls++;
      for(let i=0;i<rolls;i++)lines.push(dropOne(mon));
      if(Math.random()<0.35+lootPct()/200){
        adv.cards[mon.id]=(adv.cards[mon.id]||0)+1;
        lines.push('🎴 獲得【'+mon.icon+' '+mon.name+'卡】！（可鑲入裝備孔）');
      }
      let xp=(mi+1)*15+stars*8+(mon.boss?20:0)+(mon.hidden?40:0);
      adv.xp+=xp;
      lines.push('✦ XP +'+xp);
      S.stam=Math.min(10,S.stam+2);
      lines.push('💪 活動筋骨，體力+2（'+S.stam+'/10）');
      while(adv.xp>=needXp()){
        adv.xp-=needXp();adv.lv++;adv.sp++;
        lines.push('🆙 升級！Lv '+adv.lv+'（技能點 +1'+(adv.lv%3===0?'，HP上限 +1':'')+'）');
      }
      const bi=bossIdx(mi);
      if(si===bi&&old===0){
        if(MAPS[mi].stages.some(function(s){return s.hidden;}))
          lines.push('💀 一股毀滅氣息浮現……隱藏魔王現身！');
        if(mi+1<MAPS.length)lines.push('🗺 新地圖解鎖：'+MAPS[mi+1].icon+' '+MAPS[mi+1].name);
      }
      save();
      B=null;scene='world';
      api.showMsg('🏆 討伐成功',lines.join('\n'),[
        {label:'🗺 回地圖',red:true,fn:function(){api.hideMsg();}},
        {label:'🎒 裝備',fn:function(){api.hideMsg();bagSel=null;scene='bag';}},
        {label:'⚔ 再戰一次',fn:function(){api.hideMsg();startBattle(mi,si);}},
      ]);
    }
    function defeat(prevLines){
      if(B.abyss){abyssDefeat(prevLines);return;}
      taunt('win');
      const loss=lossOf(B.mi);
      S.chips=Math.max(0,S.chips-loss);
      // 雖敗猶榮：少量 XP（撤退不給，防刷）
      const xp=(B.mi+1)*4+Math.min(B.round,6);
      adv.xp+=xp;
      S.stam=Math.min(10,S.stam+2);
      let lvLine='';
      while(adv.xp>=needXp()){
        adv.xp-=needXp();adv.lv++;adv.sp++;
        lvLine+='\n🆙 升級！Lv '+adv.lv+'（技能點 +1）';
      }
      save();
      const mi=B.mi,si=B.si,name=B.mon.name;
      B=null;scene='world';
      api.showMsg('💀 討伐失敗',
        (prevLines||[]).join('\n')+'\n\n你被'+name+'抬出了牌桌…\n💸 醫藥費 -'+loss+'元\n✦ 雖敗猶榮 XP +'+xp+lvLine,
        [{label:'🗺 舔傷口回地圖',red:true,fn:function(){api.hideMsg();}},
         {label:'😤 立刻再戰',fn:function(){api.hideMsg();startBattle(mi,si);}}]);
    }
    function retreat(){
      const loss=Math.floor(lossOf(B.mi)/2);
      S.chips=Math.max(0,S.chips-loss);
      save();
      B=null;scene='world';
      api.showMsg('🏳 戰術性撤退','留得青山在…\n💸 跑路費 -'+loss+'元',
        [{label:'🗺 回地圖',fn:function(){api.hideMsg();}}]);
    }
    function abyssVictory(prevLines){
      taunt('die');
      const L=B.abyss, mon=B.mon;
      adv.abyss.depth=L;
      const newBest=L>adv.abyss.best; if(newBest)adv.abyss.best=L;
      const lines=(prevLines||[]).concat(['','🕳 深淵第 '+L+' 層・'+mon.name+' 被擊破！'+(newBest?'（新紀錄！）':'')]);
      const gold=mon.purify; S.chips+=gold; lines.push('💰 深淵金 +'+gold+'元');
      lines.push(dropOne(mon));
      if(L%5===0){ // 每 5 層保底高稀有 + 符文
        S.mats.rune++;
        const q=Math.min(4,2+Math.floor(L/5));
        const slot=SLOT_KEYS[Math.floor(Math.random()*SLOT_KEYS.length)];
        const it=mkItem(slot,q,0.5);
        if(!S.equip[slot])S.equip[slot]=it; else if(S.bag.length<BAG_MAX)S.bag.push(it); else S.mats.refine+=salvageYield(it);
        lines.push('🎁 深淵寶藏：〔'+RAR.name[q]+'〕'+EQ_NAMES[slot].slice(2)+'　ᚱ符文×1');
      }
      const xp=20+L*6; adv.xp+=xp; lines.push('✦ XP +'+xp);
      while(adv.xp>=needXp()){adv.xp-=needXp();adv.lv++;adv.sp++;lines.push('🆙 升級！Lv '+adv.lv);}
      save();
      B=null;scene='world';
      api.showMsg('🕳 深淵　突破第 '+L+' 層',lines.join('\n')+'\n\n最深紀錄：'+adv.abyss.best+' 層',[
        {label:'⬇ 下潛第 '+(L+1)+' 層',red:true,fn:function(){api.hideMsg();startAbyss(L+1);}},
        {label:'🗺 帶寶離場',fn:function(){api.hideMsg();}},
      ]);
    }
    function abyssDefeat(prevLines){
      taunt('win');
      const L=B.abyss, name=B.mon.name;
      adv.abyss.depth=0;
      const reward=L*30; S.chips+=reward;
      const xp=L*5; adv.xp+=xp;
      let lvLine='';
      while(adv.xp>=needXp()){adv.xp-=needXp();adv.lv++;adv.sp++;lvLine+='\n🆙 升級！Lv '+adv.lv;}
      save();
      B=null;scene='world';
      api.showMsg('🕳 深淵・止步第 '+L+' 層',
        (prevLines||[]).join('\n')+'\n\n你倒在 '+name+' 面前…\n💰 深淵結算 +'+reward+'元　✦ XP +'+xp+lvLine
        +'\n\n最深紀錄：'+adv.abyss.best+' 層',
        [{label:'🗺 回地圖',red:true,fn:function(){api.hideMsg();}},
         {label:'🕳 再戰深淵（第1層）',fn:function(){api.hideMsg();startAbyss(1);}}]);
    }
    function dropOne(mon){
      const pool=(mon.drops&&mon.drops.length)?mon.drops:['refine'];
      const kind=pool[Math.floor(Math.random()*pool.length)];
      if(kind==='equip'){
        const q=rollRarity(B?B.mi:0,!!mon.boss);
        const empty=SLOT_KEYS.filter(function(k){return !S.equip[k];});
        const slot=empty.length?empty[Math.floor(Math.random()*empty.length)]
                               :SLOT_KEYS[Math.floor(Math.random()*SLOT_KEYS.length)];
        const item=mkItem(slot,q,mon.boss?0.22:0.12);
        const tag='〔'+RAR.name[q]+'〕【'+EQ_NAMES[slot]+(item.slots?'〔'+item.slots+'孔〕':'')+'】'+(item.set?'〔'+SETS[item.set].n+'套〕':'');
        if(!S.equip[slot]){S.equip[slot]=item;return '✨ 掉落'+tag+'！已自動裝備';}
        if(S.bag.length<BAG_MAX){S.bag.push(item);return '✨ 掉落'+tag+' → 進倉庫（可換裝）';}
        const g=salvageYield(item);S.mats.refine+=g;
        return '🎒 倉庫已滿，'+tag+' 自動分解為 💠×'+g;
      }
      if(kind==='refine'){
        if(mon.boss&&Math.random()<0.35){S.mats.refine2++;return '💠✨ 掉落華麗精煉石×1（共'+S.mats.refine2+'）';}
        S.mats.refine++;return '💠 掉落精煉石×1（共'+S.mats.refine+'）';
      }
      if(kind==='rune'){S.mats.rune++;return 'ᚱ 掉落符文×1（共'+S.mats.rune+'）';}
      if(kind==='hpPotion'){S.items.hp++;return '🧪 掉落補血瓶×1';}
      if(kind==='manaPotion'){S.items.mana++;return '⚗ 掉落魔法瓶×1';}
      if(kind==='card'){
        adv.cards[mon.id]=(adv.cards[mon.id]||0)+1;
        return '🎴 獲得【'+mon.icon+' '+mon.name+'卡】！';
      }
      S.mats.refine++;return '💠 掉落精煉石×1';
    }

    /* ── 戰鬥內藥水/施法 ── */
    const SPELLS=[
      {id:'heal',icon:'✨',cost:1,
       need:function(){return true;},
       can:function(){return B.pmana>=1&&B.php<maxHp();},
       fn:function(){
         B.pmana--;
         const n=sk('heal2')?2:1;
         B.php=Math.min(maxHp(),B.php+n);api.setHp(B.php);
         bLog('✨ 補血術 +'+n+'HP（'+B.php+'/'+maxHp()+'）');}},
      {id:'scry',icon:'👁',cost:1,
       need:function(){return sk('scry')>0;},
       can:function(){return B.pmana>=1&&B.scryT<=0;},
       fn:function(){B.pmana--;B.scryT=360;bLog('👁 透視之眼睜開了…（6秒）');}},
      {id:'redraw',icon:'♻',cost:2,
       need:function(){return sk('redraw')>0;},
       can:function(){return B.pmana>=2&&B.hands[0].length>3;},
       fn:function(){
         B.pmana-=2;
         const n=sk('redraw')>=2?5:3;
         const mob=B.hands[2].length>=B.hands[3].length?2:3;
         const mine=shuffle([...B.hands[0]]).slice(0,Math.min(n,Math.max(0,B.hands[0].length-1)));
         const theirs=shuffle([...B.hands[mob]]).slice(0,mine.length);
         mine.forEach(function(c){mvCard(0,mob,c);});
         theirs.forEach(function(c){mvCard(mob,0,c);});
         bLog('♻ 重組！與'+B.names[mob]+'盲換 '+mine.length+' 張');}},
      {id:'seal',icon:'🔒',cost:2,
       need:function(){return sk('seal')>0;},
       can:function(){return B.pmana>=2&&B.sealCharge<=0;},
       fn:function(){B.pmana-=2;B.sealCharge=1;bLog('🔒 封印詠唱完成：'+B.mon.name+'下次行動將被迫 Pass');}},
      {id:'tstop',icon:'⏳',cost:3,
       need:function(){return sk('tstop')>0;},
       can:function(){return B.pmana>=3&&!B.tstop;},
       fn:function(){B.pmana-=3;B.tstop=true;bLog('⏳ 時停預備：你下次出牌後將再獲自由出牌權');}},
    ];
    function usePotion(kind){
      if(B.lockedPot===kind){bLog('💋 那格藥水被魅惑鎖住了！');return;}
      if(kind==='hp'&&S.items.hp>0&&B.php<maxHp()){
        S.items.hp--;B.php++;api.setHp(B.php);
        bLog('🧪 喝下補血瓶（'+B.php+'/'+maxHp()+'）');
      }
      else if(kind==='mana'&&S.items.mana>0&&B.pmana<maxMana()){
        S.items.mana--;B.pmana=maxMana();
        bLog('⚗ 魔法全滿（'+B.pmana+'/'+maxMana()+'）');
      }
      else if(kind==='anti'&&S.items.anti>0&&(B.poisoned||(B.plague&&!B.plagueImm))){
        S.items.anti--;
        if(B.poisoned){B.poisoned=false;bLog('🌿 毒素解除');}
        else{B.plagueImm=true;bLog('🌿 服下解毒藥，本次毒霧免疫');}
      }
      else return;
      save();
    }

    /* ── 戰鬥繪製 ── */
    function drawBattle(){
      let shook=false;
      if(B.quakeT>0){
        ctx.save();
        ctx.translate((Math.random()-0.5)*12,(Math.random()-0.5)*12);
        shook=true;
      }
      const c0=MAPBG[B.mi][0],c1=MAPBG[B.mi][1];
      const bg=ctx.createRadialGradient(W/2,H/2,60,W/2,H/2,430);
      bg.addColorStop(0,c0);bg.addColorStop(1,c1);
      ctx.fillStyle=bg;ctx.fillRect(-14,-14,W+28,H+28);
      // 競技場（血色滾邊絨布）
      ctx.save();
      const wood=ctx.createLinearGradient(W/2,H/2-250,W/2,H/2+250);
      wood.addColorStop(0,'#3a2a14');wood.addColorStop(.5,'#5a3c1e');wood.addColorStop(1,'#2c1d0c');
      ctx.fillStyle=wood;
      ctx.beginPath();ctx.ellipse(W/2,H/2,302,250,0,0,Math.PI*2);ctx.fill();
      const rim=ctx.createLinearGradient(W/2-290,H/2,W/2+290,H/2);
      rim.addColorStop(0,'#7a1414');rim.addColorStop(.5,'#e8302a');rim.addColorStop(1,'#7a1414');
      ctx.strokeStyle=rim;ctx.lineWidth=2.4;
      ctx.beginPath();ctx.ellipse(W/2,H/2,286,236,0,0,Math.PI*2);ctx.stroke();
      const felt=ctx.createRadialGradient(W/2,H/2-70,20,W/2,H/2,320);
      felt.addColorStop(0,'#3a1420');felt.addColorStop(.6,'#240b14');felt.addColorStop(1,'#13050b');
      ctx.fillStyle=felt;
      ctx.beginPath();ctx.ellipse(W/2,H/2,284,234,0,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='rgba(239,83,80,.14)';ctx.setLineDash([5,6]);ctx.lineWidth=1;
      ctx.beginPath();ctx.ellipse(W/2,H/2,172,114,0,0,Math.PI*2);ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      drawMonPanel(1,W/2-128,6,256,64,true);
      drawMonPanel(2,52,H/2-28,124,56,false);
      drawMonPanel(3,W-176,H/2-28,124,56,false);
      drawPPanel();

      drawBHand(0,'bottom');
      drawBHand(1,'top');
      drawBHand(2,'left');
      drawBHand(3,'right');

      if(B.phase==='deal'){
        for(let i=0;i<3;i++)drawCard(W/2-23-i*2,H/2-34-i*2,null,false,false);
        ctx.fillStyle='rgba(239,83,80,.85)';
        ctx.font='bold 13px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText('第 '+B.round+' 局・發牌中…',W/2,H/2+72);
      } else {
        if(B.fade){
          ctx.save();ctx.globalAlpha=B.fade.alpha;
          drawCenter(B.fade.cards,null);ctx.restore();
          B.fade.alpha-=0.015;if(B.fade.alpha<=0)B.fade=null;
        }
        if(B.played)drawCenter(B.played.cards,B.names[B.playedBy]+'　'+TYPE_ZH[B.played.type]);
      }
      // log
      ctx.save();
      ctx.fillStyle='rgba(0,0,0,.55)';rr(8,8,206,96,8);ctx.fill();
      B.log.forEach(function(m,i){
        ctx.fillStyle=i===0?'#ddd':'rgba(180,180,180,'+Math.max(0.7-i*0.1,0.2)+')';
        ctx.font=(i===0?'bold ':'')+'10px -apple-system,sans-serif';ctx.textAlign='left';
        ctx.fillText(m,15,23+i*15,192);
      });
      ctx.restore();
      // 底部戰況標
      const eliteTag=(B.elite&&B.elite.length)?'✦菁英〔'+B.elite.map(function(k){return MON_AFFIX[k].n;}).join('·')+'〕　':'';
      const tag=eliteTag+B.mon.icon+' 第'+B.round+'局　'
        +'❤'.repeat(Math.max(B.bhp,0))+'🖤'.repeat(Math.max(B.mon.hp-B.bhp,0))
        +'　暴擊門檻 '+critTh()+'張'
        +'　⚡氣勢 '+(B.momentum||0)+'%'+((B.momentum||0)>=100?'🔥':'');
      ctx.font='bold 11px -apple-system,sans-serif';
      const tgw=ctx.measureText(tag).width;
      ctx.fillStyle='rgba(70,5,5,.85)';rr(W/2-tgw/2-12,H-24,tgw+24,20,10);ctx.fill();
      ctx.fillStyle='#ff8a80';ctx.textAlign='center';
      ctx.fillText(tag,W/2,H-10);

      drawBars();
      drawBtns();
      drawBubble();
      for(let i=B.anim.length-1;i>=0;i--){
        const ac=B.anim[i];
        ctx.globalAlpha=Math.max(ac.alpha,0);
        drawCard(ac.x,ac.y,ac.card,false,true);
        ac.x+=(W/2-26-ac.x)*0.18;ac.y+=(H/2-50-ac.y)*0.18;ac.alpha-=0.04;
        if(ac.alpha<=0)B.anim.splice(i,1);
      }
      ctx.globalAlpha=1;
      if(B.cur!==0&&B.phase==='play'){
        const dots='.'.repeat(1+(Math.floor(fr/18)%3));
        ctx.fillStyle='rgba(239,83,80,.7)';
        ctx.font='bold 12px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText(B.names[B.cur]+' 思考中'+dots,W/2,H/2+72);
      }
      if(B.plague){
        ctx.save();
        const pulse=0.10+Math.sin(fr*0.1)*0.05;
        ctx.fillStyle='rgba(110,30,160,'+(0.12+pulse).toFixed(2)+')';
        ctx.fillRect(-14,-14,W+28,H+28);
        ctx.fillStyle='rgba(200,140,255,.85)';
        ctx.font='bold 12px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText('☣ 毒霧蔓延 '+Math.ceil(B.plague.t/60)+'s'+(B.plagueImm?'（你已免疫）':''),W/2,128);
        ctx.restore();
      }
      drawFloats();
      if(shook)ctx.restore();
    }
    function drawMonPanel(idx,px,py,w,h,isBoss){
      const isActive=B.cur===idx&&B.phase==='play';
      const isDone=B.finished.includes(idx);
      ctx.save();
      if(isActive){ctx.shadowColor='rgba(239,83,80,.55)';ctx.shadowBlur=14;}
      const pg=ctx.createLinearGradient(px,py,px,py+h);
      if(isBoss){pg.addColorStop(0,'rgba(70,8,8,.95)');pg.addColorStop(1,'rgba(25,2,2,.95)');}
      else{pg.addColorStop(0,'rgba(35,18,40,.92)');pg.addColorStop(1,'rgba(14,7,18,.92)');}
      ctx.fillStyle=pg;rr(px,py,w,h,9);ctx.fill();
      ctx.shadowColor='transparent';ctx.shadowBlur=0;
      ctx.strokeStyle=isBoss?'rgba(239,83,80,.85)':isActive?'rgba(239,83,80,.6)':'rgba(255,255,255,.1)';
      ctx.lineWidth=isBoss?1.6:1;rr(px,py,w,h,9);ctx.stroke();
      ctx.globalAlpha=isDone?0.55:1;
      ctx.font=(isBoss?'28px':'20px')+' sans-serif';ctx.textAlign='left';
      ctx.fillText(B.icons[idx],px+8,py+h/2+(isBoss?10:8));
      ctx.globalAlpha=1;
      ctx.fillStyle=isBoss?'#ff6659':'#e0c8e8';
      ctx.font='bold 12px -apple-system,sans-serif';
      ctx.fillText(B.names[idx],px+(isBoss?44:34),py+17);
      if(isBoss){
        ctx.font='12px sans-serif';
        ctx.fillText('❤'.repeat(Math.max(B.bhp,0))+'🖤'.repeat(Math.max(B.mon.hp-B.bhp,0)),px+44,py+34);
        const icons=Object.keys(B.mon.skills||{}).map(function(k){
          return (MSKILL[k]||'❓').split(' ')[0];}).join('');
        ctx.font='10px sans-serif';
        ctx.fillText(icons,px+44,py+50);
      }
      ctx.fillStyle=(B.hands[idx].length<=3&&!isDone)?'#ef5350':'#999';
      ctx.font='bold 10px monospace';ctx.textAlign='right';
      ctx.fillText(B.hands[idx].length+'張',px+w-8,py+17);
      if(B.lastAct[idx]&&!isDone){
        ctx.fillStyle=B.lastAct[idx]==='Pass'?'#7fa8d8':'#bbb';
        ctx.font='10px -apple-system,sans-serif';ctx.textAlign='right';
        ctx.fillText(B.lastAct[idx],px+w-8,py+32);
      }
      if(isActive){
        const pulse=0.5+Math.sin(fr*0.15)*0.5;
        ctx.fillStyle='rgba(239,83,80,'+pulse.toFixed(2)+')';
        ctx.beginPath();ctx.arc(px+w-10,py+h-9,4,0,Math.PI*2);ctx.fill();
      }
      ctx.restore();
    }
    function drawPPanel(){
      const px=8,py=H-68,w=160,h=56;
      const isActive=B.cur===0&&B.phase==='play';
      ctx.save();
      if(isActive){ctx.shadowColor='rgba(245,196,0,.55)';ctx.shadowBlur=14;}
      const pg=ctx.createLinearGradient(px,py,px,py+h);
      if(isActive){pg.addColorStop(0,'rgba(70,56,8,.92)');pg.addColorStop(1,'rgba(40,32,4,.92)');}
      else{pg.addColorStop(0,'rgba(22,27,34,.92)');pg.addColorStop(1,'rgba(10,13,18,.92)');}
      ctx.fillStyle=pg;rr(px,py,w,h,9);ctx.fill();
      ctx.shadowColor='transparent';ctx.shadowBlur=0;
      ctx.strokeStyle=isActive?'rgba(245,196,0,.75)':'rgba(255,255,255,.1)';
      ctx.lineWidth=isActive?1.5:1;rr(px,py,w,h,9);ctx.stroke();
      ctx.font='20px sans-serif';ctx.textAlign='left';
      ctx.fillText('😺',px+7,py+h/2+8);
      ctx.fillStyle=isActive?'#f5c400':'#e8e8e8';
      ctx.font='bold 12px -apple-system,sans-serif';
      ctx.fillText('玩家 Lv'+adv.lv+(B.poisoned?' ☠':''),px+34,py+16);
      ctx.fillStyle='#f5c400';ctx.font='bold 11px monospace';
      ctx.fillText('$'+S.chips,px+34,py+29);
      ctx.font='8px sans-serif';
      ctx.fillStyle='#ef5350';
      ctx.fillText('❤'.repeat(Math.max(B.php,0))+'🖤'.repeat(Math.max(maxHp()-B.php,0)),px+34,py+41);
      ctx.fillStyle='#64b5f6';
      ctx.fillText('⚡'.repeat(Math.max(B.pmana,0)),px+34,py+51);
      ctx.fillStyle='#999';ctx.font='bold 10px monospace';ctx.textAlign='right';
      ctx.fillText(B.hands[0].length+'張',px+w-8,py+16);
      ctx.restore();
    }
    function visCount(idx){
      if(B.phase!=='deal')return B.hands[idx].length;
      const dealt=Math.floor(B.dealT/2);
      return Math.max(0,Math.min(B.hands[idx].length,Math.ceil((dealt-idx)/4)));
    }
    function drawBHand(idx,dir){
      const hand=B.hands[idx];
      const n=visCount(idx);
      if(n===0)return;
      const cw=46;
      const faceBoss=B.scryT>0&&idx===1;
      const faceMob=B.scryT>0&&sk('scry')>=2&&(idx===2||idx===3);
      if(dir==='bottom'){
        const bw=cw*1.25;
        const maxSpread=Math.min((n-1)*36+bw,W-50);
        const step=n>1?(maxSpread-bw)/(n-1):0;
        const startX=(W-maxSpread)/2;
        for(let i=0;i<n;i++){
          const x=startX+i*step;
          const id=cardId(hand[i]);
          const isSel=B.sel.some(function(c){return cardId(c)===id;});
          drawCard(x,H-168-(isSel?18:0),hand[i],isSel,!B.sandIds.has(id),1.25);
          if(B.sealedId===id){
            ctx.font='14px sans-serif';ctx.textAlign='center';
            ctx.fillText('🔒',x+bw/2,H-176-(isSel?18:0));
          }
        }
      } else if(dir==='top'){
        const step=Math.min(20,Math.floor((W-300)/Math.max(n,1)));
        const startX=(W-(n-1)*step-cw)/2;
        for(let i=0;i<n;i++)drawCard(startX+i*step,76,hand[i],false,faceBoss,0.74);
      } else {
        const x=dir==='left'?10:W-46;
        const step=Math.min(17,(H-240)/Math.max(n,1));
        const startY=(H-(n-1)*step-54)/2;
        for(let i=0;i<n;i++)drawCard(x,startY+i*step,hand[i],false,faceMob,0.8);
      }
    }
    function drawCenter(cards,label){
      const n=cards.length;
      const cw=46*1.15,gap=58;
      const startX=W/2-((n-1)*gap+cw)/2, cy=H/2-50;
      if(label){
        ctx.font='bold 11px -apple-system,sans-serif';
        const tw=ctx.measureText(label).width;
        ctx.fillStyle='rgba(0,0,0,.55)';rr(W/2-tw/2-10,cy-26,tw+20,18,9);ctx.fill();
        ctx.strokeStyle='rgba(239,83,80,.4)';rr(W/2-tw/2-10,cy-26,tw+20,18,9);ctx.stroke();
        ctx.fillStyle='rgba(255,138,128,.95)';ctx.textAlign='center';
        ctx.fillText(label,W/2,cy-13);
      }
      for(let i=0;i<n;i++)drawCard(startX+i*gap,cy,cards[i],false,true,1.15);
    }
    function drawBars(){
      if(B.phase==='between')return;
      const pots=[{k:'hp',ic:'🧪',n:S.items.hp,on:S.items.hp>0&&B.php<maxHp()},
                  {k:'mana',ic:'⚗',n:S.items.mana,on:S.items.mana>0&&B.pmana<maxMana()},
                  {k:'anti',ic:'🌿',n:S.items.anti,on:S.items.anti>0&&(B.poisoned||(B.plague&&!B.plagueImm))}];
      let x=W-3*50-8;
      ctx.save();
      pots.forEach(function(p){
        const locked=B.lockedPot===p.k;
        const on=p.on&&!locked;
        ctx.fillStyle=on?'rgba(40,30,12,.9)':'rgba(18,18,22,.75)';
        rr(x,8,44,36,7);ctx.fill();
        ctx.strokeStyle=on?'rgba(245,196,0,.55)':'rgba(255,255,255,.08)';
        rr(x,8,44,36,7);ctx.stroke();
        ctx.globalAlpha=on?1:0.4;
        ctx.font='15px sans-serif';ctx.textAlign='center';
        ctx.fillText(locked?'💋':p.ic,x+22,28);
        ctx.globalAlpha=1;
        ctx.fillStyle=on?'#f5c400':'#666';ctx.font='bold 9px monospace';
        ctx.fillText('×'+p.n,x+22,40);
        if(on){
          const kk=p.k, xx=x;
          hot.push({x:xx,y:8,w:44,h:36,fn:function(){usePotion(kk);}});
        }
        x+=50;
      });
      const learned=SPELLS.filter(function(s){return s.need();});
      x=W-learned.length*50-8;
      learned.forEach(function(s){
        const on=B.phase==='play'&&s.can();
        ctx.fillStyle=on?'rgba(20,24,52,.9)':'rgba(16,16,24,.7)';
        rr(x,50,44,36,7);ctx.fill();
        ctx.strokeStyle=on?'rgba(127,119,221,.7)':'rgba(255,255,255,.08)';
        rr(x,50,44,36,7);ctx.stroke();
        ctx.globalAlpha=on?1:0.4;
        ctx.font='15px sans-serif';ctx.textAlign='center';
        ctx.fillText(s.icon,x+22,70);
        ctx.globalAlpha=1;
        ctx.fillStyle=on?'#9fa8ff':'#666';ctx.font='bold 9px monospace';
        ctx.fillText('魔'+s.cost,x+22,82);
        if(on){
          const ss=s, xx=x;
          hot.push({x:xx,y:50,w:44,h:36,fn:function(){ss.fn();save();}});
        }
        x+=50;
      });
      // 魔法卡列（一次性，僅顯示持有的）
      const cards=[
        {k:'sub', ic:'🃏',n:S.items.sub, on:S.items.sub>0&&!B.subShield,
         use:function(){S.items.sub--;B.subShield=true;bLog('🃏 替身卡展開：下一次傷害由它承受');}},
        {k:'bomb',ic:'💣',n:S.items.bomb,on:S.items.bomb>0&&!B.bombUsed&&B.bhp>0,
         use:function(){S.items.bomb--;B.bombUsed=true;bossDmg(1,'💣 炸裂卡！');}},
        {k:'fore',ic:'🔮',n:S.items.fore,on:S.items.fore>0&&B.scryT<=0,
         use:function(){S.items.fore--;B.scryT=360;bLog('🔮 預知卡：看穿'+B.mon.name+'的手牌（6秒）');}},
      ].filter(function(c){return c.n>0;});
      let cx2=W-cards.length*50-8;
      cards.forEach(function(c){
        ctx.fillStyle=c.on?'rgba(46,16,46,.9)':'rgba(18,14,20,.7)';
        rr(cx2,92,44,36,7);ctx.fill();
        ctx.strokeStyle=c.on?'rgba(218,112,214,.65)':'rgba(255,255,255,.08)';
        rr(cx2,92,44,36,7);ctx.stroke();
        ctx.globalAlpha=c.on?1:0.4;
        ctx.font='15px sans-serif';ctx.textAlign='center';
        ctx.fillText(c.ic,cx2+22,112);
        ctx.globalAlpha=1;
        ctx.fillStyle=c.on?'#e8a8e8':'#666';ctx.font='bold 9px monospace';
        ctx.fillText('×'+c.n,cx2+22,124);
        if(c.on&&B.phase==='play'){
          const cc=c, xx=cx2;
          hot.push({x:xx,y:92,w:44,h:36,fn:function(){cc.use();save();}});
        }
        cx2+=50;
      });
      ctx.restore();
      btn(8,110,72,28,'🏳 撤退',function(){
        api.showMsg('🏳 確定撤退？','跑路費 '+Math.floor(lossOf(B.mi)/2)+' 元（戰敗的一半）',
          [{label:'跑！',red:true,fn:function(){api.hideMsg();retreat();}},
           {label:'再拚一下',fn:function(){api.hideMsg();}}]);
      });
    }
    function drawBtns(){
      if(B.cur!==0||B.phase!=='play')return;
      const canPlay=B.sel.length>0;
      const canPass=B.played!==null&&B.playedBy!==0;
      btn(W/2-160,H-56,60,38,'💡提示',function(){
        const mustC3=B.mustFirst&&B.hands[0].some(function(c){return c.r==='3'&&c.s==='♣';});
        const combos=legalCombos(B.hands[0],B.played,mustC3)
          .filter(function(c){return !B.sealedId||!c.cards.some(function(cc){return cardId(cc)===B.sealedId;});});
        if(!combos.length){bLog('💡 沒有牌能壓，建議 Pass');B.sel=[];}
        else{B.sel=[...combos[0].cards];bLog('💡 已幫你選最小可出牌');}
      },'gold');
      btn(W/2-92,H-56,84,38,'出牌',canPlay?function(){
        // bPlay 可能同步觸發 victory/defeat → B 被設 null，回頭再碰 B.sel 會炸
        if(bPlay(0,B&&B.sel)&&B)B.sel=[];
      }:null,'red');
      btn(W/2+8,H-56,84,38,'Pass',canPass?function(){
        bPass(0);if(B)B.sel=[];
      }:null);
      btn(W/2+100,H-56,60,38,'⇅排序',function(){
        B.sortMode=B.sortMode==='rank'?'suit':'rank';sortP();
      });
      if(B.sel.length>0)
        btn(W-80,H-56,72,38,'↩ 取消',function(){B.sel=[];});
      if(canPlay){
        const cl=classify(B.sel);
        const ok=cl&&canBeat(B.played,cl)
          &&(!B.mustFirst||B.sel.some(function(c){return c.r==='3'&&c.s==='♣';}))
          &&!(B.sealedId&&B.sel.some(function(c){return cardId(c)===B.sealedId;}));
        ctx.fillStyle=ok?'rgba(120,220,120,.9)':'rgba(239,83,80,.9)';
        ctx.font='bold 11px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText(cl?TYPE_ZH[cl.type]+(ok?' ✓':' ✗壓不過/被封'):'✗ 非法牌型',W/2,H-64);
      }
      // 手牌點擊區
      const hand=B.hands[0];
      const bw=46*1.25,chh=68*1.25;
      const maxSpread=Math.min((hand.length-1)*36+bw,W-50);
      const step=hand.length>1?(maxSpread-bw)/(hand.length-1):0;
      const startX=(W-maxSpread)/2;
      for(let i=hand.length-1;i>=0;i--){
        const cx=startX+i*step;
        const id=cardId(hand[i]);
        const isSel=B.sel.some(function(sc){return cardId(sc)===id;});
        const cy=H-168-(isSel?18:0);
        const card=hand[i];
        hot.push({x:cx,y:cy,w:(i===hand.length-1?bw:(step||bw)),h:chh,fn:function(){
          const j=B.sel.findIndex(function(sc){return cardId(sc)===id;});
          if(j>=0)B.sel.splice(j,1);else B.sel.push(card);
        }});
      }
    }
    /* 垃圾話泡泡（打字機）*/
    function drawBubble(){
      if(!B||!B.bubble)return;
      const bub=B.bubble;
      bub.shown=Math.min(bub.text.length,bub.shown+0.45);
      const shownTxt=bub.text.slice(0,Math.ceil(bub.shown));
      ctx.save();
      const font='bold 13px -apple-system,sans-serif';
      const lines=wrap(bub.text,font,210);
      ctx.font=font;
      let bw=22;
      lines.forEach(function(l){bw=Math.max(bw,ctx.measureText(l).width+22);});
      bw=Math.min(236,bw);
      const bh=lines.length*18+12;
      const bx=W/2-bw/2, by=78;
      ctx.globalAlpha=Math.min(1,bub.t/30);
      ctx.fillStyle='rgba(245,242,235,.96)';
      rr(bx,by,bw,bh,10);ctx.fill();
      ctx.strokeStyle='rgba(120,20,20,.5)';ctx.lineWidth=1.4;
      rr(bx,by,bw,bh,10);ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(W/2-7,by+1);ctx.lineTo(W/2,by-9);ctx.lineTo(W/2+7,by+1);
      ctx.closePath();
      ctx.fillStyle='rgba(245,242,235,.96)';ctx.fill();
      // 打字機逐字
      ctx.fillStyle='#3a1010';ctx.font=font;ctx.textAlign='left';
      let used=0;
      lines.forEach(function(l,li){
        const part=shownTxt.slice(used,used+l.length);
        ctx.fillText(part,bx+11,by+17+li*18);
        used+=l.length;
      });
      ctx.restore();
      bub.t--;
      if(bub.t<=0)B.bubble=null;
    }

    /* ══════════════ 裝備頁 ══════════════ */
    const SLOT_KEYS=['weapon','armor','helm','ring','amulet'];
    function refineDesc(k){
      if(k==='weapon')return '精煉每3級：暴擊門檻 -1';
      if(k==='armor')return '精煉每級：擋傷 +5%（上限85%）';
      if(k==='ring')return '精煉滿5級：每局回 2 魔';
      return '精煉每級：撿寶 +2%';
    }
    function drawBag(){
      const bg=ctx.createLinearGradient(0,0,0,H);
      bg.addColorStop(0,'#171320');bg.addColorStop(1,'#070509');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      ctx.fillStyle='#f5c400';ctx.font='bold 17px -apple-system,sans-serif';ctx.textAlign='left';
      ctx.fillText('🎒 裝備 — 😺 燈燈騎士',20,34);
      ctx.fillStyle='#f5c400';ctx.font='bold 13px monospace';ctx.textAlign='right';
      ctx.fillText('💰 '+S.chips,W-100,34);
      btn(W-84,14,68,30,'↩ 返回',function(){scene='world';});

      // 左：角色卡（紙娃娃：裝備部位疊加 + 稀有度光圈）
      ctx.fillStyle='rgba(22,27,34,.95)';rr(14,56,156,330,12);ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,.12)';rr(14,56,156,330,12);ctx.stroke();
      const DOLL=[ // [槽位, 圖示, dx, dy, size]
        ['helm',  '👹', 92, 76, 16],
        ['amulet','📿', 92, 142, 14],
        ['weapon','🗡', 56, 112, 18],
        ['armor', '🛡', 128, 112, 18],
        ['ring',  '💍', 60, 142, 13],
      ];
      ctx.font='42px sans-serif';ctx.textAlign='center';
      ctx.fillText('😺',92,124);
      DOLL.forEach(function(d){
        const k=d[0], e=S.equip[k];
        if(!e)return;
        const q=eqQ(k);
        // 稀有度光圈
        ctx.save();
        ctx.strokeStyle=RAR.col[q];
        ctx.globalAlpha=q===4?(0.55+Math.sin(fr*0.12)*0.3):0.7; // 暗金呼吸光
        ctx.lineWidth=q>=3?2:1.2;
        ctx.beginPath();ctx.arc(d[2],d[3]-d[4]*0.35,d[4]*0.85,0,Math.PI*2);ctx.stroke();
        ctx.restore();
        ctx.font=d[4]+'px sans-serif';
        ctx.fillText(d[1],d[2],d[3]);
        if(e.lv){
          ctx.fillStyle=RAR.col[q];ctx.font='bold 8px monospace';
          ctx.fillText('+'+e.lv,d[2]+d[4]*0.8,d[3]-d[4]*0.7);
        }
      });
      ctx.fillStyle='#eee';ctx.font='bold 14px -apple-system,sans-serif';
      ctx.fillText('Lv '+adv.lv,92,162);
      ctx.fillStyle='rgba(255,255,255,.12)';rr(30,170,124,7,3);ctx.fill();
      ctx.fillStyle='#7f77dd';rr(30,170,124*Math.min(1,adv.xp/needXp()),7,3);ctx.fill();
      ctx.fillStyle='#999';ctx.font='9px monospace';
      ctx.fillText('XP '+adv.xp+'/'+needXp(),92,190);
      ctx.textAlign='left';ctx.font='11px -apple-system,sans-serif';
      const statLines=[
        '❤ 生命上限　'+maxHp(),
        '⚡ 魔力上限　'+maxMana(),
        '💥 暴擊門檻　'+critTh()+' 張',
        '🎁 撿寶加成　+'+lootPct()+'%',
        '🛡 擋傷機率　'+Math.round(blockPct()*100)+'%',
        '🎴 鑲嵌卡片　'+sockN()+' 張',
        '🏆 討伐次數　'+adv.clears,
      ];
      statLines.forEach(function(l,i){
        ctx.fillStyle='#bbb';
        ctx.fillText(l,28,212+i*23,132);
      });
      const sc=setCount(), sActive=Object.keys(sc).filter(function(id){return sc[id]>=2;});
      if(sActive.length){
        ctx.font='10px -apple-system,sans-serif';ctx.fillStyle='#d0b84e';
        ctx.fillText('🔗 '+sActive.map(function(id){return SETS[id].n+sc[id]+'/3';}).join('  '),28,212+statLines.length*23,132);
      }

      // 中：5 槽位（2欄）
      const px0=182,pw=232,ph=88,gp=10;
      SLOT_KEYS.forEach(function(k,i){
        const x=px0+(i%2)*(pw+gp), y=56+Math.floor(i/2)*(ph+gp);
        const e=S.equip[k];
        const sel=bagSel===k;
        ctx.save();
        ctx.fillStyle=e?'rgba(28,32,44,.95)':'rgba(16,18,24,.8)';
        rr(x,y,pw,ph,10);ctx.fill();
        ctx.strokeStyle=sel?'rgba(245,196,0,.9)':e?'rgba(255,255,255,.18)':'rgba(255,255,255,.07)';
        ctx.lineWidth=sel?2:1;
        if(!e)ctx.setLineDash([4,4]);
        rr(x,y,pw,ph,10);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle='#888';ctx.font='9px -apple-system,sans-serif';ctx.textAlign='left';
        ctx.fillText({weapon:'武器',armor:'防具',helm:'頭飾',ring:'戒指',amulet:'項鍊'}[k],x+10,y+15);
        if(e){
          const q=eqQ(k);
          ctx.fillStyle=RAR.col[q];ctx.font='bold 13px -apple-system,sans-serif';
          ctx.fillText('〔'+RAR.name[q]+'〕'+EQ_NAMES[k].slice(2)+(e.lv?' +'+e.lv:''),x+10,y+33);
          ctx.fillStyle='#9aa';ctx.font='10px -apple-system,sans-serif';
          const safe=safeOf(k);
          ctx.fillText(EQ_DESC[k]+'　'+(safe>0?'安定+'+safe:'⚠ 無安定'),x+10,y+49);
          // 孔位
          let so='';
          for(let s2=0;s2<(e.slots||0);s2++)so+=(s2<(e.cards||[]).length?'◆':'◇');
          ctx.fillStyle='#b9a4e8';ctx.font='12px sans-serif';
          ctx.fillText((e.slots?so:'無孔'),x+10,y+67);
          if((e.cards||[]).length){
            const cardTxt=e.cards.map(function(cid){
              const mm=findMon(cid);return mm?mm.icon:'🎴';}).join('');
            ctx.font='11px sans-serif';
            ctx.fillText(cardTxt,x+10+(e.slots||0)*14+8,y+67);
          }
          if(e.affixes&&e.affixes.length){
            let ax=x+10;ctx.font='bold 9px -apple-system,sans-serif';
            e.affixes.forEach(function(a){
              const af=AFFIX[a.t];if(!af)return;
              const tag=af.n;const tw=ctx.measureText(tag).width+10;
              ctx.fillStyle='rgba(255,255,255,.06)';rr(ax,y+73,tw,12,3);ctx.fill();
              ctx.fillStyle=af.c;ctx.fillText(tag,ax+5,y+82);
              ax+=tw+4;
            });
          } else {
            ctx.fillStyle='#777';ctx.font='8px -apple-system,sans-serif';
            ctx.fillText(refineDesc(k),x+10,y+81);
          }
        } else {
          ctx.fillStyle='#555';ctx.font='12px -apple-system,sans-serif';
          ctx.fillText('—— 未取得 ——',x+10,y+40);
          ctx.fillStyle='#444';ctx.font='9px -apple-system,sans-serif';
          ctx.fillText('討伐魔王有機率掉落',x+10,y+58);
        }
        ctx.restore();
        if(e)hot.push({x:x,y:y,w:pw,h:ph,fn:function(){bagSel=(bagSel===k?null:k);}});
      });

      // 右下：藥水/素材
      const iy=56+3*(ph+gp)+4;
      ctx.fillStyle='rgba(22,27,34,.95)';rr(182,iy,474,76,10);ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,.1)';rr(182,iy,474,76,10);ctx.stroke();
      ctx.fillStyle='#888';ctx.font='9px -apple-system,sans-serif';ctx.textAlign='left';
      ctx.fillText('藥水',196,iy+18);
      ctx.fillText('素材',420,iy+18);
      ctx.fillStyle='#ddd';ctx.font='13px -apple-system,sans-serif';
      ctx.fillText('🧪×'+S.items.hp+'　⚗×'+S.items.mana+'　🌿×'+S.items.anti,196,iy+44);
      ctx.fillText('💠×'+S.mats.refine+'　💠✨×'+S.mats.refine2+'　ᚱ×'+S.mats.rune,420,iy+44);
      const cardTotal=Object.keys(adv.cards).reduce(function(s,k){return s+adv.cards[k];},0);
      ctx.fillStyle='#9aa';ctx.font='11px -apple-system,sans-serif';
      ctx.fillText('🎴 怪物卡×'+cardTotal+'（鑲入裝備孔觸發專屬效果，卡冊可查）',196,iy+65);

      // 底部操作列（兩列）
      const by2=H-94, by=H-52;
      const selE=bagSel&&S.equip[bagSel];
      const canRef=selE&&selE.lv<10&&(S.mats.refine>=2||((selE.lv||0)+1>safeOf(bagSel)&&S.mats.refine2>0));
      const canSock=selE&&(selE.slots||0)>(selE.cards||[]).length&&cardTotal>0;
      const refTag=!selE?'⚒ 精煉':((selE.lv||0)+1<=safeOf(bagSel)
        ?'⚒ 精煉 +'+((selE.lv||0)+1)+'（💠×2・安定內必成）'
        :(S.mats.refine2>0?'⚒ 精煉 +'+((selE.lv||0)+1)+'（💠✨×1・85%）'
                          :'⚒ 精煉 +'+((selE.lv||0)+1)+'（💠×2・65%）'));
      btn(14,by2,210,36,refTag,canRef?function(){doRefine();}:null,'gold');
      btn(232,by2,210,36,'🔧 鑲嵌怪物卡',canSock?function(){socketMenu(S.equip[bagSel],function(){api.hideMsg();});}:null);
      btn(456,by2,198,36,selE?'📦 管理（卸下/分解/拆卡）':'📦 管理',selE?function(){manageEquip(bagSel);}:null);
      btn(14,by,210,36,'🎒 倉庫（'+S.bag.length+'）',function(){stashPage=0;scene='stash';});
      btn(232,by,120,36,'🎴 卡冊',openAlbum);
      btn(362,by,120,36,'🛒 商店',openShop);
      btn(492,by,162,36,'↩ 回地圖',function(){scene='world';});
      if(!bagSel){
        ctx.fillStyle='#666';ctx.font='10px -apple-system,sans-serif';ctx.textAlign='left';
        ctx.fillText('點選一件裝備以精煉/鑲嵌/管理',14,by2-8);
      }
    }
    function findMon(id){
      for(const m of MAPS)for(const st of m.stages)if(st.id===id)return st;
      return null;
    }
    /* 精煉判定（裝備頁自己敲 / 打鐵店老師傅共用）
       安定值內：💠×2 必成；超過安定（或暗金無安定）：
         有華麗石 → 吃 💠✨×1，成功率 85%（老師傅 95%）
         沒華麗石 → 吃 💠×2，成功率 65%（老師傅 80%） */
    function refineAttempt(k,bySmith){
      const e=S.equip[k];
      if(!e||e.lv>=10)return '已達上限';
      const next=(e.lv||0)+1;
      const inSafe=next<=safeOf(k);
      if(inSafe){
        if(S.mats.refine<2)return '精煉石不夠（需💠×2）';
        S.mats.refine-=2;
        e.lv=next;
        return null; // 安定內必成
      }
      let prob, used;
      if(S.mats.refine2>0){
        S.mats.refine2--;prob=bySmith?0.95:0.85;used='💠✨';
      } else if(S.mats.refine>=2){
        S.mats.refine-=2;prob=bySmith?0.80:0.65;used='💠×2';
      } else return '石頭不夠（超安定需💠×2 或 💠✨×1）';
      if(Math.random()<prob){e.lv=next;return null;}
      return 'FAIL:'+used;
    }
    function doRefine(){
      const e=S.equip[bagSel];
      if(!e)return;
      const r=refineAttempt(bagSel,false);
      if(r===null)addFloat(W/2,H/2,'⚒ 精煉成功！+'+e.lv+((e.lv<=safeOf(bagSel))?'（安定內）':''),'#ffd54f');
      else if(r.indexOf('FAIL:')===0)addFloat(W/2,H/2,'💥 精煉失敗…'+r.slice(5)+'碎了','#ef9a9a');
      else addFloat(W/2,H/2,'❌ '+r,'#ef9a9a');
      save();
    }
    function doSocket(){
      const e=S.equip[bagSel];
      if(!e||(e.slots||0)<=(e.cards||[]).length)return;
      // 取持有最多的卡鑲入
      let pick=null,max=0;
      Object.keys(adv.cards).forEach(function(k){
        if(adv.cards[k]>max){max=adv.cards[k];pick=k;}
      });
      if(!pick)return;
      adv.cards[pick]--;
      if(adv.cards[pick]<=0)delete adv.cards[pick];
      e.cards=e.cards||[];
      e.cards.push(pick);
      const mm=findMon(pick);
      addFloat(W/2,H/2,'🔧 鑲入 '+(mm?mm.icon+mm.name:'')+'卡！撿寶+3%','#b9a4e8');
      save();
    }
    function openAlbum(){
      const keys=Object.keys(adv.cards);
      let inSock={};
      SLOT_KEYS.forEach(function(k){
        const e=S.equip[k];
        if(e&&e.cards)e.cards.forEach(function(cid){inSock[cid]=(inSock[cid]||0)+1;});
      });
      const sockKeys=Object.keys(inSock);
      const body=(keys.length?keys.map(function(k){
          const mm=findMon(k);const f=CARD_FX[k];
          return (mm?mm.icon+' '+mm.name:k)+'卡 ×'+adv.cards[k]+(f?'　'+f.n+'：'+f.d:'');
        }).join('\n'):'（尚未收集到怪物卡）')
        +(sockKeys.length?'\n\n— 已鑲嵌 —\n'+sockKeys.map(function(k){
          const mm=findMon(k);const f=CARD_FX[k];
          return (mm?mm.icon+' '+mm.name:k)+'卡 ×'+inSock[k]+(f?'　'+f.d:'');
        }).join('\n'):'')
        +'\n\n鑲入裝備孔即觸發專屬效果，同卡可疊加';
      api.showMsg('🎴 怪物卡冊',body,[{label:'↩ 返回',fn:function(){api.hideMsg();}}]);
    }

    /* ══════════════ 倉庫 / 換裝 / 分解 / 拆卡（Slice 1）══════════════ */
    let stashPage=0;
    const SALV=[1,2,3,5,8]; // 分解💠：白藍黃金暗金
    function salvageYield(e){return SALV[(e.q==null?2:e.q)]+(e.lv||0);}
    function eqName(k){return EQ_NAMES[k]?EQ_NAMES[k].slice(2):k;}
    function itemLabel(e){
      const q=(e.q==null?2:e.q);
      return '〔'+RAR.name[q]+'〕'+eqName(e.slot)+(e.lv?' +'+e.lv:'')
        +((e.slots||0)?'　'+(e.cards||[]).map(function(c){var m=findMon(c);return m?m.icon:'🎴';}).join('')
            +'◇'.repeat((e.slots||0)-(e.cards||[]).length):'')
        +(e.affixes&&e.affixes.length?'　⟨'+e.affixes.map(function(a){return AFFIX[a.t]?AFFIX[a.t].n:a.t;}).join('·')+'⟩':'')
        +(e.set&&SETS[e.set]?'　🔗'+SETS[e.set].n+'套':'');
    }
    function returnCards(e){ // 分解/拆卸時把孔內卡退回卡庫
      (e.cards||[]).forEach(function(cid){adv.cards[cid]=(adv.cards[cid]||0)+1;});
    }
    function equipFromBag(idx){
      const it=S.bag[idx]; if(!it)return;
      const k=it.slot; const cur=S.equip[k];
      S.equip[k]=it; S.bag.splice(idx,1);
      if(cur){if(!cur.slot)cur.slot=k; S.bag.push(cur);}
      addFloat(W/2,H/2,'⚔ 已裝備 '+eqName(k),'#f5c400'); save();
    }
    function unequip(k){
      const e=S.equip[k]; if(!e)return false;
      if(S.bag.length>=BAG_MAX){addFloat(W/2,H/2,'❌ 倉庫已滿','#ef9a9a');return false;}
      if(!e.slot)e.slot=k; S.bag.push(e); S.equip[k]=0;
      addFloat(W/2,H/2,'📤 已卸下 '+eqName(k),'#9aa'); save(); return true;
    }
    function salvageItem(e){returnCards(e); const g=salvageYield(e); S.mats.refine+=g;
      addFloat(W/2,H/2,'💠 分解為精煉石×'+g,'#b0c4de'); save(); return g;}
    /* 鑲嵌：選要鑲哪張卡 */
    function socketMenu(e,re){
      const keys=Object.keys(adv.cards).filter(function(k){return adv.cards[k]>0;});
      if((e.slots||0)<=(e.cards||[]).length){api.showMsg('🔧 鑲嵌','此件已無空孔',[{label:'↩',fn:re}]);return;}
      if(!keys.length){api.showMsg('🔧 鑲嵌','沒有可鑲的怪物卡',[{label:'↩',fn:re}]);return;}
      const btns=keys.map(function(k){const mm=findMon(k);
        return {label:(mm?mm.icon+mm.name:k)+'卡 ×'+adv.cards[k],fn:function(){
          adv.cards[k]--; if(adv.cards[k]<=0)delete adv.cards[k];
          e.cards=e.cards||[]; e.cards.push(k);
          addFloat(W/2,H/2,'🔧 鑲入'+(mm?mm.icon:'')+'卡','#b9a4e8'); save(); re();}};});
      btns.push({label:'↩ 返回',fn:re});
      api.showMsg('🔧 選擇要鑲嵌的卡','剩餘空孔 '+((e.slots||0)-(e.cards||[]).length),btns);
    }
    /* 拆卡：選要拆哪張，免費回卡庫 */
    function unsocketMenu(e,re){
      if(!(e.cards||[]).length){api.showMsg('🃏 拆卡','此件沒有鑲嵌的卡',[{label:'↩',fn:re}]);return;}
      const btns=e.cards.map(function(cid,ci){const mm=findMon(cid);
        return {label:'拆下 '+(mm?mm.icon+mm.name:cid)+'卡',fn:function(){
          e.cards.splice(ci,1); adv.cards[cid]=(adv.cards[cid]||0)+1;
          addFloat(W/2,H/2,'🃏 已拆回卡庫','#b9a4e8'); save(); re();}};});
      btns.push({label:'↩ 返回',fn:re});
      api.showMsg('🃏 拆卸怪物卡（免費，回卡庫）','',btns);
    }
    /* 穿戴件管理選單（裝備頁「管理」鈕）*/
    /* 符文用途（Batch D）：重洗詞綴 ᚱ×2 / 鑿孔 ᚱ×3 */
    function runeBtns(e,re){
      const out=[], q=(e.q==null?2:e.q);
      if(S.mats.rune>=2)out.push({label:'ᚱ 重洗詞綴（ᚱ×2，現'+S.mats.rune+'）',fn:function(){
        S.mats.rune-=2; e.affixes=rollAffixes(q);
        addFloat(W/2,H/2,'ᚱ 詞綴已重洗','#c9b6f0'); save(); re();}});
      if(S.mats.rune>=3&&(e.slots||0)<6)out.push({label:'ᚱ 鑿孔 +1（ᚱ×3，現'+(e.slots||0)+'孔）',fn:function(){
        S.mats.rune-=3; e.slots=(e.slots||0)+1;
        addFloat(W/2,H/2,'ᚱ 鑿出新孔位','#c9b6f0'); save(); re();}});
      return out;
    }
    function manageEquip(k){
      const e=S.equip[k]; if(!e)return;
      const re=function(){api.hideMsg();manageEquip(k);};
      const close=function(){api.hideMsg();};
      const btns=[
        {label:'📤 卸下進倉庫',fn:function(){if(unequip(k))bagSel=null;close();}},
        {label:'💠 分解（'+salvageYield(e)+'💠'+((e.cards||[]).length?'＋退卡':'')+'）',fn:function(){
          salvageItem(e); S.equip[k]=0; bagSel=null; close();}},
      ];
      if((e.slots||0)>(e.cards||[]).length)btns.push({label:'🔧 鑲嵌怪物卡',fn:function(){socketMenu(e,re);}});
      if((e.cards||[]).length)btns.push({label:'🃏 拆卸怪物卡',fn:function(){unsocketMenu(e,re);}});
      runeBtns(e,re).forEach(function(b){btns.push(b);});
      btns.push({label:'↩ 返回',fn:close});
      api.showMsg('📦 '+eqName(k)+' 管理',itemLabel(e),btns);
    }
    /* 倉庫件操作選單 */
    function bagItemMenu(idx){
      const it=S.bag[idx]; if(!it)return;
      const close=function(){api.hideMsg();};
      const re=function(){api.hideMsg();bagItemMenu(idx);};
      const btns=[
        {label:'⚔ 裝備（換下現件回倉庫）',fn:function(){equipFromBag(idx);close();}},
        {label:'💠 分解（'+salvageYield(it)+'💠'+((it.cards||[]).length?'＋退卡':'')+'）',fn:function(){
          salvageItem(it); S.bag.splice(idx,1); close();}},
      ];
      if((it.slots||0)>(it.cards||[]).length)btns.push({label:'🔧 鑲嵌怪物卡',fn:function(){socketMenu(it,re);}});
      if((it.cards||[]).length)btns.push({label:'🃏 拆卸怪物卡',fn:function(){unsocketMenu(it,re);}});
      runeBtns(it,re).forEach(function(b){btns.push(b);});
      btns.push({label:'↩ 返回',fn:close});
      api.showMsg('🎒 '+eqName(it.slot)+'（倉庫）',itemLabel(it),btns);
    }
    /* 倉庫頁 */
    const STASH_ROWS=7;
    function drawStash(){
      const bg=ctx.createLinearGradient(0,0,0,H);
      bg.addColorStop(0,'#171320');bg.addColorStop(1,'#070509');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      ctx.fillStyle='#f5c400';ctx.font='bold 17px -apple-system,sans-serif';ctx.textAlign='left';
      ctx.fillText('🎒 倉庫　'+S.bag.length+'/'+BAG_MAX,20,34);
      btn(W-84,14,68,30,'↩ 返回',function(){scene='bag';});
      const pages=Math.max(1,Math.ceil(S.bag.length/STASH_ROWS));
      if(stashPage>=pages)stashPage=pages-1;
      if(!S.bag.length){
        ctx.fillStyle='#777';ctx.font='13px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText('倉庫是空的 — 討伐魔王掉的裝備會放這裡',W/2,H/2);
        ctx.textAlign='left';return;
      }
      const x=20,w=W-40,rh=58,y0=60;
      for(let r=0;r<STASH_ROWS;r++){
        const idx=stashPage*STASH_ROWS+r; if(idx>=S.bag.length)break;
        const it=S.bag[idx], q=(it.q==null?2:it.q), y=y0+r*rh;
        ctx.fillStyle='rgba(24,28,40,.95)';rr(x,y,w,rh-8,9);ctx.fill();
        ctx.strokeStyle=RAR.col[q];ctx.globalAlpha=q>=3?0.9:0.5;ctx.lineWidth=q>=3?2:1;
        rr(x,y,w,rh-8,9);ctx.stroke();ctx.globalAlpha=1;
        const ICON={weapon:'🗡',armor:'🛡',helm:'👹',ring:'💍',amulet:'📿'}[it.slot];
        ctx.font='22px sans-serif';ctx.textAlign='left';ctx.fillText(ICON,x+14,y+33);
        ctx.fillStyle=RAR.col[q];ctx.font='bold 13px -apple-system,sans-serif';
        ctx.fillText('〔'+RAR.name[q]+'〕'+eqName(it.slot)+(it.lv?' +'+it.lv:''),x+48,y+22);
        ctx.fillStyle='#9aa';ctx.font='10px -apple-system,sans-serif';
        let so='';for(let s2=0;s2<(it.slots||0);s2++)so+=(s2<(it.cards||[]).length?'◆':'◇');
        const ctxt=(it.cards||[]).map(function(c){var m=findMon(c);return m?m.icon:'';}).join('');
        ctx.fillText((it.slots?'孔 '+so+' '+ctxt:'無孔')+'　分解 💠'+salvageYield(it),x+48,y+40);
        btn(x+w-104,y+10,92,30,'操作',(function(i){return function(){bagItemMenu(i);};})(idx));
      }
      if(pages>1){
        btn(W/2-110,H-46,90,34,'◀ 上一頁',stashPage>0?function(){stashPage--;}:null);
        ctx.fillStyle='#bbb';ctx.font='12px monospace';ctx.textAlign='center';
        ctx.fillText((stashPage+1)+' / '+pages,W/2,H-25);
        btn(W/2+20,H-46,90,34,'下一頁 ▶',stashPage<pages-1?function(){stashPage++;}:null);
      }
      ctx.textAlign='left';
    }

    /* ══════════════ 技能樹頁 ══════════════ */
    function drawTree(){
      const bg=ctx.createLinearGradient(0,0,0,H);
      bg.addColorStop(0,'#121a14');bg.addColorStop(1,'#050805');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      ctx.fillStyle='#f5c400';ctx.font='bold 17px -apple-system,sans-serif';ctx.textAlign='left';
      ctx.fillText('🌳 技能樹 — Lv '+adv.lv,20,34);
      ctx.fillStyle='#ba7517';rr(220,16,92,24,12);ctx.fill();
      ctx.fillStyle='#fff';ctx.font='bold 11px -apple-system,sans-serif';ctx.textAlign='center';
      ctx.fillText('剩餘技能點 '+adv.sp,266,32);
      btn(W-238,14,86,30,'↺ 洗點 💠×5',S.mats.refine>=5?function(){
        api.showMsg('↺ 洗點','耗 💠×5 重置全部技能點，確定？',[
          {label:'洗！',red:true,fn:function(){
            api.hideMsg();
            S.mats.refine-=5;
            let back=0;
            Object.keys(PSK).forEach(function(bk){
              PSK[bk].list.forEach(function(n){back+=(adv.sk[n.id]||0);});
            });
            adv.sk={};adv.sp+=back;
            save();
          }},
          {label:'算了',fn:function(){api.hideMsg();}},
        ]);
      }:null);
      btn(W-144,14,68,30,'↩ 返回',function(){scene='world';});

      const keys=['kill','magic','luck'];
      const colW=210,gap=12,x0=(W-3*colW-2*gap)/2;
      const headBg={kill:'rgba(120,18,18,.85)',magic:'rgba(60,52,137,.85)',luck:'rgba(8,80,65,.85)'};
      const pipCol={kill:'#ef5350',magic:'#9f8df0',luck:'#4cd6a8'};
      keys.forEach(function(bk,ci){
        const x=x0+ci*(colW+gap);
        const pts=branchPts(bk);
        ctx.fillStyle=headBg[bk];rr(x,56,colW,30,8);ctx.fill();
        ctx.fillStyle='#fff';ctx.font='bold 13px -apple-system,sans-serif';ctx.textAlign='center';
        ctx.fillText(PSK[bk].name+'　已投 '+pts,x+colW/2,76);
        let y=94, lastTier=0;
        PSK[bk].list.forEach(function(n){
          if(n.tier>lastTier){
            const ok=pts>=n.tier;
            ctx.fillStyle=ok?'rgba(245,196,0,.5)':'rgba(255,255,255,.25)';
            ctx.font='9px -apple-system,sans-serif';ctx.textAlign='center';
            ctx.fillText('— 需投 '+n.tier+' 點 '+(ok?'✓':'')+' —',x+colW/2,y+8);
            y+=16;lastTier=n.tier;
          }
          const cur=adv.sk[n.id]||0;
          const gated=pts<n.tier;
          const canUp=!gated&&adv.sp>0&&cur<n.max;
          const nh=64;
          ctx.save();
          ctx.fillStyle=gated?'rgba(14,16,20,.7)':'rgba(24,28,38,.95)';
          rr(x,y,colW,nh,8);ctx.fill();
          ctx.strokeStyle=cur>0?'rgba(245,196,0,.65)':canUp?'rgba(255,255,255,.3)':'rgba(255,255,255,.08)';
          ctx.lineWidth=cur>0?1.5:1;
          if(gated)ctx.setLineDash([4,4]);
          rr(x,y,colW,nh,8);ctx.stroke();ctx.setLineDash([]);
          ctx.globalAlpha=gated?0.5:1;
          ctx.fillStyle='#eee';ctx.font='bold 12px -apple-system,sans-serif';ctx.textAlign='left';
          ctx.fillText((gated?'🔒 ':'')+n.name,x+10,y+18);
          // 投點 pips
          let pip='';
          for(let p=0;p<n.max;p++)pip+=(p<cur?'●':'○');
          ctx.fillStyle=pipCol[bk];ctx.font='11px sans-serif';ctx.textAlign='right';
          ctx.fillText(pip,x+colW-10,y+18);
          ctx.fillStyle='#9aa';ctx.font='9px -apple-system,sans-serif';ctx.textAlign='left';
          wrap(n.desc,'9px -apple-system,sans-serif',colW-20).slice(0,3)
            .forEach(function(l,li){ctx.fillText(l,x+10,y+33+li*12);});
          ctx.restore();
          if(canUp){
            const nid=n.id, yy=y;
            hot.push({x:x,y:yy,w:colW,h:nh,fn:function(){
              adv.sk[nid]=(adv.sk[nid]||0)+1;
              adv.sp--;
              addFloat(x+colW/2,yy,'＋'+n.name,'#ffd54f');
              save();
            }});
          }
          y+=nh+8;
        });
      });
      ctx.fillStyle='#666';ctx.font='10px -apple-system,sans-serif';ctx.textAlign='center';
      ctx.fillText('點擊技能卡投點・每升 1 級獲得 1 點・終極技需該系投滿 10 點',W/2,H-12);
    }

    /* ══════════════ 商店街 ══════════════ */
    function priceF(){return 1-0.15*sk('barg');}
    function invLine(){
      return '💰'+S.chips+'元'+(sk('barg')?'　🍀 議價 -'+(sk('barg')*15)+'%':'');
    }
    function buyItem(kind,cost,reopen,isMat){
      if(S.chips<cost){addFloat(W/2,H/2,'❌ 錢不夠','#ef9a9a');reopen();return;}
      S.chips-=cost;
      if(isMat)S.mats[kind]++;else S.items[kind]++;
      save();reopen();
    }
    function openShop(){ // 商店街入口（函式名沿用，呼叫點免改）
      api.showMsg('🏮 冒險者商店街',invLine()+'\n\n四間老店，各懷絕活——',[
        {label:'💊 藥妝店（藥水）',fn:function(){api.hideMsg();openPharmacy();}},
        {label:'🛡 裝備店（補缺件）',fn:function(){api.hideMsg();openArmory();}},
        {label:'⚒ 打鐵店（精煉）',fn:function(){api.hideMsg();openSmith();}},
        {label:'🔮 魔法屋（一次性卡片）',fn:function(){api.hideMsg();openMagic();}},
        {label:'🎰 賭場後門（打工賺錢）',fn:function(){api.hideMsg();openWork(null);}},
        {label:'↩ 離開',fn:function(){api.hideMsg();}},
      ]);
    }
    function backStreet(){api.hideMsg();openShop();}
    function openPharmacy(){
      const f=priceF();
      const P={hp:Math.round(150*f),mana:Math.round(200*f),anti:Math.round(100*f)};
      const re=function(){api.hideMsg();openPharmacy();};
      api.showMsg('💊 藥妝店',invLine()+'\n🧪×'+S.items.hp+' ⚗×'+S.items.mana+' 🌿×'+S.items.anti,[
        {label:'🧪 補血瓶 $'+P.hp,fn:function(){buyItem('hp',P.hp,re);}},
        {label:'⚗ 魔法瓶 $'+P.mana,fn:function(){buyItem('mana',P.mana,re);}},
        {label:'🌿 解毒藥 $'+P.anti,fn:function(){buyItem('anti',P.anti,re);}},
        {label:'↩ 回商店街',fn:backStreet},
      ]);
    }
    function openArmory(){
      const f=priceF();
      const cost=Math.round(800*f); // 店售一律白裝（安定7 入門款），高稀有靠討伐掉落
      const missing=SLOT_KEYS.filter(function(k){return !S.equip[k];});
      const re=function(){api.hideMsg();openArmory();};
      const btns=missing.map(function(k){
        return {label:'〔白〕'+EQ_NAMES[k]+' $'+cost,fn:function(){
          if(S.chips<cost){addFloat(W/2,H/2,'❌ 錢不夠','#ef9a9a');re();return;}
          S.chips-=cost;
          S.equip[k]={lv:0,q:0,slots:rollSlots(sk('sock')),cards:[]};
          save();re();
        }};
      });
      btns.push({label:'↩ 回商店街',fn:backStreet});
      api.showMsg('🛡 裝備店',invLine()
        +'\n'+(missing.length?'店售一律〔白〕裝（安定7），孔數看緣分；高稀有打王去':'五件到齊，老闆敬你是條好漢'),btns);
    }
    function openSmith(){
      const f=priceF();
      const stoneP=Math.round(250*f);
      const re=function(){api.hideMsg();openSmith();};
      const deluxeP=Math.round(800*f);
      const btns=[
        {label:'💠 精煉石 $'+stoneP,fn:function(){buyItem('refine',stoneP,re,true);}},
        {label:'💠✨ 華麗精煉石 $'+deluxeP,fn:function(){buyItem('refine2',deluxeP,re,true);}},
      ];
      SLOT_KEYS.forEach(function(k){
        const e=S.equip[k];
        if(!e||e.lv>=10)return;
        const next=(e.lv||0)+1;
        const tag=next<=safeOf(k)?'安定內必成':'老師傅 '+(S.mats.refine2>0?'95%':'80%');
        btns.push({label:'⚒〔'+RAR.name[eqQ(k)]+'〕'+EQ_NAMES[k].slice(2)+' +'+next+'（$300・'+tag+'）',fn:function(){
          if(S.chips<300){addFloat(W/2,H/2,'❌ 錢不夠','#ef9a9a');re();return;}
          S.chips-=300;
          const r=refineAttempt(k,true);
          if(r===null)addFloat(W/2,H/2,'⚒ 老師傅出手！+'+e.lv,'#ffd54f');
          else if(r.indexOf('FAIL:')===0)addFloat(W/2,H/2,'💥 連老師傅都嘆氣…'+r.slice(5)+'碎了','#ef9a9a');
          else{S.chips+=300;addFloat(W/2,H/2,'❌ '+r,'#ef9a9a');} // 沒石頭退錢
          save();re();
        }});
      });
      btns.push({label:'↩ 回商店街',fn:backStreet});
      api.showMsg('⚒ 打鐵店',invLine()+'\n💠×'+S.mats.refine+'　💠✨×'+S.mats.refine2
        +'\n安定值內精煉必定成功；超安定/暗金有華麗石自動優先使用',btns);
    }
    function openMagic(){
      const f=priceF();
      const P={sub:Math.round(300*f),bomb:Math.round(400*f),fore:Math.round(250*f)};
      const re=function(){api.hideMsg();openMagic();};
      api.showMsg('🔮 魔法屋',invLine()
        +'\n🃏×'+S.items.sub+' 💣×'+S.items.bomb+' 🔮×'+S.items.fore
        +'\n\n一次性卡片，戰鬥中點右上卡片列使用',[
        {label:'🃏 替身卡 $'+P.sub+'（擋下一次傷害）',fn:function(){buyItem('sub',P.sub,re);}},
        {label:'💣 炸裂卡 $'+P.bomb+'（王直接-1HP，每場限1）',fn:function(){buyItem('bomb',P.bomb,re);}},
        {label:'🔮 預知卡 $'+P.fore+'（看穿王手牌6秒）',fn:function(){buyItem('fore',P.fore,re);}},
        {label:'↩ 回商店街',fn:backStreet},
      ]);
    }

    /* ══════════════ 賭場打工 ══════════════ */
    const WORK_EV=[
      ['🃏 洗牌洗出殘影，荷官看傻了','賞'],
      ['🍺 端酒給醉漢，他把零錢全塞給你','小費'],
      ['🧽 擦桌時從桌縫摳出遺落籌碼','撿到'],
      ['🚪 幫大戶開門開得特別有誠意','賞'],
      ['📢 吆喝聲太洪亮，圍觀客變多','老闆賞'],
      ['🧹 掃地掃出別人輸到扔掉的籌碼','撿到'],
    ];
    function openWork(lastLine){
      const re=function(line){api.hideMsg();openWork(line);};
      const broke=S.chips<50&&S.stam<=0;
      const btns=[];
      [[1,'💪 打 1 輪工'],[3,'💪💪 打 3 輪工'],[5,'🔥 打 5 輪工'],[99,'🫠 體力榨乾打到底']]
        .forEach(function(opt){
          const n=Math.min(opt[0],S.stam);
          if(n<=0)return;
          if(opt[0]!==1&&opt[0]!==99&&S.stam<opt[0])return; // 3/5 輪需足額
          if(opt[0]===99&&S.stam<2)return;                  // 榨乾至少要 2
          btns.push({label:opt[1]+'（體力-'+n+'）',red:opt[0]===1,fn:function(){
            api.hideMsg();startWork(n);
          }});
        });
      if(broke){
        btns.push({label:'🥺 向老闆娘討口飯吃',fn:function(){
          S.stam+=1;
          save();re('💝 老闆娘嘆了口氣：「拿去，別賭了。」體力+1');
        }});
      }
      btns.push({label:'🥤 提神飲料 $50（體力+3）',fn:function(){
        if(S.chips<50){re('❌ 連飲料錢都沒有…去討口飯吧');return;}
        if(S.stam>=10){re('❌ 體力滿了，別浪費錢');return;}
        S.chips-=50;
        S.stam=Math.min(10,S.stam+3);
        save();re('🥤 咕嚕咕嚕…體力+3（'+S.stam+'/10）');
      }});
      btns.push({label:'↩ 回商店街',fn:backStreet});
      api.showMsg('🎰 賭場後門・打工小弟',
        invLine()+'　💪 '+S.stam+'/10'
        +'\n'+(lastLine||'賭場永遠缺人手。一輪工 60~180 元'+(sk('barg')?'（🍀嘴甜小費+'+(sk('barg')*15)+'%）':'')+'，5% 機率遇到豪氣大戶')
        +'\n（戰鬥結束體力+2，提神飲料隨時補）',btns);
    }

    /* ── 打工掛機場景：自動演出，玩家只要看；可翹班退還未用體力 ── */
    const ROUND_FR=140;
    function startWork(n){
      S.stam-=n; // 體力預扣，翹班按比例退
      Wk={n:n,done:0,t:0,gain:0,log:[],ev:WORK_EV[Math.floor(Math.random()*WORK_EV.length)]};
      save();
      scene='work';
    }
    function workPayout(){
      let gain=60+Math.floor(Math.random()*121);
      gain=Math.round(gain*(1+0.15*sk('barg')));
      let line;
      if(Math.random()<0.05){
        gain+=500;
        line='💎 豪氣大戶全賞你！+'+gain+'元';
      } else line=Wk.ev[0]+'，'+Wk.ev[1]+' +'+gain+'元';
      S.chips+=gain;Wk.gain+=gain;
      Wk.log.unshift(line);if(Wk.log.length>5)Wk.log.pop();
      addFloat(W/2+Math.sin(fr*0.035)*150,H-200,'+'+gain+'元','#ffd54f');
      Wk.done++;Wk.t=0;
      Wk.ev=WORK_EV[Math.floor(Math.random()*WORK_EV.length)];
      save();
      if(Wk.done>=Wk.n)workEnd(false);
    }
    function workEnd(quit){
      const back=quit?(Wk.n-Wk.done):0;
      if(back>0)S.stam=Math.min(10,S.stam+back);
      const total=Wk.gain, rounds=Wk.done;
      save();
      Wk=null;scene='world';
      api.showMsg(quit?'🏃 翹班！':'🌙 下班囉',
        '打了 '+rounds+' 輪工，進帳 +'+total+'元'
        +(back>0?'\n退還體力 '+back+'（'+S.stam+'/10）':'')
        +'\n💰 '+S.chips+'元　💪 '+S.stam+'/10',
        [{label:'🎰 繼續打工',fn:function(){api.hideMsg();openWork(null);}},
         {label:'🗺 回地圖',red:true,fn:function(){api.hideMsg();}}]);
    }
    function drawWork(){
      const bg=ctx.createLinearGradient(0,0,0,H);
      bg.addColorStop(0,'#221024');bg.addColorStop(1,'#090409');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      const lamp=ctx.createRadialGradient(W/2,90,10,W/2,90,300);
      lamp.addColorStop(0,'rgba(245,196,0,.12)');lamp.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=lamp;ctx.fillRect(0,0,W,H);
      ctx.font='26px sans-serif';ctx.textAlign='center';
      ctx.fillText('💡',W/2,80);
      // 三張賭桌＋客人微動
      const tabs=[[150,300],[W/2,340],[W-150,300]];
      const gL=['🤵','💃','🧔'], gR=['🤠','👲','🥸'];
      tabs.forEach(function(tp,i){
        ctx.fillStyle='#3a1420';
        ctx.beginPath();ctx.ellipse(tp[0],tp[1],86,40,0,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle='rgba(232,48,42,.5)';ctx.lineWidth=2;
        ctx.beginPath();ctx.ellipse(tp[0],tp[1],86,40,0,0,Math.PI*2);ctx.stroke();
        ctx.font='20px sans-serif';
        ctx.fillText(gL[i],tp[0]-40,tp[1]-26+Math.sin(fr*0.06+i*2)*3);
        ctx.fillText(gR[i],tp[0]+40,tp[1]-26+Math.sin(fr*0.08+i)*3);
        ctx.font='13px sans-serif';
        ctx.fillText('🃏',tp[0],tp[1]+4);
      });
      // 老闆娘監工
      ctx.font='30px sans-serif';
      ctx.fillText('👩‍🦰',W-60,120);
      ctx.fillStyle='#caa';ctx.font='10px -apple-system,sans-serif';
      ctx.fillText('老闆娘盯著你',W-60,140);
      // 打工貓：左右巡走＋顛步＋道具揮舞＋汗滴
      const cx=W/2+Math.sin(fr*0.035)*150;
      const cy=H-180-Math.abs(Math.sin(fr*0.18))*8;
      const flip=Math.cos(fr*0.035)<0;
      ctx.font='38px sans-serif';
      ctx.fillText('😺',cx,cy);
      ctx.save();
      ctx.translate(cx+(flip?-26:26),cy-12);
      ctx.rotate(Math.sin(fr*0.25)*0.5);
      ctx.font='20px sans-serif';
      ctx.fillText(Wk.ev[0].slice(0,2),0,0); // 事件首 emoji 當手上道具
      ctx.restore();
      if(fr%40<6){ctx.font='14px sans-serif';ctx.fillText('💦',cx+20,cy-34);}
      // 進度條
      const prog=Wk.t/ROUND_FR;
      ctx.fillStyle='#eee';ctx.font='bold 12px -apple-system,sans-serif';
      ctx.fillText('第 '+(Wk.done+1)+'/'+Wk.n+' 輪　'+Wk.ev[0],W/2,H-122);
      ctx.fillStyle='rgba(0,0,0,.55)';rr(W/2-150,H-112,300,16,8);ctx.fill();
      ctx.fillStyle='#f5c400';rr(W/2-148,H-110,296*Math.min(prog,1),12,6);ctx.fill();
      // 帳面
      ctx.fillStyle='#f5c400';ctx.font='bold 16px monospace';ctx.textAlign='center';
      ctx.fillText('本趟進帳 +'+Wk.gain+'元　💰'+S.chips,W/2,42);
      ctx.fillStyle='#999';ctx.font='11px sans-serif';
      ctx.fillText('💪 '+S.stam+'/10（已預扣）',W/2,62);
      // 事件 log（左上）
      ctx.textAlign='left';
      Wk.log.forEach(function(m,i){
        ctx.fillStyle='rgba(220,200,160,'+Math.max(0.85-i*0.16,0.2).toFixed(2)+')';
        ctx.font='10px -apple-system,sans-serif';
        ctx.fillText(m,16,90+i*15);
      });
      btn(W-96,H-50,80,32,'🏃 翹班',function(){workEnd(true);});
      drawFloats();
    }

    /* ══════════════ 主迴圈 / 點擊 ══════════════ */
    var LAND=false; // 橫向旋轉模式（host 視覺旋轉就緒後設 true，輸入跟著反轉）
    function resolvePoint(e){
      const r=canvas.getBoundingClientRect();
      const src=(e.touches&&e.touches[0])||(e.changedTouches&&e.changedTouches[0])||e;
      let mx=(src.clientX-r.left)*(W/r.width);
      let my=(src.clientY-r.top)*(H/r.height);
      if(LAND){ const t=mx; mx=H-my; my=t; } // 逆時針 90° 視覺旋轉對應的輸入反轉
      return {mx:mx,my:my};
    }
    function onClick(e){
      if(!alive)return;
      if(e.cancelable)e.preventDefault();
      const p=resolvePoint(e);
      for(let i=hot.length-1;i>=0;i--){
        const z=hot[i];
        if(p.mx>=z.x&&p.mx<=z.x+z.w&&p.my>=z.y&&p.my<=z.y+z.h){z.fn();return;}
      }
    }
    if(canvas.style)canvas.style.touchAction='manipulation'; // 去除雙擊縮放/延遲
    // pointerdown 涵蓋滑鼠+觸控，去掉手機 ~300ms click 延遲；不支援 pointer 的舊瀏覽器退回 click
    if(window.PointerEvent)canvas.addEventListener('pointerdown',onClick);
    else { canvas.addEventListener('touchstart',onClick,{passive:false}); canvas.addEventListener('click',onClick); }

    function loop(){
      if(!alive)return;
      fr++;
      hot=[];
      if(scene==='work'&&Wk){
        Wk.t++;
        if(Wk.t>=ROUND_FR)workPayout();
      }
      if(scene==='battle'&&B){
        if(B.phase==='deal'){
          B.dealT++;
          if(B.dealT>=110)bOnDealDone();
        } else if(B.phase==='play'){
          if(B.scryT>0)B.scryT--;
          // 戰吼封印：玩家剩 ≤2 張即碎裂（封到最後一張會整局當殭屍，體驗極差）
          if(B.sealedId&&B.hands[0].length<=2){
            B.sealedId=null;
            bLog('🗯 你殺氣騰騰，封印自行碎裂了！');
          }
          // 劇震
          if(B.quakeAt>0){
            B.quakeAt--;
            if(B.quakeAt<=0){
              B.quakeT=55;
              if(cardFx('quakeWard')>0){bLog('🛡 磐石之軀！劇震無傷');}
              else{bLog('🌋 大地劇震！你 -1HP');pDmg(1,'被震飛');if(B.php<=0){bSettleDeath();}}
            }
          }
          if(B.quakeT>0)B.quakeT--;
          // 瘟疫
          if(B.plagueAt>0){
            B.plagueAt--;
            if(B.plagueAt<=0){
              B.plague={t:600,tick:180};
              B.plagueImm=false;
              bLog('☣ 毒霧爆發！（10秒，每3秒-1HP，解毒藥可自保）');
            }
          }
          if(B.plague){
            B.plague.t--;B.plague.tick--;
            if(B.plague.tick<=0){
              B.plague.tick=180;
              if(!B.plagueImm&&cardFx('quakeWard')<=0){
                pDmg(1,'毒霧侵蝕');
                if(B.php<=0){bSettleDeath();}
              }
            }
            if(B.plague&&B.plague.t<=0){B.plague=null;bLog('🌬 毒霧散去');}
          }
          // 垃圾話 idle
          if(B&&B.bubble===null){
            B.idleT--;
            if(B.idleT<=0)taunt('idle');
          }
          // 鑽地暈眩：輪到玩家且可 Pass → 強制 Pass
          if(B&&B.cur===0&&B.stunArmed&&B.played!==null&&B.playedBy!==0){
            B.stunArmed=false;
            bLog('🪲 腳下塌陷！你暈了一輪被迫 Pass');
            bPass(0);B.sel=[];
          }
          // AI 行動
          if(B&&B.cur!==0&&!B.finished.includes(B.cur)){
            B.aiT--;
            if(B.aiT<=0){
              const p=B.cur;
              const mustC3=B.mustFirst&&B.hands[p].some(function(c){return c.r==='3'&&c.s==='♣';});
              // 封印：王被迫 Pass（自由出牌權無法 Pass → 封印落空）
              if(p===1&&B.sealCharge>0){
                if(B.played!==null&&B.playedBy!==1){
                  B.sealCharge=0;
                  bLog('🔒 封印發動！'+B.mon.name+' 被迫 Pass');
                  bPass(1);bAiTimer();
                  draw();api.raf(loop);return;
                } else if(B.played===null){
                  B.sealCharge=0;
                  bLog('🔒 封印被自由出牌權破解了…');
                }
              }
              // 鐵支眩暈：王被迫 Pass（自由出牌權無法 Pass → 眩暈散去）
              if(p===1&&B.stunBoss){
                B.stunBoss=false;
                if(B.played!==null&&B.playedBy!==1){
                  bLog('💫 鐵支威壓！'+B.mon.name+' 眩暈，被迫 Pass');
                  bPass(1);bAiTimer();
                  draw();api.raf(loop);return;
                } else bLog('💫 '+B.mon.name+' 甩了甩頭，眩暈散去');
              }
              const seen=new Set([...B.seen]);
              B.hands[p].forEach(function(c){seen.add(cardId(c));});
              let result=smartAiPlay({
                hand:B.hands[p],played:B.played,mustC3:mustC3,
                seen:seen,oppLens:bOppLens(p),
                keepTwoProb:p===1?0:0.45,
              });
              // 壓制：玩家進入殘局（剩牌≤5）→ 怪方以 sup 機率改出最大合法牌封鎖
              // ⚠ 不可用 playedBy===0 當觸發（玩家每手都被三家圍毆 → 永遠搶不到牌權，91局0勝實測）
              if(result&&B.hands[0].length<=5
                 &&Math.random()<Math.min(0.97,(B.mon.sup||0.6)+(B.enraged?0.1:0))){
                const combos=legalCombos(B.hands[p],B.played,mustC3);
                const pool=B.hands[0].length<=4?combos
                  :combos.filter(function(c){
                      return c.cl.type!=='fourOfAKind'&&c.cl.type!=='straightFlush';});
                if(pool.length)result=pool[pool.length-1];
              }
              if(result)bPlay(p,result.cards);
              else bPass(p);
              if(B&&B.phase==='play')bAiTimer();
            }
          }
        }
      }
      draw();
      api.raf(loop);
    }
    /* 事件致死（劇震/毒霧把玩家打到 0）走正式敗北 */
    function bSettleDeath(){
      if(!B)return;
      if(B.cardRevive>0){
        B.cardRevive--;B.php=1;api.setHp(1);
        bLog('⚰ 冥王庇佑！你以 1HP 撐住（剩 '+B.cardRevive+' 次）');
        return;
      }
      if(sk('phoenix')&&!B.phUsed&&Math.random()<0.3){
        B.phUsed=true;B.php=1;api.setHp(1);
        bLog('🪽 不死鳥之力！你以 1HP 浴火重生');
        return;
      }
      defeat(['你倒在了魔王的天災之下…']);
    }
    function draw(){
      if(scene==='world')drawWorld();
      else if(scene==='battle'&&B)drawBattle();
      else if(scene==='work'&&Wk)drawWork();
      else if(scene==='bag')drawBag();
      else if(scene==='stash')drawStash();
      else if(scene==='tree')drawTree();
      else drawWorld();
    }

    function destroy(){
      alive=false;
      canvas.removeEventListener('pointerdown',onClick);
      canvas.removeEventListener('touchstart',onClick);
      canvas.removeEventListener('click',onClick);
    }
    api.setScore(S.chips);
    api.setHp(maxHp());
    api.raf(loop);
    return destroy;
  }
})();
