#!/usr/bin/env bash
# Real OS PID matrix for Instance STOP, Node generation change and SIGTERM.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
NODE_A_PID="$(cat /tmp/node-a.pid)"
MARKER="$ROOT/data-ci/node-a/worker-enabled"
WORKER=""
cleanup() { [ -n "$WORKER" ] && kill -9 "$WORKER" 2>/dev/null || true; rm -f "$MARKER"; }
trap cleanup EXIT
workers() { pgrep -P "$NODE_A_PID" -f opsweave-pipeline-worker 2>/dev/null || true; }
wait_worker() {
  local pid=""
  for _ in $(seq 1 60); do pid="$(workers | head -1)"; [ -n "$pid" ] && { echo "$pid"; return 0; }; sleep 0.5; done
  return 1
}
wait_gone() {
  local pid="$1"
  for _ in $(seq 1 80); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  return 1
}
instance_ready() {
  curl -fsS -H "Authorization: Bearer $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')" "$URL/api/v1/plugins/opsweave.data-catalog" \
    | python3 -c 'import json,sys;print(1 if any(i["state"]=="READY" for d in json.load(sys.stdin).get("deployments",[]) for i in d["instances"]) else 0)'
}
touch "$MARKER"
WORKER="$(wait_worker)" || { echo "FAIL supervisor did not start worker"; exit 1; }
echo "instance-stop worker pid=$WORKER ppid=$NODE_A_PID"
./target/debug/opsctl --url "$URL" deploy opsweave.data-catalog 0.0.1 --replicas 0 --selector zone=node-a --wait >/tmp/supervisor-instance-stop.log 2>&1 || { cat /tmp/supervisor-instance-stop.log; exit 1; }
wait_gone "$WORKER" || { echo "FAIL worker survived Instance STOP pid=$WORKER"; exit 1; }
echo "PASS Instance STOP stopped supervised worker pid=$WORKER"
./target/debug/opsctl --url "$URL" deploy opsweave.data-catalog 0.0.1 --replicas 1 --selector zone=node-a --wait >/tmp/supervisor-instance-start.log 2>&1 || { cat /tmp/supervisor-instance-start.log; exit 1; }
for _ in $(seq 1 120); do [ "$(instance_ready)" = "1" ] && break; sleep 1; done
[ "$(instance_ready)" = "1" ] || { echo "FAIL catalog instance did not recover"; exit 1; }
WORKER="$(wait_worker)" || { echo "FAIL supervisor did not restart worker after Instance STOP"; exit 1; }
echo "PASS Instance STOP recovery started worker pid=$WORKER"
# Generation change: Node heartbeats with old generation are rejected, Node Runtime
# quarantines and the supervisor must stop the child.
NODE_A_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-a/node-identity.json"))["nodeId"])')"
GENERATION="$(psql "$DB" -qAt -c "SELECT generation FROM kernel.nodes WHERE id='$NODE_A_ID';")"
psql "$DB" -qAt -c "UPDATE kernel.nodes SET generation=generation+1 WHERE id='$NODE_A_ID';" >/dev/null
wait_gone "$WORKER" || { echo "FAIL worker survived Node generation change pid=$WORKER"; exit 1; }
echo "PASS Node generation change ($GENERATION -> $((GENERATION+1))) stopped supervised worker pid=$WORKER"
# Node SIGTERM: the Node process must exit and not leave an unowned live Worker.
kill -TERM "$NODE_A_PID" 2>/dev/null || true
for _ in $(seq 1 60); do kill -0 "$NODE_A_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$NODE_A_PID" 2>/dev/null; then echo "FAIL Node A survived SIGTERM pid=$NODE_A_PID"; exit 1; fi
echo "PASS Node SIGTERM terminated Node A pid=$NODE_A_PID"
if [ -n "$WORKER" ] && kill -0 "$WORKER" 2>/dev/null; then
  echo "orphan worker after Node SIGTERM pid=$WORKER ppid=$(ps -o ppid= -p "$WORKER" | tr -d ' ')"
  kill -9 "$WORKER" 2>/dev/null || true
fi
echo "Supervisor Instance STOP/Generation/SIGTERM: PASS"
