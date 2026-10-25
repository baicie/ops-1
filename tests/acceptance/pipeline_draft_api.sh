#!/usr/bin/env bash
# Draft persistence and optimistic concurrency against real PostgreSQL.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
PIPE=host-metrics-pipeline
bad() { echo "FAIL  $*"; exit 1; }
PUB_BEFORE="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/revisions/1" | sha256sum | cut -d' ' -f1)"
CREATE_CODE="$(curl -sS -o /tmp/draft-create.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -H 'accept: application/json' -d '{}' "$URL/api/v1/pipelines/$PIPE/drafts")"
if [ "$CREATE_CODE" != "201" ]; then echo "FAIL  draft create expected 201 got $CREATE_CODE: $(cat /tmp/draft-create.json)"; exit 1; fi
CREATE="$(cat /tmp/draft-create.json)"
DRAFT_ID="$(printf '%s' "$CREATE" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="DRAFT" and d["version"]==1; print(d["draftId"])')"
DEF="$(printf '%s' "$CREATE" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["definition"]))')"
EDIT="$(printf '%s' "$DEF" | python3 -c 'import json,sys; d=json.load(sys.stdin); n=next(n for n in d["nodes"] if n["type"]=="builtin.map.fields"); n["config"]["mappings"]=[{"from":"host","to":"host"}]; print(json.dumps(d))')"
UPD="$(curl -fsS "${AUTH[@]}" -X PUT -H 'content-type: application/json' -H 'If-Match: 1' -d "$EDIT" "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT_ID")"
printf '%s' "$UPD" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["version"]==2 and d["definition"]["status"]=="DRAFT" and d["definitionDigest"].startswith("sha256:")' || bad "draft update"
CODE="$(curl -sS -o /tmp/draft-conflict.json -w '%{http_code}' "${AUTH[@]}" -X PUT -H 'content-type: application/json' -H 'If-Match: 1' -d "$EDIT" "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT_ID")"
[ "$CODE" = "409" ] || bad "stale version expected 409 got $CODE"
printf '%s' "$(cat /tmp/draft-conflict.json)" | python3 -c 'import json,sys; assert json.load(sys.stdin)["code"]=="DRAFT_VERSION_CONFLICT"' || bad "conflict code"
READ="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT_ID")"
printf '%s' "$READ" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["version"]==2; assert d["definition"]["nodes"][2]["config"]["mappings"][0]["from"]=="host"' || bad "draft not persisted"
LIST="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/drafts")"
printf '%s' "$LIST" | python3 -c "import json,sys; d=json.load(sys.stdin); assert any(x['draftId']=='$DRAFT_ID' for x in d)" || bad "draft list"
PUB_AFTER="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/revisions/1" | sha256sum | cut -d' ' -f1)"
[ "$PUB_BEFORE" = "$PUB_AFTER" ] || bad "published revision changed by draft write"
CODE="$(curl -sS -o /tmp/draft-missing.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{"baseRevision":999}' "$URL/api/v1/pipelines/$PIPE/drafts")"
[ "$CODE" = "400" ] || bad "invalid base revision=$CODE"
CODE="$(curl -sS -o /tmp/draft-unauth.json -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$URL/api/v1/pipelines/$PIPE/drafts")"
[ "$CODE" = "401" ] || bad "unauth draft=$CODE"
echo "PASS Draft API create/update/read/list, optimistic 409, immutability, 400/401"
echo "Pipeline Draft API: PASS"
