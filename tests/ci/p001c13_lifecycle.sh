#!/usr/bin/env bash
# P001-C1.3 - run the full TypeScript lifecycle in one isolated platform, prove
# the run touched only its own Docker resources, then clean up.
#
# This is the driver that turns tests/acceptance/e2e_platform.sh from "a script
# an operator can run against whatever is on port 18181" into a self-contained,
# reproducible acceptance that CI can gate on. It does not reimplement the
# lifecycle; it supplies the three things the lifecycle needs and could not
# assert on its own:
#
#   1. an isolated platform - its own database, HOME, ports, node state
#      directories and installation identity, from tests/ci/p001c_up.sh;
#   2. a Docker ownership record taken BEFORE the run, so "it created containers
#      and removed only those" is measured against the daemon rather than
#      assumed;
#   3. a controlled teardown that removes this run's resources and reports -
#      never removes - anything it cannot attribute.
#
# Refuses to run on a shared daemon unless OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1, so
# a developer's own containers cannot be mistaken for leftovers. On a shared
# daemon the pre/post container comparison still runs; it just does not delete.
#
#   tests/ci/p001c13_lifecycle.sh            # create a run, execute, tear down
#   tests/ci/p001c13_lifecycle.sh --keep     # leave the platform up for inspection
#
# Exit code is the acceptance result. Cleanup can never overwrite it.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

EVIDENCE="${OPSWEAVE_EVIDENCE_DIR:-$ROOT/artifacts/p001c13}"
mkdir -p "$EVIDENCE"
RUN_ID=""

fatal() { printf 'BLOCKED: %s\n' "$*" >&2; exit 1; }
say() { printf '\n### %s\n' "$*"; }

# --- prerequisites ----------------------------------------------------------
# Every one of these is a hard requirement. A missing Docker daemon, psql or
# node binary must stop the run as BLOCKED; silently degrading to a mock would
# produce a green that asserts nothing, which is the failure this whole phase
# exists to remove.
command -v docker >/dev/null 2>&1 || fatal "docker CLI is not installed"
docker info >/dev/null 2>&1 || fatal "the Docker daemon is not reachable"
command -v createdb >/dev/null 2>&1 || fatal "PostgreSQL client tools (createdb) are not installed"
pg_isready >/dev/null 2>&1 || fatal "PostgreSQL is not running"
[ -x "$ROOT/target/debug/opsweave-kernel" ] || fatal "cargo build -p opsweave-kernel has not been run"
[ -x "$ROOT/target/debug/opsweave-node" ] || fatal "cargo build -p opsweave-node has not been run"
[ -x "$ROOT/target/debug/opsctl" ] || fatal "cargo build -p opsweave-opsctl has not been run"

