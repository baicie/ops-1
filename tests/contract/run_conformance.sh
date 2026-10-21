#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
./target/debug/opsctl --url "${OPSWEAVE_URL:-http://127.0.0.1:18181}" login --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >/dev/null
python3 tests/contract/run_conformance.py
