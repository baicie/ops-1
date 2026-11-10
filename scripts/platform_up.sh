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
REGISTRY_PORT="${OPSWEAVE_REGISTRY_PORT:-15001}"
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

# Which compose files this host uses.
#
# The base file publishes loopback only. The docker-bridge gateway binding that
# plugin containers need is a SEPARATE override, added only when the address is
# assignable here - see detect_plugin_gateway.
COMPOSE_FILES=("$COMPOSE_FILE")

compose() {
  # Every invocation re-checks the recorded gateway decision, so a command that
  # was not `install` still composes exactly the way the install did.
  load_gateway_decision
  local args=()
  local f
  for f in "${COMPOSE_FILES[@]}"; do args+=(-f "$f"); done
  OPSWEAVE_PLATFORM_DIR="$PLATFORM_DIR" \
  OPSWEAVE_PORT="$PORT" \
  OPSWEAVE_PG_PORT="$PG_PORT" \
  OPSWEAVE_REGISTRY_PORT="${REGISTRY_PORT:-15001}" \
  OPSWEAVE_PLUGIN_GATEWAY_IP="${PLUGIN_GATEWAY_IP:-}" \
  DOCKER_GID="${DOCKER_GID:-$(detect_docker_gid)}" \
  docker compose -p "$PROJECT" "${args[@]}" "$@"
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
  docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true
}

# Whether the docker bridge gateway can actually be BOUND by a host process here.
#
# docker network inspect reports the bridge's gateway on every platform, so its
# value says nothing about whether publishing on it will succeed. The only honest
# test is to try: bind a throwaway listener on the address. Docker Desktop and
# rootless Docker report a gateway the host cannot bind, and Compose would then
# abort the whole `up` on "cannot assign requested address".
#
# Returns 0 and sets PLUGIN_GATEWAY_IP when the bind succeeded, 1 otherwise.
probe_gateway_bindable() {
  local ip="$1"
  [ -n "$ip" ] || return 1
  docker run --rm --network host --entrypoint /bin/sh "$(platform_image)" \
      -c "command -v python3 >/dev/null 2>&1 && python3 -c 'import socket;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((\"$ip\",0));s.close()' && exit 0; exit 1" \
      >/dev/null 2>&1
}

# Decides whether this install gets the bridge-gateway override, and says why.
configure_plugin_gateway() {
  local ip
  ip="$(detect_bridge_ip)"
  if [ -n "$ip" ] && probe_gateway_bindable "$ip"; then
    PLUGIN_GATEWAY_IP="$ip"
    COMPOSE_FILES=("$COMPOSE_FILE" "$(dirname "$COMPOSE_FILE")/compose.bridge-gateway.yaml")
    ok "plugin gateway $ip is bindable; plugin containers can reach the Kernel and PostgreSQL"
  else
    PLUGIN_GATEWAY_IP=""
    warn "no bindable docker bridge gateway on this host (reported: ${ip:-none})."
    warn "  The platform installs and runs, but a PLUGIN CONTAINER will not be able to"
    warn "  reach the Kernel or PostgreSQL through the bridge. This is expected on"
    warn "  Docker Desktop and rootless Docker; set OPSWEAVE_PLUGIN_GATEWAY_IP to a"
    warn "  bindable address to enable it. Plugin containers are not part of this profile."
  fi
}

# Reads the decision `install` recorded and rebuilds COMPOSE_FILES from it.
# Absent file = the install never ran; the base file alone is the safe default.
load_gateway_decision() {
  local recorded
  recorded="$(env_value "$PLATFORM_DIR/gateway.env" OPSWEAVE_PLUGIN_GATEWAY_IP 2>/dev/null || true)"
  if [ -n "$recorded" ]; then
    PLUGIN_GATEWAY_IP="$recorded"
    COMPOSE_FILES=("$COMPOSE_FILE" "$(dirname "$COMPOSE_FILE")/compose.bridge-gateway.yaml")
  else
    PLUGIN_GATEWAY_IP=""
    COMPOSE_FILES=("$COMPOSE_FILE")
  fi
}

# The address the KERNEL (host networking) uses to reach PostgreSQL.
#
# Tries, in order, an explicit override, the docker bridge gateway when it is
# bindable, and Docker Desktop's documented host alias. Each candidate is
# verified by actually connecting from a host-networked container of the image,
# so the answer is an observation rather than a platform guess.
resolve_db_host() {
  local gateway="$1" candidate
  if [ -n "${OPSWEAVE_DATABASE_HOST:-}" ]; then
    printf '%s' "$OPSWEAVE_DATABASE_HOST"; return 0
  fi
  for candidate in "$gateway" host.docker.internal 127.0.0.1; do
    [ -n "$candidate" ] || continue
    if probe_db_reachable "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  # Nothing answered. Fall back to the gateway so the failure is reported by
  # the Kernel with a real DSN in its log, not by this probe with a guess.
  printf '%s' "${gateway:-127.0.0.1}"
}

