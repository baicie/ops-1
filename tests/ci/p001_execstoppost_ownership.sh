#!/bin/bash
# P001 stage 2 — ExecStopPost cleanup ownership, against a REAL Docker daemon.
#
# The defect: `opsweave-node-cleanup.sh` selected containers with
#
#     docker ps -aq --filter "label=opsweave.node-id=$NODE_ID"
#
# and then ran `docker rm -f` on each match. `opsweave.node-id` is not an
# ownership proof — ADR-023 says so, and the Runtime stopped using it as one in
# C1.2. A restored database or a copied state directory reproduces the same node
# id in two installations, so this script deleted a *different* installation's
# containers. It also used the bare `docker` CLI, which reads `DOCKER_HOST`; the
# systemd unit exports `OPSWEAVE_DOCKER_HOST`, so under the rootless unit the
# script talked to the default socket.
#
# Every case below runs the real script against the real daemon. No mocks.
#
# Isolation: containers carry a node id and installation ids generated for THIS
# run, so no other container can match the filters. The script is invoked with a
# state directory under /tmp, never the deployed one.
#
# Exit: 0 only when every assertion passed AND teardown removed this run's
# containers. A teardown failure is reported and fails the run.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLEANUP="$REPO_ROOT/deployments/linux/opsweave-node-cleanup.sh"

[ -x "$CLEANUP" ] || { echo "missing or non-executable: $CLEANUP" >&2; exit 1; }

uuid() { uuidgen | tr 'A-Z' 'a-z'; }

RUN="$(uuid | cut -c1-12)"
NODE_ID="$(uuid)"
INST_A="$(uuid)"
INST_B="$(uuid)"
TAG="p001s2-$RUN"
WORK="$(mktemp -d "/tmp/$TAG.XXXXXX")"

PASS=0
FAIL=0
CREATED=()

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }

teardown() {
  local code=$?
  trap - EXIT TERM INT
  local left=0
  for c in "${CREATED[@]:-}"; do
    [ -n "$c" ] || continue
    if docker inspect "$c" >/dev/null 2>&1; then
      docker rm -f "$c" >/dev/null 2>&1 || left=$((left + 1))
    fi
  done
  rm -rf "$WORK"
  if [ "$left" -gt 0 ]; then
    printf 'cleanup: FAIL (%d container(s) this run created could not be removed)\n' "$left"
    [ "$code" -eq 0 ] && code=1
  else
    printf 'cleanup: PASS (this run'"'"'s containers are gone)\n'
  fi
  echo "RESULT: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -gt 0 ] || [ "$left" -gt 0 ]; then
    exit 1
  fi
  exit "$code"
}
trap teardown EXIT TERM INT

# --- daemon must be real -----------------------------------------------------
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  if [ "${OPSWEAVE_REQUIRE_TEST_DOCKER:-0}" = "1" ]; then
    echo "BLOCKED: OPSWEAVE_REQUIRE_TEST_DOCKER=1 but no Docker daemon" >&2
    exit 1
  fi
  echo "SKIP: no Docker daemon and OPSWEAVE_REQUIRE_TEST_DOCKER is not 1"
  exit 0
fi

# --- fixture -----------------------------------------------------------------
plant() { # name, installation-id (empty = none), extra label args...
  local name="$1" inst="$2"; shift 2
  local args=(run -d --name "$name" --label "opsweave.node-id=$NODE_ID")
  [ -n "$inst" ] && args+=(--label "opsweave.installation-id=$inst")
  args+=(--label "opsweave.managed=true" "$@" --entrypoint sh alpine:3.20 -c 'sleep 600')
  docker "${args[@]}" >/dev/null || return 1
  CREATED+=("$name")
}

plant "p001s2-a-$RUN" "$INST_A" || { echo "cannot plant A" >&2; exit 1; }
plant "p001s2-b-$RUN" "$INST_B" || { echo "cannot plant B" >&2; exit 1; }
plant "p001s2-legacy-$RUN" ""     || { echo "cannot plant legacy" >&2; exit 1; }
# third party: no opsweave labels at all
docker run -d --name "p001s2-third-$RUN" --label "team=someone-else" \
  --entrypoint sh alpine:3.20 -c 'sleep 600' >/dev/null || { echo "cannot plant third" >&2; exit 1; }
