# UI visual v3 — the three specs, and the order to read them in

These are **specifications**, not bug lists. Six review rounds produced six “position lists”; an implementer
fixed every position; the next round still ended in “一坨”. The reason is mechanical: a position list can be
fixed, and a rule cannot be fixed position by position. What was missing was the rule.

Written against HEAD `7fd0c99` (`feat/ui-visual-excellence-v3`). Every number in the three files was produced
by a command whose output is quoted next to it, and every rule has a gate that can fail a build.

| file | answers | gate |
|---|---|---|
| `token-table.md` | **what a value is**: 3 radii, 4 type tiers, 2 control heights, 2 button sizes, and why *that* value | `check-ui-tokens.mjs` (R1–R4) |
| `page-template.md` | **where it goes**: one page template, header 80px, first block at y=160, one KPI band, one control height per row | `check-ui-metrics.mjs --template` |
| `table-spec.md` | **how a row behaves**: identity cell, column degradation, 40px rows, collapse runs, 390 cards, overflow | `check-ui-metrics.mjs` |
| `machine-language-rules.md` | **what the machine may say**: NO_DATA budget, `:lang(en)` casing, `Intl` units, destructive colour | `check-ui-tokens.mjs` (R5–R7) |

## Execution order

Four constraints decide it: a token must exist before a layout reads it; the header must be one component
before its height can be fixed; the table kit unlocks nine pages at once; and the machine-language work is
the only part that is independent of everything else.

| # | step | spec | why here | effort |
|---|---|---|---|---|
| 1 | **T1–T2 + M2** — declare the tokens, radius, `:lang(en)` casing | `token-table.md`, `machine-language-rules.md` | radius is the largest single blocker (120 findings) and is purely mechanical; `:lang(en)` is one CSS rule that changes zero pixels | 4.5h |
| 2 | **P1–P3** — canvas ruler, header 80px, action row on the title line | `page-template.md` | the header is the first thing every page renders; its height decides `firstBlockY` on all 14 routes | 2.5h |
| 3 | **T3–T5** — type ladder, control tiers, one button family | `token-table.md` | the template’s toolbar rule is only real once there are two control heights to choose from | 5.5h |
| 4 | **P4–P5** — one KPI band, toolbar rule C1 | `page-template.md` | depends on the control tiers; it is where the KPI `gap: 16` argument lands | 4h |
| 5 | **S1–S2 + S8** — table kit, `/admin/jobs`, 390 cards | `table-spec.md` | the kit unlocks 9 pages; jobs + 390 is the page carrying all three defects at once | 8h |
| 6 | **T6–T8 + P6** — one `PageHeader`, one shape, 34 call sites | `token-table.md`, `page-template.md` | last of the token work because it touches 34 files, all mechanically | 7h |
| 7 | **S3–S7** — the remaining 8 pages | `table-spec.md` | per-page; each independent once the kit exists | 10h |
| 8 | **M1, M3–M5** — empty states, `Intl`, CI wiring | `machine-language-rules.md` | M5 last: it is the gate that keeps steps 1–7 from being reverted by accident | 8h |

**Total ≈ 49 hours** (6 working days) for one engineer who has read the three files and does not re-litigate
them. The gate is red at every step until the last one; the ratchet budget in each spec is lowered by each PR.

## What the gates prove today

All four runs are on the unmodified tree — nothing was patched to make a point.

```
$ node scripts/check-ui-tokens.mjs
FAIL radius-tier 120 / control-tier 15 / type-tier 7 / one-header 5 / uppercase-guard 22 / format-locale 4
exit 1

$ node scripts/check-ui-tokens.mjs --ratchet ui-debt.json     # budgets at today’s counts
check-ui-tokens: PASS                                         exit 0

$ node scripts/check-ui-metrics.mjs …/_metrics_r390-light-en.json   # the record that shipped
FAIL overflow>0 /admin/jobs/1285fbe8-… +223px                      exit 1

$ node scripts/check-ui-metrics.mjs …/_metrics_r1440-light-en.json
check-ui-metrics: PASS (25 page measurements)                      exit 0
```

## The question the review asked

**Can the next developer build the correct table and the correct page without the review report?**

Yes. Here is the test of that claim: the three files never cite a review round as authority. Where a number
appears, the command that produced it is on the next line; where a value is chosen, the “why this value”
sentence is arithmetic or a pixel argument, never “unify to one”. A developer who reads `table-spec.md`
§2.1–§2.6 can build a row without opening `visual-audit.md`; a developer who reads `token-table.md` §2 can
answer “32 or 36 for this control” without asking anyone.

The one thing the files do **not** settle is colour: the palette is out of scope in all three (§5 of each),
because none of the six rounds’ measured defects was a colour defect. That is a stated gap, not an omission.

## Reading order for a reviewer

1. `token-table.md` §1 — 120 radius findings, 8 type tokens against 19 sizes on screen, 6 control heights, 8 header shapes. This is the 现状 that each review round re-discovered from scratch.
2. `page-template.md` §2.1 — the template, on one screen. If the diagram is wrong, everything downstream is wrong.
3. `table-spec.md` §2.3 — the 40px row arithmetic. The only place where a type tier, a control tier and a table rule meet, so the cheapest place to find a contradiction.
4. `machine-language-rules.md` §2 M5 — the CI wiring. Until it lands, the other three files are advice.

