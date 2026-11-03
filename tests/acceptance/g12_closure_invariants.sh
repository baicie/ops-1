#!/usr/bin/env bash
# G12 D2 acceptance: the CLOSED incident is a database invariant, not an API convention.
#
#   OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_DATABASE_URL=postgres://localhost/x \
#   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... tests/acceptance/g12_closure_invariants.sh
#
# What this script is for. 0019's closure guard is a BEFORE UPDATE OF status trigger, and its
# CHECK only ties the closure columns to the status. Measured against a real database, that left
# two ways to write a closure nobody signed:
#
#   1. INSERT a row already CLOSED (no trigger ran at all);
#   2. after a legitimate close, rewrite closure_note / closed_at / closed_by / closure_key,
#      because those writes do not mention `status` and the trigger never fires.
#
# 0024 closes both. Every assertion below runs the *hostile* statement against the real schema
# and requires a refusal, then re-reads the row to show nothing changed - a refusal that still
# left the row edited would be the same defect wearing an error message. The last two steps run
# the LEGITIMATE path over HTTP (create, evidence, verdict, close) so the migration is proven not
# to have broken the one closure the product is allowed to make.
#
# The database URL is used for what no client can do: hand-written SQL, which is the whole point.
set -uo pipefail
URL="$OPSWEAVE_URL"; [ -n "$URL" ] || URL=http://127.0.0.1:18199
ADMIN_EMAIL="$OPSWEAVE_ADMIN_EMAIL"
ADMIN_PASSWORD="$OPSWEAVE_ADMIN_PASSWORD"
DB="$OPSWEAVE_DATABASE_URL"
if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ] || [ -z "$DB" ]; then
  echo "set OPSWEAVE_ADMIN_EMAIL, OPSWEAVE_ADMIN_PASSWORD and OPSWEAVE_DATABASE_URL"; exit 2
fi
RUN="$(date +%s)-$$"
WORK="$(mktemp -d)"
PASS=0; FAIL=0; FAILED_LIST=""

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED_LIST="$FAILED_LIST
  $*"; printf 'FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi; }
contains() { case "$2" in *"$1"*) ok "$3";; *) bad "$3 (got: $(printf '%s' "$2" | head -c 300))";; esac; }
refused() { case "$2" in *ERROR*) ok "$3";; *) bad "$3 (statement was NOT refused; got: $(printf '%s' "$2" | head -c 200))";; esac; }
step() { printf '\n######## %s ########\n' "$*"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
compact() { python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), separators=(",",":"))[:400])
except Exception:
    sys.stdin.seek(0); print(sys.stdin.read().strip()[:400])' < "$1"; }

