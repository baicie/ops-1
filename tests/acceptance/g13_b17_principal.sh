#!/usr/bin/env bash
# G13-B1.7 acceptance: persisted jobs survive credential expiry, and an explicit
# authorization change stops them with a stable terminal reason.
#
# Three jobs are seeded for a REAL Kernel worker:
#
#   A. the enqueue-time principal token expired an hour ago; the source, node and
#      workspace are still valid, but there is no plugin route. The worker must
#      EXECUTE it: the retryable route failure leaves RETRY_WAIT, never
#      FAILED_FINAL/AUTOMATION_PRINCIPAL_EXPIRED.
#   B. the principal was revoked. The worker must not call the plugin and must
#      end FAILED_FINAL with AUTOMATION_PRINCIPAL_REVOKED.
#   C. the source was disabled after enqueue. The worker must end FAILED_FINAL
#      with AUTOMATION_SOURCE_NOT_READY.
#
# Fixtures are labelled and inserted over psql; no live Zabbix or Node is used.
# REAL_ZABBIX_VERIFIED = NOT_RUN. Requires OPSWEAVE_DATABASE_URL and a running
# Kernel on OPSWEAVE_URL (its worker loop is the system under test).
set -uo pipefail

DATABASE_URL="${OPSWEAVE_DATABASE_URL:?set OPSWEAVE_DATABASE_URL}"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
RUN="$(date +%s)-$$"
PASS=0; FAIL=0; FAILED=()
SERVICE_USER="00000000-0000-4000-8000-0000000000a1"
WORKSPACE="00000000-0000-4000-8000-000000000001"
NODE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"

ok()  { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); FAILED+=("$*"); printf 'FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
sql() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$1"; }

curl -fsS -m 10 "$URL/livez" >/dev/null || { echo "the kernel is not reachable at $URL"; exit 2; }

echo "== kernel: $URL   run: $RUN"
echo "== FIXTURE: one node, three sources/principals/jobs (not Zabbix)"

sql "INSERT INTO kernel.nodes
       (id,name,control_token_hash,data_token,generation,os,arch,status,last_seen_at,enrolled_at)
     VALUES ('$NODE_ID','b17-node-$RUN','hash','data-token',1,'linux','arm64','READY',now(),now())" >/dev/null

seed_job() { # name source_state principal_mode -> prints "source principal incident event job"
  local name="$1" source_state="$2" principal_mode="$3"
  local source incident principal event job
  source="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  incident="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  principal="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  event="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  job="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  local issued="now()" expires="now()+interval '5 minutes'" revoked="NULL"
  case "$principal_mode" in
    expired) issued="now()-interval '2 hours'"; expires="now()-interval '1 hour'" ;;
    revoked) revoked="now()" ;;
  esac
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL || return 1
BEGIN;
INSERT INTO kernel.telemetry_sources
  (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state,automation_item_ids)
VALUES
  ('$source','$WORKSPACE','zabbix-source','secretref:zabbix/b17-$name',
   'https://zabbix.example/api_jsonrpc.php','VERIFY','$source_state',ARRAY['12345']);
INSERT INTO kernel.incidents
  (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
VALUES
  ('$incident','b17 $name fixture','MAJOR','OPEN','ZABBIX','b17-$name-$RUN',now(),
   '$SERVICE_USER','$WORKSPACE','AUTOMATION');
INSERT INTO kernel.automation_principals
  (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
   allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti,revoked_at)
VALUES
  ('$principal','zabbix-source','$(python3 -c 'import uuid;print(uuid.uuid4())')','$NODE_ID',1,
   '$WORKSPACE','$source',ARRAY['SOURCE_COLLECT'],NULL,NULL,
   jsonb_build_object('collections',8,'windowSeconds',300,'evidenceBytes',1048576),
   $issued,$expires,'$(python3 -c 'import uuid;print(uuid.uuid4())')',$revoked);
INSERT INTO kernel.telemetry_events
  (event_id,workspace_id,source_id,native_id,idempotency_key,trigger_state,severity,
   occurred_at,observed_at,payload_digest,payload,late,incident_id)
VALUES
  ('$event','$WORKSPACE','$source','b17-$name-$RUN','b17-key-$name-$RUN','PROBLEM','MAJOR',
   now(),now(),'sha256:$(python3 -c 'print("d"*64)')','{}'::jsonb,false,'$incident');
INSERT INTO kernel.automation_jobs
  (job_id,event_id,incident_id,principal_id,source_id,status,max_attempts)
VALUES
  ('$job','$event','$incident','$principal','$source','PENDING',3);
COMMIT;
SQL
  printf '%s %s %s %s %s\n' "$source" "$principal" "$incident" "$event" "$job"
}

