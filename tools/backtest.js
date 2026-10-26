// Backtest the draft model with 5-fold cross-validation.
//
//   node tools/backtest.js data/<save>.json
//
// Each match is predicted by a model that never saw it. Champion balance changes
// a lot between patches, so the model is built from the match's own patch (as the
// draft helper does by default) and compared with simpler baselines.

const fs = require("fs");
const Stats = require("../site/stats.js");
const Draft = require("../site/draft.js");

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/backtest.js data/<save>.json");
  process.exit(1);
}
const dataset = JSON.parse(fs.readFileSync(file, "utf8"));
const matches = dataset.matches;
const patches = [...new Set(matches.map((m) => m.patch))];
const FOLDS = 5;

const strengthGap = (model, m) =>
  Draft.teamStrength(model, m.picks_a, m.picks_b) - Draft.teamStrength(model, m.picks_b, m.picks_a);
const withoutPairs = (model) => ({
  ...model,
  synergy: new Float64Array(model.n ** 2),
  counter: new Float64Array(model.n ** 2),
});

const predictors = {
  "team A always wins": () => () => 1,
  "all patches, champion win rates only": (train) => {
    const model = withoutPairs(Draft.buildModel(Stats.sidesFor(train, "all"), dataset.champions));
    return (m) => strengthGap(model, m);
  },
  "same patch, champion win rates only": (train) => {
    const models = perPatch(train, withoutPairs);
    return (m) => strengthGap(models[m.patch], m);
  },
  "same patch, full model (draft helper)": (train) => {
    const models = perPatch(train, (x) => x);
    return (m) => strengthGap(models[m.patch], m);
  },
};

function perPatch(train, transform) {
  const models = {};
  for (const p of patches) {
    models[p] = transform(Draft.buildModel(Stats.sidesFor(train.filter((m) => m.patch === p), "all"), dataset.champions));
  }
  return models;
}

const gaps = Object.fromEntries(Object.keys(predictors).map((k) => [k, []]));
for (let fold = 0; fold < FOLDS; fold++) {
  const train = matches.filter((m) => m.id % FOLDS !== fold);
  const test = matches.filter((m) => m.id % FOLDS === fold);
  for (const [name, make] of Object.entries(predictors)) {
    const predict = make(train);
    for (const m of test) gaps[name].push([predict(m), m.winner === "a"]);
  }
}

console.log(`${matches.length} matches, ${FOLDS}-fold cross-validation\n`);
for (const [name, results] of Object.entries(gaps)) {
  const decided = results.filter(([gap]) => gap !== 0);
  const correct = decided.filter(([gap, aWon]) => gap > 0 === aWon).length;
  console.log(`${(100 * correct / decided.length).toFixed(1).padStart(5)}%  ${name}`);
}

// Fit the logistic scale used for the win chance shown in the helper.
const full = gaps["same patch, full model (draft helper)"];
let best = { scale: 0, loss: Infinity };
for (let scale = 0.05; scale <= 30; scale *= 1.1) {
  let loss = 0;
  for (const [gap, aWon] of full) {
    const p = 1 / (1 + Math.exp(-scale * gap));
    loss -= Math.log(Math.max(1e-9, aWon ? p : 1 - p));
  }
  if (loss < best.loss) best = { scale, loss };
}
console.log(`\nbest win-chance scale: ${best.scale.toFixed(2)} (log loss ${(best.loss / full.length).toFixed(4)}, coin flip 0.6931)`);
