# scripts/

Scripts are grouped by **who calls them**, which is the only grouping that
stays true after a rename. Names lie: `demo_up.sh` is not a demo, it is how
three CI workflows bring a platform up.

## Entry points (stable - changing these breaks callers)

| Script | Called by | Purpose |
|---|---|---|
| `opsweave.sh` | humans, README | the one command a developer is meant to learn |
| `platform_up.sh` | humans, `data-foundation.yml` | bring the platform up locally |
| `demo_up.sh` / `demo_down.sh` / `demo_common.sh` | `data-foundation.yml`, `plugin-lifecycle.yml`, `staging-preview.yml` | E2E bring-up; **CI infrastructure, not a demo** |
| `demo_data_up.sh` / `demo_hello_up.sh` | `data-foundation.yml`, `staging-preview.yml` | per-surface bring-up used by the harnesses |

## Build

| Script | Called by |
|---|---|
| `build-plugins.sh` / `build-data-plugins.sh` / `build-zabbix-plugin.sh` | `plugin-lifecycle.yml`, `data-foundation.yml`, `ci.yml` |
| `assemble_plugin.py` | `plugin-lifecycle.yml` (bundle assembly) |
| `sync-plugin-identity.mjs` / `sync-package-exports.mjs` | `ci.yml` guards |

## Release and deploy

`publish-data-plugins.sh`, `publish-demo-hello-plugin.sh`, `release-receipt.mjs`,
`verify-registry-digest.mjs`, `contract-bundle-fixture.sh`, `deploy-staging.sh`,
`ci-ssh-setup.sh`. See `docs/ci/` for the release chain's own documentation.

## Verify (CI gates with no product effect)

`check-i18n.mjs`, `check-ui-tokens.mjs`, `check-ui-metrics.mjs`,
`check-workbench-metrics.mjs`, `check-status-vocabulary.mjs`. Each has a
`*.test.mjs` beside it; `data-foundation.yml` and `ci.yml` run both.

## Maintenance

`backup.sh`, `restore.sh` - operator tools, not part of any workflow.

## `ci/`

Measurement and audit tools that are not gates: `ci-cost.mjs` reads Actions
history, `classify-visual-assets.mjs` classifies tracked PNGs. They inform a
decision; they do not fail a build. Kept out of `scripts/` proper so that a
directory listing separates "runs in CI" from "you run it to look at something".

## Tests

Tests for these scripts live in `tests/scripts/`, not here. `scripts/tests/`
held exactly one file, `deploy-served-sha.test.sh`, and **no workflow ran it** -
measured 2026-11-21, it passed 26/26 the first time anyone tried. It now lives
in `tests/scripts/` and runs in `ci.yml`.
