# Pinpoint

A Kahoot-meets-GeoGuessr game for a live event. The projector shows a photo, guests drop a pin
on a world map on their phones, points are awarded by distance, and a leaderboard follows each round.

- **`/`** is for guests' phones. They join by QR code, need no account or app, and can switch between Czech and English.
- **`/host`** runs on the projector laptop. It shows the lobby with a QR code, the photo with a timer, the answer map, the leaderboard, and a podium at the end.
- **`/admin`** is where you upload photos, set or adjust each answer on a map, add captions, and change settings.

`/host` and `/admin` are protected by the organizer password (`PINPOINT_ADMIN_TOKEN`).

## How a game runs

```
lobby ─→ photo + timer ─→ answer on the map ─→ leaderboard ─→ next photo … ─→ podium
      →               →   (auto-closes when      →
                           time is up or all
                           phones have guessed)
```

Each **→** is the host pressing **→ / Space / Enter / PageDown**, so a presenter clicker works too.
Other keys on the host screen: **E** adds 15 s, **F** toggles fullscreen, **L** switches language, **P** opens the player list.
When the mouse is idle, the control bar hides itself. Move the mouse to bring it back. The **⋯** menu starts a new game.

**Scoring:** `5000 × e^(−distance / scale)`. Each photo picks a scale in the admin:

| Scale | km | Points at 50 km | Points at 500 km | Points at 2000 km |
|---|---|---|---|---|
| World (default) | 2000 | 4877 | 3894 | 1839 |
| Continent | 500 | 4524 | 1839 | 92 |
| Country | 150 | 3583 | 178 | 0 |
| City | 15 | 178 | 0 | 0 |

The scale also sets how close the reveal zooms in on the answer: a regional view for World, street level for City.
If none of the guesses is in view after zooming, arrows at the screen edge point to the five closest, with names and distances.

Points count toward the leaderboard only at the reveal, so nobody can tell how close they were before the answer is shown.

## Preparing the photos

1. Open `/admin` and upload photos. JPEG, PNG and iPhone HEIC all work.
2. If a photo has GPS in its metadata, the location is filled in automatically. Photos shared through WhatsApp, Messenger or social media have usually lost it. For those, click the photo and search for a place, click the map, or paste coordinates (in Google Maps, right-click a place and click the numbers to copy them).
3. Optionally add a caption for each photo. It appears when the answer is revealed, e.g. *"Our first holiday – Crete"*.
4. Reorder the photos with ↑ ↓. Photos without a location are skipped automatically.

Photos are resized to 2048 px and **all metadata is stripped** before guests see them. Otherwise, anyone could save the image and read the GPS answer from it.

## Running locally (development)

```bash
# backend
cd backend
uv sync
PINPOINT_ADMIN_TOKEN=dev uv run uvicorn app.main:create_app --factory --reload --port 8000

# frontend (second terminal), with hot reload and proxying to the backend
cd frontend
npm install
npm run dev          # http://localhost:5173 (and on your LAN IP, for testing with a real phone)

# tests
cd backend && uv run pytest
```

`npm run build` writes the production bundle to `backend/static/`, which FastAPI serves itself.

## Testing on your laptop with real phones

**1. Run the production container** (Docker Desktop or OrbStack on the Mac):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

The organizer password is `local` unless `.env` sets another one.

**2. Open everything through your Wi-Fi IP, not `localhost`.** The QR code on the projector screen encodes
the address you opened `/host` with, and `localhost` means nothing to a phone.

```bash
ipconfig getifaddr en0          # e.g. 192.168.1.23
```

- `http://192.168.1.23:8000/admin` — upload a few photos
- `http://192.168.1.23:8000/host` — the projector screen; press F for fullscreen
- scan the QR code with phones on the **same Wi-Fi**

If phones can't connect, macOS may be blocking incoming connections. Allow Docker in
System Settings → Network → Firewall.

**3. Add fake guests** to see how the screens handle a full room:

```bash
cd backend && uv run python scripts/fake_guests.py 80
```

