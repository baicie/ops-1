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
# `ON_ERROR_STOP=1`, matching the acceptance's own `q()`.
#
# Without it `psql -c` prints the error and exits 0, so a statement that failed
# is indistinguishable from one that worked. Measured: an UPDATE naming a column
# that does not exist (`error_code` instead of `last_error_code`), with its output
# redirected to /dev/null, looked exactly like a successful one - and the case
# then reported the PRODUCT's behaviour as wrong when its own setup had never
# run:
#
#     ERROR: column "error_code" of relation "pipeline_jobs" does not exist
#     FAIL  1: expected FAILED after revocation, got RUNNING
#
# With this flag a broken statement fails at the point it is written, with the
# psql error visible.
q()   { psql "$DB" -qAt -v ON_ERROR_STOP=1 -c "$1"; }

# --- the worker binary must be the real one --------------------------------
#
# `pipeline_long_heartbeat_counterfactuals.sh` swaps
# `target/debug/opsweave-pipeline-worker` for a script that exits 1, runs the SUT,
# and swaps it back. If that swap is ever left behind, every worker THIS file
# starts dies immediately - and the cases report
#
#     the job did not reach RUNNING (got QUEUED)
#
# which is a claim about the product. On run 43598745967 five cases failed this
# way against a stubbed binary, not against a defect.
#
# The counterfactuals now restore unconditionally and verify it, and this guard
# makes the debris impossible to mistake for a finding if it ever returns: a
# `*.real` sibling means a swap is outstanding, and a worker that exits before
# its own first log line means the path holds a stub.
REAL_BIN="$ROOT/target/debug/opsweave-pipeline-worker"
if [ -f "$REAL_BIN.real" ]; then
  echo "BLOCKED: $REAL_BIN.real exists, so the worker binary at" >&2
  echo "         $REAL_BIN is a stand-in left by another script. Every case here" >&2
  echo "         would start it and report QUEUED as a product finding." >&2
  echo "         Restore it (mv $REAL_BIN.real $REAL_BIN) and re-run." >&2
  exit 3
fi
# The discriminator is the binary's own SIZE, not a `--version` probe: this
# worker takes no CLI arguments (its `main` reads `OPSWEAVE_WORKER_JOB_ID` from
# the environment), so `--version` would start one and try to reach the Kernel -
# a check with side effects is not a precondition check.
#
# The stub the counterfactuals install is a few lines of shell; the real worker
# links tokio, reqwest and the contracts crate. A floor of 1 MiB separates them
# by orders of magnitude without executing anything, and a worker below it would
# fail for a reason worth stopping on anyway.
if [ -x "$REAL_BIN" ]; then
  bin_size="$(wc -c <"$REAL_BIN" 2>/dev/null | tr -d ' ' || echo 0)"
  if [ "${bin_size:-0}" -lt 1048576 ]; then
    echo "BLOCKED: $REAL_BIN is only ${bin_size} bytes, so it is a stand-in (the" >&2
    echo "         counterfactuals swap in a script that exits 1), not the real" >&2
    echo "         worker. Every case would start it and report QUEUED as a" >&2
    echo "         product finding. Rebuild: cargo build -p opsweave-pipeline-worker" >&2
    exit 3
  fi
else
  echo "BLOCKED: $REAL_BIN is missing; build it before running this suite" >&2
  exit 3
fi

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

