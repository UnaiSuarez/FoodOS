// Bump este número en cada cambio de estrategia para forzar reinstalación
// del SW y purga de cachés viejas. v2 cacheaba JS/CSS cache-first, lo que
// servía bundles desactualizados para siempre (sobre todo en desarrollo).
const CACHE_NAME = "foodos-v3";
const PRECACHE = ["/", "/dashboard", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Borra TODAS las cachés que no sean la actual (incluida la antigua foodos-v2
      // con JS obsoleto). Esto purga los bundles pegados de la versión anterior.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // No interceptar Supabase ni otras APIs externas.
  if (url.origin !== self.location.origin) return;
  // No interceptar nada de Next.js en desarrollo (_next/*): HMR, chunks que
  // reutilizan URL al recompilar, etc. Dejar pasar siempre a la red.
  if (url.pathname.startsWith("/_next/webpack") || url.pathname.includes("hot-update")) return;

  const dest = event.request.destination;

  // Imágenes y fuentes: cache-first (cambian poco y se benefician del caché).
  if (dest === "image" || dest === "font") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // JS, CSS, navegación y resto: network-first. Siempre se intenta la versión
  // fresca de la red; solo se cae al caché si no hay conexión. Así un cambio de
  // código nunca queda servido desde una versión vieja.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/dashboard")))
  );
});
