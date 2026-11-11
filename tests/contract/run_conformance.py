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
    # Count what is actually probed. The loop used to `continue` past every
    # non-READY instance and every instance without a host port, so a deployment
    # whose instances were all UNHEALTHY or all port-less executed zero
    # assertions and the script exited 0 - a green run that tested nothing. The
    # final count is reported and must be at least one.
    probed = 0
    for instance in deployment["instances"]:
        if instance["state"] != "READY":
            continue
        port = instance.get("hostPort")
        if not port:
            continue
        probed += 1
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
    check(probed > 0,
          f"{plugin_id}: at least one READY instance with a host port was probed "
          f"(found {probed} of {len(deployment['instances'])})")
    print(f"  probed {plugin_id}@{active} on {probed} of {len(deployment['instances'])} instance(s)")

for plugin in ["dev.opsweave.hello", "dev.opsweave.hello-go", "dev.opsweave.hello-java"]:
    probe(plugin)

# Gateway identity header is host-owned; a forged header must not survive.
# A just-activated replacement replica can be observed READY a fraction before
# the Node proxy accepts traffic; retry the idempotent probe briefly.
import time

status, echo = 0, {}
for attempt in range(6):
    status, echo = request(
        "/api/v1/gateway/dev.opsweave.hello/api/hello/echo",
        "POST",
        {"probe": True},
        {"X-OpsWeave-User-Role": "forged-superadmin", "X-OpsWeave-User-Id": "forged"},
    )
    if status == 200:
        break
    time.sleep(1)
check(status == 200, "gateway TS echo 200")
# B2.1: the unsigned role header is never forwarded. The client forged
# "forged-superadmin"; the plugin must see no role header at all, and the
# identity it may act on is the Kernel-signed owu1 context below.
check(echo.get("deliveredUnsignedRole") is None, "gateway strips the unsigned caller role header")
check(echo.get("deliveredSignedContext") is True, "gateway delivers a Kernel-signed user context")

print(f"\nRuntime conformance: {len(failures)} failure(s)")
# --- self-check: the zero-instance path must FAIL ---------------------------
#
# The probe loop used to `continue` past every non-READY instance and every
# instance without a host port, so a deployment whose instances were all
# UNHEALTHY executed zero assertions and the script exited 0 - a green run that
# tested nothing. It now counts what it probes and fails when that is zero.
#
# This self-check proves the predicate is real, without needing a platform:
# it evaluates the same filter over a synthetic deployment and requires the
# result to be zero, and it requires probe() to contain the assertion that
# turns that zero into a failure.
def _probeable(instances):
    n = 0
    for instance in instances:
        if instance["state"] != "READY":
            continue
        if not instance.get("hostPort"):
            continue
        n += 1
    return n

_zero_cases = [
    ("no instances at all", []),
    ("all unhealthy", [{"state": "UNHEALTHY", "hostPort": 1}]),
    ("ready without a host port", [{"state": "READY"}]),
    ("mixed, none probeable", [{"state": "UNHEALTHY", "hostPort": 1}, {"state": "READY"}]),
]
for label, instances in _zero_cases:
    if _probeable(instances) != 0:
        print(f"self-check broken: {label} produced a probeable instance")
        sys.exit(1)

# And probe() must still turn a zero count into a recorded failure. A substring
# search is not enough: the first version searched for "check(probed > 0" and
# that text also appears in this comment, so deleting the assertion still left
# the self-check green. Parse the function and look for a comparison against
# probed instead.
import ast as _ast

_tree = _ast.parse(open(__file__).read())
_probe_fn = next((n for n in _ast.walk(_tree)
                  if isinstance(n, _ast.FunctionDef) and n.name == "probe"), None)
if _probe_fn is None:
    print("self-check broken: probe() is gone")
    sys.exit(1)
# A comparison that mentions `probed`, not merely a reference to it: the loop
# itself increments the counter, so a bare Name node proves nothing.
_compares_probed = any(
    isinstance(node, _ast.Compare)
    and any(isinstance(side, _ast.Name) and side.id == "probed"
            for side in [node.left, *node.comparators])
    for node in _ast.walk(_probe_fn)
)
if not _compares_probed:
    print("self-check broken: probe() no longer compares the probed count, so a "
          "zero-instance deployment would pass silently again")
    sys.exit(1)
print("self-check: a deployment with no probeable instance cannot pass silently")

sys.exit(1 if failures else 0)
