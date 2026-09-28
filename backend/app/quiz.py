"""The quiz definition (photos, their answers, settings), stored as JSON on disk."""

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from . import photos as photo_files

Scale = Literal["world", "continent", "country", "city"]
MapStart = Literal["world", "europe", "czechia"]


class PhotoItem(BaseModel):
    id: str
    lat: float | None = None
    lng: float | None = None
    caption_cs: str = ""
    caption_en: str = ""
    scale: Scale = "world"
    time_limit: int | None = Field(default=None, ge=5, le=600)  # None = use default
    from_exif: bool = False

    @property
    def playable(self) -> bool:
        return self.lat is not None and self.lng is not None


class QuizSettings(BaseModel):
    title_cs: str = "Kde to bylo?"
    title_en: str = "Where was this?"
    subtitle_cs: str = ""
    subtitle_en: str = ""
    default_time_limit: int = Field(default=40, ge=5, le=600)
    map_start: MapStart = "europe"  # where the guessing map opens on phones


class Quiz(BaseModel):
    settings: QuizSettings = QuizSettings()
    photos: list[PhotoItem] = []


class PhotoPatch(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    caption_cs: str | None = None
    caption_en: str | None = None
    scale: Scale | None = None
    time_limit: int | None = Field(default=None, ge=5, le=600)
    clear_time_limit: bool = False


class QuizStore:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "quiz.json"
        self.photos_dir = data_dir / "photos"
        self.photos_dir.mkdir(parents=True, exist_ok=True)
        self.quiz = self._load()

    def _load(self) -> Quiz:
        if self.path.exists():
            return Quiz.model_validate_json(self.path.read_text(encoding="utf-8"))
        return Quiz()

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(self.quiz.model_dump_json(indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def get(self, photo_id: str) -> PhotoItem:
        for p in self.quiz.photos:
            if p.id == photo_id:
                return p
        raise KeyError(photo_id)

    def add(self, item: PhotoItem) -> PhotoItem:
        self.quiz.photos.append(item)
        self.save()
        return item

    def update(self, photo_id: str, patch: PhotoPatch) -> PhotoItem:
        item = self.get(photo_id)
        data = patch.model_dump(exclude_unset=True)
        if data.pop("clear_time_limit", False):
            item.time_limit = None
        for key, value in data.items():
            setattr(item, key, value)
        if "lat" in data or "lng" in data:
            item.from_exif = False
        self.save()
        return item

    def delete(self, photo_id: str) -> None:
        item = self.get(photo_id)
        self.quiz.photos.remove(item)
        photo_files.delete_files(photo_id, self.photos_dir)
        self.save()

    def reorder(self, ids: list[str]) -> None:
        by_id = {p.id: p for p in self.quiz.photos}
        if sorted(ids) != sorted(by_id):
            raise ValueError("Order must contain every photo exactly once")
        self.quiz.photos = [by_id[i] for i in ids]
        self.save()

    def update_settings(self, settings: QuizSettings) -> None:
        self.quiz.settings = settings
        self.save()

    def playable_photos(self) -> list[PhotoItem]:
        return [p for p in self.quiz.photos if p.playable]


def dump(quiz: Quiz) -> dict:
    return json.loads(quiz.model_dump_json())
