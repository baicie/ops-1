#!/usr/bin/env bash
# Read-only Pipeline API contract: list/detail/revisions/revision.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
bad() { echo "FAIL  $*"; exit 1; }
PIPE=host-metrics-pipeline
# Seed a revision through the existing write API; GET endpoints must reflect it.
curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' --data-binary @contracts/examples/pipeline-definition.json "$URL/api/v1/pipelines" >/dev/null
LIST="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines?limit=1")"
COUNT="$(printf '%s' "$LIST" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')"
[ "$COUNT" -ge 1 ] || bad "list empty"
printf '%s' "$LIST" | python3 -c 'import json,sys; d=json.load(sys.stdin); i=d["items"][0]; assert i["pipelineId"] and i["name"] and i["latestRevision"]>=1' || bad "list DTO"
DETAIL="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE")"
printf '%s' "$DETAIL" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["pipelineId"]=="host-metrics-pipeline"; assert d["latest"]["definition"]["pipelineId"]=="host-metrics-pipeline"; assert d["latest"]["digest"].startswith("sha256:")' || bad "detail DTO"
REVS="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/revisions?limit=1")"
printf '%s' "$REVS" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d["items"])==1; assert d["items"][0]["revision"]>=1' || bad "revisions DTO"
REV="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/revisions/1")"
printf '%s' "$REV" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["revision"]==1 and d["definition"]["revision"]==1' || bad "revision DTO"
CODE="$(curl -sS -o /tmp/pipeline-read-missing.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/pipelines/missing-pipeline")"
[ "$CODE" = "404" ] || bad "missing detail=$CODE"
CODE="$(curl -sS -o /tmp/pipeline-read-cursor.json -w '%{http_code}' "${AUTH[@]}" "$URL/api/v1/pipelines?cursor=not*base64")"
[ "$CODE" = "400" ] || bad "invalid cursor=$CODE"
CODE="$(curl -sS -o /tmp/pipeline-read-unauth.json -w '%{http_code}' "$URL/api/v1/pipelines")"
[ "$CODE" = "401" ] || bad "unauth list=$CODE"
# Stable pagination: page 2 starts after the cursor and does not repeat page 1.
CURSOR="$(printf '%s' "$LIST" | json "d.get('nextCursor') or ''")"
if [ -n "$CURSOR" ]; then
  NEXT="$(curl -fsS "${AUTH[@]}" --get --data-urlencode "limit=1" --data-urlencode "cursor=$CURSOR" "$URL/api/v1/pipelines")"
  FIRST="$(printf '%s' "$LIST" | json "d['items'][0]['pipelineId']")"
  SECOND="$(printf '%s' "$NEXT" | json "d['items'][0]['pipelineId']")"
  [ "$FIRST" != "$SECOND" ] || bad "pagination repeated pipeline"
fi
echo "PASS Pipeline Read API list/detail/revisions/revision, 400/401/404 and pagination"
echo "Pipeline Read API: PASS"
