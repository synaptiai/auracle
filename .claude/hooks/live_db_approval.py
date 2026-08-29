#!/usr/bin/env python3
"""Route live-database commands to approval. DEC-17, DEC-19."""
import json
import re
import sys

# `migrate` is an ordinary English word and also appears in every path that
# names the migration runner. It counts only as a command word: not after a
# path separator (src/ledger/migrate.ts) and not before a file extension
# (migrate.db.test.ts). `npm run db:migrate` still counts.
DB_COMMAND = re.compile(
    r"\b(psql|pg_dump|pg_restore|createdb|dropdb|pscale|"
    r"alembic|flyway)\b"
    r"|(?<![\w/.-])migrate\b(?!\.[A-Za-z])"
    r"|(?<=:)migrate\b(?!\.[A-Za-z])"
)
LOCAL_HOST = r"(?:localhost|127\.0\.0\.1|\[?::1\]?)"

# A local target only counts where a host is actually named: after -h/--host,
# or as the host part of a connection URI. Scanning the whole line let a
# trailing comment grant the exemption.
LOCAL_TARGET = re.compile(
    r"(?:-h\s*" + LOCAL_HOST + r"\b"
    r"|--host(?:=|\s+)" + LOCAL_HOST + r"\b"
    r"|://(?:[^/@\s]*@)?" + LOCAL_HOST + r"[:/\s]"
    r"|--local\b)"
)

# An explicitly named non-local host is never exempt, whatever else the line
# says. Checked first, so a container cannot launder a remote target.
REMOTE_HOST = re.compile(
    r"(?:-h\s*(?!" + LOCAL_HOST + r"\b)[A-Za-z0-9_.-]+"
    r"|--host(?:=|\s+)(?!" + LOCAL_HOST + r"\b)[A-Za-z0-9_.-]+"
    r"|://(?:[^/@\s]*@)?(?!" + LOCAL_HOST + r")[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)"
)

# A container client is a local target only when the command it runs names
# no remote host of its own.
DOCKER_LOCAL = re.compile(r"\bdocker\s+exec\b")

# Reading text that mentions a database tool is not touching a database.
READ_ONLY = re.compile(
    r"^\s*(?:grep|rg|ag|ack|cat|bat|head|tail|less|more|wc|nl|file|stat"
    r"|find|fd|ls|tree|cut|sort|uniq|column"
    r"|git\s+(?:grep|log|show|diff|status|blame|ls-files))\b"
)


def strip_comments(command: str) -> str:
    """Drop trailing comments so a comment cannot grant an exemption."""
    out = []
    for line in command.splitlines():
        quote = None
        cut = len(line)
        for i, ch in enumerate(line):
            if quote is not None:
                if ch == quote:
                    quote = None
            elif ch in "\'\"":
                quote = ch
            elif ch == "#" and (i == 0 or line[i - 1].isspace()):
                cut = i
                break
        out.append(line[:cut])
    return "\n".join(out)


def is_read_only(command: str) -> bool:
    """True when every line is a read-only text command."""
    lines = [ln for ln in command.splitlines() if ln.strip()]
    if not lines:
        return False
    return all(READ_ONLY.match(ln) for ln in lines)

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
    # Reading a file that names a database tool touches no database.
    if is_read_only(strip_heredoc_bodies(raw, always=True)):
        return 0
    # No body ever grants the exemption, so these tests read the command lines
    # alone. Comments go too: a trailing comment is not a connection target.
    lines = strip_comments(strip_heredoc_bodies(raw, always=True))
    # An explicitly named remote host wins over every exemption below.
    if not REMOTE_HOST.search(lines):
        if LOCAL_TARGET.search(lines) or DOCKER_LOCAL.search(lines):
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
