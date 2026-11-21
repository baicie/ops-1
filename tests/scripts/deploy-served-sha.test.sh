#!/usr/bin/env bash
# Guard test for the served-commit gate in scripts/deploy-staging.sh.
#
# The deploy driver normally runs as root on the staging host with a live docker daemon. This test
# runs that same script file against stub docker/curl/flock/stat commands placed first on PATH, so
# the certification path is exercised end to end with no host, no daemon and no root.
#
# Fixture: /livez, /readyz and / all answer 200, so health_check() passes, while /api/v1/version
# reports an older commit. That is precisely the case that used to be written down as a success.
#
# Run from anywhere:  bash scripts/tests/deploy-served-sha.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SCRIPT="$REPO_ROOT/scripts/deploy-staging.sh"
NEW_SHA="1111111111111111111111111111111111111111"
OLD_SHA="2222222222222222222222222222222222222222"
IMAGE_REPO="ghcr.io/baicie/opsweave"
PASSED=0
FAILED=0

if [ ! -f "$DEPLOY_SCRIPT" ]; then
  printf 'FAIL missing deploy script: %s\n' "$DEPLOY_SCRIPT" >&2
  exit 1
fi

check() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    PASSED=$((PASSED + 1))
    printf '  ok   %s\n' "$label"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL %s (expected "%s", got "%s")\n' "$label" "$expected" "$actual"
  fi
}

check_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -q -- "$needle" "$file" 2>/dev/null; then
    PASSED=$((PASSED + 1))
    printf '  ok   %s\n' "$label"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL %s (no match for "%s" in %s)\n' "$label" "$needle" "$file"
  fi
}

# The failure record's served_commit reflects the host's state after rollback, so the pre-rollback
# mismatch is asserted from the deploy log, where append_log() preserved it.
check_log_contains() {
  local label="$1" sb="$2" needle="$3"
  if cat "$sb"/logs/deploy-*.log 2>/dev/null | grep -q -- "$needle"; then
    PASSED=$((PASSED + 1))
    printf '  ok   %s\n' "$label"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL %s (no match for "%s" in %s/logs)\n' "$label" "$needle" "$sb"
  fi
}

# --- stub commands ---------------------------------------------------------------------------
# curl: answers the two call shapes the driver uses: -o/-w (status code) and plain (body).
write_curl_stub() {
  local dir="$1"
  cat >"$dir/curl" <<'STUB_CURL'
#!/usr/bin/env bash
url=""
want_code=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-w) want_code=1; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
path="$(printf '%s' "$url" | sed -e 's|^[A-Za-z][A-Za-z0-9+.-]*://[^/]*||')"
[ -n "$path" ] || path="/"
code=404
body=""
case "$path" in
  /livez) code=200 ;;
  /readyz) code=200 ;;
  /) code=200; body='<html><body><div id="root"></div></body></html>' ;;
  /api/v1/version)
    case "${STUB_VERSION_MODE:-ok}" in
      unavailable) code=503 ;;
      absent)
        code=200
        body='{"version":"0.0.5","commitSha":null,"buildTime":null,"environment":"STAGING","startedAt":"2026-01-01T00:00:00Z"}'
        ;;
      *)
        code=200
        body="{\"version\":\"0.0.5\",\"commitSha\":\"${STUB_SERVED_SHA}\",\"buildTime\":null,\"environment\":\"STAGING\",\"startedAt\":\"2026-01-01T00:00:00Z\"}"
        ;;
    esac
    ;;
esac
if [ "$want_code" -eq 1 ]; then
  if [ "$code" = "200" ] || [ "$code" = "503" ]; then printf '%s' "$code"; else printf '000'; fi
  exit 0
fi
[ "$code" = "200" ] || exit 22
printf '%s' "$body"
STUB_CURL
  chmod +x "$dir/curl"
}

# docker: just enough of the CLI for one deploy of the single 'kernel' service.
write_docker_stub() {
  local dir="$1"
  cat >"$dir/docker" <<'STUB_DOCKER'
#!/usr/bin/env bash
if [ "${1:-}" = "compose" ]; then
  shift
  for arg in "$@"; do
    case "$arg" in
      version) exit 0 ;;
      config) printf 'kernel\n'; exit 0 ;;
      ps) printf 'stubcontainerid\n'; exit 0 ;;
      up) exit 0 ;;
    esac
  done
  exit 0
fi
case "${1:-}" in
  inspect)
    case "$*" in
      *State.Running*) printf 'true\n' ;;
      *State.Status*) printf 'running\n' ;;
      *Config.Image*) printf '%s:%s\n' "${STUB_IMAGE_REPO}" "${STUB_SERVED_SHA}" ;;
      *) printf '[]\n' ;;
    esac
    exit 0
    ;;
  image) printf 'ghcr.io/baicie/opsweave@sha256:stubdigest\n'; exit 0 ;;
  manifest|pull|login|run|tag|push) exit 0 ;;
