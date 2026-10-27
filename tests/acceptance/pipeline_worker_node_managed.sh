#!/usr/bin/env bash
# Node Runtime-managed worker: no manual job id and no manual worker process.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
DATASET_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
PIPELINE_ID="$(python3 -c 'import json;print(json.load(open("contracts/examples/pipeline-definition.json"))["pipelineId"])')"
MARKER="$ROOT/data-ci/node-b/worker-enabled"
touch "$MARKER"
JOB="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: node-managed-$(date +%s%N)" --data-binary "{\"pipelineId\":\"$PIPELINE_ID\",\"pipelineRevision\":1,\"input\":{},\"maxAttempts\":4,\"timeoutSeconds\":300}" "$URL/api/v1/jobs" | json "d['jobId']")"
echo "submitted $JOB for node-managed execution"
STATUS=""
for _ in $(seq 1 90); do
  STATUS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs/$JOB" | json "d['status']")"
  [ "$STATUS" = "SUCCEEDED" ] && break
  sleep 2
done
[ "$STATUS" = "SUCCEEDED" ] || bad "node-managed job status=$STATUS"
WORKER="$(psql "$DB" -qAt -c "SELECT worker_id FROM kernel.pipeline_job_leases WHERE job_id='$JOB' ORDER BY fencing_sequence DESC LIMIT 1;")"
NODE_ID="$(python3 -c 'import json;print(json.load(open("data-ci/node-b/node-identity.json"))["nodeId"])')"
case "$WORKER" in *"$NODE_ID"*) ;; *) bad "worker $WORKER is not bound to node $NODE_ID";; esac
RECEIPTS="$(psql "$DB" -qAt -c "SELECT count(*) FROM plugin_opsweave_data_catalog.catalog_effect_receipts WHERE job_id='$JOB';")"
[ "$RECEIPTS" -ge 1 ] || bad "no effect receipt for node-managed job"
ok "Node Runtime auto-claimed and completed job without manual worker invocation (node $NODE_ID, receipts $RECEIPTS)"
rm -f "$MARKER"
echo "Node-managed Worker Golden Path: PASS"
