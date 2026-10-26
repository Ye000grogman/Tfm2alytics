// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
const Stats = require("../site/stats.js");

const match = (a, b, winner, bansA = [], bansB = [], teams = [1, 2]) => ({
  patch: "2027.0.0", team_a: teams[0], team_b: teams[1],
  picks_a: a, picks_b: b, bans_a: bansA, bans_b: bansB, winner,
});

const matches = [
  match(["x", "y"], ["z", "w"], "a", ["q"], ["q"]),
  match(["x", "z"], ["y", "w"], "b", ["q"], []),
  match(["x", "y"], ["z", "q"], "a", [], ["w"], [3, 1]),
];
const champions = ["x", "y", "z", "w", "q"];

test("whole league counts every pick, ban and win once", () => {
  const sides = Stats.sidesFor(matches, "all", 1);
  const rows = Object.fromEntries(Stats.championTable(sides, "all", champions).map((r) => [r.id, r]));
  assert.strictEqual(rows.x.picks, 3);
  assert.strictEqual(rows.x.wins, 2);
  assert.strictEqual(rows.q.bans, 2); // banned by both teams in match 1 counts once
  assert.strictEqual(rows.q.picks, 1);
  assert.strictEqual(rows.x.pickRate, 1);
  assert.strictEqual(rows.q.presence, 1);
});

test("my team's picks only counts my side", () => {
  const sides = Stats.sidesFor(matches, "mine-side", 1);
  assert.strictEqual(sides.length, 3);
  const rows = Object.fromEntries(Stats.championTable(sides, "mine-side", champions).map((r) => [r.id, r]));
  assert.strictEqual(rows.z.picks, 2); // match 2 as team A, match 3 as team B
  assert.strictEqual(rows.z.wins, 0);
});

test("synergy and counter deltas point the right way", () => {
  const sides = Stats.sidesFor(matches, "all", 1);
  const rows = Stats.championTable(sides, "all", champions);
  const { synergies, counters } = Stats.championDetail(sides, "x", rows);
  const y = synergies.find((s) => s.id === "y");
  assert.deepStrictEqual([y.games, y.winRate], [2, 1]);
  assert.ok(y.delta > 0);
  const w = counters.find((c) => c.id === "w");
  assert.strictEqual(w.games, 2);
});

test("tiers are relative", () => {
  const rows = [...Array(10)].map((_, i) => ({ id: String(i), picks: 100, smoothedWinRate: 0.6 - i * 0.01, presence: 0 }));
  rows.push({ id: "rare", picks: 3, smoothedWinRate: 0.9, presence: 0 });
  Stats.assignTiers(rows, 10);
  assert.deepStrictEqual(rows.map((r) => r.tier).join(""), "SAABBBBCCD–");
});
