// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
global.Stats = require("../site/stats.js");
global.Draft = require("../site/draft.js");
const Train = require("../site/train.js");

const champs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
const tags = Object.fromEntries(champs.map((c) => [c, { damage: "physical", range: "melee", tags: [] }]));
tags.k = { damage: "magic", range: "ranged", tags: ["cc"] };

// "a" wins every game it plays; the rest is a coin flip decided by game number.
function dataset() {
  const matches = [];
  for (let id = 0; id < 400; id++) {
    const pool = [...champs].sort(() => 0); // fixed order
    const rot = id % champs.length;
    const order = pool.slice(rot).concat(pool.slice(0, rot));
    const picks_a = order.slice(0, 5);
    const picks_b = order.slice(5, 10);
    let winner = id % 2 ? "a" : "b";
    if (picks_a.includes("a")) winner = "a";
    if (picks_b.includes("a")) winner = "b";
    matches.push({ id, patch: id < 200 ? "2026.0.0" : "2026.1.0", team_a: 1, team_b: 2, picks_a, picks_b, bans_a: [], bans_b: [], winner });
  }
  return { save: { my_team_id: 1 }, champions: champs, matches, patch_notes: [] };
}

test("training learns the champion that always wins and tests on newer games", () => {
  const model = Train.train(dataset(), tags);
  assert.ok(model.weights["champ:a"] > 0.3);
  assert.strictEqual(model.report.testGames, 60);
  assert.ok(model.report.draftOnly.accuracy > 0.6);
  assert.ok(!Object.keys(model.weights).some((k) => k.startsWith("team:")), "team strength stays out of the saved model");
  assert.ok(Train.winChance(model, ["a", "b"], ["c", "d"], "2026.1.0") > 0.6);
});

test("suggestions rank the strong champion first and explain it", () => {
  const model = Train.train(dataset(), tags);
  const draft = { myPicks: ["b"], myBans: [], enemyPicks: ["c"], enemyBans: [] };
  const [first] = Train.suggest(model, draft, "pick", { patch: "2026.1.0", enemyPicksNext: true });
  assert.strictEqual(first.champion, "a");
  assert.strictEqual(first.parts[0].kind, "base");
  assert.ok(first.answer && first.answer.champion !== "a");
  const [ban] = Train.suggest(model, draft, "ban", { patch: "2026.1.0" });
  assert.strictEqual(ban.champion, "a");
});

test("team composition checks scale with how full the team is", () => {
  const two = Train.compFeatures(["a", "b"], [], tags);
  assert.deepStrictEqual(two.find(([k]) => k === "comp:no_magic"), ["comp:no_magic", 0.4]);
  const withMage = Train.compFeatures(["a", "k"], [], tags).map(([k]) => k);
  assert.ok(!withMage.includes("comp:no_magic") && !withMage.includes("comp:no_cc"));
});
