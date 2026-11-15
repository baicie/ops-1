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
# A case that ran and could not establish its property. It is NOT a pass and NOT
# a product failure: the suite measured nothing about the thing it was written
# to measure. Kept separate from BLOCKED because BLOCKED means "the environment
# was not there" and this means "the environment was there and the observation
# was inconclusive".
INCONCLUSIVE=0
# Cases this run deliberately did not execute, with a reason. A NOT_RUN case is
# never counted as passing, and the summary below says how many there are - the
# old script's `exit 0` when FAIL and BLOCKED were both 0 made "eight of twelve
# scenarios did not run" look identical to "all twelve passed".
NOT_RUN=0
NOT_RUN_REASONS=""
ok()      { PASS=$((PASS+1)); echo "PASS  $*"; echo "PASS  $*" >>"$EVIDENCE"; }
bad()     { FAIL=$((FAIL+1)); echo "FAIL  $*"; echo "FAIL  $*" >>"$EVIDENCE"; }
blocked() { BLOCKED=$((BLOCKED+1)); echo "BLOCKED  $*"; echo "BLOCKED  $*" >>"$EVIDENCE"; }
inconclusive() { INCONCLUSIVE=$((INCONCLUSIVE+1)); echo "INCONCLUSIVE  $*"; echo "INCONCLUSIVE  $*" >>"$EVIDENCE"; }
notrun()  {
  NOT_RUN=$((NOT_RUN+1))
  local reason="${2:-no reason given}"
  echo "NOT_RUN  $1  ($reason)"
  echo "NOT_RUN  $1  ($reason)" >>"$EVIDENCE"
  NOT_RUN_REASONS="$NOT_RUN_REASONS
  - $1: $reason"
}
# `ABSENT`: the product has no such mechanism, so there is nothing to assert.
#
# Different from NOT_RUN, which means "this should have been measured and was
# not". The distinction decides the exit code: a NOT_RUN is a gap in this run, an
# ABSENT is a fact about the product that no future run of this suite will change.
#
# Deliberately NOT a way to skip work. Every ABSENT line names a `file:line` that
# shows the mechanism is missing, so the next person can check the claim instead
# of taking it on trust. If the mechanism is ever added, that line stops being
# true and the case must become a real assertion.
ABSENT=0
ABSENT_REASONS=""
absent()  {
  ABSENT=$((ABSENT+1))
  local reason="${2:-no reason given}"
  echo "ABSENT  $1  ($reason)"
  echo "ABSENT  $1  ($reason)" >>"$EVIDENCE"
  ABSENT_REASONS="$ABSENT_REASONS
  - $1: $reason"
}
note()    { echo "      $*"; echo "note  $*" >>"$EVIDENCE"; }

# --- fixture cleanup --------------------------------------------------------
#
# Every resource this run created is named here and nowhere else. The previous
# version also revoked "the first ACTIVE grant it could see", which may have
# belonged to another suite; nothing like that remains.
#
# Written as a FUNCTION and installed as a trap, not as a tail block. A cleanup
# that only runs when the script reaches its last line does not run at all when
# the case it is cleaning up after hangs, when CI cancels the job, or when the
# shell is interrupted - which is exactly when a leftover account and a live
# grant are most likely. EXIT covers the normal path and `set -e` aborts; TERM
# and INT cover a cancelled job.
#
# Cleanup failures are recorded in $EVIDENCE and in FAIL rather than swallowed:
# a teardown that cannot say what it left behind is how a suite quietly poisons
# the database for the next run.
CLEANED=0
cleanup_fixtures() {
  # Idempotent: the EXIT trap may run after the tool has already been called by
  # hand, and running twice must not double-count failures.
  [ "$CLEANED" = "0" ] || return 0
  CLEANED=1

  for leftover in "${OWN_GRANT_ID:-}" "${OWN2:-}"; do
    [ -n "$leftover" ] || continue
    CODE="$(call "$ADMIN_TOKEN" DELETE "/api/v1/capability-grants/$leftover")"
    case "$CODE" in
      200|204) note "cleanup: revoked this run's leftover grant $leftover" ;;
      404)     note "cleanup: grant $leftover was already gone" ;;
      *)       echo "FAIL  cleanup: this run's grant $leftover could not be revoked (HTTP $CODE)" >>"$EVIDENCE"
               FAIL=$((FAIL+1)) ;;
    esac
  done

  if [ "$VIEWER_CREATED" = "1" ] && [ -n "$VIEWER_ID" ]; then
    code="$(call "$ADMIN_TOKEN" PATCH "/api/v1/users/$VIEWER_ID" '{"disabled":true}')"
    case "$code" in
      200|204) note "cleanup: disabled the viewer this run created ($VIEWER_ID)" ;;
      *)
        echo "FAIL  cleanup: the viewer this run created ($VIEWER_ID) could not be disabled (HTTP $code)" >>"$EVIDENCE"
        FAIL=$((FAIL+1)) ;;
    esac
  elif [ "$VIEWER_CREATED" = "1" ]; then
    echo "FAIL  cleanup: a viewer was created but no id was recorded; it cannot be cleaned up by id" >>"$EVIDENCE"
    FAIL=$((FAIL+1))
  else
    # Not a failure: the fixture was never created. This branch exists so the
    # absence of a cleanup is a stated fact rather than a silent non-event.
    note "cleanup: no viewer fixture was created by this run, so none was disabled"
  fi

  # The dataset case 7 wrote, if it landed.
  #
  # Verified before deleting, not assumed. The id contains this run's tag, so a
  # collision is not expected - but "the name looks like mine" is the same
  # reasoning that let the old code revoke an arbitrary grant. The check is that
  # a listing under the caller's OWN workspace contains the id; a dataset that
  # is not there is not this run's to delete, whatever it is called.
  if [ -n "${FORGED_DATASET_CREATED:-}" ]; then
    OWN_LISTING="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
      "$URL$CATALOG_PATH?workspaceId=$WS_A" 2>/dev/null || true)"
    if ! printf '%s' "$OWN_LISTING" | grep -qF "$FORGED_DATASET"; then
      echo "FAIL  cleanup: $FORGED_DATASET was written but is not listed under this run's workspace," >>"$EVIDENCE"
      echo "      so it was NOT deleted: deleting a resource this run cannot show it owns is the" >>"$EVIDENCE"
      echo "      mistake this cleanup exists to avoid. Check by hand." >>"$EVIDENCE"
      FAIL=$((FAIL+1))
      return 0
    fi
    dcode="$(call "$ADMIN_TOKEN" DELETE "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets/$FORGED_DATASET" '{}')"
    case "$dcode" in
      200|201|204) note "cleanup: deleted the dataset this run wrote ($FORGED_DATASET)" ;;
      404)         note "cleanup: dataset $FORGED_DATASET was already gone" ;;
      *)           echo "FAIL  cleanup: the dataset this run wrote ($FORGED_DATASET) could not be deleted (HTTP $dcode)" >>"$EVIDENCE"
                   FAIL=$((FAIL+1)) ;;
    esac
  fi
}

