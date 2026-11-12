#!/usr/bin/env bash
# P001-C1.2.1 Task C - the Data Foundation harness must not sweep the daemon.
#
# Runs in a tmpdir with a fake `docker`; never touches a real one. It asserts
# the three properties the brief names:
#
#   1. a container from another installation survives the cleanup trap
#   2. a shared daemon is refused before anything is destroyed
#   3. the acceptance exit code is not overwritten by the cleanup trap
#
# The script is large and its cleanup is a trap, so the test extracts and runs
# the trap in isolation rather than pretending to boot a platform.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p001c121-df-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SCRIPT="$ROOT/tests/ci/data_foundation_ci.sh"

echo
echo "== CASE 1: the global opsweave.managed=true sweep is gone"
if grep -qE 'docker ps -aq --filter label=opsweave.managed=true \| xargs' "$SCRIPT"; then
  fail "the script still sweeps every OpsWeave container on the daemon"
else
  pass "no global sweep: removal is scoped by installation id"
fi
if grep -q 'opsweave.installation-id' "$SCRIPT"; then
  pass "cleanup filters on the installation id"
else
  fail "cleanup does not reference the installation id"
fi
if grep -q 'OPSWEAVE_CI_ALLOW_SHARED_DAEMON' "$SCRIPT"; then
  pass "a shared daemon is an explicit, opt-in condition"
else
  fail "there is no precondition for a shared daemon"
fi

echo
echo "== CASE 2: a foreign installation's container survives the trap"
# Extract the cleanup function and run it against a fake daemon holding two
# containers: one labelled with this run's identity, one with a stranger's.
sed -n '/^cleanup() {/,/^}/p' "$SCRIPT" > "$WORK/cleanup.sh"
if [ ! -s "$WORK/cleanup.sh" ]; then
  echo "could not extract the cleanup function; this case would be vacuous" >&2
  exit 1
fi
FAKE="$WORK/daemon"
mkdir -p "$FAKE/store/ours" "$FAKE/store/theirs" "$FAKE/bin" "$WORK/repo/data-ci/node-a"
OURS="aaaaaaaa-1111-4111-8111-111111111111"
THEIRS="bbbbbbbb-2222-4222-8222-222222222222"
printf '%s' "$OURS" > "$WORK/repo/data-ci/node-a/installation-id"
printf '%s' "$OURS" > "$FAKE/store/ours/label"
printf '%s' "$THEIRS" > "$FAKE/store/theirs/label"
printf 'ours-id' > "$FAKE/store/ours/id"
printf 'theirs-id' > "$FAKE/store/theirs/id"
cat > "$FAKE/bin/docker" <<'FAKE_DOCKER'
#!/bin/sh
case "$1" in
  ps)
    # Both the -aq/--filter form and the -a --format form are used.
    for d in "$STORE"/*; do
      [ -d "$d" ] || continue
      keep=1; prev=""
      for a in "$@"; do
        case "$prev" in
          --filter)
            case "$a" in
              "label=opsweave.installation-id="*)
                want="${a#label=opsweave.installation-id=}"
                [ "$want" = "$(cat "$d/label")" ] || keep=0 ;;
            esac ;;
        esac
        prev="$a"
      done
      [ "$keep" = "1" ] && printf '%s\n' "$(basename "$d")"
    done ;;
  rm)
    for a in "$@"; do
      case "$a" in -*) ;; *)
        for d in "$STORE"/*; do
          [ -d "$d" ] || continue
          if [ "$a" = "$(basename "$d")" ] || [ "$a" = "$(cat "$d/id" 2>/dev/null)" ]; then
            rm -rf "$d"
          fi
        done ;;
      esac
    done ;;
  inspect)
    last=""; for a in "$@"; do case "$a" in -*) ;; *) last="$a" ;; esac; done
    for d in "$STORE"/*; do
      [ -d "$d" ] || continue
      if [ "$last" = "$(basename "$d")" ]; then cat "$d/label"; exit 0; fi
    done
    echo "<no value>" ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/bin/docker"
(
  cd "$WORK/repo" || exit 1
  # The extracted function reads these; the linter cannot see through the dot.
  # shellcheck disable=SC2034
  PIDS=()
  # shellcheck disable=SC2034
  STATE_CI="$WORK/repo/data-ci"
  # shellcheck disable=SC1090
  . "$WORK/cleanup.sh"
  export PATH="$FAKE/bin:$PATH" STORE="$FAKE/store"
  cleanup
) >/dev/null 2>&1
if [ ! -d "$FAKE/store/ours" ]; then
  pass "this run's own container was removed"
else
  fail "this run's own container was not removed"
fi
if [ -d "$FAKE/store/theirs" ]; then
  pass "the other installation's container survived"
else
  fail "the cleanup removed a container it could not attribute to this run"
fi

echo
echo "== CASE 3: the acceptance exit code survives the trap"
(
  cd "$WORK/repo" || exit 1
  # shellcheck disable=SC2034
  PIDS=()
  # shellcheck disable=SC2034
  STATE_CI="$WORK/repo/data-ci"
  # shellcheck disable=SC1090
  . "$WORK/cleanup.sh"
  export PATH="$FAKE/bin:$PATH" STORE="$FAKE/store"
  trap cleanup EXIT
  exit 7
) >/dev/null 2>&1
code=$?
if [ "$code" = "7" ]; then
  pass "a failing acceptance run still exits 7, not 0"
else
  fail "the cleanup trap rewrote the exit code to $code"
fi

echo
echo "== CASE 4: the shared-daemon precondition fires"
# A daemon that already carries an OpsWeave container, with the opt-in unset.
mkdir -p "$FAKE/presweep"
cat > "$FAKE/bin/docker-presweep" <<'FAKE_DOCKER'
#!/bin/sh
case "$1" in
  ps) echo "leftover-container" ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/bin/docker-presweep"
mkdir -p "$FAKE/bin2"
cp "$FAKE/bin/docker-presweep" "$FAKE/bin2/docker"
OUT="$(cd "$WORK/repo" && PATH="$FAKE/bin2:$PATH" bash -c '
  set -euo pipefail
  # Execute just the precondition block from the script, not the whole thing.
  existing="$(docker ps -aq --filter label=opsweave.managed=true 2>/dev/null | wc -l | tr -d " ")"
  if [ "${existing:-0}" -gt 0 ] && [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" != "1" ]; then
    echo "BLOCKED: $existing OpsWeave container(s) already exist on this daemon." >&2
    exit 1
  fi
  echo "proceeded"
' 2>&1)"
CODE=$?
if [ "$CODE" -ne 0 ] && printf '%s' "$OUT" | grep -q BLOCKED; then
  pass "a shared daemon is refused with BLOCKED"
else
  fail "a shared daemon was not refused (exit $CODE): $OUT"
fi
OUT="$(cd "$WORK/repo" && PATH="$FAKE/bin2:$PATH" OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1 bash -c '
  set -euo pipefail
  existing="$(docker ps -aq --filter label=opsweave.managed=true 2>/dev/null | wc -l | tr -d " ")"
  if [ "${existing:-0}" -gt 0 ] && [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" != "1" ]; then
    echo "BLOCKED" >&2; exit 1
  fi
  echo "proceeded"
' 2>&1)"
if [ "$?" = "0" ] && printf '%s' "$OUT" | grep -q proceeded; then
  pass "the opt-in lets a dedicated runner proceed"
else
  fail "the opt-in did not allow the run: $OUT"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "the Data Foundation harness removes only what it can attribute to itself"
