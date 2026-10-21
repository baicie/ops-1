#!/usr/bin/env bash
# 0.0.1 internal backup: PostgreSQL custom dump + immutable package store archive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DB="${OPSWEAVE_DB:-opsweave}"
DEST="${1:-$ROOT/data/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"
DUMP="$DEST/kernel-$STAMP.dump"
PACKAGES="$DEST/packages-$STAMP.tar.gz"
pg_dump --format=custom --no-owner --dbname="$DB" --file="$DUMP"
if [ -d data/packages ]; then
  tar -czf "$PACKAGES" -C data packages
else
  tar -czf "$PACKAGES" -T /dev/null
fi
if command -v sha256sum >/dev/null 2>&1; then HASH=sha256sum; else HASH='shasum -a 256'; fi
{
  echo "createdAt=$STAMP"
  echo "database=$DB"
  $HASH "$DUMP" "$PACKAGES"
} > "$DEST/backup-$STAMP.txt"
echo "backup complete"
cat "$DEST/backup-$STAMP.txt"
