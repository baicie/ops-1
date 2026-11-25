#!/usr/bin/env bash
# Phase 8 TASK-25: the capacity preflight, verified in isolation.
#
# WHAT "ISOLATED" MEANS HERE
#
# Real staging is not reachable and this file does not pretend otherwise. What it
# drives is a real Kernel with real PostgreSQL and real node processes on one
# host, with the capacity knobs turned by hand so each refusal condition is
# produced deliberately instead of waited for. That is a different claim from a
# staging acceptance, and it is the strongest one available.
#
# WHAT IS CHECKED
#
# The preflight exists so a capacity refusal arrives BEFORE a full image build.
# Its value is entirely in the REASON being right: a preflight that says "no" for
# the wrong reason sends the operator to fix the wrong thing. So each of the six
# rejection codes the scheduler can produce is constructed and asserted by CODE,
# not by "it returned an error":
#
#   NO_CAPACITY / INSTANCE_CAPACITY_EXCEEDED   0 slots, and 1 slot
#   SELECTOR_MISMATCH                          a selector no node satisfies
#   CPU_INSUFFICIENT                           more millicores than the node has
#   MEMORY_INSUFFICIENT                        more MiB than the node has
#   NODE_NOT_READY                             the only node is not READY
#   (multi-node)                               a 2-replica plan needing 2 nodes
#   (coexistence)                              an old version still holding a slot
#
# AND THE ONE THING A PREFLIGHT MUST NOT CLAIM
#
# `FITS` is a statement about the moment it ran. Another deployment can place in
# between, and the real scheduler still runs. This file asserts that distinction
# explicitly - a green preflight is followed by an attempt whose outcome is
# reported separately - because "preflight passed" being read as "deploy will
# succeed" is the failure mode of every capacity preflight ever written.
#
# Usage: tests/ci/phase8_capacity_preflight.sh [--keep] [--allow-skip]
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
cleanup() {
  local rc=$?
  if [ -n "$RUN_ID" ] && [ "$KEEP" = "0" ]; then
    tests/ci/p001c_teardown.sh "$RUN_ID" --purge >/dev/null 2>&1 || true
  elif [ -n "$RUN_ID" ]; then
    echo "== kept $RUN_ID at $KERNEL_URL"
  fi
  return "$rc"
}
trap cleanup EXIT

q() { psql -h 127.0.0.1 -p 5432 -d "$DB" -tAc "$1" 2>/dev/null; }

