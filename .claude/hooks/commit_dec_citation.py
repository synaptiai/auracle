#!/usr/bin/env python3
"""Require a DEC citation when commits change the design register.

Two modes:
  stdin JSON          PreToolUse hook input. Used inside a Claude Code session.
  --commit-msg FILE   Check the staged change against the message file.
                      Used as a git commit-msg hook.
  --range=A...B       Check every commit in a range. Used on pull requests.
"""
import json
import re
import subprocess
import sys

ARCH_DOC = "docs/v1-architecture.md"
DEC_CITE = re.compile(r"DEC-\d{2}")
ROUTE = (
    "Route to approval: cite the affected DEC IDs in the message. If the "
    "change contradicts a DEC, stop and raise it instead."
)


def commit_msg_mode(msg_file):
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True,
    ).stdout.split()
    if ARCH_DOC not in staged:
        sys.exit(0)
    message = open(msg_file, errors="replace").read()
    if not DEC_CITE.search(message):
        print(f"BLOCKED: this commit changes {ARCH_DOC} but cites no DEC ID "
              "(section 2). The register is the design authority.",
              file=sys.stderr)
        print(ROUTE, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


def range_mode(rng):
    shas = subprocess.run(
        ["git", "rev-list", rng], capture_output=True, text=True,
    ).stdout.split()
    bad = []
    for sha in shas:
        out = subprocess.run(
            ["git", "show", "--format=%s", "--name-only", sha],
            capture_output=True, text=True,
        ).stdout
        lines = [l for l in out.strip().split("\n")]
        subject = lines[0] if lines else ""
        files = lines[1:]
        if ARCH_DOC in files and not DEC_CITE.search(subject):
            bad.append(sha[:10])
    if bad:
        print(f"BLOCKED: commits {', '.join(bad)} change {ARCH_DOC} without "
              "a DEC citation (section 2). The register is the design "
              "authority.")
        print(ROUTE)
        sys.exit(2)
    sys.exit(0)


def hook_mode():
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
    if not re.search(r"\bgit\b[^&|;]*\bcommit\b", cmd):
        sys.exit(0)
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True,
    ).stdout.split()
    if ARCH_DOC not in staged:
        sys.exit(0)
    if not DEC_CITE.search(cmd):
        print(
            f"BLOCKED: this commit changes {ARCH_DOC} but cites no DEC ID "
            "(section 2). The register is the design authority.",
            file=sys.stderr,
        )
        print(ROUTE, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--commit-msg":
        commit_msg_mode(sys.argv[2])
    elif len(sys.argv) > 1 and sys.argv[1].startswith("--range="):
        range_mode(sys.argv[1].split("=", 1)[1])
    else:
        hook_mode()