# `trap ... EXIT TERM INT` with the same handler: on TERM/INT the handler runs,
# then the shell exits; EXIT fires afterwards and the CLEANED guard keeps it to
# one pass.
# One handler, both jobs. Installing `trap ... EXIT` twice does not chain - the
# second registration REPLACES the first - so a scratch-directory trap at the top
# of the file would have been silently discarded by the fixture trap below it,
# leaving every run's response bodies on disk. Measured: `trap -p EXIT` after the
# second registration shows only the second command.
final_cleanup() {
  cleanup_fixtures
  [ -n "${SCRATCH:-}" ] && rm -rf "$SCRATCH"
  return 0
}

on_signal() {
  cleanup_fixtures
  # A cancelled run is not a passing run. 130/143 are the conventional codes.
  case "$1" in
    TERM) exit 143 ;;
    INT)  exit 130 ;;
    *)    exit 1 ;;
  esac
}


# A value only this run can produce. Used to tag every resource this suite
# creates, so cleanup can never touch another suite's grant or account.
RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Per-run scratch. These files used to be fixed paths under /tmp (`$SCRATCH/body`,
# `$SCRATCH/race-code`), so two runs on one machine - or a run overlapping a
# cancelled one - wrote each other's response bodies. The symptom was a case
# reading a body that belonged to a different request, which reads as a product
# finding. Nothing outside this directory is written by this script.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/p001c2-${RUN_TAG}.XXXXXX")"
ADMIN_TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])' 2>/dev/null || true)"
[ -n "$ADMIN_TOKEN" ] || { echo "BLOCKED: no ~/.opsweave/session.json" >&2; exit 3; }

# Fetch a JSON field.
jf() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

