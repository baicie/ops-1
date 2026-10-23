#!/usr/bin/env bash
# Real dynamic Dataset -> live Schema pin -> Pipeline -> Worker -> fenced records.
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

DATASET_JSON="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: dyn-dataset-$(date +%s%N)" \
  --data-binary '{"name":"dynamic-hosts","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}]}' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets")"
DATASET_ID="$(printf '%s' "$DATASET_JSON" | json "d['datasetId']")"
SCHEMA_REV="$(printf '%s' "$DATASET_JSON" | json "d['schemaRevision']")"
SCHEMA_DIGEST="$(printf '%s' "$DATASET_JSON" | json "d['schemaDigest']")"
[ -n "$DATASET_ID" ] && [ -n "$SCHEMA_DIGEST" ] || bad "dynamic dataset creation failed"
echo "dynamic dataset: $DATASET_ID revision=$SCHEMA_REV digest=$SCHEMA_DIGEST"

PIPELINE_JSON="$(python3 - "$DATASET_ID" "$SCHEMA_REV" <<'PY'
import json,sys
p=json.load(open('contracts/examples/pipeline-definition.json'))
p['pipelineId']='dynamic-hosts-pipeline'
p['name']='dynamic-hosts-pipeline'
p['revision']=1
for n in p['nodes']:
    if n['nodeId']=='sink':
        n['config']={'datasetId':sys.argv[1],'schemaRevision':int(sys.argv[2])}
p['digest']='sha256:'+'0'*64
print(json.dumps(p))
PY
)"
CREATE_CODE="$(curl -sS -o /tmp/dynamic-pipeline.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$PIPELINE_JSON" "$URL/api/v1/pipelines")"
[ "$CREATE_CODE" = "200" ] || [ "$CREATE_CODE" = "201" ] || bad "live pipeline publish returned $CREATE_CODE: $(cat /tmp/dynamic-pipeline.json)"
PINNED_SINK="$(python3 -c 'import json;d=json.load(open("/tmp/dynamic-pipeline.json"))["definition"];print(next(n["config"] for n in d["nodes"] if n["nodeId"]=="sink"))')"
echo "pinned sink: $PINNED_SINK"
python3 - <<PY
import json
sink=json.loads('''$PINNED_SINK''')
assert sink['schemaDigest'].startswith('sha256:'), sink
PY
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: dyn-job-$(date +%s%N)" --data-binary '{"pipelineId":"dynamic-hosts-pipeline","pipelineRevision":1,"input":{},"maxAttempts":4,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
run_worker() {
  local job="$1"
  load_worker node-b
  env OPSWEAVE_WORKER_KERNEL_URL="$URL" OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-b/node-identity.json" \
    OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID" OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN" \
    OPSWEAVE_WORKER_JOB_ID="$job" OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
    ./target/debug/opsweave-pipeline-worker
}
run_worker "$JOB"
STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$JOB" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "dynamic job status=$STATUS"
RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID';")"
[ "$RECORDS" = "2" ] || bad "dynamic dataset record count=$RECORDS"
EFFECT="$(psql "$DB" -qAt -c "SELECT effect_id FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB' LIMIT 1;")"
[ -n "$EFFECT" ] || bad "dynamic effect receipt missing"
ok "dynamic dataset -> live schema pin -> job SUCCEEDED records=$RECORDS effect=$EFFECT"

NEG_CODE="$(curl -sS -o /tmp/dynamic-missing.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$(python3 -c 'import json,sys; d=json.load(open("/tmp/dynamic-pipeline.json"))["definition"]; d["pipelineId"]="missing-dataset-pipeline"; d["revision"]=1; d["digest"]="sha256:"+"0"*64; [n["config"].update({"datasetId":"00000000-0000-4000-8000-000000000099"}) for n in d["nodes"] if n["nodeId"]=="sink"]; print(json.dumps(d))')" "$URL/api/v1/pipelines")"
[ "$NEG_CODE" != "200" ] || bad "missing dataset was accepted"
ok "unknown Catalog dataset rejected ($NEG_CODE)"

DRAFT="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: dyn-draft-$(date +%s%N)" --data-binary '{"baseRevision":1,"fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1},{"name":"region","type":"string","nullable":true,"ordinal":2}]}' "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/schemas/drafts")"
DRAFT_REV="$(printf '%s' "$DRAFT" | json "d['schemaRevision']")"
UND_CODE="$(curl -sS -o /tmp/dynamic-unpublished.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$(python3 -c 'import json,sys; d=json.load(open("/tmp/dynamic-pipeline.json"))["definition"]; d["pipelineId"]="unpublished-schema-pipeline"; d["revision"]=1; d["digest"]="sha256:"+"1"*64; [n["config"].update({"schemaRevision":int(sys.argv[1])}) for n in d["nodes"] if n["nodeId"]=="sink"]; print(json.dumps(d))' "$DRAFT_REV")" "$URL/api/v1/pipelines")"
[ "$UND_CODE" != "200" ] || bad "unpublished schema was accepted"
ok "unpublished schema revision rejected ($UND_CODE)"

MAL_CODE="$(curl -sS -o /tmp/dynamic-malformed.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$(python3 -c 'import json; d=json.load(open("/tmp/dynamic-pipeline.json"))["definition"]; d["pipelineId"]="malformed-dataset-pipeline"; d["revision"]=1; d["digest"]="sha256:"+"2"*64; [n["config"].update({"datasetId":"not-a-uuid"}) for n in d["nodes"] if n["nodeId"]=="sink"]; print(json.dumps(d))')" "$URL/api/v1/pipelines")"
[ "$MAL_CODE" = "400" ] || bad "malformed UUID returned $MAL_CODE"
ok "malformed Dataset UUID rejected (400)"
echo "Dynamic Catalog Pipeline Golden Path: PASS"
