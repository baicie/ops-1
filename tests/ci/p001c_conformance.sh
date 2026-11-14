#!/usr/bin/env bash
# P001-C3: run the Runtime conformance matrix against a real, isolated platform.
#
# ## What this replaces
#
# `tests/contract/run_conformance.sh` logs in and runs the probes. It assumes a
# platform is already up, with all three plugins already deployed and active -
# which is why it has only ever been run by hand. Nothing in CI invoked it, so
# the three-language assertion it makes has never gated anything.
#
# This launcher borrows the platform from `tests/ci/p001c_up.sh`, which is the
# isolated one: a per-run database, per-run state directories, per-run ports and
# container ownership by this run's node ids. It then deploys and activates the
# three reference plugins itself, so the matrix does not depend on a previous
# scenario having left them in the right state.
#
# ## Fail-closed, and honest about the difference
#
#   missing Docker daemon   -> BLOCKED, exit 3
#   missing PostgreSQL      -> BLOCKED, exit 3
#   a language never became READY -> the matrix reports NOT_RUN for it, exit 2
#   a language disagreed with the contract -> FAIL, exit 1
#   everything measured and conforming -> PASS, exit 0
#
# Exit 3 is "the environment was not there"; exit 2 is "the product could not be
# measured"; exit 1 is "the product disagreed". Collapsing those into one code
# is how an environment failure gets reported as a product result.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

EVIDENCE="$ROOT/artifacts/p001c-conformance"
mkdir -p "$EVIDENCE"
RUN_ID=""
KEEP="${OPSWEAVE_CONFORMANCE_KEEP:-0}"

say() { echo "==> $*"; }
blocked() { echo "BLOCKED: $*" >&2; exit 3; }

cleanup() {
  local code=$?
  trap - EXIT TERM INT
  # ORDER: the platform first, its registry second.
  #
  # `p001c_teardown.sh` stops the nodes, which may still be reconciling
  # containers that pull from this registry. Removing the registry first would
  # turn a clean shutdown into a pull failure and then report the cleanup as
  # broken. The registry was created before the platform and is removed after it.
  local cleanup_failed=0
  if [ -n "$RUN_ID" ]; then
    if [ "$KEEP" = "1" ]; then
      echo "   --keep: the platform is still up as $RUN_ID"
      echo "     tests/ci/p001c_teardown.sh $RUN_ID --purge"
    elif tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$EVIDENCE/teardown.log" 2>&1; then
      echo "cleanup: platform PASS"
    else
      echo "cleanup: platform FAIL (see $EVIDENCE/teardown.log)"
      cleanup_failed=1
    fi
  fi
  if [ "${CREATED_REGISTRY:-0}" = "1" ]; then
    if docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1; then
      echo "cleanup: registry PASS"
    else
      echo "cleanup: registry FAIL ($REGISTRY_NAME could not be removed)"
      cleanup_failed=1
    fi
  fi
  [ "$cleanup_failed" -eq 0 ] || [ "$code" -ne 0 ] || code=1
  exit "$code"
}
trap cleanup EXIT TERM INT

# --- preconditions, stated as BLOCKED rather than discovered later -------------
command -v docker >/dev/null 2>&1 || blocked "no docker binary"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || blocked "the Docker daemon is not reachable; this matrix needs real containers"
command -v psql >/dev/null 2>&1 || blocked "no psql; the platform harness needs PostgreSQL client tools"
pg_isready -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" >/dev/null 2>&1 \
  || blocked "PostgreSQL is not reachable at ${PGHOST:-127.0.0.1}:${PGPORT:-5432}"

# `localhost` resolves to ::1 on this runner, and a registry published on
# 127.0.0.1 does not answer there. Measured on the first real run:
#   Get "http://localhost:5001/v2/": dial tcp [::1]:5001: connect: connection refused
# `no_proxy` is what the C1.3 lifecycle driver already does for the same reason.
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

REGISTRY_PORT="${OPSWEAVE_TEST_REGISTRY_PORT:-5014}"
REGISTRY_NAME="opsweave-conformance-registry-$REGISTRY_PORT"
CREATED_REGISTRY=0

