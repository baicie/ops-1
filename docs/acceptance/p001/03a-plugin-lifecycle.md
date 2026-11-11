# P001-C1 — TypeScript Plugin Golden Path

Status: **PARTIAL, improved.** The lifecycle ran end to end against a real Node,
real containers and a real OCI registry. **D1 (`rollback` did not roll back on
its first call) was found, fixed and re-measured — §3.4.** One defect remains
open: **D4, frontend assets are still served after uninstall** (§4), which is a
stale-content exposure rather than the production-significant defect D1 was.

| Fact | Value |
|---|---|
| Code under test | `1ad7589` (C0 baseline) + the changes in this branch |
| Host | macOS 15.7 / arm64, Docker Desktop 29.7.2 |
| Kernel | `0.0.1`, `http://127.0.0.1:18281`, database `p001c` |
| Nodes | 2 (`node-a` :9201, `node-b` :9202), both `READY` |
| Registry | `localhost:5001`, `registry:2` |
| Publisher | `trusted-team`, Ed25519, key `keys/publisher.key` |
| Plugin | `dev.opsweave.hello` TypeScript/Node 22 full-stack |

---

## 0. Why this is an isolated environment, and why that was necessary

`scripts/demo_up.sh` **cannot be run on this checkout**. It hard-codes
`OPSWEAVE_DATA_DIR="$ROOT/data"` (`demo_up.sh:60`) and defaults `RESET=1`, which
runs `dropdb --force opsweave` and `rm -rf data` (`demo_up.sh:34-39`).

This checkout has:

```
data/packages/{dev.opsweave.hello, dev.opsweave.hello-go, dev.opsweave.hello-java}
data/node-a/node-identity.json, data/node-b/node-identity.json
opsweave.kernel.plugin_packages: 4 rows
```

So running the documented demo script would have destroyed installed plugin data
— the exact thing the task forbids. A backup was taken first
(`/tmp/p001c-preserve/`), and `tests/ci/p001c_up.sh` was written to start the
platform under `/tmp/p001c` with database `p001c`. **`./data` and the `opsweave`
database were never touched.**

This is itself a finding: **`OPSWEAVE_DATA_DIR` is not configurable in
`demo_up.sh`**, so the documented local path is unusable on any host that already
has state. Recorded as D3.

---

## 1. Build → OCI Push → Digest Resolve → Bundle Sign

### 1.1 A blocking defect was found and fixed first

`scripts/build-plugins.sh` aborted on **every** machine with a cached JRE:

```
./scripts/build-plugins.sh: line 167: JRE_SOURCE: unbound variable
```

`JRE_SOURCE=""` was assigned **inside** `if [ ! -x plugins/hello-java/jre/bin/java ]`.
When the JRE was already present the block was skipped, the variable was never
set, and the two later `($JRE_SOURCE)` log lines killed the script under `set -u`.

The cost is the point: **all three images had already been built and exported**.
The failure landed after the expensive work, so **no bundle was signed at all** —
the four `.zip` files stayed at their 2026-10-22 mtimes.

Fixed by declaring `JRE_SOURCE="cached"` before the branch. Verified by re-running
to completion: four bundles rewritten, `JRE_SOURCE` printing `(cached)`.

An earlier attempt to diagnose this was itself wrong: the first run was piped into
`tail`, so the exit status seen was `tail`'s. Re-run with redirection to a file to
get the real status.

### 1.2 Real image digests

```
hello-ts:0.0.1  localhost:5001/opsweave/hello-ts@sha256:160bd87af78d0c62bd34d62c3d088a8097b60b6b05a99f6cd810e8e6b16a996d
hello-ts:0.0.2  localhost:5001/opsweave/hello-ts@sha256:c89fe547d5254a8afcb41e381355a178ff7af3f790a11171093f7ddc2bdf1975
hello-go:0.0.1  localhost:5001/opsweave/hello-go@sha256:c8aa634bfa3a6b827709a26792bbcc2f2e48c52f8246a2b35e33150cd10968aa
hello-java:0.0.1 localhost:5001/opsweave/hello-java@sha256:1af2589a9d15e84869c12a78739468ce3dfce5879cf3510daa5698d8eb3f9c49
```

