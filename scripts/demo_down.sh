#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KERNEL_PORT="${OPSWEAVE_PORT:-18181}"
for port in "$KERNEL_PORT" 9101 9102; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
done
docker ps -a --filter label=opsweave.managed=true --format '{{.Names}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
echo "local OpsWeave processes and managed containers stopped"
