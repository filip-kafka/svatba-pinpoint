import "@fontsource-variable/inter";
import "@fontsource/fraunces/600.css";
import "./styles/base.css";
import "./styles/player.css";
import confetti from "canvas-confetti";

import { $, esc, showView, toast } from "./shared/dom";
import {
  errorText, formatDistance, formatNumber, lang, onLangChange, pick, t, toggleLang, type Key,
} from "./shared/i18n";
import { loadAvatars, randomAvatar, renderAvatarGrid } from "./shared/avatars";
import {
  answerIcon, avatarPinIcon, createMap, flyThen, L, nearLng, preloadViews, startViewOf, wrapLng,
  type MapStart, type View,
} from "./shared/map";
import { deeper } from "./shared/tilecache";
import { LiveSocket, ServerClock } from "./shared/socket";
import type { AnonymousState, PlayerState, ServerMessage } from "./shared/types";

const ID_KEY = "pinpoint.player";
const NAME_KEY = "pinpoint.name";
const AVATAR_KEY = "pinpoint.avatar";

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k: string) => { try { localStorage.removeItem(k); } catch {} },
};

// ------------------------------------------------------------------ elements

const app = $("#app");
const views = $(".views");
const joinForm = $<HTMLFormElement>(".join-form");
const nameInput = $<HTMLInputElement>("input[name=name]", joinForm);
const joinBtn = $<HTMLButtonElement>(".join-btn");
const joinError = $(".join-error");
const timerEl = $(".timer");
const timerFill = $(".timer-fill");
const timerText = $(".timer-text");
const lockBtn = $<HTMLButtonElement>(".lock-btn");
const photoBtn = $<HTMLButtonElement>(".photo");
const photoImg = $<HTMLImageElement>(".photo img");
const lightbox = $(".lightbox");
const action = $(".action");
const sheet = $(".avatar-sheet");

// --------------------------------------------------------------------- state

let playerId = store.get(ID_KEY);
let state: PlayerState | AnonymousState | null = null;
let joining = false;
let goneReason: "kicked" | "reset" | null = null;
let preparedRound = -1;
let revealedRound = -1;
let pendingMarker: L.Marker | null = null;
let celebrated = false;
let chosenAvatar: string | null = store.get(AVATAR_KEY); // picked on the join screen
let avatarList: string[] = [];

const clock = new ServerClock();

nameInput.value = store.get(NAME_KEY) ?? "";

/** The avatar to draw for this player: the server's copy once joined. */
const myAvatar = (): string =>
  (state?.role === "player" && state.me?.avatar) || chosenAvatar || "🙂";

void loadAvatars().then((avatars) => {
  avatarList = avatars;
  if (!chosenAvatar || !avatars.includes(chosenAvatar)) chosenAvatar = randomAvatar(avatars);
  renderAvatarGrid($(".join-avatars"), avatars, chosenAvatar, (a) => {
    chosenAvatar = a;
    store.set(AVATAR_KEY, a);
  });
});

// ----------------------------------------------------------------------- map

let map: L.Map | null = null;
const layer = L.layerGroup();

function startView(): MapStart {
  return state?.map_start ?? "europe";
}

function ensureMap(): L.Map {
  if (!map) {
    map = createMap($("#map"), { zoomControl: false }, startView());
    L.control.zoom({ position: "bottomright", zoomInTitle: "+", zoomOutTitle: "−" }).addTo(map);
    layer.addTo(map);
    map.on("click", (ev: L.LeafletMouseEvent) => placePin(ev.latlng));
  }
  requestAnimationFrame(() => map!.invalidateSize());
  return map;
}

/** Map padding that keeps things out from under the photo thumbnail and the +/- buttons. */
function thumbPadding(extra: number): { paddingTopLeft: L.PointTuple; paddingBottomRight: L.PointTuple } {
  const thumbBottom = photoBtn.offsetTop + photoBtn.offsetHeight;
  const zoomButtons = map?.getContainer().querySelector<HTMLElement>(".leaflet-control-zoom")?.offsetHeight ?? 92;
  return { paddingTopLeft: [extra, thumbBottom + extra], paddingBottomRight: [extra, zoomButtons + extra + 10] };
}

