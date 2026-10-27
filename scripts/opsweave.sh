#!/usr/bin/env bash
# OpsWeave local lifecycle helper.
# Safe by default: `start` resumes existing state; destructive reset only via `init`/`reset`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${OPSWEAVE_PORT:-18181}"
URL="http://127.0.0.1:${PORT}"
DB="${OPSWEAVE_DB:-opsweave}"
DATABASE_URL="${OPSWEAVE_DATABASE_URL:-postgres://localhost/${DB}?sslmode=disable}"
REGISTRY="${OPSWEAVE_REGISTRY:-localhost:5001}"
COMPOSE="deployments/local/compose.yaml"

say()  { printf '\033[1;36m==\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m error\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
kernel_alive() { curl -fsS "$URL/livez" >/dev/null 2>&1; }

need_docker() {
  have docker || die "docker is required"
  docker info >/dev/null 2>&1 || die "Docker daemon is not running"
}

start_registry() {
  need_docker
  if docker ps --format '{{.Names}}' | grep -qx 'opsweave-registry'; then
    ok "registry already running on 127.0.0.1:5001"
    return
  fi
  say "starting local OCI registry"
  docker compose -f "$COMPOSE" up -d registry
}

check_database() {
  local reset="${1:-0}"
  if ! have psql; then
    warn "psql not found; using OPSWEAVE_DATABASE_URL=${DATABASE_URL}"
    return
  fi
  if pg_isready -q -d "$DB" 2>/dev/null; then
    ok "PostgreSQL reachable ($DB)"
    return
  fi
  if [ "$reset" = "1" ] && have createdb; then
    say "creating local database $DB"
    createdb "$DB" 2>/dev/null || true
    if pg_isready -q -d "$DB" 2>/dev/null; then ok "PostgreSQL ready ($DB)"; return; fi
  fi
  die "PostgreSQL database '$DB' is not reachable. Run 'createdb $DB', start PostgreSQL, or set OPSWEAVE_DATABASE_URL."
}

check_bundles() {
  local missing=0
  for bundle in \
    dist/plugins/hello-ops-0.0.1.plugin.zip \
    dist/plugins/hello-ops-0.0.2.plugin.zip \
    dist/plugins/hello-go-0.0.1.plugin.zip \
    dist/plugins/hello-java-0.0.1.plugin.zip; do
    [ -f "$bundle" ] || { warn "missing $bundle"; missing=1; }
  done
  [ "$missing" = "0" ] || die "plugin bundles missing; run: ./scripts/opsweave.sh plugins"
}

start_platform() {
  local reset="${1:-0}"
  start_registry
  check_database "$reset"
  check_bundles
  if [ "$reset" != "1" ] && kernel_alive; then
    ok "Kernel already running at $URL"
    return
  fi
  say "starting Kernel + 2 Nodes (RESET=${reset})"
  BUILD=0 RESET="$reset" OPSWEAVE_DATABASE_URL="$DATABASE_URL" scripts/demo_up.sh
  kernel_alive || die "Kernel did not become live; see /tmp/opsweave-kernel.log"
  ok "OpsWeave is up at $URL"
  printf '  admin: admin@opsweave.local / OpsWeave!2026\n'
}

install_data() {
  kernel_alive || die "Kernel is not running; run ./scripts/opsweave.sh start first"
  say "building Data Catalog / Data Integration bundles"
  scripts/build-data-plugins.sh
  say "installing and activating data plugins"
  scripts/demo_data_up.sh
  ok "Data plugins are active"
}

cmd_start() {
  start_platform 0
  if [ "${WITH_DATA:-0}" = "1" ]; then install_data; fi
}

cmd_init() {
  warn "init/reset deletes the local demo database, data/ and managed containers"
  if [ "${FORCE:-0}" != "1" ]; then
    read -r -p "Continue? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || { echo "cancelled"; exit 0; }
  fi
  start_platform 1
  if [ "${WITH_DATA:-0}" = "1" ]; then install_data; fi
}

cmd_stop() {
  say "stopping OpsWeave host processes and managed containers"
  scripts/demo_down.sh
  ok "stopped (PostgreSQL/registry left running; use 'down' to stop compose services)"
}

cmd_down() {
  cmd_stop
  if have docker; then
    say "stopping local compose dependencies"
    docker compose -f "$COMPOSE" down
  fi
}

cmd_restart() {
  cmd_stop
  start_platform 0
}

cmd_status() {
  say "OpsWeave status"
  if kernel_alive; then
    printf 'Kernel:  UP  %s\n' "$URL"
    curl -fsS "$URL/readyz" 2>/dev/null | head -c 500 || true
    printf '\n'
  else
    printf 'Kernel:  DOWN\n'
  fi
  if [ -x ./target/debug/opsctl ] && kernel_alive; then
    ./target/debug/opsctl --url "$URL" plugins 2>/dev/null || true
  fi
  for p in 9101 9102; do
    if curl -fsS "http://127.0.0.1:${p}/healthz" >/dev/null 2>&1; then
      printf 'Node %s: UP  http://127.0.0.1:%s\n' "$p" "$p"
    else
      printf 'Node %s: DOWN\n' "$p"
    fi
  done
  if have docker; then
    printf '\nManaged containers:\n'
    docker ps --filter label=opsweave.managed=true --format '  {{.Names}}  {{.Status}}' || true
  fi
}

cmd_logs() {
  case "${1:-kernel}" in
    kernel) tail -n "${LINES:-120}" -f /tmp/opsweave-kernel.log ;;
    node-a|node-b) tail -n "${LINES:-120}" -f "/tmp/opsweave-${1}.log" ;;
    catalog) docker logs -f "$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-catalog/ {print $1; exit}')" ;;
    integration) docker logs -f "$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')" ;;
    *) die "usage: logs [kernel|node-a|node-b|catalog|integration]" ;;
  esac
}

