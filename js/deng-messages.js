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

export const DENG_MESSAGES = window.__DENG_MESSAGES = {

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


  // ══════════════════════════════════════════════════════════
  // 觀點卡專用台詞（perspective tab）
  // ──────────────────────────────────────────────────────────
  // 設計原則：
  //   1. 不重複卡片已渲染的壓力/支撐/訊號名稱
  //   2. 聚焦「基本面品質」×「技術面狀態」的交叉結論
  //   3. 燈燈給態度，不給廢話
  //
  // 插值佔位符：
  //   {code}           股票代號
  //   {lamps}          燈號數值（+3.5 / -2.0）
  //   {rsi}            RSI 數值（整數）
  //   {bias}           MA20 乖離率（+8.2 / -5.1）
  //   {phase}          波段位置（蓄積/啟動/主升/過熱/修正）
  //   {eps}            EPS 最新季（元）
  //   {epsGrowth}      EPS 年增率（%）
  //   {revenueGrowth}  營收年增率（%）
  //   {grossMargin}    毛利率（%）
  //   {pe}             本益比
  //   {foreignNet}     外資買賣超（張，正=買超 負=賣超）
  //   {topSignal}      最強買進訊號名稱
  //   {topWarn}        最強避險訊號名稱
  // ══════════════════════════════════════════════════════════

  // ── 強多（3燈以上）× 基本面佳 ─────────────────────────────
  // 條件：lamps >= 3 && fundQuality === 'good'
  perspective_bull_strong_fund_good: [
    { text: 'EPS 年增 {epsGrowth}%、毛利率 {grossMargin}%，基本面撐著，技術面 {lamps} 燈。公司賺錢、市場也在買，兩件事同時成立的時候不多，喵。', tone: 'cute' },
    { text: '獲利在成長、籌碼在堆疊、趨勢在走多——這三個同時出現，燈燈沒什麼好挑剔的。', tone: 'cute' },
    { text: '基本面不是裝飾，EPS 年增 {epsGrowth}% 是真的在賺錢。技術面再配 {lamps} 燈，這種組合燈燈見過不多。', tone: 'cute' },
    { text: '毛利率 {grossMargin}%、EPS 持續成長，公司體質好。現在又在 {phase} 段，不是說一定漲，但條件齊了。', tone: 'cute' },
    { text: '財報數字不說謊，{epsGrowth}% 的年增率在這個市場算是優等生。技術面也站多頭，燈燈覺得可以認真看。', tone: 'cute' },
    { text: 'EPS 年增 {epsGrowth}%，燈燈不知道你還在等什麼。', tone: 'savage' },
    { text: '基本面好、技術面多、外資也在買——你如果還猶豫，燈燈幫不了你，喵。', tone: 'savage' },
  ],

  // ── 強多（3燈以上）× 基本面普通 ───────────────────────────
  // 條件：lamps >= 3 && fundQuality === 'neutral'
  perspective_bull_strong_fund_neutral: [
    { text: '技術面 {lamps} 燈，{phase} 段，訊號很強。但基本面是普通水準，這波主要是市場在炒，獲利品質要自己判斷。', tone: 'cute' },
    { text: '漲是真的在漲，但 EPS 成長不算亮眼。題材行情居多，跟著走可以，但別當長線核心持股，喵。', tone: 'cute' },
    { text: '技術面站多頭沒問題，但基本面沒有特別支撐。行情好的時候什麼都漲，燈燈建議設好停利就好。', tone: 'cute' },
    { text: '訊號是有，公司本身賺錢能力普普。題材炒作型的行情，燈燈通常不建議重押。', tone: 'savage' },
    { text: '{phase} 段技術面強，但財報說話要誠實——獲利成長不夠，這波行情能走多遠？燈燈打個問號。', tone: 'savage' },
  ],

  // ── 強多（3燈以上）× 基本面差 ─────────────────────────────
  // 條件：lamps >= 3 && fundQuality === 'poor'
  perspective_bull_strong_fund_poor: [
    { text: '技術面多頭，但獲利在衰退——這種組合叫做「市場先走一步」，有時候是真的，有時候是陷阱，喵。', tone: 'cute' },
    { text: '漲得動是因為有人在買，不是因為公司變好了。燈燈不是說不能進，但要清楚你在賭什麼。', tone: 'savage' },
    { text: 'EPS 衰退還在 {phase} 段，燈燈見過這種組合，結局通常不太好看。', tone: 'savage' },
    { text: '技術多頭 + 基本面衰退，這是最難操作的組合。跟著動能走可以，但第一時間看到訊號轉弱就跑。', tone: 'cute' },
    { text: '公司在賠錢或獲利縮水，但市場在買。燈燈尊重市場，但這種情況停損要設很嚴。', tone: 'savage' },
  ],

  // ── 偏多啟動（1.5~3燈）× 基本面佳 ────────────────────────
  // 條件：lamps >= 1.5 && lamps < 3 && fundQuality === 'good'
  perspective_bull_mid_fund_good: [
    { text: 'EPS 年增 {epsGrowth}%，基本面有撐。技術面剛啟動，{lamps} 燈，方向偏多但還沒全面確認。', tone: 'cute' },
    { text: '財報數字不錯，技術面也在翻多的路上。這種時候燈燈的習慣是小量先進，等訊號更清楚再加碼。', tone: 'cute' },
    { text: '公司在賺錢、技術面在啟動，這個組合燈燈覺得值得盯著，喵。', tone: 'cute' },
    { text: '毛利率 {grossMargin}%，獲利品質還不錯。技術面在 {phase} 段，如果方向確認，基本面會是這波的底氣。', tone: 'cute' },
    { text: '好公司不一定馬上漲，但 EPS {epsGrowth}% 的成長加上技術面啟動，時間站在多頭這邊，喵。', tone: 'cute' },
    { text: '基本面好、技術面啟動——你在等什麼？燈燈覺得你應該比現在更積極一點。', tone: 'savage' },
  ],

  // ── 偏多啟動（1.5~3燈）× 基本面普通 ──────────────────────
  // 條件：lamps >= 1.5 && lamps < 3 && fundQuality === 'neutral'
  perspective_bull_mid_fund_neutral: [
    { text: '技術面訊號出來了，{phase} 段，方向偏多。基本面算普通，這種情況燈燈建議跟著動能走，別太貪。', tone: 'cute' },
    { text: '訊號在啟動，但財報沒有特別亮點。短線可以跟，長線要保守，喵。', tone: 'cute' },
    { text: '{lamps} 燈，技術面偏多，但公司獲利成長有限。進場可以，停利要比平常設早一點。', tone: 'cute' },
    { text: '動能有，但底氣不夠厚。燈燈覺得這種股票不適合重押。', tone: 'savage' },
  ],

  // ── 偏多啟動（1.5~3燈）× 基本面差 ────────────────────────
  // 條件：lamps >= 1.5 && lamps < 3 && fundQuality === 'poor'
  perspective_bull_mid_fund_poor: [
    { text: '技術面啟動，但獲利在衰退。燈燈不是說不能進，但這種組合的成功率不高。', tone: 'savage' },
    { text: '{phase} 段，動能有，但財報在拖後腿。短線題材可以玩，不要誤會成趨勢行情。', tone: 'cute' },
    { text: '技術面翻多但基本面在走下坡，燈燈這種組合看過很多次，謹慎一點比較好喵。', tone: 'savage' },
  ],

  // ── 中性觀望（-1.5~1.5燈）× 基本面佳 ─────────────────────
  // 條件：lamps > -1.5 && lamps < 1.5 && fundQuality === 'good'
  perspective_neutral_fund_good: [
    { text: '公司基本面不錯，EPS {epsGrowth}% 的成長算實在。技術面方向還不明確，燈燈建議等訊號確認再進，不用急。', tone: 'cute' },
    { text: '好公司有時候就是需要等一個好進場點。財報撐著，技術面等方向，喵。', tone: 'cute' },
    { text: 'EPS 成長、毛利率 {grossMargin}%，公司體質好。現在技術面在整理，等它準備好再說。', tone: 'cute' },
    { text: '財報好但技術面沒方向，這叫「好股票在盤整」。燈燈的建議是先列觀察，不要因為財報好就追進去。', tone: 'cute' },
    { text: '公司是好公司，但好公司也會讓你套住。技術面方向不明，別只看財報就下手，喵。', tone: 'savage' },
    { text: 'EPS 好看不代表現在是進場時機，多等等，喵。', tone: 'savage' },
  ],

  // ── 中性觀望（-1.5~1.5燈）× 基本面普通 ───────────────────
  // 條件：lamps > -1.5 && lamps < 1.5 && fundQuality === 'neutral'
  perspective_neutral_fund_neutral: [
    { text: '技術面沒方向，基本面也沒亮點。燈燈看到這種情況通常會直接跳過，喵。', tone: 'savage' },
    { text: '多空訊號互相抵銷，財報也沒特別說服燈燈。這種時候等待是最好的策略。', tone: 'cute' },
    { text: '沒訊號、沒基本面加持，你看這檔是要幹嘛，喵？', tone: 'savage' },
    { text: '兩邊都沒有特別的理由，燈燈的建議是把注意力放在其他更清楚的機會。', tone: 'cute' },
    { text: '沒理由買，也沒理由賣。這種股票最磨人，燈燈建議先放一邊。', tone: 'cute' },
  ],

  // ── 中性觀望（-1.5~1.5燈）× 基本面差 ─────────────────────
  // 條件：lamps > -1.5 && lamps < 1.5 && fundQuality === 'poor'
  perspective_neutral_fund_poor: [
    { text: '獲利在走下坡，技術面也沒有多頭訊號。這種組合燈燈真的不知道你為什麼要看它。', tone: 'savage' },
    { text: '基本面在退步，技術面沒有指引，燈燈建議直接放生。', tone: 'savage' },
    { text: '公司賺錢能力在下滑，市場也沒有買單，燈燈覺得放生比觀望更有效率，喵。', tone: 'savage' },
    { text: '財報在退步，技術面無方向。這種股票觀望也是浪費時間，喵。', tone: 'savage' },
  ],

  // ── 偏空（-3~-1.5燈）× 基本面佳 ──────────────────────────
  // 條件：lamps <= -1.5 && lamps > -3 && fundQuality === 'good'
  perspective_bear_mid_fund_good: [
    { text: '公司基本面沒問題，EPS 還在成長。但技術面偏弱，這種情況燈燈通常等技術面止跌再說。', tone: 'cute' },
    { text: '財報撐著，技術面卻在走弱——可能是市場在修正估值，也可能是短線過熱後的整理。別急著接，喵。', tone: 'cute' },
    { text: 'EPS {epsGrowth}% 的成長是真實的，但技術面偏空。好公司跌下來有時候是機會，但要等止跌訊號。', tone: 'cute' },
    { text: '基本面好不代表現在可以買。技術面空頭，再好的財報也會讓你先套一段時間，喵。', tone: 'savage' },
    { text: '好公司也可能短期跌很深，技術面偏空的時候燈燈建議先觀望，等訊號翻多再說。', tone: 'cute' },
  ],

  // ── 偏空（-3~-1.5燈）× 基本面普通 ────────────────────────
  // 條件：lamps <= -1.5 && lamps > -3 && fundQuality === 'neutral'
  perspective_bear_mid_fund_neutral: [
    { text: '技術面偏空，基本面也沒亮點。兩個都不站多頭，燈燈不知道留著它的理由是什麼。', tone: 'savage' },
    { text: '訊號偏空，財報沒有特別支撐，這種情況燈燈建議先減碼觀察。', tone: 'cute' },
    { text: '技術空頭 + 基本面平庸，繼續持有是在賭它會自己好轉，喵。', tone: 'savage' },
  ],

  // ── 偏空（-3~-1.5燈）× 基本面差 ──────────────────────────
  // 條件：lamps <= -1.5 && lamps > -3 && fundQuality === 'poor'
  perspective_bear_mid_fund_poor: [
    { text: '獲利在衰退，技術面也在走弱。燈燈說直白一點——這檔現在沒有任何留著的理由。', tone: 'savage' },
    { text: '財報退步 + 技術偏空，雙重壓力，燈燈建議減碼或出場。', tone: 'savage' },
    { text: 'EPS 在縮水、技術面在走空，這種組合燈燈見過很多次，通常還有得跌，喵。', tone: 'savage' },
    { text: '公司賺錢能力下滑，市場也在賣，燈燈沒辦法給你留著的理由。', tone: 'savage' },
  ],

  // ── 強空（-3燈以下）× 任何基本面 ──────────────────────────
  // 條件：lamps <= -3
  perspective_bear_strong: [
    { text: '多個空頭訊號同時壓著，這不是個別指標的雜訊，是趨勢性的轉弱。燈燈的建議是先出場，等訊號翻多再說。', tone: 'cute' },
    { text: '空頭訊號這麼密集，你還在思考要不要賣？燈燈覺得你應該先動作再想。', tone: 'savage' },
    { text: '技術面全面轉空，現在問的不是「要不要賣」，是「要賣多少」。燈燈建議至少先減半。', tone: 'savage' },
    { text: '這麼多空頭訊號同時出現，燈燈也不知道底在哪，但燈燈知道現在不是接刀的時候。', tone: 'cute' },
    { text: '空頭確立，財報好壞此時是次要的——市場在賣，你要跟著走。', tone: 'savage' },
    { text: '燈燈看到這種訊號組合通常不會留著，你看著辦，喵。', tone: 'savage' },
  ],

  // ── 妖股（X2 天黑請閉眼）──────────────────────────────────
  // 條件：sigIds.has('X2')
  perspective_yaogu_x2: [
    { text: '主力加速攻擊，這種行情跟著走是有道理的。但燈燈提醒你：妖股的出場比進場難十倍，停損要設好。', tone: 'cute' },
    { text: '飆股加速段，贏的人都很快，輸的人也很快。你進去之前要想清楚自己是哪一種，喵。', tone: 'savage' },
    { text: '量在爆、價在飆，主力還沒跑。但燈燈見過太多「以為主力還沒跑」的人最後拿到的是出貨單。', tone: 'savage' },
    { text: '這種行情燈燈不勸你不進，但停損要比平常設得更嚴。RSI 頂背離出現的那天就是離場時機。', tone: 'cute' },
    { text: '天黑請閉眼，但別睡死在裡面，喵。', tone: 'savage' },
    { text: '妖股行情短暫但刺激，燈燈尊重動能，但尊重歸尊重，倉位輕一點。', tone: 'cute' },
  ],

  // ── 妖股（X5 量證明一切）──────────────────────────────────
  // 條件：sigIds.has('X5')
  perspective_yaogu_x5: [
    { text: '爆量建倉的早期訊號，比主力大手進場早一點。但早進也可能早錯，等量能持續確認再加碼。', tone: 'cute' },
    { text: '量在爆，可能是主力在建倉，也可能是散戶在追。這個時間點燈燈建議小量試水，喵。', tone: 'cute' },
    { text: '這個訊號的精髓是「比天黑早 5 天進」——進得對就爽，進錯就吃到的是假突破。', tone: 'savage' },
    { text: '量能爆發，燈燈覺得有意思。但這是早期訊號，不是確認訊號，進場要輕。', tone: 'cute' },
  ],

  // ── RSI 過熱（rsiVal > 78）────────────────────────────────
  // 條件：rsiVal > 78（技術面多頭但過熱）
  perspective_overheat: [
    { text: 'RSI {rsi}，短線偏熱。方向多頭沒問題，但這個位置追進去，是用比較貴的價格換確定性。', tone: 'cute' },
    { text: 'RSI 到 {rsi} 了，不是不能追，但追高要有心理準備接受短線回測，喵。', tone: 'cute' },
    { text: '趨勢還在，但 RSI {rsi} 是在告訴你：現在不是最好的進場點，等回測比較划算。', tone: 'cute' },
    { text: 'RSI {rsi}，燈燈不是叫你賣，但你現在才進是去接力，不是在低點布局，要清楚自己在做什麼。', tone: 'savage' },
    { text: '多頭沒問題，但 RSI {rsi} 這種位置進去，短線被套的機率不小。', tone: 'savage' },
    { text: 'RSI {rsi}，熱過頭了。冷靜一下，喵。', tone: 'savage' },
  ],

  // ── 超跌反彈機會（rsiVal < 32）────────────────────────────
  // 條件：rsiVal < 32
  perspective_oversold: [
    { text: 'RSI {rsi}，超賣區間。反彈機率提升，但超賣不代表立刻反彈——等止跌訊號出現再說。', tone: 'cute' },
    { text: 'RSI 跌到 {rsi}，情緒面的賣壓接近極端。如果基本面沒有問題，這個位置值得開始留意。', tone: 'cute' },
    { text: '超賣不是買點，止跌才是買點。RSI {rsi} 只是告訴你「快了」，不是告訴你「現在」。', tone: 'cute' },
    { text: 'RSI {rsi}，跌得夠深了。但接刀之前先想想：它為什麼跌這麼深？', tone: 'savage' },
    { text: '超賣區燈燈見過很多次，有的真的反彈，有的繼續跌。等個止跌訊號保險一點，喵。', tone: 'cute' },
  ],

  // ── 外資連買（foreignNet 大量正值）────────────────────────
  // 條件：chips.foreignNet > 2000（張）
  perspective_foreign_buy: [
    { text: '外資買超 {foreignNet} 張，法人用錢投票。這不是散戶情緒，是機構在建倉。', tone: 'cute' },
    { text: '外資在買，投信也在加碼——法人站多頭的時候，散戶逆勢的勝率通常不高，喵。', tone: 'cute' },
    { text: '外資連續買超，代表機構認為這個價位有價值。技術面又站多頭，兩件事一起成立。', tone: 'cute' },
    { text: '法人資金流入是最好的趨勢確認訊號之一，燈燈覺得這個訊號比很多技術指標都可靠。', tone: 'cute' },
  ],

  // ── 外資連賣（foreignNet 大量負值）────────────────────────
  // 條件：chips.foreignNet < -2000（張）
  perspective_foreign_sell: [
    { text: '外資賣超 {foreignNet} 張，機構在出貨。你要跟法人反向操作，你確定你比他們聰明？', tone: 'savage' },
    { text: '法人在賣，技術面又偏弱，這兩個同時出現不是巧合。燈燈建議先觀望。', tone: 'savage' },
    { text: '外資在出清，不管理由是什麼，跟著聰明錢跑通常是比較安全的選擇，喵。', tone: 'cute' },
    { text: '外資賣超、技術偏空，燈燈沒有留著它的理由。', tone: 'savage' },
  ],

  // ── 估值便宜（PE 低、基本面佳）────────────────────────────
  // 條件：fundQuality === 'good' && pe < 15 && pe > 0
  perspective_value_cheap: [
    { text: 'PE {pe} 倍，EPS 年增 {epsGrowth}%——用低本益比買成長股，這是燈燈最喜歡的組合之一。', tone: 'cute' },
    { text: '本益比 {pe}，獲利還在成長，估值便宜。市場還沒充分定價，這種機會不常見，喵。', tone: 'cute' },
    { text: 'PE {pe} 加上 EPS 成長，安全邊際夠。技術面如果翻多，這個位置燈燈覺得很有吸引力。', tone: 'cute' },
    { text: '便宜的好公司，燈燈的最愛。PE {pe}、EPS 還在成長——你在等什麼，喵？', tone: 'savage' },
  ],

  // ── 估值過高（PE 高、基本面普通）──────────────────────────
  // 條件：pe > 40 && fundQuality !== 'good'
  perspective_value_expensive: [
    { text: 'PE {pe} 倍，獲利成長撐不住這個估值。市場在預期未來，但預期會落空的機率不小。', tone: 'cute' },
    { text: 'PE {pe}，很貴。如果未來幾季 EPS 沒有大幅成長，這個估值就是空氣，喵。', tone: 'savage' },
    { text: '本益比 {pe}，公司又沒有特別強的成長，燈燈覺得現在不是應該追的時候。', tone: 'savage' },
    { text: '市場給這個估值是在賭未來，賭對了大賺，賭錯了大跌。燈燈不判斷你賭不賭，但你要清楚這是在賭。', tone: 'cute' },
  ],

  // ── 三率改善（毛利率、營益率、淨利率同步上升）─────────────
  // 條件：grossMargin 和 revenueGrowth 都為正
  perspective_margin_improving: [
    { text: '毛利率 {grossMargin}%，三率改善——這代表公司不只在成長，成長的品質也在變好。這種訊號燈燈很在意。', tone: 'cute' },
    { text: '營收成長 + 毛利率提升，不只在賣更多，還在賣得更賺。這是體質改善的訊號，喵。', tone: 'cute' },
    { text: '三率同步走揚，財報品質提升。這種改善一旦被市場發現，通常股價會有一波反應。', tone: 'cute' },
    { text: '毛利率往上走，代表定價能力或成本控制在改善——這是競爭優勢的表現，燈燈喜歡這個。', tone: 'cute' },
  ],

  // ── 三率惡化（毛利率下滑）─────────────────────────────────
  // 條件：grossMargin 下滑 或 profitMargin 為負
  perspective_margin_declining: [
    { text: '毛利率 {grossMargin}% 在下滑，代表競爭壓力在吃掉獲利空間。這是基本面退步的早期訊號。', tone: 'cute' },
    { text: '賣得多但賺得少，這叫做「以量換質」。長期不是好訊號，喵。', tone: 'savage' },
    { text: '毛利率在縮水，燈燈不管技術面多強，這個訊號在說公司的護城河可能在消失。', tone: 'savage' },
    { text: '獲利品質在下滑，短線追技術面可以，但把它當長期持股要三思。', tone: 'savage' },
  ],

  // ── 無基本面資料（純技術面）───────────────────────────────
  // 條件：!hasFund
  perspective_no_fund: [
    { text: '燈燈只看得到技術面，基本面資料還沒載入。現在的判斷都是基於 K 線訊號，請自行評估財報品質。', tone: 'cute' },
    { text: '技術面 {lamps} 燈，{phase} 段，這是燈燈現在能給你的資訊。財報數字還沒抓到，自己查一下喵。', tone: 'cute' },
    { text: '沒有財報數字，燈燈只能說技術面的事。要完整判斷，建議你把基本面 tab 也看一下。', tone: 'cute' },
  ],

  // ── 多週期（法人 + 技術 + 基本面三合一）──────────────────
  // 條件：fundQuality === 'good' && chips.foreignNet > 1000 && lamps >= 2
  perspective_triple_confirm: [
    { text: '財報成長、外資在買、技術面多頭——三件事同時成立。燈燈不常見到這種組合，喵。', tone: 'cute' },
    { text: 'EPS 在長、法人在買、K線在走多，這三個訊號互相確認，這就是燈燈說的「共振」。', tone: 'cute' },
    { text: '基本面撐著、籌碼站多頭、技術面確認——這種機會出現的時候，猶豫是最大的損失，喵。', tone: 'savage' },
    { text: '財報、法人、技術面三面夾攻，燈燈覺得這檔值得認真對待。', tone: 'cute' },
  ],

  // ── 背離警告（技術強但基本面+籌碼都弱）───────────────────
  // 條件：lamps >= 2 && fundQuality === 'poor' && chips.foreignNet < -1000
  perspective_divergence_warning: [
    { text: '技術面多頭，但財報在退步、外資在賣——這叫背離。通常是技術面先撐著，最後還是回歸基本面。', tone: 'savage' },
    { text: '漲是真的，但背後沒有基本面和法人支撐。這種行情燈燈見過，通常是短線題材，不是趨勢，喵。', tone: 'savage' },
    { text: '技術多頭 + 基本面空 + 外資賣，這個組合讓燈燈很不安。短線跟可以，長線燈燈不敢保證。', tone: 'savage' },
  ],

};
