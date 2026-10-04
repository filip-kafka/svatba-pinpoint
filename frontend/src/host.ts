import "@fontsource-variable/inter";
import "@fontsource/fraunces/600.css";
import "./styles/base.css";
import "./styles/host.css";
import confetti from "canvas-confetti";
import QRCode from "qrcode";

import { requireToken, forgetToken } from "./shared/auth";
import { $, esc, showView, toast } from "./shared/dom";
import { errorText, formatDistance, formatNumber, lang, onLangChange, pick, t, toggleLang } from "./shared/i18n";
import { avatarSpan } from "./shared/avatars";
import { answerIcon, avatarDotIcon, createMap, flyThen, L, mapTuning, nearLng, preloadViews, type View } from "./shared/map";
import { LiveSocket, ServerClock } from "./shared/socket";
import type { HostState, LeaderRow, PhotoItem, Scale, ServerMessage } from "./shared/types";

const stage = $(".stage");
const dock = $(".dock");
const drawer = $(".drawer");
const clock = new ServerClock();
const joinUrl = location.origin;
const joinUrlShort = location.host;

let state: HostState | null = null;
let socket: LiveSocket;
let lastKey = "";       // phase+round we last built the view for
let lastAdvance = 0;

// ------------------------------------------------------------------- setup

const token = await requireToken($(".login-root"));
mapTuning.tileCacheZoomLevels = 10; // a laptop can keep plenty of parsed map tiles in memory
stage.hidden = false;
dock.hidden = false;

QRCode.toString(joinUrl, {
  type: "svg", margin: 0, errorCorrectionLevel: "M",
  color: { dark: "#2a2724ff", light: "#00000000" },
}).then((svg) => {
  $(".qr").innerHTML = svg;
});

socket = new LiveSocket(`/ws/host?token=${encodeURIComponent(token)}`, {
  onMessage: handle,
  onStatus: (s) => {
    const el = $(".connection-lost");
    el.textContent = t("reconnecting");
    el.hidden = s === "open";
  },
  onClose: (ev) => {
    if (ev.code === 4401) {
      forgetToken();
      location.reload();
      return true;
    }
  },
});

function handle(msg: ServerMessage): void {
  if (msg.type === "error") {
    toast(errorText(msg.code), "error");
    return;
  }
  if (msg.type !== "state" || msg.role !== "host") return;
  clock.sync(msg.server_now);
  state = msg;
  if (preloadedCount === -1) { // first message, whatever the phase (e.g. host page reloaded mid-game)
    preloadedCount = msg.round_count;
    void preloadReveals();
  }
  render();
}

function send(action: string, extra: Record<string, unknown> = {}): void {
  if (!socket.send({ action, ...extra })) toast(t("reconnecting"), "error");
}

// ------------------------------------------------------------------ render

function render(): void {
  const s = state;
  if (!s) return;
  const key = `${s.phase}:${s.round_index}`;
  const fresh = key !== lastKey;
  lastKey = key;

  showView(stage, s.phase);
  switch (s.phase) {
    case "lobby":
      renderLobby(s);
      break;
    case "question":
      renderQuestion(s, fresh);
      break;
    case "reveal":
      if (fresh) renderReveal(s);
      break;
    case "leaderboard":
      renderBoard(s, fresh);
      break;
    case "final":
      renderFinal(s, fresh);
      break;
  }
  renderHint(s);
  renderDock(s);
  renderDrawer(s);
  tick();
}

