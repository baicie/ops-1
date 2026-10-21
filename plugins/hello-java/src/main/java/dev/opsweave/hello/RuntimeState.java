package dev.opsweave.hello;

import java.time.Instant;

public final class RuntimeState {
    public static final String PLUGIN_ID = env("OPSWEAVE_PLUGIN_ID", "dev.opsweave.hello-java");
    public static final String VERSION = env("OPSWEAVE_PLUGIN_VERSION", "0.0.1");
    public static final String CAPABILITY_DIGEST = env("OPSWEAVE_CAPABILITY_DIGEST", "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    public static final String BUILD_DIGEST = env("OPSWEAVE_BUILD_DIGEST", "sha256:1111111111111111111111111111111111111111111111111111111111111111");
    public static final String INSTANCE_ID = env("OPSWEAVE_INSTANCE_ID", "dev-instance");
    public static final Instant STARTED_AT = Instant.now();

    private RuntimeState() {}

    public static String version() {
        return VERSION;
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value;
    }
}
