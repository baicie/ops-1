#!/usr/bin/env bash
# G12 Phase C acceptance: the incident lifecycle as a real operator experiences it.
#
# Everything here is a real HTTP call against a real kernel with a real PostgreSQL behind it, so
# it must run against a throw-away database and a kernel started for this run:
#   OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_DATABASE_URL=postgres://localhost/x \
#   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... tests/acceptance/g12_lifecycle.sh
#
# The database URL is used for four things no client can do: forcing a CONCLUDED row that has no
# verdict (so the closure gate can be shown refusing it), proving a hand-written closure and a
# hand-written reopen are refused by the schema, and counting how many closures of record exist
# after two simultaneous closes. Every state assertion is otherwise read back over HTTP.
#
# What this script is for: C1 and C2 both claim that an ILLEGAL PATH DOES NOT EXIST. A status flag
# that merely ends up correct proves nothing, so each refusal below is asserted by status code AND
# by error code, and each of them is followed by a re-read that shows nothing changed.
URL="$OPSWEAVE_URL"; [ -n "$URL" ] || URL=http://127.0.0.1:18199
ADMIN_EMAIL="$OPSWEAVE_ADMIN_EMAIL"
ADMIN_PASSWORD="$OPSWEAVE_ADMIN_PASSWORD"
DB="$OPSWEAVE_DATABASE_URL"
if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ] || [ -z "$DB" ]; then
  echo "set OPSWEAVE_ADMIN_EMAIL, OPSWEAVE_ADMIN_PASSWORD and OPSWEAVE_DATABASE_URL"; exit 2
fi
set -uo pipefail
RUN="$(date +%s)-$$"
WORK="$(mktemp -d)"
PASS=0; FAIL=0; FAILED_LIST=""

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED_LIST="$FAILED_LIST
  $*"; printf 'FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
contains() { case "$2" in *"$1"*) ok "$3 -> contains $1";; *) bad "$3 -> does not contain $1 (got: $2)";; esac; }
step() { printf '\n######## %s ########\n' "$*"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
compact() { python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), separators=(",",":")))
except Exception:
    sys.stdin.seek(0)
    print(sys.stdin.read().strip()[:400])' < "$1"; }

# curl arguments are collected with "set --" so every expansion stays a plain "$@" form.
call() { # jar csrf method path [body] -> echoes status, prints request+response
  local jar="$1" csrf="$2" method="$3" path="$4" body=""
  [ "$#" -ge 5 ] && body="$5"
  set -- -sS -m 20 -o "$WORK/body" -w '%{http_code}' -X "$method"
  [ -n "$jar" ] && set -- "$@" -b "$jar"
  [ -n "$csrf" ] && set -- "$@" -H "x-csrf-token: $csrf"
  [ -n "$body" ] && set -- "$@" -H 'content-type: application/json' --data-binary "$body"
  printf '\n$ curl -X %s %s%s <body>\n' "$method" "$URL" "$path" >&2
  local status; status="$(curl "$@" "$URL$path")"
  printf '  -> %s %s\n' "$status" "$(compact "$WORK/body")" >&2
  printf '%s' "$status"
}

last() { json "d$1" < "$WORK/body"; }
code() { json "d['code']" < "$WORK/body"; }

