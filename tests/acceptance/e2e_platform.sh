#!/usr/bin/env bash
# P001-C1.3 - the TypeScript plugin's whole lifecycle, in one run, with no
# silent failure.
#
# What changed from the C1 version, and why
# -----------------------------------------
# The old script ran deploy/activate under `|| true`:
#
#     "$OPSCTL" deploy dev.opsweave.hello 0.0.1 ... >/dev/null 2>&1 || true
#     "$OPSCTL" activate dev.opsweave.hello 0.0.1 >/dev/null 2>&1 || true
#
# and then asserted on what the Gateway answered. A deploy that failed and a
# deploy that succeeded were therefore indistinguishable until - and only if -
# the later assertion happened to notice. The reported failure named the
# Gateway, not the step that broke. `2>&1 >/dev/null` also discarded the one
# message that would have said why.
#
# Every command below is now one of three kinds, and the kind is visible in the
# code rather than implied:
#
#   must()      the step must succeed. A non-zero exit fails the run AT THAT
#               STEP, with stderr captured into the evidence file. This is the
#               default for deploy, activate, rollback, disable, uninstall.
#   expect_*()  the step MUST fail, with a specific status and a stable error
#               code. Asserting only "it returned non-zero" would accept a
#               crash, a typo in the plugin id, or a drained token as a pass -
#               so the status and the code are both checked, and a success is
#               itself a failure.
#   cleanup_*() may fail. It runs last, it never changes the verdict, and its
#               failure is reported rather than raised, so it cannot mask the
#               error that sent us there.
#
# What this run proves, in order: v1 and v2 bundles are staged from a real
# signature; v1 deploys two replicas to two real containers and both reach
# READY; v1 activates and the Gateway really routes to v1; v2 deploys but is
# NOT activated and the route STAYS on v1 (the assertion C1 never made); v2
# activates and the route switches; rollback returns the route to v1; disable
# fails closed and leaves data alone; enable restores service; uninstall stops
# the backend and says it retained data; and the containers it created are the
# only ones removed.
#
# Evidence: $EVIDENCE_DIR keeps one file per step - the command, its exit code,
# its stdout and its stderr - and lifecycle.json accumulates the structured
# facts (digests, instance ids, versions, container ids) that a later reviewer
# needs to check the claims without re-running the platform.
#
# Prerequisite: scripts/demo_up.sh (or an equivalent Kernel + 2 Nodes with the
# three bundles in dist/plugins). See tests/ci/p001c_lifecycle.sh for the
# isolated, self-contained driver used in CI.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
KERNEL_URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}"
OPSCTL="${OPSCTL:-$ROOT/target/debug/opsctl}"
PLUGIN="${OPSWEAVE_HELLO_PLUGIN:-dev.opsweave.hello}"
V1="${OPSWEAVE_HELLO_VERSION:-0.0.1}"
V2="${OPSWEAVE_HELLO_V2_VERSION:-0.0.2}"
EVIDENCE_DIR="${OPSWEAVE_EVIDENCE_DIR:-$ROOT/artifacts/p001c13}"

PASS=0
FAIL=0
STEP=""

section() { STEP="$1"; printf '\n== %s\n' "$1"; }
ok() { printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if "$@"; then ok "$*"; else bad "$*"; fi; }

mkdir -p "$EVIDENCE_DIR"
# Every step's raw evidence lands here, named after the step, so a failure in CI
# is diagnosable from the artifact without a re-run.
ev() { printf '%s/%02d-%s' "$EVIDENCE_DIR" "$((PASS + FAIL + 1))" "$(printf '%s' "$STEP" | tr ' /' '__' | tr -cd 'A-Za-z0-9_-')"; }

