#!/usr/bin/env bash
# Real Catalog HTTP Fenced Sink across Deadline (Case A) and real HTTP lock-wait
# rejection (Case B). Uses a test-only Database trigger as the synchronization
# barrier; production code is not changed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CAT="$URL/api/v1/gateway/opsweave.data-catalog/api/data-catalog"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
bad() { echo "FAIL  $*"; exit 1; }
source tests/acceptance/pipeline_worker_auth.sh
claim_job() {
  local timeout="$1" key="$2" job claim
  job="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: deadline-http-$key-$(date +%s%N)" --data-binary "{\"pipelineId\":\"host-metrics-pipeline\",\"pipelineRevision\":1,\"input\":{},\"maxAttempts\":1,\"timeoutSeconds\":$timeout}" "$URL/api/v1/jobs" | json "d['jobId']")"
  load_worker node-a
  claim="$(curl -fsS "${W_HEADERS[@]}" -X POST -H 'content-type: application/json' --data-binary "$W_BODY" "$URL/internal/v1/pipeline-jobs/$job/claim")"
  echo "$job $(printf '%s' "$claim" | json "d['leaseId']") $(printf '%s' "$claim" | json "d['fencingSequence']")"
}
make_body() {
  local job="$1" lease="$2" fence="$3" suffix="$4"
  python3 - "$job" "$lease" "$fence" "$DATASET_ID" "$suffix" <<'PY'
import json,sys,hashlib
job,lease,fence,dataset,suffix=sys.argv[1:]
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(v): return 'sha256:'+hashlib.sha256(canonical(v)).hexdigest()
logical=f'deadline-{suffix}'
effect='efx:'+hashlib.sha256(canonical({'jobId':job,'pipelineId':'host-metrics-pipeline','pipelineRevision':1,'sinkNodeId':'sink','logicalBatchId':logical})).hexdigest()
records=[{'id':f'deadline-{suffix}-1','name':'one'},{'id':f'deadline-{suffix}-2','name':'two'}]
payload={'effectId':effect,'pipelineId':'host-metrics-pipeline','pipelineRevision':1,'sinkNodeId':'sink','logicalBatchId':logical,'schemaRevision':1,'sourceBatchKey':f'job-{job}-{logical}','records':records}
print(json.dumps({**payload,'requestDigest':digest(payload),'fence':{'jobId':job,'leaseId':lease,'fencingSequence':int(fence),'pipelineId':'host-metrics-pipeline','pipelineRevision':1},'source':{'kind':'test'}}))
PY
}
cleanup() {
  psql "$DB" -qAt -c "DROP TRIGGER IF EXISTS test_deadline_barrier ON plugin_opsweave_data_catalog.catalog_effect_receipts; DROP FUNCTION IF EXISTS plugin_opsweave_data_catalog.test_deadline_barrier();" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Case A: authorization must happen before deadline; the test-only trigger stalls
# only the Receipt INSERT, after authorization has returned.
read -r JOB_A LEASE_A FENCE_A <<< "$(claim_job 5 case-a)"
DEADLINE_A="$(psql "$DB" -qAt -c "SELECT epoch FROM (SELECT extract(epoch FROM deadline_at)::float8 AS epoch FROM kernel.pipeline_jobs WHERE job_id='$JOB_A') s;")"
psql "$DB" -qAt >/dev/null <<SQL
CREATE OR REPLACE FUNCTION plugin_opsweave_data_catalog.test_deadline_barrier() RETURNS trigger
LANGUAGE plpgsql AS \$fn\$
BEGIN
  IF NEW.job_id = '$JOB_A'::uuid THEN
    INSERT INTO plugin_opsweave_data_catalog.catalog_lineage
      (lineage_id,dataset_id,schema_revision,source_batch_key,source,accepted,rejected,unknown)
    VALUES (gen_random_uuid(),'$DATASET_ID','1','deadline-barrier-start','{"test":true}',0,0,0);
    PERFORM pg_sleep(7);
  END IF;
  RETURN NEW;
END \$fn\$;
CREATE TRIGGER test_deadline_barrier BEFORE INSERT ON plugin_opsweave_data_catalog.catalog_effect_receipts
FOR EACH ROW EXECUTE FUNCTION plugin_opsweave_data_catalog.test_deadline_barrier();
SQL
BODY_A="$(make_body "$JOB_A" "$LEASE_A" "$FENCE_A" case-a)"
AUTH_BEFORE="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_jobs WHERE job_id='$JOB_A' AND deadline_at > clock_timestamp();")"
[ "$AUTH_BEFORE" = "1" ] || bad "Case A authorization window already expired"
DATE_A="$(date -u +%FT%TZ)"
CODE_A="$(curl -sS -o /tmp/deadline-http-a.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$BODY_A" "$CAT/datasets/$DATASET_ID/fenced-records")"
DATE_A_DONE="$(date -u +%FT%TZ)"
EFFECT_A="$(printf '%s' "$BODY_A" | json "d['effectId']")"
[ "$CODE_A" = "201" ] || bad "Case A HTTP=$CODE_A body=$(cat /tmp/deadline-http-a.json)"
RECEIPT_A="$(psql "$DB" -qAt -F '|' -c "SELECT status,accepted,committed_at <= clock_timestamp(), (committed_at > (SELECT deadline_at FROM kernel.pipeline_jobs WHERE job_id='$JOB_A')) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE effect_id='$EFFECT_A';")"
COMMITTED_A="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE effect_id='$EFFECT_A' AND status='COMMITTED';")"
RECORDS_A="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE source_batch_key='job-$JOB_A-deadline-case-a';")"
LINEAGE_A="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_lineage WHERE source_batch_key='job-$JOB_A-deadline-case-a';")"
BARRIER="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_lineage WHERE source_batch_key='deadline-barrier-start' AND occurred_at <= (SELECT deadline_at FROM kernel.pipeline_jobs WHERE job_id='$JOB_A');")"
COMMITTED_AFTER="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE effect_id='$EFFECT_A' AND committed_at > (SELECT deadline_at FROM kernel.pipeline_jobs WHERE job_id='$JOB_A');")"
echo "Case A request_start=$DATE_A request_end=$DATE_A_DONE deadline=$DEADLINE_A code=$CODE_A receipt=$RECEIPT_A barrier_before_deadline=$BARRIER committed_after_deadline=$COMMITTED_AFTER"
[ "$COMMITTED_A" = "1" ] || bad "Case A receipt not COMMITTED"
[ "$RECORDS_A" = "2" ] || bad "Case A records=$RECORDS_A"
[ "$LINEAGE_A" = "1" ] || bad "Case A lineage=$LINEAGE_A"
[ "$BARRIER" = "1" ] || bad "Case A barrier did not enter before deadline"
[ "$COMMITTED_AFTER" = "1" ] || bad "Case A receipt did not commit after deadline"
psql "$DB" -qAt -c "DROP TRIGGER IF EXISTS test_deadline_barrier ON plugin_opsweave_data_catalog.catalog_effect_receipts; DROP FUNCTION IF EXISTS plugin_opsweave_data_catalog.test_deadline_barrier();" >/dev/null
echo "PASS Deadline/Sink Case A real HTTP commit across deadline"
# Case B: real HTTP request must enter the Job row-lock wait and be rejected after
# the deadline; no Receipt/Records/Lineage may be written.
read -r JOB_B LEASE_B FENCE_B <<< "$(claim_job 3 case-b)"
BODY_B="$(make_body "$JOB_B" "$LEASE_B" "$FENCE_B" case-b)"
psql "$DB" -qAt >/tmp/deadline-holder-http.log 2>&1 <<SQL &
BEGIN;
SELECT 1 FROM kernel.pipeline_jobs WHERE job_id='$JOB_B' FOR UPDATE;
SELECT pg_sleep(5);
COMMIT;
SQL
HOLDER=$!
sleep 0.5
curl -sS -o /tmp/deadline-http-b.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary "$BODY_B" "$CAT/datasets/$DATASET_ID/fenced-records" >/tmp/deadline-http-b.code &
CURL_PID=$!
for _ in $(seq 1 60); do
  WAITING="$(psql "$DB" -qAt -c "SELECT count(*) FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE '%fence_authorize_effect%';")"
  [ "$WAITING" -ge 1 ] && break
  sleep 0.2
