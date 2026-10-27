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

// Ten players with the given gold for team A and team B.
const players = (gold) => Array.from({ length: 5 }, (_, i) => ({ id: i + 1, skills: [50, 50, 50, 50, 50, 50, 50, 50], dealt: gold, taken: 0, healing: 0, gold }));

test("fight shares come from gold and damage, and a game never sees its own result", () => {
  const m = { patch: "2026.0.0", picks_a: ["a"], picks_b: ["b"], players_a: players(300), players_b: players(100), winner: "a" };
  assert.deepStrictEqual(Train.fightShares(m), { gold: 0.25, damage: 0.25 });
  assert.strictEqual(Train.fightShares({ ...m, players_b: [] }), null);

  const data = dataset();
  for (const g of data.matches) {
    const aWon = g.winner === "a";
    g.players_a = players(aWon ? 300 : 100);
    g.players_b = players(aWon ? 100 : 300);
  }
  const model = Train.train(data, tags);
  assert.ok(model.weights["perf:gold"] !== undefined);
  assert.ok(model.perfAt["2026.1.0"].a[0] > 0, "the winning champion has the bigger gold share");
  // Training rows leave the game itself out of the champion's average.
  const ctx = Train.patchContext({ ...data, matches: [m] });
  ctx.perf = Train.perfTable([m], ctx);
  ctx.perfGames = new Set([m]);
  assert.ok(!Train.matchRow(m, ctx, tags, false).has("perf:gold"));
  ctx.perfGames = new Set();
  assert.ok(Train.matchRow(m, ctx, tags, false).get("perf:gold") > 0);
});

test("other saves only add games this save doesn't have, and the report compares", () => {
  const data = dataset();
  const same = Train.train(data, tags, () => {}, { extra: [dataset()] });
  assert.strictEqual(same.report.extra, null, "a copy of the same save adds nothing");

  const other = dataset();
  for (const m of other.matches) {
    m.team_a = 7;
    m.team_b = 8;
  }
  const merged = Train.train(data, tags, () => {}, { extra: [other] });
  assert.strictEqual(merged.report.extra.games, 400);
  assert.ok(merged.report.extra.without.draftOnly.accuracy > 0.6);
  assert.strictEqual(merged.games, 800);
  assert.ok(!Object.keys(merged.weights).some((k) => k.includes("#")), "other saves' patch steps stay out");
});

test("calibration groups games by the favourite's chance", () => {
  const c = Train.calibration([0.9, 0.2, 0.52], [1, 1, 0]);
  assert.strictEqual(c.bins.length, 2);
  const top = c.bins.find((b) => b.from === 0.8);
  assert.strictEqual(top.games, 2);
  assert.strictEqual(top.actual, 0.5);
});
