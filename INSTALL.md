# Installation guide

This sets up Tfm2alytics on a Windows PC: the stats site and draft helper for Teamfight Manager 2.
It takes about 10 minutes the first time. After that, starting it is one double-click.

Everything runs on your own computer. Nothing is uploaded anywhere, and the game itself is not modified:
Tfm2alytics only *reads* your save files.

---

## 1. What you need

| Thing | Why | Where |
|---|---|---|
| Windows 10 or 11 | The game and the start script | – |
| Teamfight Manager 2 with at least one save | That's where the data comes from | Steam |
| Python 3.10 or newer | Runs the tool | python.org (step 2) |
| A web browser | Shows the site | Chrome, Edge, Firefox... |

No other software, packages or accounts are needed.

## 2. Install Python

1. Go to <https://www.python.org/downloads/> and click **Download Python 3.x** (any version 3.10 or newer).
2. Run the installer.
3. **On the first screen, tick "Add python.exe to PATH".** This is the step people miss most often.
4. Click **Install Now** and wait for it to finish.
5. Check it worked: press `Win + R`, type `cmd`, press Enter, then type:

   ```
   python --version
   ```

   You should see something like `Python 3.12.4`. If you get "not recognized", see [Troubleshooting](#7-troubleshooting).

Already have Python 3.10+? Skip this step.

## 3. Get Tfm2alytics

The code is in the private GitHub repository `Ye000grogman/Tfm2alytics`. Pick one way:

**Option A, download a ZIP (easiest):**

1. Open <https://github.com/Ye000grogman/Tfm2alytics> while logged in to GitHub.
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it somewhere permanent, for example `C:\Users\<you>\Tfm2alytics`.
   (Don't run it from inside the ZIP or from Downloads if you clean that folder.)

**Option B, with git (easier to update later):**

```
cd %USERPROFILE%
git clone https://github.com/Ye000grogman/Tfm2alytics.git
```

## 4. Start it

1. Open the Tfm2alytics folder.
2. Double-click **`start.bat`**.

A black console window opens and your browser opens the site at <http://127.0.0.1:8642/site/>.

The first start takes about 10 seconds per save file. Each save is about 60 MB, and the tool unpacks
it and pulls out every match. The console shows a line per save, like:

```
save_20261022_220834.data: 10077 matches (10054 with bans), 67 champions, 120 teams -> data\save_20261022_220834.json
Reading saves from C:\Users\<you>\AppData\Roaming\TeamSamoyed\TeamfightManager2\data. Press R on the site to check for new saves.
Stats site running at http://127.0.0.1:8642/site/ (Ctrl+C to stop)
```

**Keep the console window open while you use the site.** Closing it stops the site.

> Windows may show a "Windows protected your PC" warning the first time you run `start.bat`.
> Click **More info**, then **Run anyway**. The script only starts Python with this tool.

## 5. Using it

- **Stats** tab: pick a save (default: *Latest save*), a patch, and which matches to count: the whole league, your team's games,
  your team's picks, or your opponents' picks against you. Click a champion for its synergies, counters and win rate by patch.
- **Patches** tab: the game's patch notes, with how each changed champion did before and after the patch.
  Type a champion's name to see every patch that changed it.
- **Draft** tab: choose the patch (default: newest), who picks first and, if you like, your opponent, then follow the in-game draft.
  The highlighted slot is the next turn. Click a suggestion or any champion to fill it, and click any slot to change it.
  Press **Train model** once to train the draft model on your save (a few seconds). Press it again after new games.

### Updating the stats after a game

**Press `R` on the site** (or click **Check for new saves** at the top). The tool then:

1. looks at the game's save folder for saves written since the last check,
2. if there are none, does nothing and shows *"no new saves"*,
3. if there are, waits until the game has finished writing the file, re-reads it (about 6 seconds), and reloads the page's numbers.
   Your filters, selected champion and draft in progress are kept, and the line under the save picker shows *"updated just now"*.

Nothing is checked in the background between presses. On start, the tool also picks up any saves that changed while it was closed.

`R` works on both tabs, but not while you're typing in a search box.

The site can only be as fresh as the last save the game wrote to disk. If a game you just played doesn't show up
after pressing `R`, **save the game** (or let it autosave) and press `R` again. *Latest save* in the picker always shows the most
recently written save file, so new save files are picked up too.

## 6. Updating Tfm2alytics

- **ZIP install:** download the ZIP again and unzip it over the old folder. Your extracted data in `data\` is rebuilt automatically.
- **git install:** in the folder, run `git pull`.

Then start `start.bat` again.

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `start.bat` says *Python was not found* | Re-run the Python installer, choose **Modify**, and make sure **Add Python to environment variables** is ticked. Or reinstall and tick **Add python.exe to PATH**. Then open a *new* console. |
| `python --version` shows 3.9 or older | Install a newer Python from python.org. |
| Console or site says *Save folder not found* | Your saves are somewhere else. Find the folder with your `.data` files and start with `start.bat --saves "D:\path\to\folder"`. |
| Site says *Couldn't read data/index.json* | The site was opened directly as a file. Open it through the console's address, <http://127.0.0.1:8642/site/>, instead. |
| *Address already in use* / port error | Tfm2alytics is already running in another window. Use that one, or start with `start.bat --port 8650`. |
| Site says *Couldn't read ... yet* | The game was still writing the save. Wait a moment and press `R` again. |
| Site says *Couldn't reach the server* | The console window was closed. Start `start.bat` again. |
| A recent game is missing | Save the game (step 5). The tool can't see games that aren't in a save file yet. |
| Numbers look wrong after a game update | The save format may have changed. Note your game version (shown on the Stats tab) and report it. |
| Browser didn't open | Open <http://127.0.0.1:8642/site/> yourself. |

### Useful options

You can add these after `start.bat`, or after `python -m tfm2alytics.serve` in a console:

| Option | What it does |
|---|---|
| `--saves "<folder>"` | Read saves from a different folder |
| `--port 8650` | Use a different port |
| `--no-browser` | Don't open a browser tab on start |

## 8. Where things are

| What | Where |
|---|---|
| Game saves (read only, never changed) | `%APPDATA%\TeamSamoyed\TeamfightManager2\data` |
| Extracted data (safe to delete, rebuilt on start) | `Tfm2alytics\data\` |
| The site | `Tfm2alytics\site\` |

## 9. Uninstalling

Delete the Tfm2alytics folder. Nothing else was installed except Python, which you can remove from
*Settings > Apps* if you don't need it. Your game saves are untouched.

## For developers

- Tests: `pip install pytest`, `python -m pytest`, and `node --test tests/*.test.js` (Node 18+).
- Draft model backtest: `node tools/backtest.js data/<save>.json`.
- On macOS or Linux (for example to look at a copied save): `python3 -m tfm2alytics.serve --saves <folder with .data files>`.
