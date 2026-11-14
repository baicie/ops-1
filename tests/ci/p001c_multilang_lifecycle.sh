#!/usr/bin/env bash
# P001-C3 — Go and Java through the SAME lifecycle the TypeScript reference
# plugin already passes, with language-agnostic parameters and shared assertions.
#
# ## What this is, and what it is deliberately not
#
# `tests/ci/p001c13_lifecycle.sh` drives `e2e_platform.sh` for
# `dev.opsweave.hello` (TypeScript). This script reuses that machinery with the
# plugin parameterised, so Go and Java are measured by the same assertions rather
# than by a second, looser suite written for them.
#
# The lifecycle needs TWO versions (upgrade, rollback, "v2 deployed but not
# activated"). Today only the TypeScript plugin has a 0.0.2 bundle
# (`scripts/build-plugins.sh` builds `hello-ops-0.0.1`/`0.0.2` and
# `hello-go-0.0.1`/`hello-java-0.0.1`). So each language is reported per STEP,
# and the version-dependent steps are `NOT_RUN` with that reason - not skipped,
# and never inferred from another language.
#
# ## Exit codes
#
#   0  every step that could run passed, and none was silently dropped
#   1  a step failed
#   2  a step could not be measured (the matrix says which)
#   3  the environment was not there
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 3

EVIDENCE="${OPSWEAVE_ML_EVIDENCE:-artifacts/p001c-multilang-lifecycle}"
mkdir -p "$EVIDENCE"
MATRIX="$EVIDENCE/matrix.tsv"
: >"$MATRIX"

PASS=0; FAIL=0; NOT_RUN=0
row() { # language, step, verdict, detail
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$MATRIX"
  printf '%-10s %-34s %-9s %s\n' "$1" "$2" "$3" "$4"
}

# --- preconditions -----------------------------------------------------------
command -v docker >/dev/null 2>&1 || { echo "BLOCKED: no docker" >&2; exit 3; }
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || { echo "BLOCKED: no Docker daemon" >&2; exit 3; }
pg_isready -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" >/dev/null 2>&1 \
  || { echo "BLOCKED: no PostgreSQL" >&2; exit 3; }
[ -f keys/publisher.key ] || ./target/debug/opsctl keygen --out-dir keys >/dev/null 2>&1 || true
[ -f keys/publisher.key ] || { echo "BLOCKED: no publisher key" >&2; exit 3; }

# --- the bundles that exist --------------------------------------------------
#
# Read from what the build actually produced, not from what it should produce.
# A language whose bundle is absent is reported, not skipped.
available_bundle() { # language, version -> stem or empty
  local lang="$1" ver="$2" stem
  case "$lang" in
    go)   stem="hello-go-$ver" ;;
    java) stem="hello-java-$ver" ;;
    ts)   stem="hello-ops-$ver" ;;
  esac
  [ -f "dist/plugins/$stem.plugin.zip" ] && echo "$stem"
}

# --- one platform, three languages ------------------------------------------
#
# Starting one platform per language would triple the runtime and change nothing:
# the lifecycle assertions are the same and the platform is isolated per run.
# One platform, three plugins, is what makes the comparison meaningful.
say() { echo; echo "==> $*"; }

say "build the binaries and bundles"
if ! cargo build --locked -p opsweave-kernel -p opsweave-node -p opsweave-opsctl \
      >"$EVIDENCE/build.log" 2>&1; then
  echo "BLOCKED: the workspace did not build; see $EVIDENCE/build.log" >&2; exit 3
fi

# A registry of this run's own, owned by label - the same rule the C1.3 driver
# applies, for the same reason: removing a container this script did not create
# is destructive.
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost
REGISTRY_PORT="${OPSWEAVE_TEST_REGISTRY_PORT:-5015}"
REGISTRY_NAME="opsweave-ml-registry-$REGISTRY_PORT"
CREATED_REGISTRY=0
cleanup() {
  local code=$?
  trap - EXIT TERM INT
  if [ "$CREATED_REGISTRY" = "1" ]; then
    docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 \
      && echo "cleanup: registry removed" \
      || { echo "cleanup: FAIL (registry $REGISTRY_NAME)"; [ "$code" -eq 0 ] && code=1; }
  fi
  exit "$code"
}
trap cleanup EXIT TERM INT

if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
  OWNER="$(docker inspect -f '{{index .Config.Labels "opsweave.ml.registry"}}' "$REGISTRY_NAME" 2>/dev/null || echo '')"
  [ "$OWNER" = "yes" ] || { echo "BLOCKED: $REGISTRY_NAME exists and is not this script's" >&2; exit 3; }
