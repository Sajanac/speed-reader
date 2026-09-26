// End-to-end checks in headless Chromium. Run: npm run test:e2e
// Set CHROMIUM_PATH to use a specific Chromium build.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const APP = 'http://127.0.0.1:8123/';
const SITE = 'http://localhost:8124/';
const COOP_SITE = 'http://localhost:8125/';
const shots = process.env.SHOTS_DIR;

const servers = [
  spawn('node', [path.join(here, 'serve.mjs'), root, '8123']),
  spawn('node', [path.join(here, 'serve.mjs'), path.join(here, 'fixtures'), '8124']),
  spawn('node', [path.join(here, 'serve.mjs'), path.join(here, 'fixtures'), '8125', 'coop']),
];
await new Promise((r) => setTimeout(r, 400));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('ok  ', name);
  } catch (err) {
    results.push(['FAIL', name]);
    console.log('FAIL', name, '\n    ', err.message.split('\n').slice(0, 6).join('\n     '));
  }
}

// Fake Web Speech API: speaks at 180 wpm x rate and fires word boundaries.
const speechMock = () => {
  const voices = [
    { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.samantha', default: true, localService: true },
    { name: 'Ava (Premium)', lang: 'en-US', voiceURI: 'com.apple.ava.premium', default: false, localService: true },
    { name: 'Bells', lang: 'en-US', voiceURI: 'com.apple.bells', default: false, localService: true },
  ];
  window.__spoken = [];
  // Safari 16.4+ Audio Session API (not in Chromium).
  Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true });
  let queue = [];
  let current = null;
  let timers = [];
  const run = () => {
    if (current || !queue.length) return;
    current = queue.shift();
    const u = current;
    synth.speaking = true;
    window.__spoken.push({ text: u.text, rate: u.rate, voice: u.voice && u.voice.name });
    u.onstart && u.onstart({});
    const per = 60000 / (180 * u.rate);
    const re = /\S+/g;
    let m;
    let k = 0;
    while ((m = re.exec(u.text))) {
      const ci = m.index;
      timers.push(setTimeout(() => u.onboundary && u.onboundary({ name: 'word', charIndex: ci }), k * per));
      k++;
    }
    timers.push(
      setTimeout(() => {
        current = null;
        synth.speaking = false;
        u.onend && u.onend({});
        run();
      }, k * per),
    );
  };
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => voices,
    speak(u) {
      queue.push(u);
      run();
    },
    cancel() {
      timers.forEach(clearTimeout);
      timers = [];
      const c = current;
      current = null;
      queue = [];
      synth.speaking = false;
      if (c && c.onerror) c.onerror({ error: 'interrupted' });
    },
    pause() {},
    resume() {},
    addEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
      this.rate = 1;
    }
  };
};

async function newPage(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(speechMock);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('    pageerror:', e.message));
  return { context, page };
}

const state = (page) =>
  page.evaluate(() => ({
    pivot: document.getElementById('w-pivot').textContent,
    word: document.getElementById('word').textContent,
    title: document.getElementById('doc-title').textContent,
    scrub: Number(document.getElementById('scrub').value),
    max: Number(document.getElementById('scrub').max),
    wpm: document.getElementById('wpm-label').textContent,
  }));

// Horizontal offset of the pivot letter's centre from the reader's centre,
// and whether the rendered word text fits inside the reader box.
const alignment = (page) =>
  page.evaluate(() => {
    const r = document.getElementById('reader').getBoundingClientRect();
    const rect = (id) => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id));
      return range.getBoundingClientRect();
    };
    const p = rect('w-pivot');
    const b = rect('w-before');
    const a = rect('w-after');
    return {
      offset: p.left + p.width / 2 - (r.left + r.width / 2),
      fits: (b.width === 0 || b.left >= r.left - 1) && (a.width === 0 || a.right <= r.right + 1),
    };
  });

const noDialogs = (page) => page.waitForFunction(() => !document.querySelector('dialog[open]'));

async function loadSample(page) {
  await page.click('#btn-import');
  await page.click('#btn-sample');
  await page.waitForFunction(() => document.getElementById('doc-title').textContent.startsWith('Sample'));
  await noDialogs(page);
}

async function loadText(page, text) {
  await page.click('#btn-import');
  await page.fill('#paste-text', text);
  await page.click('#btn-read-paste');
  await page.waitForFunction(() => !document.getElementById('dlg-import').open);
}

const { context, page } = await newPage();
await page.goto(APP);

await step('empty state shows placeholder', async () => {
  const s = await state(page);
  assert.match(s.word, /import/i);
  assert.equal(await page.isDisabled('#btn-play'), true);
});

