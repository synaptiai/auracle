#!/usr/bin/env python3
"""Block test-file edits while the branch marks a bug fix. See section 3.2."""
import json
import re
import subprocess
import sys

TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|(\.|_)(test|spec)\.")
BUGFIX_BRANCH = re.compile(r"^(fix|hotfix|bugfix)[/\-]", re.IGNORECASE)

data = json.load(sys.stdin)
path = (data.get("tool_input", {}).get("file_path") or "").replace("\\", "/")
if not TEST_FILE.search(path):
    sys.exit(0)

branch = subprocess.run(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    capture_output=True, text=True,
).stdout.strip()

if BUGFIX_BRANCH.match(branch):
    print(
        "BLOCKED: editing a test file while the branch marks a bug fix "
        "(section 3.2). A confident error survives when the regression test "
        "moves with the fix.",
        file=sys.stderr,
    )
    print(
        "Route to approval: ask the user, or land the test change under a "
        "separate intent.",
        file=sys.stderr,
    )
    sys.exit(2)
sys.exit(0)
