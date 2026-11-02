#!/usr/bin/env bash
# G12 D5 Phase 1 acceptance: the minimal business permission model, over real HTTP.
#
# Every claim below is a real request against a real kernel on a real PostgreSQL, so this
# script creates its own accounts and its own business workspaces. Run it against a
# throw-away database:
#
#   OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... \
#     tests/acceptance/d5_workspace_scope.sh
#
# The nine claims, in the order the phase states them:
#   1 a viewer reads the incidents of a workspace it was granted
#   2 the same viewer reads nothing of a workspace it was not
#   3 that viewer writes nothing, anywhere
#   4 an operator operates the records inside its workspace
#   5 an operator cannot reach another workspace through the owner filter or by id
#   6 the audit ledger leaks no event and no closure note across a workspace boundary
#   7 an AI investigation cannot read what its caller cannot read
#   8 a membership change is answered with on the next request
#   9 single row, list, evidence, timeline and audit agree about the boundary
#
# It prints every request line and the real response body; the assertions read those same
# responses, never a fixture.
set -uo pipefail

URL="${OPSWEAVE_URL:-http://127.0.0.1:18199}"
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

call() {
  local jar="$1" csrf="$2" method="$3" path="$4" body="${5:-}"
  local args=(-sS -m 15 -o "$WORK/body" -w '%{http_code}' -X "$method")
  [ -n "$jar" ] && args+=(-b "$jar")
  [ -n "$csrf" ] && args+=(-H "x-csrf-token: $csrf")
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  printf '\n$ curl -X %s %s%s %s\n' "$method" "$URL" "$path" "${body:+-d '$body'}" >&2
  local status; status="$(curl "${args[@]}" "$URL$path")"
  printf '  -> %s %s\n' "$status" "$(compact "$WORK/body")" >&2
  printf '%s' "$status"
}

login() {
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

user_id_of() { curl -sS -b "$1" "$URL/api/v1/auth/me" | json "d['user']['id']"; }

echo "== kernel: $URL   run: $RUN"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }
ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed"; exit 2; }
ADMIN_ID="$(user_id_of "$ADMIN_JAR")"

# --- fixtures through the public API, never inserted by hand -------------------
OPERATOR_A_EMAIL="d5-operator-a-$RUN@example.invalid"
OPERATOR_B_EMAIL="d5-operator-b-$RUN@example.invalid"
VIEWER_A_EMAIL="d5-viewer-a-$RUN@example.invalid"
PASSWORD="d5-password-1"
for spec in "operator:$OPERATOR_A_EMAIL" "operator:$OPERATOR_B_EMAIL" "viewer:$VIEWER_A_EMAIL"; do
  role="${spec%%:*}"; email="${spec#*:}"
  status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"$email\",\"displayName\":\"d5 $role\",\"password\":\"$PASSWORD\",\"role\":\"$role\"}")"
  check 200 "$status" "admin creates $role account $email"
done

OPERATOR_A_JAR="$WORK/operator-a.cookies"; OPERATOR_B_JAR="$WORK/operator-b.cookies"; VIEWER_JAR="$WORK/viewer.cookies"
OPERATOR_A_CSRF="$(login "$OPERATOR_A_EMAIL" "$PASSWORD" "$OPERATOR_A_JAR")"
OPERATOR_B_CSRF="$(login "$OPERATOR_B_EMAIL" "$PASSWORD" "$OPERATOR_B_JAR")"
VIEWER_CSRF="$(login "$VIEWER_A_EMAIL" "$PASSWORD" "$VIEWER_JAR")"
OPERATOR_A_ID="$(user_id_of "$OPERATOR_A_JAR")"
OPERATOR_B_ID="$(user_id_of "$OPERATOR_B_JAR")"

echo
echo "== 0. a new account starts with no business workspace at all"
status="$(call "$VIEWER_JAR" "" GET /api/v1/business-workspaces)"
check 200 "$status" "viewer GET /api/v1/business-workspaces"
check 0 "$(json 'len(d)' < "$WORK/body")" "a freshly created account is a member of nothing"
status="$(call "$VIEWER_JAR" "" GET /api/v1/incidents)"
check 0 "$(json "d['scope']['workspaceCount']" < "$WORK/body")" "the scope says zero workspaces"
check 0 "$(json 'len(d["items"])' < "$WORK/body")" "and the list is empty, for that reason"
status="$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST /api/v1/incidents \
  '{"title":"viewer tries to file an incident","severity":"MAJOR","startedAt":"2026-11-01T00:00:00Z"}')"
check 403 "$status" "a viewer is still refused every write (item 3, first shape)"

echo
echo "== 0b. two business workspaces, created by the platform administrator"
WS_A=""; WS_B=""
for label in a b; do
  status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/business-workspaces \
    "{\"key\":\"d5-ws-$label-$RUN\",\"name\":\"D5 workspace $label\"}")"
  check 201 "$status" "admin creates workspace $label"
  id="$(json "d['workspaceId']" < "$WORK/body")"
  check false "$(json "str(d['member']).lower()" < "$WORK/body")" "creating a workspace does not enter it"
  if [ "$label" = a ]; then WS_A="$id"; else WS_B="$id"; fi
