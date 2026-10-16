import { splitWord } from './orp.js?v=20261016';
import { buildDoc, normalize, durationMs, sentenceStart, sentenceEnd } from './text.js?v=20261016';
import { MIN_WPM, MAX_WPM } from './engine.js?v=20261016';
import { ReadingPlayback } from './playback.js?v=20261016';
import { NativeAudioNarrator } from './narration.js?v=20261016';
import { ImmersiveReader, HIGHLIGHT_COLORS, wordAtOffset } from './immersive.js?v=20261016';
import { prepareNaturalVoice, serializeAudioPackage, importAudioPackage, exportNarrationAudio, NATURAL_VOICES } from './natural-voice.js?v=20261016';
import { speechSupported, listVoices, pickVoice, voiceLabel, claimPlaybackAudio, unlockAudio } from './speech.js?v=20261016';
import { importFile, articleFromHtml } from './importers.js?v=20261016';
import { bookmarkletHref, appUrl } from './bookmarklet.js?v=20261016';
import * as store from './store.js?v=20261016';
import { createImmersiveChrome } from './immersive-chrome.js?v=20261016';
import { isLanding, showLanding, showReader } from './landing.js?v=20261016';

const $ = (id) => document.getElementById(id);
const el = {
  title: $('doc-title'),
  reader: $('reader'),
  word: $('word'),
  before: $('w-before'),
  pivot: $('w-pivot'),
  after: $('w-after'),
  context: $('context'),
  status: $('status'),
  scrub: $('scrub'),
  pos: $('pos-label'),
  time: $('time-label'),
  play: $('btn-play'),
  wpm: $('wpm'),
  wpmLabel: $('wpm-label'),
  voice: $('btn-voice'),
  toast: $('toast'),
};

const SAMPLE = `Rapid serial visual presentation shows one word at a time in the same place, so your eyes never have to move across a line.

Look at the coloured letter. Each word is positioned so that its optimal recognition point sits exactly under the markers, which is where your eye naturally lands when it reads a word. Short words pivot near the start; longer words pivot a little further in.

Sentences end with a slightly longer pause. Commas, semicolons, and colons get a shorter one. Unusually long words, like incomprehensibility, stay on screen a little longer too.

Use the slider below to change speed, the arrows to jump back or forward ten words, and the timeline to move anywhere in the text. Turn on Read aloud to hear the text in your device's voice while the words follow along.

In Read along mode, you can select a passage and listen to just those words. Open Settings to try a pastel or neutral highlight, a half marker, or a simple underline. Scroll freely whenever you like, then tap Resume following to return to the spoken text.

Voice speed has its own slider. Open Voice & audio for natural narration that runs on your device, or prepare audio on your Mac. Saved narration keeps listening simple when you put the screen away.`;

const prefs = store.loadPrefs();
let current = null; // { meta, doc }
let dragging = false;
let wakeLock = null;
let fullNarration = null;
let voicePreparation = null;
let importController = null;
let documentEpoch = 0;
let selectedPassage = null;
let currentSpan = null;
let testingDeviceVoice = false;
let immersiveChrome;

const player = new ReadingPlayback({
  onWord: (i, span) => { currentSpan = span || null; render(i); },
  onState: (playing) => {
    document.body.classList.toggle('reading', playing);
    immersiveChrome?.sync(prefs.mode, playing);
    updatePlayButton(playing);
    updateContext();
    updateStatus();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (playing && prefs.mode !== 'listen') requestWakeLock();
    else {
      releaseWakeLock();
      saveProgress(true);
    }
  },
  onError: (err) => {
    toast(err === 'not-allowed' ? 'Tap play to start reading aloud.' : String(err), 6000);
  },
  onProgress: () => { if (current && player.usesAudio) { updateLabels(player.index); updateMediaPosition(); } },
});

immersiveChrome = createImmersiveChrome({ reader: $('immersive-reader'), onExit: () => player.pause() });
const immersive = new ImmersiveReader({ container: $('immersive-reader'),
  onSeek: (index) => { clearPassage(); player.seek(index); },
  onSelection: (range) => { if (range) { selectedPassage = range; updateSelection(); } },
  onManualScroll: () => { $('btn-follow').textContent = 'Resume following'; $('btn-follow').setAttribute('aria-pressed','false'); },
});
const highlightPreview = new ImmersiveReader({ container: $('highlight-preview') });
const previewText = 'A comfortable place to read, one thoughtful sentence at a time.';
highlightPreview.load(buildDoc(previewText), previewText);
highlightPreview.setWord(5, { follow: false });

// ---------------------------------------------------------------- rendering

const canvas = document.createElement('canvas').getContext('2d');
let fontSpec = '';
let fontPx = 0;

function measureFont() {
  const prev = el.word.style.getPropertyValue('--fit');
  el.word.style.setProperty('--fit', '1');
  const cs = getComputedStyle(el.word);
  fontPx = parseFloat(cs.fontSize);
  fontSpec = `${cs.fontWeight} ${fontPx}px ${cs.fontFamily}`;
  el.word.style.setProperty('--fit', prev || '1');
}

// Shrink a long word just enough that neither side runs past the box edge.
function fitWord(before, pivot, after) {
  if (el.reader.hidden || el.reader.clientWidth < 1) return;
  if (!fontSpec) measureFont();
  canvas.font = fontSpec;
  const p = canvas.measureText(pivot).width / 2;
  const need = Math.max(canvas.measureText(before).width + p, canvas.measureText(after).width + p);
  const half = el.reader.clientWidth / 2 - 4;
  let scale = need > half && need > 0 ? half / need : 1;
  el.word.style.setProperty('--fit', String(Math.floor(scale * 10000) / 10000));
  // Optical sizing and font rounding can differ from the canvas at a smaller
  // size. Correct only long words against their actual rendered widths.
  if (scale < 1) {
    const width = (element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      return range.getBoundingClientRect().width;
    };
    for (let pass = 0; pass < 2; pass++) {
      const p = width(el.pivot) / 2;
      const actual = Math.max(width(el.before) + p, width(el.after) + p);
      if (actual <= half) break;
      scale *= half / actual;
      el.word.style.setProperty('--fit', String(Math.floor(scale * 10000) / 10000));
    }
  }
}