function renderLobby(s: HostState): void {
  $(".lobby-title").textContent = pick(s.title);
  $(".lobby-subtitle").textContent = pick(s.subtitle);
  $(".join-label").textContent = `${t("joinAt")}`;
  $(".join-url").textContent = joinUrlShort;
  $(".lobby-players-label").textContent = t("players");
  $(".players-heading .count").textContent = String(s.players.length);

  const warnings: string[] = [];
  if (s.round_count === 0) warnings.push(t("noPhotos"));
  else warnings.push(t("photosReady", { n: s.round_count }));
  if (s.missing_location_count) warnings.push(t("photosMissing", { n: s.missing_location_count }));
  $(".lobby-warnings").innerHTML = warnings.map((w) => `<span>${esc(w)}</span>`).join("");
  $(".lobby-warnings").classList.toggle("bad", s.round_count === 0);
  if (s.round_count !== preloadedCount) {
    preloadedCount = s.round_count;
    void preloadReveals();
  }

  // Add new chips without rebuilding existing ones, so only newcomers animate in.
  const list = $(".chips");
  const present = new Set(s.players.map((p) => p.id));
  list.querySelectorAll<HTMLElement>("li").forEach((li) => {
    if (!present.has(li.dataset.id!)) li.remove();
  });
  for (const p of s.players) {
    let li = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(p.id)}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = p.id;
      list.append(li);
    }
    if (li.dataset.avatar !== p.avatar) { // new chip, or the guest picked another avatar
      li.dataset.avatar = p.avatar;
      li.innerHTML = `${avatarSpan(p.avatar)}${esc(p.name)}`;
    }
    li.classList.toggle("offline", !p.connected);
  }
  $(".chips-empty").textContent = s.players.length ? "" : t("noPlayersYet");
  fitChips();
  fitText($(".join-url"));
}

/** Shrink the chip font until every name fits - 80+ guests must all be visible. */
function fitChips(): void {
  const list = $(".chips");
  let size = Math.min(28, Math.max(14, window.innerWidth * 0.0135));
  list.style.fontSize = `${size}px`;
  while (list.scrollHeight > list.clientHeight + 1 && size > 9) {
    size *= 0.92;
    list.style.fontSize = `${size}px`;
  }
}

/** Shrink a single line of text until it fits its box. */
function fitText(el: HTMLElement): void {
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth + 1 && size > 14) {
    size *= 0.94;
    el.style.fontSize = `${size}px`;
  }
}
function refitLobby(): void {
  if (state?.phase === "lobby") {
    fitChips();
    fitText($(".join-url"));
  }
}
window.addEventListener("resize", refitLobby);
// The display font arrives after the first render and is wider than the fallback,
// so measure again once it's in - otherwise the join address can end up clipped.
void document.fonts?.ready.then(refitLobby);
document.fonts?.addEventListener?.("loadingdone", refitLobby);

function renderQuestion(s: HostState, fresh: boolean): void {
  if (fresh) {
    const img = $<HTMLImageElement>(".q-photo img");
    img.src = s.photo ?? "";
  }
  $(".q-round").textContent = t("round", { i: s.round_index + 1, n: s.round_count });
  $(".q-answered strong").textContent = `${s.answered_count} / ${s.connected_count}`;
  $(".q-answered span").textContent = t("answered");
  $(".q-closed").textContent = s.closed ? t("timesUp") : "";
  $(".q-join").textContent = `${t("joinAt")} ${joinUrlShort}`;
  $(".question").classList.toggle("closed", s.closed);
}

// ------------------------------------------------------------------ reveal

let revealMap: L.Map | null = null;
let revealToken = 0;
let flying = false;
const revealLayer = L.layerGroup();

/** How far the reveal zooms in, by the photo's scoring scale (admin → Scoring). */
const REVEAL_ZOOM: Record<Scale, number> = { world: 7, continent: 8, country: 9, city: 13 };

/**
 * The close-up. After landing on the answer at REVEAL_ZOOM, if the closest guess
 * is near enough, the map pauses and then dives in until the answer and that
 * guess fill the free part of the screen - so a great guess gets a big moment.
 */
const CLOSE_UP = {
  maxZoom: 16,          // never closer than this (13 ≈ a city, 16 ≈ streets and buildings)
  minGain: 1,           // only dive if it gets at least this many zoom levels closer
  pauseMs: 1400,        // how long the regional view stays before the dive
  duration: 2.2,        // seconds the dive takes
  margin: [170, 150] as L.PointTuple, // px kept free around the pair for pins and names
};