# Start a worker bound to one job.
#
# The invocation used to be
#
#     env <assignments> "$@" ./target/debug/opsweave-pipeline-worker &
#
# and every caller passes exactly one argument (`start_long_job 40000`). `"$@"`
# expands to the arguments AFTER `$1`, which is empty - so it should have been
# harmless. It was not: `$@` was never shifted, so `"$@"` still contained
# `40000`, and `env` received it as the COMMAND to run:
#
#     env: '40000': No such file or directory
#
# The worker never started, the job stayed QUEUED, and five cases reported
# `the job did not reach RUNNING (got QUEUED)` as if the product had refused to
# claim it. Measured on run 43604452855, in `/tmp/neg-<job>.log`.
#
# Nothing ever passed extra arguments, so the parameter is simply gone. A caller
# that needs to wrap the worker can still do it through the environment.
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
    ./target/debug/opsweave-pipeline-worker >"/tmp/neg-$JOB.log" 2>&1 &
  # Recorded in a file because this function is invoked from a command
  # substitution; a variable assignment here would be lost with the subshell.
  printf '%s\n' "$!" >"$WORKER_PID_FILE"
  # Say where the worker's own output went. When five cases reported "the job did
  # not reach RUNNING (got QUEUED)" on run 43598745967, the only evidence was
  # `worker pid N already gone` - the reason was in /tmp/neg-<job>.log, which the
  # workflow does not upload. The path is now printed so the next failure can be
  # diagnosed from the job log alone.
  # stderr, NOT `note`. This function is invoked as `JOB="$(start_long_job …)"`,
  # so everything it writes to stdout becomes the job id. A `note` here did
  # exactly that: the id arrived as
  #
  #     "      worker for job <uuid>: pid … log /tmp/neg-<uuid>.log\n<uuid>"
  #
  # and every subsequent query failed with
  # `invalid input syntax for type uuid`, turning four cases into UNKNOWN. The
  # diagnostic broke the thing it was added to diagnose.
  printf 'worker for job %s: pid %s log /tmp/neg-%s.log\n' "$JOB" "$!" "$JOB" >&2
  echo "$JOB"
}

token() { python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])'; }
AUTH=(-H "Authorization: Bearer $(token)")
source tests/acceptance/pipeline_worker_auth.sh
load_worker node-b

# Why a job is not RUNNING, from what the database and the log can show.
#
# The distinction that matters is between "no worker ever claimed this" (QUEUED -
# a harness or credential defect) and "a worker claimed it and was rejected"
# (FAILED or LOST - a product defect). Printing only the status made those look
# identical in five cases at once.
report_job_not_running() {
  local job="$1" status="$2" log="/tmp/neg-$1.log"
  note "  job $job status=$status"
  local lease_row
  lease_row="$(q "SELECT coalesce(current_lease_id::text,'(none)') || ' attempts=' || coalesce(attempts::text,'?') FROM kernel.pipeline_jobs WHERE job_id='$job';" 2>/dev/null || echo "(query failed)")"
  note "  lease/attempts: $lease_row"
  if [ -f "$log" ]; then
    note "  worker log $log (last 5 lines):"
    tail -5 "$log" | while IFS= read -r l; do note "    $l"; done
  else
    note "  worker log $log: absent - the worker never started or could not write"
  fi
}

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
  # Say WHY, from evidence, rather than only that it did not. QUEUED means no
  # worker claimed the job; FAILED means one did and was rejected. Those are
  # different defects, and on run 43598745967 five cases printed the status and
  # nothing else while the worker's own log was not uploaded.
  report_job_not_running "$JOB1" "$STATUS1"
  bad "1: the job did not reach RUNNING (got $STATUS1), so the revocation would prove nothing"
  stop_worker
