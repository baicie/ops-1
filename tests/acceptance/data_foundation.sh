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

echo "== schema revision 2 compatibility and immutability"
DRAFT_JSON="$(api -X POST -H 'content-type: application/json' -H 'Idempotency-Key: data-draft-0001' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/schemas/drafts" \
  -d '{"baseRevision":1,"fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1},{"name":"cpu_percent","type":"number","nullable":true,"ordinal":2},{"name":"observed_at","type":"timestamp","nullable":true,"ordinal":3},{"name":"region","type":"string","nullable":true,"ordinal":4}]}')"
REV2="$(printf '%s' "$DRAFT_JSON" | json "d['schemaRevision']")"
[ "$REV2" = "2" ] || bad "expected schema revision 2, got $REV2"
DIFF_JSON="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/schemas/$REV2/diff?against=1")"
COMPATIBLE="$(printf '%s' "$DIFF_JSON" | json "d['compatible']")"
[ "$COMPATIBLE" = "True" ] || bad "compatible schema diff was rejected"
api -X POST "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/schemas/$REV2/publish" >/dev/null
ok "schema revision $REV2 published; old revision 1 remains"

echo "== write a revision-1 record after revision 2 is current"
api -X POST -H 'content-type: application/json' -H 'Idempotency-Key: data-r1-record-0001' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/records" \
  -d '{"schemaRevision":1,"sourceBatchKey":"legacy-revision-one-0001","records":[{"id":"legacy-1","name":"legacy","cpu_percent":1,"observed_at":"2026-10-27T00:00:00Z"}]}' >/dev/null
ok "revision-1 record persisted alongside revision-2 dataset"

echo "== reject incompatible schema change"
BAD_CODE="$(curl -sS -o /tmp/data-bad-schema.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/schemas/drafts" \
  -d '{"baseRevision":2,"fields":[{"name":"id","type":"integer","nullable":false,"ordinal":0}]}')"
[ "$BAD_CODE" = "409" ] || bad "incompatible schema returned $BAD_CODE, expected 409"
grep -q 'SCHEMA_INCOMPATIBLE' /tmp/data-bad-schema.json || bad "incompatible schema error code missing"
ok "incompatible schema rejected"

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
  -d "{\"sourceRevision\":1,\"schemaRevision\":$REV2,\"targetDatasetId\":\"$DATASET_ID\",\"mappings\":[{\"sourcePath\":\"id\",\"targetField\":\"id\",\"required\":true,\"errorPolicy\":\"REJECT_RECORD\"},{\"sourcePath\":\"name\",\"targetField\":\"name\",\"required\":false,\"errorPolicy\":\"SET_NULL\"},{\"sourcePath\":\"observed_at\",\"targetField\":\"observed_at\",\"required\":false,\"errorPolicy\":\"SET_NULL\",\"castTo\":\"timestamp\"}]}")"
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

echo "== quality result"
QUALITY="$(api "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/ingestion-runs/$RUN_ID/quality")"
QUALITY_TOTAL="$(printf '%s' "$QUALITY" | json "d['total']")"
QUALITY_UNKNOWN="$(printf '%s' "$QUALITY" | json "d['unknown']")"
[ "$QUALITY_TOTAL" = "2" ] || bad "quality total is $QUALITY_TOTAL, expected 2"
[ "$QUALITY_UNKNOWN" = "0" ] || bad "quality unknown is $QUALITY_UNKNOWN, expected 0"
ok "quality total=$QUALITY_TOTAL unknown=$QUALITY_UNKNOWN"

echo "== quality rules and persistent run"
QRULE="$(api -X POST -H 'content-type: application/json' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-rules" \
  -d '{"ruleType":"RECORD_COUNT","config":{"min":100,"max":10000},"severity":"HIGH","schemaRevision":2}')"
QRULE_ID="$(printf '%s' "$QRULE" | json "d['ruleId']")"
[ -n "$QRULE_ID" ] || bad "quality rule creation returned no id"
QRUN="$(api -X POST -H 'Idempotency-Key: quality-run-data-foundation-0001' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-runs" \
  -d '{"schemaRevision":2,"idempotencyKey":"quality-run-data-foundation-0001"}')"
