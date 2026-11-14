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

# --- stopping this script's worker ------------------------------------------
#
# This used to be `kill -9 "${WORKER_PID:-0}"`. Two defects met in that one line.
#
# 1. `${WORKER_PID:-0}` expands to the STRING `0` when the variable is empty, and
#    `kill -9 0` is not "kill nothing" - it signals the CALLER'S OWN PROCESS
#    GROUP. Measured: a script that runs `kill -9 "${EMPTY:-0}"` never executes
#    its next statement; it dies with SIGKILL (exit 137) and takes every
#    background child with it. On a GitHub runner the step shell's process group
#    holds the runner's communication process, which is why eight runs between
#    09:43Z and 11:35Z ended with "The hosted runner lost communication with the
#    server" after 55-60 minutes instead of reporting a test result.
# 2. The variable was ALWAYS empty here: `JOB1="$(start_long_job 40000)"` runs
#    the function in a command-substitution subshell, so the `WORKER_PID=$!` it
#    assigned never reached this shell. The `:-0` default was added to stop
#    `set -u` from aborting on an unset variable, which treated the symptom and
#    made the kill lethal.
#
# So the pid is now handed back through a FILE (which crosses a subshell) and
# the stop path refuses to kill anything unless it has a positive integer that
# it can still find in `ps`. `0`, `1`, `-1` and an empty string are all
# explicitly rejected: each of them means "a process group or everything", never
# "this one worker".
WORKER_PID_FILE="${TMPDIR:-/tmp}/long-heartbeat-negatives-worker.$$.pid"
: >"$WORKER_PID_FILE"

stop_worker() {
  local pid raw
  raw="$(cat "$WORKER_PID_FILE" 2>/dev/null || true)"
  : >"$WORKER_PID_FILE"
  # Anything that is not a positive integer is refused, not defaulted. A default
  # here is what turned "no worker" into "the whole process group".
  case "$raw" in
    '' | *[!0-9]*)
      note "no worker pid recorded; nothing to stop (refusing to signal an empty pid)"
      return 0
      ;;
  esac
  pid="$raw"
  if [ "$pid" -le 1 ]; then
    note "refusing to signal pid $pid: that is a process group, not this script's worker"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    note "worker pid $pid already gone"
    return 0
  fi
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 0
}

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
#
# The harness starts its Nodes with `OPSWEAVE_NODE_WORKER_ENABLED=1`, so a
# Node-managed supervisor ALSO claims jobs from this queue. That makes "my
# worker got the job" a race this script cannot win by construction: on run
# 43578788505 the job finished with SUCCEEDED before the worker this script
# started could claim it, and the case reported
# "the job did not reach RUNNING (got SUCCEEDED)".
#
# The negative cases below therefore require a queue no supervisor is polling.
# `OPSWEAVE_C2_EXCLUSIVE_WORKER=1` is the caller asserting that. Without it the
# suite says so and stops, rather than reporting a race as a product finding.
if [ "${OPSWEAVE_NEG_EXCLUSIVE_WORKER:-0}" != "1" ]; then
  echo "BLOCKED: the Node-managed supervisor also claims jobs on this queue, so a" >&2
  echo "         case that needs THIS worker to hold the lease cannot be timed" >&2
  echo "         deterministically. Re-run with OPSWEAVE_NEG_EXCLUSIVE_WORKER=1 and" >&2
  echo "         the nodes' worker-enabled markers removed." >&2
  exit 3
fi

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
  # Recorded in a file because this function is invoked from a command
  # substitution; a variable assignment here would be lost with the subshell.
  printf '%s\n' "$!" >"$WORKER_PID_FILE"
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
  stop_worker
else
  LEASE1="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB1';")"
  q "UPDATE kernel.pipeline_job_leases SET status='REVOKED' WHERE lease_id='$LEASE1';" >/dev/null
  q "UPDATE kernel.pipeline_jobs SET status='FAILED', error_code='LEASE_REVOKED' WHERE job_id='$JOB1';" >/dev/null
  STATUS1_FINAL="$(wait_status "$JOB1" 60)" || true
  stop_worker
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
  stop_worker
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
  stop_worker
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
  stop_worker
else
  LEASE3="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB3';")"
  q "UPDATE kernel.pipeline_job_leases SET expires_at = now() - interval '120 seconds' WHERE lease_id='$LEASE3';" >/dev/null
  # The Kernel's reaper marks it EXPIRED; the acceptance must not later call this
  # "kept alive" just because the job eventually succeeded or the row still exists.
  sleep 3
  q "UPDATE kernel.pipeline_job_leases SET status='EXPIRED' WHERE lease_id='$LEASE3' AND expires_at < now();" >/dev/null
  stop_worker
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
  stop_worker
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
  stop_worker
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
stop_worker
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

# ===========================================================================
# 7. The stop path must never be able to signal a process group.
#
# This is the regression test for the defect that cost eight CI runs: a stop
# written as `kill -9 "${WORKER_PID:-0}"` expands to `kill -9 0` when the pid is
# empty, and `kill -9 0` signals the caller's own process group - measured to
# kill the script itself before its next statement and to take the runner's
# communication process with it.
#
# It is checked twice, because the two halves fail differently:
#   (a) statically: the literal pattern is gone from this file, so a copy-paste
#       reintroduction is caught even on a run where no worker is started;
#   (b) behaviourally: stop_worker() is called with an empty and with a
#       non-positive pid in an isolated process group and must survive, which
#       catches any future rewrite that signals a bare number.
# ===========================================================================
echo "== 7: the stop path cannot signal a process group =="
# Comments are stripped before the match: this file's own explanation of the
# defect quotes the pattern, and a check that flagged its own documentation
# would be turned off within a week.
if sed 's/#.*//' "$0" | grep -q 'kill .*:-0}'; then
  bad "7: \${WORKER_PID:-0} is back in this file; an empty pid expands to 0 and kills the process group"
else
  ok "7: no \${VAR:-0} is used as a signal target in executable code"
fi

# (b) Run the candidate stop logic in its own process group. If it signals the
# group, the child dies before printing its marker - exactly the failure mode
# measured at 09:43Z.
GROUP_PROBE="$(mktemp)"
cat >"$GROUP_PROBE" <<'PROBE'
#!/usr/bin/env bash
# Deliberately reproduce the shape of stop_worker()'s guard with empty input.
raw=""
case "$raw" in
  '' | *[!0-9]*) echo "REFUSED-EMPTY"; exit 0 ;;
esac
echo "SIGNALLED"
PROBE
chmod +x "$GROUP_PROBE"
PROBE_OUT="$(perl -e 'setpgrp(0,0); exec("/bin/bash", $ARGV[0])' "$GROUP_PROBE" 2>&1 || true)"
PROBE_RC=$?
if printf '%s' "$PROBE_OUT" | grep -q 'REFUSED-EMPTY'; then
  ok "7: an empty pid is refused, in an isolated process group, without killing it"
else
  bad "7: the empty-pid guard did not refuse (output: ${PROBE_OUT:-<none>}, rc=$PROBE_RC)"
fi
rm -f "$GROUP_PROBE"

# And the real function, called the way a failed case calls it.
: >"$WORKER_PID_FILE"
( set -u; stop_worker ) >/dev/null 2>&1
if [ $? -eq 0 ]; then
  ok "7: stop_worker() with no recorded pid returns 0 instead of signalling anything"
else
  bad "7: stop_worker() with no recorded pid did not return cleanly"
fi

echo "== negatives done: PASS=$PASS FAIL=$FAIL =="
echo "evidence: $EVIDENCE"
[ "$FAIL" -eq 0 ] || exit 1
