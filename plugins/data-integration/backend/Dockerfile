ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG PLUGIN_VERSION=0.0.1
ARG CAPABILITY_DIGEST
ARG BUILD_DIGEST
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV NODE_ENV=production \
    PORT=8080 \
    OPSWEAVE_PLUGIN_ID=opsweave.data-integration \
    OPSWEAVE_PLUGIN_VERSION=${PLUGIN_VERSION} \
    OPSWEAVE_CAPABILITY_DIGEST=${CAPABILITY_DIGEST} \
    OPSWEAVE_BUILD_DIGEST=${BUILD_DIGEST}
USER 65532:65532
EXPOSE 8080
CMD ["node", "server.mjs"]
