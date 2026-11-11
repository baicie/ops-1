# OpsWeave staging: one image, two roles.
# No `# syntax` directive on purpose: the build uses only stable Dockerfile
# features, so it must not depend on pulling a BuildKit frontend image.
#   kernel -> /usr/local/bin/opsweave-kernel (also serves the Web Shell from /app/web)
#   node   -> /usr/local/bin/opsweave-node   (selected by overriding `command:` in compose)
# Built only in CI: the target host has no rust/node toolchain.

ARG RUST_VERSION=1.99.1
ARG NODE_VERSION=22
ARG DOCKER_CLI_VERSION=29.6.1

# ---------------------------------------------------------------------------
# The two web applications (G14.2). They are separate builds and separate
# artifacts, and the Kernel serves each from its own mount, so the full-product
# image must carry both: /app/web is the Platform Console, /app/ops-web the Ops
# application.
#
# P001-B.1 splits this into two stages, because the platform-only target used to
# be blocked by the business frontend: it waited on a `webbuild` that compiled
# ops-web it never copies. `webbuild-console` builds only what the platform
# image ships; `webbuild` adds the ops bundle on top of it for the full product.
# The dependency direction is now the real one - the light target cannot fail
# because the business application does not compile.
#   webbuild-console -> /src/apps/platform-console/dist
#   webbuild         -> the above, plus /src/apps/ops-web/dist
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS webbuild-console
ENV CI=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install --global pnpm@10.34.3
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @opsweave/platform-console build

# The full product's web stage: the console, then the ops application. Kept as a
# separate stage so `--target platform` never reaches the second build.
FROM webbuild-console AS webbuild
WORKDIR /src
RUN pnpm --filter @opsweave/ops-web build

# ---------------------------------------------------------------------------
# Rust binaries. contracts/ is required: apps/kernel/src/pipeline.rs embeds
# contracts/examples/*.json via include_str!.
# --config sets profile.release.strip without editing Cargo.toml (the
# workspace declares no [profile.release]).
#
# Two stages for the same reason as the web split. The platform-only kernel used
# to be compiled AFTER a full-product build of four binaries, so a broken
# `opsweave-pipeline-worker` failed the light image even though it ships none of
# it. `rustbuild-platform` compiles only what the platform image contains;
# `rustbuild` builds the full product on top of it and copies the light kernel
# out of the platform stage.
# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS rustbuild-platform
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY contracts ./contracts
COPY crates ./crates
COPY apps ./apps
# The platform-only kernel plus the two platform roles. No pipeline worker.
#
# `--build-arg OPSWEAVE_VERSION_OVERRIDE=0.0.2` produces a genuinely different
# build from the same tree: the workspace version is bumped and the lock file is
# relocked INSIDE this stage, where cargo exists. That is what the acceptance run
# needs to have two real versions to upgrade between - editing Cargo.toml on the
# host and leaving Cargo.lock alone fails with "cannot update the lock file
# because --locked was passed", and the host has no cargo to relock with.
ARG OPSWEAVE_VERSION_OVERRIDE=""
RUN set -eu; \
    if [ -n "$OPSWEAVE_VERSION_OVERRIDE" ]; then \
      sed -i "s/^version = \"[0-9][0-9.]*\"$/version = \"$OPSWEAVE_VERSION_OVERRIDE\"/" Cargo.toml; \
      sed -i "s/^version = \"0\.0\.1\"$/version = \"$OPSWEAVE_VERSION_OVERRIDE\"/" Cargo.lock; \
      v=$(grep -c "^version = \"$OPSWEAVE_VERSION_OVERRIDE\"$" Cargo.lock); \
      [ "$v" -ge 7 ] || { echo "lock rewrite touched $v entries, expected 7" >&2; exit 1; }; \
      ! grep -q "^version = \"0\.0\.1\"$" Cargo.lock || { echo "a 0.0.1 lock entry survived" >&2; exit 1; }; \
    fi
RUN cargo build --release --locked --config 'profile.release.strip=true' \
      -p opsweave-kernel --no-default-features \
      -p opsweave-node \
      -p opsweave-opsctl

FROM rustbuild-platform AS rustbuild
WORKDIR /src
RUN cargo build --release --locked --config 'profile.release.strip=true' \
      -p opsweave-kernel \
      -p opsweave-pipeline-worker \
 && cp /src/target/release/opsweave-kernel /src/target/full-kernel
# The platform-only kernel already exists in the shared target dir (same stage
# lineage), so no second copy is needed; the platform stage reads it directly.

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
# The node role shells out to the docker CLI (apps/node/src/docker.rs).
FROM docker:${DOCKER_CLI_VERSION}-cli AS dockercli

FROM debian:bookworm-slim AS runtime

ARG OPSWEAVE_UID=10001
ARG OPSWEAVE_GID=10001