# This registry is this run's, and ownership is established before anything is
# removed - the same rule the lifecycle driver applies, for the same reason.
if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
  OWNER="$(docker inspect -f '{{index .Config.Labels "opsweave.conformance.registry"}}' "$REGISTRY_NAME" 2>/dev/null || echo '')"
  if [ "$OWNER" != "yes" ]; then
    echo "BLOCKED: a container named $REGISTRY_NAME exists and was not created by this script; refusing to remove it" >&2
    exit 3
  fi
else
  docker run -d --name "$REGISTRY_NAME" --label "opsweave.conformance.registry=yes" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null \
    || { echo "BLOCKED: could not start a local registry on 127.0.0.1:${REGISTRY_PORT}" >&2; exit 3; }
  CREATED_REGISTRY=1
fi
for _ in $(seq 1 30); do
  curl -fsS -m 2 "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1 && break
  sleep 1
done

say "build the binaries and bundles the platform needs"
cargo build --locked -p opsweave-kernel -p opsweave-node -p opsweave-opsctl \
  >"$EVIDENCE/build.log" 2>&1 || { echo "BLOCKED: the workspace did not build; see $EVIDENCE/build.log" >&2; exit 3; }
[ -f keys/publisher.key ] || ./target/debug/opsctl keygen --out-dir keys >>"$EVIDENCE/build.log" 2>&1
# `BUILD=1` is what makes the script actually build images; without it the
# bundles step is skipped and every later install fails with "package not found".
OPSWEAVE_REGISTRY="localhost:${REGISTRY_PORT}" BUILD=1 \
  scripts/build-plugins.sh >>"$EVIDENCE/build.log" 2>&1 \
  || { echo "BLOCKED: the plugin bundles did not build; see $EVIDENCE/build.log" >&2; exit 3; }

say "start an isolated platform"
RUN_ID="$(tests/ci/p001c_up.sh 2>&1 | tee "$EVIDENCE/platform-up.log" | sed -n 's/^RUN_ID=//p' | tail -1)"
[ -n "$RUN_ID" ] || blocked "p001c_up.sh did not print a RUN_ID; see $EVIDENCE/platform-up.log"
echo "RUN_ID=$RUN_ID" >"$EVIDENCE/run.txt"

# The harness chooses the port and the HOME. Both must be read from ITS output:
# it starts the Kernel on a derived port (measured: 18621, not 18181) and writes
# the session under `<run dir>/home`, not `~/.opsweave`. Hardcoding either
# produced `Connection refused` on the first real run and would have done so on
# every run - the first version of this script assumed both.
KERNEL_URL="$(sed -n 's/^== platform up: //p' "$EVIDENCE/platform-up.log" | tail -1)"
RUN_DIR="$(sed -n 's/^RUN_DIR=//p' "$EVIDENCE/platform-up.log" | tail -1)"
[ -n "$KERNEL_URL" ] || blocked "p001c_up.sh did not report a platform URL; see $EVIDENCE/platform-up.log"
[ -n "$RUN_DIR" ] || blocked "p001c_up.sh did not report a RUN_DIR; see $EVIDENCE/platform-up.log"
{
  echo "KERNEL_URL=$KERNEL_URL"
  echo "RUN_DIR=$RUN_DIR"
} >>"$EVIDENCE/run.txt"

say "sign in"
HOME="$RUN_DIR/home" ./target/debug/opsctl --url "$KERNEL_URL" login \
  --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" \
  --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >"$EVIDENCE/login.log" 2>&1 \
  || blocked "sign-in failed; see $EVIDENCE/login.log"

