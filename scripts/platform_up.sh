#!/usr/bin/env bash
# OpsWeave Platform-only install, upgrade and recovery (P001-B).
#
# A single-host install of the PLATFORM ALONE: PostgreSQL, the OCI registry, the
# Kernel (built without the Ops application), the Platform Console and one Node
# Runtime. It installs no business application, no reference plugin and no demo
# data, and it needs no Rust, Node, Go or Maven toolchain on the target host -
# only Docker Engine with the Compose plugin.
#
# This is not `scripts/opsweave.sh`. That script is a developer helper: it builds
# from source, needs Go/Maven/Docker to produce plugin bundles, and `up` installs
# the Data plugins by default. This script never builds anything and never
# installs a plugin.
#
#   install            first-time install (env files, pull, up, verify)
#   status             what is running, and the build identity it serves
#   login-check        prove the bootstrap admin can sign in
#   stop               stop containers, keep every volume
#   start              start them again
#   upgrade <image>    switch the image (tag or @sha256:digest), wait for health
#   rollback <image>   the same operation, named for what it is used for
#   backup [file]      pg_dump + kernel data archive
#   restore <file>     restore BOTH halves from a backup produced above
#   doctor             preflight checks and a live health report
#
# Exit codes: 0 success, 1 the requested operation failed, 2 refused before acting.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${OPSWEAVE_COMPOSE_FILE:-$ROOT/deployments/platform/compose.yaml}"
PLATFORM_DIR="${OPSWEAVE_PLATFORM_DIR:-/srv/opsweave-platform}"
PROJECT="${OPSWEAVE_PROJECT:-opsweave-platform}"
PORT="${OPSWEAVE_PORT:-18080}"
PG_PORT="${OPSWEAVE_PG_PORT:-55432}"
URL="http://127.0.0.1:${PORT}"

