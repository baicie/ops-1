#!/usr/bin/env bash
# Build the two independent 0.0.2 Data Foundation plugins and signed bundles.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGISTRY="${OPSWEAVE_REGISTRY:-localhost:5001}"
TS_VERSION="${OPSWEAVE_DATA_VERSION:-0.0.1}"
sha256_file() {
  python3 - "$1" <<'PY'
import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        h.update(chunk)
print('sha256:' + h.hexdigest())
PY
}
cap_digest() {
  python3 - "$1" <<'PY'
import hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
raw = json.dumps(manifest['provides'], sort_keys=True, separators=(',', ':')).encode()
print('sha256:' + hashlib.sha256(raw).hexdigest())
PY
}
echo "== web extensions"
pnpm --filter @opsweave/data-catalog-web build >/dev/null
pnpm --filter @opsweave/data-integration-web build >/dev/null
rm -rf /tmp/data-catalog-web /tmp/data-integration-web
cp -R plugins/data-catalog/web/dist /tmp/data-catalog-web
cp -R plugins/data-integration/web/dist /tmp/data-integration-web

echo "== backend images"
if [ "${OPSWEAVE_SKIP_IMAGE_BUILD:-0}" = "1" ]; then
  # Contract/bundle-only mode. This is NOT a deployable image artifact.
  CAT_DIGEST="$REGISTRY/opsweave/data-catalog@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  INT_DIGEST="$REGISTRY/opsweave/data-integration@sha256:0000000000000000000000000000000000000000000000000000000000000000"
else
  for name in data-catalog data-integration; do
    cap="$(cap_digest "plugins/$name/manifest.template.json")"
    build="$(sha256_file "plugins/$name/backend/server.mjs")"
    base="$(docker inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}' 2>/dev/null || echo node:22-bookworm-slim)"
    docker build --build-arg BASE_IMAGE="$base" --build-arg PLUGIN_VERSION="$TS_VERSION" --build-arg CAPABILITY_DIGEST="$cap" --build-arg BUILD_DIGEST="$build" -t "$REGISTRY/opsweave/$name:$TS_VERSION" "plugins/$name/backend" >/dev/null
    docker push "$REGISTRY/opsweave/$name:$TS_VERSION" >/dev/null
  done
  CAT_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/data-catalog:$TS_VERSION")"
  INT_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/data-integration:$TS_VERSION")"
fi

echo "== signed bundles"
rm -rf /tmp/data-bundles dist/plugins/data-catalog-*.zip dist/plugins/data-integration-*.zip
mkdir -p /tmp/data-bundles dist/plugins
python3 scripts/assemble_plugin.py --template plugins/data-catalog/manifest.template.json --out /tmp/data-bundles/data-catalog --version "$TS_VERSION" --image-ref "$CAT_DIGEST" --frontend-dist /tmp/data-catalog-web >/dev/null
python3 scripts/assemble_plugin.py --template plugins/data-integration/manifest.template.json --out /tmp/data-bundles/data-integration --version "$TS_VERSION" --image-ref "$INT_DIGEST" --frontend-dist /tmp/data-integration-web >/dev/null
for name in data-catalog data-integration; do
  ./target/debug/opsctl bundle --dir "/tmp/data-bundles/$name" --out "dist/plugins/$name-$TS_VERSION.plugin.zip" --key keys/publisher.key >/dev/null
done
ls -lh dist/plugins/data-*.plugin.zip
