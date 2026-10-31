#!/usr/bin/env bash
# G12 Phase A acceptance: trusted evidence (A1), the verdict's considered set (A3).
# The browser half of A2 lives in tests/ui/g12-incident-route-identity.spec.ts.
#
# Everything here is a real HTTP call against a real kernel and a real database. The script
# creates its own operator, viewer and second-operator accounts through the admin API, so it
# must run against a throw-away database:
#   OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... \
#   OPSWEAVE_EVIDENCE_ADAPTER=... OPSWEAVE_EVIDENCE_ADAPTER_SECRET=... \
#     tests/acceptance/g12_trusted_evidence.sh
#
# The adapter secret must match the adapter configured in OPSWEAVE_EVIDENCE_ADAPTERS on the
# kernel under test; nothing here reads the kernel's configuration.
set -uo pipefail

URL="${OPSWEAVE_URL:-http://127.0.0.1:18199}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:?set OPSWEAVE_ADMIN_EMAIL}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:?set OPSWEAVE_ADMIN_PASSWORD}"
ADAPTER_ID="${OPSWEAVE_EVIDENCE_ADAPTER:?set OPSWEAVE_EVIDENCE_ADAPTER}"
ADAPTER_SECRET="${OPSWEAVE_EVIDENCE_ADAPTER_SECRET:?set OPSWEAVE_EVIDENCE_ADAPTER_SECRET}"
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

call() { # jar csrf method path [body] -> echoes the status, prints request+response
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

last() { json "d$1" < "$WORK/body"; }

login() {
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' \
    "$URL/api/v1/auth/login" -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  printf '%s' "$body" | json "d['csrfToken']"
}

# The canonical bytes an adapter signs: fixed key order, no whitespace, integer seconds.
attest() { # adapter_id secret incident_id kind source collected_at_iso content_ref issued_epoch
  python3 - "$@" <<'PY'
import base64, hashlib, hmac, json, sys
from datetime import datetime, timezone
adapter_id, secret, incident_id, kind, source, collected_at, content_ref, issued_epoch = sys.argv[1:9]
# UTC-explicit: a naive datetime is read as local time, and the unix second would
# then be off by the host offset - which looks exactly like a forged signature.
collected = datetime.strptime(collected_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
claims = {
  "v": "opsweave-evidence-attestation-v1",
  "adapterId": adapter_id,
  "incidentId": incident_id,
  "kind": kind,
  "source": source,
  "collectedAtUnix": int(collected.timestamp()),
  "contentRef": content_ref,
  "issuedAtUnix": int(issued_epoch),
}
payload = json.dumps(claims, separators=(",", ":")).encode()
digest = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
print(base64.urlsafe_b64encode(digest).decode().rstrip("="))
PY
}

evidence_count() { curl -sS -b "$1" "$URL/api/v1/incidents/$2/evidence" | json "len(d['items'])"; }

echo "== kernel: $URL   run: $RUN   adapter: $ADAPTER_ID"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

ADMIN_JAR="$WORK/admin.cookies"
ADMIN_CSRF="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ADMIN_JAR")"
[ -n "$ADMIN_CSRF" ] || { echo "admin login failed"; exit 2; }

OPERATOR_EMAIL="g12-operator-$RUN@example.invalid"
VIEWER_EMAIL="g12-viewer-$RUN@example.invalid"
for spec in "operator:$OPERATOR_EMAIL:g12-operator-password-1" "viewer:$VIEWER_EMAIL:g12-viewer-password-1"; do
  role="${spec%%:*}"; rest="${spec#*:}"; email="${rest%%:*}"; password="${rest#*:}"
  call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
    "{\"email\":\"$email\",\"displayName\":\"g12 $role\",\"password\":\"$password\",\"role\":\"$role\"}" > /dev/null
done

OP_JAR="$WORK/operator.cookies"; OP_CSRF="$(login "$OPERATOR_EMAIL" g12-operator-password-1 "$OP_JAR")"
VW_JAR="$WORK/viewer.cookies"; VW_CSRF="$(login "$VIEWER_EMAIL" g12-viewer-password-1 "$VW_JAR")"
OP2_EMAIL="g12-operator2-$RUN@example.invalid"
call "$ADMIN_JAR" "$ADMIN_CSRF" POST /api/v1/users \
  "{\"email\":\"$OP2_EMAIL\",\"displayName\":\"g12 operator2\",\"password\":\"g12-operator2-password-1\",\"role\":\"operator\"}" > /dev/null
OP2_JAR="$WORK/operator2.cookies"; login "$OP2_EMAIL" g12-operator2-password-1 "$OP2_JAR" > /dev/null

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST /api/v1/incidents \
  "{\"title\":\"g12 trusted evidence $RUN\",\"severity\":\"MAJOR\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"relatedEntity\":\"host:g12-node\"}")"
