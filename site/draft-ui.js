// UI for the draft helper: draft board, suggestions and champion grid.

const BANS = 3;
const PICKS = 5;

// Default order: bans alternate, then picks go 1-2-2-2-2-1 starting with the first-pick team.
// The game's real order isn't in the save, so any slot can also be clicked directly.
function draftOrder(firstPick) {
  const [f, s] = firstPick === "me" ? ["me", "enemy"] : ["enemy", "me"];
  const order = [];
  for (let i = 0; i < BANS; i++) order.push([f, "ban", i], [s, "ban", i]);
  const pickSides = [f, s, s, f, f, s, s, f, f, s];
  const count = { me: 0, enemy: 0 };
  for (const side of pickSides) order.push([side, "pick", count[side]++]);
  return order;
}

const state = {
  dataset: null,
  model: null,
  draft: { me: { ban: Array(BANS).fill(null), pick: Array(PICKS).fill(null) }, enemy: { ban: Array(BANS).fill(null), pick: Array(PICKS).fill(null) } },
  active: null, // [side, kind, index]
};

const $ = (id) => document.getElementById(id);
const champName = (id) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const signedPct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const filled = (list) => list.filter(Boolean);

async function init() {
  $("save-select").addEventListener("change", (e) => loadSave(e.target.value));
  $("patch-select").addEventListener("change", rebuildModel);
  $("first-pick").addEventListener("change", () => {
    state.active = nextEmptySlot();
    render();
  });
  $("reset").addEventListener("click", resetDraft);
  $("search").addEventListener("input", renderGrid);

  try {
    const saves = await (await fetch("../data/index.json", { cache: "no-store" })).json();
    $("save-select").innerHTML = saves
      .map((s) => `<option value="${escapeHtml(s.json)}">${escapeHtml(s.team || s.file)} · ${escapeHtml(s.file)}</option>`)
      .join("");
    if (saves.length) {
      const latest = saves[saves.length - 1].json;
      $("save-select").value = latest;
      await loadSave(latest);
    }
  } catch (err) {
    $("suggest-hint").textContent = "Couldn't read data/index.json. Start the site with `python -m tfm2alytics.serve`.";
  }
}

async function loadSave(file) {
  state.dataset = await (await fetch(`../data/${encodeURIComponent(file)}`, { cache: "no-store" })).json();
  const patches = [...new Set(state.dataset.matches.map((m) => m.patch))].sort(Stats.comparePatch).reverse();
  const counts = Object.fromEntries(patches.map((p) => [p, state.dataset.matches.filter((m) => m.patch === p).length]));
  $("patch-select").innerHTML =
    patches.map((p) => `<option value="${p}">${p} (${counts[p]} games)</option>`).join("") +
    `<option value="all">All patches (${state.dataset.matches.length} games)</option>`;
  $("patch-select").value = patches[0];
  rebuildModel();
  resetDraft();
}

function rebuildModel() {
  const patch = $("patch-select").value;
  const matches = Stats.filterMatches(state.dataset.matches, { patch });
  state.model = Draft.buildModel(Stats.sidesFor(matches, "all"), state.dataset.champions);
  $("model-info").textContent = `${matches.length} games in the model`;
  render();
}

function resetDraft() {
  for (const side of ["me", "enemy"]) {
    state.draft[side].ban.fill(null);
    state.draft[side].pick.fill(null);
  }
  state.active = nextEmptySlot();
  render();
}

function nextEmptySlot() {
  return draftOrder($("first-pick").value).find(([side, kind, i]) => !state.draft[side][kind][i]) || null;
}

function draftView(side) {
  const other = side === "me" ? "enemy" : "me";
  return {
    myPicks: filled(state.draft[side].pick),
    myBans: filled(state.draft[side].ban),
    enemyPicks: filled(state.draft[other].pick),
    enemyBans: filled(state.draft[other].ban),
  };
}

function takenSet() {
  return new Set(["me", "enemy"].flatMap((s) => [...filled(state.draft[s].pick), ...filled(state.draft[s].ban)]));
}

function place(champion) {
  if (!state.active || takenSet().has(champion)) return;
  const [side, kind, i] = state.active;
  state.draft[side][kind][i] = champion;
  state.active = nextEmptySlot();
  render();
}