/** Where the close-up would go, or null if it isn't worth diving for. */
function closeUpPlan(m: L.Map, answer: L.LatLng, closest: L.LatLng | undefined, baseZoom: number) {
  if (!closest) return null;
  const bounds = L.latLngBounds([answer, closest]);
  const topLeft: L.PointTuple = [CLOSE_UP.margin[0], CLOSE_UP.margin[1]];
  const bottomRight: L.PointTuple = [panelInset() + CLOSE_UP.margin[0], CLOSE_UP.margin[1] + 60]; // + the hint line
  const zoom = Math.min(
    CLOSE_UP.maxZoom,
    m.getBoundsZoom(bounds, false, L.point(topLeft).add(bottomRight)),
  );
  if (zoom < baseZoom + CLOSE_UP.minGain) return null;
  return { bounds, zoom, options: { paddingTopLeft: topLeft, paddingBottomRight: bottomRight, maxZoom: CLOSE_UP.maxZoom } };
}

// ------------------------------------------------------------ map preload

let preloadedCount = -1;
let preloadKey = "";

/**
 * Download, in the background, every map view the reveals will show: the world
 * view each reveal starts from, then for each photo (in game order) the landing
 * view and the three zoom levels the flight passes through just before it.
 * The host has the organizer token, so it can read the answers from the admin API.
 */
async function preloadReveals(): Promise<void> {
  const r = await fetch("/api/admin/quiz", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!r?.ok) return;
  const photos = ((await r.json()) as { photos: PhotoItem[] }).photos
    .filter((p): p is PhotoItem & { lat: number; lng: number } => p.lat != null && p.lng != null);
  const key = photos.map((p) => `${p.id}:${p.lat}:${p.lng}:${p.scale}`).join("|");
  if (!photos.length || key === preloadKey) return;
  preloadKey = key;

  // The answer sits beside the side panel, so cover a wider area than the screen.
  const w = window.innerWidth * 1.3, h = window.innerHeight;
  const views: View[] = [
    { lat: 25, lng: 10, zoom: 1.6, width: window.innerWidth, height: h }, // where every reveal starts
    { lat: 0, lng: 0, zoom: 2, width: 1024, height: 1024 },               // the whole world, two
    { lat: 0, lng: 0, zoom: 3, width: 2048, height: 2048 },               // coarse levels deep
  ];
  for (const p of photos) {
    const z = REVEAL_ZOOM[p.scale] ?? REVEAL_ZOOM.world;
    // Landing view and the three levels just before it, all centred on the answer ...
    for (let dz = 0; dz <= 3 && z - dz >= 3; dz++) views.push({ lat: p.lat, lng: p.lng, zoom: z - dz, width: w, height: h });
    // ... and the middle of the flight, sampled along the way from the world view.
    const lng = nearLng(p.lng, 10);
    for (let k = 4; k <= z - 4; k++) {
      for (const t of [0.6, 0.85]) {
        views.push({ lat: 25 + (p.lat - 25) * t, lng: 10 + (lng - 10) * t, zoom: k, width: w, height: h });
      }
    }
  }

  const status = $(".map-status");
  const show = (done: number, total: number) => {
    status.hidden = false;
    status.classList.toggle("done", done >= total);
    status.textContent = done >= total ? t("mapReady") : t("mapPreloading", { done, total });
  };
  const vector = await preloadViews(views, { onProgress: show });
  if (!vector) status.hidden = true; // raster maps aren't pre-loaded
}

/** What the edge pointers need: the answer and the five closest guesses (already sorted). */
let pointerData: {
  answer: L.LatLng;
  closest: { name: string; avatar: string; ll: L.LatLng; distance_km: number }[];
} | null = null;

/** Width of map hidden under the side panel, so "on screen" means actually visible. */
function panelInset(): number {
  const mapRect = $("#reveal-map").getBoundingClientRect();
  const panel = $(".reveal-panel").getBoundingClientRect();
  return Math.max(0, mapRect.right - panel.left);
}

