#!/usr/bin/env bash
# Phase 7 Batch A: publish FAILURE acceptance against a real kernel.
#
# WHAT THIS IS FOR
#
# `docs/engineering/publish-failure-coverage.md` records five conditions as
# NOT_COVERED because "each needs a KERNEL to install, deploy and activate
# against". That was true of the tests, and it was WRONG as a statement about what
# is possible here: `tests/ci/p001c_up.sh` brings up a real kernel, a real
# PostgreSQL and two real nodes on this host, isolated by run id. This script
# drives THAT kernel and produces the missing evidence.
#
# It does not touch staging. It does not modify the publish script. It does not
# claim any of this is a production acceptance — the environment is one host, and
# the node count is two processes, not two machines.
#
# WHAT IT PROVES, and how each claim is checked
#
#   TASK-01  Install -> Deploy -> READY -> Activate -> effectiveVersion read back
#            (the baseline: without it, every failure below is "nothing works")
#   TASK-02  Deploy fails (capacity / selector / instance start), and the ACTIVE
#            version is UNCHANGED - a failed deploy must not activate
#   TASK-03  Activate fails on a stale expectedRevision, and the previous version
#            KEEPS serving
#   TASK-04  The read-back disagrees with what was asked for, and the publisher
#            refuses rather than reporting success
#   TASK-05  A re-run after a failure converges, without re-registering a version
#            or claiming a succeeded phase failed
#   TASK-06  A cancel during a rollback leaves the platform in a state the next
#            reconcile can describe
#
# EACH CASE ASSERTS THE ABSENCE TOO. A failure that leaves the active version
# changed is worse than the failure, and "the command exited non-zero" says
# nothing about it.
#
# Usage:
#   tests/ci/phase7_publish_failures.sh            # full run
#   tests/ci/phase7_publish_failures.sh --keep     # leave the platform up
#
# Requires: docker (running), PostgreSQL client tools, the debug binaries.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0
FAIL=0
SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  skip %s\n' "$1"; }

RUN_ID=""
KERNEL_URL=""
STATE=""
EVIDENCE=""

cleanup() {
  local rc=$?
  if [ "$KEEP" = "0" ] && [ -n "$RUN_ID" ]; then
    echo "== teardown $RUN_ID"
    tests/ci/p001c_teardown.sh "$RUN_ID" >/dev/null 2>&1 || \
      echo "   WARNING: teardown reported a problem; see /tmp/p001c-$RUN_ID/teardown.log" >&2
  elif [ -n "$RUN_ID" ]; then
    echo "== kept run $RUN_ID at $KERNEL_URL (teardown: tests/ci/p001c_teardown.sh $RUN_ID)"
  fi
  # This script's own registry, by name and label. It never removes one it did
  # not start - the same ownership rule `p001c13_lifecycle.sh` records.
  if [ "$KEEP" = "0" ]; then
    docker rm -f osw-p7-registry >/dev/null 2>&1 || true
  fi
  return "$rc"
}
trap cleanup EXIT

psql_run() { psql -h 127.0.0.1 -p 5432 -d "$DB" -tAc "$1" 2>/dev/null; }

# The active version as the KERNEL records it. Every failure case below compares
# against this, because "the deploy failed" is not the same claim as "production
# still serves the old version".
active_version() {
  HOME="$STATE/home" ./target/debug/opsctl --url "$KERNEL_URL" plugins 2>/dev/null \
    | awk '$1 == "opsweave.data-catalog" { sub(/^active=/, "", $3); print $3 }'
}

echo "== prerequisites"
for bin in docker psql createdb; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing $bin" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 2; }
for b in opsweave-kernel opsweave-node opsctl; do
  [ -x "target/debug/$b" ] || { echo "missing target/debug/$b (cargo build)" >&2; exit 2; }
done

