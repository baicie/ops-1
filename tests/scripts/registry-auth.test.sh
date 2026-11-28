#!/usr/bin/env bash
# TASK-36A: the registry states, driven against a fake `docker`.
#
# Every case sources `scripts/lib/registry-auth.sh` — the PRODUCTION file — and
# puts a fake `docker` on PATH. Nothing here re-implements a classifier, because
# a test with its own copy of the mapping has no counterfactual: it would keep
# passing while the deploy script's copy drifted.
#
# The cases come from the brief's list, plus the two measured on run 45999793408:
# a missing token file with a working existing login, and a missing token file
# with a broken one.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A fake docker whose behaviour each case sets with environment variables.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$1 $2" in
  "login ghcr.io")
    # consume stdin so the password never leaks into an argument
    cat >/dev/null
    if [ "${FAKE_LOGIN_RC:-0}" != "0" ]; then
      printf '%s\n' "${FAKE_LOGIN_ERR:-unauthorized}" >&2
      exit "${FAKE_LOGIN_RC}"
    fi
    exit 0 ;;
  "manifest inspect")
    if [ "${FAKE_MANIFEST_RC:-0}" != "0" ]; then
      printf '%s\n' "${FAKE_MANIFEST_ERR:-manifest unknown}" >&2
      exit "${FAKE_MANIFEST_RC}"
    fi
    printf '{"Ref":"%s","Descriptor":{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":1234}}\n' \
      "${3:-}" "${FAKE_MANIFEST_DIGEST:-sha256:aaa}"
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"

# `env_file_value` lives in the deploy script; the production lib calls it.
env_file_value() { printf 'x-access-token'; }
export -f env_file_value

# shellcheck source=../../scripts/lib/registry-auth.sh
. scripts/lib/registry-auth.sh

TOKEN="$WORK/ghcr.token"

echo "== 1. no token file, existing login is assumed — NOT a failure"
rm -f "$TOKEN"
authenticate_registry "$TOKEN" ghcr.io/baicie/opsweave; rc=$?
[ "$rc" -eq 0 ] && [ "$REGISTRY_AUTH_STATE" = "EXISTING_CREDENTIAL" ] \
  && ok "EXISTING_CREDENTIAL, and it does not fail the step" \
  || bad "got $REGISTRY_AUTH_STATE rc=$rc"

echo "== 2. token file present and accepted"
printf 'tok\n' > "$TOKEN"
FAKE_LOGIN_RC=0 authenticate_registry "$TOKEN" ghcr.io/baicie/opsweave; rc=$?
[ "$rc" -eq 0 ] && [ "$REGISTRY_AUTH_STATE" = "EXPLICIT_CREDENTIAL_AVAILABLE" ] \
  && ok "EXPLICIT_CREDENTIAL_AVAILABLE" || bad "got $REGISTRY_AUTH_STATE"

echo "== 3. token file present but EXPIRED — a real failure, named"
FAKE_LOGIN_RC=1 FAKE_LOGIN_ERR='Error response from daemon: Get "https://ghcr.io/v2/": unauthorized: authentication required' \
  authenticate_registry "$TOKEN" ghcr.io/baicie/opsweave; rc=$?
[ "$rc" -ne 0 ] && [ "$REGISTRY_AUTH_STATE" = "AUTH_FAILED" ] \
  && ok "AUTH_FAILED" || bad "got $REGISTRY_AUTH_STATE rc=$rc"

echo "== 4. token file present, registry unreachable — a DIFFERENT failure"
FAKE_LOGIN_RC=1 FAKE_LOGIN_ERR='Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host' \
  authenticate_registry "$TOKEN" ghcr.io/baicie/opsweave; rc=$?
[ "$REGISTRY_AUTH_STATE" = "AUTH_UNAVAILABLE" ] \
  && ok "AUTH_UNAVAILABLE, distinguishable from AUTH_FAILED" \
  || bad "got $REGISTRY_AUTH_STATE"

