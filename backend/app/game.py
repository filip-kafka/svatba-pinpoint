"""Game state machine - pure logic, no networking.

    LOBBY -> QUESTION -> REVEAL -> LEADERBOARD -> QUESTION -> ... -> REVEAL -> FINAL

Points are computed when a guess arrives but only added to totals at REVEAL, so
nobody can infer how close they were from their score while the round is open.
"""

import json
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Callable

from .quiz import PhotoItem, QuizSettings
from .scoring import haversine_km, normalize_lng, points_for

NAME_MAX = 20


class Phase(StrEnum):
    LOBBY = "lobby"
    QUESTION = "question"
    REVEAL = "reveal"
    LEADERBOARD = "leaderboard"
    FINAL = "final"


class GameError(Exception):
    """Raised for invalid player/host actions. ``code`` is shown translated in the UI."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class Guess:
    lat: float
    lng: float
    distance_km: float
    points: int
    at: float


@dataclass
class Player:
    id: str
    name: str
    total: int = 0
    joined_at: float = 0.0


@dataclass
class Game:
    now: Callable[[], float] = time.time
    phase: Phase = Phase.LOBBY
    round_index: int = -1
    rounds: list[PhotoItem] = field(default_factory=list)
    settings: QuizSettings = field(default_factory=QuizSettings)
    players: dict[str, Player] = field(default_factory=dict)
    banned: set[str] = field(default_factory=set)
    # round index -> player id -> guess
    guesses: dict[int, dict[str, Guess]] = field(default_factory=dict)
    ends_at: float | None = None
    closed: bool = False
    prev_ranks: dict[str, int] = field(default_factory=dict)

    # ---------------------------------------------------------------- players

    def join(self, name: str, player_id: str | None = None) -> Player:
        if player_id and player_id in self.banned:
            raise GameError("kicked")
        if player_id and player_id in self.players:
            return self.players[player_id]  # reconnect keeps name and score

        name = re.sub(r"\s+", " ", name or "").strip()[:NAME_MAX]
        if not name:
            raise GameError("name_empty")
        if any(p.name.casefold() == name.casefold() for p in self.players.values()):
            raise GameError("name_taken")

        player = Player(id=player_id or uuid.uuid4().hex, name=name, joined_at=self.now())
        self.players[player.id] = player
        return player

    def kick(self, player_id: str) -> None:
        self.players.pop(player_id, None)
        self.banned.add(player_id)
        for round_guesses in self.guesses.values():
            round_guesses.pop(player_id, None)
        self.prev_ranks.pop(player_id, None)

    # ----------------------------------------------------------------- rounds

    @property
    def current(self) -> PhotoItem | None:
        if 0 <= self.round_index < len(self.rounds):
            return self.rounds[self.round_index]
        return None

    @property
    def is_last_round(self) -> bool:
        return self.round_index == len(self.rounds) - 1

    def time_limit(self, item: PhotoItem) -> int:
        return item.time_limit or self.settings.default_time_limit

    def start(self, rounds: list[PhotoItem], settings: QuizSettings) -> None:
        if self.phase != Phase.LOBBY:
            raise GameError("already_started")
        if not rounds:
            raise GameError("no_photos")
        self.rounds = [r.model_copy() for r in rounds]
        self.settings = settings.model_copy()
        self._open_round(0)

    def _open_round(self, index: int) -> None:
        self.round_index = index
        self.phase = Phase.QUESTION
        self.guesses.setdefault(index, {})
        self.closed = False
        self.ends_at = self.now() + self.time_limit(self.rounds[index])

    def guess(self, player_id: str, lat: float, lng: float) -> Guess:
        if player_id not in self.players:
            raise GameError("not_joined")
        if self.phase != Phase.QUESTION or self.closed:
            raise GameError("round_closed")
        if self.ends_at is not None and self.now() > self.ends_at + 1.0:  # 1 s grace for latency
            raise GameError("round_closed")
        round_guesses = self.guesses[self.round_index]
        if player_id in round_guesses:
            raise GameError("already_guessed")
        if not (-90 <= lat <= 90) or not (-1e4 < lng < 1e4):
            raise GameError("bad_guess")

        item = self.current
        assert item is not None and item.lat is not None and item.lng is not None
        lng = normalize_lng(lng)
        dist = haversine_km(lat, lng, item.lat, item.lng)
        g = Guess(lat=lat, lng=lng, distance_km=dist, points=points_for(dist, item.scale), at=self.now())
        round_guesses[player_id] = g
        return g

    def close_round(self) -> None:
        if self.phase == Phase.QUESTION:
            self.closed = True

    def everyone_answered(self, connected_ids: set[str]) -> bool:
        active = connected_ids & self.players.keys()
        answered = self.guesses.get(self.round_index, {}).keys()
        return bool(active) and active <= answered

    def advance(self, rounds_if_lobby: list[PhotoItem] | None = None,
                settings: QuizSettings | None = None) -> None:
        """The host's single "next" button."""
        if self.phase == Phase.LOBBY:
            self.start(rounds_if_lobby or [], settings or QuizSettings())
        elif self.phase == Phase.QUESTION:
            self._reveal()
        elif self.phase == Phase.REVEAL:
            self.phase = Phase.FINAL if self.is_last_round else Phase.LEADERBOARD
        elif self.phase == Phase.LEADERBOARD:
            self._open_round(self.round_index + 1)
        # FINAL: nothing further

    def _reveal(self) -> None:
        self.closed = True
        self.prev_ranks = self.ranks()
        for pid, g in self.guesses.get(self.round_index, {}).items():
            if pid in self.players:
                self.players[pid].total += g.points
        self.phase = Phase.REVEAL
        self.ends_at = None

    def reset(self) -> None:
        """Back to the lobby with everyone still joined, scores zeroed."""
        for p in self.players.values():
            p.total = 0
        self.phase = Phase.LOBBY
        self.round_index = -1
        self.rounds = []
        self.guesses = {}
        self.ends_at = None
        self.closed = False
        self.prev_ranks = {}

    def reset_all(self) -> None:
        """Back to the lobby and forget every player."""
        self.reset()
        self.players = {}
        self.banned = set()

    # ------------------------------------------------------------- standings

    def standings(self) -> list[Player]:
        return sorted(self.players.values(), key=lambda p: (-p.total, p.joined_at))

    def ranks(self) -> dict[str, int]:
        """Competition ranking: 1, 2, 2, 4 ..."""
        ranks: dict[str, int] = {}
        last_total, last_rank = None, 0
        for i, p in enumerate(self.standings(), start=1):
            if p.total != last_total:
                last_total, last_rank = p.total, i
            ranks[p.id] = last_rank
        return ranks

    def round_points(self, index: int | None = None) -> dict[str, int]:
        idx = self.round_index if index is None else index
        return {pid: g.points for pid, g in self.guesses.get(idx, {}).items()}

    # ----------------------------------------------------------- persistence

    def to_json(self) -> str:
        return json.dumps({
            "phase": self.phase.value,
            "round_index": self.round_index,
            "rounds": [r.model_dump() for r in self.rounds],
            "settings": self.settings.model_dump(),
            "players": [asdict(p) for p in self.players.values()],
            "banned": sorted(self.banned),
            "guesses": {str(i): {pid: asdict(g) for pid, g in gs.items()}
                        for i, gs in self.guesses.items()},
            "ends_at": self.ends_at,
            "closed": self.closed,
            "prev_ranks": self.prev_ranks,
        })

    @classmethod
    def from_json(cls, raw: str, now: Callable[[], float] = time.time) -> "Game":
        d = json.loads(raw)
        g = cls(now=now)
        g.phase = Phase(d["phase"])
        g.round_index = d["round_index"]
        g.rounds = [PhotoItem.model_validate(r) for r in d["rounds"]]
        g.settings = QuizSettings.model_validate(d["settings"])
        g.players = {p["id"]: Player(**p) for p in d["players"]}
        g.banned = set(d["banned"])
        g.guesses = {int(i): {pid: Guess(**x) for pid, x in gs.items()}
                     for i, gs in d["guesses"].items()}
        g.ends_at = d["ends_at"]
        g.closed = d["closed"]
        g.prev_ranks = d["prev_ranks"]
        if g.phase == Phase.QUESTION and g.ends_at is not None and g.ends_at < now():
            g.closed = True  # the timer ran out while the server was down
        return g


def save_game(game: Game, path: Path) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(game.to_json(), encoding="utf-8")
    os.replace(tmp, path)


def load_game(path: Path) -> Game:
    if path.exists():
        try:
            return Game.from_json(path.read_text(encoding="utf-8"))
        except (ValueError, KeyError, TypeError):
            path.rename(path.with_suffix(".corrupt"))
    return Game()
