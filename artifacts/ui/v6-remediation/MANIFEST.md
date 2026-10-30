# V6 remediation evidence

Commit label in every rail: **bfe8d70** (= HEAD of feat/ui-visual-excellence-v3).
Bundle hash recorded per shot: **7c63f601181900d7** (index-C7dYD6bX.js, index-Cj7Flxhp.css).

## What is in this bucket (40 of 79)

| file | what it proves |
| --- | --- |
| matrix-<page>-<viewport>-<theme>-<locale>.png (36) | the MUST matrix: overview/plugins/nodes x 1440/1024/390 x light/dark x en/zh-CN |
| interaction-command-palette-1440-dark.png | P0-4 at desktop, dark |
| interaction-command-palette-390-light.png | P0-4 on a phone |
| interaction-drawer-open-dark.png | the 390 drawer, dark |
| interaction-filter-tab-selected-dark.png | the selected chip fill, dark |
| _assertions.json | every shot (all 79) with the DOM measurements taken before it was written |

The other 39 PNGs (the remaining 32 interaction states and the four state shots) live in
/tmp/v6-matrix/ with the same names; their measurements are in _assertions.json.

## Measured (from _assertions.json)

- **P0-1 Plugins@390**: tbody clientHeight 704 / scrollHeight 704, 2 records, 8 cells stacked,
  overlaps 0, record heights 354/350. Before: tbody 224 / 640, cells 335x58 piled from
  y=434.9 to y=782.9 with the four records on top of each other.
- **P0-1 Nodes@390**: tbody 306 / 306, 9 cells stacked, overlaps 0. Before: table box 56px with
  8 cells laid out to y=766.9, so status/instances/CPU/memory/capacity/sample were all clipped.
- **P0-1 desktop unchanged**: plugins row heights 60/59, nodes 67, stacked false.
- **P0-2**: state-unconfigured -> pill "Not configured" (data-verdict=not-configured) and rail
  "Not configured"; state-forbidden -> neither pill nor rail contains "ready"; state-error ->
  both say "unavailable".
- **P0-3**: chip text/background light rgb(75,85,99) on rgb(238,241,245) = 6.67:1; dark
  rgb(168,179,193) on rgb(27,33,41) = 7.62:1. The selected chip is an accent fill
  (srgb .20 .34 .84 / .12 light, .47 .57 1 / .18 dark), not a white block.
  prefers-color-scheme: dark with no stored preference yields html[data-theme=dark].
- **P0-4**: command list clientHeight 387 / scrollHeight 387, 10 destinations, at 1440 and 390,
  light and dark.
- **P0-5**: Overview KPI 0 == Plugins strip 0, list rows 2, system-plugin note present.
- **P0-6**: zh-CN attention title 尚未接入节点 (data-title-source=catalog); an unmapped Kernel
  sentence renders verbatim behind the 内核 source marker.

## Honest caveats

- The rail prints HEAD (bfe8d70), but the bundle was built from HEAD + uncommitted working-tree
  changes: this task forbids git writes, so no commit could be created. The bundle hash above is
  the exact bytes every shot was taken from, and it is recorded per shot.
- state-system-dark-login-1440.png has no rail: the login page has no shell.
- The local harness holds one enrolled node and two plugin rows (one of them the system plugin,
  nothing installed), so the Nodes record layout is proven on one record and P0-5 lands on 0 == 0.
