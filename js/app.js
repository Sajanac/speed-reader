import { splitWord } from './orp.js';
import { buildDoc, durationMs, sentenceStart, sentenceEnd } from './text.js';
import { Player, MIN_WPM, MAX_WPM } from './engine.js';
import { speechSupported, listVoices, pickVoice, voiceLabel, claimPlaybackAudio, unlockAudio } from './speech.js';
import { importFile, articleFromHtml } from './importers.js';
import { bookmarkletHref, appUrl } from './bookmarklet.js';
import * as store from './store.js';

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

Use the slider below to change speed, the arrows to jump back or forward ten words, and the timeline to move anywhere in the text. Turn on Read aloud to hear the text in your device's voice while the words follow along.`;

const prefs = store.loadPrefs();
let current = null; // { meta, doc }
let dragging = false;
let wakeLock = null;

const player = new Player({
  onWord: (i) => render(i),
  onState: (playing) => {
    document.body.classList.toggle('reading', playing);
    updatePlayButton(playing);
    updateContext();
    updateStatus();
    if (playing) requestWakeLock();
    else {
      releaseWakeLock();
      saveProgress(true);
    }
  },
  onError: (err) => {
    toast(err === 'not-allowed' ? 'Tap play to start reading aloud.' : `Speech stopped: ${err}`);
  },
});

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
  if (!fontSpec) measureFont();
  canvas.font = fontSpec;
  const p = canvas.measureText(pivot).width / 2;
  const need = Math.max(canvas.measureText(before).width + p, canvas.measureText(after).width + p);
  const half = el.reader.clientWidth / 2 - 4;
  el.word.style.setProperty('--fit', need > half && need > 0 ? (half / need).toFixed(3) : '1');
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
  if (!dragging) el.scrub.value = i;
  updateLabels(i);
  if (!player.playing) updateContext();
  saveProgress(false);
}

function updateLabels(i) {
  const n = current.doc.words.length;
  const pct = n > 1 ? Math.round((i / (n - 1)) * 100) : 100;
  el.pos.textContent = `${(i + 1).toLocaleString()} / ${n.toLocaleString()} · ${pct}%`;
  let ms;
  if (player.speech) {
    const wpm = player.speaker.measuredWpm || player.wpm;
    ms = ((n - i - 1) * 60000) / wpm;
  } else {
    ms = durationMs(current.doc, i, n, player.wpm);
  }
  el.time.textContent = `${formatDuration(ms)} left`;
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
  if (!current || player.playing) {
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
    const v = player.voice ? player.voice.name : 'default voice';
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

function loadDocument(meta, text) {
  player.pause(); // saves the previous document's position
  saveProgress(true);
  const doc = buildDoc(text);
  if (!doc.words.length) {
    toast('That text has no words to read.');
    return;
  }
  current = { meta, doc };
  lastSaved = meta.position;
  el.title.textContent = meta.title;
  document.title = `${meta.title} · Speed Reader`;
  el.scrub.max = Math.max(0, doc.words.length - 1);
  el.play.disabled = false;
  player.load(doc, Math.min(meta.position || 0, doc.words.length - 1));
  prefs.lastDocId = meta.id;
  store.savePrefs(prefs);
}

async function openText({ title, text, source, url = '' }) {
  const words = buildDoc(text).words.length;
  if (!words) throw new Error('No words found.');
  const id = store.docId({ url, text });
  const meta = await store.saveDoc({ id, title: title || 'Untitled', source, url, text, wordCount: words });
  loadDocument(meta, text);
  if (meta.position > 0) toast(`Resuming at word ${(meta.position + 1).toLocaleString()}.`);
}

async function openStored(id) {
  const saved = await store.getDoc(id);
  if (!saved) return false;
  loadDocument(saved.meta, saved.text);
  return true;
}

async function runImport(task, label) {
  toast(`${label}…`, 60000);
  try {
    await openText(await task());
    toast('Ready. Tap play or press space.');
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 6000);
    return false;
  }
}

// ---------------------------------------------------------------- dialogs

const dlgImport = $('dlg-import');
const dlgLibrary = $('dlg-library');
const dlgSettings = $('dlg-settings');

function openDialog(d) {
  player.pause();
  d.showModal();
}

// Close when tapping the backdrop.
for (const d of [dlgImport, dlgLibrary, dlgSettings]) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
}

