# Phase 8D TASK-39: staging, in its current state

**No staging operation was performed to produce this document.** Every value below
was read from a `staging-preview` run's own uploaded artifact — the host status
JSON that the failed run collects with `if: always()`. No SSH, no query, no deploy,
no row deleted, and nothing was re-triggered.

## What staging is serving right now

From run **45593146217** (the `main` push run for `aedc7680`, 2026-11-25T10:15Z):

```json
"current": {
  "sha": "aedc7680f878c529262aed0497814fae9591ffee",
  "image": "ghcr.io/baicie/opsweave:aedc7680f878c529262aed0497814fae9591ffee",
  "digest": "sha256:a1d3fa7b25ca04d042432ab60377d10e92572d5baa7cb524272b99442d05c3c7",
  "deployed_at": "2026-11-25T10:17:36Z",
  "healthy": true,
  "rolled_back": false
}
"health": { "livez": "pass", "readyz": "pass", "root": "pass" }
"served_commit": { "sha": "aedc7680…", "state": "observed" }
"services": postgres running, registry running, kernel running, node running
```

So the **Kernel and Node are current and healthy** — the deploy half of that job
succeeded. The job is red for the plugin half only.

## The exact failure in that run

Same run, same job, later step:

```
PENDING 0/0 ready (… [INSTANCE_CAPACITY_EXCEEDED] node staging-node:
4 instances already scheduled on this node against a per-node limit of 4 …)
Error: timed out waiting for deployment readiness
```

This is the defect TASK-30 audited and TASK-32/#222 fixed. **The fix is merged and
not deployed**, so the condition is unchanged on the host.

## The four rows, and what the merged rule would do

| occupant | same plugin's other versions | released by #222's rule? |
|---|---|---|
| `dev.opsweave.hello@0.0.1` | none | **no** — its plugin's only version |
| `opsweave.data-catalog@0.0.2` | `0.0.3590`, `0.0.65450` | **yes** — superseded, not ACTIVE |
| `opsweave.data-catalog@0.0.3590` | `0.0.65450` | **yes** |
| `opsweave.data-integration@0.0.2` | none | **no** — its plugin's only version |

**Two of four.** The two it cannot release are not "stuck"; they are each the only
version of their plugin, and whether they are `ACTIVE` and serving traffic needs the
staging database. This session has no access to it and does not guess.

## What TASK-39 requires, and what is blocked

The brief's acceptance list needs, in order:

1. active revision before the deploy — **needs the staging DB** (`BLOCKED_ENV`)
2. actual resource occupancy before — **partly available**: the error names the four
   occupants and the limit; the per-row status is in the DB
3. the target plugin's artifact identity — **available** (`publish-data-plugins.sh`
   prints the digest, and the 8A tools now check it)
4. the scheduling of the new version — **available from a deploy run**
5. the READY target instance identity — needs the deploy to get past capacity
6. activation — needs 5
7. Gateway read-back — needs 6
8. whether the old instance was released per contract — **this is what #222 changes,
   and it is unverified until deployed**
