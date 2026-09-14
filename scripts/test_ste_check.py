#!/usr/bin/env python3
"""Cases for the STE checker. Run: python3 scripts/test_ste_check.py

Each case writes one temporary markdown file and asserts the exit code.
The list and table exclusions are policy, so they get cases of their own.
"""
import os
import subprocess
import sys
import tempfile

CHECKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ste-check.py")
PASS, FAIL = 0, 1

LONG = "word " * 25
SEVEN = " ".join(f"Sentence number {n} here." for n in range(7))

CASES = [
    ("short sentence passes", PASS, "The relay sends first.\n"),
    ("21 words breaks rule 1", FAIL, LONG.strip() + ".\n"),
    ("six sentences pass", PASS,
     " ".join(f"Line {n} is short." for n in range(6)) + "\n"),
    ("seven sentences break rule 2", FAIL, SEVEN + "\n"),
    # Front matter is metadata, not prose. No shipped file opens with it, but a
    # run that names a design document reads one, and its keys would read as
    # one 30-word sentence.
    ("front matter at the start is not prose", PASS,
     "---\ntitle: \"" + ("word " * 20).strip() + "\"\nauthor: code\n"
     + "tags: [a, b, c]\n---\n\nThe relay sends first.\n"),
    # Only at the start. A thematic break later in a document is a rule,
    # and the prose between two of them is prose.
    ("prose between two later rules still breaks rule 1", FAIL,
     "The relay sends first.\n\n---\n" + LONG.strip() + ".\n---\n"),
    ("a long sentence after front matter still breaks rule 1", FAIL,
     "---\ntitle: short\n---\n\n" + LONG.strip() + ".\n"),
    # A block that opens and never closes is not front matter, so its text
    # stays prose rather than vanishing from the check.
    ("an unclosed opening rule is not front matter", FAIL,
     "---\n" + LONG.strip() + ".\n"),
    # A block is front matter only when every line in it is a known key. A
    # blank line or a sentence ends it, so prose between an opening rule and a
    # later one stays prose, and a later pair of rules hides nothing.
    ("prose after a blank line under an opening rule is not front matter", FAIL,
     "---\n\n" + LONG.strip() + ".\n\n---\n"),
    ("front matter that runs into a blank line is not front matter", FAIL,
     "---\ntitle: x\n\n" + LONG.strip() + ".\n\n---\n"),
    ("a later pair of rules after real front matter hides nothing", FAIL,
     "---\ntitle: short\n---\n\nShort.\n\n---\n\n" + LONG.strip() + ".\n\n---\n"),
    # Front matter holds metadata keys alone. Prose between two rules is prose,
    # with or without a key above it and with no blank line anywhere.
    ("prose between an opening rule and its closer is not front matter", FAIL,
     "---\n" + LONG.strip() + ".\n---\n\nShort.\n"),
    ("a key line does not make the prose under it metadata", FAIL,
     "---\ntitle: x\n" + LONG.strip() + ".\n---\n"),
    ("a later rule with no blank line hides nothing after front matter", FAIL,
     "---\ntitle: b\n---\n" + LONG.strip() + ".\n---\n"),
    ("an unknown key is not front matter", FAIL,
     "---\nnote: " + LONG.strip() + ".\n---\n"),
    # Only at the very start. A block further down is a rule and prose, and the
    # prose above it is never dropped.
    ("front matter below prose is not front matter", FAIL,
     LONG.strip() + ".\n\n---\ntitle: x\n---\n"),
    ("front matter below prose with no blank line is not front matter", FAIL,
     LONG.strip() + ".\n---\ntitle: x\n---\n"),
    # A block that never closes is not front matter, even at the end of a file.
    ("a key line that never closes is prose", FAIL,
     "---\ntitle: " + LONG.strip() + "."),
    # A key is a key only with its colon. A sentence that opens with a key word
    # is prose.
    ("a line that only opens with a key word is prose", FAIL,
     "---\ntitle: x\ntags are " + LONG.strip() + ".\n---\n"),
    # A byte-order mark is not text. Front matter after one is still metadata.
    ("front matter after a byte-order mark is not prose", PASS,
     "\ufeff---\ntitle: \"" + ("word " * 20).strip() + "\"\n---\n\nThe relay sends first.\n"),
    # Rule 2 is prose only. A procedure of seven steps is legal.
    ("seven numbered steps pass", PASS,
     "\n".join(f"{n}. Step {n} runs." for n in range(1, 8)) + "\n"),
    ("seven bullets pass", PASS,
     "\n".join(f"- Point {n} holds." for n in range(1, 8)) + "\n"),
    ("seven table rows pass", PASS,
     "| A | B |\n|---|---|\n" + "\n".join(f"| r{n} | v{n} |" for n in range(7)) + "\n"),
    # A long sentence still counts inside a list or a table cell.
    ("long sentence in a list breaks rule 1", FAIL, f"- {LONG.strip()}.\n"),
    ("long sentence in a table cell breaks rule 1", FAIL,
     f"| A | B |\n|---|---|\n| x | {LONG.strip()}. |\n"),
    # A fence holds code, and code is not prose.
    ("code fence is ignored", PASS, f"```\n{LONG}\n```\n"),
    ("inline code counts as one word", PASS,
     "The file `src/coordinator/coordinator.ts` holds it.\n"),
    # Two paragraphs of six sentences are not one paragraph of twelve.
    ("blank line separates paragraphs", PASS,
     " ".join(f"Line {n} is short." for n in range(6)) + "\n\n"
     + " ".join(f"Line {n} is short." for n in range(6)) + "\n"),
    ("heading is its own unit", PASS,
     "# Title\n" + " ".join(f"Line {n} is short." for n in range(6)) + "\n"),
    # Rule 1 measures a sentence, and every document here wraps near 80
    # columns. Measured line by line, a wrapped sentence is two short
    # fragments and the rule enforces nothing.
    ("a sentence wrapped across lines is one sentence", FAIL,
     "word " * 12 + "\n" + "word " * 13 + "end.\n"),
    ("a wrapped sentence under the limit still passes", PASS,
     "word " * 8 + "\n" + "word " * 8 + "end.\n"),
    # A unit is a paragraph, a list item or a table cell. Lines join inside
    # one and never across one, so neither case below may be merged.
    ("a wrapped list item is one sentence", FAIL,
     "- " + "word " * 12 + "\n  " + "word " * 13 + "end.\n"),
    ("two short list items are not one sentence", PASS,
     "- " + "word " * 14 + "end.\n- " + "word " * 14 + "end.\n"),
    ("two short table cells are not one sentence", PASS,
     "| A | B |\n|---|---|\n| " + "word " * 14 + "end. | " + "word " * 14 + "end. |\n"),
    ("two short table rows are not one sentence", PASS,
     "| A |\n|---|\n| " + "word " * 14 + "end. |\n| " + "word " * 14 + "end. |\n"),
    # Without the full stops. A cell rarely ends in one, and a merge of two
    # cells that each end in one still splits into two sentences — so the two
    # cases above passed against a version that merged a whole table block.
    ("unterminated cells are not one sentence", PASS,
     "| A | B |\n|---|---|\n| " + ("word " * 12).strip() + " | " + ("word " * 12).strip() + " |\n"),
    ("unterminated list items are not one sentence", PASS,
     "- " + ("word " * 12).strip() + "\n- " + ("word " * 12).strip() + "\n"),
    # A full stop inside a bold lead-in ends a sentence. The period sits
    # before the closing marker and not before the space, so the split saw no
    # boundary and merged the lead-in with the sentence after it.
    ("a bold lead-in ends a sentence", PASS,
     "**" + ("word " * 12).strip() + ".** " + ("word " * 12).strip() + ".\n"),
    ("a bold lead-in that is itself too long still breaks rule 1", FAIL,
     "**" + ("word " * 21).strip() + ".** Short tail.\n"),
    # No boundary without the space. An emphasised word mid-sentence must not
    # end one, or a 30-word sentence reads as two short ones.
    ("emphasis inside a sentence is not a boundary", FAIL,
     ("word " * 10).strip() + " **" + ("word " * 5).strip() + "** " + ("word " * 8).strip() + ".\n"),
    # Rule 2 reads the prose that opens a block. `is_list` is true for the
    # whole block, so a paragraph of any length passed as long as a bullet
    # followed it with no blank line between them.
    ("seven sentences break rule 2 even when a list follows", FAIL,
     SEVEN + "\n- One bullet.\n- Another bullet.\n"),
    ("a list with a short lead-in still passes", PASS,
     "Two rules apply here. Both are short.\n"
     + "\n".join(f"- Point {n} holds." for n in range(1, 8)) + "\n"),
    # Three markers, not two. `***bold-italic.***` and `**_bold-italic._**`
    # are ordinary Markdown, and a cap of two merged both with the sentence
    # after them. The suite could not tell a cap of two from no cap at all.
    ("a bold-italic lead-in ends a sentence", PASS,
     "***" + ("word " * 12).strip() + ".*** " + ("word " * 12).strip() + ".\n"),
    ("a nested-emphasis lead-in ends a sentence", PASS,
     "**_" + ("word " * 12).strip() + "._** " + ("word " * 12).strip() + ".\n"),
    # A closing quote or bracket sits between the stop and the space.
    ("a quoted sentence ends a sentence", PASS,
     "He wrote \"" + ("word " * 11).strip() + ".\" " + ("word " * 12).strip() + ".\n"),
    # An abbreviation is not a sentence end. Splitting there reads one long
    # sentence as two short ones and rule 1 enforces nothing.
    ("an abbreviation does not end a sentence", FAIL,
     "The relay retries a delivery the adapter never confirmed, e.g. a timeout, "
     "and the operator reviews every one of these before it escalates.\n"),
    # A row, not a cell. The two terminated row cases above pass against a
    # mutation that joins a whole table, because the full stops re-split the
    # merged text. These do not.
    ("unterminated table rows are not one sentence", PASS,
     "| A |\n|---|\n| " + ("word " * 12).strip() + " |\n| " + ("word " * 12).strip() + " |\n"),
    # An escaped pipe is content. Splitting on it turned one long cell into
    # two short fragments, and the cell shipped clean.
    ("an escaped pipe does not divide a cell", FAIL,
     "| A |\n|---|\n| " + ("word " * 12).strip() + " \\| " + ("word " * 12).strip() + ". |\n"),
    ("a sentence that is only the word No still ends", PASS,
     "Does the relay retry a delivery whose state it cannot read? No. "
     "It escalates instead.\n"),
    # A blank line still ends a unit, and a heading is still its own.
    ("two wrapped paragraphs stay apart", PASS,
     "word " * 8 + "\n" + "word " * 8 + "end.\n\n"
     + "word " * 8 + "\n" + "word " * 8 + "end.\n"),
]


