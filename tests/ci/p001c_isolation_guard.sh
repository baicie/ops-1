#!/usr/bin/env bash
# P001-C1.1 Phase 1 counterfactual: the harness must not touch a foreign
# OpsWeave installation that shares the Docker daemon.
#
# This is the assertion the old `docker ps -aq --filter label=opsweave.managed=true
# | xargs -r docker rm -f` could not pass. It is written as an attack on our own
# harness rather than as a happy-path check: it plants a container that looks
# exactly like something we might want to clean up, runs the full start/teardown
# cycle around it, and requires it to be untouched.
#
# Planted "other installation":
#   * labelled opsweave.managed=true          (the label the old sweep matched)
#   * labelled opsweave.node-id=<foreign>     (structurally identical to ours)
#   * a real running container with state
#
# It must survive: not stopped, not removed, not restarted, no label or config
# change. A second case plants a container whose node-id EQUALS a would-be run's
# and proves the ownership check refuses rather than deleting.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

FOREIGN="p001c11-foreign-$$"
FOREIGN_NODE="00000000-0000-4000-8000-$(printf '%012d' $$)"
cleanup_foreign() { docker rm -f "$FOREIGN" >/dev/null 2>&1 || true; }
trap cleanup_foreign EXIT

echo
echo "== CASE 1: a run with REAL containers cleans up only its own"
FOREIGN_NODE="00000000-0000-4000-8000-$(printf '%012d' $$)"
docker run -d --name "$FOREIGN" \
  --label opsweave.managed=true \
  --label "opsweave.node-id=$FOREIGN_NODE" \
  --label opsweave.plugin-id=dev.opsweave.foreign \
  alpine:3 sh -c 'while true; do sleep 5; done' >/dev/null 2>&1 || {
    echo "could not plant the foreign container; this check would be vacuous" >&2; exit 1; }
FOREIGN_ID="$(docker inspect -f '{{.Id}}' "$FOREIGN" 2>/dev/null || echo '')"
FOREIGN_START="$(docker inspect -f '{{.State.StartedAt}}' "$FOREIGN" 2>/dev/null || echo '')"
[ -n "$FOREIGN_ID" ] || { echo "foreign container did not start" >&2; exit 1; }
echo "   planted $FOREIGN (node-id $FOREIGN_NODE)"

OUT="$(OPSWEAVE_TEST_RUN_INDEX=9 ./tests/ci/p001c_up.sh 2>&1)" || {
  echo "   the run did not start:"; printf '%s\n' "$OUT" | tail -5; exit 1; }
RUN_ID="$(printf '%s\n' "$OUT" | sed -n 's/^RUN_ID=//p' | tail -1)"
DIR="/tmp/p001c-${RUN_ID}"
[ -n "$RUN_ID" ] || { echo "no RUN_ID printed" >&2; exit 1; }

PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$DIR/run.json")"
URL="http://127.0.0.1:${PORT}"

# A run with no containers proves nothing about a sweep. Deploy a real plugin.
HOME="$DIR/home" ./target/debug/opsctl --url "$URL" install \
  dist/plugins/hello-ops-0.0.1.plugin.zip >/dev/null 2>&1
HOME="$DIR/home" ./target/debug/opsctl --url "$URL" deploy dev.opsweave.hello 0.0.1 \
  --replicas 2 --selector role=node --wait >/dev/null 2>&1

OWN="$(python3 - "$DIR/run.json" <<'PY'
import json, subprocess, sys
ids = json.load(open(sys.argv[1])).get("nodeIds", [])
total = 0
for nid in ids:
    out = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=opsweave.node-id={nid}"],
                         capture_output=True, text=True).stdout.split()
    total += len(out)
print(total)
PY
)"
if [ "${OWN:-0}" -ge 1 ]; then
  pass "the run created $OWN container(s) of its own"
else
  fail "the run created no containers; a cleanup check against it would be vacuous"
fi

# RESTART the same run. This is the step that matters and the one an earlier
# version of this guard was missing: the cleanup branch only executes when a run
# record already exists, so a first-start test never reaches it. That is exactly
# how this guard once passed while the global `opsweave.managed=true` sweep was
# still in the script.
if OPSWEAVE_TEST_RUN_INDEX=9 ./tests/ci/p001c_up.sh --run-id "$RUN_ID" >"$DIR"/restart.log 2>&1; then
  pass "restarting the same run exercised the cleanup branch"
else
  fail "restarting the same run failed"
  tail -5 "$DIR"/restart.log
fi

# Capture the node ids BEFORE teardown. `--purge` deletes the state dir, so
# reading run.json afterwards always found nothing and printed 0 - a green
# "own containers removed" no matter what teardown had actually done.
OWN_NODES="$(python3 -c "import json,sys;print(' '.join(json.load(open(sys.argv[1])).get('nodeIds',[])))" "$DIR/run.json")"
[ -n "$OWN_NODES" ] || { echo "no node ids recorded; this check would be vacuous" >&2; exit 1; }

TEARDOWN_OUT="$(./tests/ci/p001c_teardown.sh "$RUN_ID" --purge 2>&1)"
TEARDOWN_CODE=$?
if [ "$TEARDOWN_CODE" -eq 0 ]; then
  pass "teardown exited 0"