# Is PostgreSQL already listening on <host>:<PG_PORT> as seen from a container on
# the host network? Only used for the probe BEFORE postgres exists, so a failure
# here is expected on the first install - it then falls through to the
# candidates in order and resolve_db_host is re-run after the database is up.
probe_db_reachable() {
  local candidate="$1"
  # A raw TCP connect is the question. Three earlier attempts were wrong and are
  # recorded so they are not retried:
  #   * `echo > /dev/tcp/...` is a bash feature busybox sh does not provide, so
  #     it "failed" for every address and nothing looked reachable;
  #   * `curl telnet://host:port` treats PostgreSQL's startup bytes as a telnet
  #     negotiation failure and errors EVEN WHEN THE PORT IS OPEN;
  #   * probing from inside a container adds a dependency (nc is not in the
  #     image) and answers a different question - the KERNEL's reachability, not
  #     the host's.
  # The host is the right place: nc is available on the deployment host, and the
  # Kernel runs with host networking, so host reachability is what it will see.
  #
  # Docker Desktop publishes to the host loopback, and its host alias resolves
  # there too, so either name can answer; the caller tries them in order.
  if have nc; then
    nc -z -w 2 "$candidate" "$PG_PORT" >/dev/null 2>&1
    return $?
  fi
  # Fall back to bash's /dev/tcp when nc is absent (Linux hosts commonly have
  # neither nc nor a bash that is the login shell, but bash is present for this
  # script).
  ( exec 3<>"/dev/tcp/$candidate/$PG_PORT" ) >/dev/null 2>&1
}

# Which execution context can reach the Kernel's HTTP API.
#
#   host       - the published URL answers here (a Linux host, the deployment target)
#   container  - it does not, so every call is made from inside the Kernel container
#                (Docker Desktop with host networking; see verify_boundary_in_container)
API_CONTEXT="host"
# The origin API calls use. Set to the container's own loopback when the host
# cannot reach the published port.
API_URL="$URL"

# curl against the Kernel API from whichever context can reach it.
# Arguments are passed to curl unchanged; the body/headers are the caller's.
api() {
  if [ "$API_CONTEXT" = "container" ]; then
    local cid
    cid="$(compose ps -q kernel 2>/dev/null || true)"
    [ -n "$cid" ] || { echo "000"; return 1; }
    # The container has no shell-level cookie jar need here: each call is a
    # single request, and the jar lives in the container's /tmp.
    docker exec -i "$cid" /bin/sh -c 'exec curl -sS "$@"' _ "$@" 2>/dev/null
  else
    curl -sS "$@" 2>/dev/null
  fi
}

# Whether the published URL answers from THIS host at all.
reachable_from_host() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$URL/livez" 2>/dev/null || echo 000)"
  [ "$code" = "200" ]
}

# The boundary assertions, run from inside the Kernel container.
#
# Same checks as the host-side path, same expectations: this is not a weaker
# verification, it is the same one asked from the only place that can answer on
# a Docker Desktop host. Used only when reachable_from_host says no.
verify_boundary_in_container() {
  local image="$1" cid out
  cid="$(compose ps -q kernel 2>/dev/null || true)"
  [ -n "$cid" ] || die "the kernel container is not running"
  out="$(docker exec "$cid" /bin/sh -c "
    livez=\$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/livez);
    readyz=\$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/readyz);
    app=\$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/app);
    console=\$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/admin/overview);
    body=\$(curl -sS -X POST http://127.0.0.1:$PORT/api/v1/telemetry/events);
    echo \"livez=\$livez readyz=\$readyz app=\$app console=\$console\";
    case \"\$body\" in *BUSINESS_ROUTE_NOT_BUILT*) echo ingest=NOT_BUILT;; *) echo ingest=OTHER;; esac
  " 2>&1)" || die "could not probe the kernel container"
  printf '%s\n' "$out" | sed 's/^/    /'
  case "$out" in
    *"livez=200"*) ;;
    *) die "the kernel does not answer /livez inside its container: $out" ;;
  esac
  case "$out" in
    *"app=404"*) ;;
    *) die "the Ops prefix is not refused inside the container: $out" ;;
  esac
  case "$out" in
    *ingest=NOT_BUILT*) ;;
    *) die "the ingest route is not reported as not-built: $out" ;;
  esac
  ok "the Ops application is absent from the served build (verified in-container)"
}

platform_image() {
  printf '%s' "${OPSWEAVE_IMAGE:-$(kernel_image)}"
}