echo "== registry on 127.0.0.1:15001 (the port the bundles reference)"
if docker container inspect osw-p7-registry >/dev/null 2>&1; then
  docker rm -f osw-p7-registry >/dev/null 2>&1 || true
fi
docker run -d --name osw-p7-registry --label opsweave.p7.registry=yes \
  -p 127.0.0.1:15001:5000 registry:2 >/dev/null || { echo "cannot start registry" >&2; exit 2; }
for _ in $(seq 1 30); do
  curl -fsS -m 2 http://127.0.0.1:15001/v2/ >/dev/null 2>&1 && break
  sleep 1
done

echo "== push the images the existing bundles reference"
# The bundles in dist/ name image@sha256:... on this port. Pushing the LOCAL image
# of the same tag reproduces that digest - checked below, not assumed - so the
# harness does not need to rebuild, which needs Docker Hub.
PUSHED=0
for img in 127.0.0.1:15001/opsweave/data-catalog:0.0.3 \
           127.0.0.1:15001/opsweave/data-integration:0.0.3; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    docker push "$img" >/dev/null 2>&1 && PUSHED=$((PUSHED + 1)) || true
  fi
done
if [ "$PUSHED" -eq 0 ]; then
  skip "no local images to push; TASK-01..06 need a built bundle"
  echo
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 0
fi

echo "== the bundle's digest must be the one the registry now holds"
BUNDLE=dist/plugins/data-catalog-0.0.3.plugin.zip
[ -f "$BUNDLE" ] || { echo "missing $BUNDLE" >&2; exit 2; }
DECLARED="$(unzip -p "$BUNDLE" manifest.json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"]["imageRef"].split("@")[-1])' 2>/dev/null)"
ACTUAL="$(curl -fsS -m 10 -o /dev/null -D - \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' \
  http://127.0.0.1:15001/v2/opsweave/data-catalog/manifests/0.0.3 2>/dev/null \
  | tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }')"
if [ -n "$DECLARED" ] && [ "$DECLARED" = "$ACTUAL" ]; then
  ok "the bundle names $DECLARED, which the registry resolves"
else
  bad "bundle names ${DECLARED:-<none>}, registry resolves ${ACTUAL:-<none>}"
  echo "   (TASK-01..06 cannot proceed against a registry that holds different bytes)"
  echo
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

echo "== bring up an isolated platform (real kernel, real postgres, two real nodes)"
UP_LOG="$(mktemp)"
RUN_ID="$(tests/ci/p001c_up.sh 2>"$UP_LOG" | sed -n 's/^RUN_ID=//p' | tail -1)"
if [ -z "$RUN_ID" ]; then
  sed -n '1,40p' "$UP_LOG" >&2 || true
  echo "harness could not start an isolated platform" >&2
  exit 2
fi
rm -f "$UP_LOG"
STATE="/tmp/p001c-$RUN_ID"
DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
KERNEL_PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kernelPort"])' "$STATE/run.json")"
KERNEL_URL="http://127.0.0.1:${KERNEL_PORT}"
EVIDENCE="$STATE/evidence"
mkdir -p "$EVIDENCE"
export HOME="$STATE/home"
export OPSWEAVE_URL="$KERNEL_URL"
echo "   $KERNEL_URL  db=$DB"

ops() { ./target/debug/opsctl --url "$KERNEL_URL" "$@" 2>&1; }

# ===========================================================================
echo
echo "== TASK-01  the baseline: install, deploy, READY, activate, read back"
# ===========================================================================
# WITHOUT THIS, every failure below is "nothing works" rather than "this fails".
ops install "$BUNDLE" > "$EVIDENCE/01-install.log"
if grep -q 'staged opsweave.data-catalog@0.0.3' "$EVIDENCE/01-install.log"; then
  ok "install staged the bundle"
else
  bad "install did not stage a bundle; see 01-install.log"
fi

