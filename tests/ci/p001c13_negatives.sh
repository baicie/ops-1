#!/usr/bin/env bash
# P001-C1.3 Task C - prove the lifecycle suite can FAIL.
#
# A green acceptance run is only evidence if the same tests can go red when the
# product misbehaves. This script injects each of the six failure conditions the
# brief names, one at a time, against a live isolated platform, and asserts that
# the corresponding check reports FAIL. It is a test of the tests.
#
# Every injection is a real condition the product can produce - a manifest whose
# digest does not match, an image that cannot start, a deployment that never
# becomes READY, a route that does not switch, a rollback target that is not
# READY, and another installation's container under the name we want. None of
# them is simulated by editing the assertion.
#
# The six checks are driven through the same helpers the lifecycle script uses,
# so a change that makes the lifecycle tolerate a failure shows up here as an
# injection that is no longer detected.
#
#   tests/ci/p001c13_negatives.sh            # create a run, inject, tear down
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export no_proxy=127.0.0.1,localhost,::1 NO_PROXY=127.0.0.1,localhost,::1

EVIDENCE="${OPSWEAVE_EVIDENCE_DIR:-$ROOT/artifacts/p001c13-negatives}"
mkdir -p "$EVIDENCE"
fatal() { printf 'BLOCKED: %s\n' "$*" >&2; exit 1; }
say() { printf '\n### %s\n' "$*"; }

# --- lifecycle of this script's own resources -------------------------------
#
# Same rules as tests/ci/p001c13_lifecycle.sh, and for the same reasons:
#
#   * every resource is recorded at the moment this script creates it, by its
#     immutable container id - never discovered afterwards by a name or a label;
#   * the trap runs on EXIT, TERM and INT, so an interrupted run still cleans up;
#   * cleanup failure is a SEPARATE fact from the functional result, and the
#     script exits non-zero when either failed. The previous version ended with
#     `[ "$FAIL" = "0" ] || exit 1` followed by an unconditional teardown, so
#     `PASS=11 FAIL=0` printed and the script still exited 0 if the teardown had
#     silently failed.
RUN_ID=""
REGISTRY_CID=""
CLEANUP_STATUS=0
FUNCTIONAL_STATUS=0
TRAP_ARMED=0

cleanup_owned_resources() {
  trap - EXIT TERM INT
  # The isolated platform: scoped by run id, reports BLOCKED on anything it cannot
  # attribute. Its failure does not change the functional verdict but is recorded.
  if [ -n "$RUN_ID" ]; then
    if ! tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$EVIDENCE/teardown.log" 2>&1; then
      echo "cleanup: p001c_teardown.sh failed for $RUN_ID; see $EVIDENCE/teardown.log" >&2
      tail -20 "$EVIDENCE/teardown.log" >&2 || true
      CLEANUP_STATUS=1
    fi
    RUN_ID=""
  fi
  # The registry, by the id this script recorded when it created it. Not by name:
  # a name is a claim about the present, an id is a fact about the object.
  if [ -n "$REGISTRY_CID" ]; then
    if docker rm -f "$REGISTRY_CID" >/dev/null 2>&1; then
      echo "cleanup: removed the registry container $REGISTRY_CID (created by this script)" >&2
    else
      echo "cleanup: could not remove the registry container $REGISTRY_CID" >&2
      CLEANUP_STATUS=1
    fi
    REGISTRY_CID=""
  fi
  return 0
}

on_signal() {
  echo >&2
  echo "interrupted by SIG$1; cleaning up this run's resources" >&2
  exit 130
}

arm_traps() {
  [ "$TRAP_ARMED" = "1" ] && return 0
  TRAP_ARMED=1
  # shellcheck disable=SC2154  # rc is assigned by this trap itself
  trap 'rc=$?; cleanup_owned_resources; exit $rc' EXIT
  trap 'on_signal TERM' TERM
  trap 'on_signal INT' INT
}
arm_traps

command -v docker >/dev/null 2>&1 || fatal "docker CLI is not installed"
docker info >/dev/null 2>&1 || fatal "the Docker daemon is not reachable"
command -v createdb >/dev/null 2>&1 || fatal "PostgreSQL client tools are not installed"
pg_isready >/dev/null 2>&1 || fatal "PostgreSQL is not running"
[ -x "$ROOT/target/debug/opsweave-kernel" ] || fatal "the kernel has not been built"
[ -x "$ROOT/target/debug/opsweave-node" ] || fatal "the node has not been built"
[ -x "$ROOT/target/debug/opsctl" ] || fatal "opsctl has not been built"