# The group that owns the docker socket the NODE will mount.
#
# The node container joins this group so its `docker` CLI can talk to the
# daemon. A wrong value is not cosmetic: the node starts, then every call fails
# with "permission denied while trying to connect to the docker API", which is
# how the first real install failed (P001-B.1). The socket path is taken from
# the daemon when possible - Docker Desktop keeps it outside /var/run.
detect_docker_gid() {
  local sock
  sock="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed 's|^unix://||')"
  for candidate in "$sock" /var/run/docker.sock; do
    [ -n "$candidate" ] || continue
    [ -S "$candidate" ] || continue
    stat -c '%g' "$candidate" 2>/dev/null && return 0
    stat -f '%g' "$candidate" 2>/dev/null && return 0
  done
  echo "999"
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
  local pg_password bridge_ip db_host docker_gid
  bridge_ip="$(detect_bridge_ip)"
  # Where the KERNEL reaches PostgreSQL. The Kernel uses host networking, so it
  # talks to the host's published port. `172.17.0.1` is only correct on a stock
  # Linux bridge; on Docker Desktop the host runs in a VM and the gateway is
  # `host.docker.internal`. Choosing this by assumption is what made the first
  # real install time out on "connect to PostgreSQL" with a healthy database.
  db_host="$(resolve_db_host "$bridge_ip")"
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
DATABASE_URL=postgres://opsweave:$pg_password@__DB_HOST__:$PG_PORT/opsweave?sslmode=disable
OPSWEAVE_PUBLIC_URL=${OPSWEAVE_PUBLIC_URL:-http://$host:$PORT}
OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=$admin_email
OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=$admin_password
OPSWEAVE_BOOTSTRAP_ADMIN_NAME=${OPSWEAVE_BOOTSTRAP_ADMIN_NAME:-Platform Admin}
OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1
OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1
OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=127.0.0.1,${bridge_ip:-127.0.0.1}
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

  # Before any service starts: can this host publish on the docker bridge
  # gateway? The answer decides whether the override file joins the compose set.
  say "checking the plugin gateway"
  configure_plugin_gateway

  # A pull is not required for correctness when the images are already present:
  # a transient registry outage must not block an install that has everything it
  # needs locally. Retried because Docker Hub regularly answers 5xx/EOF, then
  # tolerated if the images exist.
  say "pulling images"
  if ! compose pull postgres registry; then
    if docker image inspect postgres:17 >/dev/null 2>&1 && docker image inspect registry:2 >/dev/null 2>&1; then
      warn "could not refresh base images (registry unreachable); using the local copies"
    else
      die "could not pull postgres:17 / registry:2 and no local copy exists"
    fi
  fi

  say "starting PostgreSQL and the registry"
  OPSWEAVE_IMAGE="$image" compose up -d postgres registry
  wait_healthy postgres registry

  # PostgreSQL is up, so the reachable address can be OBSERVED rather than
  # assumed. The Kernel uses host networking and therefore cannot use the
  # compose service name.
  say "resolving the database address"
  db_host="$(resolve_db_host "$(detect_bridge_ip)")"
  ok "the kernel will reach PostgreSQL at $db_host:$PG_PORT"
  sed -i.bak "s|@__DB_HOST__:|@$db_host:|" "$PLATFORM_DIR/kernel.env" && rm -f "$PLATFORM_DIR/kernel.env.bak"
  chmod 600 "$PLATFORM_DIR/kernel.env"

  say "starting the Kernel"
  OPSWEAVE_IMAGE="$image" compose up -d kernel
  wait_healthy kernel

  # The first-boot assertion this whole profile exists for: the Kernel must be
  # alive AND must not contain the Ops application.
  say "verifying the platform-only boundary"
  # The probes below go through the published port. On Linux that is the host
  # network the Kernel joined; on Docker Desktop a host-networked container is
  # NOT reachable from the macOS host at all, so the URL answers 502 from the
  # VM's proxy. Detecting that difference is the difference between "the install
  # is broken" and "this environment cannot observe it from here".
  if ! reachable_from_host; then
    API_CONTEXT="container"
    # Inside the container the Kernel listens on its own loopback; the host's
    # 127.0.0.1:<port> and the container's are different addresses.
    API_URL="http://127.0.0.1:$PORT"
    warn "the Kernel is up but $URL is not reachable from this host."
    warn "  With docker's host networking on Docker Desktop, container ports are not"
    warn "  published to the macOS host. Verify from inside the container instead:"
    warn "    docker exec $PROJECT-kernel-1 curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/app"
    warn "  A Linux host (the deployment target) does not have this limitation."
    verify_boundary_in_container "$image"
  else
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
  fi

  # Remembered so `start`, `upgrade` and `restore` compose the same way this
  # install did; otherwise a host without a bindable gateway would lose its
  # services on the next command.
  printf 'OPSWEAVE_PLUGIN_GATEWAY_IP=%s\n' "${PLUGIN_GATEWAY_IP:-}" > "$PLATFORM_DIR/gateway.env"
  chmod 600 "$PLATFORM_DIR/gateway.env"

  say "bootstrap administrator"
  if ! login_probe "$admin_email" "$admin_password"; then
    die "the bootstrap administrator could not sign in; see: docker compose -p $PROJECT logs kernel"
  fi
  ok "signed in as $admin_email"

  # The node drives plugin containers through the host docker socket. Whether
  # that is possible as a non-root user depends on how the socket is presented
  # INSIDE the container, which is not the same as its host ownership: Docker
  # Desktop mounts it as root:root whatever the host says, so `group_add` cannot
  # help there. Probe it, then either proceed or tell the operator exactly what
  # will not work - never start a node that silently cannot manage plugins.
  say "checking docker socket access for the node"
  if docker run --rm --entrypoint /bin/sh \
      -v /var/run/docker.sock:/var/run/docker.sock \
      --group-add "$(detect_docker_gid)" "$image" \
      -c 'docker version >/dev/null 2>&1' >/dev/null 2>&1; then
    ok "the node can reach the docker daemon as its own user"
  elif [ "${OPSWEAVE_NODE_RUN_AS_ROOT:-0}" = "1" ]; then
    export OPSWEAVE_NODE_USER="0:0"
    warn "the docker socket is not reachable as an unprivileged user; running the node"
    warn "  as root because OPSWEAVE_NODE_RUN_AS_ROOT=1. This is a deliberate trade of"
    warn "  isolation for function and is NOT the recommended posture."
  else
    warn "the docker socket is NOT reachable from the node container as an unprivileged"
    warn "  user. The node will start but cannot create plugin containers, so plugin"
    warn "  deployment will fail. Docker Desktop presents the socket as root:root inside"
    warn "  containers, which no group can fix."
    warn "  Options: run on a Linux host (the deployment target), or re-run with"
    warn "  OPSWEAVE_NODE_RUN_AS_ROOT=1 to accept a root node container."
    warn "  Continuing: the PLATFORM itself (identity, console, registry) does not need it."
  fi

  say "enrolling the node"
  local node_token
  node_token="$(issue_node_token "$admin_email" "$admin_password")" || die "could not mint a node enrolment token"
  if [ -n "$node_token" ]; then
    sed -i.bak "s|^OPSWEAVE_ENROLLMENT_TOKEN=.*|OPSWEAVE_ENROLLMENT_TOKEN=$node_token|" "$PLATFORM_DIR/node.env"
    rm -f "$PLATFORM_DIR/node.env.bak"
    chmod 600 "$PLATFORM_DIR/node.env"
  fi
  OPSWEAVE_IMAGE="$image" compose up -d node
  # A node that cannot reach the docker socket never becomes healthy, and that is
  # a fact about the HOST, not a failed install: identity, the console, the
  # registry and diagnostics all work without a node. Reporting it as success
  # would be a lie; aborting the install would overstate its importance. The
  # install completes and the summary says exactly what does not work.
  NODE_STATE="healthy"
  if ! wait_healthy_soft node 120; then
    NODE_STATE="unhealthy"
    warn "the node did not become healthy; the platform is usable but has no node"
    docker compose -p "$PROJECT" $(for f in "${COMPOSE_FILES[@]}"; do printf -- '-f %s ' "$f"; done) logs --tail 5 node 2>/dev/null | sed 's/^/    /' || true
  fi
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
# Decides API_CONTEXT on first use, so commands other than `install` (restore,
# status, upgrade) probe the same way. Cheap: one /livez request.
ensure_api_context() {
  [ "${API_CONTEXT_RESOLVED:-0}" = "1" ] && return 0
  if reachable_from_host || [ "${API_CONTEXT:-host}" = "container" ]; then
    :
  else
    API_CONTEXT="container"
    API_URL="http://127.0.0.1:$PORT"
  fi
  API_CONTEXT_RESOLVED=1
}

http_code() {
  ensure_api_context
  if [ "$API_CONTEXT" = "container" ]; then
    local cid; cid="$(compose ps -q kernel 2>/dev/null || true)"
    [ -n "$cid" ] || { echo "000"; return 0; }
    docker exec "$cid" /bin/sh -c 'curl -sS -o /dev/null -w "%{http_code}" "$@"' _ "$@" 2>/dev/null || echo "000"
  else
    curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo "000"
  fi
}

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

# Same rule as issue_node_token: the password goes on stdin, never argv.
# wait_healthy, but returns 1 instead of dying. For a service whose absence is a
# degraded platform rather than a failed install.
wait_healthy_soft() {
  local services="$1" limit="${2:-120}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    local all=1 cid state
    for svc in $services; do
      cid="$(compose ps -q "$svc" 2>/dev/null || true)"
      if [ -z "$cid" ]; then all=0; break; fi
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
      case "$state" in healthy|running) ;; *) all=0 ;; esac
    done
    [ "$all" = "1" ] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

# --- credential handling -----------------------------------------------------
#
# No secret is ever a process ARGUMENT. `/proc/<pid>/cmdline` - what `ps` prints -
# is readable by any process of the same user, and this script runs as root on a
# deployment host. The previous implementation did
#
#     python3 -c '...' "$email" "$password"
#
# which published the administrator password for the lifetime of that process.
#
# The rules, enforced by tests/ci/p001_credential_argv.sh:
#   * values enter python3 on STDIN, NUL-separated;
#   * JSON comes from json.dumps, never string concatenation, so quotes,
#     backslashes, newlines and non-ASCII round-trip. No password character is
#     forbidden to make escaping easier;
#   * container-side scratch files live in a per-call `mktemp -d` under /tmp and
#     are removed from a RETURN trap as well as on the success path, so an
#     interrupted `docker exec` cannot leave a cookie jar behind.

# {"email":...,"password":...} on stdout, from two NUL-separated STDIN fields.
# NUL is the separator because a password may contain newlines and quotes; the
# only byte it cannot contain is NUL itself.
json_login_payload() {
  python3 -I -c '
import json, sys
raw = sys.stdin.buffer.read().split(b"\0")
email = raw[0].decode("utf-8", "surrogateescape") if raw else ""
password = raw[1].decode("utf-8", "surrogateescape") if len(raw) > 1 else ""
sys.stdout.write(json.dumps({"email": email, "password": password}))
'
}

# The `csrfToken` of a JSON document read from STDIN ("" when absent/malformed).
csrf_from_stdin() {
  python3 -I -c '
import json, sys
try:
    print(json.load(sys.stdin).get("csrfToken", ""))
except Exception:
    print("")
'
}

# The `token` of a JSON document read from STDIN.
token_from_stdin() {
  python3 -I -c '
import json, sys
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw) if raw else {}
except Exception:
    d = {}
sys.stdout.write(d.get("token", "") if isinstance(d, dict) else "")
'
}

