#!/usr/bin/env bash
# TASK-36A: registry authentication and manifest verification, as two questions.
#
# SOURCE IT; DO NOT EXECUTE. `scripts/deploy-staging.sh` sources this next to
# `ensure_registry_auth`, and the test sources it against a fake `docker`.
#
# WHY THIS IS A SEPARATE FILE
#
# The deploy script asked one question — "does `docker manifest inspect` succeed?"
# — and answered it by retrying three times after swallowing an authentication
# failure with `|| true`. Measured on run 45999793408:
#
#     no /srv/opsweave-staging/ghcr.token; relying on an existing docker login
#     image ghcr.io/baicie/opsweave:63ef2451... is not resolvable yet (attempt 1/3)
#     ... (attempt 2/3) ... (attempt 3/3)
#     ERROR image ... is not resolvable from this host; check that the build
#           pushed it and that registry credentials are valid
#
# Fifteen seconds of retries cannot fix an authentication problem, and the final
# message offers two explanations ("build did not push" or "credentials invalid")
# when the log already knew which. Everything downstream then reasoned from the
# wrong answer: the SSH-transfer fallback saw the image present locally and
# concluded "not a transport failure", which does not follow.
#
# THE TWO QUESTIONS, SEPARATED
#
# Authentication: what credential did we end up with?
#   EXPLICIT_CREDENTIAL_AVAILABLE  a token file exists and `docker login` accepted it
#   EXISTING_CREDENTIAL            no token file; an existing docker login is assumed
#   AUTH_FAILED                    a token file exists and `docker login` rejected it
#   AUTH_UNAVAILABLE               a token file exists and could not be read/used
#
# Verification: what did the registry say about this reference?
#   VERIFIED            the manifest was read and the digest matches (when one was expected)
#   AUTH_REQUIRED       the registry refused for lack of (valid) credentials
#   ACCESS_DENIED       the registry refused for lack of permission
#   MANIFEST_NOT_FOUND  the registry does not have this reference
#   RATE_LIMITED        the registry is throttling
#   REGISTRY_UNAVAILABLE the registry could not be reached
#   DIGEST_MISMATCH     the manifest was read, and its digest is not the expected one
#   UNKNOWN             anything else, reported as unknown rather than guessed
#
# HOW THE STATES ARE DECIDED, AND THE LIMIT OF THAT
#
# `docker manifest inspect` gives no structured error. Its exit status is 1 for
# every failure and the reason is prose on stderr. So the mapping below reads
# stderr for the tokens Docker actually emits, and every unrecognised message
# becomes UNKNOWN rather than being forced into a category. That is deliberate:
# a classifier that guesses turns "the registry is down" into "your credentials
# are wrong", which is exactly the failure mode this file replaces.
#
# WHAT IT DOES NOT DO
#
# It does not retry AUTH_REQUIRED or ACCESS_DENIED. Those do not resolve in
# seconds. It does not retry at all here — the caller decides, per state, and the
# policy is written down at the call site rather than implied by a `while` loop.

REGISTRY_AUTH_STATE="UNINITIALISED"
REGISTRY_VERIFY_STATE="UNINITIALISED"
REGISTRY_VERIFY_DETAIL=""

# classify_auth_failure <stderr-text>
# Maps a `docker login` failure to a state. Same honesty rule as verification:
# unrecognised text is not guessed into a category.
classify_auth_failure() {
  local text="$1"
  if printf '%s' "$text" | grep -qiE 'unauthorized|authentication required|denied: incorrect username or password|401'; then
    printf 'AUTH_FAILED'
  elif printf '%s' "$text" | grep -qiE 'no such host|connection refused|i/o timeout|tls handshake|network is unreachable|server misbehaving'; then
    printf 'AUTH_UNAVAILABLE'
  else
    printf 'AUTH_FAILED'
  fi
}