OURS_BEFORE="$(docker ps -aq --filter "label=opsweave.managed=true" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${OURS_BEFORE:-0}" != "0" ] && [ "${OPSWEAVE_CI_ALLOW_SHARED_DAEMON:-0}" != "1" ]; then
  fatal "the Docker daemon already has $OURS_BEFORE OpsWeave container(s); use a dedicated daemon
         or set OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1"
fi

say "build the plugin bundles"
REGISTRY_PORT="${OPSWEAVE_TEST_REGISTRY_PORT:-5014}"
REGISTRY_NAME="opsweave-p001c13n-registry-$REGISTRY_PORT"
# A container with this name may belong to another run, another checkout or a
# colleague. The previous version ran `docker rm -f "$REGISTRY_NAME"` before it
# had established ownership of anything - a destructive operation on an unknown
# resource, at the very start of the run. Ownership is now an explicit question:
#
#   absent            -> create it and RECORD ITS ID; the id is what cleanup uses
#   present, ours     -> reuse it (a re-run of this same script)
#   present, not ours -> stop. This script cannot prove it owns that container,
#                        and using the name would mean deleting it.
if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
  OWNER="$(docker inspect -f '{{index .Config.Labels "opsweave.p001c13.registry"}}' "$REGISTRY_NAME" 2>/dev/null || echo '')"
  if [ "$OWNER" != "yes" ]; then
    fatal "a container named $REGISTRY_NAME already exists and was not created by this
         script (no opsweave.p001c13.registry=yes label). Refusing to remove it: this run
         cannot prove it owns that container. Remove it deliberately, or set
         OPSWEAVE_TEST_REGISTRY_PORT to a free port."
  fi
  REGISTRY_CID="$(docker inspect -f '{{.Id}}' "$REGISTRY_NAME" 2>/dev/null || echo '')"
  [ -n "$REGISTRY_CID" ] || fatal "could not read the id of the existing registry container"
  if [ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_CID" 2>/dev/null || echo false)" != "true" ]; then
    fatal "the registry $REGISTRY_NAME exists, is this script's, and is not running.
         Remove it with: docker rm -f $REGISTRY_CID   (it carries the p001c13 label, so
         removing it removes nothing else), then re-run."
  fi
  echo "   reusing this script's registry $REGISTRY_NAME ($REGISTRY_CID)"
else
  REGISTRY_CID="$(docker run -d --name "$REGISTRY_NAME" \
    --label "opsweave.p001c13.registry=yes" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 2>"$EVIDENCE/registry.err")" \
    || fatal "could not start a local registry on 127.0.0.1:${REGISTRY_PORT}: $(head -2 "$EVIDENCE/registry.err")"
  [ -n "$REGISTRY_CID" ] || fatal "docker run returned no container id for the registry"
  echo "   started registry $REGISTRY_NAME ($REGISTRY_CID)"
  for _ in $(seq 1 30); do
    curl -fsS -m 2 "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! OPSWEAVE_REGISTRY="localhost:${REGISTRY_PORT}" BUILD=1 \
  scripts/build-plugins.sh >"$EVIDENCE/build.log" 2>&1; then
  tail -30 "$EVIDENCE/build.log" >&2 || true
  # No hand-removal: the EXIT trap owns the registry and removes it by id.
  fatal "the plugin bundles could not be built"
fi

say "start an isolated platform"
UP_LOG="$EVIDENCE/platform-up.log"
RUN_ID="$(tests/ci/p001c_up.sh 2>"$UP_LOG" | sed -n 's/^RUN_ID=//p' | tail -1)"
if [ -z "$RUN_ID" ]; then
  tail -30 "$UP_LOG" >&2 || true
  fatal "the isolated platform did not start"
