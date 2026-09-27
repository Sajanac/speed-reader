const body = document.body;
const themeButton = document.getElementById('home-theme');
let theme = 'light';
try { theme = localStorage.getItem('sajan-landing-theme') || 'light'; } catch {}
function applyTheme() {
  body.dataset.homeTheme = theme;
  themeButton.setAttribute('aria-label', `Use ${theme === 'dark' ? 'light' : 'dark'} theme`);
  themeButton.title = themeButton.getAttribute('aria-label');
}
applyTheme();
themeButton.addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  applyTheme();
  try { localStorage.setItem('sajan-landing-theme', theme); } catch {}
});
for (const button of document.querySelectorAll('[data-reader-action]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.readerAction).click());
}
export function isLanding() { return body.classList.contains('on-home'); }
export function showReader() {
  body.classList.remove('on-home');
}
export function showLanding(meta) {
  body.classList.add('on-home');
  document.title = 'Speed Reader · Sajan Acharya';
  document.getElementById('reader-continue').hidden = !meta;
  document.getElementById('resume-title').textContent = meta?.title || '';
}