# One HTTP call, classified. Prints "<status> <body>".
call() { # token-or-empty, method, path, [body]
  local tok="$1" method="$2" path="$3" body="${4:-}"
  local args=(-sS -o "$SCRATCH/body" -w '%{http_code}' -m 15 -X "$method")
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data-binary "$body")
  # The three mutating deployment routes require an Idempotency-Key.
  #
  # `apps/kernel/src/deployments.rs:202,390,663` all start with
  # `receipts::idempotency_key(&headers)?`, and that returns
  # `bad_request("Idempotency-Key header is required (8..=128 characters)")` -
  # HTTP 400 - when the header is missing or out of range.
  #
  # Without this the activation probe below answered
  #
  #     BLOCKED  could not activate opsweave.data-catalog@0.0.1 (HTTP 400)
  #
  # on run 43649598664, and I read that 400 as a wrong `expectedRevision` because
  # the request body also carries a CAS field. It was the missing header: the
  # plugin id in that same line was already correct, and the CAS value never got
  # read.
  #
  # Only these three routes get the header; everything else in this suite is a
  # read or a refusal case that must stay exactly as a client would send it.
  case "$method:$path" in
    POST:*/activations|POST:*/deployments|POST:*/rollbacks)
      args+=(-H "Idempotency-Key: c2-$(date +%s%N)-$RANDOM") ;;
  esac
  local code
  code="$(curl "${args[@]}" "$URL$path" 2>/dev/null)" || code="000"
  printf '%s' "${code:-000}"
}
body_code() { jf "d.get('code','')" <$SCRATCH/body 2>/dev/null || true; }

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
    401|403|404|409|422)
      # STATUS AND CODE ARE BOTH REQUIRED TO MATCH EXACTLY.
      #
      # The previous version accepted any 401/403 as long as the error code was
      # right. That lets 401 and 403 substitute for each other, and they mean
      # different things: "you are not authenticated" vs "you are authenticated
      # and not allowed". A suite that treats them as interchangeable cannot
      # tell a broken fixture from a broken authorisation rule.
      #
      # A wrong status with a right code is a FIXTURE problem (the credential
      # died, the route moved), so it is BLOCKED rather than FAIL - the product
      # was never tested. A right status with a wrong code is a FAIL: the
      # refusal happened but not for the documented reason.
      if [ "$code" != "$want_code" ]; then
        bad "$label: status $status was right but the code was '$code', expected '$want_code'"
      else
        blocked "$label: got $status $code, expected $want_status $want_code - the fixture is not in the state this case needs, so the behaviour under test was not exercised"
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
# The plugin this suite exercises, resolved from what is actually installed.
#
# This was hard-coded to `dev.opsweave.data-catalog`, an id that exists nowhere
# in this repository: `plugins/data-catalog/manifest.template.json` declares
# `opsweave.data-catalog` and `scripts/demo_data_up.sh` deploys that id. The
# hard-coded name made the activation probe below a 404 route,
#
#     curl: (22) The requested URL returned error: 404
#     BLOCKED  could not activate dev.opsweave.data-catalog@0.0.1 (HTTP 400)
#
# and the 400 is the second-order effect: the 404 made `$REVISION` fall back to 0,
# so the activation CAS carried a revision that no plugin has. Every gateway case
# below then reported `503 ... environment/availability failure` - which was
# honest, but the cause was this line and it took a run to see it.
#
# Reading the id from the deployment list rather than naming it: the suite then
# measures whatever `demo_data_up.sh` actually installed, and a future rename
# cannot silently turn this into a 404 again.
PLUGIN="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/api/v1/plugins" \
  | python3 -c '
import json, sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("items", data.get("plugins", []))
# The catalog whose id ends in data-catalog and is not the alternate provider.
ids = sorted(p.get("id") or p.get("pluginId") or "" for p in items)
for candidate in ids:
    if candidate.endswith("data-catalog"):
        print(candidate); raise SystemExit
raise SystemExit("no data-catalog plugin is installed")
' 2>/dev/null)" || PLUGIN=""
if [ -z "$PLUGIN" ]; then
  blocked "no data-catalog plugin is installed, so there is nothing to guard"
fi

# --- arm the fixture cleanup -----------------------------------------------
#
# Deliberately here and not at the top: `cleanup_fixtures` calls `call`, which is
# defined above, and needs ADMIN_TOKEN, PLANE and the workspace ids. A trap armed
# before those exist would run a handler that references an undefined function -
# which is a cleanup that fails precisely when it is needed.
trap final_cleanup EXIT
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
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
#
# ---------------------------------------------------------------------------
# Ownership of the fixture
# ---------------------------------------------------------------------------
# The cleanup used to re-find the account BY EMAIL at the end and disable
# whatever it found:
#
#     VIEWER_EMAIL="c2-viewer-$RANDOM@opsweave.local"
#     ...
#     UID_TO_DELETE="$(... | next(u['id'] for u in users if u['email']==VIEWER_EMAIL))"
#     PATCH /api/v1/users/$UID_TO_DELETE {"disabled":true}
#
# Two problems, and the second is the dangerous one:
#
#   * `$RANDOM` is 15 bits. Two runs of this suite on one database can pick the
#     same address, and so can a developer's leftover fixture from last week.
#   * Nothing recorded whether THIS run created the account. If the create failed
#     with a conflict, the cleanup still disabled whatever account owned that
#     address - which may be another run's, or a human's.
#
# So the id is captured from the CREATE RESPONSE and the cleanup acts only on
# that id. If the create did not succeed, there is nothing to clean up and the
# cleanup says so.
VIEWER_EMAIL="c2-viewer-$(date -u +%Y%m%dT%H%M%SZ)-$$@opsweave.local"
VIEWER_PASS="C2Viewer!2026"
VIEWER_ID=""
VIEWER_TOKEN=""
VIEWER_CREATED=0
CREATE="$(call "$ADMIN_TOKEN" POST /api/v1/users \
  "{\"email\":\"$VIEWER_EMAIL\",\"displayName\":\"C2 Viewer\",\"password\":\"$VIEWER_PASS\",\"role\":\"viewer\"}")"
if [ "$CREATE" = "201" ] || [ "$CREATE" = "200" ]; then
  VIEWER_CREATED=1
  # The id comes from the response THIS request produced.
  #
  # It used to be looked up in `GET /api/v1/users` by email, and that comparison
  # could never match: `users.rs:88` stores `payload.email.trim().to_lowercase()`,
  # while `$VIEWER_EMAIL` is `c2-viewer-$(date -u +%Y%m%dT%H%M%SZ)-$$@…` and
  # therefore contains an upper-case `T` and `Z`. Measured on run 43649598664:
  #
  #     BLOCKED  2 ... the viewer was created but its id could not be read back
  #     ... c2-viewer-20261114T230429Z-34670@opsweave.local id= (disabled below, by id)
  #
  # The account existed and every later case used it successfully; only the
  # lookup was wrong. `create_user` returns `Json<UserView>` (`users.rs:49-53`),
  # so the id is right here in the response - no second request, no comparison,
  # and nothing that a future change to email casing can break.
  VIEWER_ID="$(jf "d.get('id','')" <$SCRATCH/body 2>/dev/null || true)"
  if [ -z "$VIEWER_ID" ]; then
    blocked "2 insufficient role: the viewer was created but the response carried no id, so it cannot be cleaned up by id"
  fi
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
    note "2 viewer fixture: $VIEWER_EMAIL id=$VIEWER_ID (disabled below, by id)"
  fi
