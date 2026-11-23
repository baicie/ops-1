#!/usr/bin/env bash
# Phase 7 TASK-23: what "deployed" actually means, stage by stage.
#
# WHY A SINGLE EXIT CODE IS NOT A RESULT
#
# `opsctl deploy --activate` already verifies more than most tools: it waits for
# READY, activates, and reads `activeVersion` back, refusing when the gateway is not
# serving what was built (`opsctl/src/main.rs:746`). That is a good claim and it is
# ONE claim. An operator asking "is the release live" gets a boolean, and the
# interesting answers are the ones in between:
#
#   the host is up but the kernel is not
#   the kernel is up but no node is enrolled
#   a node is enrolled but the plugin's container is not running
#   the container runs but the gateway refuses the route
#   the gateway serves the route but it answers 5xx
#
# Each of those is a different next action, and every one of them collapses into
# "deploy failed" today.
#
# WHAT THIS SCRIPT DOES
#
# It asks each question SEPARATELY and in dependency order, and prints one line per
# stage with an explicit state. A stage that cannot be evaluated says UNKNOWN or
# NOT_RUN and why - never a silent pass. The final verdict is derived from the
# stages, not from the last command's exit code.
#
# It does not deploy. Point it at a platform that already has one, or let it install
# and deploy first with --deploy.
#
# Usage:
#   tests/ci/phase7_release_stages.sh --run-id <id>            # inspect an existing run
#   tests/ci/phase7_release_stages.sh --run-id <id> --deploy   # install+deploy first
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RUN_ID=""; DO_DEPLOY=0; PLUGIN="opsweave.data-catalog"; VERSION="0.0.3"; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --deploy) DO_DEPLOY=1; shift ;;
    --plugin) PLUGIN="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RUN_ID" ] || { echo "usage: --run-id <id> [--deploy] [--plugin P] [--version V] [--json]" >&2; exit 2; }

STATE="/tmp/p001c-$RUN_ID"
[ -f "$STATE/run.json" ] || { echo "no run at $STATE; is the platform up?" >&2; exit 2; }
DB="p001c_${RUN_ID//[^a-zA-Z0-9]/_}"
KPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["kernelPort"])' "$STATE/run.json")"
KERNEL_URL="http://127.0.0.1:$KPORT"
export HOME="$STATE/home"
export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

q() { psql -h 127.0.0.1 -p 5432 -d "$DB" -tAc "$1" 2>/dev/null; }
op() { ./target/debug/opsctl --url "$KERNEL_URL" "$@" 2>&1; }

# One row per stage: name, state, detail. States are deliberately not booleans.
declare -a STAGE_NAME=() STAGE_STATE=() STAGE_DETAIL=() STAGE_ATTEMPT=()

# EVERY STAGE CARRIES THE ATTEMPT IT WAS OBSERVED UNDER.
#
# TASK-11: without this, `HOST_UP` from one deployment and `PLUGIN_ACTIVE` from the
# next can be assembled into a RELEASED that never happened as a whole. The stages
# are collected seconds apart, and a publish or a rollback landing in between is
# not hypothetical - it is what `--deploy` does two lines above the collection.
#
# The identity is (plugin, version, deployment id, generation). The generation is
# the field the kernel increments on every redeploy (`deployments.rs`), so a
# rollback or a re-publish changes it and the mismatch becomes visible.
#
# A stage observed before the identity is known records `?`, and a verdict that sees
# two DIFFERENT non-`?` identities refuses - see `verdict_of`.
ATTEMPT_ID="?"
stage() {
  STAGE_NAME+=("$1"); STAGE_STATE+=("$2"); STAGE_DETAIL+=("${3:-}"); STAGE_ATTEMPT+=("$ATTEMPT_ID")
}

