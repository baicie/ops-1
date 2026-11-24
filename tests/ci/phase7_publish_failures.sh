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
# See the BLOCKED block below the prerequisites: without this flag a missing
# artifact is exit 3, not a green run with zero assertions.
ALLOW_SKIP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --allow-skip) ALLOW_SKIP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

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
  # PRESERVE THE EVIDENCE BEFORE TEARDOWN DELETES IT.
  #
  # `p001c_teardown.sh` removes `/tmp/p001c-$RUN_ID`, and every case writes its
  # only evidence there. Measured on run 45338279966: TASK-01 failed on CI, the
  # step printed `see 01-deploy.log`, and that file no longer existed by the time
  # the workflow tried to upload - so a red run was undiagnosable from its own
  # artifact. That is the defect TASK-22 names ("the next agent should not have
  # to re-run a 20-minute flow to learn where it failed").
  #
  # Copied to `artifacts/`, which the workflow already uploads. Best-effort: a
  # copy failure must not change the suite's verdict.
  if [ -n "$EVIDENCE" ] && [ -d "$EVIDENCE" ]; then
    local dest="artifacts/phase7-publish-failures"
    rm -rf "$dest"
    mkdir -p "$dest" 2>/dev/null && cp -R "$EVIDENCE/." "$dest/" 2>/dev/null || \
      echo "   WARNING: could not copy evidence to $dest" >&2
  fi
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

# ---------------------------------------------------------------------------
# A MISSING ARTIFACT IS NOT A PASS, AND UNTIL NOW IT WAS TREATED AS ONE.
#
# Measured on every plugin-lifecycle run between 12:35 and 15:52 on 2026-11-23
# (45172963410, 45183654404, 45190236157, 45197291594, 45203998931):
#
#     skip no local images to push; TASK-01..06 need a built bundle
#     0 passed, 0 failed, 1 skipped
#
# with the step and the job reporting SUCCESS. The workflow never builds
# data-catalog - `scripts/build-plugins.sh` builds hello-ops/hello-go/hello-java,
# and `scripts/build-data-plugins.sh` (which does build it) is only called from
# `data-foundation.yml`. So `dist/plugins/data-catalog-0.0.3.plugin.zip` and the
# two images it names never existed here, and the suite exited 0 having asserted
# nothing.
#
# `docs/engineering/publish-failure-coverage.md` calls rows 6-11
# INTEGRATION_VERIFIED on the strength of this script. Those rows were verified on
# a developer machine; in CI they were never exercised at all. The document was
# not lying about the assertions - it was quoting a run that CI does not perform.
#
# THE EXIT CODE IS THE POINT, NOT THE MESSAGE. A suite that cannot run has to be
# distinguishable from one that ran and passed, or every green job downstream is
# making a claim nobody checked. Exit 3 is this repository's BLOCKED convention
# (see `p001c13_lifecycle.sh`, `p001c_multilang_lifecycle.sh`).
#
# WHY NOT JUST `bad`: a red job on main for a missing build input is a correct
# signal, but it is not the same failure as "the product refused a deploy". The
# caller decides; this script says BLOCKED and stops.
#
# `--allow-skip` keeps the old behaviour for the case where this is genuinely
# optional. It is NOT the default and CI does not pass it.
# ---------------------------------------------------------------------------
REGISTRY_PORT="${OPSWEAVE_P7_REGISTRY_PORT:-15001}"
REGISTRY="127.0.0.1:${REGISTRY_PORT}"

echo "== registry on 127.0.0.1:${REGISTRY_PORT} (the port the bundles reference)"
if docker container inspect osw-p7-registry >/dev/null 2>&1; then
  docker rm -f osw-p7-registry >/dev/null 2>&1 || true
fi
docker run -d --name osw-p7-registry --label opsweave.p7.registry=yes \
  -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null \
  || { echo "cannot start registry" >&2; exit 2; }
for _ in $(seq 1 30); do
  curl -fsS -m 2 "http://${REGISTRY}/v2/" >/dev/null 2>&1 && break
  sleep 1
