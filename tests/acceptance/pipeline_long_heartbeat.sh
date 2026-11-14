#!/usr/bin/env bash
# A job whose execution outlives a lease-miss window, proving the independent
# heartbeat task keeps the Lease alive across a temporary Kernel outage.
#
# ## What this script used to do, and why it was wrong
#
#     sleep 75
#     STATUS=... ; [ "$STATUS" = "SUCCEEDED" ] && bad "job completed before long-running proof"
#
# That binds the verdict to how fast the worker happens to run. On a fast host
# the job finished inside 75 s and the test failed; the recorded mitigation was
# to raise the batch delay from 30 s to 55 s so the job would take longer than
# the window. Raising a number to outrun a race does not remove the race - it
# moves it, and the run that motivated the change (43146267562) already showed
# the preceding case alone taking 62 s on a loaded runner.
#
# ## What it does instead
#
# Every threshold below is a *state*, reached by bounded polling, not a wall
# clock. The script waits for:
#
#   1. the job to be RUNNING (the worker claimed it),
#   2. at least one heartbeat to land DURING that run — measured against the
#      lease's own `acquired_at`, not against when this script started,
#   3. a Kernel outage during which a heartbeat attempt must fail,
#   4. the heartbeat to recover after the outage,
#   5. the job to reach SUCCEEDED, with 3 effects and 1001 records.
#
# Step 2 is the one that was never really tested. The old assertion checked
# `heartbeat_at > acquired_at + 20s` ONCE, at a fixed moment; if the job had
# already finished, that moment never came and the test reported a false
# failure. Here the evidence is collected as a series of samples with
# timestamps, so "the heartbeat happened during execution" is something the log
# shows rather than something a single query asserted.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

# The evidence file is the artifact a reviewer reads. Every poll appends a line,
# so a failure at any step can be explained by what was observed up to it.
EVIDENCE="${OPSWEAVE_LONG_HEARTBEAT_EVIDENCE:-/tmp/long-heartbeat-evidence.log}"
: >"$EVIDENCE"

json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; echo "PASS  $*" >>"$EVIDENCE"; }
bad() { echo "FAIL  $*"; echo "FAIL  $*" >>"$EVIDENCE"; exit 1; }
# A missing platform is not a product failure. Exit 3 says "the environment was
# not there"; exit 1 says "the product did not do what was asserted"; exit 2 says
# "measured nothing conclusive". Collapsing them lets an unreachable harness be
# reported as a defect, and a defect be reported as a harness problem.
blocked() { echo "BLOCKED  $*"; echo "BLOCKED  $*" >>"$EVIDENCE"; exit 3; }
note() { echo "      $*"; echo "note  $*" >>"$EVIDENCE"; }
# A query that cannot run must STOP the script, never return "".
#
# An empty string is indistinguishable from "no rows" at every call site - a
# lease that looks missing, a status that looks terminal, a heartbeat that looks
# unchanged. `-v ON_ERROR_STOP=1` plus an explicit check makes an unreachable
# database its own failure instead of a quiet verdict change.
q() {
  local out
  if ! out="$(psql "$DB" -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/tmp/long-heartbeat-psql.err)"; then
    echo "FAIL  the database query could not run: $(head -1 /tmp/long-heartbeat-psql.err 2>/dev/null)" >&2
    echo "FAIL  the database query could not run: $1" >>"$EVIDENCE"
    exit 2
  fi
  printf '%s' "$out"
}

# Bounded polling. `until_state <description> <budget-seconds> <command...>`
# re-runs the command every 250 ms until it prints a non-empty value, and fails
# with the observation log if the budget runs out. The budget is a guard against
# a hang, never the thing that decides the result.
until_state() {
  local what="$1" budget="$2"; shift 2
  local deadline=$(( $(date +%s) + budget ))
  local value=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    value="$("$@" 2>/dev/null || true)"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
    sleep 0.25
  done
  echo "FAIL  timed out after ${budget}s waiting for: $what" >&2
  echo "FAIL  timed out after ${budget}s waiting for: $what" >>"$EVIDENCE"
  echo "      evidence so far:" >&2
  sed 's/^/      /' "$EVIDENCE" >&2
  return 1
}

source tests/acceptance/pipeline_worker_auth.sh

