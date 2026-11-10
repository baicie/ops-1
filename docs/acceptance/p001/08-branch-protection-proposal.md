# P001 执行权限门禁方案

Status: **proposed, NOT applied.** Nothing in this document has been executed.
`main` is currently unprotected (measured 2026-11-10, see §1).

Reason for the boundary: this session merged #78 without the authorisation the
task required. The gap that allowed it is structural, not personal — a repository
with no protection cannot enforce any approval rule, so "ask first" was the only
barrier and it was a convention, not a control. This document proposes the
control. **Applying it is the repository owner's decision**, and this session will
not call any endpoint that changes it until told to.

---

## 1. Measured state, before any change

```
$ gh api repos/baicie/ops-1/branches/main/protection
{"message":"Branch not protected","status": 404}

$ gh api repos/baicie/ops-1/rulesets
[]

$ gh api repos/baicie/ops-1 --jq '{allow_squash,allow_merge,allow_rebase,delete_branch_on_merge}'
{"allow_squash":true, "allow_merge":false, "allow_rebase":false,
 "delete_branch_on_merge":true}

$ gh api repos/baicie/ops-1 --jq .permissions
{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}
```

What this means in practice:

| Fact | Consequence |
|---|---|
| `404 Branch not protected` | a direct `git push origin main` succeeds; no review, no checks, no record |
| `rulesets: []` | no organisation-level rule either |
| `allow_merge/rebase: false` | squash is the only merge shape — **keep it**, the branch-cleanup rule depends on it |
| `delete_branch_on_merge: true` | merged PR branches disappear automatically; this is why remote branches kept vanishing |
| actor has `admin: true` | the **same account** that merges can also remove protection |

That last row is the honest limit of this proposal: a protection rule does not
constrain an account that can edit protection. It constrains the *default path*
and makes an exception a deliberate, visible act instead of an accident. Real
enforcement needs a second identity or an organisation ruleset owned by someone
else (see §5).

---

## 2. Proposed ruleset (preferred over classic protection)

A repository **ruleset** is evaluated by GitHub before classic protection, is
visible in the repository UI under Rules, and supports the same bypass-audit
controls. Classic branch protection is kept as a fallback in §3 for a repository
where rulesets are unavailable.

### 2.1 Rules

| Rule | Setting | Why this one |
|---|---|---|
| Require a pull request before merging | enabled | the only thing that would have made #78's merge a reviewable act |
| Required approvals | **0** | a single-maintainer repository: a required approval is either dead or routinely self-approved, and a rule everyone bypasses is worse than an honest zero |
| Dismiss stale approvals on new commits | enabled | harmless at 0 approvals, correct the day a second reviewer exists |
| Require status checks to pass | enabled | the substance of the gate |
| Require branches to be up to date | enabled | stacked branches were previously rebased by hand; this catches the case nobody does |
| Block force pushes | enabled | this session force-pushed feature branches; `main` must never be among them |
| Block deletions | enabled | `main` must not be deletable by a mistyped command |
| Require linear history | enabled | matches "squash only"; blocks a merge commit arriving by another route |
| Require signed commits | **not proposed** | no signing key is configured; proposing it would create a rule that cannot be satisfied |

### 2.2 Required status checks

Only checks that exist and can actually pass. Naming a check that never runs
blocks every merge; naming one that is currently red blocks it too.

| Check | Source | Note |
|---|---|---|
| `ci / rust` | `ci.yml` | kernel suites against a real PostgreSQL |
| `ci / web` | `ci.yml` | typecheck, build, i18n/token/retired-path gates |
| `ci / web-unit` | `ci.yml` | vitest across both applications |
| `ci / contracts` | `ci.yml` | `contracts/` validation |
| `ci / spec-coverage` | `ci.yml` | |
| `ci / platform-only` | `ci.yml` | the platform/business boundary, both directions |
| `ci / platform-image-build` | `ci.yml` | the platform image and its dependency split |
| `reliability / quality-faults` | `reliability.yml` | |
| `data-foundation / golden-path` | `data-foundation.yml` | **verify first** — see §2.3 |

Not proposed as required, with reasons:

