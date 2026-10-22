#!/usr/bin/env bash
# 0.0.2 Data Foundation Golden Path. Requires a running Kernel with
# opsweave.data-catalog + opsweave.data-integration active and a fixture HTTP
# endpoint reachable by Integration.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
FIXTURE="${OPSWEAVE_DATA_FIXTURE:-http://127.0.0.1:18090/hosts.json}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
api() { curl -fsS "${AUTH[@]}" "$@"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

echo "== create dataset"
DATASET_JSON="$(api -X POST -H 'content-type: application/json' -H 'Idempotency-Key: data-dataset-0001' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets" \
  -d '{"name":"acceptance-hosts","description":"0.0.2 golden path","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1},{"name":"cpu_percent","type":"number","nullable":true,"ordinal":2},{"name":"observed_at","type":"timestamp","nullable":true,"ordinal":3}],"retentionPolicy":{"mode":"RETAIN","maxRecords":10000,"maxBytes":16777216}}')"
DATASET_ID="$(printf '%s' "$DATASET_JSON" | json "d['datasetId']")"
[ -n "$DATASET_ID" ] || bad "dataset creation returned no id"
ok "dataset $DATASET_ID"

echo "== create source"
SOURCE_JSON="$(api -X POST -H 'content-type: application/json' -H 'Idempotency-Key: data-source-0001' \
  "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/sources" \
  -d "{\"name\":\"acceptance-http\",\"connectorType\":\"http-json\",\"endpoint\":\"$FIXTURE\",\"credential\":{\"credentialRef\":\"secret://local/http-json/acceptance\",\"kind\":\"none\",\"maskedHint\":\"local\"}}")"
SOURCE_ID="$(printf '%s' "$SOURCE_JSON" | json "d['sourceId']")"
[ -n "$SOURCE_ID" ] || bad "source creation returned no id"
ok "source $SOURCE_ID"

echo "== connection / discovery / read-only preview"
api -X POST "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/sources/$SOURCE_ID/test" >/dev/null && ok "connection test"
DISCOVERY="$(api -X POST "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/sources/$SOURCE_ID/discover")"
FIELDS="$(printf '%s' "$DISCOVERY" | json "len(d['fields'])")"
[ "$FIELDS" -ge 3 ] || bad "discovery returned too few fields"
BEFORE="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=100" | json "len(d['items'])")"
PREVIEW="$(api -X POST -H 'content-type: application/json' -H 'Idempotency-Key: data-preview-0001' \
  "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/sources/$SOURCE_ID/preview" -d '{"path":"/","limit":5}')"
READ_ONLY="$(printf '%s' "$PREVIEW" | json "d['readOnly']")"
[ "$READ_ONLY" = "True" ] || bad "preview is not marked readOnly"
AFTER="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records?limit=100" | json "len(d['items'])")"
[ "$BEFORE" = "$AFTER" ] || bad "preview wrote records ($BEFORE -> $AFTER)"
ok "preview did not write records"

echo "== publish ingestion spec"
SPEC_JSON="$(api -X POST -H 'content-type: application/json' -H 'Idempotency-Key: data-spec-0001' \
  "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/sources/$SOURCE_ID/ingestion-specs" \
  -d "{\"sourceRevision\":1,\"schemaRevision\":1,\"targetDatasetId\":\"$DATASET_ID\",\"mappings\":[{\"sourcePath\":\"id\",\"targetField\":\"id\",\"required\":true,\"errorPolicy\":\"REJECT_RECORD\"},{\"sourcePath\":\"name\",\"targetField\":\"name\",\"required\":false,\"errorPolicy\":\"SET_NULL\"},{\"sourcePath\":\"observed_at\",\"targetField\":\"observed_at\",\"required\":false,\"errorPolicy\":\"SET_NULL\",\"castTo\":\"timestamp\"}]}")"
SPEC_ID="$(printf '%s' "$SPEC_JSON" | json "d['specId']")"
ok "spec $SPEC_ID"

echo "== run and idempotent replay"
RUN1="$(api -X POST -H 'Idempotency-Key: data-run-stable-0001' \
  "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/ingestion-specs/$SPEC_ID/runs")"
RUN2="$(api -X POST -H 'Idempotency-Key: data-run-stable-0001' \
  "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/ingestion-specs/$SPEC_ID/runs")"
RUN_ID="$(printf '%s' "$RUN1" | json "d['runId']")"
RUN_ID_2="$(printf '%s' "$RUN2" | json "d['runId']")"
[ "$RUN_ID" = "$RUN_ID_2" ] || bad "duplicate idempotency key created a new run"
STATUS="$(printf '%s' "$RUN1" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "run status is $STATUS"
ACCEPTED="$(printf '%s' "$RUN1" | json "d['accepted']")"
[ "$ACCEPTED" -gt 0 ] || bad "run accepted zero records"
ok "run $RUN_ID status=$STATUS accepted=$ACCEPTED"

echo "== lineage and dependency protection"
LINEAGE="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/lineage")"
printf '%s' "$LINEAGE" | grep -q "$RUN_ID" || bad "batch lineage missing run id"
ok "batch lineage"
DISABLE_CODE="$(curl -sS -o /tmp/data-disable.json -w '%{http_code}' "${AUTH[@]}" -X POST "$URL/api/v1/plugins/opsweave.data-catalog/disable" -H 'content-type: application/json' -H 'Idempotency-Key: data-disable-0001' -d '{"reason":"golden path dependency check"}')"
[ "$DISABLE_CODE" = "409" ] || bad "catalog disable returned $DISABLE_CODE, expected 409 DEPENDENCY_BLOCKED"
grep -q 'DEPENDENCY_BLOCKED' /tmp/data-disable.json || bad "catalog disable did not return DEPENDENCY_BLOCKED"
ok "catalog disable blocked by integration dependency"

echo "Data Foundation Golden Path: PASS"
