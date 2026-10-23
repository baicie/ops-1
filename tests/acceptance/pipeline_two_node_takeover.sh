#!/usr/bin/env bash
# Two independent Node Runtimes on one CI host; natural Lease expiry takeover.
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
rm -f "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled"
# The previous Node-managed test may still have a child in its supervisor kill
# window. Stop both known worker children before submitting this job.
for node in node-a node-b; do
  node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
  if [ -n "$node_pid" ]; then
    for worker_pid in $(pgrep -P "$node_pid" -f opsweave-pipeline-worker || true); do
      kill -9 "$worker_pid" 2>/dev/null || true
    done
  fi
done
sleep 3
python3 - <<'PY'
import json
records=[{"id":f"two-{i:04d}","name":f"two-{i:04d}.example","cpu_percent":float(i%100)} for i in range(1001)]
json.dump(records, open('tests/fixtures/data-hosts-large.json','w'))
PY
PIPELINE="$(python3 - <<'PY'
import json,hashlib
p=json.load(open('contracts/examples/pipeline-definition.json'))
p['pipelineId']='two-node-bulk'; p['name']='two-node-bulk'; p['revision']=1
for n in p['nodes']:
    if n['nodeId']=='source': n['config']['endpoint']='http://172.17.0.1:18090/data-hosts-large.json'
    if n['nodeId']=='sink': n['config']={'datasetId':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','schemaRevision':1}
p['digest']='sha256:'+'0'*64
print(json.dumps(p))
PY
)"
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$PIPELINE" "$URL/api/v1/pipelines" >/dev/null
BASELINE="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
touch "$ROOT/data-ci/node-a/worker-enabled"
sleep 2
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: two-node-$(date +%s%N)" --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":4,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
echo "two-node job: $JOB"
for _ in $(seq 1 120); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
  [ "$STATUS" = "RUNNING" ] && [ "$EFFECTS" -ge 1 ] && break
  sleep 0.2
done
[ "$STATUS" = "RUNNING" ] && [ "$EFFECTS" -ge 1 ] || bad "Node A did not produce the first committed effect"
NODE_A_PID="$(cat /tmp/node-a.pid)"
WORKER_A_PID="$(pgrep -P "$NODE_A_PID" -f opsweave-pipeline-worker | head -1 || true)"
[ -n "$WORKER_A_PID" ] || bad "Node A worker process not found"
rm -f "$ROOT/data-ci/node-a/worker-enabled"
kill -9 "$WORKER_A_PID" 2>/dev/null || true
echo "killed Node A worker pid=$WORKER_A_PID; waiting for natural lease expiry"
OLD_LEASE="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
OLD_FENCE="$(psql "$DB" -qAt -c "SELECT current_fence FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
touch "$ROOT/data-ci/node-b/worker-enabled"
START_TS="$(date +%s)"
for _ in $(seq 1 180); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  [ "$STATUS" = "SUCCEEDED" ] && break
  sleep 1
done
TOOK="$(( $(date +%s) - START_TS ))"
[ "$STATUS" = "SUCCEEDED" ] || bad "two-node takeover status=$STATUS after ${TOOK}s"
NEW_FENCE="$(psql "$DB" -qAt -c "SELECT max(fencing_sequence) FROM kernel.pipeline_job_leases WHERE job_id='$JOB';")"
ATTEMPTS="$(psql "$DB" -qAt -c "SELECT attempts FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
ACTIVE="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_leases WHERE job_id='$JOB' AND status='ACTIVE';")"
[ "$NEW_FENCE" -gt "$OLD_FENCE" ] || bad "fence did not increase: $OLD_FENCE -> $NEW_FENCE"
[ "$ATTEMPTS" = "2" ] || bad "attempts=$ATTEMPTS, expected 2"
[ "$RECORDS" = "$((BASELINE + 1001))" ] || bad "records=$RECORDS expected $((BASELINE + 1001))"
[ "$EFFECTS" = "3" ] || bad "effects=$EFFECTS, expected 3"
[ "$ACTIVE" = "0" ] || bad "terminal job still has active lease"
OLD_STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$OLD_LEASE';")"
[ "$OLD_STATUS" != "ACTIVE" ] || bad "old lease still active"
ok "two independent Node Runtimes: job=$JOB oldFence=$OLD_FENCE newFence=$NEW_FENCE attempts=$ATTEMPTS effects=$EFFECTS takeover=${TOOK}s oldLease=$OLD_STATUS"
echo "Two-Node Takeover Golden Path: PASS"
