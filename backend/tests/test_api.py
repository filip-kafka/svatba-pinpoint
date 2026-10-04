import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def jpeg_with_gps(lat=(50, 4, 31.8), lat_ref="N", lng=(14, 26, 16.08), lng_ref="E") -> bytes:
    img = Image.new("RGB", (800, 600), (120, 160, 200))
    exif = Image.Exif()
    gps = exif.get_ifd(0x8825)
    gps.update({1: lat_ref, 2: lat, 3: lng_ref, 4: lng})
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def plain_jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (400, 300), (10, 200, 10)).save(buf, "JPEG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PINPOINT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PINPOINT_ADMIN_TOKEN", TOKEN)
    monkeypatch.setenv("PINPOINT_STATIC_DIR", str(tmp_path / "no-static"))
    with TestClient(create_app()) as c:
        yield c


def test_admin_requires_token(client):
    assert client.get("/api/admin/quiz").status_code == 401
    assert client.get("/api/admin/quiz", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/admin/check", headers=AUTH).status_code == 204


def test_upload_reads_gps_and_strips_exif(client):
    r = client.post("/api/admin/photos", headers=AUTH, files=[
        ("files", ("a.jpg", jpeg_with_gps(), "image/jpeg")),
        ("files", ("b.jpg", plain_jpeg(), "image/jpeg")),
        ("files", ("c.txt", b"not an image", "text/plain")),
    ])
    body = r.json()
    assert r.status_code == 200
    assert len(body["added"]) == 2 and body["errors"] == [{"file": "c.txt", "error": "unreadable"}]

    with_gps, without = body["added"]
    assert with_gps["lat"] == pytest.approx(50.0755, abs=1e-3)
    assert with_gps["lng"] == pytest.approx(14.4378, abs=1e-3)
    assert with_gps["from_exif"] is True
    assert without["lat"] is None

    served = client.get(f"/media/{with_gps['id']}.jpg")
    assert served.status_code == 200
    img = Image.open(io.BytesIO(served.content))
    assert not img.getexif(), "served photo must not carry EXIF (it would leak the answer)"


def test_southern_western_hemisphere(client):
    raw = jpeg_with_gps(lat=(33, 52, 7.7), lat_ref="S", lng=(70, 0, 0), lng_ref="W")
    item = client.post("/api/admin/photos", headers=AUTH,
                       files=[("files", ("s.jpg", raw, "image/jpeg"))]).json()["added"][0]
    assert item["lat"] < 0 and item["lng"] == pytest.approx(-70)


def test_patch_reorder_delete(client):
    ids = [client.post("/api/admin/photos", headers=AUTH,
                       files=[("files", (f"{i}.jpg", plain_jpeg(), "image/jpeg"))]).json()["added"][0]["id"]
           for i in range(3)]
    r = client.patch(f"/api/admin/photos/{ids[0]}", headers=AUTH,
                     json={"lat": 10, "lng": 20, "caption_en": "Beach", "scale": "country", "time_limit": 25})
    assert r.json()["caption_en"] == "Beach" and r.json()["scale"] == "country"
    assert client.patch(f"/api/admin/photos/{ids[0]}", headers=AUTH, json={"lat": 100}).status_code == 422

    assert client.put("/api/admin/order", headers=AUTH, json={"ids": ids[::-1]}).status_code == 204
    assert [p["id"] for p in client.get("/api/admin/quiz", headers=AUTH).json()["photos"]] == ids[::-1]
    assert client.put("/api/admin/order", headers=AUTH, json={"ids": ids[:2]}).status_code == 400

    assert client.delete(f"/api/admin/photos/{ids[1]}", headers=AUTH).status_code == 204
    assert client.get(f"/media/{ids[1]}.jpg").status_code == 404


def test_media_rejects_path_tricks(client):
    assert client.get("/media/..%2Fquiz.json").status_code == 404
    assert client.get("/media/quiz.json").status_code == 404


def recv_until(ws, pred, limit=20):
    for _ in range(limit):
        msg = ws.receive_json()
        if pred(msg):
            return msg
    raise AssertionError("expected message not received")


def test_websocket_game(client):
    client.post("/api/admin/photos", headers=AUTH,
                files=[("files", ("a.jpg", jpeg_with_gps(), "image/jpeg"))])

    with pytest.raises(Exception):
        with client.websocket_connect("/ws/host?token=wrong") as ws:
            ws.receive_json()

    with client.websocket_connect(f"/ws/host?token={TOKEN}") as host, \
            client.websocket_connect("/ws/player") as p1, \
            client.websocket_connect("/ws/player") as p2:
        assert host.receive_json()["phase"] == "lobby"
        assert p1.receive_json()["role"] == "anonymous"
        p2.receive_json()

        p1.send_json({"type": "join", "name": "Anna"})
        joined = recv_until(p1, lambda m: m["type"] == "joined")
        p2.send_json({"type": "join", "name": "anna"})
        assert recv_until(p2, lambda m: m["type"] == "error")["code"] == "name_taken"
        p2.send_json({"type": "join", "name": "Ben"})
        recv_until(p2, lambda m: m["type"] == "joined")

        host.send_json({"action": "advance"})
        q = recv_until(host, lambda m: m["phase"] == "question")
        assert q["photo"].startswith("/media/") and q["answer"] is None

        pq = recv_until(p1, lambda m: m.get("phase") == "question")
        assert pq["answer"] is None, "answer must not leak to phones during the question"

        p1.send_json({"type": "guess", "lat": 50.07, "lng": 14.43})
        recv_until(p1, lambda m: m.get("my_guess") is not None)
        p2.send_json({"type": "guess", "lat": 48.2, "lng": 16.37})  # Vienna

        closed = recv_until(host, lambda m: m.get("closed") is True)  # everyone answered
        assert closed["answered_count"] == 2

        host.send_json({"action": "advance"})
        reveal = recv_until(host, lambda m: m["phase"] == "reveal")
        assert [g["name"] for g in reveal["guesses"]] == ["Anna", "Ben"]
        assert reveal["answer"]["lat"] == pytest.approx(50.0755, abs=1e-3)

        pr = recv_until(p1, lambda m: m.get("phase") == "reveal")
        assert pr["result"]["points"] > 4900 and pr["me"]["rank"] == 1

        host.send_json({"action": "advance"})  # only one photo -> final
        final = recv_until(p2, lambda m: m.get("phase") == "final")
        assert [x["name"] for x in final["podium"]] == ["Anna", "Ben"]
        assert final["me"]["rank"] == 2

        host.send_json({"action": "kick", "player_id": joined["player_id"]})
        assert recv_until(p1, lambda m: m["type"] == "kicked")


def test_iphone_heic_with_rotation(client):
    img = Image.new("RGB", (1200, 800), (90, 130, 170))
    exif = Image.Exif()
    exif.get_ifd(0x8825).update({1: "N", 2: (35, 14, 24.4), 3: "E", 4: (24, 48, 33.5)})
    exif[0x0112] = 6  # portrait shot, stored sideways
    buf = io.BytesIO()
    img.save(buf, "HEIF", exif=exif.tobytes())
    item = client.post("/api/admin/photos", headers=AUTH,
                       files=[("files", ("IMG_0001.HEIC", buf.getvalue(), "image/heic"))]).json()["added"][0]
    assert item["lat"] == pytest.approx(35.2401, abs=1e-3)
    served = Image.open(io.BytesIO(client.get(f"/media/{item['id']}.jpg").content))
    assert served.size[0] < served.size[1], "rotation must be baked in"
    assert not served.getexif()


def test_map_config_defaults_to_openfreemap_vector(client):
    cfg = client.get("/api/map-config").json()
    assert cfg["kind"] == "vector" and cfg["style"].startswith("https://tiles.openfreemap.org/")
    assert "OpenStreetMap" in cfg["attribution"]


def test_map_start_setting_reaches_phones(client):
    s = client.get("/api/admin/quiz", headers=AUTH).json()["settings"]
    assert s["map_start"] == "europe"
    s["map_start"] = "czechia"
    assert client.put("/api/admin/settings", headers=AUTH, json=s).status_code == 200
    with client.websocket_connect("/ws/player") as p:
        assert p.receive_json()["map_start"] == "czechia"


def test_map_config_uses_carto_key(tmp_path, monkeypatch):
    monkeypatch.setenv("PINPOINT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PINPOINT_ADMIN_TOKEN", TOKEN)
    monkeypatch.setenv("PINPOINT_CARTO_KEY", "abc123")
    with TestClient(create_app()) as c:
        cfg = c.get("/api/map-config").json()
    assert cfg["kind"] == "raster"
    assert cfg["url"].startswith("https://basemaps.cartocdn.com/") and cfg["url"].endswith("?key=abc123")
    assert "CARTO" in cfg["attribution"]


def test_host_keepalive_ping_is_not_an_action(client):
    with client.websocket_connect(f"/ws/host?token={TOKEN}") as host:
        host.receive_json()
        host.send_json({"type": "ping"})
        assert host.receive_json() == {"type": "pong"}


def test_avatars_endpoint_and_websocket_flow(client):
    avatars = client.get("/api/avatars").json()
    assert len(avatars) >= 40 and "🦊" in avatars

    client.post("/api/admin/photos", headers=AUTH,
                files=[("files", ("a.jpg", jpeg_with_gps(), "image/jpeg"))])
    with client.websocket_connect(f"/ws/host?token={TOKEN}") as host, \
            client.websocket_connect("/ws/player") as p1:
        host.receive_json(); p1.receive_json()
        p1.send_json({"type": "join", "name": "Anna", "avatar": "🦊"})
        assert recv_until(p1, lambda m: m["type"] == "joined")["avatar"] == "🦊"
        lobby = recv_until(host, lambda m: m.get("players"))
        assert lobby["players"][0]["avatar"] == "🦊"

        p1.send_json({"type": "avatar", "avatar": "🐧"})
        assert recv_until(host, lambda m: m.get("players") and m["players"][0]["avatar"] == "🐧")
        p1.send_json({"type": "avatar", "avatar": "nope"})
        assert recv_until(p1, lambda m: m["type"] == "error")["code"] == "bad_avatar"

        host.send_json({"action": "advance"})
        recv_until(p1, lambda m: m.get("phase") == "question")
        p1.send_json({"type": "guess", "lat": 50, "lng": 14})
        recv_until(host, lambda m: m.get("closed"))
        host.send_json({"action": "advance"})
        reveal = recv_until(host, lambda m: m.get("phase") == "reveal")
        assert reveal["guesses"][0]["avatar"] == "🐧"
        host.send_json({"action": "advance"})
        final = recv_until(p1, lambda m: m.get("phase") == "final")
        assert final["me"]["avatar"] == "🐧" and final["podium"][0]["avatar"] == "🐧"


def test_hint_area_sent_to_phones_without_the_answer(client):
    client.post("/api/admin/photos", headers=AUTH,
                files=[("files", ("a.jpg", jpeg_with_gps(), "image/jpeg"))])
    s = client.get("/api/admin/quiz", headers=AUTH).json()["settings"]
    client.put("/api/admin/settings", headers=AUTH, json={**s, "map_start": "photo"})
    with client.websocket_connect(f"/ws/host?token={TOKEN}") as host, \
            client.websocket_connect("/ws/player") as p1:
        host.receive_json(); p1.receive_json()
        p1.send_json({"type": "join", "name": "Anna"})
        recv_until(p1, lambda m: m["type"] == "joined")
        host.send_json({"action": "advance"})
        q = recv_until(p1, lambda m: m.get("phase") == "question")
        (south, west), (north, east) = q["start_bounds"]
        assert south < 50.0755 < north and west < 14.4378 < east
        assert q["answer"] is None
        host.send_json({"action": "close"})
        host.send_json({"action": "advance"})
        assert recv_until(p1, lambda m: m.get("phase") == "reveal")["start_bounds"] is None


def test_phone_copy_is_smaller_and_clean(client):
    raw = jpeg_with_gps()
    big = Image.open(io.BytesIO(raw)).resize((4000, 3000))
    exif = Image.open(io.BytesIO(raw)).getexif()
    buf = io.BytesIO()
    big.save(buf, "JPEG", exif=exif.tobytes())
    item = client.post("/api/admin/photos", headers=AUTH,
                       files=[("files", ("big.jpg", buf.getvalue(), "image/jpeg"))]).json()["added"][0]
    full = Image.open(io.BytesIO(client.get(f"/media/{item['id']}.jpg").content))
    phone_res = client.get(f"/media/{item['id']}_phone.jpg")
    phone = Image.open(io.BytesIO(phone_res.content))
    assert max(full.size) == 2048 and max(phone.size) == 1280
    assert not phone.getexif(), "phone copy must not carry EXIF either"
    assert "immutable" in phone_res.headers["cache-control"]


def test_startup_creates_missing_phone_copies(tmp_path, monkeypatch):
    monkeypatch.setenv("PINPOINT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PINPOINT_ADMIN_TOKEN", TOKEN)
    monkeypatch.setenv("PINPOINT_STATIC_DIR", str(tmp_path / "no-static"))
    with TestClient(create_app()) as c:
        pid = c.post("/api/admin/photos", headers=AUTH,
                     files=[("files", ("a.jpg", plain_jpeg(), "image/jpeg"))]).json()["added"][0]["id"]
    phone = tmp_path / "photos" / f"{pid}_phone.jpg"
    phone.unlink()  # as if uploaded by an older version
    with TestClient(create_app()) as c:
        assert phone.exists()
        assert c.get(f"/media/{pid}_phone.jpg").status_code == 200
        c.delete(f"/api/admin/photos/{pid}", headers=AUTH)
    assert not phone.exists()


def test_photo_urls_per_device_and_next_photo(client):
    ids = [client.post("/api/admin/photos", headers=AUTH,
                       files=[("files", (f"{i}.jpg", jpeg_with_gps(), "image/jpeg"))]).json()["added"][0]["id"]
           for i in range(2)]
    with client.websocket_connect(f"/ws/host?token={TOKEN}") as host, \
            client.websocket_connect("/ws/player") as p1:
        lobby_host = host.receive_json()
        assert lobby_host["photo"] is None and lobby_host["next_photo"] == f"/media/{ids[0]}.jpg"
        assert p1.receive_json()["next_photo"] == f"/media/{ids[0]}_phone.jpg"
        p1.send_json({"type": "join", "name": "Anna"})
        recv_until(p1, lambda m: m["type"] == "joined")

        host.send_json({"action": "advance"})
        q_host = recv_until(host, lambda m: m["phase"] == "question")
        q_phone = recv_until(p1, lambda m: m.get("phase") == "question")
        assert q_host["photo"] == f"/media/{ids[0]}.jpg" and q_phone["photo"] == f"/media/{ids[0]}_phone.jpg"
        assert q_host["next_photo"] is None, "the next photo is not announced while guessing"

        host.send_json({"action": "close"})
        host.send_json({"action": "advance"})          # reveal
        r = recv_until(p1, lambda m: m.get("phase") == "reveal")
        assert r["next_photo"] == f"/media/{ids[1]}_phone.jpg"
        host.send_json({"action": "advance"})          # leaderboard
        assert recv_until(host, lambda m: m["phase"] == "leaderboard")["next_photo"] == f"/media/{ids[1]}.jpg"
        host.send_json({"action": "advance"}); host.send_json({"action": "close"})
        host.send_json({"action": "advance"})          # last reveal
        assert recv_until(host, lambda m: m["phase"] == "reveal" and m["round_index"] == 1)["next_photo"] is None