**4. Testing several players from one computer:** every *normal* tab in the same browser is the same
player, because the player ID is kept in the browser. Use private windows, or different browsers.

**5. Testing on mobile data before the VPS is ready:** expose the laptop through a temporary HTTPS tunnel.

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8000     # prints https://<random>.trycloudflare.com
```

Open `/host` through that URL, so the QR code points at the tunnel.

**To start again from scratch**, stop the stack and run `docker compose -f docker-compose.yml -f docker-compose.local.yml down -v`.
This deletes the uploaded photos and the game state.

## Deploying to the VPS

The Docker image builds the frontend and runs everything as one container. Game state is saved to the
`/data` volume after every change, so a container restart in the middle of the wedding keeps all scores.

```bash
git clone <your repo> pinpoint && cd pinpoint
cp .env.example .env                 # set PINPOINT_ADMIN_TOKEN (and PINPOINT_DOMAIN for Caddy)
```

Then pick one of these:

**A. You don't have a reverse proxy yet.** Caddy obtains HTTPS certificates automatically:

```bash
# DNS: an A record for svatba.kaffi.dev pointing at the VPS IP
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

**B. You already have one** (Nginx Proxy Manager, Traefik, …). Run `docker compose up -d --build` and
proxy your domain to `127.0.0.1:8000` with **WebSocket support enabled**. If the proxy runs in Docker itself, drop the `ports:` mapping and put both containers on the same network.

**In Portainer:** add a Stack from the Git repository and set `PINPOINT_ADMIN_TOKEN` (and `PINPOINT_DOMAIN`) as stack environment variables.

The service must run with **one worker**, because the game lives in memory. The Dockerfile already does this.

## Before the wedding

- [ ] Run a full rehearsal at home with 3–4 phones on **mobile data**, not your Wi-Fi.
- [ ] Check the signal at the venue. If it's weak, ask for the guest Wi-Fi and put its password next to the QR code.
- [ ] Open `/host` on the projector laptop the day before, so the password is saved in the browser.
- [ ] Press **F** for fullscreen. The QR code needs to be scannable from the back row, so test that too.
- [ ] Budget about 30–40 s per photo. 10–15 photos make a good 15-minute game.
- [ ] After the rehearsal, use **⋯ → New game (disconnect everyone)** so the test players are gone.

## Customizing

- **Colours and fonts:** edit the variables at the top of `frontend/src/styles/base.css` (`--accent`, `--paper`, …).
- **Texts, in both languages:** edit `frontend/src/shared/i18n.ts`.
- **Map:** set in `.env`, no rebuild needed. See `tile_config()` in `backend/app/config.py`.
  - Default: [OpenFreeMap](https://openfreemap.org) vector map ("liberty" style). It's free, needs no key and has no request limits. Vector tiles are small, so the map loads fast on phones and zooms smoothly. Phones without WebGL fall back to OpenStreetMap raster tiles automatically.
  - `PINPOINT_MAP_STYLE=…`: another vector style, e.g. `https://tiles.openfreemap.org/styles/bright` or `…/positron`.
  - `PINPOINT_CARTO_KEY=…`: CARTO Voyager raster tiles ([free key](https://carto.com/basemaps/apikey/)).
  - `PINPOINT_TILES_URL=…` (+ `PINPOINT_TILES_ATTRIBUTION`): any other raster tile URL.
- **Where the phone map opens:** admin → Game settings → "Phone map starts at" (Europe, Czechia or the whole world).
- **Scoring:** `backend/app/scoring.py`.
- **Time added by +15 s:** `EXTEND_SECONDS` in `backend/app/hub.py`.

## Layout

```
backend/app/
  main.py      HTTP routes, WebSocket endpoints, static pages
  hub.py       connections, per-role state views, round timer
  game.py      the game state machine (pure logic, unit-tested)
  scoring.py   haversine distance + points
  photos.py    upload: EXIF GPS → strip metadata → resize
  quiz.py      photos/settings stored in data/quiz.json
frontend/src/
  player.ts    phone page
  host.ts      projector page
  admin.ts     admin page
  shared/      i18n, WebSocket with auto-reconnect, map helpers, types
```