done
[ "$WAITING" -ge 1 ] || { echo "no Catalog transaction observed waiting on lock"; exit 1; }
wait "$HOLDER"
wait "$CURL_PID" || true
CODE_B="$(cat /tmp/deadline-http-b.code)"
BODY_CODE="$(python3 -c 'import json;d=json.load(open("/tmp/deadline-http-b.json"));print(d.get("code",""))' 2>/dev/null || true)"
BODY_MESSAGE="$(python3 -c 'import json;d=json.load(open("/tmp/deadline-http-b.json"));print(d.get("message",""))' 2>/dev/null || true)"
RECEIPT_B="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB_B';")"
RECORDS_B="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE source_batch_key='job-$JOB_B-deadline-case-b';")"
LINEAGE_B="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_lineage WHERE source_batch_key='job-$JOB_B-deadline-case-b';")"
echo "Case B HTTP=$CODE_B code=$BODY_CODE message=$BODY_MESSAGE receipts=$RECEIPT_B records=$RECORDS_B lineage=$LINEAGE_B"
[ "$CODE_B" = "409" ] || bad "Case B HTTP=$CODE_B expected 409"
[ "$BODY_CODE" = "STALE_FENCE" ] || bad "Case B code=$BODY_CODE"
grep -q 'JOB_DEADLINE_EXCEEDED' /tmp/deadline-http-b.json || bad "Case B message lacks JOB_DEADLINE_EXCEEDED"
[ "$RECEIPT_B" = "0" ] || bad "Case B receipt rows=$RECEIPT_B"
[ "$RECORDS_B" = "0" ] || bad "Case B record rows=$RECORDS_B"
[ "$LINEAGE_B" = "0" ] || bad "Case B lineage rows=$LINEAGE_B"
echo "PASS Deadline/Sink Case B real HTTP lock-wait rejection"
echo "Deadline Sink HTTP: PASS"
