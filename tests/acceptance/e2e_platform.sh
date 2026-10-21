#!/usr/bin/env bash
# End-to-end acceptance for the local 0.0.1 platform.
# Prerequisite: scripts/demo_up.sh (or an equivalent Kernel + 2 Nodes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
KERNEL_URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}"
OPSCTL="$ROOT/target/debug/opsctl"
PASS=0
FAIL=0

section() { printf '\n== %s\n' "$1"; }
ok() { printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
check() { if "$@"; then ok "$*"; else bad "$*"; fi; }

login() { "$OPSCTL" --url "$KERNEL_URL" login --email "$1" --password "$2" >/dev/null; }
token() { python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])'; }
gateway() { curl -fsS -m 15 --retry 3 --retry-delay 1 --retry-all-errors -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/gateway/$1$2"; }
gateway_code() { curl -sS -o /tmp/opsweave-gw-body -w '%{http_code}' -m 15 -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/gateway/$1$2"; }

section "authentication and health"
login "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
STATUS="$("$OPSCTL" --url "$KERNEL_URL" status)"
printf '%s\n' "$STATUS"
echo "$STATUS" | grep -q 'health=' && ok "overview status endpoint" || bad "overview status endpoint"
check test "$(curl -sS "$KERNEL_URL/livez" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')" = "live"
check test "$(curl -sS "$KERNEL_URL/readyz" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')" = "ready"

section "signed bundle admission"
"$OPSCTL" --url "$KERNEL_URL" install dist/plugins/hello-ops-0.0.1.plugin.zip >/dev/null && ok "signed v1 bundle staged" || bad "signed v1 bundle staged"
"$OPSCTL" --url "$KERNEL_URL" install dist/plugins/hello-ops-0.0.2.plugin.zip >/dev/null && ok "signed v2 bundle staged" || bad "signed v2 bundle staged"
python3 - <<'PY'
import zipfile,json
src='dist/plugins/hello-ops-0.0.1.plugin.zip'; dst='/tmp/opsweave-tampered.plugin.zip'
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data=zin.read(item.filename)
        if item.filename=='manifest.json':
            m=json.loads(data); m['backend']['imageRef']=m['backend']['imageRef'].split('@')[0]+'@sha256:'+'deadbeef'*8
            data=json.dumps(m,sort_keys=True,separators=(',',':')).encode()
        zout.writestr(item,data)
PY
CSRF="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["csrf"])')"
CODE="$(curl -sS -o /tmp/opsweave-bad-body -w '%{http_code}' -H "Authorization: Bearer $(token)" -H "x-csrf-token: $CSRF" -H 'idempotency-key: acceptance-tamper-0001' -H 'content-type: application/octet-stream' --data-binary @/tmp/opsweave-tampered.plugin.zip "$KERNEL_URL/api/v1/plugins/packages")"
[ "$CODE" = "400" ] && ok "tampered imageRef is rejected (400)" || bad "tampered imageRef rejection (got $CODE)"
grep -q 'SIGNATURE_OR_BUNDLE_INVALID' /tmp/opsweave-bad-body && ok "rejection error code is explicit" || bad "rejection error code"

section "two-replica deployment and activation"
"$OPSCTL" --url "$KERNEL_URL" deploy dev.opsweave.hello 0.0.1 --replicas 2 --selector role=node --wait >/dev/null 2>&1 || true
"$OPSCTL" --url "$KERNEL_URL" activate dev.opsweave.hello 0.0.1 >/dev/null 2>&1 || true
BODY="$(gateway dev.opsweave.hello /api/hello)"
echo "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["pluginId"]=="dev.opsweave.hello" and d["version"]=="0.0.1"; print("gateway instance", d["instanceId"])'
INSTANCE_A="$(echo "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["instanceId"])')"
ok "gateway serves v1 from $INSTANCE_A"
INSTANCES="$(curl -fsS -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/plugins/dev.opsweave.hello" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(i["id"] for i in d["deployments"][0]["instances"] if i["state"]=="READY"))')"
COUNT="$(echo "$INSTANCES" | wc -w | tr -d ' ')"
[ "$COUNT" = "2" ] && ok "two READY instances observed" || bad "expected 2 READY instances, got $COUNT"

