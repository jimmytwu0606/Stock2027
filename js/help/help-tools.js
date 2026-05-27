/* js/help/help-tools.js — 輔助工具說明（PVD 分價量表等）*/
export const helpTools = `
  <article class="ind-card">
    <h3>📊 PVD — 分價量表（Price Volume Distribution）</h3>
    <p class="ind-tag">視覺化輔助工具 · 右側 canvas overlay · 即時動態更新</p>

    <h4>🎯 這是什麼？</h4>
    <p>分價量表（又稱「價量分布圖」）統計目前 K 線可視範圍內，<strong>每個價格區間的成交量</strong>，以橫向長條圖顯示在 K 線右側。你可以一眼看出「哪個價位成交最密集」。</p>

    <h4>📖 三個核心概念</h4>
    <ul>
      <li><strong>POC（Point of Control，最大量價位）</strong>：橘色橫線標示，成交量最大的價格。這個價格是多空雙方交戰最激烈的地方，往往形成強力支撐或壓力。</li>
      <li><strong>藍色長條（多頭 K 線成交量）</strong>：收盤 ≥ 開盤的 K 線所貢獻的成交量，代表買方在這個價位相對積極。</li>
      <li><strong>紅色長條（空頭 K 線成交量）</strong>：收盤 &lt; 開盤的 K 線所貢獻的成交量，代表賣方在這個價位相對積極。</li>
    </ul>

    <h4>💡 實戰應用</h4>
    <ul>
      <li><strong>長條越長 = 該價位交易越活躍 = 支撐/壓力越強</strong></li>
      <li><strong>POC（橘線）</strong>：股價回測 POC 時，常出現支撐或壓力反應，是重要的觀察點位</li>
      <li><strong>成交稀少區（長條極短）</strong>：稱為「低量區」，股價在此區間通常快速穿越，是缺乏支撐的危險區</li>
      <li><strong>藍多紅少 + 價位在下方</strong>：代表此價位買方積極，是較強的支撐區</li>
      <li><strong>紅多藍少 + 價位在上方</strong>：代表此價位賣方積極，是較強的壓力區</li>
    </ul>

    <h4>🔄 動態特性</h4>
    <p>分價量表會隨 K 線的<strong>縮放與平移即時重算</strong>，只統計目前可見範圍內的 K 線。拉長顯示範圍 = 看更長期的籌碼分布；縮短顯示範圍 = 只看近期的供需關係。</p>

    <h4>⚠️ 使用注意</h4>
    <ul>
      <li>PVD 是輔助視覺工具，不產生買賣訊號，需搭配其他技術指標判斷方向</li>
      <li>顯示範圍改變時（縮放/平移），分布會完全重算，同一支股票在不同顯示範圍下 POC 位置可能不同</li>
      <li>台股盤中成交量資料為即時更新，收盤後為最終數據</li>
    </ul>
  </article>

  <article class="ind-card">
    <h3>📋 基本面分析模組</h3>
    <p class="ind-tag">全視窗 Golden Board · 永遠啟用 · 需先載入財務資料</p>

    <h4>🎯 六大分析維度</h4>
    <ul>
      <li><strong>EPS（每股盈餘）</strong>：最新季數值 + 近4季走勢圖 + 連續成長/衰退偵測</li>
      <li><strong>EPS 年增率 + PEG</strong>：PEG = PE ÷ EPS成長率，&lt; 1 代表「便宜買到成長」</li>
      <li><strong>毛利率 / 淨利率</strong>：最新季 + 近4季趨勢（毛利率 ≥ 50% = 護城河）</li>
      <li><strong>PE / PB 估值</strong>：本益比 / 股價淨值比是否合理</li>
      <li><strong>殖利率</strong>：≥ 3% 為存股門檻，≥ 5% 存股首選</li>
      <li><strong>長線健康度</strong>：整合技術面 + 基本面的綜合評分（滿分 100）</li>
    </ul>

    <h4>📥 兩種載入方式</h4>
    <ul>
      <li><strong>推薦：</strong>進入全視窗 → 切到「基本面」Tab → 點「📥 載入基本面資料」按鈕 → 自動分析</li>
      <li><strong>或：</strong>先點下方「基本面」Tab 讓系統自動載入，再進入全視窗</li>
    </ul>

    <h4>⚠️ 使用注意</h4>
    <ul>
      <li><strong>需要 FinMind Token</strong>：請在設定中填入 Token，否則無法取得財務資料</li>
      <li><strong>季報有延遲</strong>：最晚在季度結束後 45 天公告，非即時</li>
      <li><strong>產業差異大</strong>：毛利率/PE 在電子業 vs 金融業 vs 傳產的評分標準不同</li>
      <li><strong>基本面決定長線，技術面決定進出場</strong>：兩者搭配效果最好</li>
    </ul>

    <h4>💡 與綜合報告整合</h4>
    <p>基本面結果自動整合進「綜合技術報告」，權重 × 2。若資料未載入，綜合報告會顯示提示，不影響其他指標評分。</p>
  </article>
`;
