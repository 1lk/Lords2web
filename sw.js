// Offline cache for the app shell (page, scripts, wasm, icons). Game data never goes through here: it is unpacked from the
// player's own installer and kept in IndexedDB.  VERSION is stamped by tools/package.sh; a new version installs side by side
// and takes over once every open tab has been closed, so scripts and wasm of different releases are never mixed.
const VERSION = 'ffbf13715b3a';
const CACHE = 'lords2-shell-' + VERSION;
const SHELL = [
  './', 'index.html', 'style.css', 'main.js', 'runtime.js', 'loader.js', 'lords2.wasm', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('lords2-shell-') && k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); } catch { return new Response('Offline', { status: 503, statusText: 'Offline' }); }
  })());
});
