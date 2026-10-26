// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
const Stats = require("../site/stats.js");
const Draft = require("../site/draft.js");

const champions = ["strong", "weak", "buddy", "pal", "x", "y"];
const match = (a, b, winner) => ({ patch: "1", team_a: 1, team_b: 2, picks_a: a, picks_b: b, bans_a: [], bans_b: [], winner });

// "strong" wins a lot, and wins even more next to "buddy".
const matches = [];
for (let i = 0; i < 40; i++) matches.push(match(["strong", "buddy"], ["weak", "x"], "a"));
for (let i = 0; i < 40; i++) matches.push(match(["strong", "pal"], ["weak", "y"], i % 2 ? "a" : "b"));
for (let i = 0; i < 40; i++) matches.push(match(["weak", "pal"], ["x", "y"], "b"));

const model = Draft.buildModel(Stats.sidesFor(matches, "all"), champions);
const empty = { myPicks: [], myBans: [], enemyPicks: [], enemyBans: [] };

test("stronger champions score higher", () => {
  const score = (c) => Draft.pickScore(model, c, [], []).score;
  assert.ok(score("strong") > score("pal"));
  assert.ok(score("pal") > score("weak"));
});

test("taken champions are never suggested", () => {
  const draft = { ...empty, enemyBans: ["strong"], myPicks: ["buddy"] };
  const names = Draft.suggest(model, draft, "pick", 10).map((r) => r.champion);
  assert.ok(!names.includes("strong") && !names.includes("buddy"));
});

test("synergy lifts a partner's score", () => {
  const withBuddy = Draft.pickScore(model, "strong", ["buddy"], []).score;
  const withPal = Draft.pickScore(model, "strong", ["pal"], []).score;
  assert.ok(withBuddy > withPal);
});

test("bans target what is best for the enemy", () => {
  const banScore = (draft) => Draft.suggest(model, draft, "ban", 10).find((r) => r.champion === "strong").score;
  // "strong" is a better ban once the enemy already has its best partner.
  assert.ok(banScore({ ...empty, enemyPicks: ["buddy"] }) > banScore(empty));
});

test("win chance favours the stronger team and is symmetric", () => {
  const p = Draft.winChance(model, ["strong", "buddy"], ["weak", "x"]);
  const q = Draft.winChance(model, ["weak", "x"], ["strong", "buddy"]);
  assert.ok(p > 0.5);
  assert.ok(Math.abs(p + q - 1) < 1e-9);
});
