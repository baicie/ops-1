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

# Every installation identity this checkout's demo owns, one per line.
#
# demo_up.sh gives each node its own state directory, so node-a and node-b
# normally hold DIFFERENT installation ids. This used to return the first one it
# found and stop, which meant `demo_stop_containers` cleaned node-a and silently
# left node-b's containers running - a reset that reported success and did not
# finish. It now collects the whole set; duplicates collapse, because two nodes
# sharing an id is possible (a copied state directory) and removing that
# installation twice is pointless.
#
# Returns 0 and prints the ids, or returns 1 and prints nothing when there are
# none. It deliberately does NOT mint one: a stop script has no business
# creating an identity.
demo_installation_ids() {
  local dir id_file value
  local -a found=()
  for dir in node-a node-b; do
    id_file="$(demo_data_dir)/$dir/installation-id"
    [ -f "$id_file" ] || continue
    value="$(cat "$id_file" 2>/dev/null || true)"
    [ -n "$value" ] || continue
    local duplicate=0
    local existing
    for existing in ${found[@]+"${found[@]}"}; do
      [ "$existing" = "$value" ] && duplicate=1
    done
    [ "$duplicate" = "1" ] || found+=("$value")
  done
  [ "${#found[@]}" -gt 0 ] || return 1
  printf '%s\n' "${found[@]}"
}

# The first identity, for callers that only need to name one in a message.
demo_installation_id() { demo_installation_ids 2>/dev/null | head -1; }

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
  local install_ids
  if ! install_ids="$(demo_installation_ids)"; then
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
  # EVERY installation this checkout owns, not just the first. node-a and
  # node-b have separate state directories and therefore separate identities;
  # taking one and returning left the other's containers running behind a
  # message that said the stop succeeded.
  local install_id ids removed=0 with_containers=0
  while IFS= read -r install_id; do
    [ -n "$install_id" ] || continue
    ids="$(docker ps -aq --filter "label=opsweave.installation-id=$install_id" 2>/dev/null || true)"
    if [ -z "$ids" ]; then
      echo "   no containers belong to installation $install_id"
      continue
    fi
    with_containers=$((with_containers + 1))
    if [ "$mode" = "list" ]; then
      echo "   installation $install_id owns:"
      # shellcheck disable=SC2086
      docker ps -a --filter "label=opsweave.installation-id=$install_id" \
        --format '     {{.Names}}  {{.Status}}'
      continue
    fi
    # shellcheck disable=SC2086
    if ! echo "$ids" | xargs -r docker rm -f >/dev/null 2>&1; then
      echo "BLOCKED: could not remove the containers of installation $install_id;" >&2
      echo "         not widening the sweep" >&2
      return 1
    fi
    local count
    count="$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"
    removed=$((removed + count))
    echo "   removed $count container(s) of installation $install_id"
  done <<< "$install_ids"
  if [ "$mode" = "list" ]; then
    return 0
  fi
  if [ "$with_containers" = "0" ]; then
    return 0
  fi
  echo "   removed $removed container(s) across this checkout's installation(s)"
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
