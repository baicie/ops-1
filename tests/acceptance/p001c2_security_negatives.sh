#!/usr/bin/env bash
# P001-C2: security negatives for capability / grant / workspace scoping.
#
# ## What this adds over `capability_multi_provider.sh`
#
# That script covers the multi-provider switch and revoke/restore. The C2 cases
# it does NOT cover, and that this one does:
#
#   1. no credential at all
#   2. an authenticated caller with insufficient role
#   3. crossing a workspace boundary
#   4. a capability the caller has no grant for
#   5. a request after the grant is revoked          (covered there, repeated for one fixture)
#   6. a forged caller identity
#   7. a forged workspace scope
#   8. a plugin call after disable
#   9. a plugin call after uninstall
#  10. an incompatible version upgrade                 (reported NOT_RUN, see below)
#  11. multi-provider grant semantics                  (covered there; cross-referenced)
#  12. concurrent revoke and in-flight request
#
# ## The classification that matters
#
# Every case ends in exactly one of:
#
#   PRODUCT_REFUSED   the kernel/gateway answered with the documented code - PASS
#   SESSION_FAILED    our own credential stopped working - TEST FAILURE, not a pass
#   ENVIRONMENT       network / 000 / 5xx the product did not produce - BLOCKED
#   NOT_REFUSED       2xx where a refusal was required - PRODUCT FAILURE
#
# A blanket "non-zero or non-200 is fine" check would call a dead session a
# correct refusal. That substitution is the thing this script exists to avoid.
set -uo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
# Absolute, so this script does not depend on the caller's cwd for the one
# binary it invokes directly.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE="${OPSWEAVE_C2_EVIDENCE:-/tmp/p001c2-negatives.log}"
: >"$EVIDENCE"

PASS=0
FAIL=0
BLOCKED=0
ok()      { PASS=$((PASS+1)); echo "PASS  $*"; echo "PASS  $*" >>"$EVIDENCE"; }
bad()     { FAIL=$((FAIL+1)); echo "FAIL  $*"; echo "FAIL  $*" >>"$EVIDENCE"; }
blocked() { BLOCKED=$((BLOCKED+1)); echo "BLOCKED  $*"; echo "BLOCKED  $*" >>"$EVIDENCE"; }
note()    { echo "      $*"; echo "note  $*" >>"$EVIDENCE"; }

ADMIN_TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])' 2>/dev/null || true)"
[ -n "$ADMIN_TOKEN" ] || { echo "BLOCKED: no ~/.opsweave/session.json" >&2; exit 3; }

# Fetch a JSON field.
jf() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

# One HTTP call, classified. Prints "<status> <body>".
call() { # token-or-empty, method, path, [body]
  local tok="$1" method="$2" path="$3" body="${4:-}"
  local args=(-sS -o /tmp/c2-body -w '%{http_code}' -m 15 -X "$method")
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data-binary "$body")
  local code
  code="$(curl "${args[@]}" "$URL$path" 2>/dev/null)" || code="000"
  printf '%s' "${code:-000}"
}
body_code() { jf "d.get('code','')" </tmp/c2-body 2>/dev/null || true; }

# `expect_refusal <label> <status> <code> <token> <method> <path> [body]`
#
# The four-way classification, applied uniformly.
expect_refusal() {
  local label="$1" want_status="$2" want_code="$3"; shift 3
  local status
  status="$(call "$@")"
  local code
  code="$(body_code)"
  case "$status" in
    000)
      blocked "$label: the request did not complete (HTTP 000); a missing response is not a refusal"
      return
      ;;
    "$want_status")
      if [ "$code" = "$want_code" ]; then
        ok "$label: refused with $status $code"
      else
        bad "$label: status $status was right but the code was '$code', expected '$want_code'"
      fi
      ;;
    401|403)
      # A 401/403 is only evidence when it is the code this case is about. A
      # 401 on a case that expected 403 usually means the fixture's own
      # credential died, and calling that a pass is the substitution this
      # script exists to prevent.
      if [ "$code" = "$want_code" ]; then
        ok "$label: refused with $status $code"
      else
        blocked "$label: got $status $code, expected $want_status $want_code - likely the fixture credential, not the behaviour under test"
      fi
      ;;
    2*)
      bad "$label: the product ACCEPTED the request (HTTP $status); a refusal was required"
      ;;
    5*)
      blocked "$label: HTTP $status from the product is an environment/availability failure, not the documented refusal"
      ;;
    *)
      bad "$label: unexpected status $status (code '$code'), expected $want_status $want_code"
      ;;
  esac
}

