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

    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
