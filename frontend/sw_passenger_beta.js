/**
 * Service Worker: Ульяновск Трамвай — Пассажир (BETA) (sw_passenger_beta.js)
 * Offline-First & Resilient Cache Strategy for Passenger PWA.
 */

const CACHE_NAME = 'uet-passenger-beta-v12-networkfirst';

const STATIC_PRECACHE = [
  '/',
  '/public',
  '/public_beta.html',
  '/beta/public',
  '/beta',
  '/favicon.svg',
  '/favicon.ico',
  '/vendor/leaflet.css',
  '/vendor/leaflet.js',
  '/vendor/leaflet.polylineDecorator.js',
  '/vendor/turf.min.js',
  '/passenger_beta_manifest.json',
  '/js/public_app.js',
  '/js/uet_offline_db.js',
  '/js/modules/leaflet_map_engine.js',
  '/js/modules/eta_calculator.js',
  '/js/modules/vehicles_telemetry_ws.js',
  '/js/modules/closures_controller.js',
  '/api/geo/tracks?type=tram',
  '/api/geo/tracks?type=trolleybus',
  '/api/geo/stops?type=tram',
  '/api/geo/stops?type=trolleybus',
  '/api/geo/routes?type=tram',
  '/api/geo/routes?type=trolleybus'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Изолированное кэширование каждого ресурса через allSettled
      // Единичный сбой URL никогда не отменяет установку Service Worker
      await Promise.allSettled(
        STATIC_PRECACHE.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: 'no-cache' });
            if (resp && resp.ok) {
              await cache.put(url, resp);
            }
          } catch (err) {
            console.warn('[SW Passenger] Precache skipped for:', url, err);
          }
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME && k.startsWith('uet-passenger-beta-')) {
            return caches.delete(k);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never reuse old, potentially unmasked tile responses.
  if (/^\/(?:map\/)?tiles\//.test(url.pathname)) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // Пинг, проверка статуса синка и живая телеметрия не кэшируются (всегда свежая сеть)
  if (url.pathname.includes('/api/v1/sync/status') || 
      url.pathname.includes('/api/sync/status') ||
      url.pathname.includes('/api/vehicles') ||
      url.pathname.includes('/api/admin') ||
      url.pathname.includes('/ws')) {
    return;
  }

  if (req.method !== 'GET') {
    return;
  }

  // 1. Для навигации (HTML) — Cache First с фоновым обновлением и fallback
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(req, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, response.clone());
        }
        return response;
      } catch (error) {
        const fallback = await caches.match(req) || await caches.match('/public') || await caches.match('/public_beta.html');
        return fallback || new Response('Офлайн режим УЭТ Пассажир', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 2. Для API геоданных и статики — Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      }).catch(() => null);

      if (cachedResponse) {
        // Запускаем фоновое обновление в кэш
        fetchPromise.catch(() => {});
        return cachedResponse;
      }

      return fetchPromise.then((netResp) => {
        if (netResp) return netResp;
        return new Response('{}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      });
    })
  );
});
