import pytest

from app.game import Game, GameError, Phase
from app.quiz import PhotoItem, QuizSettings
from app.scoring import haversine_km, normalize_lng, points_for


class Clock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


PRAGUE = (50.0755, 14.4378)
BRNO = (49.1951, 16.6068)
SYDNEY = (-33.8688, 151.2093)


def photos(*coords):
    return [PhotoItem(id=f"p{i}", lat=lat, lng=lng) for i, (lat, lng) in enumerate(coords)]


# ---------------------------------------------------------------- scoring

def test_haversine_prague_brno():
    assert haversine_km(*PRAGUE, *BRNO) == pytest.approx(185, abs=3)


def test_points_monotonic_and_bounded():
    assert points_for(0) == 5000
    assert points_for(100) > points_for(500) > points_for(5000) >= 0
    assert points_for(20000) < 10


def test_city_scale_is_stricter():
    assert points_for(50, "city") < points_for(50, "world")


def test_normalize_lng_wraps():
    assert normalize_lng(190) == pytest.approx(-170)
    assert normalize_lng(-190) == pytest.approx(170)
    assert normalize_lng(14.4) == pytest.approx(14.4)


# ------------------------------------------------------------------- game

def test_names_are_unique_case_insensitive():
    g = Game(now=Clock())
    g.join("Anna")
    with pytest.raises(GameError, match="name_taken"):
        g.join("  anna ")
    with pytest.raises(GameError, match="name_empty"):
        g.join("   ")


def test_reconnect_by_id_keeps_player():
    g = Game(now=Clock())
    p = g.join("Anna")
    assert g.join("whatever", p.id) is p


def test_full_game_flow_and_scoring():
    clock = Clock()
    g = Game(now=clock)
    anna, ben = g.join("Anna"), g.join("Ben")

    g.advance(photos(PRAGUE, SYDNEY), QuizSettings(default_time_limit=30))
    assert g.phase == Phase.QUESTION and g.round_index == 0
    assert g.ends_at == 1030

    g.guess(anna.id, *PRAGUE)          # spot on
    g.guess(ben.id, *BRNO)             # ~185 km off
    with pytest.raises(GameError, match="already_guessed"):
        g.guess(ben.id, *PRAGUE)

    # totals stay hidden until the reveal
    assert anna.total == 0
    assert g.everyone_answered({anna.id, ben.id})

    g.advance()
    assert g.phase == Phase.REVEAL
    assert anna.total == 5000
    assert 4000 < ben.total < 5000

    g.advance()
    assert g.phase == Phase.LEADERBOARD
    g.advance()
    assert g.phase == Phase.QUESTION and g.round_index == 1

    clock.t += 31.5   # past deadline + grace
    with pytest.raises(GameError, match="round_closed"):
        g.guess(anna.id, *SYDNEY)

    g.advance()       # reveal of last round
    assert g.phase == Phase.REVEAL
    g.advance()       # last round goes straight to the final podium
    assert g.phase == Phase.FINAL
    assert g.ranks() == {anna.id: 1, ben.id: 2}


def test_ties_share_rank():
    g = Game(now=Clock())
    a, b, c = g.join("A"), g.join("B"), g.join("C")
    a.total, b.total, c.total = 100, 100, 50
    r = g.ranks()
    assert r[a.id] == r[b.id] == 1 and r[c.id] == 3


def test_kick_bans_and_removes_guess():
    g = Game(now=Clock())
    a = g.join("A")
    g.advance(photos(PRAGUE), QuizSettings())
    g.guess(a.id, *BRNO)
    g.kick(a.id)
    assert a.id not in g.players and not g.guesses[0]
    with pytest.raises(GameError, match="kicked"):
        g.join("A", a.id)


def test_no_photos_cannot_start():
    g = Game(now=Clock())
    with pytest.raises(GameError, match="no_photos"):
        g.advance([], QuizSettings())


