"""The "around the photo" start view: a hint area that contains the answer.

The answer is placed at a random spot in the middle 60 % of the area, so the
centre of the phone's map never gives it away. The area's size follows the
photo's scoring scale: a strictly scored city photo gets a small hint area,
a world-scale photo a large one.
"""

import math
import random

from .scoring import DEFAULT_SCALE

# Scoring scale -> width (and height) of the hint area in km.
HINT_SIZE_KM: dict[str, float] = {
    "world": 4000.0,     # roughly Europe
    "continent": 1600.0, # a handful of countries
    "country": 500.0,    # about the size of Czechia
    "city": 60.0,        # a city and its surroundings
}

KM_PER_DEG_LAT = 111.32
MAX_LAT = 84.0

Bounds = list[list[float]]  # [[south, west], [north, east]] - Leaflet's order


def hint_bounds(lat: float, lng: float, scale: str, rng: random.Random) -> Bounds:
    size_km = HINT_SIZE_KM.get(scale, HINT_SIZE_KM[DEFAULT_SCALE])
    h_deg = size_km / KM_PER_DEG_LAT
    w_deg = size_km / (KM_PER_DEG_LAT * max(0.2, math.cos(math.radians(lat))))

    # Where the answer sits inside the area, as a fraction from the south-west corner.
    fy = rng.uniform(0.2, 0.8)
    fx = rng.uniform(0.2, 0.8)

    south = lat - fy * h_deg
    north = south + h_deg
    # Keep the box on the map near the poles, still containing the answer.
    if north > MAX_LAT:
        south, north = south - (north - MAX_LAT), MAX_LAT
    if south < -MAX_LAT:
        south, north = -MAX_LAT, north + (-MAX_LAT - south)
    south = max(-MAX_LAT, min(south, lat))
    north = min(MAX_LAT, max(north, lat))

    west = lng - fx * w_deg
    east = west + w_deg  # may pass ±180; Leaflet handles wrapped longitudes
    return [[round(south, 5), round(west, 5)], [round(north, 5), round(east, 5)]]
