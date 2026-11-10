#!/usr/bin/env bash
# P001-B.2: two upgrade behaviours the review named, asserted at the source.
#
# Neither can be observed without a docker daemon and two real images, so they
# are asserted two ways: the source shape (here, always runnable) and the live
# behaviour (in the Linux acceptance workflow, where a daemon exists). A source
# assertion alone would be weak; it is paired with the live one rather than
# replacing it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/platform_up.sh"
fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

[ -f "$SCRIPT" ] || { echo "FAIL  no installer at $SCRIPT"; exit 1; }

# The block that decides pull-vs-local, extracted once.
BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT
awk '/^cmd_switch_image\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SCRIPT" > "$BLOCK"
[ -s "$BLOCK" ] || { echo "FAIL  cannot extract cmd_switch_image"; exit 1; }

# ---------------------------------------------------------------------------
# 1. A mutable TAG must never be satisfied by a local copy by default.
#
#    The failure this prevents: an operator upgrades `:stable`, the daemon has an
#    old `:stable`, the installer skips the pull, the containers restart on the
#    OLD image, and every health check passes. The upgrade reports success and
#    changed nothing.
# ---------------------------------------------------------------------------
if grep -q 'OPSWEAVE_ALLOW_LOCAL_TAG' "$BLOCK"; then
  pass "taking a local copy of a tag requires an explicit opt-in"
else
  fail "a local tag can be reused without an explicit opt-in"
fi

if grep -q 'is a tag; pulling' "$BLOCK"; then
  pass "a tag pulls by default"
else
  fail "a tag does not pull by default"
fi

# The digest branch must exist and be keyed on the digest shape, not on a flag.
if grep -q '\*@sha256:\*)' "$BLOCK"; then
  pass "a digest reference is recognised as immutable"
else
  fail "digest references are not distinguished from tags"
fi
if grep -q 'a digest cannot be stale' "$BLOCK"; then
  pass "a present digest is skipped for the stated reason"
else
  fail "digest-skip is not justified in the code"
fi

# The pull result must be verified, not assumed.
if grep -q 'is not present after a successful pull' "$BLOCK"; then
  pass "a pulled tag is verified to exist"
else
  fail "a successful pull is trusted without checking the image exists"
fi

# ---------------------------------------------------------------------------
# 2. A node that is not healthy must yield DEGRADED, not success.
#
#    "Kernel swapped" is not "platform upgraded": a node that cannot reach the
#    docker socket runs no plugin workloads, so an unqualified success would
#    describe a platform with no working workload executor as fully upgraded.
# ---------------------------------------------------------------------------
if grep -q 'DEGRADED' "$BLOCK"; then
  pass "an unhealthy node produces a DEGRADED outcome"
else
  fail "an unhealthy node is reported as a complete upgrade"
fi
if grep -qE 'return 3' "$BLOCK"; then
  pass "DEGRADED has a distinct exit code (3), not 0 and not a generic failure"
else
  fail "DEGRADED has no distinct exit code"
fi
if grep -q 'NOT a complete upgrade' "$BLOCK"; then
  pass "the DEGRADED message says the upgrade is not complete"
else
  fail "the DEGRADED message does not state the upgrade is incomplete"
fi

# The success wording must be gated on the node being healthy, so there is one
# place that decides what "complete" means.
if grep -q 'kernel and node both healthy' "$BLOCK"; then
  pass "the success message requires both kernel and node"
else
  fail "success is claimed without requiring a healthy node"
fi

# A failed kernel switch must still be a hard failure, not DEGRADED.
if grep -qE 'wait_healthy kernel' "$BLOCK" && grep -q 'produced a build that is not platform-only' "$BLOCK"; then
  pass "a failed kernel switch or a non-platform build remains fatal"
else
  fail "kernel-side failures are not distinguished from node-side ones"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "P001 upgrade-behaviour guard: PASS"
  exit 0
fi
echo "P001 upgrade-behaviour guard: $fails failure(s)"
exit 1