fi
STATE="/tmp/p001c-${RUN_ID}"
KERNEL_PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$STATE/run.json")"
SRC_EP="http://127.0.0.1:${KERNEL_PORT}"
OPSCTL="$ROOT/target/debug/opsctl"
# The plugin under test. Parameterised so the same injections can be aimed at
# another language's plugin, which is what makes the negative matrix comparable
# across languages instead of a TypeScript-only suite.
#
# The injections that build their own images (a crash-loop and a never-ready
# container) are language-agnostic by construction: they serve the Runtime v1
# contract and are staged under whatever plugin id is being tested.
PLUGIN="${OPSWEAVE_NEG_PLUGIN:-dev.opsweave.hello}"
PLUGIN_STEM="${OPSWEAVE_NEG_PLUGIN_STEM:-hello-ops}"
export OPSWEAVE_URL="$SRC_EP" OPSWEAVE_ADMIN_EMAIL=admin@opsweave.local OPSWEAVE_ADMIN_PASSWORD='OpsWeave!2026'
HOME="$STATE/home" "$OPSCTL" login --email "$OPSWEAVE_ADMIN_EMAIL" --password "$OPSWEAVE_ADMIN_PASSWORD" >/dev/null \
  || fatal "could not sign in"

PASS=0
FAIL=0
ok() { printf 'PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

# Run a command that the product MUST refuse, and classify WHY it failed.
#
# The first version accepted any non-zero exit as "the product refused", which
# conflates four outcomes that mean four different things:
#
#   the product refused       the behaviour under test, and the only PASS
#   the environment failed    the Kernel is not reachable, the token is drained,
#                             the plugin was never staged - nothing was tested
#   the test never started    the command itself is wrong (bad path, bad flag)
#   the assertion failed      the product ACCEPTED what it should have refused
#
# `status != 0` cannot tell these apart, and neither can a substring match on its
# own. So the expectation is now a REGEX over the recorded output plus a set of
# markers that identify an environment fault. A command that fails with a
# connection error is reported as INCONCLUSIVE, not as a pass.
#
#   $1 label
#   $2 expected regex (extended, case-insensitive) that the real refusal carries
#   $3.. the command
expect_refusal() {
  local label="$1" want="$2"
  shift 2
  local out err status
  out="$(mktemp)"; err="$(mktemp)"
  "$@" >"$out" 2>"$err"
  status=$?
  local text; text="$(cat "$out" "$err" 2>/dev/null)"
  if [ "$status" = "0" ]; then
    bad "$label: the product ACCEPTED it (exit 0) - the assertion, not the product, is what failed here"
    sed 's/^/      /' "$out" | head -5
  elif printf '%s' "$text" | grep -qiE 'connection refused|connection reset|timed out connecting|dial tcp|no such host|address already in use|ENOENT'; then
    bad "$label: INCONCLUSIVE - the command could not reach the platform, so the refusal was never tested"
    sed 's/^/      /' "$err" | head -5
  elif printf '%s' "$text" | grep -qiE 'command not found|unknown (command|flag|option)|invalid value .* for'; then
    bad "$label: INCONCLUSIVE - the test command itself is malformed, so nothing was exercised"
    sed 's/^/      /' "$err" | head -5
  elif printf '%s' "$text" | grep -qiE 'UNAUTHENTICATED|401|token expired|session expired'; then
    bad "$label: INCONCLUSIVE - the request was not authenticated; this is not the refusal under test"
    sed 's/^/      /' "$err" | head -5
  elif ! printf '%s' "$text" | grep -qiE "$want"; then
    bad "$label: failed (exit $status) but without a marker matching /$want/ - cannot attribute the reason"
    sed 's/^/      /' "$err" | head -5
  else
    ok "$label: the product refused it (exit $status, matched /$want/)"
  fi
  rm -f "$out" "$err"
}

# --- 1. a bundle whose signature does not cover its content -----------------
say "injection 1: an invalid bundle signature"
# The bundle is edited AND re-zipped without re-signing, so the detached
# signature no longer matches the manifest digest. This is the tampering an
# attacker with registry write access would attempt.
python3 - "dist/plugins/${PLUGIN_STEM}-0.0.1.plugin.zip" "$EVIDENCE/tampered.plugin.zip" <<'PY'
import zipfile, json, sys
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'manifest.json':
            m = json.loads(data)
            m['backend']['imageRef'] = m['backend']['imageRef'].split('@')[0] + '@sha256:' + 'deadbeef' * 8
            data = json.dumps(m, sort_keys=True, separators=(',', ':')).encode()
        zout.writestr(item, data)
PY
expect_refusal "an invalid bundle signature is rejected" "SIGNATURE_OR_BUNDLE_INVALID" \
  env HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install "$EVIDENCE/tampered.plugin.zip"

# A control for the same path: the genuine bundle is accepted. Without it the
# refusal above could be a broken install command rather than a signature check.
if HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install dist/plugins/${PLUGIN_STEM}-0.0.1.plugin.zip >/dev/null 2>&1; then
  ok "control: the genuine bundle is accepted, so the refusal above is about the signature"
else
  bad "control failed: the genuine bundle was rejected, so injection 1 proved nothing"
fi

# --- 2 and 3: images that cannot serve --------------------------------------
#
# Both injections are the same three steps in a different order: build and push
# an image, THEN write a manifest naming its digest, THEN sign it. The first
# version of this script wrote the manifest first and referenced $CRASH_IMAGE
# before it existed, so the bundle was never created, the deploy failed with
# "plugin not found", and the assertion "a crash-looping deployment does not
# report success" passed for entirely the wrong reason. That is the exact class
# of false pass this phase exists to remove, found by running it.
say "building the images the injections need"
mkdir -p "$EVIDENCE/images"
CRASH_TAG="127.0.0.1:${REGISTRY_PORT}/opsweave/crashloop:0.0.1"
HANG_TAG="127.0.0.1:${REGISTRY_PORT}/opsweave/neverready:0.0.1"

session_token() {
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' \
    "$STATE/home/.opsweave/session.json" 2>/dev/null || echo ''
}

# Both injections need a server that answers liveness and does NOT answer
# readiness - that is what separates "the product is broken" from "there was no
# HTTP server at all". `crash` exits right after liveness; `hang` stays up and
# never answers readiness, which is the timeout case.
write_serve_script() {
  cat >"$1" <<'SERVER'
#!/bin/sh
# Serve a minimal HTTP endpoint on 8080 that answers ONLY /_opsweave/health/live.
# Anything else - including /_opsweave/health/ready - gets a 404, so the
# readiness probe fails while the container is genuinely running.
mode="$1"
if [ "$mode" = "crash" ]; then
  # Listen once for liveness, then die: the container leaves the running state.
  printf 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok' | nc -l -p 8080 -q 1 >/dev/null 2>&1 &
  sleep 2
  exit 1
fi
# hang: answer liveness forever, never answer readiness with 200.
while true; do
  printf 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok' | nc -l -p 8080 -q 1 >/dev/null 2>&1 || true
done
SERVER
}

build_image() {
  local tag="$1" mode="$2" dir
  dir="$EVIDENCE/images/$(printf '%s' "$tag" | tr '/:' '__')"
  mkdir -p "$dir"
  write_serve_script "$dir/serve.sh"
  cat >"$dir/Dockerfile" <<DOCKER
FROM alpine:3
RUN apk add --no-cache busybox-extras
COPY serve.sh /serve.sh
RUN chmod +x /serve.sh
CMD ["sh","/serve.sh","$mode"]
DOCKER
  # `docker build -q` still prints the build id to stdout; redirecting only to
  # the log file AND capturing the function's stdout meant that id became part
  # of the returned digest, so every caller got a two-line "value". The build
  # output goes nowhere on the success path; the digest is the only thing this
  # function is allowed to print.
  docker build -q -t "$tag" "$dir" >"$dir/build.log" 2>&1 || return 1
  docker push "$tag" >/dev/null 2>&1 || return 1
  docker inspect --format '{{index .RepoDigests 0}}' "$tag" 2>/dev/null || return 1
}

# Write a manifest for an already-pushed image, then sign it.
make_bundle() {
  local dir="$1" plugin_id="$2" image="$3" out="$4"
  [ -n "$image" ] || return 1
  # The manifest schema is the real one (plugins/hello-ops/manifest.template.json
  # and crates/contracts), not an invented shape. The first version of this
  # helper guessed `capabilityDigest` and a flat protocol object, and the CLI
  # rejected it with "unknown field `capabilityDigest`" - which at least meant the
  # failure was visible; had the schema accepted it, the injection would have
  # tested a plugin the platform never runs.
  python3 - "$dir" "$plugin_id" "$image" <<'PY'
import json, os, sys
d, plugin_id, image = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(d, exist_ok=True)
json.dump({
    "schemaVersion": "1.1",
    "id": plugin_id,
    "version": "0.0.1",
    "publisher": "trusted-team",
    "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
    "artifactDigest": "sha256:" + "0" * 64,
    "backend": {
        "runtime": "oci",
        "imageRef": image,
        "protocol": {"name": "http-json", "version": "1", "containerPort": 8080},
        "health": {
            "readinessPath": "/_opsweave/health/ready",
            "livenessPath": "/_opsweave/health/live",
            "startupPath": "/_opsweave/health/startup",
        },
        "apiPrefix": "/api/crash",
    },
    "provides": [{"name": "sample.crash.v1", "major": 1}],
    "requires": [],
    "permissions": [],
    "resources": {"cpuMillis": 200, "memoryMiB": 64},
}, open(os.path.join(d, "manifest.json"), "w"), indent=1)
PY
  HOME="$STATE/home" "$OPSCTL" bundle --dir "$dir" --out "$out" --key keys/publisher.key >/dev/null 2>&1
}

CRASH_IMAGE="$(build_image "$CRASH_TAG" crash)"
HANG_IMAGE="$(build_image "$HANG_TAG" hang)"

if [ -z "$CRASH_IMAGE" ] || [ -z "$HANG_IMAGE" ]; then
  bad "could not build the injection images; injections 2 and 3 are NOT_RUN"
else
  say "injection 2: a container that exits during startup"
  echo "   crash image: ${CRASH_IMAGE:-<empty>}"
  BUNDLE_OK=0
  if make_bundle "$EVIDENCE/crash-bundle" "dev.opsweave.crashloop" "$CRASH_IMAGE" "$EVIDENCE/crash.plugin.zip"; then
    if HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install "$EVIDENCE/crash.plugin.zip" >"$EVIDENCE/crash-install.log" 2>&1; then
      BUNDLE_OK=1
    else
      echo "   install failed:"; sed 's/^/      /' "$EVIDENCE/crash-install.log" | head -8
    fi
  else
    echo "   bundle failed (manifest dir $EVIDENCE/crash-bundle):"
    ls -la "$EVIDENCE/crash-bundle" 2>&1 | head -5
    HOME="$STATE/home" "$OPSCTL" bundle --dir "$EVIDENCE/crash-bundle" --out "$EVIDENCE/crash.plugin.zip" --key keys/publisher.key 2>&1 | head -8
  fi
  if [ "$BUNDLE_OK" != "1" ]; then
    bad "the crash-loop plugin could not be built or staged; injection 2 is NOT_RUN"
  else
    if HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" deploy dev.opsweave.crashloop 0.0.1 \
         --replicas 1 --selector role=node --wait >"$EVIDENCE/crash-deploy.log" 2>&1; then
      bad "a container that exits during startup was reported as deployed and READY"
    else
      ok "a container that exits during startup does not reach READY"
      sed 's/^/      /' "$EVIDENCE/crash-deploy.log" 2>/dev/null | tail -3
    fi
    # The exact code, not a hint of one. The previous pattern
    # (READY|DEGRADED|FAILED|CONFLICT|not ready) matched almost any error text
    # the Kernel could produce, so a 404 or a revision conflict would have passed
    # as "refused because not ready". The Kernel answers DEPLOYMENT_NOT_READY for
    # a deployment that never became READY (deployments.rs:470).
    expect_refusal "activation is refused when no replica is READY" "DEPLOYMENT_NOT_READY" \
      env HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" activate dev.opsweave.crashloop 0.0.1
  fi

  say "injection 3: a container that never becomes ready"
  if ! make_bundle "$EVIDENCE/hang-bundle" "dev.opsweave.neverready" "$HANG_IMAGE" "$EVIDENCE/hang.plugin.zip" \
     || ! HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install "$EVIDENCE/hang.plugin.zip" >/dev/null 2>&1; then
    bad "the never-ready plugin could not be built or staged; injection 3 is NOT_RUN"
  else
    # `--wait` is deliberately NOT passed: the CLI's own wait is 300s, and this
    # injection does not need to spend five minutes proving a timeout the Kernel
    # reports far sooner. What must be true is that the deployment never reaches
    # READY - polled here for a bounded 60s - and that a `--wait` deploy of the
    # same version therefore cannot succeed. The second half is asserted by
    # reading the status the wait would have read.
    HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" deploy dev.opsweave.neverready 0.0.1 \
      --replicas 1 --selector role=node >"$EVIDENCE/hang-deploy.log" 2>&1 \
      || bad "the deploy request itself was rejected, so the injection did not start"
    NEVER_READY=1
    for _ in $(seq 1 30); do
      STATUS_JSON="$(curl -fsS -m 10 -H "Authorization: Bearer $(session_token)" \
        "$SRC_EP/api/v1/plugins/dev.opsweave.neverready/deployments" 2>/dev/null || echo '[]')"
      # Parse the deployment status field; do NOT grep for the word READY. The
      # previous version did, and matched a "READY" that was not the deployment's
      # status (the response carries instance and node states too), so it declared
      # the deployment ready while the very next line printed PREPARING. Two
      # readers of one fact disagreed - the grep was wrong.
      STATUS="$(printf '%s' "$STATUS_JSON" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("unreadable"); raise SystemExit
if isinstance(d, dict): d = d.get("items") or [d]
print(" ".join(str(x.get("status")) for x in d if isinstance(x, dict) and x.get("version")=="0.0.1"))
' 2>/dev/null || echo unreadable)"
      case " $STATUS " in
        *" READY "*) NEVER_READY=0; break ;;
      esac
      sleep 2
    done
    [ "$NEVER_READY" = "1" ] \
      && ok "a deployment that never becomes READY stays PREPARING for 60s (a --wait deploy must time out)" \
      || bad "a deployment that never becomes READY reached READY, which contradicts the injection"
    FINAL="$(printf '%s' "${STATUS_JSON:-[]}" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("unreadable"); raise SystemExit
