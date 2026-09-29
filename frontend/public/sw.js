/*
 * Pinpoint service worker: keeps map data on the device.
 *
 * - Map tiles, fonts and sprites from the map provider are cache-first: once
 *   downloaded (or pre-loaded in the lobby) they never hit the network again.
 * - Style, TileJSON and sprite-index files are served from the device when
 *   stored and refreshed in the background (stale-while-revalidate), so a
 *   weekly map update is picked up next time without waiting on the network.
 * - A tile download the map cancels (it does, a lot, while flying) is still
 *   finished and stored, because it's usually needed a moment later.
 * - The app's own hashed /assets/ files are cache-first too.
 *
 * Which hosts count as "the map provider" comes from the registration URL
 * (sw.js?hosts=tiles.openfreemap.org,...), set by src/shared/tilecache.ts.
 */

const VERSION = "v1";
const MAP_CACHE = `pinpoint-map-${VERSION}`;
const ASSET_CACHE = `pinpoint-assets-${VERSION}`;
const HOSTS = new Set(
  (new URL(self.location.href).searchParams.get("hosts") || "").split(",").filter(Boolean),
);
const IMMUTABLE = /\.(pbf|mvt|png|jpe?g|webp)$/i; // tiles, glyphs, sprite sheets

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== MAP_CACHE && key !== ASSET_CACHE) await caches.delete(key);
      }
      await self.clients.claim(); // control the open page right away, no reload needed
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(event, ASSET_CACHE));
    return; // pages, API, photos, websockets: untouched
  }
  if (!HOSTS.has(url.host)) return;
  event.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(event, MAP_CACHE) : staleWhileRevalidate(event, MAP_CACHE));
});

/** Download `req` without the page's abort signal, and store it when it arrives. */
function download(event, cache) {
  const req = event.request;
  const res = fetch(req.url, { mode: req.mode, credentials: req.credentials }).then((r) => {
    // Copy for the cache before anyone reads the body.
    if (r.status === 200) event.waitUntil(cache.put(req.url, r.clone()).catch(() => {}));
    return r;
  });
  event.waitUntil(res.catch(() => {})); // keep the worker alive until the download is done
  return res;
}

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request.url, { ignoreVary: true });
  return hit ?? download(event, cache);
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request.url, { ignoreVary: true });
  const fresh = download(event, cache);
  if (hit) {
    fresh.catch(() => {}); // offline: the stored copy is fine
    return hit;
  }
  return fresh;
}
