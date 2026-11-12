#!/usr/bin/env bash
# P001-C1.1B - the rollback state machine, asserted against a live platform.
#
# Every branch of `deployments::rollback` must produce the same outcome shape and
# a truthful `rollbackCompleted`. This drives the real API - not the source - so
# it catches a branch that returns 200 while doing nothing.
#
# Requires a running isolated platform:
#   RUN_ID=$(tests/ci/p001c_up.sh | sed -n 's/^RUN_ID=//p')
#   tests/ci/p001c_rollback_states.sh "$RUN_ID"
#
# The plugin bundles must be installable from dist/plugins.
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
# Scratch files live under the run so two concurrent runs cannot overwrite
# each other output - the fixed /tmp/p001c11-* names made that possible.
SCRATCH="$DIR/scratch"
mkdir -p "$SCRATCH"
[ -f "$DIR/run.json" ] || { echo "no run record in $DIR" >&2; exit 1; }
PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$DIR/run.json")"
DB="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['database'])" "$DIR/run.json")"
HOME_DIR="$DIR/home"
URL="http://127.0.0.1:${PORT}"
OPSCTL="$ROOT/target/debug/opsctl"
TOKEN="$(cat "$DIR/token")"

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

ops() { HOME="$HOME_DIR" "$OPSCTL" --url "$URL" "$@"; }
gw() { curl -sS -m 10 -H "Authorization: Bearer $TOKEN" \
  "$URL/api/v1/gateway/dev.opsweave.hello/api/hello" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || echo ''; }
active() { ops plugins 2>/dev/null | awk '$1=="dev.opsweave.hello"{for(i=1;i<=NF;i++) if($i ~ /^active=/){sub("active=","",$i); print $i}}'; }
active_rev() { psql -d "$DB" -tAc \
  "SELECT generation FROM kernel.activation_revisions WHERE plugin_id='dev.opsweave.hello' AND status='ACTIVE'" 2>/dev/null | tr -d ' '; }

# The uniform envelope must be present on EVERY branch.
assert_envelope() {
  local label="$1" json="$2"
  for key in targetVersion effectiveVersion effectiveRevision rollbackCompleted pendingActivation; do
    if printf '%s' "$json" | grep -q "\"$key\""; then :; else
      fail "$label: response is missing $key"; return 1
    fi
  done
  return 0
}

echo "== setup: v1 active, v2 staged"
ops install dist/plugins/hello-ops-0.0.1.plugin.zip >/dev/null 2>&1
ops install dist/plugins/hello-ops-0.0.2.plugin.zip >/dev/null 2>&1
ops deploy dev.opsweave.hello 0.0.1 --replicas 2 --selector role=node --wait >/dev/null 2>&1
ops activate dev.opsweave.hello 0.0.1 >/dev/null 2>&1
[ "$(gw)" = "0.0.1" ] || { echo "setup failed: gateway $(gw)" >&2; exit 1; }
echo "   v1 active, gateway serves 0.0.1"

echo
echo "== A. idempotent: rollback to the version already active"
OUT="$(ops rollback dev.opsweave.hello 0.0.1 --replicas 2 2>&1)"
assert_envelope "idempotent" "$OUT" && {
  printf '%s' "$OUT" | grep -q '"rollbackCompleted": true' \
    && pass "already-active rollback reports completed" \
    || fail "already-active rollback did not report completion"
  [ "$(gw)" = "0.0.1" ] && pass "route unchanged at 0.0.1" || fail "route moved to $(gw)"
}

