/* js/help/help-volatility.js — 波動指標說明 */
export const helpVolatility = `
  <article class="ind-card">
    <h3>📉 HV — 歷史波動率（Historical Volatility）</h3>
    <p class="ind-tag">衡量價格波動劇烈程度，年化百分比</p>
    <h4>🎯 計算方式</h4>
    <p>HV = 收盤價對數報酬的標準差 × √252 × 100%（年化）。常用 HV(20)。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>HV &lt; 15%：</strong> 超低波動，潛伏期（系統加 8 分）</li>
      <li><strong>HV 15–25%：</strong> 低波動，等待爆發</li>
      <li><strong>HV 25–40%：</strong> 正常波動</li>
      <li><strong>HV 40–60%：</strong> 高波動，行情已啟動</li>
      <li><strong>HV &gt; 60%：</strong> 極高波動，過熱警示（系統扣 8 分）</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>「低波動潛伏」策略的核心。HV 長期偏低後突然放大，往往是大行情起點。HV 過高表示行情已走完一大段，追高危險。</p>
    <h4>📝 進階概念</h4>
    <p>選擇權交易者用 HV 估算合理權利金。HV 低 = 期權便宜；HV 高 = 期權昂貴。</p>
  </article>

  <article class="ind-card">
    <h3>📏 乖離率（Bias）</h3>
    <p class="ind-tag">股價偏離均線的百分比</p>
    <h4>🎯 計算方式</h4>
    <p>Bias = (收盤價 - MAN) / MAN × 100%。常用 Bias(20)。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>Bias &gt; +20%：</strong> 嚴重超漲，禁止追高（系統扣 4 分）</li>
      <li><strong>Bias &gt; +10%：</strong> 偏貴</li>
      <li><strong>Bias 0%：</strong> 股價貼齊均線</li>
      <li><strong>Bias &lt; -8%：</strong> 偏跌</li>
      <li><strong>Bias &lt; -15%：</strong> 超跌，反彈候選</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>強勢股 Bias 可長期維持 +5% 到 +15%；極端值 ±15% 是經典反向操作訊號。但要配合趨勢——強勢股不要因為「偏貴」就賣，否則容易踏空。</p>
  </article>
`;
