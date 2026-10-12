// Local persistence: preferences in localStorage, documents and reading
// progress in IndexedDB (with an in-memory fallback if it is unavailable).

const PREFS_KEY = 'speed-reader.prefs';
const POSITIONS_KEY = 'speed-reader.positions';
const MAX_POSITION_RECORDS = 200;
const knownDocuments = new Map();

export const DEFAULT_PREFS = {
  wpm: 300,
  accent: 'teal',
  font: 'sans',
  size: 1,
  speech: false,
  voiceURI: '',
  lastDocId: '',
  mode: 'rsvp',
  speechRate: 1,
  highlightColor: 'lavender',
  highlightStyle: 'half',
  highlightOpacity: 0.65,
  fontSize: 22,
  lineHeight: 1.85,
  sentenceHighlight: true,
  follow: true,
  voiceEngine: 'device',
  naturalVoice: 'af_heart',
  localEndpoint: '/local-voice',
};

export function loadPrefs() {
  try {
    return sanitizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function sanitizePrefs(saved = {}) {
  const p = { ...DEFAULT_PREFS, ...saved };
  const choices = {
    mode: ['rsvp', 'immersive', 'listen'], accent: ['teal', 'orange'], font: ['sans', 'serif', 'mono'],
    highlightColor: ['lavender', 'mint', 'peach', 'blush', 'sky', 'butter', 'cream', 'sand', 'taupe', 'slate', 'gray'],
    highlightStyle: ['full', 'half', 'underline', 'pill'], voiceEngine: ['device', 'browser', 'local', 'saved'],
  };
  for (const [key, values] of Object.entries(choices)) if (!values.includes(p[key])) p[key] = DEFAULT_PREFS[key];
  const limits = { wpm: [100, 1000], size: [0.7, 1.6], speechRate: [0.5, 3], highlightOpacity: [0.15, 1], fontSize: [16, 34], lineHeight: [1.35, 2.5] };
  for (const [key, [lo, hi]] of Object.entries(limits)) p[key] = Number.isFinite(Number(p[key])) ? Math.min(hi, Math.max(lo, Number(p[key]))) : DEFAULT_PREFS[key];
  for (const key of ['speech', 'sentenceHighlight', 'follow']) p[key] = Boolean(p[key]);
  for (const key of ['voiceURI', 'lastDocId', 'naturalVoice', 'localEndpoint']) if (typeof p[key] !== 'string') p[key] = DEFAULT_PREFS[key];
  return p;
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable (private browsing, quota); prefs just won't persist.
  }
}

// Stable id so re-importing the same page or text resumes where you left off.
export function docId({ url, text }) {
  if (url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return 'url:' + u.href;
    } catch {
      // fall through to a content hash
    }
  }
  return 'txt:' + hash(text);
}

// cyrb53 string hash.
function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// IndexedDB commits can finish after a tab reload. Keep the latest cursor in
// synchronous storage first, and bind it to the document's actual text so a
// revised article at the same URL cannot inherit an unrelated position.
function readPositionMirror() {
  try {
    const records = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '[]');
    if (!Array.isArray(records)) return [];
    return records.filter((record) => record && typeof record.id === 'string'
      && typeof record.contentHash === 'string' && Number.isInteger(record.position)
      && record.position >= 0 && Number.isFinite(record.updatedAt)).slice(0, MAX_POSITION_RECORDS);
  } catch { return []; }
}

function writePositionMirror(record) {
  try {
    const records = [record, ...readPositionMirror().filter((saved) => saved.id !== record.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_POSITION_RECORDS);
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(records));
  } catch { /* Persistent cursor storage can be unavailable; IndexedDB still works. */ }
}

function deletePositionMirror(id) {
  try {
    const records = readPositionMirror().filter((record) => record.id !== id);
    if (records.length) localStorage.setItem(POSITIONS_KEY, JSON.stringify(records));
    else localStorage.removeItem(POSITIONS_KEY);
  } catch { /* Storage can be blocked or full. */ }
}

function rememberDocument(meta, text) {
  const contentHash = typeof text === 'string' ? hash(text) : meta.contentHash;
  if (contentHash) knownDocuments.set(meta.id, { contentHash, wordCount: meta.wordCount });
  return contentHash;
}