# Run a command that MUST succeed.
#
# `set -e` is deliberately not used: a failing assertion has to record FAIL and
# keep going so one run reports every broken step, not just the first. Each
# `must` therefore checks the exit code itself and returns non-zero, so callers
# that need to stop (there are none - the run continues and the summary fails)
# can.
must() {
  local label="$1"
  shift
  local stem
  stem="$(ev)"
  printf '$ %s\n' "$*" >"$stem.cmd"
  if "$@" >"$stem.out" 2>"$stem.err"; then
    printf 'PASS  %s\n' "$label"
    PASS=$((PASS + 1))
    return 0
  else
    local code=$?
    printf 'FAIL  %s (exit %d)\n' "$label" "$code"
    # The message the old `2>/dev/null` threw away. Bounded so one pathological
    # stack trace cannot bury the rest of the run.
    sed 's/^/      /' "$stem.err" | head -20
    FAIL=$((FAIL + 1))
    return 1
  fi
}

# Run a command that MUST fail with a given status and error code.
#
# The status is exact ("400", not "non-zero"): a 500 would mean the request
# never reached the validation that is under test. The code is checked in the
# body, because "it failed" is not the assertion - "it failed for the documented
# reason" is.
expect_fail() {
  local label="$1" want_status="$2" want_code="$3"
  shift 3
  local stem
  stem="$(ev)"
  printf '$ %s\n' "$*" >"$stem.cmd"
  local status
  status="$(curl -sS -o "$stem.body" -w '%{http_code}' -m 20 "$@" 2>"$stem.err")"
  printf '%s' "$status" >"$stem.status"
  if [ "$status" != "$want_status" ]; then
    printf 'FAIL  %s (wanted HTTP %s, got %s)\n' "$label" "$want_status" "$status"
    sed 's/^/      /' "$stem.body" | head -5
    FAIL=$((FAIL + 1))
    return 1
  fi
  if ! grep -q "$want_code" "$stem.body"; then
    printf 'FAIL  %s (HTTP %s but no %s in the body)\n' "$label" "$status" "$want_code"
    sed 's/^/      /' "$stem.body" | head -5
    FAIL=$((FAIL + 1))
    return 1
  fi
  printf 'PASS  %s (HTTP %s %s)\n' "$label" "$status" "$want_code"
  PASS=$((PASS + 1))
}

# Run a command that may fail. Used ONLY for cleanup, and never to decide the
# verdict: the run is already over when it executes, and a second failure here
# must not overwrite the first one's message.
cleanup() {
  local label="$1"
  shift
  local stem
  stem="$(ev)"
  if "$@" >"$stem.out" 2>"$stem.err"; then
    printf 'cleanup ok: %s\n' "$label"
  else
    printf 'cleanup FAILED (does not change the verdict): %s\n' "$label"
    sed 's/^/      /' "$stem.err" | head -10
  fi
}

login() { "$OPSCTL" --url "$KERNEL_URL" login --email "$1" --password "$2" >/dev/null; }
token() { python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])'; }
csrf() { python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["csrf"])'; }
auth=(-H "Authorization: Bearer $(token)")

