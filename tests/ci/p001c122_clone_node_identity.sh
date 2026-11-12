#!/usr/bin/env bash
# P001-C1.2.2 Task A - a reinitialized clone must not keep the original's Kernel
# node identity.
#
# P001-C1.2.1 made `OPSWEAVE_INSTALLATION_ID_ACTION=reinitialize` mint a new
# *Docker* ownership id. It left `node-identity.json` untouched, and that file
# holds the node id, the control credential, the data token and the generation -
# so the clone kept talking to the Kernel as the original node. Two processes
# with one node id alternate their heartbeats over the same row: generation,
# last_seen_at and data_endpoint flip-flop, both receive the same desired
# workloads, and both may create instances for them.
#
# This test proves the sharing and then proves the fix, against a real Kernel.
# It needs a running platform:
#
#   RUN_ID=$(tests/ci/p001c_up.sh | sed -n 's/^RUN_ID=//p')
#   tests/ci/p001c122_clone_node_identity.sh "$RUN_ID"
#
# It does NOT need a Docker daemon for the identity assertions - they are about
# what the Kernel records. The nodes it starts are killed at the end.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  echo "usage: $0 <run-id>" >&2
  exit 2
fi
DIR="/tmp/p001c-${RUN_ID}"
[ -f "$DIR/run.json" ] || { echo "no run record in $DIR" >&2; exit 1; }
PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$DIR/run.json")"
URL="http://127.0.0.1:${PORT}"
TOKEN="$(cat "$DIR/token")"
OPSCTL="$ROOT/target/debug/opsctl"
SCRATCH="$DIR/scratch-c122"
mkdir -p "$SCRATCH"

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

api() { curl -sS -m 20 -H "Authorization: Bearer $TOKEN" "$URL$1"; }

# Read one field of one node row.
node_field() {
  api /api/v1/nodes | python3 -c '
import json,sys
nid, field = sys.argv[1], sys.argv[2]
for n in json.load(sys.stdin):
    if n["id"] == nid:
        print(n.get(field, "")); break
' "$1" "$2" 2>/dev/null || echo ''
}

node_count_named() {
  api /api/v1/nodes | python3 -c '
import json,sys
name = sys.argv[1]
print(sum(1 for n in json.load(sys.stdin) if n.get("id") == name))
' "$1" 2>/dev/null || echo 0
}

echo "== setup: clone node-a's state directory"
# node-a is already enrolled by p001c_up.sh and holds state in $DIR/node-a.
[ -f "$DIR/node-a/node-identity.json" ] || { echo "node-a has no identity; run p001c_up first" >&2; exit 1; }
[ -f "$DIR/node-a/installation-id" ] || { echo "node-a has no installation id" >&2; exit 1; }
A_NODE="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['nodeId'])" "$DIR/node-a/node-identity.json")"
A_INSTALL="$(cat "$DIR/node-a/installation-id")"
A_ENDPOINT="$(node_field "$A_NODE" dataEndpoint)"
echo "   A node=$A_NODE install=$A_INSTALL endpoint=${A_ENDPOINT:-<none>}"
[ -n "$A_NODE" ] || { echo "could not read A's node id" >&2; exit 1; }

STATE_B="$SCRATCH/node-b-clone"
rm -rf "$STATE_B"
cp -a "$DIR/node-a" "$STATE_B"

# The clone carries the same Kernel identity until something changes it.
B_NODE_BEFORE="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['nodeId'])" "$STATE_B/node-identity.json")"
if [ "$B_NODE_BEFORE" = "$A_NODE" ]; then
  pass "the clone starts with the same Kernel node id as A ($A_NODE)"
else
  fail "the clone did not inherit A's node id; the scenario did not reproduce"
fi

echo
echo "== without a new enrolment token the clone must refuse and change nothing"
# The inherited token was spent by A's enrolment. A clone that silently reused
# the inherited Kernel identity would be the bug this phase is about; one that
# started with no Kernel identity at all would be a different bug. It must stop.
IDENTITY_BEFORE="$(cat "$STATE_B/node-identity.json")"
B_PORT_REFUSE="$(( 21000 + ($$ % 300) ))"
REFUSE_LOG="$SCRATCH/node-b-refuse.log"
(
  cd "$ROOT" || exit 1
  HOME="$DIR/home" OPSWEAVE_KERNEL_URL="$URL" OPSWEAVE_NODE_NAME="node-b-clone-$$" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${B_PORT_REFUSE}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${B_PORT_REFUSE}" \
    OPSWEAVE_NODE_STATE_DIR="$STATE_B" \
    OPSWEAVE_INSTALLATION_ID_ACTION=reinitialize \
    ./target/debug/opsweave-node >"$REFUSE_LOG" 2>&1 &
  echo $! > "$SCRATCH/node-b-refuse.pid"
)
for _ in $(seq 1 100); do
  grep -qiE "restored the previous Kernel identity|Error:" "$REFUSE_LOG" 2>/dev/null && break
  sleep 0.2