echo "== 5. the manifest reads, and the digest is compared to the expected one"
FAKE_MANIFEST_DIGEST='sha256:good' verify_manifest 'ghcr.io/x:y' 'sha256:good' >/dev/null; rc=$?
[ "$rc" -eq 0 ] && [ "$REGISTRY_VERIFY_STATE" = "VERIFIED" ] && ok "VERIFIED" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 6. the manifest reads but the digest is WRONG — the case a tag cannot catch"
FAKE_MANIFEST_DIGEST='sha256:other' verify_manifest 'ghcr.io/x:y' 'sha256:good' >/dev/null; rc=$?
[ "$rc" -ne 0 ] && [ "$REGISTRY_VERIFY_STATE" = "DIGEST_MISMATCH" ] \
  && ok "DIGEST_MISMATCH" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 7. manifest 404"
FAKE_MANIFEST_RC=1 FAKE_MANIFEST_ERR='no such manifest: ghcr.io/x:y' verify_manifest 'ghcr.io/x:y' >/dev/null
[ "$REGISTRY_VERIFY_STATE" = "MANIFEST_NOT_FOUND" ] && ok "MANIFEST_NOT_FOUND" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 8. manifest 429"
FAKE_MANIFEST_RC=1 FAKE_MANIFEST_ERR='toomanyrequests: You have reached your pull rate limit.' verify_manifest 'ghcr.io/x:y' >/dev/null
[ "$REGISTRY_VERIFY_STATE" = "RATE_LIMITED" ] && ok "RATE_LIMITED" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 9. registry unreachable"
FAKE_MANIFEST_RC=1 FAKE_MANIFEST_ERR='Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host' verify_manifest 'ghcr.io/x:y' >/dev/null
[ "$REGISTRY_VERIFY_STATE" = "REGISTRY_UNAVAILABLE" ] && ok "REGISTRY_UNAVAILABLE" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 10. 401 is AUTH_REQUIRED, not MANIFEST_NOT_FOUND"
# THE MEASURED FAILURE. With no token file and no working login, the registry
# answers 401 and the old code retried three times and then blamed the build.
FAKE_MANIFEST_RC=1 FAKE_MANIFEST_ERR='Error response from daemon: Get "https://ghcr.io/v2/baicie/opsweave/manifests/63ef2451": unauthorized' \
  verify_manifest 'ghcr.io/x:y' >/dev/null
[ "$REGISTRY_VERIFY_STATE" = "AUTH_REQUIRED" ] && ok "AUTH_REQUIRED" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 11. 403 is ACCESS_DENIED"
FAKE_MANIFEST_RC=1 FAKE_MANIFEST_ERR='denied: requested access to the resource is forbidden' verify_manifest 'ghcr.io/x:y' >/dev/null
[ "$REGISTRY_VERIFY_STATE" = "ACCESS_DENIED" ] && ok "ACCESS_DENIED" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 12. an unrecognised error is UNKNOWN, never guessed into a category"
# THE PROPERTY THAT MATTERS MOST. A classifier that forces every message into a
# bucket turns "the registry changed its error text" into a confident wrong answer.
FAKE_MANIFEST_RC=1 FAKE_MANIFEST_ERR='something nobody has seen before' verify_manifest 'ghcr.io/x:y' >/dev/null
[ "$REGISTRY_VERIFY_STATE" = "UNKNOWN" ] && ok "UNKNOWN" || bad "got $REGISTRY_VERIFY_STATE"

echo "== 13. the retry policy: transient states retry, credential states do not"
retryable_verify_state MANIFEST_NOT_FOUND && ok "MANIFEST_NOT_FOUND retries" || bad "404 should retry (the push may be in flight)"
retryable_verify_state RATE_LIMITED && ok "RATE_LIMITED retries" || bad "429 should retry"
retryable_verify_state REGISTRY_UNAVAILABLE && ok "REGISTRY_UNAVAILABLE retries" || bad "a transport failure should retry"
retryable_verify_state AUTH_REQUIRED && bad "AUTH_REQUIRED must NOT be retried" || ok "AUTH_REQUIRED does not retry"
retryable_verify_state ACCESS_DENIED && bad "ACCESS_DENIED must NOT be retried" || ok "ACCESS_DENIED does not retry"
retryable_verify_state DIGEST_MISMATCH && bad "DIGEST_MISMATCH must NOT be retried" || ok "DIGEST_MISMATCH does not retry"
retryable_verify_state UNKNOWN && bad "UNKNOWN must not be retried blindly" || ok "UNKNOWN does not retry blindly"

