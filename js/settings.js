/**
 * settings.js
 * 設定抽屜 UI
 *
 * export：
 *   initSettingsDrawer()
 *   openSettings()
 *   closeSettings()
 */

import { Config, saveConfig, resetConfig } from './config.js';
import { showToast } from './ui.js';

// 模組載入時把 Config 的人格句型同步到 window,讓 personas.js 立即可讀
(function _bootstrapPersonaLines() {
  const lines = Config.personasLines ?? {};
  window.__personasExtraLines = {};
  ['deng','niu','ga','aunt','quant'].forEach(id => {
    window.__personasExtraLines[id] = Array.isArray(lines[id]) ? lines[id] : [];
  });
})();

// 把 Config 同步到 window,給 personas.js 用
function _applyPersonaLinesToMemory() {
  const lines = Config.personasLines ?? {};
  window.__personasExtraLines = {};
  ['deng','niu','ga','aunt','quant'].forEach(id => {
    window.__personasExtraLines[id] = Array.isArray(lines[id]) ? lines[id] : [];
  });
}

export function openSettings() {
  _syncUIFromConfig();
  document.getElementById('settingsDrawer').classList.add('open');
  document.getElementById('settingsOverlay').classList.add('open');
}

export function closeSettings() {
  document.getElementById('settingsDrawer').classList.remove('open');
  document.getElementById('settingsOverlay').classList.remove('open');
}

function _syncUIFromConfig() {
  // 資料來源
  document.querySelectorAll('input[name="dataSource"]').forEach(r => {
    r.checked = r.value === Config.dataSource;
  });
  _toggleFinMindSection(Config.dataSource === 'finmind');

  // FinMind Token
  document.getElementById('finmindToken').value = Config.finmindToken ?? '';

  // 新聞來源
  document.querySelectorAll('input[name="newsSource"]').forEach(r => {
    r.checked = r.value === Config.newsSource;
  });

  // 批次請求
  document.getElementById('concurrencyVal').value        = Config.concurrency;
  document.getElementById('concurrencyDisplay').textContent = Config.concurrency;
  document.getElementById('screenerPeriod').value        = Config.screenerPeriod;

  // K線 Proxy 模式（走 localStorage，不走 Config）
  const kpSel = document.getElementById('klineProxyMode');
  if (kpSel) kpSel.value = localStorage.getItem('klineProxyMode') ?? 'auto';

  // 功能模組
  document.getElementById('modInstitutional').checked = Config.modules.institutionalBuySell;
  document.getElementById('modMargin').checked        = Config.modules.marginTrading;
  document.getElementById('modTechnical').checked     = Config.modules.technicalScreener;

  // 手機副圖
  document.querySelectorAll('input[name="mobileIndicator"]').forEach(r => {
    r.checked = r.value === Config.mobileDefaultIndicator;
  });

  // AI 圓桌已移至 personas-panel.js
}

function _toggleFinMindSection(show) {
  document.getElementById('finmindSection').style.display = show ? '' : 'none';
}

function _saveAll() {
  // 資料來源
  const dsRadio = document.querySelector('input[name="dataSource"]:checked');
  if (dsRadio) Config.dataSource = dsRadio.value;

  // FinMind Token
  Config.finmindToken = document.getElementById('finmindToken').value.trim();

  // 新聞來源
  const newsRadio = document.querySelector('input[name="newsSource"]:checked');
  if (newsRadio) Config.newsSource = newsRadio.value;

  // 批次請求
  Config.concurrency    = parseInt(document.getElementById('concurrencyVal').value, 10);
  Config.screenerPeriod = document.getElementById('screenerPeriod').value;

  // K線 Proxy 模式（走 localStorage，不走 Config）
  const kpSel = document.getElementById('klineProxyMode');
  if (kpSel) localStorage.setItem('klineProxyMode', kpSel.value);

  // 功能模組
  Config.modules.institutionalBuySell = document.getElementById('modInstitutional').checked;
  Config.modules.marginTrading        = document.getElementById('modMargin').checked;
  Config.modules.technicalScreener    = document.getElementById('modTechnical').checked;

  // 手機副圖
  const mobRadio = document.querySelector('input[name="mobileIndicator"]:checked');
  if (mobRadio) Config.mobileDefaultIndicator = mobRadio.value;


  saveConfig();
  showToast('✓ 設定已儲存');
  closeSettings();
}

