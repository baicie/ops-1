#!/usr/bin/env python3
"""Deterministic Heartbeat-only fault proxy with structured JSONL evidence.

State file format: "<job-uuid> <mode>" where mode is 503, 429, 500, reset,
timeout, or off. Only POST /internal/v1/pipeline-jobs/<job>/heartbeat is
intercepted; every other request is forwarded verbatim to Kernel.
"""
import http.client
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = ("127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 18181)
STATE = sys.argv[3] if len(sys.argv) > 3 else "/tmp/heartbeat-fault-job"
EVENTS = sys.argv[4] if len(sys.argv) > 4 else "/tmp/heartbeat-fault-events.jsonl"
HEARTBEAT = re.compile(r"^/internal/v1/pipeline-jobs/([0-9a-fA-F-]{36})/heartbeat$")
SEQ = 0

def state():
    try:
        parts = open(STATE, encoding="utf-8").read().split()
    except OSError:
        return None, "off"
    return (parts[0], parts[1]) if len(parts) >= 2 else (None, "off")

def emit(**event):
    global SEQ
    SEQ += 1
    event.update(seq=SEQ, mono=f"{time.monotonic():.6f}", wall=f"{time.time():.6f}")
    print(json.dumps(event, sort_keys=True), flush=True)
    try:
        with open(EVENTS, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, sort_keys=True) + "\n")
    except OSError:
        pass

class Handler(BaseHTTPRequestHandler):
    def _handle(self):
        length = int(self.headers.get("content-length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path == "/__health":
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        match = HEARTBEAT.match(self.path) if self.command == "POST" else None
        job = match.group(1) if match else None
        target_job, mode = state()
        injected = bool(job and target_job and job == target_job and mode != "off")
        if injected:
            if mode == "reset":
                emit(method=self.command, path=self.path, job=job, mode=mode, status="reset", injected=True)
                self.connection.close()
                return
            if mode == "timeout":
                emit(method=self.command, path=self.path, job=job, mode=mode, status="timeout", injected=True)
                time.sleep(30)
                return
            status = int(mode) if mode in {"429", "500", "503"} else 503
            emit(method=self.command, path=self.path, job=job, mode=mode, status=status, injected=True)
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "connection"}}
        conn = http.client.HTTPConnection(*UPSTREAM, timeout=20)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            payload = response.read()
            if job:
                emit(method=self.command, path=self.path, job=job, mode=mode,
                     status=response.status, injected=False, forwarded=True)
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() in {"connection", "transfer-encoding", "content-length"}:
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            emit(method=self.command, path=self.path, job=job, mode=mode,
                 status="error", injected=False, forwarded=False, proxy_error=str(error))
            try:
                self.send_response(502); self.send_header("Content-Length", "0"); self.end_headers()
            except Exception:
                pass
        finally:
            conn.close()
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle
    def log_message(self, fmt, *args):
        sys.stderr.write("heartbeat-proxy: " + fmt % args + "\n")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18182
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