done
[ -n "$WS_A" ] && [ -n "$WS_B" ] || { echo "workspace creation failed"; exit 2; }

status="$(call "$ADMIN_JAR" "" GET /api/v1/incidents)"

grant() { # workspace user
  local w="$1" u="$2"
  call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/business-workspaces/$w/members" "{\"userId\":\"$u\"}" >/dev/null
}
grant "$WS_A" "$OPERATOR_A_ID"
grant "$WS_A" "$(user_id_of "$VIEWER_JAR")"
grant "$WS_B" "$OPERATOR_B_ID"

echo
echo "== 1/2. the two records, one per workspace"
status="$(call "$OPERATOR_A_JAR" "$OPERATOR_A_CSRF" POST /api/v1/incidents \
  "{\"title\":\"disk full on web-01\",\"severity\":\"MAJOR\",\"relatedEntity\":\"host:web-01\",\"startedAt\":\"2026-11-01T00:00:00Z\",\"workspaceId\":\"$WS_A\"}")"
check 201 "$status" "operator A files into workspace A"
INC_A="$(json "d['id']" < "$WORK/body")"; REV_A="$(json "d['revision']" < "$WORK/body")"
status="$(call "$OPERATOR_B_JAR" "$OPERATOR_B_CSRF" POST /api/v1/incidents \
  "{\"title\":\"queue backlog on mq-02\",\"severity\":\"MINOR\",\"relatedEntity\":\"host:mq-02\",\"startedAt\":\"2026-11-01T00:10:00Z\",\"workspaceId\":\"$WS_B\"}")"
check 201 "$status" "operator B files into workspace B"
INC_B="$(json "d['id']" < "$WORK/body")"

status="$(call "$OPERATOR_A_JAR" "" GET /api/v1/incidents)"
check 1 "$(json "d['scope']['workspaceCount']" < "$WORK/body")" "operator A's scope names one workspace"
check 1 "$(json 'len(d["items"])' < "$WORK/body")" "and its list holds its own record only"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_A")"
check 200 "$status" "ITEM 1: viewer A reads the incident of its workspace"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_B")"
check 404 "$status" "ITEM 2: viewer A gets 404 for the other workspace"
check INCIDENT_NOT_FOUND "$(json "d['code']" < "$WORK/body")" "ITEM 2: and it is nonexistence, not forbidden"
status="$(call "$VIEWER_JAR" "" GET /api/v1/incidents)"
check 1 "$(json 'len(d["items"])' < "$WORK/body")" "ITEM 2: the list agrees with the single read"

echo
echo "== 3. a viewer writes nothing, and the refusal does not depend on the page"
status="$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST "/api/v1/incidents/$INC_A/evidence" \
  '{"kind":"OPERATOR_NOTE","source":"acceptance","collectedAt":"2026-10-30T00:20:00Z","contentRef":"d5/evidence/a"}')"
check 403 "$status" "ITEM 3: viewer POST evidence"
check FORBIDDEN "$(json "d['code']" < "$WORK/body")" "ITEM 3: with the stable code"
status="$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST "/api/v1/incidents/$INC_A/verdict" \
  '{"verdict":"INCONCLUSIVE","rationale":"a viewer must not be able to sign a verdict"}')"
check 403 "$status" "ITEM 3: viewer POST verdict"

echo
echo "== 4. the operator operates inside its workspace"
status="$(call "$OPERATOR_A_JAR" "$OPERATOR_A_CSRF" POST "/api/v1/incidents/$INC_A/evidence" \
  '{"kind":"OPERATOR_NOTE","source":"acceptance","collectedAt":"2026-10-30T00:20:00Z","contentRef":"d5/evidence/a"}')"
check 201 "$status" "ITEM 4: operator A appends evidence"
status="$(call "$OPERATOR_A_JAR" "$OPERATOR_A_CSRF" POST "/api/v1/incidents/$INC_A/verdict" \
  '{"verdict":"INCONCLUSIVE","rationale":"the disk was full and the cleanup has not been verified yet"}')"
check 201 "$status" "ITEM 4: operator A records a verdict"

echo
echo "== 5. the owner filter is a narrowing, never a key"
status="$(call "$OPERATOR_A_JAR" "" GET "/api/v1/incidents?owner=$OPERATOR_B_ID")"
check 200 "$status" "ITEM 5: operator A lists with an owner filter naming operator B"
check 0 "$(json 'len(d["items"])' < "$WORK/body")" "ITEM 5: and receives nothing"
status="$(call "$OPERATOR_A_JAR" "" GET "/api/v1/incidents/$INC_B")"
check 404 "$status" "ITEM 5: nor by id"
status="$(call "$ADMIN_JAR" "" GET "/api/v1/incidents/$INC_A")"
check 404 "$status" "the platform admin is not a member and reads nothing either"
status="$(call "$ADMIN_JAR" "" GET /api/v1/business-workspaces)"
check true "$(python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(any(not w["member"] for w in d)).lower())' < "$WORK/body")" "the admin sees the metadata, and member=false on it"

echo
echo "== 6. the ledger does not cross the boundary"
CLOSURE_NOTE="d5 closure note $RUN"
status="$(call "$OPERATOR_A_JAR" "$OPERATOR_A_CSRF" POST "/api/v1/incidents/$INC_A/close" \
  "{\"expectedRevision\":$(json "d['revision']" < "$WORK/body" 2>/dev/null || echo 0),\"note\":\"$CLOSURE_NOTE\"}")"
if [ "$status" != 200 ]; then
  # The revision moved with the verdict, so re-read it and try once: the point of this
  # section is the ledger boundary, not the closure protocol (g12_lifecycle.sh owns that).
  REV_NOW="$(call "$OPERATOR_A_JAR" "" GET "/api/v1/incidents/$INC_A" >/dev/null; json "d['revision']" < "$WORK/body")"
  status="$(call "$OPERATOR_A_JAR" "$OPERATOR_A_CSRF" POST "/api/v1/incidents/$INC_A/close" \
    "{\"expectedRevision\":$REV_NOW,\"note\":\"$CLOSURE_NOTE\"}")"
fi
check 200 "$status" "operator A closes its record with a note"
status="$(call "$OPERATOR_B_JAR" "" GET "/api/v1/audit?subjectId=$INC_A")"
check 200 "$status" "ITEM 6: operator B asks the ledger about workspace A's record"
check 0 "$(json 'len(d["events"])' < "$WORK/body")" "ITEM 6: and the ledger answers with no event"
if grep -q "$CLOSURE_NOTE" "$WORK/body"; then bad "ITEM 6: the closure note crossed a workspace boundary"; else ok "ITEM 6: the closure note did not cross"; fi
status="$(call "$VIEWER_JAR" "" GET "/api/v1/audit?subjectId=$INC_A")"
check 200 "$status" "ITEM 6/9: viewer A asks about a record it may read"
check true "$(python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(len(d["events"])>0).lower())' < "$WORK/body")" "ITEM 6/9: and the ledger agrees with the incident route"

echo
echo "== 7. the investigator reads nothing its caller could not read"
status="$(call "$OPERATOR_B_JAR" "$OPERATOR_B_CSRF" POST "/api/v1/incidents/$INC_A/investigations" \
  "{\"idempotencyKey\":\"d5-$RUN\"}")"
check 404 "$status" "ITEM 7: operator B starts an investigation on workspace A's record"
check INCIDENT_NOT_FOUND "$(json "d['code']" < "$WORK/body")" "ITEM 7: refused at the same predicate as the read"

echo
echo "== 8. a membership change is answered with on the next request"
VIEWER_ID="$(user_id_of "$VIEWER_JAR")"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" DELETE "/api/v1/business-workspaces/$WS_A/members/$VIEWER_ID")"
check 204 "$status" "admin revokes viewer A from workspace A"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_A")"
check 404 "$status" "ITEM 8: the very next request is refused"
status="$(call "$VIEWER_JAR" "" GET /api/v1/incidents)"
check 0 "$(json "d['scope']['workspaceCount']" < "$WORK/body")" "ITEM 8: and the scope reports zero workspaces"
status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/business-workspaces/$WS_A/members" "{\"userId\":\"$VIEWER_ID\"}")"
check 201 "$status" "admin grants it again"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_A")"
check 200 "$status" "ITEM 8: and the next request reads it again"

echo
echo "== 9. one boundary, five faces"
status="$(call "$VIEWER_JAR" "" GET /api/v1/incidents)"
check true "$(python3 -c 'import json,sys;d=json.load(sys.stdin);print(str([i["id"] for i in d["items"]]==[sys.argv[1]]).lower())' "$INC_A" < "$WORK/body")" "ITEM 9: the list holds exactly workspace A's record"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_A/evidence")"
check 200 "$status" "ITEM 9: evidence of a readable record"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_B/evidence")"
check 404 "$status" "ITEM 9: evidence of an unreadable one"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_A/timeline")"
check 200 "$status" "ITEM 9: the trail of a readable record"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/incidents/$INC_B/timeline")"
check 404 "$status" "ITEM 9: the trail of an unreadable one"
status="$(call "$VIEWER_JAR" "" GET "/api/v1/audit?subjectId=$INC_B")"
check 0 "$(json 'len(d["events"])' < "$WORK/body")" "ITEM 9: and the ledger holds no event of it"

echo
echo "== summary: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  printf 'FAILED:\n%s\n' "${FAILED[*]}"
  exit 1
fi
rm -rf "$WORK"
exit 0