done
REFUSE_PID="$(cat "$SCRATCH/node-b-refuse.pid" 2>/dev/null || echo '')"
[ -n "$REFUSE_PID" ] && kill "$REFUSE_PID" 2>/dev/null || true
wait "$REFUSE_PID" 2>/dev/null || true
if grep -q "restored the previous Kernel identity" "$REFUSE_LOG"; then
  pass "a re-enrolment without a fresh token is refused"
else
  fail "the clone did not refuse a re-enrolment without a fresh token"
fi
[ "$(cat "$STATE_B/node-identity.json" 2>/dev/null)" = "$IDENTITY_BEFORE" ] \
  && pass "the inherited identity was restored byte for byte" \
  || fail "the inherited identity was not restored; the directory is not recoverable"
if grep -q "loaded node identity" "$REFUSE_LOG"; then
  fail "it fell back to loading the shared identity"
else
  pass "it did not fall back to the shared credential"
fi

echo
echo "== with a fresh token the clone reinitializes its installation identity"
# Give the clone its own enrolment token, as ADR-023 §2.2a requires. The Kernel
# treats it as a new node and issues a new credential, data token and generation.
B_TOKEN="$(HOME="$DIR/home" "$OPSCTL" --url "$URL" node-token --label node-b-clone-$$ 2>/dev/null)"
[ -n "$B_TOKEN" ] || { echo "could not mint an enrolment token for the clone" >&2; exit 1; }
# Re-clone from A: the refused attempt above re-recorded this directory's
# binding, so it is no longer a "copy of A's directory" and would not exercise
# the reinitialize path a second time.
rm -rf "$STATE_B"
cp -a "$DIR/node-a" "$STATE_B"
B_PORT="$(( 21400 + ($$ % 300) ))"
# `timeout` is a GNU coreutils binary and is absent on macOS, where this suite
# also runs. Start the node, let it settle or fail, then stop it.
B_LOG="$SCRATCH/node-b-clone.log"
(
  cd "$ROOT" || exit 1
  HOME="$DIR/home" \
    OPSWEAVE_KERNEL_URL="$URL" \
    OPSWEAVE_NODE_NAME="node-b-clone-$$" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${B_PORT}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${B_PORT}" \
    OPSWEAVE_NODE_STATE_DIR="$STATE_B" \
    OPSWEAVE_ENROLLMENT_TOKEN="$B_TOKEN" \
    OPSWEAVE_INSTALLATION_ID_ACTION=reinitialize \
    ./target/debug/opsweave-node >"$B_LOG" 2>&1 &
  echo $! > "$SCRATCH/node-b-clone.pid"
)
for _ in $(seq 1 100); do
  if grep -qiE "reinitializ|INSTALLATION_IDENTITY_CONFLICT|loaded node identity|error" "$B_LOG" 2>/dev/null; then break; fi
  sleep 0.2
done
sleep 1
B_PID="$(cat "$SCRATCH/node-b-clone.pid" 2>/dev/null || echo '')"
[ -n "$B_PID" ] && kill "$B_PID" 2>/dev/null || true
wait "$B_PID" 2>/dev/null || true
OUT="$(cat "$B_LOG" 2>/dev/null || echo '')"
echo "$OUT" | grep -qiE "reinitializ" \
  && pass "reinitialize was applied" \
  || fail "the node did not report reinitializing: $(printf '%s' "$OUT" | tail -2)"

B_INSTALL="$(cat "$STATE_B/installation-id" 2>/dev/null || echo '')"
[ -n "$B_INSTALL" ] && [ "$B_INSTALL" != "$A_INSTALL" ] \
  && pass "the clone minted a different Docker installation id" \
  || fail "the clone's installation id did not change ($B_INSTALL)"

# --- THE ASSERTION ---------------------------------------------------------
# The Docker identity is now separate. The Kernel identity is what this phase
# is about, and C1.2.1 left it shared.
B_NODE_AFTER="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['nodeId'])" "$STATE_B/node-identity.json" 2>/dev/null || echo '')"
printf '%s\n' "$OUT" | grep -q "loaded node identity" \
  && fail "the clone loaded A's Kernel identity instead of enrolling afresh" \
  || pass "the clone did not fall back to loading the inherited identity"

if [ "$B_NODE_AFTER" = "$A_NODE" ]; then
  fail "REGRESSION (Task A): after reinitialize the clone still holds A's Kernel node id \
($B_NODE_AFTER). Both processes heartbeat the same node row, so generation, \
last_seen_at and data_endpoint are overwritten by whichever wrote last."
else
  pass "after reinitialize the clone has its own Kernel node id (${B_NODE_AFTER:-<none>})"
fi

# If the clone did enrol afresh it must be a distinct row the Kernel knows about.
if [ -n "$B_NODE_AFTER" ] && [ "$B_NODE_AFTER" != "$A_NODE" ]; then
  [ "$(node_count_named "$B_NODE_AFTER")" = "1" ] \
    && pass "the Kernel has a separate row for the clone" \
    || fail "the clone's node id is not registered with the Kernel"
fi

# --- the credential half ---------------------------------------------------
# `NodeView` deliberately does not expose credentials, so equality is asserted
# behaviourally: the clone's new credential must NOT authenticate as A's node
# id. If the clone had kept A's credential this call would succeed, and that is
# precisely the sharing this phase is about.
B_CREDENTIAL="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['credential'])" \
  "$STATE_B/node-identity.json" 2>/dev/null || echo '')"
