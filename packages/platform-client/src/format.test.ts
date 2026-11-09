import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, setActiveLocale } from './format';

/**
 * machine-language-rules M3: a formatter returns a value in the reader's language, and absence
 * is a state the caller renders — never a string the formatter spells.
 *
 * Both defects these tests pin were real: `formatBytes` answered the English literal "No data"
 * in zh-CN, and `formatDuration` spelled `h`/`m`/`s` itself, so "18h 42m" was identical in both
 * catalogs. The gate (check-ui-tokens R6) can see the literal in the source; only a test can see
 * that the replacement actually localizes and that zero survived the rewrite.
 */
describe('formatBytes', () => {
  it('returns null for absence so the caller can render the Missing token', () => {
    // null, not "No data": the string was English in every locale, and a formatter that spells
    // a STATE takes M1's job away from the component that owns the dashed token.
    expect(formatBytes(undefined)).toBeNull();
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });

  it('treats zero as a reading, not as absence', () => {
    // The old guard was `value <= 0`, which printed "No data" over a node that had reported 0
    // bytes — claiming the source was never sampled when it answered a number.
    setActiveLocale('en');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('keeps binary magnitude steps and localizes only the number', () => {
    setActiveLocale('en');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(16 * 1024 ** 3)).toBe('16 GiB');
    // KiB/MiB are IEC symbols — the same glyphs in every locale. Intl's `kilobyte` is 1000
    // bytes, so localizing the SYMBOL would change what the number means.
    setActiveLocale('zh-CN');
    expect(formatBytes(1536)).toBe('1.5 KiB');
  });
});

describe('formatDuration', () => {
  it('speaks the reader language instead of spelling its own units', () => {
    setActiveLocale('en');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(67000)).toBe('18h');
    // The defect: `h` was a string literal, so an 18-hour uptime read "18h" in Chinese too.
    setActiveLocale('zh-CN');
    expect(formatDuration(45)).toBe('45秒');
    expect(formatDuration(67000)).toBe('18小时');
  });

  it('picks one unit by magnitude and returns null when there is no duration', () => {
    setActiveLocale('en');
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3700)).toBe('1h');
    expect(formatDuration(86400 * 3)).toBe('3d');
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});