call() {
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
# statement_timeout so a lock left by a previous run reports as a timeout instead of hanging the
# suite: several assertions below are expected to RAISE, and a raised statement must not queue.
# statement_timeout goes on the CONNECTION, not as a leading statement: `psql -c "SET ...; ..."`
# prints a `SET` line before the real result, which made three assertions compare against "SET"
# instead of the rows (and hid a genuine pass as a failure). PGOPTIONS reaches the server before
# the first statement and adds no output.
_sql() { PGOPTIONS='-c statement_timeout=15000' psql "$DB" -tAc "$1" 2>&1; }
sql() { _sql "$1" | grep -v '^SET$'; }
sqlq() { PGOPTIONS='-c statement_timeout=15000' psql "$DB" -tAc "$1" 2>&1; }

login() {
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

echo "== kernel: $URL   run: $RUN"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed"; exit 2; }
. "$(cd "$(dirname "$0")" && pwd)/lib/workspace_grant.sh"
ow_grant_legacy_self "$ADMIN_JAR" "$ADMIN_CSRF" || { echo "the admin could not be granted a workspace"; exit 2; }
ADMIN_ID="$(sqlq "SELECT id FROM kernel.users WHERE email='$ADMIN_EMAIL'")"
WS="${OPSWEAVE_LEGACY_WORKSPACE_ID:-00000000-0000-4000-8000-000000000001}"
echo "   admin: $ADMIN_ID"

# The migration under test must actually be applied; otherwise every refusal below could come
# from a database that predates it, which would make the suite green for the wrong reason.
step '0 - the guard this suite asserts on is installed'
TRIGGER_SRC="$(sqlq "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='incidents_closure_guard' AND NOT tgisinternal")"
contains 'INSERT OR UPDATE' "$TRIGGER_SRC" '0.1 the guard fires on INSERT as well as UPDATE (0024)'
FN="$(sqlq "SELECT pg_get_functiondef('kernel.incident_closure_guard'::regproc)")"
contains 'cannot be inserted already CLOSED' "$FN" '0.2 the function refuses a born-closed row'
contains 'cannot be rewritten' "$FN" '0.3 the function refuses a rewritten closure'

# ---------------------------------------------------------------------------
step '1 - INSERT a CLOSED row with no verdict: refused'
# ---------------------------------------------------------------------------
BEFORE_ID="$(sqlq "SELECT incident_id FROM kernel.incidents WHERE status='CLOSED' LIMIT 1")"
INSERT_CLOSED="$(sql "INSERT INTO kernel.incidents
    (incident_id,title,severity,status,source,started_at,owner,workspace_id,closed_at,closed_by,closure_note)
  VALUES (gen_random_uuid(),'hand-written closure with no verdict','MAJOR','CLOSED','MANUAL',now(),
          '$ADMIN_ID','$WS',now(),'$ADMIN_ID','written by psql')")"
refused 'x' "$INSERT_CLOSED" '1.1 a row cannot be born CLOSED'
contains 'cannot be inserted already CLOSED' "$INSERT_CLOSED" '1.2 the refusal names the rule'
COUNT="$(sqlq "SELECT count(*) FROM kernel.incidents WHERE title='hand-written closure with no verdict'")"
check '0' "$COUNT" '1.3 and nothing was written'

# ---------------------------------------------------------------------------
step '2 - a legitimate closure, made over HTTP'
# ---------------------------------------------------------------------------
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents \
  "{\"title\":\"g12d2 closure $RUN\",\"severity\":\"MAJOR\",\"startedAt\":\"$NOW\",\"relatedEntity\":\"host:g12d2\"}" > /dev/null
INC="$(last "['id']")"
echo "   incident: $INC"
call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"LOG_EXCERPT\",\"source\":\"operator:g12d2\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:g12d2-$RUN\"}" > /dev/null
check 201 "$(printf '%s' "$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INC/verdict" \
  '{"verdict":"CONFIRMED","rationale":"cpu saturation matches the reported window"}')")" '2.1 the human verdict is signed'
REV="$(sqlq "SELECT revision FROM kernel.incidents WHERE incident_id='$INC'")"
CLOSED="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INC/close" \
  "{\"expectedRevision\":$REV,\"note\":\"closed by the signed verdict\"}")"
check 200 "$CLOSED" '2.2 the legitimate close still works (0024 did not break the API path)'
check 'CLOSED' "$(sqlq "SELECT status FROM kernel.incidents WHERE incident_id='$INC'")" '2.3 and the row is CLOSED'
NOTE_BEFORE="$(sqlq "SELECT closure_note FROM kernel.incidents WHERE incident_id='$INC'")"
AT_BEFORE="$(sqlq "SELECT closed_at FROM kernel.incidents WHERE incident_id='$INC'")"
BY_BEFORE="$(sqlq "SELECT closed_by FROM kernel.incidents WHERE incident_id='$INC'")"

# ---------------------------------------------------------------------------
step '3 - rewriting the closure after the fact: refused, and nothing changed'
# ---------------------------------------------------------------------------
R_NOTE="$(sql "UPDATE kernel.incidents SET closure_note='a different reason entirely' WHERE incident_id='$INC'")"
refused 'x' "$R_NOTE" '3.1 the closure note cannot be rewritten'
R_AT="$(sql "UPDATE kernel.incidents SET closed_at='2020-01-01T00:00:00Z' WHERE incident_id='$INC'")"
refused 'x' "$R_AT" '3.2 the closure time cannot be rewritten'
# A DIFFERENT account: setting the closer to the value it already has is a no-op and legal
# (step 4 proves that). The hostile case is naming somebody else.
# A second account is created through the admin API rather than looked up: a fresh database has
# exactly one user, and a suite that quietly skips its hostile case on that database would report
# a stronger result than it measured.
call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
  "{\"email\":\"g12d2-other-$RUN@example.invalid\",\"displayName\":\"g12d2 second account\",\"password\":\"g12d2-other-password\",\"role\":\"operator\"}" > /dev/null
