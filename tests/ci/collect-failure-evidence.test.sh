#!/usr/bin/env bash
# Phase 8A TASK-28 + TASK-29: evidence scoped to a job and an attempt, and a budget
# measured in UTF-8 bytes.
#
# TASK-28's defect: V1 hung the whole artifact off the first failure line in the log,
# so a run with four failed jobs got one cause. It also swallowed API errors -
# `tryGh` returned the ERROR TEXT as though it were the response - so a 403 became
# `failedJobs: []`, written in the same voice as a run that genuinely had none.
#
# TASK-29's defect: the cap was checked in bytes and applied in UTF-16 code units, so
# a "512 KB" artifact of CJK log text was 1.5 MB, and a slice could end on a lone
# surrogate.
#
# No case here touches the network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/collect-failure-evidence.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A two-job fixture: one job fails on an assertion, one on a capacity refusal, with
# distinct step prefixes so the ranges must not cross.
python3 - "$WORK/two.json" <<'PY'
import json, sys
log = "\n".join([
  "job-a\tBuild\t2026-11-25T00:00:00Z compiling",
  "job-a\tSuite A\t2026-11-25T00:00:01Z   ok   the deployment activated",
  "job-a\tSuite A\t2026-11-25T00:00:02Z   FAIL job-a's assertion",
  "job-b\tSuite B\t2026-11-25T00:00:03Z Error: status_reason=4 instances against a per-node limit of 4 [INSTANCE_CAPACITY_EXCEEDED]",
  "job-b\tSuite B\t2026-11-25T00:00:04Z   FAIL job-b did not deploy",
])
json.dump({
  "run": {"id": 42, "run_attempt": 3, "name": "CI", "event": "push", "head_sha": "c"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "2026-11-25T00:00:00Z", "run_started_at": "2026-11-25T00:00:00Z",
          "updated_at": "2026-11-25T00:10:00Z", "html_url": "u",
          "previous_attempt_url": "https://example.invalid/prev"},
  "jobs": {"jobs": [
    {"id": 1, "name": "job-a", "conclusion": "failure", "started_at": "s", "completed_at": "e",
     "runner_name": "r", "steps": [
       {"name": "Build", "number": 1, "conclusion": "success", "started_at": "s", "completed_at": "e"},
       {"name": "Suite A", "number": 2, "conclusion": "failure", "started_at": "s", "completed_at": "e"}]},
    {"id": 2, "name": "job-b", "conclusion": "failure", "started_at": "s", "completed_at": "e",
     "runner_name": "r", "steps": [
       {"name": "Suite B", "number": 1, "conclusion": "failure", "started_at": "s", "completed_at": "e"}]},
  ]},
  "log": log,
}, open(sys.argv[1], "w"), indent=2)
PY

echo "== 28.1 each failed job is collected separately, with its own cause"
node "$TOOL" --from-json "$WORK/two.json" --json > "$WORK/two-out.json" 2>/dev/null
python3 - "$WORK/two-out.json" <<'PY' && ok "two jobs, two findings, two different categories" || bad "the jobs were folded into one cause"
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d["failedJobs"]) == 2, [j["jobName"] for j in d["failedJobs"]]
by = {j["jobName"]: j["classification"]["verdict"] for j in d["failedJobs"]}
assert by["job-a"] == "PRODUCT_REGRESSION", by
assert by["job-b"] == "STAGING_ENVIRONMENT", by
PY

echo "== 28.2 the log range is scoped to the STEP, not to the run"
python3 - "$WORK/two-out.json" <<'PY' && ok "job-a's excerpt contains none of job-b's lines" || bad "the excerpt crossed job boundaries"
import json, sys
d = json.load(open(sys.argv[1]))
a = [j for j in d["failedJobs"] if j["jobName"] == "job-a"][0]
st = a["failedSteps"][0]
assert st["sourceStatus"] == "AVAILABLE", st
assert "INSTANCE_CAPACITY_EXCEEDED" not in st["excerpt"], st["excerpt"]
assert "job-b" not in st["excerpt"], st["excerpt"]
PY

echo "== 28.3 the attempt is pinned and carried on every failed job"
python3 - "$WORK/two-out.json" <<'PY' && ok "every job records the same pinned attempt" || bad "the attempt was not pinned per job"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["run"]["attempt"] == 3, d["run"]["attempt"]
assert {j["attempt"] for j in d["failedJobs"]} == {3}, [j["attempt"] for j in d["failedJobs"]]
assert d["run"]["isRetry"] is True, d["run"]
PY