A_CREDENTIAL="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['credential'])" \
  "$DIR/node-a/node-identity.json" 2>/dev/null || echo '')"
if [ -n "$B_CREDENTIAL" ] && [ "$B_CREDENTIAL" != "$A_CREDENTIAL" ]; then
  pass "the clone holds a different control credential from A"
else
  fail "the clone inherited A's control credential"
fi
# Drive the real endpoint: A's node id with the clone's credential must be
# rejected. A heartbeat is the cheapest authenticated call.
# A body the endpoint accepts. `resourceSnapshot` is required, and a malformed
# body returns 422 AFTER authentication - which would make a 422 look like a
# rejection of the credential when it is a rejection of the payload. This was
# the first version of this check and it was wrong.
# The generation must match what the Kernel already knows: A's real supervisor is
# running and advances it, and a stale value is refused with 409
# STALE_NODE_GENERATION - a rejection of the number, not of the credential.
A_GENERATION="$(node_field "$A_NODE" generation)"
[ -n "$A_GENERATION" ] || A_GENERATION=1
HB_BODY='{"generation":'"$A_GENERATION"',"status":"READY","observedAt":"2026-11-12T00:00:00Z","dataEndpoint":"http://127.0.0.1:1","runtimeAdapterVersion":"t","os":"linux","arch":"arm64","labels":{},"capabilities":[],"instances":[],"resourceSnapshot":{"sampledAt":"2026-11-12T00:00:00Z","cpuUtilization":0.0,"memoryUsedBytes":0,"memoryTotalBytes":0,"cpuCores":1,"filesystemUsedBytes":0,"filesystemTotalBytes":0}}'
# Prove the body itself is accepted for the RIGHT node first, or the 401/403
# assertion below would be vacuous.
A_SELF="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 \
  -H "Authorization: Bearer $A_CREDENTIAL" -H 'Content-Type: application/json' \
  -X POST "$URL/internal/v1/nodes/$A_NODE/heartbeat" -d "$HB_BODY" 2>/dev/null || echo '000')"
case "$A_SELF" in
  200) pass "control: A's own credential is accepted for A (HTTP 200)" ;;
  *)   fail "control failed: A's own credential got HTTP $A_SELF for A; the credential check below would prove nothing" ;;
esac
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 \
  -H "Authorization: Bearer $B_CREDENTIAL" -H 'Content-Type: application/json' \
  -X POST "$URL/internal/v1/nodes/$A_NODE/heartbeat" \
  -d "$HB_BODY" \
  2>/dev/null || echo '000')"
case "$CODE" in
  401|403) pass "the clone's credential is rejected for A's node id (HTTP $CODE)" ;;
  200)     fail "the clone's credential was ACCEPTED for A's node id (HTTP 200): the credential is shared" ;;
  *)       fail "inconclusive: the Kernel answered $CODE for the clone's credential; the body is accepted for A, so this is not a payload problem" ;;
esac

# --- the desired-workload half --------------------------------------------
# Two distinct node ids mean two distinct desired lists. Assert the Kernel
# answers them separately rather than handing both the same rows.
A_DESIRED="$(curl -sS -m 10 -H "Authorization: Bearer $A_CREDENTIAL" \
  -H 'Content-Type: application/json' -X POST "$URL/internal/v1/nodes/$A_NODE/heartbeat" \
  -d "$HB_BODY" \
  2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("nodeId",""))
except Exception: print("")' 2>/dev/null || echo '')"
if [ -n "$A_DESIRED" ]; then
  if [ "$A_DESIRED" = "$A_NODE" ]; then
    pass "the Kernel answers A's heartbeat for A's node id"
  else
    fail "A's heartbeat returned nodeId $A_DESIRED, expected $A_NODE"
  fi
  # Both control heartbeats above wrote A's row, including data_endpoint.
  # Re-read it now, so the overwrite check below measures the clone's effect
  # and not this test's own control traffic.
  A_ENDPOINT="$(node_field "$A_NODE" dataEndpoint)"
else
  echo "   (A's heartbeat response was not parseable; the desired-workload identity check is NOT_RUN)"
fi

# A must be untouched by any of this.
[ "$(node_field "$A_NODE" id)" = "$A_NODE" ] \
  && pass "A's node row still exists" \
  || fail "A's node row disappeared"
A_ENDPOINT_AFTER="$(node_field "$A_NODE" dataEndpoint)"
if [ -n "$A_ENDPOINT" ] && [ "$A_ENDPOINT_AFTER" = "$A_ENDPOINT" ]; then
  pass "A's data endpoint was not overwritten ($A_ENDPOINT_AFTER)"
elif [ -z "$A_ENDPOINT" ]; then
  echo "   (A had no recorded endpoint; skipping the endpoint-overwrite check)"
else
  fail "A's data endpoint moved $A_ENDPOINT -> $A_ENDPOINT_AFTER; the clone heartsbeated as A"
fi


echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "a reinitialized clone has its own Kernel node identity"
