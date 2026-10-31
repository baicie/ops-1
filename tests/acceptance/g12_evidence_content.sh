#!/usr/bin/env bash
# G12 Phase B acceptance: evidence CONTENT - stored bytes, a server-computed digest, a read path
# that can say "not here", "expired", "corrupt" and "not yours", and a writer that cannot rewrite
# what it stored.
#
# Everything here is a real HTTP call against a real kernel with a real PostgreSQL behind it. It
# creates its own accounts through the admin API, so it must run against a throw-away database:
#   OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_DATABASE_URL=postgres://localhost/x \
#   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... tests/acceptance/g12_evidence_content.sh
#
# OPSWEAVE_DATABASE_URL is used for exactly two things, neither of which a client can do:
#   * proving a direct UPDATE of stored content is refused by the database itself (step 6a);
#   * producing a corruption and an expired row, which are states no API call can create.
# The digest assertions never use the database as the source of truth: they recompute sha256
# with python3 over the bytes the kernel returned. A missing environment variable is a named
# refusal rather than a silent default, because a run against the wrong kernel is worse than no
# run at all.
URL="$OPSWEAVE_URL"; [ -n "$URL" ] || URL=http://127.0.0.1:18199
ADMIN_EMAIL="$OPSWEAVE_ADMIN_EMAIL"
ADMIN_PASSWORD="$OPSWEAVE_ADMIN_PASSWORD"
DB="$OPSWEAVE_DATABASE_URL"
CANARY_PORT="$OPSWEAVE_CANARY_PORT"; [ -n "$CANARY_PORT" ] || CANARY_PORT=18198
if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ] || [ -z "$DB" ]; then
  echo "set OPSWEAVE_ADMIN_EMAIL, OPSWEAVE_ADMIN_PASSWORD and OPSWEAVE_DATABASE_URL"; exit 2
fi
# Only now that every environment read is done. Before it, an unset optional variable
# would abort the run with bash unbound-variable noise instead of a named refusal.
set -uo pipefail
RUN="$(date +%s)-$$"
WORK="$(mktemp -d)"
PASS=0; FAIL=0; FAILED_LIST=""

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED_LIST="$FAILED_LIST
  $*"; printf 'FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
step() { printf '\n######## %s ########\n' "$*"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
compact() { python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), separators=(",",":")))
except Exception:
    sys.stdin.seek(0)
    print(sys.stdin.read().strip()[:400])' < "$1"; }
