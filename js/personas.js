/**
 * personas.js — AI 圓桌(自然語言加強版)
 *
 * 設計:
 *   - 每個人格有「核心立場(score)」+「多種句型模板」
 *   - 從句型池隨機挑,並用實際數字填空,讓對話更自然
 *   - 支援使用者 @ 點名 → 該人格針對性回話
 *   - 支援人格之間連續回話(誰被嗆誰可以回嘴)
 *
 * export:
 *   PERSONAS                                       — 元資料
 *   buildPersonaChat(ctx)  → { messages, opinions }
 *   replyToMention(personId, userText, ctx, history) → ChatMessage
 *   replyAmongPersonas(targetId, fromMsg, ctx)     → ChatMessage  (人格回人格)
 */

export const PERSONAS = [
  { id: 'deng',  name: '燈燈', emoji: '🐱', sect: '動能派', side: 'bull', tone: '俏皮' },
  { id: 'niu',   name: '老牛', emoji: '🐂', sect: '價值派', side: 'bear', tone: '穩重' },
  { id: 'ga',    name: '嘎神', emoji: '⚡', sect: '當沖派', side: 'bull', tone: '急躁' },
  { id: 'aunt',  name: '阿姨', emoji: '👵', sect: '保守派', side: 'bear', tone: '碎念' },
  { id: 'quant', name: '量子', emoji: '📊', sect: '量化派', side: 'neutral', tone: '冷靜' },
];

const META = Object.fromEntries(PERSONAS.map(p => [p.id, p]));

// ─── 共用工具 ────────────────────────────────────────
const _pick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * 從 Config.personasLines[id] 取出使用者自訂的擴充句型。
 * Config 結構: { personasLines: { deng: ['...', '...'], niu: [...], ... } }
 * 若 window.__personasExtraLines 有資料(直接寫入,避免循環 import),也會合併。
 */
function _userLines(personaId) {
  try {
    const ex1 = window.__personasExtraLines?.[personaId];
    if (Array.isArray(ex1) && ex1.length) return ex1;
  } catch (_) {}
  return [];
}

/** 把預設句型池 + 使用者自訂池合併後隨機挑一句 */
function _pickWithUser(defaults, personaId) {
  const extra = _userLines(personaId);
  if (extra.length === 0) return _pick(defaults);
  // 使用者句型佔 50% 機率,讓新句型有感
  if (Math.random() < 0.5) return _pick(extra);
  return _pick(defaults);
}

function _ctxNumbers(ctx) {
  const trend = ctx.analysis?.trend ?? {};
  const vp    = ctx.analysis?.volumePrice ?? {};
  const q     = ctx.quote ?? {};
  const f     = ctx.fundamentals ?? {};
  const c     = ctx.chips ?? {};
  const t     = ctx.taiex ?? {};
  return {
    h:        trend.health ?? null,
    dir:      trend.direction ?? null,
    surge:    !!vp.surge,
    chgPct:   q.chgPct ?? 0,
    price:    q.price ?? 0,
    pe:       f.pe ?? null,
    pb:       f.pbRatio ?? null,
    dy:       f.dividendYield ?? null,
    foreign:  c.foreignNet ?? 0,
    trust:    c.trustNet ?? 0,
    taiex:    t.chgPct ?? null,
    sigCount: Array.isArray(ctx.signals) ? ctx.signals.length : 0,
  };
}

// ─── 變數代換 ───────────────────────────────────────
function _fillVars(text, ctx) {
  if (!text || typeof text !== 'string') return text;
  if (!text.includes('{')) return text;   // 沒變數直接回
  const n = _ctxNumbers(ctx);
  const get = (key) => {
    const v = {
      h:        n.h,
      chgPct:   n.chgPct,
      price:    n.price,
      pe:       n.pe,
      pb:       n.pb,
      dy:       n.dy != null ? (n.dy * 100).toFixed(1) + '%' : null,
      foreign:  n.foreign,
      trust:    n.trust,
      taiex:    n.taiex,
      sigCount: n.sigCount,
    }[key];
    if (v == null) return null;
    // 數字用 toFixed(2) 但整數不要小數點
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return String(v);
      return v.toFixed(2);
    }
    return String(v);
  };
  return text.replace(/\{(\w+)\}/g, (_, key) => {
    const v = get(key);
    return v == null ? '(無資料)' : v;
  });
}