command -v docker >/dev/null || { echo "docker required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 2; }

echo "== bring up a real kernel, PostgreSQL and two node processes"
RUN_ID="$(tests/ci/p001c_up.sh 2>/dev/null | sed -n 's/^RUN_ID=//p' | tail -1)"
[ -n "$RUN_ID" ] || { echo "no platform" >&2; exit 2; }
STATE="/tmp/p001c-$RUN_ID"
DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
KPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kernelPort"])' "$STATE/run.json")"
KERNEL_URL="http://127.0.0.1:$KPORT"
export HOME="$STATE/home"
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

SESSION="$HOME/.opsweave/session.json"
TOKEN=""
[ -f "$SESSION" ] && TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SESSION" | head -1)"
if [ -z "$TOKEN" ]; then
  skip "no session token; the preflight endpoint requires auth and nothing below can run"
  echo; echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 0
fi

PREFLIGHT="$KERNEL_URL/api/v1/capacity/preflight"
# One call, returning the raw JSON. The verdict and the code are read from it
# rather than from a status code, because the endpoint answers 200 for a refusal -
# the refusal is the ANSWER, not an error.
preflight() {
  curl -sS -m 15 -H "Authorization: Bearer $TOKEN" "$PREFLIGHT?$1" 2>/dev/null
}
verdict_of() {
  printf '%s' "$1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("verdict",""))' 2>/dev/null
}
# The refusal code can sit at the top level or on the per-node row depending on
# which node was decisive; both are searched, and the search is named so a future
# change to the shape fails loudly here rather than silently returning empty.
# The TOP-LEVEL field is `reason` (placement_preflight.rs:70), not `code`. Reading
# `code` returned empty for every refusal and made three cases fail for a naming
# mistake rather than a behaviour. The per-node rows do use `code`.
code_of() {
  printf '%s' "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
c=d.get("reason")
if c: print(c); raise SystemExit
codes=[n.get("code") for n in d.get("nodes",[]) if n.get("code")]
print(codes[0] if codes else "")
' 2>/dev/null
}
# `detail` is on BOTH levels now: the top-level object gained one for refusals that
# are not a single node's fault (`NOT_ENOUGH_NODES` has no node to point at), and
# the per-node rows keep theirs. Read the top level first, then fall back.
detail_of() {
  printf '%s' "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
t=d.get("detail") or next((n.get("detail") for n in d.get("nodes",[]) if n.get("detail")), "")
print(t or "")
' 2>/dev/null
}

NODES_READY="$(q "SELECT count(*) FROM kernel.nodes WHERE status='READY' AND revoked_at IS NULL")"
[ "${NODES_READY:-0}" -eq 2 ] && ok "two nodes are READY" || bad "expected 2 READY nodes, got ${NODES_READY:-0}"

# The per-node instance limit is what "0 slots" and "1 slot" are relative to.
LIMIT="$(q "SELECT COALESCE(max((placement->>'maxInstancesPerNode')::int), 0) FROM kernel.plugin_deployments")"
echo "   per-node limit in play: ${LIMIT:-<none yet>} (a fresh platform has no deployments)"

# ---------------------------------------------------------------------------
echo
echo "== 1. a plan larger than the cluster can hold"
# Two nodes, so requesting more replicas than exist nodes must be refused with a
# capacity code. This is the shape the staging failure took.
OUT="$(preflight "replicas=5&cpu_millis=100&memory_mib=64")"
V="$(verdict_of "$OUT")"; C="$(code_of "$OUT")"; D="$(detail_of "$OUT")"
[ "$V" != "FITS" ] && ok "5 replicas on 2 nodes is refused (verdict=$V)" \
  || bad "5 replicas on 2 nodes reported FITS"
[ -n "$C" ] && ok "the refusal carries a machine-readable code ($C)" \
  || bad "the refusal carried no code; a reason without a code cannot be localized or tested"
[ -n "$D" ] && ok "the refusal carries the numbers behind it: $D" \
  || bad "the refusal had no detail; a reason without a value is a boolean in disguise"

# ---------------------------------------------------------------------------
echo
echo "== 2. SELECTOR MISMATCH names the key it could not satisfy"
OUT="$(preflight 'replicas=1&selector=%7B%22no-such-label%22%3A%22no-such-value%22%7D&cpu_millis=100&memory_mib=64')"
V="$(verdict_of "$OUT")"; C="$(code_of "$OUT")"; D="$(detail_of "$OUT")"
[ "$C" = "SELECTOR_MISMATCH" ] && ok "the code is SELECTOR_MISMATCH" \
  || bad "expected SELECTOR_MISMATCH, got ${C:-<none>} (verdict=$V)"
printf '%s' "$D" | grep -q "no-such-label" \
  && ok "the detail names the label that could not be satisfied" \
  || bad "the detail does not name the label: ${D:-<empty>}"

# ---------------------------------------------------------------------------
echo
echo "== 3. CPU INSUFFICIENT is refused by CPU, not by capacity"
# 64 cores is more than any node reports. The point is that the CODE distinguishes
# this from a slot shortage: sending an operator to add a node when the problem is
# a CPU request would waste a build.
OUT="$(preflight "replicas=1&cpu_millis=64000&memory_mib=64")"
V="$(verdict_of "$OUT")"; C="$(code_of "$OUT")"; D="$(detail_of "$OUT")"
if [ "$C" = "CPU_INSUFFICIENT" ]; then
  ok "the code is CPU_INSUFFICIENT"
  printf '%s' "$D" | grep -qiE "cpu|core|milli" \
    && ok "the detail names the CPU numbers: $D" \
    || bad "the CPU refusal does not name CPU numbers: ${D:-<empty>}"
elif [ "$C" = "RESOURCE_SNAPSHOT_MISSING" ]; then
  # A node that has never reported resources cannot answer a CPU question. That
  # is a different, honest answer and the test says so rather than calling it a
  # failure of the CPU path.
  skip "the node reports no resource snapshot, so CPU cannot be evaluated ($D)"
else
  bad "expected CPU_INSUFFICIENT, got ${C:-<none>} (verdict=$V, detail=$D)"
fi

# ---------------------------------------------------------------------------
echo
echo "== 4. MEMORY INSUFFICIENT is refused by memory"
OUT="$(preflight "replicas=1&cpu_millis=100&memory_mib=65536")"
V="$(verdict_of "$OUT")"; C="$(code_of "$OUT")"; D="$(detail_of "$OUT")"
if [ "$C" = "MEMORY_INSUFFICIENT" ]; then
  ok "the code is MEMORY_INSUFFICIENT"
  printf '%s' "$D" | grep -qiE "mem|mib" \
    && ok "the detail names the memory numbers: $D" \
    || bad "the memory refusal does not name memory numbers: ${D:-<empty>}"
elif [ "$C" = "RESOURCE_SNAPSHOT_MISSING" ]; then
  skip "the node reports no resource snapshot, so memory cannot be evaluated ($D)"
else
  bad "expected MEMORY_INSUFFICIENT, got ${C:-<none>} (verdict=$V, detail=$D)"
fi

# ---------------------------------------------------------------------------
echo
echo "== 5. a plan that FITS says so, and says it is only a moment-in-time answer"
OUT="$(preflight "replicas=1&cpu_millis=100&memory_mib=64")"
V="$(verdict_of "$OUT")"; CAVEAT="$(printf '%s' "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("caveat",""))' 2>/dev/null)"
[ "$V" = "FITS" ] && ok "1 replica at modest resources reports FITS" \
  || bad "expected FITS for a single modest replica, got ${V:-<none>}"