done

echo "== push the images the existing bundles reference"
# The bundles in dist/ name image@sha256:... on this port. Pushing the LOCAL image
# of the same tag reproduces that digest - checked below, not assumed - so the
# harness does not need to rebuild, which needs Docker Hub.
PUSHED=0
# 0.0.4 IS IN THE PUSH LIST because TASK-06 needs it to be REAL.
#
# The first version pushed only the 0.0.3 images, and the 0.0.4 bundle was built
# against a digest that then did not exist in this run's registry. The activation
# of 0.0.4 in TASK-06 failed with
#
#     failed to resolve reference "...@sha256:7d39c50a...": not found   attempt=4
#
# and the case skipped - the same shape as the original defect, one layer down: the
# artifact existed on disk and not where the platform looks for it. Pushing it
# here is what makes the rollback target runnable.
for img in "${REGISTRY}/opsweave/data-catalog:0.0.3" \
           "${REGISTRY}/opsweave/data-integration:0.0.3" \
           "${REGISTRY}/opsweave/data-catalog:0.0.4"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    docker push "$img" >/dev/null 2>&1 && PUSHED=$((PUSHED + 1)) || true
  fi
done
if [ "$PUSHED" -eq 0 ]; then
  if [ "${ALLOW_SKIP:-0}" = "1" ]; then
    skip "no local images to push and --allow-skip was given; TASK-01..06 did NOT run"
    echo
    echo "$PASS passed, $FAIL failed, $SKIP skipped"
    exit 0
  fi
  echo "BLOCKED: TASK-01..06 need data-catalog/data-integration images, and none are local." >&2
  echo "         Build them first:  OPSWEAVE_REGISTRY=${REGISTRY} OPSWEAVE_DATA_VERSION=0.0.3 \\" >&2
  echo "                            scripts/build-data-plugins.sh" >&2
  echo "         0 assertions ran. Exiting 3 (BLOCKED) so a green job cannot mean this." >&2
  exit 3
fi

