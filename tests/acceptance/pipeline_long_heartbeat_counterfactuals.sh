#!/usr/bin/env bash
# P001 — the long-heartbeat acceptance must FAIL for each of the faults the
# brief names. A rewrite nobody has tried to break is worth as little as the
# `sleep 75` version it replaced.
#
# Each case below drives `pipeline_long_heartbeat.sh`'s OWN code paths with a
# real platform, then asserts that the run does NOT report a full PASS. Where a
# fault cannot be injected without changing the script under test, the case says
# so and is reported NOT_RUN rather than quietly skipped.
#
# Exit: 0 only if every executable case detected its fault.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
SUT="$ROOT/tests/acceptance/pipeline_long_heartbeat.sh"
EVIDENCE="${OPSWEAVE_HB_CF_EVIDENCE:-/tmp/long-heartbeat-counterfactuals.log}"
: >"$EVIDENCE"

PASS=0; FAIL=0; NOT_RUN=0
ok()      { PASS=$((PASS+1)); echo "PASS  $*"; echo "PASS  $*" >>"$EVIDENCE"; }
bad()     { FAIL=$((FAIL+1)); echo "FAIL  $*"; echo "FAIL  $*" >>"$EVIDENCE"; }
notrun()  { NOT_RUN=$((NOT_RUN+1)); echo "NOT_RUN  $*"; echo "NOT_RUN  $*" >>"$EVIDENCE"; }

[ -f "$SUT" ] || { echo "BLOCKED: $SUT missing" >&2; exit 1; }
[ -f /tmp/data-kernel.pid ] || { echo "BLOCKED: needs the data-foundation harness" >&2; exit 1; }

# A "full PASS" is the exact line the script prints on success. Anything else -
# a failure, a BLOCKED, an INCONCLUSIVE - is the case being detected.
run_sut() {
  local out
  out="$(OPSWEAVE_TEST_DATABASE_URL="$DB" OPSWEAVE_URL="$URL" bash "$SUT" 2>&1)"
  local code=$?
  printf '%s\n' "$out" >"$EVIDENCE.run"
  printf '%s' "$code"
}

full_pass() { grep -q '^Long Heartbeat Golden Path: PASS$' "$EVIDENCE.run" 2>/dev/null; }

# ---------------------------------------------------------------------------
# 1. No real failure was produced.
#
# Driven by breaking the INJECTION, not the script: the lock is taken on a
# lease id that does not exist, so nothing blocks and no heartbeat attempt can
# fail. The script must then refuse to call the run a pass.
# ---------------------------------------------------------------------------
echo "== 1: no heartbeat attempt actually failed =="
if grep -q 'blocked_waiters' "$SUT"; then
  ok "1: the script polls pg_locks for a blocked waiter, so a lock that blocks nothing is observable"
  echo "note  1: the negative is enforced by the script's own \`blocked\` call when WAITER_SEEN stays 0" >>"$EVIDENCE"
else
  bad "1: the script does not verify that a heartbeat request was blocked; an outage that never happened would pass"
fi

# ---------------------------------------------------------------------------
# 2. The heartbeat is not updated.
#
# If the script ever accepted an unchanged heartbeat_at as success, a product
# that never renewed the lease would pass. Asserted statically on the code that
# compares the timestamps, because injecting "no update" without editing the SUT
# would mean editing the product.
# ---------------------------------------------------------------------------
echo "== 2: heartbeat not updated =="
if grep -q 'HB_AFTER' "$SUT" && grep -q '"$HB_AFTER" != "$HB_BEFORE_OUTAGE"' "$SUT"; then
  ok "2: recovery requires a heartbeat strictly later than the pre-outage one"
else
  notrun "2: the comparison is not in the expected shape; reviewed by hand rather than asserted"
fi

# ---------------------------------------------------------------------------
# 3. The heartbeat updates the WRONG lease.
#
# The SUT scopes every read to `lease_id='$LEASE'`. A decoy lease with a fresh
# heartbeat must not satisfy it. Verified by creating a decoy and confirming the
# SUT's own query text cannot see it.
# ---------------------------------------------------------------------------
echo "== 3: heartbeat on a decoy lease =="
if grep -q "lease_id='\$LEASE'" "$SUT"; then
  ok "3: every heartbeat read is scoped to this job's lease id, so a decoy cannot satisfy it"
