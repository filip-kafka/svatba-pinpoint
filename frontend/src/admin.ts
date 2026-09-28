import "@fontsource-variable/inter";
import "@fontsource/fraunces/600.css";
import "./styles/base.css";
import "./styles/admin.css";

import { forgetToken, requireToken } from "./shared/auth";
import { $, esc, toast } from "./shared/dom";
import { answerIcon, createMap, L, wrapLng } from "./shared/map";
import type { PhotoItem, QuizSettings } from "./shared/types";

const token = await requireToken($(".login-root"));
const app = $("#app");
app.hidden = false;

// --------------------------------------------------------------------- API

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const r = await fetch(path, init);
  if (r.status === 401) {
    forgetToken();
    location.reload();
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

let photos: PhotoItem[] = [];
let settings: QuizSettings;

async function load(): Promise<void> {
  const quiz = await api<{ settings: QuizSettings; photos: PhotoItem[]; game_phase: string }>("GET", "/api/admin/quiz");
  photos = quiz.photos;
  settings = quiz.settings;
  $(".running-banner").hidden = quiz.game_phase === "lobby";
  renderSettings();
  renderPhotos();
}

// ---------------------------------------------------------------- settings

const settingsForm = $<HTMLFormElement>(".settings-form");

function renderSettings(): void {
  for (const [k, v] of Object.entries(settings)) {
    const input = settingsForm.elements.namedItem(k) as HTMLInputElement | null;
    if (input) input.value = String(v);
  }
}

settingsForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(settingsForm)) as Record<string, string>;
  try {
    settings = await api<QuizSettings>("PUT", "/api/admin/settings", {
      ...data,
      default_time_limit: Number(data.default_time_limit) || 40,
    });
    toast("Settings saved");
  } catch (e) {
    toast(`Could not save: ${e}`, "error");
  }
});

// ------------------------------------------------------------------ upload

const dropzone = $(".dropzone");
const fileInput = $<HTMLInputElement>("input[type=file]", dropzone);
const progress = $(".upload-progress");

async function upload(files: File[]): Promise<void> {
  const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!images.length) return;
  progress.hidden = false;
  let done = 0;
  const problems: string[] = [];
  // Small batches keep each request short and give a live progress count.
  for (let i = 0; i < images.length; i += 3) {
    const form = new FormData();
    images.slice(i, i + 3).forEach((f) => form.append("files", f, f.name));
    progress.textContent = `Uploading ${done + 1}–${Math.min(done + 3, images.length)} of ${images.length}…`;
    try {
      const res = await api<{ added: PhotoItem[]; errors: { file: string; error: string }[] }>(
        "POST", "/api/admin/photos", form);
      photos.push(...res.added);
      problems.push(...res.errors.map((e) => `${e.file}: ${e.error}`));
    } catch (e) {
      problems.push(String(e));
    }
    done = Math.min(done + 3, images.length);
    renderPhotos();
  }
  progress.hidden = true;
  const withGps = photos.filter((p) => p.from_exif).length;
  toast(`Uploaded ${images.length - problems.length} photo(s). ${withGps} have GPS from the camera.`);
  if (problems.length) toast(`Skipped: ${problems.join(", ")}`, "error", 6000);
}

fileInput.addEventListener("change", () => {
  void upload([...(fileInput.files ?? [])]);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dropzone.classList.remove("over");
  void upload([...(ev.dataTransfer?.files ?? [])]);
});

// ------------------------------------------------------------------ photos

const list = $(".photo-list");
const SCALE_LABELS: Record<PhotoItem["scale"], string> = {
  world: "World (generous)",
  continent: "Continent",
  country: "Country",
  city: "City (strict)",
};