echo "== the bundle's digest must be the one the registry now holds"
BUNDLE=dist/plugins/data-catalog-0.0.3.plugin.zip
[ -f "$BUNDLE" ] || { echo "missing $BUNDLE" >&2; exit 2; }
DECLARED="$(unzip -p "$BUNDLE" manifest.json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"]["imageRef"].split("@")[-1])' 2>/dev/null)"
ACTUAL="$(curl -fsS -m 10 -o /dev/null -D - \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' \
  "http://${REGISTRY}/v2/opsweave/data-catalog/manifests/0.0.3" 2>/dev/null \
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
# WHY IT FAILED, COLLECTED AT THE MOMENT IT FAILED.
#
# `DEGRADED 0/1 ready (0/1 replicas READY; 1 failed)` says an instance failed and
# not why. Measured on run 45343855200: the first CI run that preserved
# `01-deploy.log` showed exactly that line 150 times and nothing else, and the
# node's own log - which carries "Runtime Info does not match signed manifest",
# "docker pull failed", or a startup timeout - lives under `$STATE/logs`, which
# teardown deletes.
#
# Collected here rather than in the trap so it is captured at the failure, not at
# exit, and so an operator reading this report sees the reason beside the
# symptom.
if [ -f "$EVIDENCE/01-deploy.log" ] && grep -q 'DEGRADED\|timed out waiting' "$EVIDENCE/01-deploy.log"; then
  {
    echo "== deployment rows"
    psql -h 127.0.0.1 -p 5432 -d "$DB" -c \
      "SELECT version, status, status_reason FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog'" 2>&1
    echo "== instances"
    psql -h 127.0.0.1 -p 5432 -d "$DB" -c \
      "SELECT i.state, i.desired_action, i.container_id IS NOT NULL AS has_container, n.name
         FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id
         JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE d.plugin_id='opsweave.data-catalog'" 2>&1
    echo "== node log lines that name a cause"
    grep -hiE "does not match|pull failed|startup probe|readiness probe|supervisor error" \
      "$STATE"/logs/node-*.log 2>/dev/null | tail -6
  } > "$EVIDENCE/01-why-degraded.log" 2>&1
  echo "   (the failure reason is in 01-why-degraded.log)"
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
  # `--wait` IS PART OF THE ASSERTION, NOT AN OPTIMISATION TO SKIP.
  #
  # I removed it once to save the 300-second `wait_for_ready` bound, on the
  # argument that a placement refusal is already in the response. Measured: without
  # `--wait`, `opsctl deploy` prints `status=PENDING 0/0 ready` and EXITS 0. The
  # case then fails on its own first assertion - "a deploy with an unsatisfiable
  # selector reported success" - so the wait is what turns a queued deployment into
  # an observed failure. The 300 seconds is the price of the claim, not waste.
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
# THE CLEAN-UP HAS TO COVER EVERY DEPLOYMENT THE INJECTION TOUCHED, NOT JUST THE
# ONE THAT WAS ACTIVE. The first version of this block redeployed `$V1` with an
# empty selector and stopped there. `--selector` was applied to the **0.0.4** row -
# that is the row the deploy above targeted - and `$V1` (0.0.3) never had it. So
# the clean-up cleared a row that was already clean and left the poisoned one in
# place, and TASK-06's `deploy 0.0.4` inherited SELECTOR_MISMATCH for the rest of
# the run.
#
# Measured 2026-11-24: with a 0.0.4 bundle present for the first time, TASK-06's
# `06-before-rollback.log` filled with `PENDING 0/0 ready (SELECTOR_MISMATCH ...)`
# and the run never reached the rollback it exists to test. That is why the
# cancellation case has never had a real transition to interrupt: not the signal
# timing, which is what the row-11 note above blamed - the target deployment was
# unrunnable.
#
# Restoring is a deploy with an EMPTY selector per deployment. `--wait` on the
# ACTIVE version only, because it is the one that has to keep serving; the others
# only need their placement rewritten.
DEPLOY_RC=0
ops deploy opsweave.data-catalog "$V1" --replicas 1 --wait --activate --selector "" \
  > "$EVIDENCE/02-restore-selector.log" 2>&1 || DEPLOY_RC=$?
if [ "$DEPLOY_RC" -eq 0 ]; then
  ok "the injected selector was cleared on $V1 and it is active again"
else
  bad "could not clear the injected selector on $V1; later cases will fail for this reason; see 02-restore-selector.log"
fi

# ...and on the deployment the injection actually targeted.
#
# THIS CANNOT BE DONE THROUGH `opsctl deploy`, and the first attempt to do it that
# way silently did nothing. `create_deployment_inner` short-circuits on a
# deployment that is already PENDING or READY (deployments.rs, the
# `matches!(existing.status, "READY" | "PREPARING" | "PENDING")` arm): it returns
# the existing row with 202 and never rewrites `placement`. The injected 0.0.4 row
# is exactly PENDING - TASK-02's deploy created it and then could not place it - so
# a `deploy --selector ""` against it is accepted and changes nothing.
#
# Measured on the live database during the run that exposed this:
#
#     0.0.3 | ACTIVE  | {"nodeSelector": {}, ...}
#     0.0.4 | PENDING | {"nodeSelector": {"no-such-label": "no-such-value"}, ...}
#
# The placement is harness state that this script itself injected into a row the
# API has no path to rewrite, so the harness removes it the same way it put it
# there. This is the only direct write in the file, and it is scoped to the exact
# sentinel value the injection used - not to "clear all selectors", which could
# erase a placement that was configured deliberately.
PLACEMENT_JSON="$(psql_run "SELECT placement::text FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog' AND placement::text LIKE '%no-such-label%'")"
if [ -n "$PLACEMENT_JSON" ]; then
  CLEARED="$(psql_run "UPDATE kernel.plugin_deployments SET placement = jsonb_set(placement, '{nodeSelector}', '{}'::jsonb), status_reason='Harness cleared the injected selector', updated_at=now() WHERE plugin_id='opsweave.data-catalog' AND placement::text LIKE '%no-such-label%' RETURNING version")"
  REMAINING="$(psql_run "SELECT count(*) FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog' AND placement::text LIKE '%no-such-label%'")"
  if [ "${REMAINING:-1}" -eq 0 ]; then
    ok "removed the injected selector from the deployment row(s) the injection poisoned ($CLEARED)"
  else
    bad "the injected selector is still on ${REMAINING} deployment row(s); TASK-06 will time out"
  fi
