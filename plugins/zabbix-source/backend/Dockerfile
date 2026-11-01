ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG PLUGIN_VERSION=0.0.1
ARG CAPABILITY_DIGEST
ARG BUILD_DIGEST
WORKDIR /app
COPY package.json package-lock.json ./
# No runtime dependencies: the plugin speaks Zabbix JSON-RPC over the Node
# standard library, so there is nothing to install and nothing to audit. `npm ci`
# still runs so a future dependency cannot slip in unlocked (rules/09).
RUN npm ci --omit=dev --no-audit --no-fund
COPY zabbix.mjs server.mjs ./
ENV NODE_ENV=production \
    PORT=8080 \
    OPSWEAVE_PLUGIN_ID=opsweave.zabbix-source \
    OPSWEAVE_PLUGIN_VERSION=${PLUGIN_VERSION} \
    OPSWEAVE_CAPABILITY_DIGEST=${CAPABILITY_DIGEST} \
    OPSWEAVE_BUILD_DIGEST=${BUILD_DIGEST}
# Non-root, matching the other reference plugins (rules/09: the runtime must not
# need root and the image must not rely on being given it).
USER 65532:65532
EXPOSE 8080
CMD ["node", "server.mjs"]
