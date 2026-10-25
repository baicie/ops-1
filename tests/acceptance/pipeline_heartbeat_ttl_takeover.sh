#!/usr/bin/env bash
# Real Heartbeat fault -> Lease TTL expiry -> natural Node B takeover.
# The proxy affects only the target Worker's Heartbeat; Kernel/Node control stays direct.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROXY_PORT=18182
FLAG=/tmp/heartbeat-fault-job
PROXY_LOG=/tmp/heartbeat-fault-proxy.log
PROXY_PID=""
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  rm -f "$FLAG" "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled"
  # Restore Node B to the normal direct-Kernel path for later gates.
  if [ -f /tmp/node-b.pid ]; then
    kill -TERM "$(cat /tmp/node-b.pid)" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$(cat /tmp/node-b.pid)" 2>/dev/null || break; sleep 0.5; done
    tests/runtime/start_node.sh node-b 9102 >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
bad() { echo "FAIL  $*"; exit 1; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
for node in node-a node-b; do
  node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
  [ -n "$node_pid" ] || continue
  for worker_pid in $(pgrep -P "$node_pid" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
done
rm -f "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled" "$FLAG"
python3 tests/fixtures/heartbeat_fault_proxy.py "$PROXY_PORT" 18181 "$FLAG" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
sleep 1
# Restart Node B with a Worker-only Kernel URL override and a slow pipeline.
kill -TERM "$(cat /tmp/node-b.pid)" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$(cat /tmp/node-b.pid)" 2>/dev/null || break; sleep 0.5; done
NODE_B_PID="$(OPSWEAVE_WORKER_KERNEL_URL="http://127.0.0.1:$PROXY_PORT" OPSWEAVE_WORKER_BATCH_DELAY_MS=12000 tests/runtime/start_node.sh node-b 9102)"
echo "$NODE_B_PID" >/tmp/node-b.pid
for _ in $(seq 1 120); do
  STATE="$(psql "$DB" -qAt -c "SELECT state FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-integration' ORDER BY i.updated_at DESC LIMIT 1;")"
  [ "$STATE" = "READY" ] && break
  sleep 1
done
touch "$ROOT/data-ci/node-b/worker-enabled"
for _ in $(seq 1 60); do WORKER_A="$(pgrep -P "$NODE_B_PID" -f opsweave-pipeline-worker | head -1 || true)"; [ -n "$WORKER_A" ] && break; sleep 0.5; done
[ -n "${WORKER_A:-}" ] || bad "Node B supervisor did not start Worker A"
echo "heartbeat-ttl worker-a pid=$WORKER_A node-b=$NODE_B_PID"
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: hb-ttl-$(date +%s%N)" --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":4,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
echo "heartbeat-ttl job=$JOB"
for _ in $(seq 1 180); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
  [ "$STATUS" = "RUNNING" ] && [ "$EFFECTS" -ge 1 ] && break
  sleep 0.5
done
[ "$STATUS" = "RUNNING" ] || bad "job left RUNNING before fault status=$STATUS effects=$EFFECTS"
[ "$EFFECTS" -ge 1 ] || bad "no committed effect before heartbeat fault"
OLD_LEASE="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_FENCE="$(psql "$DB" -qAt -c "SELECT current_fence FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_BOOT="$(psql "$DB" -qAt -c "SELECT boot_id FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
OLD_INSTANCE="$(psql "$DB" -qAt -c "SELECT instance_id FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
OLD_NODE_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-b/node-identity.json"))["nodeId"])')"
OLD_CRED="$(python3 -c 'import json;print(json.load(open("data-ci/node-b/node-identity.json"))["credential"])')"
OLD_GEN="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/nodes" | python3 -c 'import json,sys;nid=sys.argv[1];print(next(n["generation"] for n in json.load(sys.stdin) if n["id"]==nid))' "$OLD_NODE_ID")"
INJECT_START="$(date +%s)"
printf '%s' "$JOB" > "$FLAG"
rm -f "$ROOT/data-ci/node-b/worker-enabled"
echo "fault armed at $(date -u +%FT%TZ) oldLease=$OLD_LEASE oldFence=$OLD_FENCE effects=$EFFECTS"
# Worker A must cancel from 503s, not be killed by the harness.
for _ in $(seq 1 80); do
  kill -0 "$WORKER_A" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$WORKER_A" 2>/dev/null; then
  bad "Worker A survived Heartbeat 503 beyond retry bound pid=$WORKER_A"
fi
echo "Worker A exited after Heartbeat fault at $(date -u +%FT%TZ)"
INJECT_END="$(date +%s)"
# Wait for the real Lease TTL; never update expires_at.
for _ in $(seq 1 180); do
  ACTIVE="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_leases WHERE job_id='$JOB' AND status='ACTIVE';")"
  [ "$ACTIVE" = "0" ] && break
  sleep 1
done
[ "${ACTIVE:-1}" = "0" ] || bad "Lease did not expire naturally"
touch "$ROOT/data-ci/node-a/worker-enabled"
for _ in $(seq 1 240); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  [ "$STATUS" = "SUCCEEDED" ] && break
  sleep 1
done
NEW_FENCE="$(psql "$DB" -qAt -c "SELECT current_fence FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
ATTEMPTS="$(psql "$DB" -qAt -c "SELECT attempts FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID' AND source_batch_key LIKE 'job-$JOB-%';")"
EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
RESULTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_results WHERE job_id='$JOB';")"
ACTIVE="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_leases WHERE job_id='$JOB' AND status='ACTIVE';")"
[ "$STATUS" = "SUCCEEDED" ] || bad "job not SUCCEEDED after TTL takeover status=$STATUS"
[ "$NEW_FENCE" -gt "$OLD_FENCE" ] || bad "fence did not increase $OLD_FENCE -> $NEW_FENCE"
[ "$ATTEMPTS" = "2" ] || bad "attempts=$ATTEMPTS expected 2"
[ "$RECORDS" = "1001" ] || bad "records=$RECORDS expected 1001"
[ "$EFFECTS" = "3" ] || bad "effects=$EFFECTS expected 3"
[ "$RESULTS" = "1" ] || bad "results=$RESULTS expected 1"
[ "$ACTIVE" = "0" ] || bad "active leases=$ACTIVE expected 0"
# Old authority path after takeover.
OLD_WORKER_ID="n:$OLD_NODE_ID:i:$OLD_INSTANCE:b:$OLD_BOOT"
OLD_HEADERS=(-H "Authorization: Bearer $OLD_CRED" -H "X-OpsWeave-Node-Id: $OLD_NODE_ID" -H "X-OpsWeave-Instance-Id: $OLD_INSTANCE" -H "X-OpsWeave-Node-Generation: $OLD_GEN" -H "X-OpsWeave-Boot-Id: $OLD_BOOT" -H "X-OpsWeave-Worker-Id: $OLD_WORKER_ID" -H 'content-type: application/json')
STALE_HB="$(curl -sS -o /tmp/hb-ttl-stale.json -w '%{http_code}' "${OLD_HEADERS[@]}" -X POST -d "{\"leaseId\":\"$OLD_LEASE\",\"fencingSequence\":$OLD_FENCE}" "$URL/internal/v1/pipeline-jobs/$JOB/heartbeat")"
STALE_RESULT="$(curl -sS -o /tmp/hb-ttl-stale-result.json -w '%{http_code}' "${OLD_HEADERS[@]}" -X POST -d "{\"leaseId\":\"$OLD_LEASE\",\"fencingSequence\":$OLD_FENCE,\"status\":\"FAILED\",\"output\":{},\"errorCode\":\"STALE\"}" "$URL/internal/v1/pipeline-jobs/$JOB/result")"
[ "$STALE_HB" != "200" ] || bad "old heartbeat accepted"
[ "$STALE_RESULT" != "200" ] || bad "old result accepted"
[ "$RESULTS" = "1" ] || bad "stale result duplicated"
echo "timeline: inject_start=$INJECT_START inject_end=$INJECT_END oldFence=$OLD_FENCE newFence=$NEW_FENCE attempts=$ATTEMPTS"
echo "stale: heartbeat=$STALE_HB result=$STALE_RESULT results=$RESULTS records=$RECORDS effects=$EFFECTS activeLeases=$ACTIVE"
grep -c '503' "$PROXY_LOG" 2>/dev/null || true
echo "PASS Heartbeat TTL Takeover: job=$JOB oldFence=$OLD_FENCE newFence=$NEW_FENCE attempts=$ATTEMPTS records=$RECORDS effects=$EFFECTS results=$RESULTS"
echo "Heartbeat TTL Takeover: PASS"