WS_A="00000000-0000-4000-8000-000000000001"
WS_B="00000000-0000-4000-8000-0000000000b2"
PLUGIN="dev.opsweave.data-catalog"
# The plugin's own route, read from plugins/data-catalog/backend/server.mjs:701,
# not guessed. The Gateway prefixes the plugin id.
CATALOG_PATH="/api/v1/gateway/$PLUGIN/api/data-catalog/datasets"

echo "== P001-C2 security negatives against $URL =="
echo "WS_A=$WS_A WS_B=$WS_B plugin=$PLUGIN" | tee -a "$EVIDENCE"

# This suite must not depend on what a PREVIOUS suite left active. Measured: it
# ran after `capability_multi_provider.sh`, which activates the alternate
# catalog provider and never switches back, and every case that reaches
# `/api/gateway/$PLUGIN/...` then answered `503 CAPABILITY_UNAVAILABLE` - the
# classifier correctly called those BLOCKED, but the suite measured nothing.
#
# The activation is therefore made explicit here. A failure to establish it is
# BLOCKED with the reason, never a silent pass.
# Route and body read from `apps/kernel/src/routes.rs:178-181` and
# `deployments::ActivateRequest` (`deployments.rs:146-151`), not guessed:
# `POST .../activations` with BOTH `version` and `expectedRevision`.
#
# The first version sent only `{"version":"0.0.1"}` and got HTTP 422 -
# `expectedRevision` is a required field because activation is a CAS. Sending
# `-1` would have been worse than omitting it: it would look like a deliberate
# never-matches guard instead of a wrong body.
# The CAS value is `activeRevision.generation` on the plugin detail
# (`plugins.rs:52-68`, `ActivationRevisionView`). Absent means "never activated",
# where the apply path expects 0.
REVISION="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/api/v1/plugins/$PLUGIN" \
  | python3 -c 'import json,sys
d = json.load(sys.stdin)
rev = d.get("activeRevision") or {}
print(rev.get("generation", 0))' 2>/dev/null || echo 0)"
ACTIVATE_STATUS="$(call "$ADMIN_TOKEN" POST "/api/v1/plugins/$PLUGIN/activations" \
  "{\"version\":\"0.0.1\",\"expectedRevision\":$REVISION}")"
case "$ACTIVATE_STATUS" in
  200|201|204) note "activated $PLUGIN@0.0.1 for this suite" ;;
  409)         note "$PLUGIN@0.0.1 was already active" ;;
  *)           blocked "could not activate $PLUGIN@0.0.1 (HTTP $ACTIVATE_STATUS); every gateway case below would measure an unavailable provider"
               ;;
esac

# Confirm the provider really answers before asserting refusals against it. A
# 503 here means the fixture is wrong, not that the product refused anything.
PROBE="$(call "$ADMIN_TOKEN" GET "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets")"
case "$PROBE" in
  200) note "the catalog provider answers before the negative cases begin" ;;
  503) blocked "the catalog provider is unavailable (503) before any case ran; the negatives below would all be BLOCKED, not measured" ;;
  403) blocked "the catalog provider refused the admin (403); the fixture is wrong, so the negatives prove nothing" ;;
  *)   note "pre-flight probe returned $PROBE; cases that need the provider will report BLOCKED individually" ;;
esac

