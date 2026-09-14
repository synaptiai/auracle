#!/usr/bin/env python3
"""Simplified Technical English checker for shipped markdown.

The convention in AGENTS.md has five rules. This script enforces the two that
a machine can decide:

  1. Maximum 20 words in a sentence.
  2. Maximum 6 sentences in a paragraph.

Rules 3 to 5 (active voice, present tense, one name for one meaning) need a
reader. No checker here claims to cover them. Do not read a pass as coverage
of those three.

Rule 2 applies to prose only. A numbered procedure and a table are not
paragraphs, and counting their entries as sentences would forbid a list of
seven steps. That exclusion is a decision, not an oversight.

Rule 1 measures a sentence, so it reads a unit and not a line. A unit is a
paragraph, a list item or a table cell. Lines join inside a unit and never
across one. Every document here wraps its prose near 80 columns, so a
sentence measured line by line is two short fragments and the rule enforces
nothing.

Rule 2 reads the prose that opens a block. A block whose prose runs into a
list still holds prose, and skipping the whole block let a paragraph of any
length pass as long as a bullet followed it.

Code fences drop out entirely. Inline code collapses to one word, because a
path or an identifier is one term to a reader.

A YAML front-matter block that opens a file drops out too, when every line in
it is a known metadata key. No file in the shipped set opens with one; the
rule serves a run that names a file, such as a design document.

Usage: python3 scripts/ste-check.py [FILE ...]
With no FILE, it checks the shipped set named by SHIPPED_GLOBS below.
That set is the one definition. `pnpm run check:ste` and the Guardrails
workflow both call this script with no arguments, so neither restates the
list and the two cannot drift apart.
Exits 1 when a file breaks a rule, and 0 when every file passes.
"""
import glob
import os
import re
import sys

MAX_WORDS = 20
MAX_SENTENCES = 6

# The markdown this repository ships to a reader. Internal notes under
# docs/internal/ are deliberately absent: a working document should not gate
# a pull request.
SHIPPED_GLOBS = (
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "REVIEW.md",
    "docs/*.md",
    # Each of these is one level deep, and `docs/*.md` does not recurse. A
    # glob that silently covers nothing reads exactly like a clean run, so
    # `check-docs.py` keeps both directories flat and the retired-glob report
    # below fails if either name stops matching.
    #
    # The archive is frozen, which means no file joins it — not that the
    # files already there stop being read. They passed this checker as
    # `intent/*.md` before they moved, and dropping them would have retired
    # the rule for 35 shipped documents without saying so.
    "docs/decisions/*.md",
    "intent/*.md",
    "intent/archive/*.md",
    "fixtures/README.md",
    "db/README.md",
)

# realpath, not abspath: through a symlink, abspath lands outside the
# repository and every glob returns nothing.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def shipped_files() -> list[str]:
    """Expands SHIPPED_GLOBS against the repository, not the caller's cwd."""
    found: list[str] = []
    for pattern in SHIPPED_GLOBS:
        found.extend(sorted(glob.glob(os.path.join(REPO_ROOT, pattern))))
    return found


def empty_globs() -> list[str]:
    """The patterns that match nothing.

    Checking the total is not enough. A renamed directory retires its own
    pattern while the others still match, so the run reports a smaller clean
    number and nobody reads it as a loss. The shell form this replaced passed
    the unexpanded literal to the checker, which failed loudly on it.
    """
    return [
        pattern
        for pattern in SHIPPED_GLOBS
        if not glob.glob(os.path.join(REPO_ROOT, pattern))
    ]

