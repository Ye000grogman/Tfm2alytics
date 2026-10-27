// UI for the draft helper: draft board, suggestions and champion grid.

const BANS = 3;
const PICKS = 5;

// TFM2's order (checked in game): bans alternate starting with the first team,
// then picks go 1-2-2-2-2-1. Any slot can also be clicked directly.
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
  model: null, // basic helper (v0), always available
  trained: null, // trained model (Phase 5), once trained or loaded
  tags: null,
  training: false,
  draft: { me: { ban: Array(BANS).fill(null), pick: Array(PICKS).fill(null) }, enemy: { ban: Array(BANS).fill(null), pick: Array(PICKS).fill(null) } },
  active: null, // [side, kind, index]
};

const $ = (id) => document.getElementById(id);
const champName = (id) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const signedPct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const filled = (list) => list.filter(Boolean);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const saveStem = () => state.dataset.save.file.replace(/\.data$/, "");

const COMP_TEXT = {
  no_magic: "no magic damage",
  mostly_magic: "mostly magic damage",
  no_physical: "no physical damage",
  no_cc: "no CC",
  much_cc: "lots of CC",
  no_frontline: "no frontline",
  two_frontline: "2+ frontliners",
  no_sustain: "no healing or shields",
  few_ranged: "1 or fewer ranged",
  mostly_ranged: "4+ ranged",
  no_anti_heal_vs_sustain: "no anti-heal vs their healing",
  no_shred_vs_frontline: "no shred or %HP damage vs their frontline",
  buffer_with_cdr: "an ally buffer with cooldown-hungry champions",
  anti_projectile_vs_ranged: "projectile blocking vs their ranged champions",
  cc_immunity_vs_cc: "CC immunity vs their CC",
  no_anti_shield_vs_shields: "no shield breaking vs their shields",
};

function init() {
  $("patch-select").addEventListener("change", rebuildModel);
  $("opponent").addEventListener("change", render);
  $("train").addEventListener("click", trainModel);
  fetch("champion-tags.json")
    .then((res) => res.json())
    .then((tags) => (state.tags = tags))
    .catch(() => ($("train").disabled = true));
  $("first-pick").addEventListener("change", () => {
    state.active = nextEmptySlot();
    render();
  });
  $("reset").addEventListener("click", resetDraft);
  $("search").addEventListener("input", renderGrid);

  SaveFeed.start({
    select: $("save-select"),
    status: $("save-info"),
    button: $("refresh"),
    onLoad: setDataset,
    onError: (text) => ($("suggest-hint").textContent = text),
  });
}

// On a refresh of the same save, keep the patch and the draft in progress.
function setDataset(dataset, { refresh = false } = {}) {
  const keepPatch = $("patch-select").value;
  state.dataset = dataset;
  const patches = [...new Set(dataset.matches.map((m) => m.patch))].sort(Stats.comparePatch).reverse();
  const counts = Object.fromEntries(patches.map((p) => [p, dataset.matches.filter((m) => m.patch === p).length]));
  $("patch-select").innerHTML =
    patches.map((p) => `<option value="${p}">${p} (${counts[p]} games)</option>`).join("") +
    `<option value="all">All patches (${dataset.matches.length} games)</option>`;
  const keep = refresh && [...$("patch-select").options].some((o) => o.value === keepPatch);
  $("patch-select").value = keep ? keepPatch : patches[0];
  fillOpponents(refresh);
  rebuildModel();
  if (!refresh) resetDraft();
  loadTrainedModel();
}

function fillOpponents(refresh) {
  const keep = $("opponent").value;
  const mine = String(state.dataset.save.my_team_id);
  const teams = Object.entries(state.dataset.teams)
    .filter(([id]) => id !== mine)
    .sort((a, b) => a[1].localeCompare(b[1]));
  $("opponent").innerHTML =
    `<option value="">Unknown</option>` + teams.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
  if (refresh && teams.some(([id]) => id === keep)) $("opponent").value = keep;
}

