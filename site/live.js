// Save picker shared by both pages, with an on-demand refresh.
//
// Press R (or click "Check for new saves") to ask the server
// (python -m tfm2alytics.serve) to look for saves the game wrote since the last
// check. If any changed, they are re-extracted and the page reloads the data
// without losing its filters or draft. "Latest save" follows whichever save the
// game wrote most recently.

const SaveFeed = (() => {
  const LATEST = "__latest__";
  const REFRESH_KEY = "r";
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const savedLine = (save, note = "press R to check for new saves") =>
    save && save.saved_at ? `Data from save at ${clock(save.saved_at)} · ${note}` : note;

  async function fetchIndex() {
    const res = await fetch("../data/index.json", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  function start({ select, status, button, onLoad, onError }) {
    let saves = [];
    let loaded = null; // { json, extractedAt }

    const target = () => {
      if (!saves.length) return null;
      if (select.value === LATEST || !select.value) return saves[saves.length - 1];
      return saves.find((s) => s.json === select.value) || saves[saves.length - 1];
    };

    function fillSelect() {
      const keep = select.value || LATEST;
      const newest = saves[saves.length - 1];
      select.innerHTML =
        `<option value="${LATEST}">Latest save${newest ? ` (${escape(newest.team || newest.file)})` : ""}</option>` +
        [...saves]
          .reverse()
          .map((s) => `<option value="${escape(s.json)}">${escape(s.team || s.file)} · ${escape(s.file)} (${s.matches} matches)</option>`)
          .join("");
      select.value = [...select.options].some((o) => o.value === keep) ? keep : LATEST;
    }

    async function sync(refresh) {
      const save = target();
      if (!save) return;
      if (loaded && loaded.json === save.json && loaded.extractedAt === save.extracted_at) return;
      const res = await fetch(`../data/${encodeURIComponent(save.json)}`, { cache: "no-store" });
      const dataset = await res.json();
      const sameSave = loaded && loaded.json === save.json;
      loaded = { json: save.json, extractedAt: save.extracted_at };
      onLoad(dataset, { refresh: refresh && sameSave });
      if (status && !refresh) status.textContent = savedLine(save);
    }

    select.addEventListener("change", () => sync(false));

    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      if (button) button.disabled = true;
      const say = (text) => status && (status.textContent = text);
      say("Checking for new saves…");
      try {
        const res = await fetch("../api/refresh", { method: "POST" });
        const result = await res.json();
        saves = await fetchIndex();
        fillSelect();
        const before = loaded && loaded.extractedAt;
        await sync(true);
        if (!result.ok && result.error) say(result.error);
        else if (result.failed && result.failed.length) say(`Couldn't read ${result.failed.join(", ")} yet. Try again in a moment.`);
        else if (loaded && loaded.extractedAt !== before) say(savedLine(target(), "updated just now"));
        else say(savedLine(target(), "no new saves"));
      } catch (err) {
        say("Couldn't reach the server. Is start.bat still running?");
      } finally {
        busy = false;
        if (button) button.disabled = false;
      }
    }

    if (button) button.addEventListener("click", refresh);
    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest && e.target.closest("input[type=search], input[type=text], textarea");
      if (e.key.toLowerCase() === REFRESH_KEY && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        refresh();
      }
    });

    (async () => {
      try {
        saves = await fetchIndex();
        fillSelect();
        if (!saves.length) return onError("No extracted saves yet. Start the site with start.bat (see INSTALL.md).");
        await sync(false);
      } catch (err) {
        select.innerHTML = "<option>No data folder found</option>";
        return onError("Couldn't read data/index.json. Start the site with start.bat or `python -m tfm2alytics.serve`.");
      }
    })();
  }

  return { start, LATEST, REFRESH_KEY };
})();
