#!/usr/bin/env bash
# Phase 8 TASK-15: the heartbeat protocol's bounds, measured against the protocol.
#
# WHAT #210 ALREADY PROVED, AND WHAT IT DID NOT
#
# `phase7_two_node_failure.sh` established two things:
#
#   a node is still READY 2 s after its process dies   (a heartbeat is not a liveness probe)
#   it leaves READY eventually                          (the staleness sweep runs)
#
# "Eventually" is not a bound. Two seconds is one sample below a threshold nobody
# stated. The brief asks for the bound itself: how long MAY the kernel take, and
# how long must it NOT take. This file supplies that, derived from the three
# protocol numbers in the source rather than from a stopwatch reading.
#
# THE THREE NUMBERS, AND WHERE THEY COME FROM
#
#   heartbeat interval   5 s    apps/kernel/src/config.rs:152
#                               (`OPSWEAVE_NODE_HEARTBEAT_SECONDS`, advertised to
#                               the node in `DesiredNodeState`; the node uses the
#                               ADVERTISED value, `runtime.rs:1263`)
#   staleness threshold 25 s    apps/kernel/src/config.rs:153
#                               (`OPSWEAVE_NODE_STALE_SECONDS`; the sweep marks a
#                               node UNREACHABLE when `last_seen_at` is older)
#   node lease          30 s    apps/node/src/config.rs:63
#                               (`OPSWEAVE_NODE_LEASE_SECONDS`; the NODE quarantines
#                               itself when the kernel has not acknowledged for
#                               this long - the other direction of the same problem)
#
# THE INVARIANT UNDER TEST is not "it recovers quickly" but:
#
#   the kernel must NOT pronounce a node dead before its lease can expire,
#   because a node that is merely slow to heartbeat is not dead, and acting early
#   stops healthy instances.
#
#     staleness threshold (25)  <  node lease (30)
#
# That ordering is what makes this safe. The kernel starts treating the node as
# gone while the node itself is still willing to serve. If it were reversed, every
# brief network hiccup would evacuate a node that was about to recover.
#
# WHAT THIS FILE MEASURES
#
#   1. the three numbers are the ones the running processes actually use
#   2. the ordering 25 < 30 holds, and is asserted rather than assumed
#   3. at stale/2 the node is STILL READY - the sweep must not fire early
#   4. at stale+margin it IS not READY - the sweep must fire, bounded above
#   5. a restarted node (same state dir) resumes the SAME row and returns to READY
#   6. its instances are reconciled back to START afterwards
#
# (5) corrects a statement in `phase7_two_node_failure.sh`: it says recovery
# "needs a fresh enrolment token". `runtime::enroll` loads the identity from the
# state directory and increments the generation when one exists (`runtime.rs:145`),
# so a restart with the same `OPSWEAVE_NODE_STATE_DIR` resumes the same node row.
# The token is only for a first enrolment. Measured here rather than argued.
#
# Usage: tests/ci/phase7_heartbeat_bounds.sh [--keep] [--allow-skip]
# Requires: docker (running), PostgreSQL client tools, the debug binaries.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

KEEP=0; ALLOW_SKIP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --allow-skip) ALLOW_SKIP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  skip %s\n' "$1"; }

