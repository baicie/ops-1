#!/usr/bin/env bash
# Guard test for scripts/ci/collect-capacity.sh.
#
# WHAT IS ACTUALLY BEING TESTED, AND WHY IT IS NOT THE HAPPY PATH
#
# This step exists because a staging fix was deployed on 2026-11-25 and did not
# work, and the run could not say why: no artifact carried a deployment's status or
# its age. The step is therefore only useful when something is wrong, so the cases
# below are mostly FAILURES. A test that covered `ssh` returning good JSON would
# prove the part that was never in doubt.
#
# THE RULE THAT MATTERS MOST: `capacity.json` must never be empty or absent. An
# empty file reads as "there were no occupants", which is the exact opposite of a
# full node and precisely the confusion this step was built to end. Every failure
# path must name itself.
#
# The script is driven with a stub `ssh` first on PATH. No host, no docker, no root.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

SCRIPT=scripts/ci/collect-capacity.sh
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/bin"
mkdir -p "$STUB"

# A stub `ssh` whose behaviour is chosen by $STUB_MODE. It reads the remote script
# from stdin exactly as the real one does, so the script under test exercises its
# real invocation path rather than a shortcut.
cat > "$STUB/ssh" <<'STUBEOF'
#!/usr/bin/env bash
# Consume stdin so the caller's redirection behaves like a real ssh.
cat >/dev/null 2>&1 || true
case "${STUB_MODE:-ok}" in
  ok)
    cat "${STUB_BODY:?STUB_BODY must be set for mode=ok}"
    exit 0 ;;
  empty)
    exit 0 ;;
  fail)
    printf '%s\n' "${STUB_ERR:-ssh: connect to host opsweave-staging port 22: Connection refused}" >&2
    exit 255 ;;
  unparseable)
    printf 'not json at all {"truncated": \n'
    exit 0 ;;
esac
STUBEOF
chmod +x "$STUB/ssh"

run() { # run <out-name> <mode> [body]
  local out="$WORK/$1.json"
  local err="$WORK/$1.stderr"
  local mode="$2"
  local body="/dev/null"
  # An explicit `if` rather than `local body="${3:-/dev/null}"`, because that form
  # silently ignored the third argument the first time this was written: the
  # assertion then read a file produced by an EMPTY body and reported the script as
  # broken. The bug was in the harness, which is worth stating since the harness is
  # what a reader trusts.
  if [ "$#" -ge 3 ] && [ -n "$3" ]; then body="$3"; fi
  STUB_MODE="$mode" STUB_BODY="$body" PATH="$STUB:$PATH" \
    bash "$SCRIPT" "$out" "$err" >/dev/null 2>&1
  printf '%s' "$out"
}

json_get() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2],""))' "$1" "$2" 2>/dev/null; }

# A body shaped like what `opsctl capacity --json` really prints, including the two
# fields this change added. Their presence is the whole point: `createdAt` is what
# separates "READY and superseded" from "PENDING, never placed".
cat > "$WORK/opsctl-good.json" <<'JSON'
{
  "verdict": "CAPACITY_BLOCKED",
  "replicasRequested": 1,
  "freeSlotsTotal": 0,
  "nodes": [{"node": "staging-node", "instancesReady": 4, "instancesTotal": 4, "freeSlots": 0}],
  "occupants": [
    {"deploymentId": "d1", "plugin": "opsweave.data-catalog", "version": "0.0.2",
     "status": "READY", "replicas": 1, "active": false,
     "reason": null, "createdAt": "2026-11-20T04:11:07Z", "activatedAt": null},
    {"deploymentId": "d2", "plugin": "opsweave.data-catalog", "version": "0.0.3590",
     "status": "READY", "replicas": 1, "active": false,
     "reason": null, "createdAt": "2026-11-22T09:03:44Z", "activatedAt": null}
  ],
  "caveat": "read-only snapshot"
}
JSON

echo "== 1. a good response is written through untouched"
OUT="$(run good ok "$WORK/opsctl-good.json")"
[ "$(json_get "$OUT" verdict)" = "CAPACITY_BLOCKED" ] && ok "verdict preserved" || bad "verdict lost"
python3 - "$OUT" <<'PY' && ok "occupants keep status, createdAt and activatedAt" || bad "the answer fields are missing"
import json, sys
d = json.load(open(sys.argv[1]))
for o in d["occupants"]:
    assert "status" in o and "createdAt" in o and "activatedAt" in o, o