read -r SRC_A PRIN_A INC_A EVT_A JOB_A <<<"$(seed_job expired-token READY expired)" || exit 2
read -r SRC_B PRIN_B INC_B EVT_B JOB_B <<<"$(seed_job revoked-principal READY revoked)" || exit 2
read -r SRC_C PRIN_C INC_C EVT_C JOB_C <<<"$(seed_job disabled-source DISABLED valid)" || exit 2
for id in "$JOB_A" "$JOB_B" "$JOB_C"; do
  [ -n "$id" ] || { echo "a fixture job was not created"; exit 2; }
done

wait_for() { # job expected_status -> actual status
  local job="$1" expected="$2" status=""
  for _ in $(seq 1 80); do
    status="$(sql "SELECT status FROM kernel.automation_jobs WHERE job_id='$job'")"
    [ "$status" = "$expected" ] && break
    sleep 0.5
  done
  printf '%s' "$status"
}

echo
echo "== A. an expired enqueue token does not kill a persisted job"
STATUS="$(wait_for "$JOB_A" RETRY_WAIT)"
check "RETRY_WAIT" "$STATUS" "the expired-principal job is retryable, not failed final"
check "AUTOMATION_INSTANCE_UNAVAILABLE" \
  "$(sql "SELECT last_error_code FROM kernel.automation_jobs WHERE job_id='$JOB_A'")" \
  "the failure is the (retryable) missing route, not principal expiry"
check "1" "$(sql "SELECT attempts FROM kernel.automation_jobs WHERE job_id='$JOB_A'")" \
  "the job really executed one attempt"

echo
echo "== B. a revoked principal stops the job with its reason"
STATUS="$(wait_for "$JOB_B" FAILED_FINAL)"
check "FAILED_FINAL" "$STATUS" "the revoked-principal job is terminal"
check "AUTOMATION_PRINCIPAL_REVOKED" \
  "$(sql "SELECT last_error_code FROM kernel.automation_jobs WHERE job_id='$JOB_B'")" \
  "the terminal reason names revocation"
check "1" "$(sql "SELECT count(*) FROM kernel.audit_events
                   WHERE event_type='telemetry.automation.attempt_failed'
                     AND details->>'jobId'='$JOB_B' AND details->>'code'='AUTOMATION_PRINCIPAL_REVOKED'")" \
  "the refusal is audited with the same code"

echo
echo "== C. a disabled source stops the job with its reason"
STATUS="$(wait_for "$JOB_C" FAILED_FINAL)"
check "FAILED_FINAL" "$STATUS" "the disabled-source job is terminal"
check "AUTOMATION_SOURCE_NOT_READY" \
  "$(sql "SELECT last_error_code FROM kernel.automation_jobs WHERE job_id='$JOB_C'")" \
  "the terminal reason names the source state"

echo
echo "== no job is left RUNNING and no expired-token reason exists"
check "0" "$(sql "SELECT count(*) FROM kernel.automation_jobs
                   WHERE job_id IN ('$JOB_A','$JOB_B','$JOB_C') AND status='RUNNING'")" \
  "no fixture job is RUNNING"
check "0" "$(sql "SELECT count(*) FROM kernel.automation_jobs
                   WHERE job_id IN ('$JOB_A','$JOB_B','$JOB_C')
                     AND last_error_code='AUTOMATION_PRINCIPAL_EXPIRED'")" \
  "no job failed for token expiry"

echo "== cleanup (fixtures only)"
for pair in "$INC_A:$EVT_A:$JOB_A:$PRIN_A:$SRC_A" "$INC_B:$EVT_B:$JOB_B:$PRIN_B:$SRC_B" "$INC_C:$EVT_C:$JOB_C:$PRIN_C:$SRC_C"; do
  IFS=: read -r inc evt job prin src <<<"$pair"
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id='$inc'" 2>/dev/null
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.incident_evidence WHERE incident_id='$inc'" 2>/dev/null
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.automation_jobs WHERE job_id='$job'" 2>/dev/null
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.telemetry_events WHERE event_id='$evt'" 2>/dev/null
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.automation_principals WHERE principal_id='$prin'" 2>/dev/null
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.incidents WHERE incident_id='$inc'" 2>/dev/null
  psql "$DATABASE_URL" -q -c "DELETE FROM kernel.telemetry_sources WHERE source_id='$src'" 2>/dev/null
done
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.nodes WHERE id='$NODE_ID'" 2>/dev/null

echo
printf 'g13_b17_principal: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed: %s\n' "${FAILED[*]}"
  exit 1
fi
exit 0
