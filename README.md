# Tfm2alytics

A personal, offline, lolalytics-style stats site and draft helper for **Teamfight Manager 2**, built from your own save files.

Status: **Phase 1 (extractor)**. The stats site and draft helper come next. See the project docs for the full plan.

## Extract a save

Saves live in `C:\Users\<you>\AppData\Roaming\TeamSamoyed\TeamfightManager2\data`.

```
python -m tfm2alytics.extract path\to\save_20261022_220834.data -o data
```

This writes `data/<save name>.json` with every match in the save (yours and AI vs AI):
patch, both teams, 5 picks per side, 3 bans per side, picks in position order, and the winner.
Needs Python 3.10+ and nothing else.

## Save format (short version)

- Header: `TFM2` magic, team name, logo, manager name, game version, installed mods, then a PNG thumbnail.
- Body: a gzip stream (about 219 MB unpacked). Positional binary: strings are an 8-byte length plus text, numbers are 8-byte little-endian.
- Match summaries: one per game, ids `0..N-1`, holding teams, patch, picks and result.
- Match details: bans and per-player blocks. These have no match id, so they're linked to summaries by the set of ten picked champions.

Details and open questions are in `tfm2alytics/matches.py`.

## Tests

```
pip install pytest
python -m pytest
```