sha256_of() { python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
header_of() { python3 -c 'import sys;print(dict(l.split(": ",1) for l in sys.stdin.read().split("\r\n") if ": " in l).get(sys.argv[1],"").strip())' "$1"; }

# curl's arguments are collected with "set --" rather than in an array, so every expansion here
# stays a plain "$@" / "$1" form.
call() { # jar csrf method path [body] -> echoes status, prints request+response
  local jar="$1" csrf="$2" method="$3" path="$4" body=""
  [ "$#" -ge 5 ] && body="$5"
  set -- -sS -m 20 -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' -X "$method"
  [ -n "$jar" ] && set -- "$@" -b "$jar"
  [ -n "$csrf" ] && set -- "$@" -H "x-csrf-token: $csrf"
  [ -n "$body" ] && set -- "$@" -H 'content-type: application/json' --data-binary "$body"
  printf '\n$ curl -X %s %s%s <json body>\n' "$method" "$URL" "$path" >&2
  local status; status="$(curl "$@" "$URL$path")"
  printf '  -> %s %s\n' "$status" "$(compact "$WORK/body")" >&2
  printf '%s' "$status"
}

# A content read is not JSON, so it gets its own call: body to $WORK/content, headers kept.
read_content() { # jar csrf incident evidence_id -> echoes status
  local jar="$1" csrf="$2" inc="$3" ev="$4"
  set -- -sS -m 20 -o "$WORK/content" -D "$WORK/cheaders" -w '%{http_code}' -X GET
  [ -n "$jar" ] && set -- "$@" -b "$jar"
  [ -n "$csrf" ] && set -- "$@" -H "x-csrf-token: $csrf"
  printf '\n$ curl -X GET %s/api/v1/incidents/%s/evidence/%s/content\n' "$URL" "$inc" "$ev" >&2
  local status; status="$(curl "$@" "$URL/api/v1/incidents/$inc/evidence/$ev/content")"
  printf '  -> %s (%s bytes, digest %s)\n' "$status" "$(wc -c < "$WORK/content" | tr -d ' ')" "$(header_of x-evidence-digest < "$WORK/cheaders")" >&2
  printf '%s' "$status"
}

last() { json "d$1" < "$WORK/body"; }

# The error envelope of a content read is written to $WORK/content (the body of that call),
# so its code has to be read from there rather than from the JSON calls' $WORK/body.
content_code() { json "d['code']" < "$WORK/content"; }

login() {
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

# A create-evidence body built by python, because the content contains newlines and quotes.
content_body() { # kind source collected_at content_type content_file [extra_json]
  python3 - "$@" <<'PY'
import json, pathlib, sys
kind, source, collected, ctype, path, extra = sys.argv[1:7]
payload = {
    "kind": kind,
    "source": source,
    "collectedAt": collected,
    "content": {"contentType": ctype, "body": pathlib.Path(path).read_text()},
}
if extra:
    payload.update(json.loads(extra))
print(json.dumps(payload))
PY
}

echo "== kernel: $URL   run: $RUN"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed"; exit 2; }

OP_EMAIL="g12b-operator-$RUN@example.invalid"
OP2_EMAIL="g12b-operator2-$RUN@example.invalid"
create_user() {
  local email="$1" password="$2"
  call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"$email\",\"displayName\":\"g12b operator\",\"password\":\"$password\",\"role\":\"operator\"}" > /dev/null
}
create_user "$OP_EMAIL" g12b-operator-password-1
create_user "$OP2_EMAIL" g12b-operator2-password-1
OP_JAR="$WORK/operator.cookies"; OP_CSRF="$(login "$OP_EMAIL" g12b-operator-password-1 "$OP_JAR")"
OP2_JAR="$WORK/operator2.cookies"; login "$OP2_EMAIL" g12b-operator2-password-1 "$OP2_JAR" > /dev/null

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST /api/v1/incidents \
  "{\"title\":\"g12b evidence content $RUN\",\"severity\":\"MAJOR\",\"startedAt\":\"$NOW\",\"relatedEntity\":\"host:g12b-node\"}")"
check 201 "$STATUS" "setup: operator creates an incident"
INC="$(last "['id']")"
echo "   incident: $INC"

# ---------------------------------------------------------------------------
step 'B3.1 - a manual evidence row that carries REAL content'
# ---------------------------------------------------------------------------
cat > "$WORK/content.txt" <<'LOG'
2026-10-31T05:00:00Z ERROR upstream=db-1 op=SELECT reason="connection reset by peer"
2026-10-31T05:00:01Z WARN  pool=primary waiting=17 active=200 max=200
2026-10-31T05:00:02Z ERROR upstream=db-1 retry=2 gave up after 30s
LOG
LOCAL_DIGEST="$(sha256_of "$WORK/content.txt")"
LOCAL_BYTES="$(wc -c < "$WORK/content.txt" | tr -d ' ')"
printf '   local sha256: %s (%s bytes)\n' "$LOCAL_DIGEST" "$LOCAL_BYTES"

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body LOG_EXCERPT 'operator:g12b' "$NOW" text/plain "$WORK/content.txt" '{}')")"
check 201 "$STATUS" "B3.1 the kernel accepts a row with content"
EV_A="$(last "['id']")"
check "STORED" "$(last "['contentStatus']")" "B3.1 the row reports stored bytes"

