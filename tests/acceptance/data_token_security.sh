#!/usr/bin/env bash
# Token-file mount safety checks against the real OCI containers.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
INTEGRATION="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')"
CATALOG="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-catalog/ {print $1; exit}')"
[ -n "$INTEGRATION" ] || bad "integration container not found"
[ -n "$CATALOG" ] || bad "catalog container not found"
MODE="$(docker exec "$INTEGRATION" stat -c '%a' /run/opsweave/capability-tokens.json)"
[ "$MODE" = "644" ] || bad "token file mode is $MODE, expected 644"
INTEGRATION_TOKENS="$(docker exec "$INTEGRATION" cat /run/opsweave/capability-tokens.json)"
printf '%s' "$INTEGRATION_TOKENS" | grep -q 'oww1' || bad "integration token file has no workload token"
CATALOG_TOKENS="$(docker exec "$CATALOG" cat /run/opsweave/capability-tokens.json)"
printf '%s' "$CATALOG_TOKENS" | grep -q 'oww1' && bad "catalog container received another instance token"
ENV_DUMP="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$INTEGRATION")"
printf '%s' "$ENV_DUMP" | grep -q 'ow_node_' && bad "Node control credential is mounted into the plugin container"
printf '%s' "$ENV_DUMP" | grep -q 'OPSWEAVE_NODE_CREDENTIAL' && bad "Node credential environment is exposed"
ok "token file mode=644; integration tokens present; no cross-instance or Node credential exposure"
# Kernel/API error bodies must not echo the workload token.
NO_TOKEN_BODY="$(curl -sS "$URL/api/v1/nodes" 2>/dev/null || true)"
printf '%s' "$NO_TOKEN_BODY" | grep -q 'oww1' && bad "unauthenticated API response leaked a workload token"
ok "no workload token in unauthenticated API response"
