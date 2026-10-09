#!/usr/bin/env bash
# Brings a fresh clone to a state where `pnpm run verify` can run.
#
# It enables corepack, installs the dependencies, installs the commit hook and
# copies .env.example. Without the commit hook, a contributor can edit the
# register with no DEC citation and learn of it only from CI.
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
# The first line of $1 that is not blank, with every carriage return made a
# space and the spaces and tabs at either end trimmed. Empty when every line is
# blank. A reason is read from it, so a blank first line or a stack trace
# never decides what the step says. A carriage return inside the line would
# move the cursor back and overwrite the step's label. The C locale reads
# every byte, so a byte the user's locale cannot decode never drops the
# reason.
first_line() {
  printf '%s\n' "$1" | LC_ALL=C tr '\r' ' ' | LC_ALL=C grep -m1 '[^[:space:]]' \
    | LC_ALL=C sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  say "auracle bootstrap (--check: nothing is changed) — $ROOT"
else
  say "auracle bootstrap — $ROOT"
fi

# 1. Node. vitest runs on major versions 22, 24, and 26 and later, and
#    testcontainers needs 22.22. Any other version fails later and less
#    clearly, so the engines field and this check name the same set.
if ! command -v node >/dev/null 2>&1; then
  step "node" "MISSING — install Node 22.22 or later, then run this again"
  exit 1
fi
# A version field is digits, and at most five of them. An empty field, a
# missing one or a longer one is refused: `[` reads none of them as a number,
# and inside an `if` its failure would read as a supported version.
is_version_field() {
  case "${1:-}" in
    ""|*[!0-9]*|??????*) return 1 ;;
  esac
}

# The version is read on its own line, as pnpm's is below: `set -e` would
# end the script inside an assignment with nothing said. What the tool prints
# to stderr stays on the terminal, above this step, and names its reason.
NODE_EXIT=0
NODE_VERSION="$(node -v)" || NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  NODE_REASON="$(first_line "$NODE_VERSION")"
  step "node" "present but fails: ${NODE_REASON:-exit $NODE_EXIT}"
  exit 1
fi
NODE_LINE="$(first_line "$NODE_VERSION")"
NODE_MAJOR="" NODE_MINOR="" NODE_PATCH=""
case "$NODE_LINE" in
  v*) IFS=. read -r NODE_MAJOR NODE_MINOR NODE_PATCH NODE_REST <<EOF_NODE || true
${NODE_LINE#v}
EOF_NODE
    ;;
esac
# A build suffix such as -nightly follows the patch number.
NODE_PATCH="${NODE_PATCH%%[!0-9]*}"
if ! is_version_field "$NODE_MAJOR" || ! is_version_field "$NODE_MINOR" || ! is_version_field "$NODE_PATCH"; then
  step "node" "${NODE_LINE:-printed nothing} — not a version this script can read; install Node 22.22 or later"
  exit 1
fi
NODE_SHOWN="v$NODE_MAJOR.$NODE_MINOR.$NODE_PATCH"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 22 ]; }; then
  step "node" "$NODE_SHOWN — too old, this repository needs Node 22.22 or later"
  exit 1
fi
if [ "$NODE_MAJOR" -eq 23 ] || [ "$NODE_MAJOR" -eq 25 ]; then
  step "node" "$NODE_SHOWN — not supported: use major version 22 (22.22 or later), 24, or 26 and later"
  exit 1
fi
step "node" "$NODE_SHOWN"

# 2. Python. The documentation and guard checks use syntax Python 3.10 added.
#    macOS ships 3.9 as python3, and there the first check stops on a
#    TypeError that names no version.
if ! command -v python3 >/dev/null 2>&1; then
  step "python3" "MISSING — install Python 3.10 or later, then run this again"
  exit 1
fi
# Python reports its version as numbers on stdout, so no warning it prints on
# stderr joins them. The form runs on Python 2 as well, so an old one is
# named, not crashed on.
PY_EXIT=0
PY_PARTS="$(python3 -c 'import sys; print("%d %d %d" % tuple(sys.version_info[:3]))')" || PY_EXIT=$?
if [ "$PY_EXIT" -ne 0 ]; then
  PY_REASON="$(first_line "$PY_PARTS")"
  step "python3" "present but fails: ${PY_REASON:-exit $PY_EXIT}"
  exit 1
fi
PY_MAJOR="" PY_MINOR="" PY_PATCH=""
read -r PY_MAJOR PY_MINOR PY_PATCH PY_REST <<EOF_PY || true
$(first_line "$PY_PARTS")
EOF_PY
if ! is_version_field "$PY_MAJOR" || ! is_version_field "$PY_MINOR" || ! is_version_field "$PY_PATCH"; then
  PY_LINE="$(first_line "$PY_PARTS")"
  step "python3" "${PY_LINE:-printed nothing} — not a version this script can read; install Python 3.10 or later"
  exit 1
