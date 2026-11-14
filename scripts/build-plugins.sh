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
  aarch64|arm64) GOARCH=arm64; JRE_ARCH=aarch64; JRE_SHA256=b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c ;;
  x86_64|amd64) GOARCH=amd64; JRE_ARCH=x64; JRE_SHA256=a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd ;;
  *) echo "unsupported local architecture: $ARCH" >&2; exit 1 ;;
esac
TS_CAP=sha256:16720c5f7a1cac3268d2cd20b72be3f0b4306734a6a087088e30ce2d8e96cf17
GO_CAP=sha256:fb87937c44f196076d9ea49455023f8d70e1ef5be94823730692c7c1e9998f8f
JAVA_CAP=sha256:396bf4276f3cecd170cf7c400ead5df06a6b987e66e5141d6b13f6001bddf708
sha256_file() {
  python3 - "$1" <<'PYHASH'
import hashlib, sys
digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print("sha256:" + digest.hexdigest())
PYHASH
}
NODE_BASE_IMAGE="$(docker inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}' 2>/dev/null | tr -d '\n' || true)"
[ -n "$NODE_BASE_IMAGE" ] || NODE_BASE_IMAGE="node:22-bookworm-slim"
verify_sha256() {
  python3 - "$1" "$2" <<'PYVERIFY'
import hashlib, sys
digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
actual = digest.hexdigest()
if actual != sys.argv[2]:
    raise SystemExit(f"sha256 mismatch: expected {sys.argv[2]}, got {actual}")
PYVERIFY
}
TS_BUILD_1="$(sha256_file plugins/hello-ops/backend-ts/server.mjs)"
TS_BUILD_2="$TS_BUILD_1"
cargo build -q -p opsweave-opsctl
echo "== web assets"
PLUGIN_VERSION="$TS_VERSION" pnpm --fail-if-no-match --filter @opsweave/hello-web build >/dev/null
rm -rf /tmp/hello-web-v1 && cp -R plugins/hello-ops/web/dist /tmp/hello-web-v1
PLUGIN_VERSION="$TS_V2_VERSION" pnpm --fail-if-no-match --filter @opsweave/hello-web build >/dev/null
rm -rf /tmp/hello-web-v2 && cp -R plugins/hello-ops/web/dist /tmp/hello-web-v2
PLUGIN_VERSION="$TS_VERSION" pnpm --fail-if-no-match --filter @opsweave/hello-web build >/dev/null

echo "== TypeScript OCI images"
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION="$TS_VERSION" --build-arg CAPABILITY_DIGEST="$TS_CAP" --build-arg BUILD_DIGEST="$TS_BUILD_1" -t "$REGISTRY/opsweave/hello-ts:$TS_VERSION" plugins/hello-ops/backend-ts >/dev/null
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION="$TS_V2_VERSION" --build-arg CAPABILITY_DIGEST="$TS_CAP" --build-arg BUILD_DIGEST="$TS_BUILD_2" -t "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION" plugins/hello-ops/backend-ts >/dev/null

echo "== Go OCI image"
( cd plugins/hello-go && GOOS=linux GOARCH="$GOARCH" CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o hello-go-linux . )
GO_BUILD="$(sha256_file plugins/hello-go/hello-go-linux)"
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION=0.0.1 --build-arg CAPABILITY_DIGEST="$GO_CAP" --build-arg BUILD_DIGEST="$GO_BUILD" -t "$REGISTRY/opsweave/hello-go:0.0.1" plugins/hello-go >/dev/null
# A second version, so the Go plugin can be put through upgrade and rollback the
# way the TypeScript reference plugin already is. Without it those steps can only
# be reported NOT_RUN, and "Go has a full lifecycle" would be an inference from
# another language rather than a measurement.
#
# `PLUGIN_VERSION` is what the runtime reports at `/_opsweave/runtime/v1/info`,
# and the Node refuses an instance whose reported version differs from the
# signed manifest (`verify_runtime_info`). So this must be a real image with the
# right version baked in - not the 0.0.1 image under a different tag.
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION=0.0.2 --build-arg CAPABILITY_DIGEST="$GO_CAP" --build-arg BUILD_DIGEST="$GO_BUILD" -t "$REGISTRY/opsweave/hello-go:0.0.2" plugins/hello-go >/dev/null