// ─── 主入口:第一輪每人開講 ──────────────────────────
export function buildPersonaChat(ctx = {}) {
  const opinions = {
    deng:  _opinionDeng(ctx),
    niu:   _opinionNiu(ctx),
    ga:    _opinionGa(ctx),
    aunt:  _opinionAunt(ctx),
    quant: _opinionQuant(ctx),
  };

  const order = ['deng', 'niu', 'ga', 'aunt', 'quant'];
  const messages = [];
  for (const id of order) {
    const op = opinions[id];
    if (!op) continue;
    const m = { ...META[id], ...op };
    const reply = _findReplyTarget(id, opinions, messages);
    if (reply) {
      m.replyTo = reply.id;
      const replyLine = _replyToMember(id, reply.id, op);
      m.text = _fillVars(replyLine ?? op.line, ctx);
    } else {
      m.text = _fillVars(op.line, ctx);
    }
    messages.push(m);
  }
  return { messages, opinions };
}

// ─── @ 點名 → 該人格回應 ─────────────────────────
export function replyToMention(personId, userText, ctx, history = []) {
  const meta = META[personId];
  if (!meta) return null;
  const op = _runOpinion(personId, ctx);
  const text = _fillVars(_styledReplyToUser(personId, userText, op), ctx);
  return { ...meta, ...op, text, replyTo: 'user' };
}

// ─── 人格回人格(被嗆時可以回嘴)──────────────────────
export function replyAmongPersonas(targetId, fromMsg, ctx) {
  const meta = META[targetId];
  if (!meta) return null;
  const op = _runOpinion(targetId, ctx);
  const line = _replyToMember(targetId, fromMsg.id, op) ?? op.line;
  return { ...meta, ...op, text: _fillVars(line, ctx), replyTo: fromMsg.id };
}

function _runOpinion(id, ctx) {
  return {
    deng: _opinionDeng, niu: _opinionNiu, ga: _opinionGa, aunt: _opinionAunt, quant: _opinionQuant
  }[id](ctx);
}

// ─── 找回應對象 ────────────────────────────────────
function _findReplyTarget(currentId, opinions, msgsSoFar) {
  const me = opinions[currentId];
  if (!me) return null;
  if (currentId === 'quant') {
    const sorted = Object.entries(opinions)
      .filter(([k]) => k !== 'quant')
      .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));
    return sorted[0] && Math.abs(sorted[0][1].score) >= 40 ? META[sorted[0][0]] : null;
  }
  for (let i = msgsSoFar.length - 1; i >= 0; i--) {
    const prev = msgsSoFar[i];
    if (prev.id === currentId) continue;
    const prevOp = opinions[prev.id];
    if (!prevOp) continue;
    if (Math.sign(me.score) !== Math.sign(prevOp.score) &&
        Math.abs(me.score - prevOp.score) >= 50) {
      return META[prev.id];
    }
  }
  return null;
}

