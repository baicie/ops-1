# G14 spacing gate + two broken tokens — evidence

Date: 2026-11-09. Branch `feat/g14-app-authz`. Read-only audit of the tree plus one fix set.

## What was wrong

| # | defect | where | how it was found |
|---|---|---|---|
| 1 | `--ow-accent-foreground` referenced but declared nowhere, so `.activity-filter-count` inherited body ink on the accent fill: **2.89:1** | `packages/ui/src/styles.css:3446` | sweep of every `var(--ow-*)` reference against the declarations |
| 2 | chart stroke fell back to `var(--accent, #4f8cff)` — a variable that does not exist either, so the polyline drew an off-palette blue | `apps/platform-console/src/Nodes.tsx:514` | same sweep, non-`--ow-` prefix |
| 3 | `spacing-token-literal: 52` and `spacing-off-scale: 108` sat in `ui-debt.json` since #15 while **no script emitted either rule name** | `docs/design/ui-visual-v3/spec/ui-debt.json` | rule list in the gate vs keys in the budget |
| 4 | dangling references: `checklists/UI_GATE.md`, `scripts/verify_package.py`, `checklists/PR_GATE.md`, `skills/*`, and 4 broken relative Markdown links | `rules/06-ui-ux.md:9`, `rules/README.md:6-8`, `AGENTS.md:41,48`, `contracts/*`, `docs/design/*` | link sweep over all 247 tracked Markdown files |

Defect 3 is the one worth dwelling on: the numbers were recorded once by hand against a tree
(`apps/platform-web`) that no longer holds the design system, R7 was described in
`code-rules.md` as "two new spacing buckets, each ratcheted one notch (435 → 52 / 115 → 108)",
and the script never contained the rule. Today's real measurement is **484 on-scale / 148
off-scale in CSS + 13 in TSX** — so 52 and 108 were never reproducible from this tree.

## What changed

- `--ow-accent-foreground` → `--ow-accent-text` (the token that already carries this job, declared
  in both themes).
- `var(--accent, #4f8cff)` → `var(--ow-accent)`.
- `spacing-off-scale` implemented as a real rule (CSS declarations + Tailwind arbitrary values;
  `var()` and `0` excluded). `spacing-token-literal` **deleted**: `code-rules.md` B6 explicitly
  permits on-scale literals, so a rule forbidding them would contradict the normative text.
- Three fail-closed guards: a budget key no rule emits → exit 2; zero scanned spacing
  declarations → exit 2; every run prints its scan volume.
- `scripts/check-ui-tokens.test.mjs` (8 tests) wired into `ci.yml`.
- All dangling doc references repointed at files that exist today.

## Verification actually run

```
node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json
  ok radius-tier 0/0  control-tier 0/0  type-tier 0/0
  ok one-header 0/0    uppercase-guard 0/0  format-locale 0/0
  ok spacing-off-scale 161/161
  scanned: 92 TSX files, 799 spacing declarations in styles.css
  check-ui-tokens: PASS

node --test scripts/check-ui-tokens.test.mjs      → 8 pass, 0 fail
node scripts/check-i18n.mjs                        → OK, 2047 keys, 18 unused (warnings)
node scripts/check-status-vocabulary.mjs           → clean, 43 protocol codes
node tests/ci/check-retired-paths.mjs              → 947 files, 0 references
node tests/ci/check-spec-coverage.mjs              → 41 covered, 22 explicit-skip, 0 unreferenced
pnpm --filter @opsweave/platform-console typecheck → exit 0
pnpm --filter @opsweave/ops-web typecheck          → exit 0
pnpm --filter @opsweave/ui test                    → 58 passed (8 files)
```

### Non-vacuity, per `rules/11` (each proved by breaking the thing on purpose)

| injected fault | expected | observed |
|---|---|---|
| `.probe-off-scale { padding: 17px; }` | `spacing-off-scale` 162 > 161 | FAIL, exit 1 |
| `mt-[19px]` added to a page | one more TSX hit | FAIL, exit 1 |
| budget key `species-token-literal` | gate refuses to run | exit 2, names the key |
| every spacing property renamed | zero scan volume | exit 2, "scanned 0 spacing declarations" |

## Browser evidence

Captured against the live local stack (`/admin/activity`, `/admin/nodes/:id`) at 1440, light and
dark — the two files this bucket keeps:

- `shots/activity-1440-light.png`
- `shots/activity-1440-dark.png`

The bundle served in that run was built **after** the source edit
(dist CSS 15:09, source 15:03) and contains `color:var(--ow-accent-text)` with
`ow-accent-foreground` absent, so the screenshots show the fix and not an older build.

390 and the node chart were captured and are not kept: the badge is the same two colours at 390,
and the chart cannot render on macOS at all (see "What is NOT verified").

Measured from the computed style, not from the picture:

| viewport | theme | badge colour | badge fill | ratio |
|---|---|---|---|---|
| 1440 | light | `rgb(255,255,255)` | `rgb(52,87,213)` | 6.05:1 |
| 1440 | dark | `rgb(12,18,36)` | `rgb(120,145,255)` | 6.47:1 |
| 390 | light | `rgb(255,255,255)` | `rgb(52,87,213)` | 6.05:1 |
| 390 | dark | `rgb(12,18,36)` | `rgb(120,145,255)` | 6.47:1 |

## What is NOT verified

- **The node resource chart's stroke is not proven in a browser here.** `historySegments` drops
  every sample whose `cpuUtilization` is null, and on macOS `resource_snapshot`
  (`apps/node/src/runtime.rs:1092`) only fills CPU/memory under
  `#[cfg(target_os = "linux")]`. On this host the polyline cannot render, so the spec reports
  `polyline not rendered (macOS node reports cpu=null)` rather than asserting a stroke it never
  saw. The source-level fix is confirmed; the rendered colour needs a Linux node.
- **No pixel baseline exists in this repository** (0 `toHaveScreenshot`), so the screenshots are
  human-reviewable evidence, not a regression gate.
- The spacing budget is recorded at **161**, today's measurement. It is a ceiling, not a target:
  it may only go down.
- `apps/platform-web` is still present on disk though retired; the token spec still says its
  scope is `apps/platform-web/src`. Whether to delete it is a separate decision.
