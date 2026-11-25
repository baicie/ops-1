#!/usr/bin/env bash
# Phase 8A TASK-26: one sanitization boundary, and the proof that no field escapes it.
#
# The defect: the collector redacted `log.excerpt` and `lastPassingAssertion` and
# copied `classification.evidence[].line` verbatim from a classifier that had been
# handed the RAW log. The same physical line appeared twice in one artifact, once
# redacted and once live.
#
# Every case here reads a committed fixture. NOTHING touches the network - that rule
# was added after PR #218's self-test went red on CI for calling the live API.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

LIB=tests/ci/lib/evidence-sanitize.mjs
TOOL=tests/ci/collect-failure-evidence.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Sentinels are invented values. A real token must never be committed to drive a test.
GH_SENT='ghp_SENTINELabcdefghijklmnopqrstuv'
JWT_SENT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
AWS_SENT='AKIAIOSFODNN7EXAMPLE'
DB_SENT='hunter2hunter2'
JSON_SENT='abcdef123456789'

# A fixture whose failing line IS the classifier's evidence and carries every shape.
# This is the shape that leaked: the same line, redacted in one field and not another.
python3 - "$GH_SENT" "$JWT_SENT" "$AWS_SENT" "$DB_SENT" "$JSON_SENT" <<'PY'
import json, sys
gh, jwt, aws, db, js = sys.argv[1:6]
log = "\n".join([
  "full\tSuite\t2026-11-25T00:00:00Z   ok   the deployment activated",
  f"full\tSuite\t2026-11-25T00:00:01Z [FATAL] transfer failed for https://{gh}@maven.example/x, status: 429",
  f"full\tSuite\t2026-11-25T00:00:02Z Authorization: Bearer {gh}",
  f"full\tSuite\t2026-11-25T00:00:03Z POSTGRES_URL=postgres://u:{db}@db:5432/x",
  f"full\tSuite\t2026-11-25T00:00:04Z {{\"client_secret\": \"{js}\"}}",
  f"full\tSuite\t2026-11-25T00:00:05Z token {jwt}",
  f"full\tSuite\t2026-11-25T00:00:06Z {aws}",
  "full\tSuite\t2026-11-25T00:00:07Z   FAIL the earlier 429 did not recover",
  # The last-passing-assertion trap: a PASS with a secret in it.
  f"full\tSuite\t2026-11-25T00:00:07Z   ok   the fixture token {gh} was accepted",
])
json.dump({
  "run": {"id": 1, "run_attempt": 1, "name": "x", "event": "push", "head_sha": "a"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "2026-11-25T00:00:00Z", "run_started_at": "2026-11-25T00:00:00Z",
          "updated_at": "2026-11-25T00:01:00Z", "html_url": "https://example.invalid/1",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 7, "name": "full", "conclusion": "failure",
    "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:01:00Z",
    "runner_name": "r", "runner_group_name": "g",
    "steps": [{"name": "Suite", "number": 3, "conclusion": "failure",
               "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:01:00Z"}]}]},
  "log": log,
}, open(sys.argv[0].replace("PY", "") and "/dev/stdout", "w") if False else open(__import__("os").environ.get("FIXTURE_OUT", "/tmp/none"), "w"))
PY

FIX="$WORK/fixture.json"
FIXTURE_OUT="$FIX" python3 - "$GH_SENT" "$JWT_SENT" "$AWS_SENT" "$DB_SENT" "$JSON_SENT" <<'PY'
import json, os, sys
gh, jwt, aws, db, js = sys.argv[1:6]
log = "\n".join([
  "full\tSuite\t2026-11-25T00:00:00Z   ok   the deployment activated",
  f"full\tSuite\t2026-11-25T00:00:01Z [FATAL] transfer failed for https://{gh}@maven.example/x, status: 429",
  f"full\tSuite\t2026-11-25T00:00:02Z Authorization: Bearer {gh}",
  f"full\tSuite\t2026-11-25T00:00:03Z POSTGRES_URL=postgres://u:{db}@db:5432/x",
  f"full\tSuite\t2026-11-25T00:00:04Z {{\"client_secret\": \"{js}\"}}",
  f"full\tSuite\t2026-11-25T00:00:05Z token {jwt}",
  f"full\tSuite\t2026-11-25T00:00:06Z {aws}",
  # A PASS whose text carries a secret: this is what lastPassingAssertion copies.
  f"full\tSuite\t2026-11-25T00:00:07Z   ok   the fixture token {gh} was accepted",
  "full\tSuite\t2026-11-25T00:00:08Z   FAIL the earlier 429 did not recover",
])
json.dump({
  "run": {"id": 1, "run_attempt": 1, "name": "x", "event": "push", "head_sha": "a"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "2026-11-25T00:00:00Z", "run_started_at": "2026-11-25T00:00:00Z",
          "updated_at": "2026-11-25T00:01:00Z", "html_url": "https://example.invalid/1",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 7, "name": "full", "conclusion": "failure",
    "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:01:00Z",
    "runner_name": "r", "runner_group_name": "g",
    "steps": [{"name": "Suite", "number": 3, "conclusion": "failure",
               "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:01:00Z"}]}]},
  "log": log,
}, open(os.environ["FIXTURE_OUT"], "w"), indent=2)
PY

