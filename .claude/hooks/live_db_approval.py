#!/usr/bin/env python3
"""Route live-database commands to approval. DEC-17, DEC-19.

The rule is about touching a database, not about naming one. Two ways an
earlier version confused the two, both measured:

  - `pnpm run db:migrate`, the setup command in README.md's Quickstart, was
    blocked. README.md and AGENTS.md each carried a paragraph that taught the
    workaround.
  - `git commit -m "migrate the ledger schema"` was blocked, because the bare
    English word matched anywhere on the line.

Both came from the same place: `migrate` is an ordinary English word, and it
was matched line-wide. So the migration rule now reads command and script
position, and a message is treated as data.

The client names are different. `psql` and `pg_dump` are unambiguous tool
names, and a first attempt at this file made them positional too. That bought
no precision and cost real strength: `sh -c "psql -h prod.example.com"`,
`eval`, `docker compose exec`, `docker run` and a command substitution all
stopped counting, and the host was never examined because the scan returned
before the host check. A client therefore counts wherever it appears in text
that can execute, exactly as it did before.

What makes the message case safe is that a message is not text that can
execute. An inert heredoc body was already excluded on that reasoning; a
`-m` message is the same thing spelled differently, so it is excluded too.

The migration case carries one more exemption. `src/ledger/migrate.ts` reads
DATABASE_URL and exits 1 when it is absent or empty, so a migration with no
value to resolve cannot reach a database. It is checked against the
environment, an inline assignment and ./.env, because `loadDotEnv()` runs
before that read and a value in the file is as live as one in the shell.
"""
import json
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))

# Clients that talk to a database. Matched wherever they appear in text that
# can execute; see the module docstring for why this is not positional.
DB_CLIENTS = [
    "psql", "pg_dump", "pg_restore", "createdb", "dropdb", "pscale",
    "alembic", "flyway",
]
CLIENT_WORD = re.compile(r"\b(?:" + "|".join(DB_CLIENTS) + r")\b")

# Runners that can invoke a migration script.
SCRIPT_RUNNERS = {"pnpm", "npm", "yarn", "bun", "npx"}

# A script name that runs a migration: `db:migrate`, `migrate`, `migrate:up`.
MIGRATION_SCRIPT = re.compile(r"^(?:[\w.-]+:)?migrate(?::[\w.-]+)?$")

# The built entry point, run directly. Restricted to compiled output under a
# build directory: `npx tsc src/ledger/migrate.ts` typechecks a source file
# and runs no migration, and an earlier version blocked the inner loop for it.
MIGRATION_ENTRY = re.compile(r"(?:^|/)(?:dist|build|out)/.*migrate\.(?:js|mjs|cjs)$")

# Wrappers that stand in front of the command they run.
WRAPPERS = {
    "sudo", "doas", "env", "time", "nohup", "setsid", "nice", "ionice",
    "stdbuf", "command", "exec", "builtin", "xargs", "timeout", "watch",
}

LOCAL_HOST = r"(?:localhost|127\.0\.0\.1|\[?::1\]?)"

# A local target only counts where a host is actually named: after -h/--host,
# or as the host part of a connection URI. Scanning the whole line let a
# trailing comment grant the exemption. The trailing (?![\w.-]) stops
# `localhost.prod.example.com` reading as local, which \b did not.
LOCAL_TARGET = re.compile(
    r"(?:-h\s*" + LOCAL_HOST + r"(?![\w.-])"
    r"|--host(?:=|\s+)" + LOCAL_HOST + r"(?![\w.-])"
    r"|://(?:[^/@\s]*@)?" + LOCAL_HOST + r"[:/\s]"
    r"|--local\b)"
)

# An explicitly named non-local host is never exempt, whatever else the line
# says. Checked first, so a container cannot launder a remote target.
REMOTE_HOST = re.compile(
    r"(?:-h\s*(?!" + LOCAL_HOST + r"(?![\w.-]))[A-Za-z0-9_.-]+"
    r"|--host(?:=|\s+)(?!" + LOCAL_HOST + r"(?![\w.-]))[A-Za-z0-9_.-]+"
    r"|://(?:[^/@\s]*@)?(?!" + LOCAL_HOST + r"[:/\s])[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)"
)

# A container client is a local target only when the command it runs names no
# remote host of its own. `docker compose exec` is the v2 spelling of the same
# thing, and omitting it put the modern form on the wrong side of the rule.
DOCKER_LOCAL = re.compile(r"\bdocker\s+(?:compose\s+)?exec\b|\bpodman\s+exec\b")

