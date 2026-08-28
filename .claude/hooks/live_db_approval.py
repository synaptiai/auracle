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

HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

# A heredoc body leaves the scan only when the line that opens it hands the
# body to one of these. They store text or send it; they run none of it.
DATA_CONSUMER = re.compile(
    r"(\bgit\s+(commit|tag|notes|merge)\b"
    r"|\bcat\b"
    r"|\btee\b"
    r"|\bgh\s+\w+\s+(create|edit|comment)\b"
    r"|\bjq\b)"
)

# These run the body, so the body stays in scope. The list also overrides a
# data consumer on the same line, for example `git commit ... && bash <<EOF`.
INTERPRETER = re.compile(
    r"\b(sh|bash|zsh|ksh|dash|ash|fish|csh|tcsh|busybox|pwsh|powershell"
    r"|python|python2|python3|node|deno|bun|tsx|ts-node|npx|npm|pnpm|yarn"
    r"|ruby|perl|php|lua|R|Rscript|java|jshell|scala|groovy|osascript"
    r"|awk|gawk|mawk|sed|expect|make|cmake|ansible|ansible-playbook"
    r"|env|eval|exec|source|command|xargs|parallel|nohup|setsid|timeout"
    r"|watch|nice|script|su|sudo|doas|ssh|scp|docker|podman|kubectl"
    r"|sqlite3|mysql|mongo|mongosh|redis-cli)\b"
)


def strip_heredoc_bodies(command: str, always: bool = False) -> str:
    """Drop a heredoc body when the opening line cannot execute it.

    The default keeps the body, so an unknown command stays in scope and no
    new tool silently opens a path around the guard. With always=True every
    body goes, which is what the local-target test needs: a body may
    incriminate a command, it may never exempt one.
    """
    lines = command.splitlines()
    kept: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        match = HEREDOC_START.search(line)
        inert = match is not None and (
            always
            or (
                DATA_CONSUMER.search(line) is not None
                and INTERPRETER.search(line) is None
            )
        )
        if inert:
            assert match is not None
            delimiter = match.group(2)
            i += 1
            while i < len(lines) and lines[i].strip() != delimiter:
                i += 1
        i += 1
    return "\n".join(kept)


def main() -> int:
    raw = json.load(sys.stdin).get("tool_input", {}).get("command", "")
    # A body that an interpreter runs counts against the command.
    if not DB_COMMAND.search(strip_heredoc_bodies(raw)):
        return 0
    # No body ever grants the exemption, so this test reads the command lines
    # alone. Otherwise `psql -h prod <<EOF ... localhost ... EOF` would pass.
    if LOCAL_TARGET.search(strip_heredoc_bodies(raw, always=True)):
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