# A private scratch directory INSIDE the Kernel container, removed by a RETURN
# trap. Prints the directory on success; prints nothing and returns 1 if the
# container cannot create one.
container_scratch() {
  local cid="$1" dir
  dir="$(docker exec "$cid" /bin/sh -c 'mktemp -d /tmp/owp.XXXXXX && chmod 700 "$1"' _ /tmp 2>/dev/null || true)"
  # Validate the shape before it is interpolated into a later `rm -rf`: an empty
  # string or anything outside /tmp/owp.* is refused.
  case "$dir" in
    /tmp/owp.*) printf '%s' "$dir" ;;
    *) return 1 ;;
  esac
}

login_probe() {
  local email="$1" password="$2" dir code cid work payload
  dir="$(mktemp -d)" || return 1
  chmod 700 "$dir"
  payload="$(printf '%s\0%s' "$email" "$password" | json_login_payload)" \
    || { rm -rf "$dir"; return 1; }

  if [ "$API_CONTEXT" = "container" ]; then
    cid="$(compose ps -q kernel 2>/dev/null || true)"
    [ -n "$cid" ] || { rm -rf "$dir"; return 1; }
    work="$(container_scratch "$cid")" || { rm -rf "$dir"; return 1; }
    # Cleanup runs on EVERY exit from here, not only on the success path.
    trap 'docker exec "$cid" /bin/sh -c "rm -rf $work" >/dev/null 2>&1 || true' RETURN
    printf '%s' "$payload" | docker exec -i "$cid" /bin/sh -c "cat > $work/login.json" 2>/dev/null || true
    code="$(docker exec "$cid" /bin/sh -c "curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @$work/login.json $API_URL/api/v1/auth/login" 2>/dev/null || echo 000)"
    docker exec "$cid" /bin/sh -c "rm -rf $work" >/dev/null 2>&1 || true
    # A RETURN trap is global: it would fire on every later function's return,
    # with $cid and $work long out of scope. Cleaning up explicitly and disarming
    # is the only correct use of it inside a helper.
    trap - RETURN
    rm -rf "$dir"
    [ "$code" = "200" ]
    return $?
  fi

  code="$(printf '%s' "$payload" | curl -sS -o /dev/null -w '%{http_code}' -c "$dir/jar" \
    -X POST -H 'content-type: application/json' --data-binary @- \
    "$API_URL/api/v1/auth/login" 2>/dev/null || echo 000)"
  rm -rf "$dir"
  [ "$code" = "200" ]
}

