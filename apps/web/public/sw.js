const CACHE_NAME = "foodos-v2";
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
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // No interceptar Supabase ni otras APIs externas.
  if (url.origin !== self.location.origin) return;
  // No interceptar rutas de Next.js internas (_next/webpack-hmr, etc.).
  if (url.pathname.startsWith("/_next/webpack")) return;

  const dest = event.request.destination;
  const isStaticAsset = dest === "script" || dest === "style" || dest === "image" || dest === "font";

  if (isStaticAsset) {
    // Cache-first para assets estáticos (JS/CSS/imágenes compilados por Next.js).
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
  } else {
    // Network-first para navegación y resto: intenta red, cae en caché si offline.
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
  }
});
