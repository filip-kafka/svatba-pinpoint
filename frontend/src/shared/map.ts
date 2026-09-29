import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { esc } from "./dom";
import { prefetchViews, setupMapCache, type View } from "./tilecache";

type RasterConfig = { kind: "raster"; url: string; attribution: string };
type TileConfig = RasterConfig | { kind: "vector"; style: string; attribution: string };

const OSM_FALLBACK: RasterConfig = {
  kind: "raster",
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
};

/**
 * The server decides which map to use (see "Map tiles" in the README), so
 * switching provider or adding a key needs no rebuild.
 */
let tileConfig: Promise<TileConfig> | null = null;
function loadTileConfig(): Promise<TileConfig> {
  tileConfig ??= fetch("/api/map-config")
    .then((r) => r.json() as Promise<TileConfig>)
    .catch(() => OSM_FALLBACK);
  return tileConfig;
}
void loadTileConfig(); // start fetching as soon as the page loads

/** MapLibre (~250 kB gzipped) is only downloaded when a vector map is configured. */
let vectorModules: Promise<typeof import("@maplibre/maplibre-gl-leaflet")> | null = null;
function loadVectorModules() {
  vectorModules ??= Promise.all([
    import("maplibre-gl"),
    import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
    import("maplibre-gl/dist/maplibre-gl.css"),
  ]).then(([maplibre, worker]) => {
    maplibre.setWorkerUrl(worker.default);
    return import("@maplibre/maplibre-gl-leaflet");
  });
  return vectorModules;
}

/**
 * Fetch the map code, and start the tile cache, while guests wait in the lobby,
 * so the first round's map appears instantly instead of loading on the clock.
 * Resolves true when a vector (pre-loadable) map is in use.
 */
export async function warmUpMap(): Promise<boolean> {
  const cfg = await loadTileConfig();
  if (cfg.kind !== "vector" || !hasWebGL()) return false;
  void loadVectorModules();
  setupMapCache(cfg.style);
  return true;
}

/** Pre-load the map tiles for these views (no-op for raster maps). See tilecache.ts. */
export async function preloadViews(
  views: View[],
  opts: Parameters<typeof prefetchViews>[1] = {},
): Promise<boolean> {
  if (!(await warmUpMap())) return false;
  await prefetchViews(views, opts);
  return true;
}

export type { View };

/**
 * MapLibre tuning. The host laptop keeps more zoom levels of parsed tiles in
 * memory than a phone should.
 */
export const mapTuning = { tileCacheZoomLevels: 5 };

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

async function baseLayer(cfg: TileConfig): Promise<L.Layer> {
  // Vector maps need WebGL; an old phone without it gets plain raster tiles instead.
  if (cfg.kind === "vector" && hasWebGL()) {
    const { maplibreGL } = await loadVectorModules();
    setupMapCache(cfg.style);
    return maplibreGL({
      style: cfg.style,
      attributionControl: { customAttribution: cfg.attribution },
      fadeDuration: 0, // labels appear at once instead of fading in
      cancelPendingTileRequestsWhileZooming: false, // keep loading coarser tiles while zooming in
      maxTileCacheZoomLevels: mapTuning.tileCacheZoomLevels,
    });
  }
  const raster = cfg.kind === "raster" ? cfg : OSM_FALLBACK;
  return L.tileLayer(raster.url, { attribution: raster.attribution, maxZoom: 19 });
}

/**
 * Where maps open. Chosen in the admin ("Phone map starts at"). "photo" means
 * the server sends a hint area per round; until then the world view is used.
 */
export type MapStart = "world" | "europe" | "czechia" | "photo";
export const START_VIEWS: Record<Exclude<MapStart, "photo">, { center: L.LatLngTuple; zoom: number }> = {
  world: { center: [30, 10], zoom: 1.5 },
  europe: { center: [50, 12], zoom: 3.25 },
  czechia: { center: [49.8, 15.4], zoom: 6.25 },
};

export const startViewOf = (start: MapStart) => START_VIEWS[start === "photo" ? "world" : start];

