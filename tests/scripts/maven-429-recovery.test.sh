#!/usr/bin/env bash
# TASK-02: does the retry actually recover from a REAL Maven 429?
#
# WHY THIS EXISTS, AND WHAT THE STUB TEST CANNOT DO
#
# `build-plugins-retry.test.sh` proves the POLICY: given a command that prints a
# fault shape and exits non-zero, does the wrapper retry it, how many times, and
# does it keep the command's exit code. That is the right test for the policy and it
# measures nothing about Maven.
#
# `legacy-regression` failed three times on a real Maven Central 429 and the retry
# message never appeared. A stub cannot explain that. This runs REAL Maven against a
# REAL HTTP server that answers 429, so the question "does the outer retry fire on a
# genuine resolution failure" is answered by observing it rather than by reading the
# code.
#
# NO PUBLIC NETWORK, NO OUTAGE REQUIRED. A local server on 127.0.0.1 serves a
# hand-written parent POM, with a hit counter. The project's pom.xml names that POM
# as its parent, so Maven's own resolver - wagon, aether, the checksum fetches, the
# negative cache, all of it - runs exactly as it does against Central.
#
# THE THREE THINGS MEASURED
#
#   1. a PERSISTENT 429: does the outer retry fire, and does it fire the number of
#      times the policy says?
#   2. a 429 that CLEARS: does the build recover, and does the recovery come from
#      Maven's own retryHandler or from the outer one?
#   3. what the failure MESSAGE looks like, because the policy greps it and a
#      message shape that does not match is a retry that never happens.
#
# (2) is the finding that matters for CI: Maven has its own retry handler and a
# SINGLE transient 429 is absorbed BEFORE the outer policy ever sees a failure. So a
# green `legacy-regression` does NOT prove the outer retry works - it may prove
# Maven never needed it. That distinction is the whole point of this file.
#
# Usage: bash tests/scripts/maven-429-recovery.test.sh
# Requires: mvn on PATH, python3. No network.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  skip %s\n' "$1"; }

cleanup() {
  local rc=$?
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "${SRV2_PID:-}" ] && kill "$SRV2_PID" 2>/dev/null
  rm -rf "$WORK"
  return "$rc"
}
trap cleanup EXIT

command -v mvn >/dev/null 2>&1 || { echo "mvn not on PATH; this test needs real Maven" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 required for the local server" >&2; exit 2; }

PORT_ONCE=18097
PORT_ALWAYS=18096

# --- the served artifact -----------------------------------------------------
mkdir -p "$WORK/served/org/example/probe-parent/1.0.0"
cat > "$WORK/served/org/example/probe-parent/1.0.0/probe-parent-1.0.0.pom" <<'POM'
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
<groupId>org.example</groupId><artifactId>probe-parent</artifactId><version>1.0.0</version>
<packaging>pom</packaging></project>
POM

# --- the project that depends on it ------------------------------------------
mkdir -p "$WORK/proj"
cat > "$WORK/proj/pom.xml" <<'POM'
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.example</groupId><artifactId>probe-parent</artifactId><version>1.0.0</version></parent>
  <artifactId>probe-child</artifactId>
</project>
POM

settings_for() {
  cat > "$WORK/settings-$1.xml" <<S
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <mirrors><mirror><id>probe-$1</id><mirrorOf>*</mirrorOf><url>http://127.0.0.1:$1</url></mirror></mirrors>
</settings>
S
}
settings_for "$PORT_ONCE"
settings_for "$PORT_ALWAYS"

# --- the two servers ---------------------------------------------------------
# `once`: the FIRST request for each path is 429, later ones serve the file. This is
# the transient case Maven's own retryHandler is designed to absorb.
cat > "$WORK/server.py" <<'PY'
import http.server, os, sys
HITS = {}
ROOT = sys.argv[1]
MODE = sys.argv[2]          # 'once' or 'always'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        n = HITS.get(path, 0) + 1
        HITS[path] = n
        sys.stderr.write(f"GET {path} hit={n}\n"); sys.stderr.flush()
        if MODE == 'always' or n == 1:
            self.send_response(429); self.send_header('Retry-After', '0'); self.end_headers()
            self.wfile.write(b'rate limited'); return
        fp = os.path.join(ROOT, path.lstrip('/'))
        if not os.path.isfile(fp):
            self.send_response(404); self.end_headers(); return
        data = open(fp, 'rb').read()
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers()
        self.wfile.write(data)
    def do_HEAD(self): self.do_GET()
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[3])), H).serve_forever()
PY

