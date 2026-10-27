// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
global.Stats = require("../site/stats.js");
const PatchNotes = require("../site/patch-notes.js");

const match = (patch, a, b, winner) => ({
  patch, team_a: 1, team_b: 2, picks_a: a, picks_b: b, bans_a: [], bans_b: [], winner,
});

const dataset = {
  save: { my_team_id: 1 },
  champions: ["knight", "vampire", "monk"],
  matches: [
    match("2026.0.0", ["knight"], ["vampire"], "b"),
    match("2026.0.0", ["knight"], ["monk"], "b"),
    match("2026.1.0", ["knight"], ["vampire"], "a"),
  ],
  patch_notes: [{
    version: "2026.1.0", date: "2026-05-04", new_champions: [],
    changes: {
      knight: [{ stat: "hp", target: null, before: "900", after: "1080", buff: true }],
      vampire: [
        { stat: "attack", target: null, before: "120", after: "96", buff: false },
        { stat: "cooltime", target: "skill2", before: "8.0", after: "7.7", buff: true },
      ],
    },
    reasons: { knight: ["unpicked_long"], vampire: ["nerf_meta_2"] },
    game_rules: [], game_rule_reasons: [],
  }],
};

test("compares each changed champion with the patch before", () => {
  const [note] = PatchNotes.build(dataset);
  assert.strictEqual(note.previous, "2026.0.0");
  assert.strictEqual(note.gamesBefore, 2);
  assert.strictEqual(note.gamesAfter, 1);
  const knight = note.champions.find((c) => c.id === "knight");
  assert.strictEqual(knight.verdict, "buff");
  assert.strictEqual(knight.before.winRate, 0);
  assert.strictEqual(knight.after.winRate, 1);
  assert.deepStrictEqual(knight.reasons, [{ text: "Not picked for a long time", level: null }]);
  assert.strictEqual(note.champions.find((c) => c.id === "vampire").verdict, "mixed");
});

test("labels read like patch notes", () => {
  assert.strictEqual(PatchNotes.statLabel({ stat: "cooltime", target: "skill2" }), "Skill 2 · Cooldown");
  assert.strictEqual(PatchNotes.statLabel({ stat: "growth_hp", target: null }), "HP per level");
  assert.deepStrictEqual(PatchNotes.reasonLabel("too_much_damage_3"), { text: "Too much damage", level: 3 });
});