**These differ from every digest recorded in `docs/acceptance/EVIDENCE.md`.**
For example `hello-ts` v1 was `sha256:6da03a97…` there; it is `sha256:160bd87a…`
here, built from a different tree. This is the concrete proof behind C0's finding
that the old evidence does not describe the current code.

The registry was also found **empty**: the Docker volume behind
`opsweave-registry` contained no repositories, so the images that
`EVIDENCE.md` pins were simply gone.

### 1.3 Bundle signing

| Bundle | artifactDigest | Signed |
|---|---|---|
| `hello-ops-0.0.1` | `sha256:84e6ff6853e999326…` | yes |
| `hello-ops-0.0.2` | `sha256:b17f7d956c3fac616…` | yes |
| `hello-go-0.0.1` | `sha256:4f53cda18c2baa0c0…` | yes |
| `hello-java-0.0.1` | `sha256:4f53cda18c2baa0c0…` | yes |

`backend.imageRef` is digest-pinned in every manifest. Note `hello-go` and
`hello-java` share an `artifactDigest` — both bundles contain only a manifest and
a signature, no frontend assets, so the payload index is identical. That is
correct, and it is also why an artifactDigest alone does not identify a plugin.

### 1.4 Capability digest is a hard-coded constant, not derived

`build-plugins.sh:17-19` declares `TS_CAP`, `GO_CAP`, `JAVA_CAP` as literals and
passes them into the image build. Verified they are *correct* today:

```
sha256(canonical(provides, sort_keys=True, separators=(",",":")))
  = sha256:16720c5f7a1cac3268d2cd20b72be3f0b4306734a6a087088e30ce2d8e96cf17
  = TS_CAP   -> MATCH
```

(The first check said MISMATCH; that was my error — I omitted `sort_keys=True`.
Recorded because the same mistake would be easy to repeat.)

The risk stands: change a manifest's `provides` without editing the constant and
the image advertises a stale digest, which `verify_runtime_info` will then reject
at container start. **D2.**

---

## 2. Lifecycle, executed

Every step below was run against the live platform. `opsctl` at
`http://127.0.0.1:18281`.

| Step | Command | Result |
|---|---|---|
| Install v1 | `opsctl install hello-ops-0.0.1.plugin.zip` | `staged … bundle=sha256:f901f5e9…` |
| Install v2 | `opsctl install hello-ops-0.0.2.plugin.zip` | `staged … bundle=sha256:ad2a160f…` |
| Deploy v1 | `opsctl deploy … 0.0.1 --replicas 2 --wait` | `READY 2/2`, via `PENDING → PREPARING → READY` |
| Activate v1 | `opsctl activate … 0.0.1` | `revision=1 status=ACTIVE` |
| Gateway v1 | `GET /api/v1/gateway/dev.opsweave.hello/api/hello` | **200**, real container |
| Deploy v2 | `opsctl deploy … 0.0.2 --replicas 2 --wait` | `READY 2/2` |
| Gateway during v2 deploy | polled every second for 11 s | **stayed `0.0.1` throughout** |
| Gateway after v2 READY, before activate | 3 polls | still `0.0.1` |
| Activate v2 | `opsctl activate … 0.0.2` | `revision=2 status=ACTIVE` |
| Gateway after activate | 3 polls | **`0.0.2`** |
| Disable | `opsctl disable … --reason` | gateway **503** `CAPABILITY_UNAVAILABLE` |
| Enable + deploy + activate | | gateway **200** |
| Rollback | `opsctl rollback … 0.0.1` | **see §3 — did not roll back** |
| Uninstall | `opsctl uninstall dev.opsweave.hello` | `dataRetained: true` |

### 2.1 The gateway response is from a real container

```json
{"pluginId":"dev.opsweave.hello","version":"0.0.1","message":"Hello from OpsWeave 0.0.1",
 "instanceId":"79201e30-079a-480c-86a0-7132f498a4d6", …
 "runtime":{"language":"TypeScript / Node.js","node":"v22.23.4","pid":6,"uptimeSeconds":46}}
```

`pid: 6` inside the container, `node v22.23.4`, a real `instanceId` that matches
`kernel.plugin_instances`. This is not a stub.

