#!/usr/bin/env bash
# The Maven retry policy, tested without Maven.
#
# WHY THIS EXISTS
#
# `retry_on_registry_fault` decides whether a failed `mvn package` is retried or
# returned. It shipped with no test, and it had a defect that only a real CI run
# found: the retry re-ran a command whose failure Maven had cached, so it never
# issued a second request (run 45001045124). A test that counts invocations
# would have caught that in a second; the CI run took 19 minutes.
#
# The policy is extracted precisely so this file can pass it a stub and count.
# Testing through the real Maven would need a controlled registry and would
# measure the network as much as the policy.
#
# Run: bash tests/scripts/build-plugins-retry.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# Source only the function, not the whole build script (which would run it).
eval "$(sed -n '/^retry_on_registry_fault()/,/^}/p' "$ROOT/scripts/build-plugins.sh")"

# A stub that fails N times with a given message, then succeeds. It records each
# invocation so the test can assert how many times the policy actually ran it.
STUB_LOG="$(mktemp)"
stub_reset() { : > "$STUB_LOG"; }
stub() { # STUB_FAILS, STUB_MESSAGE, STUB_RC_ALWAYS
  local n
  n="$(wc -l < "$STUB_LOG" | tr -d ' ')"
  echo "call" >> "$STUB_LOG"
  if [ "${STUB_ALWAYS_FAIL:-0}" = "1" ] || [ "$n" -lt "${STUB_FAILS:-0}" ]; then
    printf '%s\n' "$STUB_MESSAGE"
    return "${STUB_RC:-1}"
  fi
  echo "BUILD SUCCESS"
  return 0
}
trap 'rm -f "$STUB_LOG"' EXIT

# The backoff would make this file take a minute; the policy reads this knob.
export OPSWEAVE_RETRY_SLEEP=0

run_case() { # label, expect_calls, expect_rc
  local label="$1" want_calls="$2" want_rc="$3"
  local rc=0
  retry_on_registry_fault t stub >/dev/null 2>&1 || rc=$?
  local calls
  calls="$(wc -l < "$STUB_LOG" | tr -d ' ')"
  if [ "$calls" = "$want_calls" ] && [ "$rc" = "$want_rc" ]; then
    ok "$label (calls=$calls rc=$rc)"
  else
    bad "$label (calls=$calls want=$want_calls; rc=$rc want=$want_rc)"
  fi
}

echo "retry policy"

# --- what must be retried ---------------------------------------------------
stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] Could not find artifact g:a:pom:1'
run_case 'a permanent "Could not find" is retried 3 times, then fails' 3 1

stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] Could not transfer artifact x, status: 429'
run_case 'a 429 is retried 3 times' 3 1

stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] transfer failed, status: 503'
run_case 'a 503 is retried 3 times' 3 1

stub_reset; STUB_FAILS=1 STUB_MESSAGE='[ERROR] Could not resolve artifact x'
run_case 'a fault that clears on the second attempt succeeds' 2 0

# --- what must NOT be retried -----------------------------------------------
stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] COMPILATION ERROR: cannot find symbol'
run_case 'a compilation error fails on the FIRST attempt' 1 1

stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] Tests run: 3, Failures: 1'
run_case 'a test failure fails on the FIRST attempt' 1 1

stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] The goal you specified requires a project to execute'
run_case 'a usage error fails on the FIRST attempt' 1 1

stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] Non-resolvable parent POM: was not found during a previous attempt'
run_case 'the CACHED-failure message is NOT treated as a registry fault' 1 1

# --- success ------------------------------------------------------------------
stub_reset; STUB_FAILS=0; STUB_ALWAYS_FAIL=0
run_case 'a first-attempt success runs once' 1 0

# --- exit code and output are preserved ---------------------------------------
stub_reset; STUB_ALWAYS_FAIL=1 STUB_RC=42 STUB_MESSAGE='[ERROR] COMPILATION ERROR'
retry_on_registry_fault t stub >/dev/null 2>&1
rc=$?
STUB_ALWAYS_FAIL=0
[ "$rc" = 42 ] && ok 'the command exit code is preserved, not flattened to 1' \
  || bad "exit code became $rc, expected 42"

stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] Could not find artifact detail-token-xyz'
out="$(retry_on_registry_fault t stub 2>&1 || true)"
case "$out" in
  *detail-token-xyz*) ok 'the real error text reaches the caller' ;;
  *) bad 'the error text was lost' ;;
esac

stub_reset; STUB_FAILS=0; STUB_ALWAYS_FAIL=0
out="$(retry_on_registry_fault t stub 2>&1)"
case "$out" in
  *"BUILD SUCCESS"*) ok 'success output is replayed to stdout' ;;
  *) bad "success output was swallowed: [$out]" ;;
esac

# --- streaming output: NOT TESTED HERE, AND WHY ------------------------------
#
# The retry streams its command's output through `tee` so a long Maven build is
# visible while it runs. Whether that actually happens is not something this
# file can assert: a buffered implementation and a streaming one both produce
# the same file when the command finishes, and the difference is a latency a
# shell script cannot observe without racing a clock - a test that did so would
# be the flaky kind this repository keeps removing.
#
# The property was measured by hand instead, and the measurement is in the
# function's comment: a two-second command's first line appeared at +2s under
# the old `out="$(cmd)"` capture and at +0s under `tee`. If that regresses, the
# symptom is an empty CI log during a slow build, which is visible to a reader
# and not to a test.

# --- when the LOG cannot be written, the classification must not lie ----------
#
# The retry decision greps the captured output. If `tee` cannot write it, `grep`
# reads nothing and concludes "not a registry fault" - so a 429 is returned as a
# permanent build error for a reason that has nothing to do with the fault.
#
# Measured with an unwritable log (`/dev/full`): rc=1, grep matched nothing, ZERO
# retries, while the command's own output said `status: 429`.
#
# These cases drive the REAL function with a log directory that cannot be used.

echo
echo "unwritable log"

# A mktemp that always fails, so the first guard is exercised.
mktemp() { return 1; }
export -f mktemp 2>/dev/null || true
stub_reset; STUB_FAILS=99 STUB_MESSAGE='[ERROR] transfer failed, status: 429'
out="$(retry_on_registry_fault t stub 2>&1 || true)"
case "$out" in
  *'NO retry classification'*) ok 'an uncreatable log is REPORTED, not silently unretried' ;;
  *) bad "no report about the unusable log: [$out]" ;;
esac
calls="$(wc -l < "$STUB_LOG" | tr -d ' ')"
[ "$calls" = "1" ] && ok 'the command still ran exactly once (a build must not be refused over a temp file)' \
  || bad "ran $calls time(s), expected 1"
unset -f mktemp

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
