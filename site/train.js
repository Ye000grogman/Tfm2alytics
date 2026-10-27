// Trained draft model (Phase 5). Pure functions, no DOM: runs in the page, in a
// web worker and in Node (tools/train.js, tests).
//
// The model is a logistic regression: P(team A wins) = logistic(sum of weights of
// the game's features), each feature counted +1 for team A and -1 for team B.
// Draft feature groups (used in suggestions):
//   champ      a champion's overall strength
//   step       how a champion's strength moved at a patch; it carries over to later
//              patches, so a new patch with few games starts from the last one
//   notes      the game's patch notes: +1 per buff, -1 per nerf, summed up to the
//              patch, plus how big the stat changes were (damage, tankiness, cooldowns)
//   perf       fight stats: the team's share of gold and damage in the champion's
//              recent games. Less noisy than wins, so it settles with fewer games.
//   pair       two champions on the same team (synergy)
//   vs         one champion facing another (counter)
//   comp       team composition from champion tags: lacking magic damage, no CC, ...
// Context groups, only used in training, so strong teams and players don't make
// their champions look better than they are; never in suggestions:
//   team       team strength per year
//   player     player strength per year
//   skill      the players' skill ratings at the time of the game
//   side       team A's side advantage
//   series     who won the previous game of the same series
// Every group has its own L2 penalty, which pulls weights with few games toward 0.

