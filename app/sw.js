/* API Radar — service worker: кешируем оболочку, сеть оставляем прямой */
const CACHE = 'apiradar-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './chat.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Каталог всегда из сети, но с кешем как запасным вариантом
  if (u.hostname.endsWith('apis.guru')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // Оболочка: сначала кеш, потом сеть
  if (e.request.method === 'GET' && u.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit =>
        hit || fetch(e.request).then(r => {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {});
          return r;
        }).catch(() => caches.match('./index.html'))
      )
    );
  }
});
