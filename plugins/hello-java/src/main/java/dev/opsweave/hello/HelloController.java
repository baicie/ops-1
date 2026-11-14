package dev.opsweave.hello;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@RestController
public class HelloController {

    private String requestId(HttpServletRequest request) {
        String incoming = request.getHeader("X-OpsWeave-Request-Id");
        return incoming != null && !incoming.isBlank() && incoming.length() <= 128 ? incoming : UUID.randomUUID().toString();
    }

    @GetMapping("/_opsweave/runtime/v1/info")
    public Map<String, Object> info(HttpServletRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("pluginId", RuntimeState.PLUGIN_ID);
        body.put("version", RuntimeState.VERSION);
        body.put("runtimeProtocol", "http-json-v1");
        body.put("capabilityDigest", RuntimeState.CAPABILITY_DIGEST);
        body.put("buildDigest", RuntimeState.BUILD_DIGEST);
        return body;
    }

    @GetMapping("/_opsweave/health/live")
    public ResponseEntity<Map<String, Object>> live() {
        return ResponseEntity.ok(Map.of("status", "live"));
    }

    @GetMapping("/_opsweave/health/startup")
    public ResponseEntity<Map<String, Object>> startup() {
        return ResponseEntity.ok(Map.of("status", "started"));
    }

    @GetMapping("/_opsweave/health/ready")
    public ResponseEntity<Map<String, Object>> ready() {
        if (HelloApplication.READY.get()) {
            return ResponseEntity.ok(Map.of("status", "ready", "version", RuntimeState.VERSION));
        }
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("status", "not_ready", "version", RuntimeState.VERSION));
    }

    @GetMapping("/api/hello")
    public Map<String, Object> hello(HttpServletRequest request) {
        String id = requestId(request);
        Map<String, Object> runtime = new LinkedHashMap<>();
        runtime.put("language", "Java 21 / Spring Boot");
        runtime.put("jvm", System.getProperty("java.version"));
        runtime.put("pid", ProcessHandle.current().pid());
        runtime.put("uptimeSeconds", java.time.Duration.between(RuntimeState.STARTED_AT, Instant.now()).toSeconds());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("pluginId", RuntimeState.PLUGIN_ID);
        body.put("version", RuntimeState.VERSION);
        body.put("message", "Hello from OpsWeave (Java / Spring Boot)");
        body.put("instanceId", RuntimeState.INSTANCE_ID);
        body.put("requestId", id);
        body.put("runtime", runtime);
        body.put("timestamp", Instant.now().toString());
        return body;
    }

    @PostMapping("/api/hello/echo")
    public ResponseEntity<Map<String, Object>> echo(@RequestBody(required = false) Object payload, HttpServletRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("echoed", payload);
        body.put("pluginId", RuntimeState.PLUGIN_ID);
        body.put("version", RuntimeState.VERSION);
        body.put("instanceId", RuntimeState.INSTANCE_ID);
        body.put("requestId", requestId(request));
        // The same two observations the TypeScript and Go reference plugins make,
        // so the conformance matrix asserts one property across all three
        // languages. An unsigned caller-role header must never arrive (null =
        // stripped by the Gateway); a Kernel-signed context must. Presence only:
        // this plugin does not hold its context key and must not claim to have
        // verified the token.
        String role = request.getHeader("X-OpsWeave-User-Role");
        body.put("deliveredUnsignedRole", role == null || role.isEmpty() ? null : role);
        String ctx = request.getHeader("X-OpsWeave-User-Context");
        body.put("deliveredSignedContext", ctx != null && ctx.startsWith("owu1."));
        return ResponseEntity.ok(body);
    }

    // The Runtime v1 contract names this refusal: malformed JSON is a 400 with
    // a stable code (`contracts/openapi/plugin-runtime-v1.yaml`, `Error`), and
    // TypeScript (`server.mjs:84`) and Go (`main.go:103`) both answer
    // `400 INVALID_JSON`.
    //
    // Without this handler Spring's `HttpMessageNotReadableException` fell
    // through to the `Exception` handler below and became
    // `500 INTERNAL` - a contract divergence that existed only in Java and was
    // invisible until the conformance matrix ran the same assertion against all
    // three languages.
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unreadableBody(
            HttpMessageNotReadableException exception, HttpServletRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "INVALID_JSON");
        body.put("message", "Body must be valid JSON");
        body.put("requestId", requestId(request));
        body.put("retryable", false);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> error(Exception exception, HttpServletRequest request) {
        String id = requestId(request);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "INTERNAL");
        body.put("message", "The plugin could not process the request");
        body.put("requestId", id);
        body.put("retryable", false);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }
}
