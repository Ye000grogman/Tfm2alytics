// Draft helper model (v0, stat scoring). Pure functions, no DOM.
//
// Everything is built from three tables computed over the matches in view:
//   base[c]       how much champion c wins above 50% (smoothed)
//   synergy[c][d] how much better c does with ally d than expected
//   counter[c][d] how much c's win rate shifts when facing enemy d
// A pick is scored as base + synergy with your picks + counter vs their picks.
// A ban is scored as how good that champion would be for the enemy.

const Draft = (() => {
  const CHAMPION_PRIOR_GAMES = 20;
  const PAIR_PRIOR_GAMES = 30; // heavier than the stats page: backtests showed pairs need it
  const smooth = (wins, games, prior, weight) => (wins + prior * weight) / (games + weight);

  function buildModel(sides, champions) {
    const index = new Map(champions.map((c, i) => [c, i]));
    const n = champions.length;
    const picks = new Float64Array(n);
    const wins = new Float64Array(n);
    const bans = new Float64Array(n);
    const allyGames = new Float64Array(n * n);
    const allyWins = new Float64Array(n * n);
    const enemyGames = new Float64Array(n * n);
    const enemyWins = new Float64Array(n * n);

    for (const s of sides) {
      const mine = s.picks.map((c) => index.get(c));
      const theirs = s.enemyPicks.map((c) => index.get(c));
      for (const c of s.bans) bans[index.get(c)]++;
      for (const i of mine) {
        picks[i]++;
        if (s.won) wins[i]++;
        for (const j of mine) {
          if (i === j) continue;
          allyGames[i * n + j]++;
          if (s.won) allyWins[i * n + j]++;
        }
        for (const j of theirs) {
          enemyGames[i * n + j]++;
          if (s.won) enemyWins[i * n + j]++;
        }
      }
    }

    const drafts = sides.length / 2 || 1;
    const winRate = Array.from(picks, (p, i) => smooth(wins[i], p, 0.5, CHAMPION_PRIOR_GAMES));
    const synergy = new Float64Array(n * n);
    const counter = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const k = i * n + j;
        const expected = (winRate[i] + winRate[j]) / 2;
        synergy[k] = smooth(allyWins[k], allyGames[k], expected, PAIR_PRIOR_GAMES) - expected;
        counter[k] = smooth(enemyWins[k], enemyGames[k], winRate[i], PAIR_PRIOR_GAMES) - winRate[i];
      }
    }

    return {
      champions, index, n,
      base: winRate.map((w) => w - 0.5),
      presence: Array.from(picks, (p, i) => Math.min(1, (p + bans[i]) / drafts)),
      games: Array.from(picks),
      synergy, counter, allyGames, enemyGames,
    };
  }

  // Score champion c joining a team that already has `allies`, facing `enemies`.
  function pickScore(model, c, allies, enemies) {
    const { index, n } = model;
    const i = index.get(c);
    const parts = [{ kind: "base", value: model.base[i] }];
    for (const a of allies) {
      const j = index.get(a);
      parts.push({ kind: "ally", with: a, value: model.synergy[i * n + j], games: model.allyGames[i * n + j] });
    }
    for (const e of enemies) {
      const j = index.get(e);
      parts.push({ kind: "enemy", with: e, value: model.counter[i * n + j], games: model.enemyGames[i * n + j] });
    }
    return { champion: c, score: parts.reduce((t, p) => t + p.value, 0), parts };
  }

  // Suggestions for the side to act. `draft` = { myPicks, myBans, enemyPicks, enemyBans }.
  function suggest(model, draft, action, limit = 10) {
    const taken = new Set([...draft.myPicks, ...draft.myBans, ...draft.enemyPicks, ...draft.enemyBans]);
    const open = model.champions.filter((c) => !taken.has(c));
    let scored;
    if (action === "pick") {
      scored = open.map((c) => pickScore(model, c, draft.myPicks, draft.enemyPicks));
    } else {
      // Ban what would be best for them, nudged toward champions they are likely to take.
      scored = open.map((c) => {
        const forThem = pickScore(model, c, draft.enemyPicks, draft.myPicks);
        const presence = model.presence[model.index.get(c)];
        return { ...forThem, score: forThem.score + 0.02 * presence, presence };
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Strength of a finished or partial team against another, counting each pair once.
  function teamStrength(model, team, enemies) {
    const { index, n } = model;
    const ids = team.map((c) => index.get(c));
    const foes = enemies.map((c) => index.get(c));
    let total = 0;
    for (let x = 0; x < ids.length; x++) {
      const i = ids[x];
      total += model.base[i];
      for (let y = x + 1; y < ids.length; y++) total += model.synergy[i * n + ids[y]];
      for (const j of foes) total += (model.counter[i * n + j] - model.counter[j * n + i]) / 2;
    }
    return total;
  }

  // Fitted by tools/backtest.js on the first save: P(win) = logistic(SCALE * strength gap).
  const SCALE = 0.7;
  function winChance(model, mine, theirs, scale = SCALE) {
    const gap = teamStrength(model, mine, theirs) - teamStrength(model, theirs, mine);
    return 1 / (1 + Math.exp(-scale * gap));
  }

  // Explain a suggestion in a few words, biggest effects first.
  function reasons(result, nameOf, max = 3) {
    return result.parts
      .filter((p) => Math.abs(p.value) >= 0.005)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, max)
      .map((p) => {
        const pct = `${p.value >= 0 ? "+" : ""}${(p.value * 100).toFixed(1)}%`;
        if (p.kind === "base") return `${pct} win rate`;
        if (p.kind === "ally") return `${pct} with ${nameOf(p.with)}`;
        return `${pct} vs ${nameOf(p.with)}`;
      });
  }

  return { buildModel, pickScore, suggest, teamStrength, winChance, reasons, SCALE };
})();

if (typeof module !== "undefined") module.exports = Draft;