// A model trained earlier for this save is kept next to its data.
async function loadTrainedModel() {
  const stem = saveStem();
  try {
    const res = await fetch(`../data/${encodeURIComponent(stem)}.model.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const model = await res.json();
    if (saveStem() === stem) state.trained = model;
  } catch {
    state.trained = null;
  }
  render();
}

function trainModel() {
  if (state.training || !state.dataset || !state.tags) return;
  state.training = true;
  $("train").disabled = true;
  $("train").textContent = "Training… 0%";
  const worker = new Worker("train-worker.js");
  worker.onmessage = async (e) => {
    const { progress, model, error } = e.data;
    if (progress != null) {
      $("train").textContent = `Training… ${Math.round(progress * 100)}%`;
      return;
    }
    worker.terminate();
    state.training = false;
    $("train").disabled = false;
    $("train").textContent = "Train model";
    if (error) {
      showReport(`Training failed: ${error}`);
      return;
    }
    state.trained = model;
    let saved = true;
    try {
      const res = await fetch(`../api/model?save=${encodeURIComponent(saveStem())}`, { method: "POST", body: JSON.stringify(model) });
      saved = (await res.json()).ok;
    } catch {
      saved = false;
    }
    const r = model.report;
    showReport(
      `Trained on ${model.games.toLocaleString()} games. Tested on the newest ${r.testGames.toLocaleString()} games ` +
        `(model trained only on the games before them): the trained model picked the winner ` +
        `${pct(r.draftOnly.accuracy)} of the time from the draft alone, the basic helper ${pct(r.baseline)}.` +
        (saved ? "" : " Couldn't save the model, so it only lasts until you reload the page."),
    );
    render();
  };
  worker.postMessage({ dataset: state.dataset, tags: state.tags });
}

function showReport(text) {
  $("train-report").hidden = false;
  $("train-report").textContent = text;
}

// What the chosen opponent picks and bans, from their games on the chosen patch,
// or their latest 30 games when they haven't played it yet.
function tendencies() {
  const team = Number($("opponent").value);
  if (!$("opponent").value) return null;
  const theirs = state.dataset.matches.filter((m) => m.team_a === team || m.team_b === team);
  const patch = modelPatch();
  let games = theirs.filter((m) => m.patch === patch);
  if (games.length < 10) games = theirs.slice(-30);
  if (!games.length) return null;
  const picks = {};
  const bans = {};
  for (const m of games) {
    const a = m.team_a === team;
    for (const c of a ? m.picks_a : m.picks_b) picks[c] = (picks[c] || 0) + 1 / games.length;
    for (const c of a ? m.bans_a : m.bans_b) bans[c] = (bans[c] || 0) + 1 / games.length;
  }
  return { games: games.length, patch: games === theirs ? null : patch, picks, bans };
}

// The patch the trained model judges on: the chosen one, or the newest for "all".
function modelPatch() {
  const p = $("patch-select").value;
  return p === "all" ? [...new Set(state.dataset.matches.map((m) => m.patch))].sort(Stats.comparePatch).pop() : p;
}

function rebuildModel() {
  const patch = $("patch-select").value;
  const matches = Stats.filterMatches(state.dataset.matches, { patch });
  state.model = Draft.buildModel(Stats.sidesFor(matches, "all"), state.dataset.champions);
  state.v0Games = matches.length;
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
  renderModelInfo();
  renderOpponent();
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

function renderModelInfo() {
  const m = state.trained;
  if (!m) {
    $("model-info").textContent = `Basic helper · ${state.v0Games} games · press Train model for the trained one`;
    return;
  }
  const lastId = Math.max(...state.dataset.matches.map((x) => x.id));
  const newGames = state.dataset.matches.filter((x) => x.id > m.lastMatchId).length;
  $("model-info").textContent =
    `Trained model · ${m.games.toLocaleString()} games · tested ${pct(m.report.draftOnly.accuracy)}` +
    (newGames && lastId > m.lastMatchId ? ` · ${newGames} new games since, train again to include them` : "");
}

function renderOpponent() {
  const t = tendencies();
  if (!t) {
    $("opponent-info").innerHTML = "";
    return;
  }
  const top = (table) =>
    Object.entries(table)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([c, s]) => `${escapeHtml(champName(c))} ${Math.round(s * 100)}%`)
      .join(", ") || "–";
  $("opponent-info").innerHTML =
    `<h3>Their habits</h3><div class="muted">${t.games} games${t.patch ? ` on ${escapeHtml(t.patch)}` : " (latest)"}</div>` +
    `<div><b>Picks:</b> ${top(t.picks)}</div><div><b>Bans:</b> ${top(t.bans)}</div>`;
}

function renderWinChance() {
  const mine = filled(state.draft.me.pick);
  const theirs = filled(state.draft.enemy.pick);
  const box = $("win-chance");
  box.hidden = !mine.length && !theirs.length;
  if (box.hidden) return;
  const p = state.trained ? Train.winChance(state.trained, mine, theirs, modelPatch()) : Draft.winChance(state.model, mine, theirs);
  $("win-fill").style.width = `${(p * 100).toFixed(1)}%`;
  $("win-text").textContent =
    `Draft edge: ${(p * 100).toFixed(0)}% for you on these picks` +
    (mine.length < PICKS || theirs.length < PICKS ? " (so far)" : "") +
    ". This is the draft alone; player skill matters too.";
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
  const name = (c) => champName(c);
  const items = state.trained ? trainedSuggestions(side, kind, view) : basicSuggestions(kind, view);
  list.innerHTML = items
    .map(
      (it) => `<li data-id="${it.champion}" class="${forMe ? "" : "enemy-view"}">
        <div class="sg-main"><span class="champ">${escapeHtml(name(it.champion))}</span>
        <span class="sg-score ${it.score >= 0 ? "good" : "bad"}">${signedPct(it.score)}</span></div>
        ${it.reasons.length ? `<ul class="sg-reasons small">${it.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>` : `<div class="small muted">no strong effects</div>`}
      </li>`,
    )
    .join("");
  list.querySelectorAll(":scope > li").forEach((li) => li.addEventListener("click", () => place(li.dataset.id)));
}

function basicSuggestions(kind, view) {
  return Draft.suggest(state.model, view, kind, 10).map((r) => ({
    champion: r.champion,
    score: r.score,
    reasons: [
      ...Draft.reasons(r, champName).map(escapeHtml),
      `<span class="muted">${state.model.games[state.model.index.get(r.champion)]} games</span>`,
    ],
  }));
}

// The side after the acting one picks next, so suggestions can look one turn ahead.
function otherSidePicksNext(side) {
  const order = draftOrder($("first-pick").value);
  const at = order.findIndex(([s, k, i]) => s === state.active[0] && k === state.active[1] && i === state.active[2]);
  const next = order.slice(at + 1).find(([s, k, i]) => !state.draft[s][k][i]);
  return Boolean(next && next[0] !== side && next[1] === "pick");
}

function trainedSuggestions(side, kind, view) {
  const t = tendencies();
  const enemyIsOpponent = side === "me";
  const opts = {
    patch: modelPatch(),
    champions: state.dataset.champions,
    enemyPicksNext: kind === "pick" && otherSidePicksNext(side),
    // Their habits rank their own turns, and tilt my bans toward what they play.
    habits: !enemyIsOpponent && t ? (kind === "ban" ? t.bans : t.picks) : null,
    enemyHabits: t ? (enemyIsOpponent ? t.picks : null) : null,
  };
  if (!enemyIsOpponent && kind === "ban" && t) {
    // Predicting their ban: what's best for me, plus what they usually ban.
    const results = Train.suggest(state.trained, view, "ban", { ...opts, enemyHabits: t.bans, habits: null });
    return results.map((r) => ({ champion: r.champion, score: r.score, reasons: reasonList(r, side, kind) }));
  }
  return Train.suggest(state.trained, view, kind, opts).map((r) => ({
    champion: r.champion,
    score: r.score,
    reasons: reasonList(r, side, kind),
  }));
}

// Every reason behind a suggestion, biggest first, in win-chance points.
function reasonList(r, side, kind) {
  const out = r.parts
    .filter((p) => Math.abs(p.value) >= 0.002)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map((p) => {
      const v = `<b class="${p.value >= 0 ? "good" : "bad"}">${signedPct(p.value)}</b>`;
      if (p.kind === "base") return `${v} strength on this patch`;
      if (p.kind === "notes") return `${v} from patch notes (${p.value >= 0 ? "buffed" : "nerfed"})`;
      if (p.kind === "ally") return `${v} with ${escapeHtml(champName(p.with))}`;
      if (p.kind === "enemy") return `${v} vs ${escapeHtml(champName(p.with))}`;
      if (p.kind === "habit") {
        const verb = kind === "ban" && side === "enemy" ? "ban" : "pick";
        return `${v} they ${verb} it in ${Math.round(p.share * 100)}% of games`;
      }
      if (p.kind === "comp") {
        const what = COMP_TEXT[p.what] || p.what.replace(/_/g, " ");
        const team = kind === "ban" ? "their team" : "the team";
        const now = { fixes: "no longer has", causes: "now has", keeps: "still has" }[p.change];
        return `${v} ${team} ${now} ${what}`;
      }
      return `${v} ${escapeHtml(p.kind)}`;
    });
  if (r.answer) {
    out.push(`<span class="muted">Their best answer: ${escapeHtml(champName(r.answer.champion))}, leaving you ${pct(r.answer.chance)} to win</span>`);
  }
  return out;
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
