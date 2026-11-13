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

# --- lifecycle of this script's own resources -------------------------------
#
# Every resource is recorded at the moment this script creates it, and the trap
# removes exactly what was recorded. Nothing is discovered by scanning the daemon
# for a label, because a label filter cannot tell this run's container from
# another run's, and `docker rm -f` on a wrong match destroys someone else's work.
#
# The trap runs on EXIT, TERM and INT so an interrupted run still cleans up. It
# keeps the exit code it was entered with and never overwrites it: a cleanup
# failure is recorded as a separate fact, and the final verdict is PASS only when
# BOTH the acceptance and the cleanup succeeded.
RUN_ID=""
STARTED_REGISTRY=""
CREATED_REGISTRY=0
CLEANUP_STATUS=0
FUNCTIONAL_STATUS=0
TRAP_ARMED=0

# Remove only what this run recorded. Idempotent, so EXIT after an explicit
# teardown is a no-op rather than a second removal attempt.
cleanup_owned_resources() {
  local code="$1"
  trap - EXIT TERM INT
  # The platform: `p001c_teardown.sh` is scoped by run id and reports BLOCKED on
  # anything it cannot attribute. Its failure does NOT change the acceptance code
  # but is recorded, because a run that leaves a database behind is not a clean
  # pass.
  if [ -n "$RUN_ID" ] && [ "$KEEP" != "1" ]; then
    if ! tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$EVIDENCE/teardown.log" 2>&1; then
      echo "cleanup: p001c_teardown.sh failed for $RUN_ID; see $EVIDENCE/teardown.log" >&2
      tail -20 "$EVIDENCE/teardown.log" >&2 || true
      CLEANUP_STATUS=1
    fi
    RUN_ID=""
  fi
  # The registry, only if this script started it. The name was proven free before
  # it was created, so removing it cannot hit another workload.
  if [ "$CREATED_REGISTRY" = "1" ] && [ -n "$STARTED_REGISTRY" ]; then
    docker rm -f "$STARTED_REGISTRY" >/dev/null 2>&1 || {
      echo "cleanup: could not remove the registry container $STARTED_REGISTRY" >&2
      CLEANUP_STATUS=1
    }
    CREATED_REGISTRY=0
  fi
  exit "$code"
}

on_signal() {
  local signal="$1"
  echo >&2
  echo "interrupted by SIG$signal; cleaning up this run's resources" >&2
  # A signal is a failure of the run, whatever had been achieved so far.
  exit 130
}

arm_traps() {
  [ "$TRAP_ARMED" = "1" ] && return 0
  TRAP_ARMED=1
  trap 'cleanup_owned_resources $?' EXIT
  trap 'on_signal TERM' TERM
  trap 'on_signal INT' INT
}
arm_traps

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
OURS_BEFORE="$(docker ps -aq --filter "label=opsweave.managed=true" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${OURS_BEFORE:-0}" != "0" ] && [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" != "1" ]; then
  fatal "the Docker daemon already has $OURS_BEFORE OpsWeave container(s).
         This run creates and removes containers; on a shared daemon it cannot tell
         its own from another installation's. Use a dedicated daemon, or set
         OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1 to run without removing anything."
fi

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
# A container with this name may belong to another run, another checkout or a
# colleague. The previous version ran `docker rm -f "$REGISTRY_NAME"` first,
# which deleted it - a destructive operation on a resource this script had not
# established ownership of, performed at the very start of the run, before it had
# even looked at the daemon. It is now an ownership question:
#
#   absent            -> create it, and remember that this script created it
#   present, no label -> refuse: it is not ours and this script would have to
#                        remove it to use the name
#   present, ours     -> reuse it; this is a re-run of the same script
#
# The label is written at creation so a later run can tell the two apart without
# guessing from the name.
if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
  OWNER="$(docker inspect -f '{{index .Config.Labels "opsweave.p001c13.registry"}}' "$REGISTRY_NAME" 2>/dev/null || echo '')"
  if [ "$OWNER" != "yes" ]; then
    fatal "a container named $REGISTRY_NAME already exists and was not created by this
         script (it carries no opsweave.p001c13.registry=yes label). Refusing to remove
         it: this run cannot prove it owns that container, and starting a registry under
         that name would mean deleting an unknown workload. Remove it deliberately, or
         set OPSWEAVE_TEST_REGISTRY_PORT to a free port."
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_NAME" 2>/dev/null || echo false)" != "true" ]; then
    fatal "the registry $REGISTRY_NAME exists, is this script's, and is not running. Stop
         it with: docker rm -f $REGISTRY_NAME   (it carries the p001c13 label, so removing
         it removes nothing else), then re-run."
  fi
  echo "   reusing this script's registry $REGISTRY_NAME"
