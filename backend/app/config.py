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
OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty"


def tile_config() -> dict:
    """Which map the pages load. First match wins:

    1. PINPOINT_TILES_URL (+ PINPOINT_TILES_ATTRIBUTION): any raster tile URL template.
    2. PINPOINT_CARTO_KEY: CARTO Voyager raster tiles (free key).
    3. PINPOINT_MAP_STYLE: a MapLibre vector style URL. Default: OpenFreeMap
       "liberty" - free, no key, no request limits, and vector tiles are small,
       so the map loads fast on phones and pinch-zooms smoothly.
    """
    custom = os.environ.get("PINPOINT_TILES_URL", "").strip()
    if custom:
        return {
            "kind": "raster",
            "url": custom,
            "attribution": os.environ.get("PINPOINT_TILES_ATTRIBUTION", OSM_ATTRIBUTION),
        }
    carto_key = os.environ.get("PINPOINT_CARTO_KEY", "").strip()
    if carto_key:
        return {
            "kind": "raster",
            "url": "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=" + carto_key,
            "attribution": OSM_ATTRIBUTION + ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
        }
    return {
        "kind": "vector",
        "style": os.environ.get("PINPOINT_MAP_STYLE", "").strip() or OPENFREEMAP_STYLE,
        "attribution": '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> '
                       + OSM_ATTRIBUTION,
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
