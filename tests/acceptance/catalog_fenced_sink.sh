#!/usr/bin/env bash
# Real Catalog fenced sink + Postgres Job row-lock authority.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
CAT="$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog"

PIPELINE_JSON="$(cat contracts/examples/pipeline-definition.json)"
PIPELINE_ID="$(printf '%s' "$PIPELINE_JSON" | json "d['pipelineId']")"
REVISION="$(printf '%s' "$PIPELINE_JSON" | json "d['revision']")"
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$PIPELINE_JSON" "$URL/api/v1/pipelines" >/tmp/fenced-pipeline.json
DATASET="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: fenced-dataset-0001' -d '{"name":"fenced-hosts","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}]}' "$CAT/datasets")"
DATASET_ID="$(printf '%s' "$DATASET" | json "d['datasetId']")"
[ -n "$DATASET_ID" ] || bad "dataset creation failed"
JOB_BODY="{\"pipelineId\":\"$PIPELINE_ID\",\"pipelineRevision\":$REVISION,\"input\":{\"source\":\"http://172.17.0.1:18090/data-hosts.json\"},\"maxAttempts\":3,\"timeoutSeconds\":300}"
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: fenced-job-0001' --data-binary "$JOB_BODY" "$URL/api/v1/jobs")"
JOB_ID="$(printf '%s' "$JOB" | json "d['jobId']")"
WORKER_A='{"workerId":"fenced-worker-a","nodeId":"33333333-3333-4333-8333-333333333333","instanceId":"44444444-4444-4444-8444-444444444444","bootId":"55555555-5555-4555-8555-555555555555","version":"0.0.3"}'
WORKER_B='{"workerId":"fenced-worker-b","nodeId":"66666666-6666-4666-8666-666666666666","instanceId":"77777777-7777-4777-8777-777777777777","bootId":"88888888-8888-4888-8888-888888888888","version":"0.0.3"}'
CLAIM_A="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$WORKER_A" "$URL/api/v1/jobs/$JOB_ID/claim")"
LEASE_A="$(printf '%s' "$CLAIM_A" | json "d['leaseId']")"
FENCE_A="$(printf '%s' "$CLAIM_A" | json "d['fencingSequence']")"

make_fenced_body() {
  python3 - "$1" "$2" "$3" "$4" "$DATASET_ID" <<'PY'
import json,sys,hashlib
job,lease,fence,effectid,dataset=sys.argv[1:]
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
pipeline_id='host-metrics-pipeline'; pipeline_revision=1; sink_node='sink'; logical_batch='batch-host-metrics-0001'
records=[{'id':'host-1','name':'host-1.example'},{'id':'host-2','name':'host-2.example'}]
payload={'effectId':effectid,'pipelineId':pipeline_id,'pipelineRevision':pipeline_revision,'sinkNodeId':sink_node,'logicalBatchId':logical_batch,'schemaRevision':1,'sourceBatchKey':'fenced-batch-0001-0001','records':records}
digest='sha256:'+hashlib.sha256(canonical(payload)).hexdigest()
print(json.dumps({**payload,'requestDigest':digest,'fence':{'jobId':job,'leaseId':lease,'fencingSequence':int(fence),'pipelineId':pipeline_id,'pipelineRevision':pipeline_revision},'source':{'kind':'test'}}))
PY
}
EFFECT_ID="$(python3 - "$JOB_ID" <<'PY'
import json,hashlib,sys
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
print('efx:'+hashlib.sha256(canonical({'jobId':sys.argv[1],'pipelineId':'host-metrics-pipeline','pipelineRevision':1,'sinkNodeId':'sink','logicalBatchId':'batch-host-metrics-0001'})).hexdigest())
PY
)"
BODY_A="$(make_fenced_body "$JOB_ID" "$LEASE_A" "$FENCE_A" "$EFFECT_ID")"
CODE="$(curl -sS -o /tmp/fenced-write-a.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$BODY_A" "$CAT/datasets/$DATASET_ID/fenced-records")"
[ "$CODE" = "201" ] || bad "fenced write A returned $CODE: $(cat /tmp/fenced-write-a.json)"
ok "old worker fenced write committed with effectId=$EFFECT_ID"
COUNT="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
[ "$COUNT" = "2" ] || bad "expected 2 records after first fenced write, got $COUNT"

# Force a takeover by expiring A's lease.
psql "$DB" -qAt -c "UPDATE kernel.pipeline_job_leases SET expires_at=now()-interval '1 second' WHERE lease_id='$LEASE_A';" >/dev/null
CLAIM_B="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$WORKER_B" "$URL/api/v1/jobs/$JOB_ID/claim")"
LEASE_B="$(printf '%s' "$CLAIM_B" | json "d['leaseId']")"
FENCE_B="$(printf '%s' "$CLAIM_B" | json "d['fencingSequence']")"
[ "$FENCE_B" -gt "$FENCE_A" ] || bad "takeover fence did not increase"

# Same effectId after takeover must return the original receipt and write nothing.
RETRY_BODY="$(make_fenced_body "$JOB_ID" "$LEASE_B" "$FENCE_B" "$EFFECT_ID")"
RETRY_CODE="$(curl -sS -o /tmp/fenced-retry.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$RETRY_BODY" "$CAT/datasets/$DATASET_ID/fenced-records")"
[ "$RETRY_CODE" = "200" ] || bad "cross-attempt effect retry returned $RETRY_CODE: $(cat /tmp/fenced-retry.json)"
COUNT="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
[ "$COUNT" = "2" ] || bad "cross-attempt retry duplicated records (count=$COUNT)"
ok "cross-attempt effectId returned the original receipt without duplicate records"

# A new effect using the old fence must be rejected at the sink boundary.
NEW_EFFECT="$(python3 - "$JOB_ID" <<'PY'
import json,hashlib,sys
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
print('efx:'+hashlib.sha256(canonical({'jobId':sys.argv[1],'pipelineId':'host-metrics-pipeline','pipelineRevision':1,'sinkNodeId':'sink','logicalBatchId':'batch-host-metrics-0002'})).hexdigest())
PY
)"
STALE_BODY="$(make_fenced_body "$JOB_ID" "$LEASE_A" "$FENCE_A" "$NEW_EFFECT")"
STALE_CODE="$(curl -sS -o /tmp/fenced-stale.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$STALE_BODY" "$CAT/datasets/$DATASET_ID/fenced-records")"
[ "$STALE_CODE" = "409" ] || bad "stale fence write returned $STALE_CODE: $(cat /tmp/fenced-stale.json)"
if ! grep -Eq 'STALE_FENCE|LEASE_NOT_ACTIVE' /tmp/fenced-stale.json; then
  echo "stale response: $(cat /tmp/fenced-stale.json)"
  bad "stale fence error code missing"
fi
COUNT="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
[ "$COUNT" = "2" ] || bad "stale fence wrote records (count=$COUNT)"
ok "new claim after old fence rejected the old worker's new sink effect"

# Receipt lookup is the UNKNOWN recovery path.
LOOKUP_CODE="$(curl -sS -o /tmp/fenced-lookup.json -w '%{http_code}' "${AUTH[@]}" "$CAT/datasets/$DATASET_ID/effect-receipts?effectId=$EFFECT_ID")"
[ "$LOOKUP_CODE" = "200" ] || bad "receipt lookup returned $LOOKUP_CODE"
grep -q '"status":"COMMITTED"' /tmp/fenced-lookup.json || bad "receipt is not COMMITTED"
ok "effect receipt lookup supports UNKNOWN recovery"
echo "Catalog Fenced Sink Golden Path: PASS"
