// Save picker shared by both pages, with auto-refresh.
//
// Polls data/index.json. When the server (python -m tfm2alytics.serve) has
// re-extracted a save after the game wrote it, the page reloads that save's data
// without losing its filters or draft. "Latest save" follows whichever save the
// game wrote most recently.

const SaveFeed = (() => {
  const LATEST = "__latest__";
  const POLL_MS = 10000;
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  async function fetchIndex() {
    const res = await fetch("../data/index.json", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  function start({ select, status, onLoad, onError }) {
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
      if (status) {
        status.textContent = save.saved_at ? `Data from save at ${clock(save.saved_at)}` : "";
        if (refresh) status.textContent += " · just updated";
      }
    }

    select.addEventListener("change", () => sync(false));

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
      setInterval(async () => {
        try {
          saves = await fetchIndex();
          fillSelect();
          await sync(true);
        } catch (err) {
          // Server stopped or file mid-write; try again next tick.
        }
      }, POLL_MS);
    })();
  }

  return { start, LATEST };
})();