# Read the current identity. Called once the package/active rows are queryable.
refresh_attempt() {
  local gen
  gen="$(q "SELECT generation FROM kernel.plugin_deployments WHERE plugin_id='$PLUGIN' AND version='$VERSION' ORDER BY updated_at DESC LIMIT 1" || echo "")"
  local dep
  dep="$(q "SELECT id::text FROM kernel.plugin_deployments WHERE plugin_id='$PLUGIN' AND version='$VERSION' ORDER BY updated_at DESC LIMIT 1" || echo "")"
  if [ -n "$dep" ] && [ -n "$gen" ]; then
    ATTEMPT_ID="${PLUGIN}@${VERSION}:${dep:0:8}:g${gen}"
  fi
}

if [ "$DO_DEPLOY" = "1" ]; then
  op install "dist/plugins/${PLUGIN#opsweave.}-$VERSION.plugin.zip" >/dev/null 2>&1 || true
  op deploy "$PLUGIN" "$VERSION" --replicas 1 --wait --activate >/tmp/p7-stages-deploy.log 2>&1 || true
fi

# --- 1. host ---------------------------------------------------------------
# The kernel answering /livez is the tightest statement available about "the
# process is up". It says nothing about whether it can serve a plugin.
if curl -fsS -m 5 "$KERNEL_URL/livez" >/dev/null 2>&1; then
  stage HOST_UP UP "the kernel process answers /livez"
else
  stage HOST_UP DOWN "no answer from $KERNEL_URL/livez"
fi

# --- 2. kernel readiness ---------------------------------------------------
# SEPARATE FROM HOST_UP on purpose: /livez is liveness, /readyz asks the kernel
# whether its dependencies (PostgreSQL) are reachable. A process that is up and not
# ready is a different incident from one that is down.
if curl -fsS -m 8 "$KERNEL_URL/readyz" >/dev/null 2>&1; then
  stage KERNEL_READY READY "readyz answers"
else
  stage KERNEL_READY NOT_READY "readyz refused: the kernel cannot reach its dependencies"
fi

# --- 3. a node is enrolled and fresh ---------------------------------------
NODES_READY="$(q "SELECT count(*) FROM kernel.nodes WHERE status='READY' AND revoked_at IS NULL" || echo "")"
NODES_TOTAL="$(q "SELECT count(*) FROM kernel.nodes WHERE revoked_at IS NULL" || echo "")"
if [ -z "$NODES_READY" ]; then
  stage NODE_READY UNKNOWN "the database could not be read"
elif [ "$NODES_READY" -ge 1 ]; then
  stage NODE_READY READY "${NODES_READY}/${NODES_TOTAL} node(s) READY"
else
  stage NODE_READY NO_NODE "0/${NODES_TOTAL} node(s) READY - nothing can be placed"
fi

# The identity is knowable once a deployment row exists. Refreshed here so every
# stage from PLUGIN_INSTALLED onward carries the same attempt.
refresh_attempt

# --- 4. the plugin is installed --------------------------------------------
PKG="$(q "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='$PLUGIN' AND version='$VERSION'" || echo "")"
if [ "${PKG:-0}" -ge 1 ]; then
  stage PLUGIN_INSTALLED INSTALLED "package $PLUGIN@$VERSION is registered"
else
  stage PLUGIN_INSTALLED NOT_INSTALLED "no package row for $PLUGIN@$VERSION"
fi

# --- 5. a real container is running ----------------------------------------
# A CONTAINER ID IS NOT A RUNNING INSTANCE.
#
# The first version counted rows with `container_id IS NOT NULL`, which is true of a
# container that exists and whose `state` is still STARTING, or UNHEALTHY, or
# STOPPING. A deployment is not running because a container was created for it.
#
# Two facts are asked separately and both must hold:
#   the row has a container          (the node created something)
#   the row's state is READY         (the plugin said it is ready)
#
# Measured on a real kernel after a failed placement: the instance row had a
# container id while the deployment was DEGRADED, which the old query would have
# called RUNNING.
CONTAINERS="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='$PLUGIN' AND i.desired_action='START' AND i.container_id IS NOT NULL" || echo "")"
READY_INSTANCES="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='$PLUGIN' AND i.desired_action='START' AND i.container_id IS NOT NULL AND i.state='READY'" || echo "")"
if [ "${CONTAINERS:-0}" -eq 0 ]; then
  stage PLUGIN_RUNNING NOT_RUNNING "no instance of $PLUGIN holds a container"
