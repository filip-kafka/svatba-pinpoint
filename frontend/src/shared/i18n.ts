/** Two-language UI strings. Add a key in both languages; `t()` falls back to English. */

export type Lang = "cs" | "en";

const strings = {
  cs: {
    // player
    yourName: "Tvoje jméno",
    namePlaceholder: "např. teta Jarka",
    join: "Hrát",
    joining: "Připojuji…",
    youreIn: "Jsi ve hře, {name}!",
    watchScreen: "Sleduj plátno – hra brzy začne.",
    joinedCount: "Připojeno hráčů: {n}",
    round: "Kolo {i} z {n}",
    tapMap: "Klepni do mapy, kde byla fotka pořízena",
    lockIn: "Potvrdit tip",
    guessLocked: "Tip uložen ✓",
    waitingOthers: "Čekáme na ostatní…",
    timesUp: "Čas vypršel",
    noGuess: "V tomhle kole bez tipu",
    kmAway: "{d} daleko",
    points: "{n} b.",
    pointsLong: "{n} bodů",
    yourRank: "{rank}. místo z {n}",
    totalPoints: "Celkem {n} bodů",
    lookUp: "Podívej se na plátno!",
    finalTitle: "Konec hry!",
    youFinished: "Skončil(a) jsi na {rank}. místě",
    thanks: "Díky za hraní ♥",
    kicked: "Organizátor tě odebral ze hry.",
    gameReset: "Hra byla restartována.",
    joinAgain: "Připojit se znovu",
    reconnecting: "Obnovuji spojení…",
    tapToZoom: "Klepni pro zvětšení",
    // host
    joinAt: "Připoj se na",
    orScan: "nebo naskenuj kód",
    players: "Hráči",
    noPlayersYet: "Zatím nikdo… naskenujte QR kód!",
    pressToStart: "→ / mezerník pro start",
    pressToReveal: "→ odhalit odpověď",
    pressToContinue: "→ pokračovat",
    answered: "odpovědělo",
    closest: "Nejblíž",
    leaderboard: "Průběžné pořadí",
    photosReady: "Připravených fotek: {n}",
    photosMissing: "Fotek bez polohy: {n} (nebudou ve hře)",
    noPhotos: "Nejdřív nahraj fotky v administraci.",
    next: "Další",
    extend: "+15 s",
    closeRound: "Ukončit kolo",
    fullscreen: "Celá obrazovka",
    resetScores: "Nová hra (ponechat hráče)",
    resetAll: "Nová hra (odpojit všechny)",
    confirmReset: "Opravdu začít znovu? Body se vynulují.",
    confirmResetAll: "Opravdu? Všichni hráči budou odpojeni.",
    confirmKick: "Odebrat hráče {name}?",
    kick: "Odebrat",
    online: "online",
    offline: "offline",
    // admin/login
    adminToken: "Heslo organizátora",
    login: "Přihlásit",
    badToken: "Špatné heslo",
    // errors from server
    err_name_taken: "Tohle jméno už někdo má – přidej třeba příjmení.",
    err_name_empty: "Napiš své jméno.",
    err_round_closed: "Kolo už skončilo.",
    err_already_guessed: "Už jsi tipoval(a).",
    err_full: "Hra je plná.",
    err_kicked: "Organizátor tě odebral ze hry.",
    err_no_photos: "Nejsou žádné fotky s polohou.",
    err_generic: "Něco se pokazilo ({code}).",
    // avatars & hint area
    pickAvatar: "Vyber si obrázek",
    changeAvatar: "Změnit obrázek",
    done: "Hotovo",
    tapMapHint: "Fotka je někde v rámečku – klepni, kde přesně",
    err_bad_avatar: "Tenhle obrázek nejde vybrat.",
  },
  en: {
    yourName: "Your name",
    namePlaceholder: "e.g. Aunt Mary",
    join: "Play",
    joining: "Joining…",
    youreIn: "You're in, {name}!",
    watchScreen: "Watch the big screen – the game starts soon.",
    joinedCount: "Players joined: {n}",
    round: "Round {i} of {n}",
    tapMap: "Tap the map where you think the photo was taken",
    lockIn: "Lock in guess",
    guessLocked: "Guess locked ✓",
    waitingOthers: "Waiting for the others…",
    timesUp: "Time's up",
    noGuess: "No guess this round",
    kmAway: "{d} away",
    points: "{n} pts",
    pointsLong: "{n} points",
    yourRank: "#{rank} of {n}",
    totalPoints: "{n} points total",
    lookUp: "Look at the big screen!",
    finalTitle: "Game over!",
    youFinished: "You finished #{rank}",
    thanks: "Thanks for playing ♥",
    kicked: "The host removed you from the game.",
    gameReset: "The game was restarted.",
    joinAgain: "Join again",
    reconnecting: "Reconnecting…",
    tapToZoom: "Tap to enlarge",
    joinAt: "Join at",
    orScan: "or scan the code",
    players: "Players",
    noPlayersYet: "Nobody yet… scan the QR code!",
    pressToStart: "→ / space to start",
    pressToReveal: "→ reveal the answer",
    pressToContinue: "→ continue",
    answered: "answered",
    closest: "Closest",
    leaderboard: "Leaderboard",
    photosReady: "Photos ready: {n}",
    photosMissing: "Photos without a location: {n} (skipped)",
    noPhotos: "Upload photos in the admin page first.",
    next: "Next",
    extend: "+15 s",
    closeRound: "End round",
    fullscreen: "Fullscreen",
    resetScores: "New game (keep players)",
    resetAll: "New game (disconnect everyone)",
    confirmReset: "Start over? Scores will be reset.",
    confirmResetAll: "Are you sure? Every player will be disconnected.",
    confirmKick: "Remove {name}?",
    kick: "Remove",
    online: "online",
    offline: "offline",
    adminToken: "Organizer password",
    login: "Log in",
    badToken: "Wrong password",
    err_name_taken: "That name is taken – try adding a surname.",
    err_name_empty: "Please enter your name.",
    err_round_closed: "This round is over.",
    err_already_guessed: "You already guessed.",
    err_full: "The game is full.",
    err_kicked: "The host removed you from the game.",
    err_no_photos: "There are no photos with a location.",
    err_generic: "Something went wrong ({code}).",
    // avatars & hint area
    pickAvatar: "Pick your avatar",
    changeAvatar: "Change avatar",
    done: "Done",
    tapMapHint: "The photo was taken inside the frame – tap exactly where",
    err_bad_avatar: "That avatar isn't available.",
  },
} satisfies Record<Lang, Record<string, string>>;