await step('claims "playback" audio so the iPhone silent switch does not mute speech', async () => {
  assert.equal(await page.evaluate(() => navigator.audioSession.type), 'playback');
});

await step('sample loads', async () => {
  await loadSample(page);
  const s = await state(page);
  assert.equal(s.word, 'Rapid');
  assert.equal(s.pivot, 'a');
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-paused.png') });
});

const LONG = 'I a be the word reading understand incomprehensibility "Hello," world. antidisestablishmentarianism supercalifragilisticexpialidocious (parenthetical) café naïve';

for (const font of ['sans', 'serif', 'mono']) {
  await step(`ORP letter centred on crosshair (${font})`, async () => {
    await page.evaluate((f) => {
      document.body.dataset.font = f;
    }, font);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await loadText(page, LONG);
    const n = (await state(page)).max + 1;
    for (let i = 0; i < n; i++) {
      await page.evaluate((v) => {
        const s = document.getElementById('scrub');
        s.value = v;
        s.dispatchEvent(new Event('input'));
        s.dispatchEvent(new Event('change'));
      }, i);
      const a = await alignment(page);
      const s = await state(page);
      assert.ok(Math.abs(a.offset) < 0.75, `word "${s.word}" pivot off by ${a.offset.toFixed(2)}px`);
      assert.ok(a.fits, `word "${s.word}" overflows the box`);
    }
  });
}

await step('pivot letters follow the ORP table', async () => {
  await page.evaluate(() => (document.body.dataset.font = 'sans'));
  await loadText(page, 'a be the word reading understand incomprehensibility world.');
  const pivots = [];
  for (let i = 0; i < 8; i++) {
    await page.evaluate((v) => {
      const s = document.getElementById('scrub');
      s.value = v;
      s.dispatchEvent(new Event('input'));
    }, i);
    const html = await page.evaluate(() => [document.getElementById('w-before').textContent, document.getElementById('w-pivot').textContent]);
    pivots.push(html.join('|'));
  }
  assert.deepEqual(pivots, ['|a', 'b|e', 't|h', 'w|o', 're|a', 'und|e', 'inco|m', 'w|o']);
});

await step('timing: base interval and punctuation dwell', async () => {
  await loadText(page, 'one two three, four five. six seven eight nine ten');
  await page.evaluate(() => {
    const s = document.getElementById('wpm');
    s.value = 600;
    s.dispatchEvent(new Event('input'));
  });
  const times = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const log = [];
        const pivot = document.getElementById('word');
        const obs = new MutationObserver(() => log.push([document.getElementById('word').textContent, performance.now()]));
        obs.observe(pivot, { subtree: true, characterData: true, childList: true });
        document.getElementById('btn-play').click();
        setTimeout(() => {
          obs.disconnect();
          document.getElementById('btn-play').click();
          resolve(log);
        }, 1500);
      }),
  );
  // Collapse repeated mutations for the same word.
  const seq = times.filter((t, i) => i === 0 || t[0] !== times[i - 1][0]);
  const dur = (w) => {
    const i = seq.findIndex((t) => t[0] === w);
    return seq[i + 1][1] - seq[i][1];
  };
  const near = (v, want) => assert.ok(Math.abs(v - want) < 35, `expected ~${want}ms, got ${v.toFixed(0)}ms`);
  near(dur('two'), 100);
  near(dur('three,'), 150);
  near(dur('five.'), 200);
  near(dur('six'), 100);
});

await step('reading view hides everything but the word; tap pauses', async () => {
  await loadSample(page);
  const vis = () =>
    page.evaluate(() =>
      ['.topbar', '.controls', '.status', '#context'].map((s) => getComputedStyle(document.querySelector(s)).visibility),
    );
  const box = () => page.evaluate(() => JSON.stringify(document.getElementById('reader').getBoundingClientRect()));
  const before = await box();
  await page.click('#btn-play');
  await page.waitForTimeout(400);
  assert.deepEqual(await vis(), ['hidden', 'hidden', 'hidden', 'hidden']);
  const guides = await page.evaluate(() => getComputedStyle(document.querySelector('.guide-top')).visibility);
  assert.equal(guides, 'visible');
  assert.equal(await box(), before, 'reader moved when controls hid');
  const i = (await state(page)).scrub;
  assert.ok(i > 0, 'did not advance');
  await page.mouse.click(1200, 700); // where the hidden controls were
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.body.classList.contains('reading')), false);
  const [top, controls] = await vis();
  assert.equal(top, 'visible');
  assert.equal(controls, 'visible');
  const j = (await state(page)).scrub;
  await page.waitForTimeout(300);
  assert.equal((await state(page)).scrub, j, 'kept playing after tap');
  if (shots) {
    await page.click('#btn-play');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'desktop-reading.png') });
    await page.mouse.click(640, 120);
  }
});