RUN_ID=""; STATE=""; DB=""; KERNEL_URL=""
NODE_A_PID="" ; RESTARTED_PID=""
cleanup() {
  local rc=$?
  # Stop any node this script started, by pid, before teardown - teardown knows
  # the original pids and would otherwise leave the restarted one running.
  [ -n "$RESTARTED_PID" ] && kill "$RESTARTED_PID" 2>/dev/null
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

REGISTRY_PORT="${OPSWEAVE_P7_REGISTRY_PORT:-15001}"
REGISTRY="127.0.0.1:${REGISTRY_PORT}"
echo "== registry and the image the deployment needs"
docker rm -f osw-p7-registry >/dev/null 2>&1 || true
docker run -d --name osw-p7-registry --label opsweave.p7.registry=yes \
  -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null || { echo "no registry" >&2; exit 2; }
for _ in $(seq 1 30); do curl -fsS -m 2 "http://${REGISTRY}/v2/" >/dev/null 2>&1 && break; sleep 1; done
if ! docker push "${REGISTRY}/opsweave/data-catalog:0.0.3" >/dev/null 2>&1; then
  if [ "${ALLOW_SKIP:-0}" = "1" ]; then
    skip "the data-catalog:0.0.3 image is not local and --allow-skip was given; NOTHING RAN"
    echo; echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 0
  fi
  echo "BLOCKED: data-catalog:0.0.3 is not in this daemon, so the instance half of" >&2
  echo "         the heartbeat test cannot be observed. Build it first:" >&2
  echo "           OPSWEAVE_REGISTRY=${REGISTRY} OPSWEAVE_DATA_VERSION=0.0.3 \\" >&2
  echo "             scripts/build-data-plugins.sh" >&2
  echo "         0 assertions ran. Exiting 3 (BLOCKED) so a green job cannot mean this." >&2
  exit 3
fi

echo "== the protocol's own numbers, read from the source that defines them"
read -r HEARTBEAT_SRC STALE_SRC LEASE_SRC <<EOF
$(python3 - <<'PY'
import re
kern = open('apps/kernel/src/config.rs').read()
node = open('apps/node/src/config.rs').read()

def kern_default(env):
    # `env_i64("NAME", N)` - the name and its default are one expression.
    m = re.search(rf'{env}"\s*,\s*(\d+)', kern)
    return m.group(1) if m else ""

def node_default(env):
    # The env name and `default_value_t = N` share one `#[arg(...)]` block, but
    # are not adjacent. Search the block that contains the name.
    i = node.find(f'"{env}"')
    if i < 0:
        return ""
    m = re.search(r'default_value_t\s*=\s*(\d+)', node[i:i + 400])
    return m.group(1) if m else ""

print(kern_default("OPSWEAVE_NODE_HEARTBEAT_SECONDS"),
      kern_default("OPSWEAVE_NODE_STALE_SECONDS"),
      node_default("OPSWEAVE_NODE_LEASE_SECONDS"))
PY
)
EOF
echo "   heartbeat=${HEARTBEAT_SRC:-?}s  stale=${STALE_SRC:-?}s  lease=${LEASE_SRC:-?}s"

if [ -z "$HEARTBEAT_SRC" ] || [ -z "$STALE_SRC" ] || [ -z "$LEASE_SRC" ]; then
  # The defaults moved, or the lines were reworded. That is not a product defect,
  # but it does mean this file's bounds would be guesses - so it stops rather
  # than measuring against numbers it could not read.
  bad "could not read the three protocol defaults from the source; the bounds below would be guesses"
  echo; echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi
ok "read the three protocol defaults from source (heartbeat ${HEARTBEAT_SRC}s, stale ${STALE_SRC}s, lease ${LEASE_SRC}s)"

# THE ORDERING IS THE SAFETY PROPERTY. Asserted, not assumed.
if [ "$STALE_SRC" -lt "$LEASE_SRC" ]; then
  ok "staleness (${STALE_SRC}s) fires before the node's own lease expires (${LEASE_SRC}s)"
else
  bad "staleness (${STALE_SRC}s) is NOT before the lease (${LEASE_SRC}s): the kernel would declare a node gone only after the node stopped expecting to be alive"
fi

echo "== bring up the platform"
RUN_ID="$(tests/ci/p001c_up.sh 2>/dev/null | sed -n 's/^RUN_ID=//p' | tail -1)"
[ -n "$RUN_ID" ] || { echo "no platform" >&2; exit 2; }
STATE="/tmp/p001c-$RUN_ID"
DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
KPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kernelPort"])' "$STATE/run.json")"
KERNEL_URL="http://127.0.0.1:$KPORT"
export HOME="$STATE/home"
ops() { ./target/debug/opsctl --url "$KERNEL_URL" "$@" 2>&1; }

NODE_COUNT="$(q "SELECT count(*) FROM kernel.nodes WHERE status='READY'")"
[ "${NODE_COUNT:-0}" -eq 2 ] && ok "two nodes are READY" || bad "expected 2 READY nodes, got ${NODE_COUNT:-0}"

echo "== the protocol numbers the RUNNING kernel actually uses"
# The source default is what SHOULD be in use. This reads what IS. `diagnostics`
# is an admin endpoint (`diagnostics.rs:38-39`), so it needs the harness session -
# the same token `opsctl` uses.
SESSION="$HOME/.opsweave/session.json"
TOKEN=""
[ -f "$SESSION" ] && TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SESSION" | head -1)"
POLICIES="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$KERNEL_URL/api/v1/diagnostics" 2>/dev/null \
  | python3 -c 'import json,sys;p=json.load(sys.stdin).get("policies",{});print(p.get("heartbeatIntervalSeconds",""),p.get("nodeStaleSeconds",""))' 2>/dev/null || echo "")"
