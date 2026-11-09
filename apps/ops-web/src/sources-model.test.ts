import { describe, expect, it } from 'vitest';
import type { Capability, Extension, PluginSummary, Publisher } from '@opsweave/platform-client/contracts';
import {
  buildSourcesModel,
  deriveReach,
  deriveReadiness,
  deriveTrust,
  isSourceCapability,
  maskReference,
  summarize,
  validateCredentialRef,
  type GrantView,
} from './sources-model';

const plugin = (over: Partial<PluginSummary> = {}): PluginSummary => ({
  id: 'acme.zabbix',
  name: 'Zabbix',
  publisher: 'acme',
  latestVersion: '1.0.0',
  activeVersion: '1.0.0',
  state: 'ACTIVE',
  signatureState: 'VERIFIED',
  hasFrontend: false,
  hasBackend: true,
  desiredReplicas: 1,
  readyInstances: 1,
  totalInstances: 1,
  isSystem: false,
  ...over,
});

const capability = (over: Partial<Capability> = {}): Capability => ({
  pluginId: 'acme.zabbix',
  version: '1.0.0',
  name: 'telemetry.metrics.v1',
  major: 1,
  direction: 'PROVIDES',
  activationRevision: 3,
  ...over,
});

const publisher = (over: Partial<Publisher> = {}): Publisher => ({
  publisherId: 'acme',
  fingerprint: 'ab'.repeat(16),
  trustState: 'TRUSTED',
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
});

const grant = (over: Partial<GrantView> = {}): GrantView => ({
  grantId: '3f8b25a0-7c94-4d61-b2e8-9d0a4c7f16b3',
  name: 'telemetry.metrics.v1',
  major: 1,
  consumerPluginId: 'opsweave.incidents',
  state: 'ACTIVE',
  createdAt: '2026-10-02T00:00:00Z',
  ...over,
});

/**
 * The classifier is the whole plugin-first claim of this page: a connector appears because it
 * registered a source capability, not because its id is on a list. These cases pin the segment
 * boundary, which is the part a prefix test gets wrong.
 */
describe('isSourceCapability', () => {
  it('admits the family the shipped data-integration manifest provides', () => {
    expect(isSourceCapability('data.source.v1')).toBe(true);
  });

  it('admits a telemetry family a collector registers under', () => {
    expect(isSourceCapability('telemetry.metrics.v1')).toBe(true);
    expect(isSourceCapability('telemetry.events.v1')).toBe(true);
  });

  it('rejects a name that merely starts with the same letters', () => {
    // A raw prefix test would admit both of these, and the page would grow rows for
    // capabilities that have nothing to do with collection.
    expect(isSourceCapability('data.sourcemap.v1')).toBe(false);
    expect(isSourceCapability('telemetryx.metrics.v1')).toBe(false);
  });

  it('rejects an unrelated capability and junk input', () => {
    expect(isSourceCapability('data.catalog.v1')).toBe(false);
    expect(isSourceCapability('')).toBe(false);
  });
});

/**
 * The security-critical derivation: an unsigned or unvouched-for source may never read as
 * attested, and "we did not look" must stay distinguishable from "we looked and it is unsigned".
 */
describe('deriveTrust', () => {
  it('is SOURCE_ATTESTED only when the signature verified and the publisher is trusted', () => {
    expect(deriveTrust('VERIFIED', publisher())).toEqual({ level: 'SOURCE_ATTESTED', reason: 'signed' });
  });

  it('downgrades a verified bundle whose publisher trust was revoked', () => {
    expect(deriveTrust('VERIFIED', publisher({ revokedAt: '2026-10-20T00:00:00Z' })).level).toBe('OPERATOR_ASSERTED');
    expect(deriveTrust('VERIFIED', publisher({ trustState: 'REVOKED' })).level).toBe('OPERATOR_ASSERTED');
  });

  it('downgrades a verified bundle whose publisher is not in the trust store at all', () => {
    expect(deriveTrust('VERIFIED', null).level).toBe('OPERATOR_ASSERTED');
  });

  it('reports an unsigned bundle as UNVERIFIED', () => {
    expect(deriveTrust('UNSIGNED', publisher()).level).toBe('UNVERIFIED');
  });

  it('separates "no signature state" from "unsigned"', () => {
    // machine-language-rules M1: an absent reading is NO_DATA/UNKNOWN, never a verdict.
    expect(deriveTrust(null, publisher())).toEqual({ level: 'UNKNOWN', reason: 'missing' });
    expect(deriveTrust('', publisher()).level).toBe('UNKNOWN');
  });

  it('treats a kernel-owned plugin as attested by the platform build', () => {
    expect(deriveTrust('SYSTEM', null)).toEqual({ level: 'SOURCE_ATTESTED', reason: 'system' });
  });
});

