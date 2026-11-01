import type { Capability, Extension, PluginSummary, Publisher } from '../types';

/**
 * What a "source" is on this platform, derived rather than hard-coded per vendor.
 *
 * A telemetry connector is not a kernel concept: `rules/01-architecture.md` keeps business
 * function in plugins, so the kernel knows only "a plugin PROVIDES capability `x.y.v1` at
 * major N". This module is therefore the one place that answers "which of those plugins is a
 * data source", and it answers it from the capability registry (`GET /api/v1/capabilities`)
 * joined onto the plugin list - never from a list of plugin ids.
 *
 * The consequence is the property the page needs: any plugin that provides a source-family
 * capability appears in the table the moment it activates, including one written by a session
 * that has never seen this file. Nothing here reads a vendor name, an image reference or a
 * plugin-specific payload shape.
 */

/**
 * The capability families that make a plugin a source, matched on whole dot segments.
 *
 * `data.source` is what `plugins/data-integration/manifest.template.json` already provides;
 * `telemetry` is the family a metrics/event collector registers under. Segment-wise matching is
 * what keeps `data.sourcemap.v1` out: a prefix test on the raw string would admit it.
 *
 * This list is the contract with any connector author. A plugin that collects telemetry and
 * provides neither family is invisible here, which is a stated limitation and not a silent one -
 * `unclassifiedProviders` counts those plugins so the page can say so out loud.
 */
export const SOURCE_CAPABILITY_FAMILIES = ['data.source', 'telemetry'] as const;

/** True when `name` sits in a source family on a segment boundary. */
export function isSourceCapability(name: string): boolean {
  const segments = String(name || '').split('.');
  return SOURCE_CAPABILITY_FAMILIES.some((family) => {
    const wanted = family.split('.');
    return wanted.every((segment, index) => segments[index] === segment);
  });
}

/**
 * How much weight a source's output can carry, in the vocabulary
 * `contracts/openapi/incident-v1.yaml` already defines for evidence.
 *
 * The page renders this verbatim because it is the word an operator has to be able to trust:
 * an unsigned bundle from an untrusted publisher must never read as attested, so the derivation
 * below only ever *lowers* the level and `UNKNOWN` is a real outcome rather than a default.
 */
export type EvidenceTrust = 'SOURCE_ATTESTED' | 'OPERATOR_ASSERTED' | 'UNVERIFIED' | 'UNKNOWN';

/** Signature states the kernel writes for a package (`apps/kernel/src/packages.rs`). */
const SIGNATURE_VERIFIED = 'VERIFIED';
/** A first-party plugin the kernel ships; it has no publisher signature to check. */
const SIGNATURE_SYSTEM = 'SYSTEM';

/**
 * Trust for one connector, from the two independent facts the kernel exposes: whether the
 * package signature verified, and whether its publisher is still trusted.
 *
 * Both must hold for `SOURCE_ATTESTED`. A verified signature from a publisher whose trust was
 * revoked is `OPERATOR_ASSERTED` - the bytes are what they claim to be, but nobody currently
 * vouches for who produced them, and collapsing that into "attested" is how a revoked key keeps
 * passing for a trusted one.
 *
 * An absent signature state is `UNKNOWN`, never `UNVERIFIED`: "we did not look" and "we looked
 * and it is unsigned" are different facts (`machine-language-rules.md` §M1).
 */
export function deriveTrust(
  signatureState: string | null | undefined,
  publisher: Publisher | null | undefined,
): { level: EvidenceTrust; reason: 'signed' | 'system' | 'publisherRevoked' | 'unsigned' | 'missing' } {
  const signature = typeof signatureState === 'string' ? signatureState.trim().toUpperCase() : '';
  if (!signature) return { level: 'UNKNOWN', reason: 'missing' };
  // A kernel-owned plugin carries no third-party signature; the platform build is its provenance.
  if (signature === SIGNATURE_SYSTEM) return { level: 'SOURCE_ATTESTED', reason: 'system' };
  if (signature !== SIGNATURE_VERIFIED) return { level: 'UNVERIFIED', reason: 'unsigned' };
  // Verified bytes, but the key that signed them is no longer (or not yet) trusted here.
  const trustState = publisher ? String(publisher.trustState || '').toUpperCase() : '';
  const revoked = Boolean(publisher?.revokedAt) || (trustState !== '' && trustState !== 'TRUSTED');
  if (!publisher || revoked) return { level: 'OPERATOR_ASSERTED', reason: 'publisherRevoked' };
  return { level: 'SOURCE_ATTESTED', reason: 'signed' };
}