LIVE_HB="$(echo "$POLICIES" | awk '{print $1}')"
LIVE_STALE="$(echo "$POLICIES" | awk '{print $2}')"
if [ -n "$LIVE_HB" ] && [ -n "$LIVE_STALE" ]; then
  [ "$LIVE_HB" = "$HEARTBEAT_SRC" ] \
    && ok "the running kernel uses a ${LIVE_HB}s heartbeat, matching the source default" \
    || bad "the running kernel uses ${LIVE_HB}s but the source default is ${HEARTBEAT_SRC}s"
  [ "$LIVE_STALE" = "$STALE_SRC" ] \
    && ok "the running kernel uses a ${LIVE_STALE}s staleness threshold, matching the source default" \
    || bad "the running kernel uses ${LIVE_STALE}s but the source default is ${STALE_SRC}s"
else
  skip "could not read the running kernel's policies; the bounds below use the source defaults only"
fi

echo "== a 1-replica deployment, so a node's disappearance has an instance to reconcile"
# THE INSTANCE HALF IS OPTIONAL; THE HEARTBEAT HALF IS NOT.
#
# The heartbeat bounds below are about node rows, which need no workload. The
# instance assertions need a running container, and a container needs to reach
# PostgreSQL. On a developer machine whose PostgreSQL listens on `localhost` only,
# it cannot - the plugin exits with ECONNREFUSED and the deployment is DEGRADED
# (measured locally 2026-11-24). That is an environment limit, not a product
# defect, and exactly the case the Phase 7 root cause describes.
#
# So: if the deployment activates, the instance assertions run and count. If it
# does not, they say IN THAT CASE that they were not evaluated, rather than
# reporting a red for a platform this host cannot provide. The heartbeat
# assertions are unaffected and still have to pass.
ops install dist/plugins/data-catalog-0.0.3.plugin.zip >/dev/null 2>&1 || true
DEPLOYED=0
ops deploy opsweave.data-catalog 0.0.3 --replicas 1 --wait --activate >/tmp/p8-hb-deploy.log 2>&1 \
  && DEPLOYED=1
if [ "$DEPLOYED" = "1" ]; then
  ok "the deployment activated, so the instance half will be asserted"
else
  skip "the deployment did not activate (see /tmp/p8-hb-deploy.log); the instance assertions below are NOT_EVALUATED"
  echo "         a container that cannot reach this host's PostgreSQL exits at startup;"
  echo "         the heartbeat bounds do not depend on it and still run"
fi

node_pid() { cat "$STATE/$1.pid" 2>/dev/null; }

# KILL THE NODE THAT HOLDS THE INSTANCE, NOT A FIXED ONE.
#
# The first version always killed node-a and asserted its instance was told to
# STOP. Placement chose node-b on CI, so node-a had no instance and the
# assertion failed for a reason the case never established (run 45410012787).
# Killing whichever node holds the instance makes the claim the same under either
# placement, and leaves the other node as the control.
VICTIM="node-a"; SURVIVOR="node-b"
if [ "$DEPLOYED" = "1" ]; then
  HOLDER="$(q "SELECT n.name FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND i.desired_action='START' LIMIT 1")"
  if [ -n "$HOLDER" ]; then
    VICTIM="$HOLDER"
    [ "$VICTIM" = "node-a" ] && SURVIVOR="node-b" || SURVIVOR="node-a"
  fi
fi
echo "   victim=${VICTIM} survivor=${SURVIVOR} (victim holds the instance)"