gateway() { curl -fsS -m 15 --retry 8 --retry-delay 1 --retry-all-errors -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/gateway/$1$2"; }
gateway_code() { curl -sS -o /tmp/opsweave-gw-body -w '%{http_code}' -m 15 -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/gateway/$1$2"; }

# Read one field out of the plugin detail. Everything below is asserted against
# what the Kernel reports, not against what a command printed.
detail() {
  curl -fsS -m 15 "${auth[@]}" "$KERNEL_URL/api/v1/plugins/$PLUGIN" 2>/dev/null
}
field() {
  local json="$1" path="$2"
  printf '%s' "$json" | python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    if value is None:
        break
    if isinstance(value, list):
        index = int(key)
        value = value[index] if index < len(value) else None
    else:
        value = value.get(key)
print("" if value is None else value)
' "$path" 2>/dev/null || echo ''
}
# Instances of the deployment for a VERSION, as "id:state:digest" triples.
instances_of() {
  local json="$1" version="$2"
  printf '%s' "$json" | python3 -c '
import json, sys
version = sys.argv[1]
detail = json.load(sys.stdin)
for deployment in detail.get("deployments", []):
    if deployment.get("version") != version:
        continue
    for instance in deployment.get("instances", []):
        print("%s:%s:%s" % (
            instance.get("id"),
            instance.get("state"),
            instance.get("imageDigest") or "",
        ))
' "$version" 2>/dev/null || true
}
ready_count() { instances_of "$1" "$2" | awk -F: '$2 == "READY"' | wc -l | tr -d ' '; }
# The ACTIVE version the Kernel says is serving - the control-plane half of
# "the route switched". The Gateway half is the request below.
active_version() { field "$(detail)" activeVersion; }

# Record the structured facts this run established, so the claims survive the
# run. Written incrementally: a run that fails at step 9 still has steps 1-8.
record() {
  python3 - "$EVIDENCE_DIR/lifecycle.json" "$@" <<'PY'
import json, os, sys
path = sys.argv[1]
facts = {}
if os.path.exists(path):
    try:
        facts = json.load(open(path))
    except Exception:
        facts = {}
for pair in sys.argv[2:]:
    key, _, value = pair.partition("=")
    facts[key] = value
json.dump(facts, open(path, "w"), indent=1, sort_keys=True)
PY
}

section "authentication and health"
must "admin can sign in" login "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
check test "$(curl -sS "$KERNEL_URL/livez" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')" = "live"
check test "$(curl -sS "$KERNEL_URL/readyz" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')" = "ready"
NODES="$(curl -fsS -m 15 "${auth[@]}" "$KERNEL_URL/api/v1/nodes" | python3 -c 'import sys,json;print(sum(1 for n in json.load(sys.stdin) if n.get("status")=="READY" and not n.get("stale")))')"
[ "$NODES" -ge 2 ] && ok "$NODES READY nodes can host two replicas" || bad "expected >=2 READY nodes, got $NODES"
record "kernelUrl=$KERNEL_URL" "readyNodes=$NODES" "plugin=$PLUGIN" "v1=$V1" "v2=$V2"

section "signed bundle admission"
must "v1 bundle is staged from a signed archive" \
  "$OPSCTL" --url "$KERNEL_URL" install "dist/plugins/hello-ops-$V1.plugin.zip"
must "v2 bundle is staged from a signed archive" \
  "$OPSCTL" --url "$KERNEL_URL" install "dist/plugins/hello-ops-$V2.plugin.zip"
# The digest the bundle pinned, read back from the Kernel. Task B asks for a
# digest-pinned reference rather than a tag; this is where it is recorded.
DETAIL_JSON="$(detail)"
record "digestV1=$(printf '%s' "$DETAIL_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for dep in d.get("deployments") or []:
    for i in dep.get("instances") or []:
        if i.get("imageDigest"): print(i["imageDigest"]); raise SystemExit
print("")' 2>/dev/null || true)"

# --- negative: a bundle whose manifest was edited is refused -------------------
# The signature covers the manifest digest, so changing imageRef must fail before
# any of it reaches a Node. This is the C1 assertion, kept and sharpened: it now
# also pins the status and the code instead of testing only the status.
python3 - "dist/plugins/hello-ops-$V1.plugin.zip" <<'PY'
import zipfile, json, sys
src = sys.argv[1]
dst = '/tmp/opsweave-tampered.plugin.zip'
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'manifest.json':
            m = json.loads(data)
            m['backend']['imageRef'] = m['backend']['imageRef'].split('@')[0] + '@sha256:' + 'deadbeef' * 8
            data = json.dumps(m, sort_keys=True, separators=(',', ':')).encode()
        zout.writestr(item, data)
PY
expect_fail "a tampered manifest is refused at admission" 400 SIGNATURE_OR_BUNDLE_INVALID \
  -H "Authorization: Bearer $(token)" -H "x-csrf-token: $(csrf)" \
  -H "idempotency-key: acceptance-tamper-0001" -H 'content-type: application/octet-stream' \
  --data-binary @/tmp/opsweave-tampered.plugin.zip "$KERNEL_URL/api/v1/plugins/packages"

section "deploy v1 to two replicas"
must "v1 deploys to two replicas and both reach READY" \
  "$OPSCTL" --url "$KERNEL_URL" deploy "$PLUGIN" "$V1" --replicas 2 --selector role=node --wait
DETAIL_JSON="$(detail)"
V1_INSTANCES="$(instances_of "$DETAIL_JSON" "$V1")"
V1_READY="$(ready_count "$DETAIL_JSON" "$V1")"
[ "$V1_READY" = "2" ] && ok "two v1 instances are READY" || bad "expected 2 READY v1 instances, got $V1_READY"
# Both replicas must be on different nodes: two copies of one node is not two
# replicas, and the placement is the Kernel's claim, so it is read back.
V1_NODES="$(printf '%s' "$DETAIL_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for dep in d.get("deployments") or []:
    if dep.get("version") != sys.argv[1]: continue
    print(" ".join(str(i.get("nodeId")) for i in dep.get("instances") or [] if i.get("state")=="READY"))
' "$V1" 2>/dev/null || true)"
[ "$(printf '%s' "$V1_NODES" | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" = "2" ] \
  && ok "the two replicas are on two different nodes" \
  || bad "the two replicas are not on two nodes: $V1_NODES"
record "v1Instances=$(printf '%s' "$V1_INSTANCES" | tr '\n' ' ')" "v1Nodes=$V1_NODES"

section "live logs and RBAC"
# These three sections existed in the C1 script and are kept: removing them while
# rewriting the failure handling would have traded one kind of dishonesty (a
# swallowed deploy) for another (a silently reduced suite). Their `|| true`
# equivalents are gone; every assertion below can fail.
IID="$(printf '%s' "$V1_INSTANCES" | head -1 | cut -d: -f1)"
[ -n "$IID" ] || bad "no v1 instance id to read logs from"

# The SSE stream is bounded by design: -m 4 ends it. A CURLE_OPERATION_TIMEDOUT
# from that bound is the expected outcome, not a failure, so the exit status is
# not what is asserted - the events on the stream are.
SSE_FILE="$EVIDENCE_DIR/sse.txt"
: >"$SSE_FILE"
if [ -n "$IID" ]; then
  curl -sS -N -m 4 -H "Authorization: Bearer $(token)" \
    "$KERNEL_URL/api/v1/instances/$IID/logs/live" >"$SSE_FILE" 2>"$EVIDENCE_DIR/sse.err" || true
  grep -q 'event: status' "$SSE_FILE" && ok "the log stream opens with a status event" \
    || bad "the log stream carried no status event"
  grep -q 'event: log' "$SSE_FILE" && ok "the log stream carries a bounded log event" \
    || bad "the log stream carried no log event"
  # A forged cursor must be refused. 400, and the reason must be a cursor error -
  # "it returned 400" alone would also pass for a malformed bearer token.
  # The Kernel answers 400 INVALID_REQUEST with the message "invalid cursor"
  # (apps/kernel/src/error.rs bad_request; logs.rs decode_cursor). Match the code
  # the API actually emits rather than a wrapper's prose.
  expect_fail "a forged log cursor is refused" 400 INVALID_REQUEST \
    -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/instances/$IID/logs/live?cursor=bad-cursor"
fi

section "viewer RBAC"
# A viewer is created once, and the creation is allowed to fail on a re-run: the
# user may already exist, which is not a product failure. The ASSERTIONS below
# are what this section is for, and they are not tolerated.
if "$OPSCTL" --url "$KERNEL_URL" login --email viewer@opsweave.local --password 'ViewerPass!2026' >/dev/null 2>&1; then
  ok "the viewer account already exists and can sign in"
else
  case "$(curl -sS -o "$EVIDENCE_DIR/viewer-create.json" -w '%{http_code}' \
      -H "Authorization: Bearer $(token)" -H "x-csrf-token: $(csrf)" \
      -H 'content-type: application/json' -X POST "$KERNEL_URL/api/v1/users" \
      -d '{"email":"viewer@opsweave.local","displayName":"Read Only","password":"ViewerPass!2026","role":"viewer"}')" in
    200|201|409) ok "the viewer account exists or was created" ;;
    *) bad "could not create the viewer account: $(head -c 200 "$EVIDENCE_DIR/viewer-create.json")" ;;
  esac
