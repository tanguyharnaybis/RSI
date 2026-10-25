/**
 * Service Worker RSI Calc
 * Stratégie : network-first pour les navigations (toujours frais),
 * cache-first pour les assets de build.
 * Les URLs sont relatives : fonctionne à la racine comme sous un
 * sous-chemin (GitHub Pages).
 */

const CACHE_NAME = 'rsi-calc-v4';
const OFFLINE_URLS = ['./', './index.html', './manifest.json', './favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Ignorer les requêtes cross-origin (CDN, etc.)
  if (new URL(request.url).origin !== self.location.origin) return;

  // Bypass pour le moteur ffmpeg (~32 Mo) : le clonage de la réponse
  // pour le cache double la mémoire en streaming et peut faire échouer
  // le chargement sur iPhone (WebKit). Le moteur est chargé en réseau
  // direct ; l'application elle-même reste mise en cache hors ligne.
  if (request.url.includes('/ffmpeg/')) return;

  // Navigations : réseau d'abord, fallback cache (mode hors ligne)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Assets : cache d'abord, sinon réseau puis mise en cache
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && request.method === 'GET') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
