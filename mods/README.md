# TFM2 champion mods

`lukas_champions/` is a Teamfight Manager 2 mod that adds new champions, built with the
[official data-champion format](https://github.com/teamsamoyed/TeamfightManager2Mod).
It's data only (JSON + PNG), no code.

## Install

1. In Steam, right-click Teamfight Manager 2, **Manage > Browse local files**.
2. Copy the `lukas_champions` folder into the `mods` folder there (create `mods` if it doesn't exist).
3. Start the game, open **Mods** on the title screen, enable *Lukas's Champions*, and restart.

If something is wrong, the title screen shows a diagnostics popup, and details go to
`%APPDATA%\TeamSamoyed\TeamfightManager2\data\log.log`.

## Champions

### Celion (late-game scaling mage)

Placeholder look: Astrologer's body with custom skill icons and projectiles.

| Slot | Name | What it does |
|---|---|---|
| Skill 1 | Starlance | Skill shot, 60 + 60% AP to the first enemy hit, +2 AP permanently per hit |
| Skill 2 | Falling Star | Comet on an area after 0.75 s: 80 + 60% AP and a 0.9 s stun |
| Ult | Mana Surge | 5 s self buff: +20% AP, skill 1 and 2 cooldowns halved |

Stats: low base AP (30) with the highest AP growth of the mages (24 per level, Astrologer has 20),
slightly squishier than Astrologer. Cooldowns: 5 s, 9 s, 45 s.

TFM2 champions don't use mana, so "no longer using mana" in the ult has nothing to turn off.

### Things to check in game (first test)

- **Starlance stacks.** Do repeated hits add up (+2, +4, +6 AP...) or does each hit just refresh one +2?
  And do the stacks survive death? If either fails, the fix is a small native passive (Rust).
- **Mana Surge cooldowns.** The docs don't say exactly how `skill_cooldown_mult: 50` is applied.
  Check the skill 1 cooldown goes from 5 s to about 2.5 s during the ult.
- **Animations.** Celion borrows Astrologer's animations (`skill1`, `skill2`, `ult` tags).
- The Starlance stack also triggers on minions and monsters, not only champions.

## Art

`art_src/celion_art.py` draws the placeholder icons and projectiles with Pillow:
`python mods/art_src/celion_art.py`.
