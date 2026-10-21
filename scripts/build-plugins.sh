#!/usr/bin/env bash
# Build the three Runtime v1 reference plugins and produce signed bundles.
# The local reference registry is expected at 127.0.0.1:5001 (deployments/local).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${OPSWEAVE_REGISTRY:-localhost:5001}"
TS_VERSION="${OPSWEAVE_HELLO_VERSION:-0.0.1}"
TS_V2_VERSION="${OPSWEAVE_HELLO_V2_VERSION:-0.0.2}"
ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo arm64)"
case "$ARCH" in
  aarch64|arm64) GOARCH=arm64; JRE_ARCH=aarch64 ;;
  x86_64|amd64) GOARCH=amd64; JRE_ARCH=x64 ;;
  *) echo "unsupported local architecture: $ARCH" >&2; exit 1 ;;
esac
TS_CAP=sha256:16720c5f7a1cac3268d2cd20b72be3f0b4306734a6a087088e30ce2d8e96cf17
GO_CAP=sha256:fb87937c44f196076d9ea49455023f8d70e1ef5be94823730692c7c1e9998f8f
JAVA_CAP=sha256:396bf4276f3cecd170cf7c400ead5df06a6b987e66e5141d6b13f6001bddf708
TS_BUILD_1=sha256:9d0e1b9c0fbd3a7b6a0120dc0e8a7a3a14f8fd57d56fa31f0e6f0e3f7d7b1a11
TS_BUILD_2=sha256:6a7c4d1e9f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d
GO_BUILD=sha256:6a1d9f0e1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5
JAVA_BUILD=sha256:7b2c4d6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456

cargo build -q -p opsweave-opsctl
echo "== web assets"
PLUGIN_VERSION="$TS_VERSION" pnpm --filter @opsweave/hello-web build >/dev/null
rm -rf /tmp/hello-web-v1 && cp -R plugins/hello-ops/web/dist /tmp/hello-web-v1
PLUGIN_VERSION="$TS_V2_VERSION" pnpm --filter @opsweave/hello-web build >/dev/null
rm -rf /tmp/hello-web-v2 && cp -R plugins/hello-ops/web/dist /tmp/hello-web-v2
PLUGIN_VERSION="$TS_VERSION" pnpm --filter @opsweave/hello-web build >/dev/null

echo "== TypeScript OCI images"
docker build --build-arg PLUGIN_VERSION="$TS_VERSION" --build-arg CAPABILITY_DIGEST="$TS_CAP" --build-arg BUILD_DIGEST="$TS_BUILD_1" -t "$REGISTRY/opsweave/hello-ts:$TS_VERSION" plugins/hello-ops/backend-ts >/dev/null
docker build --build-arg PLUGIN_VERSION="$TS_V2_VERSION" --build-arg CAPABILITY_DIGEST="$TS_CAP" --build-arg BUILD_DIGEST="$TS_BUILD_2" -t "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION" plugins/hello-ops/backend-ts >/dev/null

echo "== Go OCI image"
( cd plugins/hello-go && GOOS=linux GOARCH="$GOARCH" CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o hello-go-linux . )
docker build --build-arg PLUGIN_VERSION=0.0.1 --build-arg CAPABILITY_DIGEST="$GO_CAP" --build-arg BUILD_DIGEST="$GO_BUILD" -t "$REGISTRY/opsweave/hello-go:0.0.1" plugins/hello-go >/dev/null

echo "== Java OCI image"
if [ ! -x plugins/hello-java/jre/bin/java ]; then
  echo "Downloading pinned Temurin 21 JRE for linux/$JRE_ARCH" >&2
  mkdir -p plugins/hello-java/jre
  curl -fsSL --max-time 240 "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jre/${JRE_ARCH}/linux/OpenJDK21U-jre_${JRE_ARCH}_linux_hotspot_21.0.12.1_1.tar.gz" -o /tmp/opsweave-jre21.tar.gz
  tar xzf /tmp/opsweave-jre21.tar.gz -C plugins/hello-java/jre --strip-components=1
fi
if [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
  JAVA_HOME=/opt/homebrew/opt/openjdk@21 mvn -q -f plugins/hello-java/pom.xml -DskipTests package
else
  mvn -q -f plugins/hello-java/pom.xml -DskipTests package
fi
docker build --build-arg PLUGIN_VERSION=0.0.1 --build-arg CAPABILITY_DIGEST="$JAVA_CAP" --build-arg BUILD_DIGEST="$JAVA_BUILD" -t "$REGISTRY/opsweave/hello-java:0.0.1" plugins/hello-java >/dev/null

echo "== push digests"
docker push "$REGISTRY/opsweave/hello-ts:$TS_VERSION" >/dev/null
docker push "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION" >/dev/null
docker push "$REGISTRY/opsweave/hello-go:0.0.1" >/dev/null
docker push "$REGISTRY/opsweave/hello-java:0.0.1" >/dev/null
TS_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-ts:$TS_VERSION")"
TS2_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION")"
GO_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-go:0.0.1")"
JAVA_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-java:0.0.1")"

echo "== signed bundles"
rm -rf /tmp/opsweave-bundles dist/plugins
mkdir -p /tmp/opsweave-bundles dist/plugins
python3 scripts/assemble_plugin.py --template plugins/hello-ops/manifest.template.json --out /tmp/opsweave-bundles/hello-ops-0.0.1 --version "$TS_VERSION" --image-ref "$TS_DIGEST" --frontend-dist /tmp/hello-web-v1 >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-ops/manifest.template.json --out /tmp/opsweave-bundles/hello-ops-0.0.2 --version "$TS_V2_VERSION" --image-ref "$TS2_DIGEST" --frontend-dist /tmp/hello-web-v2 >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-go/manifest.template.json --out /tmp/opsweave-bundles/hello-go-0.0.1 --version 0.0.1 --image-ref "$GO_DIGEST" >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-java/manifest.template.json --out /tmp/opsweave-bundles/hello-java-0.0.1 --version 0.0.1 --image-ref "$JAVA_DIGEST" >/dev/null
for name in hello-ops-0.0.1 hello-ops-0.0.2 hello-go-0.0.1 hello-java-0.0.1; do
  ./target/debug/opsctl bundle --dir "/tmp/opsweave-bundles/$name" --out "dist/plugins/$name.plugin.zip" --key keys/publisher.key >/dev/null
done
python3 - "$TS_DIGEST" "$TS2_DIGEST" "$GO_DIGEST" "$JAVA_DIGEST" <<'PY'
import json, pathlib, sys
plugin_dir = pathlib.Path('dist/plugins')
entries = []
for name in ['hello-ops-0.0.1','hello-ops-0.0.2','hello-go-0.0.1','hello-java-0.0.1']:
    entries.append({"bundle": f"{name}.plugin.zip", "path": str(plugin_dir / f"{name}.plugin.zip")})
(pathlib.Path('dist/plugins/index.json')).write_text(json.dumps({
    "generatedAt": "deterministic build output",
    "images": {
        "hello-ts:0.0.1": sys.argv[1],
        "hello-ts:0.0.2": sys.argv[2],
        "hello-go:0.0.1": sys.argv[3],
        "hello-java:0.0.1": sys.argv[4],
    },
    "bundles": entries,
}, indent=2) + "\n")
PY
ls -lh dist/plugins