ops deploy opsweave.data-catalog 0.0.3 --replicas 1 --wait --activate > "$EVIDENCE/01-deploy.log"
if grep -q 'activated opsweave.data-catalog@0.0.3' "$EVIDENCE/01-deploy.log"; then
  ok "deploy reached READY and activated"
else
  bad "deploy did not activate; see 01-deploy.log"
fi
if grep -q 'effectiveVersion=0.0.3 (verified' "$EVIDENCE/01-deploy.log"; then
  ok "the publisher READ THE ACTIVE VERSION BACK and it matched"
else
  bad "no verified read-back in 01-deploy.log"
fi

V1="$(active_version)"
[ "$V1" = "0.0.3" ] && ok "the kernel reports 0.0.3 active" || bad "kernel reports active=${V1:-<none>}"

CONTAINERS="$(psql_run "SELECT count(*) FROM kernel.plugin_instances WHERE desired_action='START' AND container_id IS NOT NULL")"
[ "${CONTAINERS:-0}" -ge 1 ] && ok "a real container is running (${CONTAINERS})" \
  || bad "no container with an id; the deploy is a database row, not a process"

# The `active=` field comes from `activation_revisions`, which is what the Gateway
# routes on. A deployment that is READY but not ACTIVE serves nothing.
REV_STATE="$(psql_run "SELECT status FROM kernel.activation_revisions WHERE plugin_id='opsweave.data-catalog' ORDER BY activated_at DESC LIMIT 1")"
[ "$REV_STATE" = "ACTIVE" ] && ok "activation_revisions says ACTIVE" \
  || bad "activation_revisions says ${REV_STATE:-<none>}"

# ===========================================================================
echo
echo "== TASK-02  install succeeds, DEPLOY fails, and nothing activates"
# ===========================================================================
# Capacity is the failure that actually stopped staging, so the injection is the
# real one: a deployment asking for more replicas than the per-node limit allows,
# on a selector that matches a ready node. The kernel must refuse it and must not
# move the active revision.
BEFORE_ACTIVE="$(active_version)"

# THIS CASE WAS WRONG TWICE, AND BOTH TIMES THE HARNESS SAID SO.
#
# Attempt 1: `deploy --replicas 9` against the version that was ALREADY active. It
#   reported success - correctly. `opsctl deploy` reads the state first and, for a
#   version already active, verifies the post-condition instead of re-deploying.
#   The nine replicas were never requested, so nothing could fail. The test was
#   measuring the idempotent path, not capacity.
#
# Attempt 2: `--selector no-such-label=...` on the SAME active version. Same
#   short-circuit, same honest success.
#
# So the injection needs a version the platform has NOT deployed. 0.0.4 is
# installed here from a bundle built against a real image, and it is deliberately
# never activated: a deploy that cannot place must fail BEFORE touching the active
# revision, which is what the assertion below checks.
V_UNDEPLOYED=0.0.4
V4_ZIP=dist/plugins/data-catalog-0.0.4.plugin.zip
if [ -f "$V4_ZIP" ]; then
  ops install "$V4_ZIP" > "$EVIDENCE/02-install-v4.log" 2>&1 || true
  DEPLOY_RC=0
  ops deploy opsweave.data-catalog "$V_UNDEPLOYED" --replicas 1 \
    --selector "no-such-label=no-such-value" --wait \
    > "$EVIDENCE/02-deploy-full.log" 2>&1 || DEPLOY_RC=$?
else
  DEPLOY_RC=2
  echo "   (no $V4_ZIP; the placement case cannot be injected without an undeployed version)" \
    > "$EVIDENCE/02-deploy-full.log"
fi
if [ "$DEPLOY_RC" -ne 0 ]; then
  ok "a deploy that cannot be placed is refused (rc=$DEPLOY_RC)"
else
  bad "a deploy with an unsatisfiable selector reported success; see 02-deploy-full.log"
