#!/usr/bin/env bash
# Run the 0.0.2 Data Foundation Golden Path on a Linux CI host with Docker.
# This script intentionally uses real OpsWeave Kernel/Node processes, real
# PostgreSQL, real OCI containers and the Kernel Capability Gateway.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export OPSWEAVE_URL="http://127.0.0.1:18181"
export OPSWEAVE_DATA_CATALOG_SELECTOR="zone=node-a"
export OPSWEAVE_DATA_INTEGRATION_SELECTOR="zone=node-b"
# --- environment precondition (P001-C1.2.1 Task C) -------------------------
# This harness removes OpsWeave containers. Before C1.2.1 it removed *every*
# OpsWeave container on the daemon - `label=opsweave.managed=true` is stamped by
# every installation in the world. Two things changed:
#
#   1. Cleanup is scoped to the installation identities this run created under
#      `$ROOT/data-ci`, which the nodes mint themselves.
#   2. Because this runs on a shared developer machine as easily as on a CI
#      runner, it refuses to start when the daemon already carries OpsWeave
#      containers it cannot attribute to this run. That turns "the harness ate
#      somebody's demo" into "the harness refused to start", which is the
#      failure mode we want.
#
# `OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1` downgrades that refusal to a warning for
# the dedicated-runner case, where the containers really are leftovers of an
# earlier run of this same script.
STATE_CI="$ROOT/data-ci"
cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  if [ -f /tmp/data-kernel.pid ]; then kill "$(cat /tmp/data-kernel.pid)" 2>/dev/null || true; fi
  for pidfile in /tmp/node-a.pid /tmp/node-b.pid; do
    if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
  done
  # Only this run's installations. A container with no installation label is
  # reported, never removed: it may belong to another install or predate the
  # label. The previous global sweep is gone.
  local removed=0 foreign=0
  for inst in node-a node-b; do
    local id_file="$STATE_CI/$inst/installation-id"
    [ -f "$id_file" ] || continue
    local install_id; install_id="$(cat "$id_file" 2>/dev/null || true)"
    [ -n "$install_id" ] || continue
    local ids; ids="$(docker ps -aq --filter "label=opsweave.installation-id=$install_id" 2>/dev/null || true)"
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086
      echo "$ids" | xargs -r docker rm -f >/dev/null 2>&1 && removed=$((removed + 1))
    fi
  done
  # Anything OpsWeave-shaped that is NOT attributable to this run is reported.
  foreign="$(docker ps -a --filter label=opsweave.managed=true --format '{{.Names}}' 2>/dev/null \
    | while read -r n; do
        [ -n "$n" ] || continue
        lbl="$(docker inspect -f '{{index .Config.Labels "opsweave.installation-id"}}' "$n" 2>/dev/null || true)"
        ours=0
        for inst in node-a node-b; do
          f="$STATE_CI/$inst/installation-id"
          [ -f "$f" ] || continue
          [ "$lbl" = "$(cat "$f")" ] && ours=1
        done
        [ "$ours" = "0" ] && printf '%s\n' "$n"
      done || true)"
  if [ -n "$foreign" ]; then
    echo "NOTE: containers not attributable to this run were left alone:" >&2
    printf '%s\n' "$foreign" | sed 's/^/  /' >&2
  fi
  # The exit code is the acceptance result. Cleanup must not overwrite it: the
  # old `|| true` on the sweep hid nothing (it was the last command), but a
  # future edit that made cleanup the last thing to run would turn a failed
  # assertion into a green run. Restore it explicitly.
  exit "$code"
}
trap cleanup EXIT