function renderReveal(s: HostState): void {
  if (!revealMap) {
    revealMap = createMap($("#reveal-map"), { zoomControl: false, attributionControl: true });
    revealLayer.addTo(revealMap);
    revealMap.on("moveend", () => { if (!flying) renderPointers(); });
    window.addEventListener("resize", () => { if (state?.phase === "reveal" && !flying) renderPointers(); });
  }
  const m = revealMap;
  requestAnimationFrame(() => m.invalidateSize());
  revealLayer.clearLayers();
  $(".reveal-pointers").innerHTML = "";

  const a = s.answer!;
  const answer = L.latLng(a.lat, a.lng);
  const guesses = (s.guesses ?? []).map((g) => ({ ...g, ll: L.latLng(g.lat, nearLng(g.lng, a.lng)) }));
  pointerData = { answer, closest: guesses.slice(0, 5) };

  guesses.forEach((g, i) => {
    const dot = L.marker(g.ll, { icon: avatarDotIcon(g.avatar, i < 3), keyboard: false, zIndexOffset: i < 3 ? 500 - i : 0 })
      .addTo(revealLayer);
    if (i < 3) {
      // Spread the three labels so nearby guesses don't cover each other.
      const dir = (["top", "bottom", "right"] as const)[i];
      const offset: L.PointTuple = [[0, -24], [0, 24], [24, 0]][i] as L.PointTuple;
      dot.bindTooltip(esc(g.name), { permanent: true, direction: dir, className: "guess-label", offset });
    }
  });
  L.marker(answer, { icon: answerIcon, zIndexOffset: 1000, keyboard: false }).addTo(revealLayer);

  const drawLines = () => {
    guesses.forEach((g) => L.polyline([g.ll, answer], {
      color: "#2a2724", weight: 1.5, opacity: 0.25, dashArray: "4 6", className: "reveal-line", interactive: false,
    }).addTo(revealLayer));
  };

  m.setView([25, 10], 1.6, { animate: false });
  const token = ++revealToken;
  const zoom = REVEAL_ZOOM[a.scale] ?? REVEAL_ZOOM.world;
  const closeUp = closeUpPlan(m, answer, guesses[0]?.ll, zoom);
  if (closeUp) {
    // Start downloading the close-up now; the first flight and the pause give it ~3.5 s.
    const c = closeUp.bounds.getCenter();
    const w = window.innerWidth * 1.3, h = window.innerHeight;
    void preloadViews([
      { lat: c.lat, lng: c.lng, zoom: closeUp.zoom, width: w, height: h },
      { lat: c.lat, lng: c.lng, zoom: closeUp.zoom - 1, width: w, height: h },
    ], { urgent: true });
  }

  const finish = () => {
    flying = false;
    if (token !== revealToken) return;
    drawLines();
    renderPointers();
  };

  setTimeout(() => {
    if (token !== revealToken) return; // a newer reveal (or language switch) took over
    const duration = 1.8;
    // Centre the answer in the part of the map the side panel doesn't cover.
    const center = m.unproject(m.project(answer, zoom).add([panelInset() / 2, 0]), zoom);
    flying = true;
    flyThen(m, () => m.flyTo(center, zoom, { duration }), () => {
      if (token !== revealToken || !closeUp) return finish();
      // Let everyone take in the regional view, then dive to the closest guess.
      setTimeout(() => {
        if (token !== revealToken) return;
        flyThen(m, () => m.flyToBounds(closeUp.bounds, { ...closeUp.options, duration: CLOSE_UP.duration }),
          finish, CLOSE_UP.duration);
      }, CLOSE_UP.pauseMs);
    }, duration);
  }, 350);

  $<HTMLImageElement>(".reveal-thumb").src = s.photo ?? "";
  const caption = pick(a.caption);
  $(".reveal-caption").textContent = caption;
  $(".reveal-caption").hidden = !caption;
  $(".reveal-closest-label").textContent = t("closest");
  $(".closest").innerHTML = guesses.slice(0, 5).map((g) => `
    <li><span class="c-name">${avatarSpan(g.avatar)}${esc(g.name)}</span>
      <span class="c-dist muted tabular">${esc(formatDistance(g.distance_km))}</span>
      <span class="c-pts tabular">+${esc(formatNumber(g.points))}</span></li>`).join("")
    || `<li class="muted">–</li>`;
}