/** In the lobby: pre-load the map the first round opens on (and one zoom level in). */
function preloadStartView(): void {
  const start = startView();
  if (start === "photo") { // each round's hint area is pre-loaded when the round starts
    void preloadViews([]);
    return;
  }
  const v = startViewOf(start);
  const view: View = {
    lat: v.center[0], lng: v.center[1], zoom: v.zoom,
    width: window.innerWidth, height: Math.max(300, window.innerHeight - 170), // minus the top and bottom bars
  };
  void preloadViews([view, deeper(view, 1)]);
}

/** Round start with a hint frame: pre-load the frame's area one and two zoom levels in. */
function preloadHintArea(m: L.Map, bounds: [[number, number], [number, number]]): void {
  const b = L.latLngBounds(bounds);
  const nw = m.latLngToContainerPoint(b.getNorthWest());
  const se = m.latLngToContainerPoint(b.getSouthEast());
  const c = b.getCenter();
  const frame: View = { lat: c.lat, lng: c.lng, zoom: m.getZoom(), width: se.x - nw.x, height: se.y - nw.y };
  void preloadViews([deeper(frame, 1), deeper(frame, 2)], { urgent: true });
}

function canGuess(): boolean {
  return !!state && state.role === "player" && state.phase === "question"
    && !state.closed && !state.my_guess;
}

function placePin(latlng: L.LatLng): void {
  if (!canGuess()) return;
  if (!pendingMarker) {
    pendingMarker = L.marker(latlng, { icon: avatarPinIcon(myAvatar()), draggable: true, keyboard: false }).addTo(layer);
  } else {
    pendingMarker.setLatLng(latlng);
  }
  lockBtn.disabled = false;
}

// ------------------------------------------------------------------- socket

const socket = new LiveSocket("/ws/player", {
  onOpen: () => {
    if (playerId) {
      socket.send({ type: "join", player_id: playerId, name: store.get(NAME_KEY) ?? "", avatar: chosenAvatar });
    }
  },
  onStatus: (s) => {
    $(".connection-lost").hidden = s === "open" || (s === "connecting" && state === null);
  },
  onMessage: handle,
});

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case "state":
      if (msg.role === "host") return;
      clock.sync(msg.server_now);
      state = msg;
      render();
      break;
    case "joined":
      joining = false;
      playerId = msg.player_id;
      store.set(ID_KEY, msg.player_id);
      store.set(NAME_KEY, msg.name);
      store.set(AVATAR_KEY, msg.avatar);
      chosenAvatar = msg.avatar;
      goneReason = null;
      break;
    case "error":
      joining = false;
      if (msg.code === "kicked") {
        forget("kicked");
      } else if (!state || state.role !== "player") {
        joinError.textContent = errorText(msg.code);
        joinError.hidden = false;
        renderJoinButton();
      } else {
        toast(errorText(msg.code), "error");
        lockBtn.disabled = !pendingMarker;
      }
      break;
    case "kicked":
      forget("kicked");
      break;
    case "reset":
      forget("reset");
      break;
  }
}

function forget(reason: "kicked" | "reset"): void {
  playerId = null;
  store.del(ID_KEY);
  goneReason = reason;
  state = null;
  render();
}

// -------------------------------------------------------------------- render

function applyStaticText(): void {
  document.querySelectorAll<HTMLElement>("[data-t]").forEach((el) => {
    el.textContent = t(el.dataset.t as Key);
  });
  $(".lang-toggle").textContent = lang() === "cs" ? "EN" : "CZ";
  nameInput.placeholder = t("namePlaceholder");
}

function renderJoinButton(): void {
  joinBtn.disabled = joining;
  joinBtn.textContent = joining ? t("joining") : t("join");
}

function render(): void {
  applyStaticText();

  if (goneReason) {
    showView(views, "gone");
    $(".gone-title").textContent = goneReason === "kicked" ? t("kicked") : t("gameReset");
    $(".rejoin-btn").hidden = goneReason === "kicked";
    $(".me").hidden = true;
    timerEl.hidden = true;
    $(".round-label").textContent = "";
    return;
  }

  if (!state || state.role !== "player") {
    showView(views, "join");
    $(".title").textContent = state ? pick(state.title) : "";
    $(".subtitle").textContent = state ? pick(state.subtitle) : "";
    $(".me").hidden = true;
    timerEl.hidden = true;
    $(".round-label").textContent = "";
    renderJoinButton();
    return;
  }

  const s = state;
  const me = s.me!;
  $(".me").hidden = false;
  $(".me-avatar").textContent = me.avatar;
  $(".me-name").textContent = me.name;
  $(".me-points").textContent = t("points", { n: formatNumber(me.total) });
  $(".round-label").textContent = s.round_index >= 0 && s.phase !== "final"
    ? t("round", { i: s.round_index + 1, n: s.round_count }) : "";

  if (s.phase !== "lobby") sheet.hidden = true;

  switch (s.phase) {
    case "lobby":
      showView(views, "lobby");
      $(".lobby-hello").textContent = t("youreIn", { name: me.name });
      $(".lobby-avatar-emoji").textContent = me.avatar;
      $(".lobby-count").textContent = t("joinedCount", { n: s.player_count });
      preparedRound = revealedRound = -1;
      preloadStartView();
      celebrated = false;
      break;
    case "question":
      renderQuestion(s);
      break;
    case "reveal":
      renderReveal(s);
      break;
    case "leaderboard":
    case "final":
      renderStanding(s);
      break;
  }
  timerEl.hidden = s.phase !== "question";
  tick();
}

