/* js/help/help-pattern.js — K線型態說明 */
export const helpPattern = `
  <article class="ind-card">
    <h3>🪖 紅三兵（Three White Soldiers）</h3>
    <p class="ind-tag">最強多頭延續訊號</p>
    <h4>🎯 辨識條件</h4>
    <ul>
      <li>連續 3 根陽線（收盤 &gt; 開盤）</li>
      <li>每根收盤都高於前一根</li>
      <li>每根實體（收盤-開盤）不能太小（系統要求 ≥ 前根 50%）</li>
      <li>最好出現在低檔盤整突破後</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>低檔出現勝率最高，代表底部翻轉。中段出現代表波段延續。但高檔（漲多後）出現的紅三兵可能是「最後一波」，要小心。</p>
  </article>

  <article class="ind-card">
    <h3>🫶 多頭吞噬（Bullish Engulfing）</h3>
    <p class="ind-tag">2根K線反轉組合中最可靠的</p>
    <h4>🎯 辨識條件</h4>
    <ul>
      <li>第一根：陰線</li>
      <li>第二根：陽線，且實體完全吞噬前一根（今日開盤 ≤ 昨日收盤，今日收盤 ≥ 昨日開盤）</li>
      <li>低檔出現最有效</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>第二根的成交量比第一根放大 → 訊號更強。配合 RSI 超賣（&lt;30）區出現，反彈勝率最高。</p>
  </article>

  <article class="ind-card">
    <h3>🏔️ 三重底（Triple Bottom，三川）</h3>
    <p class="ind-tag">大型底部反轉型態</p>
    <h4>🎯 辨識條件</h4>
    <ul>
      <li>近期出現 3 個相近低點（系統閾值：差距 &lt; 3%）</li>
      <li>3 個低點之間有反彈高點</li>
      <li>第三個低點量縮（系統要求）</li>
      <li>突破頸線（高點連線）後成立</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>形成時間越長，型態越可靠。突破頸線時量要放大，否則可能假突破。目標漲幅 = 底部到頸線的距離。</p>
  </article>

  <article class="ind-card">
    <h3>⛰️ 三重頂（Triple Top，三山）</h3>
    <p class="ind-tag">大型頂部反轉型態</p>
    <h4>🎯 辨識條件</h4>
    <ul>
      <li>近期出現 3 個相近高點（差距 &lt; 3%）</li>
      <li>每次衝高都失敗</li>
      <li>跌破頸線（低點連線）後確認</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>頂部型態風險警示，已持股應減碼。跌破頸線後常有反彈（拉回頸線）再大跌的走勢。</p>
  </article>

  <article class="ind-card">
    <h3>☕ 杯柄形態（Cup and Handle）</h3>
    <p class="ind-tag">William O'Neil（CAN SLIM 作者）最愛的中長線買點</p>
    <h4>🎯 辨識條件</h4>
    <ul>
      <li><strong>杯：</strong> U 型整理，杯深 &lt; 35%（系統閾值）</li>
      <li><strong>柄：</strong> 杯緣附近小幅回落，回落 &lt; 15%，量縮</li>
      <li><strong>突破：</strong> 帶量突破杯緣（杯左側高點）</li>
      <li>整體形成時間建議 7 週以上</li>
    </ul>
    <h4>💡 實戰應用</h4>
    <p>最可靠的中長線突破型態。柄部量縮代表浮額洗清，突破時量大代表主力進場。突破點 = 標準買點。</p>
    <h4>📝 歷史成功案例</h4>
    <p>蘋果、亞馬遜、輝達等大型成長股都曾多次形成杯柄後展開大波段。</p>
  </article>
`;