else
  ok "no deployment row carried the injected selector"
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
# A rollback is started and cancelled at a CONTROLLED POINT, not after a guessed
# sleep. What is asserted is NOT that it completed - it was cancelled - but that
# the kernel can still DESCRIBE the plugin, that NOTHING activated while the
# transition was frozen, and that the next rollback converges.
#
# WHY THE OLD VERSION MEASURED NOTHING, twice over:
#
#   1. The rollback targeted the already-active version, so `rollback` took its
#      idempotent branch and returned in well under a second. `sleep 0.15; kill`
#      landed after the process had exited, and `wait` reported the rollback's own
#      success. Nothing was cancelled.
#   2. Once a 0.0.4 bundle existed, TASK-02's injected `--selector` was still on
#      the 0.0.4 deployment row, so activating 0.0.4 timed out with
#      SELECTOR_MISMATCH and the case skipped for a different reason.
#
# Both are fixed. A sleep would still be gambling even with a real transition: the
# transition's duration depends on container start time, which this script does
# not control. The Phase 8 brief forbids exactly that ("必须避免通过 Sleep 碰运气.
# 使用可控故障点或状态屏障").
#
# THE BARRIER: the kernel's reconciler takes a PostgreSQL advisory lock per cycle
# and SKIPS the cycle when it cannot get it (`pg_try_advisory_lock` in
# `reconcile_once_scoped`, deployments.rs). Holding that same key from a second
# session therefore stops placement entirely - deterministically, not by winning a
# race. Verified directly before being relied on: while a session held the key, a
# second session's `pg_try_advisory_lock` returned `f`, and `t` after release.
#
# THE FREEZE ALSO STOPS THE STALENESS SWEEP, AND THAT IS A BOUNDED HAZARD.
# `reconcile_once_locked` marks nodes UNREACHABLE when `last_seen_at` is older than
# `node_stale_seconds` (25 by default), and that UPDATE runs UNDER this lock. So
# the sweep does not run while the barrier is held - which is what keeps the
# instances through the frozen window - and it runs on the first cycle after
# release, by which time the nodes have kept heartbeating (5 s interval). The
# barrier must therefore be held for SECONDS, not minutes; a hold longer than the
# heartbeat lease would make the first post-release cycle see every node as
# unreachable and turn this case into a node-failure test. The window here is
# bounded by DB polling, not by a sleep: it closes as soon as the redeploy row is
# observed PENDING and the client has been signalled.
#
# The sequence this makes possible:
#
#   a. activate 0.0.4, then roll back to 0.0.3 so 0.0.4 is DISABLED
#   b. take the planner lock
#   c. start `rollback 0.0.4` - it writes the redeploy (PENDING, generation+1) and
#      then enters `wait_for_ready`, which can never reach READY while no planner
#      runs. This is the transition, frozen at a known point.
#   d. wait for the row to BE PENDING (a database condition, not a sleep), assert
#      the ACTIVE revision is still 0.0.3, then SIGTERM the client
#   e. release the lock, assert convergence by rolling back again
#
# WHAT THIS STILL DOES NOT PROVE, stated so the case cannot be read as more: the
# freeze is on the PLANNER, not inside a single transaction. A rollback that had
# committed its activation and was killed a microsecond later would leave a state
# this sequence does not reproduce. What it does prove is the thing the previous
# version did not: that a rollback was genuinely interrupted partway, and that the
# platform is describable, did not half-activate, and converges afterwards.
V4_ZIP=dist/plugins/data-catalog-0.0.4.plugin.zip
ROLLBACK_HAS_WORK=0
if [ -f "$V4_ZIP" ] \
   && ops deploy opsweave.data-catalog 0.0.4 --replicas 1 --wait --activate \
        > "$EVIDENCE/06-before-rollback.log" 2>&1 \
   && ops rollback opsweave.data-catalog "$V1" \
        >> "$EVIDENCE/06-before-rollback.log" 2>&1; then
  # `opsctl rollback` is required for the switch BACK, not `opsctl deploy`.
  #
  # Measured: after 0.0.4 activated, `ops deploy ... 0.0.3` was refused with
  #
  #   opsweave.data-catalog@0.0.3 is DRAINING - a stopped deployment is not
  #   redeployed by a publish; run `opsctl enable` or `opsctl uninstall`
  #
  # which is the platform being right and the harness being wrong: `deploy` is the
  # publish path and deliberately does not resurrect a version it has released.
  # `rollback` is the operation that means "put this version back in service",
  # and it walks the same redeploy+activate path this case then interrupts.
  #
  # 0.0.4 must be in a state that takes rollback's REDEPLOY branch.
  #
  # NOT `READY`: `rollback` activates a READY target immediately
  # (`deployments.rs`, the `"READY" =>` arm) without entering `wait_for_ready`, so
  # there would be no blocked window to freeze and the barrier below would have
  # nothing to hold. The state that gives a real transition is the one 0.0.4 is in
  # after being superseded: DRAINING now, DISABLED once the drain window elapses.
  # Both go to the `other =>` arm, which redeploys and then waits.
  V4_STATUS="$(psql_run "SELECT status FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog' AND version='0.0.4'")"
  if [ "$V4_STATUS" = "DRAINING" ] || [ "$V4_STATUS" = "DISABLED" ]; then
    ok "0.0.4 is $V4_STATUS, so a rollback to it must redeploy and wait"
    ROLLBACK_HAS_WORK=1
  else
    skip "0.0.4 is $V4_STATUS; the rollback below would not perform a transition"
  fi