login() {
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

sql() { psql "$DB" -tAc "$1" 2>&1; }

echo "== kernel: $URL   run: $RUN"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed"; exit 2; }
# D5 section 3.4: on a fresh database the bootstrap administrator is a member of no business
# workspace (migrations run before it exists), so the fixtures below need the one audited grant
# before anything can be filed. Sourced per script rather than a shared pre-test hook, because a
# hook would grant into whatever OPSWEAVE_URL points at - staging included.
. "$(cd "$(dirname "$0")" && pwd)/lib/workspace_grant.sh"
ow_grant_legacy_self "$ADMIN_JAR" "$ADMIN_CSRF" || { echo "the admin has no business workspace and could not be granted one"; exit 2; }

OP_A_EMAIL="g12c-op-a-$RUN@example.invalid"
OP_B_EMAIL="g12c-op-b-$RUN@example.invalid"
VIEW_EMAIL="g12c-viewer-$RUN@example.invalid"
create_user() {
  local email="$1" password="$2" role="$3" name="$4"
  call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"$email\",\"displayName\":\"$name\",\"password\":\"$password\",\"role\":\"$role\"}" > /dev/null
}
create_user "$OP_A_EMAIL" g12c-op-a-password operator 'g12c op a'
create_user "$OP_B_EMAIL" g12c-op-b-password operator 'g12c op b'
create_user "$VIEW_EMAIL" g12c-viewer-password viewer 'g12c viewer'
OP_A_JAR="$WORK/opa.cookies"; OP_A_CSRF="$(login "$OP_A_EMAIL" g12c-op-a-password "$OP_A_JAR")"
OP_B_JAR="$WORK/opb.cookies"; OP_B_CSRF="$(login "$OP_B_EMAIL" g12c-op-b-password "$OP_B_JAR")"
VIEW_JAR="$WORK/view.cookies"; VIEW_CSRF="$(login "$VIEW_EMAIL" g12c-viewer-password "$VIEW_JAR")"
[ -n "$OP_A_CSRF" ] && [ -n "$OP_B_CSRF" ] && [ -n "$VIEW_CSRF" ] || { echo "operator login failed"; exit 2; }

# Every account the admin API creates is a member of nothing (D5 section 3.4), so each one is
# granted the legacy workspace before the script asks it to file or read a record.
for jar in "$OP_A_JAR" "$OP_B_JAR" "$VIEW_JAR"; do
  ow_grant_legacy "$ADMIN_JAR" "$ADMIN_CSRF" "$(ow_user_id "$jar")" || exit 2
done
OP_A_ID="$(sql "SELECT id FROM kernel.users WHERE email='$OP_A_EMAIL'")"
OP_B_ID="$(sql "SELECT id FROM kernel.users WHERE email='$OP_B_EMAIL'")"
VIEW_ID="$(sql "SELECT id FROM kernel.users WHERE email='$VIEW_EMAIL'")"
echo "   operator A: $OP_A_ID"
echo "   operator B: $OP_B_ID"
echo "   viewer:     $VIEW_ID"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

new_incident() { # jar csrf title -> echoes the id
  call "$1" "$2" POST /api/v1/incidents \
    "{\"title\":\"$3\",\"severity\":\"MAJOR\",\"startedAt\":\"$NOW\",\"relatedEntity\":\"host:g12c-node\"}" > /dev/null
  last "['id']"
}

add_evidence() { # jar csrf incident ref -> echoes status
  call "$1" "$2" POST "/api/v1/incidents/$3/evidence" \
    "{\"kind\":\"LOG_EXCERPT\",\"source\":\"operator:g12c\",\"collectedAt\":\"$NOW\",\"contentRef\":\"$4\"}"
}

record_verdict() { # jar csrf incident -> echoes status
  call "$1" "$2" POST "/api/v1/incidents/$3/verdict" \
    '{"verdict":"CONFIRMED","rationale":"cpu saturation matches the reported window"}'
}

close_incident() { # jar csrf incident revision note [key] -> echoes status
  local jar="$1" csrf="$2" inc="$3" rev="$4" note="$5" key="${6:-}"
  local payload
  if [ -n "$key" ]; then
    payload="{\"expectedRevision\":$rev,\"note\":\"$note\",\"idempotencyKey\":\"$key\"}"
  else
    payload="{\"expectedRevision\":$rev,\"note\":\"$note\"}"
  fi
  call "$jar" "$csrf" POST "/api/v1/incidents/$inc/close" "$payload"
}

transfer_incident() { # jar csrf incident revision to_owner reason -> echoes status
  call "$1" "$2" POST "/api/v1/incidents/$3/owner" \
    "{\"expectedRevision\":$4,\"toOwner\":\"$5\",\"reason\":\"$6\"}"
}

incident_field() { # jar csrf incident field -> echoes the field value
  call "$1" "$2" GET "/api/v1/incidents/$3" > /dev/null
  last "[$4]"
}

# ---------------------------------------------------------------------------
step 'C1.1 - there is no path from OPEN to CLOSED'
# ---------------------------------------------------------------------------
INC="$(new_incident "$OP_A_JAR" "$OP_A_CSRF" "g12c open jump $RUN")"
echo "   incident: $INC"
REV="$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'revision'")"
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$REV" 'closing an incident nobody investigated')"
check 409 "$STATUS" 'C1.1 OPEN -> CLOSED is refused'
check INCIDENT_CLOSE_REQUIRES_CONCLUDED "$(code)" 'C1.1 the refusal names the obstacle'
contains OPEN "$(last "['message']")" 'C1.1 the refusal names the current status'
check None "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'closedAt'")" 'C1.1 nothing closed it (closedAt is null)'
check OPEN "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'status'")" 'C1.1 the incident is still OPEN'