# Preconditions are stated, not discovered halfway through. Without them the
# script would fail on a curl error several lines later, which reads like a
# product failure rather than a missing harness.
[ -f /tmp/data-kernel.pid ] || blocked "/tmp/data-kernel.pid is missing; this test needs the data-foundation platform (tests/ci/data_foundation_ci.sh)"
[ -f "$ROOT/data-ci/node-b/node-identity.json" ] || blocked "$ROOT/data-ci/node-b/node-identity.json is missing; this test needs the enrolled node from the harness"
KERNEL_PID="$(cat /tmp/data-kernel.pid)"
kill -0 "$KERNEL_PID" 2>/dev/null || blocked "the Kernel pid $KERNEL_PID in /tmp/data-kernel.pid is not running"
curl -fsS -o /dev/null -m 5 "$URL/livez" 2>/dev/null \
  || curl -fsS -o /dev/null -m 5 "${AUTH[@]}" "$URL/api/v1/nodes" 2>/dev/null \
  || blocked "the Kernel at $URL does not answer; this test cannot distinguish a product failure from a missing platform"

JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: long-heartbeat-$(date +%s%N)" --data-binary '{"pipelineId":"two-node-bulk","pipelineRevision":1,"input":{},"maxAttempts":2,"timeoutSeconds":300}' "$URL/api/v1/jobs" | json "d['jobId']")"
load_worker node-b

# 55 s between batches keeps the job comfortably longer than the 60 s lease TTL,
# so the heartbeat is doing real work rather than being incidental. The number
# is NOT what makes the test pass - the polls below are.
env OPSWEAVE_WORKER_KERNEL_URL="$URL" OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-b/node-identity.json" \
  OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID" OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN" \
  OPSWEAVE_WORKER_JOB_ID="$JOB" OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
  OPSWEAVE_WORKER_BATCH_DELAY_MS=55000 \
  ./target/debug/opsweave-pipeline-worker >/tmp/long-heartbeat.log 2>&1 &
WORKER_PID=$!
KERNEL_PID="$(cat /tmp/data-kernel.pid)"
restore_kernel() { kill -CONT "$KERNEL_PID" 2>/dev/null || true; }
trap restore_kernel EXIT

job_status() { q "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';"; }
job_lease() { q "SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id='$JOB';"; }
lease_field() { q "SELECT $1 FROM kernel.pipeline_job_leases WHERE lease_id='$2';"; }

# ---------------------------------------------------------------------------
# 1. Wait for the job to actually be executing. This replaces "assume it is
#    running by the time we have slept long enough".
# ---------------------------------------------------------------------------
is_running() { [ "$(job_status)" = "RUNNING" ] && echo "RUNNING"; }
until_state "the job to reach RUNNING" 60 is_running >/dev/null \
  || bad "the job never started executing; status=$(job_status)"
LEASE="$(until_state "the job to have a lease" 15 job_lease)" || bad "no lease was recorded"
ok "the job is RUNNING with lease $LEASE"
note "acquired_at=$(lease_field acquired_at "$LEASE")"

# ---------------------------------------------------------------------------
# 2. A heartbeat must land DURING execution. The condition is expressed against
#    the lease's own acquired_at, so it is true regardless of how long the job
#    takes - and the poll means a slow start cannot make it false.
# ---------------------------------------------------------------------------
heartbeat_after_acquire() {
  local hb
  hb="$(q "SELECT heartbeat_at FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE' AND heartbeat_at > acquired_at;")"
  [ -n "$hb" ] && echo "$hb"
}
HB_AT="$(until_state "a heartbeat after the lease was acquired" 45 heartbeat_after_acquire)" \
  || bad "no heartbeat was recorded after the lease was acquired"
ok "a heartbeat landed during execution: $HB_AT"

# ---------------------------------------------------------------------------
# 3. Take the Kernel away long enough that a heartbeat attempt must fail, then
#    bring it back. The outage is bounded by the same polling: we do not assume
#    it happened, we check that the heartbeat timestamp did NOT advance while
#    the Kernel was stopped, and DID advance after it returned.
# ---------------------------------------------------------------------------
HB_BEFORE_OUTAGE="$HB_AT"

