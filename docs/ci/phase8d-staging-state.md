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
