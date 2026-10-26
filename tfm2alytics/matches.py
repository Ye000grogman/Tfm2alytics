"""Pull match history out of a decompressed save body.

The body has no field names: strings are an 8-byte little-endian length plus
UTF-8 text, and integers are 8-byte little-endian. Two record types matter:

Match summary (one per game, ids run 0..N-1, stored back to back):
    u64 match_id, u64 1, u64 match_id,
    str patch ("2026.0.0"),
    list[str] team A picks (5), list[str] team B picks (5),
    u8 result (1 = team A won),
    u64 team_a, u64 team_b

Match detail (one per game, separate section with its own numbering):
    ... u64 detail_id, u64 team_a, u64 team_b,
    list[str] team A bans (3), list[str] team B bans (3),
    then one block per player holding the champion they played, in position
    order (team A's five, then team B's five) followed by per-player stats.

The detail list has a few more games than the summary list, so the two ids
drift apart. Details are linked to summaries by the set of ten champions
picked (unique for almost every game) and the team ids must agree.

Team table: u64 team_id, u64 26, u64 team_id, str name.

Checked against real results: Abyssal Eclipse 0-2 Polar Blizzards and
Adamant Ronin 2-0 Quartz Imps (the last series in the save) both come out
right with "result 1 = team A won".
"""

import re
import struct
from dataclasses import dataclass, field

_IDENT = rb"[a-z][a-z0-9_]{1,40}"
_SUMMARY = re.compile(
    rb"\x08\x00{7}(\d{4}\.\d+\.\d+)"  # patch string
    rb"\x05\x00{7}"  # team A pick count
)
_ID_STR = re.compile(rb"([\x02-\x29])\x00{7}(" + _IDENT + rb")")
# Lookahead so matches can overlap: an id of 26 looks like the tag itself.
_TEAM = re.compile(rb"(?=(.{8})\x1a\x00{7}(.{8})([\x01-\x40])\x00{7})", re.S)
_TEAM_NAME = re.compile(r"[A-Za-z0-9 '.&-]+")


@dataclass
class Match:
    id: int
    patch: str
    team_a: int
    team_b: int
    picks_a: list[str]
    picks_b: list[str]
    raw_result: int
    bans_a: list[str] = field(default_factory=list)
    bans_b: list[str] = field(default_factory=list)
    # Picks in position order, when the detail record was found.
    positions_a: list[str] = field(default_factory=list)
    positions_b: list[str] = field(default_factory=list)

    @property
    def winner(self) -> str:
        return "a" if self.raw_result == 1 else "b"


def _u64(buf: bytes, off: int) -> int:
    return struct.unpack_from("<Q", buf, off)[0]


def _read_str(buf: bytes, off: int) -> tuple[str, int]:
    n = _u64(buf, off)
    if n > 64:
        raise ValueError("implausible string length")
    return buf[off + 8 : off + 8 + n].decode("utf-8"), off + 8 + n


def _read_str_list(buf: bytes, off: int) -> tuple[list[str], int]:
    count = _u64(buf, off)
    if count > 16:
        raise ValueError("implausible list length")
    off += 8
    items = []
    for _ in range(count):
        s, off = _read_str(buf, off)
        items.append(s)
    return items, off


def _is_ident(s: str) -> bool:
    return re.fullmatch(_IDENT.decode(), s) is not None


def find_summaries(body: bytes) -> list[Match]:
    matches = []
    for m in _SUMMARY.finditer(body):
        start = m.start() - 24
        if start < 0:
            continue
        match_id, one, match_id2 = (_u64(body, start + 8 * i) for i in range(3))
        if one != 1 or match_id != match_id2:
            continue
        try:
            picks_a, off = _read_str_list(body, m.end() - 8)
            picks_b, off = _read_str_list(body, off)
            team_a, team_b = _u64(body, off + 1), _u64(body, off + 9)
        except (ValueError, UnicodeDecodeError, struct.error):
            continue
        picks = picks_a + picks_b
        if len(picks_a) != 5 or len(picks_b) != 5 or not all(map(_is_ident, picks)):
            continue
        if len(set(picks)) != 10 or body[off] > 1:
            continue
        matches.append(
            Match(
                id=match_id,
                patch=m.group(1).decode(),
                team_a=team_a,
                team_b=team_b,
                picks_a=picks_a,
                picks_b=picks_b,
                raw_result=body[off],
            )
        )
    return matches


def _champ_strings(body: bytes, champions: set[str], start: int, end: int) -> list[str]:
    out = []
    for m in _ID_STR.finditer(body, start, end):
        name = m.group(2).decode()
        if m.group(1)[0] == len(m.group(2)) and name in champions and name not in out:
            out.append(name)
    return out


def attach_details(body: bytes, matches: list[Match]) -> int:
    """Fill in bans and position order from the detail records. Returns how many were linked."""
    champions = {c for mt in matches for c in mt.picks_a + mt.picks_b}
    one = rb"[\x02-\x29]\x00{7}(?:" + b"|".join(
        re.escape(c.encode()) for c in sorted(champions, key=len, reverse=True)
    ) + rb")"
    ban_pair = re.compile(rb"\x03\x00{7}((?:" + one + rb"){3})\x03\x00{7}((?:" + one + rb"){3})")

    by_picks: dict[frozenset, list[Match]] = {}
    for mt in matches:
        by_picks.setdefault(frozenset(mt.picks_a + mt.picks_b), []).append(mt)

    hits = list(ban_pair.finditer(body))
    linked = 0
    for i, h in enumerate(hits):
        next_start = hits[i + 1].start() if i + 1 < len(hits) else min(len(body), h.end() + 20000)
        played = _champ_strings(body, champions, h.end(), next_start)[:10]
        candidates = by_picks.get(frozenset(played), [])
        if len(candidates) != 1 or len(played) != 10:
            continue  # ambiguous or not a match detail record
        mt = candidates[0]
        teams = (_u64(body, h.start() - 16), _u64(body, h.start() - 8))
        if set(played[:5]) != set(mt.picks_a) or teams != (mt.team_a, mt.team_b):
            continue
        bans_a, off = _read_str_list(body, h.start())
        bans_b, _ = _read_str_list(body, off)
        mt.bans_a, mt.bans_b = bans_a, bans_b
        mt.positions_a, mt.positions_b = played[:5], played[5:]
        linked += 1
    return linked


def find_team_names(body: bytes, team_ids: set[int]) -> dict[int, str]:
    names: dict[int, str] = {}
    for m in _TEAM.finditer(body):
        team_id, team_id2, n = _u64(m.group(1), 0), _u64(m.group(2), 0), m.group(3)[0]
        if team_id != team_id2 or team_id not in team_ids or team_id in names:
            continue
        name = body[m.start() + 32 : m.start() + 32 + n].decode("utf-8", "replace")
        if _TEAM_NAME.fullmatch(name):
            names[team_id] = name
    return names


def extract_matches(body: bytes) -> list[Match]:
    matches = find_summaries(body)
    attach_details(body, matches)
    return sorted(matches, key=lambda mt: mt.id)
