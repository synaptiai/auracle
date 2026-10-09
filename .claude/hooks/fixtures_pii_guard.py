#!/usr/bin/env python3
"""Block fixture writes that contain PII-like data. DEC-18, DEC-19.

Two modes:
  stdin JSON   PreToolUse hook input. Used inside a Claude Code session.
  FILE...      Check files directly. Used in CI and by hand.
"""
import json
import posixpath
import re
import sys

# RFC 2606 and RFC 6761 reserve these for documentation and testing. An
# address under one of them cannot reach a person, so it is synthetic by
# construction and the rule is about reachable addresses.
RESERVED_EMAIL = re.compile(
    r"@(?:[A-Za-z0-9-]+\.)*(?:test|example|invalid|localhost)$"
    r"|@(?:[A-Za-z0-9-]+\.)*example\.(?:com|net|org)$",
    re.IGNORECASE,
)

PATTERNS = [
    ("email address", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"),
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
        for found in re.finditer(pat, text):
            value = found.group(0)
            if label == "email address":
                domain = value[value.rindex("@"):]
                if RESERVED_EMAIL.search(domain):
                    continue
            hits.append(f"{label}: {value[:40]!r}")
            break
    return hits


def covered(path):
    """True where the synthetic rule is absolute.

    DEC-18 is about the corpus this repository ships. A fixture or an eval
    case is data an adopter inherits, so a reachable address there is a
    defect whatever its provenance. Prose is different: a runbook may need to
    show what a real-looking address looks like, and blocking that made a
    docs-only pull request fail on its own example.

    REVIEW.md extends the rule to fixtures, evals and examples. Matching only
    '/fixtures/' left the fixture modules under src/ and the eval cases
    outside the guard, which is most of the surface it names.
    """
    # `..` is resolved before the decision, so `fixtures/../src/x.ts` is not
    # read as corpus. The comparison is lower-cased because macOS and Windows
    # resolve `FIXTURES/taxonomy.json` to the real corpus file, and a guard
    # that missed that spelling would be silent on a real write.
    norm = posixpath.normpath("/" + path.replace("\\", "/").lstrip("/")).lower()
    return (
        "/fixtures/" in norm
        or "/evals/cases/" in norm
        or re.search(r"/fixtures?[.-][^/]*$", norm) is not None
        or norm.endswith("/fixtures.ts")
    )


def file_mode(paths):
    """Blocks inside the corpus, warns outside it.

    The rule covers the corpus only. A document or a test outside it can
    mention a plausible identifier. A block there fails the whole run where
    the rule does not apply. Outside the corpus a hit is printed, so a reader
    sees it, but it does not gate the change.
    """
    failed = False
    warned = False
    for path in paths:
        hits = scan(open(path, errors="replace").read())
        if not hits:
            continue
        if covered(path):
            failed = True
            print(
                f"BLOCKED: {path} fails the synthetic-fixture rule "
                f"(DEC-18, DEC-19). Found " + "; ".join(hits)
            )
        else:
            warned = True
            print(
                f"warning: {path} names something that looks like real data. "
                f"Outside fixtures/ and evals/cases/ this does not block. "
                f"Found " + "; ".join(hits)
            )
    if warned and not failed:
        print(
            "\nThe synthetic rule is absolute inside fixtures/ and "
            "evals/cases/ only. fixtures/README.md names the reserved "
            "domains that are synthetic by construction."
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

    if not covered(path):
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
