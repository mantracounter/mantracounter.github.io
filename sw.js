const CACHE_NAME = "mantracounter-v0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./src/styles.css",
  "./src/main.js",
  "./src/audio-engine.js",
  "./src/app-state.js",
  "./src/rnnoise-processor.js",
  "./src/rnnoise-sync.js",
  "./src/icon.png",
  "./src/bell.mp3",
  "./src/ornament.png",
  "./src/background.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => Promise.resolve()),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => {
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("Offline", { status: 503 });
        });
    }),
  );
});
