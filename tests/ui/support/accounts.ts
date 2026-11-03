import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Account seeding for the UI specs, in one place because it has two halves that must not
 * drift apart (G12 D5, docs/design/g12-scope/d5-business-workspace-adr.md).
 *
 * D5 §3.3 and the migration 0022 make a business row readable for exactly one reason: the
 * caller is a MEMBER of the business workspace the row lives in. A role no longer implies a
 * workspace, and an account created after the migration is a member of NOTHING until an
 * administrator grants it (§3.4: "迁移之后新建的账号不自动获得任何工作区，必须由管理员授予").
 *
 * Two consequences the old seeds did not carry, and this module now does:
 *
 *   1. An account created through POST /api/v1/users can sign in, and then reads nothing and
 *      writes nothing: POST /incidents answers 403 INCIDENT_WORKSPACE_FORBIDDEN because the
 *      account is a member of no workspace to file the row under, and every list comes back
 *      empty. A spec whose fixture creates a viewer and an operator and then asserts that the
 *      viewer READS what the operator wrote was passing on the pre-D5 predicate - all viewers
 *      read everything - not on the thing it claims to prove. The grant is part of the fixture.
 *
 *   2. On a FRESH database the bootstrap admin belongs to zero workspaces as well, because the
 *      kernel runs migrations before it creates the bootstrap account (db.rs init: migrate ->
 *      seed_admin) and the migration's one-time grant only covers accounts that already exist.
 *      §3.4 states this as the literal result of the ruling, not a defect: the admin "能创建
 *      工作区、能授予，但读不到任何业务行，直到它显式给自己授予一次（那是一次被审计的平台
 *      动作，不是自动获得）". The seed performs that audited action once, the way an installer
 *      would, so a spec that lands on a scratch database starts from a readable workspace.
 *
 * What this module deliberately does NOT do: it never widens a permission predicate, never adds
 * an account to a workspace it was not granted through the admin API, and never grants anything
 * to a role as a role. Every call here is the same two public HTTP requests a human operator
 * would send, and the kernel decides their outcome - the helper only asserts it happened.
 */

/**
 * The legacy workspace migration 0022 creates for every incident that predates D5. Fixed UUID
 * so an operator, a rollback script and a test can name it without a lookup (§3.4).
 */
export const LEGACY_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/** A signed-in administrator, plus the identity a membership grant is addressed to. */
export interface AdminSeed {
  csrf: string;
  userId: string;
}

/** What a spec needs to describe the account it wants; nothing here is a permission. */
export interface AccountSpec {
  email: string;
  password: string;
  displayName: string;
  role: 'operator' | 'viewer';
}

/** The account as the kernel created it: the id is what the grant names. */
export interface SeedAccount extends AccountSpec {
  id: string;
}

/**
 * POST /api/v1/business-workspaces/{legacy}/members (admin) - the grant, and the only route
 * into a workspace. Idempotent by design: 201 the first time, 200 on a replay, and both mean
 * "this account may read this workspace". Anything else is a seed failure the spec must see by
 * name instead of as a mystery 403 three assertions later.
 */
export async function grantLegacyMembership(
  api: APIRequestContext,
  admin: AdminSeed,
  userId: string,
): Promise<void> {
  const granted = await api.post('/api/v1/business-workspaces/' + LEGACY_WORKSPACE_ID + '/members', {
    headers: { 'x-csrf-token': admin.csrf },
    data: { userId },
  });
  expect(
    [200, 201],
    'POST /api/v1/business-workspaces/' + LEGACY_WORKSPACE_ID + '/members for ' + userId
      + ' -> ' + granted.status() + ': ' + (await granted.text()).slice(0, 300)
      + ' - without this membership the account reads nothing and can file nothing (D5 §3.4)',
  ).toContain(granted.status());
}

/**
 * Signs the administrator in and gives it the one-time legacy grant a fresh installation needs
 * before it can create a single incident. Replays harmlessly (the kernel answers 200).
 *
 * Returns the session the create/grant calls below are made with; the cookie jar is the
 * caller's, so pass the context whose cookies the spec wants to carry the admin session.
 */
