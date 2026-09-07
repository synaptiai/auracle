#!/usr/bin/env python3
"""Names the register sections a change touches, and the DECs they cite.

`hooks/commit-msg` refuses a change to `docs/v1-architecture.md` that cites
no DEC. A commit message that names the sections from memory is a guess, and
three in this repository were wrong. Run this and paste what it prints.

Usage: python3 scripts/register-citation.py [REV]
       REV defaults to the staged change.
"""
import re
import subprocess
import sys

DOC = "docs/v1-architecture.md"
HEADING = re.compile(r"^#{2,3} ")
DEC = re.compile(r"DEC-\d{2}")


def run(args: list[str]) -> str:
    return subprocess.run(args, capture_output=True, text=True).stdout


def main() -> int:
    rev = sys.argv[1] if len(sys.argv) > 1 else None
    if rev:
        diff = run(["git", "diff", "-U0", f"{rev}~1", rev, "--", DOC])
        after = run(["git", "show", f"{rev}:{DOC}"]).split("\n")
    else:
        diff = run(["git", "diff", "-U0", "--cached", "--", DOC])
        after = open(DOC, encoding="utf-8").read().split("\n")
    if not diff.strip():
        print(f"{DOC} is unchanged. No citation is needed.")
        return 0

    heads = [(i, line) for i, line in enumerate(after) if HEADING.match(line)]
    touched: dict[str, int] = {}
    for hunk in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", diff, re.M):
        start = int(hunk.group(1))
        for line in range(start, start + int(hunk.group(2) or 1)):
            above = [(i, t) for i, t in heads if i < line]
            if above:
                touched.setdefault(above[-1][1], above[-1][0])

    cited: set[str] = set()
    for name, index in touched.items():
        end = min([i for i, _ in heads if i > index], default=len(after))
        cited |= set(DEC.findall("\n".join(after[index:end])))

    print("Sections touched:")
    for name in sorted(touched):
        print(f"  {name}")
    print("\nDECs those sections name:")
    print("  " + ", ".join(sorted(cited)) if cited else "  none")
    added = set(DEC.findall("\n".join(
        l for l in diff.split("\n") if l.startswith("+") and not l.startswith("+++"))))
    print("\nDECs on the changed lines:")
    print("  " + (", ".join(sorted(added)) if added else "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
