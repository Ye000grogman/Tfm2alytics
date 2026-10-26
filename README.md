# Tfm2alytics

A personal, offline, lolalytics-style stats site and draft helper for **Teamfight Manager 2**, built from your own save files.

Status: **Phase 4 (draft helper v0)**. Next is a trained draft model. See the project docs for the full plan.

## Quick start

**New here? Follow [INSTALL.md](INSTALL.md).** It covers everything from installing Python onward.

Needs Python 3.10+ and nothing else. On Windows, double-click `start.bat`, or run:

```
python -m tfm2alytics.serve
```

This reads every save in the game's save folder, opens the site at `http://127.0.0.1:8642/site/`,
and keeps watching the folder. Whenever the game writes a save, the save is re-read and any open page
refreshes its numbers within about 15 seconds, without losing your filters or the draft in progress.
"Latest save" in the save picker always follows the newest save. Everything runs on your PC.

To extract without the site: `python -m tfm2alytics.extract [save file or folder] -o data`.

## The stats site

- **Save picker:** "Latest save" (follows the game) or any extracted save. You can also open an extracted `.json` file directly.
- **Filters:** patch, which matches count (whole league, your team's games, your team's picks, or your opponents' picks against you), minimum games, and search.
- **Tier list:** win rate, pick rate, ban rate, presence and games per champion. Click a header to sort. Tiers are relative: top 10% S, next 20% A, middle 40% B, next 20% C, bottom 10% D. They're ranked by a smoothed win rate with a small bonus for presence.
- **Champion panel:** best and worst allies (synergy), champions it beats or loses to (counters), and win rate by patch.

## The draft helper

Open the **Draft** tab. Pick the patch to take stats from (the newest patch is the default), choose who picks first, and fill the
board as the in-game draft goes. Click a suggestion or any champion to put it in the highlighted slot. Click any slot to change it.

- **Your pick:** champions ranked by win rate on this patch, plus synergy with your picks, plus how they do against the enemy's picks. Each suggestion lists its biggest reasons.
- **Your ban:** champions that would be best for the enemy given their picks, nudged toward the ones that get picked or banned a lot.
- **Enemy turns:** shows their strongest options, so you can see what's coming.
- **Draft edge:** a win chance from the picks alone. It ignores player skill.

The board follows TFM2's order: bans alternate starting with the first team, then picks go 1-2-2-2-2-1. Any slot can also be filled by hand.

### How good is it?

`node tools/backtest.js data/<save>.json` predicts every game with a model that never saw it (5-fold cross-validation). On the first save (10,077 games):

| Predictor | Picks the winner |
|---|---|
| Team A always wins | 52.4% |
| Champion win rates from all patches | 58.1% |
| Champion win rates from the same patch | 63.5% |
| Same patch + synergy + counters (the draft helper) | 63.6% |

Balance changes between patches matter a lot. Synergy and counters barely add accuracy yet, but they explain *why* a pick is good.

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

To re-check the draft model after a change: `node tools/backtest.js data/<save>.json`.
