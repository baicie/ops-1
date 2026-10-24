#!/usr/bin/env bash
# Real OS process supervisor lifecycle: marker removal and worker SIGKILL restart.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_B_PID="$(cat /tmp/node-b.pid)"
MARKER="$ROOT/data-ci/node-b/worker-enabled"
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
workers() { pgrep -P "$NODE_B_PID" -f opsweave-pipeline-worker 2>/dev/null || true; }
wait_worker() {
  local pid=""
  for _ in $(seq 1 60); do
    pid="$(workers | head -1)"
    [ -n "$pid" ] && { echo "$pid"; return 0; }
    sleep 0.5
  done
  return 1
}
wait_gone() {
  local pid="$1"
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  return 1
}
rm -f "$MARKER"
sleep 3
touch "$MARKER"
FIRST="$(wait_worker)" || bad "supervisor did not start a worker"
echo "supervisor first worker pid=$FIRST ppid=$NODE_B_PID"
rm -f "$MARKER"
wait_gone "$FIRST" || bad "worker survived marker removal (pid=$FIRST)"
ok "marker removal stopped worker pid=$FIRST"
touch "$MARKER"
SECOND="$(wait_worker)" || bad "supervisor did not restart worker after marker restore"
[ "$SECOND" != "$FIRST" ] || bad "supervisor reused the stopped worker pid=$FIRST"
ok "marker restore started new worker pid=$SECOND"
kill -9 "$SECOND" 2>/dev/null || true
wait_gone "$SECOND" || bad "supervisor did not reap SIGKILLed worker pid=$SECOND"
THIRD="$(wait_worker)" || bad "supervisor did not restart after worker SIGKILL"
[ "$THIRD" != "$SECOND" ] || bad "supervisor did not replace SIGKILLed worker"
echo "supervisor restart worker pid=$THIRD"
ok "worker SIGKILL restarted by supervisor (old=$SECOND new=$THIRD)"
# Consecutive crash loop: each kill must produce a new supervised PID; backoff
# must be bounded and the supervisor must keep observing the marker.
CRASH="$THIRD"
for round in 1 2 3; do
  kill -9 "$CRASH" 2>/dev/null || true
  wait_gone "$CRASH" || bad "crash-loop round $round worker pid=$CRASH survived"
  CRASH="$(wait_worker)" || bad "supervisor did not restart in crash-loop round $round"
  echo "crash-loop round=$round old=$THIRD new=$CRASH"
done
ok "repeated worker crash loop recovered with bounded backoff (final=$CRASH)"
rm -f "$MARKER"
wait_gone "$CRASH" || bad "final marker removal did not stop worker"
ok "Supervisor Lifecycle Golden Path: PASS"