# Produce every output surface the brief names, once.
node "$TOOL" --from-json "$FIX" --json   > "$WORK/out.json"  2>"$WORK/err.json"
node "$TOOL" --from-json "$FIX"          > "$WORK/out.txt"   2>"$WORK/err.txt"
node "$TOOL" --from-json "$FIX" --out "$WORK/artifact.json" >/dev/null 2>&1
SENTINELS=("$GH_SENT" "$JWT_SENT" "$AWS_SENT" "$DB_SENT" "$JSON_SENT")

echo "== 1. a secret on the line the classifier quotes does not reach the artifact"
# The exact V1 leak: `classification.evidence[].line` was copied verbatim from a
# classifier that had read the raw log.
evidence="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
out=[]
for j in d["failedJobs"]:
    for f in j["classification"].get("findings",[]):
        for e in f.get("evidence",[]): out.append(e.get("line",""))
print("\n".join(out))
' "$WORK/out.json")"
leaked=0
for s in "${SENTINELS[@]}"; do printf '%s' "$evidence" | grep -qF "$s" && leaked=1; done
[ "$leaked" -eq 0 ] && ok "classification evidence carries no sentinel" || bad "classification evidence leaked a sentinel"
printf '%s' "$evidence" | grep -q '<redacted-gh-token>' \
  && ok "and it is redacted rather than dropped (the evidence is still readable)" \
  || bad "the evidence line was dropped entirely instead of redacted"

echo "== 2. a secret in the last passing assertion does not reach the artifact"
lp="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print("\n".join((st.get("lastPassingAssertion") or "") for j in d["failedJobs"] for st in j["failedSteps"]))
' "$WORK/out.json")"
leaked=0
for s in "${SENTINELS[@]}"; do printf '%s' "$lp" | grep -qF "$s" && leaked=1; done
[ "$leaked" -eq 0 ] && ok "lastPassingAssertion carries no sentinel" || bad "lastPassingAssertion leaked a sentinel"

echo "== 3. a secret in JSON metadata does not reach the artifact"
# The run/workflow/branch fields come from the API, which is not this repo's log.
python3 - "$WORK/fixture4.json" "$GH_SENT" <<'PY'
import json, sys
d = json.load(open("tests/ci/fixtures/classify/A-recovered-429-then-assertion.json"))
d["run"]["head_branch"] = f"fix/leak-{sys.argv[2]}"
d["run"]["name"] = f"CI for {sys.argv[2]}"
json.dump(d, open(sys.argv[1], "w"))
PY
node "$TOOL" --from-json "$WORK/fixture4.json" --json > "$WORK/meta.json" 2>/dev/null
grep -qF "$GH_SENT" "$WORK/meta.json" && bad "metadata leaked the sentinel" || ok "metadata fields are redacted too"

echo "== 4. the UNKNOWN path is sanitized the same way"
python3 - "$WORK/fixture5.json" "$GH_SENT" <<'PY'
import json, sys
gh = sys.argv[2]
json.dump({
  "run": {"id": 5, "run_attempt": 1, "name": "x", "event": "push", "head_sha": "a"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "2026-11-25T00:00:00Z", "run_started_at": "2026-11-25T00:00:00Z",
          "updated_at": "2026-11-25T00:01:00Z", "html_url": "https://example.invalid/5",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 55, "name": "full", "conclusion": "failure",
    "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:01:00Z",
    "runner_name": "r", "runner_group_name": "g",
    "steps": [{"name": "Suite", "number": 1, "conclusion": "failure",
               "started_at": "2026-11-25T00:00:00Z", "completed_at": "2026-11-25T00:01:00Z"}]}]},
  # No recognisable signature at all - the classifier will say UNKNOWN - and the
  # secret rides along in the same text a reader will be shown.
  "log": f"full\tSuite\t2026-11-25T00:00:00Z something odd happened near {gh}\n",
}, open(sys.argv[1], "w"), indent=2)
PY
node "$TOOL" --from-json "$WORK/fixture5.json" --json > "$WORK/unknown.json" 2>/dev/null
v="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["failedJobs"][0]["classification"]["verdict"])' "$WORK/unknown.json")"
[ "$v" = "UNKNOWN" ] && ok "the fixture really takes the UNKNOWN path" || bad "the fixture did not reach UNKNOWN (got $v)"
grep -qF "$GH_SENT" "$WORK/unknown.json" && bad "the UNKNOWN path leaked the sentinel" || ok "the UNKNOWN path is sanitized"

