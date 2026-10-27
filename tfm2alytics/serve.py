"""Command line: open the stats site in your browser.

    python -m tfm2alytics.serve

Serves the site/ and data/ folders on localhost. Nothing leaves your PC.
On start, any save newer than its extracted data is extracted. After that,
saves are only checked when you ask: press R on the site (or click
"Check for new saves"), which calls POST /api/refresh.
"""

import argparse
import functools
import http.server
import json
import re
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .extract import FORMAT_VERSION, default_save_dir, extract_save, write_index

ROOT = Path(__file__).resolve().parent.parent


def needs_extract(save: Path, out: Path) -> bool:
    json_path = out / f"{save.stem}.json"
    if not json_path.exists() or json_path.stat().st_mtime < save.stat().st_mtime:
        return True
    # Re-extract data written by an older version of the extractor. The JSON
    # starts with {"format_version":N, so the first bytes are enough.
    with json_path.open("rb") as f:
        m = re.match(rb'\{"format_version":(\d+)', f.read(64))
    return not m or int(m.group(1)) < FORMAT_VERSION


def wait_until_written(save: Path, timeout: float = 30) -> None:
    """Wait until the save stops changing, so we don't read it while the game writes it."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        stat = save.stat()
        current = (stat.st_size, stat.st_mtime)
        if current == last:
            return
        last = current
        time.sleep(1)


class Refresher:
    """Extracts saves that changed since the last extraction. One run at a time."""

    def __init__(self, save_dir: Path | None, out: Path):
        self.save_dir = save_dir
        self.out = out
        self.lock = threading.Lock()

    def run(self) -> dict:
        if self.save_dir is None:
            return {"ok": False, "error": "Save folder not found. Start with --saves <folder>."}
        with self.lock:
            saves = sorted(self.save_dir.glob("*.data"))
            stale = [s for s in saves if needs_extract(s, self.out)]
            updated, failed = [], []
            for save in stale:
                try:
                    wait_until_written(save)
                    extract_save(save, self.out)
                    updated.append(save.name)
                except Exception as err:  # e.g. the game is still writing it
                    print(f"{save.name}: couldn't read ({err})", file=sys.stderr)
                    failed.append(save.name)
            if updated or not (self.out / "index.json").exists():
                write_index(self.out)
            if updated:
                print(f"{time.strftime('%H:%M:%S')} updated {', '.join(updated)}", file=sys.stderr)
            return {"ok": not failed, "checked": len(saves), "updated": updated, "failed": failed}


class Handler(http.server.SimpleHTTPRequestHandler):
    data_dir: Path = ROOT / "data"
    refresher: Refresher | None = None

    def translate_path(self, path):
        # /data/... comes from the output folder, wherever it is; the rest from the repo.
        if path.split("?")[0].startswith("/data/"):
            rel = path.split("?")[0][len("/data/"):]
            return str(self.data_dir / Path(rel).name)
        return super().translate_path(path)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/refresh":
            self.send_error(404)
            return
        body = json.dumps(self.refresher.run()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # keep the console for extraction messages


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Serve the TFM2 stats site locally.")
    parser.add_argument("--port", type=int, default=8642)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--saves", type=Path, default=default_save_dir(), help="the game's save folder")
    parser.add_argument("--out", type=Path, default=ROOT / "data", help="where extracted data goes")
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    refresher = Refresher(args.saves, args.out)
    if args.saves:
        refresher.run()
        print(f"Reading saves from {args.saves}. Press R on the site to check for new saves.")
    else:
        print("Save folder not found. Pass --saves <folder> to read your saves.")

    Handler.data_dir = args.out.resolve()
    Handler.refresher = refresher
    handler = functools.partial(Handler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}/site/"
    print(f"Stats site running at {url} (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