else
  fail "teardown exited $TEARDOWN_CODE: $(printf '%s' "$TEARDOWN_OUT" | tail -1)"
fi

# Query docker directly with the ids captured above, not through the file that
# teardown just deleted.
own_left=0
for nid in $OWN_NODES; do
  n="$(docker ps -aq --filter "label=opsweave.node-id=${nid}" --filter "label=opsweave.test-run=${RUN_ID}" 2>/dev/null | wc -l | tr -d ' ')"
  own_left=$((own_left + n))
done
[ "$own_left" = "0" ] \
  && pass "none of this run's containers remain" \
  || fail "the run left $own_left of its own containers behind"

AFTER_ID="$(docker inspect -f '{{.Id}}' "$FOREIGN" 2>/dev/null || echo '')"
AFTER_START="$(docker inspect -f '{{.State.StartedAt}}' "$FOREIGN" 2>/dev/null || echo '')"
[ "$AFTER_ID" = "$FOREIGN_ID" ] \
  && pass "the foreign container still exists, same id" \
  || fail "the foreign container was removed"
[ "$AFTER_START" = "$FOREIGN_START" ] \
  && pass "the foreign container was not restarted" \
  || fail "the foreign container was stopped or restarted"

echo
echo "== CASE 2: a container sharing our node-id but NOT our run label survives"
#
# Node ids are not ownership. They survive a database restore, a copied state
# directory, or a test that reuses one, so an unrelated install can legitimately
# carry the same opsweave.node-id. A cleanup scoped to "my node id" would delete
# that install's containers - which is exactly what the first version of this
# harness did, and what this case exists to catch.
COLLIDE="p001c11-collide-$$"
COLLIDE_NODE="$(printf '%s' "$OWN_NODES" | awk '{print $1}')"
if [ -z "$COLLIDE_NODE" ]; then
  fail "no node id captured; the collision case cannot run"
else
  # Same node-id as ours, deliberately WITHOUT opsweave.test-run=$RUN_ID.
  docker run -d --name "$COLLIDE" \
    --label opsweave.managed=true \
    --label "opsweave.node-id=$COLLIDE_NODE" \
    alpine:3 sh -c 'while true; do sleep 5; done' >/dev/null 2>&1
  CID="$(docker inspect -f '{{.Id}}' "$COLLIDE" 2>/dev/null || echo '')"
  if [ -z "$CID" ]; then
    fail "could not plant the colliding container"
  else
    # It must match the node-id filter (proving the collision is real) and must
    # NOT match the dual filter (proving the run label is what disambiguates).
    BY_NODE="$(docker ps -aq --filter "label=opsweave.node-id=$COLLIDE_NODE" 2>/dev/null | wc -l | tr -d ' ')"
    BY_BOTH="$(docker ps -aq --filter "label=opsweave.node-id=$COLLIDE_NODE" \
      --filter "label=opsweave.test-run=${RUN_ID}" 2>/dev/null | wc -l | tr -d ' ')"
    [ "$BY_NODE" -ge 1 ] \
      && pass "the collision is real: $BY_NODE container(s) answer to node-id $COLLIDE_NODE alone" \
      || fail "collision did not reproduce (node-id matched $BY_NODE)"
    [ "$BY_BOTH" = "0" ] \
      && pass "the dual filter excludes it ($BY_BOTH matched)" \
      || fail "the dual filter still matched $BY_BOTH colliding container(s)"

    # Teardown already ran in CASE 1; the colliding container did not exist then.
    # Run it again: with the run record gone it must refuse, and either way the
    # colliding container must survive an attempted cleanup.
    # Not under $DIR: CASE 1's --purge already deleted it, so writing there would
    # fail and the grep below would read a file that never existed.
    COLLIDE_OUT="$(mktemp)"
    ./tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$COLLIDE_OUT" 2>&1
    COLLIDE_CODE=$?
    [ "$COLLIDE_CODE" -ne 0 ] \
      && pass "teardown refuses once the run record is gone (exit $COLLIDE_CODE)" \
      || fail "teardown succeeded with no run record; it cannot prove ownership"
    grep -q BLOCKED "$COLLIDE_OUT" \
      && pass "the refusal is reported as BLOCKED" \
      || fail "the refusal did not say BLOCKED"
    [ "$(docker inspect -f '{{.Id}}' "$COLLIDE" 2>/dev/null || echo '')" = "$CID" ] \
      && pass "the colliding container survived the attempted cleanup" \
      || fail "the colliding container was removed"
    rm -f "$COLLIDE_OUT"
    docker rm -f "$COLLIDE" >/dev/null 2>&1 || true
  fi
fi

echo
echo "== CASE 3: a teardown that cannot identify its target refuses to act"
BAD="nonexistent-run-id-$$"
BAD_OUT="$(mktemp)"
if ./tests/ci/p001c_teardown.sh "$BAD" --purge >"$BAD_OUT" 2>&1; then
  fail "teardown accepted a run id with no run record"
else
  grep -q BLOCKED "$BAD_OUT" && pass "teardown refuses an unknown run and says BLOCKED" \
    || fail "teardown refused but did not report BLOCKED: $(head -1 "$BAD_OUT")"
fi
rm -f "$BAD_OUT"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "test harness does not reach outside its own run"
