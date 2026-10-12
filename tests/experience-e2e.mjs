// Integration checks for read-along, listening, prepared audio, and documents.
// Run: CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/experience-e2e.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pcmToWav } from '../js/natural-voice.js';
import { buildDoc } from '../js/text.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = http.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const server = spawn(process.execPath, [path.join(root, 'tests/serve.mjs'), root, String(port)], { stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-experience-'));
const screenshots = path.join(root, 'test-results');
await fs.mkdir(screenshots, { recursive: true });
let browser;
let failures = 0;

// Keep device speech deterministic while native HTML audio retains its real
// playback clock. The media session mock exposes system actions for testing.
function installDeviceMocks() {
  const voices = [{ name: 'Ava (Premium)', lang: 'en-US', voiceURI: 'test-ava', default: true, localService: true }];
  window.__spoken = [];
  window.__mediaActions = {};
  let timers = [], generation = 0;
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => voices,
    addEventListener() {},
    cancel() {
      generation++;
      timers.forEach(clearTimeout);
      timers = [];
      synth.speaking = false;
      synth.pending = false;
    },
    pause() { synth.paused = true; },
    resume() { synth.paused = false; },
    speak(utterance) {
      const current = generation;
      synth.speaking = true;
      const interval = 180 / (utterance.rate || 1);
      const tokens = [...utterance.text.matchAll(/\S+/g)];
      window.__spoken.push({ text: utterance.text, rate: utterance.rate, voice: utterance.voice?.name });
      utterance.onstart?.({});
      tokens.forEach((token, i) => timers.push(setTimeout(() => {
        if (current === generation) utterance.onboundary?.({ name: 'word', charIndex: token.index });
      }, i * interval)));
      timers.push(setTimeout(() => {
        if (current !== generation) return;
        synth.speaking = false;
        utterance.onend?.({});
      }, tokens.length * interval));
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.rate = 1; } };
  Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true });
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null, playbackState: 'none',
      setActionHandler(name, action) { window.__mediaActions[name] = action; },
      setPositionState(state) { window.__mediaPosition = state; },
    },
  });
}

async function newPage(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript(installDeviceMocks);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#btn-play') && !document.querySelector('dialog[open]'));
  return { context, page, errors };
}

async function step(name, action) {
  try {
    await action();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}

async function openImport(page) {
  await page.locator('#btn-import:visible, [data-reader-action="btn-import"]:visible').first().click();
  await page.waitForSelector('#dlg-import[open]');
}

async function loadText(page, text) {
  await openImport(page);
  await page.fill('#paste-text', text);
  await page.click('#btn-read-paste');
  await page.waitForFunction(() => !document.querySelector('#dlg-import[open]') && !document.querySelector('#btn-play').disabled);
}

async function loadFile(page, file) {
  await openImport(page);
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => !document.querySelector('#dlg-import[open]') && !document.querySelector('#btn-play').disabled);
}

async function closeDialog(page, id) {
  await page.locator(`#${id} .dlg-head button[aria-label="Close"]`).click();
  await page.waitForFunction((dialogId) => !document.getElementById(dialogId).open, id);
}

async function setRange(page, id, value) {
  await page.locator(`#${id}`).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function usableControls(page) {
  const state = await page.locator('#btn-play').evaluate((button) => {
    const style = getComputedStyle(button);
    const parent = getComputedStyle(button.closest('.controls'));
    return { hidden: style.visibility === 'hidden' || parent.visibility === 'hidden', opacity: Number(parent.opacity), pointerEvents: parent.pointerEvents };
  });
  assert.equal(state.hidden, false, 'Playback controls remain visible');
  assert.ok(state.opacity > 0.9, 'Playback controls remain readable');
  assert.notEqual(state.pointerEvents, 'none', 'Playback controls remain interactive');
}

async function selectWords(page, start, end) {
  return page.evaluate(async ({ start, end }) => {
    const { buildDoc } = await import('/js/text.js');
    const content = document.querySelector('#immersive-reader .immersive-content');
    const text = content.textContent;
    const words = buildDoc(text).words;
    const find = (position) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let offset = 0, node;
      while ((node = walker.nextNode())) {
        if (position <= offset + node.length) return { node, offset: position - offset };
        offset += node.length;
      }
      throw new Error('Selection location missing');
    };
    const first = find(words[start].s);
    const last = find(words[end - 1].s + words[end - 1].t.length);
    document.getSelection().setBaseAndExtent(first.node, first.offset, last.node, last.offset);
    return words.slice(start, end).map((word) => word.t).join(' ');
  }, { start, end });
}

