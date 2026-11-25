#!/usr/bin/env bash
# Phase 8D TASK-40: a merged PR is not a verified main.
#
# The brief's rule is 「PR 通过不等于 main 通过」. Four of TASK-40's five
# requirements were already enforced by tools that exist; the fifth - "after
# merging, check what main actually ran" - was a sentence in a document.
#
# The three states this tool must never merge, and the three cases that taught it:
#
#   CANCELLED   merging twice in quick succession cancels the first commit's runs
#               (cancel-in-progress on pushes). NOT a failure, and NOT a pass.
#   path-filter  a workflow that watches paths a commit did not touch correctly does
#               not run. Calling that "missing" is a demand it never agreed to.
#   tag-trigger  release-certification.yml pushes on tags, not branches. A shallow
#               parse of `push:` said it owed a run for every commit.
#
# Every case reads a committed fixture. No network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/verify-main.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# THE FIXTURES LIVE IN A TEMPORARY DIRECTORY, NOT IN THE REPOSITORY.
#
# This test used to write them to `tests/ci/fixtures/mainruns/` and commit them,
# and it regenerated them on every run. The `runId` was `hash(wf) % 10000`, and
# Python's string hash is RANDOMIZED PER PROCESS (`PYTHONHASHSEED`), so every run
# produced different bytes: a clean tree became dirty merely by running the
# suite. That is a test with a side effect, and it surfaced as `git checkout`
# aborting on a "modified" fixture nobody had edited.
#
# Nothing outside this file reads those fixtures (verified: the only reference is
# the FIX assignment that used to be here), and no assertion reads `runId`. So the
# whole set is generated into $WORK and thrown away with it.
FIX="$WORK/fixtures"
mkdir -p "$FIX"

state_of() { node "$TOOL" --from-json "$1" --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])'; }

# ---------------------------------------------------------------------------
# Fixtures. Each models one real commit on main.
# ---------------------------------------------------------------------------
python3 - "$FIX" <<'PY'
import json, sys, os, zlib
d = sys.argv[1]
# A DETERMINISTIC runId. `hash()` is randomized per process, so it made the
# fixtures differ on every run; nothing asserts this field, it exists so a
# reader can tell two runs apart. crc32 is stable across processes and
# versions, which is all this needs to be.
def run(wf, concl, status="completed", created="2026-11-25T00:00:00Z", attempt=1):
    return {"workflow": wf, "name": wf.replace(".yml", ""), "status": status,
            "conclusion": concl, "createdAt": created, "attempt": attempt,
            "runId": zlib.crc32(wf.encode()) % 10000}

# VERIFIED: the three unfiltered workflows all succeeded.
json.dump({"sha": "aaa", "runs": [
    run("ci.yml", "success", created="2026-11-25T01:00:00Z"),
    run("staging-preview.yml", "success", created="2026-11-25T01:00:00Z"),
]}, open(os.path.join(d, "verified.json"), "w"))

# FAILED: one unfiltered workflow failed.
json.dump({"sha": "bbb", "runs": [
    run("ci.yml", "success"),
    run("staging-preview.yml", "failure"),
]}, open(os.path.join(d, "failed.json"), "w"))

# CANCELLED: the unfiltered runs were superseded, nothing failed.
json.dump({"sha": "ccc", "runs": [
    run("ci.yml", "cancelled"),
    run("staging-preview.yml", "cancelled"),
]}, open(os.path.join(d, "cancelled.json"), "w"))

# FAILED beats CANCELLED: one red, one superseded.
json.dump({"sha": "ddd", "runs": [
    run("ci.yml", "cancelled"),
    run("staging-preview.yml", "failure"),
]}, open(os.path.join(d, "failed-and-cancelled.json"), "w"))

# INCOMPLETE: still running.
json.dump({"sha": "eee", "runs": [
    run("ci.yml", "success"),
    run("staging-preview.yml", None, status="in_progress"),
]}, open(os.path.join(d, "incomplete.json"), "w"))

# A path-filtered workflow that did not run must NOT be reported as missing.
json.dump({"sha": "fff", "runs": [
    run("ci.yml", "success"),
    run("staging-preview.yml", "success"),
]}, open(os.path.join(d, "filtered-absent.json"), "w"))

