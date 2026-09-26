// Local persistence: preferences in localStorage, documents and reading
// progress in IndexedDB (with an in-memory fallback if it is unavailable).

const PREFS_KEY = 'speed-reader.prefs';

export const DEFAULT_PREFS = {
  wpm: 300,
  accent: 'teal',
  font: 'sans',
  size: 1,
  speech: false,
  voiceURI: '',
  lastDocId: '',
};

export function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
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
      const r = indexedDB.open('speed-reader', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'id' });
        r.result.createObjectStore('text', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch(() => null);
  }
  return dbPromise;
}

// In-memory fallback when IndexedDB can't be opened.
const mem = { meta: new Map(), text: new Map() };

async function stores(mode) {
  const db = await openDb();
  if (!db) return null;
  const tx = db.transaction(['meta', 'text'], mode);
  return { meta: tx.objectStore('meta'), text: tx.objectStore('text'), done: txDone(tx) };
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
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id) {
  const s = await stores('readonly');
  if (!s) {
    const meta = mem.meta.get(id);
    return meta ? { meta, text: mem.text.get(id) } : null;
  }
  const [meta, text] = await Promise.all([req(s.meta.get(id)), req(s.text.get(id))]);
  return meta && text ? { meta, text: text.text } : null;
}

// Save a document, keeping the reading position if it already exists.
export async function saveDoc({ id, title, source, url = '', text, wordCount }) {
  const s = await stores('readwrite');
  const now = Date.now();
  if (!s) {
    const prev = mem.meta.get(id);
    mem.meta.set(id, { id, title, source, url, wordCount, position: prev?.position || 0, createdAt: prev?.createdAt || now, updatedAt: now });
    mem.text.set(id, text);
    return mem.meta.get(id);
  }
  const prev = await req(s.meta.get(id));
  const meta = { id, title, source, url, wordCount, position: prev?.position || 0, createdAt: prev?.createdAt || now, updatedAt: now };
  s.meta.put(meta);
  s.text.put({ id, text });
  await s.done;
  return meta;
}

export async function setPosition(id, position) {
  const s = await stores('readwrite');
  if (!s) {
    const m = mem.meta.get(id);
    if (m) Object.assign(m, { position, updatedAt: Date.now() });
    return;
  }
  const meta = await req(s.meta.get(id));
  if (!meta) return;
  s.meta.put({ ...meta, position, updatedAt: Date.now() });
  await s.done;
}

export async function deleteDoc(id) {
  const s = await stores('readwrite');
  if (!s) {
    mem.meta.delete(id);
    mem.text.delete(id);
    return;
  }
  s.meta.delete(id);
  s.text.delete(id);
  await s.done;
}
