#!/usr/bin/env bash
# Node SIGTERM while the Worker Supervisor is in restart backoff.
#
# WHY THE EXIT COUNT IS TAKEN AGAINST A MARK, NOT AS A TOTAL
#
# This used to assert `grep -c 'node-managed pipeline worker exited' >= 1` over
# the whole of /tmp/node-b.log. That log is append-only across the entire
# harness, and `supervisor_lifecycle.sh` runs before this and kills workers
# itself - measured on run 43631374366, node-b.log already contained four
# `worker exited status=signal: 9 (SIGKILL)` lines at 19:24 from that earlier
# step.
#
# So the assertion was satisfied by history: this test would pass even if the
# fake worker had never been launched, which is the one thing it exists to
# prove. It was passing for the wrong reason on that very run - the Node it
# talked to had been revoked by `data_token_revocation.sh`, could not start any
# worker, and this test still printed PASS.
#
# The count is now relative to a line number captured immediately before the
# Node is started, so only this test's own worker can satisfy it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAKE=/tmp/opsweave-fake-worker.sh
MARKER="$ROOT/data-ci/node-b/worker-enabled"
LOG=/tmp/node-b.log
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
# Mark the log before the Node that will write to it starts. Everything above
# this line is another step's history and cannot satisfy the assertion below.
LOG_MARK="$(wc -l <"$LOG" 2>/dev/null || echo 0)"
NODE_B_PID="$(OPSWEAVE_PIPELINE_WORKER_BIN="$FAKE" tests/runtime/start_node.sh node-b 9102)"
echo "$NODE_B_PID" >/tmp/node-b.pid
touch "$MARKER"
# Prove the Node was told to run the fake worker, before waiting for evidence
# that it did.
#
# The env passed above used to be silently discarded: start_node.sh hard-coded
# OPSWEAVE_PIPELINE_WORKER_BIN after the caller's assignment, so `env` replaced
# it. This test then waited 30 s for an exit that could not come, from a REAL
# worker that just sat there polling. The whole-file `grep -c` below was what
# made it pass anyway.
#
# The check reads the Node's own process environment rather than trusting the
# assignment: a future caller cannot lose this argument without saying so.
if [ -r "/proc/$NODE_B_PID/environ" ]; then
  SEEN_BIN="$(tr '\0' '\n' <"/proc/$NODE_B_PID/environ" | sed -n 's/^OPSWEAVE_PIPELINE_WORKER_BIN=//p')"
  if [ "$SEEN_BIN" != "$FAKE" ]; then
    bad "node-b was started with worker bin '$SEEN_BIN', not the fake '$FAKE' (the env assignment was lost)"
  fi
else
  # No /proc (macOS). Fall back to the supervisor's own log line, which records
  # the binary it spawned.
  sleep 2
  if ! tail -n +"$((LOG_MARK + 1))" "$LOG" 2>/dev/null | grep -q "starting node-managed pipeline worker"; then
    bad "node-b never started any worker, so backoff cannot be tested"
  fi
fi
# The fake child exits 9 immediately, so the supervisor must observe it. Wait for
# THIS Node to report one, bounded, rather than sleeping a guessed 2 s.
EXITS=0
for _ in $(seq 1 120); do
  EXITS="$(tail -n +"$((LOG_MARK + 1))" "$LOG" 2>/dev/null | grep -c 'node-managed pipeline worker exited' || true)"
  [ "${EXITS:-0}" -ge 1 ] && break
  sleep 0.25
done
if [ "${EXITS:-0}" -lt 1 ]; then
  echo "FAIL  no fake worker exit observed after this Node started (log mark $LOG_MARK)"
  echo "      expected '$FAKE' to exit 9 and the supervisor to log it within 30 s."
  echo "      lines this Node wrote since the mark:"
  tail -n +"$((LOG_MARK + 1))" "$LOG" 2>/dev/null | tail -20 >&2 || true
  exit 1
