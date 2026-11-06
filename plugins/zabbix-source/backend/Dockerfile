ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG PLUGIN_VERSION=0.0.1
ARG CAPABILITY_DIGEST
ARG BUILD_DIGEST
WORKDIR /app
COPY package.json package-lock.json ./
# The plugin's only runtime dependency is `pg`, used to reach the
# Kernel-provisioned plugin schema. npm ci keeps it locked (rules/09).
RUN npm ci --omit=dev --no-audit --no-fund
COPY zabbix.mjs server.mjs storage.mjs identity.mjs credential-binding.mjs ./
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