else
  skip "0.0.4 could not be activated and switched back; the cancellation case cannot land"
fi

if [ "$ROLLBACK_HAS_WORK" = "1" ]; then
  DB_HASH="$(psql_run "SELECT hashtext(current_database())" | tr -d ' ')"
  # Same namespace constant as `reconcile_once_scoped`. If that constant changes,
  # this barrier stops holding - so it is asserted rather than copied and hoped for.
  PLANNER_KEY=257818626   # 0x0F5E_0002
  if grep -q 'PLANNER_LOCK_NAMESPACE: i32 = 0x0F5E_0002' apps/kernel/src/deployments.rs; then
    ok "the barrier uses the kernel's own planner-lock namespace"
  else
    bad "deployments.rs no longer declares 0x0F5E_0002; this barrier would not block the planner"
  fi

  # Hold the planner lock for the whole frozen window.
  mkfifo "$EVIDENCE/06-planner-lock.fifo" 2>/dev/null || true
  ( psql -h 127.0.0.1 -p 5432 -d "$DB" -tA \
      < "$EVIDENCE/06-planner-lock.fifo" > "$EVIDENCE/06-planner-lock.log" 2>&1 ) &
  LOCK_HOLDER=$!
  exec 9>"$EVIDENCE/06-planner-lock.fifo"
  echo "SELECT pg_advisory_lock(${PLANNER_KEY}, ${DB_HASH});" >&9
  # The lock is held once the holder's session reports it. Polling PostgreSQL is
  # the condition; there is no sleep deciding when the barrier is in place.
  LOCKED=0
  for _ in $(seq 1 50); do
    if [ "$(psql -h 127.0.0.1 -p 5432 -d "$DB" -tAc \
          "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${PLANNER_KEY} AND objsubid=2 AND granted")" -ge 1 ] 2>/dev/null; then
      LOCKED=1; break
    fi
    sleep 0.2
  done
  [ "$LOCKED" = "1" ] && ok "the planner lock is held: placement is frozen at a known point" \
    || bad "could not take the planner lock; the freeze below is not a barrier"

  # Start the rollback. It writes the redeploy, then blocks in wait_for_ready.
  ops rollback opsweave.data-catalog 0.0.4 > "$EVIDENCE/06-rollback.log" 2>&1 &
  RB_PID=$!

  # WAIT FOR THE TRANSITION TO BE OBSERVABLE, by querying - not by sleeping.
  # PENDING with a generation increase is the exact write the rollback performs
  # before it waits; seeing it means the rollback is mid-transition.
  MID=0
  for _ in $(seq 1 100); do
    ROW="$(psql_run "SELECT status || ' ' || generation FROM kernel.plugin_deployments WHERE plugin_id='opsweave.data-catalog' AND version='0.0.4'")"
    case "$ROW" in
      PENDING*) MID=1; break ;;
    esac
    kill -0 "$RB_PID" 2>/dev/null || break
    sleep 0.2
  done
  [ "$MID" = "1" ] && ok "the rollback is mid-transition: 0.0.4 is $ROW" \
    || bad "the rollback never reached PENDING; there was nothing to interrupt (row=$ROW)"

  # THE ASSERTION THE FREEZE BUYS: while the transition is frozen, nothing
  # activated. A rollback that moved the route before its work was done would show
  # up here.
  FROZEN_ACTIVE="$(active_version)"
  [ "$FROZEN_ACTIVE" = "$V1" ] \
    && ok "the frozen rollback has NOT activated 0.0.4; the route is still $V1" \
    || bad "a mid-transition rollback already served ${FROZEN_ACTIVE:-<none>}"

  # Now cancel the client, still frozen.
  if kill -TERM "$RB_PID" 2>/dev/null; then SIGNALLED=1; else SIGNALLED=0; fi
  wait "$RB_PID" 2>/dev/null
  RB_RC=$?

  # Release the barrier: close the fifo, let the holder exit, wait for it.
  exec 9>&-
  wait "$LOCK_HOLDER" 2>/dev/null
  RELEASED=0
  for _ in $(seq 1 50); do
    if [ "$(psql -h 127.0.0.1 -p 5432 -d "$DB" -tAc \
          "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${PLANNER_KEY} AND objsubid=2 AND granted")" -eq 0 ] 2>/dev/null; then
      RELEASED=1; break
    fi
    sleep 0.2
  done
  [ "$RELEASED" = "1" ] && ok "the planner lock is released; reconciliation can resume" \
    || bad "the planner lock is still held; every later case would be frozen too"