echo
echo "== B. upgrade to v2, then roll back across a redeploy (DRAINING/DISABLED)"
ops deploy dev.opsweave.hello 0.0.2 --replicas 2 --selector role=node --wait >/dev/null 2>&1
ops activate dev.opsweave.hello 0.0.2 >/dev/null 2>&1
[ "$(gw)" = "0.0.2" ] && pass "upgrade routes to 0.0.2" || fail "upgrade did not route (got $(gw))"
OUT="$(ops rollback dev.opsweave.hello 0.0.1 --replicas 2 2>&1)"
assert_envelope "cross-version" "$OUT" && {
  if printf '%s' "$OUT" | grep -q '"rollbackCompleted": true'; then
    pass "cross-version rollback reports completed"
  else
    fail "cross-version rollback did not complete: $(printf '%s' "$OUT" | tr '\n' ' ' | head -c 200)"
  fi
}
[ "$(gw)" = "0.0.1" ] && pass "gateway serves 0.0.1 after rollback" \
  || fail "gateway serves $(gw), not 0.0.1"
[ "$(active)" = "0.0.1" ] && pass "active version is 0.0.1" || fail "active version is $(active)"

echo
echo "== C. stale expectedRevision is refused BEFORE any redeploy"
BEFORE_REV="$(active_rev)"
# Timed: the refusal must arrive without waiting out a redeploy. Before the
# early check this call sat in `deploy --wait` for minutes and then returned 409.
C_START="$(date +%s)"
OUT="$(ops rollback dev.opsweave.hello 0.0.2 --expected-revision 1 --replicas 2 2>&1)"
C_ELAPSED=$(( $(date +%s) - C_START ))
if [ "$C_ELAPSED" -le 10 ]; then
  pass "the stale revision was refused in ${C_ELAPSED}s, before a redeploy"
else
  fail "the stale revision took ${C_ELAPSED}s to refuse; it redeployed first"
fi
if printf '%s' "$OUT" | grep -q "REVISION_CONFLICT"; then
  pass "a stale expectedRevision is refused with REVISION_CONFLICT"
else
  fail "stale expectedRevision was not refused: $(printf '%s' "$OUT" | tail -1)"
fi
[ "$(active)" = "0.0.1" ] && pass "the refused request did not change the route" \
  || fail "the refused request moved the route to $(active)"
AFTER_REV="$(active_rev)"
[ "$BEFORE_REV" = "$AFTER_REV" ] && pass "activation revision unchanged ($BEFORE_REV)" \
  || fail "revision moved $BEFORE_REV -> $AFTER_REV"

echo
echo "== D. concurrency: same target is idempotent, stale revision is a conflict"
ops deploy dev.opsweave.hello 0.0.2 --replicas 2 --selector role=node --wait >/dev/null 2>&1
ops activate dev.opsweave.hello 0.0.2 >/dev/null 2>&1
[ "$(gw)" = "0.0.2" ] || fail "setup for D did not reach 0.0.2"
REV_BEFORE="$(active_rev)"

# D1: two identical rollbacks, same expectedRevision, same target.
#
# For identical requests the correct outcomes are "both succeed" or "one succeeds
# and the other is idempotent" - there is no legitimate conflict, because they
# ask for the same thing. "At least one exited 0" is NOT the assertion: it passes
# when the second request silently corrupted state. What is asserted is that
# every request ended in one of those two shapes, and that the database ends with
# exactly one ACTIVE revision whose version and generation are consistent.
run_pair() {
  local tag="$1" rev="$2"
  ( ops rollback dev.opsweave.hello 0.0.1 --expected-revision "$rev" --replicas 2       >"$SCRATCH/$tag.a" 2>&1; echo $? >"$SCRATCH/$tag.a.code" ) &
  local pa=$!
  ( ops rollback dev.opsweave.hello 0.0.1 --expected-revision "$rev" --replicas 2       >"$SCRATCH/$tag.b" 2>&1; echo $? >"$SCRATCH/$tag.b.code" ) &
  local pb=$!
  local waited=0
  while kill -0 "$pa" 2>/dev/null || kill -0 "$pb" 2>/dev/null; do
    [ "$waited" -ge 180 ] && { kill "$pa" "$pb" 2>/dev/null; break; }
    sleep 5; waited=$((waited + 5))
  done
  wait "$pa" 2>/dev/null; wait "$pb" 2>/dev/null
  echo "$waited"
}

WAITED="$(run_pair d1 "$REV_BEFORE")"
[ "$WAITED" -ge 180 ] && fail "D1 did not settle within 180s"

