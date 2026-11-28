#!/usr/bin/env bash
# Phase 8 TASK-19: the preflight's own failure modes, driven offline.
#
# The live check needs GitHub and is BLOCKED_AUTH for writes. This drives the
# DECISION half with snapshots and mutated payloads, so the rules that matter are
# asserted without a network and without touching the ruleset.
#
# Usage: bash tests/ci/check-ruleset-preflight.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/check-ruleset-preflight.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 1. offline is honest about what it could not check"
# Offline reads the COMMITTED snapshot rather than skipping the delta check, and
# says the snapshot is dated. A preflight that silently compared against a file
# with no provenance would be worse than one that skipped.
out="$(node "$TOOL" --offline 2>&1)"; rc=$?
printf '%s\n' "$out" | grep -q "read the committed snapshot (captured" \
  && ok "offline reads the committed snapshot and names its capture date" \
  || bad "offline did not read the committed snapshot"
printf '%s\n' "$out" | grep -q "it may have drifted since" \
  && ok "it says the snapshot may have drifted" \
  || bad "it presented a dated snapshot as current"
printf '%s\n' "$out" | grep -q "0 writes - this tool has no write path" \
  && ok "it states that it has no write path" \
  || bad "no statement about writes"

echo "== 1b. with no snapshot at all, offline reports n/e rather than passing"
mv docs/ci/ruleset-live-snapshot.json "$WORK/snap.bak"
out="$(node "$TOOL" --offline 2>&1)"
printf '%s\n' "$out" | grep -q "n/e.*delta check could not run" \
  && ok "no snapshot means NOT_EVALUATED, not a pass" \
  || bad "no snapshot still reported the delta check as done"
mv "$WORK/snap.bak" docs/ci/ruleset-live-snapshot.json

echo "== 2. a live snapshot with a LOST protection is caught"
python3 - "$WORK/lost.json" <<'PY'
import json, sys
d = json.load(open('docs/ci/ruleset-26958761-original-strict.json'))
d['rules'] = [r for r in d['rules'] if r['type'] != 'non_fast_forward']
json.dump(d, open(sys.argv[1], 'w'))
PY
out="$(node "$TOOL" --snapshot "$WORK/lost.json" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "a missing protection fails the preflight (rc=$rc)" \
  || bad "a missing protection still passed"
printf '%s\n' "$out" | grep -q 'LOST "non_fast_forward"' \
  && ok "the failure names the rule that went missing" \
  || bad "the failure did not name the rule"

echo "== 3. an UNEXPECTED extra rule is surfaced, not ignored"
python3 - "$WORK/extra.json" <<'PY'
import json, sys
d = json.load(open('docs/ci/ruleset-26958761-original-strict.json'))
d['rules'].append({"type": "commit_message_pattern", "parameters": {}})
json.dump(d, open(sys.argv[1], 'w'))
PY
out="$(node "$TOOL" --snapshot "$WORK/extra.json" 2>&1)"
printf '%s\n' "$out" | grep -q "rule(s) the payload does not mention: commit_message_pattern" \
  && ok "an unknown rule is reported with its name" \
  || bad "an unknown rule was silently accepted"

echo "== 4. a candidate that CHANGES an existing rule is caught"
# The migration's whole premise is "add checks, change nothing else". A payload
# that also relaxes pull_request is a second, unnoticed change.
cp docs/ci/ruleset-candidate-ten.json "$WORK/cand.bak"
python3 - <<'PY'
import json
p = 'docs/ci/ruleset-candidate-ten.json'
d = json.load(open(p))
for r in d['rules']:
    if r['type'] == 'pull_request':
        r['parameters']['required_approving_review_count'] = 2
json.dump(d, open(p, 'w'), indent=2)
PY
out="$(node "$TOOL" --snapshot docs/ci/ruleset-26958761-original-strict.json 2>&1)"
printf '%s\n' "$out" | grep -q 'CHANGES "pull_request" parameters' \
  && ok "an extra change to pull_request is caught" \
  || bad "a changed pull_request parameter slipped through"
cp "$WORK/cand.bak" docs/ci/ruleset-candidate-ten.json

echo "== 5. the live snapshot passes end to end"
out="$(node "$TOOL" --snapshot docs/ci/ruleset-26958761-original-strict.json 2>&1)"; rc=$?
printf '%s\n' "$out" | grep -q "the rollback payload matches the LIVE state, rule for rule" \
  && ok "the snapshot path exercises the rollback/live comparison" \
  || bad "the rollback comparison did not run against a snapshot"
[ "$rc" -eq 0 ] \
  && ok "the preflight passes against a valid snapshot, including the resolved strict question" \
  || bad "an unexpected failure appeared: $(printf '%s\n' "$out" | grep FAIL | head -2)"

echo "== 6. the strict target is DECLARED and the candidate is checked against it"
# This case used to assert the OPPOSITE: that the preflight reported a
# disagreement between the nine- and ten-context payloads and deferred the
# decision. The decision has since been made (docs/ci/phase10a-ruleset-migration.md):
# the target is candidate-ten with strict=true, and the nine-context payload is
# historical evidence rather than a competing target.
#
# What must still hold is the pair of properties that made the old check worth
# having: the candidate matches the declared target, and the historical payload
# was NOT rewritten to agree with it. The second is the one that rots quietly.
out="$(node "$TOOL" --snapshot docs/ci/ruleset-26958761-original-strict.json 2>&1)"
printf '%s\n' "$out" | grep -q "the candidate matches the declared target on strict" \
  && ok "the candidate is checked against a declared strict target" \
  || bad "the candidate is not checked against a declared target"
printf '%s\n' "$out" | grep -q "the historical nine-context payload still records strict=false, unedited" \
  && ok "the historical payload is asserted unedited, not brought into line" \
  || bad "the historical payload's immutability is not asserted"

echo "== 6b. the strict check BITES when the candidate drifts"
# A check that passes for both values is not a check. This drives the real
# candidate through the real tool with strict flipped, and requires a FAIL.
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
python3 - "$TMPD" <<'PYPAY'
import json,sys,os
d=json.load(open('docs/ci/ruleset-candidate-ten.json'))
for r in d['rules']:
    if r['type']=='required_status_checks':
        r['parameters']['strict_required_status_checks_policy']=False
json.dump(d, open(os.path.join(sys.argv[1],'drifted.json'),'w'), indent=2)
PYPAY
cp docs/ci/ruleset-candidate-ten.json "$TMPD/orig.json"
cp "$TMPD/drifted.json" docs/ci/ruleset-candidate-ten.json
drift="$(node "$TOOL" --snapshot docs/ci/ruleset-26958761-original-strict.json 2>&1)"
cp "$TMPD/orig.json" docs/ci/ruleset-candidate-ten.json
printf '%s\n' "$drift" | grep -q "FAIL the candidate sets strict=false" \
  && ok "a candidate that drifts off the target is refused" \
  || bad "the strict check passed on a drifted candidate"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