# Mirrors behind a proxy intermittently answer 502 per-package, which apt does
# not retry; re-run the whole step a bounded number of times, then verify.
RUN set -eu; \
    attempts=0; \
    until apt-get update -o Acquire::Retries=5 \
          && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
               ca-certificates curl tini; do \
      attempts=$((attempts + 1)); \
      if [ "$attempts" -ge 3 ]; then echo "apt failed after 3 attempts" >&2; exit 1; fi; \
      echo "apt attempt $attempts failed; retrying in 10s" >&2; sleep 10; \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    curl --version >/dev/null && tini --version >/dev/null

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

COPY --from=rustbuild /src/target/full-kernel /usr/local/bin/opsweave-kernel
COPY --from=rustbuild /src/target/release/opsweave-node /usr/local/bin/opsweave-node
COPY --from=rustbuild /src/target/release/opsctl /usr/local/bin/opsctl
COPY --from=rustbuild /src/target/release/opsweave-pipeline-worker /usr/local/bin/opsweave-pipeline-worker

COPY --from=webbuild /src/apps/platform-console/dist /app/web
COPY --from=webbuild /src/apps/ops-web/dist /app/ops-web

RUN groupadd --gid "${OPSWEAVE_GID}" opsweave \
 && useradd --uid "${OPSWEAVE_UID}" --gid "${OPSWEAVE_GID}" --create-home \
      --shell /usr/sbin/nologin opsweave \
 && mkdir -p /app/data /app/node-state \
 && chown -R opsweave:opsweave /app

ENV OPSWEAVE_WEB_DIST=/app/web \
    OPSWEAVE_OPS_WEB_DIST=/app/ops-web \
    OPSWEAVE_DATA_DIR=/app/data

WORKDIR /app
USER opsweave

# Informational only: staging uses host networking (see compose.yaml).
EXPOSE 8081

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/opsweave-kernel"]

# ---------------------------------------------------------------------------
# Platform-only runtime (P001-B).
#
# NOT the default target. Docker builds the LAST stage in a file, so this one
# being last made every unqualified `docker build` produce a platform-only image
# - including the staging deploy, whose /app answer became 404 (run 42791913396).
# Callers must name `--target runtime` for the full product or `--target
# platform` for this one; `staging-preview.yml` and `scripts/platform-up` do.
# Keep this stage last only deliberately, and never add another after it without
# checking every caller that does not pass --target.
#
# The shipped product for a deployment that runs NO business application. It is
# a separate target rather than a flag on the full image because the difference
# must be visible in the artifact: this image contains no ops bundle, no pipeline
# worker, and a Kernel built without `business-ops`. An operator can prove what
# they are running with `docker image inspect`, and a mistaken `OPSWEAVE_IMAGE`
# cannot silently ship the Ops application.
#
#   docker build -f deployments/staging/Dockerfile --target platform -t opsweave-platform:<sha> .
#
# Deliberately still present: the docker CLI (the Node role drives plugin
# containers), `opsctl` (bootstrap and recovery), the console bundle.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS platform

ARG OPSWEAVE_UID=10001
ARG OPSWEAVE_GID=10001

RUN set -eu; \
    attempts=0; \
    until apt-get update -o Acquire::Retries=5 \
          && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
               ca-certificates curl tini; do \
      attempts=$((attempts + 1)); \
      if [ "$attempts" -ge 3 ]; then echo "apt failed after 3 attempts" >&2; exit 1; fi; \
      echo "apt attempt $attempts failed; retrying in 10s" >&2; sleep 10; \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    curl --version >/dev/null && tini --version >/dev/null

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# The platform-only Kernel and its two platform roles, taken from the stage that
# builds ONLY those. This stage has no edge to `rustbuild`, so a broken business
# crate cannot fail the platform image.
COPY --from=rustbuild-platform /src/target/release/opsweave-kernel /usr/local/bin/opsweave-kernel
COPY --from=rustbuild-platform /src/target/release/opsweave-node /usr/local/bin/opsweave-node
COPY --from=rustbuild-platform /src/target/release/opsctl /usr/local/bin/opsctl

COPY --from=webbuild-console /src/apps/platform-console/dist /app/web

RUN groupadd --gid "${OPSWEAVE_GID}" opsweave \
 && useradd --uid "${OPSWEAVE_UID}" --gid "${OPSWEAVE_GID}" --create-home \
      --shell /usr/sbin/nologin opsweave \
 && mkdir -p /app/data /app/node-state \
 && chown -R opsweave:opsweave /app

# No OPSWEAVE_OPS_WEB_DIST: there is no ops bundle to mount, and the Kernel
# refuses the /app prefix in this build.
ENV OPSWEAVE_WEB_DIST=/app/web \
    OPSWEAVE_DATA_DIR=/app/data

WORKDIR /app
USER opsweave

EXPOSE 8081

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/opsweave-kernel"]
