#!/usr/bin/env bash
# Node SIGTERM while the Worker Supervisor is in restart backoff.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAKE=/tmp/opsweave-fake-worker.sh
MARKER="$ROOT/data-ci/node-b/worker-enabled"
cleanup() {
  rm -f "$MARKER"
  if [ -f /tmp/node-b.pid ]; then
    kill -TERM "$(cat /tmp/node-b.pid)" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$(cat /tmp/node-b.pid)" 2>/dev/null || break; sleep 0.5; done
  fi
  tests/runtime/start_node.sh node-b 9102 >/dev/null 2>&1 || true
}
trap cleanup EXIT
bad() { echo "FAIL  $*"; exit 1; }
printf '#!/bin/sh\nexit 9\n' > "$FAKE"
chmod +x "$FAKE"
rm -f "$MARKER"
kill -TERM "$(cat /tmp/node-b.pid)" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$(cat /tmp/node-b.pid)" 2>/dev/null || break; sleep 0.5; done
NODE_B_PID="$(OPSWEAVE_PIPELINE_WORKER_BIN="$FAKE" tests/runtime/start_node.sh node-b 9102)"
echo "$NODE_B_PID" >/tmp/node-b.pid
touch "$MARKER"
# The fake child exits 9 repeatedly; wait until a Supervisor backoff starts.
sleep 2
LOGS_BEFORE="$(grep -c 'node-managed pipeline worker exited' /tmp/node-b.log 2>/dev/null || true)"
[ "${LOGS_BEFORE:-0}" -ge 1 ] || { echo "no fake worker exit observed"; tail -30 /tmp/node-b.log; exit 1; }
START="$(date +%s%N)"
kill -TERM "$NODE_B_PID"
for _ in $(seq 1 60); do kill -0 "$NODE_B_PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$NODE_B_PID" 2>/dev/null; then bad "Node B survived SIGTERM during backoff"; fi
DURATION_MS=$(( ($(date +%s%N) - START) / 1000000 ))
CHILDREN="$(pgrep -P "$NODE_B_PID" -f opsweave 2>/dev/null | wc -l | tr -d ' ' || true)"
[ "${CHILDREN:-0}" = "0" ] || bad "children remain after shutdown: $CHILDREN"
[ "$DURATION_MS" -lt 10000 ] || bad "shutdown duration=$DURATION_MS ms exceeds bound"
echo "PASS SIGTERM during supervisor restart backoff: duration=${DURATION_MS}ms children=0"
# Restore a normal Node B for the remaining revocation/token gates.
tests/runtime/start_node.sh node-b 9102 >/dev/null
for _ in $(seq 1 120); do [ -s /tmp/node-b.pid ] && kill -0 "$(cat /tmp/node-b.pid)" 2>/dev/null && break; sleep 0.5; done
echo "Supervisor Backoff SIGTERM: PASS"
