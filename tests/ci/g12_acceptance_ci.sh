#!/usr/bin/env bash
# G11/G12 acceptance and browser suite on a Linux CI host, against a real kernel on a
# throw-away PostgreSQL database.
#
# Why this file exists. Every G12 phase was accepted by hand on one workstation: the four
# tests/acceptance/g12_*.sh scripts and the seven tests/ui/g11*/g12* specs were referenced by
# zero workflows, so "199 assertions passed, 7 specs passed" was a claim CI could not reproduce.
# This harness starts the same two halves those runs used - a real kernel process on a fresh
# database, and a real browser against it - so a red run is red in the pipeline and not only in
# somebody's terminal.
#
# The kernel is started HERE rather than by tests/runtime/start_kernel.sh: that script hardcodes
# port 18181, the data-foundation database and its own seed accounts, and the G12 scripts create
# their own accounts through the admin API. Sharing it would put two suites in one database.
#
# Two environment-dependent behaviours are deliberate and reported by name, never silently:
#
#   * S8 of g12_ai_investigator.sh needs the kernel restarted with a related source authorised,
#     which this single-kernel harness does not do. The script prints SKIP for it; the count of
#     skipped steps is echoed here so a green run cannot be read as "all 199 ran".
#   * The evidence adapter secret below is generated per run and exported to BOTH the kernel
#     (OPSWEAVE_EVIDENCE_ADAPTERS) and g12_trusted_evidence.sh, because the script signs its own
#     attestations with the adapter's key. Nothing reads it back.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PORT="${OPSWEAVE_G12_PORT:-18199}"
export OPSWEAVE_URL="http://127.0.0.1:$PORT"
DB_NAME="${OPSWEAVE_G12_DB_NAME:-opsweave_g12}"
export OPSWEAVE_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/$DB_NAME"
export PGPASSWORD=postgres
export OPSWEAVE_ADMIN_EMAIL="admin@opsweave.local"
export OPSWEAVE_ADMIN_PASSWORD="OpsWeave!2026"
export OPSWEAVE_EVIDENCE_ADAPTER="g12-acceptance"
export OPSWEAVE_EVIDENCE_ADAPTER_SECRET="g12-acceptance-$(openssl rand -hex 16)"

LOG_DIR="$ROOT/artifacts/g12-ci"
mkdir -p "$LOG_DIR"
KERNEL_LOG="$LOG_DIR/kernel.log"
KERNEL_PID=""

cleanup() {
  local code=$?
  [ -n "$KERNEL_PID" ] && kill "$KERNEL_PID" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "== build kernel and web bundle"
cargo build -q -p opsweave-kernel
pnpm install --frozen-lockfile
pnpm --filter @opsweave/platform-web build >/dev/null

echo "== fresh database $DB_NAME"
psql "postgres://postgres:postgres@127.0.0.1:5432/postgres" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" \
  -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null

echo "== kernel on $OPSWEAVE_URL"
env \
  OPSWEAVE_BIND="127.0.0.1:$PORT" \
  OPSWEAVE_PUBLIC_URL="$OPSWEAVE_URL" \
  DATABASE_URL="$OPSWEAVE_DATABASE_URL" \
  OPSWEAVE_DATA_DIR="$ROOT/data-ci/g12" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-web/dist" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL="$OPSWEAVE_ADMIN_EMAIL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD="$OPSWEAVE_ADMIN_PASSWORD" \
  OPSWEAVE_BOOTSTRAP_ADMIN_NAME='Platform Admin' \
  OPSWEAVE_EVIDENCE_ADAPTERS="$OPSWEAVE_EVIDENCE_ADAPTER:$OPSWEAVE_EVIDENCE_ADAPTER_SECRET" \
  RUST_LOG=info \
  ./target/debug/opsweave-kernel > "$KERNEL_LOG" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 120); do
  curl -fsS "$OPSWEAVE_URL/livez" >/dev/null 2>&1 && break
  kill -0 "$KERNEL_PID" 2>/dev/null || { echo "the kernel died during startup; see $KERNEL_LOG" >&2; tail -40 "$KERNEL_LOG" >&2; exit 1; }
  sleep 0.5
done
curl -fsS "$OPSWEAVE_URL/livez" >/dev/null

# The adapter must actually be loaded, or g12_trusted_evidence.sh would fail every attestation
# for the wrong reason. config.rs logs the adapter IDS (never the secrets) once they parse, so
# this reads that line rather than trusting the environment block above.
grep -q 'source adapters configured to produce attested evidence' "$KERNEL_LOG" \
  || { echo "the kernel did not load OPSWEAVE_EVIDENCE_ADAPTERS; attested-evidence assertions would fail for the wrong reason" >&2; tail -40 "$KERNEL_LOG" >&2; exit 1; }

rc=0
run_acceptance() {
  local name="$1"; shift
  echo
  echo "######## acceptance: $name"
  if "$@" 2>&1 | tee "$LOG_DIR/acceptance-$name.log"; then
    echo "######## acceptance: $name -> PASS"
  else
    echo "######## acceptance: $name -> FAIL (see $LOG_DIR/acceptance-$name.log)"
    rc=1
  fi
}

