const CACHE = 'reader-shell-v2';
const RELEASE = '20261011';
const SHELL = [ './', 'index.html', 'icon.svg', 'manifest.webmanifest',
  'css/style.css', 'css/landing.css', 'css/experience.css', 'css/immersive.css',
  'js/app.js', 'js/engine.js', 'js/speech.js', 'js/store.js', 'js/text.js',
  'js/orp.js', 'js/importers.js', 'js/bookmarklet.js', 'js/landing.js',
  'js/playback.js', 'js/narration.js', 'js/natural-voice.js', 'js/immersive.js',
  'brand/brand.css', 'brand/theme.js', 'brand/elastic.js', 'brand/nepal-flag.svg',
  'brand/logo-mark.png', 'brand/newsreader-latin-wght-normal.woff2', 'brand/nunito-sans-latin-wght-normal.woff2',
  'vendor/Readability.js', 'vendor/jszip.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
];
self.addEventListener('install', (event) => {
  const requests = SHELL.map((path) => {
    const url = new URL(path, self.location.href);
    if (/\.(css|js)$/.test(url.pathname)) url.searchParams.set('v', RELEASE);
    return new Request(url, { cache: 'reload' });
  });
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('reader-shell-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/local-voice')) return;
  event.respondWith((async () => {
    let cache;
    try { cache = await caches.open(CACHE); } catch { /* Network reading remains available when persistent storage is blocked. */ }
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (cache && response.ok && (request.mode === 'navigate' || /\.(css|js|mjs|woff2|svg|png|bcmap)$/.test(url.pathname))) {
        try { await cache.put(request, response.clone()); } catch { /* Storage pressure must not hide a successful network response. */ }
      }
      return response;
    } catch (error) {
      const saved = await cache?.match(request, { ignoreSearch: true });
      if (saved) return saved;
      if (request.mode === 'navigate') return (await cache?.match('index.html')) || Response.error();
      throw error;
    }
  })());
});