# ---------------------------------------------------------------------------
step 'B3.2 - the digest is the server own, over the bytes it stored'
# ---------------------------------------------------------------------------
check "$LOCAL_DIGEST" "$(last "['contentSha256']")" "B3.2 contentSha256 == sha256 of the bytes we sent"
check "sha256:$LOCAL_DIGEST" "$(last "['contentRef']")" "B3.2 contentRef is derived from it, not chosen by us"
check "$LOCAL_BYTES" "$(last "['contentBytes']")" "B3.2 contentBytes is the byte length (not characters)"

WRONG="$(printf '0%.0s' $(seq 1 64))"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b' "$NOW" text/plain "$WORK/content.txt" "{\"contentRef\":\"sha256:$WRONG\"}")")"
check 400 "$STATUS" "B3.2 a client-computed digest that disagrees is refused"
check "EVIDENCE_CONTENT_REF_CONFLICT" "$(last "['code']")" "B3.2 refusal code"

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b' "$NOW" text/plain "$WORK/content.txt" "{\"contentRef\":\"sha256:$LOCAL_DIGEST\"}")")"
check 201 "$STATUS" "B3.2 a supplied contentRef that equals the derived digest is accepted"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b' "$NOW" text/plain "$WORK/content.txt" "{\"contentRef\":\"sha256:$LOCAL_DIGEST\"}")")"
check 200 "$STATUS" "B3.2 an exact replay of the stored tuple is an idempotent 200"
check "sha256:$LOCAL_DIGEST" "$(last "['contentRef']")" "B3.2 the replay answers with the stored row's derived ref"

# ---------------------------------------------------------------------------
step 'B3.3 - the write answers with a unique id'
# ---------------------------------------------------------------------------
if printf '%s' "$EV_A" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
  ok "B3.3 the evidence id is a v4 UUID ($EV_A)"
else
  bad "B3.3 the evidence id is not a v4 UUID: $EV_A"
fi
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/evidence")"
check 200 "$STATUS" "B3.3 the evidence list is readable"
check 1 "$(json "[r['id'] for r in d['items']].count('$EV_A')" < "$WORK/body")" "B3.3 the list contains that exact id, once"

# ---------------------------------------------------------------------------
step 'B3.4 - reading it back through the API the page uses'
# ---------------------------------------------------------------------------
STATUS="$(read_content "$OP_JAR" "" "$INC" "$EV_A")"
check 200 "$STATUS" "B3.4 GET .../content returns the bytes"
if cmp -s "$WORK/content" "$WORK/content.txt"; then
  ok "B3.4 the returned body is byte-identical to what was submitted"
else
  bad "B3.4 the returned body differs from what was submitted"
fi
check "text/plain; charset=utf-8" "$(header_of content-type < "$WORK/cheaders")" "B3.4 served as text/plain"
check "nosniff" "$(header_of x-content-type-options < "$WORK/cheaders")" "B3.4 nosniff is set"
check "no-store" "$(header_of cache-control < "$WORK/cheaders")" "B3.4 no-store: no copy outlives the row"
check "default-src 'none'; sandbox" "$(header_of content-security-policy < "$WORK/cheaders")" "B3.4 a sandbox CSP is set"

# ---------------------------------------------------------------------------
step 'B3.5 - the digest matches on the way out'
# ---------------------------------------------------------------------------
check "$LOCAL_DIGEST" "$(header_of x-evidence-digest < "$WORK/cheaders")" "B3.5 X-Evidence-Digest == our own recomputation"
check "$LOCAL_BYTES" "$(header_of x-evidence-bytes < "$WORK/cheaders")" "B3.5 X-Evidence-Bytes == the verified length"
check "$LOCAL_DIGEST" "$(sha256_of "$WORK/content")" "B3.5 sha256 of the received body == our recomputation"
curl -sS -b "$OP_JAR" -o "$WORK/body" "$URL/api/v1/incidents/$INC/evidence"
check "$LOCAL_DIGEST" "$(json "[r['contentSha256'] for r in d['items'] if r['id']=='$EV_A'][0]" < "$WORK/body")" "B3.5 the list reports the same digest"