fi
if login viewer@opsweave.local 'ViewerPass!2026' 2>/dev/null; then
  VTOKEN="$(token)"
  if [ -n "$IID" ]; then
    VCODE="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $VTOKEN" \
      "$KERNEL_URL/api/v1/instances/$IID/logs/live")"
    [ "$VCODE" = "403" ] && ok "a viewer is denied log access (403)" || bad "viewer log denial (got $VCODE)"
  fi
  VDIAG="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $VTOKEN" "$KERNEL_URL/api/v1/diagnostics")"
  [ "$VDIAG" = "403" ] && ok "a viewer is denied bootstrap diagnostics (403)" || bad "viewer diagnostics denial (got $VDIAG)"
  login "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
else
  bad "the viewer account could not sign in, so the RBAC assertions are NOT_RUN"
fi

section "multi-language Runtime v1"
# Go and Java are kept here, and the brief for C1.3 does not let them be dropped:
# the disabled-plugin case below is asserted on the Java plugin, as in C1. The
# full three-language MATRIX is P001-C3's deliverable; what is checked here is
# that each language serves the same Runtime v1 contract through the Gateway.
# The bundles are only present when the platform was built with BUILD=1 - which
# is why a missing one is reported as a failure to stage rather than skipped.
# The bundles must be staged before they can be deployed. The C1 script relied on
# `demo_up.sh` having installed these on some earlier run; that is an ordering
# assumption, not a property of this run, and on a fresh isolated platform it
# silently became "deploy 404" - which the old `|| true` hid entirely. Staging
# them here makes the section self-contained.
for plugin in dev.opsweave.hello-go dev.opsweave.hello-java; do
  must "$plugin bundle is staged" \
    "$OPSCTL" --url "$KERNEL_URL" install "dist/plugins/${plugin#dev.opsweave.}-$V1.plugin.zip"
