#!/usr/bin/env bash
# Real Node-credential worker executes the bounded pipeline and fenced Catalog sink.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
source tests/acceptance/pipeline_worker_auth.sh
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PIPELINE_JSON="$(cat contracts/examples/pipeline-definition.json)"
PIPELINE_ID="$(printf '%s' "$PIPELINE_JSON" | json "d['pipelineId']")"
REVISION="$(printf '%s' "$PIPELINE_JSON" | json "d['revision']")"
DATASET_BODY='{"datasetId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"worker-hosts","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}]}'
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d "$DATASET_BODY" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets" >/tmp/worker-dataset.json || true
# Pipeline fixture pins dataset aaaa...; create is idempotent for same revision/digest.
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$PIPELINE_JSON" "$URL/api/v1/pipelines" >/tmp/worker-pipeline.json
# Revision is immutable and already published by JobStore test; this is a no-op/idempotent publish.
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$PIPELINE_JSON" "$URL/api/v1/pipelines/$PIPELINE_ID/revisions" >/tmp/worker-pipeline-publish.json || true
# R1: revision same revision/different digest must be rejected.
ALTERED="$(python3 - "$PIPELINE_JSON" <<'PY'
import json,sys,hashlib
d=json.loads(sys.argv[1]); d['name']='Altered Pipeline'
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
copy=dict(d); copy.pop('digest',None)
d['digest']='sha256:'+hashlib.sha256(canonical(copy)).hexdigest()
print(json.dumps(d))
PY
)"
IMM_CODE="$(curl -sS -o /tmp/worker-immutable.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$ALTERED" "$URL/api/v1/pipelines")"
[ "$IMM_CODE" = "409" ] || bad "immutable revision returned $IMM_CODE"
grep -q 'PIPELINE_REVISION_IMMUTABLE' /tmp/worker-immutable.json || bad "immutable revision error missing"
ok "same revision/different digest rejected"
BASELINE_RECORDS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=100" | json "len(d['items'])")"
[ -n "$BASELINE_RECORDS" ] || bad "could not read baseline record count"

submit_job() {
  local key="$1"
  curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: $key" \
    --data-binary "{\"pipelineId\":\"$PIPELINE_ID\",\"pipelineRevision\":$REVISION,\"input\":{\"source\":\"http://169.254.169.254/latest/meta-data\"},\"maxAttempts\":4,\"timeoutSeconds\":300}" \
    "$URL/api/v1/jobs" | json "d['jobId']"
}

run_worker() {
  local node="$1" job="$2" crash_mode="${3:-}"
  load_worker "$node"
  env \
    OPSWEAVE_WORKER_KERNEL_URL="$URL" \
    OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/$node/node-identity.json" \
    OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID" \
    OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN" \
    OPSWEAVE_WORKER_JOB_ID="$job" \
    OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
    ${crash_mode:+OPSWEAVE_WORKER_${crash_mode}=1} \
    ./target/debug/opsweave-pipeline-worker
}

expire_lease() {
  local job="$1"
  local lease
  lease="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$job';")"
  [ -n "$lease" ] || bad "job $job has no current lease"
  psql "$DB" -qAt -c "UPDATE kernel.pipeline_job_leases SET expires_at=now()-interval '1 second' WHERE lease_id='$lease';" >/dev/null
}

# Non-admin cannot claim through the internal worker API.
ADMIN_CLAIM_CODE="$(curl -sS -o /tmp/worker-admin-claim.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary '{"workerId":"x","nodeId":"33333333-3333-4333-8333-333333333333","instanceId":"44444444-4444-4444-8444-444444444444","bootId":"55555555-5555-4555-8555-555555555555"}' "$URL/internal/v1/pipeline-jobs/00000000-0000-4000-8000-000000000000/claim")"
[ "$ADMIN_CLAIM_CODE" = "401" ] || bad "admin session claimed through worker API ($ADMIN_CLAIM_CODE)"
ok "admin session cannot impersonate a worker"

# Normal single-worker pipeline.
JOB_1="$(submit_job worker-e2e-normal)"
run_worker node-b "$JOB_1"
STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$JOB_1" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "normal job status=$STATUS"
RECORDS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=100" | json "len(d['items'])")"
[ "$RECORDS" = "$((BASELINE_RECORDS + 2))" ] || bad "expected baseline+2 dataset records, got $RECORDS"
CP_COUNT="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_checkpoints WHERE job_id='$JOB_1';")"
[ "$CP_COUNT" -ge 1 ] || bad "no checkpoint persisted"
ok "single worker executed Source→Parse→Map→Filter→Validate→Sink and completed"

# Crash before sink; B takes over with a higher fence.
JOB_2="$(submit_job worker-e2e-crash-before)"
set +e
run_worker node-b "$JOB_2" CRASH_BEFORE_SINK >/tmp/worker-crash-before.log 2>&1
CRASH_CODE=$?
set -e
[ "$CRASH_CODE" = "17" ] || bad "crash-before worker exit=$CRASH_CODE"
expire_lease "$JOB_2"
run_worker node-b "$JOB_2"
STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$JOB_2" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "crash-before takeover status=$STATUS"
FENCES="$(psql "$DB" -qAt -c "SELECT string_agg(fencing_sequence::text, ',' ORDER BY fencing_sequence) FROM kernel.pipeline_job_leases WHERE job_id='$JOB_2';")"
[ "$FENCES" = "1,2" ] || bad "takeover fences were $FENCES, expected 1,2"
ok "worker crash before sink recovered by second worker with higher fence"

# Crash after sink commit; B sees the stable effect receipt and does not duplicate.
JOB_3="$(submit_job worker-e2e-crash-after)"
set +e
run_worker node-b "$JOB_3" CRASH_AFTER_SINK >/tmp/worker-crash-after.log 2>&1
CRASH_CODE=$?
set -e
[ "$CRASH_CODE" = "18" ] || bad "crash-after worker exit=$CRASH_CODE"
expire_lease "$JOB_3"
run_worker node-b "$JOB_3"
STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$JOB_3" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "crash-after takeover status=$STATUS"
RECORDS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=100" | json "len(d['items'])")"
[ "$RECORDS" = "$((BASELINE_RECORDS + 6))" ] || bad "cross-attempt recovery duplicated records: $RECORDS"
ok "committed effect recovered by receipt without duplicate sink write"
echo "Pipeline Worker Golden Path: PASS"