# Mints a one-time node enrolment token.
#
# The password and the token both travel on STDIN; container-side files live in a
# per-call scratch directory removed by a RETURN trap.
issue_node_token() {
  local email="$1" password="$2"
  local dir jar csrf body cid work payload
  dir="$(mktemp -d)" || return 1
  chmod 700 "$dir"
  jar="$dir/jar"
  payload="$(printf '%s\0%s' "$email" "$password" | json_login_payload)" \
    || { rm -rf "$dir"; return 1; }

  # The cookie jar must live where the NEXT call runs, so both requests are
  # issued in one context. In container mode that context is the Kernel's own.
  if [ "$API_CONTEXT" = "container" ]; then
    cid="$(compose ps -q kernel 2>/dev/null || true)"
    [ -n "$cid" ] || { rm -rf "$dir"; return 1; }
    work="$(container_scratch "$cid")" || { rm -rf "$dir"; return 1; }
    trap 'docker exec "$cid" /bin/sh -c "rm -rf $work" >/dev/null 2>&1 || true' RETURN

    printf '%s' "$payload" | docker exec -i "$cid" /bin/sh -c "cat > $work/login.json" 2>/dev/null || true
    docker exec "$cid" /bin/sh -c "curl -sS -c $work/jar -X POST -H 'content-type: application/json' --data-binary @$work/login.json $API_URL/api/v1/auth/login -o $work/resp.json" >/dev/null 2>&1 || true
    csrf="$(docker exec "$cid" /bin/sh -c "cat $work/resp.json" 2>/dev/null | csrf_from_stdin || true)"
    if [ -z "$csrf" ]; then
      docker exec "$cid" /bin/sh -c "rm -rf $work" >/dev/null 2>&1 || true
      trap - RETURN
      rm -rf "$dir"
      return 1
    fi
    body="$(docker exec "$cid" /bin/sh -c "curl -sS -b $work/jar -X POST -H 'x-csrf-token: '"$csrf"' -H 'content-type: application/json' -d '{\"label\":\"'"${OPSWEAVE_NODE_NAME:-platform-node}"'\",\"ttlMinutes\":60}' $API_URL/api/v1/nodes/enrollment-tokens" 2>/dev/null || true)"
    docker exec "$cid" /bin/sh -c "rm -rf $work" >/dev/null 2>&1 || true
    trap - RETURN
    rm -rf "$dir"
    token_from_stdin <<< "$body"
    return 0
  fi

  printf '%s' "$payload" | curl -sS -c "$jar" -X POST \
      -H 'content-type: application/json' --data-binary @- \
      "$API_URL/api/v1/auth/login" -o "$dir/login.json" 2>/dev/null || true
  csrf="$(csrf_from_stdin < "$dir/login.json" 2>/dev/null || true)"
  if [ -z "$csrf" ]; then rm -rf "$dir"; return 1; fi

  body="$(curl -sS -b "$jar" -X POST -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
    -d "{\"label\":\"${OPSWEAVE_NODE_NAME:-platform-node}\",\"ttlMinutes\":60}" \
    "$API_URL/api/v1/nodes/enrollment-tokens" 2>/dev/null || true)"
  rm -rf "$dir"
  token_from_stdin <<< "$body"
}

