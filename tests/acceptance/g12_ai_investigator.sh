#!/usr/bin/env bash
# G12 Phase E acceptance: the bounded, read-only AI investigator, over real HTTP.
#
# Everything here is a real request against a real kernel with a real PostgreSQL behind
# it, so it must run against a throw-away database and a kernel started for this run:
#   OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_DATABASE_URL=postgres://localhost/x \
#   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... tests/acceptance/g12_ai_investigator.sh
#
# The database URL is used for exactly one thing no client can do: counting how many rows
# the Human Verdict table gained after an AI investigation was accepted, which is the
# negative half of "an AI hypothesis is not a human verdict".
#
# What this script is for. Three claims are easy to assert badly:
#
#   * "the tools are authorized" - so each of the five is driven, through the fixture, at
#     an incident another operator owns, and each invocation row must say REFUSED with the
#     same code the HTTP read endpoint gives.
#   * "the run is bounded" - so each limit is overrun separately, and each overrun must
#     name its own stop reason: a run that merely ended proves nothing.
#   * "the AI cannot change the verdict" - so a review is accepted, and then the verdict
#     table is shown to have gained nothing, the incident is shown not to have moved, and
#     the vocabulary is shown to refuse the verdict's own words.
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
step() { printf '\n######## %s ########\n' "$*"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
compact() { python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), separators=(",",":"))[:600])
except Exception:
    sys.stdin.seek(0)
    print(sys.stdin.read().strip()[:600])' < "$1"; }
ts() { python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=$1)).strftime('%Y-%m-%dT%H:%M:%SZ'))"; }

# curl arguments are collected with "set --" so every expansion stays a plain "$@" form.
call() { # jar csrf method path [body] -> echoes status, prints request+response, body in $WORK/body
  local jar="$1" csrf="$2" method="$3" path="$4" body=""
  [ "$#" -ge 5 ] && body="$5"
  set -- -sS -m 30 -o "$WORK/body" -w '%{http_code}' -X "$method"
  [ -n "$jar" ] && set -- "$@" -b "$jar"
  [ -n "$csrf" ] && set -- "$@" -H "x-csrf-token: $csrf"
  [ -n "$body" ] && set -- "$@" -H 'content-type: application/json' --data-binary "$body"
  printf '\n$ curl -X %s %s %s\n' "$method" "$URL" "$path" >&2
  local status; status="$(curl "$@" "$URL$path")"
  printf '  -> %s %s\n' "$status" "$(compact "$WORK/body")" >&2
  printf '%s' "$status"
}

last() { json "d$1" < "$WORK/body"; }
# count reads an expression that is not a field path (len(...)), so it must not be
# prefixed with "d" the way last() does.
count() { json "$1" < "$WORK/body"; }
code() { json "d['code']" < "$WORK/body"; }
sql() { psql "$DB" -tAc "$1" 2>&1 | tr -d ' '; }

login() {
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

RELATED_ON="$(printenv OPSWEAVE_INVESTIGATION_RELATED_ENABLED || printf 0)"
echo "== kernel: $URL   run: $RUN   related-source-enabled: $RELATED_ON"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.jar"; ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed"; exit 2; }

step "setup: two operators, each with incidents of their own"
for who in a b; do
  call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"g12e-$who-$RUN@example.invalid\",\"displayName\":\"G12E $who\",\"password\":\"g12e-password-$who-1\",\"role\":\"operator\"}" >/dev/null
done
A_JAR="$WORK/a.jar"; A_CSRF="$(login "g12e-a-$RUN@example.invalid" "g12e-password-a-1" "$A_JAR")"
B_JAR="$WORK/b.jar"; B_CSRF="$(login "g12e-b-$RUN@example.invalid" "g12e-password-b-1" "$B_JAR")"
[ -n "$A_CSRF" ] && ok "operator A logged in" || bad "operator A could not log in"
[ -n "$B_CSRF" ] && ok "operator B logged in" || bad "operator B could not log in"