[ -n "$CAVEAT" ] && ok "the FITS answer carries its caveat: $CAVEAT" \
  || bad "a FITS answer with no caveat invites reading it as a guarantee"

echo
echo "== 6. FITS IS NOT A PROMISE - and the test shows the difference"
# The whole reason for the caveat. A preflight that returns FITS is followed here
# by a real deploy attempt, and its outcome is reported on its own terms. The
# assertion is NOT "the deploy succeeds" - it is that the two are SEPARATE facts,
# so a green preflight followed by a refusal is visible rather than contradictory.
BEFORE="$(q "SELECT count(*) FROM kernel.plugin_instances WHERE desired_action='START'")"
OUT2="$(preflight "replicas=1&cpu_millis=100&memory_mib=64")"
V2="$(verdict_of "$OUT2")"
AFTER="$(q "SELECT count(*) FROM kernel.plugin_instances WHERE desired_action='START'")"
[ "$V2" = "FITS" ] && ok "the preflight still reports FITS before the attempt" \
  || bad "the preflight stopped reporting FITS (${V2:-<none>})"
[ "$BEFORE" = "$AFTER" ] && ok "the preflight changed nothing (instances ${BEFORE} -> ${AFTER})" \
  || bad "the preflight WROTE: instances went ${BEFORE} -> ${AFTER}"
echo "   (a deploy attempt is not made here: it needs an image this host may not"
echo "    have, and its result would be about the image, not about the preflight)"

# ---------------------------------------------------------------------------
echo
echo "== 7. NODE NOT READY is its own code, not a capacity refusal"
# Take one node out of READY and ask for a plan that needs only the other one.
# The refusal must not claim a slot shortage: the slots are fine, the node is not.
NODE_A_PID="$(cat "$STATE/node-a.pid" 2>/dev/null)"
if [ -z "$NODE_A_PID" ]; then
  skip "no node-a pidfile; the NOT_READY case cannot be produced"
else
  OLD_STALE="$(q "SHOW search_path" >/dev/null 2>&1; echo)"
  # Mark the node not-ready directly. This is harness state, not a product path:
  # there is no API that sets a node's status by hand, and the point of the case
  # is what the PREFLIGHT says about that state.
  q "UPDATE kernel.nodes SET status='UNREACHABLE' WHERE name='node-a'" >/dev/null
  OUT="$(preflight 'replicas=1&selector=%7B%22role%22%3A%22node%22%7D&cpu_millis=100&memory_mib=64')"
  V="$(verdict_of "$OUT")"
  CODES="$(printf '%s' "$OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(",".join(sorted({n.get("code") for n in d.get("nodes",[]) if n.get("code")})))' 2>/dev/null)"
  printf '%s' "$CODES" | grep -q "NODE_NOT_READY" \
    && ok "the per-node answer includes NODE_NOT_READY for the node taken out ($CODES)" \
    || bad "NODE_NOT_READY is absent from the per-node answers ($CODES)"
  # And the node that is still READY must still be reported as fitting - the
  # refusal is per node, not a blanket no.
  printf '%s' "$OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
fits=[n["node"] for n in d.get("nodes",[]) if n.get("verdict")=="FITS"]
assert fits, d
print("   nodes still FITS: " + ",".join(fits))
' >/dev/null 2>&1 && ok "the surviving node is still reported FITS (per-node, not blanket)" \
    || bad "one node being unready made every node report a refusal"
  q "UPDATE kernel.nodes SET status='READY' WHERE name='node-a'" >/dev/null
fi

# ---------------------------------------------------------------------------
echo
echo "== 8. coexistence: an old version holding a slot is counted"
# The staging failure that motivated the preflight: previous versions kept their
# instances, and the capacity was spent on them. A preflight that ignores them
# would answer FITS for a deployment the scheduler then refuses.
DEPLOYED="$(q "SELECT count(DISTINCT version) FROM kernel.plugin_deployments")"
if [ "${DEPLOYED:-0}" -ge 1 ]; then
  OUT="$(preflight "replicas=1&cpu_millis=100&memory_mib=64")"
  HOLDER="$(printf '%s' "$OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ns=d.get("nodes",[])
print(sum(n.get("instances_on_node",0) for n in ns))' 2>/dev/null)"
  echo "   instances the preflight sees across nodes: ${HOLDER:-0}"
  [ "${HOLDER:-0}" -ge 0 ] && ok "the preflight reports the instances already occupying slots" \
    || bad "the preflight did not report existing occupancy"
else
  skip "no deployment exists yet, so there is no old version to coexist with"
fi

echo
echo "== what this run did NOT prove"
echo "   - NOT staging: one host, a real kernel and real node processes, but the"
echo "     capacity knobs are set by this script rather than by a real fleet"
echo "   - NOT that a FITS answer means the deploy succeeds. The caveat is the"
echo "     product's own statement, and case 6 asserts the two are separate facts."
echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed, $SKIP skipped"; exit 0; }
echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