function showPlaceholder(text) {
  el.word.classList.add('placeholder');
  el.before.textContent = '';
  el.after.textContent = '';
  el.pivot.textContent = text;
  el.word.style.setProperty('--fit', '1');
}

function render(i) {
  if (!current) return;
  const w = current.doc.words[i];
  if (!w) return;
  el.word.classList.remove('placeholder');
  const { before, pivot, after } = splitWord(w.t);
  el.before.textContent = before;
  el.pivot.textContent = pivot;
  el.after.textContent = after;
  fitWord(before, pivot, after);
  if (prefs.mode === 'immersive') immersive.setWord(i, { follow: prefs.follow && player.playing, span: currentSpan });
  const from = sentenceStart(current.doc.words, i), to = sentenceEnd(current.doc.words, i);
  $('listen-context').textContent = current.doc.words.slice(from, to).map((word) => word.t).join(' ');
  const section = sectionAt(i);
  if (section >= 0) $('chapter-select').value = String(section);
  if (!dragging) el.scrub.value = i;
  updateLabels(i);
  if (!player.playing) updateContext();
  saveProgress(!player.playing);
}

function updateLabels(i) {
  const n = current.doc.words.length;
  const pct = n > 1 ? Math.round((i / (n - 1)) * 100) : 100;
  el.pos.textContent = `${(i + 1).toLocaleString()} / ${n.toLocaleString()} · ${pct}%`;
  let ms;
  if (player.usesAudio) {
    ms = (player.audio.duration - player.audio.currentTime) / player.rate * 1000;
  } else if (player.speech) {
    const wpm = player.speaker.measuredWpm || player.wpm;
    ms = ((n - i - 1) * 60000) / wpm;
  } else {
    ms = durationMs(current.doc, i, n, player.wpm);
  }
  const estimatedAudio = player.usesAudio && player.manifest.chunks.some((chunk) => chunk.durationEstimated || !chunk.duration);
  el.time.textContent = `${estimatedAudio ? '~' : ''}${formatDuration(ms)} left`;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// While paused, show the surrounding sentence with the current word marked.
function updateContext() {
  if (!current || player.playing || prefs.mode !== 'rsvp') {
    el.context.classList.remove('show');
    return;
  }
  const words = current.doc.words;
  const i = player.index;
  const from = Math.max(sentenceStart(words, i), i - 30);
  const to = Math.min(sentenceEnd(words, i), i + 30);
  const join = (a, b) => words.slice(a, b).map((w) => w.t).join(' ');
  el.context.replaceChildren(
    document.createTextNode((from > 0 && from === i - 30 ? '… ' : '') + join(from, i) + ' '),
    Object.assign(document.createElement('mark'), { textContent: words[i].t }),
    document.createTextNode(' ' + join(i + 1, to) + (to < words.length && to === i + 30 ? ' …' : '')),
  );
  el.context.classList.add('show');
}

function updatePlayButton(playing) {
  el.play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

let statusTimer = 0;
function updateStatus() {
  clearInterval(statusTimer);
  if (!player.speech) {
    el.status.textContent = '';
    return;
  }
  const tick = () => {
    const v = player.usesAudio ? `${player.manifest.voice || 'Saved narration'} · ${player.audio.timing === 'sentence' ? 'sentence highlights' : 'word highlights'}` : (player.voice ? player.voice.name : 'default voice');
    const measured = player.speaker.measuredWpm;
    el.status.textContent =
      `Reading aloud · ${v} · rate ${player.rate.toFixed(2)}×` + (measured && player.playing ? ` · ~${measured} wpm measured` : '');
  };
  tick();
  if (player.playing) statusTimer = setInterval(tick, 1000);
}

function setWpm(wpm) {
  player.setWpm(wpm);
  prefs.wpm = player.wpm;
  store.savePrefs(prefs);
  el.wpm.value = player.wpm;
  el.wpmLabel.textContent = `${player.wpm} wpm`;
  if (current) updateLabels(player.index);
  updateStatus();
}

// ---------------------------------------------------------------- documents

let saveTimer = 0;
let lastSaved = -1;
function saveProgress(now) {
  if (!current) return;
  const write = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!current || player.index === lastSaved) return;
    lastSaved = player.index;
    current.meta.position = player.index;
    store.setPosition(current.meta.id, player.index).catch(() => {});
  };
  if (now) write();
  else if (!saveTimer) saveTimer = setTimeout(write, 1500);
}

async function loadDocument(meta, originalText) {
  player.pause(); // saves the previous document's position
  saveProgress(true);
  voicePreparation?.abort();
  const epoch = ++documentEpoch;
  const text = normalize(originalText);
  const doc = buildDoc(text);
  if (!doc.words.length) {
    toast('That text has no words to read.');
    return;
  }
  current = { meta, doc, text };
  fullNarration = null;
  selectedPassage = null;
  updateSelection();
  immersive.load(doc, text);
  showReader();
  lastSaved = meta.position;
  el.title.textContent = meta.title;
  document.title = `${meta.title} · Speed Reader`;
  el.scrub.max = Math.max(0, doc.words.length - 1);
  el.play.disabled = false;
  $('listen-title').textContent = meta.title;
  player.load(doc, text, Math.min(meta.position || 0, doc.words.length - 1));
  populateSections();
  updateBookmark();
  applyMode();
  prefs.lastDocId = meta.id;
  store.savePrefs(prefs);
  setMediaMetadata();
  try {
    const saved = await store.getAudio(meta.id);
    if (epoch !== documentEpoch) return;
    if (saved) {
      fullNarration = saved;
      if (audioCompatible(saved)) player.attachAudio(saved);
    }
  } catch { toast('Saved audio could not be opened. You can prepare it again.'); }
  updateNarrationUI();
}

async function openText({ title, text: originalText, source, url = '', sections = [], metadata = {}, warnings = [] }, { guard = () => true } = {}) {
  const text = normalize(originalText);
  const words = buildDoc(text).words.length;
  if (!words) throw new Error('No words found.');
  const id = store.docId({ url, text });
  if (!guard()) throw new DOMException('Canceled','AbortError');
  const meta = await store.saveDoc({ id, title: typeof title === 'string' && title.trim() ? title : 'Untitled',
    source: typeof source === 'string' ? source : 'import', url: typeof url === 'string' ? url : '', text, wordCount: words, sections, metadata });
  if (!guard()) throw new DOMException('Canceled','AbortError');
  await loadDocument(meta, text);
  if (!guard()) throw new DOMException('Canceled','AbortError');
  if (meta.position > 0) toast(`Resuming at word ${(meta.position + 1).toLocaleString()}.`);
  return { meta, warnings: Array.isArray(warnings) ? warnings : [] };
}