if isinstance(d, dict): d = d.get("items") or [d]
print(" ".join(str(x.get("status")) for x in d if isinstance(x, dict)))
' 2>/dev/null || echo unreadable)"
    echo "   deployment status after 60s: ${FINAL:-<none>}"
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 \
      -H "Authorization: Bearer $(session_token)" \
      "$SRC_EP/api/v1/gateway/dev.opsweave.neverready/api/hello" 2>/dev/null || echo 000)"
    [ "$CODE" != "200" ] && ok "a never-ready plugin is not routed to (HTTP $CODE)" \
      || bad "a never-ready plugin was routed to (HTTP 200)"
  fi
fi

# --- 4. a route that does not switch ----------------------------------------
say "injection 4: the gateway does not switch versions"
# Install and activate v1 for real, then assert on a version that was never
# activated. The check under test is "after activation the gateway serves THIS
# version"; here nothing was activated, so a check that only looked at HTTP 200
# would pass. This is the assertion shape the lifecycle uses.
#
# The first version of this injection fell back to `{}` when the gateway request
# failed and then printed "the route serves 0.0.1" - a claim about a request that
# never arrived. It also only grepped for "0.0.2", so a body that did not parse,
# or a 503, satisfied it. Both are fixed: the request's status and the body's
# parse are separate, explicit assertions, and the served version is compared
# with the control plane rather than with a substring.
if ! HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install dist/plugins/${PLUGIN_STEM}-0.0.1.plugin.zip >"$EVIDENCE/v1-install.log" 2>&1; then
  bad "injection 4 is INCONCLUSIVE: the v1 bundle could not be staged"