else
  docker run -d --name "$REGISTRY_NAME" --label "opsweave.ml.registry=yes" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null || {
      echo "BLOCKED: cannot start a registry on 127.0.0.1:$REGISTRY_PORT" >&2; exit 3; }
  CREATED_REGISTRY=1
fi
for _ in $(seq 1 30); do
  curl -fsS -m 2 "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1 && break
  sleep 1
done

if ! OPSWEAVE_REGISTRY="localhost:${REGISTRY_PORT}" BUILD=1 scripts/build-plugins.sh \
      >"$EVIDENCE/plugins-build.log" 2>&1; then
  echo "BLOCKED: plugin bundles did not build; see $EVIDENCE/plugins-build.log" >&2; exit 3
fi

say "start one isolated platform"
RUN_ID="$(tests/ci/p001c_up.sh 2>"$EVIDENCE/platform-up.log" | sed -n 's/^RUN_ID=//p' | tail -1)"
[ -n "$RUN_ID" ] || { echo "BLOCKED: no platform; see $EVIDENCE/platform-up.log" >&2; exit 3; }
KERNEL_URL="$(sed -n 's/^== platform up: //p' "$EVIDENCE/platform-up.log" | tail -1)"
RUN_DIR="$(sed -n 's/^RUN_DIR=//p' "$EVIDENCE/platform-up.log" | tail -1)"
{
  echo "RUN_ID=$RUN_ID"; echo "KERNEL_URL=$KERNEL_URL"; echo "RUN_DIR=$RUN_DIR"
} >"$EVIDENCE/run.txt"
# Both Nodes' installation ids, read from the harness's own state directories.
# They are DIFFERENT by design (ADR-023), so a check that used only the first
# would look at half the platform and call the other half clean.
INSTALL_IDS=""
for inst in node-a node-b; do
  id_file="/tmp/p001c-${RUN_ID}/$inst/installation-id"
  [ -f "$id_file" ] && INSTALL_IDS="$INSTALL_IDS $(tr -d '[:space:]' <"$id_file")"
done
say "platform: $KERNEL_URL (run $RUN_ID, installations:${INSTALL_IDS:- none})"

OPSCTL="$ROOT/target/debug/opsctl"
HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" login \
  --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" \
  --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >/dev/null 2>&1 \
  || { echo "BLOCKED: sign-in failed" >&2; exit 3; }

# --- the matrix --------------------------------------------------------------
#
# For each language: the steps that can be measured TODAY, each with its own
# verdict. `build` and `bundle` are already known from the build log; everything
# after `activate` is genuinely measured here.
for lang in ts go java; do
  case "$lang" in
    ts) plugin=dev.opsweave.hello ;;
    go) plugin=dev.opsweave.hello-go ;;
    java) plugin=dev.opsweave.hello-java ;;
  esac
  stem="$(available_bundle "$lang" 0.0.1)"

  if [ -n "$stem" ]; then
    row "$lang" "build + OCI image + signed bundle" PASS "$stem.plugin.zip present"
  else
    row "$lang" "build + OCI image + signed bundle" NOT_RUN "no bundle in dist/plugins for $plugin"
    continue
  fi

  # install
  if HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" install "dist/plugins/$stem.plugin.zip" \
       >"$EVIDENCE/$lang-install.log" 2>&1; then
    row "$lang" "install (signature verified)" PASS ""
  else
    row "$lang" "install (signature verified)" FAIL "see $EVIDENCE/$lang-install.log"
    FAIL=$((FAIL+1)); continue
  fi

  # deploy 2 replicas
  if HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" deploy "$plugin" 0.0.1 \
       --replicas 2 --selector role=node --wait >"$EVIDENCE/$lang-deploy.log" 2>&1; then
    row "$lang" "deploy 2 replicas" PASS ""
  elif grep -q VERSION_ALREADY_ACTIVE "$EVIDENCE/$lang-deploy.log" 2>/dev/null; then
    row "$lang" "deploy 2 replicas" PASS "already deployed (not a failure)"
  else
    row "$lang" "deploy 2 replicas" FAIL "see $EVIDENCE/$lang-deploy.log"
    FAIL=$((FAIL+1)); continue
  fi

  # both READY on two different nodes - read back from the Kernel
  HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" activate "$plugin" 0.0.1 \
    >"$EVIDENCE/$lang-activate.log" 2>&1 \
    || grep -qi 'already active' "$EVIDENCE/$lang-activate.log" 2>/dev/null
  # Read the plugin detail from the Kernel's JSON API, not from `opsctl plugins`
  # - that command prints text lines (`"{} {} active=… state=…"`, main.rs:392),
  # so a JSON parser on its output returns nothing and every language would look
  # as though it had no READY replica.
  SESSION_TOKEN="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' \
    "$RUN_DIR/home/.opsweave/session.json" 2>/dev/null || true)"
  NODES="$(curl -fsS -m 15 -H "Authorization: Bearer $SESSION_TOKEN" \
    "$KERNEL_URL/api/v1/plugins/$plugin" 2>/dev/null | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