# A shared daemon is a real risk: this script removes containers, and another
# OpsWeave installation on the same host is indistinguishable from a leftover by
# anything except the installation label. Refuse unless the caller says the
# daemon is dedicated to CI.
SHARED=0
OURS_BEFORE="$(docker ps -aq --filter "label=opsweave.managed=true" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${OURS_BEFORE:-0}" != "0" ] && [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" != "1" ]; then
  fatal "the Docker daemon already has $OURS_BEFORE OpsWeave container(s).
         This run creates and removes containers; on a shared daemon it cannot tell
         its own from another installation's. Use a dedicated daemon, or set
         OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1 to run without removing anything."
fi
if [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" = "1" ]; then SHARED=1; fi

# --- plugins ----------------------------------------------------------------
# The lifecycle needs the three signed bundles AND a registry that actually
# holds the pushed images: the manifests reference image@sha256:… and the Node
# pulls that digest. Building them here is the honest path - a stale bundle from
# a previous checkout would make the digest evidence meaningless.
say "build the plugin bundles and push them to a registry"
REGISTRY_PORT="${OPSWEAVE_TEST_REGISTRY_PORT:-5013}"
REGISTRY_NAME="opsweave-p001c13-registry-$REGISTRY_PORT"
# This registry is this run's. It is removed in the trap, by name, and only if
# this script started it.
started_registry=0
if ! docker ps --format '{{.Names}}' | grep -qx "$REGISTRY_NAME"; then
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$REGISTRY_NAME" -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null \
    || fatal "could not start a local registry on 127.0.0.1:${REGISTRY_PORT}"
  started_registry=1
  # Wait for the registry to answer before pushing to it; a push into a
  # half-started registry fails with a connection reset that reads like a build
  # error.
  for _ in $(seq 1 30); do
    curl -fsS -m 2 "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
fi

BUILD_LOG="$EVIDENCE/plugins-build.log"
if ! OPSWEAVE_REGISTRY="localhost:${REGISTRY_PORT}" BUILD=1 \
  scripts/build-plugins.sh >"$BUILD_LOG" 2>&1; then
  tail -30 "$BUILD_LOG" >&2 || true
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  fatal "the plugin bundles could not be built; see $BUILD_LOG"
fi
echo "   bundles built and pushed to localhost:${REGISTRY_PORT}"

# --- platform ---------------------------------------------------------------
say "start an isolated platform"
UP_LOG="$EVIDENCE/platform-up.log"
if ! RUN_ID="$(tests/ci/p001c_up.sh 2>"$UP_LOG" | sed -n 's/^RUN_ID=//p' | tail -1)"; then
  tail -30 "$UP_LOG" >&2 || true
  fatal "the isolated platform did not start; see $UP_LOG"
fi
[ -n "$RUN_ID" ] || fatal "p001c_up.sh did not report a run id; see $UP_LOG"
echo "   run id: $RUN_ID"
STATE="/tmp/p001c-${RUN_ID}"
TOKEN="$(cat "$STATE/token" 2>/dev/null)"
[ -n "$TOKEN" ] || fatal "no session token at $STATE/token"

# --- container ownership, before -------------------------------------------
# The installation ids this run's nodes minted. Anything labelled with them after
# the run belongs to it; anything else does not, and is never removed.
# One id per line. `cat` on several files joins them without a separator, which
# produced one doubled token instead of two ids - and every filter below then
# matched nothing, so "the run removed only what it created" was vacuously true.
INSTALL_IDS="$(for f in "$STATE"/node-*/installation-id; do [ -f "$f" ] && tr -d '\n' <"$f" && echo; done | sort -u | tr '\n' ' ')"
[ -n "$INSTALL_IDS" ] || fatal "the nodes minted no installation identity; ownership cannot be established"
echo "   installation ids: $INSTALL_IDS"
: >"$EVIDENCE/containers-before.txt"
: >"$EVIDENCE/containers-after.txt"

# Snapshot every container on the daemon that this run could have made, by
# installation id. This is the "before" half of the isolation assertion.
for id in $INSTALL_IDS; do
  docker ps -a --filter "label=opsweave.installation-id=$id" --format '{{.ID}} {{.Names}}' \
    >>"$EVIDENCE/containers-before.txt" 2>/dev/null || true
done
BEFORE_COUNT="$(wc -l <"$EVIDENCE/containers-before.txt" | tr -d ' ')"
echo "   containers owned by this run before: $BEFORE_COUNT"

# --- the lifecycle ----------------------------------------------------------
say "run the TypeScript lifecycle"
LIFECYCLE_LOG="$EVIDENCE/lifecycle.log"
KERNEL_PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$STATE/run.json")"
[ -n "$KERNEL_PORT" ] || fatal "could not read the kernel port from $STATE/run.json"
export OPSWEAVE_URL="http://127.0.0.1:${KERNEL_PORT}"
export OPSWEAVE_ADMIN_EMAIL="admin@opsweave.local"
export OPSWEAVE_ADMIN_PASSWORD='OpsWeave!2026'
export OPSWEAVE_EVIDENCE_DIR="$EVIDENCE"
# Each node in this run has its own HOME; the CLI session must be the one the
# harness created, or the lifecycle signs in as nobody.
HOME="$STATE/home" tests/acceptance/e2e_platform.sh 2>&1 | tee "$LIFECYCLE_LOG"
LIFECYCLE_STATUS="${PIPESTATUS[0]}"
if [ "$LIFECYCLE_STATUS" != "0" ]; then
  printf '\nlifecycle FAILED (exit %d); the log is %s\n' "$LIFECYCLE_STATUS" "$LIFECYCLE_LOG" >&2
fi

# --- container ownership, after --------------------------------------------
say "verify the run removed only what it created"
for id in $INSTALL_IDS; do
  docker ps -a --filter "label=opsweave.installation-id=$id" --format '{{.ID}} {{.Names}}' \
    >>"$EVIDENCE/containers-after.txt" 2>/dev/null || true
done
AFTER_COUNT="$(wc -l <"$EVIDENCE/containers-after.txt" | tr -d ' ')"
echo "   containers owned by this run after:  $AFTER_COUNT"

# A container belonging to ANOTHER installation must still be running. This is
# the C1.2 boundary, checked here against whatever else is on the daemon rather
# than against a planted stub.
# The first version of this check ran the comparison inside `docker ps | while`,
# i.e. a pipeline subshell, so FOREIGN_SAFE=0 was set in a process that had
# already exited and the check could never fail. It was a green that asserted
# nothing - exactly the failure mode this phase exists to remove. The list is
# now materialised first and the loop reads it from a file.
FOREIGN_SAFE=1
if [ "$SHARED" = "1" ]; then
  FOREIGN_FILE="$EVIDENCE/foreign-containers.txt"
  docker ps -a --format '{{.ID}}|{{.Label "opsweave.installation-id"}}' 2>/dev/null \
    | awk -F'|' -v ours=" $INSTALL_IDS " '
        { label = $2 }
        label == "" || label == "<no value>" { next }
        index(ours, " " label " ") > 0 { next }
        { print $1 }
      ' >"$FOREIGN_FILE" || : >"$FOREIGN_FILE"
  FOREIGN_COUNT="$(wc -l <"$FOREIGN_FILE" | tr -d ' ')"
  while read -r cid; do
    [ -n "$cid" ] || continue
    if ! docker inspect "$cid" >/dev/null 2>&1; then
      echo "FOREIGN CONTAINER REMOVED: $cid" >&2
      FOREIGN_SAFE=0
    fi
  done <"$FOREIGN_FILE"
  if [ "$FOREIGN_SAFE" = "1" ]; then
    echo "   every foreign container survived ($FOREIGN_COUNT checked)"
  else
    echo "FAIL  the run removed a container belonging to another installation" >&2
    LIFECYCLE_STATUS=1
  fi
else
  echo "   (dedicated daemon: there were no foreign containers to preserve)"
fi

# --- teardown ---------------------------------------------------------------
# Runs on every path, keeps its own failures out of the verdict, and removes
# only this run's resources. `p001c_teardown.sh` is already scoped by run id and
# reports BLOCKED on anything it cannot attribute.
say "tear down"
if [ "$KEEP" = "1" ]; then
  echo "   --keep: the platform is still up as $RUN_ID; tear down with:"
  echo "     tests/ci/p001c_teardown.sh $RUN_ID --purge"
else
  tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$EVIDENCE/teardown.log" 2>&1
  TEARDOWN_STATUS=$?
  if [ "$TEARDOWN_STATUS" != "0" ]; then
    echo "   teardown reported a problem (exit $TEARDOWN_STATUS); see $EVIDENCE/teardown.log" >&2
    tail -20 "$EVIDENCE/teardown.log" >&2 || true
  fi
fi
# The registry this script started is this script's to remove. It is not the
# platform's, and p001c_teardown knows nothing about it.
if [ "$started_registry" = "1" ] && [ "$KEEP" != "1" ]; then
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
fi

say "result"
if [ "$LIFECYCLE_STATUS" = "0" ]; then
  echo "PASS  the full TypeScript lifecycle completed in one isolated run"
  exit 0
fi
echo "FAIL  the lifecycle did not complete; see $LIFECYCLE_LOG and $EVIDENCE"
exit "$LIFECYCLE_STATUS"