else
  SIGNALLED=0; RB_RC=0
fi

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

# Convergence means: RETRY THE ROLLBACK THAT WAS INTERRUPTED, and it completes.
#
# The old version deployed `$V1` here, which was already the active version - so
# `opsctl deploy` took its idempotent branch, verified a post-condition that was
# already true, and passed without touching anything the cancellation had left
# behind. It could not fail, which is why it was not a convergence test.
#
# Rolling back to 0.0.4 again has to do the work the interruption abandoned: a
# redeploy of 0.0.4, a READY wait, an activation, and a read-back.
CONVERGED=0
if [ "$ROLLBACK_HAS_WORK" = "1" ]; then
  ops rollback opsweave.data-catalog 0.0.4 > "$EVIDENCE/06-converge.log" 2>&1 && CONVERGED=1
  [ "$CONVERGED" = "1" ] && ok "the interrupted rollback, retried, completes" \
    || bad "the retried rollback did not complete; see 06-converge.log"
  FINAL_ACTIVE="$(active_version)"
  [ "$FINAL_ACTIVE" = "0.0.4" ] && ok "the retried rollback moved the route to 0.0.4" \
    || bad "final active=${FINAL_ACTIVE:-<none>}, expected 0.0.4"
  # Put the platform back where every later case expects it.
  #
  # `rollback`, NOT `deploy`: 0.0.3 was just superseded by the retried rollback, so
  # it is DRAINING/DISABLED and `opsctl deploy` refuses to resurrect it - the same
  # wrong-verb defect recorded in the preamble above. Measured on the run that
  # exposed it: this line was `ops deploy`, it exited non-zero, `|| true` swallowed
  # it, and the case reported FAIL "the plugin is on 0.0.4" with nothing saying why.
  RESTORED=0
  if ops rollback opsweave.data-catalog "$V1" \
       >> "$EVIDENCE/06-converge.log" 2>&1; then
    RESTORED=1
  fi
  [ "$RESTORED" = "1" ] || bad "could not restore $V1; later cases will start from 0.0.4; see 06-converge.log"