fi
START="$(date +%s%N)"
kill -TERM "$NODE_B_PID"
for _ in $(seq 1 60); do kill -0 "$NODE_B_PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$NODE_B_PID" 2>/dev/null; then bad "Node B survived SIGTERM during backoff"; fi
DURATION_MS=$(( ($(date +%s%N) - START) / 1000000 ))
CHILDREN="$(pgrep -P "$NODE_B_PID" -f opsweave 2>/dev/null | wc -l | tr -d ' ' || true)"
[ "${CHILDREN:-0}" = "0" ] || bad "children remain after shutdown: $CHILDREN"
[ "$DURATION_MS" -lt 10000 ] || bad "shutdown duration=$DURATION_MS ms exceeds bound"
echo "PASS SIGTERM during supervisor restart backoff: duration=${DURATION_MS}ms children=0 exits=$EXITS"
# Restore a normal Node B for the steps that follow, and wait for it to be USABLE
# rather than merely alive.
#
# `kill -0` only proves a process exists. A Node that has just started still has
# to enrol, adopt its container and re-mark the instance READY before its
# workload token file has anything in it. Measured on run 43666780709: this line
# returned 0.3 s before `data_token_revocation` ran, that step read
# `/run/opsweave/capability-tokens.json` and found `{}`, and waited 60 s for a key
# that was never coming -
#
#   FAIL  the workload token file never gained data.catalog.v1 within 60 s
#         (keys seen: <empty object>)
#
# Waiting for READY here is the same rule the harness states for the browser
# block: "Wait for the actual Catalog token, not a sleep." A process check is the
# sleep, one level up.
tests/runtime/start_node.sh node-b 9102 >/dev/null
RESTORED=0
for _ in $(seq 1 120); do
  if [ -s /tmp/node-b.pid ] && kill -0 "$(cat /tmp/node-b.pid)" 2>/dev/null; then RESTORED=1; break; fi
  sleep 0.5
done
[ "$RESTORED" = "1" ] || bad "node-b was not restarted for the steps that follow"
# Now the part that matters. Readiness is the Kernel's statement about the Node,
# so it is read from the Kernel, not inferred from the process table.
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])' 2>/dev/null || true)"
NODE_B_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nodeId"])' "$ROOT/data-ci/node-b/node-identity.json" 2>/dev/null || true)"
USABLE=0
for _ in $(seq 1 120); do
  STATE="$(curl -fsS -H "Authorization: Bearer $TOKEN" "${URL:-http://127.0.0.1:18181}/api/v1/nodes" 2>/dev/null \
    | python3 -c 'import json,sys
nid=sys.argv[1]
try: data=json.load(sys.stdin)
except Exception: raise SystemExit
print(next((n.get("status","?") for n in data if n["id"]==nid), "?"))' "$NODE_B_ID" 2>/dev/null || echo "?")"
  if [ "$STATE" = "READY" ]; then USABLE=1; break; fi
  sleep 1
done
[ "$USABLE" = "1" ] || bad "node-b restarted but did not reach READY within 120 s (last state: ${STATE:-?})"
# The NODE being READY is not the INSTANCE being READY, and the steps that follow
# need the second.
#
# `data_token_revocation.sh` reads `/run/opsweave/capability-tokens.json` from the
# data-integration container, and the Node only writes it once that INSTANCE is
# READY. Measured on run 43675797785: this line printed "node-b restarted and
# READY", the next step then waited its own 60 s and reported
#
#     the workload token file never gained data.catalog.v1 (keys seen: <empty object>)
#
# The Node had come back; its workload had not. `demo_data_up.sh` places the
# integration instance on `zone=node-b` (`data_foundation_ci.sh:10`), which is the
# Node this suite restarted, so an instance still STARTING at this point is
# expected rather than surprising.
INSTANCE_READY=0
for _ in $(seq 1 120); do
  READY_INSTANCES="$(curl -fsS -H "Authorization: Bearer $TOKEN" "${URL:-http://127.0.0.1:18181}/api/v1/plugins/opsweave.data-integration" 2>/dev/null \
    | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
print(sum(1 for dep in (d.get("deployments") or []) for i in (dep.get("instances") or []) if i.get("state")=="READY"))' 2>/dev/null || echo 0)"
  [ "${READY_INSTANCES:-0}" -ge 1 ] && { INSTANCE_READY=1; break; }
  sleep 1
done
[ "$INSTANCE_READY" = "1" ] || bad "node-b is READY but its data-integration instance is not (within 120 s)"
echo "node-b restarted pid=$(cat /tmp/node-b.pid), READY, data-integration instance READY"
echo "Supervisor Backoff SIGTERM: PASS"
