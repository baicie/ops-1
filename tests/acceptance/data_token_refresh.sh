#!/usr/bin/env bash
# Proves that a long-running Integration instance refreshes an expired workload
# token instead of relying on a process restart. CI configures a 2 second TTL.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
FIXTURE="${OPSWEAVE_DATA_FIXTURE:-http://127.0.0.1:18090/hosts.json}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
CAT="$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog"
INT="$URL/api/v1/gateway/opsweave.data-integration/api/data-integration"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

DATASET="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: token-refresh-dataset-0001' \
  "$CAT/datasets" -d '{"name":"token-refresh-dataset","description":"token refresh fixture","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0}],"retentionPolicy":{"mode":"RETAIN","maxRecords":100,"maxBytes":1048576}}')"
DATASET_ID="$(printf '%s' "$DATASET" | json "d['datasetId']")"
SOURCE="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: token-refresh-source-0001' \
  "$INT/sources" -d "{\"name\":\"token-refresh-source\",\"connectorType\":\"http-json\",\"endpoint\":\"$FIXTURE\",\"credential\":{\"credentialRef\":\"secret://local/http-json/token-refresh\",\"kind\":\"none\",\"maskedHint\":\"local\"}}")"
SOURCE_ID="$(printf '%s' "$SOURCE" | json "d['sourceId']")"
SPEC="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: token-refresh-spec-0001' \
  "$INT/sources/$SOURCE_ID/ingestion-specs" -d "{\"sourceRevision\":1,\"schemaRevision\":1,\"targetDatasetId\":\"$DATASET_ID\",\"mappings\":[{\"sourcePath\":\"id\",\"targetField\":\"id\",\"required\":true,\"errorPolicy\":\"REJECT_RECORD\"}]}")"
SPEC_ID="$(printf '%s' "$SPEC" | json "d['specId']")"
[ -n "$SPEC_ID" ] || bad "spec creation failed"

# CI configures OPSWEAVE_WORKLOAD_TOKEN_SECONDS=2. Wait beyond that TTL so the
# token injected at container creation is definitely expired.
sleep "${OPSWEAVE_TOKEN_WAIT_SECONDS:-4}"
RUN="$(curl -fsS "${AUTH[@]}" -X POST -H 'Idempotency-Key: token-refresh-run-0001' \
  "$INT/ingestion-specs/$SPEC_ID/runs")"
STATUS="$(printf '%s' "$RUN" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "run after token expiry status=$STATUS: $RUN"
ok "expired workload token refreshed; run status=$STATUS"
echo "Data Token Refresh: PASS"