LIST_ITEM = re.compile(r"^(\d+\.|[-*+])\s")
HEADING = re.compile(r"^#{1,6}\s+")
QUOTE = re.compile(r"^>\s?")
WORD = re.compile(r"[A-Za-z0-9_-]+")
CELL_SPLIT = re.compile(r"(?<!\\)\|")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[*_'\")\]]*\s+")
# A full stop that ends a word rather than a sentence. `No.` is absent on
# purpose: this repository writes "No. It never retries", where `No` is the
# whole sentence. An abbreviation this list does not hold still ends a
# sentence here, and the count is then two short ones rather than one long.
ABBREVIATION = re.compile(
    r"(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx|Fig|Dr|Mr|Ms|St|Inc|Ltd|Jr|Sr)\.$"
)


def sentences(text: str) -> list[str]:
    """Splits on a sentence boundary, and never inside an abbreviation."""
    parts = SENTENCE_SPLIT.split(text)
    joined: list[str] = []
    for part in parts:
        if joined and ABBREVIATION.search(joined[-1]):
            joined[-1] = f"{joined[-1]} {part}"
        else:
            joined.append(part)
    return joined


# The keys front matter holds in this repository. A line with any other shape
# makes the block prose, so a sentence cannot pass as metadata by sitting
# between two rules. Documents under docs/design/ use only these five.
FRONT_MATTER_KEYS = ("title", "author", "tags", "created_at", "updated_at")
FRONT_MATTER_LINE = re.compile(
    r"(?:" + "|".join(FRONT_MATTER_KEYS) + r")[ \t]*:(?:[ \t].*)?"
)
RULE_LINE = re.compile(r"---[ \t]*")


def strip_front_matter(text: str) -> str:
    """Drops a YAML block that opens the file and holds metadata keys alone.

    The block must close, and every line in it must be a known key. Otherwise
    nothing is dropped and the lines are read as prose, so a malformed block
    is a visible finding rather than a silent pass.
    """
    lines = text.split("\n")
    if not lines or not RULE_LINE.fullmatch(lines[0]):
        return text
    for index in range(1, len(lines)):
        if RULE_LINE.fullmatch(lines[index]):
            return "\n".join(lines[index + 1:])
        if not FRONT_MATTER_LINE.fullmatch(lines[index]):
            return text
    return text


def normalize(text: str) -> str:
    """Strips what a reader does not read as prose."""
    text = strip_front_matter(text)
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`]*`", "x", text)
    # A heading is its own unit, even with no blank line around it.
    return re.sub(r"(?m)^(#{1,6}\s+.*)$", "\n\\1\n", text)


def units(line: str, is_table: bool) -> list[str]:
    """Returns the parts of a line that carry a sentence."""
    if not (is_table and line.startswith("|")):
        return [line]
    # An escaped pipe is content, not a cell wall. Splitting on it broke one
    # 24-word cell into two short fragments and the cell shipped clean.
    cells = [c.strip() for c in CELL_SPLIT.split(line.strip("|"))]
    # The separator row under a table header carries no prose.
    if all(set(c) <= set("-: ") for c in cells):
        return []
    return cells


def prose_units(lines: list[str], is_list: bool, is_table: bool) -> list[str]:
    """Returns the units a sentence may span, in order.

    A cell never joins its neighbour and an item never joins the next one.
    Joining a whole block instead would read a row of two short cells as one
    long sentence, and a list of short bullets the same way.
    """
    if is_table:
        return [cell for line in lines for cell in units(line, True)]
    if is_list:
        items: list[list[str]] = []
        for line in lines:
            # A continuation line is indented, and the caller has already
            # stripped that indent. So anything that is not a new marker
            # belongs to the item above it.
            if LIST_ITEM.match(line) or not items:
                items.append([line])
            else:
                items[-1].append(line)
        return [" ".join(item) for item in items]
    return [" ".join(lines)]


def read_text(path: str) -> tuple[str, list[str]]:
    """Returns (text, findings). A file this script cannot read is a finding.

    `scripts/check-docs.py` runs beside this one over the same file list. A
    document that is not UTF-8 was a finding there and a traceback here.
    """
    try:
        # `utf-8-sig`, so a byte-order mark is not read as text before the
        # front matter. Bytes that are not UTF-8 still raise.
        with open(path, encoding="utf-8-sig") as handle:
            return handle.read(), []
    except UnicodeDecodeError:
        return "", [f"{path}: not UTF-8"]
    except OSError as error:
        return "", [f"{path}: {error.strerror or error}"]


def check_file(path: str) -> list[str]:
    text, findings = read_text(path)
    if findings:
        return findings
    for block in re.split(r"\n\s*\n", normalize(text)):
        lines = []
        for raw in block.splitlines():
            line = QUOTE.sub("", HEADING.sub("", raw.strip()))
            if line:
                lines.append(line)
        if not lines:
            continue
        is_list = any(LIST_ITEM.match(line) for line in lines)
        is_table = any(line.startswith("|") for line in lines)

        for unit in prose_units(lines, is_list, is_table):
            for sentence in sentences(unit):
                count = len(WORD.findall(sentence))
                if count > MAX_WORDS:
                    findings.append(
                        f"{path}: rule 1, {count} words: {sentence[:80]}"
                    )

        if is_table:
            continue
        # The prose that opens the block, which stops at the first list
        # marker. `is_list` is true for the whole block, so returning here
        # skipped rule 2 for a paragraph of any length that a bullet
        # happened to follow. Two files on the pinned list are shaped that
        # way today, and both pass only because their prose is short.
        prose = []
        for line in lines:
            if LIST_ITEM.match(line):
                break
            prose.append(line)
        if not prose:
            continue
        paragraph = " ".join(prose)
        counted = [s for s in sentences(paragraph) if s.strip()]
        if len(counted) > MAX_SENTENCES:
            findings.append(
                f"{path}: rule 2, {len(counted)} sentences: {paragraph[:70]}"
            )
    return findings


def main() -> int:
    explicit = sys.argv[1:]
    if explicit:
        paths = explicit
    else:
        # A pattern that matches nothing would otherwise shrink the clean
        # count in silence, so a renamed directory would retire its part of
        # the check and the run would still pass. Every pattern must match.
        missing = empty_globs()
        if missing:
            print(
                "ste-check: these SHIPPED_GLOBS patterns match no file: "
                + ", ".join(missing)
                + ". A renamed or deleted path retires the check for it.",
                file=sys.stderr,
            )
            return 2
        paths = shipped_files()
    findings = []
    for path in paths:
        findings.extend(check_file(path))
    for finding in findings:
        print(finding)
    if findings:
        print(f"\n{len(findings)} finding(s)")
        return 1
    print(f"STE clean: {len(paths)} file(s), rules 1 and 2")
    return 0


if __name__ == "__main__":
    sys.exit(main())
