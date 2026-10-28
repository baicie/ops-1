#!/usr/bin/env bash
# OpsWeave staging release driver. Executes ON the staging host (Ubuntu 24.04, docker + compose + curl).
#
#   --sha <40 hex>   deploy that commit's image, verify health, roll back automatically on failure
#   --status         report the running release (JSON on stdout, human summary on stderr)
#   --rollback       return to the previously recorded successful release
#
# Isolation: every docker compose invocation is pinned with -p opsweave-staging and an explicit file
# list. Nothing here deletes containers, images or volumes, so unrelated projects on the host
# (workbuddy2api and friends) are never touched.
#
# Contract with deployments/staging/compose.yaml:
#   * the image is selected by the interpolated variable OPSWEAVE_IMAGE, and compose interpolation
#     does NOT read env_file, so each release is exported into the shell environment;
#   * OPSWEAVE_BUILD_SHA / OPSWEAVE_BUILD_TIME are what /api/v1/version reports as the served
#     commit, so they are pinned on every release;
#   * the kernel container uses the host network and listens on 18080, so health probes go to
#     http://127.0.0.1:18080 from the host (not to a container-internal port).
#
# Overrides used by local rehearsal only: OPSWEAVE_STAGING_ROOT, OPSWEAVE_STAGING_DATA,
# OPSWEAVE_STAGING_BACKUPS, OPSWEAVE_STAGING_LOGS, OPSWEAVE_BASE_URL, OPSWEAVE_APP_SERVICES.

set -euo pipefail

readonly PROJECT="opsweave-staging"
readonly DEFAULT_IMAGE_REPO="ghcr.io/baicie/opsweave"
readonly SHA_RE='^[0-9a-f]{40}$'
readonly ROOT_DIR="${OPSWEAVE_STAGING_ROOT:-/srv/opsweave-staging}"
readonly DATA_DIR="${OPSWEAVE_STAGING_DATA:-/var/lib/opsweave-staging}"
readonly BACKUP_ROOT="${OPSWEAVE_STAGING_BACKUPS:-/var/backups/opsweave-staging}"
readonly LOG_DIR="${OPSWEAVE_STAGING_LOGS:-/var/log/opsweave-staging}"
readonly COMPOSE_FILE="$ROOT_DIR/compose.yaml"
readonly ENV_FILE="$ROOT_DIR/staging.env"
readonly RELEASES_DIR="$ROOT_DIR/releases"
readonly BIN_DIR="$ROOT_DIR/bin"
readonly GHCR_TOKEN_FILE="$ROOT_DIR/ghcr.token"
readonly DEPLOY_DIR="$DATA_DIR/deployments"
readonly LOCK_FILE="$DATA_DIR/deploy.lock"
readonly LOCK_TIMEOUT="${OPSWEAVE_LOCK_TIMEOUT:-600}"
readonly IMAGE_REPO="${OPSWEAVE_IMAGE_REPO:-$DEFAULT_IMAGE_REPO}"

# Some clouds allow exactly one inbound port, so the preview port is host
# configuration rather than a code default. It lives in staging.env and is
# exported here so `docker compose` interpolates exactly the port the probes
# below use. Read before BASE_URL so the loopback probe follows the same value.
if [ -z "${OPSWEAVE_PREVIEW_PORT:-}" ] && [ -r "$ENV_FILE" ]; then
  OPSWEAVE_PREVIEW_PORT="$(sed -n 's/^OPSWEAVE_PREVIEW_PORT=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
fi
OPSWEAVE_PREVIEW_PORT="${OPSWEAVE_PREVIEW_PORT:-18080}"
case "$OPSWEAVE_PREVIEW_PORT" in
  ''|*[!0-9]*)
    printf 'ERROR OPSWEAVE_PREVIEW_PORT must be numeric, got %s\n' "$OPSWEAVE_PREVIEW_PORT" >&2
    exit 2
    ;;
esac
export OPSWEAVE_PREVIEW_PORT
readonly BASE_URL="${OPSWEAVE_BASE_URL:-http://127.0.0.1:$OPSWEAVE_PREVIEW_PORT}"
readonly APP_SERVICE_CANDIDATES="${OPSWEAVE_APP_SERVICES:-kernel node}"
readonly DEP_SERVICE_CANDIDATES="${OPSWEAVE_DEP_SERVICES:-postgres registry}"
readonly HEALTH_TIMEOUT="${OPSWEAVE_HEALTH_TIMEOUT:-180}"
readonly HEALTH_INTERVAL="${OPSWEAVE_HEALTH_INTERVAL:-3}"
readonly KERNEL_READY_TIMEOUT="${OPSWEAVE_KERNEL_READY_TIMEOUT:-120}"
readonly NODE_READY_TIMEOUT="${OPSWEAVE_NODE_READY_TIMEOUT:-120}"
readonly POSTGRES_READY_TIMEOUT="${OPSWEAVE_PG_READY_TIMEOUT:-120}"
readonly ROOT_MARKER='id="root"'
readonly PG_USER_DEFAULT="opsweave"
readonly PG_DB_DEFAULT="opsweave"

COMPOSE_CMD=()
ALL_SERVICES=()
APP_SERVICES=()
LOG_FILE=""
IMAGE_DIGEST=""
IMAGE_DIGEST_SOURCE=""
BACKUP_DIR=""
BACKUP_DB="skipped"
PG_READY_STATE="unknown"
DEPLOY_STARTED_AT=""
HEALTH_LIVEZ="fail"
HEALTH_READYZ="fail"
HEALTH_ROOT="fail"
HEALTH_CHECKED_AT=""
PG_USER="$PG_USER_DEFAULT"
PG_DB="$PG_DB_DEFAULT"
NODE_STATE_DIR="${OPSWEAVE_NODE_STATE_DIR_HOST:-$DATA_DIR/node}"
BOOTSTRAP_STATE="skipped"
BOOTSTRAP_DETAIL=""
NODE_READY_STATE="skipped"
NODE_READY_COUNT="0"
NODE_READY_CHECKED_AT=""
SERVED_SHA=""
SERVED_SHA_STATE="unknown"
API_JAR=""
API_CSRF=""
BOOTSTRAP_TMP=""
MODE=""
SHA_ARG=""
BASE_URL_ARG=""
JSON_ONLY=0

export OPSWEAVE_ENV_FILE="$ENV_FILE"

iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

append_log() {
  if [ -n "$LOG_FILE" ]; then
    printf '%s %s\n' "$(iso_now)" "$*" >>"$LOG_FILE" 2>/dev/null || true
  fi
}

log() {
  printf '%s %s\n' "$(iso_now)" "$*" >&2
  append_log "$*"
}

warn() {
  printf '%s WARN %s\n' "$(iso_now)" "$*" >&2
  append_log "WARN $*"
}

die() {
  local code="${1:-1}"
  shift || true
  printf '%s ERROR %s\n' "$(iso_now)" "$*" >&2
  append_log "ERROR $*"
  exit "$code"
}

