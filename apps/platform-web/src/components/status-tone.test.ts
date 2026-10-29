import { describe, expect, it } from 'vitest';
import en from '../i18n/catalogs/en.json';
import zhCN from '../i18n/catalogs/zh-CN.json';
import { STATUS_MAP, badgeVariantForTone, glyphForTone, statusForCode, type StatusTone } from './status-tone';
import * as indicator from './app/status-indicator';
import { glyphForState, indicatorStateForCode, labelKeyForState } from './app/status-indicator';

/**
 * One table, two renderers. These assertions exist because the v3 audit found the same code
 * being blue in a table and green on a card: `STATUS_MAP` and the indicator's private
 * `CODE_STATES` disagreed about VERIFIED and STAGED, and neither knew the job lifecycle.
 */
describe('STATUS_MAP', () => {
  it('covers the six codes that used to fall through to UNKNOWN', () => {
    for (const code of ['SUCCEEDED', 'CANCELLED', 'QUEUED', 'RUNNING', 'CLAIMED', 'ACCEPTED']) {
      const entry = statusForCode(code);
      expect(entry, code + ' must be mapped, not guessed').toBeDefined();
      expect(entry!.tone, code + ' must not read as unknown').not.toBe('unknown');
    }
  });

  it('gives success a shape UNKNOWN cannot imitate', () => {
    expect(STATUS_MAP.SUCCEEDED.tone).toBe('ok');
    // Two independent cues besides hue: the glyph and the badge weight.
    expect(glyphForTone('ok')).not.toBe(glyphForTone('unknown'));
    expect(badgeVariantForTone('ok')).not.toBe(badgeVariantForTone('unknown'));
    // ...and the state renderer agrees, so the chip and the pill cannot diverge either.
    expect(glyphForState(indicatorStateForCode('SUCCEEDED'))).not.toBe(glyphForState(indicatorStateForCode('UNKNOWN')));
  });

  it('keeps failure, deliberate stop and waiting apart from each other', () => {
    expect(STATUS_MAP.FAILED.tone).toBe('danger');
    expect(STATUS_MAP.CANCELLED.tone).toBe('neutral');
    expect(STATUS_MAP.CANCELLED.state).toBe('stopped');
    expect(STATUS_MAP.QUEUED.state).toBe('attention');
    expect(STATUS_MAP.RUNNING.state).toBe('running');
  });

  it('is the only place a code is classified', () => {
    // The old duplicate table. Its absence is what makes drift impossible.
    expect((indicator as Record<string, unknown>).CODE_STATES).toBeUndefined();
    for (const [code, entry] of Object.entries(STATUS_MAP)) {
      expect(indicatorStateForCode(code), code + ' drifted between the two tables').toBe(entry.state);
    }
  });

  it('still lets revocation and staleness win over the stored code', () => {
    expect(indicatorStateForCode('READY', { revoked: true })).toBe('revoked');
    expect(indicatorStateForCode('READY', { stale: true })).toBe('stale');
    expect(indicatorStateForCode('UNREACHABLE', { stale: true })).toBe('unreachable');
  });

  it('gives every tone its own glyph, so colour is never the only cue', () => {
    const tones: StatusTone[] = ['ok', 'info', 'neutral', 'warn', 'danger', 'unknown'];
    const glyphs = tones.map(glyphForTone);
    expect(new Set(glyphs).size).toBe(tones.length);
  });

  it('has a label in both catalogs for every code and every state it resolves to', () => {
    const missing: string[] = [];
    for (const [code, entry] of Object.entries(STATUS_MAP)) {
      if (!en[entry.labelKey as keyof typeof en]) missing.push(code + ':' + entry.labelKey + ' (en)');
      if (!zhCN[entry.labelKey as keyof typeof zhCN]) missing.push(code + ':' + entry.labelKey + ' (zh-CN)');
    }
    for (const state of new Set(Object.values(STATUS_MAP).map((entry) => entry.state))) {
      const key = labelKeyForState(state);
      if (!en[key as keyof typeof en]) missing.push(state + ':' + key + ' (en)');
      if (!zhCN[key as keyof typeof zhCN]) missing.push(state + ':' + key + ' (zh-CN)');
      expect(glyphForState(state), state + ' needs a glyph').toBeTruthy();
    }
    expect(missing).toEqual([]);
  });

  it('reads the code case-insensitively and never throws on one it has not seen', () => {
    expect(statusForCode('succeeded')?.tone).toBe('ok');
    expect(statusForCode('HALTED')).toBeUndefined();
    expect(statusForCode(null)).toBeUndefined();
  });
});
