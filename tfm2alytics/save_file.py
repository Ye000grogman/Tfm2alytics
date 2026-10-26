"""Read a Teamfight Manager 2 save file (.data).

Layout, as observed on game version 0.6.2:

    "TFM2" magic
    small header: team name, team logo, manager name (1-byte length strings),
                  then game version and installed mods (8-byte length strings)
    PNG thumbnail
    gzip stream  -> the actual save body (positional binary, see matches.py)
"""

import re
import struct
import zlib
from dataclasses import dataclass, field

MAGIC = b"TFM2"
PNG_END = b"IEND\xae\x42\x60\x82"
GZIP_MAGIC = b"\x1f\x8b\x08"

_U64_STR = re.compile(rb"([\x01-\x40])\x00{7}([\x20-\x7e]+?)(?=[\x00-\x1f\x80-\xff]|$)")
_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


@dataclass
class SaveHeader:
    team: str | None = None
    logo: str | None = None
    manager: str | None = None
    game_version: str | None = None
    mods: dict[str, str] = field(default_factory=dict)


@dataclass
class SaveFile:
    header: SaveHeader
    body: bytes


def _short_strings(buf: bytes, start: int, count: int) -> list[str]:
    """Find the first `count` printable strings stored with a 1-byte length prefix."""
    out, i = [], start
    while i < len(buf) and len(out) < count:
        n = buf[i]
        chunk = buf[i + 1 : i + 1 + n]
        if 3 <= n <= 64 and len(chunk) == n and all(0x20 <= b < 0x7F for b in chunk):
            out.append(chunk.decode())
            i += 1 + n
        else:
            i += 1
    return out


def parse_header(raw: bytes) -> SaveHeader:
    header = SaveHeader()
    names = _short_strings(raw, 4, 3)
    header.team, header.logo, header.manager = (names + [None] * 3)[:3]

    # Mods are stored as (name, version) pairs of 8-byte length strings.
    strings = [
        m.group(2).decode()
        for m in _U64_STR.finditer(raw)
        if m.group(1)[0] == len(m.group(2))
    ]
    for name, version in zip(strings, strings[1:]):
        if _VERSION.match(version) and not _VERSION.match(name):
            if name == "base":
                header.game_version = version
            header.mods[name] = version
    return header


def read_save(path) -> SaveFile:
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(MAGIC):
        raise ValueError(f"{path}: not a TFM2 save (missing magic bytes)")

    png_end = data.find(PNG_END)
    search_from = png_end + len(PNG_END) if png_end != -1 else len(MAGIC)
    gz = data.find(GZIP_MAGIC, search_from)
    if gz == -1:
        raise ValueError(f"{path}: could not find the compressed save body")

    body = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(data[gz:])
    return SaveFile(header=parse_header(data[:search_from]), body=body)