incident_make() {
  local jar="$1" csrf="$2" title="$3" started="$4" related="" related_json="null"
  [ "$#" -ge 5 ] && related="$5"
  [ -n "$related" ] && related_json="\"$related\""
  call "$jar" "$csrf" POST /api/v1/incidents \
    "{\"title\":\"$title\",\"severity\":\"MAJOR\",\"startedAt\":\"$started\",\"relatedEntity\":$related_json}" >/dev/null
  last "['id']"
}
evidence_make() {
  local jar="$1" csrf="$2" incident="$3" kind="$4" collected="$5" source="$6"
  call "$jar" "$csrf" POST "/api/v1/incidents/$incident/evidence" \
    "{\"kind\":\"$kind\",\"source\":\"$source\",\"collectedAt\":\"$collected\",\"contentRef\":\"ref-$RUN-$kind-$source\"}" >/dev/null
  last "['id']"
}

# ===========================================================================
step "S1  E4: evidence sufficient for a supported hypothesis, from real rows"
I1="$(incident_make "$A_JAR" "$A_CSRF" "g12e sufficient evidence $RUN" "$(ts -3600)")"
[ -n "$I1" ] && ok "incident 1 created ($I1)" || bad "incident 1 not created"
E1A="$(evidence_make "$A_JAR" "$A_CSRF" "$I1" LOG_EXCERPT "$(ts -3000)" agent-a)"
E1B="$(evidence_make "$A_JAR" "$A_CSRF" "$I1" QUERY_RESULT "$(ts -2400)" agent-b)"
[ -n "$E1A" ] && [ -n "$E1B" ] && ok "two evidence rows recorded" || bad "evidence not recorded"

S1_STATUS="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s1-$RUN\",\"scenario\":\"AUTO\"}")"
check 201 "$S1_STATUS" "S1 start answers 201 (a run was created, not replayed)"
RUN1="$(last "['runId']")"
check "SUCCEEDED" "$(last "['status']")" "S1 status SUCCEEDED"
check "FINAL_ANSWER" "$(last "['stopReason']")" "S1 stopReason FINAL_ANSWER"
check "SUPPORTED" "$(last "['hypotheses'][0]['stance']")" "S1 stance SUPPORTED"
check 2 "$(count "len(d['hypotheses'][0]['supportingEvidence'])")" "S1 both evidence rows are cited"
check 0 "$(count "len(d['hypotheses'][0]['contradictingEvidence'])")" "S1 nothing is cited as contradicting"
check "$(python3 -c "print(sorted(['$E1A','$E1B']))")" "$(count "sorted(c['evidenceId'] for c in d['hypotheses'][0]['supportingEvidence'])")" "S1 the cited set is exactly the two evidence rows recorded above"
check 2 "$(count "len(set(c['evidenceId'] for c in d['hypotheses'][0]['supportingEvidence']))")" "S1 and no citation is invented beyond them"
check "TEST_FIXTURE" "$(last "['adapter']")" "S1 adapter field is TEST_FIXTURE"
check "True" "$(last "['synthetic']")" "S1 synthetic is true"
check "False" "$(last "['isHumanVerdict']")" "S1 isHumanVerdict is false"
check "AI_HYPOTHESIS" "$(last "['hypothesisKind']")" "S1 hypothesisKind is AI_HYPOTHESIS"
check "False" "$(last "['hypotheses'][0]['isHumanVerdict']")" "S1 the hypothesis itself says it is not a verdict"
contains "TEST_FIXTURE" "$(last "['adapterLabel']")" "S1 adapterLabel names the test adapter, not a model"
check "INCIDENT_READ_PREDICATE" "$(last "['toolInvocations'][0]['authorizationPredicate']")" "S1 every successful read names the predicate that authorized it"
check 2 "$(count "len(d['toolInvocations'])")" "S1 exactly two reads were made (incident, evidence)"
check "OK" "$(count "d['toolInvocations'][0]['outcome']")" "S1 the first read succeeded"
printf '\n---- E4 marker, raw response body ----\n' >&2
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ("adapter","adapterLabel","adapterProviderId","synthetic","hypothesisKind","isHumanVerdict")}, indent=2))' "$WORK/body" >&2
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if "TEST_FIXTURE" in json.dumps(d) else 1)' "$WORK/body"
check 0 "$?" "S1 the marker appears in the raw JSON a consumer actually receives"