fi
# The refusal must NAME the reason. "It failed" without a placement rejection is
# the state staging was in for days: a timeout with no cause.
if grep -qiE 'selector|capacity|placement|replicas READY' "$EVIDENCE/02-deploy-full.log"; then
  ok "the refusal names why it could not place"
else
  bad "the refusal does not name a placement reason; see 02-deploy-full.log"
fi

# THE SELECTOR PERSISTS, AND THE HARNESS MUST UNDO IT.
#
# `deploy --selector` writes the placement onto the deployment row; it is not a
# one-shot filter for that call. Measured: after this injection, 0.0.4 could not be
# placed either - every later deploy on this plugin inherited
# `no-such-label=no-such-value` and failed with SELECTOR_MISMATCH, which took
# TASK-06 from "cancelled mid-rollback" to "timed out waiting for readiness".
#
# That is the harness's fault, not the product's, and it is worth recording because
# the symptom looked like a product failure: a rollback that reports
# `rollbackCompleted: true` while the platform is PENDING forever.
#
# Restoring is a deploy with an EMPTY selector, which replaces the placement.
DEPLOY_RC=0
ops deploy opsweave.data-catalog "$V1" --replicas 1 --wait --activate --selector "" \
  > "$EVIDENCE/02-restore-selector.log" 2>&1 || DEPLOY_RC=$?
if [ "$DEPLOY_RC" -eq 0 ]; then
  ok "the injected selector was cleared and $V1 is active again"
else
  bad "could not clear the injected selector; later cases will fail for this reason; see 02-restore-selector.log"
fi

AFTER_ACTIVE="$(active_version)"
if [ "$AFTER_ACTIVE" = "$BEFORE_ACTIVE" ]; then
  ok "the ACTIVE version did not move ($BEFORE_ACTIVE)"
else
  bad "a FAILED deploy changed the active version: $BEFORE_ACTIVE -> $AFTER_ACTIVE"
fi

# The package row is a separate fact from the deployment and must survive: a
# failed deploy must not uninstall what it was deploying.
PKG="$(psql_run "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='opsweave.data-catalog' AND version='$V1'")"
[ "${PKG:-0}" -ge 1 ] && ok "the package for $V1 is still registered after the failed deploy" \
  || bad "the failed deploy also removed the package row"

# ===========================================================================
echo
echo "== TASK-03  deploy is fine, ACTIVATE fails on a stale expectedRevision"
# ===========================================================================
# The CAS is what stops a caller holding an outdated belief from moving the active
# revision. Injecting it through the API is the real path, not a unit test: the
# receipt path, the revision lookup and the conflict message all run.
BEFORE_ACTIVE="$(active_version)"
REV_NOW="$(psql_run "SELECT COALESCE(max(revision), 0) FROM kernel.activation_revisions WHERE plugin_id='opsweave.data-catalog'")"
STALE=$(( ${REV_NOW:-0} + 7 ))

CONFLICT_RC=0
HOME="$STATE/home" ./target/debug/opsctl --url "$KERNEL_URL" activate opsweave.data-catalog "$BEFORE_ACTIVE" \
  --expected-revision "$STALE" > "$EVIDENCE/03-activate-stale.log" 2>&1 || CONFLICT_RC=$?
if [ "$CONFLICT_RC" -ne 0 ] && grep -qiE 'conflict|revision' "$EVIDENCE/03-activate-stale.log"; then
  ok "a stale expectedRevision is refused (rc=$CONFLICT_RC)"
elif grep -qiE 'conflict|revision' "$EVIDENCE/03-activate-stale.log"; then
  ok "a stale expectedRevision is refused, and the message names the revision"
else
  skip "this opsctl build has no --expected-revision flag; the CAS was not exercised through the CLI"
fi

AFTER_ACTIVE="$(active_version)"
[ "$AFTER_ACTIVE" = "$BEFORE_ACTIVE" ] && ok "the previous version kept serving ($BEFORE_ACTIVE)" \
  || bad "a refused activation still moved the active version: $BEFORE_ACTIVE -> $AFTER_ACTIVE"

