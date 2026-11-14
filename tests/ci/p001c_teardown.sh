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
#
# ---------------------------------------------------------------------------
# Why the Docker precondition is checked before anything else
# ---------------------------------------------------------------------------
# This script used to ask the daemon like this:
#
#     ids="$(docker ps -aq --filter ... 2>/dev/null || true)"
#     [ -n "$ids" ] || continue
#
# With the daemon unreachable, `docker ps` fails, `2>/dev/null` hides why, `|| true`
# makes the failure a success, and `$(...)` captures the empty stdout. The next
# line then reads that empty string as "this run owns no containers". The script
# reported `removed 0 container(s)`, dropped the database and deleted the state
# directory - so the containers were left running with nothing on disk left to
# say whose they were. That is worse than not cleaning up at all: ownership
# evidence is exactly what a later manual recovery needs.
#
# The rule now: the daemon is a PRECONDITION, checked once, before processes are
# stopped. A query that fails is BLOCKED (exit 2) and NOTHING is removed,
# dropped or deleted.
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

STATE="${OPSWEAVE_TEARDOWN_STATE_DIR:-/tmp/p001c-${RUN_ID}}"
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

# --- Docker is a precondition, not a best-effort query ----------------------
#
# Checked ONCE, up front, with the reason preserved. `docker info` is the
# cheapest call that proves the daemon answers; if it fails, the run stops with
# every container still running and every file still on disk, so a human (or a
# later automated attempt) can recover ownership from run.json.
if ! docker_err="$(docker info --format '{{.ServerVersion}}' 2>&1 >/dev/null)"; then
  echo "BLOCKED: the Docker daemon is not reachable, so this script cannot prove" >&2
  echo "         which containers run $RUN_ID owns. Nothing was stopped, removed," >&2
  echo "         dropped or deleted: $STATE and database $DB are intact so ownership" >&2
  echo "         can still be recovered." >&2
  echo "         daemon said: ${docker_err:-<no output>}" >&2
  exit 2
fi

# --- container inventory, taken BEFORE anything is touched ------------------
#
# Every id this run owns, plus a full list of every container on the daemon so
# the post-check can prove nothing else moved. Snapshotting first is what makes
# "I removed exactly mine" a checkable claim rather than an assertion.
snapshot_containers() {
  # Prints one `id<TAB>installation-id<TAB>node-id` line per container.
  docker ps -a --no-trunc \
    --format '{{.ID}}\t{{.Label "opsweave.installation-id"}}\t{{.Label "opsweave.node-id"}}'
}

if ! BEFORE_ALL="$(snapshot_containers)"; then
  echo "BLOCKED: could not list containers. Nothing was changed." >&2
  exit 2
fi

OWNED_IDS=""
for nid in $NODE_IDS; do
  # Node id alone is not ownership - see p001c_up.sh. The installation id is the
  # same predicate the product itself uses, so this removes exactly what the
  # node would remove, no more.
  if ! ids="$(docker ps -aq --filter "label=opsweave.node-id=${nid}" \
      --filter "label=opsweave.installation-id=${INSTALLATION_ID}" 2>&1)"; then
    echo "BLOCKED: could not query containers of node $nid. Nothing was changed." >&2
    echo "         daemon said: ${ids:-<no output>}" >&2
    exit 2
  fi
  OWNED_IDS="$OWNED_IDS $ids"
done
# De-duplicated and whitespace-normalised, so the count below is ids, not lines.
OWNED_IDS="$(printf '%s\n' $OWNED_IDS | sort -u | tr '\n' ' ')"

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

# --- removal, by immutable id ----------------------------------------------
removed=0
for id in $OWNED_IDS; do
  if ! out="$(docker rm -f "$id" 2>&1 >/dev/null)"; then
    echo "BLOCKED: could not remove container $id; not widening the sweep" >&2
    echo "         daemon said: ${out:-<no output>}" >&2
    echo "         $STATE and database $DB were left intact." >&2
    exit 1
  fi
  removed=$((removed + 1))
done
echo "   removed $removed container(s) belonging to this run"

# --- post-check: the removal really happened, and nothing else moved --------
#
# Three separate claims, each checked against a fresh daemon query:
#   1. every id we set out to remove is gone;
#   2. every OTHER container that existed before still exists;
#   3. the daemon still answers (a removal that coincided with the daemon going
#      away must not read as success).
if ! AFTER_ALL="$(snapshot_containers)"; then
  echo "BLOCKED: containers were removed but the daemon stopped answering, so their" >&2
  echo "         absence could not be verified. Check by hand: $OWNED_IDS" >&2
  exit 2
fi

after_ids="$(printf '%s\n' "$AFTER_ALL" | cut -f1)"
survivors=""
for id in $OWNED_IDS; do
  if printf '%s\n' "$after_ids" | grep -qxF "$id"; then survivors="$survivors $id"; fi
done
if [ -n "$survivors" ]; then
  echo "BLOCKED: these containers still exist after removal was attempted:$survivors" >&2
  exit 1
fi

before_ids="$(printf '%s\n' "$BEFORE_ALL" | cut -f1 | sort -u)"
foreign_before="$(printf '%s\n' "$before_ids" | grep -vxF -f <(printf '%s\n' $OWNED_IDS) || true)"
missing_foreign=""
for id in $foreign_before; do
  [ -n "$id" ] || continue
  if ! printf '%s\n' "$after_ids" | grep -qxF "$id"; then missing_foreign="$missing_foreign $id"; fi
done
if [ -n "$missing_foreign" ]; then
  echo "FAIL: containers this run did not own disappeared during teardown:$missing_foreign" >&2
  echo "      That is the sweep this script exists to avoid. Investigate before" >&2
  echo "      trusting any other cleanup result." >&2
  exit 1
fi
echo "   verified: $removed owned container(s) gone, all other containers untouched"

if [ "$PURGE" = "1" ]; then
  # `--force` is required, and its absence made every purge BLOCKED: killing the
  # node processes does not close their connections at once - sqlx pools idle for
  # a while and the kernel holds its own - so a plain `dropdb` refuses with
  # "is being accessed by other users". `demo_up.sh` already uses --force for the
  # same reason. This only terminates sessions on THIS run's database, whose name
  # is derived from the run id.
  #
  # It runs only after the post-check above passed: deleting the database before
  # proving the containers are gone would destroy the ability to find them.
  if ! db_err="$(dropdb --if-exists --force "$DB" 2>&1 >/dev/null)"; then
    echo "BLOCKED: could not drop $DB; state directory $STATE kept for inspection" >&2
    echo "         psql said: ${db_err:-<no output>}" >&2
    exit 1
  fi
  rm -rf "$STATE"
  echo "   purged $DB and $STATE"
else
  echo "   kept $STATE and $DB (pass --purge to remove)"
fi
