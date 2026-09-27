import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('landing shell keeps imports direct and reader appearance separately scoped', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../css/landing.css', import.meta.url), 'utf8');
  assert.match(app, /if \(location.hash === '#import'\) \{\s+showReader\(\);\s+receiveFromBookmarklet\(\)/);
  assert.match(app, /if \(isLanding\(\)\) return;/);
  for (const id of ['btn-import', 'btn-library', 'btn-play', 'reader', 'home-resume']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} remains unique`);
  }
  assert.match(css, /body\.on-home > \.topbar/);
  assert.doesNotMatch(css, /^\.(word|controls)\s*\{/m);
});

test('home dialogs override the full reader palette, including control backgrounds', async () => {
  const css = await readFile(new URL('../css/landing.css', import.meta.url), 'utf8');
  const dialog = css.match(/^body\.on-home dialog \{([^}]+)\}/m)?.[1];
  assert.ok(dialog, 'dialog theme must stay scoped to the homepage');
  for (const [token, homeToken] of Object.entries({
    bg: 'paper', surface: 'surface', 'surface-2': 'paper',
    text: 'ink', muted: 'muted', line: 'line', accent: 'teal',
  })) {
    assert.match(dialog, new RegExp(`--${token}: var\\(--home-${homeToken}\\);`));
  }
  assert.match(css, /body\.on-home dialog \.seg input:checked \+ span \{ background: var\(--accent\); color: var\(--accent-ink\); \}/);
  assert.match(css, /body\[data-home-theme='dark'\]\.on-home dialog \{ color-scheme: dark; --accent-ink: #151817; \}/);
});
