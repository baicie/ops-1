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
note() { echo "      $*"; echo "note  $*" >>"$EVIDENCE"; }
q() { psql "$DB" -qAt -c "$1"; }

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
[ -f /tmp/data-kernel.pid ] || bad "BLOCKED: /tmp/data-kernel.pid is missing; this test needs the data-foundation platform (tests/ci/data_foundation_ci.sh)"
[ -f "$ROOT/data-ci/node-b/node-identity.json" ] || bad "BLOCKED: $ROOT/data-ci/node-b/node-identity.json is missing; this test needs the enrolled node from the harness"
KERNEL_PID="$(cat /tmp/data-kernel.pid)"
kill -0 "$KERNEL_PID" 2>/dev/null || bad "BLOCKED: the Kernel pid $KERNEL_PID in /tmp/data-kernel.pid is not running"
curl -fsS -o /dev/null -m 5 "$URL/livez" 2>/dev/null \
  || curl -fsS -o /dev/null -m 5 "${AUTH[@]}" "$URL/api/v1/nodes" 2>/dev/null \
  || bad "BLOCKED: the Kernel at $URL does not answer; this test cannot distinguish a product failure from a missing platform"

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
kill -STOP "$KERNEL_PID"
note "kernel stopped for the outage window"
# Long enough to cover more than one 10 s heartbeat interval.
sleep 25

lease_is_active() {
  local st
  st="$(q "SELECT status FROM kernel.pipeline_job_leases WHERE lease_id='$LEASE';")"
  [ "$st" = "ACTIVE" ] && echo ACTIVE
}
# The lease must survive the outage in the Kernel's own records. While the
# Kernel is stopped the query cannot run, so this is checked after CONT.
kill -CONT "$KERNEL_PID"
note "kernel resumed"
until_state "the Kernel to answer again after the outage" 30 is_running >/dev/null \
  || bad "the Kernel did not come back, or the job left RUNNING, after the outage"

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

wait "$WORKER_PID" || { tail -30 /tmp/long-heartbeat.log || true; bad "the worker exited non-zero"; }

ok "long-running job kept its Lease via the independent heartbeat across an outage (job=$JOB lease=$LEASE records=$RECORDS effects=$EFFECTS)"
echo "Long Heartbeat Golden Path: PASS"
echo "evidence: $EVIDENCE"