OTHER_ID="$(sqlq "SELECT id FROM kernel.users WHERE email='g12d2-other-$RUN@example.invalid'")"
if [ -n "$OTHER_ID" ]; then
  R_BY="$(sql "UPDATE kernel.incidents SET closed_by='$OTHER_ID' WHERE incident_id='$INC'")"
  refused 'x' "$R_BY" '3.3 the closer cannot be handed to another account'
else
  # A one-account database cannot express this; say so instead of passing silently.
  bad '3.3 no second account exists, so "the closer cannot be handed to another account" did NOT run'
fi
R_KEY="$(sql "UPDATE kernel.incidents SET closure_key='forged-replay-key' WHERE incident_id='$INC'")"
refused 'x' "$R_KEY" '3.4 a replay key cannot be attached to a finished closure'
R_STATUS="$(sql "UPDATE kernel.incidents SET status='INVESTIGATING' WHERE incident_id='$INC'")"
refused 'x' "$R_STATUS" '3.5 reopening is still refused (0019 rule, kept by 0024)'
check "$NOTE_BEFORE" "$(sqlq "SELECT closure_note FROM kernel.incidents WHERE incident_id='$INC'")" '3.6 the note is exactly what was signed'
check "$AT_BEFORE" "$(sqlq "SELECT closed_at FROM kernel.incidents WHERE incident_id='$INC'")" '3.7 the closure time is exactly what was signed'
check "$BY_BEFORE" "$(sqlq "SELECT closed_by FROM kernel.incidents WHERE incident_id='$INC'")" '3.8 the closer is exactly who signed'

# ---------------------------------------------------------------------------
step '4 - a no-op touch stays legal'
# ---------------------------------------------------------------------------
# The handler bumps updated_at on paths that are not about the closure. Refusing that would be a
# rule about punctuation, and it would break a future code path for no safety gain.
NOOP="$(sql "UPDATE kernel.incidents SET updated_at=updated_at WHERE incident_id='$INC'")"
check 'UPDATE 1' "$NOOP" '4.1 an UPDATE that changes nothing is allowed'
SAME_NOTE="$(sql "UPDATE kernel.incidents SET closure_note=closure_note WHERE incident_id='$INC'")"
check 'UPDATE 1' "$SAME_NOTE" '4.2 setting a closure column to its own value is allowed'

# ---------------------------------------------------------------------------
step '5 - CONCLUDED with no verdict still cannot be closed, by either path'
# ---------------------------------------------------------------------------
call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/incidents \
  "{\"title\":\"g12d2 unsigned $RUN\",\"severity\":\"MINOR\",\"startedAt\":\"$NOW\",\"relatedEntity\":\"host:g12d2\"}" > /dev/null
INC_UNSIGNED="$(last "['id']")"
HAND="$(sql "UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id='$INC_UNSIGNED'")"
check 'UPDATE 1' "$HAND" '5.1 setup: a CONCLUDED row with no verdict exists (written by psql)'
API_REFUSAL="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INC_UNSIGNED/close" \
  "{\"expectedRevision\":$(sqlq "SELECT revision FROM kernel.incidents WHERE incident_id='$INC_UNSIGNED'"),\"note\":\"closing something nobody signed\"}")"
check 409 "$API_REFUSAL" '5.2 the API refuses to close it'
check 'INCIDENT_CLOSE_REQUIRES_VERDICT' "$(code)" '5.3 and names the missing verdict'
DIRECT="$(sql "UPDATE kernel.incidents SET status='CLOSED', closed_at=now(), closed_by='$ADMIN_ID' WHERE incident_id='$INC_UNSIGNED'")"
contains 'no human verdict' "$DIRECT" '5.4 the schema refuses the same closure written by hand'