const POINTER_MAX_WIDTH = 320; // px; long names shrink the label's font instead of being cut off
const POINTER_NAME_MAX = 20;   // characters; the server caps names at 20 too

const shortName = (name: string): string =>
  [...name].length > POINTER_NAME_MAX ? `${[...name].slice(0, POINTER_NAME_MAX - 1).join("").trimEnd()}…` : name;

/**
 * Any of the five closest guesses that is outside the zoomed-in view gets a
 * pointer at the screen edge: an arrow in its direction, rank, name and distance.
 */
function renderPointers(): void {
  const box = $(".reveal-pointers");
  box.innerHTML = "";
  const m = revealMap;
  if (!m || !pointerData || state?.phase !== "reveal" || !pointerData.closest.length) return;

  const size = m.getSize();
  const right = size.x - panelInset();
  const onScreen = (p: L.Point) => p.x >= 16 && p.x <= right - 16 && p.y >= 16 && p.y <= size.y - 16;
  const offScreen = pointerData.closest
    .map((g, i) => ({ ...g, rank: i + 1, pt: m.latLngToContainerPoint(g.ll) }))
    .filter((g) => !onScreen(g.pt));
  if (!offScreen.length) return;

  // The box pointer centres are placed on; margins keep the widest label on screen.
  const mx = POINTER_MAX_WIDTH / 2 + 12, my = 56;
  const minX = mx, maxX = right - mx, minY = my, maxY = size.y - my - 80; // keep clear of the "→ continue" hint
  const origin = m.latLngToContainerPoint(pointerData.answer);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const GAP = 8;

  // Things already on the map that a pointer must not cover: the answer pin and the
  // visible top-3 avatars with their name labels.
  const mapRect = $("#reveal-map").getBoundingClientRect();
  document.querySelectorAll<HTMLElement>(
    "#reveal-map .pin-answer, #reveal-map .guess-dot.top, #reveal-map .leaflet-tooltip.guess-label",
  ).forEach((el) => {
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.right > mapRect.left && r.left < mapRect.right
      && r.bottom > mapRect.top && r.top < mapRect.bottom;
    if (visible) {
      placed.push({ x: r.left - mapRect.left + r.width / 2, y: r.top - mapRect.top + r.height / 2, w: r.width, h: r.height });
    }
  });

  offScreen.forEach((g, i) => {
    const dx = g.pt.x - origin.x;
    const dy = g.pt.y - origin.y;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const el = document.createElement("div");
    el.className = `pointer${g.rank <= 3 ? " top" : ""}`;
    el.style.visibility = "hidden";
    el.style.animationDelay = `${i * 120}ms`;
    el.innerHTML = `
      <svg class="pointer-arrow" viewBox="0 0 24 24" style="transform: rotate(${angle}deg)" aria-hidden="true">
        <path d="M4 12h13M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="pointer-rank">${g.rank}</span>
      ${avatarSpan(g.avatar, "pointer-avatar")}
      <span class="pointer-name">${esc(shortName(g.name))}</span>
      <span class="pointer-dist tabular">${esc(formatDistance(g.distance_km))}</span>`;
    box.append(el);

    // Shrink the font until the whole label fits the maximum width.
    let fontPx = parseFloat(getComputedStyle(el).fontSize);
    while (el.offsetWidth > POINTER_MAX_WIDTH && fontPx > 10) {
      fontPx *= 0.93;
      el.style.fontSize = `${fontPx}px`;
    }
    const w = el.offsetWidth, h = el.offsetHeight;

    // Walk from the answer towards the guess until the ray leaves the box.
    const ts = [
      dx > 0 ? (maxX - origin.x) / dx : dx < 0 ? (minX - origin.x) / dx : Infinity,
      dy > 0 ? (maxY - origin.y) / dy : dy < 0 ? (minY - origin.y) / dy : Infinity,
    ];
    const t = Math.min(...ts);
    const x0 = Math.min(maxX, Math.max(minX, origin.x + dx * t));
    const y0 = Math.min(maxY, Math.max(minY, origin.y + dy * t));
    const slideY = ts[0] <= ts[1]; // on a left/right edge we slide vertically

    // Slide along the edge (0, +1, -1, +2, -2 … steps) until it overlaps no earlier label.
    const overlaps = (x: number, y: number) => placed.some((p) =>
      Math.abs(p.x - x) < (p.w + w) / 2 + GAP && Math.abs(p.y - y) < (p.h + h) / 2 + GAP);
    let x = x0, y = y0;
    for (let k = 1; k <= 20 && overlaps(x, y); k++) {
      const step = (k % 2 ? 1 : -1) * Math.ceil(k / 2);
      if (slideY) y = Math.min(maxY, Math.max(minY, y0 + step * (h + GAP)));
      else x = Math.min(maxX, Math.max(minX, x0 + step * (w + GAP)));
    }
    placed.push({ x, y, w, h });

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "";
  });
}

