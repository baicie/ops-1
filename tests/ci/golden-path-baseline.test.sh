#!/usr/bin/env bash
# Phase 8 TASK-23: the baseline tool's decision half, driven from saved logs.
#
# The live half needs `gh`; the assertions that matter are about AGGREGATION, not
# GitHub, so these drive `--from-dir` with synthetic STEP lines.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

TOOL=tests/ci/golden-path-baseline.mjs
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mk() { # file, then STEP lines
  local f="$WORK/$1"; shift
  : > "$f"
  for line in "$@"; do printf 'x\tx\t2026-01-01T00:00:00Z %s\n' "$line" >> "$f"; done
}

# assert_json <json> <description> ; python on stdin, exits 0/1
assert_json() {
  if python3 -c "$PYCHECK" "$1"; then ok "$2"; else bad "$2"; fi
}

echo "== 1. a single sample reports zero spread and says so"
mk one.log "STEP result=PASS name=alpha start=a end=b secs=10 pid=1 rc=0 timeout=60"
out="$(node "$TOOL" --from-dir "$WORK" 2>&1)"
printf '%s\n' "$out" | grep -q "spread across samples: 0s" \
  && ok "one sample gives spread 0" || bad "spread not reported as 0"

echo "== 2. the spread is max-minus-min across samples, not a mean of pairs"
rm -f "$WORK"/*.log
mk a.log "STEP result=PASS name=alpha start=a end=b secs=10 pid=1 rc=0 timeout=60"
mk b.log "STEP result=PASS name=alpha start=a end=b secs=30 pid=1 rc=0 timeout=60"
mk c.log "STEP result=PASS name=alpha start=a end=b secs=20 pid=1 rc=0 timeout=60"
out="$(node "$TOOL" --from-dir "$WORK" --json 2>&1)"
PYCHECK='
import json,sys
d=json.loads(sys.argv[1])
r=[x for x in d["rows"] if x["name"]=="alpha"][0]
assert r["spread"]==20, r
assert r["min"]==10 and r["max"]==30, r
assert r["median"]==20, r
'
assert_json "$out" "spread is max-min (20) with median 20"

echo "== 3. a step's class is by NAME, not by duration"
rm -f "$WORK"/*.log
mk s.log "STEP result=PASS name=pipeline_long_heartbeat start=a end=b secs=5 pid=1 rc=0 timeout=60" \
         "STEP result=PASS name=supervisor_lifecycle start=a end=b secs=200 pid=1 rc=0 timeout=60"
out="$(node "$TOOL" --from-dir "$WORK" --json 2>&1)"
PYCHECK='
import json,sys
d=json.loads(sys.argv[1])
c={x["name"]:x["klass"] for x in d["rows"]}
assert c["pipeline_long_heartbeat"]=="JOB_RUN", c
assert c["supervisor_lifecycle"]=="WORK", c
'
assert_json "$out" "a 5s JOB_RUN step and a 200s WORK step are classified by name"

echo "== 4. a non-PASS step is surfaced, not averaged away"
rm -f "$WORK"/*.log
mk f.log "STEP result=FAIL name=alpha start=a end=b secs=10 pid=1 rc=1 timeout=60"
out="$(node "$TOOL" --from-dir "$WORK" --json 2>&1)"
PYCHECK='
import json,sys
d=json.loads(sys.argv[1])
r=[x for x in d["rows"] if x["name"]=="alpha"][0]
assert r["failed"]==1, r
'
assert_json "$out" "a FAIL sample is counted in the row"

echo "== 5. THE ONE THAT MATTERS: the 151 s swing is attributed to its step"
# The whole point of the file. Two runs differing by 151 s in one step and by
# nothing elsewhere must show that step with spread 151 and the others with ~0,
# so a reader can see WHICH step moved rather than only that the total did.
rm -f "$WORK"/*.log
mk fast.log "STEP result=PASS name=pipeline_long_heartbeat start=a end=b secs=15 pid=1 rc=0 timeout=240" \
            "STEP result=PASS name=supervisor_lifecycle start=a end=b secs=96 pid=1 rc=0 timeout=240"
mk slow.log "STEP result=PASS name=pipeline_long_heartbeat start=a end=b secs=166 pid=1 rc=0 timeout=240" \
            "STEP result=PASS name=supervisor_lifecycle start=a end=b secs=96 pid=1 rc=0 timeout=240"
out="$(node "$TOOL" --from-dir "$WORK" --json 2>&1)"
PYCHECK='
import json,sys
d=json.loads(sys.argv[1])
rows={x["name"]:x for x in d["rows"]}
assert rows["pipeline_long_heartbeat"]["spread"]==151, rows["pipeline_long_heartbeat"]
assert rows["supervisor_lifecycle"]["spread"]==0, rows["supervisor_lifecycle"]
assert d["totalSpread"]==151, d["totalSpread"]
'
assert_json "$out" "the 151 s total is attributed to pipeline_long_heartbeat, not to noise"

echo "== 6. no samples at all is an error, not an empty pass"
mkdir -p "$WORK/empty"
out="$(node "$TOOL" --from-dir "$WORK/empty" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "an empty sample set exits non-zero (rc=$rc)" \
  || bad "an empty sample set exited 0"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