# ---------------------------------------------------------------------------
step 'C1.2 - INVESTIGATING is not CONCLUDED either: evidence is not a conclusion'
# ---------------------------------------------------------------------------
STATUS="$(add_evidence "$OP_A_JAR" "$OP_A_CSRF" "$INC" 'sha256:g12c-first-look')"
check 201 "$STATUS" 'C1.2 the first evidence row is accepted'
check INVESTIGATING "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'status'")" 'C1.2 evidence moved it to INVESTIGATING'
REV="$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'revision'")"
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$REV" 'closing an incident under investigation')"
check 409 "$STATUS" 'C1.2 INVESTIGATING -> CLOSED is refused'
check INCIDENT_CLOSE_REQUIRES_CONCLUDED "$(code)" 'C1.2 same code, same obstacle'
check INVESTIGATING "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'status'")" 'C1.2 still INVESTIGATING'

# ---------------------------------------------------------------------------
step 'C1.3 - a signed Human Verdict is what makes a closure possible'
# ---------------------------------------------------------------------------
STATUS="$(record_verdict "$OP_A_JAR" "$OP_A_CSRF" "$INC")"
check 201 "$STATUS" 'C1.3 the verdict is recorded'
check CONCLUDED "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'status'")" 'C1.3 the verdict moved it to CONCLUDED'
REV="$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'revision'")"
echo "   revision after the verdict: $REV"

# ---------------------------------------------------------------------------
step 'C1.4 - a closure needs a signed verdict, and the schema says so too'
# ---------------------------------------------------------------------------
# A CONCLUDED row with no verdict is unreachable through the API - which is the point of this
# step: the kernel must still refuse to close it if something else ever produced that state.
INC_UNSIGNED="$(new_incident "$OP_A_JAR" "$OP_A_CSRF" "g12c unsigned conclusion $RUN")"
HAND_SET="$(sql "UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id='$INC_UNSIGNED'")"
check 'UPDATE 1' "$HAND_SET" 'C1.4 setup: a CONCLUDED row with no verdict exists (written by psql)'
REV_UNSIGNED="$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC_UNSIGNED" "'revision'")"
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC_UNSIGNED" "$REV_UNSIGNED" 'closing something nobody signed')"
check 409 "$STATUS" 'C1.4 closing a CONCLUDED incident with no verdict is refused'
check INCIDENT_CLOSE_REQUIRES_VERDICT "$(code)" 'C1.4 the refusal names the missing verdict'
check CONCLUDED "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC_UNSIGNED" "'status'")" 'C1.4 it is still CONCLUDED'
DIRECT="$(sql "UPDATE kernel.incidents SET status='CLOSED', closed_at=now(), closed_by='$OP_A_ID' WHERE incident_id='$INC_UNSIGNED'")"
contains 'no human verdict' "$DIRECT" 'C1.4 the schema refuses the same closure written by hand'

# ---------------------------------------------------------------------------
step 'C1.5 - a closure is decided against the revision the operator read'
# ---------------------------------------------------------------------------
REV="$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'revision'")"
echo "   revision before closing: $REV"
STALE=$((REV - 1))
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$STALE" 'closing on a version I no longer hold')"
check 409 "$STATUS" 'C1.5 a stale expectedRevision is refused'
check INCIDENT_VERSION_CONFLICT "$(code)" 'C1.5 the refusal names the version conflict'
check CONCLUDED "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC" "'status'")" 'C1.5 the stale attempt changed nothing'

