#!/usr/bin/env bash
# Characterization of the kernel's CURRENT API authorization policy (G10 / Phase C1).
#
# This script does not assert a policy anyone proposed; it asserts the policy that is
# implemented today, so a later "harmless" edit cannot silently tighten or widen it.
# Changing an expectation here IS a change of security policy and needs an ADR entry
# (docs/design/g10-closure/permission-adr.md).
#
# Read-only by construction: every probe is a GET, except one POST to
# /api/v1/pipelines/validate, which validates a definition and persists nothing.
#
# Two layers are covered, because they are two different mechanisms:
#   * surface layer  - GET /api/v1/auth/me -> access.allowedSurfaces / .capabilities
#   * resource layer - the per-handler require_admin / require_operator gates
#
# Usage:
#   tests/acceptance/permission_matrix.sh                 # admin column only
#   OPSWEAVE_VIEWER_EMAIL=... OPSWEAVE_VIEWER_PASSWORD=... \
#   OPSWEAVE_OPERATOR_EMAIL=... OPSWEAVE_OPERATOR_PASSWORD=... \
#     tests/acceptance/permission_matrix.sh               # all three role columns
#
# The role columns are SKIPPED (never faked) when their credentials are not supplied:
# this script does not create users, so it also runs against a shared environment.
set -uo pipefail

URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
PASS=0
FAIL=0
SKIP=0
FAILED_LABELS=()

ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED_LABELS+=("$*"); printf 'FAIL  %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s\n' "$*"; }

# admin bearer token: the same file tests/acceptance/data_authz.sh reads
TOKEN="${OPSWEAVE_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.opsweave/session.json" ]; then
  TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])' 2>/dev/null || true)"
fi
[ -n "$TOKEN" ] || { echo "no admin token: set OPSWEAVE_TOKEN or ~/.opsweave/session.json"; exit 2; }
ADMIN=(-H "Authorization: Bearer $TOKEN")

get_code() { # method path extra-curl-args...
  local method="$1" path="$2"; shift 2
  curl -sS -m 10 -o /tmp/permission-matrix-body.json -w '%{http_code}' -X "$method" "$@" "$URL$path"
}

check() { # expected actual label
  if [ "$2" = "$1" ]; then ok "$3 -> $2"; else bad "$3 -> $2 (expected $1)"; fi
}

not_403() { # actual label
  if [ "$1" = "403" ]; then bad "$2 -> 403 (gate did not reach the handler)"; else ok "$2 -> $1 (gate passed)"; fi
}

json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

# --- role session helper: cookie jar + CSRF, exactly like a browser session ---------
role_get_code() { # jar csrf path
  curl -sS -m 10 -o /tmp/permission-matrix-body.json -w '%{http_code}' -b "$1" -H "x-csrf-token: $2" "$URL$3"
}
role_post_code() { # jar csrf path body
  curl -sS -m 10 -o /tmp/permission-matrix-body.json -w '%{http_code}' -b "$1" \
    -H "x-csrf-token: $2" -H 'content-type: application/json' -X POST "$URL$3" -d "$4"
}
login_role() { # email password jar -> prints csrf token (empty on failure)
  local email="$1" password="$2" jar="$3" body
  body="$(curl -sS -m 10 -c "$jar" -H 'content-type: application/json' "$URL/api/v1/auth/login" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" 2>/dev/null)"
  printf '%s' "$body" | json "d['csrfToken']"
}

echo "== kernel that answers: $URL"
curl -sS -m 10 -o /dev/null "$URL/livez" || { echo "kernel is not reachable at $URL"; exit 2; }

echo
echo "== Anonymous never reads anything (the resource layer runs before the handler)"
for path in /api/v1/nodes /api/v1/plugins /api/v1/overview /api/v1/audit \
            /api/v1/users /api/v1/diagnostics /api/v1/settings/runtime-policies \
            /api/v1/pipelines /api/v1/jobs; do
  check 401 "$(get_code GET "$path")" "anonymous GET $path"
done

echo
echo "== Admin: declared surfaces and the admin-only resource gates"
check 200 "$(get_code GET /api/v1/auth/me "${ADMIN[@]}")" "admin GET /api/v1/auth/me"
ACCESS="$(cat /tmp/permission-matrix-body.json | json "(','.join(d['access']['allowedSurfaces']) + ' ' + ','.join(d['access']['capabilities']))")"
case "$ACCESS" in
  "workspace,admin platform:access,workspace:access") ok "admin access declaration = $ACCESS" ;;
  *) bad "admin access declaration = $ACCESS (expected workspace,admin platform:access,workspace:access)" ;;
esac
check 200 "$(get_code GET /api/v1/users "${ADMIN[@]}")" "admin GET /api/v1/users"
check 200 "$(get_code GET /api/v1/diagnostics "${ADMIN[@]}")" "admin GET /api/v1/diagnostics"
check 200 "$(get_code GET /api/v1/settings/runtime-policies "${ADMIN[@]}")" "admin GET /api/v1/settings/runtime-policies"
check 200 "$(get_code GET /bootstrap "${ADMIN[@]}")" "admin GET /bootstrap"

# GETs with no role gate at all: any authenticated session may read them.
for path in /api/v1/overview /api/v1/plugins /api/v1/nodes /api/v1/publishers \
            /api/v1/audit /api/v1/pipelines /api/v1/jobs /api/v1/extensions \
            /api/v1/capabilities; do
  check 200 "$(get_code GET "$path" "${ADMIN[@]}")" "admin GET $path (ungated handler)"
