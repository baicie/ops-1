#!/usr/bin/env bash
# Node Runtime SIGKILL leaves the worker child orphaned. Verify it cannot create
# authoritative effects after the replacement Node takes over with a new fence.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
cleanup_worker() {
  [ -n "${OLD_WORKER_PID:-}" ] && kill -9 "$OLD_WORKER_PID" 2>/dev/null || true
}
trap cleanup_worker EXIT
# Restart Node B with a long batch delay so the orphan cannot finish the job
# before its Lease/Node authority expires.
NODE_B_PID="$(cat /tmp/node-b.pid 2>/dev/null || true)"
if [ -n "$NODE_B_PID" ]; then
  for worker_pid in $(pgrep -P "$NODE_B_PID" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
  kill -9 "$NODE_B_PID" 2>/dev/null || true
fi
sleep 1
OPSWEAVE_WORKER_BATCH_DELAY_MS=90000 tests/runtime/start_node.sh node-b 9102 >/tmp/orphan-node-b.pid
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:9102/healthz >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:9102/healthz >/dev/null
NODE_B_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-b/node-identity.json"))["nodeId"])')"
for _ in $(seq 1 120); do
  READY="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/nodes" | python3 -c 'import json,sys;d=json.load(sys.stdin);nid=sys.argv[1];print(next((1 for n in d if n["id"]==nid and n.get("status")=="READY" and not n.get("stale")),0))' "$NODE_B_ID")"
  [ "$READY" = "1" ] && break
  sleep 1
done
[ "$READY" = "1" ] || bad "Node B did not become READY for orphan scenario"
for _ in $(seq 1 120); do
  INSTANCE_READY="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/plugins/opsweave.data-integration" | python3 -c 'import json,sys;d=json.load(sys.stdin);nid=sys.argv[1];print(next((1 for dep in d.get("deployments",[]) for i in dep["instances"] if i["nodeId"]==nid and i["state"]=="READY"),0))' "$NODE_B_ID")"
  [ "$INSTANCE_READY" = "1" ] && break
  sleep 1
done
[ "$INSTANCE_READY" = "1" ] || bad "Node B Integration instance is not READY for orphan scenario"

rm -f "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled"
for node in node-a node-b; do
  node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
  [ -n "$node_pid" ] || continue
  for worker_pid in $(pgrep -P "$node_pid" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
done
sleep 3
touch "$ROOT/data-ci/node-b/worker-enabled"
sleep 2
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: orphan-$(date +%s%N)" --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":4,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
echo "orphan job: $JOB"
for _ in $(seq 1 120); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
  [ "$STATUS" = "RUNNING" ] && [ "$EFFECTS" -ge 1 ] && break
  sleep 0.2
done
[ "$STATUS" = "RUNNING" ] && [ "$EFFECTS" -ge 1 ] || bad "Node B did not produce the first effect"
NODE_B_PID="$(cat /tmp/node-b.pid)"
OLD_WORKER_PID="$(pgrep -P "$NODE_B_PID" -f opsweave-pipeline-worker | head -1 || true)"
OLD_LEASE="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_FENCE="$(psql "$DB" -qAt -c "SELECT current_fence FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_BOOT="$(psql "$DB" -qAt -c "SELECT boot_id FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
OLD_PPID="$(ps -o ppid= -p "$OLD_WORKER_PID" 2>/dev/null | tr -d ' ' || true)"
echo "orphan evidence: nodePid=$NODE_B_PID workerPid=${OLD_WORKER_PID:-none} workerPpid=${OLD_PPID:-none} bootId=${OLD_BOOT:-none} lease=$OLD_LEASE fence=$OLD_FENCE"
rm -f "$ROOT/data-ci/node-b/worker-enabled"
kill -9 "$NODE_B_PID" 2>/dev/null || true
touch "$ROOT/data-ci/node-a/worker-enabled"
START_TS="$(date +%s)"
for _ in $(seq 1 180); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  [ "$STATUS" = "SUCCEEDED" ] && break
  sleep 1
done
TOOK="$(( $(date +%s) - START_TS ))"
[ "$STATUS" = "SUCCEEDED" ] || bad "orphan takeover status=$STATUS"
NEW_FENCE="$(psql "$DB" -qAt -c "SELECT max(fencing_sequence) FROM kernel.pipeline_job_leases WHERE job_id='$JOB';")"
ATTEMPTS="$(psql "$DB" -qAt -c "SELECT attempts FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID' AND source_batch_key LIKE 'job-$JOB-%';")"
EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
[ "$NEW_FENCE" -gt "$OLD_FENCE" ] || bad "fence did not increase"
[ "$ATTEMPTS" = "2" ] || bad "attempts=$ATTEMPTS"
[ "$RECORDS" = "1001" ] || bad "records=$RECORDS"
[ "$EFFECTS" = "3" ] || bad "effects=$EFFECTS"
# The orphan may still be alive, but the old fence cannot commit another effect.
sleep 5
RECORDS2="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID' AND source_batch_key LIKE 'job-$JOB-%';")"
EFFECTS2="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
[ "$RECORDS2" = "$RECORDS" ] || bad "orphan created new records: $RECORDS -> $RECORDS2"
[ "$EFFECTS2" = "$EFFECTS" ] || bad "orphan created new effects: $EFFECTS -> $EFFECTS2"
if [ -n "${OLD_WORKER_PID:-}" ] && kill -0 "$OLD_WORKER_PID" 2>/dev/null; then
  CURRENT_PPID="$(ps -o ppid= -p "$OLD_WORKER_PID" 2>/dev/null | tr -d ' ' || true)"
  ok "orphan worker survived node SIGKILL (pid=$OLD_WORKER_PID ppid=$CURRENT_PPID) but produced no new effects"
else
  ok "orphan worker exited after node SIGKILL; no new effects"
fi
ok "Orphan Worker Golden Path: job=$JOB oldFence=$OLD_FENCE newFence=$NEW_FENCE takeover=${TOOK}s records=$RECORDS effects=$EFFECTS"
rm -f "$ROOT/data-ci/node-a/worker-enabled"
NODE_A_PID="$(cat /tmp/node-a.pid)"
for worker_pid in $(pgrep -P "$NODE_A_PID" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
NEW_B_PID="$(tests/runtime/start_node.sh node-b 9102)"
echo "restarted Node B pid=$NEW_B_PID"
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:9102/healthz >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:9102/healthz >/dev/null
NODE_B_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-b/node-identity.json"))["nodeId"])')"
for _ in $(seq 1 120); do
  READY="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/nodes" | python3 -c 'import json,sys;d=json.load(sys.stdin);nid=sys.argv[1];print(next((1 for n in d if n["id"]==nid and n.get("status")=="READY" and not n.get("stale")),0))' "$NODE_B_ID")"
  [ "$READY" = "1" ] && break
  sleep 1
done
[ "$READY" = "1" ] || bad "restarted Node B did not become READY"
for _ in $(seq 1 120); do
  INSTANCE_READY="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/plugins/opsweave.data-integration" | python3 -c 'import json,sys;d=json.load(sys.stdin);nid=sys.argv[1];print(next((1 for dep in d.get("deployments",[]) for i in dep["instances"] if i["nodeId"]==nid and i["state"]=="READY"),0))' "$NODE_B_ID")"
  [ "$INSTANCE_READY" = "1" ] && break
  sleep 1
done
[ "$INSTANCE_READY" = "1" ] || bad "restarted Node B Integration instance is not READY"
echo "Orphan Worker Golden Path: PASS"