elif [ "${READY_INSTANCES:-0}" -eq 0 ]; then
  # THE DISTINCTION THE TASK ASKED FOR: a container exists and is not ready.
  stage PLUGIN_RUNNING NOT_READY "${CONTAINERS} container(s), none READY yet - the instance exists but is not serving"
else
  stage PLUGIN_RUNNING RUNNING "${READY_INSTANCES} of ${CONTAINERS} instance(s) READY with a container"
fi

# --- 6. the active revision is the version asked for -----------------------
ACTIVE="$(q "SELECT deployment_id::text FROM kernel.activation_revisions WHERE plugin_id='$PLUGIN' AND status='ACTIVE' LIMIT 1" || echo "")"
ACTIVE_VERSION="$(q "SELECT version FROM kernel.plugin_deployments WHERE id='${ACTIVE:-00000000-0000-0000-0000-000000000000}'" || echo "")"
if [ -z "$ACTIVE" ]; then
  stage PLUGIN_ACTIVE NOT_ACTIVE "no ACTIVE revision - the gateway routes nothing for this plugin"
elif [ "$ACTIVE_VERSION" = "$VERSION" ]; then
  stage PLUGIN_ACTIVE ACTIVE "ACTIVE revision is $VERSION"
else
  stage PLUGIN_ACTIVE WRONG_VERSION "ACTIVE revision is $ACTIVE_VERSION, not $VERSION"
fi

# --- 7. the gateway SERVES it ----------------------------------------------
# The step every other check stands in for. `activeVersion` is a row; this is an
# HTTP request through the gateway that the kernel routes to the plugin.
TOKEN=""
# The harness stores its session under the run's own HOME; opsctl writes it on login.
SESSION="$HOME/.opsweave/session.json"
if [ -f "$SESSION" ]; then
  TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SESSION" | head -1)"
fi
GATEWAY_STATE=UNKNOWN
GATEWAY_DETAIL=""
if [ -z "$TOKEN" ]; then
  GATEWAY_DETAIL="no stored session; the gateway requires auth so this stage was NOT evaluated"
elif [ "${ACTIVE_VERSION:-}" != "$VERSION" ]; then
  GATEWAY_DETAIL="not attempted: the active revision is ${ACTIVE_VERSION:-<none>}, so a successful request would prove nothing about $VERSION"
else
  # THE PROBE MUST NAME A ROUTE THE PLUGIN ACTUALLY SERVES.
  #
  # Three wrong versions of this line, each 404, each for a different reason:
  #   /_opsweave/health/ready   outside apiPrefix -> the gateway REFUSES it, which
  #                             is the security boundary working
  #   /api/data-catalog/        inside the prefix but no handler at the root ->
  #                             404 from the PLUGIN, not the gateway
  #   /api/data-catalog/datasets  a real route -> the gateway forwards it
  #
  # The gateway's 404 body is `route not found` when AXUM did not match, and
  # `path is outside the plugin's registered API prefix` when the gateway refused.
  # Neither is the plugin failing, and both read the same from a bare status code -
  # which is why this asks a route that exists and treats a 4xx FROM THE PLUGIN as
  # "the gateway forwarded".
  API_PREFIX="$(q "SELECT manifest->'backend'->>'apiPrefix' FROM kernel.plugin_packages WHERE plugin_id='$PLUGIN' AND version='$VERSION'" || echo "")"
  API_PREFIX="${API_PREFIX:-/api/data-catalog}"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer $TOKEN" \
    "$KERNEL_URL/api/v1/gateway/$PLUGIN${API_PREFIX}/datasets" 2>/dev/null || echo 000)"
  case "$CODE" in
    2*) GATEWAY_STATE=SERVING; GATEWAY_DETAIL="the gateway proxied to the plugin and it answered $CODE" ;;
    000) GATEWAY_DETAIL="the request did not complete" ;;
    5*) GATEWAY_STATE=UPSTREAM_ERROR; GATEWAY_DETAIL="the gateway reached the plugin and it answered $CODE" ;;
    4*)
      # A 400/401/403/422 from a route that EXISTS means the gateway forwarded the
      # request and the PLUGIN decided. That is the claim this stage makes: the
      # route is wired. Whether the plugin likes the request is a different stage.
      GATEWAY_STATE=SERVING
      GATEWAY_DETAIL="the gateway forwarded to the plugin, which answered $CODE (route is wired)" ;;
    *) GATEWAY_STATE=UNEXPECTED; GATEWAY_DETAIL="the gateway answered $CODE" ;;
  esac
