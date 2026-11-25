#!/usr/bin/env bash
# Phase 8A TASK-27: the classifier's ATTRIBUTION, driven from ten committed fixtures.
#
# Each fixture is a counterexample the brief names. For each, this asserts the
# verdict V1 got WRONG - the point is not that the new code returns something, it is
# that it stops returning the confident wrong answer.
#
# V1's failures, all reproduced before the rewrite:
#   A  a recovered 429 became the root cause of a later assertion failure
#   B  a 429 in a SUCCEEDED job explained a crash in another job
#   C  a PASSING assertion containing the word INSTANCE_CAPACITY_EXCEEDED was
#      classified STAGING_ENVIRONMENT and quoted as evidence
#   D  two matrix rows failing differently produced one category
# all four because `isFailureLine` was a CHARACTER CLASS (`[\[FATAL\]|...]`) that
# matched every string, and because rule order across the whole log decided the cause.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/classify-failure.mjs
FIX=tests/ci/fixtures/classify
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# findings <fixture> -> one line per finding: "category|ruleId|step"
# Written as a script file rather than an inline -c: the quoting of nested f-string
# quotes inside a shell single-quoted argument is a trap that silently produced an
# empty result and made four assertions fail for the wrong reason.
cat > "$WORK/findings.py" <<'PYEOF'
import json, sys
d = json.load(sys.stdin)
for f in d["findings"]:
    s = f.get("scope") or {}
    step = s.get("step") if isinstance(s, dict) else None
    sys.stdout.write("%s|%s|%s\n" % (f["category"], f.get("ruleId"), step))
PYEOF
findings() { node "$TOOL" --from-json "$FIX/$1" --json 2>/dev/null | python3 "$WORK/findings.py"; }
count() { findings "$1" | grep -c . ; }

echo "== A. a 429 that RECOVERED is not the cause of a later assertion failure"
got="$(findings A-recovered-429-then-assertion.json)"
printf '%s\n' "$got" | grep -q '^PRODUCT_REGRESSION|failed-assertion|Workspace isolation$' \
  && ok "the assertion failure in the isolation step is the finding" \
  || bad "the assertion failure was not attributed (got: $got)"
printf '%s\n' "$got" | grep -q 'EXTERNAL_DEPENDENCY' \
  && bad "the recovered 429 was still reported as a cause" \
  || ok "the recovered 429 is context, not a cause"
node "$TOOL" --from-json "$FIX/A-recovered-429-then-assertion.json" --json 2>/dev/null > "$WORK/a.json"
cat > "$WORK/check_a.py" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
steps = [f["scope"]["step"] for f in d["findings"]]
assert "Build" not in steps, steps
PYEOF
python3 "$WORK/check_a.py" "$WORK/a.json" 2>/dev/null \
  && ok "the step that recovered is NOT a failed step of its own" \
  || bad "the recovered step was reported as a failure"

echo "== B. a 429 in a job the API calls SUCCEEDED cannot explain another job's crash"
got="$(findings B-429-in-a-successful-job.json)"
[ "$(printf '%s\n' "$got" | grep -c 'EXTERNAL_DEPENDENCY')" -eq 0 ] \
  && ok "no external verdict from the succeeded job's noise" \
  || bad "a succeeded job's 429 was attributed as a cause (got: $got)"
printf '%s\n' "$got" | grep -q 'PRODUCT_REGRESSION|process-crash|Runtime tests' \
  && ok "the job that actually failed is the one that is explained" \
  || bad "the failing job's crash was not attributed (got: $got)"

echo "== C. the capacity word inside a PASSING assertion is not a capacity refusal"
got="$(findings C-capacity-word-in-a-passing-assertion.json)"
printf '%s\n' "$got" | grep -q 'STAGING_ENVIRONMENT' \
  && bad "a passing assertion's TEXT was classified as the environment's fault" \
  || ok "the passing assertion is not a capacity refusal"
printf '%s\n' "$got" | grep -q '^PRODUCT_REGRESSION|failed-assertion' \
  && ok "the failing assertion is attributed as an assertion" \
  || bad "the failing assertion was not attributed (got: $got)"

echo "== D. two matrix rows failing differently stay two findings"
n="$(count D-matrix-with-two-different-failures.json)"
[ "$n" -eq 2 ] && ok "exactly two findings, not one" || bad "expected 2 findings, got $n"
got="$(findings D-matrix-with-two-different-failures.json)"
printf '%s\n' "$got" | grep -q '^EXTERNAL_DEPENDENCY|registry-rate-limit|Go plugin$' \
  && ok "the go row keeps its external cause" || bad "the go row lost its cause (got: $got)"
