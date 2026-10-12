import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../sw.js',import.meta.url),'utf8');
async function handle({ cache, fetch, mode = 'cors' }) {
  const listeners = {};
  vm.runInNewContext(source, {
    self: { location: new URL('https://reader.example/sw.js'), addEventListener: (name,fn) => { listeners[name] = fn; } },
    caches: { open: async () => { if (cache instanceof Error) throw cache; return cache; } }, fetch, URL, Response,
  });
  let response;
  listeners.fetch({ request: { method: 'GET',url: 'https://reader.example/js/app.js',mode }, respondWith: (promise) => { response = promise; } });
  return (await response).text();
}
test('successful network content remains fresh when cache writes exceed quota', async () => {
  const cache = { put: async () => { throw new Error('Quota exceeded'); },match: async () => new Response('old content') };
  assert.equal(await handle({ cache,fetch: async () => new Response('fresh content') }),'fresh content');
});
test('blocked cache storage does not prevent network reading', async () => {
  assert.equal(await handle({ cache: new Error('Storage blocked'),fetch: async () => new Response('fresh content') }),'fresh content');
});
test('offline requests use the cached reader shell', async () => {
  const cache = { match: async (request) => typeof request === 'string' ? new Response('reader shell') : null };
  assert.equal(await handle({ cache,mode: 'navigate',fetch: async () => { throw new Error('Offline'); } }),'reader shell');
});