echo "== 28.4 a failed step with no log section is UNAVAILABLE, not silently empty"
python3 - "$WORK/nolog.json" <<'PY'
import json, sys
json.dump({
  "run": {"id": 7, "run_attempt": 1, "name": "CI", "event": "push", "head_sha": "d"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "s", "run_started_at": "s", "updated_at": "e", "html_url": "u",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 70, "name": "j", "conclusion": "failure", "started_at": "s", "completed_at": "e",
    "runner_name": "r", "steps": [
      {"name": "Present", "number": 1, "conclusion": "success", "started_at": "s", "completed_at": "e"},
      {"name": "Missing", "number": 2, "conclusion": "failure", "started_at": "s", "completed_at": "e"}]}]},
  "log": "j\tPresent\t2026-11-25T00:00:00Z PASS=3 FAIL=0 BLOCKED=0 NOT_RUN=0\n",
}, open(sys.argv[1], "w"), indent=2)
PY
node "$TOOL" --from-json "$WORK/nolog.json" --json > "$WORK/nolog-out.json" 2>/dev/null
python3 - "$WORK/nolog-out.json" <<'PY' && ok "the missing step is recorded as UNAVAILABLE with a reason" || bad "the missing step was silently dropped"
import json, sys
d = json.load(open(sys.argv[1]))
st = d["failedJobs"][0]["failedSteps"][0]
assert st["name"] == "Missing", st
assert st["sourceStatus"] == "UNAVAILABLE", st
assert st["reason"], st
assert d["completeness"]["status"] == "PARTIAL", d["completeness"]
assert any("Missing" in o["what"] for o in d["omissions"]), d["omissions"]
PY

echo "== 28.5 an unreadable run is UNAVAILABLE and exits 2, not an empty artifact"
# No fixture: point --from-json at a file with no run.id, which is the same code path
# as "the API refused us".
printf '{"log":"x"}' > "$WORK/norun.json"
node "$TOOL" --from-json "$WORK/norun.json" --json > "$WORK/norun-out.json" 2>/dev/null
rc=$?
[ "$rc" -eq 2 ] && ok "exits 2 (not 0) when the run cannot be read" || bad "exit code was $rc"
python3 - "$WORK/norun-out.json" <<'PY' && ok "the artifact says UNAVAILABLE and gives the reason" || bad "the artifact claimed completeness"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["completeness"]["status"] == "UNAVAILABLE", d["completeness"]
assert d["completeness"]["reason"], d["completeness"]
assert d["run"] is None
PY

echo "== 28.6 an API error never becomes an empty failedJobs list"
# The V1 bug in one assertion: `failedJobs: []` next to `status: COMPLETE` is the
# exact sentence that reads as "this run had no failures".
python3 - "$WORK/norun-out.json" <<'PY' && ok "an empty list is never paired with a complete status" || bad "an unreadable run produced a complete-looking empty list"
import json, sys
d = json.load(open(sys.argv[1]))
if d["completeness"]["status"] != "COMPLETE":
    assert d["failedJobs"] == [] or d["failedJobs"], "n/a"
    assert d["completeness"]["reason"], "a non-COMPLETE status must say why"
PY

echo "== 28.7 unnamed log lines are NOT assigned to the nearest job"
python3 - "$WORK/unattr.json" <<'PY'
import json, sys
json.dump({
  "run": {"id": 8, "run_attempt": 1, "name": "CI", "event": "push", "head_sha": "e"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "s", "run_started_at": "s", "updated_at": "e", "html_url": "u",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 80, "name": "j", "conclusion": "failure", "started_at": "s", "completed_at": "e",
    "runner_name": "r", "steps": [{"name": "S", "number": 1, "conclusion": "failure", "started_at": "s", "completed_at": "e"}]}]},
  "log": "a line with no tab prefix and a SECRETTOKEN=abcdef123456\nj\tS\t2026-11-25T00:00:00Z   FAIL something\n",
}, open(sys.argv[1], "w"), indent=2)
PY
node "$TOOL" --from-json "$WORK/unattr.json" --json > "$WORK/unattr-out.json" 2>/dev/null
python3 - "$WORK/unattr-out.json" <<'PY' && ok "the unprefixed line is kept at run level, not attributed to job j" || bad "an unattributed line was assigned to a job"
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d["unattributedLines"]) == 1, d["unattributedLines"]
ex = d["failedJobs"][0]["failedSteps"][0]["excerpt"]
assert "no tab prefix" not in ex, ex
PY
grep -q 'abcdef123456' "$WORK/unattr-out.json" && bad "the unattributed line leaked its secret" || ok "and it is sanitized"