# Refuse a daemon that already has OpsWeave containers from something else.
existing="$(docker ps -aq --filter label=opsweave.managed=true 2>/dev/null | wc -l | tr -d ' ')"
if [ "${existing:-0}" -gt 0 ] && [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" != "1" ]; then
  echo "BLOCKED: $existing OpsWeave container(s) already exist on this daemon." >&2
  echo "         This harness removes containers, and it can only prove ownership of" >&2
  echo "         the ones it creates. Run it on a dedicated runner/daemon, clean those" >&2
  echo "         up first, or set OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1 if they are leftovers" >&2
  echo "         of a previous run of this same script." >&2
  docker ps -a --filter label=opsweave.managed=true --format '  {{.Names}}  {{.Status}}' >&2
  exit 1
fi

echo "== build binaries and frontends"
cargo build -q -p opsweave-kernel -p opsweave-node -p opsweave-opsctl -p opsweave-pipeline-worker
pnpm install --frozen-lockfile
# Build every web application this tree actually has.
#
# Discovered by scanning apps/* rather than naming packages: an enumerated list is
# a snapshot, and a snapshot is wrong on the other side of any rename - the stack
# this harness runs on has one web application before the split and two after.
# Scanning cannot go stale, and a tree with no web application at all fails loudly
# instead of building nothing and reporting success.
WEB_APPS=()
for manifest in apps/*/package.json; do
  [ -f "$manifest" ] || continue
  name="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('name',''))" "$manifest")"
  [ -n "$name" ] || continue
  # A web application is one that has a build script; a Rust binary or a CLI has
  # a Cargo.toml and no Vite build.
  if python3 -c "import json,sys;sys.exit(0 if 'build' in json.load(open(sys.argv[1])).get('scripts',{}) else 1)" "$manifest"; then
    WEB_APPS+=("$name")
  fi
done
[ "${#WEB_APPS[@]}" -gt 0 ] || { echo "no buildable web application found under apps/"; exit 1; }
for app in "${WEB_APPS[@]}"; do
  pnpm --fail-if-no-match --filter "$app" build >/dev/null
done
echo "built web applications: ${WEB_APPS[*]}"
mkdir -p keys
./target/debug/opsctl keygen --out-dir keys >/dev/null

echo "== local OCI registry"
docker rm -f opsweave-ci-registry >/dev/null 2>&1 || true
docker run -d --name opsweave-ci-registry -p 5001:5000 registry:2 >/dev/null

echo "== data plugin images and signed bundles"
OPSWEAVE_REGISTRY=localhost:5001 scripts/build-data-plugins.sh

echo "== fixture server"
(cd tests/fixtures && python3 -m http.server 18090 --bind 0.0.0.0 >/tmp/data-fixture.log 2>&1) &
PIDS+=($!)
sleep 1

echo "== Kernel"
KERNEL_PID="$(tests/runtime/start_kernel.sh)"
PIDS+=($KERNEL_PID)
for _ in $(seq 1 60); do curl -fsS "$OPSWEAVE_URL/livez" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$OPSWEAVE_URL/livez" >/dev/null

echo "== terminalization service PostgreSQL tests"
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave'   cargo test -q -p opsweave-kernel terminalization -- --nocapture

echo "== authenticate and enroll two real Node runtimes"
./target/debug/opsctl login --email admin@opsweave.local --password 'OpsWeave!2026' >/dev/null
# B2.1a: a job is filed under a business workspace, and a dataset lives in one.
# A freshly migrated database grants membership to nobody - migration 0022's
# one-time grant only covers accounts that existed when it ran, and the
# bootstrap admin is created after it (db::init order). This fixture performs the
# same audited action an installer performs, through the public API, exactly as
# tests/acceptance/lib/workspace_grant.sh documents. It is a FIXTURE step: the
# product does not grant anyone a workspace on its own.
ADMIN_TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
ADMIN_ID="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$OPSWEAVE_URL/api/v1/auth/me" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("user") or d).get("id",""))')"
[ -n "$ADMIN_ID" ] || { echo "fixture: could not read the admin user id"; exit 1; }
GRANT_CODE="$(curl -sS -o /tmp/data-ci-grant.json -w '%{http_code}' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"userId\":\"$ADMIN_ID\"}" \
  "$OPSWEAVE_URL/api/v1/business-workspaces/00000000-0000-4000-8000-000000000001/members")"
case "$GRANT_CODE" in
  200|201) ;;
  *) echo "fixture: granting the admin the legacy workspace returned $GRANT_CODE: $(cat /tmp/data-ci-grant.json)"; exit 1 ;;
esac
start_node() {
  local name="$1" port="$2" token="$3"
  env \
    OPSWEAVE_KERNEL_URL="$OPSWEAVE_URL" \
    OPSWEAVE_ENROLLMENT_TOKEN="$token" \
    OPSWEAVE_NODE_NAME="$name" \
    OPSWEAVE_NODE_LABELS="role=node,zone=$name" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:$port" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:$port" \
    OPSWEAVE_NODE_STATE_DIR="$ROOT/data-ci/$name" \
    OPSWEAVE_DOCKER_HOST='unix:///var/run/docker.sock' \
    OPSWEAVE_NODE_TOKEN_REFRESH_SECONDS=1 \
    OPSWEAVE_NODE_WORKER_ENABLED=1 \
    OPSWEAVE_PIPELINE_WORKER_BIN="$ROOT/target/debug/opsweave-pipeline-worker" \
    OPSWEAVE_WORKER_SOURCE_ALLOWLIST=172.17.0.1,127.0.0.1 \
    OPSWEAVE_WORKER_BATCH_DELAY_MS=800 \
    RUST_LOG=info ./target/debug/opsweave-node >"/tmp/$name.log" 2>&1 &
  NODE_PID=$!
  PIDS+=($NODE_PID)
  echo "$NODE_PID" > "/tmp/$name.pid"
}
TOKEN_A="$(./target/debug/opsctl node-token --label node-a)"
TOKEN_B="$(./target/debug/opsctl node-token --label node-b)"
start_node node-a 9101 "$TOKEN_A"
start_node node-b 9102 "$TOKEN_B"
for _ in $(seq 1 90); do
  READY="$(curl -fsS -H "Authorization: Bearer $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')" "$OPSWEAVE_URL/api/v1/nodes" | python3 -c 'import json,sys;print(sum(1 for n in json.load(sys.stdin) if n.get("status")=="READY" and not n.get("stale")))')"
  [ "$READY" = "2" ] && break
  sleep 1
done
[ "${READY:-0}" = "2" ] || { echo "nodes not ready"; exit 1; }

echo "== install/activate both data plugins"
scripts/demo_data_up.sh

echo "== supervisor lifecycle (real OS processes)"
tests/acceptance/supervisor_lifecycle.sh

echo "== real OCI Golden Path"
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_foundation.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_authz.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_reliability.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/storage_migration_concurrency.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/storage_migration_parser.sh
tests/acceptance/data_token_security.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/dynamic_catalog_pipeline.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_jobs.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/catalog_fenced_sink.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_worker.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_worker_advanced.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_worker_node_managed.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_two_node_takeover.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/kernel_restart_takeover.sh
KERNEL_PID="$(cat /tmp/data-kernel.pid)"
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_long_heartbeat.sh
# The counterfactual half runs AFTER the Node-managed supervisors are stopped.
#
# Its cases need THIS script's worker to be the one holding the lease, and the
# supervisors also poll the same queue: on run 43578788505 a supervisor claimed
# the job first and finished it before the case could revoke the lease, which
# the case correctly reported as "the job did not reach RUNNING (got SUCCEEDED)"
# - a race, not a product finding.
#
# So the markers come off first, exactly as the concurrency tests below already
# do, and the suite is told the queue is exclusive to it.
rm -f "$ROOT/data-ci/node-a/worker-enabled" "$ROOT/data-ci/node-b/worker-enabled"
for node in node-a node-b; do
  node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
  if [ -n "$node_pid" ]; then
    for worker_pid in $(pgrep -P "$node_pid" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
  fi
done
# Wait for the workers to actually be gone rather than sleeping a guessed 3 s:
# the same "bounded polling instead of a fixed delay" rule the heartbeat
# acceptance was rewritten for.
for _ in $(seq 1 40); do
  left=0
  for node in node-a node-b; do
    node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
    [ -n "$node_pid" ] || continue
    pgrep -P "$node_pid" -f opsweave-pipeline-worker >/dev/null 2>&1 && left=1
  done
  [ "$left" = "0" ] && break
  sleep 0.25
done
OPSWEAVE_NEG_EXCLUSIVE_WORKER=1 \
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' \
  tests/acceptance/pipeline_long_heartbeat_negatives.sh
# Concurrency testing must not compete with Node-managed workers left by prior scenarios.
for node in node-a node-b; do
  node_pid="$(cat "/tmp/$node.pid" 2>/dev/null || true)"
  if [ -n "$node_pid" ]; then
    for worker_pid in $(pgrep -P "$node_pid" -f opsweave-pipeline-worker || true); do kill -9 "$worker_pid" 2>/dev/null || true; done
  fi
done
sleep 3
python3 tests/runtime/claim_concurrency.py
python3 tests/runtime/catalog_lock_race.py
if [ "${RUN_BROWSER_SMOKE:-0}" = "1" ]; then
  echo "== browser extension smoke and business flows"
  # A Node restart can adopt the Integration container before its workload
  # token file is refreshed. Wait for the actual Catalog token, not a sleep.
  INT_CID="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')"
  [ -n "$INT_CID" ] || { echo "integration container missing"; exit 1; }
  TOKEN_READY=0
  for _ in $(seq 1 60); do
    if docker exec "$INT_CID" cat /run/opsweave/capability-tokens.json 2>/dev/null | grep -q '"data.catalog.v1"'; then
      TOKEN_READY=1; break
    fi
    sleep 1
  done
  [ "$TOKEN_READY" = "1" ] || { echo "integration workload token file missing data.catalog.v1"; exit 1; }
  # A real auto-claim worker lets the Studio browser flow observe a completed Job.
  URL="$OPSWEAVE_URL"
  TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
  AUTH=(-H "Authorization: Bearer $TOKEN")
  source tests/acceptance/pipeline_worker_auth.sh
  load_worker node-b
  env     OPSWEAVE_WORKER_KERNEL_URL="$OPSWEAVE_URL"     OPSWEAVE_WORKER_NODE_IDENTITY="$ROOT/data-ci/node-b/node-identity.json"     OPSWEAVE_WORKER_INSTANCE_ID="$W_INSTANCE_ID"     OPSWEAVE_WORKER_NODE_GENERATION="$W_NODE_GEN"     OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1"     OPSWEAVE_WORKER_BATCH_DELAY_MS=800     ./target/debug/opsweave-pipeline-worker >/tmp/ui-worker.log 2>&1 &
  UI_WORKER_PID=$!
  sleep 1
  OPSWEAVE_URL="$OPSWEAVE_URL" OPSWEAVE_UI_FIXTURE=http://172.17.0.1:18090/data-hosts.json pnpm --filter @opsweave/ui-tests exec playwright test data-foundation.spec.ts data-foundation-flows.spec.ts studio.spec.ts visual-layout.spec.ts
  kill "$UI_WORKER_PID" 2>/dev/null || true
fi
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_node_runtime_sigkill.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_orphan_worker.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_ssrf.sh
tests/acceptance/pipeline_read_api.sh
tests/acceptance/pipeline_validation_api.sh
tests/acceptance/pipeline_draft_api.sh
tests/acceptance/pipeline_publish_api.sh
python3 tests/acceptance/publish_concurrency.py "$OPSWEAVE_URL" "$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
tests/acceptance/job_list_api.sh
tests/acceptance/job_authorization.sh
tests/acceptance/preview_api.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json OPSWEAVE_TEST_NODE_REVOCATION=0 OPSWEAVE_TEST_KERNEL_PID="$KERNEL_PID" tests/acceptance/data_token_refresh.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_heartbeat_ttl_takeover.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/deadline_sink_race.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/deadline_sink_http.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/capability_multi_provider.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/source_timeout_no_sink.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_token_revocation.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/supervisor_instance_generation_sigterm.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/supervisor_backoff_sigterm.sh
