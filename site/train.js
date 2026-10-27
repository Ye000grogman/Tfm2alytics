// Trained draft model (Phase 5). Pure functions, no DOM: runs in the page, in a
// web worker and in Node (tools/train.js, tests).
//
// The model is a logistic regression: P(team A wins) = logistic(sum of weights of
// the draft's features), each feature counted +1 for team A and -1 for team B.
// Feature groups:
//   champ      a champion's overall strength
//   step       how a champion's strength moved at a patch; it carries over to later
//              patches, so a new patch with few games starts from the last one
//   notes      the game's patch notes: +1 per buff, -1 per nerf, summed up to the patch
//   pair       two champions on the same team (synergy)
//   vs         one champion facing another (counter)
//   comp       team composition from champion tags: lacking magic damage, no CC, ...
//   team       team strength per year. Only used in training, so strong teams don't
//              make their champions look better than they are; never in suggestions.
// Every group has its own L2 penalty, which pulls weights with few games toward 0.

const Train = (() => {
  const PENALTY = { champ: 5, step: 10, notes: 1, pair: 500, vs: 500, comp: 30, team: 5 };
  const ROUNDS = 60;
  const DAMPING = 0.3; // how much of a row's other features to assume move with each step
  const HALF_LIFE_PATCHES = 4; // older patches count less
  const HOLDOUT = 0.15; // newest games kept aside to test on
  const DRAFT_GROUPS = ["champ", "step", "notes", "pair", "vs", "comp"];

  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const groupOf = (name) => name.slice(0, name.indexOf(":"));

  // Composition features for one team, from the champion tags. A partial team
  // counts in proportion to how many picks it has, so "no magic damage" after one
  // pick is a hint, not a verdict.
  function compFeatures(team, enemies, tags) {
    if (!team.length) return [];
    const count = (list) => {
      const n = { magic: 0, physical: 0, cc: 0, front: 0, sustain: 0, ranged: 0, antiHeal: 0, shred: 0, buffer: 0, cdr: 0, antiProjectile: 0, ccImmunity: 0, healing: 0 };
      for (const c of list) {
        const t = tags[c];
        if (!t) continue;
        if (t.damage === "magic") n.magic++;
        else if (t.damage === "mixed") { n.magic += 0.5; n.physical += 0.5; }
        else n.physical++;
        if (t.tags.includes("strong_cc")) n.cc += 1.5;
        else if (t.tags.includes("cc")) n.cc++;
        else if (t.tags.includes("light_cc")) n.cc += 0.5;
        if (t.tags.includes("frontline")) n.front++;
        if (t.tags.includes("healing") || t.tags.includes("shield")) n.sustain++;
        // Healing the enemy's anti-heal can cut: team healing counts fully, self-healing half.
        if (t.tags.includes("healing")) n.healing++;
        else if (t.tags.includes("self_heal")) n.healing += 0.5;
        if (t.tags.includes("anti_heal")) n.antiHeal++;
        if (t.tags.includes("shred")) n.shred++;
        if (t.tags.includes("buffer")) n.buffer++;
        if (t.tags.includes("cdr")) n.cdr++;
        if (t.tags.includes("anti_projectile")) n.antiProjectile++;
        if (t.tags.includes("cc_immunity")) n.ccImmunity++;
        if (t.range === "ranged") n.ranged++;
      }
      return n;
    };
    const { magic, physical, cc, front, sustain, ranged, antiHeal, shred, buffer, cdr, antiProjectile, ccImmunity } = count(team);
    const foe = count(enemies);
    const share = team.length / 5;
    const out = [];
    const on = (name, cond) => cond && out.push([`comp:${name}`, share]);
    on("no_magic", magic < 1);
    on("mostly_magic", magic >= 4);
    on("no_physical", physical < 1);
    on("no_cc", cc < 0.5);
    on("much_cc", cc >= 3);
    on("no_frontline", front === 0);
    on("two_frontline", front >= 2);
    on("no_sustain", sustain === 0);
    on("few_ranged", ranged <= 1);
    on("mostly_ranged", ranged >= 4);
    on("no_anti_heal_vs_sustain", antiHeal === 0 && foe.healing >= 2);
    on("no_shred_vs_frontline", shred === 0 && foe.front >= 2);
    on("buffer_with_cdr", buffer > 0 && cdr > 0);
    on("anti_projectile_vs_ranged", antiProjectile > 0 && foe.ranged >= 3);
    on("cc_immunity_vs_cc", ccImmunity > 0 && foe.cc >= 3);
    return out;
  }

  // Patch context: which patches come before which, and the patch-note score of
  // each champion up to each patch.
  function patchContext(dataset) {
    const versions = new Set(dataset.matches.map((m) => m.patch));
    for (const n of dataset.patch_notes || []) versions.add(n.version);
    const patches = [...versions].sort(Stats.comparePatch);
    const notesAt = new Map(); // patch -> Map(champion -> cumulative buff/nerf score)
    const running = new Map();
    const byVersion = new Map((dataset.patch_notes || []).map((n) => [n.version, n]));
    for (const p of patches) {
      const note = byVersion.get(p);
      if (note) {
        for (const [c, changes] of Object.entries(note.changes)) {
          const buffs = changes.filter((x) => x.buff).length;
          running.set(c, (running.get(c) || 0) + (buffs - (changes.length - buffs)) / changes.length);
        }
      }
      notesAt.set(p, new Map(running));
    }
    return { patches, notesAt };
  }

  // Features of one team (positive side), as [name, value] pairs.
  function teamFeatures(team, enemies, patch, ctx, tags) {
    const out = [];
    const upTo = ctx.patches.slice(0, ctx.patches.indexOf(patch) + 1);
    const notes = ctx.notesAt.get(patch) || new Map();
    for (const c of team) {
      out.push([`champ:${c}`, 1]);
      for (const p of upTo.slice(1)) out.push([`step:${c}@${p}`, 1]);
      if (notes.get(c)) out.push(["notes:score", notes.get(c)]);
      for (const d of team) if (c < d) out.push([`pair:${c}+${d}`, 1]);
      for (const d of enemies) out.push(c < d ? [`vs:${c}>${d}`, 1] : [`vs:${d}>${c}`, -1]);
    }
    // Each matchup was added from both sides; halve so it counts once overall.
    for (const f of out) if (f[0].startsWith("vs:")) f[1] /= 2;
    return out.concat(compFeatures(team, enemies, tags));
  }

  // One match as a sparse row: team A's features minus team B's.
  function matchRow(m, ctx, tags, withTeams) {
    const sum = new Map();
    const add = (list, sign) => {
      for (const [k, v] of list) sum.set(k, (sum.get(k) || 0) + sign * v);
    };
    add(teamFeatures(m.picks_a, m.picks_b, m.patch, ctx, tags), 1);
    add(teamFeatures(m.picks_b, m.picks_a, m.patch, ctx, tags), -1);
    if (withTeams) {
      const year = m.patch.split(".")[0];
      add([[`team:${m.team_a}@${year}`, 1]], 1);
      add([[`team:${m.team_b}@${year}`, 1]], -1);
    }
    for (const [k, v] of sum) if (Math.abs(v) < 1e-9) sum.delete(k);
    return sum;
  }

  // Logistic regression with a separate L2 penalty per group, fitted on all games
  // at once. Each round moves every weight by its gradient divided by its curvature
  // (a damped diagonal Newton step), which converges in a few dozen rounds.
  function fit(rows, labels, sampleWeights, onProgress, opts = {}) {
    const pen = { ...PENALTY, ...(opts.penalty || {}) };
    const rounds = opts.rounds || ROUNDS;
    const names = new Map();
    const encoded = rows.map((row) => {
      const idx = new Int32Array(row.size);
      const val = new Float64Array(row.size);
      let i = 0;
      for (const [k, v] of row) {
        if (!names.has(k)) names.set(k, names.size);
        idx[i] = names.get(k);
        val[i++] = v;
      }
      return [idx, val];
    });
    const n = names.size;
    const w = new Float64Array(n);
    const penalty = new Float64Array(n);
    for (const [k, i] of names) penalty[i] = pen[groupOf(k)];
    const grad = new Float64Array(n);
    const curve = new Float64Array(n);
    let bias = 0;

    for (let round = 0; round < rounds; round++) {
      for (let f = 0; f < n; f++) {
        grad[f] = penalty[f] * w[f];
        curve[f] = penalty[f];
      }
      let biasGrad = 0, biasCurve = 1e-9;
      for (let r = 0; r < encoded.length; r++) {
        const [idx, val] = encoded[r];
        let z = bias;
        for (let k = 0; k < idx.length; k++) z += w[idx[k]] * val[k];
        const p = sigmoid(z);
        const s = sampleWeights[r];
        const err = (p - labels[r]) * s;
        const h = Math.max(p * (1 - p), 0.01) * s;
        biasGrad += err;
        biasCurve += h;
        for (let k = 0; k < idx.length; k++) {
          grad[idx[k]] += err * val[k];
          // Rows share weights, so a full step would overshoot: count each
          // feature's curvature as if the row's other features moved too.
          curve[idx[k]] += h * val[k] * val[k] * idx.length * DAMPING;
        }
      }
      bias -= biasGrad / biasCurve;
      for (let f = 0; f < n; f++) w[f] -= grad[f] / curve[f];
      if (onProgress) onProgress((round + 1) / rounds);
    }
    const weights = {};
    for (const [k, i] of names) if (Math.abs(w[i]) > 1e-5) weights[k] = Number(w[i].toFixed(5));
    return { weights, bias };
  }

  function sampleWeight(m, ctx) {
    const age = ctx.patches.length - 1 - ctx.patches.indexOf(m.patch);
    return Math.pow(0.5, age / HALF_LIFE_PATCHES);
  }

  // Logit for team A from a weight table, using only the given groups.
  function logit(weights, row, groups) {
    let z = 0;
    for (const [k, v] of row) if (groups.includes(groupOf(k))) z += (weights[k] || 0) * v;
    return z;
  }

  // Train on the older games, test on the newest ones, then train again on everything.
  function train(dataset, tags, onProgress = () => {}, opts = {}) {
    const ctx = patchContext(dataset);
    const matches = [...dataset.matches].sort((a, b) => a.id - b.id);
    const split = Math.floor(matches.length * (1 - HOLDOUT));
    const rows = matches.map((m) => matchRow(m, ctx, tags, opts.teams !== false));
    const labels = matches.map((m) => (m.winner === "a" ? 1 : 0));
    const weights = matches.map((m) => sampleWeight(m, ctx));

    const test = fit(rows.slice(0, split), labels.slice(0, split), weights.slice(0, split), (p) => onProgress(p / 2), opts);
    if (opts.testOnly) return { report: null, test, rows, labels, split, matches };
    const held = matches.slice(split);
    const score = (groups) => {
      let correct = 0, loss = 0;
      held.forEach((m, i) => {
        const p = sigmoid(logit(test.weights, rows[split + i], groups));
        const won = labels[split + i];
        if ((p > 0.5) === (won === 1)) correct++;
        loss -= Math.log(Math.max(1e-9, won ? p : 1 - p));
      });
      return { accuracy: correct / held.length, logLoss: loss / held.length };
    };
    const report = {
      trainGames: split,
      testGames: held.length,
      testFrom: held.length ? held[0].patch : null,
      draftOnly: score(DRAFT_GROUPS),
      withTeams: score([...DRAFT_GROUPS, "team"]),
      baseline: baselineAccuracy(matches.slice(0, split), held),
    };

    const full = fit(rows, labels, weights, (p) => onProgress(0.5 + p / 2), opts);
    const draftWeights = Object.fromEntries(Object.entries(full.weights).filter(([k]) => groupOf(k) !== "team"));
    return {
      version: 1,
      trainedAt: Date.now() / 1000,
      games: matches.length,
      lastMatchId: matches.length ? matches[matches.length - 1].id : null,
      patches: ctx.patches,
      notesAt: Object.fromEntries([...ctx.notesAt].map(([p, m]) => [p, Object.fromEntries(m)])),
      tags,
      weights: draftWeights,
      report,
    };
  }

  // The v0 helper (same-patch stats) on the same test games, for comparison.
  function baselineAccuracy(trainMatches, testMatches) {
    if (typeof Draft === "undefined" || !testMatches.length) return null;
    const models = new Map();
    let correct = 0;
    for (const m of testMatches) {
      if (!models.has(m.patch)) {
        const same = trainMatches.filter((x) => x.patch === m.patch);
        const champions = [...new Set(trainMatches.flatMap((x) => [...x.picks_a, ...x.picks_b]).concat(m.picks_a, m.picks_b))];
        models.set(m.patch, Draft.buildModel(Stats.sidesFor(same, "all"), champions));
      }
      const model = models.get(m.patch);
      const gap = Draft.teamStrength(model, m.picks_a, m.picks_b) - Draft.teamStrength(model, m.picks_b, m.picks_a);
      // No games on this patch yet means no opinion: count it as a coin flip.
      if (gap === 0) correct += 0.5;
      else if ((gap > 0) === (m.winner === "a")) correct++;
    }
    return correct / testMatches.length;
  }

  // ---- Using a trained model in the draft helper ----

  function contextOf(model) {
    if (!model._ctx) {
      model._ctx = {
        patches: model.patches,
        notesAt: new Map(Object.entries(model.notesAt).map(([p, m]) => [p, new Map(Object.entries(m))])),
      };
    }
    return model._ctx;
  }

  // Champion strength (champ + steps) is only known relative to other champions,
  // since every game has five picks a side. Centre it on the patch's average so a
  // half-finished draft is judged fairly.
  function meanStrength(model, patch) {
    model._mean = model._mean || {};
    if (!(patch in model._mean)) {
      const ctx = contextOf(model);
      const upTo = ctx.patches.slice(1, ctx.patches.indexOf(patch) + 1);
      const champs = Object.keys(model.tags).filter((c) => model.weights[`champ:${c}`] !== undefined);
      let total = 0;
      for (const c of champs) {
        total += model.weights[`champ:${c}`] || 0;
        for (const p of upTo) total += model.weights[`step:${c}@${p}`] || 0;
      }
      model._mean[patch] = champs.length ? total / champs.length : 0;
    }
    return model._mean[patch];
  }

  // The newest patch the model knows, if the asked one is unknown.
  function knownPatch(model, patch) {
    return model.patches.includes(patch) ? patch : model.patches[model.patches.length - 1];
  }

  // Win chance for `mine` against `theirs` on a patch, from the draft alone.
  function winChance(model, mine, theirs, patch) {
    const ctx = contextOf(model);
    const p = knownPatch(model, patch);
    const row = matchRow({ picks_a: mine, picks_b: theirs, patch: p }, ctx, model.tags, false);
    return sigmoid(logit(model.weights, row, DRAFT_GROUPS) - meanStrength(model, p) * (mine.length - theirs.length));
  }

  // What adding champion c to `mine` is worth, split into reasons. Values are in
  // win chance (percentage points) at the current draft.
  function pickValue(model, c, mine, theirs, patch) {
    const ctx = contextOf(model);
    const p = knownPatch(model, patch);
    const before = teamFeatures(mine, theirs, p, ctx, model.tags);
    const after = teamFeatures([...mine, c], theirs, p, ctx, model.tags);
    const w = model.weights;
    const sum = (list) => {
      const m = new Map();
      for (const [k, v] of list) m.set(k, (m.get(k) || 0) + v);
      return m;
    };
    const a = sum(after);
    const b = sum(before);
    // Matchups also change the enemy's side, which counts against us.
    const theirsBefore = sum(teamFeatures(theirs, mine, p, ctx, model.tags).filter(([k]) => k.startsWith("vs:")));
    const theirsAfter = sum(teamFeatures(theirs, [...mine, c], p, ctx, model.tags).filter(([k]) => k.startsWith("vs:")));
    const delta = new Map();
    for (const k of new Set([...a.keys(), ...b.keys()])) delta.set(k, (a.get(k) || 0) - (b.get(k) || 0));
    for (const k of new Set([...theirsAfter.keys(), ...theirsBefore.keys()])) {
      delta.set(k, (delta.get(k) || 0) - ((theirsAfter.get(k) || 0) - (theirsBefore.get(k) || 0)));
    }

    const z0 =
      logit(w, matchRow({ picks_a: mine, picks_b: theirs, patch: p }, ctx, model.tags, false), DRAFT_GROUPS) -
      meanStrength(model, p) * (mine.length - theirs.length);
    const slope = sigmoid(z0) * (1 - sigmoid(z0)); // turns logit changes into win-chance changes
    const parts = [];
    let strength = 0;
    for (const [k, v] of delta) {
      const value = (w[k] || 0) * v;
      if (!value) continue;
      const g = groupOf(k);
      if (g === "champ" || g === "step") strength += value;
      else if (g === "notes") parts.push({ kind: "notes", value: value * slope });
      else if (g === "pair") parts.push({ kind: "ally", with: other(k.slice(5).split("+"), c), value: value * slope });
      else if (g === "vs") parts.push({ kind: "enemy", with: other(k.slice(3).split(">"), c), value: value * slope });
      else if (g === "comp") {
        const was = b.get(k) || 0;
        const now = a.get(k) || 0;
        parts.push({ kind: "comp", what: k.slice(5), value: value * slope, change: !now ? "fixes" : !was ? "causes" : "keeps" });
      }
    }
    parts.unshift({ kind: "base", value: (strength - meanStrength(model, p)) * slope });
    const total = parts.reduce((t, x) => t + x.value, 0);
    return { champion: c, score: total, parts };
  }

  const other = (pair, c) => (pair[0] === c ? pair[1] : pair[0]);
  const c0 = (result) => result.champion;
  const HABIT_WEIGHT = 0.04; // a champion they always pick counts like +4% win chance

  // Suggestions for the side to act, with one turn of look-ahead: when the enemy
  // picks next, each candidate is judged after the enemy's best answer to it.
  // `tendencies` (optional) is the opponent's pick share per champion.
  //
  // `habits` (optional) is the side's own pick share per champion: when the enemy
  // is the one acting, their favourites rank higher. `enemyHabits` is the other
  // side's pick share: bans lean toward what they like to play.
  function suggest(model, draft, action, opts = {}) {
    const { patch, champions, enemyPicksNext = false, habits = null, enemyHabits = null, limit = 10 } = opts;
    const taken = new Set([...draft.myPicks, ...draft.myBans, ...draft.enemyPicks, ...draft.enemyBans]);
    const open = (champions || Object.keys(model.tags)).filter((c) => !taken.has(c));
    const share = (table, c) => (table ? table[c] || 0 : 0);
    const withHabit = (result, table, who) => {
      const s = share(table, c0(result));
      if (!s) return result;
      const value = HABIT_WEIGHT * s;
      return { ...result, score: result.score + value, parts: [...result.parts, { kind: "habit", who, share: s, value }] };
    };

    if (action === "ban") {
      return open
        .map((c) => withHabit(pickValue(model, c, draft.enemyPicks, draft.myPicks, patch), enemyHabits, "enemy"))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    let scored = open.map((c) => withHabit(pickValue(model, c, draft.myPicks, draft.enemyPicks, patch), habits, "self"));
    scored.sort((a, b) => b.score - a.score);
    if (!enemyPicksNext) return scored.slice(0, limit);

    const now = winChance(model, draft.myPicks, draft.enemyPicks, patch);
    const shortlist = scored.slice(0, 20);
    for (const s of shortlist) {
      const mine = [...draft.myPicks, s.champion];
      let best = null;
      for (const r of open) {
        if (r === s.champion) continue;
        const theirs = [...draft.enemyPicks, r];
        const chance = winChance(model, mine, theirs, patch) - HABIT_WEIGHT * share(enemyHabits, r);
        if (!best || chance < best.chance) best = { champion: r, chance };
      }
      if (best) {
        const own = s.parts.filter((x) => x.kind === "habit").reduce((t, x) => t + x.value, 0);
        s.answer = { champion: best.champion, chance: winChance(model, mine, [...draft.enemyPicks, best.champion], patch) };
        s.score = best.chance - now + own;
      }
    }
    shortlist.sort((a, b) => b.score - a.score);
    return shortlist.slice(0, limit);
  }

  return {
    train, winChance, pickValue, suggest, compFeatures, matchRow, patchContext, teamFeatures,
    PENALTY, DRAFT_GROUPS,
  };
})();

if (typeof module !== "undefined") module.exports = Train;
