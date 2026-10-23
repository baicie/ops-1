#!/usr/bin/env bash
# Real Node-revocation rejection for refresh and capability invocation.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

CONTAINER_ID="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')"
[ -n "$CONTAINER_ID" ] || bad "data-integration container not found"
CURRENT_TOKEN="$(docker exec "$CONTAINER_ID" cat /run/opsweave/capability-tokens.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data.catalog.v1"])')"
[ -n "$CURRENT_TOKEN" ] || bad "current workload token file is empty"
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
echo "Data Token Revocation: PASS"