echo "== 14. the deploy script USES this, rather than keeping its own copy"
# A module nothing calls is the defect this repository has shipped repeatedly.
# The source line is a COMPUTED path (`dirname "$_DEPLOY_SRC"/lib/...`), so the
# assertion is on `lib/registry-auth.sh` and on the sourcing operator, not on the
# literal string the first version of this check looked for.
grep -qE '^\. .*lib/registry-auth\.sh' scripts/deploy-staging.sh \
  && ok "deploy-staging.sh sources the module" \
  || bad "deploy-staging.sh does not source scripts/lib/registry-auth.sh"
# And the swallowing that hid the auth failure is gone: no `ensure_registry_auth
# || true` anywhere in CODE. COMMENTS ARE NOT CODE — the deploy script quotes the
# old line in the comment explaining why it was removed, and the first version of
# this check matched that quotation and reported a defect that was not there.
# (Same shape as `verify-main.mjs`'s `includes('paths:')`, which read a sentence.)
# CAPTURE FIRST, THEN TEST. `grep -v ... | grep -q ...` under `set -o pipefail`
# is WRONG and it failed silently: `grep -q` exits at the first match, the
# upstream `grep -v` takes SIGPIPE (141), and pipefail makes the PIPELINE status
# 141 — which is non-zero, so the `&&` never fires and the check reports OK while
# the code it looks for is present. Measured: the counterfactual (putting the
# swallow back) stayed green. A check that cannot fail is worse than no check.
DEPLOY_CODE="$(grep -vE '^[[:space:]]*#' scripts/deploy-staging.sh || true)"
if printf '%s\n' "$DEPLOY_CODE" | grep -qE 'ensure_registry_auth[[:space:]]*\|\|[[:space:]]*true'; then
  bad "the swallowed auth failure is still there"
else
  ok "the '|| true' that hid the auth failure is gone from the code"
fi
# The old single-question function must not survive beside the new pair: two
# implementations is how the deploy script and the test drift apart.
grep -qE '^ensure_registry_auth\(\)' scripts/deploy-staging.sh \
  && bad "ensure_registry_auth still exists; there are now two implementations" \
  || ok "the old ensure_registry_auth is gone, not duplicated"

echo "== 15. the credential never reaches an argument or a log"
# `docker login --password-stdin` is the only form here. A `-p <token>` would put
# the token in the process table, and every `docker` invocation is visible to
# `ps`. The pattern must exclude `--password-stdin`, which CONTAINS `-p` — the
# first version of this check matched it and reported a defect that was not
# there, which is the same shape as a classifier that guesses.
if grep -qE -- 'docker login[^|]*(^|[[:space:]])-p[[:space:]]' scripts/lib/registry-auth.sh scripts/deploy-staging.sh; then
  bad "a token is passed as an argument"
else
  ok "no token is passed as an argument"
fi
grep -q 'password-stdin' scripts/lib/registry-auth.sh \
  && ok "the token arrives on stdin" || bad "the token does not arrive on stdin"

echo "== 15b. the PULL-FAILURE path reports the classified state, not a blank reason"
# MEASURED ON RUN 46133348247. The host pull was denied:
#
#     pre-warm authentication: EXISTING_CREDENTIAL
#     Error response from daemon: error from registry: denied
#     ERROR cannot obtain ghcr.io/...: nothing on this host was changed
#
# The classification existed but `check_image_available` runs AFTER `prewarm_image`,
# so on the one path that actually fails it was never reached and the operator was
# told neither what failed nor that it was a permission problem.
#
# This asserts the code path, because the behaviour needs a registry to exercise:
# the pull-failure branch must CALL verify_manifest before dying, and must name
# the state in its message.
PULLFAIL="$(sed -n '/if pull_image "\$sha"; then/,/^}/p' scripts/deploy-staging.sh)"
printf '%s' "$PULLFAIL" | grep -q 'verify_manifest' \
  && ok "the pull-failure path classifies before dying" \
  || bad "the pull-failure path dies without classifying - the state machine is unreachable here"