def check_bytes(name, want, payload):
    """One case that writes bytes rather than text."""
    with tempfile.NamedTemporaryFile("wb", suffix=".md", delete=False) as handle:
        handle.write(payload)
        path = handle.name
    try:
        got = subprocess.run([sys.executable, CHECKER, path],
                             capture_output=True, text=True)
        if got.returncode != want:
            print(f"FAIL {name}: want exit {want}, got {got.returncode}")
            return 1
        if "not UTF-8" not in got.stdout:
            print(f"FAIL {name}: wanted the finding to name the encoding")
            return 1
        print(f"pass {name}")
        return 0
    finally:
        os.unlink(path)


def load_checker():
    """Imports ste-check.py as a module, despite the hyphen in its name."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("ste_check", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_default_set() -> int:
    """The no-argument form must check the shipped set, and must not pass empty.

    `pnpm run check:ste` and the Guardrails workflow both call the checker
    with no arguments, so the default set is the only definition of what
    ships. Two ways that can go wrong silently, and both are closed here. A
    glob that matches nothing would print "STE clean: 0 file(s)" and exit 0,
    retiring the check without saying so. And a default set that quietly lost
    README.md or AGENTS.md would still look healthy.
    """
    failures = 0
    module = load_checker()

    proc = subprocess.run([sys.executable, CHECKER], capture_output=True, text=True)
    if proc.returncode != PASS:
        failures += 1
        print(f"FAIL the shipped set passes with no arguments: exit {proc.returncode}")
        print(f"     {(proc.stdout or proc.stderr).strip()}")
    else:
        print("pass the shipped set passes with no arguments")

    # The documents the convention exists for must be in the set. A default
    # that silently lost one would still look healthy.
    #
    # Repository-relative paths, not basenames: fixtures/README.md collapses
    # onto the root README.md in a basename set, so a basename sentinel could
    # not see the fixtures glob disappear.
    root = os.path.dirname(os.path.dirname(os.path.realpath(CHECKER)))
    paths = {os.path.relpath(p, root) for p in module.shipped_files()}
    if len(paths) < 10:
        failures += 1
        print(f"FAIL the shipped set is not vacuous: only {len(paths)} file(s)")
    for required in ("README.md", "AGENTS.md", "CONTRIBUTING.md", "REVIEW.md",
                     "fixtures/README.md", "docs/v1-architecture.md"):
        if required not in paths:
            failures += 1
            print(f"FAIL the shipped set names {required}")
    # Every glob must contribute, so retiring one directory cannot pass.
    if module.empty_globs():
        failures += 1
        print(f"FAIL these globs match nothing: {module.empty_globs()}")
    if not failures:
        print(f"pass the shipped set names the shipped documents ({len(paths)} files)")

    # An expansion that matches nothing must fail rather than report clean.
    empty = load_checker()
    # One retired pattern beside two live ones: the case a total-emptiness
    # check cannot see.
    empty.SHIPPED_GLOBS = ("README.md", "AGENTS.md", "no-such-directory/*.md")
    argv = sys.argv
    try:
        sys.argv = ["ste-check"]
        code = empty.main()
    finally:
        sys.argv = argv
    if code == PASS:
        failures += 1
        print("FAIL a retired glob must not report clean")
    else:
        print("pass a retired glob is a fault, not a pass")
    return failures


def main() -> int:
    label = {PASS: "pass", FAIL: "fail"}
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for index, (name, want, body) in enumerate(CASES):
            path = os.path.join(tmp, f"case{index}.md")
            with open(path, "w") as handle:
                handle.write(body)
            proc = subprocess.run(
                [sys.executable, CHECKER, path], capture_output=True, text=True
            )
            if proc.returncode == want:
                print(f"pass {name}")
            else:
                failures += 1
                print(
                    f"FAIL {name}: want {label[want]}, got "
                    f"{label.get(proc.returncode, proc.returncode)}"
                )
                if proc.stdout.strip():
                    print(f"     {proc.stdout.strip().splitlines()[0]}")
    # A file this checker cannot decode must be a finding, not a traceback.
    failures += check_bytes("a file that is not UTF-8 is a finding", FAIL,
                            b"\xff\xfe# not utf-8\n")

    failures += check_default_set()

    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