CREATED+=("p001s2-third-$RUN")

present() { docker inspect "$1" >/dev/null 2>&1; }

# state dir helpers
state_with() { # dir, installation-id (empty = file absent), node-id or ""
  local dir="$1" inst="$2" node="$3"
  rm -rf "$dir"; mkdir -p "$dir"
  [ -n "$inst" ] && { printf '%s' "$inst" >"$dir/installation-id"; chmod 600 "$dir/installation-id"; }
  if [ -n "$node" ]; then
    printf '{"nodeId":"%s","credential":"x","dataToken":"y","generation":1}\n' "$node" >"$dir/node-identity.json"
  fi
}

run_cleanup() { # dir, docker_host or "" ; echoes exit code
  local dir="$1" host="${2:-unix:///var/run/docker.sock}"
  local logf="$WORK/last-cleanup.log"
  # Output goes to a FILE, not captured through a pipe. Capturing with `$( )`
  # and also writing to stderr kept the command substitution's pipe open and
  # `wait` blocked for the full 300 s of the stray `sleep` a first draft left
  # behind; the diagnosis cost more than the fix.
  OPSWEAVE_NODE_STATE_DIR="$dir" DOCKER_HOST="$host" "$CLEANUP" >"$logf" 2>&1
  local code=$?
  sed 's/^/    /' "$logf" >&2
  printf '%s' "$code"
}

echo "== fixture: node=$NODE_ID A=$INST_A B=$INST_B run=$RUN =="

# --- 1. our container is removed, everyone else survives ---------------------
D="$WORK/case1"; state_with "$D" "$INST_A" "$NODE_ID"
code="$(run_cleanup "$D")"
[ "$code" = "0" ] && ok "own container: script exits 0" || bad "own container: exit $code, expected 0"
present "p001s2-a-$RUN"      && bad "A (ours) was NOT removed"        || ok "A (ours) was removed"
present "p001s2-b-$RUN"      && ok  "B (another installation) survived" || bad "B (another installation) was DELETED"
present "p001s2-legacy-$RUN" && ok  "legacy container (no installation-id) survived" || bad "legacy container was DELETED"
present "p001s2-third-$RUN"  && ok  "third-party container survived" || bad "third-party container was DELETED"

# --- 2. B's own run removes B and only B ------------------------------------
D="$WORK/case2"; state_with "$D" "$INST_B" "$NODE_ID"
code="$(run_cleanup "$D")"
[ "$code" = "0" ] && ok "installation B: exit 0" || bad "installation B: exit $code"
present "p001s2-b-$RUN" && bad "B did not remove its own container" || ok "B removed its own container"
present "p001s2-legacy-$RUN" && ok "legacy container survived B's run" || bad "legacy container deleted by B"
present "p001s2-third-$RUN" && ok "third-party survived B's run" || bad "third-party deleted by B"

# --- 3. identity file missing => refuse, delete nothing ----------------------
D="$WORK/case3"; state_with "$D" "" "$NODE_ID"
code="$(run_cleanup "$D")"
[ "$code" = "3" ] && ok "missing identity: exit 3 (refused)" || bad "missing identity: exit $code, expected 3"
present "p001s2-legacy-$RUN" && ok "missing identity: nothing was deleted" || bad "missing identity: a container was deleted"

# --- 4. identity file invalid => refuse -------------------------------------
D="$WORK/case4"; state_with "$D" "not-a-uuid" "$NODE_ID"
code="$(run_cleanup "$D")"
[ "$code" = "3" ] && ok "invalid identity: exit 3 (refused)" || bad "invalid identity: exit $code, expected 3"
present "p001s2-legacy-$RUN" && ok "invalid identity: nothing was deleted" || bad "invalid identity: a container was deleted"

# --- 5. empty identity file => refuse ---------------------------------------
D="$WORK/case5"; state_with "$D" "" "$NODE_ID"; : >"$D/installation-id"
code="$(run_cleanup "$D")"
[ "$code" = "3" ] && ok "empty identity: exit 3 (refused)" || bad "empty identity: exit $code, expected 3"

