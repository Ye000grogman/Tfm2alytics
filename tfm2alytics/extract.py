"""Command line: turn a save file into a JSON dataset the website can load.

    python -m tfm2alytics.extract path/to/save.data -o data/
"""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from .matches import extract_matches
from .save_file import read_save

FORMAT_VERSION = 1


def build_dataset(save_path: Path) -> dict:
    save = read_save(save_path)
    matches = extract_matches(save.body)
    champions = sorted({c for mt in matches for c in mt.picks_a + mt.picks_b})
    return {
        "format_version": FORMAT_VERSION,
        "save": {"file": save_path.name, **asdict(save.header)},
        "champions": champions,
        "matches": [{**asdict(mt), "winner": mt.winner} for mt in matches],
        "summary": {
            "matches": len(matches),
            "with_bans": sum(1 for mt in matches if mt.bans_a),
            "patches": sorted({mt.patch for mt in matches}),
            "teams": len({mt.team_a for mt in matches} | {mt.team_b for mt in matches}),
        },
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Extract match history from a TFM2 save.")
    parser.add_argument("saves", nargs="+", type=Path, help="one or more .data save files")
    parser.add_argument("-o", "--out", type=Path, default=Path("data"), help="output folder")
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    for save_path in args.saves:
        dataset = build_dataset(save_path)
        out_path = args.out / f"{save_path.stem}.json"
        out_path.write_text(json.dumps(dataset, separators=(",", ":")))
        s = dataset["summary"]
        print(
            f"{save_path.name}: {s['matches']} matches ({s['with_bans']} with bans), "
            f"{len(dataset['champions'])} champions, {s['teams']} teams -> {out_path}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
