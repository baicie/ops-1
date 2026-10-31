import { describe, expect, it } from 'vitest';
import {
  GLYPH_BY_KIND,
  INDICATOR_STATE_BY_KIND,
  KIND_LABEL_KEYS,
  LABEL_KEY_BY_KIND,
  TONE_BY_KIND,
  deriveInstallationState,
  readinessOf,
} from './installation-state';
import { STATUS_MAP, glyphForEntry, statusForCode } from '../components/status-tone';

/**
 * These tests exist to make the two ways of printing a status - by kind (detail page) and by
 * wire code (list page) - provably the same word. Before this module they were two tables in
 * two files and the drift was only visible to a person reading both screens.
 */

describe('deriveInstallationState', () => {
  it('maps every install state the kernel emits to a closed kind', () => {
    expect(deriveInstallationState({ state: 'ACTIVE' }).kind).toBe('active');
    expect(deriveInstallationState({ state: 'INSTALLED' }).kind).toBe('installed');
    expect(deriveInstallationState({ state: 'STAGED' }).kind).toBe('staged');
    expect(deriveInstallationState({ state: 'FAILED' }).kind).toBe('failed');
    expect(deriveInstallationState({ state: 'REJECTED' }).kind).toBe('failed');
    expect(deriveInstallationState({ state: 'DEGRADED' }).kind).toBe('degraded');
    expect(deriveInstallationState({ state: 'DISABLED' }).kind).toBe('disabled');
    expect(deriveInstallationState({ state: 'UNINSTALLED' }).kind).toBe('notInstalled');
  });

  it('is case and whitespace insensitive, so a lowercase code is not a different state', () => {
    expect(deriveInstallationState({ state: '  staged ' }).kind).toBe('staged');
  });

  it('says which field is missing instead of guessing', () => {
    expect(deriveInstallationState({})).toEqual({ kind: 'noData', missing: ['state'] });
    expect(deriveInstallationState({ state: null })).toEqual({ kind: 'noData', missing: ['state'] });
    expect(deriveInstallationState({ state: '   ' })).toEqual({ kind: 'noData', missing: ['state'] });
  });

  it('reports an unmapped code as a gap in its own table, not as a plugin state', () => {
    const derived = deriveInstallationState({ state: 'SOMETHING_ELSE' });
    expect(derived.kind).toBe('noData');
    expect(derived.missing[0]).toContain('unmapped');
  });

  it('never lets replica readiness change the status word', () => {
    // The old failure: list read totalInstances > 0, detail read deployment_state, and one
    // plugin was "1/1 ready" on one screen and "STAGED" on the other. The derivation takes one
    // field, so readiness cannot reach it.
    expect(deriveInstallationState({ state: 'STAGED' }).kind).toBe('staged');
    expect(deriveInstallationState({ state: 'STAGED' }).kind).not.toBe('active');
  });
});

describe('readinessOf', () => {
  it('is a separate fact with its own renderer', () => {
    expect(readinessOf(1, 1)).toEqual({ ready: 1, total: 1 });
    expect(readinessOf(0, 2)).toEqual({ ready: 0, total: 2 });
  });

  it('returns null rather than zero when the field is absent', () => {
    expect(readinessOf(undefined, 2)).toBeNull();
    expect(readinessOf(1, undefined)).toBeNull();
    expect(readinessOf(null, null)).toBeNull();
  });
});

describe('one vocabulary across both render paths', () => {
  it('gives the same label key whether a surface passes a kind or a wire code', () => {
    const pairs: Array<[string, Parameters<typeof deriveInstallationState>[0]]> = [
      ['ACTIVE', { state: 'ACTIVE' }],
      ['INSTALLED', { state: 'INSTALLED' }],
      ['STAGED', { state: 'STAGED' }],
      ['FAILED', { state: 'FAILED' }],
      ['DEGRADED', { state: 'DEGRADED' }],
      ['DISABLED', { state: 'DISABLED' }],
      ['UNINSTALLED', { state: 'UNINSTALLED' }],
    ];
    for (const [code, input] of pairs) {
      const viaKind = LABEL_KEY_BY_KIND[deriveInstallationState(input).kind];
      const viaCode = STATUS_MAP[code].labelKey;
      expect(viaKind, code).toBe(viaCode);
    }
  });

  it('covers every kind with a label, a tone, a glyph and an indicator state', () => {
    for (const kind of Object.keys(LABEL_KEY_BY_KIND) as (keyof typeof LABEL_KEY_BY_KIND)[]) {
      expect(LABEL_KEY_BY_KIND[kind], kind).toBeTruthy();
      expect(TONE_BY_KIND[kind], kind).toBeTruthy();
      expect(GLYPH_BY_KIND[kind], kind).toBeTruthy();
      expect(INDICATOR_STATE_BY_KIND[kind], kind).toBeTruthy();
    }
  });

  it('gives kinds that share a tone different glyphs', () => {
    type Kind = keyof typeof TONE_BY_KIND;
    const byTone = new Map<string, Kind[]>();
    for (const kind of Object.keys(TONE_BY_KIND) as (keyof typeof TONE_BY_KIND)[]) {
      const list = byTone.get(TONE_BY_KIND[kind]) ?? [];
      list.push(kind);
      byTone.set(TONE_BY_KIND[kind], list);
    }
    for (const [tone, kinds] of byTone) {
      const glyphs = kinds.map((k) => GLYPH_BY_KIND[k]);
      expect(new Set(glyphs).size, `tone ${tone} must not reuse a glyph: ${glyphs.join(',')}`).toBe(glyphs.length);
    }
  });
});

describe('accepted is not confirmed', () => {
  it('does not paint "we recorded the request" with the same green as "it happened"', () => {
    const accepted = statusForCode('ACCEPTED')!;
    const confirmed = statusForCode('CONFIRMED')!;
    expect(accepted.tone).not.toBe(confirmed.tone);
    // Same colour AND same shape is what made the two states indistinguishable on screen.
    expect(glyphForEntry(accepted)).not.toBe(glyphForEntry(confirmed));
    expect(confirmed.tone).toBe('ok');
    expect(accepted.tone).toBe('neutral');
  });
});

describe('KIND_LABEL_KEYS', () => {
  it('is the same table the component uses', () => {
    expect(KIND_LABEL_KEYS).toBe(LABEL_KEY_BY_KIND);
  });
});
