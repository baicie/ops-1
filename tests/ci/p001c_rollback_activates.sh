#!/usr/bin/env bash
# P001-C1 / D1: `rollback` must never report success without switching the route.
#
# The defect this guards, measured 2026-11-11 on an isolated platform:
#
#   $ opsctl rollback dev.opsweave.hello 0.0.1 --replicas 2
#   { "statusReason": "Redeploy requested", ... }        <- HTTP 200
#   gateway polls afterwards: 0.0.2, 0.0.2, 0.0.2        <- nothing moved
#
# The target deployment was DRAINING/DISABLED after the upgrade, so the handler
# took the branch that only redeploys, and returned that response unchanged. A
# second call - by which time v1 was READY - was the one that activated.
#
# Two halves are asserted here, because either alone can regress silently:
#
#   1. the Kernel's rollback says what it did (`pendingActivation`)
#   2. opsctl.rollback finishes the job instead of printing a 200 and exiting
#
# This is a source assertion. The live behaviour is exercised by hand and
# recorded in docs/acceptance/p001/03a-plugin-lifecycle.md; a source check is
# paired with that evidence rather than replacing it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KERNEL="$ROOT/apps/kernel/src/deployments.rs"
CLI="$ROOT/apps/opsctl/src/main.rs"
fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

[ -f "$KERNEL" ] || { echo "FAIL  no kernel source at $KERNEL"; exit 1; }
[ -f "$CLI" ] || { echo "FAIL  no opsctl source at $CLI"; exit 1; }

# The rollback body, from its signature to the next item.
BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT
awk '/^pub async fn rollback\(/{f=1} f{print} f&&/^}/{if(++c==1)exit}' "$KERNEL" > "$BLOCK"

if [ ! -s "$BLOCK" ]; then
  echo "FAIL  could not extract the rollback function from $KERNEL"
  exit 1
fi

# 1. The redeploy branch must report that it did not activate.
if grep -q 'rollbackActivated' "$BLOCK"; then
  pass "rollback reports whether it activated"
else
  fail "rollback can return without saying it did not activate"
fi

if grep -q 'pendingActivation' "$BLOCK"; then
  pass "rollback flags a pending activation"
else
  fail "rollback does not flag the activation it still needs"
fi

if grep -q 'nextStep' "$BLOCK"; then
  pass "rollback names the next step"
else
  fail "rollback does not tell the caller what remains"
fi

# The flag must be set on the branch that only redeploys. Setting it in the
# READY branch - which does activate - would invert the meaning.
if grep -q 'rollbackActivated".into(), Value::Bool(false)' "$BLOCK"; then
  pass "the redeploy branch marks rollbackActivated=false"
else
  fail "the redeploy branch does not mark itself as not-activated"
fi

# 2. opsctl must act on the flag rather than print and exit.
if grep -q 'pendingActivation' "$CLI"; then
  pass "opsctl reads pendingActivation"
else
  fail "opsctl ignores pendingActivation and would print a 200 and exit"
fi

if grep -q 'wait_for_ready(&api, &plugin, &version' "$CLI"; then
  pass "opsctl waits for the target to become READY"
else
  fail "opsctl does not wait before activating"
fi

if grep -q '/activations' "$CLI"; then
  pass "opsctl issues the activation itself"
else
  fail "opsctl never activates after a redeploy"
fi

# --- Counterfactual ---------------------------------------------------------
# A guard that cannot fail is not a guard. Verified by hand on 2026-11-11:
# reverting BOTH fixes to their original shape makes this script exit 1 with
# five failures ("can return without saying it did not activate", "does not flag
# the activation it still needs", "does not tell the caller what remains", "the
# redeploy branch does not mark itself as not-activated", "opsctl ignores
# pendingActivation"); restoring them exits 0.
#
# The check below is the part of that which can run unattended: the strings this
# script greps for must actually exist in the tree, so a rename cannot quietly
# turn every assertion into a vacuous pass.
for needle in 'rollbackActivated' 'pendingActivation' 'nextStep'; do
  if grep -q "$needle" "$KERNEL"; then
    pass "guard input present in the kernel: $needle"
  else
    fail "guard input missing from the kernel: $needle (assertions above were vacuous)"
  fi
done
if grep -q 'pendingActivation' "$CLI"; then
  pass "guard input present in opsctl: pendingActivation"
else
  fail "guard input missing from opsctl: pendingActivation (assertions above were vacuous)"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "rollback activation contract holds"