function renderQuestion(s: PlayerState): void {
  showView(views, "play");
  const m = ensureMap();

  if (preparedRound !== s.round_index) {
    preparedRound = s.round_index;
    layer.clearLayers();
    pendingMarker = null;
    if (s.start_bounds) {
      // "Around the photo": open on the hint area and frame it.
      m.invalidateSize({ animate: false }); // the map was hidden between rounds
      m.fitBounds(s.start_bounds, { animate: false, ...thumbPadding(14) });
      preloadHintArea(m, s.start_bounds);
      L.rectangle(s.start_bounds, {
        color: "#9c4a5a", weight: 2, dashArray: "6 5", fillColor: "#9c4a5a", fillOpacity: 0.05,
        interactive: false, className: "hint-area",
      }).addTo(layer);
    } else {
      const view = startViewOf(startView());
      m.setView(view.center, view.zoom, { animate: false });
    }
    photoImg.src = s.photo ?? "";
    lockBtn.disabled = true;
  }
  $(".hint").textContent = s.start_bounds ? t("tapMapHint") : t("tapMap");

  if (s.my_guess) {
    // Server confirmed our guess: pin it in place (the hint frame stays).
    pendingMarker?.remove();
    pendingMarker = null;
    layer.eachLayer((l) => { if (l instanceof L.Marker) layer.removeLayer(l); });
    L.marker([s.my_guess.lat, s.my_guess.lng], { icon: avatarPinIcon(myAvatar()), keyboard: false }).addTo(layer);
    setAction("status", t("guessLocked"), t("waitingOthers"));
  } else if (s.closed) {
    pendingMarker?.dragging?.disable();
    setAction("status", t("timesUp"), t("lookUp"));
  } else {
    setAction("guess");
  }
}

function renderReveal(s: PlayerState): void {
  showView(views, "play");
  const m = ensureMap();
  if (preparedRound !== s.round_index) {
    // Joined (or reconnected) straight into a reveal.
    preparedRound = s.round_index;
    photoImg.src = s.photo ?? "";
  }
  if (revealedRound !== s.round_index && s.answer) {
    revealedRound = s.round_index;
    layer.clearLayers();
    pendingMarker = null;
    const answer = L.latLng(s.answer.lat, s.answer.lng);
    L.marker(answer, { icon: answerIcon, keyboard: false, zIndexOffset: 1000 }).addTo(layer);
    if (s.my_guess) {
      const g = L.latLng(s.my_guess.lat, nearLng(s.my_guess.lng, answer.lng));
      L.marker(g, { icon: avatarPinIcon(myAvatar()), keyboard: false }).addTo(layer);
      const round = s.round_index;
      flyThen(
        m,
        () => m.flyToBounds(L.latLngBounds([g, answer]), { ...thumbPadding(48), maxZoom: 16, duration: 1.2 }),
        () => {
          if (revealedRound !== round || state?.phase !== "reveal") return;
          L.polyline([g, answer], {
            color: "#2a2724", weight: 2, dashArray: "6 6", opacity: 0.7, className: "reveal-line", interactive: false,
          }).addTo(layer);
        },
        1.2,
      );
    } else {
      m.flyTo(answer, 5, { duration: 1.2 });
    }
  }

  setAction("result");
  const pts = $(".result-points");
  const dist = $(".result-distance");
  if (s.result) {
    pts.textContent = `+${t("pointsLong", { n: formatNumber(s.result.points) })}`;
    dist.textContent = t("kmAway", { d: formatDistance(s.result.distance_km) });
  } else {
    pts.textContent = t("noGuess");
    dist.textContent = "";
  }
  $(".result-caption").textContent = s.answer ? pick(s.answer.caption) : "";
}

