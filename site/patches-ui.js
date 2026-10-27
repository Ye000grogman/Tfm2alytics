// UI: patch notes page. One patch at a time, or every patch that touched a champion.

const ALL = "all";
const state = { dataset: null, notes: [] };

const $ = (id) => document.getElementById(id);
const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const champName = (id) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const longDate = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "";

function init() {
  for (const id of ["patch-select", "kind-select", "search"]) $(id).addEventListener("input", render);
  $("patches").addEventListener("click", (e) => {
    const champ = e.target.closest("[data-champ]");
    if (champ) {
      $("search").value = champName(champ.dataset.champ);
      render();
    }
  });
  SaveFeed.start({
    select: $("save-select"),
    status: $("save-info"),
    button: $("refresh"),
    onLoad: setDataset,
    onError: showEmpty,
  });
}

function setDataset(dataset, { refresh = false } = {}) {
  const keep = $("patch-select").value;
  state.dataset = dataset;
  state.notes = PatchNotes.build(dataset);
  const save = dataset.save;
  $("save-title").textContent = `${save.team || "?"} · manager ${save.manager || "?"} · game ${save.game_version || "?"}`;
  $("patch-select").innerHTML =
    [...state.notes].reverse().map((n) => `<option value="${escapeHtml(n.version)}">${escapeHtml(n.version)} · ${longDate(n.date)}</option>`).join("") +
    `<option value="${ALL}">All patches</option>`;
  if (refresh && [...$("patch-select").options].some((o) => o.value === keep)) $("patch-select").value = keep;
  render();
}

function showEmpty(message) {
  $("patches").innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
}

function render() {
  if (!state.dataset) return;
  if (!state.dataset.patch_notes) {
    return showEmpty("This data was extracted before patch notes were added. Press R to read the save again.");
  }
  if (!state.notes.length) return showEmpty("No patch notes in this save yet. The league is still on its first patch.");

  const query = $("search").value.trim().toLowerCase();
  const kind = $("kind-select").value;
  const patch = $("patch-select").value;
  // A champion search looks through every patch, so the patch picker steps aside.
  $("patch-select").disabled = Boolean(query);
  const notes = query || patch === ALL ? [...state.notes].reverse() : state.notes.filter((n) => n.version === patch);

  const html = notes
    .map((note) => {
      const champs = note.champions.filter(
        (c) => (kind === ALL || c.verdict === kind || c.verdict === "mixed") && (!query || champName(c.id).toLowerCase().includes(query)),
      );
      const showRules = !query && note.game_rules.length && kind === ALL;
      if (!champs.length && !showRules && (query || kind !== ALL)) return "";
      return renderNote(note, champs, { showRules, showNew: !query });
    })
    .join("");
  $("patches").innerHTML = html || `<p class="empty">No matching changes.</p>`;
}

function renderNote(note, champs, { showRules, showNew }) {
  const buffs = note.champions.filter((c) => c.verdict === "buff").length;
  const nerfs = note.champions.filter((c) => c.verdict === "nerf").length;
  const summary = [`${note.champions.length} champions changed`, `${buffs} buffed`, `${nerfs} nerfed`];
  const games = note.previous
    ? `Stats: ${escapeHtml(note.previous)} (${note.gamesBefore} games) → ${escapeHtml(note.version)} (${note.gamesAfter} games)`
    : "";
  const newChamps =
    showNew && note.new_champions.length
      ? `<p class="new-champs">New: ${note.new_champions.map((c) => `<span class="pill new">${escapeHtml(champName(c))}</span>`).join(" ")}</p>`
      : "";
  const rules = showRules ? renderRules(note) : "";
  return `
    <section class="patch">
      <header class="patch-head">
        <h2>Patch ${escapeHtml(note.version)} <span class="muted">${longDate(note.date)}</span></h2>
        <div class="muted small">${summary.join(" · ")}${games ? ` · ${games}` : ""}</div>
      </header>
      ${newChamps}
      ${rules}
      <div class="patch-grid">${champs.map((c) => renderChampion(c, note)).join("")}</div>
    </section>`;
}

function renderRules(note) {
  const reasons = note.game_rule_reasons.map((r) => reasonPill(PatchNotes.reasonLabel(r))).join(" ");
  const rows = note.game_rules
    .map((r) => `<li>${escapeHtml(PatchNotes.ruleLabel(r.rule))}: ${valueChange(r)}</li>`)
    .join("");
  return `<div class="patch-card rules"><h3>Game rules</h3><div class="reasons">${reasons}</div><ul class="changes">${rows}</ul></div>`;
}

function renderChampion(c, note) {
  const label = { buff: "Buff", nerf: "Nerf", mixed: "Adjusted" }[c.verdict];
  const changes = c.changes.map((ch) => `<li>${escapeHtml(PatchNotes.statLabel(ch))}: ${valueChange(ch)}</li>`).join("");
  return `
    <article class="patch-card ${c.verdict}">
      <div class="patch-card-head">
        <span class="champ link" data-champ="${escapeHtml(c.id)}">${escapeHtml(champName(c.id))}</span>
        <span class="pill ${c.verdict}">${label}</span>
      </div>
      <div class="reasons">${c.reasons.map(reasonPill).join(" ")}</div>
      <ul class="changes">${changes}</ul>
      ${note.previous ? renderStats(c) : ""}
    </article>`;
}

function valueChange(ch) {
  return `<span class="muted">${escapeHtml(ch.before)}</span> → <b class="${ch.buff ? "good" : "bad"}">${escapeHtml(ch.after)}</b>`;
}

function reasonPill(r) {
  const level = r.level ? ` <span class="level">${"●".repeat(r.level)}${"○".repeat(3 - r.level)}</span>` : "";
  return `<span class="pill reason" title="${r.level ? `Strength ${r.level} of 3` : ""}">${escapeHtml(r.text)}${level}</span>`;
}

function renderStats(c) {
  const b = c.before;
  const a = c.after;
  const row = (name, key) => {
    const x = b ? b[key] : null;
    const y = a ? a[key] : null;
    const delta = x != null && y != null ? y - x : null;
    const cls = delta == null || Math.abs(delta) < 0.005 ? "muted" : delta > 0 ? "good" : "bad";
    const sign = delta != null && delta >= 0 ? "+" : "";
    return `<tr><td class="left muted">${name}</td><td>${pct(x)}</td><td>${pct(y)}</td><td class="${cls}">${delta == null ? "–" : `${sign}${(delta * 100).toFixed(1)}`}</td></tr>`;
  };
  return `
    <table class="mini patch-stats">
      <thead><tr><th class="left"></th><th>Before</th><th>After</th><th>Change</th></tr></thead>
      <tbody>
        ${row("Win rate", "winRate")}
        ${row("Pick rate", "pickRate")}
        ${row("Ban rate", "banRate")}
        ${row("Presence", "presence")}
        <tr><td class="left muted">Games</td><td>${b ? b.picks : 0}</td><td>${a ? a.picks : 0}</td><td></td></tr>
      </tbody>
    </table>`;
}

init();
