// UI: save picker, filters, tier table and champion detail panel.

const state = {
  dataset: null,
  sort: { key: "score", dir: -1 },
  selected: null,
};

const $ = (id) => document.getElementById(id);
const pct = (x, digits = 1) => (x == null ? "–" : `${(x * 100).toFixed(digits)}%`);
const signedPct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const champName = (id) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function init() {
  bindControls();
  SaveFeed.start({
    select: $("save-select"),
    status: $("save-info"),
    onLoad: setDataset,
    onError: showEmpty,
  });
}

function bindControls() {
  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) setDataset(JSON.parse(await file.text()));
  });
  for (const id of ["patch-select", "scope-select", "search"]) $(id).addEventListener("input", render);
  $("min-games").addEventListener("input", (e) => {
    $("min-games-out").textContent = e.target.value;
    render();
  });
  document.querySelectorAll("#tier-table th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === "name" ? 1 : -1 };
      render();
    });
  });
}

// On a refresh of the same save, keep the chosen patch and champion.
function setDataset(dataset, { refresh = false } = {}) {
  const keepPatch = $("patch-select").value;
  state.dataset = dataset;
  if (!refresh) state.selected = null;
  const patches = [...new Set(dataset.matches.map((m) => m.patch))].sort(Stats.comparePatch).reverse();
  $("patch-select").innerHTML =
    `<option value="all">All patches</option>` + patches.map((p) => `<option>${escapeHtml(p)}</option>`).join("");
  if (refresh && [...$("patch-select").options].some((o) => o.value === keepPatch)) $("patch-select").value = keepPatch;
  const save = dataset.save;
  $("save-title").textContent = `${save.team || "?"} · manager ${save.manager || "?"} · game ${save.game_version || "?"}`;
  const hasTeam = save.my_team_id != null;
  for (const opt of $("scope-select").options) opt.disabled = opt.value !== "all" && !hasTeam;
  if (!hasTeam) $("scope-select").value = "all";
  render();
}

function currentView() {
  const ds = state.dataset;
  const scope = $("scope-select").value;
  const matches = Stats.filterMatches(ds.matches, { patch: $("patch-select").value });
  const sides = Stats.sidesFor(matches, scope, ds.save.my_team_id);
  const rows = Stats.championTable(sides, scope, ds.champions);
  return { ds, scope, matches, sides, rows };
}

function render() {
  if (!state.dataset) return;
  const { ds, scope, matches, sides, rows } = currentView();
  const minGames = Number($("min-games").value);
  const query = $("search").value.trim().toLowerCase();

  for (const r of rows) {
    r.name = champName(r.id);
    r.score = Stats.tierScore(r);
  }
  Stats.assignTiers(rows, Math.max(minGames, 1));
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => (r.rank = i + 1));

  const { key, dir } = state.sort;
  const visible = rows
    .filter((r) => r.picks >= minGames && r.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const av = a[key] ?? -1;
      const bv = b[key] ?? -1;
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * dir;
    });

  const drafts = Stats.draftCount(sides, scope);
  $("sample-info").textContent = `${matches.length} matches · ${drafts} drafts in view`;

  document.querySelectorAll("#tier-table th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.dataset.dir = th.dataset.sort === key ? (dir > 0 ? "asc" : "desc") : "";
  });

  $("tier-table").querySelector("tbody").innerHTML = visible
    .map(
      (r) => `
      <tr data-id="${r.id}" class="${r.id === state.selected ? "selected" : ""}">
        <td class="muted">${r.rank}</td>
        <td class="left champ">${escapeHtml(r.name)}</td>
        <td><span class="tier tier-${r.tier === "–" ? "none" : r.tier}">${r.tier}</span></td>
        <td class="${rateClass(r.winRate)}">${pct(r.winRate, 2)}</td>
        <td>${pct(r.pickRate)}</td>
        <td>${pct(r.banRate)}</td>
        <td>${pct(r.presence)}</td>
        <td class="muted">${r.picks}</td>
      </tr>`
    )
    .join("");
  $("tier-table").querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.selected = tr.dataset.id;
      render();
    })
  );

  const empty = $("empty-state");
  empty.hidden = visible.length > 0;
  if (!visible.length) empty.textContent = "No champions match these filters. Try lowering Min games.";

  renderDetail(ds, scope, matches, sides, rows);
}

function rateClass(rate) {
  if (rate == null) return "muted";
  if (rate >= 0.53) return "good";
  if (rate <= 0.47) return "bad";
  return "";
}

function renderDetail(ds, scope, matches, sides, rows) {
  const panel = $("detail");
  if (!state.selected) {
    panel.innerHTML = `<p class="empty">Pick a champion to see its synergies and counters.</p>`;
    return;
  }
  const { self, synergies, counters } = Stats.championDetail(sides, state.selected, rows);
  const minPair = Math.max(5, Math.round(Number($("min-games").value) / 4));
  const top = (list, n, better) =>
    list
      .filter((e) => e.games >= minPair)
      .sort((a, b) => (better ? b.delta - a.delta : a.delta - b.delta))
      .slice(0, n);

  const trend = Stats.patchTrend(Stats.filterMatches(ds.matches, {}), scope, ds.save.my_team_id, state.selected);

  panel.innerHTML = `
    <h2>${escapeHtml(champName(self.id))} <span class="tier tier-${self.tier}">${self.tier}</span></h2>
    <div class="cards">
      ${card("Win rate", pct(self.winRate, 2))}
      ${card("Pick rate", pct(self.pickRate))}
      ${card("Ban rate", pct(self.banRate))}
      ${card("Presence", pct(self.presence))}
      ${card("Games", self.picks)}
    </div>
    ${pairList("Best with", top(synergies, 6, true), "Ally")}
    ${pairList("Worst with", top(synergies, 6, false), "Ally")}
    ${pairList("Strong against", top(counters, 6, true), "Enemy")}
    ${pairList("Weak against", top(counters, 6, false), "Enemy")}
    <h3>By patch</h3>
    <table class="mini">
      <thead><tr><th class="left">Patch</th><th>Win rate</th><th>Pick rate</th><th>Games</th></tr></thead>
      <tbody>${trend
        .map((t) => `<tr><td class="left">${escapeHtml(t.patch)}</td><td class="${rateClass(t.winRate)}">${pct(t.winRate)}</td><td>${pct(t.pickRate)}</td><td class="muted">${t.picks}</td></tr>`)
        .join("")}</tbody>
    </table>
    <p class="muted small">Pairs need at least ${minPair} games together to show.</p>`;
}

function card(label, value) {
  return `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div></div>`;
}

function pairList(title, entries, who) {
  if (!entries.length) return `<h3>${title}</h3><p class="muted small">Not enough games.</p>`;
  return `
    <h3>${title}</h3>
    <table class="mini">
      <thead><tr><th class="left">${who}</th><th>Δ</th><th>Win rate</th><th>Games</th></tr></thead>
      <tbody>${entries
        .map((e) => `<tr><td class="left champ link" data-id="${e.id}">${escapeHtml(champName(e.id))}</td><td class="${e.delta >= 0 ? "good" : "bad"}">${signedPct(e.delta)}</td><td>${pct(e.winRate)}</td><td class="muted">${e.games}</td></tr>`)
        .join("")}</tbody>
    </table>`;
}

function showEmpty(text) {
  const empty = $("empty-state");
  empty.hidden = false;
  empty.textContent = text;
}

document.addEventListener("click", (e) => {
  const link = e.target.closest(".detail-panel .link");
  if (link) {
    state.selected = link.dataset.id;
    render();
  }
});

init();
