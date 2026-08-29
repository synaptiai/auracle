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

failures = 0
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