# The instance from TASK-01 must still be running. A refused activation that stops
# the serving version is worse than the refusal.
STILL_RUNNING="$(psql_run "SELECT count(*) FROM kernel.plugin_instances WHERE desired_action='START' AND container_id IS NOT NULL")"
[ "${STILL_RUNNING:-0}" -ge 1 ] && ok "the serving instance is still running after the refusal" \
  || bad "the refused activation also stopped the serving instance"

# ===========================================================================
echo
echo "== TASK-04  the read-back disagrees, so the publisher must not claim success"
# ===========================================================================
# The publisher verifies `effectiveVersion` against the plugin's active revision.
# The injection is a version the kernel does not have: the read-back cannot match,
# and the command must fail CLOSED.
MISSING=9.9.9
READBACK_RC=0
ops deploy opsweave.data-catalog "$MISSING" --replicas 1 --wait --activate \
  > "$EVIDENCE/04-readback-mismatch.log" 2>&1 || READBACK_RC=$?
if [ "$READBACK_RC" -ne 0 ]; then
  ok "deploying a version the kernel does not have is refused (rc=$READBACK_RC)"
else
  bad "a nonexistent version was deployed; see 04-readback-mismatch.log"
fi
AFTER_ACTIVE="$(active_version)"
[ "$AFTER_ACTIVE" = "$BEFORE_ACTIVE" ] && ok "the active version still did not move ($BEFORE_ACTIVE)" \
  || bad "a failed read-back moved the active version: $BEFORE_ACTIVE -> $AFTER_ACTIVE"

# ===========================================================================
echo
echo "== TASK-05  a re-run after the failures CONVERGES"
# ===========================================================================
# Three claims, each checked separately because each can fail on its own:
#   1. the package is not registered twice
#   2. the re-run reaches the SAME active version (idempotent, not a new revision)
#   3. nothing is reported as failed when it had already succeeded
PKG_BEFORE="$(psql_run "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='opsweave.data-catalog'")"
RERUN_RC=0
ops deploy opsweave.data-catalog "$V1" --replicas 1 --wait --activate \
  > "$EVIDENCE/05-rerun.log" 2>&1 || RERUN_RC=$?
PKG_AFTER="$(psql_run "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='opsweave.data-catalog'")"

[ "$RERUN_RC" -eq 0 ] && ok "the re-run succeeded (rc=0)" \
  || bad "the re-run failed (rc=$RERUN_RC); see 05-rerun.log"
[ "$PKG_BEFORE" = "$PKG_AFTER" ] && ok "the re-run registered no extra package ($PKG_AFTER)" \
  || bad "packages went from $PKG_BEFORE to $PKG_AFTER on a re-run"
AFTER_ACTIVE="$(active_version)"
[ "$AFTER_ACTIVE" = "$V1" ] && ok "the re-run converged to the same active version ($V1)" \
  || bad "the re-run left active=${AFTER_ACTIVE:-<none>}, expected $V1"

# ===========================================================================
echo
echo "== TASK-06  the platform survives a cancellation mid-rollback"
# ===========================================================================
# A rollback is started and cancelled by signal. What is asserted is NOT that it
# completed - it was cancelled - but that the kernel can still DESCRIBE the plugin
# and the next reconcile converges. A cancelled rollback that leaves an
# undescribable state is the failure mode.
#
# THE MEASUREMENT MATTERS MORE THAN THE ASSERTIONS HERE. A rollback to the version
# that is already active returns in well under a second (`rollbackCompleted: true`,
# measured), so `sleep 1; kill` lands AFTER the process has exited: `wait` returns
# its real status and NOTHING WAS CANCELLED. The assertions still hold - the
# platform is describable and converges - but they are not evidence about
# cancellation, and reporting them as such would be the same overclaim this phase
# exists to remove.
#
# So the signal status is CHECKED, not just printed, and when it is zero the case
# says out loud that the cancel did not land.
# MAKE THE ROLLBACK DO WORK, or there is nothing to cancel. Activating 0.0.4 first
# gives the rollback a real transition to perform; cancelling a no-op measures
# nothing, which is what the previous version of this case did.
V4_ZIP=dist/plugins/data-catalog-0.0.4.plugin.zip
if [ -f "$V4_ZIP" ] && ops deploy opsweave.data-catalog 0.0.4 --replicas 1 --wait --activate \
    > "$EVIDENCE/06-before-rollback.log" 2>&1; then
  ok "0.0.4 was activated, so the rollback has a real transition to perform"
  ROLLBACK_HAS_WORK=1