usage() {
  cat <<'USAGE'
Usage: deploy-staging.sh <mode> [options]

Modes:
  --sha <40-hex-sha>   Deploy image ghcr.io/baicie/opsweave:<sha>. Backs up postgres and the
                       configuration, pins OPSWEAVE_IMAGE/OPSWEAVE_BUILD_SHA, starts the kernel,
                       enrols the node when it has no identity yet, polls /livez, /readyz and / for
                       up to 180s, and rolls back to the previous release when any check fails.
                       Exit 0 only when the new release is healthy.
  --status             Print the running release as JSON on stdout, human summary on stderr.
                       Exit 0 when the report was produced (check the "healthy" field for health).
  --rollback           Return to the release recorded in the "previous" pointer. Exit 1 when no
                       previous release is recorded.

Options:
  --base-url <url>     Public origin written to OPSWEAVE_PUBLIC_URL in staging.env (cookie security
                       and absolute links). Pass the address browsers use, e.g.
                       http://82.156.234.84:18080. Falls back to the value already in staging.env,
                       and to http://127.0.0.1:18080 when the file only holds a placeholder.
  --json               With --status: JSON only on stdout.
  -h, --help           Show this help.

Exit codes: 0 success, 1 deployment/rollback failure, 2 usage error.

Credentials:
  GHCR pulls reuse the docker login performed by CI. For a manual run, place a registry token in
  /srv/opsweave-staging/ghcr.token (0600) and set OPSWEAVE_GHCR_USER in staging.env; it is read over
  stdin by "docker login --password-stdin" and never appears in an argument list or a log line.
USAGE
}

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

json_str() { printf '"%s"' "$(json_escape "${1-}")"; }

json_or_null() {
  if [ -n "${1-}" ]; then json_str "$1"; else printf 'null'; fi
}

bool_str() {
  if [ "${1-}" = "true" ]; then printf 'true'; else printf 'false'; fi
}

# Extract a scalar field from a single-line JSON document without jq (the host has no toolchain).
json_field() {
  local doc="$1" key="$2"
  printf '%s' "$doc" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -n1
}

compose() {
  "${COMPOSE_CMD[@]}" -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

container_id() {
  compose ps -q "$1" 2>/dev/null | head -n1
}

service_exists() {
  local candidate="$1" known
  for known in ${ALL_SERVICES[@]+"${ALL_SERVICES[@]}"}; do
    if [ "$known" = "$candidate" ]; then return 0; fi
  done
  return 1
}

service_running() {
  local cid state
  cid="$(container_id "$1")"
  [ -n "$cid" ] || return 1
  state="$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || printf 'false')"
  [ "$state" = "true" ]
}

service_state() {
  local cid state
  cid="$(container_id "$1")"
  if [ -z "$cid" ]; then
    printf 'absent'
    return 0
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || printf 'unknown')"
  printf '%s' "$state"
}

service_image_ref() {
  local cid image
  cid="$(container_id "$1")"
  [ -n "$cid" ] || return 1
  image="$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  [ -n "$image" ] || return 1
  printf '%s' "$image"
}

pointer_value() {
  local file="$DEPLOY_DIR/$1"
  if [ -f "$file" ]; then
    head -n1 "$file" | tr -d '[:space:]'
  fi
}

set_pointer() {
  printf '%s\n' "${2-}" >"$DEPLOY_DIR/$1.tmp"
  chmod 600 "$DEPLOY_DIR/$1.tmp"
  mv -f "$DEPLOY_DIR/$1.tmp" "$DEPLOY_DIR/$1"
}

current_sha() {
  local recorded ref svc
  recorded="$(pointer_value current)"
  if [[ "$recorded" =~ $SHA_RE ]]; then
    printf '%s' "$recorded"
    return 0
  fi
  for svc in ${APP_SERVICES[@]+"${APP_SERVICES[@]}"}; do
    ref="$(service_image_ref "$svc" 2>/dev/null || true)"
    [ -n "$ref" ] || continue
    ref="${ref##*:}"
    if [[ "$ref" =~ $SHA_RE ]]; then
      printf '%s' "$ref"
      return 0
    fi
  done
  return 1
}

env_file_value() {
  local key="$1" fallback="$2" value
  value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" 2>/dev/null | tail -n1)"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/')"
  if [ -z "$value" ]; then
    value="$fallback"
  fi
  printf '%s' "$value"
}

# Rewrite one key in staging.env, preserving every other line and the file mode. The value travels
# through the environment, never through argv, so tokens are not readable from a process list.
set_env_file_value() {
  local key="$1" value="$2" tmp mode
  tmp="$ENV_FILE.tmp.$$"
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || printf '600')"
  OPSWEAVE_TMP_KEY="$key" OPSWEAVE_TMP_VALUE="$value" awk '
    BEGIN { k = ENVIRON["OPSWEAVE_TMP_KEY"]; v = ENVIRON["OPSWEAVE_TMP_VALUE"]; done = 0 }
    $0 ~ "^[[:space:]]*" k "[[:space:]]*=" && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

record_field() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*\"$key\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*$/\1/p" "$file" | head -n1
}

# Point compose interpolation at one release. An exported shell variable wins over --env-file.
pin_release_env() {
  local sha="$1" stamp="$2"
  export OPSWEAVE_IMAGE="$IMAGE_REPO:$sha"
  export OPSWEAVE_BUILD_SHA="$sha"
  export OPSWEAVE_BUILD_TIME="$stamp"
}

persist_release_env() {
  local existing public_url
  set_env_file_value OPSWEAVE_IMAGE "$IMAGE_REPO:$1"
  set_env_file_value OPSWEAVE_BUILD_SHA "$1"
  set_env_file_value OPSWEAVE_BUILD_TIME "$2"
  # The origin the kernel advertises (cookie security, absolute links). CI passes the canonical
  # staging URL; a placeholder is reported instead of being silently shipped.
  existing="$(env_file_value OPSWEAVE_PUBLIC_URL "")"
  public_url="${BASE_URL_ARG:-${OPSWEAVE_PUBLIC_URL_OVERRIDE:-$existing}}"
  case "$public_url" in
    ""|*__HOST_PUBLIC_IP__*|*__PLACEHOLDER__*)
      public_url="http://127.0.0.1:18080"
      warn "$ENV_FILE has no usable OPSWEAVE_PUBLIC_URL; wrote the loopback default $public_url — pass --base-url with the address browsers use"
      ;;
  esac
  if [ "$public_url" != "$existing" ]; then
    set_env_file_value OPSWEAVE_PUBLIC_URL "$public_url"
  fi
  export OPSWEAVE_PUBLIC_URL="$public_url"
  log "OPSWEAVE_PUBLIC_URL=$OPSWEAVE_PUBLIC_URL"
}

load_services() {
  local raw svc
  raw="$(compose config --services 2>/dev/null || true)"
  if [ -z "$raw" ]; then
    die 1 "cannot read services from $COMPOSE_FILE ('docker compose config --services' produced no output); check that OPSWEAVE_IMAGE and the variables in $ENV_FILE are valid"
  fi
  ALL_SERVICES=()
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    ALL_SERVICES+=("$svc")
  done <<<"$raw"
  APP_SERVICES=()
  for svc in $APP_SERVICE_CANDIDATES; do
    if service_exists "$svc"; then
      APP_SERVICES+=("$svc")
    fi
  done
  if [ "${#APP_SERVICES[@]}" -eq 0 ]; then
    die 1 "compose project defines none of the expected application services ($APP_SERVICE_CANDIDATES); defined: ${ALL_SERVICES[*]}"
  fi
  log "compose services: ${ALL_SERVICES[*]}; application services: ${APP_SERVICES[*]}"
}