const READING_TEXT = 'A quiet paragraph makes room for careful reading and a voice that feels familiar.\n\nChoose a favorite highlight and follow the words as each sentence moves across the page.\n\nYou can pause, browse another paragraph, or continue listening at your own pace.';

function readingPackage(timing = 'word') {
  const text = 'One two three four five six.\n\nSeven eight nine ten eleven twelve.';
  const duration = 2.4;
  const wav = Buffer.from(pcmToWav(new Float32Array(Math.round(8000 * duration)), 8000));
  const audio = `data:audio/wav;base64,${wav.toString('base64')}`;
  const chunks = [0, 6].map((from) => ({
    from, to: from + 6, audio, duration, timing,
    timings: timing === 'sentence' ? [{ index: from, start: 0, end: duration }]
      : Array.from({ length: 6 }, (_, i) => ({ index: from + i, start: i * 0.4, end: (i + 1) * 0.4 })),
  }));
  return {
    name: `${timing}.readalong`, mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ type: 'reader-audio-package', version: 1,
      metadata: { title: `Prepared ${timing} reading`, source: 'text' },
      manifest: { version: 1, text, engine: timing === 'sentence' ? 'browser' : 'local', voice: 'af_heart', chunks } })),
  };
}

async function mockLocalVoice(page) {
  const requests = [];
  await page.route('**/local-voice/dev/captioned_speech', async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    const words = [...request.input.matchAll(/\S+/g)].map((word) => word[0]);
    const duration = Math.max(0.35, words.length * 0.35);
    const audio = Buffer.from(pcmToWav(new Float32Array(Math.round(8000 * duration)), 8000)).toString('base64');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      audio, audio_format: 'audio/wav',
      timestamps: words.map((word, i) => ({ word, start_time: i * 0.35, end_time: (i + 1) * 0.35 })),
    }) });
  });
  return requests;
}

async function chooseLocalVoice(page) {
  await page.click('#btn-narration');
  await page.selectOption('#voice-engine', 'local');
  await page.fill('#local-endpoint', '/local-voice');
  await page.locator('#local-endpoint').dispatchEvent('change');
}

async function epubFixture() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Two paths</dc:title><dc:creator>Test reader</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/><item id="second" href="second.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>');
  for (const [name, heading, paragraph] of [
    ['first', 'First chapter', 'This opening chapter introduces a calm place to read and listen.'],
    ['second', 'Second chapter', 'The next chapter preserves its own location so that navigation remains easy.'],
  ]) zip.file(`OEBPS/${name}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head><body><h1>${heading}</h1><p>${paragraph}</p></body></html>`);
  return { name: 'two-paths.epub', mimeType: 'application/epub+zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
}

async function pdfFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const heading of ['First page has readable words.', 'Second page keeps its own location.']) {
    const page = pdf.addPage([500, 700]);
    page.drawText(heading, { x: 45, y: 620, size: 18, font });
    page.drawText('A useful paragraph follows the heading for clear narration.', { x: 45, y: 580, size: 12, font });
  }
  return { name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
}

// Simulate a browser/CDN retaining immutable module URLs from the previous
// release. New release-tagged URLs use today's files. This fixture also
// checks that the service worker does not repopulate its shell with old URLs.
async function cachedReleaseFixture() {
  const previous = 'ac0bfa8';
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', previous], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const old = new Map();
  for (const file of tracked.filter((file) => file === 'index.html' || /^(?:js|brand)\/.*\.js$/.test(file))) {
    old.set(file, execFileSync('git', ['show', `${previous}:${file}`], { cwd: root }));
  }
  let phase = 'previous';
  const requests = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
  const fixture = http.createServer(async (request, response) => {
    try {
      const location = new URL(request.url, 'http://fixture');
      let file = decodeURIComponent(location.pathname).replace(/^\//, '');
      if (!file || file.endsWith('/')) file += 'index.html';
      if (file.includes('..')) return response.writeHead(403).end();
      let body;
      const previousModule = old.has(file) && file.endsWith('.js') && !location.search;
      if (file === 'index.html' && phase === 'previous') body = old.get(file);
      else if (previousModule) body = old.get(file);
      else body = await fs.readFile(path.join(root, file));
      if (file === 'index.html' && phase === 'mixed') {
        body = Buffer.from(body.toString().replace(/(src=["']js\/app\.js)(?:\?[^"']*)?(["'])/, '$1$2'));
      }
      requests.push({ url: location.pathname + location.search, phase, previousModule });
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream',
        'cache-control': file.endsWith('.js') && file !== 'sw.js' ? 'public, max-age=31536000, immutable' : 'no-store' }).end(body);
    } catch { response.writeHead(404).end('not found'); }
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  return { url: `http://127.0.0.1:${fixture.address().port}/`, requests, setPhase(next) { phase = next; },
    async close() { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); } };
}

