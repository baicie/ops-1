#!/usr/bin/env bash
# G13-B1.4 acceptance: the workspace automation-incident queue, over real HTTP.
#
# What this proves, against a running Kernel and a real PostgreSQL:
#   * a Workspace Operator sees an unclaimed automation incident in the bounded queue;
#   * the claim is atomic and takes ownership, after which the ordinary GET and the
#     existing evidence / verdict / close routes work unchanged;
#   * a second operator's claim is 409 INCIDENT_CLAIM_TAKEN and changes nothing;
#   * Workspace B's operator cannot list or claim Workspace A's row (404, no existence oracle);
#   * a viewer is refused at the handler (403) for both queue and claim;
#   * release returns the row to the queue, ends the releaser's read access, and is audited;
#   * a CONCLUDED row cannot be claimed.
#
# THE INCIDENT IS A FIXTURE. It is inserted with the exact state the Event handler
# writes (origin AUTOMATION, owner = the non-login automation service user), because
# this script does not start a Node, an OCI plugin or Zabbix. The Event -> Job ->
# collect -> attestation path is covered by the Kernel's own DB-backed tests and by
# tests/ci/g13a1_gateway_e2e.sh; this script covers the operator half, which needs no
# upstream. REAL_ZABBIX_VERIFIED = NOT_RUN for this run.
#
# Requires:
#   OPSWEAVE_URL, OPSWEAVE_ADMIN_EMAIL, OPSWEAVE_ADMIN_PASSWORD,
#   OPSWEAVE_DATABASE_URL (psql-accessible) because of the fixture row.
#
# Creates its own accounts and workspaces through the public API. Run only against a
# throw-away database.
set -uo pipefail

URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:?set OPSWEAVE_ADMIN_EMAIL}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:?set OPSWEAVE_ADMIN_PASSWORD}"
DATABASE_URL="${OPSWEAVE_DATABASE_URL:?set OPSWEAVE_DATABASE_URL for the fixture row}"
RUN="$(date +%s)-$$"
WORK="$(mktemp -d)"
PASS=0; FAIL=0; FAILED=()
SERVICE_USER="00000000-0000-4000-8000-0000000000a1"

# Every assertion writes to stderr: the functions that create fixtures echo their
# identifier on stdout and are read with $(...), so a PASS line on stdout would be
# captured into the id (observed in the first run of this script).
ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*" >&2; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$*"); printf 'FAIL  %s\n' "$*" >&2; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
compact() { python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), separators=(",",":")))
except Exception:
    sys.stdin.seek(0)
    print(sys.stdin.read().strip()[:400])' < "$1"; }

call() { # jar csrf method path [body] -> status
  local jar="$1" csrf="$2" method="$3" path="$4" body="${5:-}"
  local args=(-sS -m 20 -o "$WORK/body" -w '%{http_code}' -X "$method")
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
  body="$(curl -sS -m 20 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

echo "== kernel: $URL   run: $RUN"
curl -sS -m 20 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed for $ADMIN_EMAIL"; exit 2; }
ADMIN_ID="$(curl -sS -b "$ADMIN_JAR" "$URL/api/v1/auth/me" | json "d['user']['id']")"
. "$(cd "$(dirname "$0")" && pwd)/lib/workspace_grant.sh"
ow_grant_legacy_self "$ADMIN_JAR" "$ADMIN_CSRF" || { echo "the admin could not be granted a workspace"; exit 2; }

create_user() { # role email password -> id
  local role="$1" email="$2" password="$3" status
  status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"$email\",\"displayName\":\"g13 $role\",\"password\":\"$password\",\"role\":\"$role\"}")"
  check 200 "$status" "admin creates $role $email"
  curl -sS -b "$ADMIN_JAR" "$URL/api/v1/users" \
    | python3 -c "import json,sys
d=json.load(sys.stdin)
print(next((u['id'] for u in d if u['email']=='$email'), ''))"
}

