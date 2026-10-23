#!/usr/bin/env bash
# Real PostgreSQL durable JobStore/Lease/Fencing acceptance through Kernel HTTP API.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
PIPELINE_JSON="$(cat contracts/examples/pipeline-definition.json)"
PIPELINE_ID="$(printf '%s' "$PIPELINE_JSON" | json "d['pipelineId']")"
REVISION="$(printf '%s' "$PIPELINE_JSON" | json "d['revision']")"
CREATE_CODE="$(curl -sS -o /tmp/pipeline-create.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$PIPELINE_JSON" "$URL/api/v1/pipelines")"
[ "$CREATE_CODE" = "200" ] || bad "pipeline create returned $CREATE_CODE: $(cat /tmp/pipeline-create.json)"
ok "pipeline published/validated with trusted registry"

JOB_BODY="$(python3 - "$PIPELINE_ID" "$REVISION" <<'PY'
import json,sys
print(json.dumps({'pipelineId':sys.argv[1],'pipelineRevision':int(sys.argv[2]),'input':{'source':'http://172.17.0.1:18090/data-hosts.json'},'maxAttempts':3,'timeoutSeconds':300}))
PY
)"
CODE="$(curl -sS -o /tmp/job-submit.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: pipeline-jobs-e2e-0001' --data-binary "$JOB_BODY" "$URL/api/v1/jobs")"
[ "$CODE" = "201" ] || bad "job submit returned $CODE: $(cat /tmp/job-submit.json)"
JOB_ID="$(json "d['jobId']" < /tmp/job-submit.json)"
STATUS="$(json "d['status']" < /tmp/job-submit.json)"
[ "$STATUS" = "QUEUED" ] || bad "new job status is $STATUS"
ok "job persisted QUEUED (jobId=$JOB_ID)"

DUP_CODE="$(curl -sS -o /tmp/job-submit-dup.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: pipeline-jobs-e2e-0001' --data-binary "$JOB_BODY" "$URL/api/v1/jobs")"
[ "$DUP_CODE" = "200" ] || bad "idempotent submission returned $DUP_CODE"
DUP_ID="$(json "d['jobId']" < /tmp/job-submit-dup.json)"
[ "$DUP_ID" = "$JOB_ID" ] || bad "idempotent submission returned a different job"
CHANGED="$(printf '%s' "$JOB_BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["input"]["source"]="http://example.invalid/changed"; print(json.dumps(d))')"
CONFLICT_CODE="$(curl -sS -o /tmp/job-submit-conflict.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: pipeline-jobs-e2e-0001' --data-binary "$CHANGED" "$URL/api/v1/jobs")"
[ "$CONFLICT_CODE" = "409" ] || bad "changed idempotent submission returned $CONFLICT_CODE"
grep -q 'JOB_IDEMPOTENCY_CONFLICT' /tmp/job-submit-conflict.json || bad "idempotency conflict code missing"
ok "duplicate key/different input rejected"

WORKER_A='{"workerId":"worker-a","nodeId":"33333333-3333-4333-8333-333333333333","instanceId":"44444444-4444-4444-8444-444444444444","bootId":"55555555-5555-4555-8555-555555555555","version":"0.0.3"}'
WORKER_B='{"workerId":"worker-b","nodeId":"66666666-6666-4666-8666-666666666666","instanceId":"77777777-7777-4777-8777-777777777777","bootId":"88888888-8888-4888-8888-888888888888","version":"0.0.3"}'
CLAIM_CODE="$(curl -sS -o /tmp/job-claim-a.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$WORKER_A" "$URL/api/v1/jobs/$JOB_ID/claim")"
[ "$CLAIM_CODE" = "200" ] || bad "worker A claim returned $CLAIM_CODE: $(cat /tmp/job-claim-a.json)"
LEASE_A="$(json "d['leaseId']" < /tmp/job-claim-a.json)"
FENCE_A="$(json "d['fencingSequence']" < /tmp/job-claim-a.json)"
[ "$FENCE_A" = "1" ] || bad "first fence is $FENCE_A"
DUP_CLAIM_CODE="$(curl -sS -o /tmp/job-claim-dup.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$WORKER_B" "$URL/api/v1/jobs/$JOB_ID/claim")"
[ "$DUP_CLAIM_CODE" = "409" ] || bad "duplicate claim returned $DUP_CLAIM_CODE"
grep -q 'JOB_ALREADY_CLAIMED' /tmp/job-claim-dup.json || bad "duplicate claim code missing"
START_CODE="$(curl -sS -o /tmp/job-start.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "{\"leaseId\":\"$LEASE_A\",\"fencingSequence\":$FENCE_A}" "$URL/api/v1/jobs/$JOB_ID/start")"
[ "$START_CODE" = "200" ] || bad "start returned $START_CODE: $(cat /tmp/job-start.json)"
HB_CODE="$(curl -sS -o /tmp/job-heartbeat.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "{\"leaseId\":\"$LEASE_A\",\"fencingSequence\":$FENCE_A}" "$URL/api/v1/jobs/$JOB_ID/heartbeat")"
[ "$HB_CODE" = "200" ] || bad "heartbeat returned $HB_CODE"
CP_CODE="$(curl -sS -o /tmp/job-checkpoint.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "{\"leaseId\":\"$LEASE_A\",\"fencingSequence\":$FENCE_A,\"sequence\":1,\"inputCursor\":\"batch:1\",\"stateDigest\":\"sha256:$(printf 'a%.0s' {1..64})\",\"state\":{}}" "$URL/api/v1/jobs/$JOB_ID/checkpoint")"
[ "$CP_CODE" = "200" ] || bad "checkpoint returned $CP_CODE: $(cat /tmp/job-checkpoint.json)"
ok "claim/start/heartbeat/checkpoint passed"

