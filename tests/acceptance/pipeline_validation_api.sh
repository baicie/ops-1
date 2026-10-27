#!/usr/bin/env bash
# Server validation is pure: valid/invalid outcomes must not create revisions/jobs.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
PIPE=host-metrics-pipeline
bad() { echo "FAIL  $*"; exit 1; }
BEFORE="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["latestRevision"], sum(len(r["definition"]["nodes"]) for r in [d["latest"]]))')"
DEF="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["latest"]["definition"]))')"
VALID="$(curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d "$DEF" "$URL/api/v1/pipelines/validate")"
printf '%s' "$VALID" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["valid"] is True, d; assert d["errors"]==[]' || bad "valid definition rejected"
INVALID="$(printf '%s' "$DEF" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["edges"][0]["dataType"]="integer"; print(json.dumps(d))' | curl -fsS "${AUTH[@]}" -X POST -H 'content-type: application/json' -d @- "$URL/api/v1/pipelines/validate")"
printf '%s' "$INVALID" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["valid"] is False; assert any(e["code"] in ("TYPE_MISMATCH","PIPELINE_DIGEST_MISMATCH") for e in d["errors"]), d' || bad "invalid definition accepted"
AFTER="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/pipelines/$PIPE" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["latestRevision"], sum(len(r["definition"]["nodes"]) for r in [d["latest"]]))')"
[ "$BEFORE" = "$AFTER" ] || bad "validation mutated revision"
CODE="$(curl -sS -o /tmp/validation-unauth.json -w '%{http_code}' -X POST -H 'content-type: application/json' -d "$DEF" "$URL/api/v1/pipelines/validate")"
[ "$CODE" = "401" ] || bad "unauth validate=$CODE"
echo "PASS Pipeline Validation API valid/invalid, no revision mutation, 401"
echo "Pipeline Validation API: PASS"
