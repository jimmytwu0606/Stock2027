/**
 * mobile-settings.js — Phase 10.1
 * 設定頁：複製 settings-drawer 內容，獨立頁面渲染
 */

let _initialized = false;

export function initMobileSettings() {
  if (_initialized) return;
  _initialized = true;
  _buildSettingsPage();
}

function _buildSettingsPage() {
  if (document.getElementById('tabMobileSettings')) return;

  const drawer = document.getElementById('settingsDrawer');
  if (!drawer) return;

  const panel = document.createElement('div');
  panel.id = 'tabMobileSettings';
  panel.className = 'tab-panel';

  const header = document.createElement('div');
  header.className = 'msettings-header';
  header.innerHTML = '<span>⚙ 系統設定</span>';
  panel.appendChild(header);

  const body = drawer.querySelector('.drawer-body')?.cloneNode(true);
  if (body) panel.appendChild(body);

  const footer = drawer.querySelector('.drawer-footer')?.cloneNode(true);
  if (footer) {
    panel.appendChild(footer);
    // 橋接按鈕到原始 drawer 的事件
    panel.querySelector('[id$="SaveBtn"]')?.addEventListener('click', () =>
      document.getElementById('settingsSaveBtn')?.click());
    panel.querySelector('[id$="ResetBtn"]')?.addEventListener('click', () =>
      document.getElementById('settingsResetBtn')?.click());
  }

  document.querySelector('main.main')?.appendChild(panel);
}
