// Network first, falling back to the cache: always fresh when online, works offline.
// The test build is the same code under /test/, so it has its own cache name,
// and each build only ever cleans up its own old caches.
const PREFIX = self.registration.scope.includes('/test/') ? 'pawsterior-test-' : 'pawsterior-v';
const CACHE = `${PREFIX}3`;
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'src/app.js', 'src/model.js', 'src/insights.js', 'src/sounds.js', 'src/env.js', 'src/seed.js', 'src/sync.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