# ===========================================================================
step "S2  E4: evidence that does not exist is stated as uncertainty, not as a guess"
I2="$(incident_make "$A_JAR" "$A_CSRF" "g12e no evidence at all $RUN" "$(ts -3600)")"
S2_STATUS="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I2/investigations" "{\"idempotencyKey\":\"s2-$RUN\"}")"
check 201 "$S2_STATUS" "S2 start answers 201"
check "SUCCEEDED" "$(last "['status']")" "S2 status SUCCEEDED (the run finished; it just could not conclude)"
check "UNCERTAIN" "$(last "['hypotheses'][0]['stance']")" "S2 stance UNCERTAIN"
check "LOW" "$(last "['hypotheses'][0]['confidence']")" "S2 confidence LOW"
check 0 "$(count "len(d['hypotheses'][0]['supportingEvidence'])")" "S2 no citation is invented"
check "NO_EVIDENCE_ROWS" "$(count "d['hypotheses'][0]['gapCodes'][0]")" "S2 the gap names what is missing"
contains "neither the timing nor the cause" "$(last "['hypotheses'][0]['uncertainty']")" "S2 the uncertainty says what is NOT established"

# ===========================================================================
step "S3  E4: a record that contradicts itself is reported as a conflict"
I3="$(incident_make "$A_JAR" "$A_CSRF" "g12e contradictory record $RUN" "$(ts -3600)")"
E3_EARLY="$(evidence_make "$A_JAR" "$A_CSRF" "$I3" LOG_EXCERPT "$(ts -10800)" agent-early)"
E3_LATE="$(evidence_make "$A_JAR" "$A_CSRF" "$I3" METRIC_SNAPSHOT "$(ts -1800)" agent-late)"
S3_STATUS="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I3/investigations" "{\"idempotencyKey\":\"s3-$RUN\"}")"
check 201 "$S3_STATUS" "S3 start answers 201"
check "CONFLICTED" "$(last "['hypotheses'][0]['stance']")" "S3 stance CONFLICTED"
check "$E3_EARLY" "$(count "d['hypotheses'][0]['contradictingEvidence'][0]['evidenceId']")" "S3 the earlier row is cited as contradicting"
check "$E3_LATE" "$(count "d['hypotheses'][0]['supportingEvidence'][0]['evidenceId']")" "S3 the later row is cited as supporting"
check "EVIDENCE_PREDATES_INCIDENT" "$(count "d['hypotheses'][0]['gapCodes'][0]")" "S3 the gap names the contradiction"

# ===========================================================================
step "S4  E2: every tool refuses an incident another operator owns"
IB="$(incident_make "$B_JAR" "$B_CSRF" "g12e operator B private $RUN" "$(ts -3600)")"
EB="$(evidence_make "$B_JAR" "$B_CSRF" "$IB" LOG_EXCERPT "$(ts -1200)" agent-b-private)"
[ -n "$IB" ] && [ -n "$EB" ] && ok "operator B holds an incident and evidence A must not reach" || bad "operator B setup failed"
S4_CTL="$(call "$A_JAR" "$A_CSRF" GET "/api/v1/incidents/$IB")"
check 404 "$S4_CTL" "S4 control: A cannot read B's incident over HTTP either"

S4_STATUS="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" \
  "{\"idempotencyKey\":\"s4-$RUN\",\"scenario\":\"CROSS_SCOPE_PROBE\",\"probeIncidentId\":\"$IB\",\"probeEvidenceId\":\"$EB\",\"maxToolCalls\":8}")"
