#!/usr/bin/env bash
# P001-C1.2.1 Task B - the demo scripts must not destroy anything they cannot
# prove is theirs.
#
# These are counterfactuals, not happy-path checks. Each one sets up the
# condition that used to be destroyed by a guess and requires the script to
# refuse instead. A guard that cannot fail is not a guard, so each case is run
# against a deliberately unsafe implementation first (see 03h §C1.2.1 for the
# recorded output).
#
# Nothing here touches a real demo: every case runs in its own tmpdir with its
# own fake `docker`, and only ever plants containers named with this script's
# own pid. The one case that needs a real listener uses a port the script picks
# and releases.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p001c121-demo-XXXXXX")"
PIDS=""
cleanup() {
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- CASE 1: a foreign process holds the demo port --------------------------
#
# The script used to run `lsof -t | xargs kill`, which stops whatever is there.
# It must now leave it running and say BLOCKED.
echo
echo "== CASE 1: an unrelated listener on the demo port must survive"
PORT="$(( 19000 + ($$ % 500) ))"
# A stand-in for "somebody else's server": `python3 -m http.server` has a command
# line that is obviously not this checkout's kernel.
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
FOREIGN_PID=$!
PIDS="$PIDS $FOREIGN_PID"
ready=0
for _ in $(seq 1 40); do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
if [ "$ready" != "1" ]; then
  echo "could not start the stand-in listener; this case would be vacuous" >&2
  exit 1
fi
OUT="$(OPSWEAVE_PORT="$PORT" bash scripts/demo_down.sh 2>&1)"
CODE=$?
if [ "$CODE" -ne 0 ]; then
  pass "demo_down refused while a foreign process held the port (exit $CODE)"
else
  fail "demo_down returned success with a foreign listener on the port"
fi
if printf '%s' "$OUT" | grep -q BLOCKED; then
  pass "the refusal is reported as BLOCKED"
else
  fail "the refusal did not say BLOCKED: $(printf '%s' "$OUT" | tail -1)"
fi
if kill -0 "$FOREIGN_PID" 2>/dev/null; then
  pass "the unrelated process is still alive"
else
  fail "the unrelated process was killed"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  pass "the unrelated process still holds its port"
else
  fail "the unrelated process lost its port"
fi
kill "$FOREIGN_PID" 2>/dev/null || true
PIDS=""
wait "$FOREIGN_PID" 2>/dev/null || true

# --- CASE 2: data exists but the identity file is gone ----------------------
#
# `cp -a data data.bak; rm data/node-*/installation-id` is what a partial
# restore looks like. The containers are still on the daemon. Ownership cannot
# be established, so nothing may be removed.
echo
echo "== CASE 2: no installation identity means no cleanup, not a guess"
FAKE="$WORK/fake2"
mkdir -p "$FAKE/bin" "$FAKE/repo/data/node-a" "$FAKE/repo/data/node-b" "$FAKE/repo/scripts"
# The state directories exist and even carry a node identity, but no
# installation-id - the exact shape a partial restore leaves behind.
printf '{"nodeId":"11111111-1111-4111-8111-111111111111"}' \
  > "$FAKE/repo/data/node-a/node-identity.json"
cp "$ROOT/scripts/demo_common.sh" "$FAKE/repo/scripts/"
cat > "$FAKE/bin/docker" <<'FAKE_DOCKER'
#!/bin/sh
# The daemon already holds an OpsWeave container that this checkout can no
# longer attribute - a partial restore, or a state directory that was wiped.
# That is the case where guessing is dangerous, and it is distinct from a first
# run, where there is nothing on the daemon at all.
case "$1" in
  ps) echo "orphaned-container" ;;
  rm) echo "RM-CALLED $*" >> "$MARKER" ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/bin/docker"
MARKER="$FAKE/rm-called"
: > "$MARKER"
OUT="$(cd "$FAKE/repo" && PATH="$FAKE/bin:$PATH" MARKER="$MARKER" \
  ROOT="$FAKE/repo" bash -c '. "$ROOT/scripts/demo_common.sh"; demo_stop_containers purge' 2>&1)"