/**
 * Whether the capability this connector provides is actually callable by anyone.
 *
 * `GET /api/v1/capability-grants` lists consumer grants. A provider with no ACTIVE grant is
 * registered and unreachable, which is a different state from "not installed" and from
 * "installed and broken" - so it gets its own word instead of being folded into the status
 * column (`AGENTS.md`: `UNKNOWN` / `PARTIAL` / `NO_DATA` may not be dressed as health).
 */
export type GrantReach = 'granted' | 'notGranted' | 'expired' | 'revoked' | 'unknown';

/** One grant row, as the kernel returns it (`CapabilityGrantView`). */
export interface GrantView {
  id?: string;
  grantId?: string;
  name: string;
  major: number;
  consumerPluginId?: string;
  providerPluginId?: string | null;
  scope?: unknown;
  state: string;
  expiresAt?: string | null;
  createdAt?: string;
}

/**
 * Reach for one provided capability.
 *
 * `null` grants means the grants route was never answered (403 for a viewer, or a failed read),
 * which is `unknown` - not `notGranted`. A viewer who cannot list grants must not be shown a
 * page claiming every connector is unreachable.
 */
export function deriveReach(
  capabilityName: string,
  major: number,
  grants: GrantView[] | null,
): { reach: GrantReach; consumers: number } {
  if (grants === null) return { reach: 'unknown', consumers: 0 };
  const matching = grants.filter((grant) => grant.name === capabilityName && Number(grant.major) === Number(major));
  if (matching.length === 0) return { reach: 'notGranted', consumers: 0 };
  const now = Date.now();
  const live = matching.filter((grant) => {
    if (String(grant.state).toUpperCase() !== 'ACTIVE') return false;
    if (!grant.expiresAt) return true;
    const expiry = new Date(grant.expiresAt).getTime();
    return Number.isNaN(expiry) ? true : expiry > now;
  });
  if (live.length > 0) return { reach: 'granted', consumers: live.length };
  // Every grant exists but none is usable; say which way it failed.
  const expired = matching.some((grant) => {
    if (String(grant.state).toUpperCase() === 'EXPIRED') return true;
    if (!grant.expiresAt) return false;
    const expiry = new Date(grant.expiresAt).getTime();
    return !Number.isNaN(expiry) && expiry <= now;
  });
  return { reach: expired ? 'expired' : 'revoked', consumers: 0 };
}

/**
 * Replica readiness, kept apart from the status word on purpose (`lib/installation-state.ts`
 * makes the same split for plugins): a half-ready connector is still ACTIVE, and letting the
 * replica count rewrite the status vocabulary is how "running" and "serving" became one word.
 */
export type Readiness = 'serving' | 'partial' | 'down' | 'none' | 'unknown';

export function deriveReadiness(ready: number | null | undefined, total: number | null | undefined): Readiness {
  if (typeof ready !== 'number' || typeof total !== 'number' || !Number.isFinite(ready) || !Number.isFinite(total)) {
    return 'unknown';
  }
  // Nothing was asked for: not a failure, and not readiness either.
  if (total <= 0) return 'none';
  if (ready <= 0) return 'down';
  return ready >= total ? 'serving' : 'partial';
}

