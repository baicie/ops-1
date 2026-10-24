#!/usr/bin/env bash
# A slow source must fail within its bounded timeout and must never create Sink effects.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SLOW_PID=""
cleanup() { [ -n "$SLOW_PID" ] && kill "$SLOW_PID" 2>/dev/null || true; rm -f "$ROOT/data-ci/node-b/worker-enabled"; }
trap cleanup EXIT
python3 tests/fixtures/slow_source.py 18091 25 >/tmp/slow-source.log 2>&1 &
SLOW_PID=$!
sleep 1
for plugin in opsweave.data-catalog opsweave.data-catalo; do
  if ! curl -fsS "${AUTH[@]}" "$URL/api/v1/gateway/$plugin/api/data-catalog/datasets/$DATASET_ID" >/dev/null 2>&1; then
    curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{"datasetId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"slow-source-hosts-'"$plugin"'","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}]}' "$URL/api/v1/gateway/$plugin/api/data-catalog/datasets" >/dev/null 2>&1 || true
  fi
done
python3 - <<'PY' >/tmp/slow-pipeline.json
import json
p=json.load(open('contracts/examples/pipeline-definition.json'))
p['pipelineId']='slow-source-timeout'
p['revision']=1
p['name']='Slow Source Timeout'
for n in p['nodes']:
    if n.get('type')=='builtin.source.http_json':
        n['config']['endpoint']='http://172.17.0.1:18091/slow.json'
        n['config']['timeoutSeconds']=20
for n in p['nodes']:
    if n.get('type')=='builtin.sink.dataset':
        n['config']['datasetId']='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
print(json.dumps(p))
PY
CODE="$(curl -sS -o /tmp/slow-publish.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary @/tmp/slow-pipeline.json "$URL/api/v1/pipelines")"
[ "$CODE" = "200" ] || { echo "slow pipeline publish=$CODE $(cat /tmp/slow-publish.json)"; exit 1; }
touch "$ROOT/data-ci/node-b/worker-enabled"
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: slow-source-$(date +%s%N)" --data-binary '{"pipelineId":"slow-source-timeout","pipelineRevision":1,"input":{},"maxAttempts":1,"timeoutSeconds":60}' "$URL/api/v1/jobs" | python3 -c 'import json,sys;print(json.load(sys.stdin)["jobId"])')"
echo "slow-source job=$JOB"
for _ in $(seq 1 90); do
  STATUS="$(psql "$DB" -qAt -c "SELECT status FROM kernel.pipeline_jobs WHERE job_id='$JOB';")"
  case "$STATUS" in SUCCEEDED|FAILED|CANCELLED) break;; esac
  sleep 1
done
[ "$STATUS" = "FAILED" ] || { echo "slow source status=$STATUS"; tail -40 /tmp/node-b.log; exit 1; }
RECORDS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_records WHERE dataset_id='$DATASET_ID' AND source_batch_key LIKE 'job-$JOB-%';")"
EFFECTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
RESULTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM kernel.pipeline_job_results WHERE job_id='$JOB';")"
[ "$RECORDS" = "0" ] || { echo "slow source created records=$RECORDS"; exit 1; }
[ "$EFFECTS" = "0" ] || { echo "slow source created effects=$EFFECTS"; exit 1; }
[ "$RESULTS" = "1" ] || { echo "slow source result count=$RESULTS"; exit 1; }
echo "PASS slow source timed out without Sink Effect (status=$STATUS records=$RECORDS effects=$EFFECTS result=$RESULTS)"
echo "Source Timeout No Sink: PASS"