describe('deriveReach', () => {
  it('is granted while an ACTIVE grant exists', () => {
    expect(deriveReach('telemetry.metrics.v1', 1, [grant()])).toEqual({ reach: 'granted', consumers: 1 });
  });

  it('counts only the grants for this capability and major', () => {
    const grants = [grant(), grant({ major: 2 }), grant({ name: 'data.catalog.v1' })];
    expect(deriveReach('telemetry.metrics.v1', 1, grants).consumers).toBe(1);
  });

  it('is notGranted when the registry answered and named no consumer', () => {
    expect(deriveReach('telemetry.metrics.v1', 1, [])).toEqual({ reach: 'notGranted', consumers: 0 });
  });

  it('is unknown - not notGranted - when the grants route never answered', () => {
    // A viewer who cannot list grants must not see a page claiming nothing is reachable.
    expect(deriveReach('telemetry.metrics.v1', 1, null)).toEqual({ reach: 'unknown', consumers: 0 });
  });

  it('distinguishes an expired grant from a revoked one', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(deriveReach('telemetry.metrics.v1', 1, [grant({ expiresAt: past })]).reach).toBe('expired');
    expect(deriveReach('telemetry.metrics.v1', 1, [grant({ state: 'EXPIRED' })]).reach).toBe('expired');
    expect(deriveReach('telemetry.metrics.v1', 1, [grant({ state: 'REVOKED' })]).reach).toBe('revoked');
  });

  it('keeps a future expiry live', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(deriveReach('telemetry.metrics.v1', 1, [grant({ expiresAt: future })]).reach).toBe('granted');
  });
});

describe('deriveReadiness', () => {
  it('separates the four real cases', () => {
    expect(deriveReadiness(2, 2)).toBe('serving');
    expect(deriveReadiness(1, 2)).toBe('partial');
    expect(deriveReadiness(0, 2)).toBe('down');
    // Nothing was asked for: that is not a failure and not readiness.
    expect(deriveReadiness(0, 0)).toBe('none');
  });

  it('is unknown when either count is missing', () => {
    expect(deriveReadiness(null, 2)).toBe('unknown');
    expect(deriveReadiness(2, undefined)).toBe('unknown');
  });
});