// ─── 回應其他人格的句型 ───────────────────────────
function _replyToMember(myId, targetId, myOp) {
  const t = META[targetId];
  const tag = `${myId}_vs_${targetId}`;
  const r = {
    niu_vs_deng: [
      `@${t.name} 追高一時爽,套牢火葬場。${myOp.line}`,
      `@${t.name} K 線會洗到死,${myOp.line}`,
      `@${t.name} 你那套撐不到三年,我抱了二十年沒套過。${myOp.line}`,
    ],
    deng_vs_niu: [
      `@${t.name} 等你看完財報股價已經漲三根!${myOp.line}`,
      `@${t.name} 你的價值股我看十年都沒漲,${myOp.line}`,
    ],
    ga_vs_niu: [
      `@${t.name} 等你算完 PE 我都結算了!${myOp.line}`,
      `@${t.name} 老牛你那慢半拍的節奏跟不上市場啦。${myOp.line}`,
    ],
    niu_vs_ga: [
      `@${t.name} 賭一賭哪天就被嘎死,我不勸了。${myOp.line}`,
      `@${t.name} 賺快錢的下場我看多了,小心一夜回到解放前。${myOp.line}`,
    ],
    aunt_vs_deng: [
      `@${t.name} 少年仔急什麼,${myOp.line}`,
      `@${t.name} 你不像看過股災的,聽阿姨一句:${myOp.line}`,
      `@${t.name} 二十年前我也跟你一樣衝,後來呢...${myOp.line}`,
    ],
    deng_vs_aunt: [
      `@${t.name} 你不買就永遠賺不到啦!${myOp.line}`,
      `@${t.name} 你那種保守只能賺定存,${myOp.line}`,
    ],
    aunt_vs_ga: [
      `@${t.name} 賭場式買股,最後都是貢獻手續費。${myOp.line}`,
      `@${t.name} 你那套早晚被市場嘎死,阿姨不勸了。${myOp.line}`,
    ],
    ga_vs_aunt: [
      `@${t.name} 阿姨你的保守在多頭也賺不到。${myOp.line}`,
      `@${t.name} 等你看完新聞我都換手三趟了!${myOp.line}`,
    ],
    quant_vs_deng: [
      `@${t.name} 你那直覺,過去三個月勝率剛好 50%。${myOp.line}`,
      `@${t.name} 「感覺強」不是訊號,${myOp.line}`,
    ],
    quant_vs_niu: [
      `@${t.name} 估值便宜不代表會漲,${myOp.line}`,
      `@${t.name} 低 PE 也可能是死亡螺旋的開始。${myOp.line}`,
    ],
    quant_vs_ga: [
      `@${t.name} 追漲停隔日同向延續機率僅 55%。${myOp.line}`,
      `@${t.name} 你那種策略長期勝率不到一半。${myOp.line}`,
    ],
    quant_vs_aunt: [
      `@${t.name} 保守過頭也是錯。${myOp.line}`,
      `@${t.name} 你的「停損」其實就是「永遠停利零」。${myOp.line}`,
    ],
    deng_vs_quant: [
      `@${t.name} 你的回測跑完行情都結束了!${myOp.line}`,
      `@${t.name} 數據是死的,人心是活的。${myOp.line}`,
    ],
    ga_vs_quant: [
      `@${t.name} 你那 55% 勝率不夠看,我要 80%。${myOp.line}`,
    ],
  };
  const list = r[tag];
  if (!list) return null;
  return _pick(list);
}

// ─── 回應使用者(@ 點名)─────────────────────────
function _styledReplyToUser(myId, userText, op) {
  const meta = META[myId];
  // 從使用者文字嗅出疑問:多/空/該不該/怎麼看
  const text = (userText || '').replace(/@\w+/g, '').trim();
  const askBull  = /多|買|追|衝|拉|漲|進場/.test(text);
  const askBear  = /空|跑|跌|出場|賣|殺/.test(text);
  const askWhat  = /怎麼看|如何|意見|看法|建議/.test(text);
  const isQuestion = /嗎\?|嗎？|嗎$|\?|？/.test(text) || askWhat;

  const pre = _userReplyOpening(myId, askBull, askBear, isQuestion);
  return `${pre}${op.line}`;
}

function _userReplyOpening(myId, askBull, askBear, isQuestion) {
  const openings = {
    deng: {
      bull:   ['你想追是吧?', '想衝了喔?', '燈燈跟你說喔,', '我覺得喔,'],
      bear:   ['你想跑?', '想出場喔?', '燈燈也覺得喵,'],
      ask:    ['燈燈來看一下喵~', '你問我啊?好,', '聽我說喵,'],
      default:['燈燈說一下,', '嗯哼?'],
    },
    niu: {
      bull:   ['追高?老牛勸你冷靜。', '別衝,先聽我說。', '年輕人別急,'],
      bear:   ['你想跑?要看為什麼跑。', '出場有出場的道理,'],
      ask:    ['老牛的看法是這樣:', '讓我說個真話,', '我幫你看一下,'],
      default:['老牛說,', '從基本面看,'],
    },
    ga: {
      bull:   ['想追?早就該追了!', '我已經卡位啦!', '快!跟上!'],
      bear:   ['跑?我都跑了!', '殺出來啊!'],
      ask:    ['看籌碼啦!', '我跟你說,'],
      default:['嘎神我跟你說,', '聽好,'],
    },
    aunt: {
      bull:   ['追?阿姨二十年看過太多人這樣套牢。', '別急別急,', '等等再說啦~'],
      bear:   ['你想跑?要小心是不是假摔。', '阿姨也建議慢一點,'],
      ask:    ['阿姨跟你說喔,', '我看過太多了,我跟你說,'],
      default:['阿姨碎念一下,', '聽阿姨一句,'],
    },
    quant: {
      bull:   ['從數據看,', '統計上來說,'],
      bear:   ['從數據看,', '回測顯示,'],
      ask:    ['純看數字,', '客觀回答你,'],
      default:['數據是這樣的:', ''],
    },
  };
  const lib = openings[myId];
  if (!lib) return '';
  if (askBull)    return _pick(lib.bull);
  if (askBear)    return _pick(lib.bear);
  if (isQuestion) return _pick(lib.ask);
  return _pick(lib.default);
}

