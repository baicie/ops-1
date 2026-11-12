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

def probeable_instances(instances):
    """The instances this run can actually reach.

    Named and separate so it can be driven with synthetic input: the zero-case
    test below calls the real probe() against these shapes rather than inspecting
    source text, because an assertion that only exists in the AST is not an
    assertion that fires.
    """
    return [i for i in instances if i.get("state") == "READY" and i.get("hostPort")]

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
    probeable = probeable_instances(deployment["instances"])
    probed = 0
    for instance in probeable:
        probed += 1
        base = f"http://127.0.0.1:{instance['hostPort']}"
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
# --- zero-instance behaviour test -------------------------------------------
#
# The probe loop used to skip every non-READY instance and every instance without
# a host port, then report the total count as though it had probed them. A
# deployment whose instances were all UNHEALTHY ran zero assertions and the
# script exited 0.
#
# This drives the REAL probe function against synthetic plugin details and
# asserts on the failures it records, not on the shape of the source. An earlier
# version inspected the AST and was satisfied by a comparison that the code no
# longer performed at the point that mattered.
def _run_probe_on(detail, status=200):
    """Call probe() with request() stubbed to return `detail`."""
    global request, failures
    saved_request, saved_failures = request, failures
    failures = []
    request = lambda path, method="GET", body=None, extra=None: (status, detail)
    try:
        probe("dev.opsweave.selfcheck")
        return list(failures)
    finally:
        request, failures = saved_request, saved_failures

_manifest = {"provides": [{"name": "x", "major": 1}], "resources": {}}

def _detail(instances):
    return {
        "manifest": _manifest,
        "packageVersions": ["0.0.1"],
        "activeVersion": "0.0.1",
        "deployments": [{"version": "0.0.1", "instances": instances}],
    }

_cases = [
    ("no instances", []),
    ("all unhealthy", [{"state": "UNHEALTHY", "hostPort": 1}]),
    ("ready without a host port", [{"state": "READY"}]),
    ("mixed, none probeable", [{"state": "UNHEALTHY", "hostPort": 1}, {"state": "READY"}]),
    ("stopped with a port", [{"state": "STOPPED", "hostPort": 1}]),
]
for label, instances in _cases:
    got = _run_probe_on(_detail(instances))
    if not got:
        print(f"self-check broken: {label!r} produced no failure; a deployment that "
              f"cannot be probed must fail")
        sys.exit(1)
    # Two gates can stop a probeable instance from existing, and both are
    # legitimate: probe() fails early with "no active instance" when the
    # deployment has none, and later with "at least one READY instance" when it
    # has some but none are reachable. Either is a failure; silence is not.
    if not any(("at least one READY instance" in f) or ("no active instance" in f)
               for f in got):
        print(f"self-check broken: {label!r} failed for another reason: {got[:2]}")
        sys.exit(1)

# And the control: a probeable instance must NOT trip the zero-instance failure.
# Without this, the assertions above would pass if probe() failed unconditionally.
#
# The loopback port is closed, so the runtime probes will fail - that is fine and
# expected here. What is asserted is only that the zero-instance complaint is
# absent, which is what distinguishes "found nothing to probe" from "probed and
# the probe failed".
_control = _run_probe_on(_detail([{"state": "READY", "hostPort": 9}]))
if any("at least one READY instance" in f for f in _control):
    print("self-check broken: a probeable instance still tripped the zero-instance "
          "failure, so that failure does not distinguish the two cases")
    sys.exit(1)

# A plugin detail that is not 200 must produce a failure rather than silence.
_api_case = _run_probe_on({}, status=500)
if not _api_case:
    print("self-check broken: a non-200 plugin detail produced no failure")
    sys.exit(1)

print(f"self-check: {len(_cases)} unprobeable shapes each fail; a probeable one does not")

sys.exit(1 if failures else 0)
