# 恢复 main 的必需检查

**当前状态（2026-11-20）：ruleset `26958761` 没有 `required_status_checks`。**

保留的规则：`deletion`、`non_fast_forward`、`required_linear_history`、`pull_request`。
`enforcement: active`，`bypass_actors: []`。

也就是说：**CI 会跑、会报红，但不再阻止任何合并。**

## 为什么记在这里

这是我按明确指示做的仓库级变更，不是缺陷修复。它的回滚材料原先只在 `/tmp`，
机器重启就没了——所以存进仓库。

## 两个快照

| 文件 | 内容 |
|---|---|
| `ruleset-26958761-original-strict.json` | 变更前的原样：九项必需检查 + `strict: true` |
| `ruleset-26958761-with-required-checks.json` | 中间态：九项检查 + `strict: false` |

## 恢复成原样（九项 + strict）

```bash
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  --input docs/ci/ruleset-26958761-original-strict.json
```

## 只恢复九项检查、不要 strict

```bash
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  --input docs/ci/ruleset-26958761-with-required-checks.json
```

## 验证

```bash
gh api repos/baicie/ops-1/rulesets/26958761 --jq '{
  enforcement,
  rules: [.rules[].type],
  checks: ([.rules[]|select(.type=="required_status_checks")]|length),
  strict: ([.rules[]|select(.type=="required_status_checks")|.parameters.strict_required_status_checks_policy][0] // "n/a")
}'
```

恢复后 `checks` 应为 `1`，`strict` 应为 `true`。

## PUT 会替换整个 rules 数组

`PUT /rulesets/{id}` 用提交的 `rules` 数组**整体替换**现有规则。只提交
`required_status_checks` 会丢掉 `deletion`、`non_fast_forward`、
`required_linear_history`、`pull_request` 四项。上面两个快照都是完整的五规则
对象，所以可以直接提交；手写载荷时不要只写一项。
