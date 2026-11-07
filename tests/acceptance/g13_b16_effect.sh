#!/usr/bin/env bash
# G13-B1.6 acceptance: a committed Evidence effect survives a crash window.
#
# The scenario is the one the database cannot tell apart from a process crash:
# the job is PENDING (its success was never confirmed), while the Evidence row
# for that job is already committed. A real Kernel process with the real worker
# loop must:
#
#   1. claim the job (fencing token 1);
#   2. find the job-scoped Evidence receipt BEFORE any plugin call;
#   3. skip collection entirely (there is no Node/instance/route in this fixture);
#   4. write SUCCEEDED with that evidence id, in one transaction with its audit.
#
# The fixture rows are inserted in ONE psql transaction so the worker can never
# observe the job before its evidence. This is a labelled fixture, not Zabbix:
# REAL_ZABBIX_VERIFIED = NOT_RUN.
#
# Requires OPSWEAVE_DATABASE_URL and a running Kernel on OPSWEAVE_DATABASE_URL
# (the worker starts with the process). Throw-away database only.
set -uo pipefail

DATABASE_URL="${OPSWEAVE_DATABASE_URL:?set OPSWEAVE_DATABASE_URL}"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
RUN="$(date +%s)-$$"
PASS=0; FAIL=0; FAILED=()
SERVICE_USER="00000000-0000-4000-8000-0000000000a1"
WORKSPACE="00000000-0000-4000-8000-000000000001"

ok()  { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); FAILED+=("$*"); printf 'FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
sql() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "$1"; }

curl -fsS -m 10 "$URL/livez" >/dev/null || { echo "the kernel is not reachable at $URL"; exit 2; }

SOURCE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
INCIDENT_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
PRINCIPAL_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
EVENT_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
JOB_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
EVIDENCE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NODE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NATIVE="b16-fixture-$RUN"
CONTENT_REF="sha256:$(python3 -c 'import hashlib;print(hashlib.sha256(b"b16-committed").hexdigest())')"

echo "== kernel: $URL   run: $RUN"
echo "== FIXTURE (not Zabbix): a PENDING job whose Evidence already committed"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL || { echo "fixture insert failed"; exit 2; }
BEGIN;
INSERT INTO kernel.nodes
  (id,name,control_token_hash,data_token,generation,os,arch,status,last_seen_at,enrolled_at)
VALUES
  ('$NODE_ID','b16-node-$RUN','hash','data-token',1,'linux','arm64','READY',now(),now());
INSERT INTO kernel.telemetry_sources
  (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
VALUES
  ('$SOURCE_ID','$WORKSPACE','zabbix-source','secretref:zabbix/b16',
   'https://zabbix.example/api_jsonrpc.php','VERIFY','READY');
INSERT INTO kernel.incidents
  (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
VALUES
  ('$INCIDENT_ID','b16 fixture automation failure','MAJOR','OPEN','ZABBIX',
   '$NATIVE',now(),'$SERVICE_USER','$WORKSPACE','AUTOMATION');
INSERT INTO kernel.automation_principals
  (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
   allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
VALUES
  ('$PRINCIPAL_ID','zabbix-source','$(python3 -c 'import uuid;print(uuid.uuid4())')',
   '$NODE_ID',1,'$WORKSPACE','$SOURCE_ID',
   ARRAY['SOURCE_COLLECT'],NULL,NULL,'{"windowSeconds":300,"evidenceBytes":1048576}'::jsonb,
   now(),now()+interval '5 minutes','$(python3 -c 'import uuid;print(uuid.uuid4())')');
INSERT INTO kernel.telemetry_events
  (event_id,workspace_id,source_id,native_id,idempotency_key,trigger_state,severity,
   occurred_at,observed_at,payload_digest,payload,late,incident_id)
VALUES
  ('$EVENT_ID','$WORKSPACE','$SOURCE_ID','$NATIVE','b16-key-$RUN','PROBLEM','MAJOR',
   now(),now(),'sha256:$(python3 -c 'print("c"*64)')','{}'::jsonb,false,'$INCIDENT_ID');
INSERT INTO kernel.automation_jobs
  (job_id,event_id,incident_id,principal_id,source_id,status,max_attempts)
VALUES
  ('$JOB_ID','$EVENT_ID','$INCIDENT_ID','$PRINCIPAL_ID','$SOURCE_ID','PENDING',3);
INSERT INTO kernel.incident_evidence
  (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust,
   verified_trust,verification_method,verified_at,submitted_by,automation_job_id)
VALUES
  ('$EVIDENCE_ID','$INCIDENT_ID','METRIC_SNAPSHOT','zabbix:effect',now(),'$CONTENT_REF',
   'OPERATOR_ASSERTED','OPERATOR_ASSERTED','OPERATOR_IDENTITY',now(),'$SERVICE_USER','$JOB_ID');
COMMIT;
SQL

echo "== waiting for the real worker to recover the committed effect"
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(sql "SELECT status FROM kernel.automation_jobs WHERE job_id='$JOB_ID'")"
  [ "$STATUS" = "SUCCEEDED" ] && break
  sleep 0.5
done
check "SUCCEEDED" "$STATUS" "the worker confirmed the job from the receipt"

EVIDENCE_STORED="$(sql "SELECT evidence_id FROM kernel.automation_jobs WHERE job_id='$JOB_ID'")"
check "$EVIDENCE_ID" "$EVIDENCE_STORED" "the job points at the already-committed evidence"
check "1" "$(sql "SELECT fencing_token FROM kernel.automation_jobs WHERE job_id='$JOB_ID'")" "the recovery used exactly one claim generation"
check "" "$(sql "SELECT COALESCE(lease_id::text,'') FROM kernel.automation_jobs WHERE job_id='$JOB_ID'")" "a terminal job carries no lease"
check "1" "$(sql "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id='$INCIDENT_ID'")" "exactly one evidence row"
check "1" "$(sql "SELECT count(*) FROM kernel.audit_events WHERE event_type='telemetry.automation.succeeded' AND details->>'jobId'='$JOB_ID'")" "exactly one success audit"
check "$CONTENT_REF" "$(sql "SELECT content_ref FROM kernel.incident_evidence WHERE evidence_id='$EVIDENCE_ID'")" "the committed contentRef was not replaced"

echo "== a second worker tick must not add anything"
sleep 3
check "1" "$(sql "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id='$INCIDENT_ID'")" "still one evidence row after another tick"
check "SUCCEEDED" "$(sql "SELECT status FROM kernel.automation_jobs WHERE job_id='$JOB_ID'")" "still SUCCEEDED"

echo "== cleanup (fixtures only)"
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.incident_evidence WHERE incident_id='$INCIDENT_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id='$INCIDENT_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.automation_jobs WHERE job_id='$JOB_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.telemetry_events WHERE event_id='$EVENT_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.automation_principals WHERE principal_id='$PRINCIPAL_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.incidents WHERE incident_id='$INCIDENT_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.telemetry_sources WHERE source_id='$SOURCE_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.nodes WHERE id='$NODE_ID'" 2>/dev/null

echo
printf 'g13_b16_effect: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed: %s\n' "${FAILED[*]}"
  exit 1
fi
exit 0
