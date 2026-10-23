#!/usr/bin/env bash
# Typed plan semantics and multi-batch recovery for the Node-managed worker.
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
python3 - <<'PY'
import json
records=[{"id":f"bulk-{i:04d}","name":f"bulk-{i:04d}.example","cpu_percent":float(i%100),"observed_at":"2026-10-23T00:00:00Z"} for i in range(1001)]
open('tests/fixtures/data-hosts-large.json','w').write(json.dumps(records))
PY
PIPELINE_JSON="$(cat contracts/examples/pipeline-definition.json)"
BASELINE="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=5000" | json "len(d['items'])")"
make_pipeline() {
  python3 - "$PIPELINE_JSON" "$1" "$2" "$3" "$4" <<'PY'
import json,sys,hashlib,copy
base=json.loads(sys.argv[1]); pid,source,mapping,flt=sys.argv[2:]
d=copy.deepcopy(base); d['pipelineId']=pid; d['name']=pid; d['revision']=1
for n in d['nodes']:
 if n['nodeId']=='source': n['config']['endpoint']=source
 if n['nodeId']=='map': n['config']=json.loads(mapping) if mapping else {}
 if n['nodeId']=='filter': n['config']=json.loads(flt) if flt else {}
 if n['nodeId']=='validate': n['config']={'required':['id','name']}
d.pop('digest',None)
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
d['digest']='sha256:'+hashlib.sha256(canonical(d)).hexdigest()
print(json.dumps(d))
PY
}
submit() {
  local pid="$1" key="$2"
  curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: $key" \
    --data-binary "{\"pipelineId\":\"$pid\",\"pipelineRevision\":1,\"input\":{},\"maxAttempts\":4,\"timeoutSeconds\":300}" \
    "$URL/api/v1/jobs" | json "d['jobId']"
}
run_worker() {
  local job="$1" crash="${2:-}"
  load_worker node-b
  env \
    OPSWEAVE_WORKER_KERNEL_URL="$URL" \
    OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-b/node-identity.json" \
    OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID" \
    OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN" \
    OPSWEAVE_WORKER_JOB_ID="$job" \
    OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
    ${crash:+$crash} \
    ./target/debug/opsweave-pipeline-worker
}
expire() {
  local lease
  lease="$(psql "$DB" -qAt -c "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$1';")"
  psql "$DB" -qAt -c "UPDATE kernel.pipeline_job_leases SET expires_at=now()-interval '1 second' WHERE lease_id='$lease';" >/dev/null
}

CUSTOM="$(make_pipeline custom-map-filter http://172.17.0.1:18090/data-hosts.json '{"mappings":{"id":"id","name":"id","cpu_percent":"cpu_percent"}}' '{"field":"cpu_percent","op":"gt","value":50}')"
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$CUSTOM" "$URL/api/v1/pipelines" >/dev/null
CUSTOM_JOB="$(submit custom-map-filter worker-advanced-custom)"
run_worker "$CUSTOM_JOB"
STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$CUSTOM_JOB" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "custom job status=$STATUS"
COUNT="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=5000" | json "len(d['items'])")"
[ "$COUNT" = "$((BASELINE + 1))" ] || bad "custom record count=$COUNT"
curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=5000" >/tmp/advanced-records.json
python3 - <<'PY'
import json
items=json.load(open('/tmp/advanced-records.json'))['items']
assert any(i.get('id')=='host-2' and i.get('name')=='host-2' for i in items), 'custom mapping/filter row missing'
PY
ok "custom map/filter config executed with different output"

BULK="$(make_pipeline custom-batches http://172.17.0.1:18090/data-hosts-large.json '' '')"
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$BULK" "$URL/api/v1/pipelines" >/dev/null
BULK_JOB="$(submit custom-batches worker-advanced-bulk)"
set +e
run_worker "$BULK_JOB" "OPSWEAVE_WORKER_CRASH_AFTER_BATCH=2" >/tmp/advanced-crash.log 2>&1
CODE=$?
set -e
[ "$CODE" = "18" ] || bad "batch crash exit=$CODE"
expire "$BULK_JOB"
run_worker "$BULK_JOB"
STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$BULK_JOB" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "bulk recovery status=$STATUS"
COUNT="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
[ "$COUNT" = "$((BASELINE + 1002))" ] || bad "bulk record count=$COUNT"
EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$BULK_JOB';")"
[ "$EFFECTS" = "3" ] || bad "expected 3 effects, got $EFFECTS"
ok "1001 records split into 3 durable batches; crash after batch 2 recovered without duplicates"
echo "Pipeline Worker Advanced Golden Path: PASS"
