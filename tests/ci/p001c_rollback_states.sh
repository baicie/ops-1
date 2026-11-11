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
cd "$ROOT"
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  echo "usage: $0 <run-id>" >&2
  exit 2
fi
DIR="/tmp/p001c-${RUN_ID}"
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
echo "== D. two simultaneous rollbacks: one wins, the other is a conflict, neither 500s"
ops deploy dev.opsweave.hello 0.0.2 --replicas 2 --selector role=node --wait >/dev/null 2>&1
ops activate dev.opsweave.hello 0.0.2 >/dev/null 2>&1
# Bounded: two concurrent redeploys of the same version can starve each other on
# a loaded host (observed 2026-11-11 - both sat at PREPARING 0/2 while the node
# logs showed instances cycling READY -> readiness timeout -> READY). The point
# of this case is the STATUS CODES, not how fast the containers settle, so give
# it a deadline instead of hanging the suite.
( ops rollback dev.opsweave.hello 0.0.1 --replicas 2 >/tmp/p001c11-rbA 2>&1; echo $? >/tmp/p001c11-rbA.code ) &
PA=$!
( ops rollback dev.opsweave.hello 0.0.1 --replicas 2 >/tmp/p001c11-rbB 2>&1; echo $? >/tmp/p001c11-rbB.code ) &
PB=$!
DEADLINE=180
WAITED=0
while kill -0 "$PA" 2>/dev/null || kill -0 "$PB" 2>/dev/null; do
  [ "$WAITED" -ge "$DEADLINE" ] && { kill "$PA" "$PB" 2>/dev/null; break; }
  sleep 5; WAITED=$((WAITED + 5))
done
wait "$PA" 2>/dev/null; wait "$PB" 2>/dev/null
if [ "$WAITED" -ge "$DEADLINE" ]; then
  fail "the concurrent pair did not settle within ${DEADLINE}s (both stalled at PREPARING)"
fi
A="$(cat /tmp/p001c11-rbA.code 2>/dev/null)"; B="$(cat /tmp/p001c11-rbB.code 2>/dev/null)"
if [ "$A" = "0" ] || [ "$B" = "0" ]; then
  pass "at least one of the two concurrent rollbacks succeeded"
else
  fail "neither concurrent rollback succeeded (A=$A B=$B)"
fi
# Match the CLI's own error prefix, not the digits "500" anywhere in the text -
# a container id or a timestamp can contain them and produce a false red.
for f in /tmp/p001c11-rbA /tmp/p001c11-rbB; do
  if grep -qE "API 5[0-9][0-9] " "$f" 2>/dev/null; then
    fail "a concurrent rollback returned a 5xx: $(grep -oE 'API 5[0-9][0-9] [A-Za-z ]+' "$f" | head -1)"
  fi
done
grep -qE "API 5[0-9][0-9] " /tmp/p001c11-rbA /tmp/p001c11-rbB 2>/dev/null \
  || pass "neither concurrent rollback returned a 5xx"
ACTIVE_COUNT="$(psql -d "$DB" -tAc "SELECT count(*) FROM kernel.activation_revisions WHERE plugin_id='dev.opsweave.hello' AND status='ACTIVE'" 2>/dev/null | tr -d ' ')"
[ "$ACTIVE_COUNT" = "1" ] && pass "exactly one ACTIVE revision remains" \
  || fail "$ACTIVE_COUNT ACTIVE revisions (must be exactly 1)"
if [ "$WAITED" -lt "$DEADLINE" ]; then
  [ "$(gw)" = "0.0.1" ] && pass "the concurrent pair left the gateway on 0.0.1" \
    || fail "gateway is $(gw) after the concurrent pair"
fi
rm -f /tmp/p001c11-rbA /tmp/p001c11-rbB /tmp/p001c11-rbA.code /tmp/p001c11-rbB.code

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