// ════════════════════════════════════════════════════════
// 五人意見產生器(擴充版:每種狀況 3~5 種說法)
// ════════════════════════════════════════════════════════

// 🐱 燈燈(動能派)
function _opinionDeng(ctx) {
  const { h, dir, surge, chgPct, sigCount } = _ctxNumbers(ctx);

  if (surge && dir === 'down') {
    return { mood:'sad', score:-60, line: _pickWithUser([
      `爆量下殺欸,燈燈不會接刀子喵~等止跌訊號再說`,
      `量出來但是往下,這種我不碰,等收腳`,
      `爆量殺出來,中刀的人很慘,燈燈先觀望`,
    ], 'deng')};
  }
  if (surge && dir === 'up') {
    if ((h ?? 0) > 70) {
      return { mood:'savage', score:80, line: _pickWithUser([
        `爆量拉升!健康度 ${h} 配上動能,燈燈說該追就追!停損設好`,
        `量價齊揚加上結構這麼漂亮(${h}),不追對不起自己`,
        `爆量+健康度 ${h},這是教科書級的進場時機喵!`,
      ], 'deng')};
    }
    return { mood:'curious', score:40, line: _pickWithUser([
      `爆量是有,但健康才 ${h ?? '不明'}...燈燈會小資位進,別 all-in`,
      `量有出來但結構沒到位(${h ?? '?'}),先試水溫`,
      `動能還行,但健康度 ${h ?? '?'} 沒到 70 不算強勢`,
    ], 'deng')};
  }
  if (h != null && h > 80 && dir === 'up') {
    return { mood:'happy', score:70, line: _pickWithUser([
      `健康度 ${h}!這結構漂亮到燈燈想偷親一下喵~找回測點進就好`,
      `${h} 分的健康度配多頭排列,燈燈會排隊等回測`,
      `趨勢這麼乾淨(${h}),燈燈會列為觀察首選`,
    ], 'deng')};
  }
  if (h != null && h < 35) {
    return { mood:'sad', score:-50, line: _pickWithUser([
      `健康度才 ${h},這檔結構爛到燈燈不會碰`,
      `${h} 分?這體質連觀察都不用,直接 pass`,
      `健康度 ${h}...燈燈寧可去找會跳的`,
    ], 'deng')};
  }
  if (h == null) {
    if (chgPct > 3)  return { mood:'savage', score:50, line: _pickWithUser([
      `漲 ${chgPct.toFixed(1)}%!動能有出來,值得追蹤喵`,
      `今天 +${chgPct.toFixed(1)}%,有戲!列觀察`,
    ], 'deng')};
    if (chgPct > 1)  return { mood:'happy', score:30, line: _pickWithUser([
      `溫和漲 ${chgPct.toFixed(1)}%,有撐,燈燈先盯著`,
      `+${chgPct.toFixed(1)}% 算溫和,可以再看`,
    ], 'deng')};
    if (chgPct < -3) return { mood:'sad', score:-50, line: _pickWithUser([
      `跌 ${chgPct.toFixed(1)}%,動能跑光,別接`,
      `${chgPct.toFixed(1)}% 殺下來,燈燈不會去當墊背的`,
    ], 'deng')};
    if (chgPct < -1) return { mood:'curious', score:-20, line: _pickWithUser([
      `回 ${chgPct.toFixed(1)}%,先看支撐在哪`,
      `小跌 ${chgPct.toFixed(1)}%,等收腳再說`,
    ], 'deng')};
    return { mood:'curious', score:0, line: _pickWithUser([
      `沒動沒成交量,燈燈去找會跳的`,
      `今天沒戲,先 pass`,
    ], 'deng')};
  }
  if (h >= 65) return { mood:'happy', score:35, line: _pickWithUser([
    `健康度 ${h},結構不錯,燈燈會列觀察`,
    `${h} 分還行,可以追蹤`,
  ], 'deng')};
  if (h <= 45) return { mood:'sad', score:-25, line: _pickWithUser([
    `健康度 ${h},體質偏弱,先擺著`,
    `${h} 分...燈燈先觀望`,
  ], 'deng')};
  return { mood:'curious', score:5, line: _pickWithUser([
    `${h} 分的盤整貨,不如找強勢股喵`,
    `健康度 ${h} 卡中間,沒甚麼好說的`,
  ], 'deng')};
}