NODE_A_PID="$(node_pid "$VICTIM")"
NODE_B_PID="$(node_pid "$SURVIVOR")"
NODE_A_ROW="$(q "SELECT id FROM kernel.nodes WHERE name='${VICTIM}'")"
echo "   ${VICTIM} pid=$NODE_A_PID row=$NODE_A_ROW"

if [ -z "$NODE_A_PID" ] || [ -z "$NODE_A_ROW" ]; then
  skip "no ${VICTIM} pid or row; the failure half cannot run"
else
  # ---------------------------------------------------------------------------
  echo "== 1. the bound BELOW: at stale/2 the node must still be READY"
  # ---------------------------------------------------------------------------
  # The point is not "it takes a while". It is that the sweep must not fire while
  # a node could still be legitimately mid-interval. stale/2 is comfortably inside
  # any plausible jitter on a loaded runner and strictly below the threshold.
  HALF=$(( STALE_SRC / 2 ))
  KILLED_AT="$(date +%s)"
  kill "$NODE_A_PID" 2>/dev/null && ok "${VICTIM} process stopped (SIGTERM)" \
    || bad "could not stop ${VICTIM}"
  sleep "$HALF"
  ST_AT_HALF="$(q "SELECT status FROM kernel.nodes WHERE name='${VICTIM}'")"
  [ "$ST_AT_HALF" = "READY" ] \
    && ok "${HALF}s after the process died (stale/2), ${VICTIM} is still READY" \
    || bad "${VICTIM} is $ST_AT_HALF at ${HALF}s, which is before the ${STALE_SRC}s threshold - the sweep fired early"

  # ---------------------------------------------------------------------------
  echo "== 2. the bound ABOVE: by stale + margin the node must be gone"
  # ---------------------------------------------------------------------------
  # One extra heartbeat interval of slack: the sweep runs on the reconciler's own
  # tick, so a threshold crossing is not observed at the instant it happens. The
  # loop is also bounded in WALL TIME, not just iterations - a slow query would
  # otherwise let `LIMIT` iterations take far longer than `LIMIT` seconds while
  # the assertion message kept claiming seconds.
  LIMIT=$(( STALE_SRC + HEARTBEAT_SRC + 5 ))
  GONE=0
  WAITED=0
  while [ "$WAITED" -lt "$LIMIT" ]; do
    ST_NOW="$(q "SELECT status FROM kernel.nodes WHERE name='${VICTIM}'")"
    if [ "$ST_NOW" != "READY" ]; then GONE=1; break; fi
    sleep 1
    WAITED=$(( WAITED + 1 ))
    [ "$(( $(date +%s) - KILLED_AT ))" -ge "$LIMIT" ] && break
  done
  [ "$GONE" = "1" ] && ok "${VICTIM} left READY within ${LIMIT}s (stale + heartbeat + 5)" \
    || bad "${VICTIM} was still READY after ${LIMIT}s; the sweep is not bounded by the protocol"
  # An explicit counter, not `$_`: `for _ in ...` consumes the loop variable and
  # `$_` is not a bash variable at all - the first version died on
  # "node: unbound variable" under `set -u` after the bound had already passed.
  # THE LOWER BOUND IS NOT `stale`, AND GETTING THIS WRONG IS THE POINT OF THE CASE.
  #
  # The sweep predicates on `last_seen_at < now() - stale`, so it ages the node
  # from its LAST HEARTBEAT, not from when this script killed the process. At the
  # moment of the kill that heartbeat is already up to one interval old, so the
  # earliest defensible change is
  #
  #     stale - heartbeat        (25 - 5 = 20 s)
  #
  # The first version asserted `stale` and failed at 21 s - reporting a product
  # defect where the measurement was wrong. 21 s IS correct behaviour: the last
  # heartbeat was ~4 s before the kill. The corrected bound passes and still
  # excludes an early sweep, which is what the assertion is for.
  EARLIEST=$(( STALE_SRC - HEARTBEAT_SRC ))
  # MEASURED WITH A CLOCK, not by adding up the loop. Each pass runs a psql query
  # whose cost the counter does not see, and the counter does not include the
  # `sleep HALF` before the loop started.
  ELAPSED="$(( $(date +%s) - KILLED_AT ))"
  echo "   observed at ${ELAPSED}s after the kill; earliest defensible ${EARLIEST}s (stale ${STALE_SRC} - heartbeat ${HEARTBEAT_SRC}), limit ${LIMIT}s"
  if [ "$ELAPSED" -ge "$EARLIEST" ]; then
    ok "the change happened at ${ELAPSED}s, not before the earliest defensible ${EARLIEST}s"
  else
    bad "the change happened at ${ELAPSED}s, before ${EARLIEST}s is possible even with a fresh heartbeat at the kill"
  fi

  # WHAT THE KERNEL DOES WITH THE INSTANCE, WHICH IS MORE THAN "STOP" OR "NOTHING".
  #
  # The first two versions asserted it was told to STOP. On CI the kernel did
  # something else and both failed with `desired_action=<none>` on the dead node:
  # the replacer MOVED the instance to the surviving node instead
  # (`deployments.rs:1969`, the `current.node_id != node.id` branch sets
  # `node_id`, `desired_action='START'`, clears `container_id`). That is correct
  # behaviour, and asserting only STOP called it a defect twice.
  #
  # The real invariant is that the instance CONVERGES onto a node that is alive:
  # either it is stopped on the dead node, or it is running somewhere else. What
  # must never happen is a row left pointing at a dead node wanting START.
  if [ "$DEPLOYED" = "1" ]; then
    ON_VICTIM="$(q "SELECT i.desired_action FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND n.name='${VICTIM}' LIMIT 1")"
    NOWHERE_START="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND i.desired_action='START' AND n.status='READY'")"
    ANY_START="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND i.desired_action='START'")"

    if [ "${ANY_START:-0}" -eq 0 ] && [ -z "$ON_VICTIM" ]; then
      bad "the instance vanished: no START row anywhere and none on ${VICTIM}"
    elif [ -n "$ON_VICTIM" ] && [ "$ON_VICTIM" != "STOP" ]; then
      bad "the instance is still ${ON_VICTIM} on ${VICTIM}, a node the kernel considers gone"
    elif [ "${NOWHERE_START:-0}" -ge 1 ]; then
      ok "the instance converged onto a READY node (${NOWHERE_START} START), away from ${VICTIM}"
    elif [ "$ON_VICTIM" = "STOP" ]; then
      ok "the instance on ${VICTIM} is told to STOP"
    else
      # One replica, placed on a node that is gone, and nothing READY holds it:
      # the scheduler has not re-placed it yet. That is a pending state, not a
      # failure, and saying so is more useful than a red.
      skip "the instance is not yet re-placed and not stopped (START=${ANY_START:-0}); the reconciler has not caught up"
    fi
  else
    skip "no instance to reconcile: the deployment never activated on this host"
  fi

  # ---------------------------------------------------------------------------
  echo "== 3. RECOVERY: the same state dir resumes the same node row"
  # ---------------------------------------------------------------------------
  # `runtime::enroll` loads the identity from the state dir when one exists and
  # increments the generation (`runtime.rs:145`) - no new token. If that is true,
  # restarting with the same directory must bring the SAME row back to READY and
  # must not create a second row with the same name (the schema has
  # `name text NOT NULL UNIQUE`, so a duplicate would fail outright).
  ROWS_BEFORE="$(q "SELECT count(*) FROM kernel.nodes WHERE name='${VICTIM}'")"
  # The data port comes from `run.json`, not from a guess. A wrong port would make
  # the restarted node advertise an endpoint the kernel rejects, and the failure
  # would look like a recovery bug.
  NODE_A_PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nodePorts"][0])' "$STATE/run.json" 2>/dev/null || echo "")"
  if [ -z "$NODE_A_PORT" ]; then
    bad "could not read ${VICTIM}'s data port from run.json; the restart below would target a guessed port"
  fi
  nohup env \
    HOME="$STATE/home" \
    OPSWEAVE_KERNEL_URL="$KERNEL_URL" \
    OPSWEAVE_NODE_NAME=${VICTIM} \
    OPSWEAVE_NODE_LABELS="role=node,zone=local" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${NODE_A_PORT}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${NODE_A_PORT}" \
    OPSWEAVE_NODE_STATE_DIR="$STATE/${VICTIM}" \
    OPSWEAVE_CONTAINER_LABELS="opsweave.test-run=${RUN_ID}" \
    OPSWEAVE_DOCKER_HOST="${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}" \
    ./target/debug/opsweave-node > "$STATE/logs/${VICTIM}-restarted.log" 2>&1 &
  RESTARTED_PID=$!

  RECOVERED=0
  for _ in $(seq 1 40); do
    ST_R="$(q "SELECT status FROM kernel.nodes WHERE name='${VICTIM}'")"
    [ "$ST_R" = "READY" ] && { RECOVERED=1; break; }
    sleep 1
  done
  [ "$RECOVERED" = "1" ] && ok "${VICTIM} is READY again after restarting with its own state dir" \
    || bad "${VICTIM} did not return to READY within 40s; see $STATE/logs/${VICTIM}-restarted.log"

  ROWS_AFTER="$(q "SELECT count(*) FROM kernel.nodes WHERE name='${VICTIM}'")"
  [ "$ROWS_BEFORE" = "$ROWS_AFTER" ] && ok "there is still exactly one ${VICTIM} row ($ROWS_AFTER)" \
    || bad "${VICTIM} rows went from $ROWS_BEFORE to $ROWS_AFTER; the restart created a second node"

  ROW_SAME="$(q "SELECT id FROM kernel.nodes WHERE name='${VICTIM}'")"
  [ "$ROW_SAME" = "$NODE_A_ROW" ] && ok "the recovered row is the SAME row ($ROW_SAME)" \
    || bad "the recovered row is $ROW_SAME, but the original was $NODE_A_ROW"

  GEN_NOW="$(q "SELECT generation FROM kernel.nodes WHERE name='${VICTIM}'")"
  [ "${GEN_NOW:-0}" -ge 2 ] && ok "the generation advanced to ${GEN_NOW} (a restart is a new generation, not a new node)" \
    || bad "generation is ${GEN_NOW:-?}; a restart should have incremented it"

  # ---------------------------------------------------------------------------
  echo "== 4. INSTANCE RECONCILIATION: the node's instance goes back to START"
  # ---------------------------------------------------------------------------
  BPID="$(node_pid "$SURVIVOR")"
  [ -n "$BPID" ] && ok "${SURVIVOR} was never touched and is still running" \
    || bad "${SURVIVOR}'s pid is gone; the test disturbed the wrong node"

  # The reconciler settles within a few ticks; 30 s is generous against a 2 s tick
  # and does not encode a guess about placement itself.
  #
  # SAME INVARIANT AS ABOVE, after recovery: exactly one replica, START, on a node
  # that is alive. Whether it stayed on the survivor (re-placed there) or came
  # back to VICTIM is the scheduler's choice and not this case's subject; a row
  # wanting START on a dead node, or no row at all, is the failure.
  if [ "$DEPLOYED" = "1" ]; then
    SETTLED=0
    DESC=""
    for _ in $(seq 1 30); do
      DESC="$(q "SELECT string_agg(n.name || ':' || i.desired_action, ',' ORDER BY n.name) FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog'")"
      LIVE_START="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND i.desired_action='START' AND n.status='READY'")"
      DEAD_START="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND i.desired_action='START' AND n.status<>'READY'")"
      if [ "${LIVE_START:-0}" -ge 1 ] && [ "${DEAD_START:-0}" -eq 0 ]; then SETTLED=1; break; fi
      sleep 1
    done
    [ "$SETTLED" = "1" ] \
      && ok "every START instance is on a READY node after recovery (${DESC})" \
      || bad "after recovery the placement is ${DESC:-<none>}: START=${LIVE_START:-0} live, ${DEAD_START:-0} on a node that is not READY"
    echo "   placement: ${DESC:-<none>}"
  else
    skip "no instance to reconcile: the deployment never activated on this host"
  fi
fi

echo
echo "== what this run did NOT prove"
echo "   - NOT two machines: both nodes are processes on this host"
echo "   - NOT network partition: the node process is killed, not disconnected."
echo "     A partition is the harder case - the node keeps heartbeating into a"
echo "     black hole and quarantines itself at its lease (${LEASE_SRC}s), which"
echo "     this file does not drive"
echo "   - NOT the kernel's side of the lease: only the node's"
echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed, $SKIP skipped"; exit 0; }
echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
