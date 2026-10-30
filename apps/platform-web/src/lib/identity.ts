/**
 * One rule for "what is this row called", shared by every table.
 *
 * The identity of a row is ⟨name⟩ · ⟨disambiguator⟩ (table-spec §2.1). The disambiguator used to
 * be the first hex characters of the id and nothing else, which is right for a UUID and wrong for
 * every subject the Kernel names instead: `data.catalog`, `dev.opsweave.hello` and
 * `opsweave.kernel.catalog` are *names*, and hex-stripping them produced `daac`, `devo`,
 * `eaee` - four characters that tell a reader nothing and that also collided, because the only
 * thing those fragments preserve is the first letter or two of a shared prefix. On /admin/activity
 * that turned 25 rows into 15 distinguishable ones.
 */

/** Above this row count, 4 hex characters stop being enough; §2.1 derives 8. */
export const IDENTITY_MANY_ROWS = 100;

/** A slug tail is capped so it can never be the part that gets clipped at 390. */
const SLUG_TAIL_MAX = 16;

/**
 * A subject/actor id that is already a name: letters, digits, dots and underscores, and at least
 * one character no hex id could contain. Hyphens are excluded on purpose - every UUID has them,
 * and treating a UUID as a name is how the whole table would have started printing
 * `3233782f-0cea-46f…` in place of a four-character disambiguator.
 */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._]*$/;
const NAMED = /[g-z]/i;

/**
 * The disambiguator for one id.
 *
 * - a UUID (or any structured id with colons/slashes) is shortened to its hex prefix, as before;
 * - a name-like id (`data.catalog`) is shown as itself, capped, because the name IS the
 *   disambiguation and its first-4-hex is noise;
 * - nothing short enough to help returns '' so the caller can omit the tail entirely.
 */
export function identityDisambiguator(id: string | null | undefined, rowsOnPage = 0): string {
  const raw = String(id || '');
  if (!raw) return '';
  const width = rowsOnPage > IDENTITY_MANY_ROWS ? 8 : 4;
  if (SLUG.test(raw) && (NAMED.test(raw) || raw.includes('.'))) {
    return raw.length > SLUG_TAIL_MAX ? raw.slice(0, SLUG_TAIL_MAX - 1) + '\u2026' : raw;
  }
  const hex = raw.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length < width ? '' : hex.slice(0, width);
}

/** The clock a row was recorded at, at the precision an audit log needs (seconds, UTC-stable ISO). */
export function identityClock(occurredAt: string | null | undefined): string {
  const value = String(occurredAt || '');
  return value.length >= 19 ? value.slice(0, 19) : value;
}
