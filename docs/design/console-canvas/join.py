#!/usr/bin/env python3
"""Join each .tpl file with the shared tokens to produce its .dc.html file.

Each .tpl file holds one artboard and carries a single `/*CSS*/` marker
inside its <helmet> style block. This script replaces that marker with
css.txt and writes the result beside it. Run it from this directory:

    python3 join.py

It prints one line per artboard. It skips a .tpl file that does not carry
exactly one marker and removes that artboard's old .dc.html, so nobody seeds
the canvas from it. It names a .dc.html file that has no .tpl file. It writes
the others, and exits non-zero at the end when any of this happens. It also
exits non-zero when it finds no .tpl file.
"""
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MARKER = "/*CSS*/"

def main() -> int:
    with open(os.path.join(HERE, "css.txt"), encoding="utf-8") as handle:
        css = handle.read().rstrip("\n")
    failures = 0
    templates = sorted(glob.glob(os.path.join(HERE, "*.tpl")))
    if not templates:
        print(f"no .tpl file in {HERE}", file=sys.stderr)
        return 1
    for tpl in templates:
        with open(tpl, encoding="utf-8") as handle:
            source = handle.read()
        out = tpl[: -len(".tpl")] + ".dc.html"
        if source.count(MARKER) != 1:
            failures += 1
            message = f"{os.path.basename(tpl)}: expected exactly one {MARKER}"
            try:
                os.remove(out)
                message += f"; removed {os.path.basename(out)}"
            except FileNotFoundError:
                pass
            except OSError as error:
                message += f"; could not remove {os.path.basename(out)} ({error.strerror or error})"
            print(message, file=sys.stderr)
            continue
        with open(out, "w", encoding="utf-8") as handle:
            handle.write(source.replace(MARKER, css))
        print(f"{os.path.basename(out)}: {os.path.getsize(out)} bytes")
    # An artboard whose .tpl file is gone keeps its last .dc.html, and a
    # canvas seeded from it shows a page that no longer exists.
    for joined in sorted(glob.glob(os.path.join(HERE, "*.dc.html"))):
        if joined[: -len(".dc.html")] + ".tpl" not in templates:
            print(f"{os.path.basename(joined)}: no .tpl file joins to it", file=sys.stderr)
            failures += 1
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