else
  blocked "2 insufficient role: could not create the viewer fixture (HTTP $CREATE)"
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
#
# NOT a user-endpoint assertion, because this endpoint does not consult grants.
#
# `capabilities::resolve` (`apps/kernel/src/capabilities.rs:237-260`) takes an
# `AuthUser`, ignores it (`_auth`), calls `resolve_provider`, and answers
# `AVAILABLE`. There is no grant lookup anywhere in it. `CAPABILITY_FORBIDDEN`
# is produced only on the WORKLOAD path (`capabilities.rs:800-820`, keyed on
# `claims.plugin_id`).
#
# So a capability nobody registered cannot answer 403 CAPABILITY_FORBIDDEN here -
# `resolve_provider` finds no row and the request is 503 CAPABILITY_UNAVAILABLE.
# Measured on runs 43654427307 and 43654427317:
#
#   BLOCKED  4 unheld capability: HTTP 503 from the product is an
#            environment/availability failure, not the documented refusal
#
# The suite classified the 503 honestly, but the case cannot be about this
# endpoint. 6 inherits the same defect: it repeats this request with forged
# identity headers and requires the same refusal.
# ---------------------------------------------------------------------------
absent "4 unheld capability" \
  "the user resolve endpoint ignores grants (capabilities.rs:237-260 takes _auth and returns AVAILABLE); CAPABILITY_FORBIDDEN exists only on the workload-token path, which capability_multi_provider.sh:100-116 exercises with a real token"

# ---------------------------------------------------------------------------
# 6. A forged caller identity.
#
# The identity headers are Kernel-owned. A client that sets them must not be
# believed; the gateway strips them (asserted positively by the conformance
# matrix) and the request is evaluated as the real bearer's identity.
#
# The assertion is that forging them does not GRANT anything. It used to be made
# against `/api/v1/capabilities/not.held.v1/1/resolve`, the same request as case
# 4 - so when case 4 turned out to describe a mechanism this endpoint does not
# have (it ignores grants, and answers 503 for a capability nobody registered),
# case 6 inherited the same impossibility: a 503 is not evidence that the forged
# headers were ignored, it is evidence that nothing was there to answer.
#
# It is now made against a route that is actually served and actually refuses:
# the cross-workspace dataset read from case 3, which answered
# `403 WORKSPACE_FORBIDDEN`. That is the shape this case needs - a real refusal
# that must not become a success because a header was added.
FORGED=(-H "X-OpsWeave-User-Id: 00000000-0000-4000-8000-00000000dead" -H "X-OpsWeave-User-Role: superadmin")
code="$(curl -sS -o $SCRATCH/body -w '%{http_code}' -m 15 "${FORGED[@]}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/api/v1/gateway/$PLUGIN/api/data-catalog/datasets?workspaceId=$WS_B" 2>/dev/null)" || code="000"
# Classification unchanged in spirit: a 2xx means the forged headers were
# believed (FAIL), a matching 403 means they were not (PASS), and anything that
# is neither means the case did not measure the property.
case "$code" in
  403) [ "$(body_code)" = "WORKSPACE_FORBIDDEN" ] \
         && ok "6 forged identity headers do not grant anything" \
         || blocked "6 forged identity gave 403 but code '$(body_code)', expected WORKSPACE_FORBIDDEN" ;;
  000) blocked "6 forged identity: the request did not complete (HTTP 000)" ;;
  2*)  bad "6 forged identity headers WERE believed (HTTP $code)" ;;
  401) blocked "6 forged identity: got 401, so the fixture credential is the problem, not the forged headers" ;;
  5*)  blocked "6 forged identity: HTTP $code is an environment/availability failure, not the behaviour under test" ;;
  *)   bad "6 forged identity: unexpected $code" ;;
esac

