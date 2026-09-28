const COOKIE = 'sajan-theme';
const DOMAIN = 'sajanacharya.com';
let transientTheme;

export function readTheme(legacyKey = 'theme') {
  if (transientTheme) return transientTheme;
  try {
    const saved = document.cookie.split('; ').find((value) => value.startsWith(`${COOKIE}=`))?.split('=')[1];
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {}
  try { return localStorage.getItem(legacyKey) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

export function saveTheme(theme, legacyKey = 'theme') {
  if (theme !== 'light' && theme !== 'dark') return;
  transientTheme = theme;
  try { localStorage.setItem(legacyKey, theme); transientTheme = undefined; } catch {}
  if (location.hostname === DOMAIN || location.hostname.endsWith(`.${DOMAIN}`)) {
    document.cookie = `${COOKIE}=${theme}; Domain=${DOMAIN}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
  }
  window.dispatchEvent(new Event('themechange'));
}