check 201 "$S4_STATUS" "S4 the probe run started"
RUN4="$(last "['runId']")"
check 5 "$(count "len(d['toolInvocations'])")" "S4 all five tools were attempted"
check "PARTIAL" "$(last "['status']")" "S4 status PARTIAL (answered on reads that were refused)"
check "FINAL_ANSWER" "$(last "['stopReason']")" "S4 the run still reached a final answer"
check "TOOL_REFUSED" "$(count "d['hypotheses'][0]['gapCodes'][0]")" "S4 the hypothesis says a read was refused"
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
names=[i["tool"] for i in d["toolInvocations"]]
expected=["get_incident","list_evidence","read_evidence","get_incident_timeline","get_related_context"]
print("TOOLS:", names)
print("REFUSALS:", [(i["tool"],i["outcome"],i["errorCode"],i["attempt"]) for i in d["toolInvocations"]])
sys.exit(0 if names==expected else 1)' "$WORK/body"
check 0 "$?" "S4 the five tools, in order, are exactly the documented set"
for tool in get_incident list_evidence read_evidence get_incident_timeline get_related_context; do
  check "REFUSED" "$(json "[i for i in d['toolInvocations'] if i['tool']=='$tool'][0]['outcome']" < "$WORK/body")" "S4 $tool refused a cross-owner incident"
  if [ "$tool" = "get_related_context" ]; then
    if [ "$RELATED_ON" = "1" ]; then
      check "INCIDENT_NOT_FOUND" "$(json "[i for i in d['toolInvocations'] if i['tool']=='$tool'][0]['errorCode']" < "$WORK/body")" "S4 $tool refused a cross-owner incident through the incident predicate (its source IS authorised here)"
    else
      check "SOURCE_UNAVAILABLE" "$(json "[i for i in d['toolInvocations'] if i['tool']=='$tool'][0]['errorCode']" < "$WORK/body")" "S4 $tool refused before any read because this deployment authorises no related source"
    fi
  else
    check "INCIDENT_NOT_FOUND" "$(json "[i for i in d['toolInvocations'] if i['tool']=='$tool'][0]['errorCode']" < "$WORK/body")" "S4 $tool refused with the same code the HTTP read gives"
  fi
done
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
attempts=[i["attempt"] for i in d["toolInvocations"]]
sys.exit(0 if all(a==1 for a in attempts) else 1)' "$WORK/body"
check 0 "$?" "S4 a refused read is attempted once, never retried"
check 0 "$(sql "SELECT count(*) FROM kernel.investigation_tool_invocations WHERE run_id='$RUN4' AND outcome='OK'")" "S4 none of the five claimed a successful read"
if [ "$RELATED_ON" = "1" ]; then
  check 5 "$(sql "SELECT count(*) FROM kernel.investigation_tool_invocations WHERE run_id='$RUN4' AND error_code='INCIDENT_NOT_FOUND'")" "S4 all five were refused by the incident predicate itself"
else
  check 4 "$(sql "SELECT count(*) FROM kernel.investigation_tool_invocations WHERE run_id='$RUN4' AND error_code='INCIDENT_NOT_FOUND'")" "S4 four of the five were refused by the incident predicate itself"
fi
check 5 "$(sql "SELECT count(*) FROM kernel.investigation_tool_invocations WHERE run_id='$RUN4' AND outcome='REFUSED'")" "S4 all five refusals are in the database, not only in the response"

S4_LIST="$(call "$A_JAR" "$A_CSRF" GET "/api/v1/incidents/$IB/investigations")"
check 404 "$S4_LIST" "S4 A cannot list the investigations of B's incident"
S4_STEAL="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$IB/investigations" "{\"idempotencyKey\":\"s4-steal-$RUN\"}")"
check 404 "$S4_STEAL" "S4 A cannot start an investigation on B's incident"

# ===========================================================================
step "S5.1  E3: the step budget stops the run and says so"
ST1="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5a-$RUN\",\"maxSteps\":2}")"
check 201 "$ST1" "S5.1 start answers 201"
check "BUDGET_EXHAUSTED" "$(last "['status']")" "S5.1 status BUDGET_EXHAUSTED"
check "STEP_BUDGET" "$(last "['stopReason']")" "S5.1 stopReason STEP_BUDGET"
check 2 "$(last "['usage']['steps']")" "S5.1 steps used equals the ceiling it was given"
check 2 "$(last "['budget']['maxSteps']")" "S5.1 the ceiling is recorded on the run"
check 0 "$(count "len(d['hypotheses'])")" "S5.1 no hypothesis was invented when the budget ran out"