check 201 "$STATUS" "operator creates an incident"
INC="$(last "['id']")"
echo "   incident: $INC"

# One clock read, so the ISO second and the signed unix second cannot disagree
# across a boundary.
NOW_EPOCH="$(date +%s)"
NOW="$(python3 -c "import datetime;print(datetime.datetime.fromtimestamp($NOW_EPOCH, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")"

echo
echo '######## A1 - the body field that granted attestation is gone ########'

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:forged-body-$RUN\",\"trust\":\"SOURCE_ATTESTED\"}")"
check 400 "$STATUS" "N1 body trust=SOURCE_ATTESTED is refused"
check "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE" "$(last "['code']")" "N1 refusal code"

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:forged-body2-$RUN\",\"trust\":\"UNVERIFIED\"}")"
check 400 "$STATUS" "N1b body trust is refused even when its value is the harmless one"

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:claim-$RUN\",\"claimedTrust\":\"SOURCE_ATTESTED\"}")"
check 400 "$STATUS" "N2 claimedTrust=SOURCE_ATTESTED is refused"
check "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE" "$(last "['code']")" "N2 refusal code"

SIG="$(attest "$ADAPTER_ID" "not-the-secret" "$INC" METRIC_SNAPSHOT prometheus "$NOW" "sha256:forged-sig-$RUN" "$NOW_EPOCH")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:forged-sig-$RUN\",\"attestation\":{\"adapterId\":\"$ADAPTER_ID\",\"issuedAt\":\"$NOW\",\"signature\":\"$SIG\"}}")"
check 401 "$STATUS" "N3 a signature made with the wrong secret is refused"
check "EVIDENCE_ATTESTATION_INVALID" "$(last "['code']")" "N3 refusal code"

SIG="$(attest "$ADAPTER_ID" "$ADAPTER_SECRET" "$INC" METRIC_SNAPSHOT prometheus "$NOW" "sha256:unknown-adapter-$RUN" "$NOW_EPOCH")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:unknown-adapter-$RUN\",\"attestation\":{\"adapterId\":\"zabbix-impostor\",\"issuedAt\":\"$NOW\",\"signature\":\"$SIG\"}}")"
check 401 "$STATUS" "N4 an adapter the kernel does not know is refused"
check "EVIDENCE_ADAPTER_UNKNOWN" "$(last "['code']")" "N4 refusal code"

STALE_EPOCH="$((NOW_EPOCH - 1800))"
STALE="$(python3 -c "import sys,datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=1800)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
SIG="$(attest "$ADAPTER_ID" "$ADAPTER_SECRET" "$INC" METRIC_SNAPSHOT prometheus "$NOW" "sha256:stale-$RUN" "$STALE_EPOCH")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:stale-$RUN\",\"attestation\":{\"adapterId\":\"$ADAPTER_ID\",\"issuedAt\":\"$STALE\",\"signature\":\"$SIG\"}}")"
check 401 "$STATUS" "N5 a genuine signature replayed 30 minutes later is refused"
check "EVIDENCE_ATTESTATION_STALE" "$(last "['code']")" "N5 refusal code"