create_workspace() { # key name -> id
  local key="$1" name="$2" status
  status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/business-workspaces \
    "{\"key\":\"$key\",\"name\":\"$name\"}")"
  check 201 "$status" "admin creates workspace $key"
  python3 -c "import json;print(json.load(open('$WORK/body'))['workspaceId'])"
}

grant() { # workspace user -> status
  local status
  status="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/business-workspaces/$1/members" \
    "{\"userId\":\"$2\"}")"
  case "$status" in 200|201) ok "membership $2 in $1 -> $status";; *) bad "membership $2 in $1 -> $status";; esac
}

OPERATOR_EMAIL="g13-op-$RUN@example.invalid"; OPERATOR_PASSWORD='g13-operator-password-1'
OTHER_EMAIL="g13-op2-$RUN@example.invalid";    OTHER_PASSWORD='g13-operator2-password-1'
DUAL_EMAIL="g13-dual-$RUN@example.invalid";    DUAL_PASSWORD='g13-dual-password-1'
VIEWER_EMAIL="g13-view-$RUN@example.invalid";  VIEWER_PASSWORD='g13-viewer-password-1'
OPERATOR_ID="$(create_user operator "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD")"
OTHER_ID="$(create_user operator "$OTHER_EMAIL" "$OTHER_PASSWORD")"
DUAL_ID="$(create_user operator "$DUAL_EMAIL" "$DUAL_PASSWORD")"
VIEWER_ID="$(create_user viewer "$VIEWER_EMAIL" "$VIEWER_PASSWORD")"
for id in "$OPERATOR_ID" "$OTHER_ID" "$DUAL_ID" "$VIEWER_ID"; do
  [ -n "$id" ] || { echo "a fixture account was not created"; exit 2; }
done

WS_A="$(create_workspace "g13-a-$RUN" "G13 workspace A")"
WS_B="$(create_workspace "g13-b-$RUN" "G13 workspace B")"
[ -n "$WS_A" ] && [ -n "$WS_B" ] || { echo "a fixture workspace was not created"; exit 2; }
grant "$WS_A" "$OPERATOR_ID"
grant "$WS_A" "$DUAL_ID"
grant "$WS_B" "$OTHER_ID"
grant "$WS_B" "$DUAL_ID"

INCIDENT_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NATIVE_ID="fixture-$RUN"
echo
echo "== FIXTURE (not Zabbix): the exact row the Event handler writes"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO kernel.incidents
     (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
   VALUES ('$INCIDENT_ID','fixture automation failure','MAJOR','OPEN','ZABBIX','$NATIVE_ID',now(),'$SERVICE_USER','$WS_A','AUTOMATION')" \
  || { echo "fixture insert failed"; exit 2; }

OPERATOR_JAR="$WORK/operator.cookies"; OPERATOR_CSRF="$(login "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD" "$OPERATOR_JAR")"
OTHER_JAR="$WORK/other.cookies";       OTHER_CSRF="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD" "$OTHER_JAR")"
DUAL_JAR="$WORK/dual.cookies";         DUAL_CSRF="$(login "$DUAL_EMAIL" "$DUAL_PASSWORD" "$DUAL_JAR")"
VIEWER_JAR="$WORK/viewer.cookies";     VIEWER_CSRF="$(login "$VIEWER_EMAIL" "$VIEWER_PASSWORD" "$VIEWER_JAR")"
[ -n "$OPERATOR_CSRF" ] && [ -n "$OTHER_CSRF" ] && [ -n "$DUAL_CSRF" ] && [ -n "$VIEWER_CSRF" ] \
  || { echo "a fixture login failed"; exit 2; }

echo
echo "== 1. the operator's ordinary list does NOT widen; the queue shows the row"
status="$(call "$OPERATOR_JAR" "" GET '/api/v1/incidents?limit=100')"
check 200 "$status" "operator lists incidents"
if python3 -c "import json,sys;d=json.load(open('$WORK/body'));sys.exit(0 if any(i['id']=='$INCIDENT_ID' for i in d['items']) else 1)"; then
  bad "the unclaimed automation incident leaked into the ordinary operator list"
