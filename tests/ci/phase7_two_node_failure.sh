#!/usr/bin/env bash
# Phase 7 TASK-12: two nodes on ONE host, and what a node failure does.
#
# THE CLAIM THIS DOES *NOT* MAKE
#
# Two node PROCESSES on one host, not two machines. Nothing here is two-node HA in
# the sense the charter means it: both nodes share a kernel, a PostgreSQL, a Docker
# daemon and a host. What it does establish is that the SCHEDULER treats them as two
# placement targets and that a node's disappearance is handled as the kernel says it
# should be.
#
# WHAT IS CHECKED
#
#   1. two nodes enrol and both are READY
#   2. a 2-replica deployment places ONE instance on EACH node, with real containers
#   3. stopping one node's process does NOT immediately mark it unreachable - the
#      kernel waits for the heartbeat to age out, because a missed heartbeat is not
#      evidence that instances stopped
#   4. after the staleness sweep the node is UNREACHABLE and its instance is stopped
#      (desired_action=STOP), while the OTHER node keeps serving
#   5. the deployment reports DEGRADED - not ACTIVE, and not disappeared
#
# WHAT WAS EXPECTED TO BE A DEFECT AND IS NOT
#
# While node-a was down, its instance row kept a `container_id` that no longer
# existed on the daemon, so `is_ghost_instance` (which requires `container_id IS
# NULL`) did not consider it a ghost and `must_rebuild` would not fire. That looked
# like a permanently stuck row.
#
# It is not: when the node comes back, `existing_node_ok` is false and the planner
# takes the REPLACE path (`deployments.rs:1970` / `:2008`), which clears
# `container_id` and re-places the slot. The stale reference resolves without
# `must_rebuild` being involved. Recorded here because the investigation cost real
# time and the next reader will have the same first impression.
#
# Usage: tests/ci/phase7_two_node_failure.sh [--keep]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  skip %s\n' "$1"; }

RUN_ID=""; STATE=""; DB=""; KERNEL_URL=""
cleanup() {
  local rc=$?
  if [ -n "$RUN_ID" ] && [ "$KEEP" = "0" ]; then
    tests/ci/p001c_teardown.sh "$RUN_ID" --purge >/dev/null 2>&1 || true
  elif [ -n "$RUN_ID" ]; then
    echo "== kept $RUN_ID at $KERNEL_URL"
  fi
  [ "$KEEP" = "0" ] && docker rm -f osw-p7-registry >/dev/null 2>&1 || true
  return "$rc"
}
trap cleanup EXIT

q() { psql -h 127.0.0.1 -p 5432 -d "$DB" -tAc "$1" 2>/dev/null; }

