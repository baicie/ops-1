#!/usr/bin/env bash
# Job IDOR / result / cancel authorization with two real users.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ADMIN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
ADMIN_AUTH=(-H "Authorization: Bearer $ADMIN")
PIPE=host-metrics-pipeline
STAMP="$(date +%s)"
B_EMAIL="operator-b-$STAMP@opsweave.local"
C_EMAIL="viewer-c-$STAMP@opsweave.local"
PASSWORD='OpsWeave!2026'
bad() { echo "FAIL  $*"; exit 1; }
json_get() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
mkuser() {
  curl -fsS "${ADMIN_AUTH[@]}" -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"displayName\":\"$2\",\"password\":\"$PASSWORD\",\"role\":\"$3\"}" \
    "$URL/api/v1/users" >/dev/null
}
login() {
  curl -fsS -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" "$URL/api/v1/auth/login" | json_get 'd["token"]'
}
mkuser "$B_EMAIL" 'Operator B' operator
mkuser "$C_EMAIL" 'Viewer C' viewer
B_TOKEN="$(login "$B_EMAIL")"
C_TOKEN="$(login "$C_EMAIL")"
B_AUTH=(-H "Authorization: Bearer $B_TOKEN")
C_AUTH=(-H "Authorization: Bearer $C_TOKEN")
DETAIL="$(curl -fsS "${ADMIN_AUTH[@]}" "$URL/api/v1/pipelines/$PIPE")"
REV="$(printf '%s' "$DETAIL" | json_get 'd["latestRevision"]')"
JOB="$(curl -fsS "${ADMIN_AUTH[@]}" -X POST -H 'content-type: application/json' -H "Idempotency-Key: authz-$STAMP" \
  -d "{\"pipelineId\":\"$PIPE\",\"pipelineRevision\":$REV,\"input\":{}}" "$URL/api/v1/jobs" | json_get 'd["jobId"]')"
[ -n "$JOB" ] || bad "job not created"
# Operator B cannot see or cancel A's job; 404 avoids UUID existence disclosure.
CODE="$(curl -sS -o /tmp/authz-b-get.json -w '%{http_code}' "${B_AUTH[@]}" "$URL/api/v1/jobs/$JOB")"
[ "$CODE" = "404" ] || bad "B get job=$CODE"
CODE="$(curl -sS -o /tmp/authz-b-result.json -w '%{http_code}' "${B_AUTH[@]}" "$URL/api/v1/jobs/$JOB/result")"
[ "$CODE" = "404" ] || bad "B result=$CODE"
CODE="$(curl -sS -o /tmp/authz-b-cancel.json -w '%{http_code}' "${B_AUTH[@]}" -X POST "$URL/api/v1/jobs/$JOB/cancel")"
[ "$CODE" = "404" ] || bad "B cancel=$CODE"
B_LIST="$(curl -fsS "${B_AUTH[@]}" "$URL/api/v1/jobs?limit=100")"
printf '%s' "$B_LIST" | python3 -c "import json,sys; assert all(x['jobId']!='$JOB' for x in json.load(sys.stdin)['items'])" || bad "B list leaked A job"
# Viewer may read summary but never result or cancel.
CODE="$(curl -sS -o /tmp/authz-c-get.json -w '%{http_code}' "${C_AUTH[@]}" "$URL/api/v1/jobs/$JOB")"
[ "$CODE" = "200" ] || bad "viewer summary=$CODE"
CODE="$(curl -sS -o /tmp/authz-b-diagnostics.json -w '%{http_code}' "${B_AUTH[@]}" "$URL/api/v1/jobs/$JOB/diagnostics")"
[ "$CODE" = "404" ] || bad "B diagnostics=$CODE"
CODE="$(curl -sS -o /tmp/authz-c-diagnostics.json -w '%{http_code}' "${C_AUTH[@]}" "$URL/api/v1/jobs/$JOB/diagnostics")"
[ "$CODE" = "403" ] || bad "viewer diagnostics=$CODE"
CODE="$(curl -sS -o /tmp/authz-c-result.json -w '%{http_code}' "${C_AUTH[@]}" "$URL/api/v1/jobs/$JOB/result")"
[ "$CODE" = "403" ] || bad "viewer result=$CODE"
CODE="$(curl -sS -o /tmp/authz-c-cancel.json -w '%{http_code}' "${C_AUTH[@]}" -X POST "$URL/api/v1/jobs/$JOB/cancel")"
[ "$CODE" = "403" ] || bad "viewer cancel=$CODE"
# Admin can cancel and read the durable terminal result.
CODE="$(curl -sS -o /tmp/authz-admin-cancel.json -w '%{http_code}' "${ADMIN_AUTH[@]}" -X POST "$URL/api/v1/jobs/$JOB/cancel")"
[ "$CODE" = "200" ] || bad "admin cancel=$CODE"
printf '%s' "$(cat /tmp/authz-admin-cancel.json)" | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"]=="CANCELLED"' || bad "cancel status"
CODE="$(curl -sS -o /tmp/authz-admin-result.json -w '%{http_code}' "${ADMIN_AUTH[@]}" "$URL/api/v1/jobs/$JOB/result")"
[ "$CODE" = "200" ] || bad "admin result=$CODE"
printf '%s' "$(cat /tmp/authz-admin-result.json)" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="CANCELLED"' || bad "result status"
DIAG="$(curl -fsS "${ADMIN_AUTH[@]}" "$URL/api/v1/jobs/$JOB/diagnostics")"
printf '%s' "$DIAG" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["jobId"]; assert len(d["events"])>=1; assert d["result"]["status"]=="CANCELLED"' || bad "diagnostics payload"
echo "PASS Job authorization owner/admin/viewer, list isolation, 404/403, admin cancel/result"
echo "Job Authorization: PASS"
