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
# Web Shell (React + Vite). Output: /src/apps/platform-web/dist
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS webbuild
ENV CI=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install --global pnpm@10.34.3
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @opsweave/platform-web build

# ---------------------------------------------------------------------------
# Rust binaries. contracts/ is required: apps/kernel/src/pipeline.rs embeds
# contracts/examples/*.json via include_str!.
# --config sets profile.release.strip without editing Cargo.toml (the
# workspace declares no [profile.release]).
# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS rustbuild
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY contracts ./contracts
COPY crates ./crates
COPY apps ./apps
RUN cargo build --release --locked --config 'profile.release.strip=true' \
      -p opsweave-kernel \
      -p opsweave-node \
      -p opsweave-opsctl \
      -p opsweave-pipeline-worker

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

COPY --from=rustbuild /src/target/release/opsweave-kernel /usr/local/bin/opsweave-kernel
COPY --from=rustbuild /src/target/release/opsweave-node /usr/local/bin/opsweave-node
COPY --from=rustbuild /src/target/release/opsctl /usr/local/bin/opsctl
COPY --from=rustbuild /src/target/release/opsweave-pipeline-worker /usr/local/bin/opsweave-pipeline-worker

COPY --from=webbuild /src/apps/platform-web/dist /app/web

RUN groupadd --gid "${OPSWEAVE_GID}" opsweave \
 && useradd --uid "${OPSWEAVE_UID}" --gid "${OPSWEAVE_GID}" --create-home \
      --shell /usr/sbin/nologin opsweave \
 && mkdir -p /app/data /app/node-state \
 && chown -R opsweave:opsweave /app

ENV OPSWEAVE_WEB_DIST=/app/web \
    OPSWEAVE_DATA_DIR=/app/data

WORKDIR /app
USER opsweave

# Informational only: staging uses host networking (see compose.yaml).
EXPOSE 8081

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/opsweave-kernel"]