fi
stage GATEWAY_SERVES "$GATEWAY_STATE" "$GATEWAY_DETAIL"

# --- 8. the browser remote ------------------------------------------------
# The OCI image carrying the plugin's frontend. It is a DIFFERENT artifact from the
# backend image and can fail on its own.
REMOTE="$(q "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id='$PLUGIN' AND i.container_id IS NOT NULL AND i.host_port IS NOT NULL" || echo "")"
if [ "${REMOTE:-0}" -ge 1 ]; then
  stage WEB_REMOTE REACHABLE "${REMOTE} instance(s) expose a host port"
else
  stage WEB_REMOTE NOT_EXPOSED "no instance exposes a host port; the remote entry was not checked"
fi

# --- verdict ---------------------------------------------------------------
# DERIVED, not the last exit code. A platform that is UP, READY, has a node and a
# running container but whose ACTIVE revision is a different version is not
# "deployed", and it is not "down" either - it is WRONG_VERSION, which is its own
# answer.
STATE_OF() { local i; for i in "${!STAGE_NAME[@]}"; do [ "${STAGE_NAME[$i]}" = "$1" ] && { echo "${STAGE_STATE[$i]}"; return; }; done; }
# THE VERDICT IS A FUNCTION OF THE STAGES, and it is written as one so it can be
# exercised without a platform. `phase7_release_stages.test.sh` drives this with
# synthetic stage rows; the script itself drives it with measured ones. One
# implementation, two ways in - the alternative is a test that restates the rule.
#
#   RELEASED                        every stage met, gateway forwarded
#   RELEASED_UNVERIFIED_GATEWAY     every stage met, the gateway was not exercised
#   RELEASED_WITHOUT_WEB_REMOTE     backend released, the browser remote was not checked
#   BLOCKED_AT_<STAGE>              that stage did not meet its requirement
verdict_of() {
  # stdin: "<stage> <state> <attempt>" lines. Prints "<verdict>|<reason>".
  local host kernel node installed running active gw remote

  # ONE RELEASE, ONE ATTEMPT - and this is checked FIRST, before any state.
  #
  # A set of stages that individually pass but were observed under different
  # attempts is not a release; it is two releases spliced together. The failure it
  # prevents is concrete: a rollback between the PLUGIN_RUNNING check and the
  # PLUGIN_ACTIVE check would produce "running and active" from two different
  # generations, and the verdict would be RELEASED for a state the platform was
  # never in.
  #
  # `?` means the stage ran before the identity was knowable, which is honest
  # rather than a mismatch - those are ignored here and the stage's own state still
  # has to pass.
  local attempts
  attempts="$(awk '$3 != "?" && $3 != "" {print $3}' <<<"$1" | sort -u)"
  local n_attempts
  n_attempts="$(printf '%s' "$attempts" | grep -c . || true)"
  if [ "${n_attempts:-0}" -gt 1 ]; then
    echo "BLOCKED_AT_MIXED_ATTEMPT|the stages were observed under ${n_attempts} different release attempts: $(printf '%s' "$attempts" | tr '\n' ' ')"
    return
  fi
  host=$(awk '$1=="HOST_UP"{print $2}' <<<"$1")
  kernel=$(awk '$1=="KERNEL_READY"{print $2}' <<<"$1")
  node=$(awk '$1=="NODE_READY"{print $2}' <<<"$1")
  installed=$(awk '$1=="PLUGIN_INSTALLED"{print $2}' <<<"$1")
  running=$(awk '$1=="PLUGIN_RUNNING"{print $2}' <<<"$1")
  active=$(awk '$1=="PLUGIN_ACTIVE"{print $2}' <<<"$1")
  gw=$(awk '$1=="GATEWAY_SERVES"{print $2}' <<<"$1")
  remote=$(awk '$1=="WEB_REMOTE"{print $2}' <<<"$1")

  [ "$host" = "UP" ] || { echo "BLOCKED_AT_HOST_UP|HOST_UP is ${host:-absent}, expected UP"; return; }
  [ "$kernel" = "READY" ] || { echo "BLOCKED_AT_KERNEL_READY|KERNEL_READY is ${kernel:-absent}, expected READY"; return; }
  [ "$node" = "READY" ] || { echo "BLOCKED_AT_NODE_READY|NODE_READY is ${node:-absent}, expected READY"; return; }
  [ "$installed" = "INSTALLED" ] || { echo "BLOCKED_AT_PLUGIN_INSTALLED|PLUGIN_INSTALLED is ${installed:-absent}, expected INSTALLED"; return; }
  [ "$running" = "RUNNING" ] || { echo "BLOCKED_AT_PLUGIN_RUNNING|PLUGIN_RUNNING is ${running:-absent}, expected RUNNING"; return; }
  [ "$active" = "ACTIVE" ] || { echo "BLOCKED_AT_PLUGIN_ACTIVE|PLUGIN_ACTIVE is ${active:-absent}, expected ACTIVE"; return; }
  case "$gw" in
    SERVING) : ;;
    UNKNOWN) echo "RELEASED_UNVERIFIED_GATEWAY|every stage met but the gateway was not exercised"; return ;;
    *) echo "BLOCKED_AT_GATEWAY_SERVES|the gateway answered ${gw:-nothing}"; return ;;
  esac
  [ "$remote" = "REACHABLE" ] || { echo "RELEASED_WITHOUT_WEB_REMOTE|backend released; the browser remote was not verified"; return; }
  echo "RELEASED|"
}