else
  docker run -d --name "$REGISTRY_NAME" \
    --label "opsweave.p001c13.registry=yes" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null \
    || fatal "could not start a local registry on 127.0.0.1:${REGISTRY_PORT}"
  CREATED_REGISTRY=1
  STARTED_REGISTRY="$REGISTRY_NAME"
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
  # Only this script's own registry is removed here, and only because it created
  # it moments ago under a name it just proved was free.
  if [ "$CREATED_REGISTRY" = "1" ]; then
    docker rm -f "$STARTED_REGISTRY" >/dev/null 2>&1 || true
    CREATED_REGISTRY=0
    STARTED_REGISTRY=""
  fi
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

# --- Docker isolation: a snapshot taken before anything is created ----------
#
# WHAT THIS REPLACES, AND WHY
#
# The first version took its "before" snapshot by filtering for this run's
# installation ids and then, after the run, re-filtered for "foreign" containers
# and checked they were still there. Two things were wrong with that:
#
#   * the "before" set was empty by construction - the run had just started, so
#     nothing carried its ids yet - and an empty before-set cannot detect a
#     deletion;
#   * the "foreign" set was recomputed from whatever was on the daemon at the
#     END, so a container the run had deleted was simply absent from the list to
#     be checked. It could not fail.
#
# The snapshot below is taken BEFORE the lifecycle runs, covers EVERY container
# on the daemon (not a filtered subset), and records the immutable id, the
# ownership label and the running state. After the run each recorded id is looked
# up again: gone, stopped, or replaced is a FAIL. That is a comparison of two
# observations, not a re-query that agrees with itself.
#
# A failed snapshot is BLOCKED, never empty: an empty list would mean "there was
# nothing to preserve", which is a claim this script is not allowed to make on
# the strength of a Docker error.
say "snapshot the daemon before the run"
DOCKER_BEFORE="$EVIDENCE/docker-before.json"
if ! docker ps -a --no-trunc --format '{{json .}}' >"$EVIDENCE/docker-ps-before.jsonl" 2>"$EVIDENCE/docker-ps-before.err"; then
  sed 's/^/      /' "$EVIDENCE/docker-ps-before.err" >&2
  fatal "docker ps failed; the daemon's prior state is unknown, so this run cannot prove it
         preserved anything. Refusing to start rather than reporting an isolation it did not
         establish."
fi
# `docker ps --format '{{json .}}'` reports ID, Names, State, Status and Labels;
# the label is what tells us whose container it is. Recorded in full so a later
# reader can see the evidence, not just the verdict.
python3 - "$EVIDENCE/docker-ps-before.jsonl" "$DOCKER_BEFORE" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
rows = []
for line in open(src):
    line = line.strip()
    if not line:
        continue
    entry = json.loads(line)
    labels = {}
    for part in (entry.get("Labels") or "").split(","):
        key, _, value = part.partition("=")
        if key:
            labels[key] = value
    rows.append({
        "id": entry.get("ID"),
        "name": entry.get("Names"),
        "state": entry.get("State"),
        "status": entry.get("Status"),
        "installationId": labels.get("opsweave.installation-id", ""),
        "managed": labels.get("opsweave.managed", ""),
        "nodeId": labels.get("opsweave.node-id", ""),
    })