# ---------------------------------------------------------------------------
step 'B3.6 - somebody changes the stored bytes, and that is DETECTED'
# ---------------------------------------------------------------------------
UPDATE_OUT="$(psql "$DB" -v ON_ERROR_STOP=1 -tAc \
  "UPDATE kernel.incident_evidence_content SET body=repeat('X', content_bytes)::bytea WHERE evidence_id='$EV_A'" 2>&1 || true)"
if printf '%s' "$UPDATE_OUT" | grep -q 'write-once'; then
  ok "B3.6a a direct UPDATE is refused by the trigger: $(printf '%s' "$UPDATE_OUT" | head -1)"
else
  bad "B3.6a the UPDATE was not refused by the write-once trigger: $UPDATE_OUT"
fi

psql "$DB" -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
ALTER TABLE kernel.incident_evidence_content DISABLE TRIGGER incident_evidence_content_write_once;
UPDATE kernel.incident_evidence_content SET body=repeat('T', content_bytes)::bytea WHERE evidence_id='$EV_A';
ALTER TABLE kernel.incident_evidence_content ENABLE TRIGGER incident_evidence_content_write_once;
SQL
printf '   corrupted %s in the database (trigger disabled, bytes replaced)\n' "$EV_A"
STATUS="$(read_content "$OP_JAR" "" "$INC" "$EV_A")"
check 500 "$STATUS" "B3.6b the read of corrupted content is refused, not served"
check "EVIDENCE_CONTENT_INTEGRITY_FAILED" "$(content_code)" "B3.6b refusal code"
if grep -q 'TAMPERED' "$WORK/content"; then
  bad "B3.6b the corrupted bytes were returned in the response body"
else
  ok "B3.6b the response carries no content bytes at all"
fi
curl -sS -b "$OP_JAR" -o "$WORK/body" "$URL/api/v1/incidents/$INC/evidence"
check "$LOCAL_DIGEST" "$(json "[r['contentSha256'] for r in d['items'] if r['id']=='$EV_A'][0]" < "$WORK/body")" "B3.6b the recorded digest is unchanged: the tamper did not rewrite history"

# ---------------------------------------------------------------------------
step 'B3.7 - an unauthorised subject cannot read the bytes'
# ---------------------------------------------------------------------------
STATUS="$(read_content "" "" "$INC" "$EV_A")"
check 401 "$STATUS" "B3.7 an anonymous caller gets no content"
STATUS="$(read_content "$OP2_JAR" "" "$INC" "$EV_A")"
check 404 "$STATUS" "B3.7 another operator cannot read it (404, not 403: no existence leak)"
check "INCIDENT_NOT_FOUND" "$(content_code)" "B3.7 refusal code"
STATUS="$(call "$OP2_JAR" "" GET "/api/v1/incidents/$INC/evidence")"
check 404 "$STATUS" "B3.7 and cannot even list the metadata its content belongs to"

# ---------------------------------------------------------------------------
step 'B3.8 - a signed verdict is not rewritten by later evidence'
# ---------------------------------------------------------------------------
curl -sS -b "$OP_JAR" -o "$WORK/body" "$URL/api/v1/incidents/$INC/evidence"
COUNT_BEFORE="$(json "len(d['items'])" < "$WORK/body")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/verdict" \
  "{\"verdict\":\"CONFIRMED\",\"rationale\":\"g12b acceptance $RUN: the db-1 reset window matches the alert\"}")"
check 201 "$STATUS" "B3.8 an operator records a verdict"
check "$COUNT_BEFORE" "$(last "['consideredEvidenceCount']")" "B3.8 the considered count is the set at signing time"
VERDICT_DIGEST="$(last "['consideredEvidenceDigest']")"