SIG="$(attest "$ADAPTER_ID" "$ADAPTER_SECRET" "$INC" METRIC_SNAPSHOT prometheus "$NOW" "sha256:original-$RUN" "$NOW_EPOCH")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"prometheus\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:moved-$RUN\",\"attestation\":{\"adapterId\":\"$ADAPTER_ID\",\"issuedAt\":\"$NOW\",\"signature\":\"$SIG\"}}")"
check 401 "$STATUS" "N6 a genuine signature moved onto a different contentRef is refused"

check 0 "$(evidence_count "$OP_JAR" "$INC")" "N7 not one of the six refusals left a row behind"

STATUS="$(call "$VW_JAR" "$VW_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"OPERATOR_NOTE\",\"source\":\"operator:viewer\",\"collectedAt\":\"$NOW\",\"contentRef\":\"note:viewer-$RUN\"}")"
check 403 "$STATUS" "N8 a viewer cannot append evidence at all"
check "FORBIDDEN" "$(last "['code']")" "N8 refusal code"

echo
echo '######## A1 - what each role actually gets ########'

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"OPERATOR_NOTE\",\"source\":\"operator:g12\",\"collectedAt\":\"$NOW\",\"contentRef\":\"note:operator-$RUN\"}")"
check 201 "$STATUS" "P1 an operator appends a row"
check "OPERATOR_ASSERTED" "$(last "['verifiedTrust']")" "P1 verifiedTrust for an operator row"
check "OPERATOR_ASSERTED" "$(last "['claimedTrust']")" "P1 claimedTrust default"
check "OPERATOR_IDENTITY" "$(last "['verificationMethod']")" "P1 verification method"
check "None" "$(last "['verifierIdentity']")" "P1 no adapter identity is claimed"

STATUS="$(call "$ADMIN_JAR" "$ADMIN_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"OPERATOR_NOTE\",\"source\":\"operator:admin\",\"collectedAt\":\"$NOW\",\"contentRef\":\"note:admin-$RUN\",\"claimedTrust\":\"UNVERIFIED\"}")"
check 201 "$STATUS" "P2 an admin appends a row with an explicit claim"
check "UNVERIFIED" "$(last "['verifiedTrust']")" "P2 the claim is not upgraded"
check "NONE" "$(last "['verificationMethod']")" "P2 nothing was verified"

SIG="$(attest "$ADAPTER_ID" "$ADAPTER_SECRET" "$INC" METRIC_SNAPSHOT "zabbix:$ADAPTER_ID" "$NOW" "sha256:attested-$RUN" "$NOW_EPOCH")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"zabbix:$ADAPTER_ID\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:attested-$RUN\",\"attestation\":{\"adapterId\":\"$ADAPTER_ID\",\"issuedAt\":\"$NOW\",\"signature\":\"$SIG\"}}")"
check 201 "$STATUS" "P3 a correctly signed attestation is accepted"
check "SOURCE_ATTESTED" "$(last "['verifiedTrust']")" "P3 verifiedTrust is attested"
check "SOURCE_ADAPTER" "$(last "['verificationMethod']")" "P3 verification method"
check "$ADAPTER_ID" "$(last "['verifierIdentity']")" "P3 the adapter identity is recorded"

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"METRIC_SNAPSHOT\",\"source\":\"zabbix:$ADAPTER_ID\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:attested-$RUN\",\"attestation\":{\"adapterId\":\"$ADAPTER_ID\",\"issuedAt\":\"$NOW\",\"signature\":\"$SIG\"}}")"
check 200 "$STATUS" "P4 replaying the attested tuple is an idempotent 200"
check "SOURCE_ADAPTER" "$(last "['verificationMethod']")" "P4 the replay answers with the stored row"

# A *valid* attestation, correctly signed over the already-settled tuple. The
# signature verifies (so this is not P3's refusal path) and the insert still
# hits the natural key, so the stored row comes back untouched.
SIG="$(attest "$ADAPTER_ID" "$ADAPTER_SECRET" "$INC" OPERATOR_NOTE "operator:g12" "$NOW" "note:operator-$RUN" "$NOW_EPOCH")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"OPERATOR_NOTE\",\"source\":\"operator:g12\",\"collectedAt\":\"$NOW\",\"contentRef\":\"note:operator-$RUN\",\"attestation\":{\"adapterId\":\"$ADAPTER_ID\",\"issuedAt\":\"$NOW\",\"signature\":\"$SIG\"}}")"
check 200 "$STATUS" "P5 a valid attestation replayed onto a settled tuple is an idempotent 200"
check "OPERATOR_ASSERTED" "$(last "['verifiedTrust']")" "P5 a replay cannot upgrade the settled row to attested"
check "OPERATOR_IDENTITY" "$(last "['verificationMethod']")" "P5 the settled row keeps its verification"
check "None" "$(last "['verifierIdentity']")" "P5 no adapter identity is claimed for a row no adapter vouched for"

