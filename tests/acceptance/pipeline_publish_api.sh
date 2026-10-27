#!/usr/bin/env bash
# Atomic draft publish, immutable old revision, idempotency and stale version.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
PIPE=host-metrics-pipeline
bad() { echo "FAIL  $*"; exit 1; }
json_get() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
OLD_BEFORE="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/revisions/1")"
OLD_HASH="$(printf '%s' "$OLD_BEFORE" | sha256sum | cut -d' ' -f1)"
BEFORE_REV="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | json_get 'd["latestRevision"]')"
CREATE="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{}' "$URL/api/v1/pipelines/$PIPE/drafts")"
DRAFT_ID="$(printf '%s' "$CREATE" | json_get 'd["draftId"]')"
KEY="publish-$(date +%s)-$RANDOM"
PUB="$(curl -fsS "${AUTH[@]}" -X POST -H "Idempotency-Key: $KEY" -H 'If-Match: 1' "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT_ID/publish")"
NEW_REV="$(printf '%s' "$PUB" | json_get 'd["revision"]')"
[ "$NEW_REV" -gt "$BEFORE_REV" ] || bad "revision did not advance"
printf '%s' "$PUB" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="PUBLISHED"; assert d["definition"]["status"]=="PUBLISHED"; assert d["digest"].startswith("sha256:")' || bad "publish DTO"
RETRY="$(curl -fsS "${AUTH[@]}" -X POST -H "Idempotency-Key: $KEY" -H 'If-Match: 1' "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT_ID/publish")"
printf '%s' "$RETRY" | python3 -c "import json,sys; assert json.load(sys.stdin)['revision']==$NEW_REV" || bad "idempotent publish returned another revision"
OLD_AFTER="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE/revisions/1")"
[ "$OLD_HASH" = "$(printf '%s' "$OLD_AFTER" | sha256sum | cut -d' ' -f1)" ] || bad "old revision mutated"
# A different draft cannot reuse the idempotency key.
CREATE2="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{}' "$URL/api/v1/pipelines/$PIPE/drafts")"
DRAFT2="$(printf '%s' "$CREATE2" | json_get 'd["draftId"]')"
CODE="$(curl -sS -o /tmp/publish-key-conflict.json -w '%{http_code}' "${AUTH[@]}" -X POST -H "Idempotency-Key: $KEY" -H 'If-Match: 1' "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT2/publish")"
[ "$CODE" = "409" ] || bad "idempotency reuse=$CODE"
printf '%s' "$(cat /tmp/publish-key-conflict.json)" | python3 -c 'import json,sys; assert json.load(sys.stdin)["code"]=="IDEMPOTENCY_CONFLICT"' || bad "idempotency code"
# Stale draft version is rejected before writing.
CODE="$(curl -sS -o /tmp/publish-stale.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'Idempotency-Key: stale-key' -H 'If-Match: 99' "$URL/api/v1/pipelines/$PIPE/drafts/$DRAFT2/publish")"
[ "$CODE" = "409" ] || bad "stale draft=$CODE"
# Invalid topology is rejected and must not allocate a revision.
BADCREATE="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{}' "$URL/api/v1/pipelines/$PIPE/drafts")"
BADDRAFT="$(printf '%s' "$BADCREATE" | json_get 'd["draftId"]')"
BADDEF="$(printf '%s' "$BADCREATE" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["definition"]["edges"][0]["dataType"]="integer"; print(json.dumps(d["definition"]))')"
curl -fsS "${AUTH[@]}" -X PUT -H 'content-type: application/json' -H 'If-Match: 1' -d "{\"definition\":$BADDEF}" "$URL/api/v1/pipelines/$PIPE/drafts/$BADDRAFT" >/dev/null
REV_BEFORE_BAD="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | json_get 'd["latestRevision"]')"
CODE="$(curl -sS -o /tmp/publish-bad.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'Idempotency-Key: bad-publish' -H 'If-Match: 2' "$URL/api/v1/pipelines/$PIPE/drafts/$BADDRAFT/publish")"
[ "$CODE" = "400" ] || bad "invalid publish=$CODE"
REV_AFTER_BAD="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | json_get 'd["latestRevision"]')"
[ "$REV_BEFORE_BAD" = "$REV_AFTER_BAD" ] || bad "invalid publish mutated latestRevision"
echo "PASS Publish atomic/idempotent/immutable/stale/invalid, new revision=$NEW_REV"
echo "Pipeline Publish API: PASS"
