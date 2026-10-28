import { describe, expect, it } from 'vitest';
import { normalizeContribution, visibleContributions, type AcceptedContribution, type RejectedContribution } from './extensions';

const PLUGIN = 'com.acme.plugin';
const ADMIN_PATH = '/admin/ext/com.acme.plugin/reports';
const WORKSPACE_PATH = '/app/ext/com.acme.plugin/reports';

const access = { allowedSurfaces: ['admin', 'workspace'] as const, capabilities: ['platform:access', 'workspace:access'] };

function accept(raw: unknown, pluginId = PLUGIN): AcceptedContribution {
  const outcome = normalizeContribution(pluginId, raw);
  if (!outcome) throw new Error('expected an accepted contribution, got null (not a mountable contribution)');
  if ('code' in outcome) throw new Error(`expected acceptance, got rejection ${outcome.code}`);
  return outcome;
}

function reject(raw: unknown, pluginId = PLUGIN): RejectedContribution {
  const outcome = normalizeContribution(pluginId, raw);
  if (!outcome) throw new Error('expected a rejection, got null');
  if (!('code' in outcome)) throw new Error('expected a rejection, got an accepted contribution');
  return outcome;
}

describe('normalizeContribution: accepted shapes', () => {
  it('accepts a well-formed v2 admin contribution unchanged', () => {
    expect(accept({ kind: 'route.page.v2', id: 'reports', path: ADMIN_PATH, surface: 'admin' })).toEqual({
      pluginId: PLUGIN,
      kind: 'route.page',
      id: 'reports',
      path: ADMIN_PATH,
      href: ADMIN_PATH,
      surface: 'admin',
      version: 2,
      requiredCapabilities: [],
    });
  });

  it('accepts a v2 workspace contribution under the workspace outlet', () => {
    const accepted = accept({ kind: 'navigation.item.v2', id: 'reports', path: WORKSPACE_PATH, surface: 'workspace' });
    expect(accepted.surface).toBe('workspace');
    expect(accepted.kind).toBe('navigation.item');
    expect(accepted.href).toBe(WORKSPACE_PATH);
  });

  it('keeps a v1 contribution at its legacy path, mounted under admin', () => {
    const accepted = accept({ kind: 'navigation.item.v1', id: 'hello', path: '/ext/acme/hello' });
    expect(accepted).toEqual({
      pluginId: PLUGIN,
      kind: 'navigation.item',
      id: 'hello',
      path: '/ext/acme/hello',
      href: '/admin/ext/acme/hello',
      surface: 'admin',
      version: 1,
      requiredCapabilities: [],
    });
  });

  it('normalizes one trailing slash away so two spellings are one route', () => {
    expect(accept({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH + '/', surface: 'admin' }).path).toBe(ADMIN_PATH);
    expect(accept({ kind: 'navigation.item.v1', id: 'h', path: '/ext/acme/hello/' }).path).toBe('/ext/acme/hello');
  });

  it('deduplicates and keeps a capability inside the vocabulary', () => {
    const accepted = accept({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'admin', requiredCapabilities: ['platform:access', 'platform:access'] });
    expect(accepted.requiredCapabilities).toEqual(['platform:access']);
  });

  it('treats an absent requiredCapabilities as no extra requirement', () => {
    for (const raw of [undefined, null]) {
      const accepted = accept({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'admin', requiredCapabilities: raw });
      expect(accepted.requiredCapabilities).toEqual([]);
    }
  });
});

