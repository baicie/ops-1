#!/usr/bin/env bash
# P001-C1.2.3 - a failed reinitialize must not let the NEXT start inherit the
# original node's Kernel identity.
#
# The sequence is the one the brief forbids substituting around:
#
#   1. clone A's live state directory to B
#   2. start B with reinitialize and NO token -> it must fail
#   3. start B again, same directory, no repair, no token
#
# Step 3 is the defect: the new installation-id and binding were already on
# disk, so the binding matched, the directory looked settled, and the node
# loaded A's Kernel identity and rewrote A's data endpoint.
#
# Requires a running platform:
#   RUN_ID=$(tests/ci/p001c_up.sh | sed -n 's/^RUN_ID=//p')
#   tests/ci/p001c123_reinit_recovery.sh "$RUN_ID"
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
SCRATCH="$DIR/scratch-c123"
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

digest() { [ -f "$1" ] && shasum -a 256 "$1" | cut -d' ' -f1 || echo MISSING; }

A_NODE="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['nodeId'])" "$DIR/node-a/node-identity.json")"
A_EP="$(endpoint_of "$A_NODE")"
echo "== A node=$A_NODE endpoint=${A_EP:-<none>}"

rm -rf "$STATE_B"
cp -a "$DIR/node-a" "$STATE_B"

echo
echo "== start 1: reinitialize WITHOUT a fresh token (must fail)"
(
  cd "$ROOT" || exit 1
  HOME="$DIR/home" OPSWEAVE_KERNEL_URL="$URL" OPSWEAVE_NODE_NAME="clone-c123-$$" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:21901" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:21901" \
    OPSWEAVE_NODE_STATE_DIR="$STATE_B" \
    OPSWEAVE_INSTALLATION_ID_ACTION=reinitialize \
    ./target/debug/opsweave-node >"$SCRATCH/start1.log" 2>&1 &
  echo $! > "$SCRATCH/start1.pid"
)
for _ in $(seq 1 100); do
  grep -qE "NEW enrolment token|enrolled|Error:" "$SCRATCH/start1.log" 2>/dev/null && break
  sleep 0.2
done
kill "$(cat "$SCRATCH/start1.pid")" 2>/dev/null || true
wait 2>/dev/null || true

if grep -q "loaded node identity" "$SCRATCH/start1.log"; then
  fail "the first start loaded the inherited identity instead of failing"
else
  pass "the first start failed rather than adopting the inherited identity"
fi
[ -f "$STATE_B/reinitialize-in-progress.json" ] \
  && pass "the failure left a durable migration marker" \
  || fail "no migration marker was written; a restart could look settled"

echo "   state left on disk (A's digests for comparison):"
for f in installation-id installation-binding.json node-identity.json; do
  printf '     %-26s B=%s\n' "$f" "$(digest "$STATE_B/$f")"
  printf '     %-26s A=%s\n' "" "$(digest "$DIR/node-a/$f")"
done

echo
echo "== start 2: same directory, no repair, no token (the defect)"
(
  cd "$ROOT" || exit 1
  HOME="$DIR/home" OPSWEAVE_KERNEL_URL="$URL" OPSWEAVE_NODE_NAME="clone-c123-$$" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:21902" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:21902" \
    OPSWEAVE_NODE_STATE_DIR="$STATE_B" \
    ./target/debug/opsweave-node >"$SCRATCH/start2.log" 2>&1 &
  echo $! > "$SCRATCH/start2.pid"
)
for _ in $(seq 1 100); do
  grep -qE "unfinished reinitialize|NEW enrolment token|loaded node identity|INSTALLATION_" \
    "$SCRATCH/start2.log" 2>/dev/null && break
  sleep 0.2
done
sleep 1
kill "$(cat "$SCRATCH/start2.pid")" 2>/dev/null || true
wait 2>/dev/null || true

if grep -q "loaded node identity" "$SCRATCH/start2.log"; then
  fail "the second start loaded the inherited Kernel identity"
else
  pass "the second start did not load the inherited Kernel identity"
fi
if grep -qE "unfinished reinitialize|NEW enrolment token|INSTALLATION_MIGRATION_IN_PROGRESS|INSTALLATION_IDENTITY_CONFLICT" \
     "$SCRATCH/start2.log"; then
  pass "it reported the unfinished migration"
else
  fail "it did not explain why it refused"
fi
[ -f "$STATE_B/reinitialize-in-progress.json" ] \
  && pass "the marker is still present, so the migration can be finished" \
  || fail "the marker was cleared even though the migration never completed"

# The point of all of the above: A must be untouched.
A_EP_AFTER="$(endpoint_of "$A_NODE")"
if [ "$A_EP" = "$A_EP_AFTER" ]; then
  pass "A's data endpoint was not overwritten by the clone"
else
  fail "A's endpoint moved $A_EP -> $A_EP_AFTER: the clone started as A"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "a failed reinitialize cannot be mistaken for a settled installation"
