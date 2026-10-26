// Stats engine: turns a list of matches into champion, synergy and counter tables.
// Pure functions, no DOM, so they can be reused by the draft helper later.

const Stats = (() => {
  const CHAMPION_PRIOR_GAMES = 20; // smoothing weight for a champion's own win rate
  const PAIR_PRIOR_GAMES = 10; // smoothing weight for pairs and matchups

  const smooth = (wins, games, prior, weight) => (wins + prior * weight) / (games + weight);

  // A "side" is one team in one match: its picks, its bans, the enemy picks and whether it won.
  // The scope decides which sides count.
  function sidesFor(matches, scope, myTeam) {
    const sides = [];
    for (const m of matches) {
      const a = {
        team: m.team_a, picks: m.picks_a, bans: m.bans_a,
        enemyPicks: m.picks_b, enemyBans: m.bans_b, won: m.winner === "a",
      };
      const b = {
        team: m.team_b, picks: m.picks_b, bans: m.bans_b,
        enemyPicks: m.picks_a, enemyBans: m.bans_a, won: m.winner === "b",
      };
      const mine = m.team_a === myTeam || m.team_b === myTeam;
      if (scope === "all" || (scope === "mine" && mine)) {
        sides.push(a, b);
      } else if (scope === "mine-side" && mine) {
        sides.push(a.team === myTeam ? a : b);
      } else if (scope === "opponents" && mine) {
        sides.push(a.team === myTeam ? b : a);
      }
    }
    return sides;
  }

  function filterMatches(matches, { patch }) {
    return patch && patch !== "all" ? matches.filter((m) => m.patch === patch) : matches;
  }

  // Number of drafts in view: every match for two-sided scopes, every side otherwise.
  function draftCount(sides, scope) {
    return scope === "all" || scope === "mine" ? sides.length / 2 : sides.length;
  }

  function championTable(sides, scope, champions) {
    const drafts = draftCount(sides, scope);
    const rows = new Map(champions.map((c) => [c, { id: c, picks: 0, wins: 0, bans: 0 }]));
    const twoSided = scope === "all" || scope === "mine";

    for (let i = 0; i < sides.length; i++) {
      const s = sides[i];
      for (const c of s.picks) {
        const r = rows.get(c);
        r.picks++;
        if (s.won) r.wins++;
      }
      // In two-sided scopes, count a champion banned by both teams once per match.
      const banned = twoSided && i % 2 === 1 ? s.bans.filter((c) => !sides[i - 1].bans.includes(c)) : s.bans;
      for (const c of banned) rows.get(c).bans++;
    }

    return [...rows.values()].map((r) => {
      const winRate = r.picks ? r.wins / r.picks : null;
      const presence = drafts ? Math.min(1, (r.picks + r.bans) / drafts) : 0;
      return {
        ...r,
        winRate,
        smoothedWinRate: smooth(r.wins, r.picks, 0.5, CHAMPION_PRIOR_GAMES),
        pickRate: drafts ? r.picks / drafts : 0,
        banRate: drafts ? r.bans / drafts : 0,
        presence,
      };
    });
  }

  // Tier from the smoothed win rate, nudged up a little for contested champions.
  function tierScore(row) {
    return row.smoothedWinRate + 0.02 * row.presence;
  }

  // Tiers are relative, like lolalytics: rank champions with enough games by score,
  // then top 10% S, next 20% A, middle 40% B, next 20% C, bottom 10% D.
  function assignTiers(rows, minGames) {
    const eligible = rows.filter((r) => r.picks >= minGames).sort((a, b) => tierScore(b) - tierScore(a));
    const cutoffs = [[0.1, "S"], [0.3, "A"], [0.7, "B"], [0.9, "C"], [1, "D"]];
    eligible.forEach((r, i) => {
      const q = (i + 0.5) / eligible.length;
      r.tier = cutoffs.find(([limit]) => q <= limit)[1];
    });
    for (const r of rows) if (r.picks < minGames) r.tier = "–";
  }

  // Synergies (same team) and counters (opposite team) for one champion.
  function championDetail(sides, champion, championRows) {
    const byId = new Map(championRows.map((r) => [r.id, r]));
    const self = byId.get(champion);
    const baseWinRate = self.smoothedWinRate;
    const allies = new Map();
    const enemies = new Map();
    const bump = (map, key, won) => {
      const e = map.get(key) || { games: 0, wins: 0 };
      e.games++;
      if (won) e.wins++;
      map.set(key, e);
    };

    for (const s of sides) {
      if (!s.picks.includes(champion)) continue;
      for (const c of s.picks) if (c !== champion) bump(allies, c, s.won);
      for (const c of s.enemyPicks) bump(enemies, c, s.won);
    }

    const synergies = [...allies].map(([id, e]) => {
      const other = byId.get(id).smoothedWinRate;
      const expected = (baseWinRate + other) / 2;
      const together = smooth(e.wins, e.games, expected, PAIR_PRIOR_GAMES);
      return { id, games: e.games, winRate: e.wins / e.games, delta: together - expected };
    });
    const counters = [...enemies].map(([id, e]) => {
      const vs = smooth(e.wins, e.games, baseWinRate, PAIR_PRIOR_GAMES);
      return { id, games: e.games, winRate: e.wins / e.games, delta: vs - baseWinRate };
    });
    return { self, synergies, counters };
  }

  function patchTrend(matches, scope, myTeam, champion) {
    const patches = [...new Set(matches.map((m) => m.patch))].sort(comparePatch);
    return patches.map((patch) => {
      const sides = sidesFor(matches.filter((m) => m.patch === patch), scope, myTeam);
      let picks = 0;
      let wins = 0;
      for (const s of sides) {
        if (s.picks.includes(champion)) {
          picks++;
          if (s.won) wins++;
        }
      }
      return { patch, picks, winRate: picks ? wins / picks : null, pickRate: picks / (draftCount(sides, scope) || 1) };
    });
  }

  function comparePatch(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  }

  return {
    sidesFor, filterMatches, draftCount, championTable, championDetail,
    patchTrend, tierScore, assignTiers, comparePatch,
  };
})();

if (typeof module !== "undefined") module.exports = Stats;
