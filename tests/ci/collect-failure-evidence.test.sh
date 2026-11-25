#!/usr/bin/env bash
# Phase 8 TASK-22: the evidence collector's two constraints - redaction and size.
#
# The live half needs `gh`. Redaction and the log range are pure functions of the
# input, so they are driven here without a run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/collect-failure-evidence.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

redact() { node "$TOOL" --redact-only; }

echo "== 1. value SHAPES are redacted, not variable names"
out="$(printf 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' | redact)"
printf '%s' "$out" | grep -q '<redacted>' && ok "a bearer token is replaced" || bad "a bearer token survived"
printf '%s' "$out" | grep -q 'ghp_abcdefghij' && bad "the token value leaked" || ok "the token value is gone"

echo "== 2. env-style credentials are redacted whatever they are called"
for name in OPSWEAVE_ENROLLMENT_TOKEN PLUGIN_SECRET AWS_SECRET_ACCESS_KEY DATABASE_PASSWORD; do
  out="$(printf '%s=someverylongvalue123456\n' "$name" | redact)"
  printf '%s' "$out" | grep -q '<redacted>' && ok "$name is redacted" || bad "$name was left in the clear"
done

echo "== 3. a password inside a connection URL is redacted"
out="$(printf 'postgres://pluginuser:supersecretpw123@host:5432/db\n' | redact)"
printf '%s' "$out" | grep -q 'supersecretpw123' && bad "the database password leaked" || ok "the database password is redacted"
printf '%s' "$out" | grep -q 'pluginuser' && ok "the username is kept (it is not a secret)" || bad "the username was over-redacted"

echo "== 4. ordinary log text is NOT mangled"
cat > "$WORK/plain.log" <<'EOF'
  ok   the deployment activated
  FAIL deploy did not activate; see 01-deploy.log
verdict: FAIL
EOF
out="$(redact < "$WORK/plain.log")"
printf '%s' "$out" | grep -q 'FAIL deploy did not activate' && ok "a FAIL line survives intact" || bad "an ordinary line was mangled"
printf '%s' "$out" | grep -q 'the deployment activated' && ok "a passing assertion survives intact" || bad "an 'ok' line was mangled"

echo "== 5. the notice says what is NOT covered, rather than implying completeness"
node "$TOOL" --from-json tests/ci/fixtures/failed-run-45419909269.json --json 2>/dev/null > "$WORK/ev.json"
python3 - "$WORK/ev.json" <<'PY' && ok "the artifact carries a redaction notice naming its own limit" || bad "no redaction notice"
import json,sys
d=json.load(open(sys.argv[1]))
n=d["redactionNotice"]
assert "NOT redacted" in n, n
PY

echo "== 6. the artifact carries every field the brief names"
python3 - "$WORK/ev.json" <<'PY' && ok "run id, attempt, job id, head sha, failed step, classification, retried" || bad "a required field is missing"
import json,sys
d=json.load(open(sys.argv[1]))
r=d["run"]
assert r["id"] and r["attempt"] is not None, r
assert r["headSha"], r
assert isinstance(r["isRetry"], bool), r
assert d["failedJobs"], "no failed job recorded"
j=d["failedJobs"][0]
assert j["id"], j
assert any(s["name"] for s in j["failedSteps"]), j
assert d["classification"]["verdict"], d["classification"]
assert d["log"]["excerpt"], "no log excerpt"
PY

echo "== 7. the log excerpt is BOUNDED and says when it truncated"
python3 - "$WORK/ev.json" <<'PY' && ok "the excerpt is bounded and reports truncation honestly" || bad "the excerpt is unbounded or hides truncation"
import json,sys,os
d=json.load(open(sys.argv[1]))
size=len(d["log"]["excerpt"].encode())
assert size <= 512*1024+64, size
assert "truncated" in d["log"], d["log"].keys()
assert d["log"]["excerptTo"] >= d["log"]["excerptFrom"], d["log"]
PY

echo "== 8. the last passing assertion is confined to the FAILING step"
# The first version searched the whole log backwards and returned a PASS from a
# different plugin's matrix row, which reads as "that plugin was fine" at the
# moment the reader asks about a different suite.
python3 - "$WORK/ev.json" <<'PY' && ok "a last-passing assertion, if present, comes from the failing step's prefix" || bad "the last passing assertion came from another step"
import json,sys
d=json.load(open(sys.argv[1]))
lp=d.get("lastPassingAssertion")
if lp is None:
    raise SystemExit(0)  # none found within the failing step: honest
fail_line=[e["line"] for e in d["classification"].get("evidence",[])][0]
want="\t".join(fail_line.split("\t")[:2])
got="\t".join(lp.split("\t")[:2])
assert got==want, f"last pass is from {got!r}, failure is in {want!r}"
PY

echo "== 9. a fixture with no run is an error, not an empty artifact"
printf '{}' > "$WORK/empty.json"
node "$TOOL" --from-json "$WORK/empty.json" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "a fixture without run.id exits non-zero (rc=$rc)" || bad "an empty fixture produced an artifact"

echo "== 10. THE SELF-TEST NEEDS NO NETWORK"
# It used to call --run against a live run, which is green where `gh` has
# credentials and red on a CI runner - five assertions failed on PR #218 for that
# reason alone. Every case above now reads a committed fixture.
grep -q -- '--from-json' "$0" && ! grep -qE -- '--run [0-9]{6,}' "$0" \
  && ok "every live lookup in this file was replaced by a fixture" \
  || bad "this self-test still calls the live API"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
