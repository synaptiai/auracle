#!/usr/bin/env python3
"""Route live-database commands to approval. DEC-17, DEC-19."""
import json
import re
import sys

DB_COMMAND = re.compile(
    r"\b(psql|pg_dump|pg_restore|createdb|dropdb|pscale|"
    r"migrate|alembic|flyway)\b"
)
LOCAL_TARGET = re.compile(
    r"(localhost|127\.0\.0\.1|::1|\-\-local|docker exec|DATABASE_URL=.*localhost)"
)

cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
if not DB_COMMAND.search(cmd):
    sys.exit(0)
if LOCAL_TARGET.search(cmd):
    sys.exit(0)

print(
    "BLOCKED: this command may touch a live database (DEC-17, DEC-19). "
    "The adopter is the data controller.",
    file=sys.stderr,
)
print(
    "Route to approval: ask the user to run it, or retarget the command at "
    "a local instance.",
    file=sys.stderr,
)
sys.exit(2)
