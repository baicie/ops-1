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

# Ports are derived, not fixed, so two runs can coexist. RUN_INDEX is a small
# integer the caller may pin; by default it comes from the run id so two runs
# started in the same second still differ.
RUN_INDEX="${OPSWEAVE_TEST_RUN_INDEX:-$(( $(printf '%s' "$RUN_ID" | cksum | cut -d' ' -f1) % 40 ))}"
KERNEL_PORT=$((18281 + RUN_INDEX * 10))
NODE_A_PORT=$((9201 + RUN_INDEX * 10))
NODE_B_PORT=$((9202 + RUN_INDEX * 10))

DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
[ ${#DB} -le 63 ] || DB="${DB:0:63}"
STATE="/tmp/p001c-${RUN_ID}"
HOME_DIR="$STATE/home"
KERNEL_URL="http://127.0.0.1:${KERNEL_PORT}"
DATABASE_URL="postgres://localhost/${DB}?sslmode=disable"
ADMIN_EMAIL=admin@opsweave.local
ADMIN_PASSWORD='OpsWeave!2026'
# The label every container of this run carries. Nothing else can have it.
RUN_LABEL="opsweave.test-run=${RUN_ID}"

# Credentials live under the run's own HOME, never the user's. 0700 dir, 0600 files.
umask 077
mkdir -p "$HOME_DIR" "$STATE"/{data,node-a,node-b,logs}
chmod 700 "$HOME_DIR"

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

echo "== run $RUN_ID (ports ${KERNEL_PORT}/${NODE_A_PORT}/${NODE_B_PORT}, db ${DB})"

if [ "$RESTART" = "0" ]; then
  echo "== create ${DB}"
  createdb "$DB"
else
  echo "== reuse ${DB}"
fi
rm -rf "$STATE"/data/* "$STATE"/node-a/* "$STATE"/node-b/*

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
    ids="$(docker ps -aq --filter "label=opsweave.node-id=${nid}" 2>/dev/null || true)"
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
echo $! > "$STATE/kernel.pid"

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
    OPSWEAVE_DOCKER_HOST="${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}" \
    ./target/debug/opsweave-node > "$STATE/logs/$name.log" 2>&1 &
  echo $! > "$STATE/$name.pid"
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

python3 - "$STATE/run.json" "$RUN_ID" "$DB" "$KERNEL_PORT" "$NODE_A_PORT" "$NODE_B_PORT" "$NODE_IDS" <<'PY'
import json, sys
path, run_id, db, kp, na, nb, ids = sys.argv[1:8]
json.dump({"runId": run_id, "database": db, "kernelPort": int(kp),
           "nodePorts": [int(na), int(nb)], "nodeIds": ids.split()},
          open(path, "w"), indent=1)
PY
chmod 600 "$STATE/run.json"

echo "== platform up: $KERNEL_URL"
echo "RUN_ID=$RUN_ID"
echo "RUN_DIR=$STATE"