# --- deploy and activate all three languages ---------------------------------
#
# A deployment that is already active is not a failure: re-running this launcher
# against a kept platform must not turn `VERSION_ALREADY_ACTIVE` into a red
# result. That distinction cost a whole CI job in C1.3, so it is made here once.
deploy_and_activate() {
  local plugin="$1"
  local out
  if out="$(HOME="$RUN_DIR/home" ./target/debug/opsctl --url "$KERNEL_URL" deploy "$plugin" 0.0.1 \
              --replicas 1 --selector role=node --wait 2>&1)"; then
    echo "$out" >>"$EVIDENCE/deploy.log"
  elif printf '%s' "$out" | grep -q 'VERSION_ALREADY_ACTIVE'; then
    echo "$plugin: already deployed at 0.0.1 (not a failure)" >>"$EVIDENCE/deploy.log"
  else
    echo "$plugin: deploy failed: $out" >>"$EVIDENCE/deploy.log"
    return 1
  fi
  if out="$(HOME="$RUN_DIR/home" ./target/debug/opsctl --url "$KERNEL_URL" activate "$plugin" 0.0.1 2>&1)"; then
    echo "$out" >>"$EVIDENCE/deploy.log"
  elif printf '%s' "$out" | grep -qi 'already active'; then
    echo "$plugin: 0.0.1 already active" >>"$EVIDENCE/deploy.log"
  else
    echo "$plugin: activate failed: $out" >>"$EVIDENCE/deploy.log"
    return 1
  fi
}

: >"$EVIDENCE/deploy.log"
# Plugin id -> bundle file stem. The stems are what `scripts/build-plugins.sh`
# writes (`hello-ops-0.0.1`, `hello-go-0.0.1`, `hello-java-0.0.1`); deriving them
# from the id with `${plugin#dev.opsweave.}` yields `hello-0.0.1`, which does not
# exist. Named explicitly so a rename in either place is a visible edit rather
# than a 404 at install time.
conformance_plugins() {
  printf '%s %s\n' \
    dev.opsweave.hello      hello-ops-0.0.1 \
    dev.opsweave.hello-go   hello-go-0.0.1 \
    dev.opsweave.hello-java hello-java-0.0.1
}

while read -r plugin stem; do
  [ -n "$plugin" ] || continue
  say "install $plugin"
  [ -f "dist/plugins/$stem.plugin.zip" ] \
    || { echo "$plugin: bundle dist/plugins/$stem.plugin.zip is missing; the matrix will report it NOT_RUN" | tee -a "$EVIDENCE/deploy.log"; continue; }
  HOME="$RUN_DIR/home" ./target/debug/opsctl --url "$KERNEL_URL" install \
    "dist/plugins/$stem.plugin.zip" >>"$EVIDENCE/deploy.log" 2>&1 \
    || echo "$plugin: install failed (it may already be installed)" >>"$EVIDENCE/deploy.log"
  if deploy_and_activate "$plugin"; then
    say "  $plugin deployed and active"
  else
    say "  $plugin could not be deployed; the matrix will report it NOT_RUN"
  fi
done < <(conformance_plugins)

# --- the matrix ---------------------------------------------------------------
say "run the conformance matrix"
set +e
HOME="$RUN_DIR/home" OPSWEAVE_URL="$KERNEL_URL" python3 tests/contract/conformance_matrix.py 2>&1 | tee "$EVIDENCE/matrix.log"
MATRIX_STATUS=${PIPESTATUS[0]}
set -e

# The original happy-path prober keeps its own record; its result is reported
# beside the matrix, not merged into it.
say "run the original happy-path prober"
HOME="$RUN_DIR/home" OPSWEAVE_URL="$KERNEL_URL" python3 tests/contract/run_conformance.py >"$EVIDENCE/conformance.log" 2>&1
BASELINE_STATUS=$?
echo "baseline prober exit=$BASELINE_STATUS" >>"$EVIDENCE/run.txt"

# --- verdict ------------------------------------------------------------------
echo
echo "matrix:   exit $MATRIX_STATUS"
echo "baseline: exit $BASELINE_STATUS"
case "$MATRIX_STATUS" in
  0) echo "RUNTIME CONFORMANCE: PASS" ;;
  2) echo "RUNTIME CONFORMANCE: BLOCKED (a language could not be measured - see the matrix)" ;;
  *) echo "RUNTIME CONFORMANCE: FAIL (a language disagreed with the contract - see the matrix)" ;;
esac

# The baseline prober failing is a finding even when the matrix passed: it
# asserts things this matrix does not (the gateway's forged-header handling).
if [ "$BASELINE_STATUS" -ne 0 ] && [ "$MATRIX_STATUS" -eq 0 ]; then
  echo "RUNTIME CONFORMANCE: FAIL (the baseline prober failed; see $EVIDENCE/conformance.log)"
  exit 1
fi
exit "$MATRIX_STATUS"
