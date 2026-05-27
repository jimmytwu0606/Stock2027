// js/deng-messages.js
// ============================================================================
// 燈燈台詞庫
// ============================================================================
// 結構: { 場景: [{ text, tone }, ...] }
// tone: 'cute'(可愛,預設)| 'savage'(毒舌)
//
// 共 60+ 句,可愛 ~70%,毒舌 ~30%
// 想擴充隨時加 entries
// ============================================================================

export const DENG_MESSAGES = {

  // ── 載入分析中 ─────────────────────────────────────────────
  loading: [
    { text: '燈燈導讀中,請稍後 ~ 喵',           tone: 'cute' },
    { text: '正在認真看 K 線 ~',                tone: 'cute' },
    { text: '等等喔,燈燈在思考 ~',              tone: 'cute' },
    { text: '找關鍵價位中...',                   tone: 'cute' },
    { text: '整理思路喵 ~',                      tone: 'cute' },
    { text: '在算這檔的支撐壓力呢...',           tone: 'cute' },
    { text: '等等,讓燈燈想清楚再講給你聽',     tone: 'cute' },
    { text: '燈燈在很努力地想了,你別催',       tone: 'savage' },
    { text: '這檔讓燈燈想一下...有點難看',     tone: 'savage' },
    { text: 'ㄜ...先讓燈燈確認一下這檔還活著', tone: 'savage' },
  ],

  // ── 分析中(算演算法時換句) ────────────────────────────
  analyzing: [
    { text: '在找這檔的關鍵價位 ~',              tone: 'cute' },
    { text: '看看大家在哪邊買賣...喵',           tone: 'cute' },
    { text: '判斷主升段還是回檔中...',           tone: 'cute' },
    { text: '正在比對歷史 K 棒 ~',               tone: 'cute' },
    { text: '量價背離?燈燈在確認 ~',           tone: 'cute' },
    { text: '思考中,順便提醒你電量剩 20%',     tone: 'savage' },
    { text: '燈燈在挑你最該注意的部分',          tone: 'cute' },
  ],

  // ── 完成解讀 ───────────────────────────────────────────────
  complete: [
    { text: '分析好囉 ~ 看看右邊喵',              tone: 'cute' },
    { text: '燈燈幫你畫好線了 ~',                tone: 'cute' },
    { text: '重點都標出來了喵 ~',                tone: 'cute' },
    { text: '來看燈燈的分析 ~',                  tone: 'cute' },
    { text: '看完記得自己想清楚再下單,燈燈不負責喔', tone: 'savage' },
    { text: '燈燈分析完了,虧錢別怪我喵',       tone: 'savage' },
    { text: '你看完還是不懂的話...那燈燈也救不了', tone: 'savage' },
    { text: '拿去吧,別再來問燈燈了',             tone: 'savage' },
  ],

  // ── 個股看起來不錯 ────────────────────────────────────────
  stockGood: [
    { text: '這檔有點意思喔 ~',                  tone: 'cute' },
    { text: '燈燈覺得結構不錯,但別重押',        tone: 'cute' },
    { text: '值得追蹤一下喵 ~',                  tone: 'cute' },
    { text: '看起來不會太差',                    tone: 'cute' },
    { text: '長短線一致看多,燈燈也覺得不錯 ~',  tone: 'cute' },
    { text: '結構算好,可以放關注名單',           tone: 'cute' },
  ],

  // ── 個股看起來不妙 ────────────────────────────────────────
  stockBad: [
    { text: 'ㄜ...這檔燈燈勸你三思',             tone: 'savage' },
    { text: '結構不太行,燈燈會繞道走',           tone: 'savage' },
    { text: '想知道為什麼跌嗎?燈燈早就跟你說了', tone: 'savage' },
    { text: '現在問是不是太晚了?',               tone: 'savage' },
    { text: '這檔...你確定?',                    tone: 'savage' },
    { text: '燈燈幫你看過了,建議放生',           tone: 'savage' },
    { text: '多週期都偏空,燈燈勸你迴避',         tone: 'savage' },
  ],

  // ── 短長分歧 ───────────────────────────────────────────────
  divergence: [
    { text: '長線結構好,但短線過熱,等回測再說', tone: 'cute' },
    { text: '短線反彈但長線還在空頭,別當救世主', tone: 'savage' },
    { text: '燈燈也很難說,等方向出來再決定',     tone: 'cute' },
    { text: '長短不一致,燈燈建議先觀察',         tone: 'cute' },
    { text: '多週期看法分歧,部位要輕,停損要嚴', tone: 'cute' },
    { text: '盤整多週期,適合箱型操作,別追進',   tone: 'cute' },
    { text: '看不出共振的話,就是還沒到進場時機', tone: 'savage' },
    { text: '長短分歧的時候,燈燈通常會選擇等',   tone: 'cute' },
  ],

  // ── 錯誤 ───────────────────────────────────────────────────
  error: [
    { text: '喵?剛剛卡到了,再試一次?',          tone: 'cute' },
    { text: '燈燈這邊網路怪怪的...',              tone: 'cute' },
    { text: '資料不太對,你重新整理看看',         tone: 'cute' },
    { text: '出錯了,但別怪燈燈喔',               tone: 'savage' },
  ],

  // ── 資料不足 ───────────────────────────────────────────────
  noData: [
    { text: '這檔 K 線太少,燈燈看不出來喵',      tone: 'cute' },
    { text: '等多累積幾天再來問燈燈吧 ~',        tone: 'cute' },
    { text: '資料不夠,燈燈也是要素材的',          tone: 'savage' },
  ],

  // ── 喚醒(從背景回來) ───────────────────────────────────
  wakeUp: [
    { text: '歐 ~ 你回來啦 ~ 燈燈睡了一下喵',     tone: 'cute' },
    { text: '啊,你終於回來了!K 線都變了喔',     tone: 'cute' },
    { text: '燈燈剛剛打瞌睡,要不要重新整理一下?', tone: 'cute' },
    { text: '歡迎回來喵 ~',                       tone: 'cute' },
    { text: '走那麼久,燈燈差點睡死',              tone: 'savage' },
  ],

  // ── 閒置(用戶久沒動) ───────────────────────────────────
  idle: [
    { text: '燈燈陪你看 K 線陪到睡著了...',       tone: 'cute' },
    { text: '在看什麼這麼久喵?',                   tone: 'cute' },
    { text: '決定不了的話,燈燈建議先休息',         tone: 'cute' },
    { text: '看那麼久決定了嗎?還是要燈燈幫你選?', tone: 'savage' },
  ],

  // ── 第一次進入(歡迎) ───────────────────────────────────
  greeting: [
    { text: '哈囉 ~ 我是燈燈,陪你看盤 ~',         tone: 'cute' },
    { text: '燈燈來啦 ~ 點個股我就幫你看',         tone: 'cute' },
    { text: '今天想看哪檔?燈燈陪你 ~',           tone: 'cute' },
  ],

  // ── 多週期共振 — 全多 ────────────────────────────────────
  resonanceBull: [
    { text: '六個週期都偏多,結構強健 ~',          tone: 'cute' },
    { text: '長短線一致看多,但別追高喔',          tone: 'cute' },
    { text: '結構好歸好,進場點還是要等回測',      tone: 'cute' },
    { text: '多週期一致,燈燈也覺得可以關注 ~',    tone: 'cute' },
    { text: '健康度都不錯,值得放關注名單',        tone: 'cute' },
    { text: '看起來不錯,但市場隨時會翻臉',        tone: 'savage' },
  ],

  // ── 多週期共振 — 全空 ────────────────────────────────────
  resonanceBear: [
    { text: '六個週期都偏空,燈燈建議放生',        tone: 'savage' },
    { text: '結構這麼空,你還想接?',              tone: 'savage' },
    { text: '空頭趨勢明確,燈燈不建議逆勢',        tone: 'cute' },
    { text: '長短皆空,連反彈都沒,別逞英雄',      tone: 'savage' },
    { text: '想抄底?燈燈見過太多想抄底的人了',    tone: 'savage' },
    { text: '止跌訊號都沒,進去就是接刀',          tone: 'savage' },
  ],

  // ── 燈號觸發(MP2 — Phase 7.1 Batch 2 新增) ─────────────
  // 這是「通用」回應,個別燈號的精準台詞在 chart-signal-overlay.js 內 inline
  // (Phase 7.5 換 Claude API 後,這個 fallback 才會用到)
  signalTrigger: [
    { text: '燈燈幫你標出來囉 ~',                  tone: 'cute' },
    { text: '看看 K 線上的標記 ~',                 tone: 'cute' },
    { text: '燈燈已經畫好線了 ~ 喵',               tone: 'cute' },
    { text: '說明就在 K 線上方,看清楚再下單喔',  tone: 'cute' },
    { text: '看完記得自己想清楚,燈燈不負責',     tone: 'savage' },
  ],
};