CODE=$?
if [ "$CODE" -ne 0 ]; then
  pass "cleanup refused without an installation identity (exit $CODE)"
else
  fail "cleanup returned success without proving ownership"
fi
if printf '%s' "$OUT" | grep -q BLOCKED; then
  pass "the refusal is reported as BLOCKED"
else
  fail "the refusal did not say BLOCKED"
fi
if [ ! -s "$MARKER" ]; then
  pass "no container was removed on a guess"
else
  fail "a container was removed without ownership: $(cat "$MARKER")"
fi

# --- CASE 2b: a first run has nothing to stop and must not be blocked ------
#
# The first version of the ownership guard refused whenever no identity existed,
# which also refused the ordinary first run - caught by CI in `legacy-regression`
# as `BLOCKED: no installation identity`. A first run has no containers by
# definition, so it is a no-op, not a refusal.
echo
echo "== CASE 2b: a first run is a no-op, not a refusal"
FAKE="$WORK/fake2b"
mkdir -p "$FAKE/bin" "$FAKE/repo/data" "$FAKE/repo/scripts"
cp "$ROOT/scripts/demo_common.sh" "$FAKE/repo/scripts/"
cat > "$FAKE/bin/docker" <<'FAKE_DOCKER'
#!/bin/sh
# An empty daemon: nothing has ever been started here.
case "$1" in
  ps) : ;;
  rm) echo "RM-CALLED $*" >&2; exit 9 ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/bin/docker"
OUT="$(cd "$FAKE/repo" && PATH="$FAKE/bin:$PATH" ROOT="$FAKE/repo" \
  bash -c '. "$ROOT/scripts/demo_common.sh"; demo_stop_containers purge' 2>&1)"
CODE=$?
if [ "$CODE" -eq 0 ]; then
  pass "a first run proceeds instead of refusing"
else
  fail "a first run was refused (exit $CODE): $OUT"
fi
if printf '%s' "$OUT" | grep -q "nothing to stop"; then
  pass "it says there was nothing to stop"
else
  fail "it did not explain the no-op: $OUT"
fi

