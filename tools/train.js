// Train the Phase 5 draft model from the command line and print how it tests.
//
//   node tools/train.js data/<save>.json [--out data/<save>.model.json]
//
// The Train button on the Draft tab does the same thing in the browser.

const fs = require("fs");
const path = require("path");
global.Stats = require("../site/stats.js");
global.Draft = require("../site/draft.js");
const Train = require("../site/train.js");

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/train.js data/<save>.json [--out <model.json>]");
  process.exit(1);
}
const outIndex = process.argv.indexOf("--out");
const dataset = JSON.parse(fs.readFileSync(file, "utf8"));
const tags = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/champion-tags.json"), "utf8"));

const started = Date.now();
const model = Train.train(dataset, tags);
const r = model.report;
const pct = (x) => (x == null ? "–" : `${(100 * x).toFixed(1)}%`);
console.log(`trained on ${model.games} games in ${((Date.now() - started) / 1000).toFixed(1)}s, ${Object.keys(model.weights).length} weights`);
console.log(`test: newest ${r.testGames} games (from patch ${r.testFrom}), model trained on the ${r.trainGames} before them`);
console.log(`  ${pct(r.baseline)}  v0 helper (same-patch stats)`);
console.log(`  ${pct(r.draftOnly.accuracy)}  trained model, draft only (log loss ${r.draftOnly.logLoss.toFixed(4)})`);
console.log(`  ${pct(r.withTeams.accuracy)}  trained model + team strength (log loss ${r.withTeams.logLoss.toFixed(4)})`);
if (outIndex > 0) {
  fs.writeFileSync(process.argv[outIndex + 1], JSON.stringify(model));
  console.log(`wrote ${process.argv[outIndex + 1]}`);
}