else
  ok "the unclaimed automation incident is absent from the ordinary operator list"
fi
status="$(call "$OPERATOR_JAR" "" GET /api/v1/incidents/claimable)"
check 200 "$status" "operator reads the claim queue"
python3 -c "import json,sys;d=json.load(open('$WORK/body'));sys.exit(0 if any(i['id']=='$INCIDENT_ID' for i in d['items']) else 1)" \
  && ok "the queue contains the unclaimed automation incident" \
  || bad "the queue does not contain the unclaimed automation incident"

echo
echo "== 2. Workspace B cannot list or claim Workspace A's row"
status="$(call "$OTHER_JAR" "" GET /api/v1/incidents/claimable)"
check 200 "$status" "workspace B operator reads its own queue"
python3 -c "import json,sys;d=json.load(open('$WORK/body'));sys.exit(0 if any(i['id']=='$INCIDENT_ID' for i in d['items']) else 1)" \
  && bad "workspace B's queue leaked workspace A's row" \
  || ok "workspace B's queue does not contain workspace A's row"
status="$(call "$OTHER_JAR" "$OTHER_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/claim" '{"expectedRevision":1}')"
check 404 "$status" "workspace B's claim is 404"
owner="$(psql "$DATABASE_URL" -Atc "SELECT owner FROM kernel.incidents WHERE incident_id='$INCIDENT_ID'")"
check "$SERVICE_USER" "$owner" "a refused cross-workspace claim changes nothing"

echo
echo "== 3. a viewer is refused at the handler"
status="$(call "$VIEWER_JAR" "" GET /api/v1/incidents/claimable)"
check 403 "$status" "viewer reads the claim queue"
status="$(call "$VIEWER_JAR" "$VIEWER_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/claim" '{"expectedRevision":1}')"
check 403 "$status" "viewer claims an incident"

echo
echo "== 4. the operator claims; a second operator loses with 409"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/claim" '{"expectedRevision":1}')"
check 200 "$status" "operator claims the queue row"
check "$OPERATOR_ID" "$(python3 -c "import json;print(json.load(open('$WORK/body'))['owner'])")" "the claim moved ownership to the operator"
REV="$(python3 -c "import json;print(json.load(open('$WORK/body'))['revision'])")"
status="$(call "$DUAL_JAR" "$DUAL_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/claim" "{\"expectedRevision\":1}")"
check 409 "$status" "a second operator's claim is a conflict"
check "INCIDENT_CLAIM_TAKEN" "$(python3 -c "import json;print(json.load(open('$WORK/body')).get('code',''))")" "the conflict has a stable code"
status="$(call "$DUAL_JAR" "" GET /api/v1/incidents/claimable)"
python3 -c "import json,sys;d=json.load(open('$WORK/body'));sys.exit(0 if any(i['id']=='$INCIDENT_ID' for i in d['items']) else 1)" \
  && bad "a claimed row stayed in the queue" \
  || ok "a claimed row leaves the queue"
status="$(call "$OPERATOR_JAR" "" GET "/api/v1/incidents/$INCIDENT_ID")"
check 200 "$status" "the new owner reads the incident"
check "AUTOMATION" "$(python3 -c "import json;print(json.load(open('$WORK/body'))['origin'])")" "the payload carries its automation origin"
check "False" "$(python3 -c "import json;print(json.load(open('$WORK/body'))['claimable'])")" "the payload no longer calls it claimable"

echo
echo "== 5. release returns it to the queue and ends read access"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/release" "{\"expectedRevision\":$REV}")"
check 200 "$status" "the owner releases the incident"
check "$SERVICE_USER" "$(psql "$DATABASE_URL" -Atc "SELECT owner FROM kernel.incidents WHERE incident_id='$INCIDENT_ID'")" "release restores the service owner"
status="$(call "$OPERATOR_JAR" "" GET "/api/v1/incidents/$INCIDENT_ID")"
check 404 "$status" "the releaser can no longer read the row"
status="$(call "$OPERATOR_JAR" "" GET /api/v1/incidents/claimable)"
python3 -c "import json,sys;d=json.load(open('$WORK/body'));sys.exit(0 if any(i['id']=='$INCIDENT_ID' for i in d['items']) else 1)" \
  && ok "the released row is back in the queue" \
  || bad "the released row did not return to the queue"