preflight() {
  local cmd
  for cmd in docker curl; do
    command -v "$cmd" >/dev/null 2>&1 || die 1 "required command not found on this host: $cmd"
  done
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    die 1 "neither 'docker compose' nor 'docker-compose' is available"
  fi
  [ -f "$COMPOSE_FILE" ] || die 1 "compose file not found: $COMPOSE_FILE (deployments/staging/compose.yaml must be installed under $ROOT_DIR first)"
  [ -f "$ENV_FILE" ] || die 1 "environment file not found: $ENV_FILE"
  mkdir -p "$DEPLOY_DIR" "$BACKUP_ROOT" "$LOG_DIR" "$RELEASES_DIR" "$BIN_DIR"
  chmod 700 "$BACKUP_ROOT" "$DEPLOY_DIR"
  LOG_FILE="$LOG_DIR/deploy-$(utc_stamp).log"
  if ! touch "$LOG_FILE" 2>/dev/null; then
    LOG_FILE=""
    warn "cannot write under $LOG_DIR; continuing without a log file"
  fi
  PG_USER="$(env_file_value POSTGRES_USER "$PG_USER_DEFAULT")"
  PG_DB="$(env_file_value POSTGRES_DB "$PG_DB_DEFAULT")"
  # The compose file marks OPSWEAVE_IMAGE as required, so give interpolation a value even before the
  # first release; read-only commands (ps, config) then keep working on a fresh host.
  if [ -z "${OPSWEAVE_IMAGE:-}" ]; then
    local interpolated_image
    interpolated_image="$(env_file_value OPSWEAVE_IMAGE "$IMAGE_REPO:unknown")"
    export OPSWEAVE_IMAGE="$interpolated_image"
  fi
  load_services
}

# The node container talks to the host docker socket through group_add; compose falls back to 999
# when DOCKER_GID is unset, which silently breaks the node on hosts whose socket group differs.
detect_docker_gid() {
  local sock="${OPSWEAVE_DOCKER_SOCKET:-/var/run/docker.sock}" gid recorded
  if [ ! -e "$sock" ]; then
    die 1 "docker socket $sock does not exist; refusing to guess DOCKER_GID for the node container"
  fi
  gid="$(stat -c '%g' "$sock" 2>/dev/null || true)"
  if ! printf '%s' "$gid" | grep -Eq '^[0-9]+$'; then
    die 1 "cannot read a numeric group id from $sock; refusing to start the node with a guessed DOCKER_GID"
  fi
  recorded="$(env_file_value DOCKER_GID "")"
  if [ "$recorded" != "$gid" ]; then
    if [ -n "$recorded" ]; then
      log "DOCKER_GID in $ENV_FILE is $recorded but $sock belongs to group $gid; correcting it"
    else
      log "DOCKER_GID is unset in $ENV_FILE; pinning it to $gid from $sock"
    fi
    set_env_file_value DOCKER_GID "$gid"
  fi
  export DOCKER_GID="$gid"
  log "DOCKER_GID=$DOCKER_GID (from $sock)"
}

# Bind-mounted host directories must already belong to the uid the containers run as: postgres is
# 999, the image's opsweave user is 10001. A root-owned directory makes the kernel or node fail to
# start. chown -R runs only when ownership actually drifts, so repeated deploys stay cheap.
prepare_bind_dir() {
  local dir="$1" uid="$2" gid="$3" mode="$4" owner identity
  if [ ! -d "$dir" ]; then
    install -d -o "$uid" -g "$gid" -m "$mode" "$dir" || die 1 "cannot create $dir owned by $uid:$gid"
    log "created $dir owned by $uid:$gid mode $mode"
    return 0
  fi
  owner="$(stat -c '%u:%g' "$dir" 2>/dev/null || true)"
  identity="$dir/node-identity.json"
  if [ "$owner" = "$uid:$gid" ] && { [ ! -f "$identity" ] || [ "$(stat -c '%u:%g' "$identity")" = "$uid:$gid" ]; }; then
    return 0
  fi
  log "correcting ownership of $dir to $uid:$gid (was ${owner:-unknown})"
  chown -R "$uid:$gid" "$dir" || die 1 "cannot chown $dir to $uid:$gid"
  chmod "$mode" "$dir" || true
}

prepare_bind_dirs() {
  if [ -n "${OPSWEAVE_SKIP_BIND_DIR_PREP:-}" ] && [ -n "${OPSWEAVE_STAGING_ROOT:-}" ]; then
    warn "OPSWEAVE_SKIP_BIND_DIR_PREP is set with an overridden staging root; skipping ownership preparation (rehearsal only)"
    return 0
  fi
  [ "$(id -u)" = "0" ] || die 1 "bind-mounted host directories must be prepared as root; re-run with sudo"
  prepare_bind_dir "$DATA_DIR/pg" 999 999 0750
  prepare_bind_dir "$DATA_DIR/registry" 0 0 0755
  prepare_bind_dir "$DATA_DIR/kernel" 10001 10001 0750
  prepare_bind_dir "$DATA_DIR/node" 10001 10001 0750
}

cleanup_bootstrap() {
  if [ -n "$BOOTSTRAP_TMP" ] && [ -d "$BOOTSTRAP_TMP" ]; then
    case "$BOOTSTRAP_TMP" in
      "$DATA_DIR"/bootstrap.*) rm -rf "$BOOTSTRAP_TMP" ;;
      *) warn "refusing to clean unexpected path $BOOTSTRAP_TMP" ;;
    esac
  fi
}
trap cleanup_bootstrap EXIT

ensure_registry_auth() {
  if [ ! -f "$GHCR_TOKEN_FILE" ]; then
    log "no $GHCR_TOKEN_FILE; relying on an existing docker login for $IMAGE_REPO"
    return 0
  fi
  local user
  user="$(env_file_value OPSWEAVE_GHCR_USER x-access-token)"
  log "authenticating docker to ghcr.io as $user using $GHCR_TOKEN_FILE (token read over stdin)"
  if ! docker login ghcr.io --username "$user" --password-stdin <"$GHCR_TOKEN_FILE" >/dev/null 2>&1; then
    warn "docker login with $GHCR_TOKEN_FILE failed; continuing with the existing credentials"
    return 1
  fi
  return 0
}

resolve_remote_digest() {
  docker manifest inspect "$IMAGE_REPO:$1" >/dev/null 2>&1
}

check_image_available() {
  local sha="$1" attempt=1
  ensure_registry_auth || true
  while [ "$attempt" -le 3 ]; do
    if resolve_remote_digest "$sha"; then
      log "image $IMAGE_REPO:$sha resolves on the registry"
      return 0
    fi
    warn "image $IMAGE_REPO:$sha is not resolvable yet (attempt $attempt/3)"
    attempt="$((attempt + 1))"
    if [ "$attempt" -le 3 ]; then sleep 5; fi
  done
  die 1 "image $IMAGE_REPO:$sha is not resolvable from this host; check that the build pushed it and that registry credentials are valid"
}

pull_image() {
  local sha="$1" ref="$IMAGE_REPO:$1" output digests
  # The tag is the full commit SHA, so an image already present on this host is
  # immutable and needs no registry round trip. This matters because the blob
  # CDN can stall for minutes on some hosts; the image can also have been
  # transferred out of band (docker save | ssh | docker load).
  # Set OPSWEAVE_REQUIRE_PULL=1 to force a registry pull anyway.
  if docker image inspect "$ref" >/dev/null 2>&1 && [ "${OPSWEAVE_REQUIRE_PULL:-0}" != "1" ]; then
    log "image $ref is already present on this host; skipping the registry pull (OPSWEAVE_REQUIRE_PULL=1 forces it)"
  elif ! output="$(docker pull "$ref" 2>&1)"; then
    printf '%s\n' "$output" >&2
    warn "failed to pull $ref"
    return 1
  fi
  digests="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$ref" 2>/dev/null || true)"
  if [ -n "$digests" ]; then
    IMAGE_DIGEST="${digests#*@}"
    IMAGE_DIGEST_SOURCE="repo-digest"
  else
    IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
    IMAGE_DIGEST_SOURCE="image-id"
  fi
  log "pulled $ref (digest: ${IMAGE_DIGEST:-unknown})"
}

