"""WebSocket connections, per-role views of the game, and the round timer.

Every change pushes a full state snapshot to every client. With ~100 phones
that is a few hundred KB per transition, which is nothing, and it makes
reconnecting clients trivially correct: the next message tells them everything.
"""

import asyncio
import json
import logging
import secrets
from pathlib import Path
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .game import Game, GameError, Phase, save_game
from .quiz import QuizStore

log = logging.getLogger("pinpoint.hub")

EXTEND_SECONDS = 15


def photo_url(photo_id: str) -> str:
    return f"/media/{photo_id}.jpg"


class Hub:
    def __init__(self, game: Game, store: QuizStore, game_path: Path, admin_token: str,
                 max_players: int = 300):
        self.game = game
        self.store = store
        self.game_path = game_path
        self.admin_token = admin_token
        self.max_players = max_players
        self.hosts: set[WebSocket] = set()
        self.player_socks: dict[str, set[WebSocket]] = {}
        self._timer: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------- plumbing

    def connected_ids(self) -> set[str]:
        return {pid for pid, socks in self.player_socks.items() if socks}

    def persist(self) -> None:
        try:
            save_game(self.game, self.game_path)
        except OSError:
            log.exception("Could not save game state")

    @staticmethod
    async def _send(ws: WebSocket, text: str) -> None:
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=5)
        except Exception:  # dead or stuck socket; its own handler will clean up
            pass

    async def broadcast(self, only_players: set[str] | None = None) -> None:
        """Send fresh state to hosts and to players (all, or just ``only_players``)."""
        ranks = self.game.ranks()
        sends: list[tuple[WebSocket, str]] = []
        host_msg = json.dumps(self.host_view(ranks))
        sends += [(ws, host_msg) for ws in self.hosts]
        for pid, socks in self.player_socks.items():
            if only_players is not None and pid not in only_players:
                continue
            msg = json.dumps(self.player_view(pid, ranks))
            sends += [(ws, msg) for ws in socks]
        await asyncio.gather(*(self._send(ws, m) for ws, m in sends))

    # --------------------------------------------------------------- timer

    def ensure_timer(self) -> None:
        g = self.game
        if self._timer and not self._timer.done():
            self._timer.cancel()
        self._timer = None
        if g.phase == Phase.QUESTION and not g.closed and g.ends_at is not None:
            self._timer = asyncio.create_task(self._run_timer(g.round_index, g.ends_at))

    async def _run_timer(self, round_index: int, ends_at: float) -> None:
        await asyncio.sleep(max(0.0, ends_at - self.game.now()))
        async with self._lock:
            g = self.game
            if g.phase == Phase.QUESTION and g.round_index == round_index and not g.closed:
                g.close_round()
                self.persist()
                await self.broadcast()

    # ---------------------------------------------------------------- views

    def _common(self) -> dict[str, Any]:
        g = self.game
        settings = g.settings if g.phase != Phase.LOBBY else self.store.quiz.settings
        item = g.current
        show_photo = item is not None and g.phase in (Phase.QUESTION, Phase.REVEAL)
        return {
            "type": "state",
            "phase": g.phase.value,
            "round_index": g.round_index,
            "round_count": len(g.rounds) if g.phase != Phase.LOBBY
            else len(self.store.playable_photos()),
            "server_now": g.now(),
            "ends_at": g.ends_at,
            "closed": g.closed,
            "time_limit": g.time_limit(item) if item else None,
            "title": {"cs": settings.title_cs, "en": settings.title_en},
            "subtitle": {"cs": settings.subtitle_cs, "en": settings.subtitle_en},
            "photo": photo_url(item.id) if show_photo and item else None,
            "player_count": len(g.players),
        }

    def _answer(self) -> dict[str, Any] | None:
        item = self.game.current
        if item is None or self.game.phase not in (Phase.REVEAL, Phase.LEADERBOARD, Phase.FINAL):
            return None
        return {
            "lat": item.lat, "lng": item.lng, "scale": item.scale,
            "caption": {"cs": item.caption_cs, "en": item.caption_en},
        }

    def _leaderboard(self, ranks: dict[str, int]) -> list[dict[str, Any]]:
        g = self.game
        rp = g.round_points()
        return [
            {"id": p.id, "name": p.name, "total": p.total, "rank": ranks[p.id],
             "prev_rank": g.prev_ranks.get(p.id), "round_points": rp.get(p.id)}
            for p in g.standings()
        ]

    def host_view(self, ranks: dict[str, int]) -> dict[str, Any]:
        g = self.game
        connected = self.connected_ids()
        view = self._common()
        view.update({
            "role": "host",
            "players": [{"id": p.id, "name": p.name, "connected": p.id in connected}
                        for p in sorted(g.players.values(), key=lambda p: p.joined_at)],
            "connected_count": len(connected & g.players.keys()),
            "answered_count": len(g.guesses.get(g.round_index, {})),
            "is_last_round": g.is_last_round,
            "missing_location_count": len(self.store.quiz.photos) - len(self.store.playable_photos()),
            "answer": self._answer(),
            "guesses": None,
            "leaderboard": None,
        })
        if g.phase == Phase.REVEAL:
            view["guesses"] = sorted(
                ({"name": g.players[pid].name, "lat": x.lat, "lng": x.lng,
                  "distance_km": x.distance_km, "points": x.points}
                 for pid, x in g.guesses.get(g.round_index, {}).items() if pid in g.players),
                key=lambda x: x["distance_km"],
            )
        if g.phase in (Phase.LEADERBOARD, Phase.FINAL):
            view["leaderboard"] = self._leaderboard(ranks)
        return view

    def player_view(self, pid: str, ranks: dict[str, int]) -> dict[str, Any]:
        g = self.game
        view = self._common()
        player = g.players.get(pid)
        guess = g.guesses.get(g.round_index, {}).get(pid)
        view.update({
            "role": "player",
            "me": None if player is None else {
                "id": player.id, "name": player.name, "total": player.total,
                "rank": ranks.get(pid), "prev_rank": g.prev_ranks.get(pid),
            },
            "my_guess": None if guess is None else {"lat": guess.lat, "lng": guess.lng},
            "answer": self._answer(),
            "result": None,
            "podium": None,
        })
        if g.phase in (Phase.REVEAL, Phase.LEADERBOARD, Phase.FINAL):
            view["result"] = None if guess is None else {
                "distance_km": guess.distance_km, "points": guess.points}
        if g.phase == Phase.FINAL:
            view["podium"] = [{"name": p.name, "total": p.total, "rank": ranks[p.id]}
                              for p in g.standings()[:3]]
        return view

    def public_view(self) -> dict[str, Any]:
        view = self._common()
        view["role"] = "anonymous"
        return view

    # ------------------------------------------------------------- sockets

    def check_token(self, token: str | None) -> bool:
        return bool(token) and secrets.compare_digest(token, self.admin_token)

    async def host_session(self, ws: WebSocket) -> None:
        self.hosts.add(ws)
        try:
            await ws.send_text(json.dumps(self.host_view(self.game.ranks())))
            while True:
                msg = await ws.receive_json()
                async with self._lock:
                    error = self._host_action(msg)
                    if error:
                        await ws.send_text(json.dumps({"type": "error", "code": error}))
                        continue
                    self.persist()
                    self.ensure_timer()
                    await self.broadcast()
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            self.hosts.discard(ws)

    def _host_action(self, msg: dict) -> str | None:
        g = self.game
        action = msg.get("action")
        try:
            if action == "advance":
                g.advance(self.store.playable_photos(), self.store.quiz.settings)
            elif action == "extend":
                if g.phase == Phase.QUESTION and g.ends_at is not None:
                    g.ends_at = max(g.ends_at, g.now()) + EXTEND_SECONDS
                    g.closed = False
            elif action == "close":
                g.close_round()
            elif action == "reset":
                g.reset()
            elif action == "reset_all":
                self._drop_all_players()
                g.reset_all()
            elif action == "kick":
                pid = str(msg.get("player_id", ""))
                g.kick(pid)
                for ws in self.player_socks.pop(pid, set()):
                    asyncio.create_task(self._send_and_close(ws, {"type": "kicked"}))
            else:
                return "unknown_action"
        except GameError as e:
            return e.code
        return None

    def _drop_all_players(self) -> None:
        for socks in self.player_socks.values():
            for ws in socks:
                asyncio.create_task(self._send_and_close(ws, {"type": "reset"}))
        self.player_socks.clear()

    async def _send_and_close(self, ws: WebSocket, payload: dict) -> None:
        await self._send(ws, json.dumps(payload))
        try:
            await ws.close()
        except Exception:
            pass

    async def player_session(self, ws: WebSocket) -> None:
        pid: str | None = None
        try:
            await ws.send_text(json.dumps(self.public_view()))
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                async with self._lock:
                    if kind == "join":
                        pid = await self._player_join(ws, msg, pid)
                    elif kind == "guess" and pid is not None:
                        await self._player_guess(ws, pid, msg)
                    elif kind == "ping":
                        await self._send(ws, json.dumps({"type": "pong"}))
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            if pid is not None and pid in self.player_socks:
                self.player_socks[pid].discard(ws)
                async with self._lock:
                    await self.broadcast(only_players=set())  # hosts see who dropped

    async def _player_join(self, ws: WebSocket, msg: dict, current: str | None) -> str | None:
        g = self.game
        requested = msg.get("player_id") or None
        is_new = requested not in g.players
        if is_new and len(g.players) >= self.max_players:
            await self._send(ws, json.dumps({"type": "error", "code": "full"}))
            return current
        try:
            player = g.join(str(msg.get("name", "")), requested)
        except GameError as e:
            await self._send(ws, json.dumps({"type": "error", "code": e.code}))
            return current
        if current and current != player.id:
            self.player_socks.get(current, set()).discard(ws)
        self.player_socks.setdefault(player.id, set()).add(ws)
        await self._send(ws, json.dumps({"type": "joined", "player_id": player.id,
                                         "name": player.name}))
        if is_new:
            self.persist()
        await self.broadcast(only_players={player.id})
        return player.id

    async def _player_guess(self, ws: WebSocket, pid: str, msg: dict) -> None:
        g = self.game
        try:
            g.guess(pid, float(msg["lat"]), float(msg["lng"]))
        except (KeyError, TypeError, ValueError):
            await self._send(ws, json.dumps({"type": "error", "code": "bad_guess"}))
            return
        except GameError as e:
            await self._send(ws, json.dumps({"type": "error", "code": e.code}))
            return
        if g.everyone_answered(self.connected_ids()):
            g.close_round()
            self.persist()
            self.ensure_timer()
            await self.broadcast()
        else:
            self.persist()
            await self.broadcast(only_players={pid})