# ---------------------------------------------------------------------------
step '6 - the signature a closure stands on is write-once (0025)'
# ---------------------------------------------------------------------------
# D2's rule is "a closure stands on a signed verdict". Before 0025 that sentence was a claim about
# the absence of an endpoint: the row could be rewritten or deleted by any SQL. Now the table says
# it. Each hostile statement is run and then the row is re-read, so a refusal that still changed
# something cannot pass.
VERDICT_BEFORE="$(sqlq "SELECT verdict FROM kernel.incident_verdicts WHERE incident_id='$INC'")"
R_VERDICT="$(sql "UPDATE kernel.incident_verdicts SET verdict='INCONCLUSIVE' WHERE incident_id='$INC'")"
contains 'cannot be revised' "$R_VERDICT" '6.1 a signed verdict cannot be revised'
R_WHY="$(sql "UPDATE kernel.incident_verdicts SET rationale='a different reason entirely' WHERE incident_id='$INC'")"
contains 'cannot be revised' "$R_WHY" '6.2 nor can its rationale'
R_WHO="$(sql "UPDATE kernel.incident_verdicts SET decided_by='$OTHER_ID' WHERE incident_id='$INC'")"
contains 'cannot be revised' "$R_WHO" '6.3 nor can the account it is attributed to'
R_GONE="$(sql "DELETE FROM kernel.incident_verdicts WHERE incident_id='$INC'")"
contains 'cannot be deleted' "$R_GONE" '6.4 the signature cannot be deleted out from under the closure'
check "$VERDICT_BEFORE" "$(sqlq "SELECT verdict FROM kernel.incident_verdicts WHERE incident_id='$INC'")" '6.5 the verdict is exactly what was signed'
check '1' "$(sqlq "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id='$INC'")" '6.6 and exactly one row still stands'

# Leave the database as this script found it. The rows are fixtures, not data - and the previous
# version of this cleanup silently did nothing: `$INC` has a signed verdict and
# `incident_verdicts.incident_id` is ON DELETE RESTRICT, so the bare DELETE always failed with a
# foreign-key error which `|| true` swallowed. Every run leaked a CLOSED incident and an orphan,
# and the script still reported success (measured on a real database). The order matters and is
# asserted rather than hoped for: runs cascade their hypotheses and citations, the verdict must go
# before the incident, and the evidence cascades with it.
cleanup_ok=1
sql "DELETE FROM kernel.investigation_runs
      WHERE incident_id IN ('$INC','$INC_UNSIGNED')" > /dev/null 2>&1 || cleanup_ok=0
# 0025 makes a verdict write-once, deletion included. This is test cleanup on a throwaway
# database, so it states that in the transaction it performs it - the same transaction-local
# flag the kernel's own test cleanup uses.
sql "BEGIN; SET LOCAL kernel.allow_verdict_removal='on';
     DELETE FROM kernel.incident_verdicts
      WHERE incident_id IN ('$INC','$INC_UNSIGNED'); COMMIT;" > /dev/null 2>&1 || cleanup_ok=0
sql "DELETE FROM kernel.incidents
      WHERE incident_id IN ('$INC','$INC_UNSIGNED')" > /dev/null 2>&1 || cleanup_ok=0
check '1' "$cleanup_ok" 'Z1 cleanup: every fixture row was removed (a failed delete fails the script)'
if [ "$cleanup_ok" = "1" ]; then
  LEFTOVER="$(sqlq "SELECT count(*) FROM kernel.incidents WHERE incident_id IN ('$INC','$INC_UNSIGNED')")"
  check '0' "$LEFTOVER" 'Z2 cleanup: and they are actually gone, not merely reported deleted'
else
  bad 'Z2 cleanup could not run, so the leak was not verified'
fi

echo
echo "== D2 result: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed assertions:%s\n' "$FAILED_LIST"
  exit 1
fi