export async function adminSeed(
  api: APIRequestContext,
  email: string,
  password: string,
): Promise<AdminSeed> {
  const login = await api.post('/api/v1/auth/login', { data: { email, password } });
  expect(login.ok(), 'admin login for fixture setup: ' + email + ' -> ' + login.status()).toBeTruthy();
  const { csrfToken } = (await login.json()) as { csrfToken: string };

  const me = await api.get('/api/v1/auth/me');
  expect(me.ok(), 'the admin session must name the user id the grant is addressed to').toBeTruthy();
  const { user } = (await me.json()) as { user?: { id?: string } };
  expect(user?.id, 'GET /api/v1/auth/me carried no user id, so no membership could be granted').toBeTruthy();

  const admin: AdminSeed = { csrf: csrfToken, userId: user!.id as string };
  await grantLegacyMembership(api, admin, admin.userId);
  return admin;
}

/**
 * Creates an account through the admin API and grants it the legacy workspace, in that order.
 *
 * The second call is not optional and is not left to each spec: an account created without it
 * is a member of nothing, so a "the viewer reads the operator's record" assertion would read an
 * empty list and fail for a reason that has nothing to do with the rule under test - or, worse,
 * pass on the pre-D5 predicate. Every spec that fabricates an account goes through here.
 *
 * `grant: false` is for the one fixture that must own NO membership: the create gate refuses an
 * account in no workspace, and a spec that cannot produce that account cannot test the refusal.
 */
export async function createAccount(
  api: APIRequestContext,
  admin: AdminSeed,
  account: AccountSpec,
  options: { grant?: boolean } = {},
): Promise<SeedAccount> {
  const created = await api.post('/api/v1/users', {
    headers: { 'x-csrf-token': admin.csrf },
    data: {
      email: account.email,
      displayName: account.displayName,
      password: account.password,
      role: account.role,
    },
  });
  // The body is read once, as text, so the failure message can quote it and the id can still
  // be parsed from the very same bytes.
  const createdBody = await created.text();
  // The kernel answers a created account with 200 and the row; 201 is accepted so a future
  // change of that status does not turn every seed into a failure.
  expect(
    [200, 201],
    'create the ' + account.role + ' account ' + account.email + ' -> ' + created.status()
      + ': ' + createdBody.slice(0, 300),
  ).toContain(created.status());
  const { id } = JSON.parse(createdBody) as { id?: string };
  expect(id, 'POST /api/v1/users returned no id, so no membership can be granted for ' + account.email).toBeTruthy();

  const seeded: SeedAccount = { ...account, id: id as string };
  if (options.grant !== false) await grantLegacyMembership(api, admin, seeded.id);
  return seeded;
}

/** A workspace created through the admin API, with the membership each caller needs. */
export interface SeedWorkspace {
  workspaceId: string;
  key: string;
}

/**
 * POST /api/v1/business-workspaces (admin), then grant it to every listed account.
 *
 * Creating a workspace does NOT enter it (D5 §2: platform administration is not a data grant),
 * so each grant is a second, explicit call. A spec that wants "an operator in TWO workspaces"
 * gets it from here, and the create gate then has to ask which one - which is the whole point.
 */
export async function createWorkspace(
  api: APIRequestContext,
  admin: AdminSeed,
  memberIds: string[],
  key: string,
): Promise<SeedWorkspace> {
  const created = await api.post('/api/v1/business-workspaces', {
    headers: { 'x-csrf-token': admin.csrf },
    data: { key, name: key },
  });
  const body = await created.text();
  expect([200, 201, 409], 'create workspace ' + key + ' -> ' + created.status() + ': ' + body.slice(0, 300))
    .toContain(created.status());
  let workspaceId: string;
  if (created.status() === 409) {
    // Idempotent for a re-run against the same database: read the id back from the list the
    // admin is allowed to see (every workspace's metadata, member or not).
    const listed = await api.get('/api/v1/business-workspaces');
    expect(listed.ok(), 'list workspaces to resolve ' + key).toBeTruthy();
    const rows = (await listed.json()) as Array<{ workspaceId: string; key: string }>;
    const found = rows.find((row) => row.key === key);
    expect(found, 'workspace ' + key + ' exists but is not in the admin list').toBeTruthy();
    workspaceId = found!.workspaceId;
  } else {
    workspaceId = (JSON.parse(body) as { workspaceId: string }).workspaceId;
  }
  for (const userId of memberIds) {
    const granted = await api.post('/api/v1/business-workspaces/' + workspaceId + '/members', {
      headers: { 'x-csrf-token': admin.csrf },
      data: { userId },
    });
    expect([200, 201], 'grant ' + userId + ' membership of ' + key + ' -> ' + granted.status() + ': ' + (await granted.text()).slice(0, 200))
      .toContain(granted.status());
  }
  return { workspaceId, key };
}