NEW_REV="$(python3 -c "import json
d=json.load(open('$WORK/body'))
print(next(i['revision'] for i in d['items'] if i['id']=='$INCIDENT_ID'))")"

echo
echo "== 6. re-claim, then the existing evidence -> verdict -> close path"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/claim" "{\"expectedRevision\":$NEW_REV}")"
check 200 "$status" "the operator re-claims the released row"
REV="$(python3 -c "import json;print(json.load(open('$WORK/body'))['revision'])")"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/evidence" \
  "{\"kind\":\"OPERATOR_NOTE\",\"source\":\"g13-b14-acceptance\",\"collectedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"contentRef\":\"note:b14-$RUN\"}")"
check 201 "$status" "the owner appends evidence"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/verdict" \
  '{"verdict":"CONFIRMED","rationale":"the fixture automation snapshot matches the report"}')"
check 201 "$status" "the owner signs the human verdict"
status="$(call "$OPERATOR_JAR" "" GET "/api/v1/incidents/$INCIDENT_ID")"
REV="$(python3 -c "import json;print(json.load(open('$WORK/body'))['revision'])")"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/close" \
  "{\"expectedRevision\":$REV,\"note\":\"the owner closed the automation incident after review\"}")"
check 200 "$status" "the owner closes the incident"
status="$(call "$OPERATOR_JAR" "$OPERATOR_CSRF" POST "/api/v1/incidents/$INCIDENT_ID/claim" '{"expectedRevision":1}')"
check 409 "$status" "a closed, owned row is not claimable (409, not a second claim)"
check "INCIDENT_CLAIM_NOT_AVAILABLE" "$(python3 -c "import json;print(json.load(open('$WORK/body')).get('code',''))")" "the closed-row refusal has a stable code"

echo
echo "== 7. the trail records claim, refusal and release"
CLAIMED="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM kernel.audit_events WHERE event_type='INCIDENT_CLAIMED' AND subject_id='$INCIDENT_ID'")"
[ "$CLAIMED" -ge 2 ] && ok "INCIDENT_CLAIMED rows: $CLAIMED (claim + re-claim)" || bad "INCIDENT_CLAIMED rows: $CLAIMED"
REFUSED="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM kernel.audit_events WHERE event_type='INCIDENT_CLAIM_REFUSED' AND subject_id='$INCIDENT_ID'")"
[ "$REFUSED" -ge 1 ] && ok "INCIDENT_CLAIM_REFUSED rows: $REFUSED" || bad "INCIDENT_CLAIM_REFUSED rows: $REFUSED"
RELEASED="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM kernel.audit_events WHERE event_type='INCIDENT_RELEASED' AND subject_id='$INCIDENT_ID'")"
[ "$RELEASED" -eq 1 ] && ok "INCIDENT_RELEASED rows: $RELEASED" || bad "INCIDENT_RELEASED rows: $RELEASED"

echo
echo "== cleanup (fixtures only)"
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id='$INCIDENT_ID'" 2>/dev/null
psql "$DATABASE_URL" -q -c "DELETE FROM kernel.incidents WHERE incident_id='$INCIDENT_ID'" 2>/dev/null
for ws in "$WS_A" "$WS_B"; do psql "$DATABASE_URL" -q -c "DELETE FROM kernel.business_workspaces WHERE workspace_id='$ws'" 2>/dev/null; done
for id in "$OPERATOR_ID" "$OTHER_ID" "$DUAL_ID" "$VIEWER_ID"; do psql "$DATABASE_URL" -q -c "DELETE FROM kernel.users WHERE id='$id'" 2>/dev/null; done

echo
printf 'g13_b14_claim: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed: %s\n' "${FAILED[*]}"
  exit 1
fi
exit 0
