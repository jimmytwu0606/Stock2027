/**
 * mobile-watchlist.js — Phase 10.1
 * 自選清單手機版：按群組，左右兩欄小卡
 * 每張小卡：代號 + 股名 + 股價 + 漲跌幅 + 迷你 K 線（SVG 折線）
 */

let _initialized = false;

export async function initMobileWatchlist() {
  if (_initialized) return;
  _initialized = true;

  const panel = document.getElementById('tabWatchlist');
  if (!panel) return;

  // header
  panel.innerHTML = `
    <div class="mwl-header">
      <span class="mwl-title">自選清單</span>
      <button class="mwl-refresh" id="mwlRefresh">⟳ 更新</button>
    </div>
    <div class="mwl-body" id="mwlBody">
      <div class="mwl-loading">載入中…</div>
    </div>
  `;

  document.getElementById('mwlRefresh')?.addEventListener('click', () => {
    document.getElementById('watchlistRescanAll')?.click();
    renderMobileWatchlist();
  });

  await renderMobileWatchlist();
}

export async function renderMobileWatchlist() {
  const body = document.getElementById('mwlBody');
  if (!body) return;

  const groups = window.__AppState?.watchlistGroups ?? [];
  if (!groups.length) {
    body.innerHTML = '<div class="mwl-empty">尚無自選股<br>請至看盤頁新增</div>';
    return;
  }

  const priceCache = window.__priceCache ?? {};

  // 取 kline 快取（給 sparkline 用）
  let klineMap = {};
  try {
    const { getAllKlineCache } = await import('../db.js');
    const all = await getAllKlineCache?.() ?? [];
    all.forEach(item => {
      if (item?.symbol && item?.candles?.length) {
        const code = item.symbol.replace('.TW', '').replace('.TWO', '');
        klineMap[code] = item.candles;
      }
    });
  } catch (e) {}

  let html = '';

  groups.forEach(group => {
    const stocks = group.stocks ?? [];
    if (!stocks.length) return;

    html += `<div class="mwl-group">
      <div class="mwl-group-name">${_esc(group.name ?? '未命名')}</div>
      <div class="mwl-grid">`;

    stocks.forEach(s => {
      const p = priceCache[s.code];
      const price  = p?.price  ?? s.price  ?? null;
      const chgPct = p?.chgPct ?? s.chgPct ?? null;
      const name   = s.name ?? s.code;
      const candles = klineMap[s.code] ?? [];
      const isUp   = (chgPct ?? 0) >= 0;
      const clr    = isUp ? '#ef5350' : '#26a69a';
      const priceTxt = price != null ? price.toFixed(2) : '—';
      const chgTxt   = chgPct != null
        ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`
        : '—';

      html += `
        <div class="mwl-card" data-code="${s.code}">
          <div class="mwl-card-top">
            <div class="mwl-card-info">
              <div class="mwl-code">${_esc(s.code)}</div>
              <div class="mwl-name">${_esc(name)}</div>
            </div>
            <div class="mwl-card-price">
              <div class="mwl-price" style="color:${clr}">${priceTxt}</div>
              <div class="mwl-chg" style="color:${clr}">${chgTxt}</div>
            </div>
          </div>
          <div class="mwl-spark">${_sparklineSVG(candles, clr)}</div>
        </div>`;
    });

    html += `</div></div>`;
  });

  body.innerHTML = html || '<div class="mwl-empty">尚無自選股</div>';

  // 點小卡進入個股
  body.querySelectorAll('.mwl-card').forEach(card => {
    card.addEventListener('click', () => {
      const code = card.dataset.code;
      if (code) window.__loadStock?.(code);
    });
  });
}

// ── SVG 迷你折線 ──────────────────────────────────────────────────────────
function _sparklineSVG(candles, color) {
  const pts = candles.slice(-20).map(c => c.close ?? c.value ?? 0);
  if (pts.length < 2) return '<svg width="100%" height="32"></svg>';

  const W = 120, H = 32, pad = 2;
  const min = Math.min(...pts), max = Math.max(...pts);
  const range = max - min || 1;

  const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / range) * (H - pad * 2);

  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
