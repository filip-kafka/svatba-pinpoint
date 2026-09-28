"""Runtime configuration, read from environment variables."""

import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("pinpoint")


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    static_dir: Path
    admin_token: str
    max_players: int
    tiles: dict


OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'


def tile_config() -> dict:
    """Which map tiles the pages load. Precedence:

    1. PINPOINT_TILES_URL (+ PINPOINT_TILES_ATTRIBUTION): any Leaflet tile URL template.
    2. PINPOINT_CARTO_KEY: CARTO Voyager (free key, 5M tiles/month for non-commercial use).
    3. Nothing set: OpenStreetMap's own tiles, no key needed.
    """
    custom = os.environ.get("PINPOINT_TILES_URL", "").strip()
    if custom:
        return {
            "url": custom,
            "attribution": os.environ.get("PINPOINT_TILES_ATTRIBUTION", OSM_ATTRIBUTION),
            "maxZoom": 19,
        }
    carto_key = os.environ.get("PINPOINT_CARTO_KEY", "").strip()
    if carto_key:
        return {
            "url": "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=" + carto_key,
            "attribution": OSM_ATTRIBUTION + ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
            "maxZoom": 19,
        }
    return {
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "attribution": OSM_ATTRIBUTION,
        "maxZoom": 19,
    }


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("PINPOINT_DATA_DIR", "data")).resolve()
    static_dir = Path(
        os.environ.get("PINPOINT_STATIC_DIR", Path(__file__).parent.parent / "static")
    ).resolve()

    token = os.environ.get("PINPOINT_ADMIN_TOKEN", "").strip()
    if not token:
        token = secrets.token_urlsafe(12)
        log.warning(
            "PINPOINT_ADMIN_TOKEN is not set - generated a temporary one: %s", token
        )

    return Settings(
        data_dir=data_dir,
        static_dir=static_dir,
        admin_token=token,
        max_players=int(os.environ.get("PINPOINT_MAX_PLAYERS", "300")),
        tiles=tile_config(),
    )