ensure_dependencies() {
  local svc
  for svc in $DEP_SERVICE_CANDIDATES; do
    service_exists "$svc" || continue
    if service_running "$svc"; then
      log "dependency service $svc already running"
      continue
    fi
    log "starting dependency service $svc (its data volumes are reused, never recreated)"
    if compose up -d --no-deps --wait --wait-timeout "$POSTGRES_READY_TIMEOUT" "$svc" >/dev/null 2>&1; then
      log "dependency service $svc is up and healthy (compose --wait)"
      continue
    fi
    log "compose --wait is unavailable or did not confirm $svc health; starting it and polling instead"
    if ! compose up -d --no-deps "$svc"; then
      die 1 "failed to start dependency service $svc"
    fi
  done
}

postgres_image_ref() {
  local cid image
  cid="$(container_id postgres)"
  if [ -n "$cid" ]; then
    image="$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
    if [ -n "$image" ]; then
      printf '%s' "$image"
      return 0
    fi
  fi
  printf 'postgres:17'
}

verify_backup() {
  local dump="$BACKUP_DIR/postgres.dump" toc="$BACKUP_DIR/postgres.toc" image
  if [ ! -s "$dump" ]; then
    warn "backup file is missing or empty: $dump"
    return 1
  fi
  image="$(postgres_image_ref)"
  if ! docker run --rm -v "$BACKUP_DIR:/backup:ro" "$image" pg_restore -l /backup/postgres.dump >"$toc" 2>"$BACKUP_DIR/postgres.toc.err"; then
    warn "pg_restore -l rejected $dump (see postgres.toc.err in the backup directory)"
    return 1
  fi
  if [ ! -s "$toc" ]; then
    warn "pg_restore -l produced an empty table of contents for $dump"
    return 1
  fi
  log "backup verified: $(wc -c <"$dump" | tr -d ' ') bytes, $(wc -l <"$toc" | tr -d ' ') table-of-content entries"
}

write_backup_manifest() {
  local sha="$1"
  {
    printf 'release_sha=%s\n' "$sha"
    printf 'created_at=%s\n' "$(iso_now)"
    printf 'compose_file=%s\n' "$COMPOSE_FILE"
    printf 'env_file=%s\n' "$ENV_FILE"
    printf 'postgres_dump=%s\n' "$BACKUP_DB"
    printf 'postgres_ready=%s\n' "$PG_READY_STATE"
    printf 'previous_running_sha=%s\n' "$(current_sha || true)"
  } >"$BACKUP_DIR/manifest.txt"
  chmod 600 "$BACKUP_DIR/manifest.txt"
}

# First boot races initdb: while the temporary instance finishes, the server accepts connections and
# even answers pg_isready, but the database named by POSTGRES_DB does not exist yet. Wait, bounded,
# before dumping; then decide whether the database is genuinely missing or simply not created yet.
wait_for_postgres() {
  local deadline remaining next_note count
  PG_READY_STATE="unknown"
  deadline=$((SECONDS + POSTGRES_READY_TIMEOUT))
  next_note=$((SECONDS + 10))
  log "waiting up to ${POSTGRES_READY_TIMEOUT}s (every ${HEALTH_INTERVAL}s) for database $PG_DB to accept queries"
  while :; do
    if compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tAc 'select 1' >/dev/null 2>&1; then
      PG_READY_STATE="ready"
      log "database $PG_DB accepts queries"
      return 0
    fi
    remaining=$((deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      break
    fi
    if [ "$SECONDS" -ge "$next_note" ]; then
      log "  postgres is still initialising (${remaining}s left)"
      next_note=$((SECONDS + 10))
    fi
    sleep "$HEALTH_INTERVAL"
  done
  # The maintenance database still answers while a target database is missing, which separates a
  # not-yet-created database from an unreachable server.
  count="$(compose exec -T postgres psql -U "$PG_USER" -d postgres -tAc "select count(*) from pg_database where datname='$PG_DB'" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$count" ]; then
    PG_READY_STATE="unreachable"
    warn "postgres did not answer within ${POSTGRES_READY_TIMEOUT}s and the cluster cannot be queried either"
    return 1
  fi
  if [ "$count" != "0" ]; then
    PG_READY_STATE="database-unusable"
    warn "the cluster knows $PG_DB but queries against it still fail after ${POSTGRES_READY_TIMEOUT}s"
    return 1
  fi
  if [ -n "$(current_sha || true)" ]; then
    PG_READY_STATE="database-missing"
    warn "database $PG_DB is absent while a release is already deployed; refusing to continue without a backup"
    return 1
  fi
  PG_READY_STATE="first-initialisation"
  warn "the cluster has no $PG_DB database and no release has been deployed yet: first initialisation, nothing to back up"
  return 0
}

create_backup() {
  local sha="$1" stamp
  stamp="$(utc_stamp)"
  BACKUP_DIR="$BACKUP_ROOT/$stamp-${sha:0:8}"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  install -m 600 "$ENV_FILE" "$BACKUP_DIR/staging.env"
  install -m 600 "$COMPOSE_FILE" "$BACKUP_DIR/compose.yaml"
  log "configuration backed up to $BACKUP_DIR"
  BACKUP_DB="skipped"
  if service_exists postgres; then
    if ! service_running postgres; then
      die 1 "postgres is defined but not running; refusing to deploy without a database backup"
    fi
    if ! wait_for_postgres; then
      die 1 "postgres is not usable ($PG_READY_STATE) after ${POSTGRES_READY_TIMEOUT}s; aborting before any image change"
    fi
    if [ "$PG_READY_STATE" = "first-initialisation" ]; then
      BACKUP_DB="skipped(first-initialisation)"
      log "no database exists yet on this first deployment; recording backup=$BACKUP_DB and continuing"
      write_backup_manifest "$sha"
      return 0
    fi
    log "dumping postgres database $PG_DB to $BACKUP_DIR/postgres.dump"
    if ! compose exec -T postgres pg_dump -Fc -U "$PG_USER" -d "$PG_DB" >"$BACKUP_DIR/postgres.dump"; then
      rm -f "$BACKUP_DIR/postgres.dump"
      die 1 "pg_dump failed; aborting before any image change"
    fi
    BACKUP_DB="dumped"
    if ! verify_backup; then
      die 1 "backup verification failed; aborting before any image change"
    fi
  else
    log "compose project defines no postgres service; no database dump needed"
  fi
  write_backup_manifest "$sha"
}

http_status() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "$1" 2>/dev/null || true)"
  if [ -z "$code" ]; then code="000"; fi
  printf '%s' "$code"
}

http_body() {
  curl -fsS --connect-timeout 5 --max-time 10 "$1" 2>/dev/null || true
}

reset_health() {
  HEALTH_LIVEZ="fail"
  HEALTH_READYZ="fail"
  HEALTH_ROOT="fail"
  HEALTH_CHECKED_AT=""
}