cmd_build() {
  say "building Rust binaries and Web Shell"
  make build
  make web
  ok "build complete"
}

cmd_plugins() {
  start_registry
  say "building signed reference plugins (requires Go, Maven, Docker)"
  scripts/build-plugins.sh
  ok "plugin bundles ready in dist/plugins"
}

cmd_data() { install_data; }

cmd_dev() {
  kernel_alive || die "Kernel is not running; run ./scripts/opsweave.sh start first"
  say "starting Vite HMR at http://127.0.0.1:5173"
  pnpm dev:web
}

cmd_doctor() {
  local failed=0
  say "OpsWeave doctor"
  for c in cargo pnpm node docker; do
    if have "$c"; then ok "$c: $(command -v "$c")"; else warn "$c: missing"; failed=1; fi
  done
  have psql && ok "psql: $(command -v psql)" || warn "psql: missing (needed by demo_up reset)"
  if have docker; then docker info >/dev/null 2>&1 && ok "docker daemon: running" || { warn "docker daemon: not running"; failed=1; }; fi
  check_database 0 || failed=1
  for f in dist/plugins/hello-ops-0.0.1.plugin.zip dist/plugins/data-catalog-0.0.1.plugin.zip; do
    [ -f "$f" ] && ok "bundle: $f" || warn "bundle missing: $f"
  done
  kernel_alive && ok "kernel: $URL" || warn "kernel: not running"
  [ "$failed" = "0" ] || warn "doctor found issues"
}

cmd_test() {
  say "contracts + Rust + Web typecheck"
  python3 tests/contract/validate_contracts.py
  cargo test --locked --workspace
  cargo clippy --locked --workspace --all-targets -- -D warnings
  pnpm --filter @opsweave/platform-web typecheck
  pnpm --filter @opsweave/platform-web test:studio
  ok "local verification complete"
}

usage() {
  cat <<'USAGE'
OpsWeave local lifecycle helper

Usage: ./scripts/opsweave.sh <command> [options]

Commands:
  start          Start/reuse Kernel + Nodes (non-destructive)
  init           DESTRUCTIVE first-time/reset: recreate local DB + Nodes
  restart        Stop and start existing environment
  stop           Stop Kernel/Nodes/managed plugin containers
  down           stop + docker compose down (PostgreSQL/registry too)
  status         Show Kernel/Node/plugin status
  logs [name]    Tail kernel|node-a|node-b|catalog|integration
  build          Build Rust binaries + Web Shell
  plugins        Build signed reference plugin bundles
  data           Build/install Data Catalog + Data Integration
  dev            Start Vite HMR (Kernel must be running)
  doctor         Check local prerequisites
  test           Run contracts, Rust tests, clippy, web typecheck/unit tests

Environment:
  OPSWEAVE_PORT=18181
  OPSWEAVE_DB=opsweave
  OPSWEAVE_DATABASE_URL=postgres://localhost/opsweave?sslmode=disable
  WITH_DATA=1 ./scripts/opsweave.sh start   # also install data plugins
  FORCE=1 ./scripts/opsweave.sh init       # no confirmation prompt

Examples:
  ./scripts/opsweave.sh doctor
  ./scripts/opsweave.sh init
  ./scripts/opsweave.sh data
  ./scripts/opsweave.sh status
  ./scripts/opsweave.sh logs kernel
USAGE
}

main() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start|up) cmd_start ;;
    init|reset) cmd_init ;;
    restart) cmd_restart ;;
    stop) cmd_stop ;;
    down) cmd_down ;;
    status) cmd_status ;;
    logs) cmd_logs "${1:-kernel}" ;;
    build) cmd_build ;;
    plugins) cmd_plugins ;;
    data) cmd_data ;;
    dev) cmd_dev ;;
    doctor|check) cmd_doctor ;;
    test) cmd_test ;;
    help|-h|--help) usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
