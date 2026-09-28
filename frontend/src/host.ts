import "@fontsource-variable/inter";
import "@fontsource/fraunces/600.css";
import "./styles/base.css";
import "./styles/host.css";
import confetti from "canvas-confetti";
import QRCode from "qrcode";

import { requireToken, forgetToken } from "./shared/auth";
import { $, esc, showView, toast } from "./shared/dom";
import { errorText, formatDistance, formatNumber, lang, onLangChange, pick, t, toggleLang } from "./shared/i18n";
import { answerIcon, createMap, L, nearLng } from "./shared/map";
import { LiveSocket, ServerClock } from "./shared/socket";
import type { HostState, LeaderRow, ServerMessage } from "./shared/types";

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
      li.textContent = p.name;
      list.append(li);
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
window.addEventListener("resize", () => {
  if (state?.phase === "lobby") {
    fitChips();
    fitText($(".join-url"));
  }
});

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
const revealLayer = L.layerGroup();

function renderReveal(s: HostState): void {
  if (!revealMap) {
    revealMap = createMap($("#reveal-map"), { zoomControl: false, attributionControl: true });
    revealLayer.addTo(revealMap);
  }
  const m = revealMap;
  requestAnimationFrame(() => m.invalidateSize());
  revealLayer.clearLayers();

  const a = s.answer!;
  const answer = L.latLng(a.lat, a.lng);
  const guesses = s.guesses ?? [];
  const points: L.LatLng[] = [answer];

  guesses.forEach((g, i) => {
    const ll = L.latLng(g.lat, nearLng(g.lng, a.lng));
    points.push(ll);
    L.polyline([ll, answer], { color: "#2a2724", weight: 1.5, opacity: 0.25, dashArray: "4 6" }).addTo(revealLayer);
    const dot = L.circleMarker(ll, {
      radius: i < 3 ? 9 : 6, color: "#fff", weight: 2, fillColor: i < 3 ? "#b8913e" : "#2f5d7c", fillOpacity: 0.95,
    }).addTo(revealLayer);
    if (i < 3) {
      // Spread the three labels so nearby guesses don't cover each other.
      const dir = (["top", "bottom", "right"] as const)[i];
      const offset: L.PointTuple = [[0, -8], [0, 8], [8, 0]][i] as L.PointTuple;
      dot.bindTooltip(esc(g.name), { permanent: true, direction: dir, className: "guess-label", offset });
    }
  });
  L.marker(answer, { icon: answerIcon, zIndexOffset: 1000, keyboard: false }).addTo(revealLayer);

  m.setView([25, 10], 1.6, { animate: false });
  setTimeout(() => {
    if (points.length > 1) {
      m.flyToBounds(L.latLngBounds(points), { padding: [70, 70], paddingBottomRight: [460, 70], maxZoom: 13, duration: 1.8 });
    } else {
      m.flyTo(answer, 6, { duration: 1.8 });
    }
  }, 350);

  $<HTMLImageElement>(".reveal-thumb").src = s.photo ?? "";
  const caption = pick(a.caption);
  $(".reveal-caption").textContent = caption;
  $(".reveal-caption").hidden = !caption;
  $(".reveal-closest-label").textContent = t("closest");
  $(".closest").innerHTML = guesses.slice(0, 5).map((g) => `
    <li><span class="c-name">${esc(g.name)}</span>
      <span class="c-dist muted tabular">${esc(formatDistance(g.distance_km))}</span>
      <span class="c-pts tabular">+${esc(formatNumber(g.points))}</span></li>`).join("")
    || `<li class="muted">–</li>`;
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
      <span class="b-name">${esc(r.name)}</span>
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
      <div class="step-name display">${esc(r.name)}</div>
      <div class="step-points tabular">${esc(formatNumber(r.total))}</div>
      <div class="step-block display">${r.rank}</div>
    </div>`).join("");
  $(".final-rest").innerHTML = rows.slice(3, 10).map((r) => `
    <li><span class="tabular">${r.rank}.</span> ${esc(r.name)} <span class="muted tabular">${esc(formatNumber(r.total))}</span></li>`).join("");

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
      <span class="d-name">${esc(p.name)}</span>
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