const Train = (() => {
  const PENALTY = {
    champ: 5, step: 10, notes: 1, perf: 1, pair: 500, vs: 500, comp: 30,
    team: 10, player: 100, skill: 1, side: 1, series: 1,
  };
  const ROUNDS = 60;
  const DAMPING = 0.3; // how much of a row's other features to assume move with each step
  const HALF_LIFE_PATCHES = 4; // older patches count less
  const HOLDOUT = 0.15; // newest games kept aside to test on
  const DRAFT_GROUPS = ["champ", "step", "notes", "perf", "pair", "vs", "comp"];
  const CONTEXT_GROUPS = ["team", "player", "skill", "side", "series"];
  const PERF_HALF_LIFE = 1; // patches
  const PERF_SMOOTH = 10; // games of weight pulling a champion's fight stats toward average
  const PERF_SCALE = 10;
  // Patch-note stats by what they change. Growth per level counts with its stat.
  const STAT_KIND = {
    attack: "damage", attack_coef: "damage", ap_coef: "damage", magic_power: "damage", attack_speed: "damage",
    hp: "tank", defence: "tank", magic_resistance: "tank",
    cooltime: "cooldown",
  };
  const NOTE_KINDS = ["damage", "tank", "cooldown", "other"];

  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const groupOf = (name) => name.slice(0, name.indexOf(":"));

  // Composition features for one team, from the champion tags. A partial team
  // counts in proportion to how many picks it has, so "no magic damage" after one
  // pick is a hint, not a verdict.
  function compFeatures(team, enemies, tags) {
    if (!team.length) return [];
    const count = (list) => {
      const n = { magic: 0, physical: 0, cc: 0, front: 0, sustain: 0, ranged: 0, antiHeal: 0, shred: 0, buffer: 0, cdr: 0, antiProjectile: 0, ccImmunity: 0, healing: 0, shields: 0, antiShield: 0 };
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
        if (["healing", "shield", "death_prevention"].some((x) => t.tags.includes(x))) n.sustain++;
        // Healing the enemy's anti-heal can cut: team healing counts fully, self-healing half.
        if (t.tags.includes("healing")) n.healing++;
        else if (t.tags.includes("self_heal")) n.healing += 0.5;
        if (t.tags.includes("anti_heal")) n.antiHeal++;
        if (t.tags.includes("shred") || t.tags.includes("percent_hp")) n.shred++;
        if (t.tags.includes("buffer")) n.buffer++;
        if (t.tags.includes("cdr")) n.cdr++;
        if (t.tags.includes("anti_projectile")) n.antiProjectile++;
        if (t.tags.includes("cc_immunity")) n.ccImmunity++;
        if (t.tags.includes("shield")) n.shields++;
        if (t.tags.includes("anti_shield")) n.antiShield++;
        if (t.range === "ranged") n.ranged++;
      }
      return n;
    };
    const { magic, physical, cc, front, sustain, ranged, antiHeal, shred, buffer, cdr, antiProjectile, ccImmunity, antiShield } = count(team);
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
    on("no_anti_shield_vs_shields", antiShield === 0 && foe.shields >= 2);
    return out;
  }

  // How big one patch-note change is: the log of after/before, positive for a buff.
  function changeSize(change) {
    const before = parseFloat(change.before);
    const after = parseFloat(change.after);
    if (!(before > 0) || !(after > 0)) return 0;
    const size = Math.min(1, Math.abs(Math.log(after / before)));
    return change.buff ? size : -size;
  }

  const statKind = (stat) => STAT_KIND[stat.replace(/^growth_/, "")] || "other";

  // Patch context: which patches come before which, and each champion's patch
  // notes up to each patch: the buff/nerf score and the summed size per kind.
  function patchContext(dataset) {
    const versions = new Set(dataset.matches.map((m) => m.patch));
    for (const n of dataset.patch_notes || []) versions.add(n.version);
    const patches = [...versions].sort(Stats.comparePatch);
    const notesAt = new Map(); // patch -> Map(champion -> { score, damage, tank, cooldown, other })
    const running = new Map();
    const byVersion = new Map((dataset.patch_notes || []).map((n) => [n.version, n]));
    for (const p of patches) {
      const note = byVersion.get(p);
      if (note) {
        for (const [c, changes] of Object.entries(note.changes)) {
          const now = { ...(running.get(c) || { score: 0, damage: 0, tank: 0, cooldown: 0, other: 0 }) };
          const buffs = changes.filter((x) => x.buff).length;
          now.score += (buffs - (changes.length - buffs)) / changes.length;
          for (const ch of changes) now[statKind(ch.stat)] += changeSize(ch);
          running.set(c, now);
        }
      }
      notesAt.set(p, new Map([...running].map(([c, v]) => [c, { ...v }])));
    }
    return { patches, notesAt, index: new Map(patches.map((p, i) => [p, i])), ns: "" };
  }

  // A game's gold and damage split: team A's share minus a half (negative when B
  // got more). Null when the save didn't have every player's stats.
  function fightShares(m) {
    if (!m.players_a || m.players_a.length !== 5 || !m.players_b || m.players_b.length !== 5) return null;
    const total = (list, key) => list.reduce((t, p) => t + p[key], 0);
    const share = (key) => {
      const a = total(m.players_a, key);
      const b = total(m.players_b, key);
      return a + b > 0 ? a / (a + b) - 0.5 : 0;
    };
    return { gold: share("gold"), damage: share("dealt") };
  }

  // Each champion's fight stats per patch, from the given games: recent patches
  // count more, and a champion with few games is pulled toward average.
  function perfTable(matches, ctx) {
    const per = ctx.patches.map(() => new Map()); // patch index -> champion -> sums
    const add = (i, c, gold, damage) => {
      const t = per[i].get(c) || { gold: 0, damage: 0, n: 0 };
      t.gold += gold;
      t.damage += damage;
      t.n += 1;
      per[i].set(c, t);
    };
    for (const m of matches) {
      const s = fightShares(m);
      if (!s) continue;
      const i = ctx.index.get(m.patch);
      for (const c of m.picks_a) add(i, c, s.gold, s.damage);
      for (const c of m.picks_b) add(i, c, -s.gold, -s.damage);
    }
    const decay = Math.pow(0.5, 1 / PERF_HALF_LIFE);
    const at = [];
    let running = new Map();
    for (let i = 0; i < ctx.patches.length; i++) {
      const next = new Map();
      for (const [c, t] of running) next.set(c, { gold: t.gold * decay, damage: t.damage * decay, n: t.n * decay });
      for (const [c, t] of per[i]) {
        const r = next.get(c) || { gold: 0, damage: 0, n: 0 };
        next.set(c, { gold: r.gold + t.gold, damage: r.damage + t.damage, n: r.n + t.n });
      }
      at.push(next);
      running = next;
    }
    return at;
  }

  // A champion's fight-stat features on a patch. `own` takes the game being
  // trained on out of its own average, so the model can't peek at the result.
  function perfFeatures(table, ctx, c, patch, own) {
    const t = table && table[ctx.index.get(patch)] && table[ctx.index.get(patch)].get(c);
    if (!t) return [];
    let { gold, damage, n } = t;
    if (own) {
      gold -= own.gold;
      damage -= own.damage;
      n -= 1;
    }
    const k = PERF_SCALE / (Math.max(0, n) + PERF_SMOOTH);
    return [["perf:gold", gold * k], ["perf:damage", damage * k]];
  }

  // Features of one team (positive side), as [name, value] pairs. `own` is the
  // team's fight shares in this game when it's part of the fight-stat table.
  function teamFeatures(team, enemies, patch, ctx, tags, own = null) {
    const out = [];
    const upTo = ctx.patches.slice(0, ctx.index.get(patch) + 1);
    const notes = ctx.notesAt.get(patch) || new Map();
    for (const c of team) {
      out.push([`champ:${c}`, 1]);
      for (const p of upTo.slice(1)) out.push([`step:${c}@${p}${ctx.ns}`, 1]);
      const note = notes.get(c);
      if (note) {
        if (note.score) out.push(["notes:score", note.score]);
        for (const kind of NOTE_KINDS) if (note[kind]) out.push([`notes:${kind}`, note[kind]]);
      }
      out.push(...perfFeatures(ctx.perf, ctx, c, patch, own));
      for (const d of team) if (c < d) out.push([`pair:${c}+${d}`, 1]);
      for (const d of enemies) out.push(c < d ? [`vs:${c}>${d}`, 1] : [`vs:${d}>${c}`, -1]);
    }
    // Each matchup was added from both sides; halve so it counts once overall.
    for (const f of out) if (f[0].startsWith("vs:")) f[1] /= 2;
    return out.concat(compFeatures(team, enemies, tags));
  }

  // Context of a game that the draft can't change: teams, players, side, series.
  function contextFeatures(m, ctx) {
    const year = m.patch.split(".")[0];
    const out = [
      [`team:${m.team_a}@${year}${ctx.ns}`, 1],
      [`team:${m.team_b}@${year}${ctx.ns}`, -1],
      ["side:a", 1],
    ];
    if (m.players_a && m.players_a.length === 5 && m.players_b && m.players_b.length === 5) {
      let skill = 0;
      for (const p of m.players_a) {
        out.push([`player:${p.id}@${year}${ctx.ns}`, 1]);
        skill += p.skills.reduce((t, x) => t + x, 0);
      }
      for (const p of m.players_b) {
        out.push([`player:${p.id}@${year}${ctx.ns}`, -1]);
        skill -= p.skills.reduce((t, x) => t + x, 0);
      }
      out.push(["skill:sum", skill / 100]);
    }
    const prev = ctx.previous && ctx.previous.get(m);
    if (prev) {
      const prevWinner = prev.winner === "a" ? prev.team_a : prev.team_b;
      out.push(["series:prev", prevWinner === m.team_a ? 1 : -1]);
    }
    return out;
  }

  // One match as a sparse row: team A's features minus team B's.
  function matchRow(m, ctx, tags, withContext) {
    const sum = new Map();
    const add = (list, sign) => {
      for (const [k, v] of list) sum.set(k, (sum.get(k) || 0) + sign * v);
    };
    const own = ctx.perfGames && ctx.perfGames.has(m) ? fightShares(m) : null;
    const flip = own && { gold: -own.gold, damage: -own.damage };
    add(teamFeatures(m.picks_a, m.picks_b, m.patch, ctx, tags, own), 1);
    add(teamFeatures(m.picks_b, m.picks_a, m.patch, ctx, tags, flip), -1);
    if (withContext) add(contextFeatures(m, ctx), 1);
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

  // The draft alone explains less than the whole model, so its logit runs too
  // confident when the context is left out. One scale factor fitted on games the
  // model wasn't trained on brings its win chances back in line.
  function fitScale(z, labels) {
    let a = 1;
    for (let round = 0; round < 20; round++) {
      let g = 0, h = 1e-9;
      z.forEach((x, i) => {
        const p = sigmoid(a * x);
        g += (p - labels[i]) * x;
        h += p * (1 - p) * x * x;
      });
      a -= g / h;
    }
    return Math.max(0.1, Math.min(1.5, a));
  }

  function sampleWeight(m, ctx) {
    const age = ctx.patches.length - 1 - ctx.index.get(m.patch);
    return Math.pow(0.5, age / HALF_LIFE_PATCHES);
  }

  // Logit for team A from a weight table, using only the given groups.
  function logit(weights, row, groups) {
    let z = 0;
    for (const [k, v] of row) if (groups.includes(groupOf(k))) z += (weights[k] || 0) * v;
    return z;
  }

  // The game just before in the same series: the previous match id between the
  // same two teams.
  function seriesLinks(matches) {
    const links = new Map();
    for (let i = 1; i < matches.length; i++) {
      const a = matches[i - 1];
      const b = matches[i];
      const same = (a.team_a === b.team_a && a.team_b === b.team_b) || (a.team_a === b.team_b && a.team_b === b.team_a);
      if (same && b.id - a.id === 1) links.set(b, a);
    }
    return links;
  }

  // A game's identity across saves: two saves of the same league share games.
  const gameKey = (m) => `${m.patch}|${m.team_a}|${m.team_b}|${m.picks_a.join(",")}|${m.picks_b.join(",")}`;

  // Prepared training data for one save: its games, patch context and rows.
  function prepare(dataset, ns, skip) {
    const ctx = { ...patchContext(dataset), ns };
    const matches = [...dataset.matches].filter((m) => !skip || !skip.has(gameKey(m))).sort((a, b) => a.id - b.id);
    ctx.previous = seriesLinks(matches);
    return { ctx, matches };
  }

  // Rows for a set of training games and test games, with fight stats taken from
  // the training games only.
  function buildRows(parts, tags) {
    for (const part of parts) {
      part.ctx.perf = perfTable(part.train, part.ctx);
      part.ctx.perfGames = new Set(part.train);
    }
    const rows = [], labels = [], weights = [];
    for (const part of parts) {
      for (const m of part.train) {
        rows.push(matchRow(m, part.ctx, tags, true));
        labels.push(m.winner === "a" ? 1 : 0);
        weights.push(sampleWeight(m, part.ctx));
      }
    }
    return { rows, labels, weights };
  }

  // How well predicted chances match what happened: games grouped by the
  // favourite's predicted chance.
  function calibration(probs, labels) {
    const bins = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1.0001];
    const out = bins.slice(0, -1).map((lo, i) => ({ from: lo, to: Math.min(1, bins[i + 1]), games: 0, predicted: 0, actual: 0 }));
    let brier = 0;
    probs.forEach((p, i) => {
      brier += (p - labels[i]) ** 2;
      const fav = Math.max(p, 1 - p);
      const won = p >= 0.5 ? labels[i] : 1 - labels[i];
      const bin = out.find((b) => fav >= b.from && fav < b.to) || out[out.length - 1];
      bin.games++;
      bin.predicted += fav;
      bin.actual += won;
    });
    for (const b of out) {
      if (b.games) {
        b.predicted /= b.games;
        b.actual /= b.games;
      }
    }
    return { brier: probs.length ? brier / probs.length : null, bins: out.filter((b) => b.games) };
  }

  // Train on the older games, test on the newest ones, then train again on
  // everything. `opts.extra` is a list of other saves' datasets to also learn
  // from: the report then compares with and without them on the same test games.
  function train(dataset, tags, onProgress = () => {}, opts = {}) {
    const main = prepare(dataset, "");
    const split = Math.floor(main.matches.length * (1 - HOLDOUT));
    const held = main.matches.slice(split);
    const seen = new Set(main.matches.map(gameKey));
    const extras = (opts.extra || []).map((d, i) => {
      const part = prepare(d, `#${i + 1}`, seen);
      for (const m of part.matches) seen.add(gameKey(m));
      return part;
    });
    const extraGames = extras.reduce((t, x) => t + x.matches.length, 0);
    const steps = extraGames ? 3 : 2;
    let step = 0;
    const progress = (p) => onProgress((step + p) / steps);

    const test = (withExtras) => {
      const parts = [{ ctx: main.ctx, train: main.matches.slice(0, split) }];
      if (withExtras) for (const x of extras) parts.push({ ctx: x.ctx, train: x.matches });
      const data = buildRows(parts, tags);
      const fitted = fit(data.rows, data.labels, data.weights, progress, opts);
      step++;
      const testRows = held.map((m) => matchRow(m, main.ctx, tags, true));
      const labels = held.map((m) => (m.winner === "a" ? 1 : 0));
      const score = (probs) => {
        let correct = 0, loss = 0;
        probs.forEach((p, i) => {
          if ((p > 0.5) === (labels[i] === 1)) correct++;
          loss -= Math.log(Math.max(1e-9, labels[i] ? p : 1 - p));
        });
        const n = held.length || 1;
        return { accuracy: correct / n, logLoss: loss / n, calibration: calibration(probs, labels) };
      };
      const draftZ = testRows.map((row) => logit(fitted.weights, row, DRAFT_GROUPS));
      const allZ = testRows.map((row) => logit(fitted.weights, row, [...DRAFT_GROUPS, ...CONTEXT_GROUPS]));
      // The draft-only scale is tested fairly: fitted on every other test game,
      // checked on the rest, and the other way round.
      const half = (f) => draftZ.map((z, i) => (i % 2 === f ? null : z));
      const scaleOf = (f) => {
        const keep = half(f).map((z, i) => [z, labels[i]]).filter(([z]) => z !== null);
        return fitScale(keep.map((x) => x[0]), keep.map((x) => x[1]));
      };
      const folds = [scaleOf(0), scaleOf(1)];
      return {
        draftOnly: score(draftZ.map((z, i) => sigmoid(folds[i % 2] * z))),
        withContext: score(allZ.map(sigmoid)),
        scale: fitScale(draftZ, labels),
      };
    };
    if (opts.testOnly) return test(Boolean(extraGames));

    const alone = test(false);
    const merged = extraGames ? test(true) : null;
    const best = merged || alone;
    const report = {
      trainGames: split,
      testGames: held.length,
      testFrom: held.length ? held[0].patch : null,
      draftOnly: best.draftOnly,
      withContext: best.withContext,
      baseline: baselineAccuracy(main.matches.slice(0, split), held),
      extra: extraGames ? { saves: extras.length, games: extraGames, without: alone } : null,
    };

    const parts = [{ ctx: main.ctx, train: main.matches }, ...extras.map((x) => ({ ctx: x.ctx, train: x.matches }))];
    const data = buildRows(parts, tags);
    const full = fit(data.rows, data.labels, data.weights, progress, opts);
    const draftWeights = Object.fromEntries(
      Object.entries(full.weights).filter(([k]) => DRAFT_GROUPS.includes(groupOf(k)) && !k.includes("#")),
    );
    const perfAt = {};
    main.ctx.patches.forEach((p, i) => {
      perfAt[p] = Object.fromEntries([...main.ctx.perf[i]].map(([c, t]) => [c, [t.gold, t.damage, t.n]]));
    });
    return {
      version: 2,
      trainedAt: Date.now() / 1000,
      games: data.rows.length,
      lastMatchId: main.matches.length ? main.matches[main.matches.length - 1].id : null,
      patches: main.ctx.patches,
      notesAt: Object.fromEntries([...main.ctx.notesAt].map(([p, m]) => [p, Object.fromEntries(m)])),
      perfAt,
      tags,
      weights: draftWeights,
      scale: best.scale,
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
      // Version 1 models stored only the buff/nerf score per champion.
      const note = (v) => (typeof v === "number" ? { score: v } : v);
      const perfAt = model.perfAt || {};
      model._ctx = {
        patches: model.patches,
        index: new Map(model.patches.map((p, i) => [p, i])),
        ns: "",
        notesAt: new Map(
          Object.entries(model.notesAt).map(([p, m]) => [p, new Map(Object.entries(m).map(([c, v]) => [c, note(v)]))]),
        ),
        perf: model.patches.map(
          (p) => new Map(Object.entries(perfAt[p] || {}).map(([c, [gold, damage, n]]) => [c, { gold, damage, n }])),
        ),
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
    const z = logit(model.weights, row, DRAFT_GROUPS) - meanStrength(model, p) * (mine.length - theirs.length);
    return sigmoid((model.scale || 1) * z);
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

    const k = model.scale || 1;
    const z0 =
      k *
      (logit(w, matchRow({ picks_a: mine, picks_b: theirs, patch: p }, ctx, model.tags, false), DRAFT_GROUPS) -
        meanStrength(model, p) * (mine.length - theirs.length));
    const slope = k * sigmoid(z0) * (1 - sigmoid(z0)); // turns logit changes into win-chance changes
    const parts = [];
    let strength = 0, notes = 0, perf = 0;
    for (const [k, v] of delta) {
      const value = (w[k] || 0) * v;
      if (!value) continue;
      const g = groupOf(k);
      if (g === "champ" || g === "step") strength += value;
      else if (g === "notes") notes += value;
      else if (g === "perf") perf += value;
      else if (g === "pair") parts.push({ kind: "ally", with: other(k.slice(5).split("+"), c), value: value * slope });
      else if (g === "vs") parts.push({ kind: "enemy", with: other(k.slice(3).split(">"), c), value: value * slope });
      else if (g === "comp") {
        const was = b.get(k) || 0;
        const now = a.get(k) || 0;
        parts.push({ kind: "comp", what: k.slice(5), value: value * slope, change: !now ? "fixes" : !was ? "causes" : "keeps" });
      }
    }
    if (notes) parts.unshift({ kind: "notes", value: notes * slope });
    if (perf) parts.unshift({ kind: "perf", value: perf * slope });
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
    train, winChance, pickValue, suggest, compFeatures, matchRow, patchContext, teamFeatures, fightShares, perfTable,
    calibration, PENALTY, DRAFT_GROUPS, CONTEXT_GROUPS,
  };
})();

if (typeof module !== "undefined") module.exports = Train;
