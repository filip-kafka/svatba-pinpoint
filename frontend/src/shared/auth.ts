/** Organizer password handling shared by /host and /admin. */

import { t } from "./i18n";
import { esc } from "./dom";

const KEY = "pinpoint.token";

export function storedToken(): string | null {
  // Allow /host?token=... once (handy for bookmarking on the projector laptop),
  // then remove it from the address bar so it isn't shown on the big screen.
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try { localStorage.setItem(KEY, fromUrl); } catch {}
    url.searchParams.delete("token");
    history.replaceState(null, "", url);
    return fromUrl;
  }
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function forgetToken(): void {
  try { localStorage.removeItem(KEY); } catch {}
}

export async function checkToken(token: string): Promise<boolean> {
  const r = await fetch("/api/admin/check", { headers: { Authorization: `Bearer ${token}` } });
  return r.status === 204;
}

/** Resolve with a valid token, showing a login form over `root` if needed. */
export async function requireToken(root: HTMLElement): Promise<string> {
  const existing = storedToken();
  if (existing && (await checkToken(existing).catch(() => false))) return existing;

  return new Promise((resolve) => {
    root.innerHTML = `
      <form class="login card">
        <h1 class="display">Pinpoint</h1>
        <label>${esc(t("adminToken"))}
          <input type="password" name="token" autocomplete="current-password" required autofocus>
        </label>
        <button class="btn btn-primary" type="submit">${esc(t("login"))}</button>
        <p class="login-error" hidden>${esc(t("badToken"))}</p>
      </form>`;
    const form = root.querySelector("form")!;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const token = (form.elements.namedItem("token") as HTMLInputElement).value.trim();
      if (await checkToken(token).catch(() => false)) {
        try { localStorage.setItem(KEY, token); } catch {}
        root.innerHTML = "";
        resolve(token);
      } else {
        (form.querySelector(".login-error") as HTMLElement).hidden = false;
      }
    });
  });
}
