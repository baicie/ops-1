# What the browser suite says, and what was compared

`AGENTS.md` §4 requires reporting the commands actually run and their results, and forbids
fabricating a pass rate. The full `tests/ui` suite does **not** pass in this environment. This
file exists so that no reader has to take that on faith in either direction.

## The comparison that matters

A second checkout was created at the base commit and served by a second Kernel on its own
database, so "failed before my change" and "failed because of my change" are two different
observations instead of one guess.

```
git worktree add /tmp/basewt-cmp c6cb34f --detach          # the base tree
cd /tmp/basewt-cmp/apps/platform-web && vite build          # its bundle
OPSWEAVE_BIND=127.0.0.1:18182 ... ./target/debug/opsweave-kernel   # its Kernel, own DB
```

The Kernel binary is the same file in both runs: neither `c6cb34f` nor this branch touches
`apps/kernel/`, verified with `git diff --stat c6cb34f HEAD -- apps/kernel/` (empty).

### `admin-polish.spec.ts` — the file this task is judged on

| tree | result |
|---|---|
| `c6cb34f` (base) | **10 passed, 1 failed** — `cancelling a job asks first…` |
| this branch | **11 passed, 0 failed** |

The one test the base fails is the one this branch fixed, in `f712411`. It was not a flake: the
base run fails it the same way every time, at the same assertion.

### The four failures I suspected were mine

Run against the base instance, unchanged, with only the URL pointed at it:

```
✘ admin-pages.spec.ts:83      all three sample pages fit 1440/1024/390 without overflow
✘ g08-batch-c.spec.ts:242     plugin detail renders the shared header and NO_DATA…
✘ overview-partial.spec.ts:297 overview: a warning attention item renders the ATTENTION indicator
✘ v5-acceptance.spec.ts:257   table rows share one baseline
4 failed
```

**The same four, failing the same way, at the base commit.** They are pre-existing conditions of
this environment, not regressions: the database is fresh, so `/admin/nodes` settles into `empty`
and no table has rows; `PluginDetail` has no `description` prop (it lost it in `c6cb34f` while the
g08 spec kept asserting one); and the attention copy differs from the string the spec pins.

## What the full suite reported

`playwright test --project=chromium --workers=1` over the whole directory: **103 passed, 29
failed**. The failures are concentrated in specs that need a stack this database does not have:

| group | why |
|---|---|
| `data-foundation*`, `staging-smoke` | needs the Data Catalog/Integration plugin bundles, which are not built or deployed here |
| `studio.spec.ts` (8) | needs published pipeline revisions; the studio's own flows need a worker |
| `admin-pages` (nodes), `overview-partial`, `ui-verbs-v6`, `v5-*` | need rows, a node, or a specific attention fixture |
| SHA-pinned specs | read their expected commit from `OPSWEAVE_COMMIT` / `V6_SHA`, defaulting to a stale hash; against the matching Kernel they pass (verified: `ui-verbs-v6.spec.ts:77` passes once both are set) |

Running the whole directory at once also produced failures that pass when run alone
(`g11-page-header-growth.spec.ts:201` failed in the sweep and passed at 2.6m on its own), so the
sweep number is an upper bound on environmental noise, not a defect count.

## What was not run

- **No browser matrix against a populated stack.** Every image is an empty database.
- **`studio.spec.ts` never passes here**, and it is the file with the known T-01 intermittent
  60-second timeout. I did not lengthen a timeout or mark anything skipped to move it. In this
  environment it fails for missing published revisions before it can reach T-01's shape, so this
  run says nothing about whether T-01 still exists.
