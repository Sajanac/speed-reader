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