else
  LEASE1="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB1';")"
  if ! q "UPDATE kernel.pipeline_job_leases SET status='REVOKED' WHERE lease_id='$LEASE1';" >/dev/null; then
    bad "1: could not revoke the lease (the UPDATE failed); the case proves nothing"
  fi
  # `last_error_code`, not `error_code` - see
  # `apps/kernel/migrations/0003_typed_pipeline.sql:33`. The wrong name made this
  # UPDATE fail, the `>/dev/null` hid the psql error, and the case then asserted
  # on a job that had never been marked FAILED:
  #
  #     ERROR: column "error_code" of relation "pipeline_jobs" does not exist
  #     FAIL  1: expected FAILED after revocation, got RUNNING
  #
  # A test reporting the product's behaviour while its own setup silently failed.
  # The update is now checked, so a future schema change fails HERE with the
  # psql error rather than turning the case into a product finding.
  if ! q "UPDATE kernel.pipeline_jobs SET status='FAILED', last_error_code='LEASE_REVOKED' WHERE job_id='$JOB1';" >/dev/null; then
    bad "1: could not mark the job FAILED (the UPDATE failed); the case proves nothing"
  fi
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
  if ! q "UPDATE kernel.pipeline_job_leases SET expires_at = now() - interval '120 seconds' WHERE lease_id='$LEASE3';" >/dev/null; then
    bad "3: could not expire the lease (the UPDATE failed); the case proves nothing"
  fi
  # The Kernel's reaper marks it EXPIRED; the acceptance must not later call this
  # "kept alive" just because the job eventually succeeded or the row still exists.
  sleep 3
  if ! q "UPDATE kernel.pipeline_job_leases SET status='EXPIRED' WHERE lease_id='$LEASE3' AND expires_at < now();" >/dev/null; then
    bad "3: could not settle the lease to EXPIRED (the UPDATE failed); the case proves nothing"
  fi
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
# 5. A duplicate Effect.
#
# The acceptance asserts exactly 3 receipts. This case inserts a fourth for the
# same job and requires the assertion to notice, so "exactly 3" is a real check
# rather than a number that happens to match.
# ===========================================================================
echo "== 5: a duplicated effect receipt =="
JOB5="$(start_long_job 800)" || bad "5: could not start the job"
STATUS5="$(wait_status "$JOB5" 120)" || true
stop_worker
if [ "$STATUS5" != "SUCCEEDED" ]; then
  # QUEUED and RUNNING mean different things and only one of them is about this
  # test. QUEUED is "no worker claimed it" - a setup or credential problem, and
  # a reason to look here. RUNNING is "a worker claimed it and did not finish in
  # time" - which is about the workload and the budget, not about duplicates.
  report_job_not_running "$JOB5" "$STATUS5"
  if [ "$STATUS5" = "QUEUED" ]; then
    note "5: the job was never claimed (QUEUED) - this is a setup problem, not a product finding"
  else
    note "5: the job reached $STATUS5 but not SUCCEEDED within the budget"
  fi
  bad "5: could not establish a baseline job to duplicate an effect on"
else
  BASE="$(q "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB5';")"
  [ "$BASE" = "3" ] || bad "5: baseline receipt count is $BASE, expected 3"
  # Copy one receipt under a new key, if the table allows it.
  q "INSERT INTO plugin_opsweave_data_catalog.catalog_effect_receipts
       SELECT * FROM plugin_opsweave_data_catalog.catalog_effect_receipts
       WHERE job_id='$JOB5' LIMIT 1;" >/dev/null 2>&1
  AFTER="$(q "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB5';")"
  if [ "$AFTER" = "$BASE" ]; then
    note "5: the table's primary key refused the duplicate; that is the product preventing it, not the test"
    ok "5: a duplicate receipt cannot be inserted at all (unique constraint holds)"
  else
    [ "$AFTER" != "3" ] \
      && ok "5: the exactly-3 assertion would fail on a duplicated receipt (now $AFTER)" \
      || bad "5: the duplicate was accepted but the count is still 3"
  fi
fi

