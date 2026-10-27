#!/usr/bin/env bash
# Real multi-provider / Grant-binding acceptance through Kernel + Node + Gateway.
# Requires the standard Data Foundation deployment plus a signed alternate
# Catalog bundle at dist/plugins/data-catalog-alt-0.0.1.plugin.zip.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
A="opsweave.data-catalog"
B="opsweave.data-catalo"
CAP="$URL/api/v1/capabilities/data.catalog.v1/1"

current_token() {
  local cid token
  cid="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')"
  [ -n "$cid" ] || bad "data-integration container not found"
  # Node Runtime restarts can adopt the container before its workload token file
  # is refreshed. Wait for the Catalog token instead of assuming immediate state.
  for _ in $(seq 1 60); do
    token="$(docker exec "$cid" cat /run/opsweave/capability-tokens.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data.catalog.v1",""))' 2>/dev/null || true)"
    [ -n "$token" ] && { printf '%s' "$token"; return 0; }
    sleep 1
  done
  bad "data-integration workload token file has no data.catalog.v1"
}

invoke_datasets() {
  local token="$1" out="$2"
  curl -sS -o "$out" -w '%{http_code}' -X GET -H "Authorization: Bearer $token" "$CAP/api/data-catalog/datasets"
}

echo "== prepare alternate signed provider"
./target/debug/opsctl --url "$URL" install dist/plugins/data-catalog-alt-0.0.1.plugin.zip >/dev/null
./target/debug/opsctl --url "$URL" deploy "$B" 0.0.1 --replicas 1 --selector zone=node-b --wait >/dev/null
# Do not activate yet: create a Grant bound to the currently selected A.
RESOLVE_A="$(curl -fsS "${AUTH[@]}" "$CAP/resolve")"
SELECTED_A="$(printf '%s' "$RESOLVE_A" | json "d['providerPluginId']")"
[ "$SELECTED_A" = "$A" ] || bad "expected A selected before alternate activation, got $SELECTED_A"
GRANT="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' "$URL/api/v1/capability-grants" \
  -d '{"name":"data.catalog.v1","major":1,"consumerPluginId":"opsweave.data-integration","providerPluginId":"'"$A"'","scope":["dataset:read","dataset:write"]}')"
GRANT_ID="$(printf '%s' "$GRANT" | json "d['id']")"
[ "$(printf '%s' "$GRANT" | json "d['providerPluginId']")" = "$A" ] || bad "grant is not bound to A"
TOKEN_A="$(current_token)"
CODE_A="$(invoke_datasets "$TOKEN_A" /tmp/multi-a.json)"
[ "$CODE_A" = "200" ] || bad "bound-A invocation returned $CODE_A"
ok "Grant bound to A reached A"

echo "== activate B; selected provider changes to B"
./target/debug/opsctl --url "$URL" activate "$B" 0.0.1 >/dev/null
RESOLVE_B="$(curl -fsS "${AUTH[@]}" "$CAP/resolve")"
SELECTED_B="$(printf '%s' "$RESOLVE_B" | json "d['providerPluginId']")"
[ "$SELECTED_B" = "$B" ] || bad "expected B selected after alternate activation, got $SELECTED_B"
TOKEN_CURRENT="$(current_token)"
MISMATCH_CODE="$(invoke_datasets "$TOKEN_CURRENT" /tmp/multi-mismatch.json)"
[ "$MISMATCH_CODE" = "403" ] || bad "bound-A invocation after natural switch returned $MISMATCH_CODE"
grep -q 'CAPABILITY_PROVIDER_MISMATCH' /tmp/multi-mismatch.json || bad "provider mismatch error code missing"
printf '%s' "$(curl -fsS "${AUTH[@]}" "$URL/api/v1/audit?limit=100")" | grep -q 'provider mismatch' || bad "provider mismatch audit missing"
ok "bound Grant rejected natural selection of B and audited"

echo "== unbounded grant follows current selected provider"
UNBOUND="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' "$URL/api/v1/capability-grants" \
  -d '{"name":"data.catalog.v1","major":1,"consumerPluginId":"opsweave.data-integration","scope":["dataset:read","dataset:write"]}')"
UNBOUND_ID="$(printf '%s' "$UNBOUND" | json "d['id']")"
TOKEN_CURRENT="$(current_token)"
CODE_B="$(invoke_datasets "$TOKEN_CURRENT" /tmp/multi-b.json)"
[ "$CODE_B" = "200" ] || bad "unbounded invocation to B returned $CODE_B"
ok "unbounded Grant followed selected provider B"

echo "== revoke and restore"
curl -fsS "${AUTH[@]}" -X DELETE "$URL/api/v1/capability-grants/$UNBOUND_ID" >/dev/null
TOKEN_CURRENT="$(current_token)"
REVOKE_CODE="$(invoke_datasets "$TOKEN_CURRENT" /tmp/multi-revoked.json)"
[ "$REVOKE_CODE" = "403" ] || bad "revoked Grant returned $REVOKE_CODE"
grep -q 'CAPABILITY_FORBIDDEN' /tmp/multi-revoked.json || bad "revoked Grant did not return CAPABILITY_FORBIDDEN"
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' "$URL/api/v1/capability-grants" \
  -d '{"name":"data.catalog.v1","major":1,"consumerPluginId":"opsweave.data-integration","scope":["dataset:read","dataset:write"]}' >/dev/null
TOKEN_CURRENT="$(current_token)"
RESTORED_CODE="$(invoke_datasets "$TOKEN_CURRENT" /tmp/multi-restored.json)"
[ "$RESTORED_CODE" = "200" ] || bad "restored Grant returned $RESTORED_CODE"
ok "Grant revoke and restore are immediate"

echo "== no-provider capability fails closed at resolution"
NO_PROVIDER="$(curl -sS -o /tmp/multi-no-provider.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/capabilities/data.catalog.v2/1/resolve")"
[ "$NO_PROVIDER" = "503" ] || bad "no-provider resolve returned $NO_PROVIDER"
grep -q 'CAPABILITY_UNAVAILABLE' /tmp/multi-no-provider.json || bad "no-provider error code missing"
ok "no-provider resolution fails closed"

# Restore the normal unbounded Grant for subsequent tests.
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' "$URL/api/v1/capability-grants" \
  -d '{"name":"data.catalog.v1","major":1,"consumerPluginId":"opsweave.data-integration","scope":["dataset:read","dataset:write"]}' >/dev/null
echo "Multi Provider Golden Path: PASS"
