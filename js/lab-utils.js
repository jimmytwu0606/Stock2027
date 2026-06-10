/**
 * lab-utils.js — 策略實驗室共用工具
 * 由各子模組 import
 */

export function resolveCode(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();
  return /^\d{4,6}$/.test(s) ? s : null;
}

export function tsToDate(ts) {
  if (!ts) return '—';
  if (typeof ts === 'string') return ts.replace(/-/g, '/').slice(0, 10);
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

export function checkProLimit(key) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved?.date === today && saved.count >= 1) return false;
  } catch {}
  return true;
}

export function consumeProLimit(key) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    const count = (saved?.date === today ? saved.count : 0) + 1;
    localStorage.setItem(key, JSON.stringify({ date: today, count }));
  } catch {}
}

export const COMPARE_STRATEGIES = [
  'X1','X2','X3','X4','X5','X6',
  'XG1','XG3',
  'S1','S2','S3','S_STRONG','S4','S5',
  'S6','S7','S8','S9',
  'S10','S11','S12',
  'S20','S21','S22','S23',
  'S13','S14','S15',
  'S16','S17','S18','S19',
  'S24','S25','S26','S27',
  'S29','S30','S31','S32','S33','S34','S35','S36',
  'S_ICHI_3GOOD','S_ICHI_CLOUD','S_ICHI_TK_CROSS',
  'S37','S38','S40','S42','S45',
];
