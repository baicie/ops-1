#!/usr/bin/env python3
"""DEMO fixture for the OpsWeave staging product walkthrough.

Serves a static JSON payload on the docker bridge gateway so plugin containers can read it.
Bound to 172.17.0.1 only: not reachable from the internet, and not a production endpoint.
"""
import http.server, os, socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST, PORT = "172.17.0.1", 18099

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    def log_message(self, fmt, *args):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer((HOST, PORT), Handler) as httpd:
    httpd.serve_forever()