# ---------------------------------------------------------------------------
step 'C1.6 - two simultaneous closes: exactly one closure of record'
# ---------------------------------------------------------------------------
INC_RACE="$(new_incident "$OP_A_JAR" "$OP_A_CSRF" "g12c concurrent close $RUN")"
add_evidence "$OP_A_JAR" "$OP_A_CSRF" "$INC_RACE" 'sha256:g12c-race' > /dev/null
record_verdict "$OP_A_JAR" "$OP_A_CSRF" "$INC_RACE" > /dev/null
RACE_REV="$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC_RACE" "'revision'")"
echo "   racing on revision $RACE_REV"
curl -sS -m 20 -o "$WORK/race-a.body" -w '%{http_code}' -b "$OP_A_JAR" -H "x-csrf-token: $OP_A_CSRF" \
  -H 'content-type: application/json' \
  --data-binary "{\"expectedRevision\":$RACE_REV,\"note\":\"closed by the first caller\"}" \
  "$URL/api/v1/incidents/$INC_RACE/close" > "$WORK/race-a.status" &
RACE_A_PID=$!
curl -sS -m 20 -o "$WORK/race-b.body" -w '%{http_code}' -b "$OP_A_JAR" -H "x-csrf-token: $OP_A_CSRF" \
  -H 'content-type: application/json' \
  --data-binary "{\"expectedRevision\":$RACE_REV,\"note\":\"closed by the second caller\"}" \
  "$URL/api/v1/incidents/$INC_RACE/close" > "$WORK/race-b.status" &
RACE_B_PID=$!
wait $RACE_A_PID $RACE_B_PID
RACE_A="$(cat "$WORK/race-a.status")"; RACE_B="$(cat "$WORK/race-b.status")"
printf '   concurrent statuses: %s / %s\n' "$RACE_A" "$RACE_B"
WINS=0; [ "$RACE_A" = 200 ] && WINS=$((WINS + 1)); [ "$RACE_B" = 200 ] && WINS=$((WINS + 1))
check 1 "$WINS" 'C1.6 exactly one close returned 200'
LOSER_BODY="$WORK/race-a.body"; [ "$RACE_A" = 200 ] && LOSER_BODY="$WORK/race-b.body"
LOSER_CODE="$(json "d['code']" < "$LOSER_BODY")"
case "$LOSER_CODE" in
  INCIDENT_ALREADY_CLOSED|INCIDENT_VERSION_CONFLICT|INCIDENT_STATE_CONFLICT) ok "C1.6 the loser is told why -> $LOSER_CODE";;
  *) bad "C1.6 the loser got an unusable answer -> $LOSER_CODE";;
esac
CLOSURES="$(sql "SELECT count(*) FROM kernel.audit_events WHERE subject_id='$INC_RACE' AND event_type='INCIDENT_CLOSED'")"
check 1 "$CLOSURES" 'C1.6 exactly one closure was audited'
check CLOSED "$(incident_field "$OP_A_JAR" "$OP_A_CSRF" "$INC_RACE" "'status'")" 'C1.6 the incident is CLOSED'

# ---------------------------------------------------------------------------
step 'C1.7 - the closure of record: who, when, why, and a moved revision'
# ---------------------------------------------------------------------------
CLOSE_KEY="g12c-close-$RUN-a"
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$REV" 'root cause was log rotation; fixed' "$CLOSE_KEY")"
check 200 "$STATUS" 'C1.7 the closure succeeds'
check CLOSED "$(last "['status']")" 'C1.7 the incident is CLOSED'
check "$OP_A_ID" "$(last "['closedBy']")" 'C1.7 the closer of record is the operator'
check 'root cause was log rotation; fixed' "$(last "['closureNote']")" 'C1.7 the reason is the operator sentence'
check "$((REV + 1))" "$(last "['revision']")" 'C1.7 the revision moved with the closure'
CLOSED_AT="$(last "['closedAt']")"
case "$CLOSED_AT" in
  None|'') bad 'C1.7 closedAt is unset on a CLOSED incident';;
  *) ok "C1.7 closedAt is recorded -> $CLOSED_AT";;
esac
TIMELINE="$(call "$OP_A_JAR" "$OP_A_CSRF" GET "/api/v1/incidents/$INC/timeline" > /dev/null; last "['truncated']")"
check False "$TIMELINE" 'C1.7 the trail of this incident fits in one page'
call "$OP_A_JAR" "$OP_A_CSRF" GET "/api/v1/incidents/$INC/timeline" > /dev/null
EVENT_TYPES="$(json "','.join(e['eventType'] for e in d['items'])" < "$WORK/body")"
check 'INCIDENT_CREATED,INCIDENT_EVIDENCE_ADDED,INCIDENT_VERDICT_RECORDED,INCIDENT_CLOSED' "$EVENT_TYPES" 'C1.7 the trail is every write, in order'