echo "== Java OCI image"
# The pinned JRE comes from one of two deterministic sources, in this order:
#
#   1. the Temurin 21 JDK the runner already carries (actions/setup-java in CI,
#      or a local toolchain), through its own jlink;
#   2. the pinned Temurin 21 JRE release archive, SHA-256 verified.
#
# Source 1 exists because the GitHub Releases host answered HTTP 504 to every
# attempt from a GitHub runner (B1.8 runs 42469656670, 42469747350: six
# retries, all 504), so retrying a broken transport was not a fix. jlink from
# the same major JDK keeps the runtime's language level; the archive path
# remains for hosts without a JDK and is still the only path that pins a
# byte-for-byte upstream digest.
# A cached JRE is reused across runs, so a runtime produced on another platform
# would be baked into every later image. The image base is Linux, so the cached
# java binary must be an ELF executable; anything else (Mach-O from a macOS jlink,
# PE from Windows) is discarded and rebuilt.
if [ -e plugins/hello-java/jre/bin/java ] && [ "$(head -c 4 plugins/hello-java/jre/bin/java 2>/dev/null | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
  echo "discarding the cached Java plugin JRE: bin/java is not a Linux ELF executable" >&2
  rm -rf plugins/hello-java/jre
fi
# Declared OUTSIDE the build branch below. It used to be assigned only when the
# JRE had to be produced, so a checkout that already carried a cached
# `plugins/hello-java/jre` skipped the assignment entirely and the two later
# `($JRE_SOURCE)` log lines aborted the whole build under `set -u`:
#   scripts/build-plugins.sh: line 167: JRE_SOURCE: unbound variable
# The images had already been built and exported by then, so the failure landed
# after all the expensive work and no bundle was ever signed.
JRE_SOURCE="cached"
if [ ! -x plugins/hello-java/jre/bin/java ]; then
  mkdir -p plugins/hello-java/jre
  JRE_SOURCE=""
  JDK_HOME=""
  if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/jlink" ]; then
    JDK_HOME="$JAVA_HOME"
  elif command -v javac >/dev/null 2>&1; then
    JDK_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)" 2>/dev/null || command -v javac)")")"
    [ -x "$JDK_HOME/bin/jlink" ] || JDK_HOME=""
  fi
  # The jar targets Java 21; a runtime from an older JDK must not be substituted,
  # and a newer one is only accepted when it can still run `--release 21` output
  # (every JDK >= 21 can). The major version is read from the JDK itself.
  if [ -n "$JDK_HOME" ]; then
    JDK_MAJOR="$("$JDK_HOME/bin/jlink" --version 2>/dev/null | sed -E 's/^([0-9]+).*/\1/' || true)"
    if [ -z "$JDK_MAJOR" ] || [ "$JDK_MAJOR" -lt 21 ] 2>/dev/null; then
      echo "the JDK at $JDK_HOME is not >= 21; falling back to the pinned archive" >&2
      JDK_HOME=""
    fi
  fi
  # jlink produces a runtime for the platform it runs on, and the image it is
  # copied into is always linux/<the same arch>. A macOS or Windows JDK would
  # therefore bake a Mach-O/PE runtime into a Linux image: the build succeeds and
  # the Pod then dies on exec. Only a Linux JDK may take the jlink path.
  if [ -n "$JDK_HOME" ]; then
    JDK_PLATFORM="$(uname -s)"
    if [ "$JDK_PLATFORM" != "Linux" ]; then
      echo "the JDK at $JDK_HOME runs on $JDK_PLATFORM; its jlink output cannot enter a Linux image, falling back to the pinned archive" >&2
      JDK_HOME=""
    fi
  fi
  if [ -n "$JDK_HOME" ]; then
    echo "Building the plugin JRE with jlink from $JDK_HOME (JDK $JDK_MAJOR)" >&2
    rm -rf plugins/hello-java/jre
    # java.se plus the JDK-only modules Spring Boot needs. A hand-listed subset
    # is not enough: the previous set omitted java.desktop and the plugin died at
    # startup with ClassNotFoundException: java.beans.PropertyEditorSupport, which
    # only shows up after deployment. java.se is the whole SE surface, so
    # reflection and SPI lookups cannot fall outside it.
    "$JDK_HOME/bin/jlink" --add-modules java.se,jdk.unsupported,jdk.crypto.ec,jdk.jfr --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output plugins/hello-java/jre >/dev/null
    JRE_SOURCE="jlink:$(basename "$JDK_HOME"):java.se"
  else
    echo "Downloading pinned Temurin 21 JRE for linux/$JRE_ARCH" >&2
    JRE_FILE="OpenJDK21U-jre_${JRE_ARCH}_linux_hotspot_21.0.13_9.tar.gz"
    curl -fsSL --retry 8 --retry-delay 5 --retry-max-time 600 --retry-all-errors --max-time 240 "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/${JRE_FILE}" -o /tmp/opsweave-jre21.tar.gz
    verify_sha256 /tmp/opsweave-jre21.tar.gz "$JRE_SHA256"
    tar xzf /tmp/opsweave-jre21.tar.gz -C plugins/hello-java/jre --strip-components=1
    JRE_SOURCE="pinned-archive"
  fi
  [ -x plugins/hello-java/jre/bin/java ] || { echo "the Java plugin JRE was not produced ($JRE_SOURCE)" >&2; exit 1; }
  echo "Java plugin JRE source: $JRE_SOURCE" >&2
