#!/usr/bin/env bash
# P001-C1.1 - stop one test run and remove ONLY the resources it created.
#
# The counterpart to p001c_up.sh. Given a run id it stops that run's processes,
# removes containers carrying that run's node ids, and drops its database. It
# never uses `opsweave.managed=true` and never sweeps the daemon.
#
#   tests/ci/p001c_teardown.sh <run-id>          # stop, keep state for inspection
#   tests/ci/p001c_teardown.sh <run-id> --purge  # also delete state dir and db
#
# Anything it cannot verify as its own is reported BLOCKED and left alone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

RUN_ID="${1:-}"
PURGE=0
[ "${2:-}" = "--purge" ] && PURGE=1
if [ -z "$RUN_ID" ]; then
  echo "usage: $0 <run-id> [--purge]" >&2
  exit 2
fi

STATE="/tmp/p001c-${RUN_ID}"
if [ ! -f "$STATE/run.json" ]; then
  echo "BLOCKED: no run record at $STATE/run.json; refusing to guess what $RUN_ID owns" >&2
  exit 1
fi

recorded="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['runId'])" "$STATE/run.json" 2>/dev/null || echo '')"
if [ "$recorded" != "$RUN_ID" ]; then
  echo "BLOCKED: $STATE records run '$recorded', not '$RUN_ID'" >&2
  exit 1
fi

DB="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['database'])" "$STATE/run.json")"
NODE_IDS="$(python3 -c "import json,sys;print(' '.join(json.load(open(sys.argv[1])).get('nodeIds',[])))" "$STATE/run.json")"
# The installation identity the nodes were given. Cleanup matches on it as well
# as the node id, because the node id alone is exactly what another install can
# share after a restore. Older run records predate it; those runs fall back to
# the test-run label, and the guard below still refuses anything it cannot name.
INSTALLATION_ID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('installationId',''))" "$STATE/run.json")"
if [ -z "$INSTALLATION_ID" ]; then
  echo "BLOCKED: $STATE/run.json records no installationId; it cannot prove which containers it owns" >&2
  exit 1
fi

# --- process identity -------------------------------------------------------
# See p001c_up.sh: a pidfile is not ownership. Same routine, duplicated here so
# teardown can run standalone.
proc_start_token() {
  local pid="$1"
  if [ -r "/proc/$pid/stat" ]; then
    local stat; stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
    local rest="${stat##*) }"
    set -- $rest
    printf 'proc:%s\n' "${20}"
  else
    # lstart has one-second resolution, so a fast PID recycle could collide.
    # The command name is added to narrow it: an unrelated process reusing the
    # number in the same second would also have to share the binary name.
    local ls; ls="$(ps -o lstart=,comm= -p "$pid" 2>/dev/null)" || return 1
    [ -n "$ls" ] || return 1
    printf 'ps:%s\n' "$(printf '%s' "$ls" | tr -s ' ')"
  fi
}

pid_owns_fingerprint() {
  local pidf="$1" pid recorded current
  pid="$(cat "$pidf" 2>/dev/null)" || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -f "$pidf.start" ] || return 1
  recorded="$(cat "$pidf.start" 2>/dev/null)"
  [ -n "$recorded" ] || return 1
  current="$(proc_start_token "$pid" 2>/dev/null)" || return 1
  [ "$recorded" = "$current" ]
}

echo "== stopping run $RUN_ID"
stopped_pids=""
for p in node-a node-b kernel; do
  pidfile="$STATE/$p.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || echo '')"
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  if ! pid_owns_fingerprint "$pidfile"; then
    # Either the process is gone or the PID now names something else. Never
    # signal a PID we cannot prove is ours; report it instead of guessing.
    if kill -0 "$pid" 2>/dev/null; then
      echo "   pid $pid is alive but not this run's process; leaving it alone" >&2
    fi
    rm -f "$pidfile" "$pidfile.start"
    continue
  fi
  kill "$pid" 2>/dev/null || true
  stopped_pids="$stopped_pids $pid"
  rm -f "$pidfile" "$pidfile.start"
done
for pid in $stopped_pids; do
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then
    echo "BLOCKED: pid $pid still alive after 10s; leaving its resources untouched" >&2
    exit 1
  fi
done
echo "   processes stopped"

removed=0
for nid in $NODE_IDS; do
  # Node id alone is not ownership - see p001c_up.sh. The installation id is the
  # same predicate the product itself uses, so this removes exactly what the
  # node would remove, no more.
  ids="$(docker ps -aq --filter "label=opsweave.node-id=${nid}" \
    --filter "label=opsweave.installation-id=${INSTALLATION_ID}" 2>/dev/null || true)"
  [ -n "$ids" ] || continue
  # shellcheck disable=SC2086
  echo "$ids" | xargs -r docker rm -f >/dev/null 2>&1 || {
    echo "BLOCKED: could not remove containers of node $nid; not widening the sweep" >&2
    exit 1
  }
  removed=$((removed + $(echo "$ids" | wc -l | tr -d ' ')))
done
echo "   removed $removed container(s) belonging to this run"

if [ "$PURGE" = "1" ]; then
  dropdb --if-exists "$DB" 2>/dev/null || {
    echo "BLOCKED: could not drop $DB" >&2; exit 1; }
  rm -rf "$STATE"
  echo "   purged $DB and $STATE"
else
  echo "   kept $STATE and $DB (pass --purge to remove)"
fi
