#!/bin/sh
# The image's command: one argument, one process.
#
# `exec` in every branch, so the process replaces this shell and receives
# SIGTERM directly. Without it the shell is PID 1, docker stop reaches the
# shell alone, and the consumer is killed ten seconds later mid-step instead
# of finishing the one it holds.
#
# No default branch. A container started with no argument names no process,
# and picking one would start a daemon nobody asked for.
set -eu

usage() {
	cat >&2 <<'EOF'
usage: <image> <process>

  webhook    HTTP intake
  imap       mailbox intake
  consumer   the state machine, for its partitions
  relay      drains the outbox to the adapters
  console    the operator console
  migrate    applies db/ in order, restates auracle_reader, then exits

Every process reads its configuration from the environment. See .env.example.
EOF
	exit 64
}

[ "$#" -ge 1 ] || usage

process="$1"
shift

case "$process" in
webhook) exec node /app/dist/intake/webhook-main.js "$@" ;;
imap) exec node /app/dist/imap/main.js "$@" ;;
consumer) exec node /app/dist/coordinator/consumer-main.js "$@" ;;
relay) exec node /app/dist/relay/main.js "$@" ;;
console) exec node /app/console/dist/main.js "$@" ;;
migrate) exec node /app/dist/ledger/migrate.js "$@" ;;
# A name this script does not know is a typo in a deploy manifest. Refusing
# is louder than falling through to a shell, and a container that starts a
# shell instead of a daemon reports healthy while doing nothing.
*)
	echo "unknown process '$process'" >&2
	usage
	;;
esac
