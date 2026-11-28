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

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
