#!/usr/bin/env bash
# Install and activate the dev.opsweave.hello demo plugin - the plugin tests/ui/visual.spec.ts
# needs for its plugin-detail, remote-extension and instance-log cases.
#
# Idempotent: when the plugin is already installed, active at the wanted version and serving at
# least one READY instance, this exits 0 without writing anything to the platform. Re-running it
# therefore costs one authenticated GET and nothing else.
#
# Requires: a published bundle (scripts/publish-demo-hello-plugin.sh) and an opsctl session
#           (`opsctl --url <url> login --email <email> --password <password>`).
# Uninstall: opsctl --url <url> uninstall dev.opsweave.hello
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

URL="${OPSWEAVE_URL:-http://127.0.0.1:${OPSWEAVE_PORT:-18181}}"
VERSION="${OPSWEAVE_HELLO_VERSION:-0.0.1}"
PLUGIN="dev.opsweave.hello"
SELECTOR="${OPSWEAVE_HELLO_SELECTOR:-role=node}"
BUNDLE="${OPSWEAVE_HELLO_BUNDLE:-dist/plugins/hello-ops-${VERSION}.plugin.zip}"
OPSCTL="./target/debug/opsctl"

TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"

# state -> "<state> <activeVersion> <readyInstances>"
read -r CURRENT_STATE CURRENT_VERSION READY <<<"$(
  curl -fsS -H "Authorization: Bearer ${TOKEN}" "${URL}/api/v1/plugins" |
    python3 -c '
import json,sys
plugin = sys.argv[1]
for item in json.load(sys.stdin):
    if item.get("id") == plugin:
        print(item.get("state") or "UNKNOWN", item.get("activeVersion") or "-", item.get("readyInstances") or 0)
        break
else:
    print("ABSENT", "-", 0)
' "${PLUGIN}"
)"

if [ "${CURRENT_STATE}" = "INSTALLED" ] && [ "${CURRENT_VERSION}" = "${VERSION}" ] && [ "${READY}" -ge 1 ]; then
  echo "${PLUGIN}@${VERSION} already installed and serving ${READY} READY instance(s); nothing to do."
  exit 0
fi

echo "== current state: ${CURRENT_STATE} active=${CURRENT_VERSION} ready=${READY}"
# Only a package that is not on the platform gets uploaded: reinstalling a staged version is a
# conflict, not a repair, and a half-installed plugin is handled by uninstalling it first.
if [ "${CURRENT_STATE}" = "ABSENT" ]; then
  [ -f "${BUNDLE}" ] || { echo "missing bundle ${BUNDLE}; run scripts/publish-demo-hello-plugin.sh first" >&2; exit 1; }
  echo "== install ${PLUGIN} ${VERSION}"
  "${OPSCTL}" --url "${URL}" install "${BUNDLE}"
else
  echo "== ${PLUGIN} is already staged; skipping upload"
fi

echo "== deploy ${PLUGIN} ${VERSION} (1 replica, ${SELECTOR})"
"${OPSCTL}" --url "${URL}" deploy "${PLUGIN}" "${VERSION}" --replicas 1 --selector "${SELECTOR}" --wait

echo "== activate ${PLUGIN} ${VERSION}"
"${OPSCTL}" --url "${URL}" activate "${PLUGIN}" "${VERSION}"

echo "${PLUGIN}@${VERSION} is active at ${URL}"