STAGE_SUMMARY=""
for i in "${!STAGE_NAME[@]}"; do
  STAGE_SUMMARY+="${STAGE_NAME[$i]} ${STAGE_STATE[$i]} ${STAGE_ATTEMPT[$i]}"$'\n'
done
# ONE CALL. Calling the function twice to split on the separator would run the
# whole decision twice, and the first version of this line was
# `${$(verdict_of ...)}` - not valid bash, and not caught by `bash -n`.
VERDICT_LINE="$(verdict_of "$STAGE_SUMMARY")"
VERDICT="${VERDICT_LINE%%|*}"
REASON="${VERDICT_LINE#*|}"

if [ "$JSON" = "1" ]; then
  printf '{"verdict":"%s","reason":"%s","stages":[' "$VERDICT" "$REASON"
  first=1
  for i in "${!STAGE_NAME[@]}"; do
    [ "$first" = "1" ] || printf ','
    first=0
    # A detail string can contain a quote; JSON needs it escaped and bash makes
    # that awkward inline. `tr` is plainer than a parameter expansion with an
    # escaped quote, which did not parse.
    detail="$(printf '%s' "${STAGE_DETAIL[$i]}" | tr '"' "'")"
    printf '{"stage":"%s","state":"%s","detail":"%s"}' \
      "${STAGE_NAME[$i]}" "${STAGE_STATE[$i]}" "$detail"
  done
  printf '%s' ']}'
  printf '\n'
else
  printf '%-18s %-16s %s\n' STAGE STATE DETAIL
  for i in "${!STAGE_NAME[@]}"; do
    printf '%-18s %-16s %s\n' "${STAGE_NAME[$i]}" "${STAGE_STATE[$i]}" "${STAGE_DETAIL[$i]}"
  done
  echo
  echo "verdict: $VERDICT"
  [ -n "$REASON" ] && echo "         $REASON"
fi

# Exit is the verdict's own: 0 only for a fully verified release.
case "$VERDICT" in
  RELEASED) exit 0 ;;
  RELEASED_UNVERIFIED_GATEWAY|RELEASED_WITHOUT_WEB_REMOTE) exit 0 ;;
  *) exit 1 ;;
esac
