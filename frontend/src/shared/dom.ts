/** Tiny DOM helpers - no framework, just enough to keep templates readable and safe. */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape user-supplied text (player names!) before putting it in innerHTML. */
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

/** Show exactly one `[data-view]` child of `root`. */
export function showView(root: HTMLElement, name: string): void {
  root.querySelectorAll<HTMLElement>(":scope > [data-view]").forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  root.dataset.current = name;
}

export function toast(text: string, kind: "info" | "error" = "info", ms = 2600): void {
  let host = document.querySelector<HTMLElement>(".toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    document.body.append(host);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  host.append(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}