try {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

  await step('mode switching shares position; narrated words highlight while controls remain available', async () => {
    const { context, page, errors } = await newPage();
    try {
      await loadText(page, READING_TEXT);
      await setRange(page, 'scrub', 7);
      await page.click('#mode-immersive');
      assert.equal(await page.locator('#immersive-reader').isVisible(), true);
      assert.equal(await page.locator('#immersive-reader .immersive-word').textContent(), 'reading');
      await page.click('#mode-rsvp');
      assert.equal(Number(await page.locator('#scrub').inputValue()), 7);
      await page.click('#mode-immersive');
      if (await page.locator('#btn-voice').getAttribute('aria-pressed') !== 'true') await page.click('#btn-voice');
      await setRange(page, 'speech-rate', 1.5);
      const wpm = await page.locator('#wpm').inputValue();
      await page.click('#btn-play');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) >= 9);
      await usableControls(page);
      assert.equal(await page.locator('#wpm').inputValue(), wpm, 'Narration speed does not change RSVP WPM');
      assert.equal(await page.evaluate(() => window.__spoken.at(-1).rate), 1.5);
      await page.click('#mode-listen');
      assert.equal(await page.locator('#listen-view').isVisible(), true);
      await usableControls(page);
      await page.click('#btn-play');
      assert.equal(await page.locator('#btn-play').getAttribute('aria-label'), 'Play');
      await page.click('#mode-immersive');
      await setRange(page, 'scrub', 7);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#toast')).opacity) < 0.02);
      await page.click('#btn-play');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) >= 9);
      assert.equal(await page.locator('#btn-play').getAttribute('aria-label'), 'Pause');
      assert.ok(await page.locator('#toast').evaluate((toast) => Number(getComputedStyle(toast).opacity) < 0.02), 'Expired notifications stay hidden while reading');
      await page.screenshot({ path: path.join(screenshots, 'desktop-readalong.png'), fullPage: true });
      await page.click('#btn-play');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('selected passage speaks only its words and retains exact highlighting', async () => {
    const { context, page, errors } = await newPage();
    try {
      await loadText(page, READING_TEXT);
      await page.click('#mode-immersive');
      const selected = await selectWords(page, 2, 7);
      await page.waitForSelector('#selection-toolbar:not([hidden])');
      await page.click('#btn-read-selection');
      await page.waitForFunction(() => window.__spoken.length > 0);
      await page.waitForFunction(() => document.querySelector('#btn-play').getAttribute('aria-label') === 'Play');
      const spoken = await page.evaluate(() => window.__spoken.map((utterance) => utterance.text).join(' '));
      assert.equal(spoken, selected);
      assert.equal(Number(await page.locator('#scrub').inputValue()), 6);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('pastel and neutral styles persist; bookmarks and reading position survive reload', async () => {
    const { context, page, errors } = await newPage();
    try {
      await loadText(page, READING_TEXT);
      await page.click('#mode-immersive');
      await page.click('#btn-settings');
      assert.equal(await page.locator('#highlight-colors button').count(), 11);
      await page.locator('#highlight-colors button[data-color="sand"], #highlight-colors button[data-highlight-color="sand"], #highlight-colors button[aria-label="Sand"]').first().click();
      await page.selectOption('#highlight-style', 'underline');
      await setRange(page, 'text-size', 26);
      assert.equal(await page.locator('#highlight-preview').getAttribute('data-highlight-style'), 'underline');
      await closeDialog(page, 'dlg-settings');
      assert.equal(await page.locator('#immersive-reader').getAttribute('data-highlight-color'), 'sand');
      await setRange(page, 'scrub', 11);
      await page.click('#btn-bookmark');
      await page.click('#btn-fwd');
      await page.click('#btn-go-bookmark');
      assert.equal(Number(await page.locator('#scrub').inputValue()), 11);
      await page.reload();
      await page.waitForSelector('#home-resume:visible');
      await page.click('#home-resume');
      await page.waitForSelector('#immersive-reader:visible');
      assert.equal(Number(await page.locator('#scrub').inputValue()), 11);
      assert.equal(await page.locator('#immersive-reader').getAttribute('data-highlight-style'), 'underline');
      assert.equal(await page.locator('#immersive-reader').getAttribute('data-highlight-color'), 'sand');
      assert.equal(await page.locator('#immersive-reader').evaluate((element) => element.style.getPropertyValue('--immersive-size')), '26px');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('EPUB chapters and PDF page locations remain navigable in the reader', async () => {
    const { context, page, errors } = await newPage();
    try {
      await loadFile(page, await epubFixture());
      await page.click('#mode-immersive');
      assert.equal(await page.locator('#chapter-select option').count(), 2);
      const epubOptions = await page.locator('#chapter-select option').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
      assert.match(epubOptions[1].text, /Second chapter/);
      await page.selectOption('#chapter-select', epubOptions[1].value);
      assert.equal(await page.locator('#immersive-reader .immersive-word').textContent(), 'Second');
      await loadFile(page, await pdfFixture());
      assert.equal(await page.locator('#chapter-select option').count(), 2);
      const pdfOptions = await page.locator('#chapter-select option').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
      assert.match(pdfOptions[1].text, /Page 2/i);
      await page.selectOption('#chapter-select', pdfOptions[1].value);
      assert.equal(await page.locator('#immersive-reader .immersive-word').textContent(), 'Second');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('prepared audio plays from its audio clock and supports system seek, pause, and package export', async () => {
    const { context, page, errors } = await newPage();
    try {
      await loadFile(page, readingPackage('word'));
      await page.click('#mode-immersive');
      await page.click('#btn-narration');
      await page.waitForSelector('#saved-audio-options:not([hidden])');
      await page.click('#btn-use-audio');
      if (await page.locator('#dlg-narration').evaluate((dialog) => dialog.open)) await closeDialog(page, 'dlg-narration');
      await page.click('#btn-play');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) >= 1);
      await usableControls(page);
      assert.equal(await page.evaluate(() => window.__spoken.length), 0, 'Saved narration uses audio rather than device TTS');
      await page.evaluate(() => {
        if (!window.__mediaActions.seekto || !window.__mediaActions.pause) throw new Error('Media controls unavailable');
        window.__mediaActions.seekto({ seekTime: 3.3, fastSeek: false });
        window.__mediaActions.pause();
      });
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) >= 8);
      assert.equal(await page.locator('#btn-play').getAttribute('aria-label'), 'Play');
      await page.click('#btn-narration');
      const downloadPromise = page.waitForEvent('download');
      await page.click('#btn-export-package');
      const download = await downloadPromise;
      const file = path.join(temp, 'export.readalong');
      await download.saveAs(file);
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(payload.type, 'reader-audio-package');
      assert.equal(payload.manifest.chunks[0].timing, 'word');
      assert.equal(payload.manifest.chunks[1].to, 12);
      await closeDialog(page, 'dlg-narration');
      const position = Number(await page.locator('#scrub').inputValue());
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#home-resume:visible');
      await page.click('#home-resume');
      assert.equal(Number(await page.locator('#scrub').inputValue()), position, 'Offline reload restores prepared-audio position');
      await page.click('#btn-play');
      await page.waitForFunction((before) => Number(document.querySelector('#scrub').value) > before, position);
      assert.equal(await page.evaluate(() => window.__spoken.length), 0, 'Saved audio plays offline after shell reload');
      await page.click('#btn-play');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('local selection preparation clamps to selected words, then Clear releases ephemeral narration', async () => {
    const { context, page, errors } = await newPage();
    try {
      const requests = await mockLocalVoice(page);
      await loadText(page, READING_TEXT);
      await page.click('#mode-immersive');
      await chooseLocalVoice(page);
      await closeDialog(page, 'dlg-narration');
      const selected = await selectWords(page, 2, 4);
      await page.waitForSelector('#selection-toolbar:not([hidden])');
      assert.equal(Number(await page.locator('#scrub').inputValue()), 0, 'Text selection leaves the original playhead at zero');
      await page.click('#btn-read-selection');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) === 3
        && document.querySelector('#btn-play').getAttribute('aria-label') === 'Play');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].input, selected);
      assert.equal(requests[0].return_timestamps, true);
      assert.equal(await page.evaluate(() => window.__spoken.length), 0);
      assert.equal(await page.locator('#immersive-reader .immersive-word').textContent(), 'makes');
      await page.click('#btn-clear-selection');
      await page.click('#btn-play');
      await page.waitForSelector('#dlg-narration[open]');
      assert.equal(await page.locator('#saved-audio-options').isVisible(), false, 'The ephemeral selection was never saved as full narration');
      await closeDialog(page, 'dlg-narration');
      await setRange(page, 'scrub', 10);
      assert.equal(Number(await page.locator('#scrub').inputValue()), 10, 'Navigation is no longer constrained to the selected passage');
      assert.equal(requests.length, 1, 'Clearing or navigating does not silently regenerate audio');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('a prepared EPUB section persists and exports a portable package with rebased word locations', async () => {
    const { context, page, errors } = await newPage();
    try {
      const requests = await mockLocalVoice(page);
      await loadFile(page, await epubFixture());
      await page.click('#mode-immersive');
      const options = await page.locator('#chapter-select option').evaluateAll((items) => items.map((item) => item.value));
      await page.selectOption('#chapter-select', options[1]);
      const chapterText = await page.locator('#immersive-reader .immersive-content').evaluate((content) => {
        const text = content.textContent;
        return text.slice(text.indexOf('Second chapter')).trim();
      });
      await chooseLocalVoice(page);
      await page.selectOption('#prepare-scope', 'section');
      await page.click('#btn-prepare-audio');
      await page.waitForFunction(() => document.querySelector('#audio-progress-label').textContent.includes('Ready. Close')
        && !document.querySelector('#btn-prepare-audio').disabled);
      assert.ok(requests.length >= 1);
      assert.equal(requests.map((request) => request.input).join('\n\n'), chapterText);
      assert.equal(requests.some((request) => request.input.includes('First chapter')), false);
      await closeDialog(page, 'dlg-narration');
      const position = Number(await page.locator('#scrub').inputValue());
      await page.reload();
      await page.waitForSelector('#home-resume:visible');
      await page.click('#home-resume');
      assert.equal(Number(await page.locator('#scrub').inputValue()), position);
      await page.click('#btn-narration');
      await page.waitForSelector('#saved-audio-options:not([hidden])');
      const downloadPromise = page.waitForEvent('download');
      await page.click('#btn-export-package');
      const download = await downloadPromise;
      const file = path.join(temp, 'chapter.readalong');
      await download.saveAs(file);
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      const total = buildDoc(chapterText).words.length;
      assert.equal(payload.manifest.text, chapterText);
      assert.equal(payload.manifest.chunks[0].from, 0);
      assert.equal(payload.manifest.chunks.at(-1).to, total);
      assert.equal(payload.manifest.chunks[0].timings[0].index, 0);
      for (const chunk of payload.manifest.chunks) for (const mark of chunk.timings) {
        assert.ok(mark.index >= chunk.from && mark.index < chunk.to);
      }
      assert.equal(payload.metadata.sections.length, 1);
      assert.equal(payload.metadata.sections[0].title, 'Second chapter');
      assert.equal(payload.metadata.sections[0].start, 0);
      assert.equal(payload.metadata.sections[0].end, chapterText.length);
      await closeDialog(page, 'dlg-narration');
      await loadFile(page, { name: 'chapter.readalong', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
      assert.equal(await page.locator('#immersive-reader .immersive-content').textContent(), chapterText);
      assert.equal(Number(await page.locator('#scrub').getAttribute('max')), total - 1);
      assert.equal(Number(await page.locator('#scrub').inputValue()), 0);
      await page.click('#btn-play');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) >= 1);
      assert.equal(await page.evaluate(() => window.__spoken.length), 0, 'Transferred chapter plays its own saved audio');
      await page.click('#btn-play');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('malformed imported package sections do not become navigation targets', async () => {
    const { context, page, errors } = await newPage();
    try {
      const pack = readingPackage('word');
      const payload = JSON.parse(pack.buffer.toString('utf8'));
      payload.metadata.sections = [null, { title: 'Negative', start: -1, end: 10 },
        { title: 'Outside', start: 0, end: payload.manifest.text.length + 1 },
        { title: 'Strings', start: '0', end: '10' }, { title: 'Backward', start: 10, end: 2 }];
      pack.buffer = Buffer.from(JSON.stringify(payload));
      await loadFile(page, pack);
      assert.equal(await page.locator('#chapter-select').isVisible(), false);
      assert.equal(await page.locator('#chapter-select option').count(), 0);
      assert.equal(await page.locator('#immersive-reader .immersive-content').textContent(), payload.manifest.text);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await step('release-tagged modules upgrade an old cached reader and retain new controls after offline reload', async () => {
    const fixture = await cachedReleaseFixture();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(installDeviceMocks);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(fixture.url);
      await loadText(page, READING_TEXT);
      assert.ok(fixture.requests.some((request) => request.url === '/js/app.js' && request.previousModule));
      assert.ok(fixture.requests.some((request) => request.url === '/js/engine.js' && request.previousModule), 'The old dependency graph is primed too');

      fixture.setPhase('mixed');
      await page.reload();
      await page.waitForSelector('#home-read-along:visible');
      await page.click('#home-read-along');
      assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('on-home')), true,
        'New markup paired with the old cached app reproduces the inert immersive button');

      fixture.setPhase('current');
      await page.reload();
      await page.waitForSelector('#home-read-along:visible');
      const entry = await page.locator('script[src*="js/app.js"]').getAttribute('src');
      const release = new URL(entry, fixture.url).searchParams.get('v');
      assert.ok(release, 'The new entry has a release cache key');
      await page.click('#home-read-along');
      await page.waitForSelector('#immersive-reader:visible');
      assert.equal(await page.locator('#mode-immersive').getAttribute('aria-pressed'), 'true');
      await page.click('#btn-narration');
      await page.waitForSelector('#dlg-narration[open]');
      assert.equal(await page.locator('#voice-engine option[value="local"]').count(), 1);
      await closeDialog(page, 'dlg-narration');
      await page.click('#btn-play');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) > 0);
      await usableControls(page);
      await page.click('#btn-play');
      assert.ok(fixture.requests.some((request) => request.url === `/js/app.js?v=${release}` && !request.previousModule));
      assert.ok(fixture.requests.some((request) => request.url === `/js/engine.js?v=${release}` && !request.previousModule), 'New dependencies bypass the old cached graph');

      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#home-read-along:visible');
      await page.click('#home-read-along');
      await page.waitForSelector('#immersive-reader:visible');
      await page.click('#btn-narration');
      await page.waitForSelector('#dlg-narration[open]');
      await closeDialog(page, 'dlg-narration');
      assert.equal(await page.locator('#mode-immersive').getAttribute('aria-pressed'), 'true', 'The upgraded shell remains functional offline');
      assert.deepEqual(errors, []);
    } finally { await context.close(); await fixture.close(); }
  });

  await step('sentence-timed audio highlights the actual spoken passage without inventing word boundaries', async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 });
    try {
      await loadFile(page, readingPackage('sentence'));
      await page.click('#mode-immersive');
      await page.click('#btn-narration');
      await page.click('#btn-use-audio');
      if (await page.locator('#dlg-narration').evaluate((dialog) => dialog.open)) await closeDialog(page, 'dlg-narration');
      assert.equal(await page.locator('#immersive-reader .immersive-span').textContent(), 'One two three four five six.');
      await page.click('#btn-play');
      await page.waitForFunction(() => document.querySelector('#immersive-reader .immersive-span')?.textContent === 'Seven eight nine ten eleven twelve.');
      await usableControls(page);
      await page.click('#btn-play');
      await page.click('#mode-rsvp');
      assert.equal(await page.locator('#btn-voice').getAttribute('aria-pressed'), 'false', 'Sentence audio switches one-word reading to its WPM timer');
      assert.equal(await page.locator('#reader').isVisible(), true);
      await page.click('#btn-voice');
      assert.equal(await page.locator('#mode-immersive').getAttribute('aria-pressed'), 'true', 'Sentence narration returns to read along');
      assert.equal(await page.locator('#immersive-reader .immersive-span').textContent(), 'Seven eight nine ten eleven twelve.');
      await loadText(page, READING_TEXT);
      if (await page.locator('#btn-voice').getAttribute('aria-pressed') === 'true') await page.click('#btn-voice');
      await page.click('#btn-narration');
      await page.selectOption('#voice-engine', 'device');
      await closeDialog(page, 'dlg-narration');
      if (await page.locator('#btn-voice').getAttribute('aria-pressed') !== 'true') await page.click('#btn-voice');
      await page.click('#btn-play');
      await page.waitForFunction(() => Number(document.querySelector('#scrub').value) >= 3);
      await usableControls(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#toast')).opacity) < 0.02);
      assert.equal(await page.locator('#btn-play').getAttribute('aria-label'), 'Pause', 'Mobile screenshot captures active narration');
      await page.screenshot({ path: path.join(screenshots, 'mobile-readalong.png'), fullPage: true });
      await page.click('#btn-play');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
} finally {
  await browser?.close();
  server.kill();
  await fs.rm(temp, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log('All reader experience checks passed.');
