// Minimal service worker: cache the app shell so it opens instantly; API calls always go to the network.
const CACHE = 'bookshelf-v1';
const SHELL = ['/', '/static/styles.css', '/static/app.js', '/static/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // Network first so updates show up, fall back to cache when offline.
  e.respondWith(fetch(e.request).then((r) => {
    if (SHELL.includes(url.pathname)) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request)));
});