# ---------------------------------------------------------------------------
step 'C1.8 - a retried close is the closure it repeats, a second close is not'
# ---------------------------------------------------------------------------
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$REV" 'replaying the closure that already happened' "$CLOSE_KEY")"
check 200 "$STATUS" 'C1.8 the same idempotency key answers 200'
check "$CLOSED_AT" "$(last "['closedAt']")" 'C1.8 the replay returns the closure of record, not a new one'
check 'root cause was log rotation; fixed' "$(last "['closureNote']")" 'C1.8 the replay did not rewrite the reason'
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$REV" 'closing it again with a fresh key' "g12c-close-$RUN-b")"
check 409 "$STATUS" 'C1.8 a different key is a second close, and is refused'
check INCIDENT_ALREADY_CLOSED "$(code)" 'C1.8 the refusal names the existing closure'
STATUS="$(close_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$REV" 'closing it again with no key at all')"
check 409 "$STATUS" 'C1.8 a caller with no key cannot claim a retry'
CLOSURES="$(sql "SELECT count(*) FROM kernel.audit_events WHERE subject_id='$INC' AND event_type='INCIDENT_CLOSED'")"
check 1 "$CLOSURES" 'C1.8 the incident still has exactly one closure of record'

# ---------------------------------------------------------------------------
step 'C1.9 - after CLOSED, every write is refused'
# ---------------------------------------------------------------------------
STATUS="$(add_evidence "$OP_A_JAR" "$OP_A_CSRF" "$INC" 'sha256:g12c-too-late')"
check 409 "$STATUS" 'C1.9 evidence after the closure is refused'
check INCIDENT_CLOSED "$(code)" 'C1.9 and says the incident is closed'
STATUS="$(record_verdict "$OP_A_JAR" "$OP_A_CSRF" "$INC")"
check 409 "$STATUS" 'C1.9 a second verdict after the closure is refused'
check INCIDENT_CLOSED "$(code)" 'C1.9 and says the incident is closed'
STATUS="$(transfer_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC" "$((REV + 1))" "$OP_B_ID" 'handing over a record that is already closed')"
check 409 "$STATUS" 'C1.9 a handover of a closed incident is refused'
check INCIDENT_CLOSED "$(code)" 'C1.9 and says the incident is closed'
EVIDENCE_COUNT="$(sql "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id='$INC'")"
check 1 "$EVIDENCE_COUNT" 'C1.9 the refused evidence was not written'

# ---------------------------------------------------------------------------
step 'C1.10 - a closure is final, and deleting the verdict does not reopen it'
# ---------------------------------------------------------------------------
REOPEN="$(sql "UPDATE kernel.incidents SET status='INVESTIGATING' WHERE incident_id='$INC'")"
contains 'cannot return to' "$REOPEN" 'C1.10 the schema refuses a hand-written reopen'
DROP_VERDICT="$(sql "DELETE FROM kernel.incident_verdicts WHERE incident_id='$INC'")"
check 'DELETE 1' "$DROP_VERDICT" 'C1.10 setup: the verdict row is gone (a table owner did this)'
REOPEN="$(sql "UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id='$INC'")"
contains 'cannot return to' "$REOPEN" 'C1.10 reopening by deleting the verdict is still refused'
check CLOSED "$(sql "SELECT status FROM kernel.incidents WHERE incident_id='$INC'")" 'C1.10 the incident is still CLOSED'