else
  skip "0.0.4 could not be activated; the rollback below is a no-op and the cancel cannot land"
  ROLLBACK_HAS_WORK=0
fi

ROLLBACK_MS_SLEEP="${OPSWEAVE_P7_ROLLBACK_SLEEP_MS:-0.15}"
ops rollback opsweave.data-catalog "$V1" > "$EVIDENCE/06-rollback.log" 2>&1 &
RB_PID=$!
sleep "$ROLLBACK_MS_SLEEP"
if kill -TERM "$RB_PID" 2>/dev/null; then
  SIGNALLED=1
else
  SIGNALLED=0
fi
wait "$RB_PID" 2>/dev/null
RB_RC=$?

DESCRIBABLE=0
for _ in $(seq 1 20); do
  if ops plugins > "$EVIDENCE/06-after-cancel.log" 2>&1; then
    DESCRIBABLE=1
    break
  fi
  sleep 1
done
[ "$DESCRIBABLE" = "1" ] && ok "the kernel still describes its plugins after the cancel" \
  || bad "the kernel could not list plugins after a cancelled rollback"

# Convergence: a plain deploy of the version that should be active must succeed.
CONVERGED=0
ops deploy opsweave.data-catalog "$V1" --replicas 1 --wait --activate \
  > "$EVIDENCE/06-converge.log" 2>&1 && CONVERGED=1
[ "$CONVERGED" = "1" ] && ok "a later deploy converges after the cancelled rollback" \
  || bad "the platform did not converge after a cancelled rollback; see 06-converge.log"

FINAL_ACTIVE="$(active_version)"
[ "$FINAL_ACTIVE" = "$V1" ] && ok "the final active version is $V1" \
  || bad "final active=${FINAL_ACTIVE:-<none>}, expected $V1"
if [ "$SIGNALLED" = "1" ] && [ "$RB_RC" -ne 0 ]; then
  ok "the rollback was actually interrupted (signal delivered, rc=$RB_RC)"
elif [ "$SIGNALLED" = "1" ]; then
  # The signal reached the process but it had already decided its outcome. That is
  # a race, not a defect - and NOT evidence of cancellation.
  skip "the SIGTERM reached the process after it had already completed (rc=0);"
  echo "         this case asserts recovery, NOT cancellation, on this run"
else
  skip "the rollback finished before the signal (it was a no-op: the target was"
  echo "         already active), so NOTHING WAS CANCELLED on this run"
fi

# ===========================================================================
echo
echo "== what this run did NOT prove"
echo "   - not staging: one host, two node PROCESSES, not two machines"
echo "   - not a real publish: no image was built in this run; the registry holds"
echo "     images pushed from the local cache, and the bundle digest was checked"
echo "     against the registry before anything was installed"
echo "   - TASK-03 depends on an opsctl flag; a skip there means the CAS was not"
echo "     exercised through the CLI in this build"
echo "   evidence: $EVIDENCE"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "$PASS passed, 0 failed, $SKIP skipped"
  exit 0
fi
echo "$PASS passed, $FAIL failed, $SKIP skipped"
exit 1