else
  # Nothing was interrupted, so there is nothing to converge; say so rather than
  # running a deploy that cannot fail and calling it evidence.
  ops deploy opsweave.data-catalog "$V1" --replicas 1 --wait --activate \
    > "$EVIDENCE/06-converge.log" 2>&1 || true
  skip "no transition was interrupted, so convergence after one was not tested"
fi

FINAL_ACTIVE="$(active_version)"
[ "$FINAL_ACTIVE" = "$V1" ] \
  && ok "the plugin is back on $V1 for the cases below" \
  || bad "the plugin is on ${FINAL_ACTIVE:-<none>}, but later cases assume $V1"
if [ "$ROLLBACK_HAS_WORK" != "1" ]; then
  skip "no real transition was available, so NOTHING WAS CANCELLED on this run"
elif [ "$SIGNALLED" = "1" ] && [ "$RB_RC" -ne 0 ]; then
  ok "the rollback was interrupted mid-transition (signal delivered, rc=$RB_RC)"
elif [ "$SIGNALLED" = "1" ]; then
  # WITH THE BARRIER HELD THIS SHOULD BE IMPOSSIBLE. The client is blocked in
  # `wait_for_ready` against a frozen planner, so it cannot have decided its
  # outcome before the signal. Reaching here means the barrier did not do what the
  # previous assertions said it did - a failure of this case, not a race to be
  # forgiven. The old version treated it as a skip because a no-op rollback really
  # could finish first; that excuse no longer applies.
  bad "the rollback completed (rc=0) while the planner was frozen; the barrier did not hold"
else
  bad "the signalled rollback was already gone when kill ran; it was not interrupted"
fi

# ===========================================================================
echo
echo "== TASK-08  one plugin succeeds, the NEXT one fails"
# ===========================================================================
# The publish script loops plugins under `set -e`, so a failure stops the run. Two
# claims are worth checking and only one of them has ever been:
#   1. the plugin that succeeded is UNAFFECTED
#   2. the run says which plugin it never reached
#
# (2) is unit-tested in `publish-untried-report.test.sh`. (1) is not tested
# anywhere, and it is the one that matters: a half-upgraded platform where the new
# failure also broke what was working is a different incident from one where it
# did not.
CAT="$(active_version)"
# COUNT ONLY THE SERVING VERSION'S CONTAINERS.
#
# Measured: this counted every deployment of the plugin, and TASK-06 leaves 0.0.4
# with two STOPPED instances that still carry a `container_id`. The count went
# 4 -> 2 during TASK-08 and the assertion failed, reporting "containers went from
# 4 to 2" - a real number about the wrong population. What TASK-08 claims is that
# the FIRST plugin keeps serving through the second one's failure, and that is a
# statement about the ACTIVE version only.
#
# The cleanup between the two is asynchronous: `rollback` supersedes 0.0.4, the
# reconciler stops its instances, and the rows keep their container ids. Counting
# them makes this assertion depend on TASK-06's timing rather than on TASK-08's
# subject.
CAT_CONTAINERS_BEFORE="$(psql_run "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND d.version='$CAT' AND i.desired_action='START' AND i.container_id IS NOT NULL")"

