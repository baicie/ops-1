#!/usr/bin/env bash
# P001 — teardown must not report success for cleanup it did not perform.
#
# The defect this attacks, from `p001c_teardown.sh` before this change:
#
#     ids="$(docker ps -aq --filter ... 2>/dev/null || true)"
#     [ -n "$ids" ] || continue
#
# When the daemon is unreachable the query fails, `2>/dev/null` hides why,
# `|| true` makes the failure a success, and the empty stdout is read as "this
# run owns no containers". The script then prints `removed 0 container(s)`,
# drops the database and deletes the state directory - leaving real containers
# running with nothing on disk that records whose they are.
#
# `p001c_isolation_guard.sh` already proves a FOREIGN container survives a real
# start/teardown cycle. It does not cover the failure modes below, which are
# about the teardown's own verdict rather than about what it deletes.
#
# Every case here runs without a Docker daemon: the script is exercised through
# a `docker` shim on PATH, so each failure condition is produced exactly and
# reproducibly, and the assertions are about the script's exit code and about
# what it did to the filesystem - both of which are the actual contract.
#
# Exit 0 only if every case passes. Cases that need a real daemon say so and
# report NOT_RUN rather than passing quietly.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

SCRIPT="$ROOT/tests/ci/p001c_teardown.sh"
fails=0; passes=0; notruns=0
pass()   { printf 'PASS  %s\n' "$*"; passes=$((passes + 1)); }
fail()   { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
notrun() { printf 'NOT_RUN  %s\n' "$*"; notruns=$((notruns + 1)); }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- fixtures ---------------------------------------------------------------
# A run record shaped like the one p001c_up.sh writes.
make_run() {
  local run_id="$1" state_dir="$2"
  mkdir -p "$state_dir"
  printf '%s' "{
    \"runId\": \"$run_id\",
    \"database\": \"p001c_$run_id\",
    \"nodeIds\": [\"11111111-1111-4111-8111-111111111111\"],
    \"installationId\": \"22222222-2222-4222-8222-222222222222\"
  }" >"$state_dir/run.json"
  # A pidfile whose process is long gone, so the stop phase is a no-op and the
  # case is about the container phase.
  echo "999999" >"$state_dir/node-a.pid"
  echo "proc:gone" >"$state_dir/node-a.pid.start"
}

# A `docker` that answers each subcommand from a scenario directory. The files
# it reads are written per case, so nothing is shared between them.
# A stateful `docker` stub.
#
# It models the daemon rather than replaying a script: containers live in
# `$SCEN/containers` (one `id<TAB>installation<TAB>node` line each), and
# `rm` deletes those lines. That matters for the post-check, which asks the
# daemon a SECOND question - "are those ids gone?" - and a stub that answered
# the same thing twice could only ever test one half.
#
# `ps -q` prints bare ids (the ownership query); `ps --format` prints the full
# triples (the inventory). Conflating them was the first version's bug.
make_docker_shim() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/docker" <<'SHIM'
#!/usr/bin/env bash
scenario="${SCENARIO_DIR:?}"
store="$scenario/containers"
cmd="${1:-}"; shift || true
fail_if() { [ -f "$scenario/exit-$1" ] && { cat "$scenario/out-$1" 2>/dev/null; exit "$(cat "$scenario/exit-$1")"; }; }
case "$cmd" in
  info)
    fail_if info
    exit 0 ;;
  ps)
    fail_if ps
    # Label filters are REAL here, not ignored: the script trusts the daemon to
    # apply them, so a stub that returned every container would test a product
    # that does not exist and would fail the "foreign container survives" case
    # for the wrong reason. Measured: without this the owned set was every id.
    quiet=0; inst=""; node=""
    prev=""
    for a in "$@"; do
      case "$a" in
        -q|-aq|--quiet) quiet=1 ;;
        label=opsweave.installation-id=*) inst="${a#label=opsweave.installation-id=}" ;;
        label=opsweave.node-id=*) node="${a#label=opsweave.node-id=}" ;;
      esac
      prev="$a"
    done
    [ -f "$store" ] || exit 0
    while IFS="$(printf '\t')" read -r cid cinc cnode; do
      [ -n "$cid" ] || continue
      [ -n "$inst" ] && [ "$cinc" != "$inst" ] && continue
      [ -n "$node" ] && [ "$cnode" != "$node" ] && continue
      if [ "$quiet" = "1" ]; then printf '%s\n' "$cid"; else printf '%s\t%s\t%s\n' "$cid" "$cinc" "$cnode"; fi
    done <"$store"
    exit 0 ;;
  rm)
    for id in "$@"; do
      case "$id" in -*) continue ;; esac
      fail_if rm
      [ -f "$store" ] && { grep -v "^$id	" "$store" >"$store.tmp" || true; mv "$store.tmp" "$store"; }
    done
    exit 0 ;;
  *) exit 0 ;;
esac
SHIM
  chmod +x "$dir/docker"
}

