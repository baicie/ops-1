import type { PluginSummary } from '../types';

/** The three summary counts, as the filter values they also are. */
export type QuickFilter = 'installed' | 'upgradeable' | 'abnormal';

/**
 * The counting rule, in code, mirroring what the summary cards print:
 * installed  = installation state is INSTALLED;
 * upgradeable = the newest uploaded package version is not the active version;
 * abnormal   = READY replicas below desired, or the installation is DEGRADED/FAILED, or the
 *              newest package signature is not VERIFIED.
 */
export function isAbnormal(plugin: PluginSummary): boolean {
  const signatureBad = Boolean(plugin.signatureState && plugin.signatureState !== 'VERIFIED');
  const replicasBehind = plugin.totalInstances > 0 && plugin.readyInstances < plugin.totalInstances;
  return signatureBad || replicasBehind || plugin.state === 'DEGRADED' || plugin.state === 'FAILED';
}

export function matchesQuickFilter(plugin: PluginSummary, key: QuickFilter): boolean {
  if (plugin.isSystem) return false;
  if (key === 'installed') return plugin.state === 'INSTALLED';
  if (key === 'upgradeable') return Boolean(plugin.latestVersion && plugin.activeVersion && plugin.latestVersion !== plugin.activeVersion);
  return isAbnormal(plugin);
}

/**
 * The search box matches id, name and publisher. The haystack is a template literal and every
 * part of it is interpolated: written as `{plugin.id} ...` the first segment is the literal text
 * "{plugin.id}", so a search by id never matched anything while the box kept accepting it.
 */
export function matchesPluginQuery(plugin: PluginSummary, query: string): boolean {
  const haystack = `${plugin.id} ${plugin.name} ${plugin.publisher || ''}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export interface PluginTableFilter {
  query: string;
  /** A wire installation state, or 'ALL'. */
  state: string;
  quickFilter: QuickFilter | null;
}

/**
 * The rows the table draws, and therefore the rows the empty state speaks for: an empty array
 * here is exactly what renders "no plugin matches".
 */
export function filterPlugins(plugins: PluginSummary[], filter: PluginTableFilter): PluginSummary[] {
  return plugins.filter((plugin) => matchesPluginQuery(plugin, filter.query)
    && (filter.state === 'ALL' || plugin.state === filter.state)
    && (filter.quickFilter === null || matchesQuickFilter(plugin, filter.quickFilter)));
}