await step('rewind 10 and forward 10', async () => {
  await loadSample(page);
  await page.evaluate(() => {
    const s = document.getElementById('scrub');
    s.value = 40;
    s.dispatchEvent(new Event('input'));
  });
  await page.click('#btn-back');
  assert.equal((await state(page)).scrub, 30);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal((await state(page)).scrub, 50);
  await page.click('#btn-back');
  await page.click('#btn-back');
  await page.click('#btn-back');
  await page.click('#btn-back');
  await page.click('#btn-back');
  await page.click('#btn-back');
  assert.equal((await state(page)).scrub, 0);
});

await step('progress and WPM persist across reload', async () => {
  await page.evaluate(() => {
    const s = document.getElementById('scrub');
    s.value = 57;
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
    const w = document.getElementById('wpm');
    w.value = 450;
    w.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('doc-title').textContent.startsWith('Sample'));
  const s = await state(page);
  assert.equal(s.scrub, 57);
  assert.equal(s.wpm, '450 wpm');
});

await step('re-importing the same text resumes', async () => {
  await loadSample(page);
  assert.equal((await state(page)).scrub, 57);
});

await step('library lists documents and opens them', async () => {
  await page.click('#btn-library');
  await page.waitForFunction(() => document.getElementById('dlg-library').open);
  const items = await page.$$eval('#library-list .t', (els) => els.map((e) => e.textContent));
  assert.ok(items.some((t) => t.startsWith('Sample')), items.join(', '));
  assert.ok(items.length >= 3);
  await page.click('#library-list li:nth-child(2) .open');
  await page.waitForFunction(() => !document.getElementById('dlg-library').open);
});

// File imports.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-'));
const txtPath = path.join(tmp, 'notes.txt');
fs.writeFileSync(txtPath, 'Plain text file.\n\nSecond paragraph here.');

const epubPath = path.join(tmp, 'book.epub');
{
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav>Contents</nav></body></html>');
  zip.file('OEBPS/text/ch1.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head><body><h1>Chapter Two</h1><p>Later text.</p></body></html>');
  zip.file('OEBPS/text/ch2.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c2</title></head><body><h1>Chapter One</h1><p>First <em>chapter</em> text.</p><p>Another paragraph.</p></body></html>');
  fs.writeFileSync(epubPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

const pdfPath = path.join(tmp, 'paper.pdf');
{
  const pdf = await PDFDocument.create();
  pdf.setTitle('Test Paper');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([400, 400]);
  p1.drawText('The first line of a para-', { x: 40, y: 340, size: 12, font });
  p1.drawText('graph continues here.', { x: 40, y: 325, size: 12, font });
  p1.drawText('A new paragraph starts.', { x: 40, y: 290, size: 12, font });
  p1.drawText('1', { x: 200, y: 20, size: 10, font });
  const p2 = pdf.addPage([400, 400]);
  p2.drawText('Second page text.', { x: 40, y: 340, size: 12, font });
  fs.writeFileSync(pdfPath, await pdf.save());
}

const readAll = (page) =>
  page.evaluate(async () => {
    const out = [];
    const s = document.getElementById('scrub');
    for (let i = 0; i <= Number(s.max); i++) {
      s.value = i;
      s.dispatchEvent(new Event('input'));
      out.push(document.getElementById('word').textContent);
    }
    return out.join(' ');
  });

async function importFile(file, title) {
  await page.click('#btn-import');
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction((t) => document.getElementById('doc-title').textContent === t, title, { timeout: 15000 });
  await noDialogs(page);
}

await step('import .txt', async () => {
  await importFile(txtPath, 'notes');
  assert.equal(await readAll(page), 'Plain text file. Second paragraph here.');
});

await step('import .epub (spine order, skips nav)', async () => {
  await importFile(epubPath, 'Test Book');
  assert.equal(await readAll(page), 'Chapter One First chapter text. Another paragraph. Chapter Two Later text.');
});

await step('import .pdf (joins hyphenation, drops page numbers)', async () => {
  await importFile(pdfPath, 'Test Paper');
  assert.equal(await readAll(page), 'The first line of a paragraph continues here. A new paragraph starts. Second page text.');
});

await step('read aloud: voice drives words, WPM sets rate, pause cancels', async () => {
  await loadSample(page);
  await page.evaluate(() => {
    const s = document.getElementById('scrub');
    s.value = 0;
    s.dispatchEvent(new Event('input'));
    const w = document.getElementById('wpm');
    w.value = 450;
    w.dispatchEvent(new Event('input'));
  });
  await page.click('#btn-voice');
  assert.equal(await page.getAttribute('#btn-voice', 'aria-pressed'), 'true');
  await page.click('#btn-play');
  await page.waitForTimeout(1200);
  const mid = await state(page);
  const spoken = await page.evaluate(() => window.__spoken);
  assert.equal(spoken[0].text.split(' ')[0], 'Rapid');
  assert.equal(spoken[0].rate, 2.5); // 450 / 180
  assert.equal(spoken[0].voice, 'Ava (Premium)'); // best quality voice by default
  // 450 wpm => 7.5 words/s, so ~9 words in 1.2s.
  assert.ok(mid.scrub >= 6 && mid.scrub <= 12, `index ${mid.scrub}`);
  // Controls are hidden while reading; tap anywhere to pause.
  await page.mouse.click(640, 120);
  const paused = (await state(page)).scrub;
  await page.waitForTimeout(500);
  assert.equal((await state(page)).scrub, paused, 'kept advancing after pause');
  const status = await page.textContent('#status');
  assert.match(status, /Reading aloud/);
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-read-aloud.png') });
  await page.click('#btn-voice');
});

await step('voice list hides novelty voices, prefers user language', async () => {
  await page.click('#btn-settings');
  const opts = await page.$$eval('#voice-select option', (o) => o.map((x) => x.textContent));
  assert.deepEqual(opts, ['Ava (Premium) (en-US)', 'Samantha (en-US)']);
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-settings.png') });
  await page.keyboard.press('Escape');
});

async function runBookmarklet(site) {
  const href = await page.getAttribute('#bm-link', 'href');
  const code = decodeURIComponent(href.slice('javascript:'.length));
  const article = await context.newPage();
  await article.goto(site + 'article.html');
  const popupPromise = context.waitForEvent('page');
  await article.evaluate(code);
  const popup = await popupPromise;
  return { article, popup };
}

await step('bookmarklet sends article across origins', async () => {
  const { article, popup } = await runBookmarklet(SITE);
  await popup.waitForFunction(() => document.getElementById('doc-title').textContent === 'The Quiet Lighthouse', null, { timeout: 10000 });
  const text = await readAll(popup);
  assert.ok(text.startsWith('The Quiet Lighthouse'), text.slice(0, 80));
  assert.match(text, /keeper still climbs its stairs/);
  assert.doesNotMatch(text, /Buy one get one|Cookie settings|Sports/);
  assert.equal(popup.url(), APP);
  if (shots) {
    await popup.setViewportSize({ width: 390, height: 844 });
    await popup.screenshot({ path: path.join(shots, 'bookmarklet-result.png') });
  }
  await popup.close();
  await article.close();
});

await step('bookmarklet falls back to copy banner when COOP blocks hand-off', async () => {
  const { article, popup } = await runBookmarklet(COOP_SITE);
  await popup.waitForFunction(() => /No page was received/.test(document.getElementById('word').textContent), null, { timeout: 5000 });
  await article.waitForFunction(() => [...document.querySelectorAll('div')].some((d) => d.shadowRoot && /could not receive/.test(d.shadowRoot.textContent)), null, { timeout: 12000 });
  await popup.close();
  await article.close();
});

await step('embed.js button on a blog opens the article in the reader', async () => {
  const blog = await context.newPage();
  await blog.goto(SITE + 'blog.html');
  await blog.waitForFunction(() => window.SpeedReader);
  const popupPromise = context.waitForEvent('page');
  await blog.click('[data-speed-read]');
  const popup = await popupPromise;
  await popup.waitForFunction(() => document.getElementById('doc-title').textContent === 'Why I Walk', null, { timeout: 10000 });
  const text = await readAll(popup);
  assert.ok(text.startsWith('Why I Walk Every morning before rounds'), text.slice(0, 80));
  assert.match(text, /can wait\.$/);
  assert.doesNotMatch(text, /Speed read this|Subscribe|All rights|Contact/);
  await popup.close();
  await blog.close();
});

await step('phone layout', async () => {
  const phone = await newPage({ width: 390, height: 844 });
  await phone.page.goto(APP);
  await loadSample(phone.page);
  await phone.page.evaluate(() => {
    const s = document.getElementById('scrub');
    s.value = 12;
    s.dispatchEvent(new Event('input'));
  });
  const a = await alignment(phone.page);
  assert.ok(Math.abs(a.offset) < 0.75 && a.fits);
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'horizontal scroll on phone');
  if (shots) await phone.page.screenshot({ path: path.join(shots, 'phone.png') });
  await phone.context.close();
});

await browser.close();
servers.forEach((s) => s.kill());
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
