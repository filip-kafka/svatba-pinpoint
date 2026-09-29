"""Fake wedding guests for testing: N WebSocket players that join and guess.

    cd backend
    uv run python scripts/fake_guests.py 80                      # local server
    uv run python scripts/fake_guests.py 80 --url wss://svatba.kaffi.dev

Leave it running while you click through the game on /host. Each guest guesses
a random spot 2-12 s into a round (about 10 % don't guess at all, like real
guests). Ctrl+C to stop; they leave the game when you do.
"""

import argparse
import asyncio
import json
import random
import urllib.request

import websockets

FIRST = ["Jana", "Petr", "Eva", "Tomáš", "Lucie", "Martin", "Kateřina", "Jakub", "Tereza", "Ondřej",
         "Anna", "Lukáš", "Marie", "David", "Veronika", "Jan", "Klára", "Filip", "Barbora", "Vojta"]
LAST = "NKDSPMHVBR"


def fetch_avatars(ws_url: str) -> list[str]:
    http_url = ws_url.replace("wss://", "https://", 1).replace("ws://", "http://", 1)
    try:
        with urllib.request.urlopen(f"{http_url}/api/avatars", timeout=10) as r:
            return json.load(r)
    except OSError:
        return []  # the server picks random ones


async def guest(i: int, url: str, stats: dict, avatars: list[str]) -> None:
    name = f"{random.choice(FIRST)} {LAST[i % len(LAST)]}.{i}"
    await asyncio.sleep(random.random() * 3)  # don't all arrive in the same millisecond
    async with websockets.connect(f"{url}/ws/player") as ws:
        avatar = random.choice(avatars) if avatars else None
        await ws.send(json.dumps({"type": "join", "name": name, "avatar": avatar}))
        guessed_round = -1
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "joined":
                stats["joined"] += 1
            elif msg["type"] == "error":
                stats["errors"] += 1
                print(f"{name}: {msg['code']}")
            elif msg["type"] in ("kicked", "reset"):
                return
            elif (msg["type"] == "state" and msg.get("role") == "player"
                  and msg["phase"] == "question" and not msg["closed"] and not msg["my_guess"]
                  and guessed_round != msg["round_index"]):
                guessed_round = msg["round_index"]
                if random.random() < 0.9:
                    asyncio.create_task(guess(ws, stats))


async def guess(ws, stats: dict) -> None:
    await asyncio.sleep(2 + random.random() * 10)
    try:
        await ws.send(json.dumps({"type": "guess",
                                  "lat": random.uniform(-40, 65),
                                  "lng": random.uniform(-120, 150)}))
        stats["guesses"] += 1
    except websockets.ConnectionClosed:
        pass


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("count", type=int, help="number of fake guests")
    ap.add_argument("--url", default="ws://localhost:8000", help="server base URL (ws:// or wss://)")
    args = ap.parse_args()

    stats = {"joined": 0, "guesses": 0, "errors": 0}
    url = args.url.rstrip("/")
    avatars = fetch_avatars(url)
    tasks = [asyncio.create_task(guest(i, url, stats, avatars)) for i in range(args.count)]
    print(f"{args.count} guests connecting to {args.url} - Ctrl+C to stop")
    try:
        while True:
            await asyncio.sleep(5)
            print(f"joined {stats['joined']}, guesses {stats['guesses']}, errors {stats['errors']}")
    finally:
        for t in tasks:
            t.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