# --- CASE 3: two demos share the daemon -------------------------------------
#
# Stopping one must not touch the other's containers. The fake docker models a
# daemon holding one container per installation and honours the label filter the
# way the real one does.
echo
echo "== CASE 3: stopping installation A leaves installation B running"
FAKE="$WORK/fake3"
mkdir -p "$FAKE/bin" "$FAKE/repo/data/node-a" "$FAKE/repo/scripts" "$FAKE/store"
cp "$ROOT/scripts/demo_common.sh" "$FAKE/repo/scripts/"
printf 'aaaaaaaa-1111-4111-8111-111111111111' > "$FAKE/repo/data/node-a/installation-id"
# Two containers, one per installation.
mkdir -p "$FAKE/store/a-container" "$FAKE/store/b-container"
printf 'aaaaaaaa-1111-4111-8111-111111111111' > "$FAKE/store/a-container/label"
printf 'bbbbbbbb-2222-4222-8222-222222222222' > "$FAKE/store/b-container/label"
printf 'a-id' > "$FAKE/store/a-container/id"
printf 'b-id' > "$FAKE/store/b-container/id"
cat > "$FAKE/bin/docker" <<'FAKE_DOCKER'
#!/bin/sh
case "$1" in
  ps)
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
  rm) for a in "$@"; do
        case "$a" in -*) ;; *)
          for d in "$STORE"/*; do
            [ -d "$d" ] || continue
            # The daemon accepts a name or an id.
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
      if [ "$last" = "$(basename "$d")" ] || [ "$last" = "$(cat "$d/id" 2>/dev/null)" ]; then
        cat "$d/label"; exit 0
      fi
    done
    echo "<no value>"; exit 0 ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/bin/docker"
(cd "$FAKE/repo" && PATH="$FAKE/bin:$PATH" STORE="$FAKE/store" ROOT="$FAKE/repo" \
  bash -c '. "$ROOT/scripts/demo_common.sh"; demo_stop_containers purge' >/dev/null 2>&1)
if [ ! -d "$FAKE/store/a-container" ]; then
  pass "A's own container was removed"
else
  fail "A's own container was not removed"
fi
if [ -d "$FAKE/store/b-container" ]; then
  pass "B's container survived A's stop"
else
  fail "stopping A removed B's container"
fi

# --- CASE 4: a labelled container survives when its removal fails ----------
#
# The old code ended every removal with `|| true`, so a failed `docker rm` was
# reported as a clean stop. A stop that could not remove its own container must
# say so.
echo
echo "== CASE 4: a failed removal is reported, not swallowed"
FAKE="$WORK/fake4"
mkdir -p "$FAKE/bin" "$FAKE/repo/data/node-a" "$FAKE/repo/scripts"
cp "$ROOT/scripts/demo_common.sh" "$FAKE/repo/scripts/"
printf 'cccccccc-3333-4333-8333-333333333333' > "$FAKE/repo/data/node-a/installation-id"
cat > "$FAKE/bin/docker" <<'FAKE_DOCKER'
#!/bin/sh
case "$1" in
  ps) echo "c-container" ;;
  rm) echo "daemon: cannot remove, container is in use" >&2; exit 1 ;;
esac
exit 0
FAKE_DOCKER
chmod +x "$FAKE/bin/docker"
OUT="$(cd "$FAKE/repo" && PATH="$FAKE/bin:$PATH" ROOT="$FAKE/repo" \
  bash -c '. "$ROOT/scripts/demo_common.sh"; demo_stop_containers purge' 2>&1)"
CODE=$?
if [ "$CODE" -ne 0 ]; then
  pass "a failed removal is a failure, not a clean stop (exit $CODE)"
else
  fail "a failed removal was reported as success"
fi
if printf '%s' "$OUT" | grep -q BLOCKED; then
  pass "the failure is reported as BLOCKED"
else
  fail "the failure did not say BLOCKED"
fi

# --- CASE 5: the RESET ordering --------------------------------------------
#
# This is the defect the brief names. `demo_up.sh` used to run `rm -rf data`
# before reading `data/node-*/installation-id`, so the cleanup loop was dead code
# and every reset left the old containers behind while claiming to have cleaned.
# Asserted structurally: in the RESET block, the identity read comes first.
echo
echo "== CASE 5: demo_up reads ownership before it deletes state"
UP="$ROOT/scripts/demo_up.sh"
if grep -q 'demo_stop_containers purge' "$UP"; then
  pass "demo_up delegates cleanup to the ownership-checked helper"
else
  fail "demo_up does not use the ownership-checked cleanup"
fi
reset_block="$(sed -n '/if \[ "\$RESET" = "1" \]/,/^fi$/p' "$UP")"
stop_line="$(printf '%s\n' "$reset_block" | grep -n 'demo_stop_containers' | head -1 | cut -d: -f1)"
# Match an executed command, not a comment that mentions one. The block's own
# explanation quotes the old `rm -rf data`, and matching that was a false
# positive on the first run of this check.
wipe_line="$(printf '%s\n' "$reset_block" | grep -nE '^[[:space:]]*rm -rf ' | head -1 | cut -d: -f1)"
if [ -n "$stop_line" ] && [ -n "$wipe_line" ] && [ "$stop_line" -lt "$wipe_line" ]; then
  pass "the RESET block stops containers (line $stop_line) before wiping state (line $wipe_line)"
else
  fail "the RESET block wipes state before stopping containers (stop=$stop_line wipe=$wipe_line)"
fi
# And the unguarded global sweep must not come back in either script.
if grep -rq 'filter label=opsweave.managed=true.*xargs' "$ROOT/scripts" 2>/dev/null; then
  fail "a global opsweave.managed=true sweep is present in scripts/"
else
  pass "no global opsweave.managed=true sweep in scripts/"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "demo scripts stop only what they can prove is theirs"
