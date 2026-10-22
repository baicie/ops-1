#!/usr/bin/env bash
# Install and activate the two independent 0.0.2 Data Foundation plugins.
# Requires: BUILD=1 scripts/build-data-plugins.sh first, platform running, opsctl session.
# For the local HTTP/JSON fixture: (cd tests/fixtures && python3 -m http.server 18090)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:${OPSWEAVE_PORT:-18181}}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
auth=(-H "Authorization: Bearer $TOKEN")
for plugin in opsweave.data-catalog opsweave.data-integration; do
  echo "== storage binding $plugin"
  curl -fsS -X POST "${auth[@]}" "$URL/api/v1/plugin-storage/$plugin" >/dev/null
done
echo "== install bundles"
./target/debug/opsctl --url "$URL" install dist/plugins/data-catalog-0.0.1.plugin.zip
./target/debug/opsctl --url "$URL" install dist/plugins/data-integration-0.0.1.plugin.zip
echo "== deploy/activate catalog"
./target/debug/opsctl --url "$URL" deploy opsweave.data-catalog 0.0.1 --replicas 1 --selector role=node --wait
./target/debug/opsctl --url "$URL" activate opsweave.data-catalog 0.0.1
echo "== grant data.catalog.v1 to integration"
curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' "$URL/api/v1/capability-grants" \
  -d '{"name":"data.catalog.v1","major":1,"consumerPluginId":"opsweave.data-integration","scope":["dataset:read","dataset:write"]}' >/dev/null
echo "== deploy/activate integration"
./target/debug/opsctl --url "$URL" deploy opsweave.data-integration 0.0.1 --replicas 1 --selector role=node --wait
./target/debug/opsctl --url "$URL" activate opsweave.data-integration 0.0.1
echo "Data Foundation plugins are active at $URL"