export type Key = keyof typeof strings.en;

const STORAGE_KEY = "pinpoint.lang";
const listeners = new Set<() => void>();

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "cs" || saved === "en") return saved;
  } catch {}
  return navigator.language.toLowerCase().startsWith("cs") || navigator.language.toLowerCase().startsWith("sk")
    ? "cs"
    : "en";
}

let current: Lang = initialLang();
document.documentElement.lang = current;

export const lang = (): Lang => current;

export function setLang(l: Lang): void {
  current = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {}
  listeners.forEach((fn) => fn());
}

export const toggleLang = (): void => setLang(current === "cs" ? "en" : "cs");

export function onLangChange(fn: () => void): void {
  listeners.add(fn);
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const s: string = (strings[current] as Record<string, string>)[key] ?? strings.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

export function errorText(code: string): string {
  const key = `err_${code}` as Key;
  return key in strings.en ? t(key) : t("err_generic", { code });
}

/** Pick the caption / title in the current language, falling back to the other one. */
export function pick(texts: { cs: string; en: string } | null | undefined): string {
  if (!texts) return "";
  return texts[current] || texts[current === "cs" ? "en" : "cs"] || "";
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(current === "cs" ? "cs-CZ" : "en-GB").format(Math.round(n));
}

export function formatDistance(km: number): string {
  if (km < 1) return `${formatNumber(km * 1000)} m`;
  if (km < 10) return `${new Intl.NumberFormat(current === "cs" ? "cs-CZ" : "en-GB", { maximumFractionDigits: 1 }).format(km)} km`;
  return `${formatNumber(km)} km`;
}