function withMirroredPosition(meta, contentHash, records = readPositionMirror()) {
  const record = records.find((saved) => saved.id === meta.id && saved.contentHash === contentHash);
  if (!record) return meta;
  return { ...meta, position: Math.min(record.position, Math.max(0, meta.wordCount - 1)),
    updatedAt: Math.max(meta.updatedAt || 0, record.updatedAt) };
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const r = indexedDB.open('speed-reader', 2);
      r.onupgradeneeded = () => {
        for (const name of ['meta', 'text', 'audio']) {
          if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch(() => null);
  }
  return dbPromise;
}

// In-memory fallback when IndexedDB can't be opened.
const mem = { meta: new Map(), text: new Map(), audio: new Map() };

export function sanitizeSections(sections, textLength) {
  if (!Array.isArray(sections)) return [];
  return sections.filter((section) => section && Number.isInteger(section.start) && Number.isInteger(section.end)
    && section.start >= 0 && section.end > section.start && section.end <= textLength)
    .map((section, index) => ({ ...section, title: typeof section.title === 'string' ? section.title.slice(0,300) : `Section ${index + 1}` }))
    .sort((a,b) => a.start - b.start);
}

async function stores(mode) {
  const db = await openDb();
  if (!db) return null;
  const tx = db.transaction(['meta', 'text', 'audio'], mode);
  return { meta: tx.objectStore('meta'), text: tx.objectStore('text'), audio: tx.objectStore('audio'), done: txDone(tx) };
}

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function listDocs() {
  const s = await stores('readonly');
  const all = s ? await req(s.meta.getAll()) : [...mem.meta.values()];
  const records = readPositionMirror();
  const mirrored = await Promise.all(all.map(async (meta) => {
    let contentHash = meta.contentHash;
    // Old database entries predate content hashes. Only load their text if a
    // cursor mirror exists and needs validation; new entries use metadata.
    if (!contentHash && records.some((record) => record.id === meta.id)) {
      const stored = s ? await req(s.text.get(meta.id)) : { text: mem.text.get(meta.id) };
      if (typeof stored?.text === 'string') contentHash = hash(stored.text);
    }
    return withMirroredPosition(meta, contentHash, records);
  }));
  return mirrored.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id) {
  const s = await stores('readonly');
  if (!s) {
    const meta = mem.meta.get(id);
    if (!meta) return null;
    const text = mem.text.get(id);
    return { meta: withMirroredPosition(meta, rememberDocument(meta, text)), text };
  }
  const [meta, text] = await Promise.all([req(s.meta.get(id)), req(s.text.get(id))]);
  return meta && text ? { meta: withMirroredPosition(meta, rememberDocument(meta, text.text)), text: text.text } : null;
}

// Save a document, keeping the reading position if it already exists.
export async function saveDoc({ id, title, source, url = '', text, wordCount, sections = [], metadata = {} }) {
  sections = sanitizeSections(sections, text.length);
  metadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const contentHash = hash(text);
  const mirrored = readPositionMirror().find((record) => record.id === id);
  if (mirrored && mirrored.contentHash !== contentHash) deletePositionMirror(id);
  const s = await stores('readwrite');
  const now = Date.now();
  if (!s) {
    const prev = mem.meta.get(id);
    const changed = mem.text.has(id) && mem.text.get(id) !== text;
    if (changed) { mem.audio.delete(id); deletePositionMirror(id); }
    const meta = { id, title, source, url, wordCount, sections, metadata, contentHash,
      position: changed ? 0 : prev?.position || 0, createdAt: prev?.createdAt || now, updatedAt: now };
    mem.meta.set(id, changed ? meta : withMirroredPosition(meta, contentHash));
    mem.text.set(id, text);
    rememberDocument(meta, text);
    return mem.meta.get(id);
  }
  const [prev, prevText] = await Promise.all([req(s.meta.get(id)), req(s.text.get(id))]);
  const changed = prevText && prevText.text !== text;
  if (changed) { s.audio.delete(id); deletePositionMirror(id); }
  const base = { id, title, source, url, wordCount, sections, metadata, contentHash,
    position: changed ? 0 : prev?.position || 0, createdAt: prev?.createdAt || now, updatedAt: now };
  const meta = changed ? base : withMirroredPosition(base, contentHash);
  s.meta.put(meta);
  s.text.put({ id, text });
  await s.done;
  rememberDocument(meta, text);
  return meta;
}

export async function setPosition(id, position) {
  if (!Number.isInteger(position) || position < 0) return;
  const known = knownDocuments.get(id) || readPositionMirror().find((record) => record.id === id);
  if (known?.contentHash) {
    if (Number.isFinite(known.wordCount)) position = Math.min(position, Math.max(0, known.wordCount - 1));
    writePositionMirror({ id, contentHash: known.contentHash, position, updatedAt: Date.now() });
  }
  const s = await stores('readwrite');
  if (!s) {
    const m = mem.meta.get(id);
    if (m && (!known?.contentHash || m.contentHash === known.contentHash)) {
      Object.assign(m, withMirroredPosition({ ...m, position, updatedAt: Date.now() }, m.contentHash));
    }
    return;
  }
  const meta = await req(s.meta.get(id));
  if (!meta || (known?.contentHash && meta.contentHash && meta.contentHash !== known.contentHash)) return;
  s.meta.put(withMirroredPosition({ ...meta, position, updatedAt: Date.now() }, known?.contentHash || meta.contentHash));
  await s.done;
}

export async function deleteDoc(id) {
  deletePositionMirror(id);
  knownDocuments.delete(id);
  const s = await stores('readwrite');
  if (!s) {
    mem.meta.delete(id);
    mem.text.delete(id);
    mem.audio.delete(id);
    return;
  }
  s.meta.delete(id);
  s.text.delete(id);
  s.audio.delete(id);
  await s.done;
}

export async function saveAudio(id, manifest) {
  const s = await stores('readwrite');
  const record = { id, manifest, updatedAt: Date.now() };
  if (!s) { mem.audio.set(id, record); return false; }
  s.audio.put(record);
  await s.done;
  return true;
}

export async function getAudio(id) {
  const s = await stores('readonly');
  const record = s ? await req(s.audio.get(id)) : mem.audio.get(id);
  return record?.manifest || null;
}

export async function deleteAudio(id) {
  const s = await stores('readwrite');
  if (!s) { mem.audio.delete(id); return; }
  s.audio.delete(id);
  await s.done;
}
