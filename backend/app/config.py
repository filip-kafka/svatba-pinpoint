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
    )
