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

# The negative fixture for the conformance matrix: the SAME binary and image
# base, reporting a runtime protocol the Node must refuse. Built as its own
# image and bundle because it needs its own plugin id - deploying it under the
# real plugin's id would replace the instance the matrix just measured.
#
# The protocol is a runtime value the plugin self-reports, which is exactly what
# `verify_runtime_info` checks (`apps/node/src/runtime.rs:1909`). Making it a
# build argument is what lets the refusal be exercised against a real container
# rather than asserted about code.
echo "== Go negative fixture (reports http-json-v2)"
# Its own build digest, derived from the same binary plus the protocol name, so
# the fixture is distinguishable from the real plugin in `runtime/v1/info`
# rather than claiming an identical provenance it does not have.
GO_BUILD_2PROTO="$(python3 - "$GO_BUILD" <<'PYHASH'
import hashlib, sys
# Same prefix convention as `sha256_file`, computed from the real binary's digest
# plus the protocol name - so the fixture reports a digest of its own rather than
# reusing the real plugin's, and `shasum` (a Perl utility that is not guaranteed
# on the runner image) is not needed.
print("sha256:" + hashlib.sha256(("http-json-v2\n" + sys.argv[1]).encode()).hexdigest())
PYHASH
)"
docker build --build-arg BASE_IMAGE="$NODE_BASE_IMAGE" --build-arg PLUGIN_VERSION=0.0.1 --build-arg CAPABILITY_DIGEST="$GO_CAP" --build-arg BUILD_DIGEST="$GO_BUILD_2PROTO" --build-arg PLUGIN_ID=dev.opsweave.hello-go-v2protocol --build-arg RUNTIME_PROTOCOL=http-json-v2 -t "$REGISTRY/opsweave/hello-go-v2protocol:0.0.1" plugins/hello-go >/dev/null

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
# `-B`, not `-q`.
#
# This was `-q`, which suppresses INFO - including `Downloading from central:`
# and `Downloaded from central:`. When this build failed once (run 44666711786)
# the only line left was
#
#   Could not find artifact org.springframework.boot:spring-boot-starter-parent:pom:3.3.5
#
# which reads as "that version is not published". It was published, and the same
# environment built it hours later (run 44674095884, see
# docs/ci/plugin-lifecycle-maven-failure.md). The expensive part of that incident
# was not the failure - it was that the log could not say what had happened, so
# answering it needed a dedicated diagnostic workflow.
#
# Batch mode keeps the output non-interactive and keeps warnings and errors; it
# gives up only the progress noise. It does not make failures less likely - it
# makes the next one explain itself.
#
# RATE LIMITING IS A DIFFERENT FAILURE FROM THE ONE THE DOC ABOVE RECORDS, AND
# IT IS THE ONE THAT NOW HAPPENS.
#
# docs/ci/plugin-lifecycle-maven-failure.md:48-56 records an attempt at
# `-Dmaven.wagon.http.retryHandler.count=3` that was reverted because it did not
# help - correctly, because that incident was a TIMEOUT, and retrying a timeout
# inside the same budget changes nothing.
#
# Measured 2026-11-21, twice on this repository's own CI (runs 44881173622 and
# 44888419414), with a message the earlier incident never produced:
#
#   Could not transfer .../spring-boot-starter-parent-3.3.5.pom ...
#   status: 429
#
# 429 is the registry asking us to come back later. That is exactly the failure
# a backed-off retry fixes, and exactly what a timeout patch does not. So the
# two properties that were reverted for the wrong failure are added back for
# the right one, and nothing else about the invocation changes.
#
# `aether.connector.connectTimeout` / `.requestTimeout` are the resolver's own
# knobs; `retryHandler.count` is what turns a 429 into a later attempt. A
# retry that is still rate-limited after 4 tries fails as loudly as before -
# this raises the chance of success, it does not hide the failure.
#
# AND A THIRD FAILURE ARRIVED, WHICH MAVEN CANNOT RETRY ITSELF.
#
# Measured 2026-11-21 (run 44935699412) with a message that carries no status
# code at all:
#
#   Could not find artifact org.springframework.boot:spring-boot-starter-parent:pom:3.3.5
#
# The same URL answered 200 on three consecutive requests a minute later, from
# the same machine. So the artifact exists and the registry said otherwise.
#
# MEASURED WITH A LOCAL SERVER, not assumed:
#
#   server 404s the first 3 requests, then serves the POM
#     retryHandler.count=4            -> 1 request,  BUILD FAILURE
#     aether...retryHandler.name=standard -> 1 request,  BUILD FAILURE
#   server 503s the first 3, then serves
#     (defaults)                      -> 7 requests,  BUILD SUCCESS
#
# Maven retries 5xx and NEVER retries 4xx, at either layer, and there is no
# property that changes that: a 404 is the resolver's answer for "this artifact
# does not exist", and re-asking is pointless by design. The design is right;
# what it cannot express is a CDN edge answering 404 for an object it holds.
#
# So the retry has to be outside Maven - and it must be narrow enough that it
# cannot mask a real build failure. It retries ONLY when the output names a
# resolution failure, and never when the compiler or the tests spoke.
# The retry policy, extracted so it can be tested without Maven.
#
# `retry_on_registry_fault <label> <command...>` runs the command, and retries it
# up to three attempts with a linear backoff ONLY when the output names a
# registry fault. Everything else is returned on the first failure.
#
# The separation is what makes TASK-25 possible: a test can pass it a command
# that prints a given message and exits non-zero, and assert how many times it
# ran. Testing this through the real Maven would need a controlled registry and
# would measure the network as much as the policy.
#
# A registry fault is one of:
#   Could not (find|transfer|resolve) artifact   the resolver gave up
#   status: 429                                  rate limited
#   status: 5xx                                  the registry is unwell
# A compilation error, a test failure, or a missing `pom.xml` matches none of
# them, which is why the policy cannot mask a real build failure.
retry_on_registry_fault() {
  local label="$1"; shift
  local attempt=1 rc=0 log
  # STREAMED, NOT BUFFERED. Measured: with `out="$(cmd)"` the first line of a
  # two-second command appeared only when the command exited, and a Maven build
  # is minutes long. On CI that means the log shows NOTHING while the build is
  # failing - the reader learns what went wrong only after it has finished, and
  # a hung build shows an empty step.
  #
  # The output still has to be kept, because the retry decision depends on it
  # (`grep` for the fault shapes) and because the last attempt's full text is
  # what a reader needs. A temp file does both: `tee` writes it as the command
  # runs, so it is visible immediately and complete afterwards.
  log="$(mktemp)"
  # shellcheck disable=SC2064  # expand $log now, not at trap time
  trap "rm -f '$log'" RETURN
  while :; do
    : > "$log"
    if "$@" > >(tee "$log") 2>&1; then
      return 0
    else
      rc=$?
    fi
    # `tee` runs in a process substitution; wait for it to flush before reading.
    wait $! 2>/dev/null || true
    if [ "$attempt" -ge 3 ] || ! grep -qE \
        'Could not (find|transfer|resolve) artifact|status: (429|5[0-9][0-9])' "$log"; then
      # THE COMMAND'S EXIT CODE, NOT A FLATTENED 1.
      return "$rc"
    fi
    printf '%s: registry fault on attempt %d, retrying in %ds\n' "$label" "$attempt" "$((attempt * 15))" >&2
    [ -n "${OPSWEAVE_RETRY_SLEEP:-}" ] && sleep "$((attempt * OPSWEAVE_RETRY_SLEEP))" || sleep "$((attempt * 15))"
    attempt=$((attempt + 1))
  done
}