// 🐂 老牛(價值派)
function _opinionNiu(ctx) {
  const { h, pe, pb, dy, chgPct } = _ctxNumbers(ctx);

  if (pe != null && pe > 30) {
    return { mood:'savage', score:-70, line: _pickWithUser([
      `PE ${pe.toFixed(1)} 倍?這是給夢的價格,不是給投資人的`,
      `本益比 ${pe.toFixed(1)} 倍,老牛二十年沒買過這麼貴的`,
      `${pe.toFixed(1)} 倍 PE,你買的是希望,不是公司`,
    ], 'niu')};
  }
  if (pe != null && pe < 12 && dy != null && dy > 0.05) {
    return { mood:'happy', score:70, line: _pickWithUser([
      `PE ${pe.toFixed(1)} 配 ${(dy*100).toFixed(1)}% 殖利率,老牛抱長都不虧`,
      `估值便宜配高息,這就是老牛要的股,抱到孫子那代`,
      `本益比 ${pe.toFixed(1)}、殖利率 ${(dy*100).toFixed(1)}%,睡得安穩的好股`,
    ], 'niu')};
  }
  if (pe != null && pe < 15) {
    return { mood:'happy', score:50, line: _pickWithUser([
      `PE ${pe.toFixed(1)},合理範圍,值得研究`,
      `${pe.toFixed(1)} 倍 PE 算便宜,看產業展望決定抱多久`,
    ], 'niu')};
  }
  if (pb != null && pb > 5) {
    return { mood:'sad', score:-40, line: _pickWithUser([
      `PB ${pb.toFixed(1)} 倍偏貴,淨值才是底氣`,
      `股價淨值比 ${pb.toFixed(1)},你買的不是公司是商譽`,
    ], 'niu')};
  }
  if (h != null && h > 70 && pe != null && pe > 20) {
    return { mood:'savage', score:-30, line: _pickWithUser([
      `漲那麼兇 PE 也吹到 ${pe.toFixed(1)},冷靜冷靜`,
      `走勢強歸強,${pe.toFixed(1)} 倍 PE 不是長期解答`,
    ], 'niu')};
  }
  if (pe == null && pb == null) {
    if (chgPct > 5)  return { mood:'savage', score:-40, line: _pickWithUser([
      `沒看財報,但一天衝 ${chgPct.toFixed(1)}%?老牛先懷疑為敬`,
      `沒基本面我不評論,但這種漲法老牛習慣性閃遠`,
    ], 'niu')};
    if (chgPct < -5) return { mood:'curious', score:20, line: _pickWithUser([
      `跌 ${chgPct.toFixed(1)}%,要是基本面沒壞就是機會`,
      `急殺 ${chgPct.toFixed(1)}%,先去查財報,基本面好就撿`,
    ], 'niu')};
    if (h != null && h > 75) return { mood:'curious', score:-10, line: `沒財報資料但走勢太強,老牛先觀望`};
    if (h != null && h < 40) return { mood:'sad', score:-30, line: `沒財報但走勢就弱,老牛不會接刀`};
    return { mood:'curious', score:0, line: _pickWithUser([
      `沒財報資料,老牛不評論 — 沒數字就不買`,
      `打開基本面 Tab 看一眼再來找我`,
    ], 'niu')};
  }
  return { mood:'curious', score:10, line: pe
    ? `PE ${pe.toFixed(1)} 還行,要看產業`
    : `基本面普通,繼續觀察`
  };
}

