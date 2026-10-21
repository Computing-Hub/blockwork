/*
 * service-worker.js — makes the Blockwork *editor itself* installable and
 * usable offline.
 *
 * Strategy: NETWORK-FIRST. When online, always fetch the latest file and update
 * the cache; when offline, fall back to the cached copy. This keeps the editor
 * up to date (no confusing stale code while you develop or after you deploy a
 * change) while still working with no connection.
 *
 * (Exported student apps use the opposite, cache-first strategy — see
 * src/runtime/runtime.template.html — because an app's code never changes once
 * it's shipped.)
 *
 * Bump CACHE_VERSION to force-drop old caches.
 */

const CACHE_VERSION = "blockwork-editor-v4";

// Pre-cached so the shell opens offline even on a brand-new visit.
const PRECACHE = [
  "./",
  "index.html",
  "manifest.json",
  "src/styles/tokens.css",
  "src/styles/editor.css",
  "src/styles/components.css",
  "src/editor/main.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      try {
        // `no-store` bypasses the browser's HTTP disk cache so an online user
        // always gets the freshest editor code — important since dev servers
        // (python http.server) send no Cache-Control and browsers would
        // otherwise heuristically serve stale modules.
        const response = await fetch(event.request, { cache: "no-store" });
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      } catch {
        // Offline (or fetch failed): serve whatever we cached last.
        const cached = await cache.match(event.request);
        if (cached) return cached;
        throw new Error("Offline and not cached: " + event.request.url);
      }
    })
  );
});