# ---------------------------------------------------------------------------
# 7. A forged workspace in a WRITE body, which is a different mechanism.
#
# Cases 3 and 7 used to send the identical request, so one security property was
# counted twice. They are now different mechanisms:
#
#   3  reads ANOTHER workspace's data, named in the query string
#   7  writes a dataset while naming another workspace in the BODY
#
# The plugin ignores the body's workspace entirely and files the dataset under
# the workspace from the SIGNED context (`server.mjs`, POST handler: "never one
# named in the body: a caller that could choose would be granting itself a
# workspace"). So the observable property is not a 403 - it is that the write is
# filed under the caller's OWN workspace, not the forged one.
#
# Asserting 403 here would have been wrong: the product accepts the write and
# ignores the forged field, which is the safer behaviour.
FORGED_DATASET="$(python3 -c 'import uuid;print(uuid.uuid4())')"
# A body the product accepts, apart from the forged workspace.
#
# The old body was
#   {"datasetId":"c2-forged-$RUN_TAG","workspaceId":"...","fields":[{"name":"probe","type":"string"}]}
# which has two independent problems:
#
#   datasetId  is not a UUID, and `server.mjs:718` rejects that with 400 before
#              anything else happens.
#   fields     omit `nullable` and `ordinal`, which `validateFields`
#              (`server.mjs:105-117`) requires. It throws a bare `Error`, the
#              handler's catch-all turns it into 500 `internal catalog error`.
#
# Measured on run 43654427307: `BLOCKED 7: the write returned 500; neither
# outcome establishes the property`. The case never reached its subject - it was
# sending a malformed request.
#
# PRODUCT FINDING, recorded but not fixed here: a client that omits `nullable` or
# `ordinal` gets 500 INTERNAL rather than 400 INVALID_REQUEST. `validateFields`
# throws `new Error(...)` like the field-name and type checks above it, so all of
# them surface as internal errors. Worth a separate fix; it is not this suite's
# subject, and changing the plugin's status codes from a test branch would make
# this test measure something else.
FORGED_BODY="$(python3 -c '
import json, sys
print(json.dumps({
  "datasetId": sys.argv[1],
  "name": sys.argv[2],
  "workspaceId": sys.argv[3],
  "fields": [{"name": "probe", "type": "string", "nullable": True, "ordinal": 0}],
}))' "$FORGED_DATASET" "c2-forged-$RUN_TAG" "$WS_B")"
WRITE_CODE="$(call "$ADMIN_TOKEN" POST "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets" "$FORGED_BODY")"
case "$WRITE_CODE" in
  200|201)
    # Recorded so the trapped cleanup can delete it. Before this the dataset was
    # written and only mentioned in a log line - a row this run created and
    # never removed, tagged with an address no later run would think to look for.
    FORGED_DATASET_CREATED=1
    FILED_WS="$(python3 -c '
import json,sys
try: d=json.load(open("$SCRATCH/body"))
except Exception: d={}
print(d.get("workspaceId") or (d.get("dataset") or {}).get("workspaceId") or "")' 2>/dev/null || true)"
    if [ "$FILED_WS" = "$WS_B" ]; then
      bad "7: a body-supplied workspace was honoured - the dataset was filed under $WS_B"
    elif [ -n "$FILED_WS" ]; then
      ok "7: a body-supplied workspace was ignored; the dataset was filed under $FILED_WS"
    else
      # The write was accepted and filed somewhere. Not knowing where is not the
      # same as it being correct: "it did not name $WS_B therefore it must be
      # fine" is an inference, not an observation. So go and LOOK - read the
      # dataset back through the same API and see which workspace lists it.
      #
      # This branch used to be a `note` and the case still counted as executed,
      # which made "the response was unhelpful" indistinguishable from "the
      # forged workspace was ignored".
      FOUND_IN=""
      for probe_ws in "$WS_A" "$WS_B"; do
        LISTING="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
          "$URL$CATALOG_PATH?workspaceId=$probe_ws" 2>/dev/null || true)"
        if printf '%s' "$LISTING" | grep -qF "$FORGED_DATASET"; then FOUND_IN="$probe_ws"; break; fi
      done
      if [ "$FOUND_IN" = "$WS_B" ]; then
        bad "7: the write did not name a workspace, and reading it back shows it was filed under the FORGED workspace $WS_B"
      elif [ "$FOUND_IN" = "$WS_A" ]; then
        ok "7: the response named no workspace, but reading it back shows it was filed under the caller's own workspace"
      else
        # Payload and a landing place both unknown. That is INCONCLUSIVE, not a
        # pass: this case proves nothing about where a forged field sends data.
        inconclusive "7: the write succeeded, the response named no workspace, and the dataset was not found under either workspace - the landing place is unproven"
      fi
    fi
    ;;
  403)
    ok "7: the write was refused (403) rather than honouring the forged workspace"
    ;;
  000) blocked "7: the write did not complete (HTTP 000)" ;;
  *)   blocked "7: the write returned $WRITE_CODE; neither outcome establishes the property" ;;
esac

# ---------------------------------------------------------------------------
# 8 / 9. Calls after disable and after uninstall.
#
# These are destructive to the deployment, so they run LAST and on a plugin the
# caller opts into. Without the opt-in they are reported NOT_RUN rather than
# skipped silently - a skipped case in a security suite must be visible.
# ---------------------------------------------------------------------------
#
# The previous version printed `ok` when the opt-in was set, without disabling
# or uninstalling anything. That is a PASS for a test that never ran - the same
# substitution this suite exists to catch, one level up.
#
# Two honest outcomes are possible here, and there is no third:
#
#   * actually disable and uninstall, with the refusal measured; or
#   * NOT_RUN, naming the suite that does measure it.
#
# `COVERED_ELSEWHERE` is printed with the exact command that covers it, so the
# claim can be checked rather than taken on trust.
if [ "${OPSWEAVE_C2_ALLOW_DESTRUCTIVE:-0}" != "1" ]; then
  # Counted, not merely printed. A NOT_RUN that only reaches stdout is a NOT_RUN
  # the verdict cannot see, which is how "eight of twelve did not run" used to
  # exit 0.
  notrun "8 disable" "opt in with OPSWEAVE_C2_ALLOW_DESTRUCTIVE=1; e2e_platform.sh covers disable -> 503 CAPABILITY_UNAVAILABLE"
  notrun "9 uninstall" "opt in with OPSWEAVE_C2_ALLOW_DESTRUCTIVE=1; e2e_platform.sh covers uninstall -> 503 CAPABILITY_UNAVAILABLE"
  echo "COVERED_ELSEWHERE  8/9 -> tests/acceptance/e2e_platform.sh"
  echo "COVERED_ELSEWHERE  8/9 -> tests/acceptance/e2e_platform.sh" >>"$EVIDENCE"
