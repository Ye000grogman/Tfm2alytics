// Patch notes: what each patch changed, and how the changed champions did on the
// patch before vs the patch itself. Pure functions, no DOM.

const PatchNotes = (() => {
  const STAT_NAMES = {
    cooltime: "Cooldown",
    attack_coef: "Attack ratio",
    ap_coef: "Magic power ratio",
    magic_power: "Magic power",
    magic_resistance: "Magic resist",
    defence: "Defense",
    hp: "HP",
    hit_box: "Hitbox",
    buff_time: "Buff duration",
    slow_ratio: "Slow amount",
    slow_time: "Slow duration",
    stun: "Stun duration",
    bind: "Root duration",
  };
  const TARGET_NAMES = { skill1: "Skill 1", skill2: "Skill 2", ult: "Ultimate", base_attack: "Basic attack" };
  const REASON_NAMES = {
    nerf_meta: "Too strong in the meta",
    buff_meta: "Weak in the meta",
    unpicked_long: "Not picked for a long time",
    unpicked: "Rarely picked",
    too_much_damage: "Too much damage",
    low_damage: "Low damage",
    too_tanky: "Too tanky",
    too_fragile: "Too fragile",
    late_game_scaling: "Scales too well late",
    weak_early_game: "Weak early game",
    early_game_dominant: "Dominant early game",
    too_much_healing: "Too much healing",
    low_healing: "Low healing",
    game_too_long: "Games last too long",
  };
  const RULE_NAMES = {
    kill_gold: "Kill gold",
    assist_gold: "Assist gold",
    gold_per_second: "Gold per second",
    kill_exp: "Kill XP",
    tower_hp: "Tower HP",
    tower_defence: "Tower defense",
  };

  const words = (id) => {
    const text = id.replace(/_/g, " ");
    return text[0].toUpperCase() + text.slice(1);
  };

  function statLabel(change) {
    let stat = change.stat;
    let suffix = "";
    if (stat.startsWith("growth_")) {
      stat = stat.slice("growth_".length);
      suffix = " per level";
    }
    const name = (STAT_NAMES[stat] || words(stat)) + suffix;
    return change.target ? `${TARGET_NAMES[change.target] || words(change.target)} · ${name}` : name;
  }

  // "too_much_damage_3" -> { text: "Too much damage", level: 3 }
  function reasonLabel(reason) {
    const m = reason.match(/^(.*?)_(\d)$/);
    const key = m ? m[1] : reason;
    return { text: REASON_NAMES[key] || REASON_NAMES[reason] || words(key), level: m ? Number(m[2]) : null };
  }

  const ruleLabel = (rule) => RULE_NAMES[rule] || words(rule);

  // "buff", "nerf" or "mixed" for a champion's list of changes.
  function verdict(changes) {
    const buffs = changes.filter((c) => c.buff).length;
    if (buffs === changes.length) return "buff";
    if (buffs === 0) return "nerf";
    return "mixed";
  }

  // Every patch, oldest first: the ones with notes and the ones only seen in matches.
  function patchList(dataset) {
    const versions = new Set(dataset.matches.map((m) => m.patch));
    for (const n of dataset.patch_notes || []) versions.add(n.version);
    return [...versions].sort(Stats.comparePatch);
  }

  // Whole-league champion rows for one patch, by champion id.
  function rowsFor(dataset, patch) {
    const matches = dataset.matches.filter((m) => m.patch === patch);
    const sides = Stats.sidesFor(matches, "all", dataset.save.my_team_id);
    const champions = new Set(dataset.champions);
    for (const m of matches) for (const c of [...m.picks_a, ...m.picks_b]) champions.add(c);
    const rows = Stats.championTable(sides, "all", [...champions]);
    return { games: matches.length, byId: new Map(rows.map((r) => [r.id, r])) };
  }

  // Each patch note with its changed champions and their before/after stats.
  function build(dataset) {
    const patches = patchList(dataset);
    const cache = new Map();
    const rows = (patch) => {
      if (!patch) return null;
      if (!cache.has(patch)) cache.set(patch, rowsFor(dataset, patch));
      return cache.get(patch);
    };
    return (dataset.patch_notes || []).map((note) => {
      const previous = patches[patches.indexOf(note.version) - 1] || null;
      const before = rows(previous);
      const after = rows(note.version);
      const champions = Object.entries(note.changes).map(([id, changes]) => ({
        id,
        changes,
        verdict: verdict(changes),
        reasons: (note.reasons[id] || []).map(reasonLabel),
        before: before ? before.byId.get(id) || null : null,
        after: after.byId.get(id) || null,
      }));
      const order = { nerf: 0, mixed: 1, buff: 2 };
      champions.sort((a, b) => order[a.verdict] - order[b.verdict] || a.id.localeCompare(b.id));
      return {
        ...note,
        previous,
        gamesBefore: before ? before.games : 0,
        gamesAfter: after.games,
        champions,
      };
    });
  }

  return { build, statLabel, reasonLabel, ruleLabel, verdict, patchList };
})();

if (typeof module !== "undefined") module.exports = PatchNotes;