# --- 6. unreachable daemon => exit 2, not "nothing to do" -------------------
D="$WORK/case6"; state_with "$D" "$INST_A" "$NODE_ID"
code="$(run_cleanup "$D" "unix:///nonexistent-opsweave-test.sock")"
[ "$code" = "2" ] && ok "unreachable daemon: exit 2 (DAEMON), not 0" || bad "unreachable daemon: exit $code, expected 2"
present "p001s2-legacy-$RUN" && ok "unreachable daemon: nothing was deleted" || bad "unreachable daemon: a container was deleted"

# --- 7. no endpoint configured => exit 1, never the default socket ----------
D="$WORK/case7"; state_with "$D" "$INST_A" "$NODE_ID"
out="$(env -u DOCKER_HOST -u OPSWEAVE_DOCKER_HOST OPSWEAVE_NODE_STATE_DIR="$D" "$CLEANUP" 2>&1)"; code=$?
[ "$code" = "1" ] && ok "no endpoint: exit 1 (USAGE) rather than using the default socket" \
  || bad "no endpoint: exit $code, expected 1"
case "$out" in *"no Docker endpoint"*) ok "no endpoint: the reason is stated" ;; *) bad "no endpoint: message was '$out'" ;; esac

# --- 8. OPSWEAVE_DOCKER_HOST alone is honoured (the unit sets both) ---------
D="$WORK/case8"; state_with "$D" "$INST_A" "$NODE_ID"
out="$(env -u DOCKER_HOST OPSWEAVE_DOCKER_HOST="unix:///nonexistent-opsweave-test.sock" \
      OPSWEAVE_NODE_STATE_DIR="$D" "$CLEANUP" 2>&1)"; code=$?
[ "$code" = "2" ] && ok "OPSWEAVE_DOCKER_HOST is accepted when DOCKER_HOST is unset (exit 2)" \
  || bad "OPSWEAVE_DOCKER_HOST ignored: exit $code, expected 2"
case "$out" in *"/nonexistent-opsweave-test.sock"*) ok "the configured socket is the one it reports" ;; *) bad "socket not named in output: $out" ;; esac

# --- 9. same NAME, different installation => never removed ------------------
# A container whose name looks exactly like ours but carries B's installation id.
docker rm -f "p001s2-a-$RUN" >/dev/null 2>&1 || true
docker run -d --name "p001s2-a-$RUN" --label "opsweave.node-id=$NODE_ID" \
  --label "opsweave.installation-id=$INST_B" --label "opsweave.managed=true" \
  --entrypoint sh alpine:3.20 -c 'sleep 600' >/dev/null
CREATED+=("p001s2-a-$RUN")
D="$WORK/case9"; state_with "$D" "$INST_A" "$NODE_ID"
code="$(run_cleanup "$D")"
[ "$code" = "0" ] && ok "same-name foreign container: exit 0 (nothing of ours left)" || bad "same-name foreign container: exit $code"
present "p001s2-a-$RUN" && ok "same-name foreign container survived (ownership is the label, not the name)" \
  || bad "same-name foreign container was deleted"

# --- 10. node id missing from the state dir => ownership still by installation
# The only container carrying this node id is `p001s2-a-$RUN`, which by case 9
# belongs to installation B. The identity in the state dir is A. Running as A
# must leave B's container alone even though there is no node-identity.json to
# narrow the candidate set - proving the installation label decides, not the
# node id and not the name.
D="$WORK/case10"; state_with "$D" "$INST_A" ""
code="$(run_cleanup "$D")"
[ "$code" = "0" ] && ok "no node-identity.json: exit 0 (nothing of A's is left)" \
  || bad "no node-identity.json: exit $code, expected 0"
present "p001s2-a-$RUN" \
  && ok "no node-identity.json: B's same-name container survived an A-scoped run" \
  || bad "no node-identity.json: A deleted a container labelled for B"
present "p001s2-legacy-$RUN" \
  && ok "no node-identity.json: the unlabelled legacy container survived" \
  || bad "no node-identity.json: the legacy container was deleted"

# --- 11. two consecutive runs are idempotent --------------------------------
D="$WORK/case11"; state_with "$D" "$INST_A" "$NODE_ID"
code1="$(run_cleanup "$D")"; code2="$(run_cleanup "$D")"
[ "$code1" = "0" ] && [ "$code2" = "0" ] && ok "second run with nothing left exits 0" \
  || bad "idempotency: exits $code1 then $code2"

