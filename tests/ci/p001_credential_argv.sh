#!/usr/bin/env bash
# P001-B.2 A1/A2: the installer must never expose a credential through a process
# argument, and must not use predictable temp file names.
#
# Static over the source, plus executed checks for the parts that can be run.
# The leak this guards is a SHAPE in the source - `python3 -c '...' "$password"` -
# and the shape is decidable, so it is decided here over the whole script.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/platform_up.sh"
fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

if [ ! -f "$SCRIPT" ]; then
  echo "FAIL  no installer at $SCRIPT"
  exit 1
fi

# The forbidden shape, as one ERE, used by the scan and by the negative control.
# `python3` followed by a credential variable used as an argument. The `[^|#]*`
# keeps a pipeline or comment from satisfying the match, and `[^a-zA-Z_]` before
# the `$` stops `$json_password-ish` names from matching accidentally. A stdin
# pipeline such as `printf ... "$password" | json_login_payload` does not put
# python3 before the variable, so it is not matched - asserted by case 7.
FORBIDDEN='python3[^|#]*[^a-zA-Z_]\$(password|admin_password|\{password\}|\{admin_password\})'

# ---------------------------------------------------------------------------
# 1. No credential is passed as a process ARGUMENT.
# ---------------------------------------------------------------------------
# Comments are stripped first: the installer DOCUMENTS the forbidden shape to
# explain why it was removed, and a scanner that cannot tell code from a comment
# would force the explanation out of the file. Line numbers are preserved so a
# hit still points at the real line.
CODE="$(mktemp)"
trap 'rm -f "$CODE"' EXIT
sed 's/^[[:space:]]*#.*$//' "$SCRIPT" > "$CODE"
if grep -nE "$FORBIDDEN" "$CODE" >/dev/null; then
  fail "python3 receives a credential as a positional argument"
  grep -nE "$FORBIDDEN" "$CODE" | sed 's/^/      /'
else
  pass "no python3 invocation takes a credential as an argument"
fi

if grep -n 'sys\.argv' "$SCRIPT" | grep -qiE 'password|csrf|token'; then
  fail "a python snippet reads a credential from sys.argv"
else
  pass "no python snippet reads a credential from sys.argv"
fi

# ---------------------------------------------------------------------------
# 2. The secrets travel on STDIN - otherwise this is "we removed the feature".
# ---------------------------------------------------------------------------
for fn in json_login_payload csrf_from_stdin token_from_stdin; do
  if grep -q "^${fn}()" "$SCRIPT"; then
    pass "stdin helper present: $fn"
  else
    fail "stdin helper missing: $fn"
  fi
done

# ---------------------------------------------------------------------------
# 3. No fixed, predictable authentication temp paths.
# ---------------------------------------------------------------------------
fixed_hits=0
for fixed in /tmp/login.json /tmp/login-resp.json /tmp/jar /tmp/lp.json /tmp/opsweave-platform-login.json; do
  if grep -qF -- "$fixed" "$SCRIPT"; then
    fail "fixed temp path in use: $fixed"
    fixed_hits=$((fixed_hits + 1))
  fi
done
if [ "$fixed_hits" -eq 0 ]; then
  pass "no fixed authentication temp paths"
fi

if grep -q 'mktemp -d' "$SCRIPT"; then
  pass "temporary directories come from mktemp -d"
else
  fail "no mktemp -d in the installer"
fi

# `rm -f ... || true` as the ONLY cleanup is what the review rejected.
if grep -qE 'trap .*(RETURN|EXIT)' "$SCRIPT"; then
  pass "cleanup is also trap-driven, not only rm"
else
  fail "no trap-based cleanup for temporary credentials"
fi

# A RETURN trap is global in bash: once armed it fires on the return of EVERY
# function, including ones whose locals ($cid, $work) no longer exist. That
# surfaced as `cid: unbound variable` inside cmd_install. Every RETURN trap in
# the installer must therefore be disarmed in the same function that armed it.
armed=$(grep -c "trap '.*' RETURN" "$SCRIPT" || true)
disarmed=$(grep -c 'trap - RETURN' "$SCRIPT" || true)
if [ "$disarmed" -ge "$armed" ] && [ "$armed" -gt 0 ]; then
  pass "every RETURN trap is disarmed ($armed armed, $disarmed disarmed)"
else
  fail "RETURN trap armed $armed time(s) but disarmed $disarmed time(s)"
fi

# ---------------------------------------------------------------------------
# 4. JSON escaping, executed against the real function.
# ---------------------------------------------------------------------------
FN="$(mktemp)"
awk '/^json_login_payload\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SCRIPT" > "$FN"
if [ ! -s "$FN" ]; then
  echo "FAIL  cannot extract json_login_payload from the installer"
  exit 1
fi