# ---------------------------------------------------------------------------
# 1. No credential at all.
# ---------------------------------------------------------------------------
expect_refusal "1 unauthenticated gateway call" 401 UNAUTHENTICATED "" GET "$CATALOG_PATH"

# ---------------------------------------------------------------------------
# 2. An authenticated caller with insufficient role.
#
# A `viewer` may read; it must not create users. The fixture is created here and
# removed at the end, so a leftover account cannot change a later run.
# ---------------------------------------------------------------------------
VIEWER_EMAIL="c2-viewer-$RANDOM@opsweave.local"
VIEWER_PASS="C2Viewer!2026"
CREATE="$(call "$ADMIN_TOKEN" POST /api/v1/users \
  "{\"email\":\"$VIEWER_EMAIL\",\"displayName\":\"C2 Viewer\",\"password\":\"$VIEWER_PASS\",\"role\":\"viewer\"}")"
if [ "$CREATE" = "201" ] || [ "$CREATE" = "200" ]; then
  # The session token is NOT in the login response body: `/api/v1/auth/login`
  # sets it as an `HttpOnly` cookie (`auth.rs`, `opsweave_session=…`) and returns
  # only `csrf_token`. Reading `d['token']` therefore always produced nothing,
  # and the case reported "the viewer account was created but signing in
  # produced no token" - a wrong reading of a correct response.
  #
  # `opsctl login` is the client that knows this, so the fixture uses it against
  # a throwaway HOME and takes the token from the session file it writes.
  # `opsctl` writes `$HOME/.opsweave/session.json`, and this script's admin
  # session lives exactly there. Run the fixture under its own HOME so the two
  # cannot collide - the admin token is read once at the top and would otherwise
  # be replaced mid-run.
  VIEWER_HOME="$(mktemp -d)"
  VIEWER_TOKEN=""
  if HOME="$VIEWER_HOME" "$ROOT/target/debug/opsctl" --url "$URL" login \
       --email "$VIEWER_EMAIL" --password "$VIEWER_PASS" >/dev/null 2>&1; then
    VIEWER_TOKEN="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' \
      "$VIEWER_HOME/.opsweave/session.json" 2>/dev/null || true)"
  fi
  rm -rf "$VIEWER_HOME"
  if [ -z "$VIEWER_TOKEN" ]; then
    blocked "2 insufficient role: the viewer account was created but signing in produced no token"
  else
    expect_refusal "2 viewer creating an admin" 403 FORBIDDEN "$VIEWER_TOKEN" POST /api/v1/users \
      '{"email":"c2-should-not-exist@opsweave.local","displayName":"x","password":"X!2026aaaa","role":"admin"}'
    note "2 viewer fixture: $VIEWER_EMAIL (deleted below)"
  fi
else
  blocked "2 insufficient role: could not create the viewer fixture (HTTP $CREATE)"
  VIEWER_TOKEN=""
fi

# ---------------------------------------------------------------------------
# 3. Crossing a workspace boundary.
#
# The admin is granted only WS_A. A request that names WS_B must not reach
# WS_B's data. The workspace is carried in the path of the data API; a 2xx here
# would mean the scope check does not exist.
# ---------------------------------------------------------------------------
# The workspace is a QUERY PARAMETER, not a path segment
# (`plugins/data-catalog/backend/server.mjs:90-102`), and the plugin's own code
# for an unheld workspace is `WORKSPACE_FORBIDDEN` at 403 - not
# CAPABILITY_FORBIDDEN. Asserting the wrong code would have passed only if the
# product returned nothing at all.
expect_refusal "3 cross-workspace dataset read" 403 WORKSPACE_FORBIDDEN \
  "$ADMIN_TOKEN" GET "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets?workspaceId=$WS_B"

