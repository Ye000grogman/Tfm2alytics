import gzip
import struct

from tfm2alytics.matches import extract_matches, find_team_names
from tfm2alytics.save_file import parse_header, read_save


def u64(n):
    return struct.pack("<Q", n)


def s(text):
    return u64(len(text)) + text.encode()


def str_list(items):
    return u64(len(items)) + b"".join(s(x) for x in items)


PICKS_A = ["sand_mage", "astrologer", "gambler", "lancer", "dual_blader"]
PICKS_B = ["pyromancer", "poison_dart_hunter", "soldier", "gunner", "monk"]
BANS_A = ["circus_blade", "demon", "android"]
BANS_B = ["alchemist", "bomber", "swordman"]
TEAMS = {60: "Terra Comets", 62: "Quake Walkers", 26: "Lightning Raiders", 3: "Grid Strikers", 9: "Hyper Jump"}
FILLER_CHAMPS = BANS_A + BANS_B  # make sure ban champions are "known" picks elsewhere


def summary(match_id, team_a, team_b, picks_a, picks_b, result):
    return (
        u64(match_id) + u64(1) + u64(match_id)
        + s("2026.0.0") + str_list(picks_a) + str_list(picks_b) + bytes([result])
        + u64(team_a) + u64(team_b)
    )


def detail(team_a, team_b, bans_a, bans_b, positions):
    players = b"".join(s(c) + u64(0) * 4 for c in positions)
    return (
        u64(7) + u64(team_a) + u64(team_b) + str_list(bans_a) + str_list(bans_b)
        + b"\x01" + players + u64(0) * 8
    )


def make_body():
    other_a = FILLER_CHAMPS[:5]
    other_b = [FILLER_CHAMPS[5], "monk", "gunner", "soldier", "lancer"]
    teams = b"".join(u64(t) + u64(26) + u64(t) + s(name) for t, name in TEAMS.items())
    summaries = summary(0, 60, 62, PICKS_A, PICKS_B, 0) + summary(1, 3, 9, other_a, other_b, 1)
    details = detail(60, 62, BANS_A, BANS_B, list(reversed(PICKS_A)) + PICKS_B)
    return teams + b"\x00" * 16 + details + b"\x00" * 16 + summaries + b"\x00" * 16


def test_extract_matches_links_bans_and_positions():
    matches = extract_matches(make_body())
    assert [m.id for m in matches] == [0, 1]

    first = matches[0]
    assert (first.team_a, first.team_b, first.patch) == (60, 62, "2026.0.0")
    assert first.picks_a == PICKS_A and first.picks_b == PICKS_B
    assert first.winner == "b"
    assert first.bans_a == BANS_A and first.bans_b == BANS_B
    assert first.positions_a == list(reversed(PICKS_A))

    assert matches[1].winner == "a"
    assert matches[1].bans_a == []  # no detail record for this one


def test_detail_with_other_teams_is_not_linked():
    body = summary(0, 60, 62, PICKS_A, PICKS_B, 0) + detail(3, 9, BANS_A, BANS_B, PICKS_A + PICKS_B)
    assert extract_matches(body)[0].bans_a == []


def test_find_team_names():
    assert find_team_names(make_body(), {60, 62, 26, 3}) == {
        60: "Terra Comets", 62: "Quake Walkers", 26: "Lightning Raiders", 3: "Grid Strikers"
    }


def test_parse_header():
    raw = (
        b"TFM2\x05\xa8\xdd\x03\x00\x07\x0fAbyssal Eclipse\x1acustom:custom_team_logo/87"
        b"\x08Asphyxia" + b"h\xf4\x00\x00" + s("base") + s("0.6.2") + s("some_mod") + s("1.2.3")
    )
    h = parse_header(raw)
    assert (h.team, h.manager, h.game_version) == ("Abyssal Eclipse", "Asphyxia", "0.6.2")
    assert h.mods == {"base": "0.6.2", "some_mod": "1.2.3"}


def test_read_save_roundtrip(tmp_path):
    body = make_body()
    raw = b"TFM2\x00\x0fAbyssal Eclipse" + b"\x89PNG....IEND\xae\x42\x60\x82" + gzip.compress(body)
    path = tmp_path / "save.data"
    path.write_bytes(raw)
    save = read_save(path)
    assert save.body == body
    assert save.header.team == "Abyssal Eclipse"