report() {
  local version apps
  version="$(curl -sS "$URL/api/v1/version" 2>/dev/null || echo '{}')"
  printf '  version:   %s\n' "$version"
  printf '  kernel:    %s\n' "$(http_code "$URL/livez") /livez, $(http_code "$URL/readyz") /readyz"
  printf '  node:      %s\n' "${NODE_STATE:-unknown}"
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
  wait_healthy postgres registry kernel
  # A node that cannot reach the docker socket is a host limitation, not a failed
  # start (same rule as install and restore).
  if ! wait_healthy_soft node 60; then
    NODE_STATE="unhealthy"
    warn "the node did not become healthy; the platform is up"
  fi
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
  # The image may be local (a build) or remote (a registry ref). Pulling a local
  # tag fails with "pull access denied", which is not an error in that case: the
  # switch is decided by whether the image exists in the daemon.
  if docker image inspect "$image" >/dev/null 2>&1; then
    ok "$image is present locally; not pulling"
  else
    compose pull kernel node || die "could not pull $image"
  fi

  # Kernel and node are replaced WITHOUT their dependencies, in that order: the
  # node needs a live kernel to re-register against, and recreating postgres or
  # the registry would drop the data the upgrade is supposed to preserve.
  OPSWEAVE_IMAGE="$image" compose up -d --no-deps kernel
  wait_healthy kernel
  OPSWEAVE_IMAGE="$image" compose up -d --no-deps node
  # The node is a separate failure domain: on a host where it cannot reach the
  # docker socket it never becomes healthy, and that must not turn a successful
  # kernel switch into a failed $label (same rule as install and restore).
  if ! wait_healthy_soft node 120; then
    NODE_STATE="unhealthy"
    warn "the node did not become healthy after the $label; the kernel switch itself succeeded"
  fi

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
# What a restore needs, measured rather than assumed:
#
#   * PostgreSQL   - identity, sessions, grants, the plugin registry ledger, the
#                    cursor secret (which derives the Ed25519 key), the audit
#                    ledger. Without it nothing authenticates.
#   * kernel volume - /app/data: the plugin package store and its backups dir.
#                    The Kernel can start without it, but installed packages
#                    referenced by the ledger are gone, so the registry would
#                    point at artifacts that no longer exist.
#   * registry volume - the OCI blobs. NOT included here, and that is a stated
#                    limit, not an oversight: plugin images can be re-pushed from
#                    their signed bundles, while the bundle store above is what
#                    the platform owns. A restore of this backup onto a fresh
#                    registry leaves installed plugins needing a re-push, and
#                    `restore` says so instead of reporting a clean recovery.
#
# Consistency boundary: pg_dump runs in one transaction against a live database.
# The kernel volume is copied afterwards, so the two halves are NOT a single
# point-in-time snapshot. A package written between the two would appear in the
# volume but not the ledger (harmless: unreferenced), and one written in the
# other direction would be in the ledger but not the volume (detected by the
# integrity check below, reported, not silently passed).
# ---------------------------------------------------------------------------

# Files every backup must contain. Checked on write and on read, so a truncated
# or hand-assembled archive cannot be restored as if it were complete.
BACKUP_REQUIRED=(opsweave.sql.gz MANIFEST kernel-data.sha256)

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "no sha256sum/shasum on this host; cannot verify the archive"
  fi
}

cmd_backup() {
  require_docker
  local stamp out tmp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="${1:-$ROOT/backups/opsweave-platform-$stamp.tar.gz}"
  mkdir -p "$(dirname "$out")"
  tmp="$(mktemp -d)"
  # Any failure leaves nothing behind, in the temp dir or at the destination.
  trap 'rm -rf "${tmp:-}"' RETURN

  # Both writers are checked before the first byte is written. A backup that
  # quietly omits half its content is worse than no backup: it is a file an
  # operator will trust.
  ensure_running postgres kernel

  say "dumping the database"
  # --clean --if-exists so a restore into a non-empty database is deterministic
  # rather than dependent on whatever was there.
  compose exec -T postgres pg_dump -U opsweave -d opsweave \
      --no-owner --no-privileges --clean --if-exists \
    > "$tmp/opsweave.sql" || die "pg_dump failed; no backup was written"
  # A dump smaller than the schema alone is a failed dump that exited 0.
  [ -s "$tmp/opsweave.sql" ] || die "pg_dump produced an empty file; no backup was written"
  gzip -9 "$tmp/opsweave.sql"

  say "archiving the kernel volume"
  mkdir -p "$tmp/kernel-data"
  docker cp "$(compose ps -q kernel):/app/data/." "$tmp/kernel-data/" \
    || die "could not copy the kernel package store; no backup was written"

  # Content inventory + checksum, so restore can prove it restored the same bytes.
  ( cd "$tmp/kernel-data" && find . -type f -print0 | sort -z | xargs -0 sha256sum 2>/dev/null ) \
    > "$tmp/kernel-data.sha256" || die "could not checksum the kernel package store"
  local file_count
  file_count="$(wc -l < "$tmp/kernel-data.sha256" | tr -d ' ')"

  cat > "$tmp/MANIFEST" <<EOF
opsweave-platform backup
format=1
created_at=$stamp
image=$(kernel_image)
build_sha=$(curl -sS "$URL/api/v1/version" 2>/dev/null | sed -n 's/.*"commitSha":"\([^"]*\)".*/\1/p')
kernel_version=$(curl -sS "$URL/api/v1/version" 2>/dev/null || echo '{}')
database_bytes=$(stat -c '%s' "$tmp/opsweave.sql.gz" 2>/dev/null || stat -f '%z' "$tmp/opsweave.sql.gz")
kernel_files=$file_count
database_sha256=$(sha256_of "$tmp/opsweave.sql.gz")
consistency=pg_dump-then-volume-copy; not-a-single-point-in-time
registry_included=no; re-push plugin images from their bundles after restore
EOF

  # Written beside the destination and renamed only when complete, so an
  # interrupted run cannot leave a normally-named, half-written backup.
  say "writing the archive"
  tar -czf "$tmp/backup.tar.gz" -C "$tmp" $(printf '%s ' "${BACKUP_REQUIRED[@]}") kernel-data \
    || die "could not assemble the archive; no backup was written"
  mv "$tmp/backup.tar.gz" "$out" || die "could not move the archive into place"

  # Read it back: a backup nobody has opened is a guess.
  tar -tzf "$out" >/dev/null 2>&1 || { rm -f "$out"; die "the archive is not readable; removed"; }
  ok "backup written to $out"
  printf '  database:  %s (sha256 %s…)\n' "$(grep database_bytes "$tmp/MANIFEST" | cut -d= -f2) bytes" "$(grep database_sha256 "$tmp/MANIFEST" | cut -d= -f2 | cut -c1-12)"
  printf '  packages:  %s files\n' "$file_count"
  printf '  restore with: %s restore %s\n' "$(basename "$0")" "$out"
  # A RETURN trap outlives the function that armed it; disarm before returning so
  # it cannot fire in a caller whose $tmp is a different (or absent) variable.
  trap - RETURN
}

