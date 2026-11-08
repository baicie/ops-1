import { describe, expect, it } from 'vitest';
import { DENY_ACCESS, canEnterSurface, legacyRedirect, normalizeAccess, readAccess, type AccessInfo } from './surface';

const WORKSPACE_ONLY = { allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] };
const BOTH = {
  allowedSurfaces: ['admin', 'workspace'],
  capabilities: ['platform:access', 'workspace:access'],
};

describe('normalizeAccess', () => {
  it('denies admin when the payload is missing, malformed or empty', () => {
    for (const raw of [null, undefined, '', 'admin', 0, 42, true, [], {}]) {
      const access = normalizeAccess(raw);
      expect(access.allowedSurfaces, JSON.stringify(raw)).toEqual(['workspace']);
      expect(access.capabilities, JSON.stringify(raw)).toEqual(['workspace:access']);
      expect(canEnterSurface(access, 'admin'), JSON.stringify(raw)).toBe(false);
    }
  });

  it('falls back to the documented denial for empty arrays', () => {
    expect(normalizeAccess({ allowedSurfaces: [], capabilities: [] })).toEqual(WORKSPACE_ONLY);
    expect(canEnterSurface(normalizeAccess({ allowedSurfaces: [], capabilities: [] }), 'admin')).toBe(false);
  });

  it('falls back when every declared surface name is unknown', () => {
    expect(normalizeAccess({ allowedSurfaces: ['root', 'superuser'], capabilities: ['platform:access'] })).toEqual({
      allowedSurfaces: ['workspace'],
      capabilities: ['platform:access'],
    });
  });

  it('drops unknown surface names instead of forwarding them', () => {
    expect(normalizeAccess({ allowedSurfaces: ['root', 'admin', 'workspace', 'nope'], capabilities: ['platform:access', 'workspace:access'] })).toEqual(BOTH);
    expect(normalizeAccess({ allowedSurfaces: ['root', 'admin'], capabilities: [] }).allowedSurfaces).toEqual(['admin']);
  });

  it('drops non-string capabilities instead of forwarding them', () => {
    expect(normalizeAccess({ allowedSurfaces: ['admin'], capabilities: [1, null, {}, 'platform:access'] }).capabilities)
      .toEqual(['platform:access']);
  });

  it('a workspace-only grant carries no admin', () => {
    const access = normalizeAccess(WORKSPACE_ONLY);
    expect(access).toEqual(WORKSPACE_ONLY);
    expect(canEnterSurface(access, 'admin')).toBe(false);
    expect(canEnterSurface(access, 'workspace')).toBe(true);
  });

  it('a grant naming both surfaces carries admin', () => {
    const access = normalizeAccess(BOTH);
    expect(access.allowedSurfaces).toContain('admin');
    expect(canEnterSurface(access, 'admin')).toBe(true);
    expect(canEnterSurface(access, 'workspace')).toBe(true);
  });

  it('declaring the admin surface without the capability still denies admin', () => {
    const access = normalizeAccess({ allowedSurfaces: ['admin', 'workspace'], capabilities: ['workspace:access'] });
    expect(access.allowedSurfaces).toContain('admin');
    expect(canEnterSurface(access, 'admin')).toBe(false);
  });

  it('does not mutate the payload it reads', () => {
    const raw = { allowedSurfaces: ['admin', 'root'], capabilities: ['platform:access'] };
    normalizeAccess(raw);
    expect(raw).toEqual({ allowedSurfaces: ['admin', 'root'], capabilities: ['platform:access'] });
  });
});

describe('readAccess provenance', () => {
  it('reports "missing" when the payload declares no access at all', () => {
    for (const raw of [null, undefined, {}, 'nope', []]) {
      expect(readAccess(raw)).toEqual({ access: DENY_ACCESS, source: 'missing' });
    }
  });

  it('reports "declared" once either field is an array', () => {
    expect(readAccess(BOTH)).toEqual({ access: BOTH, source: 'declared' });
    expect(readAccess({ allowedSurfaces: ['workspace'] }).source).toBe('declared');
    expect(readAccess({ capabilities: ['platform:access'] }).source).toBe('declared');
  });

  it('a declared denial is not reported as a missing declaration', () => {
    const grant = readAccess({ allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] });
    expect(grant.source).toBe('declared');
    expect(canEnterSurface(grant.access, 'admin')).toBe(false);
  });
});