esac
exit 0
STUB_DOCKER
  chmod +x "$dir/docker"
}

# flock: the driver serialises deployments with it; the stub always grants the lock.
write_flock_stub() {
  local dir="$1"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$dir/flock"
  chmod +x "$dir/flock"
}

# stat: the driver asks for GNU -c formats (%g on the socket, %a on staging.env).
write_stat_stub() {
  local dir="$1"
  cat >"$dir/stat" <<'STUB_STAT'
#!/usr/bin/env bash
if [ "${1:-}" = "-c" ]; then
  case "${2:-}" in
    '%g') printf '999' ;;
    '%a') printf '700' ;;
    '%u:%g') printf '10001:10001' ;;
    *) printf '0' ;;
  esac
  exit 0
fi
exec /usr/bin/stat "$@"
STUB_STAT
  chmod +x "$dir/stat"
}

setup_sandbox() {
  local sb="$1"
  rm -rf "$sb"
  mkdir -p "$sb/root" "$sb/data/deployments" "$sb/backups" "$sb/logs" "$sb/bin" "$sb/data/node"
  # Literal ${OPSWEAVE_IMAGE}: the fixture is a stand-in for the real compose file, never interpolated.
  cat >"$sb/root/compose.yaml" <<'COMPOSE_FIXTURE'
services:
  kernel:
    image: ${OPSWEAVE_IMAGE}
COMPOSE_FIXTURE
  printf 'OPSWEAVE_IMAGE=%s:unknown\nOPSWEAVE_PREVIEW_PORT=3000\nOPSWEAVE_PUBLIC_URL=http://127.0.0.1:3000\n' \
    "$IMAGE_REPO" >"$sb/root/staging.env"
  : >"$sb/docker.sock"
  # A release is already recorded, so a failed deploy has somewhere to roll back to.
  printf '%s\n' "$OLD_SHA" >"$sb/data/deployments/current"
  write_curl_stub "$sb/bin"
  write_docker_stub "$sb/bin"
  write_flock_stub "$sb/bin"
  write_stat_stub "$sb/bin"
}

# One subshell owns the sandbox environment; deploy and status differ only in the command.
sandbox_exec() {
  local sb="$1" served="$2" version_mode="$3"
  shift 3
  (
    export PATH="$sb/bin:$PATH"
    export STUB_SERVED_SHA="$served"
    export STUB_VERSION_MODE="$version_mode"
    export STUB_IMAGE_REPO="$IMAGE_REPO"
    export OPSWEAVE_STAGING_ROOT="$sb/root"
    export OPSWEAVE_STAGING_DATA="$sb/data"
    export OPSWEAVE_STAGING_BACKUPS="$sb/backups"
    export OPSWEAVE_STAGING_LOGS="$sb/logs"
    export OPSWEAVE_NODE_STATE_DIR_HOST="$sb/data/node"
    export OPSWEAVE_DOCKER_SOCKET="$sb/docker.sock"
    export OPSWEAVE_SKIP_BIND_DIR_PREP=1
    export OPSWEAVE_BASE_URL="http://127.0.0.1:3000"
    export OPSWEAVE_PREVIEW_PORT=3000
    export OPSWEAVE_IMAGE_REPO="$IMAGE_REPO"
    export OPSWEAVE_APP_SERVICES="kernel"
    export OPSWEAVE_HEALTH_TIMEOUT=10
    export OPSWEAVE_HEALTH_INTERVAL=1
    export OPSWEAVE_KERNEL_READY_TIMEOUT=10
    export OPSWEAVE_LOCK_TIMEOUT=5
    unset OPSWEAVE_ENV_FILE
    "$@"
  ) >"$sb/stdout.log" 2>"$sb/stderr.log"
  printf '%s' "$?"
}

run_deploy() {
  local sb="$1" target="$2" served="$3" version_mode="$4"
  sandbox_exec "$sb" "$served" "$version_mode" bash "$DEPLOY_SCRIPT" --sha "$target"
}

# Read-only status must keep working while the version endpoint is down: making the deploy gate
# strict must not turn a monitoring call into a failure.
run_status() {
  local sb="$1" version_mode="$2"
  sandbox_exec "$sb" "" "$version_mode" bash "$DEPLOY_SCRIPT" --status
}