export function initSettingsDrawer() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsOverlay').addEventListener('click', closeSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsSaveBtn').addEventListener('click', _saveAll);

  document.getElementById('settingsResetBtn').addEventListener('click', () => {
    if (!confirm('確定要還原所有設定為預設值？')) return;
    resetConfig();
    _syncUIFromConfig();
    showToast('✓ 已還原預設值');
  });

  document.querySelectorAll('input[name="dataSource"]').forEach(r => {
    r.addEventListener('change', () => _toggleFinMindSection(r.value === 'finmind'));
  });

  document.getElementById('concurrencyVal').addEventListener('input', e => {
    document.getElementById('concurrencyDisplay').textContent = e.target.value;
  });

  document.getElementById('tokenToggle').addEventListener('click', () => {
    const input = document.getElementById('finmindToken');
    const btn   = document.getElementById('tokenToggle');
    input.type  = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '顯示' : '隱藏';
  });

  // 從基本面面板的「設定 FinMind Token →」連結觸發
  document.addEventListener('openSettings', openSettings);

  // AI 圓桌人格管理已移至 personas-panel.js
}

// ════════════════════════════════════════════════════════
// AI 圓桌人格 Meta（export 給 personas-panel.js 使用）
// ════════════════════════════════════════════════════════
export const PERSONA_META = {
  deng:  { name: '燈燈', emoji: '🐱', sect: '動能派',
           desc: '俏皮台味,愛用「喵」字。看健康度/爆量,追強勢股,會主動押注。' },
  niu:   { name: '老牛', emoji: '🐂', sect: '價值派',
           desc: '沉穩老派,二十年股市。看 PE/PB/殖利率,反對追高,只買有實質獲利。' },
  ga:    { name: '嘎神', emoji: '⚡', sect: '當沖派',
           desc: '急躁衝動,看籌碼/法人/爆量,博消息面,只做極短線。' },
  aunt:  { name: '阿姨', emoji: '👵', sect: '保守派',
           desc: '碎念風格,二十年經驗。看大盤情俒,提醒風險,常勸退年輕人。' },
  quant: { name: '量子', emoji: '📊', sect: '量化派',
           desc: '冷靜客觀,只看統計/勝率/回測,不帶情緒,常吐槽其他人。' },
};

/** 解析 AI 回傳文字 → 句子陣列（export 給 personas-panel.js）*/
export function parseLinesFromText(text) {
  const t = String(text || '').trim();
  if (!t) return { lines: [], error: null };
  const cleaned = t.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\`\`\`\s*$/, '').trim();
  if (cleaned.startsWith('[') || cleaned.startsWith('{')) {
    try {
      const data = JSON.parse(cleaned);
      let arr;
      if (Array.isArray(data)) arr = data;
      else if (Array.isArray(data?.lines)) arr = data.lines;
      else if (Array.isArray(data?.sentences)) arr = data.sentences;
      else arr = Object.values(data).flat();
      const lines = arr.map(s => String(s ?? '').trim()).filter(Boolean);
      return { lines, error: null };
    } catch (e) {
      return { lines: [], error: 'JSON 格式錯誤:' + e.message };
    }
  }
  const lines = cleaned.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { lines, error: null };
}

/** 生成人格 Prompt（export 給 personas-panel.js）*/
export function buildPersonaPrompt(personaId) {
  const meta = PERSONA_META[personaId];
  if (!meta) return '';
  return `我有一個股市分析的 AI 圓桌系統,需要你扮演下面這個人格,寫 15 句自然口語的句型。

【人格設定】
名稱: ${meta.emoji} ${meta.name}
派別: ${meta.sect}
性格描述: ${meta.desc}

【寫作要求】
1. 每句要像「在 LINE 群組聊天」的口氣,不要像分析報告
2. 帶有這個人格的口頭禪、語氣、用字習慣
3. 句子可長可短(10~50 字都可),但要自然
4. 可使用以下變數(會被自動帶入數字):
   - {h} = 健康度(0~100)
   - {chgPct} = 漲跌幅(%)
   - {pe} = 本益比
5. 不需要每句都用變數,有些純口語的「口頭禪」也很好

【輸出格式】
請只回傳 JSON 陣列,不要其他說明文字:
\`\`\`json
[
  "句子1",
  "句子2",
  "句子3"
]
\`\`\`

請開始:`;
}