fi
if [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
  JAVA_HOME=/opt/homebrew/opt/openjdk@21 mvn -q -f plugins/hello-java/pom.xml -DskipTests package
else
  mvn -q -f plugins/hello-java/pom.xml -DskipTests package
fi
JAVA_BUILD="$(sha256_file plugins/hello-java/target/hello-java-0.0.1.jar)"
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION=0.0.1 --build-arg CAPABILITY_DIGEST="$JAVA_CAP" --build-arg BUILD_DIGEST="$JAVA_BUILD" -t "$REGISTRY/opsweave/hello-java:0.0.1" plugins/hello-java >/dev/null
# Same reason as the Go 0.0.2 image above: a real second version, so upgrade and
# rollback are measured rather than assumed.
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION=0.0.2 --build-arg CAPABILITY_DIGEST="$JAVA_CAP" --build-arg BUILD_DIGEST="$JAVA_BUILD" -t "$REGISTRY/opsweave/hello-java:0.0.2" plugins/hello-java >/dev/null
# A JRE that cannot boot the jar still builds and pushes cleanly; the failure only
# appears minutes later inside a Pod as a replica stuck in DEGRADED (B1.8 run
# 42472581569: java.beans.PropertyEditorSupport missing from a hand-listed jlink
# module set). Booting the image here turns that class of defect into a build-time
# failure with the container log attached.
JAVA_SMOKE_NAME="opsweave-hello-java-smoke-$$"
docker rm -f "$JAVA_SMOKE_NAME" >/dev/null 2>&1 || true
docker run -d --name "$JAVA_SMOKE_NAME" -p 127.0.0.1::8080 "$REGISTRY/opsweave/hello-java:0.0.1" >/dev/null
JAVA_SMOKE_PORT="$(docker port "$JAVA_SMOKE_NAME" 8080/tcp 2>/dev/null | head -1 | sed -E 's/.*:([0-9]+)$/\1/')"
JAVA_SMOKE_OK=""
if [ -n "$JAVA_SMOKE_PORT" ]; then
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "http://127.0.0.1:${JAVA_SMOKE_PORT}/_opsweave/health/live" >/dev/null 2>&1; then JAVA_SMOKE_OK=1; break; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$JAVA_SMOKE_NAME" 2>/dev/null)" = "true" ] || break
    sleep 1
  done
