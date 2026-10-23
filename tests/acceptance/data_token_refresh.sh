#!/usr/bin/env bash
# Proves that a long-running Integration instance refreshes an expired workload
# token instead of relying on a process restart. CI configures a 5 second TTL.
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

# Simulate a short Kernel outage during the idle window. The Node-side token
# refresher must recover when the Kernel returns; no plugin restart is allowed.
if [ -n "${OPSWEAVE_TEST_KERNEL_PID:-}" ]; then
  kill -STOP "$OPSWEAVE_TEST_KERNEL_PID"
  sleep 2
  kill -CONT "$OPSWEAVE_TEST_KERNEL_PID"
  ok "Kernel outage injected and resumed"
fi

# CI configures OPSWEAVE_WORKLOAD_TOKEN_SECONDS=5 and grace=1. Wait beyond that
# window so the token injected at container creation is definitely expired.
sleep "${OPSWEAVE_TOKEN_WAIT_SECONDS:-6}"
RUN="$(curl -fsS "${AUTH[@]}" -X POST -H 'Idempotency-Key: token-refresh-run-0001' \
  "$INT/ingestion-specs/$SPEC_ID/runs")"
STATUS="$(printf '%s' "$RUN" | json "d['status']")"
[ "$STATUS" = "SUCCEEDED" ] || bad "run after token expiry status=$STATUS: $RUN"
ok "expired workload token refreshed; run status=$STATUS"

if [ "${OPSWEAVE_TEST_NODE_REVOCATION:-0}" = "1" ]; then
  echo "== revoke Node and reject old workload identity"
  CONTAINER_ID="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')"
  [ -n "$CONTAINER_ID" ] || bad "data-integration container not found"
  ENV_TOKENS="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_ID" | sed -n 's/^OPSWEAVE_CAPABILITY_TOKENS=//p')"
  [ -n "$ENV_TOKENS" ] || bad "integration capability tokens not found in container env"
  OLD_TOKEN="$(printf '%s' "$ENV_TOKENS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data.catalog.v1"])')"
  # The Node-side refresher mounts a fresh token file into the container. Read
  # the current token rather than the stale env value.
  CURRENT_TOKEN="$(docker exec "$CONTAINER_ID" cat /run/opsweave/capability-tokens.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data.catalog.v1"])')"
  [ -n "$CURRENT_TOKEN" ] || bad "current workload token file is empty"
  FILE_MODE="$(docker exec "$CONTAINER_ID" stat -c '%a' /run/opsweave/capability-tokens.json)"
  [ "$FILE_MODE" = "644" ] || bad "token file mode is $FILE_MODE, expected 644"
  CATALOG_CONTAINER="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-catalog/ {print $1; exit}')"
  [ -n "$CATALOG_CONTAINER" ] || bad "data-catalog container not found"
  CATALOG_TOKENS="$(docker exec "$CATALOG_CONTAINER" cat /run/opsweave/capability-tokens.json)"
  printf '%s' "$CATALOG_TOKENS" | grep -q 'oww1' && bad "Catalog container received another instance's workload token"
  ok "token file mode=644 and no cross-instance token exposure"
  OLD_REFRESH_CODE="$(curl -sS -o /tmp/token-old-refresh.json -w '%{http_code}' -X POST -H "Authorization: Bearer $OLD_TOKEN" "$URL/internal/v1/workload-tokens/refresh")"
  [ "$OLD_REFRESH_CODE" = "401" ] || bad "old env token refresh after TTL+grace returned $OLD_REFRESH_CODE, expected 401"
  FRESH_RESPONSE="$(curl -fsS -X POST -H "Authorization: Bearer $CURRENT_TOKEN" "$URL/internal/v1/workload-tokens/refresh")"
  FRESH_TOKEN="$(printf '%s' "$FRESH_RESPONSE" | json "d['token']")"
  DETAIL="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/plugins/opsweave.data-integration")"
  NODE_ID="$(printf '%s' "$DETAIL" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(i["nodeId"] for dep in d["deployments"] for i in dep["instances"] if i["state"]=="READY"))')"
  [ -n "$NODE_ID" ] || bad "integration instance node not found"
  curl -fsS "${AUTH[@]}" -X DELETE "$URL/api/v1/nodes/$NODE_ID" >/dev/null
  REFRESH_AFTER="$(curl -sS -o /tmp/token-revoked-refresh.json -w '%{http_code}' -X POST -H "Authorization: Bearer $FRESH_TOKEN" "$URL/internal/v1/workload-tokens/refresh")"
  [ "$REFRESH_AFTER" = "403" ] || bad "refresh after node revoke returned $REFRESH_AFTER"
  grep -q 'WORKLOAD_IDENTITY_REVOKED' /tmp/token-revoked-refresh.json || bad "refresh after revoke did not return WORKLOAD_IDENTITY_REVOKED"
  INVOKE_AFTER="$(curl -sS -o /tmp/token-revoked-invoke.json -w '%{http_code}' -X GET -H "Authorization: Bearer $FRESH_TOKEN" "$URL/api/v1/capabilities/data.catalog.v1/1/api/data-catalog/datasets")"
  [ "$INVOKE_AFTER" = "403" ] || bad "invoke after node revoke returned $INVOKE_AFTER"
  grep -q 'WORKLOAD_IDENTITY_REVOKED' /tmp/token-revoked-invoke.json || bad "invoke after revoke did not return WORKLOAD_IDENTITY_REVOKED"
  ok "refresh and old token call rejected after Node revocation"
fi
echo "Data Token Refresh: PASS"
