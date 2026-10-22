#!/usr/bin/env bash
# Verify the public login endpoint has a small body limit and failed-login throttling.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
python3 - > /tmp/opsweave-oversized-login.json <<'PY'
print('{"email":"oversized@example.com","password":"' + 'a' * (3 * 1024 * 1024) + '"}', end='')
PY
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/opsweave-oversized-login.json "$URL/api/v1/auth/login" || true)"
[ "$STATUS" = "413" ] || { echo "expected oversized login 413, got $STATUS" >&2; exit 1; }
python3 - "$URL" <<'PY'
import json, sys, urllib.error, urllib.request
url = sys.argv[1] + "/api/v1/auth/login"
codes = []
for _ in range(12):
    request = urllib.request.Request(
        url,
        data=json.dumps({"email": "login-limit-test@example.com", "password": "wrong"}).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            codes.append(response.status)
    except urllib.error.HTTPError as error:
        codes.append(error.code)
if codes[-1] != 429:
    raise SystemExit(f"expected final login attempt 429, got {codes}")
print("login throttle codes:", codes)
PY
echo "auth limit test passed: oversized body 413; repeated failures end in 429"