printf '%s\n' "$got" | grep -q '^PRODUCT_REGRESSION|failed-assertion|Java plugin$' \
  && ok "the java row keeps its own, different cause" || bad "the java row was folded into the go one (got: $got)"

echo "== E. a cleanup failure beside the primary failure is a SECOND finding"
got="$(findings E-cleanup-failure-beside-primary-failure.json)"
printf '%s\n' "$got" | grep -q '^PRODUCT_REGRESSION' && printf '%s\n' "$got" | grep -q '^RUNNER_INFRASTRUCTURE' \
  && ok "both the primary failure and the cleanup fault are reported" \
  || bad "one of the two was lost (got: $got)"
node "$TOOL" --from-json "$FIX/E-cleanup-failure-beside-primary-failure.json" --json 2>/dev/null > "$WORK/e.json"
cat > "$WORK/check_e.py" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
prim = [f for f in d["findings"] if f["category"] == "PRODUCT_REGRESSION"][0]
assert prim["scope"]["step"] == "Heartbeat bounds", prim["scope"]
clean = [f for f in d["findings"] if f["category"] == "RUNNER_INFRASTRUCTURE"][0]
assert clean["scope"]["step"] == "Cleanup", clean["scope"]
PYEOF
python3 "$WORK/check_e.py" "$WORK/e.json" 2>/dev/null \
  && ok "each finding is scoped to the step it happened in" \
  || bad "a finding's scope is wrong"

echo "== F. a real registry failure stays classified as external"
got="$(findings F-real-maven-download-failure.json)"
printf '%s\n' "$got" | grep -q '^EXTERNAL_DEPENDENCY' \
  && ok "a genuine unresolvable artifact is still EXTERNAL_DEPENDENCY" \
  || bad "the genuine external failure was reclassified (got: $got)"
[ "$(count F-real-maven-download-failure.json)" -eq 1 ] \
  && ok "and it is ONE finding, not one per matching rule" \
  || bad "one cause was reported as $(count F-real-maven-download-failure.json) findings"
node "$TOOL" --from-json "$FIX/F-real-maven-download-failure.json" --json 2>/dev/null > "$WORK/f.json"
cat > "$WORK/check_f.py" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d["findings"]) == 1, d["findings"]
assert len(d["findings"][0]["alsoMatched"]) == 1, d["findings"][0]["alsoMatched"]
PYEOF
python3 "$WORK/check_f.py" "$WORK/f.json" 2>/dev/null \
  && ok "the second matching rule is recorded on the finding instead of dropped" \
  || bad "the second signature was lost"

echo "== G. a real capacity refusal is still STAGING_ENVIRONMENT"
got="$(findings G-real-capacity-refusal.json)"
printf '%s\n' "$got" | grep -q '^STAGING_ENVIRONMENT|staging-capacity' \
  && ok "the product reporting a capacity refusal is the environment" \
  || bad "a genuine capacity refusal was misclassified (got: $got)"

echo "== H. a failed step with no log is UNKNOWN, not the nearest signature"
got="$(findings H-failed-step-with-no-log.json)"
[ "$got" = "UNKNOWN|None|Runtime" ] \
  && ok "UNKNOWN, scoped to the step that failed" \
  || bad "expected UNKNOWN in Runtime, got: $got"
node "$TOOL" --from-json "$FIX/H-failed-step-with-no-log.json" --json >/dev/null 2>&1
[ $? -eq 1 ] && ok "and it exits 1, so UNKNOWN cannot be read as success" || bad "UNKNOWN did not exit 1"

echo "== I. the API and the log disagreeing is REPORTED, not silently resolved"
node "$TOOL" --from-json "$FIX/I-step-conclusion-disagrees-with-log.json" --json 2>/dev/null > "$WORK/i.json"
cat > "$WORK/check_i.py" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
ds = d["disagreements"]
assert len(ds) == 1, ds
assert ds[0]["kind"] == "LOG_CONTRADICTS_API", ds[0]
assert ds[0]["step"] == "Report", ds[0]
PYEOF
python3 "$WORK/check_i.py" "$WORK/i.json" 2>/dev/null \
  && ok "the step the API called success but whose log shows a failure is flagged" \
  || bad "the disagreement was not reported"
