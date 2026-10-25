#!/usr/bin/env bash
# Real PostgreSQL authority races for Deadline vs Catalog fenced sink.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
bad() { echo "FAIL  $*"; exit 1; }
source tests/acceptance/pipeline_worker_auth.sh
claim_job() {
  local timeout="$1" key="$2" job lease fence
  job="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: deadline-race-$key-$(date +%s%N)" --data-binary "{\"pipelineId\":\"host-metrics-pipeline\",\"pipelineRevision\":1,\"input\":{},\"maxAttempts\":1,\"timeoutSeconds\":$timeout}" "$URL/api/v1/jobs" | json "d['jobId']")"
  load_worker node-a
  local claim
  claim="$(curl -fsS "${W_HEADERS[@]}" -X POST -H 'content-type: application/json' --data-binary "$W_BODY" "$URL/internal/v1/pipeline-jobs/$job/claim")"
  lease="$(printf '%s' "$claim" | json "d['leaseId']")"
  fence="$(printf '%s' "$claim" | json "d['fencingSequence']")"
  echo "$job $lease $fence"
}
# Case B: B waits for the Job row lock until after deadline; authorization must
# re-check clock_timestamp() after acquiring the lock.
read -r JOB_B LEASE_B FENCE_B <<< "$(claim_job 3 case-b)"
echo "Case B job=$JOB_B lease=$LEASE_B fence=$FENCE_B deadline=$(psql "$DB" -qAt -c "SELECT deadline_at FROM kernel.pipeline_jobs WHERE job_id='$JOB_B';")"
psql "$DB" -qAt >/tmp/deadline-holder.log 2>&1 <<SQL &
BEGIN;
SELECT 1 FROM kernel.pipeline_jobs WHERE job_id='$JOB_B' FOR UPDATE;
SELECT pg_sleep(5);
COMMIT;
SQL
HOLDER=$!
sleep 0.5
START="$(date -u +%FT%TZ)"
RESULT_B="$(psql "$DB" -qAt -F '|' -c "SELECT authorized, reason FROM kernel.fence_authorize_effect('$JOB_B','$LEASE_B',$FENCE_B,'sink','$DATASET_ID',1);")"
END="$(date -u +%FT%TZ)"
wait "$HOLDER"
echo "Case B start=$START lock_wait=obtained after deadline end=$END result=$RESULT_B"
[ "$RESULT_B" = "f|JOB_DEADLINE_EXCEEDED" ] || bad "Case B authorization=$RESULT_B expected f|JOB_DEADLINE_EXCEEDED"
B_RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE source_batch_key LIKE 'job-$JOB_B-%';")"
B_EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB_B';")"
[ "$B_RECORDS" = "0" ] || bad "Case B records=$B_RECORDS"
[ "$B_EFFECTS" = "0" ] || bad "Case B effects=$B_EFFECTS"
# Case A: authorization completed before deadline, transaction remains open
# across the deadline. This is allowed by the documented linearization contract.
read -r JOB_A LEASE_A FENCE_A <<< "$(claim_job 3 case-a)"
echo "Case A job=$JOB_A lease=$LEASE_A fence=$FENCE_A deadline=$(psql "$DB" -qAt -c "SELECT deadline_at FROM kernel.pipeline_jobs WHERE job_id='$JOB_A';")"
RESULT_A="$(psql "$DB" -qAt -F '|' <<SQL
BEGIN;
SELECT authorized, reason FROM kernel.fence_authorize_effect('$JOB_A','$LEASE_A',$FENCE_A,'sink','$DATASET_ID',1);
SELECT pg_sleep(4);
COMMIT;
SQL
)"
A_DECISION="$(printf '%s\n' "$RESULT_A" | head -1)"
A_COMMIT="$(printf '%s\n' "$RESULT_A" | tail -1)"
echo "Case A decision=$A_DECISION commit_after_deadline=$A_COMMIT"
[ "$A_DECISION" = "t|OK" ] || bad "Case A authorization=$A_DECISION expected t|OK"
A_RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE source_batch_key LIKE 'job-$JOB_A-%';")"
A_EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB_A';")"
A_RESULTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_results WHERE job_id='$JOB_A';")"
[ "$A_RECORDS" = "0" ] || bad "Case A records=$A_RECORDS"
[ "$A_EFFECTS" = "0" ] || bad "Case A effects=$A_EFFECTS"
[ "$A_RESULTS" -le 1 ] || bad "Case A results=$A_RESULTS"
echo "PASS Deadline vs Sink Case A/B (no unauthorized Catalog write; documented linearization)"
echo "Deadline Sink Race: PASS"