export function createMap(el: HTMLElement, opts: L.MapOptions = {}, start: MapStart = "world"): L.Map {
  const view = startViewOf(start);
  const map = L.map(el, {
    worldCopyJump: true,
    minZoom: 1,
    maxZoom: 18,
    zoomSnap: 0.25,
    maxBounds: [[-88, -540], [88, 540]],
    maxBoundsViscosity: 0.8,
    attributionControl: true,
    ...opts,
  }).setView(view.center, view.zoom);
  map.attributionControl.setPrefix(false);
  let base: L.Layer | null = null;
  const useFallback = () => {
    if (base) map.removeLayer(base);
    base = L.tileLayer(OSM_FALLBACK.url, { attribution: OSM_FALLBACK.attribution, maxZoom: 19 }).addTo(map);
  };
  void loadTileConfig().then(baseLayer).then((layer) => {
    base = layer.addTo(map);
    // If the vector map's style can't be fetched (provider down, blocked
    // network), swap to plain OpenStreetMap tiles rather than show a blank map.
    const gl = (layer as Partial<{ getMaplibreMap(): import("maplibre-gl").Map }>).getMaplibreMap?.();
    gl?.on("error", () => {
      if (base === layer && !gl.isStyleLoaded()) useFallback();
    });
  }, useFallback);
  return map;
}

function pinSvg(fill: string, inner: string): string {
  return `<svg viewBox="0 0 32 44" width="32" height="44" aria-hidden="true">
    <path d="M16 43c-1-4-4-8.5-8-13.5C4.5 25 1.5 21 1.5 15.5a14.5 14.5 0 0 1 29 0c0 5.5-3 9.5-6.5 14-4 5-7 9.5-8 13.5z"
      style="fill:${fill}" stroke="rgba(0,0,0,.25)" stroke-width="1.2"/>${inner}</svg>`;
}

export const guessIcon = L.divIcon({
  className: "pin pin-guess",
  html: pinSvg("var(--guess)", '<circle cx="16" cy="15.5" r="5.5" fill="#fff"/>'),
  iconSize: [32, 44],
  iconAnchor: [16, 43],
});

export const answerIcon = L.divIcon({
  className: "pin pin-answer",
  html: pinSvg(
    "var(--accent)",
    '<path d="M16 22.5s-7-4.3-7-9a3.8 3.8 0 0 1 7-2.1 3.8 3.8 0 0 1 7 2.1c0 4.7-7 9-7 9z" fill="#fff"/>',
  ),
  iconSize: [32, 44],
  iconAnchor: [16, 43],
});

/**
 * A player's guess on the reveal map: their avatar in a circle, centred on the
 * guessed spot. HTML markers rather than L.circleMarker, because vector shapes
 * get stretched along with the map during fly-to animations; markers are
 * re-positioned every frame at a constant size.
 */
export function avatarDotIcon(avatar: string, top: boolean): L.DivIcon {
  const size = top ? 42 : 32;
  return L.divIcon({
    className: `guess-dot${top ? " top" : ""}`,
    html: `<span>${esc(avatar)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** The phone's own guess: the avatar in a bubble whose tail marks the exact spot. */
export function avatarPinIcon(avatar: string): L.DivIcon {
  return L.divIcon({
    className: "pin avatar-pin",
    html: `<span>${esc(avatar)}</span>`,
    iconSize: [44, 54],
    iconAnchor: [22, 53],
  });
}

/**
 * Fly to `target`, then run `whenLanded` - for lines, which must not exist
 * during the flight for the same reason as above. Runs at most once, even if
 * the animation is interrupted.
 */
export function flyThen(
  map: L.Map,
  fly: () => void,
  whenLanded: () => void,
  durationS: number,
): void {
  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    map.off("moveend", land);
    whenLanded();
  };
  map.on("moveend", land);
  fly();
  setTimeout(land, (durationS + 0.6) * 1000); // safety net if moveend never fires
}

/** Fold a longitude from a wrapped world copy back into [-180, 180). */
export const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180;

/**
 * Pick the copy of `lng` closest to `ref`, so a line from Alaska to Kamchatka
 * crosses the Bering Strait instead of the whole planet.
 */
export function nearLng(lng: number, ref: number): number {
  let x = lng;
  while (x - ref > 180) x -= 360;
  while (ref - x > 180) x += 360;
  return x;
}

export { L };