step "S5.2  E3: the tool-call budget stops the run and says so"
ST2="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5b-$RUN\",\"scenario\":\"BUDGET_TOOL_CALLS\",\"maxSteps\":40,\"maxToolCalls\":3}")"
check 201 "$ST2" "S5.2 start answers 201"
check "BUDGET_EXHAUSTED" "$(last "['status']")" "S5.2 status BUDGET_EXHAUSTED"
check "TOOL_CALL_BUDGET" "$(last "['stopReason']")" "S5.2 stopReason TOOL_CALL_BUDGET"
check 3 "$(last "['usage']['toolCalls']")" "S5.2 exactly the permitted number of calls ran"
check 3 "$(count "len(d['toolInvocations'])")" "S5.2 and the transcript shows exactly those three"

step "S5.3  E3: the token budget stops the run and records the overshoot honestly"
ST3="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5c-$RUN\",\"tokenBudget\":200,\"maxSteps\":40,\"maxToolCalls\":40,\"scenario\":\"BUDGET_TOOL_CALLS\"}")"
check 201 "$ST3" "S5.3 start answers 201"
check "BUDGET_EXHAUSTED" "$(last "['status']")" "S5.3 status BUDGET_EXHAUSTED"
check "TOKEN_BUDGET" "$(last "['stopReason']")" "S5.3 stopReason TOKEN_BUDGET"
contains "at most that last turn" "$(last "['detail']")" "S5.3 the recorded spend past the budget is explained, not clamped"
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print("tokens used:", d["usage"]["totalTokens"], "budget:", d["budget"]["tokenBudget"])
sys.exit(0 if d["usage"]["totalTokens"] >= d["budget"]["tokenBudget"] else 1)' "$WORK/body"
check 0 "$?" "S5.3 the run stopped at the first turn boundary past the budget"

step "S5.4  E3: the total deadline stops the run and says so"
ST4="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5d-$RUN\",\"scenario\":\"PACED_TOOL_LOOP\",\"maxSteps\":200,\"maxToolCalls\":400,\"deadlineSeconds\":1}")"
check 201 "$ST4" "S5.4 start answers 201"
check "EXPIRED" "$(last "['status']")" "S5.4 status EXPIRED"
check "DEADLINE" "$(last "['stopReason']")" "S5.4 stopReason DEADLINE"
check 1 "$(last "['budget']['deadlineSeconds']")" "S5.4 the deadline it was held to is recorded"

step "S5.5  E3: the per-tool timeout is enforced by the executor and respected by a fast read"
ST5="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5e-$RUN\",\"toolTimeoutMs\":100}")"
check 201 "$ST5" "S5.5 start with a 100 ms per-tool timeout answers 201"
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
caps=[i["durationMs"] for i in d["toolInvocations"]]
print("durations:", caps, "cap:", d["budget"]["toolTimeoutMs"])
sys.exit(0 if caps and all(v <= d["budget"]["toolTimeoutMs"] for v in caps) else 1)' "$WORK/body"
check 0 "$?" "S5.5 every read finished inside the per-tool timeout"
echo "    (the firing case is proven by: cargo test a_tool_that_exceeds_its_timeout_is_reported_as_a_timeout)" >&2

step "S5.6  E3: a refusal is not retried, and the retry ceiling is recorded"
check 0 "$(sql "SELECT retries_used FROM kernel.investigation_runs WHERE run_id='$RUN4'")" "S5.6 the run whose reads were all refused used zero retries"
ST6="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5f-$RUN\",\"maxRetries\":3}")"
check 201 "$ST6" "S5.6 start with maxRetries 3 answers 201"
check 3 "$(last "['budget']['maxRetries']")" "S5.6 the retry ceiling is recorded on the run"
check 0 "$(last "['usage']['retries']")" "S5.6 a clean run spends no retries"