for st in AUTH_REQUIRED ACCESS_DENIED RATE_LIMITED REGISTRY_UNAVAILABLE; do
  printf '%s' "$PULLFAIL" | grep -q "$st)" \
    && ok "it names $st in its own message" \
    || bad "the $st case has no message of its own"
done
# And an unrecognised failure must NOT be folded into a named bucket.
printf '%s' "$PULLFAIL" | grep -qF 'REGISTRY_VERIFY_STATE' \
  && ok "an unrecognised failure reports the raw state, not a guessed category" \
  || bad "an unrecognised failure is being forced into a category"
# EXISTING_CREDENTIAL must not be logged as if it were a success.
grep -q 'unverified until the registry answers' scripts/deploy-staging.sh \
  && ok "EXISTING_CREDENTIAL is logged as unverified, not as 'authentication ok'" \
  || bad "EXISTING_CREDENTIAL reads as a success in the log"

echo "== 15c. TASK-36B: only IMAGE_TRANSPORT may trigger the SSH transfer"
# THE DEFECT MEASURED ON RUN 46143147549. The registry answered `denied: denied`
# — a permission problem — the deploy step failed, and the fallback spent its full
# 900 s transferring an image whose identity could never be established.
#
# The host script exits 1 for every failure, so the exit code cannot answer "which
# phase". It now writes a typed record, and the workflow gates on it.
#
# `fallback_allowed` is the PRODUCTION function, extracted rather than copied: a
# test with its own copy of the switch has no counterfactual. Extract the function
# definition and evaluate it, so the shipped code is what is exercised.
eval "$(sed -n '/^fallback_allowed() {/,/^}/p' scripts/deploy-staging.sh)"
command -v fallback_allowed >/dev/null \
  || bad "fallback_allowed could not be extracted from deploy-staging.sh"
for phase in PLUGIN_PUBLISH RELEASE_IDENTITY COMPOSE_UPDATE HEALTH_VERIFICATION HOST_PREPARATION UNKNOWN ""; do
  got="$(fallback_allowed "$phase")"
  [ "$got" = "false" ] && ok "fallback refused for ${phase:-<empty>}" \
    || bad "fallback ALLOWED for ${phase:-<empty>} - a transfer cannot fix that"
done
[ "$(fallback_allowed IMAGE_TRANSPORT)" = "true" ] \
  && ok "fallback allowed for IMAGE_TRANSPORT, the one case bytes can fix" \
  || bad "IMAGE_TRANSPORT is not fallback-allowed; the recoverable case would be refused"

echo "== 15d. every die in the deploy script records a phase"
# A die with no phase is UNKNOWN, which is not fallback-allowed - but a phase that
# is never SET at a real failure site means the record says UNKNOWN for a failure
# whose phase is knowable, and the operator loses the reason.
NO_PHASE="$(grep -cE '^[[:space:]]*die [0-9]+ ' scripts/deploy-staging.sh)"
WITH_PHASE="$(grep -c 'set_failure_phase' scripts/deploy-staging.sh)"
# -1 for the function definition itself and -1 for the comment line above it
[ "$WITH_PHASE" -ge 20 ] \
  && ok "$WITH_PHASE phase markers across $NO_PHASE die call sites" \
  || bad "only $WITH_PHASE phase markers for $NO_PHASE die sites; most failures would record UNKNOWN"
grep -q 'record_failure' scripts/deploy-staging.sh \
  && ok "die() writes the record" || bad "die() does not write a failure record"

