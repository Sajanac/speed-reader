import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, sanitizePrefs, docId, saveDoc, getDoc, listDocs, setPosition,
  saveAudio, getAudio, deleteDoc } from '../js/store.js';

// Avoid Node's experimental localStorage getter; individual tests provide
// browser-shaped storage explicitly when persistence is part of the scenario.
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

test('restored preferences reject unsupported reading options and bound numeric controls', () => {
  const prefs = sanitizePrefs({ mode: 'unknown', voiceEngine: 'remote', highlightStyle: 'script',
    highlightColor: 'transparent', wpm: 5000, speechRate: 0.1, highlightOpacity: -5,
    lineHeight: Infinity, fontSize: '28', naturalVoice: {}, localEndpoint: null,
    follow: false, sentenceHighlight: false });
  assert.equal(prefs.mode, DEFAULT_PREFS.mode);
  assert.equal(prefs.voiceEngine, DEFAULT_PREFS.voiceEngine);
  assert.equal(prefs.highlightStyle, DEFAULT_PREFS.highlightStyle);
  assert.equal(prefs.highlightColor, DEFAULT_PREFS.highlightColor);
  assert.equal(prefs.wpm, 1000);
  assert.equal(prefs.speechRate, 0.5);
  assert.equal(prefs.highlightOpacity, 0.15);
  assert.equal(prefs.lineHeight, DEFAULT_PREFS.lineHeight);
  assert.equal(prefs.fontSize, 28);
  assert.equal(prefs.naturalVoice, DEFAULT_PREFS.naturalVoice);
  assert.equal(prefs.localEndpoint, DEFAULT_PREFS.localEndpoint);
  assert.equal(prefs.follow, false);
  assert.equal(prefs.sentenceHighlight, false);
});

test('URL identity ignores fragment changes while separate URLs retain separate documents', () => {
  assert.equal(docId({ url: 'https://example.com/post#first', text: 'One' }),
    docId({ url: 'https://example.com/post#second', text: 'Different words' }));
  assert.notEqual(docId({ url: 'https://example.com/first', text: 'One' }),
    docId({ url: 'https://example.com/second', text: 'One' }));
});

test('re-importing unchanged text preserves narration and position; changed text invalidates both', async () => {
  // Node has no IndexedDB. Exercise the same supported session fallback used by
  // browsers where persistent storage cannot be opened.
  const id = 'test:article-reimport';
  const original = { id, title: 'Original title', source: 'article', text: 'One two three.', wordCount: 3,
    sections: [{ title: 'Introduction', start: 0, end: 14 }] };
  await saveDoc(original);
  const manifest = { version: 1, text: original.text, chunks: [], voice: 'af_heart' };
  assert.equal(await saveAudio(id, manifest), false);
  await setPosition(id, 2);
  const first = await getDoc(id);
  const unchanged = await saveDoc({ ...original, title: 'Updated title' });
  assert.equal(unchanged.position, 2);
  assert.equal(unchanged.createdAt, first.meta.createdAt);
  assert.deepEqual(await getAudio(id), manifest);
  const changed = await saveDoc({ ...original, text: 'Entirely different article.', wordCount: 3,
    sections: [{ title: 'Replacement', start: 0, end: 27 }] });
  assert.equal(changed.position, 0);
  assert.equal(changed.createdAt, first.meta.createdAt);
  assert.equal(await getAudio(id), null);
  assert.equal((await getDoc(id)).text, 'Entirely different article.');
  await deleteDoc(id);
});

test('deleting a saved document removes its text and prepared narration together', async () => {
  const id = 'test:delete-audio';
  await saveDoc({ id, title: 'Delete me', source: 'paste', text: 'One.', wordCount: 1 });
  await saveAudio(id, { version: 1, text: 'One.', chunks: [] });
  await deleteDoc(id);
  assert.equal(await getDoc(id), null);
  assert.equal(await getAudio(id), null);
  await setPosition(id, 1);
  assert.equal(await getDoc(id), null);
});

function useLocalStorage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  return values;
}

test('the final seek is mirrored synchronously and survives a fresh module before an async commit', async (t) => {
  const values = useLocalStorage(t), id = 'test:immediate-reload';
  const document = { id, title: 'Bookmark test', source: 'paste',
    text: 'One two three four five.', wordCount: 5 };
  await saveDoc(document);
  const writes = [setPosition(id, 1), setPosition(id, 3), setPosition(id, 1)];
  // No await has happened since the seeks. The page can be destroyed now.
  assert.equal(JSON.parse(values.get('speed-reader.positions'))[0].position, 1);
  const reloaded = await import(`../js/store.js?reload=${Date.now()}`);
  const restored = await reloaded.saveDoc(document);
  assert.equal(restored.position, 1);
  assert.equal((await reloaded.getDoc(id)).meta.position, 1);
  assert.equal((await reloaded.listDocs()).find((meta) => meta.id === id).position, 1);
  await Promise.all(writes);
  assert.equal((await getDoc(id)).meta.position, 1);
  await deleteDoc(id);
});

test('cursor fingerprints prevent a changed article at the same URL from resuming stale text', async (t) => {
  const values = useLocalStorage(t), id = 'url:https://example.com/revised';
  await saveDoc({ id, title: 'Original', source: 'article', text: 'One two three four.', wordCount: 4 });
  await setPosition(id, 3);
  assert.equal(JSON.parse(values.get('speed-reader.positions')).length, 1);
  const revised = await saveDoc({ id, title: 'Revised', source: 'article', text: 'A fresh article.', wordCount: 3 });
  assert.equal(revised.position, 0);
  assert.equal(values.has('speed-reader.positions'), false);
  assert.equal((await getDoc(id)).meta.position, 0);
  assert.equal((await listDocs()).find((meta) => meta.id === id).position, 0);
  await setPosition(id, 2);
  const deleting = deleteDoc(id);
  assert.equal(values.has('speed-reader.positions'), false);
  await deleting;
});

test('position mirrors reject invalid seeks, constrain bounds, and cap document entries', async (t) => {
  const values = useLocalStorage(t);
  for (let index = 0; index < 205; index++) {
    const id = `test:bounded-cursor-${index}`;
    await saveDoc({ id, title: 'Bounded', source: 'paste', text: 'One two.', wordCount: 2 });
    await setPosition(id, 99);
  }
  const records = JSON.parse(values.get('speed-reader.positions'));
  assert.equal(records.length, 200);
  assert.ok(records.every((record) => record.position === 1));
  assert.equal(records[0].id, 'test:bounded-cursor-204');
  await setPosition('test:bounded-cursor-204', -1);
  await setPosition('test:bounded-cursor-204', NaN);
  assert.equal((await getDoc('test:bounded-cursor-204')).meta.position, 1);
  for (let index = 0; index < 205; index++) await deleteDoc(`test:bounded-cursor-${index}`);
});

test('blocked synchronous storage still permits document progress and deletion', async (t) => {
  useLocalStorage(t);
  globalThis.localStorage.getItem = globalThis.localStorage.setItem = globalThis.localStorage.removeItem = () => { throw new Error('Storage blocked'); };
  const id = 'test:blocked-cursor-storage';
  await saveDoc({ id, title: 'Private storage', source: 'paste', text: 'One two three.', wordCount: 3 });
  await setPosition(id, 2);
  assert.equal((await getDoc(id)).meta.position, 2);
  await deleteDoc(id);
  assert.equal(await getDoc(id), null);
});