mvn_package() {
  # `-U` IS WHAT MAKES THE RETRY A RETRY, and it belongs on the command the
  # policy re-runs. Measured on CI (run 45001045124): attempt 1 failed with a
  # 429, the retry ran 16 seconds later and failed immediately with
  #
  #   was not found in ... during a previous attempt. This failure was cached
  #   in the local repository and resolution is not reattempted until the
  #   update interval of central has elapsed or updates are forced
  #
  # Maven had cached the failure, so the retry never issued a second request.
  # A loop that repeats a memoised command is not a retry.
  retry_on_registry_fault mvn \
    mvn -B -U "${MAVEN_RESILIENCE[@]}" -f plugins/hello-java/pom.xml -DskipTests package
}

MAVEN_RESILIENCE=(
  -Dmaven.wagon.http.retryHandler.count=4
  -Daether.connector.connectTimeout=60000
  -Daether.connector.requestTimeout=180000
)
if [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
  JAVA_HOME=/opt/homebrew/opt/openjdk@21 mvn_package
else
  mvn_package
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
# main's 0.0.2 upgrade image and this branch's negative fixture: different tags,
# different digests, both pushed.
docker push "$REGISTRY/opsweave/hello-go:0.0.2" >/dev/null
docker push "$REGISTRY/opsweave/hello-go-v2protocol:0.0.1" >/dev/null
docker push "$REGISTRY/opsweave/hello-java:0.0.1" >/dev/null
docker push "$REGISTRY/opsweave/hello-java:0.0.2" >/dev/null
TS_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-ts:$TS_VERSION")"
TS2_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-ts:$TS_V2_VERSION")"
GO_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-go:0.0.1")"
GO2_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-go:0.0.2")"
GO_V2PROTO_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/hello-go-v2protocol:0.0.1")"
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
# The conformance negative fixture. Its own id, so deploying it cannot replace
# the instance the matrix measures, and its own version string so a surfaced
# `runtime/v1/info` from it is identifiable at a glance.
python3 scripts/assemble_plugin.py --template plugins/hello-go/manifest.template.json --out /tmp/opsweave-bundles/hello-go-v2protocol --version 0.0.1 --id dev.opsweave.hello-go-v2protocol --image-ref "$GO_V2PROTO_DIGEST" >/dev/null
# The fixture must not claim the real plugin's capabilities. It is installed to
# be REFUSED, and a bundle advertising `sample.hello.go.v1` would be a second
# provider of a capability the matrix is measuring - the kind of cross-talk that
# turns one failing assertion into two confusing ones.
python3 - /tmp/opsweave-bundles/hello-go-v2protocol/manifest.json <<'PYFIX'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest["provides"] = []
with open(path, "w") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PYFIX
# Every bundle this script writes. The fixture is listed too: it is a real signed
# bundle a consumer can install, and leaving it out of a loop over the same
# directory is the asymmetry that makes a later reader wonder which are real.
for name in hello-ops-0.0.1 hello-ops-0.0.2 hello-go-0.0.1 hello-go-0.0.2 hello-java-0.0.1 hello-java-0.0.2 hello-go-v2protocol; do
  ./target/debug/opsctl bundle --dir "/tmp/opsweave-bundles/$name" --out "dist/plugins/$name.plugin.zip" --key keys/publisher.key >/dev/null
done
python3 - "$TS_DIGEST" "$TS2_DIGEST" "$GO_DIGEST" "$JAVA_DIGEST" <<'PY'
import json, pathlib, sys
plugin_dir = pathlib.Path('dist/plugins')
entries = []
# The fixture is listed too. It is a real signed bundle that a consumer can
# install, and leaving it out of the index while it sits in the same directory is
# the kind of asymmetry that makes a later reader wonder which bundles are real.
for name in ['hello-ops-0.0.1','hello-ops-0.0.2','hello-go-0.0.1','hello-go-0.0.2','hello-java-0.0.1','hello-java-0.0.2','hello-go-v2protocol']:
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
