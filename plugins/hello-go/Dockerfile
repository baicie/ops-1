# The reference Node image is Linux/arm64 on this development host; the binary is
# built for the target platform by scripts/build-plugins.sh. Production release
# pipelines build linux/amd64 with the same static binary.
FROM node:22-bookworm-slim
ARG PLUGIN_VERSION=0.0.1
ARG CAPABILITY_DIGEST
ARG BUILD_DIGEST
WORKDIR /app
COPY hello-go-linux /app/hello-go
ENV OPSWEAVE_PLUGIN_ID=dev.opsweave.hello-go \
    OPSWEAVE_PLUGIN_VERSION=${PLUGIN_VERSION} \
    OPSWEAVE_CAPABILITY_DIGEST=${CAPABILITY_DIGEST} \
    OPSWEAVE_BUILD_DIGEST=${BUILD_DIGEST} \
    PORT=8080
USER node
EXPOSE 8080
ENTRYPOINT ["/app/hello-go"]
