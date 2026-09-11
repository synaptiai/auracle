#!/usr/bin/env python3
"""Cases for the live-database guard. Run: python3 .claude/hooks/test_live_db_approval.py

The guard skips an inert heredoc body, so prose that names a database command
does not block a commit. It still reads a body that an interpreter executes.
"""
import json
import os
import shutil
import subprocess
import tempfile
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_db_approval.py")
ALLOW, BLOCK = 0, 2

CASES = [
    ("commit message that names db:migrate", ALLOW,
     "git commit -F - <<'MSG'\ndocs: setup\n\n- Setup. Compose, npm run db:migrate, .env rules.\nMSG"),
    ("commit message that names psql in prose", ALLOW,
     "git commit -F - <<'MSG'\ndocs: mention psql in the runbook\nMSG"),
    ("commit with no heredoc and no database word", ALLOW, "git commit -m 'docs: tidy'"),
    ("client aimed at a remote host", BLOCK, "psql -h db.prod.example.com -c 'select 1'"),
    ("dump of a remote database", BLOCK, "pg_dump postgres://u:p@prod.example.com/app > d.sql"),
    ("interpreter heredoc that hides a client call", BLOCK,
     "bash <<'EOF'\npsql -h prod.example.com -c 'drop table tickets'\nEOF"),
    ("python heredoc that hides a migration call", BLOCK,
     "python3 <<'EOF'\nsubprocess.run(['alembic', 'upgrade', 'head'])\nEOF"),
    ("client on the line that opens the heredoc", BLOCK,
     "psql -h prod.example.com <<'EOF'\nselect 1;\nEOF"),
    ("heredoc body never supplies the local exemption", BLOCK,
     "psql -h prod.example.com <<'EOF'\n-- localhost\nEOF"),
    ("migration against the compose database", ALLOW,
     "DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle npm run db:migrate"),
    ("client inside the compose container", ALLOW, "docker exec db psql -U auracle"),
    # Issue #74 changed this. A migration reaches a database only through
    # DATABASE_URL, and src/ledger/migrate.ts exits 1 when it is absent. With
    # nothing to resolve there is nothing to approve, and blocking it made the
    # documented setup command unrunnable. check_migration_target below holds
    # the other half of the rule.
    ("migration with nothing to resolve", ALLOW, "npm run db:" + "migrate"),
    # The default keeps a body in scope. Only a known data consumer drops it.
    ("unknown command keeps its body in scope", BLOCK,
     "somenewtool run <<'EOF'\npsql -h prod.example.com\nEOF"),
    ("fish heredoc that hides a client call", BLOCK,
     "fish <<'EOF'\npsql -h prod.example.com\nEOF"),
    ("ssh heredoc that hides a client call", BLOCK,
     "ssh host <<'EOF'\npsql -c 'select 1'\nEOF"),
    ("sudo heredoc that hides a dump", BLOCK,
     "sudo -s <<'EOF'\npg_dump app > d.sql\nEOF"),
    ("data consumer next to an interpreter keeps its body", BLOCK,
     "git commit -F - <<'MSG' && bash\npsql -h prod.example.com\nMSG"),
    # A comment is not a connection target. The exemption used to scan the
    # whole line, so a trailing comment laundered a remote host.
    ("comment cannot supply the local exemption", BLOCK,
     "pg_dump -h prod.example.com app > d.sql # localhost"),
    # `docker exec` names a local container, not a local database. The
    # exemption used to apply whatever the inner command targeted.
    ("container cannot launder a remote host", BLOCK,
     "docker exec x pg_dump -h prod.example.com app"),
    # Reading text that mentions a tool touches no database. The guard used
    # to block its own repository search.
    ("read-only search for a tool name", ALLOW, "grep -rn 'pg_dump' docs/"),
    ("read-only history search", ALLOW, "git log --oneline -- src/ledger/migrate.ts"),
    # 'migrate' is an ordinary word and names the runner's own files. It
    # counts as a command word, not as part of a path.
    ("runner source path is not a command", ALLOW, "npx tsc src/ledger/migrate.ts"),
    ("runner test path is not a command", ALLOW, "npx vitest run src/ledger/migrate.db.test.ts"),
    ("a runner script is still recognised as a migration", ALLOW, "npm run db:" + "migrate"),
    ("cat to a file is inert", ALLOW,
     "cat > notes.md <<'EOF'\nRun psql against production only by hand.\nEOF"),
    ("gh issue body is inert", ALLOW,
     "gh issue create --body-file - <<'EOF'\nThe db:migrate step fails.\nEOF"),
    # --- issue #74: precision ---
    # The documented setup command. AGENTS.md and README.md both carried a
    # paragraph teaching a workaround for this being blocked.
    ("the documented setup command", ALLOW, "pnpm run db:" + "migrate"),
    # The word in a message is prose. This blocked every commit whose subject
    # described a migration.
    ("a commit message that names the word", ALLOW,
     'git commit -m "migrate the ledger schema"'),
    ("a commit message that names a client", ALLOW,
     'git commit -m "document the psql recipe"'),
    # The word as an argument or a path is not a command.
    ("the word as a branch name", ALLOW, "git checkout -b fix/migrate-order"),
    # A client at command position still counts, however it is reached.
    ("a client behind sudo", BLOCK, "sudo psql -h db.example.com -c 'select 1'"),
    ("a client behind a container", BLOCK, "docker exec x pg_dump -h prod.example.com app"),
    ("a client behind kubectl", BLOCK, "kubectl exec pod -- psql -h prod.example.com"),
    ("a client behind ssh", BLOCK, "ssh bastion psql -h prod.example.com"),

    # --- the differential set ---
    # A first attempt at issue #74 made the client names positional, like the
    # migration rule. That bought no precision and dropped every form where
    # the name is not a bare token at a segment head. Each line below was
    # measured allowing against that attempt and blocking on the rule before
    # it, so this set is what keeps the precision work from costing strength.
    ("a client inside sh -c", BLOCK, 'sh -c "psql -h prod.example.com -c \'select 1\'"'),
    ("a client inside bash -c", BLOCK, "bash -c 'psql -h prod.example.com'"),
    ("a client inside eval", BLOCK, "eval 'psql -h prod.example.com'"),
    ("a client from a command substitution", BLOCK,
     "$(echo psql) -h prod.example.com -c 'select 1'"),
    ("a client from a backtick substitution", BLOCK, "`echo psql` -h prod.example.com"),
    ("a client reached through a variable", BLOCK, "P=psql; $P -h prod.example.com"),
    ("a client in docker run, which is not exec", BLOCK,
     "docker run --rm postgres psql -h prod.example.com -c 'select 1'"),
    ("a client behind the compose v2 spelling", BLOCK,
     "docker compose exec db psql -h prod.example.com"),
    # A value-taking flag before the pod name was consumed as the pod.
    ("a client behind kubectl with a namespace flag", BLOCK,
     "kubectl exec -n prod pod -- psql -h prod.example.com"),
    ("a client behind kubectl with a container flag", BLOCK,
     "kubectl exec --container app pod -- psql -h prod.example.com"),
    # `\b` matched at the dot, so a remote host prefixed with the local name
    # read as local. Present before this issue and closed with it.
    ("a remote host that starts with the local name", BLOCK,
     "psql -h localhost.prod.example.com -c 'select 1'"),
    # The compose v2 spelling on the allow side too, so the fix is not a
    # one-directional patch.
    ("the compose v2 spelling of a local container", ALLOW,
     "docker compose exec db psql -U auracle"),
]


