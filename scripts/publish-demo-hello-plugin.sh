#!/usr/bin/env bash
# Build, publish and sign the dev.opsweave.hello demo plugin bundle.
#
# Produces dist/plugins/hello-ops-<version>.plugin.zip, which scripts/demo_hello_up.sh installs.
#
# Two image transports, because the registry a remote staging node pulls from is bound to that
# host's loopback and is therefore unreachable from a laptop:
#   direct  docker push to $OPSWEAVE_REGISTRY (local development registries)
#   ssh     docker save | ssh | docker load on the host, then push there (remote staging)
#
# The capability digest is derived from the manifest's "provides" exactly the way
# apps/kernel/src/nodes.rs derives it. The node refuses an instance whose runtime info reports a
# different one, so it is computed, never typed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${OPSWEAVE_REGISTRY:-localhost:5001}"
VERSION="${OPSWEAVE_HELLO_VERSION:-0.0.1}"
TRANSPORT="${OPSWEAVE_IMAGE_TRANSPORT:-direct}"
IMAGE_PLATFORM="${OPSWEAVE_IMAGE_PLATFORM:-linux/amd64}"
SSH_TARGET="${OPSWEAVE_SSH_TARGET:-}"
SSH_KEY="${OPSWEAVE_SSH_KEY:-}"
TEMPLATE="plugins/hello-ops/manifest.template.json"
IMAGE_REF="${REGISTRY}/opsweave/hello-ts:${VERSION}"
BUNDLE_DIR="/tmp/opsweave-hello-${VERSION}"
OUT="dist/plugins/hello-ops-${VERSION}.plugin.zip"

[ -f keys/publisher.key ] || { echo "missing keys/publisher.key" >&2; exit 1; }
if [ "${TRANSPORT}" = "ssh" ]; then
  [ -n "${SSH_TARGET}" ] || { echo "OPSWEAVE_SSH_TARGET is required for the ssh transport" >&2; exit 1; }
fi

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib, sys
digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print("sha256:" + digest.hexdigest())
PY
}

capability_digest() {
  python3 - "$1" <<'PY'
import hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
raw = json.dumps(manifest["provides"], sort_keys=True, separators=(",", ":")).encode()
print("sha256:" + hashlib.sha256(raw).hexdigest())
PY
}

echo "== web assets"
PLUGIN_VERSION="${VERSION}" pnpm --filter @opsweave/hello-web build >/dev/null

echo "== backend image ${IMAGE_REF} (${IMAGE_PLATFORM})"
CAPABILITY="$(capability_digest "${TEMPLATE}")"
BUILD="$(sha256_file plugins/hello-ops/backend-ts/server.mjs)"
docker buildx build --platform "${IMAGE_PLATFORM}" --provenance=false --sbom=false \
  --build-arg BASE_IMAGE="${OPSWEAVE_NODE_BASE_IMAGE:-node:22-bookworm-slim}" \
  --build-arg PLUGIN_VERSION="${VERSION}" \
  --build-arg CAPABILITY_DIGEST="${CAPABILITY}" \
  --build-arg BUILD_DIGEST="${BUILD}" \
  -t "${IMAGE_REF}" --load plugins/hello-ops/backend-ts >/dev/null

echo "== publish image (${TRANSPORT})"
if [ "${TRANSPORT}" = "ssh" ]; then
  SSH_OPTS=(-o BatchMode=yes)
  if [ -n "${SSH_KEY}" ]; then SSH_OPTS+=(-i "${SSH_KEY}"); fi
  docker save "${IMAGE_REF}" | gzip -1 | ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" 'gunzip | sudo docker load' >/dev/null
  DIGEST="$(ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "sudo docker push '${IMAGE_REF}'" 2>&1 \
    | grep -oE 'digest: sha256:[0-9a-f]{64}' | head -1 | cut -d' ' -f2)"
else
  docker push "${IMAGE_REF}" >/dev/null
  DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${IMAGE_REF}" | cut -d@ -f2)"
fi
[ -n "${DIGEST}" ] || { echo "could not resolve the published image digest" >&2; exit 1; }
echo "== digest ${DIGEST}"

echo "== signed bundle"
rm -rf "${BUNDLE_DIR}" "${OUT}"
python3 scripts/assemble_plugin.py --template "${TEMPLATE}" --out "${BUNDLE_DIR}" \
  --version "${VERSION}" --image-ref "${REGISTRY}/opsweave/hello-ts@${DIGEST}" \
  --frontend-dist plugins/hello-ops/web/dist >/dev/null
mkdir -p dist/plugins
./target/debug/opsctl bundle --dir "${BUNDLE_DIR}" --out "${OUT}" --key keys/publisher.key
ls -lh "${OUT}"