wait_kernel_livez() {
  local deadline remaining
  deadline="$((SECONDS + KERNEL_READY_TIMEOUT))"
  log "waiting up to ${KERNEL_READY_TIMEOUT}s for $BASE_URL/livez"
  while :; do
    if [ "$(http_status "$BASE_URL/livez")" = "200" ]; then
      log "kernel is live"
      return 0
    fi
    remaining="$((deadline - SECONDS))"
    if [ "$remaining" -le 0 ]; then
      warn "kernel did not answer /livez within ${KERNEL_READY_TIMEOUT}s"
      return 1
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

health_probe_once() {
  reset_health
  if [ "$(http_status "$BASE_URL/livez")" = "200" ]; then HEALTH_LIVEZ="pass"; fi
  if [ "$(http_status "$BASE_URL/readyz")" = "200" ]; then HEALTH_READYZ="pass"; fi
  if [ "$(http_status "$BASE_URL/")" = "200" ] && http_body "$BASE_URL/" | grep -q "$ROOT_MARKER"; then
    HEALTH_ROOT="pass"
  fi
  HEALTH_CHECKED_AT="$(iso_now)"
  if [ "$HEALTH_LIVEZ" = "pass" ] && [ "$HEALTH_READYZ" = "pass" ] && [ "$HEALTH_ROOT" = "pass" ]; then
    return 0
  fi
  return 1
}

health_check() {
  local deadline remaining
  reset_health
  deadline="$((SECONDS + HEALTH_TIMEOUT))"
  log "polling $BASE_URL/livez, $BASE_URL/readyz and $BASE_URL/ for up to ${HEALTH_TIMEOUT}s"
  while :; do
    if [ "$HEALTH_LIVEZ" != "pass" ] && [ "$(http_status "$BASE_URL/livez")" = "200" ]; then
      HEALTH_LIVEZ="pass"
      log "  /livez up"
    fi
    if [ "$HEALTH_READYZ" != "pass" ] && [ "$(http_status "$BASE_URL/readyz")" = "200" ]; then
      HEALTH_READYZ="pass"
      log "  /readyz ready"
    fi
    if [ "$HEALTH_LIVEZ" = "pass" ] && [ "$HEALTH_READYZ" = "pass" ] && [ "$HEALTH_ROOT" != "pass" ]; then
      if [ "$(http_status "$BASE_URL/")" = "200" ] && http_body "$BASE_URL/" | grep -q "$ROOT_MARKER"; then
        HEALTH_ROOT="pass"
        log "  / serves the application shell"
      fi
    fi
    if [ "$HEALTH_LIVEZ" = "pass" ] && [ "$HEALTH_READYZ" = "pass" ] && [ "$HEALTH_ROOT" = "pass" ]; then
      HEALTH_CHECKED_AT="$(iso_now)"
      log "health checks passed"
      return 0
    fi
    remaining="$((deadline - SECONDS))"
    if [ "$remaining" -le 0 ]; then
      HEALTH_CHECKED_AT="$(iso_now)"
      warn "health checks did not pass within ${HEALTH_TIMEOUT}s (livez=$HEALTH_LIVEZ readyz=$HEALTH_READYZ root=$HEALTH_ROOT)"
      return 1
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

# /api/v1/version reports the commit the kernel is actually serving. A mismatch means the container
# is not running the release we just pinned; it is recorded here and enforced by the CI smoke job.
served_commit_check() {
  local target="${1-}" body
  SERVED_SHA=""
  SERVED_SHA_STATE="unknown"
  body="$(http_body "$BASE_URL/api/v1/version")"
  if [ -z "$body" ]; then
    SERVED_SHA_STATE="unavailable"
    warn "/api/v1/version is not reachable"
    return 0
  fi
  SERVED_SHA="$(json_field "$body" commitSha)"
  if [ -z "$SERVED_SHA" ] || [ "$SERVED_SHA" = "null" ]; then
    SERVED_SHA=""
    SERVED_SHA_STATE="absent"
    warn "/api/v1/version does not report a commitSha"
    return 0
  fi
  if [ -z "$target" ]; then
    SERVED_SHA_STATE="observed"
    return 0
  fi
  if [ "$SERVED_SHA" = "$target" ]; then
    SERVED_SHA_STATE="match"
    log "kernel reports serving commit $SERVED_SHA"
  else
    SERVED_SHA_STATE="mismatch"
    warn "kernel reports serving commit $SERVED_SHA but $target was deployed; OPSWEAVE_BUILD_SHA may not have reached the container"
  fi
  return 0
}

health_json() {
  printf '{"livez": %s, "readyz": %s, "root": %s, "checked_at": %s, "timeout_seconds": %s}' \
    "$(json_str "$HEALTH_LIVEZ")" \
    "$(json_str "$HEALTH_READYZ")" \
    "$(json_str "$HEALTH_ROOT")" \
    "$(json_str "$HEALTH_CHECKED_AT")" \
    "$HEALTH_TIMEOUT"
}

served_json() {
  printf '{"sha": %s, "state": %s}' "$(json_or_null "$SERVED_SHA")" "$(json_str "$SERVED_SHA_STATE")"
}

node_identity_file() {
  printf '%s' "$NODE_STATE_DIR/node-identity.json"
}

node_identity_present() {
  [ -f "$(node_identity_file)" ]
}

node_json() {
  printf '{"bootstrap": %s, "detail": %s, "identity_file": %s, "ready_state": %s, "ready_nodes": %s, "checked_at": %s}' \
    "$(json_str "$BOOTSTRAP_STATE")" \
    "$(json_or_null "$BOOTSTRAP_DETAIL")" \
    "$(json_str "$(node_identity_file)")" \
    "$(json_str "$NODE_READY_STATE")" \
    "$NODE_READY_COUNT" \
    "$(json_or_null "$NODE_READY_CHECKED_AT")"
}

# Establish a kernel API session without putting the admin password into an argument list.
# opsctl only accepts --password as an argv argument, so this drives the same HTTP endpoints opsctl
# uses: POST /api/v1/auth/login (password travels over stdin) and the enrolment-token endpoint.
api_login() {
  if [ -n "$API_CSRF" ] && [ -n "$API_JAR" ] && [ -f "$API_JAR" ]; then
    return 0
  fi
  local email password body code csrf
  email="$(env_file_value OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL "")"
  password="$(env_file_value OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD "")"
  if [ -z "$email" ] || [ -z "$password" ]; then
    BOOTSTRAP_DETAIL="OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set in $ENV_FILE"
    return 1
  fi
  if [ -z "$BOOTSTRAP_TMP" ] || [ ! -d "$BOOTSTRAP_TMP" ]; then
    BOOTSTRAP_TMP="$(mktemp -d "$DATA_DIR/bootstrap.XXXXXX")"
    chmod 700 "$BOOTSTRAP_TMP"
  fi
  API_JAR="$BOOTSTRAP_TMP/cookies.txt"
  body="$(printf '{"email":%s,"password":%s}' "$(json_str "$email")" "$(json_str "$password")")"
  code="$(printf '%s' "$body" | curl -sS -o "$BOOTSTRAP_TMP/login.json" -w '%{http_code}' \
    -c "$API_JAR" -H 'content-type: application/json' --data-binary @- \
    --connect-timeout 5 --max-time 20 "$BASE_URL/api/v1/auth/login" 2>/dev/null || printf '000')"
  if [ "$code" != "200" ]; then
    BOOTSTRAP_DETAIL="kernel login returned HTTP $code"
    warn "kernel login as $email failed with HTTP $code"
    return 1
  fi
  csrf="$(json_field "$(cat "$BOOTSTRAP_TMP/login.json")" csrfToken)"
  if [ -z "$csrf" ]; then
    BOOTSTRAP_DETAIL="login response did not include csrfToken"
    return 1
  fi
  API_CSRF="$csrf"
  printf 'header = "x-csrf-token: %s"\n' "$csrf" >"$BOOTSTRAP_TMP/csrf.conf"
  chmod 600 "$BOOTSTRAP_TMP/csrf.conf"
  log "kernel API session established for $email"
  return 0
}

api_post() {
  local path="$1" payload="$2" out="$3"
  printf '%s' "$payload" | curl -sS -o "$out" -w '%{http_code}' \
    --config "$BOOTSTRAP_TMP/csrf.conf" -b "$API_JAR" -H 'content-type: application/json' \
    --data-binary @- --connect-timeout 5 --max-time 20 "$BASE_URL$path" 2>/dev/null || printf '000'
}

api_get() {
  local path="$1" out="$2"
  curl -sS -o "$out" -b "$API_JAR" -w '%{http_code}' --connect-timeout 5 --max-time 20 "$BASE_URL$path" 2>/dev/null || printf '000'
}

# First-run node enrolment, then always (re)start the node on the release just applied.
# Idempotent by design: an existing identity file means the node already owns a credential and must
# never be re-enrolled, because re-enrolment bumps the generation and breaks node history.
bootstrap_node() {
  BOOTSTRAP_STATE="skipped"
  BOOTSTRAP_DETAIL=""
  if ! service_exists node; then
    BOOTSTRAP_STATE="skipped"
    BOOTSTRAP_DETAIL="compose project defines no node service"
    warn "no node service in the compose project; skipping node start"
    return 0
  fi
  if node_identity_present; then
    BOOTSTRAP_STATE="identity-present"
    BOOTSTRAP_DETAIL="node credential already at $(node_identity_file)"
    log "node identity present at $(node_identity_file); skipping enrolment"
  else
    log "no node identity at $(node_identity_file); bootstrapping first enrolment"
    if ! api_login; then
      BOOTSTRAP_STATE="blocked"
      BOOTSTRAP_DETAIL="${BOOTSTRAP_DETAIL:-admin credentials unavailable}"
      warn "cannot enrol the node ($BOOTSTRAP_DETAIL); leaving the node stopped so it does not crash-loop"
      return 0
    fi
    local token code out
    token="$(env_file_value OPSWEAVE_ENROLLMENT_TOKEN "")"
    if [ -n "$token" ]; then
      BOOTSTRAP_STATE="token-already-set"
      BOOTSTRAP_DETAIL="OPSWEAVE_ENROLLMENT_TOKEN already present in $ENV_FILE"
      log "reusing the enrolment token already stored in $ENV_FILE"
    else
      # Equivalent to 'opsctl node-token --label staging --ttl-minutes 525600' (same endpoint the
      # CLI calls), used because opsctl login only accepts the password as an argv argument.
      out="$BOOTSTRAP_TMP/enrollment-token.json"
      code="$(api_post /api/v1/nodes/enrollment-tokens '{"label":"staging","ttlMinutes":525600}' "$out")"
      if [ "$code" != "200" ] && [ "$code" != "201" ]; then
        BOOTSTRAP_STATE="failed"
        BOOTSTRAP_DETAIL="enrolment token request returned HTTP $code"
        warn "enrolment token request failed with HTTP $code; leaving the node stopped"
        return 1
      fi
      token="$(json_field "$(cat "$out")" token)"
      if [ -z "$token" ]; then
        BOOTSTRAP_STATE="failed"
        BOOTSTRAP_DETAIL="enrolment token response carried no token"
        return 1
      fi
      set_env_file_value OPSWEAVE_ENROLLMENT_TOKEN "$token"
      BOOTSTRAP_STATE="token-issued"
      BOOTSTRAP_DETAIL="enrolment token stored in $ENV_FILE"
      log "issued a node enrolment token and stored it in $ENV_FILE (value never printed)"
    fi
  fi
  log "starting the node service on this release"
  if ! compose up -d --no-deps node; then
    BOOTSTRAP_STATE="failed"
    BOOTSTRAP_DETAIL="node service failed to start"
    warn "node service failed to start"
    return 1
  fi
  if [ "$BOOTSTRAP_STATE" = "token-issued" ]; then
    BOOTSTRAP_STATE="enrolled"
    BOOTSTRAP_DETAIL="enrolment token issued and node started"
  fi
  return 0
}

# READY nodes are what the Nodes page shows. A timeout is a recorded warning, never a deployment
# failure: the release can be healthy while the node is still handshaking.
node_readiness_check() {
  local deadline remaining code ready
  NODE_READY_STATE="skipped"
  NODE_READY_COUNT="0"
  if ! service_exists node; then
    NODE_READY_STATE="no-node-service"
    return 0
  fi
  if ! api_login; then
    NODE_READY_STATE="unauthenticated"
    warn "cannot verify node readiness: $BOOTSTRAP_DETAIL"
    return 0
  fi
  deadline="$((SECONDS + NODE_READY_TIMEOUT))"
  log "polling /api/v1/nodes for a READY node for up to ${NODE_READY_TIMEOUT}s"
  while :; do
    code="$(api_get /api/v1/nodes "$BOOTSTRAP_TMP/nodes.json")"
    if [ "$code" = "200" ]; then
      ready="$(tr -d ' ' <"$BOOTSTRAP_TMP/nodes.json" | grep -o '"status":"READY"' | wc -l | tr -d ' ')"
      if [ "${ready:-0}" -gt 0 ]; then
        NODE_READY_STATE="ready"
        NODE_READY_COUNT="$ready"
        NODE_READY_CHECKED_AT="$(iso_now)"
        log "$ready node(s) report READY"
        return 0
      fi
    fi
    remaining="$((deadline - SECONDS))"
    if [ "$remaining" -le 0 ]; then
      NODE_READY_STATE="timeout"
      NODE_READY_CHECKED_AT="$(iso_now)"
      warn "no node reported READY within ${NODE_READY_TIMEOUT}s; the Nodes page will show it as not ready"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

write_record() {
  local sha="$1" healthy="$2" rolled_back="$3" target="$4" mode="$5"
  local file="$DEPLOY_DIR/$sha.json" previous state
  previous="$(pointer_value current)"
  if [ "$healthy" = "true" ]; then state="healthy"; else state="unhealthy"; fi
  if [ "$rolled_back" = "true" ]; then state="rolled-back:$target"; fi
  {
    printf '{\n'
    printf '  "sha": %s,\n' "$(json_str "$sha")"
    printf '  "image": %s,\n' "$(json_str "$IMAGE_REPO:$sha")"
    printf '  "digest": %s,\n' "$(json_str "${IMAGE_DIGEST:-unknown}")"
    printf '  "digest_source": %s,\n' "$(json_str "${IMAGE_DIGEST_SOURCE:-unknown}")"
    printf '  "mode": %s,\n' "$(json_str "$mode")"
    printf '  "project": %s,\n' "$(json_str "$PROJECT")"
    printf '  "base_url": %s,\n' "$(json_str "$BASE_URL")"
    printf '  "started_at": %s,\n' "$(json_str "${DEPLOY_STARTED_AT:-$(iso_now)}")"
    printf '  "deployed_at": %s,\n' "$(iso_now)"
    printf '  "healthy": %s,\n' "$(bool_str "$healthy")"
    printf '  "rolled_back": %s,\n' "$(bool_str "$rolled_back")"
    printf '  "rollback_target": %s,\n' "$(json_or_null "$target")"
    printf '  "previous_sha": %s,\n' "$(json_or_null "$previous")"
    printf '  "backup": {"dir": %s, "postgres": %s},\n' "$(json_str "$BACKUP_DIR")" "$(json_or_null "$BACKUP_DB")"
    printf '  "health": %s,\n' "$(health_json)"
    printf '  "served_commit": %s,\n' "$(served_json)"
    printf '  "node": %s\n' "$(node_json)"
    printf '}\n'
  } >"$file.tmp"
  chmod 600 "$file.tmp"
  mv -f "$file.tmp" "$file"
  printf '%s %s %s %s\n' "$(iso_now)" "$sha" "${IMAGE_DIGEST:-unknown}" "$state" >>"$DEPLOY_DIR/history.log"
}

commit_pointers() {
  local new="$1" previous="$2"
  if [ "$previous" = "$new" ]; then
    log "release $new is already the recorded current release"
    return 0
  fi
  if [[ "$previous" =~ $SHA_RE ]]; then
    set_pointer previous "$previous"
  fi
  set_pointer current "$new"
}

# Pull the release, pin it in staging.env, then start the kernel first: the node needs a live kernel
# to redeem its enrolment token, so the node is started by bootstrap_node once a token exists.
apply_release() {
  local sha="$1" stamp="$2" svc
  pull_image "$sha" || return 1
  persist_release_env "$sha" "$stamp"
  pin_release_env "$sha" "$stamp"
  if service_exists kernel; then
    log "starting kernel on release $sha"
    compose up -d --no-deps kernel || return 1
  fi
  for svc in "${APP_SERVICES[@]}"; do
    [ "$svc" = "node" ] && continue
    [ "$svc" = "kernel" ] && continue
    log "starting $svc on release $sha"
    compose up -d --no-deps "$svc" || return 1
  done
  return 0
}

rollback_to_release() {
  local sha="$1" stamp
  stamp="$(iso_now)"
  pull_image "$sha" || return 1
  persist_release_env "$sha" "$stamp"
  pin_release_env "$sha" "$stamp"
  log "restoring release $sha"
  if service_exists kernel; then
    compose up -d --no-deps kernel || return 1
  fi
  if service_exists node && node_identity_present; then
    compose up -d --no-deps node || return 1
  fi
  wait_kernel_livez || return 1
  health_check
}

print_running_release() {
  local svc ref
  log "actual running release:"
  for svc in ${APP_SERVICES[@]+"${APP_SERVICES[@]}"}; do
    ref="$(service_image_ref "$svc" 2>/dev/null || printf '<unknown>')"
    log "  $svc: $ref (state: $(service_state "$svc"))"
  done
  log "  /api/v1/version reports commit: ${SERVED_SHA:-<unknown>} ($SERVED_SHA_STATE)"
}

# Exactly one deployment may mutate this host at a time. A CI run and a manual run that
# overlap both call `docker compose up`, and the interleaving can leave a service created
# but never started (observed on 2026-10-28: the kernel sat in Created and the preview port
# had no listener). The lock is held for the whole mutation; --status stays lock-free so
# monitoring never blocks on an in-flight deploy.
acquire_deploy_lock() {
  command -v flock >/dev/null 2>&1 || die 1 "flock is required to serialise deployments but is not installed"
  exec 9>"$LOCK_FILE" || die 1 "cannot open the deploy lock $LOCK_FILE"
  if ! flock -w "$LOCK_TIMEOUT" 9; then
    die 1 "another deployment still holds $LOCK_FILE after waiting ${LOCK_TIMEOUT}s; refusing to run two deployments against the same host"
  fi
  log "deploy lock acquired ($LOCK_FILE)"
}

cmd_deploy() {
  local sha="$1" previous_running="" rollback_target="" healthy=0 stamp
  preflight
  acquire_deploy_lock
  DEPLOY_STARTED_AT="$(iso_now)"
  stamp="$DEPLOY_STARTED_AT"
  previous_running="$(current_sha || true)"
  log "target release: $sha"
  log "currently running release: ${previous_running:-<none>}"
  detect_docker_gid
  prepare_bind_dirs
  check_image_available "$sha"
  ensure_dependencies
  create_backup "$sha"
  reset_health
  BOOTSTRAP_STATE="skipped"
  NODE_READY_STATE="skipped"
  if apply_release "$sha" "$stamp"; then
    if wait_kernel_livez; then
      bootstrap_node || warn "node bootstrap reported a problem"
      node_readiness_check
      if health_check; then healthy=1; fi
      served_commit_check "$sha"
    else
      warn "kernel did not become live; skipping node bootstrap and readiness"
    fi
  else
    warn "release $sha failed to start"
  fi
  if [ "$healthy" -eq 1 ]; then
    commit_pointers "$sha" "$previous_running"
    write_record "$sha" true false "" "deploy"
    log "release $sha deployed and healthy"
    print_running_release
    exit 0
  fi
  warn "release $sha is not healthy"
  if [[ "$previous_running" =~ $SHA_RE ]] && [ "$previous_running" != "$sha" ]; then
    rollback_target="$previous_running"
  fi
  if [ -z "$rollback_target" ]; then
    write_record "$sha" false false "" "deploy"
    print_running_release
    die 1 "release $sha is unhealthy and no previous release is recorded; the staging host needs manual attention"
  fi
  log "rolling back to previous release $rollback_target"
  if rollback_to_release "$rollback_target"; then
    served_commit_check "$rollback_target"
    write_record "$sha" false true "$rollback_target" "deploy"
    warn "release $sha was rolled back to $rollback_target"
    print_running_release
    exit 1
  fi
  write_record "$sha" false true "$rollback_target" "deploy"
  print_running_release
  die 1 "release $sha is unhealthy and rollback to $rollback_target also failed; the staging host needs manual attention"
}

rolled_back_flag() {
  case "$1" in
    rolled-back:*) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

rolled_back_target() {
  case "$1" in
    rolled-back:*) printf '%s' "${1#rolled-back:}" ;;
    *) printf '' ;;
  esac
}

last_deploy_json() {
  local line at sha digest state
  line="$(tail -n1 "$DEPLOY_DIR/history.log" 2>/dev/null || true)"
  if [ -z "$line" ]; then
    printf 'null'
    return 0
  fi
  read -r at sha digest state <<<"$line"
  printf '{"sha": %s, "deployed_at": %s, "digest": %s, "status": %s, "rolled_back": %s, "rollback_target": %s}' \
    "$(json_str "$sha")" \
    "$(json_str "$at")" \
    "$(json_str "$digest")" \
    "$(json_str "$state")" \
    "$(rolled_back_flag "$state")" \
    "$(json_or_null "$(rolled_back_target "$state")")"
}

current_json() {
  local sha="$1" record healthy rolled
  if [ -z "$sha" ]; then
    printf 'null'
    return 0
  fi
  record="$DEPLOY_DIR/$sha.json"
  healthy="false"
  rolled="false"
  if [ "$(record_field "$record" healthy)" = "true" ]; then healthy="true"; fi
  if [ "$(record_field "$record" rolled_back)" = "true" ]; then rolled="true"; fi
  printf '{"sha": %s, "image": %s, "digest": %s, "deployed_at": %s, "healthy": %s, "rolled_back": %s}' \
    "$(json_str "$sha")" \
    "$(json_str "$IMAGE_REPO:$sha")" \
    "$(json_or_null "$(record_field "$record" digest)")" \
    "$(json_or_null "$(record_field "$record" deployed_at)")" \
    "$healthy" \
    "$rolled"
}

status_json() {
  local sha previous svc first=1 healthy=false identity
  sha="$(current_sha || true)"
  previous="$(pointer_value previous)"
  if [ "$HEALTH_LIVEZ" = "pass" ] && [ "$HEALTH_READYZ" = "pass" ] && [ "$HEALTH_ROOT" = "pass" ]; then
    healthy=true
  fi
  identity="absent"
  if node_identity_present; then identity="present"; fi
  printf '{\n'
  printf '  "project": %s,\n' "$(json_str "$PROJECT")"
  printf '  "base_url": %s,\n' "$(json_str "$BASE_URL")"
  printf '  "collected_at": %s,\n' "$(json_str "$(iso_now)")"
  printf '  "current": %s,\n' "$(current_json "$sha")"
  printf '  "previous_sha": %s,\n' "$(json_or_null "$previous")"
  printf '  "last_deploy": %s,\n' "$(last_deploy_json)"
  printf '  "healthy": %s,\n' "$healthy"
  printf '  "health": %s,\n' "$(health_json)"
  printf '  "served_commit": %s,\n' "$(served_json)"
  printf '  "node_identity": {"status": %s, "path": %s},\n' "$(json_str "$identity")" "$(json_str "$(node_identity_file)")"
  printf '  "services": [\n'
  for svc in ${ALL_SERVICES[@]+"${ALL_SERVICES[@]}"}; do
    if [ "$first" -eq 1 ]; then first=0; else printf ',\n'; fi
    printf '    {"name": %s, "state": %s, "image": %s}' \
      "$(json_str "$svc")" \
      "$(json_str "$(service_state "$svc")")" \
      "$(json_or_null "$(service_image_ref "$svc" 2>/dev/null || true)")"
  done
  printf '\n  ]\n}\n'
}

status_human() {
  local sha previous svc line at hsha _hdigest hstate
  sha="$(current_sha || true)"
  previous="$(pointer_value previous)"
  printf 'project:        %s\n' "$PROJECT" >&2
  printf 'base url:       %s\n' "$BASE_URL" >&2
  printf 'current sha:    %s\n' "${sha:-<none>}" >&2
  printf 'image digest:   %s\n' "$(record_field "$DEPLOY_DIR/${sha:-none}.json" digest)" >&2
  printf 'previous sha:   %s\n' "${previous:-<none>}" >&2
  line="$(tail -n1 "$DEPLOY_DIR/history.log" 2>/dev/null || true)"
  if [ -n "$line" ]; then
    read -r at hsha _hdigest hstate <<<"$line"
    printf 'last deploy:    %s (sha %s, %s)\n' "$at" "$hsha" "$hstate" >&2
  else
    printf 'last deploy:    <none recorded>\n' >&2
  fi
  for svc in ${ALL_SERVICES[@]+"${ALL_SERVICES[@]}"}; do
    printf 'service %-9s %-10s %s\n' "$svc" "$(service_state "$svc")" "$(service_image_ref "$svc" 2>/dev/null || printf '<none>')" >&2
  done
  printf 'served commit:  %s (%s)\n' "${SERVED_SHA:-<unknown>}" "$SERVED_SHA_STATE" >&2
  printf 'node identity:  %s (%s)\n' "$(if node_identity_present; then printf present; else printf absent; fi)" "$(node_identity_file)" >&2
  printf 'health:         livez=%s readyz=%s root=%s (checked %s)\n' \
    "$HEALTH_LIVEZ" "$HEALTH_READYZ" "$HEALTH_ROOT" "${HEALTH_CHECKED_AT:-never}" >&2
}

cmd_status() {
  preflight
  health_probe_once || true
  served_commit_check ""
  status_json
  if [ "$JSON_ONLY" -eq 0 ]; then
    status_human
  fi
  return 0
}

cmd_rollback() {
  local previous current started
  preflight
  acquire_deploy_lock
  previous="$(pointer_value previous)"
  current="$(current_sha || true)"
  if ! [[ "$previous" =~ $SHA_RE ]]; then
    die 1 "no previous successful release is recorded (pointer $DEPLOY_DIR/previous); nothing to roll back to — pass --sha to deploy an earlier commit instead"
  fi
  if [ "$previous" = "$current" ]; then
    die 1 "the recorded previous release ($previous) is already the current release; nothing to roll back to"
  fi
  started="$(record_field "$DEPLOY_DIR/$previous.json" deployed_at)"
  if [ -z "$started" ]; then started="$(iso_now)"; fi
  DEPLOY_STARTED_AT="$started"
  log "rolling back from ${current:-<none>} to $previous"
  detect_docker_gid
  prepare_bind_dirs
  check_image_available "$previous"
  ensure_dependencies
  if ! rollback_to_release "$previous"; then
    write_record "$previous" false true "" "manual-rollback"
    die 1 "rollback to $previous failed; the staging host needs manual attention"
  fi
  served_commit_check "$previous"
  if [[ "$current" =~ $SHA_RE ]]; then
    set_pointer previous "$current"
  fi
  set_pointer current "$previous"
  write_record "$previous" true false "" "manual-rollback"
  log "rolled back to $previous"
  print_running_release
  exit 0
}

main() {
  if [ -n "$BASE_URL_ARG" ] && ! printf '%s' "$BASE_URL_ARG" | grep -Eq '^https?://[A-Za-z0-9._~:/?#@!&()*+,;=%-]+$'; then
    printf 'ERROR invalid --base-url value (expected an http(s) URL such as http://82.156.234.84:18080)\n' >&2
    exit 2
  fi
  if [ -n "$SHA_ARG" ]; then
    if ! [[ "$SHA_ARG" =~ $SHA_RE ]]; then
      printf 'ERROR invalid --sha value (expected 40 lowercase hex characters)\n' >&2
      exit 2
    fi
  fi
  case "$MODE" in
    deploy)
      cmd_deploy "$SHA_ARG"
      ;;
    status)
      cmd_status
      ;;
    rollback)
      cmd_rollback
      ;;
    *)
      printf 'ERROR no mode selected\n' >&2
      usage >&2
      exit 2
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha)
      if [ "$#" -lt 2 ]; then
        printf 'ERROR --sha requires a 40-character value\n' >&2
        exit 2
      fi
      SHA_ARG="$2"
      shift 2
      ;;
    --sha=*)
      SHA_ARG="${1#--sha=}"
      shift
      ;;
    --status)
      MODE="status"
      shift
      ;;
    --rollback)
      MODE="rollback"
      shift
      ;;
    --base-url)
      if [ "$#" -lt 2 ]; then
        printf 'ERROR --base-url requires a value\n' >&2
        exit 2
      fi
      BASE_URL_ARG="$2"
      shift 2
      ;;
    --base-url=*)
      BASE_URL_ARG="${1#--base-url=}"
      shift
      ;;
    --json)
      JSON_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -n "$SHA_ARG" ]; then
  case "$MODE" in
    ""|deploy)
      MODE="deploy"
      ;;
    *)
      printf 'ERROR --sha cannot be combined with --%s\n' "$MODE" >&2
      exit 2
      ;;
  esac
fi

main