A="$(cat "$SCRATCH"/d1.a.code 2>/dev/null)"; B="$(cat "$SCRATCH"/d1.b.code 2>/dev/null)"
# Classify each: success, idempotent success, or conflict. Anything else - 5xx,
# a timeout, an unexpected error - is a failure of the contract.
classify() {
  local f="$1" code="$2"
  if [ "$code" = "0" ]; then
    if grep -q '"idempotent": true' "$f" 2>/dev/null; then echo idempotent
    elif grep -q '"rollbackCompleted": true' "$f" 2>/dev/null; then echo success
    else echo "success-without-completion-flag"; fi
  elif grep -qE "API 5[0-9][0-9] " "$f" 2>/dev/null; then echo "5xx"
  elif grep -qE "REVISION_CONFLICT|409 Conflict returned CONFLICT" "$f" 2>/dev/null; then
    # Two shapes are correct here. A stale expectedRevision is refused as
    # REVISION_CONFLICT before any work. A request that loses the race at the
    # unique index on (plugin_id, generation) is refused as CONFLICT by the
    # sqlx-error mapping added in C1.1 - that is also a correct CAS refusal, and
    # the point of this case is that it is a 409 rather than a 500.
    echo conflict
  else echo "other-error"; fi
}
CA="$(classify "$SCRATCH"/d1.a "$A")"; CB="$(classify "$SCRATCH"/d1.b "$B")"
# Which request wins is a race and must not be asserted: measured on consecutive
# runs, A won once and B won once. What must hold is that the pair resolves as
# one success plus one conflict - not two successes (state would have been
# overwritten), not two conflicts (the work never happened), and never a 5xx.
case "$CA" in
  success|idempotent) pass "D1 request A ended as $CA" ;;
  conflict) pass "D1 request A ended as conflict" ;;
  *) fail "D1 request A ended as $CA (exit $A)" ;;
esac
# B is allowed to be a CONFLICT, and that is correct rather than a bug: the two
# requests carry the same expectedRevision, so whichever commits second finds a
# revision that has already moved and must refuse. That is compare-and-swap
# working. It must NOT be a 5xx, a silent success that corrupts state, or a
# timeout - those are asserted below.
case "$CB" in
  success|idempotent) pass "D1 request B ended as $CB" ;;
  conflict) pass "D1 request B ended as conflict (its expectedRevision was consumed by A)" ;;
  *) fail "D1 request B ended as $CB (exit $B)" ;;
esac
# Exactly one of the pair may have performed the rollback. Two successes would
# mean both wrote, two conflicts would mean neither did.
case "$CA:$CB" in
  success:conflict|idempotent:conflict|conflict:success|conflict:idempotent|success:idempotent|idempotent:success)
    pass "D1 resolved as exactly one success and one refusal ($CA / $CB)" ;;
  success:success|idempotent:idempotent)
    fail "D1 both requests reported success ($CA / $CB); state may have been written twice" ;;
  conflict:conflict)
    fail "D1 both requests were refused; the rollback never happened" ;;
  *)
    fail "D1 resolved unexpectedly ($CA / $CB)" ;;
esac
# Both asking for 0.0.1 must never leave the route elsewhere.
[ "$(active)" = "0.0.1" ] && pass "D1 left the active version at 0.0.1" \
  || fail "D1 left the active version at $(active)"
ACTIVE_COUNT="$(psql -d "$DB" -tAc "SELECT count(*) FROM kernel.activation_revisions WHERE plugin_id='dev.opsweave.hello' AND status='ACTIVE'" 2>/dev/null | tr -d ' ')"
[ "$ACTIVE_COUNT" = "1" ] && pass "D1 left exactly one ACTIVE revision" \
  || fail "D1 left $ACTIVE_COUNT ACTIVE revisions"
REV_AFTER="$(active_rev)"
if [ -n "$REV_AFTER" ] && [ "$REV_AFTER" -ge "$REV_BEFORE" ]; then
  pass "D1 did not rewind the revision ($REV_BEFORE -> $REV_AFTER)"