# Forcibly expire A's lease in PostgreSQL, then let B take over with a higher fence.
psql "$DB" -qAt -c "UPDATE kernel.pipeline_job_leases SET expires_at=now()-interval '1 second' WHERE lease_id='$LEASE_A';" >/dev/null
CLAIM_B_CODE="$(curl -sS -o /tmp/job-claim-b.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$WORKER_B" "$URL/api/v1/jobs/$JOB_ID/claim")"
[ "$CLAIM_B_CODE" = "200" ] || bad "takeover claim returned $CLAIM_B_CODE: $(cat /tmp/job-claim-b.json)"
LEASE_B="$(json "d['leaseId']" < /tmp/job-claim-b.json)"
FENCE_B="$(json "d['fencingSequence']" < /tmp/job-claim-b.json)"
[ "$FENCE_B" -gt "$FENCE_A" ] || bad "takeover fence $FENCE_B is not greater than $FENCE_A"
STALE_CODE="$(curl -sS -o /tmp/job-stale-result.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "{\"leaseId\":\"$LEASE_A\",\"fencingSequence\":$FENCE_A,\"status\":\"SUCCEEDED\",\"output\":{}}" "$URL/api/v1/jobs/$JOB_ID/result")"
[ "$STALE_CODE" = "409" ] || bad "stale worker result returned $STALE_CODE"
grep -q 'STALE_FENCE' /tmp/job-stale-result.json || bad "stale fence code missing"
STALE_CP_CODE="$(curl -sS -o /tmp/job-stale-cp.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "{\"leaseId\":\"$LEASE_A\",\"fencingSequence\":$FENCE_A,\"sequence\":2,\"stateDigest\":\"sha256:$(printf 'b%.0s' {1..64})\",\"state\":{}}" "$URL/api/v1/jobs/$JOB_ID/checkpoint")"
[ "$STALE_CP_CODE" = "409" ] || bad "stale worker checkpoint returned $STALE_CP_CODE"
ok "lease expiry/takeover and old-fence rejection passed"

RESULT_CODE="$(curl -sS -o /tmp/job-result-b.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "{\"leaseId\":\"$LEASE_B\",\"fencingSequence\":$FENCE_B,\"status\":\"SUCCEEDED\",\"output\":{\"accepted\":1},\"resultDigest\":\"sha256:$(printf 'c%.0s' {1..64})\"}" "$URL/api/v1/jobs/$JOB_ID/result")"
[ "$RESULT_CODE" = "200" ] || bad "new worker result returned $RESULT_CODE: $(cat /tmp/job-result-b.json)"
FINAL="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$JOB_ID")"
[ "$(json "d['status']" <<< "$FINAL")" = "SUCCEEDED" ] || bad "job is not SUCCEEDED: $FINAL"
COUNT="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_results WHERE job_id='$JOB_ID';")"
[ "$COUNT" = "1" ] || bad "expected exactly one result, got $COUNT"
ok "fenced result persisted exactly once"
echo "Pipeline JobStore Golden Path: PASS"
