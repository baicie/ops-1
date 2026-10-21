#!/usr/bin/env python3
"""Runtime v1 conformance probes executed with an existing opsctl session."""
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18181"
session = json.loads((pathlib.Path.home() / ".opsweave/session.json").read_text())
TOKEN = session["token"]

def request(path, method="GET", body=None, extra=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (extra or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except Exception:
            payload = {}
        return error.code, payload

failures = []
def check(condition, message):
    print(("PASS  " if condition else "FAIL  ") + message)
    if not condition:
        failures.append(message)

def canonical_provides(provides):
    return json.dumps(provides, sort_keys=True, separators=(",", ":")).encode()

def probe(plugin_id):
    status, detail = request(f"/api/v1/plugins/{plugin_id}")
    if status != 200:
        check(False, f"{plugin_id}: plugin detail {status}")
        return
    manifest = detail["manifest"]
    packages = detail["packageVersions"]
    active = detail["activeVersion"]
    deployment = next((d for d in detail["deployments"] if d["version"] == active), None)
    if not deployment or not deployment["instances"]:
        check(False, f"{plugin_id}: no active instance")
        return
    for instance in deployment["instances"]:
        if instance["state"] != "READY":
            continue
        port = instance.get("hostPort")
        if not port:
            continue
        base = f"http://127.0.0.1:{port}"
        def local(path, method="GET", body=None):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(base + path, data=data, method=method)
            if body is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, json.loads(response.read() or b"{}")
            except urllib.error.HTTPError as error:
                return error.code, {}
        info_status, info = local("/_opsweave/runtime/v1/info")
        check(info_status == 200, f"{plugin_id}: runtime info 200")
        check(info.get("pluginId") == plugin_id, f"{plugin_id}: runtime identity matches")
        check(info.get("version") == active, f"{plugin_id}: runtime version matches active")
        check(info.get("runtimeProtocol") == "http-json-v1", f"{plugin_id}: runtime protocol v1")
        expected = "sha256:" + hashlib.sha256(canonical_provides(manifest["provides"])).hexdigest()
        check(info.get("capabilityDigest") == expected, f"{plugin_id}: capability digest matches signed provides")
        check(info.get("buildDigest", "").startswith("sha256:"), f"{plugin_id}: build digest is a sha256")
        live_status, _ = local("/_opsweave/health/live")
        ready_status, _ = local("/_opsweave/health/ready")
        check(live_status == 200, f"{plugin_id}: liveness 200")
        check(ready_status == 200, f"{plugin_id}: readiness 200")
        unknown_status, _ = local("/api/does-not-exist")
        check(unknown_status == 404, f"{plugin_id}: unknown path 404")
    print(f"  probed {plugin_id}@{active} on {len(deployment['instances'])} instance(s)")

for plugin in ["dev.opsweave.hello", "dev.opsweave.hello-go", "dev.opsweave.hello-java"]:
    probe(plugin)

# Gateway identity header is host-owned; a forged header must not survive.
status, echo = request(
    "/api/v1/gateway/dev.opsweave.hello/api/hello/echo",
    "POST",
    {"probe": True},
    {"X-OpsWeave-User-Role": "forged-superadmin", "X-OpsWeave-User-Id": "forged"},
)
check(status == 200, "gateway TS echo 200")
check(echo.get("serverVerifiedCallerRole") == "admin", "gateway overwrites forged caller role")

print(f"\nRuntime conformance: {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