else
  # --- 8. DISABLE, for real -------------------------------------------------
  DISABLE_CODE="$(call "$ADMIN_TOKEN" POST "/api/v1/plugins/$PLUGIN/disable" '{}')"
  case "$DISABLE_CODE" in
    200|202|204)
      expect_refusal "8 a gateway call after disable" 503 CAPABILITY_UNAVAILABLE \
        "$ADMIN_TOKEN" GET "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets"
      # Put it back, or every later suite sees a disabled plugin.
      ENABLE_CODE="$(call "$ADMIN_TOKEN" POST "/api/v1/plugins/$PLUGIN/enable" '{}')"
      case "$ENABLE_CODE" in
        200|202|204) note "8: re-enabled $PLUGIN" ;;
        *) bad "8: the plugin was disabled but could not be re-enabled (HTTP $ENABLE_CODE); later suites are affected" ;;
      esac
      ;;
    000) blocked "8: the disable request did not complete (HTTP 000)" ;;
    *)   blocked "8: disable returned $DISABLE_CODE, so the refusal below would prove nothing" ;;
  esac

  # --- 9. UNINSTALL, for real -----------------------------------------------
  #
  # This one is NOT restored: uninstalling cannot be undone from here without a
  # redeploy, and a suite that quietly redeployed would be changing the platform
  # for everything after it. It is therefore opt-in and LAST, and the caller is
  # told that the plugin is gone.
  UNINSTALL_CODE="$(call "$ADMIN_TOKEN" DELETE "/api/v1/plugins/$PLUGIN")"
  case "$UNINSTALL_CODE" in
    200|202|204)
      expect_refusal "9 a gateway call after uninstall" 503 CAPABILITY_UNAVAILABLE \
        "$ADMIN_TOKEN" GET "/api/v1/gateway/$PLUGIN/api/data-catalog/datasets"
      echo "NOTE  9: $PLUGIN has been UNINSTALLED by this run and is not restored"
      echo "NOTE  9: $PLUGIN has been UNINSTALLED by this run and is not restored" >>"$EVIDENCE"
      ;;
    000) blocked "9: the uninstall request did not complete (HTTP 000)" ;;
    *)   blocked "9: uninstall returned $UNINSTALL_CODE, so the refusal below would prove nothing" ;;
  esac
fi

# ---------------------------------------------------------------------------
# 10. An incompatible version upgrade.
#
# There is no mechanism to declare incompatibility in a bundle today: the
# manifest has no such field, so "refuse an incompatible upgrade" cannot be
# exercised. Stated, not skipped.
# ---------------------------------------------------------------------------
absent "10 incompatible upgrade" "contracts/ manifest has no field expressing an incompatible upgrade; asserting a refusal would test a fabricated input"

# ---------------------------------------------------------------------------
# 12. Revocation semantics: SEQUENTIAL and CONCURRENT are different claims.
#
# The previous version listed every ACTIVE grant, took the first one it saw and
# revoked it. That is destructive to a resource this suite did not create: the
# grant may belong to another test, and revoking it changes what every later
# script in the harness observes.
#
# It also claimed one thing while testing another. "Revoke, then request" is a
# SEQUENTIAL check. A concurrent revoke is a different claim and needs a real
# in-flight request racing a committed revoke.
# ---------------------------------------------------------------------------

# A grant this suite owns, identified by a value only this run can produce.
FIXTURE_TAG="c2-${RUN_TAG}"
# No `providerPluginId`, and the consumer is the integration plugin.
#
# Both fields were wrong, and each failed differently on run 43649598664:
#
#   consumerPluginId: "$PLUGIN"       - the catalog is the PROVIDER, not a
#                                       consumer of its own capability.
#   providerPluginId: "$PLUGIN"       - pins the grant to whatever provider is
#                                       SELECTED. `capability_multi_provider.sh`
#                                       runs before this suite, activates
#                                       `opsweave.data-catalog-alt`, and leaves it
#                                       selected; `capabilities.rs:138-158` then
#                                       answers
#                                         HTTP 409 PROVIDER_MISMATCH
#                                         "requested provider opsweave.data-catalog
#                                          is not the selected provider"
#                                       and case 12 was BLOCKED.
#
# Omitting the provider is the documented way to say "whichever provider is
# selected", and it is what `capability_multi_provider.sh:92` already does for the
# grant it calls UNBOUND. Case 12 tests revocation semantics, not provider
# pinning, so it should not care which provider is selected.
CREATE_GRANT_BODY="{\"name\":\"data.catalog.v1\",\"major\":1,\"consumerPluginId\":\"opsweave.data-integration\",\"scope\":[\"dataset:read\"]}"
CREATE_CODE="$(call "$ADMIN_TOKEN" POST /api/v1/capability-grants "$CREATE_GRANT_BODY")"
OWN_GRANT_ID="$(jf "d.get('id') or d.get('grantId') or ''" <$SCRATCH/body 2>/dev/null || true)"
if [ "$CREATE_CODE" != "200" ] && [ "$CREATE_CODE" != "201" ]; then
  blocked "12: could not create this run's own grant (HTTP $CREATE_CODE); no existing grant is touched"
