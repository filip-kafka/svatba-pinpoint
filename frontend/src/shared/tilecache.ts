/**
 * Pre-loading map data so the map is already there when it's needed.
 *
 * 1. A service worker (public/sw.js) stores every map tile, font and sprite the
 *    device downloads, and serves it from the device from then on.
 * 2. `prefetchViews()` downloads, in the background, the exact tiles MapLibre
 *    will ask for when showing a given view. The host pre-loads every reveal
 *    during the lobby; phones pre-load their start view and each round's hint.
 *
 * Only vector styles (OpenFreeMap by default) are pre-loaded. Raster fallbacks
 * such as tile.openstreetmap.org forbid bulk downloading, so they're left alone.
 */

/** A map view in Leaflet terms: centre, Leaflet zoom, and size in CSS pixels. */
export interface View {
  lat: number;
  lng: number;
  zoom: number;
  width: number;
  height: number;
}

interface TileSource {
  templates: string[];
  minzoom: number;
  maxzoom: number;
  tileSize: number;
  round: boolean; // raster sources round the zoom, vector sources floor it
}

interface StyleInfo {
  sources: TileSource[];
  extras: string[]; // glyph ranges and sprite files every map needs
  hosts: string[];
}

// The Leaflet <-> MapLibre bridge draws a canvas 10 % bigger than the map on
// every side (its `padding` option), so MapLibre loads tiles for that area too.
const BRIDGE_PAD = 1.2;
const MAX_TILES_PER_VIEW = 400; // safety net against a runaway calculation
const CONCURRENCY = 6;

// ------------------------------------------------------------- style info

let styleInfo: Promise<StyleInfo | null> | null = null;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { mode: "cors", credentials: "same-origin" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function readStyle(styleUrl: string): Promise<StyleInfo> {
  const style = await getJson(styleUrl);
  const hosts = new Set<string>([new URL(styleUrl).host]);
  const sources: TileSource[] = [];

  for (const src of Object.values<any>(style.sources ?? {})) {
    if (src.type !== "vector" && src.type !== "raster") continue;
    let meta = src;
    if (!src.tiles && src.url) {
      hosts.add(new URL(src.url).host);
      meta = { ...(await getJson(src.url)), ...src };
    }
    if (!Array.isArray(meta.tiles) || !meta.tiles.length) continue;
    meta.tiles.forEach((t: string) => hosts.add(new URL(t.replace(/[{}]/g, "")).host));
    sources.push({
      templates: meta.tiles,
      minzoom: meta.minzoom ?? 0,
      maxzoom: meta.maxzoom ?? 22,
      tileSize: meta.tileSize ?? (src.type === "vector" ? 512 : 512),
      round: src.type === "raster",
    });
  }

  const extras: string[] = [];
  if (typeof style.glyphs === "string") {
    hosts.add(new URL(style.glyphs.replace(/[{}]/g, "")).host);
    const stacks = new Set<string>();
    for (const layer of style.layers ?? []) {
      const font = layer.layout?.["text-font"];
      if (Array.isArray(font) && font.every((f) => typeof f === "string")) stacks.add(font.join(","));
    }
    // 0-255: Latin; 256-511: Latin Extended-A, which has the Czech letters.
    for (const stack of stacks) {
      for (const range of ["0-255", "256-511"]) {
        extras.push(style.glyphs.replace("{fontstack}", stack).replace("{range}", range));
      }
    }
  }
  const sprites: string[] = typeof style.sprite === "string" ? [style.sprite]
    : Array.isArray(style.sprite) ? style.sprite.map((s: { url: string }) => s.url) : [];
  const ratio = window.devicePixelRatio > 1 ? "@2x" : "";
  for (const sprite of sprites) {
    hosts.add(new URL(sprite).host);
    extras.push(`${sprite}${ratio}.json`, `${sprite}${ratio}.png`);
  }
  return { sources, extras, hosts: [...hosts] };
}

// ---------------------------------------------------------- service worker

let swReady: Promise<void> | null = null;

/**
 * Register the caching service worker for a vector style and start reading the
 * style. Needs HTTPS (or localhost); elsewhere pre-loading still warms the
 * browser's normal HTTP cache.
 */
export function setupMapCache(styleUrl: string): void {
  styleInfo ??= readStyle(styleUrl).catch(() => null);
  swReady ??= (async () => {
    const info = await styleInfo;
    if (!info || !("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      await navigator.serviceWorker.register(`/sw.js?hosts=${encodeURIComponent(info.hosts.join(","))}`, { scope: "/" });
      if (navigator.serviceWorker.controller) return;
      // First visit: wait (briefly) until the worker takes control of this page.
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 4000);
      });
    } catch {
      /* private mode, blocked by the browser, ... - fine, HTTP cache still helps */
    }
  })();
}