got="$(findings I-step-conclusion-disagrees-with-log.json)"
printf '%s\n' "$got" | grep -q '|Report$' \
  && bad "the conflicting step was attributed anyway" \
  || ok "the conflicting step is excluded from the failed scope"

echo "== J. ordinary lines are not failure markers"
# The specific V1 defect: `isFailureLine` was `[\[FATAL\]|...]`, a character class.
got="$(findings J-ordinary-lines-are-not-failures.json)"
printf '%s\n' "$got" | grep -q '^UNKNOWN' \
  && ok "a green run with ordinary text yields no failure finding" \
  || bad "ordinary lines were treated as failures (got: $got)"
node "$TOOL" --from-json "$FIX/J-ordinary-lines-are-not-failures.json" --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
f=d["findings"][0]
assert f["nothingToClassify"] is True, f
assert "SUCCESS" in f["reason"], f["reason"]
' && ok "and it says the run SUCCEEDED rather than 'we could not tell'" || bad "a green run was reported as unreadable"

echo "== the character-class bug, directly"
# A unit assertion on the marker predicate, so a regression is caught by its name.
res="$(node --input-type=module -e '
const src = (await import("node:fs")).readFileSync("tests/ci/classify-failure.mjs", "utf8");
const m = src.match(/function isFailureLine\(body\) \{\s*return (\/.*?\/)\.test\(body\);/s);
if (!m) { console.log("NOFIND"); process.exit(0); }
const re = eval(m[1]);
const notFailures = ["everything is fine", "ok   the deployment activated", "PASS", "hello world",
                     "Compiling kernel v0.0.1", "Finished release in 42s"];
const yesFailures = ["  FAIL the deployment did not activate", "[FATAL] status: 429",
                     "thread panicked at kernel/src/runtime.rs:145", "##[error]Process completed with exit code 1",
                     "Error: docker daemon is not running"];
const wrong = notFailures.filter((s) => re.test(s)).concat(yesFailures.filter((s) => !re.test(s)));
if (wrong.length) { console.log("WRONG:" + JSON.stringify(wrong)); process.exit(1); }
console.log("OK");
' 2>/dev/null)"
[ "$res" = "OK" ] && ok "isFailureLine rejects ordinary text and accepts real markers" || bad "isFailureLine is wrong: $res"

echo "== backward compatibility: the V1 top-level keys still mean what they meant"
node "$TOOL" --from-json "$FIX/G-real-capacity-refusal.json" --json 2>/dev/null > "$WORK/g.json"
cat > "$WORK/check_compat.py" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["verdict"] == "STAGING_ENVIRONMENT", d["verdict"]
assert d["confidence"] == "specific", d["confidence"]
assert d["reason"], d
assert isinstance(d["evidence"], list) and d["evidence"], d["evidence"]
assert d["evidence"][0]["line"], d["evidence"][0]
assert d["findings"][0]["category"] == d["verdict"], "verdict must be findings[0]"
PYEOF
python3 "$WORK/check_compat.py" "$WORK/g.json" 2>/dev/null \
  && ok "verdict/confidence/reason/evidence are still present and consistent" \
  || bad "the V1 shape broke"

echo "== the tool cannot be used as a Required Check exemption"
# The brief's rule: classification is diagnosis, never a way to make a red check green.
# The exit code is part of that: a well-attributed failure must NOT exit 0, or a
# caller checking `if classify; then` reads "classified" as "no problem".
rc=0
node "$TOOL" --from-json "$FIX/A-recovered-429-then-assertion.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] && ok "an attributed failure exits 2, not 0" || bad "an attributed failure exited $rc (expected 2)"
rc=0
node "$TOOL" --from-json "$FIX/H-failed-step-with-no-log.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] && ok "an UNKNOWN failure exits 1" || bad "an UNKNOWN failure exited $rc (expected 1)"
rc=0
node "$TOOL" --from-json "$FIX/J-ordinary-lines-are-not-failures.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] && ok "the only exit 0 is a run with nothing to classify" || bad "a green run exited $rc"
# Assert there is no FLAG that could waive a failure, not that the words never appear:
# the docstring says the tool is not an exemption mechanism, which is the opposite.
grep -qE -- '--(allow|ignore|waive|skip|force-pass)' "$TOOL" \
  && bad "the tool accepts a flag that could waive a failure" || ok "no waiver flag exists in the tool"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
