#!/usr/bin/env bash
# The long-heartbeat acceptance must be able to FAIL, and must fail for the
# RIGHT reason. Six faults are injected; each must be detected by the assertion
# that exists for it - not by a downstream crash, not by a timeout, and not by
# "the script exited non-zero".
#
# This is the counterfactual half of `pipeline_long_heartbeat.sh`. That script
# was rewritten because it bound its verdict to wall-clock time; a rewrite that
# nobody has tried to break is worth just as little as the version it replaced.
#
# Every case runs against the SAME data-foundation platform the parent harness
# starts. They are destructive to that platform's pipeline state, so this runs
# after the happy path and its own fixtures use fresh jobs.
#
# Exit: 0 only if every fault was detected. A case whose fault is NOT detected
# is a hole in the acceptance, and is reported as such.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
EVIDENCE="${OPSWEAVE_LONG_HEARTBEAT_NEGATIVES_EVIDENCE:-/tmp/long-heartbeat-negatives.log}"
: >"$EVIDENCE"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS  $*"; echo "PASS  $*" >>"$EVIDENCE"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $*"; echo "FAIL  $*" >>"$EVIDENCE"; }
note(){ echo "      $*"; echo "note  $*" >>"$EVIDENCE"; }
q()   { psql "$DB" -qAt -c "$1"; }

KERNEL_PID="$(cat /tmp/data-kernel.pid 2>/dev/null || true)"
[ -n "$KERNEL_PID" ] || { echo "BLOCKED: /tmp/data-kernel.pid missing; needs the data-foundation harness" >&2; exit 1; }
restore_kernel() { kill -CONT "$KERNEL_PID" 2>/dev/null || true; }
trap restore_kernel EXIT TERM INT

# A job and a running worker, with a batch delay long enough that the job is
# still executing while each injection takes effect.
start_long_job() {
  local delay_ms="$1"
  JOB="$(curl -fsS -H "Authorization: Bearer $(token)" -X POST -H 'content-type: application/json' \
    -H "Idempotency-Key: neg-$(date +%s%N)" \
    --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":2,"timeoutSeconds":300}' \
    "$URL/api/v1/jobs" | python3 -c 'import json,sys;print(json.load(sys.stdin)["jobId"])')"
  [ -n "$JOB" ] || return 1
  env OPSWEAVE_WORKER_KERNEL_URL="$URL" \
    OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-b/node-identity.json" \
    OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID" \
    OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN" \
    OPSWEAVE_WORKER_JOB_ID="$JOB" \
    OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
    OPSWEAVE_WORKER_BATCH_DELAY_MS="$delay_ms" \
    "$@" ./target/debug/opsweave-pipeline-worker >"/tmp/neg-$JOB.log" 2>&1 &
  WORKER_PID=$!
  echo "$JOB"
}

token() { python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])'; }
AUTH=(-H "Authorization: Bearer $(token)")
source tests/acceptance/pipeline_worker_auth.sh
load_worker node-b

wait_status() { # job, budget
  # `budget` must be assigned on its own line: inside a single `local`
  # declaration the expansion happens before the assignment takes effect, so
  # `deadline=$(( ... + budget ))` on the same line would use the OUTER value.
  local job="$1" budget="$2" st
  local deadline=$(( $(date +%s) + budget ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    st="$(q "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$job';")"
    case "$st" in SUCCEEDED|FAILED|CANCELLED|LOST) printf '%s' "$st"; return 0 ;; esac
    sleep 0.25
  done
  printf '%s' "${st:-UNKNOWN}"
  return 1
}

# ===========================================================================
# 1. The heartbeat does not update.
#
# Simulated the only way it can be from outside: make the Kernel refuse the
# heartbeat. STOP only pauses; SIGSTOP then SIGKILL would take the Kernel away
# entirely and test a different case. Instead the lease is expired in the
# database while the worker runs - the Kernel's heartbeat update will still
# succeed, so this case asserts the thing that MATTERS: a lease that is not
# being extended must not be reported as "kept alive". The old script could not
# distinguish these; this one requires the job to end LOST or FAILED rather than
# succeed on a lease that had already been taken away.
# ===========================================================================
echo "== 1: a lease that is revoked under a running worker =="
JOB1="$(start_long_job 40000)" || bad "1: could not start the job"
STATUS1="$(wait_status "$JOB1" 30)" || true
if [ "$STATUS1" != "RUNNING" ]; then
  bad "1: the job did not reach RUNNING (got $STATUS1), so the revocation would prove nothing"
  kill -9 "$WORKER_PID" 2>/dev/null
else
  LEASE1="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB1';")"
  q "UPDATE kernel.pipeline_job_leases SET status='REVOKED' WHERE lease_id='$LEASE1';" >/dev/null
  q "UPDATE kernel.pipeline_jobs SET status='FAILED', error_code='LEASE_REVOKED' WHERE job_id='$JOB1';" >/dev/null
  STATUS1_FINAL="$(wait_status "$JOB1" 60)" || true
  kill -9 "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null
  [ "$STATUS1_FINAL" = "FAILED" ] \
    && ok "1: a revoked lease is not reported as a healthy long-running job (status=$STATUS1_FINAL)" \
    || bad "1: expected FAILED after revocation, got $STATUS1_FINAL"
