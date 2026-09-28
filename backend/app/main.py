"""HTTP + WebSocket entry point.

Pages:   /         player (phones)
         /host     projector screen + host controls  (asks for the admin token)
         /admin    photo & answer editor             (asks for the admin token)
"""

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import photos
from .config import load_settings
from .game import load_game
from .hub import Hub
from .quiz import PhotoItem, PhotoPatch, QuizSettings, QuizStore, dump

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
MEDIA_NAME = re.compile(r"^[0-9a-f]{32}(_thumb)?\.jpg$")


def create_app() -> FastAPI:
    settings = load_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = QuizStore(settings.data_dir)
    game_path = settings.data_dir / "game.json"
    hub = Hub(load_game(game_path), store, game_path, settings.admin_token, settings.max_players)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        hub.ensure_timer()  # resume a running round after a restart
        yield

    app = FastAPI(title="Pinpoint", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.hub = hub
    app.state.store = store

    def require_admin(authorization: str = Header(default="")) -> None:
        token = authorization.removeprefix("Bearer ").strip()
        if not hub.check_token(token):
            raise HTTPException(status_code=401, detail="bad_token")

    admin = [Depends(require_admin)]

    # ------------------------------------------------------------ admin API

    @app.get("/api/admin/check", dependencies=admin, status_code=204)
    def admin_check() -> Response:
        return Response(status_code=204)

    @app.get("/api/admin/quiz", dependencies=admin)
    def get_quiz() -> dict:
        return {**dump(store.quiz), "game_phase": hub.game.phase.value}

    @app.post("/api/admin/photos", dependencies=admin)
    async def upload_photos(files: list[UploadFile]) -> dict:
        added, errors = [], []
        for f in files:
            raw = await f.read(MAX_UPLOAD_BYTES + 1)
            if len(raw) > MAX_UPLOAD_BYTES:
                errors.append({"file": f.filename, "error": "too_large"})
                continue
            try:
                processed = await asyncio.to_thread(photos.process_upload, raw, store.photos_dir)
            except photos.PhotoError:
                errors.append({"file": f.filename, "error": "unreadable"})
                continue
            item = store.add(PhotoItem(
                id=processed.photo_id, lat=processed.lat, lng=processed.lng,
                from_exif=processed.lat is not None,
            ))
            added.append(item.model_dump())
        await hub.broadcast(only_players=set())  # host lobby shows the new count
        return {"added": added, "errors": errors}

    @app.patch("/api/admin/photos/{photo_id}", dependencies=admin)
    async def patch_photo(photo_id: str, patch: PhotoPatch) -> dict:
        try:
            item = store.update(photo_id, patch)
        except KeyError:
            raise HTTPException(404, "not_found")
        await hub.broadcast(only_players=set())
        return item.model_dump()

    @app.delete("/api/admin/photos/{photo_id}", dependencies=admin, status_code=204)
    async def delete_photo(photo_id: str) -> Response:
        try:
            store.delete(photo_id)
        except KeyError:
            raise HTTPException(404, "not_found")
        await hub.broadcast(only_players=set())
        return Response(status_code=204)

    class Order(BaseModel):
        ids: list[str]

    @app.put("/api/admin/order", dependencies=admin, status_code=204)
    def reorder(order: Order) -> Response:
        try:
            store.reorder(order.ids)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return Response(status_code=204)

    @app.put("/api/admin/settings", dependencies=admin)
    async def put_settings(new: QuizSettings) -> dict:
        store.update_settings(new)
        await hub.broadcast()
        return new.model_dump()

    # -------------------------------------------------------------- media

    @app.get("/media/{name}")
    def media(name: str) -> FileResponse:
        if not MEDIA_NAME.match(name):
            raise HTTPException(404)
        path = store.photos_dir / name
        if not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400, immutable"})

    # --------------------------------------------------------- websockets

    @app.websocket("/ws/player")
    async def ws_player(ws: WebSocket) -> None:
        await ws.accept()
        await hub.player_session(ws)

    @app.websocket("/ws/host")
    async def ws_host(ws: WebSocket, token: str = "") -> None:
        if not hub.check_token(token):
            await ws.close(code=4401)
            return
        await ws.accept()
        await hub.host_session(ws)

    # ----------------------------------------------------- frontend pages

    static: Path = settings.static_dir
    if static.is_dir():
        def page(name: str):
            async def serve() -> FileResponse:
                return FileResponse(static / name, headers={"Cache-Control": "no-cache"})
            return serve

        app.get("/", include_in_schema=False)(page("index.html"))
        app.get("/host", include_in_schema=False)(page("host.html"))
        app.get("/admin", include_in_schema=False)(page("admin.html"))
        app.mount("/", StaticFiles(directory=static), name="static")

    return app