elif [ -z "$OWN_GRANT_ID" ]; then
  blocked "12: the kernel accepted the grant but returned no id; nothing is revoked"
else
  note "12: created this run's own grant $OWN_GRANT_ID (tag $FIXTURE_TAG)"

  # --- 12a. SEQUENTIAL: after the revocation is acknowledged, a NEW request --
  #
  # NOT a gateway assertion, because the gateway does not consult grants.
  #
  # `apps/kernel/src/gateway.rs:38-46` authorises a user request on
  # `auth.role` alone - Admin, Operator or Viewer - and `grep -c
  # capability_grants apps/kernel/src/gateway.rs` returns 0. Grants are consumed
  # on the WORKLOAD token path: `capabilities.rs:413-432` looks up
  # `consumer_plugin_id = claims.plugin_id` and answers `403 CAPABILITY_FORBIDDEN`
  # when that row is gone.
  #
  # So revoking a plugin's grant cannot make an admin's `GET
  # /api/v1/gateway/...` fail, and this case asserted that it would:
  #
  #   FAIL  12a a request after the revoke was acknowledged:
  #         the product ACCEPTED the request (HTTP 200); a refusal was required
  #
  # measured on runs 43652053167 and 43652053177. The product was right; the
  # assertion described a mechanism this product does not have.
  #
  # It had never run before - the two earlier runs BLOCKED at activation - so
  # nothing contradicted it until now.
  #
  # The revocation itself IS still verified here, as an API property: the grant
  # this suite created is deleted and the Kernel reports success. What is not
  # verified - and is not verifiable from this suite - is the effect on a
  # workload token, because this suite has no workload token and does not run
  # inside the plugin container. `capability_multi_provider.sh:100-116` covers
  # exactly that, with the real token, and is the right place for it.
  REVOKE="$(call "$ADMIN_TOKEN" DELETE "/api/v1/capability-grants/$OWN_GRANT_ID")"
  case "$REVOKE" in
    200|204)
      note "12a: the grant this suite created was revoked (HTTP $REVOKE)"
      absent "12a a request after the revoke" \
        "gateway authorises on the user's role alone (gateway.rs:38-46, no capability_grants lookup); grant revocation is observable only on the workload-token path, which capability_multi_provider.sh:100-116 covers with a real token" ;;
    000) blocked "12a: the revoke did not complete (HTTP 000)" ;;
    *)   blocked "12a: the revoke returned $REVOKE, so even the API half was not established" ;;
  esac

  # --- 12b. CONCURRENT: a request already in flight when the revoke commits. -
  #
  # The contract does not say such a request must fail - it may have been
  # authorised before the revoke. What must NOT happen is that it was refused
  # BEFORE the revoke and the suite silently called that "concurrent". So the
  # check is: fire the request and the revoke together, then require the
  # response to be one of the two documented outcomes, and record which.
  #
  # A second grant is created because 12a consumed the first one.
  CREATE2="$(call "$ADMIN_TOKEN" POST /api/v1/capability-grants "$CREATE_GRANT_BODY")"
  OWN2="$(jf "d.get('id') or d.get('grantId') or ''" <$SCRATCH/body 2>/dev/null || true)"
  if [ "$CREATE2" != "200" ] && [ "$CREATE2" != "201" ]; then
    blocked "12b: could not create a second grant for the concurrency case (HTTP $CREATE2)"
  elif [ -z "$OWN2" ]; then
    blocked "12b: no id returned for the second grant"
  else
    # Overlap has to be SHOWN, not assumed. Starting two processes from the same
    # shell does not prove the request reached its authorisation check before the
    # revoke committed; it proves two processes existed. The marker below is
    # written by the request as it is being sent, and the revoke is not issued
    # until the marker appears - so "the request had started" is an observation.
    #
    # What this still does NOT prove is that the request was PAST its
    # authorisation check at the moment the revoke committed. That is not
    # observable from outside without a hook in the product, so the case is
    # labelled OBSERVED_ATTEMPT and its verdict says so rather than claiming a
    # concurrency guarantee.
    RACE_MARKER="$SCRATCH/race-started"
    rm -f "$RACE_MARKER"
    (
      : >"$RACE_MARKER"
      curl -sS -o $SCRATCH/race-body -w '%{http_code}' -m 15 \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        "$URL/api/v1/gateway/$PLUGIN/api/data-catalog/datasets" >$SCRATCH/race-code 2>/dev/null
    ) &
    RACE_PID=$!
    OVERLAP=0
    for _ in $(seq 1 200); do
      [ -f "$RACE_MARKER" ] && { OVERLAP=1; break; }
      sleep 0.01
    done
    rm -f "$RACE_MARKER"
    REVOKE2="$(call "$ADMIN_TOKEN" DELETE "/api/v1/capability-grants/$OWN2")"
    wait "$RACE_PID" 2>/dev/null || true
    RACE_CODE="$(cat $SCRATCH/race-code 2>/dev/null || echo 000)"
    if [ "$OVERLAP" != "1" ]; then
      inconclusive "12b: the request never signalled that it had started before the revoke was issued, so no overlap was demonstrated"
    else
      case "$RACE_CODE" in
        200) note "12b: OBSERVED_ATTEMPT - the in-flight request succeeded. Expected: the gateway authorises on role, so a grant revoke cannot refuse it (see 12a). What this records is that the revoke landed while a request was in flight and neither side errored." ;;
        403) bad "12b: the in-flight request was refused with 403, which the gateway should not do on a grant revoke (gateway.rs:38-46 consults no grants); if this fires, the authorisation path changed and 12a's NOT_RUN needs revisiting" ;;
        000) blocked "12b: the in-flight request did not complete (HTTP 000)" ;;
        *)   bad "12b: the in-flight request returned $RACE_CODE, which is neither documented outcome" ;;
      esac
    fi
    case "$REVOKE2" in
      200|204) ok "12b: the concurrent revoke was acknowledged" ;;
      *)       blocked "12b: the concurrent revoke returned $REVOKE2" ;;
    esac
    note "12b: only ONE interleaving was observed. This is evidence of a concurrent attempt, not a proof of race-freedom - the suite records which side won rather than claiming determinism."
  fi