### 2.2 The route does not switch before activation — proved, not asserted

This is the C1 requirement "a new version must not take over the effective route
before it is READY". The run shows something stronger, and worth stating exactly:

- while v2 was `PREPARING`, the gateway served `0.0.1` on all 11 polls;
- **after v2 reached `READY 2/2`, the gateway still served `0.0.1`.**

So readiness alone does not move traffic — activation does, and only activation.
The `activate_inner` transaction flips the revision and the gateway reads
`activation_revisions.status='ACTIVE'` live, which is why the switch appears
immediately and completely (3/3 polls at `0.0.2`, no mixed window observed).

### 2.3 Uninstall retains data

```
before: kernel.plugin_packages=2 for this plugin, plugin_installations=1
after : kernel.plugin_packages=2 for this plugin, plugin_installations=1
response: {"ok": true, "dataRetained": true}
```

Gateway after uninstall: `503 CAPABILITY_UNAVAILABLE`. Correct.

---

## 3. Defect D1 — `rollback` did not roll back on its first call (FIXED)

> **Status: fixed and verified.** The defect is described first because the
> description is the evidence; §3.4 is the fix and the measurement after it.

`opsctl rollback dev.opsweave.hello 0.0.1 --replicas 2` returned success-shaped
JSON — `"statusReason": "Redeploy requested"` — and the gateway kept serving
**`0.0.2`** on all three polls.

Database state right after that call:

```
version | status | ready replicas
0.0.1   | READY  | 2
0.0.2   | ACTIVE | 2
activation_revisions: 0.0.1 gen1 SUPERSEDED, 0.0.2 gen2 DISABLED, 0.0.2 gen3 ACTIVE
```

So v1 was redeployed to `READY` and **never activated**. `activeVersion` stayed
`0.0.2`.

### 3.1 Root cause

`apps/kernel/src/deployments.rs:898-954`:

```rust
let Some(target) = target else { … create_deployment_inner(…) };   // no deployment
if target.status == "READY" {
    activate_inner(…)                                              // the only activate path
} else if matches!(target.status.as_str(), "PENDING" | "PREPARING") {
    return 202                                                     // accepted, does nothing
} else {
    create_deployment_inner(…)                                     // ACTIVE/DISABLED/DRAINING
}
```

After an upgrade the previous deployment is `DRAINING`, then `DISABLED`. A
rollback to that version therefore takes the **last** branch, which only asks for
a redeploy. The caller has to run `rollback` a second time, by which point
`target.status == "READY"` and the first branch finally activates.

### 3.2 Confirmed by prediction

The second `rollback` call, with v1 now `READY`, returned
`"activatedAt": "2026-11-11T10:20:37.984096Z"` and the gateway served `0.0.1` on
both polls. That matches the mechanism exactly — the first call was not "slow",
it was a different code path.

### 3.3 Why this matters beyond one command

An operator who runs `rollback` during an incident, sees a `200` with a plausible
body, and walks away has **not rolled back**. The audit trail does not record the
rollback either (C0 finding A11: no `audit::record` in this handler), so there is
no later signal that it did nothing.

### 3.4 The fix, and the measurement after it

Two halves, because either alone leaves the trap open.

**Kernel** (`deployments.rs`, the redeploy branch): the response now carries

```json
{ "rollbackActivated": false,
  "pendingActivation": true,
  "nextStep": "wait for the deployment to reach READY, then POST /activations with expectedRevision to switch the route" }
```

The handler still cannot activate what it has just asked to be rebuilt — the
redeploy is asynchronous — so it says so instead of returning the redeploy body
unchanged.

**`opsctl rollback`**: reads `pendingActivation`, waits for `READY` via the same
`wait_for_ready` that `deploy --wait` uses, then issues the activation itself.

**Measured on the fixed build, one call, no manual second step:**

```
=== BEFORE: 0.0.2 ===
  rollbackActivated: false
  pendingActivation: true
  nextStep: "wait for the deployment to reach READY, then POST /activations …"
  waiting for 0.0.1 to become READY …
  activated dev.opsweave.hello@0.0.1 revision=3 status=ACTIVE
=== AFTER: 0.0.1 ===
```