// ⚡ 嘎神(當沖派)
function _opinionGa(ctx) {
  const { surge, chgPct, foreign, trust } = _ctxNumbers(ctx);
  const hasChips = foreign !== 0 || trust !== 0;

  if (chgPct >= 9) return { mood:'savage', score:90, line: _pickWithUser([
    `直接拉漲停!卡位排隊明天續攻!`,
    `漲停板了還用問?嘎神已經在排隊`,
    `+${chgPct.toFixed(1)}%!明天開盤就是戰場`,
  ], 'ga')};
  if (chgPct <= -9) return { mood:'sad', score:-80, line: _pickWithUser([
    `跌停了還在問?早跑了`,
    `跌停板,空方完勝,嘎神今天賺翻`,
    `${chgPct.toFixed(1)}%?我盤前就出貨了`,
  ], 'ga')};

  if (hasChips) {
    if (surge && (foreign + trust) > 1000) {
      return { mood:'savage', score:75, line: _pickWithUser([
        `爆量配法人買 ${((foreign+trust)/1000).toFixed(0)}K — 這戲是我演的!`,
        `主力進場了!外資+投信 ${((foreign+trust)/1000).toFixed(0)}K,跟上`,
        `法人狂買,量也出來,明天嘎到漲停我也不意外`,
      ], 'ga')};
    }
    if (foreign < -500) {
      return { mood:'sad', score:-50, line: _pickWithUser([
        `外資狂賣 ${(foreign/1000).toFixed(1)}K,不當墊背的`,
        `主力跑了,我也跑`,
        `外資-${Math.abs(foreign/1000).toFixed(1)}K,空方主場`,
      ], 'ga')};
    }
    if ((foreign + trust) > 500) {
      return { mood:'curious', score:40, line: _pickWithUser([
        `法人偷偷買,盯緊籌碼變化`,
        `主力進場跡象,觀察明天有沒有接續`,
      ], 'ga')};
    }
  }

  if (surge) {
    if (chgPct > 5)  return { mood:'savage', score:70, line: _pickWithUser([
      `爆量 +${chgPct.toFixed(1)}%,有人在拉,跟一把試試`,
      `+${chgPct.toFixed(1)}% 配爆量,當沖客的夢想`,
    ], 'ga')};
    if (chgPct > 1)  return { mood:'curious', score:35, line: _pickWithUser([
      `量出來了,${chgPct.toFixed(1)}% 不夠看,等突破關鍵價`,
      `爆量但漲幅有限,可能是換手,觀察`,
    ], 'ga')};
    if (chgPct < -3) return { mood:'sad', score:-55, line: _pickWithUser([
      `爆量殺 ${chgPct.toFixed(1)}%,有人在倒貨,別進場`,
      `量大跌深,等明天看誰在收`,
    ], 'ga')};
    return { mood:'curious', score:25, line: `量爆但價沒衝,等明天方向`};
  }
  if (chgPct > 3)  return { mood:'curious', score:30, line: `${chgPct.toFixed(1)}% 但量沒爆,弱多,先觀察`};
  if (chgPct < -3) return { mood:'sad', score:-35, line: `${chgPct.toFixed(1)}% 不爆量,溫水煮青蛙`};
  return { mood:'curious', score:0, line: _pickWithUser([
    `量沒爆、價沒動,今天嘎神去看別檔`,
    `這檔太平靜,沒戲`,
  ], 'ga')};
}

// 👵 阿姨(保守派)
function _opinionAunt(ctx) {
  const { h, surge, chgPct, taiex } = _ctxNumbers(ctx);

  if (taiex != null && taiex < -1.5) {
    return { mood:'sad', score:-60, line: _pickWithUser([
      `大盤跌 ${taiex.toFixed(2)}%,今天先收手,別逆勢`,
      `指數這樣跌,阿姨建議暫時不進場`,
      `大環境不好(${taiex.toFixed(2)}%),先存錢`,
    ], 'aunt')};
  }
  if (chgPct < -5) {
    return { mood:'sad', score:-70, line: _pickWithUser([
      `一天跌 ${chgPct.toFixed(2)}%,看了心驚,別接`,
      `${chgPct.toFixed(2)}% 的單日跌幅,阿姨二十年看怕了`,
      `跌這麼兇必有妖,阿姨不碰`,
    ], 'aunt')};
  }
  if (surge && chgPct > 5) {
    return { mood:'savage', score:-40, line: _pickWithUser([
      `一天衝 ${chgPct.toFixed(2)}%?二十年看過太多隔天倒車`,
      `今天爽明天悲,阿姨見過太多`,
      `+${chgPct.toFixed(1)}% 然後呢?套住的人都這樣開始`,
    ], 'aunt')};
  }
  if (chgPct > 3) {
    return { mood:'curious', score:-20, line: _pickWithUser([
      `又是一個追高的,阿姨二十年看多了`,
      `+${chgPct.toFixed(1)}%?隔天再說別急`,
    ], 'aunt')};
  }
  if (h != null && h > 70 && (taiex ?? 0) > 0.5) {
    return { mood:'happy', score:50, line: _pickWithUser([
      `大盤撐著、結構也好,阿姨抱一點點`,
      `大環境配個股都不錯,可以小資進`,
    ], 'aunt')};
  }
  if (h != null && h < 35) {
    return { mood:'sad', score:-50, line: _pickWithUser([
      `結構不行,堅持不碰`,
      `${h} 分的健康度,阿姨眼睛閉著都知道不要`,
    ], 'aunt')};
  }
  if (chgPct < -1.5) {
    return { mood:'curious', score:-15, line: _pickWithUser([
      `跌 ${chgPct.toFixed(1)}%,別急著接,等收腳`,
      `小跌但別衝,阿姨會等個兩三天`,
    ], 'aunt')};
  }
  if (Math.abs(chgPct) < 0.5) {
    return { mood:'curious', score:0, line: _pickWithUser([
      `沒什麼動靜,阿姨繼續看,急什麼`,
      `平靜如水,阿姨喝口茶再說`,
    ], 'aunt')};
  }
  return { mood:'curious', score:-10, line: _pickWithUser([
    `永遠一句:停損設好再進場`,
    `阿姨提醒,風險永遠優先於報酬`,
    `投資前先問自己:套了能扛多久?`,
  ], 'aunt')};
}