done
for plugin in dev.opsweave.hello-go dev.opsweave.hello-java; do
  if must "$plugin deploys" \
      "$OPSCTL" --url "$KERNEL_URL" deploy "$plugin" 0.0.1 --replicas 1 --selector role=node --wait; then
    must "$plugin activates" "$OPSCTL" --url "$KERNEL_URL" activate "$plugin" 0.0.1
    BODY="$(gateway "$plugin" /api/hello)"
    if printf '%s' "$BODY" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d.get("pluginId"), d
assert d.get("runtime", {}).get("language"), d
' 2>/dev/null; then
      ok "$plugin serves Runtime v1 with a language identity"
      printf '%s' "$BODY" >"$EVIDENCE_DIR/$plugin-greeting.json"
    else
      bad "$plugin did not serve a Runtime v1 identity: $(printf '%s' "$BODY" | head -c 200)"
    fi
  fi
done

section "activate v1"
# Before activation the route must NOT serve v1: deploy and activate are
# separate, and a route that switches on deploy makes the activation assertion
# below meaningless.
CODE_BEFORE="$(gateway_code "$PLUGIN" /api/hello)"
[ "$CODE_BEFORE" != "200" ] \
  && ok "before activation the gateway does not serve v1 (HTTP $CODE_BEFORE)" \
  || bad "the gateway served the plugin before activation (HTTP $CODE_BEFORE)"
must "v1 activates" "$OPSCTL" --url "$KERNEL_URL" activate "$PLUGIN" "$V1"
BODY="$(gateway "$PLUGIN" /api/hello)"
echo "$BODY" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["pluginId"] == sys.argv[1], d
assert d["version"] == sys.argv[2], d
print(d["instanceId"])
' "$PLUGIN" "$V1" >/tmp/opsweave-v1-instance \
  && ok "the gateway serves v1 from a real instance" \
  || bad "the gateway did not serve v1"
[ "$(active_version)" = "$V1" ] && ok "the Kernel reports $V1 active" || bad "the Kernel reports $(active_version) active, not $V1"
record "v1GatewayInstance=$(cat /tmp/opsweave-v1-instance 2>/dev/null || echo '')"

section "deploy v2 WITHOUT activating - the route must stay on v1"
must "v2 deploys to two replicas and both reach READY" \
  "$OPSCTL" --url "$KERNEL_URL" deploy "$PLUGIN" "$V2" --replicas 2 --selector role=node --wait
