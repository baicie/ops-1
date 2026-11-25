#!/usr/bin/env bash
# Phase 8C TASK-37: the evidence index must not call a check verified because
# something green happened near it.
#
# The defect this guards against, found while building the tool: the first version
# said `artifacts.length > 0` -> every passing check is PASSED_WITH_EVIDENCE.
# Measured on the #217 commit: 32 checks, ONE artifact uploaded by plugin-lifecycle,
# and the index called 27 of them evidence-backed - including checks produced by
# workflows that upload nothing. That is the same false assurance as calling them
# all verified, one step removed.
#
# Every case reads a committed fixture. No network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/evidence-index.mjs
FIX=tests/ci/fixtures/index
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$FIX"

# A commit with three checks: two green (one with an artifact of its own, one
# without) and one red.
python3 - "$FIX" <<'PY'
import json, sys, os
d = sys.argv[1]

gate = {"verdict": "FAIL", "required": ["ci-gate", "lifecycle", "other"],
        "failed": ["lifecycle"], "verified": ["ci-gate", "other"], "absent": [], "pending": [],
        "skippedRequired": [], "notWired": [], "impostor": [], "ambiguous": [], "unverifiable": []}
json.dump(gate, open(os.path.join(d, "gate.json"), "w"))

# TWO artifacts: one from the workflow that owns the RED `lifecycle` check, one
# from the workflow that owns the GREEN `other` check. The distinction matters -
# evidence does not upgrade a red check, and it must reach a green one only when
# the producer matches.
json.dump({"total_count": 2, "artifacts": [
    {"name": "lifecycle-evidence", "size_in_bytes": 87667,
     "created_at": "2026-11-25T00:00:00Z", "expires_at": "2026-12-09T00:00:00Z",
     "digest": "sha256:aaaa", "producer": "lifecycle"},
    {"name": "other-evidence", "size_in_bytes": 1024,
     "created_at": "2026-11-25T00:00:00Z", "expires_at": "2026-12-09T00:00:00Z",
     "digest": "sha256:bbbb", "producer": "other.yml"},
]}, open(os.path.join(d, "artifacts.json"), "w"))

# The mapping, as a caller that knows the workflow would supply it.
json.dump({"ci-gate": "ci.yml", "lifecycle": "lifecycle", "other": "other.yml",
           "__workflow": "lifecycle"}, open(os.path.join(d, "workflow-of.json"), "w"))

# A gate result whose checks are all green and whose run has NO artifacts.
json.dump({"verdict": "PASS", "required": ["ci-gate", "lifecycle"], "failed": [],
           "verified": ["ci-gate", "lifecycle"], "absent": [], "pending": [],
           "skippedRequired": [], "notWired": [], "impostor": [], "ambiguous": [], "unverifiable": []},
          open(os.path.join(d, "gate-green.json"), "w"))
json.dump({"total_count": 0, "artifacts": []}, open(os.path.join(d, "artifacts-none.json"), "w"))

# A gate result with a pending and an absent check.
json.dump({"verdict": "FAIL", "required": ["ci-gate", "slow", "gone"], "failed": [],
           "verified": ["ci-gate"], "absent": ["gone"], "pending": ["slow"],
           "skippedRequired": [], "notWired": [], "impostor": [], "ambiguous": [], "unverifiable": []},
          open(os.path.join(d, "gate-pending.json"), "w"))
PY

index() { node "$TOOL" --gate-json "$1" --artifacts "$2" ${3:+--workflow-of "$3"} --out "$WORK/out.json" >/dev/null 2>&1; }

echo "== 1. ONE artifact does not make every check evidence-backed"
index "$FIX/gate.json" "$FIX/artifacts.json" "$FIX/workflow-of.json"
python3 - "$WORK/out.json" <<'PY' && ok "exactly one check is PASSED_WITH_EVIDENCE, not all of them" || bad "one artifact was credited to many checks"
import json, sys
d = json.load(open(sys.argv[1]))
s = d["summary"]
assert s["passedWithEvidence"] == 1, s
named = [c["name"] for c in d["checks"] if c["state"] == "PASSED_WITH_EVIDENCE"]
assert named == ["other"], named
PY

echo "== 2. a green check with no artifact of its own is PASSED_NO_EVIDENCE"
python3 - "$WORK/out.json" <<'PY' && ok "the check that uploads nothing is not called evidence-backed" || bad "a check with no artifact was called evidence-backed"
import json, sys
d = json.load(open(sys.argv[1]))
st = {c["name"]: c["state"] for c in d["checks"]}
assert st["other"] == "PASSED_WITH_EVIDENCE", st
assert st["ci-gate"] == "PASSED_NO_EVIDENCE", st
PY

