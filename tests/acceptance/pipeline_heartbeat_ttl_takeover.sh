#!/usr/bin/env bash
# Real standalone Worker, real Heartbeat 503s, autonomous cancellation,
# natural 60s Lease expiry, and Node B takeover.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROXY_PORT=18182
STATE=/tmp/heartbeat-fault-state
EVENTS=/tmp/heartbeat-fault-events.jsonl
WORKER_LOG=/tmp/heartbeat-ttl-worker-a.log
PROXY_PID=""
WORKER_A=""
cleanup() {
  [ -n "$WORKER_A" ] && kill -9 "$WORKER_A" 2>/dev/null || true
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  rm -f "$STATE" "$EVENTS" "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled"
}
trap cleanup EXIT
bad() { echo "FAIL  $*"; exit 1; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
count_events() {
  python3 - "$EVENTS" "$1" <<'PY'
import json,sys
path, field = sys.argv[1], sys.argv[2]
try:
    events=[json.loads(line) for line in open(path) if line.strip()]
except OSError:
    events=[]
if field == "injected":
    print(sum(1 for e in events if e.get("injected") is True))
elif field == "forwarded_heartbeat":
    print(sum(1 for e in events if e.get("forwarded") and "/heartbeat" in e.get("path","")))
elif field == "proxy_errors":
    print(sum(1 for e in events if e.get("proxy_error")))
elif field == "target_heartbeat":
    print(sum(1 for e in events if "/heartbeat" in e.get("path","") and e.get("job")))
else:
    print(len(events))
PY
}
for node in node-a node-b; do
  node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
  [ -n "$node_pid" ] || continue
  for worker_pid in $(pgrep -P "$node_pid" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
done
rm -f "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled" "$STATE" "$EVENTS" "$WORKER_LOG"
# Negative control: proxy must not be considered healthy before start.
if curl -fsS --max-time 1 "http://127.0.0.1:$PROXY_PORT/__health" >/dev/null 2>&1; then
  bad "stale heartbeat proxy is already listening"
fi
python3 tests/fixtures/heartbeat_fault_proxy.py "$PROXY_PORT" 18181 "$STATE" "$EVENTS" >/tmp/heartbeat-proxy.log 2>&1 &
PROXY_PID=$!
sleep 0.5
curl -fsS --max-time 2 "http://127.0.0.1:$PROXY_PORT/__health" >/dev/null || bad "heartbeat proxy health failed"
NODE_A_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-a/node-identity.json"))["nodeId"])')"
INSTANCE="$(psql "$DB" -qAt -c "SELECT i.id FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-integration' AND i.node_id='$NODE_A_ID' AND i.state='READY' AND i.desired_action='START' LIMIT 1;")"
[ -n "$INSTANCE" ] || bad "Node A has no READY Integration instance"
NODE_GEN="$(psql "$DB" -qAt -c "SELECT generation FROM kernel.nodes WHERE id='$NODE_A_ID';")"
BOOT="$(python3 -c 'import uuid;print(uuid.uuid4())')"
OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-a/node-identity.json" \
OPSWEAVE_WORKER_INSTANCE_ID="$INSTANCE" \
OPSWEAVE_WORKER_NODE_GENERATION="$NODE_GEN" \
OPSWEAVE_WORKER_BOOT_ID="$BOOT" \
OPSWEAVE_WORKER_KERNEL_URL="http://127.0.0.1:$PROXY_PORT" \
OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
OPSWEAVE_WORKER_BATCH_DELAY_MS=12000 \
./target/debug/opsweave-pipeline-worker >"$WORKER_LOG" 2>&1 &
WORKER_A=$!
echo "standalone worker-a pid=$WORKER_A node-a=$NODE_A_ID instance=$INSTANCE boot=$BOOT"
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: hb-ttl-$(date +%s%N)" --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":4,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
echo "heartbeat-ttl job=$JOB"
for _ in $(seq 1 180); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
  [ "$STATUS" = "RUNNING" ] && [ "$EFFECTS" -ge 1 ] && break
  sleep 0.5
done
[ "$STATUS" = "RUNNING" ] || bad "job not RUNNING before fault status=$STATUS effects=$EFFECTS"
[ "$EFFECTS" -ge 1 ] || { echo "FAIL no effect before fault"; tail -60 "$WORKER_LOG"; exit 1; }
OLD_LEASE="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_FENCE="$(psql "$DB" -qAt -c "SELECT current_fence FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_BOOT="$(psql "$DB" -qAt -c "SELECT boot_id FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
OLD_INSTANCE="$(psql "$DB" -qAt -c "SELECT instance_id FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
OLD_CRED="$(python3 -c 'import json;print(json.load(open("data-ci/node-a/node-identity.json"))["credential"])')"
# Negative control: wrong Job ID must not be injected.
printf '%s 503\n' '00000000-0000-4000-8000-000000000000' > "$STATE"
sleep 2
if [ "$(count_events injected)" != "0" ]; then bad "proxy injected for wrong Job ID"; fi
# Arm only the target Job and never remove a Node marker or signal Worker A.
printf '%s 503\n' "$JOB" > "$STATE"
INJECT_START="$(date +%s)"
echo "fault armed at $(date -u +%FT%TZ) oldLease=$OLD_LEASE oldFence=$OLD_FENCE effects=$EFFECTS"
for _ in $(seq 1 120); do
  INJECTED="$(count_events injected)"
  if [ "$INJECTED" -ge 3 ] && ! kill -0 "$WORKER_A" 2>/dev/null; then break; fi
  sleep 0.5
done
for _ in $(seq 1 40); do kill -0 "$WORKER_A" 2>/dev/null || break; sleep 0.5; done
INJECTED="$(count_events injected)"
TARGET="$(count_events target_heartbeat)"
PROXY_ERRORS="$(count_events proxy_errors)"
if kill -0 "$WORKER_A" 2>/dev/null; then bad "Worker A survived Heartbeat 503s"; fi
set +e
wait "$WORKER_A" 2>/dev/null
WORKER_STATUS=$?
set -e
if [ "$INJECTED" -lt 3 ]; then
  echo "injected=$INJECTED target_heartbeat=$TARGET proxy_errors=$PROXY_ERRORS"
  tail -80 "$WORKER_LOG"
  bad "Heartbeat 503 injection count is below 3"
fi
if [ "$PROXY_ERRORS" != "0" ]; then bad "proxy errors=$PROXY_ERRORS"; fi
# Verify the 503s belong to the same Job/Lease/Fence and are from the target route.
python3 - "$EVENTS" "$JOB" "$OLD_FENCE" "$OLD_LEASE" <<'PY'
import json,sys
path,job,fence,lease=sys.argv[1:]
rows=[json.loads(line) for line in open(path) if line.strip()]
hits=[r for r in rows if r.get("injected") and job in r.get("path","")]
if len(hits) < 3: raise SystemExit(f"injected hits={len(hits)}")
gaps=[hits[i+1]["mono"]-hits[i]["mono"] for i in range(len(hits)-1)]
print("heartbeat_503_count", len(hits))
print("heartbeat_503_intervals", " ".join(f"{g:.3f}" for g in gaps))
if any(g < 1.0 or g > 20.0 for g in gaps):
    raise SystemExit(f"retry gaps outside bound: {gaps}")
PY
echo "Worker A autonomous exit status=$WORKER_STATUS after $(count_events injected) injected 503s at $(date -u +%FT%TZ)"
INJECT_END="$(date +%s)"
# Stop the Node-managed worker path permanently before takeover; the standalone
# Worker already proved autonomous cancellation.
rm -f "$ROOT/data-ci/node-a/worker-enabled"
OLD_EXPIRES="$(psql "$DB" -qAt -c "SELECT expires_at FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
for _ in $(seq 1 180); do
  EXPIRED="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE' AND expires_at <= clock_timestamp();")"
  [ "$EXPIRED" = "1" ] && break
  sleep 1
done
[ "${EXPIRED:-0}" = "1" ] || bad "Lease did not reach natural expires_at"
echo "Lease TTL reached at $(date -u +%FT%TZ) expires_at=$OLD_EXPIRES"
touch "$ROOT/data-ci/node-b/worker-enabled"
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
[ "$STATUS" = "SUCCEEDED" ] || bad "job not SUCCEEDED status=$STATUS"
[ "$NEW_FENCE" -gt "$OLD_FENCE" ] || bad "fence did not increase"
[ "$ATTEMPTS" = "2" ] || bad "attempts=$ATTEMPTS expected 2"
[ "$RECORDS" = "1001" ] || bad "records=$RECORDS"
[ "$EFFECTS" = "3" ] || bad "effects=$EFFECTS"
[ "$RESULTS" = "1" ] || bad "results=$RESULTS"
[ "$ACTIVE" = "0" ] || bad "active leases=$ACTIVE"
OLD_WORKER_ID="n:$NODE_A_ID:i:$OLD_INSTANCE:b:$OLD_BOOT"
OLD_HEADERS=(-H "Authorization: Bearer $OLD_CRED" -H "X-OpsWeave-Node-Id: $NODE_A_ID" -H "X-OpsWeave-Instance-Id: $OLD_INSTANCE" -H "X-OpsWeave-Node-Generation: $NODE_GEN" -H "X-OpsWeave-Boot-Id: $OLD_BOOT" -H "X-OpsWeave-Worker-Id: $OLD_WORKER_ID" -H 'content-type: application/json')
STALE_HB="$(curl -sS -o /tmp/hb-ttl-stale.json -w '%{http_code}' "${OLD_HEADERS[@]}" -X POST -d "{\"leaseId\":\"$OLD_LEASE\",\"fencingSequence\":$OLD_FENCE}" "$URL/internal/v1/pipeline-jobs/$JOB/heartbeat")"
STALE_RESULT="$(curl -sS -o /tmp/hb-ttl-stale-result.json -w '%{http_code}' "${OLD_HEADERS[@]}" -X POST -d "{\"leaseId\":\"$OLD_LEASE\",\"fencingSequence\":$OLD_FENCE,\"status\":\"FAILED\",\"output\":{},\"errorCode\":\"STALE\"}" "$URL/internal/v1/pipeline-jobs/$JOB/result")"
[ "$STALE_HB" != "200" ] || bad "old heartbeat accepted"
[ "$STALE_RESULT" != "200" ] || bad "old result accepted"
[ "$RESULTS" = "1" ] || bad "stale result duplicated"
echo "timeline: inject_start=$INJECT_START inject_end=$INJECT_END oldFence=$OLD_FENCE newFence=$NEW_FENCE attempts=$ATTEMPTS"
echo "injection: target_heartbeats=$TARGET injected_503=$INJECTED forwarded=$((TARGET-INJECTED)) proxy_errors=$PROXY_ERRORS"
echo "stale: heartbeat=$STALE_HB result=$STALE_RESULT results=$RESULTS records=$RECORDS effects=$EFFECTS activeLeases=$ACTIVE"
echo "PASS Heartbeat TTL Takeover: job=$JOB oldFence=$OLD_FENCE newFence=$NEW_FENCE attempts=$ATTEMPTS records=$RECORDS effects=$EFFECTS results=$RESULTS"
echo "Heartbeat TTL Takeover: PASS"
