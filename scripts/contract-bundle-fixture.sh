#!/usr/bin/env bash
# Build one signed plugin bundle from the working tree, for the `contracts` job.
#
# WHY THIS EXISTS
#
# `tests/contract/validate_contracts.py` has a section that opens
# `dist/plugins/*.plugin.zip` and recomputes the manifest, asset-index and
# remoteEntry digests without trusting the packer. It never executed in CI:
# `dist/` is gitignored, and the required `contracts` job only ran the schema
# half. The message it printed ("no dist/plugins yet; bundle checks skipped") read
# like a benign note, which is why the gap survived.
#
# The real packer (`scripts/build-plugins.sh`) needs Docker, a registry and three
# toolchains. This needs none of them: `assemble_plugin.py` is pure Python, the
# frontend comes from `tests/contract/fixtures/hello-frontend` (a tracked
# directory, not a build output), and `opsctl bundle` signs and verifies with a key
# generated here. So the required check can examine a real bundle on every pull
# request.
#
# IT USED `plugins/hello-ops/web/dist` AND THAT WAS WRONG. `dist/` is gitignored
# (.gitignore:3), so the directory exists on a developer machine that has built
# the web bundle and does not exist in a fresh CI checkout - the script passed
# locally and failed in CI with `missing required file: frontend/remoteEntry.js`.
# Depending on an untracked build output inside a required check is the same
# defect class this repository keeps finding; the fixture is tracked instead.
#
# WHAT IT IS NOT: it is not the real packer, and passing it does not prove the
# real packer is correct. It proves the validator's own checks run and can fail.
# `plugin-lifecycle.yml` remains the job that exercises the real packer.
#
# Usage: scripts/contract-bundle-fixture.sh [OUT_DIR]
#   OUT_DIR defaults to dist/plugins. The generated key is left in
#   "${OUT_DIR}/../contract-fixture-keys" so a caller can tamper and re-verify.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${1:-dist/plugins}"
KEY_DIR="$(dirname "$OUT_DIR")/contract-fixture-keys"

# A pinned digest, not a live registry read: this bundle is never deployed, and a
# network dependency in a required check is a new failure mode for no gain.
IMAGE_REF="ghcr.io/baicie/opsweave-plugin-hello@sha256:$(printf '0%.0s' $(seq 1 64))"

rm -rf "$OUT_DIR" "$KEY_DIR"
mkdir -p "$OUT_DIR" "$KEY_DIR"

cargo build -q -p opsweave-opsctl
./target/debug/opsctl keygen --out-dir "$KEY_DIR" >/dev/null

python3 scripts/assemble_plugin.py \
  --template plugins/hello-ops/manifest.template.json \
  --out "$OUT_DIR/../contract-fixture-staging/hello" \
  --version 0.0.1 \
  --image-ref "$IMAGE_REF" \
  --frontend-dist tests/contract/fixtures/hello-frontend >/dev/null

./target/debug/opsctl bundle \
  --dir "$OUT_DIR/../contract-fixture-staging/hello" \
  --out "$OUT_DIR/hello.plugin.zip" \
  --key "$KEY_DIR/publisher.key" >/dev/null

echo "built $(ls -1 "$OUT_DIR"/*.plugin.zip)"
