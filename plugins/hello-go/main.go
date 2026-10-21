package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

var (
	pluginID         = env("OPSWEAVE_PLUGIN_ID", "dev.opsweave.hello.go")
	version          = env("OPSWEAVE_PLUGIN_VERSION", "0.0.1")
	capabilityDigest = env("OPSWEAVE_CAPABILITY_DIGEST", "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	buildDigest      = env("OPSWEAVE_BUILD_DIGEST", "sha256:1111111111111111111111111111111111111111111111111111111111111111")
	instanceID       = env("OPSWEAVE_INSTANCE_ID", "dev-instance")
	port             = env("PORT", "8080")
	ready            atomic.Bool
	startedAt        = time.Now()
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func requestID(r *http.Request) string {
	if value := r.Header.Get("X-OpsWeave-Request-Id"); value != "" && len(value) <= 128 {
		return value
	}
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), os.Getpid())
}

func writeJSON(w http.ResponseWriter, status int, id string, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-OpsWeave-Request-Id", id)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errorJSON(w http.ResponseWriter, status int, id, code, message string, retryable bool) {
	writeJSON(w, status, id, map[string]any{"code": code, "message": message, "requestId": id, "retryable": retryable})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/_opsweave/runtime/v1/info", func(w http.ResponseWriter, r *http.Request) {
		id := requestID(r)
		writeJSON(w, 200, id, map[string]any{
			"pluginId": pluginID, "version": version, "runtimeProtocol": "http-json-v1",
			"capabilityDigest": capabilityDigest, "buildDigest": buildDigest,
		})
	})
	mux.HandleFunc("/_opsweave/health/live", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, requestID(r), map[string]any{"status": "live"})
	})
	mux.HandleFunc("/_opsweave/health/startup", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, requestID(r), map[string]any{"status": "started"})
	})
	mux.HandleFunc("/_opsweave/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if ready.Load() {
			writeJSON(w, 200, requestID(r), map[string]any{"status": "ready", "version": version})
			return
		}
		writeJSON(w, 503, requestID(r), map[string]any{"status": "not_ready", "version": version})
	})
	mux.HandleFunc("/api/hello", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			errorJSON(w, 405, requestID(r), "METHOD_NOT_ALLOWED", "GET only", false)
			return
		}
		id := requestID(r)
		writeJSON(w, 200, id, map[string]any{
			"pluginId": pluginID, "version": version, "message": "Hello from OpsWeave (Go)",
			"instanceId": instanceID, "requestId": id,
			"runtime":   map[string]any{"language": "Go", "goroutines": "runtime-managed", "pid": os.Getpid(), "uptimeSeconds": int(time.Since(startedAt).Seconds())},
			"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		})
	})
	mux.HandleFunc("/api/hello/echo", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errorJSON(w, 405, requestID(r), "METHOD_NOT_ALLOWED", "POST only", false)
			return
		}
		id := requestID(r)
		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
		if err != nil || len(body) > 64*1024 {
			errorJSON(w, 413, id, "PAYLOAD_TOO_LARGE", "Request body exceeds 64 KiB", false)
			return
		}
		var parsed any
		if len(body) > 0 {
			if err := json.Unmarshal(body, &parsed); err != nil {
				errorJSON(w, 400, id, "INVALID_JSON", "Body must be valid JSON", false)
				return
			}
		}
		writeJSON(w, 200, id, map[string]any{"echoed": parsed, "pluginId": pluginID, "version": version, "instanceId": instanceID, "requestId": id})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		errorJSON(w, 404, requestID(r), "NOT_FOUND", "No such route", false)
	})

	server := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		time.Sleep(500 * time.Millisecond)
		ready.Store(true)
		log.Printf("INFO hello-go runtime ready version=%s instance=%s", version, instanceID)
	}()
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()
	log.Printf("INFO hello-go runtime listening port=%s version=%s", port, version)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	ready.Store(false)
	log.Printf("INFO received shutdown signal; readiness disabled")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