fi
PY_VERSION="Python $PY_MAJOR.$PY_MINOR.$PY_PATCH"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  step "python3" "$PY_VERSION — too old, the documentation and guard checks need Python 3.10 or later"
  exit 1
fi
step "python3" "$PY_VERSION"

# 3. pnpm, through corepack. `packageManager` in package.json pins the
#    version, and corepack is what honours it. An `npm install` here produces
#    a tree no workflow validates.
# `--check` changes nothing, so it enables nothing either. A failed enable
# says why, and the advice then names only the route left.
COREPACK_RAN=0
if [ "$CHECK_ONLY" -eq 0 ] && command -v corepack >/dev/null 2>&1; then
  COREPACK_RAN=1
  if ! COREPACK_ERR="$(corepack enable 2>&1)"; then
    # The first line that holds text: a stack trace would break the column.
    COREPACK_REASON="$(first_line "$COREPACK_ERR")"
    step "corepack" "could not enable: ${COREPACK_REASON:-no reason given}"
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  # Node 26 and later ship no corepack, so the message names the route that
  # works on every supported Node: the version `packageManager` pins.
  # The read never fails, and it takes a plain version or nothing. A missing,
  # malformed or unusual field names no version, so the message never prints
  # text from package.json as a command to copy.
  PNPM_PIN="$(node -p 'try { const m = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)(?:\+[0-9A-Za-z.]+)?$/.exec(require("./package.json").packageManager || ""); m ? m[1] : "" } catch { "" }' 2>/dev/null || true)"
  if [ -n "$PNPM_PIN" ]; then
    INSTALL="run 'npm install -g pnpm@$PNPM_PIN'"
  else
    INSTALL="install the pnpm version package.json pins"
  fi
  # A corepack enable that ran, failed or not, is no advice to repeat.
  if [ "$COREPACK_RAN" -eq 1 ] || ! command -v corepack >/dev/null 2>&1; then
    step "pnpm" "MISSING — $INSTALL, then run this again"
  else
    step "pnpm" "MISSING — run 'corepack enable' (Node 22 or 24), or $INSTALL, then run this again"
  fi
  exit 1
fi
# A pnpm that cannot run is not ready. `set -e` ignores a failure inside an
# argument, so the version is read on its own line. Its stderr stays on the
# terminal, so a notice never joins the version. A failure that printed to
# stdout is named by its first line that holds text. One that printed none
# there is named by its exit code. Anything it printed to stderr is already
# above this step.
PNPM_EXIT=0
PNPM_VERSION="$(pnpm --version)" || PNPM_EXIT=$?
if [ "$PNPM_EXIT" -ne 0 ]; then
  PNPM_REASON="$(first_line "$PNPM_VERSION")"
  step "pnpm" "present but fails: ${PNPM_REASON:-exit $PNPM_EXIT}"
  exit 1
fi
step "pnpm" "$PNPM_VERSION"

# 4. Dependencies, from the lockfile. Frozen, so a bootstrap never rewrites
#    it: a lockfile change is a decision, not a side effect of setup.
if [ -d node_modules ] && [ -f node_modules/.modules.yaml ]; then
  step "dependencies" "already installed"
elif [ "$CHECK_ONLY" -eq 1 ]; then
  step "dependencies" "MISSING — run: pnpm install --frozen-lockfile"
else
  # The install prints to the terminal. The hook runs `--check`, which never
  # reaches this branch, so no registry text enters an agent's context.
  say "  installing dependencies (pnpm install --frozen-lockfile)…"
  pnpm install --frozen-lockfile
  step "dependencies" "installed"
fi

# 5. The commit hook. It blocks an edit to docs/v1-architecture.md that cites
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

# 6. `.env`. Copied from the example, which names every variable a process
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

# 7. Docker. Reported, never started.
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
  say "  - Later, to run the consumer or a model job: put OPENROUTER_API_KEY in .env."
  say "    The Quickstart needs none, and this script never invents a credential."
fi
if [ "$DOCKER_READY" -eq 1 ]; then
  say "  - docker compose --profile test up -d --wait   Postgres on 5433, GreenMail on 3025/3143"
else
  say "  - start Docker, then: docker compose --profile test up -d --wait"
fi
say "  - export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle"
say "  - export READER_DATABASE_URL=postgres://auracle_reader:auracle_reader@localhost:5433/auracle"
say "  - export MAIL_HOST=127.0.0.1     so no suite starts a throwaway container"
say "  - pnpm run db:migrate            writes to that database, so you choose when"
say ""
say "Then: pnpm run verify:fast, and pnpm run verify before a pull request."
say "README.md, section Quickstart, has the whole path, the console included."