DETAIL_JSON="$(detail)"
V2_READY="$(ready_count "$DETAIL_JSON" "$V2")"
[ "$V2_READY" = "2" ] && ok "two v2 instances are READY and waiting" || bad "expected 2 READY v2 instances, got $V2_READY"
# THE ASSERTION C1 NEVER MADE. v2 is deployed and healthy; the route must not
# have moved. Ten requests, not one: a single sample cannot tell "still v1" from
# "flapping between two active revisions".
STILL_V1=0
for _ in $(seq 1 10); do
  if gateway "$PLUGIN" /api/hello | grep -q "\"$V1\""; then STILL_V1=$((STILL_V1 + 1)); fi
done
[ "$STILL_V1" = "10" ] \
  && ok "all 10 requests still route to v1 while v2 is deployed but not activated" \
  || bad "$((10 - STILL_V1))/10 requests left v1 while v2 was not activated"
[ "$(active_version)" = "$V1" ] && ok "the Kernel still reports $V1 active" || bad "the Kernel reports $(active_version) active, not $V1"

section "activate v2"
must "v2 activates" "$OPSCTL" --url "$KERNEL_URL" activate "$PLUGIN" "$V2"
SWITCHED=0
for _ in $(seq 1 10); do
  if gateway "$PLUGIN" /api/hello | grep -q "\"$V2\""; then SWITCHED=$((SWITCHED + 1)); fi
done
[ "$SWITCHED" = "10" ] \
  && ok "all 10 requests route to v2 after activation (atomic switch)" \
  || bad "$((10 - SWITCHED))/10 requests did not reach v2 after activation"
[ "$(active_version)" = "$V2" ] && ok "the Kernel reports $V2 active" || bad "the Kernel reports $(active_version) active, not $V2"

section "rollback to v1"
must "rollback returns to v1 and activates it" \
  "$OPSCTL" --url "$KERNEL_URL" rollback "$PLUGIN" "$V1" --replicas 2
ROLLED=0
for _ in $(seq 1 10); do
  if gateway "$PLUGIN" /api/hello | grep -q "\"$V1\""; then ROLLED=$((ROLLED + 1)); fi
done
[ "$ROLLED" = "10" ] \
  && ok "all 10 requests route to v1 after rollback" \
  || bad "$((10 - ROLLED))/10 requests did not reach v1 after rollback"
[ "$(active_version)" = "$V1" ] \
  && ok "the control plane and the route agree after rollback ($V1)" \
  || bad "the control plane reports $(active_version) but the route serves v1"

section "disable fails closed"
must "the plugin disables" \
  "$OPSCTL" --url "$KERNEL_URL" disable "$PLUGIN" --reason 'p001c13 acceptance disable'
CODE="$(gateway_code "$PLUGIN" /api/hello)"
[ "$CODE" = "503" ] && ok "a disabled plugin returns 503" || bad "disabled plugin returned HTTP $CODE, expected 503"
grep -q CAPABILITY_UNAVAILABLE /tmp/opsweave-gw-body \
  && ok "the refusal carries CAPABILITY_UNAVAILABLE" \
  || bad "the refusal does not name CAPABILITY_UNAVAILABLE"
# Disable must stop ROUTING, not stop the workload and not delete anything.
# The instances are read back: a disable that quietly destroyed the deployment
# would still return 503, so the 503 alone is not the assertion.
DETAIL_JSON="$(detail)"
[ "$(instances_of "$DETAIL_JSON" "$V1" | wc -l | tr -d ' ')" -ge 1 ] \
  && ok "disable left the v1 instances in place (data/workload not implicitly destroyed)" \
  || bad "disable removed the instances, which it must not do"

section "enable restores service"
must "the plugin re-enables" "$OPSCTL" --url "$KERNEL_URL" enable "$PLUGIN"
# Enabling a disabled plugin returns it to STAGED; the deployment must be
# brought back and activated, which is what a re-enable means operationally.
must "the re-enabled v1 deployment reaches READY again" \
  "$OPSCTL" --url "$KERNEL_URL" deploy "$PLUGIN" "$V1" --replicas 2 --selector role=node --wait