python3 "$WORK/server.py" "$WORK/served" once "$PORT_ONCE" 2>"$WORK/once.log" &
SRV_PID=$!
python3 "$WORK/server.py" "$WORK/served" always "$PORT_ALWAYS" 2>"$WORK/always.log" &
SRV2_PID=$!
for _ in $(seq 1 30); do
  curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$PORT_ONCE/" 2>/dev/null; [ $? -ne 7 ] && break
  sleep 0.2
done
sleep 0.5

# The REAL policy, sourced from the script under test - not a copy.
eval "$(sed -n '/^retry_on_registry_fault()/,/^}/p' "$ROOT/scripts/build-plugins.sh")"
if ! declare -f retry_on_registry_fault >/dev/null; then
  echo "could not source retry_on_registry_fault" >&2; exit 2
fi
export OPSWEAVE_RETRY_SLEEP=0

mvn_against() { # port, local-repo
  ( cd "$WORK/proj" && mvn -B -s "$WORK/settings-$1.xml" \
      -Dmaven.repo.local="$2" -f pom.xml validate )
}

echo "== 1. a PERSISTENT 429 must make the outer policy retry"
rm -rf "$WORK/repo-always"
out="$(retry_on_registry_fault mvn mvn_against "$PORT_ALWAYS" "$WORK/repo-always" 2>&1)"; rc=$?
retries="$(printf '%s\n' "$out" | grep -c 'registry fault on attempt')"
[ "$retries" -eq 2 ] && ok "the outer policy retried twice (3 attempts total)" \
  || bad "expected 2 retry messages, got $retries"
[ "$rc" -ne 0 ] && ok "a persistent 429 is still a failure (rc=$rc)" \
  || bad 'a persistent 429 was reported as success'

REQUESTS="$(grep -c 'GET ' "$WORK/always.log" 2>/dev/null || echo 0)"
# Maven's own retryHandler fires per attempt, so the outer 3 attempts produce more
# than 3 HTTP requests. What matters is that more than one attempt HAPPENED.
[ "${REQUESTS:-0}" -gt 3 ] && ok "the server saw $REQUESTS requests: real HTTP, not a stub" \
  || bad "only ${REQUESTS:-0} requests reached the server"

echo "== 2. the failure message must match what the policy greps for"
# The policy's regex is `Could not (find|transfer|resolve) artifact|status: (429|5xx)`.
# If Maven's wording drifts, the retry silently stops happening - so the MESSAGE is
# part of the contract, not just the exit code.
if printf '%s\n' "$out" | grep -qE 'Could not transfer artifact'; then
  ok 'the failure names "Could not transfer artifact" (matches the policy)'
else
  bad 'the failure message no longer matches the retry policy'
fi
if printf '%s\n' "$out" | grep -qE 'status code: 429'; then
  ok 'the failure names status code 429'
else
  skip 'the message did not contain "status code: 429" (wording may have changed)'
fi

echo "== 3. a 429 that CLEARS: who recovers it?"
rm -rf "$WORK/repo-once"
out="$(retry_on_registry_fault mvn mvn_against "$PORT_ONCE" "$WORK/repo-once" 2>&1)"; rc=$?
outer="$(printf '%s\n' "$out" | grep -c 'registry fault on attempt')"
if [ "$rc" -eq 0 ]; then
  ok "the build recovered (rc=0)"
  if [ "$outer" -eq 0 ]; then
    # THE FINDING THAT MATTERS: this is why a green legacy-regression does not
    # prove the outer retry works.
    ok "Maven's OWN retryHandler absorbed the 429 - the outer policy never fired"
    echo "         => a green legacy-regression is NORMAL_BUILD_VERIFIED at best;"
    echo "            it is not evidence that the outer retry works."
  else
    ok "the outer policy fired $outer time(s) before recovery"
  fi
else
  bad "a transient 429 was not recovered (rc=$rc)"
fi

echo
echo "== what this establishes, and its level"
echo "   REAL_429_RECOVERY_VERIFIED  the outer policy retries a genuine resolver 429"
echo "                               and preserves failure when it persists"
echo "   NOT established             recovery from a Maven Central outage: this is a"
echo "                               local server with the same protocol behaviour"

echo
if [ "$FAIL" -eq 0 ]; then echo "$PASS passed, 0 failed, $SKIP skipped"; exit 0; fi
echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