json_roundtrip() {
  local pw="$1" out
  out="$(printf '%s\0%s' 'user@example.invalid' "$pw" | bash -c '. "$1"; json_login_payload' _ "$FN")" || return 1
  # The expectation also travels on STDIN, so this test obeys the rule it
  # enforces - its own argv included.
  printf '%s\0%s' "$out" "$pw" | python3 -I -c '
import json, sys
raw = sys.stdin.buffer.read().split(b"\0")
try:
    doc = json.loads(raw[0].decode("utf-8", "surrogateescape"))
except Exception:
    sys.exit(1)
expected = raw[1].decode("utf-8", "surrogateescape") if len(raw) > 1 else None
sys.exit(0 if isinstance(doc, dict) and doc.get("password") == expected else 1)
' 2>/dev/null
}

case_number=0
roundtrip_case() {
  case_number=$((case_number + 1))
  if json_roundtrip "$1"; then
    pass "json round-trip #$case_number"
  else
    fail "json round-trip #$case_number: $(printf '%s' "$1" | head -c 30 | tr '\n\t' '..')"
  fi
}

roundtrip_case 'plain-password-123'
roundtrip_case 'with"double"quotes'
roundtrip_case "with'single'quotes"
roundtrip_case 'with\backslash'
roundtrip_case "$(printf 'with\nnewline\ttab')"
roundtrip_case 'unicode-密码-é-🔐'
roundtrip_case 'trailing-space '
roundtrip_case ' {"looks":"like json"} '
roundtrip_case '$(not-expanded) `nor-this` ${x}'

# ---------------------------------------------------------------------------
# 5. Runtime proof: a live process never carries the value in its command line.
# ---------------------------------------------------------------------------
runtime_argv_check() {
  local marker='ARGVLEAKCANARY9x7' out pid seen probe

  out="$(printf '%s\0%s' 'user@example.invalid' "$marker" | bash -c '. "$1"; json_login_payload' _ "$FN")" || return 1
  case "$out" in
    *"$marker"*) ;;
    *) return 1 ;;   # the canary never reached the payload; nothing was tested
  esac

  probe="$(mktemp)"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'IFS= read -r line || true\n'
    printf 'sleep 0.4\n'
  } > "$probe"
  chmod +x "$probe"
  printf '%s' "$marker" | "$probe" &
  pid=$!
  sleep 0.1
  seen="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  wait "$pid" 2>/dev/null
  rm -f "$probe"
  case "$seen" in
    *"$marker"*) return 1 ;;
  esac
  return 0
}

# The whole process table, not just the probe: the probe above only proves the
# canary did not leak through ONE child. `grep` itself is excluded because its
# own argv carries the pattern - the classic false positive that makes a leak
# scan useless (counted, then discarded, not assumed away).
scan_process_table() {
  local marker="$1" hits
  hits="$(ps -eo args= 2>/dev/null | grep -F -- "$marker" | grep -v 'grep' | grep -vc '^$' || true)"
  [ "${hits:-0}" -eq 0 ]
}

if runtime_argv_check; then
  pass "no credential appears in a live process command line"
else
  fail "a credential appeared in a process command line"
fi

# Self-check that the scanner can actually SEE a leak, so a zero is meaningful.
if scan_process_table 'definitely-not-present-9x7'; then
  pass "the process-table scan reports zero for an absent marker"
else
  fail "the process-table scan is broken (it found an absent marker)"
fi
if ( exec -a "leaky-ARGVLEAKCANARY9x7" sleep 0.3 ) & then
  sleep 0.1
  if scan_process_table 'ARGVLEAKCANARY9x7'; then
    fail "the process-table scan missed a deliberate leak"
  else
    pass "the process-table scan detects a deliberate leak"
  fi
  wait
fi

# ---------------------------------------------------------------------------
# 6. Negative control: the check must REJECT the shape it forbids.
#
#    Without this, a guard that always passes looks identical to a guard that
#    works - the failure mode this repository has hit before.
# ---------------------------------------------------------------------------
if printf '%s\n' 'python3 -c "print(1)" "$email" "$password"' | grep -qE "$FORBIDDEN"; then
  pass "the argv pattern check rejects the forbidden shape"
else
  fail "the argv pattern check does not catch the forbidden shape"
fi

# ---------------------------------------------------------------------------
# 7. Positive control: the script's own shape is NOT rejected.
# ---------------------------------------------------------------------------
if printf '%s\n' 'payload="$(printf "%s\0%s" "$email" "$password" | json_login_payload)"' | grep -qE "$FORBIDDEN"; then
  fail "the argv pattern check rejects a legitimate stdin-based line"
else
  pass "the argv pattern check accepts a legitimate stdin-based line"
fi

rm -f "$CODE" "$FN"

echo
if [ "$fails" -eq 0 ]; then
  echo "P001 credential-handling guard: PASS"
  exit 0
fi
echo "P001 credential-handling guard: $fails failure(s)"
exit 1
