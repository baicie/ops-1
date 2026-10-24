#!/usr/bin/env bash
# A job that runs >70s proves the independent heartbeat task keeps the Lease alive.
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
source tests/acceptance/pipeline_worker_auth.sh
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: long-heartbeat-$(date +%s%N)" --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":2,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
load_worker node-b
env OPSWEAVE_WORKER_KERNEL_URL="$URL" OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-b/node-identity.json" \
  OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID" OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN" \
  OPSWEAVE_WORKER_JOB_ID="$JOB" OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
  OPSWEAVE_WORKER_BATCH_DELAY_MS=30000 \
  ./target/debug/opsweave-pipeline-worker >/tmp/long-heartbeat.log 2>&1 &
WORKER_PID=$!
sleep 75
STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
[ "$STATUS" = "SUCCEEDED" ] && bad "job completed before long-running proof"
LEASE="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
LEASE_STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE';")"
[ "$LEASE_STATUS" = "ACTIVE" ] || bad "lease state after 75s is $LEASE_STATUS"
HEARTBEATS="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE' AND heartbeat_at > acquired_at + interval '20 seconds';")"
[ "$HEARTBEATS" = "1" ] || bad "lease heartbeat was not refreshed"
wait "$WORKER_PID"
STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
[ "$STATUS" = "SUCCEEDED" ] || bad "long job status=$STATUS"
EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID' AND source_batch_key LIKE 'job-$JOB-%';")"
[ "$EFFECTS" = "3" ] || bad "effects=$EFFECTS"
[ "$RECORDS" = "1001" ] || bad "records=$RECORDS"
ok "long-running job kept its Lease via independent heartbeat for >75s (job=$JOB lease=$LEASE records=$RECORDS effects=$EFFECTS)"
echo "Long Heartbeat Golden Path: PASS"