/** One connector, as the page renders it. Every field is an observation or an absence. */
export interface Connector {
  /** The providing plugin's id. Never rendered raw - it goes to `title` and the copy action. */
  pluginId: string;
  /** The plugin's own human name; falls back to the id only when the kernel sent no name. */
  name: string;
  /** True when another connector on this page shares `name`, so the row needs a disambiguator. */
  nameIsAmbiguous: boolean;
  publisher: string | null;
  /** The source capability this plugin provides, and at which major. */
  capability: string;
  major: number;
  /** Every source capability this plugin provides, when it provides more than one. */
  capabilities: Array<{ name: string; major: number }>;
  activeVersion: string | null;
  latestVersion: string | null;
  /** The raw install-state code; `lib/installation-state.ts` owns turning it into a word. */
  state: string | null;
  readiness: Readiness;
  readyInstances: number | null;
  totalInstances: number | null;
  trust: EvidenceTrust;
  trustReason: 'signed' | 'system' | 'publisherRevoked' | 'unsigned' | 'missing';
  reach: GrantReach;
  consumers: number;
  /** Whether the plugin contributes its own UI surface; the only honest "configure here" link. */
  configPath: string | null;
  /** Last change to the plugin record. NOT a collection time - see `COLLECTION_UNAVAILABLE`. */
  updatedAt: string | null;
  isSystem: boolean;
  hasBackend: boolean;
}

/**
 * There is no last-successful-collection field anywhere in Kernel API v1.
 *
 * `PluginSummary.updatedAt` is when the plugin *record* changed (an activation, a replica count),
 * so printing it under "last collected" would be a number that looks like an observation and is
 * not one. The page therefore drops that column entirely and says why once, which is both §2.7's
 * rule (a column that no row can answer is deleted, not filled with dashes) and the honest
 * reading: the platform cannot currently answer it.
 */
export const COLLECTION_UNAVAILABLE = true;

/** What the page needs to build its rows; each may be absent independently. */
export interface SourcesInput {
  plugins: PluginSummary[] | null;
  capabilities: Capability[] | null;
  grants: GrantView[] | null;
  publishers: Publisher[] | null;
  extensions: Extension[] | null;
}

export interface SourcesModel {
  connectors: Connector[];
  /** Plugins providing a capability outside the source families; stated, never hidden. */
  unclassifiedProviders: number;
  /** True when the capability registry answered but named no source provider at all. */
  noSourceCapability: boolean;
  /** Source capabilities some plugin REQUIRES that no installed plugin provides. */
  unsatisfiedRequirements: Array<{ name: string; major: number; consumerPluginId: string }>;
}

/** The plugin's own config surface, when it contributes one; `null` is "it has none". */
function configSurfaceFor(pluginId: string, extensions: Extension[] | null): string | null {
  if (!extensions) return null;
  const extension = extensions.find((item) => item.pluginId === pluginId);
  if (!extension) return null;
  // A page contribution is a destination; a nav item is a pointer to one. Either is honest,
  // a rejected contribution is not (the server withheld it, so it is not mounted).
  const page = extension.contributions?.find((item) => item.kind === 'route.page.v1');
  return page?.path ?? null;
}

/**
 * Build the connector rows.
 *
 * A capability registration is the row's reason to exist, and the plugin record supplies its
 * facts. A registration whose plugin is missing from the plugin list is dropped rather than
 * rendered half-empty: the capability route and the plugin route disagreeing is a platform
 * inconsistency, and inventing a row for it would hide that behind five NO_DATA cells.
 */
