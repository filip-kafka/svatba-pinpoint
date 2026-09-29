"""The avatars guests can pick. Emoji, so there are no image files to host.

All are from Emoji 11 (2018) or older, so they render on any phone a wedding
guest is likely to bring. Edit the list freely; the phones load it from the
server (/api/avatars), and a player whose avatar is removed keeps it until they
rejoin.
"""

import random

AVATARS: list[str] = [
    # animals
    "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🦄", "🐙",
    "🐢", "🦋", "🐝", "🐞", "🦀", "🐬", "🐳", "🦒", "🦓", "🐘", "🦔", "🦙",
    "🦚", "🦝", "🐷", "🐰",
    # everything else
    "🌻", "🌵", "🍄", "🍉", "🍍", "🥑", "🍩", "🍕", "🥨", "🍺", "🍷", "🎸",
    "🎩", "👑", "🚀", "⛵", "🎈", "🌈", "💍", "🥂",
]

_VALID = frozenset(AVATARS)


def is_valid(avatar: object) -> bool:
    return isinstance(avatar, str) and avatar in _VALID


def pick(requested: object, rng: random.Random) -> str:
    """The requested avatar if it's on the list, otherwise a random one."""
    return requested if is_valid(requested) else rng.choice(AVATARS)  # type: ignore[return-value]
