#!/usr/bin/env bash
# B2.2: the response-body bound is enforced while the body is being read, not
# after it has been buffered.
#
# Before the fix every call site did `response.bytes().await` and compared the
# result against a limit afterwards; the only earlier check was a
# `Content-Length` header, which an untrusted upstream controls. A response with
# no Content-Length was therefore fully materialised before any check ran.
#
# This script asserts the two properties that can be checked cheaply on every
# run, against the shipped code:
#
#   1. no call site in any binary buffers a response before bounding it;
#   2. the shared reader's own suite passes, including the real-socket case where
#      an upstream streams chunked forever and must be cut by SIZE, not by timeout.
#
# It deliberately does not re-implement those tests: a second copy would pass
# while the shipped one drifted.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }

echo "== no call site buffers a response before bounding it"
UNBOUNDED="$(grep -rn '\.bytes()\.await' \
  "$ROOT/apps/kernel/src" "$ROOT/apps/node/src" "$ROOT/apps/pipeline-worker/src" 2>/dev/null \
  | grep -v '^[^:]*:[0-9]*: *//' || true)"
if [ -z "$UNBOUNDED" ]; then
  ok "no response.bytes().await remains in kernel, node or pipeline-worker"
else
  bad "an unbounded read remains:"
  printf '%s\n' "$UNBOUNDED"
fi

echo "== the shared reader's suite, including the endless chunked upstream"
if cargo test -q -p opsweave-http-body-guard --manifest-path "$ROOT/Cargo.toml" >"$WORK/guard.log" 2>&1; then
  ok "opsweave-http-body-guard: $(grep -o '[0-9]* passed' "$WORK/guard.log" | head -1)"
else
  bad "bounded reader suite failed"
  sed -n '1,80p' "$WORK/guard.log"
fi

echo
echo "B2.2 response-bound checks: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