describe('canEnterSurface', () => {
  const access: AccessInfo = { allowedSurfaces: ['admin', 'workspace'], capabilities: ['platform:access'] };

  it('admin requires both the surface grant and platform:access', () => {
    expect(canEnterSurface(access, 'admin')).toBe(true);
    expect(canEnterSurface({ ...access, capabilities: ['workspace:access'] }, 'admin')).toBe(false);
    expect(canEnterSurface({ ...access, allowedSurfaces: ['workspace'] }, 'admin')).toBe(false);
    expect(canEnterSurface({ allowedSurfaces: ['workspace'], capabilities: ['platform:access'] }, 'admin')).toBe(false);
  });

  it('workspace reads only the surface list', () => {
    expect(canEnterSurface({ allowedSurfaces: ['workspace'], capabilities: [] }, 'workspace')).toBe(true);
    expect(canEnterSurface({ allowedSurfaces: ['admin'], capabilities: ['platform:access'] }, 'workspace')).toBe(false);
  });

  it('denies a malformed grant instead of throwing', () => {
    const broken: unknown[] = [null, undefined, {}, { allowedSurfaces: 'admin' }, { capabilities: ['platform:access'] }];
    for (const grant of broken) expect(canEnterSurface(grant as AccessInfo, 'admin'), String(grant)).toBe(false);
  });
});

describe('legacyRedirect targets', () => {
  it('maps every pre-G04 path onto its canonical /admin route', () => {
    const cases: [string, string][] = [
      ['/plugins', '/admin/plugins'],
      ['/plugins/install', '/admin/plugins/install'],
      ['/plugins/dev.opsweave.hello', '/admin/plugins/dev.opsweave.hello'],
      ['/nodes', '/admin/nodes'],
      ['/pipelines/p1/editor', '/admin/pipelines/p1/editor'],
      ['/pipelines/p1/run', '/admin/pipelines/p1/run'],
      ['/jobs/j1', '/admin/jobs/j1'],
      ['/settings/diagnostics', '/admin/settings/diagnostics'],
      ['/ops-center', '/admin/ops-center'],
      ['/instances/i1/logs', '/admin/instances/i1/logs'],
      ['/ext', '/admin/ext'],
      ['/ext/trusted-team/hello', '/admin/ext/trusted-team/hello'],
    ];
    for (const [from, to] of cases) expect(legacyRedirect(from), from).toBe(to);
  });

  it('produces no target for an unknown, canonical or out-of-bounds path', () => {
    const noTarget = [
      '/',
      '/app/home',
      '/admin/plugins',
      '/admin/overview',
      '/nope',
      '/plugins/install/step-2',
      '/ext/../etc/passwd',
      '/ext/..',
      '/ext/a/../../admin',
      '/ext/with space',
      '/ext/with\\backslash',
      'https://evil.example/plugins',
      '//evil.example/plugins',
    ];
    for (const pathname of noTarget) expect(legacyRedirect(pathname), pathname).toBeNull();
  });

  it('keeps only the allowlisted query keys', () => {
    expect(legacyRedirect('/plugins/abc', '?tab=deployments')).toBe('/admin/plugins/abc?tab=deployments');
    expect(legacyRedirect('/plugins/abc', '?tab=deployments&next=https://evil.example')).toBe('/admin/plugins/abc?tab=deployments');
    expect(legacyRedirect('/nodes', '?filter=ready&redirect=/admin/access')).toBe('/admin/nodes?filter=ready');
    expect(legacyRedirect('/pipelines/p1/editor', '?draft=7&node=n2&next=/x')).toBe('/admin/pipelines/p1/editor?draft=7&node=n2');
  });

  it('drops every parameter for a destination that reads none', () => {
    expect(legacyRedirect('/settings', '?tab=security')).toBe('/admin/settings');
    expect(legacyRedirect('/jobs/j1', '?tab=logs')).toBe('/admin/jobs/j1');
    expect(legacyRedirect('/plugins', '?next=/admin/access')).toBe('/admin/plugins');
  });

  it('re-encodes the captured segment and survives a malformed escape', () => {
    expect(legacyRedirect('/plugins/a%2Fb')).toBe('/admin/plugins/a%2Fb');
    expect(legacyRedirect('/plugins/%zz')).toBe('/admin/plugins/%25zz');
    expect(legacyRedirect('/nodes/%E4%B8%AD%E6%96%87')).toBe('/admin/nodes/%E4%B8%AD%E6%96%87');
  });
});