async function openStored(id) {
  importController?.abort();
  const saved = await store.getDoc(id);
  if (!saved) return false;
  await loadDocument(saved.meta, saved.text);
  return true;
}

async function runImport(task, label) {
  importController?.abort();
  const controller = importController = new AbortController();
  $('btn-cancel-import').hidden = false;
  $('import-progress').textContent = `${label}…`;
  toast(`${label}…`, 60000);
  try {
    const result = await task({ signal: controller.signal, ocr: $('pdf-ocr').checked,
      onProgress: (message) => { $('import-progress').textContent = message; } });
    if (controller.signal.aborted) throw new DOMException('Canceled','AbortError');
    const guard = () => importController === controller && !controller.signal.aborted;
    const { meta, warnings } = await openText(result, { guard });
    if (!guard() || current?.meta.id !== meta.id) throw new DOMException('Canceled','AbortError');
    if (result.audioManifest) {
      if (result.readingPrefs) {
        const imported = store.sanitizePrefs({ ...prefs, ...result.readingPrefs });
        for (const key of ['highlightColor','highlightStyle','highlightOpacity']) prefs[key] = imported[key];
        applyAppearance();
      }
      fullNarration = result.audioManifest;
      prefs.voiceEngine = 'saved'; player.setEngine('saved'); player.attachAudio(fullNarration); setSpeech(true); setMode('immersive');
      updateNarrationUI();
      try {
        const persistent = await store.saveAudio(meta.id, result.audioManifest);
        if (!guard()) throw new DOMException('Canceled','AbortError');
        if (!persistent) warnings.push('Audio is ready for this session. Keep your reading package to restore it.');
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        warnings.push('Device storage is full. Audio works for this session; keep your reading package.');
      }
    }
    toast(warnings?.length ? warnings.join(' ') : 'Ready. Tap play or press space.', warnings?.length ? 9000 : 3000);
    return true;
  } catch (err) {
    if (importController !== controller) return false;
    if (err.name === 'AbortError') { toast('Import canceled.'); return false; }
    toast(err.message || String(err), 6000);
    $('import-progress').textContent = err.message || String(err);
    return false;
  } finally { if (importController === controller) { importController = null; $('btn-cancel-import').hidden = true; } }
}

// ---------------------------------------------------------------- dialogs

const dlgImport = $('dlg-import');
const dlgLibrary = $('dlg-library');
const dlgSettings = $('dlg-settings');
const dlgNarration = $('dlg-narration');

function openDialog(d) {
  player.pause();
  d.showModal();
}

// Close when tapping the backdrop.
for (const d of [dlgImport, dlgLibrary, dlgSettings, dlgNarration]) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
}

$('btn-import').addEventListener('click', () => openDialog(dlgImport));
$('home-resume').addEventListener('click', () => {
  if (!current) return;
  showReader();
  document.title = `${current.meta.title} · Speed Reader`;
  render(player.index);
  el.play.focus();
});
$('btn-reader-home').addEventListener('click', () => {
  immersiveChrome.leave();
  player.pause();
  showLanding(current?.meta);
});
$('btn-settings').addEventListener('click', () => {
  populateVoices();
  openDialog(dlgSettings);
});
$('btn-cancel-import').addEventListener('click', () => importController?.abort());
$('home-read-along').addEventListener('click', async () => {
  setMode('immersive');
  setSpeech(true);
  await runImport(async () => ({ title: 'Sample: how this works', text: SAMPLE, source: 'sample' }), 'Loading');
});
$('btn-library').addEventListener('click', async () => {
  await renderLibrary();
  openDialog(dlgLibrary);
});

$('btn-read-paste').addEventListener('click', async () => {
  const text = $('paste-text').value;
  if (!text.trim()) return toast('Paste some text first.');
  const firstLine = text.trim().split('\n')[0];
  const title = firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
  if (await runImport(async () => ({ title, text, source: 'paste' }), 'Loading')) {
    $('paste-text').value = '';
    dlgImport.close();
  }
});

$('btn-clipboard').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return toast('The clipboard is empty.');
    $('paste-text').value = text;
    $('btn-read-paste').click();
  } catch {
    toast('Clipboard access was blocked. Long-press the box and choose Paste.');
  }
});

$('btn-sample').addEventListener('click', async () => {
  if (await runImport(async () => ({ title: 'Sample: how this works', text: SAMPLE, source: 'sample' }), 'Loading')) dlgImport.close();
});

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file && (await openFile(file))) dlgImport.close();
});

// Drag and drop anywhere.
let dragDepth = 0;
const dropOverlay = $('drop-overlay');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.remove('show');
  }
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('show');
  const file = e.dataTransfer.files[0];
  if (file && (await openFile(file)) && dlgImport.open) dlgImport.close();
});

async function openFile(file) {
  if (!/\.(readalong|json)$/i.test(file.name)) return runImport((options) => importFile(file, options), `Reading ${file.name}`);
  return runImport(async ({ signal }) => {
    const pack = await importAudioPackage(file);
    if (signal.aborted) throw new DOMException('Canceled','AbortError');
    return { ...pack.metadata, title: pack.metadata.title || file.name.replace(/\.[^.]+$/, ''), text: pack.text,
      source: 'audio package', audioManifest: pack.manifest, readingPrefs: pack.metadata.readingPrefs };
  }, `Opening ${file.name}`);
}

// Bookmarklet.
const bmHref = bookmarkletHref(appUrl());
const bmLink = $('bm-link');
bmLink.href = bmHref;
bmLink.addEventListener('click', (e) => {
  e.preventDefault();
  toast('Drag this to your Favorites bar, or use “Copy bookmarklet code”.');
});
$('btn-copy-bm').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(bmHref);
    toast('Bookmarklet code copied.');
  } catch {
    toast('Copy failed. Long-press the Speed Read button and copy its link.');
  }
});