# ---------------------------------------------------------------------------
# THE OUTAGE, and why it is a database lock rather than `kill -STOP`.
#
# `kill -STOP` on the Kernel was not an outage. Measured on 2026-11-14 the
# heartbeat timestamp advanced DURING the window, so the observation could not
# distinguish "no attempt failed" from "the attempt was queued and succeeded
# once the process resumed". A test that cannot tell those apart tests nothing.
#
# The heartbeat path is one transaction (`apps/kernel/src/jobs.rs::heartbeat`):
#
#     BEGIN
#     authorize_lease(...)
#     UPDATE kernel.pipeline_job_leases SET heartbeat_at=now(),expires_at=$2
#            WHERE lease_id=$1
#     COMMIT
#
# Holding a conflicting row lock makes that UPDATE block, and the worker's 5 s
# request timeout then fails the attempt for real. Two facts make this better
# than stopping the process:
#
#   * the failure is OBSERVABLE - `pg_locks` shows the waiter, so the script can
#     prove an attempt reached the Kernel and was blocked;
#   * it is REVERSIBLE - releasing the lock restores service without restarting
#     anything, so recovery is measured on the same lease.
# ---------------------------------------------------------------------------
hold_lease_lock() {
  # A session that takes the row lock and holds it for $1 seconds, in the
  # background. `pg_sleep` keeps the transaction open; the lock is released when
  # the session ends.
  psql "$DB" -qAt -v ON_ERROR_STOP=1 -c \
    "BEGIN; SELECT 1 FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE' FOR UPDATE; SELECT pg_sleep($1); COMMIT;" \
    >/tmp/long-heartbeat-lock.log 2>&1 &
  LOCK_PID=$!
}

lease_is_active() {
  local st
  st="$(q "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE';")"
  [ "$st" = "ACTIVE" ] && echo ACTIVE
}

# Wait until a heartbeat request is actually BLOCKED on the lock. This is the
# evidence that the outage existed: `pg_locks` with granted=false on the lease
# row means some backend is waiting for exactly the UPDATE above.
blocked_waiters() {
  q "SELECT count(*) FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.query LIKE '%pipeline_job_leases%'"
}

note "taking a row lock on the lease to force real heartbeat failures"
hold_lease_lock 12
# Bounded poll for a real blocked waiter instead of assuming the lock landed.
WAITER_SEEN=0
for _ in $(seq 1 40); do
  if [ "$(blocked_waiters 2>/dev/null || echo 0)" -ge 1 ]; then WAITER_SEEN=1; break; fi
  sleep 0.5
done
if [ "$WAITER_SEEN" = "1" ]; then
  ok "a heartbeat request was observably BLOCKED on the lease row (pg_locks granted=false)"
else
  blocked "no heartbeat request was ever observed waiting on the lease lock; the outage was not real"
fi

# The heartbeat must NOT advance while the lock is held. This is now a real
# observation: a blocked UPDATE cannot write, so an advanced timestamp would
# mean the lock was not held the way this script believes.
FROZEN="$(q "SELECT heartbeat_at FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE';")"
if [ -n "$FROZEN" ] && [ "$FROZEN" != "$HB_BEFORE_OUTAGE" ]; then
  bad "the heartbeat advanced to $FROZEN during the lock window (was $HB_BEFORE_OUTAGE): the lock did not block the UPDATE, so this run does not test recovery"
fi

wait "$LOCK_PID" 2>/dev/null || true
note "row lock released"
# Recovery is the same lease receiving a heartbeat again. No restart, no
# re-claim: the lock is the only thing that changed.
until_state "the Kernel to answer again" 30 is_running >/dev/null \
  || bad "the job left RUNNING after the lock was released"

# The heartbeat must advance after the outage: that is the recovery half.
heartbeat_advanced_since() {
  local since="$1"
  local hb
  hb="$(q "SELECT heartbeat_at FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE' AND heartbeat_at > '$since';")"
  [ -n "$hb" ] && echo "$hb"
}
HB_AFTER="$(until_state "a heartbeat after the outage" 60 heartbeat_advanced_since "$HB_BEFORE_OUTAGE")" \
  || bad "the heartbeat did not resume after the outage (last seen $HB_BEFORE_OUTAGE)"
ok "the heartbeat resumed after the outage: $HB_AFTER"

[ "$(lease_is_active)" = "ACTIVE" ] || bad "the lease left ACTIVE during the outage"
ok "the lease stayed ACTIVE across the outage"

# ---------------------------------------------------------------------------
# 4. The job must finish successfully, and the effects and records must be
#    exactly what the pipeline promises - not "at least".
# ---------------------------------------------------------------------------
job_finished() {
  local st
  st="$(job_status)"
  case "$st" in SUCCEEDED|FAILED|CANCELLED|LOST) echo "$st" ;; *) : ;; esac
}
FINAL="$(until_state "the job to reach a terminal state" 180 job_finished)" \
  || bad "the job never reached a terminal state; status=$(job_status)"
