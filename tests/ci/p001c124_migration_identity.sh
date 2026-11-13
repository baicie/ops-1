#!/usr/bin/env bash
# P001-C1.2.4 - a reinitialize that died BEFORE removing the inherited identity
# must not finish with that identity.
#
# The sequence C1.2.3 covered was: clone, fail, restart without repair. The state
# it left had a NEW installation id. This one covers the step before that:
#
#   1. clone A's live state directory to B
#   2. write the migration marker exactly as `begin_migration()` does
#   3. kill the process - `installation-id` still holds A's id
#   4. start B again, no repair, no re-copy, with a fresh enrolment token
#
# Before C1.2.4 step 4 succeeded with B running under A's Docker installation
# id: the fresh Kernel identity made the node look isolated while every cleanup
# scoped to the installation id still reached A's containers.
#
# Requires a running platform:
#   RUN_ID=$(tests/ci/p001c_up.sh | sed -n 's/^RUN_ID=//p')
#   tests/ci/p001c124_migration_identity.sh "$RUN_ID"
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
SCRATCH="$DIR/scratch-c124"
mkdir -p "$SCRATCH"
STATE_B="$SCRATCH/node-b-clone"

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

endpoint_of() {
  curl -sS -H "Authorization: Bearer $TOKEN" "$URL/api/v1/nodes" 2>/dev/null | python3 -c '
import json,sys
nid = sys.argv[1]
for n in json.load(sys.stdin):
    if n["id"] == nid:
        print(n.get("dataEndpoint","")); break
' "$1" 2>/dev/null || echo ''
}

A_NODE="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['nodeId'])" "$DIR/node-a/node-identity.json")"
A_INSTALL="$(cat "$DIR/node-a/installation-id")"
A_EP="$(endpoint_of "$A_NODE")"
echo "== A node=$A_NODE install=$A_INSTALL endpoint=${A_EP:-<none>}"

rm -rf "$STATE_B"
cp -a "$DIR/node-a" "$STATE_B"
[ "$(cat "$STATE_B/installation-id")" = "$A_INSTALL" ] \
  || { echo "the clone did not inherit A's installation id; this test would be vacuous" >&2; exit 1; }

# Step 2: the exact file `begin_migration()` writes, then the process dies at
# the point the defect is about - after the marker, before the first delete.
cat > "$STATE_B/reinitialize-in-progress.json" <<JSON
{
  "inheritedInstallationId": "$A_INSTALL",
  "inheritedNodeId": "$A_NODE",
  "startedAt": "2026-11-13T00:00:00Z"
}
JSON
echo "   planted the migration marker; installation-id is still A's"

# Step 4: a fresh token, the same directory, no repair.
B_TOKEN="$(HOME="$DIR/home" "$OPSCTL" --url "$URL" node-token --label c124-clone-$$ 2>/dev/null)"
[ -n "$B_TOKEN" ] || { echo "could not mint an enrolment token for the clone" >&2; exit 1; }
B_PORT="$(( 21700 + ($$ % 200) ))"
B_LOG="$SCRATCH/node-b-clone.log"
(
  cd "$ROOT" || exit 1
  HOME="$DIR/home" OPSWEAVE_KERNEL_URL="$URL" OPSWEAVE_NODE_NAME="c124-clone-$$" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${B_PORT}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${B_PORT}" \
    OPSWEAVE_NODE_STATE_DIR="$STATE_B" \
    OPSWEAVE_ENROLLMENT_TOKEN="$B_TOKEN" \
    ./target/debug/opsweave-node >"$B_LOG" 2>&1 &
  echo $! > "$SCRATCH/node-b.pid"
)
# The marker makes every start re-establish the Kernel identity, so the run is
# only useful once it has either enrolled or refused. `timeout` is not on macOS.
for _ in $(seq 1 150); do
  grep -qE "node enrolled|loaded node identity|Error:" "$B_LOG" 2>/dev/null && break
  sleep 0.2
done
sleep 2
B_PID="$(cat "$SCRATCH/node-b.pid" 2>/dev/null || echo '')"
[ -n "$B_PID" ] && kill "$B_PID" 2>/dev/null || true
wait "$B_PID" 2>/dev/null || true
OUT="$(cat "$B_LOG" 2>/dev/null || echo '')"

# --- the assertion ---------------------------------------------------------
B_INSTALL="$(cat "$STATE_B/installation-id" 2>/dev/null || echo '')"
if [ -n "$B_INSTALL" ] && [ "$B_INSTALL" != "$A_INSTALL" ]; then
  pass "the migration finished with its own installation id ($B_INSTALL)"
else
  fail "the clone finished the migration holding A's installation id ($B_INSTALL): every \
cleanup scoped to that id reaches A's containers"
fi

if printf '%s' "$OUT" | grep -q "installed\|node enrolled\|minted an installation identity"; then
  pass "the node reported completing the migration"
else
  echo "   (the node's log did not report enrolment; see $B_LOG)"
fi

# The binding must attest the new id to B's directory, or the next start cannot
# prove what B owns.
B_BOUND="$(python3 -c '
import json,sys
try:
    print(json.load(open(sys.argv[1]))["installationId"])
except Exception:
    print("")
' "$STATE_B/installation-binding.json" 2>/dev/null || echo '')"
if [ -n "$B_BOUND" ] && [ "$B_BOUND" = "$B_INSTALL" ]; then
  pass "the binding names the new identity"
else
  fail "the binding names '$B_BOUND' but the identity is '$B_INSTALL'"
fi

# A fresh Kernel identity, or an explicit refusal - never A's.
B_NODE="$(python3 -c '
import json,sys
try:
    print(json.load(open(sys.argv[1]))["nodeId"])
except Exception:
    print("")
' "$STATE_B/node-identity.json" 2>/dev/null || echo '')"
if [ "$B_NODE" = "$A_NODE" ]; then
  fail "the clone is still A's Kernel node ($B_NODE)"
else
  pass "the clone's Kernel identity is its own (${B_NODE:-<none>})"
fi

# The marker is only cleared when both halves are new.
if [ -f "$STATE_B/reinitialize-in-progress.json" ]; then
  if [ "$B_INSTALL" != "$A_INSTALL" ] && [ "$B_NODE" != "$A_NODE" ]; then
    echo "   (the marker is still present although both halves are new; a restart commits it)"
  else
    fail "the marker is present and the migration did not complete"
  fi
else
  pass "both halves are new, so the marker was cleared"
fi

# A must be untouched by any of it.
A_EP_AFTER="$(endpoint_of "$A_NODE")"
if [ "$A_EP" = "$A_EP_AFTER" ]; then
  pass "A's data endpoint was not overwritten ($A_EP_AFTER)"
else
  fail "A's endpoint moved $A_EP -> $A_EP_AFTER"
fi
[ "$(cat "$DIR/node-a/installation-id")" = "$A_INSTALL" ] \
  && pass "A's installation id is unchanged" \
  || fail "A's installation id changed"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "an interrupted reinitialize cannot finish with the inherited installation identity"