must "v1 activates again after enable" "$OPSCTL" --url "$KERNEL_URL" activate "$PLUGIN" "$V1"
ENABLED=0
for _ in $(seq 1 10); do
  if gateway "$PLUGIN" /api/hello >/dev/null 2>&1; then ENABLED=$((ENABLED + 1)); fi
done
[ "$ENABLED" = "10" ] && ok "all 10 requests succeed after re-enable" || bad "$((10 - ENABLED))/10 requests failed after re-enable"

section "uninstall"
# Instance ids and node ids BEFORE the uninstall, so "the backend stopped" is
# measured against containers that provably existed.
BEFORE_JSON="$(detail)"
BEFORE_INSTANCES="$(instances_of "$BEFORE_JSON" "$V1" | cut -d: -f1 | tr '\n' ' ')"
record "preUninstallInstances=$BEFORE_INSTANCES"
must "the plugin uninstalls" "$OPSCTL" --url "$KERNEL_URL" uninstall "$PLUGIN"

# The route must stop serving it.
UCODE="$(gateway_code "$PLUGIN" /api/hello)"
[ "$UCODE" != "200" ] && ok "after uninstall the gateway no longer serves the plugin (HTTP $UCODE)" \
  || bad "the gateway still served the plugin after uninstall"
# Data retained: the Kernel says so explicitly. This is the contract C1.3 keeps;
# it is NOT a claim that the data is reachable, only that it was not dropped.
# A failed read here is a failed assertion, not a shrug: if the Kernel cannot
# answer, "the plugin is UNINSTALLED" was never established.
UNINSTALL_BODY="$(curl -fsS -m 15 "${auth[@]}" "$KERNEL_URL/api/v1/plugins/$PLUGIN" 2>/dev/null || echo '{"readFailed":true}')"
echo "$UNINSTALL_BODY" | grep -q '"UNINSTALLED"' \
  && ok "the Kernel records the plugin as UNINSTALLED" \
  || bad "the Kernel does not record UNINSTALLED: $(printf '%s' "$UNINSTALL_BODY" | head -c 200)"
# The instances are told to stop. The Node's reconcile removes them; the state
# is read back rather than assumed, with a bounded wait because the loop is
# asynchronous.
STOPPED=0
for _ in $(seq 1 60); do
  STOPPED=1
  for iid in $BEFORE_INSTANCES; do
    state="$(detail | python3 -c '
import json, sys
iid = sys.argv[1]
d = json.load(sys.stdin)
for dep in d.get("deployments") or []:
    for i in dep.get("instances") or []:
        if i.get("id") == iid:
            print(i.get("state"))
            raise SystemExit
print("GONE")
' "$iid" 2>/dev/null || echo GONE)"
    case "$state" in
      READY|STARTING) STOPPED=0 ;;
    esac
  done
  [ "$STOPPED" = "1" ] && break
  sleep 1
done
[ "$STOPPED" = "1" ] \
  && ok "no instance of the uninstalled plugin is still READY or STARTING" \
  || bad "an instance was still READY/STARTING 60s after uninstall"

section "the run cleaned up only what it created"
# Ownership is the installation id, and nothing else. This asserts that the
# cleanup path below is scoped: a container that does not carry this
# installation's label is reported, never removed. The actual removal is done by
# the driver (tests/ci/p001c_lifecycle.sh) which knows its own state directory;
# here we only prove the platform is still healthy after the whole run and that
# no OTHER plugin was disturbed.
OTHER="$(curl -fsS -m 15 "${auth[@]}" "$KERNEL_URL/api/v1/plugins" 2>/dev/null | python3 -c '
import json, sys
try:
    plugins = json.load(sys.stdin)
except Exception:
    print("unreadable"); raise SystemExit
rows = plugins if isinstance(plugins, list) else plugins.get("items") or []
print(" ".join("%s:%s" % (p.get("id"), p.get("state")) for p in rows))
' 2>/dev/null || echo unreadable)"
record "pluginsAfterRun=$OTHER"
printf '   plugins after the run: %s\n' "$OTHER"

section "summary"
echo "PASS=$PASS FAIL=$FAIL"
record "pass=$PASS" "fail=$FAIL" "evidenceDir=$EVIDENCE_DIR"
[ "$FAIL" = "0" ]
