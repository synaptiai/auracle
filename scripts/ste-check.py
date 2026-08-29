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

Code fences drop out entirely. Inline code collapses to one word, because a
path or an identifier is one term to a reader.

Usage: python3 scripts/ste-check.py FILE [FILE ...]
Exits 1 when a file breaks a rule, and 0 when every file passes.
"""
import re
import sys

MAX_WORDS = 20
MAX_SENTENCES = 6

LIST_ITEM = re.compile(r"^(\d+\.|[-*+])\s")
HEADING = re.compile(r"^#{1,6}\s+")
QUOTE = re.compile(r"^>\s?")
WORD = re.compile(r"[A-Za-z0-9_-]+")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def normalize(text: str) -> str:
    """Strips what a reader does not read as prose."""
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`]*`", "x", text)
    # A heading is its own unit, even with no blank line around it.
    return re.sub(r"(?m)^(#{1,6}\s+.*)$", "\n\\1\n", text)


def units(line: str, is_table: bool) -> list[str]:
    """Returns the parts of a line that carry a sentence."""
    if not (is_table and line.startswith("|")):
        return [line]
    cells = [c.strip() for c in line.strip("|").split("|")]
    # The separator row under a table header carries no prose.
    if all(set(c) <= set("-: ") for c in cells):
        return []
    return cells


def check_file(path: str) -> list[str]:
    findings = []
    for block in re.split(r"\n\s*\n", normalize(open(path).read())):
        lines = []
        for raw in block.splitlines():
            line = QUOTE.sub("", HEADING.sub("", raw.strip()))
            if line:
                lines.append(line)
        if not lines:
            continue
        is_list = any(LIST_ITEM.match(line) for line in lines)
        is_table = any(line.startswith("|") for line in lines)

        for line in lines:
            for unit in units(line, is_table):
                for sentence in SENTENCE_SPLIT.split(unit):
                    count = len(WORD.findall(sentence))
                    if count > MAX_WORDS:
                        findings.append(
                            f"{path}: rule 1, {count} words: {sentence[:80]}"
                        )

        if is_list or is_table:
            continue
        paragraph = " ".join(lines)
        sentences = [s for s in SENTENCE_SPLIT.split(paragraph) if s.strip()]
        if len(sentences) > MAX_SENTENCES:
            findings.append(
                f"{path}: rule 2, {len(sentences)} sentences: {paragraph[:70]}"
            )
    return findings


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python3 scripts/ste-check.py FILE [FILE ...]", file=sys.stderr)
        return 2
    findings = []
    for path in sys.argv[1:]:
        findings.extend(check_file(path))
    for finding in findings:
        print(finding)
    if findings:
        print(f"\n{len(findings)} finding(s)")
        return 1
    print(f"STE clean: {len(sys.argv) - 1} file(s), rules 1 and 2")
    return 0


if __name__ == "__main__":
    sys.exit(main())
