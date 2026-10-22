#!/usr/bin/env bash
# Historical/DB-tampered dataEndpoint must also be rejected by the SSE path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_DB_NAME:-opsweave}"
./target/debug/opsctl --url "$URL" login --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >/dev/null
TOKEN="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])')"
ROW="$(psql -d "$DB" -Atc "select i.id,n.id,n.data_endpoint from kernel.plugin_instances i join kernel.nodes n on n.id=i.node_id where i.state='READY' and i.desired_action='START' limit 1")"
IFS='|' read -r INSTANCE_ID NODE_ID ORIGINAL <<< "$ROW"
[ -n "${INSTANCE_ID:-}" ] || { echo "no READY instance found" >&2; exit 1; }
psql -d "$DB" -c "update kernel.nodes set data_endpoint='http://169.254.169.254/latest/meta-data' where id='$NODE_ID'" >/dev/null
CODE="$(curl -sS -o /tmp/endpoint-policy.out -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$URL/api/v1/instances/$INSTANCE_ID/logs/live" || true)"
psql -d "$DB" -c "update kernel.nodes set data_endpoint='$ORIGINAL' where id='$NODE_ID'" >/dev/null
[ "$CODE" = "400" ] || { echo "expected SSE endpoint rejection 400, got $CODE: $(cat /tmp/endpoint-policy.out)" >&2; exit 1; }
grep -q 'NODE_DATA_ENDPOINT' /tmp/endpoint-policy.out || { echo "SSE did not return endpoint policy error" >&2; cat /tmp/endpoint-policy.out >&2; exit 1; }
echo "endpoint policy test passed: SSE rejects a tampered dataEndpoint"
