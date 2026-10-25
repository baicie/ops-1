#!/usr/bin/env bash
# Job list filters and stable pagination; no browser-side fabricated status.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
bad() { echo "FAIL  $*"; exit 1; }
LIST="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/jobs?limit=1")"
printf '%s' "$LIST" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "items" in d; assert len(d["items"])<=1; assert d.get("nextCursor") is None or len(d["nextCursor"])>0' || bad "list shape"
PIPELINE="$(printf '%s' "$LIST" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["items"][0]["pipelineId"] if d["items"] else "host-metrics-pipeline")')"
FILTER="$(curl -fsS "${AUTH[@]}" --get --data-urlencode "pipelineId=$PIPELINE" --data-urlencode "limit=5" "$URL/api/v1/jobs")"
printf '%s' "$FILTER" | python3 -c "import json,sys; d=json.load(sys.stdin); assert all(x['pipelineId']=='$PIPELINE' for x in d['items'])" || bad "pipeline filter"
CODE="$(curl -sS -o /tmp/job-list-bad-status.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/jobs?status=NOT_A_STATUS")"
[ "$CODE" = "400" ] || bad "invalid status filter=$CODE"
CODE="$(curl -sS -o /tmp/job-list-unauth.json -w '%{http_code}' "$URL/api/v1/jobs")"
[ "$CODE" = "401" ] || bad "unauth jobs=$CODE"
echo "PASS Job List API shape/filter/pagination bounds, 400/401"
echo "Job List API: PASS"