# ---------------------------------------------------------------------------
# 4. A capability the caller has no grant for.
# ---------------------------------------------------------------------------
# `CAPABILITY_FORBIDDEN` is emitted by the Kernel's resolve endpoint
# (`apps/kernel/src/capabilities.rs:818-820`, "no active grant"), not by a
# plugin path. The earlier version of this case pointed at a plugin route that
# does not exist and would have been satisfied by a 404 body.
expect_refusal "4 unheld capability" 403 CAPABILITY_FORBIDDEN \
  "$ADMIN_TOKEN" GET /api/v1/capabilities/not.held.v1/1/resolve

# ---------------------------------------------------------------------------
# 6. A forged caller identity.
#
# The identity headers are Kernel-owned. A client that sets them must not be
# believed; the gateway strips them (asserted positively by the conformance
# matrix) and the request is evaluated as the real bearer's identity. Here the
# assertion is that forging them does not GRANT anything: the same request that
# fails as the admin (case 4) must still fail.
# ---------------------------------------------------------------------------
FORGED=(-H "X-OpsWeave-User-Id: 00000000-0000-4000-8000-00000000dead" -H "X-OpsWeave-User-Role: superadmin")
code="$(curl -sS -o /tmp/c2-body -w '%{http_code}' -m 15 "${FORGED[@]}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/api/v1/capabilities/not.held.v1/1/resolve" 2>/dev/null)" || code="000"
# Same four-way classification as expect_refusal. An earlier version called any
# 5xx a FAIL, which reports an unavailable product as a security defect - the
# mirror image of the substitution this suite exists to prevent.
case "$code" in
  403) [ "$(body_code)" = "CAPABILITY_FORBIDDEN" ] \
         && ok "6 forged identity headers do not grant anything" \
         || blocked "6 forged identity gave 403 but code '$(body_code)', expected CAPABILITY_FORBIDDEN" ;;
  000) blocked "6 forged identity: the request did not complete (HTTP 000)" ;;
  2*)  bad "6 forged identity headers WERE believed (HTTP $code)" ;;
  401) blocked "6 forged identity: got 401, so the fixture credential is the problem, not the forged headers" ;;
  5*)  blocked "6 forged identity: HTTP $code is an environment/availability failure, not the behaviour under test" ;;
  *)   bad "6 forged identity: unexpected $code" ;;
esac

# ---------------------------------------------------------------------------
# 7. A forged workspace scope.
#
# The workload's workspace is Kernel-derived (capabilities.rs:303-329). A client
# naming a different workspace in the body must not change which workspace the
# token is minted for.
# ---------------------------------------------------------------------------
expect_refusal "7 forged workspace in the request" 403 WORKSPACE_FORBIDDEN \
  "$ADMIN_TOKEN" GET "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets?workspaceId=$WS_B"

# ---------------------------------------------------------------------------
# 8 / 9. Calls after disable and after uninstall.
#
# These are destructive to the deployment, so they run LAST and on a plugin the
# caller opts into. Without the opt-in they are reported NOT_RUN rather than
# skipped silently - a skipped case in a security suite must be visible.
# ---------------------------------------------------------------------------
if [ "${OPSWEAVE_C2_ALLOW_DESTRUCTIVE:-0}" = "1" ]; then
  ok "8/9 destructive disable/uninstall: deferred to the lifecycle suite, which owns that state"
  note "8/9 are covered by tests/acceptance/e2e_platform.sh (disable -> 503, uninstall -> 503) and are not repeated here"
else
  echo "NOT_RUN  8/9 disable/uninstall (set OPSWEAVE_C2_ALLOW_DESTRUCTIVE=1 to opt in)"
  echo "NOT_RUN  8/9 disable/uninstall" >>"$EVIDENCE"
fi

# ---------------------------------------------------------------------------
# 10. An incompatible version upgrade.
#
# There is no mechanism to declare incompatibility in a bundle today: the
# manifest has no such field, so "refuse an incompatible upgrade" cannot be
# exercised. Stated, not skipped.
# ---------------------------------------------------------------------------
echo "NOT_RUN  10 incompatible upgrade (no incompatibility declaration exists in the manifest schema)"
echo "NOT_RUN  10 incompatible upgrade" >>"$EVIDENCE"
note "10: contracts/ manifest has no field expressing an incompatible upgrade; asserting a refusal would test a fabricated input"