describe('normalizeContribution: silent drops', () => {
  it('returns null for anything that is not a mountable contribution', () => {
    const notContributions: unknown[] = [
      null,
      undefined,
      [],
      'route.page.v2',
      { kind: 'settings.section.v1', id: 'a', path: ADMIN_PATH, surface: 'admin' },
      { kind: 'route.page.v2', path: ADMIN_PATH, surface: 'admin' },
      { kind: 'route.page.v2', id: 'a', path: 'admin/ext/com.acme.plugin/x', surface: 'admin' },
      { kind: 'route.page.v2', id: 'a', path: ADMIN_PATH + '?x=1', surface: 'admin' },
      { kind: 'route.page.v2', id: 'a', path: ADMIN_PATH + '#x', surface: 'admin' },
    ];
    for (const raw of notContributions) expect(normalizeContribution(PLUGIN, raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('normalizeContribution: rejections', () => {
  it('rejects an illegal or missing surface', () => {
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'root' })).toMatchObject({ code: 'surface', detail: 'root' });
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH })).toMatchObject({ code: 'surface', detail: 'missing' });
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 5 })).toMatchObject({ code: 'surface', detail: 'missing' });
  });

  it('rejects a path outside the plugin namespace for its surface', () => {
    const crossing = reject({ kind: 'route.page.v2', id: 'r', path: WORKSPACE_PATH, surface: 'admin' });
    expect(crossing.code).toBe('namespace');
    expect(crossing.path).toBe(WORKSPACE_PATH);
    expect(crossing.href).toBe(WORKSPACE_PATH);

    expect(reject({ kind: 'route.page.v2', id: 'r', path: '/admin/ext/other.plugin/x', surface: 'admin' }).code).toBe('namespace');
    expect(reject({ kind: 'navigation.item.v1', id: 'r', path: '/admin/ext/com.acme.plugin/x' }).code).toBe('namespace');
    // A traversal-shaped claim passes the path shape, so the namespace rule is what refuses it.
    expect(reject({ kind: 'route.page.v2', id: 'r', path: '/admin/ext/../x', surface: 'admin' }).code).toBe('namespace');
  });

  it('rejects a host-owned root, including for v1', () => {
    for (const path of ['/admin', '/app', '/login', '/api', '/internal', '/assets', '/ext']) {
      const rejected = reject({ kind: 'route.page.v2', id: 'r', path, surface: 'admin' });
      expect(rejected.code, path).toBe('reserved');
      expect(rejected.href, path).toBe('');
    }
    expect(reject({ kind: 'navigation.item.v1', id: 'r', path: '/ext' }).code).toBe('reserved');
  });

  it('rejects a capability outside the vocabulary', () => {
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'admin', requiredCapabilities: ['root:superuser'] }))
      .toMatchObject({ code: 'capability', detail: 'root:superuser' });
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'admin', requiredCapabilities: 'platform:access' }))
      .toMatchObject({ code: 'capability', detail: 'not-a-list' });
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'admin', requiredCapabilities: [42] }))
      .toMatchObject({ code: 'capability', detail: 'not-a-string' });
  });

  it('records what the refused contribution claimed so the outlet can explain itself', () => {
    expect(reject({ kind: 'route.page.v2', id: 'r', path: ADMIN_PATH, surface: 'root' }).href).toBe(ADMIN_PATH);
  });
});

describe('visibleContributions', () => {
  const adminItem = accept({ kind: 'navigation.item.v2', id: 'a', path: ADMIN_PATH, surface: 'admin' });
  const workspaceItem = accept({ kind: 'navigation.item.v2', id: 'w', path: WORKSPACE_PATH, surface: 'workspace' });
  const gated = accept({ kind: 'route.page.v2', id: 'g', path: '/admin/ext/com.acme.plugin/gated', surface: 'admin', requiredCapabilities: ['platform:access'] });
  const overGated = accept({ kind: 'route.page.v2', id: 'x', path: '/admin/ext/com.acme.plugin/locked', surface: 'admin', requiredCapabilities: ['workspace:access'] });
  const all = [adminItem, workspaceItem, gated, overGated];

  it('never shows a surface the user cannot enter', () => {
    expect(visibleContributions(all, { allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] }, 'admin')).toEqual([]);
    expect(visibleContributions(all, { allowedSurfaces: ['admin'], capabilities: ['platform:access'] }, 'workspace')).toEqual([]);
  });

  it('requires the surface capability too, not just the surface name', () => {
    expect(visibleContributions(all, { allowedSurfaces: ['admin'], capabilities: ['workspace:access'] }, 'admin')).toEqual([]);
  });

  it('filters out a contribution whose own capability the user lacks', () => {
    expect(visibleContributions(all, { allowedSurfaces: ['admin'], capabilities: ['platform:access'] }, 'admin').map((entry) => entry.id))
      .toEqual(['a', 'g']);
  });

  it('shows only the contributions of the surface asked for', () => {
    expect(visibleContributions(all, { allowedSurfaces: ['admin', 'workspace'], capabilities: ['platform:access', 'workspace:access'] }, 'workspace').map((entry) => entry.id))
      .toEqual(['w']);
  });
});