9. whether the old artifact is still retained — `plugin_packages` history, needs DB
10. a real business request — needs 4
11. rollback availability — needs the full path
12. an evidence artifact — the index (#221) now produces one per `ci.yml` run

So the acceptance is **gated on one thing**: releasing the two reclaimable rows,
which requires a deploy running #222's code. That deploy is a real staging
mutation and is **not authorised in this session**.

## The read-only path that exists

`staging-preview.yml` has a `verify_only=true` dispatch that:

- certifies **whatever staging already serves**, by the sha the host reports;
- **mutates nothing** — the deploy step, the image build and the plugin publish are
  all guarded by `if: ${{ inputs.verify_only != true }}` (`staging-preview.yml:261`,
  `:427`, `:633-640`, `:660`);
- needs the served sha, which is `aedc7680f878c529262aed0497814fae9591ffee`.

That dispatch would produce a real acceptance record of the currently-deployed
build — the checks in items 3, 7 (read-back of what is live), 10 and 12 — without
touching the host. **It was not run, because even a read-only certification against
a real staging host is an outward-facing action on an environment the brief says to
leave alone without explicit approval.** It is recorded here as the next step that
is ready and cheap, not as something done.

## Honest summary

| claim | status |
|---|---|
| staging Kernel/Node at `aedc7680`, healthy | **verified**, from the host's own status JSON |
| plugin publish fails on capacity | **verified**, same artifact |
| the four occupants are the ones the brief names | **verified**, named in the error |
| #222 releases two of them | **reasoned from the rule + the occupant list**, not observed |
| the fix resolves staging | **not verified and not claimed** — it is not deployed |
| a real acceptance run | **not performed**; `BLOCKED_ENV` / no approval |

---

# TASK-39, executed: the fix was deployed and did not take effect

**This section replaces the "not performed" above. A real staging deploy was
authorised and run on 2026-11-25, and it measured the opposite of what the
reasoning predicted.** The earlier sections are left as they were written, because
what they got wrong is the point.

## What ran

`staging-preview` run **45608152539**, `push` on `a1f468ff`, 11:50Z–12:00Z. The
dispatch attempt before it (45607268815, for `079f8fce`) was **cancelled by this
run** through the shared `staging-preview-deploy` concurrency group — my ordering
error, stated plainly at the time: the deploy should have been triggered after the
merge, not before.

`a1f468ff` contains both `newer.created_at > d.created_at` and the
`RELEASE A SUPERSEDED CANDIDATE` statement, so the push-driven run is an equally
valid deploy of the same fix.

## What the host actually reports

`host-status.json`, from the run's own `staging-deploy` artifact, `11:59:57Z`:

```json
"current": {"sha": "a1f468ff57a12cdbdf396373f7f9b6ff74826f4e",
            "digest": "sha256:36f3feb046921332c384ceae77e708d0e19da8d604383adc2d52e6080344057d",
            "deployed_at": "2026-11-25T11:54:29Z", "healthy": true, "rolled_back": false}
"health": {"livez": "pass", "readyz": "pass", "root": "pass"}
"served_commit": {"sha": "a1f468ff…", "state": "observed"}
"services": postgres running, registry running, kernel running, node running
```

Steps 1–10 of the deploy job were **success**. The kernel and node were replaced
with the build that contains the fix, and they are healthy.

## What the publish step then did

Step 13, `Publish the data plugin bundles`, ran **11:54:35 → 11:59:53** — five
minutes on a kernel that had been up for six seconds. For the whole window the
same line repeated:

```
PENDING 0/0 ready (No eligible healthy node matches the placement selector
[INSTANCE_CAPACITY_EXCEEDED] node staging-node: 4 instances already scheduled on
this node against a per-node limit of 4; occupied by dev.opsweave.hello@0.0.1,
opsweave.data-catalog@0.0.2, opsweave.data-catalog@0.0.3590,
opsweave.data-integration@0.0.2)
Error: timed out waiting for deployment readiness
```

**The four occupants are exactly the four from before the deploy.** Not one was
released.

| claim | status |
|---|---|
| the fix is running on staging | **verified** — `served_commit` is `a1f468ff`, digest measured |
| the fix releases the two rows | **DISPROVEN on this deploy** — both are still occupants |
| the four are "superseded, never activated" | **no longer supported** — see below |
| staging's plugin path now works | **no** |

## Why the earlier reasoning was wrong

The audit reasoned: two `data-catalog` rows are superseded by `0.0.65450`, so the
rule releases them. The rule matches on `d.status = 'READY'`. **The premise that
these rows are `READY` was never verified, and could not be from outside.**

Two things are certain from the code, and both narrow the failure:

1. **`capacity_occupants` only lists instances with `desired_action='START'`**
   (`deployments.rs:2685`). A deployment that could never place a slot has its
   rows written to `STOP` by the `missing` branch (`:2092`). So all four occupants
   **did place an instance at some point**.
2. **A version that already exists in `PENDING`/`PREPARING`/`READY` is returned
   untouched** — `create_deployment_inner` answers 202 and returns the existing
   view (`deployments.rs:352-356`) without inserting a row or advancing a state.
   So `data-catalog@0.0.65450` stays `PENDING` for as long as it is ever asked
   for, and every later publish of that version short-circuits the same way.

What this does **not** establish is which of the four rows the rule should have
matched. That needs their `status` and `created_at`, and **this session has no
path to them**: `opsctl capacity` returns exactly that, but it needs a session on
the host, and the host's port is not reachable from here.

> A note on how that limit was established, because the first answer was wrong.
> Probing `http://82.156.234.84:3000/livez` returns **502**, which looks like a
> dead staging host. It is not: `connect=0.0003s` and `Proxy-Connection: keep-alive`
> are the local proxy answering, and `--noproxy '*'` returns `000` — no connection
> at all. **The 502 is my machine, not staging.** Staging was measured healthy by
> its own status endpoint four minutes earlier, and that is the only evidence
> about it this session has.

## What this does not license

- **It is not "the fix is wrong."** The rule did not match; which clause failed is
  unknown. The honest statements are "deployed, no effect" and "the reason is not
  observable from here".
- **It is not "capacity should be raised."** The brief forbids it
  (「禁止仅通过提高 Staging 实例容量来掩盖插件生命周期问题」) and the deploy gives
  no evidence for it — 4/4 with four named occupants is the condition, not the
  cause.
- **No row was deleted, no limit changed, no cleanup was attempted.** The run's
  only writes were the ones a deploy makes.

## The next instrument, and it is a small one

The gap is that **no artifact carries deployment state**. `host-status.json` has
services and health; the occupants appear only inside an error string. A run
therefore cannot answer "which of these is READY, and since when" — which is the
single question this task turned on.

`opsctl capacity --json` already prints `status`, `replicas`, `active` and
`statusReason` per deployment, read-only. The deploy job does not call it. Wiring
that output into `staging-deploy` would make the next deploy self-explaining
instead of requiring another round of inference.

That is a follow-up, not a claim. **It is not in this phase's changes.**


---

# TASK-40: the rule had no tool, so it was a sentence

The brief's five TASK-40 requirements, and where each is enforced:

| requirement | enforced by |
|---|---|
| check the PR's exact head SHA | `ci-gate` queries check runs by commit |
| checks from the right producer and a valid attempt | `check-run-ledger.mjs` |
| never call it green while a required check is pending | `await-delegated.mjs` |
| PR green ≠ main green | **nothing, until now** |
| check what main actually ran after merging | **nothing, until now** |

The last two are the same gap. "PR 通过不等于 main 通过" was a sentence in a document
that someone had to remember, and this session did remember it and did it by hand
for `a1634d62`, `a7d6cd65` and `aedc7680`. Doing it by hand three times is how the
gap became visible.

## The tool

`tests/ci/verify-main.mjs` answers one question: did every workflow that runs on a
**push to main** complete successfully for this commit?

Five states, and the boundaries between them are the whole value:

| state | meaning |
|---|---|
| `VERIFIED` | every workflow that must run on a push completed success |
| `FAILED` | a workflow concluded failure — this wins over everything |
| `CANCELLED` | superseded by a newer push; **not a failure, and not a pass** |
| `INCOMPLETE` | still running, or a required workflow has no run |
| `UNAVAILABLE` | no push run exists for this commit |

Implemented as a job in `ci.yml`, on `push` to `main` only, **outside
`JOB_TO_SUITE`** so it is never a merge criterion — it reports on a commit that is
already merged, and making it fail would not un-merge anything.

## Four bugs in the tool, all mine, all found by using it

1. **Over-matching push triggers.** Read `push:` and assumed every push. Six
   workflows were reported missing on a commit that had not touched their paths.
2. **`release-certification.yml` pushes on tags**, not branches. A shallow parse
   invented an obligation the workflow never agreed to.
3. **Comments are not configuration.** `platform-linux-acceptance.yml` opens with
   "NO `paths:` filter, deliberately" — and a `.includes('paths:')` read that
   sentence as a filter. The character-class mistake again, one level up: a
   substring match on prose.
4. **`pipefail` inverts the exit code.** The tool exits 2 for UNAVAILABLE and 3 for
   CANCELLED by design, so `tool | python3` returns non-zero while the JSON is
   perfect. The test failed against a correct tool. Documented in the tool, and the
   test now captures to a file first.

## What it says about the commits this phase produced

```
$ node tests/ci/verify-main.mjs --sha aedc7680
FAILED  aedc7680
  1 workflow(s) failed on this commit: staging-preview.yml: failure
  verified: ci.yml

$ node tests/ci/verify-main.mjs --sha a7d6cd65
FAILED  a7d6cd65
  FAILED:   staging-preview.yml: failure
  CANCELLED:ci.yml
```

Both are true, and neither is a defect in the change that landed: `staging-preview`
fails on the capacity condition TASK-32 fixes, which **is merged and not deployed**.
`ci.yml` on `a7d6cd65` was cancelled because `aedc7680` landed on top of it — the
documented `cancel-in-progress` policy.

That is exactly the distinction the tool exists to preserve: a commit whose suites
were superseded is not a verified commit, and a commit with a red suite is not a
superseded one.