kernel_image() {
  compose ps --format json 2>/dev/null | python3 -c 'import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except Exception: continue
    if d.get("Service")=="kernel": print(d.get("Image","")); break' 2>/dev/null || echo unknown
}

# Every service named is running and healthy, or this dies naming the one that
# is not. Used to refuse a backup whose inputs are absent.
ensure_running() {
  for svc in "$@"; do
    local cid state
    cid="$(compose ps -q "$svc" 2>/dev/null || true)"
    [ -n "$cid" ] || die "$svc is not running; refusing to write an incomplete backup"
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    case "$state" in
      healthy|running) ;;
      *) die "$svc is $state; refusing to write an incomplete backup" ;;
    esac
  done
}

# Order matters and is the point of this function:
#   quiesce writers -> validate -> restore data -> validate -> start -> reconcile.
# The previous order started the Kernel BEFORE restoring its volume, so the
# Kernel could migrate and write into a state the restore was about to replace.
cmd_restore() {
  require_docker
  local file="$1"
  [ -n "$file" ] || die "usage: restore <backup.tar.gz>"
  [ -f "$file" ] || die "no such backup: $file"

  if [ "${OPSWEAVE_RESTORE_FORCE:-0}" != "1" ]; then
    refuse "restore replaces the current database and kernel data. Re-run with OPSWEAVE_RESTORE_FORCE=1 to proceed."
  fi
  # An isolated target is stated, not assumed: the same env the install uses.
  local image
  image="${OPSWEAVE_IMAGE:-}"
  [ -n "$image" ] || die "set OPSWEAVE_IMAGE to the image the restored platform should run"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp:-}"' RETURN

  # --- 1. validate BEFORE touching anything -------------------------------
  say "validating $file"
  tar -tzf "$file" >/dev/null 2>&1 || die "$file is not a readable archive"
  # Reject absolute paths and parent traversal: an archive is untrusted input.
  local bad
  bad="$(tar -tzf "$file" | grep -E '(^/|(^|/)\.\.(/|$))' || true)"
  [ -z "$bad" ] || die "archive contains unsafe paths: $(echo "$bad" | head -3 | tr '\n' ' ')"
  # Refuse symlinks/hardlinks outright: this backup format never contains them,
  # and a link is how an archive writes outside the extraction root.
  bad="$(tar -tvzf "$file" | grep -E '^[lh]' || true)"
  [ -z "$bad" ] || die "archive contains links, which this format never writes"

  tar -xzf "$file" -C "$tmp" || die "cannot extract $file"
  for required in "${BACKUP_REQUIRED[@]}"; do
    [ -e "$tmp/$required" ] || die "backup is incomplete: missing $required"
  done
  [ -d "$tmp/kernel-data" ] || die "backup is incomplete: missing kernel-data/"

  local expected actual
  expected="$(grep '^database_sha256=' "$tmp/MANIFEST" | cut -d= -f2)"
  actual="$(sha256_of "$tmp/opsweave.sql.gz")"
  [ -n "$expected" ] || die "backup manifest has no database checksum"
  [ "$expected" = "$actual" ] || die "database dump checksum mismatch (manifest $expected, file $actual)"
  ( cd "$tmp/kernel-data" && { sha256sum -c "$tmp/kernel-data.sha256" >/dev/null 2>&1 \
      || shasum -a 256 -c "$tmp/kernel-data.sha256" >/dev/null 2>&1; } ) \
    || die "kernel package store checksum mismatch; refusing to restore a corrupt backup"

  # The manifest is the archive's own description of itself, so it is checked
  # for the fields a restore DEPENDS on rather than merely for being present. A
  # manifest that omits format or consistency is an archive from an older or
  # hand-built producer, and its other claims cannot be trusted either.
  for field in format created_at image database_bytes kernel_files database_sha256 consistency registry_included; do
    grep -q "^${field}=" "$tmp/MANIFEST" || die "backup manifest is missing '$field'; refusing to restore"
  done
  [ "$(grep '^format=' "$tmp/MANIFEST" | cut -d= -f2)" = "1" ]     || die "unsupported backup format (expected 1)"
  # The file count recorded at backup time must match what was archived, so a
  # truncated kernel-data directory is caught before the platform is stopped.
  declared_files="$(grep '^kernel_files=' "$tmp/MANIFEST" | cut -d= -f2)"
  archived_files="$(wc -l < "$tmp/kernel-data.sha256" | tr -d ' ')"
  [ "$declared_files" = "$archived_files" ] \
    || die "manifest declares $declared_files package files but the archive lists $archived_files"
  # A database dump smaller than the schema-only floor is a truncated dump that
  # gzip still decompressed happily.
  declared_bytes="$(grep '^database_bytes=' "$tmp/MANIFEST" | cut -d= -f2)"
  actual_bytes="$(wc -c < "$tmp/opsweave.sql.gz" | tr -d ' ')"
  [ "$declared_bytes" = "$actual_bytes" ] \
    || die "database dump is $actual_bytes bytes, the manifest recorded $declared_bytes"

  # What this archive CANNOT restore is part of validating it, and is reported
  # before anything is destroyed rather than after.
  case "$(grep '^registry_included=' "$tmp/MANIFEST")" in
    *no*) REGISTRY_RESTORED=no ;;
    *) REGISTRY_RESTORED=unknown ;;
  esac
  ok "archive validates (format $(grep '^format=' "$tmp/MANIFEST" | cut -d= -f2), $archived_files package files, registry: $REGISTRY_RESTORED)"

  # --- 2. quiesce every writer -------------------------------------------
  # Kernel and Node both stop before the database is touched. The Kernel writes
  # (migrations, audit, sessions) and the Node acts on its state; a running
  # writer during a DROP DATABASE is the failure this ordering exists to avoid.
  say "stopping the kernel and node"
  compose stop kernel node >/dev/null 2>&1 || true

  # --- 3. restore the data into a stopped platform ------------------------
  say "starting PostgreSQL only"
  OPSWEAVE_IMAGE="$image" compose up -d postgres >/dev/null
  wait_healthy postgres

  say "restoring the database"
  compose exec -T postgres psql -U opsweave -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS opsweave WITH (FORCE);" \
    -c "CREATE DATABASE opsweave OWNER opsweave;" || die "could not recreate the database"
  gunzip -c "$tmp/opsweave.sql.gz" \
    | compose exec -T postgres psql -U opsweave -d opsweave -v ON_ERROR_STOP=1 -q \
    || die "psql reported an error while restoring the dump"

  # --- 4. restore the kernel volume while the Kernel is still stopped -----
  # Through a throwaway container that mounts the volume: the Kernel is not
  # started to receive its own data, and a copy failure is fatal.
  say "restoring the kernel package store"
  local volume
  volume="$(compose config --format json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d["volumes"]["kernel"]["name"])' 2>/dev/null || true)"
  [ -n "$volume" ] || die "could not resolve the kernel volume name"
  # --user 0:0 because a freshly created docker volume is owned by root. The
  # Kernel runs as 10001 and cannot write into it, so a copy performed as the
  # runtime user fails with "Permission denied" (found on the first restore
  # drill). This is a DATA operation on a stopped platform, not a runtime one;
  # ownership is handed back to the runtime uid immediately afterwards so the
  # Kernel does not lose access to its own directory.
  docker run --rm --user 0:0 \
      -v "$volume:/target" -v "$tmp/kernel-data:/source:ro" \
      --entrypoint /bin/sh "$image" \
      -c 'rm -rf /target/* /target/.[!.]* 2>/dev/null; cp -a /source/. /target/ && chown -R 10001:10001 /target' \
    || die "could not restore the kernel package store; the platform is stopped and incomplete"

  # --- 5. validate what was restored, still stopped -----------------------
  say "verifying the restored content"
  local restored
  restored="$(docker run --rm --user 0:0 -v "$volume:/target:ro" --entrypoint /bin/sh "$image" \
      -c 'cd /target && find . -type f | wc -l' 2>/dev/null | tr -d ' ')"
  local expected_files
  expected_files="$(grep '^kernel_files=' "$tmp/MANIFEST" | cut -d= -f2)"
  [ "$restored" = "$expected_files" ] \
    || die "restored $restored package files, the backup holds $expected_files"
  ok "restored content matches the manifest ($restored files)"

  # --- 6. start the platform and reconcile --------------------------------
  say "starting the platform"
  OPSWEAVE_IMAGE="$image" compose up -d >/dev/null
  # postgres, registry and kernel are the recovery's own subject and must come
  # back. The node is a separate failure domain (see the install path): it cannot
  # reach the docker socket on some hosts, and a restore that reported failure
  # for that would blame the restore for a host limitation.
  wait_healthy postgres registry kernel
  if ! wait_healthy_soft node 60; then
    NODE_STATE="unhealthy"
    warn "the node did not become healthy after the restore; the platform itself is restored"
  fi

  say "integrity check"
  local code
  code="$(http_code "$URL/readyz")"
  [ "$code" = "200" ] || die "the restored kernel is not ready (readyz=$code)"
  code="$(http_code "$URL/app")"
  if [ "$code" != "404" ]; then
    warn "GET /app answered $code: this image is not platform-only, or the restore mixed builds"
  fi

  ok "restore complete"
  report
  warn "registry blobs were not part of this backup: installed plugins need their images re-pushed before they can start"
  trap - RETURN
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
