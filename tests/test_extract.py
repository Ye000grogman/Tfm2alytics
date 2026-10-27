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


def player_block(player_id, slot, champ, skills, fight):
    dealt, taken, healing, gold = fight
    return (
        u64(2) + u64(player_id) + u64(0) + u64(slot) + u64(1)
        + b"".join(u64(x) for x in skills) + u64(40) * 11 + u64(1) + u64(5) + u64(100)
        + s(champ) + u64(4) * 12 + s(champ) + u64(1) + s(champ)
        + u64(0) + u64(1) + u64(1) + u64(70) + u64(dealt) + u64(taken) + u64(healing) + u64(gold)
    )


def test_player_skills_and_fight_stats_are_read():
    positions = PICKS_A + PICKS_B
    players = b"".join(
        player_block(500 + i, i % 5, c, [60 + i] * 8, (1000 * i, 2000, 30 * i, 5000 + i)) for i, c in enumerate(positions)
    )
    body = (
        summary(0, 60, 62, PICKS_A, PICKS_B, 1)
        + summary(1, 3, 9, FILLER_CHAMPS[:5], [FILLER_CHAMPS[5], "monk", "gunner", "soldier", "lancer"], 1)
        + u64(7) + u64(60) + u64(62) + str_list(BANS_A) + str_list(BANS_B) + b"\x01" + players + u64(0) * 8
    )
    m = extract_matches(body)[0]
    assert m.bans_a == BANS_A
    assert [p["id"] for p in m.players_a] == [500, 501, 502, 503, 504]
    assert m.players_b[2] == {"id": 507, "skills": [67] * 8, "dealt": 7000, "taken": 2000, "healing": 210, "gold": 5007}


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


def test_needs_extract_tracks_newer_saves(tmp_path):
    import os

    from tfm2alytics.extract import FORMAT_VERSION
    from tfm2alytics.serve import needs_extract

    save = tmp_path / "save_1.data"
    save.write_bytes(b"x")
    out = tmp_path / "data"
    out.mkdir()
    assert needs_extract(save, out)
    (out / "save_1.json").write_text(f'{{"format_version":{FORMAT_VERSION}}}')
    os.utime(save, (1_000, 1_000))
    assert not needs_extract(save, out)
    os.utime(save, (4_000_000_000, 4_000_000_000))  # the game wrote the save again
    assert needs_extract(save, out)


def test_needs_extract_redoes_older_formats(tmp_path):
    import os

    from tfm2alytics.serve import needs_extract

    save = tmp_path / "save_1.data"
    save.write_bytes(b"x")
    os.utime(save, (1_000, 1_000))
    (tmp_path / "save_1.json").write_text('{"format_version":1}')
    assert needs_extract(save, tmp_path)


def test_refresh_only_extracts_changed_saves(tmp_path, monkeypatch):
    import os

    from tfm2alytics import serve

    monkeypatch.setattr(serve, "wait_until_written", lambda save: None)
    saves = tmp_path / "saves"
    saves.mkdir()
    save = saves / "save_1.data"
    save.write_bytes(b"TFM2\x00\x0fAbyssal Eclipse" + b"IEND\xae\x42\x60\x82" + gzip.compress(make_body()))
    os.utime(save, (1_000, 1_000))
    refresher = serve.Refresher(saves, tmp_path / "data")
    (tmp_path / "data").mkdir()

    assert refresher.run()["updated"] == ["save_1.data"]
    assert (tmp_path / "data" / "index.json").exists()
    assert refresher.run()["updated"] == []  # nothing new: R does nothing
    os.utime(save, (4_000_000_000, 4_000_000_000))  # the game saved again
    assert refresher.run()["updated"] == ["save_1.data"]


def test_refresh_without_save_folder_reports_it(tmp_path):
    from tfm2alytics import serve

    result = serve.Refresher(None, tmp_path).run()
    assert not result["ok"] and "Save folder" in result["error"]


def test_models_are_saved_next_to_the_data_and_left_out_of_the_index(tmp_path):
    import json

    import pytest

    from tfm2alytics.extract import write_index
    from tfm2alytics.serve import save_model

    (tmp_path / "save_1.json").write_text(json.dumps({"save": {"file": "save_1.data", "saved_at": 1}, "summary": {}}))
    path = save_model(tmp_path, "save_1", b'{"weights": {}}')
    assert path.name == "save_1.model.json"
    write_index(tmp_path)
    assert [s["json"] for s in json.loads((tmp_path / "index.json").read_text())] == ["save_1.json"]

    with pytest.raises(ValueError):
        save_model(tmp_path, "../evil", b"{}")
    with pytest.raises(ValueError):
        save_model(tmp_path, "save_1", b"not json")
