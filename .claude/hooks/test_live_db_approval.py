#!/usr/bin/env python3
"""Cases for the live-database guard. Run: python3 .claude/hooks/test_live_db_approval.py

The guard skips an inert heredoc body, so prose that names a database command
does not block a commit. It still reads a body that an interpreter executes.
"""
import json
import os
import subprocess
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
    ("migration with no local target", BLOCK, "npm run db:migrate"),
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
    ("npm script still names a migration", BLOCK, "npm run db:migrate"),
    ("cat to a file is inert", ALLOW,
     "cat > notes.md <<'EOF'\nRun psql against production only by hand.\nEOF"),
    ("gh issue body is inert", ALLOW,
     "gh issue create --body-file - <<'EOF'\nThe db:migrate step fails.\nEOF"),
]


def main() -> int:
    label = {ALLOW: "allow", BLOCK: "block"}
    failures = 0
    for name, want, command in CASES:
        proc = subprocess.run(
            [sys.executable, HOOK],
            input=json.dumps({"tool_input": {"command": command}}),
            capture_output=True,
            text=True,
        )
        got = proc.returncode
        if got == want:
            print(f"pass {name}")
        else:
            failures += 1
            print(f"FAIL {name}: want {label[want]}, got {label.get(got, got)}")
    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
