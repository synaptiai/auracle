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


def known_decs():
    """DEC ids the register actually defines. An unknown id is not a citation."""
    try:
        with open(ARCH_DOC, errors="replace") as handle:
            return set(DEC_CITE.findall(handle.read()))
    except OSError:
        return set()


def cites_a_real_dec(message):
    """True when the message names at least one DEC the register defines.

    A bare pattern match accepted DEC-99, which cites nothing. The eval suite
    already validates its own citations against the register; this brings the
    commit rule up to the same standard.
    """
    known = known_decs()
    cited = set(DEC_CITE.findall(message))
    if not cited:
        return False
    # No register on disk (a bare checkout): fall back to the pattern.
    return bool(cited & known) if known else True
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
    if not cites_a_real_dec(message):
        print(f"BLOCKED: this commit changes {ARCH_DOC} but cites no DEC ID "
              "(section 2). The register is the design authority.",
              file=sys.stderr)
        print(ROUTE, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


def read_git(args, what):
    """The output of a git command, or a block when git cannot answer.

    A commit the guard cannot read is a commit it has not checked, so an
    error here blocks rather than reading as an empty answer.
    """
    done = subprocess.run(["git", *args], capture_output=True, text=True)
    if done.returncode != 0:
        print(f"BLOCKED: cannot read {what}: {done.stderr.strip()}")
        sys.exit(2)
    return done.stdout


def commit_message(sha):
    """Subject and body. The commit-msg hook reads the whole message, so this
    mode must too: a DEC cited in the body is the normal case."""
    return read_git(["log", "-1", "--format=%s%n%b", sha], f"the message of {sha[:10]}")


def changed_files(sha):
    """Files the commit contributed, merges included.

    `git show --name-only` prints no file list for a merge, so a merge that
    edited the register was never checked. `--first-parent` overcorrected:
    it reports a merge as if it made every change on the branch, so the
    synthetic merge commit GitHub builds for a pull request failed on a
    citation its generated message can never carry.

    `--cc` reports what a merge changed against *every* parent, which is the
    evil merge and nothing else. A clean merge lists no file and passes. A
    merge that edited the register on its own still lists it and is checked.
    An ordinary commit is unaffected.
    """
    return read_git(
        ["diff-tree", "-r", "--no-commit-id", "--name-only", "--cc", sha],
        f"the files of {sha[:10]}",
    ).split()


def range_mode(rng):
    # A range the guard cannot read is a range it has not checked, so it
    # blocks. An empty base is what a step that reads a pull request's base
    # gets on a push, and an unknown base is a shallow checkout.
    base = rng.split("..")[0]
    listed = subprocess.run(
        ["git", "rev-list", rng], capture_output=True, text=True,
    )
    if not base or listed.returncode != 0:
        reason = "it names no base commit" if not base else listed.stderr.strip()
        print(f"BLOCKED: cannot read the range '{rng}': {reason}.")
        sys.exit(2)
    shas = listed.stdout.split()
    bad = []
    for sha in shas:
        if ARCH_DOC in changed_files(sha) and not cites_a_real_dec(commit_message(sha)):
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
    if not cites_a_real_dec(cmd):
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
