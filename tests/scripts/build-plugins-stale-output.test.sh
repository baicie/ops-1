#!/usr/bin/env bash
# A failed build must not leave the PREVIOUS build's bundles behind.
#
# WHY THIS EXISTS
#
# `dist/plugins` is read by `tests/contract/validate_contracts.py`,
# `tests/contract/test_bundle_validation.py` and `p001c13_negatives.sh`. None of
# them can tell this run's output from last week's. `rm -rf dist/plugins` used to
# run at the `== signed bundles` stage - after the web builds, six OCI images and
# the jlink JRE - so a failure before that point left the previous signed zips in
# place, and the contract checks would examine an older artifact as if it were the
# one just built.
#
# This test drives the ORDERING, not the build: building six images needs Docker,
# a registry and minutes, while the property under test - "the directory is cleared
# before any work that can fail" - is a property of the script's text and can be
# checked without running it.
#
# Run: bash tests/scripts/build-plugins-stale-output.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/build-plugins.sh"
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# A COMMENT IS NOT CODE. The script explains this ordering in prose, and that prose
# mentions `rm -rf dist/plugins` and `== signed bundles` - so a naive grep finds the
# explanation instead of the statement, and the first version of this test reported
# "the clear is at line 50" while pointing at a comment.
line_of() {
  # awk, not grep -v: the filter has to look at the CONTENT after the line number,
  # and chaining two greps made that hard to see and easy to get wrong.
  awk -v pat="$1" 'index($0, pat) && $0 !~ /^[[:space:]]*#/ { print NR; exit }' "$SCRIPT"
}

CLEAR="$(line_of 'rm -rf dist/plugins')"
if [ -z "$CLEAR" ]; then
  bad 'the script no longer clears dist/plugins at all'
else
  ok "dist/plugins is cleared at line $CLEAR"
fi

# Every stage that can fail before the signing section. The clear must come first.
for marker in '== web assets' '== TypeScript OCI images' '== Go OCI image' '== Java OCI image'; do
  at="$(line_of "$marker")"
  if [ -z "$at" ]; then
    bad "stage marker not found: $marker (the script changed; update this test)"
  elif [ -n "$CLEAR" ] && [ "$CLEAR" -lt "$at" ]; then
    ok "the clear ($CLEAR) precedes $marker ($at)"
  else
    bad "the clear ($CLEAR) comes AFTER $marker ($at): a failure there leaves stale bundles"
  fi
done

# And the signed-bundles section must NOT be the first place it happens.
SIGNED="$(line_of '== signed bundles')"
if [ -n "$CLEAR" ] && [ -n "$SIGNED" ] && [ "$CLEAR" -lt "$SIGNED" ]; then
  ok "the clear is not deferred to the signing stage"
else
  bad "dist/plugins is still first cleared at the signing stage ($SIGNED)"
fi

# A second clear inside the signing section would delete what the clear above
# created and re-create it; harmless, but it hides which line is load-bearing.
COUNT="$(grep -v '^\s*#' "$SCRIPT" | grep -c 'rm -rf .*dist/plugins' || true)"
[ "$COUNT" = "1" ] && ok 'exactly one place clears dist/plugins' \
  || bad "$COUNT places clear dist/plugins; the load-bearing one is no longer obvious"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
