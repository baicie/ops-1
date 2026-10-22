# Pinned Temurin 21.0.12.1 JRE for linux/aarch64 (development host). The same
# jar is released for linux/amd64 by the production pipeline.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG PLUGIN_VERSION=0.0.1
ARG CAPABILITY_DIGEST
ARG BUILD_DIGEST
COPY jre /opt/java
COPY target/hello-java-0.0.1.jar /app/app.jar
ENV JAVA_HOME=/opt/java \
    PATH=/opt/java/bin:$PATH \
    OPSWEAVE_PLUGIN_ID=dev.opsweave.hello-java \
    OPSWEAVE_PLUGIN_VERSION=${PLUGIN_VERSION} \
    OPSWEAVE_CAPABILITY_DIGEST=${CAPABILITY_DIGEST} \
    OPSWEAVE_BUILD_DIGEST=${BUILD_DIGEST} \
    PORT=8080
WORKDIR /app
USER node
EXPOSE 8080
ENTRYPOINT ["/opt/java/bin/java","-jar","/app/app.jar"]
