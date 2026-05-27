/* js/help/help-xseries.js — X 系列獨家策略說明 */
export const helpXseries = `
  <article class="ind-card">
    <h3>🏆 X 系列獨家策略（X1-X5）</h3>
    <p class="ind-tag">實戰派選股系統 · 妖股識別 · 族群輪動 · 操作建議直達</p>

    <h4>🎯 X 系列是什麼？</h4>
    <p>X 系列是本系統獨家開發、經過台股實戰回測的選股策略組合。有別於傳統技術指標（如 KD/RSI）只描述「現象」，X 系列直接告訴你<strong>「這根K線該不該進場」</strong>，並附帶操作系統建議與歷史實證勝率。</p>
    <p>X1-X5 各有不同場景：最穩的三軸共振、最飆的妖股加速、抄底反彈、族群輪動、妖股早期介入，涵蓋多種市場環境。</p>

    <h4>📋 五個策略一覽</h4>
    <ul>
      <li>
        <strong>🪙 X1 黃金比例（三軸共振 · 最穩）</strong><br/>
        條件：RSI ≥ 60 + 量 ≥ 10日均量×2 + 站上MA20 + MA20連3天上升<br/>
        動能、量能、趨勢三個維度同時滿足，門檻嚴但雜訊低。適合等待穩健進場點，或等 X2 確認後成為最強組合。
      </li>
      <li>
        <strong>🌑 X2 天黑請閉眼（飆股加速 · 最飆）</strong><br/>
        條件：10日漲 ≥ 15% + 量 ≥ 30日均量×3 + RSI ≥ 70<br/>
        捕捉<strong>已經在飆的股票繼續飆</strong>。三個條件都是強勢延續標誌，進場後「閉眼」持有。實證：60天甜蜜點 +43.7%（整段抱長），是所有策略中期望報酬最高的。
      </li>
      <li>
        <strong>🪂 X3 炒底王（V型反轉 · 抄底）</strong><br/>
        條件：5日跌 ≥ 5% + RSI 從 &lt;30 反彈到 ≥35 + 量 ≥ 10日均量×1.2<br/>
        超跌後 RSI 從超賣區反彈，有量能配合的 V 型反轉初期。<em>目前為實驗策略，建議輕倉測試。</em>
      </li>
      <li>
        <strong>🚦 X4 何時輪到我（族群輪動 · 跨股）</strong><br/>
        條件：同族群 ≥2 檔 RSI>70 + 本股 RSI 40-60 + 量 ≥ 10日均量×1.5<br/>
        族群中強勢股先跑，本股還在橫盤等待輪動。需要有同族群資料才會觸發，適合跨股布局。<em>目前為實驗策略。</em>
      </li>
      <li>
        <strong>🚀 X5 量證明一切（妖股先期 · 早進場）</strong><br/>
        條件：量 ≥ 10日均量×2.5 + RSI ≥ 60 + 站上MA20 + MA20連2天上升<br/>
        比 X2 早 5-10 天觸發的妖股先期版。用近期相對爆量取代 X2 的長期均量倍率，不被前段大量拉高基期。實證：固定20天勝率 <strong>65.5%</strong>，報酬 +19.4%（X 系列中最高勝率）。
      </li>
    </ul>

    <h4>🔴 妖股等級</h4>
    <ul>
      <li><strong>🔴 強妖</strong>：X1+X2 或 X2+X5 雙確認 — 最強妖股訊號，適合系統A抱長</li>
      <li><strong>🟠 中妖</strong>：X2 單獨 — 標準飆股訊號</li>
      <li><strong>🟡 弱妖</strong>：X5 單獨 — 早期建倉，等待 X2 確認</li>
    </ul>

    <h4>💡 三個操作系統</h4>
    <ul>
      <li>
        <strong>系統A（最大化報酬）：X2 進場 → 抱長 60 天（S40 紅三兵出場）</strong><br/>
        預期報酬 +43.7%，需要極強耐心。期間回調 -10% 以內屬正常，不要出場。
        S40 紅三兵是所有策略的最佳出場規則，等不到就到期出場（60天後）。
      </li>
      <li>
        <strong>系統B快打（妖股先期）：X5 進場 → 固定 20 天出場</strong><br/>
        預期報酬 +19.4%，勝率 65.5%，快進快出。X2 若在此期間觸發可升級為系統A繼續持有。
      </li>
      <li>
        <strong>X1-watch（等待確認）：X1 觸發但無 X2 → 等待</strong><br/>
        X1 是前置訊號，配合 X2 才是最強妖股組合。等待 X2「天黑請閉眼」確認後再以系統A進場。
      </li>
    </ul>

    <h4>📊 實證數據（20檔 basket，1年回測）</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:4px 8px">策略</th>
          <th style="text-align:left;padding:4px 8px">出場方式</th>
          <th style="text-align:right;padding:4px 8px">勝率</th>
          <th style="text-align:right;padding:4px 8px">報酬</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid var(--border, #2a2d3a)">
          <td style="padding:4px 8px">🌑 X2 天黑</td>
          <td style="padding:4px 8px">S40 出場（~48天）</td>
          <td style="text-align:right;padding:4px 8px">60%</td>
          <td style="text-align:right;padding:4px 8px;color:#34d399">+43.7%</td>
        </tr>
        <tr style="border-bottom:1px solid var(--border, #2a2d3a)">
          <td style="padding:4px 8px">🚀 X5 量證明</td>
          <td style="padding:4px 8px">固定 20 天</td>
          <td style="text-align:right;padding:4px 8px;color:#34d399">65.5%</td>
          <td style="text-align:right;padding:4px 8px;color:#34d399">+19.4%</td>
        </tr>
        <tr style="border-bottom:1px solid var(--border, #2a2d3a)">
          <td style="padding:4px 8px">🚀 X5 量證明</td>
          <td style="padding:4px 8px">S40 出場（~56天）</td>
          <td style="text-align:right;padding:4px 8px">58.6%</td>
          <td style="text-align:right;padding:4px 8px;color:#34d399">+41.6%</td>
        </tr>
        <tr>
          <td style="padding:4px 8px;color:var(--muted)">🪂 X3 / 🚦 X4</td>
          <td colspan="3" style="padding:4px 8px;color:var(--muted)">實驗中，尚未完整回測</td>
        </tr>
      </tbody>
    </table>

    <h4>⚠️ 重要注意事項</h4>
    <ul>
      <li><strong>S40 ≠ 進場訊號</strong>：S40 紅三兵作為<em>出場</em>用時效果極佳（整段 +59.9%），但作為進場訊號時實證只有 +4.1%，完全相反方向。</li>
      <li><strong>X2 亮 = W6/W7 降權</strong>：飆股主升段必然觸發 W6（RSI>80）/W7（布林超買），但這是強勢延續而非空頭訊號。系統已自動調整妖股燈號。</li>
      <li><strong>X4 需要族群資料</strong>：若系統沒有同族群的 K 線資料，X4 不會觸發（不會 throw 錯誤，只是靜默不觸發）。</li>
      <li><strong>X1+X5（無 X2）≠ 妖股</strong>：這個組合歸類為「等待確認」而非妖股，不適合以系統A進場。</li>
    </ul>

    <h4>🔗 在哪裡看到 X 系列？</h4>
    <ul>
      <li><strong>個股全視窗 → X 系列 Tab</strong>：當前股票的所有 X 系列訊號狀態、連燈天數、SVG 示意圖與 AI 進出場建議</li>
      <li><strong>篩選器</strong>：可選擇 X1-X5 作為篩選條件，掃描全市場符合的股票</li>
      <li><strong>個股訊號 chip</strong>：個股頁訊號標籤中會顯示 X 系列有亮幾天</li>
      <li><strong>蒙地卡羅 → 操作建議</strong>：basket 掃描後依 X 系列訊號組合給出系統A/B建議</li>
    </ul>
  </article>
`;