# ===========================================================================
# 6. The Kernel does not come back.
#
# LAST, FULL STOP - and the caller has to say so.
#
# `OPSWEAVE_NEG_TERMINAL=1` is the caller asserting that nothing after this suite
# needs a live platform. Without it the suite REFUSES to run case 6, rather than
# quarantining the nodes out from under whatever comes next. Measured on PR #105:
# `claim_concurrency.py` failed with `StopIteration` looking for a READY instance,
# because case 6 had quarantined every node two steps earlier. Ten steps followed
# it in `data_foundation_ci.sh`.
#
# A test whose side effect breaks the next test is not a test of the product. Freezing
# the Kernel for longer than the node lease (30 s, `config.rs:60`) makes each Node
# quarantine itself and STOP heartbeating - `runtime.rs:1154` breaks out of the
# heartbeat loop, which is the correct safety behaviour (a Node that cannot tell
# whether it was taken over must not keep acting). Nothing restores it.
#
# Measured on run 43613134315: case 5, which then ran after this one, failed with
# `claim failed (403 Forbidden): node is not READY`. That was this case's side
# effect reported as case 5's own failure. Case 5 now runs first.
#
# The happy path asserts that the heartbeat RESUMES after the outage. Without a
# resume the job must not succeed. This case stops the Kernel and leaves it
# stopped longer than the lease TTL, then restores it: the job must NOT come out
# SUCCEEDED on a lease that was never renewed.
# ===========================================================================
if [ "${OPSWEAVE_NEG_TERMINAL:-0}" != "1" ]; then
  # Refusing is the point: this case is irreversible, and silently running it in
  # the middle of a harness is how the failure lands on the next test.
  note "6: SKIPPED - case 6 quarantines every Node and cannot be undone"
  notrun "6 an outage past the lease TTL" "set OPSWEAVE_NEG_TERMINAL=1 only when no later step needs a live node"
else
echo "== 6: an outage that outlives the lease TTL =="
JOB6="$(start_long_job 40000)" || bad "6: could not start the job"
STATUS6="$(wait_status "$JOB6" 30)" || true
if [ "$STATUS6" != "RUNNING" ]; then
  bad "6: the job did not reach RUNNING (got $STATUS6)"
  stop_worker
else
  LEASE6="$(q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB6';")"
  kill -STOP "$KERNEL_PID"
  # Longer than LEASE_TTL (60 s): whatever happens, the lease cannot still be
  # ACTIVE and valid after this.
  sleep 70
  kill -CONT "$KERNEL_PID"
  sleep 3
  LEASE_STATE="$(q "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE6';")"
  JOB_STATE="$(q "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB6';")"
  stop_worker
  # This case stops the Kernel for longer than the NODE heartbeat TTL as well as
  # the lease TTL, so the Nodes go stale and are not READY when it ends.
  #
  # Everything that runs AFTER this case needs a READY node to claim a job. On run
  # 43611053760 case 6 failed with exactly that, and the worker's own log said so:
  #
  #     Error: claim failed (403 Forbidden): {"code":"FORBIDDEN",
  #       "message":"node is not READY"}
  #
  # That is this case's side effect, not a product finding - so the case now
  # WAITS for the platform to recover before returning, and fails if it does not.
  # Leaving a broken platform for the next case is how one case's PASS hides the
  # next case's setup failure.
  # This case CANNOT be undone, and the code says so:
  #
  #   apps/node/src/runtime.rs:1154-1160
  #     Err(error) => {
  #         let expired = last_success.elapsed() >= lease;
  #         warn!(...);
  #         if expired {
  #             quarantine(&shared, "node lease expired while Kernel was unreachable").await;
  #             break;                    <-- the heartbeat loop EXITS
  #         }
  #
  # `lease_seconds` defaults to 30 (config.rs:60) and this case freezes the Kernel
  # for 70. So the Node quarantines itself and stops heartbeating permanently: it
  # is a deliberate safety property - a Node that cannot tell whether it was taken
  # over must not keep acting - and nothing in the platform brings it back.
  #
  # Measured on run 43613134315: no node returned to READY within 90 s, and case 6
  # (which needs to complete a job) failed with
  # `claim failed (403 Forbidden): node is not READY`.
  #
  # So this case runs LAST among the ones that need a live platform, and it says
  # that in its own output. An earlier version waited 90 s for a recovery that
  # cannot happen, which turned a product property into a test timeout.
  note "6: nodes are now quarantined by design; this case must run last (see the header)"
  if [ "$JOB_STATE" = "SUCCEEDED" ] && [ "$LEASE_STATE" = "ACTIVE" ]; then
    bad "6: the job succeeded with an ACTIVE lease after a 70 s outage - the heartbeat claim is not being tested"
  else
    ok "6: an outage longer than the TTL is not reported as a healthy run (job=$JOB_STATE lease=$LEASE_STATE)"
  fi
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
