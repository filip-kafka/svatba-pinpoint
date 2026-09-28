"""Distance and points.

Points fall off exponentially with distance: a guess ``scale_km / 4`` away earns
~78 % of the maximum, a guess ``scale_km`` away ~37 %. Each photo picks a scale
preset, so a photo from your home town can be judged more strictly than one
from the other side of the planet.
"""

import math

MAX_POINTS = 5000
EARTH_RADIUS_KM = 6371.0088

# Preset name -> scale in km. "world" is the default.
SCALES_KM: dict[str, float] = {
    "world": 2000.0,
    "continent": 500.0,
    "country": 150.0,
    "city": 15.0,
}
DEFAULT_SCALE = "world"


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def points_for(distance_km: float, scale: str = DEFAULT_SCALE) -> int:
    scale_km = SCALES_KM.get(scale, SCALES_KM[DEFAULT_SCALE])
    return round(MAX_POINTS * math.exp(-distance_km / scale_km))


def normalize_lng(lng: float) -> float:
    """Leaflet lets people pan past the date line; fold back into [-180, 180)."""
    return ((lng + 180.0) % 360.0) - 180.0
