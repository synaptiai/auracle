#!/usr/bin/env python3
"""Cases for the synthetic-fixture guard. DEC-18, DEC-19.
Run: python3 .claude/hooks/test_fixtures_pii_guard.py

The guard must block a reachable address and accept a reserved one. RFC 2606
and RFC 6761 reserve .test, .example, .invalid, .localhost and example.com,
so an address under one of them cannot reach a person.

Every DIRTY vector is built at runtime and never written down. CI scans each
changed text file, this file included, so a literal here would fail the rule
this file exists to test.
"""
import importlib.util
import os
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "fixtures_pii_guard.py")
spec = importlib.util.spec_from_file_location("guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

CLEAN, DIRTY = False, True

CASES = [
    # Reserved domains are synthetic by construction. The repository's own
    # fixtures use these, so flagging them would block every legitimate edit.
    ("reserved .test address", CLEAN, 'to: "sam.smith@example.test"'),
    ("reserved .example address", CLEAN, 'to: "dana.doe@acme.example"'),
    ("reserved example.com", CLEAN, 'to: "a@example.com"'),
    ("reserved subdomain", CLEAN, 'to: "a@mail.acme.example"'),
    # A reachable address is the thing the rule exists to stop. Built at
    # runtime, never written down: DEC-18 bans a reachable address from a
    # committed file, and this file is a committed file.
    ("reachable address", DIRTY, 'to: "real.person@' + "gmail" + '.com"'),
    ("reachable company address", DIRTY, 'to: "someone@acme.' + "co.uk" + '"'),
    ("phone number", DIRTY, 'phone: "+44 20 ' + "7946" + ' ' + "0958" + '"'),
    ("account identifier", DIRTY, 'account_id: "AC' + "48812277" + '"'),
    ("no personal data", CLEAN, 'queue: "billing", tier: "high"'),
]

# Issue #74: the rule is absolute inside the corpus and advisory outside it.
# The guard used to fail a pull request for any hit in any changed text file,
# so a document or a test that named a plausible identifier failed the run.
SCOPE_CASES = [
    ("fixtures/gold/case.json", True, "a gold fixture"),
    ("fixtures/taxonomy.json", True, "a fixture file"),
    ("evals/cases/one.md", True, "an eval case"),
    ("src/fixtures/load.ts", True, "a fixture module"),
    ("docs/operations.md", False, "a runbook"),
    ("src/policy/policy.test.ts", False, "a test file"),
    ("README.md", False, "the readme"),
    ("intent/a-change.md", False, "an intent file"),
    # Path forms. `..` is resolved, so this is not corpus; and the corpus
    # spelled in capitals is, because the filesystem resolves it there.
    ("fixtures/../src/x.ts", False, "a path that escapes the corpus"),
    ("./fixtures/a.json", True, "a dot-slash corpus path"),
    ("FIXTURES/taxonomy.json", True, "the corpus in capitals"),
    ("fixtures\\gold\\a.json", True, "the corpus with backslashes"),
    ("my-fixtures-backup/a.json", False, "a directory the name is a substring of"),
    ("evals/cases2/x.md", False, "a directory that extends evals/cases"),
    ("src/fixtures2/x.ts", False, "a directory that extends fixtures"),
]

failures = 0
for path, want, label in SCOPE_CASES:
    got = guard.covered(path)
    if got == want:
        print(f"pass the rule is {'absolute' if want else 'advisory'} for {label}")
    else:
        print(f"FAIL {label} ({path}): want covered={want} got covered={got}")
        failures += 1

# The two directions end to end, because `covered` alone does not prove the
# exit code follows it.
import os
import subprocess
import tempfile

DIRTY_TEXT = 'to: "real.person@' + "gmail" + '.com"\n'
with tempfile.TemporaryDirectory() as _tmp:
    for rel, want_exit, label in [
        ("fixtures/gold/case.json", 2, "a corpus hit blocks"),
        ("docs/operations.md", 0, "a prose hit warns and does not block"),
    ]:
        _path = os.path.join(_tmp, rel)
        os.makedirs(os.path.dirname(_path), exist_ok=True)
        with open(_path, "w", encoding="utf-8") as _handle:
            _handle.write(DIRTY_TEXT)
        _proc = subprocess.run(
            [sys.executable, guard.__file__, _path], capture_output=True, text=True
        )
        if _proc.returncode == want_exit:
            print(f"pass {label}")
        else:
            print(f"FAIL {label}: want exit {want_exit}, got {_proc.returncode}")
            failures += 1

for name, expected, text in CASES:
    got = bool(guard.scan(text))
    if got == expected:
        print(f"pass {name}")
    else:
        print(f"FAIL {name}: want dirty={expected} got dirty={got}")
        failures += 1

print()
if failures:
    print(f"{failures} failure(s)")
    sys.exit(1)
print("all checks passed")