echo "== 3. without a producer map, nothing is attributed - and that is a THIRD state"
index "$FIX/gate.json" "$FIX/artifacts.json"
python3 - "$WORK/out.json" <<'PY' && ok "an artifact that cannot be tied to a check yields UNATTRIBUTED, not WITH_EVIDENCE" || bad "an unattributable artifact was credited anyway"
import json, sys
d = json.load(open(sys.argv[1]))
s = d["summary"]
assert s["passedWithEvidence"] == 0, s
assert s["passedEvidenceUnattributed"] == 2, (s, [(c["name"], c["state"]) for c in d["checks"]])
PY

echo "== 4. A RED CHECK IS FAILED whatever the evidence says"
python3 - "$WORK/out.json" <<'PY' && ok "a failed check is FAILED even though its own run DID upload" || bad "evidence upgraded a red check"
import json, sys
d = json.load(open(sys.argv[1]))
st = {c["name"]: c["state"] for c in d["checks"]}
assert st["lifecycle"] == "FAILED", st
PY

echo "== 5. a green run with ZERO artifacts says so, in numbers"
index "$FIX/gate-green.json" "$FIX/artifacts-none.json"
python3 - "$WORK/out.json" <<'PY' && ok "22 checks green and no artifacts reads as 22 passed-without-evidence" || bad "a green run with no evidence was not reported"
import json, sys
d = json.load(open(sys.argv[1]))
s = d["summary"]
assert s["failed"] == 0, s
assert s["passedWithEvidence"] == 0, s
assert s["passedNoEvidence"] == 2, s
assert s["artifacts"] == 0, s
PY

echo "== 6. pending and absent are their own states, not folded into failed"
index "$FIX/gate-pending.json" "$FIX/artifacts-none.json"
python3 - "$WORK/out.json" <<'PY' && ok "slow is PENDING and gone is UNKNOWN, neither is FAILED" || bad "pending/absent were conflated"
import json, sys
d = json.load(open(sys.argv[1]))
st = {c["name"]: c["state"] for c in d["checks"]}
assert st["slow"] == "PENDING", st
assert st["gone"] == "UNKNOWN", st
assert st["ci-gate"] == "PASSED_NO_EVIDENCE", st
assert d["summary"]["pending"] == 1, d["summary"]
PY

echo "== 7. no artifact list at all is PARTIAL with a reason, not a clean zero"
node "$TOOL" --gate-json "$FIX/gate.json" --out "$WORK/o.json" >/dev/null 2>&1
python3 - "$WORK/o.json" <<'PY' && ok "a missing artifact list is PARTIAL and every evidence field is UNKNOWN" || bad "an unread artifact list became 'no evidence'"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["completeness"]["status"] == "PARTIAL", d["completeness"]
assert d["completeness"]["reason"], d["completeness"]
assert all(c["evidence"] == "UNKNOWN" for c in d["checks"]), [c["evidence"] for c in d["checks"]]
assert any("artifact" in o["what"] for o in d["omissions"]), d["omissions"]
PY

echo "== 8. nothing at all is UNAVAILABLE and exits 2"
node "$TOOL" > "$WORK/u.json" 2>/dev/null; rc=$?
[ "$rc" -eq 2 ] && ok "exit 2 when there is nothing to index" || bad "exit was $rc"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["completeness"]["status"]=="UNAVAILABLE"' "$WORK/u.json" \
  && ok "and the artifact says UNAVAILABLE rather than an empty index" || bad "an empty index was presented as complete"

echo "== 9. the retention expiry is carried, so an index entry can be acted on"
index "$FIX/gate.json" "$FIX/artifacts.json" "$FIX/workflow-of.json"
python3 - "$WORK/out.json" <<'PY' && ok "an artifact carries its expiry and digest" || bad "retention was not indexed"
import json, sys
d = json.load(open(sys.argv[1]))
a = d["evidenceArtifacts"][0]
assert a["retentionExpiresAt"], a
assert a["digest"], a
assert a["belongsTo"] == "run", a
PY

