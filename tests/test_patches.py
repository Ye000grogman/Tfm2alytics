import struct

from tfm2alytics.patches import find_patch_notes


def u64(n):
    return struct.pack("<Q", n)


def s(text):
    return u64(len(text)) + text.encode()


def change(stat, before, after, buff, target=None):
    key = s(f"#asset/base/text/champion?{stat}")
    tgt = b"\x01" + s(target) if target else b"\x00"
    return u64(0) + key + tgt + s(before) + s(after) + bytes([buff])


def title(version, date):
    return (
        s("#asset/base/text/news?patch.title") + u64(1) + s("Version") + s(version)
        + s("Team Samoyed") + s(date) + s("00:00:00")
    )


def record(version, new, changes, reasons, rules=(), rule_reasons=()):
    out = s(version) + u64(len(new)) + b"".join(s(c) for c in new)
    out += u64(len(changes))
    for champ, entries in changes:
        out += s(champ) + u64(len(entries)) + b"".join(entries)
    out += u64(len(reasons)) + b"".join(s(c) + s(r) for c, r in reasons)
    out += u64(len(rules))
    for key, before, after, buff in rules:
        out += u64(0) + s("duration") + s(f"#asset/base/text/news?patch.game_rule.{key}") + s(before) + s(after) + bytes([buff])
    out += u64(len(rule_reasons)) + b"".join(s(r) for r in rule_reasons)
    return out


def test_find_patch_notes_reads_changes_reasons_and_rules():
    body = (
        b"\x00" * 40
        + s("2026.0.0")  # an unrelated version string just before the record
        + record(
            "2026.1.0", ["dancer"],
            [("vampire", [change("stat.attack", "120", "96", 0), change("patch_key.cooltime", "8.0", "7.7", 1, "skill2")])],
            [("vampire", "nerf_meta_2,too_much_damage_3")],
            rules=[("kill_gold", "300", "318", 1)], rule_reasons=["game_too_long_1"],
        )
        + title("2026.1.0", "2026-05-04")
        + b"\x00" * 30
        + record("2026.0.1", [], [("knight", [change("stat.hp", "900", "1080", 1)])], [("knight", "unpicked_long")])
        + title("2026.0.1", "2026-03-11")
    )
    notes = find_patch_notes(body)
    assert [n["version"] for n in notes] == ["2026.0.1", "2026.1.0"]

    first, second = notes
    assert first["date"] == "2026-03-11"
    assert first["changes"] == {"knight": [{"stat": "hp", "target": None, "before": "900", "after": "1080", "buff": True}]}

    assert second["new_champions"] == ["dancer"]
    assert second["changes"]["vampire"][1] == {"stat": "cooltime", "target": "skill2", "before": "8.0", "after": "7.7", "buff": True}
    assert second["reasons"] == {"vampire": ["nerf_meta_2", "too_much_damage_3"]}
    assert second["game_rules"] == [{"rule": "kill_gold", "before": "300", "after": "318", "buff": True}]
    assert second["game_rule_reasons"] == ["game_too_long_1"]
