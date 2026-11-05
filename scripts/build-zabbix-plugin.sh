#!/usr/bin/env bash
# Build, push and package the Zabbix source plugin with a real image digest.
#
# The manifest template intentionally carries placeholder digests; it is not
# evidence of a published image. This script fills the digest from the pushed
# image and signs the bundle, so the artifact names exactly the bytes it ships.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGISTRY="${OPSWEAVE_REGISTRY:-localhost:5001}"
VERSION="${OPSWEAVE_ZABBIX_VERSION:-0.0.1}"
NAME="zabbix-source"

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
# The build digest covers every runtime module, not just the entry point: the
# image now imports storage.mjs and identity.mjs, and a digest over server.mjs
# alone would stay identical when one of them changed.
build_digest() {
  python3 - "$@" <<'PY'
import hashlib, sys
h = hashlib.sha256()
for path in sys.argv[1:]:
    with open(path, 'rb') as f:
        h.update(f.read())
print('sha256:' + h.hexdigest())
PY
}

CAP="$(cap_digest "plugins/$NAME/manifest.template.json")"
BUILD="$(build_digest plugins/$NAME/backend/zabbix.mjs plugins/$NAME/backend/server.mjs plugins/$NAME/backend/storage.mjs plugins/$NAME/backend/identity.mjs)"
BASE="$(docker inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}' 2>/dev/null | tr -d '\n' || true)"
if [ -z "$BASE" ]; then
  docker pull node:22-bookworm-slim >/dev/null
  BASE="$(docker inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}' | tr -d '\n')"
fi

echo "== image $REGISTRY/opsweave/$NAME:$VERSION"
docker build \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg PLUGIN_VERSION="$VERSION" \
  --build-arg CAPABILITY_DIGEST="$CAP" \
  --build-arg BUILD_DIGEST="$BUILD" \
  -t "$REGISTRY/opsweave/$NAME:$VERSION" \
  "plugins/$NAME/backend" >/dev/null
docker push "$REGISTRY/opsweave/$NAME:$VERSION" >/dev/null
DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/$NAME:$VERSION")"
echo "digest=$DIGEST"
echo "user=$(docker inspect --format '{{.Config.User}}' "$REGISTRY/opsweave/$NAME:$VERSION")"

echo "== signed bundle"
rm -rf "/tmp/$NAME-bundle" "dist/plugins/$NAME-$VERSION.plugin.zip"
mkdir -p dist/plugins
python3 scripts/assemble_plugin.py \
  --template "plugins/$NAME/manifest.template.json" \
  --out "/tmp/$NAME-bundle" \
  --version "$VERSION" \
  --image-ref "$DIGEST" >/dev/null
./target/debug/opsctl bundle --dir "/tmp/$NAME-bundle" --out "dist/plugins/$NAME-$VERSION.plugin.zip" --key keys/publisher.key >/dev/null
ls -lh "dist/plugins/$NAME-$VERSION.plugin.zip"
python3 - "/tmp/$NAME-bundle/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m['backend']['imageRef'].startswith('localhost:5001/'), m['backend']['imageRef']
assert m['backend']['imageRef'].split('@sha256:')[1] != '0' * 64, m['backend']['imageRef']
print('manifest imageRef:', m['backend']['imageRef'])
PY
