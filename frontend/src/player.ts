import "@fontsource-variable/inter";
import "@fontsource/fraunces/600.css";
import "./styles/base.css";
import "./styles/player.css";
import confetti from "canvas-confetti";

import { $, esc, showView, toast } from "./shared/dom";
import {
  errorText, formatDistance, formatNumber, lang, onLangChange, pick, t, toggleLang, type Key,
} from "./shared/i18n";
import { answerIcon, createMap, flyThen, guessIcon, L, nearLng, START_VIEWS, warmUpMap, wrapLng, type MapStart } from "./shared/map";
import { LiveSocket, ServerClock } from "./shared/socket";
import type { AnonymousState, PlayerState, ServerMessage } from "./shared/types";

const ID_KEY = "pinpoint.player";
const NAME_KEY = "pinpoint.name";

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

// --------------------------------------------------------------------- state

let playerId = store.get(ID_KEY);
let state: PlayerState | AnonymousState | null = null;
let joining = false;
let goneReason: "kicked" | "reset" | null = null;
let preparedRound = -1;
let revealedRound = -1;
let pendingMarker: L.Marker | null = null;
let celebrated = false;

const clock = new ServerClock();

nameInput.value = store.get(NAME_KEY) ?? "";

// ----------------------------------------------------------------------- map

let map: L.Map | null = null;
const layer = L.layerGroup();

function startView(): MapStart {
  return state?.map_start ?? "europe";
}

function ensureMap(): L.Map {
  if (!map) {
    map = createMap($("#map"), { zoomControl: false }, startView());
    layer.addTo(map);
    map.on("click", (ev: L.LeafletMouseEvent) => placePin(ev.latlng));
  }
  requestAnimationFrame(() => map!.invalidateSize());
  return map;
}

function canGuess(): boolean {
  return !!state && state.role === "player" && state.phase === "question"
    && !state.closed && !state.my_guess;
}

function placePin(latlng: L.LatLng): void {
  if (!canGuess()) return;
  if (!pendingMarker) {
    pendingMarker = L.marker(latlng, { icon: guessIcon, draggable: true, keyboard: false }).addTo(layer);
  } else {
    pendingMarker.setLatLng(latlng);
  }
  lockBtn.disabled = false;
}

// ------------------------------------------------------------------- socket

const socket = new LiveSocket("/ws/player", {
  onOpen: () => {
    if (playerId) socket.send({ type: "join", player_id: playerId, name: store.get(NAME_KEY) ?? "" });
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
  $(".me-name").textContent = me.name;
  $(".me-points").textContent = t("points", { n: formatNumber(me.total) });
  $(".round-label").textContent = s.round_index >= 0 && s.phase !== "final"
    ? t("round", { i: s.round_index + 1, n: s.round_count }) : "";

  switch (s.phase) {
    case "lobby":
      showView(views, "lobby");
      $(".lobby-hello").textContent = t("youreIn", { name: me.name });
      $(".lobby-count").textContent = t("joinedCount", { n: s.player_count });
      preparedRound = revealedRound = -1;
      warmUpMap();
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
    const view = START_VIEWS[startView()];
    m.setView(view.center, view.zoom, { animate: false });
    photoImg.src = s.photo ?? "";
    lockBtn.disabled = true;
  }

  if (s.my_guess) {
    // Server confirmed our guess: pin it in place.
    layer.clearLayers();
    pendingMarker = null;
    L.marker([s.my_guess.lat, s.my_guess.lng], { icon: guessIcon, keyboard: false }).addTo(layer);
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
      L.marker(g, { icon: guessIcon, keyboard: false }).addTo(layer);
      const round = s.round_index;
      flyThen(
        m,
        () => m.flyToBounds(L.latLngBounds([g, answer]), { padding: [48, 48], maxZoom: 12, duration: 1.2 }),
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
  if (!socket.send({ type: "join", name, player_id: playerId })) {
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

$(".lang-toggle").addEventListener("click", toggleLang);
onLangChange(render);

app.dataset.ready = "1";
render();
