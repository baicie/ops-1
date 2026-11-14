#!/usr/bin/env bash
# Run one acceptance step under a hard timeout and print a machine-readable line.
#
# Why this exists: `data_foundation_ci.sh` runs 47 acceptance scripts inside one
# GitHub Actions step. On the eight runs between 09:43Z and 11:35Z on 2026-11-14
# the job ended with "The hosted runner lost communication with the server", and
# the step list could only say `data_foundation_ci.sh: in_progress`. There was no
# way to tell which script was running, for how long, or whether it was stuck -
# the successful runs spend 16 minutes in that same step and the failing ones
# spent 54, so the interesting question was never "what failed" but "where did it
# stop making progress".
#
# Every invocation prints one line:
#
#   STEP result=PASS name=<name> start=<utc> end=<utc> secs=<n> pid=<n> rc=<n> timeout=<n>
#
# A step that exceeds its budget is reported as `result=TIMEOUT` with a non-zero
# exit, never as a pass, and its whole process group is signalled so a hung child
# cannot outlive the step.
#
# Usage: tests/ci/run_step.sh <name> <timeout-seconds> [--] <command...>
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: run_step.sh <name> <timeout-seconds> <command...>" >&2
  exit 64
fi
name="$1"; budget="$2"; shift 2
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "run_step.sh: no command for $name" >&2; exit 64; }

# Callers write `run_step.sh name 120 -- VAR=1 script.sh`, the same shape they
# used before the wrapper existed. `env` makes those leading assignments real
# environment instead of arguments to `setsid`.
if [ "${1#*=}" != "$1" ] || [ "${1#*[!A-Za-z0-9_]*=}" != "$1" ]; then
  set -- env "$@"
fi

# Names go into a single-line key=value record, so separators would corrupt it.
safe_name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9_.-' '_')"
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
start_ts="$(utc)"
start_s=$SECONDS

# `setsid` gives the step its own process group, which is what makes the timeout
# able to kill grandchildren. Without it a step that spawns a daemon and then
# blocks holds this wrapper forever after its own timeout fires - measured on
# macOS, where `setsid` is absent: the wrapped `( sleep 300 ) & sleep 300` left
# the grandchild alive after the timeout. Linux CI provides `setsid`; when it is
# missing we fall back to walking the descendant tree with `pgrep -P`, and say
# in the output that the group was not used.
if command -v setsid >/dev/null 2>&1; then
  setsid "$@" &
  child=$!
  group_kill=1
else
  "$@" &
  child=$!
  group_kill=0
fi

# Every pid descending from $1, deepest last. Only used on the no-setsid path.
descendants() {
  local parent="$1" kid
  for kid in $(pgrep -P "$parent" 2>/dev/null || true); do
    descendants "$kid"
    printf '%s\n' "$kid"
  done
}

signal_tree() {
  local sig="$1"
  if [ "$group_kill" = "1" ]; then
    kill "$sig" -"$child" 2>/dev/null || true
  else
    # Children first: signalling the parent alone can orphan a daemon that then
    # reparents to init and outlives this wrapper.
    local pid
    for pid in $(descendants "$child"); do kill "$sig" "$pid" 2>/dev/null || true; done
    kill "$sig" "$child" 2>/dev/null || true
  fi
}

deadline=$(( start_s + budget ))
timed_out=0
while kill -0 "$child" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    timed_out=1
    grace="${OPSWEAVE_STEP_KILL_GRACE:-10}"
    signal_tree -TERM
    for _ in $(seq 1 $(( grace * 4 ))); do
      kill -0 "$child" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$child" 2>/dev/null; then
      signal_tree -KILL
    fi
    break
  fi
  sleep 0.5
done
wait "$child" 2>/dev/null
rc=$?

end_ts="$(utc)"
elapsed=$(( SECONDS - start_s ))

if [ "$timed_out" = "1" ]; then
  result=TIMEOUT
  # The old harness had no per-step bound at all, so a hang looked like a slow
  # test. A timeout must never be able to read as success.
  [ "$rc" -eq 0 ] && rc=124
elif [ "$rc" -eq 0 ]; then
  result=PASS
else
  result=FAIL
fi

printf 'STEP result=%s name=%s start=%s end=%s secs=%s pid=%s rc=%s timeout=%s\n' \
  "$result" "$safe_name" "$start_ts" "$end_ts" "$elapsed" "$child" "$rc" "$budget"
if [ "$group_kill" != "1" ]; then
  printf 'STEP NOTE name=%s setsid unavailable: descendants were walked with pgrep -P instead of a process group\n' "$safe_name"
fi
if [ -n "${OPSWEAVE_STEP_LOG:-}" ]; then
  printf 'STEP result=%s name=%s start=%s end=%s secs=%s rc=%s\n' \
    "$result" "$safe_name" "$start_ts" "$end_ts" "$elapsed" "$rc" >>"$OPSWEAVE_STEP_LOG"
fi

exit "$rc"
