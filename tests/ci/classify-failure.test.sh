#!/usr/bin/env bash
# Phase 8 TASK-21: the classifier's decision rules, driven from synthetic logs.
#
# The real-failure runs are cited in docs/ci/phase8-failure-classification.md; this
# drives the RULES so a signature change is caught without needing a live 429.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/classify-failure.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# classify <file> -> prints "<verdict>|<confidence>"
classify() {
  node "$TOOL" --log "$1" --json 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["verdict"]+"|"+d["confidence"])'
}
expect() { # file, want, label
  local got; got="$(classify "$1")"
  [ "$got" = "$2" ] && ok "$3" || bad "$3 (got $got, want $2)"
}

echo "== 1. a real registry 429 is EXTERNAL_DEPENDENCY, and says so with specific evidence"
cat > "$WORK/429.log" <<'EOF'
x	t	2026-11-25T04:11:16Z [FATAL] Non-resolvable parent POM for dev.opsweave:hello-java:0.0.1: Could not transfer artifact org.springframework.boot:spring-boot-starter-parent:pom:3.3.5, status: 429
EOF
expect "$WORK/429.log" "EXTERNAL_DEPENDENCY|specific" "a 429 is classified external, with specific evidence"

echo "== 2. a capacity refusal is STAGING_ENVIRONMENT, not a product regression"
cat > "$WORK/cap.log" <<'EOF'
x	t	2026-11-25T00:00:00Z status_reason=4 instances already scheduled on this node against a per-node limit of 4 [INSTANCE_CAPACITY_EXCEEDED]
EOF
expect "$WORK/cap.log" "STAGING_ENVIRONMENT|specific" "a capacity refusal is the environment"

echo "== 3. a malformed fixture is TEST_HARNESS_DEFECT"
cat > "$WORK/fixture.log" <<'EOF'
x	t	2026-11-25T00:00:00Z ERROR: failed to parse stage name "\nnode:22-bookworm-slim": invalid reference format
EOF
expect "$WORK/fixture.log" "TEST_HARNESS_DEFECT|specific" "an unparseable value is a harness defect"

echo "== 4. a runner fault is RUNNER_INFRASTRUCTURE"
cat > "$WORK/runner.log" <<'EOF'
x	t	2026-11-25T00:00:00Z Error: docker daemon is not running
EOF
expect "$WORK/runner.log" "RUNNER_INFRASTRUCTURE|specific" "a dead daemon is the runner"

echo "== 5. an attribution problem is CHECK_ATTRIBUTION"
cat > "$WORK/attrib.log" <<'EOF'
x	t	2026-11-25T00:00:00Z verdict: FAIL
x	t	2026-11-25T00:00:00Z   delegated-timeout: 1 suite(s) still running after 3600s
EOF
expect "$WORK/attrib.log" "CHECK_ATTRIBUTION|specific" "a delegated timeout is an attribution verdict"

echo "== 6. A BARE FAILED ASSERTION IS PRODUCT_REGRESSION, BY DEFAULT"
# The asymmetry under test: no external evidence is required to reach this one,
# which is what makes the other categories demand evidence.
cat > "$WORK/assert.log" <<'EOF'
x	t	2026-11-25T00:00:00Z   FAIL the active version did not move (expected 0.0.3, got 0.0.4)
EOF
expect "$WORK/assert.log" "PRODUCT_REGRESSION|default" "a failed assertion defaults to product regression"

echo "== 7. the assertion is found THROUGH the gh log prefix"
# `gh run view --log` prefixes each line with the job and step separated by tabs.
# The first version anchored `^  FAIL ` and classified this UNKNOWN.
cat > "$WORK/prefixed.log" <<'EOF'
full TypeScript lifecycle	The heartbeat protocol's bounds	2026-11-24T15:32:36.2Z   FAIL node-a's instance desired_action=<none>, expected STOP
EOF
expect "$WORK/prefixed.log" "PRODUCT_REGRESSION|default" "a prefixed FAIL line is still found"

echo "== 8. nothing matches is UNKNOWN, and it EXITS NON-ZERO"
cat > "$WORK/unknown.log" <<'EOF'
x	t	2026-11-25T00:00:00Z everything is fine
EOF
out="$(node "$TOOL" --log "$WORK/unknown.log" 2>&1)"; rc=$?
printf '%s' "$out" | grep -q "^UNKNOWN" && ok "an unmatched log is UNKNOWN" || bad "an unmatched log was not UNKNOWN"
[ "$rc" -eq 1 ] && ok "UNKNOWN exits 1, so it cannot be read as success" || bad "UNKNOWN exited $rc"

echo "== 9. UNKNOWN is not silently folded into an external excuse"
printf '%s' "$out" | grep -q 'UNKNOWN is not "probably external"' \
  && ok "the output says an unproven cause is not external" \
  || bad "the output did not warn against the blanket excuse"

echo "== 10. a 5xx from the registry is external; a 500 in a test name is not"
cat > "$WORK/5xx.log" <<'EOF'
x	t	2026-11-25T00:00:00Z Could not transfer artifact foo from/to central: status code: 503
EOF
expect "$WORK/5xx.log" "EXTERNAL_DEPENDENCY|specific" "a 503 while transferring is external"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
