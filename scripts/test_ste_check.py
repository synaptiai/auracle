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
]


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
    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
