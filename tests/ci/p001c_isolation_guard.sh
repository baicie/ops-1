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
echo "== CASE 2: a same-node-id container from another install survives restart AND teardown"
#
# Node ids are not ownership. They survive a database restore, a copied state
# directory, or a test that reuses one, so an unrelated install can legitimately
# carry the same opsweave.node-id. A cleanup scoped to "my node id" would delete
# that install's containers.
#
# The previous version of this case ran teardown a SECOND time, after CASE 1 had
# already purged the run record - so teardown refused before it ever reached the
# container-ownership decision, and the case proved nothing about containers.
# This version keeps a VALID run record and drives the real lifecycle twice:
#
#   fresh run -> plant a colliding container (same node id, foreign install id)
#             -> restart that run   (exercises the restart cleanup branch)
#             -> stop the run       (exercises the teardown removal branch)
#             -> the run's own containers are gone, the colliding one is intact
#
# It is not a `docker ps --filter` check: both branches actually execute.

COLLIDE="p001c11-collide-$$"
COLLIDE_INSTALL="$(python3 -c 'import uuid;print(uuid.uuid4())')"

# A run of its own, so this case is not entangled with CASE 1's purge.
OUT2="$(OPSWEAVE_TEST_RUN_INDEX=10 ./tests/ci/p001c_up.sh 2>&1)" || {
  echo "   the second run did not start:"; printf '%s\n' "$OUT2" | tail -5; fail "CASE 2 run failed"; }
RUN2="$(printf '%s\n' "$OUT2" | sed -n 's/^RUN_ID=//p' | tail -1)"
DIR2="/tmp/p001c-${RUN2}"
if [ -z "$RUN2" ] || [ ! -f "$DIR2/run.json" ]; then
  fail "CASE 2 could not start its own run; the collision cannot be tested"