say()  { printf '\033[1;36m==\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }
refuse() { printf '\033[1;31mrefused\033[0m %s\n' "$*" >&2; exit 2; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
require_docker() {
  have docker || refuse "docker is required and was not found on PATH"
  docker info >/dev/null 2>&1 || refuse "the Docker daemon is not reachable by this user"
  if ! docker compose version >/dev/null 2>&1; then
    refuse "the Docker Compose plugin is required (docker compose version failed)"
  fi
}

compose() {
  OPSWEAVE_PLATFORM_DIR="$PLATFORM_DIR" \
  OPSWEAVE_PORT="$PORT" \
  OPSWEAVE_PG_PORT="$PG_PORT" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# Reads one KEY from an env file without exporting the rest.
env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  sed -n "s/^${key}=//p" "$file" | tail -1
}

random_secret() {
  # 32 bytes, URL-safe, no padding: safe in a DSN and in an env file.
  if have openssl; then
    openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40
  else
    head -c 40 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40
  fi
}

detect_bridge_ip() {
  docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "172.17.0.1"
}

detect_docker_gid() {
  stat -c '%g' /var/run/docker.sock 2>/dev/null \
    || stat -f '%g' /var/run/docker.sock 2>/dev/null \
    || echo "999"
}

# ---------------------------------------------------------------------------
# The boundary check: node.env must never carry credentials.
#
# This is the same rule staging enforces, and it matters more here because the
# node is the only container with the host docker socket: a leaked DB password in
# its environment is a path from "runs a plugin container" to "database superuser".
# ---------------------------------------------------------------------------
assert_service_env_boundary() {
  local node_env="$PLATFORM_DIR/node.env"
  [ -f "$node_env" ] || return 0
  local bad
  bad=$(grep -E '^(POSTGRES_|DATABASE_URL=|OPSWEAVE_BOOTSTRAP_ADMIN_|OPSWEAVE_GHCR_TOKEN=)' "$node_env" \
        | cut -d= -f1 | sort -u | tr '\n' ' ') || true
  if [ -n "${bad// /}" ]; then
    refuse "node.env contains keys it must never hold: $bad"
  fi
  if grep -qE '^[A-Z_]*SECRET[A-Z_]*=' "$node_env"; then
    refuse "node.env contains a *SECRET* key"
  fi
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
cmd_install() {
  require_docker

  local image="${OPSWEAVE_IMAGE:-}"
  [ -n "$image" ] || die "set OPSWEAVE_IMAGE to the platform-only image (tag or @sha256 digest)"

  # A full-product staging image must not be installed here by accident: it
  # contains the Ops application and the pipeline worker, which this profile
  # exists to exclude. We cannot inspect a tag without pulling, so the check is
  # on what the operator declared plus a post-start assertion below.
  case "$image" in
    *staging*) warn "OPSWEAVE_IMAGE looks like a staging (full-product) image; this profile expects the --target platform image" ;;
  esac

  local admin_email="${OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL:-}"
  local admin_password="${OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD:-}"

  # Refuse rather than invent a credential. A generated password that nobody
  # recorded is a locked-out deployment; a fixed one is the defect this release
  # is removing from its own installer.
  if [ -z "$admin_password" ]; then
    refuse "set OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD to the password you want for the first administrator (no default is provided)"
  fi
  if [ "${#admin_password}" -lt 12 ]; then
    refuse "OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters"
  fi
  case "$admin_password" in
    OpsWeave!2026|password|changeme|admin) refuse "OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD is a well-known demo value; choose another" ;;
  esac
  if [ -z "$admin_email" ]; then
    refuse "set OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL"
  fi

  say "preparing $PLATFORM_DIR"
  if [ ! -d "$PLATFORM_DIR" ]; then
    mkdir -p "$PLATFORM_DIR" 2>/dev/null || die "cannot create $PLATFORM_DIR (run as root, or set OPSWEAVE_PLATFORM_DIR)"
  fi
  mkdir -p "$PLATFORM_DIR/node"

  local host="${OPSWEAVE_HOST:-$(hostname -f 2>/dev/null || hostname)}"
  local pg_password bridge_ip docker_gid
  bridge_ip="$(detect_bridge_ip)"
  docker_gid="$(detect_docker_gid)"
  # Reuse an existing password so a re-run does not lock the Kernel out of a
  # database that was already initialised with the old one.
  pg_password="$(env_value "$PLATFORM_DIR/postgres.env" POSTGRES_PASSWORD || true)"
  if [ -z "$pg_password" ]; then
    pg_password="$(random_secret)"
  fi

  umask 077
  cat > "$PLATFORM_DIR/postgres.env" <<EOF
POSTGRES_DB=opsweave
POSTGRES_USER=opsweave
POSTGRES_PASSWORD=$pg_password
EOF

  cat > "$PLATFORM_DIR/kernel.env" <<EOF
DATABASE_URL=postgres://opsweave:$pg_password@$bridge_ip:$PG_PORT/opsweave?sslmode=disable
OPSWEAVE_PUBLIC_URL=${OPSWEAVE_PUBLIC_URL:-http://$host:$PORT}
OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=$admin_email
OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=$admin_password
OPSWEAVE_BOOTSTRAP_ADMIN_NAME=${OPSWEAVE_BOOTSTRAP_ADMIN_NAME:-Platform Admin}
OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1
OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1
OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=127.0.0.1,$bridge_ip
OPSWEAVE_SESSION_HOURS=12
OPSWEAVE_NODE_HEARTBEAT_SECONDS=5
OPSWEAVE_NODE_STALE_SECONDS=25
OPSWEAVE_REQUEST_TIMEOUT_SECONDS=10
OPSWEAVE_TRUSTED_PROXY_IPS=
OPSWEAVE_DEV_PUBLISHER_ID=
OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY=
EOF

  # Keep an existing enrolment token if one was supplied; never invent one here
  # (it requires the Kernel to be up, which happens below).
  local token
  token="$(env_value "$PLATFORM_DIR/node.env" OPSWEAVE_ENROLLMENT_TOKEN || true)"
  cat > "$PLATFORM_DIR/node.env" <<EOF
OPSWEAVE_ENROLLMENT_TOKEN=${token:-}
OPSWEAVE_NODE_NAME=${OPSWEAVE_NODE_NAME:-platform-node}
OPSWEAVE_NODE_LABELS=role=node
OPSWEAVE_NODE_MAX_INSTANCES=4
OPSWEAVE_NODE_LEASE_SECONDS=30
EOF

  umask 022
  chmod 600 "$PLATFORM_DIR"/*.env
  assert_service_env_boundary

  say "pulling $image"
  compose pull postgres registry

  say "starting PostgreSQL and the registry"
  OPSWEAVE_IMAGE="$image" compose up -d postgres registry
  wait_healthy postgres registry

  say "starting the Kernel"
  OPSWEAVE_IMAGE="$image" compose up -d kernel
  wait_healthy kernel

  # The first-boot assertion this whole profile exists for: the Kernel must be
  # alive AND must not contain the Ops application.
  say "verifying the platform-only boundary"
  local code
  code="$(http_code "$URL/app")"
  if [ "$code" != "404" ]; then
    die "this image is not platform-only: GET /app answered $code, expected 404 (is OPSWEAVE_IMAGE the staging image?)"
  fi
  code="$(http_code -X POST "$URL/api/v1/telemetry/events")"
  if [ "$code" != "404" ]; then
    die "this image is not platform-only: POST /api/v1/telemetry/events answered $code, expected 404"
  fi
  ok "the Ops application is absent from the served build"

  say "bootstrap administrator"
  if ! login_probe "$admin_email" "$admin_password"; then
    die "the bootstrap administrator could not sign in; see: docker compose -p $PROJECT logs kernel"
  fi
  ok "signed in as $admin_email"

  say "enrolling the node"
  local node_token
  node_token="$(issue_node_token "$admin_email" "$admin_password")" || die "could not mint a node enrolment token"
  if [ -n "$node_token" ]; then
    sed -i.bak "s|^OPSWEAVE_ENROLLMENT_TOKEN=.*|OPSWEAVE_ENROLLMENT_TOKEN=$node_token|" "$PLATFORM_DIR/node.env"
    rm -f "$PLATFORM_DIR/node.env.bak"
    chmod 600 "$PLATFORM_DIR/node.env"
  fi
  OPSWEAVE_IMAGE="$image" compose up -d node
  wait_healthy node
  # The token is consumed on redemption; leaving it here would be a live
  # credential in a file with no further use.
  sed -i.bak "s|^OPSWEAVE_ENROLLMENT_TOKEN=.*|OPSWEAVE_ENROLLMENT_TOKEN=|" "$PLATFORM_DIR/node.env"
  rm -f "$PLATFORM_DIR/node.env.bak"

  say "final report"
  report
  printf '\nPlatform console: %s/admin/overview\n' "$URL"
  printf 'Operator:         %s\n' "$admin_email"
  printf 'Stop:             %s stop\n' "$0"
  printf 'Backup:           %s backup\n' "$0"
}

# ---------------------------------------------------------------------------
# Health and probes
# ---------------------------------------------------------------------------
http_code() { curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo "000"; }

wait_healthy() {
  local services="$*" waited=0 limit=180
  while [ "$waited" -lt "$limit" ]; do
    local all=1
    for svc in $services; do
      local cid state
      cid="$(compose ps -q "$svc" 2>/dev/null || true)"
      if [ -z "$cid" ]; then all=0; break; fi
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
      case "$state" in
        healthy|running) ;;
        *) all=0 ;;
      esac
    done
    [ "$all" = "1" ] && return 0
    sleep 3; waited=$((waited + 3))
  done
  die "services did not become healthy within ${limit}s: $services"
}

login_probe() {
  local email="$1" password="$2" jar
  jar="$(mktemp)"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" \
    -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    "$URL/api/v1/auth/login" 2>/dev/null || echo 000)"
  rm -f "$jar"
  [ "$code" = "200" ]
}

issue_node_token() {
  local email="$1" password="$2" jar csrf
  jar="$(mktemp)"
  curl -sS -c "$jar" -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    "$URL/api/v1/auth/login" -o /tmp/opsweave-platform-login.json 2>/dev/null || true
  csrf="$(python3 -c 'import json,sys;print(json.load(open("/tmp/opsweave-platform-login.json")).get("csrfToken",""))' 2>/dev/null || true)"
  if [ -z "$csrf" ]; then rm -f "$jar"; return 1; fi
  local body
  body="$(curl -sS -b "$jar" -X POST -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
    -d "{\"label\":\"${OPSWEAVE_NODE_NAME:-platform-node}\",\"ttlMinutes\":60}" \
    "$URL/api/v1/nodes/enrollment-tokens" 2>/dev/null || true)"
  rm -f "$jar" /tmp/opsweave-platform-login.json
  python3 -c 'import json,sys
d=json.loads(sys.argv[1]) if sys.argv[1].strip() else {}
print(d.get("token",""))' "$body" 2>/dev/null || true
}

report() {
  local version apps
  version="$(curl -sS "$URL/api/v1/version" 2>/dev/null || echo '{}')"
  printf '  version:   %s\n' "$version"
  printf '  kernel:    %s\n' "$(http_code "$URL/livez") /livez, $(http_code "$URL/readyz") /readyz"
  printf '  node:      %s\n' "$(http_code http://127.0.0.1:9101/healthz) /healthz"
  printf '  /app:      %s (must be 404 on a platform-only build)\n' "$(http_code "$URL/app")"
  printf '  services:\n'
  compose ps 2>/dev/null | sed 's/^/    /' || true
}

# ---------------------------------------------------------------------------
# status / doctor / stop / start
# ---------------------------------------------------------------------------
cmd_status() {
  require_docker
  local image
  image="$(compose ps --format json 2>/dev/null | python3 -c 'import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("Service")=="kernel":
        print(d.get("Image","")); break' 2>/dev/null || true)"
  printf 'image: %s\n' "${image:-<not running>}"
  report
}

cmd_doctor() {
  require_docker
  say "doctor"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
  ok "compose $(docker compose version --short 2>/dev/null || echo '?')"
  for cmd in curl python3; do
    if have "$cmd"; then ok "$cmd present"; else warn "$cmd missing (required by install/backup)"; fi
  done
  if [ -f "$PLATFORM_DIR/kernel.env" ]; then ok "kernel.env present"; else warn "kernel.env missing (run install)"; fi
  if [ -f "$PLATFORM_DIR/postgres.env" ]; then ok "postgres.env present"; else warn "postgres.env missing"; fi
  assert_service_env_boundary || true
  report
}

cmd_stop() {
  require_docker
  say "stopping (volumes are kept)"
  compose stop
  ok "stopped; data remains in the named volumes"
}

cmd_start() {
  require_docker
  local image
  image="${OPSWEAVE_IMAGE:-}"
  [ -n "$image" ] || die "set OPSWEAVE_IMAGE to the image you want to run"
  OPSWEAVE_IMAGE="$image" compose up -d
  wait_healthy postgres registry kernel node
  report
}

# ---------------------------------------------------------------------------
# upgrade / rollback
#
# Both are the same operation. There is no migration rollback: migrations are
# forward-only, so going back across one requires restoring a backup, and the
# script says so instead of pretending otherwise.
# ---------------------------------------------------------------------------
cmd_switch_image() {
  local label="$1" image="$2"
  require_docker
  [ -n "$image" ] || die "usage: $label <image-tag-or-@sha256-digest>"
  say "$label to $image"
  OPSWEAVE_IMAGE="$image" compose pull kernel node
  OPSWEAVE_IMAGE="$image" compose up -d --no-deps kernel
  wait_healthy kernel
  OPSWEAVE_IMAGE="$image" compose up -d --no-deps node
  wait_healthy node

  local code
  code="$(http_code "$URL/app")"
  if [ "$code" != "404" ]; then
    die "$label produced a build that is not platform-only: GET /app answered $code"
  fi
  ok "$label complete; the Ops application is still absent"
  report
  warn "migrations are forward-only: rolling back across one requires '$(basename "$0") restore <file>'"
}

# ---------------------------------------------------------------------------
# backup / restore
#
# Two halves, both required: the database holds identity, grants, the registry
# ledger and the cursor secret; the kernel volume holds the plugin package store
# and backups directory. A backup of one without the other cannot be restored
# into a working platform.
# ---------------------------------------------------------------------------
cmd_backup() {
  require_docker
  local stamp out
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="${1:-$ROOT/backups/opsweave-platform-$stamp.tar.gz}"
  mkdir -p "$(dirname "$out")"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  say "dumping the database"
  compose exec -T postgres pg_dump -U opsweave -d opsweave --no-owner --no-privileges \
    > "$tmp/opsweave.sql" || die "pg_dump failed"
  gzip -9 "$tmp/opsweave.sql"

  say "archiving the kernel volume"
  local cid
  cid="$(compose ps -q kernel 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    docker cp "$cid:/app/data/." "$tmp/kernel-data" 2>/dev/null || mkdir -p "$tmp/kernel-data"
  else
    mkdir -p "$tmp/kernel-data"
    warn "the kernel container is not running; the volume half of this backup is empty"
  fi

  cat > "$tmp/MANIFEST" <<EOF
opsweave-platform backup
created_at=$stamp
image=$(compose ps --format json 2>/dev/null | python3 -c 'import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("Service")=="kernel": print(d.get("Image","")); break' 2>/dev/null || echo unknown)
kernel_version=$(curl -sS "$URL/api/v1/version" 2>/dev/null || echo '{}')
EOF

  tar -czf "$out" -C "$tmp" .
  ok "backup written to $out"
  printf 'restore with: %s restore %s\n' "$(basename "$0")" "$out"
}

cmd_restore() {
  require_docker
  local file="$1"
  [ -n "$file" ] || die "usage: restore <backup.tar.gz>"
  [ -f "$file" ] || die "no such backup: $file"

  # Restoring is destructive to the CURRENT database. Ask, unless told not to.
  if [ "${OPSWEAVE_RESTORE_FORCE:-0}" != "1" ]; then
    refuse "restore replaces the current database and kernel data. Re-run with OPSWEAVE_RESTORE_FORCE=1 to proceed."
  fi

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  tar -xzf "$file" -C "$tmp" || die "cannot read $file"
  [ -f "$tmp/opsweave.sql.gz" ] || die "backup has no opsweave.sql.gz"

  local image
  image="${OPSWEAVE_IMAGE:-}"
  [ -n "$image" ] || die "set OPSWEAVE_IMAGE to the image the restored platform should run"

  say "starting PostgreSQL only"
  OPSWEAVE_IMAGE="$image" compose up -d postgres
  wait_healthy postgres

  say "dropping and recreating the application database"
  compose exec -T postgres psql -U opsweave -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS opsweave WITH (FORCE);" \
    -c "CREATE DATABASE opsweave OWNER opsweave;" || die "could not recreate the database"

  say "restoring the dump"
  gunzip -c "$tmp/opsweave.sql.gz" | compose exec -T postgres psql -U opsweave -d opsweave -v ON_ERROR_STOP=1 -q \
    || die "psql reported an error while restoring"

  say "restoring the kernel volume"
  OPSWEAVE_IMAGE="$image" compose up -d kernel
  wait_healthy kernel
  local cid
  cid="$(compose ps -q kernel)"
  if [ -d "$tmp/kernel-data" ]; then
    docker cp "$tmp/kernel-data/." "$cid:/app/data/" 2>/dev/null || warn "no kernel data to restore"
  fi

  OPSWEAVE_IMAGE="$image" compose up -d
  wait_healthy postgres registry kernel node
  ok "restore complete"
  report
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    install)  shift; cmd_install "$@" ;;
    status)   cmd_status ;;
    doctor)   cmd_doctor ;;
    stop)     cmd_stop ;;
    start)    cmd_start ;;
    upgrade)  shift; cmd_switch_image upgrade "${1:-}" ;;
    rollback) shift; cmd_switch_image rollback "${1:-}" ;;
    backup)   shift; cmd_backup "${1:-}" ;;
    restore)  shift; cmd_restore "${1:-}" ;;
    login-check)
      require_docker
      login_probe "${OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL:?set OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL}" \
                  "${OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD:?set OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD}" \
        && ok "login works" || die "login failed"
      ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"