QRUN_ID="$(printf '%s' "$QRUN" | json "d['runId']")"
QRUN_ID_2="$(api -X POST -H 'Idempotency-Key: quality-run-data-foundation-0001' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-runs" \
  -d '{"schemaRevision":2,"idempotencyKey":"quality-run-data-foundation-0001"}' | json "d['runId']")"
[ "$QRUN_ID" = "$QRUN_ID_2" ] || bad "quality idempotency created a second run"
for _ in $(seq 1 40); do
  QSTATUS="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-runs/$QRUN_ID" | json "d['status']")"
  case "$QSTATUS" in PASSED|FAILED|ERROR|CANCELLED) break ;; esac
  sleep 0.25
done
[ "$QSTATUS" = "FAILED" ] || bad "quality run expected FAILED, got $QSTATUS"
QDETAIL="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-runs/$QRUN_ID")"
printf '%s' "$QDETAIL" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="FAILED"; assert d["recordsExamined"]==2; assert d["results"] and d["results"][0]["failed"]==1; assert d["ruleSetDigest"].startswith("sha256:")' || bad "quality result shape mismatch"
CANCEL_CODE="$(curl -sS -o /tmp/quality-cancel.json -w '%{http_code}' "${AUTH[@]}" -X POST "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-runs/$QRUN_ID/cancel")"
[ "$CANCEL_CODE" = "409" ] || bad "terminal quality cancel returned $CANCEL_CODE"
ok "quality rule $QRULE_ID run $QRUN_ID FAILED and history/result persisted"

echo "== quality idempotency semantic conflict"
api -X POST -H 'content-type: application/json' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-rules/$QRULE_ID" \
  -d '{"version":1,"ruleType":"RECORD_COUNT","config":{"min":1,"max":2},"severity":"HIGH","enabled":true}' >/dev/null
QCONFLICT="$(curl -sS -o /tmp/quality-idempotency-conflict.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'Idempotency-Key: quality-run-data-foundation-0001' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-runs" \
  -d '{"schemaRevision":2,"idempotencyKey":"quality-run-data-foundation-0001"}')"
[ "$QCONFLICT" = "409" ] || bad "quality semantic idempotency returned $QCONFLICT, expected 409"
grep -q 'IDEMPOTENCY_CONFLICT' /tmp/quality-idempotency-conflict.json || bad "quality idempotency conflict code missing"
ok "quality idempotency key rejects different rule semantics"

echo "== governance summary"
GOV="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/governance-summary")"
printf '%s' "$GOV" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["datasetCount"]>=1; assert set(("passed","failed","error","pending","unknown")) <= set(d["latestQuality"]); assert isinstance(d["recentFailures"],list); assert d["lineageWindow"]=="24h"' || bad "governance summary shape mismatch"
ok "governance summary is server-authoritative"

echo "== node resource history"
NODE_ID="$(api "$URL/api/v1/nodes" | json "d[0]['id']")"
[ -n "$NODE_ID" ] || bad "node history has no enrolled node"
NODE_HISTORY="$(api "$URL/api/v1/nodes/$NODE_ID/resource-history?limit=5")"
printf '%s' "$NODE_HISTORY" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d,list) and d; assert d[0]["nodeId"] and d[0]["sampledAt"] and "generation" in d[0]' || bad "node resource history shape mismatch"
NODE_HOUR="$(api "$URL/api/v1/nodes/$NODE_ID/resource-history?limit=5&resolution=hour")"
printf '%s' "$NODE_HOUR" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d,list); assert all(x.get("resolution")=="hour" and x.get("sampleCount") is not None and x.get("generationChanges") is not None for x in d)' || bad "node hourly aggregation shape mismatch"
BAD_RES="$(curl -sS -o /tmp/node-bad-resolution.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/nodes/$NODE_ID/resource-history?resolution=minute")"
[ "$BAD_RES" = "400" ] || bad "invalid node resolution returned $BAD_RES"
ok "node $NODE_ID resource history persisted; hourly aggregate and invalid resolution checked"

echo "== quality negative validation"
QBAD="$(curl -sS -o /tmp/quality-bad-config.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/quality-rules" \
  -d '{"ruleType":"NULL_RATE","config":{"field":"name","threshold":2}}')"
[ "$QBAD" = "400" ] || bad "invalid quality threshold returned $QBAD"
grep -q 'INVALID_RULE' /tmp/quality-bad-config.json || bad "invalid quality rule error code missing"
ok "invalid quality rule config rejected"