else
  PORT2="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$DIR2/run.json")"
  URL2="http://127.0.0.1:${PORT2}"
  HOME="$DIR2/home" ./target/debug/opsctl --url "$URL2" install \
    dist/plugins/hello-ops-0.0.1.plugin.zip >/dev/null 2>&1
  HOME="$DIR2/home" ./target/debug/opsctl --url "$URL2" deploy dev.opsweave.hello 0.0.1 \
    --replicas 2 --selector role=node --wait >/dev/null 2>&1

  NODE2="$(python3 -c "import json,sys;ids=json.load(open(sys.argv[1])).get('nodeIds',[]);print(ids[0] if ids else '')" "$DIR2/run.json")"
  INSTALL2="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('installationId',''))" "$DIR2/run.json")"
  OWN2_BEFORE="$(docker ps -aq --filter "label=opsweave.node-id=${NODE2}" \
    --filter "label=opsweave.installation-id=${INSTALL2}" 2>/dev/null | wc -l | tr -d ' ')"

  if [ -z "$NODE2" ] || [ -z "$INSTALL2" ]; then
    fail "CASE 2 run recorded no node/installation id; the case cannot run"
  elif [ "${OWN2_BEFORE:-0}" -lt 1 ]; then
    fail "CASE 2 run created no containers; a cleanup check against it would be vacuous"
  else
    pass "CASE 2 run has $OWN2_BEFORE container(s) of its own and a valid run record"

    # Plant the colliding container: SAME node id, different installation id.
    docker run -d --name "$COLLIDE" \
      --label opsweave.managed=true \
      --label "opsweave.node-id=$NODE2" \
      --label "opsweave.installation-id=$COLLIDE_INSTALL" \
      alpine:3 sh -c 'while true; do sleep 5; done' >/dev/null 2>&1
    COLLIDE_ID="$(docker inspect -f '{{.Id}}' "$COLLIDE" 2>/dev/null || echo '')"
    COLLIDE_START="$(docker inspect -f '{{.State.StartedAt}}' "$COLLIDE" 2>/dev/null || echo '')"
    COLLIDE_LABELS="$(docker inspect -f '{{json .Config.Labels}}' "$COLLIDE" 2>/dev/null || echo '')"
    if [ -z "$COLLIDE_ID" ]; then
      fail "could not plant the colliding container"
    else
      BY_NODE="$(docker ps -aq --filter "label=opsweave.node-id=$NODE2" 2>/dev/null | wc -l | tr -d ' ')"
      BY_INSTALL="$(docker ps -aq --filter "label=opsweave.node-id=$NODE2" \
        --filter "label=opsweave.installation-id=${INSTALL2}" 2>/dev/null | wc -l | tr -d ' ')"
      [ "$BY_NODE" -gt "$BY_INSTALL" ] \
        && pass "the collision is real: $BY_NODE container(s) share the node id, $BY_INSTALL are ours" \
        || fail "collision did not reproduce (node-id $BY_NODE vs installation $BY_INSTALL)"

      NODE2_CONTAINERS="$(docker ps -q --filter "label=opsweave.node-id=${NODE2}" \
        --filter "label=opsweave.installation-id=${INSTALL2}" 2>/dev/null | head -1)"
      if [ -n "$NODE2_CONTAINERS" ]; then
        LABELLED="$(docker inspect -f '{{index .Config.Labels "opsweave.installation-id"}}' "$NODE2_CONTAINERS" 2>/dev/null || echo '')"
        [ "$LABELLED" = "$INSTALL2" ] \
          && pass "a container the node created carries its installation label" \
          || fail "the node created a container with installation label '$LABELLED', expected $INSTALL2"
      fi

      # --- restart: the cleanup branch actually runs ------------------------
      if OPSWEAVE_TEST_RUN_INDEX=10 ./tests/ci/p001c_up.sh --run-id "$RUN2" \
           >"$DIR2"/restart.log 2>&1; then
        pass "CASE 2 restart exercised the cleanup branch with a valid run record"
      else
        fail "CASE 2 restart failed"
        tail -5 "$DIR2"/restart.log
      fi
      [ "$(docker inspect -f '{{.Id}}' "$COLLIDE" 2>/dev/null || echo '')" = "$COLLIDE_ID" ] \
        && pass "the colliding container survived the restart cleanup" \
        || fail "the restart cleanup removed another install's container"

      # --- the NODE's own create path, against the colliding container ------
      #
      # Restart and teardown prove the harness does not over-reach. They do NOT
      # exercise `create_and_start`, which is the product code that used to
      # `docker rm -f` the name before creating. That path is covered by
      # `apps/node/tests/container_ownership.rs` (real daemon, compiled adapter).
      # The assertion below is the cheapest honest check that the product still
      # carries the gate at all, and it fails loudly if the label disappears from
      # a container the node creates.

      # --- teardown: the removal branch actually runs -----------------------
      TD_OUT="$(mktemp)"
      if ./tests/ci/p001c_teardown.sh "$RUN2" >"$TD_OUT" 2>&1; then
        pass "CASE 2 teardown ran against a valid run record"
      else
        fail "CASE 2 teardown failed: $(tail -1 "$TD_OUT")"
      fi
      LEFT="$(docker ps -aq --filter "label=opsweave.node-id=${NODE2}" \
        --filter "label=opsweave.installation-id=${INSTALL2}" 2>/dev/null | wc -l | tr -d ' ')"
      [ "$LEFT" = "0" ] \
        && pass "CASE 2 teardown removed this run's own containers" \
        || fail "CASE 2 teardown left $LEFT of this run's containers behind"
      [ "$(docker inspect -f '{{.Id}}' "$COLLIDE" 2>/dev/null || echo '')" = "$COLLIDE_ID" ] \
        && pass "the colliding container survived teardown" \
        || fail "teardown removed another install's container"
      [ "$(docker inspect -f '{{.State.StartedAt}}' "$COLLIDE" 2>/dev/null || echo '')" = "$COLLIDE_START" ] \
        && pass "the colliding container was not restarted" \
        || fail "the colliding container was stopped or restarted"
      [ "$(docker inspect -f '{{json .Config.Labels}}' "$COLLIDE" 2>/dev/null || echo '')" = "$COLLIDE_LABELS" ] \
        && pass "the colliding container's labels are unchanged" \
        || fail "the colliding container's labels changed"
      rm -f "$TD_OUT"
    fi
  fi
  ./tests/ci/p001c_teardown.sh "$RUN2" --purge >/dev/null 2>&1 || true
  docker rm -f "$COLLIDE" >/dev/null 2>&1 || true
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