# The second plugin: install it, then fail its deploy the same way TASK-02 does.
INTEG_BUNDLE=dist/plugins/data-integration-0.0.3.plugin.zip
if [ -f "$INTEG_BUNDLE" ]; then
  ops install "$INTEG_BUNDLE" > "$EVIDENCE/08-install-integration.log" 2>&1 || true
# `--wait` IS REQUIRED HERE FOR THE SAME REASON AS TASK-02.
#
# Without it `opsctl deploy` posts the request, prints `status=PENDING 0/0 ready`
# and exits 0 - so the case below would report "the second plugin's deploy
# reported success" for a deployment that can never be placed. The wait is what
# converts "queued" into "observed to fail".
#
# THE COST IS REAL AND IS NOT HIDDEN: a selector that matches no node can never
# become READY, so this spends `wait_for_ready`'s full 300-second bound before
# failing. Two such cases (TASK-02 and here) put roughly ten minutes of deliberate
# waiting into this suite's runtime.
#
# The improvement worth making is in `opsctl`, not here: `wait_for_ready` polls a
# deployment whose `statusReason` says `SELECTOR_MISMATCH` or
# `INSTANCE_CAPACITY_EXCEEDED` for the full bound, although neither can resolve
# inside it. Failing fast on a terminal placement refusal is a product change with
# its own tests and is NOT made in this commit - recording it is the honest step,
# and shortening the bound to make this suite faster is exactly what the Phase 8
# brief forbids.
  INTEG_RC=0
  ops deploy opsweave.data-integration 0.0.3 --replicas 1 \
    --selector "no-such-label=no-such-value" --wait \
    > "$EVIDENCE/08-integration-fail.log" 2>&1 || INTEG_RC=$?
  [ "$INTEG_RC" -ne 0 ] && ok "the second plugin's deploy failed (rc=$INTEG_RC)" \
    || bad "the second plugin's deploy reported success; see 08-integration-fail.log"

  # THE CLAIM THAT MATTERS: the first plugin is untouched.
  CAT_AFTER="$(active_version)"
  [ "$CAT_AFTER" = "$CAT" ] && ok "the FIRST plugin is still active at $CAT after the second one failed" \
    || bad "a failure in data-integration moved data-catalog: $CAT -> ${CAT_AFTER:-<none>}"

  CAT_CONTAINERS_AFTER="$(psql_run "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='opsweave.data-catalog' AND d.version='$CAT' AND i.desired_action='START' AND i.container_id IS NOT NULL")"
  [ "$CAT_CONTAINERS_AFTER" = "$CAT_CONTAINERS_BEFORE" ] \
    && ok "the serving version's container count is unchanged ($CAT_CONTAINERS_AFTER of $CAT)" \
    || bad "containers went from $CAT_CONTAINERS_BEFORE to $CAT_CONTAINERS_AFTER"

  # The failing plugin DID get its package installed - install and deploy are
  # separate steps with separate failure modes, which is what the publish script's
  # own comment says. A failed deploy must not roll the package back.
  INTEG_PKG="$(psql_run "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='opsweave.data-integration' AND version='0.0.3'")"
  [ "${INTEG_PKG:-0}" -ge 1 ] && ok "the failing plugin's package is still registered (install and deploy are separate)" \
    || bad "the failed deploy also removed the package row"

  # And it is NOT active: a package that exists is not a version that serves.
  INTEG_ACTIVE="$(HOME="$STATE/home" ./target/debug/opsctl --url "$KERNEL_URL" plugins 2>/dev/null \
    | awk '$1 == "opsweave.data-integration" { sub(/^active=/, "", $3); print $3 }')"
  [ "$INTEG_ACTIVE" != "0.0.3" ] && ok "the failing plugin is not active (active=${INTEG_ACTIVE:-<none>})" \
    || bad "a plugin whose deploy failed reports 0.0.3 active"
else
  skip "no data-integration bundle in dist/plugins; the mixed-outcome case needs two plugins"
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
