#!/usr/bin/env bash
# Real Runtime integration test: revoke a live Node and prove its managed
# containers are stopped, not merely marked UNREACHABLE in the Kernel.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
./target/debug/opsctl --url "$URL" login --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >/dev/null
SESSION="$HOME/.opsweave/session.json"
TOKEN="$(python3 -c 'import json;print(json.load(open("'"$SESSION"'"))["token"])')"
CSRF="$(python3 -c 'import json;print(json.load(open("'"$SESSION"'"))["csrf"])')"
NODE_ID="$(psql -d "${OPSWEAVE_DB_NAME:-opsweave}" -Atc "select id from kernel.nodes where name='node-a' and revoked_at is null order by enrolled_at desc limit 1")"
[ -n "$NODE_ID" ] || { echo "node-a is not enrolled" >&2; exit 1; }
BEFORE="$(docker ps -q --filter "label=opsweave.node-id=$NODE_ID" | wc -l | tr -d ' ')"
[ "$BEFORE" -ge 1 ] || { echo "node-a has no running managed container to test" >&2; exit 1; }
echo "node-a has $BEFORE managed container(s); revoking $NODE_ID"
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" "$URL/api/v1/nodes/$NODE_ID" >/dev/null
for _ in $(seq 1 30); do
  AFTER="$(docker ps -q --filter "label=opsweave.node-id=$NODE_ID" | wc -l | tr -d ' ')"
  [ "$AFTER" = "0" ] && break
  sleep 1
done
[ "$AFTER" = "0" ] || { echo "revoked node left $AFTER workload container(s) running" >&2; docker ps -a --filter "label=opsweave.node-id=$NODE_ID" --format '{{.Names}} {{.Status}}' >&2; exit 1; }
grep -q 'entering quarantine' /tmp/opsweave-node-a.log || { echo "node-a did not log quarantine transition" >&2; tail -20 /tmp/opsweave-node-a.log >&2; exit 1; }
echo "node quarantine test passed: $BEFORE container(s) were removed after revocation"