function render() {
  if (!state.model) return;
  renderSlots();
  renderWinChance();
  renderSuggestions();
  renderGrid();
}

function renderSlots() {
  document.querySelectorAll(".slots").forEach((box) => {
    const { side, kind } = box.dataset;
    box.innerHTML = state.draft[side][kind]
      .map((c, i) => {
        const active = state.active && state.active[0] === side && state.active[1] === kind && state.active[2] === i;
        const label = kind === "ban" ? `Ban ${i + 1}` : `Pick ${i + 1}`;
        return `<button class="slot ${kind} ${c ? "filled" : ""} ${active ? "active" : ""}" data-side="${side}" data-kind="${kind}" data-i="${i}">
          <span class="slot-label">${label}</span>
          <span class="slot-champ">${c ? escapeHtml(champName(c)) : "—"}</span>
          ${c ? `<span class="slot-clear" title="Clear">×</span>` : ""}
        </button>`;
      })
      .join("");
  });
  document.querySelectorAll(".slot").forEach((el) =>
    el.addEventListener("click", (e) => {
      const { side, kind, i } = el.dataset;
      if (e.target.classList.contains("slot-clear")) state.draft[side][kind][Number(i)] = null;
      state.active = [side, kind, Number(i)];
      render();
    })
  );
}

function renderWinChance() {
  const mine = filled(state.draft.me.pick);
  const theirs = filled(state.draft.enemy.pick);
  const box = $("win-chance");
  box.hidden = !mine.length && !theirs.length;
  if (box.hidden) return;
  const p = Draft.winChance(state.model, mine, theirs);
  $("win-fill").style.width = `${(p * 100).toFixed(1)}%`;
  $("win-text").textContent =
    `Draft edge: ${(p * 100).toFixed(0)}% for you on these picks` +
    (mine.length < PICKS || theirs.length < PICKS ? " (so far)" : "") +
    ". This ignores player skill, which matters as much as the draft.";
}

function renderSuggestions() {
  const list = $("suggestions");
  if (!state.active) {
    $("suggest-title").textContent = "Draft complete";
    $("suggest-hint").textContent = "Click any slot to change it.";
    list.innerHTML = "";
    return;
  }
  const [side, kind] = state.active;
  const forMe = side === "me";
  const titles = {
    "me-pick": ["Suggested picks", "Best champions for your team right now."],
    "me-ban": ["Suggested bans", "Champions that would be strongest for the enemy."],
    "enemy-pick": ["Their best picks", "What the enemy's strongest options are. Click their actual pick to record it."],
    "enemy-ban": ["Likely enemy bans", "Champions that would be strongest for you, so they may ban them."],
  };
  const [title, hint] = titles[`${side}-${kind}`];
  $("suggest-title").textContent = title;
  $("suggest-hint").textContent = hint;

  const view = draftView(side);
  const results = Draft.suggest(state.model, view, kind, 10);
  const name = (c) => champName(c);
  list.innerHTML = results
    .map((r) => {
      const games = state.model.games[state.model.index.get(r.champion)];
      const why = Draft.reasons(r, name).join(" · ") || "no strong effects";
      return `<li data-id="${r.champion}" class="${forMe ? "" : "enemy-view"}">
        <div class="sg-main"><span class="champ">${escapeHtml(name(r.champion))}</span>
        <span class="sg-score ${r.score >= 0 ? "good" : "bad"}">${signedPct(r.score)}</span></div>
        <div class="small muted">${escapeHtml(why)} · ${games} games</div>
      </li>`;
    })
    .join("");
  list.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => place(li.dataset.id)));
}

function renderGrid() {
  if (!state.dataset) return;
  const q = $("search").value.trim().toLowerCase();
  const taken = takenSet();
  $("grid").innerHTML = state.dataset.champions
    .filter((c) => champName(c).toLowerCase().includes(q))
    .map((c) => `<button class="chip ${taken.has(c) ? "taken" : ""}" data-id="${c}" ${taken.has(c) ? "disabled" : ""}>${escapeHtml(champName(c))}</button>`)
    .join("");
  $("grid").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => place(b.dataset.id)));
}

init();
