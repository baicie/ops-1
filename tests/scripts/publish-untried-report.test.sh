#!/usr/bin/env bash
# A failed publish must say which plugins it never reached.
#
# WHY THIS EXISTS
#
# `set -e` stops the per-plugin loop at the first failure, and that is the right
# call: publishing the rest after one plugin failed produces a half-upgraded
# platform. What it does NOT do is tell anyone the later plugins were never
# attempted. Measured with three plugins and a failure on the second: the third
# never runs and the output says nothing about it, so "the publish failed" reads as
# "this plugin failed".
#
# The check is the EXIT trap's report. This file drives the SAME logic against a
# stub so it can run without a kernel, a registry or a plugin image.
#
# Run: bash tests/scripts/publish-untried-report.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# The real script must contain the report, or this file is testing a fiction.
if grep -q 'the run stopped before it reached' "$ROOT/scripts/publish-data-plugins.sh"; then
  ok 'the publish script carries the untried-plugin report'
else
  bad 'the publish script has no untried-plugin report; this test would pass against nothing'
fi

# Drive the logic the script uses. Kept as a copy of the CONDITION, not the whole
# trap: the trap also does cleanup against docker, which a test must not touch.
run_case() { # label, plugins..., -- , failing index
  local label="$1"; shift
  local -a list=()
  while [ "$1" != "--" ]; do list+=("$1"); shift; done
  shift
  local failing="$1"
  local -a attempted=()
  local rc=0
  for name in "${list[@]}"; do
    attempted+=("$name")
    [ "$name" = "$failing" ] && { rc=1; break; }
  done
  local -a untried=()
  if [ "$rc" -ne 0 ] && [ "${#attempted[@]}" -lt "${#list[@]}" ]; then
    for candidate in "${list[@]}"; do
      if [[ ! " ${attempted[*]} " =~ " ${candidate} " ]]; then untried+=("$candidate"); fi
    done
  fi
  printf '%s' "${untried[*]:-}"
}

out="$(run_case 'second of three fails' a b c -- b)"
[ "$out" = "c" ] && ok "a failure on the second names the third: [$out]" \
  || bad "expected [c], got [$out]"

out="$(run_case 'first of three fails' a b c -- a)"
[ "$out" = "b c" ] && ok "a failure on the first names the rest: [$out]" \
  || bad "expected [b c], got [$out]"

out="$(run_case 'last fails' a b c -- c)"
[ "$out" = "" ] && ok "a failure on the last names nothing, correctly: [$out]" \
  || bad "expected empty, got [$out]"

out="$(run_case 'all succeed' a b c -- __none__)"
[ "$out" = "" ] && ok 'a successful run reports nothing' || bad "expected empty, got [$out]"

# A single plugin that fails is the whole list, so nothing is untried.
out="$(run_case 'only plugin fails' solo -- solo)"
[ "$out" = "" ] && ok 'a one-plugin failure has nothing untried' || bad "expected empty, got [$out]"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
