#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/demo_common.sh
. "$ROOT/scripts/demo_common.sh"

KERNEL_PORT="${OPSWEAVE_PORT:-18181}"

# Order matters: stop what this checkout started, then stop its containers.
# Both refuse rather than guess, and a refusal exits non-zero *before* anything
# destructive has happened.
echo "== stop this checkout's processes"
blocked=0
for port in "$KERNEL_PORT" 9101 9102; do
  demo_kill_port "$port" || blocked=1
done

if [ "$blocked" -ne 0 ]; then
  echo "BLOCKED: a process this checkout did not start holds one of the demo ports." >&2
  echo "         Nothing was removed. Resolve the port or set OPSWEAVE_PORT." >&2
  exit 1
fi

echo "== stop this installation's containers"
demo_stop_containers purge

echo "local OpsWeave processes and this installation's containers stopped"
