#!/usr/bin/env bash
# Brings a fresh clone to a state where `pnpm run verify` can run (issue #80).
#
# Setup was a list in a document: enable corepack, install, copy the commit
# hook, copy .env.example, start compose, migrate. Six manual steps, and the
# commit hook is the one that fails silently — a contributor who skips it
# edits the register with no DEC citation and learns of it from CI.
#
# Idempotent. Every step checks before it acts, so running it a second time
# changes nothing and says so.
#
# Two modes, and the difference is consent.
#
#   ./scripts/bootstrap.sh            does the work
#   ./scripts/bootstrap.sh --check    reports what is missing, changes nothing
#
# The SessionStart hook in `.claude/settings.json` runs `--check`. The hook
# command names this script, and this script is ordinary repository content
# that any branch can rewrite — so a session opened on a branch would run
# whatever that branch put here, with no tool call and no second approval.
# Installing dependencies, writing an executable into `.git/hooks/` and
# seeding `.env` from a tracked file are all things a person should choose.
#
# `--check` therefore prints the commands rather than running them. A person
# who wants the work runs the script with no flag.
#
# What it deliberately does NOT do:
#   - `docker compose up -d`. Starting containers is the developer's call,
#     and a hook that starts a database on every session is a surprise.
#   - `pnpm run db:migrate`. It writes to a database, and the URL it would
#     write to is the one this script cannot know is the right one.
#   - Fill in OPENROUTER_API_KEY. `.env.example` carries the name and no
#     value, and this script never invents one.
# The summary at the end names whichever of those is still outstanding.
set -euo pipefail

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    *) printf 'usage: %s [--check]\n' "$0" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
ROOT="$PWD"

say() { printf '%s\n' "$*"; }
step() { printf '  %-28s %s\n' "$1" "$2"; }

if [ "$CHECK_ONLY" -eq 1 ]; then
  say "auracle bootstrap (--check: nothing is changed) — $ROOT"
else
  say "auracle bootstrap — $ROOT"
fi

# 1. Node. The engines field asks for 22.13 or later, and a lower one fails
#    later and less clearly: vitest needs 22.12 and eslint needs 22.13.
if ! command -v node >/dev/null 2>&1; then
  step "node" "MISSING — install Node 22.13 or later, then run this again"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  step "node" "$(node -v) — too old, this repository needs 22.13 or later"
  exit 1
fi
step "node" "$(node -v)"

# 2. pnpm, through corepack. `packageManager` in package.json pins the
#    version, and corepack is what honours it. An `npm install` here produces
#    a tree no workflow validates.
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || step "corepack" "could not enable (not fatal)"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  step "pnpm" "MISSING — run 'corepack enable', or install pnpm, then run this again"
  exit 1
fi
step "pnpm" "$(pnpm --version)"

# 3. Dependencies, from the lockfile. Frozen, so a bootstrap never rewrites
#    it: a lockfile change is a decision, not a side effect of setup.
if [ -d node_modules ] && [ -f node_modules/.modules.yaml ]; then
  step "dependencies" "already installed"
elif [ "$CHECK_ONLY" -eq 1 ]; then
  step "dependencies" "MISSING — run: pnpm install --frozen-lockfile"
else
  # Output to a log rather than the terminal: under the hook this text would
  # be registry strings resolved from the lockfile, appended to an agent's
  # context at session open.
  say "  installing dependencies (pnpm install --frozen-lockfile)…"
  pnpm install --frozen-lockfile
  step "dependencies" "installed"
fi

# 4. The commit hook. It blocks an edit to docs/v1-architecture.md that cites
#    no DEC. CI runs the same check, so skipping it costs a round trip.
#
#    Never overwritten. A contributor who wrote their own hook keeps it, and
#    this says so rather than replacing it silently.
#    `.git` is a directory in a clone and a FILE in a worktree, holding
#    `gitdir: ...`. Testing for a directory skipped this step in a worktree
#    and said "no .git directory here" inside a git checkout — and the commit
#    hook is the one step this script exists to stop people forgetting. Ask
#    git where its hooks live instead.
HOOK_SRC="hooks/commit-msg"
HOOK_DIR="$(git rev-parse --git-path hooks 2>/dev/null || true)"
HOOK_DST="${HOOK_DIR:-}/commit-msg"
if [ -z "$HOOK_DIR" ]; then
  step "commit hook" "skipped — this is not a git checkout"
elif [ ! -f "$HOOK_SRC" ]; then
  step "commit hook" "skipped — $HOOK_SRC is missing"
elif [ -f "$HOOK_DST" ] && ! cmp -s "$HOOK_SRC" "$HOOK_DST"; then
  step "commit hook" "left alone — $HOOK_DST differs from $HOOK_SRC"
elif [ -f "$HOOK_DST" ]; then
  step "commit hook" "already installed"
elif [ "$CHECK_ONLY" -eq 1 ]; then
  step "commit hook" "MISSING — run: cp $HOOK_SRC $HOOK_DST && chmod +x $HOOK_DST"
else
  mkdir -p "$HOOK_DIR"
  cp "$HOOK_SRC" "$HOOK_DST"
  chmod +x "$HOOK_DST"
  step "commit hook" "installed"
fi

# 5. `.env`. Copied from the example, which names every variable a process
#    reads and carries no value for any credential. Never overwritten: that
#    file holds OPENROUTER_API_KEY once a person fills it in.
ENV_MISSING_KEY=0
# `-e` follows a symlink and answers false for a dangling one, so a `.env`
# pointing at an absent path outside the repository tested as missing and the
# copy below wrote through the link. `-L` asks about the link itself.
if [ -L .env ]; then
  step ".env" "left alone — it is a symlink, and this script does not follow one"
elif [ -e .env ]; then
  step ".env" "already present, left alone"
elif [ ! -f .env.example ]; then
  step ".env" "skipped — .env.example is missing"
elif [ "$CHECK_ONLY" -eq 1 ]; then
  step ".env" "MISSING — run: cp .env.example .env"
  ENV_MISSING_KEY=1
else
  cp .env.example .env
  step ".env" "created from .env.example"
  ENV_MISSING_KEY=1
fi
if [ -e .env ] && ! grep -qE '^\s*OPENROUTER_API_KEY=.+' .env; then
  ENV_MISSING_KEY=1
fi

# 6. Docker. Reported, never started.
DOCKER_READY=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER_READY=1
  step "docker" "running"
elif command -v docker >/dev/null 2>&1; then
  step "docker" "installed, not running"
else
  step "docker" "MISSING — the database and mail suites need it"
fi

say ""
say "What is left, and why this script does not do it:"
if [ "$ENV_MISSING_KEY" -eq 1 ]; then
  say "  - Put OPENROUTER_API_KEY in .env. This script never invents a credential."
fi
if [ "$DOCKER_READY" -eq 1 ]; then
  say "  - docker compose --profile test up -d   Postgres on 5433, GreenMail on 3025/3143"
else
  say "  - start Docker, then: docker compose --profile test up -d"
fi
say "  - export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle"
say "  - export MAIL_HOST=127.0.0.1     so no suite starts a throwaway container"
say "  - pnpm run db:migrate            writes to that database, so you choose when"
say ""
say "Then: pnpm run verify"