echo
echo '######## A3 - what the verdict considered, and what came after ########'

CONSIDERED="$(evidence_count "$OP_JAR" "$INC")"
STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/verdict" \
  "{\"verdict\":\"CONFIRMED\",\"rationale\":\"g12 acceptance run $RUN: the attested metric window matches the reported failure\"}")"
check 201 "$STATUS" "P6 an operator records a verdict"
check "$CONSIDERED" "$(last "['consideredEvidenceCount']")" "P6 the considered count is the set that existed at signing"
check "RECORDED" "$(last "['snapshotKind']")" "P6 the considered set is a record"
DIGEST="$(last "['consideredEvidenceDigest']")"
if [ "${#DIGEST}" -eq 64 ] && [ -z "$(printf '%s' "$DIGEST" | tr -d '0-9a-f')" ]; then
  ok "P6 the digest is a 64-character lowercase hex sha256"
else
  bad "P6 digest is not 64 hex characters: $DIGEST"
fi

STATUS="$(call "$OP_JAR" "$OP_CSRF" POST "/api/v1/incidents/$INC/evidence" \
  "{\"kind\":\"LOG_EXCERPT\",\"source\":\"syslog\",\"collectedAt\":\"$NOW\",\"contentRef\":\"sha256:after-signing-$RUN\"}")"
check 201 "$STATUS" "P7 CONCLUDED still accepts evidence (the capability is kept)"

STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/evidence")"
check 200 "$STATUS" "P8 the evidence list is readable after the verdict"
check 1 "$(json "[r['afterVerdict'] for r in d['items']].count(True)" < "$WORK/body")" "P8 exactly one row is flagged afterVerdict"
check "sha256:after-signing-$RUN" "$(json "[r['contentRef'] for r in d['items'] if r['afterVerdict']][0]" < "$WORK/body")" "P8 the flagged row is the one appended after signing"

STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC/verdict")"
check "$CONSIDERED" "$(last "['consideredEvidenceCount']")" "P9 the signed count did not move when evidence was appended"
check "$DIGEST" "$(last "['consideredEvidenceDigest']")" "P9 the signed digest did not move either"

STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/$INC")"
check "$CONSIDERED" "$(last "['humanVerdict']['consideredEvidenceCount']")" "P10 the incident projection carries the same count"
check "$((CONSIDERED + 1))" "$(json "len(d['evidenceRefs'])" < "$WORK/body")" "P10 evidenceRefs lists every row, signed or not"

echo
echo '######## A2 - the server side of "this is not your record" ########'

STATUS="$(call "$OP2_JAR" "" GET "/api/v1/incidents/$INC")"
check 404 "$STATUS" "N9 another operator cannot read the incident"
check "INCIDENT_NOT_FOUND" "$(last "['code']")" "N9 refusal code"
STATUS="$(call "$OP2_JAR" "" GET "/api/v1/incidents/$INC/evidence")"
check 404 "$STATUS" "N9b another operator cannot read its evidence"
STATUS="$(call "$OP2_JAR" "" GET "/api/v1/incidents/$INC/verdict")"
check 404 "$STATUS" "N9c another operator cannot read its verdict"
STATUS="$(call "$OP_JAR" "" GET "/api/v1/incidents/00000000-0000-4000-8000-000000000000")"
check 404 "$STATUS" "N10 an unknown incident id is a 404"

echo
echo "== $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then printf 'FAILED: %s\n' "${FAILED[@]}"; exit 1; fi
rm -rf "$WORK"