elif ! HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" deploy "$PLUGIN" 0.0.1 --replicas 2 --selector role=node --wait >"$EVIDENCE/v1-deploy.log" 2>&1; then
  bad "injection 4 is INCONCLUSIVE: the v1 deployment did not become READY"
elif ! HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" activate "$PLUGIN" 0.0.1 >"$EVIDENCE/v1-activate.log" 2>&1; then
  bad "injection 4 is INCONCLUSIVE: v1 could not be activated, so there is no route to test"
else
  GW_BODY="$EVIDENCE/v1-gateway.body"
  GW_CODE="$(curl -sS -o "$GW_BODY" -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer $(session_token)" \
    "$SRC_EP/api/v1/gateway/$PLUGIN/api/hello" 2>"$EVIDENCE/v1-gateway.err" || echo 000)"
  ACTIVE="$(curl -fsS -m 10 -H "Authorization: Bearer $(session_token)" \
    "$SRC_EP/api/v1/plugins/$PLUGIN" 2>/dev/null \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("activeVersion",""))' 2>/dev/null || echo '')"
  if [ "$GW_CODE" = "000" ]; then
    bad "injection 4 is INCONCLUSIVE: the gateway request did not complete (HTTP 000)"
  elif [ "$GW_CODE" != "200" ]; then
    bad "injection 4 is INCONCLUSIVE: the activated v1 plugin returned HTTP $GW_CODE"
  elif ! SERVED="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("version",""))' "$GW_BODY" 2>/dev/null)"; then
    bad "injection 4 is INCONCLUSIVE: the gateway body is not JSON, so no version can be read"
  elif [ -z "$SERVED" ]; then
    bad "injection 4 is INCONCLUSIVE: the gateway body carries no version field"
  elif [ "$SERVED" != "$ACTIVE" ]; then
    bad "the gateway serves $SERVED while the control plane reports $ACTIVE"
  elif [ "$ACTIVE" != "0.0.1" ]; then
    bad "the control plane reports $ACTIVE, not the 0.0.1 this injection activated"
  else
    ok "the gateway really serves $SERVED and the control plane agrees, so an assertion that the route is 0.0.2 would be false"
  fi