success_records() {
  local sb="$1"
  grep -l '"healthy": true' "$sb"/data/deployments/*.json 2>/dev/null | wc -l | tr -d ' '
}

pointer_current() {
  head -n1 "$1/data/deployments/current" 2>/dev/null | tr -d '[:space:]'
}

SCENARIO_DIR="${TMPDIR:-/tmp}/opsweave-served-sha-test.$$"
cleanup() {
  # OPSWEAVE_TEST_KEEP=1 keeps the sandbox so a failure can be inspected.
  if [ "${OPSWEAVE_TEST_KEEP:-0}" = "1" ]; then
    printf 'kept sandbox: %s\n' "$SCENARIO_DIR" >&2
    return 0
  fi
  rm -rf "$SCENARIO_DIR"
}
trap cleanup EXIT
mkdir -p "$SCENARIO_DIR"

# --- 1. the regression: healthy probes, stale commit -------------------------------------------
# This is the P0 case. Every probe answers 200 but the kernel serves the previous build, so the
# deploy must fail, must not move the pointer and must not leave a healthy=true record behind.
printf '\n[1] all probes 200 but /api/v1/version reports the old commit (%s) while %s is deployed\n' \
  "$OLD_SHA" "$NEW_SHA"
SB="$SCENARIO_DIR/stale"
setup_sandbox "$SB"
CODE="$(run_deploy "$SB" "$NEW_SHA" "$OLD_SHA" ok)"
check "exit code is non-zero" "$CODE" "1"
check "no healthy=true record was written" "$(success_records "$SB")" "0"
check "current pointer still names the previous release" "$(pointer_current "$SB")" "$OLD_SHA"
check_contains "health checks had passed" "$SB/stderr.log" "health checks passed"
check_contains "mismatch was reported as a certification failure" "$SB/stderr.log" "does not serve the pinned commit"
check_contains "the existing rollback path ran" "$SB/stderr.log" "rolling back to previous release $OLD_SHA"
check_contains "the release was recorded as rolled back" "$SB/data/deployments/$NEW_SHA.json" '"rolled_back": true'
check_contains "the rollback target was recorded" "$SB/data/deployments/$NEW_SHA.json" "\"rollback_target\": \"$OLD_SHA\""
check_log_contains "the deploy log records the mismatch" "$SB" "reports serving commit $OLD_SHA but $NEW_SHA was deployed"
check_contains "the record keeps the post-rollback served state" "$SB/data/deployments/$NEW_SHA.json" '"state": "match"'

# --- 2. the control: matching commit still deploys ---------------------------------------------
printf '\n[2] all probes 200 and /api/v1/version reports the deployed commit (%s)\n' "$NEW_SHA"
SB="$SCENARIO_DIR/match"
setup_sandbox "$SB"
CODE="$(run_deploy "$SB" "$NEW_SHA" "$NEW_SHA" ok)"
check "exit code is zero" "$CODE" "0"
check "exactly one healthy=true record was written" "$(success_records "$SB")" "1"
check "current pointer moved to the new release" "$(pointer_current "$SB")" "$NEW_SHA"
check_contains "the record states healthy=true" "$SB/data/deployments/$NEW_SHA.json" '"healthy": true'
check_contains "the served commit state was recorded as match" "$SB/data/deployments/$NEW_SHA.json" '"state": "match"'

# --- 3. /api/v1/version unreachable ------------------------------------------------------------
printf '\n[3] /api/v1/version is unreachable\n'
SB="$SCENARIO_DIR/unavailable"
setup_sandbox "$SB"
CODE="$(run_deploy "$SB" "$NEW_SHA" "$NEW_SHA" unavailable)"
check "exit code is non-zero" "$CODE" "1"
check "no healthy=true record was written" "$(success_records "$SB")" "0"
check "current pointer was not moved" "$(pointer_current "$SB")" "$OLD_SHA"
check_contains "unreachable endpoint reported" "$SB/stderr.log" "is unreachable"

# --- 4. commitSha missing ----------------------------------------------------------------------
printf '\n[4] /api/v1/version answers without a commitSha\n'
SB="$SCENARIO_DIR/absent"
setup_sandbox "$SB"
CODE="$(run_deploy "$SB" "$NEW_SHA" "$NEW_SHA" absent)"
check "exit code is non-zero" "$CODE" "1"
check "no healthy=true record was written" "$(success_records "$SB")" "0"
check "current pointer was not moved" "$(pointer_current "$SB")" "$OLD_SHA"
check_contains "absent commitSha reported" "$SB/stderr.log" "reports no commitSha"

# --- 5. --status stays usable without the version endpoint -------------------------------------
printf '\n[5] --status is read-only and still succeeds while /api/v1/version is unreachable\n'
SB="$SCENARIO_DIR/status"
setup_sandbox "$SB"
CODE="$(run_status "$SB" unavailable)"
check "status exit code is zero" "$CODE" "0"
if grep -q '"served_commit"' "$SB/stdout.log"; then
  PASSED=$((PASSED + 1))
  printf '  ok   status still emitted its JSON report\n'
else
  FAILED=$((FAILED + 1))
  printf '  FAIL status produced no served_commit JSON\n'
fi
check_contains "status reported the endpoint as unavailable" "$SB/stdout.log" '"state": "unavailable"'

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
