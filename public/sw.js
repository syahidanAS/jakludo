const CACHE_NAME = 'jakludo-pwa-v9';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/playgo-logo.jpg',
  '/jakludo-logo.jpg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png'
];

// Install: Cache initial app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up previous caches & claim clients
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Klik notifikasi permainan: fokus ke tab JakLudo yang sudah terbuka, atau buka tab baru
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => new URL(c.url).origin === self.location.origin);
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    })
  );
});

// Fetch: Smart caching strategy
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Jangan intersep request cross-origin (mis. Google AdSense / fonts / analytics)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Jangan intersep file teks crawler agar tidak tertangkap sebagai cache navigasi SPA
  if (url.pathname === '/ads.txt' || url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
    return;
  }

  // Jangan intersep WebSocket & socket.io polling/handshake
  if (url.pathname.startsWith('/socket.io')) {
    return;
  }

  // Jangan intersep request API dinamis atau halaman Admin CMS terpisah
  if (
    url.pathname.startsWith('/api') ||
    url.pathname === '/admin' ||
    url.pathname.startsWith('/admin/') ||
    url.pathname === '/admin.html'
  ) {
    return;
  }

  // Jangan intersep modul Vite dev server saat pengembangan lokal
  if (
    url.pathname.startsWith('/client/') ||
    url.pathname.startsWith('/node_modules/') ||
    url.pathname.startsWith('/@')
  ) {
    return;
  }

  // Hanya proses method GET
  if (request.method !== 'GET') {
    return;
  }

  // Audio/video memakai Range request (206). Respons cache penuh untuk Range request membuat
  // Safari/iOS gagal memutar musik, jadi biarkan browser menanganinya langsung.
  if (request.headers.has('range') || request.destination === 'audio' || url.pathname.endsWith('.mp3')) {
    return;
  }

  // Navigation requests (HTML shell): Network-First dengan Fallback ke Cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('/', responseClone));
          }
          return response;
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/index.html')) || Response.error())
    );
    return;
  }

  // Static Assets (JS, CSS, Images): Cache-First dengan Network Revalidate.
  // respondWith tidak boleh menerima null (saat offline/tunnel putus) karena memicu error di browser.
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      const fetchPromise = fetch(request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && url.origin === self.location.origin) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        }
        return networkResponse;
      });

      if (cachedResponse) {
        fetchPromise.catch(() => {}); // revalidasi di belakang layar boleh gagal
        return cachedResponse;
      }
      return fetchPromise.catch(() => Response.error());
    })
  );
});