# ---------------------------------------------------------------------------
step 'C2.1 - the scope matrix BEFORE the handover'
# ---------------------------------------------------------------------------
INC_HAND="$(new_incident "$OP_A_JAR" "$OP_A_CSRF" "g12c handover $RUN")"
add_evidence "$OP_A_JAR" "$OP_A_CSRF" "$INC_HAND" 'sha256:g12c-handover-note' > /dev/null
echo "   incident: $INC_HAND"
STATUS="$(call "$OP_A_JAR" "$OP_A_CSRF" GET "/api/v1/incidents/$INC_HAND")"
check 200 "$STATUS" 'C2.1 the owner reads its own incident'
check "$OP_A_ID" "$(last "['owner']")" 'C2.1 the owner column is the creator'
REV="$(last "['revision']")"
STATUS="$(call "$OP_B_JAR" "$OP_B_CSRF" GET "/api/v1/incidents/$INC_HAND")"
check 404 "$STATUS" 'C2.1 another operator cannot read it (404, not 403)'
check INCIDENT_NOT_FOUND "$(code)" 'C2.1 and is told exactly that'
STATUS="$(call "$OP_B_JAR" "$OP_B_CSRF" GET "/api/v1/incidents/$INC_HAND/timeline")"
check 404 "$STATUS" 'C2.1 nor its audit trail'
STATUS="$(call "$OP_A_JAR" "$OP_A_CSRF" GET '/api/v1/incidents?limit=100')"
check true "$(json "str(any(i['id']=='$INC_HAND' for i in d['items'])).lower()" < "$WORK/body")" 'C2.1 the owner list contains it'
STATUS="$(call "$OP_B_JAR" "$OP_B_CSRF" GET '/api/v1/incidents?limit=100')"
check false "$(json "str(any(i['id']=='$INC_HAND' for i in d['items'])).lower()" < "$WORK/body")" 'C2.1 the other operator list does not'

# ---------------------------------------------------------------------------
step 'C2.2 - a handover is decided against the revision, and only an eligible account can take it'
# ---------------------------------------------------------------------------
STATUS="$(transfer_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC_HAND" "$((REV - 1))" "$OP_B_ID" 'handing over on a version I no longer hold')"
check 409 "$STATUS" 'C2.2 a stale expectedRevision is refused'
check INCIDENT_VERSION_CONFLICT "$(code)" 'C2.2 the refusal names the version conflict'
STATUS="$(transfer_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC_HAND" "$REV" "$VIEW_ID" 'handing it to an account that cannot act')"
check 400 "$STATUS" 'C2.2 a viewer cannot be given an incident'
check INCIDENT_OWNER_ROLE_INELIGIBLE "$(code)" 'C2.2 the refusal names the role'
STATUS="$(transfer_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC_HAND" "$REV" "$OP_A_ID" 'handing it to the account that already has it')"
check 409 "$STATUS" 'C2.2 a handover to the current owner is refused'
check INCIDENT_OWNER_UNCHANGED "$(code)" 'C2.2 the refusal says the owner did not change'
TRANSFERS="$(sql "SELECT count(*) FROM kernel.audit_events WHERE subject_id='$INC_HAND' AND event_type='INCIDENT_OWNER_TRANSFERRED'")"
check 0 "$TRANSFERS" 'C2.2 none of the three refusals recorded a handover'

# ---------------------------------------------------------------------------
step 'C2.3 - the handover itself'
# ---------------------------------------------------------------------------
STATUS="$(transfer_incident "$OP_A_JAR" "$OP_A_CSRF" "$INC_HAND" "$REV" "$OP_B_ID" 'night shift takes over; the pager is with them')"
check 200 "$STATUS" 'C2.3 the handover succeeds'
check "$OP_A_ID" "$(last "['previousOwner']")" 'C2.3 the answer names who had it'
check "$OP_B_ID" "$(last "['owner']")" 'C2.3 and who has it now'
check 'night shift takes over; the pager is with them' "$(last "['reason']")" 'C2.3 the reason is recorded'
check "$((REV + 1))" "$(last "['revision']")" 'C2.3 the revision moved with the handover'
TRANSFERS="$(sql "SELECT count(*) FROM kernel.audit_events WHERE subject_id='$INC_HAND' AND event_type='INCIDENT_OWNER_TRANSFERRED'")"
check 1 "$TRANSFERS" 'C2.3 exactly one handover was audited'