$('btn-import').addEventListener('click', () => openDialog(dlgImport));
$('btn-settings').addEventListener('click', () => {
  populateVoices();
  openDialog(dlgSettings);
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
  if (file && (await runImport(() => importFile(file), `Reading ${file.name}`))) dlgImport.close();
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
  if (file && (await runImport(() => importFile(file), `Reading ${file.name}`)) && dlgImport.open) dlgImport.close();
});

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
          current = null;
          el.title.textContent = 'Speed Reader';
          el.play.disabled = true;
          el.scrub.max = 0;
          el.pos.textContent = '';
          el.time.textContent = '';
          el.context.classList.remove('show');
          showPlaceholder('Tap + to import something to read');
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
  fontSpec = '';
  if (current) render(player.index);
}

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
    if (!document.body.classList.contains('reading')) return;
    e.preventDefault();
    e.stopPropagation();
    player.pause();
  },
  true,
);

el.play.addEventListener('click', () => player.toggle());
el.reader.addEventListener('click', () => current && player.toggle());
el.reader.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    player.toggle();
  }
});
$('btn-back').addEventListener('click', () => player.skip(-10));
$('btn-fwd').addEventListener('click', () => player.skip(10));

// While the thumb is held, don't move it from under the finger.
el.scrub.addEventListener('pointerdown', () => (dragging = true));
for (const type of ['pointerup', 'pointercancel', 'change']) {
  el.scrub.addEventListener(type, () => (dragging = false));
}
el.scrub.addEventListener('input', () => player.seek(Number(el.scrub.value), { debounceSpeech: true }));
el.scrub.addEventListener('change', () => saveProgress(true));

el.wpm.addEventListener('input', () => setWpm(Number(el.wpm.value)));
$('wpm-down').addEventListener('click', () => setWpm(player.wpm - 25));
$('wpm-up').addEventListener('click', () => setWpm(player.wpm + 25));

el.voice.addEventListener('click', () => {
  if (!speechSupported()) return;
  if (!player.voice) player.voice = pickVoice(prefs.voiceURI);
  const on = !player.speech;
  player.setSpeech(on);
  prefs.speech = on;
  store.savePrefs(prefs);
  el.voice.setAttribute('aria-pressed', String(on));
  updateStatus();
  if (current) updateLabels(player.index);
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (t.matches?.('textarea, select, input:not([type=range])')) return;
  // Let focused controls keep their native keys (Space clicks a button,
  // arrows move a slider).
  if (e.key === ' ' && t.matches?.('button, summary, a')) return;
  if (e.key.startsWith('Arrow') && t.matches?.('input[type=range]')) return;
  const keys = {
    ' ': () => player.toggle(),
    ArrowLeft: () => player.skip(-10),
    ArrowRight: () => player.skip(10),
    ArrowUp: () => setWpm(player.wpm + 25),
    ArrowDown: () => setWpm(player.wpm - 25),
  };
  const fn = keys[e.key];
  if (!fn || !current) return;
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
  if (speechSupported()) {
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

// ---------------------------------------------------------------- start

async function init() {
  claimPlaybackAudio();
  applyAppearance();
  player.wpm = Math.min(MAX_WPM, Math.max(MIN_WPM, prefs.wpm));
  el.wpm.value = player.wpm;
  el.wpmLabel.textContent = `${player.wpm} wpm`;
  el.play.disabled = true;

  if (speechSupported()) {
    populateVoices();
    speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
    player.speech = prefs.speech;
    el.voice.setAttribute('aria-pressed', String(prefs.speech));
  } else {
    el.voice.disabled = true;
    el.voice.title = 'Speech is not supported in this browser';
  }
  updateStatus();

  if (location.hash === '#import') {
    receiveFromBookmarklet();
    return;
  }
  if (prefs.lastDocId && (await openStored(prefs.lastDocId).catch(() => false))) return;
  showPlaceholder('Tap + to import something to read');
}

init();
