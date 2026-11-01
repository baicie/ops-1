/**
 * The locale the shell is currently rendering in.
 *
 * `toLocaleString(undefined, ...)` follows the BROWSER, not the product: a Chinese console on
 * an English browser printed "Oct 30, 01:24:35 PM". The provider sets this on every locale
 * change, so a formatted date follows the same language as the sentence around it.
 */
let activeLocale: string | undefined;

export function setActiveLocale(locale: string): void {
  activeLocale = locale;
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(activeLocale, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * A byte count, or `null` when there is no reading.
 *
 * Two defects left this function (machine-language-rules M3.4):
 *
 *  1. It returned the English string `No data` in every locale. A formatter returns a VALUE;
 *     "no data" is a state, and a state is M1's job — the caller renders `<NoData>`, which
 *     carries the dashed token, the verbatim wire word in `title` and the localized meaning in
 *     `sr-only`. So absence now leaves here as `null` and is rendered, not spelled.
 *  2. `value <= 0` folded ZERO into that same absence. A node that reports 0 bytes has
 *     reported a number: printing "no data" over it claims the source was never sampled. Only
 *     `null`/`undefined`/a non-finite number is missing now; `0` formats as a reading.
 *
 * The magnitude steps stay binary (B / KiB / MiB / GiB / TiB) because that is what the Kernel
 * reports. `Intl` has no binary units — its `kilobyte` is 1000 bytes — so localizing the SYMBOL
 * would change the value's meaning. KiB/MiB are IEC 80000-13 symbols, the same glyphs in every
 * locale (like `kg` or `Hz`); what does vary is the NUMBER, so the number goes through `Intl`
 * and picks up the locale's decimal separator and grouping.
 */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(value?: number | null): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) { size /= 1024; unit += 1; }
  const digits = size >= 10 || unit === 0 ? 0 : 1;
  return Intl.NumberFormat(activeLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(size) + ' ' + BYTE_UNITS[unit];
}

export function shortDigest(value?: string | null, prefix = 14): string {
  if (!value) return '—';
  return value.length > prefix + 8 ? `${value.slice(0, prefix)}…${value.slice(-8)}` : value;
}

/**
 * A duration, in the reader's language (machine-language-rules M3.1).
 *
 * The old body spelled its own units: `18h 42m` in English AND in Chinese, because `h` and `m`
 * were string literals. `Intl.NumberFormat`'s unit style returns `18小时` / `18 hr` from one
 * call, so the catalog needs no unit keys and a locale added tomorrow gets units for free.
 *
 * One unit, not two. The old form printed a second component (`42m` after `18h`) which is
 * precision the reader cannot use — an uptime of "18h" and "18h 42m" lead to the same decision,
 * and `Intl` has no two-part unit form that stays grammatical across locales. The magnitude
 * picks the unit; the remainder is dropped rather than spelled.
 */
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  const [amount, unit] = whole < 60
    ? [whole, 'second' as const]
    : whole < 3600
      ? [Math.floor(whole / 60), 'minute' as const]
      : whole < 86400
        ? [Math.floor(whole / 3600), 'hour' as const]
        : [Math.floor(whole / 86400), 'day' as const];
  return Intl.NumberFormat(activeLocale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(amount);
}