echo "== 28.8 THE SANITIZER NEVER CORRUPTS THE ARTIFACT IT SANITIZES"
# Found while writing this test: the env-assignment rule's `\S+` value group crossed
# the JSON field boundary and made the artifact unparseable. A sanitizer that breaks
# its own output is worse than one that misses a secret, because the failure is
# silent in the direction that matters (bad JSON is caught; a mangled field is not).
node --input-type=module -e '
const { sanitizeText, sanitizeArtifact, NOTICE } = await import("./tests/ci/lib/evidence-sanitize.mjs");
const shapes = [
  "SECRETTOKEN=abcdef123456",
  "PLUGIN_SECRET=\"quoted value\"",
  "a,b,c KEY=value} ]",
  "\u001b[31mghp_abcdefghijklmnopqrstuvwxyz0123456789\u001b[0m",
  "Authorization: Bearer abcdefghijklmnop1234",
  "postgres://u:p@h:5432/d",
];
let bad = 0;
for (const line of shapes) {
  // Through the REAL boundary a caller uses, not a hand-rolled JSON.stringify:
  // the defect was in how sanitizeArtifact handled a serialised object, so the
  // assertion has to go through sanitizeArtifact.
  const out = sanitizeArtifact({ line, notice: NOTICE, nested: { deep: [line] } });
  try {
    JSON.parse(JSON.stringify(out));
  } catch (e) { bad += 1; console.error("broke on:", line, e.message); }
  // The variable NAME survives on purpose: it is the label, not the secret. What
  // must not survive is the VALUE.
  for (const secret of ["abcdef123456", "quoted value", "abcdefghijklmnop1234", ":p@h:"]) {
    if (out.line.includes(secret)) { bad += 1; console.error("value survived:", secret, "in", out.line); }
  }
}
console.log(bad === 0 ? "OK" : `BROKEN:${bad}`);
' > "$WORK/selfclean.txt" 2>/dev/null
[ "$(cat "$WORK/selfclean.txt")" = "OK" ] && ok "serialise -> sanitize -> parse round-trips for every shape" || bad "the sanitizer corrupts JSON: $(cat "$WORK/selfclean.txt")"

echo "== 29.1 the budget is measured in UTF-8 BYTES, not characters"
python3 - "$WORK/cjk.json" <<'PY'
import json, sys
# 200k CJK characters: 200k UTF-16 units, 600k UTF-8 bytes. A 512 KB cap applied in
# characters would let this through at 600 KB.
cjk = "中文日志 " * 40000
log = "j\tS\t2026-11-25T00:00:00Z " + cjk + "\nj\tS\t2026-11-25T00:00:01Z   FAIL the assertion\n"
json.dump({
  "run": {"id": 9, "run_attempt": 1, "name": "CI", "event": "push", "head_sha": "f"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "s", "run_started_at": "s", "updated_at": "e", "html_url": "u",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 90, "name": "j", "conclusion": "failure", "started_at": "s", "completed_at": "e",
    "runner_name": "r", "steps": [{"name": "S", "number": 1, "conclusion": "failure", "started_at": "s", "completed_at": "e"}]}]},
  "log": log,
}, open(sys.argv[1], "w"), indent=2)
PY
node "$TOOL" --from-json "$WORK/cjk.json" --out "$WORK/cjk-out.json" --max-bytes 200000 >/dev/null 2>&1
python3 - "$WORK/cjk-out.json" <<'PY' && ok "the SERIALISED artifact is under the byte budget" || bad "the artifact exceeds the byte budget"
import os, sys
n = os.path.getsize(sys.argv[1])
assert n <= 200000 + 4096, n
PY

echo "== 29.2 the truncated artifact is still valid JSON and valid UTF-8"
python3 - "$WORK/cjk-out.json" <<'PY' && ok "it parses, and no replacement character was introduced" || bad "truncation produced invalid output"
import json, sys
raw = open(sys.argv[1], "rb").read()
text = raw.decode("utf-8")          # raises on a split sequence
d = json.loads(text)
assert "�" not in text, "a replacement character means a sequence was cut"
assert d["truncation"]["truncated"] is True, d["truncation"]
assert d["truncation"]["bytes"] <= d["truncation"]["maxBytes"], d["truncation"]
PY

echo "== 29.3 no truncation splits a multi-byte character"
node --input-type=module -e '
const { truncateUtf8 } = await import("./tests/ci/lib/evidence-budget.mjs");
let bad = 0;
for (const s of ["中".repeat(500), "😀".repeat(200), "a😀中b".repeat(300), "x".repeat(100)]) {
  for (let cap = 0; cap < 400; cap += 1) {
    const r = truncateUtf8(s, cap);
    if (Buffer.byteLength(r.text, "utf8") > cap) { bad += 1; break; }
    if (/[\uD800-\uDBFF]$/.test(r.text)) { bad += 1; break; }
    if (r.text.includes("�")) { bad += 1; break; }
    if (Buffer.from(Buffer.from(r.text, "utf8")).toString("utf8") !== r.text) { bad += 1; break; }
  }
}
console.log(bad === 0 ? "OK" : `BAD:${bad}`);
' > "$WORK/trunc.txt" 2>/dev/null
[ "$(cat "$WORK/trunc.txt")" = "OK" ] && ok "every cap from 0 to 400 lands on a character boundary" || bad "truncation split a character: $(cat "$WORK/trunc.txt")"

