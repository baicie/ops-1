#!/usr/bin/env python3
"""Forward worker traffic to Kernel, but return 503 for the armed Job's heartbeat."""
import http.client, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = ("127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 18181)
FLAG = sys.argv[3] if len(sys.argv) > 3 else "/tmp/heartbeat-fault-job"

class Handler(BaseHTTPRequestHandler):
    def _handle(self):
        length = int(self.headers.get("content-length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        job = None
        try:
            job = open(FLAG).read().strip()
        except OSError:
            pass
        if job and "/heartbeat" in self.path and job in self.path:
            print(f"{time.time():.6f} heartbeat job={job} -> 503", flush=True)
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "connection"}}
        conn = http.client.HTTPConnection(*UPSTREAM, timeout=20)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            payload = response.read()
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() in {"connection", "transfer-encoding", "content-length"}:
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            print(f"{time.time():.6f} proxy error path={self.path} error={error}", flush=True)
            try:
                self.send_response(502); self.send_header("Content-Length","0"); self.end_headers()
            except Exception:
                pass
        finally:
            conn.close()
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle
    def log_message(self, fmt, *args):
        sys.stderr.write("heartbeat-proxy: " + fmt % args + "\n")

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18182), Handler).serve_forever()
