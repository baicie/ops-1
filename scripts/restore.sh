#!/usr/bin/env bash
# Restore into a NEW database by default. Never overwrites the live control plane.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "$#" -lt 1 ]; then
  echo "usage: scripts/restore.sh <kernel.dump> [packages.tar.gz] [target-db]" >&2
  exit 1
fi
DUMP="$1"
PACKAGES="${2:-}"
TARGET="${3:-opsweave_restore}"
createdb "$TARGET" 2>/dev/null || true
pg_restore --clean --if-exists --no-owner --dbname="$TARGET" "$DUMP"
if [ -n "$PACKAGES" ] && [ -f "$PACKAGES" ]; then
  mkdir -p data-restored
  tar -xzf "$PACKAGES" -C data-restored
  echo "packages restored under $ROOT/data-restored; point OPSWEAVE_DATA_DIR at it after review"
fi
echo "restored into database $TARGET — run a verification query and start the Kernel against it"
