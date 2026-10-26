"""Command line: open the stats site in your browser and keep it up to date.

    python -m tfm2alytics.serve

Serves the site/ and data/ folders on localhost. Nothing leaves your PC.
While it runs, it watches the game's save folder: whenever the game writes a
save, that save is extracted again and the open site reloads its numbers.
"""

import argparse
import functools
import http.server
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .extract import default_save_dir, extract_save, write_index

ROOT = Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    data_dir: Path = ROOT / "data"

    def translate_path(self, path):
        # /data/... comes from the output folder, wherever it is; the rest from the repo.
        if path.split("?")[0].startswith("/data/"):
            rel = path.split("?")[0][len("/data/"):]
            return str(self.data_dir / Path(rel).name)
        return super().translate_path(path)

    def log_message(self, format, *args):
        pass  # keep the console for extraction messages


def needs_extract(save: Path, out: Path) -> bool:
    json_path = out / f"{save.stem}.json"
    return not json_path.exists() or json_path.stat().st_mtime < save.stat().st_mtime


def watch(save_dir: Path, out: Path, interval: float) -> None:
    """Re-extract saves the game has written since the last extraction."""
    pending: dict[Path, float] = {}  # save -> size+mtime seen last tick
    while True:
        try:
            changed = False
            for save in sorted(save_dir.glob("*.data")):
                if not needs_extract(save, out):
                    continue
                stat = save.stat()
                signature = stat.st_size + stat.st_mtime
                # Wait one tick with no change so we don't read a save mid-write.
                if pending.get(save) != signature:
                    pending[save] = signature
                    continue
                try:
                    extract_save(save, out)
                    changed = True
                except Exception as err:  # e.g. the game is still writing it
                    print(f"{save.name}: couldn't read yet ({err}), will retry", file=sys.stderr)
                pending.pop(save, None)
            if changed:
                write_index(out)
                print(f"{time.strftime('%H:%M:%S')} data updated, the site will refresh", file=sys.stderr)
        except OSError as err:
            print(f"watching {save_dir} failed: {err}", file=sys.stderr)
        time.sleep(interval)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Serve the TFM2 stats site locally.")
    parser.add_argument("--port", type=int, default=8642)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--saves", type=Path, default=default_save_dir(), help="save folder to watch")
    parser.add_argument("--out", type=Path, default=ROOT / "data", help="where extracted data goes")
    parser.add_argument("--interval", type=float, default=5, help="seconds between save folder checks")
    parser.add_argument("--no-watch", action="store_true", help="don't watch for new saves")
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    if args.saves and not args.no_watch:
        stale = [s for s in sorted(args.saves.glob("*.data")) if needs_extract(s, args.out)]
        for save in stale:
            extract_save(save, args.out)
        write_index(args.out)
        threading.Thread(target=watch, args=(args.saves, args.out, args.interval), daemon=True).start()
        print(f"Watching {args.saves} for new saves")
    elif not args.no_watch:
        print("Save folder not found, so not watching. Pass --saves <folder> to enable auto-update.")

    Handler.data_dir = args.out.resolve()
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
