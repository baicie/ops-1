#!/usr/bin/env bash
# Preview: bounded pure transform, no Job/Revision/Receipt/Dataset writes.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
PIPE=host-metrics-pipeline
bad() { echo "FAIL  $*"; exit 1; }
json_get() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
DETAIL="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE")"
DEF="$(printf '%s' "$DETAIL" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["latest"]["definition"]))')"
REV_BEFORE="$(printf '%s' "$DETAIL" | json_get 'd["latestRevision"]')"
JOBS_BEFORE="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs?limit=100" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')"
DATASET="$(printf '%s' "$DEF" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(n["config"]["datasetId"] for n in d["nodes"] if n["type"]=="builtin.sink.dataset"))')"
RECORDS_BEFORE="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET/records?limit=100" | json_get 'len(d["items"])')"
SAMPLE='[{"id":"1","name":"alpha","n":2},{"id":"2","name":"beta","n":1}]'
BODY="$(python3 - "$DEF" "$SAMPLE" <<'PY'
import json,sys
print(json.dumps({"definition":json.loads(sys.argv[1]),"sampleInput":json.loads(sys.argv[2]),"maxRecords":10}))
PY
)"
PREVIEW="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d "$BODY" "$URL/api/v1/pipelines/preview")"
printf '%s' "$PREVIEW" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="COMPLETED", d; assert len(d["nodeOutputs"])>=5; assert d["processedRecords"]==2; assert d["errors"]==[]' || bad "valid preview"
REV_AFTER="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | json_get 'd["latestRevision"]')"
JOBS_AFTER="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs?limit=100" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')"
RECORDS_AFTER="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET/records?limit=100" | json_get 'len(d["items"])')"
[ "$REV_BEFORE" = "$REV_AFTER" ] || bad "preview created revision"
[ "$JOBS_BEFORE" = "$JOBS_AFTER" ] || bad "preview created job"
[ "$RECORDS_BEFORE" = "$RECORDS_AFTER" ] || bad "preview wrote dataset records"
LIMIT="$(python3 - "$DEF" <<'PY'
import json,sys
d=json.loads(sys.argv[1]); sample=[{"id":str(i),"name":"x","n":i} for i in range(101)]
print(json.dumps({"definition":d,"sampleInput":sample,"maxRecords":100}))
PY
)"
LIMIT_RESULT="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d "$LIMIT" "$URL/api/v1/pipelines/preview")"
printf '%s' "$LIMIT_RESULT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="INVALID"; assert d["errors"][0]["code"]=="PREVIEW_RECORD_LIMIT"' || bad "record limit"
BAD="$(printf '%s' "$DEF" | python3 -c 'import json,sys; d=json.load(sys.stdin); next(n for n in d["nodes"] if n["type"]=="builtin.map.fields")["config"]["mappings"]={"x":"missing.field"}; print(json.dumps({"definition":d,"sampleInput":[{"id":"1","name":"a"}],"maxRecords":10}))')"
BAD_RESULT="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d "$BAD" "$URL/api/v1/pipelines/preview")"
printf '%s' "$BAD_RESULT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="FAILED"; assert any(e["code"]=="PREVIEW_TRANSFORM_FAILED" for e in d["errors"])' || bad "bad transform"
CODE="$(curl -sS -o /tmp/preview-unauth.json -w '%{http_code}' -X POST -H 'content-type: application/json' -d "$BODY" "$URL/api/v1/pipelines/preview")"
[ "$CODE" = "401" ] || bad "unauth preview=$CODE"
echo "PASS Preview completed transforms, record limit, transform error, no revision/job/records side effect"
echo "Preview: PASS"