# A re-run: two rows for one workflow, the later one decides.
json.dump({"sha": "ggg", "runs": [
    run("ci.yml", "failure", created="2026-11-25T01:00:00Z"),
    run("ci.yml", "success", created="2026-11-25T02:00:00Z"),
    run("staging-preview.yml", "success"),
]}, open(os.path.join(d, "rerun.json"), "w"))
PY

echo "== 1. all unfiltered workflows success is VERIFIED"
[ "$(state_of "$FIX/verified.json")" = "VERIFIED" ] && ok "VERIFIED" || bad "got $(state_of "$FIX/verified.json")"

echo "== 2. a failed workflow is FAILED, never VERIFIED"
[ "$(state_of "$FIX/failed.json")" = "FAILED" ] && ok "FAILED" || bad "got $(state_of "$FIX/failed.json")"

echo "== 3. CANCELLED is its own state - not a failure, and NOT a pass"
[ "$(state_of "$FIX/cancelled.json")" = "CANCELLED" ] && ok "CANCELLED" || bad "got $(state_of "$FIX/cancelled.json")"
node "$TOOL" --from-json "$FIX/cancelled.json" --json > "$WORK/cancelled-out.json" 2>/dev/null || true
python3 - "$WORK/cancelled-out.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert "nothing about it was verified" in d["reason"], d["reason"]
assert "superseded" in d["reason"], d["reason"]
PYCHK
[ $? -eq 0 ] && ok "and it says the commit was never verified, rather than implying it was fine" \
  || bad "CANCELLED does not say what it means"
rc=0; node "$TOOL" --from-json "$FIX/cancelled.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] && ok "and exits 3, a code of its own - not 0 and not 1" || bad "CANCELLED exited $rc"

echo "== 4. FAILED beats CANCELLED"
# A commit with a red suite was not merely superseded, and reporting CANCELLED
# would describe a broken commit as a replaced one.
[ "$(state_of "$FIX/failed-and-cancelled.json")" = "FAILED" ] && ok "FAILED wins" || bad "got $(state_of "$FIX/failed-and-cancelled.json")"

echo "== 5. a running workflow is INCOMPLETE, not 'probably fine'"
[ "$(state_of "$FIX/incomplete.json")" = "INCOMPLETE" ] && ok "INCOMPLETE" || bad "got $(state_of "$FIX/incomplete.json")"
rc=0; node "$TOOL" --from-json "$FIX/incomplete.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] && ok "and exits non-zero" || bad "INCOMPLETE exited $rc"

echo "== 6. a PATH-FILTERED workflow that did not run is not 'missing'"
# The first version reported six workflows as missing on a commit that simply had
# not touched their paths. A false alarm teaches a reader to ignore the tool.
node "$TOOL" --from-json "$FIX/filtered-absent.json" --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["state"]=="VERIFIED", d["state"]
assert d["notTriggered"], d["notTriggered"]
assert d["notTriggeredNote"], d
assert not d["pending"], d["pending"]
' && ok "VERIFIED, with the not-triggered workflows listed separately" || bad "a path-filtered workflow was reported as missing"

echo "== 7. a TAG-triggered workflow is not expected on a commit"
# release-certification.yml pushes on `tags: ['v*']`. Expecting it on main was a
# demand the workflow never agreed to.
node --input-type=module -e '
const { pushWorkflows } = await import("./tests/ci/verify-main.mjs");
const { unfiltered, filtered } = pushWorkflows();
if (unfiltered.includes("release-certification.yml")) { console.log("WRONG"); process.exit(1); }
if (!unfiltered.includes("ci.yml")) { console.log("MISSING-CI"); process.exit(1); }
if (!unfiltered.includes("staging-preview.yml")) { console.log("MISSING-STAGING"); process.exit(1); }
console.log("OK");
' > "$WORK/tag.txt" 2>/dev/null
[ "$(cat "$WORK/tag.txt")" = "OK" ] && ok "ci.yml and staging-preview.yml are required; the tag-triggered one is not" \
  || bad "push-workflow detection is wrong: $(cat "$WORK/tag.txt")"

echo "== 8. a RE-RUN's later answer decides"
[ "$(state_of "$FIX/rerun.json")" = "VERIFIED" ] && ok "the later success is the answer" || bad "got $(state_of "$FIX/rerun.json")"

