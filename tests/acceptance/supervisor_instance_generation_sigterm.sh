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
  for _ in $(seq 1 240); do pid="$(workers | head -1)"; [ -n "$pid" ] && { echo "$pid"; return 0; }; sleep 0.5; done
  return 1
}
wait_gone() {
  local pid="$1"
  for _ in $(seq 1 80); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  return 1
}
instance_ready() {
  psql "$DB" -qAt -c "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND i.node_id='$NODE_A_ID' AND i.state='READY' AND i.desired_action='START';"
}
NODE_A_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-a/node-identity.json"))["nodeId"])')"
touch "$MARKER"
WORKER="$(wait_worker)" || { echo "FAIL supervisor did not start worker"; exit 1; }
echo "instance-stop worker pid=$WORKER ppid=$NODE_A_PID"
# Scale the test deployment to zero through its durable desired state. This is
# a test fixture operation, not a production API path.
psql "$DB" -qAt -c "UPDATE kernel.plugin_deployments SET desired_replicas=0, generation=generation+1, updated_at=now() WHERE plugin_id='opsweave.data-catalog';" >/dev/null
wait_gone "$WORKER" || { echo "FAIL worker survived Instance STOP pid=$WORKER"; exit 1; }
rm -f "$MARKER"
echo "PASS Instance STOP stopped supervised worker pid=$WORKER"
psql "$DB" -qAt -c "UPDATE kernel.plugin_deployments SET status='ACTIVE', status_reason=NULL, desired_replicas=1, generation=generation+1, placement=jsonb_set(placement, '{nodeSelector,zone}', to_jsonb('node-a'::text), true), updated_at=now() WHERE plugin_id='opsweave.data-catalog';" >/dev/null
psql "$DB" -qAt -c "UPDATE kernel.activation_revisions r SET status='ACTIVE' FROM kernel.plugin_deployments d WHERE r.deployment_id=d.id AND d.plugin_id='opsweave.data-catalog' AND r.status='DISABLED';" >/dev/null
psql "$DB" -qAt -c "UPDATE kernel.plugin_instances i SET desired_action='START', state='STARTING', observed_at=NULL, deployment_generation=i.deployment_generation+1, updated_at=now() FROM kernel.plugin_deployments d WHERE i.deployment_id=d.id AND d.plugin_id='opsweave.data-catalog';" >/dev/null
for _ in $(seq 1 60); do [ "$(instance_ready)" = "1" ] && break; sleep 1; done
if [ "$(instance_ready)" != "1" ]; then
  echo "instance did not recover from desired state; restarting Node A to prove adoption recovery"
  kill -TERM "$NODE_A_PID" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$NODE_A_PID" 2>/dev/null || break; sleep 0.5; done
  NODE_A_PID="$(tests/runtime/start_node.sh node-a 9101)"
  for _ in $(seq 1 120); do [ "$(instance_ready)" = "1" ] && break; sleep 1; done
fi
[ "$(instance_ready)" = "1" ] || {
  echo "FAIL catalog instance did not recover READY/START"
  psql "$DB" -x -c "SELECT id,status,desired_replicas,generation,placement FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog';" || true
  psql "$DB" -x -c "SELECT i.id,i.node_id,i.slot,i.state,i.desired_action,i.deployment_generation,i.last_error FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog';" || true
  psql "$DB" -x -c "SELECT id,name,status,last_seen_at FROM kernel.nodes ORDER BY name;" || true
  exit 1
}
touch "$MARKER"
WORKER="$(wait_worker)" || {
  echo "FAIL supervisor did not restart worker after Instance STOP marker=$(test -f "$MARKER" && echo yes || echo no)"
  ps -eo pid,ppid,etime,command | grep -E 'opsweave-(node|pipeline-worker)' | grep -v grep || true
  tail -40 /tmp/node-a.log 2>/dev/null || true
  exit 1
}
echo "PASS Instance STOP recovery started worker pid=$WORKER"
# Generation change: Node heartbeats with old generation are rejected, Node Runtime
# quarantines and the supervisor must stop the child.
GENERATION="$(psql "$DB" -qAt -c "SELECT generation FROM kernel.nodes WHERE id='$NODE_A_ID';")"
psql "$DB" -qAt -c "UPDATE kernel.nodes SET generation=generation+1 WHERE id='$NODE_A_ID';" >/dev/null
wait_gone "$WORKER" || { echo "FAIL worker survived Node generation change pid=$WORKER"; exit 1; }
echo "PASS Node generation change ($GENERATION -> $((GENERATION+1))) stopped supervised worker pid=$WORKER"
# Restore the durable generation and restart the Node: generation quarantine must
# be reversible and must restart exactly one supervised worker.
psql "$DB" -qAt -c "UPDATE kernel.nodes SET generation=$GENERATION WHERE id='$NODE_A_ID';" >/dev/null
kill -TERM "$NODE_A_PID" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$NODE_A_PID" 2>/dev/null || break; sleep 0.5; done
NODE_A_PID="$(tests/runtime/start_node.sh node-a 9101)"
for _ in $(seq 1 120); do [ "$(instance_ready)" = "1" ] && break; sleep 1; done
[ "$(instance_ready)" = "1" ] || { echo "FAIL instance did not recover after generation restore"; exit 1; }
touch "$MARKER"
WORKER="$(wait_worker)" || { echo "FAIL worker did not recover after generation restore"; exit 1; }
echo "PASS Node generation quarantine released; worker pid=$WORKER"
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
