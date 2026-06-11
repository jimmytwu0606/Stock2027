/**
 * api-news.js — 新聞 RSS / MOPS 公告
 */
import { getNewsSource } from './config.js';
import { fetchWithProxy } from './api-core.js';


// ─────────────────────────────────────────────
// 新聞：依設定切換來源
//
// yahootw     → Yahoo 奇摩股市 RSS（中文）
// googlenews  → Google News RSS（中文，搜尋股票名稱）
// yahoofinance→ Yahoo Finance search API（英文）
// ─────────────────────────────────────────────
export async function fetchNews(symbol, stockName = '') {
  const source = getNewsSource();
  try {
    switch (source) {
      case 'googlenews':   return await _newsGoogleNews(stockName || symbol);
      case 'yahoofinance': return await _newsYahooFinance(symbol);
      default:             return await _newsYahooTW(symbol);
    }
  } catch (e) {
    console.warn('[api] fetchNews failed:', e.message);
    return [];
  }
}

// Yahoo 奇摩股市 RSS
async function _newsYahooTW(symbol) {
  // 去掉 .TW / .TWO 後綴取純代號
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const url  = `https://tw.stock.yahoo.com/rss?s=${code}`;
  const text = await fetchWithProxy(url, 8000);
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'text/xml');
  const items  = doc.querySelectorAll('item');
  return Array.from(items).slice(0, 20).map(item => ({
    title:       item.querySelector('title')?.textContent?.trim() ?? '',
    link:        item.querySelector('link')?.textContent?.trim()  ?? '',
    publisher:   'Yahoo 奇摩',
    publishTime: _rssDateToEpoch(item.querySelector('pubDate')?.textContent),
  })).filter(n => n.title);
}

// Google News RSS
async function _newsGoogleNews(query) {
  const q   = encodeURIComponent(`${query} 股票`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const text = await fetchWithProxy(url, 8000);
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'text/xml');
  const items  = doc.querySelectorAll('item');
  return Array.from(items).slice(0, 20).map(item => ({
    title:       item.querySelector('title')?.textContent?.trim() ?? '',
    link:        item.querySelector('link')?.textContent?.trim()  ?? '',
    publisher:   item.querySelector('source')?.textContent?.trim() ?? 'Google News',
    publishTime: _rssDateToEpoch(item.querySelector('pubDate')?.textContent),
  })).filter(n => n.title);
}

// Yahoo Finance Search API（英文）
async function _newsYahooFinance(symbol) {
  const url  = `https://query1.finance.yahoo.com/v1/finance/search` +
               `?q=${encodeURIComponent(symbol)}&newsCount=20&quotesCount=0`;
  const text = await fetchWithProxy(url);
  const data = JSON.parse(text);
  return (data?.news ?? []).map(n => ({
    title:       n.title,
    link:        n.link,
    publisher:   n.publisher,
    publishTime: n.providerPublishTime,
  }));
}

function _rssDateToEpoch(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : Math.floor(d.getTime() / 1000);
}

// ─────────────────────────────────────────────
// TWSE 公告
// ─────────────────────────────────────────────
export async function fetchAnnouncements(code) {
  try {
    const url  = `https://mops.twse.com.tw/mops/web/ajax_t05st01` +
                 `?encodeURIComponent=1&step=1&firstin=1&off=1` +
                 `&keyword4=&code1=&TYPEK2=&checkbtn=&queryName=co_id` +
                 `&inpuType=co_id&TYPEK=all&isnew=false&co_id=${code}&keyword2=`;
    const text = await fetchWithProxy(url, 10000);
    const parser = new DOMParser();
    const doc    = parser.parseFromString(text, 'text/html');
    const rows   = doc.querySelectorAll('table.hasBorder tr');
    const result = [];
    rows.forEach((row, i) => {
      if (i === 0) return;
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) return;
      const date    = cells[0]?.textContent?.trim();
      const subject = cells[2]?.textContent?.trim();
      const href    = cells[2]?.querySelector('a')?.href ?? '';
      if (date && subject) result.push({ date, subject, url: href });
    });
    return result.slice(0, 20);
  } catch (e) {
    console.warn('[api] fetchAnnouncements failed:', e.message);
    return [];
  }
}
