const CACHE = 'aftertalk-web-v7';
const SHELL = ['./', 'index.html', 'styles.css', 'runtime-config.js', 'logic.js', 'ai-client.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'privacy.html', 'terms.html']
  .map((path) => new URL(path, self.registration.scope).href);
const RUNTIME_CONFIG = new URL('runtime-config.js', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('aftertalk-web-') && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.url === RUNTIME_CONFIG) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          return caches.open(CACHE)
            .then((cache) => cache.put(event.request, copy))
            .then(() => response);
        }
        return response;
      }).catch(() => caches.match(event.request).then((cached) => cached || Response.error())),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response && response.status === 200) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(SHELL[1]))),
  );
});