[ "$FINAL" = "SUCCEEDED" ] || bad "the long-running job ended $FINAL"
ok "the job reached SUCCEEDED"

# No duplicate Effect: the receipt table has exactly one row per batch.
EFFECTS="$(q "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
RECORDS="$(q "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID' AND source_batch_key LIKE 'job-$JOB-%';")"
[ "$EFFECTS" = "3" ] || bad "effects=$EFFECTS, expected exactly 3 (a duplicate Effect would make this larger)"
[ "$RECORDS" = "1001" ] || bad "records=$RECORDS, expected exactly 1001"

# The heartbeat count is reported, not asserted to a magic number: what matters
# is that at least one landed strictly inside the run, which step 2 established
# with a poll rather than a sleep.
HEARTBEATS_DURING="$(q "SELECT count(*) FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE' AND heartbeat_at > acquired_at;")"
note "heartbeats recorded after acquisition: $HEARTBEATS_DURING"

# The worker is NOT owned by this script alone.
#
# `data_foundation_ci.sh` starts the Nodes with `OPSWEAVE_NODE_WORKER_ENABLED=1`,
# so the Node's supervisor also spawns pipeline workers. After this script's
# worker finishes the job it can be handed another one and fail to claim it:
#
#   Error: claim failed (409 Conflict): JOB_ALREADY_CLAIMED
#
# Measured on 2026-11-14. That is the supervisor working as designed, not a
# failure of the job under test - which had already reached SUCCEEDED three
# assertions earlier.
#
# So the worker's exit code is REPORTED, and the verdict rests on what the
# database says the job did. Waiting for the exit and then checking status -
# the old order - also raced the opposite way: a status read while the worker
# was still finishing said SUCCEEDED before the script had looked at it.
WORKER_EXIT=0
wait "$WORKER_PID" || WORKER_EXIT=$?
if [ "$WORKER_EXIT" -ne 0 ]; then
  # A non-zero exit is only acceptable for ONE documented reason: the Node's
  # supervisor also polls this queue, so after this worker finished the job it
  # can be handed another and lose the claim race:
  #
  #   claim failed (409 Conflict): JOB_ALREADY_CLAIMED
  #
  # Any other non-zero exit is a failure of the worker under test, and reporting
  # it as "the job's outcome is asserted below" would let a crashed worker pass
  # on a job some OTHER worker completed.
  if grep -q 'JOB_ALREADY_CLAIMED' /tmp/long-heartbeat.log 2>/dev/null; then
    note "this worker exited $WORKER_EXIT with JOB_ALREADY_CLAIMED - the Node supervisor holds the job, which is the one allowed race"
  else
    tail -10 /tmp/long-heartbeat.log 2>/dev/null | sed 's/^/      /' || true
    bad "the worker this script started exited $WORKER_EXIT for a reason other than the documented supervisor race"
  fi
fi

# The verdict names what was and was not established.
#
#   PASS          the job ran, a heartbeat landed during execution, the lease
#                 stayed ACTIVE, and the job finished with exactly 3 effects and
#                 1001 records.
#   INCONCLUSIVE  all of the above, but the outage window produced no
#                 observable failed attempt, so "recovery after an outage" is
#                 not what this run proved. The heartbeat-during-execution half
#                 is still established.
#
# Nothing here upgrades INCONCLUSIVE to PASS, and nothing downgrades the
# measured half to nothing.
if [ "${INCONCLUSIVE:-0}" = "1" ]; then
  ok "long-running job kept its Lease via the independent heartbeat (job=$JOB lease=$LEASE records=$RECORDS effects=$EFFECTS)"
  echo "Long Heartbeat Golden Path: INCONCLUSIVE (the outage half was not observable; the heartbeat-during-execution half passed)"
  echo "evidence: $EVIDENCE"
  # NON-ZERO. "Not proven" must not be a green CI run.
  #
  # The previous version exited 0 here, so a run that never produced a real
  # heartbeat failure still gated as a pass - the exact substitution this
  # acceptance exists to prevent. Exit 2 is this repository's code for
  # "measured nothing conclusive" (conformance_matrix.py uses the same value).
  exit 2
fi
ok "long-running job kept its Lease via the independent heartbeat across an outage (job=$JOB lease=$LEASE records=$RECORDS effects=$EFFECTS)"
echo "Long Heartbeat Golden Path: PASS"
echo "evidence: $EVIDENCE"
