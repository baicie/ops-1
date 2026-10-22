#!/usr/bin/env bash
# C11-style local experiment: Kernel restart must re-read desired state from PG
# and reconcile against Node observations without losing the active revision.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PORT="${OPSWEAVE_PORT:-18181}"
KERNEL_URL="http://127.0.0.1:${PORT}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}"
OPSCTL="$ROOT/target/debug/opsctl"
token() { python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])'; }
gateway() { curl -fsS -m 15 -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/gateway/dev.opsweave.hello/api/hello"; }

"$OPSCTL" --url "$KERNEL_URL" login --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null
BEFORE="$(gateway | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')"
echo "active version before restart: $BEFORE"
PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)"
kill "$PID"
sleep 2
nohup env \
  OPSWEAVE_BIND="127.0.0.1:${PORT}" \
  OPSWEAVE_PUBLIC_URL="$KERNEL_URL" \
  DATABASE_URL="${DATABASE_URL:-postgres://localhost/opsweave?sslmode=disable}" \
  OPSWEAVE_DATA_DIR="$ROOT/data" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-web/dist" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
  OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$(cat keys/publisher.pub)" \
  OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
  OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1 \
  OPSWEAVE_LOG_FORMAT=json \
  ./target/debug/opsweave-kernel > /tmp/opsweave-kernel.log 2>&1 &
for _ in $(seq 1 40); do curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1 && break; sleep 0.5; done
"$OPSCTL" --url "$KERNEL_URL" login --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null
sleep 8
AFTER="$(gateway | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')"
echo "active version after restart: $AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "active revision changed across kernel restart" >&2; exit 1; }
"$OPSCTL" --url "$KERNEL_URL" doctor | head -8
echo "kernel restart reconciliation test passed"