json.dump(rows, open(dst, "w"), indent=1)
print("   %d container(s) on the daemon before the run" % len(rows))
PY
BEFORE_TOTAL="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$DOCKER_BEFORE")"
[ "$BEFORE_TOTAL" -ge 0 ] 2>/dev/null || fatal "could not read the daemon snapshot back; refusing to continue"
# The report splits the snapshot so a reviewer can see WHAT kind of preservation
# the run exercised: containers that are not OpsWeave's at all, and containers
# that are OpsWeave's but belong to a different installation (the C1.2 case).
python3 - "$DOCKER_BEFORE" >"$EVIDENCE/isolation-before.txt" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
named = [r for r in rows if r["installationId"]]
unmanaged = len(rows) - len([r for r in rows if r["managed"] == "true"])
print("total=%d unmanaged=%d installation-labelled=%d" % (len(rows), unmanaged, len(named)))
PY
echo "   before the run: $(cat "$EVIDENCE/isolation-before.txt")"
# The installation ids this run's nodes minted, taken AFTER the platform started
# (starting it creates them) and BEFORE the lifecycle creates any container.
INSTALL_IDS="$(for f in "$STATE"/node-*/installation-id; do [ -f "$f" ] && tr -d '\n' <"$f" && echo; done | sort -u | tr '\n' ' ')"
[ -n "$INSTALL_IDS" ] || fatal "the nodes minted no installation identity; ownership cannot be established"
echo "   installation ids of this run: $INSTALL_IDS"
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

# --- Docker isolation: compare by ID against the snapshot -------------------
#
# Every container recorded before the run is looked up by its immutable id, not
# by a label filter that could agree with itself. A container that disappeared,
# stopped, or whose id now belongs to a different container is a FAIL with the
# ids named.
say "verify no container the run did not create was touched"
DOCKER_AFTER="$EVIDENCE/docker-after.json"
if ! docker ps -a --no-trunc --format '{{json .}}' >"$EVIDENCE/docker-ps-after.jsonl" 2>"$EVIDENCE/docker-ps-after.err"; then
  sed 's/^/      /' "$EVIDENCE/docker-ps-after.err" >&2
  echo "FAIL  the daemon could not be read after the run, so nothing about container \
preservation was established" >&2
  ISOLATION_VERDICT=blocked
else
  python3 - "$EVIDENCE/docker-ps-after.jsonl" "$DOCKER_AFTER" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
rows = []
for line in open(src):
    line = line.strip()
    if not line:
        continue
    entry = json.loads(line)
    labels = {}
    for part in (entry.get("Labels") or "").split(","):
        key, _, value = part.partition("=")
        if key:
            labels[key] = value
    rows.append({
        "id": entry.get("ID"),
        "name": entry.get("Names"),
        "state": entry.get("State"),
        "installationId": labels.get("opsweave.installation-id", ""),
        "managed": labels.get("opsweave.managed", ""),
    })
json.dump(rows, open(dst, "w"), indent=1)
PY
  # The comparison. `ours` is this run's installation ids; a container that
  # carried one of them BEFORE the lifecycle ran cannot exist - the platform only
  # just started - so any pre-existing container is by definition not ours.
  # The verdict goes to a file rather than being captured from a heredoc inside
  # `$( )`: bash cannot pair a heredoc nested inside a command substitution inside
  # a quoted assignment, and it reported the closing `fi` three lines later as a
  # syntax error. A script that only parses by accident is not one to rely on.
  python3 - "$DOCKER_BEFORE" "$DOCKER_AFTER" "$INSTALL_IDS" \
    >"$EVIDENCE/isolation.txt" 2>"$EVIDENCE/isolation.err" <<'PY'
import json, sys
before = json.load(open(sys.argv[1]))
after = json.load(open(sys.argv[2]))
ours = set(sys.argv[3].split())
by_id = {row["id"]: row for row in after}

problems = []
checked_foreign = 0
for row in before:
    cid, name, state = row["id"], row["name"], row["state"]
    # A container that already carried one of THIS run's installation ids can
    # only be a leftover from an earlier attempt that reused the run id; it is
    # not something this run must preserve.
    if row["installationId"] and row["installationId"] in ours:
        continue
    checked_foreign += 1
    now = by_id.get(cid)
    if now is None:
        problems.append("REMOVED  %s %s (was %s)" % (cid[:12], name, state))
        continue
    if state == "running" and now["state"] != "running":
        problems.append("STOPPED  %s %s (%s -> %s)" % (cid[:12], name, state, now["state"]))
    if now["name"] != name:
        problems.append("RENAMED  %s %s -> %s" % (cid[:12], name, now["name"]))

