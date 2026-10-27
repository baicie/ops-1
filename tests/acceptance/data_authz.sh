#!/usr/bin/env bash
# Server-side authorization regression for the data plugins. This script uses
# the real Kernel Gateway and real plugin processes, not direct plugin calls.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
FIXTURE="${OPSWEAVE_DATA_FIXTURE:-http://127.0.0.1:18090/hosts.json}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
ADMIN=(-H "Authorization: Bearer $TOKEN")
CAT="$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog"
INT="$URL/api/v1/gateway/opsweave.data-integration/api/data-integration"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

create_user() {
  local email="$1" role="$2" code
  code="$(curl -sS -o /tmp/data-authz-user.json -w '%{http_code}' "${ADMIN[@]}" -X POST \
    -H 'content-type: application/json' "$URL/api/v1/users" \
    -d "{\"email\":\"$email\",\"displayName\":\"$role User\",\"password\":\"AuthzPass!2026\",\"role\":\"$role\"}")"
  case "$code" in 200|201|409) ;; *) bad "create $role user returned $code: $(cat /tmp/data-authz-user.json)";; esac
}

login_cookie() {
  local email="$1" jar="$2" body
  body="$(curl -sS -c "$jar" -H 'content-type: application/json' "$URL/api/v1/auth/login" \
    -d "{\"email\":\"$email\",\"password\":\"AuthzPass!2026\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

cookie_status() {
  local jar="$1" csrf="$2" method="$3" path="$4" output="$5" body="${6:-}"
  if [ -n "$body" ]; then
    curl -sS -o "$output" -w '%{http_code}' -b "$jar" -H "x-csrf-token: $csrf" \
      -X "$method" -H 'content-type: application/json' "$path" -d "$body"
  else
    curl -sS -o "$output" -w '%{http_code}' -b "$jar" -H "x-csrf-token: $csrf" -X "$method" "$path"
  fi
}

create_user viewer@opsweave.local viewer
create_user operator@opsweave.local operator
VIEWER_JAR=/tmp/data-viewer.cookies
OPERATOR_JAR=/tmp/data-operator.cookies
VIEWER_CSRF="$(login_cookie viewer@opsweave.local "$VIEWER_JAR")"
OPERATOR_CSRF="$(login_cookie operator@opsweave.local "$OPERATOR_JAR")"
[ -n "$VIEWER_CSRF" ] && [ -n "$OPERATOR_CSRF" ] || bad "role login returned no CSRF token"

echo "== Viewer is read-only at the backend"
DATASET_BODY='{"name":"authz-admin-dataset","description":"authorization fixture","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0}],"retentionPolicy":{"mode":"RETAIN","maxRecords":100,"maxBytes":1048576}}'
ADMIN_DATASET="$(curl -fsS "${ADMIN[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: authz-admin-dataset-0001' "$CAT/datasets" -d "$DATASET_BODY")"
ADMIN_DATASET_ID="$(printf '%s' "$ADMIN_DATASET" | json "d['datasetId']")"
[ -n "$ADMIN_DATASET_ID" ] || bad "admin dataset creation failed"

VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" GET "$CAT/datasets" /tmp/authz-viewer-get.json)"
[ "$VIEW_CODE" = "200" ] || bad "viewer dataset read returned $VIEW_CODE, expected 200"

VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" POST "$CAT/datasets" /tmp/authz-viewer-dataset.json "$DATASET_BODY")"
[ "$VIEW_CODE" = "403" ] || bad "viewer dataset create returned $VIEW_CODE, expected 403"
grep -q 'FORBIDDEN' /tmp/authz-viewer-dataset.json || bad "viewer dataset create did not return FORBIDDEN"

DRAFT_BODY='{"baseRevision":1,"fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}]}'
curl -fsS "${ADMIN[@]}" -X POST -H 'content-type: application/json' "$CAT/datasets/$ADMIN_DATASET_ID/schemas/drafts" -d "$DRAFT_BODY" >/dev/null
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" POST "$CAT/datasets/$ADMIN_DATASET_ID/schemas/2/publish" /tmp/authz-viewer-publish.json)"
[ "$VIEW_CODE" = "403" ] || bad "viewer schema publish returned $VIEW_CODE, expected 403"

ADMIN_RULE="$(curl -fsS "${ADMIN[@]}" -X POST -H 'content-type: application/json' "$CAT/datasets/$ADMIN_DATASET_ID/quality-rules" -d '{"ruleType":"RECORD_COUNT","config":{"min":0,"max":100},"severity":"LOW","schemaRevision":1}')"
ADMIN_RULE_ID="$(printf '%s' "$ADMIN_RULE" | json "d['ruleId']")"
[ -n "$ADMIN_RULE_ID" ] || bad "admin quality rule creation failed"
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" GET "$CAT/datasets/$ADMIN_DATASET_ID/quality-rules" /tmp/authz-viewer-rules.json)"
[ "$VIEW_CODE" = "200" ] || bad "viewer quality rule read returned $VIEW_CODE, expected 200"
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" POST "$CAT/datasets/$ADMIN_DATASET_ID/quality-rules" /tmp/authz-viewer-rule-write.json '{"ruleType":"RECORD_COUNT","config":{"min":0,"max":10},"schemaRevision":1}')"
[ "$VIEW_CODE" = "403" ] || bad "viewer quality rule write returned $VIEW_CODE, expected 403"
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" POST "$CAT/datasets/$ADMIN_DATASET_ID/quality-runs" /tmp/authz-viewer-quality-run.json '{"schemaRevision":1}')"
[ "$VIEW_CODE" = "403" ] || bad "viewer quality run returned $VIEW_CODE, expected 403"

SOURCE_BODY="{\"name\":\"authz-admin-source\",\"connectorType\":\"http-json\",\"endpoint\":\"$FIXTURE\",\"credential\":{\"credentialRef\":\"secret://local/http-json/authz\",\"kind\":\"none\",\"maskedHint\":\"local\"}}"
ADMIN_SOURCE="$(curl -fsS "${ADMIN[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: authz-admin-source-0001' "$INT/sources" -d "$SOURCE_BODY")"
ADMIN_SOURCE_ID="$(printf '%s' "$ADMIN_SOURCE" | json "d['sourceId']")"
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" POST "$INT/sources" /tmp/authz-viewer-source.json "$SOURCE_BODY")"
[ "$VIEW_CODE" = "403" ] || bad "viewer source create returned $VIEW_CODE, expected 403"

SPEC_BODY="{\"sourceRevision\":1,\"schemaRevision\":1,\"targetDatasetId\":\"$ADMIN_DATASET_ID\",\"mappings\":[{\"sourcePath\":\"id\",\"targetField\":\"id\",\"required\":true,\"errorPolicy\":\"REJECT_RECORD\"}]}"
ADMIN_SPEC="$(curl -fsS "${ADMIN[@]}" -X POST -H 'content-type: application/json' -H 'Idempotency-Key: authz-admin-spec-0001' "$INT/sources/$ADMIN_SOURCE_ID/ingestion-specs" -d "$SPEC_BODY")"
ADMIN_SPEC_ID="$(printf '%s' "$ADMIN_SPEC" | json "d['specId']")"
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" POST "$INT/ingestion-specs/$ADMIN_SPEC_ID/runs" /tmp/authz-viewer-run.json '')"
# cookie_status does not send Idempotency-Key; auth must be checked before this validation.
[ "$VIEW_CODE" = "403" ] || bad "viewer ingestion run returned $VIEW_CODE, expected 403"
ok "Viewer write endpoints rejected"

NODE_ID="$(curl -fsS "${ADMIN[@]}" "$URL/api/v1/nodes" | json "d[0]['id']")"
[ -n "$NODE_ID" ] || bad "no node available for history authz"
VIEW_CODE="$(cookie_status "$VIEWER_JAR" "$VIEWER_CSRF" GET "$URL/api/v1/nodes/$NODE_ID/resource-history?limit=5" /tmp/authz-viewer-node-history.json)"
[ "$VIEW_CODE" = "200" ] || bad "viewer node history returned $VIEW_CODE, expected 200"
ANON_CODE="$(curl -sS -o /tmp/authz-anon-node-history.json -w '%{http_code}' "$URL/api/v1/nodes/$NODE_ID/resource-history?limit=5")"
[ "$ANON_CODE" = "401" ] || bad "anonymous node history returned $ANON_CODE, expected 401"
ok "Node history authorization matrix"

echo "== Operator legal write path still works"
OP_DATASET_BODY='{"name":"authz-operator-dataset","description":"operator fixture","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0}],"retentionPolicy":{"mode":"RETAIN","maxRecords":100,"maxBytes":1048576}}'
OP_CODE="$(cookie_status "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "$CAT/datasets" /tmp/authz-operator-dataset.json "$OP_DATASET_BODY")"
[ "$OP_CODE" = "201" ] || bad "operator dataset create returned $OP_CODE, expected 201"
OP_DATASET_ID="$(json "d['datasetId']" < /tmp/authz-operator-dataset.json)"
OP_SOURCE_CODE="$(curl -sS -o /tmp/authz-operator-source.json -w '%{http_code}' -b "$OPERATOR_JAR" -H "x-csrf-token: $OPERATOR_CSRF" -H 'content-type: application/json' -X POST "$INT/sources" -d '{"name":"authz-operator-source","connectorType":"http-json","endpoint":"'"$FIXTURE"'","credential":{"credentialRef":"secret://local/http-json/authz-operator","kind":"none","maskedHint":"local"}}')"
[ "$OP_SOURCE_CODE" = "201" ] || bad "operator source create returned $OP_SOURCE_CODE: $(cat /tmp/authz-operator-source.json)"
OP_SOURCE_ID="$(json "d['sourceId']" < /tmp/authz-operator-source.json)"
OP_SPEC_CODE="$(curl -sS -o /tmp/authz-operator-spec.json -w '%{http_code}' -b "$OPERATOR_JAR" -H "x-csrf-token: $OPERATOR_CSRF" -H 'content-type: application/json' -X POST "$INT/sources/$OP_SOURCE_ID/ingestion-specs" -d "{\"sourceRevision\":1,\"schemaRevision\":1,\"targetDatasetId\":\"$OP_DATASET_ID\",\"mappings\":[{\"sourcePath\":\"id\",\"targetField\":\"id\",\"required\":true,\"errorPolicy\":\"REJECT_RECORD\"}]}")"
[ "$OP_SPEC_CODE" = "201" ] || bad "operator spec create returned $OP_SPEC_CODE: $(cat /tmp/authz-operator-spec.json)"
OP_SPEC_ID="$(json "d['specId']" < /tmp/authz-operator-spec.json)"
OP_RUN_CODE="$(curl -sS -o /tmp/authz-operator-run.json -w '%{http_code}' -b "$OPERATOR_JAR" -H "x-csrf-token: $OPERATOR_CSRF" -H 'Idempotency-Key: authz-operator-run-0001' -X POST "$INT/ingestion-specs/$OP_SPEC_ID/runs")"
[ "$OP_RUN_CODE" = "202" ] || bad "operator run returned $OP_RUN_CODE: $(cat /tmp/authz-operator-run.json)"
OP_RUN="$(cat /tmp/authz-operator-run.json)"
OP_STATUS="$(printf '%s' "$OP_RUN" | json "d['status']")"
[ "$OP_STATUS" = "SUCCEEDED" ] || bad "operator ingestion run status is $OP_STATUS"
ok "Operator dataset/source/spec/run succeeded"

echo "Data Authorization Golden Path: PASS"
