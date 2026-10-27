// Train the Phase 5 draft model from the command line and print how it tests.
//
//   node tools/train.js data/<save>.json [--out data/<save>.model.json] [--extra other.json ...]
//
// --extra also learns from other saves and compares with and without them.
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
const extraIndex = process.argv.indexOf("--extra");
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const dataset = read(file);
const extra = extraIndex > 0 ? process.argv.slice(extraIndex + 1).filter((f) => !f.startsWith("--")).map(read) : [];
const tags = JSON.parse(fs.readFileSync(path.join(__dirname, "../site/champion-tags.json"), "utf8"));

const started = Date.now();
const model = Train.train(dataset, tags, () => {}, { extra });
const r = model.report;
const pct = (x) => (x == null ? "–" : `${(100 * x).toFixed(1)}%`);
console.log(`trained on ${model.games} games in ${((Date.now() - started) / 1000).toFixed(1)}s, ${Object.keys(model.weights).length} weights`);
console.log(`test: newest ${r.testGames} games (from patch ${r.testFrom}), model trained on the ${r.trainGames} before them`);
const line = (name, x) => console.log(`  ${pct(x.accuracy)}  ${name} (log loss ${x.logLoss.toFixed(4)}, Brier ${x.calibration.brier.toFixed(4)})`);
console.log(`  ${pct(r.baseline)}  v0 helper (same-patch stats)`);
line("trained model, draft only", r.draftOnly);
line("trained model + teams, players, side and series", r.withContext);
if (r.extra) {
  console.log(`with ${r.extra.games} games from ${r.extra.saves} other saves; without them:`);
  line("draft only", r.extra.without.draftOnly);
  line("with context", r.extra.without.withContext);
} else if (extra.length) {
  console.log("the other saves had no games that aren't already in this one");
}
console.log("calibration, draft only (favourite's predicted chance -> how often it won):");
for (const b of r.draftOnly.calibration.bins) {
  console.log(`  ${pct(b.from)}-${pct(b.to)}: ${b.games} games, predicted ${pct(b.predicted)}, won ${pct(b.actual)}`);
}
if (outIndex > 0) {
  fs.writeFileSync(process.argv[outIndex + 1], JSON.stringify(model));
  console.log(`wrote ${process.argv[outIndex + 1]}`);
}