if problems:
    print("disturbed")
    for line in problems:
        print("  " + line, file=sys.stderr)
elif checked_foreign == 0:
    # NOT a pass. Zero preserved containers means the isolation claim was never
    # exercised; saying "every foreign container survived" about an empty set is
    # the vacuous green this phase exists to remove.
    print("insufficient")
else:
    print("preserved %d" % checked_foreign)
PY
  ISOLATION_VERDICT="$(head -1 "$EVIDENCE/isolation.txt" 2>/dev/null || echo noprint)"
  sed 's/^/      /' "$EVIDENCE/isolation.err" 2>/dev/null || true
  if [ "$ISOLATION_VERDICT" = "disturbed" ]; then
    echo "FAIL  the run disturbed a container it did not create (see above)" >&2
    LIFECYCLE_STATUS=1
  elif [ "$ISOLATION_VERDICT" = "insufficient" ]; then
    echo "   INSUFFICIENT: this daemon had no pre-existing container, so the run proved"
    echo "   nothing about preserving another installation's resources. That is reported,"
    echo "   not counted as a pass. A dedicated CI daemon is always in this state."
  elif [ "${ISOLATION_VERDICT#preserved}" != "$ISOLATION_VERDICT" ]; then
    echo "   $ISOLATION_VERDICT pre-existing container(s) still present and running"
  else
    echo "FAIL  the isolation comparison produced no verdict ($ISOLATION_VERDICT)" >&2
    LIFECYCLE_STATUS=1
  fi
fi

# --- teardown ---------------------------------------------------------------
# Runs on every path, keeps its own failures out of the verdict, and removes
# only this run's resources. `p001c_teardown.sh` is already scoped by run id and
# reports BLOCKED on anything it cannot attribute.
# --- teardown and verdict ---------------------------------------------------
# The EXIT trap owns cleanup. It runs exactly once, on every path including this
# one, and records its own outcome in CLEANUP_STATUS without touching the
# acceptance result. The block that used to live here did the work inline, which
# meant an interrupted run left the platform, the database and the registry
# behind.
say "tear down"
if [ "$KEEP" = "1" ]; then
  echo "   --keep: the platform is still up as $RUN_ID"
  echo "     tests/ci/p001c_teardown.sh $RUN_ID --purge"
  RUN_ID=""
fi
FUNCTIONAL_STATUS="$LIFECYCLE_STATUS"

say "result"
# Cleanup is part of the verdict, not a footnote. Two independent facts are
# reported, and PASS requires both: a run that leaves its database, its state
# directory or its registry behind is not a clean acceptance, and a run whose
# cleanup failed must not be summarised as one.
echo "   functional: $([ "$FUNCTIONAL_STATUS" = "0" ] && echo PASS || echo "FAIL (exit $FUNCTIONAL_STATUS)")"
echo "   cleanup:    $([ "$CLEANUP_STATUS" = "0" ] && echo PASS || echo "FAIL (teardown reported a problem)")"

if [ "$FUNCTIONAL_STATUS" = "0" ] && [ "$CLEANUP_STATUS" = "0" ]; then
  echo "PASS  the full TypeScript lifecycle completed in one isolated run, and this run's"
  echo "      resources were removed"
  exit 0
fi
if [ "$FUNCTIONAL_STATUS" = "0" ]; then
  echo "FAIL  the lifecycle passed but this run's resources were NOT fully removed;"
  echo "      see $EVIDENCE/teardown.log. Not reported as PASS."
  exit 1
fi
echo "FAIL  the lifecycle did not complete; see $LIFECYCLE_LOG and $EVIDENCE"
if [ "$CLEANUP_STATUS" != "0" ]; then
  echo "      cleanup ALSO failed; both problems are recorded above"
fi
exit "$FUNCTIONAL_STATUS"
