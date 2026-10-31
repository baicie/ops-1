#!/usr/bin/env bash
# G11 incident slice acceptance: Incident -> Evidence -> Human Verdict over real HTTP.
#
# Scope: the seven incident operations, the require_operator gate on the three
# writes, the role data scope (admin and viewer read all, an operator reads only
# what it owns), the idempotent replays, and every documented failure code.
#
# This script creates its own operator and viewer accounts through the admin API,
# so it must run against a throw-away database:
#   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... tests/acceptance/incident_slice_api.sh
#
# It prints every request line and the real response body; the assertions read
# those same responses, never a fixture.
set -uo pipefail

URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:?set OPSWEAVE_ADMIN_EMAIL}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:?set OPSWEAVE_ADMIN_PASSWORD}"
RUN="$(date +%s)-$$"
WORK="$(mktemp -d)"
PASS=0; FAIL=0; FAILED=()

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$*"); printf 'FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
compact() { python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), separators=(",",":")))
except Exception:
    sys.stdin.seek(0)
    print(sys.stdin.read().strip()[:400])' < "$1"; }

# call <jar> <csrf> <method> <path> [body] -> echoes the HTTP status, prints request+response
call() {
  local jar="$1" csrf="$2" method="$3" path="$4" body="${5:-}"
  local args=(-sS -m 10 -o "$WORK/body" -w '%{http_code}' -X "$method")
  [ -n "$jar" ] && args+=(-b "$jar")
  [ -n "$csrf" ] && args+=(-H "x-csrf-token: $csrf")
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  printf '\n$ curl -X %s %s%s %s\n' "$method" "$URL" "$path" "${body:+-d '$body'}" >&2
  local status; status="$(curl "${args[@]}" "$URL$path")"
  printf '  -> %s %s\n' "$status" "$(compact "$WORK/body")" >&2
  printf '%s' "$status"
}

login() { # email password jar -> prints the csrf token
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

echo "== kernel: $URL   run: $RUN"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed for $ADMIN_EMAIL"; exit 2; }
ADMIN_ID="$(curl -sS -b "$ADMIN_JAR" "$URL/api/v1/auth/me" | json "d['user']['id']")"

# --- fixtures created through the public API, never inserted by hand ------------
OPERATOR_EMAIL="g11-operator-$RUN@example.invalid"
VIEWER_EMAIL="g11-viewer-$RUN@example.invalid"
OPERATOR_PASSWORD="g11-operator-password-1"
VIEWER_PASSWORD="g11-viewer-password-1"
for spec in "operator:$OPERATOR_EMAIL:$OPERATOR_PASSWORD" "viewer:$VIEWER_EMAIL:$VIEWER_PASSWORD"; do
  role="${spec%%:*}"; rest="${spec#*:}"; email="${rest%%:*}"; password="${rest#*:}"
  status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"$email\",\"displayName\":\"g11 $role\",\"password\":\"$password\",\"role\":\"$role\"}")"
  check 200 "$status" "admin creates $role account"
done

OPERATOR_JAR="$WORK/operator.cookies"; VIEWER_JAR="$WORK/viewer.cookies"
OPERATOR_CSRF="$(login "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD" "$OPERATOR_JAR")"
VIEWER_CSRF="$(login "$VIEWER_EMAIL" "$VIEWER_PASSWORD" "$VIEWER_JAR")"
[ -n "$OPERATOR_CSRF" ] && [ -n "$VIEWER_CSRF" ] || { echo "role logins failed"; exit 2; }

NATIVE="acceptance-$RUN"
CREATE_BODY="{\"title\":\"disk full on web-01\",\"severity\":\"MAJOR\",\"source\":\"API\",\"nativeId\":\"$NATIVE\",\"relatedEntity\":\"host:web-01\",\"startedAt\":\"2026-10-30T01:00:00Z\"}"

echo
echo "== 1. anonymous access is rejected before the handler"
check 401 "$(call '' '' GET /api/v1/incidents)" "anonymous GET /api/v1/incidents"
check 401 "$(call '' '' POST /api/v1/incidents "$CREATE_BODY")" "anonymous POST /api/v1/incidents"