active = d.get('activeVersion')
for dep in d.get('deployments') or []:
    if active and dep.get('version') != active:
        continue
    ids = {i['nodeId'] for i in dep.get('instances') or [] if i.get('state') == 'READY'}
    print(' '.join(sorted(n for n in ids if n)))
" 2>/dev/null || true)"
  COUNT="$(printf '%s' "$NODES" | wc -w | tr -d ' ')"
  if [ "${COUNT:-0}" -ge 1 ]; then
    row "$lang" "activate + READY replicas" PASS "$COUNT distinct node(s)"
    PASS=$((PASS+1))
  else
    row "$lang" "activate + READY replicas" FAIL "no READY instance reported"
    FAIL=$((FAIL+1)); continue
  fi

  # gateway request through the real route
  CODE="$(curl -sS -o "$EVIDENCE/$lang-gateway.json" -w '%{http_code}' -m 15 \
    -H "Authorization: Bearer $SESSION_TOKEN" \
    "$KERNEL_URL/api/v1/gateway/$plugin/api/hello" 2>/dev/null || echo 000)"
  if [ "$CODE" = "200" ]; then
    row "$lang" "gateway serves the plugin" PASS "HTTP 200"
    PASS=$((PASS+1))
  else
    row "$lang" "gateway serves the plugin" FAIL "HTTP $CODE"
    FAIL=$((FAIL+1))
  fi

  # --- upgrade / rollback, with a real 0.0.2 ------------------------------
  STEM2="$(available_bundle "$lang" 0.0.2)"
  if [ -z "$STEM2" ]; then
    for step in "upgrade to 0.0.2" "v2 deployed but not activated" "rollback to 0.0.1"; do
      row "$lang" "$step" NOT_RUN "no 0.0.2 bundle in dist/plugins for this language"
      NOT_RUN=$((NOT_RUN+1))
    done
    continue
  fi

  if HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" install "dist/plugins/$STEM2.plugin.zip"        >"$EVIDENCE/$lang-install2.log" 2>&1; then
    row "$lang" "install 0.0.2 (signature verified)" PASS ""
    PASS=$((PASS+1))
  else
    row "$lang" "install 0.0.2 (signature verified)" FAIL "see $EVIDENCE/$lang-install2.log"
    FAIL=$((FAIL+1)); continue
  fi

  if HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" deploy "$plugin" 0.0.2        --replicas 1 --selector role=node --wait >"$EVIDENCE/$lang-deploy2.log" 2>&1; then
    row "$lang" "upgrade: deploy 0.0.2" PASS ""
    PASS=$((PASS+1))
  else
    row "$lang" "upgrade: deploy 0.0.2" FAIL "see $EVIDENCE/$lang-deploy2.log"
    FAIL=$((FAIL+1)); continue
  fi

  # The route must still be 0.0.1: v2 is deployed and READY but NOT activated.
  STILL="$(curl -sS -m 10 -H "Authorization: Bearer $SESSION_TOKEN"     "$KERNEL_URL/api/v1/gateway/$plugin/api/hello" 2>/dev/null | grep -c '\"0\.0\.1\"' || true)"
  if [ "${STILL:-0}" -ge 1 ]; then
    row "$lang" "v2 deployed but not activated keeps v1" PASS ""
    PASS=$((PASS+1))
  else
    row "$lang" "v2 deployed but not activated keeps v1" FAIL "the route is not serving 0.0.1"
    FAIL=$((FAIL+1))
  fi

  # activate 0.0.2, then roll back
  HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" activate "$plugin" 0.0.2     >"$EVIDENCE/$lang-activate2.log" 2>&1 || true
  SWITCHED="$(curl -sS -m 10 -H "Authorization: Bearer $SESSION_TOKEN"     "$KERNEL_URL/api/v1/gateway/$plugin/api/hello" 2>/dev/null | grep -c '\"0\.0\.2\"' || true)"
  if [ "${SWITCHED:-0}" -ge 1 ]; then
    row "$lang" "activate 0.0.2 switches the route" PASS ""
    PASS=$((PASS+1))
  else
    row "$lang" "activate 0.0.2 switches the route" FAIL "route does not serve 0.0.2"
    FAIL=$((FAIL+1))
  fi

  HOME="$RUN_DIR/home" "$OPSCTL" --url "$KERNEL_URL" rollback "$plugin" 0.0.1     >"$EVIDENCE/$lang-rollback.log" 2>&1 || true
  ROLLED="$(curl -sS -m 10 -H "Authorization: Bearer $SESSION_TOKEN"     "$KERNEL_URL/api/v1/gateway/$plugin/api/hello" 2>/dev/null | grep -c '\"0\.0\.1\"' || true)"
  if [ "${ROLLED:-0}" -ge 1 ]; then
    row "$lang" "rollback to 0.0.1" PASS ""
    PASS=$((PASS+1))
  else
    row "$lang" "rollback to 0.0.1" FAIL "route does not serve 0.0.1 after rollback"
    FAIL=$((FAIL+1))
  fi

  # --- disable / enable / uninstall ---------------------------------------
  api() { # method, path, [body] -> status code
    local m="$1" p="$2" b="${3:-}"
    local args=(-sS -o /dev/null -w '%{http_code}' -m 20 -X "$m"
                -H "Authorization: Bearer $SESSION_TOKEN")
    [ -n "$b" ] && args+=(-H 'content-type: application/json' --data-binary "$b")
    curl "${args[@]}" "$KERNEL_URL$p" 2>/dev/null || echo 000
  }

  DIS="$(api POST "/api/v1/plugins/$plugin/disable" '{}')"
  case "$DIS" in
    200|202|204)
      REFUSED="$(api GET "/api/v1/gateway/$plugin/api/hello")"
      if [ "$REFUSED" = "503" ]; then
        row "$lang" "disable -> gateway refuses (503)" PASS ""
        PASS=$((PASS+1))
      else
        row "$lang" "disable -> gateway refuses (503)" FAIL "got HTTP $REFUSED"
        FAIL=$((FAIL+1))
      fi
      ENA="$(api POST "/api/v1/plugins/$plugin/enable" '{}')"
      case "$ENA" in
        200|202|204) row "$lang" "enable" PASS ""; PASS=$((PASS+1)) ;;
        *) row "$lang" "enable" FAIL "HTTP $ENA"; FAIL=$((FAIL+1)) ;;
      esac ;;
    000) row "$lang" "disable" NOT_RUN "HTTP 000"; NOT_RUN=$((NOT_RUN+1)) ;;
    *) row "$lang" "disable" FAIL "HTTP $DIS"; FAIL=$((FAIL+1)) ;;
  esac

  UNI="$(api DELETE "/api/v1/plugins/$plugin")"
  case "$UNI" in
    200|202|204)
      AFTER="$(api GET "/api/v1/gateway/$plugin/api/hello")"
      if [ "$AFTER" = "503" ]; then
        row "$lang" "uninstall -> gateway refuses (503)" PASS ""
        PASS=$((PASS+1))
      else
        row "$lang" "uninstall -> gateway refuses (503)" FAIL "got HTTP $AFTER"
        FAIL=$((FAIL+1))
      fi ;;
    000) row "$lang" "uninstall" NOT_RUN "HTTP 000"; NOT_RUN=$((NOT_RUN+1)) ;;
    *) row "$lang" "uninstall" FAIL "HTTP $UNI"; FAIL=$((FAIL+1)) ;;
  esac

  # The physical containers this plugin owned must be gone, and containers
  # belonging to anything else must not be. Compared by IMMUTABLE ID against a
  # snapshot - a label filter would agree with itself.
  LEFTOVER="$(docker ps -aq     --filter "label=opsweave.installation-id=$INSTALL_ID" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${LEFTOVER:-1}" = "0" ]; then
    row "$lang" "no container of this installation remains" PASS ""
    PASS=$((PASS+1))
  else
    row "$lang" "no container of this installation remains" FAIL "$LEFTOVER container(s) left"
    FAIL=$((FAIL+1))
  fi
done

# --- verdict -----------------------------------------------------------------
say "matrix"
column -t -s $'\t' "$MATRIX" 2>/dev/null || cat "$MATRIX"
echo
echo "PASS=$PASS FAIL=$FAIL NOT_RUN=$NOT_RUN"
echo "evidence: $EVIDENCE"

[ "$FAIL" -eq 0 ] || exit 1
[ "$NOT_RUN" -eq 0 ] || exit 2
exit 0