echo "== Catalog capability unavailable fails closed"
GRANT_ID="$(api "$URL/api/v1/capability-grants" | json "next(g['id'] for g in d if g['name']=='data.catalog.v1' and g['state']=='ACTIVE')")"
api -X DELETE "$URL/api/v1/capability-grants/$GRANT_ID" >/dev/null
NO_CAT_CODE="$(curl -sS -o /tmp/data-no-catalog.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'Idempotency-Key: data-no-catalog-0001' \
  "$URL/api/v1/gateway/opsweave.data-integration/api/data-integration/ingestion-specs/$SPEC_ID/runs")"
[ "$NO_CAT_CODE" = "422" ] || bad "missing catalog capability returned $NO_CAT_CODE, expected 422"
grep -q 'CAPABILITY_FORBIDDEN\|CAPABILITY_UNAVAILABLE' /tmp/data-no-catalog.json || bad "missing catalog did not fail with a capability error"
api -X POST -H 'content-type: application/json' "$URL/api/v1/capability-grants" \
  -d '{"name":"data.catalog.v1","major":1,"consumerPluginId":"opsweave.data-integration","scope":["dataset:read","dataset:write"]}' >/dev/null
ok "missing capability failed closed and was restored"

echo "== lineage and dependency protection"
LINEAGE="$(api "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/lineage")"
printf '%s' "$LINEAGE" | grep -q "$RUN_ID" || bad "batch lineage missing run id"
python3 - "$LINEAGE" <<'PY2'
import json, sys
payload = json.loads(sys.argv[1])
items = payload.get("items") if isinstance(payload, dict) else payload
assert items, "lineage response has no items"
assert "nextCursor" in payload, "lineage response missing nextCursor"
for item in items:
    assert item["metadataStatus"] in ("AVAILABLE", "PARTIAL", "NOT_CAPTURED"), item["metadataStatus"]
    assert "pipeline" in item and "job" in item and "receiptId" in item
    if item["pipeline"] is not None:
        assert item["pipeline"]["pipelineId"] and item["pipeline"]["revision"]
    if item["job"] is not None:
        assert item["job"]["jobId"]
PY2
LIMIT_CODE="$(curl -sS -o /tmp/data-lineage-limit.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/lineage?limit=999")"
[ "$LIMIT_CODE" = "400" ] || bad "lineage limit was not rejected: $LIMIT_CODE"
CURSOR_CODE="$(curl -sS -o /tmp/data-lineage-cursor.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/lineage?cursor=%25%25%25")"
[ "$CURSOR_CODE" = "400" ] || bad "invalid cursor was not rejected: $CURSOR_CODE"
grep -q 'INVALID_CURSOR' /tmp/data-lineage-cursor.json || bad "invalid cursor error code missing"
BAD_CURSOR="$(python3 -c 'import base64,json; print(base64.urlsafe_b64encode(json.dumps({"v":1,"occurredAt":"2026-01-01T00:00:00Z","lineageId":"not-a-uuid","filters":"0000000000000000"}).encode()).decode().rstrip("="))')"
CURSOR_UUID_CODE="$(curl -sS -o /tmp/data-lineage-cursor-uuid.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog/datasets/$DATASET_ID/lineage?cursor=$BAD_CURSOR")"
[ "$CURSOR_UUID_CODE" = "400" ] || bad "invalid cursor UUID was not rejected: $CURSOR_UUID_CODE"
ok "batch lineage with job/pipeline/receipt enrichment"
DISABLE_CODE="$(curl -sS -o /tmp/data-disable.json -w '%{http_code}' "${AUTH[@]}" -X POST "$URL/api/v1/plugins/opsweave.data-catalog/disable" -H 'content-type: application/json' -H 'Idempotency-Key: data-disable-0001' -d '{"reason":"golden path dependency check"}')"
[ "$DISABLE_CODE" = "409" ] || bad "catalog disable returned $DISABLE_CODE, expected 409 DEPENDENCY_BLOCKED"
grep -q 'DEPENDENCY_BLOCKED' /tmp/data-disable.json || bad "catalog disable did not return DEPENDENCY_BLOCKED"
ok "catalog disable blocked by integration dependency"

echo "Data Foundation Golden Path: PASS"
