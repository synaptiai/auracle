#!/usr/bin/env python3
"""Join each .tpl file with the shared tokens to produce its .dc.html file.

Each .tpl file holds one artboard and carries a single `/*CSS*/` marker
inside its <helmet> style block. This script replaces that marker with
css.txt and writes the result beside it. Run it from this directory:

    python3 join.py

It prints one line per artboard, and it exits non-zero when a .tpl file
carries no marker. Seed the canvas from the .dc.html files it writes.
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
    for tpl in sorted(glob.glob(os.path.join(HERE, "*.tpl"))):
        with open(tpl, encoding="utf-8") as handle:
            source = handle.read()
        if source.count(MARKER) != 1:
            print(f"{os.path.basename(tpl)}: expected exactly one {MARKER}", file=sys.stderr)
            failures += 1
            continue
        out = tpl[: -len(".tpl")] + ".dc.html"
        with open(out, "w", encoding="utf-8") as handle:
            handle.write(source.replace(MARKER, css))
        print(f"{os.path.basename(out)}: {os.path.getsize(out)} bytes")
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