done

# --- role columns ---------------------------------------------------------------
VIEWER_EMAIL="${OPSWEAVE_VIEWER_EMAIL:-}"
VIEWER_PASSWORD="${OPSWEAVE_VIEWER_PASSWORD:-}"
OPERATOR_EMAIL="${OPSWEAVE_OPERATOR_EMAIL:-}"
OPERATOR_PASSWORD="${OPSWEAVE_OPERATOR_PASSWORD:-}"

if [ -n "$VIEWER_EMAIL" ] && [ -n "$VIEWER_PASSWORD" ]; then
  echo
  echo "== Viewer: authenticated read-only, no console surface"
  VIEWER_JAR=/tmp/permission-matrix-viewer.cookies
  VIEWER_CSRF="$(login_role "$VIEWER_EMAIL" "$VIEWER_PASSWORD" "$VIEWER_JAR")"
  if [ -z "$VIEWER_CSRF" ]; then
    bad "viewer login failed for $VIEWER_EMAIL"
  else
    check 200 "$(role_get_code "$VIEWER_JAR" "$VIEWER_CSRF" /api/v1/auth/me)" "viewer GET /api/v1/auth/me"
    VIEWER_ACCESS="$(cat /tmp/permission-matrix-body.json | json "(','.join(d['access']['allowedSurfaces']) + ' ' + ','.join(d['access']['capabilities']))")"
    case "$VIEWER_ACCESS" in
      "workspace workspace:access") ok "viewer access declaration = $VIEWER_ACCESS" ;;
      *) bad "viewer access declaration = $VIEWER_ACCESS (expected workspace workspace:access)" ;;
    esac
    # The resource layer grants these to *every* authenticated session (routes.rs +
    # the handlers): hiding them in navigation does not deny the data.
    for path in /api/v1/overview /api/v1/plugins /api/v1/nodes /api/v1/publishers \
                /api/v1/audit /api/v1/pipelines /api/v1/jobs /api/v1/extensions \
                /api/v1/capabilities; do
      check 200 "$(role_get_code "$VIEWER_JAR" "$VIEWER_CSRF" "$path")" "viewer GET $path (ungated handler)"
    done
    for path in /api/v1/users /api/v1/diagnostics /api/v1/settings/runtime-policies /bootstrap; do
      check 403 "$(role_get_code "$VIEWER_JAR" "$VIEWER_CSRF" "$path")" "viewer GET $path (role gate)"
    done
    check 403 "$(role_post_code "$VIEWER_JAR" "$VIEWER_CSRF" /api/v1/pipelines/validate '{}')" \
      "viewer POST /api/v1/pipelines/validate (operator gate)"
  fi
else
  skip "viewer column (set OPSWEAVE_VIEWER_EMAIL / OPSWEAVE_VIEWER_PASSWORD)"
fi

if [ -n "$OPERATOR_EMAIL" ] && [ -n "$OPERATOR_PASSWORD" ]; then
  echo
  echo "== Operator: management APIs without the console surface"
  OPERATOR_JAR=/tmp/permission-matrix-operator.cookies
  OPERATOR_CSRF="$(login_role "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD" "$OPERATOR_JAR")"
  if [ -z "$OPERATOR_CSRF" ]; then
    bad "operator login failed for $OPERATOR_EMAIL"
  else
    check 200 "$(role_get_code "$OPERATOR_JAR" "$OPERATOR_CSRF" /api/v1/auth/me)" "operator GET /api/v1/auth/me"
    OPERATOR_ACCESS="$(cat /tmp/permission-matrix-body.json | json "(','.join(d['access']['allowedSurfaces']) + ' ' + ','.join(d['access']['capabilities']))")"
    # The C1 question in one assertion: operator holds platform management powers
    # (below) while the server declares no console surface for it.
    case "$OPERATOR_ACCESS" in
      "workspace workspace:access") ok "operator access declaration = $OPERATOR_ACCESS" ;;
      *) bad "operator access declaration = $OPERATOR_ACCESS (expected workspace workspace:access)" ;;
    esac
    # operator-gated handler: reaches the handler and fails on the body, not on the gate
    not_403 "$(role_post_code "$OPERATOR_JAR" "$OPERATOR_CSRF" /api/v1/pipelines/validate '{}')" \
      "operator POST /api/v1/pipelines/validate"
    check 200 "$(role_get_code "$OPERATOR_JAR" "$OPERATOR_CSRF" /bootstrap)" "operator GET /bootstrap (operator gate)"
    for path in /api/v1/users /api/v1/diagnostics /api/v1/settings/runtime-policies; do
      check 403 "$(role_get_code "$OPERATOR_JAR" "$OPERATOR_CSRF" "$path")" "operator GET $path (admin gate)"
    done
    for path in /api/v1/nodes /api/v1/plugins /api/v1/audit /api/v1/jobs /api/v1/pipelines; do
      check 200 "$(role_get_code "$OPERATOR_JAR" "$OPERATOR_CSRF" "$path")" "operator GET $path (ungated handler)"
    done
  fi
else
  skip "operator column (set OPSWEAVE_OPERATOR_EMAIL / OPSWEAVE_OPERATOR_PASSWORD)"
fi

echo
printf 'permission matrix: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed assertions:\n'
  printf '  - %s\n' "${FAILED_LABELS[@]}"
  exit 1
fi
if [ "$SKIP" -ne 0 ]; then
  printf 'NOTE: skipped columns are unverified, not passing.\n'
fi
exit 0
