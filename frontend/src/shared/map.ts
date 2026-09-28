import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
 * Fetch the map code and style while guests wait in the lobby, so the first
 * round's map appears instantly instead of loading while the timer runs.
 */
export function warmUpMap(): void {
  void loadTileConfig().then((cfg) => {
    if (cfg.kind !== "vector" || !hasWebGL()) return;
    void loadVectorModules();
    void fetch(cfg.style).catch(() => undefined);
  });
}

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
    return maplibreGL({ style: cfg.style, attributionControl: { customAttribution: cfg.attribution } });
  }
  const raster = cfg.kind === "raster" ? cfg : OSM_FALLBACK;
  return L.tileLayer(raster.url, { attribution: raster.attribution, maxZoom: 19 });
}

/** Where maps open. Chosen in the admin ("Phone map starts at"). */
export type MapStart = "world" | "europe" | "czechia";
export const START_VIEWS: Record<MapStart, { center: L.LatLngTuple; zoom: number }> = {
  world: { center: [30, 10], zoom: 1.5 },
  europe: { center: [50, 12], zoom: 3.25 },
  czechia: { center: [49.8, 15.4], zoom: 6.25 },
};

export function createMap(el: HTMLElement, opts: L.MapOptions = {}, start: MapStart = "world"): L.Map {
  const view = START_VIEWS[start];
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