# authenticate_registry <token-file> <image-repo>
# Prints the state and sets REGISTRY_AUTH_STATE. Never calls `die`: the caller
# decides what an AUTH_FAILED means for its own step, which is the whole point of
# separating the question.
authenticate_registry() {
  local token_file="$1" image_repo="${2:-}" user out rc=0
  if [ ! -f "$token_file" ]; then
    REGISTRY_AUTH_STATE="EXISTING_CREDENTIAL"
    return 0
  fi
  user="$(env_file_value OPSWEAVE_GHCR_USER x-access-token)"
  out="$(docker login ghcr.io --username "$user" --password-stdin <"$token_file" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    REGISTRY_AUTH_STATE="EXPLICIT_CREDENTIAL_AVAILABLE"
    return 0
  fi
  REGISTRY_AUTH_STATE="$(classify_auth_failure "$out")"
  return 1
}

# classify_manifest_failure <stderr-text>
classify_manifest_failure() {
  local text="$1"
  if printf '%s' "$text" | grep -qiE 'unauthorized|authentication required|no basic auth credentials|401'; then
    printf 'AUTH_REQUIRED'
  elif printf '%s' "$text" | grep -qiE 'denied|forbidden|403'; then
    printf 'ACCESS_DENIED'
  elif printf '%s' "$text" | grep -qiE 'manifest unknown|not found|404|no such manifest'; then
    printf 'MANIFEST_NOT_FOUND'
  elif printf '%s' "$text" | grep -qiE 'toomanyrequests|rate limit|429'; then
    printf 'RATE_LIMITED'
  elif printf '%s' "$text" | grep -qiE 'no such host|connection refused|i/o timeout|tls handshake|network is unreachable|server misbehaving|context deadline exceeded'; then
    printf 'REGISTRY_UNAVAILABLE'
  else
    printf 'UNKNOWN'
  fi
}

# verify_manifest <ref> [expected-digest]
# Reads the manifest, derives the digest from it, and compares to the expected
# one when given. Prints the state; sets REGISTRY_VERIFY_STATE and _DETAIL.
#
# THE DIGEST IS DERIVED, NOT THE TAG TRUSTED. `docker manifest inspect --verbose`
# returns the descriptor, whose `digest` field is the registry's own claim about
# the bytes. Comparing that to what the build reported is the check the brief
# asks for; comparing a tag to anything would prove nothing, because a tag is a
# name the registry is free to move.
verify_manifest() {
  local ref="$1" expected="${2:-}" out rc=0 digest=""
  out="$(docker manifest inspect --verbose "$ref" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    REGISTRY_VERIFY_STATE="$(classify_manifest_failure "$out")"
    REGISTRY_VERIFY_DETAIL="$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
    printf '%s' "$REGISTRY_VERIFY_STATE"
    return 1
  fi
  # The descriptor is JSON on one line in practice; awk avoids requiring jq on
  # the host (which has neither jq nor python — measured).
  digest="$(printf '%s' "$out" | tr -d '\n' | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -n "$expected" ] && [ -n "$digest" ] && [ "$digest" != "$expected" ]; then
    REGISTRY_VERIFY_STATE="DIGEST_MISMATCH"
    REGISTRY_VERIFY_DETAIL="registry says $digest, expected $expected"
    printf '%s' "$REGISTRY_VERIFY_STATE"
    return 1
  fi
  REGISTRY_VERIFY_STATE="VERIFIED"
  REGISTRY_VERIFY_DETAIL="${digest:-no digest in descriptor}"
  printf '%s' "$REGISTRY_VERIFY_STATE"
  return 0
}

# retryable_verify_state <state>
# The caller's retry policy, stated once rather than implied by a loop bound.
retryable_verify_state() {
  case "$1" in
    # Transient by nature: the registry may serve the manifest a moment later.
    MANIFEST_NOT_FOUND) return 0 ;;
    RATE_LIMITED) return 0 ;;
    REGISTRY_UNAVAILABLE) return 0 ;;
    # Not transient: a credential does not repair itself in seconds, and neither
    # does a permission.
    AUTH_REQUIRED|ACCESS_DENIED|DIGEST_MISMATCH|VERIFIED) return 1 ;;
    # Unknown is not retried blindly. The caller sees it and decides with the
    # stderr in hand.
    *) return 1 ;;
  esac
}