echo "== 10. the index does not claim an artifact VERIFIES a check"
python3 - "$WORK/out.json" <<'PY' && ok "the note says what PASSED_WITH_EVIDENCE does not mean" || bad "the index overclaims"
import json, sys
d = json.load(open(sys.argv[1]))
assert "not a claim that the artifact verifies" in d["note"], d["note"]
PY
# Only RUNTIME STRINGS can be a claim a caller sees. Scanning comments makes the
# check fire on the sentence that DENIES the claim - which it did, twice.
python3 - "$TOOL" <<'PYEOF'
import re, sys
src = open(sys.argv[1]).read()
# Drop line comments and block comments.
src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
bad = []
for m in re.finditer(r"artifact[^.]{0,60}\bverifies?\b", src, re.I):
    window = src[max(0, m.start() - 80):m.end() + 40]
    if re.search(r"\bnot a claim\b|\bnever\b|\bdoes not\b|\bcannot\b", window, re.I):
        continue
    bad.append(window.strip()[:120])
raise SystemExit(0 if not bad else 1)
PYEOF
[ $? -eq 0 ] && ok "no unqualified claim that an artifact verifies a check" || bad "the tool claims an artifact verifies a check"

echo "== 11. THE INDEX IS PRODUCED BY A WORKFLOW, NOT ONLY BY THIS TEST"
# The defect this repository has recorded before: a tool with every test green and
# no call site. `shipped-but-not-connected`. So the wiring is asserted structurally.
python3 - "$ROOT/.github/workflows/ci.yml" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
assert "tests/ci/evidence-index.mjs" in src, "ci.yml never runs the index"
# It must run when the gate is red, or it is useless exactly when needed.
i = src.index("tests/ci/evidence-index.mjs")
step_start = src.rfind("- name:", 0, i)
step = src[step_start:i + 200]
assert "always()" in step, "the index step is skipped on a red gate: " + step[:200]
assert "upload-artifact" in src[i:], "the index is built and thrown away"
PYEOF
[ $? -eq 0 ] && ok "ci-gate produces the index and uploads it, even on a red gate" || bad "the index has no workflow call site"

echo "== 12. THE INDEX CANNOT CHANGE THE GATE'S VERDICT"
# It runs after the gate has written its result, and it exits 0 whatever happens.
python3 - "$ROOT/.github/workflows/ci.yml" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
i = src.index("tests/ci/evidence-index.mjs")
# Slice to the NEXT step, not a fixed window: a fixed window runs past the step
# boundary and sees the next step's text, which is how this assertion first failed
# against a step that was in fact correct.
nxt = src.find("- name:", i)
step = src[src.rfind("- name:", 0, i):(nxt if nxt >= 0 else len(src))]
# The step's own exit must be neutral: an index that can redden a green gate (or
# green a red one) is a second gate, and there must be exactly one.
assert "exit 0" in step, "the index step does not neutralise its own exit: " + step[:300]
assert "continue-on-error" not in step, "continue-on-error would hide a real failure here"
PYEOF
[ $? -eq 0 ] && ok "the index step cannot alter the gate verdict" || bad "the index can influence the gate"

echo "== 13. A RETRIED RUN'S TWO SAME-NAMED ARTIFACTS ARE REPORTED AS AMBIGUOUS"
# Measured on real run 45542879392 (attempt 2): two artifacts both named
# plugin-lifecycle-evidence, created 04:11 and 05:05. The artifact object has no
# run_attempt, so the index must NOT silently pick one - it must name the collision.
python3 - "$WORK/dup.json" <<'PYDUP'
import json, sys
json.dump({"total_count": 2, "artifacts": [
  {"name": "plugin-lifecycle-evidence", "id": 2, "created_at": "2026-11-25T05:05:37Z",
   "expires_at": "2026-12-09T00:00:00Z", "digest": "sha256:bb"},
  {"name": "plugin-lifecycle-evidence", "id": 1, "created_at": "2026-11-25T04:11:17Z",
   "expires_at": "2026-12-09T00:00:00Z", "digest": "sha256:aa"},
]}, open(sys.argv[1], "w"))
PYDUP
node "$TOOL" --gate-json "$FIX/gate.json" --artifacts "$WORK/dup.json" --out "$WORK/dup-out.json" >/dev/null 2>&1
python3 - "$WORK/dup-out.json" <<'PYCHK' && ok "the collision is named, and BOTH rows are kept" || bad "a duplicate artifact name was silently resolved"
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d["evidenceArtifacts"]) == 2, len(d["evidenceArtifacts"])
c = d["artifactNameCollisions"]
assert len(c) == 1, c
assert c[0]["name"] == "plugin-lifecycle-evidence", c
assert c[0]["count"] == 2, c
assert "run_attempt" in c[0]["why"], c
PYCHK

echo "== 14. no network is needed for any case above"
grep -qE -- '--run [0-9]{6,}' "$0" && bad "this self-test calls the live API" || ok "no live run id appears in this file"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
