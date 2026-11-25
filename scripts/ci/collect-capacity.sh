#!/usr/bin/env bash
# Collect deployment capacity from the staging host, for the staging-deploy artifact.
#
# WHY THIS IS A SCRIPT AND NOT A `run:` BLOCK
#
# The logic that matters here is not the happy path. It is what gets written when
# the collection FAILS, because the failure case is the one that runs on a full
# node - which is the only reason this step exists. A `run:` block cannot be tested
# without a runner and a staging host, so its failure branch would ship unexercised.
# As a file it can be driven against a stub `ssh`, which is what
# `tests/scripts/collect-capacity.test.sh` does.
#
# THE QUESTION THIS ANSWERS
#
# On 2026-11-25 a fix for staging's INSTANCE_CAPACITY_EXCEEDED condition was
# deployed and did not release any of the four occupants. The run could not say
# why, because no artifact carried a deployment's status or its age - the occupants
# appeared only inside an error string, with no status and no timestamp. Answering
# "which of these is READY, and since when" needed the staging database, which the
# person reading the run did not have.
#
# `opsctl capacity --json` answers exactly that, read-only, and this script puts it
# in the artifact.
#
# WHAT IT IS NOT ALLOWED TO DO
#
# Fail the job. A deploy that worked must not turn red because a diagnostic could
# not run: on a first deploy or a rotated credential there may be no session yet.
# Every failure path writes a NAMED document and exits 0, and the named document
# matters as much as the success document - an absent or empty capacity.json reads
# as "there were no occupants", which is the opposite of a full node.
set -uo pipefail

OUT="${1:-artifacts/staging-preview/capacity.json}"
ERR="${2:-artifacts/staging-preview/capacity.stderr}"
SSH_HOST="${SSH_HOST_ALIAS:-opsweave-staging}"
REASON="$OUT.reason"

mkdir -p "$(dirname "$OUT")"

# THE CONTAINER IS FOUND, NOT GUESSED. `opsweave-staging-kernel-1` is what a compose
# project named `opsweave-staging` with a service named `kernel` produces, and it is
# the default in `scripts/publish-data-plugins.sh:50` - but a hard-coded name that
# drifts would make this step fail forever with a message about docker rather than
# about capacity. Asking compose for the id by service label survives a rename.
#
# THE SCRIPT ARRIVES ON STDIN. An earlier version passed a quoted one-liner built
# with `printf %q`, a BASH builtin that does not exist in the `sh` the remote side
# runs. A file piped into `sh -s` has no quoting of its own to get wrong.
remote_script() {
  cat <<'REMOTE'
set -eu
cid="$(docker ps -q --filter label=com.docker.compose.service=kernel --filter label=com.docker.compose.project=opsweave-staging | head -1)"
[ -n "$cid" ] || { echo "no running kernel container for project opsweave-staging" >&2; exit 3; }
docker exec "$cid" /usr/local/bin/opsctl capacity --json
REMOTE
}

# Write a named failure document. The detail is escaped by python3 rather than by a
# printf substitution: stderr carries quotes, newlines and paths, and a half-escaped
# string produces an artifact no parser can read - worse than the empty file this
# replaces.
write_unavailable() {
  local code="$1"
  printf '%s' "$2" > "$REASON"
  python3 -c '
import json, sys
reason = open(sys.argv[1], encoding="utf-8", errors="replace").read()
open(sys.argv[2], "w", encoding="utf-8").write(
    json.dumps({"error": sys.argv[3], "detail": reason}) + "\n")
' "$REASON" "$OUT" "$code"
}

remote_script > /tmp/collect-capacity-remote.$$.sh
if ssh -F "${SSH_CONFIG_FILE:-/dev/null}" -o BatchMode=yes "$SSH_HOST" \
     'sudo -n sh -s' < /tmp/collect-capacity-remote.$$.sh > "$OUT" 2> "$ERR"; then
  rm -f /tmp/collect-capacity-remote.$$.sh
  # AN EMPTY BUT SUCCESSFUL RESPONSE IS NOT A RESULT. `ssh` exits 0 when the remote
  # command exits 0, and a tool that printed nothing satisfies that. Uploading a
  # zero-byte capacity.json would be read as "no occupants" by anything downstream,
  # so empty is treated as unavailable rather than as an answer.
  if [ ! -s "$OUT" ]; then
    write_unavailable capacity-empty "ssh succeeded but opsctl capacity printed nothing"
    echo "::warning::opsctl capacity printed nothing"
    exit 0
  fi
  # THE ARTIFACT MUST PARSE. A partial write (a container killed mid-response) would
  # otherwise upload unparseable JSON, and a reader would have to guess whether that
  # meant "no occupants" or "the tool broke".
  if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT" 2>/dev/null; then
    write_unavailable capacity-unparseable "$(head -c 400 "$OUT" 2>/dev/null)"
    echo "::warning::opsctl capacity produced unparseable output"
    exit 0
  fi
  head -c 2000 "$OUT" || true
  exit 0
fi

# Nothing here may fail the job; see the header.
rm -f /tmp/collect-capacity-remote.$$.sh
head -c 400 "$ERR" 2>/dev/null > "$REASON" || : > "$REASON"
write_unavailable capacity-unavailable "$(cat "$REASON" 2>/dev/null)"
echo "::warning::could not collect deployment capacity: $(cat "$REASON" 2>/dev/null)"
exit 0