async function renderLibrary() {
  const list = $('library-list');
  const docs = await store.listDocs();
  if (!docs.length) {
    list.innerHTML = '<li class="empty">Nothing here yet. Import something to read.</li>';
    return;
  }
  list.replaceChildren(
    ...docs.map((d) => {
      const li = document.createElement('li');
      if (current?.meta.id === d.id) li.className = 'current';
      const pct = d.wordCount > 1 ? Math.round((d.position / (d.wordCount - 1)) * 100) : 0;
      let where = d.source;
      if (d.url) {
        try {
          where = new URL(d.url).hostname;
        } catch {}
      }
      const open = document.createElement('button');
      open.className = 'open';
      open.innerHTML = '<span class="t"></span><span class="m"></span><span class="bar"><i></i></span>';
      open.querySelector('.t').textContent = d.title;
      open.querySelector('.m').textContent = `${where} · ${d.wordCount.toLocaleString()} words · ${pct}% read`;
      open.querySelector('.bar i').style.width = `${pct}%`;
      open.addEventListener('click', async () => {
        await openStored(d.id);
        dlgLibrary.close();
      });
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.setAttribute('aria-label', `Delete ${d.title}`);
      del.innerHTML = '<svg><use href="#i-close"/></svg>';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete “${d.title}” from this device?`)) return;
        await store.deleteDoc(d.id);
        if (current?.meta.id === d.id) {
          player.pause();
          voicePreparation?.abort();
          documentEpoch++;
          fullNarration = null;
          player.unload();
          immersive.clear();
          current = null;
          clearTimeout(saveTimer); saveTimer = 0;
          prefs.lastDocId = '';
          store.savePrefs(prefs);
          el.title.textContent = 'Speed Reader';
          el.play.disabled = true;
          el.scrub.max = 0;
          el.pos.textContent = '';
          el.time.textContent = '';
          el.context.classList.remove('show');
          showPlaceholder('Tap + to import something to read');
          if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
          showLanding();
        }
        renderLibrary();
      });
      li.append(open, del);
      return li;
    }),
  );
}

// ---------------------------------------------------------------- settings

function applyAppearance() {
  document.body.dataset.accent = prefs.accent;
  document.body.dataset.font = prefs.font;
  document.body.style.setProperty('--size', prefs.size);
  document.querySelector(`input[name=accent][value=${prefs.accent}]`).checked = true;
  document.querySelector(`input[name=font][value=${prefs.font}]`).checked = true;
  $('size').value = prefs.size;
  immersive.setPrefs(prefs);
  highlightPreview.setPrefs({ ...prefs, fontSize: 21, follow: false });
  for (const [id, key] of Object.entries({ 'highlight-style': 'highlightStyle', 'highlight-opacity': 'highlightOpacity', 'text-size': 'fontSize', 'line-height': 'lineHeight' })) $(id).value = prefs[key];
  $('sentence-highlight').checked = prefs.sentenceHighlight;
  $('auto-follow').checked = prefs.follow;
  document.querySelectorAll('.color-swatch').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.color === prefs.highlightColor)));
  fontSpec = '';
  if (current) render(player.index);
}

for (const [name, color] of Object.entries(HIGHLIGHT_COLORS)) {
  const button = document.createElement('button');
  button.className = 'color-swatch';
  button.dataset.color = name;
  button.style.background = `rgb(${color.rgb})`;
  button.title = color.label;
  button.setAttribute('aria-label', `${color.label} highlight`);
  button.addEventListener('click', () => { prefs.highlightColor = name; store.savePrefs(prefs); applyAppearance(); });
  $('highlight-colors').append(button);
}
for (const [id, key] of Object.entries({ 'highlight-style': 'highlightStyle', 'highlight-opacity': 'highlightOpacity', 'text-size': 'fontSize', 'line-height': 'lineHeight', 'sentence-highlight': 'sentenceHighlight', 'auto-follow': 'follow' })) {
  $(id).addEventListener('input', (event) => {
    prefs[key] = event.target.type === 'checkbox' ? event.target.checked : (event.target.type === 'range' ? Number(event.target.value) : event.target.value);
    store.savePrefs(prefs);
    applyAppearance();
  });
}
$('btn-reader-theme').addEventListener('click', () => $('home-theme').click());

document.querySelectorAll('input[name=accent], input[name=font]').forEach((r) =>
  r.addEventListener('change', () => {
    prefs[r.name] = r.value;
    store.savePrefs(prefs);
    applyAppearance();
  }),
);
$('size').addEventListener('input', (e) => {
  prefs.size = Number(e.target.value);
  store.savePrefs(prefs);
  applyAppearance();
});

function populateVoices() {
  const select = $('voice-select');
  if (!speechSupported()) {
    select.disabled = true;
    select.innerHTML = '<option>Speech is not supported in this browser</option>';
    return;
  }
  const voices = listVoices();
  if (!voices.length) {
    select.innerHTML = '<option>No voices available yet</option>';
    return;
  }
  const chosen = pickVoice(prefs.voiceURI);
  select.replaceChildren(
    ...voices.map((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = voiceLabel(v);
      o.selected = chosen && v.voiceURI === chosen.voiceURI;
      return o;
    }),
  );
  player.voice = chosen;
}

$('voice-select').addEventListener('change', (e) => {
  prefs.voiceURI = e.target.value;
  store.savePrefs(prefs);
  player.setVoice(pickVoice(prefs.voiceURI));
  updateStatus();
});

$('btn-test-voice').addEventListener('click', () => {
  if (!speechSupported()) return;
  unlockAudio();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('This is how the reader will sound at your current speed.');
  testingDeviceVoice = true;
  u.onend = u.onerror = () => { testingDeviceVoice = false; };
  const v = pickVoice(prefs.voiceURI);
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  u.rate = player.rate;
  speechSynthesis.speak(u);
});

// ---------------------------------------------------------------- controls

// While reading, everything but the word is hidden; a tap anywhere pauses.
// Capture phase so the tap doesn't also reach whatever is underneath.
document.addEventListener(
  'click',
  (e) => {
    if (!document.body.classList.contains('reading') || prefs.mode !== 'rsvp') return;
    e.preventDefault();
    e.stopPropagation();
    player.pause();
  },
  true,
);

function togglePlayback() {
  if (!current) return;
  if (prefs.mode === 'rsvp' && prefs.speech && hasSentenceAudio()) setSpeech(true);
  if (prefs.mode === 'listen' && !prefs.speech) setSpeech(true);
  if (prefs.speech && prefs.voiceEngine !== 'device' && !player.manifest) { updateNarrationUI(); openDialog(dlgNarration); return; }
  unlockAudio();
  stopPreview();
  player.toggle();
}
el.play.addEventListener('click', togglePlayback);
el.reader.addEventListener('click', togglePlayback);
el.reader.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    togglePlayback();
  }
});
$('btn-back').addEventListener('click', () => prefs.mode === 'listen' ? player.skipSeconds(-15) : player.skip(-10));
$('btn-fwd').addEventListener('click', () => prefs.mode === 'listen' ? player.skipSeconds(15) : player.skip(10));

// While the thumb is held, don't move it from under the finger.
el.scrub.addEventListener('pointerdown', () => (dragging = true));
for (const type of ['pointerup', 'pointercancel', 'change']) {
  el.scrub.addEventListener(type, () => (dragging = false));
}
el.scrub.addEventListener('input', () => { clearPassage(); player.seek(Number(el.scrub.value), { debounceSpeech: true }); });
el.scrub.addEventListener('change', () => saveProgress(true));

el.wpm.addEventListener('input', () => setWpm(Number(el.wpm.value)));
$('wpm-down').addEventListener('click', () => setWpm(player.wpm - 25));
$('wpm-up').addEventListener('click', () => setWpm(player.wpm + 25));

el.voice.addEventListener('click', () => setSpeech(!prefs.speech));
$('speech-rate').addEventListener('input', (event) => {
  prefs.speechRate = Number(event.target.value);
  player.setRate(prefs.speechRate);
  $('speech-rate-label').textContent = `${player.rate.toFixed(2)}×`;
  store.savePrefs(prefs);
  updateStatus();
});

document.addEventListener('keydown', (e) => {
  if (isLanding()) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (t.matches?.('textarea, select, input:not([type=range])')) return;
  // Let focused controls keep their native keys (Space clicks a button,
  // arrows move a slider).
  if (e.key === ' ' && t.matches?.('button, summary, a')) return;
  if (e.key.startsWith('Arrow') && t.matches?.('input[type=range]')) return;
  const keys = {
    ' ': togglePlayback,
    ArrowLeft: () => player.skip(-10),
    ArrowRight: () => player.skip(10),
    ArrowUp: () => adjustSpeed(1),
    ArrowDown: () => adjustSpeed(-1),
  };
  const fn = keys[e.key];
  if (!fn || !current) return;
  if (prefs.mode === 'immersive' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
  e.preventDefault();
  fn();
});

window.addEventListener('resize', () => {
  fontSpec = '';
  if (current) render(player.index);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveProgress(true);
    return;
  }
  if (player.playing) requestWakeLock();
  // iOS can wedge the speech queue while the page is in the background.
  if (speechSupported() && !player.usesAudio) {
    if (player.playing && player.speech) player.seek(player.index);
    else if (!player.playing) speechSynthesis.cancel();
  }
});
window.addEventListener('pagehide', () => saveProgress(true));

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    // Not supported or not allowed; the screen may dim during long reads.
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

let toastTimer = 0;
function toast(msg, ms = 3000) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- bookmarklet hand-off

// Opened by the bookmarklet as "<app>#import": ask the opener for the page,
// then extract the article.
function receiveFromBookmarklet() {
  history.replaceState(null, '', location.pathname + location.search);
  const opener = window.opener;
  if (!opener) {
    showPlaceholder('No page was received. Go back to the article, tap “Copy article text”, then use Import › Paste.');
    return;
  }
  showPlaceholder('Receiving page…');
  let received = false;
  const ping = () => {
    try {
      opener.postMessage({ type: 'rsvp-ready' }, '*');
    } catch {}
  };
  const pinger = setInterval(ping, 500);
  ping();
  setTimeout(() => {
    clearInterval(pinger);
    if (!received) showPlaceholder('No page was received. Go back to the article, tap “Copy article text”, then use Import › Paste.');
  }, 120000);
  window.addEventListener('message', async (e) => {
    if (received || e.source !== opener || e.data?.type !== 'rsvp-import' || typeof e.data.html !== 'string') return;
    received = true;
    clearInterval(pinger);
    try {
      e.source.postMessage({ type: 'rsvp-received' }, e.origin);
    } catch {}
    const url = typeof e.data.url === 'string' ? e.data.url : '';
    const ok = await runImport(() => articleFromHtml(e.data.html, url), 'Extracting article');
    if (!ok) showPlaceholder('Could not extract text from that page.');
  });
}

// ---------------------------------------------------------------- reading modes and passages

function setSpeech(on) {
  if (on && prefs.voiceEngine === 'device' && !speechSupported()) { toast('Choose a natural voice in Voice & audio.'); openDialog(dlgNarration); return; }
  if (!player.voice) player.voice = pickVoice(prefs.voiceURI);
  player.setSpeech(on);
  prefs.speech = !!on;
  if (on && prefs.mode === 'rsvp' && hasSentenceAudio()) {
    prefs.mode = 'immersive';
    toast('This narration follows sentences. Read along shows the complete spoken passage.', 5000);
  }
  store.savePrefs(prefs);
  applyMode();
  updateNarrationUI();
  updateStatus();
  if (current) render(player.index);
}
function hasSentenceAudio() { return player.manifest?.chunks.some((chunk) => chunk.timing === 'sentence'); }
function setMode(mode) {
  prefs.mode = mode;
  if (mode === 'rsvp' && prefs.speech && hasSentenceAudio()) {
    setSpeech(false);
    toast('One-word reading uses the WPM slider. Use Read along or Listen for this saved narration.', 5000);
  }
  if (mode === 'listen') setSpeech(true);
  store.savePrefs(prefs);
  applyMode();
  if (current) render(player.index);
}
function applyMode() {
  document.body.dataset.readingMode = prefs.mode;
  el.reader.hidden = prefs.mode !== 'rsvp';
  el.context.hidden = prefs.mode !== 'rsvp';
  $('immersive-reader').hidden = prefs.mode !== 'immersive';
  $('listen-view').hidden = prefs.mode !== 'listen';
  immersiveChrome.sync(prefs.mode, player.playing);
  $('btn-follow').hidden = prefs.mode !== 'immersive';
  $('rsvp-speed').hidden = prefs.speech;
  $('speech-speed').hidden = !prefs.speech;
  el.voice.setAttribute('aria-pressed', String(prefs.speech));
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === prefs.mode));
  for (const [id, direction] of [['btn-back','Back'],['btn-fwd','Forward']]) {
    const button = $(id), amount = prefs.mode === 'listen' ? 15 : 10;
    button.querySelector('.sub').textContent = amount;
    button.setAttribute('aria-label', `${direction} ${amount} ${prefs.mode === 'listen' ? 'seconds' : 'words'}`);
  }
  updateSelection();
  fontSpec = '';
}
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => setMode(button.dataset.mode));
$('btn-follow').addEventListener('click', () => {
  prefs.follow = true; store.savePrefs(prefs); immersive.resumeFollow();
  $('btn-follow').textContent = 'Following text'; $('btn-follow').setAttribute('aria-pressed','true');
});
function adjustSpeed(direction) {
  if (!prefs.speech) { setWpm(player.wpm + direction * 25); return; }
  $('speech-rate').value = Math.max(.5, Math.min(3, player.rate + direction * .1));
  $('speech-rate').dispatchEvent(new Event('input'));
}
function updateSelection() {
  $('selection-toolbar').hidden = !selectedPassage || prefs.mode !== 'immersive';
  if (selectedPassage) $('selection-label').textContent = `${selectedPassage.end - selectedPassage.start} words selected`;
}
function clearPassage() {
  if (player.manifest && player.manifest !== fullNarration) {
    if (fullNarration && audioCompatible(fullNarration)) player.attachAudio(fullNarration);
    else player.removeAudio();
  }
  player.cancelRange();
  selectedPassage = null;
  window.getSelection()?.removeAllRanges();
  updateSelection();
}
$('btn-clear-selection').addEventListener('click', clearPassage);
$('btn-read-selection').addEventListener('click', async () => {
  const range = selectedPassage;
  if (!current || !range) return;
  setSpeech(true);
  try {
    if (prefs.voiceEngine !== 'device' && !player.manifest) {
      if (!(await prepareAudio({ from: range.start, to: range.end }, { save: false, closeAfter: true }))) return;
    }
    try { player.setRange(range.start, range.end); }
    catch (error) {
      if (!['browser','local'].includes(prefs.voiceEngine)) throw error;
      if (!(await prepareAudio({ from: range.start, to: range.end }, { save: false, closeAfter: true }))) return;
      player.setRange(range.start, range.end);
    }
    player.play();
  } catch (error) { toast(error.message, 6000); }
});
$('btn-read-from').addEventListener('click', () => {
  if (!selectedPassage) return;
  const start = selectedPassage.start;
  clearPassage(); setSpeech(true); player.seek(start); togglePlayback();
});
function populateSections() {
  const select = $('chapter-select');
  const sections = current?.meta.sections || [];
  select.hidden = sections.length < 2;
  select.replaceChildren(...sections.map((section,i) => Object.assign(document.createElement('option'), { value: String(i), textContent: section.title || `Section ${i + 1}` })));
}
function sectionAt(index) {
  const offset = current?.doc.words[index]?.s ?? 0;
  return (current?.meta.sections || []).findIndex((section) => offset >= section.start && offset < section.end);
}
$('chapter-select').addEventListener('change', (event) => {
  const section = current?.meta.sections?.[Number(event.target.value)];
  if (section) { clearPassage(); player.seek(wordAtOffset(current.doc.words, section.start)); immersive.resumeFollow(); }
});
function updateBookmark() { $('btn-go-bookmark').hidden = !current || !Number.isInteger(prefs.bookmarks?.[current.meta.id]); }
$('btn-bookmark').addEventListener('click', () => {
  if (!current) return;
  prefs.bookmarks = { ...(prefs.bookmarks || {}), [current.meta.id]: player.index };
  store.savePrefs(prefs); updateBookmark(); toast('Your place is bookmarked on this device.');
});
$('btn-go-bookmark').addEventListener('click', () => {
  const index = prefs.bookmarks?.[current?.meta.id];
  if (Number.isInteger(index)) { clearPassage(); player.seek(index); immersive.resumeFollow(); }
});

// ---------------------------------------------------------------- natural narration and saved audio

function audioCompatible(manifest) {
  return prefs.voiceEngine === 'saved' || (prefs.voiceEngine === manifest.engine && prefs.naturalVoice === manifest.voice);
}
function updateNarrationUI() {
  $('voice-engine').value = prefs.voiceEngine;
  $('natural-voice').value = prefs.naturalVoice;
  $('local-endpoint').value = prefs.localEndpoint;
  const natural = ['browser','local'].includes(prefs.voiceEngine);
  $('natural-options').hidden = !natural;
  $('prepare-scope-options').hidden = !natural;
  $('prepare-scope').querySelector('[value=section]').disabled = !current?.meta.sections?.length;
  $('prepare-scope').querySelector('[value=selection]').disabled = !selectedPassage;
  for (const id of ['voice-engine','natural-voice','local-endpoint','local-token','prepare-scope']) $(id).disabled = !!voicePreparation;
  $('local-options').hidden = prefs.voiceEngine !== 'local';
  $('btn-prepare-audio').hidden = !natural;
  $('btn-prepare-audio').disabled = !current || !!voicePreparation;
  $('btn-preview-natural').hidden = prefs.voiceEngine === 'saved';
  $('btn-preview-natural').disabled = !!voicePreparation;
  $('saved-audio-options').hidden = !fullNarration;
  const hints = {
    device: 'Free and ready immediately. Download Enhanced or Premium device voices for a more natural sound. Word tracking uses voice boundaries when available, with an estimate otherwise.',
    browser: 'Natural English narration runs here. The first use downloads a large free voice model (about 90 MB plus runtime). Preparation can be slow on phones. Highlighting follows sentences. Your text stays on this device.',
    local: 'Generate natural English audio on your Mac with the free Kokoro helper. Matching word timings drive highlights; passages with different spoken tokens use sentence highlights. Import the saved audio on your phone.',
    saved: fullNarration ? 'Use the narration already saved with this document. No voice service or model is needed for playback.' : 'Import a reading package or prepare this document to add saved narration.',
  };
  $('engine-hint').textContent = hints[prefs.voiceEngine];
  $('audio-summary').textContent = player.usesAudio ? `${player.manifest.voice || 'Saved voice'} · ${player.audio.timing === 'word' ? 'word' : 'sentence'} highlights · saved audio` : (prefs.voiceEngine === 'device' ? "Your device's voice · no account needed" : 'Natural audio · prepare in Voice & audio');
  if (fullNarration) {
    const timed = fullNarration.chunks.every((chunk) => chunk.timing === 'word');
    const first = fullNarration.chunks[0].from, end = fullNarration.chunks.at(-1).to;
    const coverage = first === 0 && end === current?.doc.words.length ? 'Whole document' : `Words ${first + 1}–${end}`;
    $('saved-audio-detail').textContent = `${fullNarration.voice || 'Saved voice'} · ${coverage} · ${timed ? 'word highlights' : 'sentence highlights where word timing is unavailable'}. Saved on this device.`;
  }
}
function showNarration() { updateNarrationUI(); openDialog(dlgNarration); }
for (const id of ['btn-narration','btn-listen-prepare']) $(id).addEventListener('click', showNarration);
$('btn-natural-settings').addEventListener('click', () => { dlgSettings.close(); showNarration(); });
$('natural-voice').replaceChildren(...NATURAL_VOICES.map((voice) => Object.assign(document.createElement('option'), { value: voice.id, textContent: voice.name })));
$('voice-engine').addEventListener('change', (event) => {
  prefs.voiceEngine = event.target.value;
  player.setEngine(prefs.voiceEngine);
  if (fullNarration && audioCompatible(fullNarration)) player.attachAudio(fullNarration);
  else player.removeAudio();
  setSpeech(true);
  updateNarrationUI();
});
$('natural-voice').addEventListener('change', (event) => {
  prefs.naturalVoice = event.target.value; store.savePrefs(prefs);
  if (!fullNarration || !audioCompatible(fullNarration)) player.removeAudio();
  updateNarrationUI();
});
$('local-endpoint').addEventListener('change', (event) => { prefs.localEndpoint = event.target.value.trim() || '/local-voice'; store.savePrefs(prefs); });
function preparationProgress(progress) {
  const meter = $('audio-progress');
  if (Number.isFinite(progress.progress)) { meter.max = 100; meter.value = progress.progress; } else meter.removeAttribute('value');
  $('audio-progress-label').textContent = progress.phase === 'generating' ? `Preparing passage ${progress.completed + 1} of ${progress.total}…` : progress.phase === 'ready' ? 'Your narration is ready.' : `Downloading the voice model${progress.file ? ` · ${progress.file}` : ''}…`;
}
async function prepareAudio(range = {}, { save = true, closeAfter = false } = {}) {
  if (!current || voicePreparation) return false;
  const source = current, epoch = documentEpoch;
  if (!['browser','local'].includes(prefs.voiceEngine)) { showNarration(); return false; }
  player.pause();
  stopPreview();
  const controller = voicePreparation = new AbortController();
  $('preparation-status').hidden = false;
  updateNarrationUI();
  if (!dlgNarration.open) openDialog(dlgNarration);
  try {
    const manifest = await prepareNaturalVoice({ doc: source.doc, text: source.text, engine: prefs.voiceEngine,
      voice: prefs.naturalVoice, endpoint: prefs.localEndpoint, token: $('local-token').value,
      signal: controller.signal, onProgress: preparationProgress, ...range });
    if (controller.signal.aborted || epoch !== documentEpoch) return false;
    player.attachAudio(manifest);
    if (save) {
      fullNarration = manifest;
      try {
        const persistent = await store.saveAudio(source.meta.id, manifest);
        if (!persistent) toast('Audio is ready for this session. Save a reading package to keep it.', 6000);
      } catch { toast('Device storage is full. Save a reading package to keep this narration.', 6000); }
    }
    setSpeech(true);
    $('audio-progress-label').textContent = closeAfter ? 'Your selected passage is ready.' : 'Ready. Close this panel and tap play.';
    if (closeAfter) dlgNarration.close();
    return true;
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Voice preparation canceled.' : error.message || 'Voice preparation failed.';
    $('audio-progress-label').textContent = message;
    toast(message, 7000); return false;
  } finally {
    if (voicePreparation === controller) voicePreparation = null;
    updateNarrationUI();
  }
}
$('btn-prepare-audio').addEventListener('click', () => {
  if (!current) return;
  const scope = $('prepare-scope').value;
  if (scope === 'selection') {
    if (!selectedPassage) return toast('Select a passage in Read along mode first.');
    return prepareAudio({ from: selectedPassage.start, to: selectedPassage.end });
  }
  if (scope === 'section') {
    const section = current.meta.sections?.[Math.max(0,sectionAt(player.index))];
    if (section) {
      const from = current.doc.words.findIndex((word) => word.s >= section.start);
      const last = current.doc.words.findIndex((word) => word.s >= section.end);
      return prepareAudio({ from: Math.max(0,from), to: last < 0 ? current.doc.words.length : last });
    }
  }
  return prepareAudio();
});
$('btn-cancel-audio').addEventListener('click', () => voicePreparation?.abort());
let previewNarrator = null;
function stopPreview() {
  previewNarrator?.pause();
  if (testingDeviceVoice) { speechSynthesis.cancel(); testingDeviceVoice = false; }
}
$('btn-preview-natural').addEventListener('click', async () => {
  if (prefs.voiceEngine === 'device') { $('btn-test-voice').click(); return; }
  if (voicePreparation) return;
  const controller = voicePreparation = new AbortController();
  $('preparation-status').hidden = false; updateNarrationUI();
  previewNarrator?.dispose();
  try {
    const text = 'Take your time. A good sentence is worth listening to.';
    const doc = buildDoc(text);
    const manifest = await prepareNaturalVoice({ doc, text, engine: prefs.voiceEngine, voice: prefs.naturalVoice,
      endpoint: prefs.localEndpoint, token: $('local-token').value, signal: controller.signal, onProgress: preparationProgress });
    previewNarrator = new NativeAudioNarrator({ onError: (error) => toast(String(error)), onState: (playing) => { if (!playing) $('audio-progress-label').textContent = 'Preview finished.'; } });
    previewNarrator.load(doc, text, manifest); previewNarrator.setRate(prefs.speechRate);
    await previewNarrator.play();
    $('audio-progress-label').textContent = 'Preview ready. If sound was blocked, prepare a document and tap play.';
  } catch (error) { $('audio-progress-label').textContent = error.name === 'AbortError' ? 'Preview canceled.' : error.message; }
  finally { if (voicePreparation === controller) voicePreparation = null; updateNarrationUI(); }
});
dlgNarration.addEventListener('close', stopPreview);
dlgSettings.addEventListener('close', stopPreview);
$('btn-use-audio').addEventListener('click', () => {
  if (!fullNarration) return;
  prefs.voiceEngine = 'saved'; player.setEngine('saved'); player.attachAudio(fullNarration); setSpeech(true); dlgNarration.close();
});
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function filename() { return (current?.meta.title || 'reading').replace(/[^\p{L}\p{N} ._-]/gu,'').slice(0,90) || 'reading'; }
$('btn-export-package').addEventListener('click', async () => {
  try {
    if (!fullNarration || !current) return;
    const metadata = { title: current.meta.title, source: current.meta.source, sections: current.meta.sections, metadata: current.meta.metadata,
      readingPrefs: { highlightColor: prefs.highlightColor, highlightStyle: prefs.highlightStyle, highlightOpacity: prefs.highlightOpacity } };
    const first = fullNarration.chunks[0].from, end = fullNarration.chunks.at(-1).to;
    let manifest = fullNarration;
    if (first > 0 || end < current.doc.words.length) {
      const startOffset = current.doc.words[first].s, endOffset = current.doc.words[end - 1].s + current.doc.words[end - 1].t.length;
      manifest = { ...fullNarration, text: current.text.slice(startOffset,endOffset), chunks: fullNarration.chunks.map((chunk) => ({ ...chunk,
        from: chunk.from - first, to: chunk.to - first, timings: chunk.timings.map((timing) => ({ ...timing,index: timing.index - first })) })) };
      metadata.sections = (current.meta.sections || []).filter((section) => section.end > startOffset && section.start < endOffset)
        .map((section) => ({ ...section,start: Math.max(0,section.start - startOffset),end: Math.min(endOffset,section.end) - startOffset }));
      metadata.title += ' · prepared passage';
    }
    download(await serializeAudioPackage(manifest, metadata), `${filename()}.readalong`);
  } catch (error) { toast(error.message, 6000); }
});
$('btn-export-audio').addEventListener('click', async () => {
  try {
    if (!fullNarration) return;
    const audio = await exportNarrationAudio(fullNarration);
    download(audio, `${filename()}.${audio.type.includes('wav') ? 'wav' : 'mp3'}`);
    toast('Audiobook downloaded. Add it to Apple Books on your Mac and sync it to your iPhone.', 8000);
  } catch (error) { toast(error.message, 6000); }
});
$('btn-delete-audio').addEventListener('click', async () => {
  if (!current) return;
  voicePreparation?.abort(); player.removeAudio(); fullNarration = null;
  await store.deleteAudio(current.meta.id); updateNarrationUI(); toast('Saved audio removed from this device.');
});

// Ordinary audio participates in system playback controls. Actual vehicle
// behavior depends on Safari/iOS; this is not a native CarPlay application.
function setMediaMetadata() {
  if (!current || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: current.meta.title, artist: current.meta.metadata?.author || 'Sajan Acharya Reader', album: 'Reading library',
    artwork: [{ src: new URL('icon.svg', location.href).href, sizes: 'any', type: 'image/svg+xml' }] });
}
function updateMediaPosition() {
  if (!player.usesAudio || !navigator.mediaSession?.setPositionState) return;
  const { duration, currentTime } = player.audio;
  try { if (duration > 0) navigator.mediaSession.setPositionState({ duration, playbackRate: player.rate, position: Math.min(currentTime,duration) }); } catch { /* Some OS versions expose only transport controls. */ }
}
function setupMediaControls() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => player.play(), pause: () => player.pause(), stop: () => player.pause(),
    seekbackward: (event) => player.skipSeconds(-(event.seekOffset || 15)),
    seekforward: (event) => player.skipSeconds(event.seekOffset || 15),
    seekto: (event) => { if (player.usesAudio && Number.isFinite(event.seekTime)) player.skipSeconds(event.seekTime - player.audio.currentTime); },
    previoustrack: () => skipSection(-1), nexttrack: () => skipSection(1),
  };
  for (const [action,handler] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action,handler); } catch { /* Unsupported action. */ } }
}
function skipSection(delta) {
  if (!current) return;
  const sections = current.meta.sections || [];
  const section = sections[Math.max(0,Math.min(sections.length - 1, sectionAt(player.index) + delta))];
  clearPassage();
  if (section) player.seek(wordAtOffset(current.doc.words,section.start));
  else player.skipSeconds(delta * 15);
}

// ---------------------------------------------------------------- start

async function init() {
  claimPlaybackAudio();
  applyAppearance();
  player.wpm = Math.min(MAX_WPM, Math.max(MIN_WPM, prefs.wpm));
  player.setRate(prefs.speechRate);
  player.setEngine(prefs.voiceEngine);
  $('speech-rate').value = prefs.speechRate;
  $('speech-rate-label').textContent = `${prefs.speechRate.toFixed(2)}×`;
  el.wpm.value = player.wpm;
  el.wpmLabel.textContent = `${player.wpm} wpm`;
  el.play.disabled = true;

  if (speechSupported()) {
    populateVoices();
    speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
    player.speech = prefs.speech;
    el.voice.setAttribute('aria-pressed', String(prefs.speech));
  } else if (prefs.voiceEngine !== 'device') player.speech = prefs.speech;
  applyMode();
  updateNarrationUI();
  setupMediaControls();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  updateStatus();

  if (location.hash === '#import') {
    showReader();
    receiveFromBookmarklet();
    return;
  }
  if (prefs.lastDocId && (await openStored(prefs.lastDocId).catch(() => false))) {
    showLanding(current.meta);
    return;
  }
  showPlaceholder('Tap + to import something to read');
  showLanding();
}

init();