function renderStanding(s: PlayerState): void {
  showView(views, "standing");
  const me = s.me!;
  const final = s.phase === "final";
  $(".standing-kicker").textContent = final ? t("finalTitle") : t("leaderboard");
  $(".standing-avatar").textContent = me.avatar;
  $(".rank").textContent = me.rank ? `#${me.rank}` : "–";
  $(".standing-total").textContent = `${t("totalPoints", { n: formatNumber(me.total) })} · ${t("yourRank", {
    rank: me.rank ?? "–", n: s.player_count,
  })}`;

  const change = $(".rank-change");
  const diff = me.prev_rank && me.rank ? me.prev_rank - me.rank : 0;
  change.className = `rank-change tabular ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`;
  change.textContent = !final && diff !== 0 ? `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}` : "";

  const podium = $(".podium-list");
  podium.hidden = !final || !s.podium;
  if (final && s.podium) {
    podium.innerHTML = s.podium.map((p) => `
      <li class="podium-${p.rank}"><span class="medal">${["🥇", "🥈", "🥉"][p.rank - 1] ?? p.rank}</span>
        <span class="podium-avatar" aria-hidden="true">${esc(p.avatar)}</span>
        <span class="podium-name">${esc(p.name)}</span>
        <span class="podium-total tabular">${esc(formatNumber(p.total))}</span></li>`).join("");
    if (!celebrated && me.rank && me.rank <= 3) {
      celebrated = true;
      confetti({ particleCount: 140, spread: 80, origin: { y: 0.4 } });
    }
  }
  $(".standing-foot").textContent = final ? t("thanks") : t("lookUp");
}

function setAction(mode: "guess" | "status" | "result", title = "", sub = ""): void {
  action.dataset.mode = mode;
  if (mode === "status") {
    $(".status-title").textContent = title;
    $(".status-sub").textContent = sub;
  }
}

// --------------------------------------------------------------------- timer

function tick(): void {
  if (!state || state.phase !== "question") return;
  const limit = state.time_limit ?? 1;
  const left = state.closed ? 0 : clock.remaining(state.ends_at);
  timerFill.style.transform = `scaleX(${Math.min(1, left / limit)})`;
  timerText.textContent = `${Math.ceil(left)}`;
  timerEl.classList.toggle("urgent", left > 0 && left <= 5);
}
setInterval(tick, 200);

// -------------------------------------------------------------------- events

joinForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  joinError.hidden = true;
  joining = true;
  renderJoinButton();
  store.set(NAME_KEY, name);
  if (!socket.send({ type: "join", name, player_id: playerId, avatar: chosenAvatar })) {
    joining = false;
    renderJoinButton();
    toast(t("reconnecting"), "error");
  }
});

lockBtn.addEventListener("click", () => {
  if (!pendingMarker || !canGuess()) return;
  const { lat, lng } = pendingMarker.getLatLng();
  if (socket.send({ type: "guess", lat, lng: wrapLng(lng) })) {
    lockBtn.disabled = true;
    pendingMarker.dragging?.disable();
  } else {
    toast(t("reconnecting"), "error");
  }
});

photoBtn.setAttribute("aria-label", t("tapToZoom"));
photoBtn.addEventListener("click", () => {
  if (!photoImg.src) return;
  $<HTMLImageElement>("img", lightbox).src = photoImg.src;
  lightbox.hidden = false;
});
lightbox.addEventListener("click", () => { lightbox.hidden = true; });

$(".rejoin-btn").addEventListener("click", () => {
  goneReason = null;
  render();
  nameInput.focus();
});

// Changing the avatar after joining (lobby only - it's the moment people fiddle).
$(".lobby-avatar").addEventListener("click", () => {
  renderAvatarGrid($(".sheet-avatars"), avatarList, myAvatar(), (a) => {
    chosenAvatar = a;
    store.set(AVATAR_KEY, a);
    socket.send({ type: "avatar", avatar: a });
  });
  sheet.hidden = false;
});
$(".sheet-done").addEventListener("click", () => { sheet.hidden = true; });
sheet.addEventListener("click", (ev) => { if (ev.target === sheet) sheet.hidden = true; });

$(".lang-toggle").addEventListener("click", toggleLang);
onLangChange(render);

app.dataset.ready = "1";
render();