echo "== core cases done: PASS=$PASS FAIL=$FAIL =="

# --- 12. the three stop paths the unit must survive -------------------------
# systemd runs ExecStopPost after a clean stop, after a non-zero exit, and after
# SIGKILL. The script must behave identically in all three: it only reads the
# state directory and the daemon, so its own behaviour cannot depend on how the
# Node died. What DOES differ is whether the state directory is intact - so the
# contract under test is "the script's verdict depends on the files and daemon,
# not on the signal".
#
# This host has no systemd (macOS), so the stop is simulated: a process is
# started and terminated each way, then the script is run as ExecStopPost would.
#
# `sleep` is exec'd directly (no `sh -c`), so the PID we signal IS the process.
# Wrapping it in `sh -c` signals the shell, leaves `sleep` as an orphan, and
# `wait` then blocks for the full timeout - which is exactly what a first draft
# of this function did.
#
# The second draft signalled `sleep` directly and STILL blocked, because `wait`
# in a non-interactive shell waits for the completed job to be reaped, and the
# trace showed `kill -TERM` landing before `sleep` had actually exec'd. Both
# drafts were racing the fork. This version does not need to win that race: it
# starts a real child that exits on its own schedule and then *polls* for the
# process to be gone, bounded, instead of relying on signal delivery timing.
stop_probe() { # how (clean|nonzero|sigkill)
  local how="$1" pid i
  case "$how" in
    clean)
      sleep 3 & pid=$!
      ;;
    nonzero)
      ( sleep 3; exit 7 ) & pid=$!
      ;;
    sigkill)
      sleep 3 & pid=$!
      ;;
  esac
  # Give the child a moment to actually become the process we started, then
  # signal it the way the service manager would.
  case "$how" in
    clean)   sleep 0.2; kill -TERM "$pid" 2>/dev/null ;;
    sigkill) sleep 0.2; kill -KILL "$pid" 2>/dev/null ;;
  esac
  # Bounded wait: the helper's job is to exercise the three stop paths, not to
  # block the suite. Never `wait` unbounded on a background job here.
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  wait "$pid" 2>/dev/null || true
  return 0
}

for how in clean nonzero sigkill; do
  stop_probe "$how"
  D="$WORK/stop-$how"
  state_with "$D" "$INST_A" "$NODE_ID"
  # A container this installation owns, created anew for this case.
  docker rm -f "p001s2-stop-$RUN" >/dev/null 2>&1 || true
  docker run -d --name "p001s2-stop-$RUN" --label "opsweave.node-id=$NODE_ID" \
    --label "opsweave.installation-id=$INST_A" --label "opsweave.managed=true" \
    --entrypoint sh alpine:3.20 -c 'sleep 600' >/dev/null
  CREATED+=("p001s2-stop-$RUN")
  code="$(run_cleanup "$D")"
  [ "$code" = "0" ] && ok "stop path '$how': ExecStopPost exits 0" \
    || bad "stop path '$how': exit $code, expected 0"
  present "p001s2-stop-$RUN" && bad "stop path '$how': own container NOT removed" \
    || ok "stop path '$how': own container removed"
done

# --- 13. a damaged state dir yields the same refusal regardless of the stop ---
# After SIGKILL the identity file can be gone (a restore that did not finish,
# a half-written migration). The script must refuse, not fall back to node id.
stop_probe sigkill
D="$WORK/stop-sigkill-noidentity"; state_with "$D" "" "$NODE_ID"
docker run -d --name "p001s2-survivor-$RUN" --label "opsweave.node-id=$NODE_ID" \
  --label "opsweave.installation-id=$INST_B" --label "opsweave.managed=true" \
  --entrypoint sh alpine:3.20 -c 'sleep 600' >/dev/null
CREATED+=("p001s2-survivor-$RUN")
code="$(run_cleanup "$D")"
[ "$code" = "3" ] && ok "SIGKILL + no identity: exit 3 (refused)" || bad "SIGKILL + no identity: exit $code, expected 3"
present "p001s2-survivor-$RUN" && ok "SIGKILL + no identity: B's container survived" \
  || bad "SIGKILL + no identity: B's container was deleted"

echo "== done: PASS=$PASS FAIL=$FAIL =="