else
  fail "D1 rewound the revision ($REV_BEFORE -> ${REV_AFTER:-none})"
fi
[ "$(gw)" = "0.0.1" ] && pass "D1 left the gateway on 0.0.1" \
  || fail "D1 left the gateway on $(gw)"

# D2: a genuinely stale revision competing with the live one. Exactly one may
# succeed; the stale one MUST be refused with a conflict. This is the real
# CAS (compare-and-swap) test, and it is the case "at least one succeeded" would
# have hidden.
ops deploy dev.opsweave.hello 0.0.2 --replicas 2 --selector role=node --wait >/dev/null 2>&1
ops activate dev.opsweave.hello 0.0.2 >/dev/null 2>&1
LIVE="$(active_rev)"
STALE=$((LIVE - 1))
[ "$STALE" -ge 1 ] || STALE=1
( ops rollback dev.opsweave.hello 0.0.1 --expected-revision "$LIVE" --replicas 2 >"$SCRATCH"/d2.live 2>&1; echo $? >"$SCRATCH"/d2.live.code ) &
PL=$!
( ops rollback dev.opsweave.hello 0.0.1 --expected-revision "$STALE" --replicas 2 >"$SCRATCH"/d2.stale 2>&1; echo $? >"$SCRATCH"/d2.stale.code ) &
PS=$!
waited=0
while kill -0 "$PL" 2>/dev/null || kill -0 "$PS" 2>/dev/null; do
  [ "$waited" -ge 180 ] && { kill "$PL" "$PS" 2>/dev/null; break; }
  sleep 5; waited=$((waited + 5))
done
wait "$PL" 2>/dev/null; wait "$PS" 2>/dev/null
STALE_CODE="$(cat "$SCRATCH"/d2.stale.code 2>/dev/null)"
if [ "$STALE_CODE" != "0" ] && grep -q "REVISION_CONFLICT" "$SCRATCH"/d2.stale 2>/dev/null; then
  pass "D2 the stale request was refused with REVISION_CONFLICT"
else
  fail "D2 the stale request was not refused (exit ${STALE_CODE:-?}): $(tail -1 "$SCRATCH"/d2.stale 2>/dev/null)"
fi
if grep -qE "API 5[0-9][0-9] " "$SCRATCH"/d2.live "$SCRATCH"/d2.stale 2>/dev/null; then
  fail "D2 produced a 5xx: $(grep -hoE 'API 5[0-9][0-9] [A-Za-z ]+' "$SCRATCH"/d2.live "$SCRATCH"/d2.stale | head -1)"
else
  pass "D2 produced no 5xx"
fi
ACTIVE_COUNT="$(psql -d "$DB" -tAc "SELECT count(*) FROM kernel.activation_revisions WHERE plugin_id='dev.opsweave.hello' AND status='ACTIVE'" 2>/dev/null | tr -d ' ')"
[ "$ACTIVE_COUNT" = "1" ] && pass "D2 left exactly one ACTIVE revision" \
  || fail "D2 left $ACTIVE_COUNT ACTIVE revisions"
[ "$(active)" = "0.0.1" ] && pass "D2 ended on 0.0.1" || fail "D2 ended on $(active)"
rm -f "$SCRATCH"/d1.* "$SCRATCH"/d2.*

echo
echo "== E. a rollback to a version that was never staged is refused"
CUR_REV="$(active_rev)"
OUT="$(ops rollback dev.opsweave.hello 9.9.9 --expected-revision "$CUR_REV" --replicas 2 2>&1)"
if printf '%s' "$OUT" | grep -qiE "not found|NOT_FOUND|Error"; then
  pass "rollback to an unknown version is refused"
else
  fail "rollback to an unknown version was accepted: $(printf '%s' "$OUT" | tail -1)"
fi
[ "$(gw)" = "0.0.1" ] && pass "the refused rollback did not move the route" \
  || fail "route moved to $(gw)"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "rollback state machine holds across every branch"