// ----------------------------------------------------------- tile maths

const lat2y = (lat: number): number => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

/** The tile URLs MapLibre (behind the Leaflet bridge) requests to draw `view`. */
function tilesForView(view: View, src: TileSource): string[] {
  const mlZoom = view.zoom - 1; // the bridge runs MapLibre one zoom level below Leaflet
  const exact = mlZoom + Math.log2(512 / src.tileSize);
  let z = src.round ? Math.round(exact) : Math.floor(exact);
  z = Math.max(src.minzoom, Math.min(src.maxzoom, Math.max(0, z)));

  const n = 2 ** z;
  const worldPx = 512 * 2 ** mlZoom; // CSS pixels across the whole world at this view's zoom
  const cx = ((view.lng + 180) / 360) * n;
  const cy = lat2y(view.lat) * n;
  const halfX = ((view.width * BRIDGE_PAD) / 2) * (n / worldPx);
  const halfY = ((view.height * BRIDGE_PAD) / 2) * (n / worldPx);

  const x0 = Math.floor(cx - halfX), x1 = Math.floor(cx + halfX);
  const y0 = Math.max(0, Math.floor(cy - halfY)), y1 = Math.min(n - 1, Math.floor(cy + halfY));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES_PER_VIEW) return [];

  const urls = new Set<string>();
  for (let xi = x0; xi <= Math.min(x1, x0 + n - 1); xi++) {
    const x = ((xi % n) + n) % n; // wrap around the date line
    for (let y = y0; y <= y1; y++) {
      const template = src.templates[(x + y) % src.templates.length]; // MapLibre's own choice
      urls.add(template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y))
        .replace("{ratio}", window.devicePixelRatio > 1 ? "@2x" : ""));
    }
  }
  return [...urls];
}

/** The same area as `view`, `dz` zoom levels deeper (what zooming in on it needs). */
export const deeper = (view: View, dz: number): View => ({
  ...view, zoom: view.zoom + dz, width: view.width * 2 ** dz, height: view.height * 2 ** dz,
});

// ------------------------------------------------------------ download queue

const seen = new Set<string>();
const queue: { url: string; job: Job }[] = [];
let running = 0;

interface Job {
  total: number;
  done: number;
  onProgress?: (done: number, total: number) => void;
  resolve: () => void;
}

function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const { url, job } = queue.shift()!;
    running++;
    fetch(url, { mode: "cors", credentials: "same-origin" })
      .then((r) => r.arrayBuffer()) // read the body so the cache stores it
      .catch(() => seen.delete(url)) // allow a retry later
      .finally(() => {
        running--;
        job.done++;
        job.onProgress?.(job.done, job.total);
        if (job.done === job.total) job.resolve();
        pump();
      });
  }
}

/**
 * Download everything needed to show `views` (in order) in the background.
 * `urgent` jumps the queue - for the round that is starting right now.
 */
export async function prefetchViews(
  views: View[],
  opts: { urgent?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<void> {
  const info = await styleInfo;
  await swReady; // so the service worker sees (and stores) these requests
  if (!info) return;

  const urls: string[] = [];
  for (const url of [...info.extras, ...views.flatMap((v) => info.sources.flatMap((s) => tilesForView(v, s)))]) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  if (!urls.length) {
    opts.onProgress?.(0, 0);
    return;
  }
  await new Promise<void>((resolve) => {
    const job: Job = { total: urls.length, done: 0, onProgress: opts.onProgress, resolve };
    const items = urls.map((url) => ({ url, job }));
    if (opts.urgent) queue.unshift(...items);
    else queue.push(...items);
    opts.onProgress?.(0, urls.length);
    pump();
  });
}