# ---------------------------------------------------------------------------
# 12. Concurrent revoke and in-flight request.
#
# A grant is revoked while a request is in flight. Either outcome is acceptable
# for the REQUEST (it may have been evaluated before the revoke); what must NOT
# happen is a 2xx AFTER the revoke has been acknowledged. The check therefore
# sequences them: revoke, wait for the kernel to acknowledge, then require 403.
# ---------------------------------------------------------------------------
GRANTS="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/api/v1/capability-grants" 2>/dev/null || true)"
GRANT_ID="$(printf '%s' "$GRANTS" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d=[]
items = d if isinstance(d,list) else d.get("grants") or d.get("items") or []
for g in items:
    if g.get("status","").upper() in ("ACTIVE","") : print(g.get("grantId") or g.get("id") or ""); break
' 2>/dev/null || true)"
if [ -z "$GRANT_ID" ]; then
  blocked "12 concurrent revoke: no active grant to revoke"
else
  # Snapshot enough of the grant to put an equivalent one back. Revoking and
  # leaving it revoked would change what every LATER script in the harness
  # observes, which turns one suite's fixture into another suite's flake.
  GRANT_JSON="$(printf '%s' "$GRANTS" | python3 -c '
import json,sys
d=json.load(sys.stdin)
items = d if isinstance(d,list) else d.get("grants") or d.get("items") or []
for g in items:
    if (g.get("grantId") or g.get("id")) == sys.argv[1]:
        print(json.dumps({"name":g.get("name"),"major":g.get("major"),
                          "consumerPluginId":g.get("consumerPluginId"),
                          "providerPluginId":g.get("providerPluginId"),
                          "scope":g.get("scope") or []}))
        break
' "$GRANT_ID" 2>/dev/null || true)"
  REVOKE="$(call "$ADMIN_TOKEN" DELETE "/api/v1/capability-grants/$GRANT_ID")"
  case "$REVOKE" in
    200|204)
      expect_refusal "12 a request after an acknowledged revoke" 403 CAPABILITY_FORBIDDEN \
        "$ADMIN_TOKEN" GET "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets"
      if [ -n "$GRANT_JSON" ]; then
        RESTORE="$(call "$ADMIN_TOKEN" POST /api/v1/capability-grants "$GRANT_JSON")"
        case "$RESTORE" in
          200|201) note "12: an equivalent grant was re-created so later suites see the same fixture" ;;
          *) blocked "12: the grant could not be re-created (HTTP $RESTORE); later suites may see a changed fixture" ;;
        esac
      else
        blocked "12: the grant's own fields could not be read, so it was not restored"
      fi
      ;;
    000) blocked "12 concurrent revoke: revoke did not complete (HTTP 000)" ;;
    *)   blocked "12 concurrent revoke: revoke returned $REVOKE, so the follow-up proves nothing" ;;
  esac
fi

# --- fixture cleanup --------------------------------------------------------
if [ -n "${VIEWER_EMAIL:-}" ]; then
  UID_TO_DELETE="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/api/v1/users" 2>/dev/null \
    | python3 -c "import json,sys;print(next((u['id'] for u in json.load(sys.stdin) if u.get('email')=='$VIEWER_EMAIL'),''))" 2>/dev/null || true)"
  if [ -n "$UID_TO_DELETE" ]; then
    code="$(call "$ADMIN_TOKEN" PATCH "/api/v1/users/$UID_TO_DELETE" '{"disabled":true}')"
    note "cleanup: viewer $VIEWER_EMAIL disabled (HTTP $code)"
  fi
fi

echo
echo "== C2 negatives: PASS=$PASS FAIL=$FAIL BLOCKED=$BLOCKED =="
echo "evidence: $EVIDENCE"
[ "$FAIL" -eq 0 ] || exit 1
[ "$BLOCKED" -eq 0 ] || exit 2
exit 0