echo "== 15e. the workflow reads the phase from the HOST, and gates before transferring"
FB="$(sed -n '/- name: Hand the image over SSH/,/docker save/p' .github/workflows/staging-preview.yml)"
printf '%s' "$FB" | grep -q 'fallback_allowed' \
  && ok "the fallback step reads the host's decision" \
  || bad "the fallback does not consult fallback_allowed"
# And it does so BEFORE any transfer work, or the gate is decorative.
gate_line=$(printf '%s' "$FB" | grep -n 'ALLOWED' | head -1 | cut -d: -f1)
save_line=$(printf '%s' "$FB" | grep -n 'docker save' | head -1 | cut -d: -f1)
if [ -n "$gate_line" ] && [ -n "$save_line" ] && [ "$gate_line" -lt "$save_line" ]; then
  ok "the gate runs before the transfer (line $gate_line < $save_line)"
else
  bad "the gate is after the transfer, or absent (gate=$gate_line save=$save_line)"
fi
# The old invalid inference must be gone.
grep -q 'the host already holds' .github/workflows/staging-preview.yml \
  && bad "the 'host holds the image therefore not transport' inference is still there" \
  || ok "the invalid inference is gone"

echo "== 15f. a die with no phase for THIS failure does not inherit an older one"
# MEASURED ON RUN 46152094215, on the real host. The pull was denied — a
# RELEASE_IDENTITY failure — and the ACCESS_DENIED arm had no phase line of its
# own, so the record said HOST_PREPARATION: left over from a preflight check that
# had PASSED. The gate still refused the transfer, because both phases are `false`,
# so it refused for the wrong reason and told the operator the host was unprepared
# when it was not.
#
# The fix is structural: `set_failure_phase` records that a phase was set for THIS
# failure, and `die` refuses to use a phase that was not. This drives the real
# functions, extracted from the script.
# Both functions, plus the reset variable. Extracted rather than copied: a test
# carrying its own copy of the switch has no counterfactual.
#
# EXTRACTED TO A FILE, then sourced. `eval "$(sed ...)"` looks equivalent and is
# not: the sed patterns contain quotes that Bash re-parses before sed sees them, so
# the extraction silently produced nothing and the test measured an undefined
# function's absence as "the stale phase survived". A test that fails for a reason
# in the test is as bad as one that passes for a reason in the test.
PHASE_FNS="$WORK/phase-fns.sh"
{
  sed -n '/^FAILURE_PHASE_SET=""/p' scripts/deploy-staging.sh
  sed -n '/^set_failure_phase() {/,/^}/p' scripts/deploy-staging.sh
  sed -n '/^assert_phase_was_set() {/,/^}/p' scripts/deploy-staging.sh
} > "$PHASE_FNS"
# shellcheck source=/dev/null
. "$PHASE_FNS"
command -v set_failure_phase >/dev/null && command -v assert_phase_was_set >/dev/null \
  || bad "the phase functions could not be extracted from deploy-staging.sh"
iso_now() { printf 'test'; }

FAILURE_PHASE="HOST_PREPARATION"; FAILURE_PHASE_SET=""
# NOT `out="$(assert_phase_was_set ...)"`. A command substitution runs in a
# SUBSHELL, so the function's assignments to FAILURE_PHASE never reach this shell
# and the assertion below reads the value it set a line earlier. The first version
# of this case did exactly that and reported the fix as broken. Redirect to a file
# instead, which keeps the call in this shell.
ERRFILE="$WORK/phase-err.txt"
assert_phase_was_set "a message" 2>"$ERRFILE"
[ "$FAILURE_PHASE" = "UNKNOWN" ] \
  && ok "a stale phase is discarded and recorded as UNKNOWN" \
  || bad "a stale phase survived: got $FAILURE_PHASE"
grep -q 'no set_failure_phase' "$ERRFILE" \
  && ok "and it says why, as an internal warning" \
  || bad "the stale phase was discarded silently"

