const CACHE = 'lm-v1';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './vendor/pdf.js', './vendor/pdf.worker.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // vendor が無い環境でも install を失敗させない
    await Promise.all(ASSETS.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// キャッシュ優先。オフラインのライブ会場で確実に立ち上がることを最優先にする。
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) {
      fetch(req).then(r => { if (r && r.ok) caches.open(CACHE).then(c => c.put(req, r)); }).catch(() => {});
      return hit;
    }
    try {
      const r = await fetch(req);
      if (r && r.ok && new URL(req.url).origin === location.origin) {
        const c = await caches.open(CACHE);
        c.put(req, r.clone());
      }
      return r;
    } catch (err) {
      const fb = await caches.match('./index.html');
      if (fb) return fb;
      throw err;
    }
  })());
});
