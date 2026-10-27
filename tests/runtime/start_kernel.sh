#!/usr/bin/env bash
# Start an isolated Kernel for the runtime harness and print its PID.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
nohup env \
  OPSWEAVE_BIND=0.0.0.0:18181 \
  OPSWEAVE_PUBLIC_URL=http://127.0.0.1:18181 \
  DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' \
  OPSWEAVE_DATA_DIR="$ROOT/data-ci" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-web/dist" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@opsweave.local \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD='OpsWeave!2026' \
  OPSWEAVE_BOOTSTRAP_ADMIN_NAME='Platform Admin' \
  OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
  OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$(cat keys/publisher.pub)" \
  OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
  OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1 \
  OPSWEAVE_WORKLOAD_TOKEN_SECONDS=5 \
  OPSWEAVE_WORKLOAD_TOKEN_REFRESH_GRACE_SECONDS=1 \
  OPSWEAVE_PLUGIN_DB_HOST=172.17.0.1 \
  OPSWEAVE_PLUGIN_KERNEL_URL=http://172.17.0.1:18181 \
  OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=172.17.0.1 \
  RUST_LOG=info ./target/debug/opsweave-kernel >>/tmp/data-kernel.log 2>&1 &
PID=$!
echo "$PID" > /tmp/data-kernel.pid
echo "$PID"