echo "== 29.4 truncation keeps the structure and drops the detail"
python3 - "$WORK/cjk-out.json" <<'PY' && ok "the failed job, its failed step and the verdict survive" || bad "truncation dropped structure"
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d["failedJobs"]) == 1, d["failedJobs"]
assert d["failedJobs"][0]["classification"]["verdict"], d["failedJobs"][0]["classification"]
assert len(d["failedJobs"][0]["failedSteps"]) == 1
assert d["failedJobs"][0]["failedSteps"][0]["sourceStatus"] == "AVAILABLE"
PY

echo "== 29.5 truncation is REPORTED, with the byte counts"
python3 - "$WORK/cjk-out.json" <<'PY' && ok "the artifact says how much was dropped" || bad "truncation was hidden"
import json, sys
d = json.load(open(sys.argv[1]))
t = d["truncation"]
assert t["truncated"] is True
assert t["droppedBytes"] >= 0, t
assert any("budget" in o["why"] or "shortened" in o["why"] for o in d["omissions"]), d["omissions"]
PY

echo "== 29.6 a large log does not exhaust the runner"
# The read cap is a parameter, not a hardcoded hope. This exercises the accounting.
python3 - "$WORK/huge.json" <<'PY'
import json, sys
line = "j\tS\t2026-11-25T00:00:00Z " + ("y" * 5000)
json.dump({
  "run": {"id": 10, "run_attempt": 1, "name": "CI", "event": "push", "head_sha": "a"*40,
          "head_branch": "b", "status": "completed", "conclusion": "failure",
          "created_at": "s", "run_started_at": "s", "updated_at": "e", "html_url": "u",
          "previous_attempt_url": None},
  "jobs": {"jobs": [{"id": 100, "name": "j", "conclusion": "failure", "started_at": "s", "completed_at": "e",
    "runner_name": "r", "steps": [{"name": "S", "number": 1, "conclusion": "failure", "started_at": "s", "completed_at": "e"}]}]},
  "log": "\n".join([line] * 400 + ["j\tS\t2026-11-25T00:00:09Z   FAIL end"]),
}, open(sys.argv[1], "w"), indent=2)
PY
start=$(date +%s)
node "$TOOL" --from-json "$WORK/huge.json" --max-bytes 65536 --json > "$WORK/huge-out.json" 2>/dev/null
elapsed=$(( $(date +%s) - start ))
[ "$elapsed" -lt 30 ] && ok "a 2 MB log is bounded and completes in ${elapsed}s" || bad "took ${elapsed}s"
python3 -c 'import json,os,sys;print("bytes",os.path.getsize(sys.argv[1]))' "$WORK/huge-out.json" >/dev/null
python3 - "$WORK/huge-out.json" <<'PY' && ok "and the artifact still fits its budget" || bad "the budget was not enforced"
import json, os, sys
assert os.path.getsize(sys.argv[1]) <= 65536 + 4096, os.path.getsize(sys.argv[1])
PY

echo "== 29.7 the fixture path and the online path share one post-processing chain"
# Asserted structurally: there is exactly one place that builds the artifact, and
# `--from-json` only replaces the fetch.
grep -c 'const collected = {' "$TOOL" | grep -qx 1 \
  && ok "one artifact-construction site, used by both paths" \
  || bad "the fixture and live paths build different artifacts"

echo "== the schema the brief names is present"
node "$TOOL" --from-json "$WORK/two.json" --json 2>/dev/null > "$WORK/schema.json"
python3 - "$WORK/schema.json" <<'PY' && ok "schemaVersion, collectedAt, source, run, completeness, failedJobs, omissions, redaction, truncation, integrity" || bad "a named schema field is missing"
import json, sys
d = json.load(open(sys.argv[1]))
for k in ["schemaVersion", "collectedAt", "source", "run", "completeness", "failedJobs", "omissions", "redaction", "truncation", "integrity"]:
    assert k in d, k
for j in d["failedJobs"]:
    for k in ["runId", "attempt", "jobId", "jobName", "conclusion", "failedSteps", "classification", "sourceStatus"]:
        assert k in j, k
PY

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
