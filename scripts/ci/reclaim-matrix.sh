#!/usr/bin/env bash
# TASK-10: the reclamation correctness matrix, as mutations.
#
# ADR-030 D3 lists eight conditions that must ALL hold before a deployment is
# released. A test suite that passes is not evidence that each one does something:
# a protection whose removal changes no test result is not a protection, it is a
# comment. This script removes them one at a time and records which tests fail.
#
# WHAT IT IS NOT
#
# It is not a test. It mutates the working tree, runs the suite, and restores the
# file - so it must not run in CI and must not run concurrently with anything else
# touching `deployments.rs` or `placement_preflight.rs`. It is a REPORT: the output
# goes into `docs/ci/phase9b-reclaim-matrix.md` by hand, which is why it prints
# rather than asserts.
#
# USAGE
#
#   OPSWEAVE_TEST_DATABASE_URL=... bash scripts/ci/reclaim-matrix.sh
#
# Every mutation is applied by an exact string replacement that is asserted to
# match. A mutation that does not apply is reported as NOT_APPLIED and is not
# counted as a result - a silently skipped mutation would read as "the protection
# does nothing", which is the opposite conclusion.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

: "${OPSWEAVE_TEST_DATABASE_URL:?set OPSWEAVE_TEST_DATABASE_URL to a disposable database}"

PRE=apps/kernel/src/placement_preflight.rs
DEP=apps/kernel/src/deployments.rs
WORK="$(mktemp -d)"
trap 'restore; rm -rf "$WORK"' EXIT

cp "$PRE" "$WORK/pre.bak"
cp "$DEP" "$WORK/dep.bak"

restore() {
  [ -f "$WORK/pre.bak" ] && cp "$WORK/pre.bak" "$PRE"
  [ -f "$WORK/dep.bak" ] && cp "$WORK/dep.bak" "$DEP"
}

# run_suite prints the names of failing tests, one per line.
run_suite() {
  cargo test --bin opsweave-kernel -- --test-threads=1 2>&1 \
    | grep -E '^test .* FAILED$' \
    | sed 's/^test //; s/ .*//' \
    | sort -u
}

mutate() { # mutate <file> <old> <new> <label>
  local file="$1" old="$2" new="$3" label="$4"
  python3 - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if old not in s:
    print("NOT_APPLIED", file=sys.stderr)
    raise SystemExit(3)
open(path, 'w').write(s.replace(old, new, 1))
PY
  if [ $? -ne 0 ]; then
    printf '%-46s NOT_APPLIED\n' "$label"
    restore
    return 1
  fi

  local failures
  failures="$(run_suite)"
  if [ -z "$failures" ]; then
    printf '%-46s CAUGHT_BY_NOTHING\n' "$label"
  else
    printf '%-46s caught by: %s\n' "$label" "$(echo "$failures" | tr '\n' ' ')"
  fi
  restore
  return 0
}

echo "=== ADR-030 D3 mutation matrix ==="
echo "each line: protection removed -> the tests that noticed"
echo

# --- E2: the ACTIVE revision protection -------------------------------------
mutate "$PRE" '    if f.has_active_revision {
        return ReclaimEligibility::Protected("ACTIVE_REVISION_PROTECTED");
    }' '' "E2  no ACTIVE-revision protection"

# --- E3: the routable conjunction -------------------------------------------
mutate "$PRE" '    if f.has_ready_instance && f.has_active_revision {
        return ReclaimEligibility::Protected("ROUTABLE_INSTANCE_PRESENT");
    }' '' "E3  no routable-instance protection"

# --- E4: the status gate -----------------------------------------------------
mutate "$PRE" '        "DRAINING" => return ReclaimEligibility::Protected("ALREADY_RECLAIMING"),
        _ => return ReclaimEligibility::Protected("NOT_A_CANDIDATE_STATUS"),' \
              '' "E4  any status is a candidate"

# --- E1: supersession --------------------------------------------------------
mutate "$PRE" '    if !f.superseded_by_newer {
        return ReclaimEligibility::Protected("NO_SUCCESSOR");
    }' '' "E1  no successor required"

# --- E5: something must be waiting ------------------------------------------
mutate "$PRE" '    if !f.a_sibling_is_waiting {
        return ReclaimEligibility::Protected("NOTHING_WAITING");
    }' '' "E5  no waiting sibling required"

# --- E8: the physical-evidence requirement ----------------------------------
mutate "$PRE" '    if is_failed_attempt && f.instance_may_have_container && !f.instances_idle_or_absent {
        return ReclaimEligibility::InsufficientEvidence("RUNTIME_MAY_BE_RUNNING");
    }' '' "E8  a running container does not block"

# --- E8's other half ---------------------------------------------------------
mutate "$PRE" '    if is_failed_attempt && !f.instances_idle_or_absent {
        return ReclaimEligibility::InsufficientEvidence("RUNTIME_STATE_UNKNOWN");
    }' '' "E8  an unknown instance shape is accepted"

# --- E6: the generation fence on the write ----------------------------------
mutate "$DEP" '             WHERE id=$1 AND status=$3 AND generation=$4' \
              '             WHERE id=$1 OR (status=$3 AND generation=$4)' \
              "E6  the write is not fenced on id+status+generation"

# --- the whole decision, replaced by the naive rule the brief forbids -------
mutate "$PRE" '    match f.status.as_str() {
        "READY" | "DEGRADED" => {}' '    match f.status.as_str() {
        "READY" | "DEGRADED" | "PREPARING" => {}' \
              "E4b PREPARING treated as a candidate"

echo
echo "=== end ==="
echo "A protection whose line says CAUGHT_BY_NOTHING is not protecting anything."