echo "== 9. no run at all is UNAVAILABLE, never a clean result"
printf '{"sha":"zzz","runs":[]}' > "$WORK/none.json"
rc=0; node "$TOOL" --from-json "$WORK/none.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] && ok "exits 2 when there is nothing to read" || bad "exited $rc"
# Capture first, then read. Under `set -o pipefail` the tool's intentional exit 2
# becomes the PIPELINE's status, so `tool | python` is red even when the JSON is
# exactly right. Measured: this assertion failed against a correct tool.
node "$TOOL" --from-json "$WORK/none.json" --json > "$WORK/none-out.json" 2>/dev/null || true
python3 - "$WORK/none-out.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["state"] == "UNAVAILABLE", d["state"]
assert d["reason"], d
PYCHK
[ $? -eq 0 ] && ok "and says UNAVAILABLE with a reason" || bad "an empty run list produced a result"

echo "== 9b. a COMMIT WITH NO RUN is not the same as a commit with no workflows"
# Both produce an empty list; the difference is what the tool says about it.
python3 - "$WORK/none-out.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert "not on main" in d["reason"] or "has not started" in d["reason"], d["reason"]
PYCHK
[ $? -eq 0 ] && ok "and it says why, rather than 'all clear'" || bad "the empty case has no explanation"

echo "== 10. the tool says what it is NOT answering"
node "$TOOL" --from-json "$FIX/verified.json" --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert "different execution" in d["note"], d["note"]
assert "pull request" in d["note"].lower(), d["note"]
' && ok "the note states that a green PR does not substitute for this" || bad "the tool does not distinguish itself from PR verification"

echo "== 11. no network is needed for any case above"
grep -qE -- '--sha [0-9a-f]{7,}' "$0" && bad "this self-test calls the live API" || ok "no live sha appears in this file"

echo "== 12. running this suite does not modify the working tree"
# A test that dirties the repository on every run is a test that lies about the
# state of the checkout: `git checkout` starts refusing, and a real uncommitted
# change hides among regenerated fixtures. This repository had exactly that - the
# fixtures were written into `tests/ci/fixtures/mainruns/` with a randomized
# `hash()` in them, so the bytes changed on every invocation.
#
# WHAT THIS COMPARES, AND WHY IT IS A DELTA.
#
# The first version asserted that `git status -- tests/ci/fixtures` was empty. It
# was wrong the moment the fixtures were deleted from the repository: a staged
# deletion is a legitimate state of the checkout, and the assertion reported the
# author's own `git rm` as "this suite modified the repository". A test that
# fails on someone else's edit teaches a reader to skip it.
#
# The question is "did THIS RUN change anything", so it is answered as a
# difference between the tree before and after. Whatever the checkout already
# carried is not this suite's business.
# THE CHECK RUNS AT THE END OF THE FILE, WHICH IS THE RIGHT PLACE FOR IT.
#
# Every fixture was generated at the top and every case above has run, so if this
# suite writes into the repository it has already done so by now. No before/after
# pair is needed - and taking one around a nested `bash "$0"` would be unbounded
# recursion.
UNTRACKED="$(git status --porcelain --untracked-files=all -- tests/ci/fixtures 2>/dev/null | grep '^??' || true)"
[ -z "$UNTRACKED" ] && ok "this suite left no new files in tests/ci/fixtures/" \
  || bad "this suite wrote into the repository: $UNTRACKED"
# And nothing under the repository's fixture directory is a leftover of this run.
#
# TWO SHAPES, AND THE FIRST VERSION ONLY CAUGHT ONE. A fixture written back into a
# tracked directory shows as ` M` once the file is committed, but as `??` while it
# is still deleted from the index - and the first version asserted only ` M`, so
# the counterfactual passed the assertion that was supposed to catch it. Found by
# running the counterfactual rather than by reading this block.
#
# The staged deletion of the directory is `D ` and is not this suite's doing, so
# it is the one status that is allowed here.
LEFTOVER="$(git status --porcelain --untracked-files=all -- tests/ci/fixtures 2>/dev/null \
  | grep -v '^D ' || true)"
[ -z "$LEFTOVER" ] && ok "and left nothing behind under tests/ci/fixtures/" \
  || bad "this suite wrote into the repository: $LEFTOVER"
[ ! -d tests/ci/fixtures/mainruns ] \
  && ok "and no fixture set is written into the repository" \
  || bad "tests/ci/fixtures/mainruns/ exists again - fixtures belong in \$WORK"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
