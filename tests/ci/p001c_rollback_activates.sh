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
# The envelope is applied by rollback_response(), which sits above rollback().
# Extract both: checking only rollback() would miss the fields entirely, which is
# exactly what happened when the envelope was introduced and this guard's first
# version reported six missing fields that were present two functions up.
BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT
awk '/^async fn rollback_response\(/{f=1} f{print} f&&/^}/{if(++c==1){f=0;c=0}} /^pub async fn rollback\(/{g=1} g{print} g&&/^}/{exit}' "$KERNEL" > "$BLOCK"

if [ ! -s "$BLOCK" ]; then
  echo "FAIL  could not extract the rollback function from $KERNEL"
  exit 1
fi

# 1. Every branch must emit the same outcome envelope, and `rollbackCompleted`
#    must be computed from the ACTIVE revision rather than asserted by the branch.
for field in targetVersion effectiveVersion effectiveRevision rollbackCompleted pendingActivation nextStep; do
  if grep -q "\"$field\"" "$BLOCK"; then
    pass "rollback emits $field"
  else
    fail "rollback does not emit $field"
  fi
done

if grep -q 'active_version_of' "$KERNEL"; then
  pass "rollbackCompleted is read back from the ACTIVE activation"
else
  fail "rollbackCompleted is not derived from the database"
fi

# `rollbackCompleted` must not be set to a literal true anywhere - that is how a
# branch would claim success without checking.
# `completed` must come from comparing the effective version to the target.
# An earlier version of this check searched for one exact insert() shape, so
# rewriting the computation as `let completed = true;` slipped past it.
if grep -qE 'let completed = (true|false);' "$KERNEL"; then
  fail "rollbackCompleted is a literal instead of a comparison"
elif grep -q 'let completed = effective_version.as_deref() == Some(target_version);' "$KERNEL"; then
  pass "rollbackCompleted is computed by comparing effective and target versions"
else
  fail "rollbackCompleted is not computed from the effective version"
fi

# 2. opsctl must act on the outcome, not print and exit.
for needle in pendingActivation rollbackCompleted; do
  if grep -q "$needle" "$CLI"; then
    pass "opsctl reads $needle"
  else
    fail "opsctl does not read $needle"
  fi
done

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

# The CLI must verify the route after acting; printing the first response is how
# a "successful" rollback used to leave the old version serving.
if grep -q 'is not the active version\|did not complete:' "$CLI"; then
  pass "opsctl refuses to report success without the target being active"
else
  fail "opsctl can report success without checking the active version"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "rollback activation contract holds"