# One script per kernel state. g12_trusted_evidence.sh needs the adapter secret; the other
# three read the same kernel and the same database, and each creates its own accounts.
run_acceptance trusted-evidence tests/acceptance/g12_trusted_evidence.sh
run_acceptance evidence-content tests/acceptance/g12_evidence_content.sh
run_acceptance lifecycle        tests/acceptance/g12_lifecycle.sh
run_acceptance closure-invariants tests/acceptance/g12_closure_invariants.sh
run_acceptance ai-investigator  tests/acceptance/g12_ai_investigator.sh

echo
echo "######## fixtures: the D-workspace seed"
# g12d-workspace.spec.ts reads the incident ids it navigates to from OPSWEAVE_SEED_OUT and never
# creates them itself - a spec that seeds its own data could pass against the rows it just wrote
# and say nothing about what a reader sees. That makes this step load-bearing: without it the
# spec reads a seed.json from some earlier run, navigates to an id that does not exist in THIS
# database, and every D assertion fails on "This incident is not visible to you" - which is the
# page behaving correctly, reported as a workspace defect. The seed logs in with the same admin
# this harness bootstrapped, so the credentials come from the exports above; the output path is
# pinned for the same reason, so the reader and the writer cannot drift apart.
export OPSWEAVE_SEED_OUT="${OPSWEAVE_SEED_OUT:-$ROOT/artifacts/g12d/seed.json}"
mkdir -p "$(dirname "$OPSWEAVE_SEED_OUT")"
rm -f "$OPSWEAVE_SEED_OUT"
if node tests/ui/g12d-seed.mjs > "$LOG_DIR/seed.log" 2>&1; then
  echo "######## fixtures: seed -> OK ($OPSWEAVE_SEED_OUT)"
else
  echo "######## fixtures: seed -> FAIL (see $LOG_DIR/seed.log)"
  tail -20 "$LOG_DIR/seed.log" >&2
  rc=1
fi

echo
echo "######## browser suite (real Chromium against $OPSWEAVE_URL)"
pnpm --filter @opsweave/ui-tests exec playwright install --with-deps chromium
# --config is resolved against the CWD, not the repository root: from the root it becomes
# tests/ui/tests/ui/playwright.config.ts. The specs also resolve their own support files and
# fixture paths relative to this directory, so the suite runs from here.
#
# dual-surface.spec.ts is FIRST for the same reason g11-incident-slice.spec.ts was added before
# it: it is the only spec that drives the sign-in lifecycle end to end, and the R4 round changed
# that lifecycle (the grant now arrives with the login body). It was referenced only by
# staging-preview - a REMOTE check - so a regression in sign-in could not fail any deterministic
# job. It runs here against a runner-local kernel and database, where the link is not a variable.
#
# g11-incident-slice.spec.ts was missing here while the two defects it catches went in, which is
# why it is first in the list rather than appended: it is the only spec that drives the incident
# list as an operator, and both regressions below were invisible to every other suite.
#   * the empty list was rendered from `listState` instead of the `scope` the kernel sends, so a
#     narrowed read printed "this read applied no owner narrowing" (asserted at :310);
#   * IdentityCell dropped `data-evidence-kind`, because JSX does not type-check hyphenated
#     attributes, so the evidence row carried no machine-readable kind (asserted at :178).
# The Visual System V1 flagship specs are part of this deterministic job, not the remote
# staging tier: the Overview matrix/states and the Observability matrix had no PR gate before
# this change. The Incident matrix is already g12d-workspace.spec.ts; incidents-workspace.spec.ts
# stays an explicit skip because its fixture expects a SOURCE_ATTESTED row the seed does not
# create (recorded in docs/design/opsweave-visual-system-v1/report.md).
if (cd tests/ui && V3_CHANNEL="${V3_CHANNEL:-chromium}" pnpm exec playwright test --config playwright.config.ts \
     dual-surface.spec.ts \
     g11-incident-slice.spec.ts \
     g11-incident-state-gaps.spec.ts \
     g12-create-gate.spec.ts \
     g11-page-header-growth.spec.ts \
     g12-incident-route-identity.spec.ts \
     g12-evidence-content.spec.ts \
     g12-lifecycle.spec.ts \
     g12d-workspace.spec.ts \
     overview-matrix.spec.ts \
     overview-partial.spec.ts \
     observability-surface.spec.ts \
     dialog-contract.spec.ts \
     dialog-geometry.spec.ts \
     boundary-ownership.spec.ts \
     sources-audit.spec.ts \
     metric-card-matrix.spec.ts) 2>&1 | tee "$LOG_DIR/playwright.log"; then
  echo "######## browser suite -> PASS"
else
  echo "######## browser suite -> FAIL (see $LOG_DIR/playwright.log)"
  rc=1
fi

echo
echo "######## skipped steps, stated rather than hidden"
skipped=$(grep -c '^SKIP ' "$LOG_DIR"/acceptance-*.log 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
echo "acceptance steps skipped by their own configuration: $skipped"
if [ "$skipped" -ne 0 ]; then
  grep -h '^SKIP ' "$LOG_DIR"/acceptance-*.log || true
fi
echo "This harness starts ONE kernel, so g12_ai_investigator.sh S8 (a restart with a related"
echo "source authorised) is the step expected above. A green run here is not all 199 assertions."

exit "$rc"
