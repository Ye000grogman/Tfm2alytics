# Tfm2alytics

A personal, offline, lolalytics-style stats site and draft helper for **Teamfight Manager 2**, built from your own save files.

Status: **Phase 2 (stats site)**. The draft helper comes next. See the project docs for the full plan.

## Quick start

Needs Python 3.10+ and nothing else.

```
python -m tfm2alytics.extract "%APPDATA%\TeamSamoyed\TeamfightManager2\data" -o data
python -m tfm2alytics.serve
```

The first command reads every save in the game's save folder (or pass one `.data` file).
The second opens the stats site in your browser at `http://127.0.0.1:8642/site/`. It only
runs on your PC. Re-run the extractor whenever you want fresh numbers.

## The stats site

- **Save picker:** every extracted save, newest selected first. You can also open an extracted `.json` file directly.
- **Filters:** patch, which matches count (whole league, your team's games, your team's picks, or your opponents' picks against you), minimum games, and search.
- **Tier list:** win rate, pick rate, ban rate, presence and games per champion. Click a header to sort. Tiers are relative: top 10% S, next 20% A, middle 40% B, next 20% C, bottom 10% D. They're ranked by a smoothed win rate with a small bonus for presence.
- **Champion panel:** best and worst allies (synergy), champions it beats or loses to (counters), and win rate by patch.

Small samples are smoothed toward the average so a 3-0 pair doesn't top the list. Every number shows its game count.

## Extract a save

```
python -m tfm2alytics.extract path\to\save_20261022_220834.data -o data
```

This writes `data/<save name>.json` with every match in the save (yours and AI vs AI):
patch, both teams (with names), 5 picks per side, 3 bans per side, picks in position order, and the winner.
Needs Python 3.10+ and nothing else.

## Save format (short version)

- Header: `TFM2` magic, team name, logo, manager name, game version, installed mods, then a PNG thumbnail.
- Body: a gzip stream (about 219 MB unpacked). Positional binary: strings are an 8-byte length plus text, numbers are 8-byte little-endian.
- Match summaries: one per game, ids `0..N-1`, holding patch, picks, result (`1` = team A won, checked against real results) and team ids.
- Team table: id and name for every team in the save.
- Match details: bans and per-player blocks. These have no match id, so they're linked to summaries by the set of ten picked champions.

Details and open questions are in `tfm2alytics/matches.py`.

## Tests

```
pip install pytest
python -m pytest
node --test tests/*.test.js
```