echo "== 5. JSON and human-readable output agree"
for f in "$WORK/out.json" "$WORK/out.txt" "$WORK/err.txt"; do
  leaked=0
  for s in "${SENTINELS[@]}"; do grep -qF "$s" "$f" && leaked=1; done
  [ "$leaked" -eq 0 ] && ok "$(basename "$f") is clean" || bad "$(basename "$f") leaked"
done

echo "== 6. the whole serialised artifact passes a sentinel sweep"
# Not a field check: the ENTIRE file, which is the only check that covers a field
# nobody has written yet.
leaked=0
for s in "${SENTINELS[@]}"; do grep -qF "$s" "$WORK/artifact.json" && { leaked=1; printf '       survived: %s\n' "${s:0:20}"; }; done
[ "$leaked" -eq 0 ] && ok "no sentinel survives anywhere in the written artifact" || bad "the artifact leaked a sentinel"

echo "== 7. a caller-held secret is redacted even when it matches no shape"
# A short password that no shape rule would catch. The boundary accepts known values.
printf 'the password is swordfishxyz and nothing else\n' > "$WORK/plain.txt"
out="$(OPSWEAVE_EVIDENCE_SENTINELS=swordfishxyz node "$TOOL" --redact-only < "$WORK/plain.txt")"
printf '%s' "$out" | grep -q 'swordfishxyz' && bad "a supplied known secret survived" || ok "a supplied known secret is redacted"
node -e '
const { sanitizeText } = await import("./tests/ci/lib/evidence-sanitize.mjs");
const out = sanitizeText("the password is swordfishxyz", { extraSecrets: ["swordfishxyz"] });
process.stdout.write(out.includes("swordfishxyz") ? "LEAK" : "clean");
' --input-type=module > "$WORK/extra.txt" 2>/dev/null
[ "$(cat "$WORK/extra.txt")" = "clean" ] && ok "extraSecrets works as a function, not only a flag" || bad "extraSecrets did not apply"

echo "== 8. ordinary log text survives, and the classification still works"
# A sanitizer that mangles text is a sanitizer that changes what the classifier sees.
node "$TOOL" --from-json tests/ci/fixtures/classify/G-real-capacity-refusal.json --json > "$WORK/g.json" 2>/dev/null
v="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["failedJobs"][0]["classification"]["verdict"])' "$WORK/g.json")"
[ "$v" = "STAGING_ENVIRONMENT" ] && ok "redaction did not change the verdict (still STAGING_ENVIRONMENT)" || bad "redaction changed the verdict to $v"
grep -q 'INSTANCE_CAPACITY_EXCEEDED' "$WORK/g.json" && ok "the non-secret part of the line is preserved" || bad "the line was over-redacted"

echo "== 9. a child-process failure does not pipe unredacted output through"
# The classifier is a child. If it dies, its stdout is not trusted and not copied.
node -e '
const fs = require("fs");
const p = "tests/ci/classify-failure.mjs";
fs.writeFileSync("/tmp/classify-failure.bak", fs.readFileSync(p));
fs.writeFileSync(p, "process.stdout.write(\"ghp_CRASHEDabcdefghijklmnopqrstu\"); process.exit(9);\n");
' 2>/dev/null
out="$(node "$TOOL" --from-json "$WORK/unknown.json" --json 2>/dev/null || true)"
leaked=0
for s in ghp_CRASHEDabcdefghijklmnopqrstu; do printf '%s' "$out" | grep -qF "$s" && leaked=1; done
node -e 'const fs=require("fs");fs.writeFileSync("tests/ci/classify-failure.mjs", fs.readFileSync("/tmp/classify-failure.bak"));'
[ "$leaked" -eq 0 ] && ok "a crashed classifier's output is not passed through" || bad "a crashed classifier's stdout reached the artifact"
# Restoring the file is checked by CONTENT, not by `git diff`: this test rewrites a
# file the branch may have modified, and comparing to the index would call a
# modified-but-restored file dirty.
cmp -s tests/ci/classify-failure.mjs /tmp/classify-failure.bak \
  && ok "the classifier was restored byte-for-byte" \
  || bad "the test left classify-failure.mjs modified"

echo "== 10. THE SELF-TEST NEEDS NO NETWORK"
grep -qE -- '--run [0-9]{6,}' "$0" && bad "this self-test still calls the live API" || ok "no live run id appears in this file"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