# Reading text that mentions a database tool is not touching a database.
READ_ONLY = re.compile(
    r"^\s*(?:grep|rg|ag|ack|cat|bat|head|tail|less|more|wc|nl|file|stat"
    r"|fd|ls|tree|cut|sort|uniq|column"
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

# A command that takes a message as data rather than running it.
MESSAGE_COMMAND = re.compile(r"\bgit\s+(?:-\S+\s+)*(?:commit|tag|notes|merge)\b")
# The message argument itself, quoted or bare.
MESSAGE_ARG = re.compile(
    r"(?:-m|-F)\s+('(?:[^']*)'|\"(?:[^\"]*)\"|\S+)"
    r"|--(?:message|file)(?:=|\s+)('(?:[^']*)'|\"(?:[^\"]*)\"|\S+)"
)


def blank_message_arguments(command: str) -> str:
    """Blanks a commit message, which is data and not a command.

    `git commit -m "migrate the ledger schema"` describes a migration; it runs
    none. An inert heredoc body was already excluded on exactly that
    reasoning, and a `-m` message is the same thing spelled differently. The
    blanking is per line and only on a line that names such a command, so a
    `-m` belonging to anything else is untouched.
    """
    out = []
    for line in command.splitlines():
        if MESSAGE_COMMAND.search(line) and INTERPRETER.search(
            MESSAGE_COMMAND.sub("", line)
        ) is None:
            line = MESSAGE_ARG.sub(lambda m: m.group(0)[: m.group(0).index(m.group(1) or m.group(2))] + "''", line)
        out.append(line)
    return "\n".join(out)


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


def tokenise(segment: str) -> list[str]:
    """Best-effort shell split. An unbalanced quote falls back to whitespace."""
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|[;|&\n()]|\{|\})")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def segments(command: str) -> list[list[str]]:
    """The command's segments, each as a token list, wrappers stripped."""
    found = []
    for raw in SEGMENT_SPLIT.split(command):
        tokens = tokenise(raw)
        changed = True
        while changed and tokens:
            changed = False
            while tokens and ASSIGNMENT.match(tokens[0]):
                tokens = tokens[1:]
                changed = True
            while tokens and os.path.basename(tokens[0]) in WRAPPERS:
                tokens = tokens[1:]
                changed = True
        if tokens:
            found.append(tokens)
    return found


def names_migration(command: str) -> bool:
    """True when a runner or node actually invokes a migration."""
    for tokens in segments(command):
        head = os.path.basename(tokens[0])
        rest = tokens[1:]
        if head in SCRIPT_RUNNERS and any(
            MIGRATION_SCRIPT.match(token) for token in rest
        ):
            return True
        if head in {"node", "deno", "bun", "tsx", "ts-node"} and any(
            MIGRATION_ENTRY.search(token) for token in rest
        ):
            return True
    return False


def dotenv_database_url(root: str | None = None) -> str | None:
    """The DATABASE_URL that ./.env would supply, or None.

    `src/ledger/migrate.ts` calls loadDotEnv() before it reads the variable,
    so a value in the file is as live as one in the shell. Without this the
    exemption below would wave through a migration against whatever the file
    names.

    `process.loadEnvFile` honours an `export ` prefix, and an earlier version
    of this parser did not. A .env written in the ordinary shell-snippet style
    therefore read as absent here and as present to Node, which is the exact
    disagreement this exemption cannot afford.
    """
    path = os.path.join(root if root is not None else REPO_ROOT, ".env")
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                name, _, value = line.partition("=")
                name = name.strip()
                if name.startswith("export "):
                    name = name[len("export "):].strip()
                if name == "DATABASE_URL":
                    return value.strip().strip("'\"")
    except OSError:
        return None
    return None


def migration_has_a_target(command: str) -> bool:
    """True when a migration in this command could resolve a database.

    An inline assignment names one. Otherwise the runner inherits the
    environment and reads ./.env. With none of the three, `migrate.ts` prints
    'DATABASE_URL is not set.' and exits 1, so nothing is reachable. An empty
    value counts as absent, because that is how migrate.ts treats it.
    """
    inline = re.search(r"\bDATABASE_URL=(\S*)", command)
    if inline is not None and inline.group(1).strip("'\""):
        return True
    if os.environ.get("DATABASE_URL"):
        return True
    return bool(dotenv_database_url())


def main() -> int:
    raw = json.load(sys.stdin).get("tool_input", {}).get("command", "")
    # A message is data. So is an inert heredoc body. Neither can execute, so
    # neither may incriminate a command.
    executable = blank_message_arguments(strip_heredoc_bodies(raw))
    client = CLIENT_WORD.search(executable) is not None
    migration = names_migration(executable)
    if not client and not migration:
        return 0
    # Reading a file that names a database tool touches no database.
    if is_read_only(blank_message_arguments(strip_heredoc_bodies(raw, always=True))):
        return 0
    # No body ever grants the exemption, so these tests read the command lines
    # alone. Comments go too: a trailing comment is not a connection target.
    lines = strip_comments(
        blank_message_arguments(strip_heredoc_bodies(raw, always=True))
    )
    # An explicitly named remote host wins over every exemption below.
    if not REMOTE_HOST.search(lines):
        if LOCAL_TARGET.search(lines) or DOCKER_LOCAL.search(lines):
            return 0
        # A migration alone, with nothing to resolve, reaches no database.
        if migration and not client and not migration_has_a_target(lines):
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
