#!/usr/bin/env bash
# Focused D06 checks that are within the 0.0.2 bounded contract.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
CAT="$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

DATASET="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: reliability-dataset-0001' "$CAT/datasets" -d '{"name":"reliability-dataset","description":"bounded reliability fixture","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}],"retentionPolicy":{"mode":"RETAIN","maxRecords":3,"maxBytes":65536}}')"
DATASET_ID="$(printf '%s' "$DATASET" | json "d['datasetId']")"
MAX_RECORDS="$(printf '%s' "$DATASET" | json "d['retentionPolicy']['maxRecords']")"
[ "$MAX_RECORDS" = "3" ] || bad "retention policy was not returned"
ok "retention policy visible (maxRecords=$MAX_RECORDS; enforcement is documented as bounded)"

WRITE="$(python3 - "$DATASET_ID" <<'PY'
import json,sys
print(json.dumps({'schemaRevision':1,'sourceBatchKey':'reliability-batch-0001','source':{'pluginId':'test','sourceId':'reliability-source','sourceRevision':1},'records':[{'id':'r1','name':'one'}]}))
PY
)"
FIRST="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: reliability-write-0001' "$CAT/datasets/$DATASET_ID/records" -d "$WRITE")"
FIRST_ID="$(printf '%s' "$FIRST" | json "d['receiptId']")"
SECOND="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: reliability-write-0001' "$CAT/datasets/$DATASET_ID/records" -d "$WRITE")"
SECOND_ID="$(printf '%s' "$SECOND" | json "d['receiptId']")"
[ "$FIRST_ID" = "$SECOND_ID" ] || bad "same batch key produced a different receipt"
ok "duplicate batch key returned the original receipt"

CHANGED="$(printf '%s' "$WRITE" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["records"][0]["name"]="changed"; print(json.dumps(d))')"
CHANGED_CODE="$(curl -sS -o /tmp/reliability-changed.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: reliability-write-0002' "$CAT/datasets/$DATASET_ID/records" -d "$CHANGED")"
[ "$CHANGED_CODE" = "409" ] || bad "changed content with same batch key returned $CHANGED_CODE"
grep -q 'IDEMPOTENCY_CONFLICT' /tmp/reliability-changed.json || bad "changed batch did not return IDEMPOTENCY_CONFLICT"
ok "same batch key with changed content rejected"

BAD_SCHEMA="$(printf '%s' "$WRITE" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["schemaRevision"]=999; print(json.dumps(d))')"
SCHEMA_CODE="$(curl -sS -o /tmp/reliability-schema.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: reliability-write-0003' "$CAT/datasets/$DATASET_ID/records" -d "$BAD_SCHEMA")"
[ "$SCHEMA_CODE" = "409" ] || bad "unknown schema revision returned $SCHEMA_CODE"
grep -q 'SCHEMA_REVISION' /tmp/reliability-schema.json || bad "unknown schema error code missing"
ok "unknown schema revision rejected"

RECORDS="$(curl -fsS "${AUTH[@]}" "$CAT/datasets/$DATASET_ID/records?limit=100")"
COUNT="$(printf '%s' "$RECORDS" | json "len(d['items'])")"
[ "$COUNT" = "1" ] || bad "record count after duplicate write is $COUNT, expected 1"
ok "idempotency did not duplicate data"
echo "Data Reliability Golden Path: PASS"