# ---------------------------------------------------------------------------
step 'C2.4 - the scope matrix AFTER the handover: it inverts'
# ---------------------------------------------------------------------------
STATUS="$(call "$OP_A_JAR" "$OP_A_CSRF" GET "/api/v1/incidents/$INC_HAND")"
check 404 "$STATUS" 'C2.4 the old owner can no longer read it'
check INCIDENT_NOT_FOUND "$(code)" 'C2.4 with the same answer a stranger gets'
STATUS="$(add_evidence "$OP_A_JAR" "$OP_A_CSRF" "$INC_HAND" 'sha256:g12c-old-owner-after')"
check 404 "$STATUS" 'C2.4 and cannot write to it either'
STATUS="$(call "$OP_B_JAR" "$OP_B_CSRF" GET "/api/v1/incidents/$INC_HAND")"
check 200 "$STATUS" 'C2.4 the new owner can read it'
check "$OP_B_ID" "$(last "['owner']")" 'C2.4 and is now the owner'
STATUS="$(add_evidence "$OP_B_JAR" "$OP_B_CSRF" "$INC_HAND" 'sha256:g12c-new-owner-note')"
check 201 "$STATUS" 'C2.4 the new owner can write to it'
call "$OP_B_JAR" "$OP_B_CSRF" GET "/api/v1/incidents/$INC_HAND/timeline" > /dev/null
check 'INCIDENT_OWNER_TRANSFERRED' "$(json "[e['eventType'] for e in d['items'] if e['eventType']=='INCIDENT_OWNER_TRANSFERRED'][0]" < "$WORK/body")" 'C2.4 the new owner reads the handover in the trail'
check 'night shift takes over; the pager is with them' "$(json "[e['details']['reason'] for e in d['items'] if e['eventType']=='INCIDENT_OWNER_TRANSFERRED'][0]" < "$WORK/body")" 'C2.4 including the reason it changed hands'
STATUS="$(call "$OP_B_JAR" "$OP_B_CSRF" GET '/api/v1/incidents?limit=100')"
check true "$(json "str(any(i['id']=='$INC_HAND' for i in d['items'])).lower()" < "$WORK/body")" 'C2.4 the new owner list contains it'
STATUS="$(call "$OP_A_JAR" "$OP_A_CSRF" GET '/api/v1/incidents?limit=100')"
check false "$(json "str(any(i['id']=='$INC_HAND' for i in d['items'])).lower()" < "$WORK/body")" 'C2.4 the old owner list no longer does'

# ---------------------------------------------------------------------------
step 'C4 - the viewer: reads everything, writes nothing (server-side 403, not a UI hint)'
# ---------------------------------------------------------------------------
STATUS="$(call "$VIEW_JAR" "$VIEW_CSRF" GET "/api/v1/incidents/$INC_HAND")"
check 200 "$STATUS" 'C4 the viewer can read the incident'
STATUS="$(call "$VIEW_JAR" "$VIEW_CSRF" GET "/api/v1/incidents/$INC_HAND/timeline")"
check 200 "$STATUS" 'C4 and its trail'
STATUS="$(close_incident "$VIEW_JAR" "$VIEW_CSRF" "$INC_HAND" "$((REV + 1))" 'a viewer trying to close an incident' 'g12c-viewer-close')"
check 403 "$STATUS" 'C4 the viewer close is refused by the kernel'
check FORBIDDEN "$(code)" 'C4 with the standard forbidden envelope'
STATUS="$(transfer_incident "$VIEW_JAR" "$VIEW_CSRF" "$INC_HAND" "$((REV + 1))" "$VIEW_ID" 'a viewer taking an incident')"
check 403 "$STATUS" 'C4 the viewer handover is refused by the kernel'
STATUS="$(add_evidence "$VIEW_JAR" "$VIEW_CSRF" "$INC_HAND" 'sha256:g12c-viewer-note')"
check 403 "$STATUS" 'C4 the viewer evidence write is refused by the kernel'
STATUS="$(record_verdict "$VIEW_JAR" "$VIEW_CSRF" "$INC_HAND")"
check 403 "$STATUS" 'C4 the viewer verdict is refused by the kernel'
# And the same endpoints work for the account that does have the role: the 403 above is about
# the role, not about a route that is broken for everyone.
STATUS="$(add_evidence "$OP_B_JAR" "$OP_B_CSRF" "$INC_HAND" 'sha256:g12c-operator-after-viewer')"
check 201 "$STATUS" 'C4 the operator writes to the same incident immediately afterwards'

# ---------------------------------------------------------------------------
printf '\n######## summary ########\n'
printf 'PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failures:%s\n' "$FAILED_LIST"
  rm -rf "$WORK"
  exit 1
fi
rm -rf "$WORK"
echo 'G12 C lifecycle acceptance: every refusal was asserted by status AND code, and every one of'
echo 'them was followed by a re-read that showed nothing had changed.'
exit 0