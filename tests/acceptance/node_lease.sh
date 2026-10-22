#!/usr/bin/env bash
# Partition the Kernel from the Node for longer than the node lease.
# The Node must fail closed and stop its managed workloads.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
NODE_NAME="${OPSWEAVE_LEASE_NODE:-node-b}"
NODE_ID="$(psql -d "${OPSWEAVE_DB_NAME:-opsweave}" -Atc "select id from kernel.nodes where name='$NODE_NAME' and revoked_at is null order by enrolled_at desc limit 1")"
[ -n "$NODE_ID" ] || { echo "$NODE_NAME is not enrolled" >&2; exit 1; }
BEFORE="$(docker ps -q --filter "label=opsweave.node-id=$NODE_ID" | wc -l | tr -d ' ')"
[ "$BEFORE" -ge 1 ] || { echo "$NODE_NAME has no managed container to test" >&2; exit 1; }
KERNEL_PID="$(lsof -nP -iTCP:18181 -sTCP:LISTEN -t | head -1)"
echo "stopping Kernel pid=$KERNEL_PID; $NODE_NAME has $BEFORE container(s)"
kill "$KERNEL_PID"
for _ in $(seq 1 45); do
  AFTER="$(docker ps -q --filter "label=opsweave.node-id=$NODE_ID" | wc -l | tr -d ' ')"
  [ "$AFTER" = "0" ] && break
  sleep 1
done
[ "$AFTER" = "0" ] || { echo "node lease did not stop workloads (still $AFTER)" >&2; exit 1; }
grep -q 'entering quarantine' "/tmp/opsweave-$NODE_NAME.log" || { echo "node did not log quarantine transition" >&2; exit 1; }
echo "node lease test passed: workloads stopped after Kernel partition exceeded lease"
