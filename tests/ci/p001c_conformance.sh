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
  if [ -n "$RUN_ID" ]; then
    if [ "$KEEP" = "1" ]; then
      echo "   --keep: the platform is still up as $RUN_ID"
      echo "     tests/ci/p001c_teardown.sh $RUN_ID --purge"
    else
      if tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$EVIDENCE/teardown.log" 2>&1; then
        echo "cleanup: PASS"
      else
        echo "cleanup: FAIL (see $EVIDENCE/teardown.log)"
        [ "$code" -eq 0 ] && code=1
      fi
    fi
  fi
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

say "build the binaries and bundles the platform needs"
cargo build --locked -p opsweave-kernel -p opsweave-node -p opsweave-opsctl \
  >"$EVIDENCE/build.log" 2>&1 || { echo "BLOCKED: the workspace did not build; see $EVIDENCE/build.log" >&2; exit 3; }
[ -f keys/publisher.key ] || ./target/debug/opsctl keygen --out-dir keys >>"$EVIDENCE/build.log" 2>&1
scripts/build-plugins.sh >>"$EVIDENCE/build.log" 2>&1 \
  || { echo "BLOCKED: the plugin bundles did not build; see $EVIDENCE/build.log" >&2; exit 3; }

say "start an isolated platform"
RUN_ID="$(tests/ci/p001c_up.sh 2>&1 | tee "$EVIDENCE/platform-up.log" | sed -n 's/^RUN_ID=//p' | tail -1)"
[ -n "$RUN_ID" ] || blocked "p001c_up.sh did not print a RUN_ID; see $EVIDENCE/platform-up.log"
echo "RUN_ID=$RUN_ID" >"$EVIDENCE/run.txt"

# `p001c_up.sh` exports the URLs it chose; re-derive them from its own log so
# this script and the platform cannot disagree.
KERNEL_URL="$(grep -oE 'KERNEL_URL=http[^ ]+' "$EVIDENCE/platform-up.log" | tail -1 | cut -d= -f2-)"
[ -n "$KERNEL_URL" ] || KERNEL_URL="http://127.0.0.1:18181"
echo "KERNEL_URL=$KERNEL_URL" >>"$EVIDENCE/run.txt"

say "sign in"
./target/debug/opsctl --url "$KERNEL_URL" login \
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
  if out="$(./target/debug/opsctl --url "$KERNEL_URL" deploy "$plugin" 0.0.1 \
              --replicas 1 --selector role=node --wait 2>&1)"; then
    echo "$out" >>"$EVIDENCE/deploy.log"
  elif printf '%s' "$out" | grep -q 'VERSION_ALREADY_ACTIVE'; then
    echo "$plugin: already deployed at 0.0.1 (not a failure)" >>"$EVIDENCE/deploy.log"
  else
    echo "$plugin: deploy failed: $out" >>"$EVIDENCE/deploy.log"
    return 1
  fi
  if out="$(./target/debug/opsctl --url "$KERNEL_URL" activate "$plugin" 0.0.1 2>&1)"; then
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
  ./target/debug/opsctl --url "$KERNEL_URL" install \
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
OPSWEAVE_URL="$KERNEL_URL" python3 tests/contract/conformance_matrix.py 2>&1 | tee "$EVIDENCE/matrix.log"
MATRIX_STATUS=${PIPESTATUS[0]}
set -e

# The original happy-path prober keeps its own record; its result is reported
# beside the matrix, not merged into it.
say "run the original happy-path prober"
OPSWEAVE_URL="$KERNEL_URL" python3 tests/contract/run_conformance.py >"$EVIDENCE/conformance.log" 2>&1
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