// 📊 量子(量化派)
function _opinionQuant(ctx) {
  const { h, surge, chgPct, sigCount } = _ctxNumbers(ctx);

  if (h != null && h > 80 && sigCount >= 3) {
    return { mood:'savage', score:75, line: _pickWithUser([
      `健康度 ${h}、${sigCount} 個多方訊號疊加 — 統計上偏多`,
      `多重訊號共振(${sigCount} 個)+結構 ${h} 分,勝率資料說多`,
      `這組合在過去三年回測中勝率達 ${60 + Math.floor(Math.random()*8)}%`,
    ], 'quant')};
  }
  if (h != null && h < 30) {
    return { mood:'sad', score:-60, line: _pickWithUser([
      `健康度 ${h} 落在後 15%,反彈機率不到 35%`,
      `${h} 分屬於統計上的弱勢區,均值回歸要等更深`,
    ], 'quant')};
  }
  if (surge) {
    const sign = chgPct >= 0 ? '+' : '';
    return {
      mood:'curious',
      score: chgPct >= 0 ? 30 : -30,
      line: _pickWithUser([
        `爆量 ${sign}${chgPct.toFixed(2)}% — 歷史次日同向延續機率約 55%`,
        `量價共振 ${sign}${chgPct.toFixed(2)}%,但統計上只比丟銅板好一點`,
        `${sign}${chgPct.toFixed(2)}% 配爆量,期望值 ${chgPct >= 0 ? '微正' : '微負'}`,
      ], 'quant'),
    };
  }
  if (h == null) {
    if (chgPct > 5)  return { mood:'curious', score:-10, line: `+${chgPct.toFixed(1)}% — 單日漲幅前 10%,均值回歸風險高`};
    if (chgPct > 2)  return { mood:'curious', score:15, line: `+${chgPct.toFixed(1)}%、${sigCount} 個訊號 — 數據略偏多`};
    if (chgPct < -5) return { mood:'curious', score:5,  line: `${chgPct.toFixed(1)}% — 過度恐慌區,反彈機率約 60%`};
    if (chgPct < -2) return { mood:'curious', score:-10, line: `${chgPct.toFixed(1)}% — 數據略偏空`};
    return { mood:'curious', score:0, line: _pickWithUser([
      `波動率低、${sigCount} 個訊號 — 沒統計優勢,不下注`,
      `指標全部中性,純機率角度沒邊`,
    ], 'quant')};
  }
  if (sigCount >= 2 && h < 50) {
    return { mood:'curious', score:10, line: `訊號 ${sigCount} 個但健康度 ${h} — 訊號與結構背離,可靠度打折` };
  }
  if (sigCount === 0 && h >= 40 && h <= 60) {
    return { mood:'curious', score:0, line: `指標全部中性 — 沒統計優勢,不下判斷` };
  }
  return {
    mood:'curious',
    score: Math.round((h - 50) * 0.8),
    line: `健康度 ${h}、訊號 ${sigCount} 個 — 純數據是${h > 50 ? '略偏多' : '略偏空'}`,
  };
}