printf 'follow-up note recorded after the verdict\n' > "$WORK/after.txt"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-after' "$NOW" text/plain "$WORK/after.txt" '{}')")"
check 201 "$STATUS" "B3.8 evidence can still be appended after signing"
EV_B="$(last "['id']")"
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/verdict")"
check "$COUNT_BEFORE" "$(last "['consideredEvidenceCount']")" "B3.8 the signed count did not move"
check "$VERDICT_DIGEST" "$(last "['consideredEvidenceDigest']")" "B3.8 the signed digest did not move"
curl -sS -b "$OP_JAR" -o "$WORK/body" "$URL/api/v1/incidents/$INC/evidence"
check "True" "$(json "[r['afterVerdict'] for r in d['items'] if r['id']=='$EV_B'][0]" < "$WORK/body")" "B3.8 the new row is flagged afterVerdict"

psql "$DB" -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
ALTER TABLE kernel.incident_evidence_content DISABLE TRIGGER incident_evidence_content_write_once;
UPDATE kernel.incident_evidence_content SET body=repeat('S', content_bytes)::bytea WHERE evidence_id='$EV_B';
ALTER TABLE kernel.incident_evidence_content ENABLE TRIGGER incident_evidence_content_write_once;
SQL
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/verdict")"
check "$VERDICT_DIGEST" "$(last "['consideredEvidenceDigest']")" "B3.8 byte corruption cannot rewrite what was signed"
STATUS="$(read_content "$OP_JAR" "" "$INC" "$EV_B")"
check 500 "$STATUS" "B3.8 and the tampered bytes are refused at read time instead"

# ---------------------------------------------------------------------------
step 'LIMITS - size / content-type / clock window / query window'
# ---------------------------------------------------------------------------
python3 -c 'open("'"$WORK"'/too-big.txt","w").write("x"*65537)'
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-big' "$NOW" text/plain "$WORK/too-big.txt" '{}')")"
check 413 "$STATUS" "L1 65537 bytes is refused (413)"
check "EVIDENCE_CONTENT_TOO_LARGE" "$(last "['code']")" "L1 refusal code"

python3 -c 'open("'"$WORK"'/exact.txt","w").write("y"*65536)'
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-exact' "$NOW" text/plain "$WORK/exact.txt" '{}')")"
check 201 "$STATUS" "L1b exactly 65536 bytes is accepted: the bound is the bound"
check 65536 "$(last "['contentBytes']")" "L1b and it reports 65536 bytes"

printf '<script>alert(1)</script>\n' > "$WORK/html.txt"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-html' "$NOW" text/html "$WORK/html.txt" '{}')")"
check 415 "$STATUS" "L2 text/html is refused (415)"
check "EVIDENCE_CONTENT_TYPE_UNSUPPORTED" "$(last "['code']")" "L2 refusal code"

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-charset' "$NOW" 'text/plain; charset=utf-16' "$WORK/html.txt" '{}')")"
check 415 "$STATUS" "L2b a charset parameter is not the same value (415)"

: > "$WORK/empty.txt"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-empty' "$NOW" text/plain "$WORK/empty.txt" '{}')")"
check 400 "$STATUS" "L3 empty content is refused (400)"
check "EVIDENCE_CONTENT_EMPTY" "$(last "['code']")" "L3 refusal code"

FUTURE="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-future' "$FUTURE" text/plain "$WORK/after.txt" '{}')")"
check 400 "$STATUS" "L4 a collectedAt 2h in the future is refused (400)"
check "EVIDENCE_COLLECTED_AT_IN_FUTURE" "$(last "['code']")" "L4 refusal code"

OLD="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=500)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body OPERATOR_NOTE 'operator:g12b-old' "$OLD" text/plain "$WORK/after.txt" '{}')")"
check 400 "$STATUS" "L4b a collectedAt 500 days old is refused (400)"
check "EVIDENCE_COLLECTED_AT_TOO_OLD" "$(last "['code']")" "L4b refusal code"

SINCE="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
UNTIL="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/evidence?since=$SINCE&until=$UNTIL")"
check 200 "$STATUS" "L5 a 10-day window is accepted"
if [ "$(json "len(d['items'])" < "$WORK/body")" -ge 1 ] 2>/dev/null; then
  ok "L5 the window returned rows"
else
  bad "L5 the window returned no rows"
