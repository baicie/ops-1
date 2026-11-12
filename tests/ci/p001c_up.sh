#!/usr/bin/env bash
# P001-C1.1 — a plugin-lifecycle test platform that cannot touch anything else.
#
# WHY THIS FILE WAS REWRITTEN
#
# The previous version ended its reset with:
#
#     docker ps -aq --filter label=opsweave.managed=true | xargs -r docker rm -f
#
# That is a delete-everything sweep across the whole Docker daemon. It happened
# to be harmless only because the containers it removed were abandoned leftovers;
# the moment another OpsWeave installation - or another concurrent run of this
# very script - had a live container on the same daemon, it would have destroyed
# it. A test harness that relies on "there is probably nothing else here" is not
# isolated, it is lucky.
#
# Every resource below is now derived from a single RUN_ID:
#
#   database      p001c_<runid>            (was a fixed `p001c`)
#   state dir     /tmp/p001c-<runid>       (was a fixed /tmp/p001c)
#   ports         derived from RUN_INDEX   (was fixed 18281/9201/9202)
#   HOME          /tmp/p001c-<runid>/home  (was the user's real $HOME)
#   containers    labelled opsweave.node-id=<this run's node ids>
#
# Cleanup matches on the node ids this run enrolled, which the node already
# stamps on every container it creates (`opsweave.node-id=` in docker.rs). That
# id is a fresh UUID per database, so it cannot collide with another run's or
# another installation's containers - unlike `opsweave.managed=true`, which every
# OpsWeave node in the world also sets.
#
# Usage:
#   tests/ci/p001c_up.sh              # start a new run, print its id
#   tests/ci/p001c_up.sh --run-id X   # restart a specific run
#   tests/ci/p001c_teardown.sh X      # stop and remove only run X
#
# Prints `RUN_ID=...` on the last line so callers can capture it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

RUN_ID="${OPSWEAVE_TEST_RUN_ID:-}"
RESTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; RESTART=1; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$RUN_ID" ]; then
  RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

# A run id reaches a database name, a filesystem path and a shell word, so it is
# validated before any of those are built. Without this, a caller-supplied id
# could contain "/" or ";" and escape its own namespace.
case "$RUN_ID" in
  *[!A-Za-z0-9._-]*)
    echo "invalid RUN_ID '$RUN_ID': only [A-Za-z0-9._-] are allowed" >&2; exit 2 ;;
esac
if [ "${#RUN_ID}" -lt 8 ] || [ "${#RUN_ID}" -gt 80 ]; then
  echo "invalid RUN_ID length ${#RUN_ID}: must be 8..80 characters" >&2; exit 2
fi
case "$RUN_ID" in
  .|..|.*) echo "invalid RUN_ID '$RUN_ID': must not start with a dot" >&2; exit 2 ;;
esac

# Ports are derived, not fixed, so two runs can coexist. RUN_INDEX is a small
# integer the caller may pin; by default it comes from the run id so two runs
# started in the same second still differ.
RUN_INDEX="${OPSWEAVE_TEST_RUN_INDEX:-$(( $(printf '%s' "$RUN_ID" | cksum | cut -d' ' -f1) % 40 ))}"
KERNEL_PORT=$((18281 + RUN_INDEX * 10))
NODE_A_PORT=$((9201 + RUN_INDEX * 10))
NODE_B_PORT=$((9202 + RUN_INDEX * 10))

DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
# PostgreSQL truncates identifiers at 63 bytes, and silent truncation is how two
# different run ids would collide on one database. Refuse instead of trimming.
if [ "${#DB}" -gt 63 ]; then
  echo "RUN_ID '$RUN_ID' yields a ${#DB}-character database name; the limit is 63." >&2
  echo "Use a shorter id; truncating would let two runs share one database." >&2
  exit 2
fi
STATE="/tmp/p001c-${RUN_ID}"
HOME_DIR="$STATE/home"
KERNEL_URL="http://127.0.0.1:${KERNEL_PORT}"
DATABASE_URL="postgres://localhost/${DB}?sslmode=disable"
ADMIN_EMAIL=admin@opsweave.local
ADMIN_PASSWORD='OpsWeave!2026'
# The label every container of this run carries. Nothing else can have it.