# One owned container, in the daemon's inventory.
seed_container() {
  local id="$1" inst="$2" node="$3"
  printf '%s\t%s\t%s\n' "$id" "$inst" "$node" >>"$SCEN/containers"
}

SCEN="$WORK/scenario"
BIN="$WORK/bin"
make_docker_shim "$BIN"

echo "== 0: control - a healthy daemon and one owned container"
case_dir="$WORK/case0"; mkdir -p "$case_dir/state"
make_run "run0" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa1111 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" \
  bash "$SCRIPT" run0 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "0: a healthy daemon with one owned container exits 0"
else
  fail "0: control case exited $rc, not 0: $out"
fi
if printf '%s' "$out" | grep -q 'verified: 1 owned container(s) gone'; then
  pass "0: the post-check confirms one owned container is gone"
else
  fail "0: no verification line: $out"
fi
if [ -s "$SCEN/containers" ]; then
  fail "0: the owned container is still in the daemon's inventory"
else
  pass "0: the daemon's inventory really lost the owned container"
fi

echo
echo "== 1: the daemon is unreachable"
case_dir="$WORK/case1"; mkdir -p "$case_dir/state"
make_run "run1" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa1111 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
printf '1\n' >"$SCEN/exit-info"
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n' >"$SCEN/out-info"
out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" bash "$SCRIPT" run1 --purge 2>&1); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "1: an unreachable daemon is BLOCKED (exit 2), not a zero-container success"
else
  fail "1: expected exit 2 for an unreachable daemon, got $rc: $out"
fi
if [ -d "$case_dir/state" ]; then
  pass "1: the state directory was NOT deleted, so ownership can still be recovered"
else
  fail "1: --purge deleted the state directory even though the daemon was unreachable"
fi
if [ -s "$SCEN/containers" ]; then
  pass "1: the owned container is still in the inventory (nothing was removed)"
else
  fail "1: a container disappeared although the daemon was unreachable"
fi
if printf '%s' "$out" | grep -qi 'not reachable'; then
  pass "1: the message says the daemon was unreachable"
else
  fail "1: the failure does not name the daemon as the cause: $out"
fi

echo
echo "== 2: docker ps fails while docker info succeeds"
case_dir="$WORK/case2"; mkdir -p "$case_dir/state"
make_run "run2" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa2222 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
printf '1\n' >"$SCEN/exit-ps"
printf 'error during connect: permission denied\n' >"$SCEN/out-ps"
out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" bash "$SCRIPT" run2 --purge 2>&1); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "2: a failed container query is BLOCKED, not an empty list"
else
  fail "2: expected exit 2 when the container query fails, got $rc: $out"
fi
if [ -d "$case_dir/state" ]; then
  pass "2: the state directory survives a failed query"
else
  fail "2: the state directory was deleted after a failed query"
fi

echo
echo "== 3: docker rm fails"
#
# Note on what this case does and does not isolate: with the `rm` error check
# removed, this case still fails - but through the POST-CHECK ("the container is
# still listed"), not through the removal itself. Measured: deleting the `rm`
# guard left all 19 assertions passing, because the inventory comparison catches
# the same fact from the other side. That is defence in depth rather than a gap,
# but the two are not independently exercised, so the claim here is only what
# the case actually proves: a failed removal never reads as a clean teardown.
case_dir="$WORK/case3"; mkdir -p "$case_dir/state"
make_run "run3" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa3333 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
printf '1\n' >"$SCEN/exit-rm"
printf 'Error: container is in use\n' >"$SCEN/out-rm"
out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" bash "$SCRIPT" run3 --purge 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
  pass "3: a failed removal exits non-zero ($rc)"
else
  fail "3: a failed removal still exited 0: $out"
fi
if [ -d "$case_dir/state" ]; then
  pass "3: a failed removal keeps the state directory"
else
  fail "3: a failed removal still purged the state directory"
fi
if [ -s "$SCEN/containers" ]; then
  pass "3: the container is still listed, matching the failed rm"
else
  fail "3: the stub removed the container although rm reported failure"
fi

echo
echo "== 4: a container the run owns survives its own removal"
case_dir="$WORK/case4"; mkdir -p "$case_dir/state"
make_run "run4" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa4444 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
# `rm` reports success but the inventory keeps the line: the daemon accepted the
# call and did not act. This is the state that must never read as clean.
cat >"$BIN/docker" <<'SHIM4'
#!/usr/bin/env bash
scenario="${SCENARIO_DIR:?}"
cmd="${1:-}"; shift || true
case "$cmd" in
  info) exit 0 ;;
  ps)
    quiet=0; for a in "$@"; do { [ "$a" = "-q" ] || [ "$a" = "-aq" ]; } && quiet=1; done
    if [ "$quiet" = "1" ]; then printf 'aaaa4444\n'; else cat "$scenario/containers"; fi
    exit 0 ;;
  rm) exit 0 ;;
  *) exit 0 ;;