fi
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/evidence?since=$SINCE")"
check 400 "$STATUS" "L5b a half-bounded window is refused"
check "INCIDENT_EVIDENCE_WINDOW_INVALID" "$(last "['code']")" "L5b refusal code"
WIDE="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/evidence?since=$WIDE&until=$UNTIL")"
check 400 "$STATUS" "L5c a 200-day window is refused (the 90-day maximum)"
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/evidence?since=$UNTIL&until=$SINCE")"
check 400 "$STATUS" "L5d an inverted window is refused"

# ---------------------------------------------------------------------------
step 'LIMITS - retention: past the horizon the bytes are refused (410)'
# ---------------------------------------------------------------------------
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"QUERY_RESULT\",\"source\":\"operator:g12b-aged\",\"collectedAt\":\"$NOW\",\"contentRef\":\"query:aged-$RUN\"}")"
check 201 "$STATUS" "R0 a row is created through the API first"
EV_AGED="$(last "['id']")"
printf 'an aged query result\n' > "$WORK/aged.txt"
AGED_DIGEST="$(sha256_of "$WORK/aged.txt")"
psql "$DB" -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO kernel.incident_evidence_content
  (evidence_id, content_type, body, content_bytes, sha256, captured_at, retention_expires_at)
VALUES ('$EV_AGED', 'text/plain', pg_read_binary_file('$WORK/aged.txt'), $(wc -c < "$WORK/aged.txt" | tr -d ' '),
        '$AGED_DIGEST', now() - interval '400 days', now() - interval '35 days');
SQL
curl -sS -b "$OP_JAR" -o "$WORK/body" "$URL/api/v1/incidents/$INC/evidence"
check "STORED" "$(json "[r['contentStatus'] for r in d['items'] if r['id']=='$EV_AGED'][0]" < "$WORK/body")" "R1 the metadata still says the bytes were stored"
check "False" "$(json "[r['contentRetentionExpiresAt'] is None for r in d['items'] if r['id']=='$EV_AGED'][0]" < "$WORK/body")" "R1 the retention horizon is recorded"
STATUS="$(read_content "$OP_JAR" "" "$INC" "$EV_AGED")"
check 410 "$STATUS" "R2 past the horizon the bytes are refused (410)"
check "EVIDENCE_CONTENT_EXPIRED" "$(content_code)" "R2 refusal code"
if grep -q 'aged query result' "$WORK/content"; then
  bad "R2 expired content was served anyway"
else
  ok "R2 no expired bytes in the response"
fi

# ---------------------------------------------------------------------------
step 'LEGACY - a reference is still accepted, and never shown as content'
# ---------------------------------------------------------------------------
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"LOG_EXCERPT\",\"source\":\"syslog\",\"collectedAt\":\"$NOW\",\"contentRef\":\"s3://logs/2026/10/31/app.log#L120-140\"}")"
check 201 "$STATUS" "G1 a contentRef-only submission is still accepted"
EV_LEGACY="$(last "['id']")"
check "LEGACY_REFERENCE" "$(last "['contentStatus']")" "G1 it is labelled as a legacy reference"
check "None" "$(last "['contentSha256']")" "G1 no digest is claimed for bytes the kernel does not hold"
STATUS="$(read_content "$OP_JAR" "" "$INC" "$EV_LEGACY")"
check 404 "$STATUS" "G2 reading its content answers 404, not a fabricated body"
check "EVIDENCE_CONTENT_NOT_STORED" "$(content_code)" "G2 refusal code"
STATUS="$(read_content "$OP_JAR" "" "$INC" "00000000-0000-4000-8000-000000000000")"
check 404 "$STATUS" "G3 an unknown evidence id is a different 404"
check "EVIDENCE_NOT_FOUND" "$(content_code)" "G3 refusal code"