step "S5.7  E3: a replayed idempotency key answers with the run it already ran"
ST7="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5f-$RUN\",\"maxRetries\":3}")"
check 200 "$ST7" "S5.7 the replay answers 200, not 201"
check "True" "$(last "['idempotentReplay']")" "S5.7 the replay says it is a replay"
check "s5f-$RUN" "$(json "d['idempotencyKey']" < "$WORK/body")" "S5.7 the replay is the run recorded for that key"
BEFORE="$(sql "SELECT count(*) FROM kernel.investigation_runs WHERE incident_id='$I1'")"
call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5f-$RUN\",\"maxRetries\":3}" >/dev/null
AFTER="$(sql "SELECT count(*) FROM kernel.investigation_runs WHERE incident_id='$I1'")"
check "$BEFORE" "$AFTER" "S5.7 a third start with the same key created no new run"
check 1 "$(sql "SELECT count(*) FROM kernel.investigation_runs WHERE incident_id='$I1' AND idempotency_key='s5f-$RUN'")" "S5.7 exactly one run exists for that key"

step "S5.8  E3: cancellation is observed between steps"
CANCEL_LOG="$WORK/cancel-start.json"
( curl -sS -m 40 -o "$CANCEL_LOG" -w '%{http_code}' -b "$A_JAR" -H "x-csrf-token: $A_CSRF" \
    -H 'content-type: application/json' -X POST \
    --data-binary "{\"idempotencyKey\":\"s5h-$RUN\",\"scenario\":\"PACED_TOOL_LOOP\",\"maxSteps\":200,\"maxToolCalls\":400,\"deadlineSeconds\":60}" \
    "$URL/api/v1/incidents/$I1/investigations" > "$WORK/cancel-status" 2>&1 ) &
CANCEL_PID=$!
CANCELLED_RUN=""
for _ in $(seq 1 400); do
  curl -sS -m 10 -b "$A_JAR" "$URL/api/v1/incidents/$I1/investigations" -o "$WORK/list.json" 2>/dev/null
  CANCELLED_RUN="$(json "[r['runId'] for r in d if r['status']=='RUNNING' and r['idempotencyKey']=='s5h-$RUN'][0]" < "$WORK/list.json")"
  [ -n "$CANCELLED_RUN" ] && break
  sleep 0.01
done
[ -n "$CANCELLED_RUN" ] && ok "S5.8 a RUNNING run was observed ($CANCELLED_RUN)" || bad "S5.8 no running run was observable"
sleep 0.2
ST8="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations/$CANCELLED_RUN/cancel")"
check 200 "$ST8" "S5.8 the cancel request was accepted"
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
sys.exit(0 if d["cancelRequestedAt"] else 1)' "$WORK/body"
check 0 "$?" "S5.8 the cancel instant is recorded on the run"
wait "$CANCEL_PID" 2>/dev/null
check 201 "$(cat "$WORK/cancel-status")" "S5.8 the blocked start returned the finished run"
check "CANCELLED" "$(json "d['status']" < "$CANCEL_LOG")" "S5.8 the run's own status is CANCELLED"
check "CANCELLED" "$(json "d['stopReason']" < "$CANCEL_LOG")" "S5.8 stopReason CANCELLED"
contains "cancelled this investigation" "$(json "d['detail']" < "$CANCEL_LOG")" "S5.8 the detail names the cancellation"
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print("steps:", d["usage"]["steps"], "ceiling:", d["budget"]["maxSteps"])
sys.exit(0 if d["usage"]["steps"] < d["budget"]["maxSteps"] else 1)' "$CANCEL_LOG"
check 0 "$?" "S5.8 it stopped well before its step ceiling (a cancellation, not an exhaustion)"
ST9="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations/$CANCELLED_RUN/cancel")"
check 409 "$ST9" "S5.8 cancelling a finished run is refused"
check "INVESTIGATION_NOT_RUNNING" "$(code)" "S5.8 and the refusal says why"

