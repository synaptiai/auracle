#!/usr/bin/env bash
# The synthetic-fixture rule (DEC-18) over the files a pull request changed.
#
# This is the one guardrail that cannot be a plain `pnpm run` target: it needs
# the pull request's base commit, which exists only in CI. The rest are named
# targets in package.json.
#
# Every changed text file, not an include list. Real customer data added to
# docs/, a test file or src/test-support/ used to be caught by neither this
# job nor the in-session hook.
#
# Paths are carried NUL-delimited from `git diff` to the guard. The inline
# bash this replaced word-split an unquoted `$files`, so a changed file whose
# name held a space reached the guard as two paths that do not exist and it
# died with a traceback. That failed closed, which is the right direction, but
# it named neither the real file nor the real reason.
#
# The range is verified before it is used. `set -e` cannot see the exit status
# of a process substitution, so a `git diff` that fails against an unreachable
# base — a fork, a force-pushed base, a shallow checkout — would hand this
# loop an empty list and the only diff-scoped PII check would report a clean
# pass. An unusable range is a fault, not an empty change set.
set -euo pipefail

RANGE="${1:?usage: check-changed-pii.sh BASE...HEAD}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# git diff prints paths relative to the repository root, so the guard must
# read them from there whatever directory the caller stood in.
cd "$ROOT"

if ! git rev-parse --verify --quiet "${RANGE%%.*}^{commit}" >/dev/null; then
  echo "check-changed-pii.sh: the base of '$RANGE' is not a commit this" \
       "checkout can reach, so the scan would pass without reading a file." >&2
  exit 1
fi

files=()
while IFS= read -r -d '' path; do
  case "$path" in
    pnpm-lock.yaml|package-lock.json) continue ;;
    *.png|*.jpg|*.jpeg|*.gif|*.svg|*.ico|*.pdf|*.woff|*.woff2|*.ttf|*.zip|*.gz) continue ;;
  esac
  files+=("$path")
done < <(git diff -z --name-only --diff-filter=d "$RANGE")

if [ ${#files[@]} -eq 0 ]; then
  echo "no text files changed"
  exit 0
fi

python3 "$ROOT/.claude/hooks/fixtures_pii_guard.py" "${files[@]}"