| Check | Why not |
|---|---|
| `staging-preview / smoke` | it deploys to a shared host; making it required means an infrastructure outage blocks all code changes. It should stay a signal and be watched, not a blocker |
| `data-foundation / legacy-regression` | long-running (≈15 min) and exercises the retired business paths; valuable but not a merge gate for platform work |
| `platform-linux-acceptance / linux-runtime` | new in this branch; make it required only after it has passed on `main` at least once |
| the `g13a*` / `g13b*` / `b2-plugin-identity` jobs | they validate the Ops application, which a platform-only change does not touch; requiring them makes every platform PR wait on unrelated work |

### 2.3 Before applying: verify each required check has passed recently

A required check that has never run, or is currently failing, blocks every merge.
The order of operations must therefore be:

```bash
# For each check name, confirm it appears and passed on the current main:
gh api repos/baicie/ops-1/commits/main/check-runs \
  --jq '.check_runs[] | select(.conclusion=="success") | .name' | sort -u
```

Then remove from §2.2 any name absent from that list. `data-foundation /
golden-path` is called out because it failed once on a flaky timing assertion
(`job completed before long-running proof`) — it must be green on `main` before it
is made a gate.

---

## 3. Fallback: classic branch protection

If rulesets are unavailable on the plan, the equivalent classic settings:

```bash
gh api -X PUT repos/baicie/ops-1/branches/main/protection \
  -F 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=rust' \
  -f 'required_status_checks[contexts][]=web' \
  -f 'required_status_checks[contexts][]=web-unit' \
  -f 'required_status_checks[contexts][]=contracts' \
  -f 'required_status_checks[contexts][]=spec-coverage' \
  -f 'required_status_checks[contexts][]=platform-only' \
  -f 'required_status_checks[contexts][]=platform-image-build' \
  -F 'enforce_admins=true' \
  -F 'required_pull_request_reviews[required_approving_review_count]=0' \
  -F 'required_pull_request_reviews[dismiss_stale_reviews]=true' \
  -F 'restrictions=' \
  -F 'allow_force_pushes=false' \
  -F 'allow_deletions=false' \
  -F 'required_linear_history=true'
```

`enforce_admins=true` is the load-bearing flag: without it an administrator's
push bypasses everything, and the account that merges is the account that is
admin.

---

## 4. Verification checklist (after applying, whoever applies it)

Every line must be run and its output pasted into a P001 evidence file. A
protection rule nobody has tried to violate is a claim, not a control.

```bash
# 1. The rule is readable.
gh api repos/baicie/ops-1/rulesets --jq '.[].name'
gh api repos/baicie/ops-1/branches/main/protection --jq '.required_status_checks.contexts'

# 2. A direct push to main is REJECTED. From a scratch clone:
git clone https://github.com/baicie/ops-1 /tmp/protcheck && cd /tmp/protcheck
echo x >> README.md && git commit -am "probe: direct push must fail" && git push origin main
#    expected: remote rejects — "protected branch hook declined" / ruleset violation

# 3. A force push is REJECTED.
git push --force origin main
#    expected: rejected

# 4. Deleting main is REJECTED.
git push origin --delete main
#    expected: rejected

# 5. A PR with a red required check cannot merge.
#    (open a throwaway PR that fails `contracts`, then:)
gh pr merge <n> --squash
#    expected: refused

# 6. An admin push: if `enforce_admins` is on, even the admin is refused.
```

Items 2–6 are the ones that matter. Items 1 is only configuration.

---

## 5. The limit this proposal does not remove

`gh api repos/baicie/ops-1 --jq .permissions.admin` returns `true` for the account
that would be constrained. **An account that can edit protection is not bound by
it**; enforcement there is a convention again, exactly the situation this document
is trying to end.

Two ways to actually close that, both requiring an action this session must not
take:

1. **Organisation ruleset** owned by the organisation, with the maintainer as a
   non-admin member. Requires moving the repository into an organisation.
2. **A second identity for merges.** The automation account gets `push` (open PRs,
   push branches) and NOT `admin`; a human holds `admin` and approves merges.

Recommendation, stated as such: option 2 is smaller and can be done today; it turns
"do not merge without authorisation" from a sentence in a task brief into a
permission the account does not have.

---

## 6. What was NOT done

- No protection rule, ruleset or repository setting was created or modified.
- No endpoint that changes repository configuration was called.
- The commands in §2–§3 are written for the owner to run or to approve; this
  session will run them only after being told to.