// -------------------------------------------------------------- standings

function changeBadge(r: LeaderRow): string {
  if (r.prev_rank == null) return `<span class="chg"></span>`;
  const d = r.prev_rank - r.rank;
  if (d === 0) return `<span class="chg same">–</span>`;
  return `<span class="chg ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>`;
}

function renderBoard(s: HostState, fresh: boolean): void {
  if (!fresh) return;
  $(".board-title").textContent = t("leaderboard");
  $(".board-round").textContent = t("round", { i: s.round_index + 1, n: s.round_count });
  const rows = (s.leaderboard ?? []).slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.total));
  $(".board-list").innerHTML = rows.map((r, i) => `
    <li style="--i:${rows.length - i}; --w:${(r.total / max) * 100}%">
      <span class="b-rank tabular">${r.rank}</span>
      ${changeBadge(r)}
      <span class="b-name">${avatarSpan(r.avatar)}${esc(r.name)}</span>
      <span class="b-round tabular">${r.round_points ? `+${esc(formatNumber(r.round_points))}` : ""}</span>
      <span class="b-total tabular">${esc(formatNumber(r.total))}</span>
    </li>`).join("");
}

function renderFinal(s: HostState, fresh: boolean): void {
  if (!fresh) return;
  $(".final-title").textContent = t("finalTitle");
  const rows = s.leaderboard ?? [];
  const top = rows.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean) as LeaderRow[];
  $(".podium").innerHTML = order.map((r) => `
    <div class="step step-${r.rank <= 3 ? r.rank : 3}">
      ${avatarSpan(r.avatar, "step-avatar")}
      <div class="step-name display">${esc(r.name)}</div>
      <div class="step-points tabular">${esc(formatNumber(r.total))}</div>
      <div class="step-block display">${r.rank}</div>
    </div>`).join("");
  $(".final-rest").innerHTML = rows.slice(3, 10).map((r) => `
    <li><span class="tabular">${r.rank}.</span> ${avatarSpan(r.avatar)}${esc(r.name)} <span class="muted tabular">${esc(formatNumber(r.total))}</span></li>`).join("");

  const colors = ["#9c4a5a", "#b8913e", "#f4e3e5", "#2f5d7c", "#ffffff"];
  const burst = (x: number) => confetti({ particleCount: 90, spread: 70, origin: { x, y: 0.6 }, colors });
  setTimeout(() => burst(0.5), 900);
  setTimeout(() => burst(0.25), 1300);
  setTimeout(() => burst(0.75), 1600);
}

// --------------------------------------------------------- hint + controls

function renderHint(s: HostState): void {
  const hint = $(".hint");
  const text: Record<string, string> = {
    lobby: s.round_count ? t("pressToStart") : "",
    question: s.closed ? t("pressToReveal") : "",
    reveal: t("pressToContinue"),
    leaderboard: t("pressToContinue"),
    final: "",
  };
  hint.textContent = text[s.phase] ?? "";
}

