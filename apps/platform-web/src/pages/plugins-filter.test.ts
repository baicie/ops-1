import { describe, expect, it } from 'vitest';
import type { PluginSummary } from '../types';
import { filterPlugins, matchesPluginQuery, type QuickFilter } from './plugins-filter';

const plugin = (over: Partial<PluginSummary> = {}): PluginSummary => ({
  id: 'hello-web',
  name: 'Hello Web',
  publisher: 'opsweave',
  latestVersion: '1.2.0',
  activeVersion: '1.2.0',
  state: 'INSTALLED',
  signatureState: 'VERIFIED',
  hasFrontend: true,
  hasBackend: false,
  desiredReplicas: 0,
  readyInstances: 0,
  totalInstances: 0,
  isSystem: false,
  ...over,
});

const rows = [
  plugin(),
  plugin({ id: 'data-catalog', name: 'Data Catalog', publisher: 'acme' }),
  plugin({ id: 'pipeline-worker', name: 'Worker', publisher: null }),
];

const search = (query: string) => filterPlugins(rows, { query, state: 'ALL', quickFilter: null });

/**
 * The search box reads one haystack per row. It was written with a missing `$`, so the first
 * segment was the literal text "{plugin.id}" and a search by id matched nothing at all - these
 * cases fail on that shape and pass on the fixed one, which is the only reason they exist.
 */
describe('plugin search haystack', () => {
  it('finds a plugin by id', () => {
    expect(search('data-catalog').map((row) => row.id)).toEqual(['data-catalog']);
  });

  it('finds a plugin by name, not only by an exact case', () => {
    expect(search('hello web').map((row) => row.id)).toEqual(['hello-web']);
  });

  it('finds a plugin by publisher', () => {
    expect(search('acme').map((row) => row.id)).toEqual(['data-catalog']);
  });

  it('returns no rows - the empty state - when nothing matches', () => {
    expect(search('nothing-here')).toEqual([]);
  });

  it('does not match the literal text "{plugin.id}" that the broken haystack contained', () => {
    expect(search('{plugin.id}')).toEqual([]);
    expect(matchesPluginQuery(rows[0], '{plugin.id}')).toBe(false);
  });
});

describe('plugin table filter', () => {
  it('applies state and quick filter on top of the search', () => {
    const withState = filterPlugins(rows, { query: 'acme', state: 'INSTALLED', quickFilter: null });
    expect(withState.map((row) => row.id)).toEqual(['data-catalog']);
    const wrongState = filterPlugins(rows, { query: 'acme', state: 'DISABLED', quickFilter: null });
    expect(wrongState).toEqual([]);
  });

  it('keeps system plugins out of every quick filter', () => {
    const system = plugin({ id: 'system-core', name: 'Core', isSystem: true, state: 'INSTALLED' });
    const quick: QuickFilter = 'installed';
    expect(filterPlugins([system], { query: '', state: 'ALL', quickFilter: quick })).toEqual([]);
  });
});