describe('buildSourcesModel', () => {
  it('builds a row from the capability registry, not from a plugin id list', () => {
    const model = buildSourcesModel({
      plugins: [plugin()],
      capabilities: [capability()],
      grants: [grant()],
      publishers: [publisher()],
      extensions: null,
    });
    expect(model.connectors).toHaveLength(1);
    expect(model.connectors[0]).toMatchObject({
      pluginId: 'acme.zabbix',
      name: 'Zabbix',
      capability: 'telemetry.metrics.v1',
      trust: 'SOURCE_ATTESTED',
      reach: 'granted',
      readiness: 'serving',
    });
  });

  it('admits an unknown connector written by another session with no change here', () => {
    // The property the whole module exists for: a plugin this file has never heard of shows up
    // the moment it registers a source capability.
    const model = buildSourcesModel({
      plugins: [plugin({ id: 'third.party', name: 'Someone Else', publisher: null, signatureState: null })],
      capabilities: [capability({ pluginId: 'third.party', name: 'telemetry.logs.v1' })],
      grants: [],
      publishers: [],
      extensions: null,
    });
    expect(model.connectors.map((row) => row.pluginId)).toEqual(['third.party']);
    expect(model.connectors[0].trust).toBe('UNKNOWN');
  });

  it('ignores REQUIRES rows when building connectors', () => {
    const model = buildSourcesModel({
      plugins: [plugin()],
      capabilities: [capability({ direction: 'REQUIRES' })],
      grants: [],
      publishers: [],
      extensions: null,
    });
    expect(model.connectors).toEqual([]);
  });

  it('collapses one plugin that provides several source capabilities into one row', () => {
    const model = buildSourcesModel({
      plugins: [plugin()],
      capabilities: [
        capability({ name: 'telemetry.metrics.v1' }),
        capability({ name: 'telemetry.events.v1' }),
        // Same name/major re-registered on another activation revision: still one row.
        capability({ name: 'telemetry.metrics.v1', activationRevision: 4 }),
      ],
      grants: [],
      publishers: [publisher()],
      extensions: null,
    });
    expect(model.connectors).toHaveLength(1);
    expect(model.connectors[0].capabilities.map((item) => item.name)).toEqual([
      'telemetry.events.v1',
      'telemetry.metrics.v1',
    ]);
  });

  it('drops a registration whose plugin the plugin route does not list', () => {
    // Rendering it would mean five NO_DATA cells standing in for a platform inconsistency.
    const model = buildSourcesModel({
      plugins: [],
      capabilities: [capability()],
      grants: [],
      publishers: [],
      extensions: null,
    });
    expect(model.connectors).toEqual([]);
  });

  it('marks a duplicated display name so the row can carry a disambiguator', () => {
    const model = buildSourcesModel({
      plugins: [plugin(), plugin({ id: 'other.zabbix' })],
      capabilities: [capability(), capability({ pluginId: 'other.zabbix' })],
      grants: [],
      publishers: [publisher()],
      extensions: null,
    });
    expect(model.connectors.every((row) => row.nameIsAmbiguous)).toBe(true);
  });

  it('states the plugins it could not classify instead of hiding them', () => {
    const model = buildSourcesModel({
      plugins: [plugin(), plugin({ id: 'data.catalog', name: 'Catalog' })],
      capabilities: [capability(), capability({ pluginId: 'data.catalog', name: 'data.catalog.v1' })],
      grants: [],
      publishers: [publisher()],
      extensions: null,
    });
    expect(model.connectors).toHaveLength(1);
    expect(model.unclassifiedProviders).toBe(1);
  });

  it('separates "the registry answered with no source" from "nobody asked"', () => {
    expect(buildSourcesModel({ plugins: [], capabilities: [], grants: [], publishers: [], extensions: null }).noSourceCapability).toBe(true);
    // capabilities === null is "we never got an answer", which is not an empty answer.
    expect(buildSourcesModel({ plugins: [], capabilities: null, grants: [], publishers: [], extensions: null }).noSourceCapability).toBe(false);
  });

  it('reports a source capability something requires and nothing provides', () => {
    const model = buildSourcesModel({
      plugins: [plugin({ id: 'opsweave.incidents', name: 'Incidents' })],
      capabilities: [capability({ pluginId: 'opsweave.incidents', name: 'telemetry.metrics.v1', direction: 'REQUIRES' })],
      grants: [],
      publishers: [],
      extensions: null,
    });
    expect(model.unsatisfiedRequirements).toEqual([
      { name: 'telemetry.metrics.v1', major: 1, consumerPluginId: 'opsweave.incidents' },
    ]);
  });

  it('offers a config destination only when the plugin actually contributes a page', () => {
    const extension = (contributions: Extension['contributions']): Extension => ({
      pluginId: 'acme.zabbix',
      publisher: 'acme',
      version: '1.0.0',
      activationRevision: 3,
      assetBase: '/assets/acme/zabbix/1.0.0',
      remoteEntry: 'remoteEntry.js',
      contributions,
    });
    const withPage = buildSourcesModel({
      plugins: [plugin()],
      capabilities: [capability()],
      grants: [],
      publishers: [publisher()],
      extensions: [extension([{ kind: 'route.page.v1', id: 'cfg', path: '/ext/acme/zabbix' }])],
    });
    expect(withPage.connectors[0].configPath).toBe('/ext/acme/zabbix');

    const navOnly = buildSourcesModel({
      plugins: [plugin()],
      capabilities: [capability()],
      grants: [],
      publishers: [publisher()],
      extensions: [extension([{ kind: 'navigation.item.v1', id: 'nav', path: '/ext/acme/zabbix' }])],
    });
    expect(navOnly.connectors[0].configPath).toBeNull();
  });
});

