#!/usr/bin/env bash
# Enroll a throwaway node, prove its credential works, revoke it, prove 403.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
./target/debug/opsctl --url "$URL" login --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >/dev/null
TOKEN="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])')"
CSRF="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["csrf"])')"
ENROLL="$(./target/debug/opsctl --url "$URL" node-token --label revocation-test 2>/dev/null)"
PAYLOAD="$(python3 - "$ENROLL" <<'PY'
import json,sys
print(json.dumps({"token":sys.argv[1],"name":"revocation-test-node","os":"linux","arch":"amd64","labels":{},"capabilities":["oci.docker.v1"]}))
PY
)"
RESP="$(curl -fsS -H 'content-type: application/json' -X POST "$URL/api/v1/node-enrollment/redeem" -d "$PAYLOAD")"
NODE_ID="$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["nodeId"])')"
NODE_TOKEN="$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["credential"])')"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BODY="$(python3 - "$NODE_ID" <<'PY'
import json,sys,datetime
print(json.dumps({"generation":1,"observedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),"status":"READY","resourceSnapshot":{"sampledAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),"cpuUtilization":None,"memoryUsedBytes":None,"memoryTotalBytes":None},"instances":[],"dataEndpoint":"http://127.0.0.1:9999","runtimeAdapterVersion":"test","os":"linux","arch":"amd64","labels":{},"capabilities":[]}))
PY
)"
BAD_ENDPOINT_BODY="$(echo "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); d["dataEndpoint"]="http://169.254.169.254/latest/meta-data"; print(json.dumps(d))')"
BAD_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' -X POST "$URL/internal/v1/nodes/$NODE_ID/heartbeat" -d "$BAD_ENDPOINT_BODY")"
[ "$BAD_CODE" = "400" ] || { echo "expected unsafe data endpoint 400, got $BAD_CODE" >&2; exit 1; }
CODE1="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' -X POST "$URL/internal/v1/nodes/$NODE_ID/heartbeat" -d "$BODY")"
[ "$CODE1" = "200" ] || { echo "expected enrolled node heartbeat 200, got $CODE1" >&2; exit 1; }
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" "$URL/api/v1/nodes/$NODE_ID" >/dev/null
CODE2="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NODE_TOKEN" -H 'content-type: application/json' -X POST "$URL/internal/v1/nodes/$NODE_ID/heartbeat" -d "$BODY")"
[ "$CODE2" = "403" ] || { echo "expected revoked node heartbeat 403, got $CODE2" >&2; exit 1; }
echo "node credential revocation test passed (unsafe endpoint 400; heartbeat 200 before revoke, 403 after)"