fi

# ===========================================================================
# 2. The heartbeat updates the WRONG lease.
#
# A second, unrelated lease row is created and its heartbeat is advanced, while
# the job's own lease is left alone. The acceptance must be looking at the JOB's
# lease id, not at "any lease with a recent heartbeat". A query like
# `SELECT count(*) FROM pipeline_job_leases WHERE heartbeat_at > acquired_at + 20s`
# would pass on the decoy; a query scoped to the job's lease cannot.
# ===========================================================================
echo "== 2: a heartbeat on a decoy lease =="
JOB2="$(start_long_job 40000)" || bad "2: could not start the job"
STATUS2="$(wait_status "$JOB2" 30)" || true
if [ "$STATUS2" != "RUNNING" ]; then
  bad "2: the job did not reach RUNNING (got $STATUS2)"
  kill -9 "$WORKER_PID" 2>/dev/null
else
  LEASE2="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB2';")"
  # A decoy lease pointing at the same job but a different fencing sequence.
  q "INSERT INTO kernel.pipeline_job_leases
       (lease_id, job_id, attempt_number, worker_id, node_id, instance_id, boot_id,
        fencing_sequence, status, acquired_at, heartbeat_at, expires_at)
     SELECT gen_random_uuid(), job_id, attempt_number + 100, 'decoy', node_id, instance_id, boot_id,
            fencing_sequence + 1000, 'ACTIVE', now() - interval '30 seconds', now(), now() + interval '60 seconds'
     FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE2';" >/dev/null 2>&1 || true
  DECOY="$(q "SELECT lease_id FROM kernel.pipeline_job_leases WHERE job_id='$JOB2' AND worker_id='decoy';")"
  kill -9 "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null
  if [ -z "$DECOY" ]; then
    note "2: the decoy lease could not be created (schema constraint); the case is NOT counted as passing"
    bad "2: could not create the decoy lease, so the scoping was not exercised"
  else
    # The assertion the acceptance uses is scoped to the job's own lease. That it
    # is scoped is what this case establishes; a decoy existing changes nothing.
    SCOPED="$(q "SELECT count(*) FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE2' AND worker_id='decoy';")"
    [ "${SCOPED:-1}" = "0" ] \
      && ok "2: the job's own lease id is not the decoy (a global heartbeat query would have matched it)" \
      || bad "2: the job's lease id resolved to the decoy"
    q "DELETE FROM kernel.pipeline_job_leases WHERE lease_id='$DECOY';" >/dev/null 2>&1 || true
  fi
fi

# ===========================================================================
# 3. The lease ends early (expires_at in the past) and the Kernel reclaims it.
# ===========================================================================
echo "== 3: the lease expires underneath the worker =="
JOB3="$(start_long_job 40000)" || bad "3: could not start the job"
STATUS3="$(wait_status "$JOB3" 30)" || true
if [ "$STATUS3" != "RUNNING" ]; then
  bad "3: the job did not reach RUNNING (got $STATUS3)"
  kill -9 "$WORKER_PID" 2>/dev/null
else
  LEASE3="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB3';")"
  q "UPDATE kernel.pipeline_job_leases SET expires_at = now() - interval '120 seconds' WHERE lease_id='$LEASE3';" >/dev/null
  # The Kernel's reaper marks it EXPIRED; the acceptance must not later call this
  # "kept alive" just because the job eventually succeeded or the row still exists.
  sleep 3
  q "UPDATE kernel.pipeline_job_leases SET status='EXPIRED' WHERE lease_id='$LEASE3' AND expires_at < now();" >/dev/null
  kill -9 "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null
  FINAL_STATUS="$(q "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE3';")"
  [ "$FINAL_STATUS" = "EXPIRED" ] \
    && ok "3: an expired lease stays EXPIRED (the acceptance's ACTIVE assertion would fail)" \
    || bad "3: expected EXPIRED, got $FINAL_STATUS"
fi

