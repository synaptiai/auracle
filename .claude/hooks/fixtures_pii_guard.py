#!/usr/bin/env python3
"""Block fixture writes that contain PII-like data. DEC-18, DEC-19.

Two modes:
  stdin JSON   PreToolUse hook input. Used inside a Claude Code session.
  FILE...      Check files directly. Used in CI and by hand.
"""
import json
import re
import sys

PATTERNS = [
    ("email address", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}"),
    ("phone number",
     r"(?<![\w.\-])(?:\+\d{1,3}[\s.\-])?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])"
     r"\d{3,4}[\s.\-]?\d{3,4}(?![\w.\-])"),
    ("customer identifier",
     r"\b(?:cust(?:omer)?[_-]?id|account[_-]?id|user[_-]?uuid)\s*[:=]\s*[\"']?"
     r"[A-Za-z0-9][A-Za-z0-9\-]{5,}"),
]


def scan(text):
    hits = []
    for label, pat in PATTERNS:
        found = re.search(pat, text)
        if found:
            hits.append(f"{label}: {found.group(0)[:40]!r}")
    return hits


def file_mode(paths):
    failed = False
    for path in paths:
        hits = scan(open(path, errors="replace").read())
        if hits:
            failed = True
            print(
                f"BLOCKED: {path} fails the synthetic-fixture rule "
                f"(DEC-18, DEC-19). Found " + "; ".join(hits)
            )
    sys.exit(2 if failed else 0)


def hook_mode():
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})
    path = (inp.get("file_path") or "").replace("\\", "/")

    if tool == "Write":
        content = inp.get("content", "")
    elif tool == "Edit":
        content = "\n".join(filter(None, [inp.get("old_string", ""), inp.get("new_string", "")]))
    elif tool == "MultiEdit":
        content = "\n".join(e.get("new_string", "") for e in inp.get("edits", []))
    else:
        sys.exit(0)

    norm = "/" + path.lstrip("/")
    if "/fixtures/" not in norm:
        sys.exit(0)

    hits = scan(content)
    if hits:
        print(
            "BLOCKED: fixtures must stay synthetic (DEC-18, DEC-19). "
            "Found " + "; ".join(hits),
            file=sys.stderr,
        )
        print(
            "Route to approval: ask the user to confirm the value is "
            "synthetic, or replace it with an obviously fake placeholder.",
            file=sys.stderr,
        )
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        file_mode(sys.argv[1:])
    else:
        hook_mode()