function renderDock(s: HostState): void {
  const btn = (act: string) => $<HTMLButtonElement>(`[data-act="${act}"]`, dock);
  btn("advance").textContent = `${t("next")} →`;
  btn("advance").disabled = s.phase === "final" || (s.phase === "lobby" && s.round_count === 0);
  btn("extend").textContent = t("extend");
  btn("extend").hidden = s.phase !== "question";
  btn("close").textContent = t("closeRound");
  btn("close").hidden = s.phase !== "question" || s.closed;
  btn("players").textContent = `${t("players")} (${s.connected_count}/${s.players.length})`;
  btn("lang").textContent = lang() === "cs" ? "EN" : "CZ";
  btn("reset").textContent = t("resetScores");
  btn("reset_all").textContent = t("resetAll");
}

function renderDrawer(s: HostState): void {
  if (drawer.hidden) return;
  $(".drawer-title").textContent = `${t("players")} (${s.players.length})`;
  $(".drawer-list").innerHTML = s.players.map((p) => `
    <li><span class="dot ${p.connected ? "on" : ""}" title="${esc(p.connected ? t("online") : t("offline"))}"></span>
      <span class="d-name">${avatarSpan(p.avatar)}${esc(p.name)}</span>
      <button class="btn btn-small btn-danger" data-kick="${esc(p.id)}" data-name="${esc(p.name)}">${esc(t("kick"))}</button></li>`).join("");
}

// ------------------------------------------------------------------ timer

const RING = 2 * Math.PI * 52;
const ringFg = document.querySelector<SVGCircleElement>(".ring-fg")!;
ringFg.style.strokeDasharray = `${RING}`;

function tick(): void {
  if (!state || state.phase !== "question") return;
  const limit = state.time_limit ?? 1;
  const left = state.closed ? 0 : clock.remaining(state.ends_at);
  ringFg.style.strokeDashoffset = `${RING * (1 - Math.min(1, left / limit))}`;
  $(".ring-text").textContent = String(Math.ceil(left));
  $(".ring").classList.toggle("urgent", left > 0 && left <= 5);
}
setInterval(tick, 100);

// ------------------------------------------------------------------ input

function advance(): void {
  const now = Date.now();
  if (now - lastAdvance < 600) return; // presenter clickers love double presses
  lastAdvance = now;
  send("advance");
}

dock.addEventListener("click", (ev) => {
  const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (!act) return;
  switch (act) {
    case "advance": advance(); break;
    case "players": togglePlayers(); break;
    case "lang": toggleLang(); break;
    case "fullscreen": toggleFullscreen(); break;
    case "reset":
      if (confirm(t("confirmReset"))) send("reset");
      break;
    case "reset_all":
      if (confirm(t("confirmResetAll"))) send("reset_all");
      break;
    default: send(act);
  }
  (ev.target as HTMLElement).closest("details")?.removeAttribute("open");
});

drawer.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest("[data-act=players]")) togglePlayers();
  const kick = target.closest<HTMLElement>("[data-kick]");
  if (kick && confirm(t("confirmKick", { name: kick.dataset.name ?? "" }))) {
    send("kick", { player_id: kick.dataset.kick });
  }
});

function togglePlayers(): void {
  drawer.hidden = !drawer.hidden;
  if (state) renderDrawer(state);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
}

document.addEventListener("keydown", (ev) => {
  if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if ((ev.target as HTMLElement).closest("input, textarea, select")) return;
  switch (ev.key) {
    case "ArrowRight": case "PageDown": case " ": case "Enter":
      ev.preventDefault();
      advance();
      break;
    case "f": case "F": toggleFullscreen(); break;
    case "l": case "L": toggleLang(); break;
    case "e": case "E": if (state?.phase === "question") send("extend"); break;
    case "p": case "P": togglePlayers(); break;
  }
});

// Hide the dock and cursor when the mouse is idle, so the projector stays clean.
let idleTimer: number | undefined;
function wake(): void {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (!dock.matches(":hover") && drawer.hidden) document.body.classList.add("idle");
  }, 3000);
}
document.addEventListener("mousemove", wake);
wake();

onLangChange(() => {
  lastKey = ""; // rebuild views in the new language
  render();
});
