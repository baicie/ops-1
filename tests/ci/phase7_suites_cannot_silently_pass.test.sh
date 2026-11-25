#!/usr/bin/env bash
# Phase 8 TASK-29: a suite that cannot run must not report success.
#
# THE DEFECT THIS GUARDS AGAINST, MEASURED
#
# Between 12:35 and 15:52 on 2026-11-23, `plugin-lifecycle.yml` ran five times and
# every run was green:
#
#     45172963410  45183654404  45190236157  45197291594  45203998931
#
# Inside them, two suites printed
#
#     skip no local images to push; TASK-01..06 need a built bundle
#     0 passed, 0 failed, 1 skipped
#
#     skip the data-catalog:0.0.3 image is not local; run scripts/build-plugins.sh first
#     0 passed, 0 failed, 1 skipped
#
# and exited 0. The workflow never built those images: `scripts/build-plugins.sh`
# builds hello-ops/hello-go/hello-java, and the data plugins come from
# `scripts/build-data-plugins.sh`, whose only CI caller is `data-foundation.yml`.
# So two acceptance suites that `docs/engineering/publish-failure-coverage.md`
# cites as INTEGRATION_VERIFIED evidence ran ZERO assertions on every run, and the
# job said SUCCESS.
#
# This is the "spec with no workflow is not a gate" shape one level up: the suite
# HAS a workflow, the workflow HAS a step, and the step still proves nothing. A
# call site is necessary and not sufficient - what matters is whether the call
# reaches an assertion.
#
# WHAT IS CHECKED HERE
#
#   1. When the artifact is missing, `phase7_publish_failures.sh` exits 3 (BLOCKED)
#      and does NOT print a passing summary.
#   2. Same for `phase7_two_node_failure.sh`.
#   3. `--allow-skip` restores the old exit 0, so the escape hatch is real and the
#      tests above are not passing because the scripts always fail.
#   4. The workflow has a step that BUILDS the artifact the suites need, and the
#      two suites' steps run after it. A BLOCKED exit with nothing to unblock it
#      just moves the red.
#
# (4) is checked as a property of the YAML rather than by running CI, because the
# question "does some step produce what the suites consume" has an answer in the
# file. It is the same reasoning `tests/ci/check-impact-consistency.mjs` uses.
#
# Usage: bash tests/ci/phase7_suites_cannot_silently_pass.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# A port nothing listens on. The scripts start their own registry there and have
# no images to push to it, which is exactly the state a fresh CI runner is in.
DEAD_PORT=15998
export OPSWEAVE_P7_REGISTRY_PORT="$DEAD_PORT"

echo "== 1. a missing artifact is BLOCKED, not a pass"
out="$(bash tests/ci/phase7_publish_failures.sh 2>&1)"; rc=$?
[ "$rc" -eq 3 ] && ok "phase7_publish_failures.sh exits 3 when its images are absent" \
  || bad "expected exit 3, got $rc"
printf '%s\n' "$out" | grep -q 'BLOCKED: TASK-01..06 need' \
  && ok "it says BLOCKED and which tasks did not run" \
  || bad "no BLOCKED line naming the tasks"
# The specific lie the old version told: a summary that reads like a result.
if printf '%s\n' "$out" | grep -qE '^[0-9]+ passed, 0 failed'; then
  bad "it still printed a passing summary for a run with no assertions"
else
  ok "no 'N passed, 0 failed' summary for a run that asserted nothing"
fi

echo "== 2. the same for the two-node suite"
out="$(bash tests/ci/phase7_two_node_failure.sh 2>&1)"; rc=$?
[ "$rc" -eq 3 ] && ok "phase7_two_node_failure.sh exits 3 when its image is absent" \
  || bad "expected exit 3, got $rc"
printf '%s\n' "$out" | grep -q 'BLOCKED: the data-catalog:0.0.3 image' \
  && ok "it says BLOCKED and which image is missing" \
  || bad "no BLOCKED line naming the image"

