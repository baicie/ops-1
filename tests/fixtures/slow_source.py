#!/usr/bin/env python3
"""Deterministic slow source fixture: accepts, waits, then returns valid JSON."""
import sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 25)
        body = b'[{"id":"slow-1","name":"slow"}]'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        sys.stderr.write("slow-source: " + fmt % args + "\n")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18091
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