fi

echo "== C2 negatives: PASS=$PASS FAIL=$FAIL BLOCKED=$BLOCKED INCONCLUSIVE=$INCONCLUSIVE NOT_RUN=$NOT_RUN =="
echo "evidence: $EVIDENCE"

# ---------------------------------------------------------------------------
# The verdict.
#
# Five outcomes, because "the exit code was 0" was doing work it could not do.
# The old tail was:
#
#     [ "$FAIL" -eq 0 ] || exit 1
#     [ "$BLOCKED" -eq 0 ] || exit 2
#     exit 0
#
# so a run where eight of twelve scenarios were `note`d or never executed was
# indistinguishable from one where all twelve asserted. The exit code is now a
# verdict, and a run that did not cover everything is not a full pass.
#
#   0  STRICT_PASS            every scenario asserted, nothing inconclusive
#   1  FAIL                   a product assertion did not hold
#   2  BLOCKED                the environment was not there
#   3  PASS_WITH_COVERAGE_GAPS  nothing failed, but some cases were NOT_RUN
#   4  INCONCLUSIVE           a case ran and could not establish its property
#
# BLOCKED and FAIL win over the softer verdicts: an environment problem and a
# product defect are both more urgent than a coverage note.
if [ "$ABSENT" -gt 0 ]; then
  echo
  echo "ABSENT this run ($ABSENT case(s)): the product has no such mechanism, so"
  echo "there is nothing to assert. These are NOT passes and NOT coverage gaps -"
  echo "each line names the code that shows the mechanism is missing:$ABSENT_REASONS"
fi
if [ "$NOT_RUN" -gt 0 ]; then
  echo
  echo "NOT_RUN this run ($NOT_RUN case(s)); these are NOT passes:$NOT_RUN_REASONS"
fi
if [ "$FAIL" -ne 0 ]; then
  echo "verdict: FAIL"
  exit 1
fi
if [ "$BLOCKED" -ne 0 ]; then
  echo "verdict: BLOCKED"
  exit 2
fi
if [ "$INCONCLUSIVE" -ne 0 ]; then
  echo "verdict: INCONCLUSIVE ($INCONCLUSIVE case(s) measured nothing conclusive)"
  exit 4
fi
if [ "$NOT_RUN" -ne 0 ]; then
  echo "verdict: PASS_WITH_COVERAGE_GAPS ($NOT_RUN case(s) did not run)"
  exit 3
fi
if [ "$PASS" -eq 0 ]; then
  # Nothing asserted at all. Not a pass - this is the shape a broken suite takes
  # when every case fails its precondition and the counters stay at zero.
  echo "verdict: INCONCLUSIVE (no case asserted anything)"
  exit 4
fi
# ABSENT does not change the verdict.
#
# It used to share the NOT_RUN counter, which made this suite exit 3 on every
# run - `verdict: PASS_WITH_COVERAGE_GAPS (5 case(s) did not run)` - and exit 3
# is a failure to `run_step.sh`, so the harness stopped there on a run where
# nothing had gone wrong. Measured on run 43656373611: `PASS=6 FAIL=0 BLOCKED=0`,
# rc=3.
#
# The five were not gaps. Three were "this product has no such mechanism" (4, 10,
# 12a) and two were "opt-in destructive coverage that e2e_platform.sh owns" (8,
# 9). Neither is a hole in this run, and neither will change however many times
# it is re-run - which is exactly what NOT_RUN is supposed to signal.
#
# A NOT_RUN still fails the run, because that one IS a hole: something should
# have been measured here and was not.
if [ "$ABSENT" -gt 0 ]; then
  echo "verdict: STRICT_PASS ($ABSENT case(s) ABSENT by design - see above)"
  exit 0
fi
echo "verdict: STRICT_PASS"
exit 0