# And a phase set for this failure IS used.
FAILURE_PHASE_SET=""; set_failure_phase RELEASE_IDENTITY "denied"
assert_phase_was_set "a message" 2>/dev/null
[ "$FAILURE_PHASE" = "RELEASE_IDENTITY" ] \
  && ok "a phase set for this failure is kept" || bad "got $FAILURE_PHASE"

# Every die needs its phase on the immediately preceding line, or it inherits.
GAPS=0
for n in $(grep -n '^[[:space:]]*die [0-9]' scripts/deploy-staging.sh | cut -d: -f1); do
  sed -n "$((n-1))p" scripts/deploy-staging.sh | grep -q 'set_failure_phase' || GAPS=$((GAPS+1))
done
[ "$GAPS" -eq 0 ] \
  && ok "every die has its phase set on the line before it" \
  || bad "$GAPS die call(s) inherit a phase from wherever the variable last was"

# The assertion must be WIRED INTO die, not merely correct beside it.
#
# The first version of the case above called assert_phase_was_set directly, so
# deleting the call from `die` left the whole suite green — it tested the function
# and not the wiring, which is the "shipped but not connected" shape this repo
# records by name. This drives `die` itself, in a subshell, and checks the record
# it would have written.
DIE_RECORD="$WORK/die-record.json"
(
  FAILURE_FILE="$DIE_RECORD"
  FAILURE_PHASE="HOST_PREPARATION"   # a leftover, as on the real host
  FAILURE_PHASE_SET=""
  append_log() { :; }
  record_failure() { printf '{"phase":"%s"}\n' "$FAILURE_PHASE" > "$FAILURE_FILE"; }
  eval "$(sed -n '/^die() {/,/^}/p' scripts/deploy-staging.sh | sed 's/^  record_failure$/  record_failure/')"
  die 1 "denied"
) >/dev/null 2>&1
if grep -q '"phase":"UNKNOWN"' "$DIE_RECORD" 2>/dev/null; then
  ok "die itself records UNKNOWN when no phase was set for this failure"
else
  bad "die did not go through assert_phase_was_set: $(cat "$DIE_RECORD" 2>/dev/null || echo 'no record')"
fi

echo "== 16. every file the deploy script SOURCES is also SHIPPED to the host"
# THE DEFECT THIS CATCHES, and it was live for one commit: the deploy script began
# sourcing `lib/registry-auth.sh` while `staging-preview.yml` still scp'd only
# `deploy-staging.sh`. On a host with a working deploy the script would abort at
# the `source` line — a breakage that appears only in the real environment.
#
# The test does not hard-code the module name. It reads the source lines from the
# script and asserts each one appears in the workflow's transfer step, so a second
# module added later is covered without anyone remembering to update this file.
SOURCED="$(grep -oE '\. .*lib/[a-z-]+\.sh' scripts/deploy-staging.sh | sed -E 's#.*/(lib/[a-z-]+\.sh).*#\1#' | sort -u)"
[ -n "$SOURCED" ] && ok "the deploy script sources: $(printf '%s' "$SOURCED" | tr '\n' ' ')" \
  || bad "no sourced module found; this test no longer checks anything"
# COMMENTS ARE NOT TRANSFERS. The first version of this check searched the
# surrounding region for the module's name — and the region contained the comment
# explaining WHY the module is shipped, so removing the `scp` line still matched.
# The counterfactual stayed green. What is asserted now is the TRANSFER ITSELF:
# a line that actually copies or installs the file.
for mod in $SOURCED; do
  scp_line="$(grep -E "scp .*${mod}" .github/workflows/staging-preview.yml | grep -v '^[[:space:]]*#' || true)"
  install_line="$(grep -E "install .*/${mod#lib/}" .github/workflows/staging-preview.yml | grep -v '^[[:space:]]*#' || true)"
  if [ -n "$scp_line" ] && [ -n "$install_line" ]; then
    ok "$mod is copied to the host and installed there"
  else
    bad "$mod is SOURCED by deploy-staging.sh but not transferred (scp: ${scp_line:-MISSING}; install: ${install_line:-MISSING}) — the host would abort at the source line"
  fi
done

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