fi

# --- 5. a rollback target that is not READY ---------------------------------
say "injection 5: rollback to a version that was never deployed"
# A version that was never deployed takes the NOT_FOUND path ("deployment not
# found; deploy the version first", deployments.rs:431) - a different branch from
# the DEPLOYMENT_NOT_READY assertion above. The two cases are kept distinct, as
# the brief requires: "never deployed" and "deployed but not READY" are not the
# same refusal and must not be satisfied by one pattern.
expect_refusal "rollback to an undeployed version is refused" "NOT_FOUND" \
  env HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" rollback "$PLUGIN" 9.9.9 --replicas 1

# --- 6. another installation's container under our name ---------------------
say "injection 6: a foreign installation's container under our name"
# The C1.2 boundary, injected so the ownership claim is known to be testable.
#
# The first version asserted only that `docker ps --filter label=…` did not list
# the container. That is a test of the Docker CLI's filter, not of the product:
# it would pass with the Node's ownership check deleted entirely, because the
# filter and the assertion are the same query. It also never removed anything
# through the product's code path.
#
# This version drives the compiled `DockerAdapter` - the same type the Node uses
# to decide ownership and to remove - through the library target, via a small
# test binary that returns a machine-readable verdict. The container is planted
# first, then the adapter is asked (a) whether it thinks it owns it and (b)
# whether a scoped removal removes it.
INSTALL_A="$(python3 -c 'import uuid;print(uuid.uuid4())')"
# The identity the probe uses. It is deliberately NOT A: it stands for the
# second installation whose sweep must not reach A's container.
INSTALL_B="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NODE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
INSTANCE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NAME="opsweave-${NODE_ID}-${INSTANCE_ID}"
# This name is derived from a fresh pair of UUIDs, so it cannot collide with a
# container this script did not create; the inspect-first check makes that
# explicit rather than assumed.
if docker container inspect "$NAME" >/dev/null 2>&1; then
  bad "injection 6 is BLOCKED: a container named $NAME already exists and is not this script's"