def run(command: str, env: dict, hook: str = HOOK) -> int:
    proc = subprocess.run(
        [sys.executable, hook],
        input=json.dumps({"tool_input": {"command": command}}),
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode


def isolated_hook(tmp: str) -> str:
    """A copy of the guard whose repository root holds no .env.

    The migration exemption reads ./.env, and .env is untracked. Run against
    the real checkout, five cases here were decided by whether the developer
    had followed the setup instructions: CI passed and a working machine
    failed, with no code change between them. The copy keeps the cases about
    the rule.
    """
    hooks = os.path.join(tmp, ".claude", "hooks")
    os.makedirs(hooks, exist_ok=True)
    copy = os.path.join(hooks, os.path.basename(HOOK))
    shutil.copyfile(HOOK, copy)
    return copy


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_hook():
    """Imports the guard as a module, so its parts can be tested directly."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("live_db_approval", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_migration_target() -> int:
    """A migration counts exactly when it can resolve a database.

    This exemption is the part of issue #74 that could be wrong in the unsafe
    direction, so both sides are asserted. Absent means nothing to approve.
    Present -- in the shell, or in ./.env, which migrate.ts loads before it
    reads the variable -- means a real target.

    The ./.env half runs against a temporary directory rather than the real
    file. An earlier version of this test wrote the repository's own .env and
    restored it afterwards; a crash in between would have destroyed the key
    it holds. A test must not be able to cost you that.
    """
    failures = 0
    command = "pnpm run db:" + "migrate"
    clean = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    label = {ALLOW: "allow", BLOCK: "block"}

    shell_cases = [
        ("nothing to resolve", ALLOW, clean),
        ("DATABASE_URL exported to the shell", BLOCK,
         dict(clean, DATABASE_URL="postgres://u:p@db.example.com/app")),
    ]
    for name, want, env in shell_cases:
        got = run(command, env)
        if got == want:
            print(f"pass a migration with {name}")
        else:
            failures += 1
            print(f"FAIL a migration with {name}: want {label[want]}, got {label.get(got, got)}")

    # The parser must agree with Node's loadEnvFile about every spelling.
    # `export DATABASE_URL=` read as absent here and as present to Node, so a
    # .env written in the ordinary shell-snippet style defeated the exemption.
    module = load_hook()
    with tempfile.TemporaryDirectory() as spellings:
        for content, want, label in [
            ("export DATABASE_URL=postgres://u:p@h/app\n", True, "an export prefix"),
            ("DATABASE_URL=\n", False, "an empty value"),
            ("MY_DATABASE_URL=postgres://x\n", False, "a key it is a substring of"),
            ("DATABASE_URL_RO=postgres://x\n", False, "a key that extends it"),
            ("  DATABASE_URL = 'postgres://u@h/a'\n", True, "spaces and quotes"),
            ("DATABASE_URL=postgres://u@h/a\r\n", True, "CRLF line endings"),
            ("# DATABASE_URL=postgres://u@h/a\n", False, "a comment"),
        ]:
            with open(os.path.join(spellings, ".env"), "w", encoding="utf-8") as handle:
                handle.write(content)
            got = bool(module.dotenv_database_url(spellings))
            if got == want:
                print(f"pass .env with {label} resolves to {want}")
            else:
                failures += 1
                print(f"FAIL .env with {label}: want {want}, got {got}")

    # The ./.env half, against a temporary root.
    module = load_hook()
    saved_root = module.REPO_ROOT
    saved_env = os.environ.pop("DATABASE_URL", None)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            module.REPO_ROOT = tmp
            if module.migration_has_a_target(command):
                failures += 1
                print("FAIL an absent .env must leave nothing to resolve")
            else:
                print("pass an absent .env leaves nothing to resolve")

            with open(os.path.join(tmp, ".env"), "w", encoding="utf-8") as handle:
                handle.write("# a comment\nOPENROUTER_API_KEY=x\n")
            if module.migration_has_a_target(command):
                failures += 1
                print("FAIL a .env without DATABASE_URL must leave nothing to resolve")
            else:
                print("pass a .env without DATABASE_URL leaves nothing to resolve")

            with open(os.path.join(tmp, ".env"), "w", encoding="utf-8") as handle:
                handle.write("DATABASE_URL=postgres://u:p@db.example.com/app\n")
            if module.migration_has_a_target(command):
                print("pass a .env that names DATABASE_URL is a real target")
            else:
                failures += 1
                print("FAIL a .env that names DATABASE_URL must be a real target")

            with open(os.path.join(tmp, ".env"), "w", encoding="utf-8") as handle:
                handle.write("# DATABASE_URL=postgres://u:p@db.example.com/app\n")
            if module.migration_has_a_target(command):
                failures += 1
                print("FAIL a commented DATABASE_URL must not count as a target")
            else:
                print("pass a commented DATABASE_URL is not a target")
    finally:
        module.REPO_ROOT = saved_root
        if saved_env is not None:
            os.environ["DATABASE_URL"] = saved_env

    # An inline assignment names a target whatever the environment holds.
    if load_hook().migration_has_a_target(
            "DATABASE_URL=postgres://u:p@db.example.com/app pnpm run db:" + "migrate"):
        print("pass an inline assignment is a real target")
    else:
        failures += 1
        print("FAIL an inline assignment must be a real target")
    return failures


def main() -> int:
    label = {ALLOW: "allow", BLOCK: "block"}
    failures = 0
    # The migration exemption reads DATABASE_URL, so these cases must not
    # inherit one from whoever ran this. A developer with it exported would
    # otherwise see different results from CI.
    clean = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    tmp = tempfile.mkdtemp()
    hook = isolated_hook(tmp)
    for name, want, command in CASES:
        got = run(command, clean, hook)
        if got == want:
            print(f"pass {name}")
        else:
            failures += 1
            print(f"FAIL {name}: want {label[want]}, got {label.get(got, got)}")
    shutil.rmtree(tmp, ignore_errors=True)
    failures += check_migration_target()
    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
