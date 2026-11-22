| enforcement | active | active |
| conditions | {"ref_name": {"exclude": [], "include": ["~DEFAULT_BRANCH"]}} | {"ref_name": {"exclude": [], "include": ["~DEFAULT_BRANCH"]}} |
| bypass_actors | [] | [] |
| rule types | deletion, non_fast_forward, required_linear_history, pull_request | deletion, non_fast_forward, required_linear_history, pull_request, required_status_checks |
| required contexts | (none) | contracts, linux-runtime, platform-image-build, platform-only, quality-faults, rust, spec-coverage, web, web-unit, ci-gate |
| strict policy | - | true |

## Procedure (needs authorisation - this is NOT executed here)

```bash
# 1. Snapshot the live ruleset BEFORE writing anything.
gh api repos/baicie/ops-1/rulesets/26958761 > /tmp/ruleset-before.json

# 2. Validate the payload offline. Refuses to proceed on any finding.
node tests/ci/check-ruleset-payload.mjs

# 3. Write it. PUT REPLACES the whole rules array.
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  --input docs/ci/ruleset-candidate-ten.json

# 4. Read back and compare EVERY field, not just the contexts.
gh api repos/baicie/ops-1/rulesets/26958761 > /tmp/ruleset-after.json
node tests/ci/check-ruleset-payload.mjs --against-live /tmp/ruleset-after.json
```

## Rollback

`docs/ci/ruleset-26958761-original-strict.json` is the pre-migration shape.
Sending it restores exactly the four protections and removes the check rule.
It is validated by the same offline checker, so it also cannot lose a rule.

## What this payload does NOT do

- It does not add `ci-gate` to `JOB_TO_SUITE` or any workflow. The context already exists.
- It does not change `strict_required_status_checks_policy` semantics: `true` means a
  branch must be up to date before merging.
- It does not touch `pull_request` parameters, which are copied verbatim from live.
- It is not applied. `gh api -X PUT` above is the step that needs your decision.