echo
echo "== 2. create is idempotent on (source, nativeId)"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents "$CREATE_BODY")"
check 201 "$status" "admin POST /api/v1/incidents"
INCIDENT_ID="$(json "d['id']" < "$WORK/body")"
ADMIN_OWN_INCIDENT_OWNER="$(json "d['owner']" < "$WORK/body")"
[ "$ADMIN_OWN_INCIDENT_OWNER" = "$ADMIN_ID" ] && ok "owner is the creating session" || bad "owner is not the creator"
[ "$(json "d['status']" < "$WORK/body")" = "OPEN" ] && ok "new incident is OPEN" || bad "new incident status"
[ "$(json "d['evidenceRefs']" < "$WORK/body")" = "[]" ] && ok "evidenceRefs derived as an empty list" || bad "evidenceRefs"
[ "$(json "d['humanVerdict']" < "$WORK/body")" = "None" ] && ok "humanVerdict derived as null" || bad "humanVerdict"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents "$CREATE_BODY")"
check 200 "$status" "replayed POST answers 200, not 201"
[ "$(json "d['id']" < "$WORK/body")" = "$INCIDENT_ID" ] && ok "replay returns the same incident id" || bad "replay returned a different id"

echo
echo "== 3. read paths and role data scope"
check 200 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET /api/v1/incidents)" "admin GET /api/v1/incidents"
check 200 "$(call "$VIEWER_JAR" "$VIEWER_CSRF" GET /api/v1/incidents)" "viewer GET /api/v1/incidents"
check 200 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents/$INCIDENT_ID")" "admin GET one incident"
check 404 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET /api/v1/incidents/00000000-0000-0000-0000-000000000000)" "unknown incident id"
[ "$(json "d['code']" < "$WORK/body")" = "INCIDENT_NOT_FOUND" ] && ok "unknown id answers INCIDENT_NOT_FOUND" || bad "unknown id code"

OPERATOR_BODY="{\"title\":\"latency spike on api-02\",\"severity\":\"MINOR\",\"startedAt\":\"2026-10-30T02:00:00Z\"}"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST /api/v1/incidents "$OPERATOR_BODY")"
check 201 "$status" "operator POST /api/v1/incidents"
OPERATOR_INCIDENT="$(json "d['id']" < "$WORK/body")"
check 200 "$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" GET "/api/v1/incidents/$OPERATOR_INCIDENT")" "operator GET own incident"
check 404 "$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" GET "/api/v1/incidents/$INCIDENT_ID")" "operator GET another owner's incident"
[ "$(json "d['code']" < "$WORK/body")" = "INCIDENT_NOT_FOUND" ] && ok "out-of-scope read answers INCIDENT_NOT_FOUND" || bad "out-of-scope code"
check 200 "$(call "$VIEWER_JAR" "$VIEWER_CSRF" GET "/api/v1/incidents/$INCIDENT_ID")" "viewer GET any incident (read-only role)"
check 403 "$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST /api/v1/incidents "$OPERATOR_BODY")" "viewer POST /api/v1/incidents"

echo
echo "== 4. evidence: operator-only, idempotent, and it moves OPEN -> INVESTIGATING"
EVIDENCE_BODY='{"kind":"METRIC_SNAPSHOT","source":"prometheus","collectedAt":"2026-10-30T01:02:00Z","contentRef":"sha256:0000000000000000000000000000000000000000000000000000000000000001","trust":"SOURCE_ATTESTED"}'
check 403 "$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/evidence" "$EVIDENCE_BODY")" "viewer POST evidence"
check 404 "$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/evidence" "$EVIDENCE_BODY")" "operator POST evidence to another owner's incident"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/evidence" "$EVIDENCE_BODY")"
check 201 "$status" "admin POST evidence"
EVIDENCE_ID="$(json "d['id']" < "$WORK/body")"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/evidence" "$EVIDENCE_BODY")"
check 200 "$status" "replayed evidence answers 200"
[ "$(json "d['id']" < "$WORK/body")" = "$EVIDENCE_ID" ] && ok "replay returns the same evidence id" || bad "evidence replay id"
call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents/$INCIDENT_ID/evidence" >/dev/null
[ "$(json "len(d['items'])" < "$WORK/body")" = "1" ] && ok "evidence list has exactly one row" || bad "evidence list length"
call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents/$INCIDENT_ID" >/dev/null
[ "$(json "d['status']" < "$WORK/body")" = "INVESTIGATING" ] && ok "first evidence moved OPEN -> INVESTIGATING" || bad "status after evidence"
[ "$(json "d['evidenceRefs'][0]" < "$WORK/body")" = "$EVIDENCE_ID" ] && ok "evidenceRefs now names the evidence row" || bad "evidenceRefs projection"

