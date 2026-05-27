/* js/help/help-ma.js — 移動平均說明 */
export const helpMA = `
  <article class="ind-card">
    <h3>📊 MA — 移動平均線（Moving Average）</h3>
    <p class="ind-tag">最基礎、最重要的趨勢指標</p>
    <h4>🎯 計算方式</h4>
    <p>取最近 N 天的收盤價平均值，繪成連續曲線。常用 MA5（週線）、MA20（月線）、MA60（季線）、MA120（半年線）、MA240（年線）。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>多頭排列：</strong> 短期 MA &gt; 長期 MA（MA5 &gt; MA20 &gt; MA60），代表上升趨勢</li>
      <li><strong>空頭排列：</strong> 短期 MA &lt; 長期 MA，代表下降趨勢</li>
      <li><strong>黃金交叉：</strong> 短期 MA 由下向上穿越長期 MA，買進訊號</li>
      <li><strong>死亡交叉：</strong> 短期 MA 由上向下穿越長期 MA，賣出訊號</li>
      <li><strong>支撐/壓力：</strong> 多頭時 MA 為支撐，空頭時 MA 為壓力</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>葛蘭碧八大法則的核心。股價靠近 MA 不跌破 = 強勢；跌破 MA20 = 短期轉弱；跌破 MA60 = 中期趨勢改變。</p>
    <h4>⚠️ 局限</h4>
    <p>落後指標，盤整時頻繁發出假訊號。需要配合量能或其他指標確認。</p>
  </article>

  <article class="ind-card">
    <h3>⚡ EMA — 指數移動平均（Exponential Moving Average）</h3>
    <p class="ind-tag">反應更快的 MA，給近期價格更高權重</p>
    <h4>🎯 計算方式</h4>
    <p>EMA = (今日收盤 × α) + (昨日 EMA × (1-α))，其中 α = 2/(N+1)。最新價權重最大，越早的價格權重指數衰減。</p>
    <h4>📖 與 MA 的差異</h4>
    <ul>
      <li>MA 給每根 K 線相同權重 → 反應慢但穩定</li>
      <li>EMA 給最新 K 線最大權重 → 反應快但易被短期波動影響</li>
      <li>EMA 交叉訊號比 MA 早 1–3 天出現</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>短線操作首選。EMA5 突破 EMA20 = 短線啟動；ADX &gt; 20 確認後可進場（過濾盤整假訊號）。</p>
  </article>

  <article class="ind-card">
    <h3>🐉 GMMA — 顧比複合移動平均（Guppy Multiple MA）</h3>
    <p class="ind-tag">12條 EMA 構成的均線群，澳洲交易員 Daryl Guppy 開發</p>
    <h4>🎯 構成</h4>
    <ul>
      <li><strong>短期組（散戶）：</strong> EMA 3, 5, 8, 10, 12, 15</li>
      <li><strong>長期組（主力）：</strong> EMA 30, 35, 40, 45, 50, 60</li>
    </ul>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>短期組全部穿越長期組 → 強勢上攻</strong></li>
      <li><strong>兩組分離擴大 → 趨勢加速</strong></li>
      <li><strong>兩組糾纏 → 盤整或趨勢轉變中</strong></li>
      <li><strong>短期組跌回長期組但被支撐 → 健康回檔</strong></li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>判斷主力與散戶資金的角力。短期組向上穿越長期組是「主力認同散戶」的訊號，趨勢確立。</p>
    <h4>⚠️ 注意</h4>
    <p>12條線同時渲染對效能要求較高，預設關閉。低階裝置可能稍慢。</p>
  </article>
`;
