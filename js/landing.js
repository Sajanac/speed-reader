import { readTheme, saveTheme } from '../brand/theme.js';
import { mountElasticUnderlines } from '../brand/elastic.js';

const body = document.body;
const themeButton = document.getElementById('home-theme');
let theme = readTheme('sajan-landing-theme');
function applyTheme() {
  body.dataset.homeTheme = theme;
  themeButton.dataset.themeState = theme;
  themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
  themeButton.setAttribute('aria-label', `Use ${theme === 'dark' ? 'light' : 'dark'} theme`);
  themeButton.title = themeButton.getAttribute('aria-label');
}
applyTheme();
themeButton.addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  applyTheme();
  saveTheme(theme, 'sajan-landing-theme');
});
for (const event of ['focus', 'pageshow']) window.addEventListener(event, () => {
  theme = readTheme('sajan-landing-theme');
  applyTheme();
});
mountElasticUnderlines(document.querySelector('.brand-header-inner'), '.elastic-nav-label');
mountElasticUnderlines(document.querySelector('.brand-footer .brand-shell'));
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