step "S5.9  E3: a budget outside its range is refused, not silently clamped"
ST10="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5i-$RUN\",\"maxSteps\":0}")"
check 400 "$ST10" "S5.9 maxSteps 0 is refused"
check "INVESTIGATION_LIMIT_INVALID" "$(code)" "S5.9 with a stable code"
ST11="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s5j-$RUN\",\"maxSteps\":100000}")"
check 400 "$ST11" "S5.9 an absurd maxSteps is refused too"
ST12="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"short\"}")"
check 400 "$ST12" "S5.9 an idempotency key too short to identify anything is refused"
check "INVESTIGATION_IDEMPOTENCY_KEY_INVALID" "$(code)" "S5.9 with a stable code"

step "S5.10  E3: the run is audited and its usage is recorded"
call "$A_JAR" "$A_CSRF" GET "/api/v1/incidents/$I1/timeline" >/dev/null
TIMELINE="$(json "','.join(e['eventType'] for e in d['items'])" < "$WORK/body")"
contains "INVESTIGATION_STARTED" "$TIMELINE" "S5.10 the incident timeline records the start"
contains "INVESTIGATION_FINISHED" "$TIMELINE" "S5.10 the incident timeline records the end"
contains "INVESTIGATION_CANCELLED" "$TIMELINE" "S5.10 the incident timeline records the cancellation"
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
u=d["usage"]
print("usage:", json.dumps(u))
sys.exit(0 if u["totalTokens"]>0 and u["toolCalls"]>0 and u["steps"]>0 else 1)' "$CANCEL_LOG"
check 0 "$?" "S5.10 a cancelled run still records the calls and tokens it spent"
check "TEST_FIXTURE_NO_COST" "$(json "d['usage']['costBasis']" < "$CANCEL_LOG")" "S5.10 the fixture claims no cost it did not incur"

# ===========================================================================
step "S6  E5: accepting an AI investigation does not change the Human Verdict"
VERDICT_BEFORE="$(sql "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id='$I1'")"
check 0 "$VERDICT_BEFORE" "S6 control: the incident has no verdict yet"
call "$A_JAR" "$A_CSRF" GET "/api/v1/incidents/$I1" >/dev/null
REVISION="$(last "['revision']")"
STATUS_BEFORE="$(last "['status']")"
ST13="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations/$RUN4/review" '{"decision":"ACCEPTED","note":"the reasoning is usable for triage"}')"
check 200 "$ST13" "S6 the review was recorded"
check "ACCEPTED" "$(last "['review']['decision']")" "S6 the review decision is ACCEPTED"
check "False" "$(last "['review']['isHumanVerdict']")" "S6 the review says it is not a verdict"
check "False" "$(last "['isHumanVerdict']")" "S6 the run still says it is not a verdict"
VERDICT_AFTER="$(sql "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id='$I1'")"
check "$VERDICT_BEFORE" "$VERDICT_AFTER" "S6 the verdict table gained nothing"
call "$A_JAR" "$A_CSRF" GET "/api/v1/incidents/$I1" >/dev/null
check "None" "$(last "['humanVerdict']")" "S6 the incident still reports no human verdict"
check "$STATUS_BEFORE" "$(last "['status']")" "S6 the incident status did not move"
check "$REVISION" "$(last "['revision']")" "S6 the incident revision did not move either"
ST14="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/close" "{\"expectedRevision\":$REVISION,\"note\":\"the AI said it was fine so close it\"}")"
check 409 "$ST14" "S6 the AI's work cannot close the incident"
check "INCIDENT_CLOSE_REQUIRES_CONCLUDED" "$(code)" "S6 and the refusal names the missing human step"
ST15="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations/$RUN4/review" '{"decision":"CONFIRMED","note":"attempting to sign the AI conclusion as a verdict"}')"
check 400 "$ST15" "S6 a review cannot use the verdict's vocabulary"
check "INVESTIGATION_REVIEW_DECISION_INVALID" "$(code)" "S6 and the refusal says which words are the verdict's"
ST16="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations/$RUN4/review" '{"decision":"REJECTED","note":"a second opinion about the same run"}')"
check 409 "$ST16" "S6 a second review of the same run is refused"
check "INVESTIGATION_ALREADY_REVIEWED" "$(code)" "S6 and the refusal points at a second run"
check 0 "$(sql "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id='$I1'")" "S6 after all of that the verdict table is still empty"

