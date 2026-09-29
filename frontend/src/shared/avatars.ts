/** Avatars: the list comes from the server (backend/app/avatars.py). */

import { esc } from "./dom";

let list: Promise<string[]> | null = null;

export function loadAvatars(): Promise<string[]> {
  list ??= fetch("/api/avatars")
    .then((r) => r.json() as Promise<string[]>)
    .catch(() => {
      list = null; // try again next time
      return [];
    });
  return list;
}

export const randomAvatar = (avatars: string[]): string =>
  avatars[Math.floor(Math.random() * avatars.length)] ?? "🙂";

/**
 * Fill `grid` with one button per avatar. Arrow keys aren't wired up because
 * this is a phone-first picker; each button is a plain, tappable radio.
 */
export function renderAvatarGrid(
  grid: HTMLElement,
  avatars: string[],
  selected: string | null,
  onPick: (avatar: string) => void,
): void {
  grid.setAttribute("role", "radiogroup");
  grid.innerHTML = avatars
    .map((a) => `<button type="button" role="radio" class="avatar-option" data-avatar="${esc(a)}"
      aria-checked="${a === selected}">${esc(a)}</button>`)
    .join("");
  grid.onclick = (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-avatar]");
    if (!btn) return;
    grid.querySelectorAll("[aria-checked=true]").forEach((b) => b.setAttribute("aria-checked", "false"));
    btn.setAttribute("aria-checked", "true");
    onPick(btn.dataset.avatar!);
  };
}

/** Inline avatar for lists: `<span class="av">🦊</span>`. */
export const avatarSpan = (avatar: string | undefined, cls = "av"): string =>
  `<span class="${cls}" aria-hidden="true">${esc(avatar ?? "")}</span>`;