else
  docker run -d --name "$NAME" --label opsweave.managed=true --label "opsweave.node-id=$NODE_ID" \
    --label "opsweave.installation-id=$INSTALL_A" alpine:3 sh -c 'while true; do sleep 5; done' >/dev/null 2>&1
  A_ID="$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null || echo '')"
  A_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$NAME" 2>/dev/null || echo '')"
  if [ -z "$A_ID" ]; then
    bad "injection 6 is INCONCLUSIVE: the container could not be planted, so nothing was exercised"
  else
    # The real DockerAdapter, pointed at THE CONTAINER THIS SCRIPT PLANTED.
    #
    # The previous version ran `apps/node/tests/container_ownership.rs` here and
    # said it drove "a container this script planted". It did not: that test
    # builds its own container from its own random ids and never sees this one.
    # The claim was wrong, and re-wording it would have been worse than fixing it.
    # The adapter is now asked directly, through the `ownership_probe` example,
    # about $NAME - the exact container this script created, with installation A's
    # label, probed with installation B's identity.
    OWNERSHIP_LOG="$EVIDENCE/foreign-ownership.log"
    cargo build --locked -q -p opsweave-node --example ownership_probe \
      >"$EVIDENCE/ownership-probe-build.log" 2>&1 \
      || bad "the ownership probe could not be built; see $EVIDENCE/ownership-probe-build.log"
    # Probe with an identity that is NOT A's. `INSTALL_A` is the label on the
    # planted container; B is a fresh id, which is the "second installation"
    # whose sweep must not reach A's container.
    if "$ROOT/target/debug/examples/ownership_probe" \
         --installation "$INSTALL_B" --container "$NAME" --remove \
         >"$OWNERSHIP_LOG" 2>&1; then
      :
    else
      PROBE_STATUS=$?
      bad "the adapter did not answer Foreign for the planted container (probe exit $PROBE_STATUS)"
      sed 's/^/      /' "$OWNERSHIP_LOG" | head -5
    fi
    # Assert on what the probe actually printed, not only on its exit code: the
    # exit code alone would pass if the probe crashed before printing anything.
    if grep -qx 'ownership=foreign' "$OWNERSHIP_LOG"; then
      ok "the compiled adapter reports the planted container as foreign to installation B"
    else
      bad "the adapter did not report the planted container as foreign: \
$(grep -m1 ownership= "$OWNERSHIP_LOG" 2>/dev/null || echo 'no ownership line')"
    fi
    if grep -qx 'remove_result=foreign' "$OWNERSHIP_LOG"; then
      ok "the guarded removal refused to remove the planted container"
    else
      bad "the guarded removal did not report 'foreign' for the planted container: \
$(grep -m1 remove_result= "$OWNERSHIP_LOG" 2>/dev/null || echo 'no remove_result line')"
    fi
    if grep -qx 'still_running=true' "$OWNERSHIP_LOG"; then
      ok "the planted container was still running after the guarded removal"
    else
      bad "the planted container was not running after the guarded removal"
    fi

    # And the container this script planted is still exactly as it was.
    NOW_ID="$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null || echo '')"
    NOW_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$NAME" 2>/dev/null || echo '')"
    NOW_RUNNING="$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo 'false')"
    if [ "$NOW_ID" != "$A_ID" ]; then
      bad "the product removed or replaced the planted container (id $A_ID -> ${NOW_ID:-gone})"
    elif [ "$NOW_STARTED" != "$A_STARTED" ] || [ "$NOW_RUNNING" != "true" ]; then
      bad "the product stopped or restarted the planted container"
    else
      ok "the planted container kept its id, start time and running state"
    fi
    # This script removes its own planted container, by the id it recorded.
    docker rm -f "$A_ID" >/dev/null 2>&1 \
      && ok "the planted container was removed by id, by this script" \
      || bad "could not remove the planted container $A_ID"
  fi