echo
echo "== 5. verdict: needs evidence, write-once, and it concludes the incident"
NO_EVIDENCE_BODY='{"title":"unrelated noise","severity":"WARNING","startedAt":"2026-10-30T03:00:00Z"}'
call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents "$NO_EVIDENCE_BODY" >/dev/null
BARE_INCIDENT="$(json "d['id']" < "$WORK/body")"
check 404 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents/$BARE_INCIDENT/verdict")" "GET verdict before any verdict exists"
[ "$(json "d['code']" < "$WORK/body")" = "INCIDENT_VERDICT_NOT_FOUND" ] && ok "missing verdict answers INCIDENT_VERDICT_NOT_FOUND" || bad "missing verdict code"
check 409 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$BARE_INCIDENT/verdict" '{"verdict":"CONFIRMED","rationale":"looks like saturation to me"}')" "CONFIRMED without evidence"
[ "$(json "d['code']" < "$WORK/body")" = "INCIDENT_EVIDENCE_REQUIRED" ] && ok "codes INCIDENT_EVIDENCE_REQUIRED" || bad "evidence-required code"
check 201 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$BARE_INCIDENT/verdict" '{"verdict":"INCONCLUSIVE","rationale":"no data available for this window"}')" "INCONCLUSIVE without evidence"
check 409 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$BARE_INCIDENT/verdict" '{"verdict":"REFUTED","rationale":"second opinion on the same incident"}')" "second verdict on a concluded incident"
[ "$(json "d['code']" < "$WORK/body")" = "INCIDENT_ALREADY_CONCLUDED" ] && ok "codes INCIDENT_ALREADY_CONCLUDED" || bad "already-concluded code"
check 403 "$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/verdict" '{"verdict":"CONFIRMED","rationale":"viewers may not conclude here"}')" "viewer POST verdict"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/verdict" '{"verdict":"CONFIRMED","rationale":"disk usage matches the sampled window exactly"}')"
check 201 "$status" "admin POST verdict on an incident with evidence"
[ "$(json "d['decidedBy']" < "$WORK/body")" = "$ADMIN_ID" ] && ok "decidedBy is the deciding session" || bad "decidedBy is not the deciding session"
call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents/$INCIDENT_ID/verdict" >/dev/null
[ "$(json "d['verdict']" < "$WORK/body")" = "CONFIRMED" ] && ok "GET verdict returns CONFIRMED" || bad "GET verdict body"
call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents/$INCIDENT_ID" >/dev/null
[ "$(json "d['status']" < "$WORK/body")" = "CONCLUDED" ] && ok "verdict moved the incident to CONCLUDED" || bad "status after verdict"
[ "$(json "d['humanVerdict']['verdict']" < "$WORK/body")" = "CONFIRMED" ] && ok "humanVerdict projection is CONFIRMED" || bad "humanVerdict projection"

echo
echo "== 6. every error is explainable, never a bare 500"
check 400 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents '{"title":"bad severity","severity":"SEVERE","startedAt":"2026-10-30T04:00:00Z"}')" "unknown severity"
[ "$(json "d['code']" < "$WORK/body")" = "INVALID_REQUEST" ] && ok "closed-set violation answers INVALID_REQUEST" || bad "closed-set code"
check 400 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents '{"title":"x"}')" "missing startedAt"
check 400 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents 'not-json-at-all')" "malformed JSON body"
[ -n "$(json "d['code']" < "$WORK/body")" ] && ok "malformed JSON still answers with the error envelope" || bad "malformed JSON envelope"
check 400 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET '/api/v1/incidents?status=DONE')" "unknown status filter"
check 400 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET '/api/v1/incidents?cursor=not*base64')" "malformed cursor"

echo
echo "== 7. list shape: bounded, newest first, keyset cursor"
call "$ADMIN_JAR" "$ADMIN_CSRF" GET '/api/v1/incidents?limit=1' >/dev/null
[ "$(json "'nextCursor' in d and len(d['items'])<=1" < "$WORK/body")" = "True" ] && ok "list is bounded and advertises nextCursor" || bad "list shape"
CURSOR="$(json "d.get('nextCursor')" < "$WORK/body")"
if [ "$CURSOR" != "None" ] && [ -n "$CURSOR" ]; then
  check 200 "$(call "$ADMIN_JAR" "$ADMIN_CSRF" GET "/api/v1/incidents?limit=1&cursor=$CURSOR")" "second page via cursor"
else
  bad "expected a nextCursor with limit=1"
fi

echo
printf '== incident slice: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then printf 'failed: %s\n' "${FAILED[*]}"; exit 1; fi
echo "Incident Slice API: PASS"