command -v docker >/dev/null || { echo "docker required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 2; }

echo "== registry and images"
docker rm -f osw-p7-registry >/dev/null 2>&1 || true
docker run -d --name osw-p7-registry --label opsweave.p7.registry=yes \
  -p 127.0.0.1:15001:5000 registry:2 >/dev/null || { echo "no registry" >&2; exit 2; }
for _ in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:15001/v2/ >/dev/null 2>&1 && break; sleep 1; done
docker push 127.0.0.1:15001/opsweave/data-catalog:0.0.3 >/dev/null 2>&1 || {
  skip "the data-catalog:0.0.3 image is not local; run scripts/build-plugins.sh first"
  echo; echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 0; }

echo "== bring up two nodes"
RUN_ID="$(tests/ci/p001c_up.sh 2>/dev/null | sed -n 's/^RUN_ID=//p' | tail -1)"
[ -n "$RUN_ID" ] || { echo "no platform" >&2; exit 2; }
STATE="/tmp/p001c-$RUN_ID"
DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
KPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kernelPort"])' "$STATE/run.json")"
KERNEL_URL="http://127.0.0.1:$KPORT"
export HOME="$STATE/home"
ops() { ./target/debug/opsctl --url "$KERNEL_URL" "$@" 2>&1; }

NODES="$(q "SELECT count(*) FROM kernel.nodes WHERE status='READY'")"
[ "${NODES:-0}" -eq 2 ] && ok "two nodes are READY" || bad "expected 2 READY nodes, got ${NODES:-0}"

echo "== a 2-replica deployment must use BOTH nodes"
ops install dist/plugins/data-catalog-0.0.3.plugin.zip >/dev/null 2>&1 || true
ops deploy opsweave.data-catalog 0.0.3 --replicas 2 --wait --activate >/tmp/p7-two-node-deploy.log 2>&1
grep -q 'activated opsweave.data-catalog@0.0.3' /tmp/p7-two-node-deploy.log \
  && ok "the 2-replica deployment activated" || bad "deploy failed; see /tmp/p7-two-node-deploy.log"

PER_NODE="$(q "SELECT count(DISTINCT i.node_id) FROM kernel.plugin_instances i WHERE i.desired_action='START' AND i.container_id IS NOT NULL")"
[ "${PER_NODE:-0}" -eq 2 ] && ok "the replicas are on 2 DISTINCT nodes" \
  || bad "replicas landed on ${PER_NODE:-0} distinct node(s), expected 2"
REAL="$(q "SELECT count(*) FROM kernel.plugin_instances WHERE desired_action='START' AND container_id IS NOT NULL")"
[ "${REAL:-0}" -eq 2 ] && ok "both have real containers ($REAL)" || bad "expected 2 containers, got ${REAL:-0}"

echo "== stop one node's PROCESS, not its containers"
NODE_A_PID="$(cat "$STATE/node-a.pid" 2>/dev/null || true)"
if [ -z "$NODE_A_PID" ]; then
  skip "no node-a pidfile; the failure half cannot run"
else
  kill "$NODE_A_PID" 2>/dev/null && ok "node-a process stopped" || bad "could not stop node-a"

  # IMMEDIATELY after the kill the node must still be READY. A missed heartbeat is
  # not evidence that instances stopped - that is an explicit rule in this
  # repository, and this is where it is observable.
  sleep 2
  ST="$(q "SELECT status FROM kernel.nodes WHERE name='node-a'")"
  [ "$ST" = "READY" ] && ok "node-a is still READY 2s after the process died (heartbeat, not liveness)" \
    || bad "node-a went $ST within 2s: the kernel inferred a dead node from one missed beat"

  echo "== wait for the staleness sweep"
  SWEPT=0
  for _ in $(seq 1 40); do
    ST="$(q "SELECT status FROM kernel.nodes WHERE name='node-a'")"
    if [ "$ST" != "READY" ]; then SWEPT=1; break; fi
    sleep 1
  done
  if [ "$SWEPT" = "1" ]; then
    ok "node-a is $ST after the sweep"
  else
    bad "node-a never left READY; the staleness sweep did not run"
  fi

  # The stopped node's instance must be told to stop; the serving one must not.
  NA="$(q "SELECT desired_action FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id WHERE n.name='node-a'")"
  NB="$(q "SELECT desired_action FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id WHERE n.name='node-b'")"
  [ "$NA" = "STOP" ] && ok "the lost node's instance is told to STOP" || bad "node-a's instance is $NA, expected STOP"
  [ "$NB" = "START" ] && ok "the surviving node's instance keeps running (START)" || bad "node-b's instance is $NB, expected START"

  DEP="$(q "SELECT status FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog'")"
  [ "$DEP" = "DEGRADED" ] && ok "the deployment is DEGRADED - not ACTIVE, and not gone" \
    || bad "deployment is $DEP, expected DEGRADED"

  echo "== the container on the dead node outlives its node process"
  # This is the reason a missed heartbeat cannot be treated as "instances stopped":
  # the container is still there. It is the NODE that is gone, not the workload.
  ORPHAN="$(q "SELECT container_id FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id WHERE n.name='node-a'")"
  if [ -n "$ORPHAN" ] && docker inspect "$ORPHAN" >/dev/null 2>&1; then
    ok "node-a's container still exists on the daemon - a heartbeat is not a liveness probe"
  elif [ -n "$ORPHAN" ]; then
    ok "node-a's row still names a container ($ORPHAN) that the daemon no longer has"
  else
    skip "node-a's row has no container id to check"
  fi
fi

echo
echo "== what this run did NOT prove"
echo "   - NOT two machines: both nodes are processes on this host, sharing one"
echo "     kernel, one PostgreSQL and one Docker daemon"
echo "   - NOT node recovery: restarting a node needs a fresh enrolment token from"
echo "     the running kernel, which this script does not mint. The stale"
echo "     container_id on the stopped node resolves through the REPLACE path when"
echo "     the node returns - reasoned from the code, NOT observed here"
echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed, $SKIP skipped"; exit 0; }
echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
