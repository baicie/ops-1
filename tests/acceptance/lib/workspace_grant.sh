#!/usr/bin/env bash
# Business-workspace membership for the incident acceptance scripts. SOURCED, never executed.
#
# Why this file exists. Since D5 (migration 0022, docs/design/g12-scope/d5-business-workspace-adr.md
# section 3.4) a business row is readable for exactly one reason: the caller is a MEMBER of the
# workspace the row lives in. A role no longer implies a workspace. Two consequences reach every
# script that creates its fixtures over the public API:
#
#   1. an account created through POST /api/v1/users is a member of NOTHING until an administrator
#      grants it, so its first POST /api/v1/incidents answers
#      403 INCIDENT_WORKSPACE_FORBIDDEN;
#   2. on a FRESH database the bootstrap administrator is in the same position, because the kernel
#      runs migrations before it creates that account (db.rs init: migrate -> seed_admin) and the
#      migration's one-time grant only covers accounts that already existed.
#
# Both are the literal result of the ruling, not a defect, so the fixtures perform the missing
# audited action the way an installer would: two public HTTP requests, one to read the session's
# own user id and one to add it to the legacy workspace migration 0022 created for rows filed
# without an explicit workspaceId.
#
# Deliberately NOT done here, and each alternative was rejected for a reason:
#   * no Playwright/global-setup and no shared pre-test hook - the grant would then run against
#     whatever OPSWEAVE_URL points at, and on a shared host that includes staging;
#   * no grant inside the kernel's db::init - ADR section 3.4 states the administrator being a
#     member of nothing as product semantics, and changing it would silently widen who reads what;
#   * no predicate widened and nothing inserted into the database - the kernel decides the outcome
#     of every call below, and a refusal is reported by name instead of as a mystery 403 later.

OPSWEAVE_LEGACY_WORKSPACE_ID="${OPSWEAVE_LEGACY_WORKSPACE_ID:-00000000-0000-4000-8000-000000000001}"
_ow_grant_body="${_ow_grant_body:-$(mktemp "${TMPDIR:-/tmp}/opsweave-grant.XXXXXX")}"

# ow_user_id <cookie-jar> -> the user id the session belongs to, or nothing.
ow_user_id() {
  curl -sS -m 20 -b "$1" "$URL/api/v1/auth/me" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("user", {}).get("id", ""))
except Exception:
    print("")' 2>/dev/null
}

# ow_grant_legacy <admin-jar> <admin-csrf> <user-id>
# 201 the first time, 200 on a replay; both mean "this account may read this workspace".
ow_grant_legacy() {
  local jar="$1" csrf="$2" uid="$3" status
  if [ -z "$uid" ]; then
    printf 'no user id to grant into %s\n' "$OPSWEAVE_LEGACY_WORKSPACE_ID" >&2
    return 1
  fi
  status="$(curl -sS -m 20 -o "$_ow_grant_body" -w '%{http_code}' -b "$jar" \
    -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
    -d "{\"userId\":\"$uid\"}" \
    "$URL/api/v1/business-workspaces/$OPSWEAVE_LEGACY_WORKSPACE_ID/members")"
  case "$status" in
    200|201) return 0 ;;
    *)
      printf 'grant %s into %s -> %s: %s\n' "$uid" "$OPSWEAVE_LEGACY_WORKSPACE_ID" "$status" \
        "$(head -c 300 "$_ow_grant_body" 2>/dev/null)" >&2
      printf 'without this membership the account reads nothing and can file nothing (D5 section 3.4)\n' >&2
      return 1
      ;;
  esac
}

# ow_grant_legacy_self <jar> <csrf> -> grants the signed-in account itself, the way an installer
# gives a fresh installation's administrator the workspace it needs before it can file anything.
ow_grant_legacy_self() {
  local uid
  uid="$(ow_user_id "$1")"
  if [ -z "$uid" ]; then
    printf 'GET /api/v1/auth/me carried no user id, so no membership could be granted\n' >&2
    return 1
  fi
  ow_grant_legacy "$1" "$2" "$uid"
}
