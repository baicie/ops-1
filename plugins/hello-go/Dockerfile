# The reference Node image is Linux/arm64 on this development host; the binary is
# built for the target platform by scripts/build-plugins.sh. Production release
# pipelines build linux/amd64 with the same static binary.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG PLUGIN_VERSION=0.0.1
ARG CAPABILITY_DIGEST
ARG BUILD_DIGEST
WORKDIR /app
COPY hello-go-linux /app/hello-go
# `PLUGIN_ID` and `RUNTIME_PROTOCOL` are build arguments so the conformance
# matrix can build a negative fixture - the same binary reporting a protocol the
# Node must refuse - without a second source tree. Both default to the contract
# values, so a build that passes neither is byte-for-byte the plugin it was.
ARG PLUGIN_ID=dev.opsweave.hello-go
ARG RUNTIME_PROTOCOL=http-json-v1
ENV OPSWEAVE_PLUGIN_ID=${PLUGIN_ID} \
    OPSWEAVE_PLUGIN_VERSION=${PLUGIN_VERSION} \
    OPSWEAVE_CAPABILITY_DIGEST=${CAPABILITY_DIGEST} \
    OPSWEAVE_BUILD_DIGEST=${BUILD_DIGEST} \
    OPSWEAVE_RUNTIME_PROTOCOL=${RUNTIME_PROTOCOL} \
    PORT=8080
USER node
EXPOSE 8080
ENTRYPOINT ["/app/hello-go"]
