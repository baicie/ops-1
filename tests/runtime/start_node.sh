#!/usr/bin/env bash
# Restart an already-enrolled isolated Node Runtime and print its PID.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${1:?node name}"
PORT="${2:?data port}"
cd "$ROOT"
nohup env \
  OPSWEAVE_KERNEL_URL=http://127.0.0.1:18181 \
  OPSWEAVE_NODE_NAME="$NAME" \
  OPSWEAVE_NODE_LABELS="role=node,zone=$NAME" \
  OPSWEAVE_NODE_DATA_BIND="127.0.0.1:$PORT" \
  OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:$PORT" \
  OPSWEAVE_NODE_STATE_DIR="$ROOT/data-ci/$NAME" \
  OPSWEAVE_DOCKER_HOST='unix:///var/run/docker.sock' \
  OPSWEAVE_NODE_TOKEN_REFRESH_SECONDS=1 \
  OPSWEAVE_NODE_WORKER_ENABLED=1 \
  OPSWEAVE_PIPELINE_WORKER_BIN="$ROOT/target/debug/opsweave-pipeline-worker" \
  OPSWEAVE_WORKER_SOURCE_ALLOWLIST="172.17.0.1,127.0.0.1" \
  OPSWEAVE_WORKER_BATCH_DELAY_MS="${OPSWEAVE_WORKER_BATCH_DELAY_MS:-800}" \
  RUST_LOG=info ./target/debug/opsweave-node >>"/tmp/$NAME.log" 2>&1 &
PID=$!
echo "$PID" > "/tmp/$NAME.pid"
echo "$PID"
