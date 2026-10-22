#!/usr/bin/env bash
# A revoked publisher must not be able to deploy/activate an already-staged package.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DIR="$(mktemp -d /tmp/opsweave-publisher-test.XXXXXX)"
trap 'rm -rf "$DIR"' EXIT
./target/debug/opsctl --url "$URL" login --email "${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}" --password "${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}" >/dev/null
SESSION="$HOME/.opsweave/session.json"
TOKEN="$(python3 -c 'import json;print(json.load(open("'"$SESSION"'"))["token"])')"
CSRF="$(python3 -c 'import json;print(json.load(open("'"$SESSION"'"))["csrf"])')"
./target/debug/opsctl --url "$URL" keygen --out-dir "$DIR/keys" >/dev/null
PUB="$(cat "$DIR/keys/publisher.pub")"
python3 - "$PUB" > "$DIR/publisher.json" <<'PY'
import json, sys
print(json.dumps({"publisherId": "revoked-test", "publicKeyHex": sys.argv[1], "note": "negative test"}))
PY
curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -X POST "$URL/api/v1/publishers" --data-binary @"$DIR/publisher.json" >/dev/null
IMAGE="$(python3 -c 'import json;print(json.load(open("dist/plugins/index.json"))["images"]["hello-ts:0.0.1"])')"
mkdir -p "$DIR/plugin"
python3 - "$IMAGE" > "$DIR/plugin/manifest.json" <<'PY'
import json, sys
print(json.dumps({
  "schemaVersion": "1.1", "id": "dev.opsweave.revoked-test", "version": "0.0.1", "publisher": "revoked-test",
  "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1}, "artifactDigest": "sha256:" + "0" * 64,
  "backend": {"runtime": "oci", "imageRef": sys.argv[1],
    "protocol": {"name": "http-json", "version": "1", "containerPort": 8080},
    "health": {"readinessPath": "/_opsweave/health/ready", "livenessPath": "/_opsweave/health/live", "startupPath": "/_opsweave/health/startup"},
    "apiPrefix": "/api/hello"},
  "provides": [{"name": "sample.revoked.v1", "major": 1}], "requires": [], "permissions": [],
  "resources": {"cpuMillis": 100, "memoryMiB": 64}
}, indent=2))
PY
./target/debug/opsctl --url "$URL" bundle --dir "$DIR/plugin" --out "$DIR/plugin/plugin.zip" --key "$DIR/keys/publisher.key" >/dev/null
./target/debug/opsctl --url "$URL" install "$DIR/plugin/plugin.zip" >/dev/null
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" "$URL/api/v1/publishers/revoked-test" >/dev/null
set +e
OUT="$(./target/debug/opsctl --url "$URL" deploy dev.opsweave.revoked-test 0.0.1 --replicas 1 --selector role=node 2>&1)"
CODE=$?
set -e
[ "$CODE" -ne 0 ] || { echo "deploy unexpectedly succeeded: $OUT" >&2; exit 1; }
echo "$OUT" | grep -q 'PUBLISHER_REVOKED' || { echo "missing PUBLISHER_REVOKED: $OUT" >&2; exit 1; }
echo "publisher revocation gate passed: deploy rejected with PUBLISHER_REVOKED"
