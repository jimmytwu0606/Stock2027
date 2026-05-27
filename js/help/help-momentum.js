/* js/help/help-momentum.js — 動能指標說明 */
export const helpMomentum = `
  <article class="ind-card">
    <h3>🌀 RSI — 相對強弱指標（Relative Strength Index）</h3>
    <p class="ind-tag">經典超買超賣指標，1978年 J. Welles Wilder 發明</p>
    <h4>🎯 計算方式</h4>
    <p>RSI = 100 - 100 / (1 + RS)，其中 RS = N日平均上漲幅度 / N日平均下跌幅度。常用 RSI(14)。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>RSI &gt; 70：</strong> 超買區，警惕回檔</li>
      <li><strong>RSI &lt; 30：</strong> 超賣區，可能反彈</li>
      <li><strong>RSI 50–70：</strong> 健康強勢區（系統健康度給最高分）</li>
      <li><strong>RSI &gt; 80：</strong> 極度超買，反轉風險極高（系統重扣 15 分）</li>
      <li><strong>背離訊號：</strong> 股價創新高但 RSI 不創新高 → 頂背離（賣訊）</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>強勢股不會輕易跌破 50；空頭股難以站上 50。RSI 在 50 附近的方向，決定中短期偏多/偏空。</p>
  </article>

  <article class="ind-card">
    <h3>📈 KD — 隨機指標（Stochastic Oscillator）</h3>
    <p class="ind-tag">George Lane 1957年發明，捕捉短期動能轉折</p>
    <h4>🎯 計算方式</h4>
    <p>RSV = (今日收盤 - N日最低) / (N日最高 - N日最低) × 100。K = 前日K × 2/3 + 今日RSV × 1/3。D = 前日D × 2/3 + 今日K × 1/3。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>K &gt; 80：</strong> 超買區</li>
      <li><strong>K &lt; 20：</strong> 超賣區</li>
      <li><strong>K 線突破 D 線（黃金交叉）：</strong> 買進訊號</li>
      <li><strong>K 線跌破 D 線（死亡交叉）：</strong> 賣出訊號</li>
      <li><strong>K &gt; 85：</strong> 極度超買，系統重扣 10 分</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>適合短線進出。低檔黃金交叉（K &lt; 20 區）勝率較高；高檔死亡交叉（K &gt; 80）警示明確。</p>
  </article>

  <article class="ind-card">
    <h3>🌊 MACD — 指數平滑異同移動平均</h3>
    <p class="ind-tag">Gerald Appel 1979年發明，趨勢與動能的綜合判斷</p>
    <h4>🎯 計算方式</h4>
    <ul>
      <li>DIF = EMA(12) - EMA(26)</li>
      <li>MACD（信號線）= EMA(DIF, 9)</li>
      <li>柱狀圖（OSC）= DIF - MACD</li>
    </ul>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>DIF 突破 MACD 線：</strong> 黃金交叉，買進</li>
      <li><strong>DIF 跌破 MACD 線：</strong> 死亡交叉，賣出</li>
      <li><strong>柱狀圖由負轉正：</strong> 動能轉強</li>
      <li><strong>0軸之上：</strong> 多頭趨勢；0軸之下：空頭趨勢</li>
      <li><strong>背離：</strong> 最強訊號，股價新高但 MACD 不創新高 = 頂背離</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>適合波段操作。0軸上方的黃金交叉勝率高，0軸下方的黃金交叉常是反彈非反轉。</p>
  </article>

  <article class="ind-card">
    <h3>🎯 RCI — 順位相關係數（Rank Correlation Index）</h3>
    <p class="ind-tag">日系指標，以「時間順序」與「價格順序」的相關性偵測轉折</p>
    <h4>🎯 計算方式</h4>
    <p>對最近 N 天的價格做排序（高→低），同時對時間做排序（新→舊），兩者用 Spearman 相關係數計算，範圍 -100 到 +100。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>RCI &gt; +80：</strong> 極度超買，警惕回檔</li>
      <li><strong>RCI &lt; -80：</strong> 極度超賣，反彈機會</li>
      <li><strong>RCI 從 -80 翻轉向上 → 強買進訊號</strong></li>
      <li><strong>短期(9日) 與 中期(26日) 同向 → 趨勢確立</strong></li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>RSI 在 30–70 區間時反應遲鈍，RCI 對轉折更敏銳。日本當沖派常用。</p>
  </article>

  <article class="ind-card">
    <h3>🧠 PSY — 心理線（Psychological Line）</h3>
    <p class="ind-tag">最簡單的市場情緒指標</p>
    <h4>🎯 計算方式</h4>
    <p>PSY = (N天內上漲天數 / N) × 100。常用 PSY(12)。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>PSY &gt; 75：</strong> 樂觀過度，警惕回檔</li>
      <li><strong>PSY &lt; 25：</strong> 悲觀過度，反彈機會</li>
      <li><strong>PSY 在 40–60：</strong> 市場情緒平衡</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>純情緒指標，配合 RSI、KD 使用。三者同時超賣 = 強反彈訊號；同時超買 = 強回檔警示。</p>
  </article>
`;