statuses = {o["version"]: o["status"] for o in d["occupants"]}
assert statuses["0.0.2"] == "READY", statuses
PY

echo "== 2. an SSH FAILURE still produces a parseable, NAMED document"
# The case that matters: this step is reached on a run whose publish failed, and a
# connection problem must not turn the artifact into a blank that reads as "no
# occupants".
OUT="$(run sshfail fail)"
[ -s "$OUT" ] && ok "the file is not empty" || bad "an ssh failure left an empty artifact"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT" 2>/dev/null \
  && ok "and it parses as JSON" || bad "an ssh failure produced unparseable output"
[ "$(json_get "$OUT" error)" = "capacity-unavailable" ] && ok "and names itself capacity-unavailable" \
  || bad "the failure is not named: $(json_get "$OUT" error)" \
printf '%s' "$(json_get "$OUT" detail)" | grep -q "Connection refused" \
  && ok "and carries the real reason, not a placeholder" || bad "the reason was dropped"

echo "== 3. an EMPTY success is not an answer"
# `ssh` exits 0 when the remote command exits 0, and a tool that printed nothing
# satisfies that. A zero-byte file would be read as "no occupants".
OUT="$(run empty empty)"
[ -s "$OUT" ] && ok "the file is not empty" || bad "an empty response produced an empty artifact"
[ "$(json_get "$OUT" error)" = "capacity-empty" ] && ok "and says capacity-empty" \
  || bad "an empty response is indistinguishable from a clean one: $(json_get "$OUT" error)"

echo "== 4. TRUNCATED output is not parsed as a result"
OUT="$(run trunc unparseable)"
[ "$(json_get "$OUT" error)" = "capacity-unparseable" ] && ok "and says capacity-unparseable" \
  || bad "truncated JSON was written through: $(json_get "$OUT" error)"

echo "== 5. THE STEP NEVER FAILS THE JOB"
# A working deploy must not turn red because a diagnostic could not run. This is the
# one property that would make the whole step a net negative.
for mode in ok empty fail unparseable; do
  rc=0
  STUB_MODE="$mode" STUB_BODY="$WORK/opsctl-good.json" PATH="$STUB:$PATH" \
    bash "$SCRIPT" "$WORK/rc-$mode.json" "$WORK/rc-$mode.stderr" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ] && ok "mode=$mode exits 0" || bad "mode=$mode exited $rc - this would fail a successful deploy"
done

echo "== 6. the remote command asks compose, it does not hard-code a container name"
# A hard-coded `opsweave-staging-kernel-1` that drifted would make this step fail
# forever with a docker error rather than a capacity one.
grep -q 'com.docker.compose.service=kernel' "$SCRIPT" \
  && ok "the container is selected by compose label" || bad "the container name is hard-coded"
grep -q 'printf .%q' "$SCRIPT" \
  && bad "the remote script is quoted with a bash-only builtin" \
  || ok "no bash-only quoting is used for the remote side"

echo "== 7. it writes nothing to staging"
# The brief forbids unapproved mutations. This command is documented as read-only;
# the assertion is that nothing here could be mistaken for a mutation.
#
# COMMENTS ARE NOT CODE, and the first version of this check did not know that. It
# grepped the whole file for `deploy ` and matched the header sentence "a deploy
# that worked must not turn red" - reporting the script as mutating when the match
# was prose. Same shape as the `includes('paths:')` bug in verify-main.mjs, which
# read "NO `paths:` filter, deliberately" as a filter. Strip comments first.
CODE_ONLY="$(grep -vE '^[[:space:]]*#' "$SCRIPT")"
printf '%s' "$CODE_ONLY" | grep -nE '(docker (rm|stop|kill|restart)|psql|UPDATE |DELETE |uninstall|activate )' \
  && bad "the script contains a mutating command" \
  || ok "no mutating command appears in the executable lines"

echo
[ "$FAIL" -eq 0 ] && { echo "$PASS passed, 0 failed"; exit 0; }
echo "$PASS passed, $FAIL failed"; exit 1