function renderPhotos(): void {
  const ready = photos.filter((p) => p.lat != null).length;
  $(".photos-summary").textContent = photos.length
    ? `${photos.length} photos · ${ready} ready${photos.length - ready ? ` · ${photos.length - ready} need a location` : ""}`
    : "No photos yet.";

  list.innerHTML = photos.map((p, i) => {
    const located = p.lat != null && p.lng != null;
    const status = located
      ? `<span class="badge ok">📍 ${p.from_exif ? "from photo GPS" : "set manually"}</span>
         <span class="coords muted tabular">${p.lat!.toFixed(4)}, ${p.lng!.toFixed(4)}</span>`
      : `<span class="badge warn">⚠ needs a location</span>`;
    return `
    <li class="photo-row card ${located ? "" : "missing"}" data-id="${esc(p.id)}">
      <span class="num tabular">${i + 1}</span>
      <button class="thumb" data-act="locate" title="Set location"><img src="/media/${esc(p.id)}_thumb.jpg" alt="" loading="lazy" /></button>
      <div class="fields">
        <label>Caption shown at reveal (CZ)<input data-field="caption_cs" value="${esc(p.caption_cs)}" maxlength="120" placeholder="e.g. Naše první dovolená – Kréta" /></label>
        <label>Caption (EN)<input data-field="caption_en" value="${esc(p.caption_en)}" maxlength="120" placeholder="e.g. Our first holiday – Crete" /></label>
        <label>Scoring
          <select data-field="scale">${Object.entries(SCALE_LABELS).map(([k, v]) =>
            `<option value="${k}" ${p.scale === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        </label>
        <label>Seconds<input data-field="time_limit" type="number" min="5" max="600" step="5" value="${p.time_limit ?? ""}" placeholder="${settings.default_time_limit}" /></label>
        <div class="loc">${status} <button class="btn btn-small" data-act="locate">${located ? "Adjust" : "Set location"}</button></div>
      </div>
      <div class="row-actions">
        <button class="btn btn-icon" data-act="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn-icon" data-act="down" title="Move down" ${i === photos.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn-icon btn-danger" data-act="delete" title="Delete">🗑</button>
      </div>
    </li>`;
  }).join("");
}

list.addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement | HTMLSelectElement;
  const field = input.dataset.field;
  const id = input.closest<HTMLElement>(".photo-row")?.dataset.id;
  if (!field || !id) return;
  let body: Record<string, unknown>;
  if (field === "time_limit") {
    body = input.value ? { time_limit: Number(input.value) } : { clear_time_limit: true };
  } else {
    body = { [field]: input.value };
  }
  try {
    const updated = await api<PhotoItem>("PATCH", `/api/admin/photos/${id}`, body);
    photos = photos.map((p) => (p.id === id ? updated : p));
    toast("Saved");
  } catch (e) {
    toast(`Could not save: ${e}`, "error");
  }
});

list.addEventListener("click", async (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  const id = btn?.closest<HTMLElement>(".photo-row")?.dataset.id;
  if (!btn || !id) return;
  const idx = photos.findIndex((p) => p.id === id);
  switch (btn.dataset.act) {
    case "locate":
      openEditor(photos[idx]);
      break;
    case "up":
    case "down": {
      const j = btn.dataset.act === "up" ? idx - 1 : idx + 1;
      if (j < 0 || j >= photos.length) return;
      [photos[idx], photos[j]] = [photos[j], photos[idx]];
      renderPhotos();
      await api("PUT", "/api/admin/order", { ids: photos.map((p) => p.id) }).catch(async (e) => {
        toast(`Could not reorder: ${e}`, "error");
        await load();
      });
      break;
    }
    case "delete":
      if (!confirm("Delete this photo?")) return;
      await api("DELETE", `/api/admin/photos/${id}`);
      photos = photos.filter((p) => p.id !== id);
      renderPhotos();
      break;
  }
});

// ---------------------------------------------------------- location editor

const editor = $<HTMLDialogElement>(".editor");
const saveBtn = $<HTMLButtonElement>(".editor-save");
const readout = $(".coords-readout");
const searchInput = $<HTMLInputElement>(".search-input");
const results = $(".search-results");
const coordsInput = $<HTMLInputElement>(".coords-input");
let editorMap: L.Map | null = null;
let editorMarker: L.Marker | null = null;
let editing: PhotoItem | null = null;

function setMarker(ll: L.LatLng, pan = false): void {
  if (!editorMap) return;
  const fixed = L.latLng(ll.lat, wrapLng(ll.lng));
  if (!editorMarker) {
    editorMarker = L.marker(fixed, { icon: answerIcon, draggable: true }).addTo(editorMap);
    editorMarker.on("dragend", () => setMarker(editorMarker!.getLatLng()));
  } else {
    editorMarker.setLatLng(fixed);
  }
  if (pan) editorMap.setView(fixed, Math.max(editorMap.getZoom(), 13));
  readout.textContent = `${fixed.lat.toFixed(5)}, ${fixed.lng.toFixed(5)}`;
  saveBtn.disabled = false;
}

function openEditor(p: PhotoItem): void {
  editing = p;
  $<HTMLImageElement>(".editor-photo img").src = `/media/${p.id}.jpg`;
  results.innerHTML = "";
  searchInput.value = "";
  coordsInput.value = "";
  readout.textContent = "";
  saveBtn.disabled = true;
  editor.showModal();

  if (!editorMap) {
    editorMap = createMap($(".editor-map"));
    editorMap.on("click", (ev: L.LeafletMouseEvent) => setMarker(ev.latlng));
  }
  editorMarker?.remove();
  editorMarker = null;
  requestAnimationFrame(() => {
    editorMap!.invalidateSize();
    if (p.lat != null && p.lng != null) {
      setMarker(L.latLng(p.lat, p.lng));
      editorMap!.setView([p.lat, p.lng], 13);
      saveBtn.disabled = true; // nothing changed yet
    } else {
      editorMap!.setView([30, 10], 2);
    }
  });
}

editor.addEventListener("close", async () => {
  if (editor.returnValue !== "save" || !editing || !editorMarker) return;
  const { lat, lng } = editorMarker.getLatLng();
  try {
    const updated = await api<PhotoItem>("PATCH", `/api/admin/photos/${editing.id}`, { lat, lng: wrapLng(lng) });
    photos = photos.map((x) => (x.id === updated.id ? updated : x));
    renderPhotos();
    toast("Location saved");
  } catch (e) {
    toast(`Could not save: ${e}`, "error");
  }
});

searchInput.addEventListener("keydown", async (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  results.innerHTML = `<li class="muted">Searching…</li>`;
  try {
    // OpenStreetMap's free geocoder - fine for occasional admin lookups.
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`);
    const hits = (await r.json()) as { display_name: string; lat: string; lon: string }[];
    results.innerHTML = hits.length
      ? hits.map((h) => `<li><button type="button" class="linkish" data-lat="${esc(h.lat)}" data-lng="${esc(h.lon)}">${esc(h.display_name)}</button></li>`).join("")
      : `<li class="muted">No results</li>`;
  } catch {
    results.innerHTML = `<li class="muted">Search failed – click the map or paste coordinates instead.</li>`;
  }
});

results.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-lat]");
  if (!b) return;
  setMarker(L.latLng(Number(b.dataset.lat), Number(b.dataset.lng)), true);
  results.innerHTML = "";
});

coordsInput.addEventListener("input", () => {
  const m = coordsInput.value.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) setMarker(L.latLng(lat, lng), true);
});
coordsInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") ev.preventDefault();
});

await load();
