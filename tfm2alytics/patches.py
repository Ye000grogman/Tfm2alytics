"""Pull the game's patch notes out of a decompressed save body.

Every balance patch the league has had is stored as a record, followed by the
in-game news item announcing it ("#asset/base/text/news?patch.title", which
holds the version again and the release date). The record is:

    str version ("2026.1.0")
    list[str] new champions
    u64 n, then n times:
        str champion
        u64 m, then m changes:
            u64 0, str stat key ("#asset/base/text/champion?stat.attack"),
            u8 has_target, [str target ("skill1", "ult", "base_attack")],
            str before, str after, u8 is_buff
    u64 n, then n times: str champion, str reasons ("nerf_meta_2,too_much_damage_2")
    u64 n, then n game rule changes:
        u64 0, str unit ("duration"), str rule key, str before, str after, u8 is_buff
    list[str] game rule reasons

The first patch of a save (2026.0.0) is the starting balance and has no record.
"""

import re
import struct

_TITLE = re.compile(rb"#asset/base/text/news\?patch\.title")
_VERSION = re.compile(rb"\x08\x00{7}\d{4}\.\d+\.\d+")
_DATE = re.compile(rb"\n\x00{7}(\d{4}-\d\d-\d\d)")
_SEARCH_BACK = 80_000  # the biggest record seen is about 4 KB


class _Reader:
    def __init__(self, body: bytes, pos: int):
        self.body = body
        self.pos = pos

    def u64(self) -> int:
        value = struct.unpack_from("<Q", self.body, self.pos)[0]
        self.pos += 8
        return value

    def u8(self) -> int:
        value = self.body[self.pos]
        self.pos += 1
        return value

    def str(self) -> str:
        n = self.u64()
        if n > 200:
            raise ValueError("not a string")
        text = self.body[self.pos:self.pos + n].decode()
        self.pos += n
        return text

    def count(self) -> int:
        n = self.u64()
        if n > 200:
            raise ValueError("not a count")
        return n


def _short_key(key: str) -> str:
    # "#asset/base/text/champion?stat.attack" -> "attack",
    # "#asset/base/text/news?patch.game_rule.kill_gold" -> "kill_gold"
    return key.rsplit("?", 1)[-1].rsplit(".", 1)[-1]


def _parse_record(r: _Reader) -> dict:
    version = r.str()
    new_champions = [r.str() for _ in range(r.count())]
    changes = {}
    for _ in range(r.count()):
        champion = r.str()
        entries = []
        for _ in range(r.count()):
            r.u64()
            stat = _short_key(r.str())
            target = r.str() if r.u8() else None
            before, after = r.str(), r.str()
            entries.append({"stat": stat, "target": target, "before": before, "after": after, "buff": bool(r.u8())})
        changes[champion] = entries
    reasons = {}
    for _ in range(r.count()):
        champion = r.str()
        reasons[champion] = [x for x in r.str().split(",") if x]
    rules = []
    for _ in range(r.count()):
        r.u64()
        r.str()  # unit, always "duration" so far
        rule = _short_key(r.str())
        before, after = r.str(), r.str()
        rules.append({"rule": rule, "before": before, "after": after, "buff": bool(r.u8())})
    rule_reasons = [r.str() for _ in range(r.count())]
    return {
        "version": version,
        "new_champions": new_champions,
        "changes": changes,
        "reasons": reasons,
        "game_rules": rules,
        "game_rule_reasons": rule_reasons,
    }


def find_patch_notes(body: bytes) -> list[dict]:
    """Every patch note in the save, oldest first."""
    notes = {}
    for title in _TITLE.finditer(body):
        end = title.start() - 8  # the title string's length prefix
        start = max(0, end - _SEARCH_BACK)
        note = None
        # The record ends right where the title starts. Take the last version
        # string before the title that parses cleanly up to that point.
        for m in _VERSION.finditer(body, start, end):
            r = _Reader(body, m.start())
            try:
                parsed = _parse_record(r)
            except (ValueError, UnicodeDecodeError, struct.error, IndexError):
                continue
            if r.pos == end:
                note = parsed
        if note is None:
            continue
        date = _DATE.search(body, title.end(), title.end() + 200)
        note["date"] = date.group(1).decode() if date else None
        notes[note["version"]] = note
    return sorted(notes.values(), key=lambda n: [int(x) for x in n["version"].split(".")])