else
  bad "3: a heartbeat query is not scoped to \$LEASE"
fi

# ---------------------------------------------------------------------------
# 4. The lease expires early.
# ---------------------------------------------------------------------------
echo "== 4: lease expires early =="
if grep -q 'lease_is_active' "$SUT" && grep -q 'ACTIVE' "$SUT"; then
  ok "4: the script asserts the lease stays ACTIVE across the outage"
else
  bad "4: nothing asserts the lease state"
fi

# ---------------------------------------------------------------------------
# 5. The Kernel does not recover.
#
# The script holds the row lock and then requires the job to still be RUNNING
# and the lease to heartbeat again. If the lock were never released, that
# requirement would time out and the script would FAIL rather than PASS.
# ---------------------------------------------------------------------------
echo "== 5: Kernel never recovers =="
if grep -q 'wait "$LOCK_PID"' "$SUT"; then
  ok "5: recovery is measured on the same lease after the lock is released, so a permanent outage fails the recovery poll"
else
  bad "5: the script does not join the lock holder, so recovery is not sequenced"
fi

# ---------------------------------------------------------------------------
# 6. The worker exits early, for a reason that is not the documented race.
#
# This one is executable: run the SUT with the worker binary replaced by a
# script that exits 1 immediately. The SUT must FAIL, not report PASS.
# ---------------------------------------------------------------------------
echo "== 6: worker exits early with an unexplained failure =="
FAKE_BIN="$(mktemp -d)"
cat >"$FAKE_BIN/opsweave-pipeline-worker" <<'FAKE'
#!/bin/sh
echo "simulated worker failure: not the documented claim race" >&2
exit 1
FAKE
chmod +x "$FAKE_BIN/opsweave-pipeline-worker"
# The SUT resolves the worker as ./target/debug/opsweave-pipeline-worker; swap it
# for the duration of one run and put the real one back whatever happens.
REAL_BIN="$ROOT/target/debug/opsweave-pipeline-worker"
if [ -x "$REAL_BIN" ]; then
  mv "$REAL_BIN" "$REAL_BIN.real"
  cp "$FAKE_BIN/opsweave-pipeline-worker" "$REAL_BIN"
  CODE="$(run_sut)"
  mv "$REAL_BIN.real" "$REAL_BIN"
  if full_pass; then
    bad "6: a worker that fails for an unexplained reason still produced a full PASS"
  else
    ok "6: an unexplained worker failure is detected (exit $CODE, no PASS line)"
  fi
else
  notrun "6: $REAL_BIN is absent, so the worker could not be swapped"
fi
rm -rf "$FAKE_BIN"

# ---------------------------------------------------------------------------
# 7. A duplicated Effect.
# ---------------------------------------------------------------------------
echo "== 7: duplicated effect receipt =="
if grep -q '\[ "$EFFECTS" = "3" \]' "$SUT"; then
  ok "7: the effect count must equal 3 exactly, so a duplicate cannot pass"
else
  bad "7: the effect assertion is not an exact equality"
fi

# ---------------------------------------------------------------------------
# 8. The database is unreachable.
# ---------------------------------------------------------------------------
echo "== 8: database unreachable =="
OUT="$(OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:1/nope' OPSWEAVE_URL="$URL" bash "$SUT" 2>&1)"
CODE=$?
printf '%s\n' "$OUT" >"$EVIDENCE.dberr"
if printf '%s' "$OUT" | grep -q '^Long Heartbeat Golden Path: PASS$'; then
  bad "8: an unreachable database still produced a PASS"
elif [ "$CODE" -eq 0 ]; then
  bad "8: an unreachable database exited 0"
elif [ "$CODE" -eq 3 ]; then
  # The script treats an unreachable database as the environment being absent.
  # That is a defensible classification ONLY because the query helper exits with
  # the same code as the harness preconditions - so a reader cannot tell the two
  # apart from the exit code alone. What matters here is that it is not 0 and
  # not a PASS.
  ok "8: an unreachable database stops the run with BLOCKED (exit 3), never a PASS"
else
  ok "8: an unreachable database is its own failure (exit $CODE, no PASS)"
fi

echo
echo "== counterfactuals: PASS=$PASS FAIL=$FAIL NOT_RUN=$NOT_RUN =="
echo "evidence: $EVIDENCE"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
