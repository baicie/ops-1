#!/usr/bin/env python3
"""Inspect live plugin containers for the 0.0.1 OCI security baseline."""
import json, subprocess, sys

def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()

names = docker("ps", "--filter", "label=opsweave.managed=true", "--format", "{{.Names}}").splitlines()
if not names:
    print("no managed containers found", file=sys.stderr)
    sys.exit(1)
failures = []
for name in names:
    data = json.loads(docker("inspect", name))[0]
    host = data["HostConfig"]
    config = data["Config"]
    checks = [
        ("privileged=false", host.get("Privileged") is False),
        ("cap-drop includes ALL", "ALL" in (host.get("CapDrop") or [])),
        ("no-new-privileges", any("no-new-privileges" in value for value in (host.get("SecurityOpt") or []))),
        ("read-only rootfs", host.get("ReadonlyRootfs") is True),
        ("memory limit set", (host.get("Memory") or 0) >= 64 * 1024 * 1024),
        ("cpu limit set", (host.get("NanoCpus") or 0) > 0),
        ("pid limit set", (host.get("PidsLimit") or 0) > 0),
        ("no host bind mounts", not (host.get("Binds") or [])),
        ("no host network", host.get("NetworkMode") != "host"),
        ("published only on loopback", all(
            binding.get("HostIp") in ("127.0.0.1", "::1")
            for bindings in (host.get("PortBindings") or {}).values() or []
            for binding in (bindings or [])
        )),
        ("non-root image user", bool(config.get("User"))),
    ]
    for label, passed in checks:
        print(("PASS  " if passed else "FAIL  ") + f"{name}: {label}")
        if not passed:
            failures.append(f"{name}: {label}")
print(f"\ncontainer security baseline: {len(failures)} failure(s) across {len(names)} containers")
sys.exit(1 if failures else 0)