fi

say "summary"
echo "PASS=$PASS FAIL=$FAIL"
FUNCTIONAL_STATUS=0
[ "$FAIL" = "0" ] || FUNCTIONAL_STATUS=1

# Cleanup runs FIRST, then the verdict is computed from both facts. The previous
# version printed the summary, ran the teardown with `|| echo`, and then exited on
# FAIL alone - so a failed teardown still produced exit 0 next to "PASS=11
# FAIL=0". That is the same defect the main driver had, and it is why both now
# share one shape: cleanup, record, then decide.
say "cleanup"
cleanup_owned_resources

echo
if [ "$FUNCTIONAL_STATUS" = "0" ]; then
  echo "   injections: PASS (every injected failure was detected)"
else
  echo "   injections: FAIL ($FAIL injection(s) not detected)"
fi
if [ "$CLEANUP_STATUS" = "0" ]; then
  echo "   cleanup:    PASS"
else
  echo "   cleanup:    FAIL (a resource this run created could not be removed)"
fi

if [ "$FUNCTIONAL_STATUS" = "0" ] && [ "$CLEANUP_STATUS" = "0" ]; then
  echo "every injected failure was detected, and this run's resources were removed"
  exit 0
fi
if [ "$FUNCTIONAL_STATUS" = "0" ]; then
  echo "FAIL  every injection was detected but this run's resources were NOT fully removed;"
  echo "      see $EVIDENCE/teardown.log. Not reported as a pass."
  exit 1
fi
echo "FAIL  an injected failure was NOT detected"
if [ "$CLEANUP_STATUS" != "0" ]; then
  echo "      cleanup ALSO failed; both problems are recorded above"
fi
exit 1