esac
SHIM4
chmod +x "$BIN/docker"
out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" bash "$SCRIPT" run4 --purge 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
  pass "4: a container that survives its own removal is a failure ($rc)"
else
  fail "4: teardown claimed success with the container still listed: $out"
fi
if printf '%s' "$out" | grep -q 'still exist'; then
  pass "4: the message names the surviving container"
else
  fail "4: no surviving-container message: $out"
fi
make_docker_shim "$BIN"

echo
echo "== 5: a container the run does NOT own disappears"
case_dir="$WORK/case5"; mkdir -p "$case_dir/state"
make_run "run5" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa5555 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
seed_container ffff5555 33333333-3333-4333-8333-333333333333 44444444-4444-4444-8444-444444444444
# The stub deletes the foreign line on the first rm as well - what a too-wide
# sweep looks like from the daemon's side.
# Wrap the standard stub so that `rm` of OUR id also takes the foreign one -
# what a too-wide sweep looks like from the daemon's side. Everything else,
# including the label filters, is the standard model.
cp "$BIN/docker" "$BIN/docker.base"
cat >"$BIN/docker" <<'SHIM5'
#!/usr/bin/env bash
if [ "${1:-}" = "rm" ]; then
  store="${SCENARIO_DIR:?}/containers"
  # Delete our id (the caller's request) AND the foreign one (the defect).
  grep -v '^aaaa5555	' "$store" >"$store.tmp" || true
  grep -v '^ffff5555	' "$store.tmp" >"$store.new" || true
  mv "$store.new" "$store"
  rm -f "$store.tmp"
  exit 0
fi
exec "$(dirname "$0")/docker.base" "$@"
SHIM5
chmod +x "$BIN/docker"
out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" bash "$SCRIPT" run5 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
  pass "5: a foreign container disappearing is a FAIL, not a silent success ($rc)"
else
  fail "5: teardown reported success after a foreign container vanished: $out"
fi
if printf '%s' "$out" | grep -q 'did not own disappeared'; then
  pass "5: the message names the sweep it detected"
else
  fail "5: no foreign-disappearance message: $out"
fi
rm -f "$BIN/docker.base"
echo
echo "== 6: SIGTERM during the container phase"
case_dir="$WORK/case6"; mkdir -p "$case_dir/state"
make_run "run6" "$case_dir/state"
rm -f "$SCEN"/*; mkdir -p "$SCEN"
seed_container aaaa6666 22222222-2222-4222-8222-222222222222 11111111-1111-4111-8111-111111111111
cat >"$BIN/docker" <<'SHIM6'
#!/usr/bin/env bash
cmd="${1:-}"; shift || true
case "$cmd" in
  info) exit 0 ;;
  ps)
    quiet=0; for a in "$@"; do { [ "$a" = "-q" ] || [ "$a" = "-aq" ]; } && quiet=1; done
    if [ "$quiet" = "1" ]; then printf 'aaaa6666\n'; else printf 'aaaa6666\t22222222-2222-4222-8222-222222222222\t11111111-1111-4111-8111-111111111111\n'; fi
    exit 0 ;;
  rm) sleep 30; exit 0 ;;
  *) exit 0 ;;
esac
SHIM6
chmod +x "$BIN/docker"
OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" SCENARIO_DIR="$SCEN" PATH="$BIN:$PATH" bash "$SCRIPT" run6 >"$WORK/case6.out" 2>&1 &
td_pid=$!
sleep 1.5
kill -TERM "$td_pid" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$td_pid" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$td_pid" 2>/dev/null; then
  kill -9 "$td_pid" 2>/dev/null || true
  fail "6: teardown ignored SIGTERM and had to be SIGKILLed"
else
  wait "$td_pid" 2>/dev/null; sig_rc=$?
  if [ "$sig_rc" -eq 0 ]; then
    fail "6: teardown exited 0 after SIGTERM - a signal is not a clean finish"
  else
    pass "6: SIGTERM mid-removal ends non-zero (exit $sig_rc), never as a pass"
  fi
fi
if [ -d "$case_dir/state" ]; then
  pass "6: the state directory survives an interrupted teardown"
else
  fail "6: an interrupted teardown deleted the state directory"
fi
make_docker_shim "$BIN"

echo
echo "== 7: a real daemon, to confirm the stub did not invent the contract"
if docker info >/dev/null 2>&1; then
  case_dir="$WORK/case7"; mkdir -p "$case_dir/state"
  make_run "run7" "$case_dir/state"
  out=$(OPSWEAVE_TEARDOWN_STATE_DIR="$case_dir/state" bash "$SCRIPT" run7 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "7: a reachable daemon with no owned containers exits 0"
  else
    fail "7: real-daemon no-container case exited $rc: $out"
  fi
else
  notrun "7: no Docker daemon here; the real-API no-container case was not exercised"
fi

echo
echo "== teardown negatives: PASS=$passes FAIL=$fails NOT_RUN=$notruns =="
[ "$fails" -eq 0 ] || exit 1