# Credentials live under the run's own HOME, never the user's. 0700 dir, 0600 files.
umask 077
mkdir -p "$HOME_DIR" "$STATE"/{data,node-a,node-b,logs}
chmod 700 "$HOME_DIR"

# --- process identity -------------------------------------------------------
# A pidfile alone is not ownership: PIDs are recycled, so `kill -0 $pid` can be
# true for an unrelated process that inherited the number after ours exited.
# Each pidfile therefore carries a fingerprint captured at start, and teardown
# refuses to signal a PID whose fingerprint no longer matches.
#
# The fingerprint is the process start time, which is stable for the life of a
# process and different for a recycled PID.
proc_start_token() {
  local pid="$1"
  if [ -r "/proc/$pid/stat" ]; then
    # Field 22 of /proc/<pid>/stat is starttime in clock ticks since boot.
    local stat; stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
    # comm may contain spaces/parens; split on the LAST ')'
    local rest="${stat##*) }"
    # rest starts at field 3 (state); starttime is field 22 -> index 20 here
    set -- $rest
    printf 'proc:%s\n' "${20}"
  else
    # macOS: lstart is a stable human-readable start timestamp.
    # lstart has one-second resolution, so a fast PID recycle could collide.
    # The command name is added to narrow it: an unrelated process reusing the
    # number in the same second would also have to share the binary name.
    local ls; ls="$(ps -o lstart=,comm= -p "$pid" 2>/dev/null)" || return 1
    [ -n "$ls" ] || return 1
    printf 'ps:%s\n' "$(printf '%s' "$ls" | tr -s ' ')"
  fi
}

write_fingerprint() {
  local pidf="$1" pid token
  pid="$(cat "$pidf" 2>/dev/null)" || return 0
  token="$(proc_start_token "$pid" 2>/dev/null)" || token=""
  printf '%s' "$token" > "$pidf.start"
  chmod 600 "$pidf.start" 2>/dev/null || true
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


# --- ownership guard --------------------------------------------------------
# Before removing anything, prove the target exists AND belongs to this run.
# A wrong RUN_ID must abort rather than delete a stranger's state.
if [ "$RESTART" = "1" ] && [ -d "$STATE" ] && [ -f "$STATE/run.json" ]; then
  recorded="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['runId'])" "$STATE/run.json" 2>/dev/null || echo '')"
  if [ "$recorded" != "$RUN_ID" ]; then
    echo "REFUSING: $STATE records run '$recorded', not '$RUN_ID'" >&2
    exit 1
  fi
fi

# Stop any process this run previously started, and wait for it to actually exit
# before its state is cleared. Deleting a node's identity while its process is
# still alive is what produced the quarantine stall on 2026-11-11.
stop_pidfile() {
  local pidfile="$1" name="$2"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile" 2>/dev/null || echo '')"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  if ! pid_owns_fingerprint "$pidfile"; then
    # The PID is gone, or the number now belongs to something else. Either way
    # this is not ours to signal.
    rm -f "$pidfile" "$pidfile.start"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || { rm -f "$pidfile"; return 0; }
    sleep 0.2
  done
  echo "REFUSING: $name (pid $pid) did not exit; not clearing its state" >&2
  exit 1
}

for p in kernel node-a node-b; do
  # Only this run's pidfiles are read; the paths are namespaced by RUN_ID.
  stop_pidfile "$STATE/$p.pid" "$p"
done

# Ports are derived from RUN_INDEX, which is deterministic per run id - so a
# leftover process from an earlier run can hold the same port and the kernel then
# dies with "Address already in use" several steps later. Check before starting
# anything and name the holder, so the operator can see what to stop.
# Always succeeds: an empty result means "free", and `set -e` must not treat a
# free port as an error. `|| true` is inside the substitution so the caller's
# assignment stays a success.
port_holder() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
for candidate_port in "$KERNEL_PORT" "$NODE_A_PORT" "$NODE_B_PORT"; do
  holder="$(port_holder "$candidate_port")"
  if [ -n "$holder" ]; then
    echo "BLOCKED: port $candidate_port is held by pid $holder ($(ps -p "$holder" -o comm= 2>/dev/null))." >&2
    echo "         It is probably a leftover process from an earlier run; stop it and retry." >&2
    exit 1
  fi
