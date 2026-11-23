#!/usr/bin/env bash
# The release verdict is a FUNCTION of the stages, and this drives it directly.
#
# The script itself runs against a real kernel; that is where the stage VALUES come
# from. What this file pins is the DECISION: given these stage states, what is the
# answer, and - more importantly - which states must NOT be reported as RELEASED.
#
# A release tool that says RELEASED because its last command exited 0 is the defect
# TASK-23 exists to remove. Every case below is a state that a single exit code
# would have flattened into "deployed" or "failed".
#
# Run: bash tests/ci/phase7_release_stages.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/ci/phase7_release_stages.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# Source ONLY the function: the script's body starts a platform and is not safe to
# run here. `awk` up to the closing brace at column 0 keeps the boundary visible.
eval "$(awk '/^verdict_of\(\) \{/,/^\}/' "$SCRIPT")"
if ! declare -f verdict_of >/dev/null; then
  echo "could not load verdict_of from $SCRIPT" >&2
  exit 2
fi

ALL_GOOD=$'HOST_UP UP\nKERNEL_READY READY\nNODE_READY READY\nPLUGIN_INSTALLED INSTALLED\nPLUGIN_RUNNING RUNNING\nPLUGIN_ACTIVE ACTIVE\nGATEWAY_SERVES SERVING\nWEB_REMOTE REACHABLE'

expect() { # label, summary, want_verdict
  local got; got="$(verdict_of "$2")"; got="${got%%|*}"
  if [ "$got" = "$3" ]; then ok "$1 ($got)"; else bad "$1: got $got, want $3"; fi
}

expect 'everything met is RELEASED' "$ALL_GOOD" RELEASED

# Each stage blocks on its own, with its own name in the verdict - so the operator
# knows WHICH check to look at rather than "deployment failed".
expect 'a down host blocks at HOST_UP' \
  "${ALL_GOOD/HOST_UP UP/HOST_UP DOWN}" BLOCKED_AT_HOST_UP
expect 'an unready kernel blocks at KERNEL_READY' \
  "${ALL_GOOD/KERNEL_READY READY/KERNEL_READY NOT_READY}" BLOCKED_AT_KERNEL_READY
expect 'no enrolled node blocks at NODE_READY' \
  "${ALL_GOOD/NODE_READY READY/NODE_READY NO_NODE}" BLOCKED_AT_NODE_READY
expect 'a missing package blocks at PLUGIN_INSTALLED' \
  "${ALL_GOOD/PLUGIN_INSTALLED INSTALLED/PLUGIN_INSTALLED NOT_INSTALLED}" BLOCKED_AT_PLUGIN_INSTALLED
expect 'no container blocks at PLUGIN_RUNNING' \
  "${ALL_GOOD/PLUGIN_RUNNING RUNNING/PLUGIN_RUNNING NOT_RUNNING}" BLOCKED_AT_PLUGIN_RUNNING

# THE CASE THAT MATTERS MOST: everything looks healthy, but the ACTIVE revision is
# a DIFFERENT version. A deploy exited 0, a container runs, a node is READY - and
# production serves something else. This must never read as RELEASED.
expect 'a WRONG ACTIVE version blocks at PLUGIN_ACTIVE' \
  "${ALL_GOOD/PLUGIN_ACTIVE ACTIVE/PLUGIN_ACTIVE WRONG_VERSION}" BLOCKED_AT_PLUGIN_ACTIVE

# An unevaluated gateway is its own answer, never a pass and never a failure.
expect 'an unexercised gateway is RELEASED_UNVERIFIED_GATEWAY, not RELEASED' \
  "${ALL_GOOD/GATEWAY_SERVES SERVING/GATEWAY_SERVES UNKNOWN}" RELEASED_UNVERIFIED_GATEWAY
expect 'a refused gateway blocks' \
  "${ALL_GOOD/GATEWAY_SERVES SERVING/GATEWAY_SERVES REFUSED}" BLOCKED_AT_GATEWAY_SERVES
expect 'an upstream error blocks' \
  "${ALL_GOOD/GATEWAY_SERVES SERVING/GATEWAY_SERVES UPSTREAM_ERROR}" BLOCKED_AT_GATEWAY_SERVES

# The browser remote is a different artifact and can fail alone.
expect 'a missing web remote is its own verdict' \
  "${ALL_GOOD/WEB_REMOTE REACHABLE/WEB_REMOTE NOT_EXPOSED}" RELEASED_WITHOUT_WEB_REMOTE

# ORDER: the FIRST failing stage names the verdict. A down host with a missing
# package is a host problem - reporting PLUGIN_INSTALLED would send the operator to
# the wrong end of the chain.
expect 'the earliest failing stage wins' \
  $'HOST_UP DOWN\nKERNEL_READY NOT_READY\nNODE_READY NO_NODE\nPLUGIN_INSTALLED NOT_INSTALLED\nPLUGIN_RUNNING NOT_RUNNING\nPLUGIN_ACTIVE NOT_ACTIVE\nGATEWAY_SERVES REFUSED\nWEB_REMOTE NOT_EXPOSED' \
  BLOCKED_AT_HOST_UP

# An EMPTY summary must not read as RELEASED. Every `awk` above prints nothing for
# a missing stage, and "" compares unequal to every expected value - this pins that
# is what happens rather than assuming it.
expect 'an empty summary blocks at HOST_UP' '' BLOCKED_AT_HOST_UP

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
