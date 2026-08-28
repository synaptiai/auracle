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

# A heredoc body is data, not a command: a commit message that names
# `db:migrate` is prose. The body stays in scope when the line that opens it
# runs an interpreter, because `bash <<EOF ... psql ... EOF` does execute.
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
INTERPRETER = re.compile(
    r"\b(bash|sh|zsh|ksh|dash|env|eval|exec|xargs|source|"
    r"python|python3|node|ruby|perl|php)\b"
)


def strip_heredoc_bodies(command: str) -> str:
    """Drop inert heredoc bodies. Keep every line that can execute."""
    lines = command.splitlines()
    kept: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        match = HEREDOC_START.search(line)
        if match and not INTERPRETER.search(line):
            delimiter = match.group(2)
            i += 1
            while i < len(lines) and lines[i].strip() != delimiter:
                i += 1
        i += 1
    return "\n".join(kept)


def main() -> int:
    raw = json.load(sys.stdin).get("tool_input", {}).get("command", "")
    # Both tests read the same text: a heredoc body must never supply the
    # 'localhost' that exempts a command aimed at a live database.
    cmd = strip_heredoc_bodies(raw)
    if not DB_COMMAND.search(cmd):
        return 0
    if LOCAL_TARGET.search(cmd):
        return 0

    print(
        "BLOCKED: this command may touch a live database (DEC-17, DEC-19). "
        "The adopter is the data controller.",
        file=sys.stderr,
    )
    print(
        "Route to approval: ask the user to run it, or retarget the command "
        "at a local instance.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
