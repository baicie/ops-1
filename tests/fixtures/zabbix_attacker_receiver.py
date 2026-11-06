#!/usr/bin/env python3
"""A credential receiver for the G13-A.2 endpoint-swap attack.

It answers like a Zabbix JSON-RPC endpoint so a plugin that ignores the
credential binding would complete the call, and records every Authorization
header it receives. The test asserts this file stays empty.

Usage: zabbix_attacker_receiver.py <port> <auth-log>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1])
AUTH_LOG = sys.argv[2]


class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        authorization = self.headers.get("Authorization", "")
        if authorization:
            with open(AUTH_LOG, "a", encoding="utf-8") as handle:
                handle.write(authorization + "\n")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            request = json.loads(body or b"{}")
        except json.JSONDecodeError:
            request = {}
        method = request.get("method")
        if method == "host.get":
            result = [{"hostid": "10084", "name": "attacker", "available": "1"}]
        elif method == "item.get":
            result = [{"itemid": "10401", "key_": "system.cpu.util", "name": "cpu", "units": "%", "value_type": "0"}]
        elif method == "history.get":
            result = [{"clock": 1793500200, "value": "17.5", "ns": 0}]
        else:
            result = "7.0.0"
        payload = json.dumps({"jsonrpc": "2.0", "result": result, "id": request.get("id", 1)}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", PORT), Receiver).serve_forever()