section "live logs and RBAC"
IID="$(echo "$INSTANCES" | awk '{print $1}')"
SSE="$(curl -sS -N -m 4 -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/instances/$IID/logs/live" 2>/dev/null || true)"
echo "$SSE" | grep -q 'event: status' && ok "log SSE connects" || bad "log SSE connects"
echo "$SSE" | grep -q 'event: log' && ok "log SSE returns a bounded log event" || bad "log SSE returns a log event"
CODE="$(curl -sS -o /tmp/opsweave-log-bad -w '%{http_code}' -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/instances/$IID/logs/live?cursor=bad-cursor")"
[ "$CODE" = "400" ] && ok "forged cursor is rejected" || bad "forged cursor rejection (got $CODE)"

section "viewer RBAC"
CSRF="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["csrf"])')"
curl -sS -o /dev/null -H "Authorization: Bearer $(token)" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -X POST "$KERNEL_URL/api/v1/users" -d '{"email":"viewer@opsweave.local","displayName":"Read Only","password":"ViewerPass!2026","role":"viewer"}' || true
if login viewer@opsweave.local 'ViewerPass!2026'; then
  VTOKEN="$(token)"
  VCODE="$(curl -sS -o /tmp/opsweave-viewer-log -w '%{http_code}' -H "Authorization: Bearer $VTOKEN" "$KERNEL_URL/api/v1/instances/$IID/logs/live")"
  [ "$VCODE" = "403" ] && ok "viewer is denied log access (403)" || bad "viewer log denial (got $VCODE)"
  VDIAG="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $VTOKEN" "$KERNEL_URL/api/v1/diagnostics")"
  [ "$VDIAG" = "403" ] && ok "viewer is denied bootstrap diagnostics (403)" || bad "viewer diagnostics denial (got $VDIAG)"
fi
login "$ADMIN_EMAIL" "$ADMIN_PASSWORD"

section "multi-language Runtime v1"
for plugin in dev.opsweave.hello-go dev.opsweave.hello-java; do
  "$OPSCTL" --url "$KERNEL_URL" deploy "$plugin" 0.0.1 --replicas 1 --selector role=node --wait >/dev/null 2>&1 || true
  "$OPSCTL" --url "$KERNEL_URL" activate "$plugin" 0.0.1 >/dev/null 2>&1 || true
  BODY="$(gateway "$plugin" /api/hello)"
  echo "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("pluginId"), d; print(d["runtime"]["language"])' >/dev/null && ok "$plugin serves Runtime v1" || bad "$plugin serves Runtime v1"
done

section "upgrade and rollback"
"$OPSCTL" --url "$KERNEL_URL" deploy dev.opsweave.hello 0.0.2 --replicas 2 --selector role=node --wait >/dev/null 2>&1 || true
"$OPSCTL" --url "$KERNEL_URL" activate dev.opsweave.hello 0.0.2 >/dev/null 2>&1 || true
BODY="$(gateway dev.opsweave.hello /api/hello)"
echo "$BODY" | grep -q '0.0.2' && ok "upgrade routes to v2" || bad "upgrade routes to v2"
"$OPSCTL" --url "$KERNEL_URL" rollback dev.opsweave.hello 0.0.1 --expected-revision 2 --replicas 2 >/dev/null
"$OPSCTL" --url "$KERNEL_URL" deploy dev.opsweave.hello 0.0.1 --replicas 2 --selector role=node --wait
"$OPSCTL" --url "$KERNEL_URL" activate dev.opsweave.hello 0.0.1
BODY="$(gateway dev.opsweave.hello /api/hello)"
echo "$BODY" | grep -q '0.0.1' && ok "rollback routes to v1" || bad "rollback routes to v1"

section "disable fails closed"
"$OPSCTL" --url "$KERNEL_URL" disable dev.opsweave.hello-java --reason 'acceptance disable test' >/dev/null
CODE="$(gateway_code dev.opsweave.hello-java /api/hello)"
[ "$CODE" = "503" ] && ok "disabled plugin returns CAPABILITY_UNAVAILABLE (503)" || bad "disabled plugin expected 503, got $CODE"
grep -q CAPABILITY_UNAVAILABLE /tmp/opsweave-gw-body && ok "capability failure is explicit" || bad "capability failure code"
"$OPSCTL" --url "$KERNEL_URL" enable dev.opsweave.hello-java >/dev/null
"$OPSCTL" --url "$KERNEL_URL" deploy dev.opsweave.hello-java 0.0.1 --replicas 1 --selector role=node --wait
"$OPSCTL" --url "$KERNEL_URL" activate dev.opsweave.hello-java 0.0.1
gateway dev.opsweave.hello-java /api/hello >/dev/null && ok "re-enabled Java plugin serves again" || bad "re-enabled Java plugin"

section "summary"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
