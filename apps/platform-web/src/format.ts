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

export function formatBytes(value?: number | null): string {
  if (value === null || value === undefined || value <= 0) return 'No data';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function shortDigest(value?: string | null, prefix = 14): string {
  if (!value) return '—';
  return value.length > prefix + 8 ? `${value.slice(0, prefix)}…${value.slice(-8)}` : value;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