**Regression:** `cargo test -p opsweave-kernel` → **281 passed, 0 failed**.

**Guard:** `tests/ci/p001c_rollback_activates.sh`, 11 checks, wired into the
`platform-only` job. It was verified to **fail** by reverting both halves to
their original shape — 5 failures, exit 1 — and to pass again when restored. Its
own inputs are asserted present, so a rename cannot turn the assertions vacuous.

**Not fixed, and recorded:** `rollback` still writes no audit entry (A11) and
still has no idempotency receipt. Those are separate from D1 and remain open.

---

## 4. Defect D4 — assets are served after uninstall (confirms C0's F2)

C0 reported F2 from reading `assets.rs`. It is now **observed**:

```
GET /assets/trusted-team/dev.opsweave.hello/0.0.2/frontend/remoteEntry.js
  -> HTTP 200, 7,708 bytes, real JavaScript
  ... AFTER `opsctl uninstall dev.opsweave.hello` returned dataRetained:true
```

`assets::serve_asset` filters on `p.status <> 'REJECTED'` and publisher trust
only (`apps/kernel/src/assets.rs:21-33`). There is no installation-state or
active-revision predicate, so an uninstalled plugin's frontend bundle stays
downloadable indefinitely.

Severity is bounded — the backend is stopped, so this is stale-content exposure,
not code execution. But it contradicts "uninstalled", and the `Cache-Control:
public, max-age=31536000, immutable` header means a browser that already fetched
it will keep it for a year.

---

## 5. Defect D3 — `demo_up.sh` cannot run on a host with existing data

`OPSWEAVE_DATA_DIR` is hard-coded to `$ROOT/data` and `RESET` defaults to `1`,
which drops the database and deletes the directory. There is no supported way to
run the documented local demo beside an existing install. This is why
`tests/ci/p001c_up.sh` exists.

Not fixed here — changing `demo_up.sh` default behaviour is a separate decision
and C1's scope is the plugin path.

---

## 6. What is NOT verified

| Claim | Status |
|---|---|
| Frontend asset index served to a browser | **NOT_RUN** — the manifest's frontend assets were fetched by URL, but no browser loaded the plugin UI |
| Capability provides/requires at runtime | **NOT_RUN** — `dev.opsweave.hello` declares `provides: sample.hello.v1` but nothing consumed it in this run; that is C2 |
| Grant / revoke | **NOT_RUN** — C2 |
| Upgrade to an incompatible version | **NOT_RUN** — C2 case 10 |
| OCI image signature | **NOT_RUN, and cannot be** — not implemented (C0 M1) |
| Three-host / rootless | **NOT_RUN** — P001-E |
| Java and Go lifecycles | **NOT_RUN here** — their images build and are pushed, but this run exercised only TypeScript. C3. |

---

## 7. Position

The TypeScript golden path **runs**: build, push, digest-pin, sign, upload,
verify, stage, deploy, ready, activate, gateway call, disable, enable, rollback,
uninstall — all against real containers, with the route-switch behaviour proved
by polling rather than asserted.

Defects, by outcome:

| # | Defect | Outcome |
|---|---|---|
| **D0** | `build-plugins.sh` aborted on any host with a cached JRE; no bundle was ever signed | **fixed** |
| **D1** | `rollback` returned 200 without switching the route; the first call never worked | **fixed and re-measured** (§3.4) |
| **D3** | `demo_up.sh` cannot run beside existing data — it drops the database and deletes `data/` | **recorded, not fixed** (scope) |
| **D4** | frontend assets stay served after uninstall | **open** — C1 stays PARTIAL on this |
| **D5** | `p001c_up.sh` did not reset node identities with the database, so a second run stalled in quarantine | **fixed** (`#86`) |

C1 → **PARTIAL (lifecycle and rollback verified; D4 open; browser, capability
provides/requires, grants, incompatible upgrade, and Java/Go lifecycles not yet
exercised — C2/C3/C4).**

D4 is not a reason to distrust the lifecycle: it is stale content served after
the backend is stopped, not code execution, and §4 records it precisely. But a
plugin reported `UNINSTALLED` whose frontend still returns `200` is a
contradiction in the platform's own state, and it stays open until fixed.