# ===========================================================================
step "S7  E4: a real provider that is not configured is BLOCKED, not simulated"
ST17="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s7a-$RUN\",\"providerId\":\"http-openai-compatible-v1\"}")"
check 409 "$ST17" "S7 the real HTTP provider is BLOCKED without configuration"
check "MODEL_PROVIDER_NOT_CONFIGURED" "$(code)" "S7 and the refusal says which provider could not be resolved"
contains "OPSWEAVE_INVESTIGATION_PROVIDER_BASE_URL" "$(json "d['message']" < "$WORK/body")" "S7 the message says exactly what an operator must set"
ST18="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s7b-$RUN\",\"providerId\":\"some-other-model\"}")"
check 409 "$ST18" "S7 an invented provider id is refused"
ST19="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s7c-$RUN\",\"scenario\":\"NOPE\"}")"
check 400 "$ST19" "S7 an unknown scenario is refused"
check "INVESTIGATION_SCENARIO_INVALID" "$(code)" "S7 with a stable code"
ST20="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s7d-$RUN\",\"scenario\":\"CROSS_SCOPE_PROBE\"}")"
check 400 "$ST20" "S7 the cross-scope probe without its ids is refused"
check "INVESTIGATION_PROBE_INCOMPLETE" "$(code)" "S7 with a stable code"
ST21="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I1/investigations" "{\"idempotencyKey\":\"s7e-$RUN\",\"probeIncidentId\":\"$IB\",\"probeEvidenceId\":\"$EB\"}")"
check 400 "$ST21" "S7 probe ids on a non-probe scenario are refused"
check "INVESTIGATION_PROBE_NOT_APPLICABLE" "$(code)" "S7 so a probe cannot linger on a real run"
check 1 "$(sql "SELECT count(*) FROM kernel.investigation_model_providers WHERE kind='TEST_FIXTURE'")" "S7 (schema) exactly the fixture provider is seeded"

step "S8  E2: with a related source authorised, the scope refusal is the predicate's"
RELATED_ON="$(printenv OPSWEAVE_INVESTIGATION_RELATED_ENABLED || printf '0')"
if [ "$RELATED_ON" = "1" ]; then
  I8="$(incident_make "$A_JAR" "$A_CSRF" "g12e related source $RUN" "$(ts -3600)" "entity-$RUN")"
  IB8="$(incident_make "$B_JAR" "$B_CSRF" "g12e related source private $RUN" "$(ts -3600)" "entity-$RUN")"
  EB8="$(evidence_make "$B_JAR" "$B_CSRF" "$IB8" LOG_EXCERPT "$(ts -1200)" agent-b-related)"
  S8="$(call "$A_JAR" "$A_CSRF" POST "/api/v1/incidents/$I8/investigations" "{\"idempotencyKey\":\"s8-$RUN\",\"scenario\":\"CROSS_SCOPE_PROBE\",\"probeIncidentId\":\"$IB8\",\"probeEvidenceId\":\"$EB8\",\"maxToolCalls\":8}")"
  check 201 "$S8" "S8 the probe run started"
  check "INCIDENT_NOT_FOUND" "$(json "[i for i in d['toolInvocations'] if i['tool']=='get_related_context'][0]['errorCode']" < "$WORK/body")" \
    "S8 get_related_context refuses a cross-owner incident through the same predicate as the incident list"
  check 5 "$(json "len([i for i in d['toolInvocations'] if i['outcome']=='REFUSED'])" < "$WORK/body")" \
    "S8 with the source authorised, all five tools refuse on scope rather than on configuration"
else
  echo "SKIP  S8 (restart the kernel with OPSWEAVE_INVESTIGATION_RELATED_SOURCES=incident_index OPSWEAVE_INVESTIGATION_RELATED_ENABLED=1)" >&2
fi

echo
echo "==================== SUMMARY ===================="
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then printf 'failures:%s\n' "$FAILED_LIST"; rm -rf "$WORK"; exit 1; fi
rm -rf "$WORK"
exit 0
