import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Map tiles. CARTO's free basemaps are fine for a one-off private event of a
 * hundred people; swap in another provider here if you prefer (see README).
 */
export const TILES = {
  url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 19,
};

export function createMap(el: HTMLElement, opts: L.MapOptions = {}): L.Map {
  const map = L.map(el, {
    worldCopyJump: true,
    minZoom: 1,
    zoomSnap: 0.25,
    maxBounds: [[-88, -540], [88, 540]],
    maxBoundsViscosity: 0.8,
    attributionControl: true,
    ...opts,
  }).setView([30, 10], 1.5);
  L.tileLayer(TILES.url, {
    attribution: TILES.attribution,
    subdomains: TILES.subdomains,
    maxZoom: TILES.maxZoom,
  }).addTo(map);
  map.attributionControl.setPrefix(false);
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
