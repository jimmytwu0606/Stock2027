/* js/help/help-trend.js — 趨勢指標說明 */
export const helpTrend = `
  <article class="ind-card">
    <h3>☁️ Ichimoku — 一目均衡表（Ichimoku Kinko Hyo）</h3>
    <p class="ind-tag">日本經典長線指標，雲帶+5條線「一眼看穿」走勢</p>
    <h4>🎯 五條線</h4>
    <ul>
      <li><strong>轉換線 Tenkan（藍）：</strong> 9 日最高+最低 / 2，短期動向</li>
      <li><strong>基準線 Kijun（紅）：</strong> 26 日最高+最低 / 2，中期支撐/壓力</li>
      <li><strong>先行帶 A（橘 Area）：</strong> (Tenkan+Kijun)/2，前移 26 日</li>
      <li><strong>先行帶 B（紫 Area）：</strong> 52 日最高+最低 / 2，前移 26 日</li>
      <li><strong>延遲線 Chikou（綠）：</strong> 收盤後移 26 日，對比 26 日前價</li>
    </ul>
    <h4>☁️ 雲帶（Kumo）— 一目均衡表的靈魂</h4>
    <ul>
      <li><strong>橘 &gt; 紫（多頭雲）：</strong> 未來 26 日趨勢偏多，雲帶為強支撐</li>
      <li><strong>紫 &gt; 橘（空頭雲）：</strong> 未來 26 日趨勢偏空，雲帶為強壓力</li>
      <li><strong>收盤在雲帶上方：</strong> 多頭區，回測雲帶上緣為買點</li>
      <li><strong>收盤在雲帶下方：</strong> 空頭區，反彈到雲帶下緣為賣點</li>
      <li><strong>收盤在雲帶內：</strong> 整理區，等待方向明確</li>
    </ul>
    <h4>📖 三大訊號</h4>
    <ul>
      <li><strong>三役好轉（最強多頭）：</strong> Tenkan&gt;Kijun + 收盤&gt;雲帶頂 + Chikou&gt;26日前價</li>
      <li><strong>雲帶上行：</strong> 收盤站上雲帶上緣 + 未來雲帶為多頭</li>
      <li><strong>TK 黃金交叉：</strong> Tenkan 由下穿越 Kijun（短期啟動）</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>長線投資人的首選。三役好轉是公認的台股「全押多單」訊號之一。需要至少 52 根日 K 才能計算完整雲帶。</p>
  </article>

  <article class="ind-card">
    <h3>🧭 DMI — 動向指標（Directional Movement Index）</h3>
    <p class="ind-tag">Wilder 發明，判斷趨勢方向與強度的權威指標</p>
    <h4>🎯 構成（三條線）</h4>
    <ul>
      <li><strong>+DI（紅）：</strong> 多方力量強度</li>
      <li><strong>-DI（綠）：</strong> 空方力量強度</li>
      <li><strong>ADX（黃）：</strong> 趨勢強度（不分多空）</li>
    </ul>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>+DI &gt; -DI 且 ADX &gt; 25：</strong> 強勁上升趨勢，可追多</li>
      <li><strong>+DI &lt; -DI 且 ADX &gt; 25：</strong> 強勁下降趨勢，避免進場</li>
      <li><strong>ADX &lt; 20：</strong> 盤整市場，所有趨勢指標都失準</li>
      <li><strong>+DI 上穿 -DI：</strong> 趨勢轉多訊號</li>
      <li><strong>ADX 從低位上升：</strong> 新趨勢正在形成</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>最重要的「過濾器」。ADX &lt; 20 時，KD 黃金交叉、MA 突破等訊號的勝率都會大幅降低。</p>
  </article>

  <article class="ind-card">
    <h3>☄️ SAR — 拋物線轉向系統（Parabolic SAR）</h3>
    <p class="ind-tag">Wilder 1978年發明，自動產生停損點</p>
    <h4>🎯 計算方式</h4>
    <p>SAR 點在多頭時位於 K 線下方（紅點），空頭時位於 K 線上方（綠點）。SAR 會以加速度向價格逼近，直到被穿透 → 翻轉方向。</p>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>SAR 點在 K 線下方（紅）：</strong> 多頭，持有</li>
      <li><strong>SAR 點在 K 線上方（綠）：</strong> 空頭，避開</li>
      <li><strong>SAR 翻轉：</strong> 趨勢反轉訊號</li>
      <li><strong>SAR 加速逼近價格：</strong> 趨勢即將結束</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>提供自動停損價位。多頭時 SAR 點就是停損點，價格跌破 SAR → 立刻出場。配合 MACD 過濾盤整期假訊號。</p>
    <h4>⚠️ 局限</h4>
    <p>盤整市場頻繁翻轉，需要至少 30 根 K 線才穩定（系統前30根設為 null 暖機）。</p>
  </article>

  <article class="ind-card">
    <h3>📡 BB — 布林通道（Bollinger Bands）</h3>
    <p class="ind-tag">John Bollinger 1980年代發明，動態壓力支撐</p>
    <h4>🎯 構成</h4>
    <ul>
      <li><strong>中軌：</strong> MA20</li>
      <li><strong>上軌：</strong> MA20 + 2 × 標準差</li>
      <li><strong>下軌：</strong> MA20 - 2 × 標準差</li>
    </ul>
    <h4>📖 解讀方式</h4>
    <ul>
      <li><strong>價格觸及上軌：</strong> 短期超買</li>
      <li><strong>價格觸及下軌：</strong> 短期超賣</li>
      <li><strong>通道收窄（Squeeze）：</strong> 波動性極低，醞釀大行情</li>
      <li><strong>通道擴張：</strong> 趨勢明確，順勢操作</li>
      <li><strong>價格沿上軌行走：</strong> 強勢趨勢，不要逆勢做空</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>強勢股可沿上軌持續上攻數週，不要被「超買」概念誤導。通道收窄後突破方向通常是後續趨勢方向。</p>
  </article>

  <article class="ind-card">
    <h3>🎯 ENV — 包絡線（Envelope）</h3>
    <p class="ind-tag">簡化版的 BB，固定百分比偏移（MA20 ± 5%）</p>
    <h4>🎯 計算方式</h4>
    <ul>
      <li>上軌：MA20 × (1 + 5%)</li>
      <li>下軌：MA20 × (1 - 5%)</li>
    </ul>
    <h4>📖 與 BB 的差異</h4>
    <ul>
      <li>BB 用標準差動態調整 → 波動大時自動擴張</li>
      <li>ENV 用固定百分比 → 對極端行情反應遲鈍</li>
      <li>但 ENV 更穩定，適合波段操作</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>觸及下軌通常是低位反彈機會。觸及上軌警惕短線回檔。</p>
  </article>
`;
