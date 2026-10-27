"""Command line: turn a save file into a JSON dataset the website can load.

    python -m tfm2alytics.extract path/to/save.data -o data/

A folder can be passed instead of a file to extract every .data save in it.
data/index.json lists every extracted save for the website's save picker.
"""

import argparse
import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

from .matches import extract_matches, find_team_names
from .patches import find_patch_notes
from .save_file import read_save

FORMAT_VERSION = 2  # 2: adds patch_notes


def default_save_dir() -> Path | None:
    """The game's save folder on Windows, if it exists."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    folder = Path(appdata) / "TeamSamoyed" / "TeamfightManager2" / "data"
    return folder if folder.is_dir() else None


def build_dataset(save_path: Path) -> dict:
    save = read_save(save_path)
    matches = extract_matches(save.body)
    champions = sorted({c for mt in matches for c in mt.picks_a + mt.picks_b})
    team_ids = {mt.team_a for mt in matches} | {mt.team_b for mt in matches}
    teams = find_team_names(save.body, team_ids)
    my_team = next((t for t, name in teams.items() if name == save.header.team), None)
    return {
        "format_version": FORMAT_VERSION,
        "save": {
            "file": save_path.name,
            "my_team_id": my_team,
            "saved_at": save_path.stat().st_mtime,
            "extracted_at": time.time(),
            **asdict(save.header),
        },
        "champions": champions,
        "teams": {str(t): teams.get(t, f"Team {t}") for t in sorted(team_ids)},
        "matches": [{**asdict(mt), "winner": mt.winner} for mt in matches],
        "patch_notes": find_patch_notes(save.body),
        "summary": {
            "matches": len(matches),
            "with_bans": sum(1 for mt in matches if mt.bans_a),
            "patches": sorted({mt.patch for mt in matches}),
            "teams": len(team_ids),
            "named_teams": len(teams),
        },
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Extract match history from a TFM2 save.")
    parser.add_argument(
        "saves", nargs="*", type=Path,
        help=".data save files or folders of them (default: the game's save folder)",
    )
    parser.add_argument("-o", "--out", type=Path, default=Path("data"), help="output folder")
    args = parser.parse_args(argv)

    if not args.saves:
        if default_save_dir() is None:
            parser.error("couldn't find the game's save folder; pass a save file or folder")
        args.saves = [default_save_dir()]
    save_paths = []
    for p in args.saves:
        save_paths += sorted(p.glob("*.data")) if p.is_dir() else [p]

    args.out.mkdir(parents=True, exist_ok=True)
    for save_path in save_paths:
        extract_save(save_path, args.out)
    write_index(args.out)
    return 0


def extract_save(save_path: Path, out: Path) -> Path:
    dataset = build_dataset(save_path)
    out_path = out / f"{save_path.stem}.json"
    # Write to a temp file first so the website never reads a half-written file.
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(dataset, separators=(",", ":")))
    tmp.replace(out_path)
    s = dataset["summary"]
    print(
        f"{save_path.name}: {s['matches']} matches ({s['with_bans']} with bans), "
        f"{len(dataset['champions'])} champions, {s['teams']} teams -> {out_path}",
        file=sys.stderr,
    )
    return out_path


def write_index(out: Path) -> None:
    """List every extracted save so the website can offer them in its picker."""
    saves = []
    for path in sorted(out.glob("*.json")):
        if path.name == "index.json":
            continue
        with path.open() as f:
            dataset = json.load(f)
        saves.append({**dataset["save"], **dataset["summary"], "json": path.name})
    saves.sort(key=lambda s: s.get("saved_at", 0))  # newest save last
    tmp = out / "index.json.tmp"
    tmp.write_text(json.dumps(saves, indent=1))
    tmp.replace(out / "index.json")


if __name__ == "__main__":
    raise SystemExit(main())