done

echo "== run $RUN_ID (ports ${KERNEL_PORT}/${NODE_A_PORT}/${NODE_B_PORT}, db ${DB})"

if [ "$RESTART" = "0" ]; then
  echo "== create ${DB}"
  createdb "$DB"
else
  echo "== reuse ${DB}"
fi
# The node state dirs are cleared for a clean platform, but the installation
# identity must survive: it is what makes this run's containers distinguishable
# from another install's. A new identity on every restart would orphan every
# container the previous incarnation created - the containers stay on the daemon
# carrying the old id, and the new node correctly refuses to touch them forever.
#
# Captured before the wipe, restored after. Only `--purge` removes it, together
# with the containers it names.
saved_install_id=""
if [ -f "$STATE/node-a/installation-id" ]; then
  saved_install_id="$(cat "$STATE/node-a/installation-id")"
fi
rm -rf "$STATE"/data/* "$STATE"/node-a/* "$STATE"/node-b/*
# ONE id for both nodes, minted once. Two ids here would be a real defect: the
# run record stores a single installationId, so teardown would clean only the
# node whose id it recorded and leave the other's containers behind forever.
if [ -z "$saved_install_id" ]; then
  saved_install_id="$(python3 -c 'import uuid;print(uuid.uuid4())')"
fi
for inst in node-a node-b; do
  printf '%s' "$saved_install_id" > "$STATE/$inst/installation-id"
  chmod 600 "$STATE/$inst/installation-id"
done

# Containers created by a PREVIOUS incarnation of this run carry the node ids
# recorded in run.json. That is the only thing removed here: a specific set of
# node ids, never `opsweave.managed=true`.
#
# The condition is RESTART=1, and it was written as RESTART=0 at first - which
# made the whole block dead code, because a freshly generated run id always has
# a new state dir with no run.json in it. The isolation guard still passed while
# the global sweep was deliberately reintroduced here, which is how the mistake
# surfaced: a cleanup branch that never runs cannot fail a test that only starts
# fresh runs.
if [ "$RESTART" = "1" ] && [ -f "$STATE/run.json" ]; then
  old_nodes="$(python3 - "$STATE/run.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(" ".join(d.get("nodeIds", [])))
except Exception:
    print("")
PY
)"
  for nid in $old_nodes; do
    # Both filters. The node id alone is not ownership: it survives a database
    # restore or a copied state directory, so an unrelated install can share it.
    # The run label is set only by this run's nodes.
    ids="$(docker ps -aq --filter "label=opsweave.node-id=${nid}" \
      --filter "label=opsweave.test-run=${RUN_ID}" 2>/dev/null || true)"
    if [ -n "$ids" ]; then
      echo "== remove leftover containers of previous node $nid"
      # shellcheck disable=SC2086
      echo "$ids" | xargs -r docker rm -f >/dev/null 2>&1 || {
        echo "BLOCKED: could not remove containers labelled opsweave.node-id=$nid; not widening the sweep" >&2
        exit 1
      }
    fi
  done
fi

PUBLIC_KEY="$(cat keys/publisher.pub)"

echo "== start kernel on :${KERNEL_PORT}"
nohup env \
  HOME="$HOME_DIR" \
  OPSWEAVE_BIND="127.0.0.1:${KERNEL_PORT}" \
  OPSWEAVE_PUBLIC_URL="$KERNEL_URL" \
  DATABASE_URL="$DATABASE_URL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  OPSWEAVE_BOOTSTRAP_ADMIN_NAME="Platform Admin" \
  OPSWEAVE_DATA_DIR="$STATE/data" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-console/dist" \
  OPSWEAVE_OPS_WEB_DIST="$ROOT/apps/ops-web/dist" \
  OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
  OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$PUBLIC_KEY" \
  OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
  OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1 \
  OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=host.docker.internal \
  OPSWEAVE_LOG_FORMAT=json \
  ./target/debug/opsweave-kernel > "$STATE/logs/kernel.log" 2>&1 &
PIDF="$STATE/kernel.pid"
echo $! > "$PIDF"
write_fingerprint "$PIDF"

for _ in $(seq 1 60); do
  curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1 || {
  echo "kernel did not become live; see $STATE/logs/kernel.log" >&2
  tail -30 "$STATE/logs/kernel.log" >&2; exit 1; }
echo "   kernel live"

echo "== authenticate (session under $HOME_DIR)"
HOME="$HOME_DIR" ./target/debug/opsctl --url "$KERNEL_URL" login \
  --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null
TOKEN="$(HOME="$HOME_DIR" python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.opsweave/session.json')))['token'])")"
( umask 077; printf '%s' "$TOKEN" > "$STATE/token" )
chmod 600 "$STATE/token"

start_node() {
  local name="$1" port="$2" token="$3"
  nohup env \
    HOME="$HOME_DIR" \
    OPSWEAVE_KERNEL_URL="$KERNEL_URL" \
    OPSWEAVE_ENROLLMENT_TOKEN="$token" \
    OPSWEAVE_NODE_NAME="$name" \
    OPSWEAVE_NODE_LABELS="role=node,zone=local" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${port}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${port}" \
    OPSWEAVE_NODE_STATE_DIR="$STATE/$name" \
    OPSWEAVE_CONTAINER_LABELS="opsweave.test-run=${RUN_ID}" \
    OPSWEAVE_DOCKER_HOST="${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}" \
    ./target/debug/opsweave-node > "$STATE/logs/$name.log" 2>&1 &
  local pidf="$STATE/$name.pid"
  echo $! > "$pidf"
  write_fingerprint "$pidf"
}

echo "== enroll two nodes"
TOKEN_A="$(HOME="$HOME_DIR" ./target/debug/opsctl --url "$KERNEL_URL" node-token --label node-a 2>/dev/null)"
TOKEN_B="$(HOME="$HOME_DIR" ./target/debug/opsctl --url "$KERNEL_URL" node-token --label node-b 2>/dev/null)"
start_node node-a "$NODE_A_PORT" "$TOKEN_A"
start_node node-b "$NODE_B_PORT" "$TOKEN_B"

READY=0
for _ in $(seq 1 90); do
  READY="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$KERNEL_URL/api/v1/nodes" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sum(1 for n in d if n.get("status")=="READY" and not n.get("stale")))' 2>/dev/null || echo 0)"
  [ "$READY" = "2" ] && break
  sleep 1
done
if [ "$READY" != "2" ]; then
  echo "expected 2 READY nodes, got ${READY:-0}" >&2
  tail -20 "$STATE"/logs/node-a.log "$STATE"/logs/node-b.log >&2 || true
  exit 1
fi
echo "   2 nodes READY"

NODE_IDS="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$KERNEL_URL/api/v1/nodes" 2>/dev/null \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(n["id"] for n in d if n.get("status")=="READY" and not n.get("stale")))' 2>/dev/null || echo '')"
if [ -z "$NODE_IDS" ]; then
  echo "could not read the enrolled node ids; refusing to write a run record that cannot clean up" >&2
  exit 1
fi

python3 - "$STATE/run.json" "$RUN_ID" "$DB" "$KERNEL_PORT" "$NODE_A_PORT" "$NODE_B_PORT" "$NODE_IDS" \
  "$(cat "$STATE/node-a/installation-id")" <<'PY'
import json, sys
path, run_id, db, kp, na, nb, ids, installation = sys.argv[1:9]
# `installationId` is recorded so teardown can use the same ownership filter the
# product uses, instead of a test-only label that production never stamps.
json.dump({"runId": run_id, "database": db, "kernelPort": int(kp),
           "nodePorts": [int(na), int(nb)], "nodeIds": ids.split(),
           "installationId": installation},
          open(path, "w"), indent=1)
PY
chmod 600 "$STATE/run.json"

echo "== platform up: $KERNEL_URL"
echo "RUN_ID=$RUN_ID"
echo "RUN_DIR=$STATE"