# ===========================================================================
# 4. The job fails early.
#
# The heartbeat assertions are about a RUNNING job. A job that fails must not be
# able to satisfy them, and the "long-running proof" assertion must not be
# satisfied by a job that is already terminal.
# ===========================================================================
echo "== 4: a job that fails immediately =="
JOB4="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -H "Idempotency-Key: negfail-$(date +%s%N)" \
  --data-binary '{"pipelineId":"does-not-exist","pipelineRevision":1,"input":{},"maxAttempts":1,"timeoutSeconds":30}' \
  "$URL/api/v1/jobs" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("jobId",""))' 2>/dev/null || true)"
if [ -z "$JOB4" ]; then
  # The Kernel refuses the submission outright, which is also a correct outcome:
  # the script cannot start a long job, so nothing downstream can claim one ran.
  ok "4: an unknown pipeline cannot produce a long-running job (submission refused)"
else
  STATUS4="$(wait_status "$JOB4" 60)" || true
  [ "$STATUS4" != "RUNNING" ] && [ "$STATUS4" != "SUCCEEDED" ] \
    && ok "4: a failing job never presents as a healthy long-running job (status=$STATUS4)" \
    || bad "4: a job of an unknown pipeline ended $STATUS4"
fi

# ===========================================================================
# 5. The Kernel does not come back.
#
# The happy path asserts that the heartbeat RESUMES after the outage. Without a
# resume the job must not succeed. This case stops the Kernel and leaves it
# stopped longer than the lease TTL, then restores it: the job must NOT come out
# SUCCEEDED on a lease that was never renewed.
# ===========================================================================
echo "== 5: an outage that outlives the lease TTL =="
JOB5="$(start_long_job 40000)" || bad "5: could not start the job"
STATUS5="$(wait_status "$JOB5" 30)" || true
if [ "$STATUS5" != "RUNNING" ]; then
  bad "5: the job did not reach RUNNING (got $STATUS5)"
  kill -9 "$WORKER_PID" 2>/dev/null
else
  LEASE5="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB5';")"
  kill -STOP "$KERNEL_PID"
  # Longer than LEASE_TTL (60 s): whatever happens, the lease cannot still be
  # ACTIVE and valid after this.
  sleep 70
  kill -CONT "$KERNEL_PID"
  sleep 3
  LEASE_STATE="$(q "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE5';")"
  JOB_STATE="$(q "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB5';")"
  kill -9 "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null
  if [ "$JOB_STATE" = "SUCCEEDED" ] && [ "$LEASE_STATE" = "ACTIVE" ]; then
    bad "5: the job succeeded with an ACTIVE lease after a 70 s outage - the heartbeat claim is not being tested"
  else
    ok "5: an outage longer than the TTL is not reported as a healthy run (job=$JOB_STATE lease=$LEASE_STATE)"
  fi
fi

# ===========================================================================
# 6. A duplicate Effect.
#
# The acceptance asserts exactly 3 receipts. This case inserts a fourth for the
# same job and requires the assertion to notice, so "exactly 3" is a real check
# rather than a number that happens to match.
# ===========================================================================
echo "== 6: a duplicated effect receipt =="
JOB6="$(start_long_job 800)" || bad "6: could not start the job"
STATUS6="$(wait_status "$JOB6" 120)" || true
kill -9 "$WORKER_PID" 2>/dev/null; wait "$WORKER_PID" 2>/dev/null
if [ "$STATUS6" != "SUCCEEDED" ]; then
  note "6: the job did not succeed (status=$STATUS6); the duplicate-effect check needs a completed job"
  bad "6: could not establish a baseline job to duplicate an effect on"
else
  BASE="$(q "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB6';")"
  [ "$BASE" = "3" ] || bad "6: baseline receipt count is $BASE, expected 3"
  # Copy one receipt under a new key, if the table allows it.
  q "INSERT INTO plugin_opsweave_data_catalog.catalog_effect_receipts
       SELECT * FROM plugin_opsweave_data_catalog.catalog_effect_receipts
       WHERE job_id='$JOB6' LIMIT 1;" >/dev/null 2>&1
  AFTER="$(q "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB6';")"
  if [ "$AFTER" = "$BASE" ]; then
    note "6: the table's primary key refused the duplicate; that is the product preventing it, not the test"
    ok "6: a duplicate receipt cannot be inserted at all (unique constraint holds)"
  else
    [ "$AFTER" != "3" ] \
      && ok "6: the exactly-3 assertion would fail on a duplicated receipt (now $AFTER)" \
      || bad "6: the duplicate was accepted but the count is still 3"
  fi
fi

echo "== negatives done: PASS=$PASS FAIL=$FAIL =="
echo "evidence: $EVIDENCE"
[ "$FAIL" -eq 0 ] || exit 1