fi
if [ -z "$JAVA_SMOKE_OK" ]; then
  echo "the hello-java image never becomes live ($JRE_SOURCE); container log:" >&2
  docker logs "$JAVA_SMOKE_NAME" >&2 2>&1 || true
  docker rm -f "$JAVA_SMOKE_NAME" >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f "$JAVA_SMOKE_NAME" >/dev/null 2>&1 || true
echo "Java plugin image boots and answers /_opsweave/health/live ($JRE_SOURCE)" >&2

echo "== push digests"
docker push "$REGISTRY/opsweave/hello-ts:$TS_VERSION" >/dev/null
docker push "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION" >/dev/null
docker push "$REGISTRY/opsweave/hello-go:0.0.1" >/dev/null
docker push "$REGISTRY/opsweave/hello-go:0.0.2" >/dev/null
docker push "$REGISTRY/opsweave/hello-java:0.0.1" >/dev/null
docker push "$REGISTRY/opsweave/hello-java:0.0.2" >/dev/null
TS_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-ts:$TS_VERSION")"
TS2_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION")"
GO_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-go:0.0.1")"
GO2_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-go:0.0.2")"
JAVA_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-java:0.0.1")"
JAVA2_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-java:0.0.2")"

echo "== signed bundles"
rm -rf /tmp/opsweave-bundles dist/plugins
mkdir -p /tmp/opsweave-bundles dist/plugins
python3 scripts/assemble_plugin.py --template plugins/hello-ops/manifest.template.json --out /tmp/opsweave-bundles/hello-ops-0.0.1 --version "$TS_VERSION" --image-ref "$TS_DIGEST" --frontend-dist /tmp/hello-web-v1 >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-ops/manifest.template.json --out /tmp/opsweave-bundles/hello-ops-0.0.2 --version "$TS_V2_VERSION" --image-ref "$TS2_DIGEST" --frontend-dist /tmp/hello-web-v2 >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-go/manifest.template.json --out /tmp/opsweave-bundles/hello-go-0.0.1 --version 0.0.1 --image-ref "$GO_DIGEST" >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-go/manifest.template.json --out /tmp/opsweave-bundles/hello-go-0.0.2 --version 0.0.2 --image-ref "$GO2_DIGEST" >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-java/manifest.template.json --out /tmp/opsweave-bundles/hello-java-0.0.1 --version 0.0.1 --image-ref "$JAVA_DIGEST" >/dev/null
python3 scripts/assemble_plugin.py --template plugins/hello-java/manifest.template.json --out /tmp/opsweave-bundles/hello-java-0.0.2 --version 0.0.2 --image-ref "$JAVA2_DIGEST" >/dev/null
for name in hello-ops-0.0.1 hello-ops-0.0.2 hello-go-0.0.1 hello-go-0.0.2 hello-java-0.0.1 hello-java-0.0.2; do
  ./target/debug/opsctl bundle --dir "/tmp/opsweave-bundles/$name" --out "dist/plugins/$name.plugin.zip" --key keys/publisher.key >/dev/null
done
python3 - "$TS_DIGEST" "$TS2_DIGEST" "$GO_DIGEST" "$JAVA_DIGEST" <<'PY'
import json, pathlib, sys
plugin_dir = pathlib.Path('dist/plugins')
entries = []
for name in ['hello-ops-0.0.1','hello-ops-0.0.2','hello-go-0.0.1','hello-go-0.0.2','hello-java-0.0.1','hello-java-0.0.2']:
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
