/* js/help/help-loader.js
 * 說明書 Modal 的內容載入器
 * 動態插入各 section 的 HTML，tab 切換時才渲染（節省首次載入時間）
 *
 * 新增說明分類步驟：
 *   1. 建立 js/help/help-xxx.js，export const helpXXX = `...`
 *   2. 在下方 import 並加進 SECTIONS
 *   3. 在 index.html modal tab 列加 <button data-tab="xxx">...</button>
 */
import { helpMA }         from './help-ma.js';
import { helpMomentum }   from './help-momentum.js';
import { helpTrend }      from './help-trend.js';
import { helpVolatility } from './help-volatility.js';
import { helpPattern }    from './help-pattern.js';
import { helpTools }      from './help-tools.js';
import { helpXseries }    from './help-xseries.js';

const SECTIONS = {
  ma:         helpMA,
  momentum:   helpMomentum,
  trend:      helpTrend,
  volatility: helpVolatility,
  pattern:    helpPattern,
  tools:      helpTools,
  xseries:    helpXseries,
};

// 已渲染過的 section（避免重複 innerHTML 操作）
const _rendered = new Set();

function _renderSection(key) {
  if (_rendered.has(key)) return;
  const el = document.querySelector(`.ind-help-section[data-section="${key}"]`);
  if (!el || !SECTIONS[key]) return;
  el.innerHTML = SECTIONS[key];
  _rendered.add(key);
}

export function initHelpModal() {
  const modal    = document.getElementById('indHelpModal');
  const helpBtn  = document.getElementById('indHelpBtn');
  const overlay  = document.getElementById('indHelpOverlay');
  const closeBtn = document.getElementById('indHelpClose');
  if (!modal || !helpBtn) return;

  // 開啟時渲染當前 active section
  function openHelp() {
    modal.classList.add('open');
    overlay?.classList.add('open');
    document.body.style.overflow = 'hidden';
    const activeTab = modal.querySelector('.ind-help-tab.active');
    if (activeTab) _renderSection(activeTab.dataset.tab);
  }
  function closeHelp() {
    modal.classList.remove('open');
    overlay?.classList.remove('open');
    document.body.style.overflow = '';
  }

  helpBtn.addEventListener('click', (e) => { e.stopPropagation(); openHelp(); });
  closeBtn?.addEventListener('click', closeHelp);
  overlay?.addEventListener('click', closeHelp);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeHelp();
  });

  // Tab 切換
  modal.querySelectorAll('.ind-help-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      modal.querySelectorAll('.ind-help-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      modal.querySelectorAll('.ind-help-section').forEach(s => s.classList.remove('active'));
      const section = modal.querySelector(`.ind-help-section[data-section="${target}"]`);
      if (section) {
        section.classList.add('active');
        _renderSection(target);
      }
      modal.querySelector('.ind-help-body').scrollTop = 0;
    });
  });

  // 首次開啟預渲染第一個 tab（ma）
  _renderSection('ma');
}