echo "== 3. --allow-skip is a real escape hatch, not a no-op"
# Without this, cases 1 and 2 would pass on a script that always exits 3 - the
# check would be measuring "the script is broken", not "the script distinguishes".
out="$(bash tests/ci/phase7_publish_failures.sh --allow-skip 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "--allow-skip still exits 0 (the distinction is real)" \
  || bad "--allow-skip exited $rc; the BLOCKED cases prove nothing"
printf '%s\n' "$out" | grep -q 'did NOT run' \
  && ok "--allow-skip still says out loud that nothing ran" \
  || bad "--allow-skip passed silently, which is the original defect with a flag"

echo "== 4. the workflow builds what the suites consume, before they consume it"
WF=.github/workflows/plugin-lifecycle.yml
if [ ! -f "$WF" ]; then
  bad "no $WF"
else
  build_line="$(grep -n 'scripts/build-data-plugins.sh' "$WF" | head -1 | cut -d: -f1)"
  pf_line="$(grep -n 'tests/ci/phase7_publish_failures.sh' "$WF" | head -1 | cut -d: -f1)"
  tn_line="$(grep -n 'tests/ci/phase7_two_node_failure.sh' "$WF" | head -1 | cut -d: -f1)"
  [ -n "$build_line" ] && ok "the job runs build-data-plugins.sh (line $build_line)" \
    || bad "the job never builds the data-plugin images its Phase 7 steps need"
  if [ -n "$build_line" ] && [ -n "$pf_line" ] && [ "$build_line" -lt "$pf_line" ]; then
    ok "the build precedes the publish-failure suite ($build_line < $pf_line)"
  else
    bad "the publish-failure suite runs before/without the build ($build_line vs $pf_line)"
  fi
  if [ -n "$build_line" ] && [ -n "$tn_line" ] && [ "$build_line" -lt "$tn_line" ]; then
    ok "the build precedes the two-node suite ($build_line < $tn_line)"
  else
    bad "the two-node suite runs before/without the build ($build_line vs $tn_line)"
  fi
  # TASK-06 needs a SECOND version. Nothing produced it before this change, so the
  # cancellation case has never had a real transition to interrupt.
  grep -q 'data-catalog-0.0.4.plugin.zip' "$WF" \
    && ok "the workflow produces the second version TASK-06 needs" \
    || bad "no 0.0.4 bundle is produced; TASK-06 will skip again"

  # THE SAME RULE APPLIES TO EVERY SUITE ADDED LATER, so it is checked for the
  # TASK-15 file by the same reasoning: it must be called, its log must be kept,
  # and its call must come after the build that gives it an image.
  hb_line="$(grep -n 'tests/ci/phase7_heartbeat_bounds.sh' "$WF" | head -1 | cut -d: -f1)"
  [ -n "$hb_line" ] && ok "the job runs the heartbeat-bounds suite (line $hb_line)" \
    || bad "phase7_heartbeat_bounds.sh is written but nothing runs it"
  if [ -n "$hb_line" ]; then
    grep -q 'phase7-heartbeat-bounds.log' "$WF" \
      && ok "the heartbeat suite's output is uploaded as evidence" \
      || bad "the heartbeat suite's log is not in the evidence artifact"
    if [ -n "$build_line" ] && [ "$build_line" -lt "$hb_line" ]; then
      ok "the build precedes the heartbeat suite ($build_line < $hb_line)"
    else
      bad "the heartbeat suite runs before/without the build ($build_line vs $hb_line)"
    fi
  fi

  # And the same for TASK-25's capacity suite.
  cap_line="$(grep -n 'tests/ci/phase8_capacity_preflight.sh' "$WF" | head -1 | cut -d: -f1)"
  [ -n "$cap_line" ] && ok "the job runs the capacity-preflight suite (line $cap_line)" \
    || bad "phase8_capacity_preflight.sh is written but nothing runs it"
  if [ -n "$cap_line" ]; then
    grep -q 'phase8-capacity-preflight.log' "$WF" \
      && ok "the capacity suite's output is uploaded as evidence" \
      || bad "the capacity suite's log is not in the evidence artifact"
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "$PASS passed, 0 failed"; exit 0; fi
echo "$PASS passed, $FAIL failed"; exit 1