export function buildSourcesModel({ plugins, capabilities, grants, publishers, extensions }: SourcesInput): SourcesModel {
  const provides = (capabilities || []).filter((entry) => entry.direction === 'PROVIDES');
  const sourceProvides = provides.filter((entry) => isSourceCapability(entry.name));
  const pluginById = new Map((plugins || []).map((plugin) => [plugin.id, plugin]));
  const publisherById = new Map((publishers || []).map((entry) => [entry.publisherId, entry]));

  // One row per providing plugin, carrying every source capability it registers.
  const byPlugin = new Map<string, Array<{ name: string; major: number }>>();
  for (const entry of sourceProvides) {
    const list = byPlugin.get(entry.pluginId) || [];
    // The same name/major can be registered once per activation revision; one row, not two.
    if (!list.some((item) => item.name === entry.name && item.major === entry.major)) {
      list.push({ name: entry.name, major: entry.major });
    }
    byPlugin.set(entry.pluginId, list);
  }

  const nameCounts = new Map<string, number>();
  for (const pluginId of byPlugin.keys()) {
    const plugin = pluginById.get(pluginId);
    const name = plugin?.name || pluginId;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  const connectors: Connector[] = [];
  for (const [pluginId, list] of byPlugin) {
    const plugin = pluginById.get(pluginId);
    if (!plugin) continue;
    const sorted = [...list].sort((left, right) => left.name.localeCompare(right.name) || left.major - right.major);
    const primary = sorted[0];
    const publisher = plugin.publisher ? publisherById.get(plugin.publisher) ?? null : null;
    const trust = deriveTrust(plugin.signatureState, publisher);
    // Reach is the best of the capabilities this plugin provides: one granted capability makes
    // the connector reachable, and the drawer lists the per-capability detail.
    const reaches = sorted.map((item) => deriveReach(item.name, item.major, grants));
    const best = reaches.find((item) => item.reach === 'granted')
      ?? reaches.find((item) => item.reach === 'expired' || item.reach === 'revoked')
      ?? reaches[0]
      ?? { reach: 'unknown' as GrantReach, consumers: 0 };
    const name = plugin.name || pluginId;
    connectors.push({
      pluginId,
      name,
      nameIsAmbiguous: (nameCounts.get(name) || 0) > 1,
      publisher: plugin.publisher ?? null,
      capability: primary.name,
      major: primary.major,
      capabilities: sorted,
      activeVersion: plugin.activeVersion ?? null,
      latestVersion: plugin.latestVersion ?? null,
      state: plugin.state ?? null,
      readiness: deriveReadiness(plugin.readyInstances, plugin.totalInstances),
      readyInstances: typeof plugin.readyInstances === 'number' ? plugin.readyInstances : null,
      totalInstances: typeof plugin.totalInstances === 'number' ? plugin.totalInstances : null,
      trust: trust.level,
      trustReason: trust.reason,
      reach: best.reach,
      consumers: reaches.reduce((sum, item) => sum + item.consumers, 0),
      configPath: configSurfaceFor(pluginId, extensions),
      updatedAt: plugin.updatedAt ?? null,
      isSystem: Boolean(plugin.isSystem),
      hasBackend: Boolean(plugin.hasBackend),
    });
  }

  connectors.sort((left, right) => left.name.localeCompare(right.name) || left.pluginId.localeCompare(right.pluginId));

  // A source capability something needs and nothing provides. Rendered as its own fact: a
  // consumer waiting on a provider is not a broken connector, and it has no row of its own.
  const providedKeys = new Set(sourceProvides.map((entry) => `${entry.name}@${entry.major}`));
  const unsatisfiedRequirements: Array<{ name: string; major: number; consumerPluginId: string }> = [];
  for (const entry of capabilities || []) {
    if (entry.direction !== 'REQUIRES' || !isSourceCapability(entry.name)) continue;
    if (providedKeys.has(`${entry.name}@${entry.major}`)) continue;
    if (unsatisfiedRequirements.some((item) => item.name === entry.name && item.major === entry.major && item.consumerPluginId === entry.pluginId)) continue;
    unsatisfiedRequirements.push({ name: entry.name, major: entry.major, consumerPluginId: entry.pluginId });
  }

  return {
    connectors,
    unclassifiedProviders: new Set(provides.filter((entry) => !isSourceCapability(entry.name)).map((entry) => entry.pluginId)).size,
    noSourceCapability: capabilities !== null && sourceProvides.length === 0,
    unsatisfiedRequirements,
  };
}

/** The four counts the KPI band prints. Every one is a count of rows, never an estimate. */
export interface SourcesSummary {
  total: number;
  serving: number;
  attention: number;
  unattested: number;
}

/**
 * Summary counts.
 *
 * `serving` deliberately requires three independent things to be true at once - the plugin is
 * active, its replicas are all ready, and its capability is granted - because that is what
 * "this source is actually delivering" means. Any one of them unmet keeps the connector out of
 * the number rather than rounding it in.
 */
export function summarize(connectors: Connector[]): SourcesSummary {
  let serving = 0;
  let attention = 0;
  let unattested = 0;
  for (const connector of connectors) {
    const code = String(connector.state || '').toUpperCase();
    const active = code === 'ACTIVE' || code === 'READY';
    if (active && connector.readiness === 'serving' && connector.reach === 'granted') serving += 1;
    if (code === 'FAILED' || code === 'DEGRADED' || connector.readiness === 'down' || connector.readiness === 'partial') attention += 1;
    if (connector.trust !== 'SOURCE_ATTESTED') unattested += 1;
  }
  return { total: connectors.length, serving, attention, unattested };
}

/* ── credential references ──────────────────────────────────────────────────── */

/**
 * What a credential field may contain.
 *
 * `rules/03-security.md` is unconditional: plugin secrets travel as references with short-lived
 * access grants and must never enter a log, a manifest, a URL or an error response. So the field
 * accepts exactly two shapes and rejects everything else - including anything that merely *looks*
 * like a secret, which is the case worth catching, because a pasted token is the mistake this
 * validator exists to stop.
 */
export type CredentialRefKind = 'secretRef' | 'envVar';

export type CredentialRefResult =
  | { ok: true; kind: CredentialRefKind; value: string }
  | { ok: false; code: 'empty' | 'looksLikeSecret' | 'badShape' | 'tooLong' };

/** `secret://` + a path the kernel's own schema already constrains. */
const SECRET_REF = /^secret:\/\/[a-z0-9][a-z0-9/_-]{2,120}$/;
/** A POSIX-ish environment variable name, which is all the node adapter needs to look one up. */
const ENV_VAR = /^[A-Z][A-Z0-9_]{2,63}$/;
/** Longer than any reference or variable name, and the length a pasted token tends to have. */
const MAX_LENGTH = 128;

/**
 * Shapes that are almost certainly secret material rather than a name.
 *
 * This is a guard, not a classifier: it cannot prove a string is not a secret. It catches the
 * realistic paste - a bearer/JWT/PEM/`xxx-` vendor token, a long base64/hex run - so the field
 * can refuse it with a reason instead of forwarding it. Everything it misses is still refused
 * by the two shape tests above, which is why the order below ends in `badShape`.
 */
const SECRET_SHAPES: RegExp[] = [
  /^(bearer|basic)\s/i,
  /^ey[A-Za-z0-9_-]{8,}\./,            // a JWT header
  /-----BEGIN /,                        // PEM
  /^(sk|pk|ghp|gho|xox[baprs]|npm|AKIA|ASIA)[-_]/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,        // a long base64 run
  /^[a-f0-9]{40,}$/i,                   // a long hex run
];

/**
 * Validate what the operator typed into a credential field.
 *
 * The result never carries the rejected input back out: a caller that echoed it into a message
 * would put the thing we just refused into the DOM, and from there into a screenshot or a log.
 */
export function validateCredentialRef(raw: string): CredentialRefResult {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, code: 'empty' };
  if (value.length > MAX_LENGTH) return { ok: false, code: 'tooLong' };
  if (SECRET_SHAPES.some((shape) => shape.test(value))) return { ok: false, code: 'looksLikeSecret' };
  if (SECRET_REF.test(value)) return { ok: true, kind: 'secretRef', value };
  if (ENV_VAR.test(value)) return { ok: true, kind: 'envVar', value };
  return { ok: false, code: 'badShape' };
}

/**
 * A non-reversible hint for a reference the platform already holds.
 *
 * Only ever applied to a *reference* - the thing it describes is already not secret - and it
 * still keeps the tail hidden, because a reference path can name a tenant or a host.
 */
export function maskReference(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length <= 12) return text;
  return `${text.slice(0, 10)}…${text.slice(-2)}`;
}
