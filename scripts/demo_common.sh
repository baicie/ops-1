#!/usr/bin/env bash
# Shared safety for demo_up.sh / demo_down.sh.
#
# Both scripts stop things: processes by port, and containers by label. Both used
# to do it on a best guess - `lsof -t | xargs kill` assumes whatever holds the
# port is ours, and a global label sweep assumes every OpsWeave container on the
# daemon is ours. Neither assumption is true when a second checkout, a colleague
# or a stale process shares the machine.
#
# This file is sourced, not executed. It provides:
#   * demo_kill_port      - kill the listener ONLY if its command line proves it
#                           was started from this checkout
#   * demo_stop_containers- stop this installation's containers, and say BLOCKED
#                           when ownership cannot be established
#   * demo_installation_id- read this checkout's installation identity, or fail
#
# Every failure is loud. A stop that cannot prove what it is stopping says so and
# exits non-zero rather than continuing, because the next step is destructive.

# Where this checkout keeps the demo's node state. `data/` is a path inside the
# repository; a state directory outside it is a different installation.
demo_data_dir() { printf '%s/data' "$ROOT"; }

# Read the installation identity the nodes will use, if it exists.
#
# Returns 0 and prints the id, or returns 1 and prints nothing. It deliberately
# does NOT mint one: a stop script has no business creating an identity.
demo_installation_id() {
  local id_file
  for id_file in "$(demo_data_dir)/node-a/installation-id" "$(demo_data_dir)/node-b/installation-id"; do
    if [ -f "$id_file" ]; then
      local value
      value="$(cat "$id_file" 2>/dev/null || true)"
      if [ -n "$value" ]; then
        printf '%s\n' "$value"
        return 0
      fi
    fi
  done
  return 1
}

# Is `pid` a process this checkout started?
#
# The port is not ownership. A leftover `opsweave-kernel` from another checkout,
# a colleague's dev server, or anything else can hold 18181. The command line is
# the only evidence available cheaply, and it is enough to tell our binary from
# the rest - both because it names the binary and because `demo_up.sh` starts it
# with cwd inside this checkout.
demo_process_is_ours() {
  local pid="$1"
  local command
  command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -n "$command" ] || return 1
  case "$command" in
    *"$ROOT/target/debug/opsweave-kernel"* | *"$ROOT/target/debug/opsweave-node"*) return 0 ;;
    *"./target/debug/opsweave-kernel"* | *"./target/debug/opsweave-node"*)
      # A relative invocation is ours only if its cwd is this checkout.
      local cwd
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
      [ "$cwd" = "$ROOT" ] && return 0
      ;;
    # The published image runs the same binary under a different path; accept it
    # only when the process also names this checkout's data directory, which the
    # compose file passes explicitly.
    *opsweave-kernel* | *opsweave-node*)
      case "$command" in
        *"$ROOT/data"*) return 0 ;;
      esac
      ;;
  esac
  return 1
}

# Stop the process listening on `port`, but only if it is ours.
#
# Returns 0 when the port is free afterwards (whether we killed something or
# there was nothing there), 1 when a foreign process holds it. The caller decides
# what a foreign holder means; for both demo scripts it means BLOCKED.
demo_kill_port() {
  local port="$1"
  local pid
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 0
  if ! demo_process_is_ours "$pid"; then
    local command
    command="$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-120 || true)"
    {
      echo "BLOCKED: port $port is held by pid $pid, which this checkout did not start:"
      echo "         $command"
      echo "         Not killing it. Stop it yourself, or choose another OPSWEAVE_PORT."
    } >&2
    return 1
  fi
  kill "$pid" 2>/dev/null || true
  # Wait for the port to actually free. A process that ignores SIGTERM would
  # otherwise let the next step bind over a half-dead listener.
  local waited=0
  while [ "$waited" -lt 50 ]; do
    if [ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)" ]; then
      return 0
    fi
    sleep 0.2
    waited=$((waited + 1))
  done
  echo "BLOCKED: port $port is still held after asking pid $pid to stop" >&2
  return 1
}

# Remove this installation's containers.
#
# Ownership is the installation id, and nothing else. A container without that
# label is left alone: it may belong to another installation, to a colleague, or
# to a version that predates the label, and none of those are safe to delete on a
# guess. The caller gets the names of what was skipped so it can tell the
# operator.
#
# `$1` = "purge" to remove, "list" to only report.
demo_stop_containers() {
  local mode="${1:-purge}"
  local install_id
  if ! install_id="$(demo_installation_id)"; then
    # No identity can mean two very different things, and conflating them made
    # this refuse the ordinary first run (caught by CI: `legacy-regression`).
    #
    #   first run            nothing has ever been started under this checkout;
    #                        there is nothing to own and nothing to remove.
    #   lost identity        containers exist that belonged to this checkout and
    #                        can no longer be attributed - a partial restore or a
    #                        wiped state directory.
    #
    # The daemon distinguishes them: if no OpsWeave container exists at all, the
    # first case holds and cleanup is a correct no-op. If any exists, ownership
    # cannot be established and removing it would be a guess.
    local existing
    existing="$(docker ps -aq --filter "label=opsweave.managed=true" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${existing:-0}" = "0" ]; then
      echo "   no installation identity and no OpsWeave containers: nothing to stop"
      return 0
    fi
    echo "BLOCKED: no installation identity under $(demo_data_dir)," >&2
    echo "         but $existing OpsWeave container(s) exist on this daemon." >&2
    echo "         They cannot be attributed to this checkout, so removing them" >&2
    echo "         would be a guess. To see them:" >&2
    echo "           docker ps -a --filter label=opsweave.managed=true" >&2
    return 1
  fi
  local ids
  ids="$(docker ps -aq --filter "label=opsweave.installation-id=$install_id" 2>/dev/null || true)"
  if [ -z "$ids" ]; then
    echo "   no containers belong to installation $install_id"
    return 0
  fi
  if [ "$mode" = "list" ]; then
    echo "   installation $install_id owns:"
    # shellcheck disable=SC2086
    docker ps -a --filter "label=opsweave.installation-id=$install_id" \
      --format '     {{.Names}}  {{.Status}}'
    return 0
  fi
  # shellcheck disable=SC2086
  if ! echo "$ids" | xargs -r docker rm -f >/dev/null 2>&1; then
    echo "BLOCKED: could not remove this installation's containers; not widening the sweep" >&2
    return 1
  fi
  echo "   removed $(printf '%s\n' "$ids" | wc -l | tr -d ' ') container(s) of installation $install_id"
  # Say what was NOT removed, so an old container is never a silent leftover.
  local unlabelled
  unlabelled="$(docker ps -a --filter "label=opsweave.managed=true" --format '{{.Names}}' 2>/dev/null \
    | while read -r name; do
        [ -n "$name" ] || continue
        label="$(docker inspect -f '{{index .Config.Labels "opsweave.installation-id"}}' "$name" 2>/dev/null || true)"
        if [ -z "$label" ] || [ "$label" = "<no value>" ]; then printf '%s\n' "$name"; fi
      done || true)"
  if [ -n "$unlabelled" ]; then
    echo "   left alone (no installation label, cannot be attributed):"
    printf '%s\n' "$unlabelled" | sed 's/^/     /'
    echo "   remove them deliberately with: docker rm -f <name>"
  fi
  return 0
}