describe('summarize', () => {
  const model = (plugins: PluginSummary[], capabilities: Capability[], grants: GrantView[] | null) =>
    buildSourcesModel({ plugins, capabilities, grants, publishers: [publisher()], extensions: null }).connectors;

  it('counts a connector as serving only when active, fully ready and granted', () => {
    expect(summarize(model([plugin()], [capability()], [grant()])).serving).toBe(1);
    // Granted and active, but a replica is missing.
    expect(summarize(model([plugin({ readyInstances: 0 })], [capability()], [grant()])).serving).toBe(0);
    // Active and ready, but nothing may call it.
    expect(summarize(model([plugin()], [capability()], [])).serving).toBe(0);
    // Ready and granted, but the plugin is disabled.
    expect(summarize(model([plugin({ state: 'DISABLED' })], [capability()], [grant()])).serving).toBe(0);
  });

  it('counts anything not fully attested as unattested', () => {
    expect(summarize(model([plugin({ signatureState: null })], [capability()], [grant()])).unattested).toBe(1);
    expect(summarize(model([plugin()], [capability()], [grant()])).unattested).toBe(0);
  });

  it('counts a failed or half-ready connector as needing attention', () => {
    expect(summarize(model([plugin({ state: 'FAILED' })], [capability()], [grant()])).attention).toBe(1);
    expect(summarize(model([plugin({ readyInstances: 1, totalInstances: 2 })], [capability()], [grant()])).attention).toBe(1);
  });

  it('reports zero counts over an empty list without inventing a reading', () => {
    expect(summarize([])).toEqual({ total: 0, serving: 0, attention: 0, unattested: 0 });
  });
});

/**
 * rules/03-security.md: a credential travels as a reference. The field must refuse secret
 * material, and - just as important - must never hand the rejected input back to the caller,
 * which would put it straight into the DOM.
 */
describe('validateCredentialRef', () => {
  it('accepts a kernel secret reference', () => {
    expect(validateCredentialRef('secret://zabbix/api-token')).toEqual({
      ok: true,
      kind: 'secretRef',
      value: 'secret://zabbix/api-token',
    });
  });

  it('accepts an environment variable name', () => {
    expect(validateCredentialRef('ZABBIX_API_TOKEN')).toEqual({ ok: true, kind: 'envVar', value: 'ZABBIX_API_TOKEN' });
  });

  it('refuses the realistic pasted secret shapes', () => {
    const pasted = [
      'Bearer abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9.payload',
      '-----BEGIN PRIVATE KEY-----',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnopqrstuvwxyz',
      'A'.repeat(44),
      'a1b2c3d4'.repeat(6),
    ];
    for (const value of pasted) {
      const result = validateCredentialRef(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('looksLikeSecret');
    }
  });

  it('never returns the rejected input', () => {
    const result = validateCredentialRef('Bearer super-secret-value');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('refuses anything that is neither shape', () => {
    expect(validateCredentialRef('lowercase_env')).toMatchObject({ ok: false, code: 'badShape' });
    expect(validateCredentialRef('http://example.com/token')).toMatchObject({ ok: false, code: 'badShape' });
    expect(validateCredentialRef('')).toMatchObject({ ok: false, code: 'empty' });
    expect(validateCredentialRef('   ')).toMatchObject({ ok: false, code: 'empty' });
    expect(validateCredentialRef('B'.repeat(200))).toMatchObject({ ok: false, code: 'tooLong' });
  });
});

describe('maskReference', () => {
  it('keeps the tail of a long reference hidden', () => {
    const masked = maskReference('secret://tenant-acme/zabbix/api-token');
    expect(masked).toBe('secret://t…en');
    expect(masked).not.toContain('tenant-acme');
  });

  it('passes a short reference through and reports absence as null', () => {
    expect(maskReference('ZABBIX_TOKEN')).toBe('ZABBIX_TOKEN');
    expect(maskReference(null)).toBeNull();
    expect(maskReference('  ')).toBeNull();
  });
});