def test_reset_keeps_players_zeroes_scores():
    g = Game(now=Clock())
    a = g.join("A")
    g.advance(photos(PRAGUE), QuizSettings())
    g.guess(a.id, *PRAGUE)
    g.advance()
    g.reset()
    assert g.phase == Phase.LOBBY and a.id in g.players and a.total == 0


def test_persistence_roundtrip_closes_expired_round():
    clock = Clock()
    g = Game(now=clock)
    a = g.join("A")
    g.advance(photos(PRAGUE, BRNO), QuizSettings(default_time_limit=10))
    g.guess(a.id, *BRNO)
    raw = g.to_json()

    clock.t += 60  # server was down for a minute
    restored = Game.from_json(raw, now=clock)
    assert restored.phase == Phase.QUESTION and restored.closed
    assert restored.guesses[0][a.id].points == g.guesses[0][a.id].points
    restored.advance()
    assert restored.players[a.id].total > 0


# ----------------------------------------------------------------- avatars

import random as _random

from app import avatars
from app.hints import HINT_SIZE_KM, hint_bounds


def test_join_keeps_valid_avatar_and_replaces_invalid_one():
    g = Game(now=Clock())
    assert g.join("A", avatar="🦊").avatar == "🦊"
    b = g.join("B", avatar="<script>")
    assert avatars.is_valid(b.avatar)
    assert avatars.is_valid(g.join("C").avatar)


def test_set_avatar():
    g = Game(now=Clock())
    a = g.join("A", avatar="🦊")
    g.set_avatar(a.id, "🐧")
    assert a.avatar == "🐧"
    with pytest.raises(GameError, match="bad_avatar"):
        g.set_avatar(a.id, "not-an-avatar")


def test_old_save_without_avatars_gets_them():
    g = Game(now=Clock())
    g.join("A")
    import json
    data = json.loads(g.to_json())
    for p in data["players"]:
        del p["avatar"]
    data.pop("start_bounds")
    restored = Game.from_json(json.dumps(data))
    assert avatars.is_valid(restored.standings()[0].avatar)


# -------------------------------------------------------------- hint areas

@pytest.mark.parametrize("scale", list(HINT_SIZE_KM))
@pytest.mark.parametrize("lat,lng", [PRAGUE, SYDNEY, (64.15, -21.94), (-54.8, -68.3), (35.0, 179.5)])
def test_hint_area_contains_answer_off_centre(scale, lat, lng):
    rng = _random.Random(7)
    for _ in range(50):
        (s, w), (n, e) = hint_bounds(lat, lng, scale, rng)
        assert s <= lat <= n and w <= lng <= e
        # answer sits in the middle 60 %, never on an edge
        fx, fy = (lng - w) / (e - w), (lat - s) / (n - s)
        assert 0.19 <= fx <= 0.81 and 0.19 <= fy <= 0.81
        # size in km roughly matches the scale
        assert haversine_km(s, lng, n, lng) == pytest.approx(HINT_SIZE_KM[scale], rel=0.05)


def test_hint_area_positions_vary():
    rng = _random.Random(1)
    centres = {tuple(round(v, 3) for v in hint_bounds(*PRAGUE, "country", rng)[0]) for _ in range(20)}
    assert len(centres) > 15


def test_start_bounds_only_with_photo_start():
    g = Game(now=Clock())
    g.join("A")
    g.advance(photos(PRAGUE, SYDNEY), QuizSettings(map_start="europe"))
    assert g.start_bounds == {}

    g2 = Game(now=Clock())
    g2.join("A")
    g2.advance(photos(PRAGUE, SYDNEY), QuizSettings(map_start="photo"))
    first = g2.start_bounds[0]
    (s, w), (n, e) = first
    assert s <= PRAGUE[0] <= n and w <= PRAGUE[1] <= e
    g2.advance(); g2.advance(); g2.advance()   # reveal, leaderboard, next question
    assert set(g2.start_bounds) == {0, 1} and g2.start_bounds[0] == first

    restored = Game.from_json(g2.to_json())
    assert restored.start_bounds == g2.start_bounds
