"""Photo ingestion: read GPS from EXIF, then re-encode without any metadata.

Stripping matters: if the served JPEG kept its EXIF block, any guest could
long-press, save the image and read the answer straight out of it.
"""

import io
import uuid
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()  # iPhone photos are HEIC by default

GPS_IFD = 0x8825
MAX_EDGE = 2048    # the projector's copy: enough for a 1080p/1440p screen
PHONE_EDGE = 1280  # the phones' copy: sharp full screen on a phone, ~3x smaller to download
PHONE_QUALITY = 80
THUMB_EDGE = 480   # admin page only


class PhotoError(ValueError):
    pass


@dataclass
class ProcessedPhoto:
    photo_id: str
    lat: float | None
    lng: float | None


def _dms_to_deg(dms, ref) -> float:
    d, m, s = (float(x) for x in dms)
    deg = d + m / 60 + s / 3600
    ref = ref.decode() if isinstance(ref, bytes) else ref
    return -deg if ref in ("S", "W") else deg


def read_gps(img: Image.Image) -> tuple[float, float] | None:
    try:
        gps = img.getexif().get_ifd(GPS_IFD)
        lat = _dms_to_deg(gps[2], gps[1])
        lng = _dms_to_deg(gps[4], gps[3])
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None
    if lat == 0 and lng == 0:  # some cameras write zeros when there is no fix
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return lat, lng


def process_upload(raw: bytes, photos_dir: Path) -> ProcessedPhoto:
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # Pillow raises a zoo of exception types
        raise PhotoError("Not a readable image") from exc

    gps = read_gps(img)

    img = ImageOps.exif_transpose(img)  # bake rotation in before dropping EXIF
    if img.mode != "RGB":
        img = img.convert("RGB")

    photo_id = uuid.uuid4().hex
    photos_dir.mkdir(parents=True, exist_ok=True)

    full = img.copy()
    full.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    # No exif= argument -> Pillow writes a clean JPEG with no metadata.
    full.save(photos_dir / f"{photo_id}.jpg", "JPEG", quality=85, optimize=True)

    _save_phone(full, photos_dir / f"{photo_id}_phone.jpg")

    thumb = img.copy()
    thumb.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.Resampling.LANCZOS)
    thumb.save(photos_dir / f"{photo_id}_thumb.jpg", "JPEG", quality=80)

    lat, lng = gps if gps else (None, None)
    return ProcessedPhoto(photo_id=photo_id, lat=lat, lng=lng)


def _save_phone(full: Image.Image, path: Path) -> None:
    phone = full.copy()
    phone.thumbnail((PHONE_EDGE, PHONE_EDGE), Image.Resampling.LANCZOS)
    # Progressive: a blurry version shows up almost at once and sharpens as it loads.
    phone.save(path, "JPEG", quality=PHONE_QUALITY, optimize=True, progressive=True)


def ensure_phone_copy(photo_id: str, photos_dir: Path) -> bool:
    """Create the phone copy for a photo uploaded before phone copies existed."""
    target = photos_dir / f"{photo_id}_phone.jpg"
    source = photos_dir / f"{photo_id}.jpg"
    if target.exists() or not source.exists():
        return False
    with Image.open(source) as img:
        _save_phone(img.convert("RGB"), target)
    return True


def delete_files(photo_id: str, photos_dir: Path) -> None:
    for name in (f"{photo_id}.jpg", f"{photo_id}_phone.jpg", f"{photo_id}_thumb.jpg"):
        (photos_dir / name).unlink(missing_ok=True)
