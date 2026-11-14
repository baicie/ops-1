#!/usr/bin/env bash
# Build the two independent 0.0.2 Data Foundation plugins and signed bundles.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGISTRY="${OPSWEAVE_REGISTRY:-localhost:5001}"
TS_VERSION="${OPSWEAVE_DATA_VERSION:-0.0.1}"
sha256_file() {
  python3 - "$@" <<'PY'
import hashlib, sys
h = hashlib.sha256()
for path in sys.argv[1:]:
    with open(path, 'rb') as f:
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
pnpm --fail-if-no-match --filter @opsweave/data-catalog-web build >/dev/null
pnpm --fail-if-no-match --filter @opsweave/data-integration-web build >/dev/null
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
    # The digest covers every runtime module, not just the entry point: the image
    # now ships identity.mjs (and quality.mjs for the catalog), and a digest over
    # server.mjs alone would stay identical when one of them changed.
    modules=("plugins/$name/backend/server.mjs" "plugins/$name/backend/identity.mjs")
    [ -f "plugins/$name/backend/quality.mjs" ] && modules+=("plugins/$name/backend/quality.mjs")
    build="$(sha256_file "${modules[@]}")"
    base="$(docker inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}' 2>/dev/null | tr -d '\n' || true)"
    if [ -z "$base" ]; then base="node:22-bookworm-slim"; fi
    docker build --build-arg BASE_IMAGE="$base" --build-arg PLUGIN_VERSION="$TS_VERSION" --build-arg CAPABILITY_DIGEST="$cap" --build-arg BUILD_DIGEST="$build" -t "$REGISTRY/opsweave/$name:$TS_VERSION" "plugins/$name/backend" >/dev/null
    docker push "$REGISTRY/opsweave/$name:$TS_VERSION" >/dev/null
  done
  CAT_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/data-catalog:$TS_VERSION")"
  INT_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/data-integration:$TS_VERSION")"
fi

echo "== signed bundles"
rm -rf /tmp/data-bundles dist/plugins/data-catalog-*.zip dist/plugins/data-catalog-alt-*.zip dist/plugins/data-integration-*.zip
mkdir -p /tmp/data-bundles dist/plugins
python3 scripts/assemble_plugin.py --template plugins/data-catalog/manifest.template.json --out /tmp/data-bundles/data-catalog --version "$TS_VERSION" --image-ref "$CAT_DIGEST" --frontend-dist /tmp/data-catalog-web >/dev/null
python3 scripts/assemble_plugin.py --template plugins/data-integration/manifest.template.json --out /tmp/data-bundles/data-integration --version "$TS_VERSION" --image-ref "$INT_DIGEST" --frontend-dist /tmp/data-integration-web >/dev/null
python3 scripts/assemble_plugin.py --template plugins/data-catalog-alt/manifest.template.json --out /tmp/data-bundles/data-catalog-alt --version "$TS_VERSION" --image-ref "$CAT_DIGEST" --frontend-dist /tmp/data-catalog-web >/dev/null
# D4's dedicated fixture lives here, not in `build-plugins.sh`.
#
# The C4 browser spec disables and uninstalls a plugin to measure what happens to
# its assets. It must not do that to anything the rest of THIS harness needs, and
# it did: it discovered whatever plugin had a reachable `frontend/index.html`,
# and here those are the data plugins that `data_ssrf.sh`,
# `capability_multi_provider.sh` and `data_token_revocation.sh` all use later.
#
# It has to be built by this script rather than `build-plugins.sh` because this
# is the only one `data_foundation_ci.sh` runs - a fixture built elsewhere would
# simply not exist, and C4 would go from "runs but destroys state" to "never
# runs", which is not an improvement.
#
# Built from data-catalog: same image, same frontend bytes, its own id, and NO
# capabilities, so it cannot answer for a capability the data plugins provide.
python3 scripts/assemble_plugin.py --template plugins/data-catalog/manifest.template.json --out /tmp/data-bundles/d4-fixture --version "$TS_VERSION" --image-ref "$CAT_DIGEST" --frontend-dist /tmp/data-catalog-web >/dev/null
# Id and capabilities are rewritten HERE rather than through an `--id` flag on the
# assembler.
#
# PR #102 adds that flag for its own protocol-negative fixture, in the same file.
# Two PRs adding the same argument to the same parser is a merge conflict for no
# benefit - and the flag is incidental here, since the manifest is already being
# edited on the next line. Keeping the change local removes the overlap entirely.
python3 - /tmp/data-bundles/d4-fixture/manifest.json <<'PYFIX'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
# Its own id: deploying it must not replace an instance the conformance matrix or
# the data tests are measuring.
manifest["id"] = "dev.opsweave.hello-d4fixture"
# Nothing provided: this plugin exists to be uninstalled, and a second provider
# of a catalog capability would make the data tests ambiguous.
manifest["provides"] = []
with open(path, "w") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PYFIX
for name in data-catalog data-catalog-alt data-integration d4-fixture; do
  ./target/debug/opsctl bundle --dir "/tmp/data-bundles/$name" --out "dist/plugins/$name-$TS_VERSION.plugin.zip" --key keys/publisher.key >/dev/null
done
# The spec looks for a stem, and builds the filename from it. Rename to the
# convention it uses rather than special-casing the build script's naming.
mv "dist/plugins/d4-fixture-$TS_VERSION.plugin.zip" dist/plugins/hello-ops-d4fixture.plugin.zip
ls -lh dist/plugins/data-*.plugin.zip dist/plugins/hello-ops-d4fixture.plugin.zip