# ---------------------------------------------------------------------------
step 'SSRF - a URL in contentRef is never dereferenced'
# ---------------------------------------------------------------------------
python3 - "$CANARY_PORT" "$WORK/canary.log" <<'PY' &
import socket, sys
port, log = int(sys.argv[1]), sys.argv[2]
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen(4)
server.settimeout(30)
open(log, "w").close()
try:
    while True:
        connection, address = server.accept()
        open(log, "a").write("CONNECTED %s\n" % (address,))
        connection.close()
except socket.timeout:
    pass
PY
CANARY_PID=$!
sleep 0.7
for ref in "http://127.0.0.1:$CANARY_PORT/canary-ssrf" "javascript:alert(document.domain)" "data:text/html,<script>alert(1)</script>"; do
  escaped="$(printf '%s' "$ref" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read())[1:-1])')"
  STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
    "{\"kind\":\"QUERY_RESULT\",\"source\":\"operator:g12b-ssrf\",\"collectedAt\":\"$NOW\",\"contentRef\":\"$escaped\"}")"
  check 201 "$STATUS" "S1 a hostile contentRef is stored as text, not fetched: $ref"
done
LAST_REF_ID="$(last "['id']")"
STATUS="$(read_content "$OP_JAR" "" "$INC" "$LAST_REF_ID")"
check 404 "$STATUS" "S2 no bytes exist for a URL reference, so nothing was fetched or cached"
sleep 1
if [ -s "$WORK/canary.log" ]; then
  bad "S3 the kernel connected to the canary listener: $(cat "$WORK/canary.log")"
else
  ok "S3 the canary listener on 127.0.0.1:$CANARY_PORT received ZERO connections in the whole run"
fi
kill "$CANARY_PID" 2>/dev/null; wait "$CANARY_PID" 2>/dev/null

# The rendering rule, checked from the tree rather than promised in a comment: nothing in the web
# application injects HTML. The path is derived from this script so the check works from any cwd.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INNER_HTML_USES="$(grep -rn 'dangerouslySetInnerHTML' "$REPO_ROOT/apps/platform-web/src" | wc -l | tr -d ' ')"
check 0 "$INNER_HTML_USES" "X3 no component in the web tree injects HTML (grep dangerouslySetInnerHTML is empty)"

# ---------------------------------------------------------------------------
step 'XSS - untrusted payloads are stored verbatim and served as inert text'
# ---------------------------------------------------------------------------
printf '%s\n' \
  '<script>window.__xss = 1;</script>' \
  '<img src=x onerror="window.__xss = 2">' \
  '<svg onload="window.__xss = 3"></svg>' \
  '</pre><script>window.__xss = 4;</script>' > "$WORK/xss.txt"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "$(content_body LOG_EXCERPT 'operator:g12b-xss' "$NOW" text/plain "$WORK/xss.txt" '{}')")"
check 201 "$STATUS" "X1 a script/img/svg payload is accepted as text"
EV_XSS="$(last "['id']")"
check "$(sha256_of "$WORK/xss.txt")" "$(last "['contentSha256']")" "X1 and stored verbatim (digest matches the payload)"
STATUS="$(read_content "$OP_JAR" "" "$INC" "$EV_XSS")"
check 200 "$STATUS" "X2 it reads back"
check "text/plain; charset=utf-8" "$(header_of content-type < "$WORK/cheaders")" "X2 served as text/plain: a direct visit cannot execute it"
if cmp -s "$WORK/content" "$WORK/xss.txt"; then
  ok "X2 the payload is returned unmodified; the browser is what must not execute it"
else
  bad "X2 the returned payload was altered"
fi

# ---------------------------------------------------------------------------
step 'FIXTURES (for the browser spec to reuse)'
# ---------------------------------------------------------------------------
printf 'incident=%s\nstored_row=%s\nafter_verdict_row=%s\nlegacy_row=%s\nxss_row=%s\n' \
  "$INC" "$EV_A" "$EV_B" "$EV_LEGACY" "$EV_XSS" | tee "$WORK/fixtures.txt"

echo
echo "== $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then printf 'FAILED:%s\n' "$FAILED_LIST"; rm -rf "$WORK"; exit 1; fi
rm -rf "$WORK"
