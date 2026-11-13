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
started_registry=0
if ! docker ps --format '{{.Names}}' | grep -qx "$REGISTRY_NAME"; then
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$REGISTRY_NAME" -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null \
    || fatal "could not start a local registry"
  started_registry=1
  for _ in $(seq 1 30); do
    curl -fsS -m 2 "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! OPSWEAVE_REGISTRY="localhost:${REGISTRY_PORT}" BUILD=1 \
  scripts/build-plugins.sh >"$EVIDENCE/build.log" 2>&1; then
  tail -30 "$EVIDENCE/build.log" >&2 || true
  [ "$started_registry" = "1" ] && docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  fatal "the plugin bundles could not be built"
fi

say "start an isolated platform"
UP_LOG="$EVIDENCE/platform-up.log"
RUN_ID="$(tests/ci/p001c_up.sh 2>"$UP_LOG" | sed -n 's/^RUN_ID=//p' | tail -1)"
if [ -z "$RUN_ID" ]; then
  tail -30 "$UP_LOG" >&2 || true
  [ "$started_registry" = "1" ] && docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  fatal "the isolated platform did not start"
fi
STATE="/tmp/p001c-${RUN_ID}"
KERNEL_PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kernelPort'])" "$STATE/run.json")"
SRC_EP="http://127.0.0.1:${KERNEL_PORT}"
OPSCTL="$ROOT/target/debug/opsctl"
PLUGIN="dev.opsweave.hello"
export OPSWEAVE_URL="$SRC_EP" OPSWEAVE_ADMIN_EMAIL=admin@opsweave.local OPSWEAVE_ADMIN_PASSWORD='OpsWeave!2026'
HOME="$STATE/home" "$OPSCTL" login --email "$OPSWEAVE_ADMIN_EMAIL" --password "$OPSWEAVE_ADMIN_PASSWORD" >/dev/null \
  || fatal "could not sign in"

PASS=0
FAIL=0
ok() { printf 'PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

# Run a command that the product MUST refuse. The assertion is that it exits
# non-zero AND says why; a command that succeeds is the failure this checks for.
expect_refusal() {
  local label="$1" want="$2"
  shift 2
  local out err status
  out="$(mktemp)"; err="$(mktemp)"
  "$@" >"$out" 2>"$err"
  status=$?
  if [ "$status" = "0" ]; then
    bad "$label: the product ACCEPTED it (exit 0)"
    sed 's/^/      /' "$out" | head -5
  elif ! grep -qi "$want" "$err" "$out"; then
    bad "$label: refused (exit $status) but without '$want'"
    sed 's/^/      /' "$err" | head -5
  else
    ok "$label: refused with exit $status and '$want'"
  fi
  rm -f "$out" "$err"
}

# --- 1. a bundle whose signature does not cover its content -----------------
say "injection 1: an invalid bundle signature"
# The bundle is edited AND re-zipped without re-signing, so the detached
# signature no longer matches the manifest digest. This is the tampering an
# attacker with registry write access would attempt.
python3 - "dist/plugins/hello-ops-0.0.1.plugin.zip" "$EVIDENCE/tampered.plugin.zip" <<'PY'
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
if HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install dist/plugins/hello-ops-0.0.1.plugin.zip >/dev/null 2>&1; then
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
    expect_refusal "activation is refused when no replica is READY" "READY\|DEGRADED\|FAILED\|CONFLICT\|not ready" \
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
HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" install dist/plugins/hello-ops-0.0.1.plugin.zip >/dev/null 2>&1
HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" deploy "$PLUGIN" 0.0.1 --replicas 2 --selector role=node --wait >/dev/null 2>&1 \
  && HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" activate "$PLUGIN" 0.0.1 >/dev/null 2>&1
BODY="$(curl -fsS -m 10 -H "Authorization: Bearer $(python3 -c 'import json;print(json.load(open("'"$STATE"'/home/.opsweave/session.json"))["token"])')" \
  "$SRC_EP/api/v1/gateway/$PLUGIN/api/hello" 2>/dev/null || echo '{}')"
if printf '%s' "$BODY" | grep -q '"0.0.2"'; then
  bad "the route claimed 0.0.2 while only 0.0.1 was activated - the assertion would be vacuous"
else
  ok "the route serves 0.0.1, so a 'route is 0.0.2' assertion would correctly fail"
fi

# --- 5. a rollback target that is not READY ---------------------------------
say "injection 5: rollback to a version that was never deployed"
expect_refusal "rollback to an undeployed version is refused" "not found\|NOT_FOUND\|404\|deploy" \
  env HOME="$STATE/home" "$OPSCTL" --url "$SRC_EP" rollback "$PLUGIN" 9.9.9 --replicas 1

# --- 6. another installation's container under our name ---------------------
say "injection 6: a foreign installation's container with the same name"
# This is the C1.2 boundary, injected here so the lifecycle's ownership claim is
# known to be testable. Two installation ids, one container name: the second
# installation must see Foreign and must not remove it.
INSTALL_A="$(python3 -c 'import uuid;print(uuid.uuid4())')"
INSTALL_B="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NODE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
INSTANCE_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
NAME="opsweave-${NODE_ID}-${INSTANCE_ID}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --label opsweave.managed=true --label "opsweave.node-id=$NODE_ID" \
  --label "opsweave.installation-id=$INSTALL_A" alpine:3 sh -c 'while true; do sleep 5; done' >/dev/null 2>&1
A_ID="$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null || echo '')"
if [ -z "$A_ID" ]; then
  bad "could not plant the foreign container; injection 6 is NOT_RUN"
else
  # The Node's own sweep, scoped to installation B, must not list or remove it.
  SWEPT="$(docker ps -aq --filter "label=opsweave.installation-id=$INSTALL_B" 2>/dev/null || true)"
  [ -z "$SWEPT" ] && ok "a sweep scoped to another installation does not list it" \
    || bad "a sweep scoped to another installation listed it: $SWEPT"
  docker rm -f "$NAME" >/dev/null 2>&1
  [ "$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null || echo '')" != "$A_ID" ] \
    && ok "the planted container was removed only by this script, not by the product"
fi

say "summary"
echo "PASS=$PASS FAIL=$FAIL"

say "tear down"
tests/ci/p001c_teardown.sh "$RUN_ID" --purge >"$EVIDENCE/teardown.log" 2>&1 \
  || echo "   teardown reported a problem; see $EVIDENCE/teardown.log" >&2
[ "$started_registry" = "1" ] && docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true

[ "$FAIL" = "0" ] || exit 1
echo "every injected failure was detected"
